const FADE_SAMPLES = 240;
const DISCONTINUITY_THRESHOLD = 0.08;
const BURST_ONSET_THRESHOLD = 0.32;
const SMOOTH_SLOPE_THRESHOLD = 0.06;
const ISOLATED_SPIKE_THRESHOLD = 0.32;
const ISOLATED_BASELINE_THRESHOLD = 0.04;

function finiteSample(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

class EchoVoiceDeclickProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = [];
    this.smoothNextBlock = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === "smooth-next-block") this.smoothNextBlock = true;
    };
  }

  channelState(index) {
    if (!this.channels[index]) {
      this.channels[index] = {
        initialized: false,
        historySamples: 0,
        previousRaw: 0,
        previousOutput: 0,
        previousSlope: 0,
        correction: 0,
        correctionRemaining: 0,
        missingInput: false
      };
    }
    return this.channels[index];
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      const inputChannel = input[channelIndex] || input[0];
      const outputChannel = output[channelIndex];
      const state = this.channelState(channelIndex);
      if (!inputChannel) {
        if (!state.missingInput) {
          state.correction = state.previousOutput;
          state.correctionRemaining = state.initialized ? FADE_SAMPLES : 0;
          state.missingInput = true;
        }
        for (let index = 0; index < outputChannel.length; index += 1) {
          const rendered = state.correctionRemaining > 0
            ? state.correction * state.correctionRemaining / FADE_SAMPLES
            : 0;
          outputChannel[index] = finiteSample(rendered);
          if (state.correctionRemaining > 0) state.correctionRemaining -= 1;
        }
        state.initialized = true;
        state.previousRaw = 0;
        state.previousOutput = outputChannel[outputChannel.length - 1] || 0;
        state.previousSlope = 0;
        continue;
      }
      state.missingInput = false;

      for (let index = 0; index < outputChannel.length; index += 1) {
        let current = finiteSample(inputChannel[index], state.previousRaw);
        if (!state.initialized) {
          outputChannel[index] = current;
          state.initialized = true;
          state.historySamples = 1;
          state.previousRaw = current;
          state.previousOutput = current;
          continue;
        }

        const forcedSmoothing = this.smoothNextBlock && index === 0;
        if (forcedSmoothing) {
          // An externally suspended AudioContext is heard as silence by the
          // next graph. Resume from zero instead of replaying the stale sample
          // that preceded suspension.
          state.correction = -current;
          state.correctionRemaining = FADE_SAMPLES;
        }
        const hasLookahead = index + 1 < inputChannel.length;
        const next = hasLookahead
          ? finiteSample(inputChannel[index + 1], current)
          : current;
        const jump = Math.abs(current - state.previousRaw);
        const nextSlope = hasLookahead
          ? Math.abs(next - current)
          : Number.POSITIVE_INFINITY;
        const isolatedSpike =
          !forcedSmoothing
          && state.historySamples >= 2
          && hasLookahead
          && Math.abs(state.previousSlope) < ISOLATED_BASELINE_THRESHOLD
          && Math.abs(next - state.previousRaw) < ISOLATED_BASELINE_THRESHOLD
          && jump >= ISOLATED_SPIKE_THRESHOLD
          && nextSlope >= ISOLATED_SPIKE_THRESHOLD;
        if (isolatedSpike) {
          current = (state.previousRaw + next) * 0.5;
        }
        const sanitizedJump = Math.abs(current - state.previousRaw);
        const abruptBurstOnset =
          sanitizedJump >= BURST_ONSET_THRESHOLD
          && Math.abs(state.previousSlope) < SMOOTH_SLOPE_THRESHOLD;
        const correctionReversal =
          state.correctionRemaining > 0
          && sanitizedJump >= DISCONTINUITY_THRESHOLD
          && state.previousSlope * (current - state.previousRaw) < 0;
        const smoothDiscontinuity =
          hasLookahead
          && Math.abs(next - current) < SMOOTH_SLOPE_THRESHOLD;
        if (
          !forcedSmoothing
          && state.historySamples >= 2
          && sanitizedJump >= DISCONTINUITY_THRESHOLD
          && (
            correctionReversal
            || abruptBurstOnset
            || (
              Math.abs(state.previousSlope) < SMOOTH_SLOPE_THRESHOLD
              && smoothDiscontinuity
            )
          )
        ) {
          state.correction = state.previousOutput - current;
          state.correctionRemaining = FADE_SAMPLES;
        }

        let rendered = current;
        if (state.correctionRemaining > 0) {
          rendered += state.correction * state.correctionRemaining / FADE_SAMPLES;
          state.correctionRemaining -= 1;
        }
        rendered = finiteSample(rendered);
        outputChannel[index] = rendered;
        state.previousSlope = current - state.previousRaw;
        state.previousRaw = current;
        state.previousOutput = rendered;
        state.historySamples += 1;
      }
    }
    this.smoothNextBlock = false;
    return true;
  }
}

registerProcessor("echovoice-declick", EchoVoiceDeclickProcessor);

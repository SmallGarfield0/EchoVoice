import assert from "node:assert/strict";

let Processor;

globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null };
  }
};
globalThis.registerProcessor = (name, implementation) => {
  assert.equal(name, "echovoice-declick");
  Processor = implementation;
};

await import("../src/audio/remote-audio-declick-worklet.js");
assert.ok(Processor, "de-click processor was not registered");

function processBlocks(processor, samples, blockSize = 128) {
  const rendered = new Float32Array(samples.length);
  for (let offset = 0; offset < samples.length; offset += blockSize) {
    const input = samples.slice(offset, Math.min(samples.length, offset + blockSize));
    const output = new Float32Array(input.length);
    processor.process([[input]], [[output]]);
    rendered.set(output, offset);
  }
  return rendered;
}

function sineWave(frequency, length, amplitude = 0.24, phase = 0) {
  return Float32Array.from({ length }, (_, index) =>
    amplitude * Math.sin(phase + 2 * Math.PI * frequency * index / 48_000)
  );
}

function maxDifference(left, right) {
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
  }
  return maximum;
}

function maxAdjacentDelta(samples) {
  let maximum = 0;
  for (let index = 1; index < samples.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(samples[index] - samples[index - 1]));
  }
  return maximum;
}

for (const frequency of [440, 8_000]) {
  const input = sineWave(frequency, 4_096);
  const output = processBlocks(new Processor(), input);
  const difference = maxDifference(input, output);
  assert.ok(
    difference < 1e-7,
    `${frequency} Hz program audio was modified by ${difference}`
  );
}

const highFrequencyProgram = sineWave(18_000, 4_096, 0.24, Math.PI * 0.37);
const highFrequencyOutput = processBlocks(new Processor(), highFrequencyProgram);
assert.ok(
  maxDifference(highFrequencyProgram, highFrequencyOutput) < 1e-7,
  "legitimate high-frequency program audio was mistaken for an impulse"
);

const stepped = new Float32Array(1_024);
stepped.fill(0.4, 512);
const smoothedStep = processBlocks(new Processor(), stepped);
assert.ok(maxAdjacentDelta(smoothedStep) < 0.01, "step discontinuity was not smoothed");
assert.ok(Math.abs(smoothedStep.at(-1) - 0.4) < 1e-6, "smoothed signal did not recover its level");

const rapidTransitions = new Float32Array(1_024);
rapidTransitions.fill(0.4, 256, 320);
rapidTransitions.fill(-0.4, 320, 512);
const smoothedRapidTransitions = processBlocks(new Processor(), rapidTransitions);
assert.ok(
  maxAdjacentDelta(smoothedRapidTransitions) < 0.02,
  "a second discontinuity during an active correction was not smoothed"
);
assert.ok(
  Math.max(...smoothedRapidTransitions.map(Math.abs)) <= 0.400001,
  "overlapping corrections produced an overshoot"
);

for (const polarity of [-1, 1]) {
  const isolatedSpike = sineWave(440, 2_048, 0.04);
  isolatedSpike[1_024] = polarity;
  const suppressed = processBlocks(new Processor(), isolatedSpike);
  const baseline = (isolatedSpike[1_023] + isolatedSpike[1_025]) * 0.5;
  assert.ok(
    Math.abs(suppressed[1_024] - baseline) < 0.001,
    `${polarity > 0 ? "positive" : "negative"} isolated spike was not suppressed`
  );
  assert.ok(maxAdjacentDelta(suppressed) < 0.08, "isolated spike left an audible edge");
}

for (const index of [127, 255, 511]) {
  const boundarySpike = sineWave(440, 1_024, 0.04);
  boundarySpike[index] = 1;
  const suppressed = processBlocks(new Processor(), boundarySpike, 128);
  assert.ok(
    Math.abs(suppressed[index] - suppressed[index - 1]) < 0.02,
    `block-boundary spike at sample ${index} was not faded`
  );
  assert.ok(
    Math.abs(suppressed[index + 1] - suppressed[index]) < 0.08,
    `block-boundary spike at sample ${index} left a rebound impulse`
  );
}

const burst = sineWave(440, 4_096, 0.04);
burst.fill(0.9, 2_048, 2_112);
const smoothedBurst = processBlocks(new Processor(), burst);
assert.ok(
  Math.abs(smoothedBurst[2_048] - smoothedBurst[2_047]) < 0.02,
  "burst onset was not faded from the preceding signal"
);
assert.ok(maxAdjacentDelta(smoothedBurst) < 0.12, "burst protection left a full-scale edge");

const invalidSamples = sineWave(440, 1_024, 0.1);
invalidSamples[400] = Number.NaN;
invalidSamples[640] = Number.POSITIVE_INFINITY;
invalidSamples[768] = Number.NEGATIVE_INFINITY;
const sanitized = processBlocks(new Processor(), invalidSamples);
assert.ok(sanitized.every(Number.isFinite), "invalid PCM reached the output");
assert.ok(maxAdjacentDelta(sanitized) < 0.08, "invalid PCM replacement introduced an impulse");

const resumeProcessor = new Processor();
processBlocks(resumeProcessor, sineWave(440, 512));
resumeProcessor.port.onmessage({ data: { type: "smooth-next-block" } });
const resumed = processBlocks(resumeProcessor, sineWave(440, 512, 0.24, Math.PI * 0.63));
assert.ok(Math.abs(resumed[0]) < 1e-7, "resumed audio did not begin at silence");
assert.ok(maxAdjacentDelta(resumed) < 0.02, "resumed audio contained an impulse");

const dropoutProcessor = new Processor();
const beforeDropout = processBlocks(dropoutProcessor, Float32Array.from({ length: 512 }, () => 0.35));
const missingOutput = new Float32Array(384);
for (let offset = 0; offset < missingOutput.length; offset += 128) {
  const output = new Float32Array(128);
  dropoutProcessor.process([[]], [[output]]);
  missingOutput.set(output, offset);
}
const afterDropout = processBlocks(dropoutProcessor, Float32Array.from({ length: 512 }, () => 0.35));
const dropoutSequence = Float32Array.from([...beforeDropout, ...missingOutput, ...afterDropout]);
assert.ok(maxAdjacentDelta(dropoutSequence) < 0.02, "a temporarily missing input block introduced an impulse");
assert.ok(Math.abs(missingOutput.at(-1)) < 1e-7, "missing input did not settle to silence");

console.log("ok - audio de-click preserves program audio and smooths discontinuities");

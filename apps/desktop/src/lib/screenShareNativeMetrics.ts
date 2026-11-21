/** Counters from a single native publisher. Older cores omit some stages. */
export interface NativePipelineCounters {
  effectiveContentMode?: string | null;
  smartReason?: string | null;
  encoderFallbackReason?: string | null;
  textureCopies?: number;
  readbackFrames?: number;
  readbackMicros?: number;
  captureAgeSamples?: number;
  captureAgeMicros?: number;
  highEncodeCalls?: number;
  highEncodeCallMicros?: number;
  hardwareOutputs?: number;
  hardwareResidenceMicros?: number;
  gpuLocalBudgetBytes?: number | null;
  gpuProcessUsageBytes?: number | null;
}

export function nativePublisherSample(raw: Record<string, unknown>, atMS: number) {
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const pipeline = (raw.pipeline ?? {}) as NativePipelineCounters;
  return {
    atMS,
    captured: count(raw.capturedFrames ?? raw.captured_frames),
    encoded: count(raw.encodedFrames ?? raw.encoded_frames),
    pressure: count(raw.encoderBackpressureDrops ?? raw.encoder_backpressure_drops),
    viewerDrops: count(raw.viewerBackpressureDrops ?? raw.viewer_backpressure_drops),
    audioDrops: count(raw.audioQueueDrops ?? raw.audio_queue_drops),
    encoderTargetBps: count(raw.effectiveBitrateBps ?? raw.effective_bitrate_bps),
    copies: count(pipeline.textureCopies),
    reads: count(pipeline.readbackFrames),
    readUS: count(pipeline.readbackMicros),
    ageSamples: count(pipeline.captureAgeSamples),
    ageUS: count(pipeline.captureAgeMicros),
    calls: count(pipeline.highEncodeCalls),
    callUS: count(pipeline.highEncodeCallMicros),
    outputs: count(pipeline.hardwareOutputs),
    residenceUS: count(pipeline.hardwareResidenceMicros),
    gpuBudget: count(pipeline.gpuLocalBudgetBytes),
    gpuUsage: count(pipeline.gpuProcessUsageBytes)
  };
}

export type NativePublisherSample = ReturnType<typeof nativePublisherSample>;
export function nativePublisherMetrics(now: NativePublisherSample, before?: NativePublisherSample) {
  const delta = (field: keyof NativePublisherSample) => {
    const a = now[field], b = before?.[field];
    return a !== undefined && b !== undefined && a >= b ? a - b : undefined;
  };
  const ratio = (numerator: keyof NativePublisherSample, denominator: keyof NativePublisherSample, factor: number) => {
    const total = delta(numerator), n = delta(denominator);
    return total !== undefined && n !== undefined && n > 0 ? total / n * factor : undefined;
  };
  return {
    captureFps: ratio("captured", "atMS", 1000),
    encodeFps: ratio("encoded", "atMS", 1000),
    captureAge: ratio("ageUS", "ageSamples", 0.001),
    readback: ratio("readUS", "reads", 0.001),
    encodeCall: ratio("callUS", "calls", 0.001),
    hardwareResidence: ratio("residenceUS", "outputs", 0.001),
    copies: now.copies,
    gpuBudget: now.gpuBudget === undefined ? undefined : now.gpuBudget / 1048576,
    gpuUsage: now.gpuUsage === undefined ? undefined : now.gpuUsage / 1048576,
    pressure: now.pressure,
    viewerDrops: now.viewerDrops,
    audioDrops: now.audioDrops,
    encoderTarget: now.encoderTargetBps !== undefined ? now.encoderTargetBps / 1_000_000 : undefined
  };
}

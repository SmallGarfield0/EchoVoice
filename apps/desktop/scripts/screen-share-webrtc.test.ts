import { strict as assert } from "node:assert";
import { WebScreenShareQualityController, webScreenShareEncoding } from "../src/lib/screenShareWebQuality.ts";
import { nativePublisherSample, nativePublisherMetrics } from "../src/lib/screenShareNativeMetrics.ts";
import { changedScreenArea, ScreenContentClassifier } from "../src/lib/screenShareSmartContent.ts";
import {
  deriveScreenShareSenderTelemetry,
  orderScreenShareCodecs,
  type ScreenShareOutboundSample
} from "../src/lib/screenShareWebRTC.ts";

run("prioritizes a hardware-friendly codec for motion without dropping repair codecs", () => {
  const codecs = [
    { mimeType: "video/VP8" },
    { mimeType: "video/rtx", sdpFmtpLine: "apt=96" },
    { mimeType: "video/VP9", sdpFmtpLine: "profile-id=0" },
    { mimeType: "video/rtx", sdpFmtpLine: "apt=98" },
    { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f" },
    { mimeType: "video/rtx", sdpFmtpLine: "apt=100" },
    { mimeType: "video/red" }
  ];

  const ordered = orderScreenShareCodecs(codecs, "motion");
  assert.deepEqual(
    ordered.filter((codec) => !["video/rtx", "video/red"].includes(codec.mimeType)).map((codec) => codec.mimeType),
    ["video/H264", "video/VP9", "video/VP8"]
  );
  assert.deepEqual(
    ordered.filter((codec) => codec.mimeType === "video/rtx").map((codec) => codec.sdpFmtpLine),
    ["apt=100", "apt=98", "apt=96"]
  );
  assert.equal(ordered.at(-1)?.mimeType, "video/red");
});

run("prioritizes VP9 for detailed screen content", () => {
  const ordered = orderScreenShareCodecs(
    [
      { mimeType: "video/VP8" },
      { mimeType: "video/H264" },
      { mimeType: "video/VP9" },
      { mimeType: "video/AV1" }
    ],
    "detail"
  );
  assert.deepEqual(ordered.map((codec) => codec.mimeType), [
    "video/VP9",
    "video/H264",
    "video/VP8",
    "video/AV1"
  ]);
});

run("keeps VP9 for detailed screen content while one encoder can keep up", () => {
  const ordered = orderScreenShareCodecs(
    [{ mimeType: "video/VP8" }, { mimeType: "video/H264" }, { mimeType: "video/VP9" }],
    "detail",
    { width: 1280, height: 720, frameRate: 30, encoders: 1 }
  );
  assert.equal(ordered[0]?.mimeType, "video/VP9");
});

run("prefers the hardware codec once software encoding cannot keep up", () => {
  const codecs = [
    { mimeType: "video/VP8" },
    { mimeType: "video/H264" },
    { mimeType: "video/VP9" }
  ];

  const largeSource = orderScreenShareCodecs(codecs, "detail", {
    width: 1920,
    height: 1080,
    frameRate: 60,
    encoders: 1
  });
  assert.deepEqual(largeSource.map((codec) => codec.mimeType), [
    "video/H264",
    "video/VP9",
    "video/VP8"
  ]);

  const mesh = orderScreenShareCodecs(codecs, "detail", {
    width: 1280,
    height: 720,
    frameRate: 60,
    encoders: 4
  });
  assert.equal(mesh[0]?.mimeType, "video/H264");
});

run("derives actual screen-share bitrate, cadence, and encode cost", () => {
  const previous = sample({
    timestampMS: 1_000,
    bytesSent: 1_000_000,
    framesEncoded: 60,
    keyFramesEncoded: 1,
    totalEncodeTimeSeconds: 0.6,
    retransmittedBytesSent: 10_000
  });
  const current = sample({
    timestampMS: 2_000,
    bytesSent: 3_000_000,
    framesEncoded: 120,
    keyFramesEncoded: 2,
    totalEncodeTimeSeconds: 1.5,
    retransmittedBytesSent: 60_000,
    reportedFramesPerSecond: undefined
  });

  const telemetry = deriveScreenShareSenderTelemetry(previous, current);
  assert.equal(telemetry.bitrateBps, 16_000_000);
  assert.equal(telemetry.encodedFramesPerSecond, 60);
  assert.equal(telemetry.averageEncodeTimeMS, 15);
  assert.equal(telemetry.retransmittedBitrateBps, 400_000);
  assert.equal(telemetry.frameWidth, 1920);
  assert.equal(telemetry.frameHeight, 1080);
  assert.equal(telemetry.codecMimeType, "video/H264");
});

run("does not report missing browser encoder counters as healthy zeroes", () => {
  const current = sample({ totalEncodeTimeSeconds: undefined, retransmittedBytesSent: undefined,
    qualityLimitationReason: undefined, framesEncoded: undefined });
  const telemetry = deriveScreenShareSenderTelemetry(undefined, current);
  assert.equal(telemetry.averageEncodeTimeMS, undefined);
  assert.equal(telemetry.encodedFramesPerSecond, undefined);
  assert.equal(telemetry.bitrateBps, undefined);
  assert.equal(telemetry.retransmittedBitrateBps, undefined);
  assert.equal(telemetry.qualityLimitationReason, undefined);
});

run("an overloaded subscriber falls independently and probes back up after recovery", () => {
  const weak = new WebScreenShareQualityController();
  const healthy = new WebScreenShareQualityController();
  const target = 12_000_000;
  for (let second = 1; second <= 4; second++) {
    weak.update({ atMS: second * 1000, fps: 30, limitation: "bandwidth" }, target, 60);
    healthy.update({ atMS: second * 1000, fps: 30, limitation: "none" }, target, 60);
  }
  assert.equal(weak.tier, 2);
  assert.equal(healthy.tier, 0);
  assert.equal(webScreenShareEncoding(2, "motion", target, 60).maxFramerate, 60);
  assert.equal(webScreenShareEncoding(2, "detail", target, 60).scaleResolutionDownBy, 1);
  for (let second = 5; second <= 20; second++) {
    weak.update({ atMS: second * 1000, fps: 30, limitation: "none" }, target, 60);
  }
  assert.equal(weak.tier, 0);
});

run("startup bursts, missing bandwidth and quiet screens do not trigger adaptation", () => {
  const controller = new WebScreenShareQualityController();
  for (let t = 0; t < 700; t += 100) controller.update({ atMS: t, fps: 60, limitation: "cpu" }, 12_000_000, 60);
  for (let t = 1500; t <= 10500; t += 1000) controller.update({ atMS: t, fps: 0, actualBps: 10_000 }, 12_000_000, 60);
  assert.equal(controller.tier, 0);
});

run("smart content ignores sparse changes and requires sustained motion and recovery", () => {
  const quiet = new Uint8ClampedArray(32 * 18 * 4);
  const sparse = quiet.slice();
  sparse.fill(255, 0, 4);
  assert.equal(changedScreenArea(quiet, sparse), 1 / 576);
  const classifier = new ScreenContentClassifier();
  assert.equal(classifier.update(0.90), "balanced");
  assert.equal(classifier.update(0.60), "motion");
  for (let i = 0; i < 4; i++) assert.equal(classifier.update(0.01), "motion");
  assert.equal(classifier.update(0.02), "detail");
});

run("reports native stage timings per completed sample and leaves missing stages unavailable", () => {
  const before = nativePublisherSample({ capturedFrames: 5, pipeline: { readbackMicros: 250, readbackFrames: 1 } }, 1000);
  const after = nativePublisherSample({ capturedFrames: 65, pipeline: {
    readbackMicros: 3250, readbackFrames: 3, gpuProcessUsageBytes: 3 * 1048576, gpuLocalBudgetBytes: null
  } }, 2000);
  const result = nativePublisherMetrics(after, before);
  assert.equal(result.captureFps, 60);
  assert.equal(result.readback, 1.5);
  assert.equal(result.encodeFps, undefined);
  assert.equal(result.hardwareResidence, undefined);
  assert.equal(result.audioDrops, undefined);
  assert.equal(result.gpuUsage, 3);
  assert.equal(result.gpuBudget, undefined);
});

function sample(overrides: Partial<ScreenShareOutboundSample>): ScreenShareOutboundSample {
  return {
    id: "outbound-video",
    timestampMS: 0,
    bytesSent: 0,
    framesEncoded: 0,
    keyFramesEncoded: 0,
    totalEncodeTimeSeconds: 0,
    retransmittedBytesSent: 0,
    frameWidth: 1920,
    frameHeight: 1080,
    targetBitrateBps: 20_000_000,
    qualityLimitationReason: "none",
    qualityLimitationResolutionChanges: 0,
    nackCount: 0,
    pliCount: 0,
    codecMimeType: "video/H264",
    codecFmtpLine: "profile-level-id=42e01f",
    ...overrides
  };
}

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

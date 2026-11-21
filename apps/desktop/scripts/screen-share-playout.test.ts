import { strict as assert } from "node:assert";
import { ScreenShareReceiverSampler } from "../src/lib/screenShareReceiverStats.ts";
import {
  applyScreenSharePlayoutDelay,
  clampScreenSharePlayoutDelayMS,
  nextScreenSharePlayoutDelayMS,
  screenShareAudioPlayoutDelayMS,
  screenShareInitialVideoPlayoutDelayMS,
  screenShareMaxVideoPlayoutDelayMS,
  screenShareMinVideoPlayoutDelayMS,
  screenSharePlayoutDelayCeilingMS,
  screenShareRelayVideoPlayoutDelayMS
} from "../src/lib/screenSharePlayout.ts";

function run(name: string, body: () => void) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const calm = { jitterMS: 4, packetsLost: 0, framesDropped: 0 };

run("calm paths converge to the interactive floor, including distant or relayed peers", () => {
  for (const path of ["direct", "relay", "unknown"]) {
    let target = screenShareInitialVideoPlayoutDelayMS;
    for (let i = 0; i < 12; i++) target = nextScreenSharePlayoutDelayMS(target, calm, screenSharePlayoutDelayCeilingMS(path));
    assert.equal(target, screenShareMinVideoPlayoutDelayMS);
  }
});

run("sustained jitter widens in bounded steps and recovers after the burst", () => {
  for (const [path, ceiling] of [["direct", screenShareMaxVideoPlayoutDelayMS], ["relay", screenShareRelayVideoPlayoutDelayMS]] as const) {
    assert.equal(screenSharePlayoutDelayCeilingMS(path), ceiling);
    let target = screenShareInitialVideoPlayoutDelayMS;
    for (let i = 0; i < 20; i++) target = nextScreenSharePlayoutDelayMS(target, { ...calm, jitterMS: 44 }, ceiling);
    assert.equal(target, ceiling);
    assert.equal(screenShareAudioPlayoutDelayMS(target, ceiling), target);
    assert.equal(nextScreenSharePlayoutDelayMS(target, calm, ceiling), ceiling - 10);
  }
});

run("low-jitter decoder overload avoids adding network delay", () => {
  assert.ok(nextScreenSharePlayoutDelayMS(60, { ...calm, framesDropped: 5 }) < 60);
  assert.equal(nextScreenSharePlayoutDelayMS(60, { ...calm, jitterMS: Number.NaN }), 60);
  assert.equal(nextScreenSharePlayoutDelayMS(60, { ...calm, jitterMS: 16 }), 60);
  assert.equal(nextScreenSharePlayoutDelayMS(60, { ...calm, jitterMS: 16, freezes: 1 }), 80);
  assert.equal(clampScreenSharePlayoutDelayMS(Number.NaN), screenShareInitialVideoPlayoutDelayMS);
});

run("steers the receiver through jitterBufferTarget when it sticks", () => {
  const receiver = { jitterBufferTarget: 60 };
  assert.equal(applyScreenSharePlayoutDelay(receiver, 120), "jitterBufferTarget");
  assert.equal(receiver.jitterBufferTarget, 120);
});

run("falls back to playoutDelayHint when jitterBufferTarget is ignored", () => {
  // An older WebView2 accepts the assignment and keeps its own buffer: the
  // read-back returns the old value, so the hint has to take over.
  const receiver: { jitterBufferTarget: number; playoutDelayHint: number } = {
    jitterBufferTarget: 60,
    playoutDelayHint: 0
  };
  Object.defineProperty(receiver, "jitterBufferTarget", {
    get: () => 60,
    set: () => {},
    enumerable: true
  });
  assert.equal(applyScreenSharePlayoutDelay(receiver, 120), "playoutDelayHint");
  assert.equal(receiver.playoutDelayHint, 0.12);
});

run("uses playoutDelayHint when jitterBufferTarget is absent", () => {
  const receiver = { playoutDelayHint: 0 };
  assert.equal(applyScreenSharePlayoutDelay(receiver, 250), "playoutDelayHint");
  assert.equal(receiver.playoutDelayHint, 0.25);
});

run("reports unsupported instead of pretending to steer", () => {
  assert.equal(applyScreenSharePlayoutDelay(Object.freeze({}), 100), "unsupported");
});

run("measures deltas per stream generation, distinguishes a stopped frame from absent stats", () => {
  const sampler = new ScreenShareReceiverSampler();
  const video = { id: "v1", timestamp: 1000, framesDecoded: 30, framesReceived: 31,
    jitterBufferDelay: 1.2, jitterBufferEmittedCount: 30, totalDecodeTime: 0.12 };
  assert.equal(sampler.sample([video]).decodedFps, undefined);
  assert.equal(sampler.sample([{ ...video, timestamp: 1100 }]).decodedFps, undefined);
  const active = { ...video, framesDecoded: 60, framesReceived: 62, timestamp: 2000,
    jitterBufferDelay: 2.4, jitterBufferEmittedCount: 60, totalDecodeTime: 0.24 };
  const metrics = sampler.sample([active]);
  assert.equal(metrics.receivedFps, 31);
  assert.equal(metrics.decodedFps, 30);
  assert.equal(metrics.decodeMS, 4);
  assert.equal(metrics.jitterBufferMS, 40);
  assert.equal(metrics.freezes, undefined);
  const quiet = sampler.sample([{ ...active, timestamp: 3000 }]);
  assert.equal(quiet.decodedFps, 0);
  assert.equal(quiet.decodeMS, undefined);
  assert.equal(sampler.sample([{ ...video, id: "v2", timestamp: 4000 }]).decodedFps, undefined);
  assert.deepEqual(sampler.sample([]), {});
});

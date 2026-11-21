import { strict as assert } from "node:assert";
import { decideVoicePeerHealth } from "../src/lib/voice-peer-health.ts";

run("retries a peer that stayed disconnected beyond the threshold", () => {
  const decision = decideVoicePeerHealth({
    nowMS: 10_000,
    connectionState: "disconnected",
    disconnectedAtMS: 2_000,
    hiddenSinceMS: 0,
    mediaExpected: true,
    previousSample: null,
    inboundBytes: 0
  });
  assert.deepEqual(decision, { action: "retry", reason: "disconnected" });
});

run("keeps a recently disconnected peer inside the threshold", () => {
  const decision = decideVoicePeerHealth({
    nowMS: 10_000,
    connectionState: "disconnected",
    disconnectedAtMS: 9_000,
    hiddenSinceMS: 0,
    mediaExpected: true,
    previousSample: null,
    inboundBytes: 0
  });
  assert.deepEqual(decision, { action: "keep" });
});

run("seeds the first sample without retrying", () => {
  const decision = decideVoicePeerHealth({
    nowMS: 10_000,
    connectionState: "connected",
    hiddenSinceMS: 0,
    mediaExpected: true,
    previousSample: null,
    inboundBytes: 42
  });
  assert.deepEqual(decision, { action: "seed", sample: { bytes: 42, lastProgressAtMS: 10_000 } });
});

run("retries a visible peer whose inbound audio stalled beyond the threshold", () => {
  const decision = decideVoicePeerHealth({
    nowMS: 20_000,
    connectionState: "connected",
    hiddenSinceMS: 0,
    mediaExpected: true,
    previousSample: { bytes: 100, lastProgressAtMS: 10_000 },
    inboundBytes: 100
  });
  assert.deepEqual(decision, { action: "retry", reason: "stalled" });
});

run("re-seeds instead of retrying when the stall window was fully hidden", () => {
  const decision = decideVoicePeerHealth({
    nowMS: 300_000,
    connectionState: "connected",
    hiddenSinceMS: 250_000,
    mediaExpected: true,
    previousSample: { bytes: 100, lastProgressAtMS: 240_000 },
    inboundBytes: 100
  });
  assert.deepEqual(decision, { action: "seed", sample: { bytes: 100, lastProgressAtMS: 300_000 } });
});

run("keeps progressing media even when the tab is hidden", () => {
  const decision = decideVoicePeerHealth({
    nowMS: 300_000,
    connectionState: "connected",
    hiddenSinceMS: 250_000,
    mediaExpected: true,
    previousSample: { bytes: 100, lastProgressAtMS: 280_000 },
    inboundBytes: 200
  });
  assert.deepEqual(decision, { action: "seed", sample: { bytes: 200, lastProgressAtMS: 300_000 } });
});

run("keeps a silent peer without expected media regardless of wall clock", () => {
  const decision = decideVoicePeerHealth({
    nowMS: 300_000,
    connectionState: "connected",
    hiddenSinceMS: 0,
    mediaExpected: false,
    previousSample: { bytes: 100, lastProgressAtMS: 10_000 },
    inboundBytes: 100
  });
  assert.deepEqual(decision, { action: "seed", sample: { bytes: 100, lastProgressAtMS: 300_000 } });
});

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

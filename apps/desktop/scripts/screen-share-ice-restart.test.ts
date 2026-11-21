import { strict as assert } from "node:assert";
import {
  decideScreenShareRecovery,
  screenShareDisconnectedRebuildDelayMS,
  screenShareIceRestartCooldownMS,
  screenShareIceRestartFallbackMS,  screenShareRebuildDelayMS,
  screenShareUnhealthyRebuildDelayMS
} from "../src/lib/screenShareIceRestart.ts";

function run(name: string, body: () => void) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

run("asks the sharer to restart ICE before rebuilding a failed connection", () => {
  const decision = decideScreenShareRecovery({ state: "failed", nowMS: 1_000 });
  assert.deepEqual(decision, {
    action: "request-ice-restart",
    fallbackDelayMS: screenShareIceRestartFallbackMS
  });
  assert.ok(
    screenShareIceRestartFallbackMS > 0,
    "the rebuild must be a fallback for sharers that ignore the new signal, not a race"
  );
});

run("keeps holding while the restart request is in flight", () => {
  const nowMS = 10_000;
  // A failing connection reports both a failed connection state and a failed ICE
  // state, so the same failure arrives twice within milliseconds. The second
  // report must not shorten the fallback that the first one scheduled.
  const decision = decideScreenShareRecovery({
    state: "failed",
    nowMS,
    lastIceRestartRequestedAtMS: nowMS - 1_000
  });
  assert.deepEqual(decision, { action: "hold" });
});

run("rebuilds once the restart has had time to be answered", () => {
  const nowMS = 10_000;
  const decision = decideScreenShareRecovery({
    state: "failed",
    nowMS,
    lastIceRestartRequestedAtMS: nowMS - screenShareIceRestartFallbackMS
  });
  assert.deepEqual(decision, { action: "rebuild", delayMS: screenShareRebuildDelayMS });
});

run("retries the restart once the cooldown has passed", () => {
  const nowMS = 30_000;
  const decision = decideScreenShareRecovery({
    state: "failed",
    nowMS,
    lastIceRestartRequestedAtMS: nowMS - screenShareIceRestartCooldownMS
  });
  assert.equal(decision.action, "request-ice-restart");
});

run("keeps requesting while the last request is older than the cooldown", () => {
  const nowMS = 30_000;
  const decision = decideScreenShareRecovery({
    state: "failed",
    nowMS,
    lastIceRestartRequestedAtMS: nowMS - screenShareIceRestartCooldownMS - 1
  });
  assert.equal(decision.action, "request-ice-restart");
});

run("does not renegotiate a connection that merely went quiet", () => {
  const decision = decideScreenShareRecovery({ state: "disconnected", nowMS: 0 });
  assert.deepEqual(decision, {
    action: "rebuild",
    delayMS: screenShareDisconnectedRebuildDelayMS
  });
});

run("rebuilds a connected but unhealthy connection after a longer wait", () => {
  const decision = decideScreenShareRecovery({ state: "unhealthy", nowMS: 0 });
  assert.deepEqual(decision, {
    action: "rebuild",
    delayMS: screenShareUnhealthyRebuildDelayMS
  });
});

run("holds a healthy connection", () => {
  assert.deepEqual(decideScreenShareRecovery({ state: "healthy", nowMS: 0 }), { action: "hold" });
});

console.log("screenShareIceRestart tests passed");

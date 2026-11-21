import assert from "node:assert/strict";
import {
  decideScreenSharePathSwitch,
  screenShareDirectIceServers,
  screenSharePathQualityIsDegraded,
  screenShareRelayCandidateDeadlineMS,
  screenShareRelayCandidateVerdict,
  screenShareStartupProbeMS,
  type ScreenSharePathQualitySample
} from "../src/lib/screenShareAutoRelay.ts";

const healthyDirect: ScreenSharePathQualitySample = {
  pathKind: "direct",
  preference: "auto",
  packetLossPercent: 0,
  jitterMS: 4,
  nowMS: 20_000,
  watchingMS: 8_000,
  degradedSamples: 1,
  relaySwitches: 0
};

const tests: Array<[string, () => void]> = [];
const test = (name: string, body: () => void) => tests.push([name, body]);

test("a healthy direct path is left alone", () => {
  assert.equal(decideScreenSharePathSwitch(healthyDirect), "hold");
});

test("a static, low-rate screen on a healthy link stays direct", () => {
  const staticDesktop = { ...healthyDirect, receivedBitrateBps: 30_000, framesDroppedDelta: 5 };
  assert.equal(screenSharePathQualityIsDegraded(staticDesktop), false);
});

test("the switch waits for the degradation to persist", () => {
  const blurry = {
    ...healthyDirect,
    packetLossPercent: 3.5,
    degradedSinceMS: 18_000,
    degradedSamples: 3
  };
  // Only two seconds in: one congested second is not a property of the path.
  assert.equal(decideScreenSharePathSwitch({ ...blurry, nowMS: 20_000 }), "hold");
  assert.equal(decideScreenSharePathSwitch({ ...blurry, nowMS: 22_100 }), "prefer-relay");
});

test("one bad sample does not move the stream", () => {
  const blurry = {
    ...healthyDirect,
    packetLossPercent: 3.5,
    degradedSinceMS: 10_000,
    degradedSamples: 2
  };
  assert.equal(decideScreenSharePathSwitch({ ...blurry, nowMS: 30_000 }), "hold");
});

test("a lossy direct path counts as degraded even at a normal bitrate", () => {
  assert.ok(screenSharePathQualityIsDegraded({ ...healthyDirect, packetLossPercent: 3.5 }));
  assert.ok(screenSharePathQualityIsDegraded({ ...healthyDirect, jitterMS: 55 }));
});

test("the relay switch happens at most once per share", () => {
  const blurry = {
    ...healthyDirect,
    packetLossPercent: 3.5,
    degradedSinceMS: 10_000,
    degradedSamples: 9,
    relaySwitches: 1
  };
  assert.equal(decideScreenSharePathSwitch({ ...blurry, nowMS: 60_000 }), "hold");
});

test("a relay that is worse than the direct path is never chosen automatically", () => {
  const badRelay: ScreenSharePathQualitySample = {
    ...healthyDirect,
    pathKind: "relay",
    preference: "auto",
    packetLossPercent: 3.5,
    degradedSinceMS: 10_000,
    degradedSamples: 6
  };
  // The startup check only ever moves a viewer from direct to relay: the relay is
  // the fallback, and a second automatic switch is what made the path flap.
  assert.equal(decideScreenSharePathSwitch({ ...badRelay, nowMS: 20_000 }), "hold");
  assert.equal(decideScreenSharePathSwitch({ ...badRelay, nowMS: 20_000, watchingMS: 2_000 }), "hold");
});

test("a viewer that already chose a path is left alone", () => {
  const blurry = {
    ...healthyDirect,
    packetLossPercent: 3.5,
    degradedSinceMS: 10_000,
    degradedSamples: 9
  };
  assert.equal(
    decideScreenSharePathSwitch({ ...blurry, nowMS: 20_000, preference: "direct" }),
    "hold"
  );
  assert.equal(
    decideScreenSharePathSwitch({ ...blurry, nowMS: 20_000, preference: "relay" }),
    "hold"
  );
});

test("the automatic choice only exists inside the startup window", () => {
  const blurry = {
    ...healthyDirect,
    packetLossPercent: 3.5,
    degradedSinceMS: 1_000,
    degradedSamples: 9
  };
  assert.equal(
    decideScreenSharePathSwitch({
      ...blurry,
      nowMS: 30_000,
      watchingMS: screenShareStartupProbeMS + 1
    }),
    "hold",
    "a picture the user is already watching is not moved under them"
  );
});

test("a direct-path preference withholds the TURN servers", () => {
  const servers = [
    { urls: "stun:example.test:3478" },
    { urls: ["turn:example.test:3478?transport=udp", "stun:example.test:3478"] },
    { urls: "turns:example.test:5349" }
  ];
  const direct = screenShareDirectIceServers(servers);
  assert.deepEqual(direct, [
    { urls: "stun:example.test:3478" },
    { urls: "stun:example.test:3478" }
  ]);
  assert.deepEqual(screenShareDirectIceServers(undefined), []);
  assert.deepEqual(
    screenShareDirectIceServers([{ urls: "turns:example.test:5349" }]),
    [],
    "a relay-only configuration leaves nothing to gather from"
  );
});

test("a path that cannot be classified is never acted on", () => {
  const unknown = {
    ...healthyDirect,
    pathKind: "unknown" as const,
    packetLossPercent: 9,
    degradedSinceMS: 0,
    degradedSamples: 9
  };
  assert.equal(decideScreenSharePathSwitch(unknown), "hold");
});

test("missing measurements are treated as absent, not as bad", () => {
  assert.equal(
    screenSharePathQualityIsDegraded({
      ...healthyDirect,
      packetLossPercent: 0
    }),
    false,
    "a path with no measurement yet must not be escalated on a guess"
  );
});

tests.push([
  "a relay-only viewer that gathers no relay candidate gives up at the deadline",
  () => {
    const relayWaiting = {
      preference: "relay" as const,
      relayConfigured: true,
      relayCandidates: 0,
      connected: false
    };
    assert.equal(
      screenShareRelayCandidateVerdict({ ...relayWaiting, waitedMS: 1_000 }),
      "wait",
      "one second is not evidence that TURN is broken"
    );
    assert.equal(
      screenShareRelayCandidateVerdict({
        ...relayWaiting,
        waitedMS: screenShareRelayCandidateDeadlineMS
      }),
      "unavailable",
      "no allocation after the deadline means the relay cannot be reached"
    );
    assert.equal(
      screenShareRelayCandidateVerdict({
        ...relayWaiting,
        relayCandidates: 1,
        waitedMS: screenShareRelayCandidateDeadlineMS
      }),
      "ok",
      "an allocated relay candidate is all a relay-only viewer needs"
    );
    assert.equal(
      screenShareRelayCandidateVerdict({
        ...relayWaiting,
        connected: true,
        waitedMS: screenShareRelayCandidateDeadlineMS
      }),
      "ok",
      "an already connected path is never judged unavailable"
    );
    assert.equal(
      screenShareRelayCandidateVerdict({
        ...relayWaiting,
        preference: "auto",
        waitedMS: 60_000
      }),
      "ok",
      "a direct viewer has nothing to wait for"
    );
    assert.equal(
      screenShareRelayCandidateVerdict({
        ...relayWaiting,
        relayConfigured: false,
        waitedMS: 60_000
      }),
      "ok",
      "without a TURN server the watch is never started at all"
    );
  }
]);

for (const [name, body] of tests) {
  body();
  console.log(`ok - ${name}`);
}

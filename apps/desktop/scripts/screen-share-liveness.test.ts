import { strict as assert } from "node:assert";
import {
  decideScreenSharePathLiveness,
  screenShareMissingCandidatePairLimit,
  screenShareWatchGiveUpMS,
  screenShareWatchShouldGiveUp
} from "../src/lib/screenShareLiveness.ts";

function run(name: string, body: () => void) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const stallThresholdMS = 15_000;
const playing = {
  transportBytesReceived: 40_000,
  lastTransportProgressAtMS: 1_000,
  lastPlaybackProgressAtMS: 1_000
};

run("keeps a still screen alive while the ICE pair still carries traffic", () => {
  const liveness = decideScreenSharePathLiveness({
    nowMS: 1_000 + stallThresholdMS * 4,
    documentHidden: false,
    hasPlayableMedia: true,
    // Nothing was encoded for a minute because the desktop never changed.
    mediaProgressed: false,
    transportBytesReceived: playing.transportBytesReceived + 900,
    stallThresholdMS,
    previous: playing
  });

  assert.equal(liveness.stalled, false);
  assert.equal(liveness.transportProgressed, true);
  assert.equal(liveness.lastTransportProgressAtMS, 1_000 + stallThresholdMS * 4);
  assert.equal(liveness.lastPlaybackProgressAtMS, 1_000);
});

run("reports a stall only once the path itself goes silent", () => {
  const stillQuiet = decideScreenSharePathLiveness({
    nowMS: 1_000 + stallThresholdMS - 1,
    documentHidden: false,
    hasPlayableMedia: true,
    mediaProgressed: false,
    transportBytesReceived: playing.transportBytesReceived,
    stallThresholdMS,
    previous: playing
  });
  assert.equal(stillQuiet.stalled, false);

  const silent = decideScreenSharePathLiveness({
    nowMS: 1_000 + stallThresholdMS,
    documentHidden: false,
    hasPlayableMedia: true,
    mediaProgressed: false,
    transportBytesReceived: playing.transportBytesReceived,
    stallThresholdMS,
    previous: playing
  });
  assert.equal(silent.stalled, true);
  assert.equal(silent.lastTransportProgressAtMS, 1_000);
});

run("does not stall before the first frame ever arrives", () => {
  const liveness = decideScreenSharePathLiveness({
    nowMS: 90_000,
    documentHidden: false,
    hasPlayableMedia: false,
    mediaProgressed: false,
    transportBytesReceived: 120,
    stallThresholdMS,
    previous: undefined
  });

  assert.equal(liveness.stalled, false);
  assert.equal(liveness.transportProgressed, true);
  assert.equal(liveness.lastTransportProgressAtMS, 90_000);
  assert.equal(liveness.lastPlaybackProgressAtMS, undefined);
});

run("treats a restarted pair counter as proof that the path is alive", () => {
  const liveness = decideScreenSharePathLiveness({
    nowMS: 30_000,
    documentHidden: false,
    hasPlayableMedia: true,
    mediaProgressed: false,
    // The peer connection was rebuilt, so the new pair counts from zero.
    transportBytesReceived: 1_200,
    stallThresholdMS,
    previous: { transportBytesReceived: 9_000_000, lastTransportProgressAtMS: 1_000 }
  });

  assert.equal(liveness.stalled, false);
  assert.equal(liveness.transportProgressed, true);
  assert.equal(liveness.lastTransportProgressAtMS, 30_000);
});

run("never stalls a hidden tab and pins its timestamps", () => {
  const liveness = decideScreenSharePathLiveness({
    nowMS: 90_000,
    documentHidden: true,
    hasPlayableMedia: true,
    mediaProgressed: false,
    transportBytesReceived: playing.transportBytesReceived,
    stallThresholdMS,
    previous: playing
  });

  assert.equal(liveness.stalled, false);
  assert.equal(liveness.lastTransportProgressAtMS, 90_000);
  assert.equal(liveness.lastPlaybackProgressAtMS, 90_000);
});

run("advances both markers while frames are decoding", () => {
  const liveness = decideScreenSharePathLiveness({
    nowMS: 2_000,
    documentHidden: false,
    hasPlayableMedia: true,
    mediaProgressed: true,
    transportBytesReceived: playing.transportBytesReceived + 50_000,
    stallThresholdMS,
    previous: playing
  });

  assert.equal(liveness.stalled, false);
  assert.equal(liveness.lastTransportProgressAtMS, 2_000);
  assert.equal(liveness.lastPlaybackProgressAtMS, 2_000);
});
  run("declares a path dead when no candidate pair survives", () => {
    // An expired TURN allocation shows up as the pair disappearing while the
    // picture is still on screen. Waiting for the transport timeout would keep
    // that frozen frame up for another eleven seconds.
    const decided = decideScreenSharePathLiveness({
      nowMS: 10_000,
      documentHidden: false,
      hasPlayableMedia: true,
      mediaProgressed: false,
      transportBytesReceived: 5_000,
      missingCandidatePairSamples: screenShareMissingCandidatePairLimit,
      stallThresholdMS: 15_000,
      previous: {
        transportBytesReceived: 5_000,
        lastTransportProgressAtMS: 9_000,
        lastPlaybackProgressAtMS: 9_000
      }
    });
    assert.equal(decided.stalled, true);
  });

  run("tolerates a renegotiation that briefly drops the pair", () => {
    const decided = decideScreenSharePathLiveness({
      nowMS: 10_000,
      documentHidden: false,
      hasPlayableMedia: true,
      mediaProgressed: false,
      transportBytesReceived: 5_000,
      missingCandidatePairSamples: screenShareMissingCandidatePairLimit - 1,
      stallThresholdMS: 15_000,
      previous: {
        transportBytesReceived: 5_000,
        lastTransportProgressAtMS: 9_000,
        lastPlaybackProgressAtMS: 9_000
      }
    });
    assert.equal(decided.stalled, false);
  });

  run("a missing pair does not stall a share that never played", () => {
    const decided = decideScreenSharePathLiveness({
      nowMS: 10_000,
      documentHidden: false,
      hasPlayableMedia: false,
      mediaProgressed: false,
      transportBytesReceived: 0,
      missingCandidatePairSamples: 9,
      stallThresholdMS: 15_000
    });
    assert.equal(decided.stalled, false);
  });
run("stops retrying a share that never renders a frame", () => {
  assert.equal(screenShareWatchShouldGiveUp(undefined, 5_000), false);
  const startedAt = 1_000_000;
  assert.equal(screenShareWatchShouldGiveUp(startedAt, startedAt + 19_000), false);
  assert.equal(screenShareWatchShouldGiveUp(startedAt, startedAt + screenShareWatchGiveUpMS), true);
  assert.equal(screenShareWatchShouldGiveUp(Number.NaN, startedAt), false);
  assert.equal(screenShareWatchShouldGiveUp(0, startedAt), false);
});
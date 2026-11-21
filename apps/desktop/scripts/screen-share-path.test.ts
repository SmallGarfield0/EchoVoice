import { strict as assert } from "node:assert";
import {
  screenSharePathKind,
  screenSharePathKindFromStats,
  screenSharePathLabelKey,
  screenSharePathStatusSuffix,
  selectScreenShareCandidatePair
} from "../src/lib/screenSharePath.ts";

function run(name: string, body: () => void) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

/** Minimal stand-in for RTCStatsReport: only `get` is ever used. */
function reportOf(entries: Record<string, unknown>) {
  return { get: (id: string) => entries[id] };
}

run("calls a pair with a relay candidate relayed", () => {
  assert.equal(screenSharePathKind("relay", "relay"), "relay");
});

run("calls a pair relayed when only one end relayed", () => {
  // The TURN hop is paid for even though the far end gathered a host candidate.
  assert.equal(screenSharePathKind("relay", "host"), "relay");
  assert.equal(screenSharePathKind("srflx", "relay"), "relay");
});

run("calls a pair direct when both ends are reachable candidates", () => {
  assert.equal(screenSharePathKind("host", "host"), "direct");
  assert.equal(screenSharePathKind("host", "srflx"), "direct");
  assert.equal(screenSharePathKind("prflx", "prflx"), "direct");
});

run("refuses to guess direct from a missing candidate type", () => {
  assert.equal(screenSharePathKind("host", undefined), "unknown");
  assert.equal(screenSharePathKind(undefined, "srflx"), "unknown");
  assert.equal(screenSharePathKind("", ""), "unknown");
  // A stats report that dropped the candidate still has to read as unknown, not
  // as a working direct path.
  assert.equal(screenSharePathKind("  ", "host"), "unknown");
});

run("normalizes the candidate type spelling", () => {
  assert.equal(screenSharePathKind(" Relay ", "HOST"), "relay");
  assert.equal(screenSharePathKind("HOST", "Srflx"), "direct");
});

run("resolves the pair candidates through the same stats report", () => {
  const stats = reportOf({
    "pair-1": { localCandidateId: "local-1", remoteCandidateId: "remote-1" },
    "local-1": { candidateType: "host" },
    "remote-1": { candidateType: "relay" }
  });
  assert.equal(
    screenSharePathKindFromStats(stats, {
      localCandidateId: "local-1",
      remoteCandidateId: "remote-1"
    }),
    "relay"
  );
});

run("reports unknown when the pair names a candidate the report lost", () => {
  const stats = reportOf({ "local-1": { candidateType: "host" } });
  assert.equal(screenSharePathKindFromStats(stats, { localCandidateId: "local-1" }), "unknown");
  assert.equal(
    screenSharePathKindFromStats(stats, { localCandidateId: "local-1", remoteCandidateId: "gone" }),
    "unknown"
  );
});

run("names only the paths it actually classified", () => {
  assert.equal(screenSharePathLabelKey("direct"), "screenShare.pathDirect");
  assert.equal(screenSharePathLabelKey("relay"), "screenShare.pathRelay");
  assert.equal(screenSharePathLabelKey("unknown"), undefined);
  assert.equal(screenSharePathLabelKey(undefined), undefined);
  // Every kind the classifier can return is covered, so the label cannot drift
  // out of sync with the classifier without failing here.
  for (const kind of ["direct", "relay"] as const) {
    const stats = reportOf({
      "local-1": { candidateType: kind === "relay" ? "relay" : "host" },
      "remote-1": { candidateType: kind === "relay" ? "host" : "srflx" }
    });
    const resolved = screenSharePathKindFromStats(stats, {
      localCandidateId: "local-1",
      remoteCandidateId: "remote-1"
    });
    assert.equal(resolved, kind);
    assert.equal(screenSharePathLabelKey(resolved) !== undefined, true);
  }
});

run("selects the outgoing pair that carries the most media", () => {
  const selected = selectScreenShareCandidatePair(
    [
      { type: "candidate-pair", state: "waiting", bytesSent: 999_999 },
      { type: "candidate-pair", state: "succeeded", bytesSent: 10, localCandidateId: "a" },
      { type: "candidate-pair", state: "succeeded", bytesSent: 4_000, localCandidateId: "b" }
    ],
    "outgoing"
  );
  assert.equal(selected?.pair.localCandidateId, "b");
  assert.equal(selected?.bytes, 4_000);
});

run("selects the incoming pair by what the receiver read", () => {
  const selected = selectScreenShareCandidatePair(
    [
      { type: "candidate-pair", state: "succeeded", bytesSent: 9_000, bytesReceived: 12, nominated: true },
      { type: "candidate-pair", state: "succeeded", bytesSent: 5, bytesReceived: 8_000, localCandidateId: "rx" }
    ],
    "incoming"
  );
  assert.equal(selected?.pair.localCandidateId, "rx");
});

run("says it is still checking until a path is measured", () => {
  // The suffix used to be empty until frames arrived, which is the one case
  // where the question is asked: a share that never starts. "checking" is a
  // statement about the connection, not a guess at its outcome.
  const translate = (key: string) => key.replace("screenShare.", "");
  assert.equal(screenSharePathStatusSuffix("relay", translate), " · pathRelay");
  assert.equal(screenSharePathStatusSuffix("direct", translate), " · pathDirect");
  assert.equal(screenSharePathStatusSuffix(undefined, translate), " · pathProbing");
  assert.equal(screenSharePathStatusSuffix("unknown", translate), " · pathProbing");
});

run("finds no pair before one succeeds", () => {
  assert.equal(
    selectScreenShareCandidatePair([{ type: "candidate-pair", state: "in-progress", bytesSent: 10 }], "outgoing"),
    undefined
  );
  assert.equal(selectScreenShareCandidatePair([], "outgoing"), undefined);
});

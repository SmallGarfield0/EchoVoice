import assert from "node:assert/strict";

import {
  screenShareConnectionHasFailed,
  screenShareConnectionIsConnecting,
  screenSharePeerReceivesVideo
} from "../src/lib/screenSharePeerDirection.ts";

const results: string[] = [];
function run(name: string, body: () => void) {
  body();
  results.push(name);
}

const connectionWith = (...kinds: string[]) => ({
  getReceivers: () => kinds.map((kind) => ({ track: { kind } }))
});

run("detects the viewer half of a connection", () => {
  assert.equal(screenSharePeerReceivesVideo(connectionWith("video", "audio")), true);
});

run("a sender-only connection is not a viewer", () => {
  assert.equal(screenSharePeerReceivesVideo(connectionWith("audio")), false);
  assert.equal(screenSharePeerReceivesVideo(connectionWith()), false);
});

run("tolerates a receiver whose track has not arrived", () => {
  const pending = { getReceivers: () => [{ track: null }, { track: { kind: "video" } }] };
  assert.equal(screenSharePeerReceivesVideo(pending), true);
});

run("a failed connection is dead in either state field", () => {
  assert.equal(screenShareConnectionHasFailed({ connectionState: "failed" }), true);
  assert.equal(screenShareConnectionHasFailed({ iceConnectionState: "failed" }), true);
});

run("disconnected is not dead, because it recovers on its own", () => {
  // Treating a transient disconnect as dead would drop viewers that were about
  // to come back.
  assert.equal(
    screenShareConnectionHasFailed({ connectionState: "disconnected", iceConnectionState: "disconnected" }),
    false
  );
  assert.equal(screenShareConnectionHasFailed({ connectionState: "connected" }), false);
  assert.equal(screenShareConnectionHasFailed({}), false);
});

run("a connection that never finishes ICE is still connecting", () => {
  // Nothing else would ever release it: it never reaches failed, so the
  // failure cleanup never runs while its encoder keeps working.
  assert.equal(screenShareConnectionIsConnecting({ connectionState: "connecting" }), true);
  assert.equal(screenShareConnectionIsConnecting({ connectionState: "new" }), true);
  assert.equal(screenShareConnectionIsConnecting({ iceConnectionState: "checking" }), true);
  assert.equal(screenShareConnectionIsConnecting({ connectionState: "connected" }), false);
  assert.equal(screenShareConnectionIsConnecting({ connectionState: "failed" }), false);
});
for (const result of results) console.log(`ok - ${result}`);

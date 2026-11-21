import assert from "node:assert/strict";

import {
  remoteAudioDeclickNodeOptions,
  remoteAudioKeyMatchesMember,
  remoteAudioMemberIds
} from "../src/lib/remote-audio.ts";

const results: string[] = [];
function run(name: string, body: () => void) {
  body();
  results.push(name);
}

run("de-click keeps both channels instead of downmixing", () => {
  const options = remoteAudioDeclickNodeOptions();
  // The graph feeds this node straight into the speakers; a mono node here
  // would silently undo the stereo Opus that screen share and accompaniment
  // negotiate.
  assert.equal(options.channelCount, 2);
  assert.deepEqual(options.outputChannelCount, [2]);
  assert.equal(options.channelCountMode, "explicit");
});

run("lists a member attached through the WebAudio path", () => {
  // The WebAudio path is the normal one. Only the fallback creates <audio>
  // elements, so an element-only scan would miss everyone else.
  assert.deepEqual(
    remoteAudioMemberIds(["screen-share:mem_a:track_1", "screen-share:mem_a:track_2"], "screen-share"),
    ["mem_a"]
  );
});

run("keeps scopes apart", () => {
  const keys = [
    "voice:mem_a:t1",
    "accompaniment:mem_b:t2",
    "screen-share:mem_c:t3",
    "screen-share:mem_d:t4"
  ];
  assert.deepEqual(remoteAudioMemberIds(keys, "screen-share"), ["mem_c", "mem_d"]);
  assert.deepEqual(remoteAudioMemberIds(keys, "voice"), ["mem_a"]);
  assert.deepEqual(remoteAudioMemberIds(keys, "accompaniment"), ["mem_b"]);
});

run("does not confuse a member id that contains the prefix", () => {
  assert.deepEqual(remoteAudioMemberIds(["voice:screen-share:t1"], "screen-share"), []);
  assert.deepEqual(remoteAudioMemberIds(["voice:screen-share:t1"], "voice"), ["screen-share"]);
});

run("detaching a share leaves the member's voice attached", () => {
  // A screen-share peer connection closing must not touch audio that lives on
  // the voice peer connection: the microphone is still connected and nobody
  // re-attaches it until that connection is rebuilt.
  assert.equal(remoteAudioKeyMatchesMember("voice:mem_a:mic", "mem_a", "screen-share"), false);
  assert.equal(remoteAudioKeyMatchesMember("accompaniment:mem_a:music", "mem_a", "screen-share"), false);
  assert.equal(remoteAudioKeyMatchesMember("screen-share:mem_a:desktop", "mem_a", "screen-share"), true);
});

run("an unscoped detach still clears every scope for the member", () => {
  assert.equal(remoteAudioKeyMatchesMember("voice:mem_a:mic", "mem_a"), true);
  assert.equal(remoteAudioKeyMatchesMember("screen-share:mem_a:desktop", "mem_a"), true);
  assert.equal(remoteAudioKeyMatchesMember("voice:mem_b:mic", "mem_a"), false);
});

for (const result of results) console.log(`ok - ${result}`);

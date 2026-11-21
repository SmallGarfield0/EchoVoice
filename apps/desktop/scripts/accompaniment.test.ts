import assert from "node:assert/strict";
import {
  accompanimentSessionName,
  accompanimentSourceDisplayName,
  accompanimentSourceSessionName,
  enhanceAccompanimentOpusSDP
} from "../src/lib/accompaniment.ts";
import type { DesktopAudioProcessSource } from "../src/lib/types.ts";

const source: DesktopAudioProcessSource = {
  sourceId: "audio-process:42",
  name: "Now Playing - Echo Music",
  appName: "music-player",
  processId: 42,
  active: true
};

assert.equal(accompanimentSourceDisplayName(source), "Now Playing - Echo Music");
assert.equal(accompanimentSourceSessionName(source), "Now Playing - Echo Music");
assert.equal(accompanimentSourceDisplayName({ ...source, name: "  " }), "music-player");
assert.equal(Array.from(accompanimentSourceSessionName({ ...source, name: "音".repeat(140) })).length, 120);
assert.equal(accompanimentSessionName("  browser-song.mp3  ", "Web audio file"), "browser-song.mp3");
assert.equal(accompanimentSessionName("", "Web audio file"), "Web audio file");

const enhancedSDP = enhanceAccompanimentOpusSDP([
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "m=audio 9 UDP/TLS/RTP/SAVPF 109",
  "a=rtpmap:109 opus/48000/2",
  "a=fmtp:109 minptime=10;useinbandfec=1;stereo=0"
].join("\r\n"));
assert.match(enhancedSDP, /a=fmtp:111 minptime=10;useinbandfec=1/);
assert.match(
  enhancedSDP,
  /a=fmtp:109 minptime=10;stereo=1;sprop-stereo=1;maxaveragebitrate=256000;useinbandfec=1;usedtx=0;cbr=0/
);

console.log("accompaniment source naming tests passed");

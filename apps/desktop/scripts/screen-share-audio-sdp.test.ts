import { strict as assert } from "node:assert";
import { enhanceAccompanimentOpusSDP, enhanceScreenShareOpusSDP } from "../src/lib/accompaniment.ts";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function section(sdp: string, kind: "audio" | "video"): string {
  return sdp
    .split("\r\nm=")
    .slice(1)
    .map((value) => `m=${value}`)
    .find((value) => value.startsWith(`m=${kind} `)) ?? "";
}

// What Chromium actually offers for a screen-share track with system audio.
const browserScreenShareSdp = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=sendonly",
  "a=rtpmap:96 H264/90000",
  "a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c20",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
  "a=ssrc:1 cname:test",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=mid:1",
  "a=sendonly",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=ssrc:2 cname:test"
].join("\r\n");

run("asks the screen-share encoder for stereo at a real bitrate", () => {
  const enhanced = enhanceScreenShareOpusSDP(browserScreenShareSdp);
  const audio = section(enhanced, "audio");
  assert.match(audio, /stereo=1/);
  assert.match(audio, /sprop-stereo=1/);
  assert.match(audio, /maxaveragebitrate=160000/);
  assert.match(audio, /useinbandfec=1/);
  assert.match(audio, /usedtx=0/);
});

run("keeps the parameters the browser already negotiated", () => {
  const audio = section(enhanceScreenShareOpusSDP(browserScreenShareSdp), "audio");
  assert.match(audio, /minptime=10/, "minptime must survive the rewrite");
  assert.match(audio, /a=rtpmap:111 opus\/48000\/2/);
});

run("leaves the video section byte for byte identical", () => {
  const enhanced = enhanceScreenShareOpusSDP(browserScreenShareSdp);
  assert.equal(section(enhanced, "video"), section(browserScreenShareSdp, "video"));
});

run("is idempotent, so a renegotiation cannot grow the fmtp", () => {
  const once = enhanceScreenShareOpusSDP(browserScreenShareSdp);
  assert.equal(enhanceScreenShareOpusSDP(once), once);
});

run("touches every audio section on a screen-share connection", () => {
  const twoAudio = `${browserScreenShareSdp}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 112\r\nc=IN IP4 0.0.0.0\r\na=mid:2\r\na=sendonly\r\na=rtpmap:112 opus/48000/2\r\na=fmtp:112 minptime=10`;
  const enhanced = enhanceScreenShareOpusSDP(twoAudio);
  const sections = enhanced.split("\r\nm=audio ").slice(1);
  assert.equal(sections.length, 2);
  for (const audio of sections) {
    assert.match(audio, /stereo=1/);
  }
});

run("does nothing to an SDP without audio", () => {
  const videoOnly = browserScreenShareSdp.split("\r\nm=audio")[0];
  assert.equal(enhanceScreenShareOpusSDP(videoOnly), videoOnly);
});

run("does nothing when the audio is not Opus", () => {
  const pcmu = browserScreenShareSdp.replace("opus/48000/2", "PCMU/8000").replace("a=fmtp:111 minptime=10;useinbandfec=1\r\n", "");
  assert.equal(enhanceScreenShareOpusSDP(pcmu), pcmu);
});

run("the voice helper still treats only the second audio section as music", () => {
  // Microphone first, desktop accompaniment second: the microphone must keep
  // exactly the parameters the browser chose for it.
  const voiceSdp = `${browserScreenShareSdp}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 112\r\nc=IN IP4 0.0.0.0\r\na=mid:2\r\na=sendonly\r\na=rtpmap:112 opus/48000/2\r\na=fmtp:112 minptime=10`;
  const enhanced = enhanceAccompanimentOpusSDP(voiceSdp);
  const [microphone, accompaniment] = enhanced.split("\r\nm=audio ").slice(1);
  assert.equal(microphone, section(voiceSdp, "audio").replace(/^m=audio /, ""), "the microphone section must not change");
  assert.match(accompaniment, /maxaveragebitrate=256000/);
});

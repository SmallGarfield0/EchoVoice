import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const libDir = join(import.meta.dirname, "..", "src", "lib");
const setupSource = readFileSync(join(libDir, "screen-share-setup.svelte.ts"), "utf8");
const transportSource = readFileSync(
  join(libDir, "screen-share-transport.svelte.ts"),
  "utf8"
);

const results: string[] = [];
function run(name: string, body: () => void) {
  body();
  results.push(name);
}

// Every setter that changes what gets encoded must reach the running share,
// not only the next viewer that joins. Extracting the body keeps the check
// honest: a call in a comment or in a neighbouring method does not count.
const qualitySetters = [
  "selectResolution",
  "selectFrameRate",
  "selectBitrate",
  "selectContentMode"
];

function methodBody(source: string, signatureStart: string): string {
  source = source.replace(/\r\n/g, "\n");
  const start = source.indexOf(signatureStart);
  assert.notEqual(start, -1, `missing ${signatureStart}`);
  const end = source.indexOf("\n  }\n", start);
  assert.notEqual(end, -1, `unterminated ${signatureStart}`);
  return source.slice(start, end);
}

run("every setting that shapes the stream re-applies it", () => {
  for (const setter of [...qualitySetters, "toggleAudio", "toggleCursorCapture"]) {
    const body = methodBody(setupSource, `  ${setter}(`);
    assert.ok(
      body.includes("this.noteShareSettingsChange()"),
      `${setter} must call noteShareSettingsChange so a change either reaches running viewers or is reported`
    );
  }
});

run("the native encoder accepts a new bitrate without a new session", () => {
  const body = methodBody(setupSource, "  selectBitrate(");
  assert.ok(
    body.includes("this.hooks.nativeScreenShareSenderSession()"),
    "a running native session must be detected before falling back to the pending hint"
  );
  assert.ok(
    body.includes("applyNativeShareBitrate"),
    "the bitrate must reach the running encoder, not only the next session"
  );
  const applyBody = methodBody(setupSource, "  private async applyNativeShareBitrate(");
  assert.ok(
    applyBody.includes("setNativeScreenShareMaximumBitrate"),
    "it must go through the session command that reaches the encoder"
  );
  assert.ok(
    setupSource.includes("if (applied && this.pendingQuality.get(key) === request) this.pendingQuality.delete(key)"),
    "a quality acknowledgement must clear only its own outstanding change"
  );
});

run("the native frame pump accepts a new cadence without a new session", () => {
  const body = methodBody(setupSource, "  selectFrameRate(");
  assert.ok(
    body.includes("this.hooks.nativeScreenShareSenderSession()"),
    "a running native session must be detected before falling back to the pending hint"
  );
  assert.ok(
    body.includes("applyNativeShareFrameRate"),
    "the frame rate must reach the running pump, not only the next session"
  );
  const applyBody = methodBody(setupSource, "  private async applyNativeShareFrameRate(");
  assert.ok(
    applyBody.includes("setNativeScreenShareFrameRate"),
    "it must go through the session command that reaches the pump"
  );
  assert.ok(
    transportSource.includes('setNativeScreenShareQuality(session.sessionId, { kind: "frame-rate", value: Math.round(frameRate) }'),
    "live frame rate must reach the local native quality command"
  );
});

run("noteShareSettingsChange retunes the web senders and flags the native gap", () => {  const body = methodBody(setupSource, "  private noteShareSettingsChange(");
  assert.ok(
    body.includes("applyWebScreenShareSenderSettings()"),
    "the web senders must be retuned in place"
  );
  assert.ok(
    body.includes("shareSettingsPending = true"),
    "a native share cannot be retuned, so the change must be flagged for the label"
  );
});

run("the transport reapplies to every sender without tearing one down", () => {
  const body = methodBody(transportSource, "  async applyScreenShareSenderSettings(");
  assert.ok(body.includes("this.screenShareSenders"), "it must walk the live senders");
  assert.ok(
    body.includes("configureScreenShareSender(sender, peerId, { stable: true })"),
    "it must reuse the stable configuration path"
  );
  assert.ok(
    body.includes(".catch("),
    "a browser that refuses one knob must not reject the whole reapply"
  );
});

run("a live audio toggle renegotiates instead of editing the capture stream", () => {
  const body = methodBody(
    transportSource,
    "  async setOutgoingScreenShareAudioEnabled("
  );
  assert.ok(
    body.includes("screenSharePeerConnections"),
    "it must reach the connections that are already sending"
  );
  assert.ok(
    body.includes("renegotiateScreenSharePeerConnection("),
    "a new or removed m-line only reaches the viewer through a renegotiation"
  );
  assert.ok(
    body.includes("Promise.allSettled("),
    "one viewer failing to renegotiate must not abort the others"
  );
});

run("constraints reach the live capture, not only the pending one", () => {
  const body = methodBody(setupSource, "  async applyPendingWebConstraints(");
  assert.ok(
    body.includes("this.hooks.localScreenShareStream()"),
    "a running share has no pending stream, so the live track must be retargeted"
  );
  assert.ok(
    body.includes("pendingWebScreenShareStream()"),
    "before the share starts there is only a pending stream"
  );
});

for (const result of results) console.log(`ok - ${result}`);

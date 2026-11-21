import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guards the screen-share transport's audio hooks.
//
// Closing a share used to call detachRemoteAudioForMember() without a scope,
// which removed the member's *voice* graph as well: the microphone kept
// sending, but nothing re-attaches it until the voice connection is rebuilt.
// The scope is the whole fix, so it gets a test that reads the source.

const source = readFileSync(
  new URL("../src/lib/screen-share-transport.svelte.ts", import.meta.url),
  "utf8"
);

const results: string[] = [];
function run(name: string, body: () => void) {
  body();
  results.push(name);
}

const callLines = (needle: string) =>
  source
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => entry.line.includes(needle) && !entry.line.includes(`${needle.split("(")[0]}:`));

run("every screen-share detach names the screen-share scope", () => {
  const detaches = callLines("detachRemoteAudioForMember(");
  assert.ok(detaches.length >= 2, `expected the share and close-all paths, found ${detaches.length}`);
  for (const detach of detaches) {
    assert.ok(
      detach.line.includes('"screen-share"'),
      `line ${detach.number} detaches audio without the screen-share scope: ${detach.line}`
    );
  }
});

run("every screen-share attach names the screen-share scope", () => {
  const attaches = callLines("attachRemoteAudio(");
  assert.ok(attaches.length >= 1, "expected the track handler to attach share audio");
  for (const attach of attaches) {
    assert.ok(
      attach.line.includes('"screen-share"'),
      `line ${attach.number} attaches share audio under another scope: ${attach.line}`
    );
  }
});

for (const result of results) console.log(`ok - ${result}`);

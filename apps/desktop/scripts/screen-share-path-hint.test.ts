import test from "node:test";
import assert from "node:assert/strict";

import {
  rememberScreenSharePathHint,
  screenSharePathHintIsRelayOnly,
  takeScreenSharePathHint
} from "../src/lib/screenSharePathHint.ts";

test("a recorded hint is handed to exactly one watch", () => {
  rememberScreenSharePathHint("share-a", "mem-1", "relay");
  assert.equal(takeScreenSharePathHint("share-a", "mem-1"), "relay");
  assert.equal(takeScreenSharePathHint("share-a", "mem-1"), undefined);
});

test("hints are keyed by both share and member", () => {
  rememberScreenSharePathHint("share-b", "mem-1", "relay");
  assert.equal(takeScreenSharePathHint("share-c", "mem-1"), undefined);
  assert.equal(takeScreenSharePathHint("share-b", "mem-2"), undefined);
  assert.equal(takeScreenSharePathHint("share-b", "mem-1"), "relay");
});

test("an empty share or member never records a hint", () => {
  rememberScreenSharePathHint("", "mem-1", "relay");
  rememberScreenSharePathHint("share-d", "", "relay");
  assert.equal(takeScreenSharePathHint("", "mem-1"), undefined);
  assert.equal(takeScreenSharePathHint("share-d", ""), undefined);
});

test("only a relay hint shortens the ICE acceptance wait", () => {
  assert.equal(screenSharePathHintIsRelayOnly("relay"), true);
  assert.equal(screenSharePathHintIsRelayOnly("direct"), false);
  assert.equal(screenSharePathHintIsRelayOnly(undefined), false);
});

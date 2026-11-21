import assert from "node:assert/strict";
import {
  normalizedRemoteControlPoint,
  normalizeNativeRemoteControlInputEvent,
  SerialAsyncQueue
} from "../src/lib/remote-control.ts";
import type { RemoteControlInputEvent } from "../src/lib/types.ts";

const centered = normalizedRemoteControlPoint({
  left: 100,
  top: 50,
  width: 800,
  height: 600,
  intrinsicWidth: 1920,
  intrinsicHeight: 1080
}, 500, 350);
assert.deepEqual(centered, { x: 0.5, y: 0.5 });

const topLetterbox = normalizedRemoteControlPoint({
  left: 100,
  top: 50,
  width: 800,
  height: 600,
  intrinsicWidth: 1920,
  intrinsicHeight: 1080
}, 500, 100);
assert.equal(topLetterbox, null, "pointer coordinates in letterboxing must not reach the controlled host");

assert.deepEqual(
  normalizeNativeRemoteControlInputEvent({ type: "pointer_move", x: 0, y: 0 } as RemoteControlInputEvent),
  { type: "pointer_move", x: 0, y: 0, buttons: 0 }
);
assert.deepEqual(
  normalizeNativeRemoteControlInputEvent({
    type: "pointer_button",
    x: 0,
    y: 0,
    button: 0,
    buttons: 0,
    pressed: false
  }),
  { type: "pointer_button", x: 0, y: 0, button: 0, buttons: 0, pressed: false }
);
assert.deepEqual(
  normalizeNativeRemoteControlInputEvent({
    type: "key",
    code: "KeyA",
    key: "a",
    pressed: false,
    repeat: false
  } as RemoteControlInputEvent),
  { type: "key", code: "KeyA", key: "a", pressed: false, repeat: false, modifiers: [] }
);

const queue = new SerialAsyncQueue();
const applied: number[] = [];
const errors: string[] = [];
queue.enqueue(async () => {
  await new Promise((resolve) => setTimeout(resolve, 15));
  applied.push(1);
}, (error) => errors.push(String(error)));
queue.enqueue(async () => {
  applied.push(2);
  throw new Error("expected failure");
}, (error) => errors.push(String(error)));
queue.enqueue(async () => {
  applied.push(3);
}, (error) => errors.push(String(error)));
await queue.idle();

assert.deepEqual(applied, [1, 2, 3], "native input commands must execute in websocket order");
assert.equal(errors.length, 1, "a failed input must not break the remaining queue");
console.log("remote control frontend tests passed");

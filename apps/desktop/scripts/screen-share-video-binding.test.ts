import assert from "node:assert/strict";

import { screenShareStreamOwnerMemberId } from "../src/lib/screenShareStreamKey.ts";
import { attachScreenShareVideo } from "../src/lib/screenShareVideoBinding.ts";

const results: string[] = [];
function run(name: string, body: () => void) {
  body();
  results.push(name);
}

const share = { share_id: "share_1", owner_member_id: "mem_owner" };

run("files the stream under the share owner, not the peer key", () => {
  // The peer key here is a participant id; storing the stream under it is what
  // makes the card look up `mem_owner`, find nothing, and show "waiting" while
  // the stats report decoded frames.
  assert.equal(
    screenShareStreamOwnerMemberId({
      share,
      boundShareId: "share_1",
      fallbackMemberId: "part_123"
    }),
    "mem_owner"
  );
});

run("keeps the fallback when the connection is bound to a different share", () => {
  assert.equal(
    screenShareStreamOwnerMemberId({
      share,
      boundShareId: "share_other",
      fallbackMemberId: "mem_fallback"
    }),
    "mem_fallback"
  );
});

run("keeps the fallback when no share is known yet", () => {
  assert.equal(
    screenShareStreamOwnerMemberId({
      share: undefined,
      boundShareId: "share_1",
      fallbackMemberId: "mem_fallback"
    }),
    "mem_fallback"
  );
});

run("keeps the fallback when the connection has no bound share", () => {
  assert.equal(
    screenShareStreamOwnerMemberId({
      share,
      boundShareId: "",
      fallbackMemberId: "mem_fallback"
    }),
    "mem_fallback"
  );
});

const stream = { id: "remote-screen-share" } as unknown as MediaStream;

function createNode() {
  const listeners = new Map<string, () => void>();
  let plays = 0;
  let pauses = 0;
  const node = {
    autoplay: false,
    muted: false,
    playsInline: false,
    srcObject: null as unknown,
    play() {
      plays += 1;
      return Promise.resolve();
    },
    pause() {
      pauses += 1;
    },
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    }
  };
  return { node, listeners, plays: () => plays, pauses: () => pauses };
}

run("binds a stream that arrives after the element was mounted empty", () => {
  const { node, plays } = createNode();
  const binding = attachScreenShareVideo(node, undefined);
  assert.equal(node.srcObject, null);
  assert.equal(plays(), 0, "an empty element has nothing to play yet");
  binding.update(stream);
  assert.equal(node.srcObject, stream);
  assert.equal(plays(), 1);
  binding.destroy();
});

run("clears the element when the share goes away", () => {
  const { node, listeners, pauses } = createNode();
  const binding = attachScreenShareVideo(node, stream);
  binding.update(undefined);
  assert.equal(node.srcObject, null);
  binding.destroy();
  assert.equal(listeners.size, 0);
  assert.equal(pauses(), 1);
});

for (const name of results) {
  console.log(`ok - ${name}`);
}

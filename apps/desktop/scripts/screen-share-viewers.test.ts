import { strict as assert } from "node:assert";
import { staleNativeScreenShareViewerPeerIds } from "../src/lib/screenShareViewers.ts";

run("keeps a native viewer when participant and member IDs differ", () => {
  const states = new Map([
    ["vp_device_a", { member_id: "mem_viewer" }]
  ]);

  assert.deepEqual(
    staleNativeScreenShareViewerPeerIds(["vp_device_a"], ["vp_device_a"], ["mem_viewer"], states),
    []
  );
});

run("keeps an active device-level watch session during a stale member snapshot", () => {
  const states = new Map([
    ["vp_device_a", { member_id: "mem_viewer" }]
  ]);

  assert.deepEqual(
    staleNativeScreenShareViewerPeerIds(["vp_device_a"], ["vp_device_a"], [], states),
    []
  );
});

run("removes a resolved participant after its member stops watching", () => {
  const states = new Map([
    ["vp_device_a", { member_id: "mem_viewer" }]
  ]);

  assert.deepEqual(
    staleNativeScreenShareViewerPeerIds(["vp_device_a"], [], [], states),
    ["vp_device_a"]
  );
});

run("keeps an unresolved participant until voice state synchronization catches up", () => {
  assert.deepEqual(
    staleNativeScreenShareViewerPeerIds(["vp_device_a"], [], [], new Map()),
    []
  );
});

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

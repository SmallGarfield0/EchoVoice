// Screen share identity resolution: the three ids are easy to mix up, and a
// wrong one silently orphans a live peer connection instead of failing loudly.
import assert from "node:assert/strict";
import {
  screenShareMemberIdForPeer,
  screenShareOwnerPeerId,
  screenSharePeerIdForIdentity
} from "../src/lib/screenShareIdentities.ts";

const results = [];

async function run(name, body) {
  await body();
  results.push(`ok - ${name}`);
}

const voice = new Map([
  ["mem_alice", "part_alice"],
  ["mem_bob", "part_bob"]
]);
const members = new Map([
  ["part_alice", "mem_alice"],
  ["part_bob", "mem_bob"]
]);
const lookups = {
  hasConnection: (peerId) => peerId === "part_alice" || peerId === "part_bob",
  participantIdForMember: (memberId) => voice.get(memberId),
  memberIdForParticipant: (participantId) => members.get(participantId),
  memberIdForOwnerParticipant: () => undefined,
  peerIdForMemberShare: () => undefined
};

await run("a share is keyed by its owner participant id", async () => {
  assert.equal(
    screenShareOwnerPeerId({ owner_member_id: "mem_alice", owner_participant_id: "part_alice" }, lookups),
    "part_alice"
  );
});

await run("a share without a participant id falls back to the voice state", async () => {
  assert.equal(screenShareOwnerPeerId({ owner_member_id: "mem_alice" }, lookups), "part_alice");
});

await run("a share nobody joined yet falls back to the member id", async () => {
  assert.equal(screenShareOwnerPeerId({ owner_member_id: "mem_zed" }, lookups), "mem_zed");
});

await run("a participant id is already a peer key", async () => {
  assert.equal(screenSharePeerIdForIdentity("part_bob", lookups), "part_bob");
});

await run("a member id is translated to its participant id", async () => {
  assert.equal(screenSharePeerIdForIdentity("mem_bob", lookups), "part_bob");
});

await run("an unrelated member id is returned untouched", async () => {
  assert.equal(screenSharePeerIdForIdentity("mem_zed", lookups), "mem_zed");
});

await run("an owned share wins over the voice state for the same member", async () => {
  const withShare = {
    ...lookups,
    peerIdForMemberShare: (memberId) => (memberId === "mem_bob" ? "part_bob_stale" : undefined)
  };
  assert.equal(screenSharePeerIdForIdentity("mem_bob", withShare), "part_bob_stale");
});

await run("a peer id maps back to its member for display", async () => {
  assert.equal(screenShareMemberIdForPeer("part_alice", lookups), "mem_alice");
});

await run("a peer id whose member left still maps through the share owner", async () => {
  const withOwner = {
    ...lookups,
    memberIdForParticipant: () => undefined,
    memberIdForOwnerParticipant: (participantId) => (participantId === "part_bob" ? "mem_bob" : undefined)
  };
  assert.equal(screenShareMemberIdForPeer("part_bob", withOwner), "mem_bob");
});

await run("an unknown peer id is returned untouched rather than dropped", async () => {
  assert.equal(screenShareMemberIdForPeer("part_unknown", lookups), "part_unknown");
});

for (const result of results) console.log(result);

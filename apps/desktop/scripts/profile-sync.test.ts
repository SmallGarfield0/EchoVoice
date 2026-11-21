import assert from "node:assert/strict";

import {
  decideProfileSync,
  effectiveProfileForServer,
  mergeSyncableProfileFromMember
} from "../src/lib/profile-sync.ts";
import type { LocalUserProfile, Member } from "../src/lib/types.ts";

const local: LocalUserProfile = {
  local_profile_id: "device-a",
  display_name: "Local profile",
  avatar_data_url: "",
  avatar_sha256: "",
  avatar_color: "#7db5e8",
  bio: "Local bio",
  updated_at_ms: 2000
};

const remote: Member = {
  member_id: "member-a",
  display_name: "Remote profile",
  avatar_data_url: "",
  avatar_sha256: "",
  avatar_color: "#7db5e8",
  bio: "Remote bio",
  local_profile_id: "device-a",
  role_ids: [],
  is_owner: true,
  is_banned: false,
  last_seen_at_ms: 0,
  profile_updated_at_ms: 1000,
  online: true,
  linked_devices: 1
};

assert.equal(decideProfileSync(local, remote), "upload", "newer local data should upload automatically");
assert.equal(
  decideProfileSync({ ...local, updated_at_ms: 500 }, remote),
  "download",
  "newer canonical server data should update the local snapshot"
);
assert.equal(
  decideProfileSync(
    {
      ...local,
      display_name: remote.display_name,
      bio: remote.bio,
      updated_at_ms: 3000
    },
    remote
  ),
  "none",
  "matching profile content should not cause a redundant upload"
);
assert.equal(
  decideProfileSync({ ...local, updated_at_ms: remote.profile_updated_at_ms }, remote),
  "upload",
  "equal revisions with conflicting content should use the currently opened local profile"
);
assert.equal(
  decideProfileSync({ ...local, avatar_color: "#76c7a1" }, remote),
  "upload",
  "avatar color changes must participate in profile synchronization"
);

const personalizedRemote: Member = {
  ...remote,
  display_name: "Server nickname",
  bio: "Server-only bio",
  profile_updated_at_ms: 4000,
  profile_overrides: {
    display_name: true,
    avatar: false,
    bio: true
  }
};
assert.equal(
  decideProfileSync(local, personalizedRemote),
  "none",
  "server-specific name and bio must be excluded from global profile sync"
);
assert.deepEqual(
  mergeSyncableProfileFromMember(local, {
    ...personalizedRemote,
    avatar_color: "#76c7a1"
  }),
  {
    ...local,
    avatar_data_url: "",
    avatar_sha256: "",
    avatar_color: "#76c7a1",
    updated_at_ms: 4000
  },
  "downloading a profile must only replace fields that still follow the global profile"
);
assert.deepEqual(
  effectiveProfileForServer(local, personalizedRemote),
  {
    ...local,
    display_name: "Server nickname",
    bio: "Server-only bio",
    updated_at_ms: 4000
  },
  "effective server profile must combine overrides with the local global profile"
);

console.log("profile sync tests passed");

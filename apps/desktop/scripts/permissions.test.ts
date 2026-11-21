import assert from "node:assert/strict";
import { hasEffectivePermission, roleAllowsPermission } from "../src/lib/permissions.ts";
import type { Member, Permission, ServerRole } from "../src/lib/types.ts";

const permission = "manage_channels" satisfies Permission;
const everyone = role("everyone", true, {});
const moderator = role("moderator", false, { manage_channels: true });
const member = {
  member_id: "member-1",
  display_name: "Member",
  bio: "",
  local_profile_id: "profile-1",
  role_ids: [moderator.role_id],
  is_owner: false,
  is_banned: false,
  last_seen_at_ms: 0,
  profile_updated_at_ms: 0,
  online: true,
  linked_devices: 1
} satisfies Member;

assert.equal(hasEffectivePermission(permission, true, member, [everyone], ""), true, "owner must have every permission");
assert.equal(
  hasEffectivePermission(permission, true, member, [everyone], "missing-role"),
  true,
  "a stale role preview must fall back to the real owner permissions"
);
assert.equal(roleAllowsPermission(role("files", false, { download_files: true }), "view_files"), true);
assert.equal(roleAllowsPermission(role("files", false, { manage_files: true }), "upload_files"), true);
assert.equal(roleAllowsPermission(role("files", false, { manage_files: true }), "download_files"), true);
assert.equal(
  hasEffectivePermission(permission, true, member, [everyone, moderator], everyone.role_id),
  false,
  "an active role preview must show the selected role permissions instead of owner permissions"
);
assert.equal(
  hasEffectivePermission(permission, false, member, [everyone, moderator], ""),
  true,
  "assigned roles must grant permissions"
);
assert.equal(
  hasEffectivePermission(permission, false, { ...member, role_ids: [] }, [role("everyone", true, { manage_channels: true })], ""),
  true,
  "everyone permissions must apply to every member"
);

console.log("permission tests passed");

function role(roleId: string, isEveryone: boolean, permissions: Partial<Record<Permission, boolean>>): ServerRole {
  return {
    role_id: roleId,
    name: roleId,
    color: "",
    display_separately: false,
    position: isEveryone ? 0 : 1000,
    is_everyone: isEveryone,
    member_count: 0,
    permissions: permissions as Record<Permission, boolean>
  };
}

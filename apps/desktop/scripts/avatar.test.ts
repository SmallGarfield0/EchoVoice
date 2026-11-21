import assert from "node:assert/strict";
import {
  avatarColorForIdentity,
  avatarColorPalette,
  avatarStyleVariables,
  avatarTextColor,
  normalizeAvatarColor
} from "../src/lib/avatar.ts";

assert.equal(avatarColorForIdentity("member-a"), avatarColorForIdentity("member-a"));
assert.ok(avatarColorPalette.includes(avatarColorForIdentity("member-a") as typeof avatarColorPalette[number]));
assert.equal(normalizeAvatarColor("#7DB5E8", "member-a"), "#7db5e8");
assert.equal(normalizeAvatarColor("invalid", "member-a"), avatarColorForIdentity("member-a"));
assert.equal(avatarTextColor("#ffffff"), "#071018");
assert.equal(avatarTextColor("#111111"), "#ffffff");
assert.ok(avatarStyleVariables("#7db5e8", "member-a").includes("--member-avatar-bg: #7db5e8"));

console.log("avatar color tests passed");

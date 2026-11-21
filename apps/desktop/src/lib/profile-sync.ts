import type { LocalUserProfile, Member, ProfileOverrides } from "./types";

export type ProfileSyncDecision = "none" | "upload" | "download";

export function decideProfileSync(local: LocalUserProfile, remote: Member): ProfileSyncDecision {
  if (profileContentMatches(local, remote)) return "none";
  return local.updated_at_ms >= Number(remote.profile_updated_at_ms ?? 0) ? "upload" : "download";
}

export function profileContentMatches(local: LocalUserProfile, remote: Member): boolean {
  const overrides = profileOverrides(remote);
  return (
    (overrides.display_name || local.display_name === remote.display_name) &&
    (overrides.avatar || (
      (local.avatar_data_url ?? "") === (remote.avatar_data_url ?? "") &&
      (local.avatar_sha256 ?? "") === (remote.avatar_sha256 ?? "") &&
      (local.avatar_color ?? "") === (remote.avatar_color ?? "")
    )) &&
    (overrides.bio || local.bio === (remote.bio ?? ""))
  );
}

export function profileOverrides(remote?: Pick<Member, "profile_overrides"> | null): ProfileOverrides {
  return {
    display_name: Boolean(remote?.profile_overrides?.display_name),
    avatar: Boolean(remote?.profile_overrides?.avatar),
    bio: Boolean(remote?.profile_overrides?.bio)
  };
}

export function mergeSyncableProfileFromMember(
  local: LocalUserProfile,
  remote: Member
): LocalUserProfile {
  const overrides = profileOverrides(remote);
  return {
    ...local,
    display_name: overrides.display_name ? local.display_name : remote.display_name,
    avatar_data_url: overrides.avatar ? local.avatar_data_url : remote.avatar_data_url ?? "",
    avatar_sha256: overrides.avatar ? local.avatar_sha256 : remote.avatar_sha256 ?? "",
    avatar_color: overrides.avatar ? local.avatar_color : remote.avatar_color ?? "",
    bio: overrides.bio ? local.bio : remote.bio ?? "",
    updated_at_ms: remote.profile_updated_at_ms
  };
}

export function effectiveProfileForServer(
  local: LocalUserProfile,
  remote: Member
): LocalUserProfile {
  const overrides = profileOverrides(remote);
  return {
    ...local,
    display_name: overrides.display_name ? remote.display_name : local.display_name,
    avatar_data_url: overrides.avatar ? remote.avatar_data_url ?? "" : local.avatar_data_url,
    avatar_sha256: overrides.avatar ? remote.avatar_sha256 ?? "" : local.avatar_sha256,
    avatar_color: overrides.avatar ? remote.avatar_color ?? "" : local.avatar_color,
    bio: overrides.bio ? remote.bio ?? "" : local.bio,
    updated_at_ms: Math.max(local.updated_at_ms, remote.profile_updated_at_ms)
  };
}

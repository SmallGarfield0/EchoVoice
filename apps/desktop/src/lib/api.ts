import type {
  AccompanimentSession,
  AuditLog,
  Channel,
  ChannelFileEntry,
  ContentAsset,
  CustomEmoji,
  ChannelOrderItem,
  ChannelPermissionOverride,
  ConnectResponse,
  Member,
  MemberMergeCode,
  MemberMergeRequest,
  MemberMergeRequestList,
  MemberMergeResolution,
  LocalUserProfile,
  ProfileOverrides,
  Message,
  RemoteControlSession,
  ScreenShareSession,
  SoundboardItem,
  SoundboardPlayback,
  ServerEvent,
  ServerRole,
  ServerInvite,
  ServerSummary,
  SessionRefreshResponse,
  StoredCredential,
  RTCSignal,
  RTCConfig,
  RoleOrderItem,
  VoiceDurationStats,
  VoiceKickMode,
  VoiceState
} from "./types";
import { sha256Hex } from "./content-cache.ts";
import { clientVersion } from "./version.ts";

export type ContentAssetPurpose = "soundboard" | "emoji";

export type ConnectInput = {
  baseUrl: string;
  password: string;
  profile: LocalUserProfile;
  inviteToken?: string;
  signal?: AbortSignal;
};

export async function connect(input: ConnectInput): Promise<ConnectResponse> {
  const response = await fetch(`${input.baseUrl}/api/v1/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: input.signal,
    body: JSON.stringify({
      server_password: input.password,
      invite_token: input.inviteToken ?? "",
      profile: {
        display_name: input.profile.display_name,
        avatar_sha256: input.profile.avatar_sha256 ?? "",
        avatar_data_url: input.profile.avatar_data_url ?? "",
        avatar_color: input.profile.avatar_color ?? "",
        bio: input.profile.bio,
        local_profile_id: input.profile.local_profile_id,
        profile_updated_at_ms: input.profile.updated_at_ms,
        client_version: clientVersion
      }
    })
  });
  return readJson(response);
}

export async function getServerInvites(baseUrl: string, sessionToken: string): Promise<ServerInvite[]> {
  const payload = await readJson<{ invites: ServerInvite[] }>(
    await fetch(`${baseUrl}/api/v1/invites`, { headers: authHeaders(sessionToken) }),
    sessionToken
  );
  return payload.invites ?? [];
}

export async function createServerInvite(
  baseUrl: string,
  sessionToken: string,
  input: { expires_in_seconds: number; max_uses: number }
): Promise<ServerInvite> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
      body: JSON.stringify(input)
    }),
    sessionToken
  );
}

export async function deleteServerInvite(
  baseUrl: string,
  sessionToken: string,
  inviteId: string
): Promise<ServerInvite> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/invites/${encodeURIComponent(inviteId)}`, {
      method: "DELETE",
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
}

export async function refreshSession(
  credential: StoredCredential,
  deviceId = "",
  signal?: AbortSignal
): Promise<SessionRefreshResponse> {
  const response = await fetch(`${credential.baseUrl}/api/v1/session/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      server_id: credential.server_id,
      member_id: credential.member_id,
      access_key: credential.access_key,
      device_id: deviceId,
      client_version: clientVersion
    })
  });
  return readJson(response);
}

export async function getRTCConfig(baseUrl: string, sessionToken: string, signal?: AbortSignal): Promise<RTCConfig> {
  return readOptionalJson(
    await fetch(`${baseUrl}/api/v1/rtc-config`, { headers: authHeaders(sessionToken), signal }),
    { ice_servers: [] },
    sessionToken
  );
}

export async function getServer(baseUrl: string, signal?: AbortSignal): Promise<ServerSummary> {
  return readJson(await fetch(`${baseUrl}/api/v1/server`, { signal }));
}

export async function updateServer(
  baseUrl: string,
  sessionToken: string,
  input: ServerSummary
): Promise<ServerSummary> {
  const response = await fetch(`${baseUrl}/api/v1/server`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return readJson(response, sessionToken);
}

export async function uploadContentAsset(
  baseUrl: string,
  sessionToken: string,
  purpose: ContentAssetPurpose,
  file: File
): Promise<ContentAsset> {
  const body = new FormData();
  body.set("purpose", purpose);
  body.set("file", file, file.name);
  const response = await fetch(`${baseUrl}/api/v1/assets`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body
  });
  return readJson(response, sessionToken);
}

export async function fetchContentAsset(
  baseUrl: string,
  sessionToken: string,
  sha256: string
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/v1/assets/${encodeURIComponent(sha256)}`, {
    headers: authHeaders(sessionToken)
  });
  if (!response.ok) {
    await readJson(response, sessionToken);
  }
  return response;
}

export async function getSoundboardItems(baseUrl: string, sessionToken: string, signal?: AbortSignal): Promise<SoundboardItem[]> {
  const response = await fetch(`${baseUrl}/api/v1/soundboard`, {
    headers: authHeaders(sessionToken),
    signal
  });
  return (await readOptionalJson<{ items: SoundboardItem[] }>(response, { items: [] }, sessionToken)).items ?? [];
}

export async function uploadServerSoundboardItem(
  baseUrl: string,
  sessionToken: string,
  name: string,
  file: File
): Promise<SoundboardItem> {
  const body = new FormData();
  body.set("name", name);
  body.set("file", file, file.name);
  const response = await fetch(`${baseUrl}/api/v1/soundboard`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body
  });
  return readJson(response, sessionToken);
}

export async function deleteServerSoundboardItem(
  baseUrl: string,
  sessionToken: string,
  itemId: string
): Promise<SoundboardItem> {
  const response = await fetch(`${baseUrl}/api/v1/soundboard/${encodeURIComponent(itemId)}`, {
    method: "DELETE",
    headers: authHeaders(sessionToken)
  });
  return readJson(response, sessionToken);
}

export async function updateServerSoundboardItem(
  baseUrl: string,
  sessionToken: string,
  itemId: string,
  input: Pick<SoundboardItem, "name" | "icon_emoji" | "icon_asset_sha256" | "start_ms" | "end_ms" | "base_volume">
): Promise<SoundboardItem> {
  const response = await fetch(`${baseUrl}/api/v1/soundboard/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return readJson(response, sessionToken);
}

export async function playSoundboardItem(
  baseUrl: string,
  sessionToken: string,
  input: {
    channel_id: string;
    item_id?: string;
    asset_sha256?: string;
    name?: string;
    volume?: number;
    base_volume?: number;
    start_ms?: number;
    end_ms?: number;
  }
): Promise<SoundboardPlayback> {
  const response = await fetch(`${baseUrl}/api/v1/soundboard/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return readJson(response, sessionToken);
}

export async function getCustomEmojis(baseUrl: string, sessionToken: string, signal?: AbortSignal): Promise<CustomEmoji[]> {
  const response = await fetch(`${baseUrl}/api/v1/emojis`, {
    headers: authHeaders(sessionToken),
    signal
  });
  return (await readOptionalJson<{ emojis: CustomEmoji[] }>(response, { emojis: [] }, sessionToken)).emojis ?? [];
}

export async function uploadServerEmoji(
  baseUrl: string,
  sessionToken: string,
  shortcode: string,
  file: File
): Promise<CustomEmoji> {
  const body = new FormData();
  body.set("shortcode", shortcode);
  body.set("file", file, file.name);
  const response = await fetch(`${baseUrl}/api/v1/emojis`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body
  });
  return readJson(response, sessionToken);
}

export async function deleteServerEmoji(
  baseUrl: string,
  sessionToken: string,
  emojiId: string
): Promise<CustomEmoji> {
  const response = await fetch(`${baseUrl}/api/v1/emojis/${encodeURIComponent(emojiId)}`, {
    method: "DELETE",
    headers: authHeaders(sessionToken)
  });
  return readJson(response, sessionToken);
}

export async function updateServerEmoji(
  baseUrl: string,
  sessionToken: string,
  emojiId: string,
  shortcode: string
): Promise<CustomEmoji> {
  const response = await fetch(`${baseUrl}/api/v1/emojis/${encodeURIComponent(emojiId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({ shortcode })
  });
  return readJson(response, sessionToken);
}

export async function getProfile(baseUrl: string, sessionToken: string): Promise<Member> {
  return normalizeMember(
    await readJson<Member>(
      await fetch(`${baseUrl}/api/v1/profile`, { headers: authHeaders(sessionToken) }),
      sessionToken
    )
  );
}

export async function updateProfile(
  baseUrl: string,
  sessionToken: string,
  profile: LocalUserProfile
): Promise<Member> {
  const response = await fetch(`${baseUrl}/api/v1/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({
      scope: "global",
      display_name: profile.display_name,
      avatar_sha256: profile.avatar_sha256 ?? "",
      avatar_data_url: profile.avatar_data_url ?? "",
      avatar_color: profile.avatar_color ?? "",
      bio: profile.bio
    })
  });
  return normalizeMember(await readJson<Member>(response, sessionToken));
}

export async function updateServerProfile(
  baseUrl: string,
  sessionToken: string,
  profile: LocalUserProfile,
  profileOverrides: ProfileOverrides
): Promise<Member> {
  const response = await fetch(`${baseUrl}/api/v1/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({
      scope: "server",
      display_name: profile.display_name,
      avatar_sha256: profile.avatar_sha256 ?? "",
      avatar_data_url: profile.avatar_data_url ?? "",
      avatar_color: profile.avatar_color ?? "",
      bio: profile.bio,
      profile_overrides: profileOverrides
    })
  });
  return normalizeMember(await readJson<Member>(response, sessionToken));
}

export async function generateMemberMergeCode(
  baseUrl: string,
  sessionToken: string
): Promise<MemberMergeCode> {
  const payload = await readJson<MemberMergeCode>(
    await fetch(`${baseUrl}/api/v1/profile/merge-code`, {
      method: "POST",
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
  return { code: String(payload.code ?? ""), expires_at_ms: Number(payload.expires_at_ms ?? 0) };
}

export async function getMemberMergeRequests(
  baseUrl: string,
  sessionToken: string
): Promise<MemberMergeRequestList> {
  const payload = await readJson<MemberMergeRequestList>(
    await fetch(`${baseUrl}/api/v1/profile/merge-requests`, { headers: authHeaders(sessionToken) }),
    sessionToken
  );
  return {
    incoming: asArray(payload.incoming).map(normalizeMemberMergeRequest),
    outgoing: asArray(payload.outgoing).map(normalizeMemberMergeRequest)
  };
}

export async function createMemberMergeRequest(
  baseUrl: string,
  sessionToken: string,
  code: string
): Promise<MemberMergeRequest> {
  const payload = await readJson<MemberMergeRequest>(
    await fetch(`${baseUrl}/api/v1/profile/merge-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
      body: JSON.stringify({ code })
    }),
    sessionToken
  );
  return normalizeMemberMergeRequest(payload);
}

export async function resolveMemberMergeRequest(
  baseUrl: string,
  sessionToken: string,
  requestId: string,
  action: "accept" | "reject"
): Promise<MemberMergeResolution> {
  const payload = await readJson<MemberMergeResolution>(
    await fetch(`${baseUrl}/api/v1/profile/merge-requests/${encodeURIComponent(requestId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
      body: JSON.stringify({ action })
    }),
    sessionToken
  );
  return {
    request: normalizeMemberMergeRequest(payload.request),
    member: payload.member ? normalizeMember(payload.member) : undefined
  };
}

export async function leaveServer(baseUrl: string, sessionToken: string): Promise<Member> {
  return normalizeMember(
    await readJson<Member>(
      await fetch(`${baseUrl}/api/v1/membership`, {
        method: "DELETE",
        headers: authHeaders(sessionToken)
      }),
      sessionToken
    )
  );
}

export async function getAuditLogs(baseUrl: string, sessionToken: string, action = "", limit = 50): Promise<AuditLog[]> {
  const params = new URLSearchParams();
  if (action) params.set("action", action);
  if (limit > 0) params.set("limit", String(limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  let response = await fetch(`${baseUrl}/api/v1/audit-logs${suffix}`, {
    headers: authHeaders(sessionToken)
  });
  if (response.status === 404) {
    response = await fetch(`${baseUrl}/api/v1/audit/logs${suffix}`, {
      headers: authHeaders(sessionToken)
    });
  }
  const payload = await readJson<{ audit_logs: AuditLog[] }>(
    response,
    sessionToken
  );
  return asArray(payload.audit_logs);
}

export async function getChannels(baseUrl: string, sessionToken: string, signal?: AbortSignal): Promise<Channel[]> {
  const payload = await readJson<{ channels: Channel[] }>(
    await fetch(`${baseUrl}/api/v1/channels`, { headers: authHeaders(sessionToken), signal }),
    sessionToken
  );
  return asArray(payload.channels);
}

export async function createChannel(
  baseUrl: string,
  sessionToken: string,
  input: Pick<Channel, "type" | "name"> &
    Partial<Pick<Channel, "parent_id" | "topic" | "visibility" | "warning_text" | "bitrate" | "user_limit" | "default_language" | "localizations">>
): Promise<Channel> {
  const response = await fetch(`${baseUrl}/api/v1/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return readJson(response, sessionToken);
}

export async function updateChannel(
  baseUrl: string,
  sessionToken: string,
  channelId: string,
  input: Partial<
    Pick<
      Channel,
      | "name"
      | "parent_id"
      | "position"
      | "topic"
      | "visibility"
      | "warning_text"
      | "bitrate"
      | "user_limit"
      | "permission_synced"
      | "default_language"
      | "localizations"
    >
  >
): Promise<Channel> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return readJson(response, sessionToken);
}

export async function reorderChannels(
  baseUrl: string,
  sessionToken: string,
  items: ChannelOrderItem[]
): Promise<Channel[]> {
  const payload = await readJson<{ channels: Channel[] }>(
    await fetch(`${baseUrl}/api/v1/channels/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
      body: JSON.stringify({ items })
    }),
    sessionToken
  );
  return asArray(payload.channels);
}

export async function replaceMemberRoles(
  baseUrl: string,
  sessionToken: string,
  memberId: string,
  roleIds: string[]
): Promise<Member> {
  const response = await fetch(`${baseUrl}/api/v1/members/${memberId}/roles`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({ role_ids: roleIds })
  });
  return normalizeMember(await readJson<Member>(response, sessionToken));
}

export async function linkMemberIdentity(
  baseUrl: string,
  sessionToken: string,
  primaryMemberId: string,
  duplicateMemberId: string
): Promise<Member> {
  const response = await fetch(`${baseUrl}/api/v1/members/${primaryMemberId}/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({ duplicate_member_id: duplicateMemberId })
  });
  return normalizeMember(await readJson<Member>(response, sessionToken));
}

export async function updateMember(
  baseUrl: string,
  sessionToken: string,
  memberId: string,
  input: Pick<Member, "is_banned">
): Promise<Member> {
  const response = await fetch(`${baseUrl}/api/v1/members/${memberId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return normalizeMember(await readJson<Member>(response, sessionToken));
}

export async function deleteMember(baseUrl: string, sessionToken: string, memberId: string): Promise<Member> {
  const response = await fetch(`${baseUrl}/api/v1/members/${memberId}`, {
    method: "DELETE",
    headers: authHeaders(sessionToken)
  });
  return normalizeMember(await readJson<Member>(response, sessionToken));
}

export async function deleteChannel(
  baseUrl: string,
  sessionToken: string,
  channelId: string
): Promise<Channel> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}`, {
    method: "DELETE",
    headers: authHeaders(sessionToken)
  });
  return readJson(response, sessionToken);
}

export async function getMembers(baseUrl: string, sessionToken: string, signal?: AbortSignal): Promise<Member[]> {
  const payload = await readJson<{ members: Member[] }>(
    await fetch(`${baseUrl}/api/v1/members`, { headers: authHeaders(sessionToken), signal }),
    sessionToken
  );
  return asArray(payload.members).map(normalizeMember);
}

export async function getMemberVoiceDuration(
  baseUrl: string,
  sessionToken: string,
  memberId: string,
  signal?: AbortSignal
): Promise<VoiceDurationStats> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/members/${encodeURIComponent(memberId)}/voice-duration`, {
      headers: authHeaders(sessionToken),
      signal
    }),
    sessionToken
  );
}

export async function getRoles(baseUrl: string, sessionToken: string, signal?: AbortSignal): Promise<ServerRole[]> {
  const payload = await readJson<{ roles: ServerRole[] }>(
    await fetch(`${baseUrl}/api/v1/roles`, { headers: authHeaders(sessionToken), signal }),
    sessionToken
  );
  return asArray(payload.roles);
}

export async function createRole(
  baseUrl: string,
  sessionToken: string,
  input: Pick<ServerRole, "name" | "color" | "permissions"> &
    Partial<
      Pick<ServerRole, "position" | "gradient_color" | "icon_data_url" | "display_separately">
    >
): Promise<ServerRole> {
  const response = await fetch(`${baseUrl}/api/v1/roles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return readJson(response, sessionToken);
}

export async function updateRole(
  baseUrl: string,
  sessionToken: string,
  roleId: string,
  input: Pick<ServerRole, "name" | "color" | "position" | "permissions"> &
    Partial<Pick<ServerRole, "gradient_color" | "icon_data_url" | "display_separately">>
): Promise<ServerRole> {
  const response = await fetch(`${baseUrl}/api/v1/roles/${roleId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return readJson(response, sessionToken);
}

export async function reorderRoles(
  baseUrl: string,
  sessionToken: string,
  items: RoleOrderItem[]
): Promise<ServerRole[]> {
  const payload = await readJson<{ roles: ServerRole[] }>(
    await fetch(`${baseUrl}/api/v1/roles/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
      body: JSON.stringify({ items })
    }),
    sessionToken
  );
  return asArray(payload.roles);
}

export async function deleteRole(
  baseUrl: string,
  sessionToken: string,
  roleId: string
): Promise<ServerRole> {
  const response = await fetch(`${baseUrl}/api/v1/roles/${roleId}`, {
    method: "DELETE",
    headers: authHeaders(sessionToken)
  });
  return readJson(response, sessionToken);
}

export async function getChannelPermissionOverrides(
  baseUrl: string,
  sessionToken: string,
  channelId: string
): Promise<ChannelPermissionOverride[]> {
  const payload = await readJson<{ permission_overrides: ChannelPermissionOverride[] }>(
    await fetch(`${baseUrl}/api/v1/channels/${channelId}/permission-overrides`, {
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
  return asArray(payload.permission_overrides);
}

export async function getChannelAccessibleMemberIDs(
  baseUrl: string,
  sessionToken: string,
  channelId: string
): Promise<string[]> {
  const payload = await readJson<{ member_ids: string[] }>(
    await fetch(`${baseUrl}/api/v1/channels/${channelId}/accessible-members`, {
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
  return asArray(payload.member_ids);
}

export async function setChannelPermissionOverride(
  baseUrl: string,
  sessionToken: string,
  channelId: string,
  input: Pick<ChannelPermissionOverride, "target_type" | "target_id" | "allows" | "denies"> &
    Partial<Pick<ChannelPermissionOverride, "override_id">>
): Promise<ChannelPermissionOverride> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/permission-overrides`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return readJson(response, sessionToken);
}

export async function deleteChannelPermissionOverride(
  baseUrl: string,
  sessionToken: string,
  channelId: string,
  overrideId: string
): Promise<ChannelPermissionOverride> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/permission-overrides/${overrideId}`, {
    method: "DELETE",
    headers: authHeaders(sessionToken)
  });
  return readJson(response, sessionToken);
}

export async function getMessages(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  beforeMS = 0,
  limit = 50
): Promise<Message[]> {
  const params = new URLSearchParams();
  if (beforeMS > 0) params.set("before_ms", String(beforeMS));
  if (limit > 0) params.set("limit", String(limit));
  const payload = await readJson<{ messages: Message[] }>(
    await fetch(`${baseUrl}/api/v1/channels/${channelId}/messages?${params.toString()}`, {
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
  return asArray(payload.messages);
}

export async function getMessage(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  messageId: string
): Promise<Message> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/channels/${channelId}/messages/${messageId}`, {
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
}

export async function getMessageContext(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  messageId: string,
  before = 25,
  after = 25
): Promise<Message[]> {
  const params = new URLSearchParams();
  params.set("before", String(before));
  params.set("after", String(after));
  const payload = await readJson<{ messages: Message[] }>(
    await fetch(`${baseUrl}/api/v1/channels/${channelId}/messages/${messageId}/context?${params.toString()}`, {
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
  return asArray(payload.messages);
}

export async function searchMessages(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  query: string,
  limit = 25
): Promise<Message[]> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", String(limit));
  const payload = await readJson<{ messages: Message[] }>(
    await fetch(`${baseUrl}/api/v1/channels/${channelId}/messages?${params.toString()}`, {
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
  return asArray(payload.messages);
}

export async function getChannelFiles(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  parentId = ""
): Promise<ChannelFileEntry[]> {
  const params = new URLSearchParams();
  if (parentId) params.set("parent_id", parentId);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const payload = await readJson<{ entries: ChannelFileEntry[] }>(
    await fetch(`${baseUrl}/api/v1/channels/${channelId}/files${suffix}`, {
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
  return asArray(payload.entries);
}

export async function getChannelFileEntry(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  entryId: string
): Promise<ChannelFileEntry> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/channels/${channelId}/files/${entryId}?metadata=1`, {
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
}

export async function createChannelDirectory(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  name: string,
  parentId = ""
): Promise<ChannelFileEntry> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({ type: "directory", name, parent_id: parentId })
  });
  return readJson(response, sessionToken);
}

export async function uploadChannelFile(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  file: File,
  parentId = "",
  onProgress?: (percent: number) => void
): Promise<ChannelFileEntry> {
  const assetSHA256 = await sha256Hex(file);
  try {
    return await linkCachedChannelFile(baseUrl, channelId, sessionToken, file, assetSHA256, parentId);
  } catch (error) {
    if ((error as Error & { code?: string }).code !== "EV_FILE_ASSET_NOT_FOUND") throw error;
  }
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append("file", file);
    if (parentId) body.append("parent_id", parentId);
    body.append("expected_sha256", assetSHA256);

    const request = new XMLHttpRequest();
    request.open("POST", `${baseUrl}/api/v1/channels/${channelId}/files`);
    request.setRequestHeader("Authorization", `Bearer ${sessionToken}`);
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      const response = new Response(request.responseText, {
        status: request.status,
        statusText: request.statusText,
        headers: { "Content-Type": request.getResponseHeader("Content-Type") ?? "application/json" }
      });
      readJson<ChannelFileEntry>(response, sessionToken).then(resolve, reject);
    };
    request.onerror = () => reject(new Error("Upload failed"));
    request.onabort = () => reject(new Error("Upload aborted"));
    request.send(body);
  });
}

export async function linkCachedChannelFile(
	baseUrl: string,
	channelId: string,
	sessionToken: string,
	file: Pick<File, "name" | "size">,
	assetSHA256: string,
	parentId = ""
): Promise<ChannelFileEntry> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/channels/${channelId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
      body: JSON.stringify({
        type: "file",
        name: file.name,
        parent_id: parentId,
        asset_sha256: assetSHA256,
        size_bytes: file.size
      })
    }),
    sessionToken
  );
}

export async function updateChannelFileEntry(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  entryId: string,
  input: { name: string; parent_id?: string }
): Promise<ChannelFileEntry> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/files/${entryId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return readJson(response, sessionToken);
}

export async function deleteChannelFileEntry(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  entryId: string
): Promise<ChannelFileEntry> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/files/${entryId}`, {
    method: "DELETE",
    headers: authHeaders(sessionToken)
  });
  return readJson(response, sessionToken);
}

export async function downloadChannelFile(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  entry: ChannelFileEntry
): Promise<void> {
  const blob = await fetchChannelFileBlob(baseUrl, channelId, sessionToken, entry.entry_id);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = entry.name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

export async function fetchChannelFileBlob(
	baseUrl: string,
	channelId: string,
	sessionToken: string,
	entryId: string
): Promise<Blob> {
  const response = await fetch(
    `${baseUrl}/api/v1/channels/${channelId}/files/${entryId}?disposition=inline`,
    { headers: authHeaders(sessionToken) }
  );
  if (!response.ok) await readJson(response, sessionToken);
  return response.blob();
}

export function uploadMessageImage(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<ContentAsset> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append("file", file);
    const request = new XMLHttpRequest();
    request.open("POST", `${baseUrl}/api/v1/channels/${channelId}/message-images`);
    request.setRequestHeader("Authorization", `Bearer ${sessionToken}`);
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      const response = new Response(request.responseText, {
        status: request.status,
        statusText: request.statusText,
        headers: { "Content-Type": request.getResponseHeader("Content-Type") ?? "application/json" }
      });
      readJson<ContentAsset>(response, sessionToken).then(resolve, reject);
    };
    request.onerror = () => reject(new Error("Message image upload failed"));
    request.onabort = () => reject(new Error("Message image upload aborted"));
    request.send(body);
  });
}

export async function fetchMessageImageBlob(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  assetSHA256: string
): Promise<Blob> {
  const response = await fetch(
    `${baseUrl}/api/v1/channels/${channelId}/message-images/${assetSHA256}`,
    { headers: authHeaders(sessionToken) }
  );
  if (!response.ok) await readJson(response, sessionToken);
  return response.blob();
}

export async function getVoiceStates(baseUrl: string, sessionToken: string, signal?: AbortSignal): Promise<VoiceState[]> {
  const payload = await readJson<{ voice_states: VoiceState[] }>(
    await fetch(`${baseUrl}/api/v1/voice-states`, { headers: authHeaders(sessionToken), signal }),
    sessionToken
  );
  return asArray(payload.voice_states).map(normalizeVoiceState);
}

export async function joinVoiceChannel(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  options: { mode?: "primary" | "listener"; takeover?: boolean; signal?: AbortSignal } = {}
): Promise<VoiceState> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/voice-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({ mode: options.mode ?? "primary", takeover: Boolean(options.takeover) }),
    signal: options.signal
  });
  return normalizeVoiceState(await readJson<VoiceState>(response, sessionToken));
}

export async function updateVoiceState(
  baseUrl: string,
  sessionToken: string,
  input: Pick<VoiceState, "mic_muted" | "audio_deafened" | "is_speaking">
): Promise<VoiceState> {
  const response = await fetch(`${baseUrl}/api/v1/voice-state`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return normalizeVoiceState(await readJson<VoiceState>(response, sessionToken));
}

export async function manageVoiceState(
  baseUrl: string,
  sessionToken: string,
  participantId: string,
  input: Partial<Pick<VoiceState, "channel_id" | "server_muted" | "server_deafened">>
): Promise<VoiceState> {
  const response = await fetch(`${baseUrl}/api/v1/voice-states/${participantId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify(input)
  });
  return normalizeVoiceState(await readJson<VoiceState>(response, sessionToken));
}

export async function kickVoiceState(
  baseUrl: string,
  sessionToken: string,
  participantId: string,
  mode: VoiceKickMode = "notify"
): Promise<VoiceState> {
  const query = mode === "silent" ? "?mode=silent" : "";
  return normalizeVoiceState(await readJson<VoiceState>(
    await fetch(`${baseUrl}/api/v1/voice-states/${participantId}${query}`, {
      method: "DELETE",
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  ));
}

export async function leaveVoiceChannel(
  baseUrl: string,
  sessionToken: string,
  signal?: AbortSignal
): Promise<VoiceState> {
  const response = await fetch(`${baseUrl}/api/v1/voice-state`, {
    method: "DELETE",
    headers: authHeaders(sessionToken),
    signal
  });
  return normalizeVoiceState(await readJson<VoiceState>(response, sessionToken));
}

export async function getScreenShareSessions(baseUrl: string, sessionToken: string, signal?: AbortSignal): Promise<ScreenShareSession[]> {
  const payload = await readOptionalJson<{ screen_shares: ScreenShareSession[] }>(
    await fetch(`${baseUrl}/api/v1/screen-shares`, { headers: authHeaders(sessionToken), signal }),
    { screen_shares: [] },
    sessionToken
  );
  return asArray(payload.screen_shares);
}

export async function getAccompanimentSessions(baseUrl: string, sessionToken: string, signal?: AbortSignal): Promise<AccompanimentSession[]> {
  const payload = await readOptionalJson<{ accompaniments: AccompanimentSession[] }>(
    await fetch(`${baseUrl}/api/v1/accompaniments`, { headers: authHeaders(sessionToken), signal }),
    { accompaniments: [] },
    sessionToken
  );
  return asArray(payload.accompaniments);
}

export async function startAccompanimentSession(
  baseUrl: string,
  sessionToken: string,
  channelId: string,
  sourceName: string
): Promise<AccompanimentSession> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/channels/${channelId}/accompaniment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
      body: JSON.stringify({ source_name: sourceName })
    }),
    sessionToken
  );
}

export async function endAccompanimentSession(
  baseUrl: string,
  sessionToken: string,
  accompanimentSessionId: string
): Promise<AccompanimentSession> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/accompaniments/${accompanimentSessionId}`, {
      method: "DELETE",
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
}

export async function startScreenShareSession(
  baseUrl: string,
  sessionToken: string,
  channelId: string,
  remoteControlAllowed: boolean
): Promise<ScreenShareSession> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/screen-share`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({ remote_control_allowed: remoteControlAllowed })
  });
  return readJson(response, sessionToken);
}

export async function endScreenShareSession(
  baseUrl: string,
  sessionToken: string,
  shareId: string,
  signal?: AbortSignal
): Promise<ScreenShareSession> {
  const response = await fetch(`${baseUrl}/api/v1/screen-shares/${shareId}`, {
    method: "DELETE",
    headers: authHeaders(sessionToken),
    signal
  });
  return readJson(response, sessionToken);
}

export async function setScreenShareViewer(
  baseUrl: string,
  sessionToken: string,
  shareId: string,
  watching: boolean,
  watchSessionId = "",
  signal?: AbortSignal
): Promise<ScreenShareSession> {
  const response = await fetch(`${baseUrl}/api/v1/screen-shares/${shareId}/viewer`, {
    method: watching ? "POST" : "DELETE",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({ watch_session_id: watchSessionId }),
    signal
  });
  return readJson(response, sessionToken);
}

export async function sendScreenShareSignal(
  baseUrl: string,
  sessionToken: string,
  shareId: string,
  targetMemberId: string,
  signalType: Extract<
    RTCSignal["signal_type"],
    "screen-share-offer" | "screen-share-answer" | "screen-share-ice-candidate"
  >,
  data: unknown,
  targetParticipantId = ""
): Promise<{ delivered: boolean; queued?: boolean }> {
  const response = await screenShareSignalFetch(`${baseUrl}/api/v1/screen-shares/${shareId}/signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({
      target_member_id: targetMemberId,
      target_participant_id: targetParticipantId,
      signal_type: signalType,
      data
    })
  });
  return readJson(response, sessionToken);
}

export async function drainScreenShareSignals(
  baseUrl: string,
  sessionToken: string,
  shareId: string,
  watchSessionId = "",
  signal?: AbortSignal
): Promise<RTCSignal[]> {
  const query = watchSessionId ? `?watch_session_id=${encodeURIComponent(watchSessionId)}` : "";
  const payload = await readJson<{ signals: RTCSignal[] }>(
    await screenShareSignalFetch(`${baseUrl}/api/v1/screen-shares/${shareId}/signals${query}`, {
      headers: authHeaders(sessionToken),
      cache: "no-store",
      signal
    }),
    sessionToken
  );
  return asArray(payload.signals);
}

export async function getRemoteControlSessions(
  baseUrl: string,
  sessionToken: string,
  signal?: AbortSignal
): Promise<RemoteControlSession[]> {
  const payload = await readOptionalJson<{ remote_controls: RemoteControlSession[] }>(
    await fetch(`${baseUrl}/api/v1/remote-controls`, { headers: authHeaders(sessionToken), signal }),
    { remote_controls: [] },
    sessionToken
  );
  return asArray(payload.remote_controls);
}

export async function requestRemoteControl(
  baseUrl: string,
  sessionToken: string,
  shareId: string,
  signal?: AbortSignal
): Promise<RemoteControlSession> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/screen-shares/${shareId}/control-requests`, {
      method: "POST",
      headers: authHeaders(sessionToken),
      signal
    }),
    sessionToken
  );
}

export async function updateRemoteControl(
  baseUrl: string,
  sessionToken: string,
  controlId: string,
  action: "approve" | "reject" | "revoke"
): Promise<RemoteControlSession> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/remote-controls/${controlId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
      body: JSON.stringify({ action })
    }),
    sessionToken
  );
}

export async function suspendRemoteControl(
  baseUrl: string,
  sessionToken: string,
  controlId: string
): Promise<RemoteControlSession> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/remote-controls/${controlId}/respect`, {
      method: "POST",
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
}

export async function heartbeatRemoteControl(
  baseUrl: string,
  sessionToken: string,
  controlId: string
): Promise<RemoteControlSession> {
  return readJson(
    await fetch(`${baseUrl}/api/v1/remote-controls/${controlId}/heartbeat`, {
      method: "POST",
      headers: authHeaders(sessionToken)
    }),
    sessionToken
  );
}

async function screenShareSignalFetch(input: RequestInfo | URL, init: RequestInit, timeoutMS = 4000) {
  const controller = new AbortController();
  const externalSignal = init.signal;
  let externallyAborted = false;
  const abortFromExternalSignal = () => {
    externallyAborted = true;
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  }
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (caught) {
    if (controller.signal.aborted) {
      if (externallyAborted || externalSignal?.aborted) {
        throw externalSignal?.reason instanceof Error
          ? externalSignal.reason
          : new DOMException("Screen share signaling request aborted", "AbortError");
      }
      throw new Error(`Screen share signaling request timed out after ${timeoutMS} ms`);
    }
    throw caught;
  } finally {
    globalThis.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

export async function sendMessage(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  content: string,
  replyToMessageId = ""
): Promise<Message> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({ content, reply_to_message_id: replyToMessageId })
  });
  return readJson(response, sessionToken);
}

export async function updateMessage(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  messageId: string,
  content: string
): Promise<Message> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(sessionToken) },
    body: JSON.stringify({ content })
  });
  return readJson(response, sessionToken);
}

export async function deleteMessage(
  baseUrl: string,
  channelId: string,
  sessionToken: string,
  messageId: string
): Promise<Message> {
  const response = await fetch(`${baseUrl}/api/v1/channels/${channelId}/messages/${messageId}`, {
    method: "DELETE",
    headers: authHeaders(sessionToken)
  });
  return readJson(response, sessionToken);
}

export function openEventSocket(baseUrl: string, sessionToken: string): WebSocket {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/events";
  url.search = `?session_token=${encodeURIComponent(sessionToken)}`;
  url.hash = "";
  return new WebSocket(url);
}

export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const event = JSON.parse(raw) as ServerEvent;
    if (!event || typeof event.type !== "string") return null;
    return event;
  } catch {
    return null;
  }
}

function authHeaders(sessionToken: string): Record<string, string> {
  return { Authorization: `Bearer ${sessionToken}` };
}

async function readJson<T>(response: Response, requestSessionToken = ""): Promise<T> {
  const raw = await response.text();
  let payload: any = null;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      if (!response.ok) {
        throw new Error(raw.trim() || `HTTP ${response.status}`);
      }
      throw new Error(`Invalid JSON response from ${response.url}`);
    }
  }
  if (!response.ok) {
    const error = new Error(payload?.message || raw.trim() || `HTTP ${response.status}`) as Error & {
      status?: number;
      code?: string;
    };
    error.status = response.status;
    error.code = payload?.code;
    if (
      error.code === "EV_AUTH_SESSION_INVALID" &&
      requestSessionToken &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new CustomEvent("echovoice:session-invalid", {
        detail: { message: error.message, sessionToken: requestSessionToken }
      }));
    }
    throw error;
  }
  return payload as T;
}

async function readOptionalJson<T>(response: Response, fallback: T, requestSessionToken = ""): Promise<T> {
  if (response.status === 404 || response.status === 405) return fallback;
  return readJson<T>(response, requestSessionToken);
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function normalizeMember(member: Member): Member {
  return {
    ...member,
    avatar_color: String(member.avatar_color ?? ""),
    profile_overrides: {
      display_name: Boolean(member.profile_overrides?.display_name),
      avatar: Boolean(member.profile_overrides?.avatar),
      bio: Boolean(member.profile_overrides?.bio)
    },
    role_ids: asArray(member.role_ids),
    online: Boolean(member.online),
    linked_devices: Number(member.linked_devices ?? 0),
    profile_updated_at_ms: Number(member.profile_updated_at_ms ?? 0)
  };
}

export function normalizeMemberMergeRequest(request: MemberMergeRequest): MemberMergeRequest {
  return {
    ...request,
    request_id: String(request?.request_id ?? ""),
    target_member_id: String(request?.target_member_id ?? ""),
    requester_member_id: String(request?.requester_member_id ?? ""),
    status: request?.status ?? "pending",
    created_at_ms: Number(request?.created_at_ms ?? 0),
    expires_at_ms: Number(request?.expires_at_ms ?? 0),
    resolved_at_ms: Number(request?.resolved_at_ms ?? 0),
    requester: normalizeMember(request.requester),
    target: normalizeMember(request.target)
  };
}

export function normalizeVoiceState(state: VoiceState): VoiceState {
  const memberId = String(state?.member_id ?? "");
  return {
    ...state,
    participant_id: String(state?.participant_id ?? memberId),
    channel_id: String(state?.channel_id ?? ""),
    member_id: memberId,
    device_id: String(state?.device_id ?? ""),
    mode: state?.mode === "listener" ? "listener" : "primary",
    joined_at_ms: Number(state?.joined_at_ms ?? 0),
    mic_muted: Boolean(state?.mic_muted),
    audio_deafened: Boolean(state?.audio_deafened),
    server_muted: Boolean(state?.server_muted),
    server_deafened: Boolean(state?.server_deafened),
    is_speaking: Boolean(state?.is_speaking)
  };
}

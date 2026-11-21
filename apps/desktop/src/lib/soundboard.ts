import { normalizeSHA256 } from "./content-cache.ts";

const localSoundboardStorageKey = "ev.soundboard.local.v1";
export const soundboardPlaybackVolumeStorageKey = "ev.soundboard.playbackVolumePercent";
export const soundboardListeningVolumeStorageKey = "ev.soundboard.listeningVolumePercent";
export const soundboardVolumeMinimumPercent = 5;
export const soundboardVolumeMaximumPercent = 200;

export function clampSoundboardVolumePercent(value: number, allowMuted = false): number {
  if (!Number.isFinite(value)) return 100;
  const minimum = allowMuted ? 0 : soundboardVolumeMinimumPercent;
  return Math.min(soundboardVolumeMaximumPercent, Math.max(minimum, Math.round(value)));
}

export function loadSoundboardVolumePercent(
  key: string,
  allowMuted = false,
  storage: Pick<Storage, "getItem"> = localStorage
): number {
  return clampSoundboardVolumePercent(Number(storage.getItem(key) ?? 100), allowMuted);
}

export function formatSoundboardPosition(milliseconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(milliseconds) ? milliseconds : 0));
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const fraction = safe % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}${fraction ? `.${String(fraction).padStart(3, "0").replace(/0+$/, "")}` : ""}`;
}

export function parseSoundboardPosition(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return 0;
  const match = /^(?:(\d{1,4}):)?([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(normalized);
  if (!match) return null;
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2]);
  const milliseconds = Number((match[3] ?? "").padEnd(3, "0") || 0);
  const result = minutes * 60_000 + seconds * 1000 + milliseconds;
  return result <= 86_400_000 ? result : null;
}

export type LocalSoundboardItem = {
  local_id: string;
  name: string;
  asset_sha256: string;
  size_bytes: number;
  mime_type: string;
  icon_emoji?: string;
  icon_asset_sha256?: string;
  icon_size_bytes?: number;
  icon_mime_type?: string;
  start_ms: number;
  end_ms: number;
  base_volume: number;
  created_at_ms: number;
};

export function loadLocalSoundboardItems(storage: Pick<Storage, "getItem"> = localStorage): LocalSoundboardItem[] {
  try {
    const parsed = JSON.parse(storage.getItem(localSoundboardStorageKey) ?? "[]") as LocalSoundboardItem[];
    return parsed
      .filter((item) => Boolean(item?.local_id && item.name.trim() && normalizeSHA256(item.asset_sha256)))
      .map((item) => ({
        ...item,
        icon_emoji: item.icon_emoji ?? "",
        icon_asset_sha256: normalizeSHA256(item.icon_asset_sha256 ?? ""),
        icon_size_bytes: Number.isSafeInteger(item.icon_size_bytes) ? item.icon_size_bytes : 0,
        icon_mime_type: item.icon_mime_type ?? "",
        start_ms: Number.isSafeInteger(item.start_ms) && item.start_ms >= 0 ? item.start_ms : 0,
        end_ms: Number.isSafeInteger(item.end_ms) && item.end_ms > 0 ? item.end_ms : 0,
        base_volume: Number.isFinite(item.base_volume)
          ? clampSoundboardVolumePercent(item.base_volume * 100) / 100
          : 1
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export function saveLocalSoundboardItems(
  items: LocalSoundboardItem[],
  storage: Pick<Storage, "setItem"> = localStorage
) {
  storage.setItem(localSoundboardStorageKey, JSON.stringify(items));
}

export function createLocalSoundboardItem(file: File, assetSHA256: string): LocalSoundboardItem {
  const name = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
  return {
    local_id: `local-${crypto.randomUUID()}`,
    name: name.slice(0, 48),
    asset_sha256: normalizeSHA256(assetSHA256),
    size_bytes: file.size,
    mime_type: file.type || "application/octet-stream",
    icon_emoji: "",
    icon_asset_sha256: "",
    icon_size_bytes: 0,
    icon_mime_type: "",
    start_ms: 0,
    end_ms: 0,
    base_volume: 1,
    created_at_ms: Date.now()
  };
}

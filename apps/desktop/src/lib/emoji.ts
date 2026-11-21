import { normalizeSHA256 } from "./content-cache.ts";
import {
  defaultEmojiCategories,
  defaultEmojis as unicodeDefaultEmojis,
  type DefaultEmoji as UnicodeDefaultEmoji
} from "./default-emoji-catalog.ts";
import { prideFlagEmojis } from "./pride-flag-emojis.ts";

export {
  defaultEmojiCategories,
  unicodeEmojiVersion,
  type DefaultEmojiCategory
} from "./default-emoji-catalog.ts";

export type DefaultEmoji = UnicodeDefaultEmoji & { imageURL?: string };

const featuredFlagValues = [
  "🏁", "🚩", "🎌", "🏳️", "🏴", "🏴‍☠️",
  "🇨🇳", "🇺🇸", "🇬🇧", "🇯🇵", "🇰🇷", "🇸🇬", "🇨🇦", "🇦🇺", "🇫🇷", "🇩🇪", "🇮🇳", "🇧🇷"
];
const unicodePrideFlagValues = ["🏳️‍🌈", "🏳️‍⚧️"];

function takeEmojiValues(items: DefaultEmoji[], values: string[]) {
  const byValue = new Map(items.map((emoji) => [emoji.value, emoji]));
  return values.map((value) => byValue.get(value)).filter((emoji): emoji is DefaultEmoji => Boolean(emoji));
}

function orderedDefaultEmojis(): DefaultEmoji[] {
  const unicodeFlags = unicodeDefaultEmojis.filter((emoji) => emoji.category === "flags");
  const featuredFlags = takeEmojiValues(unicodeFlags, featuredFlagValues);
  const unicodePrideFlags = takeEmojiValues(unicodeFlags, unicodePrideFlagValues);
  const prioritizedValues = new Set([...featuredFlagValues, ...unicodePrideFlagValues]);
  const remainingFlags = unicodeFlags.filter((emoji) => !prioritizedValues.has(emoji.value));
  return [
    ...unicodeDefaultEmojis.filter((emoji) => emoji.category !== "flags"),
    ...featuredFlags,
    unicodePrideFlags[0],
    prideFlagEmojis[0],
    unicodePrideFlags[1],
    ...prideFlagEmojis.slice(1),
    ...remainingFlags
  ].filter((emoji): emoji is DefaultEmoji => Boolean(emoji));
}

export const defaultEmojis = orderedDefaultEmojis();

const localEmojiStorageKey = "ev.emoji.packs.v1";
const recentEmojiStorageKey = "ev.emoji.recent.v1";
const maximumRecentEmojiCount = 32;
const emojiTokenSource = String.raw`<:ev:([A-Za-z0-9_]{1,32}):([a-fA-F0-9]{64}):([0-9]{1,10}):(png|gif|webp|jpg)>`;
const completeEmojiTokenSource = String.raw`<:ev:[A-Za-z0-9_]{1,32}:[a-fA-F0-9]{64}:[0-9]{1,10}:(?:png|gif|webp|jpg)>`;
const builtInEmojiTokenSource = String.raw`<:evb:([a-z0-9_]{1,12})>`;
const completeBuiltInEmojiTokenSource = String.raw`<:evb:[a-z0-9_]{1,12}>`;
export const customEmojiIDPattern = /^[a-z0-9_]{1,12}$/;

const defaultEmojiByID = new Map(defaultEmojis.map((emoji) => [emoji.id, emoji]));

export type EmojiReference = {
  token: string;
  shortcode: string;
  asset_sha256: string;
  size_bytes: number;
  mime_type: string;
  start: number;
  end: number;
};

export type LocalEmojiItem = {
  local_id: string;
  shortcode: string;
  asset_sha256: string;
  size_bytes: number;
  mime_type: string;
  created_at_ms: number;
};

export type LocalEmojiPack = {
  pack_id: string;
  name: string;
  emojis: LocalEmojiItem[];
  created_at_ms: number;
  updated_at_ms: number;
};

export type CustomEmojiMetadata = {
  shortcode: string;
  asset_sha256: string;
  size_bytes: number;
  mime_type: string;
};

export type EmojiAliasResolution =
  | { kind: "custom"; emoji: CustomEmojiMetadata }
  | { kind: "default"; emoji: DefaultEmoji };

export function isValidEmojiID(value: string): boolean {
  return customEmojiIDPattern.test(value);
}

export function normalizeEmojiShortcode(value: string): string {
  return value
    .trim()
    .replace(/^:+|:+$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 12);
}

export function normalizeCustomEmojiMetadataList<T extends CustomEmojiMetadata>(items: readonly T[]): T[] {
  const candidates = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => Boolean(
      normalizeSHA256(item.asset_sha256) &&
      Number.isSafeInteger(item.size_bytes) &&
      item.size_bytes > 0 &&
      emojiTokenFormatForMIME(item.mime_type)
    ))
    .sort((left, right) => (
      Number(isValidEmojiID(right.item.shortcode)) - Number(isValidEmojiID(left.item.shortcode)) ||
      left.index - right.index
    ));
  const used = new Set<string>();
  const normalized = new Map<number, T>();
  for (const { item, index } of candidates) {
    const base = normalizeEmojiShortcode(item.shortcode) || "emoji";
    let shortcode = base;
    for (let suffix = 2; used.has(shortcode); suffix += 1) {
      const suffixText = `_${suffix}`;
      const prefix = base.slice(0, 12 - suffixText.length).replace(/_+$/g, "") || "e";
      shortcode = `${prefix}${suffixText}`;
    }
    used.add(shortcode);
    normalized.set(index, {
      ...item,
      shortcode,
      asset_sha256: normalizeSHA256(item.asset_sha256),
      mime_type: emojiMIMEFromToken(emojiTokenFormatForMIME(item.mime_type))
    });
  }
  return [...normalized.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item);
}

export function emojiAlias(id: string): string {
  return `:${id}:`;
}

export function emojiSearchScore(id: string, keywords: string[], rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase().replace(/^:+|:+$/g, "");
  if (!query) return 1;
  const normalizedID = id.toLowerCase();
  if (normalizedID === query) return 100;
  if (normalizedID.startsWith(query)) return 80 - Math.min(20, normalizedID.length - query.length);
  if (normalizedID.includes(query)) return 55 - Math.min(20, normalizedID.indexOf(query));
  const normalizedKeywords = keywords.map((keyword) => keyword.toLowerCase());
  if (normalizedKeywords.some((keyword) => keyword === query)) return 45;
  if (normalizedKeywords.some((keyword) => keyword.startsWith(query))) return 35;
  if (normalizedKeywords.some((keyword) => keyword.includes(query))) return 20;
  return 0;
}

export function findEmojiShortcodeQuery(content: string, cursor: number): EmojiShortcodeQuery | null {
  const safeCursor = Math.max(0, Math.min(content.length, cursor));
  const before = content.slice(0, safeCursor);
  const start = before.lastIndexOf(":");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  if (!/^[a-z0-9_]{0,12}$/i.test(query)) return null;
  const end = content[safeCursor] === ":" ? safeCursor + 1 : safeCursor;
  return { query: query.toLowerCase(), start, end };
}

export function loadRecentEmojiKeys(storage: Pick<Storage, "getItem"> = localStorage): string[] {
  try {
    const values = JSON.parse(storage.getItem(recentEmojiStorageKey) ?? "[]") as unknown;
    if (!Array.isArray(values)) return [];
    return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length <= 180))]
      .slice(0, maximumRecentEmojiCount);
  } catch {
    return [];
  }
}

export function recordRecentEmojiKey(
  key: string,
  current: string[],
  storage: Pick<Storage, "setItem"> = localStorage
): string[] {
  const normalized = key.trim().slice(0, 180);
  if (!normalized) return current;
  const next = [normalized, ...current.filter((value) => value !== normalized)].slice(0, maximumRecentEmojiCount);
  storage.setItem(recentEmojiStorageKey, JSON.stringify(next));
  return next;
}

export function getDefaultEmoji(id: string): DefaultEmoji | undefined {
  return defaultEmojiByID.get(id);
}

export function getBuiltInGraphicEmoji(token: string): DefaultEmoji | undefined {
  const match = token.match(new RegExp(`^${builtInEmojiTokenSource}$`));
  if (!match) return undefined;
  const emoji = getDefaultEmoji(match[1]);
  return emoji?.imageURL && emoji.value === token ? emoji : undefined;
}

export function resolveEmojiAlias(
  id: string,
  customEmojis: CustomEmojiMetadata[] = []
): EmojiAliasResolution | undefined {
  if (!isValidEmojiID(id)) return undefined;
  const custom = customEmojis.find((emoji) => emoji.shortcode === id);
  if (custom) return { kind: "custom", emoji: custom };
  const fallback = getDefaultEmoji(id);
  return fallback ? { kind: "default", emoji: fallback } : undefined;
}

export function materializeEmojiAliases(
  content: string,
  customEmojis: CustomEmojiMetadata[] = []
): string {
  const pattern = new RegExp(`${completeEmojiTokenSource}|${completeBuiltInEmojiTokenSource}|:([a-z0-9_]{1,12}):`, "g");
  return content.replace(pattern, (token, id: string | undefined) => {
    if (token.startsWith("<:ev:") || token.startsWith("<:evb:")) return token;
    const resolution = id ? resolveEmojiAlias(id, customEmojis) : undefined;
    if (!resolution) return token;
    return resolution.kind === "custom" ? createEmojiToken(resolution.emoji) : resolution.emoji.value;
  });
}

export function emojiTokenFormatForMIME(mimeType: string): "png" | "gif" | "webp" | "jpg" | "" {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/jpeg":
      return "jpg";
    default:
      return "";
  }
}

export function emojiMIMEFromToken(format: string): string {
  switch (format) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "jpg":
      return "image/jpeg";
    default:
      return "";
  }
}

export function createEmojiToken(input: {
  shortcode: string;
  asset_sha256: string;
  size_bytes: number;
  mime_type: string;
}): string {
  const shortcode = normalizeEmojiShortcode(input.shortcode);
  const sha = normalizeSHA256(input.asset_sha256);
  const format = emojiTokenFormatForMIME(input.mime_type);
  if (!isValidEmojiID(shortcode) || !sha || !format || !Number.isSafeInteger(input.size_bytes) || input.size_bytes < 1) {
    throw new Error("Invalid custom emoji metadata");
  }
  return `<:ev:${shortcode}:${sha}:${input.size_bytes}:${format}>`;
}

export function parseEmojiReferences(content: string): EmojiReference[] {
  const pattern = new RegExp(emojiTokenSource, "g");
  const references: EmojiReference[] = [];
  for (const match of content.matchAll(pattern)) {
    const sizeBytes = Number.parseInt(match[3], 10);
    const mimeType = emojiMIMEFromToken(match[4]);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || !mimeType || match.index === undefined) continue;
    references.push({
      token: match[0],
      shortcode: match[1],
      asset_sha256: normalizeSHA256(match[2]),
      size_bytes: sizeBytes,
      mime_type: mimeType,
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return references;
}

export function loadLocalEmojiPacks(storage: Pick<Storage, "getItem"> = localStorage): LocalEmojiPack[] {
  try {
    const parsed = JSON.parse(storage.getItem(localEmojiStorageKey) ?? "[]") as LocalEmojiPack[];
    return parsed
      .filter((pack) => Boolean(pack?.pack_id && pack.name.trim() && Array.isArray(pack.emojis)))
      .map((pack) => ({
        ...pack,
        emojis: pack.emojis
          .map((emoji) => ({ ...emoji, shortcode: normalizeEmojiShortcode(emoji.shortcode) }))
          .filter((emoji) => Boolean(
            emoji?.local_id &&
            isValidEmojiID(emoji.shortcode) &&
            normalizeSHA256(emoji.asset_sha256) &&
            emojiTokenFormatForMIME(emoji.mime_type)
          ))
      }))
      .sort((left, right) => left.created_at_ms - right.created_at_ms);
  } catch {
    return [];
  }
}

export function saveLocalEmojiPacks(
  packs: LocalEmojiPack[],
  storage: Pick<Storage, "setItem"> = localStorage
) {
  storage.setItem(localEmojiStorageKey, JSON.stringify(packs));
}

export function createLocalEmojiPack(name: string): LocalEmojiPack {
  const now = Date.now();
  return {
    pack_id: `pack-${crypto.randomUUID()}`,
    name: name.trim().slice(0, 48),
    emojis: [],
    created_at_ms: now,
    updated_at_ms: now
  };
}

export function createLocalEmojiItem(
  input: Pick<LocalEmojiItem, "shortcode" | "asset_sha256" | "size_bytes" | "mime_type">
): LocalEmojiItem {
  const shortcode = normalizeEmojiShortcode(input.shortcode);
  const sha = normalizeSHA256(input.asset_sha256);
  if (!isValidEmojiID(shortcode) || !sha || !emojiTokenFormatForMIME(input.mime_type)) {
    throw new Error("Invalid custom emoji metadata");
  }
  return {
    local_id: `emoji-${crypto.randomUUID()}`,
    shortcode,
    asset_sha256: sha,
    size_bytes: input.size_bytes,
    mime_type: input.mime_type,
    created_at_ms: Date.now()
  };
}

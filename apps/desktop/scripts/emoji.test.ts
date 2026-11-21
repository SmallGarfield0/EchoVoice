import assert from "node:assert/strict";
import {
  createEmojiToken,
  createLocalEmojiItem,
  createLocalEmojiPack,
  defaultEmojiCategories,
  defaultEmojis,
  emojiSearchScore,
  findEmojiShortcodeQuery,
  getBuiltInGraphicEmoji,
  isValidEmojiID,
  loadLocalEmojiPacks,
  loadRecentEmojiKeys,
  materializeEmojiAliases,
  normalizeCustomEmojiMetadataList,
  normalizeEmojiShortcode,
  parseEmojiReferences,
  resolveEmojiAlias,
  recordRecentEmojiKey,
  saveLocalEmojiPacks,
  unicodeEmojiVersion
} from "../src/lib/emoji.ts";

const sha = "ed7002b439e9ac845f22357d822bac144473fb0b771d2a79f80b7c8a1d6f0214";
assert.equal(normalizeEmojiShortcode(":Echo wave!:"), "echo_wave");
assert.equal(normalizeEmojiShortcode("abcdefghijklmnop"), "abcdefghijkl");
assert.equal(isValidEmojiID("echo_wave"), true);
assert.equal(isValidEmojiID("x"), true);
assert.equal(isValidEmojiID("Echo_wave"), false);
assert.equal(isValidEmojiID("emoji-id"), false);
assert.equal(isValidEmojiID("emoji_id_long"), false);
const legacyMetadata = normalizeCustomEmojiMetadataList([
  { shortcode: "normal", asset_sha256: sha, size_bytes: 1, mime_type: "image/png" },
  { shortcode: "33NMA_4RUX47_8E_CPO8", asset_sha256: sha, size_bytes: 2, mime_type: "IMAGE/JPEG" },
  { shortcode: "33NMA_4RUX47-more", asset_sha256: sha, size_bytes: 3, mime_type: "image/webp" }
]);
assert.deepEqual(
  legacyMetadata.map(({ shortcode, asset_sha256, mime_type }) => ({ shortcode, asset_sha256, mime_type })),
  [
    { shortcode: "normal", asset_sha256: sha, mime_type: "image/png" },
    { shortcode: "33nma_4rux47", asset_sha256: sha, mime_type: "image/jpeg" },
    { shortcode: "33nma_4rux_2", asset_sha256: sha, mime_type: "image/webp" }
  ]
);
assert.equal(new Set(defaultEmojis.map((emoji) => emoji.id)).size, defaultEmojis.length);
assert.equal(new Set(defaultEmojis.map((emoji) => emoji.value)).size, defaultEmojis.length);
assert.equal(defaultEmojis.every((emoji) => isValidEmojiID(emoji.id)), true);
assert.equal(defaultEmojis.every((emoji) => emoji.keywords.length > 0), true);
assert.equal(unicodeEmojiVersion, "17.0");
assert.ok(defaultEmojis.length >= 1900, `expected a comprehensive emoji catalog, got ${defaultEmojis.length}`);
assert.equal(defaultEmojiCategories.length, 8);
assert.equal(
  defaultEmojiCategories.every((category) => defaultEmojis.some((emoji) => emoji.category === category.id)),
  true,
  "every emoji category must contain at least one item"
);
const minimumCategoryCounts = {
  people: 500,
  symbols: 200,
  nature: 150,
  food: 120,
  activities: 80,
  travel: 200,
  objects: 250,
  flags: 250
};
for (const [category, minimum] of Object.entries(minimumCategoryCounts)) {
  const count = defaultEmojis.filter((emoji) => emoji.category === category).length;
  assert.ok(count >= minimum, `expected at least ${minimum} ${category} emoji, got ${count}`);
}
assert.equal(defaultEmojis.some((emoji) => emoji.value === "🫪" && emoji.keywords.includes("distorted face")), true);
assert.equal(defaultEmojis.some((emoji) => emoji.value === "🇨🇳" && emoji.category === "flags"), true);
assert.equal(defaultEmojis.some((emoji) => emoji.value === "🇺🇸" && emoji.category === "flags"), true);
const builtInPrideFlags = defaultEmojis.filter((emoji) => Boolean(emoji.imageURL));
assert.deepEqual(
  builtInPrideFlags.map((emoji) => emoji.id),
  [
    "progress", "lesbian", "gay_men", "bisexual", "pansexual", "asexual", "aromantic", "aroace",
    "nonbinary", "intersex", "agender", "genderfluid", "genderqueer", "polysexual", "omnisexual",
    "demisexual", "demiromantic"
  ]
);
assert.equal(builtInPrideFlags.every((emoji) => emoji.category === "flags"), true);
assert.equal(builtInPrideFlags.every((emoji) => emoji.imageURL?.startsWith("data:image/svg+xml")), true);
const orderedFlags = defaultEmojis.filter((emoji) => emoji.category === "flags");
assert.deepEqual(
  orderedFlags.slice(0, 18).map((emoji) => emoji.value),
  [
    "🏁", "🚩", "🎌", "🏳️", "🏴", "🏴‍☠️",
    "🇨🇳", "🇺🇸", "🇬🇧", "🇯🇵", "🇰🇷", "🇸🇬", "🇨🇦", "🇦🇺", "🇫🇷", "🇩🇪", "🇮🇳", "🇧🇷"
  ]
);
assert.deepEqual(
  orderedFlags.slice(18, 37).map((emoji) => emoji.value),
  [
    "🏳️‍🌈", "<:evb:progress>", "🏳️‍⚧️", "<:evb:lesbian>", "<:evb:gay_men>", "<:evb:bisexual>",
    "<:evb:pansexual>", "<:evb:asexual>", "<:evb:aromantic>", "<:evb:aroace>", "<:evb:nonbinary>",
    "<:evb:intersex>", "<:evb:agender>", "<:evb:genderfluid>", "<:evb:genderqueer>",
    "<:evb:polysexual>", "<:evb:omnisexual>", "<:evb:demisexual>", "<:evb:demiromantic>"
  ]
);
assert.equal(getBuiltInGraphicEmoji("<:evb:bisexual>")?.id, "bisexual");
assert.equal(getBuiltInGraphicEmoji("<:evb:not_found>"), undefined);
assert.ok(emojiSearchScore("rocket", ["launch", "space"], "roc") > emojiSearchScore("rocket", ["launch", "space"], "space"));
assert.deepEqual(findEmojiShortcodeQuery(":roc", 4), { query: "roc", start: 0, end: 4 });
assert.deepEqual(findEmojiShortcodeQuery("::", 1), { query: "", start: 0, end: 2 });
assert.deepEqual(findEmojiShortcodeQuery("hello :joy: world", 10), { query: "joy", start: 6, end: 11 });
assert.equal(findEmojiShortcodeQuery("hello :not valid", 16), null);
const token = createEmojiToken({ shortcode: "echo_wave", asset_sha256: sha, size_bytes: 2048, mime_type: "image/gif" });
assert.equal(token, `<:ev:echo_wave:${sha}:2048:gif>`);
assert.deepEqual(parseEmojiReferences(`hello ${token} world`)[0], {
  token,
  shortcode: "echo_wave",
  asset_sha256: sha,
  size_bytes: 2048,
  mime_type: "image/gif",
  start: 6,
  end: 6 + token.length
});

const pack = createLocalEmojiPack("Reaction pack");
pack.emojis.push(createLocalEmojiItem({
  shortcode: "echo_wave",
  asset_sha256: sha,
  size_bytes: 2048,
  mime_type: "image/gif"
}));
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value)
};
saveLocalEmojiPacks([pack], storage);
assert.deepEqual(loadLocalEmojiPacks(storage), [pack]);
const recent = recordRecentEmojiKey("default:joy", [], storage);
assert.deepEqual(recent, ["default:joy"]);
assert.deepEqual(loadRecentEmojiKeys(storage), ["default:joy"]);
assert.deepEqual(recordRecentEmojiKey("default:fire", recent, storage), ["default:fire", "default:joy"]);
const customSmile = { shortcode: "smile", asset_sha256: sha, size_bytes: 2048, mime_type: "image/gif" };
const customSmileToken = createEmojiToken(customSmile);
assert.equal(materializeEmojiAliases("hello :joy:"), "hello 😂");
assert.equal(materializeEmojiAliases("pride :bisexual:"), "pride <:evb:bisexual>");
assert.equal(materializeEmojiAliases("pride <:evb:bisexual>"), "pride <:evb:bisexual>");
assert.equal(materializeEmojiAliases("custom :smile: default :joy:", [customSmile]), `custom ${customSmileToken} default 😂`);
assert.equal(materializeEmojiAliases("unknown :not_found:", [customSmile]), "unknown :not_found:");
assert.equal(materializeEmojiAliases(customSmileToken, [customSmile]), customSmileToken);
assert.equal(resolveEmojiAlias("smile", [customSmile])?.kind, "custom");
assert.equal(resolveEmojiAlias("smile")?.kind, "default");
assert.equal(createEmojiToken({ shortcode: "x", asset_sha256: sha, size_bytes: 1, mime_type: "image/png" }).includes("<:ev:x:"), true);
assert.throws(() => createEmojiToken({ shortcode: "", asset_sha256: sha, size_bytes: 1, mime_type: "image/png" }));
assert.equal(parseEmojiReferences(`<:ev:bad:${sha}:0:png>`).length, 0);
assert.equal(parseEmojiReferences("<:evb:bisexual>").length, 0);

console.log("emoji ids, aliases, default catalog, tokens, and local pack tests passed");

import assert from "node:assert/strict";
import {
  composerInlineImagePlaceholder,
  createMessageAttachmentToken,
  createMessageImageToken,
  materializeMessageImageTokens,
  messageAttachmentEntry,
  messageAttachmentIsInlineMedia,
  parseMessageAttachmentReferences,
  parseMessageContentSegments,
  parseMessageImageReferences
} from "../src/lib/message-attachments.ts";
import type { ChannelFileEntry, ContentAsset } from "../src/lib/types.ts";

const entry: ChannelFileEntry = {
  entry_id: "file_image_1",
  channel_id: "channel_1",
  type: "file",
  name: "测试 image.png",
  owner_member_id: "member_1",
  size_bytes: 2048,
  mime_type: "image/png",
  created_at_ms: 1,
  updated_at_ms: 1
};

const token = createMessageAttachmentToken(entry);
const references = parseMessageAttachmentReferences(`caption\n${token}`);
assert.equal(references.length, 1);
assert.deepEqual(references[0], {
  entryId: entry.entry_id,
  sizeBytes: entry.size_bytes,
  mimeType: entry.mime_type,
  name: entry.name,
  previewKind: "image"
});
assert.equal(messageAttachmentIsInlineMedia(references[0]), true);
assert.equal(messageAttachmentEntry(references[0], entry.channel_id).owner_member_id, "");
assert.deepEqual(parseMessageAttachmentReferences("plain text"), []);

const imageSHA = "ab".repeat(32);
const imageToken = createMessageImageToken({
  sha256: imageSHA,
  size_bytes: 4096,
  mime_type: "image/webp",
  original_name: "粘贴 image.webp",
  created_at_ms: 1
});
assert.equal(imageToken, `<:image:${imageSHA}:4096:webp:%E7%B2%98%E8%B4%B4%20image.webp>`);
assert.deepEqual(parseMessageImageReferences(`caption\n${imageToken}`), [{
  assetSHA256: imageSHA,
  sizeBytes: 4096,
  mimeType: "image/webp",
  name: "粘贴 image.webp"
}]);
assert.deepEqual(parseMessageImageReferences("<:image:invalid:1:png:image.png>"), []);

const secondImageSHA = "cd".repeat(32);
const inlineImages: ContentAsset[] = [
  {
    sha256: imageSHA,
    size_bytes: 4096,
    mime_type: "image/webp",
    original_name: "first.webp",
    created_at_ms: 1
  },
  {
    sha256: secondImageSHA,
    size_bytes: 8192,
    mime_type: "image/png",
    original_name: "second.png",
    created_at_ms: 2
  }
];
const mixedDraft = `before${composerInlineImagePlaceholder}middle${composerInlineImagePlaceholder}after`;
const mixedContent = materializeMessageImageTokens(mixedDraft, inlineImages);
const mixedSegments = parseMessageContentSegments(mixedContent);
assert.deepEqual(mixedSegments.map((segment) => segment.type), ["text", "image", "text", "image", "text"]);
assert.equal(mixedSegments[0].type === "text" ? mixedSegments[0].content : "", "before");
assert.equal(mixedSegments[1].type === "image" ? mixedSegments[1].image.assetSHA256 : "", imageSHA);
assert.equal(mixedSegments[2].type === "text" ? mixedSegments[2].content : "", "middle");
assert.equal(mixedSegments[3].type === "image" ? mixedSegments[3].image.assetSHA256 : "", secondImageSHA);
assert.equal(mixedSegments[4].type === "text" ? mixedSegments[4].content : "", "after");
assert.throws(() => materializeMessageImageTokens(mixedDraft, inlineImages.slice(0, 1)));
assert.throws(() => materializeMessageImageTokens("plain text", inlineImages));

console.log("message attachment tests passed");

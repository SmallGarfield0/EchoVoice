import { classifyFilePreview, type FilePreviewKind } from "./file-storage.ts";
import type { ChannelFileEntry, ContentAsset } from "./types.ts";

export type MessageAttachmentReference = {
  entryId: string;
  sizeBytes: number;
  mimeType: string;
  name: string;
  previewKind: FilePreviewKind;
};

export type MessageImageReference = {
  assetSHA256: string;
  sizeBytes: number;
  mimeType: string;
  name: string;
};

export type MessageContentSegment =
  | { type: "text"; content: string }
  | { type: "image"; image: MessageImageReference; token: string };

export const composerInlineImagePlaceholder = "\uFFFC";

const messageImagePattern = /<:image:([a-fA-F0-9]{64}):([0-9]{1,12}):(png|gif|webp|jpg|avif):([A-Za-z0-9_.!~*%()-]+)>/g;

export function createMessageAttachmentToken(entry: ChannelFileEntry): string {
  const mimeType = encodeURIComponent(entry.mime_type || "application/octet-stream").replaceAll("'", "%27");
  const name = encodeURIComponent(entry.name).replaceAll("'", "%27");
  return `<:file:${entry.entry_id}:${entry.size_bytes}:${mimeType}:${name}>`;
}

export function parseMessageAttachmentReferences(content: string): MessageAttachmentReference[] {
  const references: MessageAttachmentReference[] = [];
  const pattern = /<:file:([A-Za-z0-9_-]{1,160}):([0-9]{1,16}):([A-Za-z0-9_.!~*%()-]+):([A-Za-z0-9_.!~*%()-]+)>/g;
  for (const match of content.matchAll(pattern)) {
    const sizeBytes = Number(match[2]);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) continue;
    const mimeType = decodeMetadata(match[3]);
    const name = decodeMetadata(match[4]);
    references.push({
      entryId: match[1],
      sizeBytes,
      mimeType,
      name,
      previewKind: classifyFilePreview(name, mimeType)
    });
  }
  return references;
}

export function createMessageImageToken(asset: ContentAsset): string {
  const format = messageImageFormat(asset.mime_type);
  if (!format) throw new Error(`Unsupported message image type: ${asset.mime_type}`);
  const name = encodeURIComponent(asset.original_name || "image").replaceAll("'", "%27");
  return `<:image:${asset.sha256}:${asset.size_bytes}:${format}:${name}>`;
}

export function materializeMessageImageTokens(content: string, assets: ContentAsset[]): string {
  let imageIndex = 0;
  const result = content.replaceAll(composerInlineImagePlaceholder, () => {
    const asset = assets[imageIndex];
    if (!asset) throw new Error("Message image placeholder is missing an uploaded asset");
    imageIndex += 1;
    return createMessageImageToken(asset);
  });
  if (imageIndex !== assets.length) {
    throw new Error("Uploaded message image is missing a composer placeholder");
  }
  return result;
}

export function parseMessageContentSegments(content: string): MessageContentSegment[] {
  const segments: MessageContentSegment[] = [];
  let offset = 0;
  for (const match of content.matchAll(messageImagePattern)) {
    const index = match.index ?? offset;
    if (index > offset) segments.push({ type: "text", content: content.slice(offset, index) });
    const image = messageImageReferenceFromMatch(match);
    if (image) {
      segments.push({ type: "image", image, token: match[0] });
    } else {
      segments.push({ type: "text", content: match[0] });
    }
    offset = index + match[0].length;
  }
  if (offset < content.length) segments.push({ type: "text", content: content.slice(offset) });
  return segments;
}

export function parseMessageImageReferences(content: string): MessageImageReference[] {
  return parseMessageContentSegments(content)
    .filter((segment): segment is Extract<MessageContentSegment, { type: "image" }> => segment.type === "image")
    .map((segment) => segment.image);
}

export function messageAttachmentEntry(
  reference: MessageAttachmentReference,
  channelId: string
): ChannelFileEntry {
  return {
    entry_id: reference.entryId,
    channel_id: channelId,
    type: "file",
    name: reference.name,
    owner_member_id: "",
    size_bytes: reference.sizeBytes,
    mime_type: reference.mimeType,
    created_at_ms: 0,
    updated_at_ms: 0
  };
}

export function messageAttachmentIsInlineMedia(reference: MessageAttachmentReference): boolean {
  return reference.previewKind === "image" || reference.previewKind === "video" || reference.previewKind === "audio";
}

function decodeMetadata(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function messageImageFormat(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/jpeg": return "jpg";
    case "image/avif": return "avif";
    default: return "";
  }
}

function messageImageMIME(format: string): string {
  switch (format) {
    case "png": return "image/png";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "jpg": return "image/jpeg";
    case "avif": return "image/avif";
    default: return "";
  }
}

function messageImageReferenceFromMatch(match: RegExpMatchArray): MessageImageReference | null {
  const sizeBytes = Number(match[2]);
  const mimeType = messageImageMIME(match[3]);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || !mimeType) return null;
  return {
    assetSHA256: match[1].toLowerCase(),
    sizeBytes,
    mimeType,
    name: decodeMetadata(match[4]) || "image"
  };
}

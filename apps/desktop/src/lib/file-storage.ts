export type FilePreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "archive"
  | "document"
  | "unknown";

export type FileSelectionResult = {
  selectedIds: Set<string>;
  anchorId: string;
};

export type ArchivePreviewEntry = {
  name: string;
  sizeBytes: number;
  compressedSizeBytes: number;
  directory: boolean;
};

export type ArchivePreview = {
  format: string;
  entries: ArchivePreviewEntry[];
  truncated: boolean;
  manifestAvailable: boolean;
};

export type DocumentPreview = {
  format: string;
  text: string;
  truncated: boolean;
  contentAvailable: boolean;
};

type ZipDirectoryEntry = ArchivePreviewEntry & {
  compressionMethod: number;
  generalPurposeFlags: number;
  localHeaderOffset: number;
};

type ZipDirectory = {
  format: string;
  entries: ZipDirectoryEntry[];
  totalEntries: number;
  truncated: boolean;
  available: boolean;
};

const textExtensions = new Set([
  "txt", "md", "markdown", "json", "jsonl", "xml", "csv", "tsv", "log", "yaml", "yml",
  "toml", "ini", "conf", "config", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs",
  "ts", "tsx", "jsx", "svelte", "vue", "go", "rs", "py", "java", "kt", "kts", "c", "h", "cpp",
  "hpp", "cs", "php", "rb", "sh", "ps1", "sql", "graphql", "proto"
]);

const archiveExtensions = new Set(["zip", "tar", "tgz", "gz", "bz2", "xz", "7z", "rar"]);
const documentExtensions = new Set(["doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "epub"]);
const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const videoExtensions = new Set(["mp4", "webm", "ogv", "mov", "m4v", "mkv"]);
const audioExtensions = new Set(["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac"]);

export function classifyFilePreview(name: string, mimeType = ""): FilePreviewKind {
  const mime = mimeType.trim().toLowerCase().split(";", 1)[0];
  const extension = fileExtension(name);
  if ((mime.startsWith("image/") && mime !== "image/svg+xml") || imageExtensions.has(extension)) return "image";
  if (mime.startsWith("video/") || videoExtensions.has(extension)) return "video";
  if (mime.startsWith("audio/") || audioExtensions.has(extension)) return "audio";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime.endsWith("+xml") || textExtensions.has(extension)) return "text";
  if (documentExtensions.has(extension) || mime.includes("officedocument") || mime.includes("opendocument")) return "document";
  if (archiveExtensions.has(extension) || isArchiveMIME(mime)) return "archive";
  return "unknown";
}

export function filePreviewIcon(kind: FilePreviewKind, directory = false): string {
  if (directory) return "folder";
  switch (kind) {
    case "image": return "image";
    case "video": return "movie";
    case "audio": return "audio_file";
    case "pdf": return "picture_as_pdf";
    case "text": return "description";
    case "archive": return "folder_zip";
    case "document": return "draft";
    default: return "insert_drive_file";
  }
}

export function updateFileSelection(
  current: ReadonlySet<string>,
  orderedIds: string[],
  targetId: string,
  anchorId: string,
  modifiers: { toggle: boolean; range: boolean }
): FileSelectionResult {
  if (modifiers.range && anchorId) {
    const anchorIndex = orderedIds.indexOf(anchorId);
    const targetIndex = orderedIds.indexOf(targetId);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const selectedIds = modifiers.toggle ? new Set(current) : new Set<string>();
      for (let index = start; index <= end; index += 1) selectedIds.add(orderedIds[index]);
      return { selectedIds, anchorId };
    }
  }
  if (modifiers.toggle) {
    const selectedIds = new Set(current);
    if (selectedIds.has(targetId)) selectedIds.delete(targetId);
    else selectedIds.add(targetId);
    return { selectedIds, anchorId: targetId };
  }
  return { selectedIds: new Set([targetId]), anchorId: targetId };
}

export async function readTextPreview(blob: Blob, maxBytes = 2 * 1024 * 1024): Promise<{ text: string; truncated: boolean }> {
  const truncated = blob.size > maxBytes;
  const text = await blob.slice(0, maxBytes).text();
  return { text, truncated };
}

export async function readArchivePreview(blob: Blob, name: string): Promise<ArchivePreview> {
  const extension = fileExtension(name);
  if (extension === "zip" || extension === "docx" || extension === "xlsx" || extension === "pptx" || extension === "epub") {
    return readZipPreview(blob);
  }
  if (extension === "tar") return readTarPreview(blob);
  return { format: extension ? extension.toUpperCase() : "Archive", entries: [], truncated: false, manifestAvailable: false };
}

export async function readDocumentPreview(blob: Blob, name: string, maxCharacters = 250_000): Promise<DocumentPreview> {
  const extension = fileExtension(name);
  const format = documentFormat(extension);
  if (extension === "rtf") {
    const truncated = blob.size > 4 * 1024 * 1024;
    const source = await blob.slice(0, 4 * 1024 * 1024).text();
    const text = rtfVisibleText(source).slice(0, maxCharacters);
    return { format, text, truncated: truncated || text.length >= maxCharacters, contentAvailable: Boolean(text) };
  }

  const directory = await readZipDirectory(blob);
  if (!directory.available) {
    return { format, text: "", truncated: directory.truncated, contentAvailable: false };
  }
  const candidates = documentContentEntries(extension, directory.entries);
  const sections: string[] = [];
  let truncated = directory.truncated;
  let characterCount = 0;
  for (const entry of candidates) {
    if (characterCount >= maxCharacters) {
      truncated = true;
      break;
    }
    const extracted = await readZipEntry(blob, entry, 8 * 1024 * 1024);
    if (!extracted) continue;
    truncated ||= extracted.truncated;
    const text = xmlVisibleText(new TextDecoder("utf-8", { fatal: false }).decode(extracted.bytes));
    if (!text) continue;
    const remaining = maxCharacters - characterCount;
    const sectionText = text.slice(0, remaining);
    if (candidates.length > 1) sections.push(`${documentSectionName(entry.name)}\n${sectionText}`);
    else sections.push(sectionText);
    characterCount += sectionText.length;
    if (text.length > remaining) truncated = true;
  }
  const text = sections.join("\n\n").trim();
  return { format, text, truncated, contentAvailable: Boolean(text) };
}

function fileExtension(name: string): string {
  const clean = name.trim().toLowerCase();
  const index = clean.lastIndexOf(".");
  return index >= 0 ? clean.slice(index + 1) : "";
}

function isArchiveMIME(mime: string): boolean {
  return mime === "application/zip" || mime === "application/x-zip-compressed" ||
    mime === "application/x-tar" || mime === "application/gzip" || mime === "application/x-gzip" ||
    mime === "application/x-7z-compressed" || mime === "application/vnd.rar" || mime === "application/x-rar-compressed";
}

async function readZipPreview(blob: Blob): Promise<ArchivePreview> {
  const directory = await readZipDirectory(blob);
  return {
    format: directory.format,
    entries: directory.entries.map(({ name, sizeBytes, compressedSizeBytes, directory: isDirectory }) => ({
      name,
      sizeBytes,
      compressedSizeBytes,
      directory: isDirectory
    })),
    truncated: directory.truncated,
    manifestAvailable: directory.available
  };
}

async function readZipDirectory(blob: Blob): Promise<ZipDirectory> {
  const maxTailBytes = 65_557;
  const tailStart = Math.max(0, blob.size - maxTailBytes);
  const tail = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (readUInt32LE(tail, index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return { format: "ZIP", entries: [], totalEntries: 0, truncated: false, available: false };

  const totalEntries = readUInt16LE(tail, eocd + 10);
  const directorySize = readUInt32LE(tail, eocd + 12);
  const directoryOffset = readUInt32LE(tail, eocd + 16);
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    return { format: "ZIP64", entries: [], totalEntries, truncated: true, available: false };
  }

  const maxDirectoryBytes = 8 * 1024 * 1024;
  const bytesToRead = Math.min(directorySize, maxDirectoryBytes);
  const central = new Uint8Array(await blob.slice(directoryOffset, directoryOffset + bytesToRead).arrayBuffer());
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ZipDirectoryEntry[] = [];
  let offset = 0;
  while (offset + 46 <= central.length && entries.length < 500) {
    if (readUInt32LE(central, offset) !== 0x02014b50) break;
    const generalPurposeFlags = readUInt16LE(central, offset + 8);
    const compressionMethod = readUInt16LE(central, offset + 10);
    const compressedSizeBytes = readUInt32LE(central, offset + 20);
    const sizeBytes = readUInt32LE(central, offset + 24);
    const nameLength = readUInt16LE(central, offset + 28);
    const extraLength = readUInt16LE(central, offset + 30);
    const commentLength = readUInt16LE(central, offset + 32);
    const localHeaderOffset = readUInt32LE(central, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > central.length) break;
    const entryName = decoder.decode(central.subarray(nameStart, nameEnd));
    entries.push({
      name: entryName,
      sizeBytes,
      compressedSizeBytes,
      directory: entryName.endsWith("/"),
      compressionMethod,
      generalPurposeFlags,
      localHeaderOffset
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return {
    format: "ZIP",
    entries,
    totalEntries,
    truncated: entries.length < totalEntries || directorySize > maxDirectoryBytes,
    available: true
  };
}

async function readZipEntry(
  blob: Blob,
  entry: ZipDirectoryEntry,
  maxUncompressedBytes: number
): Promise<{ bytes: Uint8Array; truncated: boolean } | null> {
  if (entry.directory || (entry.generalPurposeFlags & 0x1) !== 0 || entry.sizeBytes > maxUncompressedBytes) return null;
  const header = new Uint8Array(await blob.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer());
  if (header.length < 30 || readUInt32LE(header, 0) !== 0x04034b50) return null;
  const nameLength = readUInt16LE(header, 26);
  const extraLength = readUInt16LE(header, 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = blob.slice(dataStart, dataStart + entry.compressedSizeBytes);
  if (entry.compressionMethod === 0) {
    return { bytes: new Uint8Array(await compressed.arrayBuffer()), truncated: false };
  }
  if (entry.compressionMethod !== 8 || typeof DecompressionStream === "undefined") return null;
  try {
    const stream = compressed.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (bytes.length > maxUncompressedBytes) return null;
    return { bytes, truncated: false };
  } catch {
    return null;
  }
}

function documentContentEntries(extension: string, entries: ZipDirectoryEntry[]): ZipDirectoryEntry[] {
  const files = entries.filter((entry) => !entry.directory);
  if (extension === "docx") return files.filter((entry) => entry.name === "word/document.xml");
  if (extension === "pptx") {
    return files
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
      .sort(naturalPathCompare)
      .slice(0, 100);
  }
  if (extension === "xlsx") {
    return files
      .filter((entry) => entry.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))
      .sort((left, right) => left.name === "xl/sharedStrings.xml" ? -1 : right.name === "xl/sharedStrings.xml" ? 1 : naturalPathCompare(left, right))
      .slice(0, 50);
  }
  if (extension === "odt" || extension === "ods" || extension === "odp") {
    return files.filter((entry) => entry.name === "content.xml");
  }
  if (extension === "epub") {
    return files
      .filter((entry) => /\.(?:xhtml|html|htm)$/i.test(entry.name))
      .sort(naturalPathCompare)
      .slice(0, 30);
  }
  return [];
}

function naturalPathCompare(left: ZipDirectoryEntry, right: ZipDirectoryEntry): number {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

function documentFormat(extension: string): string {
  const labels: Record<string, string> = {
    doc: "Word", docx: "DOCX", odt: "ODT", rtf: "RTF",
    xls: "Excel", xlsx: "XLSX", ods: "ODS",
    ppt: "PowerPoint", pptx: "PPTX", odp: "ODP", epub: "EPUB"
  };
  return labels[extension] ?? (extension ? extension.toUpperCase() : "Document");
}

function documentSectionName(path: string): string {
  const match = path.match(/(?:slide|sheet)(\d+)\.xml$/i);
  if (match) return `#${match[1]}`;
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function xmlVisibleText(xml: string): string {
  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    if (!document.querySelector("parsererror")) {
      const output: string[] = [];
      const blockNames = new Set(["p", "br", "tab", "tr", "row", "table-row", "slide"]);
      const visit = (node: Node) => {
        if (node.nodeType === 3) {
          output.push(node.nodeValue ?? "");
          return;
        }
        for (const child of Array.from(node.childNodes)) visit(child);
        const localName = (node as Element).localName;
        if (localName && blockNames.has(localName)) output.push("\n");
      };
      visit(document.documentElement);
      return normalizePreviewText(output.join(""));
    }
  }
  return normalizePreviewText(decodeXMLEntities(
    xml
      .replace(/<\/(?:w:p|a:p|text:p|text:h|table:table-row|tr|row)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  ));
}

function rtfVisibleText(source: string): string {
  const decoder = new TextDecoder("windows-1252", { fatal: false });
  return normalizePreviewText(
    source
      .replace(/\\u(-?\d+)\??/g, (_match, raw) => String.fromCodePoint((Number(raw) + 65_536) % 65_536))
      .replace(/\\'([0-9a-f]{2})/gi, (_match, hex) => decoder.decode(Uint8Array.of(Number.parseInt(hex, 16))))
      .replace(/\\(?:par|line)\b/g, "\n")
      .replace(/\\tab\b/g, "\t")
      .replace(/\\[a-z]+-?\d* ?/gi, "")
      .replace(/\\[^a-z0-9]/gi, "")
      .replace(/[{}]/g, "")
  );
}

function decodeXMLEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, value) => String.fromCodePoint(Number.parseInt(value, 16)));
}

function normalizePreviewText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readTarPreview(blob: Blob): Promise<ArchivePreview> {
  const maxBytes = Math.min(blob.size, 16 * 1024 * 1024);
  const bytes = new Uint8Array(await blob.slice(0, maxBytes).arrayBuffer());
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ArchivePreviewEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length && entries.length < 500) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = trimNulls(decoder.decode(header.subarray(0, 100)));
    if (!name) break;
    const prefix = trimNulls(decoder.decode(header.subarray(345, 500)));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = trimNulls(decoder.decode(header.subarray(124, 136))).trim();
    const sizeBytes = Number.parseInt(sizeText || "0", 8) || 0;
    const typeFlag = header[156];
    entries.push({
      name: fullName,
      sizeBytes,
      compressedSizeBytes: sizeBytes,
      directory: typeFlag === 53 || fullName.endsWith("/")
    });
    offset += 512 + Math.ceil(sizeBytes / 512) * 512;
  }
  return {
    format: "TAR",
    entries,
    truncated: offset + 512 > bytes.length && maxBytes < blob.size,
    manifestAvailable: true
  };
}

function trimNulls(value: string): string {
  const nullIndex = value.indexOf("\0");
  return (nullIndex >= 0 ? value.slice(0, nullIndex) : value).trim();
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) return 0;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) return 0;
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

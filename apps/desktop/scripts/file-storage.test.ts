import assert from "node:assert/strict";
import {
  classifyFilePreview,
  filePreviewIcon,
  readArchivePreview,
  readDocumentPreview,
  updateFileSelection
} from "../src/lib/file-storage.ts";

assert.equal(classifyFilePreview("photo.png", "image/png"), "image");
assert.equal(classifyFilePreview("movie.mp4", "video/mp4"), "video");
assert.equal(classifyFilePreview("photo.webp", "application/octet-stream"), "image");
assert.equal(classifyFilePreview("movie.webm", "text/plain; charset=utf-8"), "video");
assert.equal(classifyFilePreview("recording.flac", "application/octet-stream"), "audio");
assert.equal(classifyFilePreview("readme.md", ""), "text");
assert.equal(classifyFilePreview("manual.pdf", "application/octet-stream"), "pdf");
assert.equal(classifyFilePreview("bundle.zip", "application/zip"), "archive");
assert.equal(classifyFilePreview("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "document");
assert.equal(filePreviewIcon("archive"), "folder_zip");

let result = updateFileSelection(new Set(), ["a", "b", "c", "d"], "b", "", { toggle: false, range: false });
assert.deepEqual([...result.selectedIds], ["b"]);
result = updateFileSelection(result.selectedIds, ["a", "b", "c", "d"], "d", result.anchorId, { toggle: false, range: true });
assert.deepEqual([...result.selectedIds], ["b", "c", "d"]);
result = updateFileSelection(result.selectedIds, ["a", "b", "c", "d"], "c", result.anchorId, { toggle: true, range: false });
assert.deepEqual([...result.selectedIds], ["b", "d"]);

const docxBlob = createStoredZip(
  "word/document.xml",
  "<?xml version=\"1.0\"?><w:document xmlns:w=\"urn:test\"><w:body><w:p><w:r><w:t>EchoVoice DOCX preview</w:t></w:r></w:p></w:body></w:document>"
);
const archive = await readArchivePreview(docxBlob, "preview.docx");
assert.equal(archive.manifestAvailable, true);
assert.equal(archive.entries[0]?.name, "word/document.xml");
const documentPreview = await readDocumentPreview(docxBlob, "preview.docx");
assert.equal(documentPreview.contentAvailable, true);
assert.equal(documentPreview.text, "EchoVoice DOCX preview");

const rtfPreview = await readDocumentPreview(new Blob(["{\\rtf1\\ansi EchoVoice\\par RTF preview}"]), "preview.rtf");
assert.equal(rtfPreview.text, "EchoVoice\nRTF preview");

console.log("file storage tests passed");

function createStoredZip(name: string, content: string): Blob {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const contentBytes = encoder.encode(content);
  const local = new Uint8Array(30 + nameBytes.length + contentBytes.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint32(18, contentBytes.length, true);
  localView.setUint32(22, contentBytes.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(contentBytes, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint32(20, contentBytes.length, true);
  centralView.setUint32(24, contentBytes.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);
  return new Blob([local, central, end], { type: "application/zip" });
}

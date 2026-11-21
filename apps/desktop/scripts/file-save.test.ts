import assert from "node:assert/strict";
import { saveFileWithSystemPicker, type FileSavePicker } from "../src/lib/file-save.ts";

let savedBlob: Blob | null = null;
let pickerOptions: Parameters<FileSavePicker>[0] | null = null;
const sequence: string[] = [];
const picker: FileSavePicker = async (options) => {
  sequence.push("picker");
  pickerOptions = options;
  return {
    async createWritable() {
      return {
        async write(blob) {
          savedBlob = blob;
        },
        async close() {}
      };
    }
  };
};

const source = new Blob(["EchoVoice"], { type: "text/plain" });
assert.equal(await saveFileWithSystemPicker(async () => {
  sequence.push("download");
  return source;
}, "notes.txt", "text/plain", picker), "saved");
assert.equal(savedBlob, source);
assert.deepEqual(sequence, ["picker", "download"]);
assert.equal(pickerOptions?.suggestedName, "notes.txt");
assert.deepEqual(pickerOptions?.types?.[0].accept, { "text/plain": [".txt"] });

const cancelledPicker: FileSavePicker = async () => {
  throw new DOMException("cancelled", "AbortError");
};
let cancelledDownloadStarted = false;
assert.equal(await saveFileWithSystemPicker(async () => {
  cancelledDownloadStarted = true;
  return source;
}, "notes.txt", "text/plain", cancelledPicker), "cancelled");
assert.equal(cancelledDownloadStarted, false);

console.log("file save tests passed");

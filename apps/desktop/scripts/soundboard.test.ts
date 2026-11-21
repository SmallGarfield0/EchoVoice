import assert from "node:assert/strict";
import { File } from "node:buffer";
import {
  createLocalSoundboardItem,
  clampSoundboardVolumePercent,
  formatSoundboardPosition,
  loadLocalSoundboardItems,
  loadSoundboardVolumePercent,
  parseSoundboardPosition,
  saveLocalSoundboardItems
} from "../src/lib/soundboard.ts";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value)
};
const file = new File(["audio"], "Arrival.wav", { type: "audio/wav" });
const sha = "ed7002b439e9ac845f22357d822bac144473fb0b771d2a79f80b7c8a1d6f0214";
const item = createLocalSoundboardItem(file, sha);
assert.equal(item.name, "Arrival");
assert.equal(item.base_volume, 1);
saveLocalSoundboardItems([item], storage);
assert.deepEqual(loadLocalSoundboardItems(storage), [item]);
assert.equal(formatSoundboardPosition(62_340), "1:02.34");
assert.equal(parseSoundboardPosition("1:02.34"), 62_340);
assert.equal(parseSoundboardPosition("0:05.007"), 5_007);
assert.equal(parseSoundboardPosition(""), 0);
assert.equal(parseSoundboardPosition("1:70"), null);
values.set("ev.soundboard.test", "250");
assert.equal(loadSoundboardVolumePercent("ev.soundboard.test", false, storage), 200);
values.set("ev.soundboard.test", "-10");
assert.equal(loadSoundboardVolumePercent("ev.soundboard.test", true, storage), 0);
assert.equal(clampSoundboardVolumePercent(3), 5);

values.set("ev.soundboard.local.v1", JSON.stringify([{ ...item, base_volume: 12 }]));
assert.equal(loadLocalSoundboardItems(storage)[0]?.base_volume, 2);

console.log("soundboard metadata tests passed");

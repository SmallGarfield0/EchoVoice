import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { measureMarkers } from "./screen-share-optical.mjs";

const frames = 240, delayFrames = 7, fps = 120;
const times = Array.from({ length: frames }, (_, i) => i * 1000 / fps);
const pixels = Buffer.alloc(frames * 48);
for (let i = 0; i < frames; i++) {
  for (const [side, time] of [i, Math.max(0, i - delayFrames)].entries()) {
    const id = (65525 + Math.floor(time / 2)) & 65535;
    const code = (id << 8) | ((id ^ (id >>> 8) ^ 165) & 255);
    for (let j = 0; j < 24; j++) pixels[i * 48 + side * 24 + j] = code & (1 << j) ? 230 : 15;
  }
}
const expected = delayFrames * 1000 / fps;
const clean = measureMarkers(times, pixels);
assert.equal(clean.invalidSourceCameraFrames, 0);
assert.equal(clean.unmatchedReceiverChanges, 0);
assert.equal(clean.matchedChanges, 116);
assert.ok(Math.abs(clean.glassToGlassP95MS - expected) < 1e-6);
const damaged = Buffer.from(pixels);
damaged.fill(127, 24, 48);
assert.equal(measureMarkers(times, damaged).invalidReceiverCameraFrames, 1);

// Decode an actual lossless file using camera PTS and exercise both ROI crops.
const dir = mkdtempSync(join(tmpdir(), "ev-optical-test-"));
try {
  const file = join(dir, "two-screens.nut");
  const encode = spawnSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-s", "48x1",
    "-pix_fmt", "gray", "-framerate", String(fps), "-i", "pipe:0", "-vf", "scale=192:8:flags=neighbor",
    "-c:v", "ffv1", file], { input: pixels, windowsHide: true });
  assert.equal(encode.status, 0, encode.error?.message || encode.stderr?.toString());
  const output = spawnSync(process.execPath, [join(import.meta.dirname, "screen-share-optical.mjs"),
    file, "0,0,96,8", "96,0,96,8"], { encoding: "utf8", windowsHide: true });
  assert.equal(output.status, 0, output.stderr);
  const measured = JSON.parse(output.stdout);
  assert.equal(measured.matchedChanges, clean.matchedChanges);
  assert.ok(Math.abs(measured.glassToGlassP50MS - expected) < 0.01);
  console.log("ok - 120 FPS timecoded optical fixture recovered its seven-camera-frame delay across ID rollover");
} finally {
  rmSync(dir, { force: true, recursive: true });
}

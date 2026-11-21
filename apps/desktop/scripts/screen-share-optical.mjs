// Analyze a single high-speed camera recording of the source and receiver.
// Both ROIs cover the 24 marker cells only, ordered left to right.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function run(command, args) {
  const result = spawnSync(command, args, { maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + " failed: " + result.stderr.toString().trim());
  return result.stdout;
}

function region(text) {
  if (!/^\d+,\d+,\d+,\d+$/.test(text ?? "")) throw new Error("Each ROI must be x,y,width,height in camera pixels");
  const [x, y, w, h] = text.split(",").map(Number);
  if (w < 24 || h < 1 || ![x, y, w, h].every(Number.isSafeInteger)) throw new Error("Invalid marker region");
  return { x, y, w, h };
}

function marker(row) {
  const lo = Math.min(...row), hi = Math.max(...row);
  if (hi - lo < 48) return null;
  let code = 0;
  for (let bit = 0; bit < 24; bit++) {
    const level = (row[bit] - lo) / (hi - lo);
    if (level > 0.35 && level < 0.65) return null; // partly scanned transition
    if (level >= 0.65) code |= 1 << bit;
  }
  const id = code >>> 8;
  return (code & 255) === ((id ^ (id >>> 8) ^ 165) & 255) ? id : null;
}

const percentile = (sorted, p) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;

export function measureMarkers(times, data) {
  if (times.length * 48 !== data.length) throw new Error("Camera timestamps and decoded frame count differ");
  let sourceId, receiverId, sourceChanges = 0, receiverChanges = 0, seenSource = 0;
  let invalidSource = 0, invalidReceiver = 0, unmatchedReceiver = 0, unmatchedExpired = 0;
  let previousTime = -Infinity;
  const changes = new Map(), durations = [], cameraIntervals = [];
  for (let i = 0; i < times.length; i++) {
    const at = times[i];
    if (!Number.isFinite(at) || at <= previousTime) throw new Error("Recording needs strictly increasing presentation timestamps");
    if (i > 0) cameraIntervals.push(at - previousTime);
    previousTime = at;
    const offset = i * 48;
    const src = marker(data.subarray(offset, offset + 24));
    const rx = marker(data.subarray(offset + 24, offset + 48));
    if (src === null) invalidSource++;
    else if (src !== sourceId) {
      // The first visible value on each display may predate the recording.
      if (sourceId !== undefined) {
        if (changes.has(src)) unmatchedExpired++;
        changes.set(src, at);
        sourceChanges++;
      }
      sourceId = src;
    }
    if (rx === null) invalidReceiver++;
    else if (rx !== receiverId) {
      if (receiverId !== undefined) {
        receiverChanges++;
        if (changes.has(rx)) {
          durations.push(at - changes.get(rx));
          changes.delete(rx);
          seenSource++;
        } else unmatchedReceiver++;
      }
      receiverId = rx;
    }
  }
  durations.sort((a, b) => a - b);
  cameraIntervals.sort((a, b) => a - b);
  return {
    cameraFrames: times.length, cameraFrameIntervalP50MS: percentile(cameraIntervals, 0.5),
    sourceChanges, receiverChanges, matchedChanges: seenSource,
    unmatchedSourceChanges: changes.size + unmatchedExpired, unmatchedReceiverChanges: unmatchedReceiver,
    invalidSourceCameraFrames: invalidSource, invalidReceiverCameraFrames: invalidReceiver,
    glassToGlassP50MS: percentile(durations, 0.5), glassToGlassP95MS: percentile(durations, 0.95),
    glassToGlassP99MS: percentile(durations, 0.99), maxMS: durations.at(-1) ?? null
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [file, a, b] = process.argv.slice(2);
  if (!file || !b) throw new Error("Usage: node screen-share-optical.mjs recording sourceROI receiverROI");
  const rois = [region(a), region(b)];
  const meta = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_frames",
    "-show_streams", "-show_entries", "frame=best_effort_timestamp_time:stream=width,height", "-of", "json", file]));
  const { width, height } = meta.streams[0];
  for (const r of rois) {
    if (r.x + r.w > width || r.y + r.h > height) throw new Error("Marker ROI lies outside the video frame");
  }
  const filters = rois.map((r, i) => `[s${i}]crop=${r.w}:${r.h}:${r.x}:${r.y}:exact=1,scale=24:1:flags=area,setsar=1[m${i}]`);
  const graph = ["[0:v:0]format=gray,split[s0][s1]", ...filters, "[m0][m1]hstack[out]"].join(";");
  const data = run("ffmpeg", ["-v", "error", "-noautorotate", "-i", file, "-filter_complex", graph,
    "-map", "[out]", "-fps_mode", "passthrough", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"]);
  const result = measureMarkers(meta.frames.map(f => Number(f.best_effort_timestamp_time) * 1000), data);
  console.log(JSON.stringify(result, null, 2));
  if (result.matchedChanges === 0) process.exitCode = 1;
}

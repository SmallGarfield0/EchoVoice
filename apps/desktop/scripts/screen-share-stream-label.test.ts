import assert from "node:assert/strict";

import {
  screenShareFrameRateSuffix,
  screenShareLimitationHint,
  screenSharePendingSettingsSuffix,
  screenShareResolutionSuffix
} from "../src/lib/screenShareStreamLabel.ts";

const results: string[] = [];
function run(name: string, body: () => void) {
  body();
  results.push(name);
}

run("names the delivered picture size", () => {
  assert.equal(screenShareResolutionSuffix(1280, 720), " · 1280×720");
  assert.equal(screenShareResolutionSuffix(1920, 1080), " · 1920×1080");
});

run("says nothing before the stats report the size", () => {
  assert.equal(screenShareResolutionSuffix(undefined, undefined), "");
  assert.equal(screenShareResolutionSuffix(0, 0), "");
  assert.equal(screenShareResolutionSuffix(Number.NaN, 720), "");
});

run("refuses a half-known size", () => {
  assert.equal(screenShareResolutionSuffix(1280, undefined), "");
  assert.equal(screenShareResolutionSuffix(undefined, 720), "");
});

run("rounds the fractional sizes some reports carry", () => {
  assert.equal(screenShareResolutionSuffix(1279.6, 719.5), " · 1280×720");
});

run("only shows a rate it actually measured", () => {
  assert.equal(screenShareFrameRateSuffix(30), " · 30 fps");
  assert.equal(screenShareFrameRateSuffix(29.6), " · 30 fps");
  assert.equal(screenShareFrameRateSuffix(0), " · 0 fps");
  assert.equal(screenShareFrameRateSuffix(Number.NaN), "");
  assert.equal(screenShareFrameRateSuffix(undefined), "");
});

run("says when a native quality change can only reach the next share", () => {
  const translate = (key: string) => (key === "screenShare.qualityNextShare" ? "next share" : "");
  assert.equal(screenSharePendingSettingsSuffix(true, translate), " · next share");
  assert.equal(screenSharePendingSettingsSuffix(false, translate), "");
});

run("does not invent a hint when there is nothing pending", () => {
  const translate = () => "next share";
  assert.equal(screenSharePendingSettingsSuffix(false, translate), "");
});

run("points a CPU limited share at the frame rate", () => {
  assert.equal(screenShareLimitationHint("cpu"), "lower-frame-rate");
});

run("points a bandwidth limited share at the bitrate", () => {
  assert.equal(screenShareLimitationHint("bandwidth"), "lower-bitrate");
});

run("names no setting for a limitation the browser cannot explain", () => {
  assert.equal(screenShareLimitationHint("other"), "none");
});

run("carries no hint while the share is healthy", () => {
  assert.equal(screenShareLimitationHint("none"), "none");
  assert.equal(screenShareLimitationHint(undefined), "none");
  assert.equal(screenShareLimitationHint(null), "none");
});

for (const result of results) console.log(`ok - ${result}`);

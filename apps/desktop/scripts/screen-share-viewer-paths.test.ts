import assert from "node:assert/strict";

import {
  screenShareViewerLayerSuffix,
  summarizeScreenShareViewerLayers
} from "../src/lib/screenShareViewerPaths.ts";

const results: string[] = [];
function run(name: string, body: () => void) {
  body();
  results.push(name);
}

const translateLayers = (key: string, params?: Record<string, string | number>) =>
  `${key}:${params?.reduced}/${params?.count}`;

run("counts the viewers that are not on the shared encode", () => {
  const summary = summarizeScreenShareViewerLayers(["a", "b", "c"], {
    a: "high",
    b: "low",
    c: "low"
  });
  assert.deepEqual(summary, { viewers: 3, reduced: 2 });
  assert.equal(
    screenShareViewerLayerSuffix(summary, translateLayers),
    " · screenShare.viewerLayersReduced:2/3"
  );
});

run("a share where everybody is on the shared encode stays quiet", () => {
  const summary = summarizeScreenShareViewerLayers(["a"], { a: "high" });
  assert.deepEqual(summary, { viewers: 1, reduced: 0 });
  assert.equal(screenShareViewerLayerSuffix(summary, translateLayers), "");
});

run("does not invent a tier for a viewer the sender has not reported", () => {
  const summary = summarizeScreenShareViewerLayers(["a", "b"], { a: "low" });
  assert.deepEqual(summary, { viewers: 2, reduced: 1 });
});

run("treats a missing tier map as nobody reduced", () => {
  const summary = summarizeScreenShareViewerLayers(["a", "b"], undefined);
  assert.deepEqual(summary, { viewers: 2, reduced: 0 });
  assert.equal(screenShareViewerLayerSuffix(summary, translateLayers), "");
});

for (const name of results) console.log(`ok - ${name}`);

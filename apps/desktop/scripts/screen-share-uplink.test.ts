import assert from "node:assert/strict";

import { screenSharePerViewerCostLabel } from "../src/lib/screenShareUplink.ts";

function run(name, body) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const translate = (key, params = {}) =>
  key === "screenShare.perViewerCost" ? `${params.mbps} Mbps per viewer` : key;

run("states what one viewer costs before the share starts", () => {
  assert.equal(
    screenSharePerViewerCostLabel(8_684_400, translate),
    " · 8.7 Mbps per viewer"
  );
});

run("says nothing when there is no per-viewer cost to state", () => {
  assert.equal(screenSharePerViewerCostLabel(Number.NaN, translate), "");
  assert.equal(screenSharePerViewerCostLabel(0, translate), "");
  assert.equal(screenSharePerViewerCostLabel(-1, translate), "");
});

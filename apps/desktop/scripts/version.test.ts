import assert from "node:assert/strict";

import { compareVersions, evaluateVersionCompatibility, publicVersionSeries } from "../src/lib/version.ts";

assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
assert.equal(compareVersions("v0.0.9", "0.1.0"), -1);
assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1);
assert.equal(compareVersions("development", "0.1.0"), null);
assert.equal(publicVersionSeries("v2.7.13+build.4"), "2.7.x");
assert.equal(publicVersionSeries("development"), null);

assert.deepEqual(
  evaluateVersionCompatibility({
    serverVersion: "0.0.9",
    minimumServerVersion: "0.1.0",
    clientVersion: "0.1.0",
    minimumClientVersion: "0.1.0"
  }),
  { serverVersionUnknown: false, serverOutdated: true, clientOutdated: false }
);
assert.deepEqual(
  evaluateVersionCompatibility({
    clientVersion: "0.0.9",
    minimumClientVersion: "0.1.0"
  }),
  { serverVersionUnknown: true, serverOutdated: false, clientOutdated: true }
);
assert.equal(evaluateVersionCompatibility({ clientUpdateRequired: true }).clientOutdated, true);

console.log("version compatibility tests passed");

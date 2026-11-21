import assert from "node:assert/strict";
import { normalizeSHA256, sha256Hex } from "../src/lib/content-cache.ts";

const expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
assert.equal(await sha256Hex(new TextEncoder().encode("hello world")), expected);
assert.equal(normalizeSHA256(expected.toUpperCase()), expected);
assert.equal(normalizeSHA256("not-a-sha"), "");
assert.equal(normalizeSHA256(`${expected}00`), "");

console.log("content cache tests passed");

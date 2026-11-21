import { strict as assert } from "node:assert";
import {
  rtcIceServerRefreshAfterMS,
  rtcIceServersNeedRefresh
} from "../src/lib/rtcIceServerFreshness.ts";

function run(name: string, body: () => void) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const now = 1_700_000_000_000;
const minute = 60 * 1000;

run("reuses a list fetched a moment ago", () => {
  assert.equal(rtcIceServersNeedRefresh(now - minute, now), false);
});

run("reuses a list fetched inside the refresh window", () => {
  assert.equal(rtcIceServersNeedRefresh(now - rtcIceServerRefreshAfterMS + 1, now), false);
});

run("refreshes exactly at the refresh window", () => {
  assert.equal(rtcIceServersNeedRefresh(now - rtcIceServerRefreshAfterMS, now), true);
});

run("refreshes a list older than the two hour credential lifetime", () => {
  assert.equal(rtcIceServersNeedRefresh(now - 3 * 60 * minute, now), true);
});

run("refreshes a list that was never timestamped", () => {
  assert.equal(rtcIceServersNeedRefresh(undefined, now), true);
  assert.equal(rtcIceServersNeedRefresh(0, now), true);
  assert.equal(rtcIceServersNeedRefresh(Number.NaN, now), true);
});

run("refreshes when the clock cannot be trusted", () => {
  assert.equal(rtcIceServersNeedRefresh(now - minute, Number.NaN), true);
});

run("does not loop when the clock moved backwards", () => {
  // A list "fetched in the future" must not be refreshed on every single call;
  // that would turn one bad clock into a request per peer connection.
  assert.equal(rtcIceServersNeedRefresh(now + 5 * minute, now), false);
});

console.log("rtcIceServerFreshness tests passed");

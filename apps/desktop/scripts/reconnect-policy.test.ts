import { strict as assert } from "node:assert";
import { reconnectDelayMS } from "../src/lib/reconnect-policy.ts";

run("caps the backoff at the configured maximum", () => {
  assert.equal(reconnectDelayMS(10), 15_000);
});

run("doubles per attempt until the cap", () => {
  assert.equal(reconnectDelayMS(1), 2_000);
  assert.equal(reconnectDelayMS(2), 4_000);
  assert.equal(reconnectDelayMS(3), 8_000);
  assert.equal(reconnectDelayMS(4), 15_000);
  assert.equal(reconnectDelayMS(5), 15_000);
});

run("honours a custom base for the dedicated voice socket", () => {
  assert.equal(reconnectDelayMS(1, { baseMS: 750 }), 1_500);
  assert.equal(reconnectDelayMS(2, { baseMS: 750 }), 3_000);
  assert.equal(reconnectDelayMS(4, { baseMS: 750 }), 12_000);
});

run("returns zero for the initial attempt", () => {
  assert.equal(reconnectDelayMS(0), 0);
});

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

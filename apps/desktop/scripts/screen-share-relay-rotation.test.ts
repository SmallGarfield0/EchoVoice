import assert from "node:assert/strict";

import {
  screenShareCredentialLifetimeMS,
  screenShareRelayRotationDue,
  screenShareRelayRotationLeadMS,
  screenShareRelayRotationMinIntervalMS,
  screenShareRelayRotationSpreadMS
} from "../src/lib/screenShareRelayRotation.ts";

let failures = 0;
function run(name: string, body: () => void) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

const now = 1_800_000_000_000;

run("keeps a freshly relayed viewer on its current allocation", () => {
  assert.equal(
    screenShareRelayRotationDue({ nowMS: now, pathKind: "relay", credentialFetchedAtMS: now - 60_000 }),
    false
  );
});

run("rebuilds a relayed viewer before the credential expires", () => {
  const credentialFetchedAtMS = now - (screenShareCredentialLifetimeMS - screenShareRelayRotationLeadMS);
  assert.equal(
    screenShareRelayRotationDue({ nowMS: now, pathKind: "relay", credentialFetchedAtMS }),
    true
  );
});

run("waits until the lead window opens", () => {
  const credentialFetchedAtMS =
    now - (screenShareCredentialLifetimeMS - screenShareRelayRotationLeadMS) + 1;
  assert.equal(
    screenShareRelayRotationDue({ nowMS: now, pathKind: "relay", credentialFetchedAtMS }),
    false
  );
});

run("never rebuilds a direct path", () => {
  assert.equal(
    screenShareRelayRotationDue({ nowMS: now, pathKind: "direct", credentialFetchedAtMS: now - 3 * 3_600_000 }),
    false
  );
});

run("never rebuilds a path it cannot classify", () => {
  assert.equal(
    screenShareRelayRotationDue({ nowMS: now, pathKind: "unknown", credentialFetchedAtMS: now - 3 * 3_600_000 }),
    false
  );
});

run("does nothing without a credential timestamp", () => {
  assert.equal(
    screenShareRelayRotationDue({ nowMS: now, pathKind: "relay", credentialFetchedAtMS: 0 }),
    false
  );
  assert.equal(
    screenShareRelayRotationDue({ nowMS: now, pathKind: "relay", credentialFetchedAtMS: Number.NaN }),
    false
  );
});

run("holds after a rebuild so an unreachable server cannot loop", () => {
  const credentialFetchedAtMS = 0;
  assert.equal(
    screenShareRelayRotationDue({
      nowMS: now,
      pathKind: "relay",
      credentialFetchedAtMS: now - 3 * 3_600_000,
      lastRotationAtMS: now - screenShareRelayRotationMinIntervalMS + 1
    }),
    false,
    "a rebuild in the last interval must hold even a long stale credential"
  );
  assert.equal(
    screenShareRelayRotationDue({
      nowMS: now,
      pathKind: "relay",
      credentialFetchedAtMS: now - 3 * 3_600_000,
      lastRotationAtMS: now - screenShareRelayRotationMinIntervalMS
    }),
    true,
    "the hold is a floor, not a permanent stop"
  );
  assert.ok(credentialFetchedAtMS === 0);
});

run("spreads the rebuild across its window", () => {
  const credentialFetchedAtMS = now - (screenShareCredentialLifetimeMS - screenShareRelayRotationLeadMS);
  assert.equal(
    screenShareRelayRotationDue({
      nowMS: now,
      pathKind: "relay",
      credentialFetchedAtMS,
      spreadMS: 30_000
    }),
    false,
    "a later slot in the window is not due yet"
  );
  assert.equal(
    screenShareRelayRotationDue({
      nowMS: now + 30_000,
      pathKind: "relay",
      credentialFetchedAtMS,
      spreadMS: 30_000
    }),
    true
  );
});

run("treats a broken clock as no reason to rebuild", () => {
  assert.equal(
    screenShareRelayRotationDue({
      nowMS: Number.NaN,
      pathKind: "relay",
      credentialFetchedAtMS: now - 3 * 3_600_000
    }),
    false
  );
});

run("gives every peer a stable slot inside the window", () => {
  const first = screenShareRelayRotationSpreadMS("mem_alpha");
  const second = screenShareRelayRotationSpreadMS("mem_alpha");
  assert.equal(first, second, "the same peer must always land on the same offset");
  assert.ok(first >= 0 && first < 60_000, `unexpected spread ${first}`);
  assert.notEqual(first, screenShareRelayRotationSpreadMS("mem_beta"));
});

if (failures > 0) {
  console.error(`screenShareRelayRotation tests failed: ${failures}`);
  process.exit(1);
}
console.log("screenShareRelayRotation tests passed");

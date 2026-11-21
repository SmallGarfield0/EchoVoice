import { strict as assert } from "node:assert";
import { browserRTCConfiguration } from "../src/lib/browserRTCConfiguration.ts";

function run(name: string, body: () => void) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

run("bundles every media section onto a single ICE transport", () => {
  const configuration = browserRTCConfiguration([]);
  assert.equal(
    configuration.bundlePolicy,
    "max-bundle",
    "screen share carries video and audio; a separate transport per m-line costs one relay allocation each"
  );
});

run("never pre-gathers ICE candidates against the relay port range", () => {
  const configuration = browserRTCConfiguration([]);
  assert.equal(
    configuration.iceCandidatePoolSize,
    undefined,
    "pre-gathering holds TURN ports before they are needed, and the relay range is small"
  );
});

run("forwards only the ICE server fields the browser needs", () => {
  const configuration = browserRTCConfiguration([
    { urls: "turn:relay.example:3478?transport=udp", username: "member.token", credential: "secret" },
    { urls: ["stun:stun.example:3478"], username: "", credential: "" }
  ]);
  assert.deepEqual(configuration.iceServers, [
    { urls: "turn:relay.example:3478?transport=udp", username: "member.token", credential: "secret" },
    { urls: ["stun:stun.example:3478"], username: "", credential: "" }
  ]);
});

run("keeps the array identity of a multi-url ICE server", () => {
  const urls = ["turn:relay.example:3478?transport=udp", "turn:relay.example:3478?transport=tcp"];
  const configuration = browserRTCConfiguration([{ urls }]);
  assert.deepEqual(configuration.iceServers?.[0]?.urls, urls);
});

run("survives an empty server list", () => {
  assert.deepEqual(browserRTCConfiguration([]).iceServers, []);
});

console.log("browserRTCConfiguration tests passed");

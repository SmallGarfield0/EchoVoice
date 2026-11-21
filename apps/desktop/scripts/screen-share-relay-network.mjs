import { fork, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

// Exercise the product's embedded TURN relay and native sender against Chromium.
// Only encrypted video packets on the viewer downlink are delayed and dropped.
// ICE, DTLS, RTCP and the sender uplink pass through unchanged.
function videoPayload(packet) {
  if (packet.length < 16) return false;
  let offset;
  if ((packet[0] & 0xc0) === 0x40) {
    offset = 4; // TURN ChannelData framing
  } else if (packet.readUInt16BE(0) === 0x0017 && packet.length >= 20) {
    // Before ChannelBind completes, the relay can use a STUN DATA indication.
    for (let pos = 20; pos + 4 <= packet.length;) {
      const type = packet.readUInt16BE(pos);
      const length = packet.readUInt16BE(pos + 2);
      if (type === 0x0013) { offset = pos + 4; break; }
      pos += 4 + Math.ceil(length / 4) * 4;
    }
  }
  if (offset === undefined || packet.length < offset + 12 || (packet[offset] & 0xc0) !== 0x80) return false;
  const payloadType = packet[offset + 1] & 0x7f;
  return payloadType === 102 || payloadType === 103;
}

const dir = mkdtempSync(join(tmpdir(), "ev-screen-relay-"));
const relay = spawn("go", ["test", "-count=1", "-run", "^TestBrowserRelayFixture$", "./internal/mediarelay"], {
  cwd: join(import.meta.dirname, "..", "..", "..", "services", "ev-server"),
  env: { ...process.env, EV_BROWSER_TURN_FIXTURE_DIR: dir },
  stdio: "inherit", windowsHide: true
});
const relayExit = once(relay, "exit");
const listener = createSocket("udp4");
const clients = new Map();
const pending = new Set();
let browser;
try {
  const readyPath = join(dir, "turn.json");
  const deadline = Date.now() + 120_000;
  while (!existsSync(readyPath) && Date.now() < deadline && relay.exitCode === null) await wait(100);
  if (!existsSync(readyPath)) throw new Error("Embedded TURN fixture failed to publish its loopback address");
  const { address, username, credential } = JSON.parse(readFileSync(readyPath, "utf8"));
  const serverPort = Number(address.split(":").pop());
  let impaired = false, examined = 0, dropped = 0;
  listener.on("message", (packet, client) => {
    let upstream = clients.get(client.port);
    if (!upstream) {
      upstream = createSocket("udp4");
      clients.set(client.port, upstream);
      upstream.on("message", reply => {
        const forward = () => listener.send(reply, client.port, "127.0.0.1");
        if (!impaired || !videoPayload(reply)) { forward(); return; }
        examined++;
        if (examined % 37 === 0) { dropped++; return; }
        const timer = setTimeout(() => { pending.delete(timer); forward(); }, 20);
        pending.add(timer);
      });
    }
    upstream.send(packet, serverPort, "127.0.0.1");
  });
  listener.bind(0, "127.0.0.1");
  await once(listener, "listening");
  const iceServers = [{ urls: [`turn:127.0.0.1:${listener.address().port}?transport=udp`], username, credential }];
  browser = fork(join(import.meta.dirname, "screen-share-browser-interop.mjs"), ["42e01f", "640", "360", "30"], {
    env: {
      ...process.env,
      EV_SCREEN_SHARE_RELAY_DIAGNOSTIC_URL: "",
      EV_SCREEN_SHARE_BROWSER_ICE_SERVERS: JSON.stringify(iceServers),
      EV_SCREEN_SHARE_RELAY_IMPAIR: "1",
      EV_SCREEN_SHARE_BROWSER_BASELINE_ONLY: "1",
      EV_SCREEN_SHARE_RELAY_TARGET_BITRATE_BPS: "2500000"
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true
  });
  browser.on("message", message => {
    if (message?.type !== "relay-network") return;
    impaired = message.enabled;
    browser.send({ type: "relay-network-ack", examined, dropped });
  });
  const [code] = await once(browser, "exit");
  if (code !== 0 || dropped === 0) throw new Error(`Relay/browser regression failed (exit ${code}, dropped ${dropped})`);
} finally {
  for (const timer of pending) clearTimeout(timer);
  for (const client of clients.values()) client.close();
  try { listener.close(); } catch (error) { if (error.code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error; }
  if (browser && browser.exitCode === null && browser.signalCode === null) browser.kill();
  writeFileSync(join(dir, "stop"), "");
  const [code] = await relayExit;
  for (const name of ["turn.json", "turn.tmp", "stop"]) rmSync(join(dir, name), { force: true });
  rmdirSync(dir);
  if (code !== 0) throw new Error(`Embedded TURN failed (exit ${code})`);
}

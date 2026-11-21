import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const browserCandidates = [
  process.env.CHROME_BIN,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForBrowser(port, timeoutMS = 10_000) {
  const deadline = Date.now() + timeoutMS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Chromium is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Chromium debugging endpoint did not start");
}

function evaluateInBrowser(webSocketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("error", () => reject(new Error("Chromium debugging connection failed")), {
      once: true
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener("open", async () => {
      const call = (method, params = {}) =>
        new Promise((resolveCall, rejectCall) => {
          const id = nextId++;
          pending.set(id, { resolve: resolveCall, reject: rejectCall });
          socket.send(JSON.stringify({ id, method, params }));
        });
      try {
        await call("Runtime.enable");
        const result = await call("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        }
        resolve(result.result.value);
      } catch (error) {
        reject(error);
      } finally {
        socket.close();
      }
    });
  });
}

async function connectDiagnosticMember(baseUrl) {
  const localProfileId = `codex-rtc-relay-${crypto.randomUUID()}`;
  const response = await fetch(`${baseUrl}/api/v1/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      server_password: process.env.EV_SERVER_PASSWORD ?? "",
      profile: {
        local_profile_id: localProfileId,
        display_name: "EchoVoice RTC Relay Diagnostic",
        bio: "Temporary automated TURN diagnostic",
        profile_updated_at_ms: Date.now()
      }
    })
  });
  if (!response.ok) throw new Error(`connect failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function loadRTCConfig(baseUrl, sessionToken) {
  const response = await fetch(`${baseUrl}/api/v1/rtc-config`, {
    headers: { Authorization: `Bearer ${sessionToken}` }
  });
  if (!response.ok) throw new Error(`RTC config failed (${response.status}): ${await response.text()}`);
  const payload = await response.json();
  return payload.ice_servers ?? [];
}

async function removeDiagnosticMember(baseUrl, sessionToken) {
  await fetch(`${baseUrl}/api/v1/membership`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${sessionToken}` }
  }).catch(() => undefined);
}

function relayMediaExpression(iceServers, options) {
  const configuration = {
    iceServers: iceServers.map((server) => ({
      urls: server.urls,
      username: server.username,
      credential: server.credential
    })),
    iceTransportPolicy: "relay",
    bundlePolicy: "max-bundle"
  };
  return `(async () => {
    const configuration = ${JSON.stringify(configuration)};
    const options = ${JSON.stringify(options)};
    const sender = new RTCPeerConnection(configuration);
    const receiver = new RTCPeerConnection(configuration);
    const canvas = document.createElement('canvas');
    canvas.width = options.width;
    canvas.height = options.height;
    const context = canvas.getContext('2d', { alpha: false });
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    document.body.append(video);
    let frame = 0;
    const draw = () => {
      context.fillStyle = '#050607';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#8acbff';
      context.fillRect((frame * 19) % Math.max(1, canvas.width - 220), 120, 220, 140);
      context.fillStyle = '#f4f7f9';
      context.font = '36px sans-serif';
      context.fillText('EchoVoice TURN frame ' + frame, 32, 64);
      frame += 1;
    };
    draw();
    const drawTimer = setInterval(draw, Math.max(8, Math.round(1000 / options.frameRate)));
    const stream = canvas.captureStream(options.frameRate);
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'motion';
    const rtpSender = sender.addTrack(track, stream);
    const parameters = rtpSender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = options.maxBitrate;
    parameters.encodings[0].maxFramerate = options.frameRate;
    parameters.degradationPreference = 'maintain-framerate';
    await rtpSender.setParameters(parameters).catch(() => undefined);
    receiver.ontrack = (event) => {
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      video.play().catch(() => undefined);
    };
    const waitForGathering = async (connection) => {
      if (connection.iceGatheringState === 'complete') return;
      await Promise.race([
        new Promise((resolve) => {
          const changed = () => {
            if (connection.iceGatheringState !== 'complete') return;
            connection.removeEventListener('icegatheringstatechange', changed);
            resolve();
          };
          connection.addEventListener('icegatheringstatechange', changed);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TURN candidate gathering timed out')), 15000))
      ]);
    };
    const snapshot = async () => {
      const stats = await receiver.getStats();
      let inbound = null;
      let pair = null;
      let localCandidate = null;
      let remoteCandidate = null;
      for (const report of stats.values()) {
        if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) inbound = report;
        if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId) || pair;
      }
      if (!pair) {
        for (const report of stats.values()) {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) {
            pair = report;
            break;
          }
        }
      }
      if (pair) {
        localCandidate = stats.get(pair.localCandidateId) || null;
        remoteCandidate = stats.get(pair.remoteCandidateId) || null;
      }
      return {
        connectionState: receiver.connectionState,
        iceConnectionState: receiver.iceConnectionState,
        bytesReceived: inbound?.bytesReceived || 0,
        packetsReceived: inbound?.packetsReceived || 0,
        packetsLost: inbound?.packetsLost || 0,
        framesDecoded: inbound?.framesDecoded || 0,
        framesDropped: inbound?.framesDropped || 0,
        jitter: inbound?.jitter || 0,
        roundTripTime: pair?.currentRoundTripTime || 0,
        availableIncomingBitrate: pair?.availableIncomingBitrate || 0,
        localCandidateType: localCandidate?.candidateType || '',
        localProtocol: localCandidate?.protocol || '',
        remoteCandidateType: remoteCandidate?.candidateType || '',
        remoteProtocol: remoteCandidate?.protocol || '',
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        renderedFrames: video.getVideoPlaybackQuality?.().totalVideoFrames || 0
      };
    };
    try {
      await sender.setLocalDescription(await sender.createOffer());
      await waitForGathering(sender);
      await receiver.setRemoteDescription(sender.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await waitForGathering(receiver);
      await sender.setRemoteDescription(receiver.localDescription);
      const connectedDeadline = performance.now() + 15000;
      let initial = null;
      while (performance.now() < connectedDeadline) {
        initial = await snapshot();
        if (initial.framesDecoded > 0 && initial.videoWidth > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!initial || initial.framesDecoded <= 0) {
        return { ok: false, phase: 'first-frame', initial };
      }
      const samples = [initial];
      for (let index = 0; index < options.durationSeconds; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        samples.push(await snapshot());
      }
      const final = samples.at(-1);
      return {
        ok: final.framesDecoded > initial.framesDecoded + Math.max(20, options.durationSeconds * 5),
        initial,
        final,
        frameGrowth: final.framesDecoded - initial.framesDecoded,
        byteGrowth: final.bytesReceived - initial.bytesReceived,
        samples
      };
    } finally {
      clearInterval(drawTimer);
      stream.getTracks().forEach((item) => item.stop());
      sender.close();
      receiver.close();
      video.remove();
    }
  })()`;
}

async function stopBrowser(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
}

const baseUrl = String(process.argv[2] ?? "").replace(/\/$/, "");
if (!baseUrl) throw new Error("usage: npm run diagnose:rtc-relay -- https://server.example:port");
const browser = browserCandidates.find((candidate) => existsSync(candidate));
if (!browser) throw new Error("Chrome or Edge is required for the TURN diagnostic");

let member;
let child;
let profilePath;
try {
  member = await connectDiagnosticMember(baseUrl);
  const iceServers = await loadRTCConfig(baseUrl, member.session_token);
  assert.ok(iceServers.some((server) => server.urls?.some((url) => String(url).startsWith("turn:"))), "server returned no TURN URL");
  const port = await reservePort();
  profilePath = mkdtempSync(join(tmpdir(), "ev-rtc-relay-"));
  child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profilePath}`,
      "about:blank"
    ],
    { stdio: "ignore", windowsHide: true }
  );
  const webSocketUrl = await waitForBrowser(port);
  for (const maxBitrate of [2_500_000, 8_000_000]) {
    const result = await evaluateInBrowser(
      webSocketUrl,
      relayMediaExpression(iceServers, {
        width: 1280,
        height: 720,
        frameRate: 60,
        maxBitrate,
        durationSeconds: 10
      })
    );
    console.log(`${maxBitrate / 1_000_000} Mbps TURN result: ${JSON.stringify(result)}`);
    assert.equal(result?.initial?.localCandidateType, "relay", "receiver did not select a local relay candidate");
    assert.equal(result?.initial?.remoteCandidateType, "relay", "receiver did not select a remote relay candidate");
    assert.equal(result?.ok, true, `TURN video stopped at ${maxBitrate / 1_000_000} Mbps`);
  }
} finally {
  if (member?.session_token) await removeDiagnosticMember(baseUrl, member.session_token);
  if (child) await stopBrowser(child);
  if (profilePath) rmSync(profilePath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}


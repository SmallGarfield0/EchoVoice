import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

const browserCandidates = [
  process.env.CHROME_BIN,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

function cargoCommandArgs(args) {
  const sourceConfig = process.env.EV_CARGO_SOURCE_CONFIG?.trim();
  return sourceConfig ? ["--config", sourceConfig, ...args] : args;
}

function nativeTestCommand(name) {
  if (process.env.EV_SCREEN_SHARE_TEST_BINARY) {
    return [process.env.EV_SCREEN_SHARE_TEST_BINARY, [name, "--nocapture"]];
  }
  return ["cargo", cargoCommandArgs(["test", "-p", "echovoice-desktop", name, "--", "--nocapture"])];
}

function findBrowser() {
  return browserCandidates.find((candidate) => existsSync(candidate)) ?? "";
}

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

async function connectRelayDiagnosticMember(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      server_password: process.env.EV_SERVER_PASSWORD ?? "",
      profile: {
        local_profile_id: `codex-native-relay-${crypto.randomUUID()}`,
        display_name: "EchoVoice Native Relay Diagnostic",
        bio: "Temporary automated native screen-share diagnostic",
        profile_updated_at_ms: Date.now()
      }
    })
  });
  if (!response.ok) throw new Error(`relay diagnostic connect failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function loadRelayIceServers(baseUrl, sessionToken) {
  const response = await fetch(`${baseUrl}/api/v1/rtc-config`, {
    headers: { Authorization: `Bearer ${sessionToken}` }
  });
  if (!response.ok) throw new Error(`relay diagnostic RTC config failed (${response.status}): ${await response.text()}`);
  const payload = await response.json();
  return payload.ice_servers ?? [];
}

async function removeRelayDiagnosticMember(baseUrl, sessionToken) {
  await fetch(`${baseUrl}/api/v1/membership`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${sessionToken}` }
  }).catch(() => undefined);
}

async function waitForBrowser(port, timeoutMS = 8000, targetURL) {
  const deadline = Date.now() + timeoutMS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl &&
          (!targetURL || item.url === targetURL));
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Chromium debugging endpoint did not start: ${lastError?.message ?? "timeout"}`);
}

function evaluateInBrowser(webSocketUrl, expression, clipFile) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;
    const fail = (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      reject(error);
    };
    socket.addEventListener("error", () => fail(new Error("Chromium debugging connection failed")), { once: true });
    socket.addEventListener("close", () => {
      if (pending.size) fail(new Error("Chromium closed during evaluation"));
    }, { once: true });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !pending.has(message.id)) return;
      const request = pending.get(message.id);
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
        if (clipFile) {
          const { root } = await call("DOM.getDocument");
          const { nodeId } = await call("DOM.querySelector", { nodeId: root.nodeId, selector: "#clip" });
          await call("DOM.setFileInputFiles", { nodeId, files: [resolve(clipFile)] });
        }
        const evaluated = await call("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true
        });
        if (evaluated.exceptionDetails) {
          throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
        }
        resolve(evaluated.result.value);
      } catch (error) {
        reject(error);
      } finally {
        socket.close();
      }
    });
  });
}

async function waitForSourcePage(port) {
  const endpoint = await waitForBrowser(port, 10000, benchmarkPage.href);
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await evaluateInBrowser(endpoint, 'typeof startSource === "function" && document.readyState === "complete"')) return endpoint;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("The benchmark source page did not finish loading");
}

function browserNegotiationExpression(profileLevelId) {
  return `(async () => {
    const withTimeout = (promise, phase, timeoutMs = 4000) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(phase + " timed out")), timeoutMs))
    ]);
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const receiver = new RTCPeerConnection({ iceServers: [] });
    try {
      const transceiver = offerer.addTransceiver("video", { direction: "sendonly" });
      const capabilities = RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities("video");
      const h264Codecs = (capabilities && capabilities.codecs || []).filter((codec) =>
        codec.mimeType && codec.mimeType.toLowerCase() === "video/h264"
      );
      const requestedH264 = h264Codecs.filter((codec) =>
        (codec.sdpFmtpLine || "").toLowerCase().includes("profile-level-id=" + ${JSON.stringify(profileLevelId)})
      );
      if (h264Codecs.length === 0) throw new Error("browser reports no H.264 video codec capability");
      if (transceiver.setCodecPreferences && requestedH264.length > 0) {
        transceiver.setCodecPreferences(requestedH264);
      }

      const offer = await withTimeout(offerer.createOffer(), "createOffer");
      await withTimeout(offerer.setLocalDescription(offer), "setLocalDescription(offer)");
      const localOffer = offerer.localDescription || offer;
      if (!/H264\\/90000/i.test(localOffer.sdp || "")) {
        throw new Error("browser-generated offer does not include H.264");
      }

      await withTimeout(receiver.setRemoteDescription(localOffer), "setRemoteDescription(offer)");
      const answer = await withTimeout(receiver.createAnswer(), "createAnswer");
      await withTimeout(receiver.setLocalDescription(answer), "setLocalDescription(answer)");
      const localAnswer = receiver.localDescription || answer;
      const videoLine = (localAnswer.sdp || "").split(/\\r?\\n/).find((line) => line.startsWith("m=video ")) || "";
      return {
        ok: !/^m=video\\s+0(?:\\s|$)/.test(videoLine) && receiver.signalingState === "stable",
        videoLine,
        answerHasH264: /H264\\/90000/i.test(localAnswer.sdp || ""),
        requestedProfileAvailable: requestedH264.length > 0,
        signalingState: receiver.signalingState
      };
    } finally {
      offerer.close();
      receiver.close();
    }
  })()`;
}

function browserScreenShareLoopbackExpression(profile) {
  return `(async () => {
    const senderPc = new RTCPeerConnection({ iceServers: [] });
    const receiverPc = new RTCPeerConnection({ iceServers: [] });
    const canvas = document.createElement("canvas");
    canvas.width = ${profile.width};
    canvas.height = ${profile.height};
    const context = canvas.getContext("2d", { alpha: false });
    if (!context || typeof canvas.captureStream !== "function") {
      senderPc.close();
      receiverPc.close();
      return { ok: false, error: "canvas capture is unavailable" };
    }
    let frameIndex = 0;
    const drawFrame = () => {
      const width = canvas.width;
      const height = canvas.height;
      const tileSize = 64;
      for (let y = 0; y < height; y += tileSize) {
        for (let x = 0; x < width; x += tileSize) {
          const phase = (Math.floor(x / tileSize) + Math.floor(y / tileSize) + frameIndex) % 4;
          context.fillStyle = ["#050505", "#8acbff", "#efefef", "#315f78"][phase];
          context.fillRect(x, y, tileSize, tileSize);
        }
      }
      context.fillStyle = "#050505";
      context.fillRect(20, 18, Math.min(680, width - 40), 58);
      context.fillStyle = "#eeeeee";
      context.font = "32px sans-serif";
      context.fillText("EchoVoice Web Screen Share " + frameIndex, 32, 64);
      frameIndex += 1;
    };
    drawFrame();
    const sourceFps = Math.min(${profile.frameRate}, 60);
    const drawTimer = setInterval(drawFrame, Math.max(8, Math.round(1000 / sourceFps)));
    const stream = canvas.captureStream(${profile.frameRate});
    const track = stream.getVideoTracks()[0];
    track.contentHint = "motion";
    const audioContext = new AudioContext({ sampleRate: 48000 });
    const oscillator = audioContext.createOscillator();
    const audioDestination = audioContext.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    oscillator.connect(audioDestination);
    oscillator.start();
    await audioContext.resume();
    const audioTrack = audioDestination.stream.getAudioTracks()[0];
    audioTrack.contentHint = "music";
    stream.addTrack(audioTrack);
    const videoSender = senderPc.addTrack(track, stream);
    const videoTransceiver = senderPc.getTransceivers().find((item) => item.sender === videoSender);
    const videoCapabilities = RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities("video");
    if (videoTransceiver?.setCodecPreferences && videoCapabilities?.codecs?.length) {
      const primaryOrder = ["video/h264", "video/vp9", "video/vp8", "video/av1"];
      const primaryMimeTypes = new Set(primaryOrder);
      const groups = [];
      const supplemental = [];
      let currentGroup = null;
      videoCapabilities.codecs.forEach((codec, index) => {
        const mimeType = codec.mimeType.toLowerCase();
        if (primaryMimeTypes.has(mimeType)) {
          currentGroup = { codecs: [codec], index };
          groups.push(currentGroup);
        } else if (mimeType === "video/rtx" && currentGroup) {
          currentGroup.codecs.push(codec);
        } else {
          supplemental.push(codec);
        }
      });
      groups.sort((left, right) => {
        const leftRank = primaryOrder.indexOf(left.codecs[0].mimeType.toLowerCase());
        const rightRank = primaryOrder.indexOf(right.codecs[0].mimeType.toLowerCase());
        return leftRank - rightRank || left.index - right.index;
      });
      videoTransceiver.setCodecPreferences([...groups.flatMap((group) => group.codecs), ...supplemental]);
    }
    senderPc.addTrack(audioTrack, stream);
    const requestedMaxBitrate = ${Math.min(80_000_000, Math.max(1_500_000, Math.round(profile.width * profile.height / 1_000_000 * profile.frameRate * 400_000)))};
    const applySenderParameters = async () => {
      let lastError = null;
      for (const includePriority of [true, false]) {
        try {
          const parameters = videoSender.getParameters();
          if (!parameters.encodings?.length) throw new Error("encoding parameters are unavailable");
          parameters.encodings[0].active = true;
          parameters.encodings[0].maxBitrate = requestedMaxBitrate;
          parameters.encodings[0].maxFramerate = ${profile.frameRate};
          parameters.encodings[0].scaleResolutionDownBy = 1;
          if (includePriority) {
            parameters.encodings[0].priority = "high";
            parameters.encodings[0].networkPriority = "high";
          }
          parameters.degradationPreference = "maintain-resolution";
          await videoSender.setParameters(parameters);
          return videoSender.getParameters();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("could not configure sender");
    };
    await applySenderParameters().catch(() => undefined);

    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);
    receiverPc.ontrack = (event) => {
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      video.play().catch(() => undefined);
    };
    const waitForIce = async (pc) => {
      if (pc.iceGatheringState === "complete") return;
      await Promise.race([
        new Promise((resolve) => {
          const changed = () => {
            if (pc.iceGatheringState !== "complete") return;
            pc.removeEventListener("icegatheringstatechange", changed);
            resolve();
          };
          pc.addEventListener("icegatheringstatechange", changed);
        }),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
    };

    try {
      await senderPc.setLocalDescription(await senderPc.createOffer());
      await waitForIce(senderPc);
      await receiverPc.setRemoteDescription(senderPc.localDescription);
      await receiverPc.setLocalDescription(await receiverPc.createAnswer());
      await waitForIce(receiverPc);
      await senderPc.setRemoteDescription(receiverPc.localDescription);
      const appliedParameters = await applySenderParameters();

      const mediaStartedAt = performance.now();
      const minimumRunUntil = mediaStartedAt + 5000;
      const deadline = mediaStartedAt + 10000;
      let bytesReceived = 0;
      let framesDecoded = 0;
      let packetsReceived = 0;
      let audioBytesReceived = 0;
      let audioPacketsReceived = 0;
      while (performance.now() < deadline) {
        const stats = await receiverPc.getStats();
        bytesReceived = 0;
        framesDecoded = 0;
        packetsReceived = 0;
        audioBytesReceived = 0;
        audioPacketsReceived = 0;
        stats.forEach((report) => {
          if (report.type !== "inbound-rtp") return;
          if (report.kind === "video" || report.mediaType === "video") {
            bytesReceived += report.bytesReceived || 0;
            framesDecoded += report.framesDecoded || 0;
            packetsReceived += report.packetsReceived || 0;
          }
          if (report.kind === "audio" || report.mediaType === "audio") {
            audioBytesReceived += report.bytesReceived || 0;
            audioPacketsReceived += report.packetsReceived || 0;
          }
        });
        stats.forEach((report) => {
          if (report.type !== "candidate-pair") return;
        });
        if (
          performance.now() >= minimumRunUntil &&
          bytesReceived > 0 &&
          framesDecoded >= Math.min(20, sourceFps) &&
          audioBytesReceived > 0 &&
          audioPacketsReceived > 0 &&
          video.videoWidth > 0
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const settings = track.getSettings();
      const senderStats = await senderPc.getStats();
      let outbound = null;
      let negotiatedCodec = "";
      senderStats.forEach((report) => {
        if (report.type !== "outbound-rtp" || (report.kind || report.mediaType) !== "video") return;
        outbound = report;
        negotiatedCodec = report.codecId ? (senderStats.get(report.codecId)?.mimeType || "") : "";
      });
      const mediaElapsedSeconds = Math.max(0.001, (performance.now() - mediaStartedAt) / 1000);
      return {
        ok: bytesReceived > 0 && framesDecoded > 0 && audioBytesReceived > 0 && audioPacketsReceived > 0 && settings.width === ${profile.width} && settings.height === ${profile.height},
        bytesReceived,
        packetsReceived,
        framesDecoded,
        audioBytesReceived,
        audioPacketsReceived,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        encodedFrameWidth: outbound?.frameWidth || 0,
        encodedFrameHeight: outbound?.frameHeight || 0,
        trackWidth: settings.width,
        trackHeight: settings.height,
        trackFrameRate: settings.frameRate,
        appliedMaxBitrate: appliedParameters.encodings?.[0]?.maxBitrate || 0,
        appliedMaxFramerate: appliedParameters.encodings?.[0]?.maxFramerate || 0,
        appliedScaleResolutionDownBy: appliedParameters.encodings?.[0]?.scaleResolutionDownBy || 0,
        negotiatedCodec,
        framesEncoded: outbound?.framesEncoded || 0,
        averageEncodedFramesPerSecond: (outbound?.framesEncoded || 0) / mediaElapsedSeconds,
        outboundFramesPerSecond: outbound?.framesPerSecond || 0,
        qualityLimitationReason: outbound?.qualityLimitationReason || "",
        qualityLimitationResolutionChanges: outbound?.qualityLimitationResolutionChanges || 0,
        connectionState: receiverPc.connectionState
      };
    } finally {
      clearInterval(drawTimer);
      oscillator.stop();
      oscillator.disconnect();
      await audioContext.close();
      for (const mediaTrack of stream.getTracks()) mediaTrack.stop();
      senderPc.close();
      receiverPc.close();
      video.srcObject = null;
      video.remove();
    }
  })()`;
}

function dumpNativeOffer(tempDir) {
  const offerPath = join(tempDir, "native-screen-share-offer.sdp");
  const workspaceRoot = join(import.meta.dirname, "..", "..", "..");
  const result = spawnSync(
    ...nativeTestCommand("native_webrtc_sender_trickles_candidates_without_holding_the_offer"),
    {
      cwd: workspaceRoot,
      env: { ...process.env, EV_SCREEN_SHARE_NATIVE_OFFER_DUMP: offerPath },
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !existsSync(offerPath)) {
    throw new Error(`could not produce native screen share offer:\n${result.stderr || result.stdout}`);
  }
  return readFileSync(offerPath, "utf8");
}

function nativeOfferNegotiationExpression(offerSdp) {
  return `(async () => {
    const withTimeout = (promise, phase, timeoutMs = 4000) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(phase + " timed out")), timeoutMs))
    ]);
    const receiver = new RTCPeerConnection({ iceServers: [] });
    const phases = [];
    try {
      await withTimeout(
        receiver.setRemoteDescription({ type: "offer", sdp: ${JSON.stringify(offerSdp)} }),
        "setRemoteDescription(native offer)"
      );
      phases.push("remote-offer");
      const answer = await withTimeout(receiver.createAnswer(), "createAnswer(native offer)");
      phases.push("answer-created");
      await withTimeout(receiver.setLocalDescription(answer), "setLocalDescription(native answer)");
      phases.push("local-answer");
      const localAnswer = receiver.localDescription || answer;
      const videoLine = (localAnswer.sdp || "").split(/\\r?\\n/).find((line) => line.startsWith("m=video ")) || "";
      return {
        ok: !/^m=video\\s+0(?:\\s|$)/.test(videoLine) && receiver.signalingState === "stable",
        phases,
        videoLine,
        answerHasH264: /H264\\/90000/i.test(localAnswer.sdp || ""),
        signalingState: receiver.signalingState
      };
    } finally {
      receiver.close();
    }
  })()`;
}

function nativeMediaReceiverStartExpression(offerBundle, iceServers = []) {
  const description = offerBundle?.description ?? offerBundle;
  const candidates = Array.isArray(offerBundle?.candidates) ? offerBundle.candidates : [];
  const configuration = iceServers.length > 0
    ? { iceServers, iceTransportPolicy: "relay", bundlePolicy: "max-bundle" }
    : { iceServers: [] };
  return `(async () => {
    const previous = globalThis.__evNativeMediaReceiver;
    if (previous) {
      previous.pc.close();
      previous.video.remove();
    }
    const pc = new RTCPeerConnection(${JSON.stringify(configuration)});
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.style.width = "640px";
    video.style.height = "360px";
    video.style.display = "block";
    document.body.appendChild(video);
    const state = {
      pc,
      video,
      sync: ${process.env.EV_BENCH_SYNC === "1"} ? window.createScreenShareSyncProbe() : null,
      track: null,
      videoFrameCount: 0,
      videoFrameTimes: [],
      viewerStartedAt: performance.now(),
      firstFrameAt: undefined,
      firstCandidateAt: undefined,
      relayCandidateAt: undefined,
      iceCheckingAt: undefined,
      iceConnectedAt: undefined,
      dtlsConnectedAt: undefined,
      trackReceivedAt: undefined,
      playResolvedAt: undefined,
      playError: "",
      // Candidates are handed over after the answer, the way a real viewer
      // trickles them. Waiting for gathering before answering would make the
      // handshake slower than production and blame the network for it.
      gatheredCandidates: []
    };
    globalThis.__evNativeMediaReceiver = state;
    globalThis.__evNativeMediaGathering = () => ({
      done: pc.iceGatheringState === "complete",
      candidates: state.gatheredCandidates
    });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected" && state.dtlsConnectedAt === undefined) {
        state.dtlsConnectedAt = performance.now();
      }
    };
    // Where the first frame goes is decided long before the first frame: an
    // offer round trip, candidate gathering, ICE checks and DTLS. Timestamp the
    // steps so a slow first frame can be blamed on one of them instead of on
    // "the network".
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const now = performance.now();
      if (state.firstCandidateAt === undefined) state.firstCandidateAt = now;
      const type = String(event.candidate.type || "");
      if (type === "relay" && state.relayCandidateAt === undefined) {
        state.relayCandidateAt = now;
      }
      state.gatheredCandidates.push({
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      });
    };
    pc.oniceconnectionstatechange = () => {
      const now = performance.now();
      const next = pc.iceConnectionState;
      if ((next === "checking" || next === "connected" || next === "completed")
          && state.iceCheckingAt === undefined) {
        state.iceCheckingAt = now;
      }
      if ((next === "connected" || next === "completed") && state.iceConnectedAt === undefined) {
        state.iceConnectedAt = now;
      }
    };
    const countVideoFrame = (now, meta) => {
      state.sync?.frame(video, meta);
      if (state.firstFrameAt === undefined) state.firstFrameAt = now;
      state.videoFrameCount += 1;
      state.presentedFrames = meta.presentedFrames;
      state.videoFrameTimes.push(meta.expectedDisplayTime);
      video.requestVideoFrameCallback(countVideoFrame);
    };
    pc.ontrack = (event) => {
      if (event.track.kind === "audio" && state.sync) void state.sync.attach(event.track);
      if (event.track.kind !== "video") return;
      if (state.trackReceivedAt === undefined) state.trackReceivedAt = performance.now();
      try {
        if ("jitterBufferTarget" in event.receiver) {
          event.receiver.jitterBufferTarget = 60;
        } else if ("playoutDelayHint" in event.receiver) {
          event.receiver.playoutDelayHint = 0.06;
        }
      } catch {}
      state.track = event.track;
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      video.play().then(() => {
        if (state.playResolvedAt === undefined) state.playResolvedAt = performance.now();
        if (typeof video.requestVideoFrameCallback === "function") {
          video.requestVideoFrameCallback(countVideoFrame);
        }
      }).catch((error) => {
        state.playError = error && error.message ? error.message : String(error);
      });
    };
    await pc.setRemoteDescription(${JSON.stringify(description)});
    if (${JSON.stringify(process.env.EV_SCREEN_SHARE_BROWSER_BASELINE_ONLY === "1")}) {
      const transceiver = pc.getTransceivers().find(t => t.receiver.track.kind === "video");
      const baseline = RTCRtpReceiver.getCapabilities("video").codecs.filter(c =>
        c.mimeType.toLowerCase() === "video/h264" && /profile-level-id=42[ec]0/i.test(c.sdpFmtpLine)
        && c.sdpFmtpLine.includes("packetization-mode=1"));
      if (!baseline.length) throw new Error("Browser does not expose constrained baseline decoding");
      transceiver.setCodecPreferences(baseline);
    }
    for (const candidate of ${JSON.stringify(candidates)}) {
      await pc.addIceCandidate(candidate);
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const localDescription = pc.localDescription;
    // Hand the candidates over as individual signals, the way a real viewer
    // trickles them, and keep them out of the answer. Sending them inline in
    // the SDP would leave the native addIceCandidate path untested forever.
    const gathered = [];
    let currentMid = "0";
    let currentMLine = 0;
    let sawMediaSection = false;
    for (const line of (localDescription?.sdp || "").split(/\\r?\\n/)) {
      if (line.startsWith("m=")) {
        if (sawMediaSection) currentMLine += 1;
        sawMediaSection = true;
        continue;
      }
      if (line.startsWith("a=mid:")) {
        currentMid = line.slice("a=mid:".length).trim();
        continue;
      }
      if (line.startsWith("a=candidate:")) {
        gathered.push({ candidate: line.slice("a=".length), sdpMid: currentMid, sdpMLineIndex: currentMLine });
      }
    }
    const strippedSdp = (localDescription?.sdp || "")
      .split(/\\r?\\n/)
      .filter((line) => !line.startsWith("a=candidate:"))
      .join("\\r\\n");
    return {
      description: localDescription
        ? { type: localDescription.type, sdp: strippedSdp }
        : null,
      candidates: gathered,
      signalingState: pc.signalingState,
      iceGatheringState: pc.iceGatheringState
    };
  })()`;
}

function nativeReceiverGatheringExpression() {
  return `(() => {
    const gather = globalThis.__evNativeMediaGathering;
    if (typeof gather !== "function") return { done: true, candidates: [] };
    return gather();
  })()`;
}

function nativeMediaReceiverStatsExpression(resetWindow = false) {
  return `(async () => {
    const state = globalThis.__evNativeMediaReceiver;
    if (!state) return { error: "receiver missing" };
    const stats = await state.pc.getStats();
    let bytesReceived = 0;
    let packetsReceived = 0;
    let framesDecoded = 0;
    let framesDropped = 0;
    let videoNacks = 0;
    let videoPlis = 0;
    let videoRetransmissions = 0;
    let transport = null;
    let candidatePair = null;
    let pairCount = 0;
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
        bytesReceived += report.bytesReceived || 0;
        packetsReceived += report.packetsReceived || 0;
        framesDecoded += report.framesDecoded || 0;
        framesDropped += report.framesDropped || 0;
        videoNacks += report.nackCount || 0;
        videoPlis += report.pliCount || 0;
        videoRetransmissions += report.retransmittedPacketsReceived || 0;
      }
      if (report.type === "transport") {
        transport = {
          dtlsState: report.dtlsState,
          iceRole: report.iceRole,
          selectedCandidatePairId: report.selectedCandidatePairId,
          bytesReceived: report.bytesReceived,
          bytesSent: report.bytesSent,
          dtlsCipher: report.dtlsCipher,
          srtpCipher: report.srtpCipher,
          tlsVersion: report.tlsVersion
        };
      }
      if (report.type === "candidate-pair") pairCount += 1;
      if (report.type === "candidate-pair" && report.nominated) {
        candidatePair = {
          state: report.state,
          nominated: report.nominated,
          bytesReceived: report.bytesReceived,
          bytesSent: report.bytesSent,
          packetsReceived: report.packetsReceived,
          packetsSent: report.packetsSent,
          currentRoundTripTime: report.currentRoundTripTime,
          localCandidateId: report.localCandidateId,
          remoteCandidateId: report.remoteCandidateId
        };
      }
    });
    candidatePair = stats.get(transport?.selectedCandidatePairId) ?? candidatePair;
    const localCandidate = candidatePair ? stats.get(candidatePair.localCandidateId) : null;
    const remoteCandidate = candidatePair ? stats.get(candidatePair.remoteCandidateId) : null;
    if (${Boolean(resetWindow)}) {
      state.decoderBaseline = undefined;
      state.videoFrameTimes = [];
    }
    const frameIntervals = state.videoFrameTimes
      .slice(1)
      .map((time, index) => time - state.videoFrameTimes[index]);
    const sortedIntervals = [...frameIntervals].sort((left, right) => left - right);
    const decoderSampleTime = performance.now();
    if (!state.decoderBaseline && framesDecoded > 0) {
      state.decoderBaseline = { framesDecoded, time: decoderSampleTime, presentedFrames: state.presentedFrames || 0 };
    }
    const decodedFrameWindow = state.decoderBaseline
      ? framesDecoded - state.decoderBaseline.framesDecoded
      : 0;
    const decoderWindowMs = state.decoderBaseline
      ? decoderSampleTime - state.decoderBaseline.time
      : 0;
    const measuredDecoderFps = decoderWindowMs > 0
      ? (decodedFrameWindow * 1000) / decoderWindowMs
      : 0;
    return {
      connectionState: state.pc.connectionState,
      iceConnectionState: state.pc.iceConnectionState,
      signalingState: state.pc.signalingState,
      bytesReceived,
      packetsReceived,
      pairCount,
      candidatePairState: candidatePair ? candidatePair.state : "",
      candidatePairBytes: candidatePair ? candidatePair.bytesReceived : -1,
      framesDecoded,
      framesDropped,
      videoNacks, videoPlis, videoRetransmissions,
      decodedFps: measuredDecoderFps,
      trackState: state.track && state.track.readyState,
      videoReadyState: state.video.readyState,
      videoNetworkState: state.video.networkState,
      videoWidth: state.video.videoWidth,
      videoHeight: state.video.videoHeight,
      videoCurrentTime: state.video.currentTime,
      videoPaused: state.video.paused,
      videoFrameCount: state.videoFrameCount,
      firstFrameMs: state.firstFrameAt === undefined
        ? null
        : Math.round(state.firstFrameAt - state.viewerStartedAt),
      // Split the wait into its parts so a regression points at one step.
      firstCandidateMs: state.firstCandidateAt === undefined
        ? null
        : Math.round(state.firstCandidateAt - state.viewerStartedAt),
      relayCandidateMs: state.relayCandidateAt === undefined
        ? null
        : Math.round(state.relayCandidateAt - state.viewerStartedAt),
      iceCheckingMs: state.iceCheckingAt === undefined
        ? null
        : Math.round(state.iceCheckingAt - state.viewerStartedAt),
      iceConnectedMs: state.iceConnectedAt === undefined
        ? null
        : Math.round(state.iceConnectedAt - state.viewerStartedAt),
      dtlsConnectedMs: state.dtlsConnectedAt === undefined
        ? null
        : Math.round(state.dtlsConnectedAt - state.viewerStartedAt),
      trackReceivedMs: state.trackReceivedAt === undefined
        ? null
        : Math.round(state.trackReceivedAt - state.viewerStartedAt),
      playResolvedMs: state.playResolvedAt === undefined
        ? null
        : Math.round(state.playResolvedAt - state.viewerStartedAt),
      measuredSeconds: decoderWindowMs / 1000,
      sync: state.sync?.stats(),
      renderedFps: decoderWindowMs > 0
        ? ((state.presentedFrames - state.decoderBaseline.presentedFrames) * 1000) / decoderWindowMs
        : 0,
      maxFrameGapMs: frameIntervals.length > 0 ? Math.max(...frameIntervals) : 0,
      p95FrameGapMs: sortedIntervals.length > 0
        ? sortedIntervals[Math.min(sortedIntervals.length - 1, Math.floor(sortedIntervals.length * 0.95))]
        : 0,
      p99FrameGapMs: sortedIntervals.length > 0
        ? sortedIntervals[Math.ceil(sortedIntervals.length * 0.99) - 1] : null,
      playError: state.playError,
      transport,
      candidatePair,
      localCandidateType: localCandidate && localCandidate.candidateType,
      localCandidateProtocol: localCandidate && localCandidate.protocol,
      remoteCandidateType: remoteCandidate && remoteCandidate.candidateType,
      remoteCandidateProtocol: remoteCandidate && remoteCandidate.protocol,
      // The only live negotiation of our screen-share audio track: Chrome parses
      // the fmtp we advertise, so a broken Opus line has to fail here rather
      // than only in the source-comparison test.
      audioAccepted: (() => {
        const sdp = state.pc.remoteDescription && state.pc.remoteDescription.sdp;
        if (!sdp) return "no remote description";
        const audioLine = sdp.split(/\\r?\\n/).find((line) => line.startsWith("m=audio ")) || "";
        if (!audioLine || /^m=audio\\s+0(?:\\s|$)/.test(audioLine)) return "audio m-line rejected";
        const fmtp = (sdp.match(/a=fmtp:\\d+ ([^\\r\\n]*)/gi) || [])
          .map((line) => line.toLowerCase())
          .find((line) => line.includes("maxaveragebitrate")) || "";
        const audioIndex = sdp.split(/\\r?\\n/).indexOf(audioLine);
        const audioSection = sdp.split(/\\r?\\n/).slice(audioIndex, audioIndex + 8).join(" | ");
        if (!fmtp.includes("maxaveragebitrate=160000")) return \`fmtp missing 160000: \${fmtp} :: \${audioSection}\`;
        if (!fmtp.includes("stereo=1")) return \`fmtp missing stereo: \${fmtp}\`;
        return "ok";
      })(),
      // Same failure mode as the audio fmtp: the line in the offer comes from
      // the codec the media engine registered, not from the track capability.
      // A default H.264 entry would advertise a profile and level the encoder
      // never uses.
      videoAccepted: (() => {
        const sdp = state.pc.remoteDescription && state.pc.remoteDescription.sdp;
        if (!sdp) return "no remote description";
        const videoLine = sdp.split(/\\r?\\n/).find((line) => line.startsWith("m=video ")) || "";
        if (!videoLine || /^m=video\\s+0(?:\\s|$)/.test(videoLine)) return "video m-line rejected";
        const inbound = [...stats.values()].find((r) => r.type === "inbound-rtp" && (r.kind === "video" || r.mediaType === "video"));
        const codec = inbound && stats.get(inbound.codecId);
        if (codec?.mimeType?.toLowerCase() !== "video/h264") return "inbound track has no negotiated H.264 codec";
        const payloadType = codec.payloadType;
        const fmtpFor = (desc) => desc.split(/\\r?\\n/).find((line) => line.startsWith("a=fmtp:" + payloadType + " "))?.toLowerCase() ?? "";
        const fmtp = fmtpFor(sdp);
        const accepted = fmtpFor(state.pc.localDescription?.sdp || "");
        if (!accepted.includes("packetization-mode=1")) return "answer rejected H.264 packetization";
        if (!fmtp) return "no H.264 fmtp";
        const profile = (fmtp.match(/profile-level-id=([0-9a-f]{6})(?:;|$)/i) || [])[1];
        if (!profile) return "missing encoder profile-level-id";
        if (!fmtp.includes("packetization-mode=1")) return \`missing packetization-mode=1: \${fmtp}\`;
        // PLI is how a viewer recovers from a lost keyframe and how the sender
        // learns to force one; REMB is what the native bitrate controller reads.
        // Both only exist if we advertised the feedback for the negotiated
        // payload type, so check the wire instead of the capability struct.
        const feedback = (sdp.match(new RegExp("a=rtcp-fb:" + payloadType + " [^\\\\r\\\\n]*", "gi")) || [])
          .map((line) => line.toLowerCase());
        const hasFeedback = (needle) => feedback.some((line) => line.includes(needle));
        if (!(hasFeedback("nack") && hasFeedback("pli"))) {
          return \`missing nack pli for payload \${payloadType}: \${feedback.join(" | ")}\`;
        }
        if (!hasFeedback("goog-remb")) {
          return \`missing goog-remb for payload \${payloadType}: \${feedback.join(" | ")}\`;
        }
        return profile;
      })()
    };
  })()`;
}

function closeNativeMediaReceiverExpression() {
  return `(() => {
    const state = globalThis.__evNativeMediaReceiver;
    if (!state) return;
    state.pc.close();
    state.sync?.close();
    state.video.srcObject = null;
    state.video.remove();
    delete globalThis.__evNativeMediaReceiver;
  })()`;
}

// The standalone relay fixture controls the lossy segment in the actual UDP
// path. Start only after decode and check progress again with the path restored.
async function verifyRelayRecovery(webSocketUrl, profile, before) {
  async function setImpairment(enabled) {
    return await new Promise((resolve, reject) => {
      const onAck = (message) => {
        if (message?.type !== "relay-network-ack") return;
        clearTimeout(timeout);
        process.off("message", onAck);
        resolve(message);
      };
      const timeout = setTimeout(() => {
        process.off("message", onAck);
        reject(new Error("Relay fixture did not acknowledge a network change"));
      }, 2000);
      process.on("message", onAck);
      process.send({ type: "relay-network", enabled });
    });
  }
  await setImpairment(true);
  let impaired;
  let network;
  try {
    await new Promise(resolve => setTimeout(resolve, 4000));
    impaired = await evaluateInBrowser(webSocketUrl, nativeMediaReceiverStatsExpression());
  } finally {
    network = await setImpairment(false);
  }
  const impairedFrames = impaired.framesDecoded - before.framesDecoded;
  const nacks = impaired.videoNacks - before.videoNacks;
  if (network.dropped < 1 || nacks < 1 || impairedFrames < profile.frameRate) {
    throw new Error(`TURN impairment did not exercise active decoding and RTCP feedback: ${JSON.stringify({ network, nacks, impairedFrames })}`);
  }
  const start = performance.now();
  let recovered;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    recovered = await evaluateInBrowser(webSocketUrl, nativeMediaReceiverStatsExpression());
  } while (recovered.videoFrameCount < impaired.videoFrameCount + 3 && performance.now() - start < 1500);
  if (recovered.videoFrameCount < impaired.videoFrameCount + 3 || recovered.connectionState !== "connected") {
    throw new Error("Rendering failed to recover within 1.5 s on the same peer connection");
  }
  console.log(`ok - TURN recovery: delayed ${network.examined - network.dropped}, dropped ${network.dropped}/${network.examined} video packets, receiver NACKs +${nacks}, PLIs +${impaired.videoPlis - before.videoPlis}, ${impairedFrames} decoded frames during loss; 3 further rendered frames within ${Math.round(performance.now() - start)} ms`);
  return await evaluateInBrowser(webSocketUrl, nativeMediaReceiverStatsExpression(true));
}

function startNativeMediaHarness(tempDir, profile, iceServers = []) {
  const paths = {
    offer: join(tempDir, "browser-media-offer.json"),
    answer: join(tempDir, "browser-media-answer.json"),
    candidates: join(tempDir, "browser-media-candidates.json"),
    stop: join(tempDir, "browser-media-stop"),
    result: join(tempDir, "browser-media-result.json")
  };
  const workspaceRoot = join(import.meta.dirname, "..", "..", "..");
  const child = spawn(
    ...nativeTestCommand("native_webrtc_sender_browser_media_harness"),
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        EV_SCREEN_SHARE_BROWSER_OFFER_PATH: paths.offer,
        EV_SCREEN_SHARE_BROWSER_ANSWER_PATH: paths.answer,
        EV_SCREEN_SHARE_BROWSER_CANDIDATES_PATH: paths.candidates,
        EV_SCREEN_SHARE_BROWSER_STOP_PATH: paths.stop,
        EV_SCREEN_SHARE_BROWSER_RESULT_PATH: paths.result,
        EV_SCREEN_SHARE_BROWSER_WIDTH: String(profile.width),
        EV_SCREEN_SHARE_BROWSER_HEIGHT: String(profile.height),
        EV_SCREEN_SHARE_BROWSER_FRAME_RATE: String(profile.frameRate),
        EV_SCREEN_SHARE_BROWSER_VIEWER_DELAY_MS: "1000",
        EV_SCREEN_SHARE_BROWSER_ICE_SERVERS: iceServers.length > 0 ? JSON.stringify(iceServers) : "",
        EV_SCREEN_SHARE_BROWSER_FORCE_RELAY: iceServers.length > 0 ? "1" : "0",
        EV_SCREEN_SHARE_BROWSER_TARGET_BITRATE_BPS: iceServers.length > 0
          ? (process.env.EV_SCREEN_SHARE_RELAY_TARGET_BITRATE_BPS || "22118400")
          : ""
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (output.stderr += String(chunk)));
  return { child, output, paths };
}

async function waitForHarnessFile(harness, path, timeoutMS = 120000) {
  const deadline = Date.now() + timeoutMS;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (harness.child.exitCode !== null) {
      throw new Error(`native browser media harness exited early:\n${harness.output.stderr}${harness.output.stdout}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`native browser media harness did not create ${path}`);
}

function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), "utf8");
  renameSync(temporaryPath, path);
}

function compactNativeResult(result) {
  if (!result || typeof result !== "object") return result;
  const { previewDataUrl: _previewDataUrl, ...compact } = result;
  return compact;
}

function summarizeDescription(description) {
  const lines = String(description?.sdp ?? "")
    .split(/\r?\n/)
    .filter((line) =>
      /^(m=(audio|video)|a=(setup|rtpmap|fmtp):)/.test(line)
    );
  return { type: description?.type, lines };
}

function waitForChild(child, timeoutMS = 10000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("native browser media harness did not stop")), timeoutMS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function verifyNativeMediaInBrowser(webSocketUrl, tempDir, profile, iceServers = [], sourceSocket) {
  const harness = startNativeMediaHarness(tempDir, profile, iceServers);
  let latestStats = null;
  let failure = null;
  let nativeResult = null;
  let offer = null;
  let answer = null;
  const sourceSamples = [];
  const trace = [];
  async function markWindow(index) {
    writeFileSync(harness.paths.stop + "." + index + ".request", "");
    if (sourceSocket) sourceSamples.push(await evaluateInBrowser(sourceSocket,
      "({ time: performance.now(), frames: currentSource.count })"));
  }
  try {
    await waitForHarnessFile(harness, harness.paths.offer);
    const offerBundle = JSON.parse(readFileSync(harness.paths.offer, "utf8"));
    offer = offerBundle.description ?? offerBundle;
    const setup = await evaluateInBrowser(
      webSocketUrl,
      nativeMediaReceiverStartExpression(offerBundle, iceServers)
    );
    if (!setup?.description || setup.signalingState !== "stable") {
      throw new Error(`browser media receiver did not create an answer: ${JSON.stringify(setup)}`);
    }
    answer = setup.description;
    writeJsonAtomic(harness.paths.answer, answer);
    // The answer goes out first, candidates follow — the same order a real
    // viewer produces when it trickles instead of waiting for gathering.
    // Publish each batch as it appears: waiting for `complete` used to delay the
    // handoff by 200-300 ms, which Pion spent without a remote candidate (and
    // Chrome spent waiting for a DTLS peer that had not started listening).
    let gathered = setup.candidates ?? [];
    let published = 0;
    const gatherDeadline = Date.now() + 6000;
    while (Date.now() < gatherDeadline) {
      const progress = await evaluateInBrowser(webSocketUrl, nativeReceiverGatheringExpression());
      if (Array.isArray(progress?.candidates) && progress.candidates.length > published) {
        gathered = progress.candidates;
        published = gathered.length;
        writeJsonAtomic(harness.paths.candidates, gathered);
      }
      if (progress?.done) break;
      // Poll tightly: a real viewer's candidates reach the peer in milliseconds,
      // and a slow handoff here would inflate the measured DTLS time.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeJsonAtomic(harness.paths.candidates, gathered);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      latestStats = await evaluateInBrowser(webSocketUrl, nativeMediaReceiverStatsExpression());
      if (
        latestStats.bytesReceived > 0 &&
        latestStats.packetsReceived > 0 &&
        latestStats.framesDecoded > 0 &&
        latestStats.videoWidth > 0 &&
        latestStats.videoHeight > 0 &&
        latestStats.videoFrameCount > 0
      ) {
        break;
      }
      if (harness.child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (
      !latestStats ||
      latestStats.bytesReceived <= 0 ||
      latestStats.framesDecoded <= 0 ||
      latestStats.videoWidth <= 0 ||
      latestStats.videoFrameCount <= 0
    ) {
      throw new Error(`Chromium did not decode/render native RTP: ${JSON.stringify(latestStats)}`);
    }

    const controlledWindow = process.env.EV_BENCH_NATIVE_WINDOW === "1";
    if (process.env.EV_SCREEN_SHARE_RELAY_IMPAIR === "1") {
      latestStats = await verifyRelayRecovery(webSocketUrl, profile, latestStats);
    }
    const sustainedSeconds = controlledWindow ? Number(process.env.EV_BENCH_SECONDS ?? 10) : iceServers.length > 0 ? 10 : 2;
    if (!Number.isInteger(sustainedSeconds) || sustainedSeconds < 2 || sustainedSeconds > 600) {
      throw new Error("Use a 2–600 second measurement window");
    }
    if (controlledWindow) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await markWindow(0);
      latestStats = await evaluateInBrowser(webSocketUrl, nativeMediaReceiverStatsExpression(true));
    }
    const recoveryStart = process.env.EV_SCREEN_SHARE_RELAY_IMPAIR === "1" ? latestStats.videoFrameCount : 0;
    const targetFrameCount = recoveryStart + profile.frameRate * sustainedSeconds;
    const cadenceDeadline = Date.now() + (controlledWindow ? sustainedSeconds * 1000 : iceServers.length > 0 ? 15000 : 5000);
    let nextTrace = Date.now();
    while (Date.now() < cadenceDeadline && (controlledWindow || latestStats.videoFrameCount < targetFrameCount)) {
      await new Promise((resolve) => setTimeout(resolve, controlledWindow ? 750 : 200));
      latestStats = await evaluateInBrowser(webSocketUrl, nativeMediaReceiverStatsExpression());
      if (sourceSocket && process.env.EV_BENCH_TRACE === "1" && Date.now() >= nextTrace) {
        nextTrace += 1000;
        const sourceFrames = await evaluateInBrowser(sourceSocket, "currentSource.count");
        trace.push({ wallMs: Date.now(), sourceFrames, decoded: latestStats.framesDecoded,
          packets: latestStats.packetsReceived, presentedCallbacks: latestStats.videoFrameCount });
      }
    }
    if (controlledWindow) await markWindow(1);
    const minimumFrameCount = profile.realCapture
      ? Math.max(10, Math.min(30, Math.floor(profile.frameRate / 4)))
      : profile.frameRate;
    if (latestStats.audioAccepted !== "ok") {
      throw new Error(
        `Chromium did not accept the native screen-share audio track: ${latestStats.audioAccepted}`
      );
    }
    if (process.env.EV_BENCH_SYNC === "1" && !(latestStats.sync?.matched >= 2)) {
      throw new Error("Missing matched decoded flashes and clicks: " + JSON.stringify(latestStats.sync));
    }
    if (latestStats.videoFrameCount < minimumFrameCount) {
      throw new Error(`Chromium received too few continuous frames: ${JSON.stringify(latestStats)}`);
    }
    const minimumDecodedFps = profile.realCapture
      ? Math.min(12, profile.frameRate * 0.2)
      : profile.frameRate * 0.8;
    const compositorTargetFps = Math.min(profile.frameRate, 60);
    const minimumRenderedFps = controlledWindow && profile.frameRate >= 60
      ? 55 : profile.realCapture ? 10 : compositorTargetFps * 0.8;
    const maximumP95GapMs = profile.realCapture ? 250 : Math.max(50, 3000 / compositorTargetFps);
    const maximumFrameGapMs = profile.realCapture ? 1000 : Math.max(150, 6000 / compositorTargetFps);
    if (
      latestStats.videoWidth !== profile.width ||
      latestStats.videoHeight !== profile.height ||
      latestStats.decodedFps < minimumDecodedFps ||
      latestStats.renderedFps < minimumRenderedFps ||
      latestStats.p95FrameGapMs > maximumP95GapMs ||
      latestStats.maxFrameGapMs > maximumFrameGapMs
    ) {
      throw new Error(`Chromium screen share cadence is unstable: ${JSON.stringify(latestStats)}`);
    }
    if (iceServers.length > 0 && (
      latestStats.localCandidateType !== "relay" || latestStats.remoteCandidateType !== "relay"
    )) {
      throw new Error(`native screen share did not use TURN relay candidates: ${JSON.stringify(latestStats)}`);
    }
    if (!/^[a-f0-9]{6}$/i.test(latestStats.videoAccepted ?? "")) {
      throw new Error(
        `Chromium was offered the wrong H.264 video codec: ${latestStats.videoAccepted}`
      );
    }
    console.log(
      `ok - Chromium received smooth native RTP: ${latestStats.videoWidth}x${latestStats.videoHeight}, first frame ${latestStats.firstFrameMs} ms after the viewer started (candidate ${latestStats.firstCandidateMs} ms, relay ${latestStats.relayCandidateMs} ms, ICE connected ${latestStats.iceConnectedMs} ms, DTLS ${latestStats.dtlsConnectedMs} ms, track ${latestStats.trackReceivedMs} ms, play ${latestStats.playResolvedMs} ms), ${latestStats.framesDecoded} decoded frames, ${latestStats.decodedFps.toFixed(1)} decode FPS, ${latestStats.renderedFps.toFixed(1)} display FPS, p95 gap ${latestStats.p95FrameGapMs.toFixed(1)} ms, max gap ${latestStats.maxFrameGapMs.toFixed(1)} ms, ${latestStats.bytesReceived} bytes, pair ${latestStats.pairCount}/${latestStats.candidatePairState}/${latestStats.candidatePairBytes}, audio ${latestStats.audioAccepted}, video ${latestStats.videoAccepted}`
    );
  } catch (caught) {
    failure = caught;
  } finally {
    writeFileSync(harness.paths.stop, "stop", "utf8");
    const exitCode = await waitForChild(harness.child).catch(() => null);
    // The harness mirrors Pion's dtls/ice log to stderr, which is only printed on
    // failure. Dumping it lets a timing investigation read the handshake timeline.
    const dumpPath = String(process.env.EV_SCREEN_SHARE_BROWSER_DUMP_LOG ?? "").trim();
    if (dumpPath) {
      writeFileSync(dumpPath, harness.output.stderr, "utf8");
    }
    await evaluateInBrowser(webSocketUrl, closeNativeMediaReceiverExpression()).catch(() => undefined);
    if (existsSync(harness.paths.result)) {
      nativeResult = JSON.parse(readFileSync(harness.paths.result, "utf8"));
    }
    if (exitCode === null || exitCode !== 0) {
      failure = new Error(`native browser media harness failed:\n${harness.output.stderr}${harness.output.stdout}`);
    }
  }
  if (process.env.EV_BENCH_REPORT) {
    const fields = ["sync", "measuredSeconds", "decodedFps", "renderedFps", "p95FrameGapMs", "p99FrameGapMs", "maxFrameGapMs",
      "bytesReceived", "framesDecoded", "framesDropped", "videoFrameCount", "firstFrameMs", "videoWidth",
      "videoHeight", "localCandidateType", "remoteCandidateType", "videoAccepted", "audioAccepted"];
    const receiver = Object.fromEntries(fields.map(key => [key, latestStats?.[key] ?? null]));
    const senderSamples = [0, 1].map(index => {
      const path = harness.paths.stop + "." + index + ".json";
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    });
    const [srcStart, srcEnd] = sourceSamples;
    const sourceDrawFPS = srcEnd && srcEnd.time > srcStart.time
      ? 1000 * (srcEnd.frames - srcStart.frames) / (srcEnd.time - srcStart.time) : null;
    writeFileSync(process.env.EV_BENCH_REPORT, JSON.stringify({
      profile, source: process.env.EV_BENCH_NATIVE_WINDOW === "1" ? process.env.EV_BENCH_SCENE || "motion"
        : profile.realCapture ? "desktop" : "synthetic",
      sourceDrawFPS, receiver, senderSamples, ...(trace.length ? { trace } : {}), sender: compactNativeResult(nativeResult)
    }, null, 2) + "\n");
  }
  if (failure) {
    throw new Error(
      `${failure instanceof Error ? failure.message : String(failure)}` +
        `\nNative sender: ${JSON.stringify(compactNativeResult(nativeResult))}` +
        `\nOffer: ${JSON.stringify(summarizeDescription(offer))}` +
        `\nAnswer: ${JSON.stringify(summarizeDescription(answer))}` +
      `\nRust output:\n${harness.output.stderr}${harness.output.stdout}`
    );
  }
  // This value is read independently from the emitted Annex B SPS, including
  // the actual hardware constraint bits and level. Decoding alone would not
  // catch advertising a different H.264 profile from the one sent.
  const compatibility = nativeResult?.viewerLayers?.mem_browser === "compatibility";
  const emitted = compatibility ? nativeResult?.encodedCompatibilityProfileLevelId : nativeResult?.encodedProfileLevelId;
  const advertised = latestStats.videoAccepted;
  const isConstrainedBaseline = (id) => {
    if (!/^[0-9a-f]{6}$/i.test(id || "")) return false;
    const profile = Number.parseInt(id.slice(0, 2), 16);
    const flags = Number.parseInt(id.slice(2, 4), 16);
    return (profile === 0x42 && (flags & 0x4f) === 0x40) || (profile === 0x4d && (flags & 0x8f) === 0x80) || (profile === 0x58 && (flags & 0xcf) === 0xc0);
  };
  const compatibleBaseline = isConstrainedBaseline(emitted) && isConstrainedBaseline(advertised) &&
    Number.parseInt(emitted.slice(4), 16) <= Number.parseInt(advertised.slice(4), 16);
  if (process.env.EV_SCREEN_SHARE_BROWSER_BASELINE_ONLY === "1" && !compatibleBaseline) {
    throw new Error("Constrained-baseline-only viewer did not receive a compatible encode");
  }
  if (!emitted || (emitted !== advertised && !compatibleBaseline)) {
    throw new Error(`advertised H.264 ${advertised}, encoded SPS ${emitted}`);
  }
  // The sender reports which path each viewer ended up on. Assert it here so the
  // field is covered by a real connection instead of only by unit tests: a
  // loopback run gathers host candidates, a TURN-configured run must say relay.
  const expectedViewerPath = iceServers.length > 0 ? "relay" : "direct";
  const reportedViewerPath = nativeResult?.viewerPaths?.mem_browser;
  if (reportedViewerPath !== expectedViewerPath) {
    throw new Error(
      `native sender reported viewer path ${JSON.stringify(nativeResult?.viewerPaths)} ` +
        `while this connection should be ${expectedViewerPath}`
    );
  }

  // A relayed share waits for the ICE agent before it may nominate a relay pair;
  // webrtc-ice defaults that wait to two seconds, which pushed the first frame to
  // ~2.35 s until it was lowered. Keep a ceiling here so losing the override is a
  // failing gate instead of a vague "it feels slow".
  if (iceServers.length > 0) {
    const firstFrameMs = Number(latestStats?.firstFrameMs);
    const ceilingMs = 2000;
    if (!Number.isFinite(firstFrameMs) || firstFrameMs >= ceilingMs) {
      throw new Error(
        `relayed viewer took ${latestStats?.firstFrameMs} ms to the first frame, ` +
          `expected under ${ceilingMs} ms (the ICE relay nomination wait is probably back at its 2 s default)`
      );
    }
  }

  // These counters are what the pipeline health checks and the sharer's panel
  // read. A regression in frame delivery should fail here instead of quietly
  // producing a plausible-looking log line.
  const nativeInvariants = [
    // A real compositor can deliver faster than the user's selected capture
    // cadence. Intentional frame throttling is included in droppedFrames.
    ...(!profile.realCapture ? [["droppedFrames", 0]] : []),
    ["sampleWriteErrorCount", 0],
    ["nativePeerConnectionState", "connected"]
  ];
  for (const [field, expected] of nativeInvariants) {
    if (nativeResult?.[field] !== expected) {
      throw new Error(
        `native sender reported ${field}=${JSON.stringify(nativeResult?.[field])}, expected ${JSON.stringify(expected)}: ` +
          `${JSON.stringify(compactNativeResult(nativeResult))}`
      );
    }
  }
  if (nativeResult?.lastError) {
    throw new Error(`native sender kept an error: ${nativeResult.lastError}`);
  }
  if (!(nativeResult?.encodedFrames > 0)) {
    throw new Error(`native sender encoded no frames: ${JSON.stringify(compactNativeResult(nativeResult))}`);
  }

  console.log(`ok - native sender status: ${JSON.stringify(compactNativeResult(nativeResult))}`);
}

async function stopBrowser(child, port) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let socket;
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1000) });
    const { webSocketDebuggerUrl } = await response.json();
    socket = new WebSocket(webSocketDebuggerUrl);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })), { once: true });
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
  } catch {
    // If the DevTools endpoint already died, stop the owned process tree.
  } finally {
    socket?.close();
  }
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
  }
}

const browser = findBrowser();
if (!browser) {
  console.log("skip - no Chrome or Edge executable found");
  process.exit(0);
}

const browserTestArguments = process.argv.slice(2);
const meshBenchmark = browserTestArguments.includes("--benchmark");
const webOnly = browserTestArguments.includes("--web-only");
const mediaArguments = browserTestArguments.filter((argument) => argument !== "--web-only" && argument !== "--benchmark");
const profileLevelId = mediaArguments[0] || "42e020";
const mediaProfile = {
  width: Math.max(2, Number.parseInt(mediaArguments[1] || "1280", 10) || 1280),
  height: Math.max(2, Number.parseInt(mediaArguments[2] || "720", 10) || 720),
  frameRate: Math.max(1, Number.parseInt(mediaArguments[3] || "30", 10) || 30),
  realCapture: process.env.EV_SCREEN_SHARE_BROWSER_REAL_CAPTURE === "1"
};
const syncTest = process.env.EV_BENCH_SYNC === "1";
if (syncTest) {
  if (process.env.EV_BENCH_NATIVE_WINDOW !== "1") throw new Error("EV_BENCH_SYNC requires the isolated native fixture window");
  process.env.EV_BENCH_SCENE = "sync";
}
const relayBaseUrl = String(process.env.EV_SCREEN_SHARE_RELAY_DIAGNOSTIC_URL ?? "").replace(/\/$/, "");
let relayMember = null;
let relayIceServers = [];
// A local relay can be described inline, so the relay path is testable without
// standing up ev-server just to read /api/v1/rtc-config.
const inlineIceServers = String(process.env.EV_SCREEN_SHARE_BROWSER_ICE_SERVERS ?? "").trim();
if (inlineIceServers && !relayBaseUrl) {
  try {
    relayIceServers = JSON.parse(inlineIceServers);
  } catch (error) {
    throw new Error(`EV_SCREEN_SHARE_BROWSER_ICE_SERVERS must be JSON: ${error}`);
  }
  if (!Array.isArray(relayIceServers) || relayIceServers.length === 0) {
    throw new Error("EV_SCREEN_SHARE_BROWSER_ICE_SERVERS must be a non-empty array");
  }
}
if (relayBaseUrl) {
  try {
    relayMember = await connectRelayDiagnosticMember(relayBaseUrl);
    relayIceServers = await loadRelayIceServers(relayBaseUrl, relayMember.session_token);
    if (!relayIceServers.some((server) => server.urls?.some((url) => String(url).startsWith("turn:")))) {
      throw new Error("relay diagnostic server returned no TURN URL");
    }
  } catch (error) {
    if (relayMember?.session_token) {
      await removeRelayDiagnosticMember(relayBaseUrl, relayMember.session_token);
    }
    throw error;
  }
}
const profilePath = mkdtempSync(join(tmpdir(), "ev-screen-share-browser-"));
const port = await reservePort();
let sourceServer, benchmarkPage;
if (meshBenchmark || process.env.EV_BENCH_NATIVE_WINDOW === "1") {
  // A trustworthy non-opaque origin is required for the AudioWorklet probe.
  // Serve only the two owned fixture assets on loopback.
  const files = new Map(["html", "js"].map(ext => ["/screen-share-benchmark." + ext, {
    mime: ext === "js" ? "text/javascript" : "text/html",
    bytes: readFileSync(join(import.meta.dirname, "screen-share-benchmark." + ext))
  }]));
  sourceServer = createHttpServer((request, response) => {
    const file = files.get(request.url);
    if (!file || request.method !== "GET") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": file.mime + "; charset=utf-8", "Cache-Control": "no-store" });
    response.end(file.bytes);
  });
  await new Promise((resolve, reject) => {
    sourceServer.once("error", reject);
    sourceServer.listen(0, "127.0.0.1", resolve);
  });
  sourceServer.unref();
  benchmarkPage = new URL("http://127.0.0.1:" + sourceServer.address().port + "/screen-share-benchmark.html");
}
const child = spawn(
  browser,
  [
    "--headless=new",
    ...(meshBenchmark || process.env.EV_SCREEN_SHARE_BROWSER_GPU === "1" ? [] : ["--disable-gpu"]),
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-component-update",
    "--disable-extensions",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profilePath}`,
    meshBenchmark || syncTest ? benchmarkPage.href : "about:blank"
  ],
  { stdio: "ignore", windowsHide: true }
);

async function runMeshBenchmark(webSocketUrl) {
  const { resolveScreenShareBitrateBps } = await import("../src/lib/screenShareSettings.ts");
  const options = {
    width: mediaProfile.width, height: mediaProfile.height, fps: mediaProfile.frameRate,
    viewers: Number(process.env.EV_BENCH_VIEWERS ?? 1),
    seconds: Number(process.env.EV_BENCH_SECONDS ?? 15),
    scene: process.env.EV_BENCH_SCENE || "motion",
    quality: process.env.EV_BENCH_QUALITY === "1",
    iceServers: relayIceServers
  };
  options.bitrate = resolveScreenShareBitrateBps("auto", options.width, options.height, options.fps,
    ["text", "desktop"].includes(options.scene) ? "detail" : "motion");
  const clipFile = process.env.EV_BENCH_CLIP;
  if (clipFile && !existsSync(clipFile)) throw new Error("EV_BENCH_CLIP does not exist");
  const result = await evaluateInBrowser(webSocketUrl,
    `window.runScreenShareBenchmark(${JSON.stringify(options)})`, clipFile);
  console.log(JSON.stringify(result));
  if (process.env.EV_BENCH_REPORT) {
    writeFileSync(process.env.EV_BENCH_REPORT, JSON.stringify(result, null, 2) + "\n");
  }
  if (!result.ok) throw new Error("Incomplete benchmark; inspect per-viewer delivery, selected path and matched quality frames");
}

async function runInterop(webSocketUrl) {
  const result = await evaluateInBrowser(webSocketUrl, browserNegotiationExpression(profileLevelId));
  if (!result?.ok || !result.answerHasH264) {
    console.error(`not ok - browser rejected screen share H.264 profile ${profileLevelId}`);
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    console.log(
      `ok - browser created an explicit H.264 answer in ${result.signalingState} state: ${result.videoLine}`
    );
  }
  const webMediaResult = await evaluateInBrowser(
    webSocketUrl,
    browserScreenShareLoopbackExpression(mediaProfile)
  );
  if (!webMediaResult?.ok) {
    console.error("not ok - browser screen share sender did not deliver decodable video and audio");
    console.error(JSON.stringify(webMediaResult, null, 2));
    process.exitCode = 1;
  } else {
    if (
      webMediaResult.appliedMaxBitrate <= 0 ||
      webMediaResult.appliedScaleResolutionDownBy !== 1 ||
      webMediaResult.encodedFrameWidth !== mediaProfile.width ||
      webMediaResult.encodedFrameHeight !== mediaProfile.height ||
      webMediaResult.qualityLimitationResolutionChanges !== 0 ||
      webMediaResult.averageEncodedFramesPerSecond < Math.min(30, mediaProfile.frameRate * 0.55) ||
      String(webMediaResult.negotiatedCodec).toLowerCase() !== "video/h264"
    ) {
      throw new Error(`browser did not apply the stable high-quality sender profile: ${JSON.stringify(webMediaResult)}`);
    }
    console.log(
      `ok - browser screen share capture ${webMediaResult.trackWidth}x${webMediaResult.trackHeight}@${webMediaResult.trackFrameRate} encoded ${webMediaResult.encodedFrameWidth}x${webMediaResult.encodedFrameHeight} and delivered ${webMediaResult.videoWidth}x${webMediaResult.videoHeight}, ${webMediaResult.framesDecoded} decoded frames, ${webMediaResult.framesEncoded} encoded frames at ${webMediaResult.averageEncodedFramesPerSecond.toFixed(1)} FPS, ${webMediaResult.negotiatedCodec}, max ${webMediaResult.appliedMaxBitrate} bps, ${webMediaResult.bytesReceived} video bytes, ${webMediaResult.audioPacketsReceived} audio packets, ${webMediaResult.audioBytesReceived} audio bytes`
    );
  }
  if (!webOnly) {
    const nativeOffer = dumpNativeOffer(profilePath);
    const nativeResult = await evaluateInBrowser(webSocketUrl, nativeOfferNegotiationExpression(nativeOffer));
    if (!nativeResult?.ok || !nativeResult.answerHasH264) {
      console.error("not ok - browser rejected the real native screen share offer");
      console.error(JSON.stringify(nativeResult, null, 2));
      process.exitCode = 1;
    } else {
      console.log(
        `ok - browser answered the real native offer in ${nativeResult.signalingState} state (${nativeResult.phases.join(" -> ")}): ${nativeResult.videoLine}`
      );
    }
    await verifyNativeMediaInBrowser(webSocketUrl, profilePath, mediaProfile, relayIceServers);
  }
}

// Capture a known test window instead of relying on whichever monitor/window
// happens to be first in the OS enumeration. Its profile is owned by this run.
async function runNativeFixture(webSocketUrl) {
  const sourcePort = await reservePort();
  const title = "EchoVoice capture test " + crypto.randomUUID();
  const sourceWindow = spawn(browser, [
    "--app=" + benchmarkPage.href, "--no-first-run", "--disable-background-networking",
    "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows", "--autoplay-policy=no-user-gesture-required",
    "--force-device-scale-factor=1", "--window-size=" + mediaProfile.width + "," + mediaProfile.height,
    "--remote-debugging-port=" + sourcePort, "--user-data-dir=" + join(profilePath, "source")
  ], { stdio: "ignore", windowsHide: false }); // WGC needs a visible, non-minimized source window.
  try {
    const sourceSocket = await waitForSourcePage(sourcePort);
    const opts = { width: mediaProfile.width, height: mediaProfile.height, fps: mediaProfile.frameRate,
      scene: process.env.EV_BENCH_SCENE || "motion" };
    await evaluateInBrowser(sourceSocket, `(async () => {
      document.title = ${JSON.stringify(title)};
      document.querySelector("#settings").hidden = true;
      document.querySelector("#settings").style.display = "none";
      document.body.style.overflow = "hidden";
      await startSource(${JSON.stringify(opts)});
      return document.title;
    })()`, process.env.EV_BENCH_CLIP);
    process.env.EV_SCREEN_SHARE_BROWSER_REAL_CAPTURE = "1";
    process.env.EV_SCREEN_SHARE_BROWSER_REAL_CAPTURE_KIND = "window";
    // Chromium app windows can append a browser suffix to document.title.
    // Resolve the actual HWND caption on the isolated source process only.
    const caption = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$p=Get-Process -Id ${Number(sourceWindow.pid)} -ErrorAction Stop; $p.Refresh(); $p.MainWindowTitle`],
      { encoding: "utf8", windowsHide: true }).stdout?.trim();
    if (!caption?.includes(title)) throw new Error("Fixture window caption did not identify the test source: " + caption);
    process.env.EV_SCREEN_SHARE_BROWSER_REAL_CAPTURE_TITLE = caption;
    mediaProfile.realCapture = true;
    await verifyNativeMediaInBrowser(webSocketUrl, profilePath, mediaProfile, relayIceServers, sourceSocket);
  } finally {
    await stopBrowser(sourceWindow, sourcePort);
  }
}

try {
  const webSocketUrl = meshBenchmark || syncTest ? await waitForSourcePage(port) : await waitForBrowser(port);
  if (meshBenchmark) await runMeshBenchmark(webSocketUrl);
  else if (process.env.EV_BENCH_NATIVE_WINDOW === "1") await runNativeFixture(webSocketUrl);
  else await runInterop(webSocketUrl);
} finally {
  await stopBrowser(child, port);
  sourceServer?.close();
  if (relayMember?.session_token) {
    await removeRelayDiagnosticMember(relayBaseUrl, relayMember.session_token);
  }
  rmSync(profilePath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

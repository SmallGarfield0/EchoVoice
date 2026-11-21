"use strict";

// Standalone test target for real WGC / getDisplayMedia and for the headless
// mesh benchmark. Marker IDs refer to distinct drawn frames, including stills.
const sourceCanvas = document.querySelector("#source");
const clipInput = document.querySelector("#clip");
const scenes = ["desktop", "text", "scroll", "video", "game", "camera", "texture", "motion", "sync"];
const markerCells = 24;
const cellSize = 8;
let currentSource;

function qualitySampler(width, height) {
  // Three native-resolution crops from the source pixel grid. A reduced-size
  // receiver is resampled onto the same grid so its detail loss is included.
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 3 * 64;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const positions = [[0.13, 0.2], [0.52, 0.55], [0.8, 0.82]];
  return (image, scaleX = 1, scaleY = 1) => {
    positions.forEach(([x, y], i) => {
      ctx.drawImage(image, Math.floor((width - 96) * x) * scaleX, Math.floor((height - 64) * y) * scaleY,
        96 * scaleX, 64 * scaleY, 0, i * 64, 96, 64);
    });
    return ctx.getImageData(0, 0, 96, canvas.height).data;
  };
}

function compareQualityCrops(a, b) {
  let squaredError = 0, sumSSIM = 0, blocks = 0;
  const luma = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  for (let by = 0; by < 192; by += 8) {
    for (let bx = 0; bx < 96; bx += 8) {
      let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
      for (let y = by; y < by + 8; y++) {
        for (let x = bx; x < bx + 8; x++) {
          const i = 4 * (96 * y + x);
          const u = luma(a, i), v = luma(b, i);
          squaredError += (u - v) ** 2;
          sumA += u; sumB += v; sumAA += u * u; sumBB += v * v; sumAB += u * v;
        }
      }
      const u = sumA / 64, v = sumB / 64;
      const varianceA = Math.max(0, sumAA / 64 - u * u);
      const varianceB = Math.max(0, sumBB / 64 - v * v);
      const covariance = sumAB / 64 - u * v;
      sumSSIM += ((2 * u * v + 6.5025) * (2 * covariance + 58.5225)) /
        ((u * u + v * v + 6.5025) * (varianceA + varianceB + 58.5225));
      blocks++;
    }
  }
  return { mse: squaredError / (96 * 192), ssim: sumSSIM / blocks };
}

async function startSource({ width, height, fps, scene, quality = false, audible = true }) {
  if (!scenes.includes(scene) || ![width, height, fps].every(Number.isSafeInteger)
      || width < 320 || width > 3840 || height < 180 || height > 2160 || fps < 1 || fps > 120) {
    throw new Error("Invalid source dimensions, frame rate or scene");
  }
  currentSource?.stop();
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const ctx = sourceCanvas.getContext("2d", { alpha: false });
  const times = new Map();
  const references = new Map();
  const sampleQuality = quality ? qualitySampler(width, height) : null;
  let lastReferenceAt = -Infinity;
  let syncAudio, syncTrack, nextPulse, pulseEnd = 0, pulseIndex = 0;
  if (scene === "sync") {
    syncAudio = new AudioContext({ latencyHint: "interactive" });
    await syncAudio.resume();
    syncTrack = syncAudio.createMediaStreamDestination();
    nextPulse = syncAudio.currentTime + 0.6;
  }
  let clip, clipURL;
  if (scene === "video" || scene === "game") {
    if (!clipInput.files.length) throw new Error("Select a local recording for this scene");
    clip = document.createElement("video");
    clip.loop = clip.muted = true;
    clipURL = URL.createObjectURL(clipInput.files[0]);
    clip.src = clipURL;
    try { await clip.play(); } catch (error) { URL.revokeObjectURL(clipURL); throw error; }
  }
  const tile = document.createElement("canvas");
  tile.width = tile.height = 512;
  const pixels = tile.getContext("2d");
  const image = pixels.createImageData(512, 512);
  let seed = 12345;
  for (let i = 0; i < image.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.data[i] = seed >>> 24;
    image.data[i + 1] = seed >>> 16 & 255;
    image.data[i + 2] = seed >>> 8 & 255;
    image.data[i + 3] = 255;
  }
  pixels.putImageData(image, 0, 0);
  const texture = ctx.createPattern(tile, "repeat");
  const page = document.createElement("canvas");
  page.width = width;
  page.height = height + 240;
  const text = page.getContext("2d");
  text.fillStyle = "#191e26";
  text.fillRect(0, 0, width, page.height);
  text.font = "17px monospace";
  for (let y = 22; y < page.height; y += 24) {
    for (let x = 20; x < width; x += 440) {
      text.fillStyle = y % 48 === 22 ? "#9addff" : "#f0d497";
      text.fillText("const 速度 = sample(frame.time) + 0.25", x, y);
    }
  }
  let id = 0, timer, callback, stopped = false;
  const origin = performance.now();
  function draw() {
    if (stopped) return;
    const now = performance.now();
    const t = (now - origin) / 1000;
    id++;
    if (syncAudio) {
      const clock = syncAudio.currentTime;
      if (clock + 0.1 >= nextPulse && pulseEnd !== nextPulse + 0.12) {
        const tone = syncAudio.createOscillator(), volume = syncAudio.createGain();
        tone.frequency.value = 880;
        tone.connect(volume).connect(syncTrack);
        if (audible) volume.connect(syncAudio.destination);
        volume.gain.setValueAtTime(0, nextPulse);
        volume.gain.linearRampToValueAtTime(0.04, nextPulse + 0.004);
        volume.gain.setValueAtTime(0.04, nextPulse + 0.09);
        volume.gain.linearRampToValueAtTime(0, nextPulse + 0.1);
        tone.start(nextPulse);
        tone.stop(nextPulse + 0.1);
        tone.onended = () => { tone.disconnect(); volume.disconnect(); };
        pulseEnd = nextPulse + 0.12;
      }
      const stamp = syncAudio.getOutputTimestamp();
      const outputTime = stamp.performanceTime > 0
        ? stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000 : clock;
      ctx.fillStyle = outputTime >= nextPulse && outputTime < pulseEnd ? "#eee" : "#121212";
      ctx.fillRect(0, 0, width, height);
      if (outputTime >= pulseEnd && pulseEnd > nextPulse) {
        nextPulse += [1.45, 1.91, 1.63, 2.13][pulseIndex++ % 4];
      }
    } else if (clip) {
      ctx.drawImage(clip, 0, 0, width, height);
    } else if (scene === "text" || scene === "scroll" || scene === "desktop") {
      ctx.drawImage(page, 0, scene === "scroll" ? -Math.floor(t * 720) % 240 : 0);
      if (scene === "desktop") {
        ctx.fillStyle = "#fff";
        ctx.fillRect((id * 17) % width, height / 2, 14, 20);
      }
    } else if (scene === "camera") {
      ctx.fillStyle = "#081225";
      ctx.fillRect(0, 0, width, height);
      // Perspective flight through a deterministic field of depth planes.
      for (let plane = 32; plane >= 1; plane--) {
        const z = plane - (t * 7 % 1);
        const scale = height / (z + 0.25);
        ctx.strokeStyle = "hsl(" + (plane * 13 % 360) + " 75% 65%)";
        ctx.lineWidth = Math.max(1, scale / 45);
        ctx.strokeRect(width / 2 + Math.sin(t * 2 + plane / 6) * scale - scale,
          height / 2 + Math.cos(t + plane / 6) * scale / 3 - scale, scale * 2, scale * 2);
      }
    } else {
      ctx.save();
      ctx.translate((id * 9) % 512, (id * 5) % 512);
      ctx.fillStyle = texture;
      ctx.fillRect(-512, -512, width + 512, height + 512);
      ctx.restore();
      if (scene === "motion") {
        ctx.globalAlpha = 0.85;
        ctx.drawImage(page, Math.sin(t * 2) * width / 2, height / 3);
        ctx.globalAlpha = 1;
        ctx.fillStyle = Math.floor(t) % 2 ? "#607bc7" : "#dbaf55";
        ctx.fillRect((id * 37) % width, height / 6, width / 3, height / 5);
      }
    }
    // Two ID bytes + checksum survive limited-range conversion. The receiver
    // samples the central part of each cell to avoid chroma and block edges.
    const code = ((id & 65535) << 8) | ((id ^ (id >>> 8) ^ 165) & 255);
    for (let bit = 0; bit < markerCells; bit++) {
      ctx.fillStyle = code & (1 << bit) ? "white" : "black";
      ctx.fillRect(bit * cellSize, 0, cellSize, 16);
    }
    ctx.fillStyle = "#111";
    ctx.fillRect(markerCells * cellSize, 0, 120, 24);
    ctx.fillStyle = "white";
    ctx.font = "18px monospace";
    ctx.fillText(String(id), markerCells * cellSize + 4, 18);
    times.set(id & 65535, now);
    if (sampleQuality && now - lastReferenceAt >= 190) {
      references.set(id & 65535, sampleQuality(sourceCanvas));
      lastReferenceAt = now;
      if (references.size > 40) references.delete(references.keys().next().value);
    }
    if (times.size > 2048) times.delete(times.keys().next().value);
  }
  if (clip) {
    const drawClip = () => { draw(); if (!stopped) callback = clip.requestVideoFrameCallback(drawClip); };
    drawClip();
  } else {
    const rate = scene === "desktop" || scene === "text" ? 1 : fps;
    let deadline = origin;
    const tick = () => {
      draw();
      deadline += 1000 / rate;
      deadline = Math.max(deadline, performance.now());
      timer = setTimeout(tick, deadline - performance.now());
    };
    tick();
  }
  currentSource = {
    times, references, audioTrack: syncTrack?.stream.getAudioTracks()[0], get count() { return id; },
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (syncAudio) {
        syncTrack.stream.getTracks().forEach(track => track.stop());
        void syncAudio.close();
      }
      if (clip) {
        clip.cancelVideoFrameCallback(callback);
        clip.pause();
        clip.removeAttribute("src");
        clip.load();
        URL.revokeObjectURL(clipURL);
      }
    }
  };
  return currentSource;
}

// Capture silence at the output while measuring the decoded input to the Web
// Audio graph. The real process-loopback source emits the low-level test tone.
window.createScreenShareSyncProbe = function () {
  const audioTimes = [], videoTimes = [];
  const pixel = document.createElement("canvas");
  pixel.width = pixel.height = 1;
  const ctx = pixel.getContext("2d", { willReadFrequently: true });
  let audio, input, tap, bright = false, audioClock = null, error = null;
  return {
    async attach(track) {
      try {
        audio = new AudioContext({ latencyHint: "interactive" });
        await audio.resume();
        const worker = `class Pulse extends AudioWorkletProcessor {
          process(inputs) {
            const samples = inputs[0]?.[0];
            for (let i = 0; samples && i < samples.length; i++) {
              if (Math.abs(samples[i]) > 0.008 && !(currentFrame + i < this.until)) {
                this.port.postMessage((currentFrame + i) / sampleRate);
                this.until = currentFrame + i + sampleRate * 0.6;
              }
            }
            return true;
          }
        } registerProcessor("ev-pulse", Pulse);`;
        const url = URL.createObjectURL(new Blob([worker], { type: "text/javascript" }));
        try { await audio.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        input = audio.createMediaStreamSource(new MediaStream([track]));
        tap = new AudioWorkletNode(audio, "ev-pulse");
        input.connect(tap).connect(audio.destination); // processor outputs silence
        tap.port.onmessage = ({ data }) => {
          const stamp = audio.getOutputTimestamp();
          audioClock = stamp.performanceTime > 0 ? "getOutputTimestamp" : "currentTime";
          audioTimes.push(stamp.performanceTime > 0
            ? stamp.performanceTime + (data - stamp.contextTime) * 1000
            : performance.now() + (data - audio.currentTime) * 1000);
        };
      } catch (e) { error = String(e); }
    },
    frame(video, meta) {
      ctx.drawImage(video, Math.floor(video.videoWidth / 2), Math.floor(video.videoHeight / 2), 1, 1, 0, 0, 1, 1);
      const lit = ctx.getImageData(0, 0, 1, 1).data[0] > 160;
      if (lit && !bright) videoTimes.push(meta.expectedDisplayTime);
      bright = lit;
    },
    stats() {
      const paired = [], remaining = new Set(audioTimes);
      for (const flash of videoTimes) {
        // The shortest source interval is 1.45 s. Restrict pairing to a
        // nonoverlapping window and explicitly count missing/ambiguous events.
        const hits = [...remaining].filter(t => Math.abs(t - flash) < 650);
        if (hits.length === 1) {
          paired.push(hits[0] - flash);
          remaining.delete(hits[0]);
        }
      }
      return { audioClock, error, flashes: videoTimes.length, clicks: audioTimes.length, matched: paired.length,
        audioMinusVideoMS: paired, p50MS: percentile(paired, 0.5), p95MS: percentile(paired, 0.95) };
    },
    close() { tap?.disconnect(); input?.disconnect(); if (audio) void audio.close(); }
  };
};

function addChoices(container, name, choices, initial) {
  for (const value of choices) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    input.checked = value === initial;
    label.append(input, value);
    container.append(label);
  }
}
addChoices(document.querySelector("#scenes"), "scene", scenes, "motion");
addChoices(document.querySelector("#sizes"), "size", ["1920x1080", "2560x1440", "3840x2160"], "1920x1080");

document.querySelector("#settings").onsubmit = async (event) => {
  event.preventDefault();
  const fields = new FormData(event.target);
  const [width, height] = fields.get("size").split("x").map(Number);
  try {
    await startSource({ width, height, fps: 60, scene: fields.get("scene") });
    document.querySelector("#status").textContent = width + " × " + height;
  } catch (error) { document.querySelector("#status").textContent = error.message; }
};
document.querySelector("#fullscreen").onclick = () => sourceCanvas.requestFullscreen();
const params = new URLSearchParams(location.search);
if (params.has("scene")) {
  document.querySelector("#settings").style.display = "none";
  startSource({ scene: params.get("scene"), width: Number(params.get("width") || 1920),
    height: Number(params.get("height") || 1080), fps: Number(params.get("fps") || 60) })
    .catch(error => { document.querySelector("#settings").style.display = "flex";
      document.querySelector("#status").textContent = error.message; });
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitUntil(predicate, timeout, label) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > end) throw new Error(label + " timed out");
    await delay(25);
  }
}

// This path uses real RTP/RTCP, browser encoders, decoders and compositors in
// one browser clock domain. It does not measure physical glass-to-glass time.
window.runScreenShareBenchmark = async function (options) {
  const { width, height, fps, viewers, seconds, scene, iceServers } = options;
  if (![1, 2, 5, 10].includes(viewers) || !Number.isInteger(seconds) || seconds < 2 || seconds > 600) {
    throw new Error("Use 1, 2, 5 or 10 viewers and a 2–600 second measurement window");
  }
  const source = await startSource({ ...options, audible: false });
  const stream = sourceCanvas.captureStream(fps);
  const [track] = stream.getVideoTracks();
  track.contentHint = ["text", "desktop"].includes(scene) ? "detail" : "motion";
  const peers = [];
  const rtc = iceServers.length ? { iceServers, iceTransportPolicy: "relay" } : { iceServers: [] };
  let measuring = false;
  async function openViewer(index) {
    const tx = new RTCPeerConnection(rtc);
    const rx = new RTCPeerConnection(rtc);
    const video = document.createElement("video");
    video.autoplay = video.muted = video.playsInline = true;
    document.querySelector("#viewers").append(video);
    const peer = { index, tx, rx, video, gaps: [], ages: [], lastTime: null,
      observed: 0, firstPresented: null, lastPresented: null, unpaired: 0, lastProbe: -Infinity };
    if (source.audioTrack) peer.sync = window.createScreenShareSyncProbe();
    peers.push(peer);
    const marker = document.createElement("canvas");
    marker.width = markerCells;
    marker.height = 1;
    const sample = marker.getContext("2d", { willReadFrequently: true });
    sample.imageSmoothingEnabled = false;
    const sampleQuality = options.quality ? qualitySampler(width, height) : null;
    peer.qualitySamples = [];
    function onVideoFrame(now, meta) {
      peer.sync?.frame(video, meta);
      if (measuring) {
        if (peer.lastTime !== null) peer.gaps.push(meta.expectedDisplayTime - peer.lastTime);
        peer.lastTime = meta.expectedDisplayTime;
        peer.firstPresented ??= meta.presentedFrames;
        peer.lastPresented = meta.presentedFrames;
        peer.observed++;
        if ((sampleQuality || now - peer.lastProbe >= 200) && video.videoWidth) {
          peer.lastProbe = now;
          sample.drawImage(video, 0, 0, markerCells * cellSize * video.videoWidth / width,
            16 * video.videoHeight / height, 0, 0, markerCells, 1);
          const rgba = sample.getImageData(0, 0, markerCells, 1).data;
          let code = 0;
          for (let bit = 0; bit < markerCells; bit++) {
            if (rgba[4 * bit] > 127) code |= 1 << bit;
          }
          const frame = code >>> 8;
          const drawn = source.times.get(frame);
          if ((code & 255) === ((frame ^ (frame >>> 8) ^ 165) & 255) && drawn !== undefined
              && meta.expectedDisplayTime >= drawn) {
            peer.ages.push(meta.expectedDisplayTime - drawn);
            const reference = source.references.get(frame);
            if (sampleQuality && reference && peer.lastQualityId !== frame) {
              const received = sampleQuality(video, video.videoWidth / width, video.videoHeight / height);
              peer.qualitySamples.push(compareQualityCrops(reference, received));
              peer.lastQualityId = frame;
            }
          } else peer.unpaired++;
        }
      }
      peer.callback = video.requestVideoFrameCallback(onVideoFrame);
    }
    peer.callback = video.requestVideoFrameCallback(onVideoFrame);
    rx.ontrack = event => {
      if (event.track.kind === "video") video.srcObject = new MediaStream([event.track]);
      else if (peer.sync) void peer.sync.attach(event.track);
    };
    const sender = tx.addTrack(track, stream);
    if (source.audioTrack) tx.addTrack(source.audioTrack, stream);
    const transceiver = tx.getTransceivers()[0];
    const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
    if (transceiver.setCodecPreferences && codecs.some(c => c.mimeType.toLowerCase() === "video/h264")) {
      const h264 = c => c.mimeType.toLowerCase() === "video/h264";
      transceiver.setCodecPreferences([...codecs.filter(h264), ...codecs.filter(c => !h264(c))]);
    }
    await tx.setLocalDescription(await tx.createOffer());
    await waitUntil(() => tx.iceGatheringState === "complete", 12000, "publisher ICE gathering");
    await rx.setRemoteDescription(tx.localDescription);
    await rx.setLocalDescription(await rx.createAnswer());
    await waitUntil(() => rx.iceGatheringState === "complete", 12000, "viewer ICE gathering");
    await tx.setRemoteDescription(rx.localDescription);
    const params = sender.getParameters();
    params.encodings[0].maxBitrate = options.bitrate;
    params.encodings[0].maxFramerate = fps;
    params.degradationPreference = track.contentHint === "motion" ? "maintain-framerate" : "maintain-resolution";
    await sender.setParameters(params);
    await waitUntil(() => video.videoWidth > 0, 12000, "first decoded frame on viewer " + index);
  }
  async function snapshot(peer) {
    const [s, r] = await Promise.all([peer.tx.getStats(), peer.rx.getStats()]);
    const find = (stats, type) => [...stats.values()].find(i => i.type === type && i.kind === "video");
    const out = find(s, "outbound-rtp");
    const incoming = find(r, "inbound-rtp");
    if (!out || !incoming) throw new Error("Video RTP stats missing");
    const selected = [...r.values()].find(i => i.type === "transport" && i.selectedCandidatePairId);
    const pair = r.get(selected?.selectedCandidatePairId);
    return { out, incoming, media: s.get(out.mediaSourceId), codec: s.get(out.codecId)?.mimeType,
      pair, localType: r.get(pair?.localCandidateId)?.candidateType ?? null,
      remoteType: r.get(pair?.remoteCandidateId)?.candidateType ?? null };
  }
  function summarize(peer, before, after, elapsed) {
    const delta = (obj, key) => {
      const a = before[obj], b = after[obj];
      if (!a || !b || a.id !== b.id || !Number.isFinite(a[key]) || !Number.isFinite(b[key])) return null;
      const change = b[key] - a[key];
      return change >= 0 ? change : null;
    };
    const rate = (obj, key, unit = 1) => {
      const d = delta(obj, key);
      const dt = delta(obj, "timestamp");
      return d === null || !dt ? null : d * unit * 1000 / dt;
    };
    const averageMs = (obj, time, count) => {
      const duration = delta(obj, time), n = delta(obj, count);
      return !n || duration === null ? null : 1000 * duration / n;
    };
    const qualityCount = peer.qualitySamples.length;
    const meanMSE = qualityCount ? peer.qualitySamples.reduce((sum, s) => sum + s.mse, 0) / qualityCount : null;
    const quality = options.quality ? { matchedFrames: qualityCount, identicalCrops: meanMSE === 0,
      lumaPSNRdB: meanMSE > 0 ? 10 * Math.log10(255 ** 2 / meanMSE) : null,
      lumaSSIMP50: percentile(peer.qualitySamples.map(s => s.ssim), 0.5),
      lumaSSIMP05: percentile(peer.qualitySamples.map(s => s.ssim), 0.05) } : undefined;
    return { viewer: peer.index, quality, sync: peer.sync?.stats(), codec: after.codec, output: [after.incoming.frameWidth, after.incoming.frameHeight],
      path: [after.localType, after.remoteType], rttMS: Number.isFinite(after.pair?.currentRoundTripTime)
        ? after.pair.currentRoundTripTime * 1000 : null,
      capturedFPS: rate("media", "frames"), encodedFPS: rate("out", "framesEncoded"), sentFPS: rate("out", "framesSent"),
      receivedFPS: rate("incoming", "framesReceived"), decodedFPS: rate("incoming", "framesDecoded"),
      presentedFPS: peer.observed ? (peer.lastPresented - peer.firstPresented + 1) / elapsed : 0,
      frameGapP95MS: percentile(peer.gaps, 0.95), frameGapP99MS: percentile(peer.gaps, 0.99),
      drawToCompositorP50MS: percentile(peer.ages, 0.5), drawToCompositorP95MS: percentile(peer.ages, 0.95),
      pairedMarkers: peer.ages.length, unpairedMarkers: peer.unpaired, observedCallbacks: peer.observed,
      payloadBps: rate("out", "bytesSent", 8), retransmittedBytes: delta("out", "retransmittedBytesSent"),
      freezes: delta("incoming", "freezeCount"), droppedFrames: delta("incoming", "framesDropped"),
      avgJitterBufferMS: averageMs("incoming", "jitterBufferDelay", "jitterBufferEmittedCount"),
      avgEncodeMS: averageMs("out", "totalEncodeTime", "framesEncoded"),
      avgDecodeMS: averageMs("incoming", "totalDecodeTime", "framesDecoded"),
      encoder: after.out.encoderImplementation ?? null, decoder: after.incoming.decoderImplementation ?? null };
  }
  try {
    await Promise.all(Array.from({ length: viewers }, (_, i) => openViewer(i + 1)));
    await delay(2000);
    const before = await Promise.all(peers.map(snapshot));
    const sourceStart = source.count, start = performance.now();
    measuring = true;
    await delay(seconds * 1000);
    measuring = false;
    const elapsed = (performance.now() - start) / 1000;
    const drawn = source.count - sourceStart;
    const after = await Promise.all(peers.map(snapshot));
    const results = peers.map((peer, i) => summarize(peer, before[i], after[i], elapsed));
    return { ok: results.every(r => r.decodedFPS > 0 && r.presentedFPS > 0 &&
        (!source.audioTrack || r.sync.matched >= 2) &&
        (!options.quality || r.quality.matchedFrames > 0) &&
        (!iceServers.length || r.path.includes("relay"))),
      browser: navigator.userAgent, source: scene, clip: clipInput.files[0]?.name ?? null,
      width, height, fps, viewers, seconds: elapsed, requestedMaxBpsPerViewer: options.bitrate,
      sourceDrawFPS: drawn / elapsed, results };
  } finally {
    measuring = false;
    for (const p of peers) {
      p.tx.close(); p.rx.close(); p.video.cancelVideoFrameCallback(p.callback);
      p.sync?.close();
      p.video.srcObject = null; p.video.remove();
    }
    stream.getTracks().forEach(t => t.stop());
    source.stop();
  }
};

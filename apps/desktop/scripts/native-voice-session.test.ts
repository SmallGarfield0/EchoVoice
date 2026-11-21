import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { KeyedTaskCoordinator } from "../src/lib/keyedTaskCoordinator.ts";

await testSameSessionStartIsShared();
await testDifferentSessionStartsAreSerialized();
await testFailedStartReleasesCoordinator();
await testDesktopMusicCommandsStayOffTheUIThread();
await testVoiceAndMusicKeepStableNegotiatedTracks();

async function testSameSessionStartIsShared() {
  const coordinator = new KeyedTaskCoordinator();
  const gate = deferred<void>();
  let starts = 0;
  const start = async () => {
    starts += 1;
    await gate.promise;
  };

  const first = coordinator.run("generation-1:voice-a", start);
  const second = coordinator.run("generation-1:voice-a", start);
  await Promise.resolve();
  assert.equal(starts, 1, "duplicate starts for the same native voice session were not merged");
  assert.equal(first, second, "same-key callers should observe the same start operation");

  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(coordinator.active, false);
}

async function testDifferentSessionStartsAreSerialized() {
  const coordinator = new KeyedTaskCoordinator();
  const firstGate = deferred<void>();
  const order: string[] = [];

  const first = coordinator.run("generation-1:voice-a", async () => {
    order.push("first-start");
    await firstGate.promise;
    order.push("first-end");
  });
  const second = coordinator.run("generation-2:voice-b", async () => {
    order.push("second-start");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
}

async function testFailedStartReleasesCoordinator() {
  const coordinator = new KeyedTaskCoordinator();
  await assert.rejects(
    coordinator.run("generation-1:voice-a", async () => {
      throw new Error("startup failed");
    }),
    /startup failed/
  );

  let restarted = false;
  await coordinator.run("generation-1:voice-a", async () => {
    restarted = true;
  });
  assert.equal(restarted, true);
}

async function testDesktopMusicCommandsStayOffTheUIThread() {
  const nativeVoiceSource = await readFile(
    new URL("../src-tauri/src/native_voice.rs", import.meta.url),
    "utf8"
  );
  const mainSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");

  for (const command of ["native_voice_start_accompaniment", "native_voice_stop_accompaniment"]) {
    assert.match(nativeVoiceSource, new RegExp(`pub async fn ${command}\\b`));
  }
  assert.match(nativeVoiceSource, /spawn_blocking\(move \|\|/);
  assert.match(mainSource, /async fn list_desktop_audio_process_sources\b/);
  assert.match(
    mainSource,
    /spawn_blocking\([\s\S]*?windows_process_loopback::list_process_sources[\s\S]*?\)\s*\.await/
  );
}

async function testVoiceAndMusicKeepStableNegotiatedTracks() {
  const appSource = await readFile(new URL("../src/App.svelte", import.meta.url), "utf8");
  const voiceSessionSource = await readFile(
    new URL("../src/lib/voice-session.svelte.ts", import.meta.url),
    "utf8"
  );
  const nativeVoiceSource = await readFile(
    new URL("../src-tauri/src/native_voice.rs", import.meta.url),
    "utf8"
  );
  const replaceMicrophone = functionBody(voiceSessionSource, "async replaceOutgoingAudioTrack");
  const replaceMusic = functionBody(voiceSessionSource, "async replaceOutgoingAccompanimentTrack");

  assert.doesNotMatch(replaceMicrophone, /renegotiatePeerConnection|createOffer|setLocalDescription/);
  assert.doesNotMatch(replaceMusic, /renegotiatePeerConnection|createOffer|setLocalDescription/);
  assert.match(voiceSessionSource, /connection\.addTransceiver\("audio", \{ direction: "sendrecv" \}\)/);
  assert.match(voiceSessionSource, /encoding\.maxBitrate = 256_000/);
  assert.match(voiceSessionSource, /voiceAudioTrackScope\([\s\S]*?"accompaniment"/);
  assert.match(nativeVoiceSource, /const ACCOMPANIMENT_OPUS_BITRATE: u32 = 256_000/);
  assert.match(nativeVoiceSource, /const ACCOMPANIMENT_CHANNELS: usize = 2/);
  assert.match(nativeVoiceSource, /native_voice_set_member_music_volume/);
  assert.match(nativeVoiceSource, /native_voice_set_accompaniment_volume/);
  assert.match(voiceSessionSource, /signalProcessingQueues = new Map/);
  assert.doesNotMatch(voiceSessionSource, /\baudioOutputDeviceId\s*&&/);
  assert.match(nativeVoiceSource, /RTCSignalingState::HaveRemoteOffer/);
  assert.match(nativeVoiceSource, /RTCSignalingState::HaveLocalOffer/);
  assert.doesNotMatch(nativeVoiceSource, /last_offer_at_ms/);
}

function functionBody(source: string, signature: string) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} was not found`);
  const nextMethod = source.slice(start + signature.length).search(/\n  (async )?[a-zA-Z_$][a-zA-Z0-9_$]*\(/);
  const end = nextMethod >= 0 ? start + signature.length + nextMethod : source.length;
  return source.slice(start, end);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

console.log("ok - native voice lifecycle, signaling, and stable voice/music tracks are guarded");

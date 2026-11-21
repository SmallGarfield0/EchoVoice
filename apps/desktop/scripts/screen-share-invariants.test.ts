// Pins the invariants that this screen-share work established. Each of them was
// a real defect once, and every one is invisible in a passing build: the code
// has to be *read* to notice that a value is written but never obeyed, or that
// a stuck state has no brake. These assertions are cheap and blunt on purpose.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

const transportSource = await read("../src/lib/screen-share-transport.svelte.ts");
const controllerSource = await read("../src/lib/screen-share.svelte.ts");
const settingsSource = await read("../src/lib/screen-share-setup.svelte.ts");
const nativeSource = await read("../src-tauri/src/main.rs");
const appSource = await read("../src/App.svelte");
const panelSource = await read("../src/components/ContentPanel.svelte");

const results = [];

function run(name, body) {
  body();
  results.push(name);
}

function methodBody(source, signatureStart) {
  const start = source.indexOf(signatureStart);
  assert.notEqual(start, -1, `missing ${signatureStart}`);
  const end = source.indexOf("\n  }\n", start);
  assert.notEqual(end, -1, `unterminated ${signatureStart}`);
  return source.slice(start, end);
}

// Rust bodies are indented too deep for the TypeScript terminator above, and
// their format! placeholders are brace-balanced, so counting braces works.
function rustBody(source, signatureStart) {
  const start = source.indexOf(signatureStart);
  assert.notEqual(start, -1, `missing ${signatureStart}`);
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `missing body for ${signatureStart}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated ${signatureStart}`);
}

run("screen-share audio follows the video buffer instead of a fixed delay", () => {
  const body = methodBody(
    transportSource,
    "  configureScreenShareReceiver(receiver: RTCRtpReceiver, targetMemberId = \"\") {"
  );
  assert.ok(
    body.includes("screenShareAudioPlayoutDelayMS("),
    "audio must derive its delay from the video target, otherwise A/V drift returns"
  );
});

run("the playout controller is told whether this path is relayed", () => {
  const body = methodBody(transportSource, "  private adaptScreenSharePlayoutDelay(");
  assert.ok(
    body.includes("screenSharePlayoutDelayCeilingMS("),
    "a relayed path may buffer deeper than a direct one"
  );
  const caller = methodBody(transportSource, "  async refreshScreenShareReceiverStats(");
  assert.ok(
    caller.includes("effectivePathKind"),
    "a reconnect must not fall back to the unknown ceiling and shrink the buffer"
  );
});

run("a stalled stream is judged on the transport, not only on decoded frames", () => {
  const body = methodBody(transportSource, "  async refreshScreenShareReceiverStats(");
  assert.ok(
    body.includes("decideScreenSharePathLiveness("),
    "a static desktop produces no frames while the link is perfectly healthy"
  );
});

run("a connection we only send on never runs the receiver half", () => {
  const recovery = methodBody(
    transportSource,
    "  private handleScreenShareConnectionRecovery("
  );
  assert.ok(
    recovery.includes("screenSharePeerReceivesVideo("),
    "asking a viewer to restart our own ICE is a signal it can only drop"
  );
  const stats = methodBody(transportSource, "  async refreshScreenShareReceiverStats(");
  assert.ok(
    stats.includes("screenSharePeerReceivesVideo("),
    "an outbound connection has no inbound media to age into stalled"
  );
});

run("watching gives up instead of reconnecting forever", () => {
  const body = methodBody(controllerSource, "  scheduleReconnect(shareId: string, delayMS = 1200): void {");
  assert.ok(
    body.includes("screenShareWatchShouldGiveUp("),
    "a share whose session is gone must stop costing the sharer an encoder per retry"
  );
});

run("a settings change reaches the running share, not only the next one", () => {
  const body = methodBody(settingsSource, "  private noteShareSettingsChange(");
  assert.ok(
    body.includes("applyWebScreenShareSenderSettings()"),
    "the web senders must be retuned in place"
  );
  assert.ok(
    body.includes("shareSettingsPending = true"),
    "what cannot be retuned must be reported"
  );
});

run("the native sender only advertises the video and audio it encodes", () => {
  const body = rustBody(nativeSource, "    async fn create_viewer(");
  assert.ok(!body.includes("register_default_codecs()"));
  assert.ok(body.includes("RTPCodecType::Video") && body.includes("RTPCodecType::Audio"));
  assert.ok(body.includes("&self.audio_codec"));
});

run("the native sender stops waiting two seconds before it may nominate a relay", () => {
  // webrtc-ice defaults to 2000 ms before a relay pair is nominatable, which is
  // two seconds of black screen for every relayed viewer. The override is the
  // only reason a relayed screen share starts in ~1.3 s, so losing it is a
  // silent regression that no unit test would otherwise catch.
  const body = rustBody(nativeSource, "    async fn create_viewer(");
  const at = body.indexOf("set_relay_acceptance_min_wait(");
  assert.notEqual(
    at,
    -1,
    "create_viewer must lower the relay acceptance wait instead of inheriting webrtc-ice's 2 s default"
  );
  const build = body.indexOf("APIBuilder::new()");
  assert.ok(
    build !== -1 && at < build,
    "the setting engine has to be configured before the API is built from it"
  );
});

run("a failed watch can be retried without pressing stop first", () => {
  // The give-up clock only starts on a first attempt, so a retry that skips this
  // reset inherits the deadline that just expired and fails immediately — the
  // button would look like it does nothing.
  const body = methodBody(controllerSource, "  async retryWatchingScreenShare(");
  assert.ok(
    body.includes("watchGiveUpFromMS") && body.includes("startWatchingScreenShare("),
    "a retry has to restart the give-up clock before it starts the watch again"
  );
  const toggle = methodBody(controllerSource, "  async toggleWatchScreenShare(");
  assert.ok(
    toggle.includes("retryWatchingScreenShare("),
    "the same button must retry once the watch has failed"
  );
});

run("every declared transport hook is actually wired in the app", () => {
  // App.svelte is a .svelte file, so `tsc -p` never checks it: a hook that the
  // transport declares but the app forgets is a runtime `TypeError` on the
  // first call, not a type error. That is exactly how every Web screen share
  // ended up sending no offer at all — `rtcIceConfigFetchedAtMS` was missing
  // from this object, so `ensureScreenSharePeerConnection` threw before the
  // offer was created, and the catch hid it.
  const declared = transportSource.slice(
    transportSource.indexOf("export type ScreenShareTransportHooks = {"),
    transportSource.indexOf("\n};", transportSource.indexOf("export type ScreenShareTransportHooks = {"))
  );
  assert.ok(declared.length > 0, "missing ScreenShareTransportHooks");
  const names = [...declared.matchAll(/^\s{2}([a-zA-Z][\w]*)\??:/gm)].map((match) => match[1]);
  assert.ok(names.length > 20, `expected many transport hooks, parsed ${names.join(", ")}`);

  const start = appSource.indexOf("new ScreenShareTransportController({");
  assert.notEqual(start, -1, "missing ScreenShareTransportController wiring");
  const wired = appSource.slice(start, start + 6000);

  const missing = names.filter((name) => !new RegExp(`\\b${name}\\s*:`).test(wired));
  assert.deepEqual(missing, [], `App.svelte does not wire: ${missing.join(", ")}`);
});

run("a viewer leaving releases the rate it was holding back, at once", () => {
  // A single encoder is limited by the worst viewer's REMB. When that viewer
  // leaves, the ceiling has to be recomputed from what is left *and* from the
  // peak this path already sustained, otherwise the remaining viewer keeps the
  // low rate until they stop and watch again.
  const controller = rustBody(nativeSource, "    fn remove_viewer(&mut self, viewer_peer_id: &str) -> Option<u32> {");
  assert.ok(
    controller.includes("peak_bitrate_bps"),
    "the recovered rate must not be capped by the estimate that the slow viewer depressed"
  );
  const sender = rustBody(nativeSource, "    fn remove_viewer(&self, member_id: &str, watch_session_id: &str) -> bool {");
  assert.ok(
    sender.includes("keyframe_requested"),
    "the remaining viewer only sees the new rate once a keyframe arrives"
  );
});

run("a path switch never asks for a relay that does not exist", () => {
  // Relay-only gathering without a TURN server produces no candidates at all,
  // which turns a blurry picture into no picture: the guard has to be inside
  // the configuration the peer connection is actually built from.
  const body = methodBody(
    transportSource,
    "  private screenSharePeerConnectionConfiguration(shareId: string): RTCConfiguration {"
  );
  assert.ok(
    body.includes("screenShareRelayIsConfigured("),
    "relay-only ICE must be gated on a configured TURN server"
  );
  assert.ok(
    body.includes("screenShareDirectIceServers("),
    "a viewer that asked for the direct path must not be handed TURN servers"
  );
  const build = methodBody(transportSource, "  ensureScreenSharePeerConnection(");
  assert.ok(
    build.includes("screenSharePeerConnectionConfiguration("),
    "the peer connection must be built from the path-aware configuration, not the plain one"
  );
  const decision = methodBody(transportSource, "  private maybeSwitchScreenSharePath(input: {");
  assert.ok(
    decision.includes("retryWatchingScreenShareOnNewPath("),
    "a decided switch has to rebuild the connection or nothing changes"
  );
});

run("the path is chosen once at the start, then only by the viewer", () => {
  // Each switch rebuilds the peer connection: about a second of black picture and
  // a cold receiver estimate. Moving the path twice on its own is how a viewer
  // ended up on direct, then relay, then direct again for no gain.
  const decision = methodBody(transportSource, "  private maybeSwitchScreenSharePath(input: {");
  assert.ok(
    decision.includes("watchingMS:"),
    "the decision needs the age of this watch to know the startup window is over"
  );
  assert.ok(
    decision.includes("startedAtMS:"),
    "the startup window has to be anchored to the first sample"
  );
  const setter = methodBody(
    transportSource,
    "  setScreenSharePathPreference(shareId: string, preference: ScreenSharePathPreference): void {"
  );
  assert.ok(
    setter.includes("screenSharePathHistory.delete(shareId)"),
    "a manual choice must restart the startup window the old samples described"
  );
  assert.ok(
    setter.includes("retryWatchingScreenShareOnNewPath(shareId)"),
    "changing the path only takes effect through a rebuild"
  );
  // The control has to exist somewhere a viewer can reach it.
  assert.ok(
    panelSource.includes("data-screen-share-path"),
    "the viewer needs a control to pick the path themselves"
  );
  assert.ok(
    transportSource.includes("screenSharePathMenuShareId"),
    "the menu state has to live where the outside-click and Escape handlers can close it"
  );
});

run("a relay-only viewer notices an unreachable relay instead of waiting", () => {
  // A failed TURN allocation is silent: gathering just ends with no candidate,
  // so without this the viewer sits on a black frame until the watch deadline.
  const build = methodBody(transportSource, "  ensureScreenSharePeerConnection(");
  assert.ok(
    build.includes("startScreenShareRelayWatch("),
    "the peer connection must arm the relay watchdog when it is built"
  );
  const watch = methodBody(transportSource, "  private startScreenShareRelayWatch(");
  assert.ok(
    watch.includes("screenShareRelayCandidateVerdict("),
    "the watchdog must judge gathered candidates, not merely wait"
  );
  assert.ok(
    watch.includes("retryWatchingScreenShareOnNewPath("),
    "an unreachable relay has to rebuild the connection back on ICE"
  );
  const candidates = methodBody(transportSource, "  connection.onicecandidate = (event) => {");
  assert.ok(
    candidates.includes(" typ relay"),
    "relay candidates must be counted, which is what the watchdog reads"
  );
});

run("the native encoder still answers keyframe requests on a still desktop", () => {
  // A static screen produces no capture frames, so an encoder driven only by
  // capture events can never answer the PLI that follows a lost reference
  // frame: the picture freezes while the audio keeps playing, forever.
  const body = rustBody(nativeSource, "    fn run_encoding_worker(");
  assert.ok(
    body.includes("wait_timeout("),
    "the encoder must wake up without a new capture frame"
  );
  assert.ok(
    body.includes("SCREEN_SHARE_IDLE_KEYFRAME_INTERVAL"),
    "the wake-up interval has to be a named constant, not an inline literal"
  );
  assert.ok(
    body.includes("FrameSlotWait::Timeout"),
    "the idle path must be distinguishable from a stop"
  );
  const idle = body.indexOf("FrameSlotWait::Timeout");
  const forced = body.indexOf("force_keyframe()", idle);
  assert.ok(forced !== -1, "the idle path must re-encode the frame it still holds as a keyframe");
});

run("a weak viewer moves off the shared encode instead of shrinking everyone", () => {
  // One encoder for every viewer means one viewer's REMB sets everyone's rate.
  // The low tier exists so a weak link costs only its own quality.
  const decide = rustBody(nativeSource, "        fn update_viewer_layer(");
  assert.ok(
    decide.includes("high_tier_viewers() > 1"),
    "the last full-quality viewer must never be demoted, or nobody running the full encode is left"
  );
  assert.ok(
    decide.includes("viewer_holds_the_shared_encode_back("),
    "a viewer is demoted for missing the rate the others can carry, not for a fixed threshold"
  );
  const holds = rustBody(
    nativeSource,
    "        fn viewer_holds_the_shared_encode_back(&self, estimate_bps: u32) -> bool {"
  );
  assert.ok(
    holds.includes("high_tier_estimates().min()"),
    "the comparison has to be against the other full-quality viewers"
  );
  assert.ok(
    holds.includes("NATIVE_SCREEN_SHARE_LOW_TIER_RELATIVE_PERCENT"),
    "the relative shortfall has to be a named constant"
  );
  const estimate = rustBody(nativeSource, "        fn update_receiver_estimate(");
  assert.ok(
    estimate.includes("high_tier_estimates()"),
    "viewers on the low tier must not lower the shared encode's rate"
  );
  const leave = rustBody(
    nativeSource,
    "        fn remove_viewer(&mut self, viewer_peer_id: &str) -> Option<u32> {"
  );
  assert.ok(
    leave.includes("note_viewer_layer("),
    "when no full-quality viewer is left the reduced ones must be promoted, not served a smaller encode"
  );
});

run("a viewer only receives the encode its own link can carry", () => {
  const write = rustBody(nativeSource, "        fn write_h264_sample(");
  assert.ok(
    write.includes("layer: ScreenShareLayer"),
    "the write path has to be told which tier the sample belongs to"
  );
  assert.ok(
    write.includes("viewer.layer == layer"),
    "a sample must only reach the viewers subscribed to that tier"
  );
  const create = rustBody(nativeSource, "    async fn create_viewer(");
  assert.ok(
    create.includes("reserve_viewer_layer("),
    "a viewer must be assigned a tier when it is created, not on its first REMB"
  );
  const encode = rustBody(nativeSource, "    fn encode_and_deliver(");
  assert.ok(
    encode.includes("ScreenShareLayer::High") && encode.includes("ScreenShareLayer::Low"),
    "a frame has to be encoded for both tiers"
  );
  assert.ok(
    encode.includes("low_tier_target_bitrate_bps()"),
    "the low tier must only cost a second encode while somebody subscribes to it"
  );
});

run("a candidate that arrives before the answer is kept, not dropped", () => {
  // A viewer trickles candidates as soon as it has them, which beats its own
  // answer across signaling regularly. webrtc-rs rejects any candidate while
  // the remote description is missing, so an unguarded add loses the path.
  const body = rustBody(nativeSource, "    fn handle_signal(");
  assert.ok(
    body.includes("pending_ice_candidates"),
    "candidates that race the answer must be parked on the viewer"
  );
  assert.ok(
    body.includes("remote_description().await.is_some()"),
    "the decision has to be made from the connection's actual state"
  );
  assert.ok(
    body.includes(".drain(..)"),
    "the answer branch must apply the parked candidates instead of leaving them parked"
  );
});

run("a suspended capture resumes its bitrate controller", () => {
  const body = rustBody(nativeSource, "    fn run_encoding_worker(");
  assert.ok(
    body.includes("SCREEN_SHARE_CAPTURE_GAP_NS"),
    "the gap threshold has to be a named constant"
  );
  assert.ok(
    body.includes("resume_after_capture_gap("),
    "the rate controller has to be told the path is being used again"
  );
  const gap = body.indexOf("SCREEN_SHARE_CAPTURE_GAP_NS");
  const resumed = body.indexOf("resume_after_capture_gap(", gap);
  const probe = body.indexOf("probe_bitrate_upward()", gap);
  assert.ok(
    resumed > probe && probe !== -1,
    "the resume must run after the probe, or the probe's ceiling obey undoes it"
  );
});

run("a capture window that closes stops the share instead of failing silently", () => {
  // The closed window never produces another frame. Leaving the session
  // "failed" keeps the sender, the viewers and the preview alive for a source
  // that cannot come back.
  const handler = rustBody(nativeSource, "            let closed_handler =");
  assert.ok(
    handler.includes("CAPTURE_SOURCE_CLOSED_ERROR"),
    "the closed reason has to be a shared constant the client can match"
  );
  assert.ok(
    handler.includes("stop_flag") || handler.includes("closed_stop"),
    "the capture loop has to be stopped, not just marked failed"
  );
  const status = methodBody(transportSource, "  applyNativeScreenShareSenderStatus(");
  assert.ok(
    status.includes("CAPTURE_SOURCE_CLOSED_ERROR") || status.includes("capture source closed"),
    "the client has to recognise the closed-source failure"
  );
  assert.ok(
    status.includes("stopCurrentScreenShareSession("),
    "the client has to end the share, which is what the user expects"
  );
});

run("a resized capture window recreates the frame pool", () => {
  // The WGC frame pool is created at the size the window had when sharing
  // started; every frame after a resize is cropped or scaled until the pool is
  // recreated, which shows up as a picture stuck at the old size.
  const poll = rustBody(nativeSource, "                .name(\"ev-wgc-frame-poll\".to_string())");
  assert.ok(
    poll.includes("recreate_frame_pool_for_source_size("),
    "the poll loop has to look at the source size, not only at frames"
  );
  const recreate = rustBody(
    nativeSource,
    "        fn recreate_frame_pool_for_source_size("
  );
  assert.ok(
    recreate.includes(".Recreate(") && recreate.includes("frame_pool"),
    "changing the recorded size without recreating the pool fixes nothing"
  );
  assert.ok(
    recreate.includes("item.Size()"),
    "the size has to come from the capture item itself"
  );
});

run("a viewer that chose the relay tells the sharer before it reconnects", () => {
  // webrtc-ice gates nomination on the candidate type of both ends of a pair, so
  // a relay-only viewer costs the sender its full one-second relay wait before
  // DTLS can even start. That is the black screen a hand-picked relay switch used
  // to show; the hint is what lets the sender skip a wait it has nothing to
  // protect from.
  const retry = methodBody(
    transportSource,
    "  private retryWatchingScreenShareOnNewPath("
  );
  assert.ok(
    retry.includes("screen-share-path-hint"),
    "the viewer has to tell the sharer which path it is about to use"
  );
  assert.ok(
    retry.indexOf("sendRTCSignal") < retry.indexOf("retryWatchingScreenShare("),
    "the hint has to arrive before the watch it describes"
  );
  const hintHandler = methodBody(transportSource, "  handleScreenSharePathHintSignal(");
  assert.ok(
    hintHandler.includes("rememberScreenSharePathHint("),
    "the sharer has to keep the hint for the watch that follows"
  );
  assert.ok(
    controllerSource.includes("takeScreenSharePathHint(") &&
      controllerSource.includes("screenSharePathHintIsRelayOnly("),
    "adding the viewer is where the hint becomes a shorter ICE wait"
  );
  const createViewer = rustBody(
    nativeSource,
    "        async fn create_viewer(\n            &self,\n            member_id: String,"
  );
  assert.ok(
    createViewer.includes("viewer_relay_acceptance_wait("),
    "the wait has to depend on the viewer's path, not be a constant"
  );
  const wait = rustBody(nativeSource, "    fn viewer_relay_acceptance_wait(");
  assert.ok(
    wait.includes("Duration::from_millis(120)") && wait.includes("Duration::from_millis(1_000)"),
    "relay-only viewers get a short wait, everyone else keeps the direct grace"
  );
});

run("a resized or closed window still reaches the viewer as a picture", () => {
  // A window is rarely the encoder's aspect ratio, and mapping the two axes
  // independently squashes it. The scaler has to fit and pad instead.
  const convert = rustBody(
    nativeSource,
    "        fn convert_scaled_bgra_to_i420(\n            &mut self,"
  );
  assert.ok(
    convert.includes("letterbox_rect("),
    "the scaler has to fit the source into the frame instead of stretching it"
  );
  const letterbox = rustBody(nativeSource, "fn letterbox_rect(");
  assert.ok(
    letterbox.includes("& !1"),
    "the bars have to stay chroma aligned, or the colour planes shear by half a pixel"
  );
  // A closed window must end the share even when the Closed event never arrives.
  assert.ok(
    rustBody(nativeSource, "        fn spawn_capture_source_watchdog(").includes("IsWindow("),
    "the share has to notice a destroyed window without waiting for an event"
  );
  assert.ok(
    nativeSource.includes("spawn_capture_source_watchdog(\n                request.source_id.clone()"),
    "the watchdog has to be started for every window capture"
  );
});

run("resuming a still window keeps the capture timeline and requests recovery", () => {
  const worker = rustBody(
    nativeSource,
    "        fn run_encoding_worker(\n            frame_slot:"
  );
  assert.ok(
    worker.includes("resumed_after_gap") && worker.includes("media_sender.resume_after_capture_gap()"),
    "a long capture gap must trigger recovery"
  );
  assert.ok(
    !worker.includes("timeline_offset_ns") && !/\benvelope\.capture_time_ns\s*=/.test(worker),
    "real capture timestamps must keep advancing with the audio timeline"
  );
});

run("a viewer can ask which path it is actually on", () => {
  // "Are we on the relay right now?" used to be answerable only by eye, from a
  // status suffix that does not render until the picture settles. A stuck share
  // is exactly the case with no suffix, so the report has to read the same
  // measurements the decisions read and be reachable from the console.
  const report = transportSource.slice(
    transportSource.indexOf("  screenSharePathReport(): Array<{"),
    transportSource.indexOf("  toggleScreenSharePathMenu(")
  );
  assert.ok(report.length > 0, "missing screenSharePathReport");
  assert.ok(
    report.includes("pathKind:") && report.includes("webScreenShareViewerPaths"),
    "the report has to state the path the media is really taking"
  );
  assert.ok(
    report.includes("relayCandidates") && report.includes("framesDecoded"),
    "and enough counters to tell a dead path from a slow one"
  );
  assert.ok(
    transportSource.includes("__evScreenSharePaths"),
    "the report must be reachable from the console of a release build"
  );
});

run("the path is named before the picture arrives", () => {
  // Naming the path only on a settled picture hides it exactly when it matters:
  // a share that never starts, or one that froze after a path switch.
  assert.ok(
    controllerSource.includes("screenSharePathStatusSuffix("),
    "the label has to come from the one helper that also handles the unknown case"
  );
  const answerSent = controllerSource.slice(
    controllerSource.indexOf(`if (status.stage === "answer-sent") {`),
    controllerSource.indexOf(`if (status.stage === "track-received")`)
  );
  assert.ok(
    answerSent.includes("watchStatusPathSuffix(status)"),
    "the path must be named while the viewer is still waiting for its first frame"
  );
  assert.ok(
    transportSource.includes(`setWatchStatus(boundShareId, { pathKind: "unknown" })`),
    "a rebuilt connection must forget the previous path instead of repeating it"
  );
});

for (const result of results) console.log(`ok - ${result}`);

#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use ev_media::{
    FramePumpDecision, ScreenShareFramePump, ScreenShareSourceKind, ScreenShareVideoProfile,
    VideoFrameRate, VideoSize,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

mod native_opus;
mod native_voice;
mod remote_control;
mod rtc_config;
mod screen_share_rtp;

#[cfg(target_os = "windows")]
mod native_screen_content;
#[cfg(target_os = "windows")]
mod windows_media_foundation_encoder;
#[cfg(target_os = "windows")]
mod windows_texture_encoder;

#[cfg(target_os = "windows")]
mod windows_process_loopback;

const KEYRING_SERVICE: &str = "EchoVoice";
const NATIVE_SCREEN_SHARE_STATUS_EVENT: &str = "native-screen-share-sender-status";
const NATIVE_SCREEN_SHARE_STATUS_INTERVAL_MS: i64 = 500;
const NATIVE_SCREEN_SHARE_PREVIEW_STATUS_INTERVAL_MS: i64 = 125;

#[derive(Debug, Serialize)]
struct DesktopInfo {
    name: &'static str,
    version: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCaptureSource {
    source_id: String,
    kind: String,
    name: String,
    app_name: Option<String>,
    process_id: Option<u32>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    is_primary: bool,
    is_current_app: bool,
    thumbnail_data_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCaptureSources {
    backend: String,
    sources: Vec<DesktopCaptureSource>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAudioProcessSource {
    source_id: String,
    process_id: u32,
    name: String,
    app_name: Option<String>,
    icon_data_url: Option<String>,
    active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAudioProcessSources {
    backend: String,
    sources: Vec<DesktopAudioProcessSource>,
    warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfiguredHardwareProfile {
    width: u32,
    height: u32,
    frame_rates: Vec<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMediaCapabilities {
    platform: String,
    runtime: String,
    source_enumeration: bool,
    thumbnails: bool,
    native_screen_share_sender: bool,
    web_capture_fallback: bool,
    supported_frame_rates: Vec<u32>,
    max_native_frame_rate: u32,
    hardware_h264_encoder: bool,
    configured_hardware_profiles: Vec<ConfiguredHardwareProfile>,
    remote_control_host: bool,
    remote_control_source_kinds: Vec<String>,
    supported_source_kinds: Vec<String>,
    video_backends: Vec<String>,
    audio_backends: Vec<String>,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeScreenShareStartRequest {
    server_id: String,
    channel_id: String,
    share_id: String,
    owner_member_id: String,
    source_id: String,
    source_kind: String,
    #[serde(default)]
    source_process_id: Option<u32>,
    #[serde(default)]
    source_x: i32,
    #[serde(default)]
    source_y: i32,
    #[serde(default)]
    source_width: i32,
    #[serde(default)]
    source_height: i32,
    width: i32,
    height: i32,
    frame_rate: i32,
    #[serde(default)]
    target_bitrate_bps: Option<u32>,
    #[serde(default = "default_screen_share_content_mode")]
    content_mode: String,
    #[serde(default = "default_true")]
    capture_cursor: bool,
    #[serde(default = "default_true")]
    preview_enabled: bool,
    include_audio: bool,
    remote_control_allowed: bool,
    #[serde(default)]
    ice_servers: Vec<rtc_config::NativeRTCIceServer>,
}

fn default_screen_share_content_mode() -> String {
    "balanced".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeScreenShareSenderSession {
    session_id: String,
    share_id: String,
    source_id: String,
    width: i32,
    height: i32,
    frame_rate: i32,
    audio_enabled: bool,
    phase: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeScreenPipelineStats {
    texture_copies: u64,
    wgc_frames_received: u64,
    wgc_frames_replaced: u64,
    readback_frames: u64,
    gpu_local_budget_bytes: Option<u64>,
    gpu_process_usage_bytes: Option<u64>,
    readback_micros: u64,
    capture_age_samples: u64,
    capture_age_micros: u64,
    high_encode_calls: u64,
    encoded_bytes: u64,
    effective_content_mode: Option<String>,
    smart_reason: Option<String>,
    encoder_fallback_reason: Option<String>,
    high_encode_call_micros: u64,
    hardware_outputs: u64,
    hardware_residence_micros: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeScreenShareSenderStatus {
    session_id: String,
    share_id: String,
    phase: String,
    backend: String,
    viewer_member_ids: Vec<String>,
    /// "direct" or "relay" per viewer member id, recorded when its connection
    /// comes up. The sharer cannot otherwise tell a weak uplink from a relayed
    /// detour, and both look identical from inside the encoder.
    viewer_paths: HashMap<String, String>,
    /// "high" or "low" per viewer member id: which encode that viewer's track is
    /// fed from. Without it a sharer cannot tell whether a blurry viewer is on
    /// the reduced tier or simply has a weak link.
    viewer_layers: HashMap<String, String>,
    low_tier_viewers: usize,
    low_tier_bitrate_bps: Option<u32>,
    target_bitrate_bps: u32,
    effective_bitrate_bps: u32,
    receiver_estimated_bitrate_bps: Option<u32>,
    captured_frames: u64,
    forwarded_frames: u64,
    encoded_frames: u64,
    pipeline: NativeScreenPipelineStats,
    dropped_frames: u64,
    throttled_frames: u64,
    encoder_backpressure_drops: u64,
    viewer_backpressure_drops: u64,
    audio_queue_drops: u64,
    audio_samples_sent: u64,
    audio_capture_errors: u64,
    audio_send_errors: u64,
    started_at_ms: i64,
    last_frame_at_ms: i64,
    preview_enabled: bool,
    preview_data_url: Option<String>,
    preview_updated_at_ms: i64,
    applied_answer_count: u64,
    applied_ice_candidate_count: u64,
    ignored_viewer_signal_count: u64,
    native_peer_connection_state: String,
    native_ice_connection_state: String,
    native_ice_gathering_state: String,
    sample_write_count: u64,
    sample_write_error_count: u64,
    last_sample_write_error: Option<String>,
    last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeScreenShareViewerRequest {
    session_id: String,
    member_id: String,
    #[serde(default)]
    watch_session_id: String,
    /// Set when the viewer told us it is watching through the relay. A
    /// relay-only viewer sends nothing but relay candidates, and webrtc-ice
    /// applies its relay acceptance wait to both ends of a pair, so without this
    /// hint the sender waits a full second before it can nominate - and DTLS
    /// cannot start until it does.
    #[serde(default)]
    relay_only: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeScreenSharePreviewRequest {
    session_id: String,
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeScreenShareSignalRequest {
    session_id: String,
    member_id: String,
    signal_type: String,
    data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeScreenShareOutboundSignal {
    member_id: String,
    signal_type: String,
    data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredServer {
    server_id: String,
    name: String,
    #[serde(default)]
    icon_data_url: String,
    base_url: String,
    member_id: String,
    last_connected_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCredential {
    #[serde(rename = "baseUrl")]
    base_url: String,
    server_id: String,
    member_id: String,
    access_key: String,
}

#[tauri::command]
fn desktop_info() -> DesktopInfo {
    DesktopInfo {
        name: "EchoVoice",
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
fn list_desktop_capture_sources() -> Result<DesktopCaptureSources, String> {
    desktop_capture::list_sources()
}

#[tauri::command]
async fn list_desktop_audio_process_sources() -> Result<DesktopAudioProcessSources, String> {
    #[cfg(target_os = "windows")]
    {
        return tauri::async_runtime::spawn_blocking(
            windows_process_loopback::list_process_sources,
        )
        .await
        .map_err(|err| format!("list desktop audio processes task failed: {err}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(DesktopAudioProcessSources {
            backend: "unsupported".to_string(),
            sources: Vec::new(),
            warnings: vec![
                "process audio capture is currently available on Windows only".to_string(),
            ],
        })
    }
}

#[tauri::command]
async fn desktop_media_capabilities() -> Result<DesktopMediaCapabilities, String> {
    tauri::async_runtime::spawn_blocking(desktop_capture::media_capabilities)
        .await
        .map_err(|err| format!("probe desktop media capabilities: {err}"))
}

#[tauri::command]
fn start_native_screen_share_sender(
    app: AppHandle,
    manager: State<'_, NativeScreenShareManager>,
    request: NativeScreenShareStartRequest,
) -> Result<NativeScreenShareSenderSession, String> {
    let result = manager.start_sender(app, request);
    if let Err(err) = &result {
        eprintln!("EchoVoice native screen share start failed: {err}");
    }
    result
}

#[tauri::command]
fn stop_native_screen_share_sender(
    manager: State<'_, NativeScreenShareManager>,
    remote_control_manager: State<'_, remote_control::RemoteControlHostManager>,
    session_id: String,
) -> Result<(), String> {
    remote_control_manager.stop_for_sender(&session_id)?;
    manager.stop_sender(&session_id)
}

#[tauri::command]
fn start_native_remote_control_host(
    app: AppHandle,
    screen_share_manager: State<'_, NativeScreenShareManager>,
    remote_control_manager: State<'_, remote_control::RemoteControlHostManager>,
    request: remote_control::RemoteControlHostStartRequest,
) -> Result<(), String> {
    let target = screen_share_manager.remote_control_target(&request.sender_session_id)?;
    remote_control_manager.start(app, request, target)
}

#[tauri::command]
fn stop_native_remote_control_host(
    remote_control_manager: State<'_, remote_control::RemoteControlHostManager>,
    request: remote_control::RemoteControlHostStopRequest,
) -> Result<(), String> {
    remote_control_manager.stop(&request.control_id)
}

#[tauri::command]
fn apply_native_remote_control_input(
    remote_control_manager: State<'_, remote_control::RemoteControlHostManager>,
    request: remote_control::RemoteControlInputRequest,
) -> Result<(), String> {
    remote_control_manager.apply(request)
}

#[tauri::command]
fn native_screen_share_sender_status(
    manager: State<'_, NativeScreenShareManager>,
    session_id: String,
) -> Result<NativeScreenShareSenderStatus, String> {
    manager.sender_status(&session_id)
}

#[tauri::command]
fn native_screen_share_sender_set_preview_enabled(
    manager: State<'_, NativeScreenShareManager>,
    request: NativeScreenSharePreviewRequest,
) -> Result<NativeScreenShareSenderStatus, String> {
    manager.set_preview_enabled(&request.session_id, request.enabled)
}

#[tauri::command]
fn native_screen_share_sender_add_viewer(
    manager: State<'_, NativeScreenShareManager>,
    request: NativeScreenShareViewerRequest,
) -> Result<NativeScreenShareSenderStatus, String> {
    manager.add_viewer(
        &request.session_id,
        &request.member_id,
        &request.watch_session_id,
        request.relay_only,
    )
}

#[tauri::command]
fn native_screen_share_sender_remove_viewer(
    manager: State<'_, NativeScreenShareManager>,
    request: NativeScreenShareViewerRequest,
) -> Result<NativeScreenShareSenderStatus, String> {
    manager.remove_viewer(
        &request.session_id,
        &request.member_id,
        &request.watch_session_id,
    )
}

#[tauri::command]
fn native_screen_share_sender_handle_signal(
    manager: State<'_, NativeScreenShareManager>,
    request: NativeScreenShareSignalRequest,
) -> Result<NativeScreenShareSenderStatus, String> {
    manager.handle_viewer_signal(&request)
}

#[tauri::command]
async fn native_screen_share_sender_set_quality(
    manager: State<'_, NativeScreenShareManager>,
    session_id: String,
    setting: NativeScreenShareQualitySetting,
) -> Result<NativeScreenShareSenderStatus, String> {
    let (status, control) = manager.sender_runtime_parts(&session_id)?;
    let (completed, ack) = tokio::sync::oneshot::channel();
    control
        .send(NativeScreenShareControl::SetQuality { setting, completed })
        .map_err(|_| "native screen share worker is not running".to_string())?;
    ack.await
        .map_err(|_| "native screen share worker stopped before applying quality".to_string())??;
    let snapshot = status
        .lock()
        .map_err(|_| "native screen share status is poisoned".to_string())?
        .status_snapshot();
    Ok(snapshot)
}

#[tauri::command]
fn native_screen_share_sender_drain_signals(
    manager: State<'_, NativeScreenShareManager>,
    session_id: String,
) -> Result<Vec<NativeScreenShareOutboundSignal>, String> {
    manager.drain_outbound_signals(&session_id)
}

#[tauri::command]
fn load_servers(app: AppHandle) -> Result<Vec<StoredServer>, String> {
    read_servers(&app)
}

#[tauri::command]
fn save_server(app: AppHandle, server: StoredServer) -> Result<(), String> {
    let mut servers = read_servers(&app)?;
    servers.retain(|item| item.server_id != server.server_id);
    servers.push(server);
    servers.sort_by(|left, right| right.last_connected_at_ms.cmp(&left.last_connected_at_ms));
    write_servers(&app, &servers)
}

#[tauri::command]
fn remove_server(app: AppHandle, server_id: String) -> Result<(), String> {
    let mut servers = read_servers(&app)?;
    servers.retain(|item| item.server_id != server_id);
    write_servers(&app, &servers)
}

#[tauri::command]
fn load_server_credential(server_id: String) -> Result<Option<StoredCredential>, String> {
    let entry = credential_entry(&server_id)?;
    match entry.get_password() {
        Ok(raw) => {
            let credential = serde_json::from_str::<StoredCredential>(&raw)
                .map_err(|err| format!("parse credential: {err}"))?;
            Ok(Some(credential))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("load credential: {err}")),
    }
}

#[tauri::command]
fn save_server_credential(credential: StoredCredential) -> Result<(), String> {
    let raw =
        serde_json::to_string(&credential).map_err(|err| format!("serialize credential: {err}"))?;
    credential_entry(&credential.server_id)?
        .set_password(&raw)
        .map_err(|err| format!("save credential: {err}"))
}

#[tauri::command]
fn delete_server_credential(server_id: String) -> Result<(), String> {
    let entry = credential_entry(&server_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("delete credential: {err}")),
    }
}

#[tauri::command]
// Keep this command async. Building a WebView window from a synchronous invoke can
// deadlock the Windows UI thread and leave both the popout and main window frozen.
async fn open_screen_share_popout(
    app: AppHandle,
    share_id: String,
    title: String,
) -> Result<(), String> {
    let safe_share_id: String = share_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if safe_share_id.is_empty() {
        return Err("share id is required".to_string());
    }
    let label = format!("screen-share-{safe_share_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window
            .show()
            .map_err(|err| format!("show screen share popout: {err}"))?;
        return window
            .set_focus()
            .map_err(|err| format!("focus screen share popout: {err}"));
    }
    let title = if title.trim().is_empty() {
        "EchoVoice Screen Share".to_string()
    } else {
        title
    };
    let popout_url = PathBuf::from(format!("index.html?screenSharePopout={safe_share_id}"));
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(popout_url))
        .title(title)
        .inner_size(720.0, 405.0)
        .min_inner_size(420.0, 260.0)
        .decorations(false)
        .always_on_top(true)
        .shadow(true)
        .resizable(true)
        .initialization_script("document.documentElement.style.backgroundColor = '#050505';")
        .build()
        .map(|_| ())
        .map_err(|err| format!("open screen share popout: {err}"))
}

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window was not found".to_string())
}

#[tauri::command]
fn desktop_window_minimize(app: AppHandle) -> Result<(), String> {
    main_window(&app)?
        .minimize()
        .map_err(|err| format!("minimize main window: {err}"))
}

#[tauri::command]
fn desktop_window_toggle_maximize(app: AppHandle) -> Result<bool, String> {
    let window = main_window(&app)?;
    let maximized = window
        .is_maximized()
        .map_err(|err| format!("read main window state: {err}"))?;
    if maximized {
        window
            .unmaximize()
            .map_err(|err| format!("restore main window: {err}"))?;
    } else {
        window
            .maximize()
            .map_err(|err| format!("maximize main window: {err}"))?;
    }
    Ok(!maximized)
}

#[tauri::command]
fn desktop_window_is_maximized(app: AppHandle) -> Result<bool, String> {
    main_window(&app)?
        .is_maximized()
        .map_err(|err| format!("read main window state: {err}"))
}

#[tauri::command]
fn desktop_window_start_dragging(app: AppHandle) -> Result<(), String> {
    main_window(&app)?
        .start_dragging()
        .map_err(|err| format!("drag main window: {err}"))
}

#[tauri::command]
fn desktop_window_close(app: AppHandle) -> Result<(), String> {
    main_window(&app)?
        .close()
        .map_err(|err| format!("close main window: {err}"))
}

fn ensure_screen_share_popout(label: &str) -> Result<(), String> {
    if label.starts_with("screen-share-") {
        Ok(())
    } else {
        Err("screen share popout command requires a popout window".to_string())
    }
}

#[tauri::command]
fn screen_share_popout_start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    ensure_screen_share_popout(window.label())?;
    window
        .start_dragging()
        .map_err(|err| format!("drag screen share popout: {err}"))
}

#[tauri::command]
fn screen_share_popout_start_resize_dragging(
    window: tauri::Window,
    direction: String,
) -> Result<(), String> {
    ensure_screen_share_popout(window.label())?;
    let direction = match direction.as_str() {
        "North" => tauri_runtime::ResizeDirection::North,
        "NorthEast" => tauri_runtime::ResizeDirection::NorthEast,
        "East" => tauri_runtime::ResizeDirection::East,
        "SouthEast" => tauri_runtime::ResizeDirection::SouthEast,
        "South" => tauri_runtime::ResizeDirection::South,
        "SouthWest" => tauri_runtime::ResizeDirection::SouthWest,
        "West" => tauri_runtime::ResizeDirection::West,
        "NorthWest" => tauri_runtime::ResizeDirection::NorthWest,
        _ => return Err("invalid screen share popout resize direction".to_string()),
    };
    window
        .start_resize_dragging(direction)
        .map_err(|err| format!("resize screen share popout: {err}"))
}

#[tauri::command]
fn screen_share_popout_close(window: tauri::WebviewWindow) -> Result<(), String> {
    ensure_screen_share_popout(window.label())?;
    window
        .close()
        .map_err(|err| format!("close screen share popout: {err}"))
}

fn read_servers(app: &AppHandle) -> Result<Vec<StoredServer>, String> {
    let path = servers_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|err| format!("read servers: {err}"))?;
    serde_json::from_str(&raw).map_err(|err| format!("parse servers: {err}"))
}

fn write_servers(app: &AppHandle, servers: &[StoredServer]) -> Result<(), String> {
    let path = servers_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("create app data dir: {err}"))?;
    }
    let raw =
        serde_json::to_string_pretty(servers).map_err(|err| format!("serialize servers: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("write servers: {err}"))
}

fn servers_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| format!("resolve app data dir: {err}"))?
        .join("servers.json"))
}

fn credential_entry(server_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("server:{server_id}"))
        .map_err(|err| format!("open keyring entry: {err}"))
}

fn main() {
    tauri::Builder::default()
        .manage(NativeScreenShareManager::default())
        .manage(native_voice::NativeVoiceManager::default())
        .manage(native_voice::NativeMicrophoneTestManager::default())
        .manage(remote_control::RemoteControlHostManager::default())
        .invoke_handler(tauri::generate_handler![
            desktop_info,
            load_servers,
            save_server,
            remove_server,
            load_server_credential,
            save_server_credential,
            delete_server_credential,
            list_desktop_capture_sources,
            list_desktop_audio_process_sources,
            desktop_media_capabilities,
            start_native_screen_share_sender,
            stop_native_screen_share_sender,
            start_native_remote_control_host,
            stop_native_remote_control_host,
            apply_native_remote_control_input,
            native_screen_share_sender_status,
            native_screen_share_sender_set_preview_enabled,
            native_screen_share_sender_add_viewer,
            native_screen_share_sender_remove_viewer,
            native_screen_share_sender_handle_signal,
            native_screen_share_sender_set_quality,
            native_screen_share_sender_drain_signals,
            open_screen_share_popout,
            native_voice::start_native_voice_session,
            native_voice::native_voice_list_devices,
            native_voice::start_native_microphone_test,
            native_voice::native_microphone_test_status,
            native_voice::set_native_microphone_test_levels,
            native_voice::stop_native_microphone_test,
            native_voice::native_voice_test_headphones,
            native_voice::stop_native_voice_session,
            native_voice::native_voice_add_peer,
            native_voice::native_voice_remove_peer,
            native_voice::native_voice_handle_signal,
            native_voice::native_voice_set_state,
            native_voice::native_voice_restart_microphone,
            native_voice::native_voice_set_levels,
            native_voice::native_voice_set_noise_suppression,
            native_voice::native_voice_set_member_volume,
            native_voice::native_voice_set_member_music_volume,
            native_voice::native_voice_start_accompaniment,
            native_voice::native_voice_set_accompaniment_volume,
            native_voice::native_voice_stop_accompaniment,
            native_voice::native_voice_status,
            native_voice::native_voice_drain_signals,
            desktop_window_minimize,
            desktop_window_toggle_maximize,
            desktop_window_is_maximized,
            desktop_window_start_dragging,
            desktop_window_close,
            screen_share_popout_start_dragging,
            screen_share_popout_start_resize_dragging,
            screen_share_popout_close
        ])
        .run(tauri::generate_context!())
        .expect("failed to run EchoVoice desktop");
}

#[derive(Default)]
struct NativeScreenShareManager {
    sessions: Mutex<HashMap<String, NativeScreenShareRuntimeSession>>,
    next_id: AtomicU64,
}

struct NativeScreenShareRuntimeSession {
    status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
    control_tx: mpsc::Sender<NativeScreenShareControl>,
    outbound_signals: Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
    stop_flag: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
    source_id: String,
    source_kind: String,
    source_process_id: Option<u32>,
    source_x: i32,
    source_y: i32,
    source_width: i32,
    source_height: i32,
    remote_control_allowed: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "kebab-case")]
enum NativeScreenShareQualitySetting {
    FrameRate(u32),
    MaxBitrate(u32),
}

#[derive(Debug)]
enum NativeScreenShareControl {
    SetQuality {
        setting: NativeScreenShareQualitySetting,
        completed: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    AddViewer {
        member_id: String,
        watch_session_id: String,
        /// The viewer told us it is watching through the relay, so there is no
        /// direct pair to protect from the ICE acceptance wait.
        relay_only: bool,
    },
    RemoveViewer {
        member_id: String,
        watch_session_id: String,
    },
    HandleSignal {
        member_id: String,
        signal_type: String,
        data: serde_json::Value,
    },
}

#[derive(Debug)]
struct NativeScreenShareRuntimeStatus {
    session_id: String,
    share_id: String,
    source_id: String,
    width: i32,
    height: i32,
    frame_rate: i32,
    audio_enabled: bool,
    phase: String,
    backend: String,
    viewer_member_ids: Vec<String>,
    viewer_paths: HashMap<String, String>,
    viewer_layers: HashMap<String, String>,
    low_tier_viewers: usize,
    low_tier_bitrate_bps: Option<u32>,
    target_bitrate_bps: u32,
    effective_bitrate_bps: u32,
    receiver_estimated_bitrate_bps: Option<u32>,
    captured_frames: u64,
    forwarded_frames: u64,
    encoded_frames: u64,
    pipeline: NativeScreenPipelineStats,
    dropped_frames: u64,
    throttled_frames: u64,
    encoder_backpressure_drops: u64,
    viewer_backpressure_drops: u64,
    audio_queue_drops: u64,
    audio_samples_sent: u64,
    audio_capture_errors: u64,
    audio_send_errors: u64,
    started_at_ms: i64,
    last_frame_at_ms: i64,
    preview_enabled: bool,
    preview_data_url: Option<String>,
    preview_updated_at_ms: i64,
    applied_answer_count: u64,
    applied_ice_candidate_count: u64,
    ignored_viewer_signal_count: u64,
    native_peer_connection_state: String,
    native_ice_connection_state: String,
    native_ice_gathering_state: String,
    sample_write_count: u64,
    sample_write_error_count: u64,
    last_sample_write_error: Option<String>,
    last_error: Option<String>,
}

impl NativeScreenShareManager {
    fn start_sender(
        &self,
        app: AppHandle,
        request: NativeScreenShareStartRequest,
    ) -> Result<NativeScreenShareSenderSession, String> {
        validate_native_screen_share_request(&request)?;
        self.stop_share_sender(&request.share_id);

        let session_id = format!(
            "nss_{}_{}",
            now_ms(),
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let profile = native_screen_share_video_profile(&request)?;
        let target_bitrate_bps = profile.target_bitrate_bps();
        let effective_bitrate_bps = target_bitrate_bps;
        let status = Arc::new(Mutex::new(NativeScreenShareRuntimeStatus {
            session_id: session_id.clone(),
            share_id: request.share_id.clone(),
            source_id: request.source_id.clone(),
            width: request.width,
            height: request.height,
            frame_rate: request.frame_rate,
            audio_enabled: request.include_audio,
            phase: "starting".to_string(),
            backend: "windows-graphics-capture".to_string(),
            viewer_member_ids: Vec::new(),
            viewer_paths: HashMap::new(),
            viewer_layers: HashMap::new(),
            low_tier_viewers: 0,
            low_tier_bitrate_bps: None,
            target_bitrate_bps,
            effective_bitrate_bps,
            receiver_estimated_bitrate_bps: None,
            captured_frames: 0,
            forwarded_frames: 0,
            encoded_frames: 0,
            pipeline: Default::default(),
            dropped_frames: 0,
            throttled_frames: 0,
            encoder_backpressure_drops: 0,
            viewer_backpressure_drops: 0,
            audio_queue_drops: 0,
            audio_samples_sent: 0,
            audio_capture_errors: 0,
            audio_send_errors: 0,
            started_at_ms: now_ms(),
            last_frame_at_ms: 0,
            preview_enabled: request.preview_enabled,
            preview_data_url: None,
            preview_updated_at_ms: 0,
            applied_answer_count: 0,
            applied_ice_candidate_count: 0,
            ignored_viewer_signal_count: 0,
            native_peer_connection_state: "new".to_string(),
            native_ice_connection_state: "new".to_string(),
            native_ice_gathering_state: "new".to_string(),
            sample_write_count: 0,
            sample_write_error_count: 0,
            last_sample_write_error: None,
            last_error: None,
        }));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let (startup_tx, startup_rx) = mpsc::channel();
        let (control_tx, control_rx) = mpsc::channel();
        let outbound_signals = Arc::new(Mutex::new(Vec::new()));
        let worker_status = Arc::clone(&status);
        let worker_stop = Arc::clone(&stop_flag);
        let worker_request = request.clone();
        let worker_session_id = session_id.clone();
        let worker_outbound = Arc::clone(&outbound_signals);
        let worker_app = app.clone();
        let worker = thread::Builder::new()
            .name("ev-native-screen-share".to_string())
            .spawn(move || {
                native_screen_share::run_sender(
                    worker_app,
                    worker_session_id,
                    worker_request,
                    worker_status,
                    worker_stop,
                    startup_tx,
                    control_rx,
                    worker_outbound,
                );
            })
            .map_err(|err| format!("start native screen share worker: {err}"))?;

        match startup_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {
                self.sessions
                    .lock()
                    .map_err(|_| "native screen share manager is poisoned".to_string())?
                    .insert(
                        session_id.clone(),
                        NativeScreenShareRuntimeSession {
                            status: Arc::clone(&status),
                            control_tx,
                            outbound_signals,
                            stop_flag,
                            worker: Some(worker),
                            source_id: request.source_id.clone(),
                            source_kind: request.source_kind.clone(),
                            source_process_id: request.source_process_id,
                            source_x: request.source_x,
                            source_y: request.source_y,
                            source_width: request.source_width,
                            source_height: request.source_height,
                            remote_control_allowed: request.remote_control_allowed,
                        },
                    );
                Ok(status
                    .lock()
                    .map_err(|_| "native screen share status is poisoned".to_string())?
                    .session_snapshot())
            }
            Ok(Err(err)) => {
                let _ = worker.join();
                Err(err)
            }
            Err(_) => {
                stop_flag.store(true, Ordering::SeqCst);
                Err("native screen share worker did not start in time".to_string())
            }
        }
    }

    fn stop_sender(&self, session_id: &str) -> Result<(), String> {
        let runtime = self
            .sessions
            .lock()
            .map_err(|_| "native screen share manager is poisoned".to_string())?
            .remove(session_id);
        if let Some(mut runtime) = runtime {
            runtime.stop_flag.store(true, Ordering::SeqCst);
            if let Some(worker) = runtime.worker.take() {
                let _ = thread::Builder::new()
                    .name("ev-native-screen-share-reaper".to_string())
                    .spawn(move || {
                        let _ = worker.join();
                    });
            }
        }
        Ok(())
    }

    fn sender_status(&self, session_id: &str) -> Result<NativeScreenShareSenderStatus, String> {
        let status = self.sender_status_arc(session_id)?;
        let snapshot = status
            .lock()
            .map_err(|_| "native screen share status is poisoned".to_string())?
            .status_snapshot();
        Ok(snapshot)
    }

    fn set_preview_enabled(
        &self,
        session_id: &str,
        enabled: bool,
    ) -> Result<NativeScreenShareSenderStatus, String> {
        let status = self.sender_status_arc(session_id)?;
        let mut status = status
            .lock()
            .map_err(|_| "native screen share status is poisoned".to_string())?;
        status.preview_enabled = enabled;
        if !enabled {
            status.preview_data_url = None;
            status.preview_updated_at_ms = 0;
        }
        Ok(status.status_snapshot())
    }

    fn remote_control_target(
        &self,
        session_id: &str,
    ) -> Result<remote_control::RemoteControlTarget, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "native screen share manager is poisoned".to_string())?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "native screen share sender session is not running".to_string())?;
        if !session.remote_control_allowed {
            return Err("native screen share did not enable remote control".to_string());
        }
        Ok(remote_control::RemoteControlTarget {
            source_id: session.source_id.clone(),
            source_kind: session.source_kind.clone(),
            source_process_id: session.source_process_id,
            source_x: session.source_x,
            source_y: session.source_y,
            source_width: session.source_width,
            source_height: session.source_height,
        })
    }

    fn add_viewer(
        &self,
        session_id: &str,
        member_id: &str,
        watch_session_id: &str,
        relay_only: bool,
    ) -> Result<NativeScreenShareSenderStatus, String> {
        if member_id.trim().is_empty() {
            return Err("native screen share viewer member id is required".to_string());
        }
        let (status, control_tx) = self.sender_runtime_parts(session_id)?;
        let snapshot = status
            .lock()
            .map_err(|_| "native screen share status is poisoned".to_string())?
            .status_snapshot();
        control_tx
            .send(NativeScreenShareControl::AddViewer {
                member_id: member_id.to_string(),
                watch_session_id: watch_session_id.to_string(),
                relay_only,
            })
            .map_err(|_| "native screen share worker is not running".to_string())?;
        Ok(snapshot)
    }

    fn remove_viewer(
        &self,
        session_id: &str,
        member_id: &str,
        watch_session_id: &str,
    ) -> Result<NativeScreenShareSenderStatus, String> {
        let (status, control_tx) = self.sender_runtime_parts(session_id)?;
        let snapshot = status
            .lock()
            .map_err(|_| "native screen share status is poisoned".to_string())?
            .status_snapshot();
        control_tx
            .send(NativeScreenShareControl::RemoveViewer {
                member_id: member_id.to_string(),
                watch_session_id: watch_session_id.to_string(),
            })
            .map_err(|_| "native screen share worker is not running".to_string())?;
        Ok(snapshot)
    }

    fn handle_viewer_signal(
        &self,
        request: &NativeScreenShareSignalRequest,
    ) -> Result<NativeScreenShareSenderStatus, String> {
        if request.member_id.trim().is_empty() {
            return Err("native screen share signal member id is required".to_string());
        }
        if !matches!(
            request.signal_type.as_str(),
            "screen-share-answer" | "screen-share-ice-candidate" | "screen-share-restart-ice"
        ) {
            return Err("native screen share signal type is unsupported".to_string());
        }
        let (status, control_tx) = self.sender_runtime_parts(&request.session_id)?;
        let snapshot = status
            .lock()
            .map_err(|_| "native screen share status is poisoned".to_string())?
            .status_snapshot();
        control_tx
            .send(NativeScreenShareControl::HandleSignal {
                member_id: request.member_id.clone(),
                signal_type: request.signal_type.clone(),
                data: request.data.clone(),
            })
            .map_err(|_| "native screen share worker is not running".to_string())?;
        Ok(snapshot)
    }

    fn drain_outbound_signals(
        &self,
        session_id: &str,
    ) -> Result<Vec<NativeScreenShareOutboundSignal>, String> {
        let outbound_signals = self
            .sessions
            .lock()
            .map_err(|_| "native screen share manager is poisoned".to_string())?
            .get(session_id)
            .map(|runtime| Arc::clone(&runtime.outbound_signals))
            .ok_or_else(|| {
                format!("native screen share sender session is not running: {session_id}")
            })?;
        let mut signals = outbound_signals
            .lock()
            .map_err(|_| "native screen share signal queue is poisoned".to_string())?;
        Ok(signals.drain(..).collect())
    }

    fn sender_runtime_parts(
        &self,
        session_id: &str,
    ) -> Result<
        (
            Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            mpsc::Sender<NativeScreenShareControl>,
        ),
        String,
    > {
        self.sessions
            .lock()
            .map_err(|_| "native screen share manager is poisoned".to_string())?
            .get(session_id)
            .map(|runtime| (Arc::clone(&runtime.status), runtime.control_tx.clone()))
            .ok_or_else(|| {
                format!("native screen share sender session is not running: {session_id}")
            })
    }

    fn sender_status_arc(
        &self,
        session_id: &str,
    ) -> Result<Arc<Mutex<NativeScreenShareRuntimeStatus>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "native screen share manager is poisoned".to_string())?
            .get(session_id)
            .map(|runtime| Arc::clone(&runtime.status))
            .ok_or_else(|| {
                format!("native screen share sender session is not running: {session_id}")
            })
    }

    fn stop_share_sender(&self, share_id: &str) {
        let session_ids = self
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .filter_map(|(session_id, runtime)| {
                        runtime
                            .status
                            .lock()
                            .ok()
                            .filter(|status| status.share_id == share_id)
                            .map(|_| session_id.clone())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for session_id in session_ids {
            let _ = self.stop_sender(&session_id);
        }
    }
}

impl NativeScreenShareRuntimeStatus {
    fn session_snapshot(&self) -> NativeScreenShareSenderSession {
        NativeScreenShareSenderSession {
            session_id: self.session_id.clone(),
            share_id: self.share_id.clone(),
            source_id: self.source_id.clone(),
            width: self.width,
            height: self.height,
            frame_rate: self.frame_rate,
            audio_enabled: self.audio_enabled,
            phase: self.phase.clone(),
        }
    }

    fn status_snapshot(&self) -> NativeScreenShareSenderStatus {
        NativeScreenShareSenderStatus {
            session_id: self.session_id.clone(),
            share_id: self.share_id.clone(),
            phase: self.phase.clone(),
            backend: self.backend.clone(),
            viewer_member_ids: self.viewer_member_ids.clone(),
            viewer_paths: self.viewer_paths.clone(),
            viewer_layers: self.viewer_layers.clone(),
            low_tier_viewers: self.low_tier_viewers,
            low_tier_bitrate_bps: self.low_tier_bitrate_bps,
            target_bitrate_bps: self.target_bitrate_bps,
            effective_bitrate_bps: self.effective_bitrate_bps,
            receiver_estimated_bitrate_bps: self.receiver_estimated_bitrate_bps,
            captured_frames: self.captured_frames,
            forwarded_frames: self.forwarded_frames,
            encoded_frames: self.encoded_frames,
            pipeline: self.pipeline.clone(),
            dropped_frames: self.dropped_frames,
            throttled_frames: self.throttled_frames,
            encoder_backpressure_drops: self.encoder_backpressure_drops,
            viewer_backpressure_drops: self.viewer_backpressure_drops,
            audio_queue_drops: self.audio_queue_drops,
            audio_samples_sent: self.audio_samples_sent,
            audio_capture_errors: self.audio_capture_errors,
            audio_send_errors: self.audio_send_errors,
            started_at_ms: self.started_at_ms,
            last_frame_at_ms: self.last_frame_at_ms,
            preview_enabled: self.preview_enabled,
            preview_data_url: self.preview_data_url.clone(),
            preview_updated_at_ms: self.preview_updated_at_ms,
            applied_answer_count: self.applied_answer_count,
            applied_ice_candidate_count: self.applied_ice_candidate_count,
            ignored_viewer_signal_count: self.ignored_viewer_signal_count,
            native_peer_connection_state: self.native_peer_connection_state.clone(),
            native_ice_connection_state: self.native_ice_connection_state.clone(),
            native_ice_gathering_state: self.native_ice_gathering_state.clone(),
            sample_write_count: self.sample_write_count,
            sample_write_error_count: self.sample_write_error_count,
            last_sample_write_error: self.last_sample_write_error.clone(),
            last_error: self.last_error.clone(),
        }
    }
}

fn validate_native_screen_share_request(
    request: &NativeScreenShareStartRequest,
) -> Result<(), String> {
    if request.server_id.trim().is_empty()
        || request.channel_id.trim().is_empty()
        || request.share_id.trim().is_empty()
        || request.owner_member_id.trim().is_empty()
    {
        return Err("native screen share request is missing session identity".to_string());
    }
    if request.source_id.trim().is_empty() {
        return Err("native screen share source is required".to_string());
    }
    let source_kind = ScreenShareSourceKind::try_from(request.source_kind.as_str())
        .map_err(|_| "native screen share source kind is unsupported".to_string())?;
    let source_kind_supported = matches!(
        source_kind,
        ScreenShareSourceKind::Screen | ScreenShareSourceKind::Window
    );
    #[cfg(test)]
    let source_kind_supported =
        source_kind_supported || matches!(source_kind, ScreenShareSourceKind::Synthetic);
    if !source_kind_supported {
        return Err("native screen share source kind is unsupported".to_string());
    }
    if !matches!(
        request.content_mode.as_str(),
        "detail" | "balanced" | "motion" | "smart"
    ) {
        return Err("native screen share content mode is unsupported".to_string());
    }
    let profile = native_screen_share_video_profile(request)?;
    if profile.required_h264_level_idc().is_none() {
        return Err("native screen share profile exceeds the supported H.264 limits".to_string());
    }
    let _ = request.remote_control_allowed;
    Ok(())
}

fn native_screen_share_video_profile(
    request: &NativeScreenShareStartRequest,
) -> Result<ScreenShareVideoProfile, String> {
    let source_kind = ScreenShareSourceKind::try_from(request.source_kind.as_str())
        .map_err(|_| "native screen share source kind is unsupported".to_string())?;
    let width = u32::try_from(request.width)
        .map_err(|_| "native screen share resolution is out of range".to_string())?;
    let height = u32::try_from(request.height)
        .map_err(|_| "native screen share resolution is out of range".to_string())?;
    let fps = u32::try_from(request.frame_rate)
        .map_err(|_| "native screen share frame rate is out of range".to_string())?;
    let output_size = VideoSize::new(width, height)
        .map_err(|_| "native screen share resolution is out of range".to_string())?;
    let frame_rate = VideoFrameRate::new(fps)
        .map_err(|_| "native screen share frame rate is out of range".to_string())?;
    let profile = ScreenShareVideoProfile::new(source_kind, output_size, frame_rate);
    Ok(match request.target_bitrate_bps {
        Some(target_bitrate_bps) => profile.with_target_bitrate_bps(target_bitrate_bps),
        None => profile,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

mod native_screen_share {
    use super::{
        native_screen_share_video_profile, now_ms, FramePumpDecision, NativeScreenShareControl,
        NativeScreenShareOutboundSignal, NativeScreenShareRuntimeStatus,
        NativeScreenShareStartRequest, ScreenShareFramePump,
        NATIVE_SCREEN_SHARE_PREVIEW_STATUS_INTERVAL_MS, NATIVE_SCREEN_SHARE_STATUS_EVENT,
        NATIVE_SCREEN_SHARE_STATUS_INTERVAL_MS,
    };
    use crate::native_opus::Encoder as OpusEncoder;
    use crate::screen_share_rtp::{same_h264_subprofile, video_tick, ScreenSharePacketizer};
    use base64::{engine::general_purpose, Engine as _};
    use bytes::Bytes;
    use image::codecs::jpeg::JpegEncoder;
    use image::{ColorType, ImageEncoder};
    use openh264::encoder::{
        BitRate, Complexity, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, Level, Profile,
        RateControlMode, UsageType, VuiConfig,
    };
    use openh264::formats::YUVSlices;
    use openh264::OpenH264API;
    use rayon::prelude::*;
    use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
    use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
    use rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate;
    use serde_json::json;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use tokio::runtime::{Builder as TokioRuntimeBuilder, Runtime};
    use tokio::sync::{mpsc as tokio_mpsc, Notify};
    use tokio::task::JoinHandle as TokioJoinHandle;
    #[cfg(test)]
    use webrtc::api::interceptor_registry::register_default_interceptors;
    use webrtc::api::interceptor_registry::{configure_nack, configure_rtcp_reports};
    use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264, MIME_TYPE_OPUS};
    use webrtc::api::setting_engine::SettingEngine;
    use webrtc::api::APIBuilder;
    use webrtc::ice::candidate::CandidateType;
    use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
    use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
    use webrtc::ice_transport::ice_gatherer_state::RTCIceGathererState;
    use webrtc::ice_transport::ice_gathering_state::RTCIceGatheringState;
    use webrtc::interceptor::registry::Registry;
    use webrtc::peer_connection::configuration::RTCConfiguration;
    use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
    #[cfg(test)]
    use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
    use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
    use webrtc::peer_connection::RTCPeerConnection;
    use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
    use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecParameters;
    use webrtc::rtp_transceiver::rtp_codec::RTCRtpHeaderExtensionCapability;
    use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
    use webrtc::rtp_transceiver::RTCPFeedback;
    use webrtc::stats::{StatsReport, StatsReportType};
    use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
    use webrtc::track::track_local::TrackLocal;
    use yuvutils_rs::{
        bgra_to_yuv420, BufferStoreMut, YuvConversionMode, YuvPlanarImageMut, YuvRange,
        YuvStandardMatrix,
    };

    /// Which path a viewer's media actually takes. A relayed connection has a
    /// relay candidate on at least one end, so one is enough to say "relayed".
    fn classify_candidate_types(
        local: Option<CandidateType>,
        remote: Option<CandidateType>,
    ) -> &'static str {
        match (local, remote) {
            (Some(CandidateType::Relay), _) | (_, Some(CandidateType::Relay)) => "relay",
            (Some(CandidateType::Unspecified), _)
            | (_, Some(CandidateType::Unspecified))
            | (None, _)
            | (_, None) => "unknown",
            _ => "direct",
        }
    }

    /// One failed write is worth one keyframe request.
    ///
    /// A viewer that closed its tab keeps failing every sample, and asking for
    /// a keyframe on each failure turns the shared stream into a stream of IDRs
    /// - which every *live* viewer then has to pay for out of the same bitrate
    /// budget.
    fn keyframe_after_write_error(consecutive_write_errors: u32) -> bool {
        consecutive_write_errors == 1
    }

    /// Resolve the nominated candidate pair of a connection into a path.
    fn classify_viewer_path(stats: &StatsReport) -> Option<&'static str> {
        let pair = stats.reports.values().find_map(|report| match report {
            StatsReportType::CandidatePair(pair) if pair.nominated => Some(pair),
            _ => None,
        })?;
        let candidate_type = |id: &str| match stats.reports.get(id) {
            Some(StatsReportType::LocalCandidate(candidate)) => Some(candidate.candidate_type),
            Some(StatsReportType::RemoteCandidate(candidate)) => Some(candidate.candidate_type),
            _ => None,
        };
        Some(classify_candidate_types(
            candidate_type(&pair.local_candidate_id),
            candidate_type(&pair.remote_candidate_id),
        ))
    }

    struct NativeWebRtcSender {
        share_id: String,
        runtime: Arc<Runtime>,
        outbound_signals: Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
        status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
        // Shared behind an `Arc` so the per-viewer RTCP reader can move a viewer
        // between tiers the moment its receiver estimate says so.
        viewers: Arc<Mutex<HashMap<String, NativeWebRtcViewer>>>,
        pending_viewers: Mutex<HashMap<String, String>>,
        viewer_close_tasks: Mutex<Vec<TokioJoinHandle<()>>>,
        keyframe_requested: Arc<AtomicBool>,
        video_codec: RTCRtpCodecCapability,
        observed_sps: tokio::sync::watch::Sender<Option<String>>,
        observed_compatibility_sps: Mutex<Option<String>>,
        capture_started: AtomicBool,
        audio_codec: Option<RTCRtpCodecCapability>,
        viewer_media_queue_capacity: usize,
        rtc_configuration: RTCConfiguration,
        effective_bitrate_bps: Arc<AtomicU32>,
        bitrate_controller: Arc<Mutex<NativeScreenShareBitrateController>>,
        target_frame_rate: Arc<AtomicU32>,
        startup_profile: super::ScreenShareVideoProfile,
    }

    struct NativeScreenShareViewerBitrateEstimate {
        bitrate_bps: u32,
        updated_at: Instant,
    }

    /// A low estimate that is waiting to be confirmed before it lowers the
    /// bitrate for every viewer.
    struct NativeScreenShareLowEstimateHold {
        ceiling_bps: u32,
        since: Instant,
    }

    struct NativeScreenShareBitrateController {
        maximum_bitrate_bps: u32,
        effective_bitrate_bps: u32,
        // The highest rate this share has already proven it can carry to a
        // live viewer. Receiver estimates describe what the path is delivering
        // right now, not what it can deliver, so once the encoder is held down
        // the estimates stay low and the picture never recovers on its own.
        // Remembering the proven peak gives the controller a target it knows
        // the path has already reached.
        peak_bitrate_bps: u32,
        last_estimate_ceiling_bps: u32,
        viewer_estimates: HashMap<String, NativeScreenShareViewerBitrateEstimate>,
        // Which encode each viewer is subscribed to. Only the high-tier
        // estimates constrain the full-quality encoder.
        viewer_layers: HashMap<String, ScreenShareLayer>,
        // Consecutive estimates above the promotion threshold. A single report
        // is not enough to move a viewer back up: the estimator overshoots
        // right after congestion clears.
        viewer_upgrade_samples: HashMap<String, u8>,
        low_estimate_hold: Option<NativeScreenShareLowEstimateHold>,
        last_increase_at: Instant,
        last_backpressure_at: Option<Instant>,
        last_backpressure_reduction_at: Option<Instant>,
    }

    const NATIVE_SCREEN_SHARE_MIN_BITRATE_BPS: u32 = 1_500_000;
    const NATIVE_SCREEN_SHARE_REMB_HEADROOM_PERCENT: u32 = 85;
    // One encoder serves every viewer, so a single congested receiver pulls the
    // whole room down. Climbing back at ten percent every two seconds meant a
    // two second dip stayed visibly blurry for close to a minute; a quarter per
    // second recovers in roughly a tenth of that while still yielding to the
    // next congestion report, which arrives about once per second.
    const NATIVE_SCREEN_SHARE_BITRATE_INCREASE_INTERVAL: Duration = Duration::from_secs(1);
    const NATIVE_SCREEN_SHARE_BITRATE_INCREASE_DIVISOR: u32 = 4;
    const NATIVE_SCREEN_SHARE_MIN_BITRATE_INCREASE_BPS: u32 = 500_000;
    const NATIVE_SCREEN_SHARE_ESTIMATE_MAX_AGE: Duration = Duration::from_secs(5);
    const NATIVE_SCREEN_SHARE_MIN_BITRATE_CHANGE_BPS: u32 = 250_000;
    // A viewer that has just joined reports a low bandwidth estimate until its
    // receiver-side estimator converges, and one encoder feeds every viewer, so
    // acting on that first report blurs the room for one newcomer's warm-up.
    // Congestion reports arrive about once per second; waiting a little longer
    // than that separates a genuine congested viewer from a still-converging
    // one, at the cost of about one second of extra queueing for the former.
    const NATIVE_SCREEN_SHARE_ESTIMATE_SETTLE: Duration = Duration::from_millis(1_200);
    // A viewer that cannot drain its queue reports backpressure once per queue
    // refill, which at sixty frames per second is roughly every hundred
    // milliseconds. Cutting the bitrate on every one of those reports strips
    // more than eighty percent of it within a single second and keeps it there
    // for as long as the slow viewer stays connected, so one Wi-Fi viewer turns
    // the room permanently blurry. The same viewer also reports a receiver
    // estimate about once per second; one backpressure reduction per second
    // converges on its capacity without collapsing everyone else first.
    const NATIVE_SCREEN_SHARE_BACKPRESSURE_INTERVAL: Duration = Duration::from_secs(1);
    // A refused write or a lost frame asks the encoder for an intra frame. Those
    // requests arrive on consecutive frames while a viewer is stalled, and a
    // keyframe costs many times a normal frame, so an unbounded request storm
    // saturates the link that dropped the frame in the first place. Half a
    // second is libwebrtc's own floor for keyframe requests and still recovers a
    // stalled viewer within a couple of frames.
    // A receiver estimate describes the rate the path is delivering, not the
    // rate it could deliver: once the encoder is held down, the estimate that
    // comes back is derived from the reduced stream and stays low. Only a send
    // rate that exceeds the estimate can discover the real ceiling, so the
    // controller lets itself probe a little above it while the link is quiet.
    const NATIVE_SCREEN_SHARE_PROBE_STEP_PERCENT: u32 = 115;
    const NATIVE_SCREEN_SHARE_MIN_KEYFRAME_INTERVAL: Duration = Duration::from_millis(500);
    // How often the encoder wakes up with no new capture frame to see whether
    // somebody still needs a keyframe. A still desktop produces no frames at
    // all, so without this wake-up a dropped reference frame freezes the
    // picture forever while the audio keeps playing.
    /// The client stops the share when it sees this failure, because nothing can
    /// resume once the shared window is gone: it is a contract, not a log line.
    const CAPTURE_SOURCE_CLOSED_ERROR: &str = "capture source closed";
    const SCREEN_SHARE_IDLE_KEYFRAME_INTERVAL: Duration = Duration::from_millis(120);
    // A window that is minimized or fully covered stops being composited, so the
    // capture goes silent even though sharing continues. When it comes back, the
    // frame carries a capture timestamp from before the gap: passing that gap on
    // to the RTP timeline hands the viewer a multi-second frame duration, which
    // is exactly the jump forward a viewer sees. Anything past half a second is
    // treated as a restart rather than as one very long frame.
    const SCREEN_SHARE_CAPTURE_GAP_NS: u64 = 500_000_000;
    // One encode used to serve every viewer, so the receiver estimate of the
    // slowest viewer set the bitrate for the whole room: a distant participant
    // joining the share softened the picture for the people sitting next to the
    // sharer, and nothing they did could win it back while that viewer stayed.
    // Two tiers fix that by giving a link that cannot carry the full-quality
    // encode its own, cheaper encode instead of a share of the same one.
    //
    // The bands are far apart on purpose. A viewer hopping between tiers loses
    // its reference frames on every hop, which shows up as a freeze, so the
    // controller only demotes below the enter threshold and only promotes after
    // the exit threshold was confirmed twice.
    //
    // The comparison is relative, not absolute. An absolute threshold cannot
    // tell "this link is slow" from "the whole room is running slow": on a share
    // already held at 4 Mbps, a distant viewer reporting 4 Mbps is
    // indistinguishable from the viewer sitting next to the sharer, so the
    // shared encode never leaves that rate. What decides a viewer's tier is
    // whether it can carry the rate the share is aiming at — the configured
    // ceiling, capped by the strongest viewer's estimate. A viewer materially
    // below that reference is the one holding the room back, and it is the only
    // one worth demoting.
    const NATIVE_SCREEN_SHARE_LOW_TIER_RELATIVE_PERCENT: u32 = 85;
    const NATIVE_SCREEN_SHARE_LOW_TIER_PROMOTE_PERCENT: u32 = 95;
    const NATIVE_SCREEN_SHARE_LOW_TIER_UPGRADE_SAMPLES: u8 = 2;
    // `ev_media` rejects anything below 1.5 Mbps, and 1.5 Mbps is already a
    // sharp 360p30 still desktop; the ceiling keeps a generous receiver from
    // being handed a low tier that costs as much as the high one. A demoted
    // viewer is not necessarily a slow one: 720p30 at 4 Mbps still reads, while
    // 720p30 at 2 Mbps smears every motion.
    const NATIVE_SCREEN_SHARE_LOW_TIER_MIN_BPS: u32 = 1_500_000;
    const NATIVE_SCREEN_SHARE_LOW_TIER_MAX_BPS: u32 = 4_000_000;
    // The low tier keeps the published size up to 720p instead of halving it:
    // screen sharing is text first, and halving 1080p to 540p costs a whole
    // stroke width where halving the bitrate only softens motion.
    const NATIVE_SCREEN_SHARE_LOW_TIER_MAX_WIDTH: u32 = 1280;
    const NATIVE_SCREEN_SHARE_LOW_TIER_MAX_HEIGHT: u32 = 720;

    /// Which encode a viewer subscribes to. Each tier is its own bitstream with
    /// its own reference frames, so switching tiers has to restart at an intra
    /// frame; that is what [`ViewerMediaQueue::require_keyframe`] is for.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ScreenShareLayer {
        High,
        Low,
        Compatibility,
    }

    fn shared_encode_is_backpressured(
        layer: ScreenShareLayer,
        subscribed: usize,
        overflowing: usize,
    ) -> bool {
        layer == ScreenShareLayer::High && subscribed > 0 && overflowing == subscribed
    }

    impl ScreenShareLayer {
        fn as_str(self) -> &'static str {
            match self {
                Self::High => "high",
                Self::Low => "low",
                Self::Compatibility => "compatibility",
            }
        }
    }

    impl NativeScreenShareBitrateController {
        fn new(maximum_bitrate_bps: u32) -> Self {
            Self {
                maximum_bitrate_bps,
                effective_bitrate_bps: maximum_bitrate_bps,
                // Nothing has been proven yet: the peak only grows when this
                // share actually delivers a rate to a live viewer.
                peak_bitrate_bps: 0,
                last_estimate_ceiling_bps: 0,
                viewer_estimates: HashMap::new(),
                viewer_layers: HashMap::new(),
                viewer_upgrade_samples: HashMap::new(),
                low_estimate_hold: None,
                last_increase_at: Instant::now(),
                last_backpressure_at: None,
                last_backpressure_reduction_at: None,
            }
        }

        /// Records the working bitrate and remembers the highest rate this share
        /// has actually reached, which is the only evidence the controller has
        /// that the path can carry more than the current estimates claim.
        fn note_effective_bitrate(&mut self, bitrate_bps: u32) {
            self.effective_bitrate_bps = bitrate_bps;
            self.peak_bitrate_bps = self.peak_bitrate_bps.max(bitrate_bps);
        }

        /// Estimates that belong to viewers watching the full-quality encode.
        /// The low tier has its own encoder, so it must stay out of this set:
        /// keeping it out is exactly what stops one distant viewer from
        /// softening the picture for everybody else.
        fn high_tier_estimates(&self) -> impl Iterator<Item = u32> + '_ {
            self.viewer_estimates
                .iter()
                .filter_map(|(viewer_peer_id, estimate)| {
                    self.viewer_layer(viewer_peer_id)
                        .eq(&ScreenShareLayer::High)
                        .then_some(estimate.bitrate_bps)
                })
        }

        fn viewer_layer(&self, viewer_peer_id: &str) -> ScreenShareLayer {
            self.viewer_layers
                .get(viewer_peer_id)
                .copied()
                .unwrap_or(ScreenShareLayer::High)
        }

        fn high_tier_viewers(&self) -> usize {
            self.viewer_layers
                .values()
                .filter(|layer| **layer == ScreenShareLayer::High)
                .count()
        }

        fn low_tier_viewers(&self) -> usize {
            self.viewer_layers
                .values()
                .filter(|layer| **layer == ScreenShareLayer::Low)
                .count()
        }

        fn note_viewer_layer(&mut self, viewer_peer_id: &str, layer: ScreenShareLayer) {
            self.viewer_layers.insert(viewer_peer_id.to_string(), layer);
            if layer == ScreenShareLayer::High {
                self.viewer_upgrade_samples.remove(viewer_peer_id);
            }
        }

        /// Assigns and records the tier a joining viewer starts on. Everyone
        /// starts on the full-quality encode: arrival order must never decide
        /// quality, only a viewer's own estimate may demote it.
        fn reserve_viewer_layer(&mut self, viewer_peer_id: &str) -> ScreenShareLayer {
            if let Some(layer) = self.viewer_layers.get(viewer_peer_id).copied() {
                return layer;
            }
            self.note_viewer_layer(viewer_peer_id, ScreenShareLayer::High);
            ScreenShareLayer::High
        }

        /// The rate this share is aiming at: the configured ceiling, capped by
        /// what the strongest viewer reports. A receiver estimate describes what
        /// a viewing link is actually delivering; when every viewer receives the
        /// same shrunken stream they all report roughly that stream, which is
        /// why the strongest viewer — the one whose report is not held down by
        /// the shared encode — is the only honest measure of the path's capacity.
        fn high_tier_reference_bps(&self) -> u32 {
            let strongest = self
                .viewer_estimates
                .iter()
                .filter(|(id, _)| self.viewer_layer(id) != ScreenShareLayer::Compatibility)
                .map(|(_, estimate)| estimate.bitrate_bps)
                .max()
                .unwrap_or(0);
            if strongest == 0 {
                return self.maximum_bitrate_bps;
            }
            self.maximum_bitrate_bps.min(strongest)
        }

        /// Whether this viewer is what keeps the shared encode below the rate
        /// the share is aiming at. Only the weakest full-quality viewer can be
        /// that, and only when it sits materially below the reference: demoting
        /// a link that can carry the ceiling would cost quality for nothing.
        fn viewer_holds_the_shared_encode_back(&self, estimate_bps: u32) -> bool {
            let Some(lowest_full_quality) = self.high_tier_estimates().min() else {
                return false;
            };
            if estimate_bps > lowest_full_quality {
                return false;
            }
            estimate_bps
                < scale_bitrate(
                    self.high_tier_reference_bps(),
                    NATIVE_SCREEN_SHARE_LOW_TIER_RELATIVE_PERCENT,
                )
        }

        /// Moves a viewer between tiers and reports the new tier when it moved.
        /// The caller restarts that viewer's queue at a keyframe, because the
        /// two tiers are separate bitstreams.
        fn update_viewer_layer(
            &mut self,
            viewer_peer_id: &str,
            estimate_bps: u32,
        ) -> Option<ScreenShareLayer> {
            if !self.viewer_layers.contains_key(viewer_peer_id) {
                // First estimate of a viewer that joined without reserving a
                // tier: it starts on the full-quality encode, and this same
                // estimate may already move it down.
                self.note_viewer_layer(viewer_peer_id, ScreenShareLayer::High);
            }
            match self.viewer_layer(viewer_peer_id) {
                ScreenShareLayer::High
                    if self.high_tier_viewers() > 1
                        && self.viewer_holds_the_shared_encode_back(estimate_bps) =>
                {
                    self.note_viewer_layer(viewer_peer_id, ScreenShareLayer::Low);
                    Some(ScreenShareLayer::Low)
                }
                ScreenShareLayer::Low
                    if estimate_bps
                        >= scale_bitrate(
                            self.high_tier_reference_bps(),
                            NATIVE_SCREEN_SHARE_LOW_TIER_PROMOTE_PERCENT,
                        ) =>
                {
                    let samples = self
                        .viewer_upgrade_samples
                        .get(viewer_peer_id)
                        .copied()
                        .unwrap_or(0)
                        .saturating_add(1);
                    if samples >= NATIVE_SCREEN_SHARE_LOW_TIER_UPGRADE_SAMPLES {
                        self.note_viewer_layer(viewer_peer_id, ScreenShareLayer::High);
                        Some(ScreenShareLayer::High)
                    } else {
                        self.viewer_upgrade_samples
                            .insert(viewer_peer_id.to_string(), samples);
                        None
                    }
                }
                _ => {
                    self.viewer_upgrade_samples.remove(viewer_peer_id);
                    None
                }
            }
        }

        /// Target for the low-tier encoder, or `None` when nobody subscribes to
        /// it. The low tier follows the weakest low-tier viewer, which is safe:
        /// only viewers that already could not take the full-quality encode are
        /// in that set.
        ///
        /// A reduced viewer whose estimate has expired still belongs to the low
        /// tier, so it must keep receiving samples: falling back to the floor is
        /// what keeps the low encoder alive instead of leaving that viewer with a
        /// frozen picture until its next REMB arrives.
        fn low_tier_target_bitrate_bps(&self) -> Option<u32> {
            let floor = NATIVE_SCREEN_SHARE_LOW_TIER_MIN_BPS.min(self.maximum_bitrate_bps);
            let lowest = self
                .viewer_estimates
                .iter()
                .filter_map(|(viewer_peer_id, estimate)| {
                    (self.viewer_layer(viewer_peer_id) == ScreenShareLayer::Low)
                        .then_some(estimate.bitrate_bps)
                })
                .min()
                .or_else(|| (self.low_tier_viewers() > 0).then_some(floor))?;
            let ceiling = NATIVE_SCREEN_SHARE_LOW_TIER_MAX_BPS
                .min(self.maximum_bitrate_bps)
                .max(floor);
            Some(
                scale_bitrate(lowest, NATIVE_SCREEN_SHARE_REMB_HEADROOM_PERCENT)
                    .clamp(floor, ceiling),
            )
        }

        fn update_receiver_estimate(
            &mut self,
            viewer_peer_id: &str,
            receiver_estimate_bps: u32,
        ) -> (u32, u32, Option<ScreenShareLayer>) {
            let now = Instant::now();
            self.viewer_estimates.insert(
                viewer_peer_id.to_string(),
                NativeScreenShareViewerBitrateEstimate {
                    bitrate_bps: receiver_estimate_bps,
                    updated_at: now,
                },
            );
            self.viewer_estimates.retain(|_, estimate| {
                now.saturating_duration_since(estimate.updated_at)
                    <= NATIVE_SCREEN_SHARE_ESTIMATE_MAX_AGE
            });
            let layer_change = self.update_viewer_layer(viewer_peer_id, receiver_estimate_bps);
            // Only the full-quality tier sets how much the encoder spends. A
            // viewer that cannot take that tier was moved to its own encode just
            // above, and from here on it no longer participates.
            let Some(lowest_estimate) = self.high_tier_estimates().min() else {
                // A fresh report from a low-tier peer cannot constrain a high
                // tier whose own feedback has expired.
                return (
                    self.effective_bitrate_bps,
                    receiver_estimate_bps,
                    layer_change,
                );
            };
            let desired = scale_bitrate(lowest_estimate, NATIVE_SCREEN_SHARE_REMB_HEADROOM_PERCENT)
                .clamp(
                    NATIVE_SCREEN_SHARE_MIN_BITRATE_BPS.min(self.maximum_bitrate_bps),
                    self.maximum_bitrate_bps,
                );
            let reducing = desired < self.effective_bitrate_bps
                && bitrate_change_is_material(self.effective_bitrate_bps, desired);
            if !reducing {
                self.low_estimate_hold = None;
            }
            if reducing {
                if !self.low_estimate_is_settling(desired, now) {
                    self.low_estimate_hold = None;
                    self.effective_bitrate_bps = desired;
                    self.last_increase_at = now;
                }
            } else if desired > self.effective_bitrate_bps
                && now.saturating_duration_since(self.last_increase_at)
                    >= NATIVE_SCREEN_SHARE_BITRATE_INCREASE_INTERVAL
            {
                let increase = (self.effective_bitrate_bps
                    / NATIVE_SCREEN_SHARE_BITRATE_INCREASE_DIVISOR)
                    .max(NATIVE_SCREEN_SHARE_MIN_BITRATE_INCREASE_BPS);
                let next = desired.min(self.effective_bitrate_bps.saturating_add(increase));
                self.note_effective_bitrate(next);
                self.last_increase_at = now;
            }
            (self.effective_bitrate_bps, lowest_estimate, layer_change)
        }

        /// Returns true while a freshly reported low estimate is still being
        /// confirmed. Settling only applies with more than one viewer: with a
        /// single viewer nobody else can be protected from a late cut, so its
        /// estimate is trusted immediately.
        fn low_estimate_is_settling(&mut self, desired: u32, now: Instant) -> bool {
            if self.viewer_estimates.len() < 2 {
                return false;
            }
            let tolerance = (desired / 5).max(NATIVE_SCREEN_SHARE_MIN_BITRATE_CHANGE_BPS);
            let since = match &self.low_estimate_hold {
                Some(hold) if hold.ceiling_bps.abs_diff(desired) <= tolerance => hold.since,
                _ => now,
            };
            self.low_estimate_hold = Some(NativeScreenShareLowEstimateHold {
                ceiling_bps: desired,
                since,
            });
            now.saturating_duration_since(since) < NATIVE_SCREEN_SHARE_ESTIMATE_SETTLE
        }

        /// Drops a viewer's estimate and raises the ceiling the remaining
        /// viewers allow right away. Returns the new effective bitrate when it
        /// moved materially, so the caller can push it into the encoder and ask
        /// for a keyframe.
        ///
        /// Waiting for the next receiver report instead of doing this left the
        /// encoder crawling back at +25 %/s, which is why a viewer who watched a
        /// distant participant join and leave kept seeing a blurry picture until
        /// they stopped and started watching again.
        fn remove_viewer(&mut self, viewer_peer_id: &str) -> Option<u32> {
            self.viewer_estimates.remove(viewer_peer_id);
            self.viewer_layers.remove(viewer_peer_id);
            self.viewer_upgrade_samples.remove(viewer_peer_id);
            self.low_estimate_hold = None;
            let none_left_high = !self
                .viewer_estimates
                .keys()
                .any(|viewer_peer_id| self.viewer_layer(viewer_peer_id) == ScreenShareLayer::High);
            if none_left_high {
                // A reduced tier with no full-quality viewer left to protect
                // would only cost a second encode; the survivor owns the full
                // one, and its own estimate moves it back down if it must.
                let remaining = self
                    .viewer_layers
                    .iter()
                    .filter(|(_, layer)| **layer == ScreenShareLayer::Low)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for viewer_peer_id in remaining {
                    self.note_viewer_layer(&viewer_peer_id, ScreenShareLayer::High);
                }
            }
            let ceiling = if none_left_high {
                // The viewer that forced a low bitrate is gone, and nobody is
                // left to constrain the encode. Carrying that ceiling into the
                // next viewer's session would blur them for the first seconds
                // of a connection whose limit was never about them.
                self.maximum_bitrate_bps
            } else {
                let estimate_ceiling = self
                    .high_tier_estimates()
                    .map(|bitrate_bps| {
                        scale_bitrate(bitrate_bps, NATIVE_SCREEN_SHARE_REMB_HEADROOM_PERCENT)
                    })
                    .min()
                    .unwrap_or(self.maximum_bitrate_bps);
                // The remaining estimates were themselves measured against the
                // throttled stream, so they under-report the path. The peak is
                // the rate this share has already delivered, and it is the only
                // thing that remembers more was possible.
                estimate_ceiling.max(self.peak_bitrate_bps).clamp(
                    NATIVE_SCREEN_SHARE_MIN_BITRATE_BPS.min(self.maximum_bitrate_bps),
                    self.maximum_bitrate_bps,
                )
            };
            if ceiling > self.effective_bitrate_bps
                && bitrate_change_is_material(ceiling, self.effective_bitrate_bps)
            {
                self.note_effective_bitrate(ceiling);
                self.last_increase_at = Instant::now();
                self.last_backpressure_reduction_at = None;
                return Some(ceiling);
            }
            if self.viewer_estimates.is_empty() {
                self.last_backpressure_reduction_at = None;
            }
            None
        }

        /// Restarts the working rate after the capture went quiet for a while
        /// (a window sent to the background stops producing frames). Receiver
        /// reports measured a stream that was not sending, so they describe the
        /// gap rather than the path; resuming from the peak this share already
        /// delivered avoids crawling back up one probe at a time while the
        /// viewer watches a blurred picture.
        fn resume_after_idle(&mut self) -> u32 {
            let floor = NATIVE_SCREEN_SHARE_MIN_BITRATE_BPS.min(self.maximum_bitrate_bps);
            let resumed = self
                .peak_bitrate_bps
                .max(self.effective_bitrate_bps)
                .clamp(floor, self.maximum_bitrate_bps);
            self.low_estimate_hold = None;
            self.last_increase_at = Instant::now();
            self.last_backpressure_at = None;
            self.last_backpressure_reduction_at = None;
            self.note_effective_bitrate(resumed);
            resumed
        }

        fn reduce_for_backpressure(&mut self) -> u32 {
            let now = Instant::now();
            self.last_backpressure_at = Some(now);
            let recent_reduction = self.last_backpressure_reduction_at.is_some_and(|last| {
                now.saturating_duration_since(last) < NATIVE_SCREEN_SHARE_BACKPRESSURE_INTERVAL
            });
            if recent_reduction {
                return self.effective_bitrate_bps;
            }
            self.last_backpressure_reduction_at = Some(now);
            self.effective_bitrate_bps = scale_bitrate(self.effective_bitrate_bps, 80)
                .max(NATIVE_SCREEN_SHARE_MIN_BITRATE_BPS.min(self.maximum_bitrate_bps));
            self.last_increase_at = now;
            self.effective_bitrate_bps
        }

        fn probe_upward(&mut self) -> u32 {
            let now = Instant::now();
            self.viewer_estimates.retain(|_, estimate| {
                now.saturating_duration_since(estimate.updated_at)
                    <= NATIVE_SCREEN_SHARE_ESTIMATE_MAX_AGE
            });
            let estimate_ceiling = self
                .high_tier_estimates()
                .map(|bitrate_bps| {
                    scale_bitrate(bitrate_bps, NATIVE_SCREEN_SHARE_REMB_HEADROOM_PERCENT)
                })
                .min()
                .unwrap_or(self.maximum_bitrate_bps);
            let ceiling = estimate_ceiling.clamp(
                NATIVE_SCREEN_SHARE_MIN_BITRATE_BPS.min(self.maximum_bitrate_bps),
                self.maximum_bitrate_bps,
            );
            // A ceiling that dropped below what we already send has to be obeyed
            // now: waiting for the next receiver report keeps overshooting a
            // link that just told us it cannot take it. Obeying it on every pass
            // would instead cancel the probe below, because a rate that is stuck
            // low keeps producing an estimate that is just as low.
            let ceiling_dropped = self.last_estimate_ceiling_bps
                > ceiling.saturating_add(NATIVE_SCREEN_SHARE_MIN_BITRATE_CHANGE_BPS);
            let far_above_ceiling = self.effective_bitrate_bps > ceiling.saturating_mul(2);
            self.last_estimate_ceiling_bps = ceiling;
            if self.effective_bitrate_bps > ceiling
                && bitrate_change_is_material(self.effective_bitrate_bps, ceiling)
                && (ceiling_dropped || far_above_ceiling)
            {
                self.effective_bitrate_bps = ceiling;
                self.last_increase_at = now;
            }
            let backpressure_quiet = self
                .last_backpressure_at
                .is_none_or(|last| now.saturating_duration_since(last) >= Duration::from_secs(2));
            // Receiver estimates are feedback about a stream that is already
            // throttled, so staying under them can never discover a path that
            // got faster or a link that was never the bottleneck. Probing a
            // little above the current rate is what breaks that loop: if the
            // path cannot take it, the next estimate and the loss report pull
            // us straight back down.
            let probe_ceiling = scale_bitrate(
                self.effective_bitrate_bps,
                NATIVE_SCREEN_SHARE_PROBE_STEP_PERCENT,
            )
            // Never chase more than twice what the path last reported: past
            // that the overshoot costs the viewer the picture it already has.
            .min(ceiling.saturating_mul(2))
            .clamp(
                NATIVE_SCREEN_SHARE_MIN_BITRATE_BPS.min(self.maximum_bitrate_bps),
                self.maximum_bitrate_bps,
            );
            let target = if backpressure_quiet {
                ceiling.max(probe_ceiling)
            } else {
                ceiling
            };
            if backpressure_quiet
                && self.effective_bitrate_bps < target
                && now.saturating_duration_since(self.last_increase_at)
                    >= NATIVE_SCREEN_SHARE_BITRATE_INCREASE_INTERVAL
            {
                let increase = (self.effective_bitrate_bps
                    / NATIVE_SCREEN_SHARE_BITRATE_INCREASE_DIVISOR)
                    .max(NATIVE_SCREEN_SHARE_MIN_BITRATE_INCREASE_BPS);
                // One step per second is the right way to probe a link whose
                // capacity is still unknown, but it is the wrong way to recover
                // from a ceiling that has doubled. That happens when the viewer
                // that was limiting us stopped watching, or its link recovered.
                // Stepping would keep the picture soft for roughly twelve
                // seconds while every remaining viewer already reports room for
                // more, so take the ceiling the estimator is offering.
                let next = if target >= self.effective_bitrate_bps.saturating_mul(2) {
                    target
                } else {
                    self.effective_bitrate_bps.saturating_add(increase)
                };
                self.note_effective_bitrate(next.min(target));
                self.last_increase_at = now;
            }
            self.effective_bitrate_bps
        }

        fn retain_effective_bitrate(&mut self, bitrate_bps: u32) {
            self.effective_bitrate_bps = bitrate_bps.min(self.maximum_bitrate_bps);
            self.last_increase_at = Instant::now();
        }

        /// The user's chosen bitrate is the ceiling, not the working value: the
        /// controller still probes downward after a receiver report. Lowering it
        /// must take effect at once, because that is the whole reason to lower it.
        fn set_maximum_bitrate(&mut self, bitrate_bps: u32) {
            if bitrate_bps == 0 {
                return;
            }
            let previous_maximum = self.maximum_bitrate_bps;
            self.maximum_bitrate_bps = bitrate_bps.max(NATIVE_SCREEN_SHARE_MIN_BITRATE_BPS);
            // The proven peak is only evidence about a link as fast as the user
            // still allows. Keeping a stale, higher peak would jump the next
            // recovery past the ceiling the user just chose.
            self.peak_bitrate_bps = self.peak_bitrate_bps.min(self.maximum_bitrate_bps);
            if self.maximum_bitrate_bps != previous_maximum {
                self.low_estimate_hold = None;
            }
            if self.effective_bitrate_bps > self.maximum_bitrate_bps {
                self.effective_bitrate_bps = self.maximum_bitrate_bps;
                self.last_increase_at = Instant::now();
            }
        }
    }

    fn scale_bitrate(rate: u32, percent: u32) -> u32 {
        ((u64::from(rate) * u64::from(percent)) / 100).min(u64::from(u32::MAX)) as u32
    }

    fn bitrate_change_is_material(current_bitrate_bps: u32, next_bitrate_bps: u32) -> bool {
        current_bitrate_bps.abs_diff(next_bitrate_bps)
            >= (current_bitrate_bps / 10).max(NATIVE_SCREEN_SHARE_MIN_BITRATE_CHANGE_BPS)
    }

    struct NativeWebRtcViewer {
        audio_sample_tx: Option<tokio_mpsc::Sender<QueuedOpusSample>>,
        offered_primary_profile: String,
        peer_connection: Arc<RTCPeerConnection>,
        media_queue: Arc<ViewerMediaQueue>,
        ready_for_media: Arc<AtomicBool>,
        watch_session_id: String,
        /// The encode this viewer's track is fed from.
        layer: ScreenShareLayer,
        /// Candidates that arrived before the viewer's answer. A viewer trickles
        /// its candidates as soon as it has local candidates, which regularly
        /// beats its own answer across the signaling path; webrtc-rs refuses to
        /// add any candidate before the remote description exists, so those
        /// candidates would otherwise be lost and the connection would have to
        /// fall back to whatever the answer carried inline.
        pending_ice_candidates: Arc<Mutex<Vec<RTCIceCandidateInit>>>,
    }

    impl NativeWebRtcViewer {
        fn can_send_media(&self) -> bool {
            self.ready_for_media.load(Ordering::Acquire)
                && self.peer_connection.connection_state() == RTCPeerConnectionState::Connected
        }
    }

    #[derive(Clone)]
    struct QueuedH264Sample {
        data: Bytes,
        capture_tick: u64,
        enqueued_at: Instant,
        is_keyframe: bool,
    }

    #[derive(Clone)]
    struct QueuedOpusSample {
        data: Bytes,
        capture_tick: u64,
        enqueued_at: Instant,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ViewerMediaQueuePushResult {
        Enqueued,
        DroppedAwaitingKeyframe,
        Backpressure(usize),
    }

    #[derive(Debug)]
    struct ExpiredVideoFrames {
        count: usize,
        needs_keyframe: bool,
    }

    struct ViewerMediaQueueState {
        samples: VecDeque<QueuedH264Sample>,
        awaiting_keyframe: bool,
        /// True once this viewer has been handed a keyframe. Until then the
        /// viewer is simply not receiving yet, which is not a dropped frame.
        had_keyframe: bool,
        closed: bool,
    }

    struct ViewerMediaQueue {
        state: Mutex<ViewerMediaQueueState>,
        ready: Notify,
        capacity: usize,
    }

    const VIEWER_MEDIA_QUEUE_TARGET_MS: u64 = 125;
    const VIEWER_MEDIA_QUEUE_MIN_CAPACITY: usize = 6;
    const VIEWER_MEDIA_QUEUE_MAX_CAPACITY: usize = 20;
    const SCREEN_SHARE_AUDIO_SAMPLE_RATE: u32 = 48_000;
    const SCREEN_SHARE_AUDIO_CHANNELS: usize = 2;
    const SCREEN_SHARE_AUDIO_FRAME_SAMPLES: usize = 960;
    const SCREEN_SHARE_AUDIO_QUEUE_PACKETS: usize = 4;
    const SCREEN_SHARE_AUDIO_MAX_QUEUE_AGE: Duration = Duration::from_millis(80);
    const SCREEN_SHARE_AUDIO_BITRATE: i32 = 128_000;
    // Must be the fmtp the MediaEngine advertises, not just the one on the track:
    // the engine's Opus entry is what ends up in the SDP.
    const SCREEN_SHARE_OPUS_FMTP: &str =
        "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=160000";
    const MAX_OUTBOUND_SCREEN_SHARE_SIGNALS: usize = 256;
    const MAX_OUTBOUND_SCREEN_SHARE_SIGNALS_PER_VIEWER: usize = 48;
    const PEER_CONNECTION_OPERATION_TIMEOUT: Duration = Duration::from_secs(2);

    fn viewer_media_queue_capacity(frame_rate: u64) -> usize {
        frame_rate
            .saturating_mul(VIEWER_MEDIA_QUEUE_TARGET_MS)
            .div_ceil(1_000)
            .clamp(
                VIEWER_MEDIA_QUEUE_MIN_CAPACITY as u64,
                VIEWER_MEDIA_QUEUE_MAX_CAPACITY as u64,
            ) as usize
    }

    /// How long webrtc-ice may wait before nominating a relay pair.
    ///
    /// The wait is measured from the peer connection's start and is applied to
    /// both ends of a pair, so a relay-only viewer pays it in full before the
    /// pair is nominated - and DTLS cannot begin before that. For a viewer that
    /// chose the relay, every candidate it sends is relay, so there is no direct
    /// path left to protect and the wait is pure latency in front of the first
    /// frame. Everyone else keeps the full second so a slow direct pair still
    /// beats the relay.
    fn viewer_relay_acceptance_wait(relay_only: bool) -> Duration {
        if relay_only {
            Duration::from_millis(120)
        } else {
            Duration::from_millis(1_000)
        }
    }

    impl ViewerMediaQueue {
        fn new(capacity: usize) -> Self {
            let capacity = capacity.max(1);
            Self {
                state: Mutex::new(ViewerMediaQueueState {
                    samples: VecDeque::with_capacity(capacity),
                    awaiting_keyframe: true,
                    had_keyframe: false,
                    closed: false,
                }),
                ready: Notify::new(),
                capacity,
            }
        }

        fn push_latest(&self, sample: QueuedH264Sample) -> ViewerMediaQueuePushResult {
            let Ok(mut state) = self.state.lock() else {
                return ViewerMediaQueuePushResult::DroppedAwaitingKeyframe;
            };
            if state.closed {
                return ViewerMediaQueuePushResult::DroppedAwaitingKeyframe;
            }
            let result = if state.awaiting_keyframe && sample.is_keyframe {
                state.awaiting_keyframe = false;
                state.had_keyframe = true;
                state.samples.push_back(sample);
                ViewerMediaQueuePushResult::Enqueued
            } else if state.awaiting_keyframe {
                ViewerMediaQueuePushResult::DroppedAwaitingKeyframe
            } else if state.samples.len() >= self.capacity {
                let discarded = state.samples.len() + usize::from(!sample.is_keyframe);
                state.samples.clear();
                if sample.is_keyframe {
                    state.awaiting_keyframe = false;
                    state.samples.push_back(sample);
                } else {
                    state.awaiting_keyframe = true;
                }
                ViewerMediaQueuePushResult::Backpressure(discarded)
            } else {
                state.samples.push_back(sample);
                ViewerMediaQueuePushResult::Enqueued
            };
            drop(state);
            if result != ViewerMediaQueuePushResult::DroppedAwaitingKeyframe {
                self.ready.notify_one();
            }
            result
        }

        /// Whether this viewer has received anything at all. A viewer that is
        /// still waiting for its first keyframe is not dropping frames; it has
        /// simply not started, so it must not inflate the drop counters.
        fn has_started(&self) -> bool {
            self.state
                .lock()
                .map(|state| state.had_keyframe)
                .unwrap_or(false)
        }

        async fn next(&self) -> Option<Result<QueuedH264Sample, ExpiredVideoFrames>> {
            loop {
                let notified = self.ready.notified();
                {
                    let mut state = self.state.lock().ok()?;
                    let now = Instant::now();
                    let fresh = |sample: &QueuedH264Sample| {
                        now.saturating_duration_since(sample.enqueued_at)
                            < Duration::from_millis(VIEWER_MEDIA_QUEUE_TARGET_MS)
                    };
                    if state.samples.front().is_some_and(|sample| !fresh(sample)) {
                        // P-frames depend on the expired chain. Keep a fresh
                        // decodable suffix, or restart on the next IDR.
                        let discard = state
                            .samples
                            .iter()
                            .rposition(|s| s.is_keyframe && fresh(s))
                            .unwrap_or(state.samples.len());
                        state.samples.drain(..discard);
                        state.awaiting_keyframe = state.samples.is_empty();
                        return Some(Err(ExpiredVideoFrames {
                            count: discard,
                            needs_keyframe: state.awaiting_keyframe,
                        }));
                    }
                    if let Some(sample) = state.samples.pop_front() {
                        return Some(Ok(sample));
                    }
                    if state.closed {
                        return None;
                    }
                }
                notified.await;
            }
        }

        fn close(&self) {
            if let Ok(mut state) = self.state.lock() {
                state.closed = true;
                state.samples.clear();
            }
            self.ready.notify_waiters();
        }

        fn require_keyframe(&self) {
            if let Ok(mut state) = self.state.lock() {
                if state.closed {
                    return;
                }
                state.samples.clear();
                state.awaiting_keyframe = true;
            }
        }
    }

    /// H.264 profile the native screen-share pipeline encodes and advertises.
    ///
    /// High (`profile_idc` 100) enables CABAC and the 8x8 transform, which keeps
    /// UI text and window edges sharp at a bitrate where constrained Baseline has
    /// to spend the same bits on blocking artefacts. Chromium/WebView2, hardware
    /// MFTs and the in-app OpenH264 decoder all decode High, and both native
    /// encoders request it, so the SDP fmtp below can stay derived from one
    /// constant instead of drifting from the bitstream.
    pub(crate) const NATIVE_SCREEN_SHARE_H264_PROFILE_IDC: u8 = 100;

    /// Constraint flags paired with [`NATIVE_SCREEN_SHARE_H264_PROFILE_IDC`].
    ///
    /// OpenH264 sets `constraint_set4_flag` and `constraint_set5_flag` for High,
    /// which yields the `640c..` form that Chromium also advertises. Keeping the
    /// literal here means the fmtp is byte-identical to the SPS we actually emit.
    const OPENH264_HIGH_CONSTRAINTS: u8 = 0x0c;

    fn native_screen_share_h264_profile_level_id(
        profile: &super::ScreenShareVideoProfile,
    ) -> String {
        format!(
            "{:02x}{:02x}{:02x}",
            NATIVE_SCREEN_SHARE_H264_PROFILE_IDC,
            if profile.frame_rate.fps() > 30 {
                0
            } else {
                OPENH264_HIGH_CONSTRAINTS
            },
            profile.required_h264_level_idc().unwrap_or(52)
        )
    }

    fn native_screen_share_h264_fmtp(profile: &super::ScreenShareVideoProfile) -> String {
        h264_fmtp_for_profile_id(&native_screen_share_h264_profile_level_id(profile))
    }

    fn fmtp_param<'a>(fmtp: &'a str, name: &str) -> Option<&'a str> {
        fmtp.split(';')
            .filter_map(|param| param.trim().split_once('='))
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value)
    }

    fn screen_share_answer_layer(
        sdp: &webrtc::sdp::description::session::SessionDescription,
        primary_profile: &str,
    ) -> Result<ScreenShareLayer, String> {
        let video = sdp
            .media_descriptions
            .iter()
            .find(|m| {
                m.media_name.media == "video"
                    && m.media_name.port.value != 0
                    && m.attribute("inactive").is_none()
                    && m.attribute("sendonly").is_none()
            })
            .ok_or_else(|| "viewer declined the native screen-share video formats".to_string())?;
        let accepts = |pt: u8, profile: &str| {
            video.media_name.formats.contains(&pt.to_string())
                && sdp.get_codec_for_payload_type(pt).is_ok_and(|codec| {
                    codec.name.eq_ignore_ascii_case("H264")
                        && fmtp_param(&codec.fmtp, "packetization-mode") == Some("1")
                        && fmtp_param(&codec.fmtp, "profile-level-id")
                            .is_some_and(|id| same_h264_subprofile(id, profile))
                })
        };
        if accepts(102, primary_profile) {
            return Ok(ScreenShareLayer::High);
        }
        if accepts(103, "42e01f") {
            return Ok(ScreenShareLayer::Compatibility);
        }
        Err("viewer and native screen-share encoder have no common packetization-mode 1 H.264 profile".to_string())
    }

    fn h264_fmtp_for_profile_id(profile_id: &str) -> String {
        format!("level-asymmetry-allowed=1;packetization-mode=1;profile-level-id={profile_id}")
    }

    fn native_screen_share_video_rtcp_feedback() -> Vec<RTCPFeedback> {
        vec![
            RTCPFeedback {
                typ: "goog-remb".to_string(),
                parameter: "".to_string(),
            },
            RTCPFeedback {
                typ: "ccm".to_string(),
                parameter: "fir".to_string(),
            },
            RTCPFeedback {
                typ: "nack".to_string(),
                parameter: "".to_string(),
            },
            RTCPFeedback {
                typ: "nack".to_string(),
                parameter: "pli".to_string(),
            },
        ]
    }

    impl NativeWebRtcSender {
        fn new(
            request: &NativeScreenShareStartRequest,
            outbound_signals: Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            keyframe_requested: Arc<AtomicBool>,
        ) -> Result<Self, String> {
            let runtime = TokioRuntimeBuilder::new_multi_thread()
                .worker_threads(2)
                .thread_name("ev-native-webrtc")
                .enable_all()
                .build()
                .map_err(|err| format!("create native WebRTC runtime: {err}"))?;
            let fps = request.frame_rate.max(1) as u64;
            let profile = native_screen_share_video_profile(request)?;
            let bitrate_controller =
                NativeScreenShareBitrateController::new(profile.target_bitrate_bps());
            let effective_bitrate_bps =
                Arc::new(AtomicU32::new(bitrate_controller.effective_bitrate_bps));
            if let Ok(mut status) = status.lock() {
                status.effective_bitrate_bps = bitrate_controller.effective_bitrate_bps;
                status.receiver_estimated_bitrate_bps = None;
            }
            let bitrate_controller = Arc::new(Mutex::new(bitrate_controller));
            let video_codec = RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_string(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: native_screen_share_h264_fmtp(&profile),
                rtcp_feedback: native_screen_share_video_rtcp_feedback(),
            };
            let audio_codec = request.include_audio.then(|| RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_string(),
                clock_rate: SCREEN_SHARE_AUDIO_SAMPLE_RATE,
                channels: SCREEN_SHARE_AUDIO_CHANNELS as u16,
                sdp_fmtp_line: SCREEN_SHARE_OPUS_FMTP.to_string(),
                rtcp_feedback: Vec::new(),
            });
            let runtime = Arc::new(runtime);
            let rtc_configuration = crate::rtc_config::rtc_configuration(&request.ice_servers);
            #[cfg(test)]
            let rtc_configuration = {
                let mut configuration = rtc_configuration;
                if std::env::var("EV_SCREEN_SHARE_BROWSER_FORCE_RELAY").as_deref() == Ok("1") {
                    configuration.ice_transport_policy = RTCIceTransportPolicy::Relay;
                }
                configuration
            };
            Ok(Self {
                share_id: request.share_id.clone(),
                runtime,
                outbound_signals,
                status,
                viewers: Arc::new(Mutex::new(HashMap::new())),
                pending_viewers: Mutex::new(HashMap::new()),
                viewer_close_tasks: Mutex::new(Vec::new()),
                keyframe_requested,
                video_codec,
                observed_sps: tokio::sync::watch::channel(None).0,
                observed_compatibility_sps: Mutex::new(None),
                capture_started: AtomicBool::new(false),
                audio_codec,
                viewer_media_queue_capacity: viewer_media_queue_capacity(fps),
                rtc_configuration,
                effective_bitrate_bps,
                bitrate_controller,
                target_frame_rate: Arc::new(AtomicU32::new(fps.min(u32::MAX as u64) as u32)),
                startup_profile: profile,
            })
        }

        fn add_viewer(
            &self,
            member_id: String,
            watch_session_id: String,
            relay_only: bool,
        ) -> Result<bool, String> {
            let existing_watch_session_id = {
                let viewers = self
                    .viewers
                    .lock()
                    .map_err(|_| "native WebRTC viewer map is poisoned".to_string())?;
                match viewers.get(&member_id) {
                    Some(existing)
                        if watch_session_id.is_empty()
                            || existing.watch_session_id == watch_session_id =>
                    {
                        self.keyframe_requested.store(true, Ordering::SeqCst);
                        return Ok(true);
                    }
                    Some(existing) => Some(existing.watch_session_id.clone()),
                    None => None,
                }
            };
            if let Some(existing_watch_session_id) = existing_watch_session_id {
                self.remove_viewer(&member_id, &existing_watch_session_id);
            }
            {
                let mut pending = self
                    .pending_viewers
                    .lock()
                    .map_err(|_| "native WebRTC pending viewer map is poisoned".to_string())?;
                if pending.get(&member_id) == Some(&watch_session_id) {
                    self.keyframe_requested.store(true, Ordering::SeqCst);
                    return Ok(true);
                }
                pending.insert(member_id.clone(), watch_session_id.clone());
            }

            let viewer = match self.runtime.block_on(async {
                tokio::time::timeout(
                    PEER_CONNECTION_OPERATION_TIMEOUT,
                    self.create_viewer(member_id.clone(), watch_session_id.clone(), relay_only),
                )
                .await
            }) {
                Ok(Ok(viewer)) => viewer,
                Ok(Err(err)) => {
                    if let Ok(mut pending) = self.pending_viewers.lock() {
                        if pending.get(&member_id) == Some(&watch_session_id) {
                            pending.remove(&member_id);
                        }
                    }
                    return Err(err);
                }
                Err(_) => {
                    if let Ok(mut pending) = self.pending_viewers.lock() {
                        if pending.get(&member_id) == Some(&watch_session_id) {
                            pending.remove(&member_id);
                        }
                    }
                    return Err("timed out creating native screen share viewer".to_string());
                }
            };
            let should_keep = {
                let mut pending = self
                    .pending_viewers
                    .lock()
                    .map_err(|_| "native WebRTC pending viewer map is poisoned".to_string())?;
                let should_keep = pending.get(&member_id) == Some(&watch_session_id);
                if should_keep {
                    pending.remove(&member_id);
                }
                should_keep
            };
            if !should_keep {
                self.close_viewer_async(viewer);
                return Ok(false);
            }
            let replaced = self
                .viewers
                .lock()
                .map_err(|_| "native WebRTC viewer map is poisoned".to_string())?
                .insert(member_id, viewer);
            if let Some(replaced) = replaced {
                self.close_viewer_async(replaced);
            }
            // No keyframe request here: at this point the offer has not even
            // reached the viewer, so an IDR forced now is spent on a transport
            // that cannot carry it yet. create_viewer() asks again once the peer
            // connection reports Connected, which is when it can be seen.
            Ok(true)
        }

        async fn create_viewer(
            &self,
            member_id: String,
            watch_session_id: String,
            relay_only: bool,
        ) -> Result<NativeWebRtcViewer, String> {
            let mut media_engine = MediaEngine::default();
            // Only offer formats the screen-share encoder actually emits. Both the
            // MediaEngine entry and the bound track must describe the same SPS.
            let mut video_codec = self.video_codec.clone();
            if self.capture_started.load(Ordering::Acquire) {
                let mut observed = self.observed_sps.subscribe();
                let profile = tokio::time::timeout(
                    Duration::from_millis(1500),
                    observed.wait_for(Option::is_some),
                )
                .await
                .map_err(|_| {
                    "screen share encoder has not supplied its H.264 sequence header yet"
                        .to_string()
                })?
                .map_err(|_| {
                    "screen share encoder stopped before its first sequence header".to_string()
                })?;
                if let Some(profile) = profile.as_ref() {
                    video_codec.sdp_fmtp_line = h264_fmtp_for_profile_id(profile);
                }
            }
            media_engine
                .register_codec(
                    RTCRtpCodecParameters {
                        capability: video_codec.clone(),
                        payload_type: 102,
                        ..Default::default()
                    },
                    RTPCodecType::Video,
                )
                .map_err(|err| format!("register native screen share H.264: {err}"))?;
            let offered_primary_profile =
                fmtp_param(&video_codec.sdp_fmtp_line, "profile-level-id")
                    .unwrap()
                    .to_owned();
            let mut compatibility_codec = video_codec.clone();
            let compatibility_id = format!("42e0{}", &offered_primary_profile[4..]);
            if !same_h264_subprofile(&offered_primary_profile, &compatibility_id) {
                compatibility_codec.sdp_fmtp_line = h264_fmtp_for_profile_id(&compatibility_id);
                media_engine
                    .register_codec(
                        RTCRtpCodecParameters {
                            capability: compatibility_codec,
                            payload_type: 103,
                            ..Default::default()
                        },
                        RTPCodecType::Video,
                    )
                    .map_err(|err| format!("register compatibility H.264: {err}"))?;
            }
            if let Some(codec) = &self.audio_codec {
                media_engine
                    .register_codec(
                        RTCRtpCodecParameters {
                            capability: codec.clone(),
                            payload_type: 111,
                            ..Default::default()
                        },
                        RTPCodecType::Audio,
                    )
                    .map_err(|err| format!("register native screen share Opus: {err}"))?;
            }
            // This send-only backend consumes REMB, not transport-cc. The
            // default TWCC interceptor only generates feedback as a receiver.
            // Offer the send-time extension used by receiver-side estimation.
            media_engine
                .register_header_extension(
                    RTCRtpHeaderExtensionCapability {
                        uri: webrtc::sdp::extmap::ABS_SEND_TIME_URI.to_owned(),
                    },
                    RTPCodecType::Video,
                    None,
                )
                .map_err(|err| format!("register screen share send-time extension: {err}"))?;
            let registry =
                configure_rtcp_reports(configure_nack(Registry::new(), &mut media_engine));
            let mut setting_engine = SettingEngine::default();
            // webrtc-ice will not nominate a pair until its candidate type has been
            // "acceptable" for long enough: host 0 ms, srflx 500 ms, prflx 1000 ms,
            // relay 2000 ms. Those defaults assume a call can afford to wait for the
            // cheapest path. A screen share cannot: everything before nomination is
            // a black screen, and the trace shows a peer-reflexive pair being
            // nominated at 1240 ms purely because of that 1 s timeout. Relay keeps a
            // 1 s wait so srflx/prflx still win first; prflx drops to 500 ms so it
            // competes with srflx instead of losing a whole second to it. Both are
            // direct paths, so the cost of getting the order "wrong" is only a
            // different local interface.
            setting_engine
                .set_relay_acceptance_min_wait(Some(viewer_relay_acceptance_wait(relay_only)));
            setting_engine.set_prflx_acceptance_min_wait(Some(Duration::from_millis(500)));
            let api = APIBuilder::new()
                .with_media_engine(media_engine)
                .with_interceptor_registry(registry)
                .with_setting_engine(setting_engine)
                .build();
            let peer_connection = Arc::new(
                api.new_peer_connection(self.rtc_configuration.clone())
                    .await
                    .map_err(|err| format!("create native screen share peer connection: {err}"))?,
            );

            let ice_share_id = self.share_id.clone();
            let ice_member_id = member_id.clone();
            let ice_watch_session_id = watch_session_id.clone();
            let ice_outbound = Arc::clone(&self.outbound_signals);
            peer_connection.on_ice_candidate(Box::new(
                move |candidate: Option<RTCIceCandidate>| {
                    let share_id = ice_share_id.clone();
                    let member_id = ice_member_id.clone();
                    let watch_session_id = ice_watch_session_id.clone();
                    let outbound = Arc::clone(&ice_outbound);
                    Box::pin(async move {
                        let candidate_value = match candidate {
                            Some(candidate) => match candidate.to_json() {
                                Ok(mut candidate) => {
                                    if candidate.sdp_mid.as_deref() == Some("") {
                                        candidate.sdp_mid = Some("0".to_string());
                                    }
                                    if candidate.sdp_mline_index.is_none() {
                                        candidate.sdp_mline_index = Some(0);
                                    }
                                    json!(candidate)
                                }
                                Err(_) => return,
                            },
                            None => serde_json::Value::Null,
                        };
                        push_outbound_signal(
                            &outbound,
                            member_id,
                            "screen-share-ice-candidate",
                            json!({
                                "share_id": share_id,
                                "watch_session_id": watch_session_id,
                                "candidate": candidate_value,
                            }),
                        );
                    })
                },
            ));

            let state_share_id = self.share_id.clone();
            let state_member_id = member_id.clone();
            let state_watch_session_id = watch_session_id.clone();
            let state_outbound = Arc::clone(&self.outbound_signals);
            let state_status = Arc::clone(&self.status);
            let state_keyframe_requested = Arc::clone(&self.keyframe_requested);
            let state_peer_connection = Arc::clone(&peer_connection);
            let media_queue = Arc::new(ViewerMediaQueue::new(self.viewer_media_queue_capacity));
            let state_media_queue = Arc::clone(&media_queue);
            peer_connection.on_peer_connection_state_change(Box::new(
                move |state: RTCPeerConnectionState| {
                    let share_id = state_share_id.clone();
                    let member_id = state_member_id.clone();
                    let watch_session_id = state_watch_session_id.clone();
                    let outbound = Arc::clone(&state_outbound);
                    let status = Arc::clone(&state_status);
                    let keyframe_requested = Arc::clone(&state_keyframe_requested);
                    let peer_connection = Arc::clone(&state_peer_connection);
                    let media_queue = Arc::clone(&state_media_queue);
                    Box::pin(async move {
                        if let Ok(mut status) = status.lock() {
                            status.native_peer_connection_state = state.to_string();
                        }
                        match state {
                            RTCPeerConnectionState::Connected => {
                                // DTLS is up, so this is the first moment a frame
                                // written to the track can actually reach this
                                // viewer. The request made while the offer was
                                // still in flight could only be spent on a
                                // transport that did not exist yet, and the next
                                // periodic IDR is one to three seconds away.
                                media_queue.require_keyframe();
                                keyframe_requested.store(true, Ordering::SeqCst);
                                // Record the path this viewer actually got, once,
                                // while the connection is healthy. Without it a
                                // relayed viewer and a weak direct viewer look the
                                // same from here, and the fix is completely
                                // different.
                                //
                                // The first stats pass can run before the agent
                                // has nominated a pair, so an unresolved result
                                // is retried instead of being stored as a
                                // permanent "unknown".
                                let mut path = None;
                                for attempt in 0..3 {
                                    let stats = peer_connection.get_stats().await;
                                    path = classify_viewer_path(&stats);
                                    if path.is_some() || attempt == 2 {
                                        break;
                                    }
                                    tokio::time::sleep(Duration::from_millis(300)).await;
                                }
                                if let Some(path) = path {
                                    if let Ok(mut status) = status.lock() {
                                        status
                                            .viewer_paths
                                            .insert(member_id.clone(), path.to_string());
                                    }
                                }
                            }
                            RTCPeerConnectionState::Failed
                            | RTCPeerConnectionState::Disconnected
                            | RTCPeerConnectionState::Closed => {
                                push_outbound_signal(
                                    &outbound,
                                    member_id,
                                    "screen-share-ice-candidate",
                                    json!({
                                        "share_id": share_id,
                                        "watch_session_id": watch_session_id,
                                        "candidate": serde_json::Value::Null,
                                    }),
                                );
                            }
                            _ => {}
                        }
                    })
                },
            ));

            let ice_status = Arc::clone(&self.status);
            peer_connection.on_ice_connection_state_change(Box::new(
                move |state: RTCIceConnectionState| {
                    let status = Arc::clone(&ice_status);
                    Box::pin(async move {
                        if let Ok(mut status) = status.lock() {
                            status.native_ice_connection_state = state.to_string();
                        }
                    })
                },
            ));

            let gathering_status = Arc::clone(&self.status);
            peer_connection.on_ice_gathering_state_change(Box::new(
                move |state: RTCIceGathererState| {
                    let status = Arc::clone(&gathering_status);
                    Box::pin(async move {
                        if let Ok(mut status) = status.lock() {
                            status.native_ice_gathering_state = state.to_string();
                        }
                    })
                },
            ));

            let video_track = Arc::new(TrackLocalStaticRTP::new(
                video_codec,
                format!("screen-share-video-{member_id}"),
                format!("echovoice-screen-share-{}", self.share_id),
            ));
            let rtp_sender = peer_connection
                .add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .map_err(|err| format!("add native screen share video track: {err}"))?;
            let audio = if let Some(codec) = &self.audio_codec {
                let track = Arc::new(TrackLocalStaticRTP::new(
                    codec.clone(),
                    format!("screen-share-audio-{}", self.share_id),
                    format!("echovoice-screen-share-{}", self.share_id),
                ));
                let sender = peer_connection
                    .add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
                    .await
                    .map_err(|err| format!("add native screen share Opus track: {err}"))?;
                Some((track, sender))
            } else {
                None
            };
            let ready_for_media = Arc::new(AtomicBool::new(false));
            // Decide the tier before the offer leaves, so the very first sample
            // this viewer receives already belongs to an encode it subscribed to.
            let viewer_layer = {
                let layer = self
                    .bitrate_controller
                    .lock()
                    .map(|mut controller| controller.reserve_viewer_layer(&member_id))
                    .unwrap_or(ScreenShareLayer::High);
                if let Ok(mut status) = self.status.lock() {
                    status
                        .viewer_layers
                        .insert(member_id.clone(), layer.as_str().to_string());
                }
                layer
            };

            let offer = peer_connection
                .create_offer(None)
                .await
                .map_err(|err| format!("create native screen share offer: {err}"))?;
            peer_connection
                .set_local_description(offer.clone())
                .await
                .map_err(|err| format!("set native screen share local description: {err}"))?;
            // The offer leaves as soon as the local description is applied. Every
            // gathered candidate is trickled as its own screen-share-ice-candidate
            // signal and the viewer holds them until the offer arrives, so waiting
            // up to 250 ms for gathering only parked that delay between "watch"
            // and the first connectivity check.
            let offer = peer_connection.local_description().await.unwrap_or(offer);

            push_outbound_signal(
                &self.outbound_signals,
                member_id.clone(),
                "screen-share-offer",
                json!({
                    "share_id": self.share_id,
                    "watch_session_id": watch_session_id.clone(),
                    "description": offer,
                }),
            );

            self.spawn_rtcp_reader(member_id.clone(), Arc::clone(&media_queue), rtp_sender);
            self.spawn_media_writer(video_track, Arc::clone(&media_queue));
            let audio_sample_tx = audio.map(|(track, sender)| {
                self.spawn_audio_rtcp_reader(sender);
                self.spawn_audio_writer(track)
            });
            Ok(NativeWebRtcViewer {
                audio_sample_tx,
                offered_primary_profile,
                peer_connection,
                media_queue,
                ready_for_media,
                watch_session_id,
                layer: viewer_layer,
                pending_ice_candidates: Arc::new(Mutex::new(Vec::new())),
            })
        }

        fn spawn_media_writer(
            &self,
            video_track: Arc<TrackLocalStaticRTP>,
            media_queue: Arc<ViewerMediaQueue>,
        ) {
            let status = Arc::clone(&self.status);
            let keyframe_requested = Arc::clone(&self.keyframe_requested);
            self.runtime.spawn(async move {
                let mut consecutive_write_errors = 0u32;
                let mut packetizer = ScreenSharePacketizer::video();
                while let Some(item) = media_queue.next().await {
                    let sample = match item {
                        Ok(sample) => sample,
                        Err(expired) => {
                            if let Ok(mut status) = status.lock() {
                                status.dropped_frames =
                                    status.dropped_frames.saturating_add(expired.count as u64);
                                status.viewer_backpressure_drops = status
                                    .viewer_backpressure_drops
                                    .saturating_add(expired.count as u64);
                            }
                            if expired.needs_keyframe {
                                keyframe_requested.store(true, Ordering::SeqCst);
                            }
                            continue;
                        }
                    };
                    let result = packetizer
                        .write(&video_track, &sample.data, sample.capture_tick)
                        .await;
                    if let Ok(mut status) = status.lock() {
                        match result {
                            Ok(_) => {
                                consecutive_write_errors = 0;
                                status.sample_write_count =
                                    status.sample_write_count.saturating_add(1);
                                status.last_sample_write_error = None;
                            }
                            Err(err) => {
                                consecutive_write_errors =
                                    consecutive_write_errors.saturating_add(1);
                                status.sample_write_error_count =
                                    status.sample_write_error_count.saturating_add(1);
                                status.last_sample_write_error = Some(err.to_string());
                                if keyframe_after_write_error(consecutive_write_errors) {
                                    media_queue.require_keyframe();
                                    keyframe_requested.store(true, Ordering::SeqCst);
                                }
                            }
                        }
                    }
                }
            });
        }

        fn spawn_rtcp_reader(
            &self,
            viewer_peer_id: String,
            media_queue: Arc<ViewerMediaQueue>,
            rtp_sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>,
        ) {
            let keyframe_requested = Arc::clone(&self.keyframe_requested);
            let bitrate_controller = Arc::clone(&self.bitrate_controller);
            let effective_bitrate_bps = Arc::clone(&self.effective_bitrate_bps);
            let status = Arc::clone(&self.status);
            let viewers = Arc::clone(&self.viewers);
            self.runtime.spawn(async move {
                let mut consecutive_read_errors = 0u32;
                loop {
                    let packets = match rtp_sender.read_rtcp().await {
                        Ok((packets, _)) => {
                            consecutive_read_errors = 0;
                            packets
                        }
                        // The sender stops when the viewer goes away, so this is
                        // the one error that means "nothing more will arrive".
                        Err(webrtc::Error::ErrClosedPipe) => break,
                        // A malformed RTCP packet used to end this task for good,
                        // which silently stopped PLI and REMB handling for the
                        // rest of the share: the viewer could no longer ask for a
                        // keyframe and its estimate expired out of the bitrate
                        // controller. Retry instead, but do not spin forever on a
                        // sender that keeps failing.
                        Err(_) if consecutive_read_errors >= 4 => break,
                        Err(_) => {
                            consecutive_read_errors = consecutive_read_errors.saturating_add(1);
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            continue;
                        }
                    };
                    if packets.iter().any(|packet| {
                        packet
                            .as_any()
                            .downcast_ref::<PictureLossIndication>()
                            .is_some()
                            || packet.as_any().downcast_ref::<FullIntraRequest>().is_some()
                    }) {
                        keyframe_requested.store(true, Ordering::SeqCst);
                    }
                    for packet in packets {
                        let Some(remb) = packet
                            .as_any()
                            .downcast_ref::<ReceiverEstimatedMaximumBitrate>()
                        else {
                            continue;
                        };
                        if !remb.bitrate.is_finite() || remb.bitrate <= 0.0 {
                            continue;
                        }
                        let receiver_estimate_bps = remb.bitrate.min(u32::MAX as f32) as u32;
                        let Ok(mut viewers_guard) = viewers.lock() else {
                            continue;
                        };
                        let Some(viewer) = viewers_guard.get_mut(&viewer_peer_id) else {
                            continue;
                        };
                        if !Arc::ptr_eq(&viewer.media_queue, &media_queue) {
                            // Feedback from a closing watch must not retune its replacement.
                            continue;
                        }
                        let update = bitrate_controller.lock().ok().map(|mut controller| {
                            let update = controller
                                .update_receiver_estimate(&viewer_peer_id, receiver_estimate_bps);
                            (update, controller.low_tier_target_bitrate_bps())
                        });
                        let Some((
                            (next_bitrate_bps, lowest_estimate_bps, layer_change),
                            low_tier_bitrate_bps,
                        )) = update
                        else {
                            continue;
                        };
                        // This viewer's estimate decides its own encode, not the
                        // rate everyone else gets, so a weak link can no longer
                        // drag the whole share down to its level.
                        if let Some(layer) = layer_change {
                            viewer.layer = layer;
                            // Switch the subscription and invalidate its
                            // reference chain atomically with fan-out.
                            viewer.media_queue.require_keyframe();
                            keyframe_requested.store(true, Ordering::SeqCst);
                            if let Ok(mut status) = status.lock() {
                                status
                                    .viewer_layers
                                    .insert(viewer_peer_id.clone(), layer.as_str().to_string());
                                status.low_tier_viewers = status
                                    .viewer_layers
                                    .values()
                                    .filter(|recorded| recorded.as_str() == "low")
                                    .count();
                            }
                        }
                        effective_bitrate_bps.store(next_bitrate_bps, Ordering::Release);
                        if let Ok(mut status) = status.lock() {
                            status.effective_bitrate_bps = next_bitrate_bps;
                            status.receiver_estimated_bitrate_bps = Some(lowest_estimate_bps);
                            status.low_tier_bitrate_bps = low_tier_bitrate_bps;
                        }
                    }
                }
            });
        }

        fn spawn_audio_rtcp_reader(
            &self,
            rtp_sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>,
        ) {
            self.runtime
                .spawn(async move { while rtp_sender.read_rtcp().await.is_ok() {} });
        }

        fn remove_viewer(&self, member_id: &str, watch_session_id: &str) -> bool {
            if let Ok(mut pending) = self.pending_viewers.lock() {
                let pending_matches = pending
                    .get(member_id)
                    .map(|active| watch_session_id.is_empty() || active == watch_session_id)
                    .unwrap_or(false);
                if pending_matches {
                    pending.remove(member_id);
                }
            }
            let viewer = self.viewers.lock().ok().and_then(|mut viewers| {
                let matches = viewers
                    .get(member_id)
                    .map(|viewer| {
                        watch_session_id.is_empty() || viewer.watch_session_id == watch_session_id
                    })
                    .unwrap_or(false);
                matches.then(|| viewers.remove(member_id)).flatten()
            });
            if let Some(viewer) = viewer {
                let raised = self.viewers.lock().ok().and_then(|mut remaining| {
                    let mut controller = self.bitrate_controller.lock().ok()?;
                    let raised = controller.remove_viewer(member_id);
                    for (id, viewer) in remaining.iter_mut() {
                        let layer = controller.viewer_layer(id);
                        if viewer.layer != layer {
                            viewer.layer = layer;
                            viewer.media_queue.require_keyframe();
                            self.keyframe_requested.store(true, Ordering::SeqCst);
                            if let Ok(mut status) = self.status.lock() {
                                status
                                    .viewer_layers
                                    .insert(id.clone(), layer.as_str().to_string());
                                status.low_tier_viewers = controller.low_tier_viewers();
                            }
                        }
                    }
                    raised
                });
                if let Some(bitrate_bps) = raised {
                    self.effective_bitrate_bps
                        .store(bitrate_bps, Ordering::Release);
                    if let Ok(mut status) = self.status.lock() {
                        status.effective_bitrate_bps = bitrate_bps;
                    }
                    // The remaining viewers need a fresh intra frame at the new
                    // rate. Without it the encoder keeps sending the old, coarse
                    // picture until the next natural keyframe.
                    self.keyframe_requested.store(true, Ordering::SeqCst);
                }
                purge_outbound_signals(&self.outbound_signals, member_id, &viewer.watch_session_id);
                self.close_viewer_async(viewer);
                return true;
            }
            false
        }

        fn close_viewer_async(&self, viewer: NativeWebRtcViewer) {
            viewer.media_queue.close();
            let peer_connection = viewer.peer_connection;
            let close_task = self.runtime.spawn(async move {
                let started = Instant::now();
                if let Err(err) = peer_connection.close().await {
                    eprintln!("EchoVoice native screen share viewer close failed: {err}");
                }
                if started.elapsed() > PEER_CONNECTION_OPERATION_TIMEOUT {
                    eprintln!(
                        "EchoVoice native screen share viewer close completed slowly: {:?}",
                        started.elapsed()
                    );
                }
            });
            if let Ok(mut tasks) = self.viewer_close_tasks.lock() {
                tasks.retain(|task| !task.is_finished());
                tasks.push(close_task);
            }
        }

        fn wait_for_viewer_close_tasks(&self) {
            let tasks = self
                .viewer_close_tasks
                .lock()
                .map(|mut tasks| tasks.drain(..).collect::<Vec<_>>())
                .unwrap_or_default();
            if tasks.is_empty() {
                return;
            }
            let result = self.runtime.block_on(async move {
                tokio::time::timeout(Duration::from_secs(5), async move {
                    for task in tasks {
                        let _ = task.await;
                    }
                })
                .await
            });
            if result.is_err() {
                eprintln!("EchoVoice native screen share viewer cleanup exceeded 5 seconds");
            }
        }

        fn handle_signal(
            &self,
            member_id: &str,
            signal_type: &str,
            data: serde_json::Value,
            status: &Arc<Mutex<NativeScreenShareRuntimeStatus>>,
        ) -> Result<(), String> {
            let signal_watch_session_id = screen_share_signal_watch_session_id(&data);
            let viewer = self
                .viewers
                .lock()
                .map_err(|_| "native WebRTC viewer map is poisoned".to_string())?
                .get(member_id)
                .map(|viewer| {
                    (
                        Arc::clone(&viewer.peer_connection),
                        Arc::clone(&viewer.ready_for_media),
                        viewer.watch_session_id.clone(),
                        viewer.offered_primary_profile.clone(),
                        Arc::clone(&viewer.pending_ice_candidates),
                    )
                });
            let Some((
                peer_connection,
                ready_for_media,
                watch_session_id,
                offered_primary_profile,
                pending_ice_candidates,
            )) = viewer
            else {
                if let Ok(mut status) = status.lock() {
                    status.ignored_viewer_signal_count =
                        status.ignored_viewer_signal_count.saturating_add(1);
                    status.last_error = Some(format!(
                        "native screen share ignored {signal_type}: viewer {member_id} is not registered"
                    ));
                }
                return Ok(());
            };
            if !watch_session_id.is_empty() && signal_watch_session_id != watch_session_id {
                if let Ok(mut status) = status.lock() {
                    status.ignored_viewer_signal_count =
                        status.ignored_viewer_signal_count.saturating_add(1);
                    status.last_error = Some(format!(
                        "native screen share ignored {signal_type}: stale watch session for viewer {member_id}"
                    ));
                }
                return Ok(());
            }
            match signal_type {
                "screen-share-answer" => {
                    let description = screen_share_signal_description(data)?;
                    let parsed = description
                        .unmarshal()
                        .map_err(|err| format!("parse screen share answer: {err}"))?;
                    let negotiated = screen_share_answer_layer(&parsed, &offered_primary_profile)?;
                    self.runtime
                        .block_on(async {
                            tokio::time::timeout(
                                PEER_CONNECTION_OPERATION_TIMEOUT,
                                peer_connection.set_remote_description(description),
                            )
                            .await
                        })
                        .map_err(|_| "timed out applying native screen share answer".to_string())?
                        .map_err(|err| format!("apply native screen share answer: {err}"))?;
                    if negotiated == ScreenShareLayer::Compatibility {
                        if let Ok(mut viewers) = self.viewers.lock() {
                            if let Some(viewer) = viewers.get_mut(member_id) {
                                viewer.layer = negotiated;
                                viewer.media_queue.require_keyframe();
                                if let Ok(mut controller) = self.bitrate_controller.lock() {
                                    controller.note_viewer_layer(member_id, negotiated);
                                }
                            }
                        }
                        if let Ok(mut status) = status.lock() {
                            status
                                .viewer_layers
                                .insert(member_id.to_string(), negotiated.as_str().to_string());
                        }
                    }
                    ready_for_media.store(true, Ordering::SeqCst);
                    if let Ok(mut status) = status.lock() {
                        status.applied_answer_count = status.applied_answer_count.saturating_add(1);
                        status.last_error = None;
                    }
                    self.keyframe_requested.store(true, Ordering::SeqCst);
                    // Candidates that raced ahead of this answer were parked;
                    // apply them now so the viewer is not limited to whatever
                    // the answer happened to carry inline.
                    let parked = pending_ice_candidates
                        .lock()
                        .map(|mut candidates| candidates.drain(..).collect::<Vec<_>>())
                        .unwrap_or_default();
                    let mut applied = 0_u64;
                    for candidate in parked {
                        let outcome = self.runtime.block_on(async {
                            tokio::time::timeout(
                                PEER_CONNECTION_OPERATION_TIMEOUT,
                                peer_connection.add_ice_candidate(candidate),
                            )
                            .await
                        });
                        match outcome {
                            Ok(Ok(())) => applied = applied.saturating_add(1),
                            Ok(Err(err)) => {
                                if let Ok(mut status) = status.lock() {
                                    status.last_error = Some(format!(
                                        "parked native screen share ICE candidate rejected: {err}"
                                    ));
                                }
                            }
                            Err(_) => {
                                if let Ok(mut status) = status.lock() {
                                    status.last_error = Some(
                                        "timed out applying parked native screen share ICE candidate"
                                            .to_string(),
                                    );
                                }
                            }
                        }
                    }
                    if applied > 0 {
                        if let Ok(mut status) = status.lock() {
                            status.applied_ice_candidate_count =
                                status.applied_ice_candidate_count.saturating_add(applied);
                        }
                    }
                }
                "screen-share-ice-candidate" => {
                    if let Some(candidate) = screen_share_signal_candidate(data)? {
                        // A viewer trickles candidates as soon as it has them,
                        // which can beat its own answer. webrtc-rs rejects any
                        // candidate while the remote description is missing, so
                        // park it and let the answer branch apply it instead of
                        // throwing the path away.
                        let has_remote_description = self.runtime.block_on(async {
                            peer_connection.remote_description().await.is_some()
                        });
                        if !has_remote_description {
                            if let Ok(mut parked) = pending_ice_candidates.lock() {
                                if !parked.contains(&candidate) {
                                    if parked.len() >= MAX_OUTBOUND_SCREEN_SHARE_SIGNALS_PER_VIEWER
                                    {
                                        return Err("native screen share pending ICE candidate queue is full".to_string());
                                    }
                                    parked.push(candidate);
                                }
                            }
                            return Ok(());
                        }
                        self.runtime
                            .block_on(async {
                                tokio::time::timeout(
                                    PEER_CONNECTION_OPERATION_TIMEOUT,
                                    peer_connection.add_ice_candidate(candidate),
                                )
                                .await
                            })
                            .map_err(|_| {
                                "timed out applying native screen share ICE candidate".to_string()
                            })?
                            .map_err(|err| {
                                format!("apply native screen share ICE candidate: {err}")
                            })?;
                        if let Ok(mut status) = status.lock() {
                            status.applied_ice_candidate_count =
                                status.applied_ice_candidate_count.saturating_add(1);
                            status.last_error = None;
                        }
                    }
                }
                "screen-share-restart-ice" => {
                    // An ICE failure is a path problem, not a media problem. The
                    // encoder, its bitrate and its keyframe cadence are all still
                    // good, so renegotiate with fresh credentials instead of
                    // tearing the viewer down and making it pay for a new offer
                    // and a new keyframe.
                    let restarted = self.runtime.block_on(async {
                        tokio::time::timeout(PEER_CONNECTION_OPERATION_TIMEOUT, async {
                            // restart_ice() refuses to run while our own
                            // gathering is still in flight, and a viewer can ask
                            // for a restart moments after the connection comes up
                            // (the offer no longer waits for gathering, so that
                            // window is real). Wait the current round out rather
                            // than dropping the request on the floor.
                            let mut gathering_complete =
                                peer_connection.gathering_complete_promise().await;
                            if peer_connection.ice_gathering_state()
                                == RTCIceGatheringState::Gathering
                            {
                                let _ = tokio::time::timeout(
                                    Duration::from_secs(1),
                                    gathering_complete.recv(),
                                )
                                .await;
                            }
                            peer_connection
                                .restart_ice()
                                .await
                                .map_err(|err| format!("restart native screen share ICE: {err}"))?;
                            let offer =
                                peer_connection.create_offer(None).await.map_err(|err| {
                                    format!("recreate native screen share offer: {err}")
                                })?;
                            peer_connection
                                .set_local_description(offer.clone())
                                .await
                                .map_err(|err| {
                                    format!("set native screen share restart offer: {err}")
                                })?;
                            // Restart candidates trickle the same way, so this
                            // path does not wait for gathering either.
                            Ok::<_, String>(
                                peer_connection.local_description().await.unwrap_or(offer),
                            )
                        })
                        .await
                    });
                    match restarted {
                        Ok(Ok(offer)) => {
                            push_outbound_signal(
                                &self.outbound_signals,
                                member_id.to_string(),
                                "screen-share-offer",
                                json!({
                                    "share_id": self.share_id,
                                    "watch_session_id": watch_session_id.clone(),
                                    "description": offer,
                                }),
                            );
                            self.keyframe_requested.store(true, Ordering::SeqCst);
                            if let Ok(mut status) = status.lock() {
                                status.last_error = None;
                            }
                        }
                        Ok(Err(err)) => {
                            // Never fail the viewer's signal over this: its own
                            // fallback timer rebuilds the connection when no
                            // offer arrives.
                            if let Ok(mut status) = status.lock() {
                                status.ignored_viewer_signal_count =
                                    status.ignored_viewer_signal_count.saturating_add(1);
                                status.last_error = Some(err);
                            }
                        }
                        Err(_) => {
                            if let Ok(mut status) = status.lock() {
                                status.ignored_viewer_signal_count =
                                    status.ignored_viewer_signal_count.saturating_add(1);
                                status.last_error = Some(
                                    "timed out restarting native screen share ICE".to_string(),
                                );
                            }
                        }
                    }
                }
                _ => {}
            }
            Ok(())
        }

        fn write_h264_sample(
            &self,
            layer: ScreenShareLayer,
            encoded_h264: Vec<u8>,
            capture_time_ns: u64,
        ) {
            if encoded_h264.is_empty() {
                return;
            }
            let is_keyframe = h264_annexb_contains_nal_type(&encoded_h264, 5);
            if layer == ScreenShareLayer::High && is_keyframe {
                if let Some(profile_id) = h264_annexb_sps_profile_level_id(&encoded_h264) {
                    self.observed_sps.send_if_modified(|seen| {
                        if seen.as_ref() == Some(&profile_id) {
                            return false;
                        }
                        *seen = Some(profile_id);
                        true
                    });
                }
            }
            if layer == ScreenShareLayer::Compatibility && is_keyframe {
                if let Some(profile_id) = h264_annexb_sps_profile_level_id(&encoded_h264) {
                    if !same_h264_subprofile(&profile_id, "42e01f") {
                        if let Ok(mut status) = self.status.lock() {
                            status.last_error = Some(format!(
                                "compatibility encoder emitted unsupported H.264 SPS {profile_id}"
                            ));
                        }
                        return;
                    }
                    if let Ok(mut seen) = self.observed_compatibility_sps.lock() {
                        *seen = Some(profile_id);
                    }
                }
            }
            let capture_tick = video_tick(capture_time_ns);
            let enqueued_at = Instant::now();
            let data = Bytes::from(encoded_h264);
            let Ok(viewers) = self.viewers.lock() else {
                return;
            };
            let mut subscribed = 0;
            let mut overflowing = 0;
            let mut overload_drops = 0;
            let mut dropped = 0;
            for viewer in viewers
                .values()
                .filter(|viewer| viewer.layer == layer && viewer.can_send_media())
            {
                subscribed += 1;
                match viewer.media_queue.push_latest(QueuedH264Sample {
                    data: data.clone(),
                    capture_tick,
                    enqueued_at,
                    is_keyframe,
                }) {
                    ViewerMediaQueuePushResult::Enqueued => {}
                    ViewerMediaQueuePushResult::DroppedAwaitingKeyframe => {
                        if viewer.media_queue.has_started() {
                            dropped += 1;
                        }
                    }
                    ViewerMediaQueuePushResult::Backpressure(count) => {
                        dropped += count as u64;
                        overload_drops += count as u64;
                        overflowing += 1;
                    }
                }
            }
            drop(viewers);
            if dropped > 0 {
                if let Ok(mut status) = self.status.lock() {
                    status.dropped_frames = status.dropped_frames.saturating_add(dropped);
                    status.viewer_backpressure_drops = status
                        .viewer_backpressure_drops
                        .saturating_add(overload_drops);
                }
            }
            if overflowing > 0 && !is_keyframe {
                self.keyframe_requested.store(true, Ordering::SeqCst);
            }
            if shared_encode_is_backpressured(layer, subscribed, overflowing) {
                self.reduce_bitrate_for_backpressure();
            }
        }

        fn effective_bitrate_bps(&self) -> u32 {
            self.effective_bitrate_bps.load(Ordering::Acquire)
        }

        /// How much the reduced tier may spend right now, or `None` when no
        /// viewer is subscribed to it and it should not be encoded at all.
        fn low_tier_target_bitrate_bps(&self) -> Option<u32> {
            self.bitrate_controller
                .lock()
                .ok()
                .and_then(|controller| controller.low_tier_target_bitrate_bps())
        }

        fn compatibility_target_bitrate_bps(&self) -> Option<u32> {
            let controller = self.bitrate_controller.lock().ok()?;
            if !controller
                .viewer_layers
                .values()
                .any(|layer| *layer == ScreenShareLayer::Compatibility)
            {
                return None;
            }
            let estimate = controller
                .viewer_estimates
                .iter()
                .filter(|(id, estimate)| {
                    controller.viewer_layer(id) == ScreenShareLayer::Compatibility
                        && estimate.updated_at.elapsed() <= NATIVE_SCREEN_SHARE_ESTIMATE_MAX_AGE
                })
                .map(|(_, estimate)| {
                    scale_bitrate(
                        estimate.bitrate_bps,
                        NATIVE_SCREEN_SHARE_REMB_HEADROOM_PERCENT,
                    )
                })
                .min();
            Some(estimate.unwrap_or(controller.maximum_bitrate_bps).clamp(
                NATIVE_SCREEN_SHARE_MIN_BITRATE_BPS.min(controller.maximum_bitrate_bps),
                controller.maximum_bitrate_bps,
            ))
        }

        fn retain_effective_bitrate(&self, bitrate_bps: u32) {
            if let Ok(mut controller) = self.bitrate_controller.lock() {
                controller.retain_effective_bitrate(bitrate_bps);
            }
            self.effective_bitrate_bps
                .store(bitrate_bps, Ordering::Release);
            if let Ok(mut status) = self.status.lock() {
                status.effective_bitrate_bps = bitrate_bps;
            }
        }

        /// Applies a bitrate the user picked while the share is already running.
        /// The encode pipeline already rebuilds the encoder whenever the working
        /// bitrate changes, so only the ceiling has to move.
        fn set_maximum_bitrate(&self, bitrate_bps: u32) -> Result<(), String> {
            use super::ScreenShareVideoProfile;
            if !(ScreenShareVideoProfile::MIN_TARGET_BITRATE_BPS
                ..=ScreenShareVideoProfile::MAX_TARGET_BITRATE_BPS)
                .contains(&bitrate_bps)
            {
                return Err("native screen share bitrate is out of range".to_string());
            }
            let next_level = self
                .startup_profile
                .clone()
                .with_target_bitrate_bps(bitrate_bps)
                .required_h264_level_idc();
            if next_level > self.startup_profile.required_h264_level_idc() {
                return Err("restart the screen share to negotiate the higher H.264 level needed for this bitrate".to_string());
            }
            let (maximum, effective) = {
                let mut controller = self.bitrate_controller.lock().map_err(|_| {
                    "native screen share bitrate controller is poisoned".to_string()
                })?;
                controller.set_maximum_bitrate(bitrate_bps);
                (
                    controller.maximum_bitrate_bps,
                    controller.effective_bitrate_bps,
                )
            };
            self.effective_bitrate_bps
                .store(effective, Ordering::Release);
            if let Ok(mut status) = self.status.lock() {
                status.target_bitrate_bps = maximum;
                status.effective_bitrate_bps = effective;
            }
            Ok(())
        }

        /// Applies a frame rate the user picked while the share is already
        /// running. The capture keeps producing; the frame pump only forwards
        /// fewer of those frames, so nothing has to be renegotiated.
        fn set_target_frame_rate(&self, frame_rate: u32) -> Result<(), String> {
            ev_media::VideoFrameRate::new(frame_rate)
                .map_err(|_| "native screen share frame rate is out of range".to_string())?;
            if frame_rate > self.startup_profile.frame_rate.fps() {
                return Err("restart the screen share to configure the higher capture and encoder frame rate".to_string());
            }
            self.target_frame_rate.store(frame_rate, Ordering::Release);
            Ok(())
        }

        fn target_frame_rate(&self) -> Arc<AtomicU32> {
            Arc::clone(&self.target_frame_rate)
        }

        fn reduce_bitrate_for_backpressure(&self) {
            let next_bitrate_bps = self
                .bitrate_controller
                .lock()
                .ok()
                .map(|mut controller| controller.reduce_for_backpressure());
            let Some(next_bitrate_bps) = next_bitrate_bps else {
                return;
            };
            self.effective_bitrate_bps
                .store(next_bitrate_bps, Ordering::Release);
            if let Ok(mut status) = self.status.lock() {
                status.effective_bitrate_bps = next_bitrate_bps;
            }
        }

        fn probe_bitrate_upward(&self) {
            if !self.has_ready_viewers() {
                return;
            }
            let next_bitrate_bps = self
                .bitrate_controller
                .lock()
                .ok()
                .map(|mut controller| controller.probe_upward());
            let Some(next_bitrate_bps) = next_bitrate_bps else {
                return;
            };
            self.effective_bitrate_bps
                .store(next_bitrate_bps, Ordering::Release);
            if let Ok(mut status) = self.status.lock() {
                status.effective_bitrate_bps = next_bitrate_bps;
            }
        }

        /// The capture produced no frame for long enough that the encoder was
        /// idle and the viewers' decoders dropped their reference frame. Push
        /// the restored rate into the status so the UI and the diagnostics show
        /// the stream really restarts at full quality.
        fn resume_after_capture_gap(&self) {
            let next_bitrate_bps = self
                .bitrate_controller
                .lock()
                .map(|mut controller| controller.resume_after_idle())
                .unwrap_or_else(|_| self.effective_bitrate_bps());
            self.effective_bitrate_bps
                .store(next_bitrate_bps, Ordering::Release);
            if let Ok(mut status) = self.status.lock() {
                status.effective_bitrate_bps = next_bitrate_bps;
            }
        }

        fn spawn_audio_writer(
            &self,
            track: Arc<TrackLocalStaticRTP>,
        ) -> tokio_mpsc::Sender<QueuedOpusSample> {
            let (tx, mut rx) =
                tokio_mpsc::channel::<QueuedOpusSample>(SCREEN_SHARE_AUDIO_QUEUE_PACKETS);
            let status = Arc::clone(&self.status);
            self.runtime.spawn(async move {
                let mut packetizer = ScreenSharePacketizer::audio();
                while let Some(sample) = rx.recv().await {
                    if sample.enqueued_at.elapsed() >= SCREEN_SHARE_AUDIO_MAX_QUEUE_AGE {
                        if let Ok(mut status) = status.lock() {
                            status.audio_queue_drops = status.audio_queue_drops.saturating_add(1);
                        }
                        continue;
                    }
                    let result = packetizer
                        .write(&track, &sample.data, sample.capture_tick)
                        .await;
                    if let Ok(mut status) = status.lock() {
                        match result {
                            Ok(()) => {
                                status.sample_write_count =
                                    status.sample_write_count.saturating_add(1);
                                status.audio_samples_sent = status
                                    .audio_samples_sent
                                    .saturating_add(SCREEN_SHARE_AUDIO_FRAME_SAMPLES as u64);
                            }
                            Err(err) => {
                                status.sample_write_error_count =
                                    status.sample_write_error_count.saturating_add(1);
                                status.last_sample_write_error =
                                    Some(format!("send native Opus sample: {err}"));
                                status.audio_send_errors =
                                    status.audio_send_errors.saturating_add(1);
                            }
                        }
                    }
                }
            });
            tx
        }

        fn write_opus_sample(&self, encoded_opus: Vec<u8>, capture_tick: u64) {
            if encoded_opus.is_empty() || self.audio_codec.is_none() {
                return;
            }
            let sample = QueuedOpusSample {
                data: Bytes::from(encoded_opus),
                capture_tick,
                enqueued_at: Instant::now(),
            };
            let mut dropped = 0_u64;
            if let Ok(viewers) = self.viewers.lock() {
                for viewer in viewers.values().filter(|viewer| viewer.can_send_media()) {
                    if let Some(tx) = &viewer.audio_sample_tx {
                        if tx.try_send(sample.clone()).is_err() {
                            dropped += 1;
                        }
                    }
                }
            }
            if dropped > 0 {
                if let Ok(mut status) = self.status.lock() {
                    status.audio_queue_drops = status.audio_queue_drops.saturating_add(dropped);
                }
            }
        }

        fn has_ready_viewers(&self) -> bool {
            self.viewers
                .lock()
                .map(|viewers| viewers.values().any(NativeWebRtcViewer::can_send_media))
                .unwrap_or(false)
        }

        fn close_all(&self) {
            if let Ok(mut pending) = self.pending_viewers.lock() {
                pending.clear();
            }
            let viewers = self
                .viewers
                .lock()
                .map(|mut viewers| {
                    viewers
                        .drain()
                        .map(|(_, viewer)| viewer)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for viewer in viewers {
                purge_outbound_signals(&self.outbound_signals, "", &viewer.watch_session_id);
                self.close_viewer_async(viewer);
            }
            self.wait_for_viewer_close_tasks();
            if let Ok(mut signals) = self.outbound_signals.lock() {
                signals.clear();
            }
        }
    }

    fn push_outbound_signal(
        outbound_signals: &Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
        member_id: String,
        signal_type: &str,
        data: serde_json::Value,
    ) {
        if let Ok(mut signals) = outbound_signals.lock() {
            if signal_type == "screen-share-offer" {
                signals.retain(|signal| signal.member_id != member_id);
            }
            let viewer_signal_count = signals
                .iter()
                .filter(|signal| signal.member_id == member_id)
                .count();
            if viewer_signal_count >= MAX_OUTBOUND_SCREEN_SHARE_SIGNALS_PER_VIEWER
                && signal_type == "screen-share-ice-candidate"
            {
                return;
            }
            signals.push(NativeScreenShareOutboundSignal {
                member_id,
                signal_type: signal_type.to_string(),
                data,
            });
            while signals.len() > MAX_OUTBOUND_SCREEN_SHARE_SIGNALS {
                let index = signals
                    .iter()
                    .position(|signal| signal.signal_type == "screen-share-ice-candidate")
                    .unwrap_or(0);
                signals.remove(index);
            }
        }
    }

    fn purge_outbound_signals(
        outbound_signals: &Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
        member_id: &str,
        watch_session_id: &str,
    ) {
        if let Ok(mut signals) = outbound_signals.lock() {
            signals.retain(|signal| {
                if !member_id.is_empty() && signal.member_id != member_id {
                    return true;
                }
                if watch_session_id.is_empty() {
                    return false;
                }
                screen_share_signal_watch_session_id(&signal.data) != watch_session_id
            });
        }
    }

    fn screen_share_signal_description(
        data: serde_json::Value,
    ) -> Result<RTCSessionDescription, String> {
        let value = data.get("description").cloned().unwrap_or(data);
        serde_json::from_value(value)
            .map_err(|err| format!("parse native screen share session description: {err}"))
    }

    fn screen_share_signal_candidate(
        data: serde_json::Value,
    ) -> Result<Option<RTCIceCandidateInit>, String> {
        let value = data.get("candidate").cloned().unwrap_or(data);
        if value.is_null() {
            return Ok(None);
        }
        serde_json::from_value(value)
            .map(Some)
            .map_err(|err| format!("parse native screen share ICE candidate: {err}"))
    }

    fn screen_share_signal_watch_session_id(data: &serde_json::Value) -> String {
        data.get("watch_session_id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    }

    fn h264_annexb_contains_nal_type(data: &[u8], target_type: u8) -> bool {
        let mut offset = 0;
        while offset < data.len() {
            let Some(start_code_len) = h264_start_code_len_at(data, offset) else {
                offset += 1;
                continue;
            };
            let nal_start = offset + start_code_len;
            if nal_start >= data.len() {
                return false;
            }
            if data[nal_start] & 0x1f == target_type {
                return true;
            }
            offset = nal_start + 1;
        }
        false
    }

    fn h264_start_code_len_at(data: &[u8], offset: usize) -> Option<usize> {
        if offset + 4 <= data.len()
            && data[offset] == 0
            && data[offset + 1] == 0
            && data[offset + 2] == 0
            && data[offset + 3] == 1
        {
            return Some(4);
        }
        if offset + 3 <= data.len()
            && data[offset] == 0
            && data[offset + 1] == 0
            && data[offset + 2] == 1
        {
            return Some(3);
        }
        None
    }

    fn h264_annexb_sps_profile_level_id(data: &[u8]) -> Option<String> {
        let mut offset = 0;
        while offset < data.len() {
            let Some(start_code_len) = h264_start_code_len_at(data, offset) else {
                offset += 1;
                continue;
            };
            let nal_start = offset + start_code_len;
            if nal_start + 4 <= data.len() && data[nal_start] & 0x1f == 7 {
                return Some(format!(
                    "{:02x}{:02x}{:02x}",
                    data[nal_start + 1],
                    data[nal_start + 2],
                    data[nal_start + 3]
                ));
            }
            offset = nal_start + 1;
        }
        None
    }

    #[cfg(target_os = "windows")]
    struct NativeScreenShareAudioRuntime {
        worker: Option<thread::JoinHandle<()>>,
        stop: Arc<AtomicBool>,
    }

    #[cfg(target_os = "windows")]
    impl Drop for NativeScreenShareAudioRuntime {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn start_native_screen_share_audio(
        request: &NativeScreenShareStartRequest,
        status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
        stop_flag: Arc<AtomicBool>,
        sender: Arc<NativeWebRtcSender>,
    ) -> Result<Option<NativeScreenShareAudioRuntime>, String> {
        use crate::windows_process_loopback::{
            LoopbackClock, ProcessLoopbackCapture, ProcessLoopbackMode, CHANNELS,
        };

        if !request.include_audio {
            return Ok(None);
        }
        let (target_process_id, loopback_mode) = match request.source_kind.as_str() {
            "window" => (
                request.source_process_id.ok_or_else(|| {
                    "the selected window does not expose a process id for audio capture".to_string()
                })?,
                ProcessLoopbackMode::IncludeProcessTree,
            ),
            "screen" => (std::process::id(), ProcessLoopbackMode::ExcludeProcessTree),
            kind => return Err(format!("unsupported native audio source kind: {kind}")),
        };
        let (startup_tx, startup_rx) = mpsc::channel();
        let worker_status = Arc::clone(&status);
        let worker_stop = Arc::clone(&stop_flag);
        let worker = thread::Builder::new()
            .name("ev-screen-share-audio".to_string())
            .spawn(move || {
                let mut encoder = match OpusEncoder::new_audio(
                    SCREEN_SHARE_AUDIO_SAMPLE_RATE,
                    CHANNELS,
                    SCREEN_SHARE_AUDIO_BITRATE,
                    10,
                    true,
                    true,
                    5,
                ) {
                    Ok(encoder) => encoder,
                    Err(err) => {
                        let _ = startup_tx
                            .send(Err(format!("create screen-share Opus encoder: {err}")));
                        return;
                    }
                };
                let capture = match ProcessLoopbackCapture::open(target_process_id, loopback_mode) {
                    Ok(capture) => capture,
                    Err(err) => {
                        let _ = startup_tx.send(Err(err));
                        return;
                    }
                };
                let _ = startup_tx.send(Ok(()));
                let mut captured =
                    Vec::with_capacity(SCREEN_SHARE_AUDIO_FRAME_SAMPLES * CHANNELS * 2);
                let mut pending =
                    VecDeque::with_capacity(SCREEN_SHARE_AUDIO_FRAME_SAMPLES * CHANNELS * 4);
                let mut frame = vec![0.0_f32; SCREEN_SHARE_AUDIO_FRAME_SAMPLES * CHANNELS];
                let mut encoded = vec![0_u8; 4096];
                let mut clock = LoopbackClock::default();
                let mut pending_tick = 0_u64;
                while !worker_stop.load(Ordering::SeqCst) {
                    captured.clear();
                    match capture.read_packet(&mut captured) {
                        Ok(Some(packet)) => {
                            let (tick, discontinuity) = clock.observe(&packet);
                            if discontinuity {
                                pending.clear();
                            }
                            if pending.is_empty() {
                                pending_tick = tick;
                            }
                            pending.extend(captured.iter().copied());
                            while pending.len() >= frame.len() {
                                for sample in &mut frame {
                                    *sample = pending.pop_front().unwrap_or_default();
                                }
                                match encoder.encode_float(
                                    &frame,
                                    SCREEN_SHARE_AUDIO_FRAME_SAMPLES,
                                    &mut encoded,
                                ) {
                                    Ok(packet_len) => {
                                        sender.write_opus_sample(
                                            encoded[..packet_len].to_vec(),
                                            pending_tick,
                                        );
                                        pending_tick = pending_tick.saturating_add(
                                            SCREEN_SHARE_AUDIO_FRAME_SAMPLES as u64,
                                        );
                                    }
                                    Err(err) => {
                                        if let Ok(mut status) = worker_status.lock() {
                                            status.audio_enabled = false;
                                            status.audio_capture_errors =
                                                status.audio_capture_errors.saturating_add(1);
                                            status.last_error = Some(format!(
                                                "encode screen-share Opus audio: {err}"
                                            ));
                                        }
                                        return;
                                    }
                                }
                            }
                        }
                        Ok(None) => thread::sleep(Duration::from_millis(3)),
                        Err(err) => {
                            if let Ok(mut status) = worker_status.lock() {
                                status.audio_enabled = false;
                                status.audio_capture_errors =
                                    status.audio_capture_errors.saturating_add(1);
                                status.last_error = Some(err);
                            }
                            return;
                        }
                    }
                }
            })
            .map_err(|err| format!("start native screen-share audio worker: {err}"))?;
        match startup_rx.recv_timeout(Duration::from_secs(6)) {
            Ok(Ok(())) => Ok(Some(NativeScreenShareAudioRuntime {
                worker: Some(worker),
                stop: stop_flag,
            })),
            Ok(Err(err)) => {
                stop_flag.store(true, Ordering::SeqCst);
                let _ = worker.join();
                Err(err)
            }
            Err(_) => {
                stop_flag.store(true, Ordering::SeqCst);
                let _ = worker.join();
                Err("timed out starting native screen-share audio capture".to_string())
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn start_native_screen_share_audio(
        request: &NativeScreenShareStartRequest,
        _status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
        _stop_flag: Arc<AtomicBool>,
        _sender: Arc<NativeWebRtcSender>,
    ) -> Result<Option<()>, String> {
        if request.include_audio {
            return Err(
                "filtered native screen-share audio is not implemented on this platform"
                    .to_string(),
            );
        }
        Ok(None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn run_sender(
        app: AppHandle,
        _session_id: String,
        request: NativeScreenShareStartRequest,
        status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
        stop_flag: Arc<AtomicBool>,
        startup_tx: mpsc::Sender<Result<(), String>>,
        control_rx: mpsc::Receiver<NativeScreenShareControl>,
        outbound_signals: Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
    ) {
        let keyframe_requested = Arc::new(AtomicBool::new(true));
        let sender = match NativeWebRtcSender::new(
            &request,
            outbound_signals,
            Arc::clone(&status),
            Arc::clone(&keyframe_requested),
        ) {
            Ok(sender) => Arc::new(sender),
            Err(err) => {
                if let Ok(mut status) = status.lock() {
                    status.phase = "failed".to_string();
                    status.last_error = Some(err.clone());
                }
                let _ = startup_tx.send(Err(err));
                return;
            }
        };
        let result = platform::run_capture(
            &request,
            Arc::clone(&status),
            Arc::clone(&stop_flag),
            Arc::clone(&sender),
            keyframe_requested,
        );
        match result {
            Ok(runtime) => {
                let audio_runtime = match start_native_screen_share_audio(
                    &request,
                    Arc::clone(&status),
                    Arc::clone(&stop_flag),
                    Arc::clone(&sender),
                ) {
                    Ok(runtime) => runtime,
                    Err(err) => {
                        drop(runtime);
                        sender.close_all();
                        if let Ok(mut status) = status.lock() {
                            status.phase = "failed".to_string();
                            status.audio_enabled = false;
                            status.last_error = Some(err.clone());
                        }
                        emit_status(&app, &status);
                        let _ = startup_tx.send(Err(err));
                        return;
                    }
                };
                if let Ok(mut status) = status.lock() {
                    status.phase = "running".to_string();
                    status.last_error = None;
                }
                emit_status(&app, &status);
                let _ = startup_tx.send(Ok(()));
                let mut last_status_emit_ms = 0;
                while !stop_flag.load(Ordering::SeqCst) {
                    for _ in 0..64 {
                        let Ok(command) = control_rx.try_recv() else {
                            break;
                        };
                        if let Err(err) =
                            handle_native_screen_share_control(&sender, &status, command)
                        {
                            if let Ok(mut status) = status.lock() {
                                status.last_error = Some(err);
                            }
                        }
                        emit_status(&app, &status);
                    }
                    let now = now_ms();
                    let status_interval_ms = status
                        .lock()
                        .map(|status| {
                            if status.preview_enabled {
                                NATIVE_SCREEN_SHARE_PREVIEW_STATUS_INTERVAL_MS
                            } else {
                                NATIVE_SCREEN_SHARE_STATUS_INTERVAL_MS
                            }
                        })
                        .unwrap_or(NATIVE_SCREEN_SHARE_STATUS_INTERVAL_MS);
                    if now.saturating_sub(last_status_emit_ms) >= status_interval_ms {
                        emit_status(&app, &status);
                        last_status_emit_ms = now;
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                drop(audio_runtime);
                drop(runtime);
                sender.close_all();
                if let Ok(mut status) = status.lock() {
                    status.phase = "stopped".to_string();
                }
                emit_status(&app, &status);
            }
            Err(err) => {
                if let Ok(mut status) = status.lock() {
                    status.phase = "failed".to_string();
                    status.last_error = Some(err.clone());
                }
                emit_status(&app, &status);
                let _ = startup_tx.send(Err(err));
            }
        }
    }

    fn emit_status(app: &AppHandle, status: &Arc<Mutex<NativeScreenShareRuntimeStatus>>) {
        let snapshot = status.lock().ok().map(|status| status.status_snapshot());
        if let Some(snapshot) = snapshot {
            if let Err(err) = app.emit(NATIVE_SCREEN_SHARE_STATUS_EVENT, snapshot) {
                eprintln!("EchoVoice native screen share status emit failed: {err}");
            }
        }
    }

    fn handle_native_screen_share_control(
        sender: &Arc<NativeWebRtcSender>,
        status: &Arc<Mutex<NativeScreenShareRuntimeStatus>>,
        command: NativeScreenShareControl,
    ) -> Result<(), String> {
        match command {
            NativeScreenShareControl::SetQuality { setting, completed } => {
                let result = match setting {
                    super::NativeScreenShareQualitySetting::FrameRate(fps) => {
                        sender.set_target_frame_rate(fps)
                    }
                    super::NativeScreenShareQualitySetting::MaxBitrate(bps) => {
                        sender.set_maximum_bitrate(bps)
                    }
                };
                let _ = completed.send(result);
                Ok(())
            }
            NativeScreenShareControl::AddViewer {
                member_id,
                watch_session_id,
                relay_only,
            } => {
                if sender.add_viewer(member_id.clone(), watch_session_id, relay_only)? {
                    if let Ok(mut status) = status.lock() {
                        if !status.viewer_member_ids.contains(&member_id) {
                            status.viewer_member_ids.push(member_id);
                            status.viewer_member_ids.sort();
                        }
                    }
                }
                Ok(())
            }
            NativeScreenShareControl::RemoveViewer {
                member_id,
                watch_session_id,
            } => {
                if sender.remove_viewer(&member_id, &watch_session_id) {
                    if let Ok(mut status) = status.lock() {
                        status
                            .viewer_member_ids
                            .retain(|existing| existing != &member_id);
                        // The path was recorded for a connection that no longer
                        // exists. Keeping it would make the map grow for the
                        // lifetime of the share and every status snapshot pay
                        // for viewers that already left.
                        status.viewer_paths.remove(&member_id);
                        status.viewer_layers.remove(&member_id);
                        status.low_tier_viewers = status
                            .viewer_layers
                            .values()
                            .filter(|layer| layer.as_str() == "low")
                            .count();
                    }
                }
                Ok(())
            }
            NativeScreenShareControl::HandleSignal {
                member_id,
                signal_type,
                data,
            } => sender.handle_signal(&member_id, &signal_type, data, status),
        }
    }

    struct NativeH264Encoder {
        encoder: Encoder,
        width: usize,
        height: usize,
        frame_index: u64,
        y_plane: Vec<u8>,
        u_plane: Vec<u8>,
        v_plane: Vec<u8>,
        source_layout: Option<(usize, usize, usize)>,
        source_x_starts: Vec<usize>,
        source_x_ends: Vec<usize>,
        source_y_starts: Vec<usize>,
        source_y_ends: Vec<usize>,
        fit_width: usize,
        fit_height: usize,
        fit_offset_x: usize,
        fit_offset_y: usize,
    }

    impl NativeH264Encoder {
        #[cfg(test)]
        fn new(profile: &super::ScreenShareVideoProfile) -> Result<Self, String> {
            Self::new_with_content_mode(profile, "balanced", false)
        }

        fn new_with_content_mode(
            profile: &super::ScreenShareVideoProfile,
            content_mode: &str,
            constrained: bool,
        ) -> Result<Self, String> {
            let width = even_dimension(profile.output_size.width()).max(2) as usize;
            let height = even_dimension(profile.output_size.height()).max(2) as usize;
            let (complexity, keyframe_seconds) = match content_mode {
                "detail" => (Complexity::High, 3),
                "motion" => (Complexity::Low, 1),
                _ => (Complexity::Medium, 2),
            };
            let config = EncoderConfig::new()
                .usage_type(UsageType::ScreenContentRealTime)
                .rate_control_mode(RateControlMode::Bitrate)
                .bitrate(BitRate::from_bps(profile.target_bitrate_bps()))
                .max_frame_rate(FrameRate::from_hz(profile.frame_rate.fps() as f32))
                .intra_frame_period(IntraFramePeriod::from_num_frames(
                    profile
                        .frame_rate
                        .fps()
                        .saturating_mul(keyframe_seconds)
                        .max(1),
                ))
                .profile(if constrained {
                    Profile::Baseline
                } else {
                    Profile::High
                })
                .level(openh264_level_for_profile(profile))
                .complexity(complexity)
                .num_threads(0)
                .skip_frames(true)
                .adaptive_quantization(false)
                .background_detection(false)
                .vui(VuiConfig::bt709());
            let api = OpenH264API::from_source();
            let encoder = Encoder::with_api_config(api, config)
                .map_err(|err| format!("create OpenH264 encoder: {err}"))?;
            Ok(Self {
                encoder,
                width,
                height,
                frame_index: 0,
                y_plane: vec![0; width.saturating_mul(height)],
                u_plane: vec![0; width.saturating_mul(height) / 4],
                v_plane: vec![0; width.saturating_mul(height) / 4],
                source_layout: None,
                source_x_starts: Vec::new(),
                source_x_ends: Vec::new(),
                source_y_starts: Vec::new(),
                source_y_ends: Vec::new(),
                fit_width: width,
                fit_height: height,
                fit_offset_x: 0,
                fit_offset_y: 0,
            })
        }

        fn encode_bgra(
            &mut self,
            source_bgra: &[u8],
            source_width: usize,
            source_height: usize,
            source_stride: usize,
        ) -> Result<Vec<u8>, String> {
            self.convert_scaled_bgra_to_i420(
                source_bgra,
                source_width,
                source_height,
                source_stride,
            )?;
            let yuv = YUVSlices::new(
                (&self.y_plane, &self.u_plane, &self.v_plane),
                (self.width, self.height),
                (self.width, self.width / 2, self.width / 2),
            );
            let encoded = self
                .encoder
                .encode(&yuv)
                .map_err(|err| format!("encode OpenH264 frame: {err}"))?;
            self.frame_index = self.frame_index.saturating_add(1);
            Ok(encoded.to_vec())
        }

        fn force_keyframe(&mut self) {
            if self.frame_index > 0 {
                self.encoder.force_intra_frame();
            }
        }

        fn convert_scaled_bgra_to_i420(
            &mut self,
            source_bgra: &[u8],
            source_width: usize,
            source_height: usize,
            source_stride: usize,
        ) -> Result<(), String> {
            if source_width == 0 || source_height == 0 {
                return Err("captured frame has an empty size".to_string());
            }
            let min_stride = source_width
                .checked_mul(4)
                .ok_or_else(|| "captured frame row is too wide".to_string())?;
            if source_stride < min_stride {
                return Err("captured frame stride is smaller than its width".to_string());
            }
            let required_len = source_stride
                .checked_mul(source_height)
                .ok_or_else(|| "captured frame buffer is too large".to_string())?;
            if source_bgra.len() < required_len {
                return Err("captured frame buffer is truncated".to_string());
            }
            if source_width == self.width && source_height == self.height {
                return self.convert_unscaled_bgra_to_i420(source_bgra, source_stride);
            }
            let source_layout = (source_width, source_height, source_stride);
            if self.source_layout != Some(source_layout) {
                // Every source sample belongs to exactly one output sample, so a
                // downscale averages each group instead of dropping the samples it
                // skipped. Point sampling made text shimmer whenever the capture
                // size was not the encoded size, which is the default case on any
                // display that is not the chosen preset.
                //
                // The fit is scaled, not stretched: a captured window is rarely the
                // encoder's aspect ratio, and mapping the two axes independently
                // turned every resized window into a squashed picture.
                let (fit_width, fit_height, fit_offset_x, fit_offset_y) =
                    letterbox_rect(self.width, self.height, source_width, source_height);
                self.source_x_starts = axis_starts(fit_width, source_width);
                self.source_x_ends = axis_ends(fit_width, source_width);
                self.source_y_starts = axis_starts(fit_height, source_height);
                self.source_y_ends = axis_ends(fit_height, source_height);
                self.fit_width = fit_width;
                self.fit_height = fit_height;
                self.fit_offset_x = fit_offset_x;
                self.fit_offset_y = fit_offset_y;
                self.source_layout = Some(source_layout);
                if fit_width != self.width || fit_height != self.height {
                    // The bars are written once and never touched again, because
                    // only the fitted rectangle below writes into these planes.
                    self.y_plane.fill(16);
                    self.u_plane.fill(128);
                    self.v_plane.fill(128);
                }
            }

            let width = self.width;
            let half_width = width / 2;
            let fit_offset_x = self.fit_offset_x;
            let fit_offset_y = self.fit_offset_y;
            let fit_width = self.fit_width;
            let fit_height = self.fit_height;
            let source_x_starts = &self.source_x_starts;
            let source_x_ends = &self.source_x_ends;
            let source_y_starts = &self.source_y_starts;
            let source_y_ends = &self.source_y_ends;
            self.y_plane
                .par_chunks_exact_mut(width * 2)
                .zip(self.u_plane.par_chunks_exact_mut(half_width))
                .zip(self.v_plane.par_chunks_exact_mut(half_width))
                .enumerate()
                .for_each(|(row_pair_index, ((y_rows, u_row), v_row))| {
                    let target_y = row_pair_index * 2;
                    if target_y < fit_offset_y || target_y + 1 >= fit_offset_y + fit_height {
                        return;
                    }
                    let local_y = target_y - fit_offset_y;
                    let (y_row_0, y_row_1) = y_rows.split_at_mut(width);
                    let row_0 = (source_y_starts[local_y], source_y_ends[local_y]);
                    let row_1 = (source_y_starts[local_y + 1], source_y_ends[local_y + 1]);
                    for target_x in (fit_offset_x..fit_offset_x + fit_width).step_by(2) {
                        let local_x = target_x - fit_offset_x;
                        let column_0 = (source_x_starts[local_x], source_x_ends[local_x]);
                        let column_1 = (source_x_starts[local_x + 1], source_x_ends[local_x + 1]);
                        let pixel_0 =
                            average_bgra_block(source_bgra, source_stride, column_0, row_0);
                        let pixel_1 =
                            average_bgra_block(source_bgra, source_stride, column_1, row_0);
                        let pixel_2 =
                            average_bgra_block(source_bgra, source_stride, column_0, row_1);
                        let pixel_3 =
                            average_bgra_block(source_bgra, source_stride, column_1, row_1);
                        y_row_0[target_x] = rgb_to_y(pixel_0);
                        y_row_0[target_x + 1] = rgb_to_y(pixel_1);
                        y_row_1[target_x] = rgb_to_y(pixel_2);
                        y_row_1[target_x + 1] = rgb_to_y(pixel_3);

                        let average = (
                            (pixel_0.0 as u32
                                + pixel_1.0 as u32
                                + pixel_2.0 as u32
                                + pixel_3.0 as u32
                                + 2)
                                / 4,
                            (pixel_0.1 as u32
                                + pixel_1.1 as u32
                                + pixel_2.1 as u32
                                + pixel_3.1 as u32
                                + 2)
                                / 4,
                            (pixel_0.2 as u32
                                + pixel_1.2 as u32
                                + pixel_2.2 as u32
                                + pixel_3.2 as u32
                                + 2)
                                / 4,
                        );
                        let chroma_offset = target_x / 2;
                        u_row[chroma_offset] = rgb_to_u(average);
                        v_row[chroma_offset] = rgb_to_v(average);
                    }
                });
            Ok(())
        }

        fn convert_unscaled_bgra_to_i420(
            &mut self,
            source_bgra: &[u8],
            source_stride: usize,
        ) -> Result<(), String> {
            let width = u32::try_from(self.width)
                .map_err(|_| "screen share frame width exceeds the YUV converter limit")?;
            let height = u32::try_from(self.height)
                .map_err(|_| "screen share frame height exceeds the YUV converter limit")?;
            let bgra_stride = u32::try_from(source_stride)
                .map_err(|_| "screen share frame stride exceeds the YUV converter limit")?;
            let mut planar_image = YuvPlanarImageMut {
                y_plane: BufferStoreMut::Borrowed(&mut self.y_plane),
                y_stride: width,
                u_plane: BufferStoreMut::Borrowed(&mut self.u_plane),
                u_stride: width / 2,
                v_plane: BufferStoreMut::Borrowed(&mut self.v_plane),
                v_stride: width / 2,
                width,
                height,
            };
            bgra_to_yuv420(
                &mut planar_image,
                source_bgra,
                bgra_stride,
                YuvRange::Limited,
                YuvStandardMatrix::Bt709,
                YuvConversionMode::Balanced,
            )
            .map_err(|err| format!("convert BGRA screen frame to I420: {err}"))
        }
    }

    struct NativeEncodedVideoFrame {
        data: Vec<u8>,
        capture_time_ns: u64,
    }

    enum NativeScreenShareVideoEncoder {
        OpenH264 {
            encoder: Box<NativeH264Encoder>,
            profile: super::ScreenShareVideoProfile,
            content_mode: String,
            constrained: bool,
            fallback_reason: Option<String>,
            target_bitrate_bps: u32,
        },
        #[cfg(target_os = "windows")]
        MediaFoundation(Box<crate::windows_media_foundation_encoder::MediaFoundationH264Encoder>),
    }

    impl NativeScreenShareVideoEncoder {
        fn new(
            profile: &super::ScreenShareVideoProfile,
            content_mode: &str,
            constrained: bool,
        ) -> Result<Self, String> {
            if profile.frame_rate.fps() > 30 {
                #[cfg(target_os = "windows")]
                {
                    return crate::windows_media_foundation_encoder::MediaFoundationH264Encoder::new_with_content_mode(
                        profile, content_mode,
                        crate::windows_media_foundation_encoder::H264OutputProfile::for_compatibility(constrained),
                    )
                    .map(Box::new)
                    .map(Self::MediaFoundation);
                }
                #[cfg(not(target_os = "windows"))]
                {
                    return Err(
                        "screen sharing above 60 FPS requires a platform hardware encoder"
                            .to_string(),
                    );
                }
            }
            NativeH264Encoder::new_with_content_mode(profile, content_mode, constrained).map(
                |encoder| Self::OpenH264 {
                    encoder: Box::new(encoder),
                    profile: profile.clone(),
                    content_mode: content_mode.to_string(),
                    fallback_reason: None,
                    constrained,
                    target_bitrate_bps: profile.target_bitrate_bps(),
                },
            )
        }

        fn fallback_reason(&self) -> Option<&str> {
            match self {
                Self::OpenH264 {
                    fallback_reason, ..
                } => fallback_reason.as_deref(),
                #[cfg(target_os = "windows")]
                Self::MediaFoundation(mft) => mft.fallback_reason.as_deref(),
            }
        }

        fn note_fallback(&mut self, cause: String) {
            let reason = match self {
                Self::OpenH264 {
                    fallback_reason, ..
                } => fallback_reason,
                #[cfg(target_os = "windows")]
                Self::MediaFoundation(mft) => &mut mft.fallback_reason,
            };
            reason.get_or_insert(cause);
        }

        fn is_constrained_baseline(&self) -> bool {
            match self {
                Self::OpenH264 { constrained, .. } => *constrained,
                #[cfg(target_os = "windows")]
                Self::MediaFoundation(encoder) => encoder.is_constrained_baseline(),
            }
        }

        fn backend_name(&self) -> String {
            match self {
                Self::OpenH264 { .. } => "openh264-software".to_string(),
                #[cfg(target_os = "windows")]
                Self::MediaFoundation(encoder) => {
                    format!(
                        "media-foundation-hardware ({}, {})",
                        encoder.name(),
                        if encoder.uses_texture_input() {
                            if encoder.is_constrained_baseline() {
                                "D3D11/NV12/CBP"
                            } else {
                                "D3D11/NV12/High"
                            }
                        } else {
                            if encoder.is_constrained_baseline() {
                                "CPU/NV12/CBP"
                            } else {
                                "CPU/NV12/High"
                            }
                        }
                    )
                }
            }
        }

        fn force_keyframe(&mut self) {
            match self {
                Self::OpenH264 { encoder, .. } => encoder.force_keyframe(),
                #[cfg(target_os = "windows")]
                Self::MediaFoundation(encoder) => encoder.force_keyframe(),
            }
        }

        fn set_content_mode(&mut self, mode: &str) -> Result<(), String> {
            match self {
                Self::OpenH264 {
                    encoder,
                    profile,
                    constrained,
                    content_mode,
                    ..
                } => {
                    let mut next =
                        NativeH264Encoder::new_with_content_mode(profile, mode, *constrained)?;
                    next.force_keyframe();
                    *encoder = Box::new(next);
                    *content_mode = mode.into();
                    Ok(())
                }
                #[cfg(target_os = "windows")]
                Self::MediaFoundation(mft) => mft.set_content_mode(mode),
            }
        }
        fn target_bitrate_bps(&self) -> u32 {
            match self {
                Self::OpenH264 {
                    target_bitrate_bps, ..
                } => *target_bitrate_bps,
                #[cfg(target_os = "windows")]
                Self::MediaFoundation(encoder) => encoder.target_bitrate_bps(),
            }
        }

        fn set_target_bitrate_bps(&mut self, bitrate_bps: u32) -> Result<bool, String> {
            match self {
                Self::OpenH264 {
                    encoder,
                    profile,
                    content_mode,
                    constrained,
                    target_bitrate_bps,
                    ..
                } => {
                    if *target_bitrate_bps == bitrate_bps {
                        return Ok(false);
                    }
                    let next_profile = profile.clone().with_target_bitrate_bps(bitrate_bps);
                    let next_encoder = NativeH264Encoder::new_with_content_mode(
                        &next_profile,
                        content_mode,
                        *constrained,
                    )?;
                    *encoder = Box::new(next_encoder);
                    *profile = next_profile;
                    *target_bitrate_bps = bitrate_bps;
                    Ok(true)
                }
                #[cfg(target_os = "windows")]
                Self::MediaFoundation(encoder) => encoder.set_target_bitrate_bps(bitrate_bps),
            }
        }

        fn encode_bgra(
            &mut self,
            source_bgra: &[u8],
            source_width: usize,
            source_height: usize,
            source_stride: usize,
            capture_time_ns: u64,
        ) -> Result<Vec<NativeEncodedVideoFrame>, String> {
            match self {
                Self::OpenH264 { encoder, .. } => encoder
                    .encode_bgra(source_bgra, source_width, source_height, source_stride)
                    .map(|data| {
                        vec![NativeEncodedVideoFrame {
                            data,
                            capture_time_ns,
                        }]
                    }),
                #[cfg(target_os = "windows")]
                Self::MediaFoundation(encoder) => encoder
                    .encode_bgra(
                        source_bgra,
                        source_width,
                        source_height,
                        source_stride,
                        capture_time_ns,
                    )
                    .map(|frames| {
                        frames
                            .into_iter()
                            .map(|frame| NativeEncodedVideoFrame {
                                data: frame.data,
                                capture_time_ns: frame.capture_time_ns,
                            })
                            .collect()
                    }),
            }
        }
    }

    #[inline(always)]
    fn bgra_rgb(source: &[u8], offset: usize) -> (u8, u8, u8) {
        (source[offset + 2], source[offset + 1], source[offset])
    }

    #[inline(always)]
    fn rgb_to_y((red, green, blue): (u8, u8, u8)) -> u8 {
        (((47 * red as u32 + 157 * green as u32 + 16 * blue as u32 + 128) >> 8) + 16).clamp(16, 235)
            as u8
    }

    #[inline(always)]
    fn rgb_to_u((red, green, blue): (u32, u32, u32)) -> u8 {
        (((-26 * red as i32 - 87 * green as i32 + 113 * blue as i32 + 128) >> 8) + 128)
            .clamp(16, 240) as u8
    }

    #[inline(always)]
    fn rgb_to_v((red, green, blue): (u32, u32, u32)) -> u8 {
        (((112 * red as i32 - 102 * green as i32 - 10 * blue as i32 + 128) >> 8) + 128)
            .clamp(16, 240) as u8
    }

    /// First source sample covered by each output index.
    pub(crate) fn axis_starts(output: usize, source: usize) -> Vec<usize> {
        let output = output.max(1);
        (0..output)
            .map(|index| index.saturating_mul(source) / output)
            .collect()
    }

    /// One past the last source sample covered by each output index.
    ///
    /// Kept in step with `axis_starts` so every source sample is covered by
    /// exactly one output index. The `max(start + 1)` guard keeps an output index
    /// from covering nothing when the source is smaller than the output.
    pub(crate) fn axis_ends(output: usize, source: usize) -> Vec<usize> {
        let output = output.max(1);
        let source = source.max(1);
        (0..output)
            .map(|index| {
                let start = index.saturating_mul(source) / output;
                ((index + 1).saturating_mul(source) / output)
                    .max(start.saturating_add(1))
                    .min(source)
            })
            .collect()
    }

    /// Area average of one source rectangle.
    ///
    /// Averaging the whole rectangle is what keeps a downscale from aliasing:
    /// dropping the samples it does not need makes thin text shimmer, and the
    /// capture size is only equal to the encoded size when the user picked a
    /// preset that matches the display.
    pub(crate) fn average_bgra_block(
        source_bgra: &[u8],
        source_stride: usize,
        (x_start, x_end): (usize, usize),
        (y_start, y_end): (usize, usize),
    ) -> (u8, u8, u8) {
        let mut red = 0u32;
        let mut green = 0u32;
        let mut blue = 0u32;
        let mut samples = 0u32;
        for y in y_start..y_end {
            let row = y.saturating_mul(source_stride);
            for x in x_start..x_end {
                let (sample_red, sample_green, sample_blue) = bgra_rgb(source_bgra, row + x * 4);
                red = red.saturating_add(u32::from(sample_red));
                green = green.saturating_add(u32::from(sample_green));
                blue = blue.saturating_add(u32::from(sample_blue));
                samples = samples.saturating_add(1);
            }
        }
        if samples == 0 {
            return (0, 0, 0);
        }
        let half = samples / 2;
        (
            ((red + half) / samples) as u8,
            ((green + half) / samples) as u8,
            ((blue + half) / samples) as u8,
        )
    }

    /// Scale a source into an output box without changing its aspect ratio, and
    /// centre what is left over. Mapping both axes independently is what made a
    /// resized window arrive squashed on the viewer's screen: the capture size is
    /// whatever the window is, while the encoder keeps the preset size, so the
    /// two ratios only agree by accident. The result is written as black bars
    /// (Y=16, U=V=128) instead of a stretched picture.
    pub(crate) fn letterbox_rect(
        output_width: usize,
        output_height: usize,
        source_width: usize,
        source_height: usize,
    ) -> (usize, usize, usize, usize) {
        if output_width < 2 || output_height < 2 || source_width == 0 || source_height == 0 {
            return (output_width.max(2) & !1, output_height.max(2) & !1, 0, 0);
        }
        let scale_x = output_width as f64 / source_width as f64;
        let scale_y = output_height as f64 / source_height as f64;
        let scale = scale_x.min(scale_y);
        let fit_width =
            (((source_width as f64 * scale).round() as usize).clamp(2, output_width)) & !1;
        let fit_height =
            (((source_height as f64 * scale).round() as usize).clamp(2, output_height)) & !1;
        // Both offsets stay even so every 2x2 luma block lands on one chroma
        // sample: an odd offset would shear the colour planes by half a pixel.
        let offset_x = ((output_width - fit_width) / 2) & !1;
        let offset_y = ((output_height - fit_height) / 2) & !1;
        (fit_width.max(2), fit_height.max(2), offset_x, offset_y)
    }

    fn even_dimension(value: u32) -> u32 {
        value.saturating_sub(value % 2)
    }

    fn openh264_level_for_profile(profile: &super::ScreenShareVideoProfile) -> Level {
        match profile.required_h264_level_idc().unwrap_or(52) {
            31 => Level::Level_3_1,
            32 => Level::Level_3_2,
            40 => Level::Level_4_0,
            41 => Level::Level_4_1,
            42 => Level::Level_4_2,
            50 => Level::Level_5_0,
            51 => Level::Level_5_1,
            _ => Level::Level_5_2,
        }
    }

    #[cfg(target_os = "windows")]
    mod platform {
        use super::*;
        use windows::core::{factory, w, IInspectable, Interface};
        use windows::Foundation::{EventRegistrationToken, TimeSpan, TypedEventHandler};
        use windows::Graphics::Capture::{
            Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
            GraphicsCaptureSession,
        };
        use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
        use windows::Graphics::DirectX::DirectXPixelFormat;
        use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
        use windows::Win32::Graphics::Direct3D::{
            D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_11_1,
        };
        use windows::Win32::Graphics::Direct3D11::{
            D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
            D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
            D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
        };
        use windows::Win32::Graphics::Dxgi::IDXGIDevice;
        use windows::Win32::Graphics::Gdi::{
            CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
            EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, GetWindowDC, ReleaseDC,
            SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BI_RGB, CAPTUREBLT,
            COLORONCOLOR, DIB_RGB_COLORS, HBITMAP, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
            SRCCOPY,
        };
        use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
        use windows::Win32::System::Threading::{
            AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority,
            AVRT_PRIORITY_HIGH,
        };
        use windows::Win32::System::WinRT::Direct3D11::{
            CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
        };
        use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowRect, IsWindow, PW_RENDERFULLCONTENT,
        };

        const PREVIEW_INTERVAL_MS: i64 = 125;
        const PREVIEW_MAX_WIDTH: usize = 960;
        const PREVIEW_MAX_HEIGHT: usize = 540;
        const PREVIEW_JPEG_QUALITY: u8 = 82;
        const GDI_FALLBACK_START_MS: i64 = 1_000;

        fn set_capture_backend(status: &mut NativeScreenShareRuntimeStatus, backend: &str) {
            if status.backend.split(" + ").next() == Some(backend) {
                return;
            }
            status.backend = match status.backend.split_once(" + ") {
                Some((_, encoder_backend)) => format!("{backend} + {encoder_backend}"),
                None => backend.to_string(),
            };
        }

        struct MmcssCaptureTask(Option<windows::Win32::Foundation::HANDLE>);

        impl MmcssCaptureTask {
            fn enter() -> Self {
                let mut task_index = 0;
                let handle =
                    unsafe { AvSetMmThreadCharacteristicsW(w!("Capture"), &mut task_index) }.ok();
                if let Some(handle) = handle {
                    unsafe {
                        let _ = AvSetMmThreadPriority(handle, AVRT_PRIORITY_HIGH);
                    }
                    return Self(Some(handle));
                }
                Self(handle)
            }
        }

        impl Drop for MmcssCaptureTask {
            fn drop(&mut self) {
                if let Some(handle) = self.0.take() {
                    unsafe {
                        let _ = AvRevertMmThreadCharacteristics(handle);
                    }
                }
            }
        }

        struct CaptureApartment(std::marker::PhantomData<std::rc::Rc<()>>);

        impl CaptureApartment {
            fn enter() -> Result<Self, String> {
                unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
                    .map_err(|e| format!("start WGC apartment: {e}"))?;
                Ok(Self(std::marker::PhantomData))
            }
        }

        impl Drop for CaptureApartment {
            fn drop(&mut self) {
                unsafe {
                    windows::Win32::System::WinRT::RoUninitialize();
                }
            }
        }

        struct CaptureDevice {
            winrt_device: IDirect3DDevice,
            d3d_device: ID3D11Device,
            d3d_context: ID3D11DeviceContext,
        }

        #[derive(Clone)]
        struct CapturedBgraFrame {
            data: Arc<[u8]>,
            width: usize,
            height: usize,
            stride: usize,
        }

        #[derive(Clone)]
        enum CapturedFrame {
            Memory(CapturedBgraFrame),
            Texture(Arc<TextureFrame>),
        }

        struct TextureFrame {
            texture: Arc<ID3D11Texture2D>,
            width: u32,
            height: u32,
            reader: Arc<Mutex<D3D11FrameReader>>,
            memory: std::sync::OnceLock<Result<CapturedBgraFrame, String>>,
        }

        impl From<CapturedBgraFrame> for CapturedFrame {
            fn from(frame: CapturedBgraFrame) -> Self {
                Self::Memory(frame)
            }
        }

        impl CapturedFrame {
            fn size(&self) -> (usize, usize) {
                match self {
                    Self::Memory(f) => (f.width, f.height),
                    Self::Texture(f) => (f.width as usize, f.height as usize),
                }
            }

            fn memory(&self) -> Result<&CapturedBgraFrame, String> {
                match self {
                    Self::Memory(frame) => Ok(frame),
                    Self::Texture(f) => f
                        .memory
                        .get_or_init(|| {
                            f.reader
                                .lock()
                                .map_err(|_| "readback worker unavailable".to_owned())?
                                .read(&f.texture)
                        })
                        .as_ref()
                        .map_err(Clone::clone),
                }
            }

            fn encode(
                &self,
                encoder: &mut NativeScreenShareVideoEncoder,
                pts: u64,
                status: &Mutex<NativeScreenShareRuntimeStatus>,
                tier: ScreenShareLayer,
            ) -> Result<Vec<NativeEncodedVideoFrame>, String> {
                if let (Self::Texture(f), NativeScreenShareVideoEncoder::MediaFoundation(mft)) =
                    (self, &mut *encoder)
                {
                    if mft.uses_texture_input() {
                        match mft.encode_texture(&f.texture, f.width, f.height, pts) {
                            Ok(frames) => {
                                return Ok(frames
                                    .into_iter()
                                    .map(|f| NativeEncodedVideoFrame {
                                        data: f.data,
                                        capture_time_ns: f.capture_time_ns,
                                    })
                                    .collect())
                            }
                            Err(err) => {
                                mft.restore_memory_input(&err)?;
                                let backend = encoder.backend_name();
                                eprintln!(
                                    "EchoVoice {tier:?} screen encoder switched to {backend}"
                                );
                                if let Ok(mut status) = status.lock() {
                                    if tier == ScreenShareLayer::High {
                                        status.pipeline.encoder_fallback_reason =
                                            encoder.fallback_reason().map(str::to_owned);
                                        let capture = status
                                            .backend
                                            .split(" + ")
                                            .next()
                                            .unwrap_or("windows-graphics-capture");
                                        status.backend = format!("{capture} + {backend}");
                                    }
                                    status.last_error = Some(err);
                                }
                            }
                        }
                    }
                }
                let f = self.memory()?;
                encoder.encode_bgra(&f.data, f.width, f.height, f.stride, pts)
            }
        }

        #[derive(Clone)]
        struct CapturedFrameEnvelope {
            frame: CapturedFrame,
            capture_time_ns: u64,
            wall_clock_ms: i64,
        }

        struct LatestFrameSlotState<T> {
            pending: Option<T>,
            stopped: bool,
        }

        struct LatestFrameSlot<T> {
            state: Mutex<LatestFrameSlotState<T>>,
            ready: Condvar,
        }

        enum FrameSlotWait<T> {
            Frame(T),
            Timeout,
            Stopped,
        }

        impl<T> LatestFrameSlot<T> {
            fn new() -> Self {
                Self {
                    state: Mutex::new(LatestFrameSlotState {
                        pending: None,
                        stopped: false,
                    }),
                    ready: Condvar::new(),
                }
            }

            fn replace(&self, value: T) -> Result<bool, String> {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "native screen share frame slot is poisoned".to_string())?;
                if state.stopped {
                    return Ok(false);
                }
                let replaced = state.pending.replace(value).is_some();
                self.ready.notify_one();
                Ok(replaced)
            }

            fn wait(&self) -> Option<T> {
                let mut state = self.state.lock().ok()?;
                loop {
                    if let Some(value) = state.pending.take() {
                        return Some(value);
                    }
                    if state.stopped {
                        return None;
                    }
                    state = self.ready.wait(state).ok()?;
                }
            }

            /// Blocks for at most `timeout`, reporting whether a frame turned up.
            /// A keyframe somebody is still waiting for must be produced even
            /// when the screen is not changing, so the encoder cannot be driven
            /// exclusively by capture events.
            fn wait_timeout(&self, timeout: Duration) -> FrameSlotWait<T> {
                let Ok(mut state) = self.state.lock() else {
                    return FrameSlotWait::Stopped;
                };
                let deadline = Instant::now() + timeout;
                loop {
                    if let Some(value) = state.pending.take() {
                        return FrameSlotWait::Frame(value);
                    }
                    if state.stopped {
                        return FrameSlotWait::Stopped;
                    }
                    let now = Instant::now();
                    let Some(remaining) = deadline.checked_duration_since(now) else {
                        return FrameSlotWait::Timeout;
                    };
                    let Ok((guard, _)) = self.ready.wait_timeout(state, remaining) else {
                        return FrameSlotWait::Stopped;
                    };
                    state = guard;
                }
            }

            fn stop(&self) {
                if let Ok(mut state) = self.state.lock() {
                    state.stopped = true;
                    state.pending = None;
                    self.ready.notify_all();
                }
            }
        }

        struct FrameEncodingInput {
            frame_pump: Mutex<ScreenShareFramePump>,
            frame_slot: Arc<LatestFrameSlot<CapturedFrameEnvelope>>,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            capture_clock: CaptureClock,
            target_frame_rate: Arc<AtomicU32>,
        }

        struct CaptureClock {
            origin_ns: u64,
            frequency: u64,
        }

        impl CaptureClock {
            fn new() -> Result<Self, String> {
                use windows::Win32::System::Performance::QueryPerformanceFrequency;
                let mut frequency = 0;
                unsafe { QueryPerformanceFrequency(&mut frequency) }
                    .map_err(|e| format!("query capture clock frequency: {e}"))?;
                let frequency = frequency.max(1) as u64;
                Ok(Self {
                    origin_ns: Self::qpc_ns(frequency)?,
                    frequency,
                })
            }

            fn qpc_ns(frequency: u64) -> Result<u64, String> {
                use windows::Win32::System::Performance::QueryPerformanceCounter;
                let mut ticks = 0;
                unsafe { QueryPerformanceCounter(&mut ticks) }
                    .map_err(|e| format!("read capture clock: {e}"))?;
                Ok(
                    (u128::from(ticks.max(0) as u64) * 1_000_000_000 / u128::from(frequency))
                        as u64,
                )
            }

            fn now_ns(&self) -> Result<u64, String> {
                Ok(Self::qpc_ns(self.frequency)?.saturating_sub(self.origin_ns))
            }
        }

        impl FrameEncodingInput {
            fn submit(&self, frame: impl Into<CapturedFrame>, capture_time_ns: Option<u64>) {
                if let Err(error) = self.submit_with(capture_time_ns, || Ok(Some(frame.into()))) {
                    if let Ok(mut status) = self.status.lock() {
                        status.last_error = Some(error);
                    }
                }
            }

            fn submit_with(
                &self,
                capture_time_ns: Option<u64>,
                capture: impl FnOnce() -> Result<Option<CapturedFrame>, String>,
            ) -> Result<(), String> {
                let has_source_timestamp = capture_time_ns.is_some();
                let capture_time_ns = match capture_time_ns {
                    Some(timestamp) => timestamp,
                    None => self.capture_clock.now_ns()?,
                };
                let wall_clock_ms = now_ms();
                let desired_frame_rate = self.target_frame_rate.load(Ordering::Acquire).max(1);
                let decision = self.frame_pump.lock().map(|mut pump| {
                    // The user can retarget the cadence mid-share; the capture keeps
                    // running at the source rate and only the pump changes.
                    if pump.target_frame_rate().fps() != desired_frame_rate {
                        if let Ok(frame_rate) = ev_media::VideoFrameRate::new(desired_frame_rate) {
                            pump.set_target_frame_rate(frame_rate);
                        }
                    }
                    pump.observe_frame_ns(capture_time_ns)
                });
                let first_captured_frame = self
                    .status
                    .lock()
                    .map(|mut status| {
                        let first = status.captured_frames == 0;
                        status.captured_frames = status.captured_frames.saturating_add(1);
                        status.last_frame_at_ms = wall_clock_ms;
                        if !matches!(decision, Ok(FramePumpDecision::Forward)) {
                            status.dropped_frames = status.dropped_frames.saturating_add(1);
                            status.throttled_frames = status.throttled_frames.saturating_add(1);
                        }
                        first
                    })
                    .unwrap_or(false);
                if !matches!(decision, Ok(FramePumpDecision::Forward)) {
                    return Ok(());
                }
                // Make the frame-rate decision while the WGC surface is still borrowed,
                // before a GPU copy, readback, scale or color conversion.
                let Some(frame) = capture()? else {
                    if let Ok(mut status) = self.status.lock() {
                        status.dropped_frames = status.dropped_frames.saturating_add(1);
                    }
                    return Ok(());
                };
                if let Ok(mut status) = self.status.lock() {
                    if matches!(frame, CapturedFrame::Texture(_)) {
                        status.pipeline.texture_copies += 1;
                        if let Some(age) = has_source_timestamp
                            .then(|| self.capture_clock.now_ns().ok())
                            .flatten()
                            .and_then(|now| now.checked_sub(capture_time_ns))
                        {
                            status.pipeline.capture_age_samples += 1;
                            status.pipeline.capture_age_micros = status
                                .pipeline
                                .capture_age_micros
                                .saturating_add(age / 1000);
                        }
                    }
                    status.forwarded_frames = status.forwarded_frames.saturating_add(1);
                }
                if first_captured_frame {
                    let backend = self
                        .status
                        .lock()
                        .map(|status| status.backend.clone())
                        .unwrap_or_else(|_| "unknown".to_string());
                    eprintln!(
                        "EchoVoice native screen share first frame captured backend={} size={}x{}",
                        backend,
                        frame.size().0,
                        frame.size().1
                    );
                }

                let envelope = CapturedFrameEnvelope {
                    frame,
                    capture_time_ns,
                    wall_clock_ms,
                };
                match self.frame_slot.replace(envelope) {
                    Ok(true) => {
                        if let Ok(mut status) = self.status.lock() {
                            status.dropped_frames = status.dropped_frames.saturating_add(1);
                            status.encoder_backpressure_drops =
                                status.encoder_backpressure_drops.saturating_add(1);
                        }
                    }
                    Ok(false) => {}
                    Err(err) => {
                        if let Ok(mut status) = self.status.lock() {
                            status.last_error = Some(err);
                        }
                    }
                }
                Ok(())
            }
        }

        struct FrameEncodingPipeline {
            input: Arc<FrameEncodingInput>,
            preview_slot: Arc<LatestFrameSlot<CapturedFrameEnvelope>>,
            encoder_worker: Option<thread::JoinHandle<()>>,
            preview_worker: Option<thread::JoinHandle<()>>,
        }

        impl FrameEncodingPipeline {
            fn start(
                profile: &super::super::ScreenShareVideoProfile,
                content_mode: &str,
                status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
                keyframe_requested: Arc<AtomicBool>,
                media_sender: Arc<NativeWebRtcSender>,
            ) -> Result<Self, String> {
                Self::start_with_device(
                    profile,
                    content_mode,
                    status,
                    keyframe_requested,
                    media_sender,
                    None,
                )
            }

            fn start_with_device(
                profile: &super::super::ScreenShareVideoProfile,
                content_mode: &str,
                status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
                keyframe_requested: Arc<AtomicBool>,
                media_sender: Arc<NativeWebRtcSender>,
                device: Option<ID3D11Device>,
            ) -> Result<Self, String> {
                let frame_slot = Arc::new(LatestFrameSlot::new());
                let preview_slot = Arc::new(LatestFrameSlot::new());
                let input = Arc::new(FrameEncodingInput {
                    frame_pump: Mutex::new(ScreenShareFramePump::new(profile.frame_rate)),
                    frame_slot: Arc::clone(&frame_slot),
                    status: Arc::clone(&status),
                    capture_clock: CaptureClock::new()?,
                    target_frame_rate: media_sender.target_frame_rate(),
                });

                let encoder_status = Arc::clone(&status);
                let encoder_preview_slot = Arc::clone(&preview_slot);
                let encoder_profile = profile
                    .clone()
                    .with_target_bitrate_bps(media_sender.effective_bitrate_bps());
                let encoder_content_mode = content_mode.to_string();
                let (encoder_start_tx, encoder_start_rx) = mpsc::sync_channel(1);
                let encoder_worker = thread::Builder::new()
                    .name("ev-screen-share-encoder".to_string())
                    .spawn(move || {
                        let primary = create_video_encoder(&encoder_profile,&encoder_content_mode,device.as_ref(),false)
                            .or_else(|high_error| {
                                let mut cbp=create_video_encoder(&encoder_profile,&encoder_content_mode,device.as_ref(),true)
                                    .map_err(|cbp_error|format!("H.264 High unavailable: {high_error}; constrained Baseline unavailable: {cbp_error}"))?;
                                eprintln!("EchoVoice H.264 High unavailable, same-size constrained Baseline active: {high_error}");
                                cbp.note_fallback(high_error);
                                Ok::<_,String>(cbp)
                            });
                        let encoder=match primary {
                            Ok(encoder) => encoder,
                            Err(err) => {
                                let _ = encoder_start_tx.send(Err(err));
                                encoder_preview_slot.stop();
                                return;
                            }
                        };
                        if let Ok(mut status) = encoder_status.lock() {
                            status.pipeline.encoder_fallback_reason=encoder.fallback_reason().map(str::to_owned);
                            status.backend =
                                format!("{} + {}", status.backend, encoder.backend_name());
                        }
                        if encoder_start_tx.send(Ok(())).is_err() {
                            encoder_preview_slot.stop();
                            return;
                        }
                        run_encoding_worker(
                            frame_slot,
                            encoder_preview_slot,
                            encoder_status,
                            keyframe_requested,
                            media_sender,
                            encoder,
                            encoder_profile,
                            encoder_content_mode,
                        )
                    })
                    .map_err(|err| format!("start native screen share encoder: {err}"))?;
                match encoder_start_rx.recv_timeout(Duration::from_secs(10)) {
                    Ok(Ok(())) => {}
                    Ok(Err(err)) => {
                        input.frame_slot.stop();
                        let _ = encoder_worker.join();
                        return Err(err);
                    }
                    Err(err) => {
                        input.frame_slot.stop();
                        let _ = encoder_worker.join();
                        return Err(format!("initialize native screen share encoder: {err}"));
                    }
                }

                let preview_status = Arc::clone(&status);
                let preview_slot_for_worker = Arc::clone(&preview_slot);
                let preview_worker = match thread::Builder::new()
                    .name("ev-screen-share-preview".to_string())
                    .spawn(move || run_preview_worker(preview_slot_for_worker, preview_status))
                {
                    Ok(worker) => worker,
                    Err(err) => {
                        input.frame_slot.stop();
                        let _ = encoder_worker.join();
                        return Err(format!("start native screen share preview: {err}"));
                    }
                };

                Ok(Self {
                    input,
                    preview_slot,
                    encoder_worker: Some(encoder_worker),
                    preview_worker: Some(preview_worker),
                })
            }

            fn input(&self) -> Arc<FrameEncodingInput> {
                Arc::clone(&self.input)
            }

            fn stop(&mut self) {
                self.input.frame_slot.stop();
                self.preview_slot.stop();
                if let Some(worker) = self.encoder_worker.take() {
                    let _ = worker.join();
                }
                if let Some(worker) = self.preview_worker.take() {
                    let _ = worker.join();
                }
            }
        }

        impl Drop for FrameEncodingPipeline {
            fn drop(&mut self) {
                self.stop();
            }
        }

        /// Whether a pending keyframe request may be turned into an intra frame
        /// now. A request that arrives inside the throttle window stays pending,
        /// so a viewer that is genuinely stuck still gets a fresh keyframe as
        /// soon as the window closes instead of losing its request.
        fn create_video_encoder(
            profile: &super::super::ScreenShareVideoProfile,
            mode: &str,
            device: Option<&ID3D11Device>,
            constrained: bool,
        ) -> Result<NativeScreenShareVideoEncoder, String> {
            use crate::windows_media_foundation_encoder::{
                H264OutputProfile, MediaFoundationH264Encoder,
            };
            let output_profile = H264OutputProfile::for_compatibility(constrained);
            // High resolution at 30 fps benefits from GPU conversion and encode
            // too. Software remains available for lower-cadence memory inputs.
            let large = profile.output_size.width() as u64 * profile.output_size.height() as u64
                >= 2560 * 1440;
            if let Some(device) = device.filter(|_| profile.frame_rate.fps() > 30 || large) {
                let attempt = MediaFoundationH264Encoder::new_with_device(
                    profile,
                    mode,
                    device,
                    output_profile,
                );
                match attempt {
                    Ok(mft) => {
                        return Ok(NativeScreenShareVideoEncoder::MediaFoundation(Box::new(
                            mft,
                        )))
                    }
                    Err(cause) => {
                        match MediaFoundationH264Encoder::new_with_content_mode(profile,mode,output_profile) {
                            Ok(mut mft)=>{
                                mft.note_texture_fallback(&cause);
                                return Ok(NativeScreenShareVideoEncoder::MediaFoundation(Box::new(mft)));
                            }
                            Err(memory_error) if profile.frame_rate.fps()>30 => return Err(format!("hardware H.264 texture input: {cause}; memory input: {memory_error}")),
                            Err(memory_error) => {
                                let mut software=NativeScreenShareVideoEncoder::new(profile,mode,constrained)?;
                                software.note_fallback(format!("D3D11: {cause}; hardware memory input: {memory_error}"));
                                return Ok(software);
                            }
                        }
                    }
                }
            }
            NativeScreenShareVideoEncoder::new(profile, mode, constrained)
        }

        fn keyframe_throttle_allows(
            last_forced_at: Option<Instant>,
            now: Instant,
            minimum_interval: Duration,
        ) -> bool {
            last_forced_at.map_or(true, |last| {
                now.saturating_duration_since(last) >= minimum_interval
            })
        }

        /// Pushes the controller's working rate into the encoder. Shared by the
        /// capture path and the idle keyframe path.
        fn retarget_encoder_bitrate(
            media_sender: &NativeWebRtcSender,
            status: &Mutex<NativeScreenShareRuntimeStatus>,
            encoder: &mut NativeScreenShareVideoEncoder,
        ) {
            let requested_bitrate_bps = media_sender.effective_bitrate_bps();
            let applied_bitrate_bps = encoder.target_bitrate_bps();
            if requested_bitrate_bps == applied_bitrate_bps {
                return;
            }
            match encoder.set_target_bitrate_bps(requested_bitrate_bps) {
                Ok(_) => {
                    if let Ok(mut status) = status.lock() {
                        status.effective_bitrate_bps = requested_bitrate_bps;
                    }
                }
                Err(err) => {
                    media_sender.retain_effective_bitrate(applied_bitrate_bps);
                    if let Ok(mut status) = status.lock() {
                        status.last_error = Some(err);
                    }
                }
            }
        }

        /// The reduced encode a weak viewer is subscribed to: the published size
        /// capped at 720p, never upscaled, and never more bitrate than the tier
        /// allows. Resolution is only dropped as far as 720p, because screen
        /// sharing is read before it is watched: a 540p encode costs a whole
        /// stroke width where a lower bitrate only softens motion.
        fn low_tier_video_profile(
            profile: &super::super::ScreenShareVideoProfile,
            target_bitrate_bps: u32,
        ) -> super::super::ScreenShareVideoProfile {
            let published = profile.output_size;
            let (width, height, _, _) = letterbox_rect(
                published
                    .width()
                    .min(NATIVE_SCREEN_SHARE_LOW_TIER_MAX_WIDTH) as usize,
                published
                    .height()
                    .min(NATIVE_SCREEN_SHARE_LOW_TIER_MAX_HEIGHT) as usize,
                published.width() as usize,
                published.height() as usize,
            );
            let size = ::ev_media::VideoSize::new(width as u32, height as u32).unwrap_or(published);
            super::super::ScreenShareVideoProfile::new(
                profile.source_kind,
                size,
                profile.frame_rate,
            )
            .with_target_bitrate_bps(target_bitrate_bps)
        }

        struct SubscribedEncoder {
            layer: ScreenShareLayer,
            profile: super::super::ScreenShareVideoProfile,
            encoder: Option<NativeScreenShareVideoEncoder>,
            failed: bool,
        }

        fn encode_and_deliver(
            encoder: &mut NativeScreenShareVideoEncoder,
            extra: &mut [SubscribedEncoder],
            content_mode: &str,
            media_sender: &NativeWebRtcSender,
            status: &Mutex<NativeScreenShareRuntimeStatus>,
            envelope: &CapturedFrameEnvelope,
        ) {
            let encode_started = Instant::now();
            let encode_result = envelope.frame.encode(
                encoder,
                envelope.capture_time_ns,
                status,
                ScreenShareLayer::High,
            );
            let elapsed = encode_started.elapsed();
            let encode_elapsed_ms = elapsed.as_millis();
            let (samples, residence) = match encoder {
                NativeScreenShareVideoEncoder::MediaFoundation(mft) => mft.take_output_timing(),
                _ => (0, 0),
            };
            if let Ok(mut status) = status.lock() {
                status.pipeline.high_encode_calls += 1;
                status.pipeline.high_encode_call_micros = status
                    .pipeline
                    .high_encode_call_micros
                    .saturating_add(elapsed.as_micros() as u64);
                status.pipeline.hardware_outputs += samples;
                status.pipeline.hardware_residence_micros = status
                    .pipeline
                    .hardware_residence_micros
                    .saturating_add(residence);
            }
            match encode_result {
                Ok(encoded_frames) if !encoded_frames.is_empty() => {
                    let first_encoded_frame = status
                        .lock()
                        .map(|status| status.encoded_frames == 0)
                        .unwrap_or(false);
                    let mut byte_len = 0_usize;
                    let mut frame_count = 0_u64;
                    for encoded in encoded_frames {
                        if encoded.data.is_empty() {
                            continue;
                        }
                        byte_len = byte_len.saturating_add(encoded.data.len());
                        frame_count = frame_count.saturating_add(1);
                        media_sender.write_h264_sample(
                            ScreenShareLayer::High,
                            encoded.data,
                            encoded.capture_time_ns,
                        );
                    }
                    if let Ok(mut status) = status.lock() {
                        status.phase = "sending".to_string();
                        status.pipeline.encoded_bytes += byte_len as u64;
                        status.encoded_frames = status.encoded_frames.saturating_add(frame_count);
                        status.last_error = None;
                    }
                    if first_encoded_frame && frame_count > 0 {
                        eprintln!(
                            "EchoVoice native screen share first frame encoded bytes={} elapsed={}ms",
                            byte_len, encode_elapsed_ms
                        );
                    }
                }
                Ok(_) => {}
                Err(err) => {
                    if let Ok(mut status) = status.lock() {
                        status.phase = "running".to_string();
                        status.last_error = Some(err);
                    }
                }
            }

            for tier in extra {
                let target = match tier.layer {
                    ScreenShareLayer::Low => media_sender.low_tier_target_bitrate_bps(),
                    ScreenShareLayer::Compatibility => {
                        media_sender.compatibility_target_bitrate_bps()
                    }
                    ScreenShareLayer::High => unreachable!(),
                };
                let Some(bitrate) = target else {
                    tier.encoder = None;
                    tier.failed = false;
                    continue;
                };
                if tier.failed {
                    continue;
                }
                if tier.encoder.is_none() {
                    let device = match &envelope.frame {
                        CapturedFrame::Texture(f) => unsafe { f.texture.GetDevice() }.ok(),
                        _ => None,
                    };
                    let profile = tier.profile.clone().with_target_bitrate_bps(bitrate);
                    match create_video_encoder(
                        &profile,
                        content_mode,
                        device.as_ref(),
                        tier.layer == ScreenShareLayer::Compatibility
                            || encoder.is_constrained_baseline(),
                    ) {
                        Ok(encoder) => tier.encoder = Some(encoder),
                        Err(err) => {
                            tier.failed = true;
                            if let Ok(mut status) = status.lock() {
                                status.last_error =
                                    Some(format!("start {:?} encoder: {err}", tier.layer));
                            }
                            continue;
                        }
                    }
                }
                let encoder = tier.encoder.as_mut().unwrap();
                if let Err(err) = encoder.set_target_bitrate_bps(bitrate) {
                    if let Ok(mut status) = status.lock() {
                        status.last_error =
                            Some(format!("retarget {:?} encoder: {err}", tier.layer));
                    }
                }
                match envelope
                    .frame
                    .encode(encoder, envelope.capture_time_ns, status, tier.layer)
                {
                    Ok(frames) => {
                        for frame in frames {
                            media_sender.write_h264_sample(
                                tier.layer,
                                frame.data,
                                frame.capture_time_ns,
                            );
                        }
                    }
                    Err(err) => {
                        if let Ok(mut status) = status.lock() {
                            status.last_error =
                                Some(format!("encode {:?} sample: {err}", tier.layer));
                        }
                    }
                }
            }
        }

        // Async MFT output can arrive after ProcessInput returns. Deliver that
        // output even when the screen stops changing after a single update.
        fn drain_encoder_output(
            encoder: &mut NativeScreenShareVideoEncoder,
            tier: ScreenShareLayer,
            media_sender: &NativeWebRtcSender,
            status: &Mutex<NativeScreenShareRuntimeStatus>,
        ) -> bool {
            let NativeScreenShareVideoEncoder::MediaFoundation(mft) = encoder else {
                return false;
            };
            if !mft.has_pending_output() {
                return false;
            }
            match mft.poll_output() {
                Ok(frames) => {
                    let count = frames.len() as u64;
                    let bytes = frames
                        .iter()
                        .map(|frame| frame.data.len() as u64)
                        .sum::<u64>();
                    for frame in frames {
                        media_sender.write_h264_sample(tier, frame.data, frame.capture_time_ns);
                    }
                    if tier == ScreenShareLayer::High && count > 0 {
                        if let Ok(mut status) = status.lock() {
                            status.pipeline.encoded_bytes += bytes;
                            let (samples, residence) = mft.take_output_timing();
                            status.pipeline.hardware_outputs += samples;
                            status.pipeline.hardware_residence_micros = status
                                .pipeline
                                .hardware_residence_micros
                                .saturating_add(residence);
                            status.encoded_frames = status.encoded_frames.saturating_add(count);
                            status.phase = "sending".into();
                        }
                    }
                }
                Err(err) => {
                    if let Ok(mut status) = status.lock() {
                        status.last_error = Some(err);
                    }
                }
            }
            mft.has_pending_output()
        }

        fn run_encoding_worker(
            frame_slot: Arc<LatestFrameSlot<CapturedFrameEnvelope>>,
            preview_slot: Arc<LatestFrameSlot<CapturedFrameEnvelope>>,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            keyframe_requested: Arc<AtomicBool>,
            media_sender: Arc<NativeWebRtcSender>,
            mut encoder: NativeScreenShareVideoEncoder,
            encoder_profile: super::super::ScreenShareVideoProfile,
            content_mode: String,
        ) {
            let _mmcss_capture_task = MmcssCaptureTask::enter();
            let mut extra = [
                SubscribedEncoder {
                    layer: ScreenShareLayer::Low,
                    profile: low_tier_video_profile(
                        &encoder_profile,
                        NATIVE_SCREEN_SHARE_LOW_TIER_MAX_BPS,
                    ),
                    encoder: None,
                    failed: false,
                },
                SubscribedEncoder {
                    layer: ScreenShareLayer::Compatibility,
                    profile: encoder_profile.clone(),
                    encoder: None,
                    failed: false,
                },
            ];
            let mut last_preview_scheduled_ms = 0;
            let mut last_forced_keyframe_at: Option<Instant> = None;
            let mut last_envelope: Option<CapturedFrameEnvelope> = None;
            let mut last_real_frame_at = Instant::now();
            use crate::native_screen_content::{ContentCounters, SmartScreenContent};
            let mut smart =
                (content_mode == "smart").then(|| SmartScreenContent::new(Instant::now()));
            let mut effective_mode = if smart.is_some() {
                "balanced"
            } else {
                content_mode.as_str()
            };
            if let Ok(mut status) = status.lock() {
                status.pipeline.effective_content_mode = Some(effective_mode.into());
                status.pipeline.smart_reason = smart.as_ref().map(|_| "observing".into());
            }
            loop {
                let now = Instant::now();
                if let Some(controller) = smart.as_mut().filter(|controller| controller.due(now)) {
                    let decision = status.lock().ok().and_then(|s| {
                        let p = &s.pipeline;
                        controller.observe(
                            now,
                            ContentCounters {
                                source_updates: s.captured_frames + p.wgc_frames_replaced,
                                encode_calls: p.high_encode_calls,
                                encode_micros: p.high_encode_call_micros,
                                encode_bytes: p.encoded_bytes,
                                backpressure_drops: s.encoder_backpressure_drops,
                            },
                            encoder_profile.frame_rate.fps(),
                            encoder.target_bitrate_bps(),
                        )
                    });
                    if let Some((mode, reason)) = decision {
                        match encoder.set_content_mode(mode) {
                            Ok(()) => {
                                effective_mode = mode;
                                for tier in &mut extra {
                                    if let Some(secondary) = tier.encoder.as_mut() {
                                        if let Err(err) = secondary.set_content_mode(mode) {
                                            eprintln!("EchoVoice {:?} encoder retained content setting: {err}",tier.layer);
                                        }
                                    }
                                }
                                if let Ok(mut status) = status.lock() {
                                    status.pipeline.effective_content_mode = Some(mode.into());
                                    status.pipeline.smart_reason = Some(reason.into());
                                }
                            }
                            Err(err) => {
                                eprintln!("EchoVoice encoder retained {effective_mode} content mode: {err}");
                                if let Ok(mut status) = status.lock() {
                                    status.pipeline.smart_reason =
                                        Some("encoder-unsupported".into());
                                }
                                smart = None;
                            }
                        }
                    }
                }

                let high_pending = drain_encoder_output(
                    &mut encoder,
                    ScreenShareLayer::High,
                    &media_sender,
                    &status,
                );
                let mut extra_pending = false;
                for tier in &mut extra {
                    if let Some(encoder) = tier.encoder.as_mut() {
                        extra_pending |=
                            drain_encoder_output(encoder, tier.layer, &media_sender, &status);
                    }
                }
                let wait = if (high_pending || extra_pending)
                    && last_real_frame_at.elapsed() < Duration::from_millis(100)
                {
                    Duration::from_millis(3)
                } else {
                    SCREEN_SHARE_IDLE_KEYFRAME_INTERVAL
                };
                let envelope = match frame_slot.wait_timeout(wait) {
                    FrameSlotWait::Frame(envelope) => envelope,
                    FrameSlotWait::Timeout => {
                        // A viewer that lost the reference frame asks for a
                        // keyframe, but a still desktop never produces another
                        // capture frame, so nothing would ever answer it: the
                        // picture stays frozen (0 fps) while the audio keeps
                        // playing. Re-encoding the frame already in hand is
                        // exact for static content.
                        let Some(previous) = last_envelope.as_ref() else {
                            continue;
                        };
                        if !keyframe_requested.load(Ordering::SeqCst) {
                            continue;
                        }
                        let now = Instant::now();
                        if !keyframe_throttle_allows(
                            last_forced_keyframe_at,
                            now,
                            NATIVE_SCREEN_SHARE_MIN_KEYFRAME_INTERVAL,
                        ) {
                            continue;
                        }
                        keyframe_requested.store(false, Ordering::SeqCst);
                        encoder.force_keyframe();
                        for encoder in extra.iter_mut().filter_map(|tier| tier.encoder.as_mut()) {
                            encoder.force_keyframe();
                        }
                        last_forced_keyframe_at = Some(now);
                        media_sender.probe_bitrate_upward();
                        retarget_encoder_bitrate(&media_sender, &status, &mut encoder);
                        let mut refreshed = previous.clone();
                        refreshed.capture_time_ns = previous.capture_time_ns.saturating_add(
                            now.saturating_duration_since(last_real_frame_at).as_nanos() as u64,
                        );
                        encode_and_deliver(
                            &mut encoder,
                            &mut extra,
                            effective_mode,
                            &media_sender,
                            &status,
                            &refreshed,
                        );
                        continue;
                    }
                    FrameSlotWait::Stopped => break,
                };
                last_real_frame_at = Instant::now();
                let resumed_after_gap = last_envelope.as_ref().is_some_and(|previous| {
                    envelope
                        .capture_time_ns
                        .saturating_sub(previous.capture_time_ns)
                        > SCREEN_SHARE_CAPTURE_GAP_NS
                });
                if resumed_after_gap {
                    keyframe_requested.store(true, Ordering::SeqCst);
                }
                let preview_enabled = status
                    .lock()
                    .map(|status| status.preview_enabled)
                    .unwrap_or(false);
                if preview_enabled
                    && envelope
                        .wall_clock_ms
                        .saturating_sub(last_preview_scheduled_ms)
                        >= PREVIEW_INTERVAL_MS
                {
                    let _ = preview_slot.replace(CapturedFrameEnvelope {
                        frame: envelope.frame.clone(),
                        capture_time_ns: envelope.capture_time_ns,
                        wall_clock_ms: envelope.wall_clock_ms,
                    });
                    last_preview_scheduled_ms = envelope.wall_clock_ms;
                } else if !preview_enabled {
                    last_preview_scheduled_ms = 0;
                }

                media_sender.probe_bitrate_upward();
                retarget_encoder_bitrate(&media_sender, &status, &mut encoder);
                if resumed_after_gap {
                    // The estimate the path returned while nothing was being sent
                    // describes the gap, not the path. Resume at the rate this
                    // share already proved, and only then let the encoder see it.
                    media_sender.resume_after_capture_gap();
                    retarget_encoder_bitrate(&media_sender, &status, &mut encoder);
                }
                let now = Instant::now();
                if keyframe_requested.load(Ordering::SeqCst)
                    && keyframe_throttle_allows(
                        last_forced_keyframe_at,
                        now,
                        NATIVE_SCREEN_SHARE_MIN_KEYFRAME_INTERVAL,
                    )
                {
                    keyframe_requested.store(false, Ordering::SeqCst);
                    encoder.force_keyframe();
                    // A viewer is moved to the reduced tier by clearing its queue
                    // and waiting for a keyframe. Forcing only the high tier left
                    // that viewer waiting for the low encoder's next natural intra
                    // frame, which on screen content can be seconds away: the
                    // picture looked correct for about a second and then froze.
                    for encoder in extra.iter_mut().filter_map(|tier| tier.encoder.as_mut()) {
                        encoder.force_keyframe();
                    }
                    last_forced_keyframe_at = Some(now);
                }
                encode_and_deliver(
                    &mut encoder,
                    &mut extra,
                    effective_mode,
                    &media_sender,
                    &status,
                    &envelope,
                );
                last_envelope = Some(envelope);
            }
            preview_slot.stop();
        }

        fn run_preview_worker(
            preview_slot: Arc<LatestFrameSlot<CapturedFrameEnvelope>>,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
        ) {
            let mut last_preview_rgb: Option<Vec<u8>> = None;
            while let Some(envelope) = preview_slot.wait() {
                let preview_enabled = status
                    .lock()
                    .map(|status| status.preview_enabled)
                    .unwrap_or(false);
                if !preview_enabled {
                    last_preview_rgb = None;
                    continue;
                }
                // A shared document or slide does not change between frames.
                // Skip the JPEG and the IPC round trip when the downscaled
                // pixels are identical: the element already shows that image,
                // and re-sending it burns the CPU the encoder needs.
                let Ok((rgb, width, height)) = envelope.frame.memory().and_then(scaled_preview_rgb)
                else {
                    continue;
                };
                if last_preview_rgb.as_deref() == Some(rgb.as_slice()) {
                    continue;
                }
                let Ok(preview_data_url) = encode_preview_data_url(&rgb, width, height) else {
                    continue;
                };
                last_preview_rgb = Some(rgb);
                if let Ok(mut status) = status.lock() {
                    if !status.preview_enabled {
                        continue;
                    }
                    status.preview_data_url = Some(preview_data_url);
                    status.preview_updated_at_ms = envelope.wall_clock_ms;
                }
            }
        }

        // The encoder and preview can retain the same image. The capture frame is
        // released immediately after a device-local copy into a free owned texture.
        // A static image therefore survives the lifetime of its WGC pool slot.
        struct CaptureTexturePool {
            device: ID3D11Device,
            context: ID3D11DeviceContext,
            textures: Vec<Arc<ID3D11Texture2D>>,
            desc: Option<D3D11_TEXTURE2D_DESC>,
            reader: Arc<Mutex<D3D11FrameReader>>,
        }

        impl CaptureTexturePool {
            fn take_frame(
                &mut self,
                frame: &Direct3D11CaptureFrame,
            ) -> Result<Option<CapturedFrame>, String> {
                let surface = frame.Surface().map_err(|e| e.to_string())?;
                let access: IDirect3DDxgiInterfaceAccess =
                    surface.cast().map_err(|e| e.to_string())?;
                let texture: ID3D11Texture2D =
                    unsafe { access.GetInterface() }.map_err(|e| e.to_string())?;
                let size = frame.ContentSize().map_err(|e| e.to_string())?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                unsafe { texture.GetDesc(&mut desc) };
                let width = (size.Width.max(0) as u32).min(desc.Width);
                let height = (size.Height.max(0) as u32).min(desc.Height);
                if width == 0 || height == 0 {
                    return Ok(None);
                }
                desc.Width = width;
                desc.Height = height;
                desc.BindFlags =
                    windows::Win32::Graphics::Direct3D11::D3D11_BIND_RENDER_TARGET.0 as u32;
                desc.MiscFlags = 0;
                if self.desc != Some(desc) {
                    self.textures.clear();
                    self.desc = Some(desc);
                }
                let free = self.textures.iter().find(|t| Arc::strong_count(t) == 1);
                let owned = if let Some(free) = free {
                    Arc::clone(free)
                } else {
                    // Current encode, previous frame, preview pending and preview in flight.
                    if self.textures.len() >= 6 {
                        return Ok(None);
                    }
                    let mut resource = None;
                    unsafe {
                        self.device
                            .CreateTexture2D(&desc, None, Some(&mut resource))
                    }
                    .map_err(|e| format!("allocate capture texture: {e}"))?;
                    let resource = Arc::new(resource.ok_or("no capture texture returned")?);
                    self.textures.push(resource.clone());
                    resource
                };
                let region = windows::Win32::Graphics::Direct3D11::D3D11_BOX {
                    left: 0,
                    top: 0,
                    front: 0,
                    right: width,
                    bottom: height,
                    back: 1,
                };
                unsafe {
                    self.context.CopySubresourceRegion(
                        &*owned,
                        0,
                        0,
                        0,
                        0,
                        &texture,
                        0,
                        Some(&region),
                    )
                };
                Ok(Some(CapturedFrame::Texture(Arc::new(TextureFrame {
                    texture: owned,
                    width,
                    height,
                    reader: self.reader.clone(),
                    memory: std::sync::OnceLock::new(),
                }))))
            }
        }

        struct D3D11FrameReader {
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            device: ID3D11Device,
            context: ID3D11DeviceContext,
            staging: Option<(D3D11_TEXTURE2D_DESC, ID3D11Texture2D)>,
        }

        impl D3D11FrameReader {
            fn read(&mut self, texture: &ID3D11Texture2D) -> Result<CapturedBgraFrame, String> {
                let started = Instant::now();
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                unsafe { texture.GetDesc(&mut desc) };
                desc.Usage = D3D11_USAGE_STAGING;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                desc.BindFlags = 0;
                desc.MiscFlags = 0;
                if self
                    .staging
                    .as_ref()
                    .is_none_or(|(existing, _)| *existing != desc)
                {
                    let mut staging = None;
                    unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut staging)) }
                        .map_err(|e| format!("create staging texture: {e}"))?;
                    self.staging = Some((desc, staging.ok_or("no staging texture returned")?));
                }
                let staging = &self.staging.as_ref().unwrap().1;
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                unsafe {
                    self.context.CopyResource(staging, texture);
                }
                let mut submitted = false;
                loop {
                    // A blocking Map holds ID3D11Multithread's implicit context lock.
                    // Release it while the preview copy is in flight so the encoder
                    // thread can submit the next video-processor blit.
                    match unsafe {
                        self.context.Map(
                            staging,
                            0,
                            D3D11_MAP_READ,
                            windows::Win32::Graphics::Direct3D11::D3D11_MAP_FLAG_DO_NOT_WAIT.0
                                as u32,
                            Some(&mut mapped),
                        )
                    } {
                        Ok(()) => break,
                        Err(err)
                            if err.code()
                                == windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING =>
                        {
                            if !submitted {
                                unsafe {
                                    self.context.Flush();
                                }
                                submitted = true;
                            }
                            if started.elapsed() >= Duration::from_millis(150) {
                                return Err("D3D11 readback missed its deadline".into());
                            }
                            thread::sleep(Duration::from_millis(1));
                        }
                        Err(err) => return Err(format!("map captured frame: {err}")),
                    }
                }
                let result = copy_mapped_bgra_frame(&mapped, desc.Width, desc.Height);
                unsafe { self.context.Unmap(staging, 0) };
                if result.is_ok() {
                    if let Ok(mut status) = self.status.lock() {
                        status.pipeline.readback_frames += 1;
                        status.pipeline.readback_micros = status
                            .pipeline
                            .readback_micros
                            .saturating_add(started.elapsed().as_micros() as u64);
                    }
                }
                result
            }
        }

        pub struct CaptureRuntime {
            _inner: Box<dyn CaptureRuntimeGuard>,
        }

        trait CaptureRuntimeGuard {}

        struct WindowsCaptureRuntime {
            item: GraphicsCaptureItem,
            frame_pool: Direct3D11CaptureFramePool,
            session: GraphicsCaptureSession,
            fallback_worker: Option<thread::JoinHandle<()>>,
            source_watchdog: Option<thread::JoinHandle<()>>,
            readback_worker: Option<thread::JoinHandle<()>>,
            readback_slot: Arc<LatestFrameSlot<Direct3D11CaptureFrame>>,
            encoding_pipeline: FrameEncodingPipeline,
            stop_flag: Arc<AtomicBool>,
            frame_arrived_token: EventRegistrationToken,
            closed_token: Option<EventRegistrationToken>,
            _frame_handler: TypedEventHandler<Direct3D11CaptureFramePool, IInspectable>,
            _closed_handler: TypedEventHandler<GraphicsCaptureItem, IInspectable>,
            _device: CaptureDevice,
            _apartment: CaptureApartment,
        }

        impl CaptureRuntimeGuard for WindowsCaptureRuntime {}

        impl Drop for WindowsCaptureRuntime {
            fn drop(&mut self) {
                self.stop_flag.store(true, Ordering::SeqCst);
                let _ = self.frame_pool.RemoveFrameArrived(self.frame_arrived_token);
                if let Some(worker) = self.source_watchdog.take() {
                    let _ = worker.join();
                }
                if let Some(worker) = self.fallback_worker.take() {
                    let _ = worker.join();
                }
                self.readback_slot.stop();
                if let Some(worker) = self.readback_worker.take() {
                    let _ = worker.join();
                }
                if let Some(token) = self.closed_token {
                    let _ = self.item.RemoveClosed(token);
                }
                let _ = self.session.Close();
                let _ = self.frame_pool.Close();
                self.encoding_pipeline.stop();
            }
        }

        #[cfg(test)]
        struct SyntheticCaptureRuntime {
            worker: Option<thread::JoinHandle<()>>,
            encoding_pipeline: FrameEncodingPipeline,
            stop_flag: Arc<AtomicBool>,
        }

        #[cfg(test)]
        impl CaptureRuntimeGuard for SyntheticCaptureRuntime {}

        #[cfg(test)]
        impl Drop for SyntheticCaptureRuntime {
            fn drop(&mut self) {
                self.stop_flag.store(true, Ordering::SeqCst);
                if let Some(worker) = self.worker.take() {
                    let _ = worker.join();
                }
                self.encoding_pipeline.stop();
            }
        }

        pub fn run_capture(
            request: &NativeScreenShareStartRequest,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            stop_flag: Arc<AtomicBool>,
            media_sender: Arc<NativeWebRtcSender>,
            keyframe_requested: Arc<AtomicBool>,
        ) -> Result<CaptureRuntime, String> {
            media_sender.capture_started.store(true, Ordering::Release);
            #[cfg(test)]
            {
                if is_synthetic_source(request) {
                    return run_synthetic_capture(
                        request,
                        status,
                        stop_flag,
                        media_sender,
                        keyframe_requested,
                    )
                    .map(|runtime| CaptureRuntime {
                        _inner: Box::new(runtime),
                    });
                }
            }
            run_windows_capture(request, status, stop_flag, media_sender, keyframe_requested).map(
                |runtime| CaptureRuntime {
                    _inner: Box::new(runtime),
                },
            )
        }

        fn run_windows_capture(
            request: &NativeScreenShareStartRequest,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            stop_flag: Arc<AtomicBool>,
            media_sender: Arc<NativeWebRtcSender>,
            keyframe_requested: Arc<AtomicBool>,
        ) -> Result<WindowsCaptureRuntime, String> {
            let profile = native_screen_share_video_profile(request)?;
            let apartment = CaptureApartment::enter()?;
            let item = capture_item_for_source(&request.source_id)?;
            let source_size = item
                .Size()
                .map_err(|err| format!("read capture item size: {err}"))?;
            if source_size.Width <= 0 || source_size.Height <= 0 {
                return Err(format!(
                    "capture source has an empty size: {}x{}",
                    source_size.Width, source_size.Height
                ));
            }

            let device = create_direct3d_device()?;
            let frame_pool_buffer_count = if profile.frame_rate.fps() > 60 { 3 } else { 2 };
            let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                &device.winrt_device,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                frame_pool_buffer_count,
                source_size,
            )
            .map_err(|err| format!("create WGC frame pool: {err}"))?;
            let encoding_pipeline = FrameEncodingPipeline::start_with_device(
                &profile,
                &request.content_mode,
                Arc::clone(&status),
                keyframe_requested,
                media_sender,
                Some(device.d3d_device.clone()),
            )?;
            let encoding_input = encoding_pipeline.input();
            let frame_reader = CaptureTexturePool {
                device: device.d3d_device.clone(),
                context: device.d3d_context.clone(),
                textures: Vec::new(),
                desc: None,
                reader: Arc::new(Mutex::new(D3D11FrameReader {
                    status: Arc::clone(&status),
                    device: device.d3d_device.clone(),
                    context: device.d3d_context.clone(),
                    staging: None,
                })),
            };
            let readback_slot = Arc::new(LatestFrameSlot::new());
            let wgc_last_frame_at_ms = Arc::new(AtomicI64::new(0));
            let readback_slot_for_handler = Arc::clone(&readback_slot);
            let capture_status_for_handler = status.clone();
            let frame_handler = TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(
                move |sender, _| {
                    if let Some(pool) = sender.as_ref() {
                        drain_frames(
                            pool,
                            &readback_slot_for_handler,
                            &capture_status_for_handler,
                        );
                    }
                    Ok(())
                },
            );
            let frame_arrived_token = frame_pool
                .FrameArrived(&frame_handler)
                .map_err(|err| format!("register WGC frame callback: {err}"))?;

            let closed_status = Arc::clone(&status);
            let closed_stop = Arc::clone(&stop_flag);
            let closed_handler =
                TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| {
                    if let Ok(mut status) = closed_status.lock() {
                        status.phase = "failed".to_string();
                        status.last_error = Some(CAPTURE_SOURCE_CLOSED_ERROR.to_string());
                    }
                    // Closing the shared window ends the source: no more frames can
                    // ever arrive, so the capture threads have to stop instead of
                    // sitting on a dead item while the share claims to be running.
                    closed_stop.store(true, Ordering::SeqCst);
                    Ok(())
                });
            let closed_token = item.Closed(&closed_handler).ok();

            let session = frame_pool
                .CreateCaptureSession(&item)
                .map_err(|err| format!("create WGC capture session: {err}"))?;
            let _ = session.SetIsCursorCaptureEnabled(request.capture_cursor);
            let _ = session.SetIsBorderRequired(false);
            let capture_interval = TimeSpan {
                // Leave 20% headroom for composition/vsync quantization. The pump
                // enforces the chosen send rate before we copy a WGC texture.
                Duration: (8_000_000_i64 / profile.frame_rate.fps().max(1) as i64).max(1),
            };
            if let Err(err) = session.SetMinUpdateInterval(capture_interval) {
                eprintln!(
                    "EchoVoice WGC minimum update interval is unavailable for {} FPS: {err}",
                    profile.frame_rate.fps()
                );
            }
            session
                .StartCapture()
                .map_err(|err| format!("start WGC capture: {err}"))?;

            capture_gdi_bootstrap_frame(
                &request.source_id,
                Arc::clone(&status),
                Arc::clone(&encoding_input),
            );

            let frame_pool_size = Arc::new(Mutex::new((source_size.Width, source_size.Height)));
            let fallback_worker = spawn_frame_poll_fallback(
                request.source_id.clone(),
                item.clone(),
                frame_pool.clone(),
                device.d3d_device.clone(),
                frame_pool_buffer_count,
                Arc::clone(&frame_pool_size),
                Arc::clone(&status),
                Arc::clone(&readback_slot),
                Arc::clone(&encoding_input),
                Arc::clone(&stop_flag),
                profile.frame_rate.fps(),
                Arc::clone(&wgc_last_frame_at_ms),
            )?;

            let readback_worker = match spawn_wgc_texture_worker(
                Arc::clone(&readback_slot),
                frame_reader,
                Arc::clone(&status),
                encoding_input,
                wgc_last_frame_at_ms,
            ) {
                Ok(worker) => worker,
                Err(err) => {
                    stop_flag.store(true, Ordering::SeqCst);
                    let _ = frame_pool.RemoveFrameArrived(frame_arrived_token);
                    let _ = fallback_worker.join();
                    readback_slot.stop();
                    let _ = session.Close();
                    let _ = frame_pool.Close();
                    return Err(err);
                }
            };

            let source_watchdog = spawn_capture_source_watchdog(
                request.source_id.clone(),
                Arc::clone(&status),
                Arc::clone(&stop_flag),
                Arc::clone(&readback_slot),
            );

            Ok(WindowsCaptureRuntime {
                item,
                frame_pool,
                session,
                fallback_worker: Some(fallback_worker),
                source_watchdog,
                readback_worker: Some(readback_worker),
                readback_slot,
                encoding_pipeline,
                stop_flag,
                frame_arrived_token,
                closed_token,
                _frame_handler: frame_handler,
                _closed_handler: closed_handler,
                _device: device,
                _apartment: apartment,
            })
        }

        #[cfg(test)]
        fn is_synthetic_source(request: &NativeScreenShareStartRequest) -> bool {
            request.source_kind == "synthetic" || request.source_id.starts_with("synthetic:")
        }

        #[cfg(test)]
        fn run_synthetic_capture(
            request: &NativeScreenShareStartRequest,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            stop_flag: Arc<AtomicBool>,
            media_sender: Arc<NativeWebRtcSender>,
            keyframe_requested: Arc<AtomicBool>,
        ) -> Result<SyntheticCaptureRuntime, String> {
            let profile = native_screen_share_video_profile(request)?;
            let width = profile.output_size.width() as usize;
            let height = profile.output_size.height() as usize;
            let frame_interval =
                Duration::from_nanos(1_000_000_000_u64 / profile.frame_rate.fps().max(1) as u64);
            if let Ok(mut status) = status.lock() {
                set_capture_backend(&mut status, "synthetic-diagnostic-source");
            }
            let encoding_pipeline = FrameEncodingPipeline::start(
                &profile,
                &request.content_mode,
                Arc::clone(&status),
                keyframe_requested,
                media_sender,
            )?;
            let encoding_input = encoding_pipeline.input();
            if let Ok(mut status) = status.lock() {
                status.phase = "running".to_string();
                status.last_error = None;
            }
            encoding_input.submit(synthetic_bgra_frame(width, height, 0), Some(0));
            let worker_status = Arc::clone(&status);
            let worker_stop = Arc::clone(&stop_flag);
            let worker = thread::Builder::new()
                .name("ev-screen-share-synthetic".to_string())
                .spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let mut frame_index = 1_u64;
                        let started = Instant::now();
                        let mut next_frame_at = started + frame_interval;
                        while !worker_stop.load(Ordering::SeqCst) {
                            let now = Instant::now();
                            if now < next_frame_at {
                                thread::sleep(next_frame_at - now);
                            }
                            let frame = synthetic_bgra_frame(width, height, frame_index);
                            let capture_time_ns =
                                started.elapsed().as_nanos().min(u64::MAX as u128) as u64;
                            encoding_input.submit(frame, Some(capture_time_ns));
                            frame_index = frame_index.saturating_add(1);
                            next_frame_at += frame_interval;
                            let now = Instant::now();
                            if next_frame_at + frame_interval < now {
                                next_frame_at = now + frame_interval;
                            }
                        }
                    }));
                    if result.is_err() {
                        if let Ok(mut status) = worker_status.lock() {
                            status.phase = "failed".to_string();
                            status.last_error =
                                Some("synthetic screen share worker panicked".to_string());
                        }
                    }
                })
                .map_err(|err| format!("start synthetic screen share source: {err}"))?;
            Ok(SyntheticCaptureRuntime {
                worker: Some(worker),
                encoding_pipeline,
                stop_flag,
            })
        }

        #[cfg(test)]
        fn synthetic_bgra_frame(
            width: usize,
            height: usize,
            frame_index: u64,
        ) -> CapturedBgraFrame {
            let stride = width.saturating_mul(4);
            let mut data = vec![0; stride.saturating_mul(height)];
            let colors: [[u8; 3]; 8] = [
                [92, 188, 255],
                [112, 255, 178],
                [255, 228, 96],
                [255, 128, 128],
                [198, 154, 255],
                [255, 255, 255],
                [72, 84, 96],
                [18, 24, 32],
            ];
            let shift = (frame_index as usize).saturating_mul(9);
            let band_width = (width / colors.len().max(1)).max(1);
            for y in 0..height {
                for x in 0..width {
                    let band = ((x + shift) / band_width) % colors.len();
                    let mut rgb = colors[band];
                    if ((x + y + shift) / 32) % 2 == 0 {
                        rgb[0] = rgb[0].saturating_sub(28);
                        rgb[1] = rgb[1].saturating_sub(28);
                        rgb[2] = rgb[2].saturating_sub(28);
                    }
                    if x % 160 == 0 || y % 90 == 0 {
                        rgb = [160, 210, 255];
                    }
                    let square_size = (height / 8).clamp(28, 120);
                    let max_square_x = width.saturating_sub(square_size).max(1);
                    let square_x = (frame_index as usize).saturating_mul(13) % max_square_x;
                    let square_y = height.saturating_mul(3) / 5;
                    if x >= square_x
                        && x < square_x.saturating_add(square_size)
                        && y >= square_y
                        && y < square_y.saturating_add(square_size)
                    {
                        rgb = [170, 235, 255];
                    }
                    let offset = y * stride + x * 4;
                    data[offset] = rgb[2];
                    data[offset + 1] = rgb[1];
                    data[offset + 2] = rgb[0];
                    data[offset + 3] = 255;
                }
            }
            CapturedBgraFrame {
                data: Arc::from(data),
                width,
                height,
                stride,
            }
        }

        #[allow(clippy::too_many_arguments)]
        /// WGC delivers frames at the size the frame pool was created with, so a
        /// window the user resizes keeps being captured at its old size (the
        /// content is cropped or letterboxed) until the pool is recreated for the
        /// new source size. The encoder's output size is a fixed preset and the
        /// scaler re-reads the source size every frame, so only the pool has to
        /// follow the window.
        fn recreate_frame_pool_for_source_size(
            item: &GraphicsCaptureItem,
            frame_pool: &Direct3D11CaptureFramePool,
            device: &IDirect3DDevice,
            frame_pool_buffer_count: i32,
            frame_pool_size: &Mutex<(i32, i32)>,
        ) {
            let Ok(size) = item.Size() else {
                return;
            };
            if size.Width <= 0 || size.Height <= 0 {
                return;
            }
            let resized = match frame_pool_size.lock() {
                Ok(current) => current.0 != size.Width || current.1 != size.Height,
                Err(_) => return,
            };
            if !resized {
                return;
            }
            if frame_pool
                .Recreate(
                    device,
                    DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    frame_pool_buffer_count,
                    size,
                )
                .is_err()
            {
                return;
            }
            if let Ok(mut current) = frame_pool_size.lock() {
                *current = (size.Width, size.Height);
            }
        }

        /// The window handle encoded in a `window:<hex>` source id, when the
        /// share is capturing a window rather than a monitor.
        fn capture_source_window_handle(source_id: &str) -> Option<usize> {
            let raw = source_id.strip_prefix("window:")?;
            usize::from_str_radix(raw, 16)
                .ok()
                .filter(|handle| *handle != 0)
        }

        /// A closed capture window has to end the share on its own.
        ///
        /// `GraphicsCaptureItem::Closed` is the documented signal, but it is
        /// delivered by the compositor and does not arrive when the window is
        /// destroyed abruptly, so the share kept publishing a frozen frame while
        /// the sharer believed it was still live. Polling the handle is cheap and
        /// does not depend on any event: once the window is gone nothing can ever
        /// produce another frame.
        fn spawn_capture_source_watchdog(
            source_id: String,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            stop_flag: Arc<AtomicBool>,
            readback_slot: Arc<LatestFrameSlot<Direct3D11CaptureFrame>>,
        ) -> Option<thread::JoinHandle<()>> {
            let handle = capture_source_window_handle(&source_id)?;
            thread::Builder::new()
                .name("ev-screen-share-source-watch".to_string())
                .spawn(move || {
                    let window = HWND(handle as *mut core::ffi::c_void);
                    loop {
                        if stop_flag.load(Ordering::SeqCst) {
                            return;
                        }
                        if !unsafe { IsWindow(window) }.as_bool() {
                            if let Ok(mut status) = status.lock() {
                                status.phase = "failed".to_string();
                                status.last_error = Some(CAPTURE_SOURCE_CLOSED_ERROR.to_string());
                            }
                            stop_flag.store(true, Ordering::SeqCst);
                            readback_slot.stop();
                            return;
                        }
                        thread::sleep(Duration::from_millis(400));
                    }
                })
                .ok()
        }

        fn spawn_frame_poll_fallback(
            source_id: String,
            item: GraphicsCaptureItem,
            frame_pool: Direct3D11CaptureFramePool,
            d3d_device: ID3D11Device,
            frame_pool_buffer_count: i32,
            frame_pool_size: Arc<Mutex<(i32, i32)>>,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            readback_slot: Arc<LatestFrameSlot<Direct3D11CaptureFrame>>,
            encoding_input: Arc<FrameEncodingInput>,
            stop_flag: Arc<AtomicBool>,
            frame_rate: u32,
            wgc_last_frame_at_ms: Arc<AtomicI64>,
        ) -> Result<thread::JoinHandle<()>, String> {
            thread::Builder::new()
                .name("ev-wgc-frame-poll".to_string())
                .spawn(move || {
                    let _apartment = match CaptureApartment::enter() {
                        Ok(guard) => guard,
                        Err(error) => {
                            if let Ok(mut status) = status.lock() {
                                status.last_error = Some(error);
                            }
                            return;
                        }
                    };
                    use windows::Win32::Graphics::Dxgi::{
                        IDXGIAdapter3, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
                        DXGI_QUERY_VIDEO_MEMORY_INFO,
                    };
                    let budget_adapter = d3d_device
                        .cast::<IDXGIDevice>()
                        .and_then(|d| unsafe { d.GetAdapter() })
                        .and_then(|a| a.cast::<IDXGIAdapter3>())
                        .ok();
                    let mut next_budget_sample = Instant::now();
                    let resized_device = d3d_device
                        .cast::<IDXGIDevice>()
                        .map_err(|err| format!("cast D3D11 device to DXGI device: {err}"))
                        .and_then(|dxgi_device| winrt_direct3d_device(&dxgi_device))
                        .ok();
                    let frame_interval =
                        Duration::from_nanos(1_000_000_000_u64 / frame_rate.max(1) as u64);
                    let mut next_frame_at = Instant::now();
                    while !stop_flag.load(Ordering::SeqCst) {
                        if Instant::now() >= next_budget_sample {
                            next_budget_sample = Instant::now() + Duration::from_secs(2);
                            let budget = budget_adapter.as_ref().and_then(|adapter| {
                                let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
                                unsafe {
                                    adapter.QueryVideoMemoryInfo(
                                        0,
                                        DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
                                        &mut info,
                                    )
                                }
                                .ok()?;
                                Some(info)
                            });
                            if let Ok(mut status) = status.lock() {
                                status.pipeline.gpu_process_usage_bytes =
                                    budget.map(|info| info.CurrentUsage);
                                status.pipeline.gpu_local_budget_bytes =
                                    budget.map(|info| info.Budget);
                            }
                        }
                        if let Some(resized_device) = resized_device.as_ref() {
                            recreate_frame_pool_for_source_size(
                                &item,
                                &frame_pool,
                                resized_device,
                                frame_pool_buffer_count,
                                &frame_pool_size,
                            );
                        }
                        let last_wgc = wgc_last_frame_at_ms.load(Ordering::SeqCst);
                        // FrameArrived owns the normal dequeue. Poll only when callbacks
                        // have been silent to avoid racing two consumers for a frame.
                        if last_wgc == 0 || now_ms().saturating_sub(last_wgc) >= 100 {
                            drain_frames(&frame_pool, &readback_slot, &status);
                        }
                        if should_use_gdi_fallback(&status, &wgc_last_frame_at_ms) {
                            if let Ok(mut status) = status.lock() {
                                set_capture_backend(&mut status, "windows-gdi-fallback");
                            }
                            match capture_gdi_source_frame(&source_id) {
                                Ok(frame) => {
                                    if let Ok(mut status) = status.lock() {
                                        set_capture_backend(&mut status, "windows-gdi-fallback");
                                    }
                                    encoding_input.submit(frame, None);
                                }
                                Err(err) => {
                                    if let Ok(mut status) = status.lock() {
                                        status.last_error = Some(format!(
                                            "WGC produced no frames; GDI fallback failed: {err}"
                                        ));
                                    }
                                }
                            }
                        }
                        // Once WGC is delivering, this worker checks for resizes and
                        // missed notifications. It need not wake at the publish FPS.
                        next_frame_at += if wgc_last_frame_at_ms.load(Ordering::SeqCst) > 0 {
                            Duration::from_millis(100)
                        } else {
                            frame_interval
                        };
                        let now = Instant::now();
                        if next_frame_at > now {
                            thread::sleep(next_frame_at - now);
                        } else {
                            next_frame_at = now;
                        }
                    }
                })
                .map_err(|err| format!("start WGC frame poll fallback: {err}"))
        }

        fn spawn_wgc_texture_worker(
            readback_slot: Arc<LatestFrameSlot<Direct3D11CaptureFrame>>,
            mut frame_reader: CaptureTexturePool,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            encoding_input: Arc<FrameEncodingInput>,
            wgc_last_frame_at_ms: Arc<AtomicI64>,
        ) -> Result<thread::JoinHandle<()>, String> {
            thread::Builder::new()
                .name("ev-wgc-texture".to_string())
                .spawn(move || {
                    let _apartment = match CaptureApartment::enter() {
                        Ok(guard) => guard,
                        Err(error) => {
                            if let Ok(mut status) = status.lock() {
                                status.last_error = Some(error);
                            }
                            return;
                        }
                    };
                    let _mmcss_capture_task = MmcssCaptureTask::enter();
                    while let Some(frame) = readback_slot.wait() {
                        let capture_time_ns =
                            frame.SystemRelativeTime().ok().and_then(|timestamp| {
                                u64::try_from(timestamp.Duration).ok().map(|ticks| {
                                    ticks
                                        .saturating_mul(100)
                                        .saturating_sub(encoding_input.capture_clock.origin_ns)
                                })
                            });
                        wgc_last_frame_at_ms.store(now_ms(), Ordering::SeqCst);
                        let submitted = encoding_input
                            .submit_with(capture_time_ns, || frame_reader.take_frame(&frame));
                        let _ = frame.Close();
                        if let Ok(mut status) = status.lock() {
                            match submitted {
                                Ok(()) => {
                                    set_capture_backend(&mut status, "windows-graphics-capture")
                                }
                                Err(error) => {
                                    wgc_last_frame_at_ms.store(0, Ordering::SeqCst);
                                    status.last_error = Some(error);
                                }
                            }
                        }
                    }
                })
                .map_err(|err| format!("start WGC texture worker: {err}"))
        }

        fn capture_gdi_bootstrap_frame(
            source_id: &str,
            status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            encoding_input: Arc<FrameEncodingInput>,
        ) {
            match capture_gdi_source_frame(source_id) {
                Ok(frame) => {
                    if let Ok(mut status) = status.lock() {
                        if status.captured_frames == 0 {
                            set_capture_backend(&mut status, "windows-gdi-bootstrap");
                        }
                    }
                    encoding_input.submit(frame, None);
                }
                Err(err) => {
                    if let Ok(mut status) = status.lock() {
                        status.last_error = Some(format!("GDI bootstrap frame failed: {err}"));
                    }
                }
            }
        }

        fn should_use_gdi_fallback(
            status: &Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            wgc_last_frame_at_ms: &AtomicI64,
        ) -> bool {
            let now = now_ms();
            let last_wgc_frame_at_ms = wgc_last_frame_at_ms.load(Ordering::SeqCst);
            status
                .lock()
                .map(|status| {
                    let startup_elapsed =
                        now.saturating_sub(status.started_at_ms) >= GDI_FALLBACK_START_MS;
                    // WGC is event-driven: an unchanged desktop may produce no frames
                    // for minutes. Only bootstrap with GDI until the first WGC image.
                    let wgc_stale = last_wgc_frame_at_ms <= 0;
                    status.phase != "failed" && startup_elapsed && wgc_stale
                })
                .unwrap_or(false)
        }

        fn drain_frames(
            frame_pool: &Direct3D11CaptureFramePool,
            readback_slot: &Arc<LatestFrameSlot<Direct3D11CaptureFrame>>,
            status: &Mutex<NativeScreenShareRuntimeStatus>,
        ) {
            let mut received = 0u64;
            let mut latest_frame = None;
            while let Ok(frame) = frame_pool.TryGetNextFrame() {
                received += 1;
                if let Some(previous) = latest_frame.replace(frame) {
                    let _ = previous.Close();
                }
            }
            let Some(frame) = latest_frame else {
                return;
            };
            let previous = match readback_slot.state.lock() {
                Ok(mut state) if !state.stopped => {
                    let previous = state.pending.replace(frame);
                    readback_slot.ready.notify_one();
                    previous
                }
                _ => {
                    let _ = frame.Close();
                    return;
                }
            };
            if let Ok(mut status) = status.lock() {
                status.pipeline.wgc_frames_received += received;
                status.pipeline.wgc_frames_replaced += received - 1 + u64::from(previous.is_some());
            }
            if let Some(previous) = previous {
                let _ = previous.Close();
            }
        }

        fn capture_gdi_source_frame(source_id: &str) -> Result<CapturedBgraFrame, String> {
            if let Some(raw_index) = source_id.strip_prefix("screen:") {
                let index = raw_index
                    .parse::<usize>()
                    .map_err(|_| "invalid screen source id".to_string())?;
                let rect = monitor_rect_by_index(index)
                    .ok_or_else(|| "screen source is no longer available".to_string())?;
                return capture_gdi_screen_frame(rect);
            }
            if let Some(raw_hwnd) = source_id.strip_prefix("window:") {
                let hwnd_value = usize::from_str_radix(raw_hwnd, 16)
                    .map_err(|_| "invalid window source id".to_string())?;
                let hwnd = HWND(hwnd_value as *mut core::ffi::c_void);
                return capture_gdi_window_frame(hwnd);
            }
            Err("unsupported GDI capture source id".to_string())
        }

        fn capture_gdi_screen_frame(rect: RECT) -> Result<CapturedBgraFrame, String> {
            let screen_dc = unsafe { GetDC(HWND(std::ptr::null_mut())) };
            if screen_dc.is_invalid() {
                return Err("open screen DC for GDI fallback".to_string());
            }
            let result = capture_dc_bgra_frame(
                screen_dc,
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
            );
            unsafe {
                ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
            }
            result
        }

        fn capture_gdi_window_frame(hwnd: HWND) -> Result<CapturedBgraFrame, String> {
            let mut rect = RECT::default();
            unsafe {
                GetWindowRect(hwnd, &mut rect)
                    .map_err(|err| format!("read window rect for GDI fallback: {err}"))?;
            }
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            if width <= 0 || height <= 0 {
                return Err("window source has an empty size".to_string());
            }
            capture_gdi_window_print_frame(hwnd, width, height).or_else(|_| {
                let window_dc = unsafe { GetWindowDC(hwnd) };
                if window_dc.is_invalid() {
                    return Err("open window DC for GDI fallback".to_string());
                }
                let result = capture_dc_bgra_frame(window_dc, 0, 0, width, height);
                unsafe {
                    ReleaseDC(hwnd, window_dc);
                }
                result
            })
        }

        fn capture_gdi_window_print_frame(
            hwnd: HWND,
            width: i32,
            height: i32,
        ) -> Result<CapturedBgraFrame, String> {
            let window_dc = unsafe { GetWindowDC(hwnd) };
            if window_dc.is_invalid() {
                return Err("open window DC for PrintWindow fallback".to_string());
            }
            let source_dc = unsafe { CreateCompatibleDC(window_dc) };
            if source_dc.is_invalid() {
                unsafe {
                    ReleaseDC(hwnd, window_dc);
                }
                return Err("create PrintWindow memory DC".to_string());
            }
            let source_bitmap = unsafe { CreateCompatibleBitmap(window_dc, width, height) };
            if source_bitmap.is_invalid() {
                unsafe {
                    let _ = DeleteDC(source_dc);
                    ReleaseDC(hwnd, window_dc);
                }
                return Err("create PrintWindow bitmap".to_string());
            }
            let old_object = unsafe { SelectObject(source_dc, source_bitmap) };
            let printed = unsafe {
                PrintWindow(hwnd, source_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool()
                    || PrintWindow(hwnd, source_dc, PRINT_WINDOW_FLAGS(0)).as_bool()
            };
            let result = if printed {
                bitmap_to_bgra_frame(source_dc, source_bitmap, width, height)
            } else {
                Err("PrintWindow returned no frame".to_string())
            };
            unsafe {
                if !old_object.is_invalid() {
                    SelectObject(source_dc, old_object);
                }
                let _ = DeleteObject(source_bitmap);
                let _ = DeleteDC(source_dc);
                ReleaseDC(hwnd, window_dc);
            }
            result
        }

        fn capture_dc_bgra_frame(
            src_dc: HDC,
            src_x: i32,
            src_y: i32,
            src_width: i32,
            src_height: i32,
        ) -> Result<CapturedBgraFrame, String> {
            if src_width <= 0 || src_height <= 0 {
                return Err("GDI fallback source has an empty size".to_string());
            }
            let memory_dc = unsafe { CreateCompatibleDC(src_dc) };
            if memory_dc.is_invalid() {
                return Err("create GDI fallback memory DC".to_string());
            }
            let bitmap = unsafe { CreateCompatibleBitmap(src_dc, src_width, src_height) };
            if bitmap.is_invalid() {
                unsafe {
                    let _ = DeleteDC(memory_dc);
                }
                return Err("create GDI fallback bitmap".to_string());
            }
            let old_object = unsafe { SelectObject(memory_dc, bitmap) };
            unsafe {
                let _ = SetStretchBltMode(memory_dc, COLORONCOLOR);
            }
            let copied = unsafe {
                StretchBlt(
                    memory_dc,
                    0,
                    0,
                    src_width,
                    src_height,
                    src_dc,
                    src_x,
                    src_y,
                    src_width,
                    src_height,
                    windows::Win32::Graphics::Gdi::ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0),
                )
                .as_bool()
            };
            let result = if copied {
                bitmap_to_bgra_frame(memory_dc, bitmap, src_width, src_height)
            } else {
                Err("copy GDI fallback frame".to_string())
            };
            unsafe {
                if !old_object.is_invalid() {
                    SelectObject(memory_dc, old_object);
                }
                let _ = DeleteObject(bitmap);
                let _ = DeleteDC(memory_dc);
            }
            result
        }

        fn bitmap_to_bgra_frame(
            hdc: HDC,
            bitmap: HBITMAP,
            width: i32,
            height: i32,
        ) -> Result<CapturedBgraFrame, String> {
            let mut info = BITMAPINFO::default();
            info.bmiHeader.biSize =
                std::mem::size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = width;
            info.bmiHeader.biHeight = -height;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB.0;
            let width = width as usize;
            let height = height as usize;
            let stride = width
                .checked_mul(4)
                .ok_or_else(|| "GDI fallback row is too wide".to_string())?;
            let mut data = vec![0u8; stride.saturating_mul(height)];
            let lines = unsafe {
                GetDIBits(
                    hdc,
                    bitmap,
                    0,
                    height as u32,
                    Some(data.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut info,
                    DIB_RGB_COLORS,
                )
            };
            if lines == 0 {
                return Err("read GDI fallback bitmap bits".to_string());
            }
            Ok(CapturedBgraFrame {
                data: Arc::from(data),
                width,
                height,
                stride,
            })
        }

        /// Downscale a captured frame into the RGB buffer the preview encodes.
        ///
        /// Split out of the encoder so the preview worker can compare one frame
        /// with the previous one before paying for a JPEG.
        fn scaled_preview_rgb(
            frame: &CapturedBgraFrame,
        ) -> Result<(Vec<u8>, usize, usize), String> {
            if frame.width == 0 || frame.height == 0 {
                return Err("captured preview frame has an empty size".to_string());
            }
            let scale = (PREVIEW_MAX_WIDTH as f64 / frame.width as f64)
                .min(PREVIEW_MAX_HEIGHT as f64 / frame.height as f64)
                .min(1.0);
            let preview_width = ((frame.width as f64 * scale).round() as usize).max(1);
            let preview_height = ((frame.height as f64 * scale).round() as usize).max(1);
            let mut rgb = vec![
                0;
                preview_width
                    .saturating_mul(preview_height)
                    .saturating_mul(3)
            ];
            let x_starts = axis_starts(preview_width, frame.width);
            let x_ends = axis_ends(preview_width, frame.width);
            let y_starts = axis_starts(preview_height, frame.height);
            let y_ends = axis_ends(preview_height, frame.height);
            for y in 0..preview_height {
                let row = (y_starts[y], y_ends[y]);
                for x in 0..preview_width {
                    // The thumbnail is how the sharer judges the picture, so it
                    // has to use the same box filter as the encoded stream.
                    // Sampling one source pixel per output pixel would show
                    // aliasing the viewers never see. `average_bgra_block`
                    // returns red, green, blue in that order — assigning its
                    // first channel to the blue slot swapped red and blue in the
                    // preview while the encoded stream stayed correct.
                    let (r, g, b) = average_bgra_block(
                        &frame.data,
                        frame.stride,
                        (x_starts[x], x_ends[x]),
                        row,
                    );
                    let target_offset = (y * preview_width + x) * 3;
                    rgb[target_offset] = r;
                    rgb[target_offset + 1] = g;
                    rgb[target_offset + 2] = b;
                }
            }
            Ok((rgb, preview_width, preview_height))
        }

        fn encode_preview_data_url(
            rgb: &[u8],
            preview_width: usize,
            preview_height: usize,
        ) -> Result<String, String> {
            let mut jpeg = Vec::new();
            let encoder = JpegEncoder::new_with_quality(&mut jpeg, PREVIEW_JPEG_QUALITY);
            encoder
                .write_image(
                    rgb,
                    preview_width as u32,
                    preview_height as u32,
                    ColorType::Rgb8.into(),
                )
                .map_err(|err| format!("encode native screen share preview: {err}"))?;
            Ok(format!(
                "data:image/jpeg;base64,{}",
                general_purpose::STANDARD.encode(jpeg)
            ))
        }

        fn copy_mapped_bgra_frame(
            mapped: &D3D11_MAPPED_SUBRESOURCE,
            width: u32,
            height: u32,
        ) -> Result<CapturedBgraFrame, String> {
            if mapped.pData.is_null() {
                return Err("mapped D3D11 readback texture has no data".to_string());
            }
            let width = width as usize;
            let height = height as usize;
            let row_len = width
                .checked_mul(4)
                .ok_or_else(|| "captured frame row is too wide".to_string())?;
            let row_pitch = mapped.RowPitch as usize;
            if row_pitch < row_len {
                return Err("mapped D3D11 row pitch is smaller than its width".to_string());
            }
            let mapped_len = row_pitch
                .checked_mul(height)
                .ok_or_else(|| "mapped D3D11 frame is too large".to_string())?;
            let source =
                unsafe { std::slice::from_raw_parts(mapped.pData as *const u8, mapped_len) };
            let stride = row_len;
            let mut data = vec![0; stride.saturating_mul(height)];
            for y in 0..height {
                let source_start = y * row_pitch;
                let target_start = y * stride;
                data[target_start..target_start + row_len]
                    .copy_from_slice(&source[source_start..source_start + row_len]);
            }
            Ok(CapturedBgraFrame {
                data: Arc::from(data),
                width,
                height,
                stride,
            })
        }

        fn create_direct3d_device() -> Result<CaptureDevice, String> {
            let feature_levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let mut d3d_device: Option<ID3D11Device> = None;
            let mut d3d_context: Option<ID3D11DeviceContext> = None;
            let mut feature_level = D3D_FEATURE_LEVEL(0);
            unsafe {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    None,
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    Some(&feature_levels),
                    D3D11_SDK_VERSION,
                    Some(&mut d3d_device),
                    Some(&mut feature_level),
                    Some(&mut d3d_context),
                )
                .map_err(|err| format!("create D3D11 device: {err}"))?;
            }
            let d3d_device =
                d3d_device.ok_or_else(|| "D3D11 device was not returned".to_string())?;
            let d3d_context = d3d_context
                .ok_or_else(|| "D3D11 immediate context was not returned".to_string())?;
            let multithread: windows::Win32::Graphics::Direct3D11::ID3D11Multithread = d3d_context
                .cast()
                .map_err(|e| format!("protect shared D3D11 context: {e}"))?;
            unsafe {
                let _ = multithread.SetMultithreadProtected(true);
            }
            let dxgi_device: IDXGIDevice = d3d_device
                .cast()
                .map_err(|err| format!("cast D3D11 device to DXGI device: {err}"))?;
            let winrt_device = winrt_direct3d_device(&dxgi_device)?;
            Ok(CaptureDevice {
                winrt_device,
                d3d_device,
                d3d_context,
            })
        }

        /// Wraps the same DXGI device as the WinRT device WGC wants. The WinRT
        /// wrapper is not `Send`, but the D3D11 device behind it is free-threaded,
        /// so the capture threads rebuild the wrapper instead of carrying it.
        fn winrt_direct3d_device(dxgi_device: &IDXGIDevice) -> Result<IDirect3DDevice, String> {
            let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(dxgi_device) }
                .map_err(|err| format!("create WinRT Direct3D device: {err}"))?;
            inspectable
                .cast()
                .map_err(|err| format!("cast WinRT Direct3D device: {err}"))
        }

        fn capture_item_for_source(source_id: &str) -> Result<GraphicsCaptureItem, String> {
            let interop: IGraphicsCaptureItemInterop =
                factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                    .map_err(|err| format!("open WGC item interop: {err}"))?;
            if let Some(raw_hwnd) = source_id.strip_prefix("window:") {
                let hwnd_value = usize::from_str_radix(raw_hwnd, 16)
                    .map_err(|_| "invalid window source id".to_string())?;
                let hwnd = HWND(hwnd_value as *mut core::ffi::c_void);
                return unsafe { interop.CreateForWindow(hwnd) }
                    .map_err(|err| format!("create WGC item for window: {err}"));
            }
            if let Some(raw_index) = source_id.strip_prefix("screen:") {
                let index = raw_index
                    .parse::<usize>()
                    .map_err(|_| "invalid screen source id".to_string())?;
                let monitor = monitor_by_index(index)
                    .ok_or_else(|| "screen source is no longer available".to_string())?;
                return unsafe { interop.CreateForMonitor(monitor) }
                    .map_err(|err| format!("create WGC item for display: {err}"));
            }
            Err("unsupported desktop capture source id".to_string())
        }

        fn monitor_by_index(target_index: usize) -> Option<HMONITOR> {
            if target_index == 0 {
                return None;
            }
            struct MonitorLookup {
                target_index: usize,
                current_index: usize,
                monitor: Option<HMONITOR>,
            }

            unsafe extern "system" fn monitor_proc(
                monitor: HMONITOR,
                _hdc: HDC,
                _rect: *mut RECT,
                data: LPARAM,
            ) -> BOOL {
                let lookup = data.0 as *mut MonitorLookup;
                (*lookup).current_index += 1;
                if (*lookup).current_index != (*lookup).target_index {
                    return true.into();
                }
                let mut info = MONITORINFOEXW::default();
                info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
                let ok = GetMonitorInfoW(
                    monitor,
                    &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
                );
                if ok.as_bool() {
                    (*lookup).monitor = Some(monitor);
                }
                false.into()
            }

            let mut lookup = MonitorLookup {
                target_index,
                current_index: 0,
                monitor: None,
            };
            unsafe {
                let _ = EnumDisplayMonitors(
                    None,
                    None,
                    Some(monitor_proc),
                    LPARAM(&mut lookup as *mut _ as isize),
                );
            }
            lookup.monitor
        }

        fn monitor_rect_by_index(target_index: usize) -> Option<RECT> {
            let monitor = monitor_by_index(target_index)?;
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            let ok = unsafe {
                GetMonitorInfoW(
                    monitor,
                    &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
                )
            };
            ok.as_bool().then_some(info.monitorInfo.rcMonitor)
        }

        #[cfg(test)]
        mod tests {
            use super::*;

            #[test]
            #[ignore = "captures the selected physical SDR monitor; run with a continuous visible motion fixture"]
            fn compare_wgc_and_duplication_monitor_capture() {
                use windows::Win32::Graphics::Dxgi::Common::{
                    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_MODE_ROTATION_IDENTITY,
                };
                use windows::Win32::Graphics::Dxgi::{
                    IDXGIOutput1, IDXGIOutput6, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
                };
                let index = std::env::var("EV_DXGI_BENCH_MONITOR_INDEX")
                    .ok()
                    .map(|v| v.parse::<usize>().unwrap())
                    .unwrap_or(1);
                let source_id = format!("screen:{index}");
                let _apartment = CaptureApartment::enter().unwrap();
                let device = create_direct3d_device().unwrap();
                let adapter = unsafe {
                    device
                        .d3d_device
                        .cast::<IDXGIDevice>()
                        .unwrap()
                        .GetAdapter()
                }
                .unwrap();
                let monitor = monitor_by_index(index).expect("selected monitor missing");
                let output = (0..32)
                    .map_while(|i| unsafe { adapter.EnumOutputs(i) }.ok())
                    .find(|output| unsafe { output.GetDesc() }.is_ok_and(|d| d.Monitor == monitor))
                    .expect("selected monitor and capture/encode device must use the same adapter");
                let desc = unsafe { output.cast::<IDXGIOutput6>().unwrap().GetDesc1().unwrap() };
                assert_eq!(
                    desc.Rotation, DXGI_MODE_ROTATION_IDENTITY,
                    "rotated output needs an explicit transform"
                );
                assert_eq!(
                    desc.ColorSpace, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                    "HDR needs a color-managed capture path"
                );
                let width = (desc.DesktopCoordinates.right - desc.DesktopCoordinates.left) as u32;
                let height = (desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top) as u32;
                let profile = ev_media::ScreenShareVideoProfile::new(
                    ev_media::ScreenShareSourceKind::Screen,
                    ev_media::VideoSize::new(1920, 1080).unwrap(),
                    ev_media::VideoFrameRate::new(60).unwrap(),
                );
                for method in ["wgc", "dxgi", "dxgi", "wgc"] {
                    use crate::windows_media_foundation_encoder::{
                        H264OutputProfile, MediaFoundationH264Encoder,
                    };
                    let mut mft = MediaFoundationH264Encoder::new_with_device(
                        &profile,
                        "motion",
                        &device.d3d_device,
                        H264OutputProfile::High,
                    )
                    .unwrap();
                    let clock = CaptureClock::new().unwrap();
                    let mut ages = Vec::new();
                    let mut encoded = 0;
                    let mut pointer_only = 0;
                    let mut pointer_changes = 0;
                    let mut accumulated = 0;
                    let mut pump = ScreenShareFramePump::new(profile.frame_rate);
                    let mut submitted = 0;
                    let mut accept = |texture: &ID3D11Texture2D, capture_ns: u64| {
                        let at = CaptureClock::qpc_ns(clock.frequency).unwrap();
                        ages.push((i128::from(at) - i128::from(capture_ns)) / 1000);
                        let pts = capture_ns.saturating_sub(clock.origin_ns);
                        if pump.observe_frame_ns(pts) == FramePumpDecision::Forward {
                            submitted += 1;
                            encoded += mft
                                .encode_texture(texture, width, height, pts)
                                .unwrap()
                                .len();
                        }
                    };
                    let elapsed;
                    if method == "dxgi" {
                        let duplication = unsafe {
                            output
                                .cast::<IDXGIOutput1>()
                                .unwrap()
                                .DuplicateOutput(&device.d3d_device)
                        }
                        .unwrap();
                        let started = Instant::now();
                        while started.elapsed() < Duration::from_secs(3) {
                            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
                            let mut resource = None;
                            match unsafe {
                                duplication.AcquireNextFrame(40, &mut info, &mut resource)
                            } {
                                Ok(()) => {}
                                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
                                Err(e) => panic!("DXGI capture failed: {e}"),
                            }
                            if info.LastMouseUpdateTime != 0 {
                                pointer_changes += 1;
                            }
                            if info.LastPresentTime > 0 {
                                let texture = resource.unwrap().cast().unwrap();
                                accumulated += info.AccumulatedFrames.saturating_sub(1);
                                let ns = (info.LastPresentTime as u128 * 1_000_000_000
                                    / clock.frequency as u128)
                                    as u64;
                                accept(&texture, ns);
                            } else {
                                pointer_only += 1;
                            }
                            unsafe { duplication.ReleaseFrame() }.unwrap();
                        }
                        elapsed = started.elapsed();
                    } else {
                        let item = capture_item_for_source(&source_id).unwrap();
                        let size = item.Size().unwrap();
                        assert_eq!((size.Width, size.Height), (width as i32, height as i32));
                        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                            &device.winrt_device,
                            DirectXPixelFormat::B8G8R8A8UIntNormalized,
                            2,
                            size,
                        )
                        .unwrap();
                        let (tx, rx) = mpsc::sync_channel(1);
                        let handler =
                            TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(
                                move |_, _| {
                                    let _ = tx.try_send(());
                                    Ok(())
                                },
                            );
                        let token = pool.FrameArrived(&handler).unwrap();
                        let session = pool.CreateCaptureSession(&item).unwrap();
                        session.SetIsCursorCaptureEnabled(false).unwrap();
                        let _ = session.SetMinUpdateInterval(TimeSpan { Duration: 166666 });
                        session.StartCapture().unwrap();
                        let started = Instant::now();
                        while started.elapsed() < Duration::from_secs(3) {
                            let _ = rx.recv_timeout(Duration::from_millis(40));
                            if let Ok(frame) = pool.TryGetNextFrame() {
                                let access: IDirect3DDxgiInterfaceAccess =
                                    frame.Surface().unwrap().cast().unwrap();
                                let texture = unsafe { access.GetInterface() }.unwrap();
                                accept(
                                    &texture,
                                    (frame.SystemRelativeTime().unwrap().Duration as u64) * 100,
                                );
                                frame.Close().unwrap();
                            }
                        }
                        elapsed = started.elapsed();
                        pool.RemoveFrameArrived(token).unwrap();
                        session.Close().unwrap();
                        pool.Close().unwrap();
                    }
                    assert!(
                        !ages.is_empty(),
                        "no updated pixels captured; run a motion fixture"
                    );
                    ages.sort_unstable();
                    let p50 = ages[(ages.len() - 1) / 2];
                    let p95 = ages[(ages.len() - 1) * 95 / 100];
                    println!("capture_bench method={method} monitor={index} pixels={width}x{height} out=1920x1080@60 elapsed_s={:.3} source_updates={} submitted={} encoded_at_stop={} arrival_minus_source_us_p50={p50} arrival_minus_source_us_p95={p95} pointer_only={pointer_only} pointer_changes={pointer_changes} dxgi_missed={accumulated}",elapsed.as_secs_f64(),ages.len(),submitted,encoded);
                }
            }

            #[test]
            fn frame_slot_wakes_for_frames_and_reports_idle_waits() {
                let slot: std::sync::Arc<LatestFrameSlot<u32>> =
                    std::sync::Arc::new(LatestFrameSlot::new());
                assert!(matches!(
                    slot.wait_timeout(Duration::from_millis(2)),
                    FrameSlotWait::Timeout
                ));
                let producer = {
                    let slot = std::sync::Arc::clone(&slot);
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(20));
                        slot.replace(9)
                    })
                };
                assert!(matches!(
                    slot.wait_timeout(Duration::from_secs(5)),
                    FrameSlotWait::Frame(9)
                ));
                let _ = producer.join();
                slot.stop();
                assert!(matches!(
                    slot.wait_timeout(Duration::from_secs(5)),
                    FrameSlotWait::Stopped
                ));
            }

            #[test]
            fn a_preview_thumbnail_keeps_the_channel_order_it_was_given() {
                // `average_bgra_block` returns red, green, blue. Assigning its
                // first channel to the blue slot swapped red and blue in the
                // thumbnail while the encoded stream stayed correct - the sharer
                // then judged a picture the viewers never saw.
                let width = 4;
                let height = 2;
                let stride = width * 4;
                let mut data = Vec::with_capacity(stride * height);
                for _ in 0..(width * height) {
                    data.extend_from_slice(&[10, 20, 30, 255]);
                }
                let frame = CapturedBgraFrame {
                    data: std::sync::Arc::from(data.into_boxed_slice()),
                    width,
                    height,
                    stride,
                };

                let (rgb, preview_width, preview_height) = scaled_preview_rgb(&frame)
                    .expect("a small frame must always produce a thumbnail");
                assert_eq!((preview_width, preview_height), (width, height));
                for pixel in rgb.chunks_exact(3) {
                    assert_eq!(
                        pixel,
                        [30, 20, 10],
                        "the thumbnail must stay RGB even though the source is BGRA"
                    );
                }
            }

            #[test]
            fn a_relay_only_viewer_does_not_wait_out_the_direct_ice_grace() {
                // A relay-only viewer has no direct pair left to protect, so the
                // second we reserve for srflx/prflx is dead air in front of
                // nomination - and DTLS cannot start until a pair is nominated.
                assert_eq!(
                    viewer_relay_acceptance_wait(true),
                    Duration::from_millis(120)
                );
                assert_eq!(
                    viewer_relay_acceptance_wait(false),
                    Duration::from_millis(1_000)
                );
            }

            struct WebRtcTestLogger;

            static WEBRTC_TEST_LOG_START: std::sync::OnceLock<std::time::Instant> =
                std::sync::OnceLock::new();

            impl log::Log for WebRtcTestLogger {
                fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
                    metadata.level() <= log::Level::Warn
                        || metadata.target().contains("dtls")
                        || metadata.target().contains("peer_connection_internal")
                        || metadata.target().contains("ice")
                }

                fn log(&self, record: &log::Record<'_>) {
                    if self.enabled(record.metadata()) {
                        let start = WEBRTC_TEST_LOG_START.get_or_init(std::time::Instant::now);
                        eprintln!(
                            "[{:>8.1}ms {} {}] {}",
                            start.elapsed().as_secs_f64() * 1000.0,
                            record.level(),
                            record.target(),
                            record.args()
                        );
                    }
                }

                fn flush(&self) {}
            }

            static WEBRTC_TEST_LOGGER: WebRtcTestLogger = WebRtcTestLogger;

            fn init_webrtc_test_logger() {
                let _ = log::set_logger(&WEBRTC_TEST_LOGGER);
                log::set_max_level(log::LevelFilter::Trace);
            }

            fn synthetic_test_request() -> NativeScreenShareStartRequest {
                NativeScreenShareStartRequest {
                    server_id: "srv_test".to_string(),
                    channel_id: "ch_test".to_string(),
                    share_id: "share_test".to_string(),
                    owner_member_id: "mem_owner".to_string(),
                    source_id: "synthetic:color-bars".to_string(),
                    source_kind: "synthetic".to_string(),
                    source_process_id: None,
                    source_x: 0,
                    source_y: 0,
                    source_width: 320,
                    source_height: 180,
                    width: 320,
                    height: 180,
                    frame_rate: 30,
                    target_bitrate_bps: None,
                    content_mode: "balanced".to_string(),
                    capture_cursor: true,
                    preview_enabled: true,
                    include_audio: false,
                    remote_control_allowed: false,
                    ice_servers: Vec::new(),
                }
            }

            fn browser_test_request() -> NativeScreenShareStartRequest {
                let mut request = NativeScreenShareStartRequest {
                    width: browser_harness_profile_value("EV_SCREEN_SHARE_BROWSER_WIDTH", 1280),
                    height: browser_harness_profile_value("EV_SCREEN_SHARE_BROWSER_HEIGHT", 720),
                    frame_rate: browser_harness_profile_value(
                        "EV_SCREEN_SHARE_BROWSER_FRAME_RATE",
                        30,
                    ),
                    // The browser harness is the only place a real Chrome
                    // negotiates our screen-share audio track, so it has to be
                    // offered here; otherwise the Opus fmtp we advertise is
                    // only ever compared as text in the source.
                    include_audio: true,
                    ..synthetic_test_request()
                };
                if let Ok(raw) = std::env::var("EV_SCREEN_SHARE_BROWSER_ICE_SERVERS") {
                    if !raw.trim().is_empty() {
                        request.ice_servers = serde_json::from_str(&raw)
                            .expect("browser harness ICE server JSON must be valid");
                    }
                }
                request.target_bitrate_bps =
                    std::env::var("EV_SCREEN_SHARE_BROWSER_TARGET_BITRATE_BPS")
                        .ok()
                        .and_then(|value| value.parse::<u32>().ok())
                        .filter(|value| *value > 0);
                if std::env::var("EV_SCREEN_SHARE_BROWSER_REAL_CAPTURE").as_deref() == Ok("1") {
                    let requested_kind = std::env::var("EV_SCREEN_SHARE_BROWSER_REAL_CAPTURE_KIND")
                        .unwrap_or_else(|_| "screen".to_string());
                    let title = std::env::var("EV_SCREEN_SHARE_BROWSER_REAL_CAPTURE_TITLE").ok();
                    let source = crate::desktop_capture::list_sources()
                        .expect("enumerate desktop sources for browser harness")
                        .sources
                        .into_iter()
                        .find(|source| {
                            source.kind == requested_kind
                                && title.as_ref().is_none_or(|name| source.name == *name)
                        })
                        .unwrap_or_else(|| {
                            panic!("browser harness requires a {requested_kind} capture source")
                        });
                    request.source_id = source.source_id;
                    request.source_kind = source.kind;
                    request.source_process_id = source.process_id;
                }
                request
            }

            fn browser_harness_profile_value(name: &str, fallback: i32) -> i32 {
                std::env::var(name)
                    .ok()
                    .and_then(|value| value.parse::<i32>().ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(fallback)
            }

            fn synthetic_test_status(
                request: &NativeScreenShareStartRequest,
                profile: &ev_media::ScreenShareVideoProfile,
            ) -> Arc<Mutex<NativeScreenShareRuntimeStatus>> {
                Arc::new(Mutex::new(NativeScreenShareRuntimeStatus {
                    session_id: "nss_test".to_string(),
                    share_id: request.share_id.clone(),
                    source_id: request.source_id.clone(),
                    width: request.width,
                    height: request.height,
                    frame_rate: request.frame_rate,
                    audio_enabled: false,
                    phase: "running".to_string(),
                    backend: "synthetic-diagnostic-source".to_string(),
                    viewer_member_ids: Vec::new(),
                    viewer_paths: HashMap::new(),
                    viewer_layers: HashMap::new(),
                    low_tier_viewers: 0,
                    low_tier_bitrate_bps: None,
                    target_bitrate_bps: profile.target_bitrate_bps(),
                    effective_bitrate_bps: profile.target_bitrate_bps(),
                    receiver_estimated_bitrate_bps: None,
                    captured_frames: 0,
                    forwarded_frames: 0,
                    encoded_frames: 0,
                    pipeline: Default::default(),
                    dropped_frames: 0,
                    throttled_frames: 0,
                    encoder_backpressure_drops: 0,
                    viewer_backpressure_drops: 0,
                    audio_queue_drops: 0,
                    audio_samples_sent: 0,
                    audio_capture_errors: 0,
                    audio_send_errors: 0,
                    started_at_ms: now_ms(),
                    last_frame_at_ms: 0,
                    preview_enabled: request.preview_enabled,
                    preview_data_url: None,
                    preview_updated_at_ms: 0,
                    applied_answer_count: 0,
                    applied_ice_candidate_count: 0,
                    ignored_viewer_signal_count: 0,
                    native_peer_connection_state: "new".to_string(),
                    native_ice_connection_state: "new".to_string(),
                    native_ice_gathering_state: "new".to_string(),
                    sample_write_count: 0,
                    sample_write_error_count: 0,
                    last_sample_write_error: None,
                    last_error: None,
                }))
            }

            #[test]
            fn synthetic_frame_processing_updates_status() {
                let request = synthetic_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let keyframe_requested = Arc::new(AtomicBool::new(true));
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let media_sender = Arc::new(
                    NativeWebRtcSender::new(
                        &request,
                        outbound_signals,
                        Arc::clone(&status),
                        Arc::clone(&keyframe_requested),
                    )
                    .unwrap(),
                );
                let mut pipeline = FrameEncodingPipeline::start(
                    &profile,
                    &request.content_mode,
                    Arc::clone(&status),
                    keyframe_requested,
                    Arc::clone(&media_sender),
                )
                .unwrap();
                let frame = synthetic_bgra_frame(320, 180, 0);
                pipeline.input().submit(frame, Some(0));
                wait_for_pipeline_status(&status, 1, true);
                pipeline.stop();

                let snapshot = status.lock().unwrap().status_snapshot();
                assert_eq!(snapshot.captured_frames, 1);
                assert_eq!(snapshot.forwarded_frames, 1);
                assert_eq!(snapshot.dropped_frames, 0);
                assert_eq!(snapshot.encoded_frames, 1);
                assert_eq!(snapshot.phase, "sending");
                assert!(snapshot.last_frame_at_ms > 0);
                assert!(snapshot.preview_enabled);
                assert!(snapshot
                    .preview_data_url
                    .as_deref()
                    .is_some_and(|preview| preview.starts_with("data:image/jpeg;base64,")));
                assert!(snapshot.last_error.is_none());
                media_sender.close_all();
            }

            #[test]
            fn preview_thumbnail_averages_instead_of_dropping_pixels() {
                let width = (PREVIEW_MAX_WIDTH as usize) * 2;
                let height = (PREVIEW_MAX_HEIGHT as usize) * 2;
                let stride = width * 4;
                let mut data = vec![0u8; stride * height];
                for y in 0..height {
                    for x in 0..width {
                        let value = if (x + y) % 2 == 0 { 0u8 } else { 200u8 };
                        let offset = y * stride + x * 4;
                        data[offset] = value;
                        data[offset + 1] = value;
                        data[offset + 2] = value;
                        data[offset + 3] = 255;
                    }
                }
                let frame = CapturedBgraFrame {
                    data: Arc::from(data.into_boxed_slice()),
                    width,
                    height,
                    stride,
                };
                let (rgb, preview_width, preview_height) = scaled_preview_rgb(&frame).unwrap();
                assert_eq!(
                    (preview_width, preview_height),
                    (PREVIEW_MAX_WIDTH as usize, PREVIEW_MAX_HEIGHT as usize)
                );
                // Every output pixel covers a 2x2 block with two 0s and two 200s.
                // Picking a single source pixel instead would yield 0 or 200.
                for channel in 0..3 {
                    let sampled = rgb[channel];
                    assert!(
                        (95..=105).contains(&sampled),
                        "channel {channel} should be the block average, got {sampled}"
                    );
                }
                assert!(rgb.len() >= preview_width * preview_height * 3);
            }

            #[test]
            fn synthetic_preview_pipeline_pauses_and_resumes_without_stopping_capture() {
                let mut request = synthetic_test_request();
                request.preview_enabled = false;
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let keyframe_requested = Arc::new(AtomicBool::new(true));
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let media_sender = Arc::new(
                    NativeWebRtcSender::new(
                        &request,
                        outbound_signals,
                        Arc::clone(&status),
                        Arc::clone(&keyframe_requested),
                    )
                    .unwrap(),
                );
                let mut pipeline = FrameEncodingPipeline::start(
                    &profile,
                    &request.content_mode,
                    Arc::clone(&status),
                    keyframe_requested,
                    Arc::clone(&media_sender),
                )
                .unwrap();
                let input = pipeline.input();
                input.submit(synthetic_bgra_frame(320, 180, 0), Some(0));
                wait_for_pipeline_status(&status, 1, false);
                thread::sleep(Duration::from_millis(PREVIEW_INTERVAL_MS as u64 * 2));
                assert!(status.lock().unwrap().preview_data_url.is_none());

                status.lock().unwrap().preview_enabled = true;
                thread::sleep(Duration::from_millis(40));
                input.submit(synthetic_bgra_frame(320, 180, 1), Some(40_000_000));
                wait_for_pipeline_status(&status, 2, true);
                let snapshot = status.lock().unwrap().status_snapshot();
                assert!(snapshot.preview_enabled);
                assert!(snapshot
                    .preview_data_url
                    .as_deref()
                    .is_some_and(|preview| preview.starts_with("data:image/jpeg;base64,")));

                pipeline.stop();
                media_sender.close_all();
            }

            #[test]
            fn software_compatibility_encoder_keeps_constrained_baseline_after_retarget() {
                let profile = native_screen_share_video_profile(&synthetic_test_request()).unwrap();
                let mut encoder =
                    NativeScreenShareVideoEncoder::new(&profile, "motion", true).unwrap();
                let frame = synthetic_bgra_frame(320, 180, 0);
                for rate in [profile.target_bitrate_bps(), 2_000_000] {
                    encoder.set_target_bitrate_bps(rate).unwrap();
                    let encoded = encoder
                        .encode_bgra(&frame.data, frame.width, frame.height, frame.stride, 0)
                        .unwrap();
                    let id = h264_annexb_sps_profile_level_id(&encoded[0].data).unwrap();
                    let profile_idc = u8::from_str_radix(&id[..2], 16).unwrap();
                    let constraints = u8::from_str_radix(&id[2..4], 16).unwrap();
                    assert!(
                        crate::screen_share_rtp::is_constrained_baseline(profile_idc, constraints),
                        "unexpected OpenH264 compatibility SPS {id}"
                    );
                }
            }
            #[test]
            fn native_h264_offer_uses_profile_level_for_requested_cadence() {
                let request = synthetic_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let mut encoder = NativeH264Encoder::new(&profile).unwrap();
                let frame = synthetic_bgra_frame(320, 180, 0);
                let encoded = encoder
                    .encode_bgra(&frame.data, frame.width, frame.height, frame.stride)
                    .unwrap();
                let profile_level_id = h264_annexb_sps_profile_level_id(&encoded)
                    .expect("synthetic OpenH264 frame should include SPS");
                eprintln!("EchoVoice OpenH264 synthetic SPS profile-level-id={profile_level_id}");
                assert_eq!(
                    native_screen_share_h264_profile_level_id(&profile),
                    "640c1f",
                    "native WebRTC fmtp should advertise the High profile the encoder emits"
                );
                assert_eq!(
                    profile_level_id,
                    native_screen_share_h264_profile_level_id(&profile),
                    "the advertised profile-level-id must match the SPS the encoder emits, got {profile_level_id}"
                );

                let mut request_60 = request.clone();
                request_60.width = 1280;
                request_60.height = 720;
                request_60.frame_rate = 60;
                let profile_60 = native_screen_share_video_profile(&request_60).unwrap();
                assert_eq!(
                    native_screen_share_h264_profile_level_id(&profile_60),
                    "640020"
                );

                let mut request_120 = request_60;
                request_120.frame_rate = 120;
                let profile_120 = native_screen_share_video_profile(&request_120).unwrap();
                assert_eq!(
                    native_screen_share_h264_profile_level_id(&profile_120),
                    "64002a"
                );
            }

            #[test]
            fn accepts_high_resolution_120fps_profiles_within_h264_level_5_2() {
                for (width, height, expected_level) in [(1920, 1080, 51), (2560, 1440, 52)] {
                    let mut request = synthetic_test_request();
                    request.width = width;
                    request.height = height;
                    request.frame_rate = 120;

                    let profile = native_screen_share_video_profile(&request).unwrap();
                    assert_eq!(profile.required_h264_level_idc(), Some(expected_level));
                    assert!(crate::validate_native_screen_share_request(&request).is_ok());
                }
            }

            #[test]
            fn viewer_media_queue_recovers_with_a_fresh_keyframe_after_overflow() {
                let queue = ViewerMediaQueue::new(3);
                let sample = |value: u8, is_keyframe: bool| QueuedH264Sample {
                    data: Bytes::from(vec![value]),
                    capture_tick: 0,
                    enqueued_at: Instant::now(),
                    is_keyframe,
                };

                assert_eq!(
                    queue.push_latest(sample(0, false)),
                    ViewerMediaQueuePushResult::DroppedAwaitingKeyframe
                );
                assert_eq!(
                    queue.push_latest(sample(1, true)),
                    ViewerMediaQueuePushResult::Enqueued
                );
                assert_eq!(
                    queue.push_latest(sample(2, false)),
                    ViewerMediaQueuePushResult::Enqueued
                );
                assert_eq!(
                    queue.push_latest(sample(3, false)),
                    ViewerMediaQueuePushResult::Enqueued
                );
                assert_eq!(
                    queue.push_latest(sample(4, false)),
                    ViewerMediaQueuePushResult::Backpressure(4)
                );
                assert_eq!(
                    queue.push_latest(sample(5, false)),
                    ViewerMediaQueuePushResult::DroppedAwaitingKeyframe
                );
                assert_eq!(
                    queue.push_latest(sample(6, true)),
                    ViewerMediaQueuePushResult::Enqueued
                );
                assert_eq!(
                    queue.push_latest(sample(7, false)),
                    ViewerMediaQueuePushResult::Enqueued
                );

                let state = queue.state.lock().unwrap();
                assert!(!state.awaiting_keyframe);
                assert_eq!(state.samples.len(), 2);
                assert!(state.samples.front().unwrap().is_keyframe);
                assert_eq!(state.samples.front().unwrap().data.as_ref(), &[6]);
                assert_eq!(state.samples.back().unwrap().data.as_ref(), &[7]);
            }

            #[test]
            fn viewer_queue_expires_stale_frames_even_below_capacity() {
                let runtime = TokioRuntimeBuilder::new_current_thread().build().unwrap();
                runtime.block_on(async {
                    let queue = ViewerMediaQueue::new(8);
                    let now = Instant::now();
                    let sample = |is_keyframe, enqueued_at| QueuedH264Sample {
                        data: Bytes::from_static(b"sample"),
                        capture_tick: 0,
                        enqueued_at,
                        is_keyframe,
                    };
                    let old = now - Duration::from_secs(1);
                    queue.push_latest(sample(true, old));
                    queue.push_latest(sample(false, now));
                    let expired = queue.next().await.unwrap().err().unwrap();
                    assert_eq!(expired.count, 2);
                    assert!(expired.needs_keyframe);
                    assert_eq!(
                        queue.push_latest(sample(false, now)),
                        ViewerMediaQueuePushResult::DroppedAwaitingKeyframe
                    );

                    queue.push_latest(sample(true, old));
                    queue.push_latest(sample(false, now));
                    queue.push_latest(sample(true, now));
                    let expired = queue.next().await.unwrap().err().unwrap();
                    assert_eq!(expired.count, 2);
                    assert!(!expired.needs_keyframe);
                    assert!(queue.next().await.unwrap().unwrap().is_keyframe);
                });
            }

            #[test]
            fn one_slow_viewer_does_not_reduce_unrelated_viewers_bitrate() {
                assert!(!shared_encode_is_backpressured(ScreenShareLayer::Low, 1, 1));
                assert!(!shared_encode_is_backpressured(
                    ScreenShareLayer::High,
                    2,
                    1
                ));
                assert!(!shared_encode_is_backpressured(
                    ScreenShareLayer::High,
                    0,
                    0
                ));
                assert!(shared_encode_is_backpressured(ScreenShareLayer::High, 1, 1));
                assert!(shared_encode_is_backpressured(ScreenShareLayer::High, 2, 2));
            }

            #[test]
            fn viewer_media_queue_preserves_frames_across_regular_keyframes() {
                let queue = ViewerMediaQueue::new(4);
                let sample = |value: u8, is_keyframe: bool| QueuedH264Sample {
                    data: Bytes::from(vec![value]),
                    capture_tick: 0,
                    enqueued_at: Instant::now(),
                    is_keyframe,
                };

                for (value, is_keyframe) in [(1, true), (2, false), (3, true), (4, false)] {
                    assert_eq!(
                        queue.push_latest(sample(value, is_keyframe)),
                        ViewerMediaQueuePushResult::Enqueued
                    );
                }

                let state = queue.state.lock().unwrap();
                assert_eq!(
                    state
                        .samples
                        .iter()
                        .map(|sample| sample.data[0])
                        .collect::<Vec<_>>(),
                    vec![1, 2, 3, 4]
                );
            }

            #[test]
            fn viewer_media_queue_tells_a_starting_viewer_apart_from_a_dropping_one() {
                let queue = ViewerMediaQueue::new(3);
                let sample = |is_keyframe: bool| QueuedH264Sample {
                    data: Bytes::from_static(b"frame"),
                    capture_tick: 0,
                    enqueued_at: Instant::now(),
                    is_keyframe,
                };

                assert!(!queue.has_started());
                assert_eq!(
                    queue.push_latest(sample(false)),
                    ViewerMediaQueuePushResult::DroppedAwaitingKeyframe
                );
                assert!(
                    !queue.has_started(),
                    "a viewer waiting for its first keyframe has not started, so it is not dropping frames"
                );

                assert_eq!(
                    queue.push_latest(sample(true)),
                    ViewerMediaQueuePushResult::Enqueued
                );
                assert!(queue.has_started(), "the keyframe starts this viewer");

                for _ in 0..2 {
                    queue.push_latest(sample(false));
                }
                assert_eq!(
                    queue.push_latest(sample(false)),
                    ViewerMediaQueuePushResult::Backpressure(4)
                );
                assert!(
                    queue.has_started(),
                    "a viewer that already received a keyframe still counts after an overflow"
                );
            }

            #[test]
            fn viewer_fan_out_shares_the_encoded_buffer() {
                // Fan-out must stay a refcount bump. If it ever turns into a
                // copy per viewer, an eight viewer room starts moving the whole
                // encoded frame eight times per frame, on the encoder thread.
                let encoded = Bytes::from(vec![7u8; 4096]);
                let sample = QueuedH264Sample {
                    data: encoded.clone(),
                    capture_tick: 0,
                    enqueued_at: Instant::now(),
                    is_keyframe: true,
                };
                let queues = [
                    Arc::new(ViewerMediaQueue::new(6)),
                    Arc::new(ViewerMediaQueue::new(6)),
                    Arc::new(ViewerMediaQueue::new(6)),
                ];
                for queue in &queues {
                    assert_eq!(
                        queue.push_latest(sample.clone()),
                        ViewerMediaQueuePushResult::Enqueued
                    );
                }

                let base = encoded.as_ptr() as usize;
                for queue in &queues {
                    let state = queue.state.lock().unwrap();
                    let queued = state.samples.front().expect("fan-out must enqueue");
                    assert_eq!(
                        queued.data.as_ptr() as usize,
                        base,
                        "fan-out must share the encoded buffer instead of copying it per viewer"
                    );
                }
            }

            #[test]
            fn high_bitrate_percentages_preserve_the_configured_range() {
                assert_eq!(scale_bitrate(80_000_000, 85), 68_000_000);
                assert_eq!(scale_bitrate(60_000_000, 115), 69_000_000);
                let mut controller = NativeScreenShareBitrateController::new(80_000_000);
                controller.reserve_viewer_layer("fast");
                controller.reserve_viewer_layer("slow");
                controller.update_receiver_estimate("fast", 80_000_000);
                let (_, _, changed) = controller.update_receiver_estimate("slow", 50_000_000);
                assert_eq!(changed, Some(ScreenShareLayer::Low));
            }

            #[test]
            fn native_bitrate_controller_starts_safely_and_reacts_to_congestion() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                assert_eq!(controller.effective_bitrate_bps, 22_118_400);

                controller.effective_bitrate_bps = 10_000_000;
                assert_eq!(controller.reduce_for_backpressure(), 8_000_000);

                let (effective, estimate, _) =
                    controller.update_receiver_estimate("vp_viewer", 2_000_000);
                assert_eq!(estimate, 2_000_000);
                assert_eq!(effective, 1_700_000);
            }

            #[test]
            fn native_bitrate_controller_ignores_small_receiver_estimate_oscillation() {
                let mut controller = NativeScreenShareBitrateController::new(20_000_000);
                let (effective, estimate, _) =
                    controller.update_receiver_estimate("vp_viewer", 23_000_000);

                assert_eq!(estimate, 23_000_000);
                assert_eq!(effective, 20_000_000);
            }

            #[test]
            fn native_bitrate_controller_recovers_from_a_transient_dip() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                let (after_dip, _, _) = controller.update_receiver_estimate("vp_viewer", 4_000_000);
                assert_eq!(after_dip, 3_400_000);

                controller.last_increase_at = Instant::now()
                    .checked_sub(NATIVE_SCREEN_SHARE_BITRATE_INCREASE_INTERVAL)
                    .expect("instant supports subtraction");
                let (recovered, _, _) =
                    controller.update_receiver_estimate("vp_viewer", 22_000_000);

                // One interval of recovery must move a quarter of the way up,
                // not the ten percent that left streams blurry for a minute.
                assert_eq!(recovered, 4_250_000);
            }

            #[test]
            fn native_bitrate_controller_moves_a_newcomer_off_the_shared_encode() {
                let mut controller = NativeScreenShareBitrateController::new(3_400_000);
                let (steady, _, _) =
                    controller.update_receiver_estimate("steady_viewer", 4_000_000);
                assert_eq!(steady, 3_400_000);

                // A newcomer's estimator converges upward from a low value. It is
                // moved to the reduced tier instead of blurring the stream the
                // steady viewer is watching, so no confirmation window is needed.
                let (kept, _, layer) = controller.update_receiver_estimate("newcomer", 800_000);
                assert_eq!(layer, Some(ScreenShareLayer::Low));
                assert_eq!(
                    kept, 3_400_000,
                    "a viewer on the reduced tier must not change the shared encode"
                );
                assert!(
                    controller.low_estimate_hold.is_none(),
                    "demoting the newcomer is the answer, not waiting for it to settle"
                );
            }

            #[test]
            fn native_bitrate_controller_demotes_a_viewer_that_cannot_hold_the_shared_rate() {
                let mut controller = NativeScreenShareBitrateController::new(6_000_000);
                controller.update_receiver_estimate("steady_viewer", 6_000_000);
                let (shared, _, _) = controller.update_receiver_estimate("other_viewer", 6_000_000);
                assert_eq!(shared, 5_100_000);

                // The dip is far below what the other viewer already carries, so
                // it belongs to this link: the viewer moves to the reduced encode
                // and the shared rate is left where the healthy viewer needs it.
                let (held, _, layer) =
                    controller.update_receiver_estimate("steady_viewer", 2_600_000);
                assert_eq!(layer, Some(ScreenShareLayer::Low));
                assert_eq!(
                    held, 5_100_000,
                    "a link that cannot hold the shared rate must not halve it for everyone"
                );
            }

            #[test]
            fn native_bitrate_controller_tracks_a_lone_viewer_immediately() {
                let mut controller = NativeScreenShareBitrateController::new(3_400_000);
                let (effective, _, _) = controller.update_receiver_estimate("solo_viewer", 800_000);

                // With nobody else to protect, waiting would only add dropouts.
                assert_eq!(effective, 1_500_000);
            }

            #[test]
            fn native_bitrate_controller_rate_limits_backpressure_reductions() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                controller.effective_bitrate_bps = 10_000_000;

                // A viewer that cannot drain its queue reports backpressure once
                // per queue refill, which is roughly every hundred milliseconds
                // at sixty frames per second. Honouring each report would strip
                // more than eighty percent of the bitrate within a second and
                // keep it there while that viewer stays connected.
                assert_eq!(controller.reduce_for_backpressure(), 8_000_000);
                assert_eq!(controller.reduce_for_backpressure(), 8_000_000);
                assert_eq!(controller.reduce_for_backpressure(), 8_000_000);

                controller.last_backpressure_reduction_at = Some(
                    Instant::now()
                        .checked_sub(NATIVE_SCREEN_SHARE_BACKPRESSURE_INTERVAL)
                        .expect("instant supports subtraction"),
                );
                assert_eq!(controller.reduce_for_backpressure(), 6_400_000);
            }

            #[test]
            fn native_bitrate_controller_recovers_immediately_when_the_limit_leaves() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                let (narrow, _, _) = controller.update_receiver_estimate("hotel_viewer", 1_000_000);
                assert_eq!(narrow, 1_500_000);
                // The healthy viewer was already connected, and its estimate was
                // taken while the encode was held down for the hotel link.
                controller.update_receiver_estimate("office_viewer", 20_000_000);
                assert_eq!(controller.effective_bitrate_bps, 1_500_000);

                // The viewer that forced the floor is gone. Walking up in
                // twenty-five percent steps would take about twelve seconds to
                // reach the remaining ceiling, all of them visibly soft, and the
                // estimates that would drive that walk were measured against the
                // throttled stream in the first place.
                assert_eq!(controller.remove_viewer("hotel_viewer"), Some(17_000_000));
                assert_eq!(controller.effective_bitrate_bps, 17_000_000);
            }

            #[test]
            fn native_bitrate_controller_still_probes_when_the_ceiling_is_close() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                controller.effective_bitrate_bps = 10_000_000;
                controller.viewer_estimates.insert(
                    "solo_viewer".to_string(),
                    NativeScreenShareViewerBitrateEstimate {
                        bitrate_bps: 20_000_000,
                        updated_at: Instant::now(),
                    },
                );
                controller.last_increase_at = Instant::now()
                    .checked_sub(NATIVE_SCREEN_SHARE_BITRATE_INCREASE_INTERVAL)
                    .expect("instant supports subtraction");

                // Seventeen megabits is less than twice ten, so this is still an
                // unknown-capacity probe: one step of twenty-five percent, not a
                // jump to the ceiling.
                assert_eq!(controller.probe_upward(), 12_500_000);
            }

            #[test]
            fn native_bitrate_controller_probes_past_a_stuck_estimate() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                controller.update_receiver_estimate("solo_viewer", 2_000_000);
                assert_eq!(controller.effective_bitrate_bps, 1_700_000);

                // The viewer's estimate is derived from what it receives, so a
                // throttled encode keeps reporting the throttled rate. Without a
                // probe that dares to exceed it the picture never recovers, which
                // is exactly the "only a stop and start brings the sharpness
                // back" report.
                for _ in 0..40 {
                    controller.last_increase_at = Instant::now()
                        .checked_sub(NATIVE_SCREEN_SHARE_BITRATE_INCREASE_INTERVAL)
                        .expect("instant supports subtraction");
                    controller.probe_upward();
                }

                assert!(
                    controller.effective_bitrate_bps > 1_700_000,
                    "the probe has to climb above a stuck estimate"
                );
                assert!(
                    controller.effective_bitrate_bps <= 4_000_000,
                    "the probe must stay within twice the reported ceiling"
                );
            }

            #[test]
            fn native_bitrate_controller_forgets_a_ceiling_nobody_needs() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                controller.update_receiver_estimate("hotel_viewer", 1_000_000);
                assert_eq!(
                    controller.effective_bitrate_bps,
                    NATIVE_SCREEN_SHARE_MIN_BITRATE_BPS
                );

                controller.update_receiver_estimate("office_viewer", 20_000_000);
                controller.remove_viewer("hotel_viewer");
                // The estimate that is left was measured while the encode was
                // throttled for someone else, so it under-reports the office
                // link. Climbing from it would keep the remaining viewer soft for
                // seconds after the constraint left; the ceiling its own report
                // describes applies at once.
                assert_eq!(
                    controller.effective_bitrate_bps, 17_000_000,
                    "the remaining viewer's own ceiling applies as soon as the limiter leaves"
                );

                controller.remove_viewer("office_viewer");
                assert_eq!(
                    controller.effective_bitrate_bps, controller.maximum_bitrate_bps,
                    "with nobody watching, the next viewer must not inherit a ceiling that was never about them"
                );
            }

            #[test]
            fn native_bitrate_controller_keeps_a_weak_viewer_off_the_shared_encode() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                controller.update_receiver_estimate("office_viewer", 20_000_000);
                assert_eq!(controller.effective_bitrate_bps, 17_000_000);
                assert_eq!(
                    controller.viewer_layer("office_viewer"),
                    ScreenShareLayer::High
                );

                // The distant viewer cannot take the full-quality encode. Before
                // tiers it published its own low ceiling for everyone, which is
                // the reported "everything turns soft when someone far away
                // joins". Now it gets its own reduced encode instead.
                let (effective, reported, layer) =
                    controller.update_receiver_estimate("hotel_viewer", 1_000_000);
                assert_eq!(layer, Some(ScreenShareLayer::Low));
                assert_eq!(
                    controller.viewer_layer("hotel_viewer"),
                    ScreenShareLayer::Low
                );
                assert_eq!(
                    effective, 17_000_000,
                    "the full-quality encode keeps the rate its own viewer supports"
                );
                assert_eq!(
                    reported, 20_000_000,
                    "a viewer on the reduced tier must not report a ceiling for the shared one"
                );
                let low = controller
                    .low_tier_target_bitrate_bps()
                    .expect("the reduced tier is active");
                assert!(
                    (NATIVE_SCREEN_SHARE_LOW_TIER_MIN_BPS..=NATIVE_SCREEN_SHARE_LOW_TIER_MAX_BPS)
                        .contains(&low),
                    "the reduced tier stays inside its own band, got {low}"
                );
            }

            #[test]
            fn native_bitrate_controller_promotes_a_reduced_viewer_after_two_good_samples() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                controller.update_receiver_estimate("office_viewer", 20_000_000);
                // A viewer joining a share already has a tier, and it starts on
                // the full-quality encode whatever the arrival order was.
                assert_eq!(
                    controller.reserve_viewer_layer("hotel_viewer"),
                    ScreenShareLayer::High
                );

                // Its own estimate is what moves it down.
                assert_eq!(
                    controller
                        .update_receiver_estimate("hotel_viewer", 1_000_000)
                        .2,
                    Some(ScreenShareLayer::Low)
                );
                controller.update_receiver_estimate("hotel_viewer", 3_000_000);
                assert_eq!(
                    controller.viewer_layer("hotel_viewer"),
                    ScreenShareLayer::Low,
                    "a sample far below what the other viewer carries neither promotes nor resets the count"
                );
                // Promotion is relative to the best viewer, not to a fixed rate: a
                // link is ready for the shared encode when it can carry what that
                // encode is already being steered to.
                assert_eq!(
                    controller
                        .update_receiver_estimate("hotel_viewer", 19_500_000)
                        .2,
                    None,
                    "one good sample is not enough to promote a viewer"
                );
                let (_, _, promoted) =
                    controller.update_receiver_estimate("hotel_viewer", 19_500_000);
                assert_eq!(
                    promoted,
                    Some(ScreenShareLayer::High),
                    "two consecutive samples near the best viewer promote the viewer"
                );
            }

            #[test]
            fn native_bitrate_controller_releases_the_reduced_tier_when_its_viewer_leaves() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                controller.update_receiver_estimate("office_viewer", 20_000_000);
                controller.update_receiver_estimate("hotel_viewer", 1_000_000);
                assert!(controller.low_tier_target_bitrate_bps().is_some());

                controller.remove_viewer("hotel_viewer");
                assert_eq!(
                    controller.low_tier_target_bitrate_bps(),
                    None,
                    "with nobody on the reduced tier its encoder must stop being fed"
                );
                assert_eq!(
                    controller.effective_bitrate_bps, 17_000_000,
                    "the full-quality viewer keeps its rate throughout"
                );
            }

            #[test]
            fn native_bitrate_controller_keeps_feeding_a_reduced_viewer_without_a_fresh_estimate() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                controller.update_receiver_estimate("office_viewer", 20_000_000);
                controller.update_receiver_estimate("hotel_viewer", 1_000_000);
                assert_eq!(
                    controller.viewer_layer("hotel_viewer"),
                    ScreenShareLayer::Low
                );

                // REMB is not sent by every receiver every second. Once the
                // reduced viewer's estimate expires it still sits on the low
                // tier, so dropping the encoder would freeze its picture until
                // the next report (which is exactly the "plays for a second,
                // then stops" report).
                controller.viewer_estimates.clear();
                assert_eq!(
                    controller.low_tier_target_bitrate_bps(),
                    Some(NATIVE_SCREEN_SHARE_LOW_TIER_MIN_BPS),
                    "a reduced viewer keeps a live encoder at the low-tier floor"
                );

                controller.remove_viewer("hotel_viewer");
                assert_eq!(controller.low_tier_target_bitrate_bps(), None);
            }

            #[test]
            fn native_bitrate_controller_resumes_from_its_peak_after_an_idle_gap() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                controller.update_receiver_estimate("office_viewer", 20_000_000);
                assert_eq!(controller.effective_bitrate_bps, 17_000_000);
                // A healthy share climbs above the reported ceiling: that is
                // where the peak this test resumes from comes from.
                for _ in 0..3 {
                    controller.last_increase_at = Instant::now()
                        .checked_sub(NATIVE_SCREEN_SHARE_BITRATE_INCREASE_INTERVAL)
                        .expect("instant supports subtraction");
                    controller.probe_upward();
                }
                let peak = controller.effective_bitrate_bps;
                assert!(peak > 17_000_000, "the probe should have climbed: {peak}");

                // While the window was in the background the encoder sent
                // nothing, so the receiver reported a path that carries almost
                // nothing and the working rate collapsed.
                controller.update_receiver_estimate("office_viewer", 4_000_000);
                assert!(
                    controller.effective_bitrate_bps <= 3_500_000,
                    "the collapsed estimate should pull the rate down: {}",
                    controller.effective_bitrate_bps
                );

                // Those reports describe the silence, not the path, and by the
                // time frames come back they are older than the report window.
                for estimate in controller.viewer_estimates.values_mut() {
                    estimate.updated_at = Instant::now()
                        .checked_sub(NATIVE_SCREEN_SHARE_ESTIMATE_MAX_AGE + Duration::from_secs(1))
                        .expect("the report window is far shorter than the process uptime");
                }

                // Crawling back one probe per second would leave the viewer
                // blurred for a minute, so the resume jumps to what this share
                // already proved it could send.
                let resumed = controller.resume_after_idle();
                assert_eq!(resumed, peak);
                assert_eq!(controller.effective_bitrate_bps, peak);
                assert_eq!(
                    controller.probe_upward(),
                    peak,
                    "an expired estimate window must not undo the resume"
                );
            }

            #[test]
            fn native_viewer_path_separates_a_relay_from_a_direct_connection() {
                use CandidateType::{Host, Relay, ServerReflexive, Unspecified};

                assert_eq!(
                    classify_candidate_types(Some(Host), Some(Host)),
                    "direct",
                    "two host candidates are a direct connection"
                );
                assert_eq!(
                    classify_candidate_types(Some(Host), Some(ServerReflexive)),
                    "direct",
                    "a server reflexive address is still a direct path"
                );
                assert_eq!(classify_candidate_types(Some(Relay), Some(Host)), "relay");
                assert_eq!(classify_candidate_types(Some(Host), Some(Relay)), "relay");
                assert_eq!(classify_candidate_types(Some(Relay), Some(Relay)), "relay");

                // An unresolved report must never be shown as a direct path:
                // that is exactly the reading a user would act on.
                assert_eq!(classify_candidate_types(None, Some(Host)), "unknown");
                assert_eq!(classify_candidate_types(Some(Host), None), "unknown");
                assert_eq!(
                    classify_candidate_types(Some(Unspecified), Some(Host)),
                    "unknown"
                );
            }

            #[test]
            fn native_bitrate_controller_obeys_a_lowered_maximum_immediately() {
                let mut controller = NativeScreenShareBitrateController::new(22_118_400);
                controller.update_receiver_estimate("office_viewer", 20_000_000);
                assert!(controller.effective_bitrate_bps > 3_000_000);

                controller.set_maximum_bitrate(3_000_000);
                assert_eq!(controller.maximum_bitrate_bps, 3_000_000);
                assert_eq!(
                    controller.effective_bitrate_bps, 3_000_000,
                    "a lowered ceiling has to take effect at once, that is why it was lowered"
                );

                // Raising the ceiling only re-opens headroom; the controller still
                // probes back up at its own pace.
                controller.set_maximum_bitrate(8_000_000);
                assert_eq!(controller.maximum_bitrate_bps, 8_000_000);
                assert_eq!(controller.effective_bitrate_bps, 3_000_000);

                // A zero request is a malformed signal, not "mute the share".
                controller.set_maximum_bitrate(0);
                assert_eq!(controller.maximum_bitrate_bps, 8_000_000);
            }

            #[test]
            fn native_frame_pump_retargets_without_waiting_for_the_old_deadline() {
                let mut pump = ScreenShareFramePump::new(
                    ev_media::VideoFrameRate::new(10).expect("10 fps is a valid rate"),
                );
                assert_eq!(pump.observe_frame_ns(0), FramePumpDecision::Forward);
                // At 10 fps the next frame is due 100 ms later, so this one waits.
                assert_eq!(pump.observe_frame_ns(1_000_000), FramePumpDecision::Drop);

                pump.set_target_frame_rate(
                    ev_media::VideoFrameRate::new(60).expect("60 fps is a valid rate"),
                );
                assert_eq!(pump.target_frame_rate().fps(), 60);
                // The old deadline belonged to the old cadence: keeping it would
                // delay the first frame at the new rate by up to 100 ms.
                assert_eq!(pump.observe_frame_ns(2_000_000), FramePumpDecision::Forward);
            }

            #[test]
            fn native_keyframe_throttle_keeps_a_stalled_viewer_recoverable() {
                let interval = NATIVE_SCREEN_SHARE_MIN_KEYFRAME_INTERVAL;
                let now = Instant::now();
                assert!(keyframe_throttle_allows(None, now, interval));

                let just_forced = now
                    .checked_sub(Duration::from_millis(1))
                    .expect("instant supports subtraction");
                assert!(!keyframe_throttle_allows(Some(just_forced), now, interval));

                // The request stays pending while throttled, so a viewer that is
                // genuinely stuck still gets its keyframe when the window closes
                // instead of losing the request altogether.
                let window_closed = now
                    .checked_sub(interval)
                    .expect("instant supports subtraction");
                assert!(keyframe_throttle_allows(Some(window_closed), now, interval));
            }

            #[test]
            fn native_write_errors_ask_for_one_keyframe_not_one_per_sample() {
                // The first failure after a healthy run is the one that can tell
                // us something changed; the rest are the same viewer being gone.
                assert!(keyframe_after_write_error(1));
                assert!(!keyframe_after_write_error(0));
                assert!(!keyframe_after_write_error(2));
                assert!(!keyframe_after_write_error(600));
            }

            #[test]
            fn native_scaled_bgra_conversion_uses_bt709_video_range() {
                assert_eq!(rgb_to_y((0, 0, 0)), 16);
                assert_eq!(rgb_to_y((255, 255, 255)), 235);
                assert_eq!(rgb_to_u((0, 0, 0)), 128);
                assert_eq!(rgb_to_v((0, 0, 0)), 128);
                assert_eq!(rgb_to_u((255, 255, 255)), 128);
                assert_eq!(rgb_to_v((255, 255, 255)), 128);

                let mut request = synthetic_test_request();
                request.width = 2;
                request.height = 2;
                let profile = native_screen_share_video_profile(&request).unwrap();
                let mut encoder = NativeH264Encoder::new(&profile).unwrap();
                encoder
                    .convert_scaled_bgra_to_i420(&[0; 64], 4, 4, 16)
                    .unwrap();
                assert_eq!(encoder.y_plane, vec![16; 4]);
                assert_eq!(encoder.u_plane, vec![128]);
                assert_eq!(encoder.v_plane, vec![128]);
            }

            #[test]
            fn native_block_average_keeps_bgra_channel_order() {
                let mut source = vec![0u8; 2 * 4];
                source[2] = 200;
                let (red, green, blue) = average_bgra_block(&source, 8, (0, 2), (0, 1));
                assert_eq!((red, green, blue), (100, 0, 0));
            }

            #[test]
            fn native_frame_axis_ranges_cover_every_source_sample() {
                for (output, source) in [(2usize, 4usize), (720, 1080), (1280, 1366), (1080, 720)] {
                    let starts = axis_starts(output, source);
                    let ends = axis_ends(output, source);
                    assert_eq!(starts.len(), output, "{output}/{source}");
                    assert_eq!(starts[0], 0, "{output}/{source}");
                    assert_eq!(*ends.last().unwrap(), source, "{output}/{source}");
                    for index in 0..output {
                        assert!(
                            ends[index] > starts[index],
                            "{output}/{source} index {index} covers nothing"
                        );
                        if index > 0 {
                            assert!(starts[index] >= starts[index - 1], "{output}/{source}");
                            assert!(ends[index] >= ends[index - 1], "{output}/{source}");
                        }
                    }
                    if source >= output {
                        for index in 1..output {
                            assert_eq!(
                                starts[index],
                                ends[index - 1],
                                "{output}/{source} leaves a gap at {index}"
                            );
                        }
                    }
                }
            }

            #[test]
            fn native_scaled_bgra_conversion_averages_instead_of_dropping_samples() {
                let mut request = synthetic_test_request();
                request.width = 2;
                request.height = 2;
                let profile = native_screen_share_video_profile(&request).unwrap();
                let mut encoder = NativeH264Encoder::new(&profile).unwrap();

                // Every output pixel of a 2:1 downscale covers two black and two
                // white samples. Point sampling returned 16 or 235; averaging has
                // to land in between, which is what stops thin text from shimmering.
                let mut source = vec![0u8; 4 * 4 * 4];
                for y in 0..4 {
                    for x in 0..4 {
                        let value = if (x + y) % 2 == 0 { 255u8 } else { 0u8 };
                        let offset = (y * 4 + x) * 4;
                        source[offset] = value;
                        source[offset + 1] = value;
                        source[offset + 2] = value;
                        source[offset + 3] = 255;
                    }
                }
                encoder
                    .convert_scaled_bgra_to_i420(&source, 4, 4, 16)
                    .unwrap();
                for value in &encoder.y_plane {
                    assert!(
                        (120..=132).contains(value),
                        "a 2:1 downscale must average the samples it drops, got {value}"
                    );
                }
            }
            #[test]
            #[ignore = "timing probe: run with --ignored --nocapture to measure the scaler"]
            fn native_scaled_bgra_conversion_timing_probe() {
                let mut request = synthetic_test_request();
                request.width = 1920;
                request.height = 1080;
                let profile = native_screen_share_video_profile(&request).unwrap();
                let mut encoder = NativeH264Encoder::new(&profile).unwrap();

                // The worst realistic case: a 4K display feeding the 1080p preset
                // at 60 fps. Averaging reads every source sample, so this is the
                // number that decides whether the quality fix costs frame rate.
                let source_width = 3840_usize;
                let source_height = 2160_usize;
                let mut source = vec![0_u8; source_width * source_height * 4];
                for (index, value) in source.iter_mut().enumerate() {
                    *value = (index % 251) as u8;
                }

                let iterations = 30_u32;
                let start = std::time::Instant::now();
                for _ in 0..iterations {
                    encoder
                        .convert_scaled_bgra_to_i420(
                            &source,
                            source_width,
                            source_height,
                            source_width * 4,
                        )
                        .unwrap();
                }
                let per_frame = start.elapsed() / iterations;
                println!("4K->1080p scaler: {per_frame:?} per frame");
                assert!(
                    per_frame < Duration::from_millis(40),
                    "4K->1080p scaling costs {per_frame:?} per frame"
                );
            }

            #[test]
            fn native_simd_bgra_conversion_uses_bt709_video_range() {
                let mut request = synthetic_test_request();
                request.width = 2;
                request.height = 2;
                let profile = native_screen_share_video_profile(&request).unwrap();
                let mut encoder = NativeH264Encoder::new(&profile).unwrap();

                encoder
                    .convert_scaled_bgra_to_i420(&[0; 16], 2, 2, 8)
                    .unwrap();
                assert_eq!(encoder.y_plane, vec![16; 4]);
                assert_eq!(encoder.u_plane, vec![128]);
                assert_eq!(encoder.v_plane, vec![128]);

                encoder
                    .convert_scaled_bgra_to_i420(&[255; 16], 2, 2, 8)
                    .unwrap();
                assert_eq!(encoder.y_plane, vec![235; 4]);
                assert_eq!(encoder.u_plane, vec![128]);
                assert_eq!(encoder.v_plane, vec![128]);
            }

            #[test]
            fn native_webrtc_sender_repeat_watch_is_idempotent() {
                let request = synthetic_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let keyframe_requested = Arc::new(AtomicBool::new(true));
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let sender = NativeWebRtcSender::new(
                    &request,
                    Arc::clone(&outbound_signals),
                    Arc::clone(&status),
                    Arc::clone(&keyframe_requested),
                )
                .unwrap();

                sender
                    .add_viewer("mem_viewer".to_string(), "watch_a".to_string(), false)
                    .unwrap();
                let first_offer_count =
                    drain_outbound_signal_type(&outbound_signals, "screen-share-offer");
                assert_eq!(first_offer_count, 1);

                sender
                    .add_viewer("mem_viewer".to_string(), "watch_a".to_string(), false)
                    .unwrap();
                let second_offer_count =
                    drain_outbound_signal_type(&outbound_signals, "screen-share-offer");
                assert_eq!(second_offer_count, 0);
                assert_eq!(sender.viewers.lock().unwrap().len(), 1);

                sender
                    .add_viewer("mem_viewer".to_string(), "watch_b".to_string(), false)
                    .unwrap();
                let replacement_offer_count =
                    drain_outbound_signal_type(&outbound_signals, "screen-share-offer");
                assert_eq!(replacement_offer_count, 1);
                assert_eq!(
                    sender
                        .viewers
                        .lock()
                        .unwrap()
                        .get("mem_viewer")
                        .unwrap()
                        .watch_session_id,
                    "watch_b"
                );
                assert!(!sender.remove_viewer("mem_viewer", "watch_a"));
                assert_eq!(
                    sender
                        .viewers
                        .lock()
                        .unwrap()
                        .get("mem_viewer")
                        .unwrap()
                        .watch_session_id,
                    "watch_b"
                );
                assert!(sender.remove_viewer("mem_viewer", "watch_b"));
                assert!(sender.viewers.lock().unwrap().is_empty());
                sender.close_all();
            }

            #[test]
            fn native_webrtc_sender_survives_rapid_watch_stop_cycles() {
                let request = synthetic_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let sender = NativeWebRtcSender::new(
                    &request,
                    Arc::clone(&outbound_signals),
                    status,
                    Arc::new(AtomicBool::new(true)),
                )
                .unwrap();
                let started = Instant::now();

                for cycle in 0..12 {
                    let watch_session_id = format!("watch_{cycle}");
                    sender
                        .add_viewer("mem_viewer".to_string(), watch_session_id.clone(), false)
                        .unwrap();
                    assert_eq!(
                        drain_outbound_signal_type(&outbound_signals, "screen-share-offer"),
                        1
                    );
                    if cycle > 0 {
                        assert!(
                            !sender.remove_viewer("mem_viewer", &format!("watch_{}", cycle - 1))
                        );
                    }
                    assert!(sender.remove_viewer("mem_viewer", &watch_session_id));
                    assert!(sender.viewers.lock().unwrap().is_empty());
                }

                assert!(
                    started.elapsed() < Duration::from_secs(12),
                    "rapid viewer lifecycle blocked for {:?}",
                    started.elapsed()
                );
                sender.close_all();
            }

            #[test]
            fn native_webrtc_sender_ignores_stale_watch_session_signals() {
                let request = synthetic_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let sender = NativeWebRtcSender::new(
                    &request,
                    Arc::new(Mutex::new(Vec::new())),
                    Arc::clone(&status),
                    Arc::new(AtomicBool::new(true)),
                )
                .unwrap();

                sender
                    .add_viewer("mem_viewer".to_string(), "watch_current".to_string(), false)
                    .unwrap();
                sender
                    .handle_signal(
                        "mem_viewer",
                        "screen-share-answer",
                        json!({
                            "share_id": request.share_id,
                            "watch_session_id": "watch_stale",
                            "description": null,
                        }),
                        &status,
                    )
                    .unwrap();

                let snapshot = status.lock().unwrap().status_snapshot();
                assert_eq!(snapshot.applied_answer_count, 0);
                assert_eq!(snapshot.ignored_viewer_signal_count, 1);
                sender.close_all();
            }

            #[test]
            fn native_webrtc_sender_trickles_candidates_without_holding_the_offer() {
                let request = synthetic_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let keyframe_requested = Arc::new(AtomicBool::new(true));
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let sender = NativeWebRtcSender::new(
                    &request,
                    Arc::clone(&outbound_signals),
                    Arc::clone(&status),
                    Arc::clone(&keyframe_requested),
                )
                .unwrap();

                let started = Instant::now();
                sender
                    .add_viewer("mem_viewer".to_string(), "watch_test".to_string(), false)
                    .unwrap();

                // Candidates are no longer baked into the offer: they trickle as
                // their own screen-share-ice-candidate signals, which is what
                // lets the offer leave without waiting for gathering. Collect
                // both in one pass so a fast candidate is never thrown away by
                // the offer drain.
                let mut offers: Vec<RTCSessionDescription> = Vec::new();
                let mut candidates: Vec<serde_json::Value> = Vec::new();
                let mut offer_elapsed: Option<Duration> = None;
                let deadline = Instant::now() + Duration::from_secs(8);
                while Instant::now() < deadline && (offers.is_empty() || candidates.is_empty()) {
                    let drained = outbound_signals
                        .lock()
                        .map(|mut signals| signals.drain(..).collect::<Vec<_>>())
                        .unwrap_or_default();
                    for signal in drained {
                        match signal.signal_type.as_str() {
                            "screen-share-offer" => {
                                offer_elapsed = Some(started.elapsed());
                                offers.push(screen_share_signal_description(signal.data).unwrap());
                            }
                            "screen-share-ice-candidate" => {
                                if !signal.data["candidate"].is_null() {
                                    candidates.push(signal.data["candidate"].clone());
                                }
                            }
                            _ => {}
                        }
                    }
                    if offers.is_empty() || candidates.is_empty() {
                        thread::sleep(Duration::from_millis(10));
                    }
                }

                assert_eq!(offers.len(), 1);
                let elapsed = offer_elapsed.expect("native sender must push an offer");
                assert!(
                    elapsed < Duration::from_millis(200),
                    "the offer waited {elapsed:?} for ICE gathering; candidates trickle, so it must not block on them"
                );
                assert!(
                    offer_ice_ufrag(&offers[0].sdp).is_some(),
                    "the offer must carry ICE credentials even though candidates arrive separately; sdp={}",
                    offers[0].sdp
                );
                if let Ok(path) = std::env::var("EV_SCREEN_SHARE_NATIVE_OFFER_DUMP") {
                    std::fs::write(&path, &offers[0].sdp).unwrap_or_else(|err| {
                        panic!("write native screen share offer to {path}: {err}")
                    });
                }
                assert!(
                    !candidates.is_empty(),
                    "the sender must trickle its ICE candidates as separate signals"
                );
                sender.close_all();
            }

            #[test]
            fn native_webrtc_sender_restart_ice_renegotiates_with_new_credentials() {
                let request = synthetic_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let sender = NativeWebRtcSender::new(
                    &request,
                    Arc::clone(&outbound_signals),
                    Arc::clone(&status),
                    Arc::new(AtomicBool::new(true)),
                )
                .unwrap();

                sender
                    .add_viewer("mem_viewer".to_string(), "watch_restart".to_string(), false)
                    .unwrap();
                let first = drain_outbound_offer_descriptions(&outbound_signals);
                assert_eq!(first.len(), 1);
                let first_ufrag = offer_ice_ufrag(&first[0].sdp)
                    .expect("the first offer advertises an ICE ufrag");

                // A viewer whose path died asks for an ICE restart. The sender
                // keeps the encoder, the track and the watch session and only
                // renegotiates the transport, so that viewer skips a new watch
                // round trip and the wait for a fresh keyframe.
                sender
                    .handle_signal(
                        "mem_viewer",
                        "screen-share-restart-ice",
                        json!({
                            "share_id": request.share_id,
                            "watch_session_id": "watch_restart",
                        }),
                        &status,
                    )
                    .unwrap();

                let restarted = drain_outbound_offer_descriptions(&outbound_signals);
                assert_eq!(
                    restarted.len(),
                    1,
                    "an ICE restart must produce exactly one fresh offer"
                );
                let restarted_ufrag = offer_ice_ufrag(&restarted[0].sdp)
                    .expect("the restart offer advertises an ICE ufrag");
                assert_ne!(
                    first_ufrag, restarted_ufrag,
                    "an ICE restart must advertise new credentials, otherwise the viewer cannot tell it apart from the original offer"
                );
                let snapshot = status.lock().unwrap().status_snapshot();
                assert_eq!(snapshot.applied_answer_count, 0);
                assert!(
                    snapshot.last_error.is_none(),
                    "ICE restart must not record an error: {snapshot:?}"
                );
                sender.close_all();
            }

            #[test]
            fn native_webrtc_sender_offer_contains_video_and_stereo_opus_tracks() {
                let mut request = synthetic_test_request();
                request.include_audio = true;
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let sender = NativeWebRtcSender::new(
                    &request,
                    Arc::clone(&outbound_signals),
                    status,
                    Arc::new(AtomicBool::new(true)),
                )
                .unwrap();

                sender
                    .add_viewer("mem_viewer".to_string(), "watch_audio".to_string(), false)
                    .unwrap();
                let offers = drain_outbound_offer_descriptions(&outbound_signals);
                assert_eq!(offers.len(), 1);
                let sdp = &offers[0].sdp;
                assert!(sdp.contains("m=video"), "offer is missing video: {sdp}");
                assert!(sdp.contains("a=rtcp-fb:102 goog-remb"));
                assert!(sdp.contains(webrtc::sdp::extmap::ABS_SEND_TIME_URI));
                assert!(!sdp.contains("transport-cc"));
                assert!(!sdp.contains("VP8/") && !sdp.contains("VP9/"));
                assert!(sdp.contains("m=audio"), "offer is missing audio: {sdp}");
                assert!(
                    sdp.to_ascii_lowercase().contains("opus/48000/2"),
                    "offer is missing stereo Opus: {sdp}"
                );
                sender.close_all();
            }

            #[test]
            fn synthetic_capture_runtime_produces_frames() {
                let request = synthetic_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let stop_flag = Arc::new(AtomicBool::new(false));
                let keyframe_requested = Arc::new(AtomicBool::new(true));
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let media_sender = Arc::new(
                    NativeWebRtcSender::new(
                        &request,
                        outbound_signals,
                        Arc::clone(&status),
                        Arc::clone(&keyframe_requested),
                    )
                    .unwrap(),
                );
                let runtime = run_capture(
                    &request,
                    Arc::clone(&status),
                    Arc::clone(&stop_flag),
                    media_sender,
                    keyframe_requested,
                )
                .unwrap();

                thread::sleep(Duration::from_millis(220));
                stop_flag.store(true, Ordering::SeqCst);
                drop(runtime);

                let snapshot = status.lock().unwrap().status_snapshot();
                assert!(
                    snapshot.captured_frames > 0,
                    "expected synthetic runtime to capture frames, got {snapshot:?}"
                );
                assert!(
                    snapshot.encoded_frames > 0,
                    "expected synthetic runtime to encode frames, got {snapshot:?}"
                );
                assert!(snapshot.last_error.is_none(), "{snapshot:?}");
            }

            #[test]
            fn native_webrtc_sender_refresh_reconnect_receives_synthetic_rtp() {
                let mut request = synthetic_test_request();
                request.include_audio = true;
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let keyframe_requested = Arc::new(AtomicBool::new(true));
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let sender = Arc::new(
                    NativeWebRtcSender::new(
                        &request,
                        Arc::clone(&outbound_signals),
                        Arc::clone(&status),
                        Arc::clone(&keyframe_requested),
                    )
                    .unwrap(),
                );
                let mut pipeline = FrameEncodingPipeline::start(
                    &profile,
                    &request.content_mode,
                    Arc::clone(&status),
                    Arc::clone(&keyframe_requested),
                    Arc::clone(&sender),
                )
                .unwrap();
                let pipeline_input = pipeline.input();
                sender
                    .add_viewer(
                        "mem_viewer".to_string(),
                        "watch_before_refresh".to_string(),
                        false,
                    )
                    .unwrap();
                assert_eq!(
                    drain_outbound_signal_type(&outbound_signals, "screen-share-offer"),
                    1
                );
                sender
                    .add_viewer(
                        "mem_viewer".to_string(),
                        "watch_after_refresh".to_string(),
                        false,
                    )
                    .unwrap();

                let runtime = TokioRuntimeBuilder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .unwrap();
                runtime.block_on(async {
                    let mut media_engine = MediaEngine::default();
                    media_engine.register_default_codecs().unwrap();
                    let registry =
                        register_default_interceptors(Registry::new(), &mut media_engine).unwrap();
                    let api = APIBuilder::new()
                        .with_media_engine(media_engine)
                        .with_interceptor_registry(registry)
                        .build();
                    let receiver = api
                        .new_peer_connection(RTCConfiguration::default())
                        .await
                        .unwrap();

                    let (packet_tx, mut packet_rx) =
                        tokio::sync::mpsc::channel::<(RTPCodecType, usize)>(4);
                    receiver.on_track(Box::new(move |track, _, _| {
                        let packet_tx = packet_tx.clone();
                        Box::pin(async move {
                            if let Ok((packet, _)) = track.read_rtp().await {
                                let _ = packet_tx.send((track.kind(), packet.payload.len())).await;
                            }
                        })
                    }));

                    let candidate_sender = Arc::clone(&sender);
                    let candidate_status = Arc::clone(&status);
                    receiver.on_ice_candidate(Box::new(move |candidate| {
                        let candidate_sender = Arc::clone(&candidate_sender);
                        let candidate_status = Arc::clone(&candidate_status);
                        Box::pin(async move {
                            let Some(candidate) = candidate else {
                                return;
                            };
                            if let Ok(candidate) = candidate.to_json() {
                                let _ = tokio::task::spawn_blocking(move || {
                                    candidate_sender.handle_signal(
                                        "mem_viewer",
                                        "screen-share-ice-candidate",
                                        json!({
                                            "share_id": "share_test",
                                            "watch_session_id": "watch_after_refresh",
                                            "candidate": candidate,
                                        }),
                                        &candidate_status,
                                    )
                                })
                                .await;
                            }
                        })
                    }));

                    let offer = wait_for_native_sender_offer(&outbound_signals).await;
                    receiver.set_remote_description(offer).await.unwrap();
                    apply_native_sender_candidates(&outbound_signals, &receiver).await;

                    let answer = receiver.create_answer(None).await.unwrap();
                    receiver
                        .set_local_description(answer.clone())
                        .await
                        .unwrap();
                    let stale_answer_sender = Arc::clone(&sender);
                    let stale_answer_status = Arc::clone(&status);
                    let stale_answer = answer.clone();
                    tokio::task::spawn_blocking(move || {
                        stale_answer_sender.handle_signal(
                            "mem_viewer",
                            "screen-share-answer",
                            json!({
                                "share_id": "share_test",
                                "watch_session_id": "watch_before_refresh",
                                "description": stale_answer,
                            }),
                            &stale_answer_status,
                        )
                    })
                    .await
                    .unwrap()
                    .unwrap();
                    let answer_sender = Arc::clone(&sender);
                    let answer_status = Arc::clone(&status);
                    tokio::task::spawn_blocking(move || {
                        answer_sender.handle_signal(
                            "mem_viewer",
                            "screen-share-answer",
                            json!({
                                "share_id": "share_test",
                                "watch_session_id": "watch_after_refresh",
                                "description": answer,
                            }),
                            &answer_status,
                        )
                    })
                    .await
                    .unwrap()
                    .unwrap();

                    let mut audio_encoder = OpusEncoder::new_audio(
                        SCREEN_SHARE_AUDIO_SAMPLE_RATE,
                        SCREEN_SHARE_AUDIO_CHANNELS,
                        SCREEN_SHARE_AUDIO_BITRATE,
                        10,
                        true,
                        true,
                        5,
                    )
                    .unwrap();
                    let audio_frame =
                        vec![0.02_f32; SCREEN_SHARE_AUDIO_FRAME_SAMPLES * SCREEN_SHARE_AUDIO_CHANNELS];
                    let mut encoded_audio = vec![0_u8; 4096];
                    let encoded_audio_len = audio_encoder
                        .encode_float(
                            &audio_frame,
                            SCREEN_SHARE_AUDIO_FRAME_SAMPLES,
                            &mut encoded_audio,
                        )
                        .unwrap();
                    let encoded_audio = encoded_audio[..encoded_audio_len].to_vec();
                    let deadline = std::time::Instant::now() + Duration::from_secs(5);
                    let mut frame_index = 0_u64;
                    let mut received_video_payload_len = 0_usize;
                    let mut received_audio_payload_len = 0_usize;
                    loop {
                        apply_native_sender_candidates(&outbound_signals, &receiver).await;
                        let frame = synthetic_bgra_frame(320, 180, frame_index);
                        pipeline_input.submit(frame, Some(frame_index.saturating_mul(33_333_333)));
                        sender.write_opus_sample(encoded_audio.clone(), frame_index * SCREEN_SHARE_AUDIO_FRAME_SAMPLES as u64);
                        frame_index = frame_index.saturating_add(1);

                        match tokio::time::timeout(Duration::from_millis(35), packet_rx.recv())
                            .await
                        {
                            Ok(Some((RTPCodecType::Video, payload_len))) => {
                                received_video_payload_len = payload_len;
                            }
                            Ok(Some((RTPCodecType::Audio, payload_len))) => {
                                received_audio_payload_len = payload_len;
                            }
                            _ if std::time::Instant::now() >= deadline => {
                                panic!(
                                    "native sender loopback did not receive video and audio RTP; video={received_video_payload_len} audio={received_audio_payload_len} status={:?}",
                                    status.lock().unwrap().status_snapshot()
                                );
                            }
                            _ => {}
                        }
                        if received_video_payload_len > 0 && received_audio_payload_len > 0 {
                            break;
                        }
                    }

                    assert!(received_video_payload_len > 0);
                    assert!(received_audio_payload_len > 0);
                    let snapshot = status.lock().unwrap().status_snapshot();
                    assert!(snapshot.captured_frames > 0, "{snapshot:?}");
                    assert!(snapshot.encoded_frames > 0, "{snapshot:?}");
                    assert!(snapshot.applied_answer_count > 0, "{snapshot:?}");
                    // Media can start flowing on the answer's own candidates, so
                    // the loop above may break before a single trickled candidate
                    // has been applied. Wait for the trickle instead of racing it.
                    let candidate_deadline = std::time::Instant::now() + Duration::from_secs(3);
                    while status
                        .lock()
                        .unwrap()
                        .status_snapshot()
                        .applied_ice_candidate_count
                        == 0
                        && std::time::Instant::now() < candidate_deadline
                    {
                        apply_native_sender_candidates(&outbound_signals, &receiver).await;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    let snapshot = status.lock().unwrap().status_snapshot();
                    assert!(snapshot.applied_ice_candidate_count > 0, "{snapshot:?}");
                    assert!(snapshot.ignored_viewer_signal_count > 0, "{snapshot:?}");
                    assert!(snapshot.sample_write_count > 0, "{snapshot:?}");
                    assert_eq!(snapshot.sample_write_error_count, 0, "{snapshot:?}");
                    assert!(snapshot.last_error.is_none(), "{snapshot:?}");
                    let _ = receiver.close().await;
                });
                pipeline.stop();
                sender.close_all();
            }

            #[test]
            fn local_quality_commands_acknowledge_only_supported_values() {
                use crate::NativeScreenShareQualitySetting::{FrameRate, MaxBitrate};
                let request = synthetic_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let sender = Arc::new(
                    NativeWebRtcSender::new(
                        &request,
                        Arc::default(),
                        Arc::clone(&status),
                        Arc::default(),
                    )
                    .unwrap(),
                );
                let apply = |setting| {
                    let (completed, ack) = tokio::sync::oneshot::channel();
                    handle_native_screen_share_control(
                        &sender,
                        &status,
                        NativeScreenShareControl::SetQuality { setting, completed },
                    )
                    .unwrap();
                    ack.blocking_recv().unwrap()
                };
                apply(FrameRate(15)).unwrap();
                assert_eq!(sender.target_frame_rate().load(Ordering::Acquire), 15);
                apply(FrameRate(30)).unwrap();
                for invalid in [0, 60, 121] {
                    assert!(apply(FrameRate(invalid)).is_err());
                }
                assert_eq!(sender.target_frame_rate().load(Ordering::Acquire), 30);
                apply(MaxBitrate(2_000_000)).unwrap();
                for invalid in [0, 80_000_000, 80_000_001] {
                    assert!(apply(MaxBitrate(invalid)).is_err());
                }
                assert_eq!(status.lock().unwrap().target_bitrate_bps, 2_000_000);
                // The viewer signal route stays closed to local publisher settings.
                let manager = crate::NativeScreenShareManager::default();
                for signal_type in ["screen-share-max-bitrate", "screen-share-frame-rate"] {
                    let signal = crate::NativeScreenShareSignalRequest {
                        session_id: "local".into(),
                        member_id: "mem_viewer".into(),
                        signal_type: signal_type.into(),
                        data: json!({"frame_rate": 60}),
                    };
                    assert!(manager
                        .handle_viewer_signal(&signal)
                        .unwrap_err()
                        .contains("unsupported"));
                }
            }

            #[test]
            fn native_webrtc_sender_feeds_two_viewers_at_once() {
                use openh264::decoder::Decoder;
                use openh264::formats::YUVSource;
                use webrtc::rtp::codecs::h264::H264Packet;
                use webrtc::rtp::packetizer::Depacketizer;
                let request = synthetic_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let keyframe_requested = Arc::new(AtomicBool::new(true));
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let sender = Arc::new(
                    NativeWebRtcSender::new(
                        &request,
                        Arc::clone(&outbound_signals),
                        Arc::clone(&status),
                        Arc::clone(&keyframe_requested),
                    )
                    .unwrap(),
                );
                let mut pipeline = FrameEncodingPipeline::start(
                    &profile,
                    &request.content_mode,
                    Arc::clone(&status),
                    Arc::clone(&keyframe_requested),
                    Arc::clone(&sender),
                )
                .unwrap();
                let pipeline_input = pipeline.input();

                sender
                    .add_viewer("mem_a".to_string(), "watch_a".to_string(), false)
                    .unwrap();
                sender
                    .add_viewer("mem_b".to_string(), "watch_b".to_string(), false)
                    .unwrap();

                let runtime = TokioRuntimeBuilder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .unwrap();
                runtime.block_on(async {
                    let offers = wait_for_native_sender_offers(&outbound_signals, 2).await;
                    assert_eq!(offers.len(), 2, "each viewer needs its own offer");
                    assert_ne!(
                        offers[0].2.sdp, offers[1].2.sdp,
                        "two viewers must not share one offer"
                    );

                    let mut receivers: std::collections::HashMap<String, Arc<RTCPeerConnection>> =
                        std::collections::HashMap::new();
                    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::channel(64);

                    for (member_id, watch_session_id, offer) in offers {
                        let expected_profile = if member_id == "mem_a" { "640c1f" } else { "42e01f" };
                        let receiver = Arc::new(new_test_receiver(expected_profile).await);
                        let receiver_weak = Arc::downgrade(&receiver);
                        let track_tx = frame_tx.clone();
                        let track_member = member_id.clone();
                        receiver.on_track(Box::new(move |track, _, _| {
                            let track_tx = track_tx.clone();
                            let track_member = track_member.clone();
                            let pc = receiver_weak.clone();
                            Box::pin(async move {
                                if track.kind() != RTPCodecType::Video {
                                    return;
                                }
                                let mut decoder = Decoder::new().unwrap();
                                let mut depacketizer = H264Packet::default();
                                let mut frame = Vec::new();
                                let mut sps = None;
                                let mut last_pli = None;
                                while let Ok((packet, _)) = track.read_rtp().await {
                                    frame.extend_from_slice(&depacketizer.depacketize(&packet.payload).unwrap());
                                    if !packet.header.marker { continue; }
                                    if let Some(id) = h264_annexb_sps_profile_level_id(&frame) { sps = Some(id); }
                                    if sps.is_none() {
                                        frame.clear();
                                        if last_pli.is_none_or(|at: Instant| at.elapsed() >= Duration::from_millis(300)) {
                                            let Some(pc) = pc.upgrade() else { break };
                                            let _ = pc.write_rtcp(&[Box::new(PictureLossIndication {
                                                sender_ssrc: 0, media_ssrc: track.ssrc(),
                                            })]).await;
                                            last_pli = Some(Instant::now());
                                        }
                                        continue;
                                    }
                                    let dimensions = decoder.decode(&frame).unwrap().map(|image| image.dimensions());
                                    frame.clear();
                                    if let Some(dimensions) = dimensions {
                                        if track_tx.send((track_member.clone(), packet.header.payload_type, sps.clone(), dimensions, packet.header.timestamp)).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            })
                        }));

                        let candidate_sender = Arc::clone(&sender);
                        let candidate_status = Arc::clone(&status);
                        let candidate_member = member_id.clone();
                        let candidate_watch = watch_session_id.clone();
                        receiver.on_ice_candidate(Box::new(move |candidate| {
                            let candidate_sender = Arc::clone(&candidate_sender);
                            let candidate_status = Arc::clone(&candidate_status);
                            let candidate_member = candidate_member.clone();
                            let candidate_watch = candidate_watch.clone();
                            Box::pin(async move {
                                let Some(candidate) = candidate else {
                                    return;
                                };
                                if let Ok(candidate) = candidate.to_json() {
                                    let _ = tokio::task::spawn_blocking(move || {
                                        candidate_sender.handle_signal(
                                            &candidate_member,
                                            "screen-share-ice-candidate",
                                            json!({
                                                "share_id": "share_test",
                                                "watch_session_id": candidate_watch,
                                                "candidate": candidate,
                                            }),
                                            &candidate_status,
                                        )
                                    })
                                    .await;
                                }
                            })
                        }));

                        receiver.set_remote_description(offer).await.unwrap();
                        apply_native_sender_candidates_for(
                            &outbound_signals,
                            &member_id,
                            &receiver,
                        )
                        .await;

                        let answer = receiver.create_answer(None).await.unwrap();
                        receiver
                            .set_local_description(answer.clone())
                            .await
                            .unwrap();
                        let answer_sender = Arc::clone(&sender);
                        let answer_status = Arc::clone(&status);
                        let answer_member = member_id.clone();
                        tokio::task::spawn_blocking(move || {
                            answer_sender.handle_signal(
                                &answer_member,
                                "screen-share-answer",
                                json!({
                                    "share_id": "share_test",
                                    "watch_session_id": watch_session_id,
                                    "description": answer,
                                }),
                                &answer_status,
                            )
                        })
                        .await
                        .unwrap()
                        .unwrap();

                        receivers.insert(member_id, receiver);
                    }

                    let deadline = std::time::Instant::now() + Duration::from_secs(8);
                    let mut decoded = [0u32; 2];
                    let mut timestamps = [None; 2];
                    let mut frame_index = 0_u64;
                    while std::time::Instant::now() < deadline && decoded.iter().any(|count| *count < 5) {
                        for (member_id, receiver) in receivers.iter() {
                            apply_native_sender_candidates_for(
                                &outbound_signals,
                                member_id,
                                receiver,
                            )
                            .await;
                        }
                        let frame = synthetic_bgra_frame(320, 180, frame_index);
                        pipeline_input.submit(frame, Some(frame_index.saturating_mul(33_333_333)));
                        frame_index = frame_index.saturating_add(1);

                        while let Ok((id, pt, sps, dimensions, timestamp)) = frame_rx.try_recv() {
                            let index = usize::from(id == "mem_b");
                            assert_eq!(pt, [102, 103][index]);
                            let sps = sps.expect("on-wire H264 SPS");
                            assert!(crate::screen_share_rtp::same_h264_subprofile(&sps, ["640c1f", "42e01f"][index]), "{id}: {sps}");
                            assert_eq!(dimensions, (320, 180));
                            if let Some(last) = timestamps[index] {
                                assert!(timestamp.wrapping_sub(last) > 0 && timestamp.wrapping_sub(last) < 90_000);
                            }
                            timestamps[index] = Some(timestamp);
                            decoded[index] += 1;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }

                    assert!(decoded.iter().all(|count| *count >= 5), "two independent decoders: {decoded:?}, {:?}", status.lock().unwrap().status_snapshot());

                    let snapshot = status.lock().unwrap().status_snapshot();
                    assert!(snapshot.encoded_frames > 0, "{snapshot:?}");
                    assert!(snapshot.applied_answer_count >= 2, "{snapshot:?}");
                    assert_eq!(snapshot.viewer_layers["mem_a"], "high");
                    assert_eq!(snapshot.viewer_layers["mem_b"], "compatibility");
                    assert_eq!(snapshot.dropped_frames, 0, "{snapshot:?}");
                    assert_eq!(snapshot.sample_write_error_count, 0, "{snapshot:?}");
                    assert!(snapshot.last_error.is_none(), "{snapshot:?}");
                    assert_eq!(
                        snapshot.viewer_paths.len(),
                        2,
                        "both viewers should have a recorded path: {snapshot:?}"
                    );

                    assert!(sender.remove_viewer("mem_b", "watch_b"));
                    receivers.remove("mem_b").unwrap().close().await.unwrap();
                    assert!(sender.compatibility_target_bitrate_bps().is_none());
                    while frame_rx.try_recv().is_ok() {}
                    let mut survivor_frames = 0;
                    let deadline = std::time::Instant::now() + Duration::from_secs(3);
                    while std::time::Instant::now() < deadline && survivor_frames < 10 {
                        pipeline_input.submit(synthetic_bgra_frame(320, 180, frame_index), Some(frame_index * 33_333_333));
                        frame_index += 1;
                        tokio::time::sleep(Duration::from_millis(34)).await;
                        while let Ok((id, pt, _, dimensions, timestamp)) = frame_rx.try_recv() {
                            assert_eq!(id, "mem_a");
                            assert_eq!((pt, dimensions), (102, (320, 180)));
                            let delta = timestamp.wrapping_sub(timestamps[0].unwrap());
                            assert!(delta > 0 && delta < 90_000);
                            timestamps[0] = Some(timestamp);
                            survivor_frames += 1;
                        }
                    }
                    assert!(survivor_frames >= 10, "surviving High viewer decoded {survivor_frames} frames");
                    eprintln!("decoded High {} and CBP {} frames at 320x180, then {} more High frames after CBP disconnected", decoded[0], decoded[1], survivor_frames);
                    for (_, receiver) in receivers {
                        let _ = receiver.close().await;
                    }
                });
                pipeline.stop();
                sender.close_all();
            }

            #[test]
            fn native_webrtc_sender_browser_media_harness() {
                let offer_path = match std::env::var("EV_SCREEN_SHARE_BROWSER_OFFER_PATH") {
                    Ok(path) => path,
                    Err(_) => return,
                };
                init_webrtc_test_logger();
                let answer_path = std::env::var("EV_SCREEN_SHARE_BROWSER_ANSWER_PATH")
                    .expect("browser answer path is required for the media harness");
                let stop_path = std::env::var("EV_SCREEN_SHARE_BROWSER_STOP_PATH")
                    .expect("browser stop path is required for the media harness");
                let result_path = std::env::var("EV_SCREEN_SHARE_BROWSER_RESULT_PATH")
                    .expect("browser result path is required for the media harness");

                let request = browser_test_request();
                let profile = native_screen_share_video_profile(&request).unwrap();
                let status = synthetic_test_status(&request, &profile);
                let keyframe_requested = Arc::new(AtomicBool::new(true));
                let outbound_signals = Arc::new(Mutex::new(Vec::new()));
                let sender = Arc::new(
                    NativeWebRtcSender::new(
                        &request,
                        Arc::clone(&outbound_signals),
                        Arc::clone(&status),
                        Arc::clone(&keyframe_requested),
                    )
                    .unwrap(),
                );
                let stop_flag = Arc::new(AtomicBool::new(false));
                let capture_runtime = run_capture(
                    &request,
                    Arc::clone(&status),
                    Arc::clone(&stop_flag),
                    Arc::clone(&sender),
                    Arc::clone(&keyframe_requested),
                )
                .unwrap();
                let viewer_delay_ms = std::env::var("EV_SCREEN_SHARE_BROWSER_VIEWER_DELAY_MS")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or_default();
                let measure_sync = std::env::var("EV_BENCH_SYNC").as_deref() == Ok("1");
                let audio_runtime = if measure_sync {
                    assert_eq!(
                        request.source_kind, "window",
                        "sync measurement requires a specific process window"
                    );
                    assert!(request.source_process_id.is_some() && request.include_audio);
                    start_native_screen_share_audio(
                        &request,
                        Arc::clone(&status),
                        Arc::clone(&stop_flag),
                        Arc::clone(&sender),
                    )
                    .unwrap()
                } else {
                    None
                };
                thread::sleep(Duration::from_millis(viewer_delay_ms));
                sender
                    .add_viewer(
                        "mem_browser".to_string(),
                        "watch_browser".to_string(),
                        false,
                    )
                    .unwrap();
                let offer_bundle = drain_outbound_offer_bundle(&outbound_signals);
                std::fs::write(&offer_path, serde_json::to_vec(&offer_bundle).unwrap())
                    .unwrap_or_else(|err| {
                        panic!("write browser harness offer to {offer_path}: {err}")
                    });

                let answer_deadline = std::time::Instant::now() + Duration::from_secs(30);
                let answer = loop {
                    if let Ok(raw) = std::fs::read_to_string(&answer_path) {
                        if let Ok(answer) = serde_json::from_str::<serde_json::Value>(&raw) {
                            break answer;
                        }
                    }
                    if std::time::Instant::now() >= answer_deadline {
                        panic!("browser media harness did not provide an answer");
                    }
                    thread::sleep(Duration::from_millis(20));
                };
                sender
                    .handle_signal(
                        "mem_browser",
                        "screen-share-answer",
                        json!({
                            "share_id": request.share_id,
                            "watch_session_id": "watch_browser",
                            "description": answer,
                        }),
                        &status,
                    )
                    .unwrap();

                let candidates_path = std::env::var("EV_SCREEN_SHARE_BROWSER_CANDIDATES_PATH")
                    .expect("browser candidate path is required for the media harness");
                let candidate_deadline = std::time::Instant::now() + Duration::from_secs(15);
                let candidates: Vec<serde_json::Value> = loop {
                    if let Ok(raw) = std::fs::read_to_string(&candidates_path) {
                        if let Ok(parsed) = serde_json::from_str(&raw) {
                            break parsed;
                        }
                    }
                    if std::time::Instant::now() >= candidate_deadline {
                        panic!("browser media harness did not provide ICE candidates");
                    }
                    thread::sleep(Duration::from_millis(20));
                };
                for candidate in candidates {
                    sender
                        .handle_signal(
                            "mem_browser",
                            "screen-share-ice-candidate",
                            json!({
                                "share_id": request.share_id,
                                "watch_session_id": "watch_browser",
                                "candidate": candidate,
                            }),
                            &status,
                        )
                        .unwrap();
                }

                let observation_start = std::time::Instant::now();
                let timeout = std::env::var("EV_BENCH_SECONDS")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(10)
                    .clamp(2, 600);
                let stream_deadline = observation_start + Duration::from_secs(timeout + 15);
                let mut next_sample = 0;
                let mut native_trace = Vec::new();
                let trace_enabled = std::env::var("EV_BENCH_TRACE").as_deref() == Ok("1");
                let mut last_trace = observation_start;
                let sample_phases = std::env::var("EV_BENCH_NATIVE_WINDOW").as_deref() == Ok("1");
                while std::time::Instant::now() < stream_deadline {
                    if trace_enabled && last_trace.elapsed() >= Duration::from_secs(1) {
                        if let Ok(s) = status.lock() {
                            native_trace.push(json!({
                                "wallMs": now_ms(), "wgc": s.pipeline.wgc_frames_received,
                                "captured": s.captured_frames, "encoded": s.encoded_frames,
                                "writes": s.sample_write_count, "viewerDrops": s.viewer_backpressure_drops,
                                "encoderDrops": s.encoder_backpressure_drops
                            }));
                        }
                        last_trace = std::time::Instant::now();
                    }
                    if sample_phases
                        && next_sample < 2
                        && std::path::Path::new(&format!("{stop_path}.{next_sample}.request"))
                            .exists()
                    {
                        use windows::Win32::Foundation::FILETIME;
                        use windows::Win32::System::Threading::{
                            GetCurrentProcess, GetProcessTimes,
                        };
                        let mut times = [FILETIME::default(); 4];
                        let [create, end, kernel, user] = &mut times;
                        let read_times = unsafe {
                            GetProcessTimes(GetCurrentProcess(), create, end, kernel, user)
                        };
                        let ticks = |t: &FILETIME| {
                            (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)
                        };
                        let cpu_ms = read_times
                            .ok()
                            .map(|()| (ticks(kernel) + ticks(user)) as f64 / 10_000.0);
                        let s = status.lock().unwrap().status_snapshot();
                        let sample = json!({
                            "elapsedMs": observation_start.elapsed().as_secs_f64() * 1000.0,
                            "processCpuMs": cpu_ms, "captured": s.captured_frames,
                            "forwarded": s.forwarded_frames, "encoded": s.encoded_frames,
                            "writes": s.sample_write_count, "encoderDrops": s.encoder_backpressure_drops,
                            "viewerDrops": s.viewer_backpressure_drops, "pipeline": s.pipeline,
                            "effectiveBps": s.effective_bitrate_bps
                        });
                        std::fs::write(
                            format!("{stop_path}.{next_sample}.json"),
                            serde_json::to_vec(&sample).unwrap(),
                        )
                        .unwrap();
                        next_sample += 1;
                    }
                    if std::path::Path::new(&stop_path).exists() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(20));
                }

                // A bitrate change has to reach the running encoder without a new
                // session: the viewer keeps its connection, only the ceiling moves.
                let live = status.lock().unwrap().status_snapshot();
                if live.encoded_frames > 0 {
                    let (completed, ack) = tokio::sync::oneshot::channel();
                    handle_native_screen_share_control(
                        &sender,
                        &status,
                        NativeScreenShareControl::SetQuality {
                            setting: crate::NativeScreenShareQualitySetting::MaxBitrate(2_000_000),
                            completed,
                        },
                    )
                    .unwrap();
                    ack.blocking_recv().unwrap().unwrap();
                    let lowered = status.lock().unwrap().status_snapshot();
                    assert_eq!(lowered.target_bitrate_bps, 2_000_000, "{lowered:?}");
                    assert!(
                        lowered.effective_bitrate_bps <= 2_000_000,
                        "a lowered ceiling must be obeyed immediately: {lowered:?}"
                    );
                    let frames_before = lowered.encoded_frames;
                    let advance_deadline = std::time::Instant::now() + Duration::from_secs(3);
                    while std::time::Instant::now() < advance_deadline
                        && status.lock().unwrap().encoded_frames <= frames_before
                    {
                        thread::sleep(Duration::from_millis(20));
                    }
                    let after = status.lock().unwrap().status_snapshot();
                    assert!(
                        after.encoded_frames > frames_before,
                        "the same session must keep encoding after a bitrate change: {after:?}"
                    );
                }

                stop_flag.store(true, Ordering::SeqCst);
                drop(audio_runtime);
                drop(capture_runtime);
                let snapshot = status.lock().unwrap().status_snapshot();
                let mut harness_result = serde_json::to_value(&snapshot).unwrap();
                if trace_enabled {
                    harness_result["trace"] = json!(native_trace);
                }
                harness_result["encodedProfileLevelId"] =
                    json!(sender.observed_sps.borrow().clone());
                harness_result["encodedCompatibilityProfileLevelId"] =
                    json!(sender.observed_compatibility_sps.lock().unwrap().clone());
                std::fs::write(
                    &result_path,
                    serde_json::to_vec_pretty(&harness_result).unwrap(),
                )
                .unwrap_or_else(|err| {
                    panic!("write browser harness result to {result_path}: {err}")
                });
                assert!(snapshot.applied_answer_count > 0, "{snapshot:?}");
                if measure_sync {
                    assert!(snapshot.audio_samples_sent > 0, "no captured audio sent");
                    assert_eq!(snapshot.audio_capture_errors, 0);
                    assert_eq!(snapshot.audio_send_errors, 0);
                }
                // The answer no longer carries candidates, so this only stays
                // true if the trickled signals actually reached the connection.
                assert!(snapshot.applied_ice_candidate_count > 0, "{snapshot:?}");
                assert!(snapshot.sample_write_count > 0, "{snapshot:?}");
                assert_eq!(snapshot.sample_write_error_count, 0, "{snapshot:?}");
                sender.close_all();
            }

            fn wait_for_pipeline_status(
                status: &Arc<Mutex<NativeScreenShareRuntimeStatus>>,
                minimum_encoded_frames: u64,
                require_preview: bool,
            ) {
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    let ready = status
                        .lock()
                        .map(|status| {
                            status.encoded_frames >= minimum_encoded_frames
                                && (!require_preview || status.preview_data_url.is_some())
                        })
                        .unwrap_or(false);
                    if ready {
                        return;
                    }
                    if Instant::now() >= deadline {
                        panic!(
                            "native screen share pipeline did not become ready: {:?}",
                            status.lock().unwrap().status_snapshot()
                        );
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }

            async fn apply_native_sender_candidates_for(
                outbound_signals: &Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
                member_id: &str,
                receiver: &RTCPeerConnection,
            ) {
                let candidates = take_native_sender_candidates_by_member(outbound_signals);
                for candidate in candidates.get(member_id).into_iter().flatten() {
                    receiver.add_ice_candidate(candidate.clone()).await.unwrap();
                }
            }

            fn take_native_sender_candidates_by_member(
                outbound_signals: &Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
            ) -> std::collections::HashMap<String, Vec<RTCIceCandidateInit>> {
                let mut grouped: std::collections::HashMap<String, Vec<RTCIceCandidateInit>> =
                    std::collections::HashMap::new();
                let signals = outbound_signals
                    .lock()
                    .map(|mut signals| signals.drain(..).collect::<Vec<_>>())
                    .unwrap_or_default();
                for signal in signals {
                    if signal.signal_type != "screen-share-ice-candidate" {
                        continue;
                    }
                    if let Some(candidate) = screen_share_signal_candidate(signal.data).unwrap() {
                        grouped.entry(signal.member_id).or_default().push(candidate);
                    }
                }
                grouped
            }

            async fn wait_for_native_sender_offers(
                outbound_signals: &Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
                expected: usize,
            ) -> Vec<(String, String, RTCSessionDescription)> {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let mut offers = Vec::new();
                while std::time::Instant::now() < deadline && offers.len() < expected {
                    let signals = outbound_signals
                        .lock()
                        .map(|mut signals| signals.drain(..).collect::<Vec<_>>())
                        .unwrap_or_default();
                    for signal in signals {
                        if signal.signal_type != "screen-share-offer" {
                            continue;
                        }
                        let watch_session_id = signal
                            .data
                            .get("watch_session_id")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let description = screen_share_signal_description(signal.data).unwrap();
                        offers.push((signal.member_id, watch_session_id, description));
                    }
                    if offers.len() >= expected {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                offers
            }

            async fn new_test_receiver(profile: &str) -> RTCPeerConnection {
                let mut media_engine = MediaEngine::default();
                media_engine
                    .register_codec(
                        RTCRtpCodecParameters {
                            capability: RTCRtpCodecCapability {
                                mime_type: MIME_TYPE_H264.into(),
                                clock_rate: 90_000,
                                sdp_fmtp_line: h264_fmtp_for_profile_id(profile),
                                ..Default::default()
                            },
                            payload_type: 102,
                            ..Default::default()
                        },
                        RTPCodecType::Video,
                    )
                    .unwrap();
                let registry =
                    register_default_interceptors(Registry::new(), &mut media_engine).unwrap();
                APIBuilder::new()
                    .with_media_engine(media_engine)
                    .with_interceptor_registry(registry)
                    .build()
                    .new_peer_connection(RTCConfiguration::default())
                    .await
                    .unwrap()
            }

            async fn wait_for_native_sender_offer(
                outbound_signals: &Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
            ) -> RTCSessionDescription {
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                loop {
                    let signals = outbound_signals
                        .lock()
                        .map(|mut signals| signals.drain(..).collect::<Vec<_>>())
                        .unwrap_or_default();
                    for signal in signals {
                        if signal.signal_type == "screen-share-offer" {
                            return screen_share_signal_description(signal.data).unwrap();
                        }
                    }
                    if std::time::Instant::now() >= deadline {
                        panic!("native sender did not generate an offer");
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }

            async fn apply_native_sender_candidates(
                outbound_signals: &Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
                receiver: &RTCPeerConnection,
            ) {
                let signals = outbound_signals
                    .lock()
                    .map(|mut signals| signals.drain(..).collect::<Vec<_>>())
                    .unwrap_or_default();
                for signal in signals {
                    if signal.signal_type != "screen-share-ice-candidate" {
                        continue;
                    }
                    if let Some(candidate) = screen_share_signal_candidate(signal.data).unwrap() {
                        receiver.add_ice_candidate(candidate).await.unwrap();
                    }
                }
            }

            fn offer_ice_ufrag(sdp: &str) -> Option<String> {
                sdp.lines()
                    .find_map(|line| line.trim().strip_prefix("a=ice-ufrag:"))
                    .map(str::to_string)
            }

            fn drain_outbound_signal_type(
                outbound_signals: &Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
                signal_type: &str,
            ) -> usize {
                outbound_signals
                    .lock()
                    .map(|mut signals| {
                        let drained = signals.drain(..).collect::<Vec<_>>();
                        drained
                            .into_iter()
                            .filter(|signal| signal.signal_type == signal_type)
                            .count()
                    })
                    .unwrap_or_default()
            }

            fn drain_outbound_offer_descriptions(
                outbound_signals: &Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
            ) -> Vec<RTCSessionDescription> {
                outbound_signals
                    .lock()
                    .map(|mut signals| {
                        signals
                            .drain(..)
                            .filter(|signal| signal.signal_type == "screen-share-offer")
                            .map(|signal| screen_share_signal_description(signal.data).unwrap())
                            .collect()
                    })
                    .unwrap_or_default()
            }

            fn drain_outbound_offer_bundle(
                outbound_signals: &Arc<Mutex<Vec<NativeScreenShareOutboundSignal>>>,
            ) -> serde_json::Value {
                let deadline = Instant::now() + Duration::from_secs(8);
                let mut description = None;
                let mut candidates = Vec::new();
                let mut gathering_complete = false;
                while Instant::now() < deadline && (!gathering_complete || description.is_none()) {
                    let signals = outbound_signals
                        .lock()
                        .map(|mut signals| signals.drain(..).collect::<Vec<_>>())
                        .unwrap_or_default();
                    for signal in signals {
                        match signal.signal_type.as_str() {
                            "screen-share-offer" => {
                                description =
                                    Some(screen_share_signal_description(signal.data).unwrap());
                            }
                            "screen-share-ice-candidate" => {
                                let candidate = signal
                                    .data
                                    .get("candidate")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                if candidate.is_null() {
                                    gathering_complete = true;
                                } else {
                                    candidates.push(candidate);
                                }
                            }
                            _ => {}
                        }
                    }
                    if !gathering_complete || description.is_none() {
                        thread::sleep(Duration::from_millis(20));
                    }
                }
                json!({
                    "description": description.expect("native sender did not generate an offer"),
                    "candidates": candidates,
                    "gathering_complete": gathering_complete,
                })
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    mod platform {
        use super::*;

        pub struct CaptureRuntime;

        pub fn run_capture(
            _request: &NativeScreenShareStartRequest,
            _status: Arc<Mutex<NativeScreenShareRuntimeStatus>>,
            _stop_flag: Arc<AtomicBool>,
            _media_sender: Arc<NativeWebRtcSender>,
            _keyframe_requested: Arc<AtomicBool>,
        ) -> Result<CaptureRuntime, String> {
            Err("native screen share capture is not implemented on this platform yet".to_string())
        }
    }
}

#[cfg(target_os = "windows")]
mod desktop_capture {
    use super::{
        ConfiguredHardwareProfile, DesktopCaptureSource, DesktopCaptureSources,
        DesktopMediaCapabilities,
    };
    use base64::Engine;
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::{ColorType, ImageEncoder};
    use std::mem;
    use std::os::windows::ffi::OsStringExt;
    use std::path::Path;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors,
        GetDC, GetDIBits, GetMonitorInfoW, GetWindowDC, ReleaseDC, SelectObject, SetStretchBltMode,
        StretchBlt, BITMAPINFO, BI_RGB, CAPTUREBLT, COLORONCOLOR, DIB_RGB_COLORS, HDC, HMONITOR,
        MONITORINFO, MONITORINFOEXW, SRCCOPY,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, GW_OWNER, MONITORINFOF_PRIMARY,
        PW_RENDERFULLCONTENT,
    };

    pub fn list_sources() -> Result<DesktopCaptureSources, String> {
        let mut sources = Vec::new();
        let mut warnings = Vec::new();
        if let Err(err) = enumerate_monitors(&mut sources) {
            warnings.push(err);
        }
        if let Err(err) = enumerate_windows(&mut sources) {
            warnings.push(err);
        }
        Ok(DesktopCaptureSources {
            backend: "windows-native-enumeration".to_string(),
            sources,
            warnings,
        })
    }

    pub fn media_capabilities() -> DesktopMediaCapabilities {
        let hardware_encoders =
            crate::windows_media_foundation_encoder::probe_hardware_h264_encoders();
        let mut configured_hardware_profiles = Vec::<ConfiguredHardwareProfile>::new();
        for encoder in &hardware_encoders {
            for candidate in &encoder.configured_profiles {
                if let Some(existing) = configured_hardware_profiles
                    .iter_mut()
                    .find(|p| p.width == candidate.width && p.height == candidate.height)
                {
                    existing.frame_rates.extend(&candidate.frame_rates);
                    existing.frame_rates.sort_unstable();
                    existing.frame_rates.dedup();
                } else {
                    configured_hardware_profiles.push(candidate.clone());
                }
            }
        }
        let hardware_h264_encoder = configured_hardware_profiles
            .iter()
            .any(|p| !p.frame_rates.is_empty());
        let mut supported_frame_rates = vec![15, 24, 30];
        for profile in &configured_hardware_profiles {
            supported_frame_rates.extend(&profile.frame_rates);
        }
        supported_frame_rates.sort_unstable();
        supported_frame_rates.dedup();
        let max_native_frame_rate = *supported_frame_rates.last().unwrap();
        let mut video_backends = vec![
            "windows-graphics-capture-d3d11".to_string(),
            "openh264-screen-encoder".to_string(),
            "native-webrtc-sender".to_string(),
        ];
        video_backends.extend(
            hardware_encoders
                .iter()
                .map(|encoder| format!("media-foundation-h264:{}", encoder.name)),
        );
        DesktopMediaCapabilities {
            platform: "windows".to_string(),
            runtime: "tauri".to_string(),
            source_enumeration: true,
            thumbnails: true,
            native_screen_share_sender: true,
            web_capture_fallback: false,
            supported_frame_rates,
            max_native_frame_rate,
            hardware_h264_encoder,
            configured_hardware_profiles,
            remote_control_host: true,
            remote_control_source_kinds: vec!["screen".to_string(), "window".to_string()],
            supported_source_kinds: vec!["screen".to_string(), "window".to_string()],
            video_backends,
            audio_backends: vec![
                "windows-process-loopback".to_string(),
                "opus-stereo".to_string(),
                "native-webrtc-audio-track".to_string(),
            ],
            notes: vec![
                "Desktop source enumeration and thumbnails are available.".to_string(),
                "Windows Graphics Capture reads real D3D11 frames and sends encoded H.264 through native WebRTC.".to_string(),
                "Window audio includes only the selected process tree; display audio excludes the EchoVoice process tree.".to_string(),
                "Voice capture, echo cancellation, Opus, WebRTC, mixing, and playback run in the native Rust process.".to_string(),
                "If microphone capture is unavailable, native output remains active in listen-only mode.".to_string(),
            ],
        }
    }

    fn enumerate_monitors(sources: &mut Vec<DesktopCaptureSource>) -> Result<(), String> {
        unsafe extern "system" fn monitor_proc(
            monitor: HMONITOR,
            _hdc: HDC,
            _rect: *mut RECT,
            data: LPARAM,
        ) -> BOOL {
            let sources = data.0 as *mut Vec<DesktopCaptureSource>;
            if let Some(source) = monitor_source(monitor, (*sources).len() + 1) {
                (*sources).push(source);
            }
            true.into()
        }

        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(monitor_proc),
                LPARAM(sources as *mut _ as isize),
            );
        }
        Ok(())
    }

    fn enumerate_windows(sources: &mut Vec<DesktopCaptureSource>) -> Result<(), String> {
        unsafe extern "system" fn window_proc(hwnd: HWND, data: LPARAM) -> BOOL {
            let sources = data.0 as *mut Vec<DesktopCaptureSource>;
            if let Some(source) = window_source(hwnd) {
                (*sources).push(source);
            }
            true.into()
        }

        unsafe {
            EnumWindows(Some(window_proc), LPARAM(sources as *mut _ as isize))
                .map_err(|err| format!("enumerate windows: {err}"))?;
        }
        Ok(())
    }

    fn monitor_source(monitor: HMONITOR, index: usize) -> Option<DesktopCaptureSource> {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;
        let ok = unsafe {
            GetMonitorInfoW(
                monitor,
                &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
            )
        };
        if !ok.as_bool() {
            return None;
        }
        let rect = info.monitorInfo.rcMonitor;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return None;
        }
        let device_name = wide_to_string(&info.szDevice);
        let name = if device_name.is_empty() {
            format!("Display {index}")
        } else {
            format!("Display {index} ({device_name})")
        };
        Some(DesktopCaptureSource {
            source_id: format!("screen:{index}"),
            kind: "screen".to_string(),
            name,
            app_name: None,
            process_id: None,
            x: rect.left,
            y: rect.top,
            width,
            height,
            is_primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            is_current_app: false,
            thumbnail_data_url: capture_screen_thumbnail(rect),
        })
    }

    fn window_source(hwnd: HWND) -> Option<DesktopCaptureSource> {
        if !unsafe { IsWindowVisible(hwnd).as_bool() } || unsafe { IsIconic(hwnd).as_bool() } {
            return None;
        }
        if unsafe { GetWindow(hwnd, GW_OWNER).is_ok() } {
            return None;
        }

        let title = window_title(hwnd);
        if title.trim().is_empty() {
            return None;
        }

        let mut process_id = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        }
        let current_process_id = unsafe { GetCurrentProcessId() };
        let is_current_app = process_id == current_process_id;
        if is_current_app {
            return None;
        }

        let mut rect = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut rect).is_err() } {
            return None;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width < 64 || height < 64 {
            return None;
        }

        let app_name = process_name(process_id);
        Some(DesktopCaptureSource {
            source_id: format!("window:{:x}", hwnd.0 as usize),
            kind: "window".to_string(),
            name: title,
            app_name,
            process_id: Some(process_id),
            x: rect.left,
            y: rect.top,
            width,
            height,
            is_primary: false,
            is_current_app,
            thumbnail_data_url: capture_window_thumbnail(hwnd, width, height),
        })
    }

    fn capture_screen_thumbnail(rect: RECT) -> Option<String> {
        capture_screen_region(rect, 320, 180).map(|(_, _, data_url)| data_url)
    }

    fn capture_window_thumbnail(hwnd: HWND, width: i32, height: i32) -> Option<String> {
        capture_window_print_png(hwnd, width, height, 320, 180)
            .map(|(_, _, data_url)| data_url)
            .or_else(|| {
                let window_dc = unsafe { GetWindowDC(hwnd) };
                if window_dc.is_invalid() {
                    return None;
                }
                let thumbnail = capture_dc_png(window_dc, 0, 0, width, height, 320, 180)
                    .map(|(_, _, data_url)| data_url);
                unsafe {
                    ReleaseDC(hwnd, window_dc);
                }
                thumbnail
            })
    }

    fn capture_screen_region(
        rect: RECT,
        max_width: i32,
        max_height: i32,
    ) -> Option<(i32, i32, String)> {
        let screen_dc = unsafe { GetDC(HWND(std::ptr::null_mut())) };
        if screen_dc.is_invalid() {
            return None;
        }
        let frame = capture_dc_png(
            screen_dc,
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            max_width,
            max_height,
        );
        unsafe {
            ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
        }
        frame
    }

    fn capture_window_print_png(
        hwnd: HWND,
        width: i32,
        height: i32,
        max_width: i32,
        max_height: i32,
    ) -> Option<(i32, i32, String)> {
        if width <= 0 || height <= 0 {
            return None;
        }
        let window_dc = unsafe { GetWindowDC(hwnd) };
        if window_dc.is_invalid() {
            return None;
        }
        let source_dc = unsafe { CreateCompatibleDC(window_dc) };
        if source_dc.is_invalid() {
            unsafe {
                ReleaseDC(hwnd, window_dc);
            }
            return None;
        }
        let source_bitmap = unsafe { CreateCompatibleBitmap(window_dc, width, height) };
        if source_bitmap.is_invalid() {
            unsafe {
                let _ = DeleteDC(source_dc);
                ReleaseDC(hwnd, window_dc);
            }
            return None;
        }
        let old_object = unsafe { SelectObject(source_dc, source_bitmap) };
        let printed = unsafe {
            PrintWindow(hwnd, source_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool()
                || PrintWindow(hwnd, source_dc, PRINT_WINDOW_FLAGS(0)).as_bool()
        };
        let result = if printed {
            capture_dc_png(source_dc, 0, 0, width, height, max_width, max_height)
        } else {
            None
        };
        unsafe {
            if !old_object.is_invalid() {
                SelectObject(source_dc, old_object);
            }
            let _ = DeleteObject(source_bitmap);
            let _ = DeleteDC(source_dc);
            ReleaseDC(hwnd, window_dc);
        }
        result
    }

    fn capture_dc_png(
        src_dc: HDC,
        src_x: i32,
        src_y: i32,
        src_width: i32,
        src_height: i32,
        max_width: i32,
        max_height: i32,
    ) -> Option<(i32, i32, String)> {
        if src_width <= 0 || src_height <= 0 {
            return None;
        }
        let (thumb_width, thumb_height) = scaled_size(src_width, src_height, max_width, max_height);
        let memory_dc = unsafe { CreateCompatibleDC(src_dc) };
        if memory_dc.is_invalid() {
            return None;
        }
        let bitmap = unsafe { CreateCompatibleBitmap(src_dc, thumb_width, thumb_height) };
        if bitmap.is_invalid() {
            unsafe {
                let _ = DeleteDC(memory_dc);
            }
            return None;
        }
        let old_object = unsafe { SelectObject(memory_dc, bitmap) };
        unsafe {
            let _ = SetStretchBltMode(memory_dc, COLORONCOLOR);
        }
        let copied = unsafe {
            StretchBlt(
                memory_dc,
                0,
                0,
                thumb_width,
                thumb_height,
                src_dc,
                src_x,
                src_y,
                src_width,
                src_height,
                windows::Win32::Graphics::Gdi::ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0),
            )
            .as_bool()
        };
        let result = if copied {
            bitmap_to_png_data_url(memory_dc, bitmap, thumb_width, thumb_height)
                .map(|data_url| (thumb_width, thumb_height, data_url))
        } else {
            None
        };
        unsafe {
            if !old_object.is_invalid() {
                SelectObject(memory_dc, old_object);
            }
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(memory_dc);
        }
        result
    }

    fn bitmap_to_png_data_url(
        hdc: HDC,
        bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
        width: i32,
        height: i32,
    ) -> Option<String> {
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize =
            mem::size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;
        let mut bgra = vec![0u8; (width * height * 4) as usize];
        let lines = unsafe {
            GetDIBits(
                hdc,
                bitmap,
                0,
                height as u32,
                Some(bgra.as_mut_ptr() as *mut core::ffi::c_void),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        if lines == 0 {
            return None;
        }
        let mut rgb = Vec::with_capacity((width * height * 3) as usize);
        for pixel in bgra.chunks_exact(4) {
            rgb.push(pixel[2]);
            rgb.push(pixel[1]);
            rgb.push(pixel[0]);
        }
        let mut png = Vec::new();
        let encoder =
            PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Adaptive);
        encoder
            .write_image(&rgb, width as u32, height as u32, ColorType::Rgb8.into())
            .ok()?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(png);
        Some(format!("data:image/png;base64,{encoded}"))
    }

    fn scaled_size(width: i32, height: i32, max_width: i32, max_height: i32) -> (i32, i32) {
        let max_width = max_width.clamp(1, 3840) as f64;
        let max_height = max_height.clamp(1, 2160) as f64;
        let scale = (max_width / width as f64).min(max_height / height as f64);
        (
            (width as f64 * scale).round().max(1.0) as i32,
            (height as f64 * scale).round().max(1.0) as i32,
        )
    }

    fn window_title(hwnd: HWND) -> String {
        let length = unsafe { GetWindowTextLengthW(hwnd) };
        if length <= 0 {
            return String::new();
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
            .trim()
            .to_string()
    }

    fn process_name(process_id: u32) -> Option<String> {
        let handle =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()? };
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let result = unsafe {
            QueryFullProcessImageNameW(
                handle,
                Default::default(),
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
        };
        let _ = unsafe { CloseHandle(handle) };
        if result.is_err() || length == 0 {
            return None;
        }
        let full_path = String::from_utf16_lossy(&buffer[..length as usize]);
        Path::new(&full_path)
            .file_stem()
            .map(|name| name.to_string_lossy().to_string())
            .filter(|name| !name.trim().is_empty())
    }

    fn wide_to_string(raw: &[u16]) -> String {
        let length = raw.iter().position(|ch| *ch == 0).unwrap_or(raw.len());
        std::ffi::OsString::from_wide(&raw[..length])
            .to_string_lossy()
            .trim()
            .to_string()
    }
}

#[cfg(not(target_os = "windows"))]
mod desktop_capture {
    use super::{DesktopCaptureSources, DesktopMediaCapabilities};

    pub fn list_sources() -> Result<DesktopCaptureSources, String> {
        Ok(DesktopCaptureSources {
            backend: "unsupported".to_string(),
            sources: Vec::new(),
            warnings: vec![
                "desktop capture enumeration is not implemented on this platform".to_string(),
            ],
        })
    }

    pub fn media_capabilities() -> DesktopMediaCapabilities {
        let platform = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "unknown"
        };
        let (supported_source_kinds, video_backends, audio_backends, notes) = if cfg!(
            target_os = "macos"
        ) {
            (
                vec!["screen".to_string(), "window".to_string(), "application".to_string()],
                vec!["planned:screencapturekit".to_string()],
                vec!["planned:coreaudio-loopback".to_string()],
                vec![
                    "macOS support should use ScreenCaptureKit for display/window/application capture.".to_string(),
                    "Native sender is not implemented yet.".to_string(),
                ],
            )
        } else {
            (
                Vec::new(),
                vec!["planned:platform-native-capture".to_string()],
                vec!["planned:platform-native-audio".to_string()],
                vec!["Native capture is not implemented on this platform yet.".to_string()],
            )
        };
        DesktopMediaCapabilities {
            platform: platform.to_string(),
            runtime: "tauri".to_string(),
            source_enumeration: false,
            thumbnails: false,
            native_screen_share_sender: false,
            web_capture_fallback: false,
            supported_frame_rates: vec![15, 30, 60],
            max_native_frame_rate: 0,
            hardware_h264_encoder: false,
            configured_hardware_profiles: Vec::new(),
            remote_control_host: false,
            remote_control_source_kinds: Vec::new(),
            supported_source_kinds,
            video_backends,
            audio_backends,
            notes,
        }
    }
}

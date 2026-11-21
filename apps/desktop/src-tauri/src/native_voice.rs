use crate::native_opus::{Decoder as OpusDecoder, Encoder as OpusEncoder};
use bytes::Bytes;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample as CpalSample, SampleFormat, SizedSample, StreamConfig};
use nnnoiseless::DenoiseState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sys_voice::{AecConfig, CaptureHandle, Channels};
use tauri::{AppHandle, Manager, State};
use tokio::runtime::Builder as TokioRuntimeBuilder;
use tokio::sync::mpsc as tokio_mpsc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_gatherer_state::RTCIceGathererState;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::signaling_state::RTCSignalingState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::stats::StatsReportType;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::rtc_config::{rtc_configuration, NativeRTCIceServer};

const SAMPLE_RATE: u32 = 48_000;
const FRAME_SAMPLES: usize = 960;
const FRAME_DURATION: Duration = Duration::from_millis(20);
const OPUS_BITRATE: u32 = 48_000;
const ACCOMPANIMENT_OPUS_BITRATE: u32 = 256_000;
const ACCOMPANIMENT_CHANNELS: usize = 2;
const PLAYOUT_PREBUFFER_FRAMES: usize = 3;
const PLAYBACK_TARGET_FRAMES: usize = 3;
const PLAYBACK_MIN_FRAMES: usize = 1;
const PLAYBACK_CHANNELS: usize = 2;
const MAX_DECODED_QUEUE_SAMPLES: usize = FRAME_SAMPLES * PLAYBACK_CHANNELS * 12;
const MAX_PLAYBACK_QUEUE_FRAMES: usize = FRAME_SAMPLES * 8;
const MAX_PACKET_LOSS_CONCEALMENT_FRAMES: usize = 3;
const PLAYOUT_IDLE_RESET_FRAMES: u16 = 25;
const PLAYOUT_FADE_SAMPLES: usize = 240;
const ACCOMPANIMENT_FADE_IN_SAMPLES: usize = FRAME_SAMPLES;
const VOICE_PEER_DISCONNECTED_TIMEOUT_MS: i64 = 6_000;
const UI_SOUND_VOLUME_SCALE: f32 = 0.25;
const SPEAKING_START_RMS: f32 = 0.035;
const SPEAKING_STOP_RMS: f32 = 0.015;

fn default_voice_volume_percent() -> u32 {
    100
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceNoiseSuppressionMode {
    Off,
    Light,
    #[default]
    Standard,
    Strong,
}

impl VoiceNoiseSuppressionMode {
    fn as_u8(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::Light => 1,
            Self::Standard => 2,
            Self::Strong => 3,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Off,
            1 => Self::Light,
            3 => Self::Strong,
            _ => Self::Standard,
        }
    }
}

fn clamp_input_gain(value: u32) -> u32 {
    value.min(1000)
}

fn clamp_output_volume(value: u32) -> u32 {
    value.min(100)
}

fn clamp_member_volume(value: u32) -> u32 {
    value.min(1000)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceStartRequest {
    pub server_id: String,
    pub channel_id: String,
    pub member_id: String,
    pub muted: bool,
    pub deafened: bool,
    #[serde(default = "default_voice_volume_percent")]
    pub input_gain_percent: u32,
    #[serde(default = "default_voice_volume_percent")]
    pub output_volume_percent: u32,
    #[serde(default)]
    pub input_device_id: String,
    #[serde(default)]
    pub output_device_id: String,
    #[serde(default)]
    pub noise_suppression_mode: VoiceNoiseSuppressionMode,
    #[serde(default)]
    pub ice_servers: Vec<NativeRTCIceServer>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioDevices {
    pub inputs: Vec<NativeAudioDevice>,
    pub outputs: Vec<NativeAudioDevice>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoicePeerRequest {
    pub session_id: String,
    pub member_id: String,
    pub initiate: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceRemovePeerRequest {
    pub session_id: String,
    pub member_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceSignalRequest {
    pub session_id: String,
    pub member_id: String,
    pub signal_type: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceStateRequest {
    pub session_id: String,
    pub muted: bool,
    pub deafened: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceMicrophoneRestartRequest {
    pub session_id: String,
    pub input_device_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceLevelsRequest {
    pub session_id: String,
    pub input_gain_percent: u32,
    pub output_volume_percent: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceNoiseSuppressionRequest {
    pub session_id: String,
    pub mode: VoiceNoiseSuppressionMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceMemberVolumeRequest {
    pub session_id: String,
    pub member_id: String,
    pub volume_percent: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceMemberMusicVolumeRequest {
    pub session_id: String,
    pub member_id: String,
    pub volume_percent: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceAccompanimentRequest {
    pub session_id: String,
    pub process_id: u32,
    #[serde(default = "default_voice_volume_percent")]
    pub volume_percent: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceAccompanimentVolumeRequest {
    pub session_id: String,
    pub volume_percent: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceMicrophoneTestRequest {
    #[serde(default)]
    pub input_device_id: String,
    #[serde(default)]
    pub output_device_id: String,
    #[serde(default = "default_voice_volume_percent")]
    pub input_gain_percent: u32,
    #[serde(default = "default_voice_volume_percent")]
    pub output_volume_percent: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMicrophoneTestLevelsRequest {
    pub session_id: String,
    pub input_gain_percent: u32,
    pub output_volume_percent: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceHeadphoneTestRequest {
    #[serde(default)]
    pub output_device_id: String,
    #[serde(default = "default_voice_volume_percent")]
    pub output_volume_percent: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceSession {
    pub session_id: String,
    pub channel_id: String,
    pub member_id: String,
    pub backend: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMicrophoneTestStatus {
    pub session_id: String,
    pub active: bool,
    pub input_level: f32,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceStatus {
    pub session_id: String,
    pub channel_id: String,
    pub phase: String,
    pub backend: String,
    pub playback_backend: String,
    pub microphone_available: bool,
    pub microphone_error: Option<String>,
    pub muted: bool,
    pub deafened: bool,
    pub speaking: bool,
    pub input_level: f32,
    pub noise_suppression_mode: VoiceNoiseSuppressionMode,
    pub peer_count: usize,
    pub round_trip_time_ms: Option<u32>,
    pub captured_frames: u64,
    pub encoded_packets: u64,
    pub received_packets: u64,
    pub decoded_frames: u64,
    pub played_frames: u64,
    pub dropped_frames: u64,
    pub last_capture_at_ms: i64,
    pub last_receive_at_ms: i64,
    pub accompaniment_active: bool,
    pub accompaniment_process_id: Option<u32>,
    pub accompaniment_packets: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceOutboundSignal {
    pub member_id: String,
    pub signal_type: String,
    pub data: serde_json::Value,
}

#[derive(Default)]
pub struct NativeVoiceManager {
    lifecycle: Mutex<()>,
    session: Mutex<Option<NativeVoiceRuntimeSession>>,
    next_id: AtomicU64,
}

#[derive(Default)]
pub struct NativeMicrophoneTestManager {
    session: Mutex<Option<NativeMicrophoneTestRuntime>>,
    next_id: AtomicU64,
}

struct NativeMicrophoneTestRuntime {
    session_id: String,
    active: Arc<AtomicBool>,
    input_level_bits: Arc<AtomicU32>,
    last_error: Arc<Mutex<Option<String>>>,
    stop_flag: Arc<AtomicBool>,
    input_gain_percent: Arc<AtomicU32>,
    output_volume_percent: Arc<AtomicU32>,
    worker: Option<thread::JoinHandle<()>>,
}

struct NativeVoiceRuntimeSession {
    session_id: String,
    status: Arc<Mutex<NativeVoiceStatus>>,
    outbound_signals: Arc<Mutex<Vec<NativeVoiceOutboundSignal>>>,
    control_tx: tokio_mpsc::UnboundedSender<NativeVoiceControl>,
    worker: Option<thread::JoinHandle<()>>,
}

enum NativeVoiceControl {
    AddPeer {
        member_id: String,
        initiate: bool,
        response: mpsc::Sender<Result<(), String>>,
    },
    RemovePeer {
        member_id: String,
        response: mpsc::Sender<Result<(), String>>,
    },
    HandleSignal {
        member_id: String,
        signal_type: String,
        data: serde_json::Value,
        response: mpsc::Sender<Result<(), String>>,
    },
    SetState {
        muted: bool,
        deafened: bool,
        response: mpsc::Sender<Result<(), String>>,
    },
    RestartMicrophone {
        input_device_id: String,
        response: mpsc::Sender<Result<(), String>>,
    },
    SetLevels {
        input_gain_percent: u32,
        output_volume_percent: u32,
        response: mpsc::Sender<Result<(), String>>,
    },
    SetNoiseSuppression {
        mode: VoiceNoiseSuppressionMode,
        response: mpsc::Sender<Result<(), String>>,
    },
    SetMemberVolume {
        member_id: String,
        volume_percent: u32,
        response: mpsc::Sender<Result<(), String>>,
    },
    SetMemberMusicVolume {
        member_id: String,
        volume_percent: u32,
        response: mpsc::Sender<Result<(), String>>,
    },
    StartAccompaniment {
        process_id: u32,
        volume_percent: u32,
        response: mpsc::Sender<Result<(), String>>,
    },
    SetAccompanimentVolume {
        volume_percent: u32,
        response: mpsc::Sender<Result<(), String>>,
    },
    StopAccompaniment {
        response: mpsc::Sender<Result<(), String>>,
    },
    Stop,
}

struct NativeVoiceEngine {
    status: Arc<Mutex<NativeVoiceStatus>>,
    outbound_signals: Arc<Mutex<Vec<NativeVoiceOutboundSignal>>>,
    muted: Arc<AtomicBool>,
    deafened: Arc<AtomicBool>,
    microphone_available: Arc<AtomicBool>,
    input_gain_percent: Arc<AtomicU32>,
    noise_suppression_mode: Arc<AtomicU8>,
    output_volume_percent: Arc<AtomicU32>,
    member_volumes: Arc<Mutex<HashMap<String, u32>>>,
    member_music_volumes: Arc<Mutex<HashMap<String, u32>>>,
    accompaniment_volume_percent: Arc<AtomicU32>,
    audio_track: Arc<TrackLocalStaticSample>,
    accompaniment_track: Arc<TrackLocalStaticSample>,
    accompaniment_runtime: Option<NativeAccompanimentRuntime>,
    decoded_tx: tokio_mpsc::UnboundedSender<DecodedAudio>,
    peers: HashMap<String, NativeVoicePeer>,
    rtc_configuration: RTCConfiguration,
}

struct NativeVoiceStartup {
    backend: String,
}

enum NativePlayback {
    OutputOnly(CpalPlayback),
}

enum NativeCapture {
    EchoCancelled(CaptureHandle),
    Direct(CpalCapture),
}

struct CpalCapture {
    _stream: cpal::Stream,
    receiver: tokio_mpsc::UnboundedReceiver<Result<Vec<f32>, String>>,
}

#[derive(Default)]
struct CpalCaptureBuffer {
    samples: VecDeque<f32>,
    source_position: f64,
}

struct CpalPlayback {
    _stream: cpal::Stream,
    queue: Arc<Mutex<CpalPlaybackBuffer>>,
}

#[derive(Default)]
struct CpalPlaybackBuffer {
    frames: VecDeque<[f32; PLAYBACK_CHANNELS]>,
    source_position: f64,
    last_output_frame: [f32; PLAYBACK_CHANNELS],
    fade_from_frame: [f32; PLAYBACK_CHANNELS],
    fade_remaining: usize,
    was_empty: bool,
}

struct StereoTestBuffer {
    frames: VecDeque<(f32, f32)>,
    source_sample_rate: u32,
    source_position: f64,
}

struct NativeVoicePeer {
    peer_connection: Arc<RTCPeerConnection>,
    pending_ice: Vec<RTCIceCandidateInit>,
    disconnected_at_ms: i64,
}

struct DecodedAudio {
    member_id: String,
    source_id: String,
    is_accompaniment: bool,
    samples: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IncomingOpusPayloadKind {
    Padding,
    DiscontinuousSilence,
    Audio,
}

fn opus_frame_to_stereo(pcm: &[f32], samples_per_channel: usize, channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return pcm[..samples_per_channel.min(pcm.len())]
            .iter()
            .flat_map(|sample| [*sample, *sample])
            .collect();
    }
    pcm[..samples_per_channel.saturating_mul(channels).min(pcm.len())].to_vec()
}

#[derive(Default)]
struct VoicePlayoutQueue {
    samples: VecDeque<f32>,
    started: bool,
    needs_fade_in: bool,
    previous_frame: [f32; PLAYBACK_CHANNELS],
    last_frame: [f32; PLAYBACK_CHANNELS],
    underflow_frames: u16,
}

struct NativeAccompanimentRuntime {
    stop_flag: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for NativeAccompanimentRuntime {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl NativeVoiceManager {
    fn start(&self, request: NativeVoiceStartRequest) -> Result<NativeVoiceSession, String> {
        if request.channel_id.trim().is_empty() || request.member_id.trim().is_empty() {
            return Err("voice channel and member are required".to_string());
        }
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "native voice lifecycle is poisoned".to_string())?;
        self.stop_current();

        let session_id = format!(
            "nvs_{}_{}",
            now_ms(),
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let backend = native_audio_backend().to_string();
        let status = Arc::new(Mutex::new(NativeVoiceStatus {
            session_id: session_id.clone(),
            channel_id: request.channel_id.clone(),
            phase: "starting".to_string(),
            backend: backend.clone(),
            playback_backend: "starting".to_string(),
            microphone_available: false,
            microphone_error: None,
            muted: request.muted,
            deafened: request.deafened,
            speaking: false,
            input_level: 0.0,
            noise_suppression_mode: request.noise_suppression_mode,
            peer_count: 0,
            round_trip_time_ms: None,
            captured_frames: 0,
            encoded_packets: 0,
            received_packets: 0,
            decoded_frames: 0,
            played_frames: 0,
            dropped_frames: 0,
            last_capture_at_ms: 0,
            last_receive_at_ms: 0,
            accompaniment_active: false,
            accompaniment_process_id: None,
            accompaniment_packets: 0,
            last_error: None,
        }));
        let outbound_signals = Arc::new(Mutex::new(Vec::new()));
        let (control_tx, control_rx) = tokio_mpsc::unbounded_channel();
        let (startup_tx, startup_rx) = mpsc::channel();
        let worker_status = Arc::clone(&status);
        let worker_outbound = Arc::clone(&outbound_signals);
        let worker_request = request.clone();
        let worker = thread::Builder::new()
            .name("ev-native-voice".to_string())
            .spawn(move || {
                let runtime = match TokioRuntimeBuilder::new_multi_thread()
                    .worker_threads(4)
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(err) => {
                        let _ = startup_tx.send(Err(format!("create native voice runtime: {err}")));
                        return;
                    }
                };
                runtime.block_on(run_native_voice(
                    worker_request,
                    worker_status,
                    worker_outbound,
                    control_rx,
                    startup_tx,
                ));
            })
            .map_err(|err| format!("start native voice worker: {err}"))?;

        match startup_rx.recv_timeout(Duration::from_secs(8)) {
            Ok(Ok(startup)) => {
                let mut slot = self
                    .session
                    .lock()
                    .map_err(|_| "native voice manager is poisoned".to_string())?;
                *slot = Some(NativeVoiceRuntimeSession {
                    session_id: session_id.clone(),
                    status,
                    outbound_signals,
                    control_tx,
                    worker: Some(worker),
                });
                Ok(NativeVoiceSession {
                    session_id,
                    channel_id: request.channel_id,
                    member_id: request.member_id,
                    backend: startup.backend,
                })
            }
            Ok(Err(err)) => {
                let _ = worker.join();
                Err(err)
            }
            Err(_) => {
                let _ = control_tx.send(NativeVoiceControl::Stop);
                let _ = worker.join();
                Err("native voice startup timed out".to_string())
            }
        }
    }

    fn stop_current(&self) {
        let runtime = self.session.lock().ok().and_then(|mut slot| slot.take());
        if let Some(mut runtime) = runtime {
            let _ = runtime.control_tx.send(NativeVoiceControl::Stop);
            if let Some(worker) = runtime.worker.take() {
                let _ = worker.join();
            }
        }
    }

    fn stop(&self, session_id: &str) -> Result<(), String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "native voice lifecycle is poisoned".to_string())?;
        let matches = self
            .session
            .lock()
            .map_err(|_| "native voice manager is poisoned".to_string())?
            .as_ref()
            .is_some_and(|session| session.session_id == session_id);
        if matches {
            self.stop_current();
        }
        Ok(())
    }

    fn send_control<F>(&self, session_id: &str, build: F) -> Result<(), String>
    where
        F: FnOnce(mpsc::Sender<Result<(), String>>) -> NativeVoiceControl,
    {
        let sender = {
            let session = self
                .session
                .lock()
                .map_err(|_| "native voice manager is poisoned".to_string())?;
            let session = session
                .as_ref()
                .filter(|session| session.session_id == session_id)
                .ok_or_else(|| "native voice session was not found".to_string())?;
            session.control_tx.clone()
        };
        let (response_tx, response_rx) = mpsc::channel();
        sender
            .send(build(response_tx))
            .map_err(|_| "native voice worker has stopped".to_string())?;
        response_rx
            .recv_timeout(Duration::from_secs(8))
            .map_err(|_| "native voice operation timed out".to_string())?
    }

    fn set_state(&self, request: NativeVoiceStateRequest) -> Result<(), String> {
        let session_id = request.session_id.clone();
        self.send_control(&session_id, |response| NativeVoiceControl::SetState {
            muted: request.muted,
            deafened: request.deafened,
            response,
        })
    }

    fn restart_microphone(
        &self,
        request: NativeVoiceMicrophoneRestartRequest,
    ) -> Result<(), String> {
        let session_id = request.session_id.clone();
        self.send_control(&session_id, |response| {
            NativeVoiceControl::RestartMicrophone {
                input_device_id: request.input_device_id,
                response,
            }
        })
    }

    fn set_levels(&self, request: NativeVoiceLevelsRequest) -> Result<(), String> {
        let session_id = request.session_id.clone();
        self.send_control(&session_id, |response| NativeVoiceControl::SetLevels {
            input_gain_percent: request.input_gain_percent,
            output_volume_percent: request.output_volume_percent,
            response,
        })
    }

    fn set_noise_suppression(
        &self,
        request: NativeVoiceNoiseSuppressionRequest,
    ) -> Result<(), String> {
        let session_id = request.session_id.clone();
        self.send_control(&session_id, |response| {
            NativeVoiceControl::SetNoiseSuppression {
                mode: request.mode,
                response,
            }
        })
    }

    fn set_member_volume(&self, request: NativeVoiceMemberVolumeRequest) -> Result<(), String> {
        if request.member_id.trim().is_empty() {
            return Err("voice member is required".to_string());
        }
        let session_id = request.session_id.clone();
        self.send_control(&session_id, |response| {
            NativeVoiceControl::SetMemberVolume {
                member_id: request.member_id,
                volume_percent: request.volume_percent,
                response,
            }
        })
    }

    fn set_member_music_volume(
        &self,
        request: NativeVoiceMemberMusicVolumeRequest,
    ) -> Result<(), String> {
        if request.member_id.trim().is_empty() {
            return Err("voice member is required".to_string());
        }
        let session_id = request.session_id.clone();
        self.send_control(&session_id, |response| {
            NativeVoiceControl::SetMemberMusicVolume {
                member_id: request.member_id,
                volume_percent: request.volume_percent,
                response,
            }
        })
    }

    fn start_accompaniment(&self, request: NativeVoiceAccompanimentRequest) -> Result<(), String> {
        if request.process_id == 0 {
            return Err("music source process id is required".to_string());
        }
        let session_id = request.session_id.clone();
        self.send_control(&session_id, |response| {
            NativeVoiceControl::StartAccompaniment {
                process_id: request.process_id,
                volume_percent: request.volume_percent,
                response,
            }
        })
    }

    fn set_accompaniment_volume(
        &self,
        request: NativeVoiceAccompanimentVolumeRequest,
    ) -> Result<(), String> {
        let session_id = request.session_id.clone();
        self.send_control(&session_id, |response| {
            NativeVoiceControl::SetAccompanimentVolume {
                volume_percent: request.volume_percent,
                response,
            }
        })
    }

    fn stop_accompaniment(&self, session_id: &str) -> Result<(), String> {
        self.send_control(session_id, |response| {
            NativeVoiceControl::StopAccompaniment { response }
        })
    }

    fn status(&self, session_id: &str) -> Result<NativeVoiceStatus, String> {
        let status = {
            let session = self
                .session
                .lock()
                .map_err(|_| "native voice manager is poisoned".to_string())?;
            let session = session
                .as_ref()
                .filter(|session| session.session_id == session_id)
                .ok_or_else(|| "native voice session was not found".to_string())?;
            Arc::clone(&session.status)
        };
        let snapshot = status
            .lock()
            .map_err(|_| "native voice status is poisoned".to_string())?
            .clone();
        Ok(snapshot)
    }

    fn drain_signals(&self, session_id: &str) -> Result<Vec<NativeVoiceOutboundSignal>, String> {
        let queue = {
            let session = self
                .session
                .lock()
                .map_err(|_| "native voice manager is poisoned".to_string())?;
            let session = session
                .as_ref()
                .filter(|session| session.session_id == session_id)
                .ok_or_else(|| "native voice session was not found".to_string())?;
            Arc::clone(&session.outbound_signals)
        };
        let signals = queue
            .lock()
            .map_err(|_| "native voice signal queue is poisoned".to_string())?
            .drain(..)
            .collect();
        Ok(signals)
    }
}

impl Drop for NativeVoiceManager {
    fn drop(&mut self) {
        self.stop_current();
    }
}

impl NativeMicrophoneTestManager {
    fn start(
        &self,
        request: NativeVoiceMicrophoneTestRequest,
    ) -> Result<NativeMicrophoneTestStatus, String> {
        self.stop_current();
        let session_id = format!(
            "nmts_{}_{}",
            now_ms(),
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let active = Arc::new(AtomicBool::new(false));
        let input_level_bits = Arc::new(AtomicU32::new(0.0_f32.to_bits()));
        let last_error = Arc::new(Mutex::new(None));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let input_gain_percent =
            Arc::new(AtomicU32::new(clamp_input_gain(request.input_gain_percent)));
        let output_volume_percent = Arc::new(AtomicU32::new(clamp_output_volume(
            request.output_volume_percent,
        )));
        let worker_active = Arc::clone(&active);
        let worker_level = Arc::clone(&input_level_bits);
        let worker_error = Arc::clone(&last_error);
        let worker_stop = Arc::clone(&stop_flag);
        let worker_input_gain = Arc::clone(&input_gain_percent);
        let worker_output_volume = Arc::clone(&output_volume_percent);
        let (startup_tx, startup_rx) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("ev-microphone-test".to_string())
            .spawn(move || {
                let status = Arc::new(Mutex::new(microphone_test_status()));
                let mut capture = match CpalCapture::new(
                    trimmed_device_id(&request.input_device_id),
                    Arc::clone(&status),
                ) {
                    Ok(capture) => capture,
                    Err(err) => {
                        let _ = startup_tx.send(Err(err));
                        return;
                    }
                };
                let playback = match CpalPlayback::new_for_device(
                    status,
                    trimmed_device_id(&request.output_device_id),
                ) {
                    Ok(playback) => playback,
                    Err(err) => {
                        let _ = startup_tx.send(Err(err));
                        return;
                    }
                };
                worker_active.store(true, Ordering::SeqCst);
                if startup_tx.send(Ok(())).is_err() {
                    worker_active.store(false, Ordering::SeqCst);
                    return;
                }
                while !worker_stop.load(Ordering::SeqCst) {
                    match capture.receiver.try_recv() {
                        Ok(Ok(mut samples)) => {
                            let mut peak = 0.0_f32;
                            let input_gain =
                                worker_input_gain.load(Ordering::Relaxed) as f32 / 100.0;
                            let output_gain =
                                worker_output_volume.load(Ordering::Relaxed) as f32 / 100.0;
                            for sample in &mut samples {
                                let monitored = soft_limit(*sample * input_gain);
                                peak = peak.max(monitored.abs());
                                *sample = monitored * output_gain;
                            }
                            worker_level.store(peak.min(1.0).to_bits(), Ordering::Relaxed);
                            let stereo_samples = samples
                                .into_iter()
                                .flat_map(|sample| [sample, sample])
                                .collect();
                            if let Err(err) = playback.enqueue(stereo_samples) {
                                if let Ok(mut slot) = worker_error.lock() {
                                    *slot = Some(err);
                                }
                                break;
                            }
                        }
                        Ok(Err(err)) => {
                            if let Ok(mut slot) = worker_error.lock() {
                                *slot = Some(err);
                            }
                            break;
                        }
                        Err(tokio_mpsc::error::TryRecvError::Empty) => {
                            thread::sleep(Duration::from_millis(4));
                        }
                        Err(tokio_mpsc::error::TryRecvError::Disconnected) => {
                            if !worker_stop.load(Ordering::SeqCst) {
                                if let Ok(mut slot) = worker_error.lock() {
                                    *slot = Some("native microphone input stopped".to_string());
                                }
                            }
                            break;
                        }
                    }
                }
                worker_level.store(0.0_f32.to_bits(), Ordering::Relaxed);
                worker_active.store(false, Ordering::SeqCst);
            })
            .map_err(|err| format!("start microphone test worker: {err}"))?;

        match startup_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {
                let runtime = NativeMicrophoneTestRuntime {
                    session_id: session_id.clone(),
                    active,
                    input_level_bits,
                    last_error,
                    stop_flag,
                    input_gain_percent,
                    output_volume_percent,
                    worker: Some(worker),
                };
                let status = microphone_test_snapshot(&runtime);
                let mut slot = self
                    .session
                    .lock()
                    .map_err(|_| "microphone test manager is poisoned".to_string())?;
                *slot = Some(runtime);
                Ok(status)
            }
            Ok(Err(err)) => {
                let _ = worker.join();
                Err(err)
            }
            Err(_) => {
                stop_flag.store(true, Ordering::SeqCst);
                let _ = worker.join();
                Err("microphone test startup timed out".to_string())
            }
        }
    }

    fn status(&self, session_id: &str) -> Result<NativeMicrophoneTestStatus, String> {
        let slot = self
            .session
            .lock()
            .map_err(|_| "microphone test manager is poisoned".to_string())?;
        let runtime = slot
            .as_ref()
            .filter(|runtime| runtime.session_id == session_id)
            .ok_or_else(|| "microphone test session was not found".to_string())?;
        Ok(microphone_test_snapshot(runtime))
    }

    fn set_levels(&self, request: NativeMicrophoneTestLevelsRequest) -> Result<(), String> {
        let slot = self
            .session
            .lock()
            .map_err(|_| "microphone test manager is poisoned".to_string())?;
        let runtime = slot
            .as_ref()
            .filter(|runtime| runtime.session_id == request.session_id)
            .ok_or_else(|| "microphone test session was not found".to_string())?;
        runtime.input_gain_percent.store(
            clamp_input_gain(request.input_gain_percent),
            Ordering::Relaxed,
        );
        runtime.output_volume_percent.store(
            clamp_output_volume(request.output_volume_percent),
            Ordering::Relaxed,
        );
        Ok(())
    }

    fn stop(&self, session_id: &str) -> Result<(), String> {
        let runtime = {
            let mut slot = self
                .session
                .lock()
                .map_err(|_| "microphone test manager is poisoned".to_string())?;
            if slot
                .as_ref()
                .is_some_and(|runtime| runtime.session_id != session_id)
            {
                return Err("microphone test session was not found".to_string());
            }
            slot.take()
        };
        if let Some(runtime) = runtime {
            stop_microphone_test_runtime(runtime);
        }
        Ok(())
    }

    fn stop_current(&self) {
        let runtime = self.session.lock().ok().and_then(|mut slot| slot.take());
        if let Some(runtime) = runtime {
            stop_microphone_test_runtime(runtime);
        }
    }
}

impl Drop for NativeMicrophoneTestManager {
    fn drop(&mut self) {
        self.stop_current();
    }
}

fn microphone_test_snapshot(runtime: &NativeMicrophoneTestRuntime) -> NativeMicrophoneTestStatus {
    NativeMicrophoneTestStatus {
        session_id: runtime.session_id.clone(),
        active: runtime.active.load(Ordering::SeqCst),
        input_level: f32::from_bits(runtime.input_level_bits.load(Ordering::Relaxed)),
        last_error: runtime
            .last_error
            .lock()
            .ok()
            .and_then(|error| error.clone()),
    }
}

fn stop_microphone_test_runtime(mut runtime: NativeMicrophoneTestRuntime) {
    runtime.stop_flag.store(true, Ordering::SeqCst);
    if let Some(worker) = runtime.worker.take() {
        let _ = worker.join();
    }
}

#[tauri::command]
pub fn start_native_voice_session(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoiceStartRequest,
) -> Result<NativeVoiceSession, String> {
    manager.start(request)
}

#[tauri::command]
pub fn native_voice_list_devices() -> Result<NativeAudioDevices, String> {
    let host = cpal::default_host();
    let default_input_id = host
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());
    let default_output_id = host
        .default_output_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());
    let inputs = collect_audio_devices(
        host.input_devices()
            .map_err(|err| format!("list native input devices: {err}"))?,
        default_input_id.as_deref(),
    );
    let outputs = collect_audio_devices(
        host.output_devices()
            .map_err(|err| format!("list native output devices: {err}"))?,
        default_output_id.as_deref(),
    );
    Ok(NativeAudioDevices { inputs, outputs })
}

#[tauri::command]
pub fn start_native_microphone_test(
    manager: State<'_, NativeMicrophoneTestManager>,
    request: NativeVoiceMicrophoneTestRequest,
) -> Result<NativeMicrophoneTestStatus, String> {
    manager.start(request)
}

#[tauri::command]
pub fn native_microphone_test_status(
    manager: State<'_, NativeMicrophoneTestManager>,
    session_id: String,
) -> Result<NativeMicrophoneTestStatus, String> {
    manager.status(&session_id)
}

#[tauri::command]
pub fn set_native_microphone_test_levels(
    manager: State<'_, NativeMicrophoneTestManager>,
    request: NativeMicrophoneTestLevelsRequest,
) -> Result<(), String> {
    manager.set_levels(request)
}

#[tauri::command]
pub fn stop_native_microphone_test(
    manager: State<'_, NativeMicrophoneTestManager>,
    session_id: String,
) -> Result<(), String> {
    manager.stop(&session_id)
}

#[tauri::command]
pub fn native_voice_test_headphones(
    request: NativeVoiceHeadphoneTestRequest,
) -> Result<(), String> {
    let (samples, source_sample_rate) = decode_embedded_microphone_enabled_sound()?;
    let gain =
        clamp_output_volume(request.output_volume_percent) as f32 / 100.0 * UI_SOUND_VOLUME_SCALE;
    let gap_frames = (source_sample_rate as usize * 180) / 1000;
    let mut frames = VecDeque::with_capacity(samples.len() * 2 + gap_frames);
    frames.extend(samples.iter().map(|sample| (*sample * gain, 0.0)));
    frames.extend(std::iter::repeat_n((0.0, 0.0), gap_frames));
    frames.extend(samples.iter().map(|sample| (0.0, *sample * gain)));

    let host = cpal::default_host();
    let device = resolve_output_device(&host, trimmed_device_id(&request.output_device_id))?;
    let supported = device
        .default_output_config()
        .map_err(|err| format!("load headphone test output configuration: {err}"))?;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    if config.channels == 0 || config.sample_rate == 0 {
        return Err("headphone test output configuration is invalid".to_string());
    }
    let queue = Arc::new(Mutex::new(StereoTestBuffer {
        frames,
        source_sample_rate,
        source_position: 0.0,
    }));
    let playback_error = Arc::new(Mutex::new(None));
    let stream = build_headphone_test_output_stream(
        &device,
        config,
        sample_format,
        queue,
        Arc::clone(&playback_error),
    )?;
    stream
        .play()
        .map_err(|err| format!("start headphone test output: {err}"))?;
    let playback_ms =
        ((samples.len() * 2 + gap_frames) as u64 * 1000) / source_sample_rate.max(1) as u64;
    thread::sleep(Duration::from_millis(playback_ms + 120));
    if let Ok(error) = playback_error.lock() {
        if let Some(message) = error.as_ref() {
            return Err(message.clone());
        }
    }
    Ok(())
}

fn decode_embedded_microphone_enabled_sound() -> Result<(Vec<f32>, u32), String> {
    let bytes = include_bytes!("../assets/mic_headset_on.wav");
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("embedded headphone test sound is not a WAV file".to_string());
    }
    let mut offset = 12_usize;
    let mut format = None;
    let mut data = None;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = u32::from_le_bytes(
            bytes[offset + 4..offset + 8]
                .try_into()
                .map_err(|_| "invalid WAV chunk size".to_string())?,
        ) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(chunk_size)
            .ok_or_else(|| "invalid WAV chunk length".to_string())?;
        if end > bytes.len() {
            return Err("truncated embedded headphone test sound".to_string());
        }
        if chunk_id == b"fmt " && chunk_size >= 16 {
            format = Some((
                u16::from_le_bytes([bytes[start], bytes[start + 1]]),
                u16::from_le_bytes([bytes[start + 2], bytes[start + 3]]),
                u32::from_le_bytes(bytes[start + 4..start + 8].try_into().unwrap()),
                u16::from_le_bytes([bytes[start + 14], bytes[start + 15]]),
            ));
        } else if chunk_id == b"data" {
            data = Some(&bytes[start..end]);
        }
        offset = end + (chunk_size & 1);
    }
    let (audio_format, channels, sample_rate, bits_per_sample) =
        format.ok_or_else(|| "embedded headphone test sound has no format chunk".to_string())?;
    let data = data.ok_or_else(|| "embedded headphone test sound has no data chunk".to_string())?;
    if audio_format != 1 || channels == 0 || bits_per_sample != 16 {
        return Err("embedded headphone test sound must use 16-bit PCM".to_string());
    }
    let frame_bytes = channels as usize * 2;
    let mut samples = Vec::with_capacity(data.len() / frame_bytes);
    for frame in data.chunks_exact(frame_bytes) {
        let mut mixed = 0.0_f32;
        for channel in 0..channels as usize {
            let index = channel * 2;
            mixed += i16::from_le_bytes([frame[index], frame[index + 1]]) as f32 / 32768.0;
        }
        samples.push(mixed / channels as f32);
    }
    if samples.is_empty() {
        return Err("embedded headphone test sound is empty".to_string());
    }
    Ok((samples, sample_rate))
}

fn microphone_test_status() -> NativeVoiceStatus {
    NativeVoiceStatus {
        session_id: "microphone-test".to_string(),
        channel_id: String::new(),
        phase: "testing".to_string(),
        backend: native_audio_backend().to_string(),
        playback_backend: String::new(),
        microphone_available: true,
        microphone_error: None,
        muted: false,
        deafened: false,
        speaking: false,
        input_level: 0.0,
        noise_suppression_mode: VoiceNoiseSuppressionMode::Off,
        peer_count: 0,
        round_trip_time_ms: None,
        captured_frames: 0,
        encoded_packets: 0,
        received_packets: 0,
        decoded_frames: 0,
        played_frames: 0,
        dropped_frames: 0,
        last_capture_at_ms: 0,
        last_receive_at_ms: 0,
        accompaniment_active: false,
        accompaniment_process_id: None,
        accompaniment_packets: 0,
        last_error: None,
    }
}

fn collect_audio_devices(
    devices: impl Iterator<Item = cpal::Device>,
    default_id: Option<&str>,
) -> Vec<NativeAudioDevice> {
    let mut result = Vec::new();
    for device in devices {
        let Ok(id) = device.id().map(|id| id.to_string()) else {
            continue;
        };
        if result
            .iter()
            .any(|existing: &NativeAudioDevice| existing.id == id)
        {
            continue;
        }
        result.push(NativeAudioDevice {
            name: device.to_string(),
            is_default: default_id.is_some_and(|default| default == id),
            id,
        });
    }
    result
}

fn trimmed_device_id(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn start_default_native_audio(
    status: Arc<Mutex<NativeVoiceStatus>>,
    startup_tx: &mpsc::Sender<Result<NativeVoiceStartup, String>>,
) -> (
    Option<NativeCapture>,
    Option<NativePlayback>,
    Option<String>,
    String,
) {
    let playback = match CpalPlayback::new_for_device(Arc::clone(&status), None) {
        Ok(playback) => NativePlayback::OutputOnly(playback),
        Err(err) => {
            let message = format!("start default native output: {err}");
            set_fatal_status(&status, &message);
            let _ = startup_tx.send(Err(message));
            return (None, None, None, native_audio_backend().to_string());
        }
    };
    match start_default_native_capture(Arc::clone(&status)) {
        Ok((capture, used_direct_fallback)) => (
            Some(capture),
            Some(playback),
            None,
            if used_direct_fallback {
                direct_audio_backend().to_string()
            } else {
                native_audio_backend().to_string()
            },
        ),
        Err(err) => (
            None,
            Some(playback),
            Some(err),
            output_only_audio_backend().to_string(),
        ),
    }
}

fn start_default_native_capture(
    status: Arc<Mutex<NativeVoiceStatus>>,
) -> Result<(NativeCapture, bool), String> {
    match CaptureHandle::new(AecConfig {
        sample_rate: SAMPLE_RATE,
        channels: Channels::Mono,
    }) {
        Ok(capture) => Ok((NativeCapture::EchoCancelled(capture), false)),
        Err(aec_error) => CpalCapture::new(None, status)
            .map(|capture| (NativeCapture::Direct(capture), true))
            .map_err(|direct_error| {
                format!(
                    "start native microphone: echo-cancelled capture failed ({aec_error}); direct capture fallback failed ({direct_error})"
                )
            }),
    }
}

fn start_native_capture_for_device(
    input_device_id: Option<&str>,
    status: Arc<Mutex<NativeVoiceStatus>>,
) -> Result<(NativeCapture, String), String> {
    if let Some(device_id) = input_device_id {
        return match CpalCapture::new(Some(device_id), Arc::clone(&status)) {
            Ok(capture) => Ok((
                NativeCapture::Direct(capture),
                selected_direct_audio_backend().to_string(),
            )),
            Err(selected_error) => start_default_native_capture(status)
                .map(|(capture, used_direct_fallback)| {
                    let backend = if used_direct_fallback {
                        direct_audio_backend()
                    } else {
                        native_audio_backend()
                    };
                    (capture, backend.to_string())
                })
                .map_err(|default_error| {
                    format!(
                        "selected input failed ({selected_error}); default input fallback failed ({default_error})"
                    )
                }),
        };
    }

    start_default_native_capture(status).map(|(capture, used_direct_fallback)| {
        let backend = if used_direct_fallback {
            direct_audio_backend()
        } else {
            native_audio_backend()
        };
        (capture, backend.to_string())
    })
}

fn start_selected_native_audio(
    input_device_id: Option<&str>,
    output_device_id: Option<&str>,
    status: Arc<Mutex<NativeVoiceStatus>>,
    startup_tx: &mpsc::Sender<Result<NativeVoiceStartup, String>>,
) -> (
    Option<NativeCapture>,
    Option<NativePlayback>,
    Option<String>,
    String,
) {
    let capture_result = if let Some(device_id) = input_device_id {
        match CpalCapture::new(Some(device_id), Arc::clone(&status)) {
            Ok(capture) => Ok((NativeCapture::Direct(capture), true, false)),
            Err(selected_error) => start_default_native_capture(Arc::clone(&status))
                .map(|(capture, used_direct_fallback)| (capture, false, used_direct_fallback))
                .map_err(|default_error| {
                    format!(
                        "selected input failed ({selected_error}); default input fallback failed ({default_error})"
                    )
                }),
        }
    } else {
        start_default_native_capture(Arc::clone(&status))
            .map(|(capture, used_direct_fallback)| (capture, false, used_direct_fallback))
    };
    let playback = match CpalPlayback::new_for_device(Arc::clone(&status), output_device_id) {
        Ok(playback) => NativePlayback::OutputOnly(playback),
        Err(selected_error) if output_device_id.is_some() => {
            match CpalPlayback::new_for_device(Arc::clone(&status), None) {
                Ok(playback) => NativePlayback::OutputOnly(playback),
                Err(default_error) => {
                    let message = format!(
                        "start native output: selected device failed ({selected_error}); default output fallback failed ({default_error})"
                    );
                    set_fatal_status(&status, &message);
                    let _ = startup_tx.send(Err(message));
                    return (None, None, None, "selected-device".to_string());
                }
            }
        }
        Err(err) => {
            let message = format!("start default native output: {err}");
            set_fatal_status(&status, &message);
            let _ = startup_tx.send(Err(message));
            return (None, None, None, "selected-device".to_string());
        }
    };
    match capture_result {
        Ok((capture, used_selected_input, used_direct_fallback)) => (
            Some(capture),
            Some(playback),
            None,
            if used_selected_input {
                selected_direct_audio_backend().to_string()
            } else if used_direct_fallback {
                direct_audio_backend().to_string()
            } else {
                native_audio_backend().to_string()
            },
        ),
        Err(err) => (
            None,
            Some(playback),
            Some(format!("start selected native input: {err}")),
            output_only_audio_backend().to_string(),
        ),
    }
}

#[tauri::command]
pub fn stop_native_voice_session(
    manager: State<'_, NativeVoiceManager>,
    session_id: String,
) -> Result<(), String> {
    manager.stop(&session_id)
}

#[tauri::command]
pub fn native_voice_set_noise_suppression(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoiceNoiseSuppressionRequest,
) -> Result<(), String> {
    manager.set_noise_suppression(request)
}

#[tauri::command]
pub fn native_voice_add_peer(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoicePeerRequest,
) -> Result<(), String> {
    let session_id = request.session_id.clone();
    manager.send_control(&session_id, |response| NativeVoiceControl::AddPeer {
        member_id: request.member_id,
        initiate: request.initiate,
        response,
    })
}

#[tauri::command]
pub fn native_voice_remove_peer(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoiceRemovePeerRequest,
) -> Result<(), String> {
    let session_id = request.session_id.clone();
    manager.send_control(&session_id, |response| NativeVoiceControl::RemovePeer {
        member_id: request.member_id,
        response,
    })
}

#[tauri::command]
pub fn native_voice_handle_signal(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoiceSignalRequest,
) -> Result<(), String> {
    let session_id = request.session_id.clone();
    manager.send_control(&session_id, |response| NativeVoiceControl::HandleSignal {
        member_id: request.member_id,
        signal_type: request.signal_type,
        data: request.data,
        response,
    })
}

#[tauri::command]
pub fn native_voice_set_state(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoiceStateRequest,
) -> Result<(), String> {
    manager.set_state(request)
}

#[tauri::command]
pub fn native_voice_restart_microphone(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoiceMicrophoneRestartRequest,
) -> Result<(), String> {
    manager.restart_microphone(request)
}

#[tauri::command]
pub fn native_voice_set_levels(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoiceLevelsRequest,
) -> Result<(), String> {
    manager.set_levels(request)
}

#[tauri::command]
pub fn native_voice_set_member_volume(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoiceMemberVolumeRequest,
) -> Result<(), String> {
    manager.set_member_volume(request)
}

#[tauri::command]
pub fn native_voice_set_member_music_volume(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoiceMemberMusicVolumeRequest,
) -> Result<(), String> {
    manager.set_member_music_volume(request)
}

#[tauri::command]
pub async fn native_voice_start_accompaniment(
    app: AppHandle,
    request: NativeVoiceAccompanimentRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeVoiceManager>()
            .start_accompaniment(request)
    })
    .await
    .map_err(|err| format!("start music capture task failed: {err}"))?
}

#[tauri::command]
pub async fn native_voice_stop_accompaniment(
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeVoiceManager>()
            .stop_accompaniment(&session_id)
    })
    .await
    .map_err(|err| format!("stop music capture task failed: {err}"))?
}

#[tauri::command]
pub fn native_voice_set_accompaniment_volume(
    manager: State<'_, NativeVoiceManager>,
    request: NativeVoiceAccompanimentVolumeRequest,
) -> Result<(), String> {
    manager.set_accompaniment_volume(request)
}

#[tauri::command]
pub fn native_voice_status(
    manager: State<'_, NativeVoiceManager>,
    session_id: String,
) -> Result<NativeVoiceStatus, String> {
    manager.status(&session_id)
}

#[tauri::command]
pub fn native_voice_drain_signals(
    manager: State<'_, NativeVoiceManager>,
    session_id: String,
) -> Result<Vec<NativeVoiceOutboundSignal>, String> {
    manager.drain_signals(&session_id)
}

async fn run_native_voice(
    request: NativeVoiceStartRequest,
    status: Arc<Mutex<NativeVoiceStatus>>,
    outbound_signals: Arc<Mutex<Vec<NativeVoiceOutboundSignal>>>,
    mut control_rx: tokio_mpsc::UnboundedReceiver<NativeVoiceControl>,
    startup_tx: mpsc::Sender<Result<NativeVoiceStartup, String>>,
) {
    let selected_input = trimmed_device_id(&request.input_device_id);
    let selected_output = trimmed_device_id(&request.output_device_id);
    let (capture, playback, microphone_error, backend) =
        if selected_input.is_none() && selected_output.is_none() {
            start_default_native_audio(Arc::clone(&status), &startup_tx)
        } else {
            start_selected_native_audio(
                selected_input,
                selected_output,
                Arc::clone(&status),
                &startup_tx,
            )
        };
    let Some(playback) = playback else { return };

    let audio_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_OPUS.to_owned(),
            clock_rate: SAMPLE_RATE,
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0".to_string(),
            rtcp_feedback: Vec::new(),
        },
        format!("voice-audio-{}", request.member_id),
        format!(
            "echovoice-voice-{}-{}",
            request.server_id, request.channel_id
        ),
    ));
    let accompaniment_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_OPUS.to_owned(),
            clock_rate: SAMPLE_RATE,
            channels: 2,
            sdp_fmtp_line:
                "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000;usedtx=0;cbr=0"
                    .to_string(),
            rtcp_feedback: Vec::new(),
        },
        format!("accompaniment-audio-{}", request.member_id),
        format!(
            "echovoice-accompaniment-{}-{}",
            request.server_id, request.channel_id
        ),
    ));
    let microphone_available = Arc::new(AtomicBool::new(capture.is_some()));
    let muted = Arc::new(AtomicBool::new(
        request.muted || request.deafened || capture.is_none(),
    ));
    let deafened = Arc::new(AtomicBool::new(request.deafened));
    let input_gain_percent = Arc::new(AtomicU32::new(clamp_input_gain(request.input_gain_percent)));
    let noise_suppression_mode = Arc::new(AtomicU8::new(request.noise_suppression_mode.as_u8()));
    let output_volume_percent = Arc::new(AtomicU32::new(clamp_output_volume(
        request.output_volume_percent,
    )));
    let member_volumes = Arc::new(Mutex::new(HashMap::new()));
    let member_music_volumes = Arc::new(Mutex::new(HashMap::new()));
    let accompaniment_volume_percent = Arc::new(AtomicU32::new(default_voice_volume_percent()));
    let (decoded_tx, decoded_rx) = tokio_mpsc::unbounded_channel();

    let mut capture_task = capture.map(|capture| {
        tokio::spawn(capture_and_send(
            capture,
            Arc::clone(&audio_track),
            Arc::clone(&muted),
            Arc::clone(&microphone_available),
            Arc::clone(&input_gain_percent),
            Arc::clone(&noise_suppression_mode),
            Arc::clone(&status),
        ))
    });
    let playback_task = tokio::spawn(mix_and_play(
        playback,
        decoded_rx,
        Arc::clone(&deafened),
        Arc::clone(&output_volume_percent),
        Arc::clone(&member_volumes),
        Arc::clone(&member_music_volumes),
        Arc::clone(&status),
    ));
    let mut engine = NativeVoiceEngine {
        status: Arc::clone(&status),
        outbound_signals,
        muted,
        deafened,
        microphone_available,
        input_gain_percent,
        noise_suppression_mode,
        output_volume_percent,
        member_volumes,
        member_music_volumes,
        accompaniment_volume_percent,
        audio_track,
        accompaniment_track,
        accompaniment_runtime: None,
        decoded_tx,
        peers: HashMap::new(),
        rtc_configuration: rtc_configuration(&request.ice_servers),
    };
    update_status(&status, |status| {
        status.phase = "running".to_string();
        status.backend = backend.clone();
        status.playback_backend = backend.clone();
        status.microphone_available = engine.microphone_available.load(Ordering::SeqCst);
        status.microphone_error = microphone_error;
        status.muted = engine.muted.load(Ordering::SeqCst);
        status.last_error = None;
    });
    let _ = startup_tx.send(Ok(NativeVoiceStartup { backend }));

    let mut stats_interval = tokio::time::interval(Duration::from_secs(1));
    stats_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let control = tokio::select! {
            _ = stats_interval.tick() => {
                engine.refresh_network_stats().await;
                continue;
            }
            control = control_rx.recv() => {
                let Some(control) = control else { break; };
                control
            }
        };
        match control {
            NativeVoiceControl::AddPeer {
                member_id,
                initiate,
                response,
            } => {
                let result = engine.ensure_peer(member_id, initiate).await;
                let _ = response.send(result);
            }
            NativeVoiceControl::RemovePeer {
                member_id,
                response,
            } => {
                let result = engine.remove_peer(&member_id).await;
                let _ = response.send(result);
            }
            NativeVoiceControl::HandleSignal {
                member_id,
                signal_type,
                data,
                response,
            } => {
                let result = engine.handle_signal(member_id, &signal_type, data).await;
                let _ = response.send(result);
            }
            NativeVoiceControl::SetState {
                muted,
                deafened,
                response,
            } => {
                let wants_microphone = !muted && !deafened;
                let result =
                    if wants_microphone && !engine.microphone_available.load(Ordering::SeqCst) {
                        let message = engine
                            .status
                            .lock()
                            .ok()
                            .and_then(|status| status.microphone_error.clone())
                            .unwrap_or_else(|| "native microphone is unavailable".to_string());
                        engine.muted.store(true, Ordering::SeqCst);
                        update_status(&engine.status, |status| {
                            status.muted = true;
                            status.speaking = false;
                            status.input_level = 0.0;
                        });
                        Err(message)
                    } else {
                        engine.muted.store(muted || deafened, Ordering::SeqCst);
                        engine.deafened.store(deafened, Ordering::SeqCst);
                        update_status(&engine.status, |status| {
                            status.muted = muted || deafened;
                            status.deafened = deafened;
                            if status.muted {
                                status.speaking = false;
                                status.input_level = 0.0;
                            }
                        });
                        Ok(())
                    };
                let _ = response.send(result);
            }
            NativeVoiceControl::RestartMicrophone {
                input_device_id,
                response,
            } => {
                let result = if engine.microphone_available.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    if let Some(previous_task) = capture_task.take() {
                        previous_task.abort();
                        let _ = previous_task.await;
                    }
                    match start_native_capture_for_device(
                        trimmed_device_id(&input_device_id),
                        Arc::clone(&engine.status),
                    ) {
                        Ok((capture, backend)) => {
                            engine.microphone_available.store(true, Ordering::SeqCst);
                            engine.muted.store(true, Ordering::SeqCst);
                            update_status(&engine.status, |status| {
                                status.backend = backend;
                                status.microphone_available = true;
                                status.microphone_error = None;
                                status.muted = true;
                                status.speaking = false;
                                status.input_level = 0.0;
                                status.last_error = None;
                            });
                            capture_task = Some(tokio::spawn(capture_and_send(
                                capture,
                                Arc::clone(&engine.audio_track),
                                Arc::clone(&engine.muted),
                                Arc::clone(&engine.microphone_available),
                                Arc::clone(&engine.input_gain_percent),
                                Arc::clone(&engine.noise_suppression_mode),
                                Arc::clone(&engine.status),
                            )));
                            Ok(())
                        }
                        Err(err) => {
                            let message = format!("restart native microphone: {err}");
                            mark_microphone_unavailable(
                                &engine.microphone_available,
                                &engine.muted,
                                &engine.status,
                                &message,
                            );
                            Err(message)
                        }
                    }
                };
                let _ = response.send(result);
            }
            NativeVoiceControl::SetLevels {
                input_gain_percent,
                output_volume_percent,
                response,
            } => {
                engine
                    .input_gain_percent
                    .store(clamp_input_gain(input_gain_percent), Ordering::SeqCst);
                engine
                    .output_volume_percent
                    .store(clamp_output_volume(output_volume_percent), Ordering::SeqCst);
                let _ = response.send(Ok(()));
            }
            NativeVoiceControl::SetNoiseSuppression { mode, response } => {
                engine
                    .noise_suppression_mode
                    .store(mode.as_u8(), Ordering::SeqCst);
                update_status(&engine.status, |status| {
                    status.noise_suppression_mode = mode;
                });
                let _ = response.send(Ok(()));
            }
            NativeVoiceControl::SetMemberVolume {
                member_id,
                volume_percent,
                response,
            } => {
                let result = engine
                    .member_volumes
                    .lock()
                    .map(|mut volumes| {
                        volumes.insert(member_id, clamp_member_volume(volume_percent));
                    })
                    .map_err(|_| "native voice member volumes are poisoned".to_string());
                let _ = response.send(result);
            }
            NativeVoiceControl::SetMemberMusicVolume {
                member_id,
                volume_percent,
                response,
            } => {
                let result = engine
                    .member_music_volumes
                    .lock()
                    .map(|mut volumes| {
                        volumes.insert(member_id, clamp_member_volume(volume_percent));
                    })
                    .map_err(|_| "native voice member music volumes are poisoned".to_string());
                let _ = response.send(result);
            }
            NativeVoiceControl::StartAccompaniment {
                process_id,
                volume_percent,
                response,
            } => {
                engine
                    .accompaniment_volume_percent
                    .store(clamp_member_volume(volume_percent), Ordering::SeqCst);
                let result = engine.start_accompaniment(process_id);
                let _ = response.send(result);
            }
            NativeVoiceControl::SetAccompanimentVolume {
                volume_percent,
                response,
            } => {
                engine
                    .accompaniment_volume_percent
                    .store(clamp_member_volume(volume_percent), Ordering::SeqCst);
                let _ = response.send(Ok(()));
            }
            NativeVoiceControl::StopAccompaniment { response } => {
                engine.stop_accompaniment();
                let _ = response.send(Ok(()));
            }
            NativeVoiceControl::Stop => break,
        }
    }

    update_status(&status, |status| status.phase = "stopping".to_string());
    engine.stop_accompaniment();
    engine.close_all().await;
    if let Some(capture_task) = capture_task {
        capture_task.abort();
        let _ = capture_task.await;
    }
    playback_task.abort();
    let _ = playback_task.await;
    update_status(&status, |status| {
        status.phase = "stopped".to_string();
        status.peer_count = 0;
        status.round_trip_time_ms = None;
        status.speaking = false;
        status.input_level = 0.0;
    });
}

impl NativeVoiceEngine {
    fn start_accompaniment(&mut self, process_id: u32) -> Result<(), String> {
        self.stop_accompaniment();

        #[cfg(target_os = "windows")]
        {
            use crate::windows_process_loopback::{
                ProcessLoopbackCapture, ProcessLoopbackMode, CHANNELS,
            };

            let stop_flag = Arc::new(AtomicBool::new(false));
            let worker_stop = Arc::clone(&stop_flag);
            let track = Arc::clone(&self.accompaniment_track);
            let status = Arc::clone(&self.status);
            let volume_percent = Arc::clone(&self.accompaniment_volume_percent);
            let runtime_handle = tokio::runtime::Handle::current();
            let (startup_tx, startup_rx) = mpsc::channel();
            let worker = thread::Builder::new()
                .name("ev-native-accompaniment".to_string())
                .spawn(move || {
                    let capture = match ProcessLoopbackCapture::open(
                        process_id,
                        ProcessLoopbackMode::IncludeProcessTree,
                    ) {
                        Ok(capture) => capture,
                        Err(err) => {
                            let _ = startup_tx.send(Err(err));
                            return;
                        }
                    };
                    let mut encoder = match OpusEncoder::new_audio(
                        SAMPLE_RATE,
                        ACCOMPANIMENT_CHANNELS,
                        ACCOMPANIMENT_OPUS_BITRATE as i32,
                        10,
                        true,
                        true,
                        5,
                    ) {
                        Ok(encoder) => encoder,
                        Err(err) => {
                            let _ = startup_tx
                                .send(Err(format!("create music playback Opus encoder: {err}")));
                            return;
                        }
                    };
                    let _ = startup_tx.send(Ok(()));
                    let mut captured = Vec::with_capacity(FRAME_SAMPLES * CHANNELS * 2);
                    let mut pending = VecDeque::with_capacity(FRAME_SAMPLES * CHANNELS * 4);
                    let mut frame = vec![0.0_f32; FRAME_SAMPLES * ACCOMPANIMENT_CHANNELS];
                    let mut encoded = vec![0_u8; 4096];
                    let mut fade_in_remaining =
                        ACCOMPANIMENT_FADE_IN_SAMPLES * ACCOMPANIMENT_CHANNELS;

                    while !worker_stop.load(Ordering::SeqCst) {
                        match capture.read_available(&mut captured) {
                            Ok(captured_frames) => {
                                pending.extend(captured.iter().copied());
                                while pending.len() >= FRAME_SAMPLES * ACCOMPANIMENT_CHANNELS {
                                    for sample in &mut frame {
                                        *sample = pending.pop_front().unwrap_or_default();
                                    }
                                    apply_linear_fade_in(
                                        &mut frame,
                                        &mut fade_in_remaining,
                                        ACCOMPANIMENT_FADE_IN_SAMPLES * ACCOMPANIMENT_CHANNELS,
                                    );
                                    let send_gain =
                                        volume_percent.load(Ordering::Relaxed) as f32 / 100.0;
                                    for sample in &mut frame {
                                        *sample = soft_limit(*sample * send_gain);
                                    }
                                    let packet_len = match encoder.encode_float(
                                        &frame,
                                        FRAME_SAMPLES,
                                        &mut encoded,
                                    ) {
                                        Ok(packet_len) => packet_len,
                                        Err(err) => {
                                            set_status_error(
                                                &status,
                                                &format!("encode music playback Opus audio: {err}"),
                                            );
                                            update_status(&status, |status| {
                                                status.accompaniment_active = false;
                                                status.accompaniment_process_id = None;
                                            });
                                            return;
                                        }
                                    };
                                    if runtime_handle
                                        .block_on(track.write_sample(&Sample {
                                            data: Bytes::copy_from_slice(&encoded[..packet_len]),
                                            duration: FRAME_DURATION,
                                            ..Default::default()
                                        }))
                                        .is_ok()
                                    {
                                        update_status(&status, |status| {
                                            status.accompaniment_packets =
                                                status.accompaniment_packets.saturating_add(1);
                                        });
                                    }
                                }
                                if captured_frames == 0 {
                                    thread::sleep(Duration::from_millis(3));
                                }
                            }
                            Err(err) => {
                                set_status_error(
                                    &status,
                                    &format!("capture music process audio: {err}"),
                                );
                                update_status(&status, |status| {
                                    status.accompaniment_active = false;
                                    status.accompaniment_process_id = None;
                                });
                                return;
                            }
                        }
                    }
                })
                .map_err(|err| format!("start music capture worker: {err}"))?;

            match startup_rx.recv_timeout(Duration::from_secs(6)) {
                Ok(Ok(())) => {
                    self.accompaniment_runtime = Some(NativeAccompanimentRuntime {
                        stop_flag,
                        worker: Some(worker),
                    });
                    update_status(&self.status, |status| {
                        status.accompaniment_active = true;
                        status.accompaniment_process_id = Some(process_id);
                        status.accompaniment_packets = 0;
                        status.last_error = None;
                    });
                    Ok(())
                }
                Ok(Err(err)) => {
                    stop_flag.store(true, Ordering::SeqCst);
                    let _ = worker.join();
                    Err(err)
                }
                Err(_) => {
                    stop_flag.store(true, Ordering::SeqCst);
                    let _ = worker.join();
                    Err("timed out starting music process audio capture".to_string())
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = process_id;
            Err("process music playback is currently available on Windows only".to_string())
        }
    }

    fn stop_accompaniment(&mut self) {
        self.accompaniment_runtime.take();
        update_status(&self.status, |status| {
            status.accompaniment_active = false;
            status.accompaniment_process_id = None;
        });
    }

    async fn ensure_peer(&mut self, member_id: String, initiate: bool) -> Result<(), String> {
        let now = now_ms();
        let remove_existing = self.peers.get_mut(&member_id).is_some_and(|peer| {
            match peer.peer_connection.connection_state() {
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => true,
                RTCPeerConnectionState::Disconnected => {
                    if peer.disconnected_at_ms == 0 {
                        peer.disconnected_at_ms = now;
                    }
                    now.saturating_sub(peer.disconnected_at_ms)
                        >= VOICE_PEER_DISCONNECTED_TIMEOUT_MS
                }
                _ => {
                    peer.disconnected_at_ms = 0;
                    false
                }
            }
        });
        if remove_existing {
            self.remove_peer(&member_id).await?;
        }
        if let Some(peer) = self.peers.get(&member_id) {
            if !initiate
                || peer.peer_connection.remote_description().await.is_some()
                || peer.peer_connection.local_description().await.is_some()
                || peer.peer_connection.signaling_state() != RTCSignalingState::Stable
            {
                return Ok(());
            }
            let peer_connection = Arc::clone(&peer.peer_connection);
            let offer = peer_connection
                .create_offer(None)
                .await
                .map_err(|err| format!("create native voice offer: {err}"))?;
            peer_connection
                .set_local_description(offer.clone())
                .await
                .map_err(|err| format!("set native voice local offer: {err}"))?;
            let mut offer = peer_connection.local_description().await.unwrap_or(offer);
            offer.sdp = enhance_accompaniment_opus_sdp(&offer.sdp);
            push_outbound_signal(
                &self.outbound_signals,
                member_id.clone(),
                "offer",
                json!(offer),
            );
            return Ok(());
        }
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_default_codecs()
            .map_err(|err| format!("register native voice codecs: {err}"))?;
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)
            .map_err(|err| format!("register native voice interceptors: {err}"))?;
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();
        let peer_connection = Arc::new(
            api.new_peer_connection(self.rtc_configuration.clone())
                .await
                .map_err(|err| format!("create native voice peer connection: {err}"))?,
        );

        self.install_peer_callbacks(&member_id, &peer_connection);
        let rtp_sender = peer_connection
            .add_track(Arc::clone(&self.audio_track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|err| format!("add native voice Opus track: {err}"))?;
        spawn_rtcp_reader(rtp_sender);
        let accompaniment_sender = peer_connection
            .add_track(Arc::clone(&self.accompaniment_track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|err| format!("add native music playback Opus track: {err}"))?;
        spawn_rtcp_reader(accompaniment_sender);
        self.peers.insert(
            member_id.clone(),
            NativeVoicePeer {
                peer_connection: Arc::clone(&peer_connection),
                pending_ice: Vec::new(),
                disconnected_at_ms: 0,
            },
        );
        self.refresh_peer_count();

        if initiate {
            let offer = peer_connection
                .create_offer(None)
                .await
                .map_err(|err| format!("create native voice offer: {err}"))?;
            peer_connection
                .set_local_description(offer.clone())
                .await
                .map_err(|err| format!("set native voice local offer: {err}"))?;
            let mut offer = peer_connection.local_description().await.unwrap_or(offer);
            offer.sdp = enhance_accompaniment_opus_sdp(&offer.sdp);
            push_outbound_signal(
                &self.outbound_signals,
                member_id.clone(),
                "offer",
                json!(offer),
            );
        }
        Ok(())
    }

    fn install_peer_callbacks(&self, member_id: &str, peer_connection: &Arc<RTCPeerConnection>) {
        let ice_member_id = member_id.to_string();
        let ice_outbound = Arc::clone(&self.outbound_signals);
        peer_connection.on_ice_candidate(Box::new(move |candidate: Option<RTCIceCandidate>| {
            let member_id = ice_member_id.clone();
            let outbound = Arc::clone(&ice_outbound);
            Box::pin(async move {
                let Some(candidate) = candidate else {
                    return;
                };
                if let Ok(mut candidate) = candidate.to_json() {
                    if candidate.sdp_mid.as_deref() == Some("") {
                        candidate.sdp_mid = Some("0".to_string());
                    }
                    if candidate.sdp_mline_index.is_none() {
                        candidate.sdp_mline_index = Some(0);
                    }
                    push_outbound_signal(&outbound, member_id, "ice-candidate", json!(candidate));
                }
            })
        }));

        let track_member_id = member_id.to_string();
        let decoded_tx = self.decoded_tx.clone();
        let track_status = Arc::clone(&self.status);
        peer_connection.on_track(Box::new(move |track, _, transceiver| {
            let member_id = track_member_id.clone();
            let track_id = track.id();
            let transceiver_mid = transceiver.mid().map(|mid| mid.to_string());
            let is_accompaniment = track_id.starts_with("accompaniment-audio-")
                || transceiver_mid.as_deref().is_some_and(|mid| mid != "0");
            let source_id = format!("{}:{}:{}", member_id, track_id, track.tid());
            let decoded_tx = decoded_tx.clone();
            let status = Arc::clone(&track_status);
            Box::pin(async move {
                let decoder_channels = if is_accompaniment {
                    ACCOMPANIMENT_CHANNELS
                } else {
                    1
                };
                let mut decoder = match OpusDecoder::new(SAMPLE_RATE, decoder_channels) {
                    Ok(decoder) => decoder,
                    Err(err) => {
                        set_status_error(&status, &format!("create Opus decoder: {err:?}"));
                        return;
                    }
                };
                let mut pcm = vec![0.0_f32; 5760 * decoder_channels];
                let mut expected_sequence_number = None;
                let mut previous_audio_end = None;
                let mut previous_payload_was_silence = true;
                while let Ok((packet, _)) = track.read_rtp().await {
                    update_status(&status, |status| {
                        status.received_packets = status.received_packets.saturating_add(1);
                        status.last_receive_at_ms = now_ms();
                    });
                    let sequence_number = packet.header.sequence_number;
                    let payload_kind = classify_incoming_opus_payload(&packet.payload);
                    if let Some(expected) = expected_sequence_number {
                        let Some(missing_packets) = rtp_forward_gap(expected, sequence_number)
                        else {
                            continue;
                        };
                        if missing_packets > 0 {
                            update_status(&status, |status| {
                                status.dropped_frames =
                                    status.dropped_frames.saturating_add(missing_packets as u64);
                            });
                            if payload_kind == IncomingOpusPayloadKind::Audio
                                && !previous_payload_was_silence
                            {
                                let missing_samples = previous_audio_end
                                    .map(|end| packet.header.timestamp.wrapping_sub(end) as usize);
                                let count = if missing_samples == Some(0) {
                                    0
                                } else {
                                    missing_packets.min(MAX_PACKET_LOSS_CONCEALMENT_FRAMES)
                                };
                                for _ in 0..count {
                                    match recover_lost_opus(
                                        &mut decoder,
                                        &packet.payload,
                                        &mut pcm,
                                        missing_packets,
                                        missing_samples,
                                    ) {
                                        Ok(sample_count) if sample_count > 0 => {
                                            if decoded_tx
                                                .send(DecodedAudio {
                                                    member_id: member_id.clone(),
                                                    source_id: source_id.clone(),
                                                    is_accompaniment,
                                                    samples: opus_frame_to_stereo(
                                                        &pcm,
                                                        sample_count,
                                                        decoder_channels,
                                                    ),
                                                })
                                                .is_err()
                                            {
                                                return;
                                            }
                                        }
                                        Ok(_) => {}
                                        Err(err) => set_status_error(
                                            &status,
                                            &format!("conceal lost Opus packet: {err:?}"),
                                        ),
                                    }
                                }
                            }
                        }
                    }
                    expected_sequence_number = Some(sequence_number.wrapping_add(1));

                    match payload_kind {
                        IncomingOpusPayloadKind::Padding => continue,
                        IncomingOpusPayloadKind::DiscontinuousSilence => {
                            previous_payload_was_silence = true;
                            if let Err(err) =
                                decoder.decode_float(&packet.payload, &mut pcm, 5760, false)
                            {
                                set_status_error(
                                    &status,
                                    &format!("decode Opus DTX packet: {err:?}"),
                                );
                            }
                            continue;
                        }
                        IncomingOpusPayloadKind::Audio => {
                            previous_payload_was_silence = false;
                        }
                    }
                    match decoder.decode_float(&packet.payload, &mut pcm, 5760, false) {
                        Ok(sample_count) if sample_count > 0 => {
                            previous_audio_end =
                                Some(packet.header.timestamp.wrapping_add(sample_count as u32));
                            update_status(&status, |status| {
                                status.decoded_frames = status.decoded_frames.saturating_add(1);
                            });
                            if decoded_tx
                                .send(DecodedAudio {
                                    member_id: member_id.clone(),
                                    source_id: source_id.clone(),
                                    is_accompaniment,
                                    samples: opus_frame_to_stereo(
                                        &pcm,
                                        sample_count,
                                        decoder_channels,
                                    ),
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        Ok(_) => {}
                        Err(err) => {
                            set_status_error(&status, &format!("decode Opus packet: {err:?}"))
                        }
                    }
                }
            })
        }));

        let state_status = Arc::clone(&self.status);
        peer_connection.on_peer_connection_state_change(Box::new(
            move |state: RTCPeerConnectionState| {
                let status = Arc::clone(&state_status);
                Box::pin(async move {
                    if matches!(state, RTCPeerConnectionState::Failed) {
                        set_status_error(&status, "native voice peer connection failed");
                    }
                })
            },
        ));
        let ice_status = Arc::clone(&self.status);
        peer_connection.on_ice_connection_state_change(Box::new(
            move |state: RTCIceConnectionState| {
                let status = Arc::clone(&ice_status);
                Box::pin(async move {
                    if matches!(state, RTCIceConnectionState::Failed) {
                        set_status_error(&status, "native voice ICE connection failed");
                    }
                })
            },
        ));
        let gathering_status = Arc::clone(&self.status);
        peer_connection.on_ice_gathering_state_change(Box::new(
            move |state: RTCIceGathererState| {
                let status = Arc::clone(&gathering_status);
                Box::pin(async move {
                    if matches!(state, RTCIceGathererState::Complete) {
                        update_status(&status, |status| {
                            if status.last_error.as_deref()
                                == Some("native voice ICE gathering failed")
                            {
                                status.last_error = None;
                            }
                        });
                    }
                })
            },
        ));
    }

    async fn handle_signal(
        &mut self,
        member_id: String,
        signal_type: &str,
        data: serde_json::Value,
    ) -> Result<(), String> {
        if !self.peers.contains_key(&member_id) {
            self.ensure_peer(member_id.clone(), false).await?;
        }
        match signal_type {
            "offer" => {
                let description: RTCSessionDescription = serde_json::from_value(data)
                    .map_err(|err| format!("parse native voice offer: {err}"))?;
                let peer = self
                    .peers
                    .get_mut(&member_id)
                    .ok_or_else(|| "native voice peer was not found".to_string())?;
                let signaling_state = peer.peer_connection.signaling_state();
                let duplicate_offer =
                    peer.peer_connection
                        .remote_description()
                        .await
                        .is_some_and(|remote| {
                            remote.sdp_type == RTCSdpType::Offer && remote.sdp == description.sdp
                        });
                if duplicate_offer {
                    if let Some(answer) = peer
                        .peer_connection
                        .local_description()
                        .await
                        .filter(|local| local.sdp_type == RTCSdpType::Answer)
                    {
                        push_outbound_signal(
                            &self.outbound_signals,
                            member_id,
                            "answer",
                            json!(answer),
                        );
                        return Ok(());
                    }
                    if signaling_state != RTCSignalingState::HaveRemoteOffer {
                        return Ok(());
                    }
                } else {
                    if signaling_state != RTCSignalingState::Stable {
                        return Ok(());
                    }
                    peer.peer_connection
                        .set_remote_description(description)
                        .await
                        .map_err(|err| format!("apply native voice offer: {err}"))?;
                }
                apply_pending_ice(peer).await;
                if peer.peer_connection.signaling_state() != RTCSignalingState::HaveRemoteOffer {
                    return Ok(());
                }
                let answer = peer
                    .peer_connection
                    .create_answer(None)
                    .await
                    .map_err(|err| format!("create native voice answer: {err}"))?;
                peer.peer_connection
                    .set_local_description(answer.clone())
                    .await
                    .map_err(|err| format!("set native voice local answer: {err}"))?;
                let mut answer = peer
                    .peer_connection
                    .local_description()
                    .await
                    .unwrap_or(answer);
                answer.sdp = enhance_accompaniment_opus_sdp(&answer.sdp);
                push_outbound_signal(&self.outbound_signals, member_id, "answer", json!(answer));
            }
            "answer" => {
                let description: RTCSessionDescription = serde_json::from_value(data)
                    .map_err(|err| format!("parse native voice answer: {err}"))?;
                let peer = self
                    .peers
                    .get_mut(&member_id)
                    .ok_or_else(|| "native voice peer was not found".to_string())?;
                if peer
                    .peer_connection
                    .remote_description()
                    .await
                    .is_some_and(|remote| {
                        remote.sdp_type == RTCSdpType::Answer && remote.sdp == description.sdp
                    })
                {
                    return Ok(());
                }
                if peer.peer_connection.signaling_state() != RTCSignalingState::HaveLocalOffer {
                    return Ok(());
                }
                peer.peer_connection
                    .set_remote_description(description)
                    .await
                    .map_err(|err| format!("apply native voice answer: {err}"))?;
                apply_pending_ice(peer).await;
            }
            "ice-candidate" => {
                if data.is_null() {
                    return Ok(());
                }
                let candidate: RTCIceCandidateInit = serde_json::from_value(data)
                    .map_err(|err| format!("parse native voice ICE candidate: {err}"))?;
                let peer = self
                    .peers
                    .get_mut(&member_id)
                    .ok_or_else(|| "native voice peer was not found".to_string())?;
                if peer.peer_connection.remote_description().await.is_some() {
                    let _ = peer.peer_connection.add_ice_candidate(candidate).await;
                } else {
                    peer.pending_ice.push(candidate);
                }
            }
            _ => {}
        }
        update_status(&self.status, |status| status.last_error = None);
        Ok(())
    }

    async fn remove_peer(&mut self, member_id: &str) -> Result<(), String> {
        if let Some(peer) = self.peers.remove(member_id) {
            peer.peer_connection
                .close()
                .await
                .map_err(|err| format!("close native voice peer: {err}"))?;
        }
        self.refresh_peer_count();
        Ok(())
    }

    async fn close_all(&mut self) {
        let peers = self.peers.drain().map(|(_, peer)| peer).collect::<Vec<_>>();
        for peer in peers {
            let _ = peer.peer_connection.close().await;
        }
        self.refresh_peer_count();
    }

    fn refresh_peer_count(&self) {
        update_status(&self.status, |status| status.peer_count = self.peers.len());
    }

    async fn refresh_network_stats(&self) {
        let mut maximum_rtt_ms = None;
        for peer in self.peers.values() {
            let report = peer.peer_connection.get_stats().await;
            for item in report.reports.values() {
                let StatsReportType::CandidatePair(pair) = item else {
                    continue;
                };
                if !pair.nominated
                    || !pair.current_round_trip_time.is_finite()
                    || pair.current_round_trip_time < 0.0
                {
                    continue;
                }
                let rtt_ms = (pair.current_round_trip_time * 1000.0)
                    .round()
                    .clamp(0.0, u32::MAX as f64) as u32;
                maximum_rtt_ms =
                    Some(maximum_rtt_ms.map_or(rtt_ms, |current: u32| current.max(rtt_ms)));
            }
        }
        update_status(&self.status, |status| {
            status.round_trip_time_ms = maximum_rtt_ms
        });
    }
}

async fn apply_pending_ice(peer: &mut NativeVoicePeer) {
    for candidate in peer.pending_ice.drain(..) {
        let _ = peer.peer_connection.add_ice_candidate(candidate).await;
    }
}

async fn capture_and_send(
    mut capture: NativeCapture,
    audio_track: Arc<TrackLocalStaticSample>,
    muted: Arc<AtomicBool>,
    microphone_available: Arc<AtomicBool>,
    input_gain_percent: Arc<AtomicU32>,
    noise_suppression_mode: Arc<AtomicU8>,
    status: Arc<Mutex<NativeVoiceStatus>>,
) {
    let mut encoder = match create_voice_opus_encoder() {
        Ok(encoder) => encoder,
        Err(err) => {
            set_status_error(&status, &format!("create Opus encoder: {err}"));
            return;
        }
    };
    let mut encoded = vec![0_u8; 1200];
    let mut frame = Vec::with_capacity(FRAME_SAMPLES);
    let mut samples = VecDeque::with_capacity(FRAME_SAMPLES * 3);
    let mut speaking_frames = 0_u8;
    let mut silent_frames = 0_u8;
    let mut noise_suppressor = NativeNoiseSuppressor::new();

    while let Some(chunk) = capture.recv().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                mark_microphone_unavailable(
                    &microphone_available,
                    &muted,
                    &status,
                    &format!("native audio capture failed: {err}"),
                );
                break;
            }
        };
        samples.extend(chunk.into_iter().map(|sample| sample.clamp(-1.0, 1.0)));
        while samples.len() >= FRAME_SAMPLES {
            frame.clear();
            frame.extend(samples.drain(..FRAME_SAMPLES));
            let suppression_mode =
                VoiceNoiseSuppressionMode::from_u8(noise_suppression_mode.load(Ordering::Relaxed));
            noise_suppressor.process(suppression_mode, &mut frame);
            let input_gain = input_gain_percent.load(Ordering::Relaxed) as f32 / 100.0;
            frame
                .iter_mut()
                .for_each(|sample| *sample = (*sample * input_gain).clamp(-1.0, 1.0));
            let rms = frame_rms(&frame);
            let is_muted = muted.load(Ordering::SeqCst);
            if !is_muted && rms >= SPEAKING_START_RMS {
                speaking_frames = speaking_frames.saturating_add(1);
                silent_frames = 0;
            } else if is_muted || rms <= SPEAKING_STOP_RMS {
                silent_frames = silent_frames.saturating_add(1);
                speaking_frames = 0;
            }
            update_status(&status, |status| {
                status.captured_frames = status.captured_frames.saturating_add(1);
                status.last_capture_at_ms = now_ms();
                status.input_level = if is_muted { 0.0 } else { rms.min(1.0) };
                if !is_muted && speaking_frames >= 3 {
                    status.speaking = true;
                } else if is_muted || silent_frames >= 10 {
                    status.speaking = false;
                }
            });
            if is_muted {
                continue;
            }
            if status
                .lock()
                .map(|status| status.peer_count == 0)
                .unwrap_or(true)
            {
                continue;
            }
            match encoder.encode_float(&frame, FRAME_SAMPLES, &mut encoded) {
                Ok(packet_len) => match audio_track
                    .write_sample(&Sample {
                        data: Bytes::copy_from_slice(&encoded[..packet_len]),
                        duration: FRAME_DURATION,
                        ..Default::default()
                    })
                    .await
                {
                    Ok(_) => update_status(&status, |status| {
                        status.encoded_packets = status.encoded_packets.saturating_add(1);
                    }),
                    Err(err) => {
                        set_status_error(&status, &format!("send native Opus sample: {err}"))
                    }
                },
                Err(err) => {
                    set_status_error(&status, &format!("encode native Opus frame: {err:?}"))
                }
            }
        }
    }
    if microphone_available.load(Ordering::SeqCst) {
        mark_microphone_unavailable(
            &microphone_available,
            &muted,
            &status,
            "native audio capture stopped",
        );
    }
}

fn create_voice_opus_encoder() -> Result<OpusEncoder, String> {
    OpusEncoder::new(SAMPLE_RATE, 1, OPUS_BITRATE as i32, 8, true, true, 10)
}

fn enhance_accompaniment_opus_sdp(sdp: &str) -> String {
    let mut audio_section_index = 0;
    sdp.split("\r\nm=")
        .enumerate()
        .map(|(index, section)| {
            let mut normalized = if index == 0 {
                section.to_string()
            } else {
                format!("m={section}")
            };
            if !normalized.starts_with("m=audio ") {
                return normalized;
            }
            audio_section_index += 1;
            if audio_section_index != 2 {
                return normalized;
            }
            let Some(payload) = normalized.lines().find_map(|line| {
                let rest = line.strip_prefix("a=rtpmap:")?;
                let (payload, codec) = rest.split_once(' ')?;
                codec
                    .eq_ignore_ascii_case("opus/48000/2")
                    .then(|| payload.to_string())
            }) else {
                return normalized;
            };
            let prefix = format!("a=fmtp:{payload} ");
            let controlled = [
                "stereo",
                "sprop-stereo",
                "maxaveragebitrate",
                "useinbandfec",
                "usedtx",
                "cbr",
            ];
            let parameters = normalized.lines().find_map(|line| {
                line.strip_prefix(&prefix).map(|value| {
                    value
                        .split(';')
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .filter(|value| {
                            let key = value.split('=').next().unwrap_or_default();
                            !controlled
                                .iter()
                                .any(|candidate| key.eq_ignore_ascii_case(candidate))
                        })
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
            });
            let mut parameters = parameters.unwrap_or_default();
            parameters.extend([
                "stereo=1".to_string(),
                "sprop-stereo=1".to_string(),
                "maxaveragebitrate=256000".to_string(),
                "useinbandfec=1".to_string(),
                "usedtx=0".to_string(),
                "cbr=0".to_string(),
            ]);
            let replacement = format!("{prefix}{}", parameters.join(";"));
            if normalized.lines().any(|line| line.starts_with(&prefix)) {
                normalized = normalized
                    .lines()
                    .map(|line| {
                        if line.starts_with(&prefix) {
                            replacement.as_str()
                        } else {
                            line
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\r\n");
            } else {
                normalized.push_str("\r\n");
                normalized.push_str(&replacement);
            }
            normalized
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

struct NativeNoiseSuppressor {
    mode: VoiceNoiseSuppressionMode,
    denoiser: Box<DenoiseState<'static>>,
    rnnoise_warm: bool,
    light_gate_gain: f32,
    strong_gate_gain: f32,
    high_pass_previous_input: f32,
    high_pass_previous_output: f32,
}

impl NativeNoiseSuppressor {
    fn new() -> Self {
        Self {
            mode: VoiceNoiseSuppressionMode::Off,
            denoiser: DenoiseState::new(),
            rnnoise_warm: false,
            light_gate_gain: 1.0,
            strong_gate_gain: 1.0,
            high_pass_previous_input: 0.0,
            high_pass_previous_output: 0.0,
        }
    }

    fn process(&mut self, mode: VoiceNoiseSuppressionMode, frame: &mut [f32]) {
        if mode != self.mode {
            self.mode = mode;
            self.denoiser = DenoiseState::new();
            self.rnnoise_warm = false;
            self.light_gate_gain = 1.0;
            self.strong_gate_gain = 1.0;
            self.high_pass_previous_input = 0.0;
            self.high_pass_previous_output = 0.0;
        }

        match mode {
            VoiceNoiseSuppressionMode::Off => {}
            VoiceNoiseSuppressionMode::Light => self.process_light(frame),
            VoiceNoiseSuppressionMode::Standard => {
                self.process_rnnoise(frame, false);
            }
            VoiceNoiseSuppressionMode::Strong => {
                self.process_rnnoise(frame, true);
            }
        }
    }

    fn process_light(&mut self, frame: &mut [f32]) {
        const HIGH_PASS_ALPHA: f32 = 0.9896;
        for sample in frame.iter_mut() {
            let input = *sample;
            let output = HIGH_PASS_ALPHA
                * (self.high_pass_previous_output + input - self.high_pass_previous_input);
            self.high_pass_previous_input = input;
            self.high_pass_previous_output = output;
            *sample = output;
        }

        let rms = frame_rms(frame);
        let target_gain = if rms >= 0.006 { 1.0 } else { 0.32 };
        let smoothing = if target_gain > self.light_gate_gain {
            0.7
        } else {
            0.08
        };
        self.light_gate_gain += (target_gain - self.light_gate_gain) * smoothing;
        for sample in frame {
            *sample *= self.light_gate_gain;
        }
    }

    fn process_rnnoise(&mut self, frame: &mut [f32], strong: bool) {
        let mut vad_total = 0.0;
        let mut chunks = 0_u32;
        for chunk in frame.chunks_exact_mut(DenoiseState::FRAME_SIZE) {
            let mut input = [0.0_f32; DenoiseState::FRAME_SIZE];
            let mut output = [0.0_f32; DenoiseState::FRAME_SIZE];
            for (target, sample) in input.iter_mut().zip(chunk.iter()) {
                *target = (*sample * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32);
            }
            vad_total += self.denoiser.process_frame(&mut output, &input);
            chunks += 1;
            if self.rnnoise_warm {
                for (target, sample) in chunk.iter_mut().zip(output.iter()) {
                    *target = (*sample / i16::MAX as f32).clamp(-1.0, 1.0);
                }
            } else {
                chunk.fill(0.0);
                self.rnnoise_warm = true;
            }
        }

        if !strong || chunks == 0 {
            return;
        }
        let vad_probability = vad_total / chunks as f32;
        let target_gain = if vad_probability >= 0.55 {
            1.0
        } else if vad_probability <= 0.18 {
            0.08
        } else {
            0.08 + (vad_probability - 0.18) / 0.37 * 0.92
        };
        let smoothing = if target_gain > self.strong_gate_gain {
            0.8
        } else {
            0.12
        };
        self.strong_gate_gain += (target_gain - self.strong_gate_gain) * smoothing;
        for sample in frame {
            *sample *= self.strong_gate_gain;
        }
    }
}

fn rtp_forward_gap(expected: u16, actual: u16) -> Option<usize> {
    let distance = actual.wrapping_sub(expected);
    (distance < 0x8000).then_some(distance as usize)
}

// With one missing packet, RTP gives its exact duration and the following Opus
// packet can carry its redundant audio. libopus falls back to concealment when
// that packet has no FEC. Decode the current packet normally afterwards.
fn recover_lost_opus(
    decoder: &mut OpusDecoder,
    following_packet: &[u8],
    pcm: &mut [f32],
    missing_packets: usize,
    missing_samples: Option<usize>,
) -> Result<usize, String> {
    if missing_packets == 1 {
        if let Some(duration) = missing_samples.filter(|n| (120..=5760).contains(n) && n % 120 == 0)
        {
            return decoder.decode_float(following_packet, pcm, duration, true);
        }
    }
    decoder.decode_float(&[], pcm, FRAME_SAMPLES, false)
}

fn apply_linear_fade_in(samples: &mut [f32], remaining: &mut usize, total: usize) {
    if *remaining == 0 || total == 0 {
        return;
    }
    let completed = total.saturating_sub(*remaining);
    let fade_samples = (*remaining).min(samples.len());
    for (index, sample) in samples.iter_mut().take(fade_samples).enumerate() {
        *sample *= (completed + index + 1) as f32 / total as f32;
    }
    *remaining -= fade_samples;
}

fn classify_incoming_opus_payload(payload: &[u8]) -> IncomingOpusPayloadKind {
    match payload.len() {
        0 => IncomingOpusPayloadKind::Padding,
        1 => IncomingOpusPayloadKind::DiscontinuousSilence,
        _ => IncomingOpusPayloadKind::Audio,
    }
}

impl VoicePlayoutQueue {
    fn push(&mut self, samples: Vec<f32>) -> usize {
        self.samples.extend(samples);
        let dropped = self.samples.len().saturating_sub(MAX_DECODED_QUEUE_SAMPLES);
        if dropped > 0 {
            let aligned_dropped =
                (dropped + PLAYBACK_CHANNELS - 1) / PLAYBACK_CHANNELS * PLAYBACK_CHANNELS;
            self.samples
                .drain(..aligned_dropped.min(self.samples.len()));
            self.needs_fade_in = true;
        }
        if !self.started
            && self.samples.len() >= FRAME_SAMPLES * PLAYBACK_CHANNELS * PLAYOUT_PREBUFFER_FRAMES
        {
            self.started = true;
            self.needs_fade_in = true;
            self.underflow_frames = 0;
        }
        dropped
    }

    fn has_complete_frame(&self) -> bool {
        self.samples.len() >= FRAME_SAMPLES * PLAYBACK_CHANNELS
    }

    fn take_frame(&mut self) -> Option<Vec<f32>> {
        if !self.started {
            return None;
        }
        if self.has_complete_frame() {
            let mut frame = self
                .samples
                .drain(..FRAME_SAMPLES * PLAYBACK_CHANNELS)
                .collect::<Vec<_>>();
            let boundary_discontinuity = (0..PLAYBACK_CHANNELS).any(|channel| {
                let current = frame.get(channel).copied().unwrap_or_default();
                let next = frame
                    .get(PLAYBACK_CHANNELS + channel)
                    .copied()
                    .unwrap_or(current);
                let previous_slope = self.last_frame[channel] - self.previous_frame[channel];
                let jump = current - self.last_frame[channel];
                jump.abs() >= 0.08 && previous_slope.abs() < 0.06 && (next - current).abs() < 0.06
            });
            if self.needs_fade_in || self.underflow_frames > 0 || boundary_discontinuity {
                let fade_frames = PLAYOUT_FADE_SAMPLES.min(FRAME_SAMPLES);
                for (index, samples) in frame
                    .chunks_exact_mut(PLAYBACK_CHANNELS)
                    .take(fade_frames)
                    .enumerate()
                {
                    let progress = (index + 1) as f32 / fade_frames as f32;
                    for channel in 0..PLAYBACK_CHANNELS {
                        samples[channel] = self.last_frame[channel]
                            + (samples[channel] - self.last_frame[channel]) * progress;
                    }
                }
                self.needs_fade_in = false;
                self.underflow_frames = 0;
            }
            self.previous_frame = self.last_frame;
            self.last_frame = [
                frame
                    .get(frame.len().saturating_sub(2))
                    .copied()
                    .unwrap_or_default(),
                frame.last().copied().unwrap_or_default(),
            ];
            return Some(frame);
        }

        self.underflow_frames = self.underflow_frames.saturating_add(1);
        let mut frame = vec![0.0_f32; FRAME_SAMPLES * PLAYBACK_CHANNELS];
        let fade_frames = PLAYOUT_FADE_SAMPLES.min(FRAME_SAMPLES);
        for (index, samples) in frame
            .chunks_exact_mut(PLAYBACK_CHANNELS)
            .take(fade_frames)
            .enumerate()
        {
            let remaining = 1.0 - (index + 1) as f32 / fade_frames as f32;
            for channel in 0..PLAYBACK_CHANNELS {
                samples[channel] = self.last_frame[channel] * remaining;
            }
        }
        self.previous_frame = self.last_frame;
        self.last_frame = [0.0; PLAYBACK_CHANNELS];
        if self.underflow_frames >= PLAYOUT_IDLE_RESET_FRAMES {
            self.reset();
        }
        Some(frame)
    }

    fn reset(&mut self) {
        self.samples.clear();
        self.started = false;
        self.needs_fade_in = false;
        self.previous_frame = [0.0; PLAYBACK_CHANNELS];
        self.last_frame = [0.0; PLAYBACK_CHANNELS];
        self.underflow_frames = 0;
    }
}

fn queue_decoded_audio(
    queues: &mut HashMap<(String, String, bool), VoicePlayoutQueue>,
    packet: DecodedAudio,
) -> usize {
    queues
        .entry((packet.member_id, packet.source_id, packet.is_accompaniment))
        .or_default()
        .push(packet.samples)
}

async fn mix_and_play(
    playback: NativePlayback,
    mut decoded_rx: tokio_mpsc::UnboundedReceiver<DecodedAudio>,
    deafened: Arc<AtomicBool>,
    output_volume_percent: Arc<AtomicU32>,
    member_volumes: Arc<Mutex<HashMap<String, u32>>>,
    member_music_volumes: Arc<Mutex<HashMap<String, u32>>>,
    status: Arc<Mutex<NativeVoiceStatus>>,
) {
    let mut queues: HashMap<(String, String, bool), VoicePlayoutQueue> = HashMap::new();
    let mut current_mix_gain = 1.0_f32;
    let mut interval = tokio::time::interval(Duration::from_millis(5));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            packet = decoded_rx.recv() => {
                let Some(packet) = packet else { break; };
                if queue_decoded_audio(&mut queues, packet) > 0 {
                    update_status(&status, |status| {
                        status.dropped_frames = status.dropped_frames.saturating_add(1);
                    });
                }
            }
            _ = interval.tick() => {
                while let Ok(packet) = decoded_rx.try_recv() {
                    if queue_decoded_audio(&mut queues, packet) > 0 {
                        update_status(&status, |status| {
                            status.dropped_frames = status.dropped_frames.saturating_add(1);
                        });
                    }
                }
                if deafened.load(Ordering::SeqCst) {
                    for queue in queues.values_mut() {
                        queue.reset();
                    }
                    if let Err(err) = playback.clear() {
                        set_fatal_status(&status, &format!("clear native playback: {err}"));
                        break;
                    }
                    continue;
                }
                let member_volume_snapshot = member_volumes
                    .lock()
                    .map(|volumes| volumes.clone())
                    .unwrap_or_default();
                let member_music_volume_snapshot = member_music_volumes
                    .lock()
                    .map(|volumes| volumes.clone())
                    .unwrap_or_default();
                for _ in 0..PLAYBACK_TARGET_FRAMES {
                    let buffered_samples = match playback.buffered_samples() {
                        Ok(samples) => samples,
                        Err(err) => {
                            set_fatal_status(&status, &format!("inspect native playback: {err}"));
                            return;
                        }
                    };
                    let active = queues.values().filter(|queue| queue.started).count();
                    if active == 0 {
                        current_mix_gain = 1.0;
                        break;
                    }
                    if buffered_samples >= FRAME_SAMPLES * PLAYBACK_TARGET_FRAMES {
                        break;
                    }
                    let has_complete_frame = queues
                        .values()
                        .any(|queue| queue.started && queue.has_complete_frame());
                    if !has_complete_frame && buffered_samples >= FRAME_SAMPLES * PLAYBACK_MIN_FRAMES {
                        break;
                    }

                    let target_mix_gain = 1.0 / (active as f32).sqrt();
                    current_mix_gain += (target_mix_gain - current_mix_gain) * 0.2;
                    let mut mixed = vec![0.0_f32; FRAME_SAMPLES * PLAYBACK_CHANNELS];
                    for ((member_id, _, is_accompaniment), queue) in queues
                        .iter_mut()
                        .filter(|(_, queue)| queue.started)
                    {
                        let Some(frame) = queue.take_frame() else { continue; };
                        let member_gain = (if *is_accompaniment {
                            &member_music_volume_snapshot
                        } else {
                            &member_volume_snapshot
                        })
                            .get(member_id)
                            .copied()
                            .unwrap_or(default_voice_volume_percent()) as f32
                            / 100.0;
                        for (mixed_sample, source_sample) in mixed.iter_mut().zip(frame) {
                            *mixed_sample += source_sample * current_mix_gain * member_gain;
                        }
                    }
                    let output_gain = output_volume_percent.load(Ordering::Relaxed) as f32 / 100.0;
                    for sample in &mut mixed {
                        *sample = soft_limit(*sample) * output_gain;
                    }
                    match playback.send(mixed).await {
                        Ok(_) => update_status(&status, |status| {
                            status.played_frames = status.played_frames.saturating_add(1);
                        }),
                        Err(err) => {
                            set_fatal_status(&status, &format!("native audio playback failed: {err}"));
                            return;
                        }
                    }
                }
                queues.retain(|_, queue| queue.started || !queue.samples.is_empty());
            }
        }
    }
}

impl NativePlayback {
    async fn send(&self, samples: Vec<f32>) -> Result<(), String> {
        match self {
            Self::OutputOnly(playback) => playback.enqueue(samples),
        }
    }

    fn buffered_samples(&self) -> Result<usize, String> {
        match self {
            Self::OutputOnly(playback) => playback.buffered_samples(),
        }
    }

    fn clear(&self) -> Result<(), String> {
        match self {
            Self::OutputOnly(playback) => playback.clear(),
        }
    }
}

impl NativeCapture {
    async fn recv(&mut self) -> Option<Result<Vec<f32>, String>> {
        match self {
            Self::EchoCancelled(capture) => capture
                .recv()
                .await
                .map(|result| result.map_err(|err| err.to_string())),
            Self::Direct(capture) => capture.receiver.recv().await,
        }
    }
}

impl CpalCapture {
    fn new(device_id: Option<&str>, status: Arc<Mutex<NativeVoiceStatus>>) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = resolve_input_device(&host, device_id)?;
        let supported = device
            .default_input_config()
            .map_err(|err| format!("load input configuration: {err}"))?;
        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.into();
        if config.channels == 0 || config.sample_rate == 0 {
            return Err("input configuration is invalid".to_string());
        }
        let (sender, receiver) = tokio_mpsc::unbounded_channel();
        let stream = build_cpal_input_stream(&device, config, sample_format, sender, status)?;
        stream
            .play()
            .map_err(|err| format!("start input stream: {err}"))?;
        Ok(Self {
            _stream: stream,
            receiver,
        })
    }
}

impl CpalCaptureBuffer {
    fn push(&mut self, input: impl IntoIterator<Item = f32>, source_sample_rate: u32) -> Vec<f32> {
        self.samples.extend(input);
        let mut output = Vec::new();
        let step = source_sample_rate.max(1) as f64 / SAMPLE_RATE as f64;
        while self.samples.len() >= 2 {
            let first = self.samples[0];
            let second = self.samples[1];
            output.push(first + (second - first) * self.source_position as f32);
            self.source_position += step;
            while self.source_position >= 1.0 && self.samples.len() >= 2 {
                self.samples.pop_front();
                self.source_position -= 1.0;
            }
        }
        output
    }
}

fn resolve_input_device(
    host: &cpal::Host,
    device_id: Option<&str>,
) -> Result<cpal::Device, String> {
    if let Some(device_id) = device_id {
        let id = device_id
            .parse::<cpal::DeviceId>()
            .map_err(|err| format!("invalid input device id: {err}"))?;
        return host
            .device_by_id(&id)
            .filter(DeviceTrait::supports_input)
            .ok_or_else(|| format!("input device was not found: {device_id}"));
    }
    host.default_input_device()
        .ok_or_else(|| "default input device was not found".to_string())
}

fn resolve_output_device(
    host: &cpal::Host,
    device_id: Option<&str>,
) -> Result<cpal::Device, String> {
    if let Some(device_id) = device_id {
        let id = device_id
            .parse::<cpal::DeviceId>()
            .map_err(|err| format!("invalid output device id: {err}"))?;
        return host
            .device_by_id(&id)
            .filter(DeviceTrait::supports_output)
            .ok_or_else(|| format!("output device was not found: {device_id}"));
    }
    host.default_output_device()
        .ok_or_else(|| "default output device was not found".to_string())
}

fn build_cpal_input_stream(
    device: &cpal::Device,
    config: StreamConfig,
    sample_format: SampleFormat,
    sender: tokio_mpsc::UnboundedSender<Result<Vec<f32>, String>>,
    status: Arc<Mutex<NativeVoiceStatus>>,
) -> Result<cpal::Stream, String> {
    match sample_format {
        SampleFormat::F32 => build_typed_cpal_input_stream::<f32>(device, config, sender, status),
        SampleFormat::F64 => build_typed_cpal_input_stream::<f64>(device, config, sender, status),
        SampleFormat::I8 => build_typed_cpal_input_stream::<i8>(device, config, sender, status),
        SampleFormat::I16 => build_typed_cpal_input_stream::<i16>(device, config, sender, status),
        SampleFormat::I24 => {
            build_typed_cpal_input_stream::<cpal::I24>(device, config, sender, status)
        }
        SampleFormat::I32 => build_typed_cpal_input_stream::<i32>(device, config, sender, status),
        SampleFormat::I64 => build_typed_cpal_input_stream::<i64>(device, config, sender, status),
        SampleFormat::U8 => build_typed_cpal_input_stream::<u8>(device, config, sender, status),
        SampleFormat::U16 => build_typed_cpal_input_stream::<u16>(device, config, sender, status),
        SampleFormat::U32 => build_typed_cpal_input_stream::<u32>(device, config, sender, status),
        SampleFormat::U64 => build_typed_cpal_input_stream::<u64>(device, config, sender, status),
        format => Err(format!("unsupported input sample format: {format}")),
    }
}

fn build_typed_cpal_input_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    sender: tokio_mpsc::UnboundedSender<Result<Vec<f32>, String>>,
    status: Arc<Mutex<NativeVoiceStatus>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Copy,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let sample_rate = config.sample_rate;
    let mut buffer = CpalCaptureBuffer::default();
    let error_sender = sender.clone();
    device
        .build_input_stream(
            config,
            move |input: &[T], _| {
                let mono = input.chunks(channels).map(|frame| {
                    frame.iter().copied().map(f32::from_sample).sum::<f32>()
                        / frame.len().max(1) as f32
                });
                let output = buffer.push(mono, sample_rate);
                if !output.is_empty() {
                    let _ = sender.send(Ok(output));
                }
            },
            move |err| {
                let message = format!("native input stream: {err}");
                set_status_error(&status, &message);
                let _ = error_sender.send(Err(message));
            },
            None,
        )
        .map_err(|err| format!("build input stream: {err}"))
}

impl CpalPlayback {
    fn new_for_device(
        status: Arc<Mutex<NativeVoiceStatus>>,
        device_id: Option<&str>,
    ) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = resolve_output_device(&host, device_id)?;
        let supported = device
            .default_output_config()
            .map_err(|err| format!("load output configuration: {err}"))?;
        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.into();
        if config.channels == 0 || config.sample_rate == 0 {
            return Err("output configuration is invalid".to_string());
        }
        let queue = Arc::new(Mutex::new(CpalPlaybackBuffer {
            frames: VecDeque::with_capacity(MAX_PLAYBACK_QUEUE_FRAMES),
            ..Default::default()
        }));
        let stream =
            build_cpal_output_stream(&device, config, sample_format, Arc::clone(&queue), status)?;
        stream
            .play()
            .map_err(|err| format!("start output stream: {err}"))?;
        Ok(Self {
            _stream: stream,
            queue,
        })
    }

    fn enqueue(&self, mut samples: Vec<f32>) -> Result<(), String> {
        let maximum_samples = MAX_PLAYBACK_QUEUE_FRAMES * PLAYBACK_CHANNELS;
        if samples.len() > maximum_samples {
            let drop_samples = samples.len() - maximum_samples;
            let aligned_drop =
                (drop_samples + PLAYBACK_CHANNELS - 1) / PLAYBACK_CHANNELS * PLAYBACK_CHANNELS;
            samples.drain(..aligned_drop.min(samples.len()));
        }
        let incoming_frames = samples
            .chunks_exact(PLAYBACK_CHANNELS)
            .map(|frame| [frame[0], frame[1]])
            .collect::<Vec<_>>();
        let mut queue = self
            .queue
            .lock()
            .map_err(|_| "native output queue is poisoned".to_string())?;
        let overflow = queue
            .frames
            .len()
            .saturating_add(incoming_frames.len())
            .saturating_sub(MAX_PLAYBACK_QUEUE_FRAMES);
        if overflow > 0 {
            let drain_count = overflow.min(queue.frames.len());
            queue.frames.drain(..drain_count);
            queue.source_position = 0.0;
            queue.begin_transition();
        }
        queue.frames.extend(incoming_frames);
        Ok(())
    }

    fn buffered_samples(&self) -> Result<usize, String> {
        self.queue
            .lock()
            .map(|queue| queue.frames.len())
            .map_err(|_| "native output queue is poisoned".to_string())
    }

    fn clear(&self) -> Result<(), String> {
        let mut queue = self
            .queue
            .lock()
            .map_err(|_| "native output queue is poisoned".to_string())?;
        queue.frames.clear();
        queue.source_position = 0.0;
        Ok(())
    }
}

impl CpalPlaybackBuffer {
    fn begin_transition(&mut self) {
        self.fade_from_frame = self.last_output_frame;
        self.fade_remaining = PLAYOUT_FADE_SAMPLES;
    }

    fn next_frame(&mut self, output_sample_rate: u32) -> [f32; PLAYBACK_CHANNELS] {
        let has_frames = !self.frames.is_empty();
        if has_frames != !self.was_empty {
            self.begin_transition();
        }
        self.was_empty = !has_frames;

        let raw_frame = if let Some(&first) = self.frames.front() {
            if self.frames.len() == 1 {
                self.frames.pop_front();
                self.source_position = 0.0;
                first
            } else {
                let second = self.frames[1];
                let position = self.source_position as f32;
                let frame = [
                    first[0] + (second[0] - first[0]) * position,
                    first[1] + (second[1] - first[1]) * position,
                ];
                self.source_position += SAMPLE_RATE as f64 / output_sample_rate.max(1) as f64;
                while self.source_position >= 1.0 && self.frames.len() > 1 {
                    self.frames.pop_front();
                    self.source_position -= 1.0;
                }
                frame
            }
        } else {
            self.source_position = 0.0;
            [0.0; PLAYBACK_CHANNELS]
        };

        let frame = if self.fade_remaining > 0 {
            let completed = PLAYOUT_FADE_SAMPLES - self.fade_remaining + 1;
            let progress = completed as f32 / PLAYOUT_FADE_SAMPLES as f32;
            self.fade_remaining -= 1;
            [
                self.fade_from_frame[0] + (raw_frame[0] - self.fade_from_frame[0]) * progress,
                self.fade_from_frame[1] + (raw_frame[1] - self.fade_from_frame[1]) * progress,
            ]
        } else {
            raw_frame
        };
        self.last_output_frame = frame;
        frame
    }
}

impl StereoTestBuffer {
    fn next_frame(&mut self, output_sample_rate: u32) -> (f32, f32) {
        let Some(&first) = self.frames.front() else {
            self.source_position = 0.0;
            return (0.0, 0.0);
        };
        if self.frames.len() == 1 {
            self.frames.pop_front();
            self.source_position = 0.0;
            return first;
        }
        let second = self.frames[1];
        let position = self.source_position as f32;
        let frame = (
            first.0 + (second.0 - first.0) * position,
            first.1 + (second.1 - first.1) * position,
        );
        self.source_position +=
            self.source_sample_rate.max(1) as f64 / output_sample_rate.max(1) as f64;
        while self.source_position >= 1.0 && self.frames.len() > 1 {
            self.frames.pop_front();
            self.source_position -= 1.0;
        }
        frame
    }
}

fn build_headphone_test_output_stream(
    device: &cpal::Device,
    config: StreamConfig,
    sample_format: SampleFormat,
    queue: Arc<Mutex<StereoTestBuffer>>,
    playback_error: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String> {
    match sample_format {
        SampleFormat::F32 => {
            build_typed_headphone_test_output_stream::<f32>(device, config, queue, playback_error)
        }
        SampleFormat::F64 => {
            build_typed_headphone_test_output_stream::<f64>(device, config, queue, playback_error)
        }
        SampleFormat::I8 => {
            build_typed_headphone_test_output_stream::<i8>(device, config, queue, playback_error)
        }
        SampleFormat::I16 => {
            build_typed_headphone_test_output_stream::<i16>(device, config, queue, playback_error)
        }
        SampleFormat::I24 => build_typed_headphone_test_output_stream::<cpal::I24>(
            device,
            config,
            queue,
            playback_error,
        ),
        SampleFormat::I32 => {
            build_typed_headphone_test_output_stream::<i32>(device, config, queue, playback_error)
        }
        SampleFormat::I64 => {
            build_typed_headphone_test_output_stream::<i64>(device, config, queue, playback_error)
        }
        SampleFormat::U8 => {
            build_typed_headphone_test_output_stream::<u8>(device, config, queue, playback_error)
        }
        SampleFormat::U16 => {
            build_typed_headphone_test_output_stream::<u16>(device, config, queue, playback_error)
        }
        SampleFormat::U32 => {
            build_typed_headphone_test_output_stream::<u32>(device, config, queue, playback_error)
        }
        SampleFormat::U64 => {
            build_typed_headphone_test_output_stream::<u64>(device, config, queue, playback_error)
        }
        format => Err(format!(
            "unsupported headphone test output sample format: {format}"
        )),
    }
}

fn build_typed_headphone_test_output_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    queue: Arc<Mutex<StereoTestBuffer>>,
    playback_error: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    let output_sample_rate = config.sample_rate;
    device
        .build_output_stream(
            config,
            move |output: &mut [T], _| {
                fill_headphone_test_output(output, channels, output_sample_rate, &queue)
            },
            move |err| {
                if let Ok(mut error) = playback_error.lock() {
                    *error = Some(format!("native headphone test output: {err}"));
                }
            },
            None,
        )
        .map_err(|err| format!("build headphone test output stream: {err}"))
}

fn fill_headphone_test_output<T>(
    output: &mut [T],
    channels: usize,
    output_sample_rate: u32,
    queue: &Arc<Mutex<StereoTestBuffer>>,
) where
    T: CpalSample + FromSample<f32>,
{
    let Ok(mut queue) = queue.lock() else {
        for sample in output {
            *sample = T::from_sample(0.0);
        }
        return;
    };
    for output_frame in output.chunks_mut(channels.max(1)) {
        let (left, right) = queue.next_frame(output_sample_rate);
        if output_frame.len() == 1 {
            output_frame[0] = T::from_sample((left + right) * 0.5);
            continue;
        }
        output_frame[0] = T::from_sample(left);
        output_frame[1] = T::from_sample(right);
        for sample in output_frame.iter_mut().skip(2) {
            *sample = T::from_sample(0.0);
        }
    }
}

fn build_cpal_output_stream(
    device: &cpal::Device,
    config: StreamConfig,
    sample_format: SampleFormat,
    queue: Arc<Mutex<CpalPlaybackBuffer>>,
    status: Arc<Mutex<NativeVoiceStatus>>,
) -> Result<cpal::Stream, String> {
    match sample_format {
        SampleFormat::F32 => build_typed_cpal_output_stream::<f32>(device, config, queue, status),
        SampleFormat::F64 => build_typed_cpal_output_stream::<f64>(device, config, queue, status),
        SampleFormat::I8 => build_typed_cpal_output_stream::<i8>(device, config, queue, status),
        SampleFormat::I16 => build_typed_cpal_output_stream::<i16>(device, config, queue, status),
        SampleFormat::I24 => {
            build_typed_cpal_output_stream::<cpal::I24>(device, config, queue, status)
        }
        SampleFormat::I32 => build_typed_cpal_output_stream::<i32>(device, config, queue, status),
        SampleFormat::I64 => build_typed_cpal_output_stream::<i64>(device, config, queue, status),
        SampleFormat::U8 => build_typed_cpal_output_stream::<u8>(device, config, queue, status),
        SampleFormat::U16 => build_typed_cpal_output_stream::<u16>(device, config, queue, status),
        SampleFormat::U32 => build_typed_cpal_output_stream::<u32>(device, config, queue, status),
        SampleFormat::U64 => build_typed_cpal_output_stream::<u64>(device, config, queue, status),
        format => Err(format!("unsupported output sample format: {format}")),
    }
}

fn build_typed_cpal_output_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    queue: Arc<Mutex<CpalPlaybackBuffer>>,
    status: Arc<Mutex<NativeVoiceStatus>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    let output_sample_rate = config.sample_rate;
    device
        .build_output_stream(
            config,
            move |output: &mut [T], _| {
                fill_cpal_output(output, channels, output_sample_rate, &queue)
            },
            move |err| set_status_error(&status, &format!("native output stream: {err}")),
            None,
        )
        .map_err(|err| format!("build default output stream: {err}"))
}

fn fill_cpal_output<T>(
    output: &mut [T],
    channels: usize,
    output_sample_rate: u32,
    queue: &Arc<Mutex<CpalPlaybackBuffer>>,
) where
    T: CpalSample + FromSample<f32>,
{
    let Ok(mut queue) = queue.lock() else {
        for sample in output {
            *sample = T::from_sample(0.0);
        }
        return;
    };
    for frame in output.chunks_mut(channels.max(1)) {
        let source = queue.next_frame(output_sample_rate);
        if frame.len() == 1 {
            frame[0] = T::from_sample((source[0] + source[1]) * 0.5);
            continue;
        }
        frame[0] = T::from_sample(source[0]);
        frame[1] = T::from_sample(source[1]);
        for output_sample in frame.iter_mut().skip(2) {
            *output_sample = T::from_sample(0.0);
        }
    }
}

fn spawn_rtcp_reader(sender: Arc<RTCRtpSender>) {
    tokio::spawn(async move { while sender.read_rtcp().await.is_ok() {} });
}

fn push_outbound_signal(
    queue: &Arc<Mutex<Vec<NativeVoiceOutboundSignal>>>,
    member_id: String,
    signal_type: &str,
    data: serde_json::Value,
) {
    if let Ok(mut queue) = queue.lock() {
        queue.push(NativeVoiceOutboundSignal {
            member_id,
            signal_type: signal_type.to_string(),
            data,
        });
    }
}

fn update_status(
    status: &Arc<Mutex<NativeVoiceStatus>>,
    update: impl FnOnce(&mut NativeVoiceStatus),
) {
    if let Ok(mut status) = status.lock() {
        update(&mut status);
    }
}

fn set_status_error(status: &Arc<Mutex<NativeVoiceStatus>>, message: &str) {
    update_status(status, |status| {
        status.last_error = Some(message.to_string())
    });
}

fn set_fatal_status(status: &Arc<Mutex<NativeVoiceStatus>>, message: &str) {
    update_status(status, |status| {
        status.phase = "failed".to_string();
        status.last_error = Some(message.to_string());
        status.speaking = false;
        status.input_level = 0.0;
    });
}

fn mark_microphone_unavailable(
    microphone_available: &Arc<AtomicBool>,
    muted: &Arc<AtomicBool>,
    status: &Arc<Mutex<NativeVoiceStatus>>,
    message: &str,
) {
    microphone_available.store(false, Ordering::SeqCst);
    muted.store(true, Ordering::SeqCst);
    update_status(status, |status| {
        status.microphone_available = false;
        status.microphone_error = Some(message.to_string());
        status.muted = true;
        status.speaking = false;
        status.input_level = 0.0;
    });
}

fn frame_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

fn soft_limit(sample: f32) -> f32 {
    const THRESHOLD: f32 = 0.92;
    if !sample.is_finite() {
        return 0.0;
    }
    let magnitude = sample.abs();
    if magnitude <= THRESHOLD {
        sample
    } else {
        let headroom = 1.0 - THRESHOLD;
        let limited = THRESHOLD + headroom * ((magnitude - THRESHOLD) / headroom).tanh();
        limited.copysign(sample)
    }
}

fn native_audio_backend() -> &'static str {
    if cfg!(target_os = "windows") {
        "wasapi-aec-cpal-output"
    } else if cfg!(target_os = "macos") {
        "voice-processing-io-cpal-output"
    } else if cfg!(target_os = "linux") {
        "pulseaudio-cpal-output"
    } else {
        "native-audio"
    }
}

fn output_only_audio_backend() -> &'static str {
    if cfg!(target_os = "windows") {
        "wasapi-output-only"
    } else if cfg!(target_os = "macos") {
        "coreaudio-output-only"
    } else if cfg!(target_os = "linux") {
        "native-output-only"
    } else {
        "output-only"
    }
}

fn direct_audio_backend() -> &'static str {
    if cfg!(target_os = "windows") {
        "wasapi-direct-cpal-output"
    } else if cfg!(target_os = "macos") {
        "coreaudio-direct-cpal-output"
    } else if cfg!(target_os = "linux") {
        "pulseaudio-direct-cpal-output"
    } else {
        "native-direct-cpal-output"
    }
}

fn selected_direct_audio_backend() -> &'static str {
    if cfg!(target_os = "windows") {
        "wasapi-selected-output-direct-input"
    } else if cfg!(target_os = "macos") {
        "coreaudio-selected-output-direct-input"
    } else if cfg!(target_os = "linux") {
        "pulseaudio-selected-output-direct-input"
    } else {
        "native-selected-output-direct-input"
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_status() -> Arc<Mutex<NativeVoiceStatus>> {
        Arc::new(Mutex::new(NativeVoiceStatus {
            session_id: "voice_test".to_string(),
            channel_id: "channel_test".to_string(),
            phase: "running".to_string(),
            backend: "test".to_string(),
            playback_backend: "test".to_string(),
            microphone_available: true,
            microphone_error: None,
            muted: false,
            deafened: false,
            speaking: false,
            input_level: 0.0,
            noise_suppression_mode: VoiceNoiseSuppressionMode::Standard,
            peer_count: 0,
            round_trip_time_ms: None,
            captured_frames: 0,
            encoded_packets: 0,
            received_packets: 0,
            decoded_frames: 0,
            played_frames: 0,
            dropped_frames: 0,
            last_capture_at_ms: 0,
            last_receive_at_ms: 0,
            accompaniment_active: false,
            accompaniment_process_id: None,
            accompaniment_packets: 0,
            last_error: None,
        }))
    }

    #[test]
    fn opus_voice_frame_round_trips() {
        let input = (0..FRAME_SAMPLES)
            .map(|index| {
                ((index as f32 * 440.0 * std::f32::consts::TAU / SAMPLE_RATE as f32).sin()) * 0.25
            })
            .collect::<Vec<_>>();
        let mut encoder = create_voice_opus_encoder().unwrap();
        let mut packet = vec![0_u8; 1200];
        let packet_len = encoder
            .encode_float(&input, FRAME_SAMPLES, &mut packet)
            .unwrap();
        let mut decoder = OpusDecoder::new(SAMPLE_RATE, 1).unwrap();
        let mut output = vec![0.0_f32; 5760];
        let output_len = decoder
            .decode_float(&packet[..packet_len], &mut output, 5760, false)
            .unwrap();
        assert_eq!(output_len, FRAME_SAMPLES);
        assert!(output[..output_len]
            .iter()
            .any(|sample| sample.abs() > 0.001));
    }

    #[test]
    fn opus_decoder_conceals_a_missing_voice_frame() {
        let input = vec![0.15_f32; FRAME_SAMPLES];
        let mut encoder = create_voice_opus_encoder().unwrap();
        let mut packet = vec![0_u8; 1200];
        let packet_len = encoder
            .encode_float(&input, FRAME_SAMPLES, &mut packet)
            .unwrap();
        let mut decoder = OpusDecoder::new(SAMPLE_RATE, 1).unwrap();
        let mut output = vec![0.0_f32; 5760];
        decoder
            .decode_float(&packet[..packet_len], &mut output, 5760, false)
            .unwrap();
        let concealed = decoder
            .decode_float(&[], &mut output, FRAME_SAMPLES, false)
            .unwrap();
        assert_eq!(concealed, FRAME_SAMPLES);
        assert!(output[..concealed].iter().all(|sample| sample.is_finite()));
    }

    #[test]
    fn opus_recovers_single_packet_using_its_rtp_duration_before_decoding_current_audio() {
        let samples = FRAME_SAMPLES / 2;
        let mut encoder = OpusEncoder::new(SAMPLE_RATE, 1, 20_000, 8, true, true, 20).unwrap();
        let mut decoder = OpusDecoder::new(SAMPLE_RATE, 1).unwrap();
        let mut pcm = vec![0.0; 5760];
        let mut packet = [0; 1200];
        for index in 0..12 {
            let speech: Vec<_> = (0..samples)
                .map(|i| ((index * samples + i) as f32 * 0.044).sin() * 0.25)
                .collect();
            let len = encoder.encode_float(&speech, samples, &mut packet).unwrap();
            if index == 10 {
                continue;
            }
            if index == 11 {
                let recovered =
                    recover_lost_opus(&mut decoder, &packet[..len], &mut pcm, 1, Some(samples))
                        .unwrap();
                assert_eq!(recovered, samples);
                assert!(pcm[..recovered].iter().all(|s| s.is_finite()));
            }
            assert_eq!(
                decoder
                    .decode_float(&packet[..len], &mut pcm, 5760, false)
                    .unwrap(),
                samples
            );
        }
        // A discontinuity cannot be turned into an unbounded PCM allocation.
        assert_eq!(
            recover_lost_opus(&mut decoder, &[], &mut pcm, 1, Some(48_000)).unwrap(),
            FRAME_SAMPLES
        );
    }

    #[test]
    fn native_noise_suppression_modes_produce_bounded_pcm() {
        for mode in [
            VoiceNoiseSuppressionMode::Off,
            VoiceNoiseSuppressionMode::Light,
            VoiceNoiseSuppressionMode::Standard,
            VoiceNoiseSuppressionMode::Strong,
        ] {
            let mut suppressor = NativeNoiseSuppressor::new();
            let mut frame = (0..FRAME_SAMPLES)
                .map(|index| {
                    let speech =
                        (index as f32 * 220.0 * std::f32::consts::TAU / SAMPLE_RATE as f32).sin()
                            * 0.18;
                    let noise = (((index * 37) % 101) as f32 - 50.0) / 5_000.0;
                    speech + noise
                })
                .collect::<Vec<_>>();
            for _ in 0..4 {
                suppressor.process(mode, &mut frame);
                assert!(frame.iter().all(|sample| sample.is_finite()));
                assert!(frame.iter().all(|sample| sample.abs() <= 1.0));
            }
        }
    }

    #[test]
    fn speaking_threshold_detects_quiet_voice_without_promoting_low_noise() {
        let quiet_voice = (0..FRAME_SAMPLES)
            .map(|index| {
                (index as f32 * 220.0 * std::f32::consts::TAU / SAMPLE_RATE as f32).sin() * 0.05
            })
            .collect::<Vec<_>>();
        let low_noise = vec![0.01_f32; FRAME_SAMPLES];

        assert!(frame_rms(&quiet_voice) >= SPEAKING_START_RMS);
        assert!(frame_rms(&low_noise) <= SPEAKING_STOP_RMS);
        assert!(SPEAKING_STOP_RMS < SPEAKING_START_RMS);
    }

    #[test]
    fn light_filter_reduces_idle_low_frequency_noise() {
        let mut suppressor = NativeNoiseSuppressor::new();
        let mut frame = vec![0.003_f32; FRAME_SAMPLES];
        for _ in 0..20 {
            frame.fill(0.003);
            suppressor.process(VoiceNoiseSuppressionMode::Light, &mut frame);
        }
        assert!(frame_rms(&frame) < 0.001);
    }

    #[test]
    fn strong_rnnoise_uses_speech_aware_attenuation() {
        let mut suppressor = NativeNoiseSuppressor::new();
        let mut frame = vec![0.0_f32; FRAME_SAMPLES];
        for _ in 0..8 {
            suppressor.process(VoiceNoiseSuppressionMode::Strong, &mut frame);
        }
        assert!(suppressor.rnnoise_warm);
        assert!(suppressor.strong_gate_gain < 0.9);
    }

    #[test]
    fn muted_rtp_keepalives_are_not_classified_as_audio() {
        assert_eq!(
            classify_incoming_opus_payload(&[]),
            IncomingOpusPayloadKind::Padding
        );
        assert_eq!(
            classify_incoming_opus_payload(&[0xf8]),
            IncomingOpusPayloadKind::DiscontinuousSilence
        );
        assert_eq!(
            classify_incoming_opus_payload(&[0xf8, 0xff]),
            IncomingOpusPayloadKind::Audio
        );

        let mut queue = VoicePlayoutQueue::default();
        for _ in 0..4 {
            if classify_incoming_opus_payload(&[]) == IncomingOpusPayloadKind::Audio {
                queue.push(vec![0.25; 5760]);
            }
        }
        assert!(queue.samples.is_empty());
        assert!(!queue.started);
    }

    #[test]
    fn rtp_sequence_gap_handles_wraparound_and_late_packets() {
        assert_eq!(rtp_forward_gap(101, 101), Some(0));
        assert_eq!(rtp_forward_gap(101, 103), Some(2));
        assert_eq!(rtp_forward_gap(u16::MAX, 1), Some(2));
        assert_eq!(rtp_forward_gap(103, 102), None);
    }

    #[test]
    fn playout_queue_prebuffers_and_fades_underflow() {
        let mut queue = VoicePlayoutQueue::default();
        queue.push(vec![
            0.5;
            FRAME_SAMPLES
                * PLAYBACK_CHANNELS
                * (PLAYOUT_PREBUFFER_FRAMES - 1)
        ]);
        assert!(!queue.started);
        queue.push(vec![0.5; FRAME_SAMPLES * PLAYBACK_CHANNELS]);
        assert!(queue.started);
        let first = queue.take_frame().unwrap();
        assert!(first[0] < 0.01);
        assert_eq!(first[(PLAYOUT_FADE_SAMPLES - 1) * PLAYBACK_CHANNELS], 0.5);
        for _ in 1..PLAYOUT_PREBUFFER_FRAMES {
            assert_eq!(
                queue.take_frame().unwrap().len(),
                FRAME_SAMPLES * PLAYBACK_CHANNELS
            );
        }
        let concealed = queue.take_frame().unwrap();
        assert!((concealed[0] - 0.5).abs() < 0.02);
        assert_eq!(
            concealed[(PLAYOUT_FADE_SAMPLES - 1) * PLAYBACK_CHANNELS],
            0.0
        );
        assert!(concealed[PLAYOUT_FADE_SAMPLES * PLAYBACK_CHANNELS..]
            .iter()
            .all(|sample| *sample == 0.0));
    }

    #[test]
    fn limiter_keeps_mixed_audio_in_range() {
        for sample in [-4.0, -1.0, 0.0, 1.0, 4.0] {
            assert!(soft_limit(sample).abs() <= 1.0);
        }
    }

    #[test]
    fn limiter_is_continuous_monotonic_and_rejects_invalid_samples() {
        let below = soft_limit(0.919_999);
        let threshold = soft_limit(0.92);
        let above = soft_limit(0.920_001);
        assert!(below <= threshold && threshold <= above);
        assert!((above - below).abs() < 0.000_01);
        assert_eq!(soft_limit(f32::NAN), 0.0);
        assert_eq!(soft_limit(f32::INFINITY), 0.0);
        assert_eq!(soft_limit(f32::NEG_INFINITY), 0.0);
    }

    #[test]
    fn playout_queue_crossfades_after_dropping_stale_audio() {
        let mut queue = VoicePlayoutQueue {
            samples: VecDeque::from(vec![
                0.8;
                FRAME_SAMPLES
                    * PLAYBACK_CHANNELS
                    * PLAYOUT_PREBUFFER_FRAMES
            ]),
            started: true,
            last_frame: [0.8; PLAYBACK_CHANNELS],
            ..Default::default()
        };
        queue.push(vec![-0.8; MAX_DECODED_QUEUE_SAMPLES]);
        let frame = queue.take_frame().unwrap();
        assert!((frame[0] - 0.8).abs() < 0.05);
        assert!(frame[(PLAYOUT_FADE_SAMPLES - 1) * PLAYBACK_CHANNELS] < -0.7);
    }

    #[test]
    fn playout_queue_crossfades_an_encoded_silence_boundary() {
        let mut queue = VoicePlayoutQueue {
            samples: VecDeque::from(vec![
                0.0;
                FRAME_SAMPLES
                    * PLAYBACK_CHANNELS
                    * PLAYOUT_PREBUFFER_FRAMES
            ]),
            started: true,
            previous_frame: [0.14; PLAYBACK_CHANNELS],
            last_frame: [0.15; PLAYBACK_CHANNELS],
            ..Default::default()
        };
        let frame = queue.take_frame().unwrap();
        assert!((frame[0] - 0.15).abs() < 0.01);
        assert_eq!(frame[(PLAYOUT_FADE_SAMPLES - 1) * PLAYBACK_CHANNELS], 0.0);
    }

    #[test]
    fn playout_queue_preserves_legitimate_fast_packet_boundaries() {
        let mut samples = vec![0.0; FRAME_SAMPLES * PLAYBACK_CHANNELS];
        for (index, frame) in samples.chunks_exact_mut(PLAYBACK_CHANNELS).enumerate() {
            let sample = if index % 2 == 0 { -0.8 } else { 0.8 };
            frame.fill(sample);
        }
        let mut queue = VoicePlayoutQueue {
            samples: VecDeque::from(samples),
            started: true,
            previous_frame: [-0.8; PLAYBACK_CHANNELS],
            last_frame: [0.8; PLAYBACK_CHANNELS],
            ..Default::default()
        };
        let frame = queue.take_frame().unwrap();
        assert_eq!(frame[0], -0.8);
        assert_eq!(frame[PLAYBACK_CHANNELS], 0.8);
    }

    #[test]
    fn voice_volume_controls_enforce_supported_ranges() {
        assert_eq!(clamp_input_gain(300), 300);
        assert_eq!(clamp_input_gain(1_001), 1_000);
        assert_eq!(clamp_output_volume(150), 100);
        assert_eq!(clamp_member_volume(600), 600);
        assert_eq!(clamp_member_volume(1_001), 1_000);
        assert_eq!(clamp_input_gain(65), 65);
        assert_eq!(clamp_output_volume(40), 40);
        assert_eq!(clamp_member_volume(135), 135);
    }

    #[test]
    fn output_resampler_consumes_source_at_expected_rate() {
        let mut buffer = CpalPlaybackBuffer {
            frames: (0..FRAME_SAMPLES)
                .map(|sample| [sample as f32, -(sample as f32)])
                .collect(),
            ..Default::default()
        };
        for _ in 0..FRAME_SAMPLES * 2 {
            let _ = buffer.next_frame(SAMPLE_RATE * 2);
        }
        assert!(buffer.frames.len() <= 1);
    }

    #[test]
    fn output_buffer_crossfades_queue_discontinuities() {
        let mut buffer = CpalPlaybackBuffer {
            frames: VecDeque::from(vec![[0.8, -0.8]; FRAME_SAMPLES]),
            ..Default::default()
        };
        let previous = buffer.next_frame(SAMPLE_RATE);
        buffer.frames = VecDeque::from(vec![[-0.8, 0.8]; FRAME_SAMPLES]);
        buffer.source_position = 0.0;
        buffer.begin_transition();
        let first = buffer.next_frame(SAMPLE_RATE);
        assert!((first[0] - previous[0]).abs() < 0.05);
        assert!((first[1] - previous[1]).abs() < 0.05);
        for _ in 1..PLAYOUT_FADE_SAMPLES {
            let _ = buffer.next_frame(SAMPLE_RATE);
        }
        assert!(buffer.last_output_frame[0] < -0.7);
        assert!(buffer.last_output_frame[1] > 0.7);
    }

    #[test]
    fn accompaniment_fade_in_reaches_full_gain_without_a_step() {
        let mut remaining = ACCOMPANIMENT_FADE_IN_SAMPLES;
        let mut frame = vec![1.0; FRAME_SAMPLES];
        apply_linear_fade_in(&mut frame, &mut remaining, ACCOMPANIMENT_FADE_IN_SAMPLES);
        assert!(frame[0] < 0.01);
        assert_eq!(frame[FRAME_SAMPLES - 1], 1.0);
        assert_eq!(remaining, 0);
        assert!(frame.windows(2).all(|pair| pair[1] >= pair[0]));
    }

    #[test]
    fn accompaniment_sdp_enables_high_quality_stereo_only_on_music_track() {
        let sdp = [
            "v=0",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111",
            "a=rtpmap:111 opus/48000/2",
            "a=fmtp:111 minptime=10;useinbandfec=1",
            "m=audio 9 UDP/TLS/RTP/SAVPF 109",
            "a=rtpmap:109 opus/48000/2",
            "a=fmtp:109 minptime=10;stereo=0",
        ]
        .join("\r\n");
        let enhanced = enhance_accompaniment_opus_sdp(&sdp);
        assert!(enhanced.contains("a=fmtp:111 minptime=10;useinbandfec=1"));
        assert!(enhanced.contains(
            "a=fmtp:109 minptime=10;stereo=1;sprop-stereo=1;maxaveragebitrate=256000;useinbandfec=1;usedtx=0;cbr=0"
        ));
    }

    #[test]
    fn opus_frames_are_normalized_to_stereo_for_native_playback() {
        let stereo = [0.75, 0.25, -0.5, 0.5];
        assert_eq!(opus_frame_to_stereo(&stereo, 2, 2), stereo);
        assert_eq!(
            opus_frame_to_stereo(&[0.5, -0.25], 2, 1),
            vec![0.5, 0.5, -0.25, -0.25]
        );
    }

    #[test]
    fn embedded_headphone_test_sound_decodes_and_preserves_channel_order() {
        let (samples, sample_rate) = decode_embedded_microphone_enabled_sound().unwrap();
        assert_eq!(sample_rate, SAMPLE_RATE);
        assert!(samples.len() > SAMPLE_RATE as usize / 4);
        assert!(samples.iter().any(|sample| sample.abs() > 0.001));

        let mut buffer = StereoTestBuffer {
            frames: VecDeque::from([(0.5, 0.0), (0.0, 0.5)]),
            source_sample_rate: SAMPLE_RATE,
            source_position: 0.0,
        };
        assert_eq!(buffer.next_frame(SAMPLE_RATE), (0.5, 0.0));
        assert_eq!(buffer.next_frame(SAMPLE_RATE), (0.0, 0.5));
    }

    #[test]
    #[ignore = "requires a local default audio output device"]
    fn default_output_device_consumes_queued_audio() {
        let playback = CpalPlayback::new_for_device(test_status(), None)
            .expect("default output device should start");
        let sample_count = FRAME_SAMPLES * 4;
        playback
            .enqueue(vec![0.0; sample_count])
            .expect("default output should accept PCM");
        std::thread::sleep(Duration::from_millis(120));
        let remaining = playback.queue.lock().unwrap().frames.len();
        assert!(
            remaining < sample_count,
            "default output callback did not consume queued PCM"
        );
    }

    #[test]
    #[ignore = "requires a local default audio input device"]
    fn default_input_device_produces_pcm() {
        let mut capture =
            CpalCapture::new(None, test_status()).expect("default input device should start");
        let runtime = TokioRuntimeBuilder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let chunk = runtime
            .block_on(async {
                tokio::time::timeout(Duration::from_secs(2), capture.receiver.recv()).await
            })
            .expect("default input callback did not produce PCM in time")
            .expect("default input stream stopped")
            .expect("default input stream returned an error");
        assert!(!chunk.is_empty());
        assert!(chunk.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    #[ignore = "requires the Windows echo-cancelled default input backend"]
    fn default_echo_cancelled_input_produces_pcm() {
        let runtime = TokioRuntimeBuilder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let chunk = runtime
            .block_on(async {
                let capture = CaptureHandle::new(AecConfig {
                    sample_rate: SAMPLE_RATE,
                    channels: Channels::Mono,
                })
                .expect("default echo-cancelled input should start");
                tokio::time::timeout(Duration::from_secs(2), capture.recv()).await
            })
            .expect("echo-cancelled input did not produce PCM in time")
            .expect("echo-cancelled input stream stopped")
            .expect("echo-cancelled input stream returned an error");
        assert!(!chunk.is_empty());
        assert!(chunk.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    fn native_opus_track_reaches_standard_webrtc_receiver() {
        let runtime = TokioRuntimeBuilder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let status = test_status();
            let outbound_signals = Arc::new(Mutex::new(Vec::new()));
            let audio_track = Arc::new(TrackLocalStaticSample::new(
                RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: SAMPLE_RATE,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0".to_string(),
                    rtcp_feedback: Vec::new(),
                },
                "voice-test-track".to_string(),
                "voice-test-stream".to_string(),
            ));
            let accompaniment_track = Arc::new(TrackLocalStaticSample::new(
                RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: SAMPLE_RATE,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0".to_string(),
                    rtcp_feedback: Vec::new(),
                },
                "accompaniment-test-track".to_string(),
                "accompaniment-test-stream".to_string(),
            ));
            let (decoded_tx, mut decoded_rx) = tokio_mpsc::unbounded_channel();
            let mut engine = NativeVoiceEngine {
                status: Arc::clone(&status),
                outbound_signals: Arc::clone(&outbound_signals),
                muted: Arc::new(AtomicBool::new(false)),
                deafened: Arc::new(AtomicBool::new(false)),
                microphone_available: Arc::new(AtomicBool::new(true)),
                input_gain_percent: Arc::new(AtomicU32::new(100)),
                noise_suppression_mode: Arc::new(AtomicU8::new(
                    VoiceNoiseSuppressionMode::Standard.as_u8(),
                )),
                output_volume_percent: Arc::new(AtomicU32::new(100)),
                member_volumes: Arc::new(Mutex::new(HashMap::new())),
                member_music_volumes: Arc::new(Mutex::new(HashMap::new())),
                accompaniment_volume_percent: Arc::new(AtomicU32::new(100)),
                audio_track: Arc::clone(&audio_track),
                accompaniment_track: Arc::clone(&accompaniment_track),
                accompaniment_runtime: None,
                decoded_tx,
                peers: HashMap::new(),
                rtc_configuration: RTCConfiguration::default(),
            };
            engine
                .ensure_peer("receiver".to_string(), true)
                .await
                .unwrap();

            let mut sender_candidates = Vec::new();
            let offer = {
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                loop {
                    let signals = outbound_signals
                        .lock()
                        .map(|mut queue| queue.drain(..).collect::<Vec<_>>())
                        .unwrap_or_default();
                    let mut offer = None;
                    for signal in signals {
                        match signal.signal_type.as_str() {
                            "offer" => {
                                offer = Some(
                                    serde_json::from_value::<RTCSessionDescription>(signal.data)
                                        .unwrap(),
                                )
                            }
                            "ice-candidate" => sender_candidates.push(
                                serde_json::from_value::<RTCIceCandidateInit>(signal.data).unwrap(),
                            ),
                            _ => {}
                        }
                    }
                    if let Some(offer) = offer {
                        break offer;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "native voice sender did not generate an offer"
                    );
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            };
            assert_eq!(offer.sdp.matches("m=audio").count(), 2);
            assert!(offer.sdp.contains("opus/48000/2"));
            assert!(offer.sdp.contains("minptime=10"));

            let mut media_engine = MediaEngine::default();
            media_engine.register_default_codecs().unwrap();
            let registry =
                register_default_interceptors(Registry::new(), &mut media_engine).unwrap();
            let receiver = APIBuilder::new()
                .with_media_engine(media_engine)
                .with_interceptor_registry(registry)
                .build()
                .new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap();
            let (packet_tx, mut packet_rx) = tokio_mpsc::channel::<(String, Vec<u8>)>(4);
            receiver.on_track(Box::new(move |track, _, _| {
                let packet_tx = packet_tx.clone();
                Box::pin(async move {
                    if let Ok((packet, _)) = track.read_rtp().await {
                        let _ = packet_tx.send((track.id(), packet.payload.to_vec())).await;
                    }
                })
            }));
            let receiver_candidates = Arc::new(Mutex::new(Vec::<RTCIceCandidateInit>::new()));
            let callback_candidates = Arc::clone(&receiver_candidates);
            receiver.on_ice_candidate(Box::new(move |candidate| {
                let candidates = Arc::clone(&callback_candidates);
                Box::pin(async move {
                    let Some(candidate) = candidate else {
                        return;
                    };
                    if let Ok(candidate) = candidate.to_json() {
                        if let Ok(mut candidates) = candidates.lock() {
                            candidates.push(candidate);
                        }
                    }
                })
            }));
            let receiver_audio_track = Arc::new(TrackLocalStaticSample::new(
                RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: SAMPLE_RATE,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0".to_string(),
                    rtcp_feedback: Vec::new(),
                },
                "receiver-test-track".to_string(),
                "receiver-test-stream".to_string(),
            ));
            let receiver_sender = receiver
                .add_track(Arc::clone(&receiver_audio_track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .unwrap();
            spawn_rtcp_reader(receiver_sender);
            receiver.set_remote_description(offer).await.unwrap();
            for candidate in sender_candidates.drain(..) {
                receiver.add_ice_candidate(candidate).await.unwrap();
            }
            let answer = receiver.create_answer(None).await.unwrap();
            receiver
                .set_local_description(answer.clone())
                .await
                .unwrap();
            engine
                .handle_signal("receiver".to_string(), "answer", json!(answer))
                .await
                .unwrap();

            let input = (0..FRAME_SAMPLES)
                .map(|index| {
                    ((index as f32 * 440.0 * std::f32::consts::TAU / SAMPLE_RATE as f32).sin())
                        * 0.25
                })
                .collect::<Vec<_>>();
            let mut encoder = create_voice_opus_encoder().unwrap();
            let mut encoded = vec![0_u8; 1200];
            let packet_len = encoder
                .encode_float(&input, FRAME_SAMPLES, &mut encoded)
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut received_track_ids = std::collections::HashSet::new();
            let mut received_voice_payload = None;
            loop {
                let signals = outbound_signals
                    .lock()
                    .map(|mut queue| queue.drain(..).collect::<Vec<_>>())
                    .unwrap_or_default();
                for signal in signals {
                    if signal.signal_type == "ice-candidate" {
                        let candidate =
                            serde_json::from_value::<RTCIceCandidateInit>(signal.data).unwrap();
                        receiver.add_ice_candidate(candidate).await.unwrap();
                    }
                }
                let candidates = receiver_candidates
                    .lock()
                    .map(|mut candidates| candidates.drain(..).collect::<Vec<_>>())
                    .unwrap_or_default();
                for candidate in candidates {
                    engine
                        .handle_signal("receiver".to_string(), "ice-candidate", json!(candidate))
                        .await
                        .unwrap();
                }
                audio_track
                    .write_sample(&Sample {
                        data: Bytes::copy_from_slice(&encoded[..packet_len]),
                        duration: FRAME_DURATION,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                accompaniment_track
                    .write_sample(&Sample {
                        data: Bytes::copy_from_slice(&encoded[..packet_len]),
                        duration: FRAME_DURATION,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                receiver_audio_track
                    .write_sample(&Sample {
                        data: Bytes::copy_from_slice(&encoded[..packet_len]),
                        duration: FRAME_DURATION,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                match tokio::time::timeout(Duration::from_millis(30), packet_rx.recv()).await {
                    Ok(Some((track_id, payload))) if !payload.is_empty() => {
                        if track_id == "voice-test-track" {
                            received_voice_payload = Some(payload);
                        }
                        received_track_ids.insert(track_id);
                    }
                    _ if std::time::Instant::now() >= deadline => {
                        panic!(
                            "native voice loopback did not receive microphone and accompaniment RTP; tracks={received_track_ids:?} status={:?}",
                            status.lock().unwrap()
                        )
                    }
                    _ => {}
                }
                if received_track_ids.contains("voice-test-track")
                    && received_track_ids.contains("accompaniment-test-track")
                {
                    break;
                }
            }
            let mut browser_compatible_decoder = OpusDecoder::new(SAMPLE_RATE, 2).unwrap();
            let mut browser_compatible_pcm = vec![0.0_f32; 5760 * 2];
            let decoded_samples = browser_compatible_decoder
                .decode_float(
                    received_voice_payload.as_deref().unwrap(),
                    &mut browser_compatible_pcm,
                    5760,
                    false,
                )
                .unwrap();
            assert_eq!(decoded_samples, FRAME_SAMPLES);
            assert!(browser_compatible_pcm[..decoded_samples * 2]
                .iter()
                .any(|sample| sample.abs() > 0.001));
            let decoded = tokio::time::timeout(Duration::from_secs(2), decoded_rx.recv())
                .await
                .expect("native voice receiver did not decode remote Opus")
                .expect("native voice decode channel closed");
            assert_eq!(decoded.member_id, "receiver");
            assert!(!decoded.source_id.is_empty());
            assert_eq!(decoded.samples.len(), FRAME_SAMPLES * PLAYBACK_CHANNELS);
            assert!(status.lock().unwrap().received_packets > 0);

            if let Ok(mut signals) = outbound_signals.lock() {
                signals.clear();
            }
            let repeated_offer = receiver.create_offer(None).await.unwrap();
            receiver
                .set_local_description(repeated_offer.clone())
                .await
                .unwrap();
            engine
                .handle_signal(
                    "receiver".to_string(),
                    "offer",
                    json!(repeated_offer.clone()),
                )
                .await
                .unwrap();
            engine
                .handle_signal("receiver".to_string(), "offer", json!(repeated_offer))
                .await
                .unwrap();
            let repeated_answers = outbound_signals
                .lock()
                .map(|signals| {
                    signals
                        .iter()
                        .filter(|signal| signal.signal_type == "answer")
                        .map(|signal| {
                            serde_json::from_value::<RTCSessionDescription>(signal.data.clone())
                                .unwrap()
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            assert_eq!(repeated_answers.len(), 2);
            receiver
                .set_remote_description(repeated_answers[0].clone())
                .await
                .unwrap();
            engine
                .handle_signal(
                    "receiver".to_string(),
                    "answer",
                    json!(repeated_answers[0].clone()),
                )
                .await
                .unwrap();
            engine.close_all().await;
            receiver.close().await.unwrap();
        });
    }
}

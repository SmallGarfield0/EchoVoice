use base64::{engine::general_purpose, Engine as _};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ColorType, ImageEncoder};
use std::collections::HashMap;
use std::mem;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crate::{DesktopAudioProcessSource, DesktopAudioProcessSources};
use windows::core::{Error, IUnknown, Interface, HRESULT, PCWSTR, PROPVARIANT};
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO, BI_RGB,
    DIB_RGB_COLORS, HBRUSH, HDC,
};
use windows::Win32::Media::Audio::{
    eRender, ActivateAudioInterfaceAsync, AudioSessionStateActive,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    IAudioSessionControl2, IAudioSessionManager, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, DEVICE_STATE_ACTIVE, PROCESS_LOOPBACK_MODE,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::ExtractIconExW;
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, DrawIconEx, EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, DI_NORMAL, GW_OWNER, HICON,
};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;

pub struct LoopbackPacket {
    pub frames: usize,
    pub device_position: Option<u64>,
    pub qpc_100ns: Option<u64>,
    pub discontinuity: bool,
}

#[derive(Default)]
pub struct LoopbackClock {
    expected_device_position: Option<u64>,
    next_tick: u64,
    qpc_origin: Option<(u64, u64)>,
}

impl LoopbackClock {
    pub fn observe(&mut self, packet: &LoopbackPacket) -> (u64, bool) {
        // Sample positions preserve the exact PCM cadence. QPC also spans
        // intervals where an inactive process produced no loopback packets.
        let skipped = packet
            .device_position
            .zip(self.expected_device_position)
            .map(|(current, expected)| current.saturating_sub(expected))
            .unwrap_or(0);
        let mut tick = self.next_tick.saturating_add(skipped);
        if let Some(qpc) = packet.qpc_100ns {
            let (base_qpc, base_tick) = *self.qpc_origin.get_or_insert((qpc, tick));
            let elapsed =
                u128::from(qpc.saturating_sub(base_qpc)) * u128::from(SAMPLE_RATE) / 10_000_000;
            let clock_tick = base_tick.saturating_add(elapsed as u64);
            // Ignore small driver timestamp jitter during continuous capture.
            if packet.discontinuity || clock_tick.saturating_sub(tick) > u64::from(SAMPLE_RATE / 10)
            {
                tick = tick.max(clock_tick);
            }
        }
        let discontinuous = packet.discontinuity || tick != self.next_tick;
        self.next_tick = tick.saturating_add(packet.frames as u64);
        self.expected_device_position = packet
            .device_position
            .map(|start| start.saturating_add(packet.frames as u64));
        (tick, discontinuous)
    }
}

pub fn list_process_sources() -> Result<DesktopAudioProcessSources, String> {
    thread::Builder::new()
        .name("ev-audio-session-enumeration".to_string())
        .spawn(list_process_sources_on_worker)
        .map_err(|err| format!("start Windows audio-session enumeration: {err}"))?
        .join()
        .map_err(|_| "Windows audio-session enumeration panicked".to_string())?
}

fn list_process_sources_on_worker() -> Result<DesktopAudioProcessSources, String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|err| format!("initialize audio-session COM apartment: {err}"))?;
    }
    let result = enumerate_process_sources();
    unsafe { CoUninitialize() };
    result
}

fn enumerate_process_sources() -> Result<DesktopAudioProcessSources, String> {
    let device_enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|err| format!("create Windows audio device enumerator: {err}"))?
    };
    let devices = unsafe {
        device_enumerator
            .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
            .map_err(|err| format!("enumerate active Windows audio outputs: {err}"))?
    };
    let device_count = unsafe {
        devices
            .GetCount()
            .map_err(|err| format!("read Windows audio output count: {err}"))?
    };
    let mut process_states = HashMap::<u32, bool>::new();
    let mut warnings = Vec::new();
    for index in 0..device_count {
        let result = (|| -> Result<(), String> {
            let device = unsafe {
                devices
                    .Item(index)
                    .map_err(|err| format!("open Windows audio output {index}: {err}"))?
            };
            let manager: IAudioSessionManager = unsafe {
                device
                    .Activate(CLSCTX_ALL, None)
                    .map_err(|err| format!("open Windows audio session manager {index}: {err}"))?
            };
            let manager: IAudioSessionManager2 = manager
                .cast()
                .map_err(|err| format!("open Windows audio session manager v2 {index}: {err}"))?;
            let sessions = unsafe {
                manager
                    .GetSessionEnumerator()
                    .map_err(|err| format!("enumerate Windows audio sessions {index}: {err}"))?
            };
            let session_count = unsafe {
                sessions
                    .GetCount()
                    .map_err(|err| format!("read Windows audio session count {index}: {err}"))?
            };
            for session_index in 0..session_count {
                let session = match unsafe { sessions.GetSession(session_index) } {
                    Ok(session) => session,
                    Err(err) => {
                        warnings.push(format!(
                            "open Windows audio session {index}:{session_index}: {err}"
                        ));
                        continue;
                    }
                };
                let session_v2: IAudioSessionControl2 = match session.cast() {
                    Ok(session) => session,
                    Err(_) => continue,
                };
                let process_id = match unsafe { session_v2.GetProcessId() } {
                    Ok(process_id) if process_id != 0 && process_id != std::process::id() => {
                        process_id
                    }
                    _ => continue,
                };
                let active = unsafe { session.GetState() }
                    .map(|state| state == AudioSessionStateActive)
                    .unwrap_or(false);
                process_states
                    .entry(process_id)
                    .and_modify(|current| *current |= active)
                    .or_insert(active);
            }
            Ok(())
        })();
        if let Err(err) = result {
            warnings.push(err);
        }
    }

    let window_titles = visible_window_titles_by_process();
    let mut icon_cache = HashMap::<PathBuf, Option<String>>::new();
    let mut sources = process_states
        .into_iter()
        .map(|(process_id, active)| {
            let image_path = process_image_path(process_id);
            let app_name = image_path.as_deref().and_then(process_name_from_path);
            let icon_data_url = image_path.as_ref().and_then(|path| {
                icon_cache
                    .entry(path.clone())
                    .or_insert_with(|| process_icon_data_url(path))
                    .clone()
            });
            let name = window_titles
                .get(&process_id)
                .cloned()
                .or_else(|| app_name.clone())
                .unwrap_or_else(|| format!("Process {process_id}"));
            DesktopAudioProcessSource {
                source_id: format!("audio-process:{process_id}"),
                process_id,
                name,
                app_name,
                icon_data_url,
                active,
            }
        })
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| {
        right
            .active
            .cmp(&left.active)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.process_id.cmp(&right.process_id))
    });
    Ok(DesktopAudioProcessSources {
        backend: "windows-audio-sessions".to_string(),
        sources,
        warnings,
    })
}

fn visible_window_titles_by_process() -> HashMap<u32, String> {
    unsafe extern "system" fn window_proc(hwnd: HWND, data: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok() {
            return true.into();
        }
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return true.into();
        }
        let mut buffer = vec![0_u16; length as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buffer);
        if copied <= 0 {
            return true.into();
        }
        let title = String::from_utf16_lossy(&buffer[..copied as usize])
            .trim()
            .to_string();
        if title.is_empty() {
            return true.into();
        }
        let mut process_id = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id != 0 {
            let titles = &mut *(data.0 as *mut HashMap<u32, String>);
            titles.entry(process_id).or_insert(title);
        }
        true.into()
    }

    let mut titles = HashMap::new();
    let _ = unsafe { EnumWindows(Some(window_proc), LPARAM(&mut titles as *mut _ as isize)) };
    titles
}

fn process_image_path(process_id: u32) -> Option<PathBuf> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()? };
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            Default::default(),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    if result.is_err() || length == 0 {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(
        &buffer[..length as usize],
    )))
}

fn process_name_from_path(path: &Path) -> Option<String> {
    path.file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
}

fn process_icon_data_url(path: &Path) -> Option<String> {
    const ICON_SIZE: i32 = 48;

    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut icon = HICON::default();
    let extracted =
        unsafe { ExtractIconExW(PCWSTR(wide_path.as_ptr()), 0, Some(&mut icon), None, 1) };
    if extracted == 0 || icon.0.is_null() {
        return None;
    }

    let result = icon_to_png_data_url(icon, ICON_SIZE);
    unsafe {
        let _ = DestroyIcon(icon);
    }
    result
}

fn icon_to_png_data_url(icon: HICON, size: i32) -> Option<String> {
    if icon.0.is_null() || !(16..=128).contains(&size) {
        return None;
    }

    let memory_dc = unsafe { CreateCompatibleDC(HDC::default()) };
    if memory_dc.is_invalid() {
        return None;
    }

    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize =
        mem::size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = size;
    info.bmiHeader.biHeight = -size;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB.0;
    let mut bits = std::ptr::null_mut();
    let bitmap = match unsafe {
        CreateDIBSection(
            memory_dc,
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            HANDLE::default(),
            0,
        )
    } {
        Ok(bitmap) if !bits.is_null() => bitmap,
        _ => {
            unsafe {
                let _ = DeleteDC(memory_dc);
            }
            return None;
        }
    };
    let old_object = unsafe { SelectObject(memory_dc, bitmap) };
    let result = (|| {
        let bgra = unsafe {
            std::slice::from_raw_parts_mut(bits.cast::<u8>(), (size * size * 4) as usize)
        };
        for pixel in bgra.chunks_exact_mut(4) {
            // The icon tile uses the same neutral dark surface as the picker. An
            // opaque base also renders legacy mask-only Win32 icons correctly.
            pixel.copy_from_slice(&[15, 13, 11, 255]);
        }
        unsafe {
            DrawIconEx(
                memory_dc,
                0,
                0,
                icon,
                size,
                size,
                0,
                HBRUSH::default(),
                DI_NORMAL,
            )
            .ok()?;
        }
        let mut rgb = Vec::with_capacity((size * size * 3) as usize);
        for pixel in bgra.chunks_exact(4) {
            rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
        let mut png = Vec::new();
        PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Adaptive)
            .write_image(&rgb, size as u32, size as u32, ColorType::Rgb8.into())
            .ok()?;
        Some(format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(png)
        ))
    })();
    unsafe {
        if !old_object.is_invalid() {
            SelectObject(memory_dc, old_object);
        }
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(memory_dc);
    }
    result
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessLoopbackMode {
    IncludeProcessTree,
    ExcludeProcessTree,
}

impl ProcessLoopbackMode {
    fn as_windows(self) -> PROCESS_LOOPBACK_MODE {
        match self {
            Self::IncludeProcessTree => PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            Self::ExcludeProcessTree => PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        }
    }
}

pub struct ProcessLoopbackCapture {
    audio_client: IAudioClient,
    capture_client: IAudioCaptureClient,
    com_initialized: bool,
}

impl ProcessLoopbackCapture {
    pub fn open(target_process_id: u32, mode: ProcessLoopbackMode) -> Result<Self, String> {
        if target_process_id == 0 {
            return Err("process loopback requires a non-zero target process id".to_string());
        }
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|err| format!("initialize process-loopback COM apartment: {err}"))?;
        }

        match Self::open_initialized(target_process_id, mode) {
            Ok(capture) => Ok(capture),
            Err(err) => {
                unsafe { CoUninitialize() };
                Err(err)
            }
        }
    }

    fn open_initialized(target_process_id: u32, mode: ProcessLoopbackMode) -> Result<Self, String> {
        let audio_client = activate_audio_client(target_process_id, mode)?;
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: CHANNELS as u16,
            nSamplesPerSec: SAMPLE_RATE,
            nAvgBytesPerSec: SAMPLE_RATE * CHANNELS as u32 * 2,
            nBlockAlign: (CHANNELS * 2) as u16,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        unsafe {
            audio_client
                .Initialize(AUDCLNT_SHAREMODE_SHARED, stream_flags, 0, 0, &format, None)
                .map_err(|err| format!("initialize Windows process-loopback stream: {err}"))?;
        }
        let capture_client = unsafe {
            audio_client
                .GetService::<IAudioCaptureClient>()
                .map_err(|err| format!("open Windows process-loopback capture service: {err}"))?
        };
        unsafe {
            audio_client
                .Start()
                .map_err(|err| format!("start Windows process-loopback capture: {err}"))?;
        }
        Ok(Self {
            audio_client,
            capture_client,
            com_initialized: true,
        })
    }

    pub fn read_available(&self, output: &mut Vec<f32>) -> Result<usize, String> {
        output.clear();
        let mut captured_frames = 0_usize;
        while let Some(packet) = self.read_packet(output)? {
            captured_frames += packet.frames;
        }
        Ok(captured_frames)
    }

    /// Append exactly one WASAPI packet and expose its first frame's source time.
    pub fn read_packet(&self, output: &mut Vec<f32>) -> Result<Option<LoopbackPacket>, String> {
        let packet_frames = unsafe {
            self.capture_client
                .GetNextPacketSize()
                .map_err(|err| format!("read Windows process-loopback packet size: {err}"))?
        };
        if packet_frames == 0 {
            return Ok(None);
        }

        let mut data = std::ptr::null_mut();
        let mut frames = 0_u32;
        let mut flags = 0_u32;
        let mut device_position = 0;
        let mut qpc = 0;
        unsafe {
            self.capture_client
                .GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    Some(&mut device_position),
                    Some(&mut qpc),
                )
                .map_err(|err| format!("read Windows process-loopback buffer: {err}"))?;
        }
        if frames == 0 {
            return Ok(None);
        }
        let append_result = append_pcm16_stereo(
            output,
            data,
            frames as usize,
            flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0,
        );
        let release_result = unsafe { self.capture_client.ReleaseBuffer(frames) }
            .map_err(|err| format!("release Windows process-loopback buffer: {err}"));
        append_result?;
        release_result?;
        let timestamp_valid = flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0;
        Ok(Some(LoopbackPacket {
            frames: frames as usize,
            device_position: timestamp_valid.then_some(device_position),
            qpc_100ns: (timestamp_valid && qpc != 0).then_some(qpc),
            discontinuity: flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0,
        }))
    }
}

impl Drop for ProcessLoopbackCapture {
    fn drop(&mut self) {
        let _ = unsafe { self.audio_client.Stop() };
        if self.com_initialized {
            unsafe { CoUninitialize() };
            self.com_initialized = false;
        }
    }
}

fn append_pcm16_stereo(
    output: &mut Vec<f32>,
    data: *mut u8,
    frames: usize,
    silent: bool,
) -> Result<(), String> {
    let sample_count = frames
        .checked_mul(CHANNELS)
        .ok_or_else(|| "process-loopback sample count overflow".to_string())?;
    if silent {
        output.resize(output.len().saturating_add(sample_count), 0.0);
        return Ok(());
    }
    if data.is_null() && sample_count > 0 {
        return Err("Windows process-loopback returned a null PCM buffer".to_string());
    }
    let samples = unsafe { std::slice::from_raw_parts(data.cast::<i16>(), sample_count) };
    output.extend(samples.iter().map(|sample| *sample as f32 / 32768.0));
    Ok(())
}

#[windows::core::implement(IActivateAudioInterfaceCompletionHandler)]
struct AudioActivationHandler(mpsc::Sender<windows::core::Result<IUnknown>>);

impl IActivateAudioInterfaceCompletionHandler_Impl for AudioActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        operation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let result = operation
            .ok_or_else(|| {
                Error::new(
                    HRESULT(0x8000_4003_u32 as i32),
                    "missing audio activation operation",
                )
            })
            .and_then(audio_activation_result);
        let _ = self.0.send(result);
        Ok(())
    }
}

fn audio_activation_result(
    operation: &IActivateAudioInterfaceAsyncOperation,
) -> windows::core::Result<IUnknown> {
    let mut activation_result = HRESULT::default();
    let mut interface = None;
    unsafe {
        operation.GetActivateResult(&mut activation_result, &mut interface)?;
    }
    activation_result.ok()?;
    interface.ok_or_else(|| {
        Error::new(
            HRESULT(0x8000_4005_u32 as i32),
            "Windows returned no process-loopback audio interface",
        )
    })
}

fn activate_audio_client(
    target_process_id: u32,
    mode: ProcessLoopbackMode,
) -> Result<IAudioClient, String> {
    let mut activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: target_process_id,
                ProcessLoopbackMode: mode.as_windows(),
            },
        },
    };
    let raw_prop_variant = RawBlobPropVariant {
        vt: 65,
        reserved: [0; 3],
        blob: RawBlob {
            size: mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            data: (&mut activation_params as *mut AUDIOCLIENT_ACTIVATION_PARAMS).cast::<u8>(),
        },
    };
    let prop_variant = &raw_prop_variant as *const RawBlobPropVariant as *const PROPVARIANT;
    let (sender, receiver) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = AudioActivationHandler(sender).into();
    let _operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(prop_variant),
            &handler,
        )
        .map_err(|err| format!("activate Windows process-loopback audio interface: {err}"))?
    };
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "timed out waiting for Windows process-loopback activation".to_string())?
        .map_err(|err| format!("activate Windows process-loopback audio interface: {err}"))?
        .cast::<IAudioClient>()
        .map_err(|err| format!("cast Windows process-loopback audio client: {err}"))
}

#[repr(C)]
struct RawBlob {
    size: u32,
    data: *mut u8,
}

#[repr(C)]
struct RawBlobPropVariant {
    vt: u16,
    reserved: [u16; 3],
    blob: RawBlob,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn activation_prop_variant_matches_windows_layout() {
        assert_eq!(
            mem::size_of::<RawBlobPropVariant>(),
            mem::size_of::<PROPVARIANT>()
        );
        assert_eq!(
            mem::align_of::<RawBlobPropVariant>(),
            mem::align_of::<PROPVARIANT>()
        );
    }

    #[test]
    fn silent_packets_expand_to_stereo_pcm() {
        let mut output = vec![0.5];
        append_pcm16_stereo(&mut output, std::ptr::null_mut(), 4, true).unwrap();
        assert_eq!(output.len(), 9);
        assert!(output[1..].iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn enumerated_audio_process_sources_are_normalized() {
        let result = list_process_sources().unwrap();
        let mut ids = HashSet::new();
        for source in result.sources {
            assert_ne!(source.process_id, 0);
            assert_ne!(source.process_id, std::process::id());
            assert!(!source.name.trim().is_empty());
            if let Some(icon) = source.icon_data_url {
                assert!(icon.starts_with("data:image/png;base64,"));
            }
            assert!(ids.insert(source.source_id));
        }
    }

    #[test]
    fn extracts_and_encodes_a_windows_resource_icon() {
        let system_root = std::env::var_os("SystemRoot").expect("SystemRoot is available");
        let shell_library = PathBuf::from(system_root)
            .join("System32")
            .join("shell32.dll");
        let icon = process_icon_data_url(&shell_library).expect("shell32 exposes an icon");
        assert!(icon.starts_with("data:image/png;base64,"));
        assert!(icon.len() > 128);
    }

    #[test]
    fn loopback_clock_preserves_missing_audio_intervals() {
        let mut clock = LoopbackClock::default();
        let mut packet = LoopbackPacket {
            frames: 480,
            device_position: Some(100),
            qpc_100ns: Some(1_000_000),
            discontinuity: false,
        };
        assert_eq!(clock.observe(&packet), (0, false));
        // Invalid timestamps on one packet leave its PCM on the sample clock.
        packet.device_position = None;
        packet.qpc_100ns = None;
        assert_eq!(clock.observe(&packet), (480, false));
        // Render suspension followed by fresh audio. No old PCM should be
        // joined to it, even if the virtual endpoint did not flag a glitch.
        packet.device_position = Some(1060);
        packet.qpc_100ns = Some(11_000_000);
        assert_eq!(clock.observe(&packet), (48_000, true));
        packet.device_position = Some(2500);
        packet.qpc_100ns = None;
        assert_eq!(clock.observe(&packet), (49_440, true));
    }

    #[test]
    #[ignore = "requires a Windows audio engine and Windows 10 build 20348 or newer"]
    fn opens_process_exclusion_loopback_on_supported_windows() {
        let capture = ProcessLoopbackCapture::open(
            std::process::id(),
            ProcessLoopbackMode::ExcludeProcessTree,
        )
        .unwrap();
        let mut samples = Vec::new();
        capture.read_available(&mut samples).unwrap();
    }
}

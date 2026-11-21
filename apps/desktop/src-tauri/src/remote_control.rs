use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;

#[derive(Debug, Clone)]
pub struct RemoteControlTarget {
    pub source_id: String,
    pub source_kind: String,
    pub source_process_id: Option<u32>,
    pub source_x: i32,
    pub source_y: i32,
    pub source_width: i32,
    pub source_height: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlHostStartRequest {
    pub control_id: String,
    pub sender_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlHostStopRequest {
    pub control_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlInputRequest {
    pub control_id: String,
    pub sender_session_id: String,
    pub sequence: u64,
    pub event: RemoteControlInputEvent,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum RemoteControlInputEvent {
    PointerMove {
        x: f64,
        y: f64,
        buttons: u32,
    },
    PointerButton {
        x: f64,
        y: f64,
        button: u32,
        buttons: u32,
        pressed: bool,
    },
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
    },
    ReleaseAll,
    Key {
        code: String,
        key: String,
        pressed: bool,
        repeat: bool,
        modifiers: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControlLocalInputEvent {
    control_id: String,
    at_ms: i64,
    respect_until_ms: i64,
}

#[derive(Default)]
pub struct RemoteControlHostManager {
    operation: Mutex<()>,
    session: Mutex<Option<RemoteControlHostSession>>,
}

struct RemoteControlHostSession {
    control_id: String,
    sender_session_id: String,
    target: RemoteControlTarget,
    last_sequence: u64,
    monitor: platform::LocalInputMonitor,
}

impl RemoteControlHostManager {
    pub fn start(
        &self,
        app: AppHandle,
        request: RemoteControlHostStartRequest,
        target: RemoteControlTarget,
    ) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "remote control host operation is poisoned".to_string())?;
        if request.control_id.trim().is_empty() || request.sender_session_id.trim().is_empty() {
            return Err("remote control session identity is missing".to_string());
        }
        if !matches!(target.source_kind.as_str(), "screen" | "window") {
            return Err(
                "remote control is only available for screen and window sources".to_string(),
            );
        }
        self.stop_all_locked()?;
        let monitor = platform::start_local_input_monitor(app, request.control_id.clone())?;
        *self
            .session
            .lock()
            .map_err(|_| "remote control host manager is poisoned".to_string())? =
            Some(RemoteControlHostSession {
                control_id: request.control_id,
                sender_session_id: request.sender_session_id,
                target,
                last_sequence: 0,
                monitor,
            });
        Ok(())
    }

    pub fn stop(&self, control_id: &str) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "remote control host operation is poisoned".to_string())?;
        let should_stop = self
            .session
            .lock()
            .map_err(|_| "remote control host manager is poisoned".to_string())?
            .as_ref()
            .map(|session| session.control_id == control_id)
            .unwrap_or(false);
        if should_stop {
            self.stop_all_locked()?;
        }
        Ok(())
    }

    pub fn stop_for_sender(&self, sender_session_id: &str) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "remote control host operation is poisoned".to_string())?;
        let should_stop = self
            .session
            .lock()
            .map_err(|_| "remote control host manager is poisoned".to_string())?
            .as_ref()
            .map(|session| session.sender_session_id == sender_session_id)
            .unwrap_or(false);
        if should_stop {
            self.stop_all_locked()?;
        }
        Ok(())
    }

    pub fn apply(&self, request: RemoteControlInputRequest) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "remote control host operation is poisoned".to_string())?;
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "remote control host manager is poisoned".to_string())?;
        let session = guard
            .as_mut()
            .ok_or_else(|| "remote control host session is not active".to_string())?;
        if session.control_id != request.control_id
            || session.sender_session_id != request.sender_session_id
        {
            return Err("remote control input does not match the active host session".to_string());
        }
        if request.sequence == 0 || request.sequence <= session.last_sequence {
            return Err("remote control input sequence is stale".to_string());
        }
        if matches!(&request.event, RemoteControlInputEvent::ReleaseAll) {
            session.monitor.release_inputs();
            session.last_sequence = request.sequence;
            return Ok(());
        }
        if session.monitor.respect_until_ms() > now_ms() {
            return Err("remote control input is suspended for local input".to_string());
        }
        platform::apply_input(&session.target, &request.event)?;
        session.monitor.record_input(&request.event);
        session.last_sequence = request.sequence;
        Ok(())
    }

    fn stop_all_locked(&self) -> Result<(), String> {
        let session = self
            .session
            .lock()
            .map_err(|_| "remote control host manager is poisoned".to_string())?
            .take();
        if let Some(session) = session {
            session.monitor.stop();
        }
        Ok(())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{
        now_ms, RemoteControlInputEvent, RemoteControlLocalInputEvent, RemoteControlTarget,
    };
    use std::collections::{HashMap, HashSet};
    use std::mem::size_of;
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
    use std::sync::mpsc::{self, SyncSender};
    use std::sync::{Arc, Mutex, OnceLock, Weak};
    use std::thread;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
        MOUSEEVENTF_MOVE_NOCOALESCE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
        VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetForegroundWindow, GetSystemMetrics,
        GetWindowRect, GetWindowThreadProcessId, IsChild, IsWindow, PeekMessageW,
        SetForegroundWindow, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
        WindowFromPoint, GA_ROOT, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, PM_REMOVE,
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
        WH_KEYBOARD_LL, WH_MOUSE_LL,
    };

    const INJECTED_INPUT_MARKER: usize = 0x4556_5243_544C;
    const LOCAL_INPUT_RESPECT_MS: i64 = 3000;
    const LOCAL_INPUT_EVENT_INTERVAL_MS: i64 = 200;

    static HOOK_STATE: OnceLock<Mutex<Option<Weak<HookState>>>> = OnceLock::new();

    struct HookState {
        app: AppHandle,
        control_id: String,
        active: AtomicBool,
        respect_until_ms: Arc<AtomicI64>,
        last_event_at_ms: AtomicI64,
        pressed_inputs: Arc<Mutex<PressedInputState>>,
    }

    #[derive(Default)]
    struct PressedInputState {
        buttons: HashSet<u32>,
        keys: HashMap<String, String>,
    }

    impl PressedInputState {
        fn record(&mut self, event: &RemoteControlInputEvent) {
            match event {
                RemoteControlInputEvent::PointerButton {
                    button, pressed, ..
                } => {
                    if *pressed {
                        self.buttons.insert(*button);
                    } else {
                        self.buttons.remove(button);
                    }
                }
                RemoteControlInputEvent::Key {
                    code, key, pressed, ..
                } => {
                    if *pressed {
                        self.keys.insert(code.clone(), key.clone());
                    } else {
                        self.keys.remove(code);
                    }
                }
                _ => {}
            }
        }

        fn take_all(&mut self) -> (Vec<u32>, Vec<(String, String)>) {
            let buttons = self.buttons.drain().collect();
            let keys = self.keys.drain().collect();
            (buttons, keys)
        }
    }

    pub struct LocalInputMonitor {
        state: Arc<HookState>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl LocalInputMonitor {
        pub fn respect_until_ms(&self) -> i64 {
            self.state.respect_until_ms.load(Ordering::SeqCst)
        }

        pub fn record_input(&self, event: &RemoteControlInputEvent) {
            if let Ok(mut pressed_inputs) = self.state.pressed_inputs.lock() {
                pressed_inputs.record(event);
            }
        }

        pub fn release_inputs(&self) {
            release_pressed_inputs(&self.state.pressed_inputs);
        }

        pub fn stop(mut self) {
            release_pressed_inputs(&self.state.pressed_inputs);
            self.state.active.store(false, Ordering::SeqCst);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
            if let Ok(mut slot) = hook_state_slot().lock() {
                *slot = None;
            }
        }
    }

    pub fn start_local_input_monitor(
        app: AppHandle,
        control_id: String,
    ) -> Result<LocalInputMonitor, String> {
        let state = Arc::new(HookState {
            app,
            control_id,
            active: AtomicBool::new(true),
            respect_until_ms: Arc::new(AtomicI64::new(0)),
            last_event_at_ms: AtomicI64::new(0),
            pressed_inputs: Arc::new(Mutex::new(PressedInputState::default())),
        });
        *hook_state_slot()
            .lock()
            .map_err(|_| "remote control hook state is poisoned".to_string())? =
            Some(Arc::downgrade(&state));
        let worker_state = Arc::clone(&state);
        let (startup_tx, startup_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("ev-remote-control-input-monitor".to_string())
            .spawn(move || run_hook_loop(worker_state, startup_tx))
            .map_err(|err| format!("start remote control input monitor: {err}"))?;
        match startup_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                state.active.store(false, Ordering::SeqCst);
                let _ = worker.join();
                if let Ok(mut slot) = hook_state_slot().lock() {
                    *slot = None;
                }
                return Err(err);
            }
            Err(_) => {
                state.active.store(false, Ordering::SeqCst);
                let _ = worker.join();
                if let Ok(mut slot) = hook_state_slot().lock() {
                    *slot = None;
                }
                return Err("remote control input monitor did not start in time".to_string());
            }
        }
        Ok(LocalInputMonitor {
            state,
            worker: Some(worker),
        })
    }

    fn run_hook_loop(state: Arc<HookState>, startup: SyncSender<Result<(), String>>) {
        let module = match unsafe { GetModuleHandleW(None) } {
            Ok(module) => HINSTANCE(module.0),
            Err(err) => {
                let _ = startup.send(Err(format!("read EchoVoice module handle: {err}")));
                state.active.store(false, Ordering::SeqCst);
                return;
            }
        };
        let mouse_hook =
            unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(remote_control_mouse_hook), module, 0) };
        let mouse_hook = match mouse_hook {
            Ok(hook) => hook,
            Err(err) => {
                let _ = startup.send(Err(format!("install remote mouse input monitor: {err}")));
                state.active.store(false, Ordering::SeqCst);
                return;
            }
        };
        let keyboard_hook = unsafe {
            SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(remote_control_keyboard_hook),
                module,
                0,
            )
        };
        let keyboard_hook = match keyboard_hook {
            Ok(hook) => hook,
            Err(err) => {
                unsafe {
                    let _ = UnhookWindowsHookEx(mouse_hook);
                }
                let _ = startup.send(Err(format!("install remote keyboard input monitor: {err}")));
                state.active.store(false, Ordering::SeqCst);
                return;
            }
        };
        let _ = startup.send(Ok(()));
        while state.active.load(Ordering::SeqCst) {
            let mut message = MSG::default();
            while unsafe { PeekMessageW(&mut message, HWND::default(), 0, 0, PM_REMOVE).as_bool() }
            {
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
        unsafe {
            let _ = UnhookWindowsHookEx(mouse_hook);
            let _ = UnhookWindowsHookEx(keyboard_hook);
        }
    }

    unsafe extern "system" fn remote_control_mouse_hook(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            let input = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            if input.dwExtraInfo != INJECTED_INPUT_MARKER {
                mark_local_input();
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    unsafe extern "system" fn remote_control_keyboard_hook(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            let input = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            if input.dwExtraInfo != INJECTED_INPUT_MARKER {
                mark_local_input();
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    fn mark_local_input() {
        let state = hook_state_slot()
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().and_then(Weak::upgrade));
        let Some(state) = state else {
            return;
        };
        if !state.active.load(Ordering::SeqCst) {
            return;
        }
        let at_ms = now_ms();
        let respect_until_ms = at_ms.saturating_add(LOCAL_INPUT_RESPECT_MS);
        state
            .respect_until_ms
            .store(respect_until_ms, Ordering::SeqCst);
        release_pressed_inputs(&state.pressed_inputs);
        let previous = state.last_event_at_ms.swap(at_ms, Ordering::SeqCst);
        if at_ms.saturating_sub(previous) < LOCAL_INPUT_EVENT_INTERVAL_MS {
            return;
        }
        let _ = state.app.emit(
            "remote-control-local-input",
            RemoteControlLocalInputEvent {
                control_id: state.control_id.clone(),
                at_ms,
                respect_until_ms,
            },
        );
    }

    fn hook_state_slot() -> &'static Mutex<Option<Weak<HookState>>> {
        HOOK_STATE.get_or_init(|| Mutex::new(None))
    }

    pub fn apply_input(
        target: &RemoteControlTarget,
        event: &RemoteControlInputEvent,
    ) -> Result<(), String> {
        let (rect, window) = target_rect(target)?;
        if let Some(window) = window {
            if unsafe { GetForegroundWindow() } != window {
                unsafe {
                    let _ = SetForegroundWindow(window);
                }
            }
            if unsafe { GetForegroundWindow() } != window {
                return Err(
                    "shared window cannot receive remote input while it is not in the foreground"
                        .to_string(),
                );
            }
        }
        match event {
            RemoteControlInputEvent::PointerMove { x, y, buttons } => {
                let _ = buttons;
                send_pointer_position(rect, window, *x, *y)
            }
            RemoteControlInputEvent::PointerButton {
                x,
                y,
                button,
                buttons,
                pressed,
            } => {
                let _ = buttons;
                send_pointer_position(rect, window, *x, *y)?;
                send_pointer_button(*button, *pressed)
            }
            RemoteControlInputEvent::Wheel {
                x,
                y,
                delta_x,
                delta_y,
            } => {
                send_pointer_position(rect, window, *x, *y)?;
                send_wheel(*delta_x, *delta_y)
            }
            RemoteControlInputEvent::Key {
                code,
                key,
                pressed,
                repeat,
                modifiers,
            } => {
                let _ = repeat;
                if target.source_kind == "window" {
                    validate_window_key(code, modifiers)?;
                }
                send_key(code, key, *pressed)
            }
            RemoteControlInputEvent::ReleaseAll => Ok(()),
        }
    }

    fn validate_window_key(code: &str, modifiers: &[String]) -> Result<(), String> {
        let has_modifier = |value: &str| modifiers.iter().any(|modifier| modifier == value);
        let escapes_window = code.starts_with("Meta")
            || code == "PrintScreen"
            || has_modifier("Meta")
            || (has_modifier("Alt") && matches!(code, "Tab" | "Escape"))
            || (has_modifier("Control") && code == "Escape");
        if escapes_window {
            return Err("remote key combination is outside the shared window".to_string());
        }
        Ok(())
    }

    fn release_pressed_inputs(pressed_inputs: &Mutex<PressedInputState>) {
        let (buttons, keys) = pressed_inputs
            .lock()
            .map(|mut state| state.take_all())
            .unwrap_or_default();
        for button in buttons {
            let _ = send_pointer_button(button, false);
        }
        for (code, key) in keys {
            let _ = send_key(&code, &key, false);
        }
    }

    fn target_rect(target: &RemoteControlTarget) -> Result<(RECT, Option<HWND>), String> {
        if target.source_kind == "window" {
            let raw = target
                .source_id
                .strip_prefix("window:")
                .ok_or_else(|| "invalid shared window source id".to_string())?;
            let value = usize::from_str_radix(raw, 16)
                .map_err(|_| "invalid shared window source id".to_string())?;
            let window = HWND(value as *mut core::ffi::c_void);
            if !unsafe { IsWindow(window).as_bool() } {
                return Err("shared window is no longer available".to_string());
            }
            if let Some(expected_process_id) = target.source_process_id {
                let mut actual_process_id = 0;
                unsafe {
                    GetWindowThreadProcessId(window, Some(&mut actual_process_id));
                }
                if actual_process_id == 0 || actual_process_id != expected_process_id {
                    return Err("shared window identity changed".to_string());
                }
            }
            let mut rect = RECT::default();
            unsafe { GetWindowRect(window, &mut rect) }
                .map_err(|err| format!("read shared window bounds: {err}"))?;
            validate_rect(rect)?;
            return Ok((rect, Some(window)));
        }
        let rect = if target.source_width > 0 && target.source_height > 0 {
            RECT {
                left: target.source_x,
                top: target.source_y,
                right: target.source_x.saturating_add(target.source_width),
                bottom: target.source_y.saturating_add(target.source_height),
            }
        } else {
            virtual_desktop_rect()
        };
        validate_rect(rect)?;
        Ok((rect, None))
    }

    fn validate_rect(rect: RECT) -> Result<(), String> {
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return Err("remote control target bounds are invalid".to_string());
        }
        Ok(())
    }

    fn virtual_desktop_rect() -> RECT {
        let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
        let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
        RECT {
            left,
            top,
            right: left.saturating_add(unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }),
            bottom: top.saturating_add(unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }),
        }
    }

    fn send_pointer_position(
        rect: RECT,
        window: Option<HWND>,
        x: f64,
        y: f64,
    ) -> Result<(), String> {
        let (screen_x, screen_y) = normalized_screen_point(rect, x, y)?;
        if let Some(window) = window {
            validate_window_pointer_target(window, screen_x, screen_y)?;
        }
        let desktop = virtual_desktop_rect();
        let desktop_width = (desktop.right - desktop.left).max(1);
        let desktop_height = (desktop.bottom - desktop.top).max(1);
        let absolute_x = ((i64::from(screen_x - desktop.left) * 65_535)
            / i64::from((desktop_width - 1).max(1))) as i32;
        let absolute_y = ((i64::from(screen_y - desktop.top) * 65_535)
            / i64::from((desktop_height - 1).max(1))) as i32;
        send_inputs(&[mouse_input(
            absolute_x,
            absolute_y,
            0,
            MOUSEEVENTF_MOVE
                | MOUSEEVENTF_ABSOLUTE
                | MOUSEEVENTF_VIRTUALDESK
                | MOUSEEVENTF_MOVE_NOCOALESCE,
        )])
    }

    fn normalized_screen_point(rect: RECT, x: f64, y: f64) -> Result<(i32, i32), String> {
        if !x.is_finite()
            || !y.is_finite()
            || !(0.0..=1.0).contains(&x)
            || !(0.0..=1.0).contains(&y)
        {
            return Err("remote pointer coordinate is invalid".to_string());
        }
        let width = (rect.right - rect.left).max(1);
        let height = (rect.bottom - rect.top).max(1);
        let screen_x = rect.left + (x * f64::from(width - 1)).round() as i32;
        let screen_y = rect.top + (y * f64::from(height - 1)).round() as i32;
        Ok((screen_x, screen_y))
    }

    fn validate_window_pointer_target(
        target: HWND,
        screen_x: i32,
        screen_y: i32,
    ) -> Result<(), String> {
        let pointed = unsafe {
            WindowFromPoint(POINT {
                x: screen_x,
                y: screen_y,
            })
        };
        if pointed.is_invalid() {
            return Err("remote pointer is outside the shared window".to_string());
        }
        let pointed_root = unsafe { GetAncestor(pointed, GA_ROOT) };
        let target_root = unsafe { GetAncestor(target, GA_ROOT) };
        if pointed != target
            && pointed_root != target_root
            && !unsafe { IsChild(target, pointed).as_bool() }
        {
            return Err("remote pointer is blocked by another window".to_string());
        }
        Ok(())
    }

    fn send_pointer_button(button: u32, pressed: bool) -> Result<(), String> {
        let (flags, data) = match (button, pressed) {
            (0, true) => (MOUSEEVENTF_LEFTDOWN, 0),
            (0, false) => (MOUSEEVENTF_LEFTUP, 0),
            (1, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
            (1, false) => (MOUSEEVENTF_MIDDLEUP, 0),
            (2, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
            (2, false) => (MOUSEEVENTF_RIGHTUP, 0),
            (3, true) => (MOUSEEVENTF_XDOWN, 1),
            (3, false) => (MOUSEEVENTF_XUP, 1),
            (4, true) => (MOUSEEVENTF_XDOWN, 2),
            (4, false) => (MOUSEEVENTF_XUP, 2),
            _ => return Err("remote pointer button is unsupported".to_string()),
        };
        send_inputs(&[mouse_input(0, 0, data, flags)])
    }

    fn send_wheel(delta_x: f64, delta_y: f64) -> Result<(), String> {
        let mut inputs = Vec::with_capacity(2);
        let vertical = (-delta_y).round().clamp(-1200.0, 1200.0) as i32;
        let horizontal = delta_x.round().clamp(-1200.0, 1200.0) as i32;
        if vertical != 0 {
            inputs.push(mouse_input(0, 0, vertical as u32, MOUSEEVENTF_WHEEL));
        }
        if horizontal != 0 {
            inputs.push(mouse_input(0, 0, horizontal as u32, MOUSEEVENTF_HWHEEL));
        }
        if inputs.is_empty() {
            return Ok(());
        }
        send_inputs(&inputs)
    }

    fn send_key(code: &str, key: &str, pressed: bool) -> Result<(), String> {
        if let Some(virtual_key) = virtual_key_for_code(code) {
            let flags = if pressed {
                Default::default()
            } else {
                KEYEVENTF_KEYUP
            };
            return send_inputs(&[INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(virtual_key),
                        wScan: 0,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: INJECTED_INPUT_MARKER,
                    },
                },
            }]);
        }
        let mut utf16 = key.encode_utf16();
        let Some(unit) = utf16.next() else {
            return Err("remote key is unsupported".to_string());
        };
        if utf16.next().is_some() {
            return Err("remote key is unsupported".to_string());
        }
        let flags = if pressed {
            KEYEVENTF_UNICODE
        } else {
            KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        };
        send_inputs(&[INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: INJECTED_INPUT_MARKER,
                },
            },
        }])
    }

    fn virtual_key_for_code(code: &str) -> Option<u16> {
        if let Some(letter) = code.strip_prefix("Key") {
            let byte = letter.as_bytes().first().copied()?;
            if letter.len() == 1 && byte.is_ascii_uppercase() {
                return Some(u16::from(byte));
            }
        }
        if let Some(digit) = code.strip_prefix("Digit") {
            let byte = digit.as_bytes().first().copied()?;
            if digit.len() == 1 && byte.is_ascii_digit() {
                return Some(u16::from(byte));
            }
        }
        if let Some(function) = code
            .strip_prefix('F')
            .and_then(|value| value.parse::<u16>().ok())
        {
            if (1..=24).contains(&function) {
                return Some(111 + function);
            }
        }
        match code {
            "Backspace" => Some(0x08),
            "Tab" => Some(0x09),
            "Enter" | "NumpadEnter" => Some(0x0D),
            "ShiftLeft" | "ShiftRight" => Some(0x10),
            "ControlLeft" | "ControlRight" => Some(0x11),
            "AltLeft" | "AltRight" => Some(0x12),
            "Pause" => Some(0x13),
            "CapsLock" => Some(0x14),
            "Escape" => Some(0x1B),
            "Space" => Some(0x20),
            "PageUp" => Some(0x21),
            "PageDown" => Some(0x22),
            "End" => Some(0x23),
            "Home" => Some(0x24),
            "ArrowLeft" => Some(0x25),
            "ArrowUp" => Some(0x26),
            "ArrowRight" => Some(0x27),
            "ArrowDown" => Some(0x28),
            "PrintScreen" => Some(0x2C),
            "Insert" => Some(0x2D),
            "Delete" => Some(0x2E),
            "MetaLeft" | "MetaRight" => Some(0x5B),
            "ContextMenu" => Some(0x5D),
            "Numpad0" => Some(0x60),
            "Numpad1" => Some(0x61),
            "Numpad2" => Some(0x62),
            "Numpad3" => Some(0x63),
            "Numpad4" => Some(0x64),
            "Numpad5" => Some(0x65),
            "Numpad6" => Some(0x66),
            "Numpad7" => Some(0x67),
            "Numpad8" => Some(0x68),
            "Numpad9" => Some(0x69),
            "NumpadMultiply" => Some(0x6A),
            "NumpadAdd" => Some(0x6B),
            "NumpadSubtract" => Some(0x6D),
            "NumpadDecimal" => Some(0x6E),
            "NumpadDivide" => Some(0x6F),
            "Semicolon" => Some(0xBA),
            "Equal" => Some(0xBB),
            "Comma" => Some(0xBC),
            "Minus" => Some(0xBD),
            "Period" => Some(0xBE),
            "Slash" => Some(0xBF),
            "Backquote" => Some(0xC0),
            "BracketLeft" => Some(0xDB),
            "Backslash" => Some(0xDC),
            "BracketRight" => Some(0xDD),
            "Quote" => Some(0xDE),
            _ => None,
        }
    }

    fn mouse_input(
        dx: i32,
        dy: i32,
        mouse_data: u32,
        flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
    ) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: mouse_data,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: INJECTED_INPUT_MARKER,
                },
            },
        }
    }

    fn send_inputs(inputs: &[INPUT]) -> Result<(), String> {
        let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
        if sent != inputs.len() as u32 {
            return Err("Windows rejected remote input injection".to_string());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn tracks_pressed_remote_inputs_until_release() {
            let mut state = PressedInputState::default();
            state.record(&RemoteControlInputEvent::PointerButton {
                x: 0.5,
                y: 0.5,
                button: 0,
                buttons: 1,
                pressed: true,
            });
            state.record(&RemoteControlInputEvent::Key {
                code: "ControlLeft".to_string(),
                key: "Control".to_string(),
                pressed: true,
                repeat: false,
                modifiers: vec!["Control".to_string()],
            });

            let (buttons, keys) = state.take_all();
            assert_eq!(buttons, vec![0]);
            assert_eq!(
                keys,
                vec![("ControlLeft".to_string(), "Control".to_string())]
            );
            assert!(state.buttons.is_empty());
            assert!(state.keys.is_empty());
        }

        #[test]
        fn rejects_shortcuts_that_escape_a_shared_window() {
            assert!(validate_window_key("KeyA", &[]).is_ok());
            assert!(validate_window_key("Tab", &["Alt".to_string()]).is_err());
            assert!(validate_window_key("Escape", &["Control".to_string()]).is_err());
            assert!(validate_window_key("MetaLeft", &["Meta".to_string()]).is_err());
            assert!(validate_window_key("PrintScreen", &[]).is_err());
        }

        #[test]
        fn deserializes_release_all_input() {
            let event: RemoteControlInputEvent =
                serde_json::from_str(r#"{"type":"release_all"}"#).expect("release_all event");
            assert!(matches!(event, RemoteControlInputEvent::ReleaseAll));
        }

        #[test]
        fn maps_normalized_points_across_negative_display_coordinates() {
            let rect = RECT {
                left: -1920,
                top: -200,
                right: 0,
                bottom: 880,
            };
            assert_eq!(
                normalized_screen_point(rect, 0.0, 0.0).unwrap(),
                (-1920, -200)
            );
            assert_eq!(normalized_screen_point(rect, 1.0, 1.0).unwrap(), (-1, 879));
            assert_eq!(
                normalized_screen_point(rect, 0.5, 0.5).unwrap(),
                (-960, 340)
            );
            assert!(normalized_screen_point(rect, 1.01, 0.5).is_err());
        }

        #[test]
        #[ignore = "sends a no-op mouse event to the active Windows input desktop"]
        fn windows_send_input_smoke_test() {
            send_inputs(&[mouse_input(0, 0, 0, MOUSEEVENTF_MOVE)])
                .expect("Windows should accept a no-op remote input event");
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::{RemoteControlInputEvent, RemoteControlTarget};
    use tauri::AppHandle;

    pub struct LocalInputMonitor;

    impl LocalInputMonitor {
        pub fn respect_until_ms(&self) -> i64 {
            0
        }

        pub fn record_input(&self, _event: &RemoteControlInputEvent) {}

        pub fn release_inputs(&self) {}

        pub fn stop(self) {}
    }

    pub fn start_local_input_monitor(
        _app: AppHandle,
        _control_id: String,
    ) -> Result<LocalInputMonitor, String> {
        Err("remote control hosting is only available on Windows".to_string())
    }

    pub fn apply_input(
        _target: &RemoteControlTarget,
        _event: &RemoteControlInputEvent,
    ) -> Result<(), String> {
        Err("remote control hosting is only available on Windows".to_string())
    }
}

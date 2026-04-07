use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, WindowEvent};

#[cfg(target_os = "windows")]
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LCONTROL, VK_RCONTROL};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WINEVENT_OUTOFCONTEXT};

use crate::automation;
use crate::bridge::AppState;
use crate::debug_trace;
use crate::hotkey;

#[derive(Debug, Clone, Serialize)]
struct HotkeyTraceEvent {
    stage: String,
    shortcut: String,
    detail: String,
}

struct AutoSelectionState {
    last_text: String,
    last_emit: Instant,
}

struct ModifierHotkeyState {
    shift_pressed_count: u8,
    alt_pressed_count: u8,
    modifier_started_at: Option<Instant>,
    blocked: bool,
}

struct MouseSelectionState {
    left_pressed: bool,
    press_x: f64,
    press_y: f64,
    cursor_x: f64,
    cursor_y: f64,
    moved: bool,
    last_release_at: Option<Instant>,
    last_release_x: f64,
    last_release_y: f64,
}

struct NavigationHotkeyState {
    alt_pressed: bool,
    ctrl_pressed: bool,
    meta_pressed: bool,
    shift_pressed: bool,
}

static AUTO_SELECTION_STATE: OnceLock<Mutex<AutoSelectionState>> = OnceLock::new();
static PENDING_SELECTION_EVENT: OnceLock<Mutex<Option<SelectionEvent>>> = OnceLock::new();
static MODIFIER_HOTKEY_STATE: OnceLock<Mutex<ModifierHotkeyState>> = OnceLock::new();
static MOUSE_SELECTION_STATE: OnceLock<Mutex<MouseSelectionState>> = OnceLock::new();
static NAVIGATION_HOTKEY_STATE: OnceLock<Mutex<NavigationHotkeyState>> = OnceLock::new();
static OCR_POPOVER_OPENED_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
static CTRL_ENTER_INTERCEPT_ACTIVE: AtomicBool = AtomicBool::new(false);
static SELECTION_EVENT_SEQ: OnceLock<AtomicU64> = OnceLock::new();
#[cfg(target_os = "windows")]
static DESKTOP_SWITCH_APP: OnceLock<AppHandle> = OnceLock::new();
#[cfg(target_os = "windows")]
static DESKTOP_SWITCH_HOOK_STARTED: AtomicBool = AtomicBool::new(false);

const SHIFT_TRIGGER_MAX_HOLD_MS: u64 = 700;
const MOUSE_DRAG_MIN_DISTANCE_PX: f64 = 6.0;
const DOUBLE_CLICK_MAX_DISTANCE_PX: f64 = 14.0;
const DOUBLE_CLICK_MAX_INTERVAL_MS: u64 = 360;
const POINT_ANCHOR_HALF_WIDTH: i32 = 16;
const POINT_ANCHOR_HALF_HEIGHT: i32 = 14;
const POPOVER_BASE_WIDTH: f64 = 420.0;
const POPOVER_BASE_HEIGHT: f64 = 72.0;
const CURSOR_GAP: i32 = 10;
const CURSOR_ABOVE_EXTRA_GAP_MAX: i32 = 6;
const CURSOR_ABOVE_NEAR_BOTTOM_RATIO: f32 = 0.22;
const OCR_TRANSIENT_CLOSE_GUARD_MS: u64 = 1400;

fn emit_hotkey_trace(app: &AppHandle, stage: &str, shortcut: &str, detail: String) {
    if !debug_trace::enabled() {
        return;
    }

    let _ = app.emit(
        "hotkey-trace",
        HotkeyTraceEvent {
            stage: stage.to_owned(),
            shortcut: shortcut.to_owned(),
            detail,
        },
    );
}

fn auto_selection_state() -> &'static Mutex<AutoSelectionState> {
    AUTO_SELECTION_STATE.get_or_init(|| {
        Mutex::new(AutoSelectionState {
            last_text: String::new(),
            last_emit: Instant::now() - Duration::from_secs(5),
        })
    })
}

fn pending_selection_event() -> &'static Mutex<Option<SelectionEvent>> {
    PENDING_SELECTION_EVENT.get_or_init(|| Mutex::new(None))
}

fn modifier_hotkey_state() -> &'static Mutex<ModifierHotkeyState> {
    MODIFIER_HOTKEY_STATE.get_or_init(|| {
        Mutex::new(ModifierHotkeyState {
            shift_pressed_count: 0,
            alt_pressed_count: 0,
            modifier_started_at: None,
            blocked: false,
        })
    })
}

fn mouse_selection_state() -> &'static Mutex<MouseSelectionState> {
    MOUSE_SELECTION_STATE.get_or_init(|| {
        Mutex::new(MouseSelectionState {
            left_pressed: false,
            press_x: 0.0,
            press_y: 0.0,
            cursor_x: 0.0,
            cursor_y: 0.0,
            moved: false,
            last_release_at: None,
            last_release_x: 0.0,
            last_release_y: 0.0,
        })
    })
}

fn navigation_hotkey_state() -> &'static Mutex<NavigationHotkeyState> {
    NAVIGATION_HOTKEY_STATE.get_or_init(|| {
        Mutex::new(NavigationHotkeyState {
            alt_pressed: false,
            ctrl_pressed: false,
            meta_pressed: false,
            shift_pressed: false,
        })
    })
}

fn ocr_popover_opened_at() -> &'static Mutex<Option<Instant>> {
    OCR_POPOVER_OPENED_AT.get_or_init(|| Mutex::new(None))
}

fn next_selection_event_id() -> u64 {
    let seq = SELECTION_EVENT_SEQ.get_or_init(|| AtomicU64::new(1));
    seq.fetch_add(1, Ordering::Relaxed)
}

fn to_i32_coord(value: f64) -> i32 {
    if value.is_nan() {
        return 0;
    }
    if value <= i32::MIN as f64 {
        return i32::MIN;
    }
    if value >= i32::MAX as f64 {
        return i32::MAX;
    }
    value.round() as i32
}

fn make_rect(left: i32, top: i32, right: i32, bottom: i32) -> ScreenRect {
    ScreenRect {
        left: left.min(right),
        top: top.min(bottom),
        right: left.max(right),
        bottom: top.max(bottom),
    }
}

fn pointer_distance(x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    let dx = x1 - x2;
    let dy = y1 - y2;
    (dx * dx + dy * dy).sqrt()
}

fn should_trigger_auto_selection(event: &rdev::Event) -> bool {
    let Ok(mut guard) = mouse_selection_state().lock() else {
        return false;
    };

    match event.event_type {
        rdev::EventType::ButtonPress(rdev::Button::Left) => {
            guard.press_x = guard.cursor_x;
            guard.press_y = guard.cursor_y;
            guard.left_pressed = true;
            guard.moved = false;
            false
        }
        rdev::EventType::MouseMove { x, y } => {
            guard.cursor_x = x;
            guard.cursor_y = y;
            if !guard.left_pressed {
                return false;
            }

            if pointer_distance(guard.press_x, guard.press_y, x, y) >= MOUSE_DRAG_MIN_DISTANCE_PX {
                guard.moved = true;
            }
            false
        }
        rdev::EventType::ButtonRelease(rdev::Button::Left) => {
            let release_x = guard.cursor_x;
            let release_y = guard.cursor_y;

            let drag_distance =
                pointer_distance(guard.press_x, guard.press_y, release_x, release_y);
            let is_drag_selection =
                guard.left_pressed && (guard.moved || drag_distance >= MOUSE_DRAG_MIN_DISTANCE_PX);

            let now = Instant::now();
            let is_double_click = guard
                .last_release_at
                .map(|at| {
                    at.elapsed() <= Duration::from_millis(DOUBLE_CLICK_MAX_INTERVAL_MS)
                        && pointer_distance(
                            guard.last_release_x,
                            guard.last_release_y,
                            release_x,
                            release_y,
                        ) <= DOUBLE_CLICK_MAX_DISTANCE_PX
                })
                .unwrap_or(false);

            guard.left_pressed = false;
            guard.moved = false;
            guard.last_release_at = Some(now);
            guard.last_release_x = release_x;
            guard.last_release_y = release_y;

            is_drag_selection || is_double_click
        }
        _ => false,
    }
}

fn is_shift_key(key: rdev::Key) -> bool {
    matches!(key, rdev::Key::ShiftLeft | rdev::Key::ShiftRight)
}

fn is_modifier_trigger_key(key: rdev::Key) -> bool {
    is_shift_key(key) || is_alt_key(key)
}

fn on_modifier_hotkey_event(app: &AppHandle, event_type: &rdev::EventType) {
    match event_type {
        rdev::EventType::KeyPress(key) => {
            let Ok(mut guard) = modifier_hotkey_state().lock() else {
                return;
            };

            if is_modifier_trigger_key(*key) {
                if guard.shift_pressed_count == 0 && guard.alt_pressed_count == 0 {
                    guard.modifier_started_at = Some(Instant::now());
                    guard.blocked = false;
                }

                if is_shift_key(*key) {
                    guard.shift_pressed_count = guard.shift_pressed_count.saturating_add(1).min(2);
                } else {
                    guard.alt_pressed_count = guard.alt_pressed_count.saturating_add(1).min(2);
                }
                return;
            }

            if guard.shift_pressed_count > 0 || guard.alt_pressed_count > 0 {
                guard.blocked = true;
            }
        }
        rdev::EventType::KeyRelease(key) => {
            if !is_modifier_trigger_key(*key) {
                return;
            }

            let should_trigger = {
                let Ok(mut guard) = modifier_hotkey_state().lock() else {
                    return;
                };

                if guard.shift_pressed_count == 0 && guard.alt_pressed_count == 0 {
                    return;
                }

                if is_shift_key(*key) {
                    if guard.shift_pressed_count == 0 {
                        return;
                    }
                    guard.shift_pressed_count = guard.shift_pressed_count.saturating_sub(1);
                } else {
                    if guard.alt_pressed_count == 0 {
                        return;
                    }
                    guard.alt_pressed_count = guard.alt_pressed_count.saturating_sub(1);
                }

                if guard.shift_pressed_count > 0 || guard.alt_pressed_count > 0 {
                    return;
                }

                let quick_tap = guard
                    .modifier_started_at
                    .map(|started| {
                        started.elapsed() <= Duration::from_millis(SHIFT_TRIGGER_MAX_HOLD_MS)
                    })
                    .unwrap_or(false);
                let allowed = quick_tap && !guard.blocked;

                guard.modifier_started_at = None;
                guard.blocked = false;
                allowed
            };

            if should_trigger {
                let modifier = if is_shift_key(*key) {
                    hotkey::ModifierShortcut::Shift
                } else {
                    hotkey::ModifierShortcut::Alt
                };
                let app_for_task = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = hotkey::handle_modifier_shortcut(app_for_task, modifier).await;
                });
            }
        }
        _ => {}
    }
}

fn on_debug_copy_hotkey_event(app: &AppHandle, event_type: &rdev::EventType) {
    if !debug_trace::enabled() {
        return;
    }

    match event_type {
        rdev::EventType::KeyPress(rdev::Key::F8) => {
            let _ = app.emit("debug-copy-hotkey", "f8");
        }
        rdev::EventType::KeyPress(rdev::Key::F7) => {
            let _ = app.emit("debug-clear-hotkey", "f7");
        }
        _ => {}
    }
}

fn is_alt_key(key: rdev::Key) -> bool {
    matches!(key, rdev::Key::Alt | rdev::Key::AltGr)
}

fn is_ctrl_key(key: rdev::Key) -> bool {
    matches!(key, rdev::Key::ControlLeft | rdev::Key::ControlRight)
}

fn is_meta_key(key: rdev::Key) -> bool {
    matches!(key, rdev::Key::MetaLeft | rdev::Key::MetaRight)
}

fn is_horizontal_arrow(key: rdev::Key) -> bool {
    matches!(key, rdev::Key::LeftArrow | rdev::Key::RightArrow)
}

fn is_ctrl_enter_key(key: rdev::Key) -> bool {
    matches!(key, rdev::Key::Return | rdev::Key::KpReturn)
}

#[cfg(target_os = "windows")]
fn is_ctrl_pressed_now() -> bool {
    let left = unsafe { GetAsyncKeyState(VK_LCONTROL.0 as i32) };
    let right = unsafe { GetAsyncKeyState(VK_RCONTROL.0 as i32) };
    (left as u16 & 0x8000) != 0 || (right as u16 & 0x8000) != 0
}

#[cfg(not(target_os = "windows"))]
fn is_ctrl_pressed_now() -> bool {
    true
}

fn on_ctrl_enter_translate_event(app: &AppHandle, event_type: &rdev::EventType) -> bool {
    match event_type {
        rdev::EventType::KeyPress(key) if is_ctrl_enter_key(*key) => {
            let (ctrl_pressed, alt_pressed, meta_pressed, shift_pressed, plain_ctrl_enter) = {
                let Ok(mut guard) = navigation_hotkey_state().lock() else {
                    return false;
                };

                let ctrl_now = is_ctrl_pressed_now();
                if guard.ctrl_pressed != ctrl_now {
                    guard.ctrl_pressed = ctrl_now;
                    if !ctrl_now {
                        CTRL_ENTER_INTERCEPT_ACTIVE.store(false, Ordering::SeqCst);
                    }
                }

                let plain = guard.ctrl_pressed
                    && !guard.alt_pressed
                    && !guard.meta_pressed
                    && !guard.shift_pressed;
                (
                    guard.ctrl_pressed,
                    guard.alt_pressed,
                    guard.meta_pressed,
                    guard.shift_pressed,
                    plain,
                )
            };

            emit_hotkey_trace(
                app,
                "ctrl-enter-keypress",
                "Ctrl+Enter",
                format!(
                    "ctrl={ctrl_pressed} alt={alt_pressed} meta={meta_pressed} shift={shift_pressed} plain={plain_ctrl_enter} interceptActive={}",
                    CTRL_ENTER_INTERCEPT_ACTIVE.load(Ordering::SeqCst)
                ),
            );

            if !plain_ctrl_enter {
                return false;
            }
            if is_any_app_window_focused(app) {
                emit_hotkey_trace(
                    app,
                    "ctrl-enter-pass",
                    "Ctrl+Enter",
                    "reason=app-window-focused".to_owned(),
                );
                return false;
            }

            let state = app.state::<AppState>();
            let (should_intercept, ctrl_enter_send_enabled) = {
                let Ok(guard) = state.config.lock() else {
                    emit_hotkey_trace(
                        app,
                        "ctrl-enter-pass",
                        "Ctrl+Enter",
                        "reason=config-lock-failed".to_owned(),
                    );
                    return false;
                };
                (
                    hotkey::should_use_ctrl_enter_grab(&guard),
                    guard.hotkey_translate_ctrl_enter_send,
                )
            };

            emit_hotkey_trace(
                app,
                "ctrl-enter-config",
                "Ctrl+Enter",
                format!(
                    "shouldIntercept={should_intercept} ctrlEnterSendEnabled={ctrl_enter_send_enabled}"
                ),
            );

            if !should_intercept {
                emit_hotkey_trace(
                    app,
                    "ctrl-enter-pass",
                    "Ctrl+Enter",
                    "reason=setting-disabled".to_owned(),
                );
                return false;
            }

            if !CTRL_ENTER_INTERCEPT_ACTIVE.swap(true, Ordering::SeqCst) {
                emit_hotkey_trace(
                    app,
                    "ctrl-enter-block",
                    "Ctrl+Enter",
                    "blockedOriginalEnter=true dispatch=translate-replace".to_owned(),
                );
                let app_for_task = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = hotkey::handle_ctrl_enter_intercepted(app_for_task).await;
                });
            } else {
                emit_hotkey_trace(
                    app,
                    "ctrl-enter-block-repeat",
                    "Ctrl+Enter",
                    "blockedOriginalEnter=true while active request".to_owned(),
                );
            }

            true
        }
        rdev::EventType::KeyRelease(key) if is_ctrl_enter_key(*key) => {
            let was_active = CTRL_ENTER_INTERCEPT_ACTIVE.swap(false, Ordering::SeqCst);
            if was_active {
                emit_hotkey_trace(
                    app,
                    "ctrl-enter-release",
                    "Ctrl+Enter",
                    "interceptActive=false".to_owned(),
                );
            }
            was_active
        }
        _ => false,
    }
}

fn on_navigation_hotkey_event(app: &AppHandle, event_type: &rdev::EventType) {
    let mut should_hide_popover = false;

    match event_type {
        rdev::EventType::KeyPress(key) => {
            let Ok(mut guard) = navigation_hotkey_state().lock() else {
                return;
            };

            if is_alt_key(*key) {
                guard.alt_pressed = true;
            }
            if is_ctrl_key(*key) {
                guard.ctrl_pressed = true;
            }
            if is_shift_key(*key) {
                guard.shift_pressed = true;
            }
            if is_meta_key(*key) {
                guard.meta_pressed = true;
                should_hide_popover = true;
            }

            if *key == rdev::Key::Tab && guard.alt_pressed {
                should_hide_popover = true;
            }

            if is_horizontal_arrow(*key) && guard.ctrl_pressed && guard.meta_pressed {
                should_hide_popover = true;
            }
        }
        rdev::EventType::KeyRelease(key) => {
            let Ok(mut guard) = navigation_hotkey_state().lock() else {
                return;
            };

            if is_alt_key(*key) {
                guard.alt_pressed = false;
            }
            if is_ctrl_key(*key) {
                guard.ctrl_pressed = false;
            }
            if is_shift_key(*key) {
                guard.shift_pressed = false;
            }
            if is_meta_key(*key) {
                guard.meta_pressed = false;
            }

            if !guard.ctrl_pressed {
                CTRL_ENTER_INTERCEPT_ACTIVE.store(false, Ordering::SeqCst);
            }
        }
        _ => {}
    }

    if should_hide_popover {
        let _ = force_close_popover(app, "navigation-hotkey");
        let _ = force_close_quick_convert(app, "navigation-hotkey");
    }
}

fn check_global_outside_click(app: &AppHandle, event_type: &rdev::EventType) {
    if matches!(event_type, rdev::EventType::ButtonPress(_)) {
        let (cursor_x, cursor_y) = {
            let Ok(guard) = mouse_selection_state().lock() else {
                return;
            };
            (guard.cursor_x, guard.cursor_y)
        };

        if let Some(popover) = app.get_webview_window("popover") {
            if popover.is_visible().unwrap_or(false) {
                if let (Ok(pos), Ok(size)) = (popover.outer_position(), popover.outer_size()) {
                    let left = pos.x as f64 - 4.0;
                    let top = pos.y as f64 - 4.0;
                    let right = pos.x as f64 + size.width as f64 + 4.0;
                    let bottom = pos.y as f64 + size.height as f64 + 4.0;

                    if cursor_x < left || cursor_x > right || cursor_y < top || cursor_y > bottom {
                        let _ = force_close_popover(app, "global-outside-click");
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ScreenRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionAnchor {
    pub point: Option<ScreenPoint>,
    pub rect: Option<ScreenRect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionEvent {
    pub event_id: u64,
    pub text: String,
    pub trigger: String,
    pub anchor: Option<SelectionAnchor>,
}

pub fn take_pending_selection() -> Result<Option<SelectionEvent>, String> {
    let mut guard = pending_selection_event()
        .lock()
        .map_err(|_| "pending selection lock poisoned".to_owned())?;
    Ok(guard.take())
}

fn set_pending_selection(event: SelectionEvent) -> Result<(), String> {
    let mut guard = pending_selection_event()
        .lock()
        .map_err(|_| "pending selection lock poisoned".to_owned())?;
    *guard = Some(event);
    Ok(())
}

fn build_selection_anchor(cursor: Option<(i32, i32)>) -> Option<SelectionAnchor> {
    let point = if let Some((x, y)) = cursor {
        ScreenPoint { x, y }
    } else if let Some((x, y)) = automation::cursor_position() {
        ScreenPoint { x, y }
    } else {
        let Ok(guard) = mouse_selection_state().lock() else {
            return None;
        };
        if guard.last_release_at.is_none()
            && guard.cursor_x.abs() < f64::EPSILON
            && guard.cursor_y.abs() < f64::EPSILON
        {
            return None;
        }
        ScreenPoint {
            x: to_i32_coord(guard.cursor_x),
            y: to_i32_coord(guard.cursor_y),
        }
    };
    let rect = make_rect(
        point.x - POINT_ANCHOR_HALF_WIDTH,
        point.y - POINT_ANCHOR_HALF_HEIGHT,
        point.x + POINT_ANCHOR_HALF_WIDTH,
        point.y + POINT_ANCHOR_HALF_HEIGHT,
    );
    Some(SelectionAnchor {
        point: Some(point),
        rect: Some(rect),
    })
}

pub fn start_selection_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let app_for_listener = app.clone();
        let callback = move |event: rdev::Event| {
            on_modifier_hotkey_event(&app_for_listener, &event.event_type);
            on_debug_copy_hotkey_event(&app_for_listener, &event.event_type);
            on_navigation_hotkey_event(&app_for_listener, &event.event_type);
            check_global_outside_click(&app_for_listener, &event.event_type);

            let should_block = on_ctrl_enter_translate_event(&app_for_listener, &event.event_type);

            if should_trigger_auto_selection(&event) {
                let app_for_task = app_for_listener.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = on_auto_selection(app_for_task).await;
                });
            }
            if should_block {
                None
            } else {
                Some(event)
            }
        };

        if let Err(err) = rdev::grab(callback) {
            eprintln!("selection listener error: {err:?}");
        }
    });
}

pub fn install_popover_window_guards(app: &AppHandle) {
    let Some(popover) = app.get_webview_window("popover") else {
        return;
    };

    let app_handle = app.clone();
    popover.on_window_event(move |event| {
        let should_hide = matches!(event, WindowEvent::Focused(false));
        if should_hide {
            let _ = force_close_popover(&app_handle, "window-focused-false");
        }
    });

    if let Some(quick_convert) = app.get_webview_window("quick-convert") {
        let app_handle = app.clone();
        quick_convert.on_window_event(move |event| {
            let should_hide = matches!(event, WindowEvent::Focused(false));
            if should_hide {
                let _ = force_close_quick_convert(&app_handle, "window-focused-false");
            }
        });
    }

    #[cfg(target_os = "windows")]
    {
        install_windows_desktop_switch_guard(app);
    }
}

const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;

#[cfg(target_os = "windows")]
unsafe extern "system" fn on_windows_desktop_switch(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: windows::Win32::Foundation::HWND,
    _id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if event == EVENT_SYSTEM_FOREGROUND {
        if let Some(app) = DESKTOP_SWITCH_APP.get() {
            let mut is_our_window = false;
            for label in [
                "main",
                "popover",
                "hotkey-indicator",
                "ocr-overlay",
                "quick-convert",
                "debug-log",
            ]
            .iter()
            {
                if let Some(w) = app.get_webview_window(*label) {
                    if let Ok(w_hwnd) = w.hwnd() {
                        if w_hwnd.0 == hwnd.0 {
                            is_our_window = true;
                            break;
                        }
                    }
                }
            }

            if !is_our_window {
                let _ = force_close_popover(app, "windows-desktop-switch-fg");
                let _ = force_close_quick_convert(app, "windows-desktop-switch-fg");
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn install_windows_desktop_switch_guard(app: &AppHandle) {
    if DESKTOP_SWITCH_HOOK_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let _ = DESKTOP_SWITCH_APP.set(app.clone());

    std::thread::spawn(|| unsafe {
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(on_windows_desktop_switch),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );

        if hook.0.is_null() {
            DESKTOP_SWITCH_HOOK_STARTED.store(false, Ordering::SeqCst);
            return;
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).into() {}

        let _ = UnhookWinEvent(hook);
        DESKTOP_SWITCH_HOOK_STARTED.store(false, Ordering::SeqCst);
    });
}

pub(crate) fn is_any_app_window_focused(app: &AppHandle) -> bool {
    if let Some(main) = app.get_webview_window("main") {
        if main.is_focused().unwrap_or(false) {
            return true;
        }
    }
    if let Some(popover) = app.get_webview_window("popover") {
        if popover.is_focused().unwrap_or(false) {
            return true;
        }
    }
    if let Some(indicator) = app.get_webview_window("hotkey-indicator") {
        if indicator.is_focused().unwrap_or(false) {
            return true;
        }
    }
    if let Some(ocr_overlay) = app.get_webview_window("ocr-overlay") {
        if ocr_overlay.is_focused().unwrap_or(false) {
            return true;
        }
    }
    if let Some(debug) = app.get_webview_window("debug-log") {
        if debug.is_focused().unwrap_or(false) {
            return true;
        }
    }
    if let Some(quick_convert) = app.get_webview_window("quick-convert") {
        if quick_convert.is_focused().unwrap_or(false) {
            return true;
        }
    }
    false
}

async fn on_auto_selection(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let config = {
        let guard = state
            .config
            .lock()
            .map_err(|_| "config lock poisoned".to_owned())?;
        guard.clone()
    };
    if config.popover_trigger_mode != "auto" {
        return Ok(());
    }

    if is_any_app_window_focused(&app) {
        return Ok(());
    }

    // Snapshot cursor as early as possible to avoid drift while selection text is captured.
    let cursor = tauri::async_runtime::spawn_blocking(automation::cursor_position)
        .await
        .map_err(|err| format!("capture cursor task failed: {err}"))?;

    let raw_text = tauri::async_runtime::spawn_blocking(automation::capture_selection_text)
        .await
        .map_err(|err| format!("capture selection task failed: {err}"))??;
    let selected = raw_text.replace('\r', "").trim().to_owned();
    if selected.is_empty() {
        let _ = hide_popover_window(&app);
        return Ok(());
    }

    {
        let mut guard = auto_selection_state()
            .lock()
            .map_err(|_| "auto selection state lock poisoned".to_owned())?;
        let repeated =
            guard.last_text == selected && guard.last_emit.elapsed() < Duration::from_millis(850);
        if repeated {
            return Ok(());
        }
        guard.last_text = selected.clone();
        guard.last_emit = Instant::now();
    }

    show_popover_window(&app, selected, "auto".to_owned(), cursor)
}

pub fn show_popover_window(
    app: &AppHandle,
    text: String,
    trigger: String,
    cursor: Option<(i32, i32)>,
) -> Result<(), String> {
    if let Ok(mut guard) = ocr_popover_opened_at().lock() {
        if trigger == "ocr" {
            *guard = Some(Instant::now());
        } else {
            *guard = None;
        }
    }

    let anchor = build_selection_anchor(cursor);
    let event_id = next_selection_event_id();

    set_pending_selection(SelectionEvent {
        event_id,
        text: text.clone(),
        trigger: trigger.clone(),
        anchor: anchor.clone(),
    })?;

    let popover = app
        .get_webview_window("popover")
        .ok_or_else(|| "popover window not found".to_owned())?;

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let _ = popover.set_visible_on_all_workspaces(false);
    }

    popover
        .set_size(LogicalSize::new(POPOVER_BASE_WIDTH, POPOVER_BASE_HEIGHT))
        .map_err(|err| format!("set popover base size failed: {err}"))?;

    let positioned = resolve_popover_position(app, &popover, anchor.as_ref());
    popover
        .set_position(Position::Physical(positioned))
        .map_err(|err| format!("set popover position failed: {err}"))?;

    popover
        .show()
        .map_err(|err| format!("show popover window failed: {err}"))?;
    let reanchored = resolve_popover_position(app, &popover, anchor.as_ref());
    popover
        .set_position(Position::Physical(reanchored))
        .map_err(|err| format!("re-anchor popover position failed: {err}"))?;
    std::thread::sleep(Duration::from_millis(40));
    emit_selection_changed(app, event_id, text, trigger, anchor)
}

fn resolve_anchor_rect(anchor: Option<&SelectionAnchor>) -> Option<ScreenRect> {
    anchor.and_then(|entry| {
        entry.rect.or_else(|| {
            entry.point.as_ref().map(|point| {
                make_rect(
                    point.x - POINT_ANCHOR_HALF_WIDTH,
                    point.y - POINT_ANCHOR_HALF_HEIGHT,
                    point.x + POINT_ANCHOR_HALF_WIDTH,
                    point.y + POINT_ANCHOR_HALF_HEIGHT,
                )
            })
        })
    })
}

fn resolve_anchor_point(anchor: Option<&SelectionAnchor>) -> Option<ScreenPoint> {
    anchor.and_then(|entry| {
        if let Some(point) = &entry.point {
            return Some(point.clone());
        }

        entry.rect.map(|rect| ScreenPoint {
            x: (rect.left + rect.right) / 2,
            y: (rect.top + rect.bottom) / 2,
        })
    })
}

fn clamp_rect_to_monitor(
    rect: ScreenRect,
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
) -> ScreenRect {
    make_rect(
        rect.left.clamp(min_x, max_x),
        rect.top.clamp(min_y, max_y),
        rect.right.clamp(min_x, max_x),
        rect.bottom.clamp(min_y, max_y),
    )
}

fn overlap_area(left: i32, top: i32, width: i32, height: i32, avoid: ScreenRect) -> i64 {
    let right = left + width;
    let bottom = top + height;
    let overlap_w = (right.min(avoid.right) - left.max(avoid.left)).max(0);
    let overlap_h = (bottom.min(avoid.bottom) - top.max(avoid.top)).max(0);
    i64::from(overlap_w) * i64::from(overlap_h)
}

fn edge_distance(left: i32, top: i32, width: i32, height: i32, anchor: ScreenRect) -> i64 {
    let right = left + width;
    let bottom = top + height;

    let dx = if right < anchor.left {
        anchor.left - right
    } else if anchor.right < left {
        left - anchor.right
    } else {
        0
    };

    let dy = if bottom < anchor.top {
        anchor.top - bottom
    } else if anchor.bottom < top {
        top - anchor.bottom
    } else {
        0
    };

    i64::from(dx + dy)
}

fn overflow_total(left: i32, top: i32, min_x: i32, min_y: i32, max_x: i32, max_y: i32) -> i64 {
    let overflow_left = (min_x - left).max(0);
    let overflow_top = (min_y - top).max(0);
    let overflow_right = (left - max_x).max(0);
    let overflow_bottom = (top - max_y).max(0);
    i64::from(overflow_left + overflow_top + overflow_right + overflow_bottom)
}

fn anchor_center(anchor_rect: ScreenRect) -> (i32, i32) {
    (
        (anchor_rect.left + anchor_rect.right) / 2,
        (anchor_rect.top + anchor_rect.bottom) / 2,
    )
}

fn center_distance_to_point(
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    point_x: i32,
    point_y: i32,
) -> i64 {
    let center_x = left + width / 2;
    let center_y = top + height / 2;
    i64::from((center_x - point_x).abs() + (center_y - point_y).abs())
}

fn compute_cursor_above_gap(cursor_y: i32, monitor_top: i32, monitor_bottom: i32) -> i32 {
    let monitor_height = (monitor_bottom - monitor_top).max(1);
    let near_bottom_zone =
        ((monitor_height as f32) * CURSOR_ABOVE_NEAR_BOTTOM_RATIO).round() as i32;
    let distance_to_bottom = (monitor_bottom - cursor_y).max(0);

    if distance_to_bottom >= near_bottom_zone || near_bottom_zone <= 0 {
        return CURSOR_GAP;
    }

    let pressure = near_bottom_zone - distance_to_bottom;
    let extra = ((pressure * CURSOR_ABOVE_EXTRA_GAP_MAX) / near_bottom_zone)
        .clamp(0, CURSOR_ABOVE_EXTRA_GAP_MAX);
    CURSOR_GAP + extra
}

fn resolve_popover_position(
    app: &AppHandle,
    popover: &tauri::WebviewWindow,
    anchor: Option<&SelectionAnchor>,
) -> PhysicalPosition<i32> {
    let Ok(window_size) = popover.outer_size() else {
        return PhysicalPosition::new(18, 18);
    };

    let width = i32::try_from(window_size.width).unwrap_or(POPOVER_BASE_WIDTH as i32);
    let height = i32::try_from(window_size.height).unwrap_or(POPOVER_BASE_HEIGHT as i32);

    let anchor_point = resolve_anchor_point(anchor);
    let anchor_hint = resolve_anchor_rect(anchor).or_else(|| {
        anchor_point.as_ref().map(|point| {
            make_rect(
                point.x - POINT_ANCHOR_HALF_WIDTH,
                point.y - POINT_ANCHOR_HALF_HEIGHT,
                point.x + POINT_ANCHOR_HALF_WIDTH,
                point.y + POINT_ANCHOR_HALF_HEIGHT,
            )
        })
    });

    let monitor_from_anchor = anchor_point.as_ref().and_then(|point| {
        popover.available_monitors().ok().and_then(|monitors| {
            let mut containing = None;
            let mut nearest = None;
            let mut nearest_distance = i64::MAX;

            for monitor in monitors {
                let pos = monitor.position();
                let size = monitor.size();
                let left = pos.x;
                let top = pos.y;
                let right = left + i32::try_from(size.width).unwrap_or(i32::MAX);
                let bottom = top + i32::try_from(size.height).unwrap_or(i32::MAX);

                if point.x >= left && point.x <= right && point.y >= top && point.y <= bottom {
                    containing = Some(monitor);
                    break;
                }

                let monitor_cx = left + (right - left) / 2;
                let monitor_cy = top + (bottom - top) / 2;
                let distance =
                    i64::from((point.x - monitor_cx).abs() + (point.y - monitor_cy).abs());
                if distance < nearest_distance {
                    nearest_distance = distance;
                    nearest = Some(monitor);
                }
            }

            containing.or(nearest)
        })
    });

    let monitor = monitor_from_anchor
        .or_else(|| popover.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return PhysicalPosition::new(18, 18);
    };

    let margin = 8;
    let gap = 2;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();

    let monitor_left = monitor_position.x;
    let monitor_top = monitor_position.y;
    let monitor_right = monitor_left + i32::try_from(monitor_size.width).unwrap_or(i32::MAX);
    let monitor_bottom = monitor_top + i32::try_from(monitor_size.height).unwrap_or(i32::MAX);

    let min_x = monitor_left + margin;
    let min_y = monitor_top + margin;
    let max_x = (monitor_right - width - margin).max(min_x);
    let max_y = (monitor_bottom - height - margin).max(min_y);

    let raw_anchor = anchor_hint.unwrap_or_else(|| {
        make_rect(
            monitor_left + margin,
            monitor_top + margin,
            monitor_left + margin + POINT_ANCHOR_HALF_WIDTH * 2,
            monitor_top + margin + POINT_ANCHOR_HALF_HEIGHT * 2,
        )
    });
    let anchor_rect = clamp_rect_to_monitor(
        raw_anchor,
        min_x,
        min_y,
        monitor_right - margin,
        monitor_bottom - margin,
    );
    let (anchor_cx, anchor_cy) = anchor_center(anchor_rect);
    let cursor_x = anchor_point.as_ref().map_or(anchor_cx, |point| point.x);
    let cursor_y = anchor_point.as_ref().map_or(anchor_cy, |point| point.y);
    let cursor_gap_below = CURSOR_GAP;
    let cursor_gap_above = compute_cursor_above_gap(cursor_y, monitor_top, monitor_bottom);

    let candidates = [
        (cursor_x + cursor_gap_below, cursor_y + cursor_gap_below),
        (
            cursor_x + cursor_gap_below,
            cursor_y - height - cursor_gap_above,
        ),
        (
            cursor_x - width - cursor_gap_below,
            cursor_y + cursor_gap_below,
        ),
        (
            cursor_x - width - cursor_gap_below,
            cursor_y - height - cursor_gap_above,
        ),
        (cursor_x + cursor_gap_below, cursor_y - height / 2),
        (cursor_x - width - cursor_gap_below, cursor_y - height / 2),
        (cursor_x - width / 2, cursor_y + cursor_gap_below),
        (cursor_x - width / 2, cursor_y - height - cursor_gap_above),
        (anchor_rect.right + gap, anchor_cy - height / 2),
        (anchor_rect.left - width - gap, anchor_cy - height / 2),
        (anchor_cx - width / 2, anchor_rect.bottom + gap),
        (anchor_cx - width / 2, anchor_rect.top - height - gap),
    ];

    let mut best_left = min_x;
    let mut best_top = min_y;
    let mut best_score = i64::MAX;

    for (candidate_left, candidate_top) in candidates {
        let clamped_left = candidate_left.clamp(min_x, max_x);
        let clamped_top = candidate_top.clamp(min_y, max_y);
        let overlap = overlap_area(clamped_left, clamped_top, width, height, anchor_rect);
        let overflow = overflow_total(candidate_left, candidate_top, min_x, min_y, max_x, max_y);
        let near_anchor = edge_distance(clamped_left, clamped_top, width, height, anchor_rect);
        let near_cursor =
            center_distance_to_point(clamped_left, clamped_top, width, height, cursor_x, cursor_y);
        let score = overflow * 1_000_000 + overlap * 100_000 + near_cursor * 100 + near_anchor;

        if score < best_score {
            best_score = score;
            best_left = clamped_left;
            best_top = clamped_top;
        }
    }

    // Keep a clear cursor gap even if scoring picks a candidate too close.
    let cursor_hit_gap = if best_top + height <= cursor_y {
        cursor_gap_above
    } else if best_top >= cursor_y {
        cursor_gap_below
    } else {
        cursor_gap_above.max(cursor_gap_below)
    };
    let cursor_hits_x =
        cursor_x >= best_left - cursor_hit_gap && cursor_x <= best_left + width + cursor_hit_gap;
    let cursor_hits_y =
        cursor_y >= best_top - cursor_hit_gap && cursor_y <= best_top + height + cursor_hit_gap;
    if cursor_hits_x && cursor_hits_y {
        let preferred_above = cursor_y - height - cursor_gap_above;
        let preferred_below = cursor_y + cursor_gap_below;
        let can_place_above = preferred_above >= min_y;
        let can_place_below = preferred_below <= max_y;

        let target_top = if can_place_above && can_place_below {
            let above_delta = (best_top - preferred_above).abs();
            let below_delta = (best_top - preferred_below).abs();
            if above_delta <= below_delta {
                preferred_above
            } else {
                preferred_below
            }
        } else if can_place_above {
            preferred_above
        } else {
            preferred_below
        };

        best_top = target_top.clamp(min_y, max_y);
    }

    PhysicalPosition::new(best_left, best_top)
}

pub fn reanchor_popover_window(
    app: &AppHandle,
    anchor: Option<&SelectionAnchor>,
) -> Result<(), String> {
    let popover = app
        .get_webview_window("popover")
        .ok_or_else(|| "popover window not found".to_owned())?;

    if !popover.is_visible().unwrap_or(false) {
        return Ok(());
    }

    let target = resolve_popover_position(app, &popover, anchor);
    popover
        .set_position(Position::Physical(target))
        .map_err(|err| format!("re-anchor popover failed: {err}"))?;
    Ok(())
}

pub fn hide_popover_window(app: &AppHandle) -> Result<(), String> {
    if let Some(popover) = app.get_webview_window("popover") {
        popover
            .hide()
            .map_err(|err| format!("hide popover window failed: {err}"))?;
    }
    Ok(())
}

fn force_close_popover(app: &AppHandle, reason: &str) -> Result<(), String> {
    let is_transient_reason =
        reason == "window-focused-false" || reason == "windows-desktop-switch-fg";
    if is_transient_reason {
        let should_skip = ocr_popover_opened_at()
            .lock()
            .ok()
            .and_then(|guard| *guard)
            .map(|opened| opened.elapsed() <= Duration::from_millis(OCR_TRANSIENT_CLOSE_GUARD_MS))
            .unwrap_or(false);

        if should_skip {
            emit_hotkey_trace(
                app,
                "popover-force-close-skip",
                "popover",
                format!("reason={reason}"),
            );
            return Ok(());
        }
    }

    let _ = app.emit("force-close-popover", reason.to_owned());
    hide_popover_window(app)
}

fn force_close_quick_convert(app: &AppHandle, reason: &str) -> Result<(), String> {
    let _ = app.emit("force-close-quick-convert", reason.to_owned());
    if let Some(window) = app.get_webview_window("quick-convert") {
        window
            .hide()
            .map_err(|err| format!("hide quick convert window failed: {err}"))?;
    }
    let _ = automation::restore_previous_keyboard_layout();
    Ok(())
}

pub fn emit_selection_changed(
    app: &AppHandle,
    event_id: u64,
    text: String,
    trigger: String,
    anchor: Option<SelectionAnchor>,
) -> Result<(), String> {
    let payload = SelectionEvent {
        event_id,
        text,
        trigger,
        anchor,
    };
    app.emit("selection-changed", payload)
        .map_err(|err| format!("emit selection event failed: {err}"))
}

#[allow(dead_code)]
pub fn reposition_popover_in_monitor(
    app: &AppHandle,
    popover: &tauri::WebviewWindow,
) -> Result<(), String> {
    let Ok(current_pos) = popover.outer_position() else {
        return Ok(());
    };
    let Ok(window_size) = popover.outer_size() else {
        return Ok(());
    };

    let monitor = popover
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return Ok(());
    };

    let margin = 4;
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let mon_right = mon_pos.x + i32::try_from(mon_size.width).unwrap_or(i32::MAX);
    let mon_bottom = mon_pos.y + i32::try_from(mon_size.height).unwrap_or(i32::MAX);
    let win_w = i32::try_from(window_size.width).unwrap_or(POPOVER_BASE_WIDTH as i32);
    let win_h = i32::try_from(window_size.height).unwrap_or(POPOVER_BASE_HEIGHT as i32);

    let mut x = current_pos.x;
    let mut y = current_pos.y;

    if x + win_w + margin > mon_right {
        x = (mon_right - win_w - margin).max(mon_pos.x + margin);
    }
    if y + win_h + margin > mon_bottom {
        y = (mon_bottom - win_h - margin).max(mon_pos.y + margin);
    }

    if x != current_pos.x || y != current_pos.y {
        popover
            .set_position(Position::Physical(PhysicalPosition::new(x, y)))
            .map_err(|err| format!("reposition popover failed: {err}"))?;
    }
    Ok(())
}

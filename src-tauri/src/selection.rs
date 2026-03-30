use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position};

use crate::automation;
use crate::bridge::AppState;
use crate::hotkey;

struct AutoSelectionState {
    last_text: String,
    last_emit: Instant,
}

struct ModifierHotkeyState {
    shift_pressed_count: u8,
    shift_started_at: Option<Instant>,
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
    last_selection_rect: Option<ScreenRect>,
    last_selection_at: Option<Instant>,
}

static AUTO_SELECTION_STATE: OnceLock<Mutex<AutoSelectionState>> = OnceLock::new();
static PENDING_SELECTION_EVENT: OnceLock<Mutex<Option<SelectionEvent>>> = OnceLock::new();
static MODIFIER_HOTKEY_STATE: OnceLock<Mutex<ModifierHotkeyState>> = OnceLock::new();
static MOUSE_SELECTION_STATE: OnceLock<Mutex<MouseSelectionState>> = OnceLock::new();

const SHIFT_TRIGGER_MAX_HOLD_MS: u64 = 700;
const MOUSE_DRAG_MIN_DISTANCE_PX: f64 = 6.0;
const DOUBLE_CLICK_MAX_DISTANCE_PX: f64 = 14.0;
const DOUBLE_CLICK_MAX_INTERVAL_MS: u64 = 360;
const SELECTION_RECT_STALE_MS: u64 = 1400;
const POINT_ANCHOR_HALF_WIDTH: i32 = 16;
const POINT_ANCHOR_HALF_HEIGHT: i32 = 14;
const POPOVER_BASE_WIDTH: f64 = 360.0;
const POPOVER_BASE_HEIGHT: f64 = 300.0;

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
            shift_started_at: None,
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
            last_selection_rect: None,
            last_selection_at: None,
        })
    })
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

            let selection_rect = if is_drag_selection {
                Some(make_rect(
                    to_i32_coord(guard.press_x),
                    to_i32_coord(guard.press_y),
                    to_i32_coord(release_x),
                    to_i32_coord(release_y),
                ))
            } else if is_double_click {
                let cx = to_i32_coord(release_x);
                let cy = to_i32_coord(release_y);
                Some(make_rect(
                    cx - POINT_ANCHOR_HALF_WIDTH,
                    cy - POINT_ANCHOR_HALF_HEIGHT,
                    cx + POINT_ANCHOR_HALF_WIDTH,
                    cy + POINT_ANCHOR_HALF_HEIGHT,
                ))
            } else {
                None
            };

            guard.left_pressed = false;
            guard.moved = false;
            guard.last_release_at = Some(now);
            guard.last_release_x = release_x;
            guard.last_release_y = release_y;
            guard.last_selection_rect = selection_rect;
            guard.last_selection_at = guard.last_selection_rect.map(|_| now);

            is_drag_selection || is_double_click
        }
        _ => false,
    }
}

fn is_shift_key(key: rdev::Key) -> bool {
    matches!(key, rdev::Key::ShiftLeft | rdev::Key::ShiftRight)
}

fn on_modifier_hotkey_event(app: &AppHandle, event_type: &rdev::EventType) {
    match event_type {
        rdev::EventType::KeyPress(key) => {
            let Ok(mut guard) = modifier_hotkey_state().lock() else {
                return;
            };

            if is_shift_key(*key) {
                if guard.shift_pressed_count == 0 {
                    guard.shift_started_at = Some(Instant::now());
                    guard.blocked = false;
                }
                guard.shift_pressed_count = guard.shift_pressed_count.saturating_add(1).min(2);
                return;
            }

            if guard.shift_pressed_count > 0 {
                guard.blocked = true;
            }
        }
        rdev::EventType::KeyRelease(key) => {
            if !is_shift_key(*key) {
                return;
            }

            let should_trigger = {
                let Ok(mut guard) = modifier_hotkey_state().lock() else {
                    return;
                };

                if guard.shift_pressed_count == 0 {
                    return;
                }

                guard.shift_pressed_count = guard.shift_pressed_count.saturating_sub(1);
                if guard.shift_pressed_count > 0 {
                    return;
                }

                let quick_tap = guard
                    .shift_started_at
                    .map(|started| {
                        started.elapsed() <= Duration::from_millis(SHIFT_TRIGGER_MAX_HOLD_MS)
                    })
                    .unwrap_or(false);
                let allowed = quick_tap && !guard.blocked;

                guard.shift_started_at = None;
                guard.blocked = false;
                allowed
            };

            if should_trigger {
                let app_for_task = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = hotkey::handle_modifier_shortcut(app_for_task).await;
                });
            }
        }
        _ => {}
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

fn resolve_selection_rect() -> Option<ScreenRect> {
    let Ok(guard) = mouse_selection_state().lock() else {
        return None;
    };

    let Some(at) = guard.last_selection_at else {
        return None;
    };

    if at.elapsed() > Duration::from_millis(SELECTION_RECT_STALE_MS) {
        return None;
    }

    guard.last_selection_rect
}

fn build_selection_anchor(cursor: Option<(i32, i32)>) -> Option<SelectionAnchor> {
    let point = cursor.map(|(x, y)| ScreenPoint { x, y });
    let rect = resolve_selection_rect().or_else(|| {
        point.as_ref().map(|p| {
            make_rect(
                p.x - POINT_ANCHOR_HALF_WIDTH,
                p.y - POINT_ANCHOR_HALF_HEIGHT,
                p.x + POINT_ANCHOR_HALF_WIDTH,
                p.y + POINT_ANCHOR_HALF_HEIGHT,
            )
        })
    });

    if point.is_none() && rect.is_none() {
        return None;
    }

    Some(SelectionAnchor { point, rect })
}

pub fn start_selection_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let app_for_listener = app.clone();
        let callback = move |event: rdev::Event| {
            on_modifier_hotkey_event(&app_for_listener, &event.event_type);

            if should_trigger_auto_selection(&event) {
                let app_for_task = app_for_listener.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = on_auto_selection(app_for_task).await;
                });
            }
        };

        if let Err(err) = rdev::listen(callback) {
            eprintln!("selection listener error: {err:?}");
        }
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

    let cursor = tauri::async_runtime::spawn_blocking(automation::cursor_position)
        .await
        .map_err(|err| format!("capture cursor task failed: {err}"))?;

    show_popover_window(&app, selected, "auto".to_owned(), cursor)
}

pub fn show_popover_window(
    app: &AppHandle,
    text: String,
    trigger: String,
    cursor: Option<(i32, i32)>,
) -> Result<(), String> {
    let anchor = build_selection_anchor(cursor);

    set_pending_selection(SelectionEvent {
        text: text.clone(),
        trigger: trigger.clone(),
        anchor: anchor.clone(),
    })?;

    let popover = app
        .get_webview_window("popover")
        .ok_or_else(|| "popover window not found".to_owned())?;

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
    std::thread::sleep(Duration::from_millis(40));
    emit_selection_changed(app, text, trigger, anchor)
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

    let monitor = popover
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return PhysicalPosition::new(18, 18);
    };

    let margin = 12;
    let gap = 4;
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

    let raw_anchor = resolve_anchor_rect(anchor).unwrap_or_else(|| {
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

    let candidates = [
        (anchor_rect.right + gap, anchor_rect.top),
        (anchor_rect.right + gap, anchor_cy - height / 2),
        (anchor_rect.left - width - gap, anchor_rect.top),
        (anchor_rect.left - width - gap, anchor_cy - height / 2),
        (anchor_rect.left, anchor_rect.bottom + gap),
        (anchor_cx - width / 2, anchor_rect.bottom + gap),
        (anchor_rect.left, anchor_rect.top - height - gap),
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
        let center_x = clamped_left + width / 2;
        let center_y = clamped_top + height / 2;
        let distance = i64::from((center_x - anchor_cx).abs() + (center_y - anchor_cy).abs());
        let score = overlap * 1000 + overflow * 10000 + distance;

        if score < best_score {
            best_score = score;
            best_left = clamped_left;
            best_top = clamped_top;
        }
    }

    PhysicalPosition::new(best_left, best_top)
}

pub fn hide_popover_window(app: &AppHandle) -> Result<(), String> {
    if let Some(popover) = app.get_webview_window("popover") {
        popover
            .hide()
            .map_err(|err| format!("hide popover window failed: {err}"))?;
    }
    Ok(())
}

pub fn emit_selection_changed(
    app: &AppHandle,
    text: String,
    trigger: String,
    anchor: Option<SelectionAnchor>,
) -> Result<(), String> {
    let payload = SelectionEvent {
        text,
        trigger,
        anchor,
    };
    app.emit("selection-changed", payload)
        .map_err(|err| format!("emit selection event failed: {err}"))
}

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

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Position};

use crate::automation;
use crate::bridge::AppState;

struct AutoSelectionState {
    last_text: String,
    last_emit: Instant,
}

static AUTO_SELECTION_STATE: OnceLock<Mutex<AutoSelectionState>> = OnceLock::new();
static PENDING_SELECTION_EVENT: OnceLock<Mutex<Option<SelectionEvent>>> = OnceLock::new();

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionEvent {
    pub text: String,
    pub trigger: String,
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

pub fn start_selection_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let app_for_listener = app.clone();
        let callback = move |event: rdev::Event| {
            if let rdev::EventType::ButtonRelease(rdev::Button::Left) = event.event_type {
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

    let raw_text = tauri::async_runtime::spawn_blocking(automation::capture_selection_text)
        .await
        .map_err(|err| format!("capture selection task failed: {err}"))??;
    let selected = raw_text.replace('\r', "").trim().to_owned();
    if selected.is_empty() {
        return Ok(());
    }

    {
        let mut guard = auto_selection_state()
            .lock()
            .map_err(|_| "auto selection state lock poisoned".to_owned())?;
        let repeated = guard.last_text == selected && guard.last_emit.elapsed() < Duration::from_millis(850);
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
    set_pending_selection(SelectionEvent {
        text: text.clone(),
        trigger: trigger.clone(),
    })?;

    let popover = app
        .get_webview_window("popover")
        .ok_or_else(|| "popover window not found".to_owned())?;

    if let Some((x, y)) = cursor {
        let positioned = resolve_popover_position(app, &popover, x, y);
        popover
            .set_position(Position::Physical(positioned))
            .map_err(|err| format!("set popover position failed: {err}"))?;
    }

    popover
        .show()
        .map_err(|err| format!("show popover window failed: {err}"))?;
    std::thread::sleep(Duration::from_millis(40));
    emit_selection_changed(app, text, trigger)
}

fn resolve_popover_position(
    app: &AppHandle,
    popover: &tauri::WebviewWindow,
    cursor_x: i32,
    cursor_y: i32,
) -> PhysicalPosition<i32> {
    let mut left = cursor_x.max(0) + 18;
    let mut top = cursor_y.max(0) + 18;

    let Ok(window_size) = popover.outer_size() else {
        return PhysicalPosition::new(left, top);
    };

    let width = i32::try_from(window_size.width).unwrap_or(460);
    let height = i32::try_from(window_size.height).unwrap_or(320);

    let monitor = popover
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return PhysicalPosition::new(left, top);
    };

    let margin = 12;
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

    left = left.clamp(min_x, max_x);
    top = top.clamp(min_y, max_y);

    PhysicalPosition::new(left, top)
}

pub fn hide_popover_window(app: &AppHandle) -> Result<(), String> {
    if let Some(popover) = app.get_webview_window("popover") {
        popover
            .hide()
            .map_err(|err| format!("hide popover window failed: {err}"))?;
    }
    Ok(())
}

pub fn emit_selection_changed(app: &AppHandle, text: String, trigger: String) -> Result<(), String> {
    let payload = SelectionEvent { text, trigger };
    app.emit("selection-changed", payload)
        .map_err(|err| format!("emit selection event failed: {err}"))
}

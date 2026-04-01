use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size, State,
};

use crate::automation;
use crate::config::{self, AppConfig};
use crate::hotkey;
use crate::indicator;
use crate::ocr;
use crate::selection;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub client: Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslatePayload {
    pub text: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslateResponse {
    pub result: String,
    pub engine: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupPayload {
    pub word: String,
    pub source_lang: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictionaryMeaning {
    pub part_of_speech: String,
    pub definitions: Vec<String>,
    pub example: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupResponse {
    pub word: String,
    pub phonetic: Option<String>,
    pub audio_url: Option<String>,
    pub audio_lang: Option<String>,
    pub meanings: Vec<DictionaryMeaning>,
    pub provider: String,
    pub fallback_used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSearchPayload {
    pub query: String,
    pub page: u16,
    pub page_size: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageOption {
    pub src: String,
    pub source: String,
    pub title: String,
    pub page_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSearchResponse {
    pub query: String,
    pub page: u16,
    pub page_size: u16,
    pub options: Vec<ImageOption>,
    pub next_page: Option<u16>,
    pub has_more: bool,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrPayload {
    pub image_base64: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrResponse {
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
struct HotkeyTraceEvent {
    stage: String,
    shortcut: String,
    detail: String,
}

const OCR_OVERLAY_WINDOW_LABEL: &str = "ocr-overlay";

fn emit_hotkey_trace(app: &AppHandle, stage: &str, shortcut: &str, detail: String) {
    let _ = app.emit(
        "hotkey-trace",
        HotkeyTraceEvent {
            stage: stage.to_owned(),
            shortcut: shortcut.to_owned(),
            detail,
        },
    );
}

pub async fn translate_via_sidecar(
    client: &Client,
    payload: TranslatePayload,
) -> Result<TranslateResponse, String> {
    let endpoint = std::env::var("SIDECAR_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:49152/translate".to_owned());
    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("sidecar translate request failed: {err}"))?;
    response
        .json::<TranslateResponse>()
        .await
        .map_err(|err| format!("sidecar translate decode failed: {err}"))
}

async fn lookup_via_sidecar(
    client: &Client,
    payload: LookupPayload,
) -> Result<LookupResponse, String> {
    let endpoint = std::env::var("SIDECAR_LOOKUP_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:49152/lookup".to_owned());
    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("sidecar lookup request failed: {err}"))?;
    response
        .json::<LookupResponse>()
        .await
        .map_err(|err| format!("sidecar lookup decode failed: {err}"))
}

async fn search_images_via_sidecar(
    client: &Client,
    payload: ImageSearchPayload,
) -> Result<ImageSearchResponse, String> {
    let endpoint = std::env::var("SIDECAR_IMAGES_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:49152/images".to_owned());
    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("sidecar image search request failed: {err}"))?;
    response
        .json::<ImageSearchResponse>()
        .await
        .map_err(|err| format!("sidecar image search decode failed: {err}"))
}

async fn run_ocr_via_sidecar(client: &Client, payload: OcrPayload) -> Result<OcrResponse, String> {
    let endpoint = std::env::var("SIDECAR_OCR_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:49152/ocr".to_owned());
    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("sidecar ocr request failed: {err}"))?;
    response
        .json::<OcrResponse>()
        .await
        .map_err(|err| format!("sidecar ocr decode failed: {err}"))
}

fn monitor_for_cursor(window: &tauri::WebviewWindow, cursor: (i32, i32)) -> Option<tauri::Monitor> {
    let monitors = window.available_monitors().ok()?;
    let (x, y) = cursor;
    monitors.into_iter().find(|monitor| {
        let pos = monitor.position();
        let size = monitor.size();
        let left = pos.x;
        let top = pos.y;
        let right = left + i32::try_from(size.width).unwrap_or(i32::MAX);
        let bottom = top + i32::try_from(size.height).unwrap_or(i32::MAX);
        x >= left && x <= right && y >= top && y <= bottom
    })
}

#[tauri::command]
pub async fn load_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    let guard = state
        .config
        .lock()
        .map_err(|_| "config lock poisoned".to_owned())?;
    Ok(guard.clone())
}

#[tauri::command]
pub async fn save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: AppConfig,
) -> Result<AppConfig, String> {
    let clean = config.sanitize();
    {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| "config lock poisoned".to_owned())?;
        *guard = clean.clone();
    }
    config::save_config_to_disk(&app, &clean)?;
    hotkey::register_hotkeys(&app, &clean)?;
    let _ = app.emit("settings-updated", clean.clone());
    Ok(clean)
}

#[tauri::command]
pub async fn translate_text(
    state: State<'_, AppState>,
    payload: TranslatePayload,
) -> Result<TranslateResponse, String> {
    translate_via_sidecar(&state.client, payload).await
}

#[tauri::command]
pub async fn lookup_dictionary(
    state: State<'_, AppState>,
    payload: LookupPayload,
) -> Result<LookupResponse, String> {
    lookup_via_sidecar(&state.client, payload).await
}

#[tauri::command]
pub async fn search_images(
    state: State<'_, AppState>,
    payload: ImageSearchPayload,
) -> Result<ImageSearchResponse, String> {
    search_images_via_sidecar(&state.client, payload).await
}

#[tauri::command]
pub async fn emit_selection_changed(
    app: AppHandle,
    event_id: Option<u64>,
    text: String,
    trigger: String,
    anchor: Option<selection::SelectionAnchor>,
) -> Result<(), String> {
    selection::emit_selection_changed(&app, event_id.unwrap_or(0), text, trigger, anchor)
}

#[tauri::command]
pub fn hide_popover(app: AppHandle) -> Result<(), String> {
    selection::hide_popover_window(&app)
}

#[tauri::command]
pub fn show_loading_indicator(app: AppHandle) -> Result<(), String> {
    indicator::show_hotkey_indicator(&app, None)
}

#[tauri::command]
pub fn show_ocr_overlay(app: AppHandle) -> Result<(), String> {
    let overlay = app
        .get_webview_window(OCR_OVERLAY_WINDOW_LABEL)
        .ok_or_else(|| "ocr overlay window not found".to_owned())?;

    let cursor = automation::cursor_position();
    let monitor = cursor
        .and_then(|point| monitor_for_cursor(&overlay, point))
        .or_else(|| overlay.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    if let Some(mon) = &monitor {
        let size = mon.size();
        let _ = overlay.set_size(Size::Physical(PhysicalSize::new(size.width, size.height)));
        let pos = mon.position();
        let _ = overlay.set_position(Position::Physical(PhysicalPosition::new(pos.x, pos.y)));
    }

    overlay
        .show()
        .map_err(|err| format!("show ocr overlay failed: {err}"))?;
    overlay
        .set_focus()
        .map_err(|err| format!("focus ocr overlay failed: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn cancel_ocr_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window(OCR_OVERLAY_WINDOW_LABEL) {
        overlay
            .hide()
            .map_err(|err| format!("hide ocr overlay failed: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn submit_ocr_selection(
    app: AppHandle,
    state: State<'_, AppState>,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
) -> Result<(), String> {
    emit_hotkey_trace(
        &app,
        "ocr-submit-received",
        "overlay",
        format!("logical=({left},{top})-({right},{bottom})"),
    );

    let overlay = app
        .get_webview_window(OCR_OVERLAY_WINDOW_LABEL)
        .ok_or_else(|| "ocr overlay window not found".to_owned())?;
    let overlay_pos = overlay
        .outer_position()
        .map_err(|err| format!("read ocr overlay position failed: {err}"))?;
    let scale_factor = overlay
        .scale_factor()
        .map_err(|err| format!("read ocr overlay scale factor failed: {err}"))?;

    let physical_left = overlay_pos.x + (f64::from(left) * scale_factor).round() as i32;
    let physical_top = overlay_pos.y + (f64::from(top) * scale_factor).round() as i32;
    let physical_right = overlay_pos.x + (f64::from(right) * scale_factor).round() as i32;
    let physical_bottom = overlay_pos.y + (f64::from(bottom) * scale_factor).round() as i32;

    cancel_ocr_overlay(app.clone())?;

    let (ocr_enabled, source_language, target_language) = {
        let guard = state
            .config
            .lock()
            .map_err(|_| "config lock poisoned".to_owned())?;
        (
            guard.enable_ocr,
            guard.source_language.clone(),
            guard.target_language.clone(),
        )
    };
    if !ocr_enabled {
        emit_hotkey_trace(
            &app,
            "ocr-submit-skip",
            "overlay",
            "ocr disabled".to_owned(),
        );
        return Ok(());
    }

    let Some(region) =
        ocr::normalize_region(physical_left, physical_top, physical_right, physical_bottom)
    else {
        emit_hotkey_trace(
            &app,
            "ocr-submit-skip",
            "overlay",
            format!(
                "region too small after physical convert=({physical_left},{physical_top})-({physical_right},{physical_bottom})"
            ),
        );
        return Ok(());
    };

    emit_hotkey_trace(
        &app,
        "ocr-capture-start",
        "overlay",
        format!(
            "physical=({},{})->({},{}) | scale={:.3}",
            region.left, region.top, region.right, region.bottom, scale_factor
        ),
    );

    let anchor = region.center();
    let _ = indicator::show_hotkey_indicator(&app, Some(anchor));

    let png_base64 =
        match tauri::async_runtime::spawn_blocking(move || ocr::capture_region_png_base64(region))
            .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(err)) => {
                emit_hotkey_trace(&app, "ocr-capture-failed", "overlay", err.clone());
                return Err(err);
            }
            Err(err) => {
                let message = format!("ocr screenshot task failed: {err}");
                emit_hotkey_trace(&app, "ocr-capture-failed", "overlay", message.clone());
                return Err(message);
            }
        };

    let ocr_result = run_ocr_via_sidecar(
        &state.client,
        OcrPayload {
            image_base64: png_base64,
            source: source_language,
            target: target_language,
        },
    )
    .await;

    let _ = indicator::hide_hotkey_indicator(&app);

    let text = match ocr_result {
        Ok(result) => result.text.trim().to_owned(),
        Err(err) => {
            emit_hotkey_trace(&app, "ocr-sidecar-failed", "overlay", err.clone());
            return Err(err);
        }
    };
    emit_hotkey_trace(
        &app,
        "ocr-sidecar-done",
        "overlay",
        format!("textLen={}", text.chars().count()),
    );

    if text.is_empty() {
        emit_hotkey_trace(
            &app,
            "ocr-empty",
            "overlay",
            "sidecar returned empty text".to_owned(),
        );
        return Ok(());
    }

    let result = selection::show_popover_window(&app, text, "shortcut".to_owned(), Some(anchor));
    match &result {
        Ok(()) => emit_hotkey_trace(
            &app,
            "ocr-popover-shown",
            "overlay",
            "selection emitted".to_owned(),
        ),
        Err(err) => emit_hotkey_trace(&app, "ocr-popover-failed", "overlay", err.clone()),
    }
    result
}

#[tauri::command]
pub fn hide_loading_indicator(app: AppHandle) -> Result<(), String> {
    indicator::hide_hotkey_indicator(&app)
}

#[tauri::command]
pub fn cancel_popover_loading(app: AppHandle) -> Result<(), String> {
    hotkey::cancel_active_hotkey_translate();
    let _ = app.emit("force-close-popover", "loading-click-cancel".to_owned());
    let _ = selection::hide_popover_window(&app);
    indicator::hide_hotkey_indicator(&app)
}

#[tauri::command]
pub fn take_pending_selection() -> Result<Option<selection::SelectionEvent>, String> {
    selection::take_pending_selection()
}

#[tauri::command]
pub fn show_settings_window(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_owned())?;

    let _ = main.set_always_on_top(true);
    let _ = main.center();
    main.show()
        .map_err(|err| format!("show settings window failed: {err}"))?;
    let _ = main.set_always_on_top(false);

    main.set_focus()
        .map_err(|err| format!("focus settings window failed: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn hide_settings_window(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_owned())?;
    main.hide()
        .map_err(|err| format!("hide settings window failed: {err}"))
}

#[tauri::command]
pub fn show_debug_window(app: AppHandle) -> Result<(), String> {
    let debug = app
        .get_webview_window("debug-log")
        .ok_or_else(|| "debug window not found".to_owned())?;
    debug
        .show()
        .map_err(|err| format!("show debug window failed: {err}"))?;
    debug
        .set_focus()
        .map_err(|err| format!("focus debug window failed: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|err| format!("open clipboard failed: {err}"))?;
    clipboard
        .set_text(text)
        .map_err(|err| format!("write clipboard failed: {err}"))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn resize_popover(
    app: AppHandle,
    width: f64,
    height: f64,
    shift_x: Option<f64>,
    shiftX: Option<f64>,
    shift_y: Option<f64>,
    shiftY: Option<f64>,
    target_x: Option<f64>,
    targetX: Option<f64>,
    target_y: Option<f64>,
    targetY: Option<f64>,
    anchor: Option<selection::SelectionAnchor>,
) -> Result<(), String> {
    let popover = app
        .get_webview_window("popover")
        .ok_or_else(|| "popover window not found".to_owned())?;

    if !popover.is_visible().unwrap_or(false) {
        return Ok(());
    }

    let size_before_resize = popover.outer_size().ok();
    let position_before_resize = popover.outer_position().ok();

    popover
        .set_size(LogicalSize::new(width, height))
        .map_err(|err| format!("resize popover failed: {err}"))?;

    // Read position again after resizing because some platforms may auto-adjust
    // window coordinates when size changes near screen edges.
    let position_after_resize = popover.outer_position().ok();

    let resolved_target_x = target_x.or(targetX);
    let resolved_target_y = target_y.or(targetY);
    if let (Some(target_x), Some(target_y)) = (resolved_target_x, resolved_target_y) {
        let scale_factor = popover
            .scale_factor()
            .map_err(|err| format!("read popover scale factor failed: {err}"))?;
        let target = PhysicalPosition::new(
            (target_x * scale_factor).round() as i32,
            (target_y * scale_factor).round() as i32,
        );
        popover
            .set_position(Position::Physical(target))
            .map_err(|err| format!("position popover failed: {err}"))?;
        return Ok(());
    }

    let shift_dx = shift_x.or(shiftX).unwrap_or(0.0);
    let shift_dy = shift_y.or(shiftY).unwrap_or(0.0);
    let has_explicit_shift = shift_dx.abs() > 0.01 || shift_dy.abs() > 0.01;
    if has_explicit_shift {
        if let Some(pos) = position_before_resize.or(position_after_resize) {
            let scale_factor = popover
                .scale_factor()
                .map_err(|err| format!("read popover scale factor failed: {err}"))?;
            let shift_dx_physical = (shift_dx * scale_factor).round() as i32;
            let shift_dy_physical = (shift_dy * scale_factor).round() as i32;
            let target =
                PhysicalPosition::new(pos.x - shift_dx_physical, pos.y - shift_dy_physical);
            popover
                .set_position(Position::Physical(target))
                .map_err(|err| format!("shift popover failed: {err}"))?;
        }
    }

    if let Some(anchor_ref) = anchor.as_ref() {
        selection::reanchor_popover_window(&app, Some(anchor_ref))?;
        return Ok(());
    }

    // If caller requested an explicit logical shift, keep that result and
    // skip edge re-pinning to avoid fighting the frontend layout.
    if has_explicit_shift {
        return Ok(());
    }

    let monitor = popover
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    if let (Some(monitor), Some(before_pos), Some(before_size), Some(after_pos), Some(after_size)) = (
        monitor,
        position_before_resize,
        size_before_resize,
        popover.outer_position().ok(),
        popover.outer_size().ok(),
    ) {
        let margin = 8;
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();
        let monitor_left = monitor_pos.x;
        let monitor_top = monitor_pos.y;
        let monitor_right = monitor_left + i32::try_from(monitor_size.width).unwrap_or(i32::MAX);
        let monitor_bottom = monitor_top + i32::try_from(monitor_size.height).unwrap_or(i32::MAX);

        let before_w = i32::try_from(before_size.width).unwrap_or(0);
        let before_h = i32::try_from(before_size.height).unwrap_or(0);
        let after_w = i32::try_from(after_size.width).unwrap_or(0);
        let after_h = i32::try_from(after_size.height).unwrap_or(0);

        let right_edge_before = before_pos.x + before_w;
        let bottom_edge_before = before_pos.y + before_h;

        let pinned_right = (monitor_right - margin - right_edge_before).abs() <= 2;
        let pinned_bottom = (monitor_bottom - margin - bottom_edge_before).abs() <= 2;

        if pinned_right || pinned_bottom {
            let min_x = monitor_left + margin;
            let min_y = monitor_top + margin;
            let max_x = (monitor_right - after_w - margin).max(min_x);
            let max_y = (monitor_bottom - after_h - margin).max(min_y);

            let mut target_x = after_pos.x;
            let mut target_y = after_pos.y;

            if pinned_right {
                target_x = monitor_right - after_w - margin;
            }
            if pinned_bottom {
                target_y = monitor_bottom - after_h - margin;
            }

            target_x = target_x.clamp(min_x, max_x);
            target_y = target_y.clamp(min_y, max_y);

            if target_x != after_pos.x || target_y != after_pos.y {
                popover
                    .set_position(Position::Physical(PhysicalPosition::new(
                        target_x, target_y,
                    )))
                    .map_err(|err| format!("re-anchor popover after resize failed: {err}"))?;
            }
        }
    }

    Ok(())
}

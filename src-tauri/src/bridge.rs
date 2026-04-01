use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, State};

use crate::config::{self, AppConfig};
use crate::hotkey;
use crate::indicator;
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
pub fn hide_loading_indicator(app: AppHandle) -> Result<(), String> {
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
    main.show()
        .map_err(|err| format!("show settings window failed: {err}"))?;
    main.set_focus()
        .map_err(|err| format!("focus settings window failed: {err}"))?;
    Ok(())
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

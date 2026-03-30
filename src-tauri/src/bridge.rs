use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State};

use crate::config::{self, AppConfig};
use crate::hotkey;
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
    text: String,
    trigger: String,
    anchor: Option<selection::SelectionAnchor>,
) -> Result<(), String> {
    selection::emit_selection_changed(&app, text, trigger, anchor)
}

#[tauri::command]
pub fn hide_popover(app: AppHandle) -> Result<(), String> {
    selection::hide_popover_window(&app)
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
pub fn resize_popover(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let popover = app
        .get_webview_window("popover")
        .ok_or_else(|| "popover window not found".to_owned())?;
    popover
        .set_size(LogicalSize::new(width, height))
        .map_err(|err| format!("resize popover failed: {err}"))?;
    Ok(())
}

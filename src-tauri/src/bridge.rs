use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::Client;
use screenshots::image;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size, State,
};

use crate::automation;
use crate::config::{self, AppConfig};
use crate::debug_trace;
use crate::hotkey;
use crate::indicator;
use crate::ocr;
use crate::selection;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub client: Client,
}

#[derive(Default)]
pub struct UpdateState {
    pub pending: Mutex<Option<UpdateAvailablePayload>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateAvailablePayload {
    pub current_version: String,
    pub latest_version: String,
    pub url: String,
    pub prerelease: bool,
}

#[derive(Debug, Deserialize)]
struct VersionManifest {
    version: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    url: Option<String>,
}

const VERSION_MANIFEST_URL: &str = "https://dictover.langochung.me/version.json";
const DEFAULT_RELEASES_PAGE: &str = "https://dictover.langochung.me/releases";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrOverlayResponse {
    pub text: String,
    pub translated_text: String,
    pub image_base64: String,
    #[serde(default)]
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
struct OcrOverlayResultEvent {
    image_base64: String,
    text: String,
    original_text: String,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    source_language: String,
    target_language: String,
    original_text_len: usize,
    translated_text_len: usize,
    translation_applied: bool,
    image_overlay_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
struct HotkeyTraceEvent {
    stage: String,
    shortcut: String,
    detail: String,
}

const OCR_OVERLAY_WINDOW_LABEL: &str = "ocr-overlay";

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

async fn run_ocr_overlay_via_sidecar(
    client: &Client,
    payload: OcrPayload,
) -> Result<OcrOverlayResponse, String> {
    let endpoint = std::env::var("SIDECAR_OCR_OVERLAY_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:49152/ocr-overlay".to_owned());
    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("sidecar ocr overlay request failed: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("sidecar ocr overlay read failed: {err}"))?;

    if !status.is_success() {
        let snippet: String = body.chars().take(240).collect();
        return Err(format!("sidecar ocr overlay http {}: {}", status, snippet));
    }

    serde_json::from_str::<OcrOverlayResponse>(&body).map_err(|err| {
        let snippet: String = body.chars().take(240).collect();
        format!("sidecar ocr overlay decode failed: {err} | body={snippet}")
    })
}

fn count_words(input: &str) -> usize {
    input
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .count()
}

fn count_non_whitespace_chars(input: &str) -> usize {
    input.chars().filter(|ch| !ch.is_whitespace()).count()
}

fn is_cjk_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{3040}'..='\u{30FF}'
            | '\u{31F0}'..='\u{31FF}'
            | '\u{AC00}'..='\u{D7AF}'
    )
}

fn contains_sentence_punctuation(input: &str) -> bool {
    input.chars().any(|ch| {
        matches!(
            ch,
            '.' | ',' | '!' | '?' | ';' | ':' | '。' | '，' | '、' | '！' | '？' | '；' | '：'
        )
    })
}

fn should_use_ocr_image_overlay(input: &str) -> bool {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return false;
    }

    if count_words(trimmed) > 1 {
        return true;
    }

    let char_count = count_non_whitespace_chars(trimmed);
    if char_count >= 24 {
        return true;
    }

    let cjk_char_count = trimmed.chars().filter(|ch| is_cjk_char(*ch)).count();
    if cjk_char_count >= 6 {
        return true;
    }

    contains_sentence_punctuation(trimmed) && char_count >= 8
}

fn is_supported_source_language(value: &str) -> bool {
    matches!(
        value,
        "auto" | "vi" | "en" | "zh-CN" | "ja" | "ko" | "ru" | "de" | "fr" | "fi"
    )
}

fn is_supported_target_language(value: &str) -> bool {
    matches!(
        value,
        "vi" | "en" | "zh-CN" | "ja" | "ko" | "ru" | "de" | "fr" | "fi"
    )
}

fn parse_semver(value: &str) -> Option<Version> {
    let normalized = value.trim().trim_start_matches('v');
    Version::parse(normalized).ok()
}

fn is_newer_version(current: &str, latest: &str) -> bool {
    match (parse_semver(current), parse_semver(latest)) {
        (Some(current_ver), Some(latest_ver)) => latest_ver > current_ver,
        _ => false,
    }
}

async fn compute_update_payload(
    client: &Client,
    current_version: &str,
) -> Result<Option<UpdateAvailablePayload>, String> {
    let manifest = fetch_version_manifest(client).await?;
    let latest_version = manifest.version.trim().to_owned();

    if latest_version.is_empty() {
        return Err("version manifest has empty version".to_owned());
    }

    if !is_newer_version(current_version, &latest_version) {
        return Ok(None);
    }

    Ok(Some(UpdateAvailablePayload {
        current_version: current_version.to_owned(),
        latest_version,
        url: manifest
            .url
            .unwrap_or_else(|| DEFAULT_RELEASES_PAGE.to_owned()),
        prerelease: manifest.prerelease,
    }))
}

async fn fetch_version_manifest(client: &Client) -> Result<VersionManifest, String> {
    let response = client
        .get(VERSION_MANIFEST_URL)
        .send()
        .await
        .map_err(|err| format!("version manifest request failed: {err}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<failed-to-read-body>".to_owned())
            .replace('\n', " ")
            .replace('\r', " ");
        let body_preview: String = body.chars().take(260).collect();
        return Err(format!(
            "version manifest request failed with status {status} | body={body_preview}"
        ));
    }

    let manifest = response
        .json::<VersionManifest>()
        .await
        .map_err(|err| format!("version manifest decode failed: {err}"))?;

    Ok(manifest)
}

pub async fn check_for_updates_and_emit(app: AppHandle) {
    let client = Client::new();
    let current_version = env!("CARGO_PKG_VERSION").to_owned();

    let payload = compute_update_payload(&client, &current_version)
        .await
        .unwrap_or(None);

    if let Ok(mut guard) = app.state::<UpdateState>().pending.lock() {
        *guard = payload.clone();
    }

    if let Some(value) = payload {
        let _ = app.emit("update-available", value);
    }
}

#[tauri::command]
pub async fn check_for_updates_now(
    app: AppHandle,
) -> Result<Option<UpdateAvailablePayload>, String> {
    let client = Client::new();
    let current_version = env!("CARGO_PKG_VERSION").to_owned();
    let payload = compute_update_payload(&client, &current_version).await?;

    if let Ok(mut guard) = app.state::<UpdateState>().pending.lock() {
        *guard = payload.clone();
    }

    if let Some(value) = payload.clone() {
        let _ = app.emit("update-available", value);
    }

    Ok(payload)
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
pub fn get_pending_update(
    state: State<'_, UpdateState>,
) -> Result<Option<UpdateAvailablePayload>, String> {
    let guard = state
        .pending
        .lock()
        .map_err(|_| "update state lock poisoned".to_owned())?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_owned())
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
    let _ = selection::hide_popover_window(&app);
    let _ = app.emit("ocr-overlay-reset", "open");

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
#[allow(non_snake_case)]
pub async fn submit_ocr_selection(
    app: AppHandle,
    state: State<'_, AppState>,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    source_language: Option<String>,
    sourceLanguage: Option<String>,
    target_language: Option<String>,
    targetLanguage: Option<String>,
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

    let logical_left = left.min(right);
    let logical_top = top.min(bottom);
    let logical_width = (right - left).abs();
    let logical_height = (bottom - top).abs();

    let _ = app.emit("ocr-overlay-processing", "processing");

    let requested_source_language = source_language
        .or(sourceLanguage)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let requested_target_language = target_language
        .or(targetLanguage)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let requested_source_for_log = requested_source_language.clone();
    let requested_target_for_log = requested_target_language.clone();

    let (ocr_enabled, config_source_language, config_target_language, ocr_paragraph_display_mode) = {
        let guard = state
            .config
            .lock()
            .map_err(|_| "config lock poisoned".to_owned())?;
        (
            guard.enable_ocr,
            guard.source_language.clone(),
            guard.target_language.clone(),
            guard.ocr_paragraph_display_mode.clone(),
        )
    };
    let effective_source_language = requested_source_language
        .as_deref()
        .filter(|value| is_supported_source_language(value))
        .map(str::to_owned)
        .unwrap_or(config_source_language);
    let effective_target_language = requested_target_language
        .as_deref()
        .filter(|value| is_supported_target_language(value))
        .map(str::to_owned)
        .unwrap_or(config_target_language);
    let ocr_source_language = if effective_source_language == effective_target_language {
        "auto".to_owned()
    } else {
        effective_source_language.clone()
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

    emit_hotkey_trace(
        &app,
        "ocr-language-resolved",
        "overlay",
        format!(
            "requestedSource={} requestedTarget={} effectiveSource={} effectiveTarget={} ocrSource={}",
            requested_source_for_log.as_deref().unwrap_or("<none>"),
            requested_target_for_log.as_deref().unwrap_or("<none>"),
            effective_source_language,
            effective_target_language,
            ocr_source_language
        ),
    );

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
                let _ = cancel_ocr_overlay(app.clone());
                return Err(err);
            }
            Err(err) => {
                let message = format!("ocr screenshot task failed: {err}");
                emit_hotkey_trace(&app, "ocr-capture-failed", "overlay", message.clone());
                let _ = cancel_ocr_overlay(app.clone());
                return Err(message);
            }
        };

    let ocr_result = run_ocr_via_sidecar(
        &state.client,
        OcrPayload {
            image_base64: png_base64.clone(),
            source: ocr_source_language.clone(),
            target: effective_target_language.clone(),
        },
    )
    .await;

    let _ = indicator::hide_hotkey_indicator(&app);

    let text = match ocr_result {
        Ok(result) => result.text.trim().to_owned(),
        Err(err) => {
            emit_hotkey_trace(&app, "ocr-sidecar-failed", "overlay", err.clone());
            let _ = cancel_ocr_overlay(app.clone());
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
        let _ = cancel_ocr_overlay(app.clone());
        return Ok(());
    }

    let overlay_word_count = count_words(&text);
    let overlay_char_count = count_non_whitespace_chars(&text);
    let default_overlay_routing = should_use_ocr_image_overlay(&text);
    let use_overlay_flow = if overlay_word_count > 1 {
        ocr_paragraph_display_mode == "image"
    } else {
        default_overlay_routing
    };
    emit_hotkey_trace(
        &app,
        "ocr-routing-decision",
        "overlay",
        format!(
            "wordCount={overlay_word_count} charCount={overlay_char_count} defaultOverlay={default_overlay_routing} paragraphMode={} useOverlay={use_overlay_flow}",
            ocr_paragraph_display_mode
        ),
    );

    if use_overlay_flow {
        emit_hotkey_trace(
            &app,
            "ocr-overlay-flow-start",
            "overlay",
            "multi-token OCR selection detected".to_owned(),
        );

        let mut overlay_text = text.clone();
        let mut overlay_original_text = text.clone();
        let mut overlay_image_base64 = png_base64.clone();
        let mut overlay_original_text_len = text.chars().count();
        let mut overlay_translated_text_len = 0usize;
        let mut overlay_translation_applied = false;
        let mut overlay_image_changed = false;

        match run_ocr_overlay_via_sidecar(
            &state.client,
            OcrPayload {
                image_base64: png_base64,
                source: ocr_source_language.clone(),
                target: effective_target_language.clone(),
            },
        )
        .await
        {
            Ok(overlay) => {
                let sidecar_original = overlay.text.trim();
                let sidecar_translated = overlay.translated_text.trim();
                overlay_original_text_len = sidecar_original.chars().count();
                overlay_translated_text_len = sidecar_translated.chars().count();
                if !sidecar_original.is_empty() {
                    overlay_original_text = sidecar_original.to_owned();
                }

                if !overlay.error.trim().is_empty() {
                    emit_hotkey_trace(
                        &app,
                        "ocr-overlay-sidecar-warn",
                        "overlay",
                        format!(
                            "source={} target={} error={}",
                            ocr_source_language,
                            effective_target_language,
                            overlay.error.trim()
                        ),
                    );
                }

                let translated = overlay.translated_text.trim();
                if !translated.is_empty() {
                    overlay_text = translated.to_owned();
                }
                overlay_translation_applied =
                    !translated.is_empty() && translated != sidecar_original;

                let overlay_image = overlay.image_base64.trim();
                if overlay_image.is_empty() {
                    emit_hotkey_trace(
                        &app,
                        "ocr-overlay-flow-fallback",
                        "overlay",
                        "sidecar returned empty overlay image, using captured region".to_owned(),
                    );
                } else {
                    overlay_image_changed = overlay_image != overlay_image_base64;
                    overlay_image_base64 = overlay_image.to_owned();
                }

                emit_hotkey_trace(
                    &app,
                    "ocr-overlay-sidecar-response",
                    "overlay",
                    format!(
                        "source={} target={} originalTextLen={} translatedTextLen={} translationApplied={} imageOverlayChanged={} outputImageLen={}",
                        ocr_source_language,
                        effective_target_language,
                        overlay_original_text_len,
                        overlay_translated_text_len,
                        overlay_translation_applied,
                        overlay_image_changed,
                        overlay_image_base64.len()
                    ),
                );
            }
            Err(err) => {
                emit_hotkey_trace(
                    &app,
                    "ocr-overlay-flow-fallback",
                    "overlay",
                    format!("overlay generation failed, using captured region: {err}"),
                );
            }
        }

        let _ = app.emit(
            "ocr-overlay-result-ready",
            OcrOverlayResultEvent {
                image_base64: overlay_image_base64,
                text: overlay_text.clone(),
                original_text: overlay_original_text,
                left: logical_left,
                top: logical_top,
                width: logical_width,
                height: logical_height,
                source_language: ocr_source_language.clone(),
                target_language: effective_target_language.clone(),
                original_text_len: overlay_original_text_len,
                translated_text_len: overlay_translated_text_len,
                translation_applied: overlay_translation_applied,
                image_overlay_changed: overlay_image_changed,
            },
        );
        emit_hotkey_trace(
            &app,
            "ocr-overlay-flow-shown",
            "overlay",
            format!("result textLen={}", overlay_text.chars().count()),
        );
        return Ok(());
    }

    cancel_ocr_overlay(app.clone())?;

    let result = selection::show_popover_window(&app, text, "ocr".to_owned(), Some(anchor));
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
pub fn open_external_url(url: String) -> Result<(), String> {
    let value = url.trim();
    if value.is_empty() {
        return Err("url is empty".to_owned());
    }
    if !value.starts_with("https://") && !value.starts_with("http://") {
        return Err("only http/https urls are allowed".to_owned());
    }
    webbrowser::open(value)
        .map(|_| ())
        .map_err(|err| format!("open external url failed: {err}"))
}

#[tauri::command]
pub fn copy_image_to_clipboard(image_base64: String) -> Result<(), String> {
    let payload = image_base64.trim();
    if payload.is_empty() {
        return Err("image payload is empty".to_owned());
    }

    let bytes = BASE64_STANDARD
        .decode(payload)
        .map_err(|err| format!("decode image payload failed: {err}"))?;
    let decoded = image::load_from_memory(&bytes)
        .map_err(|err| format!("decode image bytes failed: {err}"))?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    if width == 0 || height == 0 {
        return Err("decoded image is empty".to_owned());
    }

    let mut clipboard =
        arboard::Clipboard::new().map_err(|err| format!("open clipboard failed: {err}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(rgba.into_raw()),
        })
        .map_err(|err| format!("write image clipboard failed: {err}"))
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

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::Client;
use screenshots::image;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashSet;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};
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
const QUICK_CONVERT_BASE_WIDTH: f64 = 520.0;
const QUICK_CONVERT_BASE_HEIGHT: f64 = 360.0;
const SIDECAR_HEALTH_WAIT_TIMEOUT_MS: u64 = 2600;
const SIDECAR_HEALTH_REQUEST_TIMEOUT_MS: u64 = 700;
const SIDECAR_HEALTH_RETRY_BASE_MS: u64 = 80;
const SIDECAR_WARMUP_REQUEST_TIMEOUT_MS: u64 = 18000;
const SIDECAR_WARMUP_MAX_ATTEMPTS: u8 = 3;
const SIDECAR_WARMUP_RETRY_BASE_MS: u64 = 140;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslatePayload {
    pub text: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
struct WarmupPayload {
    source: String,
    target: String,
}

#[derive(Debug, Clone, Deserialize)]
struct WarmupResponsePayload {
    #[serde(default)]
    source: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    ready: Option<bool>,
    #[serde(default)]
    status: Value,
}

#[derive(Debug, Clone, Serialize)]
struct SidecarReadinessPayload {
    stage: String,
    ready: bool,
    attempts: u8,
    elapsed_ms: u64,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
struct SidecarWarmupStatusPayload {
    stage: String,
    source: String,
    target: String,
    ready: bool,
    attempts: u8,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslateResponse {
    pub result: String,
    pub engine: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickConvertPayload {
    pub text: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickConvertWordData {
    pub input: String,
    #[serde(default)]
    pub phonetic: Option<String>,
    #[serde(default)]
    pub part_of_speech: Option<String>,
    #[serde(default)]
    pub audio_url: Option<String>,
    #[serde(default)]
    pub audio_lang: Option<String>,
    #[serde(default)]
    pub synonyms: Vec<String>,
    #[serde(default)]
    pub related: Vec<String>,
    #[serde(default)]
    pub sounds_like: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickConvertResponse {
    pub kind: String,
    pub result: String,
    pub engine: String,
    pub mode: String,
    pub fallback_used: bool,
    pub word_data: Option<QuickConvertWordData>,
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

#[derive(Debug, Clone, Serialize)]
struct OcrOverlayBackgroundPayload {
    image_base64: String,
}

#[derive(Debug, Clone, Serialize)]
struct QuickConvertOpenedPayload {
    text: String,
    shortcut: String,
    position_mode: String,
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

fn sidecar_health_target() -> (String, u16) {
    let host = std::env::var("SIDECAR_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = std::env::var("SIDECAR_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(49152);
    (host, port)
}

fn sidecar_warmup_endpoint() -> String {
    std::env::var("SIDECAR_WARMUP_URL").unwrap_or_else(|_| {
        let host = std::env::var("SIDECAR_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
        let port = std::env::var("SIDECAR_PORT").unwrap_or_else(|_| "49152".to_owned());
        format!("http://{host}:{port}/warmup")
    })
}

fn warmup_status_ok(status: &Value, key: &str) -> Option<bool> {
    status
        .as_object()
        .and_then(|obj| obj.get(key))
        .and_then(|value| value.as_object())
        .and_then(|entry| entry.get("ok"))
        .and_then(|ok| ok.as_i64())
        .map(|ok| ok == 1)
}

fn warmup_response_ready(payload: &WarmupResponsePayload) -> bool {
    if let Some(ready) = payload.ready {
        return ready;
    }

    let mut saw_any = false;
    for key in [
        "argos_translate",
        "api_translate",
        "quick_convert",
        "lookup",
    ] {
        if let Some(ok) = warmup_status_ok(&payload.status, key) {
            saw_any = true;
            if !ok {
                return false;
            }
        }
    }

    saw_any
}

fn warmup_status_summary(payload: &WarmupResponsePayload) -> String {
    let to_flag = |value: Option<bool>| match value {
        Some(true) => "1",
        Some(false) => "0",
        None => "?",
    };

    format!(
        "argos={} api={} quick={} lookup={}",
        to_flag(warmup_status_ok(&payload.status, "argos_translate")),
        to_flag(warmup_status_ok(&payload.status, "api_translate")),
        to_flag(warmup_status_ok(&payload.status, "quick_convert")),
        to_flag(warmup_status_ok(&payload.status, "lookup")),
    )
}

fn emit_sidecar_readiness(
    app: &AppHandle,
    stage: &str,
    ready: bool,
    attempts: u8,
    elapsed_ms: u64,
    detail: String,
) {
    let _ = app.emit(
        "sidecar-readiness",
        SidecarReadinessPayload {
            stage: stage.to_owned(),
            ready,
            attempts,
            elapsed_ms,
            detail,
        },
    );
}

pub fn wait_for_sidecar_health(app: &AppHandle, stage: &str) -> bool {
    let (host, port) = sidecar_health_target();
    let endpoint = format!("{host}:{port}");
    let started_at = Instant::now();
    let deadline = started_at + Duration::from_millis(SIDECAR_HEALTH_WAIT_TIMEOUT_MS);
    let mut attempts: u8 = 0;
    let mut delay_ms = SIDECAR_HEALTH_RETRY_BASE_MS;
    let mut last_detail: Option<String> = None;

    loop {
        attempts = attempts.saturating_add(1);
        let mut connected = false;
        match endpoint.to_socket_addrs() {
            Ok(addresses) => {
                for addr in addresses {
                    if TcpStream::connect_timeout(
                        &addr,
                        Duration::from_millis(SIDECAR_HEALTH_REQUEST_TIMEOUT_MS),
                    )
                    .is_ok()
                    {
                        connected = true;
                        break;
                    }
                }
            }
            Err(err) => {
                if last_detail.is_none() {
                    last_detail = Some(format!("endpoint={endpoint} resolve-failed={err}"));
                }
            }
        }

        if connected {
            let elapsed_ms = started_at.elapsed().as_millis() as u64;
            emit_sidecar_readiness(
                app,
                stage,
                true,
                attempts,
                elapsed_ms,
                format!("endpoint={endpoint} tcp-ready=1"),
            );
            return true;
        }

        if last_detail.is_none() {
            last_detail = Some(format!("endpoint={endpoint} tcp-ready=0"));
        }

        if Instant::now() >= deadline {
            break;
        }

        std::thread::sleep(Duration::from_millis(delay_ms));
        delay_ms = (delay_ms * 2).min(320);
    }

    let elapsed_ms = started_at.elapsed().as_millis() as u64;
    emit_sidecar_readiness(
        app,
        stage,
        false,
        attempts,
        elapsed_ms,
        last_detail.unwrap_or_else(|| "health-check-timeout".to_owned()),
    );
    false
}

fn normalize_warmup_source(source: &str) -> String {
    if source.trim() == "auto" {
        "en".to_owned()
    } else {
        source.trim().to_owned()
    }
}

fn push_warmup_pair(
    seen: &mut HashSet<String>,
    pairs: &mut Vec<(String, String)>,
    source: String,
    target: String,
) {
    if source.is_empty() || target.is_empty() {
        return;
    }

    let key = format!("{}->{}", source, target);
    if seen.insert(key) {
        pairs.push((source, target));
    }
}

fn warmup_pairs_from_config(config: &AppConfig) -> Vec<(String, String)> {
    let mut seen = HashSet::<String>::new();
    let mut pairs: Vec<(String, String)> = Vec::new();

    let popover_source = normalize_warmup_source(&config.source_language);
    let popover_target = config.target_language.trim().to_owned();
    if !popover_source.is_empty() && !popover_target.is_empty() {
        push_warmup_pair(
            &mut seen,
            &mut pairs,
            popover_source.clone(),
            popover_target.clone(),
        );
        if popover_source != popover_target {
            push_warmup_pair(&mut seen, &mut pairs, popover_target, popover_source);
        }
    }

    let quick_source = normalize_warmup_source(&config.quick_translate_source_language);
    let quick_target = config.quick_translate_target_language.trim().to_owned();
    if !quick_source.is_empty() && !quick_target.is_empty() {
        push_warmup_pair(
            &mut seen,
            &mut pairs,
            quick_source.clone(),
            quick_target.clone(),
        );
        if quick_source != quick_target {
            push_warmup_pair(&mut seen, &mut pairs, quick_target, quick_source);
        }
    }

    pairs
}

fn warmup_languages_changed(previous: &AppConfig, next: &AppConfig) -> bool {
    previous.source_language != next.source_language
        || previous.target_language != next.target_language
        || previous.quick_translate_source_language != next.quick_translate_source_language
        || previous.quick_translate_target_language != next.quick_translate_target_language
}

async fn warmup_pair_via_sidecar(
    client: &Client,
    stage: &str,
    source: String,
    target: String,
) -> SidecarWarmupStatusPayload {
    let endpoint = sidecar_warmup_endpoint();
    let mut attempts: u8 = 0;
    let mut delay_ms = SIDECAR_WARMUP_RETRY_BASE_MS;
    let mut last_detail = "warmup-not-started".to_owned();

    for attempt in 1..=SIDECAR_WARMUP_MAX_ATTEMPTS {
        attempts = attempt;
        let result = client
            .post(endpoint.clone())
            .json(&WarmupPayload {
                source: source.clone(),
                target: target.clone(),
            })
            .timeout(Duration::from_millis(SIDECAR_WARMUP_REQUEST_TIMEOUT_MS))
            .send()
            .await;

        match result {
            Ok(response) => {
                let status_code = response.status().as_u16();
                match response.json::<WarmupResponsePayload>().await {
                    Ok(payload) => {
                        let ready = warmup_response_ready(&payload);
                        let summary = warmup_status_summary(&payload);
                        let payload_source = if payload.source.trim().is_empty() {
                            source.clone()
                        } else {
                            payload.source
                        };
                        let payload_target = if payload.target.trim().is_empty() {
                            target.clone()
                        } else {
                            payload.target
                        };
                        let detail =
                            format!("endpoint={endpoint} status={status_code} {}", summary);
                        return SidecarWarmupStatusPayload {
                            stage: stage.to_owned(),
                            source: payload_source,
                            target: payload_target,
                            ready,
                            attempts,
                            detail,
                        };
                    }
                    Err(err) => {
                        last_detail =
                            format!("endpoint={endpoint} status={status_code} decode-failed={err}");
                    }
                }
            }
            Err(err) => {
                last_detail = format!("endpoint={endpoint} request-failed={err}");
            }
        }

        if attempt < SIDECAR_WARMUP_MAX_ATTEMPTS {
            std::thread::sleep(Duration::from_millis(delay_ms));
            delay_ms = (delay_ms * 2).min(520);
        }
    }

    SidecarWarmupStatusPayload {
        stage: stage.to_owned(),
        source,
        target,
        ready: false,
        attempts,
        detail: last_detail,
    }
}

pub fn schedule_language_warmup(app: AppHandle, client: Client, config: AppConfig, stage: &str) {
    let pairs = warmup_pairs_from_config(&config);
    if pairs.is_empty() {
        return;
    }

    let stage = stage.to_owned();

    tauri::async_runtime::spawn(async move {
        for (source, target) in pairs {
            let payload = warmup_pair_via_sidecar(&client, &stage, source, target).await;
            let _ = app.emit("sidecar-warmup-status", payload);
        }
    });
}

pub async fn quick_convert_via_sidecar(
    client: &Client,
    payload: QuickConvertPayload,
) -> Result<QuickConvertResponse, String> {
    let endpoint = std::env::var("SIDECAR_QUICK_CONVERT_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:49152/quick-convert".to_owned());
    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("sidecar quick-convert request failed: {err}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        let text = payload.text.trim().to_owned();
        let source = payload.source.clone();
        let target = payload.target.clone();
        let translate = translate_via_sidecar(
            client,
            TranslatePayload {
                text: text.clone(),
                source: source.clone(),
                target: target.clone(),
            },
        )
        .await
        .map_err(|err| format!("sidecar quick-convert compat translate failed: {err}"))?;

        let translated_word = translate.result.trim().to_owned();
        let source_is_english = is_english_language_code(&source);
        let target_is_english = is_english_language_code(&target);
        let use_english_metadata = source_is_english || target_is_english;

        let metadata_lang = if use_english_metadata {
            "en".to_owned()
        } else {
            target.clone()
        };

        let metadata_word = if source_is_english {
            text.clone()
        } else {
            translated_word.clone()
        };
        let metadata_single_word = is_single_word_candidate(&metadata_word);

        let mut word_data: Option<QuickConvertWordData> = None;
        if metadata_single_word {
            let (synonyms, related, sounds_like) =
                query_datamuse_word_data(client, &metadata_word).await;
            let lookup = lookup_via_sidecar(
                client,
                LookupPayload {
                    word: metadata_word.clone(),
                    source_lang: metadata_lang.clone(),
                },
            )
            .await
            .ok();

            let phonetic = lookup.as_ref().and_then(|item| item.phonetic.clone());
            let part_of_speech = lookup.as_ref().and_then(|item| {
                item.meanings.iter().find_map(|meaning| {
                    let trimmed = meaning.part_of_speech.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed.to_owned())
                    }
                })
            });
            let mut audio_url = lookup.as_ref().and_then(|item| item.audio_url.clone());
            let mut audio_lang = lookup.as_ref().and_then(|item| item.audio_lang.clone());
            if audio_url.is_none() {
                audio_url = build_google_tts_url(&metadata_word, &metadata_lang);
                if audio_url.is_some() {
                    audio_lang = Some(metadata_lang.clone());
                }
            }
            let has_extra = phonetic.is_some()
                || part_of_speech.is_some()
                || audio_url.is_some()
                || !synonyms.is_empty()
                || !related.is_empty()
                || !sounds_like.is_empty();

            if has_extra {
                word_data = Some(QuickConvertWordData {
                    input: metadata_word,
                    phonetic,
                    part_of_speech,
                    audio_url,
                    audio_lang,
                    synonyms,
                    related,
                    sounds_like,
                });
            }
        }

        return Ok(QuickConvertResponse {
            kind: if word_data.is_some() {
                "word".to_owned()
            } else {
                "text".to_owned()
            },
            result: translate.result,
            engine: translate.engine,
            mode: if word_data.is_some() {
                format!("{}+compat-word-enriched", translate.mode)
            } else {
                format!("{}+compat-translate", translate.mode)
            },
            fallback_used: true,
            word_data,
        });
    }

    if !response.status().is_success() {
        let status = response.status();
        let snippet = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(240)
            .collect::<String>();
        return Err(format!(
            "sidecar quick-convert http {}: {}",
            status, snippet
        ));
    }

    response
        .json::<QuickConvertResponse>()
        .await
        .map_err(|err| format!("sidecar quick-convert decode failed: {err}"))
}

fn build_google_tts_url(text: &str, lang: &str) -> Option<String> {
    let query = text.trim();
    if query.is_empty() {
        return None;
    }

    let normalized_lang = match lang.trim() {
        "zh" | "zh-CN" => "zh-CN",
        "" => "en",
        value => value,
    };

    let mut url = reqwest::Url::parse("https://translate.google.com/translate_tts").ok()?;
    url.query_pairs_mut()
        .append_pair("ie", "UTF-8")
        .append_pair("client", "tw-ob")
        .append_pair("tl", normalized_lang)
        .append_pair("q", query);
    Some(url.to_string())
}

async fn query_datamuse_word_data(
    client: &Client,
    word: &str,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let synonyms = collect_datamuse_words(client, "rel_syn", word, 8).await;
    let related = collect_datamuse_words(client, "ml", word, 8).await;
    let sounds_like = collect_datamuse_words(client, "sl", word, 8).await;
    (synonyms, related, sounds_like)
}

async fn collect_datamuse_words(
    client: &Client,
    key: &str,
    word: &str,
    limit: usize,
) -> Vec<String> {
    let response = match client
        .get("https://api.datamuse.com/words")
        .query(&[(key, word), ("max", "8")])
        .send()
        .await
    {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    if !response.status().is_success() {
        return Vec::new();
    }

    let payload = match response.json::<Vec<Value>>().await {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    let mut words: Vec<String> = Vec::new();
    for item in payload {
        let Some(word_value) = item.get("word").and_then(Value::as_str) else {
            continue;
        };
        let normalized = word_value.trim();
        if normalized.is_empty() {
            continue;
        }
        if words
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(normalized))
        {
            continue;
        }
        words.push(normalized.to_owned());
        if words.len() >= limit {
            break;
        }
    }
    words
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

fn is_english_language_code(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "en" | "en-us" | "en-gb"
    )
}

fn is_single_word_candidate(input: &str) -> bool {
    let trimmed = input.trim();
    !trimmed.is_empty()
        && count_words(trimmed) == 1
        && !contains_sentence_punctuation(trimmed)
        && count_non_whitespace_chars(trimmed) <= 48
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

fn resolve_quick_convert_position(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    position_mode: &str,
) -> PhysicalPosition<i32> {
    let Ok(window_size) = window.outer_size() else {
        return PhysicalPosition::new(24, 24);
    };

    let width = i32::try_from(window_size.width).unwrap_or(QUICK_CONVERT_BASE_WIDTH as i32);
    let height = i32::try_from(window_size.height).unwrap_or(QUICK_CONVERT_BASE_HEIGHT as i32);
    let cursor = automation::cursor_position();
    let monitor = cursor
        .and_then(|point| monitor_for_cursor(window, point))
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return PhysicalPosition::new(24, 24);
    };

    let horizontal_margin = 0;
    let vertical_margin = 0;
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let mon_left = mon_pos.x;
    let mon_top = mon_pos.y;
    let mon_right = mon_left + i32::try_from(mon_size.width).unwrap_or(i32::MAX);
    let mon_bottom = mon_top + i32::try_from(mon_size.height).unwrap_or(i32::MAX);

    let min_x = mon_left + horizontal_margin;
    let max_x = (mon_right - width - horizontal_margin).max(min_x);
    let min_y = mon_top + vertical_margin;
    let max_y = (mon_bottom - height - vertical_margin).max(min_y);

    let center_x = mon_left + ((mon_right - mon_left - width) / 2);
    let center_y = mon_top + ((mon_bottom - mon_top - height) / 2);

    let normalized_mode = match position_mode {
        "left-middle" => "middle-left",
        "right-middle" => "middle-right",
        "center" => "middle-center",
        other => other,
    };

    let (preferred_x, preferred_y) = match normalized_mode {
        "top-left" => (min_x, min_y),
        "top-center" => (center_x, min_y),
        "top-right" => (max_x, min_y),
        "middle-left" => (min_x, center_y),
        "middle-center" => (center_x, center_y),
        "middle-right" => (max_x, center_y),
        "bottom-left" => (min_x, max_y),
        "bottom-center" => (center_x, max_y),
        "bottom-right" => (max_x, max_y),
        _ => (min_x, center_y),
    };

    PhysicalPosition::new(
        preferred_x.clamp(min_x, max_x),
        preferred_y.clamp(min_y, max_y),
    )
}

pub fn show_quick_convert_window_with_seed(
    app: &AppHandle,
    position_mode: &str,
    seed_text: Option<String>,
    shortcut: Option<String>,
) -> Result<(), String> {
    let quick_convert = app
        .get_webview_window("quick-convert")
        .ok_or_else(|| "quick convert window not found".to_owned())?;

    let _ = quick_convert.set_always_on_top(true);
    quick_convert
        .set_size(Size::Logical(LogicalSize::new(
            QUICK_CONVERT_BASE_WIDTH,
            QUICK_CONVERT_BASE_HEIGHT,
        )))
        .map_err(|err| format!("set quick convert size failed: {err}"))?;

    let position = resolve_quick_convert_position(app, &quick_convert, position_mode);
    quick_convert
        .set_position(Position::Physical(position))
        .map_err(|err| format!("set quick convert position failed: {err}"))?;

    quick_convert
        .show()
        .map_err(|err| format!("show quick convert window failed: {err}"))?;
    quick_convert
        .set_focus()
        .map_err(|err| format!("focus quick convert window failed: {err}"))?;

    let payload = QuickConvertOpenedPayload {
        text: seed_text.unwrap_or_default(),
        shortcut: shortcut.unwrap_or_default(),
        position_mode: position_mode.to_owned(),
    };
    app.emit_to("quick-convert", "quick-convert-opened", payload)
        .map_err(|err| format!("emit quick convert opened failed: {err}"))?;

    Ok(())
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
pub async fn quick_convert_text(
    state: State<'_, AppState>,
    payload: QuickConvertPayload,
) -> Result<QuickConvertResponse, String> {
    quick_convert_via_sidecar(&state.client, payload).await
}

#[tauri::command]
pub fn show_quick_convert_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let config = {
        let guard = state
            .config
            .lock()
            .map_err(|_| "config lock poisoned".to_owned())?;
        guard.clone()
    };
    show_quick_convert_window_with_seed(&app, &config.quick_convert_popup_position, None, None)
}

#[tauri::command]
pub fn hide_quick_convert_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("quick-convert") {
        window
            .hide()
            .map_err(|err| format!("hide quick convert window failed: {err}"))?;
    }
    Ok(())
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
    let previous = {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| "config lock poisoned".to_owned())?;
        let prior = guard.clone();
        *guard = clean.clone();
        prior
    };
    config::save_config_to_disk(&app, &clean)?;
    hotkey::register_hotkeys(&app, &clean)?;
    if warmup_languages_changed(&previous, &clean) {
        let _ = wait_for_sidecar_health(&app, "settings-change");
        schedule_language_warmup(
            app.clone(),
            state.client.clone(),
            clean.clone(),
            "settings-change",
        );
    }
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

    let mut background_snapshot_region = None;

    if let Some(mon) = &monitor {
        let size = mon.size();
        let _ = overlay.set_size(Size::Physical(PhysicalSize::new(size.width, size.height)));
        let pos = mon.position();
        let _ = overlay.set_position(Position::Physical(PhysicalPosition::new(pos.x, pos.y)));

        let monitor_right = pos
            .x
            .saturating_add(i32::try_from(size.width).unwrap_or(i32::MAX));
        let monitor_bottom = pos
            .y
            .saturating_add(i32::try_from(size.height).unwrap_or(i32::MAX));
        background_snapshot_region =
            ocr::normalize_region(pos.x, pos.y, monitor_right, monitor_bottom);
    }

    overlay
        .show()
        .map_err(|err| format!("show ocr overlay failed: {err}"))?;
    overlay
        .set_focus()
        .map_err(|err| format!("focus ocr overlay failed: {err}"))?;

    if let Some(full_monitor_region) = background_snapshot_region {
        let app_for_snapshot = app.clone();
        tauri::async_runtime::spawn(async move {
            let snapshot_result = tauri::async_runtime::spawn_blocking(move || {
                ocr::capture_region_png_base64(full_monitor_region)
            })
            .await;

            if let Ok(Ok(snapshot_base64)) = snapshot_result {
                let _ = app_for_snapshot.emit(
                    "ocr-overlay-background",
                    OcrOverlayBackgroundPayload {
                        image_base64: snapshot_base64,
                    },
                );
            }
        });
    }

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
pub fn toggle_settings_window(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_owned())?;

    let visible = main
        .is_visible()
        .map_err(|err| format!("read settings visibility failed: {err}"))?;

    if visible {
        main.hide()
            .map_err(|err| format!("hide settings window failed: {err}"))?;

        return Ok(());
    }

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

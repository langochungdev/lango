use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::automation;
use crate::bridge::{self, AppState, TranslatePayload};
use crate::config::AppConfig;
use crate::indicator;
use crate::selection;

const DEFAULT_POPOVER_SHORTCUT: &str = "Ctrl+Shift+D";
const DEFAULT_TRANSLATE_SHORTCUT: &str = "Shift";
const HOTKEY_CAPTURE_SETTLE_MS: u64 = 90;
const HOTKEY_RETRY_DELAY_MS: u64 = 120;
const HOTKEY_LOADING_MIN_MS: u64 = 170;
const HOTKEY_CAPTURE_MAX_ATTEMPTS: u8 = 4;

#[derive(Debug, Clone, Serialize)]
pub struct HotkeyTranslationEvent {
    pub original: String,
    pub translated: String,
    pub source: String,
    pub target: String,
    pub shortcut: String,
}

static LAST_TRANSLATION: OnceLock<Mutex<Option<(String, String)>>> = OnceLock::new();
static HOTKEY_TRANSLATE_SEQ: AtomicU64 = AtomicU64::new(0);
static HOTKEY_TRANSLATE_CANCELLED_SEQ: AtomicU64 = AtomicU64::new(0);

fn begin_hotkey_translate_request() -> u64 {
    HOTKEY_TRANSLATE_SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

fn is_hotkey_translate_cancelled(request_id: u64) -> bool {
    HOTKEY_TRANSLATE_CANCELLED_SEQ.load(Ordering::Relaxed) >= request_id
}

pub fn cancel_active_hotkey_translate() {
    let current = HOTKEY_TRANSLATE_SEQ.load(Ordering::Relaxed);
    HOTKEY_TRANSLATE_CANCELLED_SEQ.store(current, Ordering::Relaxed);
}

fn get_last_translation() -> Option<(String, String)> {
    LAST_TRANSLATION
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap()
        .clone()
}

fn set_last_translation(original: String, translated: String) {
    let mut guard = LAST_TRANSLATION
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap();
    *guard = Some((original, translated));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyAction {
    ShowPopover,
    TranslateReplace,
}

fn normalize_shortcut(shortcut: &str) -> String {
    shortcut
        .split('+')
        .map(|part| part.trim().to_ascii_lowercase())
        .collect::<Vec<String>>()
        .join("+")
}

fn is_valid_modifier(token: &str) -> bool {
    matches!(
        token.to_ascii_lowercase().as_str(),
        "ctrl" | "control" | "shift" | "alt" | "cmd" | "meta" | "cmdorctrl" | "commandorcontrol"
    )
}

fn is_valid_key_token(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if token.len() == 1 {
        return token.chars().all(|ch| ch.is_ascii_alphanumeric());
    }
    if let Some(rest) = token.strip_prefix('F') {
        return !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit());
    }
    matches!(
        token.to_ascii_lowercase().as_str(),
        "space" | "enter" | "tab"
    )
}

fn sanitize_translation_text(input: &str) -> String {
    let prepared = input
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("</p>", "\n")
        .replace("</div>", "\n")
        .replace("</li>", "\n");

    let mut stripped = String::with_capacity(prepared.len());
    let mut in_tag = false;
    for ch in prepared.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => stripped.push(ch),
            _ => {}
        }
    }

    stripped
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace('\r', "")
}

fn parse_hotkey_with_mode(shortcut: &str, allow_modifier_only: bool) -> Result<(), String> {
    let parts: Vec<&str> = shortcut
        .split('+')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("hotkey cannot be empty".to_owned());
    }

    let mut key_count = 0;
    for (index, token) in parts.iter().enumerate() {
        if is_valid_modifier(token) {
            continue;
        }
        if !is_valid_key_token(token) {
            return Err(format!("unsupported key: {token}"));
        }
        key_count += 1;
        if key_count > 1 {
            return Err("hotkey can only include one non-modifier key".to_owned());
        }
        if index != parts.len() - 1 {
            return Err("hotkey key token must be the last segment".to_owned());
        }
    }

    if key_count == 0 {
        if allow_modifier_only {
            if parts.len() == 1 && parts[0].eq_ignore_ascii_case("shift") {
                return Ok(());
            }
            return Err("only Shift modifier-only hotkey is supported".to_owned());
        }
        return Err("hotkey must include one non-modifier key".to_owned());
    }

    Ok(())
}

fn effective_shortcut(shortcut: &str, fallback: &str, allow_modifier_only: bool) -> String {
    let trimmed = shortcut.trim();
    let parsed = if allow_modifier_only {
        parse_hotkey_with_mode(trimmed, true)
    } else {
        parse_hotkey(trimmed)
    };
    if parsed.is_ok() {
        return trimmed.to_owned();
    }
    fallback.to_owned()
}

fn is_modifier_only_shortcut(shortcut: &str) -> bool {
    let parts: Vec<&str> = shortcut
        .split('+')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect();
    !parts.is_empty() && parts.iter().all(|part| is_valid_modifier(part))
}

pub fn parse_hotkey(shortcut: &str) -> Result<(), String> {
    parse_hotkey_with_mode(shortcut, false)
}

pub fn register_hotkeys(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let popover_shortcut =
        effective_shortcut(&config.popover_shortcut, DEFAULT_POPOVER_SHORTCUT, false);
    let translate_shortcut = effective_shortcut(
        &config.hotkey_translate_shortcut,
        DEFAULT_TRANSLATE_SHORTCUT,
        true,
    );
    let manager = app.global_shortcut();
    manager
        .unregister_all()
        .map_err(|err| format!("unregister hotkeys failed: {err}"))?;
    manager
        .register(popover_shortcut.as_str())
        .map_err(|err| format!("register popover shortcut failed: {err}"))?;

    if !is_modifier_only_shortcut(&translate_shortcut)
        && normalize_shortcut(&popover_shortcut) != normalize_shortcut(&translate_shortcut)
    {
        manager
            .register(translate_shortcut.as_str())
            .map_err(|err| format!("register translate shortcut failed: {err}"))?;
    }

    Ok(())
}

fn resolve_shortcut_action(config: &AppConfig, shortcut: &str) -> Option<HotkeyAction> {
    let incoming = normalize_shortcut(shortcut);
    let popover = normalize_shortcut(&effective_shortcut(
        &config.popover_shortcut,
        DEFAULT_POPOVER_SHORTCUT,
        false,
    ));
    let translate = normalize_shortcut(&effective_shortcut(
        &config.hotkey_translate_shortcut,
        DEFAULT_TRANSLATE_SHORTCUT,
        true,
    ));

    if popover == translate && incoming == translate {
        return Some(HotkeyAction::TranslateReplace);
    }
    if incoming == popover {
        return Some(HotkeyAction::ShowPopover);
    }
    if incoming == translate {
        return Some(HotkeyAction::TranslateReplace);
    }
    None
}

pub async fn handle_global_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let config = {
        let guard = state
            .config
            .lock()
            .map_err(|_| "config lock poisoned".to_owned())?;
        guard.clone()
    };

    let Some(action) = resolve_shortcut_action(&config, &shortcut) else {
        return Ok(());
    };

    match action {
        HotkeyAction::ShowPopover => on_popover_triggered(app).await,
        HotkeyAction::TranslateReplace => {
            on_translate_replace_triggered(app, config, shortcut).await
        }
    }
}

pub async fn handle_modifier_shortcut(app: AppHandle) -> Result<(), String> {
    if selection::is_any_app_window_focused(&app) {
        return Ok(());
    }

    let state = app.state::<AppState>();
    let config = {
        let guard = state
            .config
            .lock()
            .map_err(|_| "config lock poisoned".to_owned())?;
        guard.clone()
    };

    let translate = normalize_shortcut(&effective_shortcut(
        &config.hotkey_translate_shortcut,
        DEFAULT_TRANSLATE_SHORTCUT,
        true,
    ));
    if translate != "shift" {
        return Ok(());
    }

    on_translate_replace_triggered(app, config, "Shift".to_owned()).await
}

async fn capture_active_document_text_stable() -> Result<String, String> {
    for attempt in 0..HOTKEY_CAPTURE_MAX_ATTEMPTS {
        let wait_ms = HOTKEY_CAPTURE_SETTLE_MS + HOTKEY_RETRY_DELAY_MS * u64::from(attempt);
        let captured = tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(wait_ms));
            automation::capture_active_document_text()
        })
        .await
        .map_err(|err| format!("capture active document task failed: {err}"))??;

        if !captured.replace('\r', "").trim().is_empty() {
            return Ok(captured);
        }
    }

    let fallback = tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(Duration::from_millis(HOTKEY_RETRY_DELAY_MS));
        automation::capture_selection_text()
    })
    .await
    .map_err(|err| format!("capture selection fallback task failed: {err}"))??;

    Ok(fallback)
}

async fn replace_active_document_text_stable(replacement: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(HOTKEY_CAPTURE_SETTLE_MS));
        automation::replace_active_document_text(&replacement)
    })
    .await
    .map_err(|err| format!("replace text task failed: {err}"))??;
    Ok(())
}

async fn on_popover_triggered(app: AppHandle) -> Result<(), String> {
    if selection::is_any_app_window_focused(&app) {
        return Ok(());
    }

    let raw_text = tauri::async_runtime::spawn_blocking(automation::capture_selection_text)
        .await
        .map_err(|err| format!("capture selection task failed: {err}"))??;
    let selected = raw_text.replace('\r', "");
    if selected.trim().is_empty() {
        return Ok(());
    }

    let cursor = tauri::async_runtime::spawn_blocking(automation::cursor_position)
        .await
        .map_err(|err| format!("capture cursor task failed: {err}"))?;

    selection::show_popover_window(
        &app,
        selected.trim().to_owned(),
        "shortcut".to_owned(),
        cursor,
    )
}

async fn on_translate_replace_triggered(
    app: AppHandle,
    config: AppConfig,
    shortcut: String,
) -> Result<(), String> {
    let request_id = begin_hotkey_translate_request();

    let cursor = tauri::async_runtime::spawn_blocking(automation::cursor_position)
        .await
        .ok()
        .flatten();

    let started_at = Instant::now();

    let result = async {
        if is_hotkey_translate_cancelled(request_id) {
            return Ok::<Option<(String, String)>, String>(None);
        }

        let state = app.state::<AppState>();
        let original = capture_active_document_text_stable().await?;

        let source_text = original.replace('\r', "");
        if source_text.trim().is_empty() {
            return Ok::<Option<(String, String)>, String>(None);
        }

        if is_hotkey_translate_cancelled(request_id) {
            return Ok::<Option<(String, String)>, String>(None);
        }

        if let Some((last_orig, last_trans)) = get_last_translation() {
            if source_text == last_trans {
                if is_hotkey_translate_cancelled(request_id) {
                    return Ok::<Option<(String, String)>, String>(None);
                }
                replace_active_document_text_stable(last_orig.clone()).await?;
                return Ok(Some((last_trans, last_orig)));
            } else if source_text == last_orig {
                if is_hotkey_translate_cancelled(request_id) {
                    return Ok::<Option<(String, String)>, String>(None);
                }
                replace_active_document_text_stable(last_trans.clone()).await?;
                return Ok(Some((last_orig, last_trans)));
            }
        }

        let payload = TranslatePayload {
            text: source_text.clone(),
            source: config.quick_translate_source_language.clone(),
            target: config.quick_translate_target_language.clone(),
        };

        let _ = indicator::show_hotkey_indicator(&app, cursor);
        let response = bridge::translate_via_sidecar(&state.client, payload).await?;
        let _ = indicator::hide_hotkey_indicator(&app);

        if is_hotkey_translate_cancelled(request_id) {
            return Ok::<Option<(String, String)>, String>(None);
        }

        let translated = sanitize_translation_text(&response.result);
        if translated.trim().is_empty() {
            return Ok::<Option<(String, String)>, String>(None);
        }

        if is_hotkey_translate_cancelled(request_id) {
            return Ok::<Option<(String, String)>, String>(None);
        }

        replace_active_document_text_stable(translated.clone()).await?;
        set_last_translation(source_text.clone(), translated.clone());

        Ok(Some((source_text, translated)))
    }
    .await?;

    if let Some((orig, trans)) = result {
        let event = HotkeyTranslationEvent {
            original: orig,
            translated: trans,
            source: config.quick_translate_source_language,
            target: config.quick_translate_target_language,
            shortcut,
        };
        app.emit_to("main", "hotkey-translated", event)
            .map_err(|err| format!("emit hotkey event failed: {err}"))?;
    }

    let remaining =
        Duration::from_millis(HOTKEY_LOADING_MIN_MS).saturating_sub(started_at.elapsed());
    if !remaining.is_zero() {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(remaining);
        })
        .await;
    }
    let _ = indicator::hide_hotkey_indicator(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_hotkey, parse_hotkey_with_mode};

    #[test]
    fn test_hotkey_parse() {
        assert!(parse_hotkey("Ctrl+Shift+T").is_ok());
        assert!(parse_hotkey("Shift").is_err());
        assert!(parse_hotkey_with_mode("Shift", true).is_ok());
        assert!(parse_hotkey("invalid").is_err());
    }
}

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::automation;
use crate::bridge::{self, AppState, TranslatePayload};
use crate::config::AppConfig;
use crate::selection;

#[derive(Debug, Clone, Serialize)]
pub struct HotkeyTranslationEvent {
    pub original: String,
    pub translated: String,
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

pub fn parse_hotkey(shortcut: &str) -> Result<(), String> {
    let parts: Vec<&str> = shortcut
        .split('+')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 2 {
        return Err("hotkey must include at least one modifier and one key".to_owned());
    }
    for modifier in &parts[..parts.len() - 1] {
        if !is_valid_modifier(modifier) {
            return Err(format!("unsupported modifier: {modifier}"));
        }
    }
    let key = parts[parts.len() - 1];
    if !is_valid_key_token(key) {
        return Err(format!("unsupported key: {key}"));
    }
    Ok(())
}

pub fn register_hotkeys(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    parse_hotkey(&config.popover_shortcut)?;
    parse_hotkey(&config.hotkey_translate_shortcut)?;

    let popover_shortcut = config.popover_shortcut.trim();
    let translate_shortcut = config.hotkey_translate_shortcut.trim();
    let manager = app.global_shortcut();
    manager
        .unregister_all()
        .map_err(|err| format!("unregister hotkeys failed: {err}"))?;
    manager
        .register(popover_shortcut)
        .map_err(|err| format!("register popover shortcut failed: {err}"))?;

    if normalize_shortcut(popover_shortcut) != normalize_shortcut(translate_shortcut) {
        manager
            .register(translate_shortcut)
            .map_err(|err| format!("register translate shortcut failed: {err}"))?;
    }

    Ok(())
}

fn resolve_shortcut_action(config: &AppConfig, shortcut: &str) -> Option<HotkeyAction> {
    let incoming = normalize_shortcut(shortcut);
    let popover = normalize_shortcut(&config.popover_shortcut);
    let translate = normalize_shortcut(&config.hotkey_translate_shortcut);

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
        HotkeyAction::TranslateReplace => on_translate_replace_triggered(app, config).await,
    }
}

async fn on_popover_triggered(app: AppHandle) -> Result<(), String> {
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

async fn on_translate_replace_triggered(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let state = app.state::<AppState>();
    let original = tauri::async_runtime::spawn_blocking(automation::capture_active_document_text)
        .await
        .map_err(|err| format!("capture active document task failed: {err}"))??;

    let source_text = original.replace('\r', "");
    if source_text.trim().is_empty() {
        return Ok(());
    }

    let payload = TranslatePayload {
        text: source_text.clone(),
        source: config.quick_translate_source_language,
        target: config.quick_translate_target_language,
    };

    let response = bridge::translate_via_sidecar(&state.client, payload).await?;
    let translated = response.result.replace('\r', "");
    if translated.trim().is_empty() {
        return Ok(());
    }

    let replacement = translated.clone();
    tauri::async_runtime::spawn_blocking(move || {
        automation::replace_active_document_text(&replacement)
    })
    .await
    .map_err(|err| format!("replace text task failed: {err}"))??;

    let event = HotkeyTranslationEvent {
        original: source_text,
        translated,
    };
    app.emit_to("main", "hotkey-translated", event)
        .map_err(|err| format!("emit hotkey event failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::parse_hotkey;

    #[test]
    fn test_hotkey_parse() {
        assert!(parse_hotkey("Ctrl+Shift+T").is_ok());
        assert!(parse_hotkey("invalid").is_err());
    }
}

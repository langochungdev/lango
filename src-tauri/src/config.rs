use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub enable_lookup: bool,
    pub enable_translate: bool,
    pub enable_audio: bool,
    pub auto_play_audio_mode: String,
    pub popover_trigger_mode: String,
    pub popover_shortcut: String,
    pub source_language: String,
    pub target_language: String,
    pub quick_translate_source_language: String,
    pub quick_translate_target_language: String,
    pub max_definitions: u8,
    pub show_example: bool,
    pub popover_open_panel_mode: String,
    pub popover_definition_language_mode: String,
    pub hotkey_translate_shortcut: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            enable_lookup: true,
            enable_translate: true,
            enable_audio: true,
            auto_play_audio_mode: "word".to_owned(),
            popover_trigger_mode: "auto".to_owned(),
            popover_shortcut: "Ctrl+Shift+D".to_owned(),
            source_language: "auto".to_owned(),
            target_language: "en".to_owned(),
            quick_translate_source_language: "auto".to_owned(),
            quick_translate_target_language: "en".to_owned(),
            max_definitions: 3,
            show_example: true,
            popover_open_panel_mode: "details".to_owned(),
            popover_definition_language_mode: "output".to_owned(),
            hotkey_translate_shortcut: "Ctrl+Shift+T".to_owned(),
        }
    }
}

impl AppConfig {
    pub fn sanitize(self) -> Self {
        let mut next = self;
        next.max_definitions = next.max_definitions.clamp(1, 10);
        if next.auto_play_audio_mode.is_empty() {
            next.auto_play_audio_mode = "word".to_owned();
        }
        if next.popover_trigger_mode.is_empty() {
            next.popover_trigger_mode = "auto".to_owned();
        }
        if next.popover_shortcut.is_empty() {
            next.popover_shortcut = "Ctrl+Shift+D".to_owned();
        }
        if next.source_language.is_empty() {
            next.source_language = "auto".to_owned();
        }
        if next.target_language.is_empty() {
            next.target_language = "en".to_owned();
        }
        if next.quick_translate_source_language.is_empty() {
            next.quick_translate_source_language = "auto".to_owned();
        }
        if next.quick_translate_target_language.is_empty() {
            next.quick_translate_target_language = "en".to_owned();
        }
        if next.popover_open_panel_mode.is_empty() {
            next.popover_open_panel_mode = "details".to_owned();
        }
        if next.popover_definition_language_mode.is_empty() {
            next.popover_definition_language_mode = "output".to_owned();
        }
        if next.hotkey_translate_shortcut.is_empty() {
            next.hotkey_translate_shortcut = "Ctrl+Shift+T".to_owned();
        }
        next
    }
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("resolve config dir failed: {err}"))?;
    if !base.exists() {
        fs::create_dir_all(&base).map_err(|err| format!("create config dir failed: {err}"))?;
    }
    Ok(base.join("config.json"))
}

pub fn load_config_from_disk(app: &AppHandle) -> AppConfig {
    let Ok(path) = config_path(app) else {
        return AppConfig::default();
    };
    if !path.exists() {
        return AppConfig::default();
    }
    let Ok(content) = fs::read_to_string(path) else {
        return AppConfig::default();
    };
    let Ok(parsed) = serde_json::from_str::<AppConfig>(&content) else {
        return AppConfig::default();
    };
    parsed.sanitize()
}

pub fn save_config_to_disk(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|err| format!("serialize config failed: {err}"))?;
    fs::write(path, bytes).map_err(|err| format!("write config failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::AppConfig;

    #[test]
    fn test_config_roundtrip() {
        let cfg = AppConfig {
            target_language: "vi".to_owned(),
            ..Default::default()
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let loaded: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.target_language, "vi");
    }
}

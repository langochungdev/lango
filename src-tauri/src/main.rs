#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod automation;
mod bridge;
mod config;
mod hotkey;
mod indicator;
mod selection;

use reqwest::Client;
use tauri::Manager;
use tauri_plugin_global_shortcut::{Builder as GlobalShortcutBuilder, ShortcutState};

fn main() {
    tauri::Builder::default()
        .plugin(
            GlobalShortcutBuilder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let app_handle = app.clone();
                        let shortcut = _shortcut.to_string();
                        tauri::async_runtime::spawn(async move {
                            let _ = hotkey::handle_global_shortcut(app_handle, shortcut).await;
                        });
                    }
                })
                .build(),
        )
        .setup(|app| {
            let app_handle = app.handle().clone();
            let loaded = config::load_config_from_disk(&app_handle);
            let state = bridge::AppState {
                config: std::sync::Mutex::new(loaded.clone()),
                client: Client::new(),
            };
            app.manage(state);
            hotkey::register_hotkeys(&app_handle, &loaded)?;
            selection::start_selection_listener(app_handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::load_config,
            bridge::save_config,
            bridge::translate_text,
            bridge::lookup_dictionary,
            bridge::search_images,
            bridge::emit_selection_changed,
            bridge::hide_popover,
            bridge::take_pending_selection,
            bridge::show_settings_window,
            bridge::show_debug_window,
            bridge::resize_popover
        ])
        .run(tauri::generate_context!())
        .expect("error while running DictOver Desktop");
}

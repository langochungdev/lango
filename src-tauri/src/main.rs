#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod automation;
mod bridge;
mod config;
mod hotkey;
mod indicator;
mod ocr;
mod selection;

use reqwest::Client;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
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
            selection::install_popover_window_guards(&app_handle);
            selection::start_selection_listener(app_handle.clone());

            let quit_i = MenuItem::with_id(&app_handle, "quit", "Quit", true, None::<&str>)?;
            let settings_i =
                MenuItem::with_id(&app_handle, "settings", "Settings", true, None::<&str>)?;
            let menu = Menu::with_items(&app_handle, &[&settings_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app_handle.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "settings" => {
                        let _ = bridge::show_settings_window(app.clone());
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let _ = bridge::show_settings_window(tray.app_handle().clone());
                    }
                })
                .build(&app_handle)?;

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
            bridge::show_loading_indicator,
            bridge::show_ocr_overlay,
            bridge::hide_loading_indicator,
            bridge::cancel_ocr_overlay,
            bridge::cancel_popover_loading,
            bridge::submit_ocr_selection,
            bridge::take_pending_selection,
            bridge::show_settings_window,
            bridge::hide_settings_window,
            bridge::show_debug_window,
            bridge::copy_text_to_clipboard,
            bridge::resize_popover
        ])
        .run(tauri::generate_context!())
        .expect("error while running DictOver Desktop");
}

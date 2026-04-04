#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod automation;
mod bridge;
mod config;
mod debug_trace;
mod hotkey;
mod indicator;
mod ocr;
mod selection;
mod sidecar_runtime;

use reqwest::Client;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent};
use tauri_plugin_global_shortcut::{Builder as GlobalShortcutBuilder, ShortcutState};

const TRAY_TOGGLE_DEBOUNCE_MS: u64 = 220;
static LAST_TRAY_TOGGLE_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn allow_tray_toggle_now() -> bool {
    let gate = LAST_TRAY_TOGGLE_AT.get_or_init(|| Mutex::new(None));
    let now = Instant::now();

    let Ok(mut last_guard) = gate.lock() else {
        return true;
    };

    if let Some(last) = *last_guard {
        if now.duration_since(last) < Duration::from_millis(TRAY_TOGGLE_DEBOUNCE_MS) {
            return false;
        }
    }

    *last_guard = Some(now);
    true
}

fn main() {
    let app = tauri::Builder::default()
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
            let sidecar_process = sidecar_runtime::start_release_sidecar(&app_handle)?;
            sidecar_runtime::set_tracked_sidecar(sidecar_process);
            let state = bridge::AppState {
                config: std::sync::Mutex::new(loaded.clone()),
                client: Client::new(),
            };
            let warmup_client = state.client.clone();
            app.manage(state);
            app.manage(bridge::UpdateState::default());
            let _ = bridge::wait_for_sidecar_health(&app_handle, "startup");
            bridge::schedule_language_warmup(
                app_handle.clone(),
                warmup_client,
                loaded.clone(),
                "startup",
            );
            hotkey::register_hotkeys(&app_handle, &loaded)?;
            selection::install_popover_window_guards(&app_handle);
            selection::start_selection_listener(app_handle.clone());

            let app_for_update = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                bridge::check_for_updates_and_emit(app_for_update).await;
            });

            let quit_i = MenuItem::with_id(&app_handle, "quit", "Quit", true, None::<&str>)?;
            let settings_i =
                MenuItem::with_id(&app_handle, "settings", "Settings", true, None::<&str>)?;
            let menu = Menu::with_items(&app_handle, &[&settings_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app_handle.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "settings" => {
                        let _ = bridge::show_settings_window(app.clone());
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } = event
                    {
                        if button == MouseButton::Left && button_state == MouseButtonState::Up {
                            if allow_tray_toggle_now() {
                                let _ = bridge::toggle_settings_window(tray.app_handle().clone());
                            }
                        }
                    }
                })
                .build(&app_handle)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::load_config,
            bridge::get_pending_update,
            bridge::get_app_version,
            bridge::check_for_updates_now,
            bridge::save_config,
            bridge::translate_text,
            bridge::quick_convert_text,
            bridge::lookup_dictionary,
            bridge::search_images,
            bridge::emit_selection_changed,
            bridge::hide_popover,
            bridge::show_quick_convert_window,
            bridge::hide_quick_convert_window,
            bridge::show_loading_indicator,
            bridge::show_ocr_overlay,
            bridge::hide_loading_indicator,
            bridge::cancel_ocr_overlay,
            bridge::cancel_popover_loading,
            bridge::submit_ocr_selection,
            bridge::take_pending_selection,
            bridge::show_settings_window,
            bridge::toggle_settings_window,
            bridge::hide_settings_window,
            bridge::show_debug_window,
            bridge::open_external_url,
            bridge::copy_text_to_clipboard,
            bridge::copy_image_to_clipboard,
            bridge::resize_popover
        ])
        .build(tauri::generate_context!())
        .expect("error while building DictOver Desktop");

    app.run(|_, event| {
        if let RunEvent::Exit = event {
            sidecar_runtime::stop_tracked_sidecar();
        }
    });
}

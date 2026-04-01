use tauri::Manager;
pub fn check_hwnd(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("popover") {
        let h = w.hwnd().unwrap();
        println!("{:?}", h);
    }
}

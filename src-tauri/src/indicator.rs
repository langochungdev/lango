use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size};

const INDICATOR_WINDOW_LABEL: &str = "hotkey-indicator";

pub fn show_hotkey_indicator(app: &AppHandle, cursor: Option<(i32, i32)>) -> Result<(), String> {
    let Some(indicator) = app.get_webview_window(INDICATOR_WINDOW_LABEL) else {
        return Ok(());
    };

    let monitor = indicator
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    if let Some(mon) = &monitor {
        let size = mon.size();
        let _ = indicator.set_size(Size::Physical(PhysicalSize::new(size.width, size.height)));
        let pos = mon.position();
        let _ = indicator.set_position(Position::Physical(PhysicalPosition::new(pos.x, pos.y)));
    } else if let Some((x, y)) = cursor {
        let _ = indicator.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    }

    indicator
        .show()
        .map_err(|err| format!("show indicator window failed: {err}"))
}

pub fn hide_hotkey_indicator(app: &AppHandle) -> Result<(), String> {
    if let Some(indicator) = app.get_webview_window(INDICATOR_WINDOW_LABEL) {
        indicator
            .hide()
            .map_err(|err| format!("hide indicator window failed: {err}"))?;
    }
    Ok(())
}

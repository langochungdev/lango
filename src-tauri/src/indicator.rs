use tauri::{AppHandle, Manager, PhysicalPosition, Position};

const INDICATOR_WINDOW_LABEL: &str = "hotkey-indicator";

pub fn show_hotkey_indicator(app: &AppHandle, cursor: Option<(i32, i32)>) -> Result<(), String> {
    let Some(indicator) = app.get_webview_window(INDICATOR_WINDOW_LABEL) else {
        return Ok(());
    };

    if let Some((x, y)) = cursor {
        let positioned = resolve_indicator_position(app, &indicator, x, y);
        indicator
            .set_position(Position::Physical(positioned))
            .map_err(|err| format!("set indicator position failed: {err}"))?;
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

fn resolve_indicator_position(
    app: &AppHandle,
    indicator: &tauri::WebviewWindow,
    cursor_x: i32,
    cursor_y: i32,
) -> PhysicalPosition<i32> {
    let mut left = cursor_x.max(0) + 12;
    let mut top = cursor_y.max(0) + 18;

    let Ok(window_size) = indicator.outer_size() else {
        return PhysicalPosition::new(left, top);
    };

    let width = i32::try_from(window_size.width).unwrap_or(170);
    let height = i32::try_from(window_size.height).unwrap_or(56);

    let monitor = indicator
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return PhysicalPosition::new(left, top);
    };

    let margin = 10;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();

    let monitor_left = monitor_position.x;
    let monitor_top = monitor_position.y;
    let monitor_right = monitor_left + i32::try_from(monitor_size.width).unwrap_or(i32::MAX);
    let monitor_bottom = monitor_top + i32::try_from(monitor_size.height).unwrap_or(i32::MAX);

    let min_x = monitor_left + margin;
    let min_y = monitor_top + margin;
    let max_x = (monitor_right - width - margin).max(min_x);
    let max_y = (monitor_bottom - height - margin).max(min_y);

    left = left.clamp(min_x, max_x);
    top = top.clamp(min_y, max_y);

    PhysicalPosition::new(left, top)
}

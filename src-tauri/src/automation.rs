use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Mouse, Settings};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{thread, time::Duration};

const ACTION_DELAY_MS: u64 = 80;
const COPY_DELAY_MS: u64 = 120;

fn new_enigo() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|err| format!("create input controller failed: {err}"))
}

fn run_control_combo(enigo: &mut Enigo, key: Key) -> Result<(), String> {
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|err| format!("press control failed: {err}"))?;
    enigo
        .key(key, Direction::Click)
        .map_err(|err| format!("press key failed: {err}"))?;
    enigo
        .key(Key::Control, Direction::Release)
        .map_err(|err| format!("release control failed: {err}"))
}

fn restore_clipboard(clipboard: &mut Clipboard, previous: Option<String>) {
    if let Some(snapshot) = previous {
        let _ = clipboard.set_text(snapshot);
    } else {
        let _ = clipboard.set_text(String::new());
    }
}

fn clipboard_marker(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("__dictover_{prefix}_{nanos}__")
}

pub fn capture_selection_text() -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(|err| format!("open clipboard failed: {err}"))?;
    let previous = clipboard.get_text().ok();
    let marker = clipboard_marker("selection");
    let _ = clipboard.set_text(marker.clone());
    let mut enigo = new_enigo()?;

    run_control_combo(&mut enigo, Key::Unicode('c'))?;
    thread::sleep(Duration::from_millis(COPY_DELAY_MS));

    let selected = clipboard.get_text().unwrap_or_default();
    let resolved = if selected == marker {
        String::new()
    } else {
        selected
    };
    restore_clipboard(&mut clipboard, previous);
    Ok(resolved)
}

pub fn capture_active_document_text() -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(|err| format!("open clipboard failed: {err}"))?;
    let previous = clipboard.get_text().ok();
    let marker = clipboard_marker("document");
    let _ = clipboard.set_text(marker.clone());
    let mut enigo = new_enigo()?;

    run_control_combo(&mut enigo, Key::Unicode('a'))?;
    thread::sleep(Duration::from_millis(ACTION_DELAY_MS));
    run_control_combo(&mut enigo, Key::Unicode('c'))?;
    thread::sleep(Duration::from_millis(COPY_DELAY_MS));

    let selected = clipboard.get_text().unwrap_or_default();
    let resolved = if selected == marker {
        String::new()
    } else {
        selected
    };
    restore_clipboard(&mut clipboard, previous);
    Ok(resolved)
}

pub fn replace_active_document_text(replacement: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|err| format!("open clipboard failed: {err}"))?;
    let previous = clipboard.get_text().ok();
    clipboard
        .set_text(replacement.to_owned())
        .map_err(|err| format!("write clipboard failed: {err}"))?;

    let mut enigo = new_enigo()?;
    run_control_combo(&mut enigo, Key::Unicode('a'))?;
    thread::sleep(Duration::from_millis(ACTION_DELAY_MS));
    run_control_combo(&mut enigo, Key::Unicode('v'))?;
    thread::sleep(Duration::from_millis(ACTION_DELAY_MS));

    restore_clipboard(&mut clipboard, previous);
    Ok(())
}

pub fn press_enter_key() -> Result<(), String> {
    let mut enigo = new_enigo()?;
    enigo
        .key(Key::Return, Direction::Click)
        .map_err(|err| format!("press enter failed: {err}"))?;
    Ok(())
}

pub fn cursor_position() -> Option<(i32, i32)> {
    let enigo = new_enigo().ok()?;
    enigo.location().ok()
}

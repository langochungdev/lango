pub fn enabled() -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }

    match std::env::var("DICTOVER_ENABLE_DEBUG_TRACE") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        }
        Err(_) => false,
    }
}

import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type AppSettings,
} from "@/types/settings";
import { invokeWithFallback } from "@/services/tauri";

const LOCAL_KEY = "dictover-settings";

export async function loadSettings(): Promise<AppSettings> {
  let usedFallback = false;
  const loaded = await invokeWithFallback<Partial<AppSettings>>(
    "load_config",
    {},
    async () => {
      usedFallback = true;
      const raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) {
        return DEFAULT_SETTINGS;
      }
      return JSON.parse(raw) as Partial<AppSettings>;
    },
  );

  let clean = sanitizeSettings(loaded);
  if (usedFallback && clean.ocr_paragraph_display_mode === "image") {
    clean = {
      ...clean,
      ocr_paragraph_display_mode: "popover",
    };
  }
  localStorage.setItem(LOCAL_KEY, JSON.stringify(clean));
  return clean;
}

export async function saveSettings(
  settings: AppSettings,
): Promise<AppSettings> {
  const clean = sanitizeSettings(settings);
  const saved = await invokeWithFallback<AppSettings>(
    "save_config",
    { config: clean },
    async () => {
      return clean;
    },
  );
  const normalized = sanitizeSettings(saved);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(normalized));
  return normalized;
}

import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type AppSettings,
} from "@/types/settings";
import { invokeWithFallback } from "@/services/tauri";

const LOCAL_KEY = "dictover-settings";

export async function loadSettings(): Promise<AppSettings> {
  const loaded = await invokeWithFallback<Partial<AppSettings>>(
    "load_config",
    {},
    async () => {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) {
        return DEFAULT_SETTINGS;
      }
      return JSON.parse(raw) as Partial<AppSettings>;
    },
  );

  return sanitizeSettings(loaded);
}

export async function saveSettings(
  settings: AppSettings,
): Promise<AppSettings> {
  const clean = sanitizeSettings(settings);
  return invokeWithFallback<AppSettings>(
    "save_config",
    { config: clean },
    async () => {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(clean));
      return clean;
    },
  );
}

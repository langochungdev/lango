import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type AppSettings,
} from "@/types/settings";
import { invokeWithFallback } from "@/services/tauri";

const LOCAL_KEY = "dictover-settings";

function normalizeShortcutToken(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function migrateLegacyDefaultShortcuts(
  partial: Partial<AppSettings>,
): Partial<AppSettings> {
  const migrated = { ...partial };
  const popoverShortcut = normalizeShortcutToken(partial.popover_shortcut);
  const translateShortcut = normalizeShortcutToken(
    partial.hotkey_translate_shortcut,
  );

  const hasLegacyPopoverShortcut = popoverShortcut === "ctrl+shift+d";
  const hasLegacyTranslateShortcut = translateShortcut === "shift";
  const translateFeatureDisabled = partial.enable_hotkey_translate !== true;

  if (
    hasLegacyPopoverShortcut &&
    hasLegacyTranslateShortcut &&
    translateFeatureDisabled
  ) {
    migrated.popover_shortcut = DEFAULT_SETTINGS.popover_shortcut;
    migrated.hotkey_translate_shortcut =
      DEFAULT_SETTINGS.hotkey_translate_shortcut;
    return migrated;
  }

  if (hasLegacyPopoverShortcut && partial.enable_popover_hotkey !== false) {
    migrated.popover_shortcut = DEFAULT_SETTINGS.popover_shortcut;
  }

  return migrated;
}

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

  const migrated = migrateLegacyDefaultShortcuts(loaded);
  let clean = sanitizeSettings(migrated);
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

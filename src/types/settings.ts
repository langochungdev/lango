import type {
  InputLanguageCode,
  OutputLanguageCode,
} from "@/constants/languages";

export type AutoPlayAudioMode = "off" | "word" | "all";
export type PopoverTriggerMode = "auto" | "shortcut";
export type PopoverOpenPanelMode = "none" | "details" | "images";
export type PopoverDefinitionLanguageMode = "output" | "input" | "english";

export interface AppSettings {
  enable_lookup: boolean;
  enable_translate: boolean;
  enable_audio: boolean;
  auto_play_audio_mode: AutoPlayAudioMode;
  popover_trigger_mode: PopoverTriggerMode;
  popover_shortcut: string;
  source_language: InputLanguageCode;
  target_language: OutputLanguageCode;
  quick_translate_source_language: InputLanguageCode;
  quick_translate_target_language: OutputLanguageCode;
  max_definitions: number;
  show_example: boolean;
  popover_open_panel_mode: PopoverOpenPanelMode;
  popover_definition_language_mode: PopoverDefinitionLanguageMode;
  hotkey_translate_shortcut: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  enable_lookup: true,
  enable_translate: true,
  enable_audio: true,
  auto_play_audio_mode: "word",
  popover_trigger_mode: "auto",
  popover_shortcut: "Ctrl+Shift+D",
  source_language: "auto",
  target_language: "en",
  quick_translate_source_language: "auto",
  quick_translate_target_language: "en",
  max_definitions: 3,
  show_example: true,
  popover_open_panel_mode: "details",
  popover_definition_language_mode: "output",
  hotkey_translate_shortcut: "Ctrl+Shift+T",
};

export function sanitizeSettings(partial: Partial<AppSettings>): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...partial };
  const maxDefinitions = Number.isFinite(merged.max_definitions)
    ? Math.max(1, Math.min(10, Math.round(merged.max_definitions)))
    : DEFAULT_SETTINGS.max_definitions;

  const popoverShortcut =
    merged.popover_shortcut.trim() || DEFAULT_SETTINGS.popover_shortcut;
  const hotkeyTranslateShortcut =
    merged.hotkey_translate_shortcut.trim() ||
    DEFAULT_SETTINGS.hotkey_translate_shortcut;
  const audioMode =
    merged.auto_play_audio_mode || DEFAULT_SETTINGS.auto_play_audio_mode;
  const triggerMode =
    merged.popover_trigger_mode || DEFAULT_SETTINGS.popover_trigger_mode;
  const panelMode =
    merged.popover_open_panel_mode || DEFAULT_SETTINGS.popover_open_panel_mode;
  const languageMode =
    merged.popover_definition_language_mode ||
    DEFAULT_SETTINGS.popover_definition_language_mode;
  const sourceLanguage =
    merged.source_language || DEFAULT_SETTINGS.source_language;
  const targetLanguage =
    merged.target_language || DEFAULT_SETTINGS.target_language;
  const quickTranslateSourceLanguage =
    merged.quick_translate_source_language ||
    DEFAULT_SETTINGS.quick_translate_source_language;
  const quickTranslateTargetLanguage =
    merged.quick_translate_target_language ||
    DEFAULT_SETTINGS.quick_translate_target_language;

  return {
    ...merged,
    auto_play_audio_mode: audioMode,
    popover_trigger_mode: triggerMode,
    popover_shortcut: popoverShortcut,
    source_language: sourceLanguage,
    target_language: targetLanguage,
    quick_translate_source_language: quickTranslateSourceLanguage,
    quick_translate_target_language: quickTranslateTargetLanguage,
    max_definitions: maxDefinitions,
    popover_open_panel_mode: panelMode,
    popover_definition_language_mode: languageMode,
    hotkey_translate_shortcut: hotkeyTranslateShortcut,
  };
}

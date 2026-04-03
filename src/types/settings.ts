import type {
  InputLanguageCode,
  OutputLanguageCode,
} from "@/constants/languages";

export type AutoPlayAudioMode = "off" | "word" | "all";
export type PopoverTriggerMode = "auto" | "shortcut";
export type PopoverOpenPanelMode = "none" | "details" | "images";
export type PopoverDefinitionLanguageMode = "output" | "input" | "english";
export type OcrParagraphDisplayMode = "image" | "popover";

export interface AppSettings {
  enable_lookup: boolean;
  enable_translate: boolean;
  enable_audio: boolean;
  enable_ocr: boolean;
  auto_play_audio_mode: AutoPlayAudioMode;
  popover_trigger_mode: PopoverTriggerMode;
  popover_shortcut: string;
  ocr_hotkey: string;
  source_language: InputLanguageCode;
  target_language: OutputLanguageCode;
  quick_translate_source_language: InputLanguageCode;
  quick_translate_target_language: OutputLanguageCode;
  max_definitions: number;
  show_example: boolean;
  popover_open_panel_mode: PopoverOpenPanelMode;
  popover_definition_language_mode: PopoverDefinitionLanguageMode;
  hotkey_translate_shortcut: string;
  enable_hotkey_translate: boolean;
  hotkey_translate_ctrl_enter_send: boolean;
  ocr_paragraph_display_mode: OcrParagraphDisplayMode;
}

function isValidModifier(token: string): boolean {
  const value = token.toLowerCase();
  return (
    value === "ctrl" ||
    value === "control" ||
    value === "shift" ||
    value === "alt" ||
    value === "cmd" ||
    value === "meta" ||
    value === "cmdorctrl" ||
    value === "commandorcontrol"
  );
}

function isValidKeyToken(token: string): boolean {
  if (!token) {
    return false;
  }
  if (token.length === 1) {
    return /^[a-z0-9]$/i.test(token);
  }
  if (/^f\d+$/i.test(token)) {
    return true;
  }
  const value = token.toLowerCase();
  return value === "space" || value === "enter" || value === "tab";
}

function sanitizeShortcut(
  raw: string,
  fallback: string,
  allowModifierOnly: boolean,
): string {
  const parts = raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return fallback;
  }

  let keyCount = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (isValidModifier(token)) {
      continue;
    }
    if (!isValidKeyToken(token)) {
      return fallback;
    }
    keyCount += 1;
    if (keyCount > 1 || index !== parts.length - 1) {
      return fallback;
    }
  }

  if (
    keyCount === 0 &&
    allowModifierOnly &&
    parts.length === 1 &&
    parts[0].toLowerCase() === "shift"
  ) {
    return "Shift";
  }

  if (keyCount !== 1) {
    return fallback;
  }

  return parts.join("+");
}

export const DEFAULT_SETTINGS: AppSettings = {
  enable_lookup: true,
  enable_translate: true,
  enable_audio: true,
  enable_ocr: true,
  auto_play_audio_mode: "off",
  popover_trigger_mode: "shortcut",
  popover_shortcut: "Ctrl+Shift+D",
  ocr_hotkey: "Alt+A",
  source_language: "en",
  target_language: "vi",
  quick_translate_source_language: "vi",
  quick_translate_target_language: "en",
  max_definitions: 3,
  show_example: true,
  popover_open_panel_mode: "none",
  popover_definition_language_mode: "output",
  hotkey_translate_shortcut: "Shift",
  enable_hotkey_translate: true,
  hotkey_translate_ctrl_enter_send: false,
  ocr_paragraph_display_mode: "popover",
};

const INPUT_LANGUAGE_VALUES: ReadonlyArray<InputLanguageCode> = [
  "auto",
  "vi",
  "en",
  "zh-CN",
  "ja",
  "ko",
  "ru",
  "de",
  "fr",
  "fi",
];

const OUTPUT_LANGUAGE_VALUES: ReadonlyArray<OutputLanguageCode> = [
  "vi",
  "en",
  "zh-CN",
  "ja",
  "ko",
  "ru",
  "de",
  "fr",
  "fi",
];

function isInputLanguageCode(value: string): value is InputLanguageCode {
  return INPUT_LANGUAGE_VALUES.includes(value as InputLanguageCode);
}

function isOutputLanguageCode(value: string): value is OutputLanguageCode {
  return OUTPUT_LANGUAGE_VALUES.includes(value as OutputLanguageCode);
}

export function sanitizeSettings(partial: Partial<AppSettings>): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...partial };
  const maxDefinitions = Number.isFinite(merged.max_definitions)
    ? Math.max(1, Math.min(10, Math.round(merged.max_definitions)))
    : DEFAULT_SETTINGS.max_definitions;

  const popoverShortcut = sanitizeShortcut(
    merged.popover_shortcut,
    DEFAULT_SETTINGS.popover_shortcut,
    false,
  );
  const ocrHotkey = sanitizeShortcut(
    merged.ocr_hotkey,
    DEFAULT_SETTINGS.ocr_hotkey,
    false,
  );
  const hotkeyTranslateShortcut = sanitizeShortcut(
    merged.hotkey_translate_shortcut,
    DEFAULT_SETTINGS.hotkey_translate_shortcut,
    true,
  );
  const audioMode =
    merged.auto_play_audio_mode === "word" ||
    merged.auto_play_audio_mode === "all" ||
    merged.auto_play_audio_mode === "off"
      ? merged.auto_play_audio_mode
      : DEFAULT_SETTINGS.auto_play_audio_mode;
  const triggerMode =
    merged.popover_trigger_mode === "auto" ||
    merged.popover_trigger_mode === "shortcut"
      ? merged.popover_trigger_mode
      : DEFAULT_SETTINGS.popover_trigger_mode;
  const panelMode =
    merged.popover_open_panel_mode === "details" ||
    merged.popover_open_panel_mode === "images" ||
    merged.popover_open_panel_mode === "none"
      ? merged.popover_open_panel_mode
      : DEFAULT_SETTINGS.popover_open_panel_mode;
  const languageMode =
    merged.popover_definition_language_mode === "input" ||
    merged.popover_definition_language_mode === "english" ||
    merged.popover_definition_language_mode === "output"
      ? merged.popover_definition_language_mode
      : DEFAULT_SETTINGS.popover_definition_language_mode;
  const ocrParagraphDisplayMode =
    merged.ocr_paragraph_display_mode === "popover" ||
    merged.ocr_paragraph_display_mode === "image"
      ? merged.ocr_paragraph_display_mode
      : DEFAULT_SETTINGS.ocr_paragraph_display_mode;
  const sourceLanguage =
    typeof merged.source_language === "string" &&
    isInputLanguageCode(merged.source_language)
      ? merged.source_language
      : DEFAULT_SETTINGS.source_language;
  const targetLanguage =
    typeof merged.target_language === "string" &&
    isOutputLanguageCode(merged.target_language)
      ? merged.target_language
      : DEFAULT_SETTINGS.target_language;
  const quickTranslateSourceLanguage =
    typeof merged.quick_translate_source_language === "string" &&
    isInputLanguageCode(merged.quick_translate_source_language)
      ? merged.quick_translate_source_language
      : DEFAULT_SETTINGS.quick_translate_source_language;
  const quickTranslateTargetLanguage =
    typeof merged.quick_translate_target_language === "string" &&
    isOutputLanguageCode(merged.quick_translate_target_language)
      ? merged.quick_translate_target_language
      : DEFAULT_SETTINGS.quick_translate_target_language;

  return {
    ...merged,
    enable_lookup: merged.enable_lookup !== false,
    enable_translate: merged.enable_translate !== false,
    enable_audio: merged.enable_audio !== false,
    enable_ocr: merged.enable_ocr !== false,
    show_example: merged.show_example !== false,
    auto_play_audio_mode: audioMode,
    popover_trigger_mode: triggerMode,
    popover_shortcut: popoverShortcut,
    ocr_hotkey: ocrHotkey,
    source_language: sourceLanguage,
    target_language: targetLanguage,
    quick_translate_source_language: quickTranslateSourceLanguage,
    quick_translate_target_language: quickTranslateTargetLanguage,
    max_definitions: maxDefinitions,
    popover_open_panel_mode: panelMode,
    popover_definition_language_mode: languageMode,
    hotkey_translate_shortcut: hotkeyTranslateShortcut,
    enable_hotkey_translate: merged.enable_hotkey_translate !== false,
    hotkey_translate_ctrl_enter_send:
      merged.hotkey_translate_ctrl_enter_send === true,
    ocr_paragraph_display_mode: ocrParagraphDisplayMode,
  };
}

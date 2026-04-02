import type { OutputLanguageCode } from "@/constants/languages";

export interface SettingsCopy {
  title: string;
  subtitle: string;
  ready: string;
  usingDefaults: string;
  saving: string;
  saved: string;
  autoSaved: string;
  saveFailed: string;
  hotkeyTranslated: string;
  close: string;
  features: string;
  enableLookup: string;
  enableTranslate: string;
  enableAudio: string;
  showExample: string;
  popoverTranslation: string;
  inputLanguage: string;
  outputLanguage: string;
  maxDefinitions: string;
  definitionLanguageMode: string;
  popoverTriggerAndPanel: string;
  popoverTrigger: string;
  popoverShortcut: string;
  ocrShortcut: string;
  enableOcr: string;
  ocrLanguageHint: string;
  panelMode: string;
  autoPlayAudio: string;
  triggerAuto: string;
  triggerShortcut: string;
  panelNone: string;
  panelDetails: string;
  panelImages: string;
  audioOff: string;
  audioWord: string;
  audioAll: string;
  quickTranslateInField: string;
  quickTranslateShortcut: string;
  quickInputLanguage: string;
  quickOutputLanguage: string;
  quickCtrlEnterTranslateSend: string;
  shortcutPlaceholder: string;
  quickOutputSyncedHint: string;
  modeOutput: string;
  modeInput: string;
  modeEnglish: string;
  popoverSectionTitle: string;
  convertSectionTitle: string;
  shortcutHint: string;
  swapLanguages: string;
}

const EN_COPY: SettingsCopy = {
  title: "Settings",
  subtitle:
    "Main window is for configuration only. Popover and hotkeys run globally via native backend.",
  ready: "Ready",
  usingDefaults: "Using default settings",
  saving: "Saving settings...",
  saved: "Settings saved",
  autoSaved: "Settings auto-saved",
  saveFailed: "Failed to save settings",
  hotkeyTranslated: "Global translate shortcut replaced active text",
  close: "Close",
  features: "Features",
  enableLookup: "Enable Lookup",
  enableTranslate: "Enable Translate",
  enableAudio: "Enable Audio",
  showExample: "Show Example",
  popoverTranslation: "Popover Translation",
  inputLanguage: "Input Language",
  outputLanguage: "Output Language",
  maxDefinitions: "Max Definitions",
  definitionLanguageMode: "Definition Language Mode",
  popoverTriggerAndPanel: "Popover Trigger And Panel",
  popoverTrigger: "Popover Trigger",
  popoverShortcut: "Popover Shortcut",
  ocrShortcut: "OCR Shortcut",
  enableOcr: "Enable OCR Capture",
  ocrLanguageHint:
    "OCR uses Popover input/output language directly. Hotkey works globally when focus is outside Dictover windows.",
  panelMode: "Open Panel Mode",
  autoPlayAudio: "Auto Play Audio",
  triggerAuto: "Auto",
  triggerShortcut: "Shortcut",
  panelNone: "None",
  panelDetails: "Details",
  panelImages: "Images",
  audioOff: "Off",
  audioWord: "Word",
  audioAll: "All",
  quickTranslateInField: "Quick Translate In Field",
  quickTranslateShortcut: "Quick Translate Shortcut",
  quickInputLanguage: "Quick Input Language",
  quickOutputLanguage: "Quick Output Language",
  quickCtrlEnterTranslateSend: "Ctrl+Enter: translate then send",
  shortcutPlaceholder: "Focus then press keys",
  quickOutputSyncedHint: "(independent from popover output)",
  modeOutput: "Output",
  modeInput: "Input",
  modeEnglish: "English",
  popoverSectionTitle: "Popover Settings",
  convertSectionTitle: "Convert Text Settings",
  shortcutHint:
    "Select this field then press a key combination, for example: Shift, Alt+1, Ctrl+Shift+L.",
  swapLanguages: "Swap input and output language",
};

const VI_COPY: SettingsCopy = {
  title: "Cài đặt",
  subtitle:
    "Cửa sổ chính dùng để cấu hình. Popover và hotkey chạy toàn hệ thống qua backend native.",
  ready: "Sẵn sàng",
  usingDefaults: "Đang dùng cấu hình mặc định",
  saving: "Đang lưu cài đặt...",
  saved: "Đã lưu cài đặt",
  autoSaved: "Đã tự động lưu cài đặt",
  saveFailed: "Lưu cài đặt thất bại",
  hotkeyTranslated: "Phím tắt dịch nhanh đã thay thế nội dung đang chọn",
  close: "Đóng",
  features: "Tính năng",
  enableLookup: "Bật tra từ điển",
  enableTranslate: "Bật dịch",
  enableAudio: "Bật âm thanh",
  showExample: "Hiện ví dụ",
  popoverTranslation: "Dịch trong Popover",
  inputLanguage: "Ngôn ngữ đầu vào",
  outputLanguage: "Ngôn ngữ đầu ra",
  maxDefinitions: "Số nghĩa tối đa",
  definitionLanguageMode: "Ngôn ngữ hiển thị nghĩa",
  popoverTriggerAndPanel: "Kích hoạt Popover và Panel",
  popoverTrigger: "Cách mở Popover",
  popoverShortcut: "Phím tắt Popover",
  ocrShortcut: "Phím tắt OCR",
  enableOcr: "Bật OCR từ vùng ảnh",
  ocrLanguageHint:
    "OCR dùng trực tiếp ngôn ngữ vào/ra của Popover. Phím tắt hoạt động toàn cục khi focus nằm ngoài cửa sổ Dictover.",
  panelMode: "Chế độ panel mở",
  autoPlayAudio: "Tự phát âm thanh",
  triggerAuto: "Tự động",
  triggerShortcut: "Phím tắt",
  panelNone: "Không mở",
  panelDetails: "Chi tiết",
  panelImages: "Hình ảnh",
  audioOff: "Tắt",
  audioWord: "Từ đơn",
  audioAll: "Từ và câu",
  quickTranslateInField: "Dịch nhanh trong ô nhập",
  quickTranslateShortcut: "Phím tắt dịch nhanh",
  quickInputLanguage: "Ngôn ngữ vào nhanh",
  quickOutputLanguage: "Ngôn ngữ ra nhanh",
  quickCtrlEnterTranslateSend: "Ctrl+Enter: dịch rồi gửi",
  shortcutPlaceholder: "Focus rồi bấm phím",
  quickOutputSyncedHint: "(độc lập với output popover)",
  modeOutput: "Theo đầu ra",
  modeInput: "Theo đầu vào",
  modeEnglish: "Tiếng Anh",
  popoverSectionTitle: "Cài đặt Popover",
  convertSectionTitle: "Cài đặt Convert Text",
  shortcutHint:
    "Chọn ô phím tắt rồi nhấn trực tiếp phím hoặc tổ hợp phím, ví dụ: Shift, Alt+1, Ctrl+Shift+L.",
  swapLanguages: "Đổi qua lại ngôn ngữ đầu vào và đầu ra",
};

export function getSettingsCopy(
  outputLanguage: OutputLanguageCode,
): SettingsCopy {
  if (String(outputLanguage).toLowerCase().startsWith("vi")) {
    return VI_COPY;
  }
  return EN_COPY;
}

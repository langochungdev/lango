export const INPUT_LANGUAGES = [
  { code: "vi", label: "Vietnamese" },
  { code: "auto", label: "Auto Detect" },
  { code: "en", label: "English" },
  { code: "zh-CN", label: "Chinese (Simplified)" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "ru", label: "Russian" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "fi", label: "Finnish" },
] as const;

export const OUTPUT_LANGUAGES = INPUT_LANGUAGES.filter(
  (item) => item.code !== "auto",
);

export type InputLanguageCode = (typeof INPUT_LANGUAGES)[number]["code"];
export type OutputLanguageCode = (typeof OUTPUT_LANGUAGES)[number]["code"];

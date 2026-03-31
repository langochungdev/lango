// Các hàm tiện ích xử lý text và audio cho Popover
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sanitizeMarkup(value: string): string {
  const withBreaks = value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n");

  const withoutTags = withBreaks.replace(/<[^>]+>/g, " ");

  if (typeof document === "undefined") {
    return withoutTags;
  }

  const element = document.createElement("textarea");
  element.innerHTML = withoutTags;
  return element.value;
}

export function normalizePhonetic(value: string): string {
  const clean = normalizeText(sanitizeMarkup(value || ""));
  if (!clean) {
    return "";
  }
  return clean.replace(/^[/\[\s]+|[/\]\s]+$/g, "").trim();
}

export function normalizeImageQuery(value: string): string {
  const compact = normalizeText(value);
  if (!compact) {
    return "";
  }
  return compact.split(" ").slice(0, 8).join(" ").slice(0, 80).trim();
}

export function buildAlternativeAudioUrl(audioUrl: string): string {
  const url = String(audioUrl || "").trim();
  if (!url) {
    return "";
  }

  if (url.includes("translate.googleapis.com/translate_tts")) {
    return url
      .replace(
        "translate.googleapis.com/translate_tts",
        "translate.google.com/translate_tts",
      )
      .replace("client=gtx", "client=tw-ob");
  }

  if (url.includes("translate.google.com/translate_tts")) {
    return url
      .replace(
        "translate.google.com/translate_tts",
        "translate.googleapis.com/translate_tts",
      )
      .replace("client=tw-ob", "client=gtx");
  }

  return "";
}

import type { DictionaryResult } from "@/services/dictionary";
import type { PopoverState } from "@/hooks/usePopover";

export function lookupPrimary(dictionary: DictionaryResult) {
  const firstMeaning = dictionary.meanings[0];
  const partOfSpeech = normalizeText(
    sanitizeMarkup(firstMeaning?.part_of_speech || ""),
  );
  const firstDefinition = normalizeText(
    sanitizeMarkup(firstMeaning?.definitions?.[0] || ""),
  );
  return { partOfSpeech, firstDefinition };
}

export function resolveImageQuery(
  state: PopoverState,
  selection: string,
  dictionary: DictionaryResult | null,
): string {
  if (state === "lookup") {
    return normalizeImageQuery(dictionary?.word || selection);
  }
  return normalizeImageQuery(selection);
}

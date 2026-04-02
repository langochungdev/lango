import { useCallback, useRef, useState } from "react";
import { lookupDictionary, type DictionaryResult } from "@/services/dictionary";
import { translateText, type TranslateResult } from "@/services/translate";
import type { AppSettings } from "@/types/settings";

export type PopoverState =
  | "idle"
  | "loading"
  | "lookup"
  | "translate"
  | "ocrImage"
  | "error";
export type PopoverTrigger = "auto" | "shortcut" | "ocr" | "ocr-image-overlay";

export interface OcrImageOverlayData {
  imageBase64: string;
  text: string;
}

export interface PopoverData {
  selectedText: string;
  trigger: PopoverTrigger;
  lookupDisplayWord: string | null;
  lookupDisplayDefinition: string | null;
  dictionary: DictionaryResult | null;
  translation: TranslateResult | null;
  ocrImageOverlay: OcrImageOverlayData | null;
}

const EMPTY_DATA: PopoverData = {
  selectedText: "",
  trigger: "auto",
  lookupDisplayWord: null,
  lookupDisplayDefinition: null,
  dictionary: null,
  translation: null,
  ocrImageOverlay: null,
};

function normalizeSingleLineText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

const SENTENCE_PUNCTUATION_PATTERN = /[.!?;:。,、！？；：]/u;

function getFirstDefinition(dictionary: DictionaryResult): string {
  for (const meaning of dictionary.meanings) {
    for (const definition of meaning.definitions) {
      const normalized = normalizeSingleLineText(definition);
      if (normalized) {
        return normalized;
      }
    }
  }
  return "";
}

function resolveDefinitionLanguage(
  settings: AppSettings,
  lookupSourceLanguage: string,
): string {
  if (settings.popover_definition_language_mode === "english") {
    return "en";
  }
  if (settings.popover_definition_language_mode === "output") {
    return settings.target_language;
  }
  if (settings.source_language === "auto") {
    return lookupSourceLanguage;
  }
  return settings.source_language;
}

function countWords(input: string): number {
  const words = input.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function countNonWhitespaceChars(input: string): number {
  return Array.from(input).reduce((count, char) => {
    if (char.trim()) {
      return count + 1;
    }
    return count;
  }, 0);
}

function isCjkChar(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (typeof codePoint !== "number") {
    return false;
  }

  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
}

function shouldTranslateText(input: string): boolean {
  const normalized = input.trim();
  if (!normalized) {
    return false;
  }

  if (countWords(normalized) > 1) {
    return true;
  }

  const charCount = countNonWhitespaceChars(normalized);
  if (charCount >= 24) {
    return true;
  }

  const cjkCount = Array.from(normalized).filter((char) =>
    isCjkChar(char),
  ).length;
  if (cjkCount >= 6) {
    return true;
  }

  return SENTENCE_PUNCTUATION_PATTERN.test(normalized) && charCount >= 8;
}

export function getActionType(input: string): "lookup" | "translate" {
  return shouldTranslateText(input) ? "translate" : "lookup";
}

export function usePopover(settings: AppSettings) {
  const [state, setState] = useState<PopoverState>("idle");
  const [data, setData] = useState<PopoverData>(EMPTY_DATA);
  const [error, setError] = useState<string | null>(null);
  const activeRequestIdRef = useRef(0);

  const close = useCallback(() => {
    activeRequestIdRef.current += 1;
    setState("idle");
    setData(EMPTY_DATA);
    setError(null);
  }, []);

  const openFromSelection = useCallback(
    async (rawText: string, trigger: PopoverTrigger) => {
      const selectedText = rawText.replace(/\s+/g, " ").trim();
      if (!selectedText) {
        close();
        return;
      }
      if (settings.popover_trigger_mode === "shortcut" && trigger === "auto") {
        return;
      }

      const requestId = activeRequestIdRef.current + 1;
      activeRequestIdRef.current = requestId;
      setState("loading");
      setError(null);
      const nextData: PopoverData = {
        selectedText,
        trigger,
        lookupDisplayWord: null,
        lookupDisplayDefinition: null,
        dictionary: null,
        translation: null,
        ocrImageOverlay: null,
      };

      const shouldDiscardResult = () =>
        activeRequestIdRef.current !== requestId;

      const runTranslate = async () => {
        const translation = await translateText({
          text: selectedText,
          source: settings.source_language,
          target: settings.target_language,
        });
        if (shouldDiscardResult()) {
          return;
        }
        nextData.translation = translation;
        setData(nextData);
        setState("translate");
      };

      try {
        const actionType = getActionType(selectedText);
        if (actionType === "lookup" && settings.enable_lookup) {
          const source =
            settings.source_language === "auto"
              ? "en"
              : settings.source_language;
          try {
            const dictionary = await lookupDictionary({
              word: selectedText,
              source_lang: source,
            });

            if (shouldDiscardResult()) {
              return;
            }

            if (
              Array.isArray(dictionary.meanings) &&
              dictionary.meanings.length > 0
            ) {
              const limitedDictionary: DictionaryResult = {
                ...dictionary,
                meanings: dictionary.meanings.slice(
                  0,
                  settings.max_definitions,
                ),
              };

              const definitionLanguage = resolveDefinitionLanguage(
                settings,
                source,
              );
              nextData.dictionary = limitedDictionary;

              const firstDefinition = getFirstDefinition(limitedDictionary);
              if (firstDefinition) {
                if (definitionLanguage !== source) {
                  try {
                    const translatedDefinition = await translateText({
                      text: firstDefinition,
                      source,
                      target: definitionLanguage,
                    });
                    nextData.lookupDisplayDefinition =
                      normalizeSingleLineText(translatedDefinition.result) ||
                      firstDefinition;
                  } catch {
                    nextData.lookupDisplayDefinition = firstDefinition;
                  }
                } else {
                  nextData.lookupDisplayDefinition = firstDefinition;
                }
              }

              if (settings.target_language !== source) {
                try {
                  const lookupDisplayWord = await translateText({
                    text: selectedText,
                    source,
                    target: settings.target_language,
                  });
                  nextData.lookupDisplayWord = normalizeSingleLineText(
                    lookupDisplayWord.result,
                  );
                } catch {
                  nextData.lookupDisplayWord =
                    nextData.dictionary.word || selectedText;
                }
              }

              if (!nextData.lookupDisplayWord) {
                nextData.lookupDisplayWord =
                  nextData.dictionary.word || selectedText;
              }

              if (shouldDiscardResult()) {
                return;
              }

              setData(nextData);
              setState("lookup");
              return;
            }

            if (settings.enable_translate) {
              await runTranslate();
              return;
            }

            setData(nextData);
            setError("No dictionary result for this text");
            setState("error");
            return;
          } catch {
            if (settings.enable_translate) {
              await runTranslate();
              return;
            }
            throw new Error("Dictionary lookup failed");
          }
        }

        if (settings.enable_translate) {
          await runTranslate();
          return;
        }

        if (shouldDiscardResult()) {
          return;
        }

        setData(nextData);
        setState("idle");
      } catch (cause) {
        if (shouldDiscardResult()) {
          return;
        }
        const message =
          cause instanceof Error ? cause.message : "Popover request failed";
        setData(nextData);
        setError(message);
        setState("error");
      }
    },
    [close, settings],
  );

  const openOcrImageOverlay = useCallback(
    (imageBase64: string, text: string) => {
      const imagePayload = imageBase64.trim();
      if (!imagePayload) {
        close();
        return;
      }

      activeRequestIdRef.current += 1;
      const selectedText = text.replace(/\s+/g, " ").trim();
      setError(null);
      setData({
        selectedText,
        trigger: "ocr-image-overlay",
        lookupDisplayWord: null,
        lookupDisplayDefinition: null,
        dictionary: null,
        translation: null,
        ocrImageOverlay: {
          imageBase64: imagePayload,
          text: selectedText,
        },
      });
      setState("ocrImage");
    },
    [close],
  );

  return {
    state,
    data,
    error,
    close,
    openFromSelection,
    openOcrImageOverlay,
  };
}

import { useCallback, useRef, useState } from "react";
import { lookupDictionary, type DictionaryResult } from "@/services/dictionary";
import { translateText, type TranslateResult } from "@/services/translate";
import type { AppSettings } from "@/types/settings";

export type PopoverState =
  | "idle"
  | "loading"
  | "lookup"
  | "translate"
  | "error";
export type PopoverTrigger = "auto" | "shortcut";

export interface PopoverData {
  selectedText: string;
  dictionary: DictionaryResult | null;
  translation: TranslateResult | null;
}

const EMPTY_DATA: PopoverData = {
  selectedText: "",
  dictionary: null,
  translation: null,
};

const AUTO_SELECTION_REPEAT_WINDOW_MS = 850;

function countWords(input: string): number {
  const words = input.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export function getActionType(input: string): "lookup" | "translate" {
  return countWords(input) === 1 ? "lookup" : "translate";
}

export function usePopover(settings: AppSettings) {
  const [state, setState] = useState<PopoverState>("idle");
  const [data, setData] = useState<PopoverData>(EMPTY_DATA);
  const [error, setError] = useState<string | null>(null);
  const activeRequestIdRef = useRef(0);
  const lastAutoSelectionRef = useRef<{ text: string; at: number }>({
    text: "",
    at: 0,
  });

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
      if (
        settings.popover_trigger_mode === "shortcut" &&
        trigger !== "shortcut"
      ) {
        return;
      }

      if (trigger === "auto") {
        const now = Date.now();
        const repeatedSelection =
          lastAutoSelectionRef.current.text === selectedText &&
          now - lastAutoSelectionRef.current.at <
            AUTO_SELECTION_REPEAT_WINDOW_MS;
        if (repeatedSelection) {
          return;
        }
        lastAutoSelectionRef.current = { text: selectedText, at: now };
      }

      const requestId = activeRequestIdRef.current + 1;
      activeRequestIdRef.current = requestId;
      setState("loading");
      setError(null);
      const nextData: PopoverData = {
        selectedText,
        dictionary: null,
        translation: null,
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
              nextData.dictionary = {
                ...dictionary,
                meanings: dictionary.meanings.slice(
                  0,
                  settings.max_definitions,
                ),
              };
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

  return {
    state,
    data,
    error,
    close,
    openFromSelection,
  };
}

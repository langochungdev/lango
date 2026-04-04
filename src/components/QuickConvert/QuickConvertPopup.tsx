import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { INPUT_LANGUAGES, OUTPUT_LANGUAGES } from "@/constants/languages";
import type { SettingsCopy } from "@/constants/settingsI18n";
import type { InputLanguageCode, OutputLanguageCode } from "@/constants/languages";
import type { QuickConvertResult } from "@/services/quickConvert";
import { appendDebugLog } from "@/services/debugLog";
import { AudioIcon } from "@/components/Popover/PopoverIcons";
import { useSharedAudioPlayer } from "@/hooks/useSharedAudioPlayer";

interface QuickConvertPopupProps {
  open: boolean;
  loading: boolean;
  focusToken: number;
  copy: SettingsCopy;
  positionMode: string;
  sourceLanguage: InputLanguageCode;
  targetLanguage: OutputLanguageCode;
  inputValue: string;
  outputValue: string;
  result: QuickConvertResult | null;
  onClose: (reason: string) => void;
  onSubmit: () => void;
  onSwapLanguages: () => void;
  onSourceLanguageChange: (value: InputLanguageCode) => void;
  onTargetLanguageChange: (value: OutputLanguageCode) => void;
  onInputValueChange: (value: string) => void;
}

export function QuickConvertPopup({
  open,
  loading,
  focusToken,
  copy,
  positionMode,
  sourceLanguage,
  targetLanguage,
  inputValue,
  outputValue,
  result,
  onClose,
  onSubmit,
  onSwapLanguages,
  onSourceLanguageChange,
  onTargetLanguageChange,
  onInputValueChange,
}: QuickConvertPopupProps) {
  const popupRef = useRef<HTMLElement | null>(null);
  const languageRowRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const hasOutput = outputValue.trim().length > 0;
  const wordData = result?.word_data ?? null;

  const relatedTerms = useMemo(() => {
    if (!wordData) {
      return [] as string[];
    }

    const merged = [...(wordData.synonyms || []), ...(wordData.related || [])];
    const seen = new Set<string>();
    const deduped: string[] = [];

    for (const term of merged) {
      const normalized = String(term || "").trim();
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(normalized);
      if (deduped.length >= 12) {
        break;
      }
    }

    return deduped;
  }, [wordData]);

  const normalizedPhonetic = useMemo(() => {
    const raw = String(wordData?.phonetic || "").trim();
    if (!raw) {
      return "";
    }
    const stripped = raw.replace(/^\/+|\/+$/g, "");
    return stripped ? `/${stripped}/` : "";
  }, [wordData?.phonetic]);

  const partOfSpeech = String(wordData?.part_of_speech || "").trim();
  const hasWordMetaDetails = Boolean(
    normalizedPhonetic
      || partOfSpeech
      || wordData?.audio_url
      || relatedTerms.length > 0,
  );

  const showWordMetaLayout = Boolean(
    result?.kind === "word"
      && wordData
      && hasWordMetaDetails,
  );

  const { audioPlaying, playAudio, stopAudio } = useSharedAudioPlayer({
    audioUrl: wordData?.audio_url,
    fallbackWord: wordData?.input || outputValue,
    fallbackLang: wordData?.audio_lang || targetLanguage,
    debugScope: "quick-convert",
  });

  useEffect(() => {
    if (open) {
      return;
    }
    stopAudio();
  }, [open, stopAudio]);

  const selectWidthCh = useMemo(() => {
    const longestLabel = Math.max(
      ...INPUT_LANGUAGES.map((lang) => lang.label.length),
      ...OUTPUT_LANGUAGES.map((lang) => lang.label.length),
    );
    return Math.max(10, Math.min(24, longestLabel + 3));
  }, []);

  const resizeTextarea = useCallback(
    (element: HTMLTextAreaElement | null, maxHeight: number) => {
      if (!element) {
        return;
      }
      element.style.height = "0px";
      const nextHeight = Math.max(38, Math.min(maxHeight, element.scrollHeight));
      element.style.height = `${nextHeight}px`;
      element.style.maxHeight = `${maxHeight}px`;
      element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
    },
    [],
  );

  const focusAndSelectInput = useCallback((reason: string) => {
    const el = inputRef.current;
    if (!el) {
      appendDebugLog(
        "quick-convert",
        "Quick convert select-all skipped",
        `reason=${reason} no-input-ref`,
      );
      return;
    }

    el.focus();
    try {
      el.setSelectionRange(0, el.value.length);
    } catch (error) {
      appendDebugLog(
        "quick-convert",
        "Quick convert select-all failed",
        `reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    appendDebugLog(
      "quick-convert",
      "Quick convert select-all applied",
      `reason=${reason} inputLen=${el.value.length} start=${el.selectionStart ?? -1} end=${el.selectionEnd ?? -1} focused=${document.activeElement === el ? 1 : 0}`,
    );
  }, []);

  const applyDynamicLayout = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const popupElement = popupRef.current;
    const inputElement = inputRef.current;
    if (!popupElement || !inputElement) {
      return;
    }

    const rowHeight = languageRowRef.current?.offsetHeight ?? 40;
    const popupLimit = Math.max(140, window.innerHeight - 16);
    const chromeHeight = rowHeight + 14;
    const availableHeight = Math.max(48, popupLimit - chromeHeight);

    if (hasOutput) {
      const inputLimit = Math.max(48, Math.floor(availableHeight * 0.42));
      resizeTextarea(inputElement, inputLimit);
      return;
    }

    resizeTextarea(inputElement, availableHeight);
  }, [hasOutput, resizeTextarea]);

  useEffect(() => {
    if (!open) {
      return;
    }

    applyDynamicLayout();
  }, [open, inputValue, outputValue, applyDynamicLayout]);

  useEffect(() => {
    if (!open) {
      return;
    }

    appendDebugLog(
      "quick-convert",
      "Quick convert focus effect scheduled",
      `focusToken=${focusToken} inputLen=${inputRef.current?.value.length ?? 0}`,
    );

    const focusInput = () => {
      focusAndSelectInput(`focus-token-${focusToken}`);
    };

    const frameId = window.requestAnimationFrame(focusInput);
    const timerId = window.setTimeout(focusInput, 40);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timerId);
    };
  }, [open, focusAndSelectInput, focusToken]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onWindowFocus = () => {
      window.setTimeout(() => {
        focusAndSelectInput("window-focus");
      }, 0);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        window.setTimeout(() => {
          focusAndSelectInput("visibility-visible");
        }, 0);
      }
    };

    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [open, focusAndSelectInput]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onResize = () => {
      applyDynamicLayout();
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [open, applyDynamicLayout]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  const portalTarget = document.body;
  const isTopPosition = positionMode.startsWith("top-");
  const isBottomPosition = positionMode.startsWith("bottom-");
  const positionLayoutClass = isBottomPosition
    ? " is-layout-bottom"
    : isTopPosition
      ? " is-layout-top"
      : " is-layout-middle";
  const verticalAnchorClass = isTopPosition
    ? " is-top-anchor"
    : isBottomPosition
      ? " is-bottom-anchor"
      : " is-middle-anchor";
  const horizontalAnchorClass = positionMode.endsWith("-left")
    ? " is-horizontal-left"
    : positionMode.endsWith("-right")
      ? " is-horizontal-right"
      : " is-horizontal-center";

  const languageRow = (
    <div
      ref={languageRowRef}
      className="apl-quick-convert-language-row apl-quick-convert-language-row--minimal"
    >
      <select
        className="apl-quick-convert-lang-select"
        aria-label={copy.quickInputLanguage}
        value={sourceLanguage}
        style={{ width: `${selectWidthCh}ch` }}
        onChange={(event) =>
          onSourceLanguageChange(event.target.value as InputLanguageCode)
        }
      >
        {INPUT_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        className="apl-settings-swap-languages apl-settings-swap-languages--minimal"
        aria-label={copy.swapLanguages}
        onClick={onSwapLanguages}
      >
        ⇄
      </button>

      <select
        className="apl-quick-convert-lang-select"
        aria-label={copy.quickOutputLanguage}
        value={targetLanguage}
        style={{ width: `${selectWidthCh}ch` }}
        onChange={(event) =>
          onTargetLanguageChange(event.target.value as OutputLanguageCode)
        }
      >
        {OUTPUT_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>
    </div>
  );

  const inputEditor = (
    <textarea
      ref={inputRef}
      className="apl-quick-convert-input"
      aria-label={copy.quickConvertInputLabel}
      value={inputValue}
      onChange={(event) => onInputValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmit();
          window.requestAnimationFrame(() => {
            inputRef.current?.focus();
          });
        }
      }}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      autoFocus
    />
  );

  const resultCard = hasOutput ? (
    <section className="apl-quick-convert-result-card" aria-label={copy.quickConvertOutputLabel}>
      <div className="apl-quick-convert-result-primary">
        {showWordMetaLayout ? (
          <div className="apl-quick-convert-result-head">
            <p className="apl-quick-convert-result-word">{outputValue}</p>
            {normalizedPhonetic && (
              <span className="apl-quick-convert-result-phonetic">{normalizedPhonetic}</span>
            )}
            {partOfSpeech && (
              <span className="apl-quick-convert-result-pos">{partOfSpeech}</span>
            )}
            {wordData && (
              <button
                type="button"
                className="apl-quick-convert-audio-btn"
                onClick={playAudio}
                aria-label="Play pronunciation"
                aria-pressed={audioPlaying}
              >
                <AudioIcon />
              </button>
            )}
          </div>
        ) : (
          <p className="apl-quick-convert-result-text">{outputValue}</p>
        )}
      </div>

      {showWordMetaLayout && relatedTerms.length > 0 && (
        <>
          <div className="apl-quick-convert-result-divider" aria-hidden="true" />

          <div className="apl-quick-convert-result-secondary">
            <p className="apl-quick-convert-related-list">{relatedTerms.join(" · ")}</p>
          </div>
        </>
      )}
    </section>
  ) : null;

  useEffect(() => {
    if (!open || typeof window === "undefined") {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const popup = popupRef.current;
      if (!popup) {
        appendDebugLog(
          "quick-convert",
          "Quick convert layout snapshot",
          `pos=${positionMode} top=${isTopPosition ? 1 : 0} bottom=${isBottomPosition ? 1 : 0} popup=missing`,
        );
        return;
      }

      const rect = popup.getBoundingClientRect();
      const computed = window.getComputedStyle(popup);
      const childOrder = Array.from(popup.children)
        .map((node) => {
          const el = node as HTMLElement;
          if (el.classList.contains("apl-quick-convert-language-row")) {
            return "lang";
          }
          if (el.classList.contains("apl-quick-convert-input")) {
            return "input";
          }
          if (el.classList.contains("apl-quick-convert-result-card")) {
            return "result";
          }
          return "other";
        })
        .join(">");
      appendDebugLog(
        "quick-convert",
        "Quick convert layout snapshot",
        `pos=${positionMode} top=${isTopPosition ? 1 : 0} bottom=${isBottomPosition ? 1 : 0} class=${popup.className} order=${childOrder} cssTop=${computed.top} cssBottom=${computed.bottom} rectTop=${Math.round(rect.top)} rectBottom=${Math.round(rect.bottom)} vh=${window.innerHeight}`,
      );
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isBottomPosition, isTopPosition, open, positionMode]);

  return createPortal(
    <>
      <div
        className="apl-quick-convert-backdrop"
        aria-hidden="true"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            onClose("backdrop-pointerdown");
          }
        }}
      />

      <section
        ref={popupRef}
        className={`apl-quick-convert-popup apl-quick-convert-popup--minimal${verticalAnchorClass}${horizontalAnchorClass}${positionLayoutClass}${isBottomPosition ? " is-bottom-layout" : ""}${loading ? " is-loading" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={copy.quickConvertPopupTitle}
        aria-busy={loading}
      >
        {isBottomPosition ? (
          <>
            {resultCard}
            {inputEditor}
            {languageRow}
          </>
        ) : (
          <>
            {languageRow}
            {inputEditor}
            {resultCard}
          </>
        )}
      </section>
    </>,
    portalTarget,
  );
}

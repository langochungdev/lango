// Popover hiển thị kết quả tra từ điển hoặc dịch, với sub-panel tách biệt
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createPortal } from 'react-dom'
import type { OcrImageOverlayData, PopoverState } from '@/hooks/usePopover'
import type { AutoPlayAudioMode, PopoverOpenPanelMode } from '@/types/settings'
import type { DictionaryResult } from '@/services/dictionary'
import type { TranslateResult } from '@/services/translate'
import { normalizeText, sanitizeMarkup, normalizePhonetic, lookupPrimary, resolveImageQuery, buildAlternativeAudioUrl } from '@/components/Popover/popover.utils'
import { AudioIcon, ImageIcon, SettingsIcon } from '@/components/Popover/PopoverIcons'
import { SubPanel } from '@/components/Popover/SubPanel'
import { ImageSubPanel } from '@/components/Popover/ImageSubPanel'
import { usePopoverResize } from '@/hooks/usePopoverResize'
import type { SelectionAnchor } from '@/types/selectionAnchor'
import type { PopoverTrigger } from '@/hooks/usePopover'

interface PopoverProps {
  state: PopoverState
  selection: string
  trigger: PopoverTrigger
  lookupDisplayWord?: string | null
  lookupDisplayDefinition?: string | null
  dictionary: DictionaryResult | null
  translation: TranslateResult | null
  ocrImageOverlay?: OcrImageOverlayData | null
  error: string | null
  panelMode: PopoverOpenPanelMode
  enableAudio: boolean
  autoPlayAudioMode: AutoPlayAudioMode
  selectionAnchor: SelectionAnchor | null
  onOpenSettings?: () => void
  onRequestClose?: (reason?: string) => void
}

const WIDTH_SYNC_FRAMES = 4
const MIN_POPOVER_WIDTH = 220
const MAX_POPOVER_WIDTH = 560
const MAX_LOOKUP_MIN_POPOVER_WIDTH = 440
const CONTENT_CHAR_WIDTH_PX = 7
const POPOVER_BASE_CONTENT_PADDING_PX = 84
const LOOKUP_DEFINITION_DENSITY_WEIGHT = 0.24
const LOOKUP_DEFINITION_DENSITY_CAP = 64

function useAudioPlayer(dictionary: DictionaryResult | null, selectedText: string) {
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    setAudioPlaying(false)
  }, [])

  useEffect(() => () => { stopAudio() }, [stopAudio])

  const startAudio = useCallback(async () => {
    setAudioError(null)
    stopAudio()

    const source = String(dictionary?.audio_url || '').trim()
    const fallbackWord = normalizeText(dictionary?.word || selectedText)
    const fallbackLang = normalizeText(dictionary?.audio_lang || 'en')

    const tryPlayUrl = async (url: string): Promise<boolean> => {
      if (!url) return false
      try {
        const audio = new Audio(url)
        audioRef.current = audio
        audio.onended = () => setAudioPlaying(false)
        audio.onerror = () => setAudioPlaying(false)
        setAudioPlaying(true)
        await audio.play()
        return true
      } catch { setAudioPlaying(false); return false }
    }

    if (source) {
      if (await tryPlayUrl(source)) return
      const alt = buildAlternativeAudioUrl(source)
      if (alt && await tryPlayUrl(alt)) return
    }

    const text = normalizeText(fallbackWord)
    if (text && typeof window !== 'undefined' && window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(text)
      if (fallbackLang) u.lang = fallbackLang
      window.speechSynthesis.speak(u)
    } else {
      setAudioError('Audio playback failed')
    }
  }, [dictionary, selectedText, stopAudio])

  const playAudio = useCallback(async () => {
    if (audioPlaying) { stopAudio(); return }
    await startAudio()
  }, [audioPlaying, startAudio, stopAudio])

  return { audioPlaying, audioError, playAudio, startAudio, stopAudio }
}

export function Popover({ state, selection, trigger, lookupDisplayWord, lookupDisplayDefinition, dictionary, translation, ocrImageOverlay, error, panelMode, enableAudio, autoPlayAudioMode, selectionAnchor, onOpenSettings, onRequestClose }: PopoverProps) {
  const [activePanel, setActivePanel] = useState<PopoverOpenPanelMode>('none')
  const [lockedPopoverWidth, setLockedPopoverWidth] = useState<number | null>(null)
  const [baselinePopoverWidth, setBaselinePopoverWidth] = useState<number | null>(null)
  const [overlayCopyStatus, setOverlayCopyStatus] = useState<'idle' | 'textCopied' | 'imageCopied' | 'failed'>('idle')
  const popoverRef = useRef<HTMLElement | null>(null)
  const autoAudioKeyRef = useRef('')
  const widthSyncRafRef = useRef(0)
  const overlayCopyStatusTimerRef = useRef<number | null>(null)

  const cleanSelection = normalizeText(selection)
  const selectedText = cleanSelection || 'Selection'
  const selectedWordCount = useMemo(
    () => (selectedText ? selectedText.split(/\s+/).filter(Boolean).length : 0),
    [selectedText],
  )
  const isOcrTrigger = trigger === 'ocr'
  const isParagraphTranslate = state === 'translate' && selectedWordCount > 1
  const isOcrParagraphTranslate = isOcrTrigger && isParagraphTranslate
  const isOcrLookup = isOcrTrigger && state === 'lookup'
  const ocrOverlayImageSrc = useMemo(() => {
    const payload = ocrImageOverlay?.imageBase64?.trim() ?? ''
    if (!payload) {
      return ''
    }
    return `data:image/png;base64,${payload}`
  }, [ocrImageOverlay])
  const ocrOverlayCopyText = useMemo(
    () => normalizeText(ocrImageOverlay?.text || selection),
    [ocrImageOverlay?.text, selection],
  )
  const { audioError, playAudio, startAudio, stopAudio } = useAudioPlayer(dictionary, selectedText)

  const flashOverlayCopyStatus = useCallback((next: 'textCopied' | 'imageCopied' | 'failed') => {
    setOverlayCopyStatus(next)
    if (overlayCopyStatusTimerRef.current !== null) {
      window.clearTimeout(overlayCopyStatusTimerRef.current)
    }
    overlayCopyStatusTimerRef.current = window.setTimeout(() => {
      setOverlayCopyStatus('idle')
      overlayCopyStatusTimerRef.current = null
    }, 1400)
  }, [])

  const copyOverlayText = useCallback(async () => {
    if (!ocrOverlayCopyText) {
      return
    }

    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        await invoke('copy_text_to_clipboard', { text: ocrOverlayCopyText })
      } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(ocrOverlayCopyText)
      } else {
        throw new Error('clipboard unavailable')
      }
      flashOverlayCopyStatus('textCopied')
    } catch {
      flashOverlayCopyStatus('failed')
    }
  }, [flashOverlayCopyStatus, ocrOverlayCopyText])

  const copyOverlayImage = useCallback(async () => {
    const imageBase64 = ocrImageOverlay?.imageBase64?.trim() ?? ''
    if (!imageBase64) {
      return
    }

    try {
      await invoke('copy_image_to_clipboard', { imageBase64 })
      flashOverlayCopyStatus('imageCopied')
    } catch {
      flashOverlayCopyStatus('failed')
    }
  }, [flashOverlayCopyStatus, ocrImageOverlay?.imageBase64])

  const readPopoverWidth = useCallback(() => {
    const width = popoverRef.current?.getBoundingClientRect().width ?? 0
    return width > 0 ? Math.ceil(width) : 0
  }, [])

  const capturePopoverWidth = useCallback(() => {
    const width = Math.max(readPopoverWidth(), baselinePopoverWidth ?? 0)
    if (width > 0) {
      setLockedPopoverWidth((current) => {
        if (current === null) {
          return width
        }
        return Math.max(current, width)
      })
    }
  }, [baselinePopoverWidth, readPopoverWidth])

  const togglePanel = useCallback((target: PopoverOpenPanelMode) => {
    setActivePanel((current) => {
      const next = current === target ? 'none' : target
      if (next === 'none') {
        setLockedPopoverWidth(null)
      } else {
        const width = Math.max(readPopoverWidth(), baselinePopoverWidth ?? 0)
        if (width > 0) {
          setLockedPopoverWidth(width)
        }
      }
      return next
    })
  }, [baselinePopoverWidth, readPopoverWidth])

  const closeSubPanel = useCallback(() => {
    setActivePanel('none')
    setLockedPopoverWidth(null)
  }, [])

  useEffect(() => { setActivePanel(panelMode) }, [panelMode, selection, state])
  useEffect(() => { setBaselinePopoverWidth(null); setLockedPopoverWidth(null) }, [selection])
  useEffect(() => {
    setOverlayCopyStatus('idle')
  }, [ocrImageOverlay?.imageBase64, ocrImageOverlay?.text])
  useEffect(() => {
    if (state === 'idle' || state === 'loading') {
      autoAudioKeyRef.current = ''
      stopAudio()
    }
  }, [state, stopAudio])
  useEffect(() => {
    return () => {
      if (overlayCopyStatusTimerRef.current !== null) {
        window.clearTimeout(overlayCopyStatusTimerRef.current)
      }
    }
  }, [])

  const compactLookupScore = useMemo(() => {
    if (state !== 'lookup' || !dictionary) {
      return { header: 0, definition: 0 }
    }
    const header = normalizeText(
      sanitizeMarkup(`${lookupDisplayWord || dictionary.word || selectedText} ${dictionary.phonetic || ''} ${dictionary.meanings?.[0]?.part_of_speech || ''}`),
    ).length
    const definition = normalizeText(
      sanitizeMarkup(lookupDisplayDefinition || dictionary.meanings?.[0]?.definitions?.[0] || ''),
    ).length
    return { header, definition }
  }, [dictionary, lookupDisplayDefinition, lookupDisplayWord, selectedText, state])

  const compactTranslateLength = useMemo(() => {
    if (state !== 'translate' || !translation) {
      return 0
    }
    return normalizeText(sanitizeMarkup(translation.result)).length
  }, [state, translation])

  const minPopoverWidth = useMemo(() => {
    if (state === 'ocrImage') {
      return 540
    }

    const lookupDefinitionDensity = Math.min(
      LOOKUP_DEFINITION_DENSITY_CAP,
      compactLookupScore.definition,
    )
    const lookupDensity =
      Math.max(compactLookupScore.header, selectedText.length) +
      Math.ceil(lookupDefinitionDensity * LOOKUP_DEFINITION_DENSITY_WEIGHT)
    const translateDensity = isParagraphTranslate
      ? Math.max(24, compactTranslateLength)
      : Math.max(
          compactTranslateLength,
          Math.ceil(selectedText.length * 0.8),
        )

    const contentDensity =
      state === 'lookup'
        ? Math.max(lookupDensity, selectedText.length)
        : state === 'translate'
          ? isParagraphTranslate
            ? translateDensity
            : Math.max(translateDensity, selectedText.length)
          : selectedText.length

    const widthPadding = isParagraphTranslate
      ? Math.max(20, POPOVER_BASE_CONTENT_PADDING_PX - 52)
      : POPOVER_BASE_CONTENT_PADDING_PX
    const widthCharPx = isParagraphTranslate
      ? Math.max(5.2, CONTENT_CHAR_WIDTH_PX - 1.8)
      : CONTENT_CHAR_WIDTH_PX
    const minWidth = isParagraphTranslate ? 176 : MIN_POPOVER_WIDTH

    const estimatedWidth = Math.ceil(
      widthPadding + contentDensity * widthCharPx,
    )

    const maxMinWidth =
      state === 'lookup' ? MAX_LOOKUP_MIN_POPOVER_WIDTH : MAX_POPOVER_WIDTH

    return Math.min(
      maxMinWidth,
      Math.max(minWidth, estimatedWidth),
    )
  }, [compactLookupScore.definition, compactLookupScore.header, compactTranslateLength, isParagraphTranslate, selectedText.length, state])

  const showDetailsPanel = state === 'lookup' && Boolean(dictionary) && activePanel === 'details'
  const showImagePanel = activePanel === 'images'
  const hasSubPanel = (showDetailsPanel && Boolean(dictionary)) || showImagePanel
  const showBackdrop = state !== 'idle' && state !== 'loading'

  useEffect(() => {
    if (!hasSubPanel) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSubPanel()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [closeSubPanel, hasSubPanel])

  useEffect(() => {
    if (!hasSubPanel) {
      setLockedPopoverWidth(null)
      return
    }
    if (lockedPopoverWidth === null) {
      capturePopoverWidth()
    }
  }, [capturePopoverWidth, hasSubPanel, lockedPopoverWidth])

  useEffect(() => {
    if (state === 'idle' || state === 'loading' || hasSubPanel) {
      return
    }

    const popover = popoverRef.current
    if (!popover) {
      return
    }

    const updateBaselineWidth = () => {
      const width = readPopoverWidth()
      if (width > 0) {
        setBaselinePopoverWidth((current) => {
          if (current === null) {
            return width
          }
          if (width <= minPopoverWidth) {
            return width
          }
          return Math.max(current, width)
        })
      }
    }

    updateBaselineWidth()
    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      updateBaselineWidth()
    })
    observer.observe(popover)
    return () => {
      observer.disconnect()
    }
  }, [hasSubPanel, minPopoverWidth, readPopoverWidth, state])

  useEffect(() => {
    if (!hasSubPanel) {
      return () => {
        cancelAnimationFrame(widthSyncRafRef.current)
      }
    }

    let frame = 0
    const syncWidth = () => {
      widthSyncRafRef.current = requestAnimationFrame(() => {
        capturePopoverWidth()
        frame += 1
        if (frame < WIDTH_SYNC_FRAMES) {
          syncWidth()
        }
      })
    }

    syncWidth()
    return () => {
      cancelAnimationFrame(widthSyncRafRef.current)
    }
  }, [capturePopoverWidth, hasSubPanel])

  const imageQuery = useMemo(() => resolveImageQuery(state, selectedText, dictionary), [dictionary, selectedText, state])

  useEffect(() => {
    if (!enableAudio || autoPlayAudioMode === 'off') {
      autoAudioKeyRef.current = ''
      stopAudio()
      return
    }

    if (trigger === 'ocr' || trigger === 'ocr-image-overlay') {
      autoAudioKeyRef.current = ''
      stopAudio()
      return
    }

    let autoKey = ''

    if (state === 'lookup' && dictionary && (autoPlayAudioMode === 'word' || autoPlayAudioMode === 'all')) {
      autoKey = `lookup:${selectedText}:${dictionary.word}:${dictionary.audio_url || ''}`
    }

    if (state === 'translate' && translation && autoPlayAudioMode === 'all') {
      autoKey = `translate:${selectedText}:${translation.result}`
    }

    if (!autoKey || autoAudioKeyRef.current === autoKey) {
      return
    }

    autoAudioKeyRef.current = autoKey
    void startAudio()
  }, [autoPlayAudioMode, dictionary, enableAudio, selectedText, startAudio, state, stopAudio, translation, trigger])

  usePopoverResize(
    popoverRef,
    state,
    hasSubPanel,
    activePanel,
    lockedPopoverWidth,
    minPopoverWidth,
    baselinePopoverWidth,
    selectionAnchor,
  )

  if (state === 'idle' || state === 'loading') return null

  const lookupData = dictionary ? { word: normalizeText(sanitizeMarkup(lookupDisplayWord || dictionary.word || selectedText)), phonetic: normalizePhonetic(dictionary.phonetic || ''), ...lookupPrimary(dictionary) } : null
  const definitionText = normalizeText(sanitizeMarkup(lookupDisplayDefinition || lookupData?.firstDefinition || ''))
  const translationLines = translation ? sanitizeMarkup(translation.result).split(/\r?\n+/).map(l => normalizeText(l)).filter(Boolean) : []
  const portalTarget = typeof document !== 'undefined' ? document.body : null
  if (!portalTarget) return null

  return (
    <>
      {showBackdrop && createPortal(
        <div
          className="apl-subpanel-backdrop"
          aria-hidden="true"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              stopAudio()
              onRequestClose?.('backdrop-pointerdown')
            }
          }}
        />,
        portalTarget,
      )}

      {createPortal(
        <section
          ref={popoverRef}
          className={`apl-popover${isParagraphTranslate ? ' apl-popover--translate-paragraph' : ''}${state === 'ocrImage' ? ' apl-popover--ocr-image' : ''}`}
          data-testid="popover"
          role="dialog"
          aria-modal="true"
          aria-label="Dictover popover"
        >
          {state === 'lookup' && dictionary && lookupData && (
            <div className="apl-body apl-lookup-compact">
              <div className="apl-lookup-headerline">
                <div className={`apl-lookup-headertext${isOcrLookup ? ' apl-lookup-headertext--ocr' : ''}`}>
                  {isOcrLookup && <span className="apl-lookup-origin-prefix">{selectedText}:</span>}
                  <h2 className="apl-lookup-summary">{lookupData.word}</h2>
                  {lookupData.phonetic && <span className="apl-lookup-phonetic-inline">/{lookupData.phonetic}/</span>}
                  {lookupData.partOfSpeech && <span className="apl-pos-inline">{lookupData.partOfSpeech}</span>}
                </div>
                <div className="apl-inline-actions">
                  <button type="button" className="apl-button apl-audio apl-audio-mini" aria-label="Play audio" onClick={() => void playAudio()} disabled={!enableAudio || !dictionary}><AudioIcon /></button>
                  <button type="button" className={`apl-button apl-image-toggle apl-audio-mini ${showImagePanel ? 'apl-image-toggle--active' : ''}`} aria-label="Open image panel" aria-pressed={showImagePanel} onClick={() => togglePanel('images')}><ImageIcon /></button>
                  <button type="button" className="apl-button apl-popover-settings apl-audio-mini" aria-label="Open settings" onClick={onOpenSettings} disabled={!onOpenSettings}><SettingsIcon /></button>
                </div>
              </div>
              {definitionText && (
                <button type="button" className="apl-lookup-definition-toggle" onClick={() => togglePanel('details')}>
                  <span className="apl-definition-toggle-icon">{'>'}</span>
                  <span className="apl-lookup-definition">{definitionText}</span>
                </button>
              )}
            </div>
          )}

          {state === 'translate' && translation && (
            <div className={`apl-body apl-translate-compact${isParagraphTranslate ? ' apl-translate-compact--paragraph' : ''}`}>
              {isOcrParagraphTranslate ? (
                <div className="apl-translate-ocr-stack">
                  <div className="apl-translate-ocr-origin">{selectedText}</div>
                  <div className="apl-translate-ocr-meaning">
                    {translationLines.length > 0 ? translationLines.join(' ') : normalizeText(sanitizeMarkup(translation.result))}
                  </div>
                </div>
              ) : (
                <div className={`apl-translate-vi apl-translate-vi--primary${isParagraphTranslate ? ' apl-translate-vi--single-line' : ''}`}>{translationLines.length > 0 ? translationLines.join(' ') : normalizeText(sanitizeMarkup(translation.result))}</div>
              )}
              <div className={`apl-inline-actions apl-translate-inline-actions${isParagraphTranslate ? ' apl-translate-inline-actions--floating' : ''}`}>
                {isParagraphTranslate && (
                  <button type="button" className="apl-button apl-audio apl-audio-mini" aria-label="Play audio" onClick={() => void playAudio()}><AudioIcon /></button>
                )}
                  <button type="button" className={`apl-button apl-image-toggle ${showImagePanel ? 'apl-image-toggle--active' : ''}`} aria-label="Open image panel" aria-pressed={showImagePanel} onClick={() => togglePanel('images')}><ImageIcon /></button>
                <button type="button" className="apl-button apl-popover-settings" aria-label="Open settings" onClick={onOpenSettings} disabled={!onOpenSettings}><SettingsIcon /></button>
              </div>
            </div>
          )}

          {state === 'ocrImage' && ocrImageOverlay && (
            <div className="apl-body apl-ocr-image-overlay">
              <div className="apl-ocr-image-overlay-frame">
                {ocrOverlayImageSrc && (
                  <img
                    src={ocrOverlayImageSrc}
                    alt="Translated OCR overlay"
                    className="apl-ocr-image-overlay-image"
                    draggable={false}
                  />
                )}
              </div>
              <div className="apl-ocr-image-overlay-actions" role="group" aria-label="OCR overlay actions">
                <button
                  type="button"
                  className="apl-ocr-image-overlay-btn"
                  onClick={() => void copyOverlayImage()}
                  disabled={!ocrOverlayImageSrc}
                >
                  Copy image
                </button>
                <button
                  type="button"
                  className="apl-ocr-image-overlay-btn"
                  onClick={() => void copyOverlayText()}
                  disabled={!ocrOverlayCopyText}
                >
                  Copy text
                </button>
              </div>
              {overlayCopyStatus !== 'idle' && (
                <p className={`apl-ocr-image-overlay-status${overlayCopyStatus === 'failed' ? ' is-error' : ''}`}>
                  {overlayCopyStatus === 'imageCopied' && 'Image copied'}
                  {overlayCopyStatus === 'textCopied' && 'Text copied'}
                  {overlayCopyStatus === 'failed' && 'Copy failed'}
                </p>
              )}
            </div>
          )}

          {audioError && <p className="apl-error">{audioError}</p>}
          {state === 'error' && <p className="apl-error">{error ?? 'Unknown error'}</p>}
        </section>,
        portalTarget,
      )}

      <SubPanel
        popoverRef={popoverRef}
        visible={showDetailsPanel && Boolean(dictionary)}
        panelMode="details"
      >
        <div className="apl-subpanel-body">
          {dictionary?.meanings.map((meaning, mi) => (
            <article key={`${meaning.part_of_speech}-${mi}`} className="apl-meaning">
              <h3 className="apl-pos">{normalizeText(sanitizeMarkup(meaning.part_of_speech || 'Meaning'))}</h3>
              {meaning.definitions.map((def, di) => <p key={`${mi}-${di}-${def}`} className="apl-def">{normalizeText(sanitizeMarkup(def))}</p>)}
              {meaning.example && <p className="apl-example">Example: {normalizeText(sanitizeMarkup(meaning.example))}</p>}
            </article>
          ))}
        </div>
      </SubPanel>

      <ImageSubPanel
        popoverRef={popoverRef}
        visible={showImagePanel}
        imageQuery={imageQuery}
      />
    </>
  )
}

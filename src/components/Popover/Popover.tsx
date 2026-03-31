// Popover hiển thị kết quả tra từ điển hoặc dịch, với sub-panel tách biệt
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ImageOption } from '@/services/images'
import { searchImages } from '@/services/images'
import type { PopoverState } from '@/hooks/usePopover'
import type { AutoPlayAudioMode, PopoverOpenPanelMode } from '@/types/settings'
import type { DictionaryResult } from '@/services/dictionary'
import type { TranslateResult } from '@/services/translate'
import { normalizeText, sanitizeMarkup, normalizePhonetic, lookupPrimary, resolveImageQuery, buildAlternativeAudioUrl } from '@/components/Popover/popover.utils'
import { AudioIcon, ImageIcon, SettingsIcon } from '@/components/Popover/PopoverIcons'
import { SubPanel } from '@/components/Popover/SubPanel'
import { usePopoverResize } from '@/hooks/usePopoverResize'
import type { SelectionAnchor } from '@/types/selectionAnchor'

interface PopoverProps {
  state: PopoverState
  selection: string
  dictionary: DictionaryResult | null
  translation: TranslateResult | null
  error: string | null
  panelMode: PopoverOpenPanelMode
  enableAudio: boolean
  autoPlayAudioMode: AutoPlayAudioMode
  selectionAnchor: SelectionAnchor | null
  onOpenSettings?: () => void
}

const IMAGE_PAGE_SIZE = 12
const WIDTH_SYNC_FRAMES = 4
const MIN_POPOVER_WIDTH = 220
const MAX_POPOVER_WIDTH = 560
const CONTENT_CHAR_WIDTH_PX = 7
const POPOVER_BASE_CONTENT_PADDING_PX = 120

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

export function Popover({ state, selection, dictionary, translation, error, panelMode, enableAudio, autoPlayAudioMode, selectionAnchor, onOpenSettings }: PopoverProps) {
  const [activePanel, setActivePanel] = useState<PopoverOpenPanelMode>('none')
  const [lockedPopoverWidth, setLockedPopoverWidth] = useState<number | null>(null)
  const [baselinePopoverWidth, setBaselinePopoverWidth] = useState<number | null>(null)
  const [imageLoading, setImageLoading] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [imageItems, setImageItems] = useState<ImageOption[]>([])
  const imageRequestIdRef = useRef(0)
  const popoverRef = useRef<HTMLElement | null>(null)
  const autoAudioKeyRef = useRef('')
  const widthSyncRafRef = useRef(0)

  const cleanSelection = normalizeText(selection)
  const selectedText = cleanSelection || 'Selection'
  const { audioError, playAudio, startAudio, stopAudio } = useAudioPlayer(dictionary, selectedText)

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

  useEffect(() => { setActivePanel(panelMode) }, [panelMode, selection, state])
  useEffect(() => { imageRequestIdRef.current += 1; setImageLoading(false); setImageError(null); setImageItems([]) }, [selection, state])
  useEffect(() => { setBaselinePopoverWidth(null); setLockedPopoverWidth(null) }, [selection])

  const compactLookupScore = useMemo(() => {
    if (state !== 'lookup' || !dictionary) {
      return { header: 0, definition: 0 }
    }
    const header = normalizeText(
      sanitizeMarkup(`${dictionary.word || selectedText} ${dictionary.phonetic || ''} ${dictionary.meanings?.[0]?.part_of_speech || ''}`),
    ).length
    const definition = normalizeText(
      sanitizeMarkup(dictionary.meanings?.[0]?.definitions?.[0] || ''),
    ).length
    return { header, definition }
  }, [dictionary, selectedText, state])

  const compactTranslateLength = useMemo(() => {
    if (state !== 'translate' || !translation) {
      return 0
    }
    return normalizeText(sanitizeMarkup(translation.result)).length
  }, [state, translation])

  const minPopoverWidth = useMemo(() => {
    const lookupDensity =
      compactLookupScore.header + Math.ceil(compactLookupScore.definition * 0.7)
    const translateDensity = Math.max(
      compactTranslateLength,
      Math.ceil(selectedText.length * 0.8),
    )

    const contentDensity =
      state === 'lookup'
        ? Math.max(lookupDensity, selectedText.length)
        : state === 'translate'
          ? Math.max(translateDensity, selectedText.length)
          : selectedText.length

    const estimatedWidth = Math.ceil(
      POPOVER_BASE_CONTENT_PADDING_PX + contentDensity * CONTENT_CHAR_WIDTH_PX,
    )

    return Math.min(
      MAX_POPOVER_WIDTH,
      Math.max(MIN_POPOVER_WIDTH, estimatedWidth),
    )
  }, [compactLookupScore.definition, compactLookupScore.header, compactTranslateLength, selectedText.length, state])

  const showDetailsPanel = state === 'lookup' && Boolean(dictionary) && activePanel === 'details'
  const showImagePanel = activePanel === 'images'
  const hasSubPanel = (showDetailsPanel && Boolean(dictionary)) || showImagePanel

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
    if (activePanel !== 'images' || !imageQuery) return
    const requestId = ++imageRequestIdRef.current
    setImageLoading(true)
    setImageError(null)

    void (async () => {
      try {
        const result = await searchImages({ query: imageQuery, page: 1, page_size: IMAGE_PAGE_SIZE })
        if (imageRequestIdRef.current !== requestId) return
        setImageItems(Array.isArray(result.options) ? result.options : [])
        setImageError(result.error?.trim() ? result.error : null)
      } catch {
        if (imageRequestIdRef.current !== requestId) return
        setImageItems([])
        setImageError('Image search failed')
      } finally {
        if (imageRequestIdRef.current === requestId) setImageLoading(false)
      }
    })()
  }, [activePanel, imageQuery])

  useEffect(() => {
    if (!enableAudio || autoPlayAudioMode === 'off') {
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
  }, [autoPlayAudioMode, dictionary, enableAudio, selectedText, startAudio, state, stopAudio, translation])

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

  const lookupData = dictionary ? { word: normalizeText(sanitizeMarkup(dictionary.word || selectedText)), phonetic: normalizePhonetic(dictionary.phonetic || ''), ...lookupPrimary(dictionary) } : null
  const definitionText = lookupData?.firstDefinition || ''
  const translationLines = translation ? sanitizeMarkup(translation.result).split(/\r?\n+/).map(l => normalizeText(l)).filter(Boolean) : []
  const portalTarget = typeof document !== 'undefined' ? document.body : null
  if (!portalTarget) return null

  return (
    <>
      {createPortal(
        <section ref={popoverRef} className="apl-popover" data-testid="popover" role="dialog" aria-modal="true" aria-label="Dictover popover">
          {state === 'lookup' && dictionary && lookupData && (
            <div className="apl-body apl-lookup-compact">
              <div className="apl-lookup-headerline">
                <div className="apl-lookup-headertext">
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
                <button type="button" className="apl-lookup-definition-toggle" aria-expanded={showDetailsPanel} onClick={() => togglePanel('details')}>
                  <span className={`apl-definition-toggle-icon${showDetailsPanel ? ' is-open' : ''}`}>{'>'}</span>
                  <span className="apl-lookup-definition">{definitionText}</span>
                </button>
              )}
            </div>
          )}

          {state === 'translate' && translation && (
            <div className="apl-body apl-translate-compact">
              <div className="apl-translate-vi apl-translate-vi--primary">{translationLines.length > 0 ? translationLines.join(' ') : normalizeText(sanitizeMarkup(translation.result))}</div>
              <div className="apl-inline-actions apl-translate-inline-actions">
                  <button type="button" className={`apl-button apl-image-toggle ${showImagePanel ? 'apl-image-toggle--active' : ''}`} aria-label="Open image panel" aria-pressed={showImagePanel} onClick={() => togglePanel('images')}><ImageIcon /></button>
                <button type="button" className="apl-button apl-popover-settings" aria-label="Open settings" onClick={onOpenSettings} disabled={!onOpenSettings}><SettingsIcon /></button>
              </div>
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

      <SubPanel
        popoverRef={popoverRef}
        visible={showImagePanel}
        panelMode="images"
      >
        <div className="apl-subpanel-body apl-image-grid">
          {!imageLoading && imageItems.length > 0 && imageItems.map((item, i) => (
            <a key={`${item.src}-${i}`} className="apl-image-card" href={item.page_url || item.src} target="_blank" rel="noopener noreferrer">
              <img src={item.src} alt={item.title || `${imageQuery} ${i + 1}`} loading={i < 4 ? 'eager' : 'lazy'} />
            </a>
          ))}
          {!imageLoading && imageItems.length === 0 && <p className="apl-meta">{imageError || 'No image results.'}</p>}
        </div>
      </SubPanel>
    </>
  )
}

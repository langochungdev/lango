import { useCallback, useEffect, useRef, useState } from 'react'
import type { DictionaryResult } from '@/services/dictionary'
import type { TranslateResult } from '@/services/translate'
import type { PopoverState } from '@/hooks/usePopover'
import type { PopoverOpenPanelMode } from '@/types/settings'

interface PopoverProps {
  state: PopoverState
  selection: string
  dictionary: DictionaryResult | null
  translation: TranslateResult | null
  error: string | null
  panelMode: PopoverOpenPanelMode
  onOpenSettings?: () => void
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function sanitizeMarkup(value: string): string {
  const withBreaks = value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')

  const withoutTags = withBreaks.replace(/<[^>]+>/g, ' ')

  if (typeof document === 'undefined') {
    return withoutTags
  }

  const element = document.createElement('textarea')
  element.innerHTML = withoutTags
  return element.value
}

function lookupPrimary(dictionary: DictionaryResult) {
  const firstMeaning = dictionary.meanings[0]
  const partOfSpeech = normalizeText(sanitizeMarkup(firstMeaning?.part_of_speech || ''))
  const firstDefinition = normalizeText(sanitizeMarkup(firstMeaning?.definitions?.[0] || ''))
  return { partOfSpeech, firstDefinition }
}

function imageCandidates(query: string): string[] {
  const safeQuery = encodeURIComponent(query.trim())
  if (!safeQuery) {
    return []
  }

  return [0, 1, 2, 3].map((index) => `https://source.unsplash.com/600x420/?${safeQuery}&sig=${index}`)
}

function LoadingDots({ label }: { label: string }) {
  return (
    <div className="apl-loading" role="status" aria-live="polite" aria-label={label}>
      <span className="apl-loading-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  )
}

function AudioIcon() {
  return (
    <svg className="apl-audio-icon" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <g fill="none" fillRule="evenodd" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.5 8.5v4" />
        <path d="M8.5 6.5v9" />
        <path d="M10.5 9.5v2" />
        <path d="M12.5 7.5v6.814" />
        <path d="M14.5 4.5v12" />
      </g>
    </svg>
  )
}

function ImageIcon() {
  return (
    <svg className="apl-image-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
        <rect x="2.8" y="4" width="14.4" height="12" rx="2" />
        <circle cx="7.2" cy="8" r="1.3" />
        <path d="M4.8 14l3.6-3.8 2.8 2.8 2.4-2.3 2.4 3.3" />
      </g>
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg className="apl-settings-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <path d="M8.2 2.6h3.6l.5 2.1a5.6 5.6 0 0 1 1.2.7l2-.8 1.8 3.1-1.5 1.5c.1.4.1.8.1 1.2s0 .8-.1 1.2l1.5 1.5-1.8 3.1-2-.8a5.6 5.6 0 0 1-1.2.7l-.5 2.1H8.2l-.5-2.1a5.6 5.6 0 0 1-1.2-.7l-2 .8-1.8-3.1L4.2 12a6 6 0 0 1-.1-1.2c0-.4 0-.8.1-1.2L2.7 8.1l1.8-3.1 2 .8a5.6 5.6 0 0 1 1.2-.7zm1.8 5a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Popover({
  state,
  selection,
  dictionary,
  translation,
  error,
  panelMode,
  onOpenSettings
}: PopoverProps) {
  const [activePanel, setActivePanel] = useState<PopoverOpenPanelMode>('none')
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const stopAudio = useCallback(() => {
    if (!audioRef.current) {
      return
    }
    audioRef.current.pause()
    audioRef.current.currentTime = 0
    setAudioPlaying(false)
  }, [])

  useEffect(() => {
    setActivePanel(panelMode)
  }, [panelMode, selection, state])

  useEffect(() => {
    return () => {
      stopAudio()
    }
  }, [stopAudio])

  const canPlayAudio = Boolean(dictionary?.audio_url)

  const playAudio = useCallback(async () => {
    if (audioPlaying) {
      stopAudio()
      return
    }

    if (!dictionary?.audio_url) {
      setAudioError('No audio source available')
      return
    }

    setAudioError(null)
    stopAudio()

    try {
      const audio = new Audio(dictionary.audio_url)
      audioRef.current = audio
      audio.onended = () => setAudioPlaying(false)
      audio.onerror = () => {
        setAudioPlaying(false)
        setAudioError('Audio playback failed')
      }
      setAudioPlaying(true)
      await audio.play()
    } catch {
      setAudioPlaying(false)
      setAudioError('Audio playback failed')
    }
  }, [audioPlaying, dictionary?.audio_url, stopAudio])

  if (state === 'idle') {
    return null
  }

  const cleanSelection = normalizeText(selection)
  const selectedText = cleanSelection || 'Selection'
  const translationLines = translation
    ? sanitizeMarkup(translation.result)
        .split(/\r?\n+/)
        .map((line) => normalizeText(line))
        .filter(Boolean)
    : []

  const lookupData = dictionary
    ? {
        word: normalizeText(sanitizeMarkup(dictionary.word || selectedText)),
        phonetic: normalizeText(sanitizeMarkup(dictionary.phonetic || '')),
        ...lookupPrimary(dictionary)
      }
    : null

  const definitionText = lookupData?.firstDefinition || ''
  const showDetailsPanel = state === 'lookup' && Boolean(dictionary) && activePanel === 'details'
  const showImagePanel = activePanel === 'images'
  const showSidePanel = showDetailsPanel || showImagePanel
  const images = imageCandidates(selectedText)

  return (
    <section className={`apl-popover ${showSidePanel ? 'apl-popover--split' : ''}`} data-testid="popover" role="dialog" aria-modal="true" aria-label="Dictover popover">
      <div className="apl-popover-main">
        {state === 'loading' && (
          <div className="apl-body apl-body--loading-only">
            <LoadingDots label="Loading" />
          </div>
        )}

        {state === 'lookup' && dictionary && lookupData && (
          <div className="apl-body apl-lookup-compact">
            <div className="apl-lookup-headerline">
              <div className="apl-lookup-headertext">
                <h2 className="apl-lookup-summary">{definitionText || lookupData.word}</h2>
                {lookupData.phonetic && <span className="apl-lookup-phonetic-inline">/{lookupData.phonetic}/</span>}
                {lookupData.partOfSpeech && <span className="apl-pos-inline">{lookupData.partOfSpeech}</span>}
              </div>

              <div className="apl-inline-actions">
                <button type="button" className="apl-button apl-audio apl-audio-mini" aria-label="Play audio" onClick={() => void playAudio()} disabled={!canPlayAudio}>
                  <AudioIcon />
                </button>
                <button
                  type="button"
                  className={`apl-button apl-image-toggle apl-audio-mini ${showImagePanel ? 'apl-image-toggle--active' : ''}`}
                  aria-label="Open image panel"
                  aria-pressed={showImagePanel}
                  onClick={() => setActivePanel((current) => (current === 'images' ? 'none' : 'images'))}
                >
                  <ImageIcon />
                </button>
                <button type="button" className="apl-button apl-popover-settings apl-audio-mini" aria-label="Open settings" onClick={onOpenSettings} disabled={!onOpenSettings}>
                  <SettingsIcon />
                </button>
              </div>
            </div>

            {definitionText && (
              <button
                type="button"
                className="apl-lookup-definition-toggle"
                aria-expanded={showDetailsPanel}
                onClick={() => setActivePanel((current) => (current === 'details' ? 'none' : 'details'))}
              >
                <span className="apl-definition-toggle-icon">{showDetailsPanel ? 'v' : '>'}</span>
                <span className="apl-lookup-definition">{definitionText}</span>
              </button>
            )}
          </div>
        )}

        {state === 'translate' && translation && (
          <div className="apl-body apl-translate-compact">
            <div className="apl-translate-vi apl-translate-vi--primary">
              {translationLines.length > 0 ? translationLines.join(' ') : normalizeText(sanitizeMarkup(translation.result))}
            </div>
            <div className="apl-inline-actions apl-translate-inline-actions">
              <button
                type="button"
                className={`apl-button apl-image-toggle ${showImagePanel ? 'apl-image-toggle--active' : ''}`}
                aria-label="Open image panel"
                aria-pressed={showImagePanel}
                onClick={() => setActivePanel((current) => (current === 'images' ? 'none' : 'images'))}
              >
                <ImageIcon />
              </button>
              <button type="button" className="apl-button apl-popover-settings" aria-label="Open settings" onClick={onOpenSettings} disabled={!onOpenSettings}>
                <SettingsIcon />
              </button>
            </div>
          </div>
        )}

        {audioError && <p className="apl-error">{audioError}</p>}
        {state === 'error' && <p className="apl-error">{error ?? 'Unknown error'}</p>}
      </div>

      {showDetailsPanel && dictionary && (
        <aside className="apl-subpanel" data-panel-mode="details">
          <div className="apl-subpanel-body">
            {dictionary.meanings.map((meaning, meaningIndex) => (
              <article key={`${meaning.part_of_speech}-${meaningIndex}`} className="apl-meaning">
                <h3 className="apl-pos">{normalizeText(sanitizeMarkup(meaning.part_of_speech || 'Meaning'))}</h3>
                {meaning.definitions.map((definition, definitionIndex) => (
                  <p key={`${meaningIndex}-${definitionIndex}-${definition}`} className="apl-def">
                    {normalizeText(sanitizeMarkup(definition))}
                  </p>
                ))}
                {meaning.example && <p className="apl-example">Example: {normalizeText(sanitizeMarkup(meaning.example))}</p>}
              </article>
            ))}
          </div>
        </aside>
      )}

      {showImagePanel && (
        <aside className="apl-subpanel" data-panel-mode="images">
          <div className="apl-subpanel-body apl-image-grid">
            {images.length > 0 ? images.map((src, index) => (
              <article key={`${src}-${index}`} className="apl-image-card">
                <img src={src} alt={`${selectedText} ${index + 1}`} loading="lazy" />
              </article>
            )) : (
              <p className="apl-meta">No image query.</p>
            )}
          </div>
        </aside>
      )}
    </section>
  )
}

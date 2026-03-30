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
  onClose: () => void
}

function firstLookupSummary(dictionary: DictionaryResult): string {
  const firstMeaning = dictionary.meanings[0]
  if (!firstMeaning) {
    return ''
  }
  const firstDefinition = firstMeaning.definitions[0]
  return String(firstDefinition || '').trim()
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function Popover({
  state,
  selection,
  dictionary,
  translation,
  error,
  panelMode,
  onClose
}: PopoverProps) {
  if (state === 'idle') {
    return null
  }

  const cleanSelection = normalizeText(selection)
  const lookupSummary = dictionary ? firstLookupSummary(dictionary) : ''
  const translationLines = translation
    ? translation.result
        .split(/\r?\n+/)
        .map((line) => normalizeText(line))
        .filter(Boolean)
    : []

  const showDetailsPanel = panelMode === 'details'
  const showImagePanel = panelMode === 'images'
  const hasDetailsPanelContent =
    (state === 'lookup' && Boolean(dictionary)) ||
    (state === 'translate' && Boolean(translation))

  return (
    <section className="apl-popover" data-testid="popover" role="dialog" aria-modal="true" aria-labelledby="apl-popover-title">
      <header className="apl-popover-header">
        <h2 id="apl-popover-title">{cleanSelection || 'Selection'}</h2>
        <button type="button" className="apl-close-btn" onClick={onClose}>
          Close
        </button>
      </header>

      {state === 'loading' && (
        <p className="apl-status" role="status" aria-live="polite">
          Loading...
        </p>
      )}

      {state === 'lookup' && dictionary && (
        <div className="apl-content apl-content--lookup">
          <p className="apl-lookup-word">{dictionary.word || cleanSelection}</p>
          {dictionary.phonetic && <p className="apl-phonetic">/{dictionary.phonetic}/</p>}
          {lookupSummary && <p className="apl-lookup-summary">{lookupSummary}</p>}
          <p className="apl-meta">
            Provider: {dictionary.provider}
            {dictionary.fallback_used ? ' (fallback)' : ''}
          </p>
        </div>
      )}

      {state === 'translate' && translation && (
        <div className="apl-content apl-content--translate">
          {translationLines.length > 0 ? (
            translationLines.map((line, index) => (
              <p key={`${index}-${line}`} className="apl-translation">
                {line}
              </p>
            ))
          ) : (
            <p className="apl-translation">{translation.result}</p>
          )}
          <p className="apl-meta">Engine: {translation.engine}</p>
        </div>
      )}

      {state === 'error' && <p className="apl-error">{error ?? 'Unknown error'}</p>}

      {showDetailsPanel && hasDetailsPanelContent && (
        <aside className="apl-subpanel" data-panel-mode="details">
          {state === 'lookup' && dictionary && (
            <div className="apl-subpanel-body">
              {dictionary.meanings.map((meaning, meaningIndex) => (
                <article
                  key={`${meaning.part_of_speech}-${meaningIndex}`}
                  className="apl-meaning"
                >
                  <h3>{meaning.part_of_speech || 'Meaning'}</h3>
                  <ul>
                    {meaning.definitions.map((definition, definitionIndex) => (
                      <li key={`${meaningIndex}-${definitionIndex}-${definition}`}>
                        {definition}
                      </li>
                    ))}
                  </ul>
                  {meaning.example && <p className="apl-example">Example: {meaning.example}</p>}
                </article>
              ))}
            </div>
          )}

          {state === 'translate' && translation && (
            <div className="apl-subpanel-body">
              <p className="apl-meta">Mode: {translation.mode}</p>
              <p className="apl-meta">Engine: {translation.engine}</p>
            </div>
          )}
        </aside>
      )}

      {showImagePanel && (
        <aside className="apl-subpanel" data-panel-mode="images">
          <div className="apl-subpanel-body">
            <p className="apl-meta">Image panel is not available yet in desktop mode.</p>
          </div>
        </aside>
      )}
    </section>
  )
}

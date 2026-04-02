import { invoke } from '@tauri-apps/api/core'
import { INPUT_LANGUAGES, OUTPUT_LANGUAGES } from '@/constants/languages'
import type { KeyboardEvent, MouseEvent } from 'react'
import { getSettingsCopy } from '@/constants/settingsI18n'
import type {
  AppSettings,
  AutoPlayAudioMode,
  OcrParagraphDisplayMode,
  PopoverDefinitionLanguageMode,
  PopoverOpenPanelMode
} from '@/types/settings'

interface SettingsPanelProps {
  open: boolean
  settings: AppSettings
  onChange: (next: AppSettings) => void
}

function setField<K extends keyof AppSettings>(settings: AppSettings, key: K, value: AppSettings[K]): AppSettings {
  return { ...settings, [key]: value }
}

function shortcutInputSize(value: string): number {
  return Math.max(6, Math.min(18, value.trim().length + 1))
}

function normalizeShortcutKey(key: string): string | null {
  if (!key) {
    return null
  }

  if (key.length === 1) {
    return key.toUpperCase()
  }

  if (key === ' ') {
    return 'Space'
  }

  if (key === 'Escape') {
    return 'Esc'
  }

  if (key === 'Control') {
    return 'Ctrl'
  }

  if (key === 'Meta') {
    return 'Meta'
  }

  if (key === 'Alt') {
    return 'Alt'
  }

  if (key === 'Shift') {
    return 'Shift'
  }

  if (key === 'Enter' || key === 'Tab') {
    return key
  }

  if (/^F\d{1,2}$/i.test(key)) {
    return key.toUpperCase()
  }

  return null
}

function buildShortcutFromEvent(event: KeyboardEvent<HTMLInputElement>): string | null {
  const key = normalizeShortcutKey(event.key)
  const modifiers: string[] = []

  if (event.ctrlKey) {
    modifiers.push('Ctrl')
  }
  if (event.altKey) {
    modifiers.push('Alt')
  }
  if (event.metaKey) {
    modifiers.push('Meta')
  }
  if (event.shiftKey) {
    modifiers.push('Shift')
  }

  if (!key) {
    return null
  }

  if (key === 'Ctrl' || key === 'Alt' || key === 'Meta' || key === 'Shift') {
    return null
  }

  return [...modifiers, key].join('+')
}

export function SettingsPanel({ open, settings, onChange }: SettingsPanelProps) {
  if (!open) {
    return null
  }

  const copy = getSettingsCopy(settings.target_language)

  const handleShortcutCapture =
    (field: 'ocr_hotkey' | 'hotkey_translate_shortcut') =>
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Tab') {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Backspace' || event.key === 'Delete') {
        onChange(setField(settings, field, ''))
        return
      }

      const shortcut = buildShortcutFromEvent(event)
      if (!shortcut) {
        if (event.key === 'Shift') {
          const nextShortcut =
            field === 'hotkey_translate_shortcut'
              ? 'Shift'
              : 'Alt+A'
          onChange(setField(settings, field, nextShortcut))
        }
        return
      }

      onChange(setField(settings, field, shortcut))
    }

  const swapLanguages = () => {
    const nextSource = settings.target_language
    const nextTarget = settings.source_language === 'auto' ? 'en' : settings.source_language
    onChange({
      ...settings,
      source_language: nextSource,
      target_language: nextTarget
    })
  }

  const swapQuickLanguages = () => {
    const nextSource = settings.quick_translate_target_language
    const nextTarget = settings.quick_translate_source_language === 'auto' ? 'en' : settings.quick_translate_source_language
    onChange({
      ...settings,
      quick_translate_source_language: nextSource,
      quick_translate_target_language: nextTarget
    })
  }

  const convertEnabled = settings.enable_hotkey_translate
  const profileUrl = 'https://langochung.me'

  const handleProfileClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    try {
      await invoke('open_external_url', { url: profileUrl })
    } catch {
      window.open(profileUrl, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <section className="apl-settings-root" role="dialog" aria-modal="true" aria-label={copy.title}>
      <div className="apl-settings-main">
        <div className="apl-settings-left-col">
          <article className="apl-settings-card">
            <div className="apl-settings-card-header">
              <div className="apl-settings-card-title">{copy.popoverSectionTitle}</div>
            </div>
            <div className="apl-settings-card-body">
              <div className="apl-settings-language-row">
                <label className="apl-settings-field">
                  <span>{copy.inputLanguage}</span>
                  <select
                    value={settings.source_language}
                    onChange={(e) => onChange(setField(settings, 'source_language', e.target.value as AppSettings['source_language']))}
                  >
                    {INPUT_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>{lang.label}</option>
                    ))}
                  </select>
                </label>

                <button type="button" className="apl-settings-swap-languages" aria-label={copy.swapLanguages} onClick={swapLanguages}>⇄</button>

                <label className="apl-settings-field">
                  <span>{copy.outputLanguage}</span>
                  <select
                    value={settings.target_language}
                    onChange={(e) => onChange(setField(settings, 'target_language', e.target.value as AppSettings['target_language']))}
                  >
                    {OUTPUT_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>{lang.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="apl-settings-inline-check" role="group" aria-label={copy.autoTranslateOnSelect}>
                <input
                  type="checkbox"
                  checked={settings.popover_trigger_mode === 'auto'}
                  onChange={(event) =>
                    onChange(
                      setField(
                        settings,
                        'popover_trigger_mode',
                        event.target.checked ? 'auto' : 'shortcut',
                      ),
                    )
                  }
                />
                <span>{copy.autoTranslateOnSelect}</span>
              </label>

              <div className="apl-settings-sep">
                <div className="apl-settings-sep-label">OCR Capture</div>
                <div className="apl-settings-ocr-inline">
                  <label className="apl-settings-hotkey-merged">
                    <input
                      type="checkbox"
                      checked={settings.enable_ocr}
                      onChange={(event) => onChange(setField(settings, 'enable_ocr', event.target.checked))}
                      aria-label={copy.enableOcr}
                    />
                    <span className="apl-settings-hk-label">{copy.ocrShortcut}</span>
                    <input
                      type="text"
                      value={settings.ocr_hotkey}
                      size={shortcutInputSize(settings.ocr_hotkey)}
                      placeholder={copy.shortcutPlaceholder}
                      readOnly
                      disabled={!settings.enable_ocr}
                      onKeyDown={handleShortcutCapture('ocr_hotkey')}
                    />
                  </label>
                  <div
                    className="apl-settings-radio-col apl-settings-radio-col--ocr-inline"
                    role="group"
                    aria-label={copy.ocrParagraphDisplayMode}
                  >
                    <label className="apl-settings-radio-item">
                      <input
                        type="radio"
                        name="apl-ocr-paragraph-display-mode"
                        value="popover"
                        checked={settings.ocr_paragraph_display_mode === 'popover'}
                        onChange={() =>
                          onChange(
                            setField(
                              settings,
                              'ocr_paragraph_display_mode',
                              'popover' as OcrParagraphDisplayMode,
                            ),
                          )
                        }
                        disabled={!settings.enable_ocr}
                      />
                      <span>{copy.ocrDisplayPopover}</span>
                    </label>
                    <label className="apl-settings-radio-item">
                      <input
                        type="radio"
                        name="apl-ocr-paragraph-display-mode"
                        value="image"
                        checked={settings.ocr_paragraph_display_mode === 'image'}
                        onChange={() =>
                          onChange(
                            setField(
                              settings,
                              'ocr_paragraph_display_mode',
                              'image' as OcrParagraphDisplayMode,
                            ),
                          )
                        }
                        disabled={!settings.enable_ocr}
                      />
                      <span>{copy.ocrDisplayImage}</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </article>

          <article className={`apl-settings-card ${convertEnabled ? '' : 'is-disabled'}`}>
            <div className="apl-settings-card-header">
              <div className="apl-settings-card-title">{copy.convertSectionTitle}</div>
            </div>
            <div className="apl-settings-card-body">
              <div className="apl-settings-language-row">
                <label className="apl-settings-field">
                  <span>{copy.quickInputLanguage}</span>
                  <select
                    value={settings.quick_translate_source_language}
                    disabled={!convertEnabled}
                    onChange={(e) => onChange(setField(settings, 'quick_translate_source_language', e.target.value as AppSettings['quick_translate_source_language']))}
                  >
                    {INPUT_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>{lang.label}</option>
                    ))}
                  </select>
                </label>

                <button type="button" className="apl-settings-swap-languages" aria-label={copy.swapLanguages} onClick={swapQuickLanguages} disabled={!convertEnabled}>⇄</button>

                <label className="apl-settings-field">
                  <span>{copy.quickOutputLanguage}</span>
                  <select
                    value={settings.quick_translate_target_language}
                    disabled={!convertEnabled}
                    onChange={(e) => onChange(setField(settings, 'quick_translate_target_language', e.target.value as AppSettings['quick_translate_target_language']))}
                  >
                    {OUTPUT_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>{lang.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="apl-settings-inline-check" role="group" aria-label={copy.quickCtrlEnterTranslateSend}>
                <input
                  type="checkbox"
                  checked={settings.hotkey_translate_ctrl_enter_send}
                  disabled={!convertEnabled}
                  onChange={(event) => onChange(setField(settings, 'hotkey_translate_ctrl_enter_send', event.target.checked))}
                />
                <span>{copy.quickCtrlEnterTranslateSend}</span>
              </label>

              <div className="apl-settings-sep">
                <div className="apl-settings-sep-label">{copy.quickTranslateShortcut}</div>
                <label className="apl-settings-hotkey-merged">
                  <input
                    type="checkbox"
                    checked={settings.enable_hotkey_translate}
                    onChange={(event) => onChange(setField(settings, 'enable_hotkey_translate', event.target.checked))}
                    aria-label={copy.enableQuickTranslateHotkey}
                  />
                  <span className="apl-settings-hk-label">{copy.enableQuickTranslateHotkey}</span>
                  <input
                    type="text"
                    value={settings.hotkey_translate_shortcut}
                    size={shortcutInputSize(settings.hotkey_translate_shortcut)}
                    placeholder={copy.shortcutPlaceholder}
                    readOnly
                    disabled={!convertEnabled}
                    onKeyDown={handleShortcutCapture('hotkey_translate_shortcut')}
                  />
                </label>
              </div>
            </div>
          </article>
        </div>

        <div className="apl-settings-right-col">
          <article className="apl-settings-card">
            <div className="apl-settings-card-header">
              <div className="apl-settings-card-title">{copy.panelMode}</div>
            </div>
            <div className="apl-settings-card-body">
              <div className="apl-settings-radio-col">
                <label className="apl-settings-radio-item">
                  <input
                    type="radio"
                    name="apl-panel-mode"
                    value="none"
                    checked={settings.popover_open_panel_mode === 'none'}
                    onChange={() => onChange(setField(settings, 'popover_open_panel_mode', 'none' as PopoverOpenPanelMode))}
                  />
                  <span>{copy.panelNone}</span>
                </label>
                <label className="apl-settings-radio-item">
                  <input
                    type="radio"
                    name="apl-panel-mode"
                    value="details"
                    checked={settings.popover_open_panel_mode === 'details'}
                    onChange={() => onChange(setField(settings, 'popover_open_panel_mode', 'details' as PopoverOpenPanelMode))}
                  />
                  <span>{copy.panelDetails}</span>
                </label>
                <label className="apl-settings-radio-item">
                  <input
                    type="radio"
                    name="apl-panel-mode"
                    value="images"
                    checked={settings.popover_open_panel_mode === 'images'}
                    onChange={() => onChange(setField(settings, 'popover_open_panel_mode', 'images' as PopoverOpenPanelMode))}
                  />
                  <span>{copy.panelImages}</span>
                </label>
              </div>
            </div>
          </article>

          <article className="apl-settings-card">
            <div className="apl-settings-card-header">
              <div className="apl-settings-card-title">{copy.definitionLanguageMode}</div>
            </div>
            <div className="apl-settings-card-body">
              <div className="apl-settings-radio-col">
                <label className="apl-settings-radio-item">
                  <input
                    type="radio"
                    name="apl-definition-mode"
                    value="output"
                    checked={settings.popover_definition_language_mode === 'output'}
                    onChange={() => onChange(setField(settings, 'popover_definition_language_mode', 'output' as PopoverDefinitionLanguageMode))}
                  />
                  <span>{copy.modeOutput}</span>
                </label>
                <label className="apl-settings-radio-item">
                  <input
                    type="radio"
                    name="apl-definition-mode"
                    value="input"
                    checked={settings.popover_definition_language_mode === 'input'}
                    onChange={() => onChange(setField(settings, 'popover_definition_language_mode', 'input' as PopoverDefinitionLanguageMode))}
                  />
                  <span>{copy.modeInput}</span>
                </label>
                <label className="apl-settings-radio-item">
                  <input
                    type="radio"
                    name="apl-definition-mode"
                    value="english"
                    checked={settings.popover_definition_language_mode === 'english'}
                    onChange={() => onChange(setField(settings, 'popover_definition_language_mode', 'english' as PopoverDefinitionLanguageMode))}
                  />
                  <span>{copy.modeEnglish}</span>
                </label>
              </div>
            </div>
          </article>

          <article className="apl-settings-card">
            <div className="apl-settings-card-header">
              <div className="apl-settings-card-title">{copy.autoPlayAudio}</div>
            </div>
            <div className="apl-settings-card-body">
              <div className="apl-settings-radio-col">
                <label className="apl-settings-radio-item">
                  <input
                    type="radio"
                    name="apl-audio-mode"
                    value="off"
                    checked={settings.auto_play_audio_mode === 'off'}
                    onChange={() => onChange(setField(settings, 'auto_play_audio_mode', 'off' as AutoPlayAudioMode))}
                  />
                  <span>{copy.audioOff}</span>
                </label>
                <label className="apl-settings-radio-item">
                  <input
                    type="radio"
                    name="apl-audio-mode"
                    value="word"
                    checked={settings.auto_play_audio_mode === 'word'}
                    onChange={() => onChange(setField(settings, 'auto_play_audio_mode', 'word' as AutoPlayAudioMode))}
                  />
                  <span>{copy.audioWord}</span>
                </label>
                <label className="apl-settings-radio-item">
                  <input
                    type="radio"
                    name="apl-audio-mode"
                    value="all"
                    checked={settings.auto_play_audio_mode === 'all'}
                    onChange={() => onChange(setField(settings, 'auto_play_audio_mode', 'all' as AutoPlayAudioMode))}
                  />
                  <span>{copy.audioAll}</span>
                </label>
              </div>
            </div>
          </article>

          <a
            className="apl-settings-profile-card apl-settings-profile-card--link"
            href={profileUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open langochung.me"
            onClick={(event) => {
              void handleProfileClick(event)
            }}
          >
            <div className="apl-settings-avatar">AVT</div>
            <div className="apl-settings-profile-meta">
              <div className="apl-settings-profile-name">langochung.me</div>
            </div>
          </a>
        </div>
      </div>
    </section>
  )
}

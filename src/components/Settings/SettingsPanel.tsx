import { INPUT_LANGUAGES, OUTPUT_LANGUAGES } from '@/constants/languages'
import type { KeyboardEvent } from 'react'
import { getSettingsCopy } from '@/constants/settingsI18n'
import type {
  AppSettings,
  AutoPlayAudioMode,
  PopoverDefinitionLanguageMode,
  PopoverOpenPanelMode,
  PopoverTriggerMode
} from '@/types/settings'

interface SettingsPanelProps {
  open: boolean
  settings: AppSettings
  onChange: (next: AppSettings) => void
}

function setField<K extends keyof AppSettings>(settings: AppSettings, key: K, value: AppSettings[K]): AppSettings {
  return { ...settings, [key]: value }
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
    (field: 'popover_shortcut' | 'ocr_hotkey' | 'hotkey_translate_shortcut') =>
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
              : field === 'ocr_hotkey'
                ? 'Ctrl+Shift+S'
                : 'Ctrl+Shift+D'
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

  const setTriggerMode = (mode: PopoverTriggerMode) => {
    onChange(setField(settings, 'popover_trigger_mode', mode))
  }

  return (
    <section className="apl-settings-root" role="dialog" aria-modal="true" aria-label={copy.title}>

      <div className="apl-settings-sections">
        <div className="apl-settings-section">
          <h3>{copy.popoverSectionTitle}</h3>

          <div className="apl-settings-language-row">
            <label className="apl-settings-field">
              <span>{copy.inputLanguage}</span>
              <select value={settings.source_language} onChange={(e) => onChange(setField(settings, 'source_language', e.target.value as AppSettings['source_language']))}>
                {INPUT_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </label>

            <button type="button" className="apl-settings-swap-languages" aria-label={copy.swapLanguages} onClick={swapLanguages}>↔</button>

            <label className="apl-settings-field">
              <span>{copy.outputLanguage}</span>
              <select value={settings.target_language} onChange={(e) => onChange(setField(settings, 'target_language', e.target.value as AppSettings['target_language']))}>
                {OUTPUT_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="apl-settings-section">
            <label className="apl-settings-radio">
              <input type="radio" name="apl-trigger-mode" value="auto" checked={settings.popover_trigger_mode === 'auto'} onChange={() => setTriggerMode('auto')} />
              <span className="apl-settings-radio-label">{copy.triggerAuto}</span>
            </label>

            <div className="apl-settings-radio-shortcut-row">
              <label className="apl-settings-radio apl-settings-radio--inline">
                <input type="radio" name="apl-trigger-mode" value="shortcut" checked={settings.popover_trigger_mode === 'shortcut'} onChange={() => setTriggerMode('shortcut')} />
                <span className="apl-settings-radio-label">{copy.triggerShortcut}</span>
              </label>

              <div className="apl-settings-shortcut-group">
                <label className="apl-settings-field apl-settings-field--shortcut-inline">
                  <span>{copy.popoverShortcut}</span>
                  <input
                    className="apl-settings-shortcut-input"
                    value={settings.popover_shortcut}
                    placeholder={copy.shortcutPlaceholder}
                    readOnly
                    disabled={settings.popover_trigger_mode !== 'shortcut'}
                    onKeyDown={handleShortcutCapture('popover_shortcut')}
                  />
                </label>
              </div>
            </div>

            <div className="apl-settings-shortcut-group">
              <div className="apl-settings-hint">{copy.shortcutHint}</div>
            </div>

            <div className="apl-settings-shortcut-group">
              <div className="apl-settings-hint">{copy.ocrLanguageHint}</div>
              <label className="apl-settings-ocr-hotkey-row">
                <input
                  type="checkbox"
                  checked={settings.enable_ocr}
                  onChange={(event) => onChange(setField(settings, 'enable_ocr', event.target.checked))}
                  aria-label={copy.enableOcr}
                />
                <span className="apl-settings-ocr-hotkey-label">{copy.ocrShortcut}</span>
                <input
                  className="apl-settings-shortcut-input"
                  value={settings.ocr_hotkey}
                  placeholder={copy.shortcutPlaceholder}
                  readOnly
                  disabled={!settings.enable_ocr}
                  onKeyDown={handleShortcutCapture('ocr_hotkey')}
                />
              </label>
            </div>
          </div>

          <div className="apl-settings-panel-definition-layout">
            <div className="apl-settings-panel-definition-column">
              <div className="apl-settings-section-title">{copy.panelMode}</div>
              <label className="apl-settings-radio">
                <input type="radio" name="apl-panel-mode" value="none" checked={settings.popover_open_panel_mode === 'none'} onChange={() => onChange(setField(settings, 'popover_open_panel_mode', 'none' as PopoverOpenPanelMode))} />
                <span className="apl-settings-radio-label">{copy.panelNone}</span>
              </label>
              <label className="apl-settings-radio">
                <input type="radio" name="apl-panel-mode" value="details" checked={settings.popover_open_panel_mode === 'details'} onChange={() => onChange(setField(settings, 'popover_open_panel_mode', 'details' as PopoverOpenPanelMode))} />
                <span className="apl-settings-radio-label">{copy.panelDetails}</span>
              </label>
              <label className="apl-settings-radio">
                <input type="radio" name="apl-panel-mode" value="images" checked={settings.popover_open_panel_mode === 'images'} onChange={() => onChange(setField(settings, 'popover_open_panel_mode', 'images' as PopoverOpenPanelMode))} />
                <span className="apl-settings-radio-label">{copy.panelImages}</span>
              </label>
            </div>

            <div className="apl-settings-panel-definition-column apl-settings-panel-definition-column--right">
              <div className="apl-settings-section-title">{copy.definitionLanguageMode}</div>
              <label className="apl-settings-radio">
                <input type="radio" name="apl-definition-mode" value="output" checked={settings.popover_definition_language_mode === 'output'} onChange={() => onChange(setField(settings, 'popover_definition_language_mode', 'output' as PopoverDefinitionLanguageMode))} />
                <span className="apl-settings-radio-label">{copy.modeOutput}</span>
              </label>
              <label className="apl-settings-radio">
                <input type="radio" name="apl-definition-mode" value="input" checked={settings.popover_definition_language_mode === 'input'} onChange={() => onChange(setField(settings, 'popover_definition_language_mode', 'input' as PopoverDefinitionLanguageMode))} />
                <span className="apl-settings-radio-label">{copy.modeInput}</span>
              </label>
              <label className="apl-settings-radio">
                <input type="radio" name="apl-definition-mode" value="english" checked={settings.popover_definition_language_mode === 'english'} onChange={() => onChange(setField(settings, 'popover_definition_language_mode', 'english' as PopoverDefinitionLanguageMode))} />
                <span className="apl-settings-radio-label">{copy.modeEnglish}</span>
              </label>
            </div>
          </div>

          <div className="apl-settings-section">
            <div className="apl-settings-section-title">{copy.autoPlayAudio}</div>
            <label className="apl-settings-radio">
              <input type="radio" name="apl-audio-mode" value="off" checked={settings.auto_play_audio_mode === 'off'} onChange={() => onChange(setField(settings, 'auto_play_audio_mode', 'off' as AutoPlayAudioMode))} />
              <span className="apl-settings-radio-label">{copy.audioOff}</span>
            </label>
            <label className="apl-settings-radio">
              <input type="radio" name="apl-audio-mode" value="word" checked={settings.auto_play_audio_mode === 'word'} onChange={() => onChange(setField(settings, 'auto_play_audio_mode', 'word' as AutoPlayAudioMode))} />
              <span className="apl-settings-radio-label">{copy.audioWord}</span>
            </label>
            <label className="apl-settings-radio">
              <input type="radio" name="apl-audio-mode" value="all" checked={settings.auto_play_audio_mode === 'all'} onChange={() => onChange(setField(settings, 'auto_play_audio_mode', 'all' as AutoPlayAudioMode))} />
              <span className="apl-settings-radio-label">{copy.audioAll}</span>
            </label>
          </div>
        </div>

        <div className="apl-settings-section">
          <h3>{copy.convertSectionTitle}</h3>
          <div className="apl-settings-grid">
            <label className="apl-settings-field">
              <span>{copy.quickInputLanguage}</span>
              <select value={settings.quick_translate_source_language} onChange={(e) => onChange(setField(settings, 'quick_translate_source_language', e.target.value as AppSettings['quick_translate_source_language']))}>
                {INPUT_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </label>

            <label className="apl-settings-field">
              <span>{copy.quickOutputLanguage}</span>
              <select value={settings.quick_translate_target_language} onChange={(e) => onChange(setField(settings, 'quick_translate_target_language', e.target.value as AppSettings['quick_translate_target_language']))}>
                {OUTPUT_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </label>

            <label className="apl-settings-field">
              <span>{copy.quickTranslateShortcut}</span>
              <input
                value={settings.hotkey_translate_shortcut}
                placeholder={copy.shortcutPlaceholder}
                readOnly
                onKeyDown={handleShortcutCapture('hotkey_translate_shortcut')}
              />
            </label>
          </div>
        </div>
      </div>

    </section>
  )
}

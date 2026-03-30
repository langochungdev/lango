import { INPUT_LANGUAGES, OUTPUT_LANGUAGES } from '@/constants/languages'
import type { KeyboardEvent } from 'react'
import { getSettingsCopy } from '@/constants/settingsI18n'
import type {
  AppSettings,
  AutoPlayAudioMode,
  PopoverDefinitionLanguageMode,
  PopoverOpenPanelMode
} from '@/types/settings'

interface SettingsPanelProps {
  open: boolean
  settings: AppSettings
  onChange: (next: AppSettings) => void
  onClose?: () => void
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

export function SettingsPanel({ open, settings, onChange, onClose }: SettingsPanelProps) {
  if (!open) {
    return null
  }

  const copy = getSettingsCopy(settings.target_language)

  const handleShortcutCapture =
    (field: 'popover_shortcut' | 'hotkey_translate_shortcut') =>
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
          const nextShortcut = field === 'hotkey_translate_shortcut' ? 'Shift' : 'Ctrl+Shift+D'
          onChange(setField(settings, field, nextShortcut))
        }
        return
      }

      onChange(setField(settings, field, shortcut))
    }

  return (
    <section className="apl-settings-root" role="dialog" aria-modal="true" aria-labelledby="apl-settings-title">
      <h2 id="apl-settings-title">{copy.title}</h2>

      <div className="apl-settings-sections">
        <div className="apl-settings-section">
          <div className="apl-settings-grid">
            <label>
              {copy.inputLanguage}
              <select value={settings.source_language} onChange={(e) => onChange(setField(settings, 'source_language', e.target.value as AppSettings['source_language']))}>
                {INPUT_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </label>

            <label>
              {copy.outputLanguage}
              <select value={settings.target_language} onChange={(e) => onChange(setField(settings, 'target_language', e.target.value as AppSettings['target_language']))}>
                {OUTPUT_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </label>

            <label>
              {copy.definitionLanguageMode}
              <select
                value={settings.popover_definition_language_mode}
                onChange={(e) => onChange(setField(settings, 'popover_definition_language_mode', e.target.value as PopoverDefinitionLanguageMode))}
              >
                <option value="output">{copy.modeOutput}</option>
                <option value="input">{copy.modeInput}</option>
                <option value="english">{copy.modeEnglish}</option>
              </select>
            </label>

            <label>
              {copy.popoverShortcut}
              <input
                value={settings.popover_shortcut}
                placeholder={copy.shortcutPlaceholder}
                readOnly
                onKeyDown={handleShortcutCapture('popover_shortcut')}
              />
            </label>

            <label>
              {copy.panelMode}
              <select
                value={settings.popover_open_panel_mode}
                onChange={(e) => onChange(setField(settings, 'popover_open_panel_mode', e.target.value as PopoverOpenPanelMode))}
              >
                <option value="none">{copy.panelNone}</option>
                <option value="details">{copy.panelDetails}</option>
                <option value="images">{copy.panelImages}</option>
              </select>
            </label>

            <label>
              {copy.autoPlayAudio}
              <select value={settings.auto_play_audio_mode} onChange={(e) => onChange(setField(settings, 'auto_play_audio_mode', e.target.value as AutoPlayAudioMode))}>
                <option value="off">{copy.audioOff}</option>
                <option value="word">{copy.audioWord}</option>
                <option value="all">{copy.audioAll}</option>
              </select>
            </label>

            <label>
              {copy.quickTranslateShortcut}
              <input
                value={settings.hotkey_translate_shortcut}
                placeholder={copy.shortcutPlaceholder}
                readOnly
                onKeyDown={handleShortcutCapture('hotkey_translate_shortcut')}
              />
            </label>

            <label>
              {copy.quickInputLanguage}
              <select value={settings.quick_translate_source_language} onChange={(e) => onChange(setField(settings, 'quick_translate_source_language', e.target.value as AppSettings['quick_translate_source_language']))}>
                {INPUT_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </label>

            <label>
              {copy.quickOutputLanguage}
              <select value={settings.quick_translate_target_language} onChange={(e) => onChange(setField(settings, 'quick_translate_target_language', e.target.value as AppSettings['quick_translate_target_language']))}>
                {OUTPUT_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      {onClose && (
        <footer className="apl-settings-actions">
          <button type="button" onClick={onClose}>{copy.close}</button>
        </footer>
      )}
    </section>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Popover } from '@/components/Popover/Popover'
import { DebugLogWindow } from '@/components/DebugLog/DebugLogWindow'
import { SettingsPanel } from '@/components/Settings/SettingsPanel'
import { getSettingsCopy } from '@/constants/settingsI18n'
import { usePopover } from '@/hooks/usePopover'
import { loadSettings, saveSettings } from '@/services/config'
import { appendDebugLog } from '@/services/debugLog'
import type { SelectionAnchor } from '@/types/selectionAnchor'
import { DEFAULT_SETTINGS, sanitizeSettings, type AppSettings } from '@/types/settings'

interface SelectionEventPayload {
  text: string
  trigger: 'auto' | 'shortcut'
  anchor?: SelectionAnchor | null
}

type SettingsUpdatedPayload = Partial<AppSettings>

interface HotkeyTranslationPayload {
  original: string
  translated: string
  source: string
  target: string
  shortcut: string
}

type SettingsStatus =
  | 'ready'
  | 'usingDefaults'
  | 'saving'
  | 'autoSaved'
  | 'saveFailed'
  | 'hotkeyTranslated'

const WINDOW_MODE =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('window')

const IS_POPOVER_WINDOW = WINDOW_MODE === 'popover'
const IS_HOTKEY_INDICATOR_WINDOW = WINDOW_MODE === 'hotkey-indicator'
const IS_DEBUG_LOG_WINDOW = WINDOW_MODE === 'debug-log'

function shortText(value: string, max = 72): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) {
    return clean
  }
  return `${clean.slice(0, max)}...`
}

function changedSettingKeys(previous: AppSettings, next: AppSettings): string[] {
  const keys = Object.keys(next) as Array<keyof AppSettings>
  return keys.filter((key) => previous[key] !== next[key]).map((key) => String(key))
}

function SettingsWindow() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState<SettingsStatus>('ready')
  const [loadingSettings, setLoadingSettings] = useState(true)
  const settingsRef = useRef<AppSettings>(DEFAULT_SETTINGS)
  const saveSequenceRef = useRef(0)
  const copy = getSettingsCopy(settings.target_language)

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    let mounted = true
    const setup = async () => {
      try {
        const current = await loadSettings()
        if (mounted) {
          setSettings(current)
          setStatus('ready')
          appendDebugLog(
            'settings',
            'Loaded settings',
            `popover=${current.source_language}->${current.target_language} quick=${current.quick_translate_source_language}->${current.quick_translate_target_language}`
          )
        }
      } catch {
        if (mounted) {
          setSettings(DEFAULT_SETTINGS)
          setStatus('usingDefaults')
          appendDebugLog('settings', 'Load settings failed, using defaults')
        }
      } finally {
        if (mounted) {
          setLoadingSettings(false)
        }
      }
    }
    void setup()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    let cleanupHotkey: (() => void) | null = null
    let cleanupSettingsUpdated: (() => void) | null = null
    const setupEvents = async () => {
      try {
        const unlistenHotkey = await listen<HotkeyTranslationPayload>('hotkey-translated', (event) => {
          const translated = event.payload.translated.trim()
          if (translated) {
            setStatus('hotkeyTranslated')
            appendDebugLog(
              'hotkey',
              'Quick translate replaced active text',
              `${event.payload.source}->${event.payload.target} | from="${shortText(event.payload.original)}" to="${shortText(translated)}"`
            )
          }
        })
        cleanupHotkey = unlistenHotkey
      } catch {
        cleanupHotkey = null
      }

      try {
        const unlistenSettingsUpdated = await listen<SettingsUpdatedPayload>('settings-updated', (event) => {
          setSettings((previous) => sanitizeSettings({ ...previous, ...event.payload }))
        })
        cleanupSettingsUpdated = unlistenSettingsUpdated
      } catch {
        cleanupSettingsUpdated = null
      }
    }
    void setupEvents()
    return () => {
      cleanupHotkey?.()
      cleanupSettingsUpdated?.()
    }
  }, [])

  const handleSettingsChange = useCallback((next: AppSettings) => {
    const previous = settingsRef.current
    const changedKeys = changedSettingKeys(previous, next)
    setSettings(next)

    if (changedKeys.length === 0) {
      return
    }

    const saveId = saveSequenceRef.current + 1
    saveSequenceRef.current = saveId
    setStatus('saving')
    appendDebugLog('settings', 'Auto-save settings', changedKeys.join(', '))

    void (async () => {
      try {
        const saved = await saveSettings(next)
        if (saveId !== saveSequenceRef.current) {
          return
        }
        settingsRef.current = saved
        setSettings(saved)
        setStatus('autoSaved')
        appendDebugLog('settings', 'Auto-save success', changedKeys.join(', '))
      } catch (cause) {
        if (saveId !== saveSequenceRef.current) {
          return
        }
        const reason = cause instanceof Error ? cause.message : 'unknown save error'
        setStatus('saveFailed')
        appendDebugLog('settings', 'Auto-save failed', reason)
      }
    })()
  }, [])

  const statusMessage = useMemo(() => {
    if (status === 'ready') {
      return copy.ready
    }
    if (status === 'usingDefaults') {
      return copy.usingDefaults
    }
    if (status === 'saving') {
      return copy.saving
    }
    if (status === 'autoSaved') {
      return copy.autoSaved
    }
    if (status === 'hotkeyTranslated') {
      return copy.hotkeyTranslated
    }
    return copy.saveFailed
  }, [copy, status])

  const openDebugWindow = useCallback(() => {
    void invoke('show_debug_window')
  }, [])

  return (
    <main className="apl-settings-shell">
      <p className="apl-meta">{statusMessage}</p>

      <div className="apl-settings-toolbar">
        <button type="button" onClick={openDebugWindow}>Open Debug Window</button>
      </div>

      {loadingSettings && (
        <section className="apl-settings-boot" role="status" aria-live="polite">
          <div className="apl-settings-boot-card" />
          <div className="apl-settings-boot-card" />
          <div className="apl-settings-boot-card" />
        </section>
      )}

      <SettingsPanel
        open
        settings={settings}
        onChange={handleSettingsChange}
      />
    </main>
  )
}

function PopoverWindow() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [selectionAnchor, setSelectionAnchor] = useState<SelectionAnchor | null>(null)
  const lastLoggedStateRef = useRef<string>('idle')
  const { state, data, error, close, openFromSelection } = usePopover(settings)

  const consumePendingSelection = useCallback(async () => {
    try {
      const pending = await invoke<SelectionEventPayload | null>('take_pending_selection')
      if (pending?.text.trim()) {
        setSelectionAnchor(pending.anchor ?? null)
        appendDebugLog('popover', 'Consume pending selection', `${pending.trigger} | "${shortText(pending.text)}"`)
        await openFromSelection(pending.text, pending.trigger)
      }
    } catch {
      return
    }
  }, [openFromSelection])

  useEffect(() => {
    let mounted = true
    const setup = async () => {
      try {
        const current = await loadSettings()
        if (mounted) {
          setSettings(current)
          appendDebugLog(
            'popover',
            'Loaded settings for popover',
            `popover=${current.source_language}->${current.target_language}`
          )
        }
      } catch {
        if (mounted) {
          setSettings(DEFAULT_SETTINGS)
          appendDebugLog('popover', 'Load settings failed, using defaults')
        }
      }
    }
    void setup()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    let cleanupSettingsUpdated: (() => void) | null = null
    const setupSettingsSync = async () => {
      try {
        const unlistenSettingsUpdated = await listen<SettingsUpdatedPayload>('settings-updated', (event) => {
          setSettings((previous) => sanitizeSettings({ ...previous, ...event.payload }))
        })
        cleanupSettingsUpdated = unlistenSettingsUpdated
      } catch {
        cleanupSettingsUpdated = null
      }
    }
    void setupSettingsSync()
    return () => {
      cleanupSettingsUpdated?.()
    }
  }, [])

  useEffect(() => {
    let cleanupSelection: (() => void) | null = null
    const setupEvents = async () => {
      try {
        const unlistenSelection = await listen<SelectionEventPayload>('selection-changed', (event) => {
          setSelectionAnchor(event.payload.anchor ?? null)
          appendDebugLog('popover', 'Selection changed', `${event.payload.trigger} | "${shortText(event.payload.text)}"`)
          void openFromSelection(event.payload.text, event.payload.trigger)
        })
        cleanupSelection = unlistenSelection
      } catch {
        cleanupSelection = null
      }

      await consumePendingSelection()
    }
    void setupEvents()
    return () => {
      cleanupSelection?.()
    }
  }, [consumePendingSelection, openFromSelection])

  const closePopover = useCallback((reason?: string) => {
    close()
    if (reason) {
      appendDebugLog('popover', 'Close popover', reason)
    }
    void invoke('hide_popover')
  }, [close])

  useEffect(() => {
    if (state === lastLoggedStateRef.current) {
      return
    }
    lastLoggedStateRef.current = state

    if (state === 'loading') {
      appendDebugLog('popover', 'Request started', `"${shortText(data.selectedText)}"`)
      return
    }

    if (state === 'lookup' && data.dictionary) {
      appendDebugLog(
        'popover',
        'Lookup success',
        `"${shortText(data.selectedText)}" | provider=${data.dictionary.provider}`
      )
      return
    }

    if (state === 'translate' && data.translation) {
      appendDebugLog(
        'popover',
        'Translate success',
        `"${shortText(data.selectedText)}" | ${data.translation.mode} | ${data.translation.engine}`
      )
      return
    }

    if (state === 'error') {
      appendDebugLog('popover', 'Request failed', error ?? 'unknown error')
      return
    }

    if (state === 'idle') {
      appendDebugLog('popover', 'Popover idle')
    }
  }, [data.dictionary, data.selectedText, data.translation, error, state])

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePopover('escape')
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => {
      window.removeEventListener('keydown', onKeydown)
    }
  }, [closePopover])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      const popover = document.querySelector('.apl-popover')
      const subpanel = document.querySelector('.apl-subpanel')
      if (!target) {
        return
      }
      if (popover?.contains(target) || subpanel?.contains(target)) {
        return
      }
      closePopover('outside-click')
    }

    const onWindowBlur = () => {
      closePopover('window-blur')
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [closePopover])

  const openSettingsWindow = useCallback(() => {
    appendDebugLog('popover', 'Open settings window')
    void invoke('show_settings_window')
  }, [])

  return (
    <main className="apl-popover-shell">
      <Popover
        state={state}
        selection={data.selectedText}
        dictionary={data.dictionary}
        translation={data.translation}
        error={error}
        panelMode={settings.popover_open_panel_mode}
        enableAudio={settings.enable_audio}
        autoPlayAudioMode={settings.auto_play_audio_mode}
        selectionAnchor={selectionAnchor}
        onOpenSettings={openSettingsWindow}
      />
    </main>
  )
}

function HotkeyIndicatorWindow() {
  return (
    <main className="apl-hotkey-indicator-shell" role="status" aria-live="polite" />
  )
}

export function App() {
  useEffect(() => {
    document.body.classList.toggle('apl-popover-body', IS_POPOVER_WINDOW)
    document.body.classList.toggle('apl-hotkey-indicator-body', IS_HOTKEY_INDICATOR_WINDOW)
    document.body.classList.toggle('apl-debug-body', IS_DEBUG_LOG_WINDOW)
    return () => {
      document.body.classList.remove('apl-popover-body')
      document.body.classList.remove('apl-hotkey-indicator-body')
      document.body.classList.remove('apl-debug-body')
    }
  }, [])

  if (IS_HOTKEY_INDICATOR_WINDOW) {
    return <HotkeyIndicatorWindow />
  }

  if (IS_POPOVER_WINDOW) {
    return <PopoverWindow />
  }

  if (IS_DEBUG_LOG_WINDOW) {
    return <DebugLogWindow />
  }

  return <SettingsWindow />
}

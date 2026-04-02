import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Popover } from '@/components/Popover/Popover'
import { DebugLogWindow } from '@/components/DebugLog/DebugLogWindow'
import { OcrOverlayWindow } from '@/components/OcrOverlay/OcrOverlayWindow'
import { SettingsPanel } from '@/components/Settings/SettingsPanel'
import { getSettingsCopy } from '@/constants/settingsI18n'
import { usePopover, type PopoverState } from '@/hooks/usePopover'
import { loadSettings, saveSettings } from '@/services/config'
import {
  appendDebugLog,
  clearDebugLogs,
  copyDebugLogsToClipboard,
  isDebugTraceEnabled,
} from '@/services/debugLog'
import type { DictionaryResult } from '@/services/dictionary'
import type { TranslateResult } from '@/services/translate'
import type { SelectionAnchor } from '@/types/selectionAnchor'
import { DEFAULT_SETTINGS, sanitizeSettings, type AppSettings } from '@/types/settings'

interface SelectionEventPayload {
  event_id?: number
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

interface HotkeyTracePayload {
  stage?: string
  shortcut?: string
  detail?: string
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
const PREVIEW_MODE =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('preview') === '1'

const IS_POPOVER_WINDOW = WINDOW_MODE === 'popover'
const IS_HOTKEY_INDICATOR_WINDOW = WINDOW_MODE === 'hotkey-indicator'
const IS_OCR_OVERLAY_WINDOW = WINDOW_MODE === 'ocr-overlay'
const IS_DEBUG_LOG_WINDOW = WINDOW_MODE === 'debug-log'
const IS_PREVIEW_WINDOW = WINDOW_MODE === 'preview' || PREVIEW_MODE
const DEBUG_TRACE_ENABLED = isDebugTraceEnabled()

const MOCK_DICTIONARY: DictionaryResult = {
  word: 'mindset',
  phonetic: '/ˈmaɪndset/',
  audio_url: null,
  audio_lang: 'en',
  provider: 'mock',
  fallback_used: false,
  meanings: [
    {
      part_of_speech: 'noun',
      definitions: [
        'A set of attitudes or fixed ideas that affect how someone interprets and responds to situations.',
        'A mental inclination or habit that strongly influences behavior and decisions.',
        'A way of thinking that can support growth, resilience, and long-term learning in challenging environments.'
      ],
      example: 'A growth mindset helps teams adapt quickly to changing requirements.',
    },
    {
      part_of_speech: 'noun',
      definitions: [
        'The established set of assumptions held by an individual or group.',
        'A person\'s characteristic frame of mind and worldview.'
      ],
      example: 'Their collaborative mindset improved product quality significantly.',
    }
  ],
}

const MOCK_TRANSLATION: TranslateResult = {
  result: 'tu duy\ncach nghi',
  engine: 'mock-engine',
  mode: 'direct',
}

type PreviewTab = 'settings' | 'popover'
type PreviewScenario = 'lookup' | 'translate' | 'loading' | 'error'
type PreviewHorizontalEdge = 'left' | 'right'
type PreviewVerticalEdge = 'top' | 'bottom'

function shortText(value: string, max = 72): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) {
    return clean
  }
  return `${clean.slice(0, max)}...`
}

function anchorSummary(anchor?: SelectionAnchor | null): string {
  if (!anchor) {
    return 'anchor=none'
  }

  if (anchor.rect) {
    const left = Math.min(anchor.rect.left, anchor.rect.right)
    const top = Math.min(anchor.rect.top, anchor.rect.bottom)
    const right = Math.max(anchor.rect.left, anchor.rect.right)
    const bottom = Math.max(anchor.rect.top, anchor.rect.bottom)
    return `anchorRect=(${left},${top})-(${right},${bottom})`
  }

  if (anchor.point) {
    return `anchorPoint=(${anchor.point.x},${anchor.point.y})`
  }

  return 'anchor=empty'
}

function anchorFingerprint(anchor?: SelectionAnchor | null): string {
  if (!anchor) {
    return 'none'
  }

  if (anchor.rect) {
    const left = Math.min(anchor.rect.left, anchor.rect.right)
    const top = Math.min(anchor.rect.top, anchor.rect.bottom)
    const right = Math.max(anchor.rect.left, anchor.rect.right)
    const bottom = Math.max(anchor.rect.top, anchor.rect.bottom)
    return `rect:${left}:${top}:${right}:${bottom}`
  }

  if (anchor.point) {
    return `point:${anchor.point.x}:${anchor.point.y}`
  }

  return 'empty'
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

  useEffect(() => {
    const hasTauriBridge = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void invoke('hide_settings_window').catch(() => undefined)
      }
    }
    
    const onWindowBlur = () => {
      void invoke('hide_settings_window').catch(() => undefined)
    }

    let cleanupTauriFocus: (() => void) | null = null
    if (hasTauriBridge) {
      void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) {
          void invoke('hide_settings_window').catch(() => undefined)
        }
      }).then((unlisten) => {
        cleanupTauriFocus = unlisten
      }).catch(() => undefined)
    }

    window.addEventListener('keydown', onKeydown)
    window.addEventListener('blur', onWindowBlur)
    
    return () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('blur', onWindowBlur)
      cleanupTauriFocus?.()
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

  return (
    <main className={`apl-settings-shell ${status === 'saving' ? 'is-saving' : ''}`}>
      <div className="apl-settings-status-bar apl-settings-status-bar--compact" aria-live="polite">
        <span className={`apl-settings-status-dot ${status === 'ready' || status === 'autoSaved' ? 'is-active' : ''}`} />
        <span>{statusMessage}</span>
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
  const stateRef = useRef<PopoverState>('idle')
  const anchorRef = useRef<SelectionAnchor | null>(null)
  const lastLoggedStateRef = useRef<string>('idle')
  const lastSelectionEventRef = useRef<{ key: string; at: number; eventId: number | null }>({ key: '', at: 0, eventId: null })
  const lastHotkeyEventRef = useRef({ copyAt: 0, clearAt: 0 })
  const { state, data, error, close, openFromSelection } = usePopover(settings)
  const hasTauriBridge = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  useEffect(() => {
    stateRef.current = state
    anchorRef.current = selectionAnchor
  }, [selectionAnchor, state])

  const exportTraceLogs = useCallback((source: 'local-f8' | 'global-f8') => {
    const now = Date.now()
    if (now - lastHotkeyEventRef.current.copyAt < 900) {
      return
    }
    lastHotkeyEventRef.current.copyAt = now
    appendDebugLog(
      'trace',
      'F8 trace export requested',
      `${source} | ${stateRef.current} | ${anchorSummary(anchorRef.current)}`,
    )
    void (async () => {
      const copied = await copyDebugLogsToClipboard()
      appendDebugLog(
        'trace',
        copied ? 'F8 trace export copied' : 'F8 trace export failed',
        source,
      )
    })()
  }, [])

  const clearTraceLogs = useCallback((source: 'local-f7' | 'global-f7') => {
    const now = Date.now()
    if (now - lastHotkeyEventRef.current.clearAt < 250) {
      return
    }
    lastHotkeyEventRef.current.clearAt = now
    clearDebugLogs()
    if (source === 'local-f7') {
      appendDebugLog('trace', 'F7 trace logs cleared', source)
    }
  }, [])

  const processSelectionEvent = useCallback(async (payload: SelectionEventPayload, source: 'pending' | 'event') => {
    const text = payload.text.trim()
    if (!text) {
      return
    }

    const anchor = payload.anchor ?? null
    const key = `${payload.trigger}|${text}|${anchorFingerprint(anchor)}`
    const now = Date.now()
    const incomingEventId = Number.isFinite(payload.event_id) ? Number(payload.event_id) : null
    const sameEventId =
      incomingEventId !== null &&
      lastSelectionEventRef.current.eventId !== null &&
      incomingEventId === lastSelectionEventRef.current.eventId
    const isDuplicate =
      sameEventId ||
      (lastSelectionEventRef.current.key === key &&
        now - lastSelectionEventRef.current.at <= 450)

    if (isDuplicate) {
      appendDebugLog(
        'popover',
        'Skip duplicate selection',
        `${source} | ${payload.trigger} | "${shortText(text)}" | ${anchorSummary(anchor)}`,
      )
      return
    }

    lastSelectionEventRef.current = {
      key,
      at: now,
      eventId: incomingEventId,
    }
    setSelectionAnchor(anchor)
    appendDebugLog(
      'popover',
      source === 'pending' ? 'Consume pending selection' : 'Selection changed',
      `${payload.trigger} | "${shortText(text)}" | ${anchorSummary(anchor)}`,
    )
    await openFromSelection(text, payload.trigger)
  }, [openFromSelection])

  const consumePendingSelection = useCallback(async () => {
    try {
      const pending = await invoke<SelectionEventPayload | null>('take_pending_selection')
      if (pending) {
        await processSelectionEvent(pending, 'pending')
      }
    } catch {
      return
    }
  }, [processSelectionEvent])

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

  const closePopover = useCallback((reason?: string) => {
    close()
    if (reason) {
      appendDebugLog('popover', 'Close popover', reason)
    }
    void invoke('hide_popover')
  }, [close])

  useEffect(() => {
    let cleanupSelection: (() => void) | null = null
    let cleanupForceClose: (() => void) | null = null
    const setupEvents = async () => {
      try {
        const unlistenSelection = await listen<SelectionEventPayload>('selection-changed', (event) => {
          void processSelectionEvent(event.payload, 'event')
        })
        cleanupSelection = unlistenSelection
      } catch {
        cleanupSelection = null
      }

      try {
        const unlistenForceClose = await listen<string>('force-close-popover', (event) => {
          const reason = typeof event.payload === 'string' && event.payload.trim()
            ? event.payload
            : 'native-force-close'
          closePopover(reason)
        })
        cleanupForceClose = unlistenForceClose
      } catch {
        cleanupForceClose = null
      }

      await consumePendingSelection()
    }
    void setupEvents()
    return () => {
      cleanupSelection?.()
      cleanupForceClose?.()
    }
  }, [closePopover, consumePendingSelection, processSelectionEvent])

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
    if (state === 'loading') {
      void invoke('show_loading_indicator').catch(() => undefined)
      return
    }

    void invoke('hide_loading_indicator').catch(() => undefined)
  }, [state])

  useEffect(() => {
    return () => {
      void invoke('hide_loading_indicator').catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    let cleanupDebugCopy: (() => void) | null = null
    let cleanupDebugClear: (() => void) | null = null
    let cleanupHotkeyTrace: (() => void) | null = null

    const setupDebugHotkeys = async () => {
      try {
        const unlistenDebugCopy = await listen('debug-copy-hotkey', () => {
          exportTraceLogs('global-f8')
        })
        cleanupDebugCopy = unlistenDebugCopy
      } catch {
        cleanupDebugCopy = null
      }

      try {
        const unlistenDebugClear = await listen('debug-clear-hotkey', () => {
          clearTraceLogs('global-f7')
        })
        cleanupDebugClear = unlistenDebugClear
      } catch {
        cleanupDebugClear = null
      }

      try {
        const unlistenHotkeyTrace = await listen<HotkeyTracePayload>('hotkey-trace', (event) => {
          const stage = typeof event.payload?.stage === 'string' && event.payload.stage.trim()
            ? event.payload.stage.trim()
            : 'unknown-stage'
          const shortcut = typeof event.payload?.shortcut === 'string' && event.payload.shortcut.trim()
            ? event.payload.shortcut.trim()
            : 'unknown-shortcut'
          const detail = typeof event.payload?.detail === 'string' && event.payload.detail.trim()
            ? event.payload.detail.trim()
            : ''
          appendDebugLog(
            'trace',
            `Hotkey ${stage}`,
            detail ? `${shortcut} | ${detail}` : shortcut,
          )
        })
        cleanupHotkeyTrace = unlistenHotkeyTrace
      } catch {
        cleanupHotkeyTrace = null
      }
    }
    if (DEBUG_TRACE_ENABLED) {
      void setupDebugHotkeys()
    }

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePopover('escape')
        return
      }

      if (hasTauriBridge) {
        return
      }

      if (!DEBUG_TRACE_ENABLED) {
        return
      }

      if (event.key === 'F7') {
        event.preventDefault()
        clearTraceLogs('local-f7')
        return
      }

      if (event.key === 'F8') {
        event.preventDefault()
        exportTraceLogs('local-f8')
      }
    }

    window.addEventListener('keydown', onKeydown)
    return () => {
      window.removeEventListener('keydown', onKeydown)
      cleanupDebugCopy?.()
      cleanupDebugClear?.()
      cleanupHotkeyTrace?.()
    }
  }, [clearTraceLogs, closePopover, exportTraceLogs, hasTauriBridge])

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

  useEffect(() => {
    const closeIfVisibleModel = (reason: string) => {
      if (stateRef.current !== 'idle') {
        closePopover(reason)
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        closeIfVisibleModel('desktop-switch-hidden')
      }
    }

    const onPageHide = () => {
      closeIfVisibleModel('desktop-switch-pagehide')
    }

    let cleanupTauriFocus: (() => void) | null = null
    if (hasTauriBridge) {
      const setupTauriFocus = async () => {
        try {
          const unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
            if (!focused) {
              closeIfVisibleModel('tauri-window-blur')
            }
          })
          cleanupTauriFocus = unlisten
        } catch {
          cleanupTauriFocus = null
        }
      }
      void setupTauriFocus()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      cleanupTauriFocus?.()
    }
  }, [closePopover, hasTauriBridge])

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
        onRequestClose={closePopover}
      />
    </main>
  )
}

function HotkeyIndicatorWindow() {
  const cancelLoading = useCallback(() => {
    void invoke('cancel_popover_loading').catch(() => undefined)
  }, [])

  return (
    <main
      className="apl-hotkey-indicator-shell"
      role="status"
      aria-live="polite"
      onPointerDown={cancelLoading}
    />
  )
}

function PreviewWindow() {
  const [tab, setTab] = useState<PreviewTab>('settings')
  const [settings, setSettings] = useState<AppSettings>({
    ...DEFAULT_SETTINGS,
    popover_open_panel_mode: 'details',
  })
  const [scenario, setScenario] = useState<PreviewScenario>('lookup')
  const [panelMode, setPanelMode] = useState<'none' | 'details'>('details')
  const [horizontalEdge, setHorizontalEdge] = useState<PreviewHorizontalEdge>('left')
  const [verticalEdge, setVerticalEdge] = useState<PreviewVerticalEdge>('top')

  const previewState: PopoverState =
    scenario === 'lookup'
      ? 'lookup'
      : scenario === 'translate'
        ? 'translate'
        : scenario === 'loading'
          ? 'loading'
          : 'error'

  const previewSelection = scenario === 'translate'
    ? 'Mindset shapes our daily decisions in subtle but meaningful ways.'
    : 'mindset'

  const previewDictionary = scenario === 'lookup' ? MOCK_DICTIONARY : null
  const previewTranslation = scenario === 'translate' ? MOCK_TRANSLATION : null
  const previewError = scenario === 'error' ? 'Mock preview error: service unavailable' : null

  const previewAnchor: SelectionAnchor | null = useMemo(() => {
    if (typeof window === 'undefined') {
      return null
    }
    const x = horizontalEdge === 'right'
      ? Math.max(220, window.innerWidth - 160)
      : 180
    const y = verticalEdge === 'bottom'
      ? Math.max(180, window.innerHeight - 120)
      : 120
    return { point: { x, y } }
  }, [horizontalEdge, verticalEdge])

  return (
    <main className="apl-preview-shell">
      <header className="apl-preview-header">
        <h1>UI Preview</h1>
        <p className="apl-meta">Mock data + real components. Run on browser without Tauri.</p>
      </header>

      <nav className="apl-preview-tabs" aria-label="Preview tabs">
        <button
          type="button"
          className={`apl-preview-tab${tab === 'settings' ? ' is-active' : ''}`}
          onClick={() => setTab('settings')}
        >
          Settings
        </button>
        <button
          type="button"
          className={`apl-preview-tab${tab === 'popover' ? ' is-active' : ''}`}
          onClick={() => setTab('popover')}
        >
          Popover + Subpanel Review
        </button>
      </nav>

      {tab === 'settings' ? (
        <section className="apl-preview-pane">
          <SettingsPanel
            open
            settings={settings}
            onChange={(next) => setSettings(next)}
          />
        </section>
      ) : (
        <section className="apl-preview-pane">
          <div className="apl-preview-toolbar">
            <label className="apl-preview-control">
              <span>Scenario</span>
              <select value={scenario} onChange={(event) => setScenario(event.target.value as PreviewScenario)}>
                <option value="lookup">Lookup</option>
                <option value="translate">Translate</option>
                <option value="loading">Loading</option>
                <option value="error">Error</option>
              </select>
            </label>

            <label className="apl-preview-control">
              <span>Subpanel</span>
              <select value={panelMode} onChange={(event) => setPanelMode(event.target.value as 'none' | 'details')}>
                <option value="details">Details</option>
                <option value="none">None</option>
              </select>
            </label>

            <label className="apl-preview-control">
              <span>Horizontal edge</span>
              <select value={horizontalEdge} onChange={(event) => setHorizontalEdge(event.target.value as PreviewHorizontalEdge)}>
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </label>

            <label className="apl-preview-control">
              <span>Vertical edge</span>
              <select value={verticalEdge} onChange={(event) => setVerticalEdge(event.target.value as PreviewVerticalEdge)}>
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
              </select>
            </label>
          </div>

          <div className={`apl-preview-stage apl-preview-stage--h-${horizontalEdge} apl-preview-stage--v-${verticalEdge}`}>
            <div className="apl-preview-anchor">
              <main className="apl-popover-shell apl-popover-shell--preview">
                <Popover
                  state={previewState}
                  selection={previewSelection}
                  dictionary={previewDictionary}
                  translation={previewTranslation}
                  error={previewError}
                  panelMode={panelMode}
                  enableAudio={settings.enable_audio}
                  autoPlayAudioMode={settings.auto_play_audio_mode}
                  selectionAnchor={previewAnchor}
                />
              </main>
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

export function App() {
  useEffect(() => {
    const isSettings = !IS_POPOVER_WINDOW && !IS_HOTKEY_INDICATOR_WINDOW && !IS_OCR_OVERLAY_WINDOW && !IS_DEBUG_LOG_WINDOW && !IS_PREVIEW_WINDOW
    document.body.classList.toggle('apl-settings-body', isSettings)
    document.body.classList.toggle('apl-popover-body', IS_POPOVER_WINDOW)
    document.body.classList.toggle('apl-hotkey-indicator-body', IS_HOTKEY_INDICATOR_WINDOW)
    document.body.classList.toggle('apl-ocr-overlay-body', IS_OCR_OVERLAY_WINDOW)
    document.body.classList.toggle('apl-debug-body', IS_DEBUG_LOG_WINDOW)
    document.body.classList.toggle('apl-preview-body', IS_PREVIEW_WINDOW)
    return () => {
      document.body.classList.remove('apl-settings-body')
      document.body.classList.remove('apl-popover-body')
      document.body.classList.remove('apl-hotkey-indicator-body')
      document.body.classList.remove('apl-ocr-overlay-body')
      document.body.classList.remove('apl-debug-body')
      document.body.classList.remove('apl-preview-body')
    }
  }, [])

  if (IS_HOTKEY_INDICATOR_WINDOW) {
    return <HotkeyIndicatorWindow />
  }

  if (IS_OCR_OVERLAY_WINDOW) {
    return <OcrOverlayWindow />
  }

  if (IS_POPOVER_WINDOW) {
    return <PopoverWindow />
  }

  if (IS_DEBUG_LOG_WINDOW) {
    return <DebugLogWindow />
  }

  if (IS_PREVIEW_WINDOW) {
    return <PreviewWindow />
  }

  return <SettingsWindow />
}

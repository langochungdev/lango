import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Popover } from '@/components/Popover/Popover'
import { DebugLogWindow } from '@/components/DebugLog/DebugLogWindow'
import { OcrOverlayWindow } from '@/components/OcrOverlay/OcrOverlayWindow'
import { QuickConvertPopup } from '@/components/QuickConvert/QuickConvertPopup'
import { SettingsPanel } from '@/components/Settings/SettingsPanel'
import { getSettingsCopy } from '@/constants/settingsI18n'
import { usePopover, type PopoverState, type PopoverTrigger } from '@/hooks/usePopover'
import { loadSettings, saveSettings } from '@/services/config'
import { quickConvertText, type QuickConvertResult } from '@/services/quickConvert'
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
  trigger: 'auto' | 'shortcut' | 'ocr' | 'ocr-image-overlay'
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

interface QuickConvertOpenedPayload {
  text: string
  shortcut: string
}

interface UpdateAvailablePayload {
  current_version: string
  latest_version: string
  url: string
  prerelease: boolean
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
const IS_QUICK_CONVERT_WINDOW = WINDOW_MODE === 'quick-convert'
const IS_PREVIEW_WINDOW = WINDOW_MODE === 'preview' || PREVIEW_MODE
const IS_SETTINGS_WINDOW = !IS_POPOVER_WINDOW && !IS_HOTKEY_INDICATOR_WINDOW && !IS_OCR_OVERLAY_WINDOW && !IS_DEBUG_LOG_WINDOW && !IS_QUICK_CONVERT_WINDOW && !IS_PREVIEW_WINDOW
const DEBUG_TRACE_ENABLED = isDebugTraceEnabled()
const DEFAULT_RELEASES_PAGE = 'https://dictover.langochung.me/releases'
let updateCheckBootstrapped = false

if (typeof window !== 'undefined' && IS_SETTINGS_WINDOW) {
  clearDebugLogs()
  appendDebugLog('trace', 'Trace logs reset', 'app-bootstrap')
}

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

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message
  }
  if (typeof cause === 'string') {
    return cause
  }
  try {
    return JSON.stringify(cause)
  } catch {
    return String(cause)
  }
}

function SettingsWindow() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState<SettingsStatus>('ready')
  const [updateAvailable, setUpdateAvailable] = useState<UpdateAvailablePayload | null>(null)
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState('')
  const lastAppliedUpdateKeyRef = useRef('')
  const settingsRef = useRef<AppSettings>(DEFAULT_SETTINGS)
  const saveSequenceRef = useRef(0)
  const shellRef = useRef<HTMLElement | null>(null)
  const lastSyncedWindowHeightRef = useRef(0)
  const copy = getSettingsCopy(settings.target_language)
  const hasTauriBridge = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  const shouldShowUpdate = useCallback((payload: UpdateAvailablePayload): boolean => {
    return payload.latest_version.trim() !== dismissedUpdateVersion.trim()
  }, [dismissedUpdateVersion])

  const applyIncomingUpdate = useCallback((payload: UpdateAvailablePayload | null, source: string) => {
    if (!payload) {
      appendDebugLog('update', 'No update payload', source)
      return
    }

    const payloadKey = `${payload.current_version}::${payload.latest_version}::${payload.prerelease ? '1' : '0'}`
    if (payloadKey === lastAppliedUpdateKeyRef.current) {
      appendDebugLog('update', 'Duplicate update payload ignored', `${source} | latest=${payload.latest_version}`)
      return
    }
    lastAppliedUpdateKeyRef.current = payloadKey

    appendDebugLog(
      'update',
      'Update payload received',
      `${source} | current=${payload.current_version} latest=${payload.latest_version} prerelease=${payload.prerelease ? '1' : '0'}`,
    )
    if (shouldShowUpdate(payload)) {
      setUpdateAvailable(payload)
      appendDebugLog('update', 'Update modal shown', `${source} | latest=${payload.latest_version}`)
      return
    }
    appendDebugLog('update', 'Update modal suppressed', `${source} | dismissed=${dismissedUpdateVersion || 'none'}`)
  }, [dismissedUpdateVersion, shouldShowUpdate])

  const closeSettingsWindow = useCallback(() => {
    if (!hasTauriBridge) {
      return
    }
    void invoke('hide_settings_window').catch(() => undefined)
  }, [hasTauriBridge])

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
    if (updateCheckBootstrapped) {
      appendDebugLog('update', 'Setup update check skipped', 'already-bootstrapped')
      return
    }
    updateCheckBootstrapped = true

    appendDebugLog('update', 'Setup update check', `settings-window-mounted | bridge=${hasTauriBridge ? '1' : '0'}`)
    if (!hasTauriBridge) {
      appendDebugLog('update', 'Setup update check skipped', 'no-tauri-bridge')
      return
    }

    let cleanupUpdate: (() => void) | null = null
    const setupUpdate = async () => {
      appendDebugLog('update', 'Update check attempt', 'attempt=1')

      try {
        const unlisten = await listen<UpdateAvailablePayload>('update-available', (event) => {
          applyIncomingUpdate(event.payload, 'event:update-available')
        })
        cleanupUpdate = unlisten
        appendDebugLog('update', 'Update event listener ready', 'event:update-available')
      } catch (cause) {
        cleanupUpdate = null
        appendDebugLog('update', 'Update event listener failed', describeCause(cause))
      }

      try {
        const fresh = await invoke<UpdateAvailablePayload | null>('check_for_updates_now')
        if (fresh) {
          applyIncomingUpdate(fresh, 'invoke:check_for_updates_now')
          return
        }
        appendDebugLog('update', 'No fresh update', 'invoke:check_for_updates_now')
      } catch (cause) {
        appendDebugLog('update', 'Fresh update check failed', describeCause(cause))
      }

      try {
        const pending = await invoke<UpdateAvailablePayload | null>('get_pending_update')
        if (pending) {
          applyIncomingUpdate(pending, 'invoke:get_pending_update')
          return
        }
        appendDebugLog('update', 'No update payload', 'invoke:get_pending_update')
      } catch (cause) {
        appendDebugLog('update', 'Pending update read failed', describeCause(cause))
      }
    }

    void setupUpdate()
    return () => {
      cleanupUpdate?.()
    }
  }, [applyIncomingUpdate, hasTauriBridge])

  useEffect(() => {
    if (!updateAvailable) {
      appendDebugLog('update', 'Update state', 'hidden')
      return
    }
    appendDebugLog('update', 'Update state', `visible | latest=${updateAvailable.latest_version}`)
  }, [updateAvailable])

  const dismissUpdateBanner = useCallback(() => {
    if (updateAvailable?.latest_version) {
      setDismissedUpdateVersion(updateAvailable.latest_version)
      appendDebugLog('update', 'Update modal dismissed by user', `latest=${updateAvailable.latest_version}`)
    }
    setUpdateAvailable(null)
  }, [updateAvailable?.latest_version])

  const openUpdatePage = useCallback(() => {
    const url = updateAvailable?.url?.trim() || DEFAULT_RELEASES_PAGE
    if (!hasTauriBridge) {
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
    void invoke('open_external_url', { url }).catch(() => undefined)
  }, [hasTauriBridge, updateAvailable?.url])

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'F7') {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (event.key === 'Escape') {
        closeSettingsWindow()
      }
    }

    window.addEventListener('keydown', onKeydown)
    
    return () => {
      window.removeEventListener('keydown', onKeydown)
    }
  }, [closeSettingsWindow])

  useEffect(() => {
    if (!hasTauriBridge) {
      return
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      const shell = shellRef.current
      if (!target || !shell) {
        return
      }
      if (shell.contains(target)) {
        return
      }
      closeSettingsWindow()
    }

    const onWindowBlur = () => {
      closeSettingsWindow()
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('blur', onWindowBlur)

    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [closeSettingsWindow, hasTauriBridge])

  const syncSettingsWindowSize = useCallback(async () => {
    if (!hasTauriBridge || !shellRef.current) {
      return
    }

    const shell = shellRef.current
    const visibleHeight = Math.ceil(shell.getBoundingClientRect().height)
    const contentHeight = Math.ceil(shell.scrollHeight)
    const nextHeight = Math.max(180, Math.max(visibleHeight, contentHeight) + 12)
    if (Math.abs(nextHeight - lastSyncedWindowHeightRef.current) <= 1) {
      return
    }

    try {
      const currentWindow = getCurrentWindow()
      const innerSize = await currentWindow.innerSize()
      const scaleFactor = await currentWindow.scaleFactor()
      const logicalWidth = Math.max(720, Math.round(innerSize.width / scaleFactor))
      await currentWindow.setSize(new LogicalSize(logicalWidth, nextHeight))
      lastSyncedWindowHeightRef.current = nextHeight
    } catch {
      return
    }
  }, [hasTauriBridge])

  useEffect(() => {
    if (!hasTauriBridge) {
      return
    }

    let rafId = 0
    let focusSyncTimerId = 0
    let focusSyncTimerIdLate = 0
    let cleanupFocusChanged: (() => void) | null = null
    const scheduleSync = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId)
      }
      rafId = window.requestAnimationFrame(() => {
        void syncSettingsWindowSize()
      })
    }

    const observer = new ResizeObserver(() => {
      scheduleSync()
    })

    if (shellRef.current) {
      observer.observe(shellRef.current)
    }

    void (async () => {
      try {
        const unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (!focused) {
            return
          }
          scheduleSync()
          if (focusSyncTimerId) {
            window.clearTimeout(focusSyncTimerId)
          }
          if (focusSyncTimerIdLate) {
            window.clearTimeout(focusSyncTimerIdLate)
          }
          focusSyncTimerId = window.setTimeout(scheduleSync, 80)
          focusSyncTimerIdLate = window.setTimeout(scheduleSync, 220)
        })
        cleanupFocusChanged = unlisten
      } catch {
        cleanupFocusChanged = null
      }
    })()

    scheduleSync()
    window.addEventListener('resize', scheduleSync)

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId)
      }
      if (focusSyncTimerId) {
        window.clearTimeout(focusSyncTimerId)
      }
      if (focusSyncTimerIdLate) {
        window.clearTimeout(focusSyncTimerIdLate)
      }
      cleanupFocusChanged?.()
      observer.disconnect()
      window.removeEventListener('resize', scheduleSync)
    }
  }, [hasTauriBridge, syncSettingsWindowSize])

  const handleSettingsChange = useCallback((next: AppSettings) => {
    const previous = settingsRef.current
    const changedKeys = changedSettingKeys(previous, next)
    setSettings(next)

    void emit('settings-updated', sanitizeSettings(next)).catch(() => undefined)

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

  const handleResetDefaults = useCallback(() => {
    appendDebugLog('settings', 'Reset settings to defaults')
    handleSettingsChange(DEFAULT_SETTINGS)
  }, [handleSettingsChange])

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
    <main ref={shellRef} className={`apl-settings-shell ${status === 'saving' ? 'is-saving' : ''}`}>
      <div className="apl-settings-toolbar-clean">
        <div className="apl-settings-status-bar apl-settings-status-bar--compact" aria-live="polite">
          <span className={`apl-settings-status-dot ${status === 'ready' || status === 'autoSaved' ? 'is-active' : ''}`} />
          <span>{statusMessage}</span>
        </div>
        <button type="button" onClick={handleResetDefaults}>
          {copy.resetDefaults}
        </button>
      </div>

      {updateAvailable && (
        <section
          className="apl-update-banner apl-update-banner--floating"
          role="status"
          aria-live="polite"
          aria-labelledby="apl-update-title"
        >
          <div className="apl-update-banner-main">
            <h2 id="apl-update-title">Có bản cập nhật mới: {updateAvailable.latest_version}</h2>
            <p>Bạn đang dùng {updateAvailable.current_version}</p>
          </div>
          <div className="apl-update-banner-actions">
            <button type="button" className="apl-update-action" onClick={openUpdatePage}>
              Cập nhật ngay
            </button>
            <button
              type="button"
              className="apl-update-banner-close"
              onClick={dismissUpdateBanner}
              aria-label="Đóng thông báo cập nhật"
            >
              ×
            </button>
          </div>
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
  const activeTriggerRef = useRef<PopoverTrigger>('auto')
  const lastOcrOpenAtRef = useRef(0)
  const { state, data, error, close, openFromSelection } = usePopover(settings)
  const hasTauriBridge = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  useEffect(() => {
    stateRef.current = state
    anchorRef.current = selectionAnchor
    activeTriggerRef.current = data.trigger
    if (state !== 'idle' && data.trigger === 'ocr') {
      lastOcrOpenAtRef.current = Date.now()
    }
  }, [data.trigger, selectionAnchor, state])

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

    if (payload.trigger === 'ocr-image-overlay') {
      close()
      appendDebugLog(
        'popover',
        'OCR image overlay selection anchor ready',
        `${source} | ${anchorSummary(anchor)}`,
      )
      return
    }

    appendDebugLog(
      'popover',
      source === 'pending' ? 'Consume pending selection' : 'Selection changed',
      `${payload.trigger} | "${shortText(text)}" | ${anchorSummary(anchor)}`,
    )
    await openFromSelection(text, payload.trigger)
  }, [close, openFromSelection])

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

  const shouldIgnoreTransientOcrClose = useCallback((reason?: string) => {
    if (!reason || activeTriggerRef.current !== 'ocr') {
      return false
    }

    const age = Date.now() - lastOcrOpenAtRef.current
    if (age > 1400) {
      return false
    }

    return reason === 'window-blur'
      || reason === 'tauri-window-blur'
      || reason === 'window-focused-false'
      || reason === 'windows-desktop-switch-fg'
      || reason === 'desktop-switch-hidden'
      || reason === 'desktop-switch-pagehide'
  }, [])

  const closePopover = useCallback((reason?: string) => {
    if (shouldIgnoreTransientOcrClose(reason)) {
      appendDebugLog('popover', 'Skip transient close', reason ?? 'unknown-reason')
      return
    }

    close()
    if (reason) {
      appendDebugLog('popover', 'Close popover', reason)
    }
    void invoke('hide_popover')
  }, [close, shouldIgnoreTransientOcrClose])

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

    if (state === 'ocrImage' && data.ocrImageOverlay) {
      appendDebugLog(
        'popover',
        'OCR image overlay shown',
        `textLen=${data.ocrImageOverlay.text.length} | imageBytes=${data.ocrImageOverlay.imageBase64.length}`,
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
  }, [data.dictionary, data.ocrImageOverlay, data.selectedText, data.translation, error, state])

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
      if (event.key === 'F7') {
        event.preventDefault()
        event.stopPropagation()
        if (!hasTauriBridge && DEBUG_TRACE_ENABLED) {
          clearTraceLogs('local-f7')
        }
        return
      }

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
        trigger={data.trigger}
        lookupDisplayWord={data.lookupDisplayWord}
        lookupDisplayDefinition={data.lookupDisplayDefinition}
        dictionary={data.dictionary}
        translation={data.translation}
        ocrImageOverlay={data.ocrImageOverlay}
        error={error}
        panelMode={settings.popover_open_panel_mode}
        enableAudio={settings.enable_audio}
        autoPlayAudioMode={settings.auto_play_audio_mode}
        outputLanguage={settings.target_language}
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

function QuickConvertWindow() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [inputValue, setInputValue] = useState('')
  const [outputValue, setOutputValue] = useState('')
  const [result, setResult] = useState<QuickConvertResult | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  const [loading, setLoading] = useState(false)
  const settingsRef = useRef<AppSettings>(DEFAULT_SETTINGS)
  const saveSequenceRef = useRef(0)
  const lastHotkeyEventRef = useRef({ copyAt: 0, clearAt: 0 })
  const copy = getSettingsCopy(settings.target_language)
  const hasTauriBridge = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  const exportTraceLogs = useCallback((source: 'local-f8' | 'global-f8') => {
    const now = Date.now()
    if (now - lastHotkeyEventRef.current.copyAt < 900) {
      return
    }
    lastHotkeyEventRef.current.copyAt = now
    appendDebugLog(
      'trace',
      'F8 trace export requested',
      `${source} | quick-convert | loading=${loading ? 1 : 0} | inputLen=${inputValue.trim().length} | outputLen=${outputValue.trim().length}`,
    )
    void (async () => {
      const copied = await copyDebugLogsToClipboard()
      appendDebugLog(
        'trace',
        copied ? 'F8 trace export copied' : 'F8 trace export failed',
        source,
      )
    })()
  }, [inputValue, loading, outputValue])

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
        }
      } catch {
        if (mounted) {
          setSettings(DEFAULT_SETTINGS)
        }
      }
    }
    void setup()
    return () => {
      mounted = false
    }
  }, [])

  const persistSettings = useCallback((next: AppSettings) => {
    setSettings(next)
    settingsRef.current = next
    void emit('settings-updated', next).catch(() => undefined)

    const saveId = saveSequenceRef.current + 1
    saveSequenceRef.current = saveId
    void (async () => {
      try {
        const saved = await saveSettings(next)
        if (saveId !== saveSequenceRef.current) {
          return
        }
        settingsRef.current = saved
        setSettings(saved)
      } catch {
        return
      }
    })()
  }, [])

  const closeQuickConvert = useCallback((reason: string) => {
    appendDebugLog('quick-convert', 'Close quick convert', reason)
    void invoke('hide_quick_convert_window').catch(() => undefined)
  }, [])

  useEffect(() => {
    let cleanupDebugCopy: (() => void) | null = null
    let cleanupDebugClear: (() => void) | null = null

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
    }

    if (DEBUG_TRACE_ENABLED) {
      void setupDebugHotkeys()
    }

    const onDebugHotkeys = (event: KeyboardEvent) => {
      if (!DEBUG_TRACE_ENABLED) {
        return
      }

      if (event.key === 'F7') {
        event.preventDefault()
        event.stopPropagation()
        clearTraceLogs('local-f7')
        return
      }

      if (event.key === 'F8') {
        event.preventDefault()
        event.stopPropagation()
        exportTraceLogs('local-f8')
      }
    }

    window.addEventListener('keydown', onDebugHotkeys)

    return () => {
      window.removeEventListener('keydown', onDebugHotkeys)
      cleanupDebugCopy?.()
      cleanupDebugClear?.()
    }
  }, [clearTraceLogs, exportTraceLogs])

  useEffect(() => {
    let cleanupSettingsUpdated: (() => void) | null = null
    let cleanupQuickConvertOpened: (() => void) | null = null

    const setup = async () => {
      try {
        const unlistenSettingsUpdated = await listen<SettingsUpdatedPayload>('settings-updated', (event) => {
          setSettings((previous) => sanitizeSettings({ ...previous, ...event.payload }))
        })
        cleanupSettingsUpdated = unlistenSettingsUpdated
      } catch {
        cleanupSettingsUpdated = null
      }

      try {
        const unlistenQuickConvertOpened = await listen<QuickConvertOpenedPayload>('quick-convert-opened', (event) => {
          const seedText = event.payload.text ?? ''
          const hasSeed = seedText.trim().length > 0
          if (seedText.trim().length > 0) {
            setInputValue(seedText)
          }
          setOutputValue('')
          setResult(null)
          setFocusToken((current) => current + 1)
          appendDebugLog(
            'quick-convert',
            'Quick convert opened',
            `shortcut=${event.payload.shortcut || 'unknown'} seedLen=${seedText.trim().length} hasSeed=${hasSeed ? 1 : 0} preserveInput=${hasSeed ? 0 : 1}`,
          )
          appendDebugLog(
            'quick-convert',
            'Quick convert focus token requested',
            `seedLen=${seedText.trim().length}`,
          )
        })
        appendDebugLog('quick-convert', 'Quick convert opened listener ready')
        cleanupQuickConvertOpened = unlistenQuickConvertOpened
      } catch (error) {
        appendDebugLog(
          'quick-convert',
          'Quick convert opened listener failed',
          error instanceof Error ? error.message : String(error),
        )
        cleanupQuickConvertOpened = null
      }
    }

    void setup()
    return () => {
      cleanupSettingsUpdated?.()
      cleanupQuickConvertOpened?.()
    }
  }, [])

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeQuickConvert('escape')
      }
    }

    const onWindowBlur = () => {
      closeQuickConvert('window-blur')
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        closeQuickConvert('desktop-switch-hidden')
      }
    }

    const onPageHide = () => {
      closeQuickConvert('desktop-switch-pagehide')
    }

    let cleanupTauriFocus: (() => void) | null = null
    if (hasTauriBridge) {
      const setupTauriFocus = async () => {
        try {
          const unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
            if (!focused) {
              closeQuickConvert('tauri-window-blur')
            }
          })
          cleanupTauriFocus = unlisten
        } catch {
          cleanupTauriFocus = null
        }
      }
      void setupTauriFocus()
    }

    window.addEventListener('keydown', onKeydown)
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)

    return () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      cleanupTauriFocus?.()
    }
  }, [closeQuickConvert, hasTauriBridge])

  const submitQuickConvert = useCallback(() => {
    if (loading) {
      return
    }

    const text = inputValue.trim()
    if (!text) {
      setOutputValue('')
      setResult(null)
      return
    }

    const source = settingsRef.current.quick_translate_source_language
    const target = settingsRef.current.quick_translate_target_language
    setLoading(true)
    appendDebugLog(
      'quick-convert',
      'Submit quick convert',
      `source=${source} target=${target} textLen=${text.length} bridge=${hasTauriBridge ? 1 : 0} pos=${settingsRef.current.quick_convert_popup_position}`,
    )

    void (async () => {
      try {
        const converted = await quickConvertText({ text, source, target })
        setOutputValue(converted.result)
        setResult(converted)
        appendDebugLog(
          'quick-convert',
          'Quick convert success',
          `kind=${converted.kind} engine=${converted.engine} mode=${converted.mode} resultLen=${converted.result.trim().length} meta=${converted.word_data ? 1 : 0}`,
        )
      } catch (cause) {
        appendDebugLog(
          'quick-convert',
          'Quick convert primary failed, trying translate fallback',
          `source=${source} target=${target} cause=${describeCause(cause)}`,
        )
        try {
          const translated = await invoke<TranslateResult>('translate_text', {
            payload: { text, source, target },
          })
          setOutputValue(translated.result)
          setResult(null)
          appendDebugLog(
            'quick-convert',
            'Quick convert fallback success',
            `engine=${translated.engine} mode=${translated.mode} resultLen=${translated.result.trim().length}`,
          )
          return
        } catch (fallbackCause) {
          appendDebugLog(
            'quick-convert',
            'Quick convert fallback failed',
            `source=${source} target=${target} error=${describeCause(fallbackCause)}`,
          )
        }
        appendDebugLog(
          'quick-convert',
          'Quick convert failed',
          `source=${source} target=${target} error=${describeCause(cause)} online=${typeof navigator !== 'undefined' && navigator.onLine ? 1 : 0}`,
        )
        console.error('[quick-convert] request failed', {
          source,
          target,
          textLength: text.length,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      } finally {
        setLoading(false)
      }
    })()
  }, [hasTauriBridge, inputValue, loading])

  const setQuickLanguages = useCallback((source: AppSettings['quick_translate_source_language'], target: AppSettings['quick_translate_target_language']) => {
    const next = sanitizeSettings({
      ...settingsRef.current,
      quick_translate_source_language: source,
      quick_translate_target_language: target,
    })
    persistSettings(next)
  }, [persistSettings])

  const onSwapLanguages = useCallback(() => {
    const source = settingsRef.current.quick_translate_source_language
    const target = settingsRef.current.quick_translate_target_language
    const nextSource = target
    const nextTarget = source === 'auto' ? 'en' : source
    setQuickLanguages(nextSource, nextTarget)
  }, [setQuickLanguages])

  return (
    <main className="apl-quick-convert-shell">
      <QuickConvertPopup
        open
        focusToken={focusToken}
        copy={copy}
        positionMode={settings.quick_convert_popup_position}
        sourceLanguage={settings.quick_translate_source_language}
        targetLanguage={settings.quick_translate_target_language}
        inputValue={inputValue}
        outputValue={outputValue}
        result={result}
        onClose={closeQuickConvert}
        onSubmit={submitQuickConvert}
        onSwapLanguages={onSwapLanguages}
        onSourceLanguageChange={(value) => setQuickLanguages(value, settingsRef.current.quick_translate_target_language)}
        onTargetLanguageChange={(value) => setQuickLanguages(settingsRef.current.quick_translate_source_language, value)}
        onInputValueChange={(value) => {
          setInputValue(value)
          setOutputValue('')
          setResult(null)
        }}
      />
    </main>
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
                  trigger="shortcut"
                  dictionary={previewDictionary}
                  translation={previewTranslation}
                  error={previewError}
                  panelMode={panelMode}
                  enableAudio={settings.enable_audio}
                  autoPlayAudioMode={settings.auto_play_audio_mode}
                  outputLanguage={settings.target_language}
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
    const suppressCaretBrowsingHotkey = (event: KeyboardEvent) => {
      if (event.key !== 'F7') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }

    document.addEventListener('keydown', suppressCaretBrowsingHotkey, true)
    document.addEventListener('keyup', suppressCaretBrowsingHotkey, true)
    document.addEventListener('keypress', suppressCaretBrowsingHotkey, true)
    window.addEventListener('keydown', suppressCaretBrowsingHotkey, true)
    window.addEventListener('keyup', suppressCaretBrowsingHotkey, true)
    window.addEventListener('keypress', suppressCaretBrowsingHotkey, true)
    return () => {
      document.removeEventListener('keydown', suppressCaretBrowsingHotkey, true)
      document.removeEventListener('keyup', suppressCaretBrowsingHotkey, true)
      document.removeEventListener('keypress', suppressCaretBrowsingHotkey, true)
      window.removeEventListener('keydown', suppressCaretBrowsingHotkey, true)
      window.removeEventListener('keyup', suppressCaretBrowsingHotkey, true)
      window.removeEventListener('keypress', suppressCaretBrowsingHotkey, true)
    }
  }, [])

  useEffect(() => {
    if (!IS_SETTINGS_WINDOW) {
      return
    }

    const onBeforeUnload = () => {
      clearDebugLogs()
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [])

  useEffect(() => {
    document.body.classList.toggle('apl-settings-body', IS_SETTINGS_WINDOW)
    document.body.classList.toggle('apl-popover-body', IS_POPOVER_WINDOW)
    document.body.classList.toggle('apl-hotkey-indicator-body', IS_HOTKEY_INDICATOR_WINDOW)
    document.body.classList.toggle('apl-ocr-overlay-body', IS_OCR_OVERLAY_WINDOW)
    document.body.classList.toggle('apl-quick-convert-body', IS_QUICK_CONVERT_WINDOW)
    document.body.classList.toggle('apl-debug-body', IS_DEBUG_LOG_WINDOW)
    document.body.classList.toggle('apl-preview-body', IS_PREVIEW_WINDOW)
    return () => {
      document.body.classList.remove('apl-settings-body')
      document.body.classList.remove('apl-popover-body')
      document.body.classList.remove('apl-hotkey-indicator-body')
      document.body.classList.remove('apl-ocr-overlay-body')
      document.body.classList.remove('apl-quick-convert-body')
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

  if (IS_QUICK_CONVERT_WINDOW) {
    return <QuickConvertWindow />
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

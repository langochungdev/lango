import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Popover } from '@/components/Popover/Popover'
import { SettingsPanel } from '@/components/Settings/SettingsPanel'
import { usePopover } from '@/hooks/usePopover'
import { loadSettings, saveSettings } from '@/services/config'
import { DEFAULT_SETTINGS, type AppSettings } from '@/types/settings'

interface SelectionEventPayload {
  text: string
  trigger: 'auto' | 'shortcut'
}

interface HotkeyTranslationPayload {
  translated: string
}

const IS_POPOVER_WINDOW =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('window') === 'popover'

function SettingsWindow() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [statusMessage, setStatusMessage] = useState('Ready')

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
          setStatusMessage('Using default settings')
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
    const setupEvents = async () => {
      try {
        const unlistenHotkey = await listen<HotkeyTranslationPayload>('hotkey-translated', (event) => {
          if (event.payload.translated.trim()) {
            setStatusMessage('Global translate shortcut replaced active text')
          }
        })
        cleanupHotkey = unlistenHotkey
      } catch {
        cleanupHotkey = null
      }
    }
    void setupEvents()
    return () => {
      cleanupHotkey?.()
    }
  }, [])

  const handleSaveSettings = async () => {
    try {
      const saved = await saveSettings(settings)
      setSettings(saved)
      setStatusMessage('Settings saved')
    } catch {
      setStatusMessage('Failed to save settings')
    }
  }

  return (
    <main className="apl-settings-shell">
      <section className="apl-card">
        <h1>DictOver Settings</h1>
        <p>Window chính chỉ dùng để cấu hình. Popover và hotkey chạy toàn hệ thống qua native backend.</p>
        <p>{statusMessage}</p>
      </section>

      <SettingsPanel
        open
        settings={settings}
        onChange={setSettings}
        onSave={handleSaveSettings}
      />
    </main>
  )
}

function PopoverWindow() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const { state, data, error, close, openFromSelection } = usePopover(settings)

  const consumePendingSelection = useCallback(async () => {
    try {
      const pending = await invoke<SelectionEventPayload | null>('take_pending_selection')
      if (pending?.text.trim()) {
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

  useEffect(() => {
    let cleanupSelection: (() => void) | null = null
    const setupEvents = async () => {
      try {
        const unlistenSelection = await listen<SelectionEventPayload>('selection-changed', (event) => {
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

  const closePopover = useCallback(() => {
    close()
    void invoke('hide_popover')
  }, [close])

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePopover()
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => {
      window.removeEventListener('keydown', onKeydown)
    }
  }, [closePopover])

  return (
    <main className="apl-popover-shell">
      <Popover
        state={state}
        selection={data.selectedText}
        dictionary={data.dictionary}
        translation={data.translation}
        error={error}
        panelMode={settings.popover_open_panel_mode}
        onClose={closePopover}
      />
    </main>
  )
}

export function App() {
  useEffect(() => {
    document.body.classList.toggle('apl-popover-body', IS_POPOVER_WINDOW)
    return () => {
      document.body.classList.remove('apl-popover-body')
    }
  }, [])

  if (IS_POPOVER_WINDOW) {
    return <PopoverWindow />
  }

  return <SettingsWindow />
}

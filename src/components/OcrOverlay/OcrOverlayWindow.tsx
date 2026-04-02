import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { appendDebugLog } from '@/services/debugLog'
import { loadSettings } from '@/services/config'
import type { InputLanguageCode, OutputLanguageCode } from '@/constants/languages'
import type { AppSettings } from '@/types/settings'

const OCR_OVERLAY_HINTS: Record<OutputLanguageCode, string> = {
  vi: 'Kéo chuột để chọn vùng ảnh - Esc để hủy',
  en: 'Drag to select image area - Esc to cancel',
  'zh-CN': '拖动鼠标选择图像区域 - Esc 取消',
  ja: 'ドラッグして画像範囲を選択 - Escでキャンセル',
  ko: '드래그하여 이미지 영역 선택 - Esc로 취소',
  ru: 'Перетащите мышь, чтобы выбрать область изображения - Esc для отмены',
  de: 'Ziehen, um den Bildbereich auszuwählen - Esc zum Abbrechen',
  fr: 'Faites glisser pour sélectionner la zone d\'image - Échap pour annuler',
  fi: 'Valitse kuva-alue vetämällä - Esc peruuttaa',
}

interface DragPoint {
  viewX: number
  viewY: number
}

interface NormalizedRect {
  left: number
  top: number
  width: number
  height: number
}

interface OcrOverlayResultPayload {
  image_base64?: string
  text?: string
  original_text?: string
  left?: number
  top?: number
  width?: number
  height?: number
  source_language?: string
  target_language?: string
  original_text_len?: number
  translated_text_len?: number
  translation_applied?: boolean
  image_overlay_changed?: boolean
}

interface OverlayResultState {
  imageBase64: string
  text: string
  originalText: string
  left: number
  top: number
  width: number
  height: number
}

type OverlayMode = 'select' | 'processing' | 'result'
type CopyStatus = 'idle' | 'textCopied' | 'imageCopied' | 'failed'

type SettingsUpdatedPayload = Partial<AppSettings>

function resolveHintText(targetLanguage: OutputLanguageCode | undefined): string {
  if (!targetLanguage) {
    return OCR_OVERLAY_HINTS.en
  }
  return OCR_OVERLAY_HINTS[targetLanguage] ?? OCR_OVERLAY_HINTS.en
}

function normalizeRect(start: DragPoint, current: DragPoint): NormalizedRect {
  const viewLeft = Math.min(start.viewX, current.viewX)
  const viewTop = Math.min(start.viewY, current.viewY)
  const viewRight = Math.max(start.viewX, current.viewX)
  const viewBottom = Math.max(start.viewY, current.viewY)

  return {
    left: viewLeft,
    top: viewTop,
    width: viewRight - viewLeft,
    height: viewBottom - viewTop,
  }
}

function pointFromPointer(event: React.PointerEvent<HTMLElement>): DragPoint {
  return {
    viewX: event.clientX,
    viewY: event.clientY,
  }
}

export function OcrOverlayWindow() {
  const [start, setStart] = useState<DragPoint | null>(null)
  const [current, setCurrent] = useState<DragPoint | null>(null)
  const [mode, setMode] = useState<OverlayMode>('select')
  const [hintText, setHintText] = useState<string>(OCR_OVERLAY_HINTS.en)
  const [ocrSourceLanguage, setOcrSourceLanguage] = useState<InputLanguageCode>('auto')
  const [ocrTargetLanguage, setOcrTargetLanguage] = useState<OutputLanguageCode>('en')
  const [result, setResult] = useState<OverlayResultState | null>(null)
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')
  const copyStatusTimerRef = useRef<number | null>(null)
  const hasTauriBridge = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  useEffect(() => {
    let mounted = true
    let cleanupSettingsUpdated: (() => void) | null = null
    let cleanupReset: (() => void) | null = null
    let cleanupProcessing: (() => void) | null = null
    let cleanupResult: (() => void) | null = null

    void (async () => {
      try {
        const settings = await loadSettings()
        const next = resolveHintText(settings.target_language)
        if (mounted) {
          setHintText(next)
          setOcrSourceLanguage(settings.source_language)
          setOcrTargetLanguage(settings.target_language)
        }
      } catch {
        if (mounted) {
          setHintText(OCR_OVERLAY_HINTS.en)
          setOcrSourceLanguage('auto')
          setOcrTargetLanguage('en')
        }
      }
    })()

    void (async () => {
      try {
        const unlisten = await listen<SettingsUpdatedPayload>('settings-updated', (event) => {
          if (!mounted) {
            return
          }
          const next = resolveHintText(event.payload.target_language)
          setHintText(next)
          if (event.payload.source_language) {
            setOcrSourceLanguage(event.payload.source_language)
          }
          if (event.payload.target_language) {
            setOcrTargetLanguage(event.payload.target_language)
          }
        })
        cleanupSettingsUpdated = unlisten
      } catch {
        cleanupSettingsUpdated = null
      }
    })()

    void (async () => {
      try {
        const unlisten = await listen<string>('ocr-overlay-reset', () => {
          if (!mounted) {
            return
          }
          setStart(null)
          setCurrent(null)
          setResult(null)
          setCopyStatus('idle')
          setMode('select')
        })
        cleanupReset = unlisten
      } catch {
        cleanupReset = null
      }
    })()

    void (async () => {
      try {
        const unlisten = await listen<string>('ocr-overlay-processing', () => {
          if (!mounted) {
            return
          }
          setMode('processing')
          setResult(null)
        })
        cleanupProcessing = unlisten
      } catch {
        cleanupProcessing = null
      }
    })()

    void (async () => {
      try {
        const unlisten = await listen<OcrOverlayResultPayload>('ocr-overlay-result-ready', (event) => {
          if (!mounted) {
            return
          }

          const imageBase64 = typeof event.payload?.image_base64 === 'string'
            ? event.payload.image_base64.trim()
            : ''
          const width = Number.isFinite(event.payload?.width) ? Math.max(8, Math.round(Number(event.payload?.width))) : 8
          const height = Number.isFinite(event.payload?.height) ? Math.max(8, Math.round(Number(event.payload?.height))) : 8
          const left = Number.isFinite(event.payload?.left) ? Math.round(Number(event.payload?.left)) : 0
          const top = Number.isFinite(event.payload?.top) ? Math.round(Number(event.payload?.top)) : 0
          const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
          const originalText = typeof event.payload?.original_text === 'string'
            ? event.payload.original_text
            : text
          const sourceLanguage = typeof event.payload?.source_language === 'string' ? event.payload.source_language : 'unknown'
          const targetLanguage = typeof event.payload?.target_language === 'string' ? event.payload.target_language : 'unknown'
          const originalTextLen = Number.isFinite(event.payload?.original_text_len)
            ? Math.max(0, Math.round(Number(event.payload?.original_text_len)))
            : 0
          const translatedTextLen = Number.isFinite(event.payload?.translated_text_len)
            ? Math.max(0, Math.round(Number(event.payload?.translated_text_len)))
            : 0
          const translationApplied = event.payload?.translation_applied === true
          const imageOverlayChanged = event.payload?.image_overlay_changed === true

          if (!imageBase64) {
            return
          }

          setResult({
            imageBase64,
            text,
            originalText,
            left,
            top,
            width,
            height,
          })
          setMode('result')
          setCopyStatus('idle')
          appendDebugLog(
            'trace',
            'OCR overlay result ready',
            `rect=(${left},${top},${width},${height}) textLen=${text.trim().length} | ${sourceLanguage}->${targetLanguage} | originalLen=${originalTextLen} translatedLen=${translatedTextLen} translationApplied=${translationApplied} imageOverlayChanged=${imageOverlayChanged}`,
          )
        })
        cleanupResult = unlisten
      } catch {
        cleanupResult = null
      }
    })()

    return () => {
      mounted = false
      cleanupSettingsUpdated?.()
      cleanupReset?.()
      cleanupProcessing?.()
      cleanupResult?.()
    }
  }, [])

  useEffect(() => {
    return () => {
      if (copyStatusTimerRef.current !== null) {
        window.clearTimeout(copyStatusTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void invoke('cancel_ocr_overlay').catch(() => undefined)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    const closeOverlayWindow = () => {
      void invoke('cancel_ocr_overlay').catch(() => undefined)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        closeOverlayWindow()
      }
    }

    const onPageHide = () => {
      closeOverlayWindow()
    }

    let cleanupTauriFocus: (() => void) | null = null
    if (hasTauriBridge) {
      const setupTauriFocus = async () => {
        try {
          const unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
            if (!focused) {
              closeOverlayWindow()
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
  }, [hasTauriBridge])

  const selection = useMemo(() => {
    if (!start || !current) {
      return null
    }
    return normalizeRect(start, current)
  }, [current, start])

  const flashCopyStatus = useCallback((next: Exclude<CopyStatus, 'idle'>) => {
    setCopyStatus(next)
    if (copyStatusTimerRef.current !== null) {
      window.clearTimeout(copyStatusTimerRef.current)
    }
    copyStatusTimerRef.current = window.setTimeout(() => {
      setCopyStatus('idle')
      copyStatusTimerRef.current = null
    }, 1300)
  }, [])

  const closeOverlay = useCallback(() => {
    void invoke('cancel_ocr_overlay').catch(() => undefined)
  }, [])

  const copyResultImage = useCallback(async () => {
    if (!result?.imageBase64) {
      return
    }

    try {
      await invoke('copy_image_to_clipboard', { imageBase64: result.imageBase64 })
      flashCopyStatus('imageCopied')
    } catch {
      flashCopyStatus('failed')
    }
  }, [flashCopyStatus, result?.imageBase64])

  const copyResultText = useCallback(async () => {
    const payload = result?.originalText?.trim() ?? ''
    if (!payload) {
      return
    }

    try {
      await invoke('copy_text_to_clipboard', { text: payload })
      flashCopyStatus('textCopied')
    } catch {
      flashCopyStatus('failed')
    }
  }, [flashCopyStatus, result?.originalText])

  const resultLayout = useMemo(() => {
    if (!result) {
      return null
    }

    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : result.width
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : result.height
    const frameWidth = Math.max(8, Math.min(result.width, viewportWidth - 12))
    const frameHeight = Math.max(8, Math.min(result.height, viewportHeight - 56))
    const left = Math.max(6, Math.min(result.left, viewportWidth - frameWidth - 6))
    const maxTop = Math.max(6, viewportHeight - frameHeight - 52)
    const top = Math.max(6, Math.min(result.top, maxTop))

    return {
      left,
      top,
      frameWidth,
      frameHeight,
    }
  }, [result])

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (mode === 'result' && event.button === 0 && event.target === event.currentTarget) {
      closeOverlay()
      return
    }

    if (mode !== 'select' || event.button !== 0) {
      return
    }

    const point = pointFromPointer(event)
    setStart(point)
    setCurrent(point)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (mode !== 'select' || !start) {
      return
    }

    setCurrent(pointFromPointer(event))
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (mode !== 'select' || !start) {
      return
    }

    const point = pointFromPointer(event)
    const rect = normalizeRect(start, point)
    setStart(null)
    setCurrent(null)

    if (rect.width < 8 || rect.height < 8) {
      appendDebugLog('trace', 'OCR selection canceled', 'region too small')
      void invoke('cancel_ocr_overlay').catch(() => undefined)
      return
    }

    setMode('processing')
    appendDebugLog(
      'trace',
      'OCR selection submit',
      `viewRect=(${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)})`,
    )
    void (async () => {
      try {
        await invoke('submit_ocr_selection', {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.left + rect.width),
          bottom: Math.round(rect.top + rect.height),
          sourceLanguage: ocrSourceLanguage,
          targetLanguage: ocrTargetLanguage,
        })
        appendDebugLog('trace', 'OCR selection submit done')
      } catch {
        appendDebugLog('trace', 'OCR selection submit failed')
        await invoke('cancel_ocr_overlay').catch(() => undefined)
      }
    })()
  }

  const handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    if (mode === 'select') {
      void invoke('cancel_ocr_overlay').catch(() => undefined)
    }
  }

  const shellClassName = `apl-ocr-overlay-shell${mode === 'processing' ? ' is-processing' : ''}${mode === 'result' ? ' is-result' : ''}`

  return (
    <main
      className={shellClassName}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={handleContextMenu}
    >
      {mode === 'select' && <div className="apl-ocr-overlay-hint">{hintText}</div>}
      {mode === 'select' && selection && (
        <div
          className="apl-ocr-overlay-selection"
          style={{
            left: `${selection.left}px`,
            top: `${selection.top}px`,
            width: `${selection.width}px`,
            height: `${selection.height}px`,
          }}
        />
      )}

      {mode === 'processing' && (
        <div className="apl-ocr-overlay-processing" role="status" aria-live="polite">
          Processing OCR...
        </div>
      )}

      {mode === 'result' && result && resultLayout && (
        <section
          className="apl-ocr-result-panel"
          style={{
            left: `${resultLayout.left}px`,
            top: `${resultLayout.top}px`,
            width: `${resultLayout.frameWidth}px`,
          }}
          role="dialog"
          aria-modal="false"
          aria-label="OCR translated image result"
        >
          <div className="apl-ocr-result-image-wrap" style={{ height: `${resultLayout.frameHeight}px` }}>
            <img
              src={`data:image/png;base64,${result.imageBase64}`}
              alt="OCR translated result"
              className="apl-ocr-result-image"
              draggable={false}
            />
          </div>

          <div className="apl-ocr-result-toolbar" role="group" aria-label="OCR result actions">
            <button type="button" className="apl-ocr-result-btn" onClick={() => void copyResultImage()}>
              Copy image
            </button>
            <button
              type="button"
              className="apl-ocr-result-btn"
              onClick={() => void copyResultText()}
              disabled={!result.originalText.trim()}
            >
              Copy text
            </button>
          </div>

          {copyStatus !== 'idle' && (
            <p className={`apl-ocr-result-status${copyStatus === 'failed' ? ' is-error' : ''}`}>
              {copyStatus === 'imageCopied' && 'Image copied'}
              {copyStatus === 'textCopied' && 'Text copied'}
              {copyStatus === 'failed' && 'Copy failed'}
            </p>
          )}
        </section>
      )}
    </main>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { appendDebugLog } from '@/services/debugLog'

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
  const [submitting, setSubmitting] = useState(false)

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

  const selection = useMemo(() => {
    if (!start || !current) {
      return null
    }
    return normalizeRect(start, current)
  }, [current, start])

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (submitting || event.button !== 0) {
      return
    }

    const point = pointFromPointer(event)
    setStart(point)
    setCurrent(point)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!start || submitting) {
      return
    }

    setCurrent(pointFromPointer(event))
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (!start || submitting) {
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

    setSubmitting(true)
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
        })
        appendDebugLog('trace', 'OCR selection submit done')
      } catch {
        appendDebugLog('trace', 'OCR selection submit failed')
        await invoke('cancel_ocr_overlay').catch(() => undefined)
      } finally {
        setSubmitting(false)
      }
    })()
  }

  const handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    if (!submitting) {
      void invoke('cancel_ocr_overlay').catch(() => undefined)
    }
  }

  return (
    <main
      className="apl-ocr-overlay-shell"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={handleContextMenu}
    >
      <div className="apl-ocr-overlay-hint">Keo chuot de chon vung anh - Esc de huy</div>
      {selection && (
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
    </main>
  )
}

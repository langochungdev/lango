// Sub-panel hiển thị bên cạnh popover với vị trí tính toán động
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSubPanelPosition } from '@/hooks/useSubPanelPosition'

interface SubPanelProps {
  popoverRef: React.RefObject<HTMLElement | null>
  children: React.ReactNode
  visible: boolean
  panelMode: string
}

export function SubPanel({ popoverRef, children, visible, panelMode }: SubPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null)
  const pos = useSubPanelPosition(popoverRef, panelRef, visible)
  const portalTarget = typeof document !== 'undefined' ? document.body : null

  if (!visible || !portalTarget) return null

  return createPortal(
    <aside
      ref={panelRef}
      className="apl-subpanel"
      data-panel-mode={panelMode}
      style={{
        position: 'fixed',
        left: `${pos.left}px`,
        top: `${pos.top}px`,
        maxHeight: panelMode === 'images' ? undefined : `${pos.maxHeight}px`,
        zIndex: 10001,
      }}
    >
      {children}
    </aside>,
    portalTarget,
  )
}

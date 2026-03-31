// Sub-panel hiển thị bên cạnh popover với vị trí tính toán động
import { useRef } from 'react'
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

  if (!visible) return null

  return (
    <aside
      ref={panelRef}
      className="apl-subpanel"
      data-panel-mode={panelMode}
      style={{
        position: 'fixed',
        left: `${pos.left}px`,
        top: `${pos.top}px`,
        maxHeight: `${pos.maxHeight}px`,
        zIndex: 9998,
      }}
    >
      {children}
    </aside>
  )
}

// Các icon SVG dùng trong Popover
export function LoadingDots({ label }: { label: string }) {
  return (
    <div className="apl-loading" role="status" aria-live="polite" aria-label={label}>
      <span className="apl-loading-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  )
}

export function AudioIcon() {
  return (
    <svg className="apl-audio-icon" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <g fill="none" fillRule="evenodd" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.5 8.5v4" />
        <path d="M8.5 6.5v9" />
        <path d="M10.5 9.5v2" />
        <path d="M12.5 7.5v6.814" />
        <path d="M14.5 4.5v12" />
      </g>
    </svg>
  )
}

export function ImageIcon() {
  return (
    <svg className="apl-image-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
        <rect x="2.8" y="4" width="14.4" height="12" rx="2" />
        <circle cx="7.2" cy="8" r="1.3" />
        <path d="M4.8 14l3.6-3.8 2.8 2.8 2.4-2.3 2.4 3.3" />
      </g>
    </svg>
  )
}

export function SettingsIcon() {
  return (
    <svg className="apl-settings-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <path d="M8.2 2.6h3.6l.5 2.1a5.6 5.6 0 0 1 1.2.7l2-.8 1.8 3.1-1.5 1.5c.1.4.1.8.1 1.2s0 .8-.1 1.2l1.5 1.5-1.8 3.1-2-.8a5.6 5.6 0 0 1-1.2.7l-.5 2.1H8.2l-.5-2.1a5.6 5.6 0 0 1-1.2-.7l-2 .8-1.8-3.1L4.2 12a6 6 0 0 1-.1-1.2c0-.4 0-.8.1-1.2L2.7 8.1l1.8-3.1 2 .8a5.6 5.6 0 0 1 1.2-.7zm1.8 5a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

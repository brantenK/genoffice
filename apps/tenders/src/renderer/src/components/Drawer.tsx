// Semantic side-panel drawer primitive (Phase 5 / WP-13).
//
// Drawers share the dialog accessibility contract (labelled heading, role=dialog,
// aria-modal, Escape, Tab trap, initial focus, focus restoration) but keep the
// workspace-relative side-panel placement: they open over the right side of the
// tender workspace without a scrim, because other surfaces stay usable behind
// them while a drawer is open.
import clsx from 'clsx'
import { useId, useRef, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import { useOverlayBehaviour } from './Dialog'
import { IconButton } from './ui'

const DRAWER_WIDTHS = {
  sm: 'w-[380px]',
  md: 'w-[400px]',
  lg: 'w-[440px]',
} as const

export interface DrawerProps {
  /** Visible heading; also the drawer's accessible name. */
  title: string
  subtitle?: ReactNode
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: keyof typeof DRAWER_WIDTHS
  /** Accessible name for the icon-only close control. */
  closeLabel?: string
  className?: string
  initialFocusRef?: RefObject<HTMLElement | null>
}

export function Drawer({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  width = 'md',
  closeLabel,
  className,
  initialFocusRef,
}: DrawerProps) {
  const panelRef = useRef<HTMLElement>(null)
  const titleId = useId()
  useOverlayBehaviour(panelRef, onClose, initialFocusRef)

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className={clsx(
        'absolute inset-y-0 right-0 z-20 flex max-w-[92%] flex-col border-l border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-modal-strong)] outline-none',
        DRAWER_WIDTHS[width],
        className,
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {icon && (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-dark)]">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-bold text-[var(--text)]">
              {title}
            </h2>
            {subtitle && (
              <p className="truncate text-[11px] text-[var(--text-secondary)]">{subtitle}</p>
            )}
          </div>
        </div>
        <IconButton label={closeLabel ?? `Close ${title}`} onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>

      {footer && (
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-2.5">{footer}</div>
      )}
    </aside>
  )
}

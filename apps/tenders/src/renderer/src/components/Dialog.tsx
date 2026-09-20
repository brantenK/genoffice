// Semantic modal dialog primitive (Phase 5 / WP-13).
//
// One place owns the overlay accessibility contract used by every Tenders
// dialog: a labelled heading (which is also the accessible name), `role="dialog"`
// + `aria-modal="true"`, Escape to close, Tab trapped inside, focus starting on
// the first useful control, and focus returning to the opener on close.
import clsx from 'clsx'
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './ui'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Visible, enabled focus targets inside a container, in DOM order. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute('aria-hidden') &&
      !element.closest('[aria-hidden="true"]') &&
      element.getClientRects().length > 0,
  )
}

/** Prefer a form control (or an explicit ref) over the header close button. */
function initialFocusTarget(
  panel: HTMLElement,
  initialFocusRef?: RefObject<HTMLElement | null>,
): HTMLElement | null {
  if (initialFocusRef?.current) return initialFocusRef.current
  const explicit = panel.querySelector<HTMLElement>('[data-autofocus]')
  if (explicit) return explicit
  const control = panel.querySelector<HTMLElement>(
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])',
  )
  if (control) return control
  return focusableWithin(panel)[0] ?? null
}

/**
 * Overlay behaviour shared by Dialog and Drawer:
 *  - Escape closes (and the event does not leak to other handlers);
 *  - Tab / Shift+Tab cycle inside the panel, pulling focus back in if it escapes;
 *  - focus starts inside the panel and is restored to the opener on unmount.
 */
export function useOverlayBehaviour(
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  // The opener must be captured during the FIRST RENDER, not in the mount
  // effect: React applies a control's `autoFocus` during the commit phase, so
  // by the time effects run document.activeElement is already inside the panel
  // and focus would be "restored" to a field that is about to unmount.
  const openerRef = useRef<HTMLElement | null>(null)
  const capturedRef = useRef(false)
  if (!capturedRef.current) {
    capturedRef.current = true
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

  useEffect(() => {
    const panel = panelRef.current
    if (panel) (initialFocusTarget(panel, initialFocusRef) ?? panel).focus?.()
    return () => {
      const opener = openerRef.current
      if (opener && document.contains(opener)) opener.focus?.()
    }
    // Mount-only: overlays are unmounted by their parent to close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const list = focusableWithin(panel)
      if (list.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const active = document.activeElement as HTMLElement | null
      const index = active ? list.indexOf(active) : -1
      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault()
          list[list.length - 1].focus()
        }
      } else if (index === -1 || index === list.length - 1) {
        event.preventDefault()
        list[0].focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [panelRef, onClose])
}

const DIALOG_SIZES = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
} as const

export interface DialogProps {
  /** Visible heading; also the dialog's accessible name. */
  title: string
  subtitle?: ReactNode
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
  /** Optional footer for non-form dialogs; forms render their own footer inside. */
  footer?: ReactNode
  size?: keyof typeof DIALOG_SIZES
  /** Accessible name for the icon-only close control. */
  closeLabel?: string
  className?: string
  bodyClassName?: string
  footerClassName?: string
  initialFocusRef?: RefObject<HTMLElement | null>
  role?: 'dialog' | 'alertdialog'
}

export function Dialog({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  size = 'lg',
  closeLabel,
  className,
  bodyClassName,
  footerClassName,
  initialFocusRef,
  role = 'dialog',
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useOverlayBehaviour(panelRef, onClose, initialFocusRef)

  return (
    <div
      className="fixed inset-0 z-[75] flex items-start justify-center overflow-y-auto bg-[var(--color-bg-overlay)] p-3 sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        className={clsx(
          'dialog-enter my-auto flex max-h-[92vh] w-full flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-modal-strong)] outline-none',
          DIALOG_SIZES[size],
          className,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <h2
              id={titleId}
              className="flex items-center gap-1.5 text-base font-bold text-[var(--text)]"
            >
              {icon}
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                {subtitle}
              </p>
            )}
          </div>
          <IconButton label={closeLabel ?? `Close ${title}`} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </header>

        <div className={clsx('flex min-h-0 flex-1 flex-col', bodyClassName)}>{children}</div>

        {footer && (
          <footer
            className={clsx(
              'flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3',
              footerClassName,
            )}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

// Semantic side-panel drawer primitive (Phase 5 / WP-13).
//
// Drawers share the dialog accessibility contract (labelled heading, role=dialog,
// aria-modal, Escape, Tab trap, initial focus, focus restoration) but keep the
// workspace-relative side-panel placement: they open over the right side of the
// tender workspace without a scrim, because other surfaces stay usable behind
// them while a drawer is open. A drawer's box starts at the bottom edge of the
// workspace toolbar so its own title row — and with it the close control — stays
// hit-testable (see `useToolbarOffset`).
import clsx from 'clsx'
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import { useOverlayBehaviour } from './Dialog'
import { IconButton } from './ui'

const DRAWER_WIDTHS = {
  sm: 'w-[380px]',
  md: 'w-[400px]',
  lg: 'w-[440px]',
} as const

/**
 * The workspace chrome bar. It is `position: sticky; z-index: 30`
 * (styles/responsive.css) because it owns the overflow menu, whose popup has to
 * paint above the pane headers — so the menu's `z-50` is trapped inside that
 * stacking context and the drawer can never out-rank the bar as a whole.
 */
const TOOLBAR_SELECTOR = '.workspace-context-header'

/**
 * The drawer's containing block: the positioned workspace root.
 *
 * It is looked up by its own marker rather than by tag name because the document
 * keeps exactly one `<main>` (the app shell's) and the workspace root is a
 * `<section>` — a `main` lookup from inside a drawer would resolve past the
 * workspace to the shell, which is not the box the offset is measured from. The
 * `main` fallback stays for a drawer rendered without the workspace marker.
 */
const CONTAINING_BLOCK_SELECTOR = '[data-workspace-root], main'

/**
 * The y at which a drawer's box must start: the distance from the drawer's
 * containing block to the bottom edge of the workspace toolbar.
 *
 * The drawer's box has to START below that edge. Pinned to `inset-y-0` the
 * drawer's title row — and with it the only in-drawer close control — sat
 * underneath the toolbar: laid out and "visible", but never hit-testable, so a
 * pointer click on the X retried forever while the toolbar's own controls
 * answered at that point instead. The offset is measured rather than hard-coded
 * because the toolbar wraps and grows with text zoom.
 *
 * Pure: the two measured elements are passed in, so the arithmetic (containing
 * block resolution, rounding, clamp and the no-toolbar fallback) is unit-tested
 * without a layout engine.
 */
export function toolbarBottomOffset(panel: HTMLElement, toolbar: Element | null): number {
  if (!toolbar) return 0
  // Absolute positioning resolves against the nearest positioned ancestor.
  const block = panel.offsetParent ?? panel.closest(CONTAINING_BLOCK_SELECTOR)
  if (!block) return 0
  const offset = toolbar.getBoundingClientRect().bottom - block.getBoundingClientRect().top
  return Math.max(0, Math.round(offset))
}

/** Re-measure `toolbarBottomOffset` on mount and whenever the toolbar resizes. */
function useToolbarOffset(panelRef: RefObject<HTMLElement | null>): number {
  const [offset, setOffset] = useState(0)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const container = panel.closest<HTMLElement>(CONTAINING_BLOCK_SELECTOR)
    const toolbar = container?.querySelector<HTMLElement>(TOOLBAR_SELECTOR) ?? null
    if (!container || !toolbar) return
    const measure = (): void => setOffset(toolbarBottomOffset(panel, toolbar))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [panelRef])

  return offset
}

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
  const toolbarOffset = useToolbarOffset(panelRef)

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{ top: toolbarOffset }}
      className={clsx(
        'absolute right-0 bottom-0 z-20 flex max-w-[92%] flex-col border-l border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-modal-strong)] outline-none',
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

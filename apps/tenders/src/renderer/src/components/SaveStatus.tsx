// Compact save/load status indicator for the workspace chrome. Reflects the
// authoritative v2 store lifecycle: hydrating, in-flight save, saved (with the
// advisory size heads-up when the document is approaching a save ceiling),
// failed (with Retry) and revision conflict (with Reload from disk). Small and
// quiet on purpose — it sits in chrome and must never dominate the workspace.
import type { JSX } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'

export type SaveStatusKind = 'loading' | 'saving' | 'saved' | 'error' | 'conflict'

export interface SaveStatusProps {
  status: SaveStatusKind
  /** Detail for the alert states (`error`, `conflict`); ignored elsewhere. */
  message?: string | null
  /**
   * Advisory rendered next to a settled, non-alert status — the document size
   * headroom warning while `saved` is the one in use. It never becomes an alert
   * and never blocks anything; it exists so a workspace that is filling up is
   * visible *before* saving starts to fail. A plain `message` on a non-alert
   * status is treated as an advisory too, so a call site with a single string
   * cannot silently drop it.
   */
  warning?: string | null
  onRetry?: () => void
  onReload?: () => void
  /**
   * Icon-only variant for the collapsed sidebar rail (60px wide), where the full
   * pill is clipped to its first letters. The state stays announced through the
   * accessible name, and when there is an action the rail control *is* that
   * action (a 24x24 target) rather than a second control that would not fit —
   * which is why an alert state announces itself (`role="alert"`) from a wrapper
   * *around* that control rather than from the control itself: `alert` is not an
   * allowed role for a `<button>`, so it would replace the button role and the
   * user would no longer be told this is the Retry / Reload that recovers the
   * save. A `warning` has no room for its own text here, so it is carried in the
   * glyph's accessible name/title and in the warn tone of the shell.
   */
  compact?: boolean
}

const LABEL: Record<SaveStatusKind, string> = {
  loading: 'Loading…',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
  conflict: 'Conflict',
}

// Whole-pill tone. Loading/saving/saved stay neutral; error uses the danger
// tokens (with `--danger-text` for the label, which is legible on the danger
// surface in both themes); conflict uses the warn tokens so it reads over
// either theme without a raw palette colour.
const TONE: Record<SaveStatusKind, string> = {
  loading: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]',
  saving: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]',
  saved: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]',
  error: 'border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)]',
  conflict: 'border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn)]',
}

/**
 * Advisory pill tone. The same warn tokens the conflict state uses, so a
 * workspace that is filling up reads as a heads-up in either theme without a
 * raw palette colour.
 */
const WARN_TONE = 'border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn)]'

/**
 * The status glyph; `saved` is the only status that reads as success. With an
 * advisory it becomes the warn triangle instead, because in the compact rail the
 * glyph (with its title) is the only place the warning can live.
 */
function StatusGlyph({
  status,
  advisory = false,
}: {
  status: SaveStatusKind
  advisory?: boolean
}): JSX.Element {
  if (!advisory && (status === 'loading' || status === 'saving')) {
    return <Loader2 size={12} className="animate-spin" aria-hidden="true" />
  }
  if (!advisory && status === 'saved') {
    return <Check size={12} className="text-[var(--success)]" aria-hidden="true" />
  }
  return <AlertTriangle size={12} aria-hidden="true" />
}

export function SaveStatus({
  status,
  message,
  warning,
  onRetry,
  onReload,
  compact = false,
}: SaveStatusProps): JSX.Element {
  const isAlert = status === 'error' || status === 'conflict'
  const detail = isAlert && message ? message : null
  // Advisory only once the status has settled: a spinner or an in-flight save
  // must not be replaced mid-flight, and an alert already owns the message.
  const advisory =
    !isAlert && status !== 'loading' && status !== 'saving' ? (warning ?? message) || null : null
  const title = detail
    ? `${LABEL[status]} — ${detail}`
    : advisory
      ? `${LABEL[status]} — ${advisory}`
      : LABEL[status]
  const tone = advisory ? WARN_TONE : TONE[status]

  if (compact) {
    const action =
      status === 'error' && onRetry
        ? { label: 'Retry', run: onRetry }
        : status === 'conflict' && onReload
          ? { label: 'Reload from disk', run: onReload }
          : null
    const shell = `inline-flex size-6 shrink-0 items-center justify-center rounded-full border ${tone}`
    if (action) {
      // `error` and `conflict` always take this branch in the collapsed rail
      // (the app shell always passes both callbacks), and here the rail control
      // *is* the action. A control whose accessible name changes announces
      // nothing by itself, so the announcement is carried by a wrapper that owns
      // the live region (WCAG 4.1.3) while the button inside keeps its own role
      // and name — the control has to stay an activatable control, and
      // `role="alert"` is not an allowed role for `<button>`: putting it there
      // replaces the button role instead of adding to it. The same announcement
      // is the wrapper's accessible name and its (visually hidden) text, so it
      // reaches the user whichever channel the assistive tech reads.
      //
      // The wrapper is a `div`, deliberately not the `span` of the settled
      // branch below: React reuses a same-type element, so a `span` would be
      // re-roled in place rather than inserted, and a live region that is
      // *inserted* carrying `role="alert"` is the reliable announcement path.
      // `aria-busy` sits on the wrapper (the live region) where it can actually
      // suppress a mid-update announcement — only the two alert states can carry
      // an action today, so it is always undefined here, as in the pill branch.
      const announcement = `${title}. ${action.label}`
      return (
        <div
          role="alert"
          aria-label={announcement}
          aria-busy={status === 'saving' ? true : undefined}
          className="inline-flex shrink-0 items-center"
        >
          <button
            type="button"
            onClick={action.run}
            aria-label={announcement}
            title={announcement}
            className={`${shell} cursor-pointer`}
          >
            <StatusGlyph status={status} advisory={advisory !== null} />
          </button>
          <span className="sr-only">{announcement}</span>
        </div>
      )
    }
    return (
      <span
        role={isAlert ? 'alert' : 'status'}
        aria-live={isAlert ? undefined : 'polite'}
        aria-busy={status === 'saving' ? true : undefined}
        title={title}
        className={shell}
      >
        <StatusGlyph status={status} advisory={advisory !== null} />
        <span className="sr-only">{title}</span>
      </span>
    )
  }

  return (
    <div
      role={isAlert ? 'alert' : 'status'}
      aria-live={isAlert ? undefined : 'polite'}
      aria-busy={status === 'saving' ? true : undefined}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}
    >
      <span className="shrink-0" aria-hidden="true">
        <StatusGlyph status={status} advisory={advisory !== null} />
      </span>

      <span className="whitespace-nowrap">{LABEL[status]}</span>

      {(detail || advisory) && (
        <span
          className="max-w-[16rem] min-w-0 truncate text-[11px] font-normal opacity-80"
          title={detail ?? advisory ?? undefined}
        >
          {detail ?? advisory}
        </span>
      )}

      {status === 'error' && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-0.5 shrink-0 cursor-pointer rounded-full border border-[var(--danger-border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--danger)] hover:bg-[var(--hover)]"
        >
          Retry
        </button>
      )}

      {status === 'conflict' && onReload && (
        <button
          type="button"
          onClick={onReload}
          className="ml-0.5 shrink-0 cursor-pointer rounded-full border border-[var(--warn-border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--warn)] hover:bg-[var(--hover)]"
        >
          Reload from disk
        </button>
      )}
    </div>
  )
}

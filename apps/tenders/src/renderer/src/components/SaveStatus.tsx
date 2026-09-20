// Compact save/load status indicator for the workspace chrome. Reflects the
// authoritative v2 store lifecycle: hydrating, in-flight save, saved, failed
// (with Retry) and revision conflict (with Reload from disk). Small and quiet
// on purpose — it sits in chrome and must never dominate the workspace.
import type { JSX } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'

export type SaveStatusKind = 'loading' | 'saving' | 'saved' | 'error' | 'conflict'

export interface SaveStatusProps {
  status: SaveStatusKind
  message?: string | null
  onRetry?: () => void
  onReload?: () => void
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

export function SaveStatus({ status, message, onRetry, onReload }: SaveStatusProps): JSX.Element {
  const isAlert = status === 'error' || status === 'conflict'
  const detail = isAlert && message ? message : null

  return (
    <div
      role={isAlert ? 'alert' : 'status'}
      aria-live={isAlert ? undefined : 'polite'}
      aria-busy={status === 'saving' ? true : undefined}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE[status]}`}
    >
      <span
        className={`shrink-0 ${status === 'saved' ? 'text-[var(--success)]' : ''}`}
        aria-hidden="true"
      >
        {status === 'loading' || status === 'saving' ? (
          <Loader2 size={12} className="animate-spin" />
        ) : status === 'saved' ? (
          <Check size={12} />
        ) : (
          <AlertTriangle size={12} />
        )}
      </span>

      <span className="whitespace-nowrap">{LABEL[status]}</span>

      {detail && (
        <span
          className="max-w-[16rem] min-w-0 truncate text-[11px] font-normal opacity-80"
          title={detail}
        >
          {detail}
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

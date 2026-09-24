// Trashed managed documents (Phase 5 WP-9) — recoverable, undo across restart.
//
// Deleting a document soft-deletes its file into `.trash/` (main owns the move);
// this drawer lists those entries and restores one on demand. Emptying the trash
// is the only permanent action and is always explicit.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArchiveRestore, RefreshCw, Trash2, X } from 'lucide-react'
import type { ManagedFileTrashEntry } from '../../../shared/tenders-persistence'
import { Badge, Button, Spinner } from './ui'
import { Dialog, useOverlayBehaviour } from './Dialog'

/** Stable no-op used while the confirm dialog owns Escape. */
const noop = () => undefined

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return 'unknown size'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatWhen(value: string): string {
  const date = new Date(value)
  if (isNaN(date.getTime())) return value
  return date.toLocaleString('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function TrashDrawer({
  onClose,
  onRestored,
}: {
  onClose: () => void
  /** Called with the restored relative path so callers can reconcile state. */
  onRestored?: (storedPath: string) => void
}) {
  const [entries, setEntries] = useState<ManagedFileTrashEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Emptying the trash is permanent, so it is confirmed in-app (native
  // window.confirm is not accepted by the durability E2E spec).
  const [emptyOpen, setEmptyOpen] = useState(false)
  // Escape-to-close, Tab trap, initial focus and focus restoration all come from
  // the shared overlay behaviour (same contract as Dialog/Drawer).
  const panelRef = useRef<HTMLElement>(null)
  const titleId = useId()
  // Escape closes the drawer, except while the empty-trash confirm dialog is
  // open: that dialog is a separate overlay and owns Escape itself.
  useOverlayBehaviour(panelRef, emptyOpen ? noop : onClose)

  const load = useCallback(async () => {
    if (typeof window === 'undefined' || !window.tendersApi?.listDocumentTrash) {
      setLoading(false)
      setError('Document trash is unavailable in this build.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await window.tendersApi.listDocumentTrash()
      if (!res?.ok) {
        setError(res?.error || 'Could not list trashed documents.')
        return
      }
      setEntries(res.entries ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onRestore = useCallback(
    async (entry: ManagedFileTrashEntry) => {
      setBusyId(entry.id)
      setError(null)
      setNotice(null)
      try {
        const res = await window.tendersApi?.restoreDocument?.({ id: entry.id })
        if (!res?.ok) {
          setError(res?.error || 'Could not restore the file.')
          return
        }
        setNotice(
          `Restored ${res.record?.fileName ?? entry.fileName}${
            res.storedPath ? ` to ${res.storedPath}` : ''
          }. Undo restores the file only — the vault entry or tender record it belonged to, its dates and notes, the compliance matrix and any requirement links are not restored.`,
        )
        if (res.storedPath) onRestored?.(res.storedPath)
        await load()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [load, onRestored],
  )

  const performEmptyTrash = useCallback(async () => {
    setBusyId('__all__')
    setError(null)
    setNotice(null)
    try {
      const res = await window.tendersApi?.cleanupDocumentTrash?.({ all: true })
      if (!res?.ok) {
        setError(res?.error || 'Could not empty the trash.')
        return
      }
      setNotice(`Permanently removed ${res.removed ?? 0} trashed document(s).`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }, [load])

  // The confirmation is inert until the user confirms inside the in-app dialog.
  const requestEmptyTrash = useCallback(() => setEmptyOpen(true), [])
  const cancelEmptyTrash = useCallback(() => setEmptyOpen(false), [])

  const confirmEmptyTrash = useCallback(() => {
    setEmptyOpen(false)
    void performEmptyTrash()
  }, [performEmptyTrash])

  return (
    <>
      <div
        data-testid="documents-trash-panel"
        className="absolute inset-y-0 right-0 z-30 flex w-[440px] max-w-[92%] flex-col"
      >
        <aside
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="trash-drawer"
          className="flex h-full min-h-0 flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl outline-none"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--surface-subtle)] text-[var(--text-secondary)] ring-1 ring-[var(--border)]">
                <Trash2 size={17} aria-hidden="true" />
              </span>
              <div>
                <h2 id={titleId} className="text-sm font-bold text-[var(--text)]">
                  Trashed documents
                </h2>
                <p className="text-[11px] text-[var(--text-tertiary)]">
                  Restores the file only — records are not restored
                </p>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close trash">
              <X size={15} />
            </Button>
          </div>

          {notice && (
            <p
              role="status"
              data-testid="trash-notice"
              className="mx-4 mt-3 rounded-lg border border-[var(--success-border)] bg-[var(--success-bg)] px-3 py-2 text-xs text-[var(--text-secondary)]"
            >
              {notice}
            </p>
          )}
          {error && (
            <p
              role="alert"
              data-testid="trash-error"
              className="mx-4 mt-3 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs font-medium text-[var(--danger)]"
            >
              {error}
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-4">
            {loading ? (
              <p className="flex items-center justify-center gap-2 py-10 text-xs text-[var(--text-tertiary)]">
                <Spinner /> Loading trashed documents…
              </p>
            ) : entries.length === 0 ? (
              <p className="py-10 text-center text-xs text-[var(--text-tertiary)]">
                No trashed documents. Deleted files stay here until you empty the trash.
              </p>
            ) : (
              <ul className="space-y-2" data-testid="trash-list">
                {entries.map((entry) => (
                  <li
                    key={entry.id}
                    data-testid={`trash-entry-${entry.id}`}
                    className="rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2.5"
                  >
                    <div
                      data-testid="trash-entry"
                      className="flex items-start justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-[var(--text)]">
                          {entry.fileName}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-tertiary)]">
                          <Badge tone={entry.category === 'rfp' ? 'indigo' : 'slate'}>
                            {entry.category === 'rfp' ? 'RFP' : 'Vault'}
                          </Badge>
                          <span>Deleted {formatWhen(entry.trashedAt)}</span>
                          <span>· {formatBytes(entry.size)}</span>
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="default"
                        data-testid={`trash-restore-${entry.id}`}
                        aria-label={`Restore ${entry.fileName}`}
                        disabled={busyId !== null}
                        onClick={() => void onRestore(entry)}
                      >
                        {busyId === entry.id ? (
                          <Spinner />
                        ) : (
                          <ArchiveRestore size={13} aria-hidden="true" />
                        )}{' '}
                        Restore
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-3">
            <button
              type="button"
              onClick={requestEmptyTrash}
              disabled={entries.length === 0 || busyId !== null}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--danger-border)] bg-[var(--surface)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger-bg)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={12} aria-hidden="true" /> Empty trash
            </button>
            <Button variant="default" size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </aside>
      </div>

      {emptyOpen && (
        <div data-testid="trash-empty-dialog" className="fixed inset-0 z-[75]">
          <Dialog
            title="Empty the trash?"
            subtitle="Permanently delete every trashed document."
            icon={<Trash2 size={16} aria-hidden="true" />}
            size="sm"
            onClose={cancelEmptyTrash}
            footer={
              <>
                {/* Destructive and irreversible: Cancel takes initial focus. */}
                <Button variant="ghost" data-autofocus onClick={cancelEmptyTrash}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  data-testid="trash-empty-confirm"
                  onClick={confirmEmptyTrash}
                >
                  Empty trash
                </Button>
              </>
            }
          >
            <p className="px-5 py-4 text-sm leading-relaxed text-[var(--text-secondary)]">
              This permanently deletes every trashed document. It cannot be undone.
            </p>
          </Dialog>
        </div>
      )}
    </>
  )
}

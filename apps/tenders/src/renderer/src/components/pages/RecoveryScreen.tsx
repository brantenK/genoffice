// Explicit recovery screen (Phase 5 WP-2).
//
// Shown only when hydration fails with RECOVERY_REQUIRED. The renderer never
// substitutes a backup/empty/demo document as authoritative: the user chooses a
// validated candidate, and the main process writes it over the unreadable
// primary as the new authoritative file.
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArchiveRestore, RefreshCw } from 'lucide-react'
import type { TendersRecoveryCandidate } from '../../../../shared/tenders-persistence'
import { useTendersStore } from '../../store'
import { Badge, Button, Spinner } from '../ui'
import { Dialog } from '../Dialog'

function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return 'unknown size'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatWhen(value?: string): string {
  if (!value) return 'unknown time'
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

const SOURCE_LABEL: Record<TendersRecoveryCandidate['source'], string> = {
  primary: 'Primary',
  backup: 'Backup',
  temporary: 'Temporary',
  unknown: 'Unknown',
}

export function RecoveryScreen() {
  const candidates = useTendersStore((s) => s.recoveryCandidates)
  const error = useTendersStore((s) => s.recoveryError)
  const busy = useTendersStore((s) => s.recoveryBusy)
  const hydrationError = useTendersStore((s) => s.hydrationError)
  const refresh = useTendersStore((s) => s.refreshRecoveryCandidates)
  const restore = useTendersStore((s) => s.restoreRecoveryCandidate)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  // Restore overwrites the unreadable primary, so it is confirmed in-app
  // (native window.confirm is not accepted by the durability E2E spec).
  const [pendingRestore, setPendingRestore] = useState<TendersRecoveryCandidate | null>(null)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const requestRestore = useCallback((candidate: TendersRecoveryCandidate) => {
    if (!candidate.valid) return
    setPendingRestore(candidate)
  }, [])

  const cancelRestore = useCallback(() => setPendingRestore(null), [])

  const confirmRestore = useCallback(() => {
    const candidate = pendingRestore
    setPendingRestore(null)
    if (!candidate) return
    setRestoringId(candidate.id)
    void restore(candidate.id).finally(() => setRestoringId(null))
  }, [pendingRestore, restore])

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center overflow-y-auto scroll-thin p-6"
      style={{ background: 'var(--gs-panel-bg)' }}
      data-testid="recovery-surface"
    >
      <div
        className="my-auto w-full max-w-2xl rounded-2xl border border-[var(--danger-border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-menu)]"
        data-testid="recovery-screen"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]">
            <AlertTriangle size={22} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-[var(--text)]">Tenders data needs recovery</h1>
            <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]" role="alert">
              {hydrationError ||
                'The authoritative Tenders data file could not be read. Nothing was overwritten automatically.'}
            </p>
          </div>
        </div>

        <p
          className="mt-4 rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)]"
          data-testid="recovery-warning"
        >
          Restoring a copy <strong>overwrites the current file</strong> and cannot be undone. Only
          restore a copy you recognise. No backup is ever applied automatically.
        </p>

        <div className="mt-4 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--text)]">
            Validated recovery candidates{' '}
            <span className="font-normal text-[var(--text-tertiary)]">({candidates.length})</span>
          </h2>
          <Button
            size="sm"
            variant="default"
            onClick={() => void refresh()}
            disabled={busy}
            data-testid="recovery-refresh"
          >
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs font-medium text-[var(--danger)]"
          >
            {error}
          </p>
        )}

        {candidates.length === 0 ? (
          <p className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-3 text-xs text-[var(--text-secondary)]">
            No recovery candidates were found for this profile. The primary file has not been
            modified.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {candidates.map((candidate, index) => (
              <li
                key={candidate.id}
                data-testid={`recovery-candidate-${index}`}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)]"
              >
                <div
                  data-testid="recovery-candidate"
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-[var(--text)]">
                      {candidate.path}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-tertiary)]">
                      <Badge tone={candidate.source === 'backup' ? 'green' : 'slate'}>
                        {SOURCE_LABEL[candidate.source]}
                      </Badge>
                      <span>Updated {formatWhen(candidate.updatedAt)}</span>
                      <span>· {formatBytes(candidate.sizeBytes)}</span>
                      <span>· revision {candidate.revision ?? 'unknown'}</span>
                    </p>
                    {candidate.reason && (
                      <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                        {candidate.reason}
                      </p>
                    )}
                  </div>
                  <span data-testid="recovery-restore" className="inline-flex">
                    <Button
                      size="sm"
                      variant={candidate.valid ? 'primary' : 'default'}
                      disabled={!candidate.valid || busy || restoringId !== null}
                      title={
                        candidate.valid ? 'Restore this copy' : 'This copy is not valid v2 data'
                      }
                      onClick={() => requestRestore(candidate)}
                      data-testid={`recovery-restore-${index}`}
                    >
                      {restoringId === candidate.id ? <Spinner /> : <ArchiveRestore size={13} />}{' '}
                      {candidate.valid ? 'Restore' : 'Unusable'}
                    </Button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {pendingRestore && (
        <div data-testid="recovery-restore-dialog" className="fixed inset-0 z-[75]">
          <Dialog
            title="Restore this copy?"
            subtitle={`“${pendingRestore.path}” will replace the current unreadable file.`}
            icon={<AlertTriangle size={16} aria-hidden="true" />}
            size="sm"
            onClose={cancelRestore}
            footer={
              <>
                {/* Overwrites the authoritative file: Cancel takes initial focus. */}
                <Button variant="ghost" data-autofocus onClick={cancelRestore}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  data-testid="recovery-restore-confirm"
                  onClick={confirmRestore}
                >
                  Restore
                </Button>
              </>
            }
          >
            <p className="px-5 py-4 text-sm leading-relaxed text-[var(--text-secondary)]">
              This overwrites the current unreadable Tenders data file with this copy. This cannot
              be undone.
            </p>
          </Dialog>
        </div>
      )}
    </div>
  )
}

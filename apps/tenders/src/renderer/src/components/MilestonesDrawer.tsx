// Contract Milestones Drawer: Delivery progress & Zano Books billing integration.
//
// Billing is only exposed for a WON tender (`milestonesAllowed`) and is refused
// inside a sample workspace, so a demonstration record can never raise an invoice.
//
// Chrome is tokens-only (the drawer follows the suite light/dark/system theme);
// money, dates and milestone data are document data and are never restyled.
import { useState } from 'react'
import {
  Award,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Receipt,
  ShieldAlert,
  X,
  Zap,
} from 'lucide-react'
import { selectActiveTender, useTendersStore } from '../store'
import {
  TENDER_STATUS_LABEL,
  type ContractMilestone,
  type MilestoneBillingStatus,
  type TenderRecord,
} from '../../shared/types'
import { milestonesAllowed } from '../../../shared/lifecycle'
import { SAMPLE_WRITE_BLOCKED_REASON, crossAppWritesBlocked } from './TenderLifecyclePanel'
import { Drawer } from './Drawer'
import { Badge, Button, IconButton, Spinner } from './ui'

/** Result of one billing attempt, rendered by whichever surface called it. */
export interface MilestoneBillingFeedback {
  kind: 'success' | 'error'
  milestoneId: string
  message: string
  /** Errors a retry could fix (transient/transport/revision conflict). */
  retryable: boolean
  reconciled?: boolean
  /** Non-fatal note on a successful post (e.g. link committed on reconcile). */
  warning?: string
}

export interface RunMilestoneBillingOptions {
  onBusy: (milestoneId: string | null) => void
  onFeedback: (feedback: MilestoneBillingFeedback) => void
  /** Open Zano Books after a successful post (default true). */
  openBooksOnSuccess?: boolean
}

/** Definitive rejections where retrying the same request cannot succeed. */
const NON_RETRYABLE_BILLING_ERROR =
  /demo workspace|only allowed for a won|not reached|must be greater than 0|not found|not configured|unauthoriz|not a registered/i

/**
 * ONE billing handler shared by the inline milestone button (`Workspace`) and
 * this drawer, so the two entry points cannot diverge: the sample-workspace
 * guard, the IPC call, milestone persistence, `reconciled`/`warning` handling
 * and the retryability classification all live here.
 *
 * It never throws — every outcome is delivered through `onFeedback`, and the
 * caller may only surface success when `kind === 'success'`.
 */
export async function runMilestoneBilling(
  tender: TenderRecord,
  milestone: ContractMilestone,
  { onBusy, onFeedback, openBooksOnSuccess = true }: RunMilestoneBillingOptions,
): Promise<void> {
  const state = useTendersStore.getState()
  if (crossAppWritesBlocked(state.workspaces, state.activeCompanyId)) {
    onFeedback({
      kind: 'error',
      milestoneId: milestone.id,
      message: SAMPLE_WRITE_BLOCKED_REASON,
      retryable: false,
    })
    return
  }

  onBusy(milestone.id)
  try {
    const res = await window.tendersApi?.billMilestoneInBooks(tender.id, milestone.id)
    if (!res) {
      onFeedback({
        kind: 'error',
        milestoneId: milestone.id,
        message: 'Zano Books billing is unavailable in this build.',
        retryable: true,
      })
      return
    }
    if (!res.ok) {
      const message = res.error || 'Failed to bill milestone in Zano Books.'
      onFeedback({
        kind: 'error',
        milestoneId: milestone.id,
        message,
        retryable: !NON_RETRYABLE_BILLING_ERROR.test(message),
      })
      return
    }

    const nowIso = new Date().toISOString()
    const updatedMilestones = (tender.milestones || []).map((m) =>
      m.id === milestone.id
        ? {
            ...m,
            status: 'BILLED' as MilestoneBillingStatus,
            billedInvoiceId: res.invoiceId ?? m.billedInvoiceId,
            billedInvoiceNumber: res.invoiceNumber ?? m.billedInvoiceNumber,
            billedAt: m.billedAt ?? nowIso,
            billedDate: m.billedDate ?? nowIso,
          }
        : m,
    )
    state.updateTender(tender.id, { milestones: updatedMilestones })
    onFeedback({
      kind: 'success',
      milestoneId: milestone.id,
      reconciled: Boolean(res.reconciled),
      message: res.reconciled
        ? `Milestone reconciled to existing Zano Books invoice ${res.invoiceNumber || res.invoiceId || ''}.`.trim()
        : `Tax Invoice ${res.invoiceNumber || res.invoiceId} successfully created in Zano Books!`,
      retryable: false,
      warning: res.warning,
    })
    if (openBooksOnSuccess) await window.tendersApi?.openBooks?.()
  } catch (e) {
    onFeedback({
      kind: 'error',
      milestoneId: milestone.id,
      message:
        (e as { message?: string })?.message ||
        'Error occurred while creating invoice in Zano Books.',
      retryable: true,
    })
  } finally {
    onBusy(null)
  }
}

export function MilestonesDrawer({ onClose }: { onClose: () => void }) {
  const tender = useTendersStore(selectActiveTender)
  const sampleWritesBlocked = useTendersStore((s) =>
    crossAppWritesBlocked(s.workspaces, s.activeCompanyId),
  )
  const [billingMilestoneId, setBillingMilestoneId] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [error, setError] = useState<{
    message: string
    milestoneId: string
    retryable?: boolean
  } | null>(null)

  if (!tender) return null

  const billingAllowed = milestonesAllowed(tender.status)

  // A tender that is not won must not expose billing at all.
  if (!billingAllowed) {
    return (
      <Drawer
        title="Contract Milestones"
        subtitle="Books billing bridge"
        icon={<Award size={18} aria-hidden="true" />}
        closeLabel="Close Milestones"
        width="lg"
        onClose={onClose}
        footer={
          <div className="flex items-center justify-end">
            <Button variant="default" size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        }
      >
        {/* keyboard-focusable scroll region (the locked notice has no control) */}
        <div
          role="group"
          aria-label="Contract milestones (locked)"
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto scroll-thin p-4 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset focus-visible:outline-none"
        >
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] p-4">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text)]">
              <ShieldAlert size={14} className="text-[var(--text-tertiary)]" aria-hidden="true" />
              Milestones and billing are locked
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              Contract delivery milestones and Zano Books billing are only available once a tender
              is won. This tender is <strong>{TENDER_STATUS_LABEL[tender.status]}</strong>.
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              Record the outcome in the tender lifecycle panel — winning unlocks this drawer.
            </p>
          </div>
        </div>
      </Drawer>
    )
  }

  const milestones = tender.milestones || []
  const totalAmount = milestones.reduce((sum, m) => sum + (Number(m.amount) || 0), 0)
  const billedAmount = milestones
    .filter((m) => m.status === 'BILLED' || m.status === 'PAID')
    .reduce((sum, m) => sum + (Number(m.amount) || 0), 0)
  const reachedAmount = milestones
    .filter((m) => m.status === 'REACHED')
    .reduce((sum, m) => sum + (Number(m.amount) || 0), 0)

  const handleBill = async (milestone: ContractMilestone) => {
    setToastMessage(null)
    setError(null)
    await runMilestoneBilling(tender, milestone, {
      onBusy: setBillingMilestoneId,
      onFeedback: (feedback) => {
        if (feedback.kind === 'success') {
          setToastMessage(feedback.message)
          // A warning is a non-fatal note on a successful post; keep it visible
          // (and retryable) as before.
          if (feedback.warning) {
            setError({ message: feedback.warning, milestoneId: feedback.milestoneId })
          }
        } else {
          setError({
            message: feedback.message,
            milestoneId: feedback.milestoneId,
            retryable: feedback.retryable,
          })
        }
      },
    })
  }

  const handleOpenBooks = async () => {
    await window.tendersApi?.openBooks?.()
  }

  return (
    <Drawer
      title="Contract Milestones"
      subtitle="Zano Books billing bridge"
      icon={<Award size={18} aria-hidden="true" />}
      closeLabel="Close Milestones"
      width="lg"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenBooks}
            title="View all invoices in Zano Books"
          >
            <Receipt size={13} aria-hidden="true" /> View all invoices in Zano Books
          </Button>
          <Button variant="default" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      {/* Progress & valuation banner */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-subtle)] p-4">
        <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
          <span>Total Contract Valuation</span>
          <span className="font-bold text-[var(--text)]">
            R{' '}
            {totalAmount.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--canvas)]">
          <div
            className="h-full bg-[var(--accent)] transition-all duration-300"
            style={{
              width: `${totalAmount > 0 ? Math.min(100, Math.round((billedAmount / totalAmount) * 100)) : 0}%`,
            }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span className="font-medium text-[var(--accent-dark)]">
            Billed: R{' '}
            {billedAmount.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
          {reachedAmount > 0 && (
            <span className="font-medium text-[var(--warn)]">
              Ready to Bill: R{' '}
              {reachedAmount.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          )}
        </div>
      </div>

      {/* Sample-workspace guard: billing is off for demonstration data */}
      {sampleWritesBlocked && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] p-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          <ShieldAlert
            size={14}
            className="mt-0.5 shrink-0 text-[var(--warn)]"
            aria-hidden="true"
          />
          <div>{SAMPLE_WRITE_BLOCKED_REASON}</div>
        </div>
      )}

      {/* Success notice */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-[var(--success-border)] bg-[var(--success-bg)] p-3 text-xs text-[var(--text)]"
        >
          <CheckCircle2
            size={16}
            className="mt-0.5 shrink-0 text-[var(--success)]"
            aria-hidden="true"
          />
          <div className="flex-1 font-medium">{toastMessage}</div>
          <IconButton label="Dismiss billing message" onClick={() => setToastMessage(null)}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
      )}

      {/* Error notice (with retry — billing is idempotent) */}
      {error && (
        <div
          role="alert"
          className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3 text-xs text-[var(--text)]"
        >
          <X size={16} className="mt-0.5 shrink-0 text-[var(--danger)]" aria-hidden="true" />
          <div className="flex-1">
            <div>{error.message}</div>
            {(() => {
              const retryTarget = milestones.find((m) => m.id === error.milestoneId)
              if (!retryTarget || billingMilestoneId !== null || error.retryable === false)
                return null
              return (
                <Button
                  size="sm"
                  variant="default"
                  className="mt-1.5 border-[var(--danger-border)] text-[var(--danger-text)]"
                  onClick={() => void handleBill(retryTarget)}
                >
                  Retry billing
                </Button>
              )
            })()}
          </div>
          <IconButton label="Dismiss billing message" onClick={() => setError(null)}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
      )}

      {/* Milestones list */}
      {/* milestones list — keyboard-focusable scroll region: a tender whose
          milestones are all still pending has no focusable control inside it */}
      <div
        role="group"
        aria-label="Contract milestones"
        tabIndex={0}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto scroll-thin p-4 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset focus-visible:outline-none"
      >
        {milestones.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Award
              size={32}
              className="mb-2 stroke-[1.5] text-[var(--text-tertiary)]"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-[var(--text-secondary)]">
              No contract milestones defined
            </p>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              Contract delivery milestones track progressive project phases and generate Books tax
              invoices.
            </p>
          </div>
        ) : (
          milestones.map((ms, index) => {
            const isReached = ms.status === 'REACHED'
            const isBilled = ms.status === 'BILLED'
            const isPaid = ms.status === 'PAID'
            const isPending = ms.status === 'PENDING'
            const isCurrentBilling = billingMilestoneId === ms.id

            return (
              <div
                key={ms.id || index}
                className={`rounded-xl border p-4 transition-colors ${
                  isPaid
                    ? 'border-[var(--success-border)] bg-[var(--success-bg)]'
                    : isBilled
                      ? 'border-[var(--border)] bg-[var(--surface-subtle)]'
                      : isReached
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--border)] bg-[var(--surface)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-semibold text-[var(--text-tertiary)]">
                        Phase {index + 1}
                      </span>
                      {isReached && <Badge tone="indigo">Ready to Bill</Badge>}
                      {isBilled && <Badge tone="violet">Billed</Badge>}
                      {isPaid && <Badge tone="green">Paid</Badge>}
                      {isPending && <Badge tone="amber">Pending</Badge>}
                    </div>
                    <h3 className="mt-1 text-sm leading-snug font-semibold text-[var(--text)]">
                      {ms.name || ms.title || 'Milestone'}
                    </h3>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="text-sm font-bold text-[var(--text)]">
                      R{' '}
                      {Number(ms.amount || 0).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                    <div className="text-[10px] text-[var(--text-secondary)]">incl. 15% VAT</div>
                  </div>
                </div>

                {ms.description && (
                  <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                    {ms.description}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3 text-[11px] text-[var(--text-tertiary)]">
                  <div className="flex flex-wrap items-center gap-3">
                    {ms.dueDate && (
                      <span className="inline-flex items-center gap-1">
                        <Clock size={12} aria-hidden="true" /> Due: {ms.dueDate}
                      </span>
                    )}
                    {(ms as { paidAt?: string }).paidAt ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-[var(--text)]">
                        <CheckCircle2
                          size={12}
                          className="text-[var(--success)]"
                          aria-hidden="true"
                        />{' '}
                        Paid:{' '}
                        {new Date(
                          (ms as { paidAt?: string }).paidAt as string,
                        ).toLocaleDateString()}
                      </span>
                    ) : ms.billedAt ? (
                      <span className="inline-flex items-center gap-1">
                        Billed: {new Date(ms.billedAt).toLocaleDateString()}
                      </span>
                    ) : null}
                  </div>

                  {/* Actions based on milestone status */}
                  <div>
                    {isReached && (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={isCurrentBilling || sampleWritesBlocked}
                        title={sampleWritesBlocked ? SAMPLE_WRITE_BLOCKED_REASON : undefined}
                        onClick={() => handleBill(ms)}
                      >
                        {isCurrentBilling ? (
                          <>
                            <Spinner /> Invoicing…
                          </>
                        ) : (
                          <>
                            <Zap size={13} aria-hidden="true" /> Bill Milestone in Zano Books
                          </>
                        )}
                      </Button>
                    )}

                    {isBilled && (
                      <Button
                        size="sm"
                        variant="default"
                        onClick={handleOpenBooks}
                        title="Open invoice in Zano Books"
                      >
                        <FileText size={12} aria-hidden="true" />
                        <span>{ms.billedInvoiceNumber || 'View in Books'}</span>
                        <ExternalLink
                          size={10}
                          className="text-[var(--text-tertiary)]"
                          aria-hidden="true"
                        />
                      </Button>
                    )}

                    {isPaid && (
                      <Button
                        size="sm"
                        variant="default"
                        onClick={handleOpenBooks}
                        title="View settled invoice in Zano Books"
                        className="border-[var(--success-border)] text-[var(--color-brand-secondary)]"
                      >
                        <FileText size={12} aria-hidden="true" />
                        <span>{ms.billedInvoiceNumber || 'View in Books'}</span>
                        <ExternalLink
                          size={10}
                          className="text-[var(--success)]"
                          aria-hidden="true"
                        />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </Drawer>
  )
}

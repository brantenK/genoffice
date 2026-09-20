// Bid-readiness drawer: the pre-submission gate for the active tender.
// Renders the readiness checks (requirements resolved, linked docs valid AT
// the closing date, signature checklist, company-details consistency,
// deadline), a per-signature-item checkbox list, and the
// "Mark ready to submit" action that moves the tender to READY_FOR_SUBMISSION
// through the legal lifecycle path.
//
// Chrome is tokens-only so the drawer follows light/dark/system; the score ring
// carries its percentage in text, so status is never colour-only.
import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  PenLine,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { useNow } from '../deadline'
import { assessReadiness, labelForRule, signatureRuleKeys } from '../readiness'
import { selectActiveTender, useTendersStore } from '../store'
import { TENDER_TRANSITIONS } from '../../../shared/lifecycle'
import { TENDER_STATUS_LABEL, type TenderStatus } from '../../shared/types'
import { Drawer } from './Drawer'
import { Badge, Button, FORM_CHECKBOX_CLASS } from './ui'

/**
 * Shortest legal path through the lifecycle graph, excluding the start status.
 * Returns `[]` when `from === to` and `null` when no path exists, so the drawer
 * never jumps an illegal transition (e.g. IN_PROGRESS → READY_FOR_SUBMISSION).
 */
export function readinessTransitionPath(
  from: TenderStatus,
  to: TenderStatus,
): TenderStatus[] | null {
  if (from === to) return []
  const queue: TenderStatus[][] = [[from]]
  const seen = new Set<TenderStatus>([from])
  while (queue.length > 0) {
    const path = queue.shift() as TenderStatus[]
    const tail = path[path.length - 1]
    for (const next of TENDER_TRANSITIONS[tail]) {
      if (seen.has(next)) continue
      const candidate = [...path, next]
      if (next === to) return candidate.slice(1)
      seen.add(next)
      queue.push(candidate)
    }
  }
  return null
}

export function ReadinessDrawer({ onClose }: { onClose: () => void }) {
  const tender = useTendersStore(selectActiveTender)
  const vault = useTendersStore((s) => s.vault)
  const company = useTendersStore((s) => s.company)
  const setSignatureCheck = useTendersStore((s) => s.setSignatureCheck)
  const transitionTenderStatus = useTendersStore((s) => s.transitionTenderStatus)
  const [actionError, setActionError] = useState<string | null>(null)
  const now = useNow(60_000)

  if (!tender) return null

  const report = assessReadiness(tender, vault, company, now)
  const sigKeys = signatureRuleKeys(tender)
  const isReady = tender.status === 'READY_FOR_SUBMISSION'

  /**
   * Move the tender by recording every legal step explicitly, so the lifecycle
   * history keeps a meaningful reason instead of an illegal status jump. A
   * denied step is surfaced and no further step runs.
   */
  const applyLifecycle = (target: TenderStatus, reason: string): void => {
    setActionError(null)
    const path = readinessTransitionPath(tender.status, target)
    if (path === null) {
      setActionError(
        `This tender cannot move to ${TENDER_STATUS_LABEL[target]} from ${TENDER_STATUS_LABEL[tender.status]}.`,
      )
      return
    }
    for (const step of path) {
      const result = transitionTenderStatus(tender.id, step, { reason })
      if (!result.ok) {
        setActionError(result.error ?? 'Could not update the tender status.')
        return
      }
    }
  }

  return (
    <Drawer
      title="Bid readiness"
      subtitle="Pre-submission checklist"
      closeLabel="Close readiness"
      width="md"
      onClose={onClose}
      footer={
        <div>
          {isReady ? (
            <div className="flex items-center justify-between gap-2">
              <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text)]">
                <ShieldCheck size={15} className="text-[var(--success)]" aria-hidden="true" />
                {TENDER_STATUS_LABEL.READY_FOR_SUBMISSION}
              </p>
              <Button
                size="sm"
                variant="default"
                title="Move the tender back to in-progress"
                onClick={() =>
                  applyLifecycle('IN_PROGRESS', 'Returned to preparing from the readiness drawer')
                }
              >
                Back to in progress
              </Button>
            </div>
          ) : (
            <Button
              className="w-full justify-center"
              variant="primary"
              disabled={!report.ready}
              onClick={() =>
                applyLifecycle(
                  'READY_FOR_SUBMISSION',
                  'Marked ready to submit from the readiness drawer',
                )
              }
              title={
                report.ready
                  ? 'Mark this tender as ready for submission'
                  : 'Resolve every blocking check first'
              }
            >
              <ClipboardCheck size={14} aria-hidden="true" /> Mark ready to submit
            </Button>
          )}
          {actionError && (
            <p
              role="alert"
              className="mt-2 inline-flex items-start gap-1.5 text-[11px] leading-snug text-[var(--danger-text)]"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              {actionError}
            </p>
          )}
          <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
            Documents are re-checked as they will stand on the closing date, not today.
          </p>
        </div>
      }
    >
      {/* summary banner */}
      <div
        className={`shrink-0 border-b px-4 py-3 ${
          report.ready
            ? 'border-[var(--success-border)] bg-[var(--success-bg)]'
            : 'border-[var(--warn-border)] bg-[var(--warn-bg)]'
        }`}
      >
        <div className="flex items-center gap-3">
          {/* weighted score ring — the number carries the meaning, not the colour */}
          <div
            className={`flex size-14 shrink-0 items-center justify-center rounded-full border-4 ${
              report.score >= 80
                ? 'border-[var(--success)]'
                : report.score >= 50
                  ? 'border-[var(--warn)]'
                  : 'border-[var(--danger)]'
            }`}
            title="Weighted readiness score"
          >
            <span className="text-sm font-bold text-[var(--text)]">{report.score}%</span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--text)]">
              {report.ready
                ? 'All blocking checks pass — this tender can be marked ready to submit.'
                : `${report.blockingFailedCount} blocking check${report.blockingFailedCount === 1 ? '' : 's'} still failing.`}
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
              {report.score}% ready · {report.passedCount}/{report.checks.length} checks passed
            </p>
          </div>
        </div>
        {/* highest-leverage fix: the failing check worth the most score points */}
        {!report.ready && report.nextBestAction && (
          <p className="mt-2 rounded-md bg-[var(--surface)] px-2 py-1.5 text-[11px] leading-snug text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text)]">Biggest gain:</span>{' '}
            {report.nextBestAction.label} — {report.nextBestAction.detail}
          </p>
        )}
      </div>

      {/* checks — a scrollable region with no focusable content of its own, so
          it is reachable and scrollable from the keyboard (WCAG 2.1.1) */}
      <div
        role="group"
        aria-label="Bid readiness checks"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto scroll-thin p-3 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset focus-visible:outline-none"
      >
        <ul className="space-y-2">
          {report.checks.map((check) => (
            <li
              key={check.id}
              className={`rounded-lg border p-3 ${
                check.passed
                  ? 'border-[var(--success-border)] bg-[var(--success-bg)]'
                  : check.blocking
                    ? 'border-[var(--danger-border)] bg-[var(--danger-bg)]'
                    : 'border-[var(--warn-border)] bg-[var(--warn-bg)]'
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">
                  {check.passed ? (
                    <CheckCircle2 size={15} className="text-[var(--success)]" aria-hidden="true" />
                  ) : check.blocking ? (
                    <XCircle size={15} className="text-[var(--danger)]" aria-hidden="true" />
                  ) : (
                    <AlertTriangle size={15} className="text-[var(--warn)]" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-[var(--text)]">
                    {check.label}
                    {!check.blocking && <Badge tone="slate">Advisory</Badge>}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{check.detail}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>

        {/* signature checklist */}
        {sigKeys.length > 0 && (
          <div className="mt-4 rounded-lg border border-[var(--border)] p-3">
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text)]">
              <PenLine size={13} className="text-[var(--accent)]" aria-hidden="true" /> Signature
              checklist
            </h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
              Tick each item once the signed/initialled originals are in the bid pack.
            </p>
            <ul className="mt-2 space-y-1.5">
              {sigKeys.map((key) => (
                <li key={key}>
                  <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      checked={tender.signatureChecks[key] ?? false}
                      onChange={(e) => setSignatureCheck(tender.id, key, e.target.checked)}
                      className={FORM_CHECKBOX_CLASS}
                    />
                    {labelForRule(key)}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Drawer>
  )
}

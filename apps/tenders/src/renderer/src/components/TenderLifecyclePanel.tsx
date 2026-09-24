// Tender lifecycle panel — Phase 4, WP-11.
//
// A compact, always-visible strip under the tender header that shows where the
// bid stands, whether proof of submission exists, and what happened at the
// outcome. Expanding it reveals the submission record (including any
// blocker-override audit — never described as "cleared"), the outcome record and
// the append-only lifecycle history.
//
// It also owns the two write guards that belong to the bid itself:
//   • sample ("demo") workspaces cannot sync to CRM or bill Books — the bid can
//     be copied into the user's own workspace first;
//   • contract milestones are only exposed for a won tender (`milestonesAllowed`).
import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Copy,
  FileText,
  Gavel,
  Send,
  ShieldAlert,
  X,
} from 'lucide-react'
import {
  SUBMISSION_METHOD_LABEL,
  TENDER_OUTCOME_LABEL,
  TENDER_STATUS_LABEL,
  type TenderRecord,
  type TenderStatus,
  type TendersDataV2,
  type TendersWorkspaceV2,
} from '../../shared/types'
import {
  isOutcomeStatus,
  isSubmittedStatus,
  makeLifecycleEvent,
  milestonesAllowed,
  submissionEvidenceState,
} from '../../../shared/lifecycle'
import { formatRandAmount } from '../../../shared/money'
import { validateTendersDataV2 } from '../../../shared/tenders-schema'
import { isSampleWorkspace } from '../mock/sample-workspace'
import { assessReadiness } from '../readiness'
import { selectActiveTender, useTendersStore } from '../store'
import { Badge, Button } from './ui'
import { EVIDENCE_LABEL, SubmissionDialog, submissionEvidenceLabel } from './SubmissionDialog'
import { OutcomeDialog } from './OutcomeDialog'

const PIPELINE_SHORT_LABEL: Record<TenderStatus, string> = {
  IN_PROGRESS: 'Preparing',
  READY_TO_ASSEMBLE: 'Assemble',
  PACK_GENERATED: 'Pack',
  READY_FOR_SUBMISSION: 'Ready',
  SUBMITTED: 'Submitted',
  SUBMITTED_EVIDENCED: 'Evidenced',
  WON: 'Won',
  LOST: 'Lost',
  WITHDRAWN: 'Withdrawn',
  CANCELLED: 'Cancelled',
  ARCHIVED: 'Archived',
}

function statusTone(status: TenderStatus): 'slate' | 'green' | 'amber' | 'red' | 'indigo' | 'sky' {
  switch (status) {
    case 'READY_FOR_SUBMISSION':
      return 'indigo'
    case 'SUBMITTED':
      return 'amber'
    case 'SUBMITTED_EVIDENCED':
      return 'sky'
    case 'WON':
      return 'green'
    case 'LOST':
    case 'WITHDRAWN':
    case 'CANCELLED':
      return 'red'
    default:
      return 'slate'
  }
}

function formatInstant(value: string | null | undefined): string {
  if (!value) return 'Not recorded'
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

/**
 * A civil date — the notice date the user typed into the outcome dialog — is
 * not an instant, so it must not be rendered on the reader's own clock. The
 * persisted value is anchored at UTC midnight by `civilDateToRfc3339`, and an
 * unpinned format turned a notice date of 2026-08-14 into "13 Aug" for a reader
 * west of UTC. SAST is the civil-display convention the closing-date runway
 * already uses (`deadline.ts`), and against a UTC-midnight anchor it prints the
 * calendar day that was typed, on every machine.
 */
function formatCivilDate(value: string | null | undefined): string {
  if (!value) return 'Not stated'
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  if (isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Johannesburg',
  })
}

/**
 * The awarded value, printed by the one rand formatter so it agrees with the
 * proposal document (`R 850 000,50`, not `R 850 000.5`).
 */
export function formatMoney(value: number | null | undefined): string {
  if (value == null) return 'Not stated'
  return formatRandAmount(value)
}

/**
 * Prepare a demo tender for copying into a user workspace.
 *
 * Sample vault documents are deliberately NOT copied across (demo isolation),
 * so every workspace-scoped vault reference — requirements'
 * `linkedVaultDocId` / `suggestedVaultDocIds` — is dropped unless the target
 * workspace's own vault actually contains that id. Without this the copy is a
 * dangling reference and the schema rejects the whole document on save.
 */
export function cleanCopiedTender(
  tender: TenderRecord,
  targetVaultIds: ReadonlySet<string>,
): TenderRecord {
  const cloned = structuredClone(tender)
  const cleanId = (id: string | null | undefined): string | null =>
    id && targetVaultIds.has(id) ? id : null
  return {
    ...cloned,
    requirements: cloned.requirements.map((requirement) => ({
      ...requirement,
      linkedVaultDocId: cleanId(requirement.linkedVaultDocId),
      suggestedVaultDocIds: requirement.suggestedVaultDocIds.filter((id) => targetVaultIds.has(id)),
    })),
  }
}

export function TenderLifecyclePanel({ onOpenMilestones }: { onOpenMilestones: () => void }) {
  const tender = useTendersStore(selectActiveTender)
  const vault = useTendersStore((s) => s.vault)
  const company = useTendersStore((s) => s.company)
  const workspaces = useTendersStore((s) => s.workspaces)
  const activeCompanyId = useTendersStore((s) => s.activeCompanyId)
  const transitionTenderStatus = useTendersStore((s) => s.transitionTenderStatus)
  const setActiveCompany = useTendersStore((s) => s.setActiveCompany)
  const addTender = useTendersStore((s) => s.addTender)
  const setActiveTender = useTendersStore((s) => s.setActiveTender)
  const saveStatus = useTendersStore((s) => s.saveStatus)
  const saveError = useTendersStore((s) => s.saveError)
  const retrySave = useTendersStore((s) => s.retrySave)

  const [expanded, setExpanded] = useState(false)
  const [submissionOpen, setSubmissionOpen] = useState(false)
  const [outcomeOpen, setOutcomeOpen] = useState(false)
  const [reasonFor, setReasonFor] = useState<TenderStatus | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const readiness = useMemo(
    () => (tender ? assessReadiness(tender, vault, company, new Date()) : null),
    [tender, vault, company],
  )

  if (!tender || !readiness) return null

  const activeWorkspace = workspaces.find((ws) => ws.id === activeCompanyId) ?? null
  const sampleWorkspace = isSampleWorkspace(activeWorkspace)
  const ownWorkspaces = workspaces.filter((ws) => !isSampleWorkspace(ws))
  const copyTarget = ownWorkspaces[0] ?? null

  const status = tender.status
  const submission = tender.submission ?? null
  const outcome = tender.outcome ?? null
  const evidenceState = submissionEvidenceState(status, submission)
  const billingAllowed = milestonesAllowed(status)
  const history = tender.lifecycle ?? []
  const pipelineIndex = (
    [
      'IN_PROGRESS',
      'READY_TO_ASSEMBLE',
      'PACK_GENERATED',
      'READY_FOR_SUBMISSION',
      'SUBMITTED',
      'SUBMITTED_EVIDENCED',
      'WON',
    ] as TenderStatus[]
  ).indexOf(status)

  const runTransition = (to: TenderStatus, reasonText: string | null): void => {
    setError(null)
    setNotice(null)
    const result = transitionTenderStatus(tender.id, to, { reason: reasonText })
    if (!result.ok) {
      setError(result.error ?? 'That status change is not allowed.')
      return
    }
    setReasonFor(null)
    setReason('')
    setNotice(`Moved to ${TENDER_STATUS_LABEL[to]}.`)
  }

  const copyIntoOwnWorkspace = (): void => {
    setError(null)
    setNotice(null)
    if (!copyTarget) {
      setError(
        'Create your own company workspace first (company switcher → Add company), then copy this tender into it.',
      )
      return
    }
    const clash = copyTarget.tenders.some(
      (other) =>
        other.referenceNumber &&
        tender.referenceNumber &&
        other.referenceNumber === tender.referenceNumber,
    )
    if (clash) {
      setError(
        `“${copyTarget.company.tradingName}” already has a tender with reference ${tender.referenceNumber}. Resolve that reference first.`,
      )
      return
    }
    const at = new Date().toISOString()
    // Sample vault docs are not copied into the user's workspace; drop any
    // reference the target vault cannot satisfy so the copy stays internally
    // consistent (see cleanCopiedTender).
    const copy: TenderRecord = {
      ...cleanCopiedTender(tender, new Set(copyTarget.vault.map((doc) => doc.id))),
      id: `t-${Date.now()}-copy`,
      status: 'IN_PROGRESS',
      submission: null,
      outcome: null,
      linkedCrmDealId: null,
      // A sample submission or outcome is demonstration data; the real copy starts
      // from preparing with a lifecycle entry that says where it came from.
      lifecycle: [makeLifecycleEvent(null, 'IN_PROGRESS', 'Copied from the sample workspace', at)],
    }

    // Pre-validate the prospective document BEFORE claiming success. The store
    // would otherwise reject the inconsistent copy on save, producing a
    // "Copied" notice immediately followed by "Save failed".
    const nextTarget: TendersWorkspaceV2 = {
      ...copyTarget,
      tenders: [...copyTarget.tenders, copy],
    }
    const prospective: TendersDataV2 = {
      schemaVersion: 2,
      revision: 0,
      updatedAt: at,
      activeCompanyId: nextTarget.id,
      workspaces: workspaces.map((ws) => (ws.id === nextTarget.id ? nextTarget : ws)),
      issuerTemplates: useTendersStore.getState().issuerTemplates,
    }
    const validation = validateTendersDataV2(prospective)
    if (!validation.ok) {
      const first = validation.issues[0]
      setError(
        first
          ? `Could not copy this tender: ${first.path ? `${first.path}: ` : ''}${first.message}`
          : 'Could not copy this tender into your workspace.',
      )
      return
    }

    setActiveCompany(copyTarget.id)
    addTender(copy)
    setActiveTender(copy.id)
    setNotice(`Copied into “${copyTarget.company.tradingName}” as a new tender.`)
  }

  const primaryAction = (() => {
    switch (status) {
      case 'IN_PROGRESS':
        return { label: 'Mark ready to assemble', to: 'READY_TO_ASSEMBLE' as TenderStatus }
      case 'READY_TO_ASSEMBLE':
        return { label: 'Record pack generated', to: 'PACK_GENERATED' as TenderStatus }
      case 'PACK_GENERATED':
        return { label: 'Mark ready to submit', to: 'READY_FOR_SUBMISSION' as TenderStatus }
      case 'READY_FOR_SUBMISSION':
        return { label: 'Record submission…', dialog: 'submission' as const }
      case 'SUBMITTED':
        return { label: 'Add submission evidence…', dialog: 'submission' as const }
      case 'SUBMITTED_EVIDENCED':
        return { label: 'Record outcome…', dialog: 'outcome' as const }
      default:
        return null
    }
  })()

  return (
    <section
      className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-subtle)]"
      aria-label="Tender lifecycle"
    >
      {/* compact bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge tone={statusTone(status)}>{TENDER_STATUS_LABEL[status]}</Badge>
          {isSubmittedStatus(status) && (
            <Badge tone={evidenceState === 'recorded' ? 'green' : 'amber'}>
              {submissionEvidenceLabel(evidenceState)}
            </Badge>
          )}
          {outcome && <Badge tone="violet">{TENDER_OUTCOME_LABEL[outcome.status]}</Badge>}
          {submission?.blockerOverrideReason && (
            <span title="Submitted with blockers using an audited override">
              <Badge tone="red">
                <ShieldAlert size={11} /> Submitted with override
              </Badge>
            </span>
          )}
          {sampleWorkspace && (
            <span title="Demonstration data — CRM sync and Books billing are switched off">
              <Badge tone="amber">Sample workspace</Badge>
            </span>
          )}
          <span className="text-[11px] text-[var(--text-secondary)]">
            Readiness {readiness.ready ? 'clear' : `${readiness.score}%`}
            {readiness.blockingFailedCount > 0
              ? ` · ${readiness.blockingFailedCount} blocking`
              : ''}
          </span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {primaryAction && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setError(null)
                setNotice(null)
                if ('dialog' in primaryAction && primaryAction.dialog === 'submission') {
                  setSubmissionOpen(true)
                } else if ('dialog' in primaryAction && primaryAction.dialog === 'outcome') {
                  setOutcomeOpen(true)
                } else if ('to' in primaryAction) {
                  runTransition(primaryAction.to, null)
                }
              }}
            >
              {primaryAction.label}
            </Button>
          )}
          {/* Recording the outcome stays reachable without expanding the details. */}
          {status === 'SUBMITTED' && (
            <Button
              size="sm"
              variant="default"
              onClick={() => {
                setError(null)
                setNotice(null)
                setOutcomeOpen(true)
              }}
            >
              <Gavel size={13} /> Record outcome…
            </Button>
          )}
          {status === 'WON' && billingAllowed && (
            <Button size="sm" variant="default" onClick={onOpenMilestones}>
              Contract milestones
            </Button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          >
            {expanded ? (
              <ChevronDown size={12} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} aria-hidden="true" />
            )}
            {expanded ? 'Hide details' : 'Details & history'}
          </button>
        </div>
      </div>

      {/* Fail-closed persistence surface: never let an optimistic status/outcome
          change look saved when the authoritative save failed. */}
      {saveStatus === 'error' && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-t border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-2 text-[11px] font-medium text-[var(--danger-text)]"
        >
          <AlertTriangle size={12} aria-hidden="true" className="shrink-0" />
          <span>
            Not saved{saveError ? ` — ${saveError}` : ''}. This change is still only on screen.
          </span>
          <Button size="sm" variant="default" onClick={retrySave} className="ml-auto">
            Retry save
          </Button>
        </div>
      )}

      {/* live feedback */}
      <p className="sr-only" role="status" aria-live="polite">
        {notice ?? error ?? ''}
      </p>
      {(notice || error) && (
        <div className="px-4 pb-2">
          {notice && (
            <p className="rounded-md border border-[var(--success-border)] bg-[var(--success-bg)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">
              {notice}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2 py-1 text-[11px] font-medium text-[var(--danger-text)]"
            >
              {error}
            </p>
          )}
        </div>
      )}

      {expanded && (
        <div className="max-h-[45vh] space-y-3 overflow-y-auto scroll-thin border-t border-[var(--border)] px-4 py-3">
          {/* pipeline */}
          <ol
            className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
            aria-label="Tender pipeline"
          >
            {(
              [
                'IN_PROGRESS',
                'READY_TO_ASSEMBLE',
                'PACK_GENERATED',
                'READY_FOR_SUBMISSION',
                'SUBMITTED',
                'SUBMITTED_EVIDENCED',
                'WON',
              ] as TenderStatus[]
            ).map((stage, index) => {
              const current = stage === status
              const done = pipelineIndex > index
              return (
                <li key={stage} className="inline-flex items-center gap-1.5">
                  <span
                    aria-current={current ? 'step' : undefined}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      current
                        ? 'bg-[var(--accent-soft)] text-[var(--accent-dark)]'
                        : done
                          ? 'text-[var(--text-secondary)]'
                          : 'text-[var(--text-tertiary)]'
                    }`}
                  >
                    {done && <CheckCircle2 size={10} aria-hidden="true" />}
                    {PIPELINE_SHORT_LABEL[stage]}
                  </span>
                  {index < 6 && (
                    <ArrowRight
                      size={10}
                      className="text-[var(--text-tertiary)]"
                      aria-hidden="true"
                    />
                  )}
                </li>
              )
            })}
          </ol>

          {isOutcomeStatus(status) && (
            <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              This tender is closed as <strong>{TENDER_STATUS_LABEL[status]}</strong>. Contract
              milestones and Books billing are only available for a won tender.
            </p>
          )}

          {/* next steps + secondary moves */}
          <div className="flex flex-wrap items-center gap-2">
            {status === 'READY_FOR_SUBMISSION' && (
              <Button size="sm" variant="default" onClick={() => setReasonFor('PACK_GENERATED')}>
                Back to pack generated
              </Button>
            )}
            {status === 'PACK_GENERATED' && (
              <Button size="sm" variant="default" onClick={() => setReasonFor('READY_TO_ASSEMBLE')}>
                Back to assemble
              </Button>
            )}
            {status === 'READY_TO_ASSEMBLE' && (
              <Button size="sm" variant="default" onClick={() => setReasonFor('IN_PROGRESS')}>
                Back to preparing
              </Button>
            )}
            {status === 'SUBMITTED' && (
              <Button
                size="sm"
                variant="default"
                onClick={() => setReasonFor('READY_FOR_SUBMISSION')}
              >
                Correct to ready for submission
              </Button>
            )}
            {status !== 'ARCHIVED' && (
              <Button size="sm" variant="default" onClick={() => setReasonFor('ARCHIVED')}>
                <Archive size={13} /> Archive tender
              </Button>
            )}
            {!isOutcomeStatus(status) && status !== 'ARCHIVED' && (
              <Button size="sm" variant="danger" onClick={() => setReasonFor('CANCELLED')}>
                <X size={13} /> Cancel tender…
              </Button>
            )}
          </div>

          {reasonFor && (
            <ReasonPrompt
              target={reasonFor}
              value={reason}
              onChange={setReason}
              onCancel={() => {
                setReasonFor(null)
                setReason('')
              }}
              onConfirm={() => runTransition(reasonFor, reason.trim() || null)}
            />
          )}

          {/* submission record */}
          {submission ? (
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
              <h3 className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--text)]">
                <Send size={13} className="text-[var(--accent)]" aria-hidden="true" />
                Submission record
                <Badge tone={evidenceState === 'recorded' ? 'green' : 'amber'}>
                  {submissionEvidenceLabel(evidenceState)}
                </Badge>
              </h3>
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                <RecordRow label="Submitted at">
                  {formatInstant(submission.submittedAt)}
                  {submission.timeZone ? ` (${submission.timeZone})` : ''}
                </RecordRow>
                <RecordRow label="Method">{SUBMISSION_METHOD_LABEL[submission.method]}</RecordRow>
                <RecordRow label="Destination">
                  {submission.destination || 'Not recorded'}
                </RecordRow>
                <RecordRow label="Confirmation / reference">
                  {submission.confirmationReference || 'Not recorded'}
                </RecordRow>
                <RecordRow label="Submitted by">{submission.person || 'Not recorded'}</RecordRow>
                <RecordRow label="Evidence">
                  {submission.evidence
                    ? `${EVIDENCE_LABEL[submission.evidence.kind] ?? submission.evidence.kind}${submission.evidence.reference ? ` · ${submission.evidence.reference}` : ''}`
                    : 'No evidence attached yet'}
                </RecordRow>
              </dl>
              {submission.evidence?.note && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                  {submission.evidence.note}
                </p>
              )}
              {submission.notes && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {submission.notes}
                </p>
              )}

              {/* readiness snapshot + override audit */}
              {submission.readiness && (
                <div className="mt-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-2">
                  <p className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Readiness checkpoint at submission:{' '}
                    {submission.readiness.ready ? 'clear' : 'not clear'} ·{' '}
                    {submission.readiness.score}%
                  </p>
                  {submission.readiness.blockingCheckIds.length > 0 && (
                    <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                      {submission.readiness.blockingCheckIds.length} blocking check
                      {submission.readiness.blockingCheckIds.length === 1 ? '' : 's'} were failing
                      and are preserved on this record:{' '}
                      {submission.readiness.blockingCheckIds.join(', ')}.
                    </p>
                  )}
                  <p className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">
                    Captured {formatInstant(submission.readiness.capturedAt)}
                  </p>
                </div>
              )}

              {submission.blockerOverrideReason && (
                <div className="mt-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2.5 py-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text)]">
                    <ShieldAlert size={12} className="text-[var(--danger)]" aria-hidden="true" />
                    Blocker override recorded
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    {submission.blockerOverrideReason}
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-tertiary)]">
                    Recorded as an override with the blockers above unchanged. This is not a
                    readiness clearance.
                  </p>
                </div>
              )}
            </section>
          ) : isSubmittedStatus(status) || isOutcomeStatus(status) ? (
            <p className="rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              No submission record was captured for this tender (it was marked submitted before
              proof-of-submission capture existed). Add the details you have — the evidence stays
              “required” until a receipt is recorded.
            </p>
          ) : null}

          {/* outcome record */}
          {outcome && (
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
              <h3 className="flex items-center gap-2 text-xs font-semibold text-[var(--text)]">
                <Gavel size={13} className="text-[var(--accent)]" aria-hidden="true" />
                Outcome
                <Badge tone="violet">{TENDER_OUTCOME_LABEL[outcome.status]}</Badge>
              </h3>
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                <RecordRow label="Notice date">{formatCivilDate(outcome.noticeDate)}</RecordRow>
                <RecordRow label="Awarded value">
                  {outcome.status === 'won' ? formatMoney(outcome.awardedValue) : 'Not applicable'}
                </RecordRow>
                <RecordRow label="Reference">
                  {outcome.evidenceReference || 'Not recorded'}
                </RecordRow>
                <RecordRow label="Recorded">{formatInstant(outcome.recordedAt)}</RecordRow>
              </dl>
              {outcome.reason && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {outcome.reason}
                </p>
              )}
            </section>
          )}

          {/* lifecycle history */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <h3 className="flex items-center gap-2 text-xs font-semibold text-[var(--text)]">
              <ClipboardList size={13} className="text-[var(--accent)]" aria-hidden="true" />
              Lifecycle history
              <span className="text-[10px] font-normal text-[var(--text-tertiary)]">
                ({history.length})
              </span>
            </h3>
            {history.length === 0 ? (
              <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
                No status changes recorded yet.
              </p>
            ) : (
              <ol className="mt-2 space-y-1.5">
                {history.map((event, index) => (
                  <li
                    key={`${event.at}-${index}`}
                    className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1.5 text-[11px]"
                  >
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--text-secondary)]">
                      <span className="font-medium text-[var(--text)]">
                        {event.from ? TENDER_STATUS_LABEL[event.from] : 'Created'}
                        {' → '}
                        {TENDER_STATUS_LABEL[event.to]}
                      </span>
                      <span className="text-[var(--text-tertiary)]">{formatInstant(event.at)}</span>
                    </p>
                    {event.reason && (
                      <p className="mt-0.5 leading-relaxed text-[var(--text-tertiary)]">
                        {event.reason}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* sample-workspace guard + copy */}
          {sampleWorkspace && (
            <section className="rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] p-3">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
                <ShieldAlert size={13} className="text-[var(--warn)]" aria-hidden="true" />
                Sample workspace
              </h3>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                This tender is demonstration data. CRM sync and Books billing are switched off while
                you are in the sample workspace. Copy it into your own workspace to work on it for
                real — the compliance matrix and extraction review come with it; any sample
                submission or outcome stays behind.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={copyIntoOwnWorkspace}
                  disabled={!copyTarget}
                  title={
                    copyTarget
                      ? `Copy into ${copyTarget.company.tradingName}`
                      : 'Create your own company workspace first'
                  }
                >
                  <Copy size={13} /> Copy into my workspace
                </Button>
                {!copyTarget && (
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    No own workspace yet — add one from the company switcher, then come back.
                  </span>
                )}
              </div>
            </section>
          )}

          <p className="text-[10px] leading-relaxed text-[var(--text-tertiary)]">
            <FileText size={10} className="mr-1 inline" aria-hidden="true" />
            Tenders records what you did — it never submits a bid, and it never reports a failed or
            skipped check as passed.
          </p>
        </div>
      )}

      {submissionOpen && (
        <SubmissionDialog
          tender={tender}
          readiness={readiness}
          onClose={() => setSubmissionOpen(false)}
        />
      )}
      {outcomeOpen && <OutcomeDialog tender={tender} onClose={() => setOutcomeOpen(false)} />}
    </section>
  )
}

function RecordRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-[var(--text-tertiary)]">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words text-[var(--text-secondary)]">
        {children}
      </dd>
    </div>
  )
}

function ReasonPrompt({
  target,
  value,
  onChange,
  onCancel,
  onConfirm,
}: {
  target: TenderStatus
  value: string
  onChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const cancelling = target === 'CANCELLED'
  const missingReason = cancelling && value.trim().length === 0
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <p className="text-[12px] font-semibold text-[var(--text)]">
        {target === 'CANCELLED' ? 'Cancel this tender' : `Move to ${TENDER_STATUS_LABEL[target]}`}
      </p>
      <label
        htmlFor="lifecycle-reason"
        className="mt-2 mb-1 block text-[11px] font-medium text-[var(--text-secondary)]"
      >
        {cancelling ? 'Why is it being cancelled?' : 'Reason (recorded in the history)'}
      </label>
      <textarea
        id="lifecycle-reason"
        rows={2}
        value={value}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          cancelling
            ? 'e.g. Issuer cancelled the tender before closing.'
            : 'Optional note for the lifecycle history.'
        }
        className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)] focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)]"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={cancelling ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={missingReason}
          title={missingReason ? 'A cancellation needs a reason' : undefined}
        >
          {cancelling ? 'Cancel this tender' : `Move to ${TENDER_STATUS_LABEL[target]}`}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Keep as is
        </Button>
      </div>
    </div>
  )
}

/** Condensed lifecycle summary used by the tender cards in the list. */
export function lifecycleCardSummary(tender: TenderRecord): {
  label: string
  tone: 'slate' | 'green' | 'amber' | 'red' | 'indigo' | 'sky'
  evidence: string | null
  evidenceTone: 'green' | 'amber'
  override: boolean
} {
  const state = submissionEvidenceState(tender.status, tender.submission ?? null)
  return {
    label: TENDER_STATUS_LABEL[tender.status],
    tone: statusTone(tender.status),
    evidence: isSubmittedStatus(tender.status) ? submissionEvidenceLabel(state) : null,
    evidenceTone: state === 'recorded' ? 'green' : 'amber',
    override: Boolean(tender.submission?.blockerOverrideReason),
  }
}

/**
 * True when cross-app writes (CRM sync, Books billing) must stay disabled for the
 * active workspace. Exported so the milestone/billing surfaces use one rule.
 */
export function crossAppWritesBlocked(
  workspaces: { id: string; dataOrigin?: string }[],
  activeCompanyId: string | null,
): boolean {
  return isSampleWorkspace(workspaces.find((ws) => ws.id === activeCompanyId) ?? null)
}

/** Warning copy shared by the CRM and Books guards. */
export const SAMPLE_WRITE_BLOCKED_REASON =
  'Sample workspace — CRM sync and Books billing are off for demonstration data. Copy the tender into your own workspace first.'

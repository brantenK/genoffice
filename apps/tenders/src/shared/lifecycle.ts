// Pure tender lifecycle state machine (Phase 4 / WP-11).
//
// No Electron, React or Zustand imports: this module is shared by the renderer
// store, the main process, and tests. It owns the allowed status transitions and
// their guards; callers own persistence. The state machine never describes a
// blocker-overridden submission as "cleared" — the readiness snapshot and its
// blockers are preserved on the submission record.
import type { ReadinessReport } from './readiness'
import type {
  IntakeVerification,
  TenderLifecycleEvent,
  TenderOutcomeRecord,
  TenderOutcomeStatus,
  TenderReadinessSnapshot,
  TenderStatus,
  TenderSubmissionRecord,
} from './types'

/**
 * Allowed status transitions. Real workflows regress (a pack is re-opened, a
 * readiness decision is revised), so backward moves within the assembly phase
 * are permitted. Outcome states are terminal except for archival.
 */
export const TENDER_TRANSITIONS: Readonly<Record<TenderStatus, readonly TenderStatus[]>> = {
  IN_PROGRESS: ['READY_TO_ASSEMBLE', 'CANCELLED', 'ARCHIVED'],
  READY_TO_ASSEMBLE: ['IN_PROGRESS', 'PACK_GENERATED', 'CANCELLED', 'ARCHIVED'],
  PACK_GENERATED: ['READY_TO_ASSEMBLE', 'READY_FOR_SUBMISSION', 'CANCELLED', 'ARCHIVED'],
  READY_FOR_SUBMISSION: ['PACK_GENERATED', 'SUBMITTED', 'CANCELLED', 'ARCHIVED'],
  SUBMITTED: [
    'READY_FOR_SUBMISSION',
    'SUBMITTED_EVIDENCED',
    'WON',
    'LOST',
    'WITHDRAWN',
    'ARCHIVED',
  ],
  SUBMITTED_EVIDENCED: ['SUBMITTED', 'WON', 'LOST', 'WITHDRAWN', 'ARCHIVED'],
  WON: ['ARCHIVED'],
  LOST: ['ARCHIVED'],
  WITHDRAWN: ['ARCHIVED'],
  CANCELLED: ['ARCHIVED'],
  ARCHIVED: [],
}

/** Ordered happy-path pipeline for progress display. */
export const TENDER_PIPELINE_ORDER: readonly TenderStatus[] = [
  'IN_PROGRESS',
  'READY_TO_ASSEMBLE',
  'PACK_GENERATED',
  'READY_FOR_SUBMISSION',
  'SUBMITTED',
  'SUBMITTED_EVIDENCED',
  'WON',
]

export const SUBMITTED_STATUSES: readonly TenderStatus[] = ['SUBMITTED', 'SUBMITTED_EVIDENCED']
const OUTCOME_STATES: readonly TenderStatus[] = ['WON', 'LOST', 'WITHDRAWN', 'CANCELLED']

const OUTCOME_TO_STATUS: Record<Exclude<TenderOutcomeStatus, 'pending'>, TenderStatus> = {
  won: 'WON',
  lost: 'LOST',
  withdrawn: 'WITHDRAWN',
  cancelled: 'CANCELLED',
}

export function isSubmittedStatus(status: TenderStatus): boolean {
  return SUBMITTED_STATUSES.includes(status)
}

export function isOutcomeStatus(status: TenderStatus): boolean {
  return OUTCOME_STATES.includes(status)
}

export function canTransition(from: TenderStatus, to: TenderStatus): boolean {
  return TENDER_TRANSITIONS[from]?.includes(to) ?? false
}

/** Map an outcome status onto the tender status it drives. */
export function outcomeStatusToTenderStatus(status: TenderOutcomeStatus): TenderStatus {
  return status === 'pending' ? 'SUBMITTED' : OUTCOME_TO_STATUS[status]
}

/**
 * Whether milestone billing may be exposed. Only a won tender has contract
 * milestones; lost / withdrawn / cancelled (and everything else) must not.
 */
export function milestonesAllowed(status: TenderStatus): boolean {
  return status === 'WON'
}

export type SubmissionEvidenceState = 'not-submitted' | 'required' | 'recorded'

/**
 * Submission evidence state derived from authoritative data: a submitted (or
 * outcome) tender with no evidence attachment is `required`; with one it is
 * `recorded`. Legacy `SUBMITTED` tenders simply have no submission record and
 * therefore report `required` — never "cleared".
 */
export function submissionEvidenceState(
  status: TenderStatus,
  submission: TenderSubmissionRecord | null | undefined,
): SubmissionEvidenceState {
  if (!isSubmittedStatus(status) && !isOutcomeStatus(status)) return 'not-submitted'
  return submission?.evidence ? 'recorded' : 'required'
}

export interface TransitionGuardContext {
  /** Readiness checkpoint captured by the caller, if any. */
  readiness?: TenderReadinessSnapshot | null
  /** True only when `readiness` reflects the tender's current revision. */
  readinessIsCurrent?: boolean
  /** Required to submit despite blockers or with no current checkpoint. */
  blockerOverrideReason?: string | null
  submission?: TenderSubmissionRecord | null
  outcome?: TenderOutcomeRecord | null
  intake?: IntakeVerification | null
}

export interface TransitionDecision {
  allowed: boolean
  /** True when the transition is only allowed via an explicit override. */
  requiresOverride: boolean
  /** Denial reason, or null when allowed. */
  reason: string | null
}

/**
 * Evaluate one transition against the documented guards:
 * - submitting requires a current, blockers-free readiness checkpoint, or an
 *   explicit non-empty override reason (the record then keeps its blockers);
 * - marking a submission "evidence recorded" requires evidence;
 * - outcome states require a matching outcome record.
 */
export function evaluateTransition(
  from: TenderStatus,
  to: TenderStatus,
  context: TransitionGuardContext = {},
): TransitionDecision {
  if (from === to) return { allowed: true, requiresOverride: false, reason: null }

  if (!canTransition(from, to)) {
    return {
      allowed: false,
      requiresOverride: false,
      reason: `Cannot move a tender from ${from} to ${to}.`,
    }
  }

  if (isSubmittedStatus(to)) {
    if (!context.submission) {
      return {
        allowed: false,
        requiresOverride: false,
        reason: 'A submission record is required before a tender can be marked submitted.',
      }
    }
    if (to === 'SUBMITTED_EVIDENCED' && !context.submission.evidence) {
      return {
        allowed: false,
        requiresOverride: false,
        reason: 'Submission evidence must be recorded before that state can be set.',
      }
    }
    // The readiness checkpoint gate applies to the ACT of submitting; once a
    // tender is already submitted, attaching evidence is not a re-submission.
    if (isSubmittedStatus(from)) return { allowed: true, requiresOverride: false, reason: null }

    const readiness = context.readiness ?? null
    const current = context.readinessIsCurrent === true
    const clearCheckpoint = readiness !== null && current && readiness.ready === true
    if (clearCheckpoint) return { allowed: true, requiresOverride: false, reason: null }

    const override = (context.blockerOverrideReason ?? '').trim()
    if (override.length === 0) {
      return {
        allowed: false,
        requiresOverride: true,
        reason:
          readiness === null || !current
            ? 'A current readiness checkpoint is required before submitting.'
            : 'Readiness has blocking checks; an explicit override reason is required to submit.',
      }
    }
    return { allowed: true, requiresOverride: true, reason: null }
  }

  if (isOutcomeStatus(to)) {
    const outcome = context.outcome ?? null
    if (!outcome || outcome.status === 'pending') {
      return {
        allowed: false,
        requiresOverride: false,
        reason: `An outcome record is required to move a tender to ${to}.`,
      }
    }
    const expected = OUTCOME_TO_STATUS[outcome.status]
    if (expected !== to) {
      return {
        allowed: false,
        requiresOverride: false,
        reason: `Outcome status "${outcome.status}" does not match the requested ${to} state.`,
      }
    }
    return { allowed: true, requiresOverride: false, reason: null }
  }

  return { allowed: true, requiresOverride: false, reason: null }
}

/** Append one lifecycle event without mutating the existing history. */
export function appendLifecycleEvent(
  history: readonly TenderLifecycleEvent[] | null | undefined,
  event: TenderLifecycleEvent,
): TenderLifecycleEvent[] {
  return [...(history ?? []), event]
}

/** Build a lifecycle history entry. */
export function makeLifecycleEvent(
  from: TenderStatus | null,
  to: TenderStatus,
  reason: string | null,
  at: string,
): TenderLifecycleEvent {
  return { at, from, to, reason }
}

/**
 * Freeze a readiness report into the compact snapshot persisted with a
 * submission. The snapshot keeps failing/blocking ids so a blocker-overridden
 * submission can never be rendered as "cleared".
 */
export function readinessSnapshotFromReport(
  report: ReadinessReport,
  capturedAt: string,
): TenderReadinessSnapshot {
  return {
    ready: report.ready,
    score: report.score,
    failedCheckIds: report.checks.filter((check) => !check.passed).map((check) => check.id),
    blockingCheckIds: report.checks
      .filter((check) => check.blocking && !check.passed)
      .map((check) => check.id),
    capturedAt,
  }
}

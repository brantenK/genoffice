/**
 * Phase 4 / WP-11 — pure tender lifecycle state machine.
 *
 * These tests own the documented rules: allowed/forbidden transitions, the
 * submit guard (a current clear readiness checkpoint, or an explicit audited
 * override that preserves the blocker snapshot and is never "cleared"),
 * evidence-before-"recorded", outcome matching, and append-only history.
 */
import { describe, expect, it } from 'vitest'
import type { ReadinessReport } from '../src/shared/readiness'
import {
  appendLifecycleEvent,
  canTransition,
  evaluateTransition,
  makeLifecycleEvent,
  milestonesAllowed,
  outcomeStatusToTenderStatus,
  readinessSnapshotFromReport,
  submissionEvidenceState,
  TENDER_PIPELINE_ORDER,
  TENDER_TRANSITIONS,
} from '../src/shared/lifecycle'
import type {
  TenderOutcomeRecord,
  TenderReadinessSnapshot,
  TenderStatus,
  TenderSubmissionRecord,
} from '../src/shared/types'

const AT = '2026-09-01T00:00:00.000Z'

function snapshot(overrides: Partial<TenderReadinessSnapshot> = {}): TenderReadinessSnapshot {
  return {
    ready: true,
    score: 100,
    failedCheckIds: [],
    blockingCheckIds: [],
    capturedAt: AT,
    ...overrides,
  }
}

function submission(overrides: Partial<TenderSubmissionRecord> = {}): TenderSubmissionRecord {
  return {
    submittedAt: AT,
    timeZone: 'Africa/Johannesburg',
    method: 'ELECTRONIC',
    destination: 'https://portal.example.test',
    confirmationReference: 'REF-1',
    evidence: null,
    person: 'A Person',
    notes: null,
    readiness: snapshot(),
    blockerOverrideReason: null,
    ...overrides,
  }
}

function outcome(
  status: TenderOutcomeRecord['status'],
  overrides: Partial<TenderOutcomeRecord> = {},
): TenderOutcomeRecord {
  return {
    status,
    noticeDate: null,
    reason: null,
    awardedValue: null,
    evidenceReference: null,
    recordedAt: AT,
    ...overrides,
  }
}

describe('lifecycle transition graph', () => {
  it('walks the documented happy path', () => {
    const path: TenderStatus[] = [
      'IN_PROGRESS',
      'READY_TO_ASSEMBLE',
      'PACK_GENERATED',
      'READY_FOR_SUBMISSION',
    ]
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`).toBe(true)
    }
    expect(TENDER_PIPELINE_ORDER).toEqual([
      'IN_PROGRESS',
      'READY_TO_ASSEMBLE',
      'PACK_GENERATED',
      'READY_FOR_SUBMISSION',
      'SUBMITTED',
      'SUBMITTED_EVIDENCED',
      'WON',
    ])
  })

  it('rejects illegal jumps and moves out of terminal states', () => {
    expect(canTransition('IN_PROGRESS', 'SUBMITTED')).toBe(false)
    expect(canTransition('IN_PROGRESS', 'WON')).toBe(false)
    expect(canTransition('WON', 'LOST')).toBe(false)
    expect(canTransition('ARCHIVED', 'IN_PROGRESS')).toBe(false)
    expect(evaluateTransition('IN_PROGRESS', 'SUBMITTED').allowed).toBe(false)
  })

  it('only lists real statuses as transition targets', () => {
    const all = Object.keys(TENDER_TRANSITIONS) as TenderStatus[]
    for (const targets of Object.values(TENDER_TRANSITIONS)) {
      for (const target of targets) expect(all).toContain(target)
    }
    expect(TENDER_TRANSITIONS.ARCHIVED).toEqual([])
  })
})

describe('submit guard and override audit', () => {
  it('allows submitting with a current, clear checkpoint', () => {
    const decision = evaluateTransition('READY_FOR_SUBMISSION', 'SUBMITTED', {
      submission: submission(),
      readiness: snapshot(),
      readinessIsCurrent: true,
    })
    expect(decision).toEqual({ allowed: true, requiresOverride: false, reason: null })
  })

  it('requires a submission record', () => {
    const decision = evaluateTransition('READY_FOR_SUBMISSION', 'SUBMITTED', {
      readiness: snapshot(),
      readinessIsCurrent: true,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/submission record/i)
  })

  it('denies a stale checkpoint unless an override reason is given', () => {
    const stale = evaluateTransition('READY_FOR_SUBMISSION', 'SUBMITTED', {
      submission: submission(),
      readiness: snapshot(),
      readinessIsCurrent: false,
    })
    expect(stale.allowed).toBe(false)
    expect(stale.requiresOverride).toBe(true)

    const overridden = evaluateTransition('READY_FOR_SUBMISSION', 'SUBMITTED', {
      submission: submission(),
      readiness: snapshot(),
      readinessIsCurrent: false,
      blockerOverrideReason: 'Deadline missed the checkpoint; manager approved.',
    })
    expect(overridden.allowed).toBe(true)
    expect(overridden.requiresOverride).toBe(true)
  })

  it('denies submitting with blockers unless an override reason is given', () => {
    const blocked = snapshot({
      ready: false,
      score: 40,
      failedCheckIds: ['requirements'],
      blockingCheckIds: ['requirements', 'docs-at-closing'],
    })
    const denied = evaluateTransition('READY_FOR_SUBMISSION', 'SUBMITTED', {
      submission: submission({ readiness: blocked }),
      readiness: blocked,
      readinessIsCurrent: true,
    })
    expect(denied.allowed).toBe(false)
    expect(denied.requiresOverride).toBe(true)
    expect(denied.reason).toMatch(/blocking/i)
    // Never described as cleared.
    expect(denied.reason ?? '').not.toMatch(/clear/i)
  })

  it('preserves the blocker snapshot on an overridden submission (never "cleared")', () => {
    const blocked = snapshot({
      ready: false,
      score: 40,
      blockingCheckIds: ['requirements'],
      failedCheckIds: ['requirements'],
    })
    const record = submission({ readiness: blocked, blockerOverrideReason: 'Board approved.' })
    const decision = evaluateTransition('READY_FOR_SUBMISSION', 'SUBMITTED', {
      submission: record,
      readiness: blocked,
      readinessIsCurrent: true,
      blockerOverrideReason: 'Board approved.',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.requiresOverride).toBe(true)
    // The audit keeps the failing readiness exactly as captured.
    expect(record.readiness).toEqual(blocked)
    expect(record.readiness?.ready).toBe(false)
    expect(record.readiness?.blockingCheckIds).toEqual(['requirements'])
    expect(record.blockerOverrideReason).toBe('Board approved.')
  })

  it('requires evidence before the "evidence recorded" state', () => {
    const missing = evaluateTransition('SUBMITTED', 'SUBMITTED_EVIDENCED', {
      submission: submission({ evidence: null }),
    })
    expect(missing.allowed).toBe(false)
    expect(missing.reason).toMatch(/evidence/i)

    const withEvidence = evaluateTransition('SUBMITTED', 'SUBMITTED_EVIDENCED', {
      submission: submission({
        evidence: { kind: 'email-receipt', reference: 'vd-9', note: null },
      }),
    })
    expect(withEvidence.allowed).toBe(true)
  })
})

describe('outcome guard', () => {
  it('requires a matching outcome record', () => {
    const missing = evaluateTransition('SUBMITTED', 'WON')
    expect(missing.allowed).toBe(false)

    const mismatch = evaluateTransition('SUBMITTED', 'LOST', { outcome: outcome('won') })
    expect(mismatch.allowed).toBe(false)
    expect(mismatch.reason).toMatch(/does not match/i)

    expect(evaluateTransition('SUBMITTED', 'WON', { outcome: outcome('won') }).allowed).toBe(true)
    expect(
      evaluateTransition('SUBMITTED_EVIDENCED', 'WITHDRAWN', { outcome: outcome('withdrawn') })
        .allowed,
    ).toBe(true)
  })

  it('maps outcome statuses onto tender statuses', () => {
    expect(outcomeStatusToTenderStatus('won')).toBe('WON')
    expect(outcomeStatusToTenderStatus('lost')).toBe('LOST')
    expect(outcomeStatusToTenderStatus('withdrawn')).toBe('WITHDRAWN')
    expect(outcomeStatusToTenderStatus('cancelled')).toBe('CANCELLED')
    expect(outcomeStatusToTenderStatus('pending')).toBe('SUBMITTED')
  })
})

describe('milestone exposure', () => {
  it('exposes contract milestones only for a won tender', () => {
    expect(milestonesAllowed('WON')).toBe(true)
    for (const status of [
      'IN_PROGRESS',
      'READY_TO_ASSEMBLE',
      'PACK_GENERATED',
      'READY_FOR_SUBMISSION',
      'SUBMITTED',
      'SUBMITTED_EVIDENCED',
      'LOST',
      'WITHDRAWN',
      'CANCELLED',
      'ARCHIVED',
    ] as TenderStatus[]) {
      expect(milestonesAllowed(status), status).toBe(false)
    }
  })
})

describe('submission evidence state', () => {
  it('derives required/recorded without ever claiming cleared', () => {
    expect(submissionEvidenceState('IN_PROGRESS', null)).toBe('not-submitted')
    expect(submissionEvidenceState('SUBMITTED', null)).toBe('required')
    expect(submissionEvidenceState('SUBMITTED', submission({ evidence: null }))).toBe('required')
    expect(
      submissionEvidenceState(
        'SUBMITTED',
        submission({ evidence: { kind: 'courier-slip', reference: 'vd-1', note: null } }),
      ),
    ).toBe('recorded')
    expect(
      submissionEvidenceState(
        'WON',
        submission({ evidence: { kind: 'portal-confirmation', reference: null, note: 'ok' } }),
      ),
    ).toBe('recorded')
  })
})

describe('append-only history', () => {
  it('appends without mutating the existing array', () => {
    const first = makeLifecycleEvent('IN_PROGRESS', 'READY_TO_ASSEMBLE', null, AT)
    const history = [first]
    const next = appendLifecycleEvent(
      history,
      makeLifecycleEvent('READY_TO_ASSEMBLE', 'PACK_GENERATED', 'pack built', AT),
    )
    expect(history).toHaveLength(1)
    expect(next).toHaveLength(2)
    expect(next[0]).toEqual(first)
    expect(next[1].reason).toBe('pack built')
    expect(appendLifecycleEvent(undefined, first)).toEqual([first])
  })
})

describe('readiness snapshot builder', () => {
  it('captures blocking failures and does not mutate the report', () => {
    const report: ReadinessReport = {
      checks: [
        { id: 'requirements', label: 'r', detail: '', passed: false, blocking: true },
        { id: 'deadline', label: 'd', detail: '', passed: true, blocking: true },
        { id: 'company-details', label: 'c', detail: '', passed: false, blocking: false },
      ],
      ready: false,
      passedCount: 1,
      failedCount: 2,
      blockingFailedCount: 1,
      score: 30,
      nextBestAction: null,
    }
    const captured = readinessSnapshotFromReport(report, AT)
    expect(captured).toEqual({
      ready: false,
      score: 30,
      failedCheckIds: ['requirements', 'company-details'],
      blockingCheckIds: ['requirements'],
      capturedAt: AT,
    })
    expect(report.checks).toHaveLength(3)
  })
})

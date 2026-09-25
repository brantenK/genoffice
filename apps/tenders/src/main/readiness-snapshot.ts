// The submission-readiness snapshot rules that main enforces on a commit.
//
// Split out of `main/tenders-main.ts` with no behaviour change. This is the
// product's core promise in code: a readiness receipt never lies. The store
// accepts a clear (`ready: true`) checkpoint only when canonical readiness of the
// document being committed agrees with it, so no renderer payload can persist a
// blockers-free receipt for a tender that is in fact blocked.
//
// `repairSubmissionReadinessSnapshots` REPLACES a contradicted claim with the
// canonical verdict rather than rejecting the commit: rejecting would let a
// contradicting renderer wedge the workspace. The full rationale — including the
// deliberate residual for a carried-over checkpoint — is on the function.
//
// `isRecord` lives here because it is the shape predicate every function in this
// file opens with, and because `legacy-store.ts` needs exactly this one.
import type { TenderReadinessSnapshot, TendersDataV2 } from '../shared/types'
import { assessReadiness } from '../shared/readiness'

/** A plain JSON object (not null, not an array) — the shape every guard opens with. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The checkpoints of a committed document, keyed by tender id. */
function indexReadinessSnapshots(
  document: TendersDataV2 | null,
): Map<string, TenderReadinessSnapshot> {
  const snapshots = new Map<string, TenderReadinessSnapshot>()
  for (const workspace of document?.workspaces ?? []) {
    for (const tender of workspace.tenders ?? []) {
      const snapshot = tender.submission?.readiness
      if (snapshot) snapshots.set(tender.id, snapshot)
    }
  }
  return snapshots
}

function sameReadinessSnapshot(a: TenderReadinessSnapshot, b: TenderReadinessSnapshot): boolean {
  const sameList = (left: string[], right: string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index])
  return (
    a.ready === b.ready &&
    a.score === b.score &&
    a.capturedAt === b.capturedAt &&
    sameList(a.failedCheckIds, b.failedCheckIds) &&
    sameList(a.blockingCheckIds, b.blockingCheckIds)
  )
}

/** True when any tender claims a blockers-free readiness checkpoint. */
export function claimsClearSubmissionReadiness(document: unknown): boolean {
  if (!isRecord(document) || !Array.isArray(document.workspaces)) return false
  return document.workspaces.some(
    (workspace) =>
      isRecord(workspace) &&
      Array.isArray(workspace.tenders) &&
      workspace.tenders.some(
        (tender) =>
          isRecord(tender) &&
          isRecord(tender.submission) &&
          isRecord(tender.submission.readiness) &&
          tender.submission.readiness.ready === true,
      ),
  )
}

/**
 * Recompute the readiness checkpoints this commit introduces or changes,
 * returning how many main corrected.
 *
 * A checkpoint is a renderer-authored claim about the moment a bid was
 * submitted, and the product's core promise is that its readiness receipt never
 * lies, so main lets a clear claim into the store only when it can attribute it
 * to a document canonical readiness agreed with:
 *
 *  - A checkpoint byte-identical (including `capturedAt`) to the one in the
 *    previously committed document is a CARRIED-OVER historical record: main
 *    accepted that exact value when it entered the store — every write path
 *    commits through `gateTendersCommits` — and it is not a claim about the
 *    document as it stands now, so later edits must not rewrite it.
 *  - Any other clear claim is new or changed and is accepted only when canonical
 *    readiness of the document being committed agrees with it AT THE COMMIT
 *    INSTANT, over every check. Excluding the wall-clock-dependent checks was
 *    the hole that let a renderer persist `ready: true` for a tender whose only
 *    blocker was a lapsed or absent closing date.
 *
 * A contradicted claim is REPLACED with the canonical verdict rather than
 * rejected (rejecting would let a contradicting renderer wedge the workspace),
 * and the renderer receives the corrected document, so the receipt it renders
 * matches what is on disk.
 *
 * Deliberate residual: a checkpoint already on disk that main never committed
 * (a store file written before this gate existed, or by a process outside main)
 * is trusted as a carried-over record. Corroborating a carried-over checkpoint
 * against the previous document instead was rejected: a checkpoint that was
 * truthful when recorded is contradicted by every later edit that blocks the
 * tender, so that rule would rewrite true history from the second such edit on.
 */
export function repairSubmissionReadinessSnapshots(
  incoming: TendersDataV2,
  previous: TendersDataV2 | null,
  now: Date = new Date(),
): number {
  const previousSnapshots = indexReadinessSnapshots(previous)

  let repaired = 0
  for (const workspace of incoming.workspaces ?? []) {
    for (const tender of workspace.tenders ?? []) {
      const submission = tender.submission
      const snapshot = submission?.readiness
      if (!submission || !snapshot || snapshot.ready !== true) continue
      const before = previousSnapshots.get(tender.id)
      if (before && sameReadinessSnapshot(before, snapshot)) continue

      // The gate runs on the raw payload, before the store's schema validation,
      // so a tender malformed enough to break the canonical assessment must not
      // abort the repair for the whole document (which would leave every other
      // claim unchecked too).
      const report = ((): ReturnType<typeof assessReadiness> | null => {
        try {
          return assessReadiness(tender, workspace.vault ?? [], workspace.company, now)
        } catch {
          return null
        }
      })()
      if (!report) {
        // No canonical verdict exists, so the clearance cannot be verified: it is
        // downgraded (never left as a claim of readiness) while the renderer's own
        // capture instant survives on the record.
        submission.readiness = {
          ready: false,
          score: 0,
          failedCheckIds: [...snapshot.failedCheckIds],
          blockingCheckIds: [...snapshot.blockingCheckIds],
          capturedAt: snapshot.capturedAt,
        }
        repaired += 1
        continue
      }
      if (report.ready) continue

      submission.readiness = {
        ready: false,
        score: report.score,
        failedCheckIds: report.checks.filter((check) => !check.passed).map((check) => check.id),
        blockingCheckIds: report.checks
          .filter((check) => check.blocking && !check.passed)
          .map((check) => check.id),
        capturedAt: snapshot.capturedAt,
      }
      repaired += 1
    }
  }
  return repaired
}

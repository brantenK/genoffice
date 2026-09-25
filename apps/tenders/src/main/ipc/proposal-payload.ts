// The payload preflight for the cross-app and proposal IPC handlers.
//
// Split out of `main/tenders-main.ts` with no behaviour change. These are the
// shape-and-bounds checks that run BEFORE a payload reaches a generator, a CSV
// writer or a cross-app port. They are deliberately strict and refuse unknown
// keys: a payload this app does not understand is one it cannot vouch for, and
// `draftProposalDoc` is the path that may emit "ready" language, so what it
// accepts is a correctness property rather than a nicety.
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { getTendersBaseDir } from '../tenders-paths'
import type { ProposalInput } from '../proposal-generator'
import { isRecord } from '../readiness-snapshot'
import { errorMessage } from '../main-utils'

function validOptionalString(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.length <= maxLength)
  )
}

const PROPOSAL_TOP_LEVEL_KEYS = new Set([
  'id',
  'title',
  'referenceNumber',
  'issuingBody',
  'closingDate',
  'estimatedValue',
  'pricingConfirmed',
  'requirements',
  'milestones',
  'signatureChecks',
  // Legacy renderer fields are accepted only to preserve caller compatibility; they are ignored.
  'readinessReport',
  'ready',
  'healthStatus',
])
const PROPOSAL_REQUIREMENT_KEYS = new Set([
  'id',
  'title',
  'verbatimClause',
  'isMandatory',
  'status',
  'linkedVaultDocId',
  'healthStatus',
  'ruleKey',
  'reason',
  'notApplicableReason',
  'notes',
])
const PROPOSAL_MILESTONE_KEYS = new Set(['id', 'name', 'title', 'amount', 'dueDate'])
const PROPOSAL_STATUSES = new Set(['FULFILLED', 'ACTION_REQUIRED', 'OUTSTANDING', 'NOT_APPLICABLE'])
const PROPOSAL_HEALTH_STATES = new Set([
  'VALID',
  'EXPIRED',
  'STALE_CERTIFICATION',
  'NO_EXPIRY_INFO',
  'UNKNOWN',
  'INVALID_DATE',
])

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function aggregateStringChars(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length
  if (!value || typeof value !== 'object') return 0
  if (seen.has(value)) return Number.POSITIVE_INFINITY
  seen.add(value)
  let total = 0
  if (Array.isArray(value)) {
    for (const item of value) total += aggregateStringChars(item, seen)
  } else {
    for (const child of Object.values(value)) total += aggregateStringChars(child, seen)
  }
  return total
}

export function validProposalPayload(value: unknown): value is ProposalInput {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, PROPOSAL_TOP_LEVEL_KEYS)) return false
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) return false
  } catch {
    return false
  }
  if (aggregateStringChars(value) > 64 * 1024) return false
  if (
    !validOptionalString(value.title, 500) ||
    !validOptionalString(value.referenceNumber, 500) ||
    !validOptionalString(value.issuingBody, 500) ||
    !validOptionalString(value.closingDate, 120)
  )
    return false
  if (
    value.estimatedValue !== undefined &&
    (typeof value.estimatedValue !== 'number' ||
      !Number.isFinite(value.estimatedValue) ||
      value.estimatedValue < 0)
  )
    return false
  if (value.pricingConfirmed !== undefined && typeof value.pricingConfirmed !== 'boolean')
    return false
  if (value.id !== undefined && !validOptionalString(value.id, 200)) return false
  if (value.ready !== undefined && typeof value.ready !== 'boolean') return false
  if (!validOptionalString(value.healthStatus, 64)) return false
  if (value.readinessReport !== undefined && !isRecord(value.readinessReport)) return false

  if (value.requirements !== undefined) {
    if (!Array.isArray(value.requirements) || value.requirements.length > 500) return false
    for (const raw of value.requirements) {
      if (!isRecord(raw)) return false
      if (!hasOnlyKeys(raw, PROPOSAL_REQUIREMENT_KEYS)) return false
      const hasTitle =
        typeof raw.title === 'string' && raw.title.trim().length > 0 && raw.title.length <= 500
      const hasClause =
        typeof raw.verbatimClause === 'string' &&
        raw.verbatimClause.trim().length > 0 &&
        raw.verbatimClause.length <= 2000
      if (!hasTitle && !hasClause) return false
      if (
        !validOptionalString(raw.id, 200) ||
        !validOptionalString(raw.status, 64) ||
        !validOptionalString(raw.linkedVaultDocId, 500) ||
        !validOptionalString(raw.healthStatus, 64) ||
        !validOptionalString(raw.ruleKey, 100) ||
        !validOptionalString(raw.reason, 2000) ||
        !validOptionalString(raw.notApplicableReason, 2000) ||
        !validOptionalString(raw.notes, 2000)
      )
        return false
      if (raw.isMandatory !== undefined && typeof raw.isMandatory !== 'boolean') return false
      if (
        raw.status !== undefined &&
        (typeof raw.status !== 'string' || !PROPOSAL_STATUSES.has(raw.status))
      )
        return false
      if (
        raw.healthStatus !== undefined &&
        (typeof raw.healthStatus !== 'string' || !PROPOSAL_HEALTH_STATES.has(raw.healthStatus))
      )
        return false
    }
  }

  if (value.milestones !== undefined) {
    if (!Array.isArray(value.milestones) || value.milestones.length > 500) return false
    for (const raw of value.milestones) {
      if (!isRecord(raw)) return false
      if (!hasOnlyKeys(raw, PROPOSAL_MILESTONE_KEYS)) return false
      const hasName =
        typeof raw.name === 'string' && raw.name.trim().length > 0 && raw.name.length <= 500
      const hasTitle =
        typeof raw.title === 'string' && raw.title.trim().length > 0 && raw.title.length <= 500
      if (!hasName && !hasTitle) return false
      if (
        raw.amount !== undefined &&
        (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0)
      )
        return false
      if (!validOptionalString(raw.dueDate, 120)) return false
    }
  }

  if (value.signatureChecks !== undefined) {
    if (!isRecord(value.signatureChecks) || Object.keys(value.signatureChecks).length > 50)
      return false
    if (Object.keys(value.signatureChecks).some((key) => key.length > 100)) return false
    if (Object.values(value.signatureChecks).some((checked) => typeof checked !== 'boolean'))
      return false
  }
  return true
}

export function writeGeneratedProposal(content: string): string {
  const outputDir = join(getTendersBaseDir(), 'generated')
  mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const outputPath = join(outputDir, `${randomUUID()}.md`)
  writeFileSync(outputPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return outputPath
}

// Canonical tender readiness rules shared by the renderer and main process.
// This module deliberately has no renderer or Electron dependencies.
import type {
  CompanyProfile,
  DocHealth,
  IntakeVerification,
  PageExtractionState,
  RequirementRecord,
  ReviewFieldKey,
  TenderRecord,
  VaultDoc,
} from './types'
import { INTAKE_CRITICAL_REVIEW_FIELDS } from './types'
import { RULE_BY_KEY, TENDER_RULES } from './rules'

/** Signature semantics are owned by the catalogue, not a second readiness list. */
export const SIGNATURE_RULE_KEYS = TENDER_RULES.filter(
  (rule) => rule.evidenceKind === 'SIGNATURE',
).map((rule) => rule.key)

export interface ReadinessCheck {
  id: string
  label: string
  detail: string
  passed: boolean
  blocking: boolean
}

/**
 * Identity of the canonical inputs a `ReadinessReport` was produced from. The
 * proposal path verifies this before emitting ready language so a report can
 * never be applied to the wrong or a stale tender.
 */
export interface ReadinessBinding {
  tenderId: string
  /** Authoritative document revision at generation time. */
  revision: number
  /** Deterministic fingerprint of the tender + company + vault inputs. */
  fingerprint: string
  generatedAt: string
}

export interface ReadinessReport {
  checks: ReadinessCheck[]
  ready: boolean
  passedCount: number
  failedCount: number
  blockingFailedCount: number
  score: number
  nextBestAction: { label: string; detail: string } | null
  /** Present only on main-owned canonical reports. */
  binding?: ReadinessBinding
}

/** Deterministic, key-sorted JSON projection used by the fingerprint. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    )
  }
  return value
}

function fnv1a64Hex(text: string): string {
  let hash = 14695981039346656037n
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * Fingerprint the canonical readiness inputs. Deterministic across processes
 * and independent of key insertion order; the vault is sorted by id so a
 * reordered vault does not change the fingerprint.
 */
export function readinessFingerprint(input: {
  tender: unknown
  company: unknown
  vault: unknown
}): string {
  const vault = Array.isArray(input.vault)
    ? [...input.vault].sort((a, b) =>
        String((a as { id?: unknown })?.id ?? '').localeCompare(
          String((b as { id?: unknown })?.id ?? ''),
        ),
      )
    : input.vault
  return fnv1a64Hex(
    JSON.stringify(canonicalize({ tender: input.tender, company: input.company, vault })),
  )
}

/** Return a copy of the report carrying its canonical binding. */
export function bindReadinessReport(
  report: ReadinessReport,
  binding: ReadinessBinding,
): ReadinessReport {
  return { ...report, binding }
}

/**
 * Does the report's binding match every expectation that was supplied? An
 * unbound report matches only when no binding is required.
 */
export function readinessBindingMatches(
  report: ReadinessReport | undefined,
  expected?: Partial<ReadinessBinding> & { required?: boolean },
): boolean {
  if (!report) return false
  const binding = report.binding
  if (!binding) return expected?.required !== true
  if (expected?.tenderId !== undefined && binding.tenderId !== expected.tenderId) return false
  if (expected?.revision !== undefined && binding.revision !== expected.revision) return false
  if (expected?.fingerprint !== undefined && binding.fingerprint !== expected.fingerprint)
    return false
  return true
}

const CHECK_WEIGHTS: Record<string, number> = {
  requirements: 30,
  'docs-at-closing': 25,
  deadline: 20,
  signatures: 15,
  'company-details': 10,
  // Intake-verification gates block readiness but are not scored dimensions:
  // when no verification state exists they are not added at all, and when they
  // are present a weight of zero keeps every previously-published score stable.
  'intake-review': 0,
  'page-extraction': 0,
}

const REVIEW_FIELD_LABEL: Record<ReviewFieldKey, string> = {
  title: 'title',
  referenceNumber: 'reference number',
  issuingBody: 'issuing body',
  contactEmail: 'contact e-mail',
  closingDate: 'closing date & time',
  submissionMethod: 'submission method',
  submissionDestination: 'submission destination',
  estimatedValue: 'value',
}

/**
 * Readiness-critical fields whose review state is still `unconfirmed` (or
 * missing entirely). An explicit `not_stated` / `confirmed` / `corrected`
 * decision — including choosing among competing candidates — resolves it.
 */
export function unconfirmedCriticalFields(intake: IntakeVerification): ReviewFieldKey[] {
  return INTAKE_CRITICAL_REVIEW_FIELDS.filter((field) => {
    const review = intake.fields?.[field]
    return !review || review.state === 'unconfirmed'
  })
}

/**
 * Pages that are neither natively extracted nor manually reviewed. OCR-required,
 * OCR-failed and OCR-unavailable pages block readiness until reviewed.
 */
export function unreviewedOcrPages(intake: IntakeVerification): PageExtractionState[] {
  return (intake.pages ?? []).filter(
    (page) => page.state !== 'native' && page.state !== 'manually-reviewed',
  )
}

/**
 * Authoritative count of unreadable pages that review state does NOT prove were
 * handled. `TenderRecord.ocrPages` is the on-disk fact recorded by the parser
 * (and preserved verbatim through v1→v2 migration); a review can only clear it
 * by proving each unreadable page individually. A missing review — or one whose
 * `pages` were never captured — proves nothing, so it must fail closed.
 *
 * Decided from authoritative data only:
 *  - pages still flagged `ocr-required` / `ocr-unavailable` / `ocr-failed`
 *    always count;
 *  - a `manually-reviewed` page (or a natively re-extracted page whose method is
 *    `ocr`) proves one unreadable page resolved;
 *  - any remaining `ocrPages` not covered by that proof counts.
 *
 * `ocrPages === 0` (or undefined) with no page state returns 0, so the no-OCR
 * path is byte-identical to its previous readiness.
 */
export function unprovenOcrPageCount(
  tender: Pick<TenderRecord, 'ocrPages' | 'intakeVerification'>,
): number {
  const pages = tender.intakeVerification?.pages ?? []
  const unresolved = pages.filter(
    (page) => page.state !== 'native' && page.state !== 'manually-reviewed',
  ).length
  const resolvedUnreadable = pages.filter(
    (page) =>
      page.state === 'manually-reviewed' || (page.state === 'native' && page.method === 'ocr'),
  ).length
  const required = Math.max(0, tender.ocrPages ?? 0)
  return Math.max(unresolved, required - resolvedUnreadable)
}

const DAY_MS = 86_400_000
export const POLICE_STAMP_WINDOW_DAYS = 90
export type ReadinessDocHealth = DocHealth | 'UNKNOWN' | 'INVALID_DATE'

export interface DocHealthReport {
  health: ReadinessDocHealth
  daysUntilExpiry: number | null
  daysSinceCertified: number | null
  stampDaysLeft: number | null
}

export interface DocAtClosing {
  doc: VaultDoc
  healthAtClosing: DocHealthReport
  willFail: boolean
  requirementTitles: string[]
}

export interface DetailMismatch {
  field: string
  tenderExpects: string | null
  companyHas: string | null
}

export interface MissingLinkedEvidence {
  requirementTitle: string
  linkedVaultDocId: string | null
}

/** Date difference in whole days, retaining the renderer's existing semantics. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS)
}

/**
 * Human "3d 4h" / "4h 15m" / "12m" delta. Shared so the readiness deadline
 * detail and the countdown badge can never describe the same instant
 * differently.
 */
export function formatDeadlineDelta(ms: number): string {
  const abs = Math.abs(ms)
  const mins = Math.floor(abs / 60_000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

interface CivilDate {
  year: number
  month: number
  day: number
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function validCivilDate(year: number, month: number, day: number): CivilDate | null {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

function parseIsoCivilDate(raw: string): CivilDate | null {
  const match = raw.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)$)/,
  )
  return match
    ? validCivilDate(parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10))
    : null
}

/**
 * The UTC-midnight instant of a civil date-only vault value (`YYYY-MM-DD`), or
 * `null` when it is not a real date. Day maths over civil vault dates must use
 * this — never raw `new Date(value)`, which yields an Invalid Date (and a NaN
 * day count) for a typo like `2026-99-99`.
 */
export function parseCivilDay(raw: string | null | undefined): Date | null {
  const civil = raw ? parseIsoCivilDate(raw.trim()) : null
  return civil ? new Date(Date.UTC(civil.year, civil.month - 1, civil.day)) : null
}

/**
 * Civil closing values in a South African RFP are wall-clock times in South
 * Africa: "30 November 2026 at 11:00" means 11:00 SAST, i.e. 09:00Z. Anchoring
 * them to this fixed offset — never to the machine's zone and never to UTC — is
 * what keeps the readiness gate, the countdown badge, the renewal runway, the
 * `.ics` export and the proposal on one and the same instant, and keeps a bidder
 * from believing they have until 11:00 when the deadline actually passed at
 * 09:00Z.
 */
const SAST_OFFSET_MS = 2 * 3_600_000

/** The SAST instant of a civil date + wall-clock time. */
function civilInstant(civil: CivilDate, hours: number, minutes: number): Date {
  return new Date(Date.UTC(civil.year, civil.month - 1, civil.day, hours, minutes) - SAST_OFFSET_MS)
}

function civilDateFromDate(date: Date): CivilDate | null {
  if (isNaN(date.getTime())) return null
  // "Today" is the South African civil day: vault dates are SA civil dates, so
  // the day count must not shift with the machine's timezone.
  const southAfrican = new Date(date.getTime() + SAST_OFFSET_MS)
  return validCivilDate(
    southAfrican.getUTCFullYear(),
    southAfrican.getUTCMonth() + 1,
    southAfrican.getUTCDate(),
  )
}

function civilDayNumber(date: CivilDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / DAY_MS
}

function civilDaysBetween(a: CivilDate, b: CivilDate): number {
  return civilDayNumber(a) - civilDayNumber(b)
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
}

/** A capitalised month name in trailing text may be a competing deadline. */
const CAPITALISED_MONTH_RE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/

/** A spelled-out clock time is time information, not noise ("… at noon"). */
const WORD_TIME_RE = /\b(?:noon|midday|midnight)\b/i

/**
 * Can a trailing fragment after the date/time be ignored as noise?
 *
 * Only when it carries no date/time information at all: any digit could be a
 * clock time, a year or a numeric date ("… at 11:00", "… extended to 15
 * December 2026"), a spelled-out clock word states a time the parser does not
 * represent ("… at noon"), and a named month could be a competing deadline.
 * Those are ambiguous, so the whole string is rejected rather than silently
 * swallowing the date that decides whether the bid is closed.
 */
function tailIsIgnorable(tail: string): boolean {
  if (/\d/.test(tail)) return false
  if (WORD_TIME_RE.test(tail)) return false
  return !CAPITALISED_MONTH_RE.test(tail)
}

/**
 * Consume an optional leading clock time from trailing text.
 *
 * `null` = no clock time here, `'invalid'` = time-like but impossible
 * ("24h00", "14:60", "25:30"), which must reject the whole string rather than
 * fall back to end of day.
 */
function consumeLeadingTime(
  text: string,
): { hours: number; minutes: number; rest: string } | 'invalid' | null {
  if (!/^(?:at\s+)?\d{1,2}\s*[:.h]\s*\d{1,2}/i.test(text)) return null
  const match = text.match(
    /^(?:at\s+)?(\d{1,2})\s*[:.h]\s*(\d{1,2})(?::\d{2}(?:\.\d+)?)?\s*(am|pm)?/i,
  )
  if (!match) return 'invalid'
  let hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  const meridian = match[3]?.toLowerCase()
  if (minutes > 59 || (meridian ? hours < 1 || hours > 12 : hours > 23)) return 'invalid'
  if (meridian === 'pm' && hours < 12) hours += 12
  if (meridian === 'am' && hours === 12) hours = 0
  return { hours, minutes, rest: text.slice(match[0].length).trim() }
}

/**
 * Time of day for a closing date whose trailing text is pure noise. A missing
 * time means end of day (23:59) — the latest civil instant the stated date can
 * still mean — and `null` means the tail was ambiguous, so the caller rejects.
 */
function resolveClosingTail(tail: string): { hours: number; minutes: number } | null {
  const parentheticals = [...tail.matchAll(/\(([^)]*)\)/g)].map((match) => match[1])
  const outside = tail
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const time = consumeLeadingTime(outside)
  if (time === 'invalid') return null
  if (parentheticals.some((content) => !tailIsIgnorable(content))) return null
  if (!time) return tailIsIgnorable(outside) ? { hours: 23, minutes: 59 } : null
  return tailIsIgnorable(time.rest) ? { hours: time.hours, minutes: time.minutes } : null
}

/**
 * THE closing-date parser — the single gate shared by readiness, the countdown
 * badge, the renewal runway, gap analysis, the shredder and the v2 schema.
 *
 * Semantics:
 *  - A full RFC 3339 timestamp with an explicit offset is the exact instant.
 *  - Every other supported form is a South African civil date/time and is
 *    anchored to SAST (+02:00): "30 November 2026 at 11:00" → the 09:00Z instant
 *    at which an 11:00 SAST deadline actually passes. A fixed offset — rather
 *    than UTC or the machine's zone — is what keeps every consumer (the gate,
 *    the countdown badge, the runway, the `.ics` export, the proposal) on the
 *    same instant and reading the same wall clock the RFP states.
 *  - A missing time means end of day (23:59 SAST) — the latest civil instant the
 *    stated date can still mean.
 *  - Supported civil forms: ISO civil `YYYY-MM-DD`, day-first named month
 *    (incl. `11h00` and ordinal suffixes), month-first named month, and
 *    day-first slash dates — each optionally followed by a clock time.
 *  - Trailing noise (a parenthetical note, a timezone abbreviation, free text
 *    without digits) is tolerated so realistic RFP lines import. Trailing text
 *    that carries any date/time information — a clock time, a year, a numeric
 *    date, a named month — is ambiguous and rejects the whole string, so a
 *    competing or amended deadline can never be swallowed into a wrong date.
 *  - Impossible, ambiguous or timezone-less values return null.
 */
export function parseClosingDate(raw: string | null | undefined): Date | null {
  if (!raw) return null
  const s = raw.trim()
  if (s.length < 4 || s.length > 120) return null
  const clean = s.replace(/\s{2,}/g, ' ').trim()

  const rfc3339 = clean.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  )
  if (rfc3339) {
    const year = parseInt(rfc3339[1], 10)
    const month = parseInt(rfc3339[2], 10)
    const day = parseInt(rfc3339[3], 10)
    const hours = parseInt(rfc3339[4], 10)
    const minutes = parseInt(rfc3339[5], 10)
    const seconds = parseInt(rfc3339[6], 10)
    const offset = rfc3339[7]
    const offsetValid =
      offset === 'Z' ||
      (parseInt(offset.slice(1, 3), 10) <= 23 && parseInt(offset.slice(4, 6), 10) <= 59)
    if (
      !validCivilDate(year, month, day) ||
      hours > 23 ||
      minutes > 59 ||
      seconds > 59 ||
      !offsetValid
    )
      return null
    const parsed = new Date(clean)
    return isNaN(parsed.getTime()) ? null : parsed
  }

  let match = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(.*))?$/)
  if (match) {
    const civil = validCivilDate(
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      parseInt(match[3], 10),
    )
    const time = resolveClosingTail(match[4] ?? '')
    return civil && time ? civilInstant(civil, time.hours, time.minutes) : null
  }

  match = clean.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})(?:\s+(.*))?$/)
  if (match && MONTHS[match[2].toLowerCase()] !== undefined) {
    const civil = validCivilDate(
      parseInt(match[3], 10),
      MONTHS[match[2].toLowerCase()] + 1,
      parseInt(match[1], 10),
    )
    const time = resolveClosingTail(match[4] ?? '')
    return civil && time ? civilInstant(civil, time.hours, time.minutes) : null
  }

  match = clean.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})(?:\s+(.*))?$/)
  if (match && MONTHS[match[1].toLowerCase()] !== undefined) {
    const civil = validCivilDate(
      parseInt(match[3], 10),
      MONTHS[match[1].toLowerCase()] + 1,
      parseInt(match[2], 10),
    )
    const time = resolveClosingTail(match[4] ?? '')
    return civil && time ? civilInstant(civil, time.hours, time.minutes) : null
  }

  match = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(.*))?$/)
  if (match) {
    const year = parseInt(match[3].length === 2 ? `20${match[3]}` : match[3], 10)
    const civil = validCivilDate(year, parseInt(match[2], 10), parseInt(match[1], 10))
    const time = resolveClosingTail(match[4] ?? '')
    return civil && time ? civilInstant(civil, time.hours, time.minutes) : null
  }
  return null
}

export function assessDocHealth(
  doc: VaultDoc,
  now: Date = new Date(),
  validityKind?: 'EXPIRY_REQUIRED' | 'CERTIFICATION_WINDOW' | 'PERMANENT' | 'NONE',
): DocHealthReport {
  const issueDate = doc.issueDate ? parseIsoCivilDate(doc.issueDate) : null
  const expiryDate = doc.expiryDate ? parseIsoCivilDate(doc.expiryDate) : null
  const certifiedDate = doc.certifiedDate ? parseIsoCivilDate(doc.certifiedDate) : null
  const hasInvalidDate =
    (doc.issueDate !== null && issueDate === null) ||
    (doc.expiryDate !== null && expiryDate === null) ||
    (doc.certifiedDate !== null && certifiedDate === null)
  const nowCivil = civilDateFromDate(now)
  const daysUntilExpiry = expiryDate && nowCivil ? civilDaysBetween(expiryDate, nowCivil) : null
  const daysSinceCertified =
    certifiedDate && nowCivil ? civilDaysBetween(nowCivil, certifiedDate) : null
  const stampDaysLeft =
    doc.isCertified && daysSinceCertified !== null
      ? POLICE_STAMP_WINDOW_DAYS - daysSinceCertified
      : null

  if (hasInvalidDate) {
    return { health: 'INVALID_DATE', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  if (validityKind === 'EXPIRY_REQUIRED' && daysUntilExpiry === null) {
    return { health: 'UNKNOWN', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  if (
    validityKind === 'CERTIFICATION_WINDOW' &&
    (!doc.isCertified || daysSinceCertified === null || daysSinceCertified < 0)
  ) {
    return { health: 'UNKNOWN', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  if (validityKind === 'PERMANENT') {
    return { health: 'VALID', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  if (validityKind === 'NONE') {
    return { health: 'VALID', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  if (daysUntilExpiry !== null && daysUntilExpiry < 0) {
    return { health: 'EXPIRED', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  if (stampDaysLeft !== null && stampDaysLeft < 0) {
    return { health: 'STALE_CERTIFICATION', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  if (daysUntilExpiry === null && daysSinceCertified === null) {
    return { health: 'NO_EXPIRY_INFO', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
  }
  return { health: 'VALID', daysUntilExpiry, daysSinceCertified, stampDaysLeft }
}

/** A requirement is resolved only when N/A has an audit reason. */
export function isRequirementResolved(
  requirement: Pick<RequirementRecord, 'status' | 'reason' | 'notApplicableReason'>,
): boolean {
  const reason = requirement.notApplicableReason
  return (
    requirement.status === 'FULFILLED' ||
    (requirement.status === 'NOT_APPLICABLE' &&
      typeof reason === 'string' &&
      Boolean(reason.trim()))
  )
}

/** Shared status semantics used by readiness and proposal generation. */
export function assessRequirementStatuses(
  requirements: Array<
    | Pick<
        RequirementRecord,
        | 'title'
        | 'status'
        | 'isMandatory'
        | 'reason'
        | 'notApplicableReason'
        | 'linkedVaultDocId'
        | 'id'
      >
    | Record<string, any>
  >,
  mandatoryOnly = true,
): {
  unresolved: typeof requirements
  blockers: typeof requirements
  outstanding: number
  actionRequired: number
  fulfilled: number
} {
  const considered = mandatoryOnly
    ? requirements.filter((requirement) => requirement.isMandatory !== false)
    : requirements
  const blockers = considered.filter((requirement) => !isRequirementResolved(requirement as any))
  return {
    unresolved: blockers,
    blockers,
    outstanding: blockers.filter((requirement) => requirement.status === 'OUTSTANDING').length,
    actionRequired: blockers.filter((requirement) => requirement.status === 'ACTION_REQUIRED')
      .length,
    fulfilled: requirements.filter((requirement) => requirement.status === 'FULFILLED').length,
  }
}

export function requiresDocumentEvidence(ruleKey: string): boolean {
  return RULE_BY_KEY[ruleKey]?.evidenceKind === 'DOCUMENT'
}

export function checkCompanyDetails(
  tender: TenderRecord,
  company: CompanyProfile,
): DetailMismatch[] {
  const applicableRequirements = tender.requirements.filter(
    (requirement) => requirement.isMandatory !== false && requirement.status !== 'NOT_APPLICABLE',
  )
  const wants = (keyword: RegExp): boolean =>
    applicableRequirements.some((r) => keyword.test(r.title) || keyword.test(r.verbatimClause))

  const mismatches: DetailMismatch[] = []
  if (wants(/(registration|cipc|incorporat)/i) && !company.registrationNumber) {
    mismatches.push({
      field: 'Registration number',
      tenderExpects: 'CIPC registration number',
      companyHas: company.registrationNumber,
    })
  }
  if (wants(/(tax\s*pin|sars)/i) && !company.taxPin) {
    mismatches.push({
      field: 'Tax PIN',
      tenderExpects: 'SARS tax pin / TCS',
      companyHas: company.taxPin,
    })
  }
  if (wants(/(vat)/i) && !company.vatNumber) {
    mismatches.push({
      field: 'VAT number',
      tenderExpects: 'VAT registration number',
      companyHas: company.vatNumber,
    })
  }
  if (wants(/(bbbee|b-bbee|b-bbbee|broad[- ]based)/i) && !company.bbbeeLevel) {
    mismatches.push({
      field: 'B-BBEE level',
      tenderExpects: 'B-BBEE certificate / level',
      companyHas: company.bbbeeLevel,
    })
  }
  if (wants(/(csd|central supplier)/i) && !company.csdSupplierNumber) {
    mismatches.push({
      field: 'CSD supplier number',
      tenderExpects: 'CSD registration',
      companyHas: company.csdSupplierNumber,
    })
  }
  return mismatches
}

export function signatureRuleKeys(tender: TenderRecord): string[] {
  return tender.requirements
    .filter(
      (requirement) =>
        !(requirement.status === 'NOT_APPLICABLE' && isRequirementResolved(requirement)),
    )
    .map((r) => r.ruleKey)
    .filter((key) => SIGNATURE_RULE_KEYS.includes(key))
}

export function docsAtClosing(tender: TenderRecord, vault: VaultDoc[]): DocAtClosing[] {
  const closing = parseClosingDate(tender.closingDate) ?? new Date(Date.now() + 90 * DAY_MS)
  const byDoc = new Map<string, DocAtClosing>()
  for (const requirement of tender.requirements) {
    if (requirement.status === 'NOT_APPLICABLE' && isRequirementResolved(requirement)) continue
    const docId = requirement.linkedVaultDocId
    if (!docId) continue
    const doc = vault.find((candidate) => candidate.id === docId)
    if (!doc || typeof doc.fileUrl !== 'string' || !doc.fileUrl.trim()) continue
    const rule = RULE_BY_KEY[requirement.ruleKey]
    const healthAtClosing = assessDocHealth(doc, closing, rule?.validityKind)
    const entry = byDoc.get(docId)
    if (entry) {
      entry.requirementTitles.push(requirement.title)
      const currentRank = healthRank(entry.healthAtClosing.health)
      const nextRank = healthRank(healthAtClosing.health)
      if (nextRank > currentRank) entry.healthAtClosing = healthAtClosing
      entry.willFail = entry.willFail || healthWillFail(healthAtClosing.health)
    } else {
      byDoc.set(docId, {
        doc,
        healthAtClosing,
        willFail: healthWillFail(healthAtClosing.health),
        requirementTitles: [requirement.title],
      })
    }
  }
  return [...byDoc.values()]
}

/**
 * Health states that fail the "valid on the closing date" check. Exported so
 * gap analysis escalates to the same verdict instead of keeping its own list.
 */
export function healthWillFail(health: ReadinessDocHealth): boolean {
  return ['EXPIRED', 'STALE_CERTIFICATION', 'UNKNOWN', 'INVALID_DATE'].includes(health)
}

function healthRank(health: ReadinessDocHealth): number {
  return {
    VALID: 1,
    NO_EXPIRY_INFO: 2,
    UNKNOWN: 3,
    EXPIRED: 4,
    STALE_CERTIFICATION: 4,
    INVALID_DATE: 5,
  }[health]
}

export function missingLinkedEvidence(
  tender: TenderRecord,
  vault: VaultDoc[],
): MissingLinkedEvidence[] {
  return tender.requirements
    .filter(
      (requirement) =>
        requirement.isMandatory !== false &&
        requirement.status !== 'NOT_APPLICABLE' &&
        requiresDocumentEvidence(requirement.ruleKey) &&
        (!requirement.linkedVaultDocId ||
          (() => {
            const doc = vault.find((candidate) => candidate.id === requirement.linkedVaultDocId)
            return !doc || typeof doc.fileUrl !== 'string' || !doc.fileUrl.trim()
          })()),
    )
    .map((requirement) => ({
      requirementTitle: requirement.title,
      linkedVaultDocId: requirement.linkedVaultDocId!,
    }))
}

export function assessReadiness(
  tender: TenderRecord,
  vault: VaultDoc[],
  company: CompanyProfile,
  now: Date = new Date(),
): ReadinessReport {
  const checks: ReadinessCheck[] = []
  const reqs = tender.requirements
  const requirementStatus = assessRequirementStatuses(reqs, false)
  const unresolved = requirementStatus.unresolved
  checks.push({
    id: 'requirements',
    label: `All ${reqs.length} requirements fulfilled or marked N/A with a reason`,
    detail:
      reqs.length === 0
        ? 'The compliance matrix is empty and has not been audited.'
        : unresolved.length === 0
          ? 'Every requirement in the compliance matrix is resolved.'
          : `${unresolved.length} requirement(s) still outstanding or action-required: ${unresolved
              .slice(0, 3)
              .map((r) => r.title)
              .join(', ')}${unresolved.length > 3 ? '…' : ''}`,
    passed: reqs.length > 0 && unresolved.length === 0,
    blocking: true,
  })

  const docs = docsAtClosing(tender, vault)
  const missingEvidence = missingLinkedEvidence(tender, vault)
  const failing = docs.filter((doc) => doc.willFail)
  const docProblems = failing.length + missingEvidence.length
  checks.push({
    id: 'docs-at-closing',
    label: 'Linked documents valid on the closing date',
    detail:
      docProblems === 0
        ? docs.length === 0
          ? 'No documents linked yet.'
          : `All ${docs.length} linked document(s) remain valid through closing.`
        : [
            ...missingEvidence.map(
              (item) =>
                `${item.requirementTitle} — ${item.linkedVaultDocId ? `linked vault document ${item.linkedVaultDocId} is missing` : 'no linked vault document is supplied'}`,
            ),
            ...failing.map(
              (item) =>
                `${item.doc.title} — ${item.healthAtClosing.health === 'EXPIRED' ? `expires ${Math.abs(item.healthAtClosing.daysUntilExpiry ?? 0)} days before closing` : item.healthAtClosing.health === 'INVALID_DATE' || item.healthAtClosing.health === 'UNKNOWN' ? 'date information is invalid or unknown' : 'police stamp will exceed the 90-day window before closing'}`,
            ),
          ].join('; '),
    passed: docProblems === 0,
    blocking: true,
  })

  const sigKeys = signatureRuleKeys(tender)
  const sigMissing = sigKeys.filter((key) => !tender.signatureChecks[key])
  checks.push({
    id: 'signatures',
    label: 'Signature checklist completed',
    detail:
      sigKeys.length === 0
        ? 'No signature-dependent returnables detected.'
        : sigMissing.length === 0
          ? `All ${sigKeys.length} signature item(s) confirmed.`
          : `Not yet confirmed: ${sigMissing.map(labelForRule).join(', ')}`,
    passed: sigMissing.length === 0,
    blocking: true,
  })

  const mismatches = checkCompanyDetails(tender, company)
  checks.push({
    id: 'company-details',
    label: 'Company details on file match the returnables',
    detail:
      mismatches.length === 0
        ? 'Registration, tax, VAT, B-BBEE and CSD details are on file.'
        : mismatches
            .map((mismatch) => `${mismatch.field} missing on the company profile`)
            .join('; '),
    passed: mismatches.length === 0,
    blocking: mismatches.length > 0,
  })

  const closing = parseClosingDate(tender.closingDate)
  // The gate compares INSTANTS, not rounded days: a bid is not closed until the
  // closing instant has actually passed, so the closing day itself stays open
  // until its closing time. This is the same comparison the countdown badge
  // (`deadlineStatus`) and the proposal generator use, so the three can never
  // disagree about whether a tender is still open.
  const closingOpen = closing !== null && now.getTime() < closing.getTime()
  const closingDelta = closing === null ? 0 : closing.getTime() - now.getTime()
  checks.push({
    id: 'deadline',
    label: 'Closing date known and still in the future',
    detail:
      closing === null
        ? 'No closing date was lifted from the RFP — confirm the deadline manually.'
        : closingOpen
          ? `Closes in ${formatDeadlineDelta(closingDelta)}.`
          : `This tender closed ${formatDeadlineDelta(closingDelta)} ago.`,
    passed: closingOpen,
    blocking: true,
  })

  // Intake field-review gate (Phase 3). Additive: this only applies once a
  // tender carries authoritative intake-verification state, so documents and
  // callers that never recorded it keep their previous readiness exactly.
  const intake = tender.intakeVerification
  if (intake) {
    const unconfirmed = unconfirmedCriticalFields(intake)
    const competing = unconfirmed.filter(
      (field) => (intake.fields?.[field]?.candidates?.length ?? 0) > 1,
    )
    checks.push({
      id: 'intake-review',
      label: 'Every readiness-critical field has been explicitly confirmed',
      detail:
        unconfirmed.length === 0
          ? 'Every readiness-critical field was confirmed, corrected or marked not stated.'
          : `${unconfirmed.length} readiness-critical field(s) are still unconfirmed: ${unconfirmed
              .map((field) => REVIEW_FIELD_LABEL[field])
              .join(
                ', ',
              )}.${competing.length > 0 ? ` Competing candidates remain for ${competing.map((field) => REVIEW_FIELD_LABEL[field]).join(', ')}.` : ''}`,
      passed: unconfirmed.length === 0,
      blocking: true,
    })
  }

  // Page-extraction gate: FAIL-CLOSED on authoritative unreadable pages. This
  // runs even when there is NO intake-verification state at all (e.g. a v1→v2
  // migrated tender): `TenderRecord.ocrPages` alone proves unreadable pages
  // exist, and an absent/empty review proves nothing about them, so readiness
  // must not clear. With `ocrPages === 0` and no page issues this is not added
  // at all, keeping the no-OCR path byte-identical.
  const unprovenPages = unprovenOcrPageCount(tender)
  if (intake || unprovenPages > 0) {
    const blockedPages = intake ? unreviewedOcrPages(intake) : []
    const listed = blockedPages.map((page) => `p.${page.pageNumber} (${page.state})`).join(', ')
    checks.push({
      id: 'page-extraction',
      label: 'Every scanned page is OCR-extracted or manually reviewed',
      detail:
        unprovenPages === 0
          ? 'All pages have native text or were manually reviewed.'
          : blockedPages.length > 0 && unprovenPages <= blockedPages.length
            ? `${blockedPages.length} page(s) are not readable without review: ${listed}.`
            : `${unprovenPages} unreadable page(s) are not covered by review.${listed ? ` Flagged: ${listed}.` : ''}`,
      passed: unprovenPages === 0,
      blocking: true,
    })
  }

  const progress: Record<string, number> = {
    requirements: reqs.length === 0 ? 0 : (reqs.length - unresolved.length) / reqs.length,
    'docs-at-closing':
      docs.length + missingEvidence.length === 0
        ? 0.6
        : 1 - docProblems / (docs.length + missingEvidence.length),
    signatures: sigKeys.length === 0 ? 1 : (sigKeys.length - sigMissing.length) / sigKeys.length,
    'company-details': Math.max(0, 1 - mismatches.length / 5),
    deadline: closing === null ? 0.5 : closingOpen ? 1 : 0,
  }
  let score = 0
  let biggestLoss = { check: null as ReadinessCheck | null, lost: 0 }
  for (const check of checks) {
    const weight = CHECK_WEIGHTS[check.id] ?? 10
    const point = Math.max(0, Math.min(progress[check.id] ?? (check.passed ? 1 : 0), 1))
    score += weight * point
    const lost = weight * (1 - point)
    if (lost > biggestLoss.lost) biggestLoss = { check, lost }
  }
  score = Math.round(score)

  const blockingFailed = checks.filter((check) => check.blocking && !check.passed)
  return {
    checks,
    ready: blockingFailed.length === 0,
    passedCount: checks.filter((check) => check.passed).length,
    failedCount: checks.filter((check) => !check.passed).length,
    blockingFailedCount: blockingFailed.length,
    score,
    nextBestAction: biggestLoss.check
      ? { label: biggestLoss.check.label, detail: biggestLoss.check.detail }
      : null,
  }
}

export function labelForRule(ruleKey: string): string {
  const map: Record<string, string> = {
    sbd_forms: 'SBD forms signed',
    signed_initialled: 'each page signed/initialled',
    declaration: 'declaration signed',
    original_docs: 'certified originals included',
  }
  return map[ruleKey] ?? ruleKey
}

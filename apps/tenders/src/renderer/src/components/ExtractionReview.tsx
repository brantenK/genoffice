// WP-6 — Extraction review / correction step.
//
// After a tender is shredded the user lands here before anything is treated as
// settled. The step is deliberately NOT a hidden modal: the workspace shows a
// persistent "Extraction review" banner with the number of fields still to
// confirm, and this panel is a first-class view of the left pane with the source
// PDF still visible on the right so every value can be checked against its page.
//
// What the panel does:
//  - edits/confirms title, reference, issuing body, contact e-mail, closing
//    date/time, submission method + destination, and value;
//  - shows the review confidence and the source page/clause for every field;
//  - surfaces competing candidates (never silently picks one) and keeps the
//    originally extracted value after a correction;
//  - marks a field "not stated" (which clears the domain value, so an
//    unreviewed guess can never quietly satisfy readiness);
//  - lets the user add/edit/remove/reclassify requirements without re-importing.
//
// Data flow: domain edits go through the authoritative store
// (`updateTender` / `updateRequirement` / `addRequirement` / `removeRequirement`),
// so only schema-valid values reach disk. Review annotations (provenance,
// candidates, decisions) live in the review slice of the renderer store.
import { useEffect, useId, useMemo, useState } from 'react'
import {
  AlertTriangle,
  BadgeCheck,
  Banknote,
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  EyeOff,
  FileStack,
  FileText,
  Hash,
  Mail,
  MapPin,
  RotateCcw,
  ScanLine,
  Send,
  Trash2,
} from 'lucide-react'
import type {
  PageExtraction,
  PageExtractionState,
  PageExtractionStatus,
  RequirementRecord,
  SubmissionMethod,
  TenderRecord,
} from '../../shared/types'
import { SUBMISSION_METHOD_LABEL } from '../../shared/types'
import { parseClosingDate, unreviewedOcrPages } from '../readiness'
import { useTendersStore } from '../store'
import type {
  FieldReview,
  ReviewCandidate,
  ReviewFieldKey,
  ReviewFieldState,
  TenderReview,
} from '../store'

// ── constants ────────────────────────────────────────────────────────────────

/** Below this, the source support is too weak to treat a value as settled. */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.65

export const REVIEW_FIELD_ORDER: ReviewFieldKey[] = [
  'title',
  'referenceNumber',
  'issuingBody',
  'contactEmail',
  'closingDate',
  'submissionMethod',
  'submissionDestination',
  'estimatedValue',
]

export const REVIEW_FIELD_LABEL: Record<ReviewFieldKey, string> = {
  title: 'Tender title',
  referenceNumber: 'Reference number',
  issuingBody: 'Issuing body',
  contactEmail: 'Contact email',
  closingDate: 'Closing date & time',
  submissionMethod: 'Submission method',
  submissionDestination: 'Submission destination',
  estimatedValue: 'Value',
}

const REVIEW_FIELD_HINT: Record<ReviewFieldKey, string> = {
  title: 'The title the bid will be tracked under.',
  referenceNumber: 'Used to identify the bid in correspondence. Must be unique in this workspace.',
  issuingBody: 'The buyer that issued the tender.',
  contactEmail: 'Clarification / submission e-mail printed in the document.',
  closingDate:
    'Must be a date the app can parse (for example 31 October 2026 at 11:00). Readiness stays blocked while this is unknown.',
  submissionMethod: 'How the bid pack must be handed over.',
  submissionDestination: 'Drop-off address, portal, or e-mail destination.',
  estimatedValue: 'Only treated as confirmed once you confirm it here.',
}

const FIELD_ICON: Record<ReviewFieldKey, typeof FileText> = {
  title: FileText,
  referenceNumber: Hash,
  issuingBody: Building2,
  contactEmail: Mail,
  closingDate: CalendarClock,
  submissionMethod: Send,
  submissionDestination: MapPin,
  estimatedValue: Banknote,
}

type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'

const TONE_CLASS: Record<Tone, string> = {
  // --success on --success-bg is only 4.06:1 at this size; the brand green is 7:1.
  ok: 'border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--color-brand-secondary)]',
  warn: 'border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn)]',
  bad: 'border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)]',
  neutral: 'border-[var(--border)] bg-[var(--surface-subtle)] text-[var(--text-secondary)]',
  accent: 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-dark)]',
}

const INPUT_CLASS =
  'w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] hover:border-[var(--border-hover)] focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)]'

// ── page extraction state (WP-7 alpha contract) ───────────────────────────────
// Pages with a text layer were read normally. Pages without one are NOT read:
// this build performs no OCR, so they stay unconfirmed and block readiness until
// a person opens the page and marks it reviewed. Nothing in this UI may imply a
// scanned page was extracted automatically.

export const PAGE_STATUS_LABEL: Record<PageExtractionStatus, string> = {
  native: 'Text layer',
  'ocr-required': 'No text layer',
  'ocr-unavailable': 'OCR unavailable',
  'ocr-failed': 'No usable text',
  'manually-reviewed': 'Reviewed',
}

const PAGE_STATUS_TONE: Record<PageExtractionStatus, Tone> = {
  native: 'neutral',
  'ocr-required': 'warn',
  'ocr-unavailable': 'warn',
  'ocr-failed': 'bad',
  'manually-reviewed': 'ok',
}

const PAGE_STATUS_EXPLANATION: Record<PageExtractionStatus, string> = {
  native: 'This page carries its own text layer, so it was read normally.',
  'ocr-required':
    'This page has no text layer. Zanostack does not read scanned pages, so nothing on it was extracted.',
  'ocr-unavailable':
    'This page has no text layer and OCR is not available on this platform, so nothing on it was extracted.',
  'ocr-failed': 'No usable text could be produced for this page, so nothing on it was extracted.',
  'manually-reviewed': 'You confirmed this page against the original document.',
}

/** A page blocks readiness until it has native text or a manual review. */
function pageBlocksReadiness(state: PageExtractionStatus): boolean {
  return state !== 'native' && state !== 'manually-reviewed'
}

/** How many unreadable pages are listed inline before a "show all" control. */
const PAGE_PREVIEW_LIMIT = 20

// ── source-line helpers ──────────────────────────────────────────────────────

interface SourceLine {
  text: string
  pageNumber: number
}

function flattenSourceLines(extraction: PageExtraction | null | undefined): SourceLine[] {
  if (!extraction) return []
  const out: SourceLine[] = []
  for (const page of extraction.pages) {
    for (const line of page.lines) {
      const text = line.text.replace(/\s+/g, ' ').trim()
      if (text.length < 2 || text.length > 400) continue
      out.push({ text, pageNumber: page.pageNumber })
      if (out.length >= 6000) return out
    }
  }
  return out
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** First source line that carries `value` (preferring a labelled line). */
function locateValue(
  lines: SourceLine[],
  value: string,
  labelHint?: RegExp,
): { pageNumber: number; clause: string } | null {
  const needle = normalizeForMatch(value)
  if (!needle) return null
  let fallback: SourceLine | null = null
  for (const line of lines) {
    if (!normalizeForMatch(line.text).includes(needle)) continue
    if (!fallback) fallback = line
    if (labelHint && labelHint.test(line.text))
      return { pageNumber: line.pageNumber, clause: line.text }
  }
  return fallback ? { pageNumber: fallback.pageNumber, clause: fallback.text } : null
}

function readStringList(raw: unknown, key: string): string[] {
  if (!raw || typeof raw !== 'object') return []
  const value = (raw as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim())
    else if (typeof item === 'number' && Number.isFinite(item)) out.push(String(item))
  }
  return out
}

/** Conflict notes may arrive as plain strings or as small objects. */
function readConflictList(raw: unknown): string[] {
  const asStrings = readStringList({ conflicts: raw }, 'conflicts')
  if (asStrings.length > 0) return asStrings
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const note = item as Record<string, unknown>
    const parts = [note.field, note.message, note.detail].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    )
    if (parts.length > 0) out.push(parts.join(': '))
  }
  return out
}

function clamp01(value: number): number {
  return Math.round(Math.min(0.95, Math.max(0.05, value)) * 100) / 100
}

const DATE_LABEL_RE =
  /closing|no\s*later\s*than|due\s*(date|time)|deadline|bids?\s*close|tenders?\s*close/i
const REF_LABEL_RE = /reference|ref\s*(no|number)|tender\s*no|bid\s*(no|number)/i
const ISSUER_LABEL_RE =
  /issued\s*by|issuing\s*authority|employer|contracting\s*authority|procuring\s*entity|department|municipal|authority/i
const DESTINATION_LABEL_RE = /submit|deliver|deposit|lodge|hand\s*in|bid\s*box|tender\s*box|portal/i
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const MONEY_RE = /(?:R|ZAR)\s?\d[\d\s.,]{3,}/gi
const VALUE_LABEL_RE =
  /(estimated|contract|bid|tender|project|budget)\s*(value|amount|budget|price|sum)/i

function inferMethodFromText(text: string): SubmissionMethod | null {
  if (EMAIL_RE.test(text)) return 'EMAIL'
  if (/bid\s*box|tender\s*box|receptacle|foyer|reception|registry|counter|security/i.test(text))
    return 'PHYSICAL'
  if (/portal|e-?tender|online|website|e-?submission|electronic/i.test(text)) return 'ELECTRONIC'
  return null
}

function toReviewCandidates(
  values: string[],
  lines: SourceLine[],
  labelHint?: RegExp,
  cap = 4,
): ReviewCandidate[] {
  const seen = new Set<string>()
  const out: ReviewCandidate[] = []
  for (const value of values) {
    const trimmed = value.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    const source = locateValue(lines, trimmed, labelHint)
    const labelled = Boolean(source && labelHint && labelHint.test(source.clause))
    out.push({
      value: trimmed,
      sourcePage: source?.pageNumber ?? null,
      sourceClause: source?.clause ?? null,
      score: source ? (labelled ? 1 : 0.7) : 0.4,
    })
    if (out.length >= cap) break
  }
  return out
}

function emailCandidates(lines: SourceLine[]): ReviewCandidate[] {
  const seen = new Set<string>()
  const out: ReviewCandidate[] = []
  for (const line of lines) {
    const matches = line.text.match(EMAIL_RE)
    if (!matches) continue
    for (const match of matches) {
      const key = match.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const contactish = /contact|enquir|clari|tender|bid|procure|info/i.test(line.text)
      out.push({
        value: match,
        sourcePage: line.pageNumber,
        sourceClause: line.text,
        score: Math.min(
          0.4 +
            (line.pageNumber === 1 ? 0.3 : 0.1) +
            (contactish ? 0.2 : 0) +
            (/(tender|bid)s?@/i.test(match) ? 0.2 : 0),
          1,
        ),
      })
    }
    if (out.length >= 8) break
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, 4)
}

function parseMoney(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null
  const value = Number(digits)
  return Number.isFinite(value) && value > 0 ? value : null
}

function valueCandidates(lines: SourceLine[]): ReviewCandidate[] {
  const seen = new Set<string>()
  const out: ReviewCandidate[] = []
  for (const line of lines) {
    const labelled = VALUE_LABEL_RE.test(line.text)
    if (!MONEY_RE.test(line.text) && !labelled) continue
    MONEY_RE.lastIndex = 0
    const matches = line.text.match(MONEY_RE) ?? []
    for (const match of matches) {
      const parsed = parseMoney(match)
      if (parsed === null) continue
      const key = String(parsed)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        value: key,
        sourcePage: line.pageNumber,
        sourceClause: line.text,
        score: Math.min(0.4 + (labelled ? 0.35 : 0.05) + (line.pageNumber === 1 ? 0.2 : 0.05), 1),
      })
    }
    if (out.length >= 8) break
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, 4)
}

function reviewConfidence(args: {
  candidateCount: number
  sourceFound: boolean
  agrees: boolean
  scored: boolean
}): number | null {
  if (args.candidateCount === 0) return null
  let confidence = 0.45
  confidence += args.sourceFound ? 0.2 : -0.15
  if (args.agrees) confidence += 0.15
  if (args.scored) confidence += 0.1
  if (args.candidateCount > 1) confidence -= Math.min(0.1 * (args.candidateCount - 1), 0.3)
  return clamp01(confidence)
}

// ── review construction ──────────────────────────────────────────────────────

/** Structural view of the parser's metadata (read defensively). */
export interface ParserReviewMeta {
  title: string
  referenceNumber: string | null
  issuingBody: string | null
  closingDate: string | null
  submissionMethod: SubmissionMethod | null
  submissionAddress: string | null
  candidates?: unknown
  conflicts?: unknown
}

export interface DeriveReviewArgs {
  meta: ParserReviewMeta
  extraction?: PageExtraction | null
  requirements?: Array<{ id: string; confidence?: number }>
  estimatedValue?: number | null
  now?: string
}

function numberToFieldValue(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

/**
 * Initial per-page extraction state straight from the parser: pages with a text
 * layer are `native`; textless pages are `ocr-required` (this build does not run
 * OCR) and therefore block readiness until they are manually reviewed.
 */
function pageExtractionStates(
  extraction: PageExtraction | null | undefined,
): PageExtractionState[] {
  if (!extraction) return []
  return extraction.pages.map((page) => ({
    pageNumber: page.pageNumber,
    state: page.needsOcr ? 'ocr-required' : 'native',
    method: page.needsOcr ? null : 'native-text',
    confidence: null,
    reviewedAt: null,
  }))
}

/**
 * Build the review annotation from the parser output. Candidate lists come from
 * the parser when it provides them; otherwise each field falls back to the
 * single extracted value with no source, which keeps the field "not confirmed"
 * instead of implying support that was never found.
 */
export function deriveTenderReview(args: DeriveReviewArgs): TenderReview {
  const now = args.now ?? new Date().toISOString()
  const lines = flattenSourceLines(args.extraction)
  const parserLists = Boolean(args.meta.candidates)
  const list = (key: string, fallback: string | null): string[] => {
    const fromParser = readStringList(args.meta.candidates, key)
    if (fromParser.length > 0) return fromParser
    return fallback ? [fallback] : []
  }

  const buildField = (
    key: ReviewFieldKey,
    values: string[],
    extractedValue: string | null,
    labelHint?: RegExp,
    precomputedCandidates?: ReviewCandidate[],
  ): FieldReview => {
    const candidates = precomputedCandidates ?? toReviewCandidates(values, lines, labelHint)
    const top = candidates[0] ?? null
    const agrees =
      extractedValue !== null && top !== null
        ? normalizeForMatch(top.value) === normalizeForMatch(extractedValue)
        : false
    return {
      extractedValue,
      sourcePage: top?.sourcePage ?? null,
      sourceClause: top?.sourceClause ?? null,
      confidence: reviewConfidence({
        candidateCount: candidates.length,
        sourceFound: Boolean(top?.sourcePage),
        agrees,
        scored: parserLists,
      }),
      candidates,
      state: 'unconfirmed',
      reviewedAt: null,
    }
  }

  const methodValues = list('submissionMethod', args.meta.submissionMethod)
  const destinationValues = list('submissionAddress', args.meta.submissionAddress)
  const destinationCandidates = toReviewCandidates(destinationValues, lines, DESTINATION_LABEL_RE)
  const methodCandidates: ReviewCandidate[] =
    methodValues.length > 0
      ? methodValues
          .filter((value): value is SubmissionMethod =>
            ['PHYSICAL', 'ELECTRONIC', 'EMAIL'].includes(value),
          )
          .map((value) => ({
            value,
            sourcePage: destinationCandidates[0]?.sourcePage ?? null,
            sourceClause: destinationCandidates[0]?.sourceClause ?? null,
            score: 0.7,
          }))
      : []
  if (methodCandidates.length === 0 && args.meta.submissionMethod) {
    const inferredSource = destinationCandidates[0]
    methodCandidates.push({
      value: args.meta.submissionMethod,
      sourcePage: inferredSource?.sourcePage ?? null,
      sourceClause: inferredSource?.sourceClause ?? null,
      score: inferredSource ? 0.6 : 0.4,
    })
  }
  if (methodCandidates.length === 0 && destinationCandidates.length > 0) {
    for (const candidate of destinationCandidates) {
      const method = candidate.sourceClause ? inferMethodFromText(candidate.sourceClause) : null
      if (method && !methodCandidates.some((m) => m.value === method)) {
        methodCandidates.push({ ...candidate, value: method, score: 0.5 })
      }
    }
  }

  const emailList = emailCandidates(lines)
  const valueList = valueCandidates(lines)

  const fields: Partial<Record<ReviewFieldKey, FieldReview>> = {
    title: buildField(
      'title',
      args.meta.title ? [args.meta.title] : [],
      args.meta.title || null,
      /request for|invitation to|tender|proposal/i,
    ),
    referenceNumber: buildField(
      'referenceNumber',
      list('referenceNumber', args.meta.referenceNumber),
      args.meta.referenceNumber,
      REF_LABEL_RE,
    ),
    issuingBody: buildField(
      'issuingBody',
      list('issuingBody', args.meta.issuingBody),
      args.meta.issuingBody,
      ISSUER_LABEL_RE,
    ),
    contactEmail: buildField('contactEmail', [], emailList[0]?.value ?? null, undefined, emailList),
    closingDate: buildField(
      'closingDate',
      list('closingDate', args.meta.closingDate),
      args.meta.closingDate,
      DATE_LABEL_RE,
    ),
    submissionMethod: buildField(
      'submissionMethod',
      methodValues,
      args.meta.submissionMethod,
      undefined,
      methodCandidates,
    ),
    submissionDestination: buildField(
      'submissionDestination',
      destinationValues,
      args.meta.submissionAddress,
      DESTINATION_LABEL_RE,
      destinationCandidates,
    ),
    estimatedValue: buildField(
      'estimatedValue',
      [],
      numberToFieldValue(args.estimatedValue),
      undefined,
      valueList,
    ),
  }

  const requirements: TenderReview['requirements'] = {}
  for (const requirement of args.requirements ?? []) {
    requirements[requirement.id] = {
      state: 'unreviewed',
      originalTitle: null,
      originalCategory: null,
      correctedAt: null,
    }
  }

  return {
    fields,
    requirements,
    pages: pageExtractionStates(args.extraction),
    contactEmail: emailList[0]?.value ?? null,
    conflicts: readConflictList(args.meta.conflicts),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Ambiguous readiness-critical metadata is never persisted from a guess: when
 * the parser reports more than one competing value, the field is imported as
 * unknown so readiness genuinely blocks until the user resolves it in review.
 * The competing values themselves are kept in the review annotation.
 */
export function gateConflictingMeta(meta: ParserReviewMeta): {
  closingDate: string | null
  submissionMethod: SubmissionMethod | null
  submissionAddress: string | null
  clearedFields: ReviewFieldKey[]
} {
  const ambiguous = (key: string): boolean => readStringList(meta.candidates, key).length > 1
  const clearedFields: ReviewFieldKey[] = []
  if (ambiguous('closingDate')) clearedFields.push('closingDate')
  if (ambiguous('submissionMethod')) clearedFields.push('submissionMethod')
  if (ambiguous('submissionAddress')) clearedFields.push('submissionDestination')
  return {
    closingDate: ambiguous('closingDate') ? null : meta.closingDate,
    submissionMethod: ambiguous('submissionMethod') ? null : meta.submissionMethod,
    submissionAddress: ambiguous('submissionAddress') ? null : meta.submissionAddress,
    clearedFields,
  }
}

/**
 * Refresh provenance/candidates from a fresh read of the source PDF without
 * touching any user decision. Used by the "Re-read source" action so a review
 * that was created without source access still shows pages and clauses.
 */
export function refreshTenderReview(review: TenderReview, args: DeriveReviewArgs): TenderReview {
  const fresh = deriveTenderReview({ ...args, now: review.createdAt })
  const fields: TenderReview['fields'] = { ...review.fields }
  for (const key of REVIEW_FIELD_ORDER) {
    const previous = review.fields?.[key]
    const next = fresh.fields?.[key]
    if (!next) continue
    if (!previous) {
      fields[key] = next
      continue
    }
    fields[key] = {
      ...previous,
      // Keep the first provenance ever captured; only fill a blank one.
      extractedValue: previous.extractedValue ?? next.extractedValue,
      candidates: next.candidates.length > 0 ? next.candidates : previous.candidates,
      confidence: next.confidence ?? previous.confidence,
      sourcePage: next.sourcePage ?? previous.sourcePage,
      sourceClause: next.sourceClause ?? previous.sourceClause,
    }
  }
  const requirements = { ...review.requirements }
  for (const requirement of args.requirements ?? []) {
    if (!requirements[requirement.id]) {
      requirements[requirement.id] = {
        state: 'unreviewed',
        originalTitle: null,
        originalCategory: null,
        correctedAt: null,
      }
    }
  }
  // Refresh page classification from the source without discarding a manual
  // review decision: a `manually-reviewed` page stays reviewed.
  const previousPages = new Map((review.pages ?? []).map((page) => [page.pageNumber, page]))
  const pages = (fresh.pages ?? []).map((page) => {
    const previous = previousPages.get(page.pageNumber)
    if (!previous) return page
    if (previous.state === 'manually-reviewed') return previous
    return { ...page, reviewedAt: previous.reviewedAt, confidence: previous.confidence }
  })
  for (const page of review.pages ?? []) {
    if (!pages.some((candidate) => candidate.pageNumber === page.pageNumber)) pages.push(page)
  }

  return {
    ...review,
    fields,
    requirements,
    pages,
    contactEmail: review.contactEmail ?? fresh.contactEmail,
    conflicts: fresh.conflicts.length > 0 ? fresh.conflicts : review.conflicts,
    updatedAt: new Date().toISOString(),
  }
}

// ── summary ──────────────────────────────────────────────────────────────────

export interface ReviewSummary {
  totalFields: number
  decidedFields: number
  pendingFields: number
  /** Unconfirmed fields that are low-confidence or carry competing values. */
  attentionFields: ReviewFieldKey[]
  conflictingFields: ReviewFieldKey[]
  lowConfidenceFields: ReviewFieldKey[]
  lowConfidenceRequirements: RequirementRecord[]
  /** Low-confidence requirements the user has not marked verified yet. */
  requirementAttention: RequirementRecord[]
  verifiedRequirements: number
  /** Low-confidence requirements the user has marked verified. */
  verifiedLowConfidenceRequirements: number
  /**
   * Pages with no text layer that have not been manually reviewed. These block
   * readiness (canonical predicate: `unreviewedOcrPages`), so the review step
   * must expose them with a way to clear each one.
   */
  pendingPages: PageExtractionState[]
  /** Pages the user has marked manually reviewed. */
  reviewedPages: number
  /** Page-level extraction records captured for this tender (0 = never captured). */
  totalPageStates: number
  /**
   * The document reports pages without a text layer, but no page-level state
   * was ever recorded. We cannot claim those pages were checked, so this keeps
   * the review open and points the user at "re-read source".
   */
  pagesUnclassified: boolean
  complete: boolean
}

export function summarizeReview(
  tender: TenderRecord,
  review: TenderReview | undefined,
): ReviewSummary {
  const pending: ReviewFieldKey[] = []
  const attention: ReviewFieldKey[] = []
  const conflicting: ReviewFieldKey[] = []
  const lowConfidence: ReviewFieldKey[] = []

  for (const key of REVIEW_FIELD_ORDER) {
    const field = review?.fields?.[key]
    const decided = field ? field.state !== 'unconfirmed' : false
    if (!decided) pending.push(key)
    const isConflicting = (field?.candidates?.length ?? 0) > 1
    const isLow =
      typeof field?.confidence === 'number' && field.confidence < REVIEW_CONFIDENCE_THRESHOLD
    if (isConflicting) conflicting.push(key)
    if (isLow) lowConfidence.push(key)
    if (!decided && (isConflicting || isLow || !field)) attention.push(key)
  }

  const lowConfidenceRequirements = tender.requirements.filter(
    (requirement) =>
      typeof requirement.confidence === 'number' &&
      requirement.confidence < REVIEW_CONFIDENCE_THRESHOLD,
  )
  const requirementAttention = lowConfidenceRequirements.filter(
    (requirement) => review?.requirements?.[requirement.id]?.state !== 'verified',
  )
  const verifiedRequirements = tender.requirements.filter(
    (requirement) => review?.requirements?.[requirement.id]?.state === 'verified',
  ).length
  const verifiedLowConfidenceRequirements = lowConfidenceRequirements.filter(
    (requirement) => review?.requirements?.[requirement.id]?.state === 'verified',
  ).length

  // Share the canonical readiness predicate so the panel can never drift from
  // what actually blocks the bid.
  const pendingPages = (review ? unreviewedOcrPages(review) : [])
    .slice()
    .sort((a, b) => a.pageNumber - b.pageNumber)
  const pageStates = review?.pages ?? []
  const reviewedPages = pageStates.filter((page) => page.state === 'manually-reviewed').length
  const pagesUnclassified = pageStates.length === 0 && tender.ocrPages > 0

  return {
    totalFields: REVIEW_FIELD_ORDER.length,
    decidedFields: REVIEW_FIELD_ORDER.length - pending.length,
    pendingFields: pending.length,
    attentionFields: attention,
    conflictingFields: conflicting,
    lowConfidenceFields: lowConfidence,
    lowConfidenceRequirements,
    requirementAttention,
    verifiedRequirements,
    verifiedLowConfidenceRequirements,
    pendingPages,
    reviewedPages,
    totalPageStates: pageStates.length,
    pagesUnclassified,
    complete:
      pending.length === 0 &&
      requirementAttention.length === 0 &&
      pendingPages.length === 0 &&
      !pagesUnclassified,
  }
}

// ── small presentational primitives ──────────────────────────────────────────

function Chip({
  tone,
  title,
  children,
}: {
  tone: Tone
  title?: string
  children: React.ReactNode
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  )
}

type ButtonVariant = 'primary' | 'subtle' | 'ghost' | 'danger'

function MiniButton({
  variant = 'subtle',
  type = 'button',
  onClick,
  title,
  disabled,
  className,
  children,
}: {
  variant?: ButtonVariant
  type?: 'button' | 'submit'
  onClick?: () => void
  title?: string
  disabled?: boolean
  className?: string
  children: React.ReactNode
}) {
  const variants: Record<ButtonVariant, string> = {
    primary:
      'bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-dark)] border border-transparent',
    subtle:
      'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:bg-[var(--hover)]',
    ghost: 'border border-transparent text-[var(--text-secondary)] hover:bg-[var(--hover)]',
    danger:
      'border border-[var(--danger-border)] bg-[var(--surface)] text-[var(--danger-text)] hover:bg-[var(--danger-bg)]',
  }
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex min-h-6 cursor-pointer items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className ?? ''}`}
    >
      {children}
    </button>
  )
}

function confidenceTone(confidence: number | null): Tone {
  if (confidence === null) return 'neutral'
  if (confidence >= 0.8) return 'ok'
  if (confidence >= REVIEW_CONFIDENCE_THRESHOLD) return 'accent'
  return 'warn'
}

function confidenceLabel(confidence: number | null): string {
  if (confidence === null) return 'No confidence score'
  const pct = Math.round(confidence * 100)
  if (confidence >= 0.8) return `High confidence · ${pct}%`
  if (confidence >= REVIEW_CONFIDENCE_THRESHOLD) return `Medium confidence · ${pct}%`
  return `Low confidence · ${pct}%`
}

function stateChip(
  state: ReviewFieldState,
  needsAttention: boolean,
): { tone: Tone; label: string } {
  switch (state) {
    case 'confirmed':
      return { tone: 'ok', label: 'Confirmed' }
    case 'corrected':
      return { tone: 'accent', label: 'Corrected' }
    case 'not_stated':
      return { tone: 'neutral', label: 'Not stated' }
    default:
      return needsAttention
        ? { tone: 'warn', label: 'Needs review' }
        : { tone: 'neutral', label: 'Not confirmed' }
  }
}

function formatMoneyValue(value: string): string {
  const parsed = parseMoney(value)
  return parsed === null ? value : `R ${parsed.toLocaleString('en-ZA')}`
}

function displayCandidateValue(field: ReviewFieldKey, value: string): string {
  if (field === 'estimatedValue') return formatMoneyValue(value)
  if (field === 'submissionMethod') {
    const method = value as SubmissionMethod
    return SUBMISSION_METHOD_LABEL[method] ?? value
  }
  return value
}

function revealSourcePage(page: number | null): void {
  if (!page || typeof document === 'undefined') return
  const element = document.querySelector(`[data-page="${page}"]`)
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

// ── page review ──────────────────────────────────────────────────────────────

/** Jump-to-page affordance reused by every page row (same scroll as field sources). */
function PageJumpButton({ pageNumber, pdfReady }: { pageNumber: number; pdfReady: boolean }) {
  return (
    <button
      type="button"
      onClick={() => revealSourcePage(pageNumber)}
      disabled={!pdfReady}
      title={pdfReady ? `Scroll the PDF to page ${pageNumber}` : 'Open the tender PDF first'}
      className="inline-flex cursor-pointer items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent-dark)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <FileText size={10} aria-hidden="true" /> p.{pageNumber}
    </button>
  )
}

function pageConfidenceLabel(confidence: number | null): string | null {
  if (typeof confidence !== 'number') return null
  return `${Math.round(confidence * 100)}% text confidence`
}

/**
 * The page half of the review step. A scanned tender shows its unreadable pages
 * first, each with the one action that clears the readiness gate (mark reviewed)
 * and a plain statement of what the app did and did not read.
 */
function PagesSection({
  tender,
  pages,
  pendingPages,
  reviewedPages,
  pdfReady,
  onReReadSource,
  onMarkReviewed,
  onMarkManyReviewed,
  onReopen,
}: {
  tender: TenderRecord
  pages: PageExtractionState[]
  pendingPages: PageExtractionState[]
  reviewedPages: number
  pdfReady: boolean
  onReReadSource?: () => Promise<PageExtraction | null>
  onMarkReviewed: (pageNumber: number) => void
  onMarkManyReviewed: (pageNumbers: number[]) => void
  onReopen: (page: PageExtractionState) => void
}) {
  const [showAllBlocked, setShowAllBlocked] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const sectionId = useId()
  const resolvedListId = `${sectionId}-resolved`

  const blocked = useMemo(
    () => pendingPages.slice().sort((a, b) => a.pageNumber - b.pageNumber),
    [pendingPages],
  )
  const resolved = useMemo(
    () =>
      pages
        .filter((page) => !pageBlocksReadiness(page.state))
        .slice()
        .sort((a, b) => a.pageNumber - b.pageNumber),
    [pages],
  )
  const blockedShown = showAllBlocked ? blocked : blocked.slice(0, PAGE_PREVIEW_LIMIT)
  const isBlocked = blocked.length > 0

  // No page-level state was ever captured. If the document is known to contain
  // pages without a text layer, say so and point at the re-read action instead
  // of silently claiming the pages are fine.
  if (pages.length === 0) {
    if (tender.ocrPages <= 0) return null
    return (
      <section
        className="mt-3 rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] p-3"
        aria-label="Page review"
      >
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text)]">
          <ScanLine size={12} className="text-[var(--warn)]" aria-hidden="true" />
          {tender.ocrPages} page{tender.ocrPages === 1 ? '' : 's'} without a text layer
        </p>
        <p className="mt-1 text-[11px] leading-snug text-[var(--text-secondary)]">
          This tender has no page-level extraction state yet, so the app cannot say which pages were
          read. Re-read the source to classify each page, then review the pages that have no text
          layer.
        </p>
        {onReReadSource && (
          <div className="mt-2">
            <MiniButton onClick={() => void onReReadSource()} disabled={!pdfReady}>
              <RotateCcw size={11} aria-hidden="true" /> Re-read source
            </MiniButton>
          </div>
        )}
      </section>
    )
  }

  return (
    <section
      className={`mt-3 rounded-xl border p-3 ${
        isBlocked
          ? 'border-[var(--warn-border)] bg-[var(--surface)]'
          : 'border-[var(--border)] bg-[var(--surface)]'
      }`}
      aria-label="Page review"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
          <FileStack size={13} className="text-[var(--accent)]" aria-hidden="true" />
          Pages in this document
        </h3>
        <Chip tone={isBlocked ? 'warn' : 'ok'}>
          {isBlocked ? (
            <>
              <AlertTriangle size={11} aria-hidden="true" /> {blocked.length} page
              {blocked.length === 1 ? '' : 's'} need review
            </>
          ) : (
            <>
              <Check size={11} aria-hidden="true" /> All pages readable
            </>
          )}
        </Chip>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-secondary)]">
        {isBlocked
          ? `Zanostack does not read scanned pages. ${blocked.length} page${
              blocked.length === 1 ? '' : 's'
            } here have no usable text layer, so nothing on them was extracted — open each one in the PDF and mark it reviewed. Readiness stays blocked until every page is reviewed or has its own text layer.`
          : 'Every page either carries its own text layer or has been marked reviewed by you.'}
      </p>

      {blocked.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <MiniButton
            variant="subtle"
            onClick={() => onMarkManyReviewed(blocked.map((page) => page.pageNumber))}
            title="Only use this once you have compared every one of these pages against the original document"
          >
            <Check size={12} aria-hidden="true" /> Mark all {blocked.length} pages reviewed
          </MiniButton>
        </div>
      )}

      {isBlocked && (
        <>
          <ul className="mt-2 space-y-1.5">
            {blockedShown.map((page) => {
              const confidence = pageConfidenceLabel(page.confidence)
              return (
                <li
                  key={page.pageNumber}
                  className="rounded-lg border border-[var(--warn-border)] bg-[var(--surface-subtle)] px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <PageJumpButton pageNumber={page.pageNumber} pdfReady={pdfReady} />
                    <Chip
                      tone={PAGE_STATUS_TONE[page.state]}
                      title={PAGE_STATUS_EXPLANATION[page.state]}
                    >
                      {PAGE_STATUS_LABEL[page.state]}
                    </Chip>
                    {page.method && (
                      <span className="text-[11px] text-[var(--text-tertiary)]">{page.method}</span>
                    )}
                    {confidence && (
                      <span className="text-[11px] text-[var(--text-tertiary)]">{confidence}</span>
                    )}
                    <MiniButton
                      variant="primary"
                      className="ml-auto"
                      onClick={() => onMarkReviewed(page.pageNumber)}
                      title="I have read this page in the original document"
                    >
                      <BadgeCheck size={11} aria-hidden="true" /> Mark reviewed
                    </MiniButton>
                  </div>
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-[var(--text-tertiary)]">
                    <EyeOff size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
                    {PAGE_STATUS_EXPLANATION[page.state]}
                  </p>
                </li>
              )
            })}
          </ul>
          {!showAllBlocked && blocked.length > blockedShown.length && (
            <div className="mt-2">
              <MiniButton variant="ghost" onClick={() => setShowAllBlocked(true)}>
                <ChevronDown size={11} aria-hidden="true" /> Show all {blocked.length} pages
              </MiniButton>
            </div>
          )}
        </>
      )}

      {resolved.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowResolved((value) => !value)}
            aria-expanded={showResolved}
            aria-controls={resolvedListId}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          >
            {showResolved ? (
              <ChevronDown size={11} aria-hidden="true" />
            ) : (
              <ChevronRight size={11} aria-hidden="true" />
            )}
            {showResolved ? 'Hide' : 'Show'} {resolved.length} readable page
            {resolved.length === 1 ? '' : 's'}
            {reviewedPages > 0 ? ` (${reviewedPages} reviewed by you)` : ''}
          </button>
          {showResolved && (
            <ul id={resolvedListId} className="mt-1.5 space-y-1">
              {resolved.map((page) => {
                const confidence = pageConfidenceLabel(page.confidence)
                return (
                  <li
                    key={page.pageNumber}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1.5"
                  >
                    <PageJumpButton pageNumber={page.pageNumber} pdfReady={pdfReady} />
                    <Chip tone={PAGE_STATUS_TONE[page.state]}>{PAGE_STATUS_LABEL[page.state]}</Chip>
                    {page.method && (
                      <span className="text-[11px] text-[var(--text-tertiary)]">{page.method}</span>
                    )}
                    {confidence && (
                      <span className="text-[11px] text-[var(--text-tertiary)]">{confidence}</span>
                    )}
                    {page.state === 'manually-reviewed' && (
                      <MiniButton
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => onReopen(page)}
                        title="Reopen this page — it will need review again and block readiness"
                      >
                        <RotateCcw size={11} aria-hidden="true" /> Reopen
                      </MiniButton>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

// ── main component ───────────────────────────────────────────────────────────

export function ExtractionReview({
  tender,
  review,
  pdfReady,
  onBack,
  onReReadSource,
  onOpenRequirement,
}: {
  tender: TenderRecord
  review: TenderReview
  pdfReady: boolean
  onBack: () => void
  onReReadSource?: () => Promise<PageExtraction | null>
  onOpenRequirement: (requirementId: string) => void
}) {
  const updateTender = useTendersStore((state) => state.updateTender)
  const updateFieldReview = useTendersStore((state) => state.updateFieldReview)
  const setReviewContactEmail = useTendersStore((state) => state.setReviewContactEmail)
  const updateRequirementReview = useTendersStore((state) => state.updateRequirementReview)
  const removeRequirement = useTendersStore((state) => state.removeRequirement)
  const markPageReviewed = useTendersStore((state) => state.markPageReviewed)
  const setPageExtractionState = useTendersStore((state) => state.setPageExtractionState)
  const setPageExtractionStates = useTendersStore((state) => state.setPageExtractionStates)

  const [drafts, setDrafts] = useState<Partial<Record<ReviewFieldKey, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<ReviewFieldKey, string>>>({})
  const [reReading, setReReading] = useState(false)
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)

  // A new tender is a new review — never carry drafts across.
  useEffect(() => {
    setDrafts({})
    setErrors({})
    setPendingRemoveId(null)
  }, [tender.id])

  const summary = useMemo(() => summarizeReview(tender, review), [tender, review])
  const pages = review.pages ?? []

  const currentValueFor = (field: ReviewFieldKey): string => {
    switch (field) {
      case 'title':
        return tender.title
      case 'referenceNumber':
        return tender.referenceNumber ?? ''
      case 'issuingBody':
        return tender.issuingBody ?? ''
      case 'contactEmail':
        return review.contactEmail ?? ''
      case 'closingDate':
        return tender.closingDate ?? ''
      case 'submissionMethod':
        return tender.submissionMethod ?? ''
      case 'submissionDestination':
        return tender.submissionAddress ?? ''
      case 'estimatedValue':
        return numberToFieldValue(tender.estimatedValue) ?? ''
      default:
        return ''
    }
  }

  const applyFieldValue = (field: ReviewFieldKey, raw: string): string | null => {
    const value = raw.replace(/\s+/g, ' ').trim()

    if (field === 'title') {
      if (!value) return 'A tender needs a title — type one or keep the extracted title.'
      updateTender(tender.id, { title: value })
      return null
    }
    if (field === 'referenceNumber') {
      updateTender(tender.id, { referenceNumber: value || null })
      return null
    }
    if (field === 'issuingBody') {
      updateTender(tender.id, { issuingBody: value || null })
      return null
    }
    if (field === 'contactEmail') {
      if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return 'That does not look like an e-mail address.'
      }
      setReviewContactEmail(tender.id, value || null)
      return null
    }
    if (field === 'closingDate') {
      if (!value) {
        updateTender(tender.id, { closingDate: null })
        return null
      }
      if (!parseClosingDate(value)) {
        return 'The app cannot read that date. Use a format like 31 October 2026 at 11:00 or 2026-10-31 11:00.'
      }
      updateTender(tender.id, { closingDate: value })
      return null
    }
    if (field === 'submissionMethod') {
      updateTender(tender.id, { submissionMethod: (value || null) as SubmissionMethod | null })
      return null
    }
    if (field === 'submissionDestination') {
      updateTender(tender.id, { submissionAddress: value || null })
      return null
    }
    if (field === 'estimatedValue') {
      if (!value) {
        updateTender(tender.id, { estimatedValue: null, pricingConfirmed: false })
        return null
      }
      const parsed = parseMoney(value)
      if (parsed === null) return 'Enter a rand amount, for example 1 200 000.'
      updateTender(tender.id, { estimatedValue: parsed, pricingConfirmed: true })
      return null
    }
    return 'Unsupported field.'
  }

  const commitField = (field: ReviewFieldKey, raw: string) => {
    const error = applyFieldValue(field, raw)
    if (error) {
      setErrors((previous) => ({ ...previous, [field]: error }))
      return
    }
    setErrors((previous) => {
      const next = { ...previous }
      delete next[field]
      return next
    })
    setDrafts((previous) => {
      const next = { ...previous }
      delete next[field]
      return next
    })
    const extracted = review.fields?.[field]?.extractedValue ?? null
    const normalized = raw.replace(/\s+/g, ' ').trim()
    const state: ReviewFieldState =
      extracted !== null && normalizeForMatch(extracted) === normalizeForMatch(normalized)
        ? 'confirmed'
        : 'corrected'
    updateFieldReview(tender.id, field, { state, reviewedAt: new Date().toISOString() })
  }

  const confirmField = (field: ReviewFieldKey, raw?: string) => {
    const value = (raw ?? currentValueFor(field)).replace(/\s+/g, ' ').trim()
    if (!value) return
    // "Confirm" means: the value now in the field is the right one. commitField
    // records it as corrected when it differs from what the parser lifted, so
    // the audit trail never claims a changed value was the original.
    commitField(field, value)
  }

  const markNotStated = (field: ReviewFieldKey) => {
    const error = applyFieldValue(field, '')
    if (error) {
      setErrors((previous) => ({ ...previous, [field]: error }))
      return
    }
    setDrafts((previous) => {
      const next = { ...previous }
      delete next[field]
      return next
    })
    updateFieldReview(tender.id, field, {
      state: 'not_stated',
      reviewedAt: new Date().toISOString(),
    })
  }

  const restoreExtracted = (field: ReviewFieldKey) => {
    const extracted = review.fields?.[field]?.extractedValue
    if (extracted === null || extracted === undefined) return
    commitField(field, extracted)
  }

  const chooseCandidate = (field: ReviewFieldKey, candidate: ReviewCandidate) => {
    commitField(field, candidate.value)
  }

  const confirmAllFound = () => {
    for (const field of REVIEW_FIELD_ORDER) {
      // The price is never bulk-confirmed: it is high-stakes and must stay an
      // explicit decision, so a stray click cannot make a proposal look priced.
      if (field === 'estimatedValue') continue
      const detail = review.fields?.[field]
      if (!detail || detail.state !== 'unconfirmed') continue
      if (detail.candidates.length !== 1) continue
      if (typeof detail.confidence !== 'number') continue
      if (detail.confidence < REVIEW_CONFIDENCE_THRESHOLD) continue
      if (!currentValueFor(field)) continue
      updateFieldReview(tender.id, field, {
        state: 'confirmed',
        reviewedAt: new Date().toISOString(),
      })
    }
  }

  const verifyRequirement = (requirementId: string) => {
    updateRequirementReview(tender.id, requirementId, { state: 'verified' })
  }

  const verifyAllRemainingRequirements = () => {
    for (const requirement of summary.requirementAttention) {
      updateRequirementReview(tender.id, requirement.id, { state: 'verified' })
    }
  }

  // ── page review actions ────────────────────────────────────────────────────
  const handleMarkPageReviewed = (pageNumber: number) => {
    markPageReviewed(tender.id, pageNumber)
  }

  // One authoritative write for the bulk action instead of N sequential patches.
  const handleMarkManyPagesReviewed = (pageNumbers: number[]) => {
    const reviewedAt = new Date().toISOString()
    const next = pages.map((page) =>
      pageNumbers.includes(page.pageNumber)
        ? { ...page, state: 'manually-reviewed' as const, reviewedAt }
        : page,
    )
    setPageExtractionStates(tender.id, next)
  }

  // "Set back" returns a reviewed page to the state that blocks readiness again.
  // The pre-review status is not stored, so a page with native text returns to
  // `native`; everything else returns to `ocr-required` (needs a human read).
  const handleReopenPage = (page: PageExtractionState) => {
    const base: PageExtractionStatus = page.method === 'native-text' ? 'native' : 'ocr-required'
    setPageExtractionState(tender.id, page.pageNumber, { state: base, reviewedAt: null })
  }

  // Unclassified scanned pages count as outstanding page work so the bar cannot
  // read as complete while they are still unverified.
  const pageWork =
    summary.pendingPages.length +
    summary.reviewedPages +
    (summary.pagesUnclassified ? tender.ocrPages : 0)
  const progressTotal = summary.totalFields + summary.lowConfidenceRequirements.length + pageWork
  const progressNow = Math.min(
    progressTotal,
    summary.decidedFields + summary.verifiedLowConfidenceRequirements + summary.reviewedPages,
  )

  const handleReRead = async () => {
    if (!onReReadSource) return
    setReReading(true)
    try {
      await onReReadSource()
    } finally {
      setReReading(false)
    }
  }

  const orderedFields = useMemo(() => {
    const attention = new Set(summary.attentionFields)
    return [...REVIEW_FIELD_ORDER].sort((a, b) => {
      const aAttention = attention.has(a) ? 0 : 1
      const bAttention = attention.has(b) ? 0 : 1
      if (aAttention !== bAttention) return aAttention - bAttention
      return REVIEW_FIELD_ORDER.indexOf(a) - REVIEW_FIELD_ORDER.indexOf(b)
    })
  }, [summary.attentionFields])

  const conflictNotes = review.conflicts ?? []

  // Rendered in one of two places (see below): before the fields while pages
  // block readiness so a scanned tender leads with the action, otherwise after
  // the requirements as a quiet summary.
  const pagesSection = (
    <PagesSection
      tender={tender}
      pages={pages}
      pendingPages={summary.pendingPages}
      reviewedPages={summary.reviewedPages}
      pdfReady={pdfReady}
      onReReadSource={onReReadSource}
      onMarkReviewed={handleMarkPageReviewed}
      onMarkManyReviewed={handleMarkManyPagesReviewed}
      onReopen={handleReopenPage}
    />
  )

  return (
    <section
      className="review-enter flex h-full min-h-0 flex-col bg-[var(--surface)]"
      aria-label="Extraction review"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
            <BadgeCheck size={15} className="text-[var(--accent)]" aria-hidden="true" />
            Extraction review
          </h2>
          <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
            Confirm, correct or reject every value the parser lifted before the bid is treated as
            ready.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onReReadSource && (
            <MiniButton
              onClick={() => void handleReRead()}
              disabled={!pdfReady || reReading}
              title={
                pdfReady
                  ? 'Re-read the PDF to refresh source pages and clauses'
                  : 'Open the tender PDF first'
              }
            >
              <RotateCcw size={12} className={reReading ? 'animate-spin' : ''} /> Re-read source
            </MiniButton>
          )}
          <MiniButton onClick={onBack} variant="subtle" title="Back to the compliance matrix">
            Back to matrix
          </MiniButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-3 py-3">
        {/* progress */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-[var(--text)]">
              {summary.decidedFields} of {summary.totalFields} fields confirmed
              {summary.lowConfidenceRequirements.length > 0 && (
                <span className="text-[var(--text-tertiary)]">
                  {' '}
                  · {summary.verifiedLowConfidenceRequirements} of{' '}
                  {summary.lowConfidenceRequirements.length} requirements verified
                </span>
              )}
              {summary.pendingPages.length > 0 && (
                <span className="text-[var(--text-tertiary)]">
                  {' '}
                  · {summary.pendingPages.length} page
                  {summary.pendingPages.length === 1 ? '' : 's'} to review
                </span>
              )}
              {summary.pagesUnclassified && (
                <span className="text-[var(--text-tertiary)]">
                  {' '}
                  · {tender.ocrPages} page{tender.ocrPages === 1 ? '' : 's'} with no recorded text
                  layer
                </span>
              )}
            </p>
            <Chip tone={summary.complete ? 'ok' : 'warn'}>
              {summary.complete ? (
                <>
                  <Check size={11} aria-hidden="true" /> Review complete
                </>
              ) : (
                <>
                  <AlertTriangle size={11} aria-hidden="true" /> Review incomplete
                </>
              )}
            </Chip>
          </div>
          <div
            role="progressbar"
            aria-label="Extraction review progress"
            aria-valuemin={0}
            aria-valuemax={Math.max(1, progressTotal)}
            aria-valuenow={Math.min(progressNow, Math.max(1, progressTotal))}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-subtle)]"
          >
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all"
              style={{
                width: `${progressTotal === 0 ? 100 : Math.round((progressNow / progressTotal) * 100)}%`,
              }}
            />
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            Extraction review: {summary.decidedFields} of {summary.totalFields} fields confirmed,{' '}
            {summary.verifiedLowConfidenceRequirements} of{' '}
            {summary.lowConfidenceRequirements.length} requirements verified,{' '}
            {summary.pendingPages.length} page
            {summary.pendingPages.length === 1 ? '' : 's'} still to review.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <MiniButton
              variant="subtle"
              onClick={confirmAllFound}
              disabled={summary.pendingFields === 0}
              title="Confirm the fields that have a single, well-sourced value"
            >
              <Check size={12} aria-hidden="true" /> Confirm well-sourced fields
            </MiniButton>
            {summary.requirementAttention.length > 0 && (
              <MiniButton variant="subtle" onClick={verifyAllRemainingRequirements}>
                <BadgeCheck size={12} aria-hidden="true" /> Mark remaining requirements verified
              </MiniButton>
            )}
          </div>
          {!summary.complete && (
            <p className="mt-2 rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-2 py-1.5 text-[11px] leading-snug text-[var(--warn)]">
              Confirm every field before you treat this bid as ready. A field you mark not stated is
              cleared, and a deadline, submission method or destination that had competing values
              was imported as unknown — so readiness stays blocked until you resolve it here.
              {summary.pendingPages.length > 0 &&
                ` Pages with no text layer also block readiness until you review them below.`}
              {summary.pagesUnclassified &&
                ` This tender reports pages without a text layer but none were classified — re-read the source to classify them.`}
            </p>
          )}
        </div>

        {conflictNotes.length > 0 && (
          <div className="mt-3 rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] p-3">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--warn)]">
              <AlertTriangle size={12} aria-hidden="true" /> Conflicting values found in the
              document
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-[var(--warn)]">
              {conflictNotes.map((note, index) => (
                <li key={`${index}-${note}`}>{note}</li>
              ))}
            </ul>
          </div>
        )}

        {/* pages lead when they are the blocker, so a scanned tender reads first */}
        {summary.pendingPages.length > 0 && pagesSection}

        {/* fields */}
        <ul className="mt-3 space-y-2.5">
          {orderedFields.map((field, index) => (
            <li
              key={field}
              className="review-enter"
              style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
            >
              <FieldCard
                field={field}
                tender={tender}
                detail={review.fields?.[field]}
                draft={drafts[field]}
                error={errors[field] ?? null}
                currentValue={currentValueFor(field)}
                pdfReady={pdfReady}
                onDraft={(value) => setDrafts((previous) => ({ ...previous, [field]: value }))}
                onCommit={(value) => commitField(field, value)}
                onConfirm={(value) => confirmField(field, value)}
                onNotStated={() => markNotStated(field)}
                onRestore={() => restoreExtracted(field)}
                onChooseCandidate={(candidate) => chooseCandidate(field, candidate)}
              />
            </li>
          ))}
        </ul>

        {/* requirements that need a decision */}
        <section className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
              <FileText size={13} className="text-[var(--accent)]" aria-hidden="true" />
              Requirements needing verification
            </h3>
            <MiniButton onClick={onBack} title="Add, edit, reclassify or remove requirements">
              Add or edit in the matrix
            </MiniButton>
          </div>
          {summary.requirementAttention.length === 0 ? (
            <p className="mt-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2 text-[11px] text-[var(--text-tertiary)]">
              {summary.lowConfidenceRequirements.length === 0
                ? 'Every extracted requirement matched strongly. You can still add, edit, reclassify or remove requirements in the compliance matrix.'
                : 'All low-confidence requirements have been verified.'}
            </p>
          ) : (
            <ul className="mt-1.5 space-y-2">
              {summary.requirementAttention.map((requirement) => (
                <li
                  key={requirement.id}
                  className="rounded-xl border border-[var(--warn-border)] bg-[var(--surface)] p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-[var(--text)]">
                        {requirement.title}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
                        <span>p.{requirement.pageNumber}</span>
                        <Chip tone="warn">{confidenceLabel(requirement.confidence ?? null)}</Chip>
                        {requirement.isMandatory && <Chip tone="bad">Mandatory</Chip>}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <MiniButton
                        onClick={() => {
                          onOpenRequirement(requirement.id)
                          revealSourcePage(requirement.pageNumber)
                        }}
                        title="Show this clause in the PDF"
                      >
                        <MapPin size={11} aria-hidden="true" /> Open source
                      </MiniButton>
                      <MiniButton
                        variant="primary"
                        onClick={() => verifyRequirement(requirement.id)}
                      >
                        <BadgeCheck size={11} aria-hidden="true" /> Mark verified
                      </MiniButton>
                      {pendingRemoveId === requirement.id ? (
                        <MiniButton
                          variant="danger"
                          onClick={() => {
                            removeRequirement(tender.id, requirement.id)
                            setPendingRemoveId(null)
                          }}
                        >
                          <Trash2 size={11} aria-hidden="true" /> Confirm remove
                        </MiniButton>
                      ) : (
                        <MiniButton
                          variant="ghost"
                          onClick={() => setPendingRemoveId(requirement.id)}
                          title="This requirement does not belong to this tender"
                        >
                          <Trash2 size={11} aria-hidden="true" /> Remove
                        </MiniButton>
                      )}
                    </div>
                  </div>
                  {requirement.verbatimClause && (
                    <blockquote className="mt-2 border-l-2 border-[var(--border-strong)] pl-2.5 text-[11px] leading-relaxed text-[var(--text-tertiary)] italic">
                      “{requirement.verbatimClause}”
                    </blockquote>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {summary.pendingPages.length === 0 && pagesSection}

        <p className="mt-4 pb-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          Corrections are saved to this tender as you make them — there is no need to import the PDF
          again. The originally extracted text is kept beside each corrected field.
        </p>
      </div>
    </section>
  )
}

// ── one field card ───────────────────────────────────────────────────────────

function FieldCard({
  field,
  tender,
  detail,
  draft,
  error,
  currentValue,
  pdfReady,
  onDraft,
  onCommit,
  onConfirm,
  onNotStated,
  onRestore,
  onChooseCandidate,
}: {
  field: ReviewFieldKey
  tender: TenderRecord
  detail: FieldReview | undefined
  draft: string | undefined
  error: string | null
  currentValue: string
  pdfReady: boolean
  onDraft: (value: string) => void
  onCommit: (value: string) => void
  onConfirm: (value: string) => void
  onNotStated: () => void
  onRestore: () => void
  onChooseCandidate: (candidate: ReviewCandidate) => void
}) {
  const inputId = useId()
  const hintId = `${inputId}-hint`
  const provenanceId = `${inputId}-provenance`
  const Icon = FIELD_ICON[field]
  const state = detail?.state ?? 'unconfirmed'
  const conflicting = (detail?.candidates?.length ?? 0) > 1
  const confidence = detail?.confidence ?? null
  const needsAttention =
    state === 'unconfirmed' &&
    (conflicting || confidence === null || confidence < REVIEW_CONFIDENCE_THRESHOLD)
  const chip = stateChip(state, needsAttention)
  const label = REVIEW_FIELD_LABEL[field]
  const value = draft ?? currentValue
  const original = detail?.extractedValue ?? null
  const corrected =
    (state === 'corrected' || state === 'not_stated') &&
    original !== null &&
    normalizeForMatch(original) !== normalizeForMatch(currentValue)
  const canConfirm = currentValue.trim().length > 0
  const canNotState = field !== 'title'
  const sourcePage = detail?.sourcePage ?? null
  const sourceClause = detail?.sourceClause ?? null
  const topCandidate = detail?.candidates?.[0] ?? null
  const topSuggestion =
    topCandidate && normalizeForMatch(topCandidate.value) !== normalizeForMatch(currentValue)
      ? topCandidate
      : null

  return (
    <fieldset
      className={`rounded-xl border p-3 ${
        needsAttention
          ? 'border-[var(--warn-border)] bg-[var(--surface)]'
          : 'border-[var(--border)] bg-[var(--surface)]'
      }`}
    >
      <legend className="sr-only">{label}</legend>

      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
          <Icon size={13} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
          {/* A real label, not just the sr-only legend: the field control needs
              its own programmatic name (the legend only labels the group). */}
          <label htmlFor={inputId} className="cursor-pointer truncate">
            {label}
          </label>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={chip.tone}>{chip.label}</Chip>
          <Chip
            tone={confidenceTone(confidence)}
            title="How strongly the document supports this value. Low confidence values must be checked against the source page."
          >
            {confidenceLabel(confidence)}
          </Chip>
        </div>
      </div>

      <p id={hintId} className="mt-1 text-[11px] text-[var(--text-tertiary)]">
        {REVIEW_FIELD_HINT[field]}
      </p>

      {/* value control */}
      <div className="mt-2">
        {field === 'submissionMethod' ? (
          <select
            id={inputId}
            value={value}
            aria-describedby={`${hintId} ${provenanceId}`}
            onChange={(event) => onCommit(event.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">— not set —</option>
            <option value="EMAIL">{SUBMISSION_METHOD_LABEL.EMAIL}</option>
            <option value="PHYSICAL">{SUBMISSION_METHOD_LABEL.PHYSICAL}</option>
            <option value="ELECTRONIC">{SUBMISSION_METHOD_LABEL.ELECTRONIC}</option>
          </select>
        ) : (
          <input
            id={inputId}
            type={field === 'contactEmail' ? 'email' : 'text'}
            inputMode={field === 'estimatedValue' ? 'decimal' : undefined}
            value={value}
            aria-describedby={`${hintId} ${provenanceId}`}
            aria-invalid={error ? true : undefined}
            onChange={(event) => onDraft(event.target.value)}
            onBlur={(event) => onCommit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onCommit(event.currentTarget.value)
              }
            }}
            placeholder={
              field === 'estimatedValue'
                ? 'e.g. 1 200 000'
                : field === 'closingDate'
                  ? 'e.g. 31 October 2026 at 11:00'
                  : ''
            }
            className={INPUT_CLASS}
          />
        )}
      </div>

      {error && (
        <p role="alert" className="mt-1 text-[11px] font-medium text-[var(--danger-text)]">
          {error}
        </p>
      )}

      {/* single sourced suggestion that is not the value in the field yet */}
      {!conflicting && topSuggestion && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2 py-1.5 text-[11px] text-[var(--text-secondary)]">
          <span className="font-medium">Found in the document:</span>
          <span>{displayCandidateValue(field, topSuggestion.value)}</span>
          {topSuggestion.sourcePage && (
            <span className="text-[var(--text-tertiary)]">p.{topSuggestion.sourcePage}</span>
          )}
          <MiniButton
            variant="subtle"
            className="ml-auto"
            onClick={() => onChooseCandidate(topSuggestion)}
          >
            <Check size={11} aria-hidden="true" /> Use this value
          </MiniButton>
        </div>
      )}

      {/* provenance */}
      <p
        id={provenanceId}
        className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-tertiary)]"
      >
        {sourcePage ? (
          <>
            <button
              type="button"
              onClick={() => revealSourcePage(sourcePage)}
              disabled={!pdfReady}
              className="inline-flex cursor-pointer items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-medium text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent-dark)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              title={
                pdfReady
                  ? 'Scroll the PDF to this page'
                  : 'Open the tender PDF to jump to the source'
              }
            >
              <MapPin size={10} aria-hidden="true" /> p.{sourcePage}
            </button>
            <span className="text-[var(--text-tertiary)]">source page</span>
          </>
        ) : (
          <span>No source page recorded for this value.</span>
        )}
        {sourceClause && (
          <span className="line-clamp-2 w-full text-[var(--text-tertiary)] italic">
            “{sourceClause}”
          </span>
        )}
      </p>

      {/* original extracted value (provenance after a correction) */}
      {original !== null && original.trim().length > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">
          <span className="font-medium">Original extracted text:</span>
          <span className="italic">{displayCandidateValue(field, original)}</span>
          {corrected && (
            <button
              type="button"
              onClick={onRestore}
              className="inline-flex cursor-pointer items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-medium hover:border-[var(--accent)] hover:text-[var(--accent-dark)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            >
              <RotateCcw size={10} aria-hidden="true" /> Restore
            </button>
          )}
        </p>
      )}

      {/* competing candidates */}
      {conflicting && (
        <fieldset className="mt-2 rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] p-2">
          <legend className="px-1 text-[11px] font-semibold text-[var(--warn)]">
            {detail?.candidates.length} competing values — choose the one that stands
          </legend>
          <ul className="space-y-1">
            {detail?.candidates.map((candidate, index) => {
              const selected =
                normalizeForMatch(candidate.value) === normalizeForMatch(currentValue) &&
                currentValue.length > 0
              return (
                <li key={`${candidate.value}-${index}`}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--hover)]">
                    <input
                      type="radio"
                      name={inputId}
                      className="mt-0.5 size-3.5 shrink-0 accent-[var(--accent)]"
                      checked={selected}
                      onChange={() => onChooseCandidate(candidate)}
                    />
                    <span className="min-w-0">
                      <span className="block text-[11px] font-medium text-[var(--text)]">
                        {displayCandidateValue(field, candidate.value)}
                        {candidate.sourcePage ? (
                          <span className="ml-1.5 font-normal text-[var(--text-tertiary)]">
                            p.{candidate.sourcePage}
                          </span>
                        ) : null}
                      </span>
                      {candidate.sourceClause && (
                        <span className="mt-0.5 line-clamp-2 block text-[11px] text-[var(--text-tertiary)] italic">
                          “{candidate.sourceClause}”
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>
      )}

      {!conflicting && needsAttention && (
        <p className="mt-2 text-[11px] text-[var(--warn)]">
          {confidence === null
            ? 'Nothing was found for this field. Mark it not stated or type the value from the document.'
            : 'Only one weak match was found. Check it against the source page before confirming.'}
        </p>
      )}

      {/* actions */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <MiniButton
          variant="primary"
          onClick={() => onConfirm(value)}
          disabled={!canConfirm}
          title={canConfirm ? 'Confirm this value is correct' : 'Nothing to confirm yet'}
        >
          <Check size={11} aria-hidden="true" /> Confirm
        </MiniButton>
        <MiniButton
          variant="subtle"
          onClick={onNotStated}
          disabled={!canNotState}
          title={
            canNotState
              ? 'The document does not state this — clears the value'
              : 'A tender must keep a title'
          }
        >
          Not stated
        </MiniButton>
        {field === 'submissionDestination' && tender.submissionMethod === null && (
          <span className="text-[11px] text-[var(--text-tertiary)]">
            Set the submission method above.
          </span>
        )}
      </div>
    </fieldset>
  )
}

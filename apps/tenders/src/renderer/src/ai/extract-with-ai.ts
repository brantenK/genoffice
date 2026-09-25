// The adapter between the AI extraction core and the shapes the app persists.
//
// `shared/ai-extraction` produces *suggestions* with its own vocabulary
// (`provenance: 'ai-suggested'`, `score`, `field`/`value`, `pageNumber`). The
// persistence schema speaks a different one (`suggestedBy: 'ai'`,
// `ReviewCandidate` / `ExtractedRequirement`), and it rejects unknown keys
// document-wide, so a spread of a core object would fail the whole save. This
// module is the single translation point. The mapping is pure: no `window`, no
// model, no clock (the only time value is passed in), so it is unit-testable with
// no network and no bridge.
//
// The vision pass at the end of the file is the one exception, and it is kept
// here rather than in `transport.ts` because reading a scanned page is a property
// of the extraction pass, not of the transport: it uses the injected model calls
// and only *builds* one on the shared bridge.
//
// Two rules the code below enforces rather than documents:
//
//  1. **Provenance is stated, never inferred.** Every value that came from a
//     model is written as `suggestedBy: 'ai'`; a value the local engine read
//     keeps its own (absent = `'parser'`). A value both produced is kept as the
//     PARSER's candidate, so a model can never be credited with — or blamed for —
//     a value the rule engine read.
//  2. **Nothing here decides anything.** No function in this file can produce
//     `state: 'confirmed'`: a field the AI pass fills for the first time is
//     written as the core's single machine review state (`unconfirmed`), and a
//     field a human has already decided is only ever extended with candidates.

import type {
  AiCompletion,
  AiExtractionRun,
  AiRequirementSuggestion,
  ChunkExtractionOutcome,
  ExtractionChunking,
  ExtractionContext,
  ExtractionPageInput,
  ExtractionRejection,
  ExtractionRule,
  ExtractionRuleCatalogue,
  MetadataFieldKey,
  MergedExtraction,
  MetadataSuggestion,
} from '../../../shared/ai-extraction'
import {
  AI_SUGGESTION_REVIEW_STATE,
  buildExtractionChunks,
  buildVisionReadPrompt,
  INTAKE_METADATA_FIELDS,
  mergeExtractionChunks,
  NO_EXTRACTION_TEXT_WARNING,
  parseVisionReadReply,
  runAiExtraction,
} from '../../../shared/ai-extraction'
import { TENDER_RULES, type TenderRule } from '../../../shared/rules'
import {
  MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD,
  MAX_TENDERS_REVIEW_CONFLICTS,
} from '../../../shared/tenders-persistence'
import {
  AI_VISION_METHOD,
  pageContentObtained,
  type ExtractedRequirement,
  type IntakeVerification,
  type PageExtractionState,
  type ReviewCandidate,
  type TenderRecord,
  type ValueProvenance,
} from '../../../shared/types'
import { getProviderAdapter, modelLacksVision } from '@genoffice/ai-provider/browser'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import type { AiCompletionProgress, TendersAiBridge, TendersRequestImage } from './transport'
import { createTendersCompletion } from './transport'

/** The schema's word for "a model suggested this" — the translation of `'ai-suggested'`. */
export const AI_VALUE_PROVENANCE: ValueProvenance = 'ai'

// ── the rule catalogue ────────────────────────────────────────────────────────

/**
 * Project the app's rule catalogue into the core's `ExtractionRule` shape.
 *
 * The core takes the catalogue as a parameter (it never imports `rules.ts`) and
 * treats it as authoritative wherever it has an opinion: `validateSuggestions`
 * takes `category`, `isMandatory`, `riskLevel` and `order` from here and ignores
 * the model's values for a known key. So this mapping is what stops a model
 * promoting a general returnable to mandatory or demoting a disqualifier, and it
 * is derived from the same fields the local shredder uses (`isMandatory` mirrors
 * `shredExtraction`'s own rule).
 */
export function buildExtractionRuleCatalogue(
  rules: readonly TenderRule[] = TENDER_RULES,
): ExtractionRuleCatalogue {
  return rules.map((rule): ExtractionRule => ({
    ruleKey: rule.key,
    title: rule.title,
    category: rule.category,
    isMandatory:
      rule.category === 'MANDATORY_STAGE_1' || rule.riskLevel === 'CRITICAL_DISQUALIFIER',
    riskLevel: rule.riskLevel,
    order: rule.order,
  }))
}

/** The catalogue the AI pass is given, built from `TENDER_RULES`. */
export const AI_EXTRACTION_RULES: ExtractionRuleCatalogue = buildExtractionRuleCatalogue()

// ── per-item translation ──────────────────────────────────────────────────────

/**
 * One AI metadata suggestion as a review candidate.
 *
 * Constructed key by key: the core's `field`, `value` and `provenance` members
 * are NOT members of the schema's `ReviewCandidate` (only `value`, `sourcePage`,
 * `sourceClause`, `score`, `suggestedBy` are), so spreading would reject the
 * whole document on the next save.
 */
export function toReviewCandidate(suggestion: MetadataSuggestion): ReviewCandidate {
  return {
    value: suggestion.value,
    sourcePage: suggestion.pageNumber,
    sourceClause: suggestion.sourceClause,
    score: suggestion.score,
    suggestedBy: AI_VALUE_PROVENANCE,
  }
}

/**
 * One AI requirement suggestion as an `ExtractedRequirement`.
 *
 * Same rule as above — every member is named, and the core's `provenance` is
 * translated rather than carried. `notes` / `additionalClauses` are emitted only
 * when they have content, because an own-property `undefined` is not the same
 * thing as an absent optional member to the schema's JSON-semantics presence
 * check.
 */
export function toExtractedRequirement(suggestion: AiRequirementSuggestion): ExtractedRequirement {
  const notes = suggestion.notes?.trim() ?? ''
  const additional = suggestion.additionalClauses ?? []
  return {
    id: suggestion.id,
    ruleKey: suggestion.ruleKey,
    title: suggestion.title,
    category: suggestion.category,
    isMandatory: suggestion.isMandatory,
    verbatimClause: suggestion.verbatimClause,
    pageNumber: suggestion.pageNumber,
    boundingBox: {
      top: suggestion.boundingBox.top,
      left: suggestion.boundingBox.left,
      width: suggestion.boundingBox.width,
      height: suggestion.boundingBox.height,
    },
    riskLevel: suggestion.riskLevel,
    order: suggestion.order,
    confidence: suggestion.confidence,
    ...(notes.length > 0 ? { notes } : {}),
    ...(additional.length > 0
      ? {
          additionalClauses: additional.map((clause) => ({
            text: clause.text,
            pageNumber: clause.pageNumber,
          })),
        }
      : {}),
    suggestedBy: AI_VALUE_PROVENANCE,
  }
}

// ── the duplicate reference number ────────────────────────────────────────────

/** The tender fields the duplicate-reference check reads. */
export type ReferenceTender = Pick<TenderRecord, 'id' | 'title' | 'referenceNumber'>

export interface DuplicateReferenceCheck {
  /** The colliding reference number, or null when there is none. */
  value: string | null
  /** Titles of the tenders already carrying it. */
  tenderTitles: string[]
  /** Plain-language, actionable message for the UI; null when there is no collision. */
  message: string | null
}

/**
 * Does this reference number already belong to another tender in the workspace?
 *
 * `validateTendersDataV2` refuses the ENTIRE document when two tenders carry the
 * same non-null `referenceNumber` (see `semanticChecks` in
 * `shared/tenders-schema.ts`), so a re-imported — or AI-lifted — reference that
 * collides does not fail that one field: it fails every autosave with a
 * path-shaped schema error. Detecting it here is what turns that into a sentence
 * the user can act on.
 *
 * The comparison is exact, mirroring the schema exactly (a case-different value
 * does not collide there, so reporting one here would be a false alarm).
 */
export function checkDuplicateReference(
  value: string | null | undefined,
  tenders: readonly ReferenceTender[],
  options: { excludeTenderId?: string } = {},
): DuplicateReferenceCheck {
  const reference = typeof value === 'string' ? value.trim() : ''
  if (reference.length === 0) return { value: null, tenderTitles: [], message: null }
  const collisions = tenders.filter(
    (tender) => tender.id !== options.excludeTenderId && tender.referenceNumber === reference,
  )
  if (collisions.length === 0) return { value: null, tenderTitles: [], message: null }
  const titles = collisions.map((tender) => tender.title)
  const named = titles
    .slice(0, 3)
    .map((title) => `“${title}”`)
    .join(', ')
  return {
    value: reference,
    tenderTitles: titles,
    message:
      `Reference number “${reference}” is already on tender ${named}. Two tenders in one workspace ` +
      'cannot share a reference number, so it was kept in the extraction review instead of being ' +
      'written to this tender — confirm the right reference there, or remove the earlier import.',
  }
}

// ── the adaptation ────────────────────────────────────────────────────────────

export interface AdaptAiExtractionInput {
  merged: MergedExtraction
  /** Rule keys the tender's checklist already covers (the local engine's own finds). */
  existingRuleKeys?: readonly string[]
  /** Tenders in this workspace, for the duplicate-reference check. */
  existingTenders?: readonly ReferenceTender[]
  /** The tender being enriched, so its own reference cannot collide with itself. */
  tenderId?: string
  /**
   * What the vision pass did with the pages that had no text layer, appended to
   * `summary`. Absent (or empty) says nothing extra — a document with no scanned
   * page, or a run that never asked a model to read one.
   */
  visionSummary?: string | null
}

export interface AiExtractionAdaptation {
  /** AI candidates per intake field, strongest first, capped at the schema's per-field limit. */
  candidates: Partial<Record<MetadataFieldKey, ReviewCandidate[]>>
  /** Requirements for rules the local engine did NOT already find, in the core's order. */
  requirements: ExtractedRequirement[]
  /** Rule keys skipped because the checklist already covers them. */
  skippedRuleKeys: string[]
  /** Suggestions the core refused, with the reason, for the UI to show. */
  rejections: ExtractionRejection[]
  /** Everything else worth saying (truncated pages, chunks that failed, …). */
  warnings: string[]
  /** Pages no method obtained — these must keep blocking readiness. */
  unreadPages: number[]
  /** Non-null only when the model's strongest reference number already exists elsewhere. */
  duplicateReference: DuplicateReferenceCheck | null
  /** One honest sentence describing what the pass produced. */
  summary: string
}

function countCandidates(candidates: Partial<Record<MetadataFieldKey, ReviewCandidate[]>>): number {
  let total = 0
  for (const field of INTAKE_METADATA_FIELDS) total += candidates[field]?.length ?? 0
  return total
}

/**
 * Turn one run's merged output into the app's shapes.
 *
 * Metadata becomes candidate lists (never a persisted domain value: a candidate
 * is something the review step asks about, not something the tender claims).
 * Requirements become records for rules the local engine did not already cover —
 * one row per rule is the shape the compliance matrix expects, and the local
 * engine's own hit is the better row for a rule it found (it carries the real
 * clause box from the text layer), so a model's second sighting is reported as
 * skipped rather than added as a duplicate row.
 */
export function adaptAiExtraction(input: AdaptAiExtractionInput): AiExtractionAdaptation {
  const { merged } = input
  const candidates: Partial<Record<MetadataFieldKey, ReviewCandidate[]>> = {}
  for (const suggestion of merged.metadata) {
    const list = candidates[suggestion.field] ?? []
    if (list.length >= MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD) continue
    list.push(toReviewCandidate(suggestion))
    candidates[suggestion.field] = list
  }

  const covered = new Set(input.existingRuleKeys ?? [])
  const requirements: ExtractedRequirement[] = []
  const skippedRuleKeys: string[] = []
  for (const suggestion of merged.requirements) {
    if (covered.has(suggestion.ruleKey)) {
      skippedRuleKeys.push(suggestion.ruleKey)
      continue
    }
    covered.add(suggestion.ruleKey)
    requirements.push(toExtractedRequirement(suggestion))
  }

  const referenceCheck = checkDuplicateReference(
    candidates.referenceNumber?.[0]?.value,
    input.existingTenders ?? [],
    { excludeTenderId: input.tenderId },
  )
  const duplicateReference = referenceCheck.message === null ? null : referenceCheck

  const metadataCount = countCandidates(candidates)
  const unread = merged.unreadPages.length
  const parts = [
    `AI extraction read ${merged.pagesRead.length} of ${merged.numPages} page${merged.numPages === 1 ? '' : 's'} and suggested ${metadataCount} metadata value${metadataCount === 1 ? '' : 's'} and ${requirements.length} requirement${requirements.length === 1 ? '' : 's'} for review.`,
  ]
  if (skippedRuleKeys.length > 0) {
    parts.push(
      `${skippedRuleKeys.length} suggestion${skippedRuleKeys.length === 1 ? '' : 's'} matched a rule the local engine had already found and was not added again.`,
    )
  }
  if (merged.rejections.length > 0) {
    parts.push(
      `${merged.rejections.length} suggestion${merged.rejections.length === 1 ? '' : 's'} ${merged.rejections.length === 1 ? 'was' : 'were'} refused — see the reasons below.`,
    )
  }
  const visionSummary = input.visionSummary?.trim() ?? ''
  if (visionSummary.length > 0) parts.push(visionSummary)
  if (unread > 0) {
    parts.push(
      `${unread} page${unread === 1 ? '' : 's'} had no text layer, so no reader obtained ${unread === 1 ? 'it' : 'them'} and ${unread === 1 ? 'it still blocks' : 'they still block'} readiness.`,
    )
  }

  return {
    candidates,
    requirements,
    skippedRuleKeys,
    rejections: merged.rejections,
    warnings: merged.warnings,
    unreadPages: merged.unreadPages,
    duplicateReference,
    summary: parts.join(' '),
  }
}

// ── merging into the review annotation ────────────────────────────────────────

/** Case- and whitespace-insensitive identity for de-duplicating one value twice. */
function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Union the AI candidates into the field's existing ones.
 *
 * A value both readers produced keeps the entry it already had, so a
 * parser-extracted value is never relabelled as a model suggestion. Strongest
 * first, capped at the schema's per-field limit — an over-long list rejects the
 * whole document.
 */
export function mergeReviewCandidates(
  existing: readonly ReviewCandidate[],
  added: readonly ReviewCandidate[],
): ReviewCandidate[] {
  const seen = new Set<string>()
  const merged: ReviewCandidate[] = []
  for (const candidate of [...existing, ...added]) {
    const key = normalizeValue(candidate.value)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    merged.push(candidate)
  }
  merged.sort((a, b) => b.score - a.score)
  return merged.slice(0, MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD)
}

/**
 * Fold the AI pass into a review annotation without touching a single human
 * decision.
 *
 *  * A field a person has already decided (`state !== 'unconfirmed'`) only gains
 *    candidates.
 *  * A field the parser filled keeps its value, its page, its confidence and its
 *    (absent = parser) provenance.
 *  * A field nobody has filled yet takes the strongest AI candidate, marked
 *    `suggestedBy: 'ai'`, and is written as `unconfirmed` — the one review state
 *    a machine suggestion may carry.
 *  * New requirements are registered `unreviewed`, so they appear in the review
 *    step like every other row.
 */
export function mergeAiIntoReview(
  review: IntakeVerification,
  adaptation: AiExtractionAdaptation,
  now: string = new Date().toISOString(),
): IntakeVerification {
  const fields: IntakeVerification['fields'] = { ...review.fields }
  for (const key of INTAKE_METADATA_FIELDS) {
    const added = adaptation.candidates[key]
    if (!added || added.length === 0) continue
    const previous = review.fields?.[key]
    const candidates = mergeReviewCandidates(previous?.candidates ?? [], added)
    const parserOwned = previous !== undefined && previous.extractedValue !== null
    const decided = previous !== undefined && previous.state !== 'unconfirmed'
    if (previous && (parserOwned || decided)) {
      fields[key] = { ...previous, candidates }
      continue
    }
    const top = added[0]!
    fields[key] = {
      extractedValue: previous?.extractedValue ?? top.value,
      sourcePage: previous?.sourcePage ?? top.sourcePage,
      sourceClause: previous?.sourceClause ?? top.sourceClause,
      confidence: previous?.confidence ?? top.score,
      candidates,
      state: previous?.state ?? AI_SUGGESTION_REVIEW_STATE,
      reviewedAt: previous?.reviewedAt ?? null,
      suggestedBy: previous?.suggestedBy ?? AI_VALUE_PROVENANCE,
    }
  }

  const requirements: IntakeVerification['requirements'] = { ...review.requirements }
  for (const requirement of adaptation.requirements) {
    if (requirements[requirement.id]) continue
    requirements[requirement.id] = {
      state: 'unreviewed',
      originalTitle: null,
      originalCategory: null,
      correctedAt: null,
    }
  }

  const conflicts = [...review.conflicts]
  const duplicate = adaptation.duplicateReference?.message
  if (duplicate !== undefined && duplicate !== null && !conflicts.includes(duplicate)) {
    conflicts.push(duplicate)
  }

  return {
    ...review,
    fields,
    requirements,
    conflicts: conflicts.slice(0, MAX_TENDERS_REVIEW_CONFLICTS),
    updatedAt: now,
  }
}

// ── the vision pass: pages with no text layer ─────────────────────────────────
//
// A page the parser flagged `needsOcr` has no usable text layer, so the local
// engine never read it and it blocks readiness until something does. This is the
// something: the page's IMAGE is handed to the model the user configured, and the
// text it returns goes through the same chunk → prompt → parse → validate path as
// a page with its own text layer. One extraction path, one set of honesty rules.
//
// Three rules the code below enforces rather than documents:
//
//  1. **A page is marked read only on the model's reading of its image.** A
//     refused, empty, too-short, unrenderable or failed reading leaves the page
//     exactly as it was: still blocking. `vision.readPages` is the only source of
//     that mark.
//  2. **Only a page the parser itself flagged `needsOcr` may ever be marked.**
//     `markModelReadPages` intersects the read set with the parser's flagged set,
//     because readiness' OCR accounting is count-based: marking one page too many
//     would over-subtract and weaken the gate.
//  3. **Nothing lifted from a scanned page is confirmed.** The reading is text, so
//     everything extracted from it is a `suggestedBy: 'ai'` suggestion in
//     `unconfirmed` — the same shape as every other model suggestion.

/**
 * One page image, in the shape the provider layer's user message takes.
 *
 * The transport's own `TendersRequestImage` rather than a second, structurally
 * identical declaration: the image a vision read attaches is exactly the image
 * `createTendersCompletion` puts on its user message, so there is one shape to
 * change and no cast between two.
 */
export type AiPageImage = TendersRequestImage

/**
 * The model call for one scanned page: the page's image in, its text out.
 *
 * Deliberately not the core's `AiCompletion`: this is a different request (an
 * image plus a transcription instruction), and a caller must be able to WITHHOLD
 * it — a text-only model — rather than have the pass quietly ask a model to
 * transcribe an image it was never sent.
 */
export type AiVisionCompletion = (args: {
  system: string
  user: string
  images: readonly AiPageImage[]
  signal?: AbortSignal
}) => Promise<string>

/** The caller's reason the vision pass is off. A complete sentence, shown as-is. */
export const VISION_UNAVAILABLE_MESSAGE =
  'No model configured here can read an image, so pages without a text layer were not read by AI.'

/** Why a scanned page was not read: the run was cancelled before its turn came. */
export const VISION_CANCELLED_REASON =
  'The run was cancelled before this page’s turn came, so this page was not read.'

/**
 * Can the configured model read a scanned page's image?
 *
 * Mirrors the slides renderer's own `settingsSupportVision`: a provider whose
 * capabilities say it cannot take images, a model the catalogue knows is
 * text-only, and a provider this build cannot resolve at all are all answered
 * "no". Withholding a vision read that would fail is honest — the pages then keep
 * blocking and the caller says why — whereas attempting one that fails would
 * spend the user's tokens to learn nothing.
 */
export function settingsSupportVision(
  settings: Pick<AiSettings, 'provider' | 'providers'>,
): boolean {
  try {
    if (!getProviderAdapter(settings.provider).capabilities.vision) return false
    return !modelLacksVision(settings.providers?.[settings.provider]?.model ?? '')
  } catch {
    return false
  }
}

export interface CreateVisionCompletionOptions {
  bridge: TendersAiBridge
  settings: AiSettings
  /** Called on every delta of every page's reply, so the caller can show progress. */
  onProgress?: (progress: AiCompletionProgress) => void
  /** Injected for deterministic tests; defaults to `crypto.randomUUID()`. */
  newRequestId?: () => string
  /** Overrides the transport's reply ceiling. */
  maxChars?: number
  /** Ceiling on one page read, on a wall clock the wire cannot extend. */
  callTimeoutMs?: number
}

/**
 * Build the `AiVisionCompletion` on the suite's shared `ai:stream` bridge: one
 * request per page, carrying that page's image, bounded and cancellable by
 * exactly the rules a text chunk is.
 *
 * The image travels on the transport's own optional `images` argument — the wire
 * shape (`AiStreamRequest.messages[].images`) every provider protocol already
 * maps — so the vision read shares the text pass's single implementation of the
 * stream lifecycle (one listener, cancellation, the reply ceiling, `stopReason`)
 * and there is no decorator over the bridge to keep in step with it.
 */
export function createVisionCompletion(options: CreateVisionCompletionOptions): AiVisionCompletion {
  const { bridge, settings, ...rest } = options
  return ({ system, user, images, signal }) =>
    createTendersCompletion({ ...rest, bridge, settings })({
      system,
      user,
      images,
      ...(signal ? { signal } : {}),
    })
}

export type AiPassPhase = 'text' | 'vision-read' | 'vision-extract'

/** Progress of one step of the pass, so the caller can report it honestly. */
export interface AiPassProgress {
  phase: AiPassPhase
  /** 0-based index within the phase */
  index: number
  /** how many units the phase has (chunks, or pages for a vision read) */
  total: number
  /** the document pages this step covers */
  pageNumbers: number[]
}

// ── the run's wall-clock budget ──────────────────────────────────────────────
//
// `chunkCount × per-request latency` is the quantity nothing bounded. A 500-page
// tender is many chunks (see `buildExtractionChunks`), and against a slow or
// stalling provider each chunk's call may legitimately occupy its own absolute
// cap — so the total could run for hours with only a manual Cancel. The budget
// below is what makes the published figure the ENFORCED one:
//
//   * every single call is capped at `AI_EXTRACTION_CHUNK_BUDGET_MS` (5 minutes),
//     which is a ceiling on ONE request, not a promise about a slow one — the
//     idle watchdog and the transport's own absolute cap keep their jobs;
//   * the whole run is capped at `AI_EXTRACTION_RUN_BUDGET_MS` (15 minutes), so a
//     document of any length finishes or stops in a bounded time.
//
// What a stopped run does is decided by the same rule every other failure
// follows: the chunk that could not be sent is recorded with the reason, its
// pages stay UNREAD (so they keep blocking readiness), and everything already
// extracted is kept. The local engine's own result is untouched, and a run the
// user cancelled or a newer import superseded still applies nothing — the budget
// aborts the run's own signal, which is the path that already existed.

/** Ceiling on ONE model call. The shared transport's own absolute cap is 15 min. */
export const AI_EXTRACTION_CHUNK_BUDGET_MS = 5 * 60_000

/** Ceiling on the WHOLE run, however many chunks the document needs. */
export const AI_EXTRACTION_RUN_BUDGET_MS = 15 * 60_000

/** Why a chunk was not sent at all: the run had already spent its budget. */
export const RUN_DEADLINE_REASON = 'the run reached its time budget before this chunk was sent'

/** Why a chunk's own call was stopped: it outlived its share of the run. */
export const CHUNK_BUDGET_REASON =
  'the model call outlived its share of the run’s time budget and was stopped'

/** Why a vision read did not happen: the run had already spent its budget. */
export const VISION_DEADLINE_REASON =
  'The run reached its time budget before this page’s turn came, so this page was not read.'

/** The run reached its wall-clock budget. Reported with what it did produce. */
export function runDeadlineWarning(budgetMs: number): string {
  return `The AI extraction run reached its ${describeBudget(budgetMs)} time budget and stopped. Everything it had read up to that point is kept; the chunks it did not reach were not read by AI.`
}

/** "5 minutes" / "1 minute" / "90 seconds": the budget as a user reads it. */
function describeBudget(milliseconds: number): string {
  if (milliseconds < 60_000) {
    const seconds = Math.max(1, Math.round(milliseconds / 1_000))
    return `${seconds} second${seconds === 1 ? '' : 's'}`
  }
  const minutes = Math.round(milliseconds / 60_000)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/** A monotonically increasing reading of the wall clock, in milliseconds. */
export type TendersClock = () => number

/** A one-shot timer; `setTimeout` in production, a test's own in a test. */
export type TendersTimer = (callback: () => void, milliseconds: number) => unknown
/** Cancels a `TendersTimer`; `clearTimeout` in production. */
export type TendersClearTimer = (handle: unknown) => void

/**
 * The ceilings for one run: how long a single call may take, and how long the
 * whole run may take across every phase.
 *
 * The clock and the timer are both injected so a test can drive the deadline
 * deterministically — with a fake clock and a timer it fires on demand, a budget
 * test needs no network, no sleeping and no wall time at all.
 */
export interface AiRunBudget {
  /** Ceiling on one model call. */
  chunkBudgetMs: number
  /** Ceiling on the whole run, text chunks and vision reads together. */
  runBudgetMs: number
  /** The clock both are measured against; defaults to `Date.now`. */
  now?: TendersClock
  /** Arms the per-call deadline; defaults to `setTimeout`. */
  setTimer?: TendersTimer
  /** Cancels a timer the run no longer needs; defaults to `clearTimeout`. */
  clearTimer?: TendersClearTimer
}

type ResolvedAiRunBudget = {
  chunkBudgetMs: number
  runBudgetMs: number
  now: TendersClock
  setTimer: TendersTimer
  clearTimer: TendersClearTimer
}

export const DEFAULT_AI_RUN_BUDGET: AiRunBudget = {
  chunkBudgetMs: AI_EXTRACTION_CHUNK_BUDGET_MS,
  runBudgetMs: AI_EXTRACTION_RUN_BUDGET_MS,
}

/** A positive, finite ceiling, or the documented default. */
function resolveBudgetMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function resolveBudget(budget: AiRunBudget | undefined): ResolvedAiRunBudget {
  const now = budget?.now ?? ((): number => Date.now())
  return {
    chunkBudgetMs: resolveBudgetMs(budget?.chunkBudgetMs, AI_EXTRACTION_CHUNK_BUDGET_MS),
    runBudgetMs: resolveBudgetMs(budget?.runBudgetMs, AI_EXTRACTION_RUN_BUDGET_MS),
    now: (): number => {
      const read = now()
      return Number.isFinite(read) ? read : 0
    },
    setTimer:
      budget?.setTimer ?? ((callback, milliseconds): unknown => setTimeout(callback, milliseconds)),
    clearTimer: budget?.clearTimer ?? ((handle): void => clearTimeout(handle as never)),
  }
}

/** How the pages without a text layer are read; absent means no vision read. */
export type TenderAiPassVision =
  | {
      available: true
      completion: AiVisionCompletion
      /** Render one document page to an image; a rejection is that page's reason. */
      renderPageImage: (pageNumber: number) => Promise<AiPageImage>
      /**
       * Ceilings for the pages of a pass that has no injected budget of its own.
       * `runTenderAiPass` hands the reader the run's remaining budget, and this is
       * the fallback for a caller that builds the completion itself: one page with
       * the per-call ceiling, and two per-call ceilings for the extraction pass
       * that follows the readings — never an unbounded number of minutes.
       */
      budget?: AiRunBudget
    }
  | { available: false; reason: string }

export interface AiVisionPassSummary {
  /** pages the parser flagged `needsOcr` — the ONLY pages a read may mark */
  scannedPages: number[]
  /** pages whose image a model actually read, ascending */
  readPages: number[]
  /** pages that stayed unread, with the reason, ascending */
  unread: { pageNumber: number; reason: string }[]
  /** why no vision read was attempted at all; null when one was */
  skippedReason: string | null
  /** one honest sentence for the UI; '' when there is nothing to say */
  summary: string
}

export interface TenderAiPassInput {
  /** the text-layer model call: one request per chunk, as before */
  completion: AiCompletion
  /** the parser's own per-page read, `needsOcr` included */
  pages: readonly ExtractionPageInput[]
  numPages: number
  rules: ExtractionRuleCatalogue
  metadataFields?: readonly MetadataFieldKey[]
  fileName?: string | null
  tenderTitle?: string | null
  signal?: AbortSignal
  /** how pages without a text layer are read; absent means no vision read */
  vision?: TenderAiPassVision
  onProgress?: (progress: AiPassProgress) => void
  /**
   * The run's wall-clock ceilings. Absent means the documented defaults
   * (`AI_EXTRACTION_CHUNK_BUDGET_MS` per call, `AI_EXTRACTION_RUN_BUDGET_MS`
   * for the whole run); `now` is injected so a test can drive the clock.
   */
  budget?: AiRunBudget
}

export interface TenderAiPassResult {
  merged: MergedExtraction
  outcomes: ChunkExtractionOutcome[]
  vision: AiVisionPassSummary
}

function messageOf(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
  const text = raw.trim()
  return (text.length === 0 ? 'unknown error' : text).slice(0, 300)
}

function pagesLabel(count: number): string {
  return `${count} page${count === 1 ? '' : 's'}`
}

/** What the vision pass did, in one sentence a user can act on. */
function visionSentence(read: number, total: number, unread: number): string {
  if (read === 0) {
    return `None of the ${pagesLabel(total)} without a text layer could be read by the model, so ${total === 1 ? 'it still blocks' : 'they still block'} readiness.`
  }
  if (unread > 0) {
    return `${pagesLabel(read)} of the ${pagesLabel(total)} without a text layer were read by the model; ${pagesLabel(unread)} could not be read and still ${unread === 1 ? 'blocks' : 'block'} readiness.`
  }
  return `${pagesLabel(read)} without a text layer ${read === 1 ? 'was' : 'were'} read by the model — everything lifted from ${read === 1 ? 'it' : 'them'} is a suggestion you still have to confirm.`
}

function visionSkippedSentence(reason: string, total: number): string {
  return `${reason} ${pagesLabel(total)} ${total === 1 ? 'has' : 'have'} no text layer, so no reader obtained ${total === 1 ? 'it' : 'them'} and ${total === 1 ? 'it still blocks' : 'they still block'} readiness.`
}

interface VisionReadOutcome {
  outcomes: ChunkExtractionOutcome[]
  chunkingWarnings: string[]
  summary: AiVisionPassSummary
}

/**
 * Read every flagged page's image, then extract from what the model read.
 *
 * The reading and the extraction are two steps on purpose. The reading produces
 * the page's TEXT, which is what the extraction path already knows how to turn
 * into suggestions — and it is the reading that decides whether the page counts
 * as read, so a page whose extraction then fails is still a page whose content was
 * obtained, while a page whose reading failed is untouched.
 */
async function readScannedPages(
  input: TenderAiPassInput,
  context: ExtractionContext,
  scannedPages: readonly number[],
  chunkOffset: number,
  budget: ResolvedAiRunBudget,
  runEndsAt: number,
): Promise<VisionReadOutcome> {
  const empty: AiVisionPassSummary = {
    scannedPages: [...scannedPages],
    readPages: [],
    unread: [],
    skippedReason: null,
    summary: '',
  }
  if (scannedPages.length === 0) return { outcomes: [], chunkingWarnings: [], summary: empty }

  const vision = input.vision
  if (!vision || vision.available !== true) {
    const reason =
      vision && vision.available === false && vision.reason.trim().length > 0
        ? vision.reason.trim()
        : VISION_UNAVAILABLE_MESSAGE
    return {
      outcomes: [],
      chunkingWarnings: [],
      summary: {
        scannedPages: [...scannedPages],
        readPages: [],
        unread: scannedPages.map((pageNumber) => ({ pageNumber, reason })),
        skippedReason: reason,
        summary: visionSkippedSentence(reason, scannedPages.length),
      },
    }
  }

  const transcripts = new Map<number, string>()
  const unread: { pageNumber: number; reason: string }[] = []
  const total = scannedPages.length

  for (let index = 0; index < total; index += 1) {
    const pageNumber = scannedPages[index]!
    if (input.signal?.aborted === true) {
      for (const rest of scannedPages.slice(index)) {
        unread.push({ pageNumber: rest, reason: VISION_CANCELLED_REASON })
      }
      break
    }
    // The run's budget, checked before a page is actually asked for: the pages
    // it never reached stay unread (and keep blocking readiness) and say why,
    // exactly as a cancelled run's remaining pages do.
    if (budget.now() >= runEndsAt) {
      for (const rest of scannedPages.slice(index)) {
        unread.push({ pageNumber: rest, reason: VISION_DEADLINE_REASON })
      }
      break
    }
    input.onProgress?.({ phase: 'vision-read', index, total, pageNumbers: [pageNumber] })
    const prompt = buildVisionReadPrompt({
      pageNumber,
      numPages: input.numPages,
      fileName: input.fileName ?? null,
    })
    let image: AiPageImage
    try {
      image = await vision.renderPageImage(pageNumber)
    } catch (error) {
      unread.push({
        pageNumber,
        reason: `The page image could not be rendered (${messageOf(error)}), so no model read this page.`,
      })
      continue
    }
    let raw: string
    try {
      raw = await vision.completion({
        system: prompt.system,
        user: prompt.user,
        images: [image],
        ...(input.signal ? { signal: input.signal } : {}),
      })
    } catch (error) {
      unread.push({
        pageNumber,
        reason: `The model could not read this page (${messageOf(error)}).`,
      })
      continue
    }
    const parsed = parseVisionReadReply(raw)
    if (!parsed.ok) {
      unread.push({ pageNumber, reason: parsed.error })
      continue
    }
    transcripts.set(pageNumber, parsed.text)
  }

  const readPages = [...transcripts.keys()].sort((a, b) => a - b)
  const summary = (): AiVisionPassSummary => ({
    scannedPages: [...scannedPages],
    readPages,
    unread: [...unread].sort((a, b) => a.pageNumber - b.pageNumber),
    skippedReason: null,
    summary: visionSentence(readPages.length, total, unread.length),
  })

  if (readPages.length === 0) {
    return { outcomes: [], chunkingWarnings: [], summary: summary() }
  }

  // The model's readings are the pages' text, so they go through the SAME
  // chunking and the same extraction path a text layer would — and inside the
  // same budget: each chunk of the readings gets nothing more than what is left
  // of the run, and the pages it never reached stay unread.
  const visionChunking = buildExtractionChunks({
    pages: readPages.map((pageNumber) => ({
      pageNumber,
      text: transcripts.get(pageNumber) ?? '',
    })),
    numPages: input.numPages,
  })
  const visionOutcomes: ChunkExtractionOutcome[] = []
  for (const chunk of visionChunking.chunks) {
    const pageNumbers = chunk.pages.map((page) => page.pageNumber)
    if (input.signal?.aborted === true || budget.now() >= runEndsAt) {
      visionOutcomes.push({
        chunkIndex: chunk.index,
        pageNumbers,
        validation: null,
        error: RUN_DEADLINE_REASON,
      })
      continue
    }
    input.onProgress?.({
      phase: 'vision-extract',
      index: chunk.index,
      total: visionChunking.chunks.length,
      pageNumbers,
    })
    const remaining = Math.min(budget.chunkBudgetMs, runEndsAt - budget.now())
    const oneChunk: ExtractionChunking = {
      chunks: [chunk],
      numPages: visionChunking.numPages,
      inputPages: visionChunking.inputPages,
      textlessPages: visionChunking.textlessPages,
      truncatedPages: visionChunking.truncatedPages,
      warnings: [],
    }
    const run = await runAiExtraction({
      completion: withCallBudget(input.completion, remaining, budget),
      chunking: oneChunk,
      context,
      fileName: input.fileName ?? null,
      tenderTitle: input.tenderTitle ?? null,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    visionOutcomes.push(...run.outcomes)
  }

  return {
    // A vision chunk is stamped `ai-vision` so the merge can never record its
    // pages as `native-text` — which would claim a text layer they do not have —
    // and its indices are offset so they order after the text pass.
    outcomes: visionOutcomes.map((outcome) => ({
      ...outcome,
      chunkIndex: outcome.chunkIndex + chunkOffset,
      method: AI_VISION_METHOD,
    })),
    chunkingWarnings: visionChunking.warnings,
    summary: summary(),
  }
}

/**
 * The whole optional pass: the text chunks, then a vision read of every page the
 * parser flagged `needsOcr`, then one merge of both — all inside one wall-clock
 * budget (see `AiRunBudget`).
 *
 * Never throws for a model's sake: a failed chunk, a failed page read or the run
 * running out of time is recorded and everything else is kept, so the pass can
 * only ever ADD to what the local engine found. `merged.unreadPages` remains the
 * honest complement of what was actually read, which is what keeps an unread page
 * blocking readiness.
 *
 * The budget is enforced by aborting this run's own signal — the same path a
 * Cancel click takes — so a run that started with an abort signal is left
 * cancelled and superseded by the store: a run stopped for time applies nothing
 * either. A caller that passed no signal gets the run's budget as hard as any
 * other caller: a chunk that cannot start is a failure with its pages unread,
 * never a silently kept model value.
 */
export async function runTenderAiPass(input: TenderAiPassInput): Promise<TenderAiPassResult> {
  const budget = resolveBudget(input.budget)
  const runEndsAt = budget.now() + budget.runBudgetMs
  const context: ExtractionContext = {
    rules: input.rules,
    numPages: input.numPages,
    ...(input.metadataFields ? { metadataFields: input.metadataFields } : {}),
  }
  const flagged = new Set(
    input.pages.filter((page) => page.needsOcr === true).map((page) => page.pageNumber),
  )
  // A page the parser flagged as having no usable text layer is never sent as
  // text: its image is read, or it stays unread. Emptying the text is what makes
  // that true in the chunker's own accounting, so `textlessPages` and the
  // parser's flagged set are the same pages — and no page can be marked from a
  // text chunk that never existed.
  const chunking = buildExtractionChunks({
    pages: input.pages.map((page) =>
      flagged.has(page.pageNumber) ? { ...page, text: '', needsOcr: true } : page,
    ),
    numPages: input.numPages,
  })
  const textRun = await runChunksWithinBudget(input, budget, runEndsAt, chunking)

  // The vision reader is given the run's remaining budget, so the readings it
  // performs itself are bounded by the same clock as the text pass. The budget it
  // hands a caller that built its own completion is its own fallback (see
  // `TenderAiPassVision.budget`), which does not depend on the clock at all.
  const vision = await readScannedPages(
    {
      ...input,
      ...(input.vision?.available === true
        ? { vision: { ...input.vision, budget: input.vision.budget ?? input.budget } }
        : {}),
    },
    context,
    chunking.textlessPages.filter((page) => flagged.has(page)),
    chunking.chunks.length,
    budget,
    runEndsAt,
  )

  // The outcomes come from two chunkings — the text pass and the pass over the
  // model's readings — so both sets of chunking warnings belong to the result.
  //
  // A document with no text layer at all leaves the text chunker with nothing to
  // send, which it reports. That is true of the text pass and no longer true of
  // the run once a reading has happened, so the reading replaces it.
  const textWarnings =
    vision.summary.readPages.length > 0
      ? chunking.warnings.filter((warning) => warning !== NO_EXTRACTION_TEXT_WARNING)
      : chunking.warnings
  const mergeChunking: ExtractionChunking = {
    ...chunking,
    warnings: [...textWarnings, ...vision.chunkingWarnings],
  }
  const deadlineWarning = textRun.ranOutOfTime ? runDeadlineWarning(budget.runBudgetMs) : null
  const outcomes = [...textRun.run.outcomes, ...vision.outcomes]
  const merged = mergeExtractionChunks(outcomes, { ...context, chunking: mergeChunking })

  // The run's own sentence about its budget goes first: it explains why some
  // pages were never sent, and every other warning is read in its light.
  if (deadlineWarning !== null) merged.warnings = [deadlineWarning, ...merged.warnings]

  return { merged, outcomes, vision: vision.summary }
}

/**
 * Send the text chunks under one wall-clock budget.
 *
 * The core's own `runAiExtraction` reports the reason only in the outcome, so
 * the loop is driven from here: this is the one place that can both stop the run
 * AND tell the caller it stopped for time. Each chunk gets nothing more than the
 * run's remaining budget, so a single slow call cannot carry the run past its
 * deadline, and the deadline is re-read after every chunk (the clock is not
 * assumed to advance only inside a model call).
 *
 * Every decision the core made about a reply — parse, validate, provenance,
 * bounds — is made by it either way: the only thing this loop does differently is
 * whether the next chunk is sent at all.
 */
async function runChunksWithinBudget(
  input: TenderAiPassInput,
  budget: ResolvedAiRunBudget,
  runEndsAt: number,
  chunks: ExtractionChunking,
): Promise<{ run: AiExtractionRun; ranOutOfTime: boolean }> {
  const outcomes: ChunkExtractionOutcome[] = []
  const context: ExtractionContext = {
    rules: input.rules,
    numPages: input.numPages,
    ...(input.metadataFields ? { metadataFields: input.metadataFields } : {}),
  }
  let ranOutOfTime = false
  for (const chunk of chunks.chunks) {
    const pageNumbers = chunk.pages.map((page) => page.pageNumber)
    if (input.signal?.aborted === true) {
      outcomes.push({
        chunkIndex: chunk.index,
        pageNumbers,
        validation: null,
        error: 'the extraction was cancelled before this chunk was sent',
      })
      continue
    }
    if (budget.now() >= runEndsAt) {
      // Reported as a chunk that was never sent, which is exactly what it is:
      // its pages stay unread and keep blocking readiness.
      ranOutOfTime = true
      outcomes.push({
        chunkIndex: chunk.index,
        pageNumbers,
        validation: null,
        error: RUN_DEADLINE_REASON,
      })
      continue
    }
    input.onProgress?.({
      phase: 'text',
      index: chunk.index,
      total: chunks.chunks.length,
      pageNumbers,
    })
    const remaining = Math.min(budget.chunkBudgetMs, runEndsAt - budget.now())
    const oneChunk: ExtractionChunking = {
      chunks: [chunk],
      numPages: chunks.numPages,
      inputPages: chunks.inputPages,
      textlessPages: chunks.textlessPages,
      truncatedPages: chunks.truncatedPages,
      warnings: [],
    }
    const run = await runAiExtraction({
      completion: withCallBudget(input.completion, remaining, budget),
      chunking: oneChunk,
      context,
      fileName: input.fileName ?? null,
      tenderTitle: input.tenderTitle ?? null,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    outcomes.push(...run.outcomes)
  }

  // The merge is the core's, over this loop's outcomes: one implementation of
  // dedup, validation and the unread-page accounting for both drivers.
  const merged = mergeExtractionChunks(outcomes, { ...context, chunking: chunks })
  return { run: { merged, outcomes }, ranOutOfTime }
}

/**
 * One right of reply: a model call that cannot outlive the deadline it is given.
 *
 * The deadline is armed on the run's injected timer and measured against its
 * injected clock, so in a test it fires exactly when the test says — no sleeping,
 * no network, no wall time. The timer is what makes the ceiling real rather than
 * advisory: without it `remaining` would be a number nothing acted on.
 *
 * The call underneath is not abandoned: the transport's own per-call ceiling
 * (armed by its caller with the same figure) cancels the request in the main
 * process, so a provider cannot go on streaming into nothing. This wrapper
 * settles FIRST, with the reason a user can read, and the transport's later
 * rejection is swallowed here rather than becoming an unhandled one.
 *
 * A caller's `signal` is passed through untouched: a Cancel click must still be
 * reported as a cancellation, not as a budget stop.
 */
function withCallBudget(
  completion: AiCompletion,
  remainingMs: number,
  budget: ResolvedAiRunBudget,
): AiCompletion {
  return async (args) => {
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      let handle: unknown = null
      const finish = (outcome: { ok: true; text: string } | { ok: false; error: string }): void => {
        if (settled) return
        settled = true
        if (handle !== null) budget.clearTimer(handle)
        if (outcome.ok) resolve(outcome.text)
        else reject(new Error(outcome.error))
      }
      handle = budget.setTimer(() => finish({ ok: false, error: CHUNK_BUDGET_REASON }), remainingMs)
      void Promise.resolve(completion(args)).then(
        (text) => finish({ ok: true, text }),
        (error: unknown) => finish({ ok: false, error: messageOf(error) }),
      )
    })
  }
}

/**
 * Mark the pages a vision read actually obtained text for.
 *
 * The only function in this file that writes a page state, and it can write
 * exactly one: `ai-extracted` with `AI_VISION_METHOD`, which says the page's
 * content is available and nothing more. It never writes `native` (the page has
 * no text layer) and never `manually-reviewed` (no person read it).
 *
 * Three refusals are built in, and each one protects readiness:
 *
 *  * a page the parser did NOT flag `needsOcr` is never marked — readiness'
 *    OCR accounting is count-based, so marking an extra page would over-subtract
 *    and weaken the gate;
 *  * a page no reading produced text for is never marked — it keeps blocking;
 *  * a page whose content is already obtained (a text layer, or a human's own
 *    review) is never touched, so a model read can never displace a human one.
 */
export function markModelReadPages(
  pages: readonly PageExtractionState[],
  input: { scannedPages: readonly number[]; readPages: readonly number[] },
): PageExtractionState[] {
  const flagged = new Set(input.scannedPages)
  const obtained = new Set(input.readPages)
  return pages.map((page) => {
    if (!obtained.has(page.pageNumber)) return page
    if (!flagged.has(page.pageNumber)) return page
    if (pageContentObtained(page.state)) return page
    return {
      pageNumber: page.pageNumber,
      state: 'ai-extracted',
      method: AI_VISION_METHOD,
      confidence: page.confidence,
      reviewedAt: page.reviewedAt,
    }
  })
}

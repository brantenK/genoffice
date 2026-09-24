// AI-assisted tender extraction — the pure core.
//
// The local rule engine (`src/renderer/src/pdf/shred.ts` over `src/shared/rules.ts`)
// stays the always-available offline default. This module is the additive AI pass:
// it turns PDF page text into *suggestions* a human must still confirm, using a
// model call the caller injects.
//
// Why it is shaped this way:
//
//  * **Zero runtime dependencies.** Nothing here imports `@genoffice/ai-provider`,
//    `@genoffice/ai-search`, `node:*`, or anything else Node-only. The whole file
//    runs in a browser context and in a plain jsdom test, and it is deterministic:
//    no clock, no randomness, no locale, no `fetch`. The model call arrives as a
//    parameter (`AiCompletion`), so unit tests exercise every path with no network.
//  * **No structured-output mode exists.** `packages/ai-provider` streams text and
//    tool calls only — there is no JSON/response-format mode anywhere in the
//    provider layer (the only `response_format` uses are image-generation base64).
//    So extraction is prompt-for-strict-JSON plus defensive parsing: `buildExtractionPrompt`
//    asks for one bare JSON object, and `parseExtractionReply` never throws on a bad reply.
//  * **Reject, never repair.** `validateSuggestions` enforces exactly the bounds the
//    persistence schema (`src/shared/tenders-schema.ts`) will enforce later. A value
//    that violates one is dropped with a reason the UI can show, because a silently
//    repaired value would be a fabricated one.
//  * **No false readiness, ever.** Nothing in this module can produce a review state.
//    Suggestions carry `provenance: 'ai-suggested'` so they can never be mistaken for
//    the local parser's own extraction, and the merged result carries the single
//    review state a machine suggestion is allowed to have — `unconfirmed`.
//
// The caller owns the rule catalogue and passes it in: this module never imports
// `src/shared/rules.ts`, so the catalogue can be trimmed, extended or replaced
// without touching the extraction pipeline.

import type { BoundingBox, RequirementCategory, ReviewFieldKey, RiskLevel } from './types'

// ── the injected model call ───────────────────────────────────────────────────

/**
 * The only way this module reaches a model. A caller wraps
 * `chatForProvider`/`streamForProvider` from `@genoffice/ai-provider` (or a test
 * double) behind this signature; the pipeline never knows which.
 */
export type AiCompletion = (args: {
  system: string
  user: string
  signal?: AbortSignal
}) => Promise<string>

// ── provenance & review state ─────────────────────────────────────────────────

/** Marks a value as machine-suggested rather than parser-extracted. */
export const AI_SUGGESTION_PROVENANCE = 'ai-suggested' as const
export type SuggestionProvenance = typeof AI_SUGGESTION_PROVENANCE

/**
 * The one review state an AI suggestion may ever carry. The review layer's
 * `deriveTenderReview` hardcodes `state: 'unconfirmed'` for every field and only a
 * human action moves it — this constant exists so the extraction pipeline can state
 * that in its own return type and no consumer can read a suggestion as decided.
 */
export const AI_SUGGESTION_REVIEW_STATE = 'unconfirmed' as const

/**
 * Stamp machine provenance onto a suggestion. Additive and idempotent: it returns a
 * shallow copy, so an existing object is never mutated and a suggestion that already
 * carries the label keeps it.
 */
export function markProvenance<T extends object>(
  suggestion: T,
): T & { provenance: SuggestionProvenance } {
  return { ...suggestion, provenance: AI_SUGGESTION_PROVENANCE }
}

/** True when a value is a machine suggestion and must not be shown as parser output. */
export function isAiSuggested(value: { provenance?: unknown } | null | undefined): boolean {
  return value?.provenance === AI_SUGGESTION_PROVENANCE
}

// ── bounds ────────────────────────────────────────────────────────────────────

/**
 * Default text budget for one chunk.
 *
 * 24 000 characters is the suite's established budget for feeding document text to a
 * model (`READ_CHUNK_CHARS` in `apps/pdf/src/renderer/ai/tools.ts`, the closest
 * precedent: a page's text handed to a model for analysis). The extraction pass is
 * one call per chunk rather than a resent transcript, so the suite's larger one-shot
 * payload cap (48 000, used by docs/sheets/slides/html reads) is also defensible —
 * which is exactly why this is a parameter. 24 000 keeps the prompt comfortably inside
 * every provider's context and leaves room for the JSON reply inside the provider's
 * own output cap.
 */
export const DEFAULT_EXTRACTION_CHUNK_CHARS = 24_000

/** Confidence assumed when the model states none. Recorded as a warning, never hidden. */
export const DEFAULT_AI_CONFIDENCE = 0.5

/** Longest metadata value offered. A title/reference/date is never this long. */
export const MAX_METADATA_VALUE_CHARS = 512

/** Longest quoted source line kept. A longer quote is dropped rather than truncated. */
export const MAX_SOURCE_CLAUSE_CHARS = 2_000

/** Longest requirement title accepted. A checklist label, not a paragraph. */
export const MAX_REQUIREMENT_TITLE_CHARS = 200

/** Longest verbatim clause accepted. One quoted passage, not a page dump. */
export const MAX_REQUIREMENT_CLAUSE_CHARS = 4_000

/** Longest advisory note kept (truncated, since a note is not a validated field). */
export const MAX_REQUIREMENT_NOTES_CHARS = 500

/** Longest model-supplied requirement id accepted before it is replaced. */
export const MAX_REQUIREMENT_ID_CHARS = 128

/** Requirements accepted from one chunk. The catalogue holds 27 rules; this is headroom. */
export const MAX_REQUIREMENTS_PER_CHUNK = 64

/** Entries lifted from one array of a reply, so a hostile reply cannot flood validation. */
export const MAX_PARSED_ITEMS_PER_CHUNK = 128

/** Metadata suggestions accepted from one chunk. */
export const MAX_METADATA_SUGGESTIONS_PER_CHUNK = 64

/** Mirrors `MAX_TENDERS_REQUIREMENTS_PER_TENDER` in `src/shared/tenders-persistence.ts`. */
export const MAX_REQUIREMENTS_PER_RESULT = 5_000

/** Mirrors `MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD` in `src/shared/tenders-persistence.ts`. */
export const MAX_METADATA_CANDIDATES_PER_FIELD = 16

/** Mirrors `MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT`, held far below it. */
export const MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT = 8

// ── page input & chunking ─────────────────────────────────────────────────────

export interface ExtractionPageInput {
  pageNumber: number
  text: string
  /** true when the page has no usable text layer (OCR/vision territory) */
  needsOcr?: boolean
}

export interface ExtractionChunkingInput {
  pages: readonly ExtractionPageInput[]
  numPages: number
  /** Text budget per chunk; defaults to `DEFAULT_EXTRACTION_CHUNK_CHARS`. */
  maxChars?: number
}

export interface ExtractionChunkPage {
  pageNumber: number
  text: string
  /** true when the page's own text exceeded the budget and was cut */
  truncated: boolean
}

export interface ExtractionChunk {
  index: number
  pages: ExtractionChunkPage[]
  /** sum of the page text lengths in this chunk — never above the budget */
  chars: number
}

export interface ExtractionChunking {
  chunks: ExtractionChunk[]
  numPages: number
  /** every page number the caller supplied, sorted and de-duplicated */
  inputPages: number[]
  /** pages with no usable text layer — never sent, so they stay unread */
  textlessPages: number[]
  /** pages whose text was cut to the budget */
  truncatedPages: number[]
  warnings: string[]
}

function resolveMaxChars(maxChars: number | undefined): number {
  const resolved = maxChars ?? DEFAULT_EXTRACTION_CHUNK_CHARS
  if (!Number.isFinite(resolved) || resolved < 1) {
    throw new TypeError('maxChars must be a finite number of at least 1 character.')
  }
  return Math.floor(resolved)
}

/** The chunker's warning when a document offered no text at all to send. */
export const NO_EXTRACTION_TEXT_WARNING =
  'No page text was available, so no AI extraction request was made.'

/**
 * Split page text into chunks that each fit the character budget.
 *
 * Guarantees: a page is never split across chunks (its text is the unit of context a
 * bounding box and a page number refer to); page numbers survive verbatim; a page
 * larger than the whole budget is truncated to the budget and reported in
 * `truncatedPages` rather than silently dropped. Pages with no text layer are never
 * sent — they are recorded in `textlessPages` so the caller can route them to a
 * vision pass and so an unread page keeps blocking readiness.
 */
export function buildExtractionChunks(input: ExtractionChunkingInput): ExtractionChunking {
  const maxChars = resolveMaxChars(input.maxChars)
  const numPages = Number.isFinite(input.numPages) ? Math.max(0, Math.floor(input.numPages)) : 0
  const warnings: string[] = []
  const inputPages: number[] = []
  const textlessPages: number[] = []
  const truncatedPages: number[] = []
  const chunks: ExtractionChunk[] = []

  const seen = new Set<number>()
  const usable: ExtractionChunkPage[] = []
  const ordered = [...input.pages].sort((a, b) => a.pageNumber - b.pageNumber)

  for (const page of ordered) {
    const pageNumber = page.pageNumber
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      warnings.push(`Ignored a page entry with an invalid page number (${String(pageNumber)}).`)
      continue
    }
    if (numPages > 0 && pageNumber > numPages) {
      warnings.push(`Ignored page ${pageNumber}: the document has ${numPages} page(s).`)
      continue
    }
    if (seen.has(pageNumber)) {
      warnings.push(`Ignored a duplicate entry for page ${pageNumber}.`)
      continue
    }
    seen.add(pageNumber)
    inputPages.push(pageNumber)

    const text = page.text ?? ''
    if (text.trim().length === 0) {
      textlessPages.push(pageNumber)
      continue
    }
    if (text.length > maxChars) {
      truncatedPages.push(pageNumber)
      warnings.push(
        `Page ${pageNumber} holds ${text.length} characters, more than the ${maxChars}-character budget, so only its first ${maxChars} characters were sent to the model.`,
      )
      usable.push({ pageNumber, text: text.slice(0, maxChars), truncated: true })
      continue
    }
    usable.push({ pageNumber, text, truncated: false })
  }

  let current: ExtractionChunkPage[] = []
  let currentChars = 0
  const flush = (): void => {
    if (current.length === 0) return
    chunks.push({ index: chunks.length, pages: current, chars: currentChars })
    current = []
    currentChars = 0
  }
  for (const page of usable) {
    // A page is never split, so a page that would overflow starts the next chunk
    // instead. A truncated page always fills a chunk on its own.
    if (current.length > 0 && currentChars + page.text.length > maxChars) flush()
    current.push(page)
    currentChars += page.text.length
  }
  flush()

  if (chunks.length === 0) {
    warnings.push(NO_EXTRACTION_TEXT_WARNING)
  }

  return { chunks, numPages, inputPages, textlessPages, truncatedPages, warnings }
}

// ── rule catalogue & metadata fields ──────────────────────────────────────────

/**
 * One entry of the known rule catalogue, as handed to the model.
 *
 * Callers build this from `TENDER_RULES` in `src/shared/rules.ts`:
 *
 * ```ts
 * { ruleKey: rule.key, title: rule.title, category: rule.category,
 *   isMandatory: rule.category === 'MANDATORY_STAGE_1' || rule.riskLevel === 'CRITICAL_DISQUALIFIER',
 *   riskLevel: rule.riskLevel, order: rule.order }
 * ```
 *
 * The catalogue is authoritative wherever it has an opinion: `validateSuggestions`
 * takes `category`, `isMandatory`, `riskLevel` and `order` from it and ignores the
 * model's values for a known key, so a model can never promote a general returnable
 * to mandatory or demote a disqualifier.
 */
export interface ExtractionRule {
  ruleKey: string
  title: string
  category: RequirementCategory
  isMandatory: boolean
  riskLevel?: RiskLevel
  order?: number
}

export type ExtractionRuleCatalogue = readonly ExtractionRule[]

/**
 * The six intake-critical tender metadata fields — must stay identical to
 * `INTAKE_CRITICAL_REVIEW_FIELDS` in `./types` (pinned by the test, since a
 * `const` cannot be re-exported through a type-only import). `contactEmail` and
 * `estimatedValue` are deliberately excluded: they are review-scoped and gate nothing.
 */
export type MetadataFieldKey = Extract<
  ReviewFieldKey,
  | 'title'
  | 'referenceNumber'
  | 'issuingBody'
  | 'closingDate'
  | 'submissionMethod'
  | 'submissionDestination'
>

export const INTAKE_METADATA_FIELDS: readonly MetadataFieldKey[] = [
  'title',
  'referenceNumber',
  'issuingBody',
  'closingDate',
  'submissionMethod',
  'submissionDestination',
]

// ── contexts ──────────────────────────────────────────────────────────────────

export interface ExtractionContext {
  rules: ExtractionRuleCatalogue
  numPages: number
  /** Metadata fields the model may suggest; defaults to `INTAKE_METADATA_FIELDS`. */
  metadataFields?: readonly MetadataFieldKey[]
}

export interface ExtractionPromptContext extends ExtractionContext {
  fileName?: string | null
  tenderTitle?: string | null
  chunkIndex?: number
  chunkCount?: number
}

export interface ExtractionPrompt {
  system: string
  user: string
}

/**
 * Deliberately context-light: parsing runs before any judgement about the document,
 * so it makes no claim about whether a rule key exists or a page number is real —
 * `validateSuggestions` owns that. The chunk is carried so a parsed reply can be
 * attributed to the page range the model actually saw.
 */
export interface ExtractionParseContext {
  chunk?: ExtractionChunk
}

// ── suggestions ───────────────────────────────────────────────────────────────

export interface MetadataSuggestion {
  field: MetadataFieldKey
  value: string
  /** null when the model gave no page — offered without a citation, never invented */
  pageNumber: number | null
  sourceClause: string | null
  /** the model's own 0–1 confidence, or null when it stated none */
  confidence: number | null
  /** 0–1 ranking strength within the field, raised by corroboration across pages */
  score: number
  provenance?: SuggestionProvenance
}

export interface AiRequirementSuggestion {
  id: string
  ruleKey: string
  title: string
  category: RequirementCategory
  isMandatory: boolean
  verbatimClause: string
  pageNumber: number
  boundingBox: BoundingBox
  riskLevel: RiskLevel
  order: number
  confidence: number
  notes?: string
  additionalClauses?: { text: string; pageNumber: number }[]
  provenance?: SuggestionProvenance
}

// ── prompt ────────────────────────────────────────────────────────────────────

function ruleTable(rules: ExtractionRuleCatalogue): string {
  if (rules.length === 0) return '(the catalogue is empty — report no requirements)'
  const lines = ['ruleKey | title | category | mandatory']
  for (const rule of rules) {
    const title = rule.title.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
    lines.push(`${rule.ruleKey} | ${title} | ${rule.category} | ${rule.isMandatory ? 'yes' : 'no'}`)
  }
  return lines.join('\n')
}

/**
 * Build the `{ system, user }` pair for one chunk.
 *
 * The system prompt carries the strict-JSON contract (the provider layer has no JSON
 * mode, so the format has to be asked for in words) and the whole known rule
 * catalogue, so the model maps findings onto *known* keys instead of inventing keys
 * that no vault document could ever match. It also states the honesty rules: values
 * are copied verbatim, page numbers and boxes must be real, and everything returned
 * is a suggestion a human confirms.
 */
export function buildExtractionPrompt(
  chunk: ExtractionChunk,
  context: ExtractionPromptContext,
): ExtractionPrompt {
  const fields = context.metadataFields ?? INTAKE_METADATA_FIELDS
  const system = [
    'You extract structured data from South African tender (RFP) documents for a bid-compliance tool.',
    'You are a SUGGESTION engine. A human reviews and confirms every value you return. Never state or imply that anything is confirmed, approved, compliant or ready.',
    '',
    'Reply with ONE strict JSON object and nothing else. No markdown, no code fences, no commentary before or after, no trailing commas, no comments, no keys other than the ones below. Every number must be a JSON number, not a string. If you find nothing, reply with empty arrays.',
    '',
    'Shape:',
    '{',
    '  "metadata": [',
    `    { "field": ${fields.map((f) => `"${f}"`).join(' | ')}, "value": "text copied verbatim from the page", "pageNumber": 1, "sourceClause": "the line it came from", "confidence": 0.0 }`,
    '  ],',
    '  "requirements": [',
    '    { "ruleKey": "one key from the catalogue below", "title": "short checklist label", "verbatimClause": "the sentence that requires it", "pageNumber": 1, "boundingBox": { "top": 0.0, "left": 0.0, "width": 0.0, "height": 0.0 }, "confidence": 0.0, "notes": "" }',
    '  ],',
    '  "warnings": ["anything you could not read or were unsure about"]',
    '}',
    '',
    `Metadata fields you may suggest — use these exact field names and nothing else: ${fields.join(', ')}.`,
    '- "value" must be copied verbatim from the page text. Never paraphrase, normalise, translate or guess.',
    '- "submissionMethod" must be one of PHYSICAL, ELECTRONIC, EMAIL.',
    '- Use null for "pageNumber", "sourceClause" or "confidence" when you genuinely do not know; never invent one.',
    '',
    'Rules for requirements:',
    '- "ruleKey" MUST be one of the keys in the catalogue below. Never invent a key, never translate a key, never use a title as a key.',
    '- "title" is a short label for the checklist, at most 200 characters.',
    '- "verbatimClause" is the sentence or line from the page that imposes the requirement, copied verbatim, at most 4000 characters. Do not summarise it.',
    '- Report a rule once. Do not repeat the same ruleKey for the same requirement.',
    `- "pageNumber" must be a real page of this document: an integer from 1 to ${context.numPages}.`,
    '- "boundingBox" gives the location of the clause as fractions of the page: "left" and "width" are horizontal, "top" and "height" are vertical, each between 0 and 1, with left+width at most 1 and top+height at most 1. Use 0 for all four when you cannot locate it.',
    '- "confidence" is your own 0–1 confidence that the clause really imposes that requirement. Be conservative.',
    '',
    `Known rule catalogue (${context.rules.length} keys):`,
    ruleTable(context.rules),
  ].join('\n')

  const header: string[] = []
  if (context.fileName) header.push(`Document: ${context.fileName}`)
  if (context.tenderTitle) header.push(`Tender title hint: ${context.tenderTitle}`)
  const pageNumbers = chunk.pages.map((page) => page.pageNumber)
  const range =
    pageNumbers.length === 0
      ? 'no pages'
      : pageNumbers.length === 1
        ? `page ${pageNumbers[0]}`
        : `pages ${pageNumbers[0]}–${pageNumbers[pageNumbers.length - 1]}`
  const position =
    context.chunkIndex !== undefined && context.chunkCount !== undefined
      ? ` This is chunk ${context.chunkIndex + 1} of ${context.chunkCount}.`
      : ''
  header.push(
    `Extract from ${range} of ${context.numPages} (page numbers below are the document's own page numbers).${position}`,
  )

  const body = chunk.pages.map((page) => `--- PAGE ${page.pageNumber} ---\n${page.text}`)
  const user = [
    ...header,
    '',
    ...body,
    '',
    'Reply with the single JSON object described in your instructions, and nothing else.',
  ].join('\n')

  return { system, user }
}

// ── defensive parsing ─────────────────────────────────────────────────────────

export interface ParsedMetadataSuggestion {
  field: string
  value: string
  pageNumber: number | null
  sourceClause: string | null
  confidence: number | null
}

export interface ParsedRequirementSuggestion {
  id: string | null
  ruleKey: string
  title: string
  verbatimClause: string
  pageNumber: number | null
  boundingBox: BoundingBox | null
  /** true when a box was supplied that was not four finite numbers */
  boundingBoxMalformed: boolean
  category: string | null
  isMandatory: boolean | null
  riskLevel: string | null
  confidence: number | null
  notes: string | null
}

export interface ParsedExtractionReply {
  metadata: ParsedMetadataSuggestion[]
  requirements: ParsedRequirementSuggestion[]
  /** things the model said it was unsure about, plus structural junk that was dropped */
  warnings: string[]
  /** page numbers of the chunk this reply answers (empty when no chunk was supplied) */
  pageNumbers: number[]
  chunkIndex: number | null
}

export type ParseExtractionResult =
  { ok: true; reply: ParsedExtractionReply } | { ok: false; error: string }

const ENVELOPE_KEYS = ['extraction', 'result', 'data', 'output', 'response'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Strings, plus the numbers/booleans a model sometimes writes where text belongs. */
function readTextLike(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null
}

/** Tolerates `"0.8"` as well as `0.8`; a non-finite or unparseable value is absent. */
function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readInteger(value: unknown): number | null {
  const parsed = readNumber(value)
  return parsed === null || !Number.isInteger(parsed) ? null : parsed
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === 'yes') return true
    if (text === 'false' || text === 'no') return false
  }
  return null
}

function messageOf(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
  const text = raw.trim()
  return (text.length === 0 ? 'unknown error' : text).slice(0, 300)
}

/**
 * The first balanced `{...}` in the text, string-literal aware, so braces inside a
 * quoted clause cannot unbalance the scan. Returns null when there is no complete
 * object (e.g. a reply truncated mid-JSON).
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

/** Drop `,` immediately before `}`/`]` outside string literals — the commonest model slip. */
function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === ',') {
      let lookahead = index + 1
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1
      if (text[lookahead] === '}' || text[lookahead] === ']') continue
    }
    out += char
  }
  return out
}

function readJsonValue(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const attempts: string[] = [text]
  const balanced = firstBalancedObject(text)
  if (balanced !== null && balanced !== text) attempts.push(balanced)
  const brace = text.indexOf('{')
  if (brace > 0) attempts.push(text.slice(brace))

  let lastError = 'the reply was not valid JSON'
  for (const attempt of attempts) {
    for (const candidate of [attempt, stripTrailingCommas(attempt)]) {
      try {
        return { ok: true, value: JSON.parse(candidate) }
      } catch (error) {
        lastError = messageOf(error)
      }
    }
  }
  return { ok: false, error: lastError }
}

/** `{ "extraction": {...} }` and friends: unwrap one level when the wrapper holds the payload. */
function unwrapEnvelope(root: Record<string, unknown>): Record<string, unknown> | null {
  if ('requirements' in root || 'metadata' in root) return null
  for (const key of ENVELOPE_KEYS) {
    const inner = root[key]
    if (isPlainObject(inner) && ('requirements' in inner || 'metadata' in inner)) return inner
  }
  return null
}

function readBoundingBox(value: unknown): BoundingBox | null {
  if (!isPlainObject(value)) return null
  const top = readNumber(value.top)
  const left = readNumber(value.left)
  const width = readNumber(value.width)
  const height = readNumber(value.height)
  if (top === null || left === null || width === null || height === null) return null
  return { top, left, width, height }
}

function liftMetadata(
  entry: unknown,
  index: number,
  warnings: string[],
): ParsedMetadataSuggestion | null {
  if (!isPlainObject(entry)) {
    warnings.push(`metadata[${index}] was not a JSON object and was ignored.`)
    return null
  }
  const field = readString(entry.field) ?? readString(entry.key) ?? readString(entry.name)
  const value = readTextLike(entry.value) ?? readTextLike(entry.text)
  if (field === null || field.trim().length === 0 || value === null) {
    warnings.push(`metadata[${index}] had no field/value pair and was ignored.`)
    return null
  }
  return {
    field: field.trim(),
    value: value.trim(),
    pageNumber: readInteger(entry.pageNumber) ?? readInteger(entry.page) ?? null,
    sourceClause: readString(entry.sourceClause) ?? readString(entry.clause) ?? null,
    confidence: readNumber(entry.confidence),
  }
}

function liftRequirement(
  entry: unknown,
  index: number,
  warnings: string[],
): ParsedRequirementSuggestion | null {
  if (!isPlainObject(entry)) {
    warnings.push(`requirements[${index}] was not a JSON object and was ignored.`)
    return null
  }
  const box = entry.boundingBox
  const boundingBox = readBoundingBox(box)
  return {
    id: readString(entry.id),
    // An absent or unusable key is kept as an empty string so validation rejects it
    // with a reason the UI can show, rather than the item vanishing here.
    ruleKey: (
      readString(entry.ruleKey) ??
      readString(entry.key) ??
      readString(entry.rule) ??
      ''
    ).trim(),
    title: (readTextLike(entry.title) ?? '').trim(),
    verbatimClause: (readTextLike(entry.verbatimClause) ?? readTextLike(entry.clause) ?? '').trim(),
    pageNumber: readInteger(entry.pageNumber) ?? readInteger(entry.page) ?? null,
    boundingBox,
    boundingBoxMalformed: box !== undefined && box !== null && boundingBox === null,
    category: readString(entry.category),
    isMandatory: readBoolean(entry.isMandatory),
    riskLevel: readString(entry.riskLevel),
    confidence: readNumber(entry.confidence),
    notes: (readTextLike(entry.notes) ?? '').trim() || null,
  }
}

function readArray(
  value: unknown,
  name: string,
): { ok: true; items: unknown[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, items: [] }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: `The model reply's "${name}" was a JSON ${typeof value}; an array was expected.`,
    }
  }
  return { ok: true, items: value }
}

function readModelWarnings(value: unknown, warnings: string[]): void {
  if (typeof value === 'string') {
    if (value.trim().length > 0) warnings.push(value.trim())
    return
  }
  if (!Array.isArray(value)) return
  for (const entry of value) {
    const text = readTextLike(entry)
    if (text !== null && text.trim().length > 0) warnings.push(text.trim())
  }
}

/**
 * Turn a raw model reply into a typed result, or a reason it could not be read.
 *
 * Never throws: every failure is a `{ ok: false, error }` the caller can log and show.
 * Tolerates markdown fences, prose before/after the object, a trailing comma, numeric
 * strings where numbers belong, and one level of envelope (`{ "extraction": {...} }`).
 * Structural junk inside an otherwise good reply is dropped with a warning; anything
 * that violates a real bound is left for `validateSuggestions` to reject with a reason.
 */
export function parseExtractionReply(
  raw: string,
  context: ExtractionParseContext = {},
): ParseExtractionResult {
  const pageNumbers = context.chunk ? context.chunk.pages.map((page) => page.pageNumber) : []
  const chunkIndex = context.chunk ? context.chunk.index : null
  const empty: ParsedExtractionReply = {
    metadata: [],
    requirements: [],
    warnings: [],
    pageNumbers,
    chunkIndex,
  }

  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) {
    return { ok: false, error: 'The model returned an empty reply.' }
  }

  const json = readJsonValue(text)
  if (!json.ok) {
    return { ok: false, error: `The model reply was not valid JSON (${json.error}).` }
  }
  if (Array.isArray(json.value)) {
    return {
      ok: false,
      error: 'The model reply was a JSON array; a single JSON object was expected.',
    }
  }
  if (!isPlainObject(json.value)) {
    return {
      ok: false,
      error: `The model reply was a JSON ${typeof json.value}; a single JSON object was expected.`,
    }
  }

  const root = unwrapEnvelope(json.value) ?? json.value
  const warnings: string[] = []
  readModelWarnings(root.warnings, warnings)
  readModelWarnings(root.notes, warnings)

  const metadataRaw = readArray(root.metadata, 'metadata')
  if (!metadataRaw.ok) return { ok: false, error: metadataRaw.error }
  const requirementsRaw = readArray(root.requirements, 'requirements')
  if (!requirementsRaw.ok) return { ok: false, error: requirementsRaw.error }

  const metadata: ParsedMetadataSuggestion[] = []
  metadataRaw.items.slice(0, MAX_PARSED_ITEMS_PER_CHUNK).forEach((entry, index) => {
    const lifted = liftMetadata(entry, index, warnings)
    if (lifted) metadata.push(lifted)
  })
  if (metadataRaw.items.length > MAX_PARSED_ITEMS_PER_CHUNK) {
    warnings.push(
      `The reply listed ${metadataRaw.items.length} metadata suggestions; only the first ${MAX_PARSED_ITEMS_PER_CHUNK} were read.`,
    )
  }

  const requirements: ParsedRequirementSuggestion[] = []
  requirementsRaw.items.slice(0, MAX_PARSED_ITEMS_PER_CHUNK).forEach((entry, index) => {
    const lifted = liftRequirement(entry, index, warnings)
    if (lifted) requirements.push(lifted)
  })
  if (requirementsRaw.items.length > MAX_PARSED_ITEMS_PER_CHUNK) {
    warnings.push(
      `The reply listed ${requirementsRaw.items.length} requirements; only the first ${MAX_PARSED_ITEMS_PER_CHUNK} were read.`,
    )
  }

  return { ok: true, reply: { metadata, requirements, warnings, pageNumbers, chunkIndex } }
}

// ── the vision read ───────────────────────────────────────────────────────────

/**
 * The exact marker the vision prompt asks for when a page's image cannot be
 * read.
 *
 * An explicit refusal protocol beats inferring a failure from the reply's shape:
 * a model that cannot read a page must be able to say so, and
 * `parseVisionReadReply` turns that answer into a failure instead of a page's
 * text. Marking a page read is what stops it blocking readiness, so a refusal
 * that arrived as prose would be the one way a model could clear the page gate
 * without having read anything.
 */
export const VISION_UNREADABLE_MARKER = 'UNREADABLE'

/**
 * Fewest non-whitespace characters a model's reading must hold to count as a
 * page's content.
 *
 * 20 is not arbitrary: `extractSinglePage` (renderer `pdf/extract.ts`) flags a
 * page `needsOcr` at exactly this threshold, so a reading that is itself below
 * it has produced no more usable text than the text layer it replaces — and the
 * page must keep blocking rather than be recorded as read.
 */
export const MIN_VISION_TRANSCRIPT_CHARS = 20

export interface VisionReadPromptContext {
  pageNumber: number
  numPages: number
  fileName?: string | null
}

/**
 * Build the `{ system, user }` pair that asks a model to read one scanned page's
 * image.
 *
 * Deliberately a TRANSCRIPTION request and not an extraction request: the text it
 * returns is the page's text, which then goes through the same chunk → prompt →
 * parse → validate path as a page that carries its own text layer. That keeps one
 * extraction path — and one set of honesty rules — for both kinds of page, and it
 * keeps the model's reading reviewable in its own right instead of arriving
 * already digested into suggestions.
 */
export function buildVisionReadPrompt(context: VisionReadPromptContext): ExtractionPrompt {
  const system = [
    'You read one scanned page of a South African tender (RFP) document for a bid-compliance tool. The page has no text layer, so it reaches you as an image.',
    '',
    'Transcribe the page’s text EXACTLY as it appears, in reading order.',
    '- Reply with the page’s text and nothing else: no preamble, no commentary, no summary, no markdown, no code fences, no translation.',
    '- Copy every character verbatim. Never paraphrase, tidy, complete, correct or translate anything, and never add a value the page does not show.',
    '- Keep the page’s own line breaks and its own language.',
    '- Where a word is genuinely illegible, write [illegible] in its place. Do not guess it.',
    `- If the image is not a readable page of text — it is blank, corrupt, or you cannot make out its content — reply with exactly ${VISION_UNREADABLE_MARKER} and nothing else.`,
  ].join('\n')

  const header: string[] = []
  if (context.fileName) header.push(`Document: ${context.fileName}`)
  header.push(`The attached image is page ${context.pageNumber} of ${context.numPages}.`)

  const user = [
    ...header,
    '',
    'Transcribe this page’s text exactly, and reply with the text only.',
  ].join('\n')

  return { system, user }
}

export type ParseVisionReadResult = { ok: true; text: string } | { ok: false; error: string }

/** A reply wrapped in a code fence, with or without a language tag. */
function stripCodeFence(text: string): string {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text.trim())
  return match && match[1] !== undefined ? match[1].trim() : text
}

/**
 * A reply that wrapped the page's text in an object (`{ "text": "…" }`).
 *
 * Only a reply that is *entirely* one JSON object is unwrapped, so a page whose
 * own text happens to contain JSON is left alone.
 */
function unwrapTranscript(text: string): string {
  const json = readJsonValue(text)
  if (!json.ok || !isPlainObject(json.value)) return text
  for (const key of ['text', 'transcript', 'pageText', 'content']) {
    const value = json.value[key]
    if (typeof value === 'string') return value
  }
  return text
}

/**
 * Turn a model's reply to a vision read into the page's text, or a reason the page
 * was not read.
 *
 * Never throws, and never repairs: a refusal (`UNREADABLE`), an empty reply, or a
 * reading too short to be a page's content is a FAILURE, not text. The caller
 * marks a page read only on `ok`, so anything less than the page's content leaves
 * the page blocking readiness exactly as it did before.
 */
export function parseVisionReadReply(raw: string): ParseVisionReadResult {
  const reply = typeof raw === 'string' ? stripCodeFence(raw.trim()) : ''
  if (reply.length === 0) {
    return { ok: false, error: 'The model returned an empty reading of the page.' }
  }
  const text = unwrapTranscript(reply).trim()
  if (text.length === 0) {
    return { ok: false, error: 'The model returned an empty reading of the page.' }
  }
  const refusal = new RegExp(
    `^[\\s"'\`\\[({]*${VISION_UNREADABLE_MARKER}[\\s"'\`\\])}]*[.!]?$`,
    'i',
  )
  if (refusal.test(text)) {
    return {
      ok: false,
      error: 'The model reported that it could not read the page image, so the page was not read.',
    }
  }
  const chars = text.replace(/\s+/g, '').length
  if (chars < MIN_VISION_TRANSCRIPT_CHARS) {
    return {
      ok: false,
      error: `The model’s reading held only ${chars} character${chars === 1 ? '' : 's'} of text, fewer than the ${MIN_VISION_TRANSCRIPT_CHARS} a readable page needs, so the page was not read.`,
    }
  }
  return { ok: true, text }
}

// ── validation ────────────────────────────────────────────────────────────────

export type ExtractionRejectionCode =
  | 'MALFORMED_ITEM'
  | 'UNKNOWN_RULE_KEY'
  | 'PAGE_MISSING'
  | 'PAGE_OUT_OF_RANGE'
  | 'BOUNDING_BOX_INVALID'
  | 'CONFIDENCE_OUT_OF_RANGE'
  | 'DUPLICATE_REQUIREMENT_ID'
  | 'EMPTY_TITLE'
  | 'TITLE_TOO_LONG'
  | 'CLAUSE_TOO_LONG'
  | 'METADATA_FIELD_NOT_ALLOWED'
  | 'METADATA_VALUE_EMPTY'
  | 'METADATA_VALUE_TOO_LONG'
  | 'REQUIREMENT_LIMIT_EXCEEDED'
  | 'METADATA_LIMIT_EXCEEDED'

/** One suggestion that was not offered, with a plain-language reason the UI can show. */
export interface ExtractionRejection {
  kind: 'requirement' | 'metadata'
  /** stable label, e.g. `requirements[2].boundingBox` */
  path: string
  code: ExtractionRejectionCode
  reason: string
  value?: string
}

export interface ValidationResult {
  metadata: MetadataSuggestion[]
  requirements: AiRequirementSuggestion[]
  rejections: ExtractionRejection[]
  /** things worth telling the user that are not rejections (e.g. a missing box) */
  warnings: string[]
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Case- and whitespace-insensitive identity for de-duplicating the same value twice. */
function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function readRiskLevel(value: string | null): RiskLevel | null {
  return value === 'CRITICAL_DISQUALIFIER' || value === 'POINT_SCORED' || value === 'INFORMATIONAL'
    ? value
    : null
}

/**
 * Enforce every bound the persistence schema will enforce, and reject rather than
 * repair. A repaired value is a fabricated one: the user would be asked to confirm
 * something the document never said.
 *
 * Rejected outright: a requirement page outside `1..numPages` (or missing), a
 * `ruleKey` not in the catalogue — an unknown key silently breaks vault matching
 * downstream, because gap analysis resolves evidence through `RULE_BY_KEY` and would
 * find nothing to suggest for a rule it has never heard of — a bounding box whose
 * members leave `0..1` or whose `left+width`/`top+height` exceeds 1, a `confidence`
 * outside `0..1`, a duplicate requirement id, an empty or over-long title, an
 * over-long verbatim clause, and any metadata field outside the six intake-critical
 * ones.
 *
 * Not repaired but not rejected either: an absent box or confidence becomes the
 * schema's zero box / the documented default and is *reported*, never presented as a
 * located source.
 *
 * The bounding-box extent check is exact, with no floating-point epsilon: the schema
 * compares exactly too, so accepting a box the schema would reject would corrupt the
 * whole persisted document on the next save.
 */
export function validateSuggestions(
  reply: ParsedExtractionReply,
  context: ExtractionContext,
): ValidationResult {
  const numPages = Number.isFinite(context.numPages) ? Math.max(0, Math.floor(context.numPages)) : 0
  const allowedFields = new Set<string>(context.metadataFields ?? INTAKE_METADATA_FIELDS)
  const byRuleKey = new Map<string, { rule: ExtractionRule; index: number }>()
  context.rules.forEach((rule, index) => {
    if (!byRuleKey.has(rule.ruleKey)) byRuleKey.set(rule.ruleKey, { rule, index })
  })

  const rejections: ExtractionRejection[] = []
  const warnings: string[] = []
  const metadata: MetadataSuggestion[] = []
  const requirements: AiRequirementSuggestion[] = []
  const seenMetadata = new Set<string>()
  const usedIds = new Set<string>()
  let missingConfidenceNoted = false

  reply.metadata.forEach((item, index) => {
    const path = `metadata[${index}]`
    if (!allowedFields.has(item.field)) {
      rejections.push({
        kind: 'metadata',
        path: `${path}.field`,
        code: 'METADATA_FIELD_NOT_ALLOWED',
        reason: `"${item.field || '(empty)'}" is not one of the six intake-critical tender fields, so it was not offered for review.`,
        value: item.field,
      })
      return
    }
    const value = item.value.trim()
    if (value.length === 0) {
      rejections.push({
        kind: 'metadata',
        path: `${path}.value`,
        code: 'METADATA_VALUE_EMPTY',
        reason: 'The suggested value was blank, so there was nothing to confirm.',
      })
      return
    }
    if (value.length > MAX_METADATA_VALUE_CHARS) {
      rejections.push({
        kind: 'metadata',
        path: `${path}.value`,
        code: 'METADATA_VALUE_TOO_LONG',
        reason: `The suggested value is ${value.length} characters long; a tender field value is capped at ${MAX_METADATA_VALUE_CHARS}.`,
      })
      return
    }
    if (item.pageNumber !== null && (item.pageNumber < 1 || item.pageNumber > numPages)) {
      rejections.push({
        kind: 'metadata',
        path: `${path}.pageNumber`,
        code: 'PAGE_OUT_OF_RANGE',
        reason: `Page ${item.pageNumber} does not exist in this document (1–${numPages}), so the citation could not be real.`,
        value: String(item.pageNumber),
      })
      return
    }
    if (item.confidence !== null && (item.confidence < 0 || item.confidence > 1)) {
      rejections.push({
        kind: 'metadata',
        path: `${path}.confidence`,
        code: 'CONFIDENCE_OUT_OF_RANGE',
        reason: `Confidence ${item.confidence} is outside 0–1.`,
        value: String(item.confidence),
      })
      return
    }
    if (metadata.length >= MAX_METADATA_SUGGESTIONS_PER_CHUNK) {
      rejections.push({
        kind: 'metadata',
        path,
        code: 'METADATA_LIMIT_EXCEEDED',
        reason: `One chunk may not add more than ${MAX_METADATA_SUGGESTIONS_PER_CHUNK} metadata suggestions; this one was not offered.`,
      })
      return
    }
    if (item.pageNumber === null) {
      warnings.push(
        `${path} ("${value}") came with no source page, so it is offered without a page reference.`,
      )
    }
    const clause = item.sourceClause === null ? null : item.sourceClause.trim()
    const usableClause =
      clause === null || clause.length === 0
        ? null
        : clause.length > MAX_SOURCE_CLAUSE_CHARS
          ? null
          : clause
    if (clause !== null && usableClause === null && clause.length > MAX_SOURCE_CLAUSE_CHARS) {
      warnings.push(
        `${path}: the quoted source line was ${clause.length} characters long and was dropped rather than cut short.`,
      )
    }

    const key = `${item.field}\u0000${normalizeValue(value)}`
    if (seenMetadata.has(key)) return
    seenMetadata.add(key)

    metadata.push(
      markProvenance({
        field: item.field as MetadataFieldKey,
        value,
        pageNumber: item.pageNumber,
        sourceClause: usableClause,
        confidence: item.confidence,
        score: clamp01(item.confidence ?? DEFAULT_AI_CONFIDENCE),
      }),
    )
  })

  reply.requirements.forEach((item, index) => {
    const path = `requirements[${index}]`
    const found = byRuleKey.get(item.ruleKey)
    if (!found) {
      rejections.push({
        kind: 'requirement',
        path: `${path}.ruleKey`,
        code: 'UNKNOWN_RULE_KEY',
        reason: `"${item.ruleKey || '(empty)'}" is not a known rule key. An unknown key cannot be matched to a vault document later, so this requirement was not offered.`,
        value: item.ruleKey,
      })
      return
    }
    if (requirements.length >= MAX_REQUIREMENTS_PER_CHUNK) {
      rejections.push({
        kind: 'requirement',
        path,
        code: 'REQUIREMENT_LIMIT_EXCEEDED',
        reason: `One chunk may not add more than ${MAX_REQUIREMENTS_PER_CHUNK} requirements; this one was not offered.`,
      })
      return
    }
    const title = item.title.trim()
    if (title.length === 0) {
      rejections.push({
        kind: 'requirement',
        path: `${path}.title`,
        code: 'EMPTY_TITLE',
        reason: 'The requirement had no title, so there was nothing for the checklist to show.',
      })
      return
    }
    if (title.length > MAX_REQUIREMENT_TITLE_CHARS) {
      rejections.push({
        kind: 'requirement',
        path: `${path}.title`,
        code: 'TITLE_TOO_LONG',
        reason: `The requirement title is ${title.length} characters long; a checklist label is capped at ${MAX_REQUIREMENT_TITLE_CHARS}.`,
      })
      return
    }
    const clause = item.verbatimClause.trim()
    if (clause.length > MAX_REQUIREMENT_CLAUSE_CHARS) {
      rejections.push({
        kind: 'requirement',
        path: `${path}.verbatimClause`,
        code: 'CLAUSE_TOO_LONG',
        reason: `The quoted clause is ${clause.length} characters long; a single quoted passage is capped at ${MAX_REQUIREMENT_CLAUSE_CHARS}.`,
      })
      return
    }
    if (clause.length === 0) {
      warnings.push(
        `${path} ("${title}") came with no verbatim clause, so it is offered without quoted evidence.`,
      )
    }
    if (item.pageNumber === null) {
      rejections.push({
        kind: 'requirement',
        path: `${path}.pageNumber`,
        code: 'PAGE_MISSING',
        reason:
          'The requirement cited no page. A requirement without a page cannot be traced back to the document, so it was not offered.',
      })
      return
    }
    if (item.pageNumber < 1 || item.pageNumber > numPages) {
      rejections.push({
        kind: 'requirement',
        path: `${path}.pageNumber`,
        code: 'PAGE_OUT_OF_RANGE',
        reason: `Page ${item.pageNumber} does not exist in this document (1–${numPages}).`,
        value: String(item.pageNumber),
      })
      return
    }
    if (item.boundingBoxMalformed) {
      rejections.push({
        kind: 'requirement',
        path: `${path}.boundingBox`,
        code: 'BOUNDING_BOX_INVALID',
        reason:
          'The bounding box was not four numbers, so the clause location could not be trusted.',
      })
      return
    }
    let boundingBox: BoundingBox = { top: 0, left: 0, width: 0, height: 0 }
    if (item.boundingBox !== null) {
      const box = item.boundingBox
      const inUnit = [box.top, box.left, box.width, box.height].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      )
      if (!inUnit || box.left + box.width > 1 || box.top + box.height > 1) {
        rejections.push({
          kind: 'requirement',
          path: `${path}.boundingBox`,
          code: 'BOUNDING_BOX_INVALID',
          reason: `The bounding box (top ${box.top}, left ${box.left}, width ${box.width}, height ${box.height}) does not sit inside a page: every value must be between 0 and 1 and must not overflow the page.`,
        })
        return
      }
      boundingBox = { top: box.top, left: box.left, width: box.width, height: box.height }
    } else {
      warnings.push(
        `${path} ("${title}") came with no bounding box, so it is offered without a marked location on page ${item.pageNumber}.`,
      )
    }
    if (item.confidence !== null && (item.confidence < 0 || item.confidence > 1)) {
      rejections.push({
        kind: 'requirement',
        path: `${path}.confidence`,
        code: 'CONFIDENCE_OUT_OF_RANGE',
        reason: `Confidence ${item.confidence} is outside 0–1.`,
        value: String(item.confidence),
      })
      return
    }
    if (item.confidence === null && !missingConfidenceNoted) {
      missingConfidenceNoted = true
      warnings.push(
        `The model stated no confidence for its requirements; ${DEFAULT_AI_CONFIDENCE} was recorded so the values stay visibly unconfirmed.`,
      )
    }

    const suppliedId = item.id === null ? '' : item.id.trim()
    let id = suppliedId.length > MAX_REQUIREMENT_ID_CHARS ? '' : suppliedId
    if (suppliedId.length > MAX_REQUIREMENT_ID_CHARS) {
      warnings.push(
        `${path}: the model's id was longer than ${MAX_REQUIREMENT_ID_CHARS} characters and was replaced.`,
      )
    }
    if (id.length === 0) {
      id = `ai-req-${found.rule.ruleKey}`
      let suffix = 2
      while (usedIds.has(id)) {
        id = `ai-req-${found.rule.ruleKey}-${suffix}`
        suffix += 1
      }
    } else if (usedIds.has(id)) {
      rejections.push({
        kind: 'requirement',
        path: `${path}.id`,
        code: 'DUPLICATE_REQUIREMENT_ID',
        reason: `Two requirements in this reply used the id "${id}". Requirement ids must be unique, so the second was not offered.`,
        value: id,
      })
      return
    }
    usedIds.add(id)

    const notes = item.notes === null ? '' : item.notes.trim()
    requirements.push(
      markProvenance({
        id,
        ruleKey: found.rule.ruleKey,
        title,
        // The catalogue is authoritative wherever it has an opinion, so a model can
        // never promote a general returnable to mandatory or demote a disqualifier.
        category: found.rule.category,
        isMandatory: found.rule.isMandatory,
        verbatimClause: clause,
        pageNumber: item.pageNumber,
        boundingBox,
        riskLevel: found.rule.riskLevel ?? readRiskLevel(item.riskLevel) ?? 'INFORMATIONAL',
        order:
          found.rule.order !== undefined && Number.isFinite(found.rule.order)
            ? found.rule.order
            : (found.index + 1) * 10,
        confidence: item.confidence ?? DEFAULT_AI_CONFIDENCE,
        ...(notes.length > 0 ? { notes: notes.slice(0, MAX_REQUIREMENT_NOTES_CHARS) } : {}),
      }),
    )
  })

  return { metadata, requirements, rejections, warnings }
}

// ── merging ───────────────────────────────────────────────────────────────────

export interface ChunkExtractionOutcome {
  chunkIndex: number
  /** the pages the model actually saw for this chunk */
  pageNumbers: readonly number[]
  /** `validateSuggestions` output for the chunk; null when the model call failed */
  validation: ValidationResult | null
  parsed?: ParsedExtractionReply | null
  error?: string | null
  /**
   * How this chunk's pages were read. Absent means `'native-text'` — the text
   * pass, which is what every chunk was before a vision pass existed.
   *
   * `'ai-vision'` marks a chunk built from a model's READING of a scanned page's
   * image rather than from the page's own text layer, so provenance stays honest:
   * such a page is recorded with a null `chunkIndex` (no text chunk read it), and
   * it counts as read even when the extraction over the reading produced nothing,
   * because the reading itself is what obtained the page's content.
   */
  method?: ExtractionReadMethod
}

export type ExtractionReadMethod = 'native-text' | 'ai-vision'

export interface PageReadRecord {
  pageNumber: number
  method: ExtractionReadMethod
  /** the chunk that read it; null for a vision pass */
  chunkIndex: number | null
}

export interface MergeExtractionContext extends ExtractionContext {
  chunking: ExtractionChunking
  /** pages the caller read with a vision pass on scanned pages */
  visionPages?: readonly number[]
}

export interface MergedExtraction {
  numPages: number
  metadata: MetadataSuggestion[]
  requirements: AiRequirementSuggestion[]
  pagesRead: PageReadRecord[]
  /** pages no method obtained — these must keep blocking readiness */
  unreadPages: number[]
  rejections: ExtractionRejection[]
  warnings: string[]
  provenance: SuggestionProvenance
  /** the only review state a machine suggestion may carry */
  reviewState: typeof AI_SUGGESTION_REVIEW_STATE
}

function describePages(pages: readonly number[]): string {
  if (pages.length === 0) return 'no pages'
  if (pages.length === 1) return `page ${pages[0]}`
  const contiguous = pages.every((page, index) => index === 0 || page === pages[index - 1] + 1)
  return contiguous ? `pages ${pages[0]}–${pages[pages.length - 1]}` : `pages ${pages.join(', ')}`
}

interface MetadataGroup {
  field: MetadataFieldKey
  value: string
  pageNumber: number | null
  sourceClause: string | null
  confidence: number | null
  occurrences: number
  pages: Set<number>
}

/**
 * Merge per-chunk results into one extraction result.
 *
 * Metadata is de-duplicated by value (case- and whitespace-insensitive): a value seen
 * on two pages is stronger evidence than a value seen once, so it outranks it. Every
 * candidate keeps a 0–1 `score` for the review UI to sort by.
 *
 * Requirements are merged by `ruleKey` — one requirement per rule, the same shape the
 * local shredder produces — keeping the strongest sighting and recording the other
 * pages as corroborating clauses. Requirement ids are re-synthesised when two chunks
 * collide, because duplicate ids reject the whole persisted document.
 *
 * `pagesRead` records every page that was actually read and by what method, and
 * `unreadPages` is its complement: a page whose text was never obtained stays unread,
 * so it keeps blocking readiness.
 */
export function mergeExtractionChunks(
  perChunk: readonly ChunkExtractionOutcome[],
  context: MergeExtractionContext,
): MergedExtraction {
  const numPages = Number.isFinite(context.numPages) ? Math.max(0, Math.floor(context.numPages)) : 0
  const warnings: string[] = [...context.chunking.warnings]
  const rejections: ExtractionRejection[] = []
  const pagesRead: PageReadRecord[] = []
  const readPages = new Set<number>()
  const metadataGroups = new Map<string, MetadataGroup>()
  const requirementGroups = new Map<string, AiRequirementSuggestion[]>()

  const inRange = (page: number): boolean =>
    Number.isInteger(page) && page >= 1 && (numPages === 0 || page <= numPages)

  const recordRead = (
    page: number,
    method: ExtractionReadMethod,
    chunkIndex: number | null,
  ): void => {
    if (readPages.has(page)) return
    readPages.add(page)
    pagesRead.push({ pageNumber: page, method, chunkIndex })
  }

  const ordered = [...perChunk].sort((a, b) => a.chunkIndex - b.chunkIndex)
  for (const outcome of ordered) {
    const chunkPages = outcome.pageNumbers.filter(inRange).sort((a, b) => a - b)
    const method: ExtractionReadMethod = outcome.method ?? 'native-text'
    if (outcome.validation === null) {
      const detail =
        outcome.error !== undefined && outcome.error !== null && outcome.error.trim().length > 0
          ? outcome.error.trim()
          : 'the model call returned no reply'
      if (method === 'ai-vision') {
        // A vision chunk exists only because the model's reading of those pages
        // was obtained first, so their content IS available even though nothing
        // was extracted from it. Recording them keeps the page gate honest in
        // both directions: read (content obtained) yet empty of suggestions.
        for (const page of chunkPages) recordRead(page, 'ai-vision', null)
        warnings.push(
          `AI extraction produced nothing from the model's reading of ${describePages(chunkPages)}: ${detail}. Nothing was extracted from those pages.`,
        )
      } else {
        warnings.push(
          `AI extraction produced nothing for ${describePages(chunkPages)}: ${detail}. Those pages were not read by AI.`,
        )
      }
      continue
    }
    for (const page of chunkPages) {
      // A vision read has no text chunk behind it, so it records no chunk index.
      recordRead(page, method, method === 'ai-vision' ? null : outcome.chunkIndex)
    }
    rejections.push(...outcome.validation.rejections)
    warnings.push(...outcome.validation.warnings)

    for (const item of outcome.validation.metadata) {
      const key = `${item.field}\u0000${normalizeValue(item.value)}`
      const group = metadataGroups.get(key)
      if (!group) {
        metadataGroups.set(key, {
          field: item.field,
          value: item.value,
          pageNumber: item.pageNumber,
          sourceClause: item.sourceClause,
          confidence: item.confidence,
          occurrences: 1,
          pages: new Set(item.pageNumber === null ? [] : [item.pageNumber]),
        })
        continue
      }
      group.occurrences += 1
      if (item.pageNumber !== null) group.pages.add(item.pageNumber)
      if (
        item.confidence !== null &&
        (group.confidence === null || item.confidence > group.confidence)
      ) {
        group.confidence = item.confidence
      }
      if (group.pageNumber === null && item.pageNumber !== null) group.pageNumber = item.pageNumber
      if (group.sourceClause === null && item.sourceClause !== null) {
        group.sourceClause = item.sourceClause
      }
    }

    for (const item of outcome.validation.requirements) {
      const list = requirementGroups.get(item.ruleKey)
      if (list) list.push(item)
      else requirementGroups.set(item.ruleKey, [item])
    }
  }

  for (const page of [...(context.visionPages ?? [])].filter(inRange).sort((a, b) => a - b)) {
    if (readPages.has(page)) continue
    readPages.add(page)
    pagesRead.push({ pageNumber: page, method: 'ai-vision', chunkIndex: null })
  }

  const metadata: MetadataSuggestion[] = []
  for (const field of context.metadataFields ?? INTAKE_METADATA_FIELDS) {
    const fieldGroups = [...metadataGroups.values()]
      .filter((group) => group.field === field)
      .map((group) => ({
        group,
        score: clamp01(
          (group.confidence ?? DEFAULT_AI_CONFIDENCE) + 0.1 * Math.max(group.pages.size - 1, 0),
        ),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.group.pageNumber ?? Number.MAX_SAFE_INTEGER) -
            (b.group.pageNumber ?? Number.MAX_SAFE_INTEGER) ||
          (a.group.value < b.group.value ? -1 : a.group.value > b.group.value ? 1 : 0),
      )
    const kept = fieldGroups.slice(0, MAX_METADATA_CANDIDATES_PER_FIELD)
    for (const dropped of fieldGroups.slice(MAX_METADATA_CANDIDATES_PER_FIELD)) {
      rejections.push({
        kind: 'metadata',
        path: `metadata.${field}`,
        code: 'METADATA_LIMIT_EXCEEDED',
        reason: `Only the ${MAX_METADATA_CANDIDATES_PER_FIELD} strongest candidates per field are kept; "${dropped.group.value}" was weaker and was not offered.`,
        value: dropped.group.value,
      })
    }
    for (const { group, score } of kept) {
      metadata.push(
        markProvenance({
          field: group.field,
          value: group.value,
          pageNumber: group.pageNumber,
          sourceClause: group.sourceClause,
          confidence: group.confidence,
          score,
        }),
      )
    }
  }

  const requirements: AiRequirementSuggestion[] = []
  const finalIds = new Set<string>()
  for (const ruleKey of [...requirementGroups.keys()].sort()) {
    const list = requirementGroups.get(ruleKey) ?? []
    const ranked = [...list].sort(
      (a, b) =>
        b.confidence - a.confidence ||
        a.pageNumber - b.pageNumber ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    const winner = ranked[0]
    if (!winner) continue
    const distinctPages = new Set(list.map((item) => item.pageNumber))
    const additional: { text: string; pageNumber: number }[] = []
    const claimed = new Set<number>([winner.pageNumber])
    for (const other of ranked.slice(1)) {
      if (claimed.has(other.pageNumber)) continue
      claimed.add(other.pageNumber)
      if (other.verbatimClause.length === 0) continue
      additional.push({ text: other.verbatimClause, pageNumber: other.pageNumber })
      if (additional.length >= MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT) break
    }
    let id = winner.id
    if (finalIds.has(id)) {
      id = `ai-req-${ruleKey}`
      let suffix = 2
      while (finalIds.has(id)) {
        id = `ai-req-${ruleKey}-${suffix}`
        suffix += 1
      }
      warnings.push(
        `Two requirements from different rules shared the id "${winner.id}"; "${id}" was assigned so requirement ids stay unique.`,
      )
    }
    finalIds.add(id)

    const extraPages = [...distinctPages]
      .filter((page) => page !== winner.pageNumber)
      .sort((a, b) => a - b)
    const noteParts: string[] = []
    if (winner.notes !== undefined && winner.notes.trim().length > 0)
      noteParts.push(winner.notes.trim())
    if (extraPages.length > 0) noteParts.push(`Also referenced on p. ${extraPages.join(', p. ')}`)

    const { notes: _winnerNotes, ...rest } = winner
    requirements.push(
      markProvenance({
        ...rest,
        id,
        confidence:
          Math.round(clamp01(winner.confidence + 0.1 * Math.max(distinctPages.size - 1, 0)) * 100) /
          100,
        ...(additional.length > 0 ? { additionalClauses: additional } : {}),
        ...(noteParts.length > 0 ? { notes: noteParts.join(' · ') } : {}),
      }),
    )
  }
  requirements.sort(
    (a, b) =>
      a.order - b.order ||
      (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0) ||
      a.pageNumber - b.pageNumber,
  )
  if (requirements.length > MAX_REQUIREMENTS_PER_RESULT) {
    for (const dropped of requirements.slice(MAX_REQUIREMENTS_PER_RESULT)) {
      rejections.push({
        kind: 'requirement',
        path: dropped.ruleKey,
        code: 'REQUIREMENT_LIMIT_EXCEEDED',
        reason: `A tender may not hold more than ${MAX_REQUIREMENTS_PER_RESULT} requirements; "${dropped.title}" was not offered.`,
        value: dropped.ruleKey,
      })
    }
    requirements.length = MAX_REQUIREMENTS_PER_RESULT
  }

  const unreadPages: number[] = []
  for (let page = 1; page <= numPages; page += 1) {
    if (!readPages.has(page)) unreadPages.push(page)
  }

  pagesRead.sort(
    (a, b) =>
      a.pageNumber - b.pageNumber || (a.method < b.method ? -1 : a.method > b.method ? 1 : 0),
  )

  return {
    numPages,
    metadata,
    requirements,
    pagesRead,
    unreadPages,
    rejections,
    warnings: [...new Set(warnings)],
    provenance: AI_SUGGESTION_PROVENANCE,
    reviewState: AI_SUGGESTION_REVIEW_STATE,
  }
}

// ── availability ──────────────────────────────────────────────────────────────

/**
 * The provider the suite falls back to when the stored selection is not usable.
 *
 * `activeProvider` in `@genoffice/ai-provider` returns this literal, and the
 * shell's `ai:get-settings` handler already applies it before the settings reach
 * a renderer, so settings read through the bridge normally arrive with
 * `provider` resolved. It is restated here rather than imported because this
 * module must stay dependency-free, and the test pins it against the catalogue.
 */
export const AI_FALLBACK_PROVIDER = 'anthropic'

/**
 * How a provider satisfies the suite's credential gate — the four shapes the
 * request path itself accepts, and nothing else.
 *
 * The gate is two functions in `@genoffice/ai-provider`: `activeProvider`
 * (`packages/ai-provider/src/providers.ts`), which resolves a stored selection
 * and reads `needsCliPath` / `needsBaseUrl` off the catalogue, and the
 * per-request guard in the main process (`apps/slides/src/main/ai-ipc.ts`,
 * `provider !== 'codex' && !config.apiKey`). Between them they accept:
 *
 *  * `'api-key'` — a non-empty `apiKey`. Every BYOK provider; the default.
 *  * `'base-url'` — a non-empty `baseUrl`, and the key stays OPTIONAL: custom
 *    OpenAI-compatible endpoints (Ollama, LM Studio, vLLM) accept anonymous
 *    requests, which `activeProvider` documents in so many words. The
 *    catalogue's `needsBaseUrl` flag (today exactly `custom`).
 *  * `'cli'` — no key and no model id at all: the CLI is already signed in and
 *    picks the account's own current default model. The catalogue's
 *    `needsCliPath` flag, whose registry auth is `'codex-chatgpt'` (today
 *    exactly `codex`).
 *  * `'sign-in'` — no key in the settings file, because the main process fetches
 *    one from the app's own login for the request (`provider === 'genspark' &&
 *    !config.apiKey` → `gskApiKey()`). A model id is still required, exactly as
 *    the main-process guard requires one of every provider but codex. The
 *    registry's auth `'gsk-login'` (today exactly `genspark`).
 *
 * This table is the catalogue's EXCEPTIONS: a provider absent from it is
 * `'api-key'`. It is restated rather than imported because this module must stay
 * dependency-free, and `tests/ai-extraction.test.ts` pins every entry against the
 * catalogue's own flags and the registry's `capabilities.auth`, so the two cannot
 * drift apart silently.
 *
 * It is deliberately NOT an input to `aiExtractionAvailability`: a caller that
 * could extend the keyless or base-URL set could make the helper answer
 * differently for the same settings, which is the drift a single source of truth
 * exists to prevent.
 */
export type AiProviderAuthKind = 'api-key' | 'base-url' | 'cli' | 'sign-in'

export const AI_PROVIDER_AUTH_KINDS: Readonly<Record<string, AiProviderAuthKind>> = {
  codex: 'cli',
  genspark: 'sign-in',
  custom: 'base-url',
}

/** The provider ids of one auth kind, in catalogue order. */
function providersWithAuth(kind: AiProviderAuthKind): readonly string[] {
  return Object.entries(AI_PROVIDER_AUTH_KINDS)
    .filter(([, value]) => value === kind)
    .map(([id]) => id)
}

/**
 * Providers that authenticate without an api key and without a model id — the
 * CLI-backed ones (today exactly `codex`), derived from the table above.
 */
export const AI_KEYLESS_PROVIDERS: readonly string[] = providersWithAuth('cli')

/** Providers whose credential is a base URL, with the api key optional. */
export const AI_BASE_URL_PROVIDERS: readonly string[] = providersWithAuth('base-url')

/** Providers the app signs the user in for, so no key is ever stored for them. */
export const AI_SIGN_IN_PROVIDERS: readonly string[] = providersWithAuth('sign-in')

/** The parts of `AiProviderConfig` this module reads, typed structurally. */
export interface AiProviderConfigLike {
  apiKey?: string | null
  model?: string | null
  baseUrl?: string | null
  cliPath?: string | null
}

/**
 * The parts of `AiSettings` this module reads, typed structurally so no import
 * from `@genoffice/ai-provider` is needed and a test double stays trivial.
 */
export interface AiSettingsLike {
  provider?: string | null
  providers?: Record<string, AiProviderConfigLike | null | undefined> | null
}

export interface AiAvailabilityInput {
  /** The BYOK settings, or null/undefined when none could be read. */
  settings?: AiSettingsLike | null
  /** Override the fallback provider id; defaults to `AI_FALLBACK_PROVIDER`. */
  fallbackProvider?: string
  /**
   * The caller's own answer to "can this model read a scanned page's image?".
   *
   * The suite decides that with `modelLacksVision(model)` in
   * `@genoffice/ai-provider/browser`, which this module may not import, so the
   * answer arrives as an input and is echoed back unchanged. `null`/absent means
   * the caller did not ask. It is deliberately **not** a fourth reason for
   * unavailability: a text-only model still runs AI extraction over every page
   * that carries a text layer — it only cannot read a scanned page, and the
   * caller decides what to do about that (route the page to a human review and
   * let it keep blocking readiness).
   */
  visionCapable?: boolean | null
}

export type AiUnavailableReason = 'no-provider-configured' | 'no-api-key' | 'no-model'

export type AiAvailability =
  | {
      available: true
      /** the provider the suite will stream through, after its own fallback */
      provider: string
      /** the model id that will be requested; empty for a keyless CLI provider */
      model: string
      /** echoed from the input, unchanged: null when the caller did not ask */
      visionCapable: boolean | null
    }
  | {
      available: false
      reason: AiUnavailableReason
      /** plain language, user-facing, and safe to show as-is */
      message: string
    }

function nonEmpty(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A provider's credential shape; a provider the catalogue adds later is a BYOK key. */
function authKindOf(provider: string): AiProviderAuthKind {
  return AI_PROVIDER_AUTH_KINDS[provider] ?? 'api-key'
}

/** Does this provider need a model id of its own? A CLI provider picks its own. */
function requiresModelId(provider: string): boolean {
  return authKindOf(provider) !== 'cli'
}

/**
 * Is this provider's credential requirement met by its own config?
 *
 * `'cli'` and `'sign-in'` providers carry no credential in the settings file at
 * all — the suite authenticates them — so there is nothing here that can be
 * missing. A `'sign-in'` provider that is *not* signed in is a per-request
 * failure the main process reports in its own words; this module is pure and
 * cannot read a login state, so it does not pretend to.
 */
function credentialSatisfied(provider: string, config: AiProviderConfigLike): boolean {
  switch (authKindOf(provider)) {
    case 'cli':
    case 'sign-in':
      return true
    case 'base-url':
      return nonEmpty(config.baseUrl).length > 0
    default:
      return nonEmpty(config.apiKey).length > 0
  }
}

const NO_PROVIDER_MESSAGE =
  "No AI provider is configured yet, so AI extraction cannot run. Tenders' own rule engine reads the document offline and needs no key."

/**
 * Can this user run AI extraction, and if not, why not?
 *
 * Pure, synchronous and dependency-free: no clock, no I/O, no network, no import
 * beyond this module's own types. It answers only whether a request *could*
 * succeed — never whether anything has been extracted, confirmed or is ready.
 *
 * It mirrors the gate that actually decides a stream, in this order:
 *
 *  1. **A provider is configured.** The stored selection is honoured only when
 *     its config is usable, and anything else falls back to
 *     `AI_FALLBACK_PROVIDER`, exactly as `activeProvider` does. A config is
 *     usable when its provider's own requirement is met: a model id (except for
 *     a CLI provider, which picks its own), plus its credential —
 *     `AI_PROVIDER_AUTH_KINDS` above says which shape that credential has. This
 *     step is a no-op for settings read through the shell (which already applies
 *     that fallback) and keeps the helper correct for a raw or hand-built
 *     settings object.
 *  2. **The resolved provider's credential requirement is satisfied** — an api
 *     key for an `'api-key'` provider, a base URL for a `'base-url'` one (its
 *     key stays optional), and nothing at all for a `'cli'` or `'sign-in'` one,
 *     which the suite authenticates for the user.
 *  3. **A model is selected** (`model.trim()`), skipped only for a `'cli'`
 *     provider, exactly as the main-process guard skips the check for codex.
 *
 * The reasons keep their documented order and vocabulary
 * (`'no-provider-configured' | 'no-api-key' | 'no-model'`); `'no-api-key'` is the
 * "the credential is missing" bucket, and its message names what is actually
 * missing for this provider — a base URL, where that is the credential.
 *
 * Unavailable is not an error and not a reason to stop: the local rule engine is
 * the offline, always-available default, and the caller should present the
 * message as the reason the *optional* AI pass is off.
 */
export function aiExtractionAvailability(input: AiAvailabilityInput = {}): AiAvailability {
  const fallback = input.fallbackProvider ?? AI_FALLBACK_PROVIDER
  const visionCapable = input.visionCapable ?? null
  const settings = input.settings
  const selected = nonEmpty(settings?.provider)
  const providers = settings?.providers ?? null

  const usable = (id: string, config: AiProviderConfigLike | null | undefined): boolean => {
    if (!config) return false
    if (!requiresModelId(id)) return true
    if (nonEmpty(config.model).length === 0) return false
    return credentialSatisfied(id, config)
  }

  if (selected.length === 0) {
    return { available: false, reason: 'no-provider-configured', message: NO_PROVIDER_MESSAGE }
  }

  const provider = usable(selected, providers?.[selected]) ? selected : fallback
  const config = providers?.[provider]
  if (!config) {
    return { available: false, reason: 'no-provider-configured', message: NO_PROVIDER_MESSAGE }
  }

  if (!credentialSatisfied(provider, config)) {
    return {
      available: false,
      reason: 'no-api-key',
      message:
        authKindOf(provider) === 'base-url'
          ? `The AI provider "${provider}" has no base URL set, so AI extraction cannot run. Add one in Settings, or keep using the offline rule engine, which needs no key.`
          : `No API key is set for the AI provider "${provider}", so AI extraction cannot run. Add one in Settings, or keep using the offline rule engine, which needs no key.`,
    }
  }

  const model = nonEmpty(config.model)
  if (requiresModelId(provider) && model.length === 0) {
    return {
      available: false,
      reason: 'no-model',
      message: `The AI provider "${provider}" has no model selected, so AI extraction cannot run. Choose a model in Settings, or keep using the offline rule engine.`,
    }
  }

  return { available: true, provider, model, visionCapable }
}

// ── the pipeline ──────────────────────────────────────────────────────────────

export interface AiExtractionRunInput {
  completion: AiCompletion
  chunking: ExtractionChunking
  context: ExtractionContext
  fileName?: string | null
  tenderTitle?: string | null
  signal?: AbortSignal
  /** pages read by a vision pass; merged in as `ai-vision` */
  visionPages?: readonly number[]
  /** called before each chunk is sent, for progress reporting */
  onChunk?: (info: { chunkIndex: number; chunkCount: number; pageNumbers: number[] }) => void
}

export interface AiExtractionRun {
  merged: MergedExtraction
  outcomes: ChunkExtractionOutcome[]
}

/**
 * Chunk → prompt → injected model call → parse → validate → merge.
 *
 * Never throws and never partially trusts a reply: a chunk whose call fails or whose
 * reply cannot be read is recorded as an outcome with an error, its pages stay unread,
 * and the run returns everything the other chunks produced. That is what makes AI
 * extraction additive — a failed or absent model call leaves the local parser's result
 * exactly as it was.
 */
export async function runAiExtraction(input: AiExtractionRunInput): Promise<AiExtractionRun> {
  const outcomes: ChunkExtractionOutcome[] = []
  const chunkCount = input.chunking.chunks.length
  for (const chunk of input.chunking.chunks) {
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
    input.onChunk?.({ chunkIndex: chunk.index, chunkCount, pageNumbers })
    const prompt = buildExtractionPrompt(chunk, {
      ...input.context,
      fileName: input.fileName ?? null,
      tenderTitle: input.tenderTitle ?? null,
      chunkIndex: chunk.index,
      chunkCount,
    })
    let raw: string
    try {
      raw = await input.completion({
        system: prompt.system,
        user: prompt.user,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    } catch (error) {
      outcomes.push({
        chunkIndex: chunk.index,
        pageNumbers,
        validation: null,
        error: messageOf(error),
      })
      continue
    }
    const parsed = parseExtractionReply(raw, { chunk })
    if (!parsed.ok) {
      outcomes.push({
        chunkIndex: chunk.index,
        pageNumbers,
        validation: null,
        parsed: null,
        error: parsed.error,
      })
      continue
    }
    outcomes.push({
      chunkIndex: chunk.index,
      pageNumbers,
      parsed: parsed.reply,
      validation: validateSuggestions(parsed.reply, input.context),
    })
  }
  const merged = mergeExtractionChunks(outcomes, {
    ...input.context,
    chunking: input.chunking,
    visionPages: input.visionPages,
  })
  return { merged, outcomes }
}

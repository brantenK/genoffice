// DOCX intake: read a .docx the way the app reads a PDF.
//
// The local pipeline is written against `PageExtraction` (see pdf/extract.ts):
// pages of text lines carrying normalized boxes, consumed unchanged by
// `shredExtraction` / `extractTenderMeta` (pdf/shred.ts) and by the review UI.
// A .docx has no pages and no measured geometry, so this module presents the
// document honestly rather than inventing either:
//
//  * one LINE per paragraph — and per table row, the way the PDF path clusters a
//    visual row — split further at the soft/column breaks the engine encodes as
//    '\n' (packages/docx-engine/src/parse.ts);
//  * one PAGE per page segment the document ITSELF declares: a page break (the
//    engine encodes `w:br w:type="page"` as '\f' inside run text, or reports a
//    protected paragraph that hosts one as `fieldDisplay.kind === 'pageBreak'`),
//    a paragraph carrying `w:pageBreakBefore`, or a section that starts on a new
//    page. Nothing else creates a page: a flowing .docx is ONE page
//    (`pagination: 'continuous'`), and the UI must say so instead of printing
//    "1 page" (see `docxPaginationNote`). `numPages` is therefore the document's
//    own page count, and every `pageNumber` is one of its page numbers — no
//    fabricated pagination, and no clause can cite a page the file does not have.
//  * boxes that are READING-ORDER COORDINATES, not measured geometry: lines stack
//    top-to-bottom inside the band 0.20–0.80, with a paragraph-sized gap between
//    groups. That is exactly what `buildClauses` needs to split clauses at
//    paragraph boundaries, and staying out of the 0.18 header/footer band keeps
//    the running-boilerplate heuristic from stripping a body line (a .docx body
//    has no running header — headers/footers are separate parts and are not read
//    here). `left`/`width` are the full column because the file records no x
//    positions.
//  * `needsOcr` mirroring the PDF rule's INTENT — a page whose content produced
//    no usable text blocks readiness. The PDF path can only infer that from a
//    character threshold (a scan looks like a short page); a .docx can tell the
//    difference, so a page is flagged only when it carries visible content that is
//    not text (pictures, charts, drawings) AND yields fewer than 20 non-space
//    characters. A page that is genuinely blank therefore does not block — the
//    body was read in full, so no body content on it is unread — while a
//    picture-only page still fails closed.
//
// ── responsiveness and cancellation ──────────────────────────────────────────
//
// The PDF path reports progress per page and checks its abort signal between
// pages (pdf/extract.ts), because a PDF is read page by page and each
// `getTextContent()` resolves before the next page begins. A .docx has no such
// seam: `parseDocx` is one library call, and this module holds no hooks inside it.
//
// What that one call does to the renderer depends on what the document is made
// of, and both shapes were measured on the reference machine with a
// self-rescheduling macrotask ticker, which reports the longest stretch in which
// no macrotask ran — the window in which a renderer cannot paint and cannot
// dispatch the user's click. (The instrument reads 501 ms for a 500 ms busy loop,
// 404 ms for a 400 ms chain of resolved promises and 12 ms for a 200 ms chain of
// `setTimeout`s, so it measures the absence of a task boundary rather than a
// clock.)
//
//  * A PICTURE-heavy package yields throughout. JSZip's media path inflates each
//    picture part in chunks and pako emits its output in chunks, so the decode is
//    a long chain of resolved promises: 16 pictures of 1 MB took 4.7 s of wall
//    clock with a longest gap of 345 ms, and 40 of them 11.1 s with a longest gap
//    of 316 ms.
//  * A TEXT-heavy package does NOT. The body is parsed in one unbroken pass:
//    24 500 paragraphs (4.7 M characters in a 72 KB package) held the thread for
//    3 599 ms of its 3.9 s, and one 12 000 000-character paragraph — the shape
//    `maxTextChars` admits — held it for 5 512 ms of 6.0 s.
//
// So on a text-heavy document the frame cannot repaint and a click on Cancel is
// queued until the block ends, while on a picture-heavy one the loop turns
// throughout. Neither is fixable here: the block is inside `parseDocx` and there
// is no seam to yield at. What this module owes a surface instead is the truth —
// the PHASE of the parse and never a fraction of it, with the parse's own message
// saying that no progress can be reported while it runs (see
// `docxParseProgressMessage`) — so the indicator is honestly indeterminate rather
// than a spinner beside a bar this path would have had to invent.
//
// The progress seam is a callback rather than something this layer awaits, so a
// caller whose environment cannot schedule a timer in the middle of a parse is
// not forced into a polling document, and this path checks the abort signal at
// every sample, which is what bounds a cancel to one sample's work.
// `emitDocxProgressEvery` blocks the event loop for as long as it is given, so
// the renderer's own entry point does not use it — see `shredFile` in
// components/TenderList.tsx.
//
// No fixture for the figures above is committed to this repository, so they are
// reference-machine readings rather than something a checkout re-derives — unlike
// the PDF envelope's, which `tests/performance/results.json` records (the same
// admission is recorded in docs/tenders-hardening/contracts-and-invariants.md).
//
// NOT read, deliberately: header/footer parts, footnotes and endnotes, and
// comments (separate parts, not body text — the body is where requirements
// live), plus Word's saved `w:lastRenderedPageBreak` layout hints. That hint is
// a layout CACHE, and the block model does not carry its position inside a
// paragraph, so honouring it would place boundaries at paragraph starts — a
// guessed page number, which is exactly what this module refuses to produce.
import {
  DOCX_ZIP_LIMITS,
  parseDocx,
  readSections,
  type Block,
  type ParseExtras,
  type ParsedDoc,
  type SectionInfo,
} from '@genoffice/docx-engine'
import type { ExtractedPage, PageExtraction, PageLine } from '../../shared/types'
import { normalizePdfText } from '../pdf/clauses'
import { PDF_PREFLIGHT_LIMITS, formatBytes } from '../pdf/extract'

// ── published import limits ──────────────────────────────────────────────────

export interface DocxPreflightLimits {
  /** Same published per-file ceiling as the PDF path — see `PDF_PREFLIGHT_LIMITS`. */
  maxBytes: number
  /**
   * Extracted text lines (one paragraph or table row each).
   *
   * A .docx "line" is a whole paragraph or table row, so the reason the PDF path
   * needs a line budget applies here too — but the PDF's own figure is not
   * transferable, and the two are different measurements rather than one scaled.
   * The PDF path's ~0.042 MB is HEAP PER VISUAL LINE, taken on the short visual
   * lines of a rendered page (`tests/performance/results.json`, `byteStress`: a
   * 22 000-line synthetic document whose lines run ~85–118 characters). A DOCX
   * line is a whole paragraph or table row, several times longer, and what it
   * costs is its parsed BLOCK rather than its characters — so a per-line figure
   * has to be measured on this path, never derived from the PDF one by length.
   * Measured here: 24 500 lines / 4.77 M characters retained ~112 MB through
   * parse → `buildClauses` → `shredExtraction` in ~4.8 s on the reference
   * machine, i.e. ~4.6 KB per line whether the line is 195 or 1 087 characters.
   * 24 600 lines is therefore ~115 MB and ~5 s — well inside the same 1 GB heap
   * budget the PDF envelope is written against, and the reason it is safe to hold
   * at the PDF's figure.
   *
   * It bounds the WORK of clause reconstruction plus rule matching, which are
   * per-line, and it is NOT a bound on characters — see `maxTextChars`.
   */
  maxLines: number
  /**
   * Extracted text characters across the whole document.
   *
   * `maxLines` alone does not bound what it looks like it bounds: `blockUnits`
   * splits at the engine's soft/column/page breaks, and a paragraph with no break
   * is ONE line of unbounded length. A small, highly compressible .docx can
   * declare up to `DOCX_ZIP_LIMITS.maxPartBytes` of `document.xml` (512 MiB) in a
   * single paragraph, so a two-line document could carry hundreds of MB of text
   * past a line-count guard.
   *
   * Measured on this path: ~4.5 bytes of resident heap per extracted character
   * and ~1 M characters per second through parse → clause reconstruction → rule
   * matching, so 12 000 000 characters is ~54 MB of heap and ~12 s of local work
   * on the reference machine. That is 2.5× the 4 766 389 characters of the
   * 24 500-line realistic fixture, so `maxLines` still binds first for a normal
   * document and this budget exists for the shape a line count cannot see.
   *
   * Both DOCX figures in this interface are this path's own reference-machine
   * readings and no fixture for them is committed, so a checkout cannot re-derive
   * them (the same admission is recorded in
   * docs/tenders-hardening/contracts-and-invariants.md). They are the basis of the
   * budgets, not numbers any test enforces; each budget's VALUE is pinned in
   * `tests/docx-intake.test.ts`.
   */
  maxTextChars: number
}

export const DOCX_PREFLIGHT_LIMITS: DocxPreflightLimits = {
  maxBytes: PDF_PREFLIGHT_LIMITS.maxBytes,
  maxLines: 24_600,
  maxTextChars: 12_000_000,
}

/** Twips per point: the engine reports page sizes in twips, the PDF path in points. */
const TWIPS_PER_POINT = 20

// ── typed failures ───────────────────────────────────────────────────────────

export type DocxPreflightCode =
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_LINES'
  /** Declared uncompressed size beyond `DOCX_ZIP_LIMITS` (zip bomb). */
  | 'ZIP_BOMB'
  /** More extracted text than `maxTextChars`, which a line count cannot see. */
  | 'TOO_MUCH_TEXT'
  /** A CFB/OLE container: password-protected, or a legacy .doc wearing a .docx name. */
  | 'PROTECTED'
  /** Not a Word package at all (another format renamed to .docx, or no document part). */
  | 'NOT_A_DOCX'
  /** A package that cannot be read: truncated, damaged or unparseable. */
  | 'CORRUPT'
  /** The document holds no content at all. */
  | 'EMPTY_DOCUMENT'
  /** The document holds content but no text (pictures/drawings only). */
  | 'NO_TEXT'

/** Typed, user-surfaceable rejection for a .docx that cannot be read. */
export class DocxPreflightError extends Error {
  readonly code: DocxPreflightCode
  /** The offending measurement, when the code has one (null otherwise). */
  readonly actual: number | null
  readonly limit: number | null
  constructor(
    code: DocxPreflightCode,
    actual: number | null,
    limit: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'DocxPreflightError'
    this.code = code
    this.actual = actual
    this.limit = limit
  }
}

/** Raised when the user cancels an import; no partial result is returned. */
export class DocxImportCancelledError extends Error {
  readonly code = 'CANCELLED' as const
  constructor(message = 'Import cancelled.') {
    super(message)
    this.name = 'DocxImportCancelledError'
    this.code = 'CANCELLED'
  }
}

/** Reject an over-large file before its buffer is read. */
export function assertDocxBytesWithinLimit(
  bytes: number,
  limits: DocxPreflightLimits = DOCX_PREFLIGHT_LIMITS,
): void {
  if (Number.isFinite(bytes) && bytes > limits.maxBytes) {
    throw new DocxPreflightError(
      'FILE_TOO_LARGE',
      bytes,
      limits.maxBytes,
      `This .docx is ${formatBytes(bytes)} — the import limit is ${formatBytes(
        limits.maxBytes,
      )} per file.`,
    )
  }
}

/** Reject an over-long document once its text lines are known, before the shredder runs. */
export function assertDocxLinesWithinLimit(
  lines: number,
  limits: DocxPreflightLimits = DOCX_PREFLIGHT_LIMITS,
): void {
  if (Number.isFinite(lines) && lines > limits.maxLines) {
    throw new DocxPreflightError(
      'TOO_MANY_LINES',
      lines,
      limits.maxLines,
      `This .docx contains ${lines} text lines — the import limit is ${limits.maxLines} lines per document.`,
    )
  }
}

/**
 * Reject a document holding more text than the budget, once its text is known and
 * before the shredder runs.
 *
 * Checked alongside the line budget, not instead of it: a paragraph with no break
 * is one line of unbounded length, so a document can hold too much text while
 * holding very few lines. Both are refusals before the shredder, never a silent
 * truncation — a cut document would present a partial reading as a complete one.
 */
export function assertDocxTextWithinLimit(
  chars: number,
  limits: DocxPreflightLimits = DOCX_PREFLIGHT_LIMITS,
): void {
  if (Number.isFinite(chars) && chars > limits.maxTextChars) {
    throw new DocxPreflightError(
      'TOO_MUCH_TEXT',
      chars,
      limits.maxTextChars,
      `This .docx contains ${groupThousands(chars)} characters of text — the import limit is ${groupThousands(limits.maxTextChars)} characters per document.`,
    )
  }
}

/** `12000000` as `12 000 000`, so a large count stays readable in a message. */
export function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

const ZIP_BOMB_MESSAGE =
  `This .docx was refused before it was read: the package declares more than ` +
  `${formatBytes(DOCX_ZIP_LIMITS.maxTotalBytes)} of uncompressed content, or more than ` +
  `${formatBytes(DOCX_ZIP_LIMITS.maxPartBytes)} in a single part. A document that large is ` +
  `either damaged or not a real .docx.`
const PROTECTED_MESSAGE =
  'This file is not an open .docx package — it is a password-protected or legacy Word file ' +
  '(.doc). Save an unprotected copy as .docx and import that.'
const NOT_A_DOCX_MESSAGE =
  'This file is not a Word .docx document — its contents do not match the .docx name.'
const CORRUPT_MESSAGE =
  'This .docx could not be read — the file appears to be damaged or incomplete.'
const EMPTY_DOCUMENT_MESSAGE = 'This .docx is empty — there is no text or content to extract.'
const NO_TEXT_MESSAGE =
  'This .docx contains no text — its content is pictures or drawings. The local extractor reads ' +
  'text only, so no requirements can be lifted from this file.'

/**
 * The engine's own guard rails are the only place these conditions are decided
 * (packages/docx-engine/src/zip-load.ts and src/parse.ts), so they are mapped onto
 * the typed union here rather than re-derived.
 */
function docxFailure(error: unknown): DocxPreflightError {
  const message = error instanceof Error ? error.message : String(error)
  // Which of the three `DOCX_ZIP_LIMITS` was exceeded is named in the message;
  // `actual`/`limit` stay null because the engine's throw carries no number this
  // layer can attribute with certainty.
  if (message.startsWith('docx rejected:')) {
    return new DocxPreflightError('ZIP_BOMB', null, null, ZIP_BOMB_MESSAGE)
  }
  if (message.startsWith('not a docx:') || message.startsWith('OpenDocument file')) {
    return new DocxPreflightError('NOT_A_DOCX', null, null, NOT_A_DOCX_MESSAGE)
  }
  return new DocxPreflightError('CORRUPT', null, null, CORRUPT_MESSAGE)
}

// ── the intake contract ──────────────────────────────────────────────────────

/** How the page numbers of a DOCX intake were derived. */
export type DocxPagination =
  /** Page numbers come from page breaks the document itself declares. */
  | 'declared'
  /** The document declares no page break: it is presented as one block of text. */
  | 'continuous'

/**
 * A DOCX extraction. `PageExtraction`-compatible on purpose: `shredExtraction`,
 * `extractTenderMeta`, `extractIssuerInfo` and the review UI consume it with no
 * change, and the extra fields are what a surface needs to describe the source
 * honestly.
 */
export interface DocxIntake extends PageExtraction {
  /** Discriminator: these pages came from a .docx, not from a rendered PDF. */
  kind: 'docx'
  /** How `pageNumber` was derived — see `DocxPagination` and `docxPaginationNote`. */
  pagination: DocxPagination
  /**
   * Content blocks the document holds (paragraphs, headings, list items, tables,
   * pictures). Body markers — the trailing `w:sectPr`, bookmarks, proofing
   * errors — are not content and are not counted.
   */
  numBlocks: number
  /** Blocks carrying visible content that is not text (pictures, charts, embedded objects). */
  nonTextBlocks: number
  /** Text lines lifted, in reading order (equals the sum of the pages' line counts). */
  numLines: number
  /** Characters of text lifted, after normalization (equals the sum of the lines'). */
  numChars: number
}

/** Anything with a byte length and an async byte reader: a `File`/`Blob`, or a plain buffer. */
export type DocxIntakeSource =
  ArrayBuffer | Uint8Array | { size: number; arrayBuffer(): Promise<ArrayBuffer> }

export interface DocxIntakeOptions {
  limits?: DocxPreflightLimits
  /** Abort signal, checked before and after the parse (the parse itself is not interruptible). */
  signal?: AbortSignal
  /**
   * Called as the parse advances. The first call is `{ phase: 'parsing' }` and
   * later ones report `bytes` = the size of the whole package, which is a bound on
   * the work rather than a measurement of it: no internal offset exists to sample.
   * A caller that wants a bounded-cadence UI derives its own number from this (see
   * `docxProgressFraction`); nothing here may claim a percentage the parse did not
   * measure.
   *
   * **This callback is where cancellation happens.** If it is synchronous and the
   * parse takes a long time, nothing else can run, so `options.signal` is only
   * ever *checked* at the moments this function calls it — once before the bytes
   * are read, once after the read, and then at each progress sample. A caller that
   * passes no callback keeps today's behaviour exactly: the signal is checked
   * before and after the parse, and the cancel is delivered when the parse
   * returns.
   */
  onProgress?: (progress: DocxIntakeProgress) => void
}

/** A progress sample. `bytes: 0` means the phase reports no measurable progress. */
export interface DocxIntakeProgress {
  phase: 'reading' | 'parsing' | 'mapping'
  /** Bytes of the package, 0 before the buffer is read. */
  bytes: number
}

/**
 * The fraction of the import to display, in 0–1, from the parse's own bound.
 *
 * Returns 0 before the package's size is known and 1 from the moment it is, which
 * is a statement about the BOUND and not about the import: the parse of a
 * text-heavy document runs for seconds after this has reached 1 (see the
 * responsiveness note at the top of this module). So a surface must not render it
 * as a progress bar — a bar built from it would jump to full while seconds of work
 * remain, which is the fabricated percentage this path exists to refuse. The app
 * renders none: the Word import reports `total: 0` and `ShredProgress` draws no bar
 * (see `shredFile` in components/TenderList.tsx), and the value here is what tells
 * a surface whether the size is known yet.
 */
export function docxProgressFraction(progress: DocxIntakeProgress): number {
  switch (progress.phase) {
    case 'reading':
      return 0
    case 'mapping':
      return 1
    default:
      return progress.bytes > 0 ? 1 : 0
  }
}

/**
 * What the import is doing, in plain language, for the surface showing it.
 *
 * Deliberately no percentage and no page count: the parse has neither. A .docx is
 * read as one package, so the only things this path can honestly say are that it
 * is opening the file, that it is reading the document's content, and — for the
 * document's content — that no progress can be reported while that step runs.
 * That last clause is the reason this function returns prose rather than a
 * number, and it is not decoration: the parse of a text-heavy document holds the
 * renderer for seconds in one unbroken block, so the honest indicator is an
 * indeterminate one whose message explains why it cannot advance (see the
 * responsiveness note at the top of this module for what was measured, and
 * `docxMediaByteBudget` for the media weight on the other shape).
 */
export function docxParseProgressMessage(progress: DocxIntakeProgress): string {
  if (progress.phase === 'reading') return 'Opening the Word document…'
  if (progress.phase === 'mapping') return 'Matching compliance rules…'
  return (
    'Reading the Word document — one pass over the whole file, so no progress can ' +
    'be reported until it finishes.'
  )
}

/**
 * How many bytes of image data a parse will inline as base64.
 *
 * A LOWER bound on the wait, never the whole of it: the media path yields while it
 * inflates (so a picture-heavy package stays responsive), while a text-heavy one
 * blocks the thread in proportion to its text and has no media at all. Each media
 * part is inflated and then inlined as base64 — a ~4/3 expansion plus a
 * character-by-character encode. Measured on this path: 16 pictures of 1 MB (16 MB
 * of media, no text) parsed in 4.7 s, while a 72 KB package holding 4.7 M
 * characters of text parsed in 3.9 s — so media weight explains the wait on one
 * shape and nothing at all about it on the other.
 */
export function docxMediaByteBudget(
  parts: Array<{ name: string; uncompressedBytes: number }>,
): number {
  return parts.reduce(
    (total, part) =>
      /\.(?:bmp|emf|gif|jpe?g|png|tiff?|wmf)$/i.test(part.name)
        ? total + part.uncompressedBytes
        : total,
    0,
  )
}

/**
 * Run `run`, calling `onProgress` once per `everyMs` while it is pending.
 *
 * This is a convenience for tests and for hosts that tolerate it — NOT what the
 * app uses. `setTimeout` and `setInterval` are clamped to about 1 s between a
 * document's own frames, so a 1 s poll yields only when the parse lets the loop
 * turn, and in app code `ShredProgress` already carries a CSS spinner whose
 * rotation is the indeterminate signal a frozen frame would deny it.
 *
 * `everyMs <= 0` disables the timer and samples once before `run` is called, which
 * still checks the signal; that is the renderer's path.
 */
export async function emitDocxProgressEvery<T>(
  run: () => Promise<T>,
  onProgress: (progress: DocxIntakeProgress) => void,
  everyMs: number,
  bytes = 0,
): Promise<T> {
  if (!(everyMs > 0)) {
    onProgress({ phase: 'parsing', bytes })
    return run()
  }
  const timer = setInterval(() => onProgress({ phase: 'parsing', bytes }), everyMs)
  try {
    return await run()
  } finally {
    clearInterval(timer)
  }
}

/**
 * The honest one-line description of how this intake is paginated, for the review
 * UI. Exported so no surface has to paraphrase the rule and get it wrong.
 */
export function docxPaginationNote(intake: Pick<DocxIntake, 'pagination' | 'numPages'>): string {
  if (intake.pagination === 'declared') {
    const pages = `${intake.numPages} ${intake.numPages === 1 ? 'page' : 'pages'}`
    return `Pages follow the page breaks this .docx declares (${pages}).`
  }
  return (
    'This .docx declares no page breaks, so the document is presented as one continuous block of ' +
    'text: clause references read "p. 1" and are not printed page numbers.'
  )
}

// ── geometry ─────────────────────────────────────────────────────────────────

/** Top of the line band, in normalized page height. */
const PAGE_TOP = 0.2
/** Height of the line band; keeps every line out of the 0.18 header/footer band. */
const PAGE_SPAN = 0.6
/** One line's vertical slot, in layout units. */
const LINE_UNITS = 1
/** The share of its slot a line occupies; the rest is the gap to the next line. */
const LINE_HEIGHT_RATIO = 0.8
/**
 * Gap before the first line of a new paragraph / table row, in units. `largeGap`
 * in pdf/clauses.ts splits a clause when the gap exceeds 2.5 × line height, i.e.
 * 2 units here, so the group gap must clear 2.8 units.
 */
const GROUP_GAP_UNITS = 4
/** The PDF path's own "no usable text layer" threshold (see pdf/extract.ts). */
const MIN_TEXT_CHARS = 20

// ── reading the document ─────────────────────────────────────────────────────

/** One extracted line before pagination. */
interface LineUnit {
  text: string
  /** First line of a paragraph / table row: the clause split point. */
  startsGroup: boolean
}

/** A declared page segment, filled in reading order. */
interface Segment {
  units: LineUnit[]
  /** The segment holds visible content that is not text. */
  hasNonText: boolean
}

/**
 * The block's visible text, one entry per paragraph or table row, each still
 * carrying the engine's break encoding ('\n' = line/column break, '\f' = page
 * break). A table row's cells are joined into one line, exactly as the PDF path
 * clusters a visual row. Text boxes and an anchor paragraph's stray runs are
 * included: that text is on the page.
 */
function blockUnits(block: Block): string[] {
  if (block.type === 'table') {
    const rows = block.table?.rows ?? []
    return rows.map((row) => row.map((cell) => cell.paras.join(' ')).join(' '))
  }
  const parts: string[] = []
  const own = (block.runs ?? []).map((run) => run.text).join('')
  if (own) parts.push(own)
  const stray = (block.strayRuns ?? []).map((run) => run.text).join('')
  if (stray) parts.push(stray)
  for (const box of block.textboxes ?? []) {
    for (const para of box.paras) {
      const text = para.runs.map((run) => run.text).join('')
      if (text) parts.push(text)
    }
  }
  return parts
}

/** A block that shows something: body markers (sectPr, bookmarks, proofErr) do not. */
function isContentBlock(block: Block): boolean {
  return !block.hidden && !block.invisibleMarker
}

/** Visible content that is not text — the reason a page can hold nothing to read. */
function carriesNonText(block: Block): boolean {
  if (block.type === 'image') return true
  if (block.imageDataUrl || block.chartDisplay || block.diagramDisplay || block.oleProgId)
    return true
  return (block.runs ?? []).some((run) => run.image !== undefined)
}

/** A block whose own paragraph declares a page break (body-level `w:br`, or a protected host). */
function isPageBreakBlock(block: Block): boolean {
  return block.fieldDisplay?.kind === 'pageBreak' || block.label === 'Page break'
}

/**
 * Split the body into declared page segments. Every declared break opens a new
 * segment — including one with no content, because a blank page is still a page
 * and dropping it would renumber every page after it.
 */
function buildSegments(blocks: Block[], sectionPageStarts: Set<number>): Segment[] {
  const segments: Segment[] = [{ units: [], hasNonText: false }]
  const current = (): Segment => segments[segments.length - 1]
  const breakPage = (): void => {
    segments.push({ units: [], hasNonText: false })
  }

  for (const block of blocks) {
    if (block.docxIndex !== null && sectionPageStarts.has(block.docxIndex)) breakPage()
    if (block.format?.pageBreakBefore) breakPage()
    const units = blockUnits(block)
    // A break the engine reports as a block property is placed at the block's
    // start; when it is in the run text ('\f') the position is exact, so the
    // property is only used where the text cannot carry it.
    if (isPageBreakBlock(block) && !units.some((unit) => unit.includes('\f'))) breakPage()
    if (carriesNonText(block)) current().hasNonText = true

    for (const unit of units) {
      unit.split('\f').forEach((part, pageIndex) => {
        if (pageIndex > 0) breakPage()
        part.split('\n').forEach((rawLine, lineIndex) => {
          const text = normalizePdfText(rawLine)
          if (!text) return
          // Line 0 is the paragraph's or row's own first line — the clause split
          // point; a wrapped line inside it stays in the same group.
          current().units.push({ text, startsGroup: lineIndex === 0 })
        })
      })
    }
  }
  return segments
}

function layoutPage(
  pageNumber: number,
  segment: Segment,
  size: { width: number; height: number },
): ExtractedPage {
  const units = segment.units
  const tops: number[] = []
  let cursor = 0
  units.forEach((unit, index) => {
    if (index > 0) cursor += unit.startsGroup ? GROUP_GAP_UNITS : LINE_UNITS
    tops.push(cursor)
    cursor += LINE_HEIGHT_RATIO
  })
  const totalUnits = Math.max(cursor, LINE_UNITS)
  const unitHeight = PAGE_SPAN / totalUnits
  const height = LINE_HEIGHT_RATIO * unitHeight
  const lines: PageLine[] = units.map((unit, index) => ({
    pageNumber,
    text: unit.text,
    box: { top: PAGE_TOP + PAGE_SPAN * (tops[index] / totalUnits), left: 0, width: 1, height },
  }))
  const text = lines.map((line) => line.text).join('\n')
  return {
    pageNumber,
    width: size.width,
    height: size.height,
    text,
    lines,
    needsOcr: segment.hasNonText && text.replace(/\s+/g, '').length < MIN_TEXT_CHARS,
  }
}

// ── format sniffing ──────────────────────────────────────────────────────────

/** CFB/OLE container magic: a legacy .doc, or a password-protected package. */
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function sniffFormat(bytes: Uint8Array): 'zip' | 'cfb' | 'other' {
  if (bytes.length >= 8 && CFB_MAGIC.every((byte, index) => bytes[index] === byte)) return 'cfb'
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip'
  return 'other'
}

async function readBytes(
  source: DocxIntakeSource,
  limits: DocxPreflightLimits,
): Promise<Uint8Array> {
  if (ArrayBuffer.isView(source)) {
    assertDocxBytesWithinLimit(source.byteLength, limits)
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  }
  if (source instanceof ArrayBuffer) {
    assertDocxBytesWithinLimit(source.byteLength, limits)
    return new Uint8Array(source)
  }
  if (
    typeof source === 'object' &&
    source !== null &&
    typeof source.size === 'number' &&
    typeof source.arrayBuffer === 'function'
  ) {
    // Preflight BEFORE the buffer is read, like the PDF path does.
    assertDocxBytesWithinLimit(source.size, limits)
    return new Uint8Array(await source.arrayBuffer())
  }
  throw new TypeError('extractDocxIntake expects a File/Blob, an ArrayBuffer or a Uint8Array')
}

// ── the entry point ──────────────────────────────────────────────────────────

/**
 * Extract a .docx into the shape the rest of the intake pipeline already consumes.
 *
 * Every failure is typed and user-surfaceable (`DocxPreflightError`); nothing
 * returns a silent empty extraction that would look like a tender with no
 * requirements. No network, no clock: the result is a pure function of the bytes.
 *
 * The transform is pure, but the call is not free: it samples `options.onProgress`
 * so a surface can show that the import is alive and so `options.signal` is
 * checked at more than two moments — see the responsiveness note at the top of
 * this module for what was measured and why a callback is the seam rather than an
 * internal yield.
 */
export async function extractDocxIntake(
  source: DocxIntakeSource,
  options: DocxIntakeOptions = {},
): Promise<DocxIntake> {
  const limits = options.limits ?? DOCX_PREFLIGHT_LIMITS
  const signal = options.signal
  const onProgress = options.onProgress
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DocxImportCancelledError()
  }
  // Every sample is a cancellation checkpoint. `emitDocxProgressEvery` guarantees
  // there is at least one before the parse runs, so a signal aborted while the
  // caller was still reading the file still refuses the work — and the check
  // deliberately precedes the report, so a sample is never delivered for an import
  // that is already cancelled.
  const sample = (phase: DocxIntakeProgress['phase'], bytes: number): void => {
    throwIfAborted()
    onProgress?.({ phase, bytes })
  }

  throwIfAborted()
  sample('reading', 0)
  const bytes = await readBytes(source, limits)
  throwIfAborted()
  sample('parsing', bytes.byteLength)

  const format = sniffFormat(bytes)
  if (format === 'cfb') throw new DocxPreflightError('PROTECTED', null, null, PROTECTED_MESSAGE)
  if (format !== 'zip') throw new DocxPreflightError('NOT_A_DOCX', null, null, NOT_A_DOCX_MESSAGE)

  let parsed: ParsedDoc & { extras: ParseExtras }
  let sections: SectionInfo[]
  try {
    parsed = await emitDocxProgressEvery(
      () => parseDocx(bytes),
      (progress) => sample(progress.phase, progress.bytes),
      0,
      bytes.byteLength,
    )
    sections = readSections(parsed)
    // A cancel delivered while the parse was running: the library call cannot
    // observe the signal, so this is the first moment the cancel CAN be honoured
    // — and it is inside the window whose catch maps failures to `CORRUPT`.
    throwIfAborted()
  } catch (error) {
    // A cancellation raised in that window is a cancellation, not a damaged
    // package. Without this, cancelling a long Word import tells the user their
    // own document is corrupt — a lie about a file that parsed perfectly.
    if (error instanceof DocxImportCancelledError) throw error
    throw docxFailure(error)
  }
  sample('mapping', bytes.byteLength)

  // A section that starts on a new page is a declared page boundary; the first
  // section's own type is meaningless (there is no previous section).
  const sectionPageStarts = new Set<number>()
  sections.forEach((section, index) => {
    if (index === 0) return
    if (
      section.startType === 'nextPage' ||
      section.startType === 'evenPage' ||
      section.startType === 'oddPage'
    ) {
      sectionPageStarts.add(section.firstBlockIndex)
    }
  })

  const segments = buildSegments(parsed.blocks, sectionPageStarts)
  const numLines = segments.reduce((total, segment) => total + segment.units.length, 0)
  const numChars = segments.reduce(
    (total, segment) => total + segment.units.reduce((sum, unit) => sum + unit.text.length, 0),
    0,
  )
  assertDocxLinesWithinLimit(numLines, limits)
  assertDocxTextWithinLimit(numChars, limits)

  const contentBlocks = parsed.blocks.filter(isContentBlock)
  const nonTextBlocks = contentBlocks.filter(carriesNonText).length
  if (numLines === 0) {
    throw nonTextBlocks > 0
      ? new DocxPreflightError('NO_TEXT', null, null, NO_TEXT_MESSAGE)
      : new DocxPreflightError('EMPTY_DOCUMENT', null, null, EMPTY_DOCUMENT_MESSAGE)
  }

  // The document's own declared page size, in the PDF path's unit (points); the
  // first section governs. No rendered geometry exists for a .docx, so nothing
  // consumes this as a raster size — it is the page box the file declares.
  const settings = sections[0]?.settings
  const size = {
    width: settings ? settings.pageWidth / TWIPS_PER_POINT : 0,
    height: settings ? settings.pageHeight / TWIPS_PER_POINT : 0,
  }
  const pages = segments.map((segment, index) => layoutPage(index + 1, segment, size))
  const ocrPages = pages.filter((page) => page.needsOcr).length

  return {
    kind: 'docx',
    // A declared break always opens a second segment, so more than one page
    // means the page numbers are the document's own.
    pagination: pages.length > 1 ? 'declared' : 'continuous',
    numBlocks: contentBlocks.length,
    nonTextBlocks,
    numLines,
    numChars,
    numPages: pages.length,
    pages,
    textPages: pages.length - ocrPages,
    ocrPages,
  }
}

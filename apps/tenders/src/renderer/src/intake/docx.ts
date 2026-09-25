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
   * needs a line budget applies here too — but NOT the PDF's own figure: its
   * ~0.042 MB heap per line was measured on VISUAL lines of ~40 characters, and a
   * DOCX paragraph is 5–25 times longer. What was measured for this path is a
   * cost per LINE rather than per character, because the parsed block model (not
   * the text) dominates it: 24 500 lines / 4.77 M characters retained ~112 MB
   * through parse → `buildClauses` → `shredExtraction` in ~4.8 s on the reference
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
 */
export async function extractDocxIntake(
  source: DocxIntakeSource,
  options: DocxIntakeOptions = {},
): Promise<DocxIntake> {
  const limits = options.limits ?? DOCX_PREFLIGHT_LIMITS
  const signal = options.signal
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DocxImportCancelledError()
  }

  throwIfAborted()
  const bytes = await readBytes(source, limits)
  throwIfAborted()

  const format = sniffFormat(bytes)
  if (format === 'cfb') throw new DocxPreflightError('PROTECTED', null, null, PROTECTED_MESSAGE)
  if (format !== 'zip') throw new DocxPreflightError('NOT_A_DOCX', null, null, NOT_A_DOCX_MESSAGE)

  let parsed: ParsedDoc & { extras: ParseExtras }
  let sections: SectionInfo[]
  try {
    parsed = await parseDocx(bytes)
    sections = readSections(parsed)
  } catch (error) {
    throw docxFailure(error)
  }
  throwIfAborted()

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

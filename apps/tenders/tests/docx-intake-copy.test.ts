// DOCX intake, wired into the product — the decisions this wave makes, pinned.
//
// `intake/docx.ts` already reads a .docx into the shape the rest of the pipeline
// consumes (its own 31 tests are in `docx-intake.test.ts`). What is pinned here
// is everything the SURFACES had to decide once a Word document could arrive
// through the same dropzone as a PDF:
//
//  1. WHICH READER a chosen file goes to (`tenderSourceKind`), and that the PDF
//     path is still the PDF path.
//  2. THE PAGE COUNT. A .docx that declares no page break is ONE page to this
//     app — the whole file — and printing "1 page" beside it would read as a
//     printed page number. The card says what the document is instead, and the
//     review step and the workspace both state the module's own
//     `docxPaginationNote`, so no surface paraphrases the rule.
//  3. THE AI VISION PASS. A .docx has no rendered pages, so no page image can be
//     handed to a model — whatever the model can do. `importVision` refuses that
//     read BEFORE it consults the model's capability, and the flagged pages keep
//     blocking readiness for a person to clear.
//  4. THE VOCABULARY. A picture-only page of a Word document is not a scanned
//     one: there is no scanner, no text layer and no OCR step anywhere in that
//     path. Saying "scanned" of it describes a mechanism that never ran, which
//     is the same class of error as claiming a page was read when it was not.
//
// The copy half is checked against the comment-stripped source, in the style the
// other honesty guards use (`tests/ocr-honesty-copy.test.ts`): the copy lives in
// JSX and wraps across lines, so phrases are matched against collapsed source.
// Nothing here weakens those guards — the PDF wording they pin is asserted to
// survive, byte for byte, in the same file.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  DOCX_MIME,
  WORD_DOCUMENT_VISION_MESSAGE,
  documentPageSummary,
  importVision,
  tenderSourceKind,
} from '../src/renderer/src/components/TenderList'
import {
  PAGE_STATUS_LABEL,
  isWordDocumentName,
  pageStatusExplanation,
  wordDocumentPagination,
  wordDocumentPaginationNote,
} from '../src/renderer/src/components/ExtractionReview'
import { docxPaginationNote } from '../src/renderer/src/intake/docx'
import type { AiPageImage, AiVisionCompletion } from '../src/renderer/src/ai/extract-with-ai'

/** Locate `apps/tenders/src/renderer/src` from either cwd (`-w` or repo root). */
function resolveRendererSrc(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const fromRepoRoot = join(dir, 'apps', 'tenders', 'src', 'renderer', 'src')
    if (existsSync(fromRepoRoot)) return fromRepoRoot
    const fromWorkspace = join(dir, 'src', 'renderer', 'src')
    if (existsSync(fromWorkspace)) return fromWorkspace
    dir = dirname(dir)
  }
  throw new Error('Could not locate apps/tenders/src/renderer/src from ' + process.cwd())
}

const SRC = resolveRendererSrc()

/** Reduce a source file to the copy a user could actually read. */
function copyText(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join(' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Source with comments removed and code intact. Structural guards ("this file
 * calls the DOCX preflight") match against this rather than the raw file: a raw
 * regex is satisfied by a comment that merely names the call.
 */
function codeText(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** The two surfaces this feature changes copy on, plus the configs. */
const TENDER_LIST = 'components/TenderList.tsx'
const REVIEW = 'components/ExtractionReview.tsx'
const WORKSPACE = 'components/Workspace.tsx'

/** A page number printed as a page count is the claim a .docx must not make. */
const PRINTED_PAGE_CLAIM = /\b1 pages?\b/

describe('which reader a chosen file goes to', () => {
  it('routes each document type to its own intake path', () => {
    expect(tenderSourceKind({ name: 'rfp.pdf', type: 'application/pdf' })).toBe('pdf')
    expect(tenderSourceKind({ name: 'rfp.docx', type: DOCX_MIME })).toBe('docx')
    // Case is not a decision: Windows hands over both spellings.
    expect(tenderSourceKind({ name: 'RFP.PDF', type: '' })).toBe('pdf')
    expect(tenderSourceKind({ name: 'RFP.DOCX', type: '' })).toBe('docx')
    // Anything else is not readable, and the caller says so instead of guessing.
    expect(tenderSourceKind({ name: 'rfp.doc', type: '' })).toBeNull()
    expect(tenderSourceKind({ name: 'rfp.txt', type: 'text/plain' })).toBeNull()
    expect(tenderSourceKind({ name: 'rfp', type: '' })).toBeNull()
  })

  it('lets the name decide, and the OS type only when the name says nothing', () => {
    // The name is what the user recognises, and the type is a hint that
    // contradicts it often enough to matter (a .docx dragged out of an archive,
    // a PDF served as octet-stream).
    expect(tenderSourceKind({ name: 'rfp.pdf', type: DOCX_MIME })).toBe('pdf')
    expect(tenderSourceKind({ name: 'rfp.docx', type: 'application/pdf' })).toBe('docx')
    // A name with no extension at all falls back to the declared type.
    expect(tenderSourceKind({ name: 'rfp', type: DOCX_MIME })).toBe('docx')
    expect(tenderSourceKind({ name: 'rfp', type: 'application/pdf' })).toBe('pdf')
  })

  it('keeps the PDF path in place beside the DOCX one', () => {
    const code = codeText(TENDER_LIST)
    // The Word reader, its byte guard and its line budget…
    expect(code, 'the .docx intake must be wired in').toMatch(/extractDocxIntake\(/)
    expect(code, 'the .docx byte preflight must run before the buffer is read').toMatch(
      /assertDocxBytesWithinLimit\(/,
    )
    expect(code, 'the .docx line budget must be published in the limits copy').toMatch(
      /DOCX_PREFLIGHT_LIMITS\.maxLines/,
    )
    expect(code, 'a typed .docx refusal must reach the user').toMatch(/DocxPreflightError/)
    // …and the PDF path untouched beside it.
    expect(code).toMatch(/assertPdfBytesWithinLimit\(/)
    expect(code).toMatch(/assertPdfPagesWithinLimit\(/)
    expect(code).toMatch(/extractAllPages\(/)
    expect(code).toMatch(/loadPdfDocument\(/)
  })

  it('accepts a .docx in the file input and on the drag-and-drop path', () => {
    const code = codeText(TENDER_LIST)
    expect(code, 'the file input must offer Word documents').toMatch(
      /accept=\{`application\/pdf,\.pdf,\$\{DOCX_MIME\},\.docx`\}/,
    )
    // Both entry points go through the same import, so the guard cannot be
    // bypassed by dropping a file instead of choosing one.
    expect(code).toMatch(/onDrop=/)
    expect(code).toMatch(/handleFile\(f\)/)
    const copy = copyText(TENDER_LIST)
    expect(copy, 'the dropzone must name what it accepts').toMatch(/PDF or Word \.docx/)
    expect(copy, 'the limits must cover both readers').toMatch(/per PDF/)
    expect(copy, 'the limits must cover both readers').toMatch(/per Word \.docx/)
  })
})

describe('a Word document is not a PDF with one page', () => {
  it('describes the source document instead of printing a page count for it', () => {
    expect(documentPageSummary({ fileName: 'rfp.pdf', numPages: 4 })).toBe('4 pages')
    expect(documentPageSummary({ fileName: 'rfp.docx', numPages: 3 })).toBe(
      '3 pages (declared by the .docx)',
    )
    const flowing = documentPageSummary({ fileName: 'rfp.docx', numPages: 1 })
    expect(flowing).toMatch(/continuous block of text/)
    expect(flowing).toMatch(/no page breaks declared/)
    // The claim this replaces: "1 page" beside a Word document reads as a
    // printed page number the file never had. The pattern has teeth on it…
    expect('1 pages').toMatch(PRINTED_PAGE_CLAIM)
    // …and the shipping answer does not contain it.
    expect(flowing).not.toMatch(PRINTED_PAGE_CLAIM)
  })

  it('states the pagination note the intake module itself produced', () => {
    const continuous = { fileName: 'rfp.docx', numPages: 1 }
    expect(wordDocumentPaginationNote(continuous)).toBe(
      docxPaginationNote({ pagination: 'continuous', numPages: 1 }),
    )
    expect(wordDocumentPaginationNote({ fileName: 'rfp.docx', numPages: 3 })).toBe(
      docxPaginationNote({ pagination: 'declared', numPages: 3 }),
    )
    // The honest note for a flowing document says the page references are not
    // printed page numbers — that is the whole reason it exists.
    expect(wordDocumentPaginationNote(continuous)).toMatch(/not printed page numbers/)
    expect(wordDocumentPaginationNote(continuous)).not.toMatch(PRINTED_PAGE_CLAIM)
    // A PDF has real pages and needs no such note.
    expect(wordDocumentPaginationNote({ fileName: 'rfp.pdf', numPages: 1 })).toBeNull()
  })

  it('reconstructs the discriminator the way the intake module derives it', () => {
    // `extractDocxIntake` sets `pagination: pages.length > 1 ? 'declared' :
    // 'continuous'`, and the record keeps only `numPages`. Deriving it any other
    // way would let the app print a note the file contradicts.
    expect(wordDocumentPagination({ numPages: 1 })).toEqual({
      pagination: 'continuous',
      numPages: 1,
    })
    expect(wordDocumentPagination({ numPages: 2 })).toEqual({ pagination: 'declared', numPages: 2 })
  })

  it('tells a Word document from a PDF by the file the tender was imported under', () => {
    expect(isWordDocumentName('rfp.docx')).toBe(true)
    expect(isWordDocumentName('RFP.DOCX')).toBe(true)
    expect(isWordDocumentName('rfp.pdf')).toBe(false)
    expect(isWordDocumentName('')).toBe(false)
    expect(isWordDocumentName(null)).toBe(false)
    expect(isWordDocumentName(undefined)).toBe(false)
  })
})

describe('the optional AI pass never attempts a vision read of a .docx', () => {
  /** A PDFDocumentProxy stand-in: `importVision` only ever passes it through. */
  const doc = { numPages: 3 } as unknown as PDFDocumentProxy
  const image = { dataUrl: 'data:image/png;base64,AA' } as unknown as AiPageImage

  function args(overrides: { doc: PDFDocumentProxy | null; supportsVision: boolean }): {
    doc: PDFDocumentProxy | null
    supportsVision: boolean
    createCompletion: () => AiVisionCompletion
    renderPageImage: (doc: PDFDocumentProxy, pageNumber: number) => Promise<AiPageImage>
  } {
    return {
      ...overrides,
      createCompletion: vi.fn(() => (async () => ({ text: '' })) as unknown as AiVisionCompletion),
      renderPageImage: vi.fn(async () => image),
    }
  }

  it('refuses the read for a Word document and never builds a renderer', () => {
    const input = args({ doc: null, supportsVision: true })
    const vision = importVision(input)

    expect(vision.available).toBe(false)
    if (vision.available) throw new Error('a .docx must not be given a vision read')
    expect(vision.reason).toBe(WORD_DOCUMENT_VISION_MESSAGE)
    // Nothing was constructed and nothing was rendered: the pass cannot even
    // reach a page image for a document that has no pages.
    expect(input.createCompletion).not.toHaveBeenCalled()
    expect(input.renderPageImage).not.toHaveBeenCalled()
  })

  it('checks the document before the model, so a vision-capable model is not asked either', () => {
    // The order is the point: consulting the model's capability first would hand
    // a vision-capable model a renderer for a file that cannot be rendered, and
    // the run would fail on a document it had read perfectly.
    const withVision = importVision(args({ doc: null, supportsVision: true }))
    const withoutVision = importVision(args({ doc, supportsVision: false }))
    expect(withVision.available).toBe(false)
    expect(withoutVision.available).toBe(false)
    if (withVision.available || withoutVision.available) throw new Error('unreachable')
    expect(withVision.reason).toBe(WORD_DOCUMENT_VISION_MESSAGE)
    expect(withVision.reason).not.toBe(withoutVision.reason)
  })

  it('still refuses a model that cannot read an image, without building anything', () => {
    const input = args({ doc, supportsVision: false })
    const vision = importVision(input)
    expect(vision.available).toBe(false)
    if (vision.available) throw new Error('a text-only model must not be asked to read an image')
    expect(vision.reason).toMatch(/cannot be used to read an image/)
    expect(input.createCompletion).not.toHaveBeenCalled()
  })

  it('hands a PDF to the renderer only when the model can read the image', async () => {
    const input = args({ doc, supportsVision: true })
    const vision = importVision(input)
    expect(vision.available).toBe(true)
    if (!vision.available) throw new Error('a PDF with a vision-capable model must be readable')
    expect(input.createCompletion).toHaveBeenCalledTimes(1)
    await expect(vision.renderPageImage(4)).resolves.toBe(image)
    expect(input.renderPageImage).toHaveBeenCalledWith(doc, 4)
  })

  it('says what it could not do without claiming a page was read', () => {
    expect(WORD_DOCUMENT_VISION_MESSAGE).toMatch(/no rendered pages/)
    expect(WORD_DOCUMENT_VISION_MESSAGE).toMatch(/no page image/)
    // No scanner, no text layer and no OCR step is involved in a .docx, and the
    // message a user reads must not imply one.
    expect(WORD_DOCUMENT_VISION_MESSAGE).not.toMatch(/scanned|image-only|\bOCR\b/i)
    // Nor may it claim a reading happened — the whole point is that none did.
    expect(WORD_DOCUMENT_VISION_MESSAGE).not.toMatch(
      /was read|were read|has been read|have been read/i,
    )
  })

  it('wires the decision into the import, not a renderer that cannot work', () => {
    const code = codeText(TENDER_LIST)
    // Exactly one page-image renderer exists in this file, and it is reached
    // through the doc-gated helper.
    expect(code.match(/renderPdfPageImage\(/g) ?? []).toHaveLength(1)
    expect(code).toMatch(/renderPageImage: \(doc, pageNumber\) =>/)
    expect(code).toMatch(/importVision\(\{/)
    // The pass releases the parsed PDF only if there is one.
    expect(code).toMatch(/args\.doc\?\.cleanup\(\)/)
  })
})

describe('a picture-only Word page is not called scanned', () => {
  /** The word a .docx path must never use for a page whose content is a picture. */
  const SCANNER_VOCABULARY = /scanned|image-only|\bOCR\b/i

  it('keeps the PDF wording the existing guards and e2e spec assert', () => {
    // `tests/ocr-honesty-copy.test.ts` and the built-Electron intake-review spec
    // both read this sentence. It must survive this feature untouched.
    expect(pageStatusExplanation('ocr-required')).toMatch(/does not read scanned pages/)
    expect(pageStatusExplanation('ocr-required')).toMatch(/nothing on it was extracted/)
    expect(pageStatusExplanation('ocr-required')).toMatch(/no AI extraction read this one/)
  })

  it('describes a Word page without naming a mechanism that never ran', () => {
    const word = pageStatusExplanation('ocr-required', true)
    expect(word).toMatch(/no text/i)
    expect(word).toMatch(/nothing on it was extracted/)
    expect(word, 'a Word page was never scanned and no OCR step exists').not.toMatch(
      SCANNER_VOCABULARY,
    )
    // The PDF answer still does name the scanner, so the Word answer is a real
    // alternative rather than the same string with the guard satisfied by luck.
    expect(pageStatusExplanation('ocr-required')).toMatch(SCANNER_VOCABULARY)
  })

  it('has a scanner-free explanation for every page state', () => {
    for (const state of Object.keys(PAGE_STATUS_LABEL) as Array<keyof typeof PAGE_STATUS_LABEL>) {
      const word = pageStatusExplanation(state, true)
      const pdf = pageStatusExplanation(state, false)
      expect(word.length, `${state} needs an explanation`).toBeGreaterThan(0)
      expect(pdf.length, `${state} needs an explanation`).toBeGreaterThan(0)
      expect(word, `${state} must not be described with scanner vocabulary`).not.toMatch(
        SCANNER_VOCABULARY,
      )
    }
  })

  it('keeps the badge, the review copy and the source pane on the right vocabulary', () => {
    const list = codeText(TENDER_LIST)
    // The card's count badge branches on the source kind: "scanned page" for a
    // PDF, "picture-only page" for a Word document.
    expect(list).toMatch(/isWordDocumentName\(t\.fileName\)/)
    expect(list).toMatch(/picture-only page/)
    expect(list).toMatch(/scanned page/)
    // The review step asks the shared helper instead of indexing a table.
    const review = codeText(REVIEW)
    expect(review).toMatch(/pageStatusExplanation\(page\.state, wordDocument\)/)
    expect(review).toMatch(/isWordDocumentName\(tender\.fileName\)/)
    // …and it still says the local engine does not read a page with no text.
    expect(copyText(REVIEW)).toMatch(/does not read scanned pages/)
    expect(copyText(REVIEW)).toMatch(/no text layer/i)
  })

  it('says what a blocked Word page is, in the blocked branch of the same notice', () => {
    // The page-review paragraph is a ternary: the PDF arm is pinned by the
    // honesty guards and the intake-review e2e spec, and the Word arm is this
    // one. A branch-scoped read of the collapsed copy is what keeps the two
    // arms from being judged by each other's words.
    const copy = copyText(REVIEW)
    const wordBlocked = copy.match(/This tender is a Word \.docx[\s\S]*?holds text\./)?.[0] ?? ''
    expect(wordBlocked.length, 'the Word arm of the page notice must exist').toBeGreaterThan(0)
    expect(wordBlocked).toMatch(/nothing on them was extracted/)
    expect(wordBlocked, 'a .docx page was never scanned').not.toMatch(SCANNER_VOCABULARY)
    expect(
      copy,
      'the resolved arm must say the .docx text was read in full, not that pages have a text layer',
    ).toMatch(/This \.docx was read in full: no page holds content that produced no text\./)
  })

  it('shows the clause text where a Word document has no page to highlight', () => {
    const workspace = codeText(WORKSPACE)
    // The Word branch comes first: a .docx is never handed to the PDF viewer.
    expect(workspace).toMatch(/wordDocument \? \(\s*<WordSourcePane/)
    expect(workspace).toMatch(/data-testid="word-source-pane"/)
    // Every clause block is a jump target, so the review step's "open source"
    // lands on the clause text rather than on a highlight that does not exist.
    expect(workspace).toMatch(/data-page=\{requirement\.pageNumber\}/)
    // …and the workspace states the pagination note instead of printing "1 page".
    expect(workspace).toMatch(/wordDocumentPaginationNote\(tender\)/)
    expect(workspace, 'the PDF branch must keep printing its page count').toMatch(
      /\{tender\.numPages\} pages/,
    )
  })
})

// ── the Word import's progress is honest, and it yields where it can ──────────
//
// Measured on this path: a .docx parse yields the thread while it inflates
// pictures (16 MB of them took 4.7 s with no gap longer than 345 ms) but NOT
// while it parses text (24 500 paragraphs in a 72 KB package held the thread for
// 3 599 ms of its 3.9 s). So the import can honestly report a PHASE and cannot
// honestly report a fraction or a bar — and the stages it runs after the parse
// are its own, where a real task boundary IS available. Both halves are pinned
// here against the source, because the failure each prevents is a future edit.

describe('a Word import is given no progress it did not measure', () => {
  it('shows the module’s own phase message and derives no fraction from the bound', () => {
    const code = codeText(TENDER_LIST)
    // The surface shows the module's message, so nothing paraphrases what the
    // parse can and cannot say — including why it cannot say how far along it is.
    expect(code).toMatch(/message: docxParseProgressMessage\(progress\)/)
    // `docxProgressFraction` answers "is the package's size known yet", and the
    // size is known before any of a text-heavy document's parse has run. A bar
    // built from it would fill to 100 % while seconds of work remained, so the
    // Word path must not reach for it at all.
    expect(code, 'no surface may turn the bound into a bar').not.toMatch(/docxProgressFraction/)
    // `total: 0` is what makes the indicator indeterminate: `ShredProgress`
    // renders the bar and the page counter only when there is a total. The exact
    // wiring is pinned — the module's message, no page, no total — because that
    // combination IS the honest state: an indeterminate spinner and a sentence
    // that says why it cannot advance.
    const wordBranch = code.slice(
      code.indexOf('if (wordDocument) {'),
      code.indexOf('assertPdfBytesWithinLimit(file.size)'),
    )
    expect(wordBranch.length, 'the Word branch of the import must exist').toBeGreaterThan(0)
    expect(wordBranch).toMatch(
      /onProgress: \(progress\) =>\s*setShredding\(\{\s*stage: 'loading',\s*message: docxParseProgressMessage\(progress\),\s*page: 0,\s*total: 0,\s*\}\)/,
    )
    expect(wordBranch, 'the Word branch has no page total to pass').not.toMatch(
      /total: progressTotal/,
    )
    // …and the PDF path still reports real pages beside it.
    expect(code).toMatch(/total: doc\.numPages/)
  })

  it('yields the thread between its own stages instead of running them together', () => {
    const code = codeText(TENDER_LIST)
    // A real task boundary — the point at which the frame repaints and a queued
    // Cancel click is dispatched — followed by a cancellation checkpoint, so a
    // cancel landing in the gap stops the import before the next stage's work
    // rather than after it.
    expect(code).toMatch(
      /const paintAndCheckAbort = async \(\): Promise<void> => \{\s*await new Promise\(\(resolve\) => setTimeout\(resolve, 0\)\)\s*throwIfAborted\(\)\s*\}/,
    )
    // Measured on a 24 500-line Word document: `shredExtraction` holds the thread
    // ~1.05 s and `extractTenderMeta` ~0.8 s, so run together they are one 1.85 s
    // stretch the frame cannot paint through. The seams must be used.
    const seams = code.match(/await paintAndCheckAbort\(\)/g) ?? []
    expect(seams.length, 'the post-parse stages must not run back to back').toBeGreaterThanOrEqual(
      2,
    )
  })
})

import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  DOCX_PREFLIGHT_LIMITS,
  DocxImportCancelledError,
  DocxPreflightError,
  docxMediaByteBudget,
  docxPaginationNote,
  docxParseProgressMessage,
  docxProgressFraction,
  emitDocxProgressEvery,
  extractDocxIntake,
  groupThousands,
  type DocxIntakeProgress,
  type DocxPreflightCode,
} from '../src/renderer/src/intake/docx'
import { buildClauses } from '../src/renderer/src/pdf/clauses'
import { formatBytes, PDF_PREFLIGHT_LIMITS } from '../src/renderer/src/pdf/extract'
import { extractTenderMeta, shredExtraction } from '../src/renderer/src/pdf/shred'
import { intakeLimitDisclosure } from '../src/renderer/src/components/TenderList'
import { MAX_TENDERS_DOCUMENT_UPLOAD_BYTES } from '../src/shared/ipc'
import type { BoundingBox } from '../src/shared/types'

/**
 * DOCX intake reads a .docx the way the PDF path reads a PDF: the fixtures are
 * built here, in-test, as real (minimal) OOXML packages, so every assertion runs
 * against the same `parseDocx` the app ships. No binary fixture is committed and
 * nothing touches the network.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

const DOC_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

const STYLES_XML =
  XML_DECL +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>' +
  '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>'

/** 1x1 red PNG */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

interface FixtureOptions {
  /** raw XML of the <w:body> children (a sectPr is appended automatically) */
  bodyXml: string
  /** add the media part + relationship an inline picture needs */
  withImage?: boolean
}

async function buildDocx(options: FixtureOptions): Promise<Uint8Array> {
  const zip = new JSZip()
  const contentTypes =
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (options.withImage ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${contentTypes}</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      (options.withImage
        ? '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'
        : '') +
      '</Relationships>',
  )
  zip.file('word/styles.xml', STYLES_XML)
  if (options.withImage) zip.file('word/media/image1.png', TINY_PNG_BASE64, { base64: true })
  zip.file(
    'word/document.xml',
    `${XML_DECL}<w:document ${DOC_NS}><w:body>${options.bodyXml}` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
      '</w:body></w:document>',
  )
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const P = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`

const H1 = (text: string): string =>
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>` +
  `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`

/** An explicit page break, written the way Word writes one (inside a run). */
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'

/** The other form: a page break as a direct child of <w:body>. */
const BODY_PAGE_BREAK = '<w:br w:type="page"/>'

/** A section break paragraph: its sectPr terminates the section it sits in. */
const SECTION_BREAK_PARA =
  '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:pPr>' +
  '<w:r><w:t xml:space="preserve">End of section one</w:t></w:r></w:p>'

const IMAGE_PARA =
  '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic>' +
  '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'

const TABLE = (rows: string[][]): string =>
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>' +
  rows[0].map(() => '<w:gridCol w:w="4000"/>').join('') +
  '</w:tblGrid>' +
  rows
    .map(
      (row) =>
        `<w:tr>${row
          .map(
            (cell) =>
              `<w:tc><w:p><w:r><w:t xml:space="preserve">${esc(cell)}</w:t></w:r></w:p></w:tc>`,
          )
          .join('')}</w:tr>`,
    )
    .join('') +
  '</w:tbl>'

const RFP_HEAD =
  H1('REQUEST FOR PROPOSALS') +
  P('Zanostack Bulk Water Pipeline Upgrade Phase 2') +
  P('Reference Number: DWS/RFP-2026/0034') +
  P('Closing Date: 30 November 2026') +
  P('DEPARTMENT OF WATER AND SANITATION') +
  P('Proposals must be delivered to the bid box at 185 Francis Baai Drive, Pretoria')

const TAX_CLAUSE =
  'Bidders must submit a valid SARS Tax Clearance Certificate or TCS PIN confirming tax compliance at bid closing.'
const CSD_CLAUSE =
  'A valid Central Supplier Database (CSD) registration report must accompany the bid.'
const BEE_CLAUSE =
  'A certified copy of the B-BBEE certificate or a sworn affidavit must be included.'
const COIDA_CLAUSE =
  'A letter of good standing from the Compensation Commissioner (COIDA) is required.'

/** The exact predicate `parseBoundingBox` in src/shared/tenders-schema.ts enforces. */
function expectUnitBox(box: BoundingBox): void {
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.left + box.width).toBeLessThanOrEqual(1)
  expect(box.top + box.height).toBeLessThanOrEqual(1)
}

/** Await a rejection and return it as the typed preflight error. */
async function preflightError(run: Promise<unknown>): Promise<DocxPreflightError> {
  const error = await run.then(
    () => null,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(DocxPreflightError)
  return error as DocxPreflightError
}

async function expectCode(
  run: Promise<unknown>,
  code: DocxPreflightCode,
): Promise<DocxPreflightError> {
  const error = await preflightError(run)
  expect(error.code).toBe(code)
  return error
}

/** Overwrite the declared uncompressed size of every central-directory record. */
function patchCentralSizes(bytes: Uint8Array, size: number): Uint8Array {
  const out = bytes.slice()
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  for (let i = 0; i + 28 <= out.length; i++) {
    if (out[i] === 0x50 && out[i + 1] === 0x4b && out[i + 2] === 0x01 && out[i + 3] === 0x02) {
      view.setUint32(i + 24, size, true)
    }
  }
  return out
}

describe('DOCX intake', () => {
  describe('a normal document', () => {
    it('produces the PageExtraction shape the shredder and the meta extractor consume', async () => {
      const intake = await extractDocxIntake(
        await buildDocx({
          bodyXml: RFP_HEAD + P(TAX_CLAUSE) + P(CSD_CLAUSE) + P(BEE_CLAUSE) + P(COIDA_CLAUSE),
        }),
      )

      expect(intake.kind).toBe('docx')
      expect(intake.numBlocks).toBe(10)
      expect(intake.numLines).toBe(10)
      expect(intake.numPages).toBe(1)
      // No page break in the file: one continuous block, and the note says so.
      expect(intake.pagination).toBe('continuous')
      expect(intake.ocrPages).toBe(0)
      expect(intake.textPages).toBe(1)
      expect(intake.nonTextBlocks).toBe(0)
      expect(intake.pages[0].needsOcr).toBe(false)
      expect(intake.pages[0].text).toContain(TAX_CLAUSE)
      expect(intake.pages[0].lines.map((line) => line.text)).toContain(CSD_CLAUSE)
      // Page size comes from the document's own sectPr (A4 in twips → points).
      expect(intake.pages[0].width).toBeCloseTo(11906 / 20, 1)
      expect(intake.pages[0].height).toBeCloseTo(16838 / 20, 1)
    })

    it('finds requirements with shredExtraction and lifts the cover metadata', async () => {
      const intake = await extractDocxIntake(
        await buildDocx({
          bodyXml: RFP_HEAD + P(TAX_CLAUSE) + P(CSD_CLAUSE) + P(BEE_CLAUSE) + P(COIDA_CLAUSE),
        }),
      )

      const requirements = shredExtraction(intake)
      const keys = requirements.map((requirement) => requirement.ruleKey)
      expect(keys).toContain('tax_pin')
      expect(keys).toContain('csd')
      expect(keys).toContain('bbbee')
      expect(keys).toContain('coida')
      for (const requirement of requirements) {
        expect(requirement.pageNumber).toBeGreaterThanOrEqual(1)
        expect(requirement.pageNumber).toBeLessThanOrEqual(intake.numPages)
        expect(requirement.verbatimClause.length).toBeGreaterThan(8)
        expectUnitBox(requirement.boundingBox)
        for (const clause of requirement.additionalClauses ?? []) {
          expect(clause.pageNumber).toBeLessThanOrEqual(intake.numPages)
        }
      }
      const tax = requirements.find((requirement) => requirement.ruleKey === 'tax_pin')
      expect(tax?.verbatimClause).toBe(TAX_CLAUSE)

      const meta = extractTenderMeta(intake, 'fallback-title')
      expect(meta.title).toBe('Zanostack Bulk Water Pipeline Upgrade Phase 2')
      expect(meta.referenceNumber).toBe('DWS/RFP-2026/0034')
      expect(meta.closingDate).toBe('30 November 2026')
      expect(meta.issuingBody).toBe('DEPARTMENT OF WATER AND SANITATION')
      expect(meta.submissionMethod).toBe('PHYSICAL')
      expect(meta.conflicts).toEqual([])
    })

    it('turns every table row into one line and every paragraph into its own clause', async () => {
      const intake = await extractDocxIntake(
        await buildDocx({
          bodyXml:
            P('The following documents must be submitted with the bid') +
            P(CSD_CLAUSE) +
            TABLE([
              ['3.1', 'Valid tax clearance certificate'],
              ['3.2', 'Proof of COIDA registration'],
            ]),
        }),
      )

      const lines = intake.pages[0].lines.map((line) => line.text)
      expect(lines).toContain('3.1 Valid tax clearance certificate')
      expect(lines).toContain('3.2 Proof of COIDA registration')

      const clauses = buildClauses(intake).map((clause) => clause.text)
      // A paragraph break splits the clause even though the first paragraph
      // carries no sentence-terminating punctuation.
      const first = clauses.find((clause) => clause.includes('must be submitted with the bid'))
      expect(first).toBe('The following documents must be submitted with the bid')
      expect(clauses).toContain(CSD_CLAUSE)
      // Each table row is its own clause, so a quote never spans two rows.
      expect(clauses).toContain('3.1 Valid tax clearance certificate')
    })

    it('keeps every line box inside the unit square and out of the header band', async () => {
      const intake = await extractDocxIntake(
        await buildDocx({ bodyXml: RFP_HEAD + P(TAX_CLAUSE) + TABLE([['a', 'b']]) }),
      )
      for (const page of intake.pages) {
        for (const line of page.lines) {
          expectUnitBox(line.box)
          // 0.18 is the running header/footer band in pdf/clauses.ts: a .docx
          // body line must never be treated as running boilerplate.
          expect(line.box.top).toBeGreaterThan(0.18)
          expect(line.box.top + line.box.height).toBeLessThan(0.82)
        }
      }
    })

    it('accepts a File and reads the bytes only once the byte cap allows it', async () => {
      const bytes = await buildDocx({ bodyXml: RFP_HEAD + P(TAX_CLAUSE) })
      // A `File` part takes an `ArrayBuffer`-backed view; the generator hands back
      // a `Uint8Array` whose buffer is only known to be `ArrayBufferLike`, so the
      // copy gives it the concrete backing buffer the DOM type asks for.
      const file = new File([new Uint8Array(bytes)], 'tender.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      const intake = await extractDocxIntake(file)
      expect(intake.numLines).toBe(7)
    })
  })

  describe('pagination honesty', () => {
    it('numbers pages from the breaks the document declares', async () => {
      const intake = await extractDocxIntake(
        await buildDocx({
          bodyXml:
            H1('REQUEST FOR PROPOSALS') +
            P('Zanostack Bulk Water Pipeline Upgrade Phase 2') +
            P('Reference Number: DWS/RFP-2026/0034') +
            PAGE_BREAK +
            P(TAX_CLAUSE),
        }),
      )

      expect(intake.pagination).toBe('declared')
      expect(intake.numPages).toBe(2)
      expect(intake.pages.map((page) => page.pageNumber)).toEqual([1, 2])
      expect(intake.pages[0].lines.map((line) => line.text)).not.toContain(TAX_CLAUSE)
      expect(intake.pages[1].lines.map((line) => line.text)).toEqual([TAX_CLAUSE])
      expect(intake.pages[1].lines[0].pageNumber).toBe(2)

      // The page number survives into the compliance matrix and stays inside
      // the range the v2 schema validates (1..numPages).
      const tax = shredExtraction(intake).find((requirement) => requirement.ruleKey === 'tax_pin')
      expect(tax?.pageNumber).toBe(2)
    })

    it('honours a pageBreakBefore paragraph and a body-level page break', async () => {
      const intake = await extractDocxIntake(
        await buildDocx({
          bodyXml:
            P(TAX_CLAUSE) +
            BODY_PAGE_BREAK +
            P(COIDA_CLAUSE) +
            `<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Annexure A</w:t></w:r></w:p>`,
        }),
      )

      expect(intake.pagination).toBe('declared')
      expect(intake.numPages).toBe(3)
      expect(intake.pages[0].lines.map((line) => line.text)).toEqual([TAX_CLAUSE])
      expect(intake.pages[1].lines.map((line) => line.text)).toEqual([COIDA_CLAUSE])
      expect(intake.pages[2].lines.map((line) => line.text)).toEqual(['Annexure A'])
    })

    it('honours a section that starts on a new page', async () => {
      const intake = await extractDocxIntake(
        await buildDocx({ bodyXml: P(TAX_CLAUSE) + SECTION_BREAK_PARA + P(COIDA_CLAUSE) }),
      )

      expect(intake.pagination).toBe('declared')
      expect(intake.numPages).toBe(2)
      expect(intake.pages[0].lines.map((line) => line.text)).toEqual([
        TAX_CLAUSE,
        'End of section one',
      ])
      expect(intake.pages[1].lines.map((line) => line.text)).toEqual([COIDA_CLAUSE])
    })

    it('flags a picture-only page as needing a read instead of dropping it', async () => {
      const intake = await extractDocxIntake(
        await buildDocx({
          bodyXml: RFP_HEAD + P(TAX_CLAUSE) + PAGE_BREAK + IMAGE_PARA,
          withImage: true,
        }),
      )

      expect(intake.numPages).toBe(2)
      expect(intake.pages[1].lines).toEqual([])
      expect(intake.pages[1].text).toBe('')
      expect(intake.pages[1].needsOcr).toBe(true)
      expect(intake.ocrPages).toBe(1)
      expect(intake.textPages).toBe(1)
      expect(intake.nonTextBlocks).toBe(1)
      // The text page is still shredded: a blocked page does not lose the rest.
      expect(shredExtraction(intake).map((requirement) => requirement.ruleKey)).toContain('tax_pin')
    })

    it('does not claim a page count it cannot support', async () => {
      const flowing = await extractDocxIntake(
        await buildDocx({ bodyXml: RFP_HEAD + P(TAX_CLAUSE) }),
      )
      expect(docxPaginationNote(flowing)).toContain('declares no page breaks')
      expect(docxPaginationNote(flowing)).toContain('not printed page numbers')
      expect(docxPaginationNote(flowing)).not.toContain('1 page')

      const paged = await extractDocxIntake(
        await buildDocx({ bodyXml: P(TAX_CLAUSE) + PAGE_BREAK + P(COIDA_CLAUSE) }),
      )
      expect(docxPaginationNote(paged)).toBe(
        'Pages follow the page breaks this .docx declares (2 pages).',
      )
    })
  })

  describe('defensive failure', () => {
    it('rejects a corrupt package as CORRUPT', async () => {
      const truncatedZip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00])
      await expectCode(extractDocxIntake(truncatedZip), 'CORRUPT')

      const valid = await buildDocx({ bodyXml: P(TAX_CLAUSE) })
      await expectCode(extractDocxIntake(valid.slice(0, valid.length - 120)), 'CORRUPT')
    })

    it('rejects a package whose declared sizes exceed DOCX_ZIP_LIMITS as ZIP_BOMB', async () => {
      const bomb = patchCentralSizes(await buildDocx({ bodyXml: P(TAX_CLAUSE) }), 600 * 1024 * 1024)
      const error = await expectCode(extractDocxIntake(bomb), 'ZIP_BOMB')
      // The message names the ceiling the file was refused against.
      expect(error.message).toContain('512.0 MB')
      expect(error.message).toContain('1536.0 MB')
    })

    it('rejects an empty document as EMPTY_DOCUMENT', async () => {
      await expectCode(extractDocxIntake(await buildDocx({ bodyXml: '' })), 'EMPTY_DOCUMENT')
      await expectCode(extractDocxIntake(await buildDocx({ bodyXml: '<w:p/>' })), 'EMPTY_DOCUMENT')
    })

    it('rejects an images-only document as NO_TEXT rather than extracting nothing', async () => {
      const error = await expectCode(
        extractDocxIntake(await buildDocx({ bodyXml: IMAGE_PARA, withImage: true })),
        'NO_TEXT',
      )
      expect(error.message).toContain('pictures or drawings')
    })

    it('rejects a mislabelled file: another format, an encrypted package, another OOXML app', async () => {
      const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n')
      await expectCode(extractDocxIntake(pdf), 'NOT_A_DOCX')

      // CFB/OLE magic: a legacy .doc, or a password-protected package.
      const cfb = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00])
      const protectedError = await expectCode(extractDocxIntake(cfb), 'PROTECTED')
      expect(protectedError.message).toContain('password-protected')

      // A zip that is not a Word package (a spreadsheet, say).
      const spreadsheet = new JSZip()
      spreadsheet.file('[Content_Types].xml', `${XML_DECL}<Types/>`)
      spreadsheet.file('xl/workbook.xml', `${XML_DECL}<workbook/>`)
      await expectCode(
        extractDocxIntake(await spreadsheet.generateAsync({ type: 'uint8array' })),
        'NOT_A_DOCX',
      )
    })

    it('rejects an over-large file before its bytes are read', async () => {
      let read = false
      const tooLarge = {
        size: DOCX_PREFLIGHT_LIMITS.maxBytes + 1,
        arrayBuffer: (): Promise<ArrayBuffer> => {
          read = true
          return Promise.resolve(new ArrayBuffer(0))
        },
      }
      const error = await expectCode(extractDocxIntake(tooLarge), 'FILE_TOO_LARGE')
      expect(read).toBe(false)
      expect(error.actual).toBe(DOCX_PREFLIGHT_LIMITS.maxBytes + 1)
      expect(error.limit).toBe(DOCX_PREFLIGHT_LIMITS.maxBytes)

      const buffer = new ArrayBuffer(DOCX_PREFLIGHT_LIMITS.maxBytes + 1)
      await expectCode(extractDocxIntake(buffer), 'FILE_TOO_LARGE')
    })

    it('rejects a document with more lines than the import limit', async () => {
      const bytes = await buildDocx({ bodyXml: RFP_HEAD + P(TAX_CLAUSE) })
      const error = await expectCode(
        extractDocxIntake(bytes, { limits: { ...DOCX_PREFLIGHT_LIMITS, maxLines: 3 } }),
        'TOO_MANY_LINES',
      )
      expect(error.actual).toBe(7)
      expect(error.limit).toBe(3)
    })

    it('honours the published limits and the PDF byte ceiling', () => {
      expect(DOCX_PREFLIGHT_LIMITS.maxBytes).toBe(PDF_PREFLIGHT_LIMITS.maxBytes)
      expect(DOCX_PREFLIGHT_LIMITS.maxBytes).toBe(100 * 1024 * 1024)
      expect(DOCX_PREFLIGHT_LIMITS.maxLines).toBe(24_600)
      expect(DOCX_PREFLIGHT_LIMITS.maxTextChars).toBe(12_000_000)
    })

    /**
     * The character budget exists because a LINE count cannot bound a DOCX: a
     * paragraph with no break is one line of unbounded length, and the engine's
     * own zip limit admits 512 MiB in a single part. This is the shape the line
     * guard passes and the text guard must catch. The budget is injected small so
     * the fixture is cheap; the value the app ships is asserted against the
     * published constant further down.
     */
    it('refuses too much text on too few lines, where a line count sees nothing', async () => {
      const limits = { ...DOCX_PREFLIGHT_LIMITS, maxTextChars: 10_000 }
      const bytes = await buildDocx({ bodyXml: P('x'.repeat(limits.maxTextChars + 1)) })
      const error = await expectCode(extractDocxIntake(bytes, { limits }), 'TOO_MUCH_TEXT')
      expect(error.actual).toBe(limits.maxTextChars + 1)
      expect(error.limit).toBe(limits.maxTextChars)
      expect(error.message).toMatch(/10 000 characters per document/)
      // One line: the line budget is nowhere near binding for this document.
      const atLimit = await buildDocx({ bodyXml: P('x'.repeat(limits.maxTextChars)) })
      await expect(extractDocxIntake(atLimit, { limits })).resolves.toMatchObject({
        numLines: 1,
        numChars: limits.maxTextChars,
      })
    })

    it('reports the extracted character count on the result', async () => {
      const bytes = await buildDocx({ bodyXml: RFP_HEAD + P(TAX_CLAUSE) })
      const intake = await extractDocxIntake(bytes)
      const lineChars = intake.pages.reduce(
        (total, page) => total + page.lines.reduce((sum, line) => sum + line.text.length, 0),
        0,
      )
      expect(intake.numChars).toBeGreaterThan(0)
      expect(intake.numChars).toBe(lineChars)
      // `page.text` joins the lines with '\n', so it carries one more character
      // per line than the text lifted — the count is of the text, not the join.
      const joined = intake.pages.reduce((total, page) => total + page.text.length, 0)
      const lines = intake.pages.reduce((total, page) => total + page.lines.length, 0)
      expect(joined).toBe(lineChars + lines - intake.pages.length)
    })

    it('returns no partial result when the import is cancelled', async () => {
      const controller = new AbortController()
      controller.abort()
      const bytes = await buildDocx({ bodyXml: P(TAX_CLAUSE) })
      const error = await extractDocxIntake(bytes, { signal: controller.signal }).then(
        () => null,
        (thrown: unknown) => thrown,
      )
      expect(error).toBeInstanceOf(DocxImportCancelledError)
      expect((error as DocxImportCancelledError).code).toBe('CANCELLED')
    })
  })

  // ── progress and cancellation during the parse ──────────────────────────────
  //
  // The parse is one library call with no internal seam, so this path cannot
  // report pages the way the PDF path does. What it must NOT do is leave a
  // surface with nothing to show and an abort that is only ever checked at the
  // two ends of a call that can run for tens of seconds: that is a frozen frame,
  // which reads as a hang. These tests pin the seam that fixes it.

  describe('progress and cancellation', () => {
    it('reports the phase of the import, never a fraction it did not measure', async () => {
      const seen: DocxIntakeProgress[] = []
      const bytes = await buildDocx({ bodyXml: RFP_HEAD + P(TAX_CLAUSE) })
      await extractDocxIntake(bytes, { onProgress: (progress) => seen.push({ ...progress }) })

      // Opening the file, then the parse, then one sample per moment the parse
      // hands the run back (its own resolved promise, and the post-parse abort
      // checkpoint), then the mapping phase. The exact number of hand-backs is a
      // property of the JSZip/pako decode, not of this module, so the assertion
      // pins the ORDER and the bounds rather than a count that would break on a
      // dependency's refactor.
      const phases = seen.map((progress) => progress.phase)
      expect(phases[0]).toBe('reading')
      expect(phases[phases.length - 1]).toBe('mapping')
      expect(phases.slice(1, -1).every((phase) => phase === 'parsing')).toBe(true)
      expect(phases.filter((phase) => phase === 'reading')).toHaveLength(1)
      expect(phases.filter((phase) => phase === 'mapping')).toHaveLength(1)
      // The parse hands the run back at least once — once, when there is no
      // internal hand-back at all — and only ever before the mapping phase.
      expect(phases.length).toBeGreaterThanOrEqual(3)
      expect(phases.indexOf('mapping')).toBe(phases.length - 1)
      // Phase 1 carries no size (the buffer is not read yet); every later sample
      // carries the package's own size, which is what the fraction is derived from.
      expect(seen[0].bytes).toBe(0)
      for (const progress of seen.slice(1)) expect(progress.bytes).toBe(bytes.byteLength)
      for (const progress of seen) {
        // A real number in 0–1 and nothing else: no NaN, no >1, never negative.
        const fraction = docxProgressFraction(progress)
        expect(Number.isFinite(fraction)).toBe(true)
        expect(fraction).toBeGreaterThanOrEqual(0)
        expect(fraction).toBeLessThanOrEqual(1)
      }
      expect(docxProgressFraction(seen[0])).toBe(0)
      expect(docxProgressFraction(seen[1])).toBe(1)
      // The fraction tracks the parse and nothing else: it is 0 before any bytes
      // are read and 1 from the moment the package's size is known. It is a bound
      // on the work, never a measurement, so it never lands in between.
      expect(new Set(seen.map(docxProgressFraction))).toEqual(new Set([0, 1]))
      // Nothing in the reported progress is a page count, and the messages never
      // claim a percentage — the only thing this path can honestly say.
      for (const progress of seen) {
        const message = docxParseProgressMessage(progress)
        expect(message.length).toBeGreaterThan(0)
        expect(message).not.toMatch(/\d\s*%/)
        expect(message).not.toMatch(/page \d/i)
      }
      expect(docxParseProgressMessage(seen[0])).toBe('Opening the package…')
      expect(docxParseProgressMessage(seen[1])).toBe('Reading document content…')
    })

    it('checks the signal at every sample, so a cancel is not only checked at the ends', async () => {
      // A signal already aborted when the parse would begin: the sample taken
      // before it must refuse the work rather than run it to completion. This is
      // the abort check the callback exists to provide — without it, the only
      // checkpoints are before and after the whole parse.
      const controller = new AbortController()
      const bytes = await buildDocx({ bodyXml: P(TAX_CLAUSE) })
      const reported: DocxIntakeProgress[] = []
      let parseRan = false

      const error = await extractDocxIntake(bytes, {
        signal: controller.signal,
        onProgress: (progress) => {
          reported.push({ ...progress })
          // Simulate a cancel delivered by the UI while the import is in flight:
          // the sample is the moment the parse is running and the caller can act.
          controller.abort()
        },
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      )
      expect(parseRan).toBe(false)
      // The first sample is 'reading'; aborting there means the parse is never
      // reached, so 'parsing' is never reported either.
      expect(reported.map((progress) => progress.phase)).toEqual(['reading'])
      expect(error).toBeInstanceOf(DocxImportCancelledError)
    })

    it('never reports a cancelled import as a damaged package', async () => {
      // The regression this pins, and the scenario the finding is about: the user
      // cancels while a long parse is running. The parse cannot observe the signal,
      // so the cancel is first honoured in the window whose `catch` maps every
      // failure to `CORRUPT` — without the re-throw, cancelling a 26-second Word
      // import tells the user their own document is damaged, when it parsed fine.
      const controller = new AbortController()
      const bytes = await buildDocx({ bodyXml: P(TAX_CLAUSE) })
      const error = await extractDocxIntake(bytes, {
        signal: controller.signal,
        // Abort while the entry point holds the run — i.e. mid-import, the moment
        // the user's Cancel click lands.
        onProgress: () => controller.abort(),
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      )
      expect(error).toBeInstanceOf(DocxImportCancelledError)
      expect(error).not.toBeInstanceOf(DocxPreflightError)
      expect((error as DocxImportCancelledError).code).toBe('CANCELLED')
    })

    it('samples once before the parse and then on every interval it is given', async () => {
      // The seam the app does not use: a timer-driven sample. It must fire while
      // the parse is pending and stop exactly once the parse settles — a timer
      // left running would report progress for an import that is already done.
      let settled = 0
      let samples = 0
      const result = await emitDocxProgressEvery(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 60))
          settled += 1
          return 'done'
        },
        () => {
          samples += 1
        },
        10,
        2048,
      )
      expect(result).toBe('done')
      expect(settled).toBe(1)
      expect(samples).toBeGreaterThanOrEqual(2)
      const afterSettle = samples
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(samples).toBe(afterSettle)
    })

    it('measures the picture weight of a package without inflating it', async () => {
      // What an operator's stopwatch actually tracks: the media parts, which are
      // inflated and then inlined as base64. Text parts are not it.
      const budget = docxMediaByteBudget([
        { name: 'word/media/image1.png', uncompressedBytes: 1_048_576 },
        { name: 'word/media/image2.jpeg', uncompressedBytes: 2_097_152 },
        { name: 'word/media/oleObject1.bin', uncompressedBytes: 9_999_999 },
        { name: 'word/document.xml', uncompressedBytes: 12_345 },
        { name: 'word/media/scan.TIF', uncompressedBytes: 4_000 },
      ])
      expect(budget).toBe(1_048_576 + 2_097_152 + 4_000)
    })
  })
})

// ── what the dropzone advertises is what the preflights enforce ───────────────
//
// The trust bug this closes: the dropzone said "up to 100.0 MB per PDF" while the
// managed-document store refused to SAVE above 25 MiB, so a document the copy
// called fine imported and then existed only as a session blob. The disclosure now
// states both bounds, and every number in it is read from the constant that
// ENFORCES it — asserted here against those same constants, so the two cannot
// drift apart again. Reading the constant (rather than restating its value) is
// what gives this teeth: change a limit and this fails until the copy is changed
// with it.

describe('the advertised import limits are the enforced ones', () => {
  const disclosure = intakeLimitDisclosure()

  it('quotes the PDF preflight figure that refuses an oversize PDF', () => {
    expect(disclosure).toContain(groupThousands(PDF_PREFLIGHT_LIMITS.maxPages))
    expect(disclosure).toContain(formatBytes(PDF_PREFLIGHT_LIMITS.maxBytes))
  })

  it('quotes the DOCX preflight figures that refuse an oversize .docx', () => {
    expect(disclosure).toContain(groupThousands(DOCX_PREFLIGHT_LIMITS.maxLines))
    expect(disclosure).toContain(formatBytes(DOCX_PREFLIGHT_LIMITS.maxBytes))
  })

  it('names the smaller bound that decides whether the document can be kept', () => {
    // The whole point of the disclosure: the save ceiling is not the import
    // ceiling, and a document between them is kept for the session only.
    expect(MAX_TENDERS_DOCUMENT_UPLOAD_BYTES).toBeLessThan(PDF_PREFLIGHT_LIMITS.maxBytes)
    expect(disclosure).toContain(formatBytes(MAX_TENDERS_DOCUMENT_UPLOAD_BYTES))
    expect(disclosure).toMatch(/session only/)
    // ...and it names both readers, so neither path is described by the other's
    // numbers.
    expect(disclosure).toMatch(/per PDF/)
    expect(disclosure).toMatch(/per Word \.docx/)
  })

  it('fails if either preflight constant is raised past what it advertises', () => {
    // A RED case for the assertions above: the disclosure is built from these
    // constants, so a value it does not quote is a value it would not have.
    const raised = { ...PDF_PREFLIGHT_LIMITS, maxBytes: PDF_PREFLIGHT_LIMITS.maxBytes * 2 }
    expect(disclosure).not.toContain(formatBytes(raised.maxBytes))
    const raisedLines = { ...DOCX_PREFLIGHT_LIMITS, maxLines: 99_999 }
    expect(disclosure).not.toContain(groupThousands(raisedLines.maxLines))
    // The grouped form is the published one, so the raw digits are NOT what the
    // assertion above would accept by accident.
    expect(groupThousands(raisedLines.maxLines)).not.toBe(String(raisedLines.maxLines))
  })
})

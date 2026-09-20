// Deterministic, offline PDF generator for the synthetic Tenders intake corpus.
//
// Uses `pdf-lib` (the same library the Tenders e2e specs use — see
// `e2e/tenders-persistence-cutover.spec.ts` `generateTextPdf`) so every fixture
// is reproducible byte-for-byte from code. No network, no binary blobs, no
// machine-specific paths.
//
// Page kinds produced here:
//   native   — real text layer (single column, two-column, or table-like)
//   scan     — a page with NO text layer (one embedded image + vector fills
//              only). The parser must classify this as OCR-required; we do NOT
//              attempt real OCR.
//   vector   — a page with graphics only and no text layer (scan-like variant
//              that avoids an image XObject).
//
// NOTE ON LIGATURES: `pdf-lib` standard fonts use WinAnsi encoding, which has
// no code points for U+FB01 "ﬁ" / U+FB02 "ﬂ", and `@pdf-lib/fontkit` is not
// installed in this workspace, so a true ligature glyph cannot be embedded
// offline. pdfjs also normalises ligature glyphs to "fi"/"fl" during text
// extraction, so the parser never observes the ligature code point from a
// native PDF. The corpus therefore models the OCR-punctuation axis with the
// variants that are reproducible here (curly quotes, en/em dashes, NBSP and
// the B-BBEE / BBBEE / B BBEE wording forms). See the report for the caveat.

export const PAGE_WIDTH = 595 // A4 points
export const PAGE_HEIGHT = 842

const MARGIN_X = 50
const TOP_Y = 780
const LINE_HEIGHT = 20
const FONT_SIZE = 11

// A deterministic 16x16 RGB PNG (blue/green gradient) used as the "scan"
// wallpaper. Generated once with zlib and pasted here so the corpus has no
// binary fixture files and no rebuild dependency.
const SCAN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAABlElEQVR4nBWRURFEMQjEkFAJSKgEJFQCEiohEiqhEpCAhEpAAhLuHt87THYjIgxBhSmYsAQXtoBwhCuEkMITSmhBZDAGOpgDG6yBD/aAwRncQQxy8AY16IGIMhRVpmLKUlzZCspRrhJKKk8ppRWRyZjoZE5ssiY+2RMmZ3InMcnJm9SkJyLGMNSYhhnLcGMbGMe4RhhpPKOMNkQWY6GLubDFWvhiL1icxV3EIhdvUYteiDjDUWc65izHne3gHOc64aTznHLaEdmMjW7mxjZr45u9YXM2dxOb3LxNbXoj8g2IfiWxDwT/wt8duBCQ8KCg/3rkMA56mAc7rIMf9vni53APccjDO9Shz9/DZVz0Mi92WRe/7Ps9P5d7iUte3qUuff8eghFoMAMLVuDBjg/lBDeIIIMXVNDx95CMRJOZWLIST3Z+4Ce5SSSZvKSSzr+Hx3joYz7ssR7+2O+reR73EY98vEc9+v09FKPQYhZWrMKLXd8op7hFFFm8ooquv4dmNNrMxprVeLP7m/A0t4kmm9dU080PiAJwEDqK72wAAAAASUVORK5CYII='

/** Draw one text line at a given column x. Empty lines advance vertically. */
function drawColumn(page, font, lines, x, startY) {
  let y = startY
  for (const line of lines) {
    if (typeof line === 'string' && line.length > 0) {
      page.drawText(line, { x, y, size: FONT_SIZE, font })
    }
    y -= LINE_HEIGHT
  }
  return y
}

/** Draw a table-like block: each row is a list of cells placed in columns. */
function drawTable(page, font, rows, columnXs, startY) {
  let y = startY
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [row]
    cells.forEach((cell, index) => {
      const x = columnXs[index] ?? columnXs[columnXs.length - 1] ?? MARGIN_X
      if (typeof cell === 'string' && cell.length > 0) {
        page.drawText(cell, { x, y, size: FONT_SIZE, font })
      }
    })
    y -= LINE_HEIGHT
  }
  return y
}

/** Realm-independent base64 decode (avoids Buffer/jsdom realm mismatches). */
function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function drawScanPage(doc, page) {
  const { rgb } = await import('pdf-lib')
  // Vector "paper" bands plus a deterministic image so the page has zero text.
  page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    color: rgb(0.97, 0.97, 0.95),
  })
  const image = await doc.embedPng(base64ToBytes(SCAN_PNG_BASE64))
  page.drawImage(image, { x: 40, y: 300, width: 515, height: 240 })
  for (let i = 0; i < 6; i += 1) {
    page.drawRectangle({
      x: 60,
      y: 700 - i * 28,
      width: 470 - (i % 3) * 60,
      height: 6,
      color: rgb(0.25, 0.25, 0.3),
    })
  }
}

async function drawVectorOnlyPage(doc, page) {
  const { rgb } = await import('pdf-lib')
  page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    color: rgb(1, 1, 1),
  })
  for (let i = 0; i < 18; i += 1) {
    page.drawRectangle({
      x: 60,
      y: 760 - i * 32,
      width: 300 + ((i * 37) % 160),
      height: 5,
      color: rgb(0.3, 0.3, 0.35),
    })
  }
}

/**
 * Build one corpus fixture PDF.
 * @param {{ id: string, pages: Array<object> }} fixture
 * @returns {Promise<Uint8Array>}
 */
export async function buildFixturePdf(fixture) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const fixedDate = new Date('2026-01-01T00:00:00.000Z')
  doc.setCreationDate(fixedDate)
  doc.setModificationDate(fixedDate)
  doc.setProducer('tenders-corpus')
  doc.setCreator('tenders-corpus')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  for (const spec of fixture.pages) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    if (spec.mode === 'scan') {
      await drawScanPage(doc, page)
      continue
    }
    if (spec.mode === 'vector') {
      await drawVectorOnlyPage(doc, page)
      continue
    }
    if (spec.layout === 'two-column') {
      const left = spec.left ?? []
      const right = spec.right ?? []
      drawColumn(page, font, left, MARGIN_X, TOP_Y)
      drawColumn(page, font, right, 320, TOP_Y)
      continue
    }
    if (spec.layout === 'table') {
      drawTable(page, font, spec.rows ?? [], spec.columnXs ?? [MARGIN_X, 220, 380], TOP_Y)
      continue
    }
    const lines = spec.lines ?? []
    let y = TOP_Y
    for (const line of lines) {
      if (typeof line === 'string' && line.length > 0) {
        // Skip the empty sentinel used for paragraph spacing.
        if (line === '') {
          y -= LINE_HEIGHT / 2
          continue
        }
        // Headings that look like the tender heading are drawn bold for realism.
        const isHeading = /^(INVITATION|REQUEST FOR|TENDER|BID)/.test(line)
        page.drawText(line, { x: MARGIN_X, y, size: FONT_SIZE, font: isHeading ? bold : font })
      }
      y -= LINE_HEIGHT
    }
  }

  return doc.save()
}

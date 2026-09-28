/**
 * The A4 tax-invoice / credit-note PDF builder (pdf-lib). Kept in its own
 * module so only the main process — the only place a PDF is ever built —
 * pays for the dependency, and the renderer bundle does not.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import { round2 } from './accounting'
import { DEFAULT_INVOICE_ACCENT, isValidInvoiceAccent } from './chart'
import type { CompanySettings, Invoice, PrintTemplate } from './types'
const PAGE_W = 595.28 // A4 portrait, points
const PAGE_H = 841.89
const MARGIN = 48
const CONTENT_W = PAGE_W - MARGIN * 2

const COLOR_DARK = rgb(0.117, 0.161, 0.231)
const COLOR_GRAY = rgb(0.486, 0.486, 0.486)
const COLOR_LINE = rgb(0.929, 0.929, 0.929)
const COLOR_LIGHT = rgb(0.973, 0.973, 0.973)
const COLOR_ACCENT = rgb(0.047, 0.463, 0.435)
const COLOR_WHITE = rgb(1, 1, 1)

/** Height of the modern template's full-width accent header band (points). */
const MODERN_BAND_H = 64
/** Opacity of the modern template's tinted table-header row. */
const MODERN_TINT_OPACITY = 0.14
/** The footer line every template draws when no letterhead footer is set. */
const DEFAULT_FOOTER_TEXT = 'Generated via Zano Books — Sovereign Financial Management'

/** A #RRGGBB literal as pdf-lib RGB. */
function hexToRgb(hex: string): RGB {
  const value = parseInt(hex.slice(1), 16)
  return rgb(((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255)
}

export function formatMoney(amount: number, symbol: string): string {
  return `${symbol} ${amount.toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = String(text || '')
    .split(/\s+/)
    .filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate
    } else {
      if (current) lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

/** The marker appended to a clipped cell. WinAnsi (the standard fonts' encoding) cannot represent U+2026, so three periods are used. */
const CLIP_MARKER = '...'

/**
 * Drops trailing characters until the text plus a clip marker fits the column,
 * so the reader can see the value was cut rather than silently truncated.
 */
function clipText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const raw = String(text || '')
  if (font.widthOfTextAtSize(raw, size) <= maxWidth) return raw

  let out = raw
  while (out.length > 0 && font.widthOfTextAtSize(`${out}${CLIP_MARKER}`, size) > maxWidth) {
    out = out.slice(0, -1)
  }
  if (out.length === 0) {
    // Not even the marker fits beside a single character: mark as much of the
    // cell as possible so the cell is never silently blank.
    return font.widthOfTextAtSize(CLIP_MARKER, size) <= maxWidth ? CLIP_MARKER : ''
  }
  return `${out}${CLIP_MARKER}`
}

/**
 * Renders text inside a bounded column: full size when it fits, otherwise the
 * largest font size down to `minSize` that fits without an ellipsis, otherwise
 * the text clipped at `minSize`. Returns what is actually drawn so callers can
 * measure exactly what lands on the page.
 */
function fitCell(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  minSize = 6,
): { text: string; size: number } {
  const raw = String(text || '')
  if (font.widthOfTextAtSize(raw, size) <= maxWidth) return { text: raw, size }

  for (let candidate = size - 0.5; candidate >= minSize; candidate -= 0.5) {
    if (font.widthOfTextAtSize(raw, candidate) <= maxWidth) return { text: raw, size: candidate }
  }
  return { text: clipText(raw, font, minSize, maxWidth), size: minSize }
}

/** One right-aligned table column: where its text ends and how much room it gets. */
interface PdfColumn {
  right: number
  width: number
}

/**
 * Builds a real A4 PDF tax invoice / credit note with pdf-lib. Multi-page
 * documents repeat the line-items header and carry the footer and a
 * 'Page N of M' marker on every page. Pure: returns the PDF bytes; never
 * writes to disk.
 */
export async function buildInvoicePdf(
  invoice: Invoice,
  settings: CompanySettings,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  let page: PDFPage = pdfDoc.addPage([PAGE_W, PAGE_H])

  const symbol = settings.currencySymbol || 'R'
  // The document prints in the INVOICE'S currency (the same contract the print
  // preview implements, and what the ledger stores: the invoice's own totals
  // stay in `currency` — that is what the printed document shows). A
  // foreign-currency invoice's amounts are labelled with its ISO code — never
  // the base symbol against foreign figures — and an FX note under the totals
  // gives the base-currency equivalent at the invoice's stored rate.
  const invoiceCurrencyCode = (invoice.currency || '').trim()
  const baseCurrencyCode = (settings.currency || 'ZAR').trim().toUpperCase()
  const isForeignCurrency =
    Boolean(invoiceCurrencyCode) &&
    invoiceCurrencyCode.toUpperCase() !== baseCurrencyCode
  const moneySymbol = isForeignCurrency ? invoiceCurrencyCode.toUpperCase() : symbol
  const rightX = PAGE_W - MARGIN
  let y = PAGE_H - MARGIN

  // --- Template & accent resolution ---
  // classic keeps its historical palette byte-for-byte: the built-in accent
  // constant stays in play until the user picks a different colour, and the
  // letterhead footer only extends the existing footer line. modern draws the
  // settings accent everywhere (the default `#0F766E` when none is stored).
  const template: PrintTemplate = settings.printTemplate === 'modern' ? 'modern' : 'classic'
  const accentChanged =
    isValidInvoiceAccent(settings.invoiceAccent) &&
    settings.invoiceAccent.toUpperCase() !== DEFAULT_INVOICE_ACCENT.toUpperCase()
  const accent =
    template === 'modern' || accentChanged
      ? hexToRgb(
          isValidInvoiceAccent(settings.invoiceAccent)
            ? settings.invoiceAccent
            : DEFAULT_INVOICE_ACCENT,
        )
      : COLOR_ACCENT
  const letterhead = (settings.letterheadFooter || '').trim()

  const draw = (
    font: PDFFont,
    size: number,
    text: string,
    x: number,
    color: RGB,
    align: 'left' | 'right' = 'left',
    rightEdge: number = rightX,
  ): void => {
    const width = font.widthOfTextAtSize(text, size)
    page.drawText(text, {
      x: align === 'right' ? rightEdge - width : x,
      y: y - size,
      size,
      font,
      color,
    })
  }
  const down = (gap: number): void => {
    y -= gap
  }
  const divider = (color: RGB = COLOR_LINE): void => {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: rightX, y },
      thickness: 0.75,
      color,
    })
    y -= 1
  }

  // --- Line items table geometry ---
  // Every column is a bounded box whose room is capped at its own gap to the
  // next column, so two adjacent cells can never meet on the page.
  const colDesc = MARGIN
  const colQty = 305
  const colRate: PdfColumn = { right: 358, width: 48 }
  const colTax: PdfColumn = { right: 432, width: 70 }
  const colAmount: PdfColumn = { right: 547.28, width: 110 }
  const descWidth = colQty - colDesc - 8
  const qtyDescWidth = colRate.right - colRate.width - (colQty + 1) - 6
  const HEADER_ROW_H = 26

  /** Draws one line-items table header row at the current `y`. */
  const drawTableHeader = (): void => {
    if (template === 'modern') {
      page.drawRectangle({
        x: MARGIN,
        y: y - 15,
        width: CONTENT_W,
        height: 16,
        color: accent,
        opacity: MODERN_TINT_OPACITY,
      })
    } else {
      page.drawRectangle({
        x: MARGIN,
        y: y - 15,
        width: CONTENT_W,
        height: 16,
        color: COLOR_LIGHT,
      })
    }
    draw(bold, 8.5, 'Description', colDesc, COLOR_GRAY)
    draw(regular, 8.5, 'Qty', colQty + 1, COLOR_GRAY)
    draw(regular, 8.5, 'Rate', colRate.right, COLOR_GRAY, 'right', colRate.right)
    draw(regular, 8.5, 'Tax', colTax.right, COLOR_GRAY, 'right', colTax.right)
    draw(regular, 8.5, 'Amount', colAmount.right, COLOR_GRAY, 'right', colAmount.right)
    down(18)
  }

  const ensureRoom = (needed: number): void => {
    if (y - needed < 60) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H])
      y = PAGE_H - MARGIN
    }
  }

  /** Breaks to a new page when the next table row would not fit, repeating the header. */
  const ensureRowRoom = (): void => {
    if (y - HEADER_ROW_H < 60) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H])
      y = PAGE_H - MARGIN
      drawTableHeader()
    }
  }

  // --- Header: issuer (left) + document title/meta (right) ---
  const title = invoice.creditNote ? 'CREDIT NOTE' : 'TAX INVOICE'
  const companyName = settings.companyName || 'Company Name'
  if (template === 'modern') {
    // The modern template opens with a full-width accent band carrying the
    // issuer and the document title in white; the meta block starts below it.
    page.drawRectangle({
      x: 0,
      y: PAGE_H - MODERN_BAND_H,
      width: PAGE_W,
      height: MODERN_BAND_H,
      color: accent,
    })
    page.drawText(companyName, {
      x: MARGIN,
      y: PAGE_H - 40,
      size: 18,
      font: bold,
      color: COLOR_WHITE,
    })
    page.drawText(title, {
      x: rightX - bold.widthOfTextAtSize(title, 16),
      y: PAGE_H - 40,
      size: 16,
      font: bold,
      color: COLOR_WHITE,
    })
    y = PAGE_H - MODERN_BAND_H - 14
  } else {
    draw(bold, 18, companyName, MARGIN, COLOR_DARK)
    draw(bold, 16, title, rightX, COLOR_DARK, 'right')
    down(26)
  }

  draw(regular, 9, `VAT Reg: ${settings.taxNumber || '-'}`, MARGIN, COLOR_GRAY)
  draw(bold, 11, invoice.invoiceNumber || '', rightX, COLOR_DARK, 'right')
  down(15)

  if (settings.address) {
    draw(regular, 9, settings.address, MARGIN, COLOR_GRAY)
  }
  draw(regular, 9, `Date: ${invoice.date || '-'}`, rightX, COLOR_GRAY, 'right')
  down(14)

  const contact = [settings.email, settings.phone].filter(Boolean).join('  ·  ')
  if (contact) {
    draw(regular, 9, contact, MARGIN, COLOR_GRAY)
  }
  draw(regular, 9, `Due: ${invoice.dueDate || '-'}`, rightX, COLOR_GRAY, 'right')
  down(14)

  draw(regular, 9, `Status: ${(invoice.status || '').toUpperCase()}`, rightX, COLOR_GRAY, 'right')
  down(14)

  draw(bold, 9, `Billed To: ${invoice.partyName || '-'}`, rightX, COLOR_DARK, 'right')
  down(14)

  if (invoice.tenderReference) {
    draw(regular, 9, `Reference: ${invoice.tenderReference}`, rightX, COLOR_DARK, 'right')
    down(14)
  }

  down(10)
  divider()
  down(22)

  // --- Line items table ---
  drawTableHeader()

  const items = Array.isArray(invoice.items) ? invoice.items : []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    ensureRowRoom()
    if (i % 2 === 1) {
      page.drawRectangle({
        x: MARGIN,
        y: y - 13,
        width: CONTENT_W,
        height: 14,
        color: COLOR_LIGHT,
      })
    }
    const desc = fitCell(it.description || `Item ${i + 1}`, regular, 9, descWidth)
    const qty = fitCell(
      Number(it.qty).toLocaleString('en-ZA', { maximumFractionDigits: 2 }),
      regular,
      9,
      qtyDescWidth,
    )
    const rate = fitCell(formatMoney(Number(it.rate) || 0, moneySymbol), regular, 9, colRate.width)
    const tax = fitCell(`${Number(it.taxRate) || 0}%`, regular, 9, colTax.width)
    const amount = fitCell(formatMoney(Number(it.amount) || 0, moneySymbol), regular, 9, colAmount.width)

    draw(regular, desc.size, desc.text, colDesc, COLOR_DARK)
    draw(regular, qty.size, qty.text, colQty + 1, COLOR_DARK)
    draw(regular, rate.size, rate.text, colRate.right, COLOR_DARK, 'right', colRate.right)
    draw(regular, tax.size, tax.text, colTax.right, COLOR_DARK, 'right', colTax.right)
    draw(regular, amount.size, amount.text, colAmount.right, COLOR_DARK, 'right', colAmount.right)
    down(20)
  }

  down(8)
  // The "totals rule": modern always draws it in the accent, classic only
  // when the user picked a colour other than the built-in teal.
  divider(template === 'modern' || accentChanged ? accent : COLOR_LINE)
  down(18)

  // --- Totals block ---
  const taxLabelRate = Number(items[0]?.taxRate) || settings.defaultTaxRate || 15
  const drawTotal = (
    label: string,
    value: string,
    opts: { font?: PDFFont; color?: RGB; size?: number } = {},
  ): void => {
    const font = opts.font || regular
    const size = opts.size || 9
    const color = opts.color || COLOR_DARK
    const labelWidth = rightX - size * 17 - MARGIN
    draw(font, size, fitCell(label, font, size, labelWidth).text, MARGIN, color)
    // The value column is bounded too, so an extreme stored total cannot run
    // off the page edge or reach back into the label.
    draw(font, size, fitCell(value, font, size, size * 17).text, rightX, color, 'right')
    down(size + 8)
  }

  drawTotal('Subtotal', formatMoney(Number(invoice.subtotal) || 0, moneySymbol))
  drawTotal(`VAT / Tax (${taxLabelRate}%)`, formatMoney(Number(invoice.taxTotal) || 0, moneySymbol))
  if (invoice.roundOff !== undefined && round2(invoice.roundOff) !== 0) {
    drawTotal('Round-off', formatMoney(round2(invoice.roundOff), moneySymbol))
  }
  drawTotal('Grand Total', formatMoney(Number(invoice.grandTotal) || 0, moneySymbol), {
    font: bold,
    size: 11,
    // modern emphasises the totals row in the accent; classic keeps its dark
    // grand total unless the accent was changed (see the Amount Due colour).
    color: template === 'modern' ? accent : COLOR_DARK,
  })
  down(2)
  drawTotal('Amount Due', formatMoney(Number(invoice.outstandingAmount) || 0, moneySymbol), {
    font: bold,
    size: 11,
    color: template === 'modern' || accentChanged ? accent : COLOR_ACCENT,
  })

  // FX note: a foreign-currency document carries its own-currency figures AND
  // the base-currency equivalent at the invoice's stored rate, so the reader
  // (and a VAT audit) can reconcile the document to the ledger's base posting.
  if (isForeignCurrency) {
    const rate = Number(invoice.exchangeRate)
    const fxRate = Number.isFinite(rate) && rate > 0 ? rate : 1
    down(2)
    draw(
      regular,
      8,
      `Exchange rate: 1 ${moneySymbol} = ${fxRate.toFixed(2)} ${baseCurrencyCode} · Base grand total: ${formatMoney(round2((Number(invoice.grandTotal) || 0) * fxRate), symbol)}`,
      MARGIN,
      COLOR_DARK,
    )
    down(14)
  }

  // --- Notes ---
  down(10)
  draw(bold, 9, 'Notes & Payment Terms', MARGIN, COLOR_DARK)
  down(14)
  const notes = wrapText(
    invoice.notes || 'Payment terms: Net 30 days upon invoice receipt.',
    regular,
    9,
    CONTENT_W,
  )
  for (const noteLine of notes) {
    ensureRoom(12)
    draw(regular, 9, noteLine, MARGIN, COLOR_GRAY)
    down(12)
  }

  // --- Footer & page numbers on every page ---
  // The letterhead footer rides the existing footer line: classic appends it
  // after the generated-by text, modern replaces that text with it. The line
  // is clipped so it can never run into the right-aligned page marker.
  const footerText =
    template === 'modern'
      ? letterhead || DEFAULT_FOOTER_TEXT
      : letterhead
        ? `${DEFAULT_FOOTER_TEXT}  ·  ${letterhead}`
        : DEFAULT_FOOTER_TEXT
  const pageCount = pdfDoc.getPageCount()
  for (let index = 0; index < pageCount; index++) {
    const footerPage = pdfDoc.getPage(index)
    footerPage.drawLine({
      start: { x: MARGIN, y: 56 },
      end: { x: rightX, y: 56 },
      thickness: 0.75,
      color: COLOR_LINE,
    })
    const marker = `Page ${index + 1} of ${pageCount}`
    const markerWidth = regular.widthOfTextAtSize(marker, 8)
    footerPage.drawText(clipText(footerText, regular, 8, rightX - MARGIN - markerWidth - 12), {
      x: MARGIN,
      y: 40,
      size: 8,
      font: regular,
      color: COLOR_GRAY,
    })
    footerPage.drawText(marker, {
      x: rightX - markerWidth,
      y: 40,
      size: 8,
      font: regular,
      color: COLOR_GRAY,
    })
  }

  // Document metadata (viewers show this in the title bar).
  pdfDoc.setTitle(
    `${invoice.creditNote ? 'Credit Note' : 'Tax Invoice'} ${invoice.invoiceNumber || ''}`.trim(),
  )
  pdfDoc.setAuthor(settings.companyName || '')

  return pdfDoc.save()
}

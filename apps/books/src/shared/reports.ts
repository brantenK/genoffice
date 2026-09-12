import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import { round2 } from './accounting'
import type { CompanySettings, Invoice, Party } from './types'

/**
 * Pure, framework-free report builders (aging analysis, VAT tax register)
 * and the real-PDF invoice generator. No electron/react imports — safe to
 * run in the main process, the renderer, and vitest.
 */

export interface AgingRow {
  partyId: string
  partyName: string
  current: number
  days30: number
  days60: number
  days90: number
  total: number
}

export interface TaxRegisterRow {
  /** null marks the grand TOTAL row. */
  taxRate: number | null
  salesTaxable: number
  salesTax: number
  purchaseTaxable: number
  purchaseTax: number
}

/** Whole days from `fromIso` to `toIso` (YYYY-MM-DD), timezone-safe (UTC math). */
export function daysBetween(fromIso: string, toIso: string): number {
  const parseDay = (iso: string): number => {
    const [y, m, d] = String(iso || '')
      .split('-')
      .map(Number)
    return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)
      ? Date.UTC(y, m - 1, d)
      : NaN
  }
  const from = parseDay(fromIso)
  const to = parseDay(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.round((to - from) / 86400000)
}

/**
 * AR/AP aging buckets for one invoice direction. Only open invoices count
 * (status not Paid/Cancelled/Draft and outstandingAmount > 0). Buckets are
 * keyed by days overdue (asOf minus dueDate): <=0 current, 1-30 days30,
 * 31-60 days60, >60 days90. One row per party, sorted by total descending.
 */
export function agingBuckets(
  invoices: Invoice[],
  parties: Party[],
  asOf: string,
  type: 'Sales' | 'Purchase',
): AgingRow[] {
  const partyNameById = new Map((parties || []).map((p) => [p.id, p.name]))

  const open = (invoices || []).filter(
    (inv) =>
      inv.type === type &&
      inv.status !== 'Paid' &&
      inv.status !== 'Cancelled' &&
      inv.status !== 'Draft' &&
      round2(inv.outstandingAmount || 0) > 0,
  )

  const rows = new Map<string, AgingRow>()
  for (const inv of open) {
    const daysOverdue = daysBetween(inv.dueDate, asOf)
    const amount = round2(inv.outstandingAmount)
    const partyId = inv.partyId || `party-${inv.partyName || inv.invoiceNumber}`

    let row = rows.get(partyId)
    if (!row) {
      row = {
        partyId,
        partyName: partyNameById.get(partyId) || inv.partyName || 'Unknown',
        current: 0,
        days30: 0,
        days60: 0,
        days90: 0,
        total: 0,
      }
      rows.set(partyId, row)
    }

    if (daysOverdue <= 0) row.current = round2(row.current + amount)
    else if (daysOverdue <= 30) row.days30 = round2(row.days30 + amount)
    else if (daysOverdue <= 60) row.days60 = round2(row.days60 + amount)
    else row.days90 = round2(row.days90 + amount)
    row.total = round2(row.total + amount)
  }

  return Array.from(rows.values()).sort((a, b) => b.total - a.total)
}

/**
 * VAT register: per distinct item taxRate, per direction (Sales/Purchase).
 * Every non-draft, non-cancelled invoice is included. Line amounts feed the
 * taxable base (discountRate applied when present: amount*(1-discountRate/100))
 * and item tax is round2(effective * taxRate / 100). The last row (taxRate
 * null) sums everything.
 */
export function taxRegister(invoices: Invoice[]): TaxRegisterRow[] {
  const posted = (invoices || []).filter(
    (inv) => inv.status !== 'Draft' && inv.status !== 'Cancelled',
  )

  const totals: TaxRegisterRow = {
    taxRate: null,
    salesTaxable: 0,
    salesTax: 0,
    purchaseTaxable: 0,
    purchaseTax: 0,
  }
  const byRate = new Map<number, TaxRegisterRow>()

  for (const inv of posted) {
    // Credit notes reduce the VAT register: their reversal journals debit
    // VAT output (sales) / credit VAT input (purchase), so the register must
    // NET them — otherwise the SARS output VAT is overstated.
    const sign = inv.creditNote ? -1 : 1
    for (const item of inv.items || []) {
      const discount = round2(item.discountRate || 0)
      const effective = round2((item.amount || 0) * (1 - discount / 100))
      const rate = round2(Number(item.taxRate) || 0)
      const tax = round2((effective * rate) / 100)

      let row = byRate.get(rate)
      if (!row) {
        row = {
          taxRate: rate,
          salesTaxable: 0,
          salesTax: 0,
          purchaseTaxable: 0,
          purchaseTax: 0,
        }
        byRate.set(rate, row)
      }

      if (inv.type === 'Sales') {
        row.salesTaxable = round2(row.salesTaxable + sign * effective)
        row.salesTax = round2(row.salesTax + sign * tax)
        totals.salesTaxable = round2(totals.salesTaxable + sign * effective)
        totals.salesTax = round2(totals.salesTax + sign * tax)
      } else {
        row.purchaseTaxable = round2(row.purchaseTaxable + sign * effective)
        row.purchaseTax = round2(row.purchaseTax + sign * tax)
        totals.purchaseTaxable = round2(totals.purchaseTaxable + sign * effective)
        totals.purchaseTax = round2(totals.purchaseTax + sign * tax)
      }
    }
  }

  const rows = Array.from(byRate.values()).sort((a, b) => (a.taxRate ?? 0) - (b.taxRate ?? 0))
  rows.push(totals)
  return rows
}

const PAGE_W = 595.28 // A4 portrait, points
const PAGE_H = 841.89
const MARGIN = 48
const CONTENT_W = PAGE_W - MARGIN * 2

const COLOR_DARK = rgb(0.117, 0.161, 0.231)
const COLOR_GRAY = rgb(0.486, 0.486, 0.486)
const COLOR_LINE = rgb(0.929, 0.929, 0.929)
const COLOR_LIGHT = rgb(0.973, 0.973, 0.973)
const COLOR_ACCENT = rgb(0.047, 0.463, 0.435)

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

function fitText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  let out = String(text || '')
  while (out.length > 0 && font.widthOfTextAtSize(out, size) > maxWidth) {
    out = out.slice(0, -1)
  }
  if (out !== String(text || '')) out = `${out}…`
  return out
}

/**
 * Builds a real A4 PDF tax invoice / credit note with pdf-lib.
 * Pure: returns the PDF bytes; never writes to disk.
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
  const rightX = PAGE_W - MARGIN
  let y = PAGE_H - MARGIN

  const draw = (
    font: PDFFont,
    size: number,
    text: string,
    x: number,
    color: RGB,
    align: 'left' | 'right' = 'left',
  ): void => {
    const width = font.widthOfTextAtSize(text, size)
    page.drawText(text, {
      x: align === 'right' ? rightX - width : x,
      y: y - size,
      size,
      font,
      color,
    })
  }
  const down = (gap: number): void => {
    y -= gap
  }
  const divider = (): void => {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: rightX, y },
      thickness: 0.75,
      color: COLOR_LINE,
    })
    y -= 1
  }
  const ensureRoom = (needed: number): void => {
    if (y - needed < 60) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H])
      y = PAGE_H - MARGIN
    }
  }

  // --- Header: issuer (left) + document title/meta (right) ---
  const title = invoice.creditNote ? 'CREDIT NOTE' : 'TAX INVOICE'
  draw(bold, 18, settings.companyName || 'Company Name', MARGIN, COLOR_DARK)
  draw(bold, 16, title, rightX, COLOR_DARK, 'right')
  down(26)

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
  const colDesc = MARGIN
  const colQty = 305
  const colRate = 355
  const colTax = 420
  const colAmount = 470

  const headerBg: RGB = COLOR_LIGHT
  page.drawRectangle({
    x: MARGIN,
    y: y - 15,
    width: CONTENT_W,
    height: 16,
    color: headerBg,
  })
  draw(bold, 8.5, 'Description', colDesc, COLOR_GRAY)
  draw(regular, 8.5, 'Qty', colQty + 1, COLOR_GRAY)
  draw(regular, 8.5, 'Rate', colRate, COLOR_GRAY, 'right')
  draw(regular, 8.5, 'Tax', colTax, COLOR_GRAY, 'right')
  draw(regular, 8.5, 'Amount', colAmount, COLOR_GRAY, 'right')
  down(18)

  const items = Array.isArray(invoice.items) ? invoice.items : []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    ensureRoom(26)
    if (i % 2 === 1) {
      page.drawRectangle({
        x: MARGIN,
        y: y - 13,
        width: CONTENT_W,
        height: 14,
        color: COLOR_LIGHT,
      })
    }
    draw(
      regular,
      9,
      fitText(it.description || `Item ${i + 1}`, regular, 9, colQty - colDesc - 14),
      colDesc,
      COLOR_DARK,
    )
    draw(
      regular,
      9,
      Number(it.qty).toLocaleString('en-ZA', { maximumFractionDigits: 2 }),
      colQty + 1,
      COLOR_DARK,
    )
    draw(regular, 9, formatMoney(Number(it.rate) || 0, symbol), colRate, COLOR_DARK, 'right')
    draw(regular, 9, `${Number(it.taxRate) || 0}%`, colTax, COLOR_DARK, 'right')
    draw(regular, 9, formatMoney(Number(it.amount) || 0, symbol), colAmount, COLOR_DARK, 'right')
    down(20)
  }

  down(8)
  divider()
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
    draw(font, size, label, rightX - 190, color)
    draw(font, size, value, rightX, color, 'right')
    down(size + 8)
  }

  drawTotal('Subtotal', formatMoney(Number(invoice.subtotal) || 0, symbol))
  drawTotal(`VAT / Tax (${taxLabelRate}%)`, formatMoney(Number(invoice.taxTotal) || 0, symbol))
  if (invoice.roundOff !== undefined && round2(invoice.roundOff) !== 0) {
    drawTotal('Round-off', formatMoney(round2(invoice.roundOff), symbol))
  }
  drawTotal('Grand Total', formatMoney(Number(invoice.grandTotal) || 0, symbol), {
    font: bold,
    size: 11,
  })
  down(2)
  drawTotal('Amount Due', formatMoney(Number(invoice.outstandingAmount) || 0, symbol), {
    font: bold,
    size: 11,
    color: COLOR_ACCENT,
  })

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

  // --- Footer ---
  const firstPage = pdfDoc.getPage(0)
  firstPage.drawText('Generated via Zano Books — Sovereign Financial Management', {
    x: MARGIN,
    y: 40,
    size: 8,
    font: regular,
    color: COLOR_GRAY,
  })

  // Document metadata (viewers show this in the title bar).
  pdfDoc.setTitle(
    `${invoice.creditNote ? 'Credit Note' : 'Tax Invoice'} ${invoice.invoiceNumber || ''}`.trim(),
  )
  pdfDoc.setAuthor(settings.companyName || '')

  return pdfDoc.save()
}

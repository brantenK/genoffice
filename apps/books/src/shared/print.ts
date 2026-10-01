/**
 * Print-document semantics shared by the PDF builders (main process) and the
 * print previews (renderer): the title each document direction maps to, the
 * VAT totals row's label, and the discount the totals block prints. Pure text
 * rules — no pdf-lib import here, so the renderer bundle never pays for it.
 */
import { round2 } from './accounting'
import type { Invoice, InvoiceItem } from './types'

/** The document title a stored invoice prints as, by its direction. */
export function invoiceDocumentTitle(invoice: Pick<Invoice, 'type' | 'creditNote'>): string {
  if (invoice.creditNote) return 'CREDIT NOTE'
  return invoice.type === 'Purchase' ? 'PURCHASE BILL' : 'TAX INVOICE'
}

/** The metadata title (viewers show it in the title bar), in title case. */
export function invoiceDocumentMetaTitle(
  invoice: Pick<Invoice, 'type' | 'creditNote'>,
): string {
  if (invoice.creditNote) return 'Credit Note'
  return invoice.type === 'Purchase' ? 'Purchase Bill' : 'Tax Invoice'
}

/** Every distinct tax rate among the lines, rounded like the totals engine. */
export function distinctLineTaxRates(items: InvoiceItem[]): number[] {
  const rates = new Set<number>()
  for (const item of Array.isArray(items) ? items : []) {
    rates.add(round2(Number(item.taxRate) || 0))
  }
  return Array.from(rates)
}

/**
 * The label of the VAT totals row. The rate is printed only when every line
 * carries the same non-zero rate AND the document actually charges VAT — a
 * 0% or mixed-rate document prints a bare label, because a rate shown beside
 * the total would otherwise be a guess.
 */
export function vatTaxLabel(items: InvoiceItem[], taxTotal: number, base: string): string {
  const rates = distinctLineTaxRates(items)
  const singleNonZeroRate = rates.length === 1 && rates[0] !== 0
  if (singleNonZeroRate && round2(Number(taxTotal) || 0) !== 0) {
    return `${base} (${rates[0]}%)`
  }
  return base
}

/**
 * The discount the totals block prints, mirroring the posting engine: the
 * invoice-level discount clamped to a non-negative subtotal (the taxable base
 * never drops below zero) and not booked at all on a negative one, so
 * Subtotal − Discount + VAT + Round-off ties to the stored grand total.
 */
export function bookedInvoiceDiscount(subtotal: number, discountTotal: number): number {
  const stored = round2(Number(discountTotal) || 0)
  const base = round2(Number(subtotal) || 0)
  if (stored <= 0 || base < 0) return 0
  return round2(Math.min(stored, base))
}

/**
 * The note printed when a document carries none. One constant for the print
 * preview, the store's default and the PDF builders, so a blank note renders
 * identically everywhere.
 */
export const DEFAULT_INVOICE_NOTES = 'Payment due within 30 days.'

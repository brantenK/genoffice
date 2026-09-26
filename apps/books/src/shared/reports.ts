import { invoiceTaxBreakdown, postedInvoiceAmounts, round2 } from './accounting'
import type { Invoice, Party } from './types'

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
  /** Open credit balance (unapplied credit notes / overpayments), as a magnitude. */
  credit: number
  /** Net open balance: the four overdue buckets minus `credit`. */
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
 * AR/AP aging buckets for one invoice direction. Every open invoice counts
 * (status not Paid/Cancelled/Draft and a non-zero outstandingAmount). Debit
 * balances are keyed by days overdue (asOf minus dueDate): <=0 current, 1-30
 * days30, 31-60 days60, >60 days90. Credit balances (customer credit notes,
 * overpayments) are collected in `credit` rather than dropped, so `total` is
 * the net balance and reconciles with the party's derived outstandingBalance.
 * One row per party, sorted by total descending.
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
      round2(inv.outstandingAmount || 0) !== 0,
  )

  const rows = new Map<string, AgingRow>()
  for (const inv of open) {
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
        credit: 0,
        total: 0,
      }
      rows.set(partyId, row)
    }

    if (amount < 0) {
      row.credit = round2(row.credit - amount)
    } else {
      const daysOverdue = daysBetween(inv.dueDate, asOf)
      if (daysOverdue <= 0) row.current = round2(row.current + amount)
      else if (daysOverdue <= 30) row.days30 = round2(row.days30 + amount)
      else if (daysOverdue <= 60) row.days60 = round2(row.days60 + amount)
      else row.days90 = round2(row.days90 + amount)
    }
  }

  for (const row of rows.values()) {
    row.total = round2(row.current + row.days30 + row.days60 + row.days90 - row.credit)
  }

  return Array.from(rows.values()).sort((a, b) => b.total - a.total)
}

/**
 * VAT register: per distinct item taxRate, per direction (Sales/Purchase).
 * Every non-draft, non-cancelled invoice is included. The taxable base and VAT
 * of each invoice come from `postedInvoiceAmounts` — the very rule the journal
 * builders post with — so the register reports exactly what the ledger posted:
 * a store-written row as stored, an item-only / legacy row from its lines with
 * its base closed onto the stored `grandTotal`. A row whose lines imply VAT
 * (and whose stored totals are absent) is therefore reported AND posted on the
 * lines' VAT; the register can never report VAT the ledger did not post. An
 * invoice carries no VAT-inclusive flag (that is a company setting), so the
 * lines of such a row are read as VAT-exclusive, exactly as the journal reads
 * them. Credit notes are netted (their reversal journals debit VAT output /
 * credit VAT input), otherwise SARS output VAT is overstated. The last row
 * (taxRate null) sums everything.
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
    const sign = inv.creditNote ? -1 : 1
    const amounts = postedInvoiceAmounts(inv)
    const breakdown = invoiceTaxBreakdown({
      items: inv.items,
      discountTotal: inv.discountTotal,
      subtotal: amounts.subtotal,
      taxTotal: amounts.taxTotal,
    })

    // A row with no item lines at all still posts the VAT it carries (a
    // correction or legacy row): report it under the 0% band so the register
    // and the ledger agree on every invoice, not only on those with lines.
    const rateRows =
      breakdown.rows.length === 0 && (breakdown.taxable !== 0 || breakdown.tax !== 0)
        ? [{ taxRate: 0, taxable: breakdown.taxable, tax: breakdown.tax }]
        : breakdown.rows

    for (const line of rateRows) {
      let row = byRate.get(line.taxRate)
      if (!row) {
        row = {
          taxRate: line.taxRate,
          salesTaxable: 0,
          salesTax: 0,
          purchaseTaxable: 0,
          purchaseTax: 0,
        }
        byRate.set(line.taxRate, row)
      }

      if (inv.type === 'Sales') {
        row.salesTaxable = round2(row.salesTaxable + sign * line.taxable)
        row.salesTax = round2(row.salesTax + sign * line.tax)
        totals.salesTaxable = round2(totals.salesTaxable + sign * line.taxable)
        totals.salesTax = round2(totals.salesTax + sign * line.tax)
      } else {
        row.purchaseTaxable = round2(row.purchaseTaxable + sign * line.taxable)
        row.purchaseTax = round2(row.purchaseTax + sign * line.tax)
        totals.purchaseTaxable = round2(totals.purchaseTaxable + sign * line.taxable)
        totals.purchaseTax = round2(totals.purchaseTax + sign * line.tax)
      }
    }
  }

  const rows = Array.from(byRate.values()).sort((a, b) => (a.taxRate ?? 0) - (b.taxRate ?? 0))
  rows.push(totals)
  return rows
}

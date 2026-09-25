import { DEFAULT_BANK_ACCOUNT_NAME } from './chart'
import type {
  Account,
  BankTransaction,
  Invoice,
  InvoiceItem,
  InvoiceType,
  JournalEntry,
  JournalEntryItem,
  Party,
} from './types'

/**
 * Strict 2-decimal rounding function ensuring floating point precision invariants.
 */
export function round2(n: number): number {
  const val = Math.round((Number(n) || 0) * 100) / 100
  return val === 0 ? 0 : val
}

/**
 * The post-discount line amount for an item (VAT-exclusive or -inclusive
 * exactly as the line amount was entered). Line discounts are applied BEFORE
 * tax: effective = amount * (1 - discountRate/100). Shared by the totals
 * engine and the journal builders so the discount math lives in one place.
 */
export function effectiveLineAmount(item: InvoiceItem): number {
  const hasQtyRate =
    item.qty != null && item.rate != null && !isNaN(Number(item.qty)) && !isNaN(Number(item.rate))
  const lineAmt = round2(
    hasQtyRate ? Number(item.qty) * Number(item.rate) : Number(item.amount) || 0,
  )

  const discountRate = Number(item.discountRate)
  if (item.discountRate != null && !isNaN(discountRate) && discountRate !== 0) {
    return round2(lineAmt * (1 - discountRate / 100))
  }
  return lineAmt
}

export interface InvoiceTotalsOptions {
  /** When true, each line's amount is treated as VAT-inclusive. Default false. */
  taxInclusive?: boolean
  /** Invoice-level VAT-exclusive discount (absolute, applied before tax). */
  discountTotal?: number
  /** Absolute grand-total adjustment (may be negative). */
  roundOff?: number
}

/**
 * Calculates subtotal, taxTotal, and grandTotal from line items.
 *
 * - Line discounts (item.discountRate) reduce each line BEFORE tax.
 * - taxInclusive: base = amount / (1 + rate/100), tax = amount - base.
 * - Invoice-level discountTotal reduces the taxable base (and hence tax).
 * - roundOff is applied to grandTotal only.
 *
 * Guarantees to 2 decimal places: grandTotal === subtotal + taxTotal +
 * roundOff when no invoice-level discount is applied (with a discount,
 * taxableSubtotal = max(0, subtotal - discountTotal) replaces subtotal).
 * The `roundOff` key is only present on the result when non-zero.
 */
export function calculateInvoiceTotals(
  items: InvoiceItem[],
  opts?: InvoiceTotalsOptions,
): {
  subtotal: number
  taxTotal: number
  grandTotal: number
  roundOff?: number
} {
  if (!Array.isArray(items) || items.length === 0) {
    return { subtotal: 0, taxTotal: 0, grandTotal: 0 }
  }

  const taxInclusive = opts?.taxInclusive === true
  const discountTotal = round2(Number(opts?.discountTotal) || 0)
  const roundOff = round2(Number(opts?.roundOff) || 0)

  let subtotal = 0
  let lineTaxTotal = 0

  for (const it of items) {
    const effective = effectiveLineAmount(it)
    const taxRate = Number(it.taxRate) || 0

    let base = effective
    let lineTax = round2((effective * taxRate) / 100)
    if (taxInclusive && taxRate !== 0) {
      base = round2(effective / (1 + taxRate / 100))
      lineTax = round2(effective - base)
    }

    subtotal = round2(subtotal + base)
    lineTaxTotal = round2(lineTaxTotal + lineTax)
  }

  // Invoice-level discount: the taxable base never drops below zero for
  // positive subtotals. Negative subtotals (rebates / credit notes) keep
  // their phase-1 negative-tax semantics — no clamp there.
  const rawTaxable = round2(subtotal - discountTotal)
  const taxableSubtotal = subtotal < 0 || discountTotal <= 0 ? rawTaxable : Math.max(0, rawTaxable)

  // Without a discount the per-line tax sum is preserved exactly (phase-1
  // behavior). With a discount, tax is recomputed on the discounted base:
  // single shared rate -> aggregate rate on taxableSubtotal; mixed rates ->
  // per-line taxes scaled proportionally.
  let taxTotal = lineTaxTotal
  if (discountTotal !== 0) {
    const rates = new Set<number>()
    for (const it of items) {
      rates.add(Number(it.taxRate) || 0)
    }
    if (rates.size <= 1) {
      const rate = rates.size === 1 ? Array.from(rates)[0] : 0
      taxTotal = round2(taxableSubtotal * (rate / 100))
    } else {
      const factor = subtotal !== 0 ? taxableSubtotal / subtotal : 1
      taxTotal = round2(lineTaxTotal * factor)
    }
  }

  const grandTotal = round2(taxableSubtotal + taxTotal + roundOff)
  const result: {
    subtotal: number
    taxTotal: number
    grandTotal: number
    roundOff?: number
  } = { subtotal, taxTotal, grandTotal }
  if (roundOff !== 0) {
    result.roundOff = roundOff
  }
  return result
}

export interface InvoiceTaxRow {
  taxRate: number
  taxable: number
  tax: number
}

export interface InvoiceTaxInput {
  items: InvoiceItem[]
  /** Invoice-level VAT-exclusive discount (applied before tax). */
  discountTotal?: number
  /** Posted VAT-exclusive subtotal; falls back to the item lines. */
  subtotal?: number
  /** Posted VAT; falls back to the item lines. */
  taxTotal?: number
}

export interface InvoiceTaxBreakdown {
  /** VAT-exclusive base actually taxed (line and invoice discounts applied). */
  taxable: number
  /** VAT posted for this invoice. */
  tax: number
  /** Per distinct tax rate; the rows always sum back to `taxable` / `tax`. */
  rows: InvoiceTaxRow[]
}

/**
 * One item line as the reporting engine reads it. `amount` is the stored line
 * total (the store writes it as qty x rate) and where an older row disagrees
 * with qty x rate the stored total is the one that was posted; suppressing
 * qty/rate makes `effectiveLineAmount` resolve the line to that amount while
 * still applying the line's own `discountRate`.
 */
function postedLine(item: InvoiceItem): InvoiceItem {
  return item.amount ? { ...item, qty: Number.NaN, rate: Number.NaN } : item
}

/**
 * The post-discount amount a journal posts for one line, read exactly as the
 * tax register reads it (`postedLine` above), so the accounts a journal groups
 * a line into and the rates the register taxes it at come from the same figure.
 */
export function journalLineAmount(item: InvoiceItem): number {
  return effectiveLineAmount(postedLine(item))
}

/**
 * The single definition of an invoice's VAT: which base is taxed at which
 * rate, how much VAT that posts, and the per-rate split of both.
 *
 * All discount arithmetic goes through `calculateInvoiceTotals` — each line's
 * `discountRate` first, then the invoice-level `discountTotal` (aggregate tax
 * for a single rate, proportional for mixed rates). The per-rate rows are the
 * taxes the item lines imply, scaled onto those totals, so the journal VAT leg
 * and the tax register can never report different figures.
 *
 * The totals are derived from the item lines unless the caller supplies the
 * posted `subtotal` / `taxTotal` — the store writes those with this same engine
 * and the journals post them, which is how the tax register reports exactly
 * what was posted. The last row absorbs the rounding difference.
 */
export function invoiceTaxBreakdown(input: InvoiceTaxInput): InvoiceTaxBreakdown {
  const lines = (Array.isArray(input.items) ? input.items : []).map(postedLine)
  const discountTotal = round2(Number(input.discountTotal) || 0)

  const derived = calculateInvoiceTotals(lines, { discountTotal })
  const subtotal = input.subtotal !== undefined ? round2(input.subtotal) : derived.subtotal
  const bookedDiscount = round2(subtotal >= 0 ? Math.min(discountTotal, subtotal) : 0)
  const taxable = round2(subtotal - bookedDiscount)
  const tax = input.taxTotal !== undefined ? round2(input.taxTotal) : derived.taxTotal

  const groups = new Map<number, InvoiceTaxRow>()
  for (const line of lines) {
    const rate = round2(Number(line.taxRate) || 0)
    const totals = calculateInvoiceTotals([line])
    const group = groups.get(rate) || { taxRate: rate, taxable: 0, tax: 0 }
    group.taxable = round2(group.taxable + totals.subtotal)
    group.tax = round2(group.tax + totals.taxTotal)
    groups.set(rate, group)
  }

  const rows = Array.from(groups.values()).sort((a, b) => a.taxRate - b.taxRate)
  if (rows.length === 1) {
    rows[0].taxable = taxable
    rows[0].tax = tax
  } else if (rows.length > 1) {
    const baseSum = rows.reduce((sum, row) => round2(sum + row.taxable), 0)
    const taxSum = rows.reduce((sum, row) => round2(sum + row.tax), 0)
    const baseScale = baseSum !== 0 ? taxable / baseSum : 1
    const taxScale = taxSum !== 0 ? tax / taxSum : 1
    for (const row of rows) {
      row.taxable = round2(row.taxable * baseScale)
      row.tax = round2(row.tax * taxScale)
    }
    const scaledBase = rows.reduce((sum, row) => round2(sum + row.taxable), 0)
    const scaledTax = rows.reduce((sum, row) => round2(sum + row.tax), 0)
    const last = rows[rows.length - 1]
    last.taxable = round2(last.taxable + round2(taxable - scaledBase))
    last.tax = round2(last.tax + round2(tax - scaledTax))
  }

  return { taxable, tax, rows }
}

/**
 * True when a stored row carries the totals the store wrote for it: a non-zero
 * VAT-exclusive subtotal or VAT. A row without them (item-only and legacy
 * data) is read from its item lines instead. The journal builders and the VAT
 * register both gate on this one test, so the VAT they post and the VAT they
 * report can never diverge.
 */
export function hasPostedTotals(invoice: Pick<Invoice, 'subtotal' | 'taxTotal'>): boolean {
  return round2(Number(invoice.subtotal) || 0) !== 0 || round2(Number(invoice.taxTotal) || 0) !== 0
}

export interface PostedInvoiceAmounts {
  /** VAT-exclusive base the posting carries. */
  subtotal: number
  /** VAT the posting carries. */
  taxTotal: number
}

/**
 * The VAT-exclusive subtotal and VAT one invoice posts, under the single rule
 * the journal builders and `taxRegister` share:
 * - a row that carries posted totals is posted exactly as stored — the store
 *   writes those totals with `calculateInvoiceTotals`, so a store-written row
 *   is internally consistent and its figures are the ones the invoice shows;
 * - a row without posted totals has no stored base to post: its item lines are
 *   authoritative for the VAT (the very lines `taxRegister` reads) and the
 *   stored `grandTotal` fixes the base as the remainder it leaves after that
 *   VAT, so the posting closes on the anchor instead of inventing a residual.
 *
 * An invoice carries no `taxInclusive` flag (that is a company setting), so a
 * row without posted totals is read as VAT-exclusive by the journal and the
 * register alike — one rule, never two.
 */
export function postedInvoiceAmounts(
  invoice: Pick<
    Invoice,
    'items' | 'subtotal' | 'taxTotal' | 'grandTotal' | 'discountTotal' | 'roundOff'
  >,
): PostedInvoiceAmounts {
  const storedSubtotal = round2(Number(invoice.subtotal) || 0)
  const storedTax = round2(Number(invoice.taxTotal) || 0)
  if (hasPostedTotals(invoice)) {
    return { subtotal: storedSubtotal, taxTotal: storedTax }
  }

  const lines = Array.isArray(invoice.items) ? invoice.items : []
  const discountTotal = round2(Number(invoice.discountTotal) || 0)
  const roundOff = round2(Number(invoice.roundOff) || 0)
  const grandTotal = round2(Number(invoice.grandTotal) || 0)
  // The VAT the item lines imply, read exactly as the tax register reads it.
  const taxTotal = invoiceTaxBreakdown({ items: lines, discountTotal }).tax
  // No anchor to close against (a row whose grandTotal was never written):
  // the item lines carry the posting on their own.
  const subtotal =
    grandTotal === 0
      ? calculateInvoiceTotals(lines.map(postedLine), { discountTotal }).subtotal
      : round2(grandTotal + discountTotal - taxTotal - roundOff)
  return { subtotal, taxTotal }
}

/** The item lines a journal groups by account, with NaN arrays read as empty. */
function journalLines(invoice: Invoice): InvoiceItem[] {
  return Array.isArray(invoice.items) ? invoice.items : []
}

/** Every distinct tax rate among the lines, ascending (0 for rate-less lines). */
function lineTaxRates(lines: InvoiceItem[]): number[] {
  const rates = new Set<number>()
  for (const line of lines) {
    const rate = round2(Number(line.taxRate) || 0)
    if (!rates.has(rate)) rates.add(rate)
  }
  return Array.from(rates).sort((a, b) => a - b)
}

/**
 * The VAT remark for a posting leg, labelled with the rate(s) the posting
 * actually carries: '15% VAT Output', '0% VAT Output Adjustment',
 * '7.5% / 15% VAT Output' for a mixed-rate invoice. `suffix` carries the sign
 * convention ('Adjustment' when the leg is on its reversal side).
 */
function vatRemark(rates: number[], suffix: string): string {
  const labels = rates.length > 0 ? rates : [0]
  return `${labels.map((rate) => `${rate}%`).join(' / ')} VAT ${suffix}`
}

/**
 * Group invoice lines by their posting account, on the same post-discount
 * `journalLineAmount` basis the totals engine and the tax register use. A line
 * whose effective amount rounds to zero is dropped so it never produces a 0.00
 * journal leg.
 */
function groupLines(
  lines: InvoiceItem[],
  accounts: Account[],
  opts: {
    defaultAccountId: string
    defaultAccountType: Account['accountType']
    defaultName: string
  },
): Map<string, { accountId: string; accountName: string; amount: number }> {
  const groups = new Map<string, { accountId: string; accountName: string; amount: number }>()

  for (const it of lines) {
    const lineAmt = journalLineAmount(it)
    if (lineAmt === 0) continue
    const accId = it.accountId || opts.defaultAccountId
    const matched = accounts.find((a) => a.id === accId)
    const accName = it.accountName || matched?.name || opts.defaultName

    const existing = groups.get(accId) || {
      accountId: accId,
      accountName: accName,
      amount: 0,
    }
    existing.amount = round2(existing.amount + lineAmt)
    groups.set(accId, existing)
  }

  return groups
}

/** The account a journal falls back to when an invoice carries no usable line. */
function defaultGroupAccount(
  accounts: Account[],
  id: string,
  accountType: Account['accountType'],
  name: string,
): { accountId: string; accountName: string } {
  const matched = accounts.find((a) => a.id === id || a.accountType === accountType)
  return { accountId: matched?.id || id, accountName: matched?.name || name }
}

/** Posting account a sales entry absorbs a rounding difference on. */
const AR_INCOME_ACCOUNT = 'acc-sales'
/** Posting account a purchase entry absorbs a rounding difference on. */
const AP_EXPENSE_ACCOUNT = 'acc-materials'

/** VAT posting accounts, which carry the posted VAT and never a residual. */
const VAT_ACCOUNTS = new Set(['acc-vat', 'acc-vat-out', 'acc-vat-in'])

/**
 * Journal legs whose amount is fixed by the stored figures: the AR/AP control
 * leg (the stored grandTotal) and the VAT leg (the posted VAT).
 */
function isFixedLeg(item: JournalEntryItem): boolean {
  return (
    item.accountId === 'acc-ar' || item.accountId === 'acc-ap' || VAT_ACCOUNTS.has(item.accountId)
  )
}

/**
 * Forces the entry to balance. The residual rides a revenue/expense leg: the
 * preferred account when one of its legs can take the adjustment, any other
 * revenue/expense leg otherwise, and a leg of its own on the fallback account
 * when the entry carries none (a corrupt row whose lines all point at control
 * accounts).
 *
 * The VAT leg and the AR/AP control leg are deliberately NEVER adjustment
 * targets: the VAT leg carries the posted VAT and the control leg is the
 * entry's anchor on the stored `grandTotal`, so a residual on either would
 * misstate the VAT return or make the party balance, the AR/AP control account
 * and the invoice disagree — the very defect this anchor exists to prevent.
 */
function absorbRoundingDifference(
  items: JournalEntryItem[],
  preferredAccountId: string,
  fallback: { accountId: string; accountName: string },
  remark: string,
): void {
  const debit = round2(items.reduce((s, it) => s + it.debit, 0))
  const credit = round2(items.reduce((s, it) => s + it.credit, 0))
  if (debit === credit) return

  const delta = round2(Math.abs(debit - credit))
  if (delta === 0) return

  const candidates = items.filter((item) => !isFixedLeg(item))
  const target =
    candidates.find(
      (it) => it.accountId === preferredAccountId && it.debit === 0 && it.credit > 0,
    ) ||
    candidates.find(
      (it) => it.accountId === preferredAccountId && it.credit === 0 && it.debit > 0,
    ) ||
    candidates[candidates.length - 1]

  if (!target) {
    // Nothing to adjust: carry the residual on its own leg so the posting
    // still balances rather than leaving one side of the entry short.
    const addCredit = round2(debit - credit) > 0
    items.push({
      id: `je-i-bal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      accountId: fallback.accountId,
      accountName: fallback.accountName,
      debit: addCredit ? 0 : delta,
      credit: addCredit ? delta : 0,
      remark,
    })
    return
  }

  if (round2(debit - credit) > 0) {
    target.credit = round2(target.credit + delta)
    if (target.debit !== 0 && target.credit !== 0) {
      const net = round2(target.credit - target.debit)
      target.debit = net < 0 ? round2(Math.abs(net)) : 0
      target.credit = net > 0 ? net : 0
    }
  } else {
    target.debit = round2(target.debit + delta)
    if (target.debit !== 0 && target.credit !== 0) {
      const net = round2(target.debit - target.credit)
      target.debit = net > 0 ? net : 0
      target.credit = net < 0 ? round2(Math.abs(net)) : 0
    }
  }
}

/**
 * Creates a balanced JournalEntry for a Sales Invoice.
 *
 * The entry is ANCHORED ON THE STORED `grandTotal` (never on `subtotal`): the
 * Receivable leg is always exactly that amount, so the party balance, the AR
 * control account and the invoice can never disagree. The posted VAT and the
 * VAT-exclusive base the income legs start from come from `postedInvoiceAmounts`
 * — the same rule the tax register reads — and the discount / round-off /
 * residual legs are recomputed so that
 * - Debit: Accounts Receivable (acc-ar) for invoice.grandTotal
 * - Credit: Income account(s) (item.accountId or acc-sales) for the posted
 *   subtotal; a negative subtotal (a rebate invoice) posts on the debit side
 *   instead of being dropped
 * - Debit: invoice-level discount (invoice.discountTotal) on the first income
 *   account (remark 'Invoice discount'), keeping the VAT base consistent
 * - Credit: VAT Output Payable (acc-vat or acc-vat-out) for the posted VAT,
 *   labelled with the rate(s) the lines actually carry
 * - Final: round-off adjustment on the first income account: the invoice's
 *   `roundOff`, plus whatever residual the stored figures leave. Positive
 *   credits income, negative debits it.
 *
 * Two legs are always emitted — only a posting with both sides of zero (a
 * nil invoice) collapses to a single balanced 0.00 leg.
 * Total Debits strictly equal Total Credits for ANY finite stored totals,
 * internally consistent or not. A line whose effective amount is zero is not
 * posted on its own account (the amount is already 0.00); any residual is
 * absorbed on an income leg, never on the VAT or Receivable leg.
 */
export function createSalesInvoiceJournal(
  invoice: Invoice,
  accounts: Account[],
  party?: Party,
  jeNumber?: string,
): JournalEntry {
  const roundOff = round2(Number(invoice.roundOff) || 0)
  const discountTotal = round2(Number(invoice.discountTotal) || 0)
  const grandTotal = round2(Number(invoice.grandTotal) || 0)
  // The entry is anchored on grandTotal: the Receivable leg is always exactly
  // that amount. The VAT and the base the income legs start from come from the
  // one shared rule `taxRegister` reads too (`postedInvoiceAmounts`), so the
  // posted VAT and the reported VAT cannot diverge.
  const { subtotal, taxTotal } = postedInvoiceAmounts(invoice)

  const lines = journalLines(invoice)

  const dateStr = invoice.date || new Date().toISOString().split('T')[0]
  const year = new Date(dateStr).getFullYear() || new Date().getFullYear()
  const randomSuffix = Math.random().toString(36).slice(2, 7)
  const entryNum = jeNumber || `JE-${year}-${String(Date.now()).slice(-4)}-${randomSuffix}`

  const arAcc = accounts.find((a) => a.id === 'acc-ar' || a.accountType === 'Receivable') || {
    id: 'acc-ar',
    name: 'Accounts Receivable (Debtors)',
  }

  const isArCredit = grandTotal < 0
  const absGrandTotal = round2(Math.abs(grandTotal))

  const items: JournalEntryItem[] = [
    {
      id: `je-i-ar-${Date.now()}-${randomSuffix}`,
      accountId: arAcc.id,
      accountName: arAcc.name,
      partyId: invoice.partyId || party?.id,
      partyName: invoice.partyName || party?.name,
      debit: isArCredit ? 0 : absGrandTotal,
      credit: isArCredit ? absGrandTotal : 0,
      remark: `Invoice ${invoice.invoiceNumber}`,
    },
  ]

  const incomeGroups = groupLines(lines, accounts, {
    defaultAccountId: 'acc-sales',
    defaultAccountType: 'Direct Income',
    defaultName: 'Tender & Commercial Contracting Sales',
  })

  if (incomeGroups.size === 0) {
    const salesAcc = defaultGroupAccount(
      accounts,
      'acc-sales',
      'Direct Income',
      'Tender & Commercial Contracting Sales',
    )
    incomeGroups.set(salesAcc.accountId, { ...salesAcc, amount: subtotal })
  }

  // The income legs carry the posted subtotal — a negative subtotal (a rebate
  // invoice) posts its income on the debit side like any other negative amount,
  // so it is never dropped and the entry never loses its counterpart to the
  // Receivable leg.
  const groupTarget = subtotal
  const entries = Array.from(incomeGroups.values())
  const sumCredits = entries.reduce((s, e) => round2(s + e.amount), 0)
  const diff = round2(groupTarget - sumCredits)
  if (diff !== 0 && entries.length > 0) {
    entries[entries.length - 1].amount = round2(entries[entries.length - 1].amount + diff)
  }

  let incIdx = 1
  for (const inc of incomeGroups.values()) {
    const absAmt = round2(Math.abs(inc.amount))
    if (absAmt === 0) continue
    const isNegative = inc.amount < 0
    items.push({
      id: `je-i-inc-${incIdx++}-${Date.now()}-${randomSuffix}`,
      accountId: inc.accountId,
      accountName: inc.accountName,
      debit: isNegative ? absAmt : 0,
      credit: isNegative ? 0 : absAmt,
      remark: isNegative
        ? `Sales Discount / Adjustment - ${invoice.invoiceNumber}`
        : `Sales Revenue - ${invoice.invoiceNumber}`,
    })
  }

  // Invoice-level discount: its own leg on the first income account. A
  // positive discount is a debit against income (it reduces revenue); when the
  // stored discount is negative (a surcharge) the leg takes the credit side.
  const bookedDiscount = round2(subtotal < 0 ? 0 : Math.min(discountTotal, subtotal))
  if (bookedDiscount !== 0) {
    const first = Array.from(incomeGroups.values())[0]
    const discSigned = round2(-bookedDiscount)
    items.push({
      id: `je-i-disc-${Date.now()}-${randomSuffix}`,
      accountId: first.accountId,
      accountName: first.accountName,
      debit: discSigned < 0 ? round2(Math.abs(discSigned)) : 0,
      credit: discSigned > 0 ? discSigned : 0,
      remark: `Invoice discount - ${invoice.invoiceNumber}`,
    })
  }

  if (taxTotal !== 0) {
    const vatAcc = accounts.find((a) => a.id === 'acc-vat' || a.id === 'acc-vat-out') || {
      id: 'acc-vat',
      name: 'SARS VAT Output Payable',
    }

    const isNegativeVat = taxTotal < 0
    const absTax = round2(Math.abs(taxTotal))
    items.push({
      id: `je-i-vat-${Date.now()}-${randomSuffix}`,
      accountId: vatAcc.id,
      accountName: vatAcc.name,
      debit: isNegativeVat ? absTax : 0,
      credit: isNegativeVat ? 0 : absTax,
      remark: vatRemark(lineTaxRates(lines), isNegativeVat ? 'Output Adjustment' : 'Output'),
    })
  }

  // Round-off: the invoice's own signed adjustment on the first income
  // account, so the entry lands exactly on grandTotal. roundOff > 0 (grand
  // total rounded up) credits income, roundOff < 0 debits it. Whatever
  // residual inconsistent stored totals leave is absorbed below.
  const roundAdjustment = round2(roundOff)
  if (roundAdjustment !== 0) {
    const primary = Array.from(incomeGroups.values())[0] || {
      accountId: 'acc-sales',
      accountName: 'Tender & Commercial Contracting Sales',
    }
    const isRoundOffCredit = roundAdjustment > 0
    const absRoundOff = round2(Math.abs(roundAdjustment))
    items.push({
      id: `je-i-round-${Date.now()}-${randomSuffix}`,
      accountId: primary.accountId,
      accountName: primary.accountName,
      debit: isRoundOffCredit ? 0 : absRoundOff,
      credit: isRoundOffCredit ? absRoundOff : 0,
      remark: `Round-off adjustment - ${invoice.invoiceNumber}`,
    })
  }

  if (items.length === 1) {
    // A nil invoice: no income, VAT, discount or round-off to post. Emit a
    // single balanced leg rather than an entry with a debit side only.
    items.push({
      id: `je-i-nil-${Date.now()}-${randomSuffix}`,
      accountId: items[0].accountId,
      accountName: items[0].accountName,
      partyId: invoice.partyId || party?.id,
      partyName: invoice.partyName || party?.name,
      debit: 0,
      credit: 0,
      remark: `Invoice ${invoice.invoiceNumber} — no financial effect`,
    })
  }

  let totalDebit = round2(items.reduce((s, it) => s + it.debit, 0))
  let totalCredit = round2(items.reduce((s, it) => s + it.credit, 0))
  if (totalDebit !== totalCredit) {
    // Safety net: a sales posting can never leave the ledger unbalanced. The
    // residual rides an income leg — never the VAT leg (the posted VAT) and
    // never the Receivable leg (the anchor on grandTotal).
    absorbRoundingDifference(
      items,
      AR_INCOME_ACCOUNT,
      defaultGroupAccount(
        accounts,
        'acc-sales',
        'Direct Income',
        'Tender & Commercial Contracting Sales',
      ),
      `Balancing adjustment - ${invoice.invoiceNumber}`,
    )
    totalDebit = round2(items.reduce((s, it) => s + it.debit, 0))
    totalCredit = round2(items.reduce((s, it) => s + it.credit, 0))
  }

  return {
    id: `je-${Date.now()}-${randomSuffix}`,
    entryNumber: entryNum,
    date: dateStr,
    items,
    totalDebit,
    totalCredit,
    remarks: `System sales invoice posting for ${invoice.invoiceNumber}`,
    posted: true,
  }
}

/**
 * Creates a balanced JournalEntry for a Purchase Bill. The mirror of
 * `createSalesInvoiceJournal`, anchored on the stored `grandTotal` — the
 * Payable leg is always exactly that amount — with the expense legs starting
 * from the posted VAT-exclusive subtotal `postedInvoiceAmounts` returns:
 * - Debit: Expense Account(s) (item.accountId or acc-materials) for the posted
 *   subtotal; a negative subtotal posts on the credit side instead of being dropped
 * - Credit: invoice-level discount (bill.discountTotal) on the first expense
 *   account (remark 'Invoice discount'), keeping the VAT base consistent
 * - Debit: VAT Input Recoverable (acc-vat-in or acc-vat) for the posted VAT,
 *   labelled with the rate(s) the lines actually carry
 * - Credit: Accounts Payable (acc-ap) for bill.grandTotal
 * - Final: round-off adjustment plus any residual on the first expense
 *   account (remark 'Round-off adjustment'), so the entry lands on grandTotal
 * Total Debits strictly equal Total Credits for ANY finite stored totals.
 */
export function createPurchaseBillJournal(
  bill: Invoice,
  accounts: Account[],
  party?: Party,
  jeNumber?: string,
): JournalEntry {
  const roundOff = round2(Number(bill.roundOff) || 0)
  const discountTotal = round2(Number(bill.discountTotal) || 0)
  const grandTotal = round2(Number(bill.grandTotal) || 0)
  // The entry is anchored on grandTotal: the Payable leg is always exactly
  // that amount. The VAT and the base the expense legs start from come from the
  // one shared rule `taxRegister` reads too (`postedInvoiceAmounts`), so the
  // posted VAT and the reported VAT cannot diverge.
  const { subtotal, taxTotal } = postedInvoiceAmounts(bill)

  const lines = journalLines(bill)

  const dateStr = bill.date || new Date().toISOString().split('T')[0]
  const year = new Date(dateStr).getFullYear() || new Date().getFullYear()
  const randomSuffix = Math.random().toString(36).slice(2, 7)
  const entryNum = jeNumber || `JE-${year}-${String(Date.now()).slice(-4)}-${randomSuffix}`

  const items: JournalEntryItem[] = []

  // Group line items by expense account if available
  const expenseGroups = groupLines(lines, accounts, {
    defaultAccountId: 'acc-materials',
    defaultAccountType: 'Direct Expense',
    defaultName: 'Direct Project Materials & Subcontractors',
  })

  if (expenseGroups.size === 0) {
    const matAcc = defaultGroupAccount(
      accounts,
      'acc-materials',
      'Direct Expense',
      'Direct Project Materials & Subcontractors',
    )
    expenseGroups.set(matAcc.accountId, { ...matAcc, amount: subtotal })
  }

  // The expense legs carry the posted subtotal — a negative subtotal (a rebate
  // bill) posts its expense on the credit side like any other negative amount,
  // so it is never dropped and the entry never loses its counterpart to the
  // Payable leg.
  const groupTarget = subtotal
  const entries = Array.from(expenseGroups.values())
  const sumDebits = entries.reduce((s, e) => round2(s + e.amount), 0)
  const diff = round2(groupTarget - sumDebits)
  if (diff !== 0 && entries.length > 0) {
    entries[entries.length - 1].amount = round2(entries[entries.length - 1].amount + diff)
  }

  let expIdx = 1
  for (const exp of expenseGroups.values()) {
    const absAmt = round2(Math.abs(exp.amount))
    if (absAmt === 0) continue
    const isNegative = exp.amount < 0
    items.push({
      id: `je-i-exp-${expIdx++}-${Date.now()}-${randomSuffix}`,
      accountId: exp.accountId,
      accountName: exp.accountName,
      debit: isNegative ? 0 : absAmt,
      credit: isNegative ? absAmt : 0,
      remark: isNegative
        ? `Direct Expense Discount / Adjustment - ${bill.invoiceNumber}`
        : `Direct Expense - ${bill.invoiceNumber}`,
    })
  }

  // Invoice-level discount: its own leg on the first expense account. A
  // positive discount takes the credit side (it reduces the expense); a
  // negative stored discount takes the debit side.
  const bookedDiscount = round2(subtotal < 0 ? 0 : discountTotal)
  if (bookedDiscount !== 0) {
    const first = Array.from(expenseGroups.values())[0]
    items.push({
      id: `je-i-disc-${Date.now()}-${randomSuffix}`,
      accountId: first.accountId,
      accountName: first.accountName,
      debit: bookedDiscount < 0 ? round2(Math.abs(bookedDiscount)) : 0,
      credit: bookedDiscount > 0 ? bookedDiscount : 0,
      remark: `Invoice discount - ${bill.invoiceNumber}`,
    })
  }

  if (taxTotal !== 0) {
    const vatInAcc = accounts.find((a) => a.id === 'acc-vat-in') ||
      accounts.find((a) => a.id === 'acc-vat') || {
        id: 'acc-vat-in',
        name: 'SARS VAT Input Recoverable',
      }

    const isNegativeTax = taxTotal < 0
    const absTax = round2(Math.abs(taxTotal))
    items.push({
      id: `je-i-vatin-${Date.now()}-${randomSuffix}`,
      accountId: vatInAcc.id,
      accountName: vatInAcc.name,
      debit: isNegativeTax ? 0 : absTax,
      credit: isNegativeTax ? absTax : 0,
      remark: vatRemark(
        lineTaxRates(lines),
        isNegativeTax ? 'Input Adjustment' : 'Input Recoverable',
      ),
    })
  }

  const apAcc = accounts.find((a) => a.id === 'acc-ap' || a.accountType === 'Payable') || {
    id: 'acc-ap',
    name: 'Accounts Payable (Creditors)',
  }

  const isApDebit = grandTotal < 0
  const absGrandTotal = round2(Math.abs(grandTotal))
  items.push({
    id: `je-i-ap-${Date.now()}-${randomSuffix}`,
    accountId: apAcc.id,
    accountName: apAcc.name,
    partyId: bill.partyId || party?.id,
    partyName: bill.partyName || party?.name,
    debit: isApDebit ? absGrandTotal : 0,
    credit: isApDebit ? 0 : absGrandTotal,
    remark: `Purchase Bill ${bill.invoiceNumber}`,
  })

  // Round-off: the bill's own signed adjustment on the first expense account,
  // so the entry lands exactly on grandTotal. roundOff > 0 (grand total
  // rounded up) debits expense, roundOff < 0 credits it. Whatever residual
  // inconsistent stored totals leave is absorbed below.
  const roundAdjustment = round2(roundOff)
  if (roundAdjustment !== 0) {
    const primary = Array.from(expenseGroups.values())[0] || {
      accountId: 'acc-materials',
      accountName: 'Direct Project Materials & Subcontractors',
    }
    const isRoundOffDebit = roundAdjustment > 0
    const absRoundOff = round2(Math.abs(roundAdjustment))
    items.push({
      id: `je-i-round-${Date.now()}-${randomSuffix}`,
      accountId: primary.accountId,
      accountName: primary.accountName,
      debit: isRoundOffDebit ? absRoundOff : 0,
      credit: isRoundOffDebit ? 0 : absRoundOff,
      remark: `Round-off adjustment - ${bill.invoiceNumber}`,
    })
  }

  if (items.length === 1) {
    // A nil bill: no expense, VAT, discount or round-off to post. Emit a
    // single balanced leg rather than an entry with a credit side only.
    items.push({
      id: `je-i-nil-${Date.now()}-${randomSuffix}`,
      accountId: items[0].accountId,
      accountName: items[0].accountName,
      partyId: bill.partyId || party?.id,
      partyName: bill.partyName || party?.name,
      debit: 0,
      credit: 0,
      remark: `Purchase Bill ${bill.invoiceNumber} — no financial effect`,
    })
  }

  let totalDebit = round2(items.reduce((s, it) => s + it.debit, 0))
  let totalCredit = round2(items.reduce((s, it) => s + it.credit, 0))
  if (totalDebit !== totalCredit) {
    // Safety net: a purchase posting can never leave the ledger unbalanced. The
    // residual rides an expense leg — never the VAT leg (the posted VAT) and
    // never the Payable leg (the anchor on grandTotal).
    absorbRoundingDifference(
      items,
      AP_EXPENSE_ACCOUNT,
      defaultGroupAccount(
        accounts,
        'acc-materials',
        'Direct Expense',
        'Direct Project Materials & Subcontractors',
      ),
      `Balancing adjustment - ${bill.invoiceNumber}`,
    )
    totalDebit = round2(items.reduce((s, it) => s + it.debit, 0))
    totalCredit = round2(items.reduce((s, it) => s + it.credit, 0))
  }

  return {
    id: `je-${Date.now()}-${randomSuffix}`,
    entryNumber: entryNum,
    date: dateStr,
    items,
    totalDebit,
    totalCredit,
    remarks: `System purchase bill posting for ${bill.invoiceNumber}`,
    posted: true,
  }
}

export interface SettlementJournalOptions {
  invoice: Pick<
    Invoice,
    'id' | 'invoiceNumber' | 'type' | 'partyId' | 'partyName' | 'grandTotal' | 'outstandingAmount'
  >
  accounts: Account[]
  amount?: number
  party?: Party
  date?: string
  bankAccountId?: string
  remarks?: string
  jeNumber?: string
}

/**
 * Creates a balanced JournalEntry for an Invoice Payment / Settlement:
 * - Sales Receipt: Debit Bank (acc-bank), Credit Accounts Receivable (acc-ar)
 * - Purchase Payment: Debit Accounts Payable (acc-ap), Credit Bank (acc-bank)
 * Total Debits strictly equal Total Credits.
 */
export function createSettlementJournal(
  invoiceOrOptions: Invoice | SettlementJournalOptions,
  accountsParam?: Account[],
  amountParam?: number,
  partyParam?: Party,
  jeNumberParam?: string,
  bankAccountIdParam?: string,
  remarksParam?: string,
): JournalEntry {
  let invoice: Pick<
    Invoice,
    'id' | 'invoiceNumber' | 'type' | 'partyId' | 'partyName' | 'grandTotal' | 'outstandingAmount'
  >
  let accounts: Account[]
  let amount: number | undefined
  let party: Party | undefined
  let jeNumber: string | undefined
  let bankAccountId: string
  let remarks: string | undefined
  let dateStr: string

  if (
    typeof invoiceOrOptions === 'object' &&
    invoiceOrOptions !== null &&
    'invoice' in invoiceOrOptions &&
    'accounts' in invoiceOrOptions
  ) {
    const opts = invoiceOrOptions as SettlementJournalOptions
    invoice = opts.invoice
    accounts = opts.accounts || []
    amount = opts.amount
    party = opts.party
    jeNumber = opts.jeNumber
    bankAccountId = opts.bankAccountId || 'acc-bank'
    remarks = opts.remarks
    dateStr = opts.date || new Date().toISOString().split('T')[0]
  } else {
    invoice = invoiceOrOptions as Invoice
    accounts = accountsParam || []
    amount = amountParam
    party = partyParam
    jeNumber = jeNumberParam
    bankAccountId = bankAccountIdParam || 'acc-bank'
    remarks = remarksParam
    dateStr = new Date().toISOString().split('T')[0]
  }

  const settledAmount = round2(
    amount !== undefined && amount !== null
      ? amount
      : invoice.outstandingAmount !== undefined
        ? invoice.outstandingAmount
        : invoice.grandTotal,
  )

  const year = new Date(dateStr).getFullYear() || new Date().getFullYear()
  const randomSuffix = Math.random().toString(36).slice(2, 7)
  const entryNum = jeNumber || `JE-${year}-${String(Date.now()).slice(-4)}-${randomSuffix}`

  const bankAcc = accounts.find((a) => a.id === bankAccountId || a.accountType === 'Bank') || {
    id: bankAccountId,
    name: DEFAULT_BANK_ACCOUNT_NAME,
  }

  const isSales = invoice.type === 'Sales'

  let items: JournalEntryItem[]
  if (isSales) {
    const arAcc = accounts.find((a) => a.id === 'acc-ar' || a.accountType === 'Receivable') || {
      id: 'acc-ar',
      name: 'Accounts Receivable (Debtors)',
    }

    items = [
      {
        id: `jei-rec-bank-${Date.now()}-${randomSuffix}`,
        accountId: bankAcc.id,
        accountName: bankAcc.name,
        debit: settledAmount,
        credit: 0,
        remark: remarks || `Payment received: Invoice ${invoice.invoiceNumber}`,
      },
      {
        id: `jei-rec-ar-${Date.now()}-${randomSuffix}`,
        accountId: arAcc.id,
        accountName: arAcc.name,
        partyId: invoice.partyId || party?.id,
        partyName: invoice.partyName || party?.name,
        debit: 0,
        credit: settledAmount,
        remark: remarks || `Settlement for Invoice ${invoice.invoiceNumber}`,
      },
    ]
  } else {
    const apAcc = accounts.find((a) => a.id === 'acc-ap' || a.accountType === 'Payable') || {
      id: 'acc-ap',
      name: 'Accounts Payable (Creditors)',
    }

    items = [
      {
        id: `jei-pay-ap-${Date.now()}-${randomSuffix}`,
        accountId: apAcc.id,
        accountName: apAcc.name,
        partyId: invoice.partyId || party?.id,
        partyName: invoice.partyName || party?.name,
        debit: settledAmount,
        credit: 0,
        remark: remarks || `Settlement for Bill ${invoice.invoiceNumber}`,
      },
      {
        id: `jei-pay-bank-${Date.now()}-${randomSuffix}`,
        accountId: bankAcc.id,
        accountName: bankAcc.name,
        debit: 0,
        credit: settledAmount,
        remark: remarks || `Disbursement for Bill ${invoice.invoiceNumber}`,
      },
    ]
  }

  return {
    id: `je-${Date.now()}-${randomSuffix}`,
    entryNumber: entryNum,
    date: dateStr,
    items,
    totalDebit: settledAmount,
    totalCredit: settledAmount,
    remarks:
      remarks ||
      `Settlement payment for ${invoice.type === 'Sales' ? 'Invoice' : 'Bill'} ${invoice.invoiceNumber}`,
    posted: true,
  }
}

/**
 * Recomputes and guarantees that every party's outstandingBalance strictly equals
 * the sum of open invoice outstanding amounts.
 */
export function recomputePartyBalances(invoices: Invoice[], parties: Party[]): Party[] {
  if (!Array.isArray(parties)) return []
  const invList = Array.isArray(invoices) ? invoices : []

  return parties.map((party) => {
    const partyInvoices = invList.filter((inv) => {
      if (!inv || inv.partyId !== party.id) return false
      const status = String(inv.status || '').toLowerCase()
      return status !== 'paid' && status !== 'cancelled'
    })

    const openTotal = partyInvoices.reduce((sum, inv) => {
      const amt = inv.outstandingAmount !== undefined ? inv.outstandingAmount : inv.grandTotal
      return round2(sum + (Number(amt) || 0))
    }, 0)

    return {
      ...party,
      outstandingBalance: round2(openTotal),
    }
  })
}

/**
 * Splits a CSV row into columns, taking quoted strings and escaped quotes ("") into account.
 */
export function splitCsvRow(line: string): string[] {
  const cols: string[] = []
  let curr = ''
  let inQuote = false

  for (let c = 0; c < line.length; c++) {
    const char = line[c]
    if (char === '"') {
      if (inQuote && line[c + 1] === '"') {
        curr += '"'
        c++
      } else {
        inQuote = !inQuote
      }
    } else if (char === ',' && !inQuote) {
      cols.push(curr.trim())
      curr = ''
    } else {
      curr += char
    }
  }
  cols.push(curr.trim())
  return cols
}

/**
 * Parses financial string representations of bank transaction amounts:
 * - South African Rand tokens (R, ZAR) and symbols ($)
 * - Parenthetical negatives: (1,250.00) -> -1250.00
 * - Trailing negatives or DR/CR tokens: 1250.00- or 1250.00DR -> -1250.00
 * - Decimal commas with comma/space thousands: 1 250,50 -> 1250.50
 * - Comma thousands with decimal periods: 1,250.50 -> 1250.50
 * - Decimal commas without thousands: 1250,50 -> 1250.50
 * - Strictly rounded to 2 decimal places.
 */
export function parseBankAmount(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0
  if (typeof raw === 'number') return isNaN(raw) ? 0 : round2(raw)
  let s = String(raw).trim().replace(/['"]/g, '')
  if (!s) return 0

  let isNegative = false
  if (s.startsWith('(') && s.endsWith(')')) {
    isNegative = true
    s = s.slice(1, -1).trim()
  }

  // Check trailing minus or DR/CR tokens BEFORE stripping currency letters!
  if (s.endsWith('-')) {
    isNegative = true
    s = s.slice(0, -1).trim()
  } else if (/dr$/i.test(s)) {
    isNegative = true
    s = s.slice(0, -2).trim()
  } else if (/cr$/i.test(s)) {
    s = s.slice(0, -2).trim()
  }

  // Strip currency tokens and symbols: ZAR, R, $, €, £, and whitespace
  s = s
    .replace(/ZAR/gi, '')
    .replace(/[R$\u00A0\s€£]/gi, '')
    .trim()
  if (!s) return 0

  if (s.startsWith('-')) {
    isNegative = !isNegative
    s = s.slice(1).trim()
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim()
  }

  const hasComma = s.includes(',')
  const hasDot = s.includes('.')

  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(',')
    const lastDot = s.lastIndexOf('.')
    if (lastComma < lastDot) {
      // 1,250.50 -> strip comma
      s = s.replace(/,/g, '')
    } else {
      // 1.250,50 -> strip dot, convert comma to dot
      s = s.replace(/\./g, '').replace(',', '.')
    }
  } else if (hasComma && !hasDot) {
    const commaParts = s.split(',')
    if (commaParts.length === 2 && commaParts[1].length <= 2) {
      // Decimal comma: e.g. 1250,50 or 50,00
      s = s.replace(',', '.')
    } else {
      // Thousands separator: e.g. 1,250 or 1,000,000
      s = s.replace(/,/g, '')
    }
  }

  const num = parseFloat(s)
  if (isNaN(num)) return 0
  const result = isNegative ? -Math.abs(num) : Math.abs(num)
  return round2(result)
}

/**
 * Normalizes varied bank statement date formats to ISO YYYY-MM-DD:
 * Supports YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, DD-MM-YYYY, YYYYMMDD.
 */
export function normalizeDate(dateStr: string): string {
  if (!dateStr || typeof dateStr !== 'string') {
    return new Date().toISOString().split('T')[0]
  }
  const clean = dateStr.trim().replace(/['"]/g, '')

  // YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  const ymdMatch = clean.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (ymdMatch) {
    const [, y, m, d] = ymdMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
  const dmyMatch = clean.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // YYYYMMDD
  const compactMatch = clean.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compactMatch) {
    const [, y, m, d] = compactMatch
    return `${y}-${m}-${d}`
  }

  const parsed = new Date(clean)
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0]
  }

  return clean
}

/**
 * Parses South African bank statement CSVs:
 * Supports FNB, Standard Bank, Nedbank, Absa.
 * - Dynamically scans rows to find the actual header row, ignoring introductory account/balance metadata.
 * - Handles signed single amount columns vs separate Debit/Credit columns.
 * - Strips leading UTF-8 BOM if present.
 * - Ignores empty or summary rows (e.g. Total, Closing Balance).
 */
export function parseBankStatementCsv(csvText: string): BankTransaction[] {
  if (!csvText || typeof csvText !== 'string') return []
  const cleanText = csvText.replace(/^\uFEFF/, '')
  const lines = cleanText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length < 2) return []

  // Dynamic header search (first 25 rows)
  let headerRowIndex = 0
  let foundHeader = false
  const maxScan = Math.min(lines.length, 25)

  for (let i = 0; i < maxScan; i++) {
    const rawLine = lines[i]
    const cols = splitCsvRow(rawLine).map((c) => c.toLowerCase().replace(/['"]/g, '').trim())
    if (cols.length < 2) continue

    const hasDate = cols.some(
      (c) =>
        /(^date$|transaction\s*date|trans\s*date|posting\s*date|value\s*date)/i.test(c) ||
        (c.includes('date') &&
          !c.includes('statement') &&
          !c.includes('account') &&
          !c.includes('print')),
    )
    const hasAmount = cols.some(
      (c) =>
        !c.includes('balance') &&
        !c.includes('debit') &&
        !c.includes('credit') &&
        /(^amount$|transaction\s*amount|trans\s*amount|net\s*amount|total\s*amount|value|^amt$)/i.test(
          c,
        ),
    )
    const hasDebit = cols.some((c) =>
      /(^debit$|debit\s*amount|paid\s*out|money\s*out|withdrawal|withdrawals|payments?)/i.test(c),
    )
    const hasCredit = cols.some((c) =>
      /(^credit$|credit\s*amount|paid\s*in|money\s*in|deposits?|receipts?)/i.test(c),
    )
    const hasDesc = cols.some((c) =>
      /(desc|detail|narrative|particular|remark|memo|payee)/i.test(c),
    )

    if (
      hasDate &&
      (hasAmount ||
        (hasDebit && hasCredit) ||
        hasDebit ||
        hasCredit ||
        (hasDesc && cols.length >= 3))
    ) {
      headerRowIndex = i
      foundHeader = true
      break
    }
  }

  if (!foundHeader) {
    headerRowIndex = 0
  }

  const headers = splitCsvRow(lines[headerRowIndex]).map((h) =>
    h.toLowerCase().replace(/['"]/g, '').trim(),
  )

  const dateIdx = headers.findIndex(
    (h) =>
      /(^date$|transaction\s*date|trans\s*date|posting\s*date|value\s*date)/i.test(h) ||
      (h.includes('date') && !h.includes('statement') && !h.includes('account')),
  )
  const descIdx = headers.findIndex((h) =>
    /(desc|detail|narrative|particular|remark|memo|payee)/i.test(h),
  )
  const refIdx = headers.findIndex(
    (h) =>
      /^(ref|reference|ref\s*no|reference\s*number)$/i.test(h) ||
      (!h.includes('desc') && !h.includes('detail') && /ref/i.test(h)),
  )
  const amountIdx = headers.findIndex(
    (h) =>
      !h.includes('balance') &&
      !h.includes('debit') &&
      !h.includes('credit') &&
      /(^amount$|transaction\s*amount|trans\s*amount|net\s*amount|total\s*amount|value|^amt$)/i.test(
        h,
      ),
  )
  const debitIdx = headers.findIndex((h) =>
    /(^debit$|debit\s*amount|paid\s*out|money\s*out|withdrawal|withdrawals|payments?)/i.test(h),
  )
  const creditIdx = headers.findIndex((h) =>
    /(^credit$|credit\s*amount|paid\s*in|money\s*in|deposits?|receipts?)/i.test(h),
  )

  const transactions: BankTransaction[] = []

  for (let i = headerRowIndex + 1; i < lines.length; i++) {
    const rawLine = lines[i]
    const cols = splitCsvRow(rawLine)
    if (cols.length === 0 || !cols.some((c) => c.length > 0)) continue

    const rawDate = dateIdx >= 0 && cols[dateIdx] ? cols[dateIdx].trim() : ''
    // If date has no digits or contains total/balance, skip summary line
    if (!rawDate || !/\d/.test(rawDate) || /total|balance|closing|opening/i.test(rawDate)) {
      continue
    }

    let description = descIdx >= 0 && cols[descIdx] ? cols[descIdx].trim() : ''
    const reference = refIdx >= 0 && cols[refIdx] ? cols[refIdx].trim() : ''

    if (!description && reference) {
      description = reference
    }
    if (!description) {
      description = 'Bank Transaction'
    }

    let amount = 0
    if (debitIdx >= 0 || creditIdx >= 0) {
      const debRaw = debitIdx >= 0 && cols[debitIdx] ? cols[debitIdx] : ''
      const credRaw = creditIdx >= 0 && cols[creditIdx] ? cols[creditIdx] : ''
      const deb = parseBankAmount(debRaw)
      const cred = parseBankAmount(credRaw)

      if (cred !== 0 || deb !== 0) {
        const credVal = Math.abs(cred)
        const debVal = Math.abs(deb)
        amount = round2(credVal - debVal)
      } else if (amountIdx >= 0 && cols[amountIdx]) {
        amount = parseBankAmount(cols[amountIdx])
      }
    } else if (amountIdx >= 0 && cols[amountIdx]) {
      amount = parseBankAmount(cols[amountIdx])
    }

    if (isNaN(amount) || amount === 0) continue

    const txId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `tx-${crypto.randomUUID().slice(0, 8)}`
        : `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

    transactions.push({
      id: txId,
      accountId: 'acc-bank',
      date: normalizeDate(rawDate),
      description,
      reference,
      amount: round2(amount),
      reconciled: false,
    })
  }

  return transactions
}

/**
 * Resilient frequency-based deduplication of bank transactions.
 * Preserves legitimate identical transactions on the same day while preventing duplicates on re-import.
 */
export function deduplicateBankTransactions(
  parsed: BankTransaction[],
  existing: BankTransaction[],
): {
  toAdd: BankTransaction[]
  skippedDuplicates: number
  netAdjustment: number
} {
  const existingCounts = new Map<string, number>()
  for (const tx of existing || []) {
    const key = `${tx.date}|${tx.amount.toFixed(2)}|${(tx.description || '').trim().toLowerCase()}|${(tx.reference || '').trim().toLowerCase()}`
    existingCounts.set(key, (existingCounts.get(key) || 0) + 1)
  }

  const incomingCounts = new Map<string, number>()
  const toAdd: BankTransaction[] = []
  let skippedDuplicates = 0
  let netAdjustment = 0

  for (const tx of parsed) {
    const key = `${tx.date}|${tx.amount.toFixed(2)}|${(tx.description || '').trim().toLowerCase()}|${(tx.reference || '').trim().toLowerCase()}`
    const seen = incomingCounts.get(key) || 0
    incomingCounts.set(key, seen + 1)

    const existingCount = existingCounts.get(key) || 0
    if (seen < existingCount) {
      skippedDuplicates++
    } else {
      toAdd.push(tx)
      netAdjustment = round2(netAdjustment + tx.amount)
      existingCounts.set(key, existingCount + 1)
    }
  }

  return {
    toAdd,
    skippedDuplicates,
    netAdjustment: round2(netAdjustment),
  }
}

/* ════════════════════════════════════════════════════════════════════
   Ledger-first core (Phase 1 trust): account balances are DERIVED from
   journal entries. Stored `account.balance` fields are a serialization
   cache only — every read/write normalizes them through the journals.
   ════════════════════════════════════════════════════════════════════ */

/**
 * Issues the next invoice/bill number for a type + year using the highest
 * existing sequence (never `length + 1`, which collides after deletes).
 * Format: INV-YYYY-NNN / BILL-YYYY-NNN. Pass a `prefix` (e.g. 'CN') for
 * additional series like credit notes.
 */
export function nextInvoiceNumber(
  invoices: Invoice[],
  type: InvoiceType,
  date?: string,
  prefix?: string,
): string {
  const seriesPrefix = prefix || (type === 'Purchase' ? 'BILL' : 'INV')
  const year = date
    ? new Date(date).getFullYear() || new Date().getFullYear()
    : new Date().getFullYear()
  let maxSeq = 0
  const seriesRe = new RegExp(`^${seriesPrefix}-(\\d{4})-(\\d+)$`)
  for (const inv of invoices || []) {
    if (!inv || inv.type !== type) continue
    const m = String(inv.invoiceNumber || '').match(seriesRe)
    if (m && Number(m[1]) === year) {
      maxSeq = Math.max(maxSeq, Number(m[2]))
    }
  }
  return `${seriesPrefix}-${year}-${String(maxSeq + 1).padStart(3, '0')}`
}

/**
 * Issues the next journal entry number (JE-YYYY-NNN) from the highest
 * existing sequence, so deleting entries never reuses a number.
 */
export function nextJournalNumber(journalEntries: JournalEntry[], date?: string): string {
  const year = date
    ? new Date(date).getFullYear() || new Date().getFullYear()
    : new Date().getFullYear()
  let maxSeq = 0
  for (const je of journalEntries || []) {
    const m = String(je.entryNumber || '').match(/^JE-(\d{4})-(\d+)$/)
    if (m && Number(m[1]) === year) {
      maxSeq = Math.max(maxSeq, Number(m[2]))
    }
  }
  return `JE-${year}-${String(maxSeq + 1).padStart(3, '0')}`
}

/**
 * Derives every account balance from journal entries.
 * - Leaf accounts: sum of item debits minus credits, signed by the
 *   account's normal side (Asset/Expense are debit-normal).
 * - Group accounts: sum of their descendants (never journal items directly).
 * Returns a NEW array; stored balance fields are overwritten.
 */
export function computeAccountBalances(
  accounts: Account[],
  journalEntries: JournalEntry[],
): Account[] {
  const byId = new Map<string, Account>()
  for (const acc of accounts || []) {
    byId.set(acc.id, { ...acc, balance: 0 })
  }

  for (const je of journalEntries || []) {
    if (!je || !Array.isArray(je.items)) continue
    for (const it of je.items) {
      if (!it || typeof it.accountId !== 'string') continue
      const acc = byId.get(it.accountId)
      if (!acc) continue
      const signed = round2((Number(it.debit) || 0) - (Number(it.credit) || 0))
      if (acc.rootType === 'Asset' || acc.rootType === 'Expense') {
        acc.balance = round2(acc.balance + signed)
      } else {
        acc.balance = round2(acc.balance - signed)
      }
    }
  }

  const balanceOf = (id: string, visited: Set<string>): number => {
    const acc = byId.get(id)
    if (!acc) return 0
    if (visited.has(id)) return 0
    visited.add(id)
    if (!acc.isGroup) return acc.balance
    let sum = 0
    for (const child of byId.values()) {
      if (child.parentId === id) {
        sum = round2(sum + balanceOf(child.id, visited))
      }
    }
    return round2(sum)
  }

  for (const acc of byId.values()) {
    if (acc.isGroup) {
      acc.balance = balanceOf(acc.id, new Set())
    }
  }

  return Array.from(byId.values())
}

/**
 * Invariant check: stored account balances exactly match the balances
 * derived from journal entries (within rounding tolerance).
 */
export function accountsMatchJournals(
  accounts: Account[],
  journalEntries: JournalEntry[],
): boolean {
  const derived = computeAccountBalances(accounts, journalEntries)
  for (const acc of accounts || []) {
    const d = derived.find((x) => x.id === acc.id)
    if (!d) return false
    if (Math.abs(round2(d.balance) - round2(acc.balance || 0)) > 0.005) return false
  }
  return true
}

/**
 * Invariant check: every journal entry has strictly equal debits and
 * credits (both on the entry totals and across its items).
 */
export function allJournalsBalanced(journalEntries: JournalEntry[]): boolean {
  for (const je of journalEntries || []) {
    if (!je || !Array.isArray(je.items)) return false
    const sumDebits = round2(je.items.reduce((s, it) => s + (it.debit || 0), 0))
    const sumCredits = round2(je.items.reduce((s, it) => s + (it.credit || 0), 0))
    if (sumDebits !== sumCredits) return false
    if (round2(je.totalDebit) !== round2(je.totalCredit)) return false
    if (round2(je.totalDebit) !== sumDebits) return false
    if (round2(je.totalCredit) !== sumCredits) return false
  }
  return true
}

/**
 * Creates a balanced "Opening Balances" journal entry from the stored
 * (non-group) account balances. Any residual difference between total
 * debits and credits is posted against retained earnings so the opening
 * entry always balances.
 */
export function createOpeningJournal(
  accounts: Account[],
  opts?: { date?: string; entryNumber?: string; remarks?: string },
): JournalEntry {
  const dateStr = opts?.date || new Date().toISOString().split('T')[0]
  const year = new Date(dateStr).getFullYear() || new Date().getFullYear()
  const entryNumber = opts?.entryNumber || `JE-OPENING-${year}`

  const retained =
    accounts.find((a) => a.id === 'acc-retained') ||
    accounts.find((a) => a.rootType === 'Equity' && !a.isGroup)

  const items: JournalEntryItem[] = []
  let totalDebit = 0
  let totalCredit = 0

  for (const acc of accounts || []) {
    if (!acc || acc.isGroup) continue
    const bal = round2(acc.balance || 0)
    if (bal === 0) continue
    const debitNormal = acc.rootType === 'Asset' || acc.rootType === 'Expense'
    const debit = round2(debitNormal ? (bal > 0 ? bal : 0) : bal < 0 ? -bal : 0)
    const credit = round2(debitNormal ? (bal < 0 ? -bal : 0) : bal > 0 ? bal : 0)
    items.push({
      id: `jei-open-${acc.id}`,
      accountId: acc.id,
      accountName: acc.name,
      debit,
      credit,
      remark: 'Opening balance',
    })
    totalDebit = round2(totalDebit + debit)
    totalCredit = round2(totalCredit + credit)
  }

  const diff = round2(totalDebit - totalCredit)
  if (diff !== 0) {
    const rid = retained?.id || 'acc-retained'
    const rname = retained?.name || 'Retained Earnings'
    const debit = round2(diff < 0 ? -diff : 0)
    const credit = round2(diff > 0 ? diff : 0)
    items.push({
      id: `jei-open-${rid}-balancing`,
      accountId: rid,
      accountName: rname,
      debit,
      credit,
      remark: 'Opening balance balancing difference',
    })
    totalDebit = round2(totalDebit + debit)
    totalCredit = round2(totalCredit + credit)
  }

  return {
    id: `je-opening-${year}`,
    entryNumber,
    date: dateStr,
    items,
    totalDebit,
    totalCredit,
    remarks: opts?.remarks || 'Opening balances',
    posted: true,
  }
}

/**
 * Posts an imported bank statement transaction into the ledger:
 * - Deposit:  Dr Bank / Cr Bank Suspense
 * - Withdrawal: Cr Bank / Dr Bank Suspense
 * The Suspense side is cleared when the transaction is later reconciled
 * against an invoice (see createReconciliationJournal).
 */
export function createBankImportJournal(
  tx: BankTransaction,
  accounts: Account[],
  entryNumber?: string,
): JournalEntry {
  const bankAcc = accounts.find((a) => a.id === (tx.accountId || 'acc-bank')) ||
    accounts.find((a) => a.accountType === 'Bank') || {
      id: tx.accountId || 'acc-bank',
      name: 'Bank Account',
    }
  const suspAcc = accounts.find((a) => a.id === 'acc-suspense') || {
    id: 'acc-suspense',
    name: 'Bank Suspense / Clearing',
  }
  const isDeposit = tx.amount > 0
  const abs = round2(Math.abs(tx.amount))
  const year = new Date(tx.date).getFullYear() || new Date().getFullYear()
  const jeNumber = entryNumber || `JE-${year}-${String(Date.now()).slice(-4)}`

  const items: JournalEntryItem[] = isDeposit
    ? [
        {
          id: `jei-import-bank-${tx.id}`,
          accountId: bankAcc.id,
          accountName: bankAcc.name,
          debit: abs,
          credit: 0,
          remark: `Bank statement import: ${tx.id} - ${tx.description}`,
        },
        {
          id: `jei-import-susp-${tx.id}`,
          accountId: suspAcc.id,
          accountName: suspAcc.name,
          debit: 0,
          credit: abs,
          remark: `Bank statement import: ${tx.id}`,
        },
      ]
    : [
        {
          id: `jei-import-bank-${tx.id}`,
          accountId: bankAcc.id,
          accountName: bankAcc.name,
          debit: 0,
          credit: abs,
          remark: `Bank statement import: ${tx.id} - ${tx.description}`,
        },
        {
          id: `jei-import-susp-${tx.id}`,
          accountId: suspAcc.id,
          accountName: suspAcc.name,
          debit: abs,
          credit: 0,
          remark: `Bank statement import: ${tx.id}`,
        },
      ]

  return {
    id: `je-import-${tx.id}`,
    entryNumber: jeNumber,
    date: tx.date,
    items,
    totalDebit: abs,
    totalCredit: abs,
    remarks: `Bank statement import: ${tx.id} - ${tx.description}`,
    posted: true,
  }
}

/**
 * Posts the settlement leg of a bank-statement reconciliation WITHOUT
 * touching the bank account again (the import journal already moved it):
 * - Sales deposit:   Dr Bank Suspense / Cr Accounts Receivable
 * - Purchase payment: Dr Accounts Payable / Cr Bank Suspense
 */
export function createReconciliationJournal(
  tx: BankTransaction,
  invoice: Pick<
    Invoice,
    'id' | 'invoiceNumber' | 'type' | 'partyId' | 'partyName' | 'grandTotal' | 'outstandingAmount'
  >,
  accounts: Account[],
  settledAmount: number,
  entryNumber?: string,
): JournalEntry {
  const suspAcc = accounts.find((a) => a.id === 'acc-suspense') || {
    id: 'acc-suspense',
    name: 'Bank Suspense / Clearing',
  }
  const isSales = invoice.type === 'Sales'
  const arAcc = accounts.find((a) => a.id === 'acc-ar' || a.accountType === 'Receivable') || {
    id: 'acc-ar',
    name: 'Accounts Receivable (Debtors)',
  }
  const apAcc = accounts.find((a) => a.id === 'acc-ap' || a.accountType === 'Payable') || {
    id: 'acc-ap',
    name: 'Accounts Payable (Creditors)',
  }
  const year = new Date(tx.date).getFullYear() || new Date().getFullYear()
  const jeNumber = entryNumber || `JE-${year}-${String(Date.now()).slice(-4)}`

  const items: JournalEntryItem[] = isSales
    ? [
        {
          id: `jei-reclass-susp-${tx.id}`,
          accountId: suspAcc.id,
          accountName: suspAcc.name,
          debit: settledAmount,
          credit: 0,
          remark: `Clear suspense from statement transaction: ${tx.id}`,
        },
        {
          id: `jei-reclass-ar-${tx.id}`,
          accountId: arAcc.id,
          accountName: arAcc.name,
          partyId: invoice.partyId,
          partyName: invoice.partyName,
          debit: 0,
          credit: settledAmount,
          remark: `Settlement for Invoice ${invoice.invoiceNumber}`,
        },
      ]
    : [
        {
          id: `jei-reclass-ap-${tx.id}`,
          accountId: apAcc.id,
          accountName: apAcc.name,
          partyId: invoice.partyId,
          partyName: invoice.partyName,
          debit: settledAmount,
          credit: 0,
          remark: `Settlement for Bill ${invoice.invoiceNumber}`,
        },
        {
          id: `jei-reclass-susp-${tx.id}`,
          accountId: suspAcc.id,
          accountName: suspAcc.name,
          debit: 0,
          credit: settledAmount,
          remark: `Clear suspense from statement transaction: ${tx.id}`,
        },
      ]

  return {
    id: `je-reclass-${tx.id}`,
    entryNumber: jeNumber,
    date: tx.date,
    items,
    totalDebit: settledAmount,
    totalCredit: settledAmount,
    remarks: `1-Click Bank Reconciliation: Transaction ${tx.description} for Invoice ${invoice.invoiceNumber}`,
    posted: true,
  }
}

/** True when a journal entry was created from a bank statement import. */
export function isBankImportJournal(je: JournalEntry): boolean {
  return Boolean(je && je.remarks && /^Bank statement import:/.test(je.remarks))
}

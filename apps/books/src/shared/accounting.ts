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

/**
 * Creates a balanced JournalEntry for a Sales Invoice:
 * - Debit: Accounts Receivable (acc-ar) for invoice.grandTotal
 * - Credit: Income Account(s) (item.accountId or acc-sales) for invoice.subtotal
 * - Debit: invoice-level discount (invoice.discountTotal) on the first income
 *   account (remark 'Invoice discount'), keeping the VAT base consistent
 * - Credit: VAT Output Payable (acc-vat or acc-vat-out) for invoice.taxTotal (if taxTotal > 0)
 * - Final: round-off adjustment (invoice.roundOff) on the income account
 *   (remark 'Round-off adjustment') so the entry equals grandTotal
 * Total Debits strictly equal Total Credits.
 */
export function createSalesInvoiceJournal(
  invoice: Invoice,
  accounts: Account[],
  party?: Party,
  jeNumber?: string,
): JournalEntry {
  const roundOff = round2(Number(invoice.roundOff) || 0)
  const discountTotal = round2(Number(invoice.discountTotal) || 0)
  const taxTotal = round2(invoice.taxTotal)
  const grandTotal = round2(invoice.grandTotal || invoice.subtotal + taxTotal + roundOff)
  const subtotal = round2(
    invoice.subtotal !== undefined ? invoice.subtotal : grandTotal - taxTotal - roundOff,
  )

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

  // Group line items by revenue account if available
  const incomeGroups = new Map<string, { accountId: string; accountName: string; amount: number }>()

  if (Array.isArray(invoice.items) && invoice.items.length > 0) {
    for (const it of invoice.items) {
      const lineAmt = effectiveLineAmount(it)
      const accId = it.accountId || 'acc-sales'
      const matched = accounts.find((a) => a.id === accId)
      const accName = it.accountName || matched?.name || 'Tender & Commercial Contracting Sales'

      const existing = incomeGroups.get(accId) || {
        accountId: accId,
        accountName: accName,
        amount: 0,
      }
      existing.amount = round2(existing.amount + lineAmt)
      incomeGroups.set(accId, existing)
    }
  }

  if (incomeGroups.size === 0) {
    const salesAcc = accounts.find(
      (a) => a.id === 'acc-sales' || a.accountType === 'Direct Income',
    ) || {
      id: 'acc-sales',
      name: 'Tender & Commercial Contracting Sales',
    }
    incomeGroups.set(salesAcc.id, {
      accountId: salesAcc.id,
      accountName: salesAcc.name,
      amount: subtotal,
    })
  } else {
    // Ensure sum of item credits equals subtotal exactly to avoid 1-cent discrepancy
    const entries = Array.from(incomeGroups.values())
    const sumCredits = entries.reduce((s, e) => round2(s + e.amount), 0)
    const diff = round2(subtotal - sumCredits)
    if (diff !== 0 && entries.length > 0) {
      entries[entries.length - 1].amount = round2(entries[entries.length - 1].amount + diff)
    }
  }

  let incIdx = 1
  for (const inc of incomeGroups.values()) {
    if (inc.amount !== 0 || incomeGroups.size === 1 || subtotal === 0) {
      const isNegative = inc.amount < 0
      const absAmt = round2(Math.abs(inc.amount))
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
  }

  // Invoice-level discount: a negative item on the first income account.
  // The booked reduction never exceeds the (non-negative) subtotal so the
  // entry stays balanced even when the discount equals the whole invoice.
  if (discountTotal !== 0) {
    const first = Array.from(incomeGroups.values())[0]
    const discAmt = round2(subtotal >= 0 ? Math.min(discountTotal, subtotal) : discountTotal)
    if (discAmt !== 0) {
      items.push({
        id: `je-i-disc-${Date.now()}-${randomSuffix}`,
        accountId: first.accountId,
        accountName: first.accountName,
        debit: discAmt,
        credit: 0,
        remark: `Invoice discount - ${invoice.invoiceNumber}`,
      })
    }
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
      remark: isNegativeVat ? '15% VAT Output Adjustment' : '15% VAT Output',
    })
  }

  // Round-off: a final signed adjustment on the income account so the entry
  // equals grandTotal. roundOff > 0 (grand total rounded up) credits income;
  // roundOff < 0 (rounded down) debits income.
  if (roundOff !== 0) {
    const primary = Array.from(incomeGroups.values())[0] || {
      accountId: 'acc-sales',
      accountName: 'Tender & Commercial Contracting Sales',
    }
    const isRoundOffCredit = roundOff > 0
    const absRoundOff = round2(Math.abs(roundOff))
    items.push({
      id: `je-i-round-${Date.now()}-${randomSuffix}`,
      accountId: primary.accountId,
      accountName: primary.accountName,
      debit: isRoundOffCredit ? 0 : absRoundOff,
      credit: isRoundOffCredit ? absRoundOff : 0,
      remark: `Round-off adjustment - ${invoice.invoiceNumber}`,
    })
  }

  const totalDebit = round2(items.reduce((s, it) => s + it.debit, 0))
  const totalCredit = round2(items.reduce((s, it) => s + it.credit, 0))

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
 * Creates a balanced JournalEntry for a Purchase Bill:
 * - Debit: Expense Account(s) (item.accountId or acc-materials) for bill.subtotal
 * - Credit: invoice-level discount (bill.discountTotal) on the first expense
 *   account (remark 'Invoice discount'), keeping the VAT base consistent
 * - Debit: VAT Input Recoverable (acc-vat-in or acc-vat) for bill.taxTotal (if taxTotal > 0)
 * - Credit: Accounts Payable (acc-ap) for bill.grandTotal
 * - Final: round-off adjustment (bill.roundOff) on the expense account
 *   (remark 'Round-off adjustment') so the entry equals grandTotal
 * Total Debits strictly equal Total Credits.
 */
export function createPurchaseBillJournal(
  bill: Invoice,
  accounts: Account[],
  party?: Party,
  jeNumber?: string,
): JournalEntry {
  const roundOff = round2(Number(bill.roundOff) || 0)
  const discountTotal = round2(Number(bill.discountTotal) || 0)
  const taxTotal = round2(bill.taxTotal)
  const grandTotal = round2(bill.grandTotal || bill.subtotal + taxTotal + roundOff)
  const subtotal = round2(
    bill.subtotal !== undefined ? bill.subtotal : grandTotal - taxTotal - roundOff,
  )

  const dateStr = bill.date || new Date().toISOString().split('T')[0]
  const year = new Date(dateStr).getFullYear() || new Date().getFullYear()
  const randomSuffix = Math.random().toString(36).slice(2, 7)
  const entryNum = jeNumber || `JE-${year}-${String(Date.now()).slice(-4)}-${randomSuffix}`

  const items: JournalEntryItem[] = []

  // Group line items by expense account if available
  const expenseGroups = new Map<
    string,
    { accountId: string; accountName: string; amount: number }
  >()

  if (Array.isArray(bill.items) && bill.items.length > 0) {
    for (const it of bill.items) {
      const lineAmt = effectiveLineAmount(it)
      const accId = it.accountId || 'acc-materials'
      const matched = accounts.find((a) => a.id === accId)
      const accName = it.accountName || matched?.name || 'Direct Project Materials & Subcontractors'

      const existing = expenseGroups.get(accId) || {
        accountId: accId,
        accountName: accName,
        amount: 0,
      }
      existing.amount = round2(existing.amount + lineAmt)
      expenseGroups.set(accId, existing)
    }
  }

  if (expenseGroups.size === 0) {
    const matAcc = accounts.find(
      (a) => a.id === 'acc-materials' || a.accountType === 'Direct Expense',
    ) || {
      id: 'acc-materials',
      name: 'Direct Project Materials & Subcontractors',
    }
    expenseGroups.set(matAcc.id, {
      accountId: matAcc.id,
      accountName: matAcc.name,
      amount: subtotal,
    })
  } else {
    // Ensure sum of item debits equals subtotal exactly
    const entries = Array.from(expenseGroups.values())
    const sumDebits = entries.reduce((s, e) => round2(s + e.amount), 0)
    const diff = round2(subtotal - sumDebits)
    if (diff !== 0 && entries.length > 0) {
      entries[entries.length - 1].amount = round2(entries[entries.length - 1].amount + diff)
    }
  }

  let expIdx = 1
  for (const exp of expenseGroups.values()) {
    if (exp.amount !== 0 || expenseGroups.size === 1 || subtotal === 0) {
      const isNegative = exp.amount < 0
      const absAmt = round2(Math.abs(exp.amount))
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
  }

  // Invoice-level discount: a negative item on the first expense account.
  // The booked reduction never exceeds the (non-negative) subtotal so the
  // entry stays balanced even when the discount equals the whole bill.
  if (discountTotal !== 0) {
    const first = Array.from(expenseGroups.values())[0]
    const discAmt = round2(subtotal >= 0 ? Math.min(discountTotal, subtotal) : discountTotal)
    if (discAmt !== 0) {
      items.push({
        id: `je-i-disc-${Date.now()}-${randomSuffix}`,
        accountId: first.accountId,
        accountName: first.accountName,
        debit: 0,
        credit: discAmt,
        remark: `Invoice discount - ${bill.invoiceNumber}`,
      })
    }
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
      remark: isNegativeTax ? '15% VAT Input Adjustment' : '15% VAT Input Recoverable',
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

  // Round-off: a final signed adjustment on the expense account so the entry
  // equals grandTotal. roundOff > 0 (bill total rounded up) debits expense;
  // roundOff < 0 (rounded down) credits expense.
  if (roundOff !== 0) {
    const primary = Array.from(expenseGroups.values())[0] || {
      accountId: 'acc-materials',
      accountName: 'Direct Project Materials & Subcontractors',
    }
    const isRoundOffDebit = roundOff > 0
    const absRoundOff = round2(Math.abs(roundOff))
    items.push({
      id: `je-i-round-${Date.now()}-${randomSuffix}`,
      accountId: primary.accountId,
      accountName: primary.accountName,
      debit: isRoundOffDebit ? absRoundOff : 0,
      credit: isRoundOffDebit ? 0 : absRoundOff,
      remark: `Round-off adjustment - ${bill.invoiceNumber}`,
    })
  }

  const totalDebit = round2(items.reduce((s, it) => s + it.debit, 0))
  const totalCredit = round2(items.reduce((s, it) => s + it.credit, 0))

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
    name: 'FNB Business Cheque Account',
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

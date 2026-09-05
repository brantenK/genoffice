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
 * Calculates subtotal, taxTotal, and grandTotal from line items.
 * Strictly guarantees that subtotal + taxTotal === grandTotal to 2 decimal places.
 */
export function calculateInvoiceTotals(items: InvoiceItem[]): {
  subtotal: number
  taxTotal: number
  grandTotal: number
} {
  if (!Array.isArray(items) || items.length === 0) {
    return { subtotal: 0, taxTotal: 0, grandTotal: 0 }
  }

  let subtotal = 0
  let taxTotal = 0

  for (const it of items) {
    let lineAmt = 0
    if (
      it.qty != null &&
      it.rate != null &&
      !isNaN(Number(it.qty)) &&
      !isNaN(Number(it.rate))
    ) {
      lineAmt = round2(Number(it.qty) * Number(it.rate))
    } else if (it.amount != null && !isNaN(Number(it.amount))) {
      lineAmt = round2(Number(it.amount))
    }

    const taxRate = Number(it.taxRate) || 0
    const lineTax = round2((lineAmt * taxRate) / 100)

    subtotal = round2(subtotal + lineAmt)
    taxTotal = round2(taxTotal + lineTax)
  }

  const grandTotal = round2(subtotal + taxTotal)
  return { subtotal, taxTotal, grandTotal }
}

/**
 * Creates a balanced JournalEntry for a Sales Invoice:
 * - Debit: Accounts Receivable (acc-ar) for invoice.grandTotal
 * - Credit: Income Account(s) (item.accountId or acc-sales) for invoice.subtotal
 * - Credit: VAT Output Payable (acc-vat or acc-vat-out) for invoice.taxTotal (if taxTotal > 0)
 * Total Debits strictly equal Total Credits.
 */
export function createSalesInvoiceJournal(
  invoice: Invoice,
  accounts: Account[],
  party?: Party,
  jeNumber?: string
): JournalEntry {
  const grandTotal = round2(invoice.grandTotal || (invoice.subtotal + invoice.taxTotal))
  const taxTotal = round2(invoice.taxTotal)
  const subtotal = round2(grandTotal - taxTotal)

  const dateStr = invoice.date || new Date().toISOString().split('T')[0]
  const year = new Date(dateStr).getFullYear() || new Date().getFullYear()
  const randomSuffix = Math.random().toString(36).slice(2, 7)
  const entryNum =
    jeNumber ||
    `JE-${year}-${String(Date.now()).slice(-4)}-${randomSuffix}`

  const arAcc =
    accounts.find((a) => a.id === 'acc-ar' || a.accountType === 'Receivable') || {
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
      let lineAmt = 0
      if (
        it.qty != null &&
        it.rate != null &&
        !isNaN(Number(it.qty)) &&
        !isNaN(Number(it.rate))
      ) {
        lineAmt = round2(Number(it.qty) * Number(it.rate))
      } else if (it.amount != null && !isNaN(Number(it.amount))) {
        lineAmt = round2(Number(it.amount))
      }
      const accId = it.accountId || 'acc-sales'
      const matched = accounts.find((a) => a.id === accId)
      const accName = it.accountName || matched?.name || 'Tender & Commercial Contracting Sales'

      const existing = incomeGroups.get(accId) || { accountId: accId, accountName: accName, amount: 0 }
      existing.amount = round2(existing.amount + lineAmt)
      incomeGroups.set(accId, existing)
    }
  }

  if (incomeGroups.size === 0) {
    const salesAcc =
      accounts.find((a) => a.id === 'acc-sales' || a.accountType === 'Direct Income') || {
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

  if (taxTotal !== 0) {
    const vatAcc =
      accounts.find((a) => a.id === 'acc-vat' || a.id === 'acc-vat-out') || {
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
 * - Debit: VAT Input Recoverable (acc-vat-in or acc-vat) for bill.taxTotal (if taxTotal > 0)
 * - Credit: Accounts Payable (acc-ap) for bill.grandTotal
 * Total Debits strictly equal Total Credits.
 */
export function createPurchaseBillJournal(
  bill: Invoice,
  accounts: Account[],
  party?: Party,
  jeNumber?: string
): JournalEntry {
  const grandTotal = round2(bill.grandTotal || (bill.subtotal + bill.taxTotal))
  const taxTotal = round2(bill.taxTotal)
  const subtotal = round2(grandTotal - taxTotal)

  const dateStr = bill.date || new Date().toISOString().split('T')[0]
  const year = new Date(dateStr).getFullYear() || new Date().getFullYear()
  const randomSuffix = Math.random().toString(36).slice(2, 7)
  const entryNum =
    jeNumber ||
    `JE-${year}-${String(Date.now()).slice(-4)}-${randomSuffix}`

  const items: JournalEntryItem[] = []

  // Group line items by expense account if available
  const expenseGroups = new Map<string, { accountId: string; accountName: string; amount: number }>()

  if (Array.isArray(bill.items) && bill.items.length > 0) {
    for (const it of bill.items) {
      let lineAmt = 0
      if (
        it.qty != null &&
        it.rate != null &&
        !isNaN(Number(it.qty)) &&
        !isNaN(Number(it.rate))
      ) {
        lineAmt = round2(Number(it.qty) * Number(it.rate))
      } else if (it.amount != null && !isNaN(Number(it.amount))) {
        lineAmt = round2(Number(it.amount))
      }
      const accId = it.accountId || 'acc-materials'
      const matched = accounts.find((a) => a.id === accId)
      const accName =
        it.accountName || matched?.name || 'Direct Project Materials & Subcontractors'

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
    const matAcc =
      accounts.find((a) => a.id === 'acc-materials' || a.accountType === 'Direct Expense') || {
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

  if (taxTotal !== 0) {
    const vatInAcc =
      accounts.find((a) => a.id === 'acc-vat-in') ||
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
      remark: isNegativeTax
        ? '15% VAT Input Adjustment'
        : '15% VAT Input Recoverable',
    })
  }

  const apAcc =
    accounts.find((a) => a.id === 'acc-ap' || a.accountType === 'Payable') || {
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
  invoice: Pick<Invoice, 'id' | 'invoiceNumber' | 'type' | 'partyId' | 'partyName' | 'grandTotal' | 'outstandingAmount'>
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
  remarksParam?: string
): JournalEntry {
  let invoice: Pick<Invoice, 'id' | 'invoiceNumber' | 'type' | 'partyId' | 'partyName' | 'grandTotal' | 'outstandingAmount'>
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
        : invoice.grandTotal
  )

  const year = new Date(dateStr).getFullYear() || new Date().getFullYear()
  const randomSuffix = Math.random().toString(36).slice(2, 7)
  const entryNum =
    jeNumber ||
    `JE-${year}-${String(Date.now()).slice(-4)}-${randomSuffix}`

  const bankAcc =
    accounts.find((a) => a.id === bankAccountId || a.accountType === 'Bank') || {
      id: bankAccountId,
      name: 'FNB Business Cheque Account',
    }

  const isSales = invoice.type === 'Sales'

  let items: JournalEntryItem[]
  if (isSales) {
    const arAcc =
      accounts.find((a) => a.id === 'acc-ar' || a.accountType === 'Receivable') || {
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
    const apAcc =
      accounts.find((a) => a.id === 'acc-ap' || a.accountType === 'Payable') || {
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
      const amt =
        inv.outstandingAmount !== undefined ? inv.outstandingAmount : inv.grandTotal
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
  s = s.replace(/ZAR/gi, '').replace(/[R$\u00A0\s€£]/gi, '').trim()
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
    const cols = splitCsvRow(rawLine).map((c) =>
      c.toLowerCase().replace(/['"]/g, '').trim()
    )
    if (cols.length < 2) continue

    const hasDate = cols.some(
      (c) =>
        /(^date$|transaction\s*date|trans\s*date|posting\s*date|value\s*date)/i.test(c) ||
        (c.includes('date') && !c.includes('statement') && !c.includes('account') && !c.includes('print'))
    )
    const hasAmount = cols.some(
      (c) =>
        !c.includes('balance') &&
        !c.includes('debit') &&
        !c.includes('credit') &&
        /(^amount$|transaction\s*amount|trans\s*amount|net\s*amount|total\s*amount|value|^amt$)/i.test(c)
    )
    const hasDebit = cols.some((c) =>
      /(^debit$|debit\s*amount|paid\s*out|money\s*out|withdrawal|withdrawals|payments?)/i.test(c)
    )
    const hasCredit = cols.some((c) =>
      /(^credit$|credit\s*amount|paid\s*in|money\s*in|deposits?|receipts?)/i.test(c)
    )
    const hasDesc = cols.some((c) =>
      /(desc|detail|narrative|particular|remark|memo|payee)/i.test(c)
    )

    if (hasDate && (hasAmount || (hasDebit && hasCredit) || hasDebit || hasCredit || (hasDesc && cols.length >= 3))) {
      headerRowIndex = i
      foundHeader = true
      break
    }
  }

  if (!foundHeader) {
    headerRowIndex = 0
  }

  const headers = splitCsvRow(lines[headerRowIndex]).map((h) =>
    h.toLowerCase().replace(/['"]/g, '').trim()
  )

  const dateIdx = headers.findIndex(
    (h) =>
      /(^date$|transaction\s*date|trans\s*date|posting\s*date|value\s*date)/i.test(h) ||
      (h.includes('date') && !h.includes('statement') && !h.includes('account'))
  )
  const descIdx = headers.findIndex((h) =>
    /(desc|detail|narrative|particular|remark|memo|payee)/i.test(h)
  )
  const refIdx = headers.findIndex(
    (h) =>
      /^(ref|reference|ref\s*no|reference\s*number)$/i.test(h) ||
      (!h.includes('desc') && !h.includes('detail') && /ref/i.test(h))
  )
  const amountIdx = headers.findIndex(
    (h) =>
      !h.includes('balance') &&
      !h.includes('debit') &&
      !h.includes('credit') &&
      /(^amount$|transaction\s*amount|trans\s*amount|net\s*amount|total\s*amount|value|^amt$)/i.test(h)
  )
  const debitIdx = headers.findIndex((h) =>
    /(^debit$|debit\s*amount|paid\s*out|money\s*out|withdrawal|withdrawals|payments?)/i.test(h)
  )
  const creditIdx = headers.findIndex((h) =>
    /(^credit$|credit\s*amount|paid\s*in|money\s*in|deposits?|receipts?)/i.test(h)
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
  existing: BankTransaction[]
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


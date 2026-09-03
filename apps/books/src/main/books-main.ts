import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, ipcMain, WebContentsView } from 'electron'
import { BOOKS_CHANNELS } from '../shared/ipc'
import type {
  Account,
  BankTransaction,
  BooksData,
  BooksDataEnvelope,
  CompanySettings,
  Invoice,
  JournalEntry,
  Party,
  SettlementSuggestion,
} from '../shared/types'

export const CURRENT_BOOKS_SCHEMA_VERSION = 1

export const DEFAULT_BOOK_SETTINGS: CompanySettings = {
  companyName: 'Zano Consulting & Engineering (Pty) Ltd',
  taxNumber: '4920198273',
  currency: 'ZAR',
  currencySymbol: 'R',
  financialYearStart: '2026-03-01',
  address: '14 Commerce Square, Sandton, Johannesburg, 2196',
  email: 'accounts@zanostack.tech',
  phone: '+27 11 555 0192',
}

export const CORE_ACCOUNTS: Account[] = [
  { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: 485250 },
  { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', parentId: 'acc-curr-asset', isGroup: false, balance: 195500 },
  { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', parentId: 'acc-curr-liab', isGroup: false, balance: 74200 },
  { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 820000 },
  { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 38400 },
]

export function migrateAndValidateBooks(raw: unknown): BooksDataEnvelope {
  const now = new Date().toISOString()
  if (!raw || typeof raw !== 'object') {
    return {
      version: CURRENT_BOOKS_SCHEMA_VERSION,
      updatedAt: now,
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts: [...CORE_ACCOUNTS],
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
    }
  }

  const r = raw as Record<string, unknown>
  const version = typeof r.version === 'number' && r.version >= 1 ? r.version : CURRENT_BOOKS_SCHEMA_VERSION
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt.trim() ? r.updatedAt : now

  const settings: CompanySettings = (r.settings && typeof r.settings === 'object')
    ? { ...DEFAULT_BOOK_SETTINGS, ...(r.settings as Partial<CompanySettings>) }
    : { ...DEFAULT_BOOK_SETTINGS }

  const existingAccounts: Account[] = Array.isArray(r.accounts) ? (r.accounts as Account[]) : []
  const accountsMap = new Map<string, Account>()
  for (const acc of existingAccounts) {
    if (acc && typeof acc.id === 'string') {
      accountsMap.set(acc.id, acc)
    }
  }

  for (const core of CORE_ACCOUNTS) {
    if (!accountsMap.has(core.id)) {
      accountsMap.set(core.id, { ...core })
    }
  }
  const accounts = Array.from(accountsMap.values())

  const parties: Party[] = Array.isArray(r.parties) ? (r.parties as Party[]) : []
  const invoices: Invoice[] = Array.isArray(r.invoices) ? (r.invoices as Invoice[]) : []
  const journalEntries: JournalEntry[] = Array.isArray(r.journalEntries) ? (r.journalEntries as JournalEntry[]) : []

  const rawBankTx = Array.isArray(r.bankTransactions) ? r.bankTransactions : []
  const bankTransactions: BankTransaction[] = []
  for (const item of rawBankTx) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as any).id === 'string' &&
      typeof (item as any).date === 'string' &&
      typeof (item as any).description === 'string' &&
      typeof (item as any).amount === 'number' &&
      Number.isFinite((item as any).amount) &&
      typeof (item as any).reconciled === 'boolean'
    ) {
      // Spread all fields first to preserve extension fields (e.g. swiftMessageId, customRef),
      // then overlay validated known fields with normalised values.
      bankTransactions.push({
        ...(item as any),
        id: (item as any).id,
        accountId: 'acc-bank',
        date: (item as any).date,
        description: (item as any).description,
        reference: typeof (item as any).reference === 'string' ? (item as any).reference : '',
        amount: Math.round((item as any).amount * 100) / 100,
        reconciled: (item as any).reconciled,
        matchedInvoiceId: typeof (item as any).matchedInvoiceId === 'string' ? (item as any).matchedInvoiceId : undefined,
        reconciledAt: typeof (item as any).reconciledAt === 'string' ? (item as any).reconciledAt : undefined,
      })
    }
  }


  return {
    version,
    updatedAt,
    settings,
    accounts,
    parties,
    invoices,
    journalEntries,
    bankTransactions,
  }
}

export function readBooksStore(baseDirOrPath: string): BooksDataEnvelope {
  const filePath = baseDirOrPath.endsWith('books-data.json') ? baseDirOrPath : join(baseDirOrPath, 'books-data.json')
  if (!existsSync(filePath)) {
    return {
      version: CURRENT_BOOKS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts: [...CORE_ACCOUNTS],
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
    }
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (err) {
    console.error('books-main: failed to read books-data.json:', err)
    return {
      version: CURRENT_BOOKS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts: [...CORE_ACCOUNTS],
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
    }
  }

  try {
    const parsed = JSON.parse(content)
    return migrateAndValidateBooks(parsed)
  } catch (parseErr) {
    const backupPath = `${filePath}.corrupted.bak`
    try {
      writeFileSync(backupPath, content, 'utf8')
      console.warn(`books-main: Corrupted books file detected. Backed up to ${backupPath}`)
    } catch (bakErr) {
      console.error('books-main: Failed to write corrupted backup file', bakErr)
    }
    return {
      version: CURRENT_BOOKS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts: [...CORE_ACCOUNTS],
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
    }
  }
}

export function writeBooksStore(baseDirOrPath: string, data: unknown): void {
  const filePath = baseDirOrPath.endsWith('books-data.json') ? baseDirOrPath : join(baseDirOrPath, 'books-data.json')
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const validated = migrateAndValidateBooks(data)
  const tmp = `${filePath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf8')
    renameSync(tmp, filePath)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    console.error('books-main: failed to atomically write books store', filePath, e)
    throw e
  }
}

export interface BooksRuntimeConfig {
  preloadPath: string
  rendererUrl?: string | undefined
  rendererFile: string
  openGeneratedPath?: (path: string) => boolean
  onOpenCrm?: () => void
  onOpenTenders?: () => void
}

let runtime: BooksRuntimeConfig = {
  preloadPath: '',
  rendererFile: '',
}

let ipcRegistered = false

function getStoragePath(): string {
  const dir = join(app.getPath('userData'), 'books')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, 'books-data.json')
}

export function configureBooksRuntime(config: BooksRuntimeConfig): void {
  runtime = { ...runtime, ...config }
}

export function registerBooksIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  // Load persistence
  ipcMain.handle(BOOKS_CHANNELS.loadData, () => {
    try {
      const p = getStoragePath()
      if (existsSync(p)) {
        return readBooksStore(p)
      }
      return null
    } catch {
      return null
    }
  })

  // Save persistence
  ipcMain.handle(BOOKS_CHANNELS.saveData, (_e, data: BooksData) => {
    try {
      const p = getStoragePath()
      writeBooksStore(p, data)
      return true
    } catch {
      return false
    }
  })

  // Cross-App: Export to Sheets
  ipcMain.handle(BOOKS_CHANNELS.exportToSheets, (_e, reportName: string, csvContent: string) => {
    try {
      const safeName = (reportName || 'Financial_Report').replace(/[^a-zA-Z0-9_-]/g, '_')
      const targetPath = join(tmpdir(), `${safeName}_${Date.now()}.csv`)
      writeFileSync(targetPath, csvContent, 'utf8')

      if (runtime.openGeneratedPath) {
        runtime.openGeneratedPath(targetPath)
      }
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to export report to Sheets' }
    }
  })

  // Cross-App: Print & Sign in PDF
  ipcMain.handle(BOOKS_CHANNELS.openInPdf, (_e, invoice: Invoice, companyName: string) => {
    try {
      const invoiceNo = (invoice?.invoiceNumber || 'INV-0001').replace(/[^a-zA-Z0-9_-]/g, '_')
      const targetPath = join(tmpdir(), `Tax_Invoice_${invoiceNo}.md`)
      
      const content = `# TAX INVOICE: ${invoice?.invoiceNumber}

**Issuer:** ${companyName || 'Zano Consulting (Pty) Ltd'}  
**Client / Billed To:** ${invoice?.partyName || 'Customer'}  
**Invoice Date:** ${invoice?.date}  
**Payment Due:** ${invoice?.dueDate}  
**Status:** ${invoice?.status?.toUpperCase()}  
${invoice?.tenderReference ? `**Reference:** ${invoice.tenderReference}  ` : ''}

---

### Line Items
| # | Description | Qty | Unit Rate | Tax Rate | Amount |
|---|---|---|---|---|---|
${(invoice?.items || []).map((it, idx) => `| ${idx + 1} | ${it.description} | ${it.qty} | R ${it.rate.toFixed(2)} | ${it.taxRate}% | R ${it.amount.toFixed(2)} |`).join('\n')}

---

### Summary
- **Subtotal:** R ${(invoice?.subtotal || 0).toFixed(2)}
- **VAT / Tax (15%):** R ${(invoice?.taxTotal || 0).toFixed(2)}
- **Grand Total:** R ${(invoice?.grandTotal || 0).toFixed(2)}
- **Amount Due:** R ${(invoice?.outstandingAmount || 0).toFixed(2)}

**Notes & Banking Details:**
${invoice?.notes || 'Standard 30 days payment terms. Please use invoice number as reference.'}

---
*Generated via Zano Books — Sovereign Financial Management*
`
      writeFileSync(targetPath, content, 'utf8')

      if (runtime.openGeneratedPath) {
        runtime.openGeneratedPath(targetPath)
      }
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to open invoice in PDF' }
    }
  })

  // Cross-App: Open CRM
  ipcMain.handle(BOOKS_CHANNELS.openInCrm, () => {
    if (runtime.onOpenCrm) {
      runtime.onOpenCrm()
      return true
    }
    return false
  })

  // Cross-App: Open Tenders
  ipcMain.handle(BOOKS_CHANNELS.openInTenders, () => {
    if (runtime.onOpenTenders) {
      runtime.onOpenTenders()
      return true
    }
    return false
  })

  // Bank reconciliation: Import CSV
  ipcMain.handle(BOOKS_CHANNELS.importBankStatementCsv, (_e, csvContent: string) => {
    try {
      const p = getStoragePath()
      return importBankStatement({ booksDataPath: p, csvContent })
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to import bank statement' }
    }
  })

  // Bank reconciliation: Reconcile transaction with invoice
  ipcMain.handle(BOOKS_CHANNELS.reconcileTransaction, (_e, transactionId: string, invoiceId: string) => {
    try {
      const p = getStoragePath()
      return executeReconciliation({ booksDataPath: p, transactionId, invoiceId })
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to reconcile transaction' }
    }
  })

  // Bank reconciliation: Get settlement suggestions
  ipcMain.handle(BOOKS_CHANNELS.getSettlementSuggestions, () => {
    try {
      const p = getStoragePath()
      const data = readBooksStore(p)
      return computeSettlementSuggestions(data)
    } catch {
      return []
    }
  })
}

export function parseBankStatementCsv(csvText: string): BankTransaction[] {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length < 2) return []

  const headerLine = lines[0]
  const headers = headerLine.split(',').map((h) => h.trim().toLowerCase().replace(/['"]/g, ''))

  const dateIdx = headers.findIndex((h) => h.includes('date'))
  const descIdx = headers.findIndex((h) => h.includes('desc') || h.includes('details') || h.includes('narrative'))
  const refIdx = headers.findIndex((h) => h.includes('ref'))
  const amountIdx = headers.findIndex((h) => h === 'amount' || h === 'value')
  const debitIdx = headers.findIndex((h) => h.includes('debit'))
  const creditIdx = headers.findIndex((h) => h.includes('credit'))

  const transactions: BankTransaction[] = []

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i]
    // Simple CSV parser handling quotes
    const cols: string[] = []
    let curr = ''
    let inQuote = false

    for (let c = 0; c < rawLine.length; c++) {
      const char = rawLine[c]
      if (char === '"') {
        inQuote = !inQuote
      } else if (char === ',' && !inQuote) {
        cols.push(curr.trim())
        curr = ''
      } else {
        curr += char
      }
    }
    cols.push(curr.trim())

    if (cols.length === 0 || !cols.some((c) => c.length > 0)) continue

    const date = dateIdx >= 0 && cols[dateIdx] ? cols[dateIdx] : new Date().toISOString().split('T')[0]
    const description = descIdx >= 0 && cols[descIdx] ? cols[descIdx] : 'Bank Transaction'
    const reference = refIdx >= 0 && cols[refIdx] ? cols[refIdx] : ''

    let amount = 0
    if (amountIdx >= 0 && cols[amountIdx]) {
      let clean = cols[amountIdx].replace(/[R$\s]/g, '').replace(/,/g, '')
      // Handle parenthesized negative: (25000) or (R 25,000)
      if (clean.startsWith('(') && clean.endsWith(')')) {
        clean = '-' + clean.slice(1, -1)
      }
      amount = parseFloat(clean) || 0
    } else if (debitIdx >= 0 || creditIdx >= 0) {
      const debRaw = debitIdx >= 0 && cols[debitIdx] ? cols[debitIdx].replace(/[R$\s]/g, '').replace(/,/g, '') : '0'
      const credRaw = creditIdx >= 0 && cols[creditIdx] ? cols[creditIdx].replace(/[R$\s]/g, '').replace(/,/g, '') : '0'
      const deb = parseFloat(debRaw) || 0
      const cred = parseFloat(credRaw) || 0
      amount = cred > 0 ? cred : -deb
    }

    if (isNaN(amount) || amount === 0) continue

    transactions.push({
      id: `tx-${randomUUID().slice(0, 8)}`,
      accountId: 'acc-bank',
      date,
      description,
      reference,
      amount: Math.round(amount * 100) / 100,
      reconciled: false,
    })
  }

  return transactions
}

export function importBankStatement({
  booksDataPath,
  csvContent,
}: {
  booksDataPath: string
  csvContent: string
}): {
  ok: boolean
  importedCount?: number
  skippedDuplicates?: number
  netAdjustment?: number
  newBankBalance?: number | null
  transactions?: BankTransaction[]
  error?: string
} {
  const booksData = readBooksStore(booksDataPath)

  const parsed = parseBankStatementCsv(csvContent)
  if (parsed.length === 0) {
    return { ok: false, error: 'No valid transactions found in statement CSV' }
  }

  // Deduplicate against existing bank transactions by fingerprint
  const existing = booksData.bankTransactions || []
  const existingFingerprints = new Set(existing.map((t) => `${t.date}|${t.description}|${t.amount}`))

  const toAdd: BankTransaction[] = []
  let netAdjustment = 0

  for (const tx of parsed) {
    const fp = `${tx.date}|${tx.description}|${tx.amount}`
    if (!existingFingerprints.has(fp)) {
      toAdd.push(tx)
      netAdjustment += tx.amount
      existingFingerprints.add(fp)
    }
  }

  booksData.bankTransactions = [...existing, ...toAdd]

  // Adjust Bank Account ledger balance by net transaction amount
  const bankAccount = booksData.accounts.find((a) => a.id === 'acc-bank')
  if (bankAccount) {
    bankAccount.balance = Math.round((bankAccount.balance + netAdjustment) * 100) / 100
  }

  booksData.updatedAt = new Date().toISOString()
  writeBooksStore(booksDataPath, booksData)

  return {
    ok: true,
    importedCount: toAdd.length,
    skippedDuplicates: parsed.length - toAdd.length,
    netAdjustment: Math.round(netAdjustment * 100) / 100,
    newBankBalance: bankAccount ? bankAccount.balance : null,
    transactions: toAdd,
  }
}

export function computeSettlementSuggestions(booksData: BooksData): SettlementSuggestion[] {
  const transactions = (booksData.bankTransactions || []).filter((t) => !t.reconciled)
  const openInvoices = (booksData.invoices || []).filter((i) => i.status !== 'Paid' && i.outstandingAmount > 0)

  const suggestions: SettlementSuggestion[] = []

  for (const tx of transactions) {
    const isDeposit = tx.amount > 0
    const targetType = isDeposit ? 'Sales' : 'Purchase'
    const targetAmount = Math.abs(tx.amount)

    const candidates = openInvoices.filter((i) => i.type === targetType)

    for (const inv of candidates) {
      const amountMatches = Math.abs(inv.outstandingAmount - targetAmount) < 0.01

      if (!amountMatches) continue

      // Check text tokens for HIGH confidence match
      const textToSearch = `${tx.description} ${tx.reference || ''}`.toLowerCase()
      const invNoMatch = Boolean(inv.invoiceNumber && textToSearch.includes(inv.invoiceNumber.toLowerCase()))
      const tenderMatch = Boolean(inv.tenderReference && textToSearch.includes(inv.tenderReference.toLowerCase()))

      // Split party name into significant keywords (length >= 4, ignoring common stop words)
      const stopWords = new Set(['city', 'of', 'the', 'and', 'dept', 'ltd', 'pty', 'inc', 'corp', 'co'])
      const partyTokens = (inv.partyName || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !stopWords.has(t))

      const partyMatch =
        Boolean(inv.partyName && textToSearch.includes(inv.partyName.toLowerCase())) ||
        (partyTokens.length > 0 && partyTokens.some((t) => textToSearch.includes(t)))

      let confidence: 'HIGH' | 'MEDIUM' = 'MEDIUM'
      let reason = 'Exact amount matches outstanding invoice'

      if (invNoMatch) {
        confidence = 'HIGH'
        reason = `Exact amount match and contains invoice number: ${inv.invoiceNumber}`
      } else if (tenderMatch) {
        confidence = 'HIGH'
        reason = `Exact amount match and contains tender reference: ${inv.tenderReference}`
      } else if (partyMatch) {
        confidence = 'HIGH'
        reason = `Exact amount match and contains counterparty name: ${inv.partyName}`
      }

      suggestions.push({
        transactionId: tx.id,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        partyName: inv.partyName,
        invoiceType: inv.type,
        amount: targetAmount,
        confidence,
        reason,
      })
    }
  }

  return suggestions
}

export function executeReconciliation({
  booksDataPath,
  transactionId,
  invoiceId,
}: {
  booksDataPath: string
  transactionId: string
  invoiceId: string
}): {
  ok: boolean
  error?: string
  transactionId?: string
  invoiceId?: string
  invoiceNumber?: string
  settledAmount?: number
  invoiceStatus?: string
} {
  const booksData = readBooksStore(booksDataPath)

  const tx = (booksData.bankTransactions || []).find((t) => t.id === transactionId)
  if (!tx) return { ok: false, error: `Transaction not found: ${transactionId}` }
  if (tx.reconciled) return { ok: false, error: `Transaction already reconciled: ${transactionId}` }

  const inv = (booksData.invoices || []).find((i) => i.id === invoiceId)
  if (!inv) return { ok: false, error: `Invoice not found: ${invoiceId}` }
  if (inv.status === 'Paid') return { ok: false, error: `Invoice already marked Paid: ${invoiceId}` }

  // 1. Mark transaction reconciled
  tx.reconciled = true
  tx.matchedInvoiceId = inv.id
  tx.reconciledAt = new Date().toISOString()

  // 2. Mark invoice Paid and clear outstanding
  const settledAmount = inv.outstandingAmount
  inv.status = 'Paid'
  inv.outstandingAmount = 0
  inv.updatedAt = new Date().toISOString()

  // 3. Update party balance
  const party = booksData.parties.find((p) => p.id === inv.partyId || p.name === inv.partyName)
  if (party) {
    party.outstandingBalance = Math.max(0, Math.round((party.outstandingBalance - settledAmount) * 100) / 100)
  }

  // 4. Update ledger accounts (offset Receivable or Payable against Bank settlement)
  for (const acc of booksData.accounts) {
    if (inv.type === 'Sales' && acc.id === 'acc-ar') {
      acc.balance = Math.max(0, Math.round((acc.balance - settledAmount) * 100) / 100)
    }
    if (inv.type === 'Purchase' && acc.id === 'acc-ap') {
      acc.balance = Math.max(0, Math.round((acc.balance - settledAmount) * 100) / 100)
    }
  }

  // 5. Post settlement journal entry
  const year = new Date().getFullYear()
  const jeNumber = `JE-${year}-${booksData.journalEntries.length + 1}`
  const today = new Date().toISOString().split('T')[0]

  const journalItems =
    inv.type === 'Sales'
      ? [
          { id: 'jei-rec-1', accountId: 'acc-bank', accountName: 'FNB Business Cheque Account', debit: settledAmount, credit: 0 },
          { id: 'jei-rec-2', accountId: 'acc-ar', accountName: 'Accounts Receivable (Debtors)', debit: 0, credit: settledAmount, partyId: party?.id, partyName: party?.name },
        ]
      : [
          { id: 'jei-rec-1', accountId: 'acc-ap', accountName: 'Accounts Payable (Creditors)', debit: settledAmount, credit: 0, partyId: party?.id, partyName: party?.name },
          { id: 'jei-rec-2', accountId: 'acc-bank', accountName: 'FNB Business Cheque Account', debit: 0, credit: settledAmount },
        ]

  booksData.journalEntries.unshift({
    id: `je-${randomUUID().slice(0, 8)}`,
    entryNumber: jeNumber,
    date: today,
    totalDebit: settledAmount,
    totalCredit: settledAmount,
    remarks: `1-Click Bank Reconciliation: Transaction ${tx.description} for Invoice ${inv.invoiceNumber}`,
    posted: true,
    items: journalItems,
  })

  booksData.updatedAt = new Date().toISOString()
  writeBooksStore(booksDataPath, booksData)

  return {
    ok: true,
    transactionId,
    invoiceId,
    invoiceNumber: inv.invoiceNumber,
    settledAmount,
    invoiceStatus: inv.status,
  }
}


export function createBooksView(): WebContentsView {
  registerBooksIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (runtime.rendererUrl) {
    view.webContents.loadURL(runtime.rendererUrl)
  } else {
    view.webContents.loadFile(runtime.rendererFile)
  }

  return view
}

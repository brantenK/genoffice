import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, watch, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, ipcMain, WebContentsView, type WebContents } from 'electron'
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

export * from '../shared/accounting'
import {
  round2,
  createSettlementJournal,
  recomputePartyBalances,
  parseBankStatementCsv,
  deduplicateBankTransactions,
} from '../shared/accounting'

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
  // ASSETS
  { id: 'acc-asset', name: 'Application of Funds (Assets)', rootType: 'Asset', accountType: 'Current Asset', parentId: null, isGroup: true, balance: 1020750 },
  { id: 'acc-curr-asset', name: 'Current Assets', rootType: 'Asset', accountType: 'Current Asset', parentId: 'acc-asset', isGroup: true, balance: 695750 },
  { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: 485250 },
  { id: 'acc-cash', name: 'Petty Cash', rootType: 'Asset', accountType: 'Cash', parentId: 'acc-curr-asset', isGroup: false, balance: 15000 },
  { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', parentId: 'acc-curr-asset', isGroup: false, balance: 195500 },
  { id: 'acc-inventory', name: 'Inventory & Materials on Hand', rootType: 'Asset', accountType: 'Current Asset', parentId: 'acc-curr-asset', isGroup: false, balance: 0 },
  { id: 'acc-fixed-asset', name: 'Fixed Assets', rootType: 'Asset', accountType: 'Fixed Asset', parentId: 'acc-asset', isGroup: true, balance: 325000 },
  { id: 'acc-equip', name: 'Office & IT Equipment', rootType: 'Asset', accountType: 'Fixed Asset', parentId: 'acc-fixed-asset', isGroup: false, balance: 85000 },
  { id: 'acc-vehic', name: 'Site Utility Vehicles', rootType: 'Asset', accountType: 'Fixed Asset', parentId: 'acc-fixed-asset', isGroup: false, balance: 240000 },

  // LIABILITIES
  { id: 'acc-liab', name: 'Source of Funds (Liabilities)', rootType: 'Liability', accountType: 'Current Liability', parentId: null, isGroup: true, balance: 112600 },
  { id: 'acc-curr-liab', name: 'Current Liabilities', rootType: 'Liability', accountType: 'Current Liability', parentId: 'acc-liab', isGroup: true, balance: 112600 },
  { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', parentId: 'acc-curr-liab', isGroup: false, balance: 74200 },
  { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 38400 },
  { id: 'acc-vat-in', name: 'SARS VAT Input Recoverable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 0 },
  { id: 'acc-payroll-liab', name: 'Payroll & PAYE / UIF Liabilities', rootType: 'Liability', accountType: 'Current Liability', parentId: 'acc-curr-liab', isGroup: false, balance: 0 },

  // EQUITY
  { id: 'acc-equity', name: 'Equity & Reserves', rootType: 'Equity', accountType: 'Equity', parentId: null, isGroup: true, balance: 700000 },
  { id: 'acc-retained', name: 'Retained Earnings', rootType: 'Equity', accountType: 'Equity', parentId: 'acc-equity', isGroup: false, balance: 600000 },
  { id: 'acc-capital', name: 'Share Capital', rootType: 'Equity', accountType: 'Equity', parentId: 'acc-equity', isGroup: false, balance: 100000 },
  { id: 'acc-owner-equity', name: "Owner's Drawings & Equity", rootType: 'Equity', accountType: 'Equity', parentId: 'acc-equity', isGroup: false, balance: 0 },

  // INCOME
  { id: 'acc-income', name: 'Income', rootType: 'Income', accountType: 'Direct Income', parentId: null, isGroup: true, balance: 1055000 },
  { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 820000 },
  { id: 'acc-consult', name: 'Professional Advisory Fees', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 235000 },
  { id: 'acc-interest-income', name: 'Interest & Investment Income', rootType: 'Income', accountType: 'Indirect Income', parentId: 'acc-income', isGroup: false, balance: 0 },

  // EXPENSES
  { id: 'acc-expense', name: 'Expenses', rootType: 'Expense', accountType: 'Direct Expense', parentId: null, isGroup: true, balance: 818000 },
  { id: 'acc-materials', name: 'Direct Project Materials & Subcontractors', rootType: 'Expense', accountType: 'Direct Expense', parentId: 'acc-expense', isGroup: false, balance: 345000 },
  { id: 'acc-salaries', name: 'Salaries & Wages', rootType: 'Expense', accountType: 'Indirect Expense', parentId: 'acc-expense', isGroup: false, balance: 380000 },
  { id: 'acc-rent', name: 'Office Rent & Facilities', rootType: 'Expense', accountType: 'Indirect Expense', parentId: 'acc-expense', isGroup: false, balance: 65000 },
  { id: 'acc-utilities', name: 'Water & Electricity Utilities', rootType: 'Expense', accountType: 'Indirect Expense', parentId: 'acc-expense', isGroup: false, balance: 0 },
  { id: 'acc-travel', name: 'Site Travel & Logistics', rootType: 'Expense', accountType: 'Indirect Expense', parentId: 'acc-expense', isGroup: false, balance: 28000 },
  { id: 'acc-deprec', name: 'Depreciation & Amortization', rootType: 'Expense', accountType: 'Indirect Expense', parentId: 'acc-expense', isGroup: false, balance: 0 },
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
      accountsMap.set(acc.id, {
        ...acc,
        balance:
          typeof acc.balance === 'number' && Number.isFinite(acc.balance)
            ? acc.balance
            : 0,
      })
    }
  }

  for (const core of CORE_ACCOUNTS) {
    if (!accountsMap.has(core.id)) {
      accountsMap.set(core.id, { ...core })
    } else {
      const existing = accountsMap.get(core.id)!
      if (existing.parentId === undefined) existing.parentId = core.parentId
      if (existing.isGroup === undefined) existing.isGroup = core.isGroup
      if (!existing.rootType) existing.rootType = core.rootType
      if (!existing.accountType) existing.accountType = core.accountType
      if (!existing.name) existing.name = core.name
    }
  }
  const accounts = Array.from(accountsMap.values())

  const rawParties = Array.isArray(r.parties) ? (r.parties as Party[]) : []
  const parties: Party[] = rawParties
    .filter((p) => p && typeof p.id === 'string')
    .map((p) => ({
      ...p,
      outstandingBalance: round2(p.outstandingBalance),
    }))

  const rawInvoices = Array.isArray(r.invoices) ? (r.invoices as Invoice[]) : []
  const invoices: Invoice[] = rawInvoices
    .filter((inv) => inv && typeof inv.id === 'string')
    .map((inv) => ({
      ...inv,
      subtotal: round2(inv.subtotal),
      taxTotal: round2(inv.taxTotal),
      grandTotal: round2(inv.grandTotal),
      outstandingAmount: round2(inv.outstandingAmount),
    }))

  const rawJournals = Array.isArray(r.journalEntries) ? (r.journalEntries as JournalEntry[]) : []
  const journalEntries: JournalEntry[] = rawJournals
    .filter((je) => je && typeof je.id === 'string')
    .map((je) => ({
      ...je,
      totalDebit: round2(je.totalDebit),
      totalCredit: round2(je.totalCredit),
      items: Array.isArray(je.items)
        ? je.items.map((item) => ({
            ...item,
            debit: round2(item.debit),
            credit: round2(item.credit),
          }))
        : [],
    }))

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
        amount: round2((item as any).amount),
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
    const timestamp = Date.now()
    const timestampedBackupPath = `${filePath}.corrupt-${timestamp}`
    const legacyBackupPath = `${filePath}.corrupted.bak`
    try {
      writeFileSync(timestampedBackupPath, content, 'utf8')
      writeFileSync(legacyBackupPath, content, 'utf8')
      console.warn(
        `books-main: Corrupted books file detected. Backed up to ${timestampedBackupPath} and ${legacyBackupPath}`
      )
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
    lastBroadcastJson = JSON.stringify(validated)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    console.error('books-main: failed to atomically write books store', filePath, e)
    throw e
  }
}

const activeBooksWebContents = new Set<WebContents>()
let booksFileWatcher: FSWatcher | null = null
let lastBroadcastJson = ''
let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null
let watchedBooksFilePath = ''

export function registerBooksWebContents(wc: WebContents): void {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
  activeBooksWebContents.add(wc)
  if (typeof wc.once === 'function') {
    wc.once('destroyed', () => {
      activeBooksWebContents.delete(wc)
    })
  }
}

export function unregisterBooksWebContents(wc: WebContents): void {
  activeBooksWebContents.delete(wc)
}

export function getActiveBooksWebContents(): WebContents[] {
  return Array.from(activeBooksWebContents).filter(
    (wc) => typeof wc.isDestroyed !== 'function' || !wc.isDestroyed()
  )
}

export function clearActiveBooksWebContents(): void {
  activeBooksWebContents.clear()
}

export function getLastBroadcastJson(): string {
  return lastBroadcastJson
}

export function setLastBroadcastJson(json: string): void {
  lastBroadcastJson = json
}

export function broadcastBooksData(data: BooksData, excludeSender?: WebContents): void {
  const json = JSON.stringify(data)
  lastBroadcastJson = json
  for (const wc of activeBooksWebContents) {
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
      continue
    }
    // Layer 1 loop suppression: skip excludeSender
    if (excludeSender) {
      if (wc === excludeSender) continue
      if ((wc as any).id && (excludeSender as any).id && (wc as any).id === (excludeSender as any).id) continue
    }
    try {
      wc.send(BOOKS_CHANNELS.dataChanged, data)
    } catch (err) {
      console.warn('books-main: failed to broadcast dataChanged to WebContents:', err)
    }
  }
}

export function persistBooksData(baseDirOrPath: string, data: unknown, excludeSender?: WebContents): void {
  const validated = migrateAndValidateBooks(data)
  writeBooksStore(baseDirOrPath, validated)
  broadcastBooksData(validated, excludeSender)
}

export function startBooksStoreWatcher(targetPath?: string): void {
  const filePath = targetPath || getStoragePath()
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (booksFileWatcher) {
    if (watchedBooksFilePath === filePath) {
      return
    }
    stopBooksStoreWatcher()
  }

  watchedBooksFilePath = filePath
  try {
    booksFileWatcher = watch(dir, (_eventType, filename) => {
      const isBooksFile = !filename || filename.includes('books-data.json')
      const isNotTmp = !filename || !filename.endsWith('.tmp')
      if (isBooksFile && isNotTmp) {
        if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
        watchDebounceTimer = setTimeout(() => {
          try {
            if (existsSync(filePath)) {
              const currentData = readBooksStore(filePath)
              const currentJson = JSON.stringify(currentData)
              if (currentJson !== lastBroadcastJson) {
                lastBroadcastJson = currentJson
                broadcastBooksData(currentData)
              }
            }
          } catch (err) {
            console.warn('books-main: error in file watcher handler:', err)
          }
        }, 100)
      }
    })
  } catch (err) {
    console.warn('books-main: could not start books-data.json watcher:', err)
  }
}

export function stopBooksStoreWatcher(): void {
  watchedBooksFilePath = ''
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer)
    watchDebounceTimer = null
  }
  if (booksFileWatcher) {
    try {
      booksFileWatcher.close()
    } catch {}
    booksFileWatcher = null
  }
}

export function resetBooksIpcForTesting(): void {
  ipcRegistered = false
  clearActiveBooksWebContents()
  stopBooksStoreWatcher()
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

  // Start file watcher for external changes
  startBooksStoreWatcher()

  const handleGetData = (_e: any) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const p = getStoragePath()
      if (existsSync(p)) {
        return readBooksStore(p)
      }
      return null
    } catch {
      return null
    }
  }

  // Load persistence (support both loadData and getData alias)
  ipcMain.handle(BOOKS_CHANNELS.loadData, handleGetData)
  ipcMain.handle('books:get-data', handleGetData)

  // Save persistence
  ipcMain.handle(BOOKS_CHANNELS.saveData, (_e, data: BooksData) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const p = getStoragePath()
      persistBooksData(p, data, _e?.sender)
      return true
    } catch {
      return false
    }
  })

  // Cross-App: Export to Sheets
  ipcMain.handle(BOOKS_CHANNELS.exportToSheets, (_e, reportName: string, csvContent: string) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
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
    if (_e?.sender) registerBooksWebContents(_e.sender)
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
  ipcMain.handle(BOOKS_CHANNELS.openInCrm, (_e) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    if (runtime.onOpenCrm) {
      runtime.onOpenCrm()
      return true
    }
    return false
  })

  // Cross-App: Open Tenders
  ipcMain.handle(BOOKS_CHANNELS.openInTenders, (_e) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    if (runtime.onOpenTenders) {
      runtime.onOpenTenders()
      return true
    }
    return false
  })

  // Bank reconciliation: Import CSV
  ipcMain.handle(BOOKS_CHANNELS.importBankStatementCsv, (_e, csvContent: string) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const p = getStoragePath()
      const result = importBankStatement({ booksDataPath: p, csvContent })
      if (result.ok) {
        const freshData = readBooksStore(p)
        broadcastBooksData(freshData)
      }
      return result
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to import bank statement' }
    }
  })

  // Bank reconciliation: Reconcile transaction with invoice
  ipcMain.handle(BOOKS_CHANNELS.reconcileTransaction, (_e, transactionId: string, invoiceId: string) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const p = getStoragePath()
      const result = executeReconciliation({ booksDataPath: p, transactionId, invoiceId })
      if (result.ok) {
        const freshData = readBooksStore(p)
        broadcastBooksData(freshData)
      }
      return result
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to reconcile transaction' }
    }
  })

  // Bank reconciliation: Get settlement suggestions
  ipcMain.handle(BOOKS_CHANNELS.getSettlementSuggestions, (_e) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const p = getStoragePath()
      const data = readBooksStore(p)
      return computeSettlementSuggestions(data)
    } catch {
      return []
    }
  })
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

  const existing = booksData.bankTransactions || []
  const { toAdd, skippedDuplicates, netAdjustment } = deduplicateBankTransactions(parsed, existing)

  booksData.bankTransactions = [...existing, ...toAdd]

  // Adjust Bank Account ledger balance by net transaction amount
  const bankAccount = booksData.accounts.find((a) => a.id === 'acc-bank')
  if (bankAccount) {
    bankAccount.balance = round2(bankAccount.balance + netAdjustment)
  }

  booksData.updatedAt = new Date().toISOString()
  writeBooksStore(booksDataPath, booksData)

  return {
    ok: true,
    importedCount: toAdd.length,
    skippedDuplicates,
    netAdjustment,
    newBankBalance: bankAccount ? bankAccount.balance : null,
    transactions: toAdd,
  }
}

export function computeSettlementSuggestions(booksData: BooksData): SettlementSuggestion[] {
  const transactions = (booksData.bankTransactions || []).filter((t) => !t.reconciled)
  const openInvoices = (booksData.invoices || []).filter(
    (i) => i.status !== 'Paid' && (i.outstandingAmount ?? i.grandTotal) > 0
  )

  const suggestions: SettlementSuggestion[] = []

  for (const tx of transactions) {
    const isDeposit = tx.amount > 0
    const targetType = isDeposit ? 'Sales' : 'Purchase'
    const targetAmount = round2(Math.abs(tx.amount))

    const candidates = openInvoices.filter((i) => i.type === targetType)

    for (const inv of candidates) {
      const currentOutstanding = round2(
        inv.outstandingAmount !== undefined && inv.outstandingAmount > 0
          ? inv.outstandingAmount
          : inv.grandTotal
      )
      const amountMatches = Math.abs(currentOutstanding - targetAmount) < 0.01

      // Check text tokens for match
      const textToSearch = `${tx.description} ${tx.reference || ''}`.toLowerCase()
      const invNoMatch = Boolean(
        inv.invoiceNumber && textToSearch.includes(inv.invoiceNumber.toLowerCase())
      )
      const tenderMatch = Boolean(
        inv.tenderReference && textToSearch.includes(inv.tenderReference.toLowerCase())
      )

      // Split party name into significant keywords (length >= 4, ignoring common stop words)
      const stopWords = new Set(['city', 'of', 'the', 'and', 'dept', 'ltd', 'pty', 'inc', 'corp', 'co'])
      const partyTokens = (inv.partyName || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !stopWords.has(t))

      const partyMatch =
        Boolean(inv.partyName && textToSearch.includes(inv.partyName.toLowerCase())) ||
        (partyTokens.length > 0 && partyTokens.some((t) => textToSearch.includes(t)))

      if (amountMatches) {
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
      } else if (targetAmount <= currentOutstanding && (invNoMatch || tenderMatch)) {
        // Partial payment match on invoice number or tender reference
        suggestions.push({
          transactionId: tx.id,
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          partyName: inv.partyName,
          invoiceType: inv.type,
          amount: targetAmount,
          confidence: 'MEDIUM',
          reason: `Partial payment matching invoice ${inv.invoiceNumber}`,
        })
      }
    }
  }

  return suggestions
}

export function executeReconciliation({
  booksDataPath,
  transactionId,
  invoiceId,
  tendersDataPath,
}: {
  booksDataPath: string
  transactionId: string
  invoiceId: string
  tendersDataPath?: string
}): {
  ok: boolean
  error?: string
  transactionId?: string
  invoiceId?: string
  invoiceNumber?: string
  settledAmount?: number
  remainingOutstanding?: number
  invoiceStatus?: string
  partyBalance?: number
  tenderMilestonePaid?: boolean
  matchedMilestoneId?: string
  matchedTenderId?: string
} {
  const booksData = readBooksStore(booksDataPath)

  const tx = (booksData.bankTransactions || []).find((t) => t.id === transactionId)
  if (!tx) return { ok: false, error: `Transaction not found: ${transactionId}` }
  if (tx.reconciled) return { ok: false, error: `Transaction already reconciled: ${transactionId}` }

  const inv = (booksData.invoices || []).find((i) => i.id === invoiceId)
  if (!inv) return { ok: false, error: `Invoice not found: ${invoiceId}` }
  if (inv.status === 'Paid' || (inv.outstandingAmount !== undefined && inv.outstandingAmount <= 0)) {
    return { ok: false, error: `Invoice already marked Paid: ${invoiceId}` }
  }
  if (inv.status === 'Draft') {
    return { ok: false, error: `Cannot reconcile a draft invoice: ${invoiceId}` }
  }
  if (inv.status === 'Cancelled') {
    return { ok: false, error: `Cannot reconcile a cancelled invoice: ${invoiceId}` }
  }

  // Direction validation
  if (inv.type === 'Sales' && tx.amount <= 0) {
    return { ok: false, error: 'Cannot reconcile a debit/withdrawal transaction against a Sales invoice' }
  }
  if (inv.type === 'Purchase' && tx.amount >= 0) {
    return { ok: false, error: 'Cannot reconcile a credit/deposit transaction against a Purchase bill' }
  }

  // 1. Mark transaction reconciled
  tx.reconciled = true
  tx.matchedInvoiceId = inv.id
  tx.reconciledAt = new Date().toISOString()

  // 2. Exact and partial settlement math
  const txAmt = round2(Math.abs(tx.amount))
  const currentOutstanding = round2(
    inv.outstandingAmount !== undefined && inv.outstandingAmount > 0
      ? inv.outstandingAmount
      : inv.grandTotal
  )
  const settledAmount = round2(Math.min(txAmt, currentOutstanding))
  const remainingOutstanding = round2(currentOutstanding - settledAmount)

  inv.outstandingAmount = remainingOutstanding
  inv.status = remainingOutstanding <= 0 ? 'Paid' : 'Unpaid'
  inv.updatedAt = new Date().toISOString()

  // 3. Update ledger accounts (offset Receivable or Payable against Bank settlement)
  for (const acc of booksData.accounts) {
    if (inv.type === 'Sales' && acc.id === 'acc-ar') {
      acc.balance = Math.max(0, round2(acc.balance - settledAmount))
    }
    if (inv.type === 'Purchase' && acc.id === 'acc-ap') {
      acc.balance = Math.max(0, round2(acc.balance - settledAmount))
    }
  }

  // 4. Update party balance
  const party = booksData.parties.find((p) => p.id === inv.partyId || p.name === inv.partyName)
  booksData.parties = recomputePartyBalances(booksData.invoices, booksData.parties)
  const updatedParty = booksData.parties.find((p) => p.id === inv.partyId || p.name === inv.partyName)

  // 5. Post settlement journal entry
  const year = new Date().getFullYear()
  const jeNumber = `JE-${year}-${booksData.journalEntries.length + 1}`
  const settlementJournal = createSettlementJournal(
    inv,
    booksData.accounts,
    settledAmount,
    updatedParty || party,
    jeNumber,
    'acc-bank',
    `1-Click Bank Reconciliation: Transaction ${tx.description} for Invoice ${inv.invoiceNumber}`
  )
  booksData.journalEntries.unshift(settlementJournal)

  booksData.updatedAt = new Date().toISOString()
  writeBooksStore(booksDataPath, booksData)

  // 6. Propagate payment state back to Zano Tenders milestone
  let tenderMilestonePaid = false
  let matchedMilestoneId: string | undefined
  let matchedTenderId: string | undefined

  // CRITICAL: Only propagate PAID to tender milestone if invoice is FULLY settled!
  const isFullySettled = remainingOutstanding <= 0 || inv.status === 'Paid'

  if (isFullySettled) {
    try {
      let candidatePath = tendersDataPath
      if (!candidatePath && booksDataPath) {
        const fromBooks = resolve(booksDataPath, '..', '..', 'tenders', 'tenders-data.json')
        if (existsSync(fromBooks)) candidatePath = fromBooks
      }
      if (!candidatePath && app?.getPath) {
        try {
          const fromApp = join(app.getPath('userData'), 'tenders', 'tenders-data.json')
          if (existsSync(fromApp)) candidatePath = fromApp
        } catch {}
      }
      if (!candidatePath) {
        if (booksDataPath) {
          candidatePath = resolve(booksDataPath, '..', '..', 'tenders', 'tenders-data.json')
        } else if (app?.getPath) {
          try {
            candidatePath = join(app.getPath('userData'), 'tenders', 'tenders-data.json')
          } catch {}
        }
      }

      if (candidatePath && existsSync(candidatePath)) {
        let tendersData: any = null
        let writeFn: any = null
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const tendersModule = require('../../../tenders/src/main/tenders-main')
          if (typeof tendersModule.readTendersStore === 'function' && typeof tendersModule.writeTendersStore === 'function') {
            tendersData = tendersModule.readTendersStore(candidatePath)
            writeFn = tendersModule.writeTendersStore
          }
        } catch {
          // Fallback to direct file read if require fails
          try {
            const raw = readFileSync(candidatePath, 'utf8')
            tendersData = JSON.parse(raw)
            writeFn = (p: string, d: any) => {
              writeFileSync(p, JSON.stringify(d, null, 2), 'utf8')
            }
          } catch {}
        }

        if (tendersData && typeof writeFn === 'function') {
          let modified = false
          const nowIso = new Date().toISOString()

          for (const ws of tendersData.workspaces || []) {
            for (const t of ws.tenders || []) {
              for (const m of t.milestones || []) {
                const matchByInvoiceId = Boolean(m.billedInvoiceId && m.billedInvoiceId === inv.id)
                const matchByInvoiceNum = Boolean(
                  m.billedInvoiceNumber && inv.invoiceNumber && m.billedInvoiceNumber === inv.invoiceNumber
                )
                const matchByRefAndAmount = Boolean(
                  (inv.tenderReference || (inv as any).tenderRef) &&
                  t.referenceNumber === (inv.tenderReference || (inv as any).tenderRef) &&
                  (m.status === 'BILLED' || m.status === 'REACHED') &&
                  Math.round(m.amount * 100) === Math.round(settledAmount * 100)
                )

                if (matchByInvoiceId || matchByInvoiceNum || matchByRefAndAmount) {
                  m.status = 'PAID'
                  m.paidAt = nowIso
                  m.paidDate = nowIso
                  if (!m.billedInvoiceId) m.billedInvoiceId = inv.id
                  if (!m.billedInvoiceNumber && inv.invoiceNumber) m.billedInvoiceNumber = inv.invoiceNumber
                  modified = true
                  tenderMilestonePaid = true
                  matchedMilestoneId = m.id
                  matchedTenderId = t.id
                  break
                }
              }
              if (tenderMilestonePaid) break
            }
            if (tenderMilestonePaid) break
          }

          if (modified) {
            tendersData.updatedAt = nowIso
            writeFn(candidatePath, tendersData)
          }
        }
      }
    } catch (err) {
      console.warn('[books-main] Failed to propagate payment to tenders:', err)
    }
  }

  return {
    ok: true,
    transactionId: tx.id,
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    settledAmount,
    remainingOutstanding,
    invoiceStatus: inv.status,
    partyBalance: updatedParty ? updatedParty.outstandingBalance : party?.outstandingBalance,
    tenderMilestonePaid,
    matchedMilestoneId,
    matchedTenderId,
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

  registerBooksWebContents(view.webContents)

  if (runtime.rendererUrl) {
    view.webContents.loadURL(runtime.rendererUrl)
  } else {
    view.webContents.loadFile(runtime.rendererFile)
  }

  return view
}

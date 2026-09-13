/**
 * apps/books/src/main/books-core.ts
 *
 * Pure books-core: the ledger-first migration/normalization engine and the
 * single posting path for sales invoices created outside the Books renderer
 * (CRM won-deals, Tenders milestones). Zero electron imports — only node
 * builtins (fs/path/crypto) and the shared accounting/chart modules, so plain
 * Node tooling (e.g. `npx tsx tools/verify-suite-workflows.mjs`) can import
 * and exercise the REAL posting logic instead of a duplicated copy.
 *
 * books-main.ts imports everything from here and re-exports it, so all
 * existing consumers (crm-main, tenders-main, tests) keep working unchanged.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  round2,
  createSalesInvoiceJournal,
  createOpeningJournal,
  createBankImportJournal,
  createReconciliationJournal,
  createSettlementJournal,
  computeAccountBalances,
  accountsMatchJournals,
  nextInvoiceNumber,
  nextJournalNumber,
  recomputePartyBalances,
  parseBankStatementCsv,
  deduplicateBankTransactions,
} from '../shared/accounting'
import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../shared/chart'
import { appendAudit, createAuditEntry } from '../shared/audit'
import { isDateLocked } from '../shared/closing'
import { planImportCoverage } from '../shared/payments'
import { MAX_AUDIT_ENTRIES } from '../shared/audit'
import type {
  Account,
  AuditEntry,
  BankTransaction,
  BooksData,
  BooksDataEnvelope,
  CompanySettings,
  Invoice,
  JournalEntry,
  Party,
  Payment,
  PaymentAllocation,
  SettlementSuggestion,
} from '../shared/types'

export const CURRENT_BOOKS_SCHEMA_VERSION = 1

/** Entry-number prefix marking a synthesized/opening-balances journal entry. */
export const OPENING_JOURNAL_PREFIX = 'JE-OPENING'

/**
 * Ledger-first normalization: synthesizes an opening-balances journal entry
 * when a legacy store has non-zero stored balances but no opening entry,
 * then recomputes every account balance strictly from journal entries.
 * Also recomputes party balances from open invoices.
 */
/**
 * Recomputes account balances strictly from journal entries and party
 * balances from open invoices. No migration/synthesis — call this on live
 * data that has just been mutated.
 */
export function recomputeLedger(data: BooksDataEnvelope): BooksDataEnvelope {
  const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((a) => ({ ...a }))
  const journalEntries = Array.isArray(data.journalEntries) ? [...data.journalEntries] : []

  const normalizedAccounts = computeAccountBalances(accounts, journalEntries)
  const invoices = Array.isArray(data.invoices) ? data.invoices : []
  const normalizedParties = recomputePartyBalances(
    invoices,
    Array.isArray(data.parties) ? data.parties : [],
  )

  return {
    ...data,
    version: data.version ?? CURRENT_BOOKS_SCHEMA_VERSION,
    updatedAt: data.updatedAt || new Date().toISOString(),
    accounts: normalizedAccounts,
    parties: normalizedParties,
    journalEntries,
  }
}

/**
 * Ledger-first normalization for raw/on-disk payloads: synthesizes a balanced
 * opening-balances journal entry when the stored balances cannot be derived
 * from the existing journals (true legacy data), then recomputes every
 * balance from journals. Idempotent — once balances are journal-derived the
 * synthesis never fires again.
 */
export function normalizeLedger(data: BooksDataEnvelope): BooksDataEnvelope {
  const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((a) => ({ ...a }))
  const journalEntries = Array.isArray(data.journalEntries) ? [...data.journalEntries] : []

  const hasOpening = journalEntries.some((je) =>
    String(je.entryNumber || '').startsWith(OPENING_JOURNAL_PREFIX),
  )
  const balancesMatchJournals = accountsMatchJournals(accounts, journalEntries)
  if (!hasOpening && !balancesMatchJournals) {
    const hasBalances = accounts.some((a) => !a.isGroup && round2(a.balance || 0) !== 0)
    if (hasBalances) {
      const opening = createOpeningJournal(accounts, {
        date: data.settings?.financialYearStart || undefined,
      })
      journalEntries.unshift(opening)
    }
  }

  return recomputeLedger({ ...data, journalEntries })
}

export function migrateAndValidateBooks(raw: unknown): BooksDataEnvelope {
  const now = new Date().toISOString()
  if (!raw || typeof raw !== 'object') {
    return {
      version: CURRENT_BOOKS_SCHEMA_VERSION,
      updatedAt: now,
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
      payments: [],
      auditLog: [],
    }
  }

  const r = raw as Record<string, unknown>
  const version =
    typeof r.version === 'number' && r.version >= 1 ? r.version : CURRENT_BOOKS_SCHEMA_VERSION
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt.trim() ? r.updatedAt : now

  const settings: CompanySettings =
    r.settings && typeof r.settings === 'object'
      ? { ...DEFAULT_BOOK_SETTINGS, ...(r.settings as Partial<CompanySettings>) }
      : { ...DEFAULT_BOOK_SETTINGS }

  const existingAccounts: Account[] = Array.isArray(r.accounts) ? (r.accounts as Account[]) : []
  const accountsMap = new Map<string, Account>()
  for (const acc of existingAccounts) {
    if (acc && typeof acc.id === 'string') {
      accountsMap.set(acc.id, {
        ...acc,
        balance: typeof acc.balance === 'number' && Number.isFinite(acc.balance) ? acc.balance : 0,
      })
    }
  }

  for (const core of EMPTY_ACCOUNTS) {
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

  // VAT Input is an asset-side receivable from SARS, never a liability.
  const vatIn = accountsMap.get('acc-vat-in')
  if (vatIn) {
    vatIn.rootType = 'Asset'
    vatIn.accountType = 'Tax'
    vatIn.parentId = 'acc-curr-asset'
    vatIn.isGroup = false
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
        matchedInvoiceId:
          typeof (item as any).matchedInvoiceId === 'string'
            ? (item as any).matchedInvoiceId
            : undefined,
        reconciledAt:
          typeof (item as any).reconciledAt === 'string' ? (item as any).reconciledAt : undefined,
        paymentLinks: Array.isArray((item as any).paymentLinks)
          ? (item as any).paymentLinks
              .filter(
                (link: any) =>
                  link &&
                  typeof link.paymentId === 'string' &&
                  typeof link.amount === 'number' &&
                  Number.isFinite(link.amount) &&
                  link.amount > 0,
              )
              .map((link: any) => ({
                paymentId: link.paymentId,
                amount: round2(link.amount),
                invoiceId: typeof link.invoiceId === 'string' ? link.invoiceId : undefined,
              }))
          : undefined,
      })
    }
  }

  const rawPayments = Array.isArray(r.payments) ? r.payments : []
  const payments: Payment[] = []
  for (const item of rawPayments) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    if (
      typeof p.id !== 'string' ||
      typeof p.partyId !== 'string' ||
      typeof p.date !== 'string' ||
      (p.type !== 'received' && p.type !== 'paid' && p.type !== 'refund') ||
      !Array.isArray(p.allocations)
    ) {
      continue
    }
    // Sanitize allocations: keep only entries with a valid invoiceId and a
    // finite amount (rounded), then derive total strictly from allocations so
    // payment.total always equals the sum of its allocations.
    const allocations: PaymentAllocation[] = []
    for (const rawAlloc of p.allocations) {
      if (!rawAlloc || typeof rawAlloc !== 'object') continue
      const a = rawAlloc as Record<string, unknown>
      if (typeof a.invoiceId !== 'string') continue
      allocations.push({
        invoiceId: a.invoiceId,
        invoiceNumber: typeof a.invoiceNumber === 'string' ? a.invoiceNumber : a.invoiceId,
        amount: round2(Number(a.amount) || 0),
      })
    }
    if (allocations.length === 0) continue
    payments.push({
      id: p.id,
      partyId: p.partyId,
      partyName: typeof p.partyName === 'string' ? p.partyName : '',
      date: p.date,
      type: p.type as Payment['type'],
      method: typeof p.method === 'string' ? p.method : undefined,
      reference: typeof p.reference === 'string' ? p.reference : undefined,
      allocations,
      total: round2(allocations.reduce((s, a) => s + a.amount, 0)),
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : now,
    })
  }

  const rawAudit = Array.isArray(r.auditLog) ? r.auditLog : []
  const auditLog: AuditEntry[] = []
  for (const item of rawAudit) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (
      typeof e.id !== 'string' ||
      typeof e.timestamp !== 'string' ||
      Number.isNaN(Date.parse(e.timestamp)) ||
      new Date(e.timestamp).toISOString() !== e.timestamp ||
      typeof e.action !== 'string' ||
      typeof e.summary !== 'string'
    ) {
      continue
    }
    auditLog.push({
      id: e.id,
      timestamp: e.timestamp,
      action: e.action,
      summary: e.summary,
      actor: typeof e.actor === 'string' ? e.actor : undefined,
      invoiceNumber: typeof e.invoiceNumber === 'string' ? e.invoiceNumber : undefined,
      paymentId: typeof e.paymentId === 'string' ? e.paymentId : undefined,
      amount:
        typeof e.amount === 'number' && Number.isFinite(e.amount) ? round2(e.amount) : undefined,
    })
  }
  // Normalize untrusted input order before capping: newest-first, then keep
  // only the recent history so a reordered backup cannot evict new entries.
  const cappedAuditLog = auditLog
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_AUDIT_ENTRIES)

  const envelope: BooksDataEnvelope = {
    version,
    updatedAt,
    settings,
    accounts,
    parties,
    invoices,
    journalEntries,
    bankTransactions,
    payments,
    auditLog: cappedAuditLog,
  }

  // Ledger-first: balances are always derived from journals, never stored.
  return normalizeLedger(envelope)
}

/** A fresh, empty ledger — first-run state before the setup wizard runs. */
export function createEmptyBooksEnvelope(): BooksDataEnvelope {
  return {
    version: CURRENT_BOOKS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_BOOK_SETTINGS },
    accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
    parties: [],
    invoices: [],
    journalEntries: [],
    bankTransactions: [],
    payments: [],
    auditLog: [],
  }
}

export function readBooksStore(baseDirOrPath: string): BooksDataEnvelope {
  const filePath = baseDirOrPath.endsWith('books-data.json')
    ? baseDirOrPath
    : join(baseDirOrPath, 'books-data.json')
  if (!existsSync(filePath)) {
    return createEmptyBooksEnvelope()
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (err) {
    console.error('books-main: failed to read books-data.json:', err)
    return createEmptyBooksEnvelope()
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
        `books-main: Corrupted books file detected. Backed up to ${timestampedBackupPath} and ${legacyBackupPath}`,
      )
    } catch (bakErr) {
      console.error('books-main: Failed to write corrupted backup file', bakErr)
    }
    return createEmptyBooksEnvelope()
  }
}

/**
 * Optional observer notified with the validated JSON after every successful
 * atomic store write. books-main registers it to keep its lastBroadcastJson
 * cache in sync (internal writes must suppress redundant watcher broadcasts);
 * pure/headless consumers simply leave it unset.
 */
let storeWriteObserver: ((json: string) => void) | undefined

export function setStoreWriteObserver(fn: ((json: string) => void) | undefined): void {
  storeWriteObserver = fn
}

export function writeBooksStore(baseDirOrPath: string, data: unknown): void {
  const filePath = baseDirOrPath.endsWith('books-data.json')
    ? baseDirOrPath
    : join(baseDirOrPath, 'books-data.json')
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const validated = migrateAndValidateBooks(data)
  const tmp = `${filePath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf8')
    renameSync(tmp, filePath)
    storeWriteObserver?.(JSON.stringify(validated))
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    console.error('books-main: failed to atomically write books store', filePath, e)
    throw e
  }
}

export interface IssueSalesInvoiceInput {
  booksDataPath: string
  partyName: string
  itemDescription: string
  /** VAT-inclusive target amount (grandTotal ≈ amount). */
  amount: number
  itemCode?: string
  accountId?: string
  accountName?: string
  tenderReference?: string
  crmDealId?: string
  notes?: string
  date?: string
  dueDate?: string
  taxRate?: number
}

export interface IssueSalesInvoiceResult {
  ok: boolean
  invoice?: Invoice
  error?: string
}

/**
 * THE single posting path for sales invoices created outside the Books
 * renderer (CRM won-deals, Tenders milestones). Owns the whole lifecycle:
 * party resolution, VAT-inclusive pricing, central invoice numbering,
 * journal posting, ledger recompute and persistence+broadcast. Callers must
 * never post journals or mutate account balances themselves.
 */
export function issueSalesInvoiceInBooks(input: IssueSalesInvoiceInput): IssueSalesInvoiceResult {
  try {
    if (!input || !input.booksDataPath) return { ok: false, error: 'booksDataPath is required' }

    const crmDealId = typeof input.crmDealId === 'string' ? input.crmDealId.trim() : ''
    const amount = round2(Number(input.amount) || 0)
    if (amount <= 0) return { ok: false, error: 'Invoice amount must be greater than 0' }
    const partyName = String(input.partyName || '').trim()
    if (!partyName) return { ok: false, error: 'Party name is required' }

    const booksData = readBooksStore(input.booksDataPath)
    if (crmDealId) {
      const existingInvoice = booksData.invoices.find((invoice) => invoice.crmDealId === crmDealId)
      if (existingInvoice) return { ok: true, invoice: existingInvoice }
    }

    let party = booksData.parties.find((p) => p.name.toLowerCase() === partyName.toLowerCase())
    if (!party) {
      party = {
        id: `party-${randomUUID().slice(0, 8)}`,
        name: partyName,
        type: 'Customer',
        email: `accounts@${partyName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'client'}.com`,
        outstandingBalance: 0,
      }
      booksData.parties.push(party)
    }

    const today = input.date || new Date().toISOString().split('T')[0]
    if (isDateLocked(booksData, today)) {
      return {
        ok: false,
        error: `Cannot issue an invoice dated in a closed period: ${today} (closed through ${booksData.settings.closedThrough})`,
      }
    }
    const dueDate =
      input.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
    // M2: an explicit 0 (zero-rated) must stay 0 — only a missing/NaN rate
    // falls back to the 15% default.
    const taxRate =
      input.taxRate !== undefined && input.taxRate !== null && input.taxRate !== 0
        ? round2(Number(input.taxRate) || 15)
        : input.taxRate === 0
          ? 0
          : 15
    // VAT-inclusive pricing: derive subtotal from the inclusive amount, then
    // recompute tax from the subtotal so invoice totals always equal the
    // journal posting exactly (never `grandTotal / 1.15` inversion drift).
    const subtotal = round2(amount / (1 + taxRate / 100))
    const taxTotal = round2(subtotal * (taxRate / 100))
    const grandTotal = round2(subtotal + taxTotal)

    const salesAcc = booksData.accounts.find((a) => a.id === (input.accountId || 'acc-sales')) || {
      id: input.accountId || 'acc-sales',
      name: input.accountName || 'Tender & Commercial Contracting Sales',
    }

    const invoiceNumber = nextInvoiceNumber(booksData.invoices, 'Sales', today)
    const invoice: Invoice = {
      id: `inv-${randomUUID().slice(0, 8)}`,
      invoiceNumber,
      type: 'Sales',
      partyId: party.id,
      partyName: party.name,
      date: today,
      dueDate,
      items: [
        {
          id: `item-${randomUUID().slice(0, 8)}`,
          itemCode: input.itemCode || 'COMMERCIAL-DELIVERY',
          description: input.itemDescription || 'Commercial Delivery & Services',
          accountId: salesAcc.id,
          accountName: salesAcc.name,
          qty: 1,
          rate: subtotal,
          taxRate,
          amount: subtotal,
        },
      ],
      subtotal,
      taxTotal,
      grandTotal,
      outstandingAmount: grandTotal,
      status: 'Unpaid',
      notes: input.notes || 'Payment terms: Net 30 days upon invoice receipt.',
      tenderReference: input.tenderReference,
      crmDealId: crmDealId || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    booksData.invoices.unshift(invoice)
    booksData.journalEntries.unshift(createSalesInvoiceJournal(invoice, booksData.accounts, party))
    booksData.updatedAt = new Date().toISOString()

    const normalized = recomputeLedger(
      appendAudit(
        booksData,
        createAuditEntry('invoice.issue', `Issued ${invoice.invoiceNumber} to ${party.name}`, {
          invoiceNumber: invoice.invoiceNumber,
          amount: invoice.grandTotal,
        }),
      ),
    )
    writeBooksStore(input.booksDataPath, normalized)

    return { ok: true, invoice }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to create sales invoice in Books' }
  }
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

  // Phase-3 payment ↔ bank-reconciliation unification: a statement line
  // already covered by a recorded payment is the SAME cash the payment
  // journal booked (Dr/Cr Bank vs AR/AP). Fully covered lines are stored
  // pre-reconciled against the matched allocation invoice and post NO import
  // journal — posting the bank movement again would double-count Bank and
  // strand Suspense. PARTIALLY covered lines post an import journal for the
  // uncovered remainder only, so Bank always matches the statement exactly.
  const coverage = planImportCoverage(booksData, toAdd)
  const storedToAdd: BankTransaction[] = toAdd.map((tx) => {
    const plan = coverage.get(tx.id)
    if (!plan || !plan.fullyCovered) return tx
    return {
      ...tx,
      reconciled: true,
      matchedInvoiceId: plan.matchedInvoiceId,
      reconciledAt: new Date().toISOString(),
    }
  })
  booksData.bankTransactions = [...existing, ...storedToAdd]

  // Ledger-first: each imported transaction is posted as a journal entry
  // (Dr/Cr Bank against Bank Suspense) for the UNCOVERED portion — a fully
  // covered line posts nothing, a partially covered line posts the remainder,
  // everything else posts in full. Balances are then derived from journals;
  // entry numbers come from the journal sequence so imports never reuse one.
  const journals = Array.isArray(booksData.journalEntries) ? [...booksData.journalEntries] : []
  for (const tx of toAdd) {
    const plan = coverage.get(tx.id)
    const uncovered = round2(Math.abs(tx.amount || 0) - (plan?.coveredAmount || 0))
    if (uncovered <= 0.005) continue
    const remainderTx: BankTransaction = {
      ...tx,
      amount: tx.amount > 0 ? uncovered : -uncovered,
    }
    journals.unshift(
      createBankImportJournal(
        remainderTx,
        booksData.accounts,
        nextJournalNumber(journals, tx.date),
      ),
    )
  }
  booksData.journalEntries = journals

  booksData.updatedAt = new Date().toISOString()
  const normalized = recomputeLedger(
    appendAudit(
      booksData,
      createAuditEntry(
        'bank.import',
        `Imported bank statement: ${toAdd.length} new transaction${toAdd.length === 1 ? '' : 's'} (${skippedDuplicates} duplicates skipped)`,
      ),
    ),
  )
  writeBooksStore(booksDataPath, normalized)

  const bankAccount = normalized.accounts.find((a) => a.id === 'acc-bank')
  return {
    ok: true,
    importedCount: toAdd.length,
    skippedDuplicates,
    netAdjustment,
    newBankBalance: bankAccount ? bankAccount.balance : null,
    transactions: storedToAdd,
  }
}

export function computeSettlementSuggestions(booksData: BooksData): SettlementSuggestion[] {
  const transactions = (booksData.bankTransactions || []).filter((t) => !t.reconciled)
  const openInvoices = (booksData.invoices || []).filter(
    (i) => i.status !== 'Paid' && (i.outstandingAmount ?? i.grandTotal) > 0,
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
          : inv.grandTotal,
      )
      const amountMatches = Math.abs(currentOutstanding - targetAmount) < 0.01

      // Check text tokens for match
      const textToSearch = `${tx.description} ${tx.reference || ''}`.toLowerCase()
      const invNoMatch = Boolean(
        inv.invoiceNumber && textToSearch.includes(inv.invoiceNumber.toLowerCase()),
      )
      const tenderMatch = Boolean(
        inv.tenderReference && textToSearch.includes(inv.tenderReference.toLowerCase()),
      )

      // Split party name into significant keywords (length >= 4, ignoring common stop words)
      const stopWords = new Set([
        'city',
        'of',
        'the',
        'and',
        'dept',
        'ltd',
        'pty',
        'inc',
        'corp',
        'co',
      ])
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

export interface ReconciliationCoreResult {
  ok: boolean
  error?: string
  transactionId?: string
  invoiceId?: string
  invoiceNumber?: string
  settledAmount?: number
  remainingOutstanding?: number
  invoiceStatus?: string
  partyBalance?: number
}

/**
 * The pure settlement core of bank-statement reconciliation (no electron).
 * Marks the transaction reconciled, settles the invoice (exact or partial),
 * posts the reclass-or-direct settlement journal, recomputes balances and
 * party balances, and persists. Cross-app tender back-propagation lives in
 * books-main's executeReconciliation wrapper.
 */
export function executeReconciliationCore({
  booksDataPath,
  transactionId,
  invoiceId,
}: {
  booksDataPath: string
  transactionId: string
  invoiceId: string
}): ReconciliationCoreResult {
  const booksData = readBooksStore(booksDataPath)

  const tx = (booksData.bankTransactions || []).find((t) => t.id === transactionId)
  if (!tx) return { ok: false, error: `Transaction not found: ${transactionId}` }
  if (tx.reconciled) return { ok: false, error: `Transaction already reconciled: ${transactionId}` }

  const inv = (booksData.invoices || []).find((i) => i.id === invoiceId)
  if (!inv) return { ok: false, error: `Invoice not found: ${invoiceId}` }
  if (
    inv.status === 'Paid' ||
    (inv.outstandingAmount !== undefined && inv.outstandingAmount <= 0)
  ) {
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
    return {
      ok: false,
      error: 'Cannot reconcile a debit/withdrawal transaction against a Sales invoice',
    }
  }
  if (inv.type === 'Purchase' && tx.amount >= 0) {
    return {
      ok: false,
      error: 'Cannot reconcile a credit/deposit transaction against a Purchase bill',
    }
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
      : inv.grandTotal,
  )
  const settledAmount = round2(Math.min(txAmt, currentOutstanding))
  const remainingOutstanding = round2(currentOutstanding - settledAmount)

  inv.outstandingAmount = remainingOutstanding
  inv.status = remainingOutstanding <= 0 ? 'Paid' : 'Unpaid'
  inv.updatedAt = new Date().toISOString()

  // 3. Recompute party balance from open invoices
  const party = booksData.parties.find((p) => p.id === inv.partyId || p.name === inv.partyName)
  booksData.parties = recomputePartyBalances(booksData.invoices, booksData.parties)
  const updatedParty = booksData.parties.find(
    (p) => p.id === inv.partyId || p.name === inv.partyName,
  )

  // 4. Post the settlement journal entry. When the transaction was imported
  // from a bank statement, the import journal already moved the bank account,
  // so this leg only clears the suspense account against Receivable/Payable
  // (ledger-first: no direct balance mutation anywhere). Legacy transactions
  // without an import journal post the full direct settlement instead.
  let settlementJournal: JournalEntry
  const hasImportJournal = (booksData.journalEntries || []).some(
    (je) => je.remarks && je.remarks.includes(`Bank statement import: ${tx.id}`),
  )
  if (hasImportJournal) {
    settlementJournal = createReconciliationJournal(
      tx,
      inv,
      booksData.accounts,
      settledAmount,
      nextJournalNumber(booksData.journalEntries, tx.date),
    )
  } else {
    settlementJournal = createSettlementJournal(
      inv,
      booksData.accounts,
      settledAmount,
      updatedParty || party,
      nextJournalNumber(booksData.journalEntries, tx.date),
      'acc-bank',
      `1-Click Bank Reconciliation: Transaction ${tx.description} for Invoice ${inv.invoiceNumber}`,
    )
  }
  booksData.journalEntries.unshift(settlementJournal)

  booksData.updatedAt = new Date().toISOString()
  const normalized = recomputeLedger(
    appendAudit(
      booksData,
      createAuditEntry(
        'bank.reconcile',
        `Reconciled ${tx.description || tx.id} against ${inv.invoiceNumber}`,
        { invoiceNumber: inv.invoiceNumber, amount: settledAmount },
      ),
    ),
  )
  writeBooksStore(booksDataPath, normalized)

  return {
    ok: true,
    transactionId: tx.id,
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    settledAmount,
    remainingOutstanding,
    invoiceStatus: inv.status,
    partyBalance: updatedParty ? updatedParty.outstandingBalance : party?.outstandingBalance,
  }
}

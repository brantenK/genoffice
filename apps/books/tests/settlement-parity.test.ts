import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  executeReconciliationCore,
  importBankStatement,
  readBooksStore,
  writeBooksStore,
} from '../src/main/books-core'
import {
  allJournalsBalanced,
  createBankImportJournal,
  createSalesInvoiceJournal,
  round2,
} from '../src/shared/accounting'
import { computeSettlementSuggestions } from '../src/shared/settlement'
import { agingBuckets } from '../src/shared/reports'
import { applyLoadedEnvelope, useBooksStore } from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import type { BankTransaction, BooksData, Invoice, Party, Payment } from '../src/shared/types'

/**
 * Settlement parity: the main-process transport (books-core — the engine the
 * IPC handlers call) and the renderer transport (the store actions, which
 * fall back to the shared engine when no booksApi bridge exists) must return
 * identical results and leave identical ledgers for bank-statement import,
 * settlement suggestions and 1-click reconciliation.
 */
const engineCalls = vi.hoisted(() => ({ imports: 0, reconciliations: 0, suggestions: 0 }))

vi.mock('../src/shared/settlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/settlement')>()
  return {
    ...actual,
    applyBankStatementImport: ((...args: Parameters<typeof actual.applyBankStatementImport>) => {
      engineCalls.imports++
      return actual.applyBankStatementImport(...args)
    }) as typeof actual.applyBankStatementImport,
    applyReconciliation: ((...args: Parameters<typeof actual.applyReconciliation>) => {
      engineCalls.reconciliations++
      return actual.applyReconciliation(...args)
    }) as typeof actual.applyReconciliation,
    computeSettlementSuggestions: ((
      ...args: Parameters<typeof actual.computeSettlementSuggestions>
    ) => {
      engineCalls.suggestions++
      return actual.computeSettlementSuggestions(...args)
    }) as typeof actual.computeSettlementSuggestions,
  }
})

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const PARTY: Party = {
  id: 'party-parity',
  name: 'Parity Client (Pty) Ltd',
  type: 'Customer',
  outstandingBalance: 0,
}

function salesInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-parity-1',
    invoiceNumber: 'INV-2026-901',
    type: 'Sales',
    partyId: PARTY.id,
    partyName: PARTY.name,
    date: '2026-09-01',
    dueDate: '2026-10-01',
    items: [],
    subtotal: 100000,
    taxTotal: 15000,
    grandTotal: 115000,
    outstandingAmount: 115000,
    status: 'Unpaid',
    ...overrides,
  }
}

function purchaseBill(overrides: Partial<Invoice> = {}): Invoice {
  return {
    ...salesInvoice(overrides),
    id: 'bill-parity-1',
    invoiceNumber: 'BILL-2026-901',
    type: 'Purchase',
  }
}

function bankTx(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: 'tx-parity-1',
    accountId: 'acc-bank',
    date: '2026-09-08',
    description: 'EFT Deposit Parity Client',
    reference: '',
    amount: 115000,
    reconciled: false,
    ...overrides,
  }
}

/** The demo seed with only the settlement fixtures the test supplies. */
function baseLedger(overrides: Partial<BooksData> = {}): BooksData {
  return {
    ...clone(initialBooksData),
    parties: [clone(PARTY)],
    invoices: [],
    bankTransactions: [],
    payments: [],
    ...overrides,
  }
}

const csvOf = (...rows: string[]): string =>
  ['Date,Description,Reference,Amount', ...rows].join('\n')

let testDir: string
let booksDataPath: string

beforeEach(() => {
  testDir = join(tmpdir(), `books-settlement-parity-${randomUUID().slice(0, 8)}`)
  mkdirSync(testDir, { recursive: true })
  booksDataPath = join(testDir, 'books-data.json')
  engineCalls.imports = 0
  engineCalls.reconciliations = 0
  engineCalls.suggestions = 0
  ;(window as unknown as { booksApi: unknown }).booksApi = undefined
  useBooksStore.setState({ data: clone(initialBooksData) })
})

afterEach(() => {
  vi.unstubAllGlobals()
  try {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  } catch {}
})

/** Writes `base` to disk and hands the store the very same ledger, so both
 *  transports start from an identical input. The store only writes a ledger it
 *  has loaded successfully, so its state is adopted the way the load path
 *  adopts it (see the store's `loadStatus` write gate). */
function seedBoth(base: BooksData): BooksData {
  writeBooksStore(booksDataPath, base)
  const stored = readBooksStore(booksDataPath)
  applyLoadedEnvelope(clone(stored))
  return stored
}

/**
 * Statement lines get random ids from the parser; making them deterministic
 * per transport run lets the two transports be compared strictly.
 */
let uuidSeq = 0
function resetTxIds(): void {
  uuidSeq = 0
  vi.stubGlobal('crypto', {
    randomUUID: () => `${String(++uuidSeq).padStart(8, '0')}-0000-4000-8000-000000000000`,
  })
}

/** The economically meaningful ledger state, without the volatile ids and
 *  timestamps a clock or Math.random supplies. */
function ledgerView(data: BooksData) {
  return {
    accounts: (data.accounts || []).map((a) => [a.id, a.balance]),
    parties: (data.parties || []).map((p) => [p.id, p.outstandingBalance]),
    invoices: (data.invoices || []).map((i) => [i.id, i.status, i.outstandingAmount]),
    bankTransactions: (data.bankTransactions || []).map((t) => ({
      id: t.id,
      date: t.date,
      description: t.description,
      reference: t.reference,
      amount: t.amount,
      reconciled: t.reconciled,
      matchedInvoiceId: t.matchedInvoiceId,
    })),
    journals: (data.journalEntries || []).map((je) => ({
      entryNumber: je.entryNumber,
      date: je.date,
      totalDebit: je.totalDebit,
      totalCredit: je.totalCredit,
      remarks: je.remarks,
      items: (je.items || []).map((it) => ({
        accountId: it.accountId,
        partyId: it.partyId,
        debit: it.debit,
        credit: it.credit,
        remark: it.remark,
      })),
    })),
    audit: (data.auditLog || []).map((a) => ({ action: a.action, summary: a.summary })),
  }
}

/** Import results carry the wall-clock reconciliation stamp of a line a
 *  payment already covered; everything else must match exactly. */
function withoutClock<T>(result: T): T {
  const copy = clone(result) as { transactions?: Record<string, unknown>[] }
  if (Array.isArray(copy.transactions)) {
    copy.transactions = copy.transactions.map((tx) =>
      tx.reconciledAt === undefined ? tx : { ...tx, reconciledAt: '<timestamp>' },
    )
  }
  return copy as T
}

async function importViaBothPaths(base: BooksData, csvContent: string) {
  const stored = seedBoth(base)

  resetTxIds()
  const mainResult = importBankStatement({ booksDataPath, csvContent })
  const mainLedger = readBooksStore(booksDataPath)

  seedBoth(stored)
  resetTxIds()
  const rendererResult = await useBooksStore.getState().importBankStatementCsv(csvContent)
  const rendererLedger = useBooksStore.getState().data

  return { stored, mainResult, mainLedger, rendererResult, rendererLedger }
}

async function reconcileViaBothPaths(base: BooksData, transactionId: string, invoiceId: string) {
  const stored = seedBoth(base)

  const mainResult = executeReconciliationCore({ booksDataPath, transactionId, invoiceId })
  const mainLedger = readBooksStore(booksDataPath)

  seedBoth(stored)
  const rendererResult = await useBooksStore
    .getState()
    .reconcileTransaction(transactionId, invoiceId)
  const rendererLedger = useBooksStore.getState().data

  return { stored, mainResult, mainLedger, rendererResult, rendererLedger }
}

describe('bank statement import — main process vs renderer', () => {
  it('returns identical counters, transactions and ledgers', async () => {
    const invoice = salesInvoice()
    const existing = bankTx({
      id: 'tx-existing',
      date: '2026-09-05',
      description: 'EFT Deposit Parity Client',
      amount: 115000,
    })
    const csv = csvOf(
      '2026-09-05,"EFT Deposit Parity Client","",115000.00',
      '2026-09-08,"EFT Deposit Parity Client INV-2026-901","",115000.00',
      '2026-09-09,"Partial EFT parity INV-2026-901","",20000.00',
      '2026-09-11,"Monthly Account Fee","FEE-1",-450.00',
    )

    const { stored, mainResult, mainLedger, rendererResult, rendererLedger } =
      await importViaBothPaths(
        baseLedger({ invoices: [invoice], bankTransactions: [existing] }),
        csv,
      )

    expect(withoutClock(rendererResult)).toEqual(withoutClock(mainResult))
    expect(mainResult.ok).toBe(true)
    expect(mainResult.importedCount).toBe(3)
    expect(mainResult.skippedDuplicates).toBe(1)
    expect(mainResult.netAdjustment).toBe(134550)
    const seedBank = stored.accounts.find((a) => a.id === 'acc-bank')!.balance
    expect(mainResult.newBankBalance).toBe(seedBank + 134550)
    expect(mainResult.transactions).toHaveLength(3)

    // Both transports posted one import journal per new statement line.
    expect(mainLedger.journalEntries.length).toBe(stored.journalEntries.length + 3)
    expect(ledgerView(rendererLedger)).toEqual(ledgerView(mainLedger))
    expect(engineCalls.imports).toBe(2)
  })

  it('pre-reconciles a line a recorded payment already covered, identically', async () => {
    const invoice = salesInvoice()
    const payment: Payment = {
      id: 'pay-parity-1',
      partyId: PARTY.id,
      partyName: PARTY.name,
      date: '2026-09-08',
      type: 'received',
      allocations: [
        { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, amount: 115000 },
      ],
      total: 115000,
      createdAt: '2026-09-08T09:00:00Z',
    }
    const csv = csvOf('2026-09-08,"EFT Deposit Parity Client INV-2026-901","",115000.00')

    const { stored, mainResult, mainLedger, rendererResult, rendererLedger } =
      await importViaBothPaths(baseLedger({ invoices: [invoice], payments: [payment] }), csv)

    expect(withoutClock(rendererResult)).toEqual(withoutClock(mainResult))
    expect(mainResult.ok).toBe(true)
    expect(mainResult.importedCount).toBe(1)
    // The payment already booked the cash: the line is stored pre-reconciled
    // and posts no second bank journal. The deleted renderer copy returned
    // the pre-reconciliation list here (`transactions: toAdd`).
    expect(mainResult.transactions![0].reconciled).toBe(true)
    expect(mainResult.transactions![0].matchedInvoiceId).toBe(invoice.id)

    const tx = mainLedger.bankTransactions!.find((t) => t.id === mainResult.transactions![0].id)!
    expect(tx.reconciled).toBe(true)
    expect(mainLedger.journalEntries.length).toBe(stored.journalEntries.length)

    expect(ledgerView(rendererLedger)).toEqual(ledgerView(mainLedger))
    expect(engineCalls.imports).toBe(2)
  })

  it('still prefers the IPC bridge when the preload API exists', async () => {
    const stored = seedBoth(baseLedger({ invoices: [salesInvoice()] }))
    const bridgeResult = { ok: true, importedCount: 7, skippedDuplicates: 0, netAdjustment: 100 }
    const importSpy = vi.fn(async () => bridgeResult)
    ;(window as unknown as { booksApi: unknown }).booksApi = {
      importBankStatementCsv: importSpy,
      // A successful read: the store marks anything else as unreadable and
      // refuses to write the ledger back.
      loadData: async () => ({ ok: true, readable: true, data: clone(stored) }),
    }

    const result = await useBooksStore
      .getState()
      .importBankStatementCsv(csvOf('2026-09-08,"Anything","",100.00'))

    expect(result).toBe(bridgeResult)
    expect(importSpy).toHaveBeenCalledTimes(1)
    expect(engineCalls.imports).toBe(0)
  })
})

describe('1-click reconciliation — main process vs renderer', () => {
  it('settles an exact match identically', async () => {
    const invoice = salesInvoice()
    const tx = bankTx({
      id: 'tx-exact',
      description: 'EFT Deposit Parity Client INV-2026-901',
      reference: 'INV-2026-901',
      amount: 115000,
    })

    const { stored, mainResult, mainLedger, rendererResult, rendererLedger } =
      await reconcileViaBothPaths(
        baseLedger({ invoices: [invoice], bankTransactions: [tx] }),
        tx.id,
        invoice.id,
      )

    expect(rendererResult).toEqual(mainResult)
    expect(mainResult).toMatchObject({
      ok: true,
      settledAmount: 115000,
      remainingOutstanding: 0,
      invoiceStatus: 'Paid',
      partyBalance: 0,
    })
    expect(mainLedger.journalEntries.length).toBe(stored.journalEntries.length + 1)
    expect(mainLedger.invoices[0]).toMatchObject({ status: 'Paid', outstandingAmount: 0 })
    expect(ledgerView(rendererLedger)).toEqual(ledgerView(mainLedger))
    expect(engineCalls.reconciliations).toBe(2)
  })

  it('settles a partial match identically', async () => {
    const invoice = salesInvoice()
    const tx = bankTx({
      id: 'tx-partial',
      description: 'First tranche for INV-2026-901',
      amount: 20000,
    })

    const { stored, mainResult, mainLedger, rendererResult, rendererLedger } =
      await reconcileViaBothPaths(
        baseLedger({ invoices: [invoice], bankTransactions: [tx] }),
        tx.id,
        invoice.id,
      )

    expect(rendererResult).toEqual(mainResult)
    expect(mainResult).toMatchObject({
      ok: true,
      settledAmount: 20000,
      remainingOutstanding: 95000,
      invoiceStatus: 'Unpaid',
      partyBalance: 95000,
    })
    const journal = mainLedger.journalEntries[0]
    expect(journal.totalDebit).toBe(20000)
    expect(journal.totalCredit).toBe(20000)
    expect(mainLedger.journalEntries.length).toBe(stored.journalEntries.length + 1)
    expect(ledgerView(rendererLedger)).toEqual(ledgerView(mainLedger))
  })

  it('books an over-amount deposit as an unapplied receipt, never a stranded suspense balance', async () => {
    const invoice = salesInvoice()
    const tx = bankTx({
      id: 'tx-over',
      description: 'Overpayment for INV-2026-901',
      amount: 120000,
    })

    const { mainResult, mainLedger, rendererResult, rendererLedger } = await reconcileViaBothPaths(
      baseLedger({ invoices: [invoice], bankTransactions: [tx] }),
      tx.id,
      invoice.id,
    )

    expect(rendererResult).toEqual(mainResult)
    expect(mainResult).toMatchObject({
      ok: true,
      // The invoice absorbs what it was owed; the 5 000 remainder is the
      // party's credit, not a Suspense balance.
      settledAmount: 115000,
      remainingOutstanding: -5000,
      // An invoice carrying a party credit stays open, so the control account,
      // the party balance and the aging report all show that credit.
      invoiceStatus: 'Unpaid',
      unappliedAmount: 5000,
    })
    // The whole statement line leaves Bank: the invoice part plus the excess.
    const settlement = mainLedger.journalEntries[0]
    expect(settlement.totalDebit).toBe(120000)
    expect(settlement.totalCredit).toBe(120000)
    expect(allJournalsBalanced([settlement])).toBe(true)
    expect(
      settlement.items.filter((item) => item.remark?.startsWith('Unapplied receipt')).length,
    ).toBe(2)
    expect(mainLedger.invoices[0]).toMatchObject({ status: 'Unpaid', outstandingAmount: -5000 })
    expect(ledgerView(rendererLedger)).toEqual(ledgerView(mainLedger))
  })

  it('rejects direction mismatches identically, leaving both ledgers untouched', async () => {
    const invoice = salesInvoice()
    const withdrawal = bankTx({
      id: 'tx-withdrawal',
      description: 'Debit order',
      amount: -57500,
    })
    const salesRun = await reconcileViaBothPaths(
      baseLedger({ invoices: [invoice], bankTransactions: [withdrawal] }),
      withdrawal.id,
      invoice.id,
    )

    expect(salesRun.rendererResult).toEqual(salesRun.mainResult)
    expect(salesRun.mainResult).toEqual({
      ok: false,
      error: 'Cannot reconcile a debit/withdrawal transaction against a Sales invoice',
    })
    expect(ledgerView(salesRun.mainLedger)).toEqual(ledgerView(salesRun.stored))
    expect(ledgerView(salesRun.rendererLedger)).toEqual(ledgerView(salesRun.stored))

    const bill = purchaseBill()
    const deposit = bankTx({
      id: 'tx-deposit',
      description: 'Deposit',
      amount: 57500,
    })
    const purchaseRun = await reconcileViaBothPaths(
      baseLedger({ invoices: [bill], bankTransactions: [deposit] }),
      deposit.id,
      bill.id,
    )

    expect(purchaseRun.rendererResult).toEqual(purchaseRun.mainResult)
    expect(purchaseRun.mainResult).toEqual({
      ok: false,
      error: 'Cannot reconcile a credit/deposit transaction against a Purchase bill',
    })
    expect(ledgerView(purchaseRun.mainLedger)).toEqual(ledgerView(purchaseRun.stored))
    expect(ledgerView(purchaseRun.rendererLedger)).toEqual(ledgerView(purchaseRun.stored))
  })

  it('clears Suspense in full for an over-amount statement line and keeps every record on the party credit', async () => {
    const invoice = salesInvoice()
    const tx = bankTx({
      id: 'tx-advance',
      description: 'Overpayment for INV-2026-901',
      amount: 120000,
    })
    const base = baseLedger({ invoices: [invoice], bankTransactions: [tx] })
    const accounts = base.accounts
    const openingBank = accounts.find((a) => a.id === 'acc-bank')!.balance
    const openingAr = accounts.find((a) => a.id === 'acc-ar')!.balance

    // A statement-imported line: the import journal already put the cash in
    // Bank against Suspense, so the reconciliation must clear all of it.
    const imported = {
      ...base,
      journalEntries: [
        createSalesInvoiceJournal(invoice, accounts, PARTY),
        createBankImportJournal(tx, accounts, 'JE-2026-IMP-ADV'),
        ...base.journalEntries,
      ],
    }

    const { mainResult, mainLedger, rendererResult, rendererLedger } = await reconcileViaBothPaths(
      imported,
      tx.id,
      invoice.id,
    )

    expect(rendererResult).toEqual(mainResult)
    expect(mainResult).toMatchObject({
      ok: true,
      settledAmount: 115000,
      remainingOutstanding: -5000,
      invoiceStatus: 'Unpaid',
      unappliedAmount: 5000,
      partyBalance: -5000,
    })

    const ledger = mainLedger
    expect(allJournalsBalanced(ledger.journalEntries)).toBe(true)
    const balance = (accountId: string): number =>
      ledger.accounts.find((a) => a.id === accountId)!.balance
    // No permanent Suspense balance is left behind: the line is reconciled, so
    // nothing could ever clear it.
    expect(balance('acc-suspense')).toBe(0)
    // Bank holds the statement movement; AR holds the invoice plus the credit.
    expect(balance('acc-bank')).toBe(round2(openingBank + 120000))
    expect(balance('acc-ar')).toBe(round2(openingAr + 115000 - 120000))

    // The control account, the derived party balance and the aging report all
    // agree on the 5 000 credit.
    expect(ledger.invoices[0]).toMatchObject({ outstandingAmount: -5000, status: 'Unpaid' })
    expect(ledger.parties[0].outstandingBalance).toBe(-5000)
    const aging = agingBuckets(ledger.invoices, ledger.parties, '2026-09-30', 'Sales')
    expect(aging).toHaveLength(1)
    expect(aging[0].credit).toBe(5000)
    expect(aging[0].total).toBe(-5000)
    expect(aging[0].total).toBe(balance('acc-ar') - openingAr)

    expect(ledgerView(rendererLedger)).toEqual(ledgerView(mainLedger))
  })

  it('settles a line a recorded payment already covered, identically, and carries its paymentLinks', async () => {
    // The invoice has already taken a 50 000 payment (65 000 outstanding) and
    // the statement line is for the whole 115 000 the payment is part of. The
    // line therefore carries the payment coverage, which is what the reconcile
    // must read before it places any of the cash again.
    const partial = salesInvoice({ outstandingAmount: 65000 })
    const payment: Payment = {
      id: 'pay-parity-partial',
      partyId: PARTY.id,
      partyName: PARTY.name,
      date: '2026-09-08',
      type: 'received',
      allocations: [{ invoiceId: partial.id, invoiceNumber: partial.invoiceNumber, amount: 50000 }],
      total: 50000,
      createdAt: '2026-09-08T09:00:00Z',
    }
    const csv = csvOf('2026-09-08,"EFT Deposit Parity Client INV-2026-901","",115000.00')

    const { stored, mainResult, mainLedger, rendererResult, rendererLedger } =
      await importViaBothPaths(baseLedger({ invoices: [partial], payments: [payment] }), csv)

    expect(withoutClock(rendererResult)).toEqual(withoutClock(mainResult))
    expect(mainResult.ok).toBe(true)
    expect(mainResult.importedCount).toBe(1)

    const afterImport = mainLedger
    const openingSuspense = stored.accounts.find((a) => a.id === 'acc-suspense')!.balance
    const openingAr = stored.accounts.find((a) => a.id === 'acc-ar')!.balance
    const tx = afterImport.bankTransactions!.find((t) => !t.reconciled)!
    // The coverage rides on the line itself, so the reconcile below can tell
    // how much of the cash a recorded payment already posted.
    expect(tx.paymentLinks).toEqual([
      { paymentId: payment.id, amount: 50000, invoiceId: partial.id },
    ])
    // Only the uncovered remainder — the 65 000 still outstanding — posts.
    expect(afterImport.accounts.find((a) => a.id === 'acc-suspense')!.balance).toBe(
      round2(openingSuspense - 65000),
    )
    expect(ledgerView(rendererLedger)).toEqual(ledgerView(afterImport))

    const settled = await reconcileViaBothPaths(afterImport, tx.id, partial.id)

    expect(settled.rendererResult).toEqual(settled.mainResult)
    expect(settled.mainResult).toMatchObject({
      ok: true,
      // The covered 50 000 is NOT settled again: the payment already placed it.
      settledAmount: 65000,
      remainingOutstanding: 0,
      unappliedAmount: 0,
      invoiceStatus: 'Paid',
      partyBalance: 0,
    })

    const ledger = settled.mainLedger
    expect(allJournalsBalanced(ledger.journalEntries)).toBe(true)
    const balance = (accountId: string): number =>
      ledger.accounts.find((a) => a.id === accountId)!.balance
    // The reconcile clears exactly what the import put in Suspense, no more.
    expect(balance('acc-suspense')).toBe(openingSuspense)
    // AR moves by the 65 000 the invoice still owed, not by the full line.
    expect(balance('acc-ar')).toBe(round2(openingAr - 65000))
    expect(ledger.invoices[0]).toMatchObject({ outstandingAmount: 0, status: 'Paid' })
    expect(ledger.parties[0].outstandingBalance).toBe(0)
    expect(agingBuckets(ledger.invoices, ledger.parties, '2026-09-30', 'Sales')).toEqual([])

    expect(ledgerView(settled.rendererLedger)).toEqual(ledgerView(settled.mainLedger))
    expect(engineCalls.imports).toBe(2)
    expect(engineCalls.reconciliations).toBe(2)
  })
})

describe('settlement suggestions — main process vs renderer', () => {
  it('returns the same exact-amount suggestion to both transports', () => {
    const invoice = salesInvoice()
    const tx = bankTx({
      id: 'tx-sugg-exact',
      description: 'EFT Deposit Parity Client INV-2026-901',
      amount: 115000,
    })
    seedBoth(baseLedger({ invoices: [invoice], bankTransactions: [tx] }))

    const fromDisk = computeSettlementSuggestions(readBooksStore(booksDataPath))
    const fromStore = computeSettlementSuggestions(useBooksStore.getState().data)

    expect(fromStore).toEqual(fromDisk)
    expect(fromDisk).toEqual([
      {
        transactionId: 'tx-sugg-exact',
        invoiceId: invoice.id,
        invoiceNumber: 'INV-2026-901',
        partyName: PARTY.name,
        invoiceType: 'Sales',
        amount: 115000,
        confidence: 'HIGH',
        reason: 'Exact amount match and contains invoice number: INV-2026-901',
      },
    ])
  })

  it('returns the partial-payment suggestion the renderer copy omitted', () => {
    const invoice = salesInvoice()
    const tx = bankTx({
      id: 'tx-sugg-partial',
      description: 'Second tranche against INV-2026-901',
      amount: 20000,
    })
    seedBoth(baseLedger({ invoices: [invoice], bankTransactions: [tx] }))

    const fromDisk = computeSettlementSuggestions(readBooksStore(booksDataPath))
    const fromStore = computeSettlementSuggestions(useBooksStore.getState().data)

    expect(fromStore).toEqual(fromDisk)
    expect(fromDisk).toEqual([
      {
        transactionId: 'tx-sugg-partial',
        invoiceId: invoice.id,
        invoiceNumber: 'INV-2026-901',
        partyName: PARTY.name,
        invoiceType: 'Sales',
        amount: 20000,
        confidence: 'MEDIUM',
        reason: 'Partial payment matching invoice INV-2026-901',
      },
    ])
  })
})

describe('the renderer store runs the shared engine, not a private copy', () => {
  it('imports through the shared engine and records its audit wording', async () => {
    seedBoth(baseLedger({ invoices: [salesInvoice()] }))
    engineCalls.imports = 0

    const res = await useBooksStore
      .getState()
      .importBankStatementCsv(
        csvOf('2026-09-08,"EFT Deposit Parity Client INV-2026-901","",115000.00'),
      )

    expect(engineCalls.imports).toBe(1)
    expect(res.ok).toBe(true)
    const audit = (useBooksStore.getState().data.auditLog || [])[0]
    expect(audit.action).toBe('bank.import')
    // The shared engine's summary — the deleted renderer copy said
    // "Imported N bank transaction(s) from CSV (M duplicate(s) skipped)".
    expect(audit.summary).toBe('Imported bank statement: 1 new transaction (0 duplicates skipped)')
  })

  it('reconciles through the shared engine and records its audit wording', async () => {
    const invoice = salesInvoice()
    const tx = bankTx({ id: 'tx-engine', description: 'Deposit INV-2026-901', amount: 115000 })
    seedBoth(baseLedger({ invoices: [invoice], bankTransactions: [tx] }))
    engineCalls.reconciliations = 0

    const res = await useBooksStore.getState().reconcileTransaction(tx.id, invoice.id)

    expect(engineCalls.reconciliations).toBe(1)
    expect(res.ok).toBe(true)
    const audit = (useBooksStore.getState().data.auditLog || [])[0]
    expect(audit.action).toBe('bank.reconcile')
    // The shared engine's summary — the deleted renderer copy said
    // "Reconciled <description> against invoice <number>".
    expect(audit.summary).toBe('Reconciled Deposit INV-2026-901 against INV-2026-901')
  })

  it('keeps the settlement surface importable from the main-process module', async () => {
    const booksMain = await import('../src/main/books-main')
    for (const name of [
      'migrateAndValidateBooks',
      'issueSalesInvoiceInBooks',
      'parseBankStatementCsv',
      'importBankStatement',
      'computeSettlementSuggestions',
      'executeReconciliationCore',
    ]) {
      expect(typeof (booksMain as unknown as Record<string, unknown>)[name]).toBe('function')
    }
  })
})

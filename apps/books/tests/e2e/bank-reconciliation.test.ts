// @vitest-environment node

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { BOOKS_CHANNELS } from '../../src/shared/ipc'
import { allJournalsBalanced } from '../../src/shared/accounting'
import type { BooksDataEnvelope, SettlementSuggestion } from '../../src/shared/types'
import { bootBooksE2E, type BooksE2ESession } from '../helpers/books-e2e'
import {
  ABSA_STATEMENT_CSV,
  ABSA_STATEMENT_NET,
  FNB_PARTIAL_STATEMENT_CSV,
  FNB_SETTLEMENT_CSV,
  FNB_SETTLEMENT_NET,
  FNB_STATEMENT_CSV,
  FNB_STATEMENT_NET,
  NEDBANK_STATEMENT_CSV,
  NEDBANK_STATEMENT_NET,
  STANDARD_BANK_STATEMENT_CSV,
  STANDARD_BANK_STATEMENT_NET,
  emptyLedger,
} from './fixtures'

vi.mock('electron', async () => {
  const { createElectronModule } = await import('../helpers/electron-mock')
  return createElectronModule()
})

// Booting the real module re-imports its whole graph; the shared runner is
// slow under parallel load, so these journeys get more room than the unit suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const CUSTOMER = 'Rand Water Authority'
const SALES_TOTAL = 23000

interface ImportResult {
  ok: boolean
  error?: string
  importedCount?: number
  skippedDuplicates?: number
  netAdjustment?: number
  newBankBalance?: number | null
}

interface ReconcileResult {
  ok: boolean
  error?: string
  invoiceNumber?: string
  settledAmount?: number
  remainingOutstanding?: number
  invoiceStatus?: string
  partyBalance?: number
}

interface IssueResult {
  ok: boolean
  error?: string
  invoice?: { id: string; invoiceNumber: string }
}

function accountBalance(data: BooksDataEnvelope, id: string): number {
  return data.accounts.find((account) => account.id === id)?.balance ?? Number.NaN
}

/** Books exactly one sales invoice of SALES_TOTAL through the real posting path. */
async function seedSalesInvoice(session: BooksE2ESession): Promise<void> {
  expect(await session.saveData(emptyLedger())).toBe(true)
  const issued = session.modules.issueSalesInvoiceInBooks({
    booksDataPath: session.booksDataPath,
    partyName: CUSTOMER,
    itemDescription: 'Bulk water pipeline maintenance',
    amount: SALES_TOTAL,
    date: '2026-08-05',
    dueDate: '2026-09-04',
  }) as IssueResult
  expect(issued.ok).toBe(true)
  expect(issued.invoice?.invoiceNumber).toBe('INV-2026-001')
}

describe('Books e2e: South African bank statement import', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  const importCsv = (csv: string) =>
    session.invoke<ImportResult>(BOOKS_CHANNELS.importBankStatementCsv, csv)

  it('imports FNB, Standard Bank, Nedbank and Absa shapes and moves the bank balance by the parsed net', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    expect(accountBalance((await session.loadData())!, 'acc-bank')).toBe(0)

    const fnb = await importCsv(FNB_STATEMENT_CSV)
    expect(fnb.ok).toBe(true)
    expect(fnb.importedCount).toBe(3)
    expect(fnb.skippedDuplicates).toBe(0)
    expect(fnb.netAdjustment).toBe(FNB_STATEMENT_NET)
    expect(fnb.newBankBalance).toBe(FNB_STATEMENT_NET)
    expect(accountBalance((await session.loadData())!, 'acc-bank')).toBe(FNB_STATEMENT_NET)
    expect(
      session.broadcasts().some((message) => message.channel === BOOKS_CHANNELS.dataChanged),
    ).toBe(true)

    const standard = await importCsv(STANDARD_BANK_STATEMENT_CSV)
    expect(standard.importedCount).toBe(3)
    expect(standard.netAdjustment).toBe(STANDARD_BANK_STATEMENT_NET)
    expect(standard.newBankBalance).toBe(FNB_STATEMENT_NET + STANDARD_BANK_STATEMENT_NET)

    const nedbank = await importCsv(NEDBANK_STATEMENT_CSV)
    expect(nedbank.importedCount).toBe(3)
    expect(nedbank.netAdjustment).toBe(NEDBANK_STATEMENT_NET)
    expect(nedbank.newBankBalance).toBe(
      FNB_STATEMENT_NET + STANDARD_BANK_STATEMENT_NET + NEDBANK_STATEMENT_NET,
    )

    const absa = await importCsv(ABSA_STATEMENT_CSV)
    expect(absa.importedCount).toBe(2)
    expect(absa.netAdjustment).toBe(ABSA_STATEMENT_NET)
    const expectedBank =
      FNB_STATEMENT_NET + STANDARD_BANK_STATEMENT_NET + NEDBANK_STATEMENT_NET + ABSA_STATEMENT_NET
    expect(absa.newBankBalance).toBe(expectedBank)

    const data = (await session.loadData())!
    expect(data.bankTransactions).toHaveLength(11)
    expect(data.bankTransactions!.every((tx) => tx.reconciled === false)).toBe(true)
    expect(allJournalsBalanced(data.journalEntries)).toBe(true)
    expect(accountBalance(data, 'acc-bank')).toBe(expectedBank)
    // Every imported line posted Dr/Cr Bank against Bank Suspense.
    expect(accountBalance(data, 'acc-suspense')).toBe(-expectedBank)

    const dates = data.bankTransactions!.map((tx) => tx.date)
    expect(dates).toContain('2026-08-03')
    expect(dates).toContain('2026-08-04')
    expect(dates).toContain('2026-08-07')
    expect(dates).toContain('2026-08-18')
    expect(dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))).toBe(true)
  })

  it('skips every line when the same statement is imported twice', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const first = await importCsv(FNB_STATEMENT_CSV)
    expect(first.importedCount).toBe(3)

    const repeat = await importCsv(FNB_STATEMENT_CSV)
    expect(repeat.ok).toBe(true)
    expect(repeat.importedCount).toBe(0)
    expect(repeat.skippedDuplicates).toBe(3)
    expect(repeat.netAdjustment).toBe(0)
    expect(repeat.newBankBalance).toBe(FNB_STATEMENT_NET)

    const data = (await session.loadData())!
    expect(data.bankTransactions).toHaveLength(3)
    expect(accountBalance(data, 'acc-bank')).toBe(FNB_STATEMENT_NET)
  })

  it('rejects a CSV with no parsable transactions', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const result = await importCsv('Please see attached statement')
    expect(result).toEqual({ ok: false, error: 'No valid transactions found in statement CSV' })
    expect(accountBalance((await session.loadData())!, 'acc-bank')).toBe(0)
  })
})

describe('Books e2e: reconciliation and settlement suggestions', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('reconciles a deposit against an invoice and settles both ledgers', async () => {
    await seedSalesInvoice(session)

    const imported = await session.invoke<ImportResult>(
      BOOKS_CHANNELS.importBankStatementCsv,
      FNB_SETTLEMENT_CSV,
    )
    expect(imported.importedCount).toBe(1)
    expect(imported.newBankBalance).toBe(FNB_SETTLEMENT_NET)

    const before = (await session.loadData())!
    const tx = before.bankTransactions!.find((item) => item.amount === SALES_TOTAL)!
    const invoice = before.invoices.find((item) => item.invoiceNumber === 'INV-2026-001')!
    expect(accountBalance(before, 'acc-ar')).toBe(SALES_TOTAL)
    expect(accountBalance(before, 'acc-suspense')).toBe(-SALES_TOTAL)

    const result = await session.invoke<ReconcileResult>(
      BOOKS_CHANNELS.reconcileTransaction,
      tx.id,
      invoice.id,
    )
    expect(result.ok).toBe(true)
    expect(result.invoiceNumber).toBe('INV-2026-001')
    expect(result.settledAmount).toBe(SALES_TOTAL)
    expect(result.remainingOutstanding).toBe(0)
    expect(result.invoiceStatus).toBe('Paid')
    expect(result.partyBalance).toBe(0)

    const after = (await session.loadData())!
    const settledTx = after.bankTransactions!.find((item) => item.id === tx.id)!
    expect(settledTx.reconciled).toBe(true)
    expect(settledTx.matchedInvoiceId).toBe(invoice.id)
    expect(typeof settledTx.reconciledAt).toBe('string')

    const settledInvoice = after.invoices.find((item) => item.id === invoice.id)!
    expect(settledInvoice.status).toBe('Paid')
    expect(settledInvoice.outstandingAmount).toBe(0)

    expect(accountBalance(after, 'acc-bank')).toBe(SALES_TOTAL)
    expect(accountBalance(after, 'acc-ar')).toBe(0)
    expect(accountBalance(after, 'acc-suspense')).toBe(0)
    expect(after.parties.find((party) => party.name === CUSTOMER)?.outstandingBalance).toBe(0)
    expect(allJournalsBalanced(after.journalEntries)).toBe(true)

    const reclass = after.journalEntries.find((journal) => journal.id === `je-reclass-${tx.id}`)!
    expect(reclass.totalDebit).toBe(SALES_TOTAL)
    expect(reclass.totalCredit).toBe(SALES_TOTAL)
    expect(reclass.items.some((item) => item.accountId === 'acc-bank')).toBe(false)
    expect(reclass.items.find((item) => item.accountId === 'acc-suspense')?.debit).toBe(SALES_TOTAL)
    expect(reclass.items.find((item) => item.accountId === 'acc-ar')?.credit).toBe(SALES_TOTAL)

    const again = await session.invoke<ReconcileResult>(
      BOOKS_CHANNELS.reconcileTransaction,
      tx.id,
      invoice.id,
    )
    expect(again.ok).toBe(false)
    expect(again.error).toContain('already reconciled')
  })

  it('refuses to reconcile a withdrawal against a sales invoice', async () => {
    await seedSalesInvoice(session)
    const imported = await session.invoke<ImportResult>(
      BOOKS_CHANNELS.importBankStatementCsv,
      FNB_STATEMENT_CSV,
    )
    expect(imported.importedCount).toBe(3)

    const data = (await session.loadData())!
    const withdrawal = data.bankTransactions!.find((item) => item.amount === -1250)!
    const invoice = data.invoices.find((item) => item.invoiceNumber === 'INV-2026-001')!

    const result = await session.invoke<ReconcileResult>(
      BOOKS_CHANNELS.reconcileTransaction,
      withdrawal.id,
      invoice.id,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe(
      'Cannot reconcile a debit/withdrawal transaction against a Sales invoice',
    )

    const unchanged = (await session.loadData())!
    expect(unchanged.invoices.find((item) => item.id === invoice.id)?.status).toBe('Unpaid')
    expect(unchanged.bankTransactions!.find((item) => item.id === withdrawal.id)?.reconciled).toBe(
      false,
    )
  })

  it('suggests the exact match as HIGH and the smaller deposit as a partial match', async () => {
    await seedSalesInvoice(session)
    const imported = await session.invoke<ImportResult>(
      BOOKS_CHANNELS.importBankStatementCsv,
      FNB_PARTIAL_STATEMENT_CSV,
    )
    expect(imported.importedCount).toBe(2)

    const data = (await session.loadData())!
    const invoice = data.invoices.find((item) => item.invoiceNumber === 'INV-2026-001')!
    const exactTx = data.bankTransactions!.find((item) => item.amount === SALES_TOTAL)!
    const partialTx = data.bankTransactions!.find((item) => item.amount === 5000)!

    const suggestions = await session.invoke<SettlementSuggestion[]>(
      BOOKS_CHANNELS.getSettlementSuggestions,
    )
    expect(suggestions).toHaveLength(2)

    const exact = suggestions.find((item) => item.transactionId === exactTx.id)!
    expect(exact).toMatchObject({
      invoiceId: invoice.id,
      invoiceNumber: 'INV-2026-001',
      partyName: CUSTOMER,
      invoiceType: 'Sales',
      amount: SALES_TOTAL,
      confidence: 'HIGH',
      reason: 'Exact amount match and contains invoice number: INV-2026-001',
    })

    const partial = suggestions.find((item) => item.transactionId === partialTx.id)!
    expect(partial).toMatchObject({
      invoiceId: invoice.id,
      invoiceNumber: 'INV-2026-001',
      invoiceType: 'Sales',
      amount: 5000,
      confidence: 'MEDIUM',
      reason: 'Partial payment matching invoice INV-2026-001',
    })
  })

  it('offers no suggestion once every statement line is reconciled', async () => {
    await seedSalesInvoice(session)
    await session.invoke(BOOKS_CHANNELS.importBankStatementCsv, FNB_SETTLEMENT_CSV)
    const data = (await session.loadData())!
    const tx = data.bankTransactions!.find((item) => item.amount === SALES_TOTAL)!
    const invoice = data.invoices.find((item) => item.invoiceNumber === 'INV-2026-001')!

    await session.invoke(BOOKS_CHANNELS.reconcileTransaction, tx.id, invoice.id)

    expect(
      await session.invoke<SettlementSuggestion[]>(BOOKS_CHANNELS.getSettlementSuggestions),
    ).toEqual([])
  })
})

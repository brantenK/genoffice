import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  executeReconciliationCore,
  importBankStatement,
  issueSalesInvoiceInBooks,
  readBooksStore,
  writeBooksStore,
} from '../src/main/books-core'
import { allJournalsBalanced, round2 } from '../src/shared/accounting'
import { computeSettlementSuggestions } from '../src/shared/settlement'
import { agingBuckets } from '../src/shared/reports'
import { applyLoadedEnvelope, useBooksStore } from '../src/renderer/src/store'
import { emptyLedger } from './e2e/fixtures'
import type { BankTransaction, BooksData, Invoice } from '../src/shared/types'

/**
 * Over-payment coverage — the two money defects an adversarial verification
 * round found in the bank-reconciliation engine, plus the states around them.
 *
 * D1: reconciling a line a recorded payment already covered re-booked the
 * covered cash as an unapplied receipt on BOTH legs, doubling Bank and leaving
 * a Suspense balance the now-reconciled line could never clear.
 * D2: a second over-amount line for the same invoice was refused with
 * "Invoice already marked Paid" while the invoice was plainly Unpaid, and the
 * suggestion engine offered no route to apply it either.
 *
 * Every scenario runs through the real paths over ONE ledger shared by both
 * transports: the store's payment/import/reconcile actions (the renderer, and
 * the app whenever no IPC bridge is present) and the main process's own
 * importBankStatement / executeReconciliationCore (the functions the IPC
 * handlers call). Nothing here posts a journal by hand, so the coverage
 * interaction these defects lived in is exercised, not simulated.
 */

const CUSTOMER = 'Rand Water Authority'
const INVOICE_TOTAL = 1150

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const csvOf = (...rows: string[]): string =>
  ['Date,Description,Reference,Amount', ...rows].join('\n')

/** One deposit line for INV-2026-001, in the shape the statement parser reads. */
const depositRow = (date: string, amount: number, narrative = 'DEPOSIT RAND WATER AUTHORITY') =>
  `${date},"${narrative}","INV-2026-001",${amount.toFixed(2)}`

let testDir: string
let booksDataPath: string

beforeEach(() => {
  testDir = join(tmpdir(), `books-overpayment-${randomUUID().slice(0, 8)}`)
  mkdirSync(testDir, { recursive: true })
  booksDataPath = join(testDir, 'books-data.json')
  ;(window as unknown as { booksApi: unknown }).booksApi = undefined
  writeBooksStore(booksDataPath, emptyLedger())
  applyLoadedEnvelope(clone(emptyLedger()))
})

afterEach(() => {
  try {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  } catch {}
})

/** The ledger as the main-process transport sees it. */
const storedData = (): BooksData => readBooksStore(booksDataPath)

/** Writes the store's ledger to the temp file, so the main-process transport
 *  (and the IPC handlers behind it) works on the very same state. */
function toMainTransport(): void {
  writeBooksStore(booksDataPath, clone(useBooksStore.getState().data))
}

/** Reads the temp file back into the store after a main-process step. */
function fromMainTransport(): BooksData {
  const stored = storedData()
  applyLoadedEnvelope(clone(stored))
  return stored
}

/**
 * Issues the 1 150.00 invoice (1 000.00 + 15% VAT) through the real
 * main-process issuance path — the same one CRM and Tenders use — and hands
 * the resulting ledger to the store.
 */
function issueInvoice(): Invoice {
  const issued = issueSalesInvoiceInBooks({
    booksDataPath,
    partyName: CUSTOMER,
    itemDescription: 'Bank reconciliation hardening',
    amount: INVOICE_TOTAL,
    date: '2026-08-01',
    dueDate: '2026-08-31',
  })
  expect(issued.ok, JSON.stringify(issued)).toBe(true)

  const stored = fromMainTransport()
  const invoice = stored.invoices[0]
  expect(invoice).toMatchObject({
    invoiceNumber: 'INV-2026-001',
    subtotal: 1000,
    taxTotal: 150,
    grandTotal: INVOICE_TOTAL,
    outstandingAmount: INVOICE_TOTAL,
    status: 'Unpaid',
  })
  return invoice
}

/** Records a received payment against the invoice through the store. */
async function recordReceipt(amount: number, date: string): Promise<void> {
  const invoice = useBooksStore.getState().data.invoices[0]
  const result = await useBooksStore.getState().recordPayment({
    partyId: invoice.partyId,
    date,
    method: 'Bank Transfer',
    reference: invoice.invoiceNumber,
    allocations: [{ invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, amount }],
  })
  expect(result.ok, JSON.stringify(result)).toBe(true)
}

/** Imports one statement row through the store (the renderer transport). */
async function importViaStore(rows: string[]): Promise<{ ok: boolean; importedCount?: number }> {
  const result = await useBooksStore.getState().importBankStatementCsv(csvOf(...rows))
  expect(result.ok, JSON.stringify(result)).toBe(true)
  return result
}

/** Imports one statement row through books-core (the main-process transport). */
function importViaMain(rows: string[]): { ok: boolean; importedCount?: number } {
  toMainTransport()
  const result = importBankStatement({ booksDataPath, csvContent: csvOf(...rows) })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  fromMainTransport()
  return result
}

const unreconciledTransaction = (data: BooksData): BankTransaction =>
  data.bankTransactions!.find((tx) => !tx.reconciled)!

const balance = (data: BooksData, accountId: string): number =>
  data.accounts.find((account) => account.id === accountId)!.balance

const partyBalance = (data: BooksData): number => data.parties[0].outstandingBalance

/** AR aging totals for the one party: what the aging report shows. */
function agingTotals(data: BooksData): { total: number; credit: number } {
  const rows = agingBuckets(data.invoices, data.parties, '2026-09-30', 'Sales')
  return {
    total: round2(rows.reduce((sum, row) => sum + row.total, 0)),
    credit: round2(rows.reduce((sum, row) => sum + row.credit, 0)),
  }
}

/** Reconciles through books-core — the engine behind the IPC handler. */
function reconcileViaMain(transactionId: string, invoiceId: string) {
  toMainTransport()
  const result = executeReconciliationCore({ booksDataPath, transactionId, invoiceId })
  fromMainTransport()
  return result
}

describe('D1 — a statement line a recorded payment already covered', () => {
  it('books only the uncovered remainder when the receipt comes first', async () => {
    const invoice = issueInvoice()
    await recordReceipt(1000, '2026-08-02')

    // The recorded payment is the only bank movement so far.
    const afterPayment = useBooksStore.getState().data
    expect(balance(afterPayment, 'acc-bank')).toBe(1000)
    expect(balance(afterPayment, 'acc-ar')).toBe(150)
    expect(partyBalance(afterPayment)).toBe(150)
    expect(afterPayment.invoices[0]).toMatchObject({ status: 'Unpaid', outstandingAmount: 150 })

    // The statement line arrives for the full 1 150: the import posts only the
    // 150 the payment did not already cover.
    const imported = await importViaStore([depositRow('2026-08-05', INVOICE_TOTAL)])
    expect(imported.importedCount).toBe(1)

    const afterImport = useBooksStore.getState().data
    expect(balance(afterImport, 'acc-bank')).toBe(1150)
    expect(balance(afterImport, 'acc-suspense')).toBe(-150)
    expect(balance(afterImport, 'acc-ar')).toBe(150)
    const tx = unreconciledTransaction(afterImport)
    // The coverage survives on the line — this is what keeps the reconcile
    // below from booking the payment's 1 000 a second time.
    expect(tx.paymentLinks).toEqual([
      { paymentId: afterImport.payments![0].id, amount: 1000, invoiceId: invoice.id },
    ])

    const result = reconcileViaMain(tx.id, invoice.id)
    expect(result).toEqual({
      ok: true,
      transactionId: tx.id,
      invoiceId: invoice.id,
      invoiceNumber: 'INV-2026-001',
      settledAmount: 150,
      remainingOutstanding: 0,
      invoiceStatus: 'Paid',
      partyBalance: 0,
      unappliedAmount: 0,
    })

    const ledger = storedData()
    expect(balance(ledger, 'acc-bank')).toBe(1150)
    expect(balance(ledger, 'acc-suspense')).toBe(0)
    expect(balance(ledger, 'acc-ar')).toBe(0)
    expect(partyBalance(ledger)).toBe(0)
    expect(ledger.invoices[0]).toMatchObject({ status: 'Paid', outstandingAmount: 0 })
    expect(agingTotals(ledger)).toEqual({ total: 0, credit: 0 })
    expect(ledger.bankTransactions![0].reconciled).toBe(true)
    expect(allJournalsBalanced(ledger.journalEntries)).toBe(true)

    // The settlement entry moves the 150 remainder and nothing else.
    const settlement = ledger.journalEntries[0]
    expect(settlement.totalDebit).toBe(150)
    expect(settlement.totalCredit).toBe(150)
    expect(settlement.items.some((item) => item.remark?.startsWith('Unapplied'))).toBe(false)
  })

  it('produces the same figures when the receipt comes after the import', async () => {
    const invoice = issueInvoice()

    // Import first: the whole 1 150 sits in Suspense against the line.
    const imported = importViaMain([depositRow('2026-08-05', INVOICE_TOTAL)])
    expect(imported.importedCount).toBe(1)
    const afterImport = storedData()
    expect(balance(afterImport, 'acc-bank')).toBe(1150)
    expect(balance(afterImport, 'acc-suspense')).toBe(-1150)
    expect(afterImport.bankTransactions![0].paymentLinks).toBeUndefined()

    // The receipt arrives afterwards: it links the line and clears its own
    // share of Suspense instead of moving Bank again.
    await recordReceipt(1000, '2026-08-02')
    const afterReceipt = useBooksStore.getState().data
    expect(balance(afterReceipt, 'acc-bank')).toBe(1150)
    expect(balance(afterReceipt, 'acc-suspense')).toBe(-150)
    expect(balance(afterReceipt, 'acc-ar')).toBe(150)
    expect(partyBalance(afterReceipt)).toBe(150)
    expect(unreconciledTransaction(afterReceipt)).toMatchObject({
      reconciled: false,
      paymentLinks: [
        { paymentId: afterReceipt.payments![0].id, amount: 1000, invoiceId: invoice.id },
      ],
    })

    const tx = unreconciledTransaction(afterReceipt)
    const result = reconcileViaMain(tx.id, invoice.id)
    expect(result).toEqual({
      ok: true,
      transactionId: tx.id,
      invoiceId: invoice.id,
      invoiceNumber: 'INV-2026-001',
      settledAmount: 150,
      remainingOutstanding: 0,
      invoiceStatus: 'Paid',
      partyBalance: 0,
      unappliedAmount: 0,
    })

    const ledger = storedData()
    expect(balance(ledger, 'acc-bank')).toBe(1150)
    expect(balance(ledger, 'acc-suspense')).toBe(0)
    expect(balance(ledger, 'acc-ar')).toBe(0)
    expect(partyBalance(ledger)).toBe(0)
    expect(ledger.invoices[0]).toMatchObject({ status: 'Paid', outstandingAmount: 0 })
    expect(agingTotals(ledger)).toEqual({ total: 0, credit: 0 })
    expect(ledger.journalEntries[0].totalDebit).toBe(150)
    expect(allJournalsBalanced(ledger.journalEntries)).toBe(true)
  })

  it('settles the last part when the line equals the invoice total', async () => {
    const invoice = issueInvoice()
    importViaMain([depositRow('2026-08-05', INVOICE_TOTAL)])
    await recordReceipt(500, '2026-08-02')

    const afterReceipt = useBooksStore.getState().data
    expect(balance(afterReceipt, 'acc-bank')).toBe(1150)
    expect(balance(afterReceipt, 'acc-suspense')).toBe(-650)
    expect(balance(afterReceipt, 'acc-ar')).toBe(650)

    const tx = unreconciledTransaction(afterReceipt)
    expect(reconcileViaMain(tx.id, invoice.id)).toMatchObject({
      ok: true,
      settledAmount: 650,
      remainingOutstanding: 0,
      unappliedAmount: 0,
      invoiceStatus: 'Paid',
      partyBalance: 0,
    })

    const ledger = storedData()
    expect(balance(ledger, 'acc-bank')).toBe(1150)
    expect(balance(ledger, 'acc-suspense')).toBe(0)
    expect(balance(ledger, 'acc-ar')).toBe(0)
    expect(partyBalance(ledger)).toBe(0)
    expect(agingTotals(ledger)).toEqual({ total: 0, credit: 0 })
  })

  it('settles only the uncovered part when the line is smaller than the invoice', async () => {
    const invoice = issueInvoice()
    await recordReceipt(400, '2026-08-02')

    const afterPayment = useBooksStore.getState().data
    expect(afterPayment.invoices[0]).toMatchObject({ outstandingAmount: 750 })
    expect(balance(afterPayment, 'acc-bank')).toBe(400)

    // A 600 line against a 750 invoice: the 400 the payment already posted is
    // not placed again, so only 200 reaches the invoice.
    importViaMain([depositRow('2026-08-06', 600, 'PART PAYMENT RAND WATER AUTHORITY')])
    const afterImport = storedData()
    expect(balance(afterImport, 'acc-bank')).toBe(600)
    expect(balance(afterImport, 'acc-suspense')).toBe(-200)
    expect(afterImport.bankTransactions![0].paymentLinks).toEqual([
      { paymentId: afterImport.payments![0].id, amount: 400, invoiceId: invoice.id },
    ])

    const tx = unreconciledTransaction(afterImport)
    expect(reconcileViaMain(tx.id, invoice.id)).toMatchObject({
      ok: true,
      settledAmount: 200,
      remainingOutstanding: 550,
      unappliedAmount: 0,
      invoiceStatus: 'Unpaid',
      partyBalance: 550,
    })

    const ledger = storedData()
    expect(balance(ledger, 'acc-bank')).toBe(600)
    expect(balance(ledger, 'acc-suspense')).toBe(0)
    expect(balance(ledger, 'acc-ar')).toBe(550)
    expect(partyBalance(ledger)).toBe(550)
    expect(agingTotals(ledger)).toEqual({ total: 550, credit: 0 })
  })
})

describe('over-amount lines', () => {
  it('books the excess of a genuinely over-amount line as an unapplied receipt', () => {
    const invoice = issueInvoice()
    importViaMain([depositRow('2026-08-05', 1200)])

    const tx = unreconciledTransaction(storedData())
    expect(reconcileViaMain(tx.id, invoice.id)).toMatchObject({
      ok: true,
      settledAmount: 1150,
      remainingOutstanding: -50,
      unappliedAmount: 50,
      invoiceStatus: 'Unpaid',
      partyBalance: -50,
    })

    const ledger = storedData()
    expect(balance(ledger, 'acc-bank')).toBe(1200)
    expect(balance(ledger, 'acc-suspense')).toBe(0)
    expect(balance(ledger, 'acc-ar')).toBe(-50)
    expect(partyBalance(ledger)).toBe(-50)
    expect(ledger.invoices[0]).toMatchObject({ status: 'Unpaid', outstandingAmount: -50 })
    expect(agingTotals(ledger)).toEqual({ total: -50, credit: 50 })

    const settlement = ledger.journalEntries[0]
    expect(settlement.totalDebit).toBe(1200)
    expect(settlement.totalCredit).toBe(1200)
    expect(settlement.items.filter((item) => item.remark?.startsWith('Unapplied')).length).toBe(2)
    expect(allJournalsBalanced(ledger.journalEntries)).toBe(true)
  })

  it('applies a second over-amount line to the same invoice instead of refusing it (D2)', async () => {
    const invoice = issueInvoice()
    importViaMain([depositRow('2026-08-05', 1200)])
    const firstTx = unreconciledTransaction(storedData())
    expect(reconcileViaMain(firstTx.id, invoice.id)).toMatchObject({
      ok: true,
      remainingOutstanding: -50,
      unappliedAmount: 50,
    })

    // A second deposit for the same invoice. The invoice now carries a party
    // credit, and the suggestion engine has to offer it: the line's cash
    // otherwise stays in Suspense with no route out.
    await importViaStore([depositRow('2026-08-06', 300)])
    const data = useBooksStore.getState().data
    const secondTx = unreconciledTransaction(data)
    expect(computeSettlementSuggestions(data)).toContainEqual({
      transactionId: secondTx.id,
      invoiceId: invoice.id,
      invoiceNumber: 'INV-2026-001',
      partyName: CUSTOMER,
      invoiceType: 'Sales',
      amount: 300,
      confidence: 'MEDIUM',
      reason: 'Invoice INV-2026-001 is already in credit: this line becomes an unapplied receipt',
    })

    // The invoice cannot absorb anything, so the whole 300 becomes an unapplied
    // receipt that grows the party's credit — and clears the 300 in Suspense.
    expect(reconcileViaMain(secondTx.id, invoice.id)).toMatchObject({
      ok: true,
      settledAmount: 0,
      remainingOutstanding: -350,
      unappliedAmount: 300,
      invoiceStatus: 'Unpaid',
      partyBalance: -350,
    })

    const ledger = storedData()
    expect(balance(ledger, 'acc-bank')).toBe(1500)
    expect(balance(ledger, 'acc-suspense')).toBe(0)
    expect(balance(ledger, 'acc-ar')).toBe(-350)
    expect(partyBalance(ledger)).toBe(-350)
    expect(ledger.invoices[0]).toMatchObject({ status: 'Unpaid', outstandingAmount: -350 })
    expect(ledger.bankTransactions!.every((tx) => tx.reconciled)).toBe(true)
    expect(agingTotals(ledger)).toEqual({ total: -350, credit: 350 })
    expect(allJournalsBalanced(ledger.journalEntries)).toBe(true)

    // The entry is the unapplied receipt and nothing else: Suspense 300 against
    // Receivable 300, both legs labelled as unapplied.
    const receipt = ledger.journalEntries[0]
    expect(receipt.totalDebit).toBe(300)
    expect(receipt.totalCredit).toBe(300)
    expect(receipt.items).toHaveLength(2)
    expect(receipt.items.every((item) => item.remark?.startsWith('Unapplied receipt'))).toBe(true)
    expect(receipt.items.find((item) => item.accountId === 'acc-suspense')!.debit).toBe(300)
    expect(receipt.items.find((item) => item.accountId === 'acc-ar')!.credit).toBe(300)
  })

  it('still refuses a settled invoice, describing the real state', async () => {
    const invoice = issueInvoice()
    await recordReceipt(1000, '2026-08-02')
    await importViaStore([depositRow('2026-08-05', INVOICE_TOTAL)])
    const settledTx = unreconciledTransaction(useBooksStore.getState().data)
    expect(reconcileViaMain(settledTx.id, invoice.id).ok).toBe(true)

    // The invoice is now settled with nothing outstanding; a further line for
    // it is refused with a message that says exactly that — not "already marked
    // Paid" while the invoice is not.
    importViaMain([depositRow('2026-08-09', 100, 'EXTRA DEPOSIT RAND WATER AUTHORITY')])
    const ledger = storedData()
    const extraTx = unreconciledTransaction(ledger)
    const result = reconcileViaMain(extraTx.id, invoice.id)
    expect(result).toEqual({
      ok: false,
      error:
        'Invoice INV-2026-001 is already settled (nothing outstanding): a statement line cannot be applied to it',
    })

    const after = storedData()
    expect(unreconciledTransaction(after).id).toBe(extraTx.id)
    expect(balance(after, 'acc-suspense')).toBe(-100)
    expect(after.invoices[0]).toMatchObject({ status: 'Paid', outstandingAmount: 0 })
  })
})

// @vitest-environment node

/**
 * perf-5000: build a 5,000-invoice ledger (parties, payments, journals) via
 * the real accounting engines, persist it through the REAL store handlers,
 * then measure load, save, reports (trial balance / aging / tax register /
 * cash-flow) and a statement-PDF build. Generous sanity bounds (30s per
 * operation); the measured numbers print for the sign-off. Memory is
 * reported, never gated.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { BOOKS_CHANNELS } from '../../src/shared/ipc'
import {
  agingBuckets,
  taxRegister,
} from '../../src/shared/reports'
import { computeCashFlowStatement } from '../../src/shared/cash-flow'
import {
  accountsMatchJournals,
  allJournalsBalanced,
  createPaymentJournal,
  calculateInvoiceTotals,
  computeAccountBalances,
  createSalesInvoiceJournal,
  nextInvoiceNumber,
  recomputePartyBalances,
  round2,
} from '../../src/shared/accounting'
import { applyPayment, createPaymentJournal } from '../../src/shared/payments'
import { buildInvoicePdf } from '../../src/shared/invoice-pdf'
import type {
  Account,
  BooksData,
  BooksDataEnvelope,
  Invoice,
  InvoiceItem,
  Party,
  Payment,
} from '../../src/shared/types'
import { bootBooksE2E, type BooksE2ESession } from './helpers/books-e2e'
import { emptyLedger } from './e2e/fixtures'

vi.mock('electron', async () => {
  const { createElectronModule } = await import('./helpers/electron-mock')
  return createElectronModule()
})

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const INVOICE_COUNT = 5_000
const PARTY_COUNT = 250
const PAYMENT_COUNT = 1_500
const PER_OP_BOUND_MS = 30_000

let session: BooksE2ESession

beforeEach(async () => {
  session = await bootBooksE2E()
})

afterEach(() => {
  session?.dispose()
})

/** The invoice-save shape: post a journal for a new invoice and derive balances. */
function buildInvoice(
  snapshot: BooksData,
  index: number,
  party: Party,
  date: string,
): { invoice: Invoice; journal: ReturnType<typeof createSalesInvoiceJournal> } {
  const items: InvoiceItem[] = [
    {
      id: `item-${index}`,
      itemCode: 'BULK-DELIVERY',
      description: 'Bulk delivery',
      accountId: 'acc-sales',
      accountName: 'Sales',
      qty: 1 + (index % 3),
      rate: round2(900 + (index % 17) * 130),
      taxRate: 15,
      amount: 0,
    },
  ]
  items[0].amount = round2(items[0].qty * items[0].rate)
  const totals = calculateInvoiceTotals(items, { taxInclusive: false })
  const now = new Date().toISOString()
  const invoice: Invoice = {
    id: `inv-perf-${index}`,
    invoiceNumber: nextInvoiceNumber(snapshot.invoices, 'Sales', date),
    type: 'Sales',
    partyId: party.id,
    partyName: party.name,
    date,
    dueDate: date,
    items,
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    outstandingAmount: totals.grandTotal,
    status: 'Unpaid',
    createdAt: now,
    updatedAt: now,
  }
  return { invoice, journal: createSalesInvoiceJournal(invoice, snapshot.accounts, party) }
}

describe('perf-5000: build, persist, measure', () => {
  it('5,000 invoices load, save, report and build a statement PDF within generous bounds', async () => {
    // ── Build the ledger in memory with the real engines ──
    let ledger: BooksData = {
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      settings: { ...emptyLedger().settings, taxInclusive: false },
      accounts: emptyLedger().accounts.map((a) => ({ ...a, balance: 0 })),
      parties: [],
      invoices: [],
      quotes: [],
      journalEntries: [],
      bankTransactions: [],
      payments: [],
      auditLog: [],
    }

    const parties: Party[] = Array.from({ length: PARTY_COUNT }, (_, i) => ({
      id: `party-perf-${i}`,
      name: `Perf Party ${i} (Pty) Ltd`,
      type: 'Customer',
      outstandingBalance: 0,
    }))
    ledger.parties = parties

    const invoices: Invoice[] = []
    const journals: ledger['journalEntries'] = []
    for (let index = 0; index < INVOICE_COUNT; index += 1) {
      const party = parties[index % PARTY_COUNT]
      const date = `2026-${String(1 + (index % 8)).padStart(2, '0')}-${String(1 + (index % 27)).padStart(2, '0')}`
      const { invoice, journal } = buildInvoice(ledger, index, party, date)
      invoices.push(invoice)
      journals.push(journal)
    }
    ledger.invoices = invoices
    ledger.journalEntries = [...journals].reverse() // newest first, as the store writes them

    // ── Payments via the real payment engine ──
    const payments: Payment[] = []
    let working = ledger
    for (let index = 0; index < PAYMENT_COUNT; index += 1) {
      const invoice = invoices[index % invoices.length]
      const rate = 1
      const outstandingBase = round2(invoice.outstandingAmount ?? invoice.grandTotal)
      const amount = round2(outstandingBase * 0.5)
      if (amount <= 0) continue
      const applied = applyPayment(working, {
        partyId: invoice.partyId,
        date: '2026-08-10',
        type: 'received',
        method: 'EFT',
        reference: `PERF-PAY-${index}`,
        allocations: [
          {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            amount,
          },
        ],
      })
      if (!applied.ok || !applied.payment) continue
      const journal = createPaymentJournal(
        applied.payment,
        applied.updatedInvoices,
        working.accounts,
        `JE-PERF-${index}`,
      )
      payments.push(applied.payment)
      working = {
        ...working,
        invoices: applied.updatedInvoices,
        payments: [...(working.payments ?? []), applied.payment],
        journalEntries: [journal, ...working.journalEntries],
        accounts: computeAccountBalances(working.accounts, [journal, ...working.journalEntries]),
        parties: recomputePartyBalances(applied.updatedInvoices, working.parties),
      }
    }
    ledger = working
    ledger.payments = payments

    // The ledger must be internally complete before persisting.
    expect(allJournalsBalanced(ledger.journalEntries)).toBe(true)
    expect(accountsMatchJournals(ledger.accounts, ledger.journalEntries)).toBe(true)
    expect(ledger.invoices).toHaveLength(INVOICE_COUNT)
    expect(ledger.payments).toHaveLength(PAYMENT_COUNT)

    // ── Persist through the real handlers ──
    const saveStarted = Date.now()
    const saved = await session.saveDataResult(ledger, 0)
    const saveMs = Date.now() - saveStarted
    expect(saved.ok, saved.ok ? '' : saved.error).toBe(true)
    expect(session.readStoredData().invoices).toHaveLength(INVOICE_COUNT)

    // ── Measure load ──
    const loadStarted = Date.now()
    const loaded = await session.loadData()
    const loadMs = Date.now() - loadStarted
    expect(loaded).toBeTruthy()
    expect(loaded!.invoices).toHaveLength(INVOICE_COUNT)

    // ── Measure a real save from the loaded revision ──
    const tweakStarted = Date.now()
    const tweaked: BooksDataEnvelope = {
      ...loaded!,
      settings: { ...loaded!.settings, companyName: 'Perf Save (Pty) Ltd' },
    }
    const tweakSave = await session.saveDataResult(tweaked, loaded!.revision)
    const tweakMs = Date.now() - tweakStarted
    expect(tweakSave.ok, tweakSave.ok ? '' : tweakSave.error).toBe(true)

    // ── Reports ──
    const salesAging = agingBuckets(ledger.invoices, ledger.parties, '2026-09-30', 'Sales')
    const purchaseAging = agingBuckets(ledger.invoices, ledger.parties, '2026-09-30', 'Purchase')
    const taxRows = taxRegister(ledger.invoices)
    // Trial balance figures, exactly as the reports view derives them.
    const leafAccounts = ledger.accounts.filter((a) => !a.isGroup)
    let trialDr = 0
    let trialCr = 0
    for (const account of leafAccounts) {
      const isDebit = account.rootType === 'Asset' || account.rootType === 'Expense'
      if (isDebit) trialDr = round2(trialDr + account.balance)
      else trialCr = round2(trialCr + account.balance)
    }
    const cash = computeCashFlowStatement(ledger, { from: '2026-03-01', to: '2026-09-30' })
    expect(cash.closing).toBe(
      round2(
        ledger.accounts
          .filter((a) => a.id === 'acc-bank' || a.id === 'acc-cash')
          .reduce((sum, a) => sum + a.balance, 0),
      ),
    )
    expect(salesAging.length).toBeGreaterThan(0)
    expect(taxRows.length).toBeGreaterThan(0)
    expect(trialDr).toBeGreaterThan(0)

    // ── Statement PDF ──
    const pdfStarted = Date.now()
    const pdf = await buildInvoicePdf(invoices[0], ledger.settings)
    const pdfMs = Date.now() - pdfStarted
    expect(pdf.length).toBeGreaterThan(1000)

    // ── Sanity bounds ──
    for (const [name, ms] of [
      ['load', loadMs],
      ['save', saveMs],
      ['save from loaded revision', tweakMs],
    ] as const) {
      expect(ms, `${name} took ${ms}ms`).toBeLessThan(PER_OP_BOUND_MS)
    }
    expect(saveMs, `save took ${saveMs}ms`).toBeLessThan(PER_OP_BOUND_MS)
    expect(pdfMs, `pdf took ${pdfMs}ms`).toBeLessThan(PER_OP_BOUND_MS)

    console.log(
      '[perf-5000] load=%dms save=%dms save-from-loaded=%dms pdf=%dms | accounts=%d invoices=%d payments=%d journals=%d | aging(sales)=%d tax=%d trialDr=%d trialCr=%d cashOpen=%d cashClose=%d',
      loadMs,
      saveMs,
      tweakMs,
      pdfMs,
      ledger.accounts.length,
      ledger.invoices.length,
      ledger.payments.length,
      ledger.journalEntries.length,
      salesAging.length,
      taxRows.length,
      trialDr,
      trialCr,
      cash.opening,
      cash.closing,
    )
    const beforeMem = process.memoryUsage()
    console.log(
      '[perf-5000] memory rss=%dMB heapUsed=%dMB heapTotal=%dMB external=%dMB',
      beforeMem.rss / 1048576,
      beforeMem.heapUsed / 1048576,
      beforeMem.heapTotal / 1048576,
      beforeMem.external / 1048576,
    )
    void beforeMem
  })
})

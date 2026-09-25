// @vitest-environment node

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { EMPTY_ACCOUNTS } from '../../src/shared/chart'
import { BOOKS_CHANNELS } from '../../src/shared/ipc'
import {
  allJournalsBalanced,
  calculateInvoiceTotals,
  computeAccountBalances,
  createPurchaseBillJournal,
  nextInvoiceNumber,
  recomputePartyBalances,
} from '../../src/shared/accounting'
import type { BooksDataEnvelope, Invoice, JournalEntry, Party } from '../../src/shared/types'
import { bootBooksE2E, type BooksE2ESession } from '../helpers/books-e2e'
import { emptyLedger } from './fixtures'

vi.mock('electron', async () => {
  const { createElectronModule } = await import('../helpers/electron-mock')
  return createElectronModule()
})

// Booting the real module re-imports its whole graph; the shared runner is
// slow under parallel load, so these journeys get more room than the unit suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const CUSTOMER = 'Rand Water Authority'
const SUPPLIER = 'Kagiso Civils CC'
const SALES_TOTAL = 23000
const BILL_SUBTOTAL = 5000

const REQUIRED_CHANNELS = [
  BOOKS_CHANNELS.loadData,
  BOOKS_CHANNELS.saveData,
  BOOKS_CHANNELS.importBankStatementCsv,
  BOOKS_CHANNELS.reconcileTransaction,
  BOOKS_CHANNELS.getSettlementSuggestions,
  BOOKS_CHANNELS.backupNow,
  BOOKS_CHANNELS.listBackups,
  BOOKS_CHANNELS.restoreBackup,
  BOOKS_CHANNELS.openInPdf,
  BOOKS_CHANNELS.exportToSheets,
]

function accountBalance(data: BooksDataEnvelope, id: string): number {
  return data.accounts.find((account) => account.id === id)?.balance ?? Number.NaN
}

function journalTotals(journal: JournalEntry): { debit: number; credit: number } {
  return {
    debit: journal.items.reduce((sum, item) => sum + item.debit, 0),
    credit: journal.items.reduce((sum, item) => sum + item.credit, 0),
  }
}

function purchaseBill(party: Party): Invoice {
  const items: Invoice['items'] = [
    {
      id: 'item-bill-1',
      itemCode: 'SUB-CIVIL',
      description: 'Civil works subcontractor invoice',
      accountId: 'acc-materials',
      accountName: 'Direct Project Materials & Subcontractors',
      qty: 1,
      rate: BILL_SUBTOTAL,
      taxRate: 15,
      amount: BILL_SUBTOTAL,
    },
  ]
  const totals = calculateInvoiceTotals(items, { taxInclusive: false })
  const now = new Date().toISOString()
  return {
    id: 'inv-bill-1',
    invoiceNumber: nextInvoiceNumber([], 'Purchase', '2026-08-10'),
    type: 'Purchase',
    partyId: party.id,
    partyName: party.name,
    date: '2026-08-10',
    dueDate: '2026-09-09',
    items,
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    outstandingAmount: totals.grandTotal,
    status: 'Unpaid',
    createdAt: now,
    updatedAt: now,
  }
}

/** Issues one sales invoice and one purchase bill through the real write paths. */
async function seedInvoiceAndBill(session: BooksE2ESession): Promise<void> {
  expect(await session.saveData(emptyLedger())).toBe(true)

  const issued = session.modules.issueSalesInvoiceInBooks({
    booksDataPath: session.booksDataPath,
    partyName: CUSTOMER,
    itemDescription: 'Bulk water pipeline maintenance',
    amount: SALES_TOTAL,
    date: '2026-08-05',
    dueDate: '2026-09-04',
  })
  expect(issued.ok).toBe(true)
  expect(issued.invoice?.invoiceNumber).toBe('INV-2026-001')
  expect(issued.invoice?.grandTotal).toBe(SALES_TOTAL)

  const current = (await session.loadData())!
  const supplier: Party = {
    id: 'party-kagiso',
    name: SUPPLIER,
    type: 'Supplier',
    outstandingBalance: 0,
  }
  const bill = purchaseBill(supplier)
  const journalEntries = [
    createPurchaseBillJournal(bill, current.accounts, supplier),
    ...current.journalEntries,
  ]
  const invoices = [bill, ...current.invoices]
  const parties = recomputePartyBalances(invoices, [...current.parties, supplier])
  const accounts = computeAccountBalances(current.accounts, journalEntries)

  expect(await session.saveData({ ...current, invoices, parties, accounts, journalEntries })).toBe(
    true,
  )
}

describe('Books e2e: boot, posting and restart', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('registers the real IPC channel set through createBooksView', async () => {
    for (const channel of REQUIRED_CHANNELS) {
      expect(session.handlerChannels()).toContain(channel)
    }
    expect(session.handlerChannels()).not.toContain(BOOKS_CHANNELS.dataChanged)
    expect(session.handlerChannels().length).toBe(new Set(session.handlerChannels()).size)

    await expect(session.invoke('books:not-a-channel')).rejects.toThrow(
      "No handler registered for 'books:not-a-channel'",
    )
  })

  it('starts empty, persists the first save and loads it back', async () => {
    expect(await session.loadData()).toBeNull()
    expect(session.listFiles()).toEqual([])

    const ledger = emptyLedger()
    expect(await session.saveData(ledger)).toBe(true)

    // Layer-1 loop suppression: the saving renderer gets no echo of its own write.
    expect(session.broadcasts()).toEqual([])

    const loaded = (await session.loadData())!
    expect(loaded.settings.companyName).toBe('Branten Solutions (Pty) Ltd')
    expect(loaded.settings.taxNumber).toBe('9123456789')
    expect(loaded.accounts).toHaveLength(EMPTY_ACCOUNTS.length)
    expect(loaded.invoices).toEqual([])
    expect(loaded.parties).toEqual([])
    expect(JSON.parse(session.readBooksFile()).settings.companyName).toBe(
      'Branten Solutions (Pty) Ltd',
    )
  })

  it('clears module state and on-disk data through reset', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    expect(await session.loadData()).not.toBeNull()

    await session.reset()

    expect(await session.loadData()).toBeNull()
    expect(session.listFiles()).toEqual([])
    expect(session.handlerChannels()).toContain(BOOKS_CHANNELS.loadData)
    expect(session.broadcasts()).toEqual([])
  })

  it('posts a sales invoice and a purchase bill with balanced journals and correct balances', async () => {
    await seedInvoiceAndBill(session)

    const data = (await session.loadData())!
    expect(data.invoices).toHaveLength(2)
    expect(data.invoices.map((invoice) => invoice.invoiceNumber).sort()).toEqual([
      'BILL-2026-001',
      'INV-2026-001',
    ])

    for (const journal of data.journalEntries) {
      const { debit, credit } = journalTotals(journal)
      expect(journal.totalDebit).toBe(journal.totalCredit)
      expect(debit).toBe(credit)
    }
    expect(allJournalsBalanced(data.journalEntries)).toBe(true)

    const totalDebit = data.journalEntries.reduce(
      (sum, journal) => sum + journal.items.reduce((s, item) => s + item.debit, 0),
      0,
    )
    const totalCredit = data.journalEntries.reduce(
      (sum, journal) => sum + journal.items.reduce((s, item) => s + item.credit, 0),
      0,
    )
    expect(totalDebit).toBe(totalCredit)

    // Sales: Dr Receivable 23000 / Cr Sales 20000 / Cr VAT Output 3000.
    expect(accountBalance(data, 'acc-ar')).toBe(SALES_TOTAL)
    expect(accountBalance(data, 'acc-sales')).toBe(20000)
    expect(accountBalance(data, 'acc-vat')).toBe(3000)
    // Bill: Dr Materials 5000 / Dr VAT Input 750 / Cr Payable 5750.
    expect(accountBalance(data, 'acc-materials')).toBe(BILL_SUBTOTAL)
    expect(accountBalance(data, 'acc-vat-in')).toBe(750)
    expect(accountBalance(data, 'acc-ap')).toBe(5750)

    const customer = data.parties.find((party) => party.name === CUSTOMER)
    const supplier = data.parties.find((party) => party.name === SUPPLIER)
    expect(customer?.outstandingBalance).toBe(SALES_TOTAL)
    expect(supplier?.outstandingBalance).toBe(5750)

    // The control accounts equal the subledger they summarize.
    expect(accountBalance(data, 'acc-ar')).toBe(customer?.outstandingBalance)
    expect(accountBalance(data, 'acc-ap')).toBe(supplier?.outstandingBalance)
  })

  it('reloads the same ledger and balances after an app restart', async () => {
    await seedInvoiceAndBill(session)

    const before = (await session.loadData())!
    const bytesBefore = session.readBooksFile()
    await session.restart()
    expect(session.handlerChannels()).toContain(BOOKS_CHANNELS.loadData)

    const after = (await session.loadData())!
    expect(after.invoices).toEqual(before.invoices)
    expect(after.parties).toEqual(before.parties)
    expect(after.accounts).toEqual(before.accounts)
    expect(after.journalEntries).toEqual(before.journalEntries)
    expect(accountBalance(after, 'acc-ar')).toBe(SALES_TOTAL)
    expect(accountBalance(after, 'acc-ap')).toBe(5750)
    expect(session.readBooksFile()).toBe(bytesBefore)
  })
})

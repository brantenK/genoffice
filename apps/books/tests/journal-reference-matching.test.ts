import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountsMatchJournals, computeAccountBalances, round2 } from '../src/shared/accounting'
import { CORE_ACCOUNTS } from '../src/shared/chart'
import { reversalJournalRemoval } from '../src/shared/credit-notes'
import { applyLoadedEnvelope, useBooksStore } from '../src/renderer/src/store'
import type { BooksData, Invoice, JournalEntry, Party } from '../src/shared/types'

/**
 * Journals are matched to invoices and payments by a reference marker in the
 * entry or item remarks. That match must be a whole reference: a ledger that
 * holds INV-2026-001 next to INV-2026-0011 must not lose the neighbour's
 * posting when one invoice is edited, deleted or collected.
 */
const INVOICE = 'INV-2026-001'
const NEIGHBOUR = 'INV-2026-0011'

function salesInvoice(id: string, invoiceNumber: string, amount: number): Invoice {
  const taxTotal = round2(amount * 0.15)
  return {
    id,
    invoiceNumber,
    type: 'Sales',
    partyId: 'party-1',
    partyName: 'Reference Customer',
    date: '2026-09-01',
    dueDate: '2026-10-01',
    items: [
      {
        id: `${id}-item`,
        description: 'Works',
        qty: 1,
        rate: amount,
        taxRate: 15,
        amount,
        accountId: 'acc-sales',
      },
    ],
    subtotal: amount,
    taxTotal,
    grandTotal: round2(amount + taxTotal),
    outstandingAmount: round2(amount + taxTotal),
    status: 'Unpaid',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

function postingJournal(invoice: Invoice): JournalEntry {
  const tax = round2(invoice.taxTotal)
  const net = round2(invoice.grandTotal - tax)
  return {
    id: `je-${invoice.id}`,
    entryNumber: `JE-${invoice.invoiceNumber}`,
    date: invoice.date,
    items: [
      {
        id: `je-${invoice.id}-ar`,
        accountId: 'acc-ar',
        accountName: 'Accounts Receivable (Debtors)',
        partyId: invoice.partyId,
        partyName: invoice.partyName,
        debit: invoice.grandTotal,
        credit: 0,
        remark: `Invoice ${invoice.invoiceNumber}`,
      },
      {
        id: `je-${invoice.id}-income`,
        accountId: 'acc-sales',
        accountName: 'Sales',
        debit: 0,
        credit: net,
        remark: `Sales Revenue - ${invoice.invoiceNumber}`,
      },
      {
        id: `je-${invoice.id}-vat`,
        accountId: 'acc-vat',
        accountName: 'SARS VAT Output Payable',
        debit: 0,
        credit: tax,
        remark: `15% VAT Output`,
      },
    ],
    totalDebit: invoice.grandTotal,
    totalCredit: invoice.grandTotal,
    remarks: `System sales invoice posting for ${invoice.invoiceNumber}`,
    posted: true,
  }
}

const party: Party = {
  id: 'party-1',
  name: 'Reference Customer',
  type: 'Customer',
  email: '',
  outstandingBalance: 0,
}

function ledgerWithPrefixPair(): BooksData {
  const invoices = [salesInvoice('inv-1', INVOICE, 10000), salesInvoice('inv-11', NEIGHBOUR, 2000)]
  const journalEntries = invoices.map(postingJournal)
  return {
    settings: {
      companyName: 'Reference Co',
      currency: 'ZAR',
      currencySymbol: 'R',
      financialYearStart: '2026-03-01',
      defaultTaxRate: 15,
      taxInclusive: false,
      closedThrough: '',
    },
    accounts: computeAccountBalances(CORE_ACCOUNTS, journalEntries),
    parties: [party],
    invoices,
    journalEntries,
    bankTransactions: [],
    payments: [],
    auditLog: [],
  }
}

const readState = () => useBooksStore.getState()

describe('Journal references are matched whole, never as a substring', () => {
  beforeEach(() => {
    useBooksStore.setState({
      activeTab: 'dashboard',
      activeInvoiceId: null,
      needsSetup: false,
      loadError: false,
      lastError: null,
      invoiceStatusFilter: 'All',
      activeReport: 'profit-loss',
      printInvoice: null,
      searchTerm: '',
    })
  })

  afterEach(() => {
    useBooksStore.setState({ data: undefined as unknown as BooksData })
  })

  it('reversalJournalRemoval keeps the journals of a number that merely starts the same', () => {
    const journals = [
      postingJournal(salesInvoice('a', INVOICE, 100)),
      postingJournal(salesInvoice('b', NEIGHBOUR, 200)),
    ]
    const remaining = reversalJournalRemoval(INVOICE, journals)

    expect(remaining).toHaveLength(1)
    expect(remaining[0].remarks).toContain(NEIGHBOUR)
  })

  it('deleteInvoice leaves the neighbour invoice posted and the ledger agreeing', () => {
    const ledger = ledgerWithPrefixPair()
    applyLoadedEnvelope({
      ...ledger,
      version: 1,
      revision: 1,
      updatedAt: '2026-09-24T08:00:00.000Z',
    })

    readState().deleteInvoice('inv-1')

    const after = readState().data
    expect(after.invoices.map((i) => i.invoiceNumber)).toEqual([NEIGHBOUR])
    expect(after.journalEntries).toHaveLength(1)
    expect(after.journalEntries[0].remarks).toContain(NEIGHBOUR)
    expect(accountsMatchJournals(after.accounts, after.journalEntries)).toBe(true)
    expect(after.accounts.find((a) => a.id === 'acc-ar')!.balance).toBe(2300)
  })

  it('deleteInvoice still reverses the target invoice it was asked about', () => {
    const ledger = ledgerWithPrefixPair()
    applyLoadedEnvelope({
      ...ledger,
      version: 1,
      revision: 1,
      updatedAt: '2026-09-24T08:00:00.000Z',
    })

    readState().deleteInvoice('inv-11')

    const after = readState().data
    expect(after.invoices.map((i) => i.invoiceNumber)).toEqual([INVOICE])
    expect(after.journalEntries).toHaveLength(1)
    expect(after.journalEntries[0].remarks).toContain(INVOICE)
    expect(accountsMatchJournals(after.accounts, after.journalEntries)).toBe(true)
  })
})

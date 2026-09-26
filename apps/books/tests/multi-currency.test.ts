// Multi-currency Stage A: base-currency conversion in the money core.
//
// The ledger of record is denominated in the company's base currency
// (settings.currency). An invoice may carry its own currency and an
// exchangeRate — how many base-currency units one invoice-currency unit buys
// — while its own totals stay in ITS currency. Every money-touching ledger
// figure (journal legs, tax register, party and account balances, payment
// allocations, aging) is base, converted at the invoice's rate. A ledger
// whose invoices carry no currency fields settles everything at rate 1: it
// must behave exactly as it did before this stage.
import { describe, expect, it } from 'vitest'
import {
  allJournalsBalanced,
  computeAccountBalances,
  createPurchaseBillJournal,
  createSalesInvoiceJournal,
  recomputePartyBalances,
} from '../src/shared/accounting'
import { applyPayment, createPaymentJournal } from '../src/shared/payments'
import { agingBuckets, taxRegister } from '../src/shared/reports'
import { createCreditNoteJournal } from '../src/shared/credit-notes'
import { applyReconciliation, computeSettlementSuggestions } from '../src/shared/settlement'
import { migrateAndValidateBooks } from '../src/main/books-core'
import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../src/shared/chart'
import type {
  Account,
  BooksData,
  Invoice,
  InvoiceItem,
  JournalEntry,
  Party,
} from '../src/shared/types'

const accounts: Account[] = EMPTY_ACCOUNTS.map((a) => ({ ...a, balance: 0 }))

const customer: Party = {
  id: 'party-1',
  name: 'Delta Trading',
  type: 'Customer',
  outstandingBalance: 0,
}

const item = (over: Partial<InvoiceItem> = {}): InvoiceItem => ({
  id: 'it-1',
  itemCode: 'ITEM-1',
  description: 'Consulting',
  accountId: 'acc-sales',
  accountName: 'Consulting Revenue',
  qty: 1,
  rate: 1000,
  taxRate: 15,
  amount: 1000,
  ...over,
})

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: 'inv-1',
  invoiceNumber: 'INV-2026-001',
  type: 'Sales',
  partyId: 'party-1',
  partyName: 'Delta Trading',
  date: '2026-09-01',
  dueDate: '2026-10-01',
  items: [item()],
  subtotal: 10000,
  taxTotal: 1500,
  grandTotal: 11500,
  outstandingAmount: 11500,
  status: 'Unpaid',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
  ...over,
})

const ledger = (over: Partial<BooksData> = {}): BooksData => ({
  version: 1,
  settings: { ...DEFAULT_BOOK_SETTINGS },
  accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
  parties: [customer],
  invoices: [],
  journalEntries: [],
  bankTransactions: [],
  payments: [],
  ...over,
})

/** The posting legs of an entry, sorted, zero legs dropped — for leg-shape equality. */
const legs = (je: JournalEntry) =>
  je.items
    .map((it) => ({ accountId: it.accountId, debit: it.debit, credit: it.credit }))
    .filter((l) => l.debit !== 0 || l.credit !== 0)
    .sort(
      (a, b) => a.accountId.localeCompare(b.accountId) || a.debit - b.debit || a.credit - b.credit,
    )

const balanceOf = (derived: Account[], id: string): number =>
  derived.find((a) => a.id === id)?.balance ?? 0

const findByNumber = (invoices: Invoice[], invoiceNumber: string): Invoice => {
  const found = invoices.find((inv) => inv.invoiceNumber === invoiceNumber)
  if (!found) throw new Error(`invoice ${invoiceNumber} not found`)
  return found
}

describe('multi-currency: ledgers without currency fields are unchanged (rate 1)', () => {
  // Hand-computed ZAR case: 10 000 subtotal, 15% VAT = 1 500, grand 11 500.
  const zarInvoice = invoice()

  it('posts the same journal legs as an invoice stamped with an explicit rate 1', () => {
    const bare = createSalesInvoiceJournal(zarInvoice, accounts, customer)
    const stamped = createSalesInvoiceJournal(
      { ...zarInvoice, currency: 'ZAR', exchangeRate: 1 },
      accounts,
      customer,
    )
    expect(legs(bare)).toEqual(legs(stamped))
  })

  it('posts the hand-computed ZAR journal', () => {
    const je = createSalesInvoiceJournal(zarInvoice, accounts, customer)
    expect(allJournalsBalanced([je])).toBe(true)
    expect(je.totalDebit).toBe(11500)
    expect(je.totalCredit).toBe(11500)
    expect(legs(je)).toEqual([
      { accountId: 'acc-ar', debit: 11500, credit: 0 },
      { accountId: 'acc-sales', debit: 0, credit: 10000 },
      { accountId: 'acc-vat', debit: 0, credit: 1500 },
    ])
  })

  it('settles, ages and registers VAT exactly as before', () => {
    const openJournal = createSalesInvoiceJournal(zarInvoice, accounts, customer)
    const openLedger = ledger({ invoices: [zarInvoice], journalEntries: [openJournal] })

    // Aging before payment: the whole open balance, in the current bucket.
    expect(agingBuckets(openLedger.invoices, openLedger.parties, '2026-09-15', 'Sales')).toEqual([
      {
        partyId: 'party-1',
        partyName: 'Delta Trading',
        current: 11500,
        days30: 0,
        days60: 0,
        days90: 0,
        credit: 0,
        total: 11500,
      },
    ])

    // Tax register: 10 000 taxable, 1 500 VAT.
    const register = taxRegister(openLedger.invoices)
    expect(register[0]).toMatchObject({ taxRate: 15, salesTaxable: 10000, salesTax: 1500 })
    expect(register[register.length - 1]).toMatchObject({
      taxRate: null,
      salesTaxable: 10000,
      salesTax: 1500,
    })

    // Payment of the full 11 500 settles it.
    const result = applyPayment(openLedger, {
      partyId: 'party-1',
      date: '2026-09-20',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 11500 }],
    })
    expect(result.ok).toBe(true)
    const paid = findByNumber(result.updatedInvoices!, 'INV-2026-001')
    expect(paid.outstandingAmount).toBe(0)
    expect(paid.status).toBe('Paid')

    const paymentJournal = createPaymentJournal(result.payment!, openLedger.invoices, accounts)
    const settled = computeAccountBalances(openLedger.accounts, [openJournal, paymentJournal])
    expect(balanceOf(settled, 'acc-ar')).toBe(0)
    expect(balanceOf(settled, 'acc-bank')).toBe(11500)

    // Aging and party balance clear after settlement.
    expect(
      agingBuckets(result.updatedInvoices!, openLedger.parties, '2026-09-15', 'Sales'),
    ).toEqual([])
    const party = recomputePartyBalances(result.updatedInvoices!, openLedger.parties)[0]
    expect(party.outstandingBalance).toBe(0)
  })
})

describe('multi-currency: an EUR invoice at rate 20 posts and reports in ZAR (base)', () => {
  // EUR 5 000 subtotal, 15% VAT = EUR 750, grand EUR 5 750.
  // Base: 100 000 subtotal, 15 000 VAT, 115 000 receivable.
  const eurInvoice = invoice({
    id: 'inv-eur',
    invoiceNumber: 'INV-2026-002',
    items: [item({ qty: 5, rate: 1000, amount: 5000 })],
    subtotal: 5000,
    taxTotal: 750,
    grandTotal: 5750,
    outstandingAmount: 5750,
    currency: 'EUR',
    exchangeRate: 20,
  })

  it('posts ×20 legs that balance, with AR = grandTotal × 20', () => {
    const je = createSalesInvoiceJournal(eurInvoice, accounts, customer)
    expect(allJournalsBalanced([je])).toBe(true)
    expect(je.totalDebit).toBe(115000)
    expect(je.totalCredit).toBe(115000)
    expect(legs(je)).toEqual([
      { accountId: 'acc-ar', debit: 115000, credit: 0 },
      { accountId: 'acc-sales', debit: 0, credit: 100000 },
      { accountId: 'acc-vat', debit: 0, credit: 15000 },
    ])
    // The AR control leg anchors on the stored grandTotal, converted.
    expect(5750 * 20).toBe(115000)

    const derived = computeAccountBalances(accounts, [je])
    expect(balanceOf(derived, 'acc-ar')).toBe(115000)
    expect(balanceOf(derived, 'acc-sales')).toBe(100000)
    expect(balanceOf(derived, 'acc-vat')).toBe(15000)
  })

  it('mirrors the purchase side: AP = grandTotal × 20, VAT input in base', () => {
    const bill = invoice({
      id: 'bill-eur',
      invoiceNumber: 'BILL-2026-001',
      type: 'Purchase',
      items: [
        item({
          qty: 2,
          rate: 1000,
          amount: 2000,
          accountId: 'acc-materials',
          accountName: 'Materials',
        }),
      ],
      subtotal: 2000,
      taxTotal: 300,
      grandTotal: 2300,
      outstandingAmount: 2300,
      currency: 'EUR',
      exchangeRate: 20,
    })
    const je = createPurchaseBillJournal(bill, accounts, customer)
    expect(allJournalsBalanced([je])).toBe(true)
    expect(legs(je)).toEqual([
      { accountId: 'acc-ap', debit: 0, credit: 46000 },
      { accountId: 'acc-materials', debit: 40000, credit: 0 },
      { accountId: 'acc-vat-in', debit: 6000, credit: 0 },
    ])
  })

  it('taxRegister, aging and party balance are base-currency', () => {
    const ledgerData = ledger({
      invoices: [eurInvoice],
      journalEntries: [createSalesInvoiceJournal(eurInvoice, accounts, customer)],
    })

    // VAT on the base value: 100 000 × 15% = 15 000.
    const register = taxRegister(ledgerData.invoices)
    expect(register[0]).toMatchObject({ taxRate: 15, salesTaxable: 100000, salesTax: 15000 })
    expect(register[register.length - 1]).toMatchObject({
      taxRate: null,
      salesTaxable: 100000,
      salesTax: 15000,
    })

    // EUR 5 750 outstanding is 115 000 base, in the 1-30 day bucket
    // (dueDate 2026-10-01, asOf 2026-10-15 → 14 days overdue).
    const aging = agingBuckets(ledgerData.invoices, ledgerData.parties, '2026-10-15', 'Sales')
    expect(aging).toHaveLength(1)
    expect(aging[0].days30).toBe(115000)
    expect(aging[0].total).toBe(115000)

    const party = recomputePartyBalances(ledgerData.invoices, ledgerData.parties)[0]
    expect(party.outstandingBalance).toBe(115000)
  })
})

describe('multi-currency: migration stamps and repairs currency fields', () => {
  it('stamps absent/blank fields from settings.currency and repairs invalid rates', () => {
    const migrated = migrateAndValidateBooks({
      version: 1,
      revision: 0,
      updatedAt: '2026-09-01T08:00:00.000Z',
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
      parties: [],
      invoices: [
        invoice({ id: 'inv-a' }), // nothing set
        invoice({ id: 'inv-b', currency: 'EUR', exchangeRate: 20 }), // valid, preserved
        invoice({ id: 'inv-c', exchangeRate: 0 }), // invalid rate
        invoice({ id: 'inv-d', exchangeRate: -5 }), // invalid rate
        invoice({ id: 'inv-e', exchangeRate: Number.NaN }), // invalid rate
        invoice({ id: 'inv-f', currency: '   ' }), // blank currency
        invoice({ id: 'inv-g', currency: '  EUR ', exchangeRate: 12.5 }), // trimmed, preserved
      ],
      journalEntries: [],
    })

    const invs = migrated.invoices
    expect(invs[0].currency).toBe('ZAR')
    expect(invs[0].exchangeRate).toBe(1)

    expect(invs[1].currency).toBe('EUR')
    expect(invs[1].exchangeRate).toBe(20)

    expect(invs[2].exchangeRate).toBe(1)
    expect(invs[3].exchangeRate).toBe(1)
    expect(invs[4].exchangeRate).toBe(1)

    expect(invs[5].currency).toBe('ZAR')
    expect(invs[5].exchangeRate).toBe(1)

    expect(invs[6].currency).toBe('EUR')
    expect(invs[6].exchangeRate).toBe(12.5)
  })

  it('stamps from a non-ZAR base currency and keeps the rest of the invoice intact', () => {
    const migrated = migrateAndValidateBooks({
      version: 1,
      revision: 0,
      updatedAt: '2026-09-01T08:00:00.000Z',
      settings: { ...DEFAULT_BOOK_SETTINGS, currency: 'USD', currencySymbol: '$' },
      accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
      parties: [],
      invoices: [invoice({ id: 'inv-a', grandTotal: 11500, outstandingAmount: 11500 })],
      journalEntries: [],
    })
    expect(migrated.invoices[0].currency).toBe('USD')
    expect(migrated.invoices[0].exchangeRate).toBe(1)
    expect(migrated.invoices[0].grandTotal).toBe(11500)
  })
})

describe('multi-currency: a base-currency payment settles a foreign invoice', () => {
  // EUR 100 grand total at rate 20 = 2 000 ZAR of receivable.
  const eur100 = invoice({
    id: 'inv-eur100',
    invoiceNumber: 'INV-2026-100',
    items: [item({ rate: 100, amount: 100, taxRate: 0 })],
    subtotal: 100,
    taxTotal: 0,
    grandTotal: 100,
    outstandingAmount: 100,
    currency: 'EUR',
    exchangeRate: 20,
  })

  it('needs exactly 2 000 base to reach Paid', () => {
    const data = ledger({ invoices: [eur100] })

    const exact = applyPayment(data, {
      partyId: 'party-1',
      date: '2026-09-10',
      allocations: [{ invoiceId: 'inv-eur100', invoiceNumber: 'INV-2026-100', amount: 2000 }],
    })
    expect(exact.ok).toBe(true)
    expect(exact.payment!.total).toBe(2000)
    const settled = findByNumber(exact.updatedInvoices!, 'INV-2026-100')
    expect(settled.outstandingAmount).toBe(0)
    expect(settled.status).toBe('Paid')

    // One cent over the converted outstanding is refused.
    const tooMuch = applyPayment(data, {
      partyId: 'party-1',
      date: '2026-09-10',
      allocations: [{ invoiceId: 'inv-eur100', invoiceNumber: 'INV-2026-100', amount: 2000.01 }],
    })
    expect(tooMuch.ok).toBe(false)
    expect(tooMuch.error).toMatch(/exceeds outstanding 2000/)
  })

  it('writes the remainder back in the invoice currency on a partial payment', () => {
    const data = ledger({ invoices: [eur100] })
    const result = applyPayment(data, {
      partyId: 'party-1',
      date: '2026-09-10',
      allocations: [{ invoiceId: 'inv-eur100', invoiceNumber: 'INV-2026-100', amount: 1000 }],
    })
    expect(result.ok).toBe(true)
    const partial = findByNumber(result.updatedInvoices!, 'INV-2026-100')
    // Base remainder 2 000 − 1 000 = 1 000 → EUR 1 000 / 20 = 50.
    expect(partial.outstandingAmount).toBe(50)
    expect(partial.status).toBe('Unpaid')
    // The party balance reads the BASE remainder: 50 EUR × 20.
    const party = recomputePartyBalances(result.updatedInvoices!, data.parties)[0]
    expect(party.outstandingBalance).toBe(1000)

    // The second half in base settles it.
    const second = applyPayment(ledger({ invoices: [partial] }), {
      partyId: 'party-1',
      date: '2026-09-12',
      allocations: [{ invoiceId: 'inv-eur100', invoiceNumber: 'INV-2026-100', amount: 1000 }],
    })
    expect(second.ok).toBe(true)
    const paid = findByNumber(second.updatedInvoices!, 'INV-2026-100')
    expect(paid.outstandingAmount).toBe(0)
    expect(paid.status).toBe('Paid')
  })

  it('posts the payment journal in base and nets AR to zero', () => {
    const data = ledger({ invoices: [eur100] })
    const invoiceJournal = createSalesInvoiceJournal(eur100, accounts, customer)
    const result = applyPayment(data, {
      partyId: 'party-1',
      date: '2026-09-10',
      allocations: [{ invoiceId: 'inv-eur100', invoiceNumber: 'INV-2026-100', amount: 2000 }],
    })
    expect(result.ok).toBe(true)
    const paymentJournal = createPaymentJournal(result.payment!, data.invoices, accounts)
    expect(allJournalsBalanced([invoiceJournal, paymentJournal])).toBe(true)
    expect(paymentJournal.totalDebit).toBe(2000)

    const derived = computeAccountBalances(accounts, [invoiceJournal, paymentJournal])
    expect(balanceOf(derived, 'acc-ar')).toBe(0)
    expect(balanceOf(derived, 'acc-bank')).toBe(2000)
  })
})

describe('multi-currency: invoice + full credit note nets every account to zero', () => {
  it('cancels the EUR posting account by account', () => {
    const eurInvoice = invoice({
      id: 'inv-eur',
      invoiceNumber: 'INV-2026-002',
      items: [item({ qty: 5, rate: 1000, amount: 5000 })],
      subtotal: 5000,
      taxTotal: 750,
      grandTotal: 5750,
      outstandingAmount: 5750,
      currency: 'EUR',
      exchangeRate: 20,
    })
    const creditNote = invoice({
      id: 'cn-eur',
      invoiceNumber: 'CN-2026-001',
      creditNote: true,
      creditedInvoiceId: 'inv-eur',
      items: [item({ qty: 5, rate: 1000, amount: 5000 })],
      subtotal: 5000,
      taxTotal: 750,
      grandTotal: 5750,
      outstandingAmount: -5750,
      currency: 'EUR',
      exchangeRate: 20,
      status: 'Unpaid',
    })

    const invoiceJournal = createSalesInvoiceJournal(eurInvoice, accounts, customer)
    const creditJournal = createCreditNoteJournal(creditNote, accounts, customer)
    expect(allJournalsBalanced([invoiceJournal, creditJournal])).toBe(true)
    expect(creditJournal.totalDebit).toBe(115000)
    expect(creditJournal.totalCredit).toBe(115000)
    expect(legs(creditJournal)).toEqual([
      { accountId: 'acc-ar', debit: 0, credit: 115000 },
      { accountId: 'acc-sales', debit: 100000, credit: 0 },
      { accountId: 'acc-vat', debit: 15000, credit: 0 },
    ])

    // Every account the pair touches nets to zero.
    const derived = computeAccountBalances(accounts, [invoiceJournal, creditJournal])
    for (const id of ['acc-ar', 'acc-sales', 'acc-vat']) {
      expect(balanceOf(derived, id)).toBe(0)
    }
  })
})

describe('multi-currency: a mixed-currency ledger sums party balance and AR in base', () => {
  it('ZAR + EUR invoices for one party', () => {
    const zarInvoice = invoice({ dueDate: '2026-08-01' }) // 75 days overdue at asOf → days90
    const eurInvoice = invoice({
      id: 'inv-eur',
      invoiceNumber: 'INV-2026-002',
      items: [item({ qty: 5, rate: 1000, amount: 5000 })],
      subtotal: 5000,
      taxTotal: 750,
      grandTotal: 5750,
      outstandingAmount: 5750,
      currency: 'EUR',
      exchangeRate: 20,
      dueDate: '2026-11-01', // not yet due → current
    })

    const journals = [
      createSalesInvoiceJournal(zarInvoice, accounts, customer),
      createSalesInvoiceJournal(eurInvoice, accounts, customer),
    ]
    const derived = computeAccountBalances(accounts, journals)
    // AR control: 11 500 (ZAR) + 5 750 × 20 (EUR) = 126 500.
    expect(balanceOf(derived, 'acc-ar')).toBe(126500)

    const parties = recomputePartyBalances([zarInvoice, eurInvoice], [customer])
    expect(parties[0].outstandingBalance).toBe(126500)
    // The party balance reconciles with the AR control account.
    expect(parties[0].outstandingBalance).toBe(balanceOf(derived, 'acc-ar'))

    const aging = agingBuckets([zarInvoice, eurInvoice], [customer], '2026-10-15', 'Sales')
    expect(aging).toHaveLength(1)
    expect(aging[0].current).toBe(115000)
    expect(aging[0].days90).toBe(11500)
    expect(aging[0].total).toBe(126500)

    const register = taxRegister([zarInvoice, eurInvoice])
    expect(register[register.length - 1]).toMatchObject({
      taxRate: null,
      salesTaxable: 110000,
      salesTax: 16500,
    })
  })
})

describe('multi-currency: bank reconciliation settles a foreign invoice in base', () => {
  const eur100 = invoice({
    id: 'inv-eur100',
    invoiceNumber: 'INV-2026-100',
    items: [item({ rate: 100, amount: 100, taxRate: 0 })],
    subtotal: 100,
    taxTotal: 0,
    grandTotal: 100,
    outstandingAmount: 100,
    currency: 'EUR',
    exchangeRate: 20,
  })
  const tx = {
    id: 'tx-eur',
    accountId: 'acc-bank',
    date: '2026-09-10',
    description: 'EFT Delta Trading INV-2026-100',
    reference: '',
    amount: 2000,
    reconciled: false,
  }

  it('suggests the exact base-currency match', () => {
    const data = ledger({ invoices: [eur100], bankTransactions: [tx] })
    const suggestions = computeSettlementSuggestions(data)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      transactionId: 'tx-eur',
      invoiceId: 'inv-eur100',
      amount: 2000,
      confidence: 'HIGH',
    })
  })

  it('settles the whole EUR 100 invoice with a 2 000 base deposit', () => {
    const data = ledger({
      invoices: [eur100],
      journalEntries: [createSalesInvoiceJournal(eur100, accounts, customer)],
      bankTransactions: [tx],
    })
    const { result, ledger: next } = applyReconciliation(data, {
      transactionId: 'tx-eur',
      invoiceId: 'inv-eur100',
    })
    expect(result.ok).toBe(true)
    expect(result.settledAmount).toBe(2000)
    expect(result.remainingOutstanding).toBe(0)
    expect(result.invoiceStatus).toBe('Paid')
    expect(result.partyBalance).toBe(0)

    const settled = findByNumber(next!.invoices, 'INV-2026-100')
    expect(settled.outstandingAmount).toBe(0)
    expect(settled.status).toBe('Paid')

    // AR nets to zero: the invoice posted Dr 2 000, the settlement Cr 2 000.
    const derived = computeAccountBalances(accounts, next!.journalEntries)
    expect(balanceOf(derived, 'acc-ar')).toBe(0)
    expect(balanceOf(derived, 'acc-bank')).toBe(2000)
  })

  it('writes a partial settlement back in the invoice currency', () => {
    const data = ledger({
      invoices: [eur100],
      journalEntries: [createSalesInvoiceJournal(eur100, accounts, customer)],
      bankTransactions: [{ ...tx, amount: 500 }],
    })
    const { result, ledger: next } = applyReconciliation(data, {
      transactionId: 'tx-eur',
      invoiceId: 'inv-eur100',
    })
    expect(result.ok).toBe(true)
    expect(result.settledAmount).toBe(500)
    expect(result.remainingOutstanding).toBe(1500)
    expect(result.invoiceStatus).toBe('Unpaid')

    const partial = findByNumber(next!.invoices, 'INV-2026-100')
    // Base remainder 1 500 → EUR 1 500 / 20 = 75.
    expect(partial.outstandingAmount).toBe(75)
    expect(partial.status).toBe('Unpaid')
    expect(result.partyBalance).toBe(1500)
  })
})

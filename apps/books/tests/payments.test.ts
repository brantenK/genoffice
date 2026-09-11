import { describe, expect, it, beforeEach } from 'vitest'
import { accountsMatchJournals, allJournalsBalanced, round2 } from '../src/shared/accounting'
import {
  applyPayment,
  createPaymentJournal,
  findMatchingUnreconciledTransaction,
  linkPaymentToBankTransaction,
} from '../src/shared/payments'
import { migrateAndValidateBooks } from '../src/main/books-main'
import { useBooksStore } from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import type { BankTransaction, BooksData, Payment } from '../src/shared/types'

const seed = (): BooksData => JSON.parse(JSON.stringify(initialBooksData))

describe('applyPayment — validation & allocation', () => {
  it('exact settle marks the invoice Paid and zeroes outstanding', () => {
    const data = seed()
    const res = applyPayment(data, {
      partyId: 'party-1',
      date: '2026-09-06',
      method: 'Bank Transfer',
      reference: 'EFT-REF-1',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    })
    expect(res.ok).toBe(true)
    const payment = res.payment!
    expect(payment.type).toBe('received')
    expect(payment.partyId).toBe('party-1')
    expect(payment.partyName).toBe('City of Ekurhuleni Water Dept')
    expect(payment.total).toBe(145000)
    expect(payment.method).toBe('Bank Transfer')
    expect(payment.reference).toBe('EFT-REF-1')
    expect(payment.date).toBe('2026-09-06')

    const inv = res.updatedInvoices!.find((i) => i.id === 'inv-1')!
    expect(inv.outstandingAmount).toBe(0)
    expect(inv.status).toBe('Paid')
    // Untouched invoices are returned unchanged.
    expect(res.updatedInvoices!.find((i) => i.id === 'inv-2')!.outstandingAmount).toBe(50500)
  })

  it('partial settle keeps the invoice Unpaid with reduced outstanding', () => {
    const data = seed()
    const res = applyPayment(data, {
      partyId: 'party-1',
      date: '2026-09-06',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 50000 }],
    })
    expect(res.ok).toBe(true)
    const inv = res.updatedInvoices!.find((i) => i.id === 'inv-1')!
    expect(inv.outstandingAmount).toBe(95000)
    expect(inv.status).toBe('Unpaid')
    expect(res.payment!.total).toBe(50000)
  })

  it('rejects an allocation exceeding the outstanding amount', () => {
    const data = seed()
    const res = applyPayment(data, {
      partyId: 'party-1',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 200000 }],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/exceeds outstanding/)
  })

  it('rejects zero and negative allocation amounts', () => {
    const data = seed()
    const zero = applyPayment(data, {
      partyId: 'party-1',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 0 }],
    })
    expect(zero.ok).toBe(false)
    const negative = applyPayment(data, {
      partyId: 'party-1',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: -100 }],
    })
    expect(negative.ok).toBe(false)
  })

  it('supports multi-invoice allocations in a single payment', () => {
    const data = seed()
    data.invoices.push({
      ...data.invoices[0],
      id: 'inv-extra',
      invoiceNumber: 'INV-2026-009',
      grandTotal: 25000,
      outstandingAmount: 25000,
      status: 'Unpaid',
      createdAt: '2026-08-25T09:00:00Z',
      updatedAt: '2026-08-25T09:00:00Z',
    })
    const res = applyPayment(data, {
      partyId: 'party-1',
      allocations: [
        { invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 },
        { invoiceId: 'inv-extra', invoiceNumber: 'INV-2026-009', amount: 25000 },
      ],
    })
    expect(res.ok).toBe(true)
    expect(res.payment!.total).toBe(170000)
    expect(res.payment!.allocations).toHaveLength(2)
    expect(res.updatedInvoices!.find((i) => i.id === 'inv-1')!.status).toBe('Paid')
    expect(res.updatedInvoices!.find((i) => i.id === 'inv-extra')!.status).toBe('Paid')
  })

  it('rejects duplicate allocations for the same invoice', () => {
    const data = seed()
    const res = applyPayment(data, {
      partyId: 'party-1',
      allocations: [
        { invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 5000 },
        { invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 5000 },
      ],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/duplicate/i)
  })

  it('defaults the direction from the party classification', () => {
    const data = seed()
    const customer = applyPayment(data, {
      partyId: 'party-1',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 1000 }],
    })
    expect(customer.payment!.type).toBe('received')
    const supplier = applyPayment(data, {
      partyId: 'party-4',
      allocations: [{ invoiceId: 'bill-1', invoiceNumber: 'BILL-2026-001', amount: 1000 }],
    })
    expect(supplier.payment!.type).toBe('paid')
  })

  it('rejects a received payment against Purchase bills and paid against Sales invoices', () => {
    const data = seed()
    const receivedOnPurchase = applyPayment(data, {
      partyId: 'party-4',
      type: 'received',
      allocations: [{ invoiceId: 'bill-1', invoiceNumber: 'BILL-2026-001', amount: 10000 }],
    })
    expect(receivedOnPurchase.ok).toBe(false)
    expect(receivedOnPurchase.error).toMatch(/received/)

    const paidOnSales = applyPayment(data, {
      partyId: 'party-1',
      type: 'paid',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 10000 }],
    })
    expect(paidOnSales.ok).toBe(false)
    expect(paidOnSales.error).toMatch(/paid/)
  })

  it('rejects unknown parties and unknown invoices', () => {
    const data = seed()
    const unknownParty = applyPayment(data, {
      partyId: 'party-999',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 100 }],
    })
    expect(unknownParty.ok).toBe(false)
    expect(unknownParty.error).toMatch(/Party not found/)

    const unknownInvoice = applyPayment(data, {
      partyId: 'party-1',
      allocations: [{ invoiceId: 'inv-999', invoiceNumber: 'INV-2026-999', amount: 100 }],
    })
    expect(unknownInvoice.ok).toBe(false)
    expect(unknownInvoice.error).toMatch(/Invoice not found/)
  })

  it('rejects invoices that belong to another party', () => {
    const data = seed()
    const res = applyPayment(data, {
      partyId: 'party-1',
      allocations: [{ invoiceId: 'inv-2', invoiceNumber: 'INV-2026-002', amount: 100 }],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/does not belong to/)
  })

  it('rejects draft and cancelled invoices', () => {
    const data = seed()
    const base = data.invoices[0]
    data.invoices.push(
      {
        ...base,
        id: 'inv-draft',
        invoiceNumber: 'INV-2026-900',
        status: 'Draft',
        outstandingAmount: 100,
        createdAt: '2026-08-25T09:00:00Z',
        updatedAt: '2026-08-25T09:00:00Z',
      },
      {
        ...base,
        id: 'inv-cancelled',
        invoiceNumber: 'INV-2026-901',
        status: 'Cancelled',
        outstandingAmount: 100,
        createdAt: '2026-08-25T09:00:00Z',
        updatedAt: '2026-08-25T09:00:00Z',
      },
    )
    const draft = applyPayment(data, {
      partyId: 'party-1',
      allocations: [{ invoiceId: 'inv-draft', invoiceNumber: 'INV-2026-900', amount: 100 }],
    })
    expect(draft.ok).toBe(false)
    expect(draft.error).toMatch(/Draft/)
    const cancelled = applyPayment(data, {
      partyId: 'party-1',
      allocations: [{ invoiceId: 'inv-cancelled', invoiceNumber: 'INV-2026-901', amount: 100 }],
    })
    expect(cancelled.ok).toBe(false)
    expect(cancelled.error).toMatch(/Cancelled/)
  })

  it('rejects an already-paid invoice with no outstanding amount', () => {
    const data = seed()
    const res = applyPayment(data, {
      partyId: 'party-3',
      allocations: [{ invoiceId: 'inv-3', invoiceNumber: 'INV-2026-003', amount: 100 }],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no outstanding amount/)
  })

  it('rejects empty allocations', () => {
    const data = seed()
    const res = applyPayment(data, { partyId: 'party-1', allocations: [] })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/at least one invoice/)
  })

  it('resolves a party by name (partyName input or partyId holding a name)', () => {
    const data = seed()
    const byName = applyPayment(data, {
      partyName: 'City of Ekurhuleni Water Dept',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 1000 }],
    })
    expect(byName.ok).toBe(true)
    expect(byName.payment!.partyId).toBe('party-1')

    const byIdAsName = applyPayment(data, {
      partyId: 'transnet freight rail logistics',
      allocations: [{ invoiceId: 'inv-2', invoiceNumber: 'INV-2026-002', amount: 1000 }],
    })
    expect(byIdAsName.ok).toBe(true)
    expect(byIdAsName.payment!.partyId).toBe('party-2')
  })
})

describe('createPaymentJournal — balanced double-entry sides', () => {
  const data = seed()
  const mkPayment = (overrides: Partial<Payment> = {}): Payment => ({
    id: 'pay-test-1',
    partyId: 'party-1',
    partyName: 'City of Ekurhuleni Water Dept',
    date: '2026-09-06',
    type: 'received',
    method: 'Bank Transfer',
    reference: 'EFT-REF',
    allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    total: 145000,
    createdAt: '2026-09-06T10:00:00Z',
    ...overrides,
  })

  it('received: Dr Bank total / Cr AR per allocation, totals match payment.total', () => {
    const je = createPaymentJournal(mkPayment(), data.invoices, data.accounts, 'JE-2026-050')
    expect(allJournalsBalanced([je])).toBe(true)
    expect(je.entryNumber).toBe('JE-2026-050')
    expect(je.date).toBe('2026-09-06')
    expect(je.totalDebit).toBe(145000)
    expect(je.totalCredit).toBe(145000)

    const bank = je.items.find((i) => i.accountId === 'acc-bank')!
    expect(bank.debit).toBe(145000)
    expect(bank.credit).toBe(0)

    const ar = je.items.find((i) => i.accountId === 'acc-ar')!
    expect(ar.debit).toBe(0)
    expect(ar.credit).toBe(145000)
    expect(ar.partyId).toBe('party-1')
    expect(ar.partyName).toBe('City of Ekurhuleni Water Dept')
    expect(ar.remark).toBe('Payment received: INV-2026-001')

    // Reversal marker: entry remarks and at least one item remark carry the payment id.
    expect(je.remarks).toContain('Payment pay-test-1')
    expect(je.remarks).toContain('EFT-REF')
    expect(je.items.some((i) => i.remark && i.remark.includes('Payment pay-test-1'))).toBe(true)
  })

  it('multi-invoice received: one AR item per allocation summing to the bank leg', () => {
    const payment = mkPayment({
      allocations: [
        { invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 100000 },
        { invoiceId: 'inv-2', invoiceNumber: 'INV-2026-002', amount: 30000 },
      ],
      total: 130000,
    })
    const je = createPaymentJournal(payment, data.invoices, data.accounts)
    expect(allJournalsBalanced([je])).toBe(true)
    expect(je.totalDebit).toBe(130000)
    const arItems = je.items.filter((i) => i.accountId === 'acc-ar')
    expect(arItems).toHaveLength(2)
    expect(round2(arItems.reduce((s, i) => s + i.credit, 0))).toBe(130000)
    const bank = je.items.find((i) => i.accountId === 'acc-bank')!
    expect(bank.debit).toBe(130000)
  })

  it('paid: Dr AP per allocation / Cr Bank total, totals match payment.total', () => {
    const payment = mkPayment({
      id: 'pay-test-2',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      type: 'paid',
      method: 'Cash',
      reference: undefined,
      allocations: [{ invoiceId: 'bill-1', invoiceNumber: 'BILL-2026-001', amount: 42000 }],
      total: 42000,
    })
    const je = createPaymentJournal(payment, data.invoices, data.accounts, 'JE-2026-051')
    expect(allJournalsBalanced([je])).toBe(true)
    expect(je.totalDebit).toBe(42000)
    expect(je.totalCredit).toBe(42000)

    const ap = je.items.find((i) => i.accountId === 'acc-ap')!
    expect(ap.debit).toBe(42000)
    expect(ap.credit).toBe(0)
    expect(ap.partyId).toBe('party-4')
    expect(ap.remark).toBe('Payment made: BILL-2026-001')

    const bank = je.items.find((i) => i.accountId === 'acc-bank')!
    expect(bank.debit).toBe(0)
    expect(bank.credit).toBe(42000)

    // No reference supplied: remarks fall back to the method.
    expect(je.remarks).toContain('Payment pay-test-2 - Cash')
  })

  it('unknown invoice ids in allocations still produce a balanced entry', () => {
    const payment = mkPayment({
      id: 'pay-test-3',
      allocations: [{ invoiceId: 'inv-gone', invoiceNumber: 'INV-2026-999', amount: 1000 }],
      total: 1000,
    })
    const je = createPaymentJournal(payment, data.invoices, data.accounts)
    expect(allJournalsBalanced([je])).toBe(true)
  })
})

describe('payment ↔ bank-transaction linking (phase-3 unification)', () => {
  const seed = (): BooksData => JSON.parse(JSON.stringify(initialBooksData))
  const mkPayment = (overrides: Partial<Payment> = {}): Payment => ({
    id: 'pay-unif-1',
    partyId: 'party-1',
    partyName: 'City of Ekurhuleni Water Dept',
    date: '2026-09-06',
    type: 'received',
    allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    total: 145000,
    createdAt: '2026-09-06T10:00:00Z',
    ...overrides,
  })
  const mkTx = (overrides: Partial<BankTransaction> = {}): BankTransaction => ({
    id: 'tx-unif-1',
    accountId: 'acc-bank',
    date: '2026-09-10',
    description: 'EFT deposit',
    reference: '',
    amount: 145000,
    reconciled: false,
    ...overrides,
  })

  it('linkPaymentToBankTransaction matches by invoice number in the transaction text', () => {
    const data = seed()
    data.bankTransactions = [
      mkTx({ id: 'tx-1', description: 'EFT deposit', reference: 'INV-2026-001' }),
    ]
    const linked = linkPaymentToBankTransaction(data, mkPayment())
    expect(linked.matchedTransactionId).toBe('tx-1')
    const matched = linked.bankTransactions.find((t) => t.id === 'tx-1')!
    expect(matched.reconciled).toBe(true)
    expect(matched.matchedInvoiceId).toBe('inv-1')
    expect(matched.reconciledAt).toBeTruthy()
    // Unmatched transactions are untouched.
    expect(linked.bankTransactions).toHaveLength(1)
  })

  it('linkPaymentToBankTransaction matches by a significant party-name token', () => {
    const data = seed()
    data.bankTransactions = [
      mkTx({ id: 'tx-1', description: 'EFT Ekurhuleni settlement', reference: '' }),
    ]
    const linked = linkPaymentToBankTransaction(data, mkPayment())
    expect(linked.matchedTransactionId).toBe('tx-1')
    expect(linked.bankTransactions.find((t) => t.id === 'tx-1')!.reconciled).toBe(true)
    expect(linked.bankTransactions.find((t) => t.id === 'tx-1')!.matchedInvoiceId).toBe('inv-1')
  })

  it('linkPaymentToBankTransaction returns no match and leaves the array untouched', () => {
    const data = seed()
    data.bankTransactions = [
      mkTx({ id: 'tx-1', description: 'Monthly rental deposit', reference: '' }),
    ]
    const linked = linkPaymentToBankTransaction(data, mkPayment())
    expect(linked.matchedTransactionId).toBeUndefined()
    expect(linked.bankTransactions).toHaveLength(1)
    expect(linked.bankTransactions[0].reconciled).toBe(false)
    expect(linked.bankTransactions[0].matchedInvoiceId).toBeUndefined()
  })

  it('linkPaymentToBankTransaction never touches an already-reconciled transaction', () => {
    const data = seed()
    data.bankTransactions = [
      mkTx({ id: 'tx-1', description: 'EFT City of Ekurhuleni settlement', reconciled: true }),
    ]
    expect(findMatchingUnreconciledTransaction(data, mkPayment())).toBeNull()
    const linked = linkPaymentToBankTransaction(data, mkPayment())
    expect(linked.matchedTransactionId).toBeUndefined()
    // Still reconciled, but not because of this payment — unchanged.
    expect(linked.bankTransactions[0].reconciled).toBe(true)
    expect(linked.bankTransactions[0].matchedInvoiceId).toBeUndefined()
  })

  it('findMatchingUnreconciledTransaction supports a partial statement match', () => {
    const data = seed()
    data.bankTransactions = [
      mkTx({ id: 'tx-1', description: 'EFT City of Ekurhuleni settlement', amount: 145001 }),
    ]
    // Partial coverage is intentional: the payment can clear 145,000 of a
    // 145,001 imported statement line, leaving a 1.00 Suspense remainder.
    expect(findMatchingUnreconciledTransaction(data, mkPayment())?.id).toBe('tx-1')
  })

  it('findMatchingUnreconciledTransaction returns the first matching unreconciled tx', () => {
    const data = seed()
    data.bankTransactions = [
      mkTx({ id: 'tx-1', description: 'EFT Ekurhuleni deposit', reference: '' }),
      mkTx({ id: 'tx-2', description: 'EFT Ekurhuleni settlement', reference: '' }),
    ]
    expect(findMatchingUnreconciledTransaction(data, mkPayment())?.id).toBe('tx-1')
  })
})

describe('migrateAndValidateBooks — payments carry-through', () => {
  it('round-trips valid payments and sanitizes amounts with round2', () => {
    const migrated = migrateAndValidateBooks({
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: { companyName: 'Co', currency: 'ZAR', currencySymbol: 'R' },
      accounts: [],
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
      payments: [
        {
          id: 'pay-1',
          partyId: 'party-1',
          partyName: 'Acme',
          date: '2026-09-06',
          type: 'received',
          method: 'Bank Transfer',
          reference: 'REF-1',
          allocations: [
            { invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 1000.005 },
            { invoiceId: 'inv-2', invoiceNumber: 'INV-2026-002', amount: 2000 },
          ],
          total: 3000.005,
          createdAt: '2026-09-06T10:00:00Z',
        },
      ],
    })
    expect(migrated.payments).toHaveLength(1)
    const p = migrated.payments![0]
    expect(p.id).toBe('pay-1')
    expect(p.type).toBe('received')
    // Allocations and total are rounded to 2dp; total is derived from allocations.
    expect(p.allocations[0].amount).toBe(1000.01)
    expect(p.allocations[1].amount).toBe(2000)
    expect(p.total).toBe(3000.01)
  })

  it('round-trips a valid refund payment so it remains reversible after reload', () => {
    const migrated = migrateAndValidateBooks({
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: { companyName: 'Co', currency: 'ZAR', currencySymbol: 'R' },
      accounts: [],
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
      payments: [
        {
          id: 'pay-refund',
          partyId: 'party-1',
          partyName: 'Customer',
          date: '2026-09-06',
          type: 'refund',
          allocations: [{ invoiceId: 'cn-1', invoiceNumber: 'CN-2026-001', amount: 11500 }],
          total: 11500,
          createdAt: '2026-09-06T10:00:00Z',
        },
      ],
    })
    expect(migrated.payments).toHaveLength(1)
    expect(migrated.payments![0].type).toBe('refund')
    expect(migrated.payments![0].total).toBe(11500)
  })

  it('drops invalid payment entries and keeps the rest', () => {
    const migrated = migrateAndValidateBooks({
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: { companyName: 'Co', currency: 'ZAR', currencySymbol: 'R' },
      accounts: [],
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
      payments: [
        { id: 'pay-bad-type', partyId: 'p', date: '2026-09-06', type: 'refunded', allocations: [] },
        { id: 'pay-no-allocs', partyId: 'p', date: '2026-09-06', type: 'paid', allocations: [] },
        {
          id: 'pay-bad-alloc',
          partyId: 'p',
          date: '2026-09-06',
          type: 'paid',
          allocations: [{ amount: 50 }],
        },
        {
          id: 'pay-ok',
          partyId: 'p',
          partyName: 'P',
          date: '2026-09-06',
          type: 'paid',
          allocations: [{ invoiceId: 'i1', amount: 50 }],
          total: 50,
        },
      ],
    })
    expect(migrated.payments).toHaveLength(1)
    expect(migrated.payments![0].id).toBe('pay-ok')
    // invoiceNumber falls back to the invoiceId when missing.
    expect(migrated.payments![0].allocations[0].invoiceNumber).toBe('i1')
  })

  it('includes an empty payments array when the input has none (envelope pattern)', () => {
    const migrated = migrateAndValidateBooks({
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: { companyName: 'Co', currency: 'ZAR', currencySymbol: 'R' },
      accounts: [],
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
    })
    expect(migrated.payments).toEqual([])
  })
})

describe('store recordPayment / deletePayment (ledger-first round-trip)', () => {
  beforeEach(() => {
    useBooksStore.setState({
      activeTab: 'dashboard',
      data: JSON.parse(JSON.stringify(initialBooksData)),
      needsSetup: false,
      activeInvoiceId: null,
      invoiceStatusFilter: 'All',
      activeReport: 'profit-loss',
      printInvoice: null,
      searchTerm: '',
    })
  })

  const state = () => useBooksStore.getState().data
  const expectInvariants = () => {
    const d = state()
    expect(allJournalsBalanced(d.journalEntries)).toBe(true)
    expect(accountsMatchJournals(d.accounts, d.journalEntries)).toBe(true)
  }

  it('recordPayment posts a balanced journal, moves Bank/AR, recomputes party balances', async () => {
    const store = useBooksStore.getState()
    const res = await store.recordPayment({
      partyId: 'party-1',
      date: '2026-09-06',
      method: 'Bank Transfer',
      reference: 'EFT-2026-001',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    })
    expect(res.ok).toBe(true)
    expectInvariants()

    const d = state()
    expect(d.payments).toHaveLength(1)
    const payment = d.payments![0]
    expect(payment.type).toBe('received')
    expect(payment.total).toBe(145000)
    expect(d.journalEntries[0].remarks).toContain(`Payment ${payment.id}`)

    const inv = d.invoices.find((i) => i.id === 'inv-1')!
    expect(inv.outstandingAmount).toBe(0)
    expect(inv.status).toBe('Paid')

    const bank = d.accounts.find((a) => a.id === 'acc-bank')!
    const ar = d.accounts.find((a) => a.id === 'acc-ar')!
    expect(bank.balance).toBe(round2(485250 + 145000))
    expect(ar.balance).toBe(round2(195500 - 145000))

    const party = d.parties.find((p) => p.id === 'party-1')!
    expect(party.outstandingBalance).toBe(0)
  })

  it('recordPayment for a supplier debits AP and credits Bank', async () => {
    const store = useBooksStore.getState()
    const res = await store.recordPayment({
      partyId: 'party-4',
      date: '2026-09-06',
      method: 'Cash',
      allocations: [{ invoiceId: 'bill-1', invoiceNumber: 'BILL-2026-001', amount: 42000 }],
    })
    expect(res.ok).toBe(true)
    expectInvariants()

    const d = state()
    expect(d.payments![0].type).toBe('paid')
    const bank = d.accounts.find((a) => a.id === 'acc-bank')!
    const ap = d.accounts.find((a) => a.id === 'acc-ap')!
    expect(bank.balance).toBe(round2(485250 - 42000))
    expect(ap.balance).toBe(round2(74200 - 42000))
    expect(d.parties.find((p) => p.id === 'party-4')!.outstandingBalance).toBe(0)
  })

  it('recordPayment rejects over-allocation without mutating anything', async () => {
    const store = useBooksStore.getState()
    const before = state()
    const res = await store.recordPayment({
      partyId: 'party-1',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 999999 }],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    expectInvariants()

    const d = state()
    expect(d.payments || []).toHaveLength(0)
    expect(d.journalEntries.length).toBe(before.journalEntries.length)
    expect(d.invoices.find((i) => i.id === 'inv-1')!.outstandingAmount).toBe(145000)
  })

  it('deletePayment restores outstanding, reverses the journal, keeps invariants', async () => {
    const store = useBooksStore.getState()
    await store.recordPayment({
      partyId: 'party-1',
      date: '2026-09-06',
      method: 'Bank Transfer',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    })
    expect(state().payments).toHaveLength(1)
    const paymentId = state().payments![0].id
    const journalCount = state().journalEntries.length

    await store.deletePayment(paymentId)
    expectInvariants()

    const d = state()
    expect(d.payments).toHaveLength(0)
    expect(d.journalEntries.length).toBe(journalCount - 1)
    expect(d.journalEntries.some((je) => je.remarks && je.remarks.includes(paymentId))).toBe(false)

    const inv = d.invoices.find((i) => i.id === 'inv-1')!
    expect(inv.outstandingAmount).toBe(145000)
    expect(inv.status).toBe('Unpaid')

    const bank = d.accounts.find((a) => a.id === 'acc-bank')!
    const ar = d.accounts.find((a) => a.id === 'acc-ar')!
    expect(bank.balance).toBe(485250)
    expect(ar.balance).toBe(195500)
    expect(d.parties.find((p) => p.id === 'party-1')!.outstandingBalance).toBe(145000)
  })

  it('deletePayment after a partial payment restores only its share', async () => {
    const store = useBooksStore.getState()
    await store.recordPayment({
      partyId: 'party-2',
      date: '2026-09-06',
      allocations: [{ invoiceId: 'inv-2', invoiceNumber: 'INV-2026-002', amount: 20000 }],
    })
    const paymentId = state().payments![0].id
    await store.deletePayment(paymentId)
    expectInvariants()

    const inv = state().invoices.find((i) => i.id === 'inv-2')!
    expect(inv.outstandingAmount).toBe(50500)
    expect(inv.status).toBe('Unpaid')
    expect(state().parties.find((p) => p.id === 'party-2')!.outstandingBalance).toBe(50500)
  })

  it('deletePayment is a no-op for an unknown payment id', async () => {
    const store = useBooksStore.getState()
    const before = state()
    await store.deletePayment('pay-does-not-exist')
    expect(state().journalEntries.length).toBe(before.journalEntries.length)
    expect(state().payments || []).toHaveLength(0)
    expectInvariants()
  })

  it('full ledger round-trip through migration keeps payments and the invariant', async () => {
    const store = useBooksStore.getState()
    await store.recordPayment({
      partyId: 'party-1',
      date: '2026-09-06',
      method: 'Bank Transfer',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    })
    const migrated = migrateAndValidateBooks(JSON.parse(JSON.stringify(state())))
    expect(migrated.payments).toHaveLength(1)
    expect(migrated.payments![0].total).toBe(145000)
    expect(allJournalsBalanced(migrated.journalEntries)).toBe(true)
    expect(accountsMatchJournals(migrated.accounts, migrated.journalEntries)).toBe(true)
  })
})

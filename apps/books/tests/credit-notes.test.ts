import { describe, expect, it } from 'vitest'
import {
  accountsMatchJournals,
  allJournalsBalanced,
  computeAccountBalances,
  createSalesInvoiceJournal,
  round2,
} from '../src/shared/accounting'
import { EMPTY_ACCOUNTS } from '../src/shared/chart'
import {
  createCreditNoteJournal,
  repostPlanForPartialSettlement,
  reversalJournalRemoval,
  validateCreditNote,
} from '../src/shared/credit-notes'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import type { BooksData, Invoice, JournalEntry, Party } from '../src/shared/types'

const customer: Party = {
  id: 'party-cn-cust',
  name: 'Credit Note Customer',
  type: 'Customer',
  outstandingBalance: 0,
}

const supplier: Party = {
  id: 'party-cn-supp',
  name: 'Credit Note Supplier',
  type: 'Supplier',
  outstandingBalance: 0,
}

const mkInvoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: 'inv-cn-base',
  invoiceNumber: 'INV-2026-500',
  type: 'Sales',
  partyId: customer.id,
  partyName: customer.name,
  date: '2026-09-01',
  dueDate: '2026-10-01',
  items: [],
  subtotal: 0,
  taxTotal: 0,
  grandTotal: 0,
  outstandingAmount: 0,
  status: 'Unpaid',
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
  ...overrides,
})

const lineItem = (
  accountId: string,
  rate: number,
  taxRate = 15,
  accountName = 'Tender & Commercial Contracting Sales',
) => ({
  id: `it-${accountId}-${rate}`,
  itemCode: 'CODE-1',
  description: 'Credit note line',
  accountId,
  accountName,
  qty: 1,
  rate,
  taxRate,
  amount: rate,
})

describe('createCreditNoteJournal', () => {
  it('reverses a sales invoice: Cr AR / Dr income / Dr VAT, balanced at grandTotal', () => {
    const creditNote = mkInvoice({
      id: 'cn-1',
      invoiceNumber: 'CN-2026-001',
      creditNote: true,
      items: [lineItem('acc-sales', 100000)],
      subtotal: 100000,
      taxTotal: 15000,
      grandTotal: 115000,
    })

    const je = createCreditNoteJournal(creditNote, EMPTY_ACCOUNTS, customer, 'JE-2026-050')
    expect(je.entryNumber).toBe('JE-2026-050')
    expect(je.totalDebit).toBe(115000)
    expect(je.totalCredit).toBe(115000)
    expect(allJournalsBalanced([je])).toBe(true)
    // The debit and credit columns each sum to exactly grandTotal.
    const debitSum = round2(je.items.reduce((s, it) => s + it.debit, 0))
    const creditSum = round2(je.items.reduce((s, it) => s + it.credit, 0))
    expect(debitSum).toBe(115000)
    expect(creditSum).toBe(115000)

    const arItem = je.items.find((i) => i.accountId === 'acc-ar')
    const incomeItem = je.items.find((i) => i.accountId === 'acc-sales')
    const vatItem = je.items.find((i) => i.accountId === 'acc-vat' || i.accountId === 'acc-vat-out')

    expect(arItem?.credit).toBe(115000)
    expect(arItem?.debit).toBe(0)
    expect(arItem?.partyId).toBe(customer.id)
    expect(arItem?.partyName).toBe(customer.name)
    expect(incomeItem?.debit).toBe(100000)
    expect(incomeItem?.credit).toBe(0)
    expect(vatItem?.debit).toBe(15000)
    expect(vatItem?.credit).toBe(0)
    // Every remark references the credit note number for reversal matching.
    expect(je.remarks).toContain('CN-2026-001')
    expect(arItem?.remark).toContain('CN-2026-001')
    expect(incomeItem?.remark).toContain('CN-2026-001')
  })

  it('groups income across multiple accounts with the reversed sides', () => {
    const creditNote = mkInvoice({
      id: 'cn-2',
      invoiceNumber: 'CN-2026-002',
      creditNote: true,
      items: [
        lineItem('acc-sales', 80000),
        lineItem('acc-consult', 20000, 15, 'Professional Advisory Fees'),
      ],
      subtotal: 100000,
      taxTotal: 15000,
      grandTotal: 115000,
    })

    const je = createCreditNoteJournal(creditNote, EMPTY_ACCOUNTS, customer)
    const salesItem = je.items.find((i) => i.accountId === 'acc-sales')
    const consultItem = je.items.find((i) => i.accountId === 'acc-consult')
    const vatItem = je.items.find((i) => i.accountId === 'acc-vat' || i.accountId === 'acc-vat-out')

    expect(salesItem?.debit).toBe(80000)
    expect(salesItem?.credit).toBe(0)
    expect(consultItem?.debit).toBe(20000)
    expect(consultItem?.credit).toBe(0)
    expect(vatItem?.debit).toBe(15000)
    expect(je.totalDebit).toBe(115000)
    expect(je.totalCredit).toBe(115000)
    expect(allJournalsBalanced([je])).toBe(true)
  })

  it('absorbs a 1-cent difference into the last income group', () => {
    const creditNote = mkInvoice({
      id: 'cn-3',
      invoiceNumber: 'CN-2026-003',
      creditNote: true,
      items: [
        lineItem('acc-sales', 100, 0),
        lineItem('acc-consult', 200, 0, 'Professional Advisory Fees'),
      ],
      // grandTotal exceeds subtotal + taxTotal by 2c (e.g. a round-off).
      subtotal: 300,
      taxTotal: 0,
      grandTotal: 300.02,
    })

    const je = createCreditNoteJournal(creditNote, EMPTY_ACCOUNTS, customer)
    const salesItem = je.items.find((i) => i.accountId === 'acc-sales')
    const consultItem = je.items.find((i) => i.accountId === 'acc-consult')
    expect(salesItem?.debit).toBe(100)
    // The last group absorbs the 0.02 difference.
    expect(consultItem?.debit).toBe(200.02)
    expect(je.totalDebit).toBe(300.02)
    expect(je.totalCredit).toBe(300.02)
    expect(allJournalsBalanced([je])).toBe(true)
  })

  it('reverses a purchase bill: Dr AP / Cr expense / Cr VAT input', () => {
    const creditNote = mkInvoice({
      id: 'cn-4',
      invoiceNumber: 'CN-2026-004',
      type: 'Purchase',
      partyId: supplier.id,
      partyName: supplier.name,
      creditNote: true,
      items: [lineItem('acc-materials', 20000, 15, 'Direct Project Materials & Subcontractors')],
      subtotal: 20000,
      taxTotal: 3000,
      grandTotal: 23000,
    })

    const je = createCreditNoteJournal(creditNote, EMPTY_ACCOUNTS, supplier)
    const apItem = je.items.find((i) => i.accountId === 'acc-ap')
    const expenseItem = je.items.find((i) => i.accountId === 'acc-materials')
    const vatInItem = je.items.find(
      (i) => i.accountId === 'acc-vat-in' || i.accountId === 'acc-vat',
    )

    expect(apItem?.debit).toBe(23000)
    expect(apItem?.credit).toBe(0)
    expect(apItem?.partyId).toBe(supplier.id)
    expect(expenseItem?.credit).toBe(20000)
    expect(expenseItem?.debit).toBe(0)
    expect(vatInItem?.credit).toBe(3000)
    expect(vatInItem?.debit).toBe(0)
    expect(je.totalDebit).toBe(23000)
    expect(je.totalCredit).toBe(23000)
    expect(allJournalsBalanced([je])).toBe(true)
  })
})

describe('validateCreditNote', () => {
  it('accepts a valid credit note', () => {
    const creditNote = mkInvoice({
      invoiceNumber: 'CN-2026-010',
      creditNote: true,
      subtotal: 10000,
      taxTotal: 1500,
      grandTotal: 11500,
    })
    const original = mkInvoice({ invoiceNumber: 'INV-2026-010', grandTotal: 14500 })
    expect(
      validateCreditNote({ invoice: creditNote, originalInvoice: original, paidAmount: 5000 }),
    ).toEqual({ ok: true })
    expect(validateCreditNote({ invoice: creditNote, paidAmount: 5000 }).ok).toBe(true)
  })

  it('rejects zero or negative credit amounts', () => {
    const zero = validateCreditNote({
      invoice: mkInvoice({ invoiceNumber: 'CN-2026-011', grandTotal: 0 }),
      paidAmount: 0,
    })
    expect(zero.ok).toBe(false)
    const negative = validateCreditNote({
      invoice: mkInvoice({ invoiceNumber: 'CN-2026-012', grandTotal: -11500 }),
      paidAmount: 0,
    })
    expect(negative.ok).toBe(false)
    expect(negative.error).toContain('greater than zero')
  })

  it('rejects crediting a credit note', () => {
    const original = mkInvoice({ invoiceNumber: 'CN-2026-013', creditNote: true, grandTotal: 5000 })
    const res = validateCreditNote({
      invoice: mkInvoice({ invoiceNumber: 'CN-2026-014', grandTotal: 1000 }),
      originalInvoice: original,
      paidAmount: 0,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('credit note')
  })

  it('rejects crediting more than the original invoice total', () => {
    const original = mkInvoice({ invoiceNumber: 'INV-2026-020', grandTotal: 10000 })
    const over = validateCreditNote({
      invoice: mkInvoice({ invoiceNumber: 'CN-2026-020', grandTotal: 10000.01 }),
      originalInvoice: original,
      paidAmount: 0,
    })
    expect(over.ok).toBe(false)
    expect(over.error).toContain('exceed')
    // Crediting exactly the original total is allowed.
    const exact = validateCreditNote({
      invoice: mkInvoice({ invoiceNumber: 'CN-2026-021', grandTotal: 10000 }),
      originalInvoice: original,
      paidAmount: 0,
    })
    expect(exact.ok).toBe(true)
  })

  it('rejects a missing reference and non-numeric amounts', () => {
    const noRef = validateCreditNote({
      invoice: mkInvoice({ invoiceNumber: '', grandTotal: 1000 }),
      paidAmount: 0,
    })
    expect(noRef.ok).toBe(false)
    expect(noRef.error).toContain('invoice number')

    const nanAmount = validateCreditNote({
      invoice: mkInvoice({ invoiceNumber: 'CN-2026-030', grandTotal: Number.NaN }),
      paidAmount: 0,
    })
    expect(nanAmount.ok).toBe(false)
    expect(nanAmount.error).toContain('numeric')
  })
})

describe('repostPlanForPartialSettlement', () => {
  it('keeps a fully paid edit Paid with zero outstanding', () => {
    const oldInvoice = mkInvoice({
      invoiceNumber: 'INV-2026-040',
      grandTotal: 1000,
      outstandingAmount: 0,
      status: 'Paid',
    })
    const plan = repostPlanForPartialSettlement(
      oldInvoice,
      mkInvoice({ invoiceNumber: 'INV-2026-040', grandTotal: 1000, status: 'Paid' }),
    )
    expect(plan.paidAmount).toBe(1000)
    expect(plan.newOutstanding).toBe(0)
    expect(plan.status).toBe('Paid')
  })

  it('preserves the paid portion and recomputes outstanding on a partial edit', () => {
    const oldInvoice = mkInvoice({
      invoiceNumber: 'INV-2026-041',
      grandTotal: 1000,
      outstandingAmount: 400,
      status: 'Unpaid',
    })
    const plan = repostPlanForPartialSettlement(
      oldInvoice,
      mkInvoice({ invoiceNumber: 'INV-2026-041', grandTotal: 1200, status: 'Unpaid' }),
    )
    expect(plan.paidAmount).toBe(600)
    expect(plan.newOutstanding).toBe(round2(1200 - 600))
    expect(plan.status).toBe('Unpaid')
  })

  it('never returns a negative paid amount or outstanding', () => {
    // Overpaid oddity: the paid portion clamps at zero.
    const plan = repostPlanForPartialSettlement(
      mkInvoice({
        invoiceNumber: 'INV-2026-042',
        grandTotal: 1000,
        outstandingAmount: 1300,
        status: 'Unpaid',
      }),
      mkInvoice({ invoiceNumber: 'INV-2026-042', grandTotal: 500, status: 'Unpaid' }),
    )
    expect(plan.paidAmount).toBe(0)
    expect(plan.newOutstanding).toBe(500)

    // A new total below what was already paid settles fully.
    const smaller = repostPlanForPartialSettlement(
      mkInvoice({
        invoiceNumber: 'INV-2026-043',
        grandTotal: 1000,
        outstandingAmount: 400,
        status: 'Unpaid',
      }),
      mkInvoice({ invoiceNumber: 'INV-2026-043', grandTotal: 400, status: 'Unpaid' }),
    )
    expect(smaller.paidAmount).toBe(600)
    expect(smaller.newOutstanding).toBe(0)
    expect(smaller.status).toBe('Paid')
  })

  it('returns zero paid amount for an invoice that was never paid', () => {
    const plan = repostPlanForPartialSettlement(
      mkInvoice({
        invoiceNumber: 'INV-2026-044',
        grandTotal: 1000,
        outstandingAmount: 1000,
        status: 'Unpaid',
      }),
      mkInvoice({ invoiceNumber: 'INV-2026-044', grandTotal: 1000, status: 'Unpaid' }),
    )
    expect(plan.paidAmount).toBe(0)
    expect(plan.newOutstanding).toBe(1000)
    expect(plan.status).toBe('Unpaid')
  })

  it('keeps an edited Draft invoice in Draft with full outstanding', () => {
    const plan = repostPlanForPartialSettlement(
      mkInvoice({
        invoiceNumber: 'INV-2026-045',
        grandTotal: 1000,
        outstandingAmount: 1000,
        status: 'Draft',
      }),
      mkInvoice({ invoiceNumber: 'INV-2026-045', grandTotal: 1200, status: 'Draft' }),
    )
    expect(plan.paidAmount).toBe(0)
    expect(plan.newOutstanding).toBe(1200)
    expect(plan.status).toBe('Draft')
  })
})

describe('reversalJournalRemoval', () => {
  it('removes only journals referencing the old invoice number', () => {
    const jePosting: JournalEntry = {
      id: 'je-1',
      entryNumber: 'JE-2026-001',
      date: '2026-09-01',
      posted: true,
      totalDebit: 11500,
      totalCredit: 11500,
      remarks: 'System sales invoice posting for INV-2026-100',
      items: [{ id: 'i1', accountId: 'acc-ar', accountName: 'AR', debit: 11500, credit: 0 }],
    }
    const jeSettlement: JournalEntry = {
      id: 'je-2',
      entryNumber: 'JE-2026-002',
      date: '2026-09-02',
      posted: true,
      totalDebit: 5000,
      totalCredit: 5000,
      remarks: 'Settlement payment for Invoice INV-2026-100',
      items: [
        { id: 'i1', accountId: 'acc-bank', accountName: 'Bank', debit: 5000, credit: 0 },
        {
          id: 'i2',
          accountId: 'acc-ar',
          accountName: 'AR',
          debit: 0,
          credit: 5000,
          remark: 'Settlement for Invoice INV-2026-100',
        },
      ],
    }
    const jeOtherInvoice: JournalEntry = {
      id: 'je-3',
      entryNumber: 'JE-2026-003',
      date: '2026-09-03',
      posted: true,
      totalDebit: 23000,
      totalCredit: 23000,
      remarks: 'System sales invoice posting for INV-2026-101',
      items: [{ id: 'i1', accountId: 'acc-ar', accountName: 'AR', debit: 23000, credit: 0 }],
    }
    const jeUnrelated: JournalEntry = {
      id: 'je-4',
      entryNumber: 'JE-2026-004',
      date: '2026-09-04',
      posted: true,
      totalDebit: 250,
      totalCredit: 250,
      remarks: 'Manual transfer',
      items: [
        { id: 'i1', accountId: 'acc-bank', accountName: 'Bank', debit: 250, credit: 0 },
        { id: 'i2', accountId: 'acc-cash', accountName: 'Cash', debit: 0, credit: 250 },
      ],
    }

    const remaining = reversalJournalRemoval('INV-2026-100', [
      jePosting,
      jeSettlement,
      jeOtherInvoice,
      jeUnrelated,
    ])
    expect(remaining).toHaveLength(2)
    expect(remaining.map((je) => je.id).sort()).toEqual(['je-3', 'je-4'])
    expect(remaining).not.toContain(jePosting)
    expect(remaining).not.toContain(jeSettlement)
  })
})

describe('Ledger-first integration: invoice + credit note reversal', () => {
  it('posts a sales invoice, reverses it with a credit note, and AR returns to its pre-invoice value', () => {
    const data: BooksData = JSON.parse(JSON.stringify(initialBooksData))
    const arBefore = data.accounts.find((a) => a.id === 'acc-ar')!.balance
    const salesBefore = data.accounts.find((a) => a.id === 'acc-sales')!.balance
    const vatBefore = data.accounts.find((a) => a.id === 'acc-vat')!.balance

    const invoice = mkInvoice({
      id: 'inv-integration',
      invoiceNumber: 'INV-2026-900',
      items: [lineItem('acc-sales', 10000)],
      subtotal: 10000,
      taxTotal: 1500,
      grandTotal: 11500,
      outstandingAmount: 11500,
    })
    const salesJe = createSalesInvoiceJournal(invoice, data.accounts, customer)

    const creditNote = mkInvoice({
      id: 'cn-integration',
      invoiceNumber: 'CN-2026-900',
      creditNote: true,
      items: [lineItem('acc-sales', 10000)],
      subtotal: 10000,
      taxTotal: 1500,
      grandTotal: 11500,
    })
    const creditNoteJe = createCreditNoteJournal(creditNote, data.accounts, customer)

    const allJournals = [...data.journalEntries, salesJe, creditNoteJe]
    expect(allJournalsBalanced(allJournals)).toBe(true)

    const derived = computeAccountBalances(data.accounts, allJournals)
    expect(derived.find((a) => a.id === 'acc-ar')!.balance).toBe(arBefore)
    expect(derived.find((a) => a.id === 'acc-sales')!.balance).toBe(salesBefore)
    expect(derived.find((a) => a.id === 'acc-vat')!.balance).toBe(vatBefore)

    const accountsWithDerived = data.accounts.map((a) => ({
      ...a,
      balance: derived.find((d) => d.id === a.id)!.balance,
    }))
    expect(accountsMatchJournals(accountsWithDerived, allJournals)).toBe(true)
  })
})

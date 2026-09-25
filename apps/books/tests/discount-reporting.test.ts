import { describe, expect, it } from 'vitest'
import {
  allJournalsBalanced,
  calculateInvoiceTotals,
  computeAccountBalances,
  createPurchaseBillJournal,
  createSalesInvoiceJournal,
  effectiveLineAmount,
  invoiceTaxBreakdown,
  recomputePartyBalances,
  round2,
} from '../src/shared/accounting'
import {
  createCreditNoteJournal,
  journalReferencesInvoice,
  reversalJournalRemoval,
} from '../src/shared/credit-notes'
import { agingBuckets, taxRegister, type TaxRegisterRow } from '../src/shared/reports'
import { EMPTY_ACCOUNTS } from '../src/shared/chart'
import type { Invoice, InvoiceItem, JournalEntry, Party } from '../src/shared/types'

/**
 * Money-math regressions for discount reporting:
 * - the tax register must report the VAT the journal posted, invoice-level
 *   discountTotal included, and its per-rate rows must sum to that VAT;
 * - a credit note must mirror the posting it reverses account by account
 *   (line discountRate applied) instead of dumping the discount on the last
 *   income group;
 * - AR ageing must reconcile with the derived party balances once a customer
 *   credit note exists;
 * - journal <-> invoice matching must be an exact reference, never a substring.
 */

const AS_OF = '2026-09-20'

const CUSTOMER: Party = {
  id: 'party-discount',
  name: 'Aurora Fabrication (Pty) Ltd',
  type: 'Customer',
  outstandingBalance: 0,
}

/** A line whose stored amount is qty x rate, exactly as the invoice form writes it. */
function line(
  partial: Partial<InvoiceItem> & { qty: number; rate: number; taxRate: number },
): InvoiceItem {
  return {
    id: `it-${Math.random().toString(36).slice(2, 8)}`,
    itemCode: 'LINE',
    description: 'Line',
    accountId: 'acc-sales',
    accountName: 'Tender & Commercial Contracting Sales',
    ...partial,
    amount: round2(partial.qty * partial.rate),
  }
}

/** An invoice whose stored totals came from the totals engine, as the store writes them. */
function invoice(
  partial: Partial<Invoice> & { items: InvoiceItem[]; invoiceNumber: string },
): Invoice {
  const totals = calculateInvoiceTotals(partial.items, {
    discountTotal: partial.discountTotal,
    roundOff: partial.roundOff,
  })
  const grandTotal = round2(partial.grandTotal ?? totals.grandTotal)
  return {
    id: partial.id ?? `inv-${partial.invoiceNumber}`,
    invoiceNumber: partial.invoiceNumber,
    type: partial.type ?? 'Sales',
    partyId: partial.partyId ?? CUSTOMER.id,
    partyName: partial.partyName ?? CUSTOMER.name,
    date: partial.date ?? '2026-09-01',
    dueDate: partial.dueDate ?? '2026-09-15',
    items: partial.items,
    subtotal: round2(partial.subtotal ?? totals.subtotal),
    taxTotal: round2(partial.taxTotal ?? totals.taxTotal),
    grandTotal,
    outstandingAmount: round2(
      partial.outstandingAmount ?? (partial.creditNote ? -grandTotal : grandTotal),
    ),
    status: partial.status ?? 'Unpaid',
    creditNote: partial.creditNote,
    creditedInvoiceId: partial.creditedInvoiceId,
    ...(partial.discountTotal ? { discountTotal: partial.discountTotal } : {}),
    ...(partial.roundOff ? { roundOff: partial.roundOff } : {}),
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

/** Signed movement of one account inside a journal: debits minus credits. */
function accountNet(journal: JournalEntry, accountId: string): number {
  return round2(
    journal.items
      .filter((item) => item.accountId === accountId)
      .reduce((sum, item) => round2(sum + item.debit - item.credit), 0),
  )
}

/** The VAT the journal posted, as a positive output (Sales) / input (Purchase) amount. */
function postedVat(journal: JournalEntry, type: 'Sales' | 'Purchase'): number {
  const ids = type === 'Sales' ? ['acc-vat', 'acc-vat-out'] : ['acc-vat-in', 'acc-vat']
  const vat = journal.items.find((item) => ids.includes(item.accountId))
  if (!vat) return 0
  return type === 'Sales' ? round2(vat.credit - vat.debit) : round2(vat.debit - vat.credit)
}

function totalRow(rows: TaxRegisterRow[]): TaxRegisterRow {
  return rows.find((row) => row.taxRate === null)!
}

function rateRows(rows: TaxRegisterRow[]): TaxRegisterRow[] {
  return rows.filter((row) => row.taxRate !== null)
}

const sumTaxable = (rows: TaxRegisterRow[]): number =>
  round2(rows.reduce((sum, row) => round2(sum + (row.salesTaxable + row.purchaseTaxable)), 0))

const sumTax = (rows: TaxRegisterRow[]): number =>
  round2(rows.reduce((sum, row) => round2(sum + (row.salesTax + row.purchaseTax)), 0))

describe('Tax register reports the VAT the journal posted', () => {
  it('single rate: an invoice-level discountTotal is reflected in the register', () => {
    const items = [line({ qty: 1, rate: 10000, taxRate: 15 })]
    const inv = invoice({ invoiceNumber: 'INV-2026-001', items, discountTotal: 500 })

    // 10000 taxable, less the 500 invoice discount, taxed at 15%.
    expect(inv.subtotal).toBe(10000)
    expect(inv.taxTotal).toBe(1425)
    expect(inv.grandTotal).toBe(10925)

    const journal = createSalesInvoiceJournal(inv, EMPTY_ACCOUNTS, CUSTOMER)
    expect(postedVat(journal, 'Sales')).toBe(1425)

    const rows = taxRegister([inv])
    expect(totalRow(rows).salesTax).toBe(1425)
    expect(totalRow(rows).salesTax).toBe(postedVat(journal, 'Sales'))
    expect(totalRow(rows).salesTaxable).toBe(9500)
    expect(rateRows(rows)[0].salesTaxable).toBe(9500)
    expect(rateRows(rows)[0].salesTax).toBe(1425)
  })

  it('mixed rates: per-rate rows sum to the posted VAT output', () => {
    const items = [
      line({ qty: 1, rate: 691, taxRate: 15 }),
      line({ qty: 1, rate: 500, taxRate: 0, accountId: 'acc-consult' }),
    ]
    const inv = invoice({ invoiceNumber: 'INV-2026-002', items, discountTotal: 100 })
    const journal = createSalesInvoiceJournal(inv, EMPTY_ACCOUNTS, CUSTOMER)
    const posted = postedVat(journal, 'Sales')

    // Mixed rates: the discount scales the per-line tax proportionally.
    expect(inv.subtotal).toBe(1191)
    expect(inv.taxTotal).toBe(94.95)
    expect(inv.grandTotal).toBe(round2(1091 + 94.95))
    expect(posted).toBe(94.95)

    // The shared breakdown is the one definition of that VAT.
    const breakdown = invoiceTaxBreakdown({
      items: inv.items,
      discountTotal: inv.discountTotal,
      subtotal: inv.subtotal,
      taxTotal: inv.taxTotal,
    })
    expect(breakdown.tax).toBe(posted)
    expect(breakdown.taxable).toBe(1091)
    expect(round2(breakdown.rows.reduce((sum, row) => round2(sum + row.tax), 0))).toBe(posted)

    const rows = taxRegister([inv])
    expect(rateRows(rows).map((row) => row.taxRate)).toEqual([0, 15])
    expect(sumTax(rateRows(rows))).toBe(posted)
    expect(sumTaxable(rateRows(rows))).toBe(1091)
    expect(totalRow(rows).salesTax).toBe(posted)
    expect(totalRow(rows).salesTaxable).toBe(round2(inv.subtotal - inv.discountTotal!))
  })

  it('purchase bills: a discounted bill matches the VAT input posted', () => {
    const items = [
      line({
        qty: 1,
        rate: 4000,
        taxRate: 15,
        accountId: 'acc-materials',
        accountName: 'Direct Project Materials & Subcontractors',
      }),
    ]
    const bill = invoice({
      invoiceNumber: 'BILL-2026-001',
      type: 'Purchase',
      items,
      discountTotal: 250,
    })
    const journal = createPurchaseBillJournal(bill, EMPTY_ACCOUNTS)

    expect(postedVat(journal, 'Purchase')).toBe(round2((4000 - 250) * 0.15))
    const rows = taxRegister([bill])
    expect(totalRow(rows).purchaseTax).toBe(postedVat(journal, 'Purchase'))
    expect(totalRow(rows).purchaseTax).toBe(562.5)
  })
})

describe('Credit notes mirror the posting they reverse', () => {
  const discountedLines = (): InvoiceItem[] => [
    line({ qty: 1, rate: 10000, taxRate: 15, discountRate: 10, accountId: 'acc-sales' }),
    line({
      qty: 1,
      rate: 5000,
      taxRate: 15,
      accountId: 'acc-consult',
      accountName: 'Professional Advisory Fees',
    }),
  ]

  it('line discountRate lands on its own account, not on the last group', () => {
    const items = discountedLines()
    const original = invoice({ invoiceNumber: 'INV-2026-010', items })
    const creditNote = invoice({
      invoiceNumber: 'CN-2026-010',
      items,
      creditNote: true,
      creditedInvoiceId: original.id,
    })

    // The discounted line posts 9000, not its raw 10000.
    expect(effectiveLineAmount(items[0])).toBe(9000)
    expect(original.subtotal).toBe(14000)
    expect(original.taxTotal).toBe(2100)

    const originalJournal = createSalesInvoiceJournal(original, EMPTY_ACCOUNTS, CUSTOMER)
    const creditNoteJournal = createCreditNoteJournal(creditNote, EMPTY_ACCOUNTS, CUSTOMER)

    expect(allJournalsBalanced([creditNoteJournal])).toBe(true)
    expect(creditNoteJournal.totalDebit).toBe(creditNoteJournal.totalCredit)
    expect(creditNoteJournal.totalDebit).toBe(originalJournal.totalDebit)

    // Every account carries the exact mirror of the original posting.
    expect(accountNet(originalJournal, 'acc-sales')).toBe(-9000)
    expect(accountNet(originalJournal, 'acc-consult')).toBe(-5000)
    expect(accountNet(originalJournal, 'acc-vat')).toBe(-2100)
    expect(accountNet(originalJournal, 'acc-ar')).toBe(16100)
    expect(accountNet(creditNoteJournal, 'acc-sales')).toBe(9000)
    expect(accountNet(creditNoteJournal, 'acc-consult')).toBe(5000)
    expect(accountNet(creditNoteJournal, 'acc-vat')).toBe(2100)
    expect(accountNet(creditNoteJournal, 'acc-ar')).toBe(-16100)
  })

  it('reverses line, invoice-level discount and round-off account for account', () => {
    const items = discountedLines()
    const adjustments = { discountTotal: 500, roundOff: -25 }
    const original = invoice({ invoiceNumber: 'INV-2026-011', items, ...adjustments })
    const creditNote = invoice({
      invoiceNumber: 'CN-2026-011',
      items,
      creditNote: true,
      creditedInvoiceId: original.id,
      ...adjustments,
    })

    expect(original.subtotal).toBe(14000)
    expect(original.taxTotal).toBe(2025) // (14000 - 500) * 15%
    expect(original.grandTotal).toBe(15500)

    const originalJournal = createSalesInvoiceJournal(original, EMPTY_ACCOUNTS, CUSTOMER)
    const creditNoteJournal = createCreditNoteJournal(creditNote, EMPTY_ACCOUNTS, CUSTOMER)

    expect(allJournalsBalanced([originalJournal, creditNoteJournal])).toBe(true)
    expect(creditNoteJournal.totalDebit).toBe(creditNoteJournal.totalCredit)
    expect(creditNoteJournal.totalDebit).toBe(originalJournal.totalDebit)

    const accounts = new Set(
      [...originalJournal.items, ...creditNoteJournal.items].map((item) => item.accountId),
    )
    for (const accountId of accounts) {
      expect(
        round2(accountNet(originalJournal, accountId) + accountNet(creditNoteJournal, accountId)),
      ).toBe(0)
    }

    // Ledger-first: invoice plus full credit note leaves every account at zero.
    const derived = computeAccountBalances(EMPTY_ACCOUNTS, [originalJournal, creditNoteJournal])
    for (const account of derived) {
      expect(account.balance).toBe(0)
    }
  })

  it('absorbs only a rounding difference into the last group', () => {
    const items = [
      line({ qty: 1, rate: 100, taxRate: 0, accountId: 'acc-sales' }),
      line({ qty: 1, rate: 200, taxRate: 0, accountId: 'acc-consult' }),
    ]
    const creditNote = invoice({
      invoiceNumber: 'CN-2026-012',
      items,
      creditNote: true,
      // 2c of unrecorded difference: grandTotal above subtotal + taxTotal.
      grandTotal: 300.02,
      taxTotal: 0,
      subtotal: 300,
    })

    const journal = createCreditNoteJournal(creditNote, EMPTY_ACCOUNTS, CUSTOMER)
    expect(accountNet(journal, 'acc-sales')).toBe(100)
    expect(accountNet(journal, 'acc-consult')).toBe(200.02)
    expect(journal.totalDebit).toBe(300.02)
    expect(journal.totalCredit).toBe(300.02)
    expect(allJournalsBalanced([journal])).toBe(true)
  })
})

describe('AR ageing reconciles with the derived party balances', () => {
  it('a customer credit note is surfaced as a credit and nets into the row total', () => {
    const original = invoice({
      invoiceNumber: 'INV-2026-030',
      items: [line({ qty: 1, rate: 1000, taxRate: 15 })],
    })
    const creditNote = invoice({
      invoiceNumber: 'CN-2026-030',
      items: [line({ qty: 1, rate: 400, taxRate: 15 })],
      creditNote: true,
      creditedInvoiceId: original.id,
    })
    expect(original.grandTotal).toBe(1150)
    expect(creditNote.grandTotal).toBe(460)

    const invoices = [original, creditNote]
    const journals = [
      createSalesInvoiceJournal(original, EMPTY_ACCOUNTS, CUSTOMER),
      createCreditNoteJournal(creditNote, EMPTY_ACCOUNTS, CUSTOMER),
    ]

    const rows = agingBuckets(invoices, [CUSTOMER], AS_OF, 'Sales')
    expect(rows).toHaveLength(1)
    expect(rows[0].partyId).toBe(CUSTOMER.id)
    expect(rows[0].days30).toBe(1150) // due 2026-09-15, 5 days overdue as of 2026-09-20
    expect(rows[0].current + rows[0].days60 + rows[0].days90).toBe(0)
    expect(rows[0].credit).toBe(460)
    expect(rows[0].total).toBe(690)

    const [party] = recomputePartyBalances(invoices, [CUSTOMER])
    expect(party.outstandingBalance).toBe(rows[0].total)

    const ar = computeAccountBalances(EMPTY_ACCOUNTS, journals).find((a) => a.id === 'acc-ar')!
    expect(ar.balance).toBe(rows[0].total)
  })

  it('a credit-only party still appears, with a negative net total', () => {
    const creditNote = invoice({
      invoiceNumber: 'CN-2026-031',
      items: [line({ qty: 1, rate: 200, taxRate: 15 })],
      creditNote: true,
    })

    const rows = agingBuckets([creditNote], [CUSTOMER], AS_OF, 'Sales')
    expect(rows).toHaveLength(1)
    expect(rows[0].credit).toBe(230)
    expect(rows[0].total).toBe(-230)
    expect(rows[0].current).toBe(0)
  })

  it('an unapplied credit does not disturb other parties rows', () => {
    const other: Party = {
      id: 'party-other',
      name: 'Other Debtor (Pty) Ltd',
      type: 'Customer',
      outstandingBalance: 0,
    }
    const invoices = [
      invoice({
        invoiceNumber: 'INV-2026-032',
        partyId: other.id,
        partyName: other.name,
        items: [line({ qty: 1, rate: 800, taxRate: 15 })],
      }),
      invoice({
        invoiceNumber: 'CN-2026-032',
        items: [line({ qty: 1, rate: 400, taxRate: 15 })],
        creditNote: true,
      }),
    ]

    const rows = agingBuckets(invoices, [CUSTOMER, other], AS_OF, 'Sales')
    expect(rows.map((row) => row.partyId)).toEqual([other.id, CUSTOMER.id])
    expect(rows[0].total).toBe(920)
    expect(rows[1].total).toBe(-460)

    const balances = recomputePartyBalances(invoices, [CUSTOMER, other])
    const byId = new Map(balances.map((party) => [party.id, party.outstandingBalance]))
    for (const row of rows) {
      expect(row.total).toBe(byId.get(row.partyId))
    }
  })
})

describe('journalReferencesInvoice', () => {
  const journal = (id: string, remarks: string, itemRemarks: string[] = []): JournalEntry => ({
    id,
    entryNumber: `JE-2026-9${id}`,
    date: '2026-09-01',
    posted: true,
    totalDebit: 0,
    totalCredit: 0,
    remarks,
    items: itemRemarks.map((remark, index) => ({
      id: `${id}-i${index}`,
      accountId: 'acc-ar',
      accountName: 'Accounts Receivable (Debtors)',
      debit: 0,
      credit: 0,
      remark,
    })),
  })

  it('matches an exact reference in the entry remarks or an item remark', () => {
    expect(
      journalReferencesInvoice(
        journal('1', 'System sales invoice posting for INV-2026-001'),
        'INV-2026-001',
      ),
    ).toBe(true)
    expect(
      journalReferencesInvoice(
        journal('2', 'Settlement for Invoice INV-2026-001 (partial)'),
        'INV-2026-001',
      ),
    ).toBe(true)
    expect(
      journalReferencesInvoice(
        journal('3', 'Settlement', ['Settlement for Bill BILL-2026-001']),
        'BILL-2026-001',
      ),
    ).toBe(true)
  })

  it('does not match prefix or suffix collisions', () => {
    const longer = journal('4', 'System sales invoice posting for INV-2026-0011')
    expect(journalReferencesInvoice(longer, 'INV-2026-001')).toBe(false)
    expect(journalReferencesInvoice(longer, 'INV-2026-0011')).toBe(true)

    const shorter = journal('5', 'System sales invoice posting for INV-2026-001')
    expect(journalReferencesInvoice(shorter, 'INV-2026-0011')).toBe(false)

    const journalNumber = journal('6', 'Credit Note JE-2026-0012 reversal')
    expect(journalReferencesInvoice(journalNumber, 'JE-2026-001')).toBe(false)
    expect(journalReferencesInvoice(journalNumber, 'JE-2026-0012')).toBe(true)

    const itemCollision = journal('7', 'Settlement', ['Settlement for Invoice INV-2026-0011'])
    expect(journalReferencesInvoice(itemCollision, 'INV-2026-001')).toBe(false)
  })

  it('never matches an empty reference', () => {
    const entry = journal('8', 'System sales invoice posting for INV-2026-001')
    expect(journalReferencesInvoice(entry, '')).toBe(false)
    expect(journalReferencesInvoice(entry, '   ')).toBe(false)
  })

  it('reversalJournalRemoval keeps the journals of the colliding longer number', () => {
    const target = journal('9', 'System sales invoice posting for INV-2026-001', [
      'Sales Revenue - INV-2026-001',
    ])
    const collision = journal('a', 'System sales invoice posting for INV-2026-0011')
    const itemCollision = journal('b', 'Credit Note CN-2026-001', [
      'Credit Note Reversal - INV-2026-0011',
    ])

    const remaining = reversalJournalRemoval('INV-2026-001', [target, collision, itemCollision])
    expect(remaining.map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})

describe('Trial balance after a discounted invoice and its credit note', () => {
  it('total debits equal total credits across the sequence', () => {
    const items = [
      line({ qty: 1, rate: 10000, taxRate: 15, discountRate: 10, accountId: 'acc-sales' }),
      line({
        qty: 1,
        rate: 5000,
        taxRate: 15,
        accountId: 'acc-consult',
        accountName: 'Professional Advisory Fees',
      }),
    ]
    const adjustments = { discountTotal: 500, roundOff: -25 }
    const original = invoice({ invoiceNumber: 'INV-2026-040', items, ...adjustments })
    const creditNote = invoice({
      invoiceNumber: 'CN-2026-040',
      items,
      creditNote: true,
      creditedInvoiceId: original.id,
      ...adjustments,
    })
    const bill = invoice({
      invoiceNumber: 'BILL-2026-040',
      type: 'Purchase',
      items: [
        line({
          qty: 2,
          rate: 1500,
          taxRate: 15,
          discountRate: 5,
          accountId: 'acc-materials',
          accountName: 'Direct Project Materials & Subcontractors',
        }),
      ],
      discountTotal: 100,
    })

    const journals = [
      createSalesInvoiceJournal(original, EMPTY_ACCOUNTS, CUSTOMER),
      createCreditNoteJournal(creditNote, EMPTY_ACCOUNTS, CUSTOMER),
      createPurchaseBillJournal(bill, EMPTY_ACCOUNTS),
    ]
    expect(allJournalsBalanced(journals)).toBe(true)

    const totalDebits = round2(journals.reduce((sum, je) => round2(sum + je.totalDebit), 0))
    const totalCredits = round2(journals.reduce((sum, je) => round2(sum + je.totalCredit), 0))
    expect(totalDebits).toBe(totalCredits)

    // Trial balance over the derived balances: debit-side equals credit-side.
    const derived = computeAccountBalances(EMPTY_ACCOUNTS, journals)
    let debitSide = 0
    let creditSide = 0
    for (const account of derived) {
      if (account.isGroup) continue
      const debitNormal = account.rootType === 'Asset' || account.rootType === 'Expense'
      const signed = round2(debitNormal ? account.balance : -account.balance)
      if (signed > 0) debitSide = round2(debitSide + signed)
      else creditSide = round2(creditSide - signed)
    }
    expect(debitSide).toBe(creditSide)
    expect(debitSide).toBeGreaterThan(0)

    // The sales invoice and its credit note cancel on every account they touch.
    const pair = new Set([...journals[0].items, ...journals[1].items].map((item) => item.accountId))
    for (const accountId of pair) {
      expect(round2(accountNet(journals[0], accountId) + accountNet(journals[1], accountId))).toBe(
        0,
      )
    }
  })
})

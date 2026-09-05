import { describe, it, expect } from 'vitest'
import {
  round2,
  calculateInvoiceTotals,
  createSalesInvoiceJournal,
  createPurchaseBillJournal,
  recomputePartyBalances,
} from '../src/shared/accounting'
import { CORE_ACCOUNTS } from '../src/main/books-main'
import type { Invoice, InvoiceItem, Party } from '../src/shared/types'

describe('F18 Invariants & Bookkeeping Precision Suite', () => {
  describe('round2 Precision & Floating-Point Edge Cases', () => {
    it('handles classic floating-point addition drift (0.1 + 0.2 === 0.3)', () => {
      expect(0.1 + 0.2).not.toBe(0.3)
      expect(round2(0.1 + 0.2)).toBe(0.3)
    })

    it('rounds sub-cent fractions deterministically', () => {
      expect(round2(0.004)).toBe(0)
      expect(round2(0.0051)).toBe(0.01)
      expect(round2(0.006)).toBe(0.01)
      expect(round2(1.234)).toBe(1.23)
      expect(round2(1.236)).toBe(1.24)
      expect(round2(99.994)).toBe(99.99)
      expect(round2(99.9951)).toBe(100.0)
    })

    it('normalizes negative zero to positive zero', () => {
      expect(Object.is(round2(-0.0001), 0)).toBe(true)
      expect(Object.is(round2(0), 0)).toBe(true)
    })

    it('handles negative amounts and large enterprise figures', () => {
      expect(round2(-1250.556)).toBe(-1250.56)
      expect(round2(-1250.551)).toBe(-1250.55)
      expect(round2(-45.004)).toBe(-45)
      expect(round2(100000000.554)).toBe(100000000.55)
      expect(round2(100000000.556)).toBe(100000000.56)
    })

    it('handles null, undefined, NaN, and string inputs safely', () => {
      expect(round2(null as any)).toBe(0)
      expect(round2(undefined as any)).toBe(0)
      expect(round2(NaN)).toBe(0)
      expect(round2('123.456' as any)).toBe(123.46)
      expect(round2('invalid' as any)).toBe(0)
    })
  })

  describe('calculateInvoiceTotals & Tax Calculations', () => {
    it('calculates standard 15% South African VAT correctly', () => {
      const items: InvoiceItem[] = [
        {
          id: 'item-1',
          description: 'Civil Engineering Consulting',
          qty: 10,
          rate: 1500,
          taxRate: 15,
          amount: 15000,
        },
      ]
      const totals = calculateInvoiceTotals(items)
      expect(totals.subtotal).toBe(15000)
      expect(totals.taxTotal).toBe(2250)
      expect(totals.grandTotal).toBe(17250)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })

    it('calculates zero-rated (0% VAT) items correctly', () => {
      const items: InvoiceItem[] = [
        {
          id: 'item-1',
          description: 'Export Advisory Service',
          qty: 5,
          rate: 2000,
          taxRate: 0,
          amount: 10000,
        },
      ]
      const totals = calculateInvoiceTotals(items)
      expect(totals.subtotal).toBe(10000)
      expect(totals.taxTotal).toBe(0)
      expect(totals.grandTotal).toBe(10000)
    })

    it('handles mixed tax rates across multiple line items', () => {
      const items: InvoiceItem[] = [
        {
          id: 'item-1',
          description: 'Standard taxable goods',
          qty: 2,
          rate: 345.5,
          taxRate: 15,
          amount: 691,
        },
        {
          id: 'item-2',
          description: 'Zero-rated agricultural supplies',
          qty: 1,
          rate: 500,
          taxRate: 0,
          amount: 500,
        },
      ]
      const totals = calculateInvoiceTotals(items)
      expect(totals.subtotal).toBe(1191)
      expect(totals.taxTotal).toBe(103.65) // 691 * 0.15 = 103.65
      expect(totals.grandTotal).toBe(1294.65)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })

    it('handles negative items such as commercial rebates and trade discounts', () => {
      const items: InvoiceItem[] = [
        {
          id: 'item-1',
          description: 'Server Hardware Infrastructure',
          qty: 1,
          rate: 50000,
          taxRate: 15,
          amount: 50000,
        },
        {
          id: 'item-2',
          description: 'Early Settlement Rebate (5%)',
          qty: 1,
          rate: -2500,
          taxRate: 15,
          amount: -2500,
        },
      ]
      const totals = calculateInvoiceTotals(items)
      expect(totals.subtotal).toBe(47500)
      expect(totals.taxTotal).toBe(7125) // (50000 * 0.15) - (2500 * 0.15) = 7500 - 375 = 7125
      expect(totals.grandTotal).toBe(54625)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })

    it('falls back to item.amount when qty or rate is missing or invalid', () => {
      const items: InvoiceItem[] = [
        {
          id: 'item-1',
          description: 'Fixed milestone fee',
          taxRate: 15,
          amount: 12500,
        },
      ]
      const totals = calculateInvoiceTotals(items)
      expect(totals.subtotal).toBe(12500)
      expect(totals.taxTotal).toBe(1875)
      expect(totals.grandTotal).toBe(14375)
    })

    it('returns zeros for empty or non-array items', () => {
      expect(calculateInvoiceTotals([])).toEqual({ subtotal: 0, taxTotal: 0, grandTotal: 0 })
      expect(calculateInvoiceTotals(null as any)).toEqual({ subtotal: 0, taxTotal: 0, grandTotal: 0 })
    })

    it('guarantees subtotal + taxTotal === grandTotal across fractional-cent rates', () => {
      const items: InvoiceItem[] = [
        { id: '1', description: 'Item 1', qty: 3, rate: 33.33, taxRate: 15 },
        { id: '2', description: 'Item 2', qty: 7, rate: 14.29, taxRate: 15 },
        { id: '3', description: 'Item 3', qty: 11, rate: 8.77, taxRate: 15 },
      ]
      const totals = calculateInvoiceTotals(items)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })
  })

  describe('Strict Double-Entry Equality (Debits === Credits)', () => {
    it('guarantees totalDebits === totalCredits on standard Sales Invoices', () => {
      const invoice: Invoice = {
        id: 'inv-test-1',
        invoiceNumber: 'INV-2026-001',
        type: 'Sales',
        partyId: 'party-cust-1',
        partyName: 'Transnet SOC Ltd',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        status: 'Unpaid',
        items: [
          {
            id: 'it-1',
            description: 'Locomotive Sensor Systems',
            qty: 4,
            rate: 25000,
            taxRate: 15,
            amount: 100000,
            accountId: 'acc-sales',
          },
        ],
        subtotal: 100000,
        taxTotal: 15000,
        grandTotal: 115000,
        outstandingAmount: 115000,
      }

      const je = createSalesInvoiceJournal(invoice, CORE_ACCOUNTS)
      expect(je.totalDebit).toBe(115000)
      expect(je.totalCredit).toBe(115000)
      expect(je.totalDebit).toBe(je.totalCredit)

      const sumDebits = round2(je.items.reduce((s, it) => s + it.debit, 0))
      const sumCredits = round2(je.items.reduce((s, it) => s + it.credit, 0))
      expect(sumDebits).toBe(sumCredits)
      expect(sumDebits).toBe(115000)
    })

    it('guarantees totalDebits === totalCredits on Purchase Bills', () => {
      const bill: Invoice = {
        id: 'bill-test-1',
        invoiceNumber: 'PB-2026-042',
        type: 'Purchase',
        partyId: 'party-supp-1',
        partyName: 'BuildMax Materials',
        date: '2026-09-02',
        dueDate: '2026-10-02',
        status: 'Unpaid',
        items: [
          {
            id: 'it-1',
            description: 'Reinforced Concrete Aggregate',
            qty: 20,
            rate: 1800,
            taxRate: 15,
            amount: 36000,
            accountId: 'acc-materials',
          },
        ],
        subtotal: 36000,
        taxTotal: 5400,
        grandTotal: 41400,
        outstandingAmount: 41400,
      }

      const je = createPurchaseBillJournal(bill, CORE_ACCOUNTS)
      expect(je.totalDebit).toBe(41400)
      expect(je.totalCredit).toBe(41400)
      expect(je.totalDebit).toBe(je.totalCredit)

      const sumDebits = round2(je.items.reduce((s, it) => s + it.debit, 0))
      const sumCredits = round2(je.items.reduce((s, it) => s + it.credit, 0))
      expect(sumDebits).toBe(sumCredits)
      expect(sumDebits).toBe(41400)
    })

    it('fuzzer: 50 randomized invoices with complex fractions preserve debit === credit equality', () => {
      for (let seed = 1; seed <= 50; seed++) {
        const qty1 = 1 + (seed % 17)
        const rate1 = round2(12.34 * seed + 0.77)
        const qty2 = 1 + ((seed * 3) % 11)
        const rate2 = round2(87.65 + seed * 1.5)
        const discountRate = round2(-(5 + (seed % 9) * 2.3))

        const items: InvoiceItem[] = [
          { id: `f1-${seed}`, description: `Item A ${seed}`, qty: qty1, rate: rate1, taxRate: 15, accountId: 'acc-sales' },
          { id: `f2-${seed}`, description: `Item B ${seed}`, qty: qty2, rate: rate2, taxRate: 15, accountId: 'acc-consult' },
          { id: `f3-${seed}`, description: `Discount ${seed}`, qty: 1, rate: discountRate, taxRate: 15, accountId: 'acc-sales' },
        ]

        const totals = calculateInvoiceTotals(items)
        const inv: Invoice = {
          id: `fuzz-inv-${seed}`,
          invoiceNumber: `FUZZ-${seed}`,
          type: seed % 2 === 0 ? 'Sales' : 'Purchase',
          partyId: `party-${seed}`,
          partyName: `Party ${seed}`,
          date: '2026-09-03',
          dueDate: '2026-10-03',
          status: 'Unpaid',
          items,
          subtotal: totals.subtotal,
          taxTotal: totals.taxTotal,
          grandTotal: totals.grandTotal,
          outstandingAmount: totals.grandTotal,
        }

        const je =
          inv.type === 'Sales'
            ? createSalesInvoiceJournal(inv, CORE_ACCOUNTS)
            : createPurchaseBillJournal(inv, CORE_ACCOUNTS)

        const calculatedDebits = round2(je.items.reduce((s, i) => s + i.debit, 0))
        const calculatedCredits = round2(je.items.reduce((s, i) => s + i.credit, 0))

        expect(je.totalDebit).toBe(je.totalCredit)
        expect(calculatedDebits).toBe(calculatedCredits)
        expect(calculatedDebits).toBe(je.totalDebit)
      }
    })
  })

  describe('Party Outstanding Balance Invariants', () => {
    it('strictly recomputes party balance matching open invoice outstanding amounts', () => {
      const parties: Party[] = [
        { id: 'p1', name: 'Rand Water', type: 'Customer', outstandingBalance: 99999 },
        { id: 'p2', name: 'Cement Supplies Co', type: 'Supplier', outstandingBalance: 0 },
      ]

      const invoices: Invoice[] = [
        {
          id: 'i1',
          invoiceNumber: 'INV-1',
          type: 'Sales',
          partyId: 'p1',
          partyName: 'Rand Water',
          status: 'Unpaid',
          subtotal: 10000,
          taxTotal: 1500,
          grandTotal: 11500,
          outstandingAmount: 11500,
          date: '2026-09-01',
          dueDate: '2026-10-01',
          items: [],
        },
        {
          id: 'i2',
          invoiceNumber: 'INV-2',
          type: 'Sales',
          partyId: 'p1',
          partyName: 'Rand Water',
          status: 'Unpaid',
          subtotal: 5000,
          taxTotal: 750,
          grandTotal: 5750,
          outstandingAmount: 2000, // partially paid
          date: '2026-09-02',
          dueDate: '2026-10-02',
          items: [],
        },
        {
          id: 'i3',
          invoiceNumber: 'INV-3',
          type: 'Sales',
          partyId: 'p1',
          partyName: 'Rand Water',
          status: 'Paid',
          subtotal: 20000,
          taxTotal: 3000,
          grandTotal: 23000,
          outstandingAmount: 0,
          date: '2026-08-01',
          dueDate: '2026-09-01',
          items: [],
        },
        {
          id: 'i4',
          invoiceNumber: 'INV-4',
          type: 'Sales',
          partyId: 'p1',
          partyName: 'Rand Water',
          status: 'Cancelled',
          subtotal: 8000,
          taxTotal: 1200,
          grandTotal: 9200,
          outstandingAmount: 9200,
          date: '2026-08-15',
          dueDate: '2026-09-15',
          items: [],
        },
        {
          id: 'i5',
          invoiceNumber: 'BILL-1',
          type: 'Purchase',
          partyId: 'p2',
          partyName: 'Cement Supplies Co',
          status: 'Unpaid',
          subtotal: 3000,
          taxTotal: 450,
          grandTotal: 3450,
          outstandingAmount: 3450,
          date: '2026-09-01',
          dueDate: '2026-10-01',
          items: [],
        },
      ]

      const updated = recomputePartyBalances(invoices, parties)
      const p1 = updated.find((p) => p.id === 'p1')!
      const p2 = updated.find((p) => p.id === 'p2')!

      // p1 open amount: 11500 (i1) + 2000 (i2) = 13500 (i3 is Paid, i4 is Cancelled)
      expect(p1.outstandingBalance).toBe(13500)
      // p2 open amount: 3450 (i5)
      expect(p2.outstandingBalance).toBe(3450)
    })

    it('sets party balance to 0 if all invoices are paid or cancelled', () => {
      const parties: Party[] = [
        { id: 'p1', name: 'Customer A', type: 'Customer', outstandingBalance: 5000 },
      ]
      const invoices: Invoice[] = [
        {
          id: 'i1',
          invoiceNumber: 'INV-1',
          type: 'Sales',
          partyId: 'p1',
          partyName: 'Customer A',
          status: 'Paid',
          subtotal: 5000,
          taxTotal: 0,
          grandTotal: 5000,
          outstandingAmount: 0,
          date: '2026-09-01',
          dueDate: '2026-10-01',
          items: [],
        },
      ]
      const updated = recomputePartyBalances(invoices, parties)
      expect(updated[0].outstandingBalance).toBe(0)
    })

    it('handles empty parties or empty invoices safely', () => {
      expect(recomputePartyBalances([], [])).toEqual([])
      const parties: Party[] = [{ id: 'p1', name: 'Customer A', type: 'Customer', outstandingBalance: 100 }]
      expect(recomputePartyBalances([], parties)[0].outstandingBalance).toBe(0)
    })
  })
})

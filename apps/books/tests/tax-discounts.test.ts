import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  round2,
  effectiveLineAmount,
  calculateInvoiceTotals,
  createSalesInvoiceJournal,
  createPurchaseBillJournal,
  allJournalsBalanced,
  accountsMatchJournals,
} from '../src/shared/accounting'
import { CORE_ACCOUNTS, readBooksStore, writeBooksStore } from '../src/main/books-main'
import { useBooksStore } from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import type { Invoice, InvoiceItem, InvoiceType } from '../src/shared/types'

/**
 * Phase 2 (workstream 3): Taxes, Discounts & Round-Off.
 *
 * Every scenario keeps the phase-1 ledger-first invariants:
 * - subtotal + taxTotal (+ roundOff) === grandTotal (2dp, discount-free)
 * - journal totals === invoice grandTotal
 * - every journal entry balanced (debits === credits)
 * - stored account balances always equal balances derived from journals
 */
describe('Phase 2: Taxes, Discounts & Round-Off', () => {
  // Amount-only lines omit qty/rate (exercises the amount fallback); lines
  // that pass qty+rate also pass a consistent amount (qty * rate).
  const line = (partial: Partial<InvoiceItem> & { taxRate: number }): InvoiceItem =>
    ({
      id: `it-${Math.random().toString(36).slice(2, 8)}`,
      itemCode: '',
      description: 'Item',
      accountId: 'acc-sales',
      accountName: 'Tender & Commercial Contracting Sales',
      amount: 0,
      ...partial,
    }) as InvoiceItem

  const mkInvoice = (
    type: InvoiceType,
    items: InvoiceItem[],
    totals: ReturnType<typeof calculateInvoiceTotals>,
    extra: Partial<Invoice> = {},
  ): Invoice => ({
    id: `inv-${Math.random().toString(36).slice(2, 8)}`,
    invoiceNumber: `${type === 'Sales' ? 'INV' : 'BILL'}-2026-${String(
      Math.floor(Math.random() * 900) + 100,
    )}`,
    type,
    partyId: 'party-x',
    partyName: type === 'Sales' ? 'Discount Test Customer' : 'Discount Test Supplier',
    date: '2026-09-01',
    dueDate: '2026-10-01',
    items,
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    outstandingAmount: totals.grandTotal,
    status: 'Unpaid',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  })

  /**
   * The journal's Receivable/Payable leg always equals grandTotal and the
   * entry is always balanced. The entry's gross total (totalDebit ===
   * totalCredit) equals subtotal + taxTotal + max(roundOff, 0): separate
   * 'Invoice discount' / 'Round-off adjustment' items are internal income
   * adjustments, so with a discount or a negative round-off the gross side
   * is subtotal + taxTotal (larger than grandTotal). Tests that need the
   * strict totals === grandTotal property assert it explicitly (scenarios
   * without discount/negative round-off).
   */
  const expectJournalParity = (
    invoice: Invoice,
    totals: ReturnType<typeof calculateInvoiceTotals>,
  ) => {
    const je =
      invoice.type === 'Sales'
        ? createSalesInvoiceJournal(invoice, CORE_ACCOUNTS)
        : createPurchaseBillJournal(invoice, CORE_ACCOUNTS)
    expect(allJournalsBalanced([je])).toBe(true)
    expect(je.totalDebit).toBe(je.totalCredit)
    expect(je.totalDebit).toBe(
      round2(totals.subtotal + totals.taxTotal + Math.max(totals.roundOff || 0, 0)),
    )
    const arApId = invoice.type === 'Sales' ? 'acc-ar' : 'acc-ap'
    const arApItem = je.items.find((i) => i.accountId === arApId)
    expect(arApItem).toBeDefined()
    expect(round2(Math.abs((arApItem?.debit || 0) - (arApItem?.credit || 0)))).toBe(
      totals.grandTotal,
    )
    return je
  }

  describe('effectiveLineAmount (shared discount helper)', () => {
    it('applies discountRate to the computed line amount', () => {
      expect(effectiveLineAmount(line({ amount: 10000, taxRate: 15, discountRate: 10 }))).toBe(9000)
      expect(
        effectiveLineAmount(
          line({ qty: 3, rate: 100, amount: 300, taxRate: 15, discountRate: 20 }),
        ),
      ).toBe(240)
      expect(
        effectiveLineAmount(line({ qty: 2, rate: 50, amount: 100, taxRate: 15, discountRate: 5 })),
      ).toBe(95)
    })

    it('returns the plain amount when no discount is set (or it is 0)', () => {
      expect(effectiveLineAmount(line({ amount: 10000, taxRate: 15 }))).toBe(10000)
      expect(effectiveLineAmount(line({ amount: 10000, taxRate: 15, discountRate: 0 }))).toBe(10000)
      expect(effectiveLineAmount(line({ qty: 4, rate: 250, amount: 1000, taxRate: 15 }))).toBe(1000)
    })
  })

  describe('Line discounts (discountRate)', () => {
    it('taxes the discounted base and keeps the identity', () => {
      const totals = calculateInvoiceTotals([
        line({ amount: 10000, taxRate: 15, discountRate: 10 }),
      ])
      expect(totals.subtotal).toBe(9000)
      expect(totals.taxTotal).toBe(1350) // 9000 * 0.15
      expect(totals.grandTotal).toBe(10350)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })

    it('works for qty x rate lines and fractional discounts', () => {
      const totals = calculateInvoiceTotals([
        line({ qty: 3, rate: 100, amount: 300, taxRate: 15, discountRate: 20 }),
      ])
      expect(totals.subtotal).toBe(240)
      expect(totals.taxTotal).toBe(36)
      expect(totals.grandTotal).toBe(276)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })

    it('rounds the discounted amount to 2dp before tax', () => {
      // 33.33 * 0.85 = 28.3305 -> 28.33 base, tax 4.25 (28.33 * 0.15)
      const totals = calculateInvoiceTotals([
        line({ qty: 1, rate: 33.33, amount: 33.33, taxRate: 15, discountRate: 15 }),
      ])
      expect(totals.subtotal).toBe(28.33)
      expect(totals.taxTotal).toBe(round2(28.33 * 0.15))
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })
  })

  describe('Invoice-level discountTotal', () => {
    it('single shared tax rate: tax on the discounted subtotal', () => {
      const totals = calculateInvoiceTotals([line({ amount: 10000, taxRate: 15 })], {
        discountTotal: 500,
      })
      expect(totals.subtotal).toBe(10000)
      expect(totals.taxTotal).toBe(1425) // (10000 - 500) * 0.15
      expect(totals.grandTotal).toBe(10925)
      expect(round2(totals.subtotal - 500 + totals.taxTotal)).toBe(totals.grandTotal)
    })

    it('recomputes tax on the discounted base (aggregate, not per-line sum)', () => {
      const totals = calculateInvoiceTotals(
        [line({ amount: 10000, taxRate: 15 }), line({ amount: 2000, taxRate: 15 })],
        { discountTotal: 500 },
      )
      expect(totals.subtotal).toBe(12000)
      expect(totals.taxTotal).toBe(1725) // 11500 * 0.15, NOT 1500 + 300
      expect(totals.grandTotal).toBe(13225)
    })

    it('mixed rates: scales existing per-line tax proportionally', () => {
      const totals = calculateInvoiceTotals(
        [line({ amount: 691, taxRate: 15 }), line({ amount: 500, taxRate: 0 })],
        { discountTotal: 100 },
      )
      expect(totals.subtotal).toBe(1191)
      // factor = 1091 / 1191; line tax 103.65 scaled down
      expect(totals.taxTotal).toBe(94.95)
      expect(totals.grandTotal).toBe(round2(1091 + 94.95))
    })

    it('a discount larger than the subtotal clamps the taxable base to 0', () => {
      const totals = calculateInvoiceTotals([line({ amount: 1000, taxRate: 15 })], {
        discountTotal: 2000,
      })
      expect(totals.subtotal).toBe(1000)
      expect(totals.taxTotal).toBe(0)
      expect(totals.grandTotal).toBe(0)
    })
  })

  describe('Round-off', () => {
    it('positive round-off adds to grandTotal only', () => {
      const totals = calculateInvoiceTotals([line({ amount: 10000, taxRate: 15 })], {
        roundOff: 0.5,
      })
      expect(totals.subtotal).toBe(10000)
      expect(totals.taxTotal).toBe(1500)
      expect(totals.grandTotal).toBe(11500.5)
      expect(totals.roundOff).toBe(0.5)
      expect(round2(totals.subtotal + totals.taxTotal + (totals.roundOff || 0))).toBe(
        totals.grandTotal,
      )
    })

    it('negative round-off is allowed and reduces grandTotal', () => {
      const totals = calculateInvoiceTotals([line({ amount: 10000, taxRate: 15 })], {
        roundOff: -25,
      })
      expect(totals.subtotal).toBe(10000)
      expect(totals.taxTotal).toBe(1500)
      expect(totals.grandTotal).toBe(11475)
      expect(totals.roundOff).toBe(-25)
      expect(round2(totals.subtotal + totals.taxTotal + (totals.roundOff || 0))).toBe(
        totals.grandTotal,
      )
    })

    it('roundOff key is omitted when 0 (and the empty-items shape is unchanged)', () => {
      const totals = calculateInvoiceTotals([line({ amount: 10000, taxRate: 15 })], {
        roundOff: 0,
      })
      expect('roundOff' in totals).toBe(false)
      expect(calculateInvoiceTotals([])).toEqual({ subtotal: 0, taxTotal: 0, grandTotal: 0 })
      expect(calculateInvoiceTotals(null as any)).toEqual({
        subtotal: 0,
        taxTotal: 0,
        grandTotal: 0,
      })
    })
  })

  describe('VAT-inclusive lines (taxInclusive)', () => {
    it('splits an inclusive amount into base and tax', () => {
      const totals = calculateInvoiceTotals([line({ amount: 1150, taxRate: 15 })], {
        taxInclusive: true,
      })
      expect(totals.subtotal).toBe(1000) // 1150 / 1.15
      expect(totals.taxTotal).toBe(150) // 1150 - 1000
      expect(totals.grandTotal).toBe(1150)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })

    it('handles zero-rated lines and fractional bases', () => {
      const totals = calculateInvoiceTotals(
        [line({ amount: 333.33, taxRate: 15 }), line({ amount: 500, taxRate: 0 })],
        { taxInclusive: true },
      )
      expect(totals.subtotal).toBe(round2(333.33 / 1.15 + 500))
      expect(totals.taxTotal).toBe(round2(333.33 - round2(333.33 / 1.15)))
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })

    it('supports negative (rebate) inclusive lines', () => {
      const totals = calculateInvoiceTotals(
        [line({ amount: 1150, taxRate: 15 }), line({ amount: -115, taxRate: 15 })],
        { taxInclusive: true },
      )
      expect(totals.subtotal).toBe(900)
      expect(totals.taxTotal).toBe(135)
      expect(totals.grandTotal).toBe(1035)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })
  })

  describe('Regression: behavior unchanged without opts', () => {
    it('classic floating-point drift cases still round correctly', () => {
      const totals = calculateInvoiceTotals([
        line({ qty: 3, rate: 33.33, amount: 99.99, taxRate: 15 }),
        line({ qty: 7, rate: 14.29, amount: 100.03, taxRate: 15 }),
        line({ qty: 11, rate: 8.77, amount: 96.47, taxRate: 15 }),
      ])
      expect(totals.subtotal).toBe(296.49)
      // Per-line taxes on the LINE amounts: 15.00 + 15.00 + 14.47
      expect(totals.taxTotal).toBe(44.47)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })

    it('per-line tax sum is preserved (not aggregate) when no discount is set', () => {
      // 2 lines of 33.35 @15%: per-line 5.00 each -> 10.00; the aggregate
      // round2(66.7 * 0.15) would be 10.01, so a correct implementation
      // must NOT recompute on the summed base.
      const totals = calculateInvoiceTotals([
        line({ qty: 1, rate: 33.35, amount: 33.35, taxRate: 15 }),
        line({ qty: 1, rate: 33.35, amount: 33.35, taxRate: 15 }),
      ])
      expect(totals.subtotal).toBe(66.7)
      expect(totals.taxTotal).toBe(10.0)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })

    it('negative rebate items keep their phase-1 negative tax', () => {
      const totals = calculateInvoiceTotals([
        line({ amount: 50000, taxRate: 15 }),
        line({ amount: -2500, taxRate: 15 }),
      ])
      expect(totals.subtotal).toBe(47500)
      expect(totals.taxTotal).toBe(7125)
      expect(totals.grandTotal).toBe(54625)
      expect(round2(totals.subtotal + totals.taxTotal)).toBe(totals.grandTotal)
    })
  })

  describe('Journal parity: journals equal invoice totals and stay balanced', () => {
    it('sales journal matches grandTotal with line discounts', () => {
      const items = [line({ amount: 10000, taxRate: 15, discountRate: 10 })]
      const totals = calculateInvoiceTotals(items)
      const je = expectJournalParity(mkInvoice('Sales', items, totals), totals)
      // No invoice-level adjustments: the entry gross equals grandTotal.
      expect(je.totalDebit).toBe(totals.grandTotal)
      expect(je.totalDebit).toBe(10350)
      expect(je.items.find((i) => i.accountId === 'acc-sales')?.credit).toBe(9000)
      expect(je.items.find((i) => i.accountId === 'acc-vat')?.credit).toBe(1350)
    })

    it('purchase journal matches grandTotal with invoice-level discount', () => {
      const items = [line({ amount: 10000, taxRate: 15, accountId: 'acc-materials' })]
      const totals = calculateInvoiceTotals(items, { discountTotal: 500 })
      const je = expectJournalParity(
        mkInvoice('Purchase', items, totals, { discountTotal: 500 }),
        totals,
      )
      // Discount item is an internal expense adjustment: gross = subtotal + tax.
      expect(je.totalDebit).toBe(11425)
      const discountItem = je.items.find((i) => i.remark?.includes('Invoice discount'))
      expect(discountItem).toBeDefined()
      expect(discountItem!.accountId).toBe('acc-materials')
      expect(discountItem!.debit).toBe(0)
      expect(discountItem!.credit).toBe(500)
    })

    it('sales journal books discount as a debit on the first income account', () => {
      const items = [line({ amount: 10000, taxRate: 15 })]
      const totals = calculateInvoiceTotals(items, { discountTotal: 500, roundOff: -25 })
      expect(totals.grandTotal).toBe(10900)
      const je = expectJournalParity(
        mkInvoice('Sales', items, totals, { discountTotal: 500, roundOff: -25 }),
        totals,
      )
      expect(je.totalDebit).toBe(11425) // 10000 income + 1425 VAT (gross side)
      const discountItem = je.items.find((i) => i.remark?.includes('Invoice discount'))
      expect(discountItem).toBeDefined()
      expect(discountItem!.debit).toBe(500)
      expect(discountItem!.credit).toBe(0)
      // round-off (negative) debits income so AR lands exactly on grandTotal
      const roundItem = je.items.find((i) => i.remark?.includes('Round-off adjustment'))
      expect(roundItem).toBeDefined()
      expect(roundItem!.debit).toBe(25)
      expect(roundItem!.credit).toBe(0)
    })

    it('purchase journal with mixed-rate discount and negative round-off balances', () => {
      const items = [
        line({ amount: 691, taxRate: 15, accountId: 'acc-materials' }),
        line({ amount: 500, taxRate: 0, accountId: 'acc-materials' }),
      ]
      const totals = calculateInvoiceTotals(items, { discountTotal: 100, roundOff: -0.2 })
      const je = expectJournalParity(
        mkInvoice('Purchase', items, totals, { discountTotal: 100, roundOff: -0.2 }),
        totals,
      )
      expect(je.totalDebit).toBe(1285.95) // 1191 + 94.95 gross
      expect(je.items.find((i) => i.remark?.includes('Round-off adjustment'))!.credit).toBe(0.2)
    })

    it('positive round-off credits income (sales) / debits expense (purchase)', () => {
      const salesItems = [line({ amount: 10000, taxRate: 15 })]
      const salesTotals = calculateInvoiceTotals(salesItems, { roundOff: 0.5 })
      const salesJe = expectJournalParity(
        mkInvoice('Sales', salesItems, salesTotals, { roundOff: 0.5 }),
        salesTotals,
      )
      // Positive round-off raises the credit side to grandTotal: gross === grandTotal.
      expect(salesJe.totalDebit).toBe(salesTotals.grandTotal)
      expect(salesJe.items.find((i) => i.remark?.includes('Round-off adjustment'))!.credit).toBe(
        0.5,
      )

      const purchaseItems = [line({ amount: 10000, taxRate: 15, accountId: 'acc-materials' })]
      const purchaseTotals = calculateInvoiceTotals(purchaseItems, { roundOff: 0.5 })
      const purchaseJe = expectJournalParity(
        mkInvoice('Purchase', purchaseItems, purchaseTotals, { roundOff: 0.5 }),
        purchaseTotals,
      )
      expect(purchaseJe.totalDebit).toBe(purchaseTotals.grandTotal)
      expect(purchaseJe.items.find((i) => i.remark?.includes('Round-off adjustment'))!.debit).toBe(
        0.5,
      )
    })

    it('VAT-inclusive invoices post balanced journals whose totals equal grandTotal', () => {
      const items = [line({ amount: 1150, taxRate: 15 })]
      const totals = calculateInvoiceTotals(items, { taxInclusive: true })
      const je = expectJournalParity(mkInvoice('Sales', items, totals), totals)
      expect(je.totalDebit).toBe(totals.grandTotal)
      expect(je.items.find((i) => i.accountId === 'acc-sales')?.credit).toBe(1000)
      expect(je.items.find((i) => i.accountId === 'acc-vat')?.credit).toBe(150)

      const buyItems = [line({ amount: 1150, taxRate: 15, accountId: 'acc-materials' })]
      const buyTotals = calculateInvoiceTotals(buyItems, {
        taxInclusive: true,
        discountTotal: 50,
        roundOff: 0.4,
      })
      expect(buyTotals.grandTotal).toBe(round2(950 + 142.5 + 0.4))
      expectJournalParity(
        mkInvoice('Purchase', buyItems, buyTotals, { discountTotal: 50, roundOff: 0.4 }),
        buyTotals,
      )
    })

    it('fuzzer: 40 randomized discounted invoices keep journal parity', () => {
      for (let seed = 1; seed <= 40; seed++) {
        const qty = 1 + (seed % 13)
        const rate = round2(10 + seed * 7.33)
        const discountRate = round2(2 + (seed % 6) * 2.5)
        const items = [
          line({ qty, rate, amount: round2(qty * rate), taxRate: 15, discountRate }),
          line({ amount: -round2(seed * 1.1), taxRate: 15, discountRate: 0 }),
        ]
        const discountTotal = round2(seed % 3 === 0 ? seed * 2 : 0)
        const roundOff = round2(seed % 4 === 0 ? -1 : seed % 5 === 0 ? 1 : 0)
        const totals = calculateInvoiceTotals(items, { discountTotal, roundOff })
        const type: InvoiceType = seed % 2 === 0 ? 'Sales' : 'Purchase'
        expectJournalParity(mkInvoice(type, items, totals, { discountTotal, roundOff }), totals)
      }
    })
  })

  describe('Store integration: saveInvoice keeps the ledger-first invariant', () => {
    let testDir: string
    let booksDataPath: string

    beforeEach(() => {
      testDir = join(tmpdir(), `books-tax-discounts-${randomUUID().slice(0, 8)}`)
      mkdirSync(testDir, { recursive: true })
      booksDataPath = join(testDir, 'books-data.json')

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

    afterEach(() => {
      try {
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
      } catch {}
    })

    const storeState = () => useBooksStore.getState().data

    it('saveInvoice with line + invoice discounts and round-off keeps AR = opening + grandTotal', async () => {
      const openingAr = storeState().accounts.find((a) => a.id === 'acc-ar')!.balance
      expect(openingAr).toBe(195500)

      await useBooksStore.getState().saveInvoice({
        type: 'Sales',
        partyName: 'Discounted Customer Co',
        status: 'Unpaid',
        discountTotal: 500,
        roundOff: -20,
        items: [
          {
            id: 'it-1',
            itemCode: '',
            description: 'Works with 10% line discount',
            accountId: 'acc-sales',
            accountName: 'Tender & Commercial Contracting Sales',
            qty: 1,
            rate: 10000,
            taxRate: 15,
            amount: 10000,
            discountRate: 10,
          },
        ],
      })

      const d = storeState()
      expect(allJournalsBalanced(d.journalEntries)).toBe(true)
      expect(accountsMatchJournals(d.accounts, d.journalEntries)).toBe(true)

      const inv = d.invoices[0]
      // 9000 effective - 500 invoice discount = 8500 taxable @15% = 1275, - 20 round-off
      expect(inv.subtotal).toBe(9000)
      expect(inv.taxTotal).toBe(1275)
      expect(inv.grandTotal).toBe(9755)
      expect(inv.discountTotal).toBe(500)
      expect(inv.roundOff).toBe(-20)
      expect(round2(inv.subtotal - 500 + inv.taxTotal - 20)).toBe(inv.grandTotal)

      const ar = d.accounts.find((a) => a.id === 'acc-ar')!.balance
      expect(ar).toBe(round2(openingAr + inv.grandTotal))
      expect(ar).toBe(205255)
    })

    it('saveInvoice purchase bill with discounts keeps AP = opening + grandTotal', async () => {
      const openingAp = storeState().accounts.find((a) => a.id === 'acc-ap')!.balance
      expect(openingAp).toBe(74200)

      await useBooksStore.getState().saveInvoice({
        type: 'Purchase',
        partyName: 'Discounted Supplier Co',
        status: 'Unpaid',
        discountTotal: 1000,
        roundOff: 7,
        items: [
          {
            id: 'it-1',
            itemCode: '',
            description: 'Materials with 5% discount',
            accountId: 'acc-materials',
            accountName: 'Direct Project Materials & Subcontractors',
            qty: 1,
            rate: 20000,
            taxRate: 15,
            amount: 20000,
            discountRate: 5,
          },
        ],
      })

      const d = storeState()
      expect(allJournalsBalanced(d.journalEntries)).toBe(true)
      expect(accountsMatchJournals(d.accounts, d.journalEntries)).toBe(true)

      const bill = d.invoices[0]
      expect(bill.subtotal).toBe(19000)
      expect(bill.taxTotal).toBe(2700)
      expect(bill.grandTotal).toBe(20707)
      expect(bill.discountTotal).toBe(1000)
      expect(bill.roundOff).toBe(7)

      const ap = d.accounts.find((a) => a.id === 'acc-ap')!.balance
      expect(ap).toBe(round2(openingAp + bill.grandTotal))
      expect(ap).toBe(94907)
    })

    it('taxInclusive setting flows through saveInvoice into totals and journals', async () => {
      await useBooksStore.getState().updateSettings({ taxInclusive: true, defaultTaxRate: 15 })
      const openingAr = storeState().accounts.find((a) => a.id === 'acc-ar')!.balance

      await useBooksStore.getState().saveInvoice({
        type: 'Sales',
        partyName: 'Inclusive Pricing Customer',
        status: 'Unpaid',
        items: [
          {
            id: 'it-1',
            itemCode: '',
            description: 'VAT-inclusive milestone',
            accountId: 'acc-sales',
            accountName: 'Tender & Commercial Contracting Sales',
            qty: 1,
            rate: 1150,
            taxRate: 15,
            amount: 1150,
          },
        ],
      })

      const d = storeState()
      expect(allJournalsBalanced(d.journalEntries)).toBe(true)
      expect(accountsMatchJournals(d.accounts, d.journalEntries)).toBe(true)
      const inv = d.invoices[0]
      expect(inv.subtotal).toBe(1000)
      expect(inv.taxTotal).toBe(150)
      expect(inv.grandTotal).toBe(1150)
      const ar = d.accounts.find((a) => a.id === 'acc-ar')!.balance
      expect(ar).toBe(round2(openingAr + inv.grandTotal))
    })
  })

  describe('Settings persistence through the migrate round-trip', () => {
    let testDir: string
    let booksDataPath: string

    beforeEach(() => {
      testDir = join(tmpdir(), `books-settings-${randomUUID().slice(0, 8)}`)
      mkdirSync(testDir, { recursive: true })
      booksDataPath = join(testDir, 'books-data.json')

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

    afterEach(() => {
      try {
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
      } catch {}
    })

    it('updateSettings persists and new fields survive write/read migration', async () => {
      await useBooksStore.getState().updateSettings({
        companyName: 'Round Trip Engineering (Pty) Ltd',
        defaultTaxRate: 12.5,
        taxInclusive: false,
        currency: 'USD',
        currencySymbol: '$',
      })

      const d = useBooksStore.getState().data
      expect(d.settings.defaultTaxRate).toBe(12.5)
      expect(d.settings.taxInclusive).toBe(false)
      expect(d.settings.currency).toBe('USD')
      expect(d.settings.currencySymbol).toBe('$')

      // Round trip through main-process migration: DEFAULT_BOOK_SETTINGS is
      // spread first, so stored values must win.
      writeBooksStore(booksDataPath, d)
      const migrated = readBooksStore(booksDataPath)
      expect(migrated.settings.companyName).toBe('Round Trip Engineering (Pty) Ltd')
      expect(migrated.settings.defaultTaxRate).toBe(12.5)
      expect(migrated.settings.taxInclusive).toBe(false)
      expect(migrated.settings.currency).toBe('USD')
      expect(migrated.settings.currencySymbol).toBe('$')
    })
  })
})

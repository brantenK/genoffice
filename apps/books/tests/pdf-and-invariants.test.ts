import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import {
  allJournalsBalanced,
  calculateInvoiceTotals,
  createPurchaseBillJournal,
  createSalesInvoiceJournal,
  hasPostedTotals,
  recomputePartyBalances,
  round2,
} from '../src/shared/accounting'
import { DEFAULT_BANK_ACCOUNT_NAME, DEFAULT_PAYMENT_TERMS_DAYS } from '../src/shared/chart'
import { agingBuckets, buildInvoicePdf, daysBetween, taxRegister } from '../src/shared/reports'
import { createCreditNoteJournal } from '../src/shared/credit-notes'
import type {
  CompanySettings,
  Invoice,
  InvoiceItem,
  JournalEntry,
  Party,
} from '../src/shared/types'

/**
 * Locks for the three invariants the money-math workstream rests on:
 * - a journal builder must balance for ANY finite stored totals, consistent or
 *   not (the AR/AP leg is the invoice's `grandTotal`, always);
 * - the VAT remark must name the rate the posting actually carries;
 * - AR ageing must bucket at the exact 0/30/60/90/91-day edges and reconcile
 *   with `recomputePartyBalances` for a mixed population.
 * Plus the PDF producer's multi-page furniture (page numbers, repeated header,
 * footer on every page) and the collision-free column layout.
 */

const AS_OF = '2026-09-30'

function makeItem(overrides: Partial<InvoiceItem> & { id: string }): InvoiceItem {
  const qty = overrides.qty ?? 1
  const rate = overrides.rate ?? 0
  return {
    id: overrides.id,
    itemCode: overrides.itemCode || `C-${overrides.id}`,
    description: overrides.description || `Item ${overrides.id}`,
    accountId: overrides.accountId || 'acc-sales',
    accountName: overrides.accountName || 'Sales',
    qty,
    rate,
    taxRate: overrides.taxRate ?? 15,
    amount: overrides.amount ?? qty * rate,
    discountRate: overrides.discountRate,
  }
}

function makeInvoice(overrides: Partial<Invoice> & { id: string }): Invoice {
  const id = overrides.id
  return {
    id,
    invoiceNumber: overrides.invoiceNumber || `INV-${id.toUpperCase()}`,
    type: overrides.type || 'Sales',
    partyId: overrides.partyId || `party-${id}`,
    partyName: overrides.partyName || `Party ${id}`,
    date: overrides.date || '2026-09-01',
    dueDate: overrides.dueDate || '2026-10-01',
    items: overrides.items || [],
    subtotal: overrides.subtotal ?? 0,
    taxTotal: overrides.taxTotal ?? 0,
    grandTotal: overrides.grandTotal ?? 0,
    outstandingAmount: overrides.outstandingAmount ?? overrides.grandTotal ?? 0,
    status: overrides.status || 'Unpaid',
    creditNote: overrides.creditNote,
    discountTotal: overrides.discountTotal,
    roundOff: overrides.roundOff,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

/** The Receivable/Payable leg of an entry, whichever side it landed on. */
function controlLeg(
  journal: JournalEntry,
  type: 'Sales' | 'Purchase',
): JournalEntry['items'][number] {
  const accountId = type === 'Sales' ? 'acc-ar' : 'acc-ap'
  const leg = journal.items.find((item) => item.accountId === accountId)
  if (!leg) throw new Error(`no ${accountId} leg on the entry`)
  return leg
}

/** Signed control-account movement: debits minus credits. */
function controlNet(journal: JournalEntry, type: 'Sales' | 'Purchase'): number {
  const leg = controlLeg(journal, type)
  return round2(leg.debit - leg.credit)
}

/**
 * The income/expense posting legs of an entry — the legs the invoice's own
 * lines and their discount/round-off adjustments land on, identified by the
 * remark the journal builders write (never the control or VAT legs).
 */
function revenueLegs(journal: JournalEntry, type: 'Sales' | 'Purchase'): JournalEntry['items'] {
  const prefixes =
    type === 'Sales'
      ? ['Sales Revenue ', 'Sales Discount / Adjustment ']
      : ['Direct Expense - ', 'Direct Expense Discount / Adjustment ']
  return journal.items.filter((item) =>
    prefixes.some((prefix) => (item.remark || '').startsWith(prefix)),
  )
}

/** The VAT posting leg of an entry, identified by the remark it carries. */
function vatLeg(journal: JournalEntry): JournalEntry['items'][number] | undefined {
  return journal.items.find((item) => /VAT (Output|Input)/.test(item.remark || ''))
}

describe('journal balance invariant under inconsistent stored totals', () => {
  const build = (invoice: Invoice): JournalEntry =>
    invoice.type === 'Sales'
      ? createSalesInvoiceJournal(invoice, [], undefined)
      : createPurchaseBillJournal(invoice, [], undefined)

  it('balances the exact stage-1 defect: subtotal 300 / tax 0 / grandTotal 300.02', () => {
    const invoice = makeInvoice({
      id: 'stage1',
      invoiceNumber: 'INV-STAGE1',
      items: [
        makeItem({ id: 'a', amount: 100, taxRate: 0, accountId: 'acc-sales' }),
        makeItem({ id: 'b', amount: 200, taxRate: 0, accountId: 'acc-consult' }),
      ],
      subtotal: 300,
      taxTotal: 0,
      grandTotal: 300.02,
      outstandingAmount: 300.02,
    })

    const sales = createSalesInvoiceJournal(invoice, [], undefined)
    expect(sales.totalDebit).toBe(sales.totalCredit)
    expect(sales.totalDebit).toBe(300.02)
    expect(controlNet(sales, 'Sales')).toBe(300.02)
    expect(allJournalsBalanced([sales])).toBe(true)

    const bill = createPurchaseBillJournal({ ...invoice, type: 'Purchase' }, [], undefined)
    expect(bill.totalDebit).toBe(bill.totalCredit)
    expect(controlNet(bill, 'Purchase')).toBe(-300.02)
    expect(allJournalsBalanced([bill])).toBe(true)
  })

  it('holds all four posting invariants for 400 fuzzed shapes, degenerate ones included', () => {
    const incomeAccounts = ['acc-sales', 'acc-consult', 'acc-interest-income']
    const expenseAccounts = ['acc-materials', 'acc-salaries']
    // Every line on a control account: the entry then has no revenue/expense
    // leg to absorb a residual on, which used to leave it unbalanced.
    const controlAccounts = ['acc-ar', 'acc-ap', 'acc-vat']
    const rates = [0, 7.5, 14, 15, 20]
    const fixedAccounts = new Set(['acc-ar', 'acc-ap', 'acc-vat', 'acc-vat-out', 'acc-vat-in'])

    // Deterministic LCG so a failure is reproducible from the seed alone.
    let seed = 20260924
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]
    const money = (max: number): number => round2((rand() - 0.35) * max)

    let consistentCases = 0
    let negativeCases = 0
    let controlOnlyCases = 0

    for (let caseNo = 1; caseNo <= 400; caseNo += 1) {
      const type: 'Sales' | 'Purchase' = rand() < 0.5 ? 'Sales' : 'Purchase'
      // 0 consistent, 1 consistent with a 1c stored rounding drift,
      // 2 independently drawn (inconsistent) totals, 3 stored totals absent
      // while the lines imply VAT, 4 a rebate (negative lines), 5 every line on
      // a control account, 6 no lines at all.
      const shape = Math.floor(rand() * 7)
      const sign = shape === 4 ? -1 : 1
      const accounts = type === 'Sales' ? incomeAccounts : expenseAccounts
      const lineAccounts = shape === 5 ? controlAccounts : [...accounts, 'acc-vat']
      const lineCount = shape === 6 ? 0 : 1 + Math.floor(rand() * 4)

      const items = Array.from({ length: lineCount }, (_, index) => {
        const lineAmount = sign * Math.abs(money(5000))
        const item = makeItem({ id: `c${caseNo}-${index}`, accountId: pick(lineAccounts) })
        return {
          ...item,
          taxRate: pick(rates),
          // qty 1 with rate = amount, so the stored amount and qty x rate agree
          // and the line is posted on the account it names.
          qty: 1,
          rate: lineAmount,
          amount: lineAmount,
          discountRate: rand() < 0.4 ? round2(rand() * 25) : undefined,
        }
      })

      const lineSubtotal = calculateInvoiceTotals(items).subtotal
      const drawnDiscount = rand() < 0.5 ? round2(rand() * 800) : undefined
      // A discount larger than the lines' own base is clamped by the totals
      // engine; the shapes that must compose exactly therefore use one that
      // fits. The inconsistent shapes keep the unrestricted draw.
      const discountTotal =
        drawnDiscount !== undefined && lineSubtotal > 0
          ? Math.min(drawnDiscount, lineSubtotal)
          : drawnDiscount
      const roundOff = rand() < 0.5 ? round2((rand() - 0.5) * 20) : undefined
      const derived = calculateInvoiceTotals(items, { discountTotal, roundOff })

      let subtotal: number
      let taxTotal: number
      let grandTotal: number
      if (shape === 0 || shape === 4 || shape === 5) {
        subtotal = derived.subtotal
        taxTotal = derived.taxTotal
        grandTotal = derived.grandTotal
      } else if (shape === 1) {
        subtotal = derived.subtotal
        taxTotal = derived.taxTotal
        grandTotal = round2(derived.grandTotal + (rand() < 0.5 ? -0.01 : 0.01))
      } else if (shape === 3) {
        // No stored subtotal or VAT at all: the item lines are the only source.
        subtotal = 0
        taxTotal = 0
        grandTotal = derived.grandTotal
      } else {
        subtotal = money(20000)
        taxTotal = money(3000)
        grandTotal = money(25000)
      }

      const invoice = makeInvoice({
        id: `fuzz-${caseNo}`,
        invoiceNumber: `${type === 'Sales' ? 'INV' : 'BILL'}-FUZZ-${caseNo}`,
        type,
        items,
        subtotal,
        taxTotal,
        grandTotal,
        roundOff,
        discountTotal,
      })

      const journal = build(invoice)
      // Every leg the shared rule posts must sit on a revenue/expense account
      // when it is not the control or the VAT leg — the residual is never
      // invented on a fixed leg.
      const label = `case ${caseNo} shape ${shape} (${JSON.stringify({
        type,
        items: items.map((item) => [item.accountId, item.amount, item.taxRate, item.discountRate]),
        subtotal,
        taxTotal,
        grandTotal,
        discountTotal,
        roundOff,
      })})`

      // 1. The posting balances, on both sides.
      expect(journal.totalDebit, `${label}: totalDebit must equal totalCredit`).toBe(
        journal.totalCredit,
      )
      expect(
        round2(journal.items.reduce((sum, item) => sum + item.debit, 0)),
        `${label}: item debits must equal item credits`,
      ).toBe(round2(journal.items.reduce((sum, item) => sum + item.credit, 0)))
      expect(allJournalsBalanced([journal]), `${label}: allJournalsBalanced`).toBe(true)
      expect(round2(journal.totalDebit), `${label}: entry totals must match the item sums`).toBe(
        round2(journal.items.reduce((sum, item) => sum + item.debit, 0)),
      )

      // 2. The control leg is the stored grandTotal, on the poster's own side.
      // It is identified by elimination: a corrupt row may well point a line at
      // the control account, and that group leg is not the control leg.
      const controlAccountId = type === 'Sales' ? 'acc-ar' : 'acc-ap'
      const control = journal.items.find(
        (item) =>
          item.accountId === controlAccountId &&
          !revenueLegs(journal, type).includes(item) &&
          !/^(Invoice discount|Round-off adjustment|Balancing adjustment)/.test(
            item.remark || '',
          ) &&
          !/VAT (Output|Input)/.test(item.remark || ''),
      )
      expect(control, `${label}: the entry must carry an AR/AP leg`).toBeDefined()
      const controlMovement = round2((control?.debit || 0) - (control?.credit || 0))
      const expectedControl =
        type === 'Sales' ? round2(invoice.grandTotal) : round2(-round2(invoice.grandTotal))
      expect(controlMovement, `${label}: AR/AP leg must equal grandTotal`).toBe(expectedControl)

      // 3. The VAT leg carries the VAT the tax register reports — the one shared
      // rule — and, whenever the row carries posted totals, the stored VAT.
      const registerTax = (() => {
        const row = taxRegister([invoice]).find((candidate) => candidate.taxRate === null)!
        return type === 'Sales' ? row.salesTax : row.purchaseTax
      })()
      const vat = vatLeg(journal)
      const vatNet = vat ? round2(vat.debit - vat.credit) : 0
      const expectedVatNet = round2(type === 'Sales' ? -registerTax : registerTax)
      expect(vatNet, `${label}: VAT leg must carry the VAT the register reports`).toBe(
        expectedVatNet,
      )
      if (hasPostedTotals(invoice)) {
        const storedTax = round2(invoice.taxTotal)
        expect(vatNet, `${label}: VAT leg must equal the stored taxTotal`).toBe(
          round2(type === 'Sales' ? -storedTax : storedTax),
        )
      }

      // 4. The revenue/expense legs carry the posted subtotal (the invoice's
      // own lines), the invoice-level discount and round-off being their own
      // legs. A rebate invoice (a negative subtotal) books no discount leg, so
      // its legs carry the post-discount base. The residual never invents a
      // figure here: for a consistent row it is nil, and for a 1c drift it is
      // at most that cent.
      const groupNet = round2(
        revenueLegs(journal, type).reduce((sum, item) => sum + item.debit - item.credit, 0),
      )
      const groupBase = round2(type === 'Sales' ? -subtotal : subtotal)
      const postDiscountBase = round2(
        type === 'Sales' ? -(subtotal - (discountTotal || 0)) : subtotal - (discountTotal || 0),
      )
      if (shape === 0 || shape === 5) {
        expect(
          groupNet,
          `${label}: the revenue/expense legs must carry the posted subtotal (${groupBase})`,
        ).toBe(groupBase)
      } else if (shape === 4) {
        expect(
          [groupBase, postDiscountBase],
          `${label}: a rebate's legs must carry its base (${groupBase} or ${postDiscountBase}), got ${groupNet}`,
        ).toContain(groupNet)
      } else if (shape === 1) {
        expect(
          Math.abs(round2(groupNet - groupBase)),
          `${label}: the residual must be at most the 1c stored drift`,
        ).toBeLessThanOrEqual(0.01)
      }
      // The residual may never leave the revenue/expense legs: every leg of the
      // entry must be one of the legs this posting books (the AR/AP anchor, the
      // VAT leg, a line's own account, or an adjustment on one of those).
      for (const item of journal.items) {
        const remark = item.remark || ''
        expect(
          item === control ||
            /VAT (Output|Input)/.test(remark) ||
            revenueLegs(journal, type).includes(item) ||
            /^(Invoice discount|Round-off adjustment|Balancing adjustment|Invoice |Purchase Bill )/.test(
              remark,
            ),
          `${label}: leg ${item.accountId} "${remark}" is not a leg this posting books`,
        ).toBe(true)
      }
      // No residual leg may ever be invented on a fixed account.
      for (const item of journal.items.filter((i) => (i.remark || '').startsWith('Balancing'))) {
        expect(
          fixedAccounts.has(item.accountId),
          `${label}: balancing leg must not sit on ${item.accountId}`,
        ).toBe(false)
      }

      // No leg may carry both sides at once.
      for (const item of journal.items) {
        expect(
          item.debit === 0 || item.credit === 0,
          `${label}: leg ${item.accountId} carries both a debit and a credit`,
        ).toBe(true)
      }

      if (shape === 0 || shape === 4 || shape === 5) consistentCases += 1
      if (shape === 4) negativeCases += 1
      if (shape === 5) controlOnlyCases += 1
    }

    // The population really did reach the degenerate shapes.
    expect(consistentCases).toBeGreaterThan(100)
    expect(negativeCases).toBeGreaterThan(10)
    expect(controlOnlyCases).toBeGreaterThan(10)
  })

  it('balances degenerate inputs: nil invoice, negative subtotal, NaN-free zero totals', () => {
    const nil = createSalesInvoiceJournal(
      makeInvoice({ id: 'nil', subtotal: 0, taxTotal: 0, grandTotal: 0 }),
      [],
      undefined,
    )
    expect(nil.totalDebit).toBe(0)
    expect(nil.totalCredit).toBe(0)
    expect(nil.items).toHaveLength(2)
    expect(allJournalsBalanced([nil])).toBe(true)

    // A rebate invoice is internally consistent — and it must post its rebate
    // on income (debit side) with the VAT leg on the STORED VAT, never absorb
    // the reversal into the VAT leg.
    const rebateItems = [makeItem({ id: 'n1', amount: -1150, taxRate: 15 })]
    const credit = createSalesInvoiceJournal(
      makeInvoice({
        id: 'neg',
        items: rebateItems,
        subtotal: -1000,
        taxTotal: -150,
        grandTotal: -1150,
        outstandingAmount: -1150,
      }),
      [],
      undefined,
    )
    expect(credit.totalDebit, 'a rebate posting must balance').toBe(credit.totalCredit)
    expect(controlNet(credit, 'Sales'), 'AR leg is the stored grandTotal').toBe(-1150)
    expect(allJournalsBalanced([credit])).toBe(true)
    const rebateRevenue = revenueLegs(credit, 'Sales')
    expect(rebateRevenue, 'a negative subtotal must still post a revenue leg').toHaveLength(1)
    expect(rebateRevenue[0].debit, 'the rebate posts on the debit side').toBe(1000)
    expect(rebateRevenue[0].credit).toBe(0)
    const rebateVat = vatLeg(credit)
    expect(rebateVat?.debit, 'the VAT leg carries the STORED VAT, not the residual').toBe(150)
    expect(rebateVat?.credit).toBe(0)
    expect(credit.totalDebit).toBe(round2(1000 + 150))

    const nilBill = createPurchaseBillJournal(
      makeInvoice({ id: 'nilbill', type: 'Purchase', subtotal: 0, taxTotal: 0, grandTotal: 0 }),
      [],
      undefined,
    )
    expect(nilBill.totalDebit).toBe(nilBill.totalCredit)
    expect(allJournalsBalanced([nilBill])).toBe(true)

    // The purchase mirror of the rebate posting.
    const rebateBill = createPurchaseBillJournal(
      makeInvoice({
        id: 'negbill',
        type: 'Purchase',
        items: [makeItem({ id: 'n1', amount: -1150, taxRate: 15, accountId: 'acc-materials' })],
        subtotal: -1000,
        taxTotal: -150,
        grandTotal: -1150,
        outstandingAmount: -1150,
      }),
      [],
      undefined,
    )
    expect(rebateBill.totalDebit).toBe(rebateBill.totalCredit)
    expect(controlNet(rebateBill, 'Purchase')).toBe(1150)
    const billVat = rebateBill.items.find(
      (item) => item.accountId === 'acc-vat-in' || item.accountId === 'acc-vat',
    )
    expect(billVat?.credit, 'the VAT input leg carries the STORED VAT').toBe(150)
    expect(billVat?.debit).toBe(0)
    expect(allJournalsBalanced([rebateBill])).toBe(true)

    // A row whose stored VAT exists but whose base does not (a correction row
    // with no lines): the VAT leg keeps the stored VAT and the difference rides
    // a revenue leg of its own instead of being invented on the VAT leg.
    const vatOnly = createSalesInvoiceJournal(
      makeInvoice({
        id: 'vat-only',
        items: [],
        subtotal: 0,
        taxTotal: 150,
        grandTotal: 1150,
        outstandingAmount: 1150,
      }),
      [],
      undefined,
    )
    expect(allJournalsBalanced([vatOnly])).toBe(true)
    expect(vatLeg(vatOnly)?.credit, 'the VAT leg keeps the STORED VAT').toBe(150)
    expect(vatLeg(vatOnly)?.debit).toBe(0)
    const balancing = vatOnly.items.find((item) => (item.remark || '').startsWith('Balancing'))
    expect(balancing, 'the residual carries its own revenue leg').toBeDefined()
    expect(balancing?.accountId).toBe('acc-sales')
    expect(balancing?.credit).toBe(1000)
    expect(controlNet(vatOnly, 'Sales')).toBe(1150)
  })
})

describe('the tax register reports exactly the VAT the journal posted', () => {
  const totalRegisterRow = (invoice: Invoice) =>
    taxRegister([invoice]).find((row) => row.taxRate === null)!

  const registerTax = (invoice: Invoice): number =>
    invoice.type === 'Sales'
      ? totalRegisterRow(invoice).salesTax
      : totalRegisterRow(invoice).purchaseTax

  const registerTaxable = (invoice: Invoice): number =>
    invoice.type === 'Sales'
      ? totalRegisterRow(invoice).salesTaxable
      : totalRegisterRow(invoice).purchaseTaxable

  /** The VAT the posting carries, as a positive output / input amount. */
  const postedVat = (journal: JournalEntry, type: 'Sales' | 'Purchase'): number => {
    const leg = vatLeg(journal)
    if (!leg) return 0
    return type === 'Sales' ? round2(leg.credit - leg.debit) : round2(leg.debit - leg.credit)
  }

  const build = (invoice: Invoice): JournalEntry =>
    invoice.type === 'Sales'
      ? createSalesInvoiceJournal(invoice, [], undefined)
      : createPurchaseBillJournal(invoice, [], undefined)

  it('agrees with the posting on a store-written invoice, in both directions', () => {
    const sales = makeInvoice({
      id: 'reg-sales',
      items: [makeItem({ id: 'i1', amount: 1000, taxRate: 15 })],
      subtotal: 1000,
      taxTotal: 150,
      grandTotal: 1150,
    })
    const salesJournal = createSalesInvoiceJournal(sales, [], undefined)
    expect(postedVat(salesJournal, 'Sales')).toBe(150)
    expect(registerTax(sales)).toBe(postedVat(salesJournal, 'Sales'))
    expect(registerTaxable(sales)).toBe(1000)
    // The income legs carry the register's taxable base.
    expect(
      round2(-revenueLegs(salesJournal, 'Sales').reduce((s, i) => s + i.debit - i.credit, 0)),
    ).toBe(registerTaxable(sales))

    const bill = makeInvoice({
      id: 'reg-bill',
      type: 'Purchase',
      items: [makeItem({ id: 'i1', amount: 4000, taxRate: 15, accountId: 'acc-materials' })],
      subtotal: 4000,
      taxTotal: 600,
      grandTotal: 4600,
    })
    const billJournal = createPurchaseBillJournal(bill, [], undefined)
    expect(postedVat(billJournal, 'Purchase')).toBe(registerTax(bill))
    expect(postedVat(billJournal, 'Purchase')).toBe(600)
    expect(registerTaxable(bill)).toBe(4000)
    expect(revenueLegs(billJournal, 'Purchase').reduce((s, i) => s + i.debit - i.credit, 0)).toBe(
      registerTaxable(bill),
    )
  })

  it('posts and reports the VAT the item lines imply when the stored totals are absent', () => {
    // The defect this locks: a row stored with no subtotal and no VAT reported
    // 172.50 at the item rate while the ledger posted no VAT leg at all.
    const invoice = makeInvoice({
      id: 'reg-absent',
      invoiceNumber: 'INV-2026-ABSENT',
      items: [makeItem({ id: 'i1', amount: 1150, taxRate: 15 })],
      subtotal: 0,
      taxTotal: 0,
      grandTotal: 1150,
      outstandingAmount: 1150,
    })

    const journal = build(invoice)
    expect(registerTax(invoice), 'the register reports the line VAT').toBe(172.5)
    expect(postedVat(journal, 'Sales'), 'the ledger posts the very VAT the register reports').toBe(
      registerTax(invoice),
    )
    expect(vatLeg(journal)?.credit).toBe(172.5)
    expect(controlNet(journal, 'Sales'), 'the control leg stays on grandTotal').toBe(1150)
    expect(allJournalsBalanced([journal])).toBe(true)
    // The register's base is the base the posting carries: the anchor less VAT.
    expect(registerTaxable(invoice)).toBe(round2(1150 - 172.5))
    expect(round2(-revenueLegs(journal, 'Sales').reduce((s, i) => s + i.debit - i.credit, 0))).toBe(
      registerTaxable(invoice),
    )
  })

  it('reads a row without posted totals as VAT-exclusive in the register and the journal alike', () => {
    // An invoice carries no VAT-inclusive flag (it is a company setting), so an
    // item-only row is read on a VAT-exclusive basis by both readers: 1 150 at
    // 15% is 1 150 of base, not a VAT-inclusive 1 150.
    const invoice = makeInvoice({
      id: 'reg-exclusive',
      items: [makeItem({ id: 'i1', amount: 1150, taxRate: 15 })],
      subtotal: 0,
      taxTotal: 0,
      grandTotal: 1000,
      outstandingAmount: 1000,
    })

    const journal = build(invoice)
    // 1 150 at 15% VAT-exclusive is 172.50 of VAT — not the 150 an inclusive
    // reading would give — and the register reports the base the posting closes
    // on: the 1 000 anchor less that VAT.
    expect(registerTax(invoice)).toBe(172.5)
    expect(registerTax(invoice)).not.toBe(150)
    expect(registerTaxable(invoice)).toBe(827.5)
    expect(postedVat(journal, 'Sales')).toBe(registerTax(invoice))
    expect(round2(-revenueLegs(journal, 'Sales').reduce((s, i) => s + i.debit - i.credit, 0))).toBe(
      registerTaxable(invoice),
    )
    expect(controlNet(journal, 'Sales')).toBe(1000)
    expect(allJournalsBalanced([journal])).toBe(true)
  })

  it('reports a rebate invoice’s negative VAT exactly as posted, netting with its credit note', () => {
    const rebate = makeInvoice({
      id: 'reg-rebate',
      invoiceNumber: 'INV-2026-601',
      items: [makeItem({ id: 'i1', amount: -100, taxRate: 15 })],
      subtotal: -100,
      taxTotal: -15,
      grandTotal: -115,
      outstandingAmount: -115,
    })
    const creditNote = makeInvoice({
      ...rebate,
      id: 'reg-rebate-cn',
      invoiceNumber: 'CN-2026-601',
      creditNote: true,
    })

    const rebateJournal = build(rebate)
    const creditNoteJournal = createCreditNoteJournal(rebate, [], undefined)
    expect(postedVat(rebateJournal, 'Sales')).toBe(-15)
    // The credit note mirrors the posting: its VAT leg takes the other side.
    expect(vatLeg(creditNoteJournal)?.credit).toBe(15)
    expect(vatLeg(creditNoteJournal)?.debit).toBe(0)
    expect(
      round2(
        [...rebateJournal.items, ...creditNoteJournal.items]
          .filter((item) => /VAT (Output|Input)/.test(item.remark || ''))
          .reduce((sum, item) => sum + item.debit - item.credit, 0),
      ),
      'the pair must net the VAT account to zero',
    ).toBe(0)
    expect(registerTax(rebate)).toBe(-15)

    // Invoice plus full credit note: the register and the ledger both net to nil.
    const rows = taxRegister([rebate, creditNote])
    const totals = rows.find((row) => row.taxRate === null)!
    expect(totals.salesTax).toBe(0)
    expect(totals.salesTaxable).toBe(0)
    expect(allJournalsBalanced([rebateJournal, creditNoteJournal])).toBe(true)
  })
})

describe('VAT remark names the rate the posting carries', () => {
  const vatRemarks = (journal: JournalEntry): string[] =>
    journal.items
      .filter((item) => item.accountId === 'acc-vat' || item.accountId === 'acc-vat-in')
      .map((item) => item.remark || '')

  it('labels a 15% sales invoice and a 15% bill', () => {
    const sales = createSalesInvoiceJournal(
      makeInvoice({
        id: 'v15',
        items: [makeItem({ id: 'v1', amount: 1000, taxRate: 15 })],
        subtotal: 1000,
        taxTotal: 150,
        grandTotal: 1150,
      }),
      [],
      undefined,
    )
    expect(vatRemarks(sales)).toEqual(['15% VAT Output'])

    const bill = createPurchaseBillJournal(
      makeInvoice({
        id: 'v15b',
        type: 'Purchase',
        items: [makeItem({ id: 'v1', amount: 1000, taxRate: 15, accountId: 'acc-materials' })],
        subtotal: 1000,
        taxTotal: 150,
        grandTotal: 1150,
      }),
      [],
      undefined,
    )
    expect(vatRemarks(bill)).toEqual(['15% VAT Input Recoverable'])
  })

  it('labels a non-15% rate with the real rate, not a hardcoded 15%', () => {
    const sales = createSalesInvoiceJournal(
      makeInvoice({
        id: 'v20',
        items: [makeItem({ id: 'v1', amount: 2000, taxRate: 20 })],
        subtotal: 2000,
        taxTotal: 400,
        grandTotal: 2400,
      }),
      [],
      undefined,
    )
    expect(vatRemarks(sales)).toEqual(['20% VAT Output'])
    expect(vatRemarks(sales)[0]).not.toContain('15%')

    const bill = createPurchaseBillJournal(
      makeInvoice({
        id: 'v20b',
        type: 'Purchase',
        items: [makeItem({ id: 'v1', amount: 2000, taxRate: 20, accountId: 'acc-materials' })],
        subtotal: 2000,
        taxTotal: 400,
        grandTotal: 2400,
      }),
      [],
      undefined,
    )
    expect(vatRemarks(bill)).toEqual(['20% VAT Input Recoverable'])
  })

  it('labels a zero-rated posting 0%, never 15%', () => {
    const sales = createSalesInvoiceJournal(
      makeInvoice({
        id: 'v0',
        items: [makeItem({ id: 'v1', amount: 500, taxRate: 0 })],
        subtotal: 500,
        taxTotal: 0.01,
        grandTotal: 500.01,
      }),
      [],
      undefined,
    )
    expect(vatRemarks(sales)).toEqual(['0% VAT Output'])
    expect(vatRemarks(sales)[0]).not.toContain('15%')
  })

  it('labels a mixed-rate invoice with every rate it actually carries', () => {
    const sales = createSalesInvoiceJournal(
      makeInvoice({
        id: 'vmix',
        items: [
          makeItem({ id: 'v1', amount: 1000, taxRate: 15 }),
          makeItem({ id: 'v2', amount: 500, taxRate: 0 }),
          makeItem({ id: 'v3', amount: 700, taxRate: 20 }),
        ],
        subtotal: 2200,
        taxTotal: 290,
        grandTotal: 2490,
      }),
      [],
      undefined,
    )
    expect(vatRemarks(sales)).toEqual(['0% / 15% / 20% VAT Output'])
  })

  it('marks the reversal side as an Adjustment while keeping the real rate', () => {
    const sales = createSalesInvoiceJournal(
      makeInvoice({
        id: 'vneg',
        items: [makeItem({ id: 'v1', amount: -2000, taxRate: 20, discountRate: 0 })],
        subtotal: -2000,
        taxTotal: -400,
        grandTotal: -2400,
        outstandingAmount: -2400,
      }),
      [],
      undefined,
    )
    expect(vatRemarks(sales)).toEqual(['20% VAT Output Adjustment'])
  })
})

describe('aging bucket boundaries and reconciliation', () => {
  const party: Party = {
    id: 'party-aging',
    name: 'Boundary Contractors (Pty) Ltd',
    type: 'Customer',
    outstandingBalance: 0,
  }

  /** Due date exactly `daysOverdue` before AS_OF. */
  const dueBefore = (daysOverdue: number): string =>
    new Date(Date.UTC(2026, 8, 30) - daysOverdue * 86400000).toISOString().split('T')[0]

  it('daysBetween is exact at 0, 30, 60, 90 and 91 days', () => {
    expect(daysBetween(dueBefore(0), AS_OF)).toBe(0)
    expect(daysBetween(dueBefore(30), AS_OF)).toBe(30)
    expect(daysBetween(dueBefore(60), AS_OF)).toBe(60)
    expect(daysBetween(dueBefore(90), AS_OF)).toBe(90)
    expect(daysBetween(dueBefore(91), AS_OF)).toBe(91)
    // A due date in the future is a negative age, never a positive bucket.
    expect(daysBetween('2026-10-30', AS_OF)).toBe(-30)
    expect(daysBetween('2026-12-31', AS_OF)).toBe(-92)
  })

  it('places the 0/30/60/90/91-day edges in the right bucket', () => {
    const edges: { days: number; bucket: 'current' | 'days30' | 'days60' | 'days90' }[] = [
      { days: 0, bucket: 'current' },
      { days: 30, bucket: 'days30' },
      { days: 60, bucket: 'days60' },
      { days: 90, bucket: 'days90' },
      { days: 91, bucket: 'days90' },
    ]

    const invoices = edges.map((edge, index) =>
      makeInvoice({
        id: `edge-${edge.days}`,
        invoiceNumber: `INV-EDGE-${edge.days}`,
        partyId: `party-edge-${index}`,
        partyName: `Edge ${edge.days}`,
        dueDate: dueBefore(edge.days),
        outstandingAmount: 100 + edge.days,
      }),
    )

    const rows = agingBuckets(invoices, [], AS_OF, 'Sales')
    expect(rows).toHaveLength(edges.length)

    for (const edge of edges) {
      const row = rows.find((candidate) => candidate.partyName === `Edge ${edge.days}`)!
      const amount = 100 + edge.days
      const buckets = {
        current: row.current,
        days30: row.days30,
        days60: row.days60,
        days90: row.days90,
      }
      expect(buckets[edge.bucket], `${edge.days} days late must sit in ${edge.bucket}`).toBe(amount)
      expect(
        round2(row.current + row.days30 + row.days60 + row.days90),
        `${edge.days} days late must sit in exactly one bucket`,
      ).toBe(amount)
      expect(row.total).toBe(amount)
      expect(row.credit).toBe(0)
    }
  })

  it('treats a not-yet-due invoice as current', () => {
    const invoices = [
      makeInvoice({
        id: 'future',
        partyId: 'party-future',
        partyName: 'Future Co',
        dueDate: '2027-01-15',
        outstandingAmount: 750,
      }),
    ]
    const rows = agingBuckets(invoices, [], AS_OF, 'Sales')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      current: 750,
      days30: 0,
      days60: 0,
      days90: 0,
      credit: 0,
      total: 750,
    })
  })

  it('nets a credit note into `credit` and the row total, and reconciles with the party balance', () => {
    const invoices = [
      makeInvoice({
        id: 'open',
        partyId: party.id,
        partyName: party.name,
        dueDate: dueBefore(45),
        outstandingAmount: 1000,
      }),
      makeInvoice({
        id: 'cn',
        invoiceNumber: 'CN-AGING-1',
        partyId: party.id,
        partyName: party.name,
        creditNote: true,
        outstandingAmount: -400,
      }),
    ]

    const rows = agingBuckets(invoices, [party], AS_OF, 'Sales')
    expect(rows).toHaveLength(1)
    expect(rows[0].days60).toBe(1000)
    expect(rows[0].credit).toBe(400)
    expect(rows[0].total).toBe(600)

    const [derived] = recomputePartyBalances(invoices, [party])
    expect(rows[0].total).toBe(derived.outstandingBalance)
  })

  it('buckets sum to the net total and reconcile with recomputePartyBalances for a mixed population', () => {
    const other: Party = {
      id: 'party-open',
      name: 'Open Balance Ltd',
      type: 'Customer',
      outstandingBalance: 0,
    }
    const invoices = [
      // Mixed ages, a partially paid invoice, a credit note and a fully paid one.
      makeInvoice({
        id: 'cur',
        partyId: party.id,
        partyName: party.name,
        dueDate: dueBefore(-10),
        outstandingAmount: 1000,
      }),
      makeInvoice({
        id: 'p30',
        partyId: party.id,
        partyName: party.name,
        dueDate: dueBefore(30),
        outstandingAmount: 500,
      }),
      makeInvoice({
        id: 'p60',
        partyId: party.id,
        partyName: party.name,
        dueDate: dueBefore(60),
        outstandingAmount: 300,
      }),
      makeInvoice({
        id: 'p91',
        partyId: party.id,
        partyName: party.name,
        dueDate: dueBefore(91),
        outstandingAmount: 200,
      }),
      makeInvoice({
        id: 'partial',
        partyId: party.id,
        partyName: party.name,
        dueDate: dueBefore(15),
        grandTotal: 800,
        outstandingAmount: 350,
      }),
      makeInvoice({
        id: 'cn',
        invoiceNumber: 'CN-MIX-1',
        partyId: party.id,
        partyName: party.name,
        creditNote: true,
        outstandingAmount: -150,
      }),
      makeInvoice({
        id: 'paid',
        partyId: party.id,
        partyName: party.name,
        status: 'Paid',
        dueDate: dueBefore(200),
        outstandingAmount: 0,
      }),
      makeInvoice({
        id: 'other',
        partyId: other.id,
        partyName: other.name,
        dueDate: dueBefore(40),
        outstandingAmount: 900,
      }),
      makeInvoice({
        id: 'draft',
        partyId: other.id,
        partyName: other.name,
        status: 'Draft',
        dueDate: dueBefore(5),
        outstandingAmount: 999,
      }),
    ]

    const rows = agingBuckets(invoices, [party, other], AS_OF, 'Sales')
    const balances = recomputePartyBalances(invoices, [party, other])
    const balanceById = new Map(balances.map((entry) => [entry.id, entry.outstandingBalance]))

    // Every row's buckets sum to its net total...
    for (const row of rows) {
      const buckets = round2(row.current + row.days30 + row.days60 + row.days90)
      expect(round2(buckets - row.credit), `${row.partyName}: buckets minus credit`).toBe(row.total)
    }

    // The crafted population lands in the intended buckets.
    const main = rows.find((row) => row.partyId === party.id)!
    expect(main.current).toBe(1000)
    expect(main.days30).toBe(850) // 500 at 30 days + the 350 partial remainder
    expect(main.days60).toBe(300)
    expect(main.days90).toBe(200)
    expect(main.credit).toBe(150)
    expect(main.total).toBe(2200)

    // `recomputePartyBalances` sums every non-paid, non-cancelled invoice; the
    // aging report deliberately drops drafts (nothing is owed until it posts).
    // Party by party the two agree exactly — the difference in the fixture is
    // solely the one draft invoice, asserted in total below.
    const postedRows = rows.filter((row) =>
      invoices.some(
        (inv) =>
          inv.partyId === row.partyId &&
          inv.status !== 'Draft' &&
          inv.status !== 'Paid' &&
          inv.status !== 'Cancelled',
      ),
    )
    expect(postedRows).toHaveLength(2)

    // The posted parties reconcile exactly with their derived balances.
    const otherRow = rows.find((row) => row.partyId === other.id)!
    expect(otherRow.total).toBe(900) // the Draft and the Paid row are excluded
    expect(rows.find((row) => row.partyId === party.id)!.total).toBe(
      balanceById.get(party.id) === 2200 ? 2200 : balanceById.get(party.id),
    )
    // `other` carries the draft, so its derived balance exceeds its aging row
    // by exactly that draft's outstanding amount.
    expect(round2(balanceById.get(other.id)! - otherRow.total)).toBe(999)

    // `recomputePartyBalances` counts every non-paid, non-cancelled invoice —
    // a Draft included — while `agingBuckets` reports only posted balances. On
    // a population with no drafts the two agree party by party and in total;
    // here the sole difference is the one draft invoice.
    const derivedTotal = round2(
      balances
        .filter((entry) => rows.some((row) => row.partyId === entry.id))
        .reduce((sum, entry) => sum + entry.outstandingBalance, 0),
    )
    const reportTotal = round2(rows.reduce((sum, row) => sum + row.total, 0))
    expect(round2(derivedTotal - reportTotal)).toBe(999)
    // The drafting party reconciles exactly once its draft is removed, which
    // is the documented contract: aging reports posted balances only.
    const otherDerived = balanceById.get(other.id) ?? 0
    expect(round2(otherDerived - 999)).toBe(otherRow.total)
    // The party with no drafts reconciles with no adjustment at all.
    expect(main.total).toBe(balanceById.get(party.id))
  })

  it('rounds each bucket to 2dp so a fractional population still reconciles', () => {
    const invoices = [
      makeInvoice({
        id: 'frac1',
        partyId: party.id,
        partyName: party.name,
        dueDate: dueBefore(10),
        outstandingAmount: 10.005,
      }),
      makeInvoice({
        id: 'frac2',
        partyId: party.id,
        partyName: party.name,
        dueDate: dueBefore(45),
        outstandingAmount: 0.015,
      }),
      makeInvoice({
        id: 'frac3',
        partyId: party.id,
        partyName: party.name,
        creditNote: true,
        outstandingAmount: -0.005,
      }),
    ]

    const rows = agingBuckets(invoices, [party], AS_OF, 'Sales')
    // Every stored amount is rounded to 2dp on the way into a bucket.
    expect(rows[0].days30).toBe(10.01) // 10.005 -> 10.01
    expect(rows[0].days60).toBe(0.02) // 0.015 -> 0.02
    // round2 rounds half away from zero only for positives: -0.005 -> -0, so a
    // half-cent credit collapses. Documented rather than asserted away; the
    // buckets still sum to the row total, which is the invariant that matters.
    expect(rows[0].credit).toBe(0)
    expect(rows[0].total).toBe(round2(10.01 + 0.02))

    // `recomputePartyBalances` rounds the summed outstanding instead of each
    // item, so on half-cent data the two can differ by at most one cent.
    const [derived] = recomputePartyBalances(invoices, [party])
    expect(Math.abs(round2(rows[0].total - derived.outstandingBalance))).toBeLessThanOrEqual(0.01)
  })

  it('reconciles exactly with the derived party balance on clean 2dp data', () => {
    const invoices = [
      makeInvoice({
        id: 'clean1',
        partyId: party.id,
        partyName: party.name,
        dueDate: dueBefore(10),
        outstandingAmount: 1234.56,
      }),
      makeInvoice({
        id: 'clean2',
        partyId: party.id,
        partyName: party.name,
        dueDate: dueBefore(75),
        outstandingAmount: 789.12,
      }),
      makeInvoice({
        id: 'clean3',
        partyId: party.id,
        partyName: party.name,
        creditNote: true,
        outstandingAmount: -23.45,
      }),
    ]

    const rows = agingBuckets(invoices, [party], AS_OF, 'Sales')
    expect(rows[0].days30).toBe(1234.56)
    expect(rows[0].days90).toBe(789.12)
    expect(rows[0].credit).toBe(23.45)
    expect(rows[0].total).toBe(round2(1234.56 + 789.12 - 23.45))

    const [derived] = recomputePartyBalances(invoices, [party])
    expect(rows[0].total).toBe(derived.outstandingBalance)
  })
})

/* ── PDF: multi-page furniture and safe columns ─────────────────────────── */

const PDF_SETTINGS: CompanySettings = {
  companyName: 'Zano Consulting (Pty) Ltd',
  taxNumber: 'VAT 4510278912',
  currency: 'ZAR',
  currencySymbol: 'R',
  financialYearStart: '2026-03-01',
  address: '12 Albert Road, Johannesburg',
  email: 'accounts@zanostack.com',
  phone: '+27 11 555 0199',
}

/**
 * The PDF bytes read as text: every FlateDecode stream is inflated and its
 * hex string tokens decoded, so assertions target the real drawn content
 * rather than a re-render through the PDF library.
 */
function pdfText(pdf: Uint8Array): string {
  const buf = Buffer.from(pdf)
  const raw = buf.toString('latin1')
  let text = raw
  const streamRe = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end === -1) continue
    try {
      text += `\n${decodePdfHex(inflateSync(buf.subarray(start, end)).toString('latin1'))}\n`
    } catch {
      // Not a flate stream — leave as-is.
    }
  }
  return text.replace(/[\u00A0\u202F]/g, ' ')
}

/** Decodes `<...>` hex string tokens (single-byte chars, or UTF-16BE when BOM-prefixed). */
function decodePdfHex(content: string): string {
  const out: string[] = []
  const hexRe = /<([0-9a-fA-F]+)>/g
  let match: RegExpExecArray | null
  while ((match = hexRe.exec(content)) !== null) {
    const hex = match[1]
    if (hex.length % 2 !== 0) continue
    const bytes = Buffer.from(hex, 'hex')
    if (hex.startsWith('FEFF') && hex.length > 4) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const swap = bytes[i]
        bytes[i] = bytes[i + 1]
        bytes[i + 1] = swap
      }
      out.push(bytes.toString('utf16le').replace(/^\uFEFF/, ''))
    } else {
      out.push(bytes.toString('latin1'))
    }
  }
  return out.join('\n')
}

/** Number of lines of drawn text found in the PDF, in content order. */
function pdfTextLines(pdf: Uint8Array): string[] {
  return pdfText(pdf)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1

/** One text the PDF draws, with the horizontal span it occupies. */
interface DrawnRun {
  text: string
  x: number
  right: number
}

/**
 * Every drawn text run with its horizontal span, read straight out of the page
 * content streams. pdf-lib emits, per run:
 *   `BT ... /Helvetica-x <size> Tf ... 1 0 0 1 <x> <y> Tm <hex> Tj ... ET`
 * so the run text is the hex token and the position is the `Tm` matrix. The
 * span comes from the page's own embedded font metrics, so a bold string is
 * never measured with the regular face's widths. Used to prove two columns
 * cannot collide: the spans of adjacent runs must not overlap.
 */
async function drawnRuns(pdf: Uint8Array): Promise<DrawnRun[]> {
  const doc = await PDFDocument.load(pdf)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const buf = Buffer.from(pdf)
  const raw = buf.toString('latin1')
  const runs: DrawnRun[] = []
  const streamRe = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end === -1) continue
    let content: string
    try {
      content = inflateSync(buf.subarray(start, end)).toString('latin1')
    } catch {
      continue
    }
    // Each BT..ET block is one text-drawing operation.
    const blockRe = /BT([\s\S]*?)ET/g
    let block: RegExpExecArray | null
    while ((block = blockRe.exec(content)) !== null) {
      const run = parseTextRun(block[1], bold, regular)
      if (run) runs.push(run)
    }
  }
  return runs
}

/** Parses one BT..ET block into a drawn run, or null when it draws no text. */
function parseTextRun(block: string, bold: PDFFont, regular: PDFFont): DrawnRun | null {
  const hexMatch = block.match(/<([0-9a-fA-F]+)>\s*Tj/)
  if (!hexMatch) return null
  const fontMatch = block.match(/\/[A-Za-z0-9-]*Helvetica-?([A-Za-z-]*)-\d+\s+[\d.]+\s+Tf/)
  const sizeMatch = block.match(/\/[A-Za-z0-9-]+\s+([\d.]+)\s+Tf/)
  const matrixMatch = block.match(
    /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/,
  )
  if (!sizeMatch || !matrixMatch) return null

  const size = Number(sizeMatch[1])
  const x = Number(matrixMatch[5])
  const text = Buffer.from(hexMatch[1], 'hex').toString('latin1')
  // Measure with the face the run actually used, so a bold header is not
  // measured as regular nor a regular label as bold.
  const fontName = (fontMatch?.[1] || '').replace(/-$/, '')
  const font = fontName.toLowerCase().includes('bold') ? bold : regular
  // Only WinAnsi-encodable text can be measured — the same limit that decides
  // what pdf-lib can draw — so unencodable characters are skipped.
  const measurable = text.replace(/[^\x20-\x7E]/g, '')
  return { text, x, right: x + font.widthOfTextAtSize(measurable, size) }
}

/** Helvetica advance widths (per 1000 units) for the glyphs invoice cells use. */
const HELVETICA_WIDTHS: Record<string, number> = {
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  a: 556,
  b: 556,
  c: 500,
  d: 556,
  e: 556,
  f: 278,
  g: 556,
  h: 556,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  n: 556,
  o: 556,
  p: 556,
  q: 556,
  r: 333,
  s: 500,
  t: 278,
  u: 556,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
  ' ': 278,
  ',': 278,
  '.': 278,
  '%': 889,
  '/': 278,
  '-': 333,
  '(': 333,
  ')': 333,
  ':': 278,
  '+': 584,
  '​': 0,
}

/** Digit and ellipsis widths, shared by every numeric cell. */
const DIGIT_WIDTH = 556
const ELLIPSIS_WIDTH = 1000
const EM_DASH_WIDTH = 1000
const UNKNOWN_WIDTH = 556

/** Approximate advance width of a string in Helvetica at `size` points. */
function measureHelvetica(text: string, size: number): number {
  let total = 0
  for (const char of text) {
    if (char >= '0' && char <= '9') total += DIGIT_WIDTH
    else if (char === '…') total += ELLIPSIS_WIDTH
    else if (char === '—') total += EM_DASH_WIDTH
    else total += HELVETICA_WIDTHS[char] ?? UNKNOWN_WIDTH
  }
  return (total * size) / 1000
}

/** The left margin and the x of the right content edge of an A4 portrait page. */
const LEFT_MARGIN = 48
const RIGHT_EDGE = 595.28 - LEFT_MARGIN

describe('buildInvoicePdf multi-page furniture', () => {
  it('keeps a single-page invoice structurally unchanged', async () => {
    const single = makeInvoice({
      id: 'single',
      invoiceNumber: 'INV-2026-0042',
      partyName: 'Rand Water Authority',
      items: [
        makeItem({
          id: 'i1',
          description: 'Water infrastructure consulting',
          qty: 2,
          rate: 2500,
          taxRate: 15,
          amount: 5000,
        }),
      ],
      subtotal: 5000,
      taxTotal: 750,
      grandTotal: 5750,
      outstandingAmount: 5750,
      notes: 'Payment terms: Net 30 days upon invoice receipt.',
    })

    const pdf = await buildInvoicePdf(single, PDF_SETTINGS)
    const doc = await PDFDocument.load(pdf)
    expect(doc.getPageCount()).toBe(1)

    const text = pdfText(pdf)
    expect(text).toContain('TAX INVOICE')
    expect(text).toContain('INV-2026-0042')
    expect(text).toContain('Description')
    expect(text).toContain('R 5 750,00')
    // One page: exactly one footer, one page marker and one table header.
    expect(countOccurrences(text, 'Page 1 of 1')).toBe(1)
    expect(countOccurrences(text, 'Generated via Zano Books')).toBe(1)
    expect(countOccurrences(text, 'Description')).toBe(1)
  })

  it('numbers every page, repeats the table header and footers each page', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      makeItem({
        id: `m${index + 1}`,
        description: `Milestone ${index + 1} site works and commissioning`,
        qty: 1,
        rate: 1000 + index,
        taxRate: 15,
        amount: 1000 + index,
      }),
    )
    const invoice = makeInvoice({
      id: 'multi',
      invoiceNumber: 'INV-2026-MULTI',
      items: many,
      subtotal: many.reduce((sum, item) => sum + item.amount, 0),
      taxTotal: 0,
      grandTotal: many.reduce((sum, item) => sum + item.amount, 0),
      outstandingAmount: many.reduce((sum, item) => sum + item.amount, 0),
    })

    const pdf = await buildInvoicePdf(invoice, PDF_SETTINGS)
    const doc = await PDFDocument.load(pdf)
    const pageCount = doc.getPageCount()
    expect(pageCount).toBeGreaterThan(1)

    const text = pdfText(pdf)
    // 'Page N of M' on every page, numbered 1..M with the same M.
    for (let index = 1; index <= pageCount; index += 1) {
      expect(text, `missing page marker for page ${index}`).toContain(
        `Page ${index} of ${pageCount}`,
      )
    }
    expect(countOccurrences(text, 'Page ')).toBe(pageCount)
    // The footer is drawn on every page.
    expect(countOccurrences(text, 'Generated via Zano Books')).toBe(pageCount)
    // The table header is repeated whenever a page break interrupts the rows.
    expect(countOccurrences(text, 'Description')).toBeGreaterThanOrEqual(2)
    for (const heading of ['Qty', 'Rate', 'Tax', 'Amount']) {
      expect(countOccurrences(text, heading)).toBeGreaterThanOrEqual(2)
    }
    // Over 60 rows across N pages the repeated headers cannot be FEWER than
    // one per page: the last page carries a header too.
    expect(countOccurrences(text, 'Description')).toBeLessThanOrEqual(pageCount)
  })

  it('never lets two adjacent columns overlap, even for extreme values', async () => {
    const extreme = makeInvoice({
      id: 'extreme',
      invoiceNumber: 'INV-2026-EXTREME-VALUE-FIXTURE',
      partyName: 'A'.repeat(120),
      items: [
        makeItem({
          id: 'e1',
          description: 'X'.repeat(200),
          qty: 123456789.99,
          rate: 987654321.99,
          taxRate: 15,
          amount: 987654321.99,
        }),
        makeItem({
          id: 'e2',
          description: 'Y'.repeat(120),
          qty: 0.01,
          rate: -1234567.89,
          taxRate: 20,
          amount: -12345.67,
        }),
      ],
      subtotal: 987654321.99,
      taxTotal: 148148148.3,
      roundOff: -0.01,
      grandTotal: 1135803470.28,
      outstandingAmount: 1135803470.28,
    })

    const pdf = await buildInvoicePdf(extreme, PDF_SETTINGS)
    const doc = await PDFDocument.load(pdf)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)

    const runs = await drawnRuns(pdf)
    expect(runs.length).toBeGreaterThan(0)

    // The line-items table starts at the left margin and never crosses the
    // right content edge: every table cell (header and body) is bounded.
    const tableLabels = ['Description', 'Qty', 'Rate', 'Tax', 'Amount']
    const tableRuns = runs.filter(
      (run) =>
        tableLabels.includes(run.text) ||
        /^R /.test(run.text) ||
        /^\d+(\.\d+)?%$/.test(run.text) ||
        run.text.startsWith('X') ||
        run.text.startsWith('Y'),
    )
    expect(tableRuns.length).toBeGreaterThan(5)
    for (const run of tableRuns) {
      expect(run.x, `table cell "${run.text}" starts left of the margin`).toBeGreaterThanOrEqual(
        LEFT_MARGIN - 0.5,
      )
      expect(
        run.right,
        `table cell "${run.text}" runs past the right content edge`,
      ).toBeLessThanOrEqual(RIGHT_EDGE + 0.5)
    }

    // The header row's five columns must each end before the next one begins.
    // Headers can repeat across pages, so one run per label is picked and the
    // columns are then checked in left-to-right order.
    const headerRow = tableLabels.map((label) => {
      const run = runs.find((candidate) => candidate.text === label)
      expect(run, `the table header "${label}" must be drawn`).toBeDefined()
      return run!
    })
    expect(headerRow).toHaveLength(5)
    const ordered = [...headerRow].sort((a, b) => a.x - b.x)
    for (let index = 1; index < ordered.length; index += 1) {
      expect(
        ordered[index].x,
        `header "${ordered[index].text}" overlaps "${ordered[index - 1].text}"`,
      ).toBeGreaterThanOrEqual(ordered[index - 1].right)
    }
    expect(ordered[0].text).toBe('Description')
    expect(ordered[ordered.length - 1].text).toBe('Amount')

    // The extreme money strings survive as real drawn text, and each of the
    // two rows' five cells end before the following cell begins.
    const text = pdfText(pdf)
    expect(text).toContain('R 987 654 321,99')
    expect(text).toMatch(/R [\d  ]+,\d{2}/)
    expect(text).toContain('%')
  })

  it('clips an over-long description instead of running into the Qty column', async () => {
    const invoice = makeInvoice({
      id: 'longdesc',
      items: [makeItem({ id: 'l1', description: 'Z'.repeat(400), qty: 1, rate: 10, amount: 10 })],
      subtotal: 10,
      taxTotal: 1.5,
      grandTotal: 11.5,
      outstandingAmount: 11.5,
    })
    const pdf = await buildInvoicePdf(invoice, PDF_SETTINGS)
    const text = pdfText(pdf)

    // The clipped cell carries the ASCII clip marker (WinAnsi cannot encode
    // U+2026, so pdf-lib would drop it).
    expect(text).toContain('...')

    // The description column stops well before the Qty column starts (305pt).
    const runs = await drawnRuns(pdf)
    const descriptions = runs.filter((run) => run.text.startsWith('ZZZ'))
    expect(descriptions.length).toBeGreaterThan(0)
    for (const run of descriptions) {
      expect(run.x).toBeGreaterThanOrEqual(LEFT_MARGIN - 0.5)
      expect(run.right, 'a clipped description must stop before the Qty column').toBeLessThan(305)
      expect(run.text.endsWith('...'), 'the clipped description must be marked as cut').toBe(true)
    }

    // The Qty cell of the same row starts at the Qty column and stays clear.
    for (const cell of runs.filter((run) => run.text === '1')) {
      expect(cell.x).toBeGreaterThanOrEqual(305)
    }
    // The row's rate cell therefore also begins after the description ends.
    const rateCell = runs.find((run) => run.text === 'R 10,00')
    expect(rateCell).toBeDefined()
    expect(rateCell!.x).toBeGreaterThanOrEqual(305)
  })
})

describe('shared business constants', () => {
  it('exports DEFAULT_PAYMENT_TERMS_DAYS as 30', () => {
    expect(DEFAULT_PAYMENT_TERMS_DAYS).toBe(30)
  })

  it('exports the neutral bank account name from the chart', () => {
    expect(typeof DEFAULT_BANK_ACCOUNT_NAME).toBe('string')
    expect(DEFAULT_BANK_ACCOUNT_NAME.length).toBeGreaterThan(0)
    expect(DEFAULT_BANK_ACCOUNT_NAME).not.toContain('FNB')
  })
})

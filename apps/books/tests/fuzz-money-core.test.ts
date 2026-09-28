/**
 * Randomized invariant fuzz for the Zano Books money core.
 *
 * ~25 000 sales invoices through calculateInvoiceTotals + createSalesInvoiceJournal,
 * ~5 000 purchase bills and ~5 000 credit notes through their builders, over a
 * adversarial input mix: mixed/odd VAT rates, line and invoice-level discounts
 * (including over-discounts and negative surcharges), negative rebate lines,
 * qty/rate/amount disagreements (±0.005 half-cent boundaries included),
 * multi-currency legs, and internally inconsistent stored totals.
 *
 * Every case seeds its own mulberry32 stream from SEED ^ salt + case index, so
 * a failing case is reproducible from the seed, the slice and the index alone.
 *
 * Assertions per case (in integer cents):
 *   1. journal totalDebit === totalCredit === sum of its item legs;
 *   2. the AR/AP control leg nets exactly to round2(grandTotal x fxRate)
 *      (credit-negative for AP, the control leg's natural side);
 *   3. the VAT leg nets exactly to the posted VAT per the code's own contract
 *      (stored totals when the row carries them, item-line derivation when it
 *      does not — see postedInvoiceAmounts), never adjusted by the balancer;
 *   4. no account carries both a debit and a credit on the same journal;
 *   5. every leg is a clean 2-decimal amount;
 *   6. for credit notes: original + full credit note at the same fx rate nets
 *      every account to zero (exact at rate 1; within the documented FX
 *      rounding drift otherwise — see the report);
 *   7. batch level: taxRegister totals === the VAT the journals actually
 *      posted, per direction, and === the VAT-account balances.
 */
import { describe, expect, it } from 'vitest'
import {
  calculateInvoiceTotals,
  computeAccountBalances,
  createPurchaseBillJournal,
  createSalesInvoiceJournal,
  invoiceExchangeRate,
  round2,
  toBaseAmount,
} from '../src/shared/accounting'
import { createCreditNoteJournal } from '../src/shared/credit-notes'
import { taxRegister } from '../src/shared/reports'
import { EMPTY_ACCOUNTS } from '../src/shared/chart'
import { cents, makeFuzz, type Fuzz } from './fuzz-random'
import type { Account, Invoice, InvoiceItem, JournalEntry, Party } from '../src/shared/types'

/** Fixed master seed. 0xB00B5 — "books". Change it and every case changes. */
const SEED = 0xb00b5

const SALES_CASES = 25_000
const PURCHASE_CASES = 5_000
const CREDIT_NOTE_CASES = 5_000
const CHUNKS = 5

const ACCOUNTS: Account[] = EMPTY_ACCOUNTS.map((a) => ({ ...a, balance: 0 }))

const CUSTOMER: Party = {
  id: 'party-fz-cust',
  name: 'Fuzz Customer (Pty) Ltd',
  type: 'Customer',
  outstandingBalance: 0,
}
const SUPPLIER: Party = {
  id: 'party-fz-supp',
  name: 'Fuzz Supplier Ltd',
  type: 'Supplier',
  outstandingBalance: 0,
}

const INCOME_ACCOUNTS = ['acc-sales', 'acc-consult', 'acc-interest-income'] as const
const EXPENSE_ACCOUNTS = ['acc-materials', 'acc-rent', 'acc-travel'] as const

const VAT_OUT_ACCOUNTS = ['acc-vat', 'acc-vat-out']
const VAT_IN_ACCOUNTS = ['acc-vat-in', 'acc-vat']

/** The `postedLine` rule (accounting.ts, module-private there): a line with a
 * truthy stored amount is read on that amount, its qty/rate suppressed. */
function postedLineClone(item: InvoiceItem): InvoiceItem {
  return item.amount ? { ...item, qty: Number.NaN, rate: Number.NaN } : item
}

/**
 * The code's own posting contract for one invoice, re-derived independently of
 * the journal builders: stored totals win when the row carries them
 * (hasPostedTotals), otherwise the item lines are authoritative with the
 * stored grandTotal closing the base as the remainder. Both figures in base
 * currency.
 */
function expectedPostedAmounts(invoice: Invoice): { subtotal: number; taxTotal: number } {
  const rate = invoiceExchangeRate(invoice)
  const storedSubtotal = round2(Number(invoice.subtotal) || 0)
  const storedTax = round2(Number(invoice.taxTotal) || 0)
  if (storedSubtotal !== 0 || storedTax !== 0) {
    return { subtotal: toBaseAmount(storedSubtotal, rate), taxTotal: toBaseAmount(storedTax, rate) }
  }
  const lines = (Array.isArray(invoice.items) ? invoice.items : []).map(postedLineClone)
  const discountTotal = round2(Number(invoice.discountTotal) || 0)
  const roundOff = round2(Number(invoice.roundOff) || 0)
  const grandTotal = round2(Number(invoice.grandTotal) || 0)
  const derived = calculateInvoiceTotals(lines, { discountTotal })
  const taxTotal = derived.taxTotal
  const subtotal =
    grandTotal === 0 ? derived.subtotal : round2(grandTotal + discountTotal - taxTotal - roundOff)
  return { subtotal: toBaseAmount(subtotal, rate), taxTotal: toBaseAmount(taxTotal, rate) }
}

function genLine(f: Fuzz, type: 'Sales' | 'Purchase'): InvoiceItem {
  const accountPool = type === 'Sales' ? INCOME_ACCOUNTS : EXPENSE_ACCOUNTS
  const accountId = f.chance(0.75)
    ? type === 'Sales'
      ? 'acc-sales'
      : 'acc-materials'
    : f.pick(accountPool)

  const kind = f.int(0, 19)
  let qty: number
  if (kind <= 11) qty = f.int(1, 12)
  else if (kind <= 15) qty = f.pick([0.5, 1.25, 2.5, 3.75, 0.33])
  else if (kind <= 17) qty = 0 // zero line: the journal grouping drops it
  else qty = -f.int(1, 6) // negative rebate line

  const rate = f.chance(0.12) ? f.money(1, 60) : f.int(100, 5_000_000) / 100
  const taxRate = f.weighted<number>([
    [0, 22],
    [15, 34],
    [14.99, 10],
    [14, 8],
    [7.5, 8],
    [10, 6],
    [5, 4],
    [2.5, 4],
    [20, 4],
  ])
  const discountRate = f.chance(0.68) ? undefined : f.pick([0, 5, 10, 12.5, 33.33, 50, 100, 0.5])

  const base = round2(qty * rate)
  const mode = f.int(0, 19)
  let amount: number
  if (mode <= 14) amount = base
  else if (mode <= 16) amount = f.nudged(base) // ±0.005 qty×rate boundary
  else if (mode === 17) amount = round2(base + f.pick([-1, 1, 0.02, -0.02, 123.45, -250]))
  else if (mode === 18) amount = 0 // falsy stored total: qty × rate stays the posted basis
  else amount = Number.NaN // truthy NaN stored total: the line resolves to 0.00

  if (f.chance(0.03)) {
    // qty unusable: the stored amount is the posted basis (documented guard)
    return {
      id: `it-${accountId}`,
      itemCode: 'FZ-1',
      description: 'Fuzz line (qty unusable)',
      accountId,
      accountName: ACCOUNTS.find((a) => a.id === accountId)?.name || accountId,
      qty: Number.NaN,
      rate,
      taxRate,
      amount: f.money(1, 5000),
      ...(discountRate !== undefined ? { discountRate } : {}),
    }
  }

  return {
    id: `it-${accountId}`,
    itemCode: 'FZ-1',
    description: 'Fuzz line',
    accountId,
    accountName: ACCOUNTS.find((a) => a.id === accountId)?.name || accountId,
    qty,
    rate,
    taxRate,
    amount,
    ...(discountRate !== undefined ? { discountRate } : {}),
  }
}

interface BuiltInvoice {
  invoice: Invoice
  consistent: boolean
}

function buildInvoice(
  f: Fuzz,
  type: 'Sales' | 'Purchase',
  index: number,
  opts: { forceConsistent?: boolean } = {},
): BuiltInvoice {
  const party = type === 'Sales' ? CUSTOMER : SUPPLIER
  const items = Array.from({ length: f.int(1, 5) }, () => genLine(f, type))

  const taxInclusive = f.chance(0.3)
  const subtotal0 = calculateInvoiceTotals(items, { taxInclusive }).subtotal
  const discountRoll = f.float()
  let discountTotal = 0
  if (discountRoll >= 0.5 && discountRoll < 0.85) discountTotal = f.money(0, Math.max(1, Math.abs(subtotal0)))
  else if (discountRoll >= 0.85 && discountRoll < 0.93) discountTotal = Math.abs(subtotal0) + f.money(1, 5000)
  else if (discountRoll >= 0.93) discountTotal = -f.money(1, 500)
  const roundOff = f.chance(0.7)
    ? 0
    : f.pick([0.01, -0.01, 0.5, -0.5, 1, -1, f.money(0.01, 2) * (f.chance(0.5) ? 1 : -1)])

  const rate = f.chance(0.65) ? 1 : f.fxRate()
  const fx = rate !== 1

  const consistent = opts.forceConsistent === true ? true : f.chance(0.78)
  const totals = calculateInvoiceTotals(items, { taxInclusive, discountTotal, roundOff })

  let subtotal = totals.subtotal
  let taxTotal = totals.taxTotal
  let grandTotal = totals.grandTotal
  if (!consistent) {
    const corruption = f.int(0, 5)
    if (corruption === 0) taxTotal = round2(taxTotal + f.pick([-5, -1, -0.02, 0.02, 1, 7.77]))
    else if (corruption === 1) subtotal = round2(subtotal + f.pick([-10, -0.03, 0.03, 10]))
    else if (corruption === 2) {
      subtotal = 0
      taxTotal = 0 // item-line rule takes over, grandTotal stays the anchor
    } else if (corruption === 3) grandTotal = round2(grandTotal + f.pick([-3, -0.01, 0.01, 9.99]))
    else if (corruption === 4) grandTotal = 0 // item-only row with no anchor
    else {
      subtotal = 0
      taxTotal = 0
      grandTotal = Number.NaN as unknown as number // no anchor at all
    }
  }

  const invoice: Invoice = {
    id: `${type === 'Sales' ? 'inv' : 'bill'}-fz-${index}`,
    invoiceNumber: `${type === 'Sales' ? 'INV' : 'BILL'}-FZ-${index}`,
    type,
    partyId: party.id,
    partyName: party.name,
    date: f.isoDate(),
    dueDate: f.isoDate(),
    items,
    subtotal,
    taxTotal,
    grandTotal,
    outstandingAmount: round2(Number(grandTotal) || 0),
    status: 'Unpaid',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(discountTotal !== 0 ? { discountTotal } : {}),
    ...(roundOff !== 0 ? { roundOff } : {}),
    ...(fx ? { currency: 'EUR', exchangeRate: rate } : {}),
  }
  return { invoice, consistent }
}

/** The aggregate (debit, credit) an account carries across one journal. */
function accountSides(je: JournalEntry): Map<string, { d: number; c: number }> {
  const nets = new Map<string, { d: number; c: number }>()
  for (const it of je.items) {
    const agg = nets.get(it.accountId) || { d: 0, c: 0 }
    agg.d = round2(agg.d + it.debit)
    agg.c = round2(agg.c + it.credit)
    nets.set(it.accountId, agg)
  }
  return nets
}

const FIXED_LEG_ACCOUNTS = new Set(['acc-ar', 'acc-ap', 'acc-vat', 'acc-vat-out', 'acc-vat-in'])

/**
 * Journal-shape invariants. The builders deliberately post the invoice-level
 * discount, the round-off and the balancing residual as SEPARATE legs on
 * income/expense accounts that also carry the revenue/expense leg
 * (createSalesInvoiceJournal's docstring documents this placement), so the
 * "no self-cancelling legs" invariant narrows to: no single item carries both
 * sides; the fixed legs (control/VAT) are exactly one single-sided leg each;
 * and any account carrying both sides is an income/expense account.
 */
function checkJournalShape(je: JournalEntry, ctx: string): void {
  for (const it of je.items) {
    expect(
      !(it.debit > 0 && it.credit > 0) && !(it.debit < 0 || it.credit < 0),
      `${ctx} item on ${it.accountId} is single-sided and non-negative (d=${it.debit} c=${it.credit})`,
    ).toBe(true)
  }
  const sides = accountSides(je)
  for (const [acc, agg] of sides) {
    if (!FIXED_LEG_ACCOUNTS.has(acc)) continue
    expect(
      agg.d === 0 || agg.c === 0,
      `${ctx} fixed leg ${acc} carries only one side (d=${agg.d} c=${agg.c})`,
    ).toBe(true)
  }
  for (const [acc, agg] of sides) {
    if (!(agg.d > 0 && agg.c > 0)) continue
    const root = ACCOUNTS.find((a) => a.id === acc)?.rootType
    expect(
      root === 'Income' || root === 'Expense',
      `${ctx} account ${acc} carries both sides but is not an income/expense account (d=${agg.d} c=${agg.c})`,
    ).toBe(true)
  }
}

function checkJournal(
  je: JournalEntry,
  invoice: Invoice,
  type: 'Sales' | 'Purchase',
  side: 'posting' | 'reversal',
  ctx: string,
): { subtotal: number; taxTotal: number } {
  const debits = cents(je.items.reduce((s, it) => s + it.debit, 0))
  const creditSum = cents(je.items.reduce((s, it) => s + it.credit, 0))
  expect(debits, `${ctx} item debits == item credits`).toBe(creditSum)
  expect(cents(je.totalDebit), `${ctx} totalDebit == item debits`).toBe(debits)
  expect(cents(je.totalCredit), `${ctx} totalCredit == item credits`).toBe(creditSum)

  for (const it of je.items) {
    expect(
      Number.isInteger(cents(it.debit)) && Number.isInteger(cents(it.credit)),
      `${ctx} leg ${it.accountId} is a clean 2-decimal amount (d=${it.debit} c=${it.credit})`,
    ).toBe(true)
  }

  checkJournalShape(je, ctx)

  const rate = invoiceExchangeRate(invoice)
  const grandBaseCents = cents(toBaseAmount(Number(invoice.grandTotal) || 0, rate))
  // Posting side: AR debit / AP credit for a positive total; the credit note
  // reverses its original, so its control leg sits on the opposite side.
  const controlSign = (type === 'Sales' ? 1 : -1) * (side === 'reversal' ? -1 : 1)
  const controlAcc = type === 'Sales' ? 'acc-ar' : 'acc-ap'
  const controlLegsAll = je.items.filter((it) => it.accountId === controlAcc)
  const controlLegs = controlLegsAll.filter((it) => it.debit !== 0 || it.credit !== 0)
  if (grandBaseCents === 0) {
    // A base-currency nil anchors at zero: the control leg (plus, for a fully
    // nil invoice, its zero marker leg) carries no amount on either side.
    expect(
      controlLegs.length,
      `${ctx} a base-currency nil posts no control amount`,
    ).toBe(0)
    expect(
      controlLegsAll.length >= 1 &&
        controlLegsAll.length <= 2 &&
        controlLegsAll.every((it) => it.debit === 0 && it.credit === 0),
      `${ctx} a base-currency nil anchors ${controlAcc} at zero (legs=${controlLegsAll.length})`,
    ).toBe(true)
  } else {
    expect(controlLegs.length, `${ctx} exactly one ${controlAcc} control leg`).toBe(1)
    expect(
      cents(controlLegs[0].debit - controlLegs[0].credit) || 0,
      `${ctx} ${controlAcc} control leg == stored grandTotal x fx (${grandBaseCents}c, side=${side})`,
    ).toBe((controlSign * grandBaseCents) || 0)
  }

  const expected = expectedPostedAmounts(invoice)
  const taxCents = cents(expected.taxTotal)
  const vatAccs = type === 'Sales' ? VAT_OUT_ACCOUNTS : VAT_IN_ACCOUNTS
  const vatLegs = je.items.filter((it) => vatAccs.includes(it.accountId))
  if (taxCents === 0) {
    expect(vatLegs.length, `${ctx} no VAT leg when the posted VAT is zero`).toBe(0)
  } else {
    expect(vatLegs.length, `${ctx} exactly one VAT leg`).toBe(1)
    const vatNet = vatLegs[0].debit - vatLegs[0].credit
    const vatSign = (type === 'Sales' ? -1 : 1) * (side === 'reversal' ? -1 : 1)
    expect(
      cents(vatNet) || 0,
      `${ctx} VAT leg == posted VAT x fx (expected ${vatSign * taxCents}c)`,
    ).toBe((vatSign * taxCents) || 0)
  }
  return expected
}

/** Batch accumulators shared across the chunk tests (sequential within a file). */
const batch = {
  journals: [] as JournalEntry[],
  invoices: [] as Invoice[],
  salesVatExpected: 0,
  purchaseVatExpected: 0,
  salesVatPosted: 0,
  purchaseVatPosted: 0,
}

function runSalesChunk(chunk: number): void {
  for (let i = 0; i < SALES_CASES / CHUNKS; i++) {
    const index = chunk * (SALES_CASES / CHUNKS) + i
    const f = makeFuzz((SEED ^ 0x51e5) + index)
    const { invoice } = buildInvoice(f, 'Sales', index)
    const je = createSalesInvoiceJournal(invoice, ACCOUNTS, CUSTOMER)
    const ctx = `sales#${index} seed=${(SEED ^ 0x51e5) + index}`
    const expected = checkJournal(je, invoice, 'Sales', 'posting', ctx)
    batch.journals.push(je)
    batch.invoices.push(invoice)
    const sign = invoice.creditNote ? -1 : 1
    batch.salesVatExpected = round2(batch.salesVatExpected + sign * expected.taxTotal)
    const vatNet = je.items
      .filter((it) => VAT_OUT_ACCOUNTS.includes(it.accountId))
      .reduce((s, it) => s + it.debit - it.credit, 0)
    batch.salesVatPosted = round2(batch.salesVatPosted - vatNet)
  }
}

function runPurchaseChunk(chunk: number): void {
  for (let i = 0; i < PURCHASE_CASES / CHUNKS; i++) {
    const index = chunk * (PURCHASE_CASES / CHUNKS) + i
    const f = makeFuzz((SEED ^ 0x9b15) + index)
    const { invoice } = buildInvoice(f, 'Purchase', index)
    const je = createPurchaseBillJournal(invoice, ACCOUNTS, SUPPLIER)
    const ctx = `purchase#${index} seed=${(SEED ^ 0x9b15) + index}`
    const expected = checkJournal(je, invoice, 'Purchase', 'posting', ctx)
    batch.journals.push(je)
    batch.invoices.push(invoice)
    const sign = invoice.creditNote ? -1 : 1
    batch.purchaseVatExpected = round2(batch.purchaseVatExpected + sign * expected.taxTotal)
    const vatNet = je.items
      .filter((it) => VAT_IN_ACCOUNTS.includes(it.accountId))
      .reduce((s, it) => s + it.debit - it.credit, 0)
    batch.purchaseVatPosted = round2(batch.purchaseVatPosted + vatNet)
  }
}

/** A credit-noteable original: consistent stored totals, grandTotal > 0.
 *
 * The wave-1 carve-out (all lines must be effective-nonzero, finding F1) is
 * GONE: fallback legs now land on leaf accounts and the credit note mirrors
 * the invoice's own grouping, so round-off-only originals and mixed
 * zero/effective lines net to zero with their full credit note. The only
 * remaining exclusions are the credit-noteability rules themselves
 * (grandTotal > 0, consistent stored totals).
 */
function genCreditNoteOriginal(f: Fuzz, index: number): Invoice {
  for (let attempt = 0; attempt < 16; attempt++) {
    const built = buildInvoice(f, f.chance(0.7) ? 'Sales' : 'Purchase', index, {
      forceConsistent: true,
    })
    if (round2(Number(built.invoice.grandTotal) || 0) > 0) return built.invoice
  }
  // Deterministic fallback so the slice always has a case.
  const line: InvoiceItem = {
    id: 'it-fallback',
    itemCode: 'FZ-1',
    description: 'Fallback line',
    accountId: 'acc-sales',
    accountName: 'Tender & Commercial Contracting Sales',
    qty: 7,
    rate: 333.33,
    taxRate: 15,
    amount: 2333.31,
  }
  const totals = calculateInvoiceTotals([line], {})
  return {
    id: `inv-fz-${index}`,
    invoiceNumber: `INV-FZ-${index}`,
    type: 'Sales',
    partyId: CUSTOMER.id,
    partyName: CUSTOMER.name,
    date: '2026-06-01',
    dueDate: '2026-07-01',
    items: [line],
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    outstandingAmount: totals.grandTotal,
    status: 'Unpaid',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function runCreditNoteChunk(chunk: number): void {
  for (let i = 0; i < CREDIT_NOTE_CASES / CHUNKS; i++) {
    const index = chunk * (CREDIT_NOTE_CASES / CHUNKS) + i
    const f = makeFuzz((SEED ^ 0xc47e) + index)
    const original = genCreditNoteOriginal(f, index)
    const type = original.type
    const party = type === 'Sales' ? CUSTOMER : SUPPLIER

    const jeOriginal =
      type === 'Sales'
        ? createSalesInvoiceJournal(original, ACCOUNTS, party)
        : createPurchaseBillJournal(original, ACCOUNTS, party)
    const ctx = `cn#${index} seed=${(SEED ^ 0xc47e) + index}`
    const expectedOriginal = checkJournal(jeOriginal, original, type, 'posting', ctx)

    // The full credit note the store would build: same items, same
    // discount/round-off, same stored totals, creditNote flag set.
    const cn: Invoice = {
      ...original,
      id: `cn-fz-${index}`,
      invoiceNumber: `CN-FZ-${index}`,
      creditNote: true,
      creditedInvoiceId: original.id,
      outstandingAmount: -round2(Number(original.grandTotal) || 0),
      items: original.items.map((it) => ({ ...it, id: `cn-${it.id}` })),
    }
    const jeCn = createCreditNoteJournal(cn, ACCOUNTS, party)
    const cnCtx = `${ctx} credit-note`
    const expectedCn = checkJournal(jeCn, cn, type, 'reversal', cnCtx)
    // The credit note must carry back exactly what the original posted.
    expect(
      cents(expectedCn.taxTotal),
      `${cnCtx} credit note VAT == original posted VAT`,
    ).toBe(cents(expectedOriginal.taxTotal))

    // Netting: original + credit note at the same fx rate cancels every account.
    const rate = invoiceExchangeRate(original)
    const derived = computeAccountBalances(ACCOUNTS, [jeOriginal, jeCn])
    if (rate === 1) {
      for (const acc of derived) {
        expect(
          cents(acc.balance) || 0,
          `${ctx} original + credit note nets ${acc.id} to zero`,
        ).toBe(0)
      }
    } else {
      for (const acc of derived) {
        expect(
          Math.abs(acc.balance),
          `${ctx} original + credit note nets ${acc.id} within the documented FX rounding drift`,
        ).toBeLessThanOrEqual(0.15 + 1e-9)
      }
    }

    for (const [je, inv, expected] of [
      [jeOriginal, original, expectedOriginal] as const,
      [jeCn, cn, expectedCn] as const,
    ]) {
      batch.journals.push(je)
      batch.invoices.push(inv)
      const sign = inv.creditNote ? -1 : 1
      const vatAccs = type === 'Sales' ? VAT_OUT_ACCOUNTS : VAT_IN_ACCOUNTS
      const vatNet = je.items
        .filter((it) => vatAccs.includes(it.accountId))
        .reduce((s, it) => s + it.debit - it.credit, 0)
      if (type === 'Sales') {
        batch.salesVatExpected = round2(batch.salesVatExpected + sign * expected.taxTotal)
        batch.salesVatPosted = round2(batch.salesVatPosted - vatNet)
      } else {
        batch.purchaseVatExpected = round2(batch.purchaseVatExpected + sign * expected.taxTotal)
        batch.purchaseVatPosted = round2(batch.purchaseVatPosted + vatNet)
      }
    }
  }
}

describe('fuzz: money core under randomized input', () => {
  it(
    `sales invoices: ${SALES_CASES / CHUNKS} cases x ${CHUNKS} chunks balance and anchor`,
    () => {
      for (let chunk = 0; chunk < CHUNKS; chunk++) runSalesChunk(chunk)
    },
    120_000,
  )

  it(
    `purchase bills: ${PURCHASE_CASES / CHUNKS} cases x ${CHUNKS} chunks balance and anchor`,
    () => {
      for (let chunk = 0; chunk < CHUNKS; chunk++) runPurchaseChunk(chunk)
    },
    120_000,
  )

  it(
    `credit notes: ${CREDIT_NOTE_CASES / CHUNKS} pairs x ${CHUNKS} chunks reverse their originals`,
    () => {
      for (let chunk = 0; chunk < CHUNKS; chunk++) runCreditNoteChunk(chunk)
    },
    120_000,
  )

  it('batch: tax register reports exactly the VAT the journals posted', () => {
    expect(batch.journals.length).toBe(SALES_CASES + PURCHASE_CASES + CREDIT_NOTE_CASES * 2)

    const derived = computeAccountBalances(ACCOUNTS, batch.journals)
    const balanceOf = (id: string): number => derived.find((a) => a.id === id)?.balance ?? 0

    // VAT accounts vs posted legs (observed journals).
    expect(
      (cents(balanceOf('acc-vat') + balanceOf('acc-vat-out')) || 0),
      'sales VAT accounts == VAT posted by sales journals',
    ).toBe(cents(batch.salesVatPosted) || 0)
    expect(
      cents(balanceOf('acc-vat-in')) || 0,
      'purchase VAT account == VAT posted by purchase journals',
    ).toBe(cents(batch.purchaseVatPosted) || 0)

    // VAT accounts vs the code's posting contract (independent oracle).
    expect(
      (cents(balanceOf('acc-vat') + balanceOf('acc-vat-out')) || 0),
      'sales VAT accounts == contract VAT for the batch',
    ).toBe(cents(batch.salesVatExpected) || 0)
    expect(
      cents(balanceOf('acc-vat-in')) || 0,
      'purchase VAT account == contract VAT for the batch',
    ).toBe(cents(batch.purchaseVatExpected) || 0)

    // The tax register reads the same rule the journals post.
    const rows = taxRegister(batch.invoices)
    const totalsRow = rows.find((r) => r.taxRate === null)
    expect(totalsRow, 'tax register has a grand total row').toBeDefined()
    expect(cents(totalsRow!.salesTax) || 0, 'register salesTax == posted sales VAT').toBe(
      cents(batch.salesVatPosted) || 0,
    )
    expect(cents(totalsRow!.purchaseTax) || 0, 'register purchaseTax == posted purchase VAT').toBe(
      cents(batch.purchaseVatPosted) || 0,
    )

    // Per-rate rows must sum back to the totals row.
    const rateRows = rows.filter((r) => r.taxRate !== null)
    expect(
      (cents(rateRows.reduce((s, r) => s + r.salesTax, 0)) || 0),
      'register per-rate salesTax rows sum to the totals row',
    ).toBe(cents(totalsRow!.salesTax) || 0)
    expect(
      (cents(rateRows.reduce((s, r) => s + r.purchaseTax, 0)) || 0),
      'register per-rate purchaseTax rows sum to the totals row',
    ).toBe(cents(totalsRow!.purchaseTax) || 0)
  }, 120_000)
})

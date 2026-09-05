import assert from 'node:assert'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const booksModule = require('../../apps/books/out/main/index.js')

const {
  round2,
  calculateInvoiceTotals,
  createSalesInvoiceJournal,
  createPurchaseBillJournal,
  createSettlementJournal,
  recomputePartyBalances,
  CORE_ACCOUNTS,
  migrateAndValidateBooks,
} = booksModule

let pass = 0
let fail = 0

function stress(name, fn) {
  try {
    fn()
    pass++
    console.log(`  [STRESS PASS] ${name}`)
  } catch (e) {
    fail++
    console.error(`  [STRESS FAIL] ${name}:`, e.message)
  }
}

console.log('=== ADVERSARIAL STRESS TEST SUITE ===\n')

// 1. High-precision Cent Drift Stress Test: 33 items each 33.3333... with 15% VAT
stress('33 fractional line items avoid rounding drift and balance strictly', () => {
  const items = []
  for (let i = 0; i < 33; i++) {
    items.push({
      id: `it-${i}`,
      accountId: i % 2 === 0 ? 'acc-sales' : 'acc-consult',
      qty: 3,
      rate: 33.33, // 99.99
      taxRate: 15, // 14.9985 -> 15.00
    })
  }
  const totals = calculateInvoiceTotals(items)
  assert.strictEqual(totals.subtotal + totals.taxTotal, totals.grandTotal)

  const inv = {
    id: 'inv-stress-1',
    invoiceNumber: 'INV-STRESS-01',
    type: 'Sales',
    ...totals,
    items,
  }

  const je = createSalesInvoiceJournal(inv, CORE_ACCOUNTS)
  assert.strictEqual(je.totalDebit, totals.grandTotal)
  assert.strictEqual(je.totalCredit, totals.grandTotal)
  assert.strictEqual(je.totalDebit, je.totalCredit)

  const actualDebitSum = round2(je.items.reduce((s, it) => s + it.debit, 0))
  const actualCreditSum = round2(je.items.reduce((s, it) => s + it.credit, 0))
  assert.strictEqual(actualDebitSum, actualCreditSum)
  assert.strictEqual(actualDebitSum, totals.grandTotal)
})

// 2. 100 items purchase bill with alternating tax rates (0%, 5%, 14%, 15%, 20%)
stress('100 purchase bill items with varying tax rates strictly balance', () => {
  const taxRates = [0, 5, 14, 15, 20]
  const items = []
  for (let i = 0; i < 100; i++) {
    items.push({
      id: `b-${i}`,
      accountId: i % 3 === 0 ? 'acc-materials' : i % 3 === 1 ? 'acc-utilities' : 'acc-travel',
      qty: (i + 1) * 0.5,
      rate: 19.99 + (i % 7),
      taxRate: taxRates[i % taxRates.length],
    })
  }
  const totals = calculateInvoiceTotals(items)
  assert.strictEqual(round2(totals.subtotal + totals.taxTotal), totals.grandTotal)

  const bill = {
    id: 'bill-stress-1',
    invoiceNumber: 'BILL-STRESS-01',
    type: 'Purchase',
    ...totals,
    items,
  }

  const je = createPurchaseBillJournal(bill, CORE_ACCOUNTS)
  assert.strictEqual(je.totalDebit, totals.grandTotal)
  assert.strictEqual(je.totalCredit, totals.grandTotal)
  assert.strictEqual(je.totalDebit, je.totalCredit)
})

// 3. Zero total invoice / bill
stress('Zero total invoice generates balanced journal', () => {
  const inv = {
    id: 'inv-zero',
    invoiceNumber: 'INV-ZERO',
    type: 'Sales',
    subtotal: 0,
    taxTotal: 0,
    grandTotal: 0,
    items: [],
  }
  const je = createSalesInvoiceJournal(inv, CORE_ACCOUNTS)
  assert.strictEqual(je.totalDebit, 0)
  assert.strictEqual(je.totalCredit, 0)
})

// 4. Inconsistent subtotal in input (e.g. corrupted invoice data)
stress('Inconsistent subtotal in invoice is safely balanced by engine', () => {
  const badInv = {
    id: 'inv-bad',
    invoiceNumber: 'INV-BAD',
    type: 'Sales',
    subtotal: 999999, // wrong subtotal!
    taxTotal: 15,
    grandTotal: 115,
    items: [{ id: 'it-1', accountId: 'acc-sales', amount: 100 }],
  }
  const je = createSalesInvoiceJournal(badInv, CORE_ACCOUNTS)
  assert.strictEqual(je.totalDebit, 115)
  assert.strictEqual(je.totalCredit, 115)
  assert.strictEqual(je.totalDebit, je.totalCredit)
})

// 5. Party balance recomputation with 500 invoices
stress('recomputePartyBalances scales across 500 invoices without performance degradation', () => {
  const parties = [
    { id: 'p-alpha', name: 'Alpha Corp', outstandingBalance: 0 },
    { id: 'p-beta', name: 'Beta Ltd', outstandingBalance: 0 },
  ]
  const invoices = []
  for (let i = 0; i < 500; i++) {
    invoices.push({
      id: `inv-${i}`,
      partyId: i % 2 === 0 ? 'p-alpha' : 'p-beta',
      grandTotal: 100,
      outstandingAmount: i % 5 === 0 ? 0 : 100,
      status: i % 5 === 0 ? 'Paid' : i % 7 === 0 ? 'Cancelled' : 'Unpaid',
    })
  }

  const start = performance.now()
  const res = recomputePartyBalances(invoices, parties)
  const elapsed = performance.now() - start

  assert(elapsed < 50, `recomputePartyBalances took too long: ${elapsed}ms`)
  assert(res[0].outstandingBalance > 0)
  assert(res[1].outstandingBalance > 0)
  console.log(`    ℹ️ 500 invoices recomputed in ${elapsed.toFixed(2)}ms`)
})

// 6. Schema Migration: preserves all 30 core accounts when migrating empty or custom store
stress('migrateAndValidateBooks preserves exactly 30 accounts with full hierarchy from empty input', () => {
  const migrated = migrateAndValidateBooks({})
  assert.strictEqual(migrated.accounts.length, 30)

  // Verify each group account has valid children
  const assetChildren = migrated.accounts.filter((a) => a.parentId === 'acc-asset')
  assert(assetChildren.length >= 2, 'acc-asset must have at least curr-asset and fixed-asset')

  const currAssetChildren = migrated.accounts.filter((a) => a.parentId === 'acc-curr-asset')
  assert(currAssetChildren.some((a) => a.id === 'acc-bank'))
  assert(currAssetChildren.some((a) => a.id === 'acc-ar'))
  assert(currAssetChildren.some((a) => a.id === 'acc-cash'))
})

console.log(`\n===================================`)
console.log(`Stress Results: ${pass} passed, ${fail} failed`)
console.log(`===================================`)

if (fail > 0) process.exit(1)

import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
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
  DEFAULT_BOOK_SETTINGS,
  CURRENT_BOOKS_SCHEMA_VERSION,
  migrateAndValidateBooks,
  readBooksStore,
  writeBooksStore,
} = booksModule

let passCount = 0
let failCount = 0

function runTest(name, fn) {
  try {
    fn()
    passCount++
    console.log(`  [PASS] ${name}`)
  } catch (err) {
    failCount++
    console.error(`  [FAIL] ${name}:`, err.message)
  }
}

console.log('=== AUDITOR FORENSIC VERIFICATION SUITE ===\n')

// 1. Math: round2
runTest('round2 handles floating point drift (0.1 + 0.2 === 0.3)', () => {
  assert.strictEqual(round2(0.1 + 0.2), 0.3)
  assert.strictEqual(round2(0.1 + 0.7), 0.8)
})

runTest('round2 normalizes negative zero to 0', () => {
  assert.strictEqual(Object.is(round2(-0), 0), true)
  assert.strictEqual(Object.is(round2(-0.0001), 0), true)
})

runTest('round2 half-up rounding precision', () => {
  assert.strictEqual(round2(10.005), 10.01)
  assert.strictEqual(round2(10.004), 10.00)
  assert.strictEqual(round2(123.456), 123.46)
})

runTest('round2 edge cases (null, undefined, NaN, string)', () => {
  assert.strictEqual(round2(null), 0)
  assert.strictEqual(round2(undefined), 0)
  assert.strictEqual(round2(NaN), 0)
  assert.strictEqual(round2('123.45'), 123.45)
  assert.strictEqual(round2('abc'), 0)
})

// 2. Math: calculateInvoiceTotals
runTest('calculateInvoiceTotals empty list', () => {
  const res = calculateInvoiceTotals([])
  assert.deepStrictEqual(res, { subtotal: 0, taxTotal: 0, grandTotal: 0 })
})

runTest('calculateInvoiceTotals single line item 15% VAT', () => {
  const items = [{ qty: 2, rate: 1000, taxRate: 15 }]
  const res = calculateInvoiceTotals(items)
  assert.strictEqual(res.subtotal, 2000)
  assert.strictEqual(res.taxTotal, 300)
  assert.strictEqual(res.grandTotal, 2300)
})

runTest('calculateInvoiceTotals fractional cent line items', () => {
  const items = [
    { qty: 1, rate: 126086.96, taxRate: 15 },
    { qty: 1, rate: 43913.04, taxRate: 15 },
  ]
  const res = calculateInvoiceTotals(items)
  assert.strictEqual(res.subtotal, 170000)
  assert.strictEqual(res.taxTotal, 25500)
  assert.strictEqual(res.grandTotal, 195500)
  assert.strictEqual(round2(res.subtotal + res.taxTotal), res.grandTotal)
})

// 3. Double-Entry: createSalesInvoiceJournal
runTest('createSalesInvoiceJournal produces strictly balanced debits and credits', () => {
  const inv = {
    id: 'inv-test-1',
    invoiceNumber: 'INV-2026-901',
    type: 'Sales',
    partyId: 'party-1',
    partyName: 'Test Client',
    date: '2026-09-01',
    subtotal: 10000,
    taxTotal: 1500,
    grandTotal: 11500,
    items: [
      { id: 'it-1', accountId: 'acc-sales', amount: 6000, taxRate: 15 },
      { id: 'it-2', accountId: 'acc-consult', amount: 4000, taxRate: 15 },
    ],
  }
  const je = createSalesInvoiceJournal(inv, CORE_ACCOUNTS)
  assert.strictEqual(je.totalDebit, 11500)
  assert.strictEqual(je.totalCredit, 11500)
  assert.strictEqual(je.totalDebit, je.totalCredit)

  // Verify Debit item
  const arItem = je.items.find((it) => it.accountId === 'acc-ar')
  assert(arItem, 'Must have AR item')
  assert.strictEqual(arItem.debit, 11500)
  assert.strictEqual(arItem.credit, 0)

  // Verify Credit items
  const salesItem = je.items.find((it) => it.accountId === 'acc-sales')
  assert.strictEqual(salesItem.credit, 6000)

  const consultItem = je.items.find((it) => it.accountId === 'acc-consult')
  assert.strictEqual(consultItem.credit, 4000)

  const vatItem = je.items.find((it) => it.accountId === 'acc-vat')
  assert.strictEqual(vatItem.credit, 1500)
})

runTest('createSalesInvoiceJournal with zero tax', () => {
  const inv = {
    id: 'inv-test-2',
    invoiceNumber: 'INV-2026-902',
    type: 'Sales',
    date: '2026-09-01',
    subtotal: 5000,
    taxTotal: 0,
    grandTotal: 5000,
    items: [{ id: 'it-1', accountId: 'acc-sales', amount: 5000, taxRate: 0 }],
  }
  const je = createSalesInvoiceJournal(inv, CORE_ACCOUNTS)
  assert.strictEqual(je.totalDebit, 5000)
  assert.strictEqual(je.totalCredit, 5000)
  assert.strictEqual(je.items.some((it) => it.accountId === 'acc-vat'), false)
})

// 4. Double-Entry: createPurchaseBillJournal
runTest('createPurchaseBillJournal produces strictly balanced debits and credits', () => {
  const bill = {
    id: 'bill-test-1',
    invoiceNumber: 'BILL-2026-801',
    type: 'Purchase',
    partyId: 'party-supp-1',
    partyName: 'Steel Supplier',
    date: '2026-09-02',
    subtotal: 36521.74,
    taxTotal: 5478.26,
    grandTotal: 42000,
    items: [
      { id: 'b-1', accountId: 'acc-materials', amount: 36521.74, taxRate: 15 },
    ],
  }
  const je = createPurchaseBillJournal(bill, CORE_ACCOUNTS)
  assert.strictEqual(je.totalDebit, 42000)
  assert.strictEqual(je.totalCredit, 42000)

  const matItem = je.items.find((it) => it.accountId === 'acc-materials')
  assert.strictEqual(matItem.debit, 36521.74)
  assert.strictEqual(matItem.credit, 0)

  const vatInItem = je.items.find((it) => it.accountId === 'acc-vat-in' || it.accountId === 'acc-vat')
  assert.strictEqual(vatInItem.debit, 5478.26)
  assert.strictEqual(vatInItem.credit, 0)

  const apItem = je.items.find((it) => it.accountId === 'acc-ap')
  assert.strictEqual(apItem.debit, 0)
  assert.strictEqual(apItem.credit, 42000)
})

// 5. Double-Entry: createSettlementJournal
runTest('createSettlementJournal for Sales payment received', () => {
  const inv = {
    id: 'inv-settle-1',
    invoiceNumber: 'INV-2026-100',
    type: 'Sales',
    partyId: 'party-1',
    partyName: 'Client Alpha',
    grandTotal: 50000,
    outstandingAmount: 50000,
  }
  const je = createSettlementJournal({
    invoice: inv,
    accounts: CORE_ACCOUNTS,
    amount: 50000,
  })
  assert.strictEqual(je.totalDebit, 50000)
  assert.strictEqual(je.totalCredit, 50000)

  const bank = je.items.find((it) => it.accountId === 'acc-bank')
  assert.strictEqual(bank.debit, 50000)
  assert.strictEqual(bank.credit, 0)

  const ar = je.items.find((it) => it.accountId === 'acc-ar')
  assert.strictEqual(ar.debit, 0)
  assert.strictEqual(ar.credit, 50000)
})

runTest('createSettlementJournal for Purchase bill disbursement', () => {
  const bill = {
    id: 'bill-settle-1',
    invoiceNumber: 'BILL-2026-100',
    type: 'Purchase',
    partyId: 'supp-1',
    partyName: 'Vendor Beta',
    grandTotal: 25000,
    outstandingAmount: 25000,
  }
  const je = createSettlementJournal({
    invoice: bill,
    accounts: CORE_ACCOUNTS,
    amount: 25000,
  })
  assert.strictEqual(je.totalDebit, 25000)
  assert.strictEqual(je.totalCredit, 25000)

  const ap = je.items.find((it) => it.accountId === 'acc-ap')
  assert.strictEqual(ap.debit, 25000)
  assert.strictEqual(ap.credit, 0)

  const bank = je.items.find((it) => it.accountId === 'acc-bank')
  assert.strictEqual(bank.debit, 0)
  assert.strictEqual(bank.credit, 25000)
})

// 6. Algorithm: recomputePartyBalances
runTest('recomputePartyBalances ignores Paid and Cancelled invoices', () => {
  const parties = [
    { id: 'p1', name: 'Alpha', outstandingBalance: 0 },
    { id: 'p2', name: 'Beta', outstandingBalance: 0 },
  ]
  const invoices = [
    { partyId: 'p1', grandTotal: 1000, outstandingAmount: 1000, status: 'Unpaid' },
    { partyId: 'p1', grandTotal: 2000, outstandingAmount: 0, status: 'Paid' },
    { partyId: 'p1', grandTotal: 500, outstandingAmount: 500, status: 'Cancelled' },
    { partyId: 'p1', grandTotal: 1500, outstandingAmount: 1500, status: 'Overdue' },
    { partyId: 'p2', grandTotal: 3000, outstandingAmount: 1200, status: 'Unpaid' },
  ]
  const updated = recomputePartyBalances(invoices, parties)
  const p1 = updated.find((p) => p.id === 'p1')
  const p2 = updated.find((p) => p.id === 'p2')
  assert.strictEqual(p1.outstandingBalance, 2500) // 1000 + 1500
  assert.strictEqual(p2.outstandingBalance, 1200)
})

// 7. Chart of Accounts Structure & Invariants
runTest('CORE_ACCOUNTS contains exactly 30 accounts with full standard hierarchy', () => {
  assert.strictEqual(CORE_ACCOUNTS.length, 30)

  const rootGroups = CORE_ACCOUNTS.filter((a) => a.parentId === null)
  assert.strictEqual(rootGroups.length, 5, 'Must have 5 root groups with parentId === null')
  const expectedRoots = ['acc-asset', 'acc-liab', 'acc-equity', 'acc-income', 'acc-expense']
  assert.deepStrictEqual(rootGroups.map((a) => a.id).sort(), expectedRoots.sort())

  // Verify all non-root accounts have valid parent IDs
  const accountIds = new Set(CORE_ACCOUNTS.map((a) => a.id))
  for (const acc of CORE_ACCOUNTS) {
    if (acc.parentId !== null) {
      assert(accountIds.has(acc.parentId), `Account ${acc.id} references invalid parent ${acc.parentId}`)
    }
  }

  // Check 5 categories
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-bank'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-ar'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-ap'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-vat'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-vat-in'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-payroll-liab'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-owner-equity'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-sales'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-materials'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-salaries'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-rent'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-utilities'))
  assert(CORE_ACCOUNTS.some((a) => a.id === 'acc-deprec'))
})

// 8. Persistence & Corruption Recovery
runTest('writeBooksStore performs atomic writes via temporary file and rename', () => {
  const tempDir = join(tmpdir(), `audit-books-${randomUUID().slice(0, 8)}`)
  mkdirSync(tempDir, { recursive: true })
  try {
    const filePath = join(tempDir, 'books-data.json')
    writeBooksStore(filePath, { accounts: [{ id: 'acc-bank', balance: 500000 }] })
    assert(existsSync(filePath), 'File must exist after write')

    // Check directory for no lingering tmp files
    const files = readdirSync(tempDir)
    const tmpFiles = files.filter((f) => f.includes('.tmp'))
    assert.strictEqual(tmpFiles.length, 0, 'No orphaned .tmp files')

    const envelope = readBooksStore(filePath)
    assert.strictEqual(envelope.version, 1)
    assert.strictEqual(envelope.accounts.length, 30)
    assert.strictEqual(envelope.accounts.find((a) => a.id === 'acc-bank').balance, 500000)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

runTest('readBooksStore on corrupt JSON creates both timestamped .corrupt-[ts] and .corrupted.bak', () => {
  const tempDir = join(tmpdir(), `audit-corrupt-${randomUUID().slice(0, 8)}`)
  mkdirSync(tempDir, { recursive: true })
  try {
    const filePath = join(tempDir, 'books-data.json')
    const badJson = '{"broken": true, INVALID_JSON}'
    writeFileSync(filePath, badJson, 'utf8')

    const fallback = readBooksStore(filePath)
    assert.strictEqual(fallback.version, 1)
    assert.strictEqual(fallback.accounts.length, 30)

    const dirFiles = readdirSync(tempDir)
    const corruptTs = dirFiles.filter((f) => f.startsWith('books-data.json.corrupt-'))
    const corruptBak = dirFiles.filter((f) => f === 'books-data.json.corrupted.bak')

    assert.strictEqual(corruptTs.length, 1, 'Must create timestamped corrupt backup')
    assert.strictEqual(corruptBak.length, 1, 'Must create legacy corrupted.bak')
    assert.strictEqual(readFileSync(join(tempDir, corruptBak[0]), 'utf8'), badJson)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

console.log(`\n===================================`)
console.log(`Auditor Verification Results: ${passCount} passed, ${failCount} failed`)
console.log(`===================================`)

if (failCount > 0) {
  process.exit(1)
} else {
  process.exit(0)
}

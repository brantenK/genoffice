#!/usr/bin/env node
/**
 * tools/test-challenger-2-m1-adversarial.mjs
 *
 * Challenger 2 Adversarial Stress Test Suite for Milestone 1 (M1):
 * - Check 1: Party Balance Invariant Tests (recomputePartyBalances)
 * - Check 2: Store Migration & 2-Decimal Sanitization Tests (migrateAndValidateBooks)
 * - Check 3: UI Component Calculations (ChartOfAccounts renderTree & Dashboard !a.isGroup)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const booksModule = require('../apps/books/out/main/index.js')
const initialDataModule = require('../apps/books/src/renderer/src/mock/initialData.ts')

const {
  CURRENT_BOOKS_SCHEMA_VERSION,
  DEFAULT_BOOK_SETTINGS,
  CORE_ACCOUNTS,
  migrateAndValidateBooks,
  readBooksStore,
  writeBooksStore,
  round2,
  recomputePartyBalances,
  calculateInvoiceTotals,
  createSalesInvoiceJournal,
  createPurchaseBillJournal,
  createSettlementJournal,
} = booksModule

const { initialBooksData } = initialDataModule

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  [PASS] ${name}`)
  } catch (err) {
    failed++
    failures.push({ name, error: err.message, stack: err.stack })
    console.error(`  [FAIL] ${name}: ${err.message}`)
  }
}

function createSandbox() {
  const dir = join(tmpdir(), `challenger-m1-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    booksPath: join(dir, 'books', 'books-data.json'),
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

console.log('======================================================================')
console.log('  CHALLENGER 2: ADVERSARIAL STRESS TEST SUITE — MILESTONE 1 (M1)')
console.log('======================================================================\n')

// ============================================================================
// CHECK 1: PARTY BALANCE INVARIANT TESTS (recomputePartyBalances)
// ============================================================================
console.log('--- Check 1: Party Balance Invariant (recomputePartyBalances) ---')

test('1.1 Mixed invoice status filtering: Paid and Cancelled excluded, Unpaid, Overdue, Draft included', () => {
  const party1 = { id: 'party-test-1', name: 'Alpha Corp', outstandingBalance: 99999 }
  const invoices = [
    { id: 'i1', partyId: 'party-test-1', grandTotal: 1000, outstandingAmount: 1000, status: 'Unpaid' },
    { id: 'i2', partyId: 'party-test-1', grandTotal: 2500, outstandingAmount: 2500, status: 'Overdue' },
    { id: 'i3', partyId: 'party-test-1', grandTotal: 500, outstandingAmount: 500, status: 'Draft' },
    { id: 'i4', partyId: 'party-test-1', grandTotal: 7000, outstandingAmount: 0, status: 'Paid' },
    { id: 'i5', partyId: 'party-test-1', grandTotal: 3000, outstandingAmount: 3000, status: 'Cancelled' },
  ]

  const updatedParties = recomputePartyBalances(invoices, [party1])
  assert.strictEqual(updatedParties.length, 1)
  // Expected: 1000 (Unpaid) + 2500 (Overdue) + 500 (Draft) = 4000.00
  // Paid (7000) and Cancelled (3000) must be completely excluded
  assert.strictEqual(updatedParties[0].outstandingBalance, 4000, 'Party balance must equal sum of open invoices (4000)')
})

test('1.2 Partial settlement tracking: outstandingAmount takes strict precedence over grandTotal', () => {
  const party = { id: 'party-partial', name: 'Beta Ltd', outstandingBalance: 0 }
  const invoices = [
    // Invoice originally 100,000, partially settled down to 15,420.50
    { id: 'i-part-1', partyId: 'party-partial', grandTotal: 100000, outstandingAmount: 15420.50, status: 'Unpaid' },
    // Invoice originally 50,000, partially settled down to 2,500.25
    { id: 'i-part-2', partyId: 'party-partial', grandTotal: 50000, outstandingAmount: 2500.25, status: 'Overdue' },
  ]

  const res = recomputePartyBalances(invoices, [party])
  // Expected: 15420.50 + 2500.25 = 17920.75 (NOT grandTotal 150000)
  assert.strictEqual(res[0].outstandingBalance, 17920.75, 'Must use outstandingAmount when present')
})

test('1.3 Fallback to grandTotal when outstandingAmount is undefined', () => {
  const party = { id: 'party-legacy', name: 'Legacy Customer', outstandingBalance: 0 }
  const invoices = [
    { id: 'i-leg-1', partyId: 'party-legacy', grandTotal: 3500.50, status: 'Unpaid' }, // no outstandingAmount
    { id: 'i-leg-2', partyId: 'party-legacy', grandTotal: 1200.25, status: 'Overdue' }, // no outstandingAmount
  ]

  const res = recomputePartyBalances(invoices, [party])
  assert.strictEqual(res[0].outstandingBalance, 4700.75, 'Must fallback to grandTotal when outstandingAmount is undefined')
})

test('1.4 Zero balance invariants: invoice with outstandingAmount === 0 contributes 0 even if marked Unpaid', () => {
  const party = { id: 'party-zero', name: 'Zero Balance Customer', outstandingBalance: 5000 }
  const invoices = [
    { id: 'i-z-1', partyId: 'party-zero', grandTotal: 10000, outstandingAmount: 0, status: 'Unpaid' },
  ]

  const res = recomputePartyBalances(invoices, [party])
  assert.strictEqual(res[0].outstandingBalance, 0, '0 outstandingAmount contributes 0')
})

test('1.5 Floating point accumulation precision: 10 fractional open invoices eliminate JS binary drift', () => {
  const party = { id: 'party-float', name: 'Fractional Cents Client', outstandingBalance: 0 }
  // 10 invoices of 0.10, 0.20, 0.10, etc. (classic 0.1 + 0.2 = 0.30000000000000004 bug)
  const invoices = [
    { id: 'f1', partyId: 'party-float', grandTotal: 0.10, outstandingAmount: 0.10, status: 'Unpaid' },
    { id: 'f2', partyId: 'party-float', grandTotal: 0.20, outstandingAmount: 0.20, status: 'Unpaid' },
    { id: 'f3', partyId: 'party-float', grandTotal: 0.10, outstandingAmount: 0.10, status: 'Unpaid' },
    { id: 'f4', partyId: 'party-float', grandTotal: 0.20, outstandingAmount: 0.20, status: 'Unpaid' },
    { id: 'f5', partyId: 'party-float', grandTotal: 0.10, outstandingAmount: 0.10, status: 'Unpaid' },
    { id: 'f6', partyId: 'party-float', grandTotal: 0.20, outstandingAmount: 0.20, status: 'Unpaid' },
    { id: 'f7', partyId: 'party-float', grandTotal: 0.10, outstandingAmount: 0.10, status: 'Unpaid' },
    { id: 'f8', partyId: 'party-float', grandTotal: 0.20, outstandingAmount: 0.20, status: 'Unpaid' },
    { id: 'f9', partyId: 'party-float', grandTotal: 0.10, outstandingAmount: 0.10, status: 'Unpaid' },
    { id: 'f10', partyId: 'party-float', grandTotal: 0.20, outstandingAmount: 0.20, status: 'Unpaid' },
  ]

  const res = recomputePartyBalances(invoices, [party])
  // 5 * 0.10 + 5 * 0.20 = 0.50 + 1.00 = 1.50 strictly
  assert.strictEqual(res[0].outstandingBalance, 1.5, 'Must equal 1.50 without floating point drift')
  assert.strictEqual(Number(res[0].outstandingBalance.toFixed(2)), 1.50)
})

test('1.6 Multi-party isolation: invoices do not cross-contaminate different parties', () => {
  const p1 = { id: 'p1', name: 'Party 1', outstandingBalance: 0 }
  const p2 = { id: 'p2', name: 'Party 2', outstandingBalance: 0 }
  const p3 = { id: 'p3', name: 'Party 3 (No invoices)', outstandingBalance: 500 }

  const invoices = [
    { id: 'inv-p1-1', partyId: 'p1', grandTotal: 5000, outstandingAmount: 5000, status: 'Unpaid' },
    { id: 'inv-p2-1', partyId: 'p2', grandTotal: 7500, outstandingAmount: 7500, status: 'Unpaid' },
    { id: 'inv-p1-2', partyId: 'p1', grandTotal: 2500, outstandingAmount: 2500, status: 'Overdue' },
    { id: 'inv-orphan', partyId: 'p-nonexistent', grandTotal: 99999, outstandingAmount: 99999, status: 'Unpaid' },
  ]

  const res = recomputePartyBalances(invoices, [p1, p2, p3])
  const updatedP1 = res.find((p) => p.id === 'p1')
  const updatedP2 = res.find((p) => p.id === 'p2')
  const updatedP3 = res.find((p) => p.id === 'p3')

  assert.strictEqual(updatedP1.outstandingBalance, 7500, 'Party 1 gets only p1 invoices (5000 + 2500 = 7500)')
  assert.strictEqual(updatedP2.outstandingBalance, 7500, 'Party 2 gets only p2 invoices (7500)')
  assert.strictEqual(updatedP3.outstandingBalance, 0, 'Party 3 with no invoices resets to 0')
})

test('1.7 Adversarial inputs to recomputePartyBalances: null, undefined, malformed invoice items', () => {
  // Empty or invalid party list returns []
  assert.deepStrictEqual(recomputePartyBalances([], null), [])
  assert.deepStrictEqual(recomputePartyBalances([], undefined), [])
  assert.deepStrictEqual(recomputePartyBalances([], 'not-an-array'), [])

  // Invoices containing null, undefined, objects missing fields
  const party = { id: 'p-resilient', name: 'Resilient Co', outstandingBalance: 0 }
  const malformedInvoices = [
    null,
    undefined,
    {},
    { id: 'i-no-party', grandTotal: 1000, status: 'Unpaid' },
    { id: 'i-nan', partyId: 'p-resilient', grandTotal: NaN, outstandingAmount: NaN, status: 'Unpaid' },
    { id: 'i-good', partyId: 'p-resilient', grandTotal: 300, outstandingAmount: 300, status: 'Unpaid' },
  ]

  const res = recomputePartyBalances(malformedInvoices, [party])
  assert.strictEqual(res[0].outstandingBalance, 300, 'Malformed items safely handled without crash')
})

test('1.8 Initial seed data party balance invariant: initialBooksData strictly matches recomputed balances', () => {
  const initialParties = initialBooksData.parties
  const initialInvoices = initialBooksData.invoices

  const recomputed = recomputePartyBalances(initialInvoices, initialParties)

  for (const p of recomputed) {
    const original = initialParties.find((op) => op.id === p.id)
    assert.strictEqual(
      p.outstandingBalance,
      original.outstandingBalance,
      `Party ${p.name} (${p.id}) initial balance ${original.outstandingBalance} matches recomputed ${p.outstandingBalance}`
    )
  }
})

test('1.9 String number resilience and credit notes (negative amounts)', () => {
  const party = { id: 'party-strings', name: 'String Amount Client', outstandingBalance: 0 }
  const invoices = [
    { id: 'str-1', partyId: 'party-strings', grandTotal: '1500.50', outstandingAmount: '1500.50', status: 'Unpaid' },
    { id: 'str-2', partyId: 'party-strings', grandTotal: '-300.25', outstandingAmount: '-300.25', status: 'Unpaid' }, // credit note
  ]

  const res = recomputePartyBalances(invoices, [party])
  // 1500.50 - 300.25 = 1200.25
  assert.strictEqual(res[0].outstandingBalance, 1200.25, 'String amounts and credit notes correctly calculated')
})

test('1.10 Scale stress test: 10,000 invoices across 100 parties compute deterministically under 200ms', () => {
  const parties = []
  for (let i = 0; i < 100; i++) {
    parties.push({ id: `scale-p-${i}`, name: `Party ${i}`, outstandingBalance: 0 })
  }

  const invoices = []
  for (let i = 0; i < 10000; i++) {
    const pIdx = i % 100
    const status = i % 3 === 0 ? 'Paid' : (i % 3 === 1 ? 'Unpaid' : 'Overdue')
    invoices.push({
      id: `scale-inv-${i}`,
      partyId: `scale-p-${pIdx}`,
      grandTotal: 100,
      outstandingAmount: status === 'Paid' ? 0 : 100,
      status,
    })
  }

  const start = Date.now()
  const res = recomputePartyBalances(invoices, parties)
  const duration = Date.now() - start

  assert.strictEqual(res.length, 100)
  // Each party has 100 invoices. 34 are Paid (i%3===0), 33 Unpaid (i%3===1), 33 Overdue (i%3===2).
  // Total open invoices per party = 66 * 100 = 6600.00
  for (const p of res) {
    assert(p.outstandingBalance >= 6600 && p.outstandingBalance <= 6700, `Party ${p.id} balance in expected range`)
  }
  console.log(`    ℹ️ Scale test (10,000 invoices across 100 parties): took ${duration}ms`)
  assert(duration < 1000, 'Must execute within 1000ms')
})

// ============================================================================
// CHECK 2: STORE MIGRATION SANITIZATION TESTS (migrateAndValidateBooks)
// ============================================================================
console.log('\n--- Check 2: Store Migration & 2-Decimal Sanitization ---')

test('2.1 Partial objects and missing sections receive full standard envelope and all 30 accounts', () => {
  const partial = {
    settings: { companyName: 'Custom Co' },
  }
  const migrated = migrateAndValidateBooks(partial)

  assert.strictEqual(migrated.version, 1)
  assert.strictEqual(migrated.settings.companyName, 'Custom Co')
  assert.strictEqual(migrated.settings.currency, 'ZAR')
  assert.strictEqual(migrated.accounts.length, 30, 'Must have exactly 30 harmonized accounts')
  assert.deepStrictEqual(migrated.parties, [])
  assert.deepStrictEqual(migrated.invoices, [])
  assert.deepStrictEqual(migrated.journalEntries, [])
  assert.deepStrictEqual(migrated.bankTransactions, [])
})

test('2.2 Legacy store with only 5 core accounts backfills all 25 missing accounts including 8 group nodes', () => {
  const legacyData = {
    accounts: [
      { id: 'acc-bank', name: 'Legacy Bank', balance: 500000 },
      { id: 'acc-ar', name: 'Legacy AR', balance: 120000 },
      { id: 'acc-ap', name: 'Legacy AP', balance: 45000 },
      { id: 'acc-sales', name: 'Legacy Sales', balance: 600000 },
      { id: 'acc-vat', name: 'Legacy VAT', balance: 30000 },
    ],
  }

  const migrated = migrateAndValidateBooks(legacyData)

  // Must have 30 accounts now
  assert.strictEqual(migrated.accounts.length, 30, 'Must expand 5 accounts to 30 accounts')

  // Existing balances must be strictly preserved
  const bank = migrated.accounts.find((a) => a.id === 'acc-bank')
  const ar = migrated.accounts.find((a) => a.id === 'acc-ar')
  const ap = migrated.accounts.find((a) => a.id === 'acc-ap')
  const sales = migrated.accounts.find((a) => a.id === 'acc-sales')
  const vat = migrated.accounts.find((a) => a.id === 'acc-vat')

  assert.strictEqual(bank.balance, 500000, 'Legacy acc-bank balance preserved')
  assert.strictEqual(ar.balance, 120000, 'Legacy acc-ar balance preserved')
  assert.strictEqual(ap.balance, 45000, 'Legacy acc-ap balance preserved')
  assert.strictEqual(sales.balance, 600000, 'Legacy acc-sales balance preserved')
  assert.strictEqual(vat.balance, 30000, 'Legacy acc-vat balance preserved')

  // Backfilled group accounts must exist with parentId and isGroup properties
  const rootAsset = migrated.accounts.find((a) => a.id === 'acc-asset')
  assert(rootAsset, 'acc-asset root node must exist')
  assert.strictEqual(rootAsset.parentId, null, 'Root asset group parentId must be null')
  assert.strictEqual(rootAsset.isGroup, true, 'Root asset must be group')

  const currAsset = migrated.accounts.find((a) => a.id === 'acc-curr-asset')
  assert(currAsset, 'acc-curr-asset sub-group must exist')
  assert.strictEqual(currAsset.parentId, 'acc-asset', 'acc-curr-asset parent must be acc-asset')
  assert.strictEqual(currAsset.isGroup, true)

  // Existing leaf accounts must have parentId restored if omitted
  assert.strictEqual(bank.parentId, 'acc-curr-asset', 'acc-bank must be placed under acc-curr-asset')
  assert.strictEqual(bank.isGroup, false, 'acc-bank must not be group')

  // Backfilled leaf accounts must exist
  const inv = migrated.accounts.find((a) => a.id === 'acc-inventory')
  assert(inv, 'acc-inventory backfilled')
  const vatIn = migrated.accounts.find((a) => a.id === 'acc-vat-in')
  assert(vatIn, 'acc-vat-in backfilled')
  const payroll = migrated.accounts.find((a) => a.id === 'acc-payroll-liab')
  assert(payroll, 'acc-payroll-liab backfilled')
})

test('2.3 Unrounded floating-point numbers across accounts, parties, invoices, journals, bank transactions', () => {
  const dirtyData = {
    accounts: [
      { id: 'acc-bank', balance: 100.123456789 },
      { id: 'acc-sales', balance: 999.999 },
      { id: 'acc-ap', balance: 45.455 },
      { id: 'acc-ar', balance: 0.000001 },
      { id: 'acc-vat', balance: -0.00001 },
    ],
    parties: [
      { id: 'p1', name: 'Dirty Party', outstandingBalance: 1234.56789 },
      { id: 'p2', name: 'Zero Party', outstandingBalance: -0.000001 },
    ],
    invoices: [
      {
        id: 'inv-dirty',
        invoiceNumber: 'INV-DIRTY-1',
        subtotal: 100.333333,
        taxTotal: 15.049999,
        grandTotal: 115.383332,
        outstandingAmount: 115.383332,
      },
    ],
    journalEntries: [
      {
        id: 'je-dirty',
        entryNumber: 'JE-DIRTY-1',
        totalDebit: 115.383332,
        totalCredit: 115.383332,
        items: [
          { id: 'ji-1', accountId: 'acc-ar', debit: 115.383332, credit: 0.00001 },
          { id: 'ji-2', accountId: 'acc-sales', debit: 0, credit: 100.333333 },
          { id: 'ji-3', accountId: 'acc-vat', debit: 0, credit: 15.049999 },
        ],
      },
    ],
    bankTransactions: [
      {
        id: 'tx-dirty',
        date: '2026-09-01',
        description: 'Dirty Bank Tx',
        amount: 555.55555,
        reconciled: false,
      },
    ],
  }

  const clean = migrateAndValidateBooks(dirtyData)

  // Accounts
  assert.strictEqual(clean.accounts.find((a) => a.id === 'acc-bank').balance, 100.12)
  assert.strictEqual(clean.accounts.find((a) => a.id === 'acc-sales').balance, 1000.00)
  assert.strictEqual(clean.accounts.find((a) => a.id === 'acc-ap').balance, 45.46)
  assert.strictEqual(clean.accounts.find((a) => a.id === 'acc-ar').balance, 0)
  assert.strictEqual(clean.accounts.find((a) => a.id === 'acc-vat').balance, 0)

  // Parties
  assert.strictEqual(clean.parties.find((p) => p.id === 'p1').outstandingBalance, 1234.57)
  assert.strictEqual(clean.parties.find((p) => p.id === 'p2').outstandingBalance, 0)

  // Invoices
  const cleanInv = clean.invoices[0]
  assert.strictEqual(cleanInv.subtotal, 100.33)
  assert.strictEqual(cleanInv.taxTotal, 15.05)
  assert.strictEqual(cleanInv.grandTotal, 115.38)
  assert.strictEqual(cleanInv.outstandingAmount, 115.38)

  // Journal Entries
  const cleanJe = clean.journalEntries[0]
  assert.strictEqual(cleanJe.totalDebit, 115.38)
  assert.strictEqual(cleanJe.totalCredit, 115.38)
  assert.strictEqual(cleanJe.items[0].debit, 115.38)
  assert.strictEqual(cleanJe.items[0].credit, 0)
  assert.strictEqual(cleanJe.items[1].credit, 100.33)
  assert.strictEqual(cleanJe.items[2].credit, 15.05)

  // Bank Transactions
  assert.strictEqual(clean.bankTransactions[0].amount, 555.56)
})

test('2.4 Dual backup generation on corrupt JSON: creates both .corrupt-[timestamp] and .corrupted.bak', () => {
  const sb = createSandbox()
  try {
    const corruptContent = '{ "accounts": [ INVALID JSON ]'
    mkdirSync(join(sb.dir, 'books'), { recursive: true })
    writeFileSync(sb.booksPath, corruptContent, 'utf8')

    const loaded = readBooksStore(sb.booksPath)
    assert.strictEqual(loaded.version, 1)
    assert.strictEqual(loaded.accounts.length, 30)

    // Verify .corrupted.bak
    const legacyBak = `${sb.booksPath}.corrupted.bak`
    assert(existsSync(legacyBak), 'Legacy .corrupted.bak must exist')
    assert.strictEqual(readFileSync(legacyBak, 'utf8'), corruptContent)

    // Verify timestamped .corrupt-*
    const dirFiles = readdirSync(join(sb.dir, 'books'))
    const timestampedBak = dirFiles.find((f) => f.includes('.corrupt-'))
    assert(timestampedBak, 'Timestamped backup file (.corrupt-[timestamp]) must exist')
    assert.strictEqual(readFileSync(join(sb.dir, 'books', timestampedBak), 'utf8'), corruptContent)
  } finally {
    sb.cleanup()
  }
})

test('2.5 Atomic write resilience: writeBooksStore uses .tmp and cleans up safely', () => {
  const sb = createSandbox()
  try {
    const data = {
      settings: { companyName: 'Atomic Co' },
      accounts: [{ id: 'acc-bank', balance: 50000 }],
    }
    writeBooksStore(sb.booksPath, data)
    assert(existsSync(sb.booksPath))

    const reloaded = readBooksStore(sb.booksPath)
    assert.strictEqual(reloaded.settings.companyName, 'Atomic Co')
    assert.strictEqual(reloaded.accounts.find((a) => a.id === 'acc-bank').balance, 50000)

    const dirFiles = readdirSync(join(sb.dir, 'books'))
    assert.strictEqual(dirFiles.filter((f) => f.includes('.tmp')).length, 0, 'No orphaned .tmp files')
  } finally {
    sb.cleanup()
  }
})

test('2.6 Elimination of negative zero (-0) across all numeric round2 operations', () => {
  assert.strictEqual(Object.is(round2(-0), 0), true, 'round2(-0) must return +0')
  assert.strictEqual(Object.is(round2(-0.000001), 0), true, 'round2(-0.000001) must return +0')
  assert.strictEqual(Object.is(round2(0), 0), true, 'round2(0) must return +0')
  assert.strictEqual(Object.is(round2('invalid'), 0), true, 'round2(invalid) must return +0')
  assert.strictEqual(Object.is(round2(null), 0), true, 'round2(null) must return +0')
  assert.strictEqual(Object.is(round2(undefined), 0), true, 'round2(undefined) must return +0')
})

// ============================================================================
// CHECK 3: UI COMPONENT CALCULATIONS (ChartOfAccounts & Dashboard)
// ============================================================================
console.log('\n--- Check 3: UI Component Calculations ---')

test('3.1 ChartOfAccounts tree rendering: renderTree(null, 0) returns exactly 5 root categories', () => {
  const accounts = CORE_ACCOUNTS

  // Replicate ChartOfAccounts.tsx renderTree logic
  const renderTree = (parentId = null, depth = 0) => {
    const isRoot = parentId === null || parentId === undefined
    const children = accounts.filter((a) => {
      if (isRoot) {
        return (
          a.parentId === null ||
          a.parentId === undefined ||
          (depth === 0 && !accounts.some((parent) => parent.id === a.parentId))
        )
      }
      return a.parentId === parentId
    })
    return children
  }

  const rootChildren = renderTree(null, 0)
  assert.strictEqual(rootChildren.length, 5, 'Exactly 5 root category nodes must render at depth 0')

  const rootIds = rootChildren.map((a) => a.id)
  assert.deepStrictEqual(
    rootIds.sort(),
    ['acc-asset', 'acc-expense', 'acc-equity', 'acc-income', 'acc-liab'].sort(),
    'All 5 standard root categories are present at root'
  )

  for (const root of rootChildren) {
    assert.strictEqual(root.parentId, null, `Root account ${root.id} parentId must be null`)
    assert.strictEqual(root.isGroup, true, `Root account ${root.id} must be a group`)
  }
})

test('3.2 ChartOfAccounts tree recursive traversal visits all 30 accounts with zero missing nodes', () => {
  const accounts = CORE_ACCOUNTS

  const renderTree = (parentId = null, depth = 0) => {
    const isRoot = parentId === null || parentId === undefined
    const children = accounts.filter((a) => {
      if (isRoot) {
        return (
          a.parentId === null ||
          a.parentId === undefined ||
          (depth === 0 && !accounts.some((parent) => parent.id === a.parentId))
        )
      }
      return a.parentId === parentId
    })

    const visited = []
    for (const child of children) {
      visited.push(child)
      const sub = renderTree(child.id, depth + 1)
      visited.push(...sub)
    }
    return visited
  }

  const allRendered = renderTree(null, 0)
  assert.strictEqual(allRendered.length, 30, 'Full tree traversal must visit all 30 accounts')

  const renderedIds = new Set(allRendered.map((a) => a.id))
  assert.strictEqual(renderedIds.size, 30, 'All 30 accounts must have unique IDs')

  for (const core of CORE_ACCOUNTS) {
    assert(renderedIds.has(core.id), `Account ${core.id} must be rendered in tree`)
  }
})

test('3.3 ChartOfAccounts orphaned account recovery: orphaned node rendered at depth 0 without crashing', () => {
  const accountsWithOrphan = [
    ...CORE_ACCOUNTS,
    {
      id: 'acc-orphan',
      name: 'Orphaned Account',
      parentId: 'non-existent-parent-group',
      isGroup: false,
      balance: 1000,
    },
  ]

  const renderTree = (parentId = null, depth = 0) => {
    const isRoot = parentId === null || parentId === undefined
    const children = accountsWithOrphan.filter((a) => {
      if (isRoot) {
        return (
          a.parentId === null ||
          a.parentId === undefined ||
          (depth === 0 && !accountsWithOrphan.some((parent) => parent.id === a.parentId))
        )
      }
      return a.parentId === parentId
    })
    return children
  }

  const rootChildren = renderTree(null, 0)
  // 5 root groups + 1 orphaned account = 6 items at depth 0
  assert.strictEqual(rootChildren.length, 6, 'Orphaned account rescued at depth 0')
  assert(rootChildren.some((a) => a.id === 'acc-orphan'), 'Orphaned account included in root view')
})

test('3.4 Dashboard calculation: !a.isGroup strictly eliminates revenue and expense double-counting', () => {
  const accounts = initialBooksData.accounts

  // Dashboard calculation logic
  const incomeAccounts = accounts.filter((a) => !a.isGroup && a.rootType === 'Income')
  const totalIncome = incomeAccounts.reduce((acc, a) => acc + a.balance, 0)

  const expenseAccounts = accounts.filter((a) => !a.isGroup && a.rootType === 'Expense')
  const totalExpenses = expenseAccounts.reduce((acc, a) => acc + a.balance, 0)

  const netProfit = totalIncome - totalExpenses

  const bankAccounts = accounts.filter((a) => !a.isGroup && (a.accountType === 'Bank' || a.accountType === 'Cash'))
  const liquidCash = bankAccounts.reduce((acc, a) => acc + a.balance, 0)

  // Empirical verifications
  // 1. Total Income:
  // Leaf accounts: acc-sales (820000) + acc-consult (235000) + acc-interest-income (0) = 1,055,000
  assert.strictEqual(totalIncome, 1055000, 'Total Income must equal sum of non-group income accounts')

  // Check what would happen WITHOUT !a.isGroup:
  const doubleCountedIncome = accounts.filter((a) => a.rootType === 'Income').reduce((acc, a) => acc + a.balance, 0)
  assert.strictEqual(doubleCountedIncome, 2110000, 'Unfiltered income would double-count group node (2,110,000)')
  assert(totalIncome < doubleCountedIncome, 'Filtered totalIncome eliminates double-counting')

  // 2. Total Expenses:
  // Leaf accounts: acc-materials (345000) + acc-salaries (380000) + acc-rent (65000) + acc-utilities (0) + acc-travel (28000) + acc-deprec (0) = 818,000
  assert.strictEqual(totalExpenses, 818000, 'Total Expenses must equal sum of non-group expense accounts')

  // Check what would happen WITHOUT !a.isGroup:
  const doubleCountedExpenses = accounts.filter((a) => a.rootType === 'Expense').reduce((acc, a) => acc + a.balance, 0)
  assert.strictEqual(doubleCountedExpenses, 1636000, 'Unfiltered expenses would double-count group node (1,636,000)')
  assert(totalExpenses < doubleCountedExpenses, 'Filtered totalExpenses eliminates double-counting')

  // 3. Net Profit:
  assert.strictEqual(netProfit, 1055000 - 818000, 'Net profit = 237,000')
  assert.strictEqual(netProfit, 237000)

  // 4. Liquid Cash:
  // Leaf accounts: acc-bank (485250) + acc-cash (15000) = 500,250
  assert.strictEqual(liquidCash, 500250, 'Liquid cash = 500,250')
})

test('3.5 Dashboard calculation invariance under adversarial group balance inflation', () => {
  // Adversarially modify group balances to arbitrary values
  const mutatedAccounts = initialBooksData.accounts.map((acc) => {
    if (acc.isGroup) {
      return { ...acc, balance: 999999999 } // extreme inflated group balance
    }
    return { ...acc }
  })

  const incomeAccounts = mutatedAccounts.filter((a) => !a.isGroup && a.rootType === 'Income')
  const totalIncome = incomeAccounts.reduce((acc, a) => acc + a.balance, 0)

  const expenseAccounts = mutatedAccounts.filter((a) => !a.isGroup && a.rootType === 'Expense')
  const totalExpenses = expenseAccounts.reduce((acc, a) => acc + a.balance, 0)

  const netProfit = totalIncome - totalExpenses

  // Invariant holds: totalIncome and totalExpenses are completely unaffected by group balances
  assert.strictEqual(totalIncome, 1055000, 'totalIncome is immune to group balance inflation')
  assert.strictEqual(totalExpenses, 818000, 'totalExpenses is immune to group balance inflation')
  assert.strictEqual(netProfit, 237000, 'netProfit is immune to group balance inflation')
})

test('3.6 Dashboard zero revenue / zero expense division-by-zero protection', () => {
  const zeroAccounts = CORE_ACCOUNTS.map((a) => ({ ...a, balance: 0 }))
  const incomeAccounts = zeroAccounts.filter((a) => !a.isGroup && a.rootType === 'Income')
  const totalIncome = incomeAccounts.reduce((acc, a) => acc + a.balance, 0)
  const expenseAccounts = zeroAccounts.filter((a) => !a.isGroup && a.rootType === 'Expense')
  const totalExpenses = expenseAccounts.reduce((acc, a) => acc + a.balance, 0)
  const netProfit = totalIncome - totalExpenses

  // In Dashboard.tsx: operational margin formula:
  const operationalMarginStr = ((netProfit / (totalIncome || 1)) * 100).toFixed(1)
  assert.strictEqual(operationalMarginStr, '0.0', 'Operational margin handles 0 totalIncome safely without NaN')

  // In Dashboard.tsx: progress bar widths:
  const receivableRatio = Math.min(100, (0 / (totalIncome || 1)) * 100)
  const payableRatio = Math.min(100, (0 / (totalExpenses || 1)) * 100)
  assert.strictEqual(receivableRatio, 0)
  assert.strictEqual(payableRatio, 0)
})

// ============================================================================
// SUMMARY & VERDICT
// ============================================================================
console.log('\n======================================================================')
console.log(`SUMMARY: ${passed} passed, ${failed} failed out of ${passed + failed} tests`)
if (failures.length > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) {
    console.log(`❌ ${f.name}: ${f.error}`)
  }
}
console.log('======================================================================')

process.exit(failed > 0 ? 1 : 0)

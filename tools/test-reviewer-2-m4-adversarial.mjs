#!/usr/bin/env node
/**
 * tools/test-reviewer-2-m4-adversarial.mjs
 *
 * Adversarial Reviewer 2 Verification Suite for Milestone 4:
 * Focuses on edge cases, boundary conditions, integrity verification,
 * and double-entry invariants across:
 * 1. parseBankStatementCsv
 * 2. importBankStatement
 * 3. computeSettlementSuggestions
 * 4. executeReconciliation
 * 5. Integrity and facade checks
 */

import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const sandboxDir = join(tmpdir(), `r2-m4-adv-${randomUUID().slice(0, 8)}`)
mkdirSync(join(sandboxDir, 'books'), { recursive: true })

const ipcHandlers = new Map()
require.cache[require.resolve('electron')] = {
  exports: {
    app: {
      getPath: (name) => {
        if (name === 'userData') return sandboxDir
        return tmpdir()
      },
    },
    ipcMain: {
      handle: (channel, handler) => {
        ipcHandlers.set(channel, handler)
      },
    },
    WebContentsView: class {},
  },
}

const books = require('../apps/books/out/main/index.js')

let passed = 0
let failed = 0
const errors = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✅ [PASS] ${name}`)
  } catch (err) {
    failed++
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`)
    errors.push({ name, err })
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✅ [PASS] ${name}`)
  } catch (err) {
    failed++
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`)
    errors.push({ name, err })
  }
}

function writeBooks(data) {
  const p = join(sandboxDir, 'books', 'books-data.json')
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
  return p
}

function readBooks() {
  const p = join(sandboxDir, 'books', 'books-data.json')
  return JSON.parse(readFileSync(p, 'utf8'))
}

function baseData() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { ...books.DEFAULT_BOOK_SETTINGS },
    accounts: books.CORE_ACCOUNTS.map((a) => ({ ...a })),
    parties: [
      { id: 'party-cust-1', name: 'Zano Tech Client (Pty) Ltd', type: 'Customer', outstandingBalance: 50000 },
      { id: 'party-supp-1', name: 'Office Suppliers Corp', type: 'Supplier', outstandingBalance: 12000 },
    ],
    invoices: [
      {
        id: 'inv-s1',
        invoiceNumber: 'INV-2026-901',
        type: 'Sales',
        partyId: 'party-cust-1',
        partyName: 'Zano Tech Client (Pty) Ltd',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [{ id: 'i1', itemCode: 'SVC', description: 'IT Consulting', accountId: 'acc-sales', accountName: 'Sales', qty: 1, rate: 43478.26, taxRate: 15, amount: 43478.26 }],
        subtotal: 43478.26,
        taxTotal: 6521.74,
        grandTotal: 50000,
        outstandingAmount: 50000,
        status: 'Unpaid',
        tenderReference: 'TND-2026-X',
      },
      {
        id: 'inv-p1',
        invoiceNumber: 'BILL-2026-55',
        type: 'Purchase',
        partyId: 'party-supp-1',
        partyName: 'Office Suppliers Corp',
        date: '2026-09-02',
        dueDate: '2026-10-02',
        items: [{ id: 'i2', itemCode: 'SUP', description: 'Desks & Chairs', accountId: 'acc-ap', accountName: 'Payables', qty: 1, rate: 12000, taxRate: 0, amount: 12000 }],
        subtotal: 12000,
        taxTotal: 0,
        grandTotal: 12000,
        outstandingAmount: 12000,
        status: 'Unpaid',
      },
    ],
    journalEntries: [],
    bankTransactions: [],
  }
}

async function run() {
  console.log('===============================================================')
  console.log('  REVIEWER 2 ADVERSARIAL STRESS SUITE (MILESTONE 4)')
  console.log('===============================================================\n')

  // --- 1. CSV Parser Resilience & Malformed Input Handling ---
  console.log('--- 1. CSV Parser Edge Cases ---')

  test('Empty inputs and whitespace only return empty array', () => {
    assert.deepStrictEqual(books.parseBankStatementCsv(''), [])
    assert.deepStrictEqual(books.parseBankStatementCsv('   \n\r\n\t  \n  '), [])
    assert.deepStrictEqual(books.parseBankStatementCsv('Date,Description,Amount'), [])
  })

  test('Parenthesized negative numbers in various currencies', () => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,Test 1,R1,(25000)
2026-09-02,Test 2,R2,"(R 35,000.50)"
2026-09-03,Test 3,R3,"($ 1,234.56)"
2026-09-04,Test 4,R4,-R 500.00
2026-09-05,Test 5,R5,"(R 10,000)"`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 5)
    assert.strictEqual(res[0].amount, -25000)
    assert.strictEqual(res[1].amount, -35000.50)
    assert.strictEqual(res[2].amount, -1234.56)
    assert.strictEqual(res[3].amount, -500.00)
    assert.strictEqual(res[4].amount, -10000)
  })

  test('Trailing commas, empty lines, and spaces between fields', () => {
    const csv = `Date,Description,Reference,Amount

2026-09-01,Payment A,REF-1,1000.00,
  ,  ,  ,  
2026-09-02,Payment B,REF-2,2000.00,,,

`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[0].amount, 1000)
    assert.strictEqual(res[1].amount, 2000)
  })

  test('Debit and Credit separate columns with Rands and Dollars', () => {
    const csv = `Date,Narrative,Ref,Debit,Credit
2026-09-01,Client Wire,W-100,,"R 50,000.00"
2026-09-02,Vendor Pay,W-101,"$ 12,000.00",
2026-09-03,Zero movement,W-102,0,0`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[0].amount, 50000)
    assert.strictEqual(res[1].amount, -12000)
  })

  test('Quoted commas inside description preserve integrity', () => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,"Ekurhuleni, City of (Water Dept)",TND-01,145000.00`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 1)
    assert.strictEqual(res[0].description, 'Ekurhuleni, City of (Water Dept)')
    assert.strictEqual(res[0].amount, 145000)
  })

  // --- 2. Ingestion & Fingerprint Deduplication ---
  console.log('\n--- 2. Ingestion & Deduplication ---')

  test('Fingerprint deduplication (date|description|amount) prevents double-counting', () => {
    const dataPath = writeBooks(baseData())
    const csv = `Date,Description,Reference,Amount
2026-09-01,Deposit 1,R1,10000
2026-09-02,Withdrawal 1,R2,-4000`

    const res1 = books.importBankStatement({ booksDataPath: dataPath, csvContent: csv })
    assert.strictEqual(res1.ok, true)
    assert.strictEqual(res1.importedCount, 2)
    assert.strictEqual(res1.netAdjustment, 6000)

    const state1 = readBooks()
    const bankAcc1 = state1.accounts.find((a) => a.id === 'acc-bank')
    assert.strictEqual(bankAcc1.balance, 485250 + 6000)

    // Re-import identical statement
    const res2 = books.importBankStatement({ booksDataPath: dataPath, csvContent: csv })
    assert.strictEqual(res2.ok, true)
    assert.strictEqual(res2.importedCount, 0)
    assert.strictEqual(res2.skippedDuplicates, 2)
    assert.strictEqual(res2.netAdjustment, 0)

    const state2 = readBooks()
    const bankAcc2 = state2.accounts.find((a) => a.id === 'acc-bank')
    assert.strictEqual(bankAcc2.balance, 485250 + 6000, 'Bank balance must NOT change on re-import')
  })

  test('Internal deduplication of identical rows in a single batch', () => {
    const dataPath = writeBooks(baseData())
    const csvWithDuplicates = `Date,Description,Reference,Amount
2026-09-01,Deposit Same,R1,5000
2026-09-01,Deposit Same,R2,5000
2026-09-02,Unique Deposit,R3,3000`

    const res = books.importBankStatement({ booksDataPath: dataPath, csvContent: csvWithDuplicates })
    assert.strictEqual(res.ok, true)
    // 2 unique fingerprints, 1 skipped duplicate
    assert.strictEqual(res.importedCount, 2)
    assert.strictEqual(res.skippedDuplicates, 1)
    assert.strictEqual(res.netAdjustment, 8000)
  })

  // --- 3. Settlement Suggestions Engine ---
  console.log('\n--- 3. Settlement Suggestions ---')

  test('Deposits strictly match Sales invoices, withdrawals strictly match Purchase bills', () => {
    const data = baseData()
    data.bankTransactions = [
      { id: 'tx-dep-50k', accountId: 'acc-bank', date: '2026-09-05', description: 'Customer wire', amount: 50000, reconciled: false },
      { id: 'tx-with-12k', accountId: 'acc-bank', date: '2026-09-05', description: 'Vendor wire', amount: -12000, reconciled: false },
      // Intentional cross-test: withdrawal of 50k should NOT match Sales invoice of 50k
      { id: 'tx-with-50k', accountId: 'acc-bank', date: '2026-09-06', description: 'Mistaken wire', amount: -50000, reconciled: false },
      // Intentional cross-test: deposit of 12k should NOT match Purchase bill of 12k
      { id: 'tx-dep-12k', accountId: 'acc-bank', date: '2026-09-06', description: 'Refund wire', amount: 12000, reconciled: false },
    ]

    const suggestions = books.computeSettlementSuggestions(data)
    assert.strictEqual(suggestions.length, 2)

    const sugSales = suggestions.find((s) => s.transactionId === 'tx-dep-50k')
    assert(sugSales)
    assert.strictEqual(sugSales.invoiceId, 'inv-s1')
    assert.strictEqual(sugSales.invoiceType, 'Sales')

    const sugPurch = suggestions.find((s) => s.transactionId === 'tx-with-12k')
    assert(sugPurch)
    assert.strictEqual(sugPurch.invoiceId, 'inv-p1')
    assert.strictEqual(sugPurch.invoiceType, 'Purchase')
  })

  test('Confidence scoring: HIGH for Invoice No, Tender Ref, or Party name keywords; MEDIUM for amount only', () => {
    const data = baseData()
    data.bankTransactions = [
      { id: 'tx-tok-1', accountId: 'acc-bank', date: '2026-09-05', description: 'EFT ref INV-2026-901', amount: 50000, reconciled: false },
      { id: 'tx-tok-2', accountId: 'acc-bank', date: '2026-09-05', description: 'Payment TND-2026-X', amount: 50000, reconciled: false },
      { id: 'tx-tok-3', accountId: 'acc-bank', date: '2026-09-05', description: 'EFT from Client', amount: 50000, reconciled: false },
      { id: 'tx-tok-4', accountId: 'acc-bank', date: '2026-09-05', description: 'Generic Unidentified Inflow', amount: 50000, reconciled: false },
    ]

    const suggestions = books.computeSettlementSuggestions(data)
    assert.strictEqual(suggestions.length, 4)

    const s1 = suggestions.find((s) => s.transactionId === 'tx-tok-1')
    assert.strictEqual(s1.confidence, 'HIGH')
    assert(s1.reason.includes('invoice number'))

    const s2 = suggestions.find((s) => s.transactionId === 'tx-tok-2')
    assert.strictEqual(s2.confidence, 'HIGH')
    assert(s2.reason.includes('tender reference'))

    const s3 = suggestions.find((s) => s.transactionId === 'tx-tok-3')
    assert.strictEqual(s3.confidence, 'HIGH')
    assert(s3.reason.includes('counterparty name'))

    const s4 = suggestions.find((s) => s.transactionId === 'tx-tok-4')
    assert.strictEqual(s4.confidence, 'MEDIUM')
    assert.strictEqual(s4.reason, 'Exact amount matches outstanding invoice')
  })

  test('Settlement suggestions ignore already Paid or reconciled items', () => {
    const data = baseData()
    // Mark invoice paid
    data.invoices[0].status = 'Paid'
    data.invoices[0].outstandingAmount = 0
    data.bankTransactions = [
      { id: 'tx-paid', accountId: 'acc-bank', date: '2026-09-05', description: 'Paid inv', amount: 50000, reconciled: false },
      { id: 'tx-rec', accountId: 'acc-bank', date: '2026-09-05', description: 'Reconciled tx', amount: -12000, reconciled: true },
    ]

    const suggestions = books.computeSettlementSuggestions(data)
    assert.strictEqual(suggestions.length, 0, 'Must produce 0 suggestions when invoice is Paid or tx is reconciled')
  })

  // --- 4. Reconciliation Execution & Double-Entry Balance Invariants ---
  console.log('\n--- 4. Reconciliation Execution & Double-Entry Invariants ---')

  test('Sales Invoice reconciliation posts balanced JournalEntry (Debit acc-bank, Credit acc-ar)', () => {
    const data = baseData()
    data.bankTransactions = [
      { id: 'tx-rec-s', accountId: 'acc-bank', date: '2026-09-05', description: 'Deposit INV-2026-901', amount: 50000, reconciled: false },
    ]
    const p = writeBooks(data)

    const res = books.executeReconciliation({ booksDataPath: p, transactionId: 'tx-rec-s', invoiceId: 'inv-s1' })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.settledAmount, 50000)

    const updated = readBooks()
    const inv = updated.invoices.find((i) => i.id === 'inv-s1')
    assert.strictEqual(inv.status, 'Paid')
    assert.strictEqual(inv.outstandingAmount, 0)

    const party = updated.parties.find((pt) => pt.id === 'party-cust-1')
    assert.strictEqual(party.outstandingBalance, 0)

    const arAcc = updated.accounts.find((a) => a.id === 'acc-ar')
    assert.strictEqual(arAcc.balance, books.CORE_ACCOUNTS.find((a) => a.id === 'acc-ar').balance - 50000)

    // Journal Entry verification
    assert.strictEqual(updated.journalEntries.length, 1)
    const je = updated.journalEntries[0]
    assert.strictEqual(je.posted, true)
    assert.strictEqual(je.totalDebit, 50000)
    assert.strictEqual(je.totalCredit, 50000)
    assert.strictEqual(je.totalDebit, je.totalCredit)

    const debitItem = je.items.find((it) => it.debit > 0)
    const creditItem = je.items.find((it) => it.credit > 0)
    assert.strictEqual(debitItem.accountId, 'acc-bank')
    assert.strictEqual(debitItem.debit, 50000)
    assert.strictEqual(creditItem.accountId, 'acc-ar')
    assert.strictEqual(creditItem.credit, 50000)
  })

  test('Purchase Bill reconciliation posts balanced JournalEntry (Debit acc-ap, Credit acc-bank)', () => {
    const data = baseData()
    data.bankTransactions = [
      { id: 'tx-rec-p', accountId: 'acc-bank', date: '2026-09-05', description: 'Payment BILL-2026-55', amount: -12000, reconciled: false },
    ]
    const p = writeBooks(data)

    const res = books.executeReconciliation({ booksDataPath: p, transactionId: 'tx-rec-p', invoiceId: 'inv-p1' })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.settledAmount, 12000)

    const updated = readBooks()
    const inv = updated.invoices.find((i) => i.id === 'inv-p1')
    assert.strictEqual(inv.status, 'Paid')
    assert.strictEqual(inv.outstandingAmount, 0)

    const party = updated.parties.find((pt) => pt.id === 'party-supp-1')
    assert.strictEqual(party.outstandingBalance, 0)

    const apAcc = updated.accounts.find((a) => a.id === 'acc-ap')
    assert.strictEqual(apAcc.balance, books.CORE_ACCOUNTS.find((a) => a.id === 'acc-ap').balance - 12000)

    // Journal Entry verification
    assert.strictEqual(updated.journalEntries.length, 1)
    const je = updated.journalEntries[0]
    assert.strictEqual(je.posted, true)
    assert.strictEqual(je.totalDebit, 12000)
    assert.strictEqual(je.totalCredit, 12000)
    assert.strictEqual(je.totalDebit, je.totalCredit)

    const debitItem = je.items.find((it) => it.debit > 0)
    const creditItem = je.items.find((it) => it.credit > 0)
    assert.strictEqual(debitItem.accountId, 'acc-ap')
    assert.strictEqual(debitItem.debit, 12000)
    assert.strictEqual(creditItem.accountId, 'acc-bank')
    assert.strictEqual(creditItem.credit, 12000)
  })

  test('Idempotency: Repeated reconciliation rejected with clear error', () => {
    const data = baseData()
    data.bankTransactions = [
      { id: 'tx-idem', accountId: 'acc-bank', date: '2026-09-05', description: 'Wire', amount: 50000, reconciled: false },
    ]
    const p = writeBooks(data)

    const first = books.executeReconciliation({ booksDataPath: p, transactionId: 'tx-idem', invoiceId: 'inv-s1' })
    assert.strictEqual(first.ok, true)

    // Second attempt must fail
    const second = books.executeReconciliation({ booksDataPath: p, transactionId: 'tx-idem', invoiceId: 'inv-s1' })
    assert.strictEqual(second.ok, false)
    assert(second.error.includes('already reconciled') || second.error.includes('already marked Paid'))
  })

  test('Invalid inputs: Non-existent transaction or invoice returns error gracefully', () => {
    const data = baseData()
    const p = writeBooks(data)

    const nonTx = books.executeReconciliation({ booksDataPath: p, transactionId: 'tx-ghost', invoiceId: 'inv-s1' })
    assert.strictEqual(nonTx.ok, false)
    assert(nonTx.error.includes('Transaction not found'))

    const nonInv = books.executeReconciliation({ booksDataPath: p, transactionId: 'tx-s1', invoiceId: 'inv-ghost' })
    assert.strictEqual(nonInv.ok, false)
  })

  // Cleanup sandbox
  try {
    rmSync(sandboxDir, { recursive: true, force: true })
  } catch {}

  console.log('\n===============================================================')
  console.log(`Reviewer 2 Adversarial Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error('❌ ADVERSARIAL STRESS TEST FAILED')
    process.exit(1)
  } else {
    console.log('🎉 ALL REVIEWER 2 ADVERSARIAL STRESS TESTS PASSED!')
    console.log('===============================================================\n')
  }
}

run()

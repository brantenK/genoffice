#!/usr/bin/env node
/**
 * tools/test-challenger-1-m4-empirical.mjs
 *
 * EMPIRICAL ADVERSARIAL TEST HARNESS FOR MILESTONE 4 (challenger_1_m4)
 * Thoroughly verifies:
 * 1. CSV parser resilience across all edge cases (formats, currencies, signs, empty lines, whitespace, invalid amounts)
 * 2. Bank statement import deduplication across 1x, 2x, and 3x imports
 * 3. Bank ledger balance adjustment strict mathematical equality: acc-bank = prev + net
 * 4. Settlement suggestion engine: deposit vs Sales, withdrawal vs Purchase, token disambiguation, zero false positives
 * 5. End-to-end reconciliation double-entry integrity & idempotency
 */

import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Set up an isolated sandbox directory
const sandboxDir = join(tmpdir(), `challenger-1-m4-${randomUUID().slice(0, 8)}`)
mkdirSync(join(sandboxDir, 'books'), { recursive: true })

const ipcHandlers = new Map()

// Mock electron app & ipcMain for headless verification
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

// Load compiled books main module
const books = require('../apps/books/out/main/index.js')

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failureDetails = []

function test(name, fn) {
  totalTests++
  try {
    fn()
    passedTests++
    console.log(`  ✅ [PASS] ${name}`)
  } catch (err) {
    failedTests++
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`)
    failureDetails.push({ name, error: err })
  }
}

async function testAsync(name, fn) {
  totalTests++
  try {
    await fn()
    passedTests++
    console.log(`  ✅ [PASS] ${name}`)
  } catch (err) {
    failedTests++
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`)
    failureDetails.push({ name, error: err })
  }
}

function getBooksFilePath() {
  return join(sandboxDir, 'books', 'books-data.json')
}

function writeBooksData(data) {
  writeFileSync(getBooksFilePath(), JSON.stringify(data, null, 2), 'utf8')
}

function readBooksData() {
  return JSON.parse(readFileSync(getBooksFilePath(), 'utf8'))
}

function createSampleBooksData(initialBankBalance = 485250) {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: {
      companyName: 'Zano Consulting & Engineering (Pty) Ltd',
      taxNumber: '4920198273',
      currency: 'ZAR',
      currencySymbol: 'R',
      financialYearStart: '2026-03-01',
      address: '14 Commerce Square, Sandton',
      email: 'accounts@zanostack.tech',
      phone: '+27 11 555 0192',
    },
    accounts: [
      { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: initialBankBalance },
      { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', parentId: 'acc-curr-asset', isGroup: false, balance: 350000 },
      { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', parentId: 'acc-curr-liab', isGroup: false, balance: 95000 },
      { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 820000 },
      { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 38400 },
    ],
    parties: [
      { id: 'party-ekurhuleni', name: 'City of Ekurhuleni Water Dept', type: 'Customer', outstandingBalance: 145000 },
      { id: 'party-helios', name: 'Helios Clean Energy Solutions', type: 'Customer', outstandingBalance: 115000 },
      { id: 'party-safintra', name: 'Safintra Steel Building Materials', type: 'Supplier', outstandingBalance: 42000 },
      { id: 'party-alpha', name: 'Alpha Logistics & Transport Services', type: 'Customer', outstandingBalance: 50000 },
      { id: 'party-beta', name: 'Beta Technologies International', type: 'Customer', outstandingBalance: 50000 },
    ],
    invoices: [
      {
        id: 'inv-tender-01',
        invoiceNumber: 'INV-2026-041',
        type: 'Sales',
        partyId: 'party-ekurhuleni',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [{ id: 'i1', description: 'Milestone 1 Valve Refurbishment', qty: 1, rate: 126086.96, taxRate: 15, amount: 126086.96 }],
        subtotal: 126086.96,
        taxTotal: 18913.04,
        grandTotal: 145000,
        outstandingAmount: 145000,
        status: 'Unpaid',
        tenderReference: 'RFP-WTR-2026-04',
        createdAt: '2026-09-01T08:00:00Z',
        updatedAt: '2026-09-01T08:00:00Z',
      },
      {
        id: 'inv-crm-01',
        invoiceNumber: 'INV-2026-042',
        type: 'Sales',
        partyId: 'party-helios',
        partyName: 'Helios Clean Energy Solutions',
        date: '2026-09-02',
        dueDate: '2026-10-02',
        items: [{ id: 'i2', description: 'Commercial Solar Installation', qty: 1, rate: 100000, taxRate: 15, amount: 100000 }],
        subtotal: 100000,
        taxTotal: 15000,
        grandTotal: 115000,
        outstandingAmount: 115000,
        status: 'Unpaid',
        crmDealId: 'deal-won-01',
        createdAt: '2026-09-02T08:00:00Z',
        updatedAt: '2026-09-02T08:00:00Z',
      },
      {
        id: 'bill-supp-01',
        invoiceNumber: 'BILL-2026-018',
        type: 'Purchase',
        partyId: 'party-safintra',
        partyName: 'Safintra Steel Building Materials',
        date: '2026-09-03',
        dueDate: '2026-10-03',
        items: [{ id: 'i3', description: 'Industrial Steel Beams', qty: 1, rate: 42000, taxRate: 0, amount: 42000 }],
        subtotal: 42000,
        taxTotal: 0,
        grandTotal: 42000,
        outstandingAmount: 42000,
        status: 'Unpaid',
        createdAt: '2026-09-03T08:00:00Z',
        updatedAt: '2026-09-03T08:00:00Z',
      },
      {
        id: 'inv-alpha-01',
        invoiceNumber: 'INV-2026-050',
        type: 'Sales',
        partyId: 'party-alpha',
        partyName: 'Alpha Logistics & Transport Services',
        date: '2026-09-04',
        dueDate: '2026-10-04',
        items: [{ id: 'i4', description: 'Freight Dispatch Consulting', qty: 1, rate: 43478.26, taxRate: 15, amount: 43478.26 }],
        subtotal: 43478.26,
        taxTotal: 6521.74,
        grandTotal: 50000,
        outstandingAmount: 50000,
        status: 'Unpaid',
        tenderReference: 'RFP-ALPHA-99',
        createdAt: '2026-09-04T08:00:00Z',
        updatedAt: '2026-09-04T08:00:00Z',
      },
      {
        id: 'inv-beta-01',
        invoiceNumber: 'INV-2026-051',
        type: 'Sales',
        partyId: 'party-beta',
        partyName: 'Beta Technologies International',
        date: '2026-09-04',
        dueDate: '2026-10-04',
        items: [{ id: 'i5', description: 'Cloud Architecture Advisory', qty: 1, rate: 43478.26, taxRate: 15, amount: 43478.26 }],
        subtotal: 43478.26,
        taxTotal: 6521.74,
        grandTotal: 50000,
        outstandingAmount: 50000,
        status: 'Unpaid',
        tenderReference: 'RFP-BETA-88',
        createdAt: '2026-09-04T08:00:00Z',
        updatedAt: '2026-09-04T08:00:00Z',
      },
    ],
    journalEntries: [],
    bankTransactions: [],
  }
}

async function runEmpiricalSuite() {
  console.log('\n======================================================================')
  console.log('  CHALLENGER 1 (Milestone 4): EMPIRICAL ADVERSARIAL VERIFICATION')
  console.log('======================================================================\n')

  // Initialize books IPC handlers
  books.registerBooksIpc()

  // --------------------------------------------------------------------------
  // CATEGORY 1: CSV PARSER EDGE CASES
  // --------------------------------------------------------------------------
  console.log('--- Category 1: CSV Parser Edge Cases ---')

  test('1.1 Standard 4-column CSV (Date, Description, Reference, Amount)', () => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,Client EFT Deposit,REF-101,15000.50
2026-09-02,Utility Municipality,REF-102,-3200.75`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[0].accountId, 'acc-bank')
    assert.strictEqual(res[0].date, '2026-09-01')
    assert.strictEqual(res[0].description, 'Client EFT Deposit')
    assert.strictEqual(res[0].reference, 'REF-101')
    assert.strictEqual(res[0].amount, 15000.50)
    assert.strictEqual(res[0].reconciled, false)
    assert.strictEqual(res[1].amount, -3200.75)
  })

  test('1.2 CSV header variations (uppercase, alternative names: Narrative, Value)', () => {
    const csv = `DATE,NARRATIVE,REF,VALUE
2026-09-01,Invoice payment,REF-99,8400.00`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 1)
    assert.strictEqual(res[0].date, '2026-09-01')
    assert.strictEqual(res[0].description, 'Invoice payment')
    assert.strictEqual(res[0].reference, 'REF-99')
    assert.strictEqual(res[0].amount, 8400.00)
  })

  test('1.3 Separate Debit and Credit columns: Debit-only row -> negative amount', () => {
    const csv = `Date,Description,Reference,Debit,Credit
2026-09-01,Supplier Wire,WIRE-01,14250.00,`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 1)
    assert.strictEqual(res[0].amount, -14250.00)
  })

  test('1.4 Separate Debit and Credit columns: Credit-only row -> positive amount', () => {
    const csv = `Date,Description,Reference,Debit,Credit
2026-09-01,Client Wire,WIRE-02,,98000.00`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 1)
    assert.strictEqual(res[0].amount, 98000.00)
  })

  test('1.5 Separate Debit and Credit columns: Empty/zero debit and credit row is safely skipped', () => {
    const csv = `Date,Description,Reference,Debit,Credit
2026-09-01,No-op row,REF-NONE,0.00,0.00
2026-09-02,Valid Inflow,REF-OK,,500.00`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 1)
    assert.strictEqual(res[0].amount, 500.00)
  })

  test('1.6 South African Rand currency symbol (R), spaces, and thousand-separators', () => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,Tender Receipt,RFP-01,"R 1,450,000.00"
2026-09-02,Small Fee,FEE-01,"R75.50"
2026-09-03,Space Separated,REF-03,"R 50 000.00"`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 3)
    assert.strictEqual(res[0].amount, 1450000.00)
    assert.strictEqual(res[1].amount, 75.50)
    assert.strictEqual(res[2].amount, 50000.00)
  })

  test('1.7 US Dollar currency symbol ($), spaces, and comma separators', () => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,Global Client,USD-01,"$ 25,000.50"
2026-09-02,SaaS Expense,USD-02,"-$ 150.00"`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[0].amount, 25000.50)
    assert.strictEqual(res[1].amount, -150.00)
  })

  test('1.8 Parenthesized negatives: plain, formatted with Rand R, and formatted with Dollar $', () => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,Plain Paren,NEG-01,"(25000)"
2026-09-02,Rand Paren,NEG-02,"(R 14,500.50)"
2026-09-03,Dollar Paren,NEG-03,"($ 3,200.00)"
2026-09-04,Spaced Paren,NEG-04,"  ( R 8,900.25 )  "`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 4)
    assert.strictEqual(res[0].amount, -25000.00)
    assert.strictEqual(res[1].amount, -14500.50)
    assert.strictEqual(res[2].amount, -3200.00)
    assert.strictEqual(res[3].amount, -8900.25)
  })

  test('1.9 Trailing empty rows, blank lines, and trailing commas', () => {
    const csv = `Date,Description,Reference,Amount

2026-09-01,First Transaction,REF-1,1000.00

2026-09-02,Second Transaction,REF-2,2000.00,
,,,
  ,  ,  ,  

`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[0].amount, 1000.00)
    assert.strictEqual(res[1].amount, 2000.00)
  })

  test('1.10 Whitespace padding around headers and data columns', () => {
    const csv = `   Date   ,   Description   ,   Reference   ,   Amount   
   2026-09-01   ,   Payment from Clean Energy Corp   ,   REF-WHITE-01   ,   12500.00   `
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 1)
    assert.strictEqual(res[0].date, '2026-09-01')
    assert.strictEqual(res[0].description, 'Payment from Clean Energy Corp')
    assert.strictEqual(res[0].reference, 'REF-WHITE-01')
    assert.strictEqual(res[0].amount, 12500.00)
  })

  test('1.11 Invalid amounts (0, 0.00, R 0.00, NaN, text words) are safely ignored', () => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,Zero entry 1,Z-1,0
2026-09-02,Zero entry 2,Z-2,0.00
2026-09-03,Zero entry 3,Z-3,"R 0.00"
2026-09-04,Invalid text,I-1,N/A
2026-09-05,Invalid text 2,I-2,PENDING
2026-09-06,Valid entry,V-1,450.00
2026-09-07,Invalid symbol only,I-3,R`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 1, 'Only the single valid amount row must be included')
    assert.strictEqual(res[0].amount, 450.00)
    assert.strictEqual(res[0].reference, 'V-1')
  })

  test('1.12 Empty string or headers-only CSV returns empty array cleanly', () => {
    assert.deepStrictEqual(books.parseBankStatementCsv(''), [])
    assert.deepStrictEqual(books.parseBankStatementCsv('Date,Description,Reference,Amount\n'), [])
    assert.deepStrictEqual(books.parseBankStatementCsv('\n\n\n'), [])
  })

  // --------------------------------------------------------------------------
  // CATEGORY 2: BANK STATEMENT IMPORT DEDUPLICATION & LEDGER BALANCE ADJUSTMENT
  // --------------------------------------------------------------------------
  console.log('\n--- Category 2: Bank Statement Import Deduplication & Ledger Balance Adjustment ---')

  const sampleCsvContent = `Date,Description,Reference,Amount
2026-09-01,Deposit from Customer X,DEP-01,25000.00
2026-09-02,Payment to Supplier Y,SUP-01,-10000.00
2026-09-03,Deposit from Customer Z,DEP-02,15000.00`
  // Net transactions: +25,000 - 10,000 + 15,000 = +30,000

  test('2.1 Initial statement import (1x): imports transactions and adjusts bank ledger balance', () => {
    const initialBalance = 485250
    writeBooksData(createSampleBooksData(initialBalance))
    const testBooksPath = getBooksFilePath()

    const res = books.importBankStatement({ booksDataPath: testBooksPath, csvContent: sampleCsvContent })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.importedCount, 3)
    assert.strictEqual(res.skippedDuplicates, 0)
    assert.strictEqual(res.netAdjustment, 30000.00)
    assert.strictEqual(res.newBankBalance, initialBalance + 30000.00)

    const saved = readBooksData()
    const bankAcc = saved.accounts.find((a) => a.id === 'acc-bank')
    assert.strictEqual(bankAcc.balance, initialBalance + 30000.00)
    assert.strictEqual(saved.bankTransactions.length, 3)
  })

  test('2.2 Re-importing the same statement (2x): 0 duplicates imported, zero balance change', () => {
    const testBooksPath = getBooksFilePath()
    const beforeData = readBooksData()
    const balanceBefore = beforeData.accounts.find((a) => a.id === 'acc-bank').balance

    const res2 = books.importBankStatement({ booksDataPath: testBooksPath, csvContent: sampleCsvContent })
    assert.strictEqual(res2.ok, true)
    assert.strictEqual(res2.importedCount, 0, 'Must import 0 duplicate transactions')
    assert.strictEqual(res2.skippedDuplicates, 3, 'Must skip all 3 duplicate transactions')
    assert.strictEqual(res2.netAdjustment, 0, 'Net adjustment must be strictly 0')
    assert.strictEqual(res2.newBankBalance, balanceBefore, 'Bank balance must remain exactly unchanged')

    const afterData = readBooksData()
    const balanceAfter = afterData.accounts.find((a) => a.id === 'acc-bank').balance
    assert.strictEqual(balanceAfter, balanceBefore)
    assert.strictEqual(afterData.bankTransactions.length, 3, 'Transaction list count must remain unchanged')
  })

  test('2.3 Re-importing the same statement a third time (3x): 0 duplicates, zero balance change', () => {
    const testBooksPath = getBooksFilePath()
    const beforeData = readBooksData()
    const balanceBefore = beforeData.accounts.find((a) => a.id === 'acc-bank').balance

    const res3 = books.importBankStatement({ booksDataPath: testBooksPath, csvContent: sampleCsvContent })
    assert.strictEqual(res3.ok, true)
    assert.strictEqual(res3.importedCount, 0)
    assert.strictEqual(res3.skippedDuplicates, 3)
    assert.strictEqual(res3.netAdjustment, 0)
    assert.strictEqual(res3.newBankBalance, balanceBefore)

    const afterData = readBooksData()
    const balanceAfter = afterData.accounts.find((a) => a.id === 'acc-bank').balance
    assert.strictEqual(balanceAfter, balanceBefore)
    assert.strictEqual(afterData.bankTransactions.length, 3)
  })

  test('2.4 Partial overlap import: imports only new rows and adjusts balance strictly by new rows', () => {
    const testBooksPath = getBooksFilePath()
    const beforeData = readBooksData()
    const balanceBefore = beforeData.accounts.find((a) => a.id === 'acc-bank').balance

    // CSV containing 1 duplicate row and 2 brand-new rows
    const partialCsv = `Date,Description,Reference,Amount
2026-09-01,Deposit from Customer X,DEP-01,25000.00
2026-09-04,Brand New Deposit,DEP-03,8000.00
2026-09-05,Brand New Expense,EXP-01,-2000.00`
    // Net for new rows: +8,000 - 2,000 = +6,000

    const res = books.importBankStatement({ booksDataPath: testBooksPath, csvContent: partialCsv })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.importedCount, 2, 'Should only import the 2 new rows')
    assert.strictEqual(res.skippedDuplicates, 1, 'Should skip the 1 existing duplicate row')
    assert.strictEqual(res.netAdjustment, 6000.00)
    assert.strictEqual(res.newBankBalance, balanceBefore + 6000.00)

    const afterData = readBooksData()
    assert.strictEqual(afterData.bankTransactions.length, 5)
    assert.strictEqual(afterData.accounts.find((a) => a.id === 'acc-bank').balance, balanceBefore + 6000.00)
  })

  test('2.5 Zero-sum statement import: imports transactions with netAdjustment = 0', () => {
    const testBooksPath = getBooksFilePath()
    const balanceBefore = readBooksData().accounts.find((a) => a.id === 'acc-bank').balance

    const zeroSumCsv = `Date,Description,Reference,Amount
2026-09-10,Zero Net Inflow,ZN-01,5432.10
2026-09-10,Zero Net Outflow,ZN-02,-5432.10`

    const res = books.importBankStatement({ booksDataPath: testBooksPath, csvContent: zeroSumCsv })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.importedCount, 2)
    assert.strictEqual(res.netAdjustment, 0.00)
    assert.strictEqual(res.newBankBalance, balanceBefore)

    const afterData = readBooksData()
    assert.strictEqual(afterData.accounts.find((a) => a.id === 'acc-bank').balance, balanceBefore)
  })

  test('2.6 Bank ledger balance adjustment strict mathematical equality: acc-bank = prev + net', () => {
    const testCases = [
      { prev: 0, delta: 1234.56, expected: 1234.56 },
      { prev: 100000, delta: -99999.99, expected: 0.01 },
      { prev: -5000, delta: -2500.50, expected: -7500.50 }, // Overdraft balance
      { prev: 50.15, delta: 25.85, expected: 76.00 },
    ]

    for (const tc of testCases) {
      writeBooksData(createSampleBooksData(tc.prev))
      const testBooksPath = getBooksFilePath()

      const csv = `Date,Description,Reference,Amount
2026-09-15,Math Integrity Test,MTH-1,${tc.delta}`
      const res = books.importBankStatement({ booksDataPath: testBooksPath, csvContent: csv })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.netAdjustment, Math.round(tc.delta * 100) / 100)
      assert.strictEqual(res.newBankBalance, tc.expected)

      const saved = readBooksData()
      assert.strictEqual(saved.accounts.find((a) => a.id === 'acc-bank').balance, tc.expected)
    }
  })

  test('2.7 Ingestion of empty or invalid CSV returns error and preserves database unaltered', () => {
    const initialData = createSampleBooksData(100000)
    writeBooksData(initialData)
    const testBooksPath = getBooksFilePath()

    const res = books.importBankStatement({ booksDataPath: testBooksPath, csvContent: 'Date,Description,Reference,Amount\n' })
    assert.strictEqual(res.ok, false)
    assert(res.error.includes('No valid transactions'))

    const afterData = readBooksData()
    assert.strictEqual(afterData.accounts.find((a) => a.id === 'acc-bank').balance, 100000)
    assert.strictEqual(afterData.bankTransactions.length, 0)
  })

  // --------------------------------------------------------------------------
  // CATEGORY 3: SETTLEMENT SUGGESTION MATCHING ENGINE
  // --------------------------------------------------------------------------
  console.log('\n--- Category 3: Settlement Suggestion Matching Engine ---')

  test('3.1 Deposit matching: matches open Sales invoice, strictly ignores Purchase bill of same amount', () => {
    const booksData = createSampleBooksData()
    // Add a Purchase bill with the exact same amount (145,000) as the Sales invoice
    booksData.invoices.push({
      id: 'bill-duplicate-amount',
      invoiceNumber: 'BILL-SAME-145',
      type: 'Purchase',
      partyId: 'party-safintra',
      partyName: 'Safintra Steel Building Materials',
      date: '2026-09-01',
      dueDate: '2026-10-01',
      items: [],
      subtotal: 145000,
      taxTotal: 0,
      grandTotal: 145000,
      outstandingAmount: 145000,
      status: 'Unpaid',
    })

    // Positive transaction (Deposit) of 145,000
    booksData.bankTransactions = [
      {
        id: 'tx-dep-145',
        accountId: 'acc-bank',
        date: '2026-09-02',
        description: 'EFT Deposit for Water Project',
        reference: 'DEP-145',
        amount: 145000,
        reconciled: false,
      },
    ]

    const suggestions = books.computeSettlementSuggestions(booksData)
    assert.strictEqual(suggestions.length, 1, 'Should only match the Sales invoice, not the Purchase bill')
    assert.strictEqual(suggestions[0].invoiceId, 'inv-tender-01')
    assert.strictEqual(suggestions[0].invoiceType, 'Sales')
  })

  test('3.2 Withdrawal matching: matches open Purchase bill, strictly ignores Sales invoice of same amount', () => {
    const booksData = createSampleBooksData()
    // Add a Sales invoice with the exact same amount (42,000) as the Purchase bill
    booksData.invoices.push({
      id: 'inv-duplicate-amount',
      invoiceNumber: 'INV-SAME-42',
      type: 'Sales',
      partyId: 'party-helios',
      partyName: 'Helios Clean Energy Solutions',
      date: '2026-09-03',
      dueDate: '2026-10-03',
      items: [],
      subtotal: 42000,
      taxTotal: 0,
      grandTotal: 42000,
      outstandingAmount: 42000,
      status: 'Unpaid',
    })

    // Negative transaction (Withdrawal) of -42,000
    booksData.bankTransactions = [
      {
        id: 'tx-with-42',
        accountId: 'acc-bank',
        date: '2026-09-03',
        description: 'Supplier settlement payout',
        reference: 'PAY-42',
        amount: -42000,
        reconciled: false,
      },
    ]

    const suggestions = books.computeSettlementSuggestions(booksData)
    assert.strictEqual(suggestions.length, 1, 'Should only match the Purchase bill, not the Sales invoice')
    assert.strictEqual(suggestions[0].invoiceId, 'bill-supp-01')
    assert.strictEqual(suggestions[0].invoiceType, 'Purchase')
  })

  test('3.3 Text token disambiguation: Invoice Number token gives HIGH confidence', () => {
    const booksData = createSampleBooksData()
    booksData.bankTransactions = [
      {
        id: 'tx-inv-no',
        accountId: 'acc-bank',
        date: '2026-09-02',
        description: 'Direct Deposit Ref INV-2026-042',
        reference: 'INV-2026-042',
        amount: 115000,
        reconciled: false,
      },
    ]

    const suggestions = books.computeSettlementSuggestions(booksData)
    assert.strictEqual(suggestions.length, 1)
    assert.strictEqual(suggestions[0].invoiceId, 'inv-crm-01')
    assert.strictEqual(suggestions[0].confidence, 'HIGH')
    assert(suggestions[0].reason.includes('invoice number: INV-2026-042'))
  })

  test('3.4 Text token disambiguation: Tender Reference token gives HIGH confidence', () => {
    const booksData = createSampleBooksData()
    booksData.bankTransactions = [
      {
        id: 'tx-tender-ref',
        accountId: 'acc-bank',
        date: '2026-09-02',
        description: 'Settlement contract RFP-WTR-2026-04',
        reference: 'RFP-WTR-2026-04',
        amount: 145000,
        reconciled: false,
      },
    ]

    const suggestions = books.computeSettlementSuggestions(booksData)
    assert.strictEqual(suggestions.length, 1)
    assert.strictEqual(suggestions[0].invoiceId, 'inv-tender-01')
    assert.strictEqual(suggestions[0].confidence, 'HIGH')
    assert(suggestions[0].reason.includes('tender reference: RFP-WTR-2026-04'))
  })

  test('3.5 Text token disambiguation: Counterparty keyword token gives HIGH confidence', () => {
    const booksData = createSampleBooksData()
    // Description contains 'Ekurhuleni' without invoice number or tender reference
    booksData.bankTransactions = [
      {
        id: 'tx-party-keyword',
        accountId: 'acc-bank',
        date: '2026-09-02',
        description: 'Transfer from Ekurhuleni Treasury',
        reference: 'TREASURY-01',
        amount: 145000,
        reconciled: false,
      },
    ]

    const suggestions = books.computeSettlementSuggestions(booksData)
    assert.strictEqual(suggestions.length, 1)
    assert.strictEqual(suggestions[0].invoiceId, 'inv-tender-01')
    assert.strictEqual(suggestions[0].confidence, 'HIGH')
    assert(suggestions[0].reason.includes('counterparty name: City of Ekurhuleni Water Dept'))
  })

  test('3.6 Competing candidates disambiguation: Same amount, different tokens', () => {
    // Both inv-alpha-01 and inv-beta-01 have exact amount R 50,000
    const booksData = createSampleBooksData()
    booksData.bankTransactions = [
      {
        id: 'tx-alpha',
        accountId: 'acc-bank',
        date: '2026-09-04',
        description: 'Payment for INV-2026-050 Alpha Transport',
        reference: 'ALPHA-REF',
        amount: 50000,
        reconciled: false,
      },
    ]

    const suggestions = books.computeSettlementSuggestions(booksData)
    assert.strictEqual(suggestions.length, 2, 'Should return suggestions for both 50k invoices')

    const alphaSug = suggestions.find((s) => s.invoiceId === 'inv-alpha-01')
    const betaSug = suggestions.find((s) => s.invoiceId === 'inv-beta-01')

    assert.strictEqual(alphaSug.confidence, 'HIGH', 'Alpha must have HIGH confidence due to token match')
    assert.strictEqual(betaSug.confidence, 'MEDIUM', 'Beta must have MEDIUM confidence due to lack of tokens')
  })

  test('3.7 Zero false positives for unmatched amounts: Delta >= 0.01 produces 0 suggestions', () => {
    const booksData = createSampleBooksData()
    booksData.bankTransactions = [
      { id: 't1', accountId: 'acc-bank', date: '2026-09-01', description: 'Off by 1 Rand', amount: 145001.00, reconciled: false },
      { id: 't2', accountId: 'acc-bank', date: '2026-09-01', description: 'Off by 2 cents', amount: 145000.02, reconciled: false },
      { id: 't3', accountId: 'acc-bank', date: '2026-09-01', description: 'Completely different', amount: 99999.00, reconciled: false },
    ]

    const suggestions = books.computeSettlementSuggestions(booksData)
    assert.strictEqual(suggestions.length, 0, 'Must produce zero false positives for amounts differing by >= 0.01')
  })

  test('3.8 Exclude reconciled transactions: Reconciled transactions generate 0 suggestions', () => {
    const booksData = createSampleBooksData()
    booksData.bankTransactions = [
      {
        id: 'tx-reconciled',
        accountId: 'acc-bank',
        date: '2026-09-01',
        description: 'Already Reconciled Transaction',
        amount: 145000,
        reconciled: true, // Marked reconciled
        matchedInvoiceId: 'inv-tender-01',
      },
    ]

    const suggestions = books.computeSettlementSuggestions(booksData)
    assert.strictEqual(suggestions.length, 0, 'Reconciled transaction must not generate suggestions')
  })

  test('3.9 Exclude paid invoices: Paid or 0-outstanding invoices generate 0 suggestions', () => {
    const booksData = createSampleBooksData()
    // Mark inv-tender-01 Paid
    const inv = booksData.invoices.find((i) => i.id === 'inv-tender-01')
    inv.status = 'Paid'
    inv.outstandingAmount = 0

    booksData.bankTransactions = [
      {
        id: 'tx-new',
        accountId: 'acc-bank',
        date: '2026-09-01',
        description: 'EFT Deposit for Water Project',
        amount: 145000,
        reconciled: false,
      },
    ]

    const suggestions = books.computeSettlementSuggestions(booksData)
    assert.strictEqual(suggestions.length, 0, 'Paid invoices must not generate suggestions')
  })

  // --------------------------------------------------------------------------
  // CATEGORY 4: END-TO-END RECONCILIATION & DOUBLE-ENTRY INTEGRITY
  // --------------------------------------------------------------------------
  console.log('\n--- Category 4: End-to-End Reconciliation & Double-Entry Integrity ---')

  test('4.1 Full reconciliation cycle: Updates transaction, invoice, party, and balances', () => {
    const testBooksPath = getBooksFilePath()
    const initialData = createSampleBooksData(500000)
    initialData.bankTransactions = [
      {
        id: 'tx-flow-1',
        accountId: 'acc-bank',
        date: '2026-09-02',
        description: 'EFT Payment INV-2026-042 Helios Clean Energy',
        reference: 'INV-2026-042',
        amount: 115000,
        reconciled: false,
      },
    ]
    writeBooksData(initialData)

    const recResult = books.executeReconciliation({
      booksDataPath: testBooksPath,
      transactionId: 'tx-flow-1',
      invoiceId: 'inv-crm-01',
    })

    assert.strictEqual(recResult.ok, true)
    assert.strictEqual(recResult.settledAmount, 115000)
    assert.strictEqual(recResult.invoiceStatus, 'Paid')

    const updated = readBooksData()

    // 1. Transaction check
    const tx = updated.bankTransactions.find((t) => t.id === 'tx-flow-1')
    assert.strictEqual(tx.reconciled, true)
    assert.strictEqual(tx.matchedInvoiceId, 'inv-crm-01')
    assert(tx.reconciledAt)

    // 2. Invoice check
    const inv = updated.invoices.find((i) => i.id === 'inv-crm-01')
    assert.strictEqual(inv.status, 'Paid')
    assert.strictEqual(inv.outstandingAmount, 0)

    // 3. Party check
    const party = updated.parties.find((p) => p.id === 'party-helios')
    assert.strictEqual(party.outstandingBalance, 0)

    // 4. Accounts check: acc-ar offset
    const arAcc = updated.accounts.find((a) => a.id === 'acc-ar')
    assert.strictEqual(arAcc.balance, 350000 - 115000)

    // 5. Balanced Journal Entry check
    const je = updated.journalEntries[0]
    assert(je, 'Journal entry posted')
    assert.strictEqual(je.totalDebit, 115000)
    assert.strictEqual(je.totalCredit, 115000)
    assert.strictEqual(je.totalDebit, je.totalCredit, 'Debits must strictly equal Credits')
    assert.strictEqual(je.posted, true)
  })

  test('4.2 Supplier Bill reconciliation: Offsets Accounts Payable (acc-ap) and party balance', () => {
    const testBooksPath = getBooksFilePath()
    const initialData = createSampleBooksData(500000)
    initialData.bankTransactions = [
      {
        id: 'tx-flow-supp',
        accountId: 'acc-bank',
        date: '2026-09-03',
        description: 'Payment Safintra Steel',
        reference: 'BILL-2026-018',
        amount: -42000,
        reconciled: false,
      },
    ]
    writeBooksData(initialData)

    const recResult = books.executeReconciliation({
      booksDataPath: testBooksPath,
      transactionId: 'tx-flow-supp',
      invoiceId: 'bill-supp-01',
    })

    assert.strictEqual(recResult.ok, true)
    assert.strictEqual(recResult.settledAmount, 42000)
    assert.strictEqual(recResult.invoiceStatus, 'Paid')

    const updated = readBooksData()
    const bill = updated.invoices.find((i) => i.id === 'bill-supp-01')
    assert.strictEqual(bill.status, 'Paid')
    assert.strictEqual(bill.outstandingAmount, 0)

    const party = updated.parties.find((p) => p.id === 'party-safintra')
    assert.strictEqual(party.outstandingBalance, 0)

    const apAcc = updated.accounts.find((a) => a.id === 'acc-ap')
    assert.strictEqual(apAcc.balance, 95000 - 42000)

    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 42000)
    assert.strictEqual(je.totalCredit, 42000)
  })

  test('4.3 Post-reconciliation suggestion clearance: Settled items generate 0 suggestions', () => {
    const updated = readBooksData()
    const suggestions = books.computeSettlementSuggestions(updated)
    const matched = suggestions.find((s) => s.transactionId === 'tx-flow-supp' || s.invoiceId === 'bill-supp-01')
    assert.strictEqual(matched, undefined, 'Reconciled bill must not appear in any settlement suggestions')
  })

  test('4.4 Idempotency / Double-reconciliation rejection: Re-reconciling returns an error', () => {
    const testBooksPath = getBooksFilePath()
    const recResult = books.executeReconciliation({
      booksDataPath: testBooksPath,
      transactionId: 'tx-flow-supp',
      invoiceId: 'bill-supp-01',
    })

    assert.strictEqual(recResult.ok, false)
    assert(recResult.error.includes('already reconciled') || recResult.error.includes('already marked Paid'))
  })

  await testAsync('4.5 IPC Round-Trip: Ingestion -> Suggestion -> Reconciliation via ipcMain channels', async () => {
    const testBooksPath = getBooksFilePath()
    writeBooksData(createSampleBooksData(500000))

    const importHandler = ipcHandlers.get('books:import-bank-statement-csv')
    const suggestionsHandler = ipcHandlers.get('books:get-settlement-suggestions')
    const reconcileHandler = ipcHandlers.get('books:reconcile-transaction')

    assert(importHandler, 'importBankStatementCsv handler registered')
    assert(suggestionsHandler, 'getSettlementSuggestions handler registered')
    assert(reconcileHandler, 'reconcileTransaction handler registered')

    // 1. Import statement via IPC
    const csv = `Date,Description,Reference,Amount
2026-09-02,Tender Payment RFP-WTR-2026-04 City of Ekurhuleni,RFP-WTR-2026-04,145000.00`
    const impRes = await importHandler({}, csv)
    assert.strictEqual(impRes.ok, true)
    assert.strictEqual(impRes.importedCount, 1)

    // 2. Query suggestions via IPC
    const sugs = await suggestionsHandler({})
    assert.strictEqual(sugs.length, 1)
    assert.strictEqual(sugs[0].invoiceId, 'inv-tender-01')
    assert.strictEqual(sugs[0].confidence, 'HIGH')

    // 3. Reconcile via IPC
    const recRes = await reconcileHandler({}, sugs[0].transactionId, 'inv-tender-01')
    assert.strictEqual(recRes.ok, true)
    assert.strictEqual(recRes.settledAmount, 145000)

    // 4. Verify persistent state
    const saved = readBooksData()
    const savedInv = saved.invoices.find((i) => i.id === 'inv-tender-01')
    assert.strictEqual(savedInv.status, 'Paid')
    assert.strictEqual(savedInv.outstandingAmount, 0)
    assert.strictEqual(saved.accounts.find((a) => a.id === 'acc-ar').balance, 350000 - 145000)
  })

  // Cleanup sandbox directory
  try {
    rmSync(sandboxDir, { recursive: true, force: true })
  } catch {}

  console.log('\n======================================================================')
  console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${failedTests}`)
  console.log('======================================================================\n')

  if (failedTests > 0) {
    console.error('❌ EMPIRICAL ADVERSARIAL VERIFICATION FAILED')
    for (const f of failureDetails) {
      console.error(`- ${f.name}: ${f.error.message}`)
    }
    process.exit(1)
  } else {
    console.log('🎉 ALL EMPIRICAL ADVERSARIAL M4 TESTS PASSED PERFECTLY!')
    process.exit(0)
  }
}

runEmpiricalSuite().catch((err) => {
  console.error('Fatal error running empirical suite:', err)
  process.exit(1)
})

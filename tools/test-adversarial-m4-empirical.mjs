#!/usr/bin/env node
/**
 * tools/test-adversarial-m4-empirical.mjs
 *
 * Adversarial Empirical Verification Suite for Milestone 4:
 * Tests the real compiled apps/books/out/main/index.js helper functions and IPC handlers:
 * - parseBankStatementCsv
 * - importBankStatement
 * - computeSettlementSuggestions
 * - executeReconciliation
 * - IPC: books:import-bank-statement-csv, books:reconcile-transaction, books:get-settlement-suggestions
 */

import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const sandboxDir = join(tmpdir(), `m4-adv-${randomUUID().slice(0, 8)}`)
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

function writeBooksData(data) {
  const filePath = join(sandboxDir, 'books', 'books-data.json')
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function readBooksData() {
  const filePath = join(sandboxDir, 'books', 'books-data.json')
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function createSampleBooksData() {
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
      { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: 485250 },
      { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', parentId: 'acc-curr-asset', isGroup: false, balance: 260000 },
      { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', parentId: 'acc-curr-liab', isGroup: false, balance: 42000 },
      { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 820000 },
      { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 38400 },
    ],
    parties: [
      { id: 'party-1', name: 'City of Ekurhuleni Water Dept', type: 'Customer', outstandingBalance: 145000 },
      { id: 'party-2', name: 'Helios Clean Energy Solutions', type: 'Customer', outstandingBalance: 115000 },
      { id: 'party-3', name: 'Safintra Steel Building Materials', type: 'Supplier', outstandingBalance: 42000 },
    ],
    invoices: [
      {
        id: 'inv-tender-01',
        invoiceNumber: 'INV-2026-041',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [{ id: 'i1', itemCode: 'SRV', description: 'Milestone 1', accountId: 'acc-sales', accountName: 'Sales', qty: 1, rate: 126086.96, taxRate: 15, amount: 126086.96 }],
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
        partyId: 'party-2',
        partyName: 'Helios Clean Energy Solutions',
        date: '2026-09-02',
        dueDate: '2026-10-02',
        items: [{ id: 'i2', itemCode: 'SRV', description: 'Solar Services', accountId: 'acc-sales', accountName: 'Sales', qty: 1, rate: 100000, taxRate: 15, amount: 100000 }],
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
        partyId: 'party-3',
        partyName: 'Safintra Steel Building Materials',
        date: '2026-09-03',
        dueDate: '2026-10-03',
        items: [{ id: 'i3', itemCode: 'MAT', description: 'Steel', accountId: 'acc-ap', accountName: 'Payables', qty: 1, rate: 42000, taxRate: 0, amount: 42000 }],
        subtotal: 42000,
        taxTotal: 0,
        grandTotal: 42000,
        outstandingAmount: 42000,
        status: 'Unpaid',
        createdAt: '2026-09-03T08:00:00Z',
        updatedAt: '2026-09-03T08:00:00Z',
      },
    ],
    journalEntries: [],
    bankTransactions: [],
  }
}

async function runAdversarialM4Suite() {
  console.log('\n======================================================================')
  console.log('   ZANO BOOKS: ADVERSARIAL EMPIRICAL M4 VERIFICATION SUITE')
  console.log('======================================================================\n')

  // Register IPC handlers
  books.registerBooksIpc()

  // 1. CSV Parser Resilience
  test('CSV Parser: Standard columns (Date, Description, Reference, Amount)', () => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,Payment from Customer A,REF-100,5000.00
2026-09-02,Supplier payment,REF-200,-1500.50`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[0].accountId, 'acc-bank')
    assert.strictEqual(res[0].amount, 5000.00)
    assert.strictEqual(res[0].reference, 'REF-100')
    assert.strictEqual(res[1].amount, -1500.50)
  })

  test('CSV Parser: Debit and Credit separate columns', () => {
    const csv = `Date,Narrative,Reference,Debit,Credit
2026-09-01,Deposit receipt,REF-A,,12000.00
2026-09-02,Utility bill,REF-B,3400.00,`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[0].amount, 12000.00)
    assert.strictEqual(res[1].amount, -3400.00)
  })

  test('CSV Parser: Currency symbols (R, $), whitespace, commas, parenthesized negative', () => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,Inflow Rands,REF-1,"R 1,234,567.89"
2026-09-02,Outflow Parentheses,REF-2,"(R 45,000.00)"
2026-09-03,Dollar inflow,REF-3,"$ 10,500.00"
2026-09-04,Plain paren,REF-4,"(25000)"`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 4)
    assert.strictEqual(res[0].amount, 1234567.89)
    assert.strictEqual(res[1].amount, -45000.00)
    assert.strictEqual(res[2].amount, 10500.00)
    assert.strictEqual(res[3].amount, -25000.00)
  })

  test('CSV Parser: Malformed rows, empty lines, trailing commas handled cleanly', () => {
    const csv = `Date,Description,Reference,Amount

2026-09-01,Valid entry,REF-OK,500.00,
,,,
malformed without amount,,,
2026-09-02,Another valid,REF-OK2,-300.00

`
    const res = books.parseBankStatementCsv(csv)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[0].amount, 500.00)
    assert.strictEqual(res[1].amount, -300.00)
  })

  // 2. Import & Ingestion
  test('Bank Statement Ingestion: Balance adjustment and deduplication', () => {
    const testBooksPath = join(sandboxDir, 'books', 'books-data.json')
    writeBooksData(createSampleBooksData())

    const csv1 = `Date,Description,Reference,Amount
2026-09-01,Deposit 1,REF-D1,10000.00
2026-09-02,Withdrawal 1,REF-W1,-2500.00`

    const res1 = books.importBankStatement({ booksDataPath: testBooksPath, csvContent: csv1 })
    assert.strictEqual(res1.ok, true)
    assert.strictEqual(res1.importedCount, 2)
    assert.strictEqual(res1.netAdjustment, 7500.00)
    assert.strictEqual(res1.newBankBalance, 485250 + 7500.00)

    // Re-importing same statement should skip duplicates
    const res2 = books.importBankStatement({ booksDataPath: testBooksPath, csvContent: csv1 })
    assert.strictEqual(res2.ok, true)
    assert.strictEqual(res2.importedCount, 0)
    assert.strictEqual(res2.skippedDuplicates, 2)
    assert.strictEqual(res2.netAdjustment, 0)
  })

  // 3. Settlement Suggestions
  test('Settlement Suggestions: Matching deposits with Sales and withdrawals with Purchases', () => {
    const initialData = createSampleBooksData()
    initialData.bankTransactions = [
      {
        id: 'tx-1',
        accountId: 'acc-bank',
        date: '2026-09-02',
        description: 'EFT Deposit RFP-WTR-2026-04 City of Ekurhuleni',
        reference: 'RFP-WTR-2026-04',
        amount: 145000,
        reconciled: false,
      },
      {
        id: 'tx-2',
        accountId: 'acc-bank',
        date: '2026-09-03',
        description: 'EFT Payment INV-2026-042 Helios Clean Energy',
        reference: 'INV-2026-042',
        amount: 115000,
        reconciled: false,
      },
      {
        id: 'tx-3',
        accountId: 'acc-bank',
        date: '2026-09-04',
        description: 'EFT Supplier Settlement Safintra Steel',
        reference: 'BILL-2026-018',
        amount: -42000,
        reconciled: false,
      },
      {
        id: 'tx-4',
        accountId: 'acc-bank',
        date: '2026-09-05',
        description: 'Random bank fee',
        reference: 'FEE-01',
        amount: -450,
        reconciled: false,
      },
    ]

    const suggestions = books.computeSettlementSuggestions(initialData)
    assert.strictEqual(suggestions.length, 3, 'Should find exactly 3 suggestions for 3 open invoices')

    const sug1 = suggestions.find((s) => s.transactionId === 'tx-1')
    assert(sug1, 'Found tender suggestion')
    assert.strictEqual(sug1.confidence, 'HIGH')
    assert.strictEqual(sug1.invoiceId, 'inv-tender-01')

    const sug2 = suggestions.find((s) => s.transactionId === 'tx-2')
    assert(sug2, 'Found CRM deal suggestion')
    assert.strictEqual(sug2.confidence, 'HIGH')
    assert.strictEqual(sug2.invoiceId, 'inv-crm-01')

    const sug3 = suggestions.find((s) => s.transactionId === 'tx-3')
    assert(sug3, 'Found supplier bill suggestion')
    assert.strictEqual(sug3.confidence, 'HIGH')
    assert.strictEqual(sug3.invoiceId, 'bill-supp-01')
  })

  // 4. Execution of Reconciliation & Ledger Accounting
  test('executeReconciliation: Reconciles invoice, updates party, posts balanced journal entry', () => {
    const testBooksPath = join(sandboxDir, 'books', 'books-data.json')
    const initialData = createSampleBooksData()
    initialData.bankTransactions = [
      {
        id: 'tx-rec-1',
        accountId: 'acc-bank',
        date: '2026-09-02',
        description: 'Settlement for INV-2026-041',
        reference: 'INV-2026-041',
        amount: 145000,
        reconciled: false,
      },
    ]
    writeBooksData(initialData)

    const recRes = books.executeReconciliation({
      booksDataPath: testBooksPath,
      transactionId: 'tx-rec-1',
      invoiceId: 'inv-tender-01',
    })

    assert.strictEqual(recRes.ok, true)
    assert.strictEqual(recRes.settledAmount, 145000)

    const updated = readBooksData()
    const txAfter = updated.bankTransactions.find((t) => t.id === 'tx-rec-1')
    assert.strictEqual(txAfter.reconciled, true)
    assert.strictEqual(txAfter.matchedInvoiceId, 'inv-tender-01')
    assert(txAfter.reconciledAt)

    const invAfter = updated.invoices.find((i) => i.id === 'inv-tender-01')
    assert.strictEqual(invAfter.status, 'Paid')
    assert.strictEqual(invAfter.outstandingAmount, 0)

    const partyAfter = updated.parties.find((p) => p.id === 'party-1')
    assert.strictEqual(partyAfter.outstandingBalance, 0)

    const arAcc = updated.accounts.find((a) => a.id === 'acc-ar')
    assert.strictEqual(arAcc.balance, 260000 - 145000)

    // Check Journal Entry
    assert(updated.journalEntries.length >= 1)
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 145000)
    assert.strictEqual(je.totalCredit, 145000)
    assert.strictEqual(je.posted, true)

    // Re-reconciling should fail
    const duplicateRec = books.executeReconciliation({
      booksDataPath: testBooksPath,
      transactionId: 'tx-rec-1',
      invoiceId: 'inv-tender-01',
    })
    assert.strictEqual(duplicateRec.ok, false)
    assert(duplicateRec.error.includes('already reconciled') || duplicateRec.error.includes('already marked Paid'))
  })

  // 5. IPC Handlers via ipcMain
  await testAsync('IPC Handlers: importBankStatementCsv, getSettlementSuggestions, reconcileTransaction', async () => {
    const testBooksPath = join(sandboxDir, 'books', 'books-data.json')
    writeBooksData(createSampleBooksData())

    const importHandler = ipcHandlers.get('books:import-bank-statement-csv')
    assert(importHandler, 'importBankStatementCsv handler registered')

    const suggestionsHandler = ipcHandlers.get('books:get-settlement-suggestions')
    assert(suggestionsHandler, 'getSettlementSuggestions handler registered')

    const reconcileHandler = ipcHandlers.get('books:reconcile-transaction')
    assert(reconcileHandler, 'reconcileTransaction handler registered')

    // 1. Import via IPC
    const csv = `Date,Description,Reference,Amount
2026-09-02,Helios Energy Solar Payment,INV-2026-042,115000.00`
    const impRes = await importHandler({}, csv)
    assert.strictEqual(impRes.ok, true)
    assert.strictEqual(impRes.importedCount, 1)

    // 2. Get suggestions via IPC
    const sugs = await suggestionsHandler({})
    assert.strictEqual(sugs.length, 1)
    assert.strictEqual(sugs[0].invoiceId, 'inv-crm-01')
    assert.strictEqual(sugs[0].confidence, 'HIGH')

    // 3. Reconcile via IPC
    const txId = sugs[0].transactionId
    const recRes = await reconcileHandler({}, txId, 'inv-crm-01')
    assert.strictEqual(recRes.ok, true)

    // Verify persistence
    const saved = readBooksData()
    const savedInv = saved.invoices.find((i) => i.id === 'inv-crm-01')
    assert.strictEqual(savedInv.status, 'Paid')
    assert.strictEqual(savedInv.outstandingAmount, 0)
  })

  // Cleanup sandbox
  try {
    rmSync(sandboxDir, { recursive: true, force: true })
  } catch {}

  console.log('\n----------------------------------------------------------------------')
  console.log(`Results: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  if (failedTests > 0) {
    console.error('❌ ADVERSARIAL VERIFICATION FAILED')
    process.exit(1)
  } else {
    console.log('🎉 ALL ADVERSARIAL EMPIRICAL M4 TESTS PASSED!')
    console.log('----------------------------------------------------------------------\n')
  }
}

runAdversarialM4Suite()

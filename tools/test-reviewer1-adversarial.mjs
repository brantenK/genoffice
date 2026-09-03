import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
 
const require = createRequire(import.meta.url)
 
const sandboxDir = join(tmpdir(), `r1-adv-d{randomUUID().slice(0, 8)}`)
mkdirSync(join(sandboxDir, 'books'), { recursive: true })
 
require.cache[require.resolve('electron')] = {
  exports: {
    app: {
      getPath: (name) => {
        if (name === 'userData') return sandboxDir
        return tmpdir()
      },
    },
    ipcMain: {
      handle: () => {},
    },
    WebContentsView: class {},
  },
}
 
const books = require('../apps/books/out/main/index.js')
 
let passed = 0
let failed = 0
 
function runTest(name, fn) {
  try {
    fn()
    passed++
    console.log(`[PASS] ${name}`)
  } catch (err) {
    failed++
    console.error(`[FAIL] ${name}: ${err.message}`)
  }
}
 
// 1. Empty & Boundary CSV
runTest('CSV: Empty, whitespace, header-only', () => {
  assert.deepStrictEqual(books.parseBankStatementCsv(''), [])
  assert.deepStrictEqual(books.parseBankStatementCsv('   \n  \n  '), [])
  assert.deepStrictEqual(books.parseBankStatementCsv('Date,Description,Reference,Amount'), [])
})
 
// 2. Complex quoted fields
runTest('CSV: Quoted commas and descriptions', () => {
  const csv = 'Date,Description,Reference,Amount\n2026-09-01,"Apex Valves, Supplies and Tools","REF, #1234","R 55,200.50"'
  const res = books.parseBankStatementCsv(csv)
  assert.strictEqual(res.length, 1)
  assert.strictEqual(res[0].description, 'Apex Valves, Supplies and Tools')
  assert.strictEqual(res[0].reference, 'REF, #1234')
  assert.strictEqual(res[0].amount, 55200.50)
})
 
// 3. Currency parsing
runTest('CSV: Negative formats and currency symbols', () => {
  const csv = `Date,Narrative,Ref,Amount
2026-09-01,Case A,R1,"R 1,500.00"
2026-09-02,Case B,R2,"(R 2,500.00)"
2026-09-03,Case C,R3,"$ 3,000.00"
2026-09-04,Case D,R4,"(4500)"
2026-09-05,Case E,R5,"-750.25"`
  const res = books.parseBankStatementCsv(csv)
  assert.strictEqual(res.length, 5)
  assert.strictEqual(res[0].amount, 1500.00)
  assert.strictEqual(res[1].amount, -2500.00)
  assert.strictEqual(res[2].amount, 3000.00)
  assert.strictEqual(res[3].amount, -4500.00)
  assert.strictEqual(res[4].amount, -750.25)
})
 
// 4. Debit/Credit columns
runTest('CSV: Debit and Credit separate columns mapping', () => {
  const csv = `Date,Description,Reference,Debit,Credit
2026-09-01,Deposit,REF-1,,15000.00
2026-09-02,Withdrawal,REF-2,4500.00,
2026-09-03,Zero entry,REF-3,0.00,0.00`
  const res = books.parseBankStatementCsv(csv)
  assert.strictEqual(res.length, 2)
  assert.strictEqual(res[0].amount, 15000.00)
  assert.strictEqual(res[1].amount, -4500.00)
})
 
// 5. Settlement Suggestions: Directionality, Tolerance, and Confidence
runTest('Suggestions: Directionality, Tolerance & Scoring', () => {
  const booksData = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { currency: 'ZAR', currencySymbol: 'R' },
    accounts: [{ id: 'acc-bank', balance: 100000 }],
    parties: [
      { id: 'p1', name: 'Alpha Corp', outstandingBalance: 10000 },
      { id: 'p2', name: 'Beta Logistics', outstandingBalance: 5000 },
    ],
    invoices: [
      {
        id: 'inv-1',
        invoiceNumber: 'INV-100',
        type: 'Sales',
        partyId: 'p1',
        partyName: 'Alpha Corp',
        outstandingAmount: 10000,
        status: 'Unpaid',
      },
      {
        id: 'inv-2',
        invoiceNumber: 'BILL-200',
        type: 'Purchase',
        partyId: 'p2',
        partyName: 'Beta Logistics',
        outstandingAmount: 5000,
        status: 'Unpaid',
      },
    ],
    journalEntries: [],
    bankTransactions: [
      { id: 't1', accountId: 'acc-bank', date: '2026-09-01', description: 'Deposit INV-100', amount: 10000, reconciled: false },
      { id: 't2', accountId: 'acc-bank', date: '2026-09-02', description: 'Payment Beta Logistics', amount: -5000, reconciled: false },
      { id: 't3', accountId: 'acc-bank', date: '2026-09-03', description: 'Random deposit', amount: 5000, reconciled: false },
      { id: 't4', accountId: 'acc-bank', date: '2026-09-04', description: 'Close but wrong', amount: 10000.10, reconciled: false },
    ],
  }
 
  const sugs = books.computeSettlementSuggestions(booksData)
  assert.strictEqual(sugs.length, 2)
  
  const s1 = sugs.find(s => s.transactionId === 't1')
  assert(s1)
  assert.strictEqual(s1.invoiceId, 'inv-1')
  assert.strictEqual(s1.confidence, 'HIGH')
  
  const s2 = sugs.find(s => s.transactionId === 't2')
  assert(s2)
  assert.strictEqual(s2.invoiceId, 'inv-2')
  assert.strictEqual(s2.confidence, 'HIGH')
})
 
// 6. Reconciliation execution integrity
runTest('Reconciliation: double-entry integrity and idempotency', () => {
  const booksPath = join(sandboxDir, 'books', 'books-data.json')
  const initial = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { currency: 'ZAR', currencySymbol: 'R' },
    accounts: [
      { id: 'acc-bank', rootType: 'Asset', balance: 50000 },
      { id: 'acc-ar', rootType: 'Asset', balance: 20000 },
    ],
    parties: [{ id: 'p1', name: 'Client A', outstandingBalance: 20000 }],
    invoices: [
      { id: 'inv-a', invoiceNumber: 'INV-A1a', type: 'Sales', partyId: 'p1', partyName: 'Client A', outstandingAmount: 20000, status: 'Unpaid' },
    ],
    journalEntries: [],
    bankTransactions: [
      { id: 'tx-a', accountId: 'acc-bank', date: '2026-09-01', description: 'Client A Payment', amount: 20000, reconciled: false },
    ],
  }
  writeFileSync(booksPath, JSON.stringify(initial, null, 2), 'utf8')
  
  const rec = books.executeReconciliation({
    booksDataPath: booksPath,
    transactionId: 'tx-a',
    invoiceId: 'inv-a',
  })
  assert.strictEqual(rec.ok, true)
  
  const after = JSON.parse(readFileSync(booksPath, 'utf8'))
  assert.strictEqual(after.invoices[0].status, 'Paid')
  assert.strictEqual(after.invoices[0].outstandingAmount, 0)
  assert.strictEqual(after.parties[0].outstandingBalance, 0)
  assert.strictEqual(after.accounts.find(a => a.id === 'acc-ar').balance, 0)
  assert.strictEqual(after.bankTransactions[0].reconciled, true)
  assert.strictEqual(after.journalEntries.length, 1)
  assert.strictEqual(after.journalEntries[0].totalDebit, 20000)
  assert.strictEqual(after.journalEntries[0].totalCredit, 20000)
  
  // Re-reconciliation attempt must be rejected
  const rec2 = books.executeReconciliation({
    booksDataPath: booksPath,
    transactionId: 'tx-a',
    invoiceId: 'inv-a',
  })
  assert.strictEqual(rec2.ok, false)
})
 
// 7. Migration of legacy data without bankTransactions
runTest('Migration: Legacy v0 data envelope safely upgraded', () => {
  const legacy = {
    settings: { companyName: 'Legacy Co' },
    accounts: [{ id: 'acc-bank', balance: 1000 }],
    parties: [],
    invoices: [],
    journalEntries: [],
  }
  const envelope = books.migrateAndValidateBooks(legacy)
  assert.strictEqual(envelope.version, 1)
  assert(Array.isArray(envelope.bankTransactions))
  assert.strictEqual(envelope.bankTransactions.length, 0)
})
 
try {
  rmSync(sandboxDir, { recursive: true, force: true })
} catch {}
 
console.log(`\nAdversarial Edge Case Tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

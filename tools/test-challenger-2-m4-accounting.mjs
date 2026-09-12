#!/usr/bin/env node
/**
 * tools/test-challenger-2-m4-accounting.mjs
 *
 * Challenger 2 Milestone 4 Adversarial Test Harness:
 * Focuses on empirical verification of Milestone 4 accounting side-effects,
 * 1-click reconciliation invariants, double-entry ledger balance, and error guards.
 */

import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Sandbox directory for isolated testing
const sandboxDir = join(tmpdir(), `m4-challenger2-${randomUUID().slice(0, 8)}`)
mkdirSync(join(sandboxDir, 'books'), { recursive: true })

const ipcHandlers = new Map()

// Electron mock for IPC & app path resolution
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

function getBooksFilePath() {
  return join(sandboxDir, 'books', 'books-data.json')
}

function writeBooksData(data) {
  writeFileSync(getBooksFilePath(), JSON.stringify(data, null, 2), 'utf8')
}

function readBooksData() {
  return JSON.parse(readFileSync(getBooksFilePath(), 'utf8'))
}

function createFreshBooksData() {
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
      { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: 500000 },
      { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', parentId: 'acc-curr-asset', isGroup: false, balance: 350000 },
      { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', parentId: 'acc-curr-liab', isGroup: false, balance: 120000 },
      { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 900000 },
      { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 45000 },
    ],
    parties: [
      { id: 'party-cust-1', name: 'City of Ekurhuleni Water Dept', type: 'Customer', outstandingBalance: 145000 },
      { id: 'party-cust-2', name: 'Helios Clean Energy Solutions', type: 'Customer', outstandingBalance: 115000.75 },
      { id: 'party-cust-3', name: 'Acme Commercial Properties', type: 'Customer', outstandingBalance: 5000 },
      { id: 'party-supp-1', name: 'Safintra Steel Building Materials', type: 'Supplier', outstandingBalance: 42000 },
      { id: 'party-supp-2', name: 'Consolidated Electrical Wholesalers', type: 'Supplier', outstandingBalance: 18500.50 },
    ],
    invoices: [
      {
        id: 'inv-sales-tender',
        invoiceNumber: 'INV-2026-041',
        type: 'Sales',
        partyId: 'party-cust-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [{ id: 'i1', itemCode: 'SRV', description: 'Milestone 1 Reservoir', accountId: 'acc-sales', accountName: 'Sales', qty: 1, rate: 126086.96, taxRate: 15, amount: 126086.96 }],
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
        id: 'inv-sales-crm-fractional',
        invoiceNumber: 'INV-2026-042',
        type: 'Sales',
        partyId: 'party-cust-2',
        partyName: 'Helios Clean Energy Solutions',
        date: '2026-09-02',
        dueDate: '2026-10-02',
        items: [{ id: 'i2', itemCode: 'SRV', description: 'Solar Installation', accountId: 'acc-sales', accountName: 'Sales', qty: 1, rate: 100000.65, taxRate: 15, amount: 100000.65 }],
        subtotal: 100000.65,
        taxTotal: 15000.10,
        grandTotal: 115000.75,
        outstandingAmount: 115000.75,
        status: 'Unpaid',
        crmDealId: 'deal-solar-won',
        createdAt: '2026-09-02T08:00:00Z',
        updatedAt: '2026-09-02T08:00:00Z',
      },
      {
        id: 'inv-sales-partyname-only',
        invoiceNumber: 'INV-2026-043',
        type: 'Sales',
        partyId: 'unmatched-party-id',
        partyName: 'Acme Commercial Properties',
        date: '2026-09-03',
        dueDate: '2026-10-03',
        items: [{ id: 'i3', itemCode: 'SRV', description: 'HVAC Maintenance', accountId: 'acc-sales', accountName: 'Sales', qty: 1, rate: 10000, taxRate: 0, amount: 10000 }],
        subtotal: 10000,
        taxTotal: 0,
        grandTotal: 10000,
        outstandingAmount: 10000,
        status: 'Unpaid',
        createdAt: '2026-09-03T08:00:00Z',
        updatedAt: '2026-09-03T08:00:00Z',
      },
      {
        id: 'inv-sales-orphan-party',
        invoiceNumber: 'INV-2026-044',
        type: 'Sales',
        partyId: 'non-existent-party-id',
        partyName: 'Ghost Client LLC',
        date: '2026-09-03',
        dueDate: '2026-10-03',
        items: [{ id: 'i4', itemCode: 'SRV', description: 'Consulting', accountId: 'acc-sales', accountName: 'Sales', qty: 1, rate: 8000, taxRate: 0, amount: 8000 }],
        subtotal: 8000,
        taxTotal: 0,
        grandTotal: 8000,
        outstandingAmount: 8000,
        status: 'Unpaid',
        createdAt: '2026-09-03T08:00:00Z',
        updatedAt: '2026-09-03T08:00:00Z',
      },
      {
        id: 'bill-purch-steel',
        invoiceNumber: 'BILL-2026-018',
        type: 'Purchase',
        partyId: 'party-supp-1',
        partyName: 'Safintra Steel Building Materials',
        date: '2026-09-03',
        dueDate: '2026-10-03',
        items: [{ id: 'b1', itemCode: 'MAT', description: 'Structural Steel', accountId: 'acc-ap', accountName: 'Payables', qty: 1, rate: 42000, taxRate: 0, amount: 42000 }],
        subtotal: 42000,
        taxTotal: 0,
        grandTotal: 42000,
        outstandingAmount: 42000,
        status: 'Unpaid',
        createdAt: '2026-09-03T08:00:00Z',
        updatedAt: '2026-09-03T08:00:00Z',
      },
      {
        id: 'bill-purch-elec-fractional',
        invoiceNumber: 'BILL-2026-019',
        type: 'Purchase',
        partyId: 'party-supp-2',
        partyName: 'Consolidated Electrical Wholesalers',
        date: '2026-09-04',
        dueDate: '2026-10-04',
        items: [{ id: 'b2', itemCode: 'MAT', description: 'High Voltage Cables', accountId: 'acc-ap', accountName: 'Payables', qty: 1, rate: 18500.50, taxRate: 0, amount: 18500.50 }],
        subtotal: 18500.50,
        taxTotal: 0,
        grandTotal: 18500.50,
        outstandingAmount: 18500.50,
        status: 'Unpaid',
        createdAt: '2026-09-04T08:00:00Z',
        updatedAt: '2026-09-04T08:00:00Z',
      },
    ],
    journalEntries: [],
    bankTransactions: [],
  }
}

async function runChallenger2M4AccountingSuite() {
  console.log('\n================================================================================')
  console.log('  CHALLENGER 2: EMPIRICAL VERIFICATION OF MILESTONE 4 ACCOUNTING SIDE-EFFECTS')
  console.log('================================================================================\n')

  const booksPath = getBooksFilePath()
  books.registerBooksIpc()

  // --------------------------------------------------------------------------
  // SUITE 1: 1-Click Reconciliation of Sales Invoices
  // --------------------------------------------------------------------------
  console.log('--- Suite 1: Sales Invoice 1-Click Reconciliation Side-Effects ---')

  test('1.1: Sales invoice reconciliation marks transaction reconciled with matchedInvoiceId & timestamp', () => {
    const data = createFreshBooksData()
    data.bankTransactions.push({
      id: 'tx-dep-1',
      accountId: 'acc-bank',
      date: '2026-09-02',
      description: 'EFT Deposit RFP-WTR-2026-04 City of Ekurhuleni',
      reference: 'RFP-WTR-2026-04',
      amount: 145000,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-dep-1',
      invoiceId: 'inv-sales-tender',
    })

    assert.strictEqual(res.ok, true, 'executeReconciliation should succeed')
    assert.strictEqual(res.settledAmount, 145000, 'settledAmount should equal invoice outstanding amount')
    assert.strictEqual(res.invoiceStatus, 'Paid', 'invoiceStatus in response should be Paid')

    const updated = readBooksData()
    const tx = updated.bankTransactions.find((t) => t.id === 'tx-dep-1')
    assert.strictEqual(tx.reconciled, true, 'tx.reconciled must be true')
    assert.strictEqual(tx.matchedInvoiceId, 'inv-sales-tender', 'tx.matchedInvoiceId must match invoice id')
    assert.ok(tx.reconciledAt, 'tx.reconciledAt must be defined')
    assert.ok(!isNaN(Date.parse(tx.reconciledAt)), 'tx.reconciledAt must be valid ISO date')
  })

  test('1.2: Sales invoice reconciliation sets status to Paid, outstandingAmount to 0', () => {
    const updated = readBooksData()
    const inv = updated.invoices.find((i) => i.id === 'inv-sales-tender')
    assert.strictEqual(inv.status, 'Paid', 'Invoice status must be Paid')
    assert.strictEqual(inv.outstandingAmount, 0, 'outstandingAmount must be 0')
    assert.ok(inv.updatedAt, 'updatedAt must be updated')
  })

  test('1.3: Sales invoice reconciliation decrements customer outstandingBalance', () => {
    const updated = readBooksData()
    const party = updated.parties.find((p) => p.id === 'party-cust-1')
    assert.strictEqual(party.outstandingBalance, 0, 'party-cust-1 outstandingBalance should be decremented from 145000 to 0')
  })

  test('1.4: Sales invoice reconciliation offsets Accounts Receivable (acc-ar)', () => {
    const updated = readBooksData()
    const ar = updated.accounts.find((a) => a.id === 'acc-ar')
    // Initial 350000 - 145000 = 205000
    assert.strictEqual(ar.balance, 205000, 'acc-ar balance must be reduced by settled amount (350000 - 145000 = 205000)')
  })

  test('1.5: Sales invoice reconciliation posts balanced JournalEntry (Debit acc-bank, Credit acc-ar)', () => {
    const updated = readBooksData()
    assert.strictEqual(updated.journalEntries.length, 1, 'Exactly 1 journal entry should be posted')
    const je = updated.journalEntries[0]

    assert.strictEqual(je.posted, true, 'Journal entry must be posted')
    assert.strictEqual(je.totalDebit, 145000, 'totalDebit must equal settled amount')
    assert.strictEqual(je.totalCredit, 145000, 'totalCredit must equal settled amount')
    assert.strictEqual(je.totalDebit, je.totalCredit, 'Double-entry balance: totalDebit === totalCredit')

    assert.strictEqual(je.items.length, 2, 'Must have 2 line items')
    const debitItem = je.items.find((i) => i.accountId === 'acc-bank')
    const creditItem = je.items.find((i) => i.accountId === 'acc-ar')

    assert.ok(debitItem, 'Debit item on acc-bank must exist')
    assert.strictEqual(debitItem.debit, 145000, 'acc-bank must be debited by 145000')
    assert.strictEqual(debitItem.credit, 0, 'acc-bank credit must be 0')

    assert.ok(creditItem, 'Credit item on acc-ar must exist')
    assert.strictEqual(creditItem.debit, 0, 'acc-ar debit must be 0')
    assert.strictEqual(creditItem.credit, 145000, 'acc-ar must be credited by 145000')
    assert.strictEqual(creditItem.partyId, 'party-cust-1', 'Party ID should be linked on AR journal item')
    assert.strictEqual(creditItem.partyName, 'City of Ekurhuleni Water Dept', 'Party name should be linked on AR journal item')
  })

  test('1.6: Sales invoice with fractional cents reconciliation preserves exact cent accuracy', () => {
    const data = readBooksData()
    data.bankTransactions.push({
      id: 'tx-dep-fract',
      accountId: 'acc-bank',
      date: '2026-09-03',
      description: 'Solar Settlement INV-2026-042 Helios',
      amount: 115000.75,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-dep-fract',
      invoiceId: 'inv-sales-crm-fractional',
    })

    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.settledAmount, 115000.75)

    const updated = readBooksData()
    const party = updated.parties.find((p) => p.id === 'party-cust-2')
    assert.strictEqual(party.outstandingBalance, 0, 'party-cust-2 balance decremented to exactly 0')

    const ar = updated.accounts.find((a) => a.id === 'acc-ar')
    // 205000 - 115000.75 = 89999.25
    assert.strictEqual(ar.balance, 89999.25, 'acc-ar balance accurately decremented with cents')

    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 115000.75)
    assert.strictEqual(je.totalCredit, 115000.75)
    assert.strictEqual(je.totalDebit, je.totalCredit)
  })

  test('1.7: Sales invoice matching party by name when partyId differs', () => {
    const data = readBooksData()
    data.bankTransactions.push({
      id: 'tx-dep-name-only',
      accountId: 'acc-bank',
      date: '2026-09-03',
      description: 'Acme Commercial Maintenance INV-2026-043',
      amount: 10000,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-dep-name-only',
      invoiceId: 'inv-sales-partyname-only',
    })

    assert.strictEqual(res.ok, true)
    const updated = readBooksData()
    const party = updated.parties.find((p) => p.name === 'Acme Commercial Properties')
    // Initial balance was 5000, invoice was 10000 -> Math.max(0, 5000 - 10000) = 0
    assert.strictEqual(party.outstandingBalance, 0, 'party balance clamped at 0 without negative overflow')
  })

  test('1.8: Sales invoice with non-existent party degrades gracefully without error', () => {
    const data = readBooksData()
    data.bankTransactions.push({
      id: 'tx-dep-ghost',
      accountId: 'acc-bank',
      date: '2026-09-03',
      description: 'Ghost client payment',
      amount: 8000,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-dep-ghost',
      invoiceId: 'inv-sales-orphan-party',
    })

    assert.strictEqual(res.ok, true, 'Reconciliation should succeed even if party is missing from parties list')
    const updated = readBooksData()
    const inv = updated.invoices.find((i) => i.id === 'inv-sales-orphan-party')
    assert.strictEqual(inv.status, 'Paid')
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 8000)
    assert.strictEqual(je.totalCredit, 8000)
  })

  // --------------------------------------------------------------------------
  // SUITE 2: 1-Click Reconciliation of Purchase Bills
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 2: Purchase Bill 1-Click Reconciliation Side-Effects ---')

  test('2.1: Purchase bill reconciliation marks transaction reconciled', () => {
    const data = createFreshBooksData()
    data.bankTransactions.push({
      id: 'tx-with-1',
      accountId: 'acc-bank',
      date: '2026-09-04',
      description: 'EFT Outflow BILL-2026-018 Safintra Steel',
      reference: 'BILL-2026-018',
      amount: -42000,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-with-1',
      invoiceId: 'bill-purch-steel',
    })

    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.settledAmount, 42000)
    assert.strictEqual(res.invoiceStatus, 'Paid')

    const updated = readBooksData()
    const tx = updated.bankTransactions.find((t) => t.id === 'tx-with-1')
    assert.strictEqual(tx.reconciled, true)
    assert.strictEqual(tx.matchedInvoiceId, 'bill-purch-steel')
    assert.ok(tx.reconciledAt)
  })

  test('2.2: Purchase bill reconciliation sets bill status to Paid, outstandingAmount to 0', () => {
    const updated = readBooksData()
    const bill = updated.invoices.find((i) => i.id === 'bill-purch-steel')
    assert.strictEqual(bill.status, 'Paid')
    assert.strictEqual(bill.outstandingAmount, 0)
  })

  test('2.3: Purchase bill reconciliation decrements supplier outstandingBalance', () => {
    const updated = readBooksData()
    const supp = updated.parties.find((p) => p.id === 'party-supp-1')
    assert.strictEqual(supp.outstandingBalance, 0, 'Supplier balance decremented from 42000 to 0')
  })

  test('2.4: Purchase bill reconciliation offsets Accounts Payable (acc-ap)', () => {
    const updated = readBooksData()
    const ap = updated.accounts.find((a) => a.id === 'acc-ap')
    // Initial 120000 - 42000 = 78000
    assert.strictEqual(ap.balance, 78000, 'acc-ap balance must be reduced by settled amount (120000 - 42000 = 78000)')
  })

  test('2.5: Purchase bill reconciliation posts balanced JournalEntry (Debit acc-ap, Credit acc-bank)', () => {
    const updated = readBooksData()
    const je = updated.journalEntries[0]

    assert.strictEqual(je.posted, true)
    assert.strictEqual(je.totalDebit, 42000)
    assert.strictEqual(je.totalCredit, 42000)
    assert.strictEqual(je.totalDebit, je.totalCredit, 'Double-entry balance: totalDebit === totalCredit')

    assert.strictEqual(je.items.length, 2)
    const debitItem = je.items.find((i) => i.accountId === 'acc-ap')
    const creditItem = je.items.find((i) => i.accountId === 'acc-bank')

    assert.ok(debitItem, 'Debit item on acc-ap must exist')
    assert.strictEqual(debitItem.debit, 42000, 'acc-ap must be debited by 42000')
    assert.strictEqual(debitItem.credit, 0, 'acc-ap credit must be 0')
    assert.strictEqual(debitItem.partyId, 'party-supp-1', 'Party ID should be linked on AP journal item')
    assert.strictEqual(debitItem.partyName, 'Safintra Steel Building Materials', 'Party name should be linked on AP journal item')

    assert.ok(creditItem, 'Credit item on acc-bank must exist')
    assert.strictEqual(creditItem.debit, 0, 'acc-bank debit must be 0')
    assert.strictEqual(creditItem.credit, 42000, 'acc-bank must be credited by 42000')
  })

  test('2.6: Purchase bill with fractional cents reconciliation preserves exact cent accuracy', () => {
    const data = readBooksData()
    data.bankTransactions.push({
      id: 'tx-with-fract',
      accountId: 'acc-bank',
      date: '2026-09-04',
      description: 'EFT Payment BILL-2026-019 Consolidated Electrical',
      amount: -18500.50,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-with-fract',
      invoiceId: 'bill-purch-elec-fractional',
    })

    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.settledAmount, 18500.50)

    const updated = readBooksData()
    const supp = updated.parties.find((p) => p.id === 'party-supp-2')
    assert.strictEqual(supp.outstandingBalance, 0)

    const ap = updated.accounts.find((a) => a.id === 'acc-ap')
    // 78000 - 18500.50 = 59499.50
    assert.strictEqual(ap.balance, 59499.50, 'acc-ap balance accurately decremented with cents')

    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 18500.50)
    assert.strictEqual(je.totalCredit, 18500.50)
    assert.strictEqual(je.totalDebit, je.totalCredit)
  })

  test('2.7: Purchase bill reconciliation when party outstandingBalance is smaller than bill amount clamps at 0', () => {
    const data = createFreshBooksData()
    // Set supplier balance smaller than bill
    const supp = data.parties.find((p) => p.id === 'party-supp-1')
    supp.outstandingBalance = 500
    data.bankTransactions.push({
      id: 'tx-with-clamp',
      accountId: 'acc-bank',
      date: '2026-09-04',
      description: 'Settlement test clamp',
      amount: -42000,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-with-clamp',
      invoiceId: 'bill-purch-steel',
    })
    assert.strictEqual(res.ok, true)
    const updated = readBooksData()
    const suppAfter = updated.parties.find((p) => p.id === 'party-supp-1')
    assert.strictEqual(suppAfter.outstandingBalance, 0, 'Balance clamped at 0 without negative number')
  })

  test('2.8: Purchase bill reconciliation when acc-ap is smaller than bill amount clamps at 0', () => {
    const data = createFreshBooksData()
    const ap = data.accounts.find((a) => a.id === 'acc-ap')
    ap.balance = 1000 // smaller than 42000
    data.bankTransactions.push({
      id: 'tx-with-clamp2',
      accountId: 'acc-bank',
      date: '2026-09-04',
      description: 'Settlement test clamp',
      amount: -42000,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-with-clamp2',
      invoiceId: 'bill-purch-steel',
    })
    assert.strictEqual(res.ok, true)
    const updated = readBooksData()
    const apAfter = updated.accounts.find((a) => a.id === 'acc-ap')
    assert.strictEqual(apAfter.balance, 0, 'acc-ap clamped at 0 without negative balance')
  })

  // --------------------------------------------------------------------------
  // SUITE 3: Error Guards and Adversarial Boundary Conditions
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 3: Error Guards & Adversarial Boundaries ---')

  test('3.1: Guard against reconciling non-existent transaction', () => {
    writeBooksData(createFreshBooksData())
    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-ghost-does-not-exist',
      invoiceId: 'inv-sales-tender',
    })
    assert.strictEqual(res.ok, false)
    assert.ok(res.error.includes('Transaction not found'))
  })

  test('3.2: Guard against reconciling non-existent invoice', () => {
    const data = createFreshBooksData()
    data.bankTransactions.push({
      id: 'tx-valid-1',
      accountId: 'acc-bank',
      date: '2026-09-02',
      description: 'Some deposit',
      amount: 145000,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-valid-1',
      invoiceId: 'inv-ghost-does-not-exist',
    })
    assert.strictEqual(res.ok, false)
    assert.ok(res.error.includes('Invoice not found'))
  })

  test('3.3: Guard against re-reconciling already reconciled transaction', () => {
    const data = createFreshBooksData()
    data.bankTransactions.push({
      id: 'tx-already-rec',
      accountId: 'acc-bank',
      date: '2026-09-02',
      description: 'Already reconciled',
      amount: 145000,
      reconciled: true,
      matchedInvoiceId: 'inv-sales-tender',
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-already-rec',
      invoiceId: 'inv-sales-crm-fractional',
    })
    assert.strictEqual(res.ok, false)
    assert.ok(res.error.includes('already reconciled'))
  })

  test('3.4: Guard against re-reconciling already Paid invoice', () => {
    const data = createFreshBooksData()
    data.invoices[0].status = 'Paid'
    data.invoices[0].outstandingAmount = 0
    data.bankTransactions.push({
      id: 'tx-unrec-1',
      accountId: 'acc-bank',
      date: '2026-09-02',
      description: 'Valid deposit',
      amount: 145000,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-unrec-1',
      invoiceId: data.invoices[0].id,
    })
    assert.strictEqual(res.ok, false)
    assert.ok(res.error.includes('already marked Paid'))
  })

  test('3.5: Guard when bankTransactions array is missing or empty', () => {
    const data = createFreshBooksData()
    delete data.bankTransactions
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-any',
      invoiceId: 'inv-sales-tender',
    })
    assert.strictEqual(res.ok, false)
    assert.ok(res.error.includes('Transaction not found'))
  })

  test('3.6: Guard when invoices array is missing or empty', () => {
    const data = createFreshBooksData()
    data.bankTransactions.push({
      id: 'tx-valid-test',
      accountId: 'acc-bank',
      date: '2026-09-02',
      description: 'Test',
      amount: 1000,
      reconciled: false,
    })
    delete data.invoices
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-valid-test',
      invoiceId: 'inv-any',
    })
    assert.strictEqual(res.ok, false)
    assert.ok(res.error.includes('Invoice not found'))
  })

  test('3.7: Reconciling invoice with status Unpaid but 0 outstandingAmount produces balanced zero-entry without crash', () => {
    const data = createFreshBooksData()
    const zeroInv = {
      id: 'inv-zero-amount',
      invoiceNumber: 'INV-ZERO-1',
      type: 'Sales',
      partyId: 'party-cust-1',
      partyName: 'City of Ekurhuleni Water Dept',
      date: '2026-09-01',
      dueDate: '2026-10-01',
      items: [],
      subtotal: 0,
      taxTotal: 0,
      grandTotal: 0,
      outstandingAmount: 0,
      status: 'Unpaid',
      createdAt: '2026-09-01T08:00:00Z',
      updatedAt: '2026-09-01T08:00:00Z',
    }
    data.invoices.push(zeroInv)
    data.bankTransactions.push({
      id: 'tx-zero',
      accountId: 'acc-bank',
      date: '2026-09-01',
      description: 'Zero test',
      amount: 0.01,
      reconciled: false,
    })
    writeBooksData(data)

    const res = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: 'tx-zero',
      invoiceId: 'inv-zero-amount',
    })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.settledAmount, 0)
    const updated = readBooksData()
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 0)
    assert.strictEqual(je.totalCredit, 0)
    assert.strictEqual(je.totalDebit, je.totalCredit)
  })

  // --------------------------------------------------------------------------
  // SUITE 4: 100% Double-Entry Ledger Invariant Verification
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 4: Strict Double-Entry Invariant Across Diverse Scenarios ---')

  test('4.1: Multi-transaction interleaved reconciliation preserves double-entry invariant 100%', () => {
    const data = createFreshBooksData()
    writeBooksData(data)

    // Import a multi-row statement CSV
    const csvContent = `Date,Description,Reference,Amount
2026-09-01,EFT Tender Milestone RFP-WTR-2026-04,RFP-WTR-2026-04,145000.00
2026-09-02,Helios Solar Services INV-2026-042,INV-2026-042,115000.75
2026-09-03,Safintra Steel Structural Materials,BILL-2026-018,-42000.00
2026-09-04,Consolidated Electrical High Voltage,BILL-2026-019,-18500.50`

    const importRes = books.importBankStatement({
      booksDataPath: booksPath,
      csvContent,
    })
    assert.strictEqual(importRes.ok, true)
    assert.strictEqual(importRes.importedCount, 4)

    // Get suggestions
    const currentData = readBooksData()
    const suggestions = books.computeSettlementSuggestions(currentData)
    assert.strictEqual(suggestions.length, 4, 'All 4 transactions should match open invoices')

    // Execute reconciliation for all 4
    for (const sug of suggestions) {
      const rec = books.executeReconciliation({
        booksDataPath: booksPath,
        transactionId: sug.transactionId,
        invoiceId: sug.invoiceId,
      })
      assert.strictEqual(rec.ok, true, `Reconciliation for ${sug.invoiceNumber} should succeed`)
    }

    // Verify final state
    const finalData = readBooksData()
    assert.strictEqual(finalData.journalEntries.length, 4, 'Should have 4 journal entries')

    for (const je of finalData.journalEntries) {
      assert.strictEqual(je.posted, true, 'Every entry must be posted')
      assert.strictEqual(je.totalDebit, je.totalCredit, `Double entry invariant broken on ${je.entryNumber}: debit ${je.totalDebit} != credit ${je.totalCredit}`)

      const itemsDebitSum = je.items.reduce((s, i) => s + i.debit, 0)
      const itemsCreditSum = je.items.reduce((s, i) => s + i.credit, 0)
      assert.strictEqual(Math.round(itemsDebitSum * 100) / 100, je.totalDebit, `Item debits mismatch totalDebit on ${je.entryNumber}`)
      assert.strictEqual(Math.round(itemsCreditSum * 100) / 100, je.totalCredit, `Item credits mismatch totalCredit on ${je.entryNumber}`)
    }

    // Check all invoices are Paid
    const relevantInvoices = finalData.invoices.filter((i) =>
      ['inv-sales-tender', 'inv-sales-crm-fractional', 'bill-purch-steel', 'bill-purch-elec-fractional'].includes(i.id),
    )
    for (const inv of relevantInvoices) {
      assert.strictEqual(inv.status, 'Paid', `Invoice ${inv.id} must be Paid`)
      assert.strictEqual(inv.outstandingAmount, 0, `Invoice ${inv.id} outstandingAmount must be 0`)
    }

    // Check all transactions are reconciled
    assert.strictEqual(finalData.bankTransactions.every((t) => t.reconciled), true, 'All transactions must be reconciled')

    // Check bank ledger balance: initial 500000 + 145000 + 115000.75 - 42000 - 18500.50 = 699500.25
    const bankAccount = finalData.accounts.find((a) => a.id === 'acc-bank')
    assert.strictEqual(bankAccount.balance, 699500.25, 'Bank account balance matches net transactions')
  })

  test('4.2: Fuzzing / Stress test: 50 randomized reconciliations strictly preserve double-entry balance', () => {
    const data = createFreshBooksData()
    data.journalEntries = []
    data.invoices = []
    data.bankTransactions = []

    const count = 50
    for (let i = 0; i < count; i++) {
      const isSales = i % 2 === 0
      const rawAmount = (Math.random() * 100000 + 1).toFixed(2)
      const amount = parseFloat(rawAmount)

      const invId = `fuzz-inv-${i}`
      const txId = `fuzz-tx-${i}`

      data.invoices.push({
        id: invId,
        invoiceNumber: `INV-FUZZ-${i}`,
        type: isSales ? 'Sales' : 'Purchase',
        partyId: isSales ? 'party-cust-1' : 'party-supp-1',
        partyName: isSales ? 'City of Ekurhuleni Water Dept' : 'Safintra Steel Building Materials',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [],
        subtotal: amount,
        taxTotal: 0,
        grandTotal: amount,
        outstandingAmount: amount,
        status: 'Unpaid',
        createdAt: '2026-09-01T08:00:00Z',
        updatedAt: '2026-09-01T08:00:00Z',
      })

      data.bankTransactions.push({
        id: txId,
        accountId: 'acc-bank',
        date: '2026-09-01',
        description: `Fuzz tx ${i}`,
        amount: isSales ? amount : -amount,
        reconciled: false,
      })
    }

    writeBooksData(data)

    for (let i = 0; i < count; i++) {
      const res = books.executeReconciliation({
        booksDataPath: booksPath,
        transactionId: `fuzz-tx-${i}`,
        invoiceId: `fuzz-inv-${i}`,
      })
      assert.strictEqual(res.ok, true)
    }

    const fuzzData = readBooksData()
    assert.strictEqual(fuzzData.journalEntries.length, count)

    for (const je of fuzzData.journalEntries) {
      assert.strictEqual(je.totalDebit, je.totalCredit, `Fuzz entry ${je.entryNumber} imbalanced!`)
      const dSum = je.items.reduce((s, it) => s + it.debit, 0)
      const cSum = je.items.reduce((s, it) => s + it.credit, 0)
      assert.strictEqual(Math.round(dSum * 100) / 100, je.totalDebit)
      assert.strictEqual(Math.round(cSum * 100) / 100, je.totalCredit)
    }
  })

  // --------------------------------------------------------------------------
  // SUITE 5: Re-importing Bank Statement after Reconciliation
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 5: Statement Re-import Deduplication & State Integrity ---')

  test('5.1: Re-importing identical statement preserves already reconciled state and prevents double balance adjust', () => {
    const data = createFreshBooksData()
    writeBooksData(data)

    const csv = `Date,Description,Reference,Amount
2026-09-01,EFT Tender Milestone RFP-WTR-2026-04,RFP-WTR-2026-04,145000.00`

    // Initial import
    const imp1 = books.importBankStatement({ booksDataPath: booksPath, csvContent: csv })
    assert.strictEqual(imp1.ok, true)
    assert.strictEqual(imp1.importedCount, 1)
    assert.strictEqual(imp1.newBankBalance, 500000 + 145000)

    // Reconcile the transaction
    const txId = imp1.transactions[0].id
    const rec = books.executeReconciliation({
      booksDataPath: booksPath,
      transactionId: txId,
      invoiceId: 'inv-sales-tender',
    })
    assert.strictEqual(rec.ok, true)

    // Re-import the exact same CSV
    const imp2 = books.importBankStatement({ booksDataPath: booksPath, csvContent: csv })
    assert.strictEqual(imp2.ok, true)
    assert.strictEqual(imp2.importedCount, 0, 'Should skip duplicate transaction')
    assert.strictEqual(imp2.skippedDuplicates, 1, 'Should report 1 skipped duplicate')
    assert.strictEqual(imp2.netAdjustment, 0, 'Net adjustment must be 0')
    assert.strictEqual(imp2.newBankBalance, 645000, 'Bank balance must remain exactly 645000')

    // Verify transaction remains reconciled and linked
    const verifiedData = readBooksData()
    const tx = verifiedData.bankTransactions.find((t) => t.id === txId)
    assert.strictEqual(tx.reconciled, true, 'Transaction must remain reconciled')
    assert.strictEqual(tx.matchedInvoiceId, 'inv-sales-tender', 'Matched invoice ID must be preserved')
  })

  // --------------------------------------------------------------------------
  // SUITE 6: IPC Bridge Handlers Verification
  // --------------------------------------------------------------------------
  console.log('\n--- Suite 6: Books IPC Handlers Verification ---')

  await testAsync('6.1: IPC handler books:reconcile-transaction executes correctly', async () => {
    const data = createFreshBooksData()
    data.bankTransactions.push({
      id: 'tx-ipc-1',
      accountId: 'acc-bank',
      date: '2026-09-02',
      description: 'EFT Deposit RFP-WTR-2026-04 City of Ekurhuleni',
      amount: 145000,
      reconciled: false,
    })
    writeBooksData(data)

    const handler = ipcHandlers.get('books:reconcile-transaction')
    assert.ok(handler, 'books:reconcile-transaction handler must be registered')

    const res = await handler({}, 'tx-ipc-1', 'inv-sales-tender')
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.settledAmount, 145000)

    const updated = readBooksData()
    const tx = updated.bankTransactions.find((t) => t.id === 'tx-ipc-1')
    assert.strictEqual(tx.reconciled, true)
    const inv = updated.invoices.find((i) => i.id === 'inv-sales-tender')
    assert.strictEqual(inv.status, 'Paid')
  })

  await testAsync('6.2: IPC handler books:reconcile-transaction returns structured error on invalid call', async () => {
    const handler = ipcHandlers.get('books:reconcile-transaction')
    const res = await handler({}, 'tx-nonexistent', 'inv-nonexistent')
    assert.strictEqual(res.ok, false)
    assert.ok(res.error)
  })

  await testAsync('6.3: IPC handler books:get-settlement-suggestions excludes reconciled items', async () => {
    const data = readBooksData()
    const suggestionsHandler = ipcHandlers.get('books:get-settlement-suggestions')
    assert.ok(suggestionsHandler)

    const sugs = await suggestionsHandler({})
    // In current data, tx-ipc-1 is reconciled and inv-sales-tender is Paid
    const foundReconciled = sugs.find((s) => s.transactionId === 'tx-ipc-1' || s.invoiceId === 'inv-sales-tender')
    assert.strictEqual(foundReconciled, undefined, 'Reconciled transaction or Paid invoice must never be suggested')
  })

  // Cleanup sandbox
  try {
    rmSync(sandboxDir, { recursive: true, force: true })
  } catch {}

  console.log('\n================================================================================')
  console.log(`Results: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  console.log('================================================================================\n')

  if (failedTests > 0) {
    console.error(`❌ CHALLENGER 2 SUITE FAILED with ${failedTests} failure(s):`)
    for (const f of failureDetails) {
      console.error(`  - ${f.name}: ${f.error.message}`)
    }
    process.exit(1)
  } else {
    console.log('🎉 ALL CHALLENGER 2 EMPIRICAL TESTS PASSED!')
  }
}

runChallenger2M4AccountingSuite().catch((err) => {
  console.error('Unhandled test runner exception:', err)
  process.exit(1)
})

#!/usr/bin/env node
/**
 * tools/test-challenger-2-m3-accounting.mjs
 *
 * Challenger 2 Verification Suite for Milestone 3:
 * Empirical Verification of Books Store Accounting Side-Effects and Cross-Store Data Integrity
 * resulting from Tenders Contract Milestone Billing.
 *
 * Verification Objectives:
 * 1. Tax invoice creation in `books-data.json`:
 *    - type === 'Sales'
 *    - status === 'Unpaid'
 *    - tenderReference field (e.g. 'RFP-WTR-2026-04')
 *    - line-item description format (`${milestoneTitle} per ${tenderReference}`)
 *    - line-item itemCode ('TENDER-PROGRESS'), accountId ('acc-sales'), rate/amount, taxRate (15)
 *    - payment terms ('Payment terms: 30 days net from tax invoice submission.')
 *    - dueDate calculation
 * 2. Double-entry Chart of Accounts adjustments:
 *    - acc-ar debited by grandTotal
 *    - acc-sales credited by subtotal
 *    - acc-vat credited by taxTotal
 *    - untouched accounts unchanged
 *    - cumulative balance integrity across multiple billings
 * 3. Balanced JournalEntry posting:
 *    - totalDebit === totalCredit === grandTotal
 *    - exactly 3 balancing line items (acc-ar, acc-sales, acc-vat)
 *    - remarks, entryNumber, posted flag
 * 4. Boundary valuations & stress testing:
 *    - Zero amount (rejected)
 *    - Negative amount (rejected)
 *    - Fractional cents (e.g. R 145,000.55, R 0.01, R 1.15, R 333,333.33)
 *    - Extreme amounts (R 50,000,000.00, R 99,999,999.99)
 *    - Preservation of subtotal + taxTotal === grandTotal without rounding discrepancy
 * 5. Issuing authority party auto-creation and customer balance update:
 *    - Auto-creation of party when not in Books
 *    - Case-insensitive reuse of existing party
 *    - Customer outstanding balance increments
 *    - Multi-party isolation
 * 6. Cross-store consistency & state machine:
 *    - tenders-data.json milestone status updated to 'BILLED'
 *    - billedInvoiceId and billedInvoiceNumber match generated Books invoice
 *    - billedAt and billedDate populated
 *    - Idempotency guard (re-billing already BILLED milestone rejected)
 *    - Eligibility guard (billing PENDING milestone rejected)
 *    - Non-existent tender/milestone rejection
 *    - Shell tab activation callback trigger
 *    - Data persistence and atomic write resilience
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import assert from 'node:assert'

const require = createRequire(import.meta.url)

// Mock Electron IPC & App
const ipcHandlers = new Map()
let currentMockUserDataDir = ''

require.cache[require.resolve('electron')] = {
  exports: {
    app: {
      getPath: (name) => {
        if (name === 'userData') return currentMockUserDataDir
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

// Load compiled Books & Tenders modules
const booksModule = require('../apps/books/out/main/index.js')
const { CURRENT_BOOKS_SCHEMA_VERSION, CORE_ACCOUNTS, DEFAULT_BOOK_SETTINGS } = booksModule

const tendersModule = require('../apps/tenders/out/main/index.js')
const { CURRENT_TENDERS_SCHEMA_VERSION, SEED_TENDER_WTR_04, readTendersStore, writeTendersStore } = tendersModule

// Track shell tab activation callbacks
let onOpenBooksCallCount = 0
let lastOpenedInvoiceId = null

tendersModule.configureTendersRuntime({
  onOpenBooks: (invId) => {
    onOpenBooksCallCount++
    lastOpenedInvoiceId = invId
  },
})
tendersModule.registerTendersIpc()

function getBillMilestoneHandler() {
  const handler = ipcHandlers.get('tenders:bill-milestone-in-books')
  if (!handler) {
    throw new Error('IPC handler for tenders:bill-milestone-in-books is not registered')
  }
  return handler
}

function getOpenBooksHandler() {
  const handler = ipcHandlers.get('tenders:open-books')
  if (!handler) {
    throw new Error('IPC handler for tenders:open-books is not registered')
  }
  return handler
}

function createCleanSandbox(prefix = 'm3-ch2-books-') {
  const root = join(tmpdir(), `${prefix}${randomUUID().slice(0, 8)}`)
  const tendersDir = join(root, 'tenders')
  const booksDir = join(root, 'books')
  mkdirSync(tendersDir, { recursive: true })
  mkdirSync(booksDir, { recursive: true })

  // Initialize standard Books store
  const booksData = {
    version: CURRENT_BOOKS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_BOOK_SETTINGS },
    accounts: CORE_ACCOUNTS.map((a) => ({ ...a })),
    parties: [
      {
        id: 'party-pre-ekurhuleni',
        name: 'City of Ekurhuleni Water Dept',
        type: 'Customer',
        email: 'procurement@ekurhuleni.gov.za',
        outstandingBalance: 50000,
      },
      {
        id: 'party-pre-eskom',
        name: 'Eskom Holdings SOC Ltd',
        type: 'Customer',
        email: 'tenders@eskom.co.za',
        outstandingBalance: 120000,
      },
    ],
    invoices: [],
    journalEntries: [],
  }
  writeFileSync(join(booksDir, 'books-data.json'), JSON.stringify(booksData, null, 2), 'utf8')

  // Initialize standard Tenders store with seed tender
  const tendersData = {
    version: CURRENT_TENDERS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    activeCompanyId: 'comp-zano-01',
    workspaces: [
      {
        id: 'ws-ekurhuleni-01',
        name: 'Ekurhuleni Water Infrastructure',
        company: {
          name: 'Zano Consulting (Pty) Ltd',
          tradingName: 'Zano Consulting',
          registrationNumber: '2018/123456/07',
          vatNumber: '4920284719',
          taxPin: '9876543210',
          bbbeeLevel: 'Level 1',
          bbbeeBlackOwnership: '100%',
          csdSupplierNumber: 'MAAA0012345',
          founded: '2018',
          employees: '45',
          industry: 'Engineering & Construction',
          description: 'Civil and mechanical engineering contracting services',
          address: '24 Sovereign Square, Sandton, 2196',
          phone: '+27 11 982 4000',
          email: 'info@zanostack.dev',
          website: 'https://zanostack.dev',
          directors: [],
          projects: [],
        },
        customers: [],
        vault: [],
        tenders: [
          JSON.parse(JSON.stringify(SEED_TENDER_WTR_04)),
        ],
      },
    ],
    issuerTemplates: [],
  }
  writeFileSync(join(tendersDir, 'tenders-data.json'), JSON.stringify(tendersData, null, 2), 'utf8')

  return {
    root,
    tendersDir,
    booksDir,
    tendersPath: join(tendersDir, 'tenders-data.json'),
    booksPath: join(booksDir, 'books-data.json'),
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {}
    },
  }
}

// Test harness execution tracking
let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures = []

async function runTest(suiteName, name, testFn) {
  totalTests++
  process.stdout.write(`  [${totalTests.toString().padStart(2, '0')}] ${name} ... `)
  try {
    await testFn()
    passedTests++
    console.log('✅ PASS')
  } catch (err) {
    failedTests++
    console.log('❌ FAIL')
    console.error(`       Error: ${err.message}`)
    failures.push({ suite: suiteName, name, error: err.message, stack: err.stack })
  }
}

console.log('======================================================================')
console.log('   EMPIRICAL CHALLENGER 2: MILESTONE 3 ACCOUNTING & INTEGRITY SUITE')
console.log('   Books Store Accounting Side-Effects & Cross-Store Data Integrity')
console.log('======================================================================\n')

async function runMilestone3Verification() {
  const billHandler = getBillMilestoneHandler()
  const openHandler = getOpenBooksHandler()

  // =========================================================================
  // SUITE 1: Tax Invoice Creation & Invariants in books-data.json
  // =========================================================================
  console.log('--- SUITE 1: Tax Invoice Creation & Invariants in books-data.json ---')

  await runTest('InvoiceSpec', 'Invoice created with type=Sales, status=Unpaid, and tenderReference', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true, 'Billing call must succeed')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 1, 'Exactly 1 invoice created in Books')

      const inv = books.invoices[0]
      assert.strictEqual(inv.id, res.invoiceId, 'Invoice id matches result')
      assert.strictEqual(inv.invoiceNumber, res.invoiceNumber, 'Invoice number matches result')
      assert.strictEqual(inv.type, 'Sales', 'Invoice type must be Sales')
      assert.strictEqual(inv.status, 'Unpaid', 'Invoice status must be Unpaid')
      assert.strictEqual(inv.tenderReference, 'RFP-WTR-2026-04', 'tenderReference matches tender')
      assert.strictEqual(inv.grandTotal, 145000, 'grandTotal equals milestone amount R 145,000')
      assert.strictEqual(inv.outstandingAmount, 145000, 'outstandingAmount equals grandTotal')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('InvoiceSpec', 'Line-item description format strictly matches "${milestoneTitle} per ${tenderReference}"', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices[0]
      assert(Array.isArray(inv.items) && inv.items.length === 1, 'Must contain exactly 1 line item')

      const item = inv.items[0]
      const expectedDescription = 'Phase 1 Reservoir Valve Refurbishment per RFP-WTR-2026-04'
      assert.strictEqual(item.description, expectedDescription, 'Line item description matches contract format')
      assert.strictEqual(item.itemCode, 'TENDER-PROGRESS', 'Line item itemCode is TENDER-PROGRESS')
      assert.strictEqual(item.accountId, 'acc-sales', 'Line item accountId is acc-sales')
      assert.strictEqual(item.accountName, 'Tender & Commercial Contracting Sales', 'Line item accountName matches')
      assert.strictEqual(item.qty, 1, 'Quantity is 1')
      assert.strictEqual(item.taxRate, 15, 'VAT rate is 15%')
      assert.strictEqual(item.rate, inv.subtotal, 'Item rate equals invoice subtotal')
      assert.strictEqual(item.amount, inv.subtotal, 'Item amount equals invoice subtotal')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('InvoiceSpec', 'Payment terms default to 30 days net and custom notes are preserved', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      // Test default notes
      const resDefault = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(resDefault.ok, true)

      let books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(
        books.invoices[0].notes,
        'Payment terms: 30 days net from tax invoice submission.',
        'Default payment terms note must be 30 days net from tax invoice submission.',
      )

      // Test custom notes via object payload
      // Reset milestone status to REACHED in tenders store for custom notes test
      const tData = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      tData.workspaces[0].tenders[0].milestones[0].status = 'REACHED'
      delete tData.workspaces[0].tenders[0].milestones[0].billedInvoiceId
      writeFileSync(sandbox.tendersPath, JSON.stringify(tData, null, 2), 'utf8')

      const resCustom = await billHandler(null, {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        tenderReference: 'RFP-WTR-2026-04',
        issuingAuthority: 'City of Ekurhuleni Water Dept',
        milestoneTitle: 'Phase 1 Reservoir Valve Refurbishment',
        amount: 145000,
        notes: 'Special milestone payment terms: Payment due within 14 days of engineer sign-off.',
      })
      assert.strictEqual(resCustom.ok, true)

      books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(
        books.invoices[0].notes,
        'Special milestone payment terms: Payment due within 14 days of engineer sign-off.',
        'Custom payment terms notes are preserved on the invoice',
      )
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('InvoiceSpec', 'Due date calculation uses milestone dueDate when available or defaults to +30 days', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      // SEED_TENDER_WTR_04 ms-01 has dueDate: '2026-08-30'
      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices[0]
      assert.strictEqual(inv.dueDate, '2026-08-30', 'dueDate matches milestone.dueDate')
      const today = new Date().toISOString().split('T')[0]
      assert.strictEqual(inv.date, today, 'invoice.date is today')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('InvoiceSpec', 'Sequential invoice numbering increments properly (INV-YYYY-XXX)', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res1 = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res1.ok, true)
      assert.strictEqual(res1.invoiceNumber, `INV-${new Date().getFullYear()}-001`)

      // Add a second REACHED milestone to tender
      const tData = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      tData.workspaces[0].tenders[0].milestones.push({
        id: 'ms-03',
        name: 'Phase 3 Commissioning & Testing',
        title: 'Phase 3 Commissioning & Testing',
        amount: 80000,
        status: 'REACHED',
      })
      writeFileSync(sandbox.tendersPath, JSON.stringify(tData, null, 2), 'utf8')

      const res2 = await billHandler(null, 'tender-wtr-04', 'ms-03')
      assert.strictEqual(res2.ok, true)
      assert.strictEqual(res2.invoiceNumber, `INV-${new Date().getFullYear()}-002`, 'Second invoice gets 002')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 2, 'Books has 2 invoices')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 2: Double-Entry Chart of Accounts Adjustments
  // =========================================================================
  console.log('\n--- SUITE 2: Double-Entry Chart of Accounts Adjustments ---')

  await runTest('DoubleEntry', 'acc-ar debited by grandTotal, acc-sales credited by subtotal, acc-vat credited by taxTotal', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const initialBooks = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const prevAr = initialBooks.accounts.find((a) => a.id === 'acc-ar').balance
      const prevSales = initialBooks.accounts.find((a) => a.id === 'acc-sales').balance
      const prevVat = initialBooks.accounts.find((a) => a.id === 'acc-vat').balance

      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const newAr = books.accounts.find((a) => a.id === 'acc-ar').balance
      const newSales = books.accounts.find((a) => a.id === 'acc-sales').balance
      const newVat = books.accounts.find((a) => a.id === 'acc-vat').balance

      assert.strictEqual(newAr, Math.round((prevAr + res.grandTotal) * 100) / 100, 'acc-ar debited by grandTotal')
      assert.strictEqual(newSales, Math.round((prevSales + res.subtotal) * 100) / 100, 'acc-sales credited by subtotal')
      assert.strictEqual(newVat, Math.round((prevVat + res.taxTotal) * 100) / 100, 'acc-vat credited by taxTotal')

      // Check South African 15% VAT split for R 145,000.00
      assert.strictEqual(res.grandTotal, 145000)
      assert.strictEqual(res.subtotal, 126086.96)
      assert.strictEqual(res.taxTotal, 18913.04)
      assert.strictEqual(Math.round((res.subtotal + res.taxTotal) * 100) / 100, res.grandTotal, 'subtotal + taxTotal === grandTotal')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('DoubleEntry', 'Untouched accounts (acc-bank, acc-ap) remain strictly unmodified', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const initialBooks = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const prevBank = initialBooks.accounts.find((a) => a.id === 'acc-bank').balance
      const prevAp = initialBooks.accounts.find((a) => a.id === 'acc-ap').balance

      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const newBank = books.accounts.find((a) => a.id === 'acc-bank').balance
      const newAp = books.accounts.find((a) => a.id === 'acc-ap').balance

      assert.strictEqual(newBank, prevBank, 'acc-bank balance must remain unmodified')
      assert.strictEqual(newAp, prevAp, 'acc-ap balance must remain unmodified')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('DoubleEntry', 'Double-entry balance equation holds across cumulative sequential billings', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root

      // Bill first milestone (R 145,000)
      const res1 = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res1.ok, true)

      // Add and bill second milestone (R 98,000)
      const tData = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      tData.workspaces[0].tenders[0].milestones.push({
        id: 'ms-extra',
        name: 'Phase 2 Piping',
        amount: 98000,
        status: 'REACHED',
      })
      writeFileSync(sandbox.tendersPath, JSON.stringify(tData, null, 2), 'utf8')

      const res2 = await billHandler(null, 'tender-wtr-04', 'ms-extra')
      assert.strictEqual(res2.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const initialBooks = createCleanSandbox()
      const initB = JSON.parse(readFileSync(initialBooks.booksPath, 'utf8'))
      initialBooks.cleanup()

      const deltaAr = books.accounts.find((a) => a.id === 'acc-ar').balance - initB.accounts.find((a) => a.id === 'acc-ar').balance
      const deltaSales = books.accounts.find((a) => a.id === 'acc-sales').balance - initB.accounts.find((a) => a.id === 'acc-sales').balance
      const deltaVat = books.accounts.find((a) => a.id === 'acc-vat').balance - initB.accounts.find((a) => a.id === 'acc-vat').balance

      const totalBilled = 145000 + 98000 // 243,000
      assert.strictEqual(Math.round(deltaAr * 100) / 100, totalBilled, 'Total AR increase equals total billed')
      assert.strictEqual(
        Math.round(deltaAr * 100) / 100,
        Math.round((deltaSales + deltaVat) * 100) / 100,
        'Double-entry balance holds: delta(AR) === delta(Sales) + delta(VAT)',
      )
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 3: Balanced JournalEntry Posting
  // =========================================================================
  console.log('\n--- SUITE 3: Balanced JournalEntry Posting ---')

  await runTest('JournalEntry', 'totalDebit === totalCredit === grandTotal and posted === true', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.journalEntries.length, 1, 'Exactly 1 JournalEntry posted')

      const je = books.journalEntries[0]
      assert.strictEqual(je.posted, true, 'JournalEntry must be posted')
      assert.strictEqual(je.totalDebit, 145000, 'totalDebit equals grandTotal')
      assert.strictEqual(je.totalCredit, 145000, 'totalCredit equals grandTotal')
      assert.strictEqual(je.totalDebit, je.totalCredit, 'totalDebit strictly equals totalCredit')
      assert(je.remarks.includes(res.invoiceNumber), 'Remarks contains invoiceNumber')
      assert(je.remarks.includes('RFP-WTR-2026-04'), 'Remarks contains tender reference')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('JournalEntry', 'Exactly 3 balancing items with matching debit/credit allocations', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const je = books.journalEntries[0]
      assert(Array.isArray(je.items) && je.items.length === 3, 'Must have exactly 3 journal items')

      const [itemAr, itemSales, itemVat] = je.items

      // Item 1: acc-ar debit
      assert.strictEqual(itemAr.accountId, 'acc-ar', 'Item 1 is acc-ar')
      assert.strictEqual(itemAr.debit, 145000, 'Item 1 debit equals grandTotal')
      assert.strictEqual(itemAr.credit, 0, 'Item 1 credit is 0')
      assert.strictEqual(itemAr.partyName, 'City of Ekurhuleni Water Dept', 'Item 1 partyName matches issuer')

      // Item 2: acc-sales credit
      assert.strictEqual(itemSales.accountId, 'acc-sales', 'Item 2 is acc-sales')
      assert.strictEqual(itemSales.debit, 0, 'Item 2 debit is 0')
      assert.strictEqual(itemSales.credit, 126086.96, 'Item 2 credit equals subtotal')

      // Item 3: acc-vat credit
      assert.strictEqual(itemVat.accountId, 'acc-vat', 'Item 3 is acc-vat')
      assert.strictEqual(itemVat.debit, 0, 'Item 3 debit is 0')
      assert.strictEqual(itemVat.credit, 18913.04, 'Item 3 credit equals taxTotal')

      // Item-level sums
      const sumDebits = je.items.reduce((s, i) => s + (i.debit || 0), 0)
      const sumCredits = je.items.reduce((s, i) => s + (i.credit || 0), 0)
      assert.strictEqual(Math.round(sumDebits * 100) / 100, 145000, 'Sum of debits === grandTotal')
      assert.strictEqual(Math.round(sumCredits * 100) / 100, 145000, 'Sum of credits === grandTotal')
      assert.strictEqual(Math.round(sumDebits * 100) / 100, Math.round(sumCredits * 100) / 100, 'Item debits === Item credits')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 4: Boundary Valuations & Stress Testing
  // =========================================================================
  console.log('\n--- SUITE 4: Boundary Valuations & Stress Testing ---')

  await runTest('BoundaryValuation', 'Zero amount (R 0.00) is rejected and stores are not modified', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const tData = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      tData.workspaces[0].tenders[0].milestones[0].amount = 0
      writeFileSync(sandbox.tendersPath, JSON.stringify(tData, null, 2), 'utf8')

      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, false, 'Zero amount billing must fail')
      assert(res.error.toLowerCase().includes('greater than 0'), 'Error message specifies greater than 0')

      // Verify Books store remained unmodified
      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 0, 'No invoice created')
      assert.strictEqual(books.journalEntries.length, 0, 'No journal entry created')

      // Verify Tenders milestone status is still REACHED
      const tendersAfter = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      assert.strictEqual(tendersAfter.workspaces[0].tenders[0].milestones[0].status, 'REACHED')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('BoundaryValuation', 'Negative amount is rejected and stores are not modified', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const tData = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      tData.workspaces[0].tenders[0].milestones[0].amount = -50000
      writeFileSync(sandbox.tendersPath, JSON.stringify(tData, null, 2), 'utf8')

      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, false, 'Negative amount billing must fail')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 0, 'No invoice created')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('BoundaryValuation', 'Fractional cents valuation: R 145,000.55 computes exact zero penny discrepancy', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        tenderReference: 'RFP-WTR-2026-04',
        issuingAuthority: 'City of Ekurhuleni Water Dept',
        milestoneTitle: 'Phase 1 Reservoir Valve Refurbishment',
        amount: 145000.55,
      })
      assert.strictEqual(res.ok, true)

      assert.strictEqual(res.grandTotal, 145000.55)
      // subtotal = Math.round((145000.55 / 1.15) * 100) / 100 = 126087.43
      assert.strictEqual(res.subtotal, 126087.43)
      // taxTotal = Math.round((145000.55 - 126087.43) * 100) / 100 = 18913.12
      assert.strictEqual(res.taxTotal, 18913.12)
      assert.strictEqual(Math.round((res.subtotal + res.taxTotal) * 100) / 100, 145000.55, 'subtotal + taxTotal === 145000.55')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const je = books.journalEntries[0]
      assert.strictEqual(je.totalDebit, 145000.55)
      assert.strictEqual(je.totalCredit, 145000.55)
      assert.strictEqual(je.items[0].debit, 145000.55)
      assert.strictEqual(je.items[1].credit, 126087.43)
      assert.strictEqual(je.items[2].credit, 18913.12)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('BoundaryValuation', 'Smallest cent boundary: R 0.01 maintains balanced double-entry', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        amount: 0.01,
      })
      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.grandTotal, 0.01)
      assert.strictEqual(res.subtotal, 0.01)
      assert.strictEqual(res.taxTotal, 0.00)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const je = books.journalEntries[0]
      assert.strictEqual(je.totalDebit, 0.01)
      assert.strictEqual(je.totalCredit, 0.01)
      assert.strictEqual(Math.round((je.items[1].credit + je.items[2].credit) * 100) / 100, 0.01)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('BoundaryValuation', 'Exact 15% boundary: R 1.15 produces clean subtotal R 1.00 and VAT R 0.15', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        amount: 1.15,
      })
      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.grandTotal, 1.15)
      assert.strictEqual(res.subtotal, 1.00)
      assert.strictEqual(res.taxTotal, 0.15)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const je = books.journalEntries[0]
      assert.strictEqual(je.totalDebit, 1.15)
      assert.strictEqual(je.totalCredit, 1.15)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('BoundaryValuation', 'Repeating fractions: R 333,333.33 maintains subtotal + taxTotal === grandTotal', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        amount: 333333.33,
      })
      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.grandTotal, 333333.33)
      assert.strictEqual(res.subtotal, 289855.07)
      assert.strictEqual(res.taxTotal, 43478.26)
      assert.strictEqual(Math.round((res.subtotal + res.taxTotal) * 100) / 100, 333333.33)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const je = books.journalEntries[0]
      assert.strictEqual(je.totalDebit, 333333.33)
      assert.strictEqual(je.totalCredit, 333333.33)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('BoundaryValuation', 'Extreme valuation: R 50,000,000.00 (50M ZAR) posted with double-entry integrity', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        amount: 50000000,
      })
      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.grandTotal, 50000000)
      assert.strictEqual(res.subtotal, 43478260.87)
      assert.strictEqual(res.taxTotal, 6521739.13)
      assert.strictEqual(Math.round((res.subtotal + res.taxTotal) * 100) / 100, 50000000)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const je = books.journalEntries[0]
      assert.strictEqual(je.totalDebit, 50000000)
      assert.strictEqual(je.totalCredit, 50000000)

      const arAcc = books.accounts.find((a) => a.id === 'acc-ar')
      assert.strictEqual(arAcc.balance, 195500 + 50000000)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('BoundaryValuation', 'Extreme valuation with cents: R 99,999,999.99 maintains financial integrity', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        amount: 99999999.99,
      })
      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.grandTotal, 99999999.99)
      assert.strictEqual(res.subtotal, 86956521.73)
      assert.strictEqual(res.taxTotal, 13043478.26)
      assert.strictEqual(Math.round((res.subtotal + res.taxTotal) * 100) / 100, 99999999.99)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const je = books.journalEntries[0]
      assert.strictEqual(je.totalDebit, 99999999.99)
      assert.strictEqual(je.totalCredit, 99999999.99)
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 5: Issuing Authority Party Auto-Creation & Balances
  // =========================================================================
  console.log('\n--- SUITE 5: Issuing Authority Party Auto-Creation & Balances ---')

  await runTest('PartyManagement', 'Auto-creates customer party with email and balance when issuer is not in Books', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        tenderReference: 'RFP-TRANSNET-2026-09',
        issuingAuthority: 'Transnet Freight Rail Logistics',
        milestoneTitle: 'Rail Siding Signaling Refurbishment',
        amount: 320000,
      })
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const party = books.parties.find((p) => p.name === 'Transnet Freight Rail Logistics')
      assert(party, 'New party must be created in Books')
      assert.strictEqual(party.type, 'Customer', 'Party type is Customer')
      assert(party.email.includes('transnetfreightraillogistics'), 'Email is generated from issuer name')
      assert.strictEqual(party.outstandingBalance, 320000, 'Outstanding balance equals grandTotal')

      const inv = books.invoices[0]
      assert.strictEqual(inv.partyId, party.id, 'Invoice references new party id')
      assert.strictEqual(inv.partyName, party.name, 'Invoice references new party name')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('PartyManagement', 'Reuses existing party case-insensitively and increments customer balance', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      // Sandbox has pre-existing party: 'City of Ekurhuleni Water Dept' with balance 50000
      const res = await billHandler(null, {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        tenderReference: 'RFP-WTR-2026-04',
        issuingAuthority: 'city of ekurhuleni water dept', // Lowercase test
        milestoneTitle: 'Phase 1 Reservoir Valve Refurbishment',
        amount: 145000,
      })
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const matchingParties = books.parties.filter((p) => p.name.toLowerCase() === 'city of ekurhuleni water dept')
      assert.strictEqual(matchingParties.length, 1, 'No duplicate party created')

      const party = matchingParties[0]
      assert.strictEqual(party.id, 'party-pre-ekurhuleni', 'Existing party id preserved')
      assert.strictEqual(party.outstandingBalance, 50000 + 145000, 'Balance incremented: 50,000 + 145,000 = 195,000')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('PartyManagement', 'Cumulative milestone billing increments party balance accurately across multiple invoices', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root

      // Bill milestone 1 (145,000)
      const res1 = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res1.ok, true)

      // Add and bill milestone 2 (95,000) for same tender
      const tData = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      tData.workspaces[0].tenders[0].milestones.push({
        id: 'ms-04',
        name: 'Phase 4 Valve Balancing',
        amount: 95000,
        status: 'REACHED',
      })
      writeFileSync(sandbox.tendersPath, JSON.stringify(tData, null, 2), 'utf8')

      const res2 = await billHandler(null, 'tender-wtr-04', 'ms-04')
      assert.strictEqual(res2.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const party = books.parties.find((p) => p.id === 'party-pre-ekurhuleni')
      // Initial: 50,000 + 145,000 + 95,000 = 290,000
      assert.strictEqual(party.outstandingBalance, 290000, 'Outstanding balance is 290,000')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('PartyManagement', 'Multi-party balance isolation: billing Authority A does not affect Authority B', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const initialBooks = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const eskomInitial = initialBooks.parties.find((p) => p.id === 'party-pre-eskom').outstandingBalance

      // Bill Ekurhuleni milestone
      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const eskomAfter = books.parties.find((p) => p.id === 'party-pre-eskom').outstandingBalance
      assert.strictEqual(eskomAfter, eskomInitial, 'Eskom balance strictly unchanged when billing Ekurhuleni')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 6: Cross-Store Consistency, State Machine & Idempotency
  // =========================================================================
  console.log('\n--- SUITE 6: Cross-Store Consistency, State Machine & Idempotency ---')

  await runTest('CrossStore', 'tenders-data.json milestone status updated to BILLED with billedInvoiceId and billedInvoiceNumber', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true)

      const tenders = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      const milestone = tenders.workspaces[0].tenders[0].milestones.find((m) => m.id === 'ms-01')

      assert.strictEqual(milestone.status, 'BILLED', 'Milestone status is BILLED')
      assert.strictEqual(milestone.billedInvoiceId, res.invoiceId, 'billedInvoiceId matches invoice id')
      assert.strictEqual(milestone.billedInvoiceNumber, res.invoiceNumber, 'billedInvoiceNumber matches invoice number')
      assert(milestone.billedAt, 'billedAt timestamp is set')
      assert(milestone.billedDate, 'billedDate timestamp is set')
      assert(tenders.updatedAt, 'tenders store updatedAt is updated')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('CrossStore', 'Idempotency guard: Re-billing an already BILLED milestone is rejected', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      // First billing
      const res1 = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res1.ok, true)

      // Second billing attempt on same milestone
      const res2 = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res2.ok, false, 'Re-billing must be rejected')
      assert(res2.error.toLowerCase().includes('already billed'), 'Error states already billed')

      // Ensure no second invoice was created in Books
      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 1, 'Invoices count still 1')
      assert.strictEqual(books.journalEntries.length, 1, 'Journal entries count still 1')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('CrossStore', 'Eligibility guard: Attempting to bill a PENDING milestone is rejected', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      // ms-02 is in PENDING status in SEED_TENDER_WTR_04
      const res = await billHandler(null, 'tender-wtr-04', 'ms-02')
      assert.strictEqual(res.ok, false, 'Billing PENDING milestone must fail')
      assert(res.error.toLowerCase().includes('not reached'), 'Error indicates not reached')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 0, 'No invoice created in Books')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('CrossStore', 'Rejects non-existent tender ID or non-existent milestone ID', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      const resTender = await billHandler(null, 'non-existent-tender', 'ms-01')
      assert.strictEqual(resTender.ok, false)
      assert(resTender.error.toLowerCase().includes('tender not found'))

      const resMs = await billHandler(null, 'tender-wtr-04', 'non-existent-ms')
      assert.strictEqual(resMs.ok, false)
      assert(resMs.error.toLowerCase().includes('milestone not found'))

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 0)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('CrossStore', 'Shell tab activation callback onOpenBooks(invoiceId) is triggered', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      onOpenBooksCallCount = 0
      lastOpenedInvoiceId = null

      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true)
      assert.strictEqual(onOpenBooksCallCount, 1, 'onOpenBooks was called exactly once')
      assert.strictEqual(lastOpenedInvoiceId, res.invoiceId, 'onOpenBooks received invoiceId')

      // Also test openBooks IPC channel
      const openBooksRes = await openHandler(null)
      assert.strictEqual(openBooksRes, true, 'tenders:open-books returned true')
      assert.strictEqual(onOpenBooksCallCount, 2, 'onOpenBooks was called again via openBooks')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('CrossStore', 'Initial billing when books-data.json does not yet exist initializes store safely', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      // Delete books-data.json
      rmSync(sandbox.booksPath, { force: true })
      assert(!existsSync(sandbox.booksPath))

      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true, 'Billing creates books store from scratch')

      assert(existsSync(sandbox.booksPath), 'books-data.json now exists')
      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 1, 'Contains created invoice')
      assert.strictEqual(books.journalEntries.length, 1, 'Contains created journal entry')
      assert(books.accounts.length >= 5, 'Contains CORE_ACCOUNTS')
      const ar = books.accounts.find((a) => a.id === 'acc-ar')
      assert.strictEqual(ar.balance, 195500 + 145000, 'acc-ar correctly debited from core baseline')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('CrossStore', 'Preserves other workspaces, tenders, vault items, and company metadata during write', async () => {
    const sandbox = createCleanSandbox()
    try {
      currentMockUserDataDir = sandbox.root
      // Add custom company metadata and a second workspace to tenders store
      const tData = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      tData.workspaces.push({
        id: 'ws-transport-02',
        name: 'Transnet Freight Works',
        company: { name: 'Transnet Contracting' },
        customers: [{ id: 'cust-1', name: 'Transnet' }],
        vault: [{ id: 'doc-1', title: 'Tax Clearance Certificate' }],
        tenders: [],
      })
      writeFileSync(sandbox.tendersPath, JSON.stringify(tData, null, 2), 'utf8')

      const res = await billHandler(null, 'tender-wtr-04', 'ms-01')
      assert.strictEqual(res.ok, true)

      const tendersAfter = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      assert.strictEqual(tendersAfter.workspaces.length, 2, 'Both workspaces preserved')
      const ws2 = tendersAfter.workspaces.find((w) => w.id === 'ws-transport-02')
      assert(ws2, 'Second workspace found')
      assert.strictEqual(ws2.vault.length, 1, 'Vault items preserved')
      assert.strictEqual(ws2.customers.length, 1, 'Customer items preserved')
    } finally {
      sandbox.cleanup()
    }
  })

  // Summary
  console.log('\n======================================================================')
  console.log(`   CHALLENGER 2 (M3) RESULTS: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  if (failedTests === 0) {
    console.log('   VERDICT: ALL BOOKS STORE ACCOUNTING & INTEGRITY INVARIANTS VERIFIED!')
  } else {
    console.log('   VERDICT: FAILURES DETECTED!')
    for (const f of failures) {
      console.log(`     - [${f.suite}] ${f.name}: ${f.error}`)
    }
  }
  console.log('======================================================================\n')

  return {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    failures,
  }
}

runMilestone3Verification()
  .then((res) => {
    if (res.failed > 0) process.exit(1)
    process.exit(0)
  })
  .catch((err) => {
    console.error('Fatal runner error:', err)
    process.exit(1)
  })

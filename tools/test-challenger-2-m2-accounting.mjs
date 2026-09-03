#!/usr/bin/env node
/**
 * tools/test-challenger-2-m2-accounting.mjs
 *
 * Challenger 2 Verification Suite for Milestone 2:
 * Deep Empirical Verification of Books Store Accounting Side-Effects from CRM Invoicing.
 *
 * Specific Verification Objectives:
 * 1. Invoice creation in `books-data.json`:
 *    - type === 'Sales'
 *    - status === 'Unpaid'
 *    - crmDealId === deal.id
 *    - line-item description format
 *    - payment terms
 * 2. Double-entry Chart of Accounts adjustments:
 *    - acc-ar debited by grandTotal
 *    - acc-sales credited by subtotal
 *    - acc-vat credited by taxTotal
 *    - untouched accounts unchanged
 * 3. Balanced JournalEntry posting:
 *    - totalDebit === totalCredit === grandTotal
 *    - exactly 3 balancing line items (acc-ar, acc-sales, acc-vat)
 * 4. Edge-case valuations:
 *    - Zero amount (0)
 *    - Fractional cents (e.g. R 115,000.55, R 0.01, R 4,999.99, R 1,234,567.89)
 *    - Extreme amounts (R 100,000,000.00, R 999,999,999.99)
 * 5. Party auto-creation and customer balance updates:
 *    - Auto-creation of missing party
 *    - Name fallbacks
 *    - Customer outstanding balance increments and multi-deal accumulation
 *    - Case-insensitive party matching
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

// Load compiled CRM module
function loadFreshCrm(userDataDir, runtimeConfig = {}) {
  currentMockUserDataDir = userDataDir
  delete require.cache[require.resolve('../apps/crm/out/main/index.js')]
  const crm = require('../apps/crm/out/main/index.js')
  crm.configureCrmRuntime(runtimeConfig)
  crm.registerCrmIpc()
  return {
    crm,
    createInvoiceInBooks: (dealId) => ipcHandlers.get('crm:create-invoice-in-books')(null, dealId),
    openBooks: () => ipcHandlers.get('crm:open-books')(null),
  }
}

// Load compiled Books module
const booksModule = require('../apps/books/out/main/index.js')
const { CURRENT_BOOKS_SCHEMA_VERSION, CORE_ACCOUNTS, DEFAULT_BOOK_SETTINGS } = booksModule

function createCleanSandbox(prefix = 'm2-ch2-books-') {
  const root = join(tmpdir(), `${prefix}${randomUUID().slice(0, 8)}`)
  const crmDir = join(root, 'crm')
  const booksDir = join(root, 'books')
  mkdirSync(crmDir, { recursive: true })
  mkdirSync(booksDir, { recursive: true })

  const booksData = {
    version: CURRENT_BOOKS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_BOOK_SETTINGS },
    accounts: CORE_ACCOUNTS.map((a) => ({ ...a })),
    parties: [
      {
        id: 'party-pre-1',
        name: 'Apex Engineering (Pty) Ltd',
        type: 'Customer',
        email: 'billing@apexeng.co.za',
        outstandingBalance: 65000,
      },
      {
        id: 'party-pre-2',
        name: 'Helios Clean Energy',
        type: 'Customer',
        email: 'accounts@heliosenergy.com',
        outstandingBalance: 120000,
      },
    ],
    invoices: [],
    journalEntries: [],
  }
  writeFileSync(join(booksDir, 'books-data.json'), JSON.stringify(booksData, null, 2), 'utf8')

  return {
    root,
    crmDir,
    booksDir,
    dealsPath: join(crmDir, 'deals.json'),
    booksPath: join(booksDir, 'books-data.json'),
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {}
    },
  }
}

function writeDeals(dealsPath, deals) {
  const envelope = {
    version: 1,
    updatedAt: new Date().toISOString(),
    deals,
  }
  writeFileSync(dealsPath, JSON.stringify(envelope, null, 2), 'utf8')
}

// Test harness state
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
console.log('   EMPIRICAL CHALLENGER 2: MILESTONE 2 ACCOUNTING TEST HARNESS')
console.log('   Books Store Accounting Side-Effects Verification')
console.log('======================================================================\n')

async function runAccountingSuite() {
  // =========================================================================
  // SUITE 1: Sales Invoice Creation & Specification Integrity
  // =========================================================================
  console.log('--- SUITE 1: Sales Invoice Creation & Specification Integrity ---')

  await runTest('InvoiceSpec', 'Invoice created with type=Sales, status=Unpaid, and correct crmDealId', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deal = {
        id: 'deal-inv-01',
        name: 'Municipal Water SCADA Refurbishment',
        companyName: 'Apex Engineering (Pty) Ltd',
        amount: 250000,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(deal.id)
      assert.strictEqual(res.ok, true, 'Invoice creation succeeded')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 1, 'Exactly 1 invoice created')

      const inv = books.invoices[0]
      assert.strictEqual(inv.id, res.invoiceId, 'Invoice id matches response')
      assert.strictEqual(inv.invoiceNumber, res.invoiceNumber, 'Invoice number matches response')
      assert.strictEqual(inv.type, 'Sales', 'Invoice type must be "Sales"')
      assert.strictEqual(inv.status, 'Unpaid', 'Invoice status must be "Unpaid"')
      assert.strictEqual(inv.crmDealId, deal.id, 'Invoice crmDealId must match deal id')
      assert.strictEqual(inv.partyName, 'Apex Engineering (Pty) Ltd', 'Party name matches')
      assert.strictEqual(inv.partyId, 'party-pre-1', 'Party id matches existing party')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('InvoiceSpec', 'Invoice line-item specification, description, and payment terms match contract', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deal = {
        id: 'deal-inv-02',
        name: 'Cloud Infrastructure Migration Phase 2',
        companyName: 'Helios Clean Energy',
        amount: 115000,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(deal.id)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices[0]

      // Notes & Payment Terms
      assert.strictEqual(
        inv.notes,
        'Payment terms: Net 30 days upon invoice receipt.',
        'Payment terms note must match exact contract specification',
      )

      // Due date calculation (today + 30 days)
      const today = new Date().toISOString().split('T')[0]
      assert.strictEqual(inv.date, today, 'Invoice date must be today')
      const expectedDueDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
      assert.strictEqual(inv.dueDate, expectedDueDate, 'Due date must be exactly 30 days ahead')

      // Items array
      assert(Array.isArray(inv.items) && inv.items.length === 1, 'Must have exactly 1 line item')
      const item = inv.items[0]
      assert.strictEqual(
        item.description,
        'Cloud Infrastructure Migration Phase 2 - Commercial Implementation & Services',
        'Line item description format matches "${deal.name} - Commercial Implementation & Services"',
      )
      assert.strictEqual(item.itemCode, 'COMMERCIAL-DELIVERY', 'itemCode is COMMERCIAL-DELIVERY')
      assert.strictEqual(item.accountId, 'acc-sales', 'Item assigned to acc-sales')
      assert.strictEqual(item.accountName, 'Tender & Commercial Contracting Sales', 'Item accountName matches')
      assert.strictEqual(item.qty, 1, 'Quantity is 1')
      assert.strictEqual(item.rate, inv.subtotal, 'Rate equals subtotal')
      assert.strictEqual(item.amount, inv.subtotal, 'Amount equals subtotal')
      assert.strictEqual(item.taxRate, 15, 'VAT rate is 15%')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('InvoiceSpec', 'Invoice valuation mapping: grandTotal === subtotal + taxTotal and outstandingAmount === grandTotal', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deal = {
        id: 'deal-inv-03',
        name: 'Enterprise Security Audit',
        companyName: 'Helios Clean Energy',
        amount: 345000,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      await createInvoiceInBooks(deal.id)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices[0]

      assert.strictEqual(inv.grandTotal, 345000, 'grandTotal matches deal.amount')
      assert.strictEqual(inv.subtotal, 300000, 'subtotal is VAT exclusive (345000 / 1.15 = 300000)')
      assert.strictEqual(inv.taxTotal, 45000, 'taxTotal is 15% VAT (45000)')
      assert.strictEqual(
        Math.round((inv.subtotal + inv.taxTotal) * 100) / 100,
        inv.grandTotal,
        'subtotal + taxTotal exactly equals grandTotal',
      )
      assert.strictEqual(inv.outstandingAmount, inv.grandTotal, 'outstandingAmount equals grandTotal initially')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 2: Double-Entry Chart of Accounts Side-Effects
  // =========================================================================
  console.log('\n--- SUITE 2: Double-Entry Chart of Accounts Side-Effects ---')

  await runTest('ChartOfAccounts', 'acc-ar debited by grandTotal, acc-sales credited by subtotal, acc-vat credited by taxTotal', async () => {
    const sandbox = createCleanSandbox()
    try {
      const booksBefore = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const arBefore = booksBefore.accounts.find((a) => a.id === 'acc-ar').balance
      const salesBefore = booksBefore.accounts.find((a) => a.id === 'acc-sales').balance
      const vatBefore = booksBefore.accounts.find((a) => a.id === 'acc-vat').balance
      const bankBefore = booksBefore.accounts.find((a) => a.id === 'acc-bank').balance
      const apBefore = booksBefore.accounts.find((a) => a.id === 'acc-ap').balance

      const deal = {
        id: 'deal-coa-01',
        name: 'Digital Transformation Project',
        companyName: 'Helios Clean Energy',
        amount: 230000,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      await createInvoiceInBooks(deal.id)

      const booksAfter = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const arAfter = booksAfter.accounts.find((a) => a.id === 'acc-ar').balance
      const salesAfter = booksAfter.accounts.find((a) => a.id === 'acc-sales').balance
      const vatAfter = booksAfter.accounts.find((a) => a.id === 'acc-vat').balance
      const bankAfter = booksAfter.accounts.find((a) => a.id === 'acc-bank').balance
      const apAfter = booksAfter.accounts.find((a) => a.id === 'acc-ap').balance

      // 230000 / 1.15 = 200000 subtotal, 30000 tax
      assert.strictEqual(arAfter, arBefore + 230000, 'acc-ar debited by 230,000')
      assert.strictEqual(salesAfter, salesBefore + 200000, 'acc-sales credited by 200,000')
      assert.strictEqual(vatAfter, vatBefore + 30000, 'acc-vat credited by 30,000')

      // Untouched accounts remain unchanged
      assert.strictEqual(bankAfter, bankBefore, 'acc-bank balance unchanged')
      assert.strictEqual(apAfter, apBefore, 'acc-ap balance unchanged')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('ChartOfAccounts', 'Multiple sequential invoices accumulate ledger account balances without drift', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deals = [
        { id: 'deal-seq-1', name: 'Phase 1 Rollout', companyName: 'Helios Clean Energy', amount: 115000, stage: 'won' },
        { id: 'deal-seq-2', name: 'Phase 2 Enhancements', companyName: 'Apex Engineering (Pty) Ltd', amount: 57500, stage: 'won' },
        { id: 'deal-seq-3', name: 'Annual Support SLA', companyName: 'Helios Clean Energy', amount: 28750, stage: 'won' },
      ]
      writeDeals(sandbox.dealsPath, deals)

      const booksInit = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const arInit = booksInit.accounts.find((a) => a.id === 'acc-ar').balance
      const salesInit = booksInit.accounts.find((a) => a.id === 'acc-sales').balance
      const vatInit = booksInit.accounts.find((a) => a.id === 'acc-vat').balance

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      for (const d of deals) {
        const res = await createInvoiceInBooks(d.id)
        assert.strictEqual(res.ok, true)
      }

      const booksFinal = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const arFinal = booksFinal.accounts.find((a) => a.id === 'acc-ar').balance
      const salesFinal = booksFinal.accounts.find((a) => a.id === 'acc-sales').balance
      const vatFinal = booksFinal.accounts.find((a) => a.id === 'acc-vat').balance

      const expectedGrandTotal = 115000 + 57500 + 28750 // 201,250
      const expectedSubtotal = 100000 + 50000 + 25000   // 175,000
      const expectedTaxTotal = 15000 + 7500 + 3750      // 26,250

      assert.strictEqual(arFinal, arInit + expectedGrandTotal, 'acc-ar accumulated correctly')
      assert.strictEqual(salesFinal, salesInit + expectedSubtotal, 'acc-sales accumulated correctly')
      assert.strictEqual(vatFinal, vatInit + expectedTaxTotal, 'acc-vat accumulated correctly')

      // Chart of Accounts double-entry invariant: total assets change = total liabilities + income change
      const deltaAR = arFinal - arInit
      const deltaCredit = (salesFinal - salesInit) + (vatFinal - vatInit)
      assert.strictEqual(deltaAR, deltaCredit, 'Total debit change equals total credit change across all deals')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 3: JournalEntry Posting & Balancing Verification
  // =========================================================================
  console.log('\n--- SUITE 3: JournalEntry Posting & Balancing Verification ---')

  await runTest('JournalEntry', 'Journal entry created with totalDebit === totalCredit === grandTotal and posted=true', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deal = {
        id: 'deal-je-01',
        name: 'Core System Upgrade',
        companyName: 'Helios Clean Energy',
        amount: 80500,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(deal.id)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.journalEntries.length, 1, 'Exactly 1 journal entry created')

      const je = books.journalEntries[0]
      assert.strictEqual(je.posted, true, 'Journal entry is marked posted')
      assert.strictEqual(je.totalDebit, 80500, 'totalDebit is 80,500')
      assert.strictEqual(je.totalCredit, 80500, 'totalCredit is 80,500')
      assert.strictEqual(je.totalDebit, je.totalCredit, 'totalDebit equals totalCredit exactly')
      assert(je.entryNumber.startsWith('JE-'), 'entryNumber has format JE-YYYY-N')
      assert(je.remarks.includes(res.invoiceNumber), 'remarks includes invoiceNumber')
      assert(je.remarks.includes(deal.name), 'remarks includes deal name')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('JournalEntry', 'Journal entry contains 3 balanced line items with correct debits, credits, and accounts', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deal = {
        id: 'deal-je-02',
        name: 'Enterprise Telemetry Architecture',
        companyName: 'Apex Engineering (Pty) Ltd',
        amount: 115000,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      await createInvoiceInBooks(deal.id)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const je = books.journalEntries[0]

      assert.strictEqual(je.items.length, 3, 'Must have exactly 3 journal entry items')

      const arItem = je.items.find((i) => i.accountId === 'acc-ar')
      const salesItem = je.items.find((i) => i.accountId === 'acc-sales')
      const vatItem = je.items.find((i) => i.accountId === 'acc-vat')

      assert(arItem, 'Must contain acc-ar line item')
      assert(salesItem, 'Must contain acc-sales line item')
      assert(vatItem, 'Must contain acc-vat line item')

      // acc-ar: Debit = grandTotal, Credit = 0
      assert.strictEqual(arItem.debit, 115000, 'acc-ar debit is grandTotal')
      assert.strictEqual(arItem.credit, 0, 'acc-ar credit is 0')
      assert.strictEqual(arItem.partyId, 'party-pre-1', 'acc-ar references partyId')
      assert.strictEqual(arItem.partyName, 'Apex Engineering (Pty) Ltd', 'acc-ar references partyName')

      // acc-sales: Debit = 0, Credit = subtotal
      assert.strictEqual(salesItem.debit, 0, 'acc-sales debit is 0')
      assert.strictEqual(salesItem.credit, 100000, 'acc-sales credit is subtotal (100,000)')

      // acc-vat: Debit = 0, Credit = taxTotal
      assert.strictEqual(vatItem.debit, 0, 'acc-vat debit is 0')
      assert.strictEqual(vatItem.credit, 15000, 'acc-vat credit is taxTotal (15,000)')

      // Sum of item debits and credits
      const sumDebits = je.items.reduce((s, i) => s + i.debit, 0)
      const sumCredits = je.items.reduce((s, i) => s + i.credit, 0)
      assert.strictEqual(sumDebits, 115000, 'Sum of line-item debits equals grandTotal')
      assert.strictEqual(sumCredits, 115000, 'Sum of line-item credits equals grandTotal')
      assert.strictEqual(sumDebits, sumCredits, 'Sum of debits equals sum of credits')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 4: Edge-Case Valuations
  // =========================================================================
  console.log('\n--- SUITE 4: Edge-Case Valuations ---')

  await runTest('ValuationEdges', 'Zero amount deal (amount = 0): creates balanced zero invoice and zero journal entry', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deal = {
        id: 'deal-zero-01',
        name: 'Pro Bono Feasibility Study',
        companyName: 'Apex Engineering (Pty) Ltd',
        amount: 0,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(deal.id)
      assert.strictEqual(res.ok, true, 'Zero valuation deal must succeed')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices[0]
      assert.strictEqual(inv.grandTotal, 0, 'grandTotal is 0')
      assert.strictEqual(inv.subtotal, 0, 'subtotal is 0')
      assert.strictEqual(inv.taxTotal, 0, 'taxTotal is 0')

      const je = books.journalEntries[0]
      assert.strictEqual(je.totalDebit, 0, 'JE totalDebit is 0')
      assert.strictEqual(je.totalCredit, 0, 'JE totalCredit is 0')
      assert.strictEqual(je.totalDebit, je.totalCredit, 'JE balances at zero')
      for (const item of je.items) {
        assert(!Number.isNaN(item.debit), 'No NaN debit')
        assert(!Number.isNaN(item.credit), 'No NaN credit')
      }
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('ValuationEdges', 'Fractional cents valuation (R 115,000.55): subtotal + taxTotal === grandTotal to the exact cent', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deal = {
        id: 'deal-frac-01',
        name: 'Custom Hardware Supply Contract',
        companyName: 'Helios Clean Energy',
        amount: 115000.55,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(deal.id)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices[0]
      const je = books.journalEntries[0]

      // 115000.55 / 1.15 = 100000.47826... -> 100000.48
      // 115000.55 - 100000.48 = 15000.07
      assert.strictEqual(inv.grandTotal, 115000.55, 'grandTotal is 115000.55')
      assert.strictEqual(inv.subtotal, 100000.48, 'subtotal rounded to 100000.48')
      assert.strictEqual(inv.taxTotal, 15000.07, 'taxTotal is 15000.07')
      assert.strictEqual(
        Math.round((inv.subtotal + inv.taxTotal) * 100) / 100,
        inv.grandTotal,
        'Penny-exact balance: 100000.48 + 15000.07 === 115000.55',
      )

      // Journal entry exact balancing
      assert.strictEqual(je.totalDebit, 115000.55, 'JE totalDebit is 115000.55')
      assert.strictEqual(je.totalCredit, 115000.55, 'JE totalCredit is 115000.55')
      assert.strictEqual(je.totalDebit, je.totalCredit, 'JE is balanced')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('ValuationEdges', 'Extreme enterprise valuation (R 100,000,000.00): subtotal + taxTotal === grandTotal without overflow', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deal = {
        id: 'deal-extreme-01',
        name: 'National Grid Infrastructure Transformation',
        companyName: 'Helios Clean Energy',
        amount: 100000000.0,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(deal.id)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices[0]
      const je = books.journalEntries[0]

      // 100,000,000 / 1.15 = 86,956,521.73913 -> 86956521.74
      // 100,000,000 - 86956521.74 = 13043478.26
      assert.strictEqual(inv.grandTotal, 100000000, 'grandTotal is 100,000,000')
      assert.strictEqual(inv.subtotal, 86956521.74, 'subtotal is 86,956,521.74')
      assert.strictEqual(inv.taxTotal, 13043478.26, 'taxTotal is 13,043,478.26')
      assert.strictEqual(
        Math.round((inv.subtotal + inv.taxTotal) * 100) / 100,
        100000000,
        'Enterprise valuation balances to the cent',
      )

      assert.strictEqual(je.totalDebit, 100000000, 'JE totalDebit matches')
      assert.strictEqual(je.totalCredit, 100000000, 'JE totalCredit matches')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('ValuationEdges', 'Adversarial odd valuations (0.01, 0.07, 4999.99, 1234567.89, 999999999.99) all balance penny-exact', async () => {
    const sandbox = createCleanSandbox()
    try {
      const oddAmounts = [0.01, 0.07, 99.99, 4999.99, 1234567.89, 999999999.99]
      const deals = oddAmounts.map((amt, idx) => ({
        id: `deal-odd-${idx}`,
        name: `Odd Deal ${amt}`,
        companyName: 'Apex Engineering (Pty) Ltd',
        amount: amt,
        stage: 'won',
      }))
      writeDeals(sandbox.dealsPath, deals)

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      for (const d of deals) {
        const res = await createInvoiceInBooks(d.id)
        assert.strictEqual(res.ok, true, `Invoicing ${d.amount} must succeed`)
      }

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, oddAmounts.length)

      for (let i = 0; i < books.invoices.length; i++) {
        const inv = books.invoices[i]
        const je = books.journalEntries[i]

        const sumInvoice = Math.round((inv.subtotal + inv.taxTotal) * 100) / 100
        assert.strictEqual(
          sumInvoice,
          inv.grandTotal,
          `Invoice ${inv.invoiceNumber} subtotal (${inv.subtotal}) + taxTotal (${inv.taxTotal}) !== grandTotal (${inv.grandTotal})`,
        )
        assert.strictEqual(
          je.totalDebit,
          je.totalCredit,
          `JE ${je.entryNumber} debit (${je.totalDebit}) !== credit (${je.totalCredit})`,
        )
        assert.strictEqual(
          je.totalDebit,
          inv.grandTotal,
          `JE ${je.entryNumber} totalDebit !== invoice grandTotal`,
        )
      }
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 5: Missing Party Auto-Creation & Customer Balance Updates
  // =========================================================================
  console.log('\n--- SUITE 5: Missing Party Auto-Creation & Customer Balance Updates ---')

  await runTest('PartyAndBalance', 'Auto-creates missing party with type=Customer and correct email domain', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deal = {
        id: 'deal-party-new',
        name: 'Smart Metering Gateway Deployment',
        companyName: 'Gauteng Water Utilities',
        amount: 175000,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(deal.id)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const party = books.parties.find((p) => p.name === 'Gauteng Water Utilities')

      assert(party, 'New party was created in Books')
      assert(party.id.startsWith('party-'), 'Party id has prefix party-')
      assert.strictEqual(party.type, 'Customer', 'Party type is Customer')
      assert.strictEqual(party.email, 'accounts@gautengwaterutilities.com', 'Auto-generated customer email')
      assert.strictEqual(party.outstandingBalance, 175000, 'Party outstandingBalance initialized to grandTotal')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('PartyAndBalance', 'Graceful fallback party name when companyName is missing (uses deal.name or sanitized fallback)', async () => {
    const sandbox = createCleanSandbox()
    try {
      // Deal with no companyName, but deal.name is 'Industrial Valve Retooling'
      const deal1 = {
        id: 'deal-nocomp-01',
        name: 'Industrial Valve Retooling',
        amount: 85000,
        stage: 'won',
      }
      // Deal with empty companyName and empty name (CrmStore sanitizes to 'Untitled Deal')
      const deal2 = {
        id: 'deal-nocomp-02',
        name: '',
        companyName: '',
        amount: 15000,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal1, deal2])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res1 = await createInvoiceInBooks(deal1.id)
      const res2 = await createInvoiceInBooks(deal2.id)
      assert.strictEqual(res1.ok, true)
      assert.strictEqual(res2.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const party1 = books.parties.find((p) => p.name === 'Industrial Valve Retooling')
      const party2 = books.parties.find((p) => p.name === 'Untitled Deal' || p.name === 'Valued Client')

      assert(party1, 'Party named after deal.name created when companyName is omitted')
      assert.strictEqual(party1.outstandingBalance, 85000)

      assert(party2, 'Party named after sanitized fallback created when both names are empty')
      assert.strictEqual(party2.outstandingBalance, 15000)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('PartyAndBalance', 'Updates existing party outstanding balance and accumulates across multiple deals', async () => {
    const sandbox = createCleanSandbox()
    try {
      // party-pre-2 'Helios Clean Energy' starts with 120,000 balance
      const booksBefore = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const heliosBefore = booksBefore.parties.find((p) => p.name === 'Helios Clean Energy')
      assert.strictEqual(heliosBefore.outstandingBalance, 120000, 'Helios starts with 120,000')

      const deal1 = {
        id: 'deal-accum-1',
        name: 'Solar Substation Monitoring',
        companyName: 'Helios Clean Energy',
        amount: 80000.50,
        stage: 'won',
      }
      const deal2 = {
        id: 'deal-accum-2',
        name: 'Battery Inverter Integration',
        companyName: 'Helios Clean Energy',
        amount: 45000.25,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [deal1, deal2])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      await createInvoiceInBooks(deal1.id)
      await createInvoiceInBooks(deal2.id)

      const booksAfter = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const heliosAfter = booksAfter.parties.find((p) => p.name === 'Helios Clean Energy')

      // 120,000 + 80,000.50 + 45,000.25 = 245,000.75
      const expectedBalance = 120000 + 80000.50 + 45000.25
      assert.strictEqual(
        heliosAfter.outstandingBalance,
        expectedBalance,
        `Helios outstanding balance accumulated: expected ${expectedBalance}, got ${heliosAfter.outstandingBalance}`,
      )

      // Confirm no duplicate party was created
      const matchingParties = booksAfter.parties.filter((p) => p.name.toLowerCase() === 'helios clean energy')
      assert.strictEqual(matchingParties.length, 1, 'Exactly one Helios party exists in Books')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('PartyAndBalance', 'Case-insensitive party matching reuses existing party without creating duplicate', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealUpper = {
        id: 'deal-case-01',
        name: 'Turbine Optimization Service',
        companyName: 'HELIOS CLEAN ENERGY', // uppercase
        amount: 60000,
        stage: 'won',
      }
      writeDeals(sandbox.dealsPath, [dealUpper])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      await createInvoiceInBooks(dealUpper.id)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const heliosParties = books.parties.filter((p) => p.name.toLowerCase() === 'helios clean energy')

      assert.strictEqual(heliosParties.length, 1, 'Must NOT create duplicate party for different casing')
      assert.strictEqual(heliosParties[0].outstandingBalance, 120000 + 60000, 'Balance updated on existing party')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 6: End-to-End Accounting Lifecycle & Integration Consistency
  // =========================================================================
  console.log('\n--- SUITE 6: End-to-End Accounting Lifecycle & Integration Consistency ---')

  await runTest('AccountingLifecycle', 'Invoice ordering, JournalEntry ordering, and CRM deal back-reference consistency', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deals = [
        { id: 'deal-e2e-1', name: 'Contract Alpha', companyName: 'Apex Engineering (Pty) Ltd', amount: 50000, stage: 'won' },
        { id: 'deal-e2e-2', name: 'Contract Beta', companyName: 'Helios Clean Energy', amount: 75000, stage: 'won' },
      ]
      writeDeals(sandbox.dealsPath, deals)

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res1 = await createInvoiceInBooks(deals[0].id)
      const res2 = await createInvoiceInBooks(deals[1].id)

      // Check Books file
      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 2)
      assert.strictEqual(books.journalEntries.length, 2)

      // Invoices unshifted: index 0 is most recent (deal-e2e-2)
      assert.strictEqual(books.invoices[0].id, res2.invoiceId)
      assert.strictEqual(books.invoices[1].id, res1.invoiceId)

      // JournalEntries unshifted: index 0 is most recent (deal-e2e-2)
      assert.strictEqual(books.journalEntries[0].remarks.includes(res2.invoiceNumber), true)
      assert.strictEqual(books.journalEntries[1].remarks.includes(res1.invoiceNumber), true)

      // Check deals.json back-references
      const crmDealsEnvelope = JSON.parse(readFileSync(sandbox.dealsPath, 'utf8'))
      const d1 = crmDealsEnvelope.deals.find((d) => d.id === deals[0].id)
      const d2 = crmDealsEnvelope.deals.find((d) => d.id === deals[1].id)

      assert.strictEqual(d1.invoiceId, res1.invoiceId, 'Deal 1 has invoiceId')
      assert.strictEqual(d1.invoiceNumber, res1.invoiceNumber, 'Deal 1 has invoiceNumber')
      assert(d1.invoicedAt, 'Deal 1 has invoicedAt timestamp')

      assert.strictEqual(d2.invoiceId, res2.invoiceId, 'Deal 2 has invoiceId')
      assert.strictEqual(d2.invoiceNumber, res2.invoiceNumber, 'Deal 2 has invoiceNumber')
      assert(d2.invoicedAt, 'Deal 2 has invoicedAt timestamp')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n======================================================================')
  console.log(`CHALLENGER 2 ACCOUNTING RESULTS: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  if (failedTests === 0) {
    console.log('STATUS: EMPIRICAL VERIFICATION PASSED (100% SUCCESS)')
  } else {
    console.log(`STATUS: EMPIRICAL VERIFICATION FAILED (${failedTests} failures)`)
  }
  console.log('======================================================================')

  if (failedTests > 0) {
    process.exit(1)
  } else {
    process.exit(0)
  }
}

runAccountingSuite().catch((err) => {
  console.error('Fatal test runner error:', err)
  process.exit(1)
})

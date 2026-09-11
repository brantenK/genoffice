#!/usr/bin/env node
/**
 * tools/test-adversarial-m2-empirical.mjs
 *
 * Adversarial Empirical Verification Suite for Milestone 2:
 * Tests the real compiled apps/crm/out/main/index.js IPC handler 'crm:create-invoice-in-books'
 * and 'crm:open-books' against stress-test corner cases, mathematical invariants,
 * double-entry ledger balance, duplicate prevention, and schema envelope preservation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Set up mock Electron IPC & App with a persistent sandbox dir for the CrmStore instance
const sandboxDir = join(tmpdir(), `m2-adv-${randomUUID().slice(0, 8)}`)
mkdirSync(join(sandboxDir, 'crm'), { recursive: true })
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

// Import compiled crm main module AFTER electron mock is installed
const crm = require('../apps/crm/out/main/index.js')

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failureDetails = []

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed')
  }
}

function writeCrmDeals(deals) {
  const filePath = join(sandboxDir, 'crm', 'deals.json')
  writeFileSync(filePath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), deals }, null, 2))
}

function readCrmDeals() {
  const filePath = join(sandboxDir, 'crm', 'deals.json')
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function writeBooksData(data) {
  const filePath = join(sandboxDir, 'books', 'books-data.json')
  writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function readBooksData() {
  const filePath = join(sandboxDir, 'books', 'books-data.json')
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function createInitialBooksStore() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: {
      companyName: 'Zano Consulting & Engineering (Pty) Ltd',
      currency: 'ZAR',
      currencySymbol: 'R',
    },
    accounts: [
      { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', balance: 500000 },
      { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', balance: 100000 },
      { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', balance: 50000 },
      { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', balance: 800000 },
      { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', balance: 35000 },
    ],
    parties: [
      { id: 'party-existing', name: 'Existing Client Corp', type: 'Customer', email: 'acc@existing.com', outstandingBalance: 25000 },
    ],
    invoices: [],
    bills: [],
    journalEntries: [],
  }
}

async function test(name, fn) {
  totalTests++
  try {
    await fn()
    passedTests++
    console.log(`  ✅ [PASS] ${name}`)
  } catch (err) {
    failedTests++
    failureDetails.push({ name, error: err.message || String(err) })
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`)
  }
}

console.log('\n======================================================================')
console.log('   MILESTONE 2: EMPIRICAL ADVERSARIAL VERIFICATION')
console.log('======================================================================\n')

// Register CRM IPC
crm.registerCrmIpc()
const createInvoiceHandler = ipcHandlers.get('crm:create-invoice-in-books')
const openBooksHandler = ipcHandlers.get('crm:open-books')

assert(typeof createInvoiceHandler === 'function', 'createInvoiceInBooks IPC handler must be registered')
assert(typeof openBooksHandler === 'function', 'openBooks IPC handler must be registered')

async function runAll() {
  // Test 1: Non-won deal rejection across all pipeline stages
  await test('Rejection of non-won pipeline stages (lead, qualified, proposal, negotiation, lost)', async () => {
    const nonWonStages = ['lead', 'qualified', 'proposal', 'negotiation', 'lost']
    const deals = nonWonStages.map((st, idx) => ({
      id: `deal-st-${idx}`,
      name: `Deal in ${st}`,
      companyName: `Company ${st}`,
      amount: 50000,
      stage: st,
    }))
    writeCrmDeals(deals)
    writeBooksData(createInitialBooksStore())

    for (const d of deals) {
      const res = await createInvoiceHandler({}, d.id)
      assert(!res.ok, `Deal in stage ${d.stage} should have failed`)
      assert(res.error.includes('not won'), `Error message for stage ${d.stage} should say not won, got: ${res.error}`)
    }
  })

  // Test 2: Non-existent deal ID rejection
  await test('Rejection of non-existent deal ID', async () => {
    writeCrmDeals([])
    writeBooksData(createInitialBooksStore())

    const res = await createInvoiceHandler({}, 'non-existent-id')
    assert(!res.ok, 'Non-existent deal should fail')
    assert(res.error.includes('not found') || res.error.includes('Deal not found'), 'Error should state deal not found')
  })

  // Test 3: Nominal won deal invoice generation and exact mapping
  await test('Nominal won deal invoice mapping and 15% VAT split', async () => {
    let booksTabOpened = false
    crm.configureCrmRuntime({ onOpenBooks: () => { booksTabOpened = true } })

    const deal = {
      id: 'deal-nominal-1',
      name: 'Smart Water Grid Sensor Array',
      companyName: 'City of Tshwane Metro',
      amount: 115000,
      stage: 'won',
    }
    writeCrmDeals([deal])
    writeBooksData(createInitialBooksStore())

    const res = await createInvoiceHandler({}, deal.id)
    assert(res.ok, `Creation must succeed: ${res.error}`)
    assert(res.invoiceNumber && res.invoiceNumber.startsWith('INV-'), 'Must return valid invoiceNumber')
    assert(res.invoiceId, 'Must return invoiceId')
    assert(booksTabOpened, 'onOpenBooks callback must have been fired')

    // Inspect Books data
    const books = readBooksData()
    assert(books.invoices.length === 1, 'Exactly 1 invoice created')
    const inv = books.invoices[0]
    assert(inv.id === res.invoiceId, 'Invoice ID matches response')
    assert(inv.type === 'Sales', 'Invoice type is Sales')
    assert(inv.status === 'Unpaid', 'Invoice status is Unpaid')
    assert(inv.crmDealId === deal.id, 'crmDealId correctly recorded')
    assert(inv.partyName === 'City of Tshwane Metro', 'Party name matches company')
    assert(inv.grandTotal === 115000, 'Grand total matches deal amount')
    assert(inv.subtotal === 100000, 'Subtotal is 100,000 (115000 / 1.15)')
    assert(inv.taxTotal === 15000, 'Tax total is 15,000')
    assert(inv.items.length === 1, 'Has 1 line item')
    assert(inv.items[0].description.includes(deal.name), 'Item description includes deal name')
    assert(inv.items[0].taxRate === 15, 'Tax rate is 15')
    assert(inv.notes.includes('Net 30 days'), 'Notes include Net 30 payment terms')

    // Check party creation & balance
    const party = books.parties.find((p) => p.name === 'City of Tshwane Metro')
    assert(party, 'New party created for customer')
    assert(party.outstandingBalance === 115000, 'Party balance increased by grandTotal')

    // Check double-entry ledger adjustments
    const ar = books.accounts.find((a) => a.id === 'acc-ar')
    const sales = books.accounts.find((a) => a.id === 'acc-sales')
    const vat = books.accounts.find((a) => a.id === 'acc-vat')
    assert(ar.balance === 100000 + 115000, 'acc-ar debited by grandTotal')
    assert(sales.balance === 800000 + 100000, 'acc-sales credited by subtotal')
    assert(vat.balance === 35000 + 15000, 'acc-vat credited by taxTotal')

    // Check balanced Journal Entry
    assert(books.journalEntries.length === 1, 'Journal entry created')
    const je = books.journalEntries[0]
    assert(je.totalDebit === 115000, 'Journal entry total debit matches grandTotal')
    assert(je.totalCredit === 115000, 'Journal entry total credit matches grandTotal')
    assert(je.totalDebit === je.totalCredit, 'Journal entry is perfectly balanced')

    // Check CRM Deal back-reference in deals.json
    const crmData = readCrmDeals()
    assert(crmData.version === 1, 'CRM deals version envelope preserved')
    const savedDeal = crmData.deals.find((d) => d.id === deal.id)
    assert(savedDeal.invoiceId === res.invoiceId, 'Deal back-reference invoiceId stored')
    assert(savedDeal.invoiceNumber === res.invoiceNumber, 'Deal back-reference invoiceNumber stored')
    assert(savedDeal.invoicedAt, 'Deal back-reference invoicedAt timestamp stored')
  })

  // Test 4: Idempotency & Duplicate invoicing guard
  await test('Idempotent duplicate guard prevents multiple invoices and duplicate ledger postings', async () => {
    const deal = {
      id: 'deal-dup-1',
      name: 'Cybersecurity Appliance Renewal',
      companyName: 'SecureBank Africa',
      amount: 230000,
      stage: 'won',
    }
    writeCrmDeals([deal])
    writeBooksData(createInitialBooksStore())

    // First call
    const res1 = await createInvoiceHandler({}, deal.id)
    assert(res1.ok, `First invoice creation succeeds: ${res1.error}`)
    const invNum1 = res1.invoiceNumber

    // Verify initial ledger state
    const books1 = readBooksData()
    const arBal1 = books1.accounts.find((a) => a.id === 'acc-ar').balance
    const jeCount1 = books1.journalEntries.length
    const invCount1 = books1.invoices.length

    // Second call on the same deal
    const res2 = await createInvoiceHandler({}, deal.id)
    assert(res2.ok, 'Second call returns ok')
    assert(res2.invoiceNumber === invNum1, 'Second call returns same invoiceNumber')

    // Verify no secondary mutations occurred
    const books2 = readBooksData()
    const arBal2 = books2.accounts.find((a) => a.id === 'acc-ar').balance
    const jeCount2 = books2.journalEntries.length
    const invCount2 = books2.invoices.length

    assert(arBal2 === arBal1, 'No duplicate acc-ar debit')
    assert(jeCount2 === jeCount1, 'No duplicate journal entry created')
    assert(invCount2 === invCount1, 'No duplicate invoice created in Books')
  })

  // Test 5: Mathematical precision and cent invariants across edge valuations
  await test('Cent invariant subtotal + taxTotal === grandTotal across irregular & fractional amounts', async () => {
    const testAmounts = [
      0,                  // Zero valuation
      0.01,               // 1 cent
      0.99,               // 99 cents
      115000.55,          // Fractional cents with rounding
      99.99,              // Prime-fraction cents
      333333.33,          // Repeating thirds
      100000000.00,       // R 100M extreme valuation
    ]

    for (let i = 0; i < testAmounts.length; i++) {
      const amt = testAmounts[i]
      const deal = {
        id: `deal-frac-${i}`,
        name: `Deal Val ${amt}`,
        companyName: `Client ${i}`,
        amount: amt,
        stage: 'won',
      }
      writeCrmDeals([deal])
      writeBooksData(createInitialBooksStore())

      const res = await createInvoiceHandler({}, deal.id)
      assert(res.ok, `Valuation ${amt} must succeed: ${res.error}`)

      const books = readBooksData()
      const inv = books.invoices[0]
      const expectedGrand = Math.round(amt * 100) / 100
      assert(inv.grandTotal === expectedGrand, `Grand total ${inv.grandTotal} matches ${expectedGrand}`)
      const sum = Math.round((inv.subtotal + inv.taxTotal) * 100) / 100
      assert(sum === expectedGrand, `Subtotal (${inv.subtotal}) + Tax (${inv.taxTotal}) === Grand (${expectedGrand})`)

      const je = books.journalEntries[0]
      assert(je.totalDebit === expectedGrand, 'JE totalDebit matches grand')
      assert(je.totalCredit === expectedGrand, 'JE totalCredit matches grand')
      assert(je.totalDebit === je.totalCredit, 'JE is balanced')
    }
  })

  // Test 6: Fallback when companyName is absent
  await test('Fallback to deal name or default when companyName is missing', async () => {
    const deal1 = {
      id: 'deal-no-comp',
      name: 'Private Advisory Engagement',
      amount: 45000,
      stage: 'won',
    }
    writeCrmDeals([deal1])
    writeBooksData(createInitialBooksStore())

    const res = await createInvoiceHandler({}, deal1.id)
    assert(res.ok, `Creation without companyName must succeed: ${res.error}`)

    const books = readBooksData()
    const party = books.parties.find((p) => p.name === 'Private Advisory Engagement')
    assert(party, 'Fallback party name used deal.name')
  })

  // Test 7: Party reuse when party already exists (case-insensitive)
  await test('Existing party in Books is reused without duplicate party creation', async () => {
    const deal = {
      id: 'deal-existing-party',
      name: 'Additional Support Pack',
      companyName: 'EXISTING CLIENT CORP', // uppercase vs Existing Client Corp
      amount: 50000,
      stage: 'won',
    }
    writeCrmDeals([deal])
    writeBooksData(createInitialBooksStore())

    const res = await createInvoiceHandler({}, deal.id)
    assert(res.ok, `Creation must succeed: ${res.error}`)

    const books = readBooksData()
    const matchingParties = books.parties.filter((p) => p.name.toLowerCase() === 'existing client corp')
    assert(matchingParties.length === 1, 'Only 1 party must exist (no duplicate created)')
    assert(matchingParties[0].id === 'party-existing', 'Original party ID preserved')
    assert(matchingParties[0].outstandingBalance === 25000 + 50000, 'Original party balance incremented')
  })

  // Test 8: Shell openBooks IPC handler
  await test('openBooks IPC channel triggers callback and returns true/false', async () => {
    let triggered = false
    crm.configureCrmRuntime({ onOpenBooks: () => { triggered = true } })

    const res1 = await openBooksHandler({})
    assert(res1 === true, 'openBooks returns true when runtime callback configured')
    assert(triggered === true, 'onOpenBooks callback invoked')

    // Reset without callback
    crm.configureCrmRuntime({ onOpenBooks: undefined })
    const res2 = await openBooksHandler({})
    assert(res2 === false, 'openBooks returns false when runtime callback is undefined')
  })

  console.log('\n----------------------------------------------------------------------')
  console.log(`Results: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  console.log('----------------------------------------------------------------------\n')

  try {
    rmSync(sandboxDir, { recursive: true, force: true })
  } catch {}

  if (failedTests > 0) {
    console.error('FAILURES:')
    failureDetails.forEach((f) => console.error(` - ${f.name}: ${f.error}`))
    process.exit(1)
  }
}

runAll().catch((err) => {
  console.error('Fatal execution error:', err)
  process.exit(1)
})

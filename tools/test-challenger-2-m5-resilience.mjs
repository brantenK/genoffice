#!/usr/bin/env node
/**
 * tools/test-challenger-2-m5-resilience.mjs
 *
 * Challenger 2 Milestone 5 Phase 2 Dedicated Stress & Concurrency Resilience Test Harness:
 * Focuses on high-volume, interleaved, and adversarial failure modes across Zanostack CRM,
 * Zanostack Tenders, and Zano Books.
 *
 * Test Suites:
 * - Suite A: Concurrent & Interleaved CRM Invoicing with Fractional Cents (A1 - A5)
 * - Suite B: Interleaved Billing of Multiple Tender Milestones Across Different Tenders (B1 - B5)
 * - Suite C: Multi-Batch Bank Statement Import with Overlapping, Duplicate, and Varied Formats (C1 - C5)
 * - Suite D: Stress Reconciliation Under Rapid-Fire Execution (D1 - D5)
 * - Suite E: Corrupted File Recovery & Safe Re-Seeding (E1 - E5)
 * - Suite F: Store Round-Trip Resilience & Extension Field Preservation (F1 - F5)
 *
 * Execution: node tools/test-challenger-2-m5-resilience.mjs
 * Exits with code 0 on all passes, code 1 on failure.
 */

import assert from 'node:assert'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ============================================================================
// 1. ISOLATED TEST SANDBOX & ELECTRON MOCK INFRASTRUCTURE
// ============================================================================

const sandboxRoot = join(tmpdir(), `zanostack-c2-m5-${randomUUID().slice(0, 8)}`)
const crmDir = join(sandboxRoot, 'crm')
const tendersDir = join(sandboxRoot, 'tenders')
const booksDir = join(sandboxRoot, 'books')

mkdirSync(crmDir, { recursive: true })
mkdirSync(tendersDir, { recursive: true })
mkdirSync(booksDir, { recursive: true })

const crmDealsPath = join(crmDir, 'deals.json')
const tendersDataPath = join(tendersDir, 'tenders-data.json')
const booksDataPath = join(booksDir, 'books-data.json')

const ipcHandlers = new Map()

// Install Electron Mock in require.cache before requiring compiled app modules
require.cache[require.resolve('electron')] = {
  exports: {
    app: {
      getPath: (name) => {
        if (name === 'userData') return sandboxRoot
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

// Import compiled production modules
const crm = require('../apps/crm/out/main/index.js')
const tenders = require('../apps/tenders/out/main/index.js')
const books = require('../apps/books/out/main/index.js')

// Track shell tab activation callbacks
let lastCrmTabOpened = null
let lastTendersTabOpened = null

crm.configureCrmRuntime({
  preloadPath: '',
  rendererFile: '',
  onOpenBooks: () => {
    lastCrmTabOpened = 'books'
  },
})

tenders.configureTendersRuntime({
  preloadPath: '',
  rendererFile: '',
  onOpenBooks: (invId) => {
    lastTendersTabOpened = invId || 'books'
  },
})

// Register IPC handlers
crm.registerCrmIpc()
tenders.registerTendersIpc()
books.registerBooksIpc()

// ============================================================================
// 2. TEST HARNESS FRAMEWORK & REPORTING
// ============================================================================

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures = []
const suiteStats = {}

function recordSuiteStat(suiteLetter, passed) {
  if (!suiteStats[suiteLetter]) {
    suiteStats[suiteLetter] = { passed: 0, failed: 0 }
  }
  if (passed) {
    suiteStats[suiteLetter].passed++
  } else {
    suiteStats[suiteLetter].failed++
  }
}

async function runTest(suiteLetter, id, name, fn) {
  totalTests++
  const tStart = Date.now()
  try {
    await fn()
    passedTests++
    recordSuiteStat(suiteLetter, true)
    console.log(`  ✅ [${id}] ${name} (${Date.now() - tStart}ms)`)
  } catch (err) {
    failedTests++
    recordSuiteStat(suiteLetter, false)
    const errText = err?.stack || err?.message || String(err)
    failures.push({ id, name, error: errText })
    console.error(`  ❌ [${id}] ${name} (${Date.now() - tStart}ms)`)
    console.error(`     Error: ${err?.message || err}`)
  }
}

// Seed Helpers
function createInitialBooksEnvelope() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: {
      companyName: 'Zano Consulting & Engineering (Pty) Ltd',
      taxNumber: '4920198273',
      currency: 'ZAR',
      currencySymbol: 'R',
      financialYearStart: '2026-03-01',
      address: '14 Commerce Square, Sandton, Johannesburg, 2196',
      email: 'accounts@zanostack.tech',
      phone: '+27 11 555 0192',
    },
    accounts: [
      { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: 500000 },
      { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', parentId: 'acc-curr-asset', isGroup: false, balance: 200000 },
      { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', parentId: 'acc-curr-liab', isGroup: false, balance: 80000 },
      { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 850000 },
      { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 40000 },
    ],
    parties: [
      { id: 'party-init-1', name: 'Apex Valve Supplies (Pty) Ltd', type: 'Supplier', email: 'orders@apexvalve.co.za', outstandingBalance: 45000 },
    ],
    invoices: [
      {
        id: 'bill-init-1',
        invoiceNumber: 'BILL-2026-001',
        type: 'Purchase',
        partyId: 'party-init-1',
        partyName: 'Apex Valve Supplies (Pty) Ltd',
        date: '2026-08-20',
        dueDate: '2026-09-20',
        items: [
          { id: 'item-b1', itemCode: 'VALVE-KIT', description: '300mm Valve Replacement Seals', accountId: 'acc-ap', accountName: 'Accounts Payable', qty: 1, rate: 39130.43, taxRate: 15, amount: 39130.43 },
        ],
        subtotal: 39130.43,
        taxTotal: 5869.57,
        grandTotal: 45000,
        outstandingAmount: 45000,
        status: 'Unpaid',
        notes: 'Pre-ordered parts',
        createdAt: '2026-08-20T10:00:00Z',
        updatedAt: '2026-08-20T10:00:00Z',
      },
    ],
    journalEntries: [],
    bankTransactions: [],
  }
}

function writeFreshBooksStore(overrides = {}) {
  const data = { ...createInitialBooksEnvelope(), ...overrides }
  books.writeBooksStore(booksDataPath, data)
  return data
}

function createInitialTendersEnvelope() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeCompanyId: 'comp-zano-01',
    workspaces: [
      {
        id: 'ws-water-01',
        name: 'Municipal Water Projects',
        tenders: [
          {
            id: 'tender-wtr-04',
            title: 'Bulk Water Metering & Valve Refurbishment',
            referenceNumber: 'RFP-WTR-2026-04',
            issuingBody: 'City of Ekurhuleni Water Dept',
            status: 'ACTIVE',
            milestones: [
              {
                id: 'ms-wtr-01',
                title: 'Phase 1 Reservoir Valve Refurbishment',
                name: 'Phase 1 Reservoir Valve Refurbishment',
                description: 'Complete overhaul of high-pressure control valves',
                amount: 145000,
                status: 'REACHED',
                dueDate: '2026-08-30',
              },
              {
                id: 'ms-wtr-02',
                title: 'Phase 2 Flow Meter Sensors',
                name: 'Phase 2 Flow Meter Sensors',
                description: 'Digital telemetry installation',
                amount: 98000.50,
                status: 'PENDING',
                dueDate: '2026-11-15',
              },
            ],
          },
        ],
      },
      {
        id: 'ws-grid-02',
        name: 'Electrical Grid Infrastructure',
        tenders: [
          {
            id: 'tender-elc-09',
            title: 'Substation Transformer Modernization',
            referenceNumber: 'RFP-ELC-2026-09',
            issuingBody: 'Eskom Transmission SOC',
            status: 'ACTIVE',
            milestones: [
              {
                id: 'ms-elc-01',
                title: 'Phase 1 Primary Transformer Delivery & Rigging',
                name: 'Phase 1 Primary Transformer Delivery & Rigging',
                description: '400kV Transformer positioning and foundation sign-off',
                amount: 250000.75,
                status: 'REACHED',
                dueDate: '2026-09-15',
              },
              {
                id: 'ms-elc-02',
                title: 'Phase 2 High-Voltage Switchgear Commissioning',
                name: 'Phase 2 High-Voltage Switchgear Commissioning',
                description: 'SF6 gas insulated switchgear testing',
                amount: 180000.25,
                status: 'REACHED',
                dueDate: '2026-10-30',
              },
            ],
          },
        ],
      },
      {
        id: 'ws-health-03',
        name: 'Healthcare Infrastructure Hub',
        tenders: [
          {
            id: 'tender-hlt-12',
            title: 'Regional Hospital HVAC Filtration & Clean Rooms',
            referenceNumber: 'RFP-HLT-2026-12',
            issuingBody: 'Gauteng Health Dept',
            status: 'ACTIVE',
            milestones: [
              {
                id: 'ms-hlt-01',
                title: 'Phase 1 HEPA Air Filtration Ducting',
                name: 'Phase 1 HEPA Air Filtration Ducting',
                description: 'Negative pressure ventilation across surgical theaters',
                amount: 320000.50,
                status: 'REACHED',
                dueDate: '2026-09-30',
              },
            ],
          },
        ],
      },
    ],
    issuerTemplates: [],
  }
}

function writeFreshTendersStore(overrides = {}) {
  const data = { ...createInitialTendersEnvelope(), ...overrides }
  tenders.writeTendersStore(tendersDataPath, data)
  return data
}

// ============================================================================
// 3. SUITE A: CONCURRENT & INTERLEAVED CRM INVOICING WITH FRACTIONAL CENTS
// ============================================================================

console.log('\n======================================================================')
console.log('   SUITE A: CONCURRENT & INTERLEAVED CRM INVOICING (FRACTIONAL CENTS)')
console.log('======================================================================')

await runTest('A', 'A1', 'Concurrent/interleaved invoicing of 10 won CRM deals with fractional cents', async () => {
  writeFreshBooksStore()

  // 10 won deals with realistic non-trivial fractional cent amounts
  const fractionalDeals = [
    { id: 'deal-won-01', name: 'Cloud Migration Phase 1', companyName: 'Helios Clean Energy', amount: 12345.67, stage: 'won', probability: 100 },
    { id: 'deal-won-02', name: 'Enterprise Security Audit', companyName: 'Vanguard Cyber Tech', amount: 98765.43, stage: 'won', probability: 100 },
    { id: 'deal-won-03', name: 'IoT Telemetry Gateway', companyName: 'Urban Grid Solutions', amount: 50000.01, stage: 'won', probability: 100 },
    { id: 'deal-won-04', name: 'Biometric Access Control', companyName: 'SecureCore Ltd', amount: 10000.99, stage: 'won', probability: 100 },
    { id: 'deal-won-05', name: 'Supply Chain Analytics', companyName: 'Apex Logistics Inc', amount: 75432.18, stage: 'won', probability: 100 },
    { id: 'deal-won-06', name: 'Edge AI Video Pipeline', companyName: 'Visionary Dynamics', amount: 120555.55, stage: 'won', probability: 100 },
    { id: 'deal-won-07', name: 'Core Banking ERP Connector', companyName: 'First Meridian Bank', amount: 33333.33, stage: 'won', probability: 100 },
    { id: 'deal-won-08', name: 'Fleet Telematics Platform', companyName: 'CargoTrack Pty', amount: 88888.88, stage: 'won', probability: 100 },
    { id: 'deal-won-09', name: 'Smart Metering Gateway', companyName: 'OmniPower SA', amount: 14285.71, stage: 'won', probability: 100 },
    { id: 'deal-won-10', name: 'Data Lake Modernization', companyName: 'Synthetix Data', amount: 9999.95, stage: 'won', probability: 100 },
  ]

  crm.writeDealsStore(crmDealsPath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    deals: fractionalDeals,
  })

  const initialBooks = books.readBooksStore(booksDataPath)
  const initialAr = initialBooks.accounts.find((a) => a.id === 'acc-ar').balance
  const initialSales = initialBooks.accounts.find((a) => a.id === 'acc-sales').balance
  const initialVat = initialBooks.accounts.find((a) => a.id === 'acc-vat').balance

  const createInvoiceHandler = ipcHandlers.get('crm:create-invoice-in-books')
  assert(typeof createInvoiceHandler === 'function', 'crm:create-invoice-in-books handler must be registered')

  // Execute interleaved invoicing across all 10 deals
  const invoiceResults = []
  for (const d of fractionalDeals) {
    lastCrmTabOpened = null
    const res = await createInvoiceHandler({}, d.id)
    assert(res.ok, `Invoicing deal ${d.id} failed: ${res.error}`)
    assert(res.invoiceId, `Deal ${d.id} missing invoiceId`)
    assert(res.invoiceNumber, `Deal ${d.id} missing invoiceNumber`)
    assert.strictEqual(lastCrmTabOpened, 'books', `Shell onOpenBooks callback must fire for deal ${d.id}`)
    invoiceResults.push(res)
  }

  // Verify CRM deals store back-references
  const updatedDealsStore = crm.readDealsStore(crmDealsPath)
  for (let i = 0; i < fractionalDeals.length; i++) {
    const original = fractionalDeals[i]
    const updated = updatedDealsStore.deals.find((d) => d.id === original.id)
    assert(updated, `Deal ${original.id} must be retained in store`)
    assert.strictEqual(updated.invoiceId, invoiceResults[i].invoiceId, `Deal ${original.id} invoiceId mismatch`)
    assert.strictEqual(updated.invoiceNumber, invoiceResults[i].invoiceNumber, `Deal ${original.id} invoiceNumber mismatch`)
    assert(typeof updated.invoicedAt === 'string', `Deal ${original.id} must have invoicedAt timestamp`)
  }

  // Verify Books store state & accounting invariants
  const updatedBooks = books.readBooksStore(booksDataPath)
  assert.strictEqual(updatedBooks.invoices.length, fractionalDeals.length + 1, 'Books must contain 10 new sales invoices + 1 initial bill')

  let expectedTotalGrand = 0
  let expectedTotalSubtotal = 0
  let expectedTotalTax = 0

  for (const d of fractionalDeals) {
    const inv = updatedBooks.invoices.find((i) => i.crmDealId === d.id)
    assert(inv, `Sales invoice for deal ${d.id} must exist in Books`)
    assert.strictEqual(inv.type, 'Sales')
    assert.strictEqual(inv.status, 'Unpaid')
    assert.strictEqual(inv.grandTotal, d.amount, `grandTotal for ${d.id} must equal deal amount`)

    // Critical fractional cent invariant: subtotal + taxTotal === grandTotal
    const sumCents = Math.round((inv.subtotal + inv.taxTotal) * 100) / 100
    assert.strictEqual(sumCents, inv.grandTotal, `Fractional cents split must balance: ${inv.subtotal} + ${inv.taxTotal} = ${sumCents} != ${inv.grandTotal}`)

    expectedTotalGrand += inv.grandTotal
    expectedTotalSubtotal += inv.subtotal
    expectedTotalTax += inv.taxTotal

    // Corresponding Journal Entry verification
    const je = updatedBooks.journalEntries.find((j) => j.remarks.includes(inv.invoiceNumber))
    assert(je, `Journal entry for invoice ${inv.invoiceNumber} must exist`)
    assert.strictEqual(je.totalDebit, inv.grandTotal, `JE debit must equal grandTotal`)
    assert.strictEqual(je.totalCredit, inv.grandTotal, `JE credit must equal grandTotal`)
  }

  // Verify Chart of Accounts ledger continuity
  const updatedAr = updatedBooks.accounts.find((a) => a.id === 'acc-ar').balance
  const updatedSales = updatedBooks.accounts.find((a) => a.id === 'acc-sales').balance
  const updatedVat = updatedBooks.accounts.find((a) => a.id === 'acc-vat').balance

  const expectedAr = Math.round((initialAr + expectedTotalGrand) * 100) / 100
  const expectedSales = Math.round((initialSales + expectedTotalSubtotal) * 100) / 100
  const expectedVat = Math.round((initialVat + expectedTotalTax) * 100) / 100

  assert.strictEqual(updatedAr, expectedAr, `acc-ar balance expected ${expectedAr}, got ${updatedAr}`)
  assert.strictEqual(updatedSales, expectedSales, `acc-sales balance expected ${expectedSales}, got ${updatedSales}`)
  assert.strictEqual(updatedVat, expectedVat, `acc-vat balance expected ${expectedVat}, got ${updatedVat}`)
})

await runTest('A', 'A2', 'Idempotency & duplicate prevention across all 10 invoiced deals', async () => {
  const dealsStore = crm.readDealsStore(crmDealsPath)
  const booksBefore = books.readBooksStore(booksDataPath)
  const invoiceCountBefore = booksBefore.invoices.length

  const createInvoiceHandler = ipcHandlers.get('crm:create-invoice-in-books')

  // Attempt to re-invoice every deal
  for (const d of dealsStore.deals) {
    const res = await createInvoiceHandler({}, d.id)
    assert(res.ok, `Re-invoicing ${d.id} must return ok: true`)
    assert.strictEqual(res.invoiceId, d.invoiceId, `Must return existing invoiceId`)
    assert.strictEqual(res.invoiceNumber, d.invoiceNumber, `Must return existing invoiceNumber`)
  }

  const booksAfter = books.readBooksStore(booksDataPath)
  assert.strictEqual(booksAfter.invoices.length, invoiceCountBefore, 'Invoice count must not increase upon re-invoicing')
})

await runTest('A', 'A3', 'Interleaved non-won and won deal eligibility stress', async () => {
  const testDeals = [
    { id: 'deal-lead-01', name: 'Lead Opportunity', amount: 45000, stage: 'lead', probability: 20 },
    { id: 'deal-qual-02', name: 'Qualified Lead', amount: 65000, stage: 'qualified', probability: 40 },
    { id: 'deal-prop-03', name: 'Proposal Sent', amount: 85000, stage: 'proposal', probability: 60 },
    { id: 'deal-nego-04', name: 'In Negotiation', amount: 110000, stage: 'negotiation', probability: 80 },
    { id: 'deal-lost-05', name: 'Lost Deal', amount: 30000, stage: 'lost', probability: 0 },
    { id: 'deal-won-valid', name: 'Valid Won Deal', amount: 95000.50, stage: 'won', probability: 100 },
  ]

  crm.writeDealsStore(crmDealsPath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    deals: testDeals,
  })

  const createInvoiceHandler = ipcHandlers.get('crm:create-invoice-in-books')

  // Verify non-won stages are rejected
  for (const d of testDeals.filter((x) => x.stage !== 'won')) {
    const res = await createInvoiceHandler({}, d.id)
    assert(!res.ok, `Deal in stage ${d.stage} must be rejected`)
    assert(res.error.includes('not won'), `Error must state deal is not won: ${res.error}`)
  }

  // Verify won deal succeeds
  const wonRes = await createInvoiceHandler({}, 'deal-won-valid')
  assert(wonRes.ok, `Won deal must be invoiced successfully: ${wonRes.error}`)
  assert(wonRes.invoiceId, 'Won deal must produce invoiceId')
})

await runTest('A', 'A4', 'Extreme fractional cents precision boundaries (0.01, 115000.55, 99999999.99)', async () => {
  const extremeDeals = [
    { id: 'deal-penny', name: 'One Cent Consultation', amount: 0.01, stage: 'won' },
    { id: 'deal-split', name: 'Fractional VAT Split Test', amount: 115000.55, stage: 'won' },
    { id: 'deal-enterprise', name: 'Massive Commercial Expansion', amount: 99999999.99, stage: 'won' },
  ]

  crm.writeDealsStore(crmDealsPath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    deals: extremeDeals,
  })

  const createInvoiceHandler = ipcHandlers.get('crm:create-invoice-in-books')

  for (const d of extremeDeals) {
    const res = await createInvoiceHandler({}, d.id)
    assert(res.ok, `Invoicing extreme deal ${d.id} failed: ${res.error}`)

    const b = books.readBooksStore(booksDataPath)
    const inv = b.invoices.find((i) => i.crmDealId === d.id)
    assert(inv, `Invoice for ${d.id} must exist`)
    assert.strictEqual(inv.grandTotal, d.amount)
    const sum = Math.round((inv.subtotal + inv.taxTotal) * 100) / 100
    assert.strictEqual(sum, d.amount, `Subtotal (${inv.subtotal}) + Tax (${inv.taxTotal}) must equal grandTotal (${d.amount})`)
  }
})

await runTest('A', 'A5', 'Deal counterparty mapping with special characters and missing companyName', async () => {
  const dealsWithOddNames = [
    { id: 'deal-no-comp', name: 'Direct Deal Without Company', amount: 42000, stage: 'won' },
    { id: 'deal-special-char', name: 'Special Counterparty Deal', companyName: 'O\'Connor & Sons (Pty) Ltd // High-Tech & Co.', amount: 55000, stage: 'won' },
  ]

  crm.writeDealsStore(crmDealsPath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    deals: dealsWithOddNames,
  })

  const createInvoiceHandler = ipcHandlers.get('crm:create-invoice-in-books')

  for (const d of dealsWithOddNames) {
    const res = await createInvoiceHandler({}, d.id)
    assert(res.ok, `Failed to invoice ${d.id}: ${res.error}`)

    const b = books.readBooksStore(booksDataPath)
    const inv = b.invoices.find((i) => i.crmDealId === d.id)
    assert(inv, `Invoice for ${d.id} must exist`)

    const party = b.parties.find((p) => p.id === inv.partyId)
    assert(party, `Party for invoice ${inv.invoiceNumber} must exist`)
    assert(party.name.length > 0, 'Party name must not be empty')
    assert(party.outstandingBalance >= inv.grandTotal, 'Party outstandingBalance must be updated')
  }
})

// ============================================================================
// 4. SUITE B: INTERLEAVED BILLING OF MULTIPLE TENDER MILESTONES
// ============================================================================

console.log('\n======================================================================')
console.log('   SUITE B: INTERLEAVED MULTI-TENDER MILESTONE BILLING')
console.log('======================================================================')

await runTest('B', 'B1', 'Multi-tender interleaved milestone billing across 3 distinct tenders', async () => {
  writeFreshBooksStore()
  writeFreshTendersStore()

  const billMilestoneHandler = ipcHandlers.get('tenders:bill-milestone-in-books')
  assert(typeof billMilestoneHandler === 'function', 'tenders:bill-milestone-in-books handler must be registered')

  // Interleaved billing queue across tenders
  const billingSequence = [
    { tenderId: 'tender-wtr-04', milestoneId: 'ms-wtr-01', ref: 'RFP-WTR-2026-04', expectedAmount: 145000 },
    { tenderId: 'tender-elc-09', milestoneId: 'ms-elc-01', ref: 'RFP-ELC-2026-09', expectedAmount: 250000.75 },
    { tenderId: 'tender-hlt-12', milestoneId: 'ms-hlt-01', ref: 'RFP-HLT-2026-12', expectedAmount: 320000.50 },
    { tenderId: 'tender-elc-09', milestoneId: 'ms-elc-02', ref: 'RFP-ELC-2026-09', expectedAmount: 180000.25 },
  ]

  const billedResults = []
  for (const item of billingSequence) {
    lastTendersTabOpened = null
    const res = await billMilestoneHandler({}, {
      tenderId: item.tenderId,
      milestoneId: item.milestoneId,
    })
    assert(res.ok, `Billing milestone ${item.milestoneId} failed: ${res.error}`)
    assert(res.invoiceId, 'Must return invoiceId')
    assert(res.invoiceNumber, 'Must return invoiceNumber')
    assert.strictEqual(lastTendersTabOpened, res.invoiceId, 'Shell onOpenBooks callback must fire with invoiceId')
    billedResults.push(res)
  }

  // Verify milestones in tenders store transitioned to BILLED
  const updatedTenders = tenders.readTendersStore(tendersDataPath)
  for (const item of billingSequence) {
    let milestone = null
    for (const ws of updatedTenders.workspaces) {
      for (const t of ws.tenders || []) {
        if (t.id === item.tenderId) {
          milestone = t.milestones.find((m) => m.id === item.milestoneId)
        }
      }
    }
    assert(milestone, `Milestone ${item.milestoneId} must exist`)
    assert.strictEqual(milestone.status, 'BILLED', `Milestone ${item.milestoneId} status must be BILLED`)
    assert(milestone.billedInvoiceId, `Milestone ${item.milestoneId} must record billedInvoiceId`)
    assert(milestone.billedInvoiceNumber, `Milestone ${item.milestoneId} must record billedInvoiceNumber`)
  }

  // Verify Sales Tax Invoices created in Books
  const updatedBooks = books.readBooksStore(booksDataPath)
  for (let i = 0; i < billingSequence.length; i++) {
    const item = billingSequence[i]
    const res = billedResults[i]
    const inv = updatedBooks.invoices.find((inv) => inv.id === res.invoiceId)
    assert(inv, `Books tax invoice ${res.invoiceId} must exist`)
    assert.strictEqual(inv.tenderReference, item.ref, `tenderReference must match ${item.ref}`)
    assert.strictEqual(inv.grandTotal, item.expectedAmount, `grandTotal must match milestone amount`)
    const sumCents = Math.round((inv.subtotal + inv.taxTotal) * 100) / 100
    assert.strictEqual(sumCents, item.expectedAmount, 'Subtotal + VAT must equal grandTotal')
  }
})

await runTest('B', 'B2', 'Milestone lifecycle progression: PENDING rejected -> REACHED -> BILLED', async () => {
  const billMilestoneHandler = ipcHandlers.get('tenders:bill-milestone-in-books')

  // ms-wtr-02 is currently PENDING in tender-wtr-04
  const rejectRes = await billMilestoneHandler({}, {
    tenderId: 'tender-wtr-04',
    milestoneId: 'ms-wtr-02',
  })
  assert(!rejectRes.ok, 'Milestone in PENDING status must be rejected for billing')
  assert(rejectRes.error.includes('REACHED'), 'Error must specify REACHED status requirement')

  // Transition to REACHED
  const tData = tenders.readTendersStore(tendersDataPath)
  const tender = tData.workspaces[0].tenders.find((t) => t.id === 'tender-wtr-04')
  const m2 = tender.milestones.find((m) => m.id === 'ms-wtr-02')
  m2.status = 'REACHED'
  tenders.writeTendersStore(tendersDataPath, tData)

  // Bill now
  const successRes = await billMilestoneHandler({}, {
    tenderId: 'tender-wtr-04',
    milestoneId: 'ms-wtr-02',
  })
  assert(successRes.ok, `Billing reached milestone failed: ${successRes.error}`)
  assert(successRes.invoiceId, 'Must generate invoiceId')
})

await runTest('B', 'B3', 'Multi-tender billing idempotency guard (re-billing BILLED rejected)', async () => {
  const billMilestoneHandler = ipcHandlers.get('tenders:bill-milestone-in-books')

  const alreadyBilled = [
    { tenderId: 'tender-wtr-04', milestoneId: 'ms-wtr-01' },
    { tenderId: 'tender-elc-09', milestoneId: 'ms-elc-01' },
    { tenderId: 'tender-hlt-12', milestoneId: 'ms-hlt-01' },
  ]

  for (const item of alreadyBilled) {
    const res = await billMilestoneHandler({}, item)
    assert(!res.ok, `Re-billing milestone ${item.milestoneId} must be rejected`)
    assert(res.error.toLowerCase().includes('already billed'), `Error must mention already billed: ${res.error}`)
  }
})

await runTest('B', 'B4', 'Issuing authority party mapping & separate balance segregation', async () => {
  const updatedBooks = books.readBooksStore(booksDataPath)
  const ekurhuleni = updatedBooks.parties.find((p) => p.name.includes('Ekurhuleni'))
  const eskom = updatedBooks.parties.find((p) => p.name.includes('Eskom'))
  const gauteng = updatedBooks.parties.find((p) => p.name.includes('Gauteng'))

  assert(ekurhuleni, 'City of Ekurhuleni party must exist')
  assert(eskom, 'Eskom Transmission party must exist')
  assert(gauteng, 'Gauteng Health party must exist')

  assert(ekurhuleni.outstandingBalance > 0, 'Ekurhuleni must have outstandingBalance')
  assert(eskom.outstandingBalance > 0, 'Eskom must have outstandingBalance')
  assert(gauteng.outstandingBalance > 0, 'Gauteng Health must have outstandingBalance')
})

await runTest('B', 'B5', 'Boundary validation: zero progress amount and invalid milestone ID rejection', async () => {
  const billMilestoneHandler = ipcHandlers.get('tenders:bill-milestone-in-books')

  // Non-existent milestone ID
  const invalidRes = await billMilestoneHandler({}, {
    tenderId: 'tender-wtr-04',
    milestoneId: 'ms-does-not-exist',
  })
  assert(!invalidRes.ok, 'Non-existent milestone ID must be rejected')
  assert(invalidRes.error.includes('Milestone not found'), `Unexpected error: ${invalidRes.error}`)

  // Non-existent tender ID
  const invalidTender = await billMilestoneHandler({}, {
    tenderId: 'tender-ghost',
    milestoneId: 'ms-wtr-01',
  })
  assert(!invalidTender.ok, 'Non-existent tender ID must be rejected')
  assert(invalidTender.error.includes('Tender not found'), `Unexpected error: ${invalidTender.error}`)
})

// ============================================================================
// 5. SUITE C: MULTI-BATCH BANK STATEMENT IMPORT WITH OVERLAPPING & VARIED FORMATS
// ============================================================================

console.log('\n======================================================================')
console.log('   SUITE C: MULTI-BATCH BANK STATEMENT CSV RECONCILIATION')
console.log('======================================================================')

await runTest('C', 'C1', 'Batch 1: Standard bank statement CSV ingestion into acc-bank', async () => {
  writeFreshBooksStore()

  const batch1Csv = `Date,Description,Reference,Amount
2026-08-25,Customer Deposit - Helios Clean Energy,INV-2026-001,85000.00
2026-08-26,Ekurhuleni Water Tender Progress,RFP-WTR-2026-04,145000.00
2026-08-27,Supplier Payment - Apex Valve Supplies,BILL-2026-001,-45000.00
2026-08-28,Office Rental Sandton CBD,RENT-AUG26,-32500.00
2026-08-29,Municipal Electricity & Utilities,COJ-UTIL-991,-8450.50
2026-08-30,Vanguard Cyber Tech Commercial Settlement,INV-2026-002,98765.43
`
  const importHandler = ipcHandlers.get('books:import-bank-statement-csv')
  const res = await importHandler({}, batch1Csv)

  assert(res.ok, `Batch 1 import failed: ${res.error}`)
  assert.strictEqual(res.importedCount, 6, 'Batch 1 must import all 6 transactions')
  assert.strictEqual(res.skippedDuplicates, 0, 'Batch 1 must have 0 skipped duplicates')

  const expectedNet = 85000 + 145000 - 45000 - 32500 - 8450.50 + 98765.43
  assert.strictEqual(res.netAdjustment, Math.round(expectedNet * 100) / 100, 'netAdjustment mismatch')

  const booksState = books.readBooksStore(booksDataPath)
  const bankAcc = booksState.accounts.find((a) => a.id === 'acc-bank')
  assert.strictEqual(bankAcc.balance, Math.round((500000 + expectedNet) * 100) / 100, 'Bank account ledger balance must match')
})

await runTest('C', 'C2', 'Batch 2: Overlapping transactions, duplicate detection, and varied formats', async () => {
  // Overlaps 3 from Batch 1, introduces 4 new ones with Debit/Credit columns and currency symbols
  const batch2Csv = `Date,Description,Reference,Debit,Credit
2026-08-25,Customer Deposit - Helios Clean Energy,INV-2026-001,,85000.00
2026-08-26,Ekurhuleni Water Tender Progress,RFP-WTR-2026-04,,145000.00
2026-08-27,Supplier Payment - Apex Valve Supplies,BILL-2026-001,45000.00,
2026-08-31,Urban Grid Solutions Telemetry Deposit,INV-2026-003,,"R 50,000.01"
2026-09-01,SecureCore Access Control Payment,INV-2026-004,,"R 10,000.99"
2026-09-02,Cloud Server Infrastructure Hosting,AWS-ZAR-771,"R 15,200.00",
2026-09-03,Eskom Transmission Substation Progress,RFP-ELC-2026-09,,"R 250,000.75"
`
  const importHandler = ipcHandlers.get('books:import-bank-statement-csv')
  const res = await importHandler({}, batch2Csv)

  assert(res.ok, `Batch 2 import failed: ${res.error}`)
  assert.strictEqual(res.skippedDuplicates, 3, 'Batch 2 must identify 3 duplicate transactions from Batch 1')
  assert.strictEqual(res.importedCount, 4, 'Batch 2 must import exactly 4 new transactions')

  const expectedNewNet = 50000.01 + 10000.99 - 15200.00 + 250000.75
  assert.strictEqual(res.netAdjustment, Math.round(expectedNewNet * 100) / 100, 'Batch 2 netAdjustment mismatch')

  const booksState = books.readBooksStore(booksDataPath)
  assert.strictEqual(booksState.bankTransactions.length, 10, 'Total transactions in store must equal 10')
})

await runTest('C', 'C3', 'Batch 3: Completely duplicate batch with trailing commas and empty rows', async () => {
  const booksBefore = books.readBooksStore(booksDataPath)
  const bankBalanceBefore = booksBefore.accounts.find((a) => a.id === 'acc-bank').balance

  const duplicateCsv = `Date,Description,Reference,Amount
2026-08-25,Customer Deposit - Helios Clean Energy,INV-2026-001,85000.00
2026-08-26,Ekurhuleni Water Tender Progress,RFP-WTR-2026-04,145000.00
2026-08-27,Supplier Payment - Apex Valve Supplies,BILL-2026-001,-45000.00
,,

,,,
`
  const importHandler = ipcHandlers.get('books:import-bank-statement-csv')
  const res = await importHandler({}, duplicateCsv)

  assert(res.ok, `Duplicate batch import failed: ${res.error}`)
  assert.strictEqual(res.importedCount, 0, 'Zero new transactions should be imported')
  assert.strictEqual(res.skippedDuplicates, 3, 'All 3 rows should be recognized as duplicates')
  assert.strictEqual(res.netAdjustment, 0, 'Net adjustment must be exactly 0')

  const booksAfter = books.readBooksStore(booksDataPath)
  const bankBalanceAfter = booksAfter.accounts.find((a) => a.id === 'acc-bank').balance
  assert.strictEqual(bankBalanceAfter, bankBalanceBefore, 'Bank balance must not drift on duplicate import')
})

await runTest('C', 'C4', 'Malformed CSV resilience (empty file, invalid headers, non-numeric rows)', async () => {
  const importHandler = ipcHandlers.get('books:import-bank-statement-csv')

  // Empty string
  const resEmpty = await importHandler({}, '')
  assert(!resEmpty.ok, 'Empty CSV must be rejected')

  // Only header line
  const resHeaderOnly = await importHandler({}, 'Date,Description,Reference,Amount\n')
  assert(!resHeaderOnly.ok, 'Header-only CSV must be rejected')

  // No valid rows
  const resNoValid = await importHandler({}, 'Date,Description,Reference,Amount\n2026-08-25,Bad Row,REF,NOT_A_NUMBER\n')
  assert(!resNoValid.ok, 'CSV with only invalid rows must be rejected')
})

await runTest('C', 'C5', 'Exotic currency syntax parsing (parentheses, $, spaces, quotes, commas)', async () => {
  const exoticCsv = `Date,Description,Reference,Amount
2026-09-01,Test Dollar Amount,REF1,"$ 12,345.67"
2026-09-02,Test Negative Parenthesis,REF2,"(45,000.50)"
2026-09-03,Test Rand Space Format,REF3,"R 120 555.55"
2026-09-04,Test Parenthesized Rand,REF4,"(R 14,285.71)"
`
  const parsed = books.parseBankStatementCsv(exoticCsv)
  assert.strictEqual(parsed.length, 4, 'Must parse all 4 exotic rows')
  assert.strictEqual(parsed[0].amount, 12345.67, 'Dollar parsing mismatch')
  assert.strictEqual(parsed[1].amount, -45000.50, 'Parenthesis negative parsing mismatch')
  assert.strictEqual(parsed[2].amount, 120555.55, 'Space thousand separator mismatch')
  assert.strictEqual(parsed[3].amount, -14285.71, 'Parenthesized Rand mismatch')
})

// ============================================================================
// 6. SUITE D: STRESS RECONCILIATION UNDER RAPID-FIRE EXECUTION
// ============================================================================

console.log('\n======================================================================')
console.log('   SUITE D: RAPID-FIRE STRESS RECONCILIATION')
console.log('======================================================================')

await runTest('D', 'D1', 'Settlement suggestion engine matching accuracy under high volume', async () => {
  // Populate books with matching invoices and transactions
  const booksState = writeFreshBooksStore({
    invoices: [
      {
        id: 'inv-s1',
        invoiceNumber: 'INV-2026-101',
        type: 'Sales',
        partyName: 'Helios Clean Energy',
        grandTotal: 85000,
        outstandingAmount: 85000,
        status: 'Unpaid',
      },
      {
        id: 'inv-s2',
        invoiceNumber: 'INV-2026-102',
        type: 'Sales',
        partyName: 'City of Ekurhuleni Water Dept',
        tenderReference: 'RFP-WTR-2026-04',
        grandTotal: 145000,
        outstandingAmount: 145000,
        status: 'Unpaid',
      },
      {
        id: 'inv-p1',
        invoiceNumber: 'BILL-2026-201',
        type: 'Purchase',
        partyName: 'Apex Valve Supplies (Pty) Ltd',
        grandTotal: 45000,
        outstandingAmount: 45000,
        status: 'Unpaid',
      },
    ],
    bankTransactions: [
      { id: 'tx-1', accountId: 'acc-bank', date: '2026-08-25', description: 'Deposit Helios Clean Energy', reference: 'INV-2026-101', amount: 85000, reconciled: false },
      { id: 'tx-2', accountId: 'acc-bank', date: '2026-08-26', description: 'Progress claim per RFP-WTR-2026-04', reference: '', amount: 145000, reconciled: false },
      { id: 'tx-3', accountId: 'acc-bank', date: '2026-08-27', description: 'Payment Apex Valve Supplies', reference: 'BILL-2026-201', amount: -45000, reconciled: false },
    ],
  })

  const suggestions = books.computeSettlementSuggestions(booksState)
  assert.strictEqual(suggestions.length, 3, 'Must find suggestions for all 3 transactions')

  const sug1 = suggestions.find((s) => s.transactionId === 'tx-1')
  assert.strictEqual(sug1.invoiceId, 'inv-s1')
  assert.strictEqual(sug1.confidence, 'HIGH', 'Matching invoiceNumber must produce HIGH confidence')

  const sug2 = suggestions.find((s) => s.transactionId === 'tx-2')
  assert.strictEqual(sug2.invoiceId, 'inv-s2')
  assert.strictEqual(sug2.confidence, 'HIGH', 'Matching tenderReference must produce HIGH confidence')

  const sug3 = suggestions.find((s) => s.transactionId === 'tx-3')
  assert.strictEqual(sug3.invoiceId, 'inv-p1')
  assert.strictEqual(sug3.confidence, 'HIGH', 'Matching bill number must produce HIGH confidence')
})

await runTest('D', 'D2', 'Disambiguation between identical invoice amounts using text tokens', async () => {
  const booksState = writeFreshBooksStore({
    invoices: [
      { id: 'inv-dup-a', invoiceNumber: 'INV-2026-301', type: 'Sales', partyName: 'Alpha Tech Corp', grandTotal: 75000, outstandingAmount: 75000, status: 'Unpaid' },
      { id: 'inv-dup-b', invoiceNumber: 'INV-2026-302', type: 'Sales', partyName: 'Beta Logistics SA', grandTotal: 75000, outstandingAmount: 75000, status: 'Unpaid' },
    ],
    bankTransactions: [
      { id: 'tx-alpha', accountId: 'acc-bank', date: '2026-09-01', description: 'Payment Alpha Tech INV-2026-301', amount: 75000, reconciled: false },
      { id: 'tx-beta', accountId: 'acc-bank', date: '2026-09-01', description: 'Remittance Beta Logistics INV-2026-302', amount: 75000, reconciled: false },
    ],
  })

  const suggestions = books.computeSettlementSuggestions(booksState)
  const alphaHigh = suggestions.find((s) => s.transactionId === 'tx-alpha' && s.confidence === 'HIGH')
  const betaHigh = suggestions.find((s) => s.transactionId === 'tx-beta' && s.confidence === 'HIGH')

  assert(alphaHigh, 'Must disambiguate tx-alpha with HIGH confidence')
  assert.strictEqual(alphaHigh.invoiceId, 'inv-dup-a', 'tx-alpha must match Alpha Tech invoice')

  assert(betaHigh, 'Must disambiguate tx-beta with HIGH confidence')
  assert.strictEqual(betaHigh.invoiceId, 'inv-dup-b', 'tx-beta must match Beta Logistics invoice')
})

await runTest('D', 'D3', 'Rapid-fire sequential execution of 10 reconciliations', async () => {
  // Build a test environment with 10 invoices and 10 transactions
  const invoices = []
  const transactions = []
  const parties = []

  for (let i = 1; i <= 10; i++) {
    const invId = `inv-rapid-${i}`
    const txId = `tx-rapid-${i}`
    const partyId = `party-rapid-${i}`
    const partyName = `Rapid Client ${i} Corp`
    const amount = 10000 * i

    parties.push({ id: partyId, name: partyName, type: 'Customer', outstandingBalance: amount })
    invoices.push({
      id: invId,
      invoiceNumber: `INV-2026-RAPID-${i}`,
      type: 'Sales',
      partyId,
      partyName,
      grandTotal: amount,
      outstandingAmount: amount,
      status: 'Unpaid',
    })
    transactions.push({
      id: txId,
      accountId: 'acc-bank',
      date: '2026-09-02',
      description: `Customer Deposit ${partyName} INV-2026-RAPID-${i}`,
      amount,
      reconciled: false,
    })
  }

  writeFreshBooksStore({ parties, invoices, bankTransactions: transactions })

  const reconcileHandler = ipcHandlers.get('books:reconcile-transaction')

  // Execute all 10 reconciliations in rapid sequence
  for (let i = 1; i <= 10; i++) {
    const txId = `tx-rapid-${i}`
    const invId = `inv-rapid-${i}`
    const res = await reconcileHandler({}, txId, invId)
    assert(res.ok, `Reconciliation of ${txId} with ${invId} failed: ${res.error}`)
    assert.strictEqual(res.invoiceStatus, 'Paid')
  }

  // Verify all 10 are reconciled and ledger journal entries posted
  const updatedBooks = books.readBooksStore(booksDataPath)
  for (let i = 1; i <= 10; i++) {
    const tx = updatedBooks.bankTransactions.find((t) => t.id === `tx-rapid-${i}`)
    assert(tx.reconciled, `Transaction ${tx.id} must be reconciled`)
    assert.strictEqual(tx.matchedInvoiceId, `inv-rapid-${i}`)

    const inv = updatedBooks.invoices.find((inv) => inv.id === `inv-rapid-${i}`)
    assert.strictEqual(inv.status, 'Paid')
    assert.strictEqual(inv.outstandingAmount, 0)

    const party = updatedBooks.parties.find((p) => p.id === `party-rapid-${i}`)
    assert.strictEqual(party.outstandingBalance, 0, `Party balance must be 0`)
  }

  assert.strictEqual(updatedBooks.journalEntries.length, 10, 'Must have posted 10 settlement journal entries')
})

await runTest('D', 'D4', 'Anti-double-reconciliation guard (rejects already reconciled or paid items)', async () => {
  const reconcileHandler = ipcHandlers.get('books:reconcile-transaction')

  // Attempt to reconcile an already reconciled transaction
  const res1 = await reconcileHandler({}, 'tx-rapid-1', 'inv-rapid-1')
  assert(!res1.ok, 'Re-reconciling same pair must be rejected')
  assert(res1.error.includes('already reconciled'), `Unexpected error: ${res1.error}`)

  // Create an unreconciled transaction and attempt to pair with already Paid invoice
  const bData = books.readBooksStore(booksDataPath)
  bData.bankTransactions.push({
    id: 'tx-new-unrec',
    accountId: 'acc-bank',
    date: '2026-09-03',
    description: 'Surplus Payment Attempt',
    amount: 10000,
    reconciled: false,
  })
  books.writeBooksStore(booksDataPath, bData)

  const res2 = await reconcileHandler({}, 'tx-new-unrec', 'inv-rapid-1')
  assert(!res2.ok, 'Reconciling with already Paid invoice must be rejected')
  assert(res2.error.includes('already marked Paid'), `Unexpected error: ${res2.error}`)
})

await runTest('D', 'D5', 'General Ledger trial balance integrity post-reconciliation', async () => {
  const updatedBooks = books.readBooksStore(booksDataPath)

  // Verify balanced debits and credits across all journal entries
  let totalJeDebits = 0
  let totalJeCredits = 0

  for (const je of updatedBooks.journalEntries) {
    assert.strictEqual(je.totalDebit, je.totalCredit, `Journal entry ${je.id} is unbalanced`)
    totalJeDebits += je.totalDebit
    totalJeCredits += je.totalCredit
  }

  assert.strictEqual(totalJeDebits, totalJeCredits, 'Cumulative Journal Debits must equal Cumulative Credits')
})

// ============================================================================
// 7. SUITE E: CORRUPTED FILE RECOVERY & SAFE RE-SEEDING
// ============================================================================

console.log('\n======================================================================')
console.log('   SUITE E: CORRUPTED FILE RECOVERY & RE-SEEDING')
console.log('======================================================================')

await runTest('E', 'E1', 'Corrupted deals.json generates .corrupted.bak and recovers cleanly', async () => {
  const brokenContent = '{"version": 1, "deals": [{"id": "deal-broken", "name": "Unfinished'
  writeFileSync(crmDealsPath, brokenContent, 'utf8')

  // Read should not crash
  const recovered = crm.readDealsStore(crmDealsPath)
  assert.strictEqual(recovered.version, 1, 'Recovered envelope version must be 1')
  assert(Array.isArray(recovered.deals), 'Recovered envelope must contain deals array')

  // Verify .corrupted.bak exists
  const bakPath = `${crmDealsPath}.corrupted.bak`
  assert(existsSync(bakPath), `.corrupted.bak file must exist at ${bakPath}`)
  const bakContent = readFileSync(bakPath, 'utf8')
  assert.strictEqual(bakContent, brokenContent, 'Backup content must match original corrupted text')

  // Write new valid store
  crm.writeDealsStore(crmDealsPath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    deals: [{ id: 'deal-healed-1', name: 'Healed Deal', amount: 50000, stage: 'won' }],
  })

  const healed = crm.readDealsStore(crmDealsPath)
  assert.strictEqual(healed.deals.length, 1)
  assert.strictEqual(healed.deals[0].id, 'deal-healed-1')
})

await runTest('E', 'E2', 'Corrupted tenders-data.json generates .corrupted.bak and recovers cleanly', async () => {
  const brokenContent = '<<<SYNTAX ERROR IN TENDERS STORE FILE>>> NOT JSON'
  writeFileSync(tendersDataPath, brokenContent, 'utf8')

  const recovered = tenders.readTendersStore(tendersDataPath)
  assert.strictEqual(recovered.version, 1, 'Recovered envelope must be version 1')
  assert(Array.isArray(recovered.workspaces), 'Recovered envelope must contain workspaces array')

  const bakPath = `${tendersDataPath}.corrupted.bak`
  assert(existsSync(bakPath), `.corrupted.bak must exist at ${bakPath}`)
  assert.strictEqual(readFileSync(bakPath, 'utf8'), brokenContent)

  // Write valid state
  tenders.writeTendersStore(tendersDataPath, createInitialTendersEnvelope())
  const readBack = tenders.readTendersStore(tendersDataPath)
  assert(readBack.workspaces.length > 0)
})

await runTest('E', 'E3', 'Corrupted books-data.json generates .corrupted.bak and preserves core accounts', async () => {
  const brokenContent = '{"accounts": [{"id": "acc-bank", "balance": 500000}, TRUNCATED'
  writeFileSync(booksDataPath, brokenContent, 'utf8')

  const recovered = books.readBooksStore(booksDataPath)
  assert.strictEqual(recovered.version, 1, 'Recovered envelope must be version 1')
  assert(recovered.accounts.length >= 5, 'Recovered envelope must retain CORE_ACCOUNTS')
  assert(recovered.accounts.some((a) => a.id === 'acc-bank'), 'acc-bank must exist in fallback')
  assert(recovered.accounts.some((a) => a.id === 'acc-ar'), 'acc-ar must exist in fallback')
  assert(recovered.accounts.some((a) => a.id === 'acc-ap'), 'acc-ap must exist in fallback')
  assert(recovered.accounts.some((a) => a.id === 'acc-sales'), 'acc-sales must exist in fallback')
  assert(recovered.accounts.some((a) => a.id === 'acc-vat'), 'acc-vat must exist in fallback')

  const bakPath = `${booksDataPath}.corrupted.bak`
  assert(existsSync(bakPath), `.corrupted.bak must exist at ${bakPath}`)
  assert.strictEqual(readFileSync(bakPath, 'utf8'), brokenContent)
})

await runTest('E', 'E4', 'Zero-byte empty file recovery across all 3 stores without process crash', async () => {
  writeFileSync(crmDealsPath, '', 'utf8')
  writeFileSync(tendersDataPath, '', 'utf8')
  writeFileSync(booksDataPath, '', 'utf8')

  const crmEmpty = crm.readDealsStore(crmDealsPath)
  assert.strictEqual(crmEmpty.version, 1)

  const tendersEmpty = tenders.readTendersStore(tendersDataPath)
  assert.strictEqual(tendersEmpty.version, 1)

  const booksEmpty = books.readBooksStore(booksDataPath)
  assert.strictEqual(booksEmpty.version, 1)
})

await runTest('E', 'E5', 'Full recovery & self-healing round-trip persistence after corruption', async () => {
  // Re-seed all 3 stores with full fresh data
  const freshDeals = [{ id: 'deal-fresh-1', name: 'Fresh Opportunity', amount: 80000, stage: 'won' }]
  crm.writeDealsStore(crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals: freshDeals })

  const freshTenders = createInitialTendersEnvelope()
  tenders.writeTendersStore(tendersDataPath, freshTenders)

  const freshBooks = createInitialBooksEnvelope()
  books.writeBooksStore(booksDataPath, freshBooks)

  // Verify all 3 stores read back their updated data cleanly
  const dRead = crm.readDealsStore(crmDealsPath)
  assert.strictEqual(dRead.deals[0].name, 'Fresh Opportunity')

  const tRead = tenders.readTendersStore(tendersDataPath)
  assert.strictEqual(tRead.workspaces.length, 3)

  const bRead = books.readBooksStore(booksDataPath)
  assert.strictEqual(bRead.accounts.find((a) => a.id === 'acc-bank').balance, 500000)
})

// ============================================================================
// 8. SUITE F: STORE ROUND-TRIP RESILIENCE & EXTENSION PRESERVATION
// ============================================================================

console.log('\n======================================================================')
console.log('   SUITE F: STORE ROUND-TRIP & EXTENSION PRESERVATION')
console.log('======================================================================')

await runTest('F', 'F1', 'CRM Deals custom extension fields survive persistence round-trip', async () => {
  const extendedDeals = [
    {
      id: 'deal-ext-01',
      name: 'Tier 1 Enterprise License',
      companyName: 'Acme Mega Corp',
      amount: 150000.75,
      stage: 'won',
      probability: 100,
      customSfdcId: 'SFDC-99201',
      tierLevel: 'PLATINUM',
      customTags: ['cloud-migration', 'fedramp'],
      extraConfig: { sla: '24/7', dedicatedSupport: true },
    },
  ]

  crm.writeDealsStore(crmDealsPath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    deals: extendedDeals,
  })

  const readBack = crm.readDealsStore(crmDealsPath)
  const d = readBack.deals[0]
  assert.strictEqual(d.id, 'deal-ext-01')
  assert.strictEqual(d.customSfdcId, 'SFDC-99201', 'customSfdcId must be preserved')
  assert.strictEqual(d.tierLevel, 'PLATINUM', 'tierLevel must be preserved')
  assert.deepStrictEqual(d.customTags, ['cloud-migration', 'fedramp'], 'customTags array must be preserved')
  assert.strictEqual(d.extraConfig?.sla, '24/7', 'extraConfig object must be preserved')
})

await runTest('F', 'F2', 'Tenders custom properties on workspaces, tenders, and milestones survive round-trip', async () => {
  const extendedTendersData = {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeCompanyId: 'comp-zano-01',
    customAuditMeta: { auditor: 'GovAudit Services', signedOff: true },
    workspaces: [
      {
        id: 'ws-custom-01',
        name: 'Custom Infrastructure Workspace',
        complianceLead: 'Dr. Johnathan Vance',
        tenders: [
          {
            id: 'tender-custom-01',
            title: 'Custom High-Security Infrastructure Tender',
            referenceNumber: 'RFP-SEC-2026-99',
            vaultFolderId: 'vf-8812',
            rfpHash: '0xabc123def456',
            milestones: [
              {
                id: 'ms-custom-01',
                title: 'Perimeter Barrier Delivery',
                amount: 75000,
                status: 'REACHED',
                retentionGuaranteePct: 5,
                engineerStamp: 'STAMP-ENG-9901',
              },
            ],
          },
        ],
      },
    ],
    issuerTemplates: [],
  }

  tenders.writeTendersStore(tendersDataPath, extendedTendersData)

  const readBack = tenders.readTendersStore(tendersDataPath)
  const ws = readBack.workspaces[0]
  assert.strictEqual(ws.complianceLead, 'Dr. Johnathan Vance', 'Workspace custom property preserved')

  const t = ws.tenders[0]
  assert.strictEqual(t.vaultFolderId, 'vf-8812', 'Tender custom property preserved')
  assert.strictEqual(t.rfpHash, '0xabc123def456', 'Tender rfpHash preserved')

  const m = t.milestones[0]
  assert.strictEqual(m.retentionGuaranteePct, 5, 'Milestone custom retention guarantee preserved')
  assert.strictEqual(m.engineerStamp, 'STAMP-ENG-9901', 'Milestone engineer stamp preserved')
})

await runTest('F', 'F3', 'Books custom fields on settings, accounts, invoices, and parties survive round-trip', async () => {
  const extendedBooksData = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: {
      companyName: 'Zano Consulting (Pty) Ltd',
      taxNumber: '4920198273',
      currency: 'ZAR',
      currencySymbol: 'R',
      customRegCode: 'REG-ZA-2026-01',
    },
    accounts: [
      { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', balance: 500000, glCode: '1000-01', costCenter: 'FIN-HQ' },
      { id: 'acc-ar', name: 'Accounts Receivable', rootType: 'Asset', accountType: 'Receivable', balance: 200000 },
      { id: 'acc-ap', name: 'Accounts Payable', rootType: 'Liability', accountType: 'Payable', balance: 80000 },
      { id: 'acc-sales', name: 'Sales', rootType: 'Income', accountType: 'Direct Income', balance: 850000 },
      { id: 'acc-vat', name: 'SARS VAT', rootType: 'Liability', accountType: 'Tax', balance: 40000 },
    ],
    parties: [
      { id: 'party-cust-1', name: 'Custom Client Corp', type: 'Customer', outstandingBalance: 60000, creditRating: 'AAA', vendorPortalId: 'VP-9981' },
    ],
    invoices: [
      {
        id: 'inv-ext-1',
        invoiceNumber: 'INV-2026-EXT',
        type: 'Sales',
        partyName: 'Custom Client Corp',
        grandTotal: 60000,
        outstandingAmount: 60000,
        status: 'Unpaid',
        purchaseOrderRef: 'PO-2026-8812',
        vatExemptionCode: null,
      },
    ],
    journalEntries: [],
    bankTransactions: [
      {
        id: 'tx-ext-1',
        accountId: 'acc-bank',
        date: '2026-09-02',
        description: 'Electronic Settlement',
        amount: 60000,
        reconciled: false,
        swiftMessageId: 'SWIFT-ZA-991823',
      },
    ],
  }

  books.writeBooksStore(booksDataPath, extendedBooksData)

  const readBack = books.readBooksStore(booksDataPath)
  assert.strictEqual(readBack.settings.customRegCode, 'REG-ZA-2026-01', 'Settings custom field preserved')

  const bankAcc = readBack.accounts.find((a) => a.id === 'acc-bank')
  assert.strictEqual(bankAcc.glCode, '1000-01', 'Account glCode preserved')
  assert.strictEqual(bankAcc.costCenter, 'FIN-HQ', 'Account costCenter preserved')

  const party = readBack.parties[0]
  assert.strictEqual(party.creditRating, 'AAA', 'Party creditRating preserved')
  assert.strictEqual(party.vendorPortalId, 'VP-9981', 'Party vendorPortalId preserved')

  const inv = readBack.invoices[0]
  assert.strictEqual(inv.purchaseOrderRef, 'PO-2026-8812', 'Invoice purchaseOrderRef preserved')

  const tx = readBack.bankTransactions[0]
  assert.strictEqual(tx.swiftMessageId, 'SWIFT-ZA-991823', 'Bank transaction swiftMessageId preserved')
})

await runTest('F', 'F4', 'Atomic persistence under rapid-fire updates (no partial writes or orphan .tmp files)', async () => {
  const iterations = 50
  for (let i = 1; i <= iterations; i++) {
    const data = {
      version: 1,
      updatedAt: new Date().toISOString(),
      deals: [{ id: `deal-rapid-${i}`, name: `Rapid Deal ${i}`, amount: i * 1000, stage: 'proposal' }],
    }
    crm.writeDealsStore(crmDealsPath, data)
  }

  // Check no leftover .tmp files
  const files = readdirSync(crmDir)
  const tmpFiles = files.filter((f) => f.includes('.tmp'))
  assert.strictEqual(tmpFiles.length, 0, `Found ${tmpFiles.length} orphan .tmp files in crm directory: ${tmpFiles.join(', ')}`)

  const finalRead = crm.readDealsStore(crmDealsPath)
  assert.strictEqual(finalRead.deals[0].id, `deal-rapid-${iterations}`)
  assert.strictEqual(finalRead.deals[0].amount, iterations * 1000)
})

await runTest('F', 'F5', 'Legacy v0 schema migration preserves custom deal properties', async () => {
  // Legacy v0 raw array input
  const legacyArray = [
    {
      id: 'legacy-deal-1',
      name: 'Legacy Deal with Custom Tag',
      amount: '55000',
      probability: 120, // should be clamped
      stage: 'invalid_stage', // should fall back to lead
      legacyExternalCrmId: 'OLD-CRM-881',
      assignedSalesRep: 'Sarah Connor',
    },
  ]

  const migrated = crm.migrateAndValidateDeals(legacyArray)
  assert.strictEqual(migrated.version, 1, 'Version must be upgraded to 1')
  assert(typeof migrated.updatedAt === 'string', 'updatedAt must be populated')

  const d = migrated.deals[0]
  assert.strictEqual(d.id, 'legacy-deal-1')
  assert.strictEqual(d.amount, 55000)
  assert.strictEqual(d.probability, 100, 'Probability > 100 clamped to 100')
  assert.strictEqual(d.stage, 'lead', 'Invalid stage defaulted to lead')
  assert.strictEqual(d.legacyExternalCrmId, 'OLD-CRM-881', 'Legacy custom field preserved')
  assert.strictEqual(d.assignedSalesRep, 'Sarah Connor', 'Legacy sales rep field preserved')
})

// ============================================================================
// 9. EXECUTION SUMMARY & REPORT
// ============================================================================

console.log('\n======================================================================')
console.log('   CHALLENGER 2 MILESTONE 5 RESILIENCE VERIFICATION SUMMARY')
console.log('======================================================================')
console.log(`Suite A (Concurrent & Fractional CRM Invoicing): ${suiteStats['A']?.passed || 0} passed, ${suiteStats['A']?.failed || 0} failed`)
console.log(`Suite B (Multi-Tender Milestone Billing):       ${suiteStats['B']?.passed || 0} passed, ${suiteStats['B']?.failed || 0} failed`)
console.log(`Suite C (Multi-Batch Bank Statement Import):    ${suiteStats['C']?.passed || 0} passed, ${suiteStats['C']?.failed || 0} failed`)
console.log(`Suite D (Rapid-Fire Stress Reconciliation):     ${suiteStats['D']?.passed || 0} passed, ${suiteStats['D']?.failed || 0} failed`)
console.log(`Suite E (Corrupted File Recovery & Seeding):    ${suiteStats['E']?.passed || 0} passed, ${suiteStats['E']?.failed || 0} failed`)
console.log(`Suite F (Store Round-Trip & Extension Fields):  ${suiteStats['F']?.passed || 0} passed, ${suiteStats['F']?.failed || 0} failed`)
console.log('----------------------------------------------------------------------')
console.log(`TOTAL: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)

// Cleanup sandbox
try {
  rmSync(sandboxRoot, { recursive: true, force: true })
} catch {}

if (failedTests > 0) {
  console.error(`\n❌ VERIFICATION FAILED: ${failedTests} test(s) failed.`)
  for (const f of failures) {
    console.error(`\n[${f.id}] ${f.name}:\n${f.error}`)
  }
  process.exit(1)
} else {
  console.log('\n🎉 ALL ADVERSARIAL STRESS & RESILIENCE TESTS PASSED CLEANLY!')
  process.exit(0)
}

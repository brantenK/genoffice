#!/usr/bin/env node
import assert from 'node:assert'
/**
 * tools/test-adversarial-m3-empirical.mjs
 *
 * Adversarial Empirical Verification Suite for Milestone 3:
 * Tests the real compiled apps/tenders/out/main/index.js IPC handler 'tenders:bill-milestone-in-books'
 * and 'tenders:open-books' against stress-test corner cases, mathematical invariants,
 * double-entry ledger balance, duplicate prevention, and schema envelope preservation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const sandboxDir = join(tmpdir(), `m3-adv-${randomUUID().slice(0, 8)}`)
mkdirSync(join(sandboxDir, 'tenders'), { recursive: true })
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

const tenders = require('../apps/tenders/out/main/index.js')

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failureDetails = []


function writeTendersData(data) {
  const filePath = join(sandboxDir, 'tenders', 'tenders-data.json')
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function readTendersData() {
  const filePath = join(sandboxDir, 'tenders', 'tenders-data.json')
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function writeBooksData(data) {
  const filePath = join(sandboxDir, 'books', 'books-data.json')
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
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
      { id: 'party-ekurhuleni', name: 'City of Ekurhuleni Water Dept', type: 'Customer', email: 'procurement@ekurhuleni.gov.za', outstandingBalance: 40000 },
    ],
    invoices: [],
    journalEntries: [],
  }
}

function createInitialTendersStore(tenderOverride) {
  const defaultTender = {
    id: 'tender-wtr-04',
    title: 'Bulk Water Metering & Valve Refurbishment',
    referenceNumber: 'RFP-WTR-2026-04',
    issuingBody: 'City of Ekurhuleni Water Dept',
    closingDate: '2026-10-31',
    status: 'IN_PROGRESS',
    milestones: [
      {
        id: 'ms-01',
        name: 'Phase 1 Reservoir Valve Refurbishment',
        title: 'Phase 1 Reservoir Valve Refurbishment',
        amount: 145000,
        status: 'REACHED',
        dueDate: '2026-08-30',
      },
      {
        id: 'ms-02',
        name: 'Phase 2 Ultrasonic Flow Meter Installation',
        title: 'Phase 2 Ultrasonic Flow Meter Installation',
        amount: 98000,
        status: 'PENDING',
        dueDate: '2026-11-15',
      },
      {
        id: 'ms-03',
        name: 'Phase 3 Commissioning and Handover',
        title: 'Phase 3 Commissioning and Handover',
        amount: 55000,
        status: 'BILLED',
        billedInvoiceId: 'inv-pre-existing',
        billedInvoiceNumber: 'INV-2026-000',
      },
    ],
    requirements: [],
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeCompanyId: 'comp-1',
    workspaces: [
      {
        id: 'ws-1',
        tenders: [tenderOverride || defaultTender],
      },
    ],
    issuerTemplates: [],
  }
}

async function test(name, fn) {
  totalTests++
  try {
    await fn()
    passedTests++
    console.log(`  ? [PASS] ${name}`)
  } catch (err) {
    failedTests++
    failureDetails.push({ name, error: err.message || String(err) })
    console.error(`  ? [FAIL] ${name}: ${err.message}`)
  }
}

console.log('\n======================================================================')
console.log('   MILESTONE 3: EMPIRICAL ADVERSARIAL VERIFICATION')
console.log('======================================================================\n')

let shellOpenedBooksInvoiceId = null
let shellOpenedBooksCalled = false

tenders.configureTendersRuntime({
  preloadPath: '',
  rendererFile: '',
  onOpenBooks: (invId) => {
    shellOpenedBooksCalled = true
    shellOpenedBooksInvoiceId = invId
  },
})

tenders.registerTendersIpc()

const billMilestoneHandler = ipcHandlers.get('tenders:bill-milestone-in-books')
const openBooksHandler = ipcHandlers.get('tenders:open-books')

assert(typeof billMilestoneHandler === 'function', 'tenders:bill-milestone-in-books IPC handler must be registered')
assert(typeof openBooksHandler === 'function', 'tenders:open-books IPC handler must be registered')

async function runAll() {
  // Test 1: Rejection of PENDING status
  await test('Rejection of PENDING milestone status with informative error', async () => {
    writeTendersData(createInitialTendersStore())
    writeBooksData(createInitialBooksStore())

    const res = await billMilestoneHandler({}, { tenderId: 'tender-wtr-04', milestoneId: 'ms-02' })
    assert(!res.ok, 'Pending milestone must not be billable')
    assert(res.error.includes('REACHED'), `Error should state REACHED required: got "${res.error}"`)
  })

  // Test 2: Rejection of already BILLED milestone
  await test('Rejection of already BILLED milestone (idempotency)', async () => {
    writeTendersData(createInitialTendersStore())
    writeBooksData(createInitialBooksStore())

    const res = await billMilestoneHandler({}, { tenderId: 'tender-wtr-04', milestoneId: 'ms-03' })
    assert(!res.ok, 'Already billed milestone must not be re-billed')
    assert(res.error.toLowerCase().includes('already billed'), `Error should mention already billed: got "${res.error}"`)
  })

  // Test 3: Rejection of non-existent milestone ID
  await test('Rejection of non-existent milestone ID', async () => {
    writeTendersData(createInitialTendersStore())
    writeBooksData(createInitialBooksStore())

    const res = await billMilestoneHandler({}, { tenderId: 'tender-wtr-04', milestoneId: 'ms-non-existent' })
    assert(!res.ok, 'Non-existent milestone must be rejected')
    assert(res.error.includes('Milestone not found'), `Expected milestone not found: got "${res.error}"`)
  })

  // Test 4: Rejection of non-existent tender ID
  await test('Rejection of non-existent tender ID', async () => {
    writeTendersData(createInitialTendersStore())
    writeBooksData(createInitialBooksStore())

    const res = await billMilestoneHandler({}, { tenderId: 'tender-ghost-99', milestoneId: 'ms-01' })
    assert(!res.ok, 'Non-existent tender must be rejected')
    assert(res.error.includes('Tender not found'), `Expected tender not found: got "${res.error}"`)
  })

  // Test 5: Rejection of zero or negative billing amount
  await test('Rejection of zero or negative billing amount', async () => {
    const zeroTender = {
      id: 'tender-zero',
      referenceNumber: 'RFP-ZERO',
      issuingBody: 'Zero Dept',
      milestones: [
        { id: 'ms-zero', title: 'Zero Milestone', amount: 0, status: 'REACHED' },
        { id: 'ms-neg', title: 'Negative Milestone', amount: -500, status: 'REACHED' },
      ],
    }
    writeTendersData(createInitialTendersStore(zeroTender))
    writeBooksData(createInitialBooksStore())

    const resZero = await billMilestoneHandler({}, { tenderId: 'tender-zero', milestoneId: 'ms-zero' })
    assert(!resZero.ok, 'Zero amount must be rejected')

    const resNeg = await billMilestoneHandler({}, { tenderId: 'tender-zero', milestoneId: 'ms-neg' })
    assert(!resNeg.ok, 'Negative amount must be rejected')
  })

  // Test 6: Authentic Milestone Billing & South African VAT Math
  await test('Authentic Tax Invoice creation with precise 15% VAT and rounding', async () => {
    writeTendersData(createInitialTendersStore())
    writeBooksData(createInitialBooksStore())

    shellOpenedBooksCalled = false
    shellOpenedBooksInvoiceId = null

    const res = await billMilestoneHandler({}, {
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      tenderReference: 'RFP-WTR-2026-04',
      issuingAuthority: 'City of Ekurhuleni Water Dept',
      milestoneTitle: 'Phase 1 Reservoir Valve Refurbishment',
      amount: 145000,
    })

    assert(res.ok, `Milestone billing should succeed: ${res.error}`)
    assert.strictEqual(res.tenderReference, 'RFP-WTR-2026-04')
    assert.strictEqual(res.grandTotal, 145000)
    assert.strictEqual(res.subtotal, 126086.96)
    assert.strictEqual(res.taxTotal, 18913.04)
    assert.strictEqual(Math.round((res.subtotal + res.taxTotal) * 100) / 100, res.grandTotal, 'subtotal + taxTotal === grandTotal')

    // Shell tab activation callback check
    assert(shellOpenedBooksCalled, 'Shell onOpenBooks callback must be triggered')
    assert.strictEqual(shellOpenedBooksInvoiceId, res.invoiceId, 'Callback received generated invoiceId')
  })

  // Test 7: Double-entry General Ledger updates and Journal Entry balance
  await test('General ledger account balances and journal entry debit===credit balance', async () => {
    const initialBooks = createInitialBooksStore()
    const arBefore = initialBooks.accounts.find((a) => a.id === 'acc-ar').balance
    const salesBefore = initialBooks.accounts.find((a) => a.id === 'acc-sales').balance
    const vatBefore = initialBooks.accounts.find((a) => a.id === 'acc-vat').balance

    writeTendersData(createInitialTendersStore())
    writeBooksData(initialBooks)

    const res = await billMilestoneHandler({}, 'tender-wtr-04', 'ms-01')
    assert(res.ok, 'Billing with positional args should succeed')

    const booksAfter = readBooksData()
    const arAfter = booksAfter.accounts.find((a) => a.id === 'acc-ar').balance
    const salesAfter = booksAfter.accounts.find((a) => a.id === 'acc-sales').balance
    const vatAfter = booksAfter.accounts.find((a) => a.id === 'acc-vat').balance

    assert.strictEqual(arAfter, Math.round((arBefore + 145000) * 100) / 100, 'acc-ar incremented by grandTotal')
    assert.strictEqual(salesAfter, Math.round((salesBefore + 126086.96) * 100) / 100, 'acc-sales incremented by subtotal')
    assert.strictEqual(vatAfter, Math.round((vatBefore + 18913.04) * 100) / 100, 'acc-vat incremented by taxTotal')

    // Balanced Journal Entry
    const je = booksAfter.journalEntries.find((j) => j.remarks.includes(res.invoiceNumber))
    assert(je, 'Balanced Journal Entry must be created')
    assert.strictEqual(je.totalDebit, 145000)
    assert.strictEqual(je.totalCredit, 145000)
    assert.strictEqual(je.posted, true)

    const jeiAr = je.items.find((i) => i.accountId === 'acc-ar')
    const jeiSales = je.items.find((i) => i.accountId === 'acc-sales')
    const jeiVat = je.items.find((i) => i.accountId === 'acc-vat')

    assert.strictEqual(jeiAr.debit, 145000)
    assert.strictEqual(jeiSales.credit, 126086.96)
    assert.strictEqual(jeiVat.credit, 18913.04)
  })

  // Test 8: Tenders Store Milestone State Update & Disk Persistence
  await test('Tenders milestone updated to BILLED with billedInvoiceId & timestamp on disk', async () => {
    writeTendersData(createInitialTendersStore())
    writeBooksData(createInitialBooksStore())

    const res = await billMilestoneHandler({}, { tenderId: 'tender-wtr-04', milestoneId: 'ms-01' })
    assert(res.ok, 'Billing should succeed')

    const tendersAfter = readTendersData()
    const tender = tendersAfter.workspaces[0].tenders.find((t) => t.id === 'tender-wtr-04')
    const milestone = tender.milestones.find((m) => m.id === 'ms-01')

    assert.strictEqual(milestone.status, 'BILLED')
    assert.strictEqual(milestone.billedInvoiceId, res.invoiceId)
    assert.strictEqual(milestone.billedInvoiceNumber, res.invoiceNumber)
    assert(milestone.billedAt, 'billedAt timestamp recorded')
    assert(milestone.billedDate, 'billedDate timestamp recorded')

    // Attempt second bill immediately on same store - must fail
    const resSecond = await billMilestoneHandler({}, { tenderId: 'tender-wtr-04', milestoneId: 'ms-01' })
    assert(!resSecond.ok, 'Immediate second billing attempt must be rejected')
  })

  // Test 9: Auto-creation and balance increment of new issuing authority party
  await test('Auto-creation of unknown issuing authority in Books parties', async () => {
    const customTender = {
      id: 'tender-rand-water',
      referenceNumber: 'RFP-RW-900',
      issuingBody: 'Rand Water Operations Board',
      milestones: [
        { id: 'ms-rw-01', title: 'Pumping Station Overhaul', amount: 80000, status: 'REACHED' },
      ],
    }
    writeTendersData(createInitialTendersStore(customTender))
    writeBooksData(createInitialBooksStore())

    const res = await billMilestoneHandler({}, {
      tenderId: 'tender-rand-water',
      milestoneId: 'ms-rw-01',
      issuingAuthority: 'Rand Water Operations Board',
    })

    assert(res.ok, 'Billing custom tender should succeed')

    const books = readBooksData()
    const party = books.parties.find((p) => p.name === 'Rand Water Operations Board')
    assert(party, 'Party must be auto-created in Books')
    assert.strictEqual(party.type, 'Customer')
    assert.strictEqual(party.outstandingBalance, 80000)
  })

  // Test 10: Atomic write clean-up (no dangling .tmp files)
  await test('Atomic disk persistence clean-up without dangling .tmp files', async () => {
    const tendersDir = join(sandboxDir, 'tenders')
    const booksDir = join(sandboxDir, 'books')

    const filesTenders = readdirSync(tendersDir)
    const filesBooks = readdirSync(booksDir)

    const tmpTenders = filesTenders.filter((f) => f.includes('.tmp'))
    const tmpBooks = filesBooks.filter((f) => f.includes('.tmp'))

    assert.strictEqual(tmpTenders.length, 0, `No temporary files in tenders dir: found ${tmpTenders.join(', ')}`)
    assert.strictEqual(tmpBooks.length, 0, `No temporary files in books dir: found ${tmpBooks.join(', ')}`)
  })

  // Test 11: openBooks IPC handler
  await test('openBooks IPC handler calls runtime.onOpenBooks and returns true', async () => {
    shellOpenedBooksCalled = false
    const openRes = await openBooksHandler({})
    assert.strictEqual(openRes, true)
    assert(shellOpenedBooksCalled, 'runtime.onOpenBooks must be called')
  })

  // Test 12: Sequential multi-milestone billing and sequential invoice numbering
  await test('Sequential billing of multiple milestones maintains sequential invoice numbers', async () => {
    const multiTender = {
      id: 'tender-multi',
      referenceNumber: 'RFP-MULTI-01',
      issuingBody: 'Ekurhuleni Water',
      milestones: [
        { id: 'm-1', title: 'Milestone 1', amount: 50000, status: 'REACHED' },
        { id: 'm-2', title: 'Milestone 2', amount: 75000, status: 'REACHED' },
      ],
    }
    writeTendersData(createInitialTendersStore(multiTender))
    writeBooksData(createInitialBooksStore())

    const res1 = await billMilestoneHandler({}, { tenderId: 'tender-multi', milestoneId: 'm-1' })
    const res2 = await billMilestoneHandler({}, { tenderId: 'tender-multi', milestoneId: 'm-2' })

    assert(res1.ok && res2.ok, 'Both milestones should bill successfully')
    assert.notStrictEqual(res1.invoiceNumber, res2.invoiceNumber, 'Invoice numbers must be unique')

    const books = readBooksData()
    assert.strictEqual(books.invoices.length, 2, 'Books should contain exactly 2 invoices')
    assert.strictEqual(books.journalEntries.length, 2, 'Books should contain exactly 2 journal entries')
  })

  console.log('\n----------------------------------------------------------------------')
  console.log(`Results: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  if (failedTests > 0) {
    console.log('FAILURES:')
    failureDetails.forEach((f) => console.log(` - ${f.name}: ${f.error}`))
    process.exit(1)
  } else {
    console.log('?? ALL ADVERSARIAL EMPIRICAL AUDIT TESTS PASSED!')
    process.exit(0)
  }
}

runAll().catch((err) => {
  console.error('Fatal error during adversarial suite execution:', err)
  process.exit(1)
})



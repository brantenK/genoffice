#!/usr/bin/env node
/**
 * tools/test-challenger-1-m3-empirical.mjs
 *
 * EMPIRICAL ADVERSARIAL VERIFICATION SUITE — MILESTONE 3
 * Role: Challenger 1 (challenger_1_m3)
 * Target: Tenders to Books Milestone Billing Bridge mechanics
 *
 * Core Verification Requirements:
 * 1. Milestone eligibility enforcement (strictly rejects 'PENDING', accepts 'REACHED').
 * 2. Idempotency / duplicate billing guard (rejects billing an already 'BILLED' milestone).
 * 3. Rejection of zero or negative milestone amounts.
 * 4. Non-existent tender ID or non-existent milestone ID.
 * 5. Tender reference ('RFP-WTR-2026-04') and issuing authority linking onto created Books Tax Invoice.
 * 6. Shell tab activation callback trigger ('onOpenBooks' invoked).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import assert from 'node:assert'

const require = createRequire(import.meta.url)

// ----------------------------------------------------------------------------
// ELECTRON IPC & RUNTIME TEST HARNESS
// ----------------------------------------------------------------------------

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

// Load Books module for schema constants and helpers
const booksModule = require('../apps/books/out/main/index.js')
const {
  readBooksStore,
  writeBooksStore,
  CURRENT_BOOKS_SCHEMA_VERSION,
  CORE_ACCOUNTS,
  DEFAULT_BOOK_SETTINGS,
} = booksModule

// Load Tenders module
const tendersModule = require('../apps/tenders/out/main/index.js')
const {
  readTendersStore,
  writeTendersStore,
  CURRENT_TENDERS_SCHEMA_VERSION,
  SEED_TENDER_WTR_04,
  configureTendersRuntime,
  registerTendersIpc,
} = tendersModule

// Ensure Tenders IPC handlers are registered
registerTendersIpc()

// ----------------------------------------------------------------------------
// SANDBOX ENVIRONMENT FACTORY
// ----------------------------------------------------------------------------

function createTestSandbox(name = 'm3-sandbox') {
  const root = join(tmpdir(), `${name}-${randomUUID().slice(0, 8)}`)
  const tendersDir = join(root, 'tenders')
  const booksDir = join(root, 'books')
  mkdirSync(tendersDir, { recursive: true })
  mkdirSync(booksDir, { recursive: true })

  const tendersPath = join(tendersDir, 'tenders-data.json')
  const booksPath = join(booksDir, 'books-data.json')

  // Initialize books-data.json
  const initialBooksData = {
    version: CURRENT_BOOKS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    settings: DEFAULT_BOOK_SETTINGS,
    accounts: CORE_ACCOUNTS.map((a) => ({ ...a, balance: 0 })),
    parties: [],
    invoices: [],
    journalEntries: [],
  }
  writeFileSync(booksPath, JSON.stringify(initialBooksData, null, 2), 'utf8')

  // Initialize tenders-data.json with standard SEED_TENDER_WTR_04
  const initialTendersData = {
    version: CURRENT_TENDERS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    activeCompanyId: 'comp-zano-01',
    workspaces: [
      {
        id: 'ws-ekurhuleni-01',
        name: 'Ekurhuleni Water Infrastructure',
        tenders: [JSON.parse(JSON.stringify(SEED_TENDER_WTR_04))],
      },
    ],
    issuerTemplates: [],
  }
  writeFileSync(tendersPath, JSON.stringify(initialTendersData, null, 2), 'utf8')

  return {
    root,
    tendersDir,
    booksDir,
    tendersPath,
    booksPath,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {}
    },
  }
}

// Helper to execute IPC billMilestoneInBooks within a specific sandbox
async function executeBillMilestone(sandbox, tenderIdOrPayload, milestoneIdArg, runtimeHooks = {}) {
  currentMockUserDataDir = sandbox.root
  let openBooksCalledWith = null
  let openBooksCallCount = 0

  configureTendersRuntime({
    onOpenBooks: (invId) => {
      openBooksCallCount++
      openBooksCalledWith = invId
      if (runtimeHooks.onOpenBooks) runtimeHooks.onOpenBooks(invId)
    },
    ...runtimeHooks,
  })

  const handler = ipcHandlers.get('tenders:bill-milestone-in-books')
  assert(handler, "IPC handler 'tenders:bill-milestone-in-books' must be registered")

  const result = await handler(null, tenderIdOrPayload, milestoneIdArg)

  return {
    result,
    openBooksCallCount,
    openBooksCalledWith,
  }
}

// Helper to execute IPC openBooks within a sandbox
async function executeOpenBooks(sandbox, runtimeHooks = {}) {
  currentMockUserDataDir = sandbox.root
  let openBooksCalled = false

  configureTendersRuntime({
    onOpenBooks: () => {
      openBooksCalled = true
    },
    ...runtimeHooks,
  })

  const handler = ipcHandlers.get('tenders:open-books')
  assert(handler, "IPC handler 'tenders:open-books' must be registered")

  const res = await handler(null)
  return { res, openBooksCalled }
}

// ----------------------------------------------------------------------------
// TEST RUNNER & SUITES
// ----------------------------------------------------------------------------

const suites = []
let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures = []

function test(name, fn) {
  suites.push({ name, fn })
}

// ============================================================================
// SUITE 1: MILESTONE ELIGIBILITY ENFORCEMENT
// ============================================================================

test('1.1: Milestone with status "PENDING" is strictly rejected', async () => {
  const sb = createTestSandbox('sb-1-1')
  try {
    // ms-02 in SEED_TENDER_WTR_04 has status 'PENDING'
    const { result, openBooksCallCount } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-02')
    assert.strictEqual(result.ok, false, 'Billing PENDING milestone must return ok: false')
    assert(
      result.error && result.error.includes('PENDING') && result.error.includes('REACHED'),
      `Error must indicate status is not REACHED: ${result.error}`,
    )
    assert.strictEqual(openBooksCallCount, 0, 'onOpenBooks must NOT be triggered on rejected billing')
  } finally {
    sb.cleanup()
  }
})

test('1.2: Milestone with status "IN_PROGRESS" is strictly rejected', async () => {
  const sb = createTestSandbox('sb-1-2')
  try {
    const tenders = readTendersStore(sb.tendersPath)
    tenders.workspaces[0].tenders[0].milestones[0].status = 'IN_PROGRESS'
    writeTendersStore(sb.tendersPath, tenders)

    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, false, 'Billing IN_PROGRESS milestone must return ok: false')
    assert(result.error.includes('IN_PROGRESS'), `Error must report current status: ${result.error}`)
  } finally {
    sb.cleanup()
  }
})

test('1.3: Milestone with status "CANCELLED" is strictly rejected', async () => {
  const sb = createTestSandbox('sb-1-3')
  try {
    const tenders = readTendersStore(sb.tendersPath)
    tenders.workspaces[0].tenders[0].milestones[0].status = 'CANCELLED'
    writeTendersStore(sb.tendersPath, tenders)

    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, false, 'Billing CANCELLED milestone must return ok: false')
    assert(result.error.includes('CANCELLED'), `Error must report current status: ${result.error}`)
  } finally {
    sb.cleanup()
  }
})

test('1.4: Milestone with status "PAID" is strictly rejected', async () => {
  const sb = createTestSandbox('sb-1-4')
  try {
    const tenders = readTendersStore(sb.tendersPath)
    tenders.workspaces[0].tenders[0].milestones[0].status = 'PAID'
    writeTendersStore(sb.tendersPath, tenders)

    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, false, 'Billing PAID milestone must return ok: false')
    assert(result.error.includes('PAID'), `Error must report current status: ${result.error}`)
  } finally {
    sb.cleanup()
  }
})

test('1.5: Milestone with empty/arbitrary status string is strictly rejected', async () => {
  const sb = createTestSandbox('sb-1-5')
  try {
    const tenders = readTendersStore(sb.tendersPath)
    tenders.workspaces[0].tenders[0].milestones[0].status = 'UNKNOWN_STATE'
    writeTendersStore(sb.tendersPath, tenders)

    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, false, 'Billing arbitrary status milestone must return ok: false')
    assert(result.error.includes('UNKNOWN_STATE'), `Error must report unknown status: ${result.error}`)
  } finally {
    sb.cleanup()
  }
})

test('1.6: Milestone with status "REACHED" is accepted and billed', async () => {
  const sb = createTestSandbox('sb-1-6')
  try {
    // ms-01 in SEED_TENDER_WTR_04 has status 'REACHED'
    const { result, openBooksCallCount, openBooksCalledWith } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, true, 'Billing REACHED milestone must return ok: true')
    assert(result.invoiceId, 'Must return generated invoiceId')
    assert(result.invoiceNumber, 'Must return generated invoiceNumber')
    assert.strictEqual(openBooksCallCount, 1, 'onOpenBooks must be triggered exactly once')
    assert.strictEqual(openBooksCalledWith, result.invoiceId, 'onOpenBooks must receive generated invoiceId')
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SUITE 2: IDEMPOTENCY / DUPLICATE BILLING GUARD
// ============================================================================

test('2.1: Milestone with status "BILLED" is rejected (direct guard)', async () => {
  const sb = createTestSandbox('sb-2-1')
  try {
    const tenders = readTendersStore(sb.tendersPath)
    tenders.workspaces[0].tenders[0].milestones[0].status = 'BILLED'
    tenders.workspaces[0].tenders[0].milestones[0].billedInvoiceId = 'inv-prior-001'
    writeTendersStore(sb.tendersPath, tenders)

    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, false, 'Billing already BILLED milestone must return ok: false')
    assert(result.error.toLowerCase().includes('already billed'), `Error must state already billed: ${result.error}`)
  } finally {
    sb.cleanup()
  }
})

test('2.2: Milestone with billedInvoiceId set (even if status is REACHED) is rejected', async () => {
  const sb = createTestSandbox('sb-2-2')
  try {
    const tenders = readTendersStore(sb.tendersPath)
    // Tampered state: status says REACHED, but billedInvoiceId is already populated
    tenders.workspaces[0].tenders[0].milestones[0].status = 'REACHED'
    tenders.workspaces[0].tenders[0].milestones[0].billedInvoiceId = 'inv-tampered-123'
    writeTendersStore(sb.tendersPath, tenders)

    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, false, 'Milestone with pre-existing billedInvoiceId must be rejected')
    assert(result.error.toLowerCase().includes('already billed'), `Error must mention already billed: ${result.error}`)
  } finally {
    sb.cleanup()
  }
})

test('2.3: Sequential billing idempotency: second billing attempt returns error', async () => {
  const sb = createTestSandbox('sb-2-3')
  try {
    const firstRun = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(firstRun.result.ok, true, 'First billing must succeed')

    const secondRun = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(secondRun.result.ok, false, 'Second billing attempt must be rejected')
    assert(secondRun.result.error.toLowerCase().includes('already billed'), 'Error must report already billed')
  } finally {
    sb.cleanup()
  }
})

test('2.4: Sequential billing idempotency: Books invoice count remains 1', async () => {
  const sb = createTestSandbox('sb-2-4')
  try {
    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01') // Attempt duplicate

    const books = readBooksStore(sb.booksPath)
    assert.strictEqual(books.invoices.length, 1, 'Invoices collection must contain exactly 1 invoice')
  } finally {
    sb.cleanup()
  }
})

test('2.5: Sequential billing idempotency: Party balance is NOT double-incremented', async () => {
  const sb = createTestSandbox('sb-2-5')
  try {
    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01') // R 145,000
    const booksAfterFirst = readBooksStore(sb.booksPath)
    const partyBalanceFirst = booksAfterFirst.parties[0].outstandingBalance

    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01') // Re-billing rejected
    const booksAfterSecond = readBooksStore(sb.booksPath)
    const partyBalanceSecond = booksAfterSecond.parties[0].outstandingBalance

    assert.strictEqual(partyBalanceSecond, partyBalanceFirst, 'Party balance must not change on duplicate attempt')
    assert.strictEqual(partyBalanceSecond, 145000, 'Party balance must remain exactly 145,000')
  } finally {
    sb.cleanup()
  }
})

test('2.6: Sequential billing idempotency: Ledger accounts not double-posted', async () => {
  const sb = createTestSandbox('sb-2-6')
  try {
    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    const books1 = readBooksStore(sb.booksPath)
    const ar1 = books1.accounts.find((a) => a.id === 'acc-ar').balance
    const sales1 = books1.accounts.find((a) => a.id === 'acc-sales').balance
    const vat1 = books1.accounts.find((a) => a.id === 'acc-vat').balance

    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01') // Duplicate attempt
    const books2 = readBooksStore(sb.booksPath)
    const ar2 = books2.accounts.find((a) => a.id === 'acc-ar').balance
    const sales2 = books2.accounts.find((a) => a.id === 'acc-sales').balance
    const vat2 = books2.accounts.find((a) => a.id === 'acc-vat').balance

    assert.strictEqual(ar2, ar1, 'acc-ar balance must not change on rejected re-billing')
    assert.strictEqual(sales2, sales1, 'acc-sales balance must not change on rejected re-billing')
    assert.strictEqual(vat2, vat1, 'acc-vat balance must not change on rejected re-billing')
  } finally {
    sb.cleanup()
  }
})

test('2.7: Sequential billing idempotency: Journal entries count remains 1', async () => {
  const sb = createTestSandbox('sb-2-7')
  try {
    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01') // Duplicate attempt

    const books = readBooksStore(sb.booksPath)
    assert.strictEqual(books.journalEntries.length, 1, 'Journal entries count must remain exactly 1')
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SUITE 3: REJECTION OF ZERO OR NEGATIVE AMOUNTS
// ============================================================================

test('3.1: Milestone with zero amount is strictly rejected', async () => {
  const sb = createTestSandbox('sb-3-1')
  try {
    const tenders = readTendersStore(sb.tendersPath)
    tenders.workspaces[0].tenders[0].milestones[0].amount = 0
    writeTendersStore(sb.tendersPath, tenders)

    const { result, openBooksCallCount } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, false, 'Billing milestone with amount 0 must return ok: false')
    assert(result.error.includes('greater than 0'), `Error must mention greater than 0: ${result.error}`)
    assert.strictEqual(openBooksCallCount, 0, 'onOpenBooks must not be invoked for zero amount')
  } finally {
    sb.cleanup()
  }
})

test('3.2: Milestone with negative amount is strictly rejected', async () => {
  const sb = createTestSandbox('sb-3-2')
  try {
    const tenders = readTendersStore(sb.tendersPath)
    tenders.workspaces[0].tenders[0].milestones[0].amount = -145000
    writeTendersStore(sb.tendersPath, tenders)

    const { result, openBooksCallCount } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, false, 'Billing milestone with negative amount must return ok: false')
    assert(result.error.includes('greater than 0'), `Error must mention greater than 0: ${result.error}`)
    assert.strictEqual(openBooksCallCount, 0, 'onOpenBooks must not be invoked for negative amount')
  } finally {
    sb.cleanup()
  }
})

test('3.3: Payload override with zero amount is strictly rejected', async () => {
  const sb = createTestSandbox('sb-3-3')
  try {
    const { result } = await executeBillMilestone(sb, {
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      amount: 0,
    })
    assert.strictEqual(result.ok, false, 'Payload amount: 0 override must return ok: false')
    assert(result.error.includes('greater than 0'), `Error must mention greater than 0: ${result.error}`)
  } finally {
    sb.cleanup()
  }
})

test('3.4: Payload override with negative amount is strictly rejected', async () => {
  const sb = createTestSandbox('sb-3-4')
  try {
    const { result } = await executeBillMilestone(sb, {
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      amount: -50000,
    })
    assert.strictEqual(result.ok, false, 'Payload negative amount override must return ok: false')
    assert(result.error.includes('greater than 0'), `Error must mention greater than 0: ${result.error}`)
  } finally {
    sb.cleanup()
  }
})

test('3.5: Fractional cents boundary amount (e.g. 0.05) is accepted and calculates correctly', async () => {
  const sb = createTestSandbox('sb-3-5')
  try {
    const { result } = await executeBillMilestone(sb, {
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      amount: 0.05,
    })
    assert.strictEqual(result.ok, true, 'Small positive amount should succeed')
    assert.strictEqual(result.grandTotal, 0.05, 'grandTotal matches')
    assert.strictEqual(Math.round((result.subtotal + result.taxTotal) * 100) / 100, 0.05, 'VAT invariant holds')
  } finally {
    sb.cleanup()
  }
})

test('3.6: Multi-million contract amount (R 12,500,000.75) processes without numerical distortion', async () => {
  const sb = createTestSandbox('sb-3-6')
  try {
    const { result } = await executeBillMilestone(sb, {
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      amount: 12500000.75,
    })
    assert.strictEqual(result.ok, true, 'Large milestone amount should succeed')
    assert.strictEqual(result.grandTotal, 12500000.75)
    // subtotal = Math.round((12500000.75 / 1.15) * 100) / 100 = 10869565.87
    // taxTotal = Math.round((12500000.75 - 10869565.87) * 100) / 100 = 1630434.88
    assert.strictEqual(result.subtotal, 10869565.87)
    assert.strictEqual(result.taxTotal, 1630434.88)
    assert.strictEqual(Math.round((result.subtotal + result.taxTotal) * 100) / 100, 12500000.75)
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SUITE 4: NON-EXISTENT TENDER ID OR MILESTONE ID
// ============================================================================

test('4.1: Non-existent tender ID returns ok: false with informative error', async () => {
  const sb = createTestSandbox('sb-4-1')
  try {
    const { result, openBooksCallCount } = await executeBillMilestone(sb, 'tender-ghost-999', 'ms-01')
    assert.strictEqual(result.ok, false, 'Non-existent tender ID must return ok: false')
    assert(result.error.includes('Tender not found'), `Error must mention Tender not found: ${result.error}`)
    assert.strictEqual(openBooksCallCount, 0, 'onOpenBooks must NOT be called')
  } finally {
    sb.cleanup()
  }
})

test('4.2: Non-existent milestone ID on valid tender returns ok: false', async () => {
  const sb = createTestSandbox('sb-4-2')
  try {
    const { result, openBooksCallCount } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-ghost-999')
    assert.strictEqual(result.ok, false, 'Non-existent milestone ID must return ok: false')
    assert(result.error.includes('Milestone not found'), `Error must mention Milestone not found: ${result.error}`)
    assert.strictEqual(openBooksCallCount, 0, 'onOpenBooks must NOT be called')
  } finally {
    sb.cleanup()
  }
})

test('4.3: Empty tender ID and milestone ID handled safely without crashing', async () => {
  const sb = createTestSandbox('sb-4-3')
  try {
    const { result } = await executeBillMilestone(sb, '', '')
    assert.strictEqual(result.ok, false, 'Empty IDs must return ok: false')
    assert(result.error.includes('Tender not found'), 'Error must report tender not found')
  } finally {
    sb.cleanup()
  }
})

test('4.4: Tender with empty milestones array returns ok: false gracefully', async () => {
  const sb = createTestSandbox('sb-4-4')
  try {
    const tenders = readTendersStore(sb.tendersPath)
    tenders.workspaces[0].tenders[0].milestones = []
    writeTendersStore(sb.tendersPath, tenders)

    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, false, 'Empty milestones list must return ok: false')
    assert(result.error.includes('Milestone not found'), `Error must report milestone not found: ${result.error}`)
  } finally {
    sb.cleanup()
  }
})

test('4.5: Malformed/null arguments handled safely without unhandled exception', async () => {
  const sb = createTestSandbox('sb-4-5')
  try {
    const { result } = await executeBillMilestone(sb, null, null)
    assert.strictEqual(result.ok, false, 'Null arguments must return ok: false')
    assert(result.error, 'Error message must be present')
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SUITE 5: TENDER REFERENCE & ISSUING AUTHORITY LINKING ONTO TAX INVOICE
// ============================================================================

test('5.1: Created invoice has tenderReference "RFP-WTR-2026-04"', async () => {
  const sb = createTestSandbox('sb-5-1')
  try {
    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.tenderReference, 'RFP-WTR-2026-04')

    const books = readBooksStore(sb.booksPath)
    const inv = books.invoices.find((i) => i.id === result.invoiceId)
    assert(inv, 'Invoice must exist in books-data.json')
    assert.strictEqual(inv.tenderReference, 'RFP-WTR-2026-04', 'invoice.tenderReference matches RFP-WTR-2026-04')
  } finally {
    sb.cleanup()
  }
})

test('5.2: Created invoice has partyName matching issuing authority', async () => {
  const sb = createTestSandbox('sb-5-2')
  try {
    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    const books = readBooksStore(sb.booksPath)
    const inv = books.invoices.find((i) => i.id === result.invoiceId)
    assert.strictEqual(inv.partyName, 'City of Ekurhuleni Water Dept', 'Party name matches tender issuingBody')
  } finally {
    sb.cleanup()
  }
})

test('5.3: Created invoice type is strictly "Sales" and status is "Unpaid"', async () => {
  const sb = createTestSandbox('sb-5-3')
  try {
    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    const books = readBooksStore(sb.booksPath)
    const inv = books.invoices.find((i) => i.id === result.invoiceId)
    assert.strictEqual(inv.type, 'Sales', 'Invoice type is strictly Sales')
    assert.strictEqual(inv.status, 'Unpaid', 'Initial invoice status is Unpaid')
  } finally {
    sb.cleanup()
  }
})

test('5.4: Created invoice grandTotal equals milestone amount (145,000)', async () => {
  const sb = createTestSandbox('sb-5-4')
  try {
    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(result.grandTotal, 145000)

    const books = readBooksStore(sb.booksPath)
    const inv = books.invoices.find((i) => i.id === result.invoiceId)
    assert.strictEqual(inv.grandTotal, 145000)
    assert.strictEqual(inv.outstandingAmount, 145000)
  } finally {
    sb.cleanup()
  }
})

test('5.5: Line item description links milestone title and RFP reference', async () => {
  const sb = createTestSandbox('sb-5-5')
  try {
    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    const books = readBooksStore(sb.booksPath)
    const inv = books.invoices.find((i) => i.id === result.invoiceId)
    assert(inv.items && inv.items.length >= 1, 'Invoice has at least one line item')
    const item = inv.items[0]
    assert.strictEqual(
      item.description,
      'Phase 1 Reservoir Valve Refurbishment per RFP-WTR-2026-04',
      'Line item description formatted as "<milestoneTitle> per <tenderReference>"',
    )
    assert.strictEqual(item.taxRate, 15, 'Tax rate is 15%')
    assert.strictEqual(item.accountId, 'acc-sales', 'Linked to acc-sales')
  } finally {
    sb.cleanup()
  }
})

test('5.6: South African 15% VAT mathematical invariant holds strictly', async () => {
  const sb = createTestSandbox('sb-5-6')
  try {
    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    // Amount: 145000
    // subtotal = Math.round((145000 / 1.15) * 100) / 100 = 126086.96
    // taxTotal = Math.round((145000 - 126086.96) * 100) / 100 = 18913.04
    assert.strictEqual(result.subtotal, 126086.96, 'subtotal matches 126086.96')
    assert.strictEqual(result.taxTotal, 18913.04, 'taxTotal matches 18913.04')
    assert.strictEqual(
      Math.round((result.subtotal + result.taxTotal) * 100) / 100,
      145000,
      'subtotal + taxTotal strictly equals grandTotal',
    )
  } finally {
    sb.cleanup()
  }
})

test('5.7: Issuing authority party auto-created in Books if not previously existing', async () => {
  const sb = createTestSandbox('sb-5-7')
  try {
    const booksBefore = readBooksStore(sb.booksPath)
    assert.strictEqual(booksBefore.parties.length, 0, 'Initially zero parties')

    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')

    const booksAfter = readBooksStore(sb.booksPath)
    assert.strictEqual(booksAfter.parties.length, 1, 'Party created in Books')
    const party = booksAfter.parties[0]
    assert.strictEqual(party.name, 'City of Ekurhuleni Water Dept')
    assert.strictEqual(party.type, 'Customer')
    assert.strictEqual(party.outstandingBalance, 145000)
  } finally {
    sb.cleanup()
  }
})

test('5.8: Existing party in Books is re-used without creating duplicate records', async () => {
  const sb = createTestSandbox('sb-5-8')
  try {
    // Pre-seed the party
    const books = readBooksStore(sb.booksPath)
    books.parties.push({
      id: 'party-ekurhuleni-pre',
      name: 'City of Ekurhuleni Water Dept',
      type: 'Customer',
      email: 'procurement@ekurhuleni.gov.za',
      outstandingBalance: 10000,
    })
    writeBooksStore(sb.booksPath, books)

    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')

    const booksAfter = readBooksStore(sb.booksPath)
    assert.strictEqual(booksAfter.parties.length, 1, 'Still exactly 1 party (no duplicate)')
    const party = booksAfter.parties[0]
    assert.strictEqual(party.id, 'party-ekurhuleni-pre', 'Original party ID preserved')
    assert.strictEqual(party.outstandingBalance, 155000, 'Balance updated: 10000 + 145000 = 155000')
  } finally {
    sb.cleanup()
  }
})

test('5.9: Double-entry ledger accounts properly adjusted', async () => {
  const sb = createTestSandbox('sb-5-9')
  try {
    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')

    const books = readBooksStore(sb.booksPath)
    const accAr = books.accounts.find((a) => a.id === 'acc-ar')
    const accSales = books.accounts.find((a) => a.id === 'acc-sales')
    const accVat = books.accounts.find((a) => a.id === 'acc-vat')

    assert.strictEqual(accAr.balance, 145000, 'acc-ar debited by grandTotal 145000')
    assert.strictEqual(accSales.balance, 126086.96, 'acc-sales credited by subtotal 126086.96')
    assert.strictEqual(accVat.balance, 18913.04, 'acc-vat credited by taxTotal 18913.04')
  } finally {
    sb.cleanup()
  }
})

test('5.10: Journal entry posted and balanced (debits === credits === grandTotal)', async () => {
  const sb = createTestSandbox('sb-5-10')
  try {
    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')

    const books = readBooksStore(sb.booksPath)
    assert.strictEqual(books.journalEntries.length, 1, 'Journal entry created')
    const je = books.journalEntries[0]
    assert.strictEqual(je.posted, true, 'Journal entry marked posted')
    assert.strictEqual(je.totalDebit, 145000, 'totalDebit is 145000')
    assert.strictEqual(je.totalCredit, 145000, 'totalCredit is 145000')
    assert(je.remarks.includes('RFP-WTR-2026-04'), 'Remarks link to RFP-WTR-2026-04')

    // Inspect individual debit/credit line items
    const debitItem = je.items.find((i) => i.accountId === 'acc-ar')
    const salesItem = je.items.find((i) => i.accountId === 'acc-sales')
    const vatItem = je.items.find((i) => i.accountId === 'acc-vat')

    assert.strictEqual(debitItem.debit, 145000)
    assert.strictEqual(debitItem.credit, 0)
    assert.strictEqual(salesItem.debit, 0)
    assert.strictEqual(salesItem.credit, 126086.96)
    assert.strictEqual(vatItem.debit, 0)
    assert.strictEqual(vatItem.credit, 18913.04)
  } finally {
    sb.cleanup()
  }
})

test('5.11: Milestone in tenders-data.json updated to BILLED with billedInvoiceId', async () => {
  const sb = createTestSandbox('sb-5-11')
  try {
    const { result } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    const tenders = readTendersStore(sb.tendersPath)
    const ms = tenders.workspaces[0].tenders[0].milestones[0]

    assert.strictEqual(ms.status, 'BILLED', 'Status updated to BILLED')
    assert.strictEqual(ms.billedInvoiceId, result.invoiceId, 'billedInvoiceId set')
    assert.strictEqual(ms.billedInvoiceNumber, result.invoiceNumber, 'billedInvoiceNumber set')
    assert(ms.billedAt, 'billedAt timestamp recorded')
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SUITE 6: SHELL TAB ACTIVATION CALLBACK TRIGGER
// ============================================================================

test('6.1: onOpenBooks is invoked with invoiceId on successful milestone billing', async () => {
  const sb = createTestSandbox('sb-6-1')
  try {
    const { result, openBooksCallCount, openBooksCalledWith } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')
    assert.strictEqual(openBooksCallCount, 1, 'onOpenBooks called once')
    assert.strictEqual(openBooksCalledWith, result.invoiceId, 'Passed correct invoiceId')
  } finally {
    sb.cleanup()
  }
})

test('6.2: onOpenBooks is NOT invoked when milestone billing fails', async () => {
  const sb = createTestSandbox('sb-6-2')
  try {
    const { openBooksCallCount } = await executeBillMilestone(sb, 'tender-wtr-04', 'ms-02') // PENDING milestone
    assert.strictEqual(openBooksCallCount, 0, 'onOpenBooks must NOT be called on failure')
  } finally {
    sb.cleanup()
  }
})

test('6.3: Direct IPC call tenders:open-books triggers onOpenBooks and returns true', async () => {
  const sb = createTestSandbox('sb-6-3')
  try {
    const { res, openBooksCalled } = await executeOpenBooks(sb)
    assert.strictEqual(res, true, 'tenders:open-books returns true')
    assert.strictEqual(openBooksCalled, true, 'runtime.onOpenBooks invoked')
  } finally {
    sb.cleanup()
  }
})

test('6.4: Direct IPC call tenders:open-books returns false if runtime has no onOpenBooks', async () => {
  const sb = createTestSandbox('sb-6-4')
  try {
    currentMockUserDataDir = sb.root
    configureTendersRuntime({ onOpenBooks: undefined })
    const handler = ipcHandlers.get('tenders:open-books')
    const res = await handler(null)
    assert.strictEqual(res, false, 'Returns false when callback is unconfigured')
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SUITE 7: OBJECT PAYLOAD OVERLOAD & MULTI-WORKSPACE ADVERSARIAL CASES
// ============================================================================

test('7.1: Object payload invocation with tenderReference lookup instead of tenderId', async () => {
  const sb = createTestSandbox('sb-7-1')
  try {
    const { result } = await executeBillMilestone(sb, {
      tenderId: '', // Empty tenderId
      tenderReference: 'RFP-WTR-2026-04', // Match by reference
      milestoneId: 'ms-01',
    })
    assert.strictEqual(result.ok, true, 'Lookup by tenderReference must succeed')
    assert.strictEqual(result.tenderReference, 'RFP-WTR-2026-04')
  } finally {
    sb.cleanup()
  }
})

test('7.2: Custom milestone title and notes in payload properly reflected in Books invoice', async () => {
  const sb = createTestSandbox('sb-7-2')
  try {
    const { result } = await executeBillMilestone(sb, {
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      milestoneTitle: 'Custom Reservoir Refurbishment Phase',
      notes: 'Custom milestone payment instructions Net 15.',
    })
    assert.strictEqual(result.ok, true)

    const books = readBooksStore(sb.booksPath)
    const inv = books.invoices.find((i) => i.id === result.invoiceId)
    assert.strictEqual(
      inv.items[0].description,
      'Custom Reservoir Refurbishment Phase per RFP-WTR-2026-04',
      'Uses custom milestone title in line item',
    )
    assert.strictEqual(inv.notes, 'Custom milestone payment instructions Net 15.', 'Uses custom notes')
  } finally {
    sb.cleanup()
  }
})

test('7.3: Multi-workspace scenario: milestone found in secondary workspace', async () => {
  const sb = createTestSandbox('sb-7-3')
  try {
    const tenders = readTendersStore(sb.tendersPath)
    // Add a second workspace with another tender
    tenders.workspaces.push({
      id: 'ws-secondary-02',
      name: 'Secondary Provincial Water Board',
      tenders: [
        {
          id: 'tender-prov-09',
          title: 'Provincial Pipeline Upgrade',
          referenceNumber: 'RFP-PRV-2026-09',
          issuingBody: 'Provincial Water Authority',
          status: 'IN_PROGRESS',
          milestones: [
            {
              id: 'ms-prov-01',
              title: 'Phase A Groundwork Survey',
              amount: 220000,
              status: 'REACHED',
            },
          ],
        },
      ],
    })
    writeTendersStore(sb.tendersPath, tenders)

    const { result } = await executeBillMilestone(sb, 'tender-prov-09', 'ms-prov-01')
    assert.strictEqual(result.ok, true, 'Milestone in secondary workspace successfully billed')
    assert.strictEqual(result.tenderReference, 'RFP-PRV-2026-09')
    assert.strictEqual(result.grandTotal, 220000)

    const books = readBooksStore(sb.booksPath)
    const inv = books.invoices.find((i) => i.id === result.invoiceId)
    assert.strictEqual(inv.partyName, 'Provincial Water Authority')
  } finally {
    sb.cleanup()
  }
})

test('7.4: Atomic write integrity: no leftover .tmp files in storage directory', async () => {
  const sb = createTestSandbox('sb-7-4')
  try {
    await executeBillMilestone(sb, 'tender-wtr-04', 'ms-01')

    const tendersFiles = readdirSync(sb.tendersDir)
    const tmpTenders = tendersFiles.filter((f) => f.endsWith('.tmp'))
    assert.strictEqual(tmpTenders.length, 0, 'No leftover .tmp files in tenders directory')

    const booksFiles = readdirSync(sb.booksDir)
    const tmpBooks = booksFiles.filter((f) => f.endsWith('.tmp'))
    assert.strictEqual(tmpBooks.length, 0, 'No leftover .tmp files in books directory')
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function runAll() {
  console.log('======================================================================')
  console.log('   EMPIRICAL ADVERSARIAL SUITE — MILESTONE 3 (CHALLENGER 1)')
  console.log('======================================================================')
  console.log(`Executing ${suites.length} adversarial tests...\n`)

  const startTime = Date.now()

  for (const s of suites) {
    totalTests++
    const testStart = Date.now()
    try {
      await s.fn()
      passedTests++
      const elapsed = Date.now() - testStart
      console.log(`  ✅ [PASS] ${s.name} (${elapsed}ms)`)
    } catch (err) {
      failedTests++
      const elapsed = Date.now() - testStart
      failures.push({ name: s.name, error: err })
      console.error(`  ❌ [FAIL] ${s.name} (${elapsed}ms)`)
      console.error(`     Reason: ${err.message}`)
      if (err.stack) {
        const topStack = err.stack.split('\n').slice(1, 3).join('\n')
        console.error(`     ${topStack}`)
      }
    }
  }

  const duration = Date.now() - startTime
  console.log('\n----------------------------------------------------------------------')
  console.log(`Results: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests (${duration}ms)`)
  if (failedTests === 0) {
    console.log('🎉 ALL ADVERSARIAL MILESTONE 3 TESTS PASSED EMPIRICALLY!')
  } else {
    console.error(`⚠️ ${failedTests} TEST(S) FAILED. CHANGES REQUESTED.`)
  }
  console.log('----------------------------------------------------------------------\n')

  process.exit(failedTests === 0 ? 0 : 1)
}

runAll()

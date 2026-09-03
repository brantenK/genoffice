#!/usr/bin/env node
/**
 * tools/test-challenger-m2-empirical.mjs
 *
 * Empirical Adversarial Verification Suite for Milestone 2:
 * CRM to Books Invoicing Bridge Mechanics
 *
 * Requirements tested:
 * 1. Deal eligibility enforcement (rejects 'lead', 'qualified', 'proposal', 'negotiation', 'lost', etc.)
 * 2. Duplicate invoice creation prevention (idempotent, returns existing invoice details without creating a second invoice)
 * 3. Deal back-reference persistence in `deals.json` (`invoiceId`, `invoiceNumber`, `invoicedAt`)
 * 4. Shell tab activation callback trigger (`onOpenBooks` invoked)
 * 5. Double-entry accounting integrity and valuation boundary handling
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
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

// Helper to get a freshly loaded CRM module instance wired to a specific sandbox
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

// Helper to read books store from compiled books module
const booksModule = require('../apps/books/out/main/index.js')
const { readBooksStore, writeBooksStore, CURRENT_BOOKS_SCHEMA_VERSION, CORE_ACCOUNTS, DEFAULT_BOOK_SETTINGS } = booksModule

function createCleanSandbox(prefix = 'm2-challenger-') {
  const root = join(tmpdir(), `${prefix}${randomUUID().slice(0, 8)}`)
  const crmDir = join(root, 'crm')
  const booksDir = join(root, 'books')
  mkdirSync(crmDir, { recursive: true })
  mkdirSync(booksDir, { recursive: true })

  // Initialize books-data.json with standard structure
  const booksData = {
    version: CURRENT_BOOKS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    settings: DEFAULT_BOOK_SETTINGS,
    accounts: CORE_ACCOUNTS.map((a) => ({ ...a })),
    parties: [
      {
        id: 'party-helios',
        name: 'Helios Clean Energy',
        type: 'Customer',
        email: 'accounts@heliosenergy.com',
        outstandingBalance: 50000,
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
console.log('   EMPIRICAL CHALLENGER 1: MILESTONE 2 VERIFICATION SUITE')
console.log('   CRM to Books Invoicing Bridge Adversarial Stress Tests')
console.log('======================================================================\n')

async function main() {
  // =========================================================================
  // SUITE 1: Deal Eligibility Enforcement
  // =========================================================================
  console.log('--- SUITE 1: Deal Eligibility Enforcement ---')

  const nonWonStages = ['lead', 'qualified', 'proposal', 'negotiation', 'lost']
  for (const stage of nonWonStages) {
    await runTest('Eligibility', `Rejects deal with stage '${stage}'`, async () => {
      const sandbox = createCleanSandbox()
      try {
        const dealId = `deal-${stage}-01`
        writeDeals(sandbox.dealsPath, [
          {
            id: dealId,
            name: `Project for ${stage}`,
            companyName: 'Acme Corp',
            amount: 75000,
            stage,
            probability: 20,
          },
        ])

        const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
        const res = await createInvoiceInBooks(dealId)

        assert.strictEqual(res.ok, false, `Stage '${stage}' must not be eligible for invoicing`)
        assert(res.error, 'Error message must be present')
        assert(
          res.error.toLowerCase().includes('not won'),
          `Error message should explain deal is not won, got: "${res.error}"`,
        )

        // Verify NO invoice was created in books
        const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
        assert.strictEqual(books.invoices.length, 0, 'No invoice must be created in books')
        assert.strictEqual(books.journalEntries.length, 0, 'No journal entry must be created in books')
      } finally {
        sandbox.cleanup()
      }
    })
  }

  await runTest('Eligibility', 'Rejects non-existent deal ID', async () => {
    const sandbox = createCleanSandbox()
    try {
      writeDeals(sandbox.dealsPath, [
        { id: 'deal-existing', name: 'Real Deal', companyName: 'Real Co', amount: 50000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks('deal-non-existent-999')

      assert.strictEqual(res.ok, false, 'Non-existent deal must be rejected')
      assert(res.error.includes('not found'), `Error must state deal not found, got: "${res.error}"`)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Eligibility', 'Rejects unknown/invalid stages (e.g. pending, archived, empty)', async () => {
    const sandbox = createCleanSandbox()
    try {
      const invalidDeals = [
        { id: 'deal-pending', name: 'Pending Deal', stage: 'pending', amount: 20000 },
        { id: 'deal-archived', name: 'Archived Deal', stage: 'archived', amount: 30000 },
        { id: 'deal-empty', name: 'Empty Stage Deal', stage: '', amount: 40000 },
      ]
      writeDeals(sandbox.dealsPath, invalidDeals)

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      for (const d of invalidDeals) {
        const res = await createInvoiceInBooks(d.id)
        assert.strictEqual(res.ok, false, `Stage '${d.stage}' must be rejected`)
      }
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Eligibility', 'Strictly accepts stage "won" and succeeds', async () => {
    const sandbox = createCleanSandbox()
    try {
      writeDeals(sandbox.dealsPath, [
        { id: 'deal-legit-won', name: 'Legit Opportunity', companyName: 'Helios Clean Energy', amount: 115000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks('deal-legit-won')

      assert.strictEqual(res.ok, true, 'Won deal must be accepted')
      assert(res.invoiceNumber, 'invoiceNumber must be returned')
      assert(res.invoiceId, 'invoiceId must be returned')
      assert(res.invoiceNumber.startsWith('INV-'), 'invoiceNumber must start with INV-')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Eligibility', 'Deal progression from negotiation to won unlocks invoicing', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-progression'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Dynamic Contract', companyName: 'Helios Clean Energy', amount: 230000, stage: 'negotiation' },
      ])

      const { crm, createInvoiceInBooks } = loadFreshCrm(sandbox.root)

      // 1. Rejected while negotiation
      const res1 = await createInvoiceInBooks(dealId)
      assert.strictEqual(res1.ok, false, 'Rejected while negotiation')

      // 2. Stage updated to won
      crm.registerCrmIpc()
      const updateHandler = ipcHandlers.get('crm:update-deal-stage')
      await updateHandler(null, dealId, 'won')

      // 3. Now invoicing succeeds
      const res2 = await createInvoiceInBooks(dealId)
      assert.strictEqual(res2.ok, true, 'Succeeds once won')
      assert(res2.invoiceNumber, 'Invoice number generated')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 2: Duplicate Invoice Creation Prevention (Idempotence)
  // =========================================================================
  console.log('\n--- SUITE 2: Duplicate Invoice Creation Prevention (Idempotence) ---')

  await runTest('Idempotence', 'Repeated sequential calls return identical invoice details without duplicating records', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-idempotent-seq'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Enterprise License', companyName: 'Helios Clean Energy', amount: 115000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)

      // First call
      const res1 = await createInvoiceInBooks(dealId)
      assert.strictEqual(res1.ok, true, 'First call succeeds')
      const invNum1 = res1.invoiceNumber
      const invId1 = res1.invoiceId

      // Second call
      const res2 = await createInvoiceInBooks(dealId)
      assert.strictEqual(res2.ok, true, 'Second call returns ok: true')
      assert.strictEqual(res2.invoiceNumber, invNum1, 'Second call returns identical invoiceNumber')
      assert.strictEqual(res2.invoiceId, invId1, 'Second call returns identical invoiceId')

      // Third call
      const res3 = await createInvoiceInBooks(dealId)
      assert.strictEqual(res3.ok, true, 'Third call returns ok: true')
      assert.strictEqual(res3.invoiceNumber, invNum1, 'Third call returns identical invoiceNumber')

      // Verify books data on disk: exactly 1 invoice and 1 journal entry
      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 1, 'Exactly 1 invoice in books store')
      assert.strictEqual(books.journalEntries.length, 1, 'Exactly 1 journal entry in books store')

      // Verify ledger was debited/credited only once (initial acc-ar is 195,500)
      const arAcc = books.accounts.find((a) => a.id === 'acc-ar')
      const salesAcc = books.accounts.find((a) => a.id === 'acc-sales')
      const vatAcc = books.accounts.find((a) => a.id === 'acc-vat')
      assert.strictEqual(arAcc.balance, 195500 + 115000, 'acc-ar only debited once (195500 + 115000 = 310500)')
      assert.strictEqual(salesAcc.balance, 820000 + 100000, 'acc-sales only credited once (820000 + 100000 = 920000)')
      assert.strictEqual(vatAcc.balance, 38400 + 15000, 'acc-vat only credited once (38400 + 15000 = 53400)')

      // Verify party balance only incremented once
      const party = books.parties.find((p) => p.name === 'Helios Clean Energy')
      assert.strictEqual(party.outstandingBalance, 50000 + 115000, 'Party balance only incremented once')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Idempotence', 'Pre-existing invoiceNumber on deal immediately returns existing info', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-preinvoiced-num'
      writeDeals(sandbox.dealsPath, [
        {
          id: dealId,
          name: 'Prior Work Deal',
          companyName: 'Acme Corp',
          amount: 50000,
          stage: 'won',
          invoiceNumber: 'INV-2026-999',
          invoiceId: 'inv-pre-999',
          invoicedAt: '2026-08-01T10:00:00.000Z',
        },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)

      assert.strictEqual(res.ok, true, 'Pre-invoiced deal returns ok: true')
      assert.strictEqual(res.invoiceNumber, 'INV-2026-999', 'Returns pre-existing invoiceNumber')
      assert.strictEqual(res.invoiceId, 'inv-pre-999', 'Returns pre-existing invoiceId')

      // Verify books data was untouched
      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 0, 'No invoice added to books store')
      assert.strictEqual(books.journalEntries.length, 0, 'No journal entry added to books store')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Idempotence', 'Pre-existing invoiceId on deal immediately returns existing info', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-preinvoiced-id'
      writeDeals(sandbox.dealsPath, [
        {
          id: dealId,
          name: 'Partial Invoiced Deal',
          companyName: 'Acme Corp',
          amount: 45000,
          stage: 'won',
          invoiceId: 'inv-only-123',
        },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)

      assert.strictEqual(res.ok, true, 'Returns ok: true')
      assert.strictEqual(res.invoiceId, 'inv-only-123', 'Returns pre-existing invoiceId')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 0, 'No invoice added to books store')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Idempotence', 'Rapid burst of 10 calls on the same deal maintains single invoice and balanced books', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-burst-test'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Burst Contract', companyName: 'Helios Clean Energy', amount: 57500, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)

      const results = []
      for (let i = 0; i < 10; i++) {
        results.push(await createInvoiceInBooks(dealId))
      }

      // All calls must succeed
      for (const r of results) {
        assert.strictEqual(r.ok, true, 'All burst calls must succeed')
        assert.strictEqual(r.invoiceNumber, results[0].invoiceNumber, 'All invoice numbers match')
        assert.strictEqual(r.invoiceId, results[0].invoiceId, 'All invoice IDs match')
      }

      // Verify books state
      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 1, 'Burst produced exactly 1 invoice')
      assert.strictEqual(books.journalEntries.length, 1, 'Burst produced exactly 1 journal entry')

      const ar = books.accounts.find((a) => a.id === 'acc-ar').balance
      const sales = books.accounts.find((a) => a.id === 'acc-sales').balance
      const vat = books.accounts.find((a) => a.id === 'acc-vat').balance
      assert.strictEqual(ar, 195500 + 57500, 'acc-ar correct (195500 + 57500 = 253000)')
      assert.strictEqual(sales, 820000 + 50000, 'acc-sales correct (820000 + 50000 = 870000)')
      assert.strictEqual(vat, 38400 + 7500, 'acc-vat correct (38400 + 7500 = 45900)')
      assert.strictEqual(ar - 195500, (sales - 820000) + (vat - 38400), 'Double-entry balance delta strictly balances')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 3: Deal Back-Reference Persistence in deals.json
  // =========================================================================
  console.log('\n--- SUITE 3: Deal Back-Reference Persistence in deals.json ---')

  await runTest('Persistence', 'Persists invoiceId, invoiceNumber, invoicedAt onto target deal in deals.json', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-backref-verify'
      writeDeals(sandbox.dealsPath, [
        {
          id: dealId,
          name: 'Solar Grid Microgeneration',
          companyName: 'Helios Clean Energy',
          amount: 80500,
          stage: 'won',
          probability: 100,
          expectedCloseDate: '2026-09-15',
          notes: 'Important solar grid contract',
        },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)

      assert.strictEqual(res.ok, true, 'Invoice creation succeeded')

      // Read deals.json directly from disk
      const rawCrm = readFileSync(sandbox.dealsPath, 'utf8')
      const crmEnvelope = JSON.parse(rawCrm)
      assert.strictEqual(crmEnvelope.version, 1, 'Deals envelope version is 1')
      assert(typeof crmEnvelope.updatedAt === 'string', 'Envelope has updatedAt')

      const dealOnDisk = crmEnvelope.deals.find((d) => d.id === dealId)
      assert(dealOnDisk, 'Deal must exist in deals.json on disk')

      // Verify back-reference fields
      assert.strictEqual(dealOnDisk.invoiceId, res.invoiceId, 'invoiceId matches returned ID')
      assert.strictEqual(dealOnDisk.invoiceNumber, res.invoiceNumber, 'invoiceNumber matches returned number')
      assert(typeof dealOnDisk.invoicedAt === 'string', 'invoicedAt must be string')
      const parsedDate = new Date(dealOnDisk.invoicedAt)
      assert(!isNaN(parsedDate.getTime()), 'invoicedAt must be valid date timestamp')
      assert(
        Math.abs(Date.now() - parsedDate.getTime()) < 60000,
        'invoicedAt timestamp should be within the last minute',
      )

      // Verify other fields were NOT lost
      assert.strictEqual(dealOnDisk.name, 'Solar Grid Microgeneration', 'Deal name preserved')
      assert.strictEqual(dealOnDisk.companyName, 'Helios Clean Energy', 'Company name preserved')
      assert.strictEqual(dealOnDisk.amount, 80500, 'Amount preserved')
      assert.strictEqual(dealOnDisk.stage, 'won', 'Stage preserved')
      assert.strictEqual(dealOnDisk.expectedCloseDate, '2026-09-15', 'Close date preserved')
      assert.strictEqual(dealOnDisk.notes, 'Important solar grid contract', 'Notes preserved')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Persistence', 'Untouched neighbor deals in deals.json remain completely intact', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deals = [
        { id: 'deal-other-1', name: 'Neighbor Lead', amount: 10000, stage: 'lead', notes: 'Untouched lead' },
        { id: 'deal-target-won', name: 'Target Won Deal', amount: 50000, stage: 'won', companyName: 'Helios Clean Energy' },
        { id: 'deal-other-2', name: 'Neighbor Lost', amount: 20000, stage: 'lost', notes: 'Untouched lost' },
      ]
      writeDeals(sandbox.dealsPath, deals)

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks('deal-target-won')
      assert.strictEqual(res.ok, true, 'Invoice created')

      // Inspect disk
      const crmAfter = JSON.parse(readFileSync(sandbox.dealsPath, 'utf8'))
      assert.strictEqual(crmAfter.deals.length, 3, 'Total deals count must remain 3')

      const d1 = crmAfter.deals.find((d) => d.id === 'deal-other-1')
      assert.strictEqual(d1.name, 'Neighbor Lead')
      assert.strictEqual(d1.stage, 'lead')
      assert.strictEqual(d1.invoiceId, undefined, 'Neighbor deal has no invoiceId')

      const d2 = crmAfter.deals.find((d) => d.id === 'deal-other-2')
      assert.strictEqual(d2.name, 'Neighbor Lost')
      assert.strictEqual(d2.stage, 'lost')
      assert.strictEqual(d2.invoiceId, undefined, 'Neighbor deal has no invoiceId')

      const dTarget = crmAfter.deals.find((d) => d.id === 'deal-target-won')
      assert.strictEqual(dTarget.invoiceId, res.invoiceId)
      assert.strictEqual(dTarget.invoiceNumber, res.invoiceNumber)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Persistence', 'Survives cold store reload from disk and confirms no stray .tmp files', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-cold-reload'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Cold Reload Opportunity', amount: 100000, stage: 'won', companyName: 'Helios Clean Energy' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true)

      // Cold reload: re-read deals using a completely fresh require and CrmStore instance
      const { crm } = loadFreshCrm(sandbox.root)
      const reloadedStore = new crm.CrmStore(sandbox.root)
      const reloadedDeal = reloadedStore.getDeals().find((d) => d.id === dealId)

      assert(reloadedDeal, 'Deal must be found on fresh cold store instance')
      assert.strictEqual(reloadedDeal.invoiceId, res.invoiceId, 'Cold-reloaded invoiceId matches')
      assert.strictEqual(reloadedDeal.invoiceNumber, res.invoiceNumber, 'Cold-reloaded invoiceNumber matches')
      assert(reloadedDeal.invoicedAt, 'Cold-reloaded invoicedAt exists')

      // Check for leftover temporary files in crmDir and booksDir
      const crmFiles = readdirSync(sandbox.crmDir)
      const booksFiles = readdirSync(sandbox.booksDir)
      const tmpCrmFiles = crmFiles.filter((f) => f.endsWith('.tmp') || f.includes('.tmp.'))
      const tmpBooksFiles = booksFiles.filter((f) => f.endsWith('.tmp') || f.includes('.tmp.'))

      assert.strictEqual(tmpCrmFiles.length, 0, `No leftover tmp files in crm directory: ${tmpCrmFiles.join(', ')}`)
      assert.strictEqual(tmpBooksFiles.length, 0, `No leftover tmp files in books directory: ${tmpBooksFiles.join(', ')}`)
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 4: Shell Tab Activation Callback Trigger (onOpenBooks)
  // =========================================================================
  console.log('\n--- SUITE 4: Shell Tab Activation Callback Trigger (onOpenBooks) ---')

  await runTest('Tab Activation', 'Invokes onOpenBooks callback when invoice is successfully created', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-trigger-success'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Tab Switch Opportunity', companyName: 'Helios Clean Energy', amount: 46000, stage: 'won' },
      ])

      let onOpenBooksCallCount = 0
      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root, {
        onOpenBooks: () => {
          onOpenBooksCallCount++
        },
      })

      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true, 'Invoice created')
      assert.strictEqual(onOpenBooksCallCount, 1, 'onOpenBooks must be called exactly once on success')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Tab Activation', 'Does NOT invoke onOpenBooks callback when invoice creation fails (non-won stage)', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-trigger-failure'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Lost Deal', companyName: 'Helios Clean Energy', amount: 46000, stage: 'lost' },
      ])

      let onOpenBooksCallCount = 0
      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root, {
        onOpenBooks: () => {
          onOpenBooksCallCount++
        },
      })

      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, false, 'Invoice creation rejected')
      assert.strictEqual(onOpenBooksCallCount, 0, 'onOpenBooks must NOT be called on failure')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Tab Activation', 'Direct IPC call to crm:open-books invokes runtime.onOpenBooks and returns true', async () => {
    const sandbox = createCleanSandbox()
    try {
      let callbackInvoked = false
      const { openBooks } = loadFreshCrm(sandbox.root, {
        onOpenBooks: () => {
          callbackInvoked = true
        },
      })

      const result = await openBooks()
      assert.strictEqual(result, true, 'crm:open-books must return true when configured')
      assert.strictEqual(callbackInvoked, true, 'runtime.onOpenBooks must be executed')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Tab Activation', 'Direct IPC call to crm:open-books returns false when onOpenBooks unconfigured', async () => {
    const sandbox = createCleanSandbox()
    try {
      const { openBooks } = loadFreshCrm(sandbox.root, {}) // unconfigured
      const result = await openBooks()
      assert.strictEqual(result, false, 'Returns false safely when onOpenBooks is not configured')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Tab Activation', 'Invoicing succeeds cleanly without crash when onOpenBooks is unconfigured', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-no-callback'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'No Callback Deal', companyName: 'Helios Clean Energy', amount: 30000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root, {}) // No onOpenBooks
      const res = await createInvoiceInBooks(dealId)

      assert.strictEqual(res.ok, true, 'Invoicing succeeds even if onOpenBooks is not configured')
      assert(res.invoiceNumber, 'invoiceNumber present')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 5: Double-Entry Ledger, VAT & Valuation Boundaries
  // =========================================================================
  console.log('\n--- SUITE 5: Double-Entry Ledger, VAT & Valuation Boundaries ---')

  await runTest('Valuation & Ledger', 'Standard 15% VAT calculation: 115,000 valuation -> 100,000 subtotal, 15,000 tax', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-vat-std'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Standard VAT Deal', companyName: 'Helios Clean Energy', amount: 115000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices.find((i) => i.id === res.invoiceId)
      assert(inv, 'Invoice exists')
      assert.strictEqual(inv.grandTotal, 115000)
      assert.strictEqual(inv.subtotal, 100000)
      assert.strictEqual(inv.taxTotal, 15000)
      assert.strictEqual(inv.subtotal + inv.taxTotal, inv.grandTotal, 'Penny-exact balance')
      assert.strictEqual(inv.type, 'Sales')
      assert.strictEqual(inv.status, 'Unpaid')
      assert.strictEqual(inv.crmDealId, dealId)
      assert(inv.items[0].description.includes('Standard VAT Deal'))
      assert.strictEqual(inv.notes, 'Payment terms: Net 30 days upon invoice receipt.')

      const je = books.journalEntries[0]
      assert(je, 'Journal entry exists')
      assert.strictEqual(je.totalDebit, 115000)
      assert.strictEqual(je.totalCredit, 115000)
      assert.strictEqual(je.posted, true)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Valuation & Ledger', 'Fractional valuation (4,999.99): penny-exact balance', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-fractional'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Fractional Cents Deal', companyName: 'Helios Clean Energy', amount: 4999.99, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices.find((i) => i.id === res.invoiceId)
      assert.strictEqual(inv.grandTotal, 4999.99)
      assert.strictEqual(Math.round((inv.subtotal + inv.taxTotal) * 100) / 100, inv.grandTotal)

      const ar = books.accounts.find((a) => a.id === 'acc-ar').balance
      const sales = books.accounts.find((a) => a.id === 'acc-sales').balance
      const vat = books.accounts.find((a) => a.id === 'acc-vat').balance
      const deltaAr = Math.round((ar - 195500) * 100) / 100
      const deltaSales = Math.round((sales - 820000) * 100) / 100
      const deltaVat = Math.round((vat - 38400) * 100) / 100
      assert.strictEqual(deltaAr, 4999.99)
      assert.strictEqual(Math.round((deltaSales + deltaVat) * 100) / 100, deltaAr)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Valuation & Ledger', 'Zero valuation deal (amount = 0) completes safely', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-zero-val'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Pro Bono Implementation', companyName: 'Helios Clean Energy', amount: 0, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices.find((i) => i.id === res.invoiceId)
      assert.strictEqual(inv.grandTotal, 0)
      assert.strictEqual(inv.subtotal, 0)
      assert.strictEqual(inv.taxTotal, 0)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Valuation & Ledger', 'Large enterprise valuation (R 100,000,000.00) balances without precision failure', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-enterprise-100m'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'National Grid Infrastructure', companyName: 'Helios Clean Energy', amount: 100000000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices.find((i) => i.id === res.invoiceId)
      assert.strictEqual(inv.grandTotal, 100000000)
      assert.strictEqual(inv.subtotal + inv.taxTotal, inv.grandTotal)
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Valuation & Ledger', 'Auto-creates customer party in Books when counterparty does not exist', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-new-party'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'New Client Project', companyName: 'Apex Robotics Corp', amount: 50000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const party = books.parties.find((p) => p.name === 'Apex Robotics Corp')
      assert(party, 'New party must be auto-created in Books')
      assert.strictEqual(party.type, 'Customer')
      assert.strictEqual(party.outstandingBalance, 50000)
      assert(party.email.includes('apexroboticscorp.com') || party.email.includes('@'), 'Party email auto-generated')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Valuation & Ledger', 'Graceful fallback when deal companyName is missing (uses deal.name)', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-no-company'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Solo Contractor Services', amount: 25000, stage: 'won' }, // no companyName
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices.find((i) => i.id === res.invoiceId)
      assert.strictEqual(inv.partyName, 'Solo Contractor Services', 'Party name falls back to deal.name')
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUITE 6: Deep Adversarial Edge Cases & Stress Attacks
  // =========================================================================
  console.log('\n--- SUITE 6: Deep Adversarial Edge Cases & Stress Attacks ---')

  await runTest('Adversarial Stress', 'Special characters, quotes, unicode, and injection tokens in deal & company names', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-adversarial-chars'
      const complexName = 'Contract "Alpha" <script>alert(1)</script> \n / \\ & 🚀 \u00A0 \u200B'
      const complexCompany = 'Acme & Son\'s "Mega-Corp" / (Pty) Ltd. \u2705'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: complexName, companyName: complexCompany, amount: 69000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true, 'Complex strings handle without syntax error')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices.find((i) => i.id === res.invoiceId)
      assert(inv, 'Invoice created with complex strings')
      assert.strictEqual(inv.partyName, complexCompany, 'Party name preserved accurately')
      assert(inv.items[0].description.includes(complexName), 'Item description preserved accurately')

      const crmAfter = JSON.parse(readFileSync(sandbox.dealsPath, 'utf8'))
      const dealAfter = crmAfter.deals.find((d) => d.id === dealId)
      assert.strictEqual(dealAfter.name, complexName, 'Deal name unchanged in CRM deals.json')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Adversarial Stress', 'Handles completely missing books-data.json file cleanly', async () => {
    const sandbox = createCleanSandbox()
    try {
      // Remove books-data.json so it does not exist
      rmSync(sandbox.booksPath, { force: true })

      const dealId = 'deal-missing-books'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Cold Store Bootstrap Deal', companyName: 'Helios Clean Energy', amount: 115000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true, 'Succeeds even if books-data.json did not exist beforehand')

      assert(existsSync(sandbox.booksPath), 'books-data.json was created on the fly')
      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 1, 'Invoice saved into freshly created books store')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Adversarial Stress', 'Handles corrupted books-data.json by backing up to .corrupted.bak and recovering', async () => {
    const sandbox = createCleanSandbox()
    try {
      // Write corrupted garbage into books-data.json
      writeFileSync(sandbox.booksPath, '{"version": 1, "accounts": [TRUNCATED_GARBAGE', 'utf8')

      const dealId = 'deal-corrupt-recovery'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Corruption Recovery Deal', companyName: 'Helios Clean Energy', amount: 57500, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true, 'Recovers gracefully from corrupted books store')

      const bakPath = `${sandbox.booksPath}.corrupted.bak`
      assert(existsSync(bakPath), '.corrupted.bak must be preserved')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 1, 'Invoice written to healed books store')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Adversarial Stress', 'Multiple sequential deals generate strictly monotonic invoice numbers', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deals = [
        { id: 'deal-seq-1', name: 'Phase 1', amount: 10000, stage: 'won', companyName: 'Helios Clean Energy' },
        { id: 'deal-seq-2', name: 'Phase 2', amount: 20000, stage: 'won', companyName: 'Helios Clean Energy' },
        { id: 'deal-seq-3', name: 'Phase 3', amount: 30000, stage: 'won', companyName: 'Helios Clean Energy' },
      ]
      writeDeals(sandbox.dealsPath, deals)

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res1 = await createInvoiceInBooks('deal-seq-1')
      const res2 = await createInvoiceInBooks('deal-seq-2')
      const res3 = await createInvoiceInBooks('deal-seq-3')

      assert.strictEqual(res1.ok, true)
      assert.strictEqual(res2.ok, true)
      assert.strictEqual(res3.ok, true)

      const year = new Date().getFullYear()
      assert.strictEqual(res1.invoiceNumber, `INV-${year}-001`)
      assert.strictEqual(res2.invoiceNumber, `INV-${year}-002`)
      assert.strictEqual(res3.invoiceNumber, `INV-${year}-003`)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      assert.strictEqual(books.invoices.length, 3, 'All 3 invoices recorded in Books')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Adversarial Stress', 'Case-insensitive party matching reuses existing party without duplication', async () => {
    const sandbox = createCleanSandbox()
    try {
      // In sandbox, initial party name is 'Helios Clean Energy'
      // Pass deal with lowercase / uppercase casing
      const dealId = 'deal-case-party'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Rebranding Deal', companyName: 'helios clean energy', amount: 46000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true)

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const matchingParties = books.parties.filter((p) => p.name.toLowerCase() === 'helios clean energy')
      assert.strictEqual(matchingParties.length, 1, 'Did not create duplicate party with different casing')
      assert.strictEqual(matchingParties[0].id, 'party-helios', 'Reused original party ID')
      assert.strictEqual(matchingParties[0].outstandingBalance, 50000 + 46000, 'Updated existing party balance')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Adversarial Stress', 'Accumulates outstanding balances accurately across multiple deals for same customer', async () => {
    const sandbox = createCleanSandbox()
    try {
      const deals = [
        { id: 'deal-acc-1', name: 'Contract A', companyName: 'Helios Clean Energy', amount: 23000, stage: 'won' },
        { id: 'deal-acc-2', name: 'Contract B', companyName: 'Helios Clean Energy', amount: 46000, stage: 'won' },
      ]
      writeDeals(sandbox.dealsPath, deals)

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      await createInvoiceInBooks('deal-acc-1')
      await createInvoiceInBooks('deal-acc-2')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const party = books.parties.find((p) => p.id === 'party-helios')
      // initial 50,000 + 23,000 + 46,000 = 119,000
      assert.strictEqual(party.outstandingBalance, 119000, 'Outstanding balance cumulative total matches')
    } finally {
      sandbox.cleanup()
    }
  })

  await runTest('Adversarial Stress', 'Negative amount deal clamped to zero and creates balanced zero invoice', async () => {
    const sandbox = createCleanSandbox()
    try {
      const dealId = 'deal-neg-amount'
      writeDeals(sandbox.dealsPath, [
        { id: dealId, name: 'Negative Deal', companyName: 'Helios Clean Energy', amount: -25000, stage: 'won' },
      ])

      const { createInvoiceInBooks } = loadFreshCrm(sandbox.root)
      const res = await createInvoiceInBooks(dealId)
      assert.strictEqual(res.ok, true, 'Sanitizes negative amount without crashing')

      const books = JSON.parse(readFileSync(sandbox.booksPath, 'utf8'))
      const inv = books.invoices.find((i) => i.id === res.invoiceId)
      assert.strictEqual(inv.grandTotal, 0, 'Negative amount clamped to 0')
      assert.strictEqual(inv.subtotal, 0)
      assert.strictEqual(inv.taxTotal, 0)
    } finally {
      sandbox.cleanup()
    }
  })

  // =========================================================================
  // SUMMARY & RESULTS
  // =========================================================================
  console.log('\n======================================================================')
  console.log(`RESULTS: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  if (failedTests > 0) {
    console.log('STATUS: VERIFICATION FAILED')
    console.log('\nFailure Details:')
    for (const f of failures) {
      console.log(`  - [${f.suite}] ${f.name}: ${f.error}`)
    }
    process.exit(1)
  } else {
    console.log('STATUS: VERIFICATION SUCCESSFUL (100% PASS)')
    console.log('======================================================================')
    process.exit(0)
  }
}

main().catch((err) => {
  console.error('Fatal test runner failure:', err)
  process.exit(1)
})

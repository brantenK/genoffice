#!/usr/bin/env node
/**
 * tools/adversarial-milestone1-resilience.mjs
 *
 * Adversarial Empirical Verification Suite for Milestone 1:
 * - CRM deals.json & Tenders tenders-data.json data resilience
 * - Corrupted JSON parsing & .corrupted.bak creation
 * - External sync deal merge (deduplication & user entry preservation)
 * - Schema migration from legacy v0 naked arrays to v1 envelope
 * - Extreme deal values and clamping (amount 0, 1e9, negative clamping, probability 0-100)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Mock Electron IPC & App for testing tenders:sync-with-crm
const ipcHandlers = new Map()
let mockUserDataDir = ''

require.cache[require.resolve('electron')] = {
  exports: {
    app: {
      getPath: (name) => {
        if (name === 'userData') return mockUserDataDir
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

// Import compiled main modules AFTER electron mock is installed
const crm = require('../apps/crm/out/main/index.js')
const tenders = require('../apps/tenders/out/main/index.js')
const books = require('../apps/books/out/main/index.js')

// Register tenders IPC to wire the mock
tenders.registerTendersIpc()
const syncWithCrmHandler = ipcHandlers.get('tenders:sync-with-crm')

// Test framework utilities
let totalTests = 0
let passedTests = 0
let failedTests = 0
const failureDetails = []

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed')
  }
}

async function test(name, fn) {
  totalTests++
  process.stdout.write(`  [TEST ${totalTests}] ${name}... `)
  try {
    await fn()
    passedTests++
    console.log('PASSED')
  } catch (err) {
    failedTests++
    console.log('FAILED')
    console.error(`    -> ${err.message}`)
    failureDetails.push({ test: name, error: err.message, stack: err.stack })
  }
}

function createTempDir(prefix = 'adv-m1-') {
  const dir = join(tmpdir(), `${prefix}${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

console.log('======================================================================')
console.log('   ADVERSARIAL EMPIRICAL TEST SUITE: MILESTONE 1 RESILIENCE')
console.log('======================================================================\n')

async function runAllTests() {
  // =========================================================================
  // SUITE 1: Corrupted JSON Parsing & Backup Resilience
  // =========================================================================
  console.log('--- SUITE 1: Corrupted JSON Parsing & Backup Resilience ---')

  await test('CRM: Corrupted syntax in deals.json generates .corrupted.bak and does not crash', () => {
    const dir = createTempDir('crm-corrupt-')
    const filePath = join(dir, 'deals.json')
    const corruptedContent = '{"version": 1, "deals": [ {"id": "deal-99", "name": "Broken'
    writeFileSync(filePath, corruptedContent, 'utf8')

    const fallback = [{ id: 'deal-fallback-1', name: 'Safe Fallback', amount: 5000, stage: 'lead', probability: 20 }]
    const result = crm.readDealsStore(dir, fallback)

    const bakPath = `${filePath}.corrupted.bak`
    assert(existsSync(bakPath), `Backup file .corrupted.bak should exist at ${bakPath}`)
    const bakContent = readFileSync(bakPath, 'utf8')
    assert(bakContent === corruptedContent, 'Backup file content should match corrupted content verbatim')

    // Verify original file on disk was NOT wiped or emptied by readDealsStore
    const diskContent = readFileSync(filePath, 'utf8')
    assert(diskContent === corruptedContent, 'Original deals.json on disk must NOT be overwritten or emptied by read operation')

    // Verify in-memory return has safe schema and fallback data
    assert(result.version === crm.CURRENT_DEALS_SCHEMA_VERSION, `Expected version ${crm.CURRENT_DEALS_SCHEMA_VERSION}`)
    assert(result.deals.length === 1, 'Expected 1 fallback deal returned')
    assert(result.deals[0].id === 'deal-fallback-1', 'Fallback deal ID mismatch')

    rmSync(dir, { recursive: true, force: true })
  })

  await test('CRM: Mangled JSON payload (e.g. 502 Bad Gateway HTML) in deals.json creates .corrupted.bak and preserves state', () => {
    const dir = createTempDir('crm-mangled-')
    const filePath = join(dir, 'deals.json')
    const mangledContent = '<!DOCTYPE html>\n<html><head><title>502 Bad Gateway</title></head>\n<body>Server Error: Unparseable JSON</body></html>'
    writeFileSync(filePath, mangledContent, 'utf8')

    const fallback = [{ id: 'd-safe', name: 'Safe Deal', amount: 1000, stage: 'proposal', probability: 50 }]
    const result = crm.readDealsStore(dir, fallback)

    const bakPath = `${filePath}.corrupted.bak`
    assert(existsSync(bakPath), 'Backup file .corrupted.bak must exist')
    const bakData = readFileSync(bakPath, 'utf8')
    assert(bakData === mangledContent, 'Backup content must match original mangled content verbatim')
    assert(result.deals[0].id === 'd-safe', 'Fallback deal should be returned')

    rmSync(dir, { recursive: true, force: true })
  })

  await test('CRM: Zero-byte empty deals.json creates .corrupted.bak and returns safe fallback', () => {
    const dir = createTempDir('crm-empty-')
    const filePath = join(dir, 'deals.json')
    writeFileSync(filePath, '', 'utf8')

    const fallback = [{ id: 'd-fallback', name: 'Fallback', amount: 2000, stage: 'lead', probability: 20 }]
    const result = crm.readDealsStore(dir, fallback)

    const bakPath = `${filePath}.corrupted.bak`
    assert(existsSync(bakPath), 'Backup file .corrupted.bak must exist for empty file')
    assert(readFileSync(bakPath, 'utf8') === '', 'Backup content must be empty string')
    assert(result.deals[0].id === 'd-fallback', 'Fallback deal must be returned')

    rmSync(dir, { recursive: true, force: true })
  })

  await test('CRM: CrmStore class initialization on corrupted deals.json does not crash and preserves .corrupted.bak', () => {
    const dir = createTempDir('crm-store-corrupt-')
    // CrmStore expects userData dir where userData/crm holds files
    const crmDir = join(dir, 'crm')
    mkdirSync(crmDir, { recursive: true })
    const filePath = join(crmDir, 'deals.json')
    const corruptedContent = '<<<INVALID JSON XML TAGS>>>'
    writeFileSync(filePath, corruptedContent, 'utf8')

    // Instantiate CrmStore
    const store = new crm.CrmStore(dir)
    const envelope = store.getDealsEnvelope()

    assert(existsSync(`${filePath}.corrupted.bak`), 'deals.json.corrupted.bak should exist')
    assert(envelope.version === 1, 'Envelope version must be 1')
    assert(Array.isArray(envelope.deals), 'Deals must be an array')
    // When corrupted, CrmStore uses SEED_DEALS as fallback
    assert(envelope.deals.length > 0, 'Deals should contain seed deals as fallback')

    rmSync(dir, { recursive: true, force: true })
  })

  await test('Tenders: Corrupted tenders-data.json creates .corrupted.bak and returns safe envelope', () => {
    const dir = createTempDir('tenders-corrupt-')
    const filePath = join(dir, 'tenders-data.json')
    const corruptedContent = '{"version": 1, "workspaces": [{"id": '
    writeFileSync(filePath, corruptedContent, 'utf8')

    const result = tenders.readTendersStore(dir)
    const bakPath = `${filePath}.corrupted.bak`

    assert(existsSync(bakPath), `Expected ${bakPath} to exist`)
    assert(readFileSync(bakPath, 'utf8') === corruptedContent, 'Backup content should match corrupted content')
    assert(readFileSync(filePath, 'utf8') === corruptedContent, 'Original file must not be wiped')
    assert(result.version === tenders.CURRENT_TENDERS_SCHEMA_VERSION, 'Expected version 1')
    assert(Array.isArray(result.workspaces) && result.workspaces.length === 0, 'Expected empty workspaces fallback')

    rmSync(dir, { recursive: true, force: true })
  })

  await test('Books: Corrupted books-data.json creates .corrupted.bak and preserves CORE_ACCOUNTS', () => {
    const dir = createTempDir('books-corrupt-')
    const filePath = join(dir, 'books-data.json')
    const corruptedContent = '{"version": 1, accounts: [{ INVALID JSON'
    writeFileSync(filePath, corruptedContent, 'utf8')

    const result = books.readBooksStore(dir)
    const bakPath = `${filePath}.corrupted.bak`

    assert(existsSync(bakPath), 'books-data.json.corrupted.bak must exist')
    assert(readFileSync(bakPath, 'utf8') === corruptedContent, 'Backup content must match')
    assert(result.version === books.CURRENT_BOOKS_SCHEMA_VERSION, 'Expected Books version 1')
    assert(result.accounts.some((a) => a.id === 'acc-bank'), 'Core account acc-bank must exist in fallback')
    assert(result.accounts.some((a) => a.id === 'acc-ar'), 'Core account acc-ar must exist in fallback')

    rmSync(dir, { recursive: true, force: true })
  })

  // =========================================================================
  // SUITE 2: External Sync Deal Merge Resilience
  // =========================================================================
  console.log('\n--- SUITE 2: External Sync Deal Merge Resilience ---')

  await test('Sync: Repeated syncs with identical deal ID do NOT duplicate deals (idempotency)', async () => {
    const dir = createTempDir('sync-idempotent-')
    mockUserDataDir = dir
    const crmDir = join(dir, 'crm')
    mkdirSync(crmDir, { recursive: true })
    const dealsPath = join(crmDir, 'deals.json')

    // Pre-populate with 3 existing user deals
    const initialDeals = [
      { id: 'user-deal-1', name: 'Customer A Deal', amount: 50000, stage: 'proposal', probability: 40 },
      { id: 'user-deal-2', name: 'Customer B Deal', amount: 80000, stage: 'negotiation', probability: 70 },
      { id: 'user-deal-3', name: 'Customer C Deal', amount: 120000, stage: 'won', probability: 100 },
    ]
    crm.writeDealsStore(crmDir, {
      version: 1,
      updatedAt: new Date().toISOString(),
      deals: initialDeals,
    })

    const syncDeal = {
      id: 'tender-wtr-04-opp',
      name: 'Bulk Water Metering & Valve Refurbishment',
      amount: 243000,
      stage: 'proposal',
      probability: 60,
      companyName: 'City of Ekurhuleni Water Dept',
      notes: 'Tender RFP-WTR-2026-04 opportunity',
    }

    // Run sync 10 times consecutively
    for (let i = 0; i < 10; i++) {
      const res = await syncWithCrmHandler({}, syncDeal)
      assert(res.ok === true, `Sync iteration ${i + 1} failed`)
      assert(res.dealId === syncDeal.id, `Sync returned dealId mismatch on iteration ${i + 1}`)
    }

    const afterEnvelope = JSON.parse(readFileSync(dealsPath, 'utf8'))
    assert(afterEnvelope.deals.length === 4, `Expected exactly 4 deals, found ${afterEnvelope.deals.length}`)

    const matches = afterEnvelope.deals.filter((d) => d.id === syncDeal.id)
    assert(matches.length === 1, `Expected exactly 1 instance of synced deal, found ${matches.length}`)
    assert(matches[0].name === syncDeal.name, 'Synced deal name mismatch')
    assert(matches[0].amount === syncDeal.amount, 'Synced deal amount mismatch')

    // Verify all 3 initial user deals are intact
    assert(afterEnvelope.deals.some((d) => d.id === 'user-deal-1'), 'user-deal-1 missing')
    assert(afterEnvelope.deals.some((d) => d.id === 'user-deal-2'), 'user-deal-2 missing')
    assert(afterEnvelope.deals.some((d) => d.id === 'user-deal-3'), 'user-deal-3 missing')

    rmSync(dir, { recursive: true, force: true })
  })

  await test('Sync: In-place update of existing deal updates attributes without wiping other fields', async () => {
    const dir = createTempDir('sync-update-')
    mockUserDataDir = dir
    const crmDir = join(dir, 'crm')
    mkdirSync(crmDir, { recursive: true })
    const dealsPath = join(crmDir, 'deals.json')

    const initialDeal = {
      id: 'deal-tender-100',
      name: 'Initial Tender Opportunity',
      amount: 150000,
      stage: 'proposal',
      probability: 50,
      companyName: 'Municipal Buyer',
      contactId: 'contact-special-42',
      contactName: 'Jane Doe',
      invoiceId: 'inv-zano-2026-004',
      invoiceNumber: 'INV-2026-004',
      invoicedAt: '2026-08-25T12:00:00Z',
      createdAt: '2026-08-01T08:00:00Z',
    }

    crm.writeDealsStore(crmDir, {
      version: 1,
      updatedAt: new Date().toISOString(),
      deals: [initialDeal],
    })

    // Update via sync
    const updateData = {
      id: 'deal-tender-100',
      name: 'Updated Tender Title',
      amount: 220000,
      stage: 'won',
      probability: 100,
      notes: 'Contract awarded',
    }

    const res = await syncWithCrmHandler({}, updateData)
    assert(res.ok === true, 'Sync update failed')

    const afterEnvelope = JSON.parse(readFileSync(dealsPath, 'utf8'))
    const updated = afterEnvelope.deals.find((d) => d.id === 'deal-tender-100')
    assert(updated, 'Updated deal not found')
    assert(updated.name === 'Updated Tender Title', 'Name not updated')
    assert(updated.amount === 220000, 'Amount not updated')
    assert(updated.stage === 'won', 'Stage not updated')

    // CRUCIAL: Back-references & custom attributes MUST be preserved
    assert(updated.invoiceId === 'inv-zano-2026-004', 'invoiceId back-reference was wiped')
    assert(updated.invoiceNumber === 'INV-2026-004', 'invoiceNumber back-reference was wiped')
    assert(updated.invoicedAt === '2026-08-25T12:00:00Z', 'invoicedAt was wiped')
    assert(updated.contactId === 'contact-special-42', 'contactId was wiped')
    assert(updated.createdAt === '2026-08-01T08:00:00Z', 'createdAt was wiped')

    rmSync(dir, { recursive: true, force: true })
  })

  await test('Sync: Handles legacy v0 naked array deals.json seamlessly and upgrades to v1 envelope', async () => {
    const dir = createTempDir('sync-legacy-')
    mockUserDataDir = dir
    const crmDir = join(dir, 'crm')
    mkdirSync(crmDir, { recursive: true })
    const dealsPath = join(crmDir, 'deals.json')

    // Raw legacy v0 array
    const legacyArray = [
      { id: 'legacy-deal-1', name: 'Legacy 1', amount: 30000, stage: 'lead' },
      { id: 'legacy-deal-2', name: 'Legacy 2', amount: 45000, stage: 'qualified' },
    ]
    writeFileSync(dealsPath, JSON.stringify(legacyArray, null, 2), 'utf8')

    const syncDeal = {
      id: 'tender-sync-legacy',
      name: 'New Tender Synced to Legacy CRM',
      amount: 175000,
    }

    const res = await syncWithCrmHandler({}, syncDeal)
    assert(res.ok === true, 'Sync with legacy file failed')

    const content = JSON.parse(readFileSync(dealsPath, 'utf8'))
    assert(!Array.isArray(content), 'File must no longer be a naked array')
    assert(content.version === 1, 'File must be upgraded to version 1')
    assert(Array.isArray(content.deals), 'Deals property must be an array')
    assert(content.deals.length === 3, `Expected 3 deals, got ${content.deals.length}`)
    assert(content.deals.some((d) => d.id === 'legacy-deal-1'), 'legacy-deal-1 missing')
    assert(content.deals.some((d) => d.id === 'legacy-deal-2'), 'legacy-deal-2 missing')
    assert(content.deals.some((d) => d.id === 'tender-sync-legacy'), 'tender-sync-legacy missing')

    rmSync(dir, { recursive: true, force: true })
  })

  await test('Sync: Rapid sequential bursts of 30 distinct sync calls maintain atomic integrity', async () => {
    const dir = createTempDir('sync-burst-')
    mockUserDataDir = dir
    const crmDir = join(dir, 'crm')
    mkdirSync(crmDir, { recursive: true })
    const dealsPath = join(crmDir, 'deals.json')

    crm.writeDealsStore(crmDir, {
      version: 1,
      updatedAt: new Date().toISOString(),
      deals: [{ id: 'anchor-deal', name: 'Anchor', amount: 10000, stage: 'lead', probability: 20 }],
    })

    const BURST_COUNT = 30
    for (let i = 0; i < BURST_COUNT; i++) {
      const res = await syncWithCrmHandler({}, {
        id: `burst-deal-${i}`,
        name: `Burst Opportunity #${i}`,
        amount: 10000 * (i + 1),
        stage: 'proposal',
        probability: 50,
      })
      assert(res.ok === true, `Burst sync ${i} failed`)
    }

    const finalEnvelope = JSON.parse(readFileSync(dealsPath, 'utf8'))
    assert(finalEnvelope.version === 1, 'Version must be 1')
    assert(finalEnvelope.deals.length === BURST_COUNT + 1, `Expected ${BURST_COUNT + 1} deals, got ${finalEnvelope.deals.length}`)
    assert(finalEnvelope.deals.some((d) => d.id === 'anchor-deal'), 'Anchor deal was lost')

    for (let i = 0; i < BURST_COUNT; i++) {
      assert(finalEnvelope.deals.some((d) => d.id === `burst-deal-${i}`), `burst-deal-${i} missing`)
    }

    rmSync(dir, { recursive: true, force: true })
  })

  await test('Sync: Alternative ID parameters (dealId, crmDealId) resolve target correctly', async () => {
    const dir = createTempDir('sync-ids-')
    mockUserDataDir = dir
    const crmDir = join(dir, 'crm')
    mkdirSync(crmDir, { recursive: true })
    const dealsPath = join(crmDir, 'deals.json')

    crm.writeDealsStore(crmDir, {
      version: 1,
      updatedAt: new Date().toISOString(),
      deals: [],
    })

    // Use dealId
    const res1 = await syncWithCrmHandler({}, { dealId: 'custom-deal-id-1', name: 'Via dealId' })
    assert(res1.ok === true && res1.dealId === 'custom-deal-id-1', 'dealId resolution failed')

    // Use crmDealId
    const res2 = await syncWithCrmHandler({}, { crmDealId: 'custom-crm-deal-id-2', name: 'Via crmDealId' })
    assert(res2.ok === true && res2.dealId === 'custom-crm-deal-id-2', 'crmDealId resolution failed')

    const finalEnvelope = JSON.parse(readFileSync(dealsPath, 'utf8'))
    assert(finalEnvelope.deals.some((d) => d.id === 'custom-deal-id-1'), 'custom-deal-id-1 missing')
    assert(finalEnvelope.deals.some((d) => d.id === 'custom-crm-deal-id-2'), 'custom-crm-deal-id-2 missing')

    rmSync(dir, { recursive: true, force: true })
  })

  // =========================================================================
  // SUITE 3: Schema Migration from Legacy v0 Naked Arrays to v1 Envelope
  // =========================================================================
  console.log('\n--- SUITE 3: Schema Migration from Legacy v0 to v1 Envelope ---')

  await test('Migration CRM: v0 naked array converted to v1 envelope with field sanitization', () => {
    const rawLegacy = [
      { id: 'd-1', name: 'Legacy Alpha', amount: 50000, stage: 'won' },
      { id: 'd-2', name: 'Legacy Beta', amount: 75000, stage: 'lost' },
      { id: 'd-3', name: 'Legacy Gamma', amount: 30000, stage: 'negotiation', probability: 80 },
    ]

    const migrated = crm.migrateAndValidateDeals(rawLegacy)
    assert(migrated.version === 1, `Expected version 1, got ${migrated.version}`)
    assert(typeof migrated.updatedAt === 'string' && migrated.updatedAt.length > 0, 'updatedAt missing')
    assert(migrated.deals.length === 3, `Expected 3 deals, got ${migrated.deals.length}`)

    // Verify deal sanitization
    const d1 = migrated.deals[0]
    assert(d1.probability === 100, `Won deal must have probability 100, got ${d1.probability}`)
    assert(typeof d1.createdAt === 'string', 'createdAt missing')
    assert(typeof d1.updatedAt === 'string', 'updatedAt missing')

    const d2 = migrated.deals[1]
    assert(d2.probability === 0, `Lost deal must have probability 0, got ${d2.probability}`)

    const d3 = migrated.deals[2]
    assert(d3.probability === 80, `Negotiation deal probability should be 80, got ${d3.probability}`)
  })

  await test('Migration CRM: Naked array containing null, primitive, or corrupted items handles gracefully', () => {
    const corruptedArray = [
      null,
      undefined,
      42,
      'malicious string',
      { id: 'valid-1', name: 'Real Deal', amount: 10000, stage: 'proposal' },
      {},
    ]

    const migrated = crm.migrateAndValidateDeals(corruptedArray)
    assert(migrated.version === 1, 'Version should be 1')
    assert(migrated.deals.length === 6, 'All elements should be converted to safe Deal objects')

    // Check non-object items converted to default deals without throwing
    for (const d of migrated.deals) {
      assert(typeof d.id === 'string' && d.id.length > 0, 'Each deal must have a valid string id')
      assert(typeof d.name === 'string' && d.name.length > 0, 'Each deal must have a valid string name')
      assert(typeof d.amount === 'number' && d.amount >= 0, 'Each deal amount must be >= 0')
      assert(typeof d.probability === 'number' && d.probability >= 0 && d.probability <= 100, 'Probability must be 0-100')
      assert(typeof d.stage === 'string', 'Stage must be a string')
    }
  })

  await test('Migration CRM: Already valid v1 envelope preserved intact without loss of custom fields', () => {
    const v1Envelope = {
      version: 1,
      updatedAt: '2026-08-30T10:00:00.000Z',
      deals: [
        {
          id: 'v1-deal-1',
          name: 'Enterprise Contract',
          amount: 500000,
          stage: 'won',
          probability: 100,
          invoiceId: 'inv-v1-001',
          invoiceNumber: 'INV-2026-V1',
          invoicedAt: '2026-08-30T11:00:00.000Z',
          companyId: 'comp-42',
          companyName: 'Megacorp',
          createdAt: '2026-08-01T09:00:00.000Z',
          updatedAt: '2026-08-30T10:00:00.000Z',
        },
      ],
    }

    const validated = crm.migrateAndValidateDeals(v1Envelope)
    assert(validated.version === 1, 'Version mismatch')
    assert(validated.updatedAt === '2026-08-30T10:00:00.000Z', 'updatedAt was overwritten')
    assert(validated.deals.length === 1, 'Deals length mismatch')
    const deal = validated.deals[0]
    assert(deal.invoiceId === 'inv-v1-001', 'invoiceId lost')
    assert(deal.invoiceNumber === 'INV-2026-V1', 'invoiceNumber lost')
    assert(deal.companyId === 'comp-42', 'companyId lost')
    assert(deal.companyName === 'Megacorp', 'companyName lost')
  })

  await test('Migration CRM: Non-object or empty inputs fallback to clean envelope', () => {
    const cases = [null, undefined, '', 12345, true, {}, { deals: 'not-an-array' }]
    for (const c of cases) {
      const result = crm.migrateAndValidateDeals(c)
      assert(result.version === 1, 'Fallback version must be 1')
      assert(Array.isArray(result.deals), 'Fallback deals must be an array')
      assert(result.deals.length === 0, 'Fallback deals should be empty')
    }
  })

  await test('Migration Tenders: Unversioned legacy data upgrades to v1 and preserves workspaces', () => {
    const legacyTenders = {
      activeCompanyId: 'comp-alpha-01',
      workspaces: [
        {
          id: 'ws-1',
          name: 'Municipal Tenders',
          tenders: [
            {
              id: 't-1',
              title: 'Water RFP',
              referenceNumber: 'RFP-2026-01',
              status: 'IN_PROGRESS',
              milestones: [
                { id: 'm-1', title: 'Milestone 1', amount: 50000, status: 'REACHED' },
              ],
            },
          ],
        },
      ],
      issuerTemplates: [{ id: 'tmpl-1', name: 'Standard Template' }],
    }

    const migrated = tenders.migrateAndValidateTenders(legacyTenders)
    assert(migrated.version === 1, `Expected version 1, got ${migrated.version}`)
    assert(migrated.activeCompanyId === 'comp-alpha-01', 'activeCompanyId mismatch')
    assert(migrated.workspaces.length === 1, 'workspaces length mismatch')
    assert(migrated.workspaces[0].tenders[0].milestones[0].amount === 50000, 'Milestone amount preserved')
    assert(migrated.issuerTemplates.length === 1, 'issuerTemplates preserved')
  })

  await test('Migration Books: Unversioned legacy data upgrades to v1 and strictly preserves core account balances', () => {
    const legacyBooks = {
      settings: { companyName: 'Custom Legacy Corp' },
      accounts: [
        { id: 'acc-bank', name: 'Custom Bank Account', rootType: 'Asset', accountType: 'Bank', balance: 999999 },
        { id: 'acc-custom-1', name: 'Prepaid Expenses', rootType: 'Asset', accountType: 'Current Asset', balance: 12500 },
      ],
      parties: [{ id: 'p-1', name: 'Legacy Customer', outstandingBalance: 4000 }],
      invoices: [{ id: 'inv-legacy-1', invoiceNumber: 'INV-LEGACY-01', grandTotal: 4000 }],
      journalEntries: [],
    }

    const migrated = books.migrateAndValidateBooks(legacyBooks)
    assert(migrated.version === 1, 'Version must be 1')
    assert(migrated.settings.companyName === 'Custom Legacy Corp', 'Settings preserved')
    assert(migrated.parties.length === 1, 'Parties preserved')
    assert(migrated.invoices.length === 1, 'Invoices preserved')

    // Verify existing core account acc-bank retained its custom balance
    const bankAcc = migrated.accounts.find((a) => a.id === 'acc-bank')
    assert(bankAcc, 'acc-bank must exist')
    assert(bankAcc.balance === 999999, `acc-bank balance should be 999999, got ${bankAcc.balance}`)

    // Verify custom account preserved
    assert(migrated.accounts.some((a) => a.id === 'acc-custom-1'), 'acc-custom-1 preserved')

    // Verify missing core accounts were auto-injected
    for (const core of books.CORE_ACCOUNTS) {
      assert(migrated.accounts.some((a) => a.id === core.id), `Missing core account ${core.id} must be injected`)
    }
  })

  // =========================================================================
  // SUITE 4: Extreme Deal Values & Clamping Boundary Tests
  // =========================================================================
  console.log('\n--- SUITE 4: Extreme Deal Values & Clamping Boundary Tests ---')

  await test('Sanitize: Zero amount (amount = 0) is valid and preserved', () => {
    const sanitized = crm.sanitizeDeal({ id: 'deal-zero', name: 'Zero Dollar Deal', amount: 0, stage: 'proposal' })
    assert(sanitized.amount === 0, `Expected 0, got ${sanitized.amount}`)
  })

  await test('Sanitize: Extreme enterprise valuation (amount = 1e9, one billion) is preserved', () => {
    const oneBillion = 1e9
    const sanitized = crm.sanitizeDeal({ id: 'deal-billion', name: 'Billion Dollar Deal', amount: oneBillion, stage: 'won' })
    assert(sanitized.amount === 1000000000, `Expected 1000000000, got ${sanitized.amount}`)
  })

  await test('Sanitize: Max safe integer valuation is preserved', () => {
    const maxVal = Number.MAX_SAFE_INTEGER
    const sanitized = crm.sanitizeDeal({ id: 'deal-max', name: 'Max Deal', amount: maxVal, stage: 'negotiation' })
    assert(sanitized.amount === maxVal, `Expected ${maxVal}, got ${sanitized.amount}`)
  })

  await test('Sanitize: Negative amounts are clamped to 0', () => {
    const negativeCases = [-1, -50000, -0.0001, -1e9]
    for (const neg of negativeCases) {
      const sanitized = crm.sanitizeDeal({ id: 'deal-neg', name: 'Negative Deal', amount: neg, stage: 'lead' })
      assert(sanitized.amount === 0, `Amount ${neg} was not clamped to 0; got ${sanitized.amount}`)
    }
  })

  await test('Sanitize: Non-finite or malformed amounts clamp to 0', () => {
    const badAmounts = [NaN, Infinity, -Infinity, '5000', null, undefined, {}, []]
    for (const bad of badAmounts) {
      const sanitized = crm.sanitizeDeal({ id: 'deal-bad-amt', name: 'Bad Amount', amount: bad, stage: 'lead' })
      assert(sanitized.amount === 0, `Bad amount ${bad} did not clamp to 0; got ${sanitized.amount}`)
    }
  })

  await test('Sanitize: Probabilities clamped strictly between 0 and 100', () => {
    // Underflow clamped to 0
    assert(crm.sanitizeDeal({ probability: -10 }).probability === 0, 'Negative probability must clamp to 0')
    assert(crm.sanitizeDeal({ probability: -999 }).probability === 0, '-999 probability must clamp to 0')

    // Overflow clamped to 100
    assert(crm.sanitizeDeal({ probability: 101 }).probability === 100, '101 probability must clamp to 100')
    assert(crm.sanitizeDeal({ probability: 9999 }).probability === 100, '9999 probability must clamp to 100')

    // Boundaries preserved
    assert(crm.sanitizeDeal({ probability: 0 }).probability === 0, '0 probability must remain 0')
    assert(crm.sanitizeDeal({ probability: 100 }).probability === 100, '100 probability must remain 100')

    // Floating points rounded to integer
    assert(crm.sanitizeDeal({ probability: 74.4 }).probability === 74, '74.4 should round to 74')
    assert(crm.sanitizeDeal({ probability: 74.6 }).probability === 75, '74.6 should round to 75')
  })

  await test('Sanitize: Non-finite probability falls back to stage-based default', () => {
    // won -> 100, lost -> 0, others -> 20
    assert(crm.sanitizeDeal({ stage: 'won', probability: NaN }).probability === 100, 'won deal with NaN prob should be 100')
    assert(crm.sanitizeDeal({ stage: 'lost', probability: Infinity }).probability === 0, 'lost deal with Infinity prob should be 0')
    assert(crm.sanitizeDeal({ stage: 'proposal', probability: undefined }).probability === 20, 'proposal deal with undefined prob should be 20')
  })

  await test('Sanitize: Invalid stage strings sanitized to "lead"', () => {
    const invalidStages = ['superwon', 'completed', 'CLOSED', '123', null, undefined, 42]
    for (const st of invalidStages) {
      const sanitized = crm.sanitizeDeal({ id: 'd-st', stage: st })
      assert(sanitized.stage === 'lead', `Invalid stage ${st} should be sanitized to "lead", got ${sanitized.stage}`)
    }
  })

  await test('Sanitize: Missing ID generates a unique deal-* identifier', () => {
    const d1 = crm.sanitizeDeal({ name: 'No ID 1' })
    const d2 = crm.sanitizeDeal({ name: 'No ID 2' })
    assert(typeof d1.id === 'string' && d1.id.startsWith('deal-'), `Expected deal-* id, got ${d1.id}`)
    assert(typeof d2.id === 'string' && d2.id.startsWith('deal-'), `Expected deal-* id, got ${d2.id}`)
    assert(d1.id !== d2.id, 'Generated IDs must be unique')
  })

  await test('Sync + Read: Extreme values through syncWithCrm are sanitized upon CRM store read', async () => {
    const dir = createTempDir('sync-sanitize-')
    mockUserDataDir = dir
    const crmDir = join(dir, 'crm')
    mkdirSync(crmDir, { recursive: true })

    // Sync a deal with extreme values: amount = 1e9, prob = 100
    const res1 = await syncWithCrmHandler({}, {
      id: 'deal-extreme-1',
      name: 'Mega Tender',
      amount: 1e9,
      probability: 100,
    })
    assert(res1.ok === true, 'Extreme deal sync failed')

    // Read store via CRM API
    const env1 = crm.readDealsStore(crmDir)
    const deal1 = env1.deals.find((d) => d.id === 'deal-extreme-1')
    assert(deal1.amount === 1e9, '1e9 amount should be preserved')
    assert(deal1.probability === 100, 'Probability 100 should be preserved')

    // Sync an update with negative amount and overflown probability
    await syncWithCrmHandler({}, {
      id: 'deal-extreme-1',
      amount: -99999,
      probability: 300,
    })

    // When read by CRM, sanitizeDeal clamps both
    const env2 = crm.readDealsStore(crmDir)
    const deal2 = env2.deals.find((d) => d.id === 'deal-extreme-1')
    assert(deal2.amount === 0, `Negative amount must be clamped to 0 by CRM store; got ${deal2.amount}`)
    assert(deal2.probability === 100, `Overflown probability must be clamped to 100 by CRM store; got ${deal2.probability}`)

    rmSync(dir, { recursive: true, force: true })
  })

  // =========================================================================
  // SUITE 5: Deep Stress & Concurrency Edge Cases
  // =========================================================================
  console.log('\n--- SUITE 5: Deep Stress & Edge Cases ---')

  await test('Stress: Sync into pre-existing corrupted deals.json writes .corrupted.bak and restores valid v1 envelope', async () => {
    const dir = createTempDir('sync-corrupt-recover-')
    mockUserDataDir = dir
    const crmDir = join(dir, 'crm')
    mkdirSync(crmDir, { recursive: true })
    const dealsPath = join(crmDir, 'deals.json')

    // Write corrupted JSON into deals.json
    const corruptSnippet = '{"deals": [{"id": "bad-json", '
    writeFileSync(dealsPath, corruptSnippet, 'utf8')

    // Run sync
    const res = await syncWithCrmHandler({}, {
      id: 'rescue-deal-1',
      name: 'Rescue Opportunity',
      amount: 88000,
    })
    assert(res.ok === true, 'Sync failed to rescue corrupted file')

    // Verify .corrupted.bak was preserved
    const bakPath = `${dealsPath}.corrupted.bak`
    assert(existsSync(bakPath), '.corrupted.bak must be preserved')
    assert(readFileSync(bakPath, 'utf8') === corruptSnippet, 'Backup content mismatch')

    // Verify deals.json is now valid v1 envelope containing the rescued deal
    const restored = JSON.parse(readFileSync(dealsPath, 'utf8'))
    assert(restored.version === 1, 'Restored file must be version 1')
    assert(restored.deals.length === 1, 'Expected 1 deal in restored file')
    assert(restored.deals[0].id === 'rescue-deal-1', 'Rescued deal ID mismatch')

    rmSync(dir, { recursive: true, force: true })
  })

  await test('Stress: Empty or undefined payload to syncWithCrm creates a safe default deal', async () => {
    const dir = createTempDir('sync-empty-payload-')
    mockUserDataDir = dir
    const crmDir = join(dir, 'crm')
    mkdirSync(crmDir, { recursive: true })
    const dealsPath = join(crmDir, 'deals.json')

    // Empty object payload
    const res1 = await syncWithCrmHandler({}, {})
    assert(res1.ok === true, 'Empty payload sync failed')
    assert(typeof res1.dealId === 'string' && res1.dealId.length > 0, 'No dealId generated')

    // Null payload
    const res2 = await syncWithCrmHandler({}, null)
    assert(res2.ok === true, 'Null payload sync failed')
    assert(typeof res2.dealId === 'string' && res2.dealId.length > 0, 'No dealId generated')

    const envelope = JSON.parse(readFileSync(dealsPath, 'utf8'))
    assert(envelope.deals.length === 2, `Expected 2 default deals, found ${envelope.deals.length}`)
    for (const d of envelope.deals) {
      assert(d.name === 'Tender Opportunity', 'Default name mismatch')
      assert(d.amount === 150000, 'Default amount mismatch')
      assert(d.stage === 'proposal', 'Default stage mismatch')
    }

    rmSync(dir, { recursive: true, force: true })
  })

  await test('Stress: Scale test with 1,000 deals in deals.json performs cleanly without degradation', () => {
    const dir = createTempDir('scale-1000-')
    const filePath = join(dir, 'deals.json')

    const deals = []
    for (let i = 0; i < 1000; i++) {
      deals.push({
        id: `scale-deal-${i}`,
        name: `High Scale Opportunity ${i}`,
        amount: Math.round(Math.random() * 1000000),
        stage: i % 2 === 0 ? 'proposal' : 'won',
        probability: i % 2 === 0 ? 50 : 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }

    const startTime = Date.now()
    crm.writeDealsStore(dir, {
      version: 1,
      updatedAt: new Date().toISOString(),
      deals,
    })
    const writeDuration = Date.now() - startTime

    const readStartTime = Date.now()
    const loaded = crm.readDealsStore(dir)
    const readDuration = Date.now() - readStartTime

    assert(loaded.version === 1, 'Version mismatch')
    assert(loaded.deals.length === 1000, `Expected 1000 deals, loaded ${loaded.deals.length}`)
    assert(writeDuration < 500, `Write too slow: ${writeDuration}ms`)
    assert(readDuration < 500, `Read too slow: ${readDuration}ms`)

    rmSync(dir, { recursive: true, force: true })
  })

  await test('Stress: Idempotent round-trip serialization stability across 5 cycles', () => {
    const dir = createTempDir('roundtrip-')
    const filePath = join(dir, 'deals.json')

    let current = {
      version: 1,
      updatedAt: '2026-09-03T12:00:00.000Z',
      deals: [
        {
          id: 'rt-1',
          name: 'Roundtrip Stability Deal',
          amount: 55000,
          stage: 'won',
          probability: 100,
          invoiceId: 'inv-rt-1',
          invoiceNumber: 'INV-2026-RT1',
          invoicedAt: '2026-09-03T12:05:00.000Z',
          createdAt: '2026-09-01T08:00:00.000Z',
          updatedAt: '2026-09-03T12:00:00.000Z',
        },
      ],
    }

    crm.writeDealsStore(dir, current)

    for (let cycle = 0; cycle < 5; cycle++) {
      const readEnv = crm.readDealsStore(dir)
      assert(readEnv.deals.length === 1, `Cycle ${cycle}: deals length mismatch`)
      assert(readEnv.deals[0].invoiceId === 'inv-rt-1', `Cycle ${cycle}: invoiceId lost`)
      assert(readEnv.deals[0].amount === 55000, `Cycle ${cycle}: amount corrupted`)
      // Write back
      crm.writeDealsStore(dir, readEnv)
    }

    const finalEnv = crm.readDealsStore(dir)
    assert(finalEnv.deals[0].name === 'Roundtrip Stability Deal', 'Name corrupted after 5 roundtrips')
    assert(finalEnv.deals[0].probability === 100, 'Probability corrupted after 5 roundtrips')

    rmSync(dir, { recursive: true, force: true })
  })
}

runAllTests().then(() => {
  console.log('\n======================================================================')
  console.log(`RESULTS: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  if (failedTests === 0) {
    console.log('STATUS: VERIFICATION SUCCESSFUL (100% PASS)')
  } else {
    console.log(`STATUS: VERIFICATION FAILED (${failedTests} failures)`)
    for (const f of failureDetails) {
      console.log(`  - [FAILED] ${f.test}: ${f.error}`)
    }
  }
  console.log('======================================================================')
  process.exit(failedTests === 0 ? 0 : 1)
})

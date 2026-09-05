#!/usr/bin/env node
/**
 * tools/test-challenger-m1-data-integrity.ts
 *
 * EMPIRICAL CHALLENGE HARNESS FOR MILESTONE 1 (R1):
 * Unified Main-Renderer State Synchronization
 *
 * Scope of Verification:
 * 1. Seed data preservation: Verify all 7 mock compliance documents in MOCK_VAULT
 *    ('vd-tax', 'vd-coida', 'vd-bbbee', 'vd-cipc', 'vd-directors', 'vd-sbd', 'vd-csd'),
 *    all 5 customers ('c-1'..'c-5'), and SEED_TENDER_WTR_04 with 2 milestones survive store
 *    migrations, malformed input recovery, and atomic disk writes.
 * 2. Milestone billing synchronization: Verify that billMilestoneInBooks in tenders-main.ts
 *    persists the updated milestone ('BILLED', billedInvoiceId, billedInvoiceNumber) to disk,
 *    updates Books ledger accounts and journal entries, and broadcasts tenders:data-changed.
 * 3. Adversarial boundary testing on milestone billing (already billed, unreached status,
 *    invalid amount, non-existent tender/milestone).
 * 4. Multi-window / multi-subscriber simulation: Verify that multiple registered WebContents
 *    all receive updates cleanly, destroyed/crashing WebContents are safely isolated,
 *    and no infinite echo loops occur between concurrent subscribers.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Module from 'node:module'

// ----------------------------------------------------------------------------
// 1. Electron Mocking Harness
// ----------------------------------------------------------------------------
const testDir = join(tmpdir(), `challenger-m1-${randomUUID().slice(0, 8)}`)
mkdirSync(testDir, { recursive: true })

const ipcHandlers: Record<string, (...args: any[]) => any> = {}

const mockApp = {
  getPath: (name: string) => {
    if (name === 'userData') return testDir
    return testDir
  },
  isReady: () => true,
}

const mockIpcMain = {
  handle: (channel: string, listener: (...args: any[]) => any) => {
    ipcHandlers[channel] = listener
  },
}

class MockWebContentsView {
  webContents = {
    isDestroyed: () => false,
    send: (_channel: string, ..._args: any[]) => {},
    loadURL: async () => {},
    loadFile: async () => {},
    once: (_event: string, _fn: () => void) => {},
  }
}

// Intercept 'electron' require
const origRequire = (Module.prototype as any).require
;(Module.prototype as any).require = function (id: string) {
  if (id === 'electron') {
    return {
      app: mockApp,
      ipcMain: mockIpcMain,
      WebContentsView: MockWebContentsView,
    }
  }
  return origRequire.apply(this, arguments)
}

// ----------------------------------------------------------------------------
// 2. Load Tenders Modules
// ----------------------------------------------------------------------------
const tendersMain = require('../apps/tenders/src/main/tenders-main.ts')
const {
  CURRENT_TENDERS_SCHEMA_VERSION,
  SEED_COMPANY_ID,
  SEED_TENDER_WTR_04,
  createDefaultSeedWorkspaces,
  migrateAndValidateTenders,
  readTendersStore,
  writeTendersStore,
  registerTendersIpc,
  registerTendersWebContents,
  unregisterTendersWebContents,
  getActiveTendersWebContents,
  broadcastTendersData,
  startTendersStoreWatcher,
  stopTendersStoreWatcher,
} = tendersMain

const { MOCK_VAULT } = require('../apps/tenders/src/renderer/src/mock/vault.ts')
const { MOCK_CUSTOMERS } = require('../apps/tenders/src/renderer/src/mock/customers.ts')
const { MOCK_COMPANY } = require('../apps/tenders/src/renderer/src/mock/company.ts')
const { TENDERS_CHANNELS } = require('../apps/tenders/src/shared/ipc.ts')
const { readBooksStore, writeBooksStore } = require('../apps/books/src/main/books-main.ts')

// Setup mock window & localStorage for renderer Zustand store
const storeMap = new Map<string, string>()
const mockLocalStorage = {
  getItem: (k: string) => storeMap.get(k) ?? null,
  setItem: (k: string, v: string) => { storeMap.set(k, String(v)) },
  removeItem: (k: string) => { storeMap.delete(k) },
  clear: () => { storeMap.clear() },
  length: 0,
  key: () => null,
}
;(global as any).localStorage = mockLocalStorage

const rendererListeners: Record<string, Array<(...args: any[]) => void>> = {}
let rendererSavedDataCalls: string[] = []

const mockTendersApi = {
  getStoredData: async () => {
    const fn = ipcHandlers[TENDERS_CHANNELS.getStoredData]
    if (fn) return fn({ sender: null })
    return null
  },
  saveStoredData: async (json: string) => {
    rendererSavedDataCalls.push(json)
    const fn = ipcHandlers[TENDERS_CHANNELS.saveStoredData]
    if (fn) return fn({ sender: null }, json)
    return { ok: true }
  },
  onDataChanged: (cb: (data: any) => void) => {
    if (!rendererListeners[TENDERS_CHANNELS.dataChanged]) {
      rendererListeners[TENDERS_CHANNELS.dataChanged] = []
    }
    rendererListeners[TENDERS_CHANNELS.dataChanged].push(cb)
    return () => {
      const arr = rendererListeners[TENDERS_CHANNELS.dataChanged]
      const idx = arr.indexOf(cb)
      if (idx >= 0) arr.splice(idx, 1)
    }
  },
  billMilestoneInBooks: async (payload: any, milestoneId?: string) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.billMilestoneInBooks]
    if (fn) return fn({ sender: null }, payload, milestoneId)
    return { ok: false }
  },
}

;(global as any).window = {
  tendersApi: mockTendersApi,
  localStorage: mockLocalStorage,
}

const tendersStoreModule = require('../apps/tenders/src/renderer/src/store.ts')
const { useTendersStore } = tendersStoreModule

// ----------------------------------------------------------------------------
// 3. Test Harness Framework
// ----------------------------------------------------------------------------
let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures: Array<{ name: string; error: string }> = []

function assert(condition: any, message: string) {
  totalTests++
  if (!condition) {
    failedTests++
    failures.push({ name: message, error: 'Assertion failed' })
    console.error(`  ❌ FAIL: ${message}`)
    throw new Error(`Assertion failed: ${message}`)
  } else {
    passedTests++
    console.log(`  ✅ PASS: ${message}`)
  }
}

function expectEqual(actual: any, expected: any, message: string) {
  totalTests++
  const actualStr = JSON.stringify(actual)
  const expectedStr = JSON.stringify(expected)
  if (actualStr !== expectedStr) {
    failedTests++
    const err = `Expected ${expectedStr}, got ${actualStr}`
    failures.push({ name: message, error: err })
    console.error(`  ❌ FAIL: ${message} -> ${err}`)
    throw new Error(`${message}: ${err}`)
  } else {
    passedTests++
    console.log(`  ✅ PASS: ${message}`)
  }
}

// ----------------------------------------------------------------------------
// 4. Test Execution
// ----------------------------------------------------------------------------
async function runChallengerSuite() {
  console.log('======================================================================')
  console.log('   CHALLENGER 2: EMPIRICAL DATA INTEGRITY & STATE SYNC TEST HARNESS')
  console.log('   Scope: Milestone 1 Unified Main-Renderer State Synchronization')
  console.log('======================================================================\n')

  const tendersJsonPath = join(testDir, 'tenders', 'tenders-data.json')
  mkdirSync(join(testDir, 'tenders'), { recursive: true })
  const booksJsonPath = join(testDir, 'books', 'books-data.json')
  mkdirSync(join(testDir, 'books'), { recursive: true })

  // Expected 7 compliance documents
  const EXPECTED_VAULT_IDS = [
    'vd-tax',
    'vd-coida',
    'vd-bbbee',
    'vd-cipc',
    'vd-directors',
    'vd-sbd',
    'vd-csd',
  ]

  // Expected 5 customers
  const EXPECTED_CUSTOMER_IDS = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5']

  try {
    // ========================================================================
    // CATEGORY 1: SEED DATA PRESERVATION & MIGRATION RESILIENCE
    // ========================================================================
    console.log('--- CATEGORY 1: Seed Data Preservation & Migration Under Stress ---')

    // 1.1 Fresh Seed Construction
    console.log('\n[1.1] Null / Empty Store Seed Generation:')
    const freshNull = migrateAndValidateTenders(null)
    const freshUndefined = migrateAndValidateTenders(undefined)
    const freshEmptyObj = migrateAndValidateTenders({})
    const freshString = migrateAndValidateTenders('not-an-object')

    for (const [label, seed] of [
      ['null', freshNull],
      ['undefined', freshUndefined],
      ['{}', freshEmptyObj],
      ['string', freshString],
    ] as const) {
      assert(seed.version === CURRENT_TENDERS_SCHEMA_VERSION, `Seed (${label}) version is ${CURRENT_TENDERS_SCHEMA_VERSION}`)
      assert(seed.activeCompanyId === SEED_COMPANY_ID, `Seed (${label}) activeCompanyId is '${SEED_COMPANY_ID}'`)
      assert(seed.workspaces.length === 1, `Seed (${label}) contains exactly 1 default workspace`)
      
      const ws = seed.workspaces[0]
      assert(ws.id === SEED_COMPANY_ID, `Seed (${label}) workspace id matches SEED_COMPANY_ID`)
      assert(ws.company.name === 'Thabo Engineering (Pty) Ltd', `Seed (${label}) company name matches 'Thabo Engineering (Pty) Ltd'`)
      
      // Check 7 vault documents
      assert(ws.vault.length === 7, `Seed (${label}) has exactly 7 vault documents`)
      for (const vId of EXPECTED_VAULT_IDS) {
        assert(ws.vault.some((d: any) => d.id === vId), `Seed (${label}) vault contains document '${vId}'`)
      }

      // Check 5 customers
      assert(ws.customers.length === 5, `Seed (${label}) has exactly 5 customers`)
      for (const cId of EXPECTED_CUSTOMER_IDS) {
        assert(ws.customers.some((c: any) => c.id === cId), `Seed (${label}) customers contains '${cId}'`)
      }

      // Check SEED_TENDER_WTR_04
      assert(ws.tenders.length === 1, `Seed (${label}) has exactly 1 tender`)
      const tender = ws.tenders[0]
      assert(tender.id === 'tender-wtr-04', `Seed (${label}) tender id is 'tender-wtr-04'`)
      assert(tender.referenceNumber === 'RFP-WTR-2026-04', `Seed (${label}) tender ref is 'RFP-WTR-2026-04'`)
      assert(tender.milestones.length === 2, `Seed (${label}) tender has 2 milestones`)
      assert(tender.milestones.some((m: any) => m.id === 'ms-01' && m.status === 'REACHED'), `Seed (${label}) has ms-01 REACHED`)
      assert(tender.milestones.some((m: any) => m.id === 'ms-02' && m.status === 'PENDING'), `Seed (${label}) has ms-02 PENDING`)
    }

    // 1.2 Legacy Workspaces Migration (comp-zano-01, ws-ekurhuleni-01, empty arrays)
    console.log('\n[1.2] Legacy Empty / Incomplete Workspaces Migration:')
    const legacyEnvelope = {
      version: 1,
      activeCompanyId: 'comp-zano-01',
      workspaces: [
        {
          id: 'ws-ekurhuleni-01',
          name: 'Ekurhuleni Water Infrastructure',
          company: { name: 'Legacy Thabo' },
          customers: [],
          vault: [],
          tenders: [],
        },
      ],
    }
    const migratedLegacy = migrateAndValidateTenders(legacyEnvelope)
    assert(migratedLegacy.activeCompanyId === SEED_COMPANY_ID, `Legacy comp-zano-01 migrated to '${SEED_COMPANY_ID}'`)
    assert(migratedLegacy.workspaces[0].id === SEED_COMPANY_ID, `Legacy ws-ekurhuleni-01 mapped to '${SEED_COMPANY_ID}'`)
    assert(migratedLegacy.workspaces[0].vault.length === 7, `Empty vault in legacy file restored with 7 documents`)
    for (const vId of EXPECTED_VAULT_IDS) {
      assert(migratedLegacy.workspaces[0].vault.some((d: any) => d.id === vId), `Migrated legacy has '${vId}'`)
    }
    assert(migratedLegacy.workspaces[0].customers.length === 5, `Empty customers in legacy file restored with 5 customers`)
    assert(migratedLegacy.workspaces[0].tenders.length === 1, `Empty tenders in legacy file restored with SEED_TENDER_WTR_04`)

    // 1.3 User Custom Data Preservation
    console.log('\n[1.3] User-Created Custom Entities Preservation:')
    const customDoc = {
      id: 'vd-custom-99',
      title: 'Custom ISO 9001 Certificate',
      category: 'COMPLIANCE',
      fileUrl: '/demo/vault/iso-9001.pdf',
      issueDate: '2026-01-01',
      expiryDate: '2027-01-01',
      isCertified: true,
      certifiedDate: '2026-01-02',
      metadata: { Certifier: 'SABS' },
    }
    const customCustomer = {
      id: 'c-custom-99',
      name: 'Rand Water Board',
      contactName: 'Naledi Khumalo',
      industry: 'Water Utility',
      status: 'ACTIVE',
      requiredDocs: [],
    }
    const customTender = {
      id: 'tender-custom-88',
      title: 'Sedibeng Pipeline Replacement',
      referenceNumber: 'RFP-SED-2026-09',
      issuingBody: 'Sedibeng District Municipality',
      status: 'SUBMITTED',
      milestones: [],
      requirements: [],
    }

    const mixedEnvelope = {
      version: 1,
      activeCompanyId: SEED_COMPANY_ID,
      workspaces: [
        {
          id: SEED_COMPANY_ID,
          name: 'Thabo Engineering (Pty) Ltd',
          company: { ...MOCK_COMPANY },
          customers: [...MOCK_CUSTOMERS, customCustomer],
          vault: [...MOCK_VAULT, customDoc],
          tenders: [SEED_TENDER_WTR_04, customTender],
        },
      ],
    }

    const validatedMixed = migrateAndValidateTenders(mixedEnvelope)
    assert(validatedMixed.workspaces[0].vault.length === 8, `Mixed vault retains all 8 documents (7 mock + 1 custom)`)
    assert(validatedMixed.workspaces[0].vault.some((d: any) => d.id === 'vd-custom-99'), `Custom document 'vd-custom-99' preserved`)
    assert(validatedMixed.workspaces[0].customers.length === 6, `Mixed customers retains all 6 customers (5 mock + 1 custom)`)
    assert(validatedMixed.workspaces[0].customers.some((c: any) => c.id === 'c-custom-99'), `Custom customer 'c-custom-99' preserved`)
    assert(validatedMixed.workspaces[0].tenders.length === 2, `Mixed tenders retains both tenders`)
    assert(validatedMixed.workspaces[0].tenders.some((t: any) => t.id === 'tender-custom-88'), `Custom tender 'tender-custom-88' preserved`)

    // 1.4 File Corruption Recovery (.corrupted.bak)
    console.log('\n[1.4] File Corruption Handling & Safe Backup:')
    const corruptFile = join(testDir, 'tenders', 'tenders-data.json')
    writeFileSync(corruptFile, '<<<MALFORMED SYNTAX NOT JSON>>>', 'utf8')
    const fallbackData = readTendersStore(corruptFile)
    assert(fallbackData.version === CURRENT_TENDERS_SCHEMA_VERSION, `Corrupted file read returns fallback version ${CURRENT_TENDERS_SCHEMA_VERSION}`)
    assert(existsSync(`${corruptFile}.corrupted.bak`), `Backup file ${corruptFile}.corrupted.bak was created`)
    assert(readFileSync(`${corruptFile}.corrupted.bak`, 'utf8') === '<<<MALFORMED SYNTAX NOT JSON>>>', `Backup content preserved verbatim`)

    // 1.5 Atomic Write Round-Trip
    console.log('\n[1.5] Atomic Store Write & Round-Trip Disk Persistence:')
    writeTendersStore(corruptFile, validatedMixed)
    assert(existsSync(corruptFile), `tenders-data.json exists on disk after atomic write`)
    const reReadDisk = readTendersStore(corruptFile)
    assert(reReadDisk.workspaces[0].vault.length === 8, `Disk store correctly read back with 8 vault documents`)
    assert(reReadDisk.workspaces[0].customers.length === 6, `Disk store correctly read back with 6 customers`)
    assert(reReadDisk.workspaces[0].tenders.length === 2, `Disk store correctly read back with 2 tenders`)

    // ========================================================================
    // CATEGORY 2: MILESTONE BILLING SYNCHRONIZATION
    // ========================================================================
    console.log('\n--- CATEGORY 2: Milestone Billing Synchronization ---')

    // Reset clean stores
    registerTendersIpc()
    const initialTendersEnvelope = migrateAndValidateTenders(null)
    writeTendersStore(tendersJsonPath, initialTendersEnvelope)

    // Setup initial Books store
    const initialBooks = {
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: { companyName: 'Thabo Engineering (Pty) Ltd', currency: 'ZAR' },
      accounts: [
        { id: 'acc-bank', name: 'Bank', balance: 500000 },
        { id: 'acc-ar', name: 'Accounts Receivable', balance: 100000 },
        { id: 'acc-sales', name: 'Sales', balance: 400000 },
        { id: 'acc-vat', name: 'VAT Output', balance: 50000 },
      ],
      parties: [],
      invoices: [],
      journalEntries: [],
    }
    writeFileSync(booksJsonPath, JSON.stringify(initialBooks, null, 2), 'utf8')

    // Capture broadcast events
    const broadcastEvents: Array<{ channel: string; data: any }> = []
    const billingSubscriber = {
      isDestroyed: () => false,
      send: (channel: string, data: any) => {
        broadcastEvents.push({ channel, data })
      },
      once: (_ev: string, _fn: () => void) => {},
    }
    registerTendersWebContents(billingSubscriber as any)

    // 2.1 Successful Billing of ms-01
    console.log('\n[2.1] Successful Milestone Billing Execution:')
    const billRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      tenderReference: 'RFP-WTR-2026-04',
      issuingAuthority: 'City of Ekurhuleni Water Dept',
      milestoneTitle: 'Phase 1 Reservoir Valve Refurbishment',
      amount: 145000,
    })

    assert(billRes.ok === true, `billMilestoneInBooks succeeded with ok: true`)
    assert(typeof billRes.invoiceNumber === 'string' && billRes.invoiceNumber.startsWith('INV-'), `Generated invoice number: ${billRes.invoiceNumber}`)
    assert(billRes.grandTotal === 145000, `Invoice grand total matches milestone amount (145000)`)
    assert(billRes.subtotal === 126086.96, `Invoice subtotal (ex-VAT) correctly calculated as 126086.96`)
    assert(billRes.taxTotal === 18913.04, `Invoice 15% VAT correctly calculated as 18913.04`)

    // Verify Tenders Disk Store
    const billedDiskTenders = readTendersStore(tendersJsonPath)
    const diskTender = billedDiskTenders.workspaces[0].tenders.find((t: any) => t.id === 'tender-wtr-04')
    const diskMilestone = diskTender.milestones.find((m: any) => m.id === 'ms-01')
    assert(diskMilestone.status === 'BILLED', `Milestone status on disk updated to 'BILLED'`)
    assert(diskMilestone.billedInvoiceId === billRes.invoiceId, `Milestone billedInvoiceId on disk matches created invoice ID`)
    assert(diskMilestone.billedInvoiceNumber === billRes.invoiceNumber, `Milestone billedInvoiceNumber on disk matches invoice number`)
    assert(typeof diskMilestone.billedAt === 'string' && !isNaN(Date.parse(diskMilestone.billedAt)), `Milestone billedAt timestamp recorded on disk`)

    // Verify Books Disk Store
    const updatedBooks = readBooksStore(booksJsonPath)
    const createdInvoice = updatedBooks.invoices.find((inv: any) => inv.id === billRes.invoiceId)
    assert(createdInvoice !== undefined, `Invoice created in Books store`)
    assert(createdInvoice.tenderReference === 'RFP-WTR-2026-04', `Invoice references RFP-WTR-2026-04`)
    assert(createdInvoice.partyName === 'City of Ekurhuleni Water Dept', `Invoice party is 'City of Ekurhuleni Water Dept'`)
    assert(createdInvoice.grandTotal === 145000, `Invoice grandTotal is 145000`)
    assert(createdInvoice.status === 'Unpaid', `Invoice status is 'Unpaid'`)

    // Verify Double-Entry Journal
    const journalEntry = updatedBooks.journalEntries[0]
    assert(journalEntry !== undefined, `Balanced journal entry created in Books`)
    assert(journalEntry.totalDebit === 145000 && journalEntry.totalCredit === 145000, `Journal entry balanced: Debit == Credit == 145000`)
    assert(journalEntry.posted === true, `Journal entry marked as posted`)

    // Verify Ledger Account Adjustments
    const arAcc = updatedBooks.accounts.find((a: any) => a.id === 'acc-ar')
    const salesAcc = updatedBooks.accounts.find((a: any) => a.id === 'acc-sales')
    const vatAcc = updatedBooks.accounts.find((a: any) => a.id === 'acc-vat')
    assert(arAcc.balance === 245000, `Accounts Receivable increased by 145000 (100000 -> 245000)`)
    assert(salesAcc.balance === 526086.96, `Sales increased by 126086.96 (400000 -> 526086.96)`)
    assert(vatAcc.balance === 68913.04, `VAT Output increased by 18913.04 (50000 -> 68913.04)`)

    // Verify Broadcast Event Received
    const lastBroadcast = broadcastEvents[broadcastEvents.length - 1]
    assert(lastBroadcast !== undefined, `broadcastTendersData was called on milestone billing`)
    assert(lastBroadcast.channel === TENDERS_CHANNELS.dataChanged, `Broadcast channel is '${TENDERS_CHANNELS.dataChanged}'`)
    const broadcastMs = lastBroadcast.data.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
    assert(broadcastMs.status === 'BILLED', `Broadcast payload reflects BILLED status`)
    assert(broadcastMs.billedInvoiceNumber === billRes.invoiceNumber, `Broadcast payload reflects billed invoice number`)

    // 2.2 Adversarial Billing Cases
    console.log('\n[2.2] Adversarial Billing Edge Cases & Invariant Enforcement:')

    // 2.2a Double-billing ms-01
    const doubleBillRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
    })
    assert(doubleBillRes.ok === false, `Double-billing already billed milestone correctly rejected`)
    assert(doubleBillRes.error?.includes('already billed'), `Error indicates milestone is already billed`)

    // 2.2b Billing unreached ms-02 (status PENDING)
    const unreachedBillRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-02',
    })
    assert(unreachedBillRes.ok === false, `Billing unreached milestone (PENDING) correctly rejected`)
    assert(unreachedBillRes.error?.includes('not in REACHED status') || unreachedBillRes.error?.includes('not reached'), `Error indicates milestone is not reached`)

    // 2.2c Non-existent tender ID
    const ghostTenderRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: 'tender-ghost-99',
      milestoneId: 'ms-01',
    })
    assert(ghostTenderRes.ok === false, `Billing non-existent tender correctly rejected`)
    assert(ghostTenderRes.error?.includes('Tender not found'), `Error specifies tender not found`)

    // 2.2d Non-existent milestone ID
    const ghostMsRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-ghost-99',
    })
    assert(ghostMsRes.ok === false, `Billing non-existent milestone correctly rejected`)
    assert(ghostMsRes.error?.includes('Milestone not found'), `Error specifies milestone not found`)

    // 2.2e Zero or negative amount
    // First manually temporarily reset ms-01 to REACHED in store to test amount validation
    const tempStore = readTendersStore(tendersJsonPath)
    tempStore.workspaces[0].tenders[0].milestones.push({
      id: 'ms-zero',
      title: 'Zero Amount Test',
      amount: 0,
      status: 'REACHED',
    })
    writeTendersStore(tendersJsonPath, tempStore)

    const zeroAmountRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-zero',
      amount: 0,
    })
    assert(zeroAmountRes.ok === false, `Billing milestone with amount 0 correctly rejected`)
    assert(zeroAmountRes.error?.includes('must be greater than 0'), `Error indicates amount must be > 0`)

    // ========================================================================
    // CATEGORY 3: MULTI-WINDOW / MULTI-SUBSCRIBER SIMULATION
    // ========================================================================
    console.log('\n--- CATEGORY 3: Multi-Window & Multi-Subscriber Simulation ---')

    // 3.1 Multi-WebContents Broadcast Distribution
    console.log('\n[3.1] Broadcast Distribution to Multiple Concurrent WebContents:')
    const receivedCounters: Record<string, number> = {}
    const multiSubscribers: any[] = []

    for (let i = 1; i <= 5; i++) {
      const subId = `wc-window-${i}`
      receivedCounters[subId] = 0
      const sub = {
        id: subId,
        isDestroyed: () => false,
        send: (channel: string, _data: any) => {
          if (channel === TENDERS_CHANNELS.dataChanged) {
            receivedCounters[subId]++
          }
        },
        once: (_ev: string, _fn: () => void) => {},
      }
      multiSubscribers.push(sub)
      registerTendersWebContents(sub as any)
    }

    const testPayload = migrateAndValidateTenders(null)
    testPayload.updatedAt = '2026-09-04T20:00:00.000Z'
    broadcastTendersData(testPayload)

    for (let i = 1; i <= 5; i++) {
      const subId = `wc-window-${i}`
      assert(receivedCounters[subId] === 1, `${subId} received exactly 1 broadcast event`)
    }

    // 3.2 Handling Destroyed WebContents
    console.log('\n[3.2] Isolation and Cleanup of Destroyed WebContents:')
    // Mark Window 2 as destroyed via isDestroyed()
    multiSubscribers[1].isDestroyed = () => true
    // Destroy Window 4 via unregister
    unregisterTendersWebContents(multiSubscribers[3] as any)

    testPayload.updatedAt = '2026-09-04T20:01:00.000Z'
    broadcastTendersData(testPayload)

    assert(receivedCounters['wc-window-1'] === 2, `Active Window 1 received second broadcast`)
    assert(receivedCounters['wc-window-2'] === 1, `Destroyed Window 2 ignored (count stayed at 1)`)
    assert(receivedCounters['wc-window-3'] === 2, `Active Window 3 received second broadcast`)
    assert(receivedCounters['wc-window-4'] === 1, `Unregistered Window 4 ignored (count stayed at 1)`)
    assert(receivedCounters['wc-window-5'] === 2, `Active Window 5 received second broadcast`)

    // 3.3 Exception-Throwing WebContents Resilience
    console.log('\n[3.3] Resilience Against Crashing / Throwing WebContents:')
    multiSubscribers[2].send = () => {
      throw new Error('Simulated IPC crash: Object has been destroyed')
    }

    testPayload.updatedAt = '2026-09-04T20:02:00.000Z'
    // broadcastTendersData should NOT throw
    let broadcastThrew = false
    try {
      broadcastTendersData(testPayload)
    } catch {
      broadcastThrew = true
    }

    assert(broadcastThrew === false, `broadcastTendersData did not throw when a subscriber crashed`)
    assert(receivedCounters['wc-window-1'] === 3, `Window 1 still received broadcast despite Window 3 crash`)
    assert(receivedCounters['wc-window-5'] === 3, `Window 5 still received broadcast despite Window 3 crash`)

    // 3.4 Multi-Renderer Echo Loop Prevention
    console.log('\n[3.4] Multi-Renderer Feedback Loop Prevention:')
    const initialSaveCalls = rendererSavedDataCalls.length

    // Simulate renderer store receiving broadcast
    const incomingData = migrateAndValidateTenders(null)
    incomingData.workspaces[0].tenders[0].title = 'Sync From Main Test'
    useTendersStore.getState().syncFromMain(incomingData)

    // Wait 350ms to exceed any debounce timer
    await new Promise((r) => setTimeout(r, 400))

    const finalSaveCalls = rendererSavedDataCalls.length
    assert(finalSaveCalls === initialSaveCalls, `syncFromMain did not trigger outbound saveStoredData (no feedback loop)`)

    // ========================================================================
    // CATEGORY 4: EXTERNAL DISK FILE WATCHER MULTI-BROADCAST
    // ========================================================================
    console.log('\n--- CATEGORY 4: File Watcher External Synchronization ---')

    startTendersStoreWatcher(tendersJsonPath)

    const watcherEvents: any[] = []
    const watcherSubscriber = {
      isDestroyed: () => false,
      send: (channel: string, data: any) => {
        if (channel === TENDERS_CHANNELS.dataChanged) {
          watcherEvents.push(data)
        }
      },
      once: (_ev: string, _fn: () => void) => {},
    }
    registerTendersWebContents(watcherSubscriber as any)

    // Simulate external system modifying tenders-data.json directly on disk
    const diskStoreData = readTendersStore(tendersJsonPath)
    diskStoreData.workspaces[0].tenders[0].title = 'Externally Modified Title By Script'
    diskStoreData.updatedAt = new Date().toISOString()
    writeFileSync(tendersJsonPath, JSON.stringify(diskStoreData, null, 2), 'utf8')

    // Wait up to 1500ms for watcher debounce and broadcast
    const watcherWaitStart = Date.now()
    while (watcherEvents.length === 0 && Date.now() - watcherWaitStart < 1500) {
      await new Promise((r) => setTimeout(r, 50))
    }

    assert(watcherEvents.length > 0, `File watcher detected on-disk modification and broadcasted event`)
    const watcherTitle = watcherEvents[0]?.workspaces[0]?.tenders[0]?.title
    assert(watcherTitle === 'Externally Modified Title By Script', `Watcher broadcast payload has updated title`)

    stopTendersStoreWatcher()

    // ------------------------------------------------------------------------
    // SUMMARY
    // ------------------------------------------------------------------------
    console.log('\n======================================================================')
    console.log(`RESULTS SUMMARY:`)
    console.log(`  Total Tests Run: ${totalTests}`)
    console.log(`  Passed: ${passedTests}`)
    console.log(`  Failed: ${failedTests}`)
    console.log('======================================================================\n')

    if (failedTests > 0) {
      console.error('❌ EMPIRICAL VERIFICATION FAILED with errors:')
      for (const f of failures) {
        console.error(`  - ${f.name}: ${f.error}`)
      }
      process.exit(1)
    } else {
      console.log('🎉 ALL EMPIRICAL CHALLENGER TESTS PASSED SUCCESSFULLY! (VERDICT: APPROVE)')
      process.exit(0)
    }
  } catch (err: any) {
    console.error('\n❌ UNEXPECTED HARNESS FAILURE:', err)
    process.exit(1)
  } finally {
    try {
      stopTendersStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    } catch {}
  }
}

void runChallengerSuite()

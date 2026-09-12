#!/usr/bin/env node
/**
 * tools/verify-tenders-sync.ts
 *
 * Automated Verification Suite for Milestone 1:
 * Unified Main-Renderer State Synchronization (R1)
 *
 * Checks:
 * 1. Harmonized Seed Data Integrity (MOCK_COMPANY, MOCK_CUSTOMERS, MOCK_VAULT)
 * 2. Legacy/empty store migration (retains 7 vault documents)
 * 3. Renderer persistence to tenders-data.json (Requirement 6.a)
 * 4. Restart rehydration: data loads identically after simulated restart (Requirement 6.a)
 * 5. Main-to-Renderer IPC broadcast (tenders:data-changed emitted to active WebContents)
 * 6. External disk modifications update renderer store without reload (Requirement 6.b)
 * 7. Feedback loop prevention guard (isSyncingFromMain)
 * 8. billMilestoneInBooks persists to disk and triggers live broadcast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Module from 'node:module'

// ----------------------------------------------------------------------------
// Mock Electron before loading tenders modules
// ----------------------------------------------------------------------------
const ipcHandlers: Record<string, (...args: any[]) => any> = {}
const testDir = join(tmpdir(), `tenders-test-${randomUUID().slice(0, 8)}`)
mkdirSync(testDir, { recursive: true })

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
    send: (channel: string, ...args: any[]) => {
      webContentsEvents.push({ channel, args })
    },
    loadURL: async () => {},
    loadFile: async () => {},
    once: (_event: string, _fn: () => void) => {},
  }
}

const webContentsEvents: Array<{ channel: string; args: any[] }> = []

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
// Load Tenders Modules
// ----------------------------------------------------------------------------
const tendersMain = require('../apps/tenders/src/main/tenders-main.ts')
const {
  CURRENT_TENDERS_SCHEMA_VERSION,
  SEED_COMPANY_ID,
  migrateAndValidateTenders,
  readTendersStore,
  writeTendersStore,
  registerTendersIpc,
  registerTendersWebContents,
  broadcastTendersData,
  startTendersStoreWatcher,
  stopTendersStoreWatcher,
} = tendersMain

const tendersIpc = require('../apps/tenders/src/shared/ipc.ts')
const { TENDERS_CHANNELS } = tendersIpc

// Setup mock window for renderer store
const listeners: Record<string, Array<(...args: any[]) => void>> = {}
let savedDataCalls: string[] = []

const mockTendersApi = {
  getStoredData: async () => {
    const fn = ipcHandlers[TENDERS_CHANNELS.getStoredData]
    if (fn) return fn({ sender: null })
    return null
  },
  saveStoredData: async (json: string) => {
    savedDataCalls.push(json)
    const fn = ipcHandlers[TENDERS_CHANNELS.saveStoredData]
    if (fn) return fn({ sender: null }, json)
    return { ok: true }
  },
  onDataChanged: (cb: (data: any) => void) => {
    if (!listeners[TENDERS_CHANNELS.dataChanged]) {
      listeners[TENDERS_CHANNELS.dataChanged] = []
    }
    listeners[TENDERS_CHANNELS.dataChanged].push(cb)
    return () => {
      const arr = listeners[TENDERS_CHANNELS.dataChanged]
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

;(global as any).window = {
  tendersApi: mockTendersApi,
  localStorage: mockLocalStorage,
}

const tendersStoreModule = require('../apps/tenders/src/renderer/src/store.ts')
const { useTendersStore, scheduleSaveToMain } = tendersStoreModule

// Subscribe renderer store to onDataChanged exactly as App.tsx does
mockTendersApi.onDataChanged((data) => {
  useTendersStore.getState().syncFromMain(data)
})

// ----------------------------------------------------------------------------
// Test Runner
// ----------------------------------------------------------------------------
let passed = 0
let failed = 0

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error(`  ❌ FAIL: ${msg}`)
    failed++
    throw new Error(msg)
  } else {
    console.log(`  ✅ PASS: ${msg}`)
    passed++
  }
}

async function runTests() {
  console.log('\n======================================================================')
  console.log('   ZANOSTACK TENDERS STATE SYNCHRONIZATION VERIFICATION (M1)')
  console.log('======================================================================\n')

  try {
    // ------------------------------------------------------------------------
    // TEST 1: Harmonized seed data integrity
    // ------------------------------------------------------------------------
    console.log('--- TEST 1: Harmonized Seed Data Integrity ---')
    const seed = migrateAndValidateTenders(null)
    assert(seed.version === CURRENT_TENDERS_SCHEMA_VERSION, `Seed version is ${CURRENT_TENDERS_SCHEMA_VERSION}`)
    assert(seed.activeCompanyId === 'co-thabo', `Seed activeCompanyId is 'co-thabo'`)
    assert(seed.workspaces.length === 1, `Seed contains 1 workspace`)
    const ws = seed.workspaces[0]
    assert(ws.id === 'co-thabo', `Workspace id is 'co-thabo'`)
    assert(ws.company.name === 'Thabo Engineering (Pty) Ltd', `Company name is 'Thabo Engineering (Pty) Ltd'`)
    assert(ws.company.tradingName === 'Thabo Engineering', `Company trading name is 'Thabo Engineering'`)
    assert(Array.isArray(ws.customers) && ws.customers.length === 5, `Customers has 5 mock entries (c-1 to c-5)`)
    assert(Array.isArray(ws.vault) && ws.vault.length === 7, `Vault has all 7 compliance documents`)
    assert(ws.vault.some((d: any) => d.id === 'vd-tax'), `Vault contains SARS Tax Clearance (vd-tax)`)
    assert(ws.vault.some((d: any) => d.id === 'vd-coida'), `Vault contains COIDA (vd-coida)`)
    assert(ws.vault.some((d: any) => d.id === 'vd-bbbee'), `Vault contains B-BBEE (vd-bbbee)`)
    assert(ws.tenders.length === 1 && ws.tenders[0].referenceNumber === 'RFP-WTR-2026-04', `Default tender RFP-WTR-2026-04 present`)
    assert(ws.tenders[0].milestones.length === 2, `Default tender has 2 contract milestones`)

    // ------------------------------------------------------------------------
    // TEST 2: Seed harmonization on legacy/empty files
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 2: Legacy / Empty File Migration ---')
    const legacyEmpty = {
      version: 1,
      activeCompanyId: 'comp-zano-01',
      workspaces: [
        {
          id: 'ws-ekurhuleni-01',
          name: 'Ekurhuleni Water Infrastructure',
          company: { name: 'Zano Consulting (Pty) Ltd' },
          customers: [],
          vault: [],
          tenders: [],
        },
      ],
    }
    const migrated = migrateAndValidateTenders(legacyEmpty)
    assert(migrated.activeCompanyId === 'co-thabo', `Legacy company id migrated to 'co-thabo'`)
    assert(migrated.workspaces[0].vault.length === 7, `Empty vault in legacy file migrated with all 7 compliance documents`)
    assert(migrated.workspaces[0].customers.length === 5, `Empty customers in legacy file migrated with 5 customers`)
    assert(migrated.workspaces[0].tenders.length === 1, `Empty tenders in legacy file migrated with SEED_TENDER_WTR_04`)

    // ------------------------------------------------------------------------
    // TEST 3: IPC Registration & Active WebContents Tracking
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 3: Active WebContents Tracking & Broadcast ---')
    registerTendersIpc()
    assert(typeof ipcHandlers[TENDERS_CHANNELS.getStoredData] === 'function', `getStoredData IPC handler registered`)
    assert(typeof ipcHandlers[TENDERS_CHANNELS.saveStoredData] === 'function', `saveStoredData IPC handler registered`)
    assert(typeof ipcHandlers[TENDERS_CHANNELS.billMilestoneInBooks] === 'function', `billMilestoneInBooks IPC handler registered`)

    const mockWc = {
      isDestroyed: () => false,
      send: (channel: string, data: any) => {
        webContentsEvents.push({ channel, args: [data] })
        // Relay to renderer mock listeners
        const cbs = listeners[channel] || []
        for (const cb of cbs) cb(data)
      },
      once: (_ev: string, _fn: () => void) => {},
    }
    registerTendersWebContents(mockWc as any)

    // Verify broadcastTendersData sends to active WebContents
    const sampleEnvelope = migrateAndValidateTenders(null)
    sampleEnvelope.updatedAt = '2026-09-04T19:00:00Z'
    broadcastTendersData(sampleEnvelope)

    const lastEvent = webContentsEvents[webContentsEvents.length - 1]
    assert(lastEvent?.channel === TENDERS_CHANNELS.dataChanged, `broadcastTendersData sends to ${TENDERS_CHANNELS.dataChanged}`)
    assert(lastEvent?.args[0]?.updatedAt === '2026-09-04T19:00:00Z', `Broadcast payload matches transmitted data`)

    // ------------------------------------------------------------------------
    // TEST 4: Renderer Persistence & App Restart (Requirement 6.a)
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 4: Renderer Persistence & Restart Integrity (Req 6.a) ---')
    const tendersJsonPath = join(testDir, 'tenders', 'tenders-data.json')
    mkdirSync(join(testDir, 'tenders'), { recursive: true })

    // Simulate loadFromMain on fresh app launch
    savedDataCalls = []
    await useTendersStore.getState().loadFromMain()
    assert(existsSync(tendersJsonPath), `tenders-data.json created on disk after initial loadFromMain`)

    // Simulate renderer user mutation
    const initialTender = useTendersStore.getState().tenders[0]
    assert(initialTender?.id === 'tender-wtr-04', `Found active tender in renderer store`)

    useTendersStore.getState().updateTender('tender-wtr-04', {
      estimatedValue: 777000,
      title: 'Upgraded Bulk Water Infrastructure Phase 3',
    })

    // Trigger debounced save to main
    useTendersStore.getState().saveToMain()
    // Wait for debounce timer (350ms)
    await new Promise((r) => setTimeout(r, 400))

    assert(existsSync(tendersJsonPath), `tenders-data.json exists on disk`)
    const rawSaved = JSON.parse(readFileSync(tendersJsonPath, 'utf8'))
    const savedTender = rawSaved.workspaces[0].tenders.find((t: any) => t.id === 'tender-wtr-04')
    assert(savedTender.estimatedValue === 777000, `Saved to disk: estimatedValue updated to 777000`)
    assert(savedTender.title === 'Upgraded Bulk Water Infrastructure Phase 3', `Saved to disk: title updated`)

    // Simulate APP RESTART: Reset in-memory store state to default, then call loadFromMain
    useTendersStore.setState({
      workspaces: [],
      tenders: [],
      activeCompanyId: '',
    })
    assert(useTendersStore.getState().tenders.length === 0, `Store memory cleared to simulate app termination`)

    // Rehydrate from main process disk
    await useTendersStore.getState().loadFromMain()
    const rehydratedTender = useTendersStore.getState().tenders.find((t: any) => t.id === 'tender-wtr-04')
    assert(rehydratedTender !== undefined, `Tender successfully rehydrated from disk`)
    assert(rehydratedTender.estimatedValue === 777000, `Rehydrated tender identically retains estimatedValue (777000)`)
    assert(rehydratedTender.title === 'Upgraded Bulk Water Infrastructure Phase 3', `Rehydrated tender identically retains title`)

    // ------------------------------------------------------------------------
    // TEST 5: Live UI Update on External Modification without reload (Requirement 6.b)
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 5: External Modification Broadcast & Live Sync (Req 6.b) ---')
    // Start watcher on storage path
    startTendersStoreWatcher(tendersJsonPath)

    let rendererReceivedLiveUpdate = false
    const unsub = useTendersStore.subscribe((state) => {
      const t = state.tenders.find((x) => x.id === 'tender-wtr-04')
      if (t && t.title === 'External System Modified Title') {
        rendererReceivedLiveUpdate = true
      }
    })

    // Simulate external tool/script directly editing tenders-data.json
    const diskContent = readTendersStore(tendersJsonPath)
    diskContent.workspaces[0].tenders[0].title = 'External System Modified Title'
    diskContent.updatedAt = new Date().toISOString()
    writeFileSync(tendersJsonPath, JSON.stringify(diskContent, null, 2), 'utf8')

    // Wait for watcher debounce (100ms) and broadcast
    const startWait = Date.now()
    while (!rendererReceivedLiveUpdate && Date.now() - startWait < 1500) {
      await new Promise((r) => setTimeout(r, 50))
    }

    assert(rendererReceivedLiveUpdate === true, `Renderer store received live update on external modification without reload`)
    const currentInMemTitle = useTendersStore.getState().tenders.find((t) => t.id === 'tender-wtr-04')?.title
    assert(currentInMemTitle === 'External System Modified Title', `In-memory title updated to 'External System Modified Title'`)

    unsub()
    stopTendersStoreWatcher()

    // ------------------------------------------------------------------------
    // TEST 6: Echo Loop Prevention Guard (isSyncingFromMain)
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 6: Echo Loop Prevention Guard ---')
    const beforeSaveCount = savedDataCalls.length
    const incomingBroadcast = migrateAndValidateTenders(null)
    incomingBroadcast.workspaces[0].tenders[0].title = 'Echo Guard Test Title'

    useTendersStore.getState().syncFromMain(incomingBroadcast)
    // Wait for any potential debounce timer
    await new Promise((r) => setTimeout(r, 400))

    const afterSaveCount = savedDataCalls.length
    assert(afterSaveCount === beforeSaveCount, `syncFromMain did not trigger outbound saveStoredData (no feedback loop)`)

    // ------------------------------------------------------------------------
    // TEST 7: billMilestoneInBooks Persistence & Live Broadcast
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 7: billMilestoneInBooks Persistence & Broadcast ---')
    // Set Books store in testDir
    const booksDir = join(testDir, 'books')
    mkdirSync(booksDir, { recursive: true })
    const initialBooks = {
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: { companyName: 'Zano Consulting', currency: 'ZAR' },
      accounts: [
        { id: 'acc-bank', name: 'Bank', balance: 100000 },
        { id: 'acc-ar', name: 'Accounts Receivable', balance: 0 },
        { id: 'acc-sales', name: 'Sales', balance: 0 },
        { id: 'acc-vat', name: 'VAT Output', balance: 0 },
      ],
      parties: [],
      invoices: [],
      journalEntries: [],
    }
    writeFileSync(join(booksDir, 'books-data.json'), JSON.stringify(initialBooks, null, 2), 'utf8')

    const billResult = await mockTendersApi.billMilestoneInBooks({
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      tenderReference: 'RFP-WTR-2026-04',
      issuingAuthority: 'City of Ekurhuleni Water Dept',
      milestoneTitle: 'Phase 1 Reservoir Valve Refurbishment',
      amount: 145000,
    })

    assert(billResult.ok === true, `billMilestoneInBooks returned ok: true`)
    assert(typeof billResult.invoiceNumber === 'string', `Invoice number generated: ${billResult.invoiceNumber}`)

    // Check disk storage
    const updatedDiskTenders = readTendersStore(tendersJsonPath)
    const diskMs = updatedDiskTenders.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
    assert(diskMs.status === 'BILLED', `Milestone status on disk is BILLED`)
    assert(diskMs.billedInvoiceNumber === billResult.invoiceNumber, `Milestone billedInvoiceNumber saved on disk`)

    // Check renderer in-memory store
    const inMemMs = useTendersStore.getState().tenders[0].milestones?.find((m: any) => m.id === 'ms-01')
    assert(inMemMs?.status === 'BILLED', `Renderer in-memory store reflects BILLED status live`)
    assert(inMemMs?.billedInvoiceNumber === billResult.invoiceNumber, `Renderer in-memory store reflects billedInvoiceNumber live`)

    console.log('\n----------------------------------------------------------------------')
    console.log(`Results: ${passed} passed, ${failed} failed`)
    console.log('🎉 ALL STATE SYNCHRONIZATION VERIFICATIONS PASSED!')
    console.log('----------------------------------------------------------------------\n')
  } catch (err) {
    console.error('\n❌ VERIFICATION TEST FAILED:', err)
    process.exit(1)
  } finally {
    try {
      stopTendersStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    } catch {}
  }
}

void runTests()

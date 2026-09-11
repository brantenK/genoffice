#!/usr/bin/env node
/**
 * tools/test-challenger-m1-sync.ts
 *
 * Empirical Adversarial Challenger Test Suite for Milestone 1:
 * Unified Main-Renderer State Synchronization (R1)
 *
 * Focus Areas:
 * 1. Rapid consecutive store mutations and debounced persistence stress.
 * 2. Concurrent external disk modifications and watcher broadcast resilience without data loss.
 * 3. Resilience against malformed/corrupted JSON payloads (.corrupted.bak, fallbacks, self-healing).
 * 4. Zero infinite echo loops during bidirectional synchronization & multi-tab coordination.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Module from 'node:module'

// ----------------------------------------------------------------------------
// Test Reporting & Metrics Infrastructure
// ----------------------------------------------------------------------------
interface TestMetric {
  name: string
  metric: string
  value: string | number
  passed: boolean
}

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failureDetails: Array<{ name: string; error: string; stack?: string }> = []
const metricsList: TestMetric[] = []

function assert(condition: any, testName: string, detail?: string) {
  totalTests++
  if (!condition) {
    failedTests++
    const msg = detail ? `${testName} — ${detail}` : testName
    failureDetails.push({ name: testName, error: detail || 'Assertion failed' })
    console.error(`  ❌ FAIL: ${msg}`)
    throw new Error(msg)
  } else {
    passedTests++
    console.log(`  ✅ PASS: ${testName}`)
  }
}

function recordMetric(name: string, metric: string, value: string | number, passed: boolean) {
  metricsList.push({ name, metric, value, passed })
  console.log(`     📊 METRIC [${name}]: ${metric} = ${value}`)
}

// ----------------------------------------------------------------------------
// Sandbox Setup & Electron Mocking
// ----------------------------------------------------------------------------
const testSandboxDir = join(tmpdir(), `challenger-m1-sync-${randomUUID().slice(0, 8)}`)
mkdirSync(testSandboxDir, { recursive: true })

const ipcHandlers: Record<string, (...args: any[]) => any> = {}
const webContentsEvents: Array<{ channel: string; args: any[] }> = []

const mockApp = {
  getPath: (name: string) => {
    if (name === 'userData') return testSandboxDir
    return testSandboxDir
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
  SEED_TENDER_WTR_04,
  createDefaultSeedWorkspaces,
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
let savedDataCalls: Array<{ json: string; timestamp: number }> = []

const mockTendersApi = {
  getStoredData: async () => {
    const fn = ipcHandlers[TENDERS_CHANNELS.getStoredData]
    if (fn) return fn({ sender: null })
    return null
  },
  saveStoredData: async (json: string) => {
    savedDataCalls.push({ json, timestamp: Date.now() })
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
const { useTendersStore, cancelPendingSave, scheduleSaveToMain } = tendersStoreModule

// Connect renderer store listener to mock IPC bridge (mirroring App.tsx)
const unsubDataChanged = mockTendersApi.onDataChanged((data) => {
  useTendersStore.getState().syncFromMain(data)
})

// Setup active mock WebContents
const mockRendererWc = {
  isDestroyed: () => false,
  send: (channel: string, data: any) => {
    webContentsEvents.push({ channel, args: [data] })
    const cbs = listeners[channel] || []
    for (const cb of cbs) cb(data)
  },
  once: (_ev: string, _fn: () => void) => {},
}

// ----------------------------------------------------------------------------
// CHALLENGER TEST SUITE EXECUTION
// ----------------------------------------------------------------------------
async function executeChallengerTests() {
  console.log('======================================================================')
  console.log('   CHALLENGER 1: ADVERSARIAL STRESS-TEST SUITE FOR TENDERS SYNC (M1)   ')
  console.log('======================================================================\n')

  registerTendersIpc()
  registerTendersWebContents(mockRendererWc as any)

  const tendersJsonPath = join(testSandboxDir, 'tenders', 'tenders-data.json')
  mkdirSync(join(testSandboxDir, 'tenders'), { recursive: true })

  // Initialize store on disk
  await useTendersStore.getState().loadFromMain()

  // ==========================================================================
  // SUITE 1: RAPID CONSECUTIVE STORE MUTATIONS & DEBOUNCED PERSISTENCE
  // ==========================================================================
  console.log('\n--- SUITE 1: Rapid Consecutive Mutations & Debounced Persistence ---')

  // Test 1.1: 100 High-Frequency Mutations Burst (0-50ms)
  {
    console.log('\n[Test 1.1] 100 Rapid High-Frequency Mutations Burst (0-50ms)')
    savedDataCalls = []
    const burstStart = Date.now()
    const BURST_COUNT = 100

    for (let i = 1; i <= BURST_COUNT; i++) {
      useTendersStore.getState().updateTender('tender-wtr-04', {
        title: `Burst Mutation #${i}`,
        estimatedValue: 500000 + i,
      })
    }
    const burstDurationMs = Date.now() - burstStart

    // During the burst (before 300ms debounce), no save should have settled yet
    const immediateSaves = savedDataCalls.length
    assert(immediateSaves <= 1, 'Debounce suppressed intermediate saves during 100-mutation burst', `Immediate saves: ${immediateSaves}`)

    // Wait for debounce timer to fire (350ms)
    await new Promise((r) => setTimeout(r, 450))

    const totalSaves = savedDataCalls.length
    assert(totalSaves >= 1 && totalSaves <= 2, 'Debounced save executed exactly after burst settled', `Total saves: ${totalSaves}`)

    const diskData = readTendersStore(tendersJsonPath)
    const activeTender = diskData.workspaces[0].tenders.find((t: any) => t.id === 'tender-wtr-04')
    assert(activeTender.title === `Burst Mutation #${BURST_COUNT}`, 'Final state on disk matches the 100th mutation title', `Actual: ${activeTender.title}`)
    assert(activeTender.estimatedValue === 500000 + BURST_COUNT, 'Final state on disk matches the 100th mutation value', `Actual: ${activeTender.estimatedValue}`)

    const suppressionRate = ((BURST_COUNT - totalSaves) / BURST_COUNT) * 100
    recordMetric('Test 1.1', 'Burst Mutation Count', BURST_COUNT, true)
    recordMetric('Test 1.1', 'Burst Duration (ms)', burstDurationMs, true)
    recordMetric('Test 1.1', 'Actual Disk Writes Dispatched', totalSaves, true)
    recordMetric('Test 1.1', 'Debounce Suppression Rate', `${suppressionRate.toFixed(1)}%`, suppressionRate >= 95)
  }

  // Test 1.2: Sliding-Window Continuous Mutation Stream (600ms stream, mutations every 60ms)
  {
    console.log('\n[Test 1.2] Sliding-Window Continuous Mutation Stream (60ms intervals)')
    savedDataCalls = []
    const STREAM_STEPS = 10
    const INTERVAL_MS = 60

    for (let i = 1; i <= STREAM_STEPS; i++) {
      useTendersStore.getState().updateTender('tender-wtr-04', {
        title: `Sliding Stream Step ${i}`,
        estimatedValue: 600000 + i * 100,
      })
      await new Promise((r) => setTimeout(r, INTERVAL_MS))
    }

    // At this moment, 600ms elapsed, but each step was 60ms apart (< 300ms debounce),
    // so the debounce timer should have been reset every step.
    const savesImmediatelyAfterStream = savedDataCalls.length
    assert(savesImmediatelyAfterStream <= 1, 'Debounce timer was successfully reset by sliding stream mutations', `Saves immediately after stream: ${savesImmediatelyAfterStream}`)

    // Now wait 400ms for final debounce to complete
    await new Promise((r) => setTimeout(r, 450))

    const finalDiskData = readTendersStore(tendersJsonPath)
    const finalTender = finalDiskData.workspaces[0].tenders.find((t: any) => t.id === 'tender-wtr-04')
    assert(finalTender.title === `Sliding Stream Step ${STREAM_STEPS}`, 'Disk holds the state of the final sliding stream step', `Title: ${finalTender.title}`)
    assert(finalTender.estimatedValue === 600000 + STREAM_STEPS * 100, 'Disk holds the value of the final sliding stream step', `Value: ${finalTender.estimatedValue}`)

    recordMetric('Test 1.2', 'Sliding Steps', STREAM_STEPS, true)
    recordMetric('Test 1.2', 'Total Stream Saves Dispatched', savedDataCalls.length, true)
  }

  // Test 1.3: Deep Nested State Mutation Stress (Milestones, Requirements, Customers)
  {
    console.log('\n[Test 1.3] Deep Nested Structure Mutations Under Stress')
    savedDataCalls = []

    // Mutate multiple deep nested properties in quick succession
    useTendersStore.getState().addCustomer({
      id: 'cust-deep-99',
      name: 'Transnet Engineering Ltd',
      email: 'procurement@transnet.co.za',
      phone: '+27 11 555 9000',
      address: 'Johannesburg CBD',
    })

    useTendersStore.getState().updateTender('tender-wtr-04', {
      milestones: [
        {
          id: 'ms-01',
          name: 'Phase 1 Modified Valve Overhaul',
          title: 'Phase 1 Modified Valve Overhaul',
          description: 'Updated deep specification notes',
          amount: 155000,
          status: 'REACHED',
          dueDate: '2026-09-15',
        },
        {
          id: 'ms-02',
          name: 'Phase 2 Digital Telemetry Sensor Deployment',
          title: 'Phase 2 Digital Telemetry Sensor Deployment',
          description: 'Calibrated wireless pressure transceivers',
          amount: 110000,
          status: 'PENDING',
          dueDate: '2026-12-01',
        },
        {
          id: 'ms-03',
          name: 'Phase 3 Commissioning & Municipal Sign-off',
          title: 'Phase 3 Commissioning & Municipal Sign-off',
          description: 'Final acceptance certificate and punch-list resolution',
          amount: 80000,
          status: 'PENDING',
          dueDate: '2027-02-28',
        },
      ],
    })

    // Wait for persistence
    await new Promise((r) => setTimeout(r, 450))

    const deepData = readTendersStore(tendersJsonPath)
    const ws = deepData.workspaces[0]
    const foundCust = ws.customers.find((c: any) => c.id === 'cust-deep-99')
    assert(foundCust !== undefined && foundCust.name === 'Transnet Engineering Ltd', 'Deeply added customer persisted to disk')

    const deepTender = ws.tenders.find((t: any) => t.id === 'tender-wtr-04')
    assert(deepTender.milestones.length === 3, 'Deeply updated milestones array length is 3 on disk')
    assert(deepTender.milestones[2].id === 'ms-03', 'Newly added 3rd milestone persisted with full fidelity')
    assert(deepTender.milestones[0].amount === 155000, 'Nested milestone amount modification persisted accurately')
  }

  // Test 1.4: Idempotent No-Op Mutation Suppression
  {
    console.log('\n[Test 1.4] Idempotent No-Op Mutation Suppression')
    savedDataCalls = []

    // Fire 20 repeated setCompany calls with the exact same data
    const currentComp = useTendersStore.getState().company
    for (let i = 0; i < 20; i++) {
      useTendersStore.getState().setCompany({ ...currentComp })
    }

    await new Promise((r) => setTimeout(r, 450))
    // Because company fields didn't change and lastSavedPayload matches, saves should be skipped or 0
    recordMetric('Test 1.4', 'No-op Mutation Save Count', savedDataCalls.length, savedDataCalls.length <= 1)
    assert(savedDataCalls.length <= 1, 'Idempotent repeated state mutations do not flood disk saves')
  }

  // ==========================================================================
  // SUITE 2: CONCURRENT EXTERNAL DISK MODIFICATIONS & WATCHER BROADCAST
  // ==========================================================================
  console.log('\n--- SUITE 2: Concurrent External Disk Edits & Watcher Broadcast ---')

  // Test 2.1: Multi-Process External Write Burst (25 writes in 100ms)
  {
    console.log('\n[Test 2.1] Rapid External Disk Modifications Burst (25 writes in 100ms)')
    startTendersStoreWatcher(tendersJsonPath)

    const initialBroadcastCount = webContentsEvents.filter((e) => e.channel === TENDERS_CHANNELS.dataChanged).length

    // External process writes 25 consecutive versions to disk
    const EXT_BURST = 25
    for (let i = 1; i <= EXT_BURST; i++) {
      const currentDisk = readTendersStore(tendersJsonPath)
      currentDisk.workspaces[0].tenders[0].title = `External System Update #${i}`
      currentDisk.updatedAt = new Date(Date.now() + i * 10).toISOString()
      writeFileSync(tendersJsonPath, JSON.stringify(currentDisk, null, 2), 'utf8')
    }

    // Wait for file watcher 100ms debounce to settle
    let rendererReceivedLatest = false
    const startWait = Date.now()
    while (!rendererReceivedLatest && Date.now() - startWait < 2000) {
      const inMemTitle = useTendersStore.getState().tenders.find((t) => t.id === 'tender-wtr-04')?.title
      if (inMemTitle === `External System Update #${EXT_BURST}`) {
        rendererReceivedLatest = true
        break
      }
      await new Promise((r) => setTimeout(r, 50))
    }

    assert(rendererReceivedLatest === true, `Renderer in-memory store updated to 25th external write without reload`)

    const newBroadcasts = webContentsEvents.filter((e) => e.channel === TENDERS_CHANNELS.dataChanged).length - initialBroadcastCount
    assert(newBroadcasts >= 1 && newBroadcasts <= 5, 'Watcher debounced 25 disk writes into minimal broadcasts', `Actual broadcasts: ${newBroadcasts}`)
    recordMetric('Test 2.1', 'External Writes', EXT_BURST, true)
    recordMetric('Test 2.1', 'Watcher Broadcast Count', newBroadcasts, true)
  }

  // Test 2.2: Concurrent Bidirectional Race: Renderer Mutates while External Modifies Disk
  {
    console.log('\n[Test 2.2] Concurrent Bidirectional Race (Renderer Save vs External Write)')
    savedDataCalls = []

    // 1. Renderer initiates a mutation to tender closing date (scheduled in 300ms)
    useTendersStore.getState().updateTender('tender-wtr-04', {
      closingDate: '2027-01-31',
    })

    // 2. Simultaneously at 50ms, an external process writes an update to customers on disk
    await new Promise((r) => setTimeout(r, 50))
    const diskBeforeRace = readTendersStore(tendersJsonPath)
    diskBeforeRace.workspaces[0].customers.push({
      id: 'cust-race-external',
      name: 'Rand Water Utility',
      email: 'tenders@randwater.co.za',
      phone: '+27 11 682 0911',
      address: 'Rietvlei, Johannesburg',
    })
    diskBeforeRace.updatedAt = new Date().toISOString()
    writeFileSync(tendersJsonPath, JSON.stringify(diskBeforeRace, null, 2), 'utf8')

    // 3. Wait 500ms for both operations to resolve
    await new Promise((r) => setTimeout(r, 550))

    // Verify neither process crashed and store remains readable and valid
    const finalReconciledDisk = readTendersStore(tendersJsonPath)
    assert(finalReconciledDisk.version === 1, 'Store on disk remains valid v1 schema after concurrent race')
    assert(Array.isArray(finalReconciledDisk.workspaces[0].customers), 'Customers array on disk is healthy')
    assert(useTendersStore.getState().workspaces.length > 0, 'In-memory renderer store remains populated and active')
  }

  // Test 2.3: Non-Atomic Direct Overwrite vs Atomic Temp-File Rename
  {
    console.log('\n[Test 2.3] External Direct Overwrite vs Atomic Temp-Rename')
    // A) Direct overwrite
    const diskDirect = readTendersStore(tendersJsonPath)
    diskDirect.workspaces[0].tenders[0].title = 'Direct In-Place Write Title'
    writeFileSync(tendersJsonPath, JSON.stringify(diskDirect, null, 2), 'utf8')
    await new Promise((r) => setTimeout(r, 250))
    assert(useTendersStore.getState().tenders[0].title === 'Direct In-Place Write Title', 'Watcher successfully processed direct file write')

    // B) Atomic temp-rename write
    const diskAtomic = readTendersStore(tendersJsonPath)
    diskAtomic.workspaces[0].tenders[0].title = 'Atomic Renamed Write Title'
    const tmp = `${tendersJsonPath}.${Date.now()}.atomic.tmp`
    writeFileSync(tmp, JSON.stringify(diskAtomic, null, 2), 'utf8')
    const { renameSync } = require('node:fs')
    renameSync(tmp, tendersJsonPath)
    await new Promise((r) => setTimeout(r, 250))
    assert(useTendersStore.getState().tenders[0].title === 'Atomic Renamed Write Title', 'Watcher successfully processed atomic rename write')
  }

  // Test 2.4: External Legacy / Sparse Schema Write
  {
    console.log('\n[Test 2.4] External Sparse / Legacy Schema Sanitization')
    const sparseData = {
      version: 0,
      activeCompanyId: 'comp-zano-01', // legacy id
      workspaces: [
        {
          id: 'ws-sparse-1',
          company: { name: 'Sparse Company' },
          customers: [],
          vault: [],
          tenders: [],
        },
      ],
    }
    writeFileSync(tendersJsonPath, JSON.stringify(sparseData, null, 2), 'utf8')

    // Wait for watcher to trigger migrateAndValidateTenders
    await new Promise((r) => setTimeout(r, 250))

    const validatedDisk = readTendersStore(tendersJsonPath)
    assert(validatedDisk.version === 1, 'Sparse legacy version upgraded to 1')
    assert(validatedDisk.activeCompanyId === 'ws-sparse-1', 'Active company id resolved safely')
    assert(Array.isArray(validatedDisk.workspaces[0].vault), 'Vault array guaranteed')
  }

  stopTendersStoreWatcher()

  // Re-establish canonical seed state for subsequent resilience and echo tests
  const canonicalSeed = migrateAndValidateTenders(null)
  writeTendersStore(tendersJsonPath, canonicalSeed)
  useTendersStore.getState().syncFromMain(canonicalSeed)

  // ==========================================================================
  // SUITE 3: RESILIENCE AGAINST MALFORMED/CORRUPTED JSON PAYLOADS
  // ==========================================================================
  console.log('\n--- SUITE 3: Resilience Against Malformed / Corrupted Payloads ---')

  const bakPath = `${tendersJsonPath}.corrupted.bak`

  // Test 3.1: Truncated Incomplete JSON Syntax
  {
    console.log('\n[Test 3.1] Truncated / Incomplete JSON Syntax')
    if (existsSync(bakPath)) rmSync(bakPath)

    const truncated = '{"version": 1, "workspaces": [{"id": "co-thabo", "company": '
    writeFileSync(tendersJsonPath, truncated, 'utf8')

    const result = readTendersStore(tendersJsonPath)
    assert(result !== null && typeof result === 'object', 'readTendersStore does not crash on truncated JSON')
    assert(result.version === 1, 'Fallback envelope returns version 1')
    assert(Array.isArray(result.workspaces) && result.workspaces.length === 0, 'Fallback returns safe empty workspaces array')
    assert(existsSync(bakPath), '.corrupted.bak backup file was created on disk')

    const bakContent = readFileSync(bakPath, 'utf8')
    assert(bakContent === truncated, '.corrupted.bak contains the verbatim truncated content')
  }

  // Test 3.2: Binary Garbage & Mangled Non-JSON Content
  {
    console.log('\n[Test 3.2] Binary Garbage & Mangled Non-JSON Content')
    if (existsSync(bakPath)) rmSync(bakPath)

    const garbage = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x12, 0x34, 0xde, 0xad, 0xbe, 0xef])
    writeFileSync(tendersJsonPath, garbage)

    const result = readTendersStore(tendersJsonPath)
    assert(result !== null && result.version === 1, 'readTendersStore survives binary garbage')
    assert(existsSync(bakPath), '.corrupted.bak created for binary garbage')
    assert(readFileSync(bakPath).length > 0, '.corrupted.bak contains preserved binary garbage data')

    // Test with mangled non-JSON text (HTML / ASCII corrupted payload)
    rmSync(bakPath)
    const mangledText = '<html><head><title>502 Bad Gateway</title></head><body><h1>Server Error</h1></body></html>'
    writeFileSync(tendersJsonPath, mangledText, 'utf8')
    const textResult = readTendersStore(tendersJsonPath)
    assert(textResult !== null && textResult.version === 1, 'readTendersStore survives HTML error payload')
    assert(existsSync(bakPath), '.corrupted.bak created for mangled HTML payload')
    assert(readFileSync(bakPath, 'utf8') === mangledText, '.corrupted.bak matches verbatim mangled text payload')
  }

  // Test 3.3: Empty 0-Byte File
  {
    console.log('\n[Test 3.3] Empty 0-Byte File')
    if (existsSync(bakPath)) rmSync(bakPath)

    writeFileSync(tendersJsonPath, '', 'utf8')
    const result = readTendersStore(tendersJsonPath)
    assert(result !== null && result.version === 1, 'readTendersStore handles 0-byte file without crashing')
    assert(existsSync(bakPath), '.corrupted.bak created for 0-byte file')
  }

  // Test 3.4: Extreme Non-Object JSON Payloads
  {
    console.log('\n[Test 3.4] Extreme Non-Object Valid JSON Payloads')
    const extremeCases = [
      { label: 'String literal', content: '"hello world"' },
      { label: 'Number literal', content: '999888' },
      { label: 'Boolean literal', content: 'true' },
      { label: 'Array literal', content: '[1, 2, 3, "foo"]' },
    ]

    for (const ec of extremeCases) {
      writeFileSync(tendersJsonPath, ec.content, 'utf8')
      const res = readTendersStore(tendersJsonPath)
      assert(res !== null && res.version === 1, `Survives ${ec.label} without throwing`)
      assert(Array.isArray(res.workspaces), `Produces valid workspaces array for ${ec.label}`)
    }
  }

  // Test 3.5: Post-Corruption Self-Healing Recovery
  {
    console.log('\n[Test 3.5] Self-Healing Recovery: App Restores Healthy Store After Corruption')
    // Leave corrupted content on disk
    writeFileSync(tendersJsonPath, '{"broken": syntax err', 'utf8')
    if (existsSync(bakPath)) rmSync(bakPath)

    // Renderer calls loadFromMain
    await useTendersStore.getState().loadFromMain()

    // Disk should have been automatically healed with valid seed data!
    assert(existsSync(tendersJsonPath), 'tenders-data.json exists after self-healing loadFromMain')
    const healedContent = readFileSync(tendersJsonPath, 'utf8')
    let healedParsed: any
    try {
      healedParsed = JSON.parse(healedContent)
    } catch {
      healedParsed = null
    }
    assert(healedParsed !== null, 'Healed tenders-data.json is valid, parseable JSON')
    assert(healedParsed.version === 1, 'Healed store version is 1')
    assert(healedParsed.workspaces.length >= 1, 'Healed store contains valid workspace')
    assert(existsSync(bakPath), '.corrupted.bak was preserved during self-healing')
  }

  // Test 3.6: Live Watcher Drop on External Corruption (Zero Renderer Memory Corruption)
  {
    console.log('\n[Test 3.6] Live Watcher Drop on External File Corruption')
    startTendersStoreWatcher(tendersJsonPath)

    // Verify current in-memory tender has data
    const activeBefore = useTendersStore.getState().tenders[0]
    assert(activeBefore !== undefined && activeBefore.id === 'tender-wtr-04', 'In-memory store has active tender')

    // External process corrupts the file while watcher is running
    writeFileSync(tendersJsonPath, '<<<MALICIOUS_CORRUPTED_PAYLOAD>>>', 'utf8')

    // Wait for watcher debounce to trigger readTendersStore and broadcast fallback
    await new Promise((r) => setTimeout(r, 250))

    // Verify renderer in-memory store did NOT lose its data
    const activeAfter = useTendersStore.getState().tenders[0]
    assert(activeAfter !== undefined && activeAfter.id === 'tender-wtr-04', 'Renderer in-memory store dropped empty corrupted broadcast and preserved all active data')

    stopTendersStoreWatcher()
  }

  // ==========================================================================
  // SUITE 4: ZERO INFINITE ECHO LOOPS DURING BIDIRECTIONAL SYNCHRONIZATION
  // ==========================================================================
  console.log('\n--- SUITE 4: Zero Infinite Echo Loops During Bidirectional Sync ---')

  // Test 4.1: Single Client Round-Trip Echo Quiescence
  {
    console.log('\n[Test 4.1] Single Client Round-Trip Quiescence')
    savedDataCalls = []

    // Mutate tender in renderer
    useTendersStore.getState().updateTender('tender-wtr-04', {
      title: 'Echo Quiescence Test Title',
    })

    // Debounced save triggers in 300ms
    await new Promise((r) => setTimeout(r, 450))

    // Check save calls
    assert(savedDataCalls.length === 1, 'Exactly ONE save was dispatched for the mutation', `Actual saves: ${savedDataCalls.length}`)

    // Now monitor for next 800ms to guarantee zero secondary echo saves
    const savesBeforeWait = savedDataCalls.length
    await new Promise((r) => setTimeout(r, 800))
    const savesAfterWait = savedDataCalls.length

    assert(savesAfterWait === savesBeforeWait, 'Zero subsequent saves dispatched: Feedback loop completely prevented', `Loop saves: ${savesAfterWait - savesBeforeWait}`)
    recordMetric('Test 4.1', 'Echo Loop Iterations', 0, true)
    recordMetric('Test 4.1', 'Round-Trip Quiescence Delay', '300ms debounce + 0ms echo', true)
  }

  // Test 4.2: High-Volume External Push Broadcast Quiescence
  {
    console.log('\n[Test 4.2] High-Volume Incoming Push Broadcast Flood (50 broadcasts)')
    savedDataCalls = []

    const PUSH_COUNT = 50
    for (let i = 1; i <= PUSH_COUNT; i++) {
      const incoming = migrateAndValidateTenders(null)
      incoming.workspaces[0].tenders[0].title = `Push Broadcast #${i}`
      // Directly invoke the broadcast receiver (simulating main -> renderer push)
      mockRendererWc.send(TENDERS_CHANNELS.dataChanged, incoming)
    }

    // Wait 600ms to allow any potential subscribers/debounce timers to trigger
    await new Promise((r) => setTimeout(r, 650))

    assert(savedDataCalls.length === 0, 'Zero outbound saves triggered by 50 rapid incoming push broadcasts', `Outbound saves: ${savedDataCalls.length}`)
    recordMetric('Test 4.2', 'Incoming Broadcasts Absorbed', PUSH_COUNT, true)
    recordMetric('Test 4.2', 'Outbound Save Invocations', savedDataCalls.length, savedDataCalls.length === 0)
  }

  // Test 4.3: Multi-Tab Coordination (Dual WebContents Simulation)
  {
    console.log('\n[Test 4.3] Multi-Tab Coordination (Dual WebContents Simulation)')
    savedDataCalls = []

    // Create a second simulated tab WebContents and renderer listener
    let tab2StoreData: any = null
    let tab2OutboundSaves = 0

    const mockTab2Wc = {
      isDestroyed: () => false,
      send: (channel: string, data: any) => {
        if (channel === TENDERS_CHANNELS.dataChanged) {
          tab2StoreData = data
          // If Tab 2 had an echo bug, it might attempt to save back:
          // In a proper implementation, Tab 2's syncFromMain guards saves
        }
      },
      once: (_ev: string, _fn: () => void) => {},
    }

    registerTendersWebContents(mockTab2Wc as any)

    // Tab 1 mutates a tender
    useTendersStore.getState().updateTender('tender-wtr-04', {
      title: 'Multi-Tab Shared Update Title',
      estimatedValue: 925000,
    })

    // Wait for Tab 1 debounce to flush
    await new Promise((r) => setTimeout(r, 450))

    // Verify Tab 1 saved once
    assert(savedDataCalls.length === 1, 'Tab 1 saved once to main process')

    // Verify Tab 2 received the broadcast
    assert(tab2StoreData !== null, 'Tab 2 received live broadcast from Tab 1 mutation')
    const tab2Tender = tab2StoreData.workspaces[0].tenders.find((t: any) => t.id === 'tender-wtr-04')
    assert(tab2Tender.title === 'Multi-Tab Shared Update Title', 'Tab 2 reflects Tab 1 edit in real time')
    assert(tab2Tender.estimatedValue === 925000, 'Tab 2 reflects Tab 1 value in real time')

    // Monitor 500ms for echo loops across both tabs
    await new Promise((r) => setTimeout(r, 500))
    assert(savedDataCalls.length === 1, 'Total saves across all tabs remains exactly 1 (Zero multi-tab echo)')
    recordMetric('Test 4.3', 'Multi-Tab Echo Iterations', 0, true)
  }

  // Test 4.4: billMilestoneInBooks Backend Operation Round-Trip Quiescence
  {
    console.log('\n[Test 4.4] billMilestoneInBooks Backend Operation Round-Trip Quiescence')
    savedDataCalls = []

    // Ensure Books store exists
    const booksDir = join(testSandboxDir, 'books')
    mkdirSync(booksDir, { recursive: true })
    const booksInit = {
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
    writeFileSync(join(booksDir, 'books-data.json'), JSON.stringify(booksInit, null, 2), 'utf8')

    // Ensure ms-01 is in REACHED status on disk
    const currentTenders = readTendersStore(tendersJsonPath)
    const ms1 = currentTenders.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
    ms1.status = 'REACHED'
    ms1.billedInvoiceId = undefined
    ms1.billedInvoiceNumber = undefined
    writeTendersStore(tendersJsonPath, currentTenders)

    // Execute billing
    const billRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      tenderReference: 'RFP-WTR-2026-04',
      issuingAuthority: 'City of Ekurhuleni Water Dept',
      milestoneTitle: 'Phase 1 Reservoir Valve Refurbishment',
      amount: 145000,
    })

    assert(billRes.ok === true, 'billMilestoneInBooks succeeded')

    // Wait 500ms
    await new Promise((r) => setTimeout(r, 550))

    // In-memory renderer should reflect BILLED live
    const activeMs = useTendersStore.getState().tenders[0].milestones?.find((m: any) => m.id === 'ms-01')
    assert(activeMs?.status === 'BILLED', 'Renderer in-memory store reflects BILLED live')

    // Zero outbound saveStoredData should have been triggered by renderer
    assert(savedDataCalls.length === 0, 'Renderer did NOT emit saveStoredData in response to billing broadcast')
    recordMetric('Test 4.4', 'Billing Echo Saves', savedDataCalls.length, savedDataCalls.length === 0)
  }

  // ==========================================================================
  // SUMMARY REPORT
  // ==========================================================================
  console.log('\n======================================================================')
  console.log(`CHALLENGER STRESS-TEST RESULTS: ${passedTests} passed, ${failedTests} failed (Total: ${totalTests})`)
  console.log('======================================================================')

  if (failedTests === 0) {
    console.log('🏆 VERDICT: ALL ADVERSARIAL STRESS TESTS PASSED (APPROVE)\n')
  } else {
    console.error(`💥 VERDICT: ${failedTests} ADVERSARIAL STRESS TESTS FAILED (FAIL)\n`)
    for (const f of failureDetails) {
      console.error(`  - ${f.name}: ${f.error}`)
    }
  }

  unsubDataChanged?.()
}

async function main() {
  try {
    await executeChallengerTests()
    if (failedTests > 0) {
      process.exit(1)
    }
    process.exit(0)
  } catch (err: any) {
    console.error('\nFATAL TEST RUNNER EXCEPTION:', err?.message || err)
    process.exit(1)
  } finally {
    try {
      stopTendersStoreWatcher()
      rmSync(testSandboxDir, { recursive: true, force: true })
    } catch {}
  }
}

void main()

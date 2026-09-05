/**
 * tools/verify-books-m4-challenger.ts
 *
 * EMPIRICAL CHALLENGER TEST SUITE FOR BOOKS MILESTONE 4 (M4)
 * Features: F14, F15, F16
 *
 * Verification Objectives:
 * 1. IPC Channels & Preload Contract (F14):
 *    - BOOKS_CHANNELS contains dataChanged and DATA_CHANGED mapped to 'books:data-changed'
 *    - Preload contract exposes onDataChanged returning an unsubscribe cleanup function
 * 2. Main Process WebContents Tracking & Pruning (F14):
 *    - WebContents tracked in Set, auto-pruned on 'destroyed'
 *    - Dead / destroyed WebContents safely filtered out
 * 3. Layer 1 Sender Exclusion (F14):
 *    - broadcastBooksData skips excludeSender (sender receives 0 echoes)
 *    - Non-sender peers all receive the broadcast
 * 4. Layer 2 Hash Comparison Loop Suppression (F15):
 *    - computeDataHash produces deterministic payloads
 *    - syncFromMain skips identical incoming data
 *    - syncFromMain updates in-memory state without calling persist()
 *    - syncFromMain recomputes party balances correctly
 * 5. Cross-App File Watcher & Debouncing (F14, F16):
 *    - External disk writes to books-data.json trigger reload & broadcast
 *    - Internal writes update lastBroadcastJson preventing redundant watcher broadcasts
 *    - Rapid sequential writes are debounced
 * 6. End-to-End Cross-App Simulation (F16):
 *    - Tenders milestone billing disk write propagates to active Books renderer store
 *    - CRM won deal invoice disk write propagates to active Books renderer store
 */

import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { BOOKS_CHANNELS } from '../apps/books/src/shared/ipc'
import {
  registerBooksWebContents,
  unregisterBooksWebContents,
  getActiveBooksWebContents,
  clearActiveBooksWebContents,
  broadcastBooksData,
  persistBooksData,
  writeBooksStore,
  readBooksStore,
  startBooksStoreWatcher,
  stopBooksStoreWatcher,
  getLastBroadcastJson,
  setLastBroadcastJson,
  resetBooksIpcForTesting,
} from '../apps/books/src/main/books-main'
import {
  useBooksStore,
  computeDataHash,
  getLastSavedHash,
  setLastSavedHash,
} from '../apps/books/src/renderer/src/store'
import { initialBooksData } from '../apps/books/src/renderer/src/mock/initialData'
import type { BooksData, Invoice, Party, JournalEntry } from '../apps/books/src/shared/types'

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures: Array<{ suite: string; name: string; error: string }> = []

async function testAsync(suite: string, name: string, fn: () => Promise<void>) {
  totalTests++
  try {
    await fn()
    passedTests++
    console.log(`  [PASS] ${name}`)
  } catch (err: any) {
    failedTests++
    failures.push({ suite, name, error: err.message || String(err) })
    console.error(`  [FAIL] ${name}: ${err.message}`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

// Reset state between suites
function resetTestState() {
  resetBooksIpcForTesting()
  useBooksStore.setState({
    activeTab: 'dashboard',
    data: JSON.parse(JSON.stringify(initialBooksData)),
    activeInvoiceId: null,
    invoiceStatusFilter: 'All',
    activeReport: 'profit-loss',
    printInvoice: null,
    searchTerm: '',
  })
  setLastSavedHash(computeDataHash(initialBooksData))
}

// Mock WebContents Factory
function createMockWebContents(id?: string) {
  let destroyed = false
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  const sentMessages: Array<{ channel: string; data: any }> = []

  const wc: any = {
    id: id || `wc-${randomUUID().slice(0, 8)}`,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
      const handlers = listeners.get('destroyed') || []
      for (const h of handlers) h()
    },
    send: (channel: string, data: any) => {
      if (destroyed) throw new Error('Cannot send to destroyed WebContents')
      sentMessages.push({ channel, data })
    },
    once: (event: string, handler: (...args: any[]) => void) => {
      const arr = listeners.get(event) || []
      arr.push(handler)
      listeners.set(event, arr)
    },
    on: (event: string, handler: (...args: any[]) => void) => {
      const arr = listeners.get(event) || []
      arr.push(handler)
      listeners.set(event, arr)
    },
    removeListener: (event: string, handler: (...args: any[]) => void) => {
      const arr = listeners.get(event) || []
      listeners.set(
        event,
        arr.filter((h) => h !== handler)
      )
    },
    _sentMessages: sentMessages,
  }

  return wc
}

async function run() {
  console.log('======================================================================')
  console.log('   EMPIRICAL CHALLENGER: BOOKS MILESTONE 4 (M4) AUDIT HARNESS        ')
  console.log('======================================================================\n')

  // ──────────────────────────────────────────────────────────────────
  // SUITE 1: IPC CHANNELS & PRELOAD CONTRACT
  // ──────────────────────────────────────────────────────────────────
  console.log('--- SUITE 1: IPC Channels & Preload Contract ---')

  await testAsync('Suite 1', '1.1 BOOKS_CHANNELS defines dataChanged and DATA_CHANGED as books:data-changed', async () => {
    assert.strictEqual(BOOKS_CHANNELS.dataChanged, 'books:data-changed')
    assert.strictEqual(BOOKS_CHANNELS.DATA_CHANGED, 'books:data-changed')
    assert.strictEqual(BOOKS_CHANNELS.loadData, 'books:load-data')
    assert.strictEqual(BOOKS_CHANNELS.saveData, 'books:save-data')
  })

  await testAsync('Suite 1', '1.2 Preload onDataChanged registers listener and returns unsubscribe cleanup', async () => {
    const mockIpcRenderer = {
      events: new Map<string, Function[]>(),
      on(channel: string, listener: Function) {
        const arr = this.events.get(channel) || []
        arr.push(listener)
        this.events.set(channel, arr)
      },
      removeListener(channel: string, listener: Function) {
        const arr = this.events.get(channel) || []
        this.events.set(
          channel,
          arr.filter((l) => l !== listener)
        )
      },
      emit(channel: string, ...args: any[]) {
        const arr = this.events.get(channel) || []
        for (const l of arr) l({}, ...args)
      },
    }

    // Preload implementation simulation
    function setupPreload(ipc: typeof mockIpcRenderer) {
      return {
        onDataChanged: (callback: (data: BooksData) => void) => {
          const listener = (_: any, data: BooksData) => callback(data)
          ipc.on(BOOKS_CHANNELS.dataChanged, listener)
          return () => {
            ipc.removeListener(BOOKS_CHANNELS.dataChanged, listener)
          }
        },
      }
    }

    const api = setupPreload(mockIpcRenderer)
    const received: BooksData[] = []
    const unsubscribe = api.onDataChanged((data) => {
      received.push(data)
    })

    assert.strictEqual(mockIpcRenderer.events.get(BOOKS_CHANNELS.dataChanged)?.length, 1)

    // Emit event
    const sampleData = JSON.parse(JSON.stringify(initialBooksData))
    sampleData.updatedAt = '2026-09-05T12:00:00.000Z'
    mockIpcRenderer.emit(BOOKS_CHANNELS.dataChanged, sampleData)

    assert.strictEqual(received.length, 1)
    assert.strictEqual(received[0].updatedAt, '2026-09-05T12:00:00.000Z')

    // Unsubscribe
    unsubscribe()
    assert.strictEqual(mockIpcRenderer.events.get(BOOKS_CHANNELS.dataChanged)?.length, 0)

    // Emit again - should not be received
    mockIpcRenderer.emit(BOOKS_CHANNELS.dataChanged, sampleData)
    assert.strictEqual(received.length, 1)
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 2: WEBCONTENTS TRACKING & PRUNING
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 2: WebContents Tracking & Pruning ---')

  await testAsync('Suite 2', '2.1 registerBooksWebContents adds active WebContents', async () => {
    resetTestState()
    const wc1 = createMockWebContents('wc1')
    const wc2 = createMockWebContents('wc2')

    registerBooksWebContents(wc1)
    registerBooksWebContents(wc2)

    const active = getActiveBooksWebContents()
    assert.strictEqual(active.length, 2)
    assert(active.includes(wc1))
    assert(active.includes(wc2))
  })

  await testAsync('Suite 2', '2.2 registerBooksWebContents rejects null or already destroyed WebContents', async () => {
    resetTestState()
    const deadWc = createMockWebContents('deadWc')
    deadWc.destroy()

    registerBooksWebContents(null as any)
    registerBooksWebContents(undefined as any)
    registerBooksWebContents(deadWc)

    assert.strictEqual(getActiveBooksWebContents().length, 0)
  })

  await testAsync('Suite 2', '2.3 WebContents destroyed event automatically unregisters from active set', async () => {
    resetTestState()
    const wc1 = createMockWebContents('wc1')
    const wc2 = createMockWebContents('wc2')

    registerBooksWebContents(wc1)
    registerBooksWebContents(wc2)
    assert.strictEqual(getActiveBooksWebContents().length, 2)

    // Destroy wc1
    wc1.destroy()
    const remaining = getActiveBooksWebContents()
    assert.strictEqual(remaining.length, 1)
    assert.strictEqual(remaining[0].id, 'wc2')
  })

  await testAsync('Suite 2', '2.4 unregisterBooksWebContents explicitly removes WebContents', async () => {
    resetTestState()
    const wc = createMockWebContents('wc')
    registerBooksWebContents(wc)
    assert.strictEqual(getActiveBooksWebContents().length, 1)

    unregisterBooksWebContents(wc)
    assert.strictEqual(getActiveBooksWebContents().length, 0)
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 3: LAYER 1 SENDER EXCLUSION (MAIN PROCESS)
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 3: Layer 1 Sender Exclusion (Main Process) ---')

  await testAsync('Suite 3', '3.1 broadcastBooksData sends to all WebContents when no excludeSender is given', async () => {
    resetTestState()
    const wc1 = createMockWebContents('tab-1')
    const wc2 = createMockWebContents('tab-2')
    registerBooksWebContents(wc1)
    registerBooksWebContents(wc2)

    const payload: BooksData = JSON.parse(JSON.stringify(initialBooksData))
    payload.updatedAt = '2026-09-05T14:00:00Z'

    broadcastBooksData(payload)

    assert.strictEqual(wc1._sentMessages.length, 1)
    assert.strictEqual(wc1._sentMessages[0].channel, BOOKS_CHANNELS.dataChanged)
    assert.strictEqual(wc1._sentMessages[0].data.updatedAt, '2026-09-05T14:00:00Z')

    assert.strictEqual(wc2._sentMessages.length, 1)
    assert.strictEqual(wc2._sentMessages[0].channel, BOOKS_CHANNELS.dataChanged)
    assert.strictEqual(wc2._sentMessages[0].data.updatedAt, '2026-09-05T14:00:00Z')
  })

  await testAsync('Suite 3', '3.2 Layer 1 suppression: excludeSender does NOT receive echo broadcast', async () => {
    resetTestState()
    const senderWc = createMockWebContents('editor-tab')
    const peerWc1 = createMockWebContents('overview-tab')
    const peerWc2 = createMockWebContents('reports-tab')

    registerBooksWebContents(senderWc)
    registerBooksWebContents(peerWc1)
    registerBooksWebContents(peerWc2)

    const payload: BooksData = JSON.parse(JSON.stringify(initialBooksData))
    payload.updatedAt = '2026-09-05T14:05:00Z'

    // Broadcast with senderWc excluded
    broadcastBooksData(payload, senderWc)

    // SENDER MUST RECEIVE 0 MESSAGES (Layer 1 loop suppression)
    assert.strictEqual(
      senderWc._sentMessages.length,
      0,
      'Sender WebContents must NOT receive echo broadcast!'
    )

    // Peers must each receive 1 broadcast
    assert.strictEqual(peerWc1._sentMessages.length, 1)
    assert.strictEqual(peerWc1._sentMessages[0].data.updatedAt, '2026-09-05T14:05:00Z')
    assert.strictEqual(peerWc2._sentMessages.length, 1)
    assert.strictEqual(peerWc2._sentMessages[0].data.updatedAt, '2026-09-05T14:05:00Z')
  })

  await testAsync('Suite 3', '3.3 persistBooksData passes excludeSender to broadcast', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-test-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      const senderWc = createMockWebContents('active-books-renderer')
      const otherWc = createMockWebContents('background-books-tab')
      registerBooksWebContents(senderWc)
      registerBooksWebContents(otherWc)

      const payload: BooksData = JSON.parse(JSON.stringify(initialBooksData))
      payload.updatedAt = '2026-09-05T14:10:00Z'

      persistBooksData(booksPath, payload, senderWc)

      // Disk check
      assert(existsSync(booksPath))
      const stored = readBooksStore(booksPath)
      assert.strictEqual(stored.updatedAt, '2026-09-05T14:10:00Z')

      // SENDER received 0 echoes
      assert.strictEqual(senderWc._sentMessages.length, 0)
      // Other tab received 1 broadcast
      assert.strictEqual(otherWc._sentMessages.length, 1)
      assert.strictEqual(otherWc._sentMessages[0].channel, 'books:data-changed')
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 4: LAYER 2 HASH COMPARISON LOOP SUPPRESSION (RENDERER STORE)
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 4: Layer 2 Hash Comparison Loop Suppression (Renderer) ---')

  await testAsync('Suite 4', '4.1 computeDataHash produces consistent deterministic hash', async () => {
    const data1: BooksData = JSON.parse(JSON.stringify(initialBooksData))
    const data2: BooksData = JSON.parse(JSON.stringify(initialBooksData))

    const hash1 = computeDataHash(data1)
    const hash2 = computeDataHash(data2)
    assert.strictEqual(hash1, hash2)
    assert(hash1.length > 50)

    // Mutation alters hash
    data2.invoices.push({
      id: 'inv-test-m4',
      invoiceNumber: 'INV-2026-999',
      type: 'Sales',
      partyId: 'party-cust-1',
      partyName: 'Test Customer',
      date: '2026-09-05',
      dueDate: '2026-10-05',
      items: [],
      subtotal: 1000,
      taxTotal: 150,
      grandTotal: 1150,
      outstandingAmount: 1150,
      status: 'Unpaid',
      createdAt: '2026-09-05T12:00:00Z',
      updatedAt: '2026-09-05T12:00:00Z',
    })

    const hash3 = computeDataHash(data2)
    assert.notStrictEqual(hash1, hash3)
  })

  await testAsync('Suite 4', '4.2 Layer 2 suppression: syncFromMain ignores incoming data identical to lastSavedHash', async () => {
    resetTestState()
    const initialData = useBooksStore.getState().data
    const currentHash = computeDataHash(initialData)
    setLastSavedHash(currentHash)

    let stateUpdated = false
    const unsub = useBooksStore.subscribe(() => {
      stateUpdated = true
    })

    // Invoke syncFromMain with exact same payload
    useBooksStore.getState().syncFromMain(JSON.parse(JSON.stringify(initialData)))

    // Zustand store should NOT have updated or re-rendered
    assert.strictEqual(stateUpdated, false, 'Store should not trigger update for identical payload')
    unsub()
  })

  await testAsync('Suite 4', '4.3 syncFromMain does NOT call persist or IPC saveData', async () => {
    resetTestState()
    let ipcSaveCalled = false
    ;(global as any).window = {
      booksApi: {
        saveData: async () => {
          ipcSaveCalled = true
          return true
        },
      },
    }

    const newData: BooksData = JSON.parse(JSON.stringify(initialBooksData))
    newData.invoices.push({
      id: 'inv-external-1',
      invoiceNumber: 'INV-EXT-001',
      type: 'Sales',
      partyId: 'party-cust-1',
      partyName: 'External Client',
      date: '2026-09-05',
      dueDate: '2026-10-05',
      items: [],
      subtotal: 5000,
      taxTotal: 750,
      grandTotal: 5750,
      outstandingAmount: 5750,
      status: 'Unpaid',
      createdAt: '2026-09-05T12:00:00Z',
      updatedAt: '2026-09-05T12:00:00Z',
    })

    useBooksStore.getState().syncFromMain(newData)

    // Store state in memory is updated
    const invoices = useBooksStore.getState().data.invoices
    assert(invoices.some((i) => i.id === 'inv-external-1'))

    // But persist / saveData was NOT triggered
    assert.strictEqual(ipcSaveCalled, false, 'syncFromMain must NEVER re-persist back to main!')
    delete (global as any).window
  })

  await testAsync('Suite 4', '4.4 syncFromMain correctly recomputes party balances', async () => {
    resetTestState()
    const sampleParty: Party = {
      id: 'party-sync-cust',
      name: 'Sync Customer Ltd',
      type: 'Customer',
      outstandingBalance: 0,
    }
    const sampleInvoice: Invoice = {
      id: 'inv-sync-1',
      invoiceNumber: 'INV-2026-555',
      type: 'Sales',
      partyId: 'party-sync-cust',
      partyName: 'Sync Customer Ltd',
      date: '2026-09-05',
      dueDate: '2026-10-05',
      items: [],
      subtotal: 10000,
      taxTotal: 1500,
      grandTotal: 11500,
      outstandingAmount: 11500,
      status: 'Unpaid',
      createdAt: '2026-09-05T12:00:00Z',
      updatedAt: '2026-09-05T12:00:00Z',
    }

    const payload: BooksData = {
      ...initialBooksData,
      parties: [...initialBooksData.parties, sampleParty],
      invoices: [...initialBooksData.invoices, sampleInvoice],
    }

    useBooksStore.getState().syncFromMain(payload)

    const updatedParty = useBooksStore.getState().data.parties.find((p) => p.id === 'party-sync-cust')
    assert(updatedParty, 'Party must exist')
    assert.strictEqual(updatedParty.outstandingBalance, 11500, 'Party balance must reflect open invoice')
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 5: CROSS-APP FILE WATCHER & DEBOUNCING
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 5: Cross-App File Watcher & Debouncing ---')

  await testAsync('Suite 5', '5.1 File watcher detects external disk write and broadcasts to all active renderers', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-watch-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      // Seed initial file
      writeBooksStore(booksPath, initialBooksData)

      const mockWc1 = createMockWebContents('open-tab-1')
      const mockWc2 = createMockWebContents('open-tab-2')
      registerBooksWebContents(mockWc1)
      registerBooksWebContents(mockWc2)

      // Start file watcher on this test file
      startBooksStoreWatcher(booksPath)

      // Allow watcher to register
      await delay(50)

      // Simulate external write (e.g. from Tenders milestone billing process)
      const externalData: BooksData = readBooksStore(booksPath)
      const milestoneInvoice: Invoice = {
        id: 'inv-tender-milestone-01',
        invoiceNumber: 'INV-TDR-001',
        type: 'Sales',
        partyId: 'party-gov',
        partyName: 'Department of Water Affairs',
        date: '2026-09-05',
        dueDate: '2026-10-05',
        items: [],
        subtotal: 120000,
        taxTotal: 18000,
        grandTotal: 138000,
        outstandingAmount: 138000,
        status: 'Unpaid',
        tenderReference: 'RFP-WTR-2026-04',
        createdAt: '2026-09-05T13:00:00Z',
        updatedAt: '2026-09-05T13:00:00Z',
      }
      externalData.invoices.push(milestoneInvoice)
      externalData.updatedAt = '2026-09-05T13:00:00Z'

      // Write directly to disk (bypassing books persistBooksData)
      writeFileSync(booksPath, JSON.stringify(externalData, null, 2), 'utf8')

      // Wait for 100ms debounce + flush
      await delay(250)

      // Both WebContents must have received the broadcast!
      assert(mockWc1._sentMessages.length >= 1, 'mockWc1 must receive data-changed broadcast')
      assert(mockWc2._sentMessages.length >= 1, 'mockWc2 must receive data-changed broadcast')

      const receivedData: BooksData = mockWc1._sentMessages[mockWc1._sentMessages.length - 1].data
      assert(
        receivedData.invoices.some((i) => i.id === 'inv-tender-milestone-01'),
        'Broadcast must contain external milestone invoice'
      )
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  await testAsync('Suite 5', '5.2 Internal writeBooksStore updates lastBroadcastJson preventing redundant watcher broadcast', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-internal-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      const mockWc = createMockWebContents('books-ui')
      registerBooksWebContents(mockWc)
      startBooksStoreWatcher(booksPath)
      await delay(50)

      mockWc._sentMessages.length = 0

      // An internal persist writes to disk and updates lastBroadcastJson
      const modified: BooksData = readBooksStore(booksPath)
      modified.updatedAt = '2026-09-05T14:30:00Z'
      writeBooksStore(booksPath, modified)

      // Wait for debounce time
      await delay(250)

      // Since lastBroadcastJson was set during writeBooksStore, watcher sees identical JSON and does not broadcast!
      assert.strictEqual(
        mockWc._sentMessages.length,
        0,
        'Watcher should NOT broadcast for internal write that updated lastBroadcastJson'
      )
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  await testAsync('Suite 5', '5.3 Rapid external writes are debounced into coalesced broadcast', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-debounce-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)
      const mockWc = createMockWebContents('active-tab')
      registerBooksWebContents(mockWc)
      startBooksStoreWatcher(booksPath)
      await delay(50)

      mockWc._sentMessages.length = 0

      // Fire 5 rapid external writes within 40ms
      for (let i = 0; i < 5; i++) {
        const d: BooksData = readBooksStore(booksPath)
        d.updatedAt = `2026-09-05T15:00:0${i}Z`
        writeFileSync(booksPath, JSON.stringify(d, null, 2), 'utf8')
        await delay(10)
      }

      // Wait for debounce timeout
      await delay(250)

      // Debounce coalesces the burst into at most 1 or 2 broadcasts (never 5)
      assert(
        mockWc._sentMessages.length <= 2,
        `Expected at most 2 broadcasts from debouncer, got ${mockWc._sentMessages.length}`
      )
      // The last broadcast contains the latest state
      const lastMsg = mockWc._sentMessages[mockWc._sentMessages.length - 1]
      assert.strictEqual(lastMsg.data.updatedAt, '2026-09-05T15:00:04Z')
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 6: END-TO-END CROSS-APP SIMULATION
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 6: End-to-End Cross-App Simulation ---')

  await testAsync('Suite 6', '6.1 Tenders milestone billing disk write triggers reload-free live update in Books store', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-e2e-tenders-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      // Wire up realistic mock IPC between main process and renderer store
      const rendererWc = createMockWebContents('books-renderer-tab')
      registerBooksWebContents(rendererWc)

      // Renderer listens to books:data-changed
      rendererWc.send = (channel: string, data: BooksData) => {
        if (channel === BOOKS_CHANNELS.dataChanged) {
          useBooksStore.getState().syncFromMain(data)
        }
      }

      startBooksStoreWatcher(booksPath)
      await delay(50)

      // Tenders app executes milestone billing on disk:
      const tendersInvoice: Invoice = {
        id: 'inv-tdr-wtr-m1',
        invoiceNumber: 'INV-2026-088',
        type: 'Sales',
        partyId: 'party-dwa',
        partyName: 'Department of Water and Sanitation',
        date: '2026-09-05',
        dueDate: '2026-10-05',
        items: [
          {
            id: 'it-1',
            itemCode: 'MILESTONE',
            description: 'Phase 1: Civil Engineering Site Assessment (RFP-WTR-2026-04)',
            accountId: 'acc-sales',
            accountName: 'Tender & Commercial Contracting Sales',
            qty: 1,
            rate: 250000,
            taxRate: 15,
            amount: 250000,
          },
        ],
        subtotal: 250000,
        taxTotal: 37500,
        grandTotal: 287500,
        outstandingAmount: 287500,
        status: 'Unpaid',
        tenderReference: 'RFP-WTR-2026-04',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const freshDisk = readBooksStore(booksPath)
      freshDisk.invoices.push(tendersInvoice)
      freshDisk.parties.push({
        id: 'party-dwa',
        name: 'Department of Water and Sanitation',
        type: 'Customer',
        outstandingBalance: 287500,
      })
      writeFileSync(booksPath, JSON.stringify(freshDisk, null, 2), 'utf8')

      // Wait for debounce and push
      await delay(250)

      // Verify Zustand store updated automatically WITHOUT manual reload!
      const storeState = useBooksStore.getState().data
      const foundInvoice = storeState.invoices.find((i) => i.id === 'inv-tdr-wtr-m1')
      assert(foundInvoice, 'Tenders milestone invoice must be present in Books store state')
      assert.strictEqual(foundInvoice.grandTotal, 287500)
      assert.strictEqual(foundInvoice.tenderReference, 'RFP-WTR-2026-04')

      const party = storeState.parties.find((p) => p.id === 'party-dwa')
      assert(party, 'Department of Water party must exist')
      assert.strictEqual(party.outstandingBalance, 287500)
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  await testAsync('Suite 6', '6.2 CRM won deal invoicing disk write triggers reload-free live update in Books store', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-e2e-crm-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      const rendererWc = createMockWebContents('books-renderer-tab')
      registerBooksWebContents(rendererWc)

      rendererWc.send = (channel: string, data: BooksData) => {
        if (channel === BOOKS_CHANNELS.dataChanged) {
          useBooksStore.getState().syncFromMain(data)
        }
      }

      startBooksStoreWatcher(booksPath)
      await delay(50)

      // CRM app writes won deal sales invoice to disk:
      const crmInvoice: Invoice = {
        id: 'inv-crm-enterprise-01',
        invoiceNumber: 'INV-CRM-001',
        type: 'Sales',
        partyId: 'party-vodacom',
        partyName: 'Vodacom Group (Pty) Ltd',
        date: '2026-09-05',
        dueDate: '2026-10-05',
        items: [
          {
            id: 'it-crm-1',
            itemCode: 'CRM-WON',
            description: 'Corporate Cloud ERP Expansion License',
            accountId: 'acc-sales',
            accountName: 'Tender & Commercial Contracting Sales',
            qty: 1,
            rate: 500000,
            taxRate: 15,
            amount: 500000,
          },
        ],
        subtotal: 500000,
        taxTotal: 75000,
        grandTotal: 575000,
        outstandingAmount: 575000,
        status: 'Unpaid',
        crmDealId: 'deal-crm-voda-2026',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const freshDisk = readBooksStore(booksPath)
      freshDisk.invoices.push(crmInvoice)
      freshDisk.parties.push({
        id: 'party-vodacom',
        name: 'Vodacom Group (Pty) Ltd',
        type: 'Customer',
        outstandingBalance: 575000,
      })
      writeFileSync(booksPath, JSON.stringify(freshDisk, null, 2), 'utf8')

      await delay(250)

      // Verify Zustand store updated
      const storeState = useBooksStore.getState().data
      const foundCrmInv = storeState.invoices.find((i) => i.id === 'inv-crm-enterprise-01')
      assert(foundCrmInv, 'CRM won deal invoice must be present in Books store state')
      assert.strictEqual(foundCrmInv.crmDealId, 'deal-crm-voda-2026')
      assert.strictEqual(foundCrmInv.grandTotal, 575000)
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  await testAsync('Suite 6', '6.3 Dual-layer loop suppression stress test under rapid bidirectional mutations', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-stress-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      let broadcastCount = 0
      let storeSyncCount = 0

      const rendererWc = createMockWebContents('stress-tab')
      registerBooksWebContents(rendererWc)

      rendererWc.send = (channel: string, data: BooksData) => {
        if (channel === BOOKS_CHANNELS.dataChanged) {
          broadcastCount++
          useBooksStore.getState().syncFromMain(data)
          storeSyncCount++
        }
      }

      startBooksStoreWatcher(booksPath)
      await delay(50)

      // Perform 10 interleaved operations: renderer save and external disk write
      for (let i = 0; i < 5; i++) {
        // 1. External write (simulating external app)
        const ext = readBooksStore(booksPath)
        ext.updatedAt = `2026-09-05T16:00:0${i}Z`
        writeFileSync(booksPath, JSON.stringify(ext, null, 2), 'utf8')
        await delay(120)

        // 2. Internal save from renderer (should exclude renderer from echo)
        const currentData = useBooksStore.getState().data
        persistBooksData(booksPath, currentData, rendererWc)
        await delay(60)
      }

      // Allow all debounces to finish
      await delay(300)

      // Verify no infinite loop occurred: broadcastCount is bounded and finite
      assert(
        broadcastCount <= 10,
        `Expected at most 10 broadcasts, but got ${broadcastCount} (potential loop!)`
      )
      assert.strictEqual(broadcastCount, storeSyncCount)
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // RESULTS SUMMARY
  // ──────────────────────────────────────────────────────────────────
  console.log('\n======================================================================')
  console.log(`SUMMARY: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  console.log('======================================================================\n')

  if (failedTests > 0) {
    console.error('FAILURES:')
    for (const f of failures) {
      console.error(`  - [${f.suite}] ${f.name}: ${f.error}`)
    }
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('Unhandled test suite error:', err)
  process.exit(1)
})

/**
 * tools/test-challenger-books-m4-stress.ts
 *
 * EMPIRICAL ADVERSARIAL STRESS TEST SUITE FOR BOOKS MILESTONE 4 (M4)
 *
 * Focus Areas:
 * 1. Layer 1 Loop Suppression (Sender, Peer1, Peer2; excludeSender by reference and ID)
 * 2. WebContents Lifecycle, Destruction & Error Resilience (destroyed event, isDestroyed() === true, throwing send())
 * 3. Layer 2 Loop Suppression & In-Memory Store Sync (identical hash vs updated data, persist isolation, party balance recomputation)
 * 4. High-Throughput Concurrent/Rapid Broadcasts (50+ bursts, mid-stream WebContents destruction, watcher debounce resilience)
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
import type { BooksData, Invoice, Party } from '../apps/books/src/shared/types'

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures: Array<{ suite: string; name: string; error: string }> = []

async function test(suite: string, name: string, fn: () => Promise<void> | void) {
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

interface MockWebContentsOptions {
  id?: string
  throwOnSend?: boolean
}

function createMockWebContents(id?: string, options: { throwOnSend?: boolean } = {}) {
  let destroyed = false
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  const sentMessages: Array<{ channel: string; data: any; timestamp: number }> = []

  const wc: any = {
    id: id || `wc-${randomUUID().slice(0, 8)}`,
    isDestroyed: () => destroyed,
    setDestroyedSilent: (val: boolean) => {
      destroyed = val
    },
    destroy: () => {
      destroyed = true
      const handlers = listeners.get('destroyed') || []
      for (const h of handlers) h()
    },
    send: (channel: string, data: any) => {
      if (destroyed) {
        throw new Error(`Cannot send to destroyed WebContents ${wc.id}`)
      }
      if (options.throwOnSend) {
        throw new Error(`Simulated IPC transfer error on WebContents ${wc.id}`)
      }
      sentMessages.push({ channel, data, timestamp: Date.now() })
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

async function runAllStressTests() {
  console.log('======================================================================')
  console.log('   CHALLENGER 1: BOOKS M4 ADVERSARIAL STRESS TEST HARNESS             ')
  console.log('======================================================================\n')

  // ──────────────────────────────────────────────────────────────────
  // SUITE 1: LAYER 1 LOOP SUPPRESSION EMPIRICAL VERIFICATION
  // ──────────────────────────────────────────────────────────────────
  console.log('--- SUITE 1: Layer 1 Loop Suppression Multi-Client Verification ---')

  await test('Suite 1', '1.1 broadcastBooksData: Sender excluded by reference; Peer1 and Peer2 receive payload', async () => {
    resetTestState()
    const sender = createMockWebContents('Sender-Wc')
    const peer1 = createMockWebContents('Peer1-Wc')
    const peer2 = createMockWebContents('Peer2-Wc')

    registerBooksWebContents(sender)
    registerBooksWebContents(peer1)
    registerBooksWebContents(peer2)

    const payload: BooksData = JSON.parse(JSON.stringify(initialBooksData))
    payload.updatedAt = '2026-09-05T15:01:00Z'

    broadcastBooksData(payload, sender)

    // Sender must receive exactly 0 broadcasts
    assert.strictEqual(sender._sentMessages.length, 0, 'Sender MUST receive 0 broadcasts')

    // Peer1 and Peer2 must each receive exactly 1 broadcast
    assert.strictEqual(peer1._sentMessages.length, 1, 'Peer1 must receive broadcast')
    assert.strictEqual(peer1._sentMessages[0].channel, BOOKS_CHANNELS.dataChanged)
    assert.strictEqual(peer1._sentMessages[0].data.updatedAt, '2026-09-05T15:01:00Z')

    assert.strictEqual(peer2._sentMessages.length, 1, 'Peer2 must receive broadcast')
    assert.strictEqual(peer2._sentMessages[0].channel, BOOKS_CHANNELS.dataChanged)
    assert.strictEqual(peer2._sentMessages[0].data.updatedAt, '2026-09-05T15:01:00Z')
  })

  await test('Suite 1', '1.2 broadcastBooksData: Sender excluded by ID proxy equality', async () => {
    resetTestState()
    const sender = createMockWebContents('same-wc-id-999')
    const peer1 = createMockWebContents('peer-wc-1')
    const peer2 = createMockWebContents('peer-wc-2')

    registerBooksWebContents(sender)
    registerBooksWebContents(peer1)
    registerBooksWebContents(peer2)

    // A proxy or wrapped object with matching ID
    const senderProxy = { id: 'same-wc-id-999' } as any

    const payload: BooksData = JSON.parse(JSON.stringify(initialBooksData))
    payload.updatedAt = '2026-09-05T15:02:00Z'

    broadcastBooksData(payload, senderProxy)

    assert.strictEqual(sender._sentMessages.length, 0, 'Sender with matching ID must be excluded')
    assert.strictEqual(peer1._sentMessages.length, 1, 'Peer1 must receive broadcast')
    assert.strictEqual(peer2._sentMessages.length, 1, 'Peer2 must receive broadcast')
  })

  await test('Suite 1', '1.3 persistBooksData passes excludeSender and updates disk and lastBroadcastJson', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-stress-pbd-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      const sender = createMockWebContents('sender-persist')
      const peer = createMockWebContents('peer-persist')
      registerBooksWebContents(sender)
      registerBooksWebContents(peer)

      const payload: BooksData = JSON.parse(JSON.stringify(initialBooksData))
      payload.updatedAt = '2026-09-05T15:03:00Z'

      persistBooksData(booksPath, payload, sender)

      // Check disk
      assert(existsSync(booksPath), 'Disk file must exist')
      const fromDisk = readBooksStore(booksPath)
      assert.strictEqual(fromDisk.updatedAt, '2026-09-05T15:03:00Z')

      // Check lastBroadcastJson updated
      const lastJson = getLastBroadcastJson()
      assert(lastJson.includes('2026-09-05T15:03:00Z'), 'lastBroadcastJson must match saved payload')

      // Check sender received 0, peer received 1
      assert.strictEqual(sender._sentMessages.length, 0)
      assert.strictEqual(peer._sentMessages.length, 1)
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 2: WEBCONTENTS DESTRUCTION & ERROR RESILIENCE
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 2: WebContents Destruction & Error Resilience ---')

  await test('Suite 2', '2.1 Destroyed WebContents via destroy() event is pruned and Peer2 still receives broadcast', async () => {
    resetTestState()
    const sender = createMockWebContents('sender')
    const peer1 = createMockWebContents('peer1-to-destroy')
    const peer2 = createMockWebContents('peer2-survivor')

    registerBooksWebContents(sender)
    registerBooksWebContents(peer1)
    registerBooksWebContents(peer2)

    assert.strictEqual(getActiveBooksWebContents().length, 3)

    // Simulate destroying Peer1
    peer1.destroy()

    // Pruned from active list
    const active = getActiveBooksWebContents()
    assert.strictEqual(active.length, 2, 'Peer1 must be pruned from active WebContents')
    assert(!active.includes(peer1), 'Active list must not contain Peer1')

    // Broadcast with excludeSender = sender
    const payload: BooksData = JSON.parse(JSON.stringify(initialBooksData))
    payload.updatedAt = '2026-09-05T15:10:00Z'

    assert.doesNotThrow(() => {
      broadcastBooksData(payload, sender)
    }, 'broadcastBooksData must not crash on destroyed WebContents')

    assert.strictEqual(sender._sentMessages.length, 0)
    assert.strictEqual(peer1._sentMessages.length, 0, 'Destroyed Peer1 must receive 0 messages')
    assert.strictEqual(peer2._sentMessages.length, 1, 'Peer2 must receive broadcast successfully')
  })

  await test('Suite 2', '2.2 Silent destruction (isDestroyed() === true without event) is safely skipped without crash', async () => {
    resetTestState()
    const peer1 = createMockWebContents('peer1-silent-dead')
    const peer2 = createMockWebContents('peer2-alive')

    registerBooksWebContents(peer1)
    registerBooksWebContents(peer2)

    // Silent death: isDestroyed returns true without emitting 'destroyed'
    peer1.setDestroyedSilent(true)

    const payload: BooksData = JSON.parse(JSON.stringify(initialBooksData))
    payload.updatedAt = '2026-09-05T15:11:00Z'

    assert.doesNotThrow(() => {
      broadcastBooksData(payload)
    })

    assert.strictEqual(peer1._sentMessages.length, 0, 'Silently destroyed WebContents must not be sent to')
    assert.strictEqual(peer2._sentMessages.length, 1, 'Alive peer must receive broadcast')
  })

  await test('Suite 2', '2.3 WebContents send() exception does not abort broadcast to remaining peers', async () => {
    resetTestState()
    const brokenPeer = createMockWebContents('broken-peer', { throwOnSend: true })
    const healthyPeer = createMockWebContents('healthy-peer')

    registerBooksWebContents(brokenPeer)
    registerBooksWebContents(healthyPeer)

    const payload: BooksData = JSON.parse(JSON.stringify(initialBooksData))
    payload.updatedAt = '2026-09-05T15:12:00Z'

    // Should catch exception and not throw
    assert.doesNotThrow(() => {
      broadcastBooksData(payload)
    }, 'broadcastBooksData must catch send() errors gracefully')

    // Healthy peer must still receive the broadcast!
    assert.strictEqual(healthyPeer._sentMessages.length, 1, 'Healthy peer must receive broadcast despite broken peer')
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 3: LAYER 2 LOOP SUPPRESSION & IN-MEMORY STORE SYNC
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 3: Layer 2 Loop Suppression & Store Sync ---')

  await test('Suite 3', '3.1 syncFromMain with identical hash: 0 mutations and 0 persist calls', async () => {
    resetTestState()

    let persistCallCount = 0
    ;(global as any).window = {
      booksApi: {
        saveData: async () => {
          persistCallCount++
          return true
        },
      },
    }

    try {
      const currentData = useBooksStore.getState().data
      const initialHash = computeDataHash(currentData)
      setLastSavedHash(initialHash)

      let subscriberCalled = false
      const unsub = useBooksStore.subscribe(() => {
        subscriberCalled = true
      })

      // Simulate incoming data identical to last saved
      const cloneData = JSON.parse(JSON.stringify(currentData))
      useBooksStore.getState().syncFromMain(cloneData)

      // Verify no update triggered
      assert.strictEqual(subscriberCalled, false, 'Identical hash must not trigger store update')
      assert.strictEqual(persistCallCount, 0, 'Persist must NEVER be called on identical hash')
      assert.strictEqual(getLastSavedHash(), initialHash, 'lastSavedHash should remain unchanged')

      unsub()
    } finally {
      delete (global as any).window
    }
  })

  await test('Suite 3', '3.2 syncFromMain with updated data: store updates in-memory, party balances recomputed, persist NEVER called', async () => {
    resetTestState()

    let persistCallCount = 0
    ;(global as any).window = {
      booksApi: {
        saveData: async () => {
          persistCallCount++
          return true
        },
      },
    }

    try {
      const currentData = useBooksStore.getState().data
      setLastSavedHash(computeDataHash(currentData))

      let subscriberCalled = false
      const unsub = useBooksStore.subscribe(() => {
        subscriberCalled = true
      })

      // Create new data with an unpaid sales invoice and party
      const updatedData: BooksData = JSON.parse(JSON.stringify(currentData))
      const newInvoice: Invoice = {
        id: 'inv-stress-party-01',
        invoiceNumber: 'INV-STR-001',
        type: 'Sales',
        partyId: 'party-stress-client',
        partyName: 'Stress Test Client (Pty) Ltd',
        date: '2026-09-05',
        dueDate: '2026-10-05',
        items: [],
        subtotal: 50000,
        taxTotal: 7500,
        grandTotal: 57500,
        outstandingAmount: 57500,
        status: 'Unpaid',
        createdAt: '2026-09-05T15:20:00Z',
        updatedAt: '2026-09-05T15:20:00Z',
      }
      const newParty: Party = {
        id: 'party-stress-client',
        name: 'Stress Test Client (Pty) Ltd',
        type: 'Customer',
        outstandingBalance: 0, // Should be recomputed to 57500!
      }

      updatedData.invoices.push(newInvoice)
      updatedData.parties.push(newParty)
      updatedData.updatedAt = '2026-09-05T15:20:00Z'

      useBooksStore.getState().syncFromMain(updatedData)

      assert.strictEqual(subscriberCalled, true, 'Subscribers must be notified of real store update')
      assert.strictEqual(persistCallCount, 0, 'CRITICAL: syncFromMain must NEVER call persist/saveData!')

      // Verify in-memory state
      const stateData = useBooksStore.getState().data
      const foundInvoice = stateData.invoices.find((i) => i.id === 'inv-stress-party-01')
      assert(foundInvoice, 'New invoice must be in store')
      assert.strictEqual(foundInvoice.grandTotal, 57500)

      // Verify party balance recomputation
      const foundParty = stateData.parties.find((p) => p.id === 'party-stress-client')
      assert(foundParty, 'Party must exist')
      assert.strictEqual(
        foundParty.outstandingBalance,
        57500,
        'Party balance must be recomputed to match invoice outstandingAmount'
      )

      // Verify lastSavedHash was updated to incoming hash
      assert.strictEqual(
        getLastSavedHash(),
        computeDataHash(updatedData),
        'lastSavedHash must be updated to incoming data hash'
      )

      unsub()
    } finally {
      delete (global as any).window
    }
  })

  await test('Suite 3', '3.3 syncFromMain handles edge case inputs (null, empty properties) safely', async () => {
    resetTestState()
    assert.doesNotThrow(() => {
      useBooksStore.getState().syncFromMain(null as any)
      useBooksStore.getState().syncFromMain(undefined as any)
      useBooksStore.getState().syncFromMain({} as any)
    }, 'syncFromMain must handle invalid / empty inputs without crashing')
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 4: RAPID CONCURRENT BROADCAST THROUGHPUT & STRESS
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 4: Rapid Broadcast Throughput & Concurrency ---')

  await test('Suite 4', '4.1 50 rapid sequential broadcasts delivered reliably to all peers, sender excluded', async () => {
    resetTestState()
    const sender = createMockWebContents('burst-sender')
    const peer1 = createMockWebContents('burst-peer-1')
    const peer2 = createMockWebContents('burst-peer-2')

    registerBooksWebContents(sender)
    registerBooksWebContents(peer1)
    registerBooksWebContents(peer2)

    const baseData = JSON.parse(JSON.stringify(initialBooksData))

    const startTime = Date.now()
    const BURST_COUNT = 50

    for (let i = 0; i < BURST_COUNT; i++) {
      const payload: BooksData = {
        ...baseData,
        updatedAt: `2026-09-05T15:30:00.${String(i).padStart(3, '0')}Z`,
      }
      broadcastBooksData(payload, sender)
    }

    const elapsed = Date.now() - startTime
    console.log(`    (50 broadcasts completed in ${elapsed}ms)`)

    // Sender must have 0 messages across all 50 iterations
    assert.strictEqual(sender._sentMessages.length, 0, 'Sender must receive 0 messages across all 50 broadcasts')

    // Peer1 and Peer2 must each have received exactly 50 messages
    assert.strictEqual(peer1._sentMessages.length, BURST_COUNT, `Peer1 must receive all ${BURST_COUNT} broadcasts`)
    assert.strictEqual(peer2._sentMessages.length, BURST_COUNT, `Peer2 must receive all ${BURST_COUNT} broadcasts`)

    // Verify ordering is preserved: message 0 is 000Z, message 49 is 049Z
    assert.strictEqual(peer1._sentMessages[0].data.updatedAt, '2026-09-05T15:30:00.000Z')
    assert.strictEqual(peer1._sentMessages[BURST_COUNT - 1].data.updatedAt, '2026-09-05T15:30:00.049Z')
    assert.strictEqual(peer2._sentMessages[0].data.updatedAt, '2026-09-05T15:30:00.000Z')
    assert.strictEqual(peer2._sentMessages[BURST_COUNT - 1].data.updatedAt, '2026-09-05T15:30:00.049Z')

    // Verify lastBroadcastJson equals payload 49
    assert(getLastBroadcastJson().includes('2026-09-05T15:30:00.049Z'))
  })

  await test('Suite 4', '4.2 Mid-stream WebContents destruction during rapid broadcast loop survives without dropping peers', async () => {
    resetTestState()
    const sender = createMockWebContents('stream-sender')
    const dyingPeer = createMockWebContents('dying-peer')
    const enduringPeer = createMockWebContents('enduring-peer')

    registerBooksWebContents(sender)
    registerBooksWebContents(dyingPeer)
    registerBooksWebContents(enduringPeer)

    const baseData = JSON.parse(JSON.stringify(initialBooksData))
    const TOTAL = 30
    const KILL_INDEX = 15

    for (let i = 0; i < TOTAL; i++) {
      if (i === KILL_INDEX) {
        // Destroy dyingPeer at halfway point
        dyingPeer.destroy()
      }

      const payload: BooksData = {
        ...baseData,
        updatedAt: `2026-09-05T15:40:00.${String(i).padStart(3, '0')}Z`,
      }
      broadcastBooksData(payload, sender)
    }

    assert.strictEqual(sender._sentMessages.length, 0, 'Sender received 0')
    assert.strictEqual(dyingPeer._sentMessages.length, KILL_INDEX, `Dying peer received exactly ${KILL_INDEX} messages before death`)
    assert.strictEqual(enduringPeer._sentMessages.length, TOTAL, `Enduring peer received all ${TOTAL} messages`)
  })

  await test('Suite 4', '4.3 File watcher debounce resilience under high-frequency disk write burst', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-burst-watch-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      const observer = createMockWebContents('observer-tab')
      registerBooksWebContents(observer)

      startBooksStoreWatcher(booksPath)
      await delay(50)

      observer._sentMessages.length = 0

      // Fire 20 rapid external writes spaced 5ms apart
      for (let i = 0; i < 20; i++) {
        const d: BooksData = readBooksStore(booksPath)
        d.updatedAt = `2026-09-05T15:50:00.${String(i).padStart(3, '0')}Z`
        writeFileSync(booksPath, JSON.stringify(d, null, 2), 'utf8')
        await delay(5)
      }

      // Wait for 100ms debounce to settle
      await delay(250)

      // Watcher must have coalesced into at most 2 broadcasts
      assert(
        observer._sentMessages.length <= 2,
        `Expected debounce to coalesce 20 writes into <= 2 broadcasts, got ${observer._sentMessages.length}`
      )
      assert(observer._sentMessages.length >= 1, 'Must have received at least 1 coalesced broadcast')

      const finalReceived = observer._sentMessages[observer._sentMessages.length - 1]
      assert.strictEqual(finalReceived.data.updatedAt, '2026-09-05T15:50:00.019Z')
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // RESULTS SUMMARY
  // ──────────────────────────────────────────────────────────────────
  console.log('\n======================================================================')
  console.log(`STRESS AUDIT SUMMARY: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  console.log('======================================================================\n')

  if (failedTests > 0) {
    console.error('STRESS AUDIT FAILURES:')
    for (const f of failures) {
      console.error(`  - [${f.suite}] ${f.name}: ${f.error}`)
    }
    process.exit(1)
  }
}

runAllStressTests().catch((err) => {
  console.error('Unhandled stress suite error:', err)
  process.exit(1)
})

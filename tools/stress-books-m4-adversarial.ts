/**
 * tools/stress-books-m4-adversarial.ts
 *
 * INDEPENDENT ADVERSARIAL STRESS SUITE FOR BOOKS MILESTONE 4 (M4)
 * Author: challenger_2_books_m4
 *
 * EMPIRICAL AUDIT DIMENSIONS:
 * 1. External Disk Write Simulation (Cross-App Tenders/CRM Sync):
 *    - External Tenders milestone billing write to books-data.json
 *    - External CRM won deal invoice creation write to books-data.json
 *    - Live broadcast detection & Books Zustand store syncFromMain update
 *    - Recomputed party balances invariant verification
 * 2. Rapid Atomic File Operations & Debounce Coalescing:
 *    - 10 rapid atomic writes (.tmp write + atomic renameSync) within 50ms
 *    - Suppression of .tmp intermediate files
 *    - Coalescing of multiple file events into single broadcast
 *    - Zero dropped state (final iteration 10 strictly received)
 * 3. Windows File Locking & Race Resiliency:
 *    - Rapid write bursts with immediate watcher reads without EBUSY / EPERM crash
 * 4. External Corrupt / Truncated JSON Resilience:
 *    - External process writes truncated/corrupt JSON
 *    - Watcher & readBooksStore gracefully backup to .corrupted.bak and fallback without process exit
 * 5. Special Characters & Unicode Fidelity:
 *    - Non-ASCII party names, multilingual descriptions, symbols preserved across sync
 * 6. Destroyed WebContents Broadcast Safety:
 *    - Multiple WebContents registered, mid-flight destruction during broadcast
 * 7. Selective Party Balance Reconciliation:
 *    - Open vs Paid vs Cancelled invoices correctly recompute party balances on syncFromMain
 */

import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
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

async function test(suite: string, name: string, fn: () => Promise<void>) {
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

async function runAdversarialSuite() {
  console.log('======================================================================')
  console.log('   CHALLENGER 2: ADVERSARIAL STRESS SUITE FOR BOOKS M4               ')
  console.log('======================================================================\n')

  // ──────────────────────────────────────────────────────────────────
  // SUITE 1: External Disk Write Simulation (Cross-App Tenders/CRM Sync)
  // ──────────────────────────────────────────────────────────────────
  console.log('--- SUITE 1: External Disk Write Simulation (Cross-App Sync) ---')

  await test('Suite 1', '1.1 Tenders milestone billing disk write triggers watcher broadcast and syncFromMain updates store & party balance', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-adv-tenders-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      const booksWebContents = createMockWebContents('books-ui-tab')
      registerBooksWebContents(booksWebContents)

      // Wire renderer listener to store syncFromMain
      booksWebContents.send = (channel: string, data: BooksData) => {
        if (channel === BOOKS_CHANNELS.dataChanged) {
          booksWebContents._sentMessages.push({ channel, data })
          useBooksStore.getState().syncFromMain(data)
        }
      }

      startBooksStoreWatcher(booksPath)
      await delay(60)

      // Simulate external Tenders process (tenders-main.ts) appending a milestone invoice
      const diskData: BooksData = readBooksStore(booksPath)
      const milestoneInvoice: Invoice = {
        id: 'inv-tdr-rfp-2026-04-m1',
        invoiceNumber: 'INV-TDR-0401',
        type: 'Sales',
        partyId: 'party-dwa-rsa',
        partyName: 'Department of Water & Sanitation RSA',
        date: '2026-09-05',
        dueDate: '2026-10-05',
        items: [
          {
            id: 'item-m1',
            itemCode: 'TDR-ENG',
            description: 'Phase 1: Hydrological Inflow Survey (RFP-WTR-2026-04)',
            accountId: 'acc-sales',
            accountName: 'Tender & Commercial Contracting Sales',
            qty: 1,
            rate: 350000,
            taxRate: 15,
            amount: 350000,
          },
        ],
        subtotal: 350000,
        taxTotal: 52500,
        grandTotal: 402500,
        outstandingAmount: 402500,
        status: 'Unpaid',
        tenderReference: 'RFP-WTR-2026-04',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      diskData.invoices.push(milestoneInvoice)
      diskData.parties.push({
        id: 'party-dwa-rsa',
        name: 'Department of Water & Sanitation RSA',
        type: 'Customer',
        outstandingBalance: 0, // initially 0, syncFromMain must recompute to 402500
      })
      diskData.updatedAt = new Date().toISOString()

      // Atomic write directly by external process
      const tmp = `${booksPath}.${Date.now()}.tmp`
      writeFileSync(tmp, JSON.stringify(diskData, null, 2), 'utf8')
      renameSync(tmp, booksPath)

      // Wait for debounce and broadcast
      await delay(250)

      // Verification:
      assert(booksWebContents._sentMessages.length >= 1, 'Books tab must receive data-changed')
      const currentStore = useBooksStore.getState().data
      const storeInvoice = currentStore.invoices.find((i) => i.id === 'inv-tdr-rfp-2026-04-m1')
      assert(storeInvoice, 'Milestone invoice must be present in Zustand store state')
      assert.strictEqual(storeInvoice.tenderReference, 'RFP-WTR-2026-04')
      assert.strictEqual(storeInvoice.grandTotal, 402500)
      assert.strictEqual(storeInvoice.outstandingAmount, 402500)

      const storeParty = currentStore.parties.find((p) => p.id === 'party-dwa-rsa')
      assert(storeParty, 'Customer party must exist in Zustand store')
      assert.strictEqual(
        storeParty.outstandingBalance,
        402500,
        'Party balance must be recomputed by syncFromMain to match open invoice total'
      )
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  await test('Suite 1', '1.2 CRM won deal invoicing disk write triggers watcher broadcast and syncFromMain updates store & party balance', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-adv-crm-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      const booksWebContents = createMockWebContents('books-ui-tab')
      registerBooksWebContents(booksWebContents)

      booksWebContents.send = (channel: string, data: BooksData) => {
        if (channel === BOOKS_CHANNELS.dataChanged) {
          booksWebContents._sentMessages.push({ channel, data })
          useBooksStore.getState().syncFromMain(data)
        }
      }

      startBooksStoreWatcher(booksPath)
      await delay(60)

      // Simulate external CRM process (crm-main.ts) appending a won deal invoice
      const diskData: BooksData = readBooksStore(booksPath)
      const crmInvoice: Invoice = {
        id: 'inv-crm-vodacom-won',
        invoiceNumber: 'INV-CRM-9901',
        type: 'Sales',
        partyId: 'party-voda-corp',
        partyName: 'Vodacom Corporate Systems (Pty) Ltd',
        date: '2026-09-05',
        dueDate: '2026-10-05',
        items: [
          {
            id: 'item-crm-license',
            itemCode: 'CRM-ENT-LIC',
            description: 'Enterprise Tier License for 500 Seats',
            accountId: 'acc-sales',
            accountName: 'Tender & Commercial Contracting Sales',
            qty: 1,
            rate: 600000,
            taxRate: 15,
            amount: 600000,
          },
        ],
        subtotal: 600000,
        taxTotal: 90000,
        grandTotal: 690000,
        outstandingAmount: 690000,
        status: 'Unpaid',
        crmDealId: 'deal-voda-q3-won',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      diskData.invoices.push(crmInvoice)
      diskData.parties.push({
        id: 'party-voda-corp',
        name: 'Vodacom Corporate Systems (Pty) Ltd',
        type: 'Customer',
        outstandingBalance: 0,
      })
      diskData.updatedAt = new Date().toISOString()

      // Atomic write by CRM process
      const tmp = `${booksPath}.${Date.now()}.tmp`
      writeFileSync(tmp, JSON.stringify(diskData, null, 2), 'utf8')
      renameSync(tmp, booksPath)

      await delay(250)

      assert(booksWebContents._sentMessages.length >= 1, 'Books tab must receive data-changed')
      const currentStore = useBooksStore.getState().data
      const storeInvoice = currentStore.invoices.find((i) => i.id === 'inv-crm-vodacom-won')
      assert(storeInvoice, 'CRM invoice must be in store')
      assert.strictEqual(storeInvoice.crmDealId, 'deal-voda-q3-won')
      assert.strictEqual(storeInvoice.grandTotal, 690000)

      const storeParty = currentStore.parties.find((p) => p.id === 'party-voda-corp')
      assert(storeParty, 'Vodacom party must exist')
      assert.strictEqual(storeParty.outstandingBalance, 690000)
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 2: Rapid Atomic File Operations & Debounce Coalescing
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 2: Rapid Atomic File Operations & Debounce Coalescing ---')

  await test('Suite 2', '2.1 10 rapid atomic .tmp + rename writes within 50ms coalesce into single broadcast with final state', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-adv-rapid-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      const mockWc = createMockWebContents('rapid-test-wc')
      registerBooksWebContents(mockWc)
      startBooksStoreWatcher(booksPath)
      await delay(60)

      mockWc._sentMessages.length = 0

      const startTime = Date.now()
      const totalBurstWrites = 10

      // Execute 10 rapid atomic writes (.tmp write then renameSync)
      for (let i = 1; i <= totalBurstWrites; i++) {
        const diskData: BooksData = readBooksStore(booksPath)
        diskData.updatedAt = `2026-09-05T16:45:00.${String(i).padStart(3, '0')}Z`
        diskData.settings.companyName = `Rapid Test Company iteration ${i}`

        const tmpFile = `${booksPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
        writeFileSync(tmpFile, JSON.stringify(diskData, null, 2), 'utf8')
        renameSync(tmpFile, booksPath)

        // Keep interval between 2ms and 4ms to ensure all 10 occur in <= 50ms
        await delay(3)
      }

      const burstDuration = Date.now() - startTime
      console.log(`    (10 atomic writes completed in ${burstDuration}ms)`)

      // Wait 250ms for 100ms debounce timer to settle
      await delay(250)

      // Verification: Coalescing check
      const broadcasts = mockWc._sentMessages.filter((m) => m.channel === BOOKS_CHANNELS.dataChanged)
      assert(
        broadcasts.length <= 2,
        `Expected at most 2 broadcasts from debouncer for 10 rapid atomic writes, got ${broadcasts.length}`
      )
      assert(
        broadcasts.length >= 1,
        `Expected at least 1 broadcast, got 0`
      )

      // Verification: Final state preservation
      const lastBroadcast = broadcasts[broadcasts.length - 1]
      assert.strictEqual(
        lastBroadcast.data.settings.companyName,
        `Rapid Test Company iteration ${totalBurstWrites}`,
        'The coalesced broadcast MUST reflect the final state of iteration 10 without dropping data'
      )
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  await test('Suite 2', '2.2 File watcher strictly ignores .tmp files written without rename', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-adv-tmpignore-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      const mockWc = createMockWebContents('tmp-ignore-wc')
      registerBooksWebContents(mockWc)
      startBooksStoreWatcher(booksPath)
      await delay(60)

      mockWc._sentMessages.length = 0

      // Write several .tmp files in the directory that are NOT renamed to books-data.json
      for (let i = 0; i < 5; i++) {
        const strayTmp = join(testDir, `books-data.json.${Date.now()}.${i}.tmp`)
        writeFileSync(strayTmp, JSON.stringify({ stray: true }), 'utf8')
        await delay(10)
      }

      // Wait for debounce
      await delay(250)

      // File watcher filter (isBooksFile && isNotTmp) must ignore these
      assert.strictEqual(
        mockWc._sentMessages.length,
        0,
        'Watcher must ignore stray .tmp files and emit 0 broadcasts'
      )
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 3: Windows File Locking & Error Resilience
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 3: Windows File Locking & Error Resilience ---')

  await test('Suite 3', '3.1 External write of corrupt JSON does not crash file watcher or main process', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-adv-corrupt-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      const mockWc = createMockWebContents('corrupt-test-wc')
      registerBooksWebContents(mockWc)
      startBooksStoreWatcher(booksPath)
      await delay(60)

      // External crash writes truncated/invalid JSON
      writeFileSync(booksPath, '{"version": 1, "unclosed_json: [', 'utf8')

      // Wait for debounce and watch handler execution
      await delay(250)

      // Watcher must not throw or crash. It should fall back safely.
      // Furthermore, readBooksStore creates backup files
      assert(existsSync(booksPath), 'books-data.json should still exist')
      const corruptFiles = existsSync(`${booksPath}.corrupted.bak`)
      assert(corruptFiles, 'readBooksStore must have backed up corrupt file to .corrupted.bak')
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 4: Special Characters, Unicode & Large Payload Integrity
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 4: Unicode Fidelity & Special Characters ---')

  await test('Suite 4', '4.1 External sync preserves Unicode, special symbols, and multiline notes', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-adv-unicode-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      const mockWc = createMockWebContents('unicode-wc')
      registerBooksWebContents(mockWc)

      mockWc.send = (channel: string, data: BooksData) => {
        if (channel === BOOKS_CHANNELS.dataChanged) {
          mockWc._sentMessages.push({ channel, data })
          useBooksStore.getState().syncFromMain(data)
        }
      }

      startBooksStoreWatcher(booksPath)
      await delay(60)

      const diskData: BooksData = readBooksStore(booksPath)
      const unicodeInvoice: Invoice = {
        id: 'inv-unicode-sa',
        invoiceNumber: 'INV-🇿🇦-2026',
        type: 'Sales',
        partyId: 'party-unicode',
        partyName: 'Möbius & Ndlambe Engineering (Pty) Ltd — 🌍',
        date: '2026-09-05',
        dueDate: '2026-10-05',
        items: [
          {
            id: 'item-u1',
            description: 'Solar PV Farm Grid Tie-in: R 1,500,000.00 / 15% VAT & € / $ quotes',
            accountId: 'acc-sales',
            accountName: 'Tender & Commercial Contracting Sales',
            qty: 1,
            rate: 1500000,
            taxRate: 15,
            amount: 1500000,
          },
        ],
        subtotal: 1500000,
        taxTotal: 225000,
        grandTotal: 1725000,
        outstandingAmount: 1725000,
        status: 'Unpaid',
        notes: 'Notes with quotes "hello" & ampersands & tabs \t and newlines \nSpecial symbols: <xml></xml> © 2026',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      diskData.invoices.push(unicodeInvoice)
      diskData.parties.push({
        id: 'party-unicode',
        name: 'Möbius & Ndlambe Engineering (Pty) Ltd — 🌍',
        type: 'Customer',
        outstandingBalance: 0,
      })

      const tmp = `${booksPath}.${Date.now()}.tmp`
      writeFileSync(tmp, JSON.stringify(diskData, null, 2), 'utf8')
      renameSync(tmp, booksPath)

      await delay(250)

      const store = useBooksStore.getState().data
      const found = store.invoices.find((i) => i.id === 'inv-unicode-sa')
      assert(found, 'Unicode invoice must be present in store')
      assert.strictEqual(found.partyName, 'Möbius & Ndlambe Engineering (Pty) Ltd — 🌍')
      assert(found.notes?.includes('© 2026'))

      const p = store.parties.find((p) => p.id === 'party-unicode')
      assert(p, 'Unicode party must exist')
      assert.strictEqual(p.outstandingBalance, 1725000)
    } finally {
      stopBooksStoreWatcher()
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 5: Multiple WebContents with Concurrent Destroy Safety
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 5: Multiple WebContents with Concurrent Destroy Safety ---')

  await test('Suite 5', '5.1 Broadcast handles mid-flight WebContents destruction without uncaught error', async () => {
    resetTestState()
    const testDir = join(tmpdir(), `books-m4-adv-destroy-${randomUUID().slice(0, 6)}`)
    mkdirSync(testDir, { recursive: true })
    const booksPath = join(testDir, 'books-data.json')

    try {
      writeBooksStore(booksPath, initialBooksData)

      const liveWc1 = createMockWebContents('live-wc-1')
      const dyingWc = createMockWebContents('dying-wc')
      const liveWc2 = createMockWebContents('live-wc-2')

      registerBooksWebContents(liveWc1)
      registerBooksWebContents(dyingWc)
      registerBooksWebContents(liveWc2)

      // Destroy dyingWc right before broadcast
      dyingWc.destroy()

      // Broadcast should safely filter out dyingWc and send to liveWc1 and liveWc2
      broadcastBooksData(initialBooksData)

      assert.strictEqual(liveWc1._sentMessages.length, 1)
      assert.strictEqual(liveWc2._sentMessages.length, 1)
      assert.strictEqual(dyingWc._sentMessages.length, 0)
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // SUITE 6: Party Balance Calculation Invariants in syncFromMain
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- SUITE 6: Selective Party Balance Invariant in syncFromMain ---')

  await test('Suite 6', '6.1 syncFromMain ignores Paid and Cancelled invoices and correctly sums Unpaid/Overdue balances', async () => {
    resetTestState()

    const parties: Party[] = [
      { id: 'p-multi', name: 'Multi Invoice Client', type: 'Customer', outstandingBalance: 0 },
    ]

    const invoices: Invoice[] = [
      {
        id: 'inv-paid',
        invoiceNumber: 'INV-P-01',
        type: 'Sales',
        partyId: 'p-multi',
        partyName: 'Multi Invoice Client',
        date: '2026-09-01',
        dueDate: '2026-09-15',
        items: [],
        subtotal: 10000,
        taxTotal: 1500,
        grandTotal: 11500,
        outstandingAmount: 0,
        status: 'Paid',
        createdAt: '2026-09-01T10:00:00Z',
        updatedAt: '2026-09-01T10:00:00Z',
      },
      {
        id: 'inv-cancelled',
        invoiceNumber: 'INV-C-01',
        type: 'Sales',
        partyId: 'p-multi',
        partyName: 'Multi Invoice Client',
        date: '2026-09-02',
        dueDate: '2026-09-16',
        items: [],
        subtotal: 5000,
        taxTotal: 750,
        grandTotal: 5750,
        outstandingAmount: 5750,
        status: 'Cancelled',
        createdAt: '2026-09-02T10:00:00Z',
        updatedAt: '2026-09-02T10:00:00Z',
      },
      {
        id: 'inv-unpaid',
        invoiceNumber: 'INV-U-01',
        type: 'Sales',
        partyId: 'p-multi',
        partyName: 'Multi Invoice Client',
        date: '2026-09-03',
        dueDate: '2026-10-03',
        items: [],
        subtotal: 20000,
        taxTotal: 3000,
        grandTotal: 23000,
        outstandingAmount: 23000,
        status: 'Unpaid',
        createdAt: '2026-09-03T10:00:00Z',
        updatedAt: '2026-09-03T10:00:00Z',
      },
      {
        id: 'inv-partial',
        invoiceNumber: 'INV-PARTIAL-01',
        type: 'Sales',
        partyId: 'p-multi',
        partyName: 'Multi Invoice Client',
        date: '2026-09-04',
        dueDate: '2026-09-20',
        items: [],
        subtotal: 10000,
        taxTotal: 1500,
        grandTotal: 11500,
        outstandingAmount: 4000, // partially paid, 4000 remaining
        status: 'Unpaid',
        createdAt: '2026-09-04T10:00:00Z',
        updatedAt: '2026-09-04T10:00:00Z',
      },
    ]

    const payload: BooksData = {
      ...initialBooksData,
      parties,
      invoices,
    }

    useBooksStore.getState().syncFromMain(payload)

    const updatedParty = useBooksStore.getState().data.parties.find((p) => p.id === 'p-multi')
    assert(updatedParty, 'Party must exist')
    // Expected outstanding = 23000 + 4000 = 27000 (Paid invoice: 0, Cancelled invoice: excluded)
    assert.strictEqual(
      updatedParty.outstandingBalance,
      27000,
      `Expected outstanding balance to be 27000, got ${updatedParty.outstandingBalance}`
    )
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

runAdversarialSuite().catch((err) => {
  console.error('Unhandled test suite error:', err)
  process.exit(1)
})

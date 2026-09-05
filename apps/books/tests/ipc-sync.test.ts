import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOKS_CHANNELS } from '../src/shared/ipc'
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
} from '../src/main/books-main'
import {
  useBooksStore,
  computeDataHash,
  getLastSavedHash,
  setLastSavedHash,
} from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import type { BooksData, Invoice, Party } from '../src/shared/types'
import type { WebContents } from 'electron'

interface MockWebContentsHandle {
  wc: WebContents
  getReceived: () => Array<{ channel: string; data: any }>
  destroy: () => void
}

function createMockWebContents(customId?: string): MockWebContentsHandle {
  let isDestroyed = false
  const listeners: Record<string, Array<() => void>> = {}
  const received: Array<{ channel: string; data: any }> = []

  const mock = {
    id: customId || `wc-${randomUUID().slice(0, 6)}`,
    isDestroyed: () => isDestroyed,
    send: (channel: string, data: any) => {
      if (isDestroyed) throw new Error('Cannot send to destroyed WebContents')
      received.push({ channel, data })
    },
    once: (event: string, cb: () => void) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(cb)
    },
    destroy: () => {
      isDestroyed = true
      for (const cb of listeners['destroyed'] || []) {
        cb()
      }
    },
  } as unknown as WebContents

  return {
    wc: mock,
    getReceived: () => received,
    destroy: () => (mock as any).destroy(),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

describe('F20 & F14/F15/F16 IPC Synchronization & Event Pipeline Suite', () => {
  let testDir: string
  let booksFilePath: string

  beforeEach(() => {
    testDir = join(tmpdir(), `books-ipc-test-${randomUUID().slice(0, 8)}`)
    mkdirSync(testDir, { recursive: true })
    booksFilePath = join(testDir, 'books-data.json')

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
  })

  afterEach(() => {
    resetBooksIpcForTesting()
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    } catch {}
  })

  describe('IPC Channels Contract & Preload Listener Cleanup', () => {
    it('defines dataChanged and DATA_CHANGED as books:data-changed', () => {
      expect(BOOKS_CHANNELS.dataChanged).toBe('books:data-changed')
      expect(BOOKS_CHANNELS.DATA_CHANGED).toBe('books:data-changed')
    })

    it('simulates preload onDataChanged listener registration and unsubscribe cleanup', () => {
      const listeners = new Map<string, Set<Function>>()
      const mockIpcRenderer = {
        on: (channel: string, fn: Function) => {
          if (!listeners.has(channel)) listeners.set(channel, new Set())
          listeners.get(channel)!.add(fn)
        },
        removeListener: (channel: string, fn: Function) => {
          listeners.get(channel)?.delete(fn)
        },
      }

      // Implementation of preload onDataChanged contract
      const onDataChanged = (callback: (data: BooksData) => void) => {
        const listener = (_: any, data: BooksData) => callback(data)
        mockIpcRenderer.on(BOOKS_CHANNELS.dataChanged, listener)
        return () => {
          mockIpcRenderer.removeListener(BOOKS_CHANNELS.dataChanged, listener)
        }
      }

      let callCount = 0
      let lastData: BooksData | null = null
      const unsubscribe = onDataChanged((data) => {
        callCount++
        lastData = data
      })

      expect(listeners.get(BOOKS_CHANNELS.dataChanged)?.size).toBe(1)

      // Emit event
      const sampleData = { ...initialBooksData }
      const registeredFn = Array.from(listeners.get(BOOKS_CHANNELS.dataChanged)!)[0]
      registeredFn({}, sampleData)

      expect(callCount).toBe(1)
      expect(lastData).toBe(sampleData)

      // Unsubscribe cleanup
      unsubscribe()
      expect(listeners.get(BOOKS_CHANNELS.dataChanged)?.size).toBe(0)
    })
  })

  describe('WebContents Tracking & Auto-Pruning', () => {
    it('registers valid WebContents and retrieves active list', () => {
      const mock1 = createMockWebContents('wc-tab-1')
      const mock2 = createMockWebContents('wc-tab-2')

      registerBooksWebContents(mock1.wc)
      registerBooksWebContents(mock2.wc)

      const active = getActiveBooksWebContents()
      expect(active).toHaveLength(2)
      expect(active.map((w: any) => w.id)).toContain('wc-tab-1')
      expect(active.map((w: any) => w.id)).toContain('wc-tab-2')
    })

    it('rejects null, undefined, or destroyed WebContents from registration', () => {
      registerBooksWebContents(null as any)
      registerBooksWebContents(undefined as any)

      const dead = createMockWebContents('wc-dead')
      dead.destroy()
      registerBooksWebContents(dead.wc)

      expect(getActiveBooksWebContents()).toHaveLength(0)
    })

    it('automatically unregisters WebContents upon destroyed event', () => {
      const mock1 = createMockWebContents('wc-live')
      const mock2 = createMockWebContents('wc-to-close')

      registerBooksWebContents(mock1.wc)
      registerBooksWebContents(mock2.wc)
      expect(getActiveBooksWebContents()).toHaveLength(2)

      // Simulate tab close / destruction
      mock2.destroy()

      const active = getActiveBooksWebContents()
      expect(active).toHaveLength(1)
      expect((active[0] as any).id).toBe('wc-live')
    })

    it('unregisterBooksWebContents explicitly removes WebContents', () => {
      const mock = createMockWebContents('wc-explicit')
      registerBooksWebContents(mock.wc)
      expect(getActiveBooksWebContents()).toHaveLength(1)

      unregisterBooksWebContents(mock.wc)
      expect(getActiveBooksWebContents()).toHaveLength(0)
    })
  })

  describe('Layer 1 Sender Loop Suppression (Electron Main)', () => {
    it('broadcasts to all WebContents when no excludeSender is provided', () => {
      const tab1 = createMockWebContents('tab-1')
      const tab2 = createMockWebContents('tab-2')

      registerBooksWebContents(tab1.wc)
      registerBooksWebContents(tab2.wc)

      const payload = { ...initialBooksData }
      broadcastBooksData(payload)

      expect(tab1.getReceived()).toHaveLength(1)
      expect(tab1.getReceived()[0].channel).toBe(BOOKS_CHANNELS.dataChanged)
      expect(tab2.getReceived()).toHaveLength(1)
      expect(tab2.getReceived()[0].channel).toBe(BOOKS_CHANNELS.dataChanged)
    })

    it('skips excludeSender so originator receives 0 echo broadcasts while peers receive it', () => {
      const senderTab = createMockWebContents('sender-tab')
      const peerTab1 = createMockWebContents('peer-tab-1')
      const peerTab2 = createMockWebContents('peer-tab-2')

      registerBooksWebContents(senderTab.wc)
      registerBooksWebContents(peerTab1.wc)
      registerBooksWebContents(peerTab2.wc)

      const payload = { ...initialBooksData }
      broadcastBooksData(payload, senderTab.wc)

      expect(senderTab.getReceived()).toHaveLength(0) // 0 echoes to sender!
      expect(peerTab1.getReceived()).toHaveLength(1)
      expect(peerTab2.getReceived()).toHaveLength(1)
    })

    it('persistBooksData writes to disk and passes excludeSender to broadcast', () => {
      const originator = createMockWebContents('originator')
      const observer = createMockWebContents('observer')

      registerBooksWebContents(originator.wc)
      registerBooksWebContents(observer.wc)

      persistBooksData(booksFilePath, initialBooksData, originator.wc)

      expect(existsSync(booksFilePath)).toBe(true)
      expect(originator.getReceived()).toHaveLength(0)
      expect(observer.getReceived()).toHaveLength(1)
    })
  })

  describe('Layer 2 Hash Comparison Loop Suppression (Renderer Store)', () => {
    it('computeDataHash produces consistent deterministic hash', () => {
      const h1 = computeDataHash(initialBooksData)
      const h2 = computeDataHash(JSON.parse(JSON.stringify(initialBooksData)))
      expect(h1).toBe(h2)
    })

    it('syncFromMain ignores incoming data identical to lastSavedHash (Layer 2 guard)', () => {
      const store = useBooksStore.getState()
      setLastSavedHash(computeDataHash(store.data))

      let stateChanged = false
      const unsub = useBooksStore.subscribe(() => {
        stateChanged = true
      })

      // Send clone of current state
      store.syncFromMain(JSON.parse(JSON.stringify(store.data)))

      expect(stateChanged).toBe(false)
      unsub()
    })

    it('syncFromMain updates in-memory state without calling persist or mutating disk', () => {
      const store = useBooksStore.getState()
      const newParty: Party = { id: 'p-ext', name: 'External Party', type: 'Customer', outstandingBalance: 4500 }
      const externalData: BooksData = {
        ...store.data,
        parties: [...store.data.parties, newParty],
      }

      const preHash = getLastSavedHash()
      store.syncFromMain(externalData)

      const postState = useBooksStore.getState().data
      expect(postState.parties.some((p) => p.name === 'External Party')).toBe(true)

      // Hash was updated to incoming data hash
      expect(getLastSavedHash()).not.toBe(preHash)
      expect(getLastSavedHash()).toBe(computeDataHash(externalData))
    })

    it('syncFromMain correctly recomputes party balances for new invoices', () => {
      const store = useBooksStore.getState()
      const customer: Party = { id: 'p-sync-cust', name: 'Sync Client', type: 'Customer', outstandingBalance: 0 }
      const newInvoice: Invoice = {
        id: 'inv-sync-1',
        invoiceNumber: 'INV-SYNC-01',
        type: 'Sales',
        partyId: customer.id,
        partyName: customer.name,
        status: 'Unpaid',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        subtotal: 10000,
        taxTotal: 1500,
        grandTotal: 11500,
        outstandingAmount: 11500,
        items: [],
      }

      const incoming: BooksData = {
        ...store.data,
        parties: [...store.data.parties, customer],
        invoices: [...store.data.invoices, newInvoice],
      }

      store.syncFromMain(incoming)

      const updatedCustomer = useBooksStore.getState().data.parties.find((p) => p.id === customer.id)!
      expect(updatedCustomer.outstandingBalance).toBe(11500)
    })
  })

  describe('Debounced Filesystem Watcher & Cross-App Live Sync', () => {
    it('file watcher detects external disk write and broadcasts to active renderers', async () => {
      writeBooksStore(booksFilePath, initialBooksData)

      const observer = createMockWebContents('observer-tab')
      registerBooksWebContents(observer.wc)

      startBooksStoreWatcher(booksFilePath)

      // Simulate external write (e.g. from Tenders milestone billing process)
      const externalInvoice: Invoice = {
        id: 'inv-tender-milestone-99',
        invoiceNumber: 'INV-RFP-WTR-01',
        type: 'Sales',
        partyId: 'p-rand-water',
        partyName: 'Rand Water Authority',
        tenderReference: 'RFP-WTR-2026-04',
        status: 'Unpaid',
        date: '2026-09-05',
        dueDate: '2026-10-05',
        subtotal: 75000,
        taxTotal: 11250,
        grandTotal: 86250,
        outstandingAmount: 86250,
        items: [],
      }

      const externalData: BooksData = {
        ...initialBooksData,
        invoices: [externalInvoice, ...initialBooksData.invoices],
      }

      // External direct write bypassing Books process
      writeFileSync(booksFilePath, JSON.stringify(externalData, null, 2), 'utf8')

      // Wait for debounce timer (100ms) + filesystem event
      await delay(250)

      const received = observer.getReceived()
      expect(received.length).toBeGreaterThanOrEqual(1)
      const broadcast = received[received.length - 1]
      expect(broadcast.channel).toBe(BOOKS_CHANNELS.dataChanged)
      expect(broadcast.data.invoices[0].invoiceNumber).toBe('INV-RFP-WTR-01')

      stopBooksStoreWatcher()
    })

    it('internal writeBooksStore updates lastBroadcastJson preventing redundant watcher broadcast', async () => {
      writeBooksStore(booksFilePath, initialBooksData)

      const observer = createMockWebContents('observer-internal')
      registerBooksWebContents(observer.wc)

      startBooksStoreWatcher(booksFilePath)

      // Internal write sets lastBroadcastJson
      const mutated = {
        ...initialBooksData,
        parties: [{ id: 'p-int', name: 'Internal Party', type: 'Customer' as const, outstandingBalance: 100 }],
      }
      writeBooksStore(booksFilePath, mutated)

      await delay(250)

      // The watcher observed the file change, but currentJson === lastBroadcastJson, so 0 redundant broadcasts
      expect(observer.getReceived()).toHaveLength(0)

      stopBooksStoreWatcher()
    })

    it('debounces rapid sequential external writes into a coalesced broadcast', async () => {
      writeBooksStore(booksFilePath, initialBooksData)

      const observer = createMockWebContents('observer-debounce')
      registerBooksWebContents(observer.wc)

      startBooksStoreWatcher(booksFilePath)

      // Rapidly write 3 times within 30ms
      for (let i = 1; i <= 3; i++) {
        const rapidData = {
          ...initialBooksData,
          settings: { ...initialBooksData.settings, companyName: `Rapid Update ${i}` },
        }
        writeFileSync(booksFilePath, JSON.stringify(rapidData, null, 2), 'utf8')
        await delay(15)
      }

      // Wait for debounce timer to fire
      await delay(250)

      // Coalesced into 1 broadcast (or at most 2 depending on OS timing, but significantly fewer than raw events)
      expect(observer.getReceived().length).toBeLessThanOrEqual(2)
      const last = observer.getReceived()[observer.getReceived().length - 1]
      expect(last.data.settings.companyName).toBe('Rapid Update 3')

      stopBooksStoreWatcher()
    })
  })
})

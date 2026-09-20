import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testDir = join(tmpdir(), `tenders-ipc-test-${randomUUID().slice(0, 8)}`)

const { ipcHandlers, openedPaths, mockBroadcasts, removedHandlers, booksInvoiceCalls } = vi.hoisted(
  () => ({
    ipcHandlers: new Map<string, (...args: unknown[]) => any>(),
    openedPaths: [] as string[],
    mockBroadcasts: [] as Array<{ channel: string; data: any }>,
    removedHandlers: [] as string[],
    booksInvoiceCalls: [] as any[],
  }),
)

vi.mock('electron', () => {
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return testDir
        return testDir
      },
      isReady: () => true,
    },
    ipcMain: {
      handle: (channel: string, listener: (...args: any[]) => any) => {
        ipcHandlers.set(channel, listener)
      },
      removeHandler: (channel: string) => {
        removedHandlers.push(channel)
        ipcHandlers.delete(channel)
      },
    },
    shell: {
      openPath: vi.fn(async (p: string) => {
        openedPaths.push(p)
        return ''
      }),
    },
    WebContentsView: class MockWebContentsView {
      webContents = {
        isDestroyed: () => false,
        send: (channel: string, data: any) => {
          mockBroadcasts.push({ channel, data })
        },
        once: vi.fn(),
      }
    },
  }
})

import {
  broadcastTendersData,
  configureTendersRuntime,
  deleteDocumentFile,
  getActiveTendersWebContents,
  getTendersDocumentsDir,
  getTendersVaultDir,
  migrateAndValidateTenders,
  openDocumentFile,
  readDocumentFile,
  readTendersStore,
  registerTendersIpc,
  registerTendersWebContents,
  resolveSafeTendersPath,
  saveDocumentFile,
  SEED_TENDER_WTR_04,
  unregisterTendersWebContents,
  writeTendersStore,
} from '../src/main/tenders-main'
// Wrap (do not replace) the real Books posting so the existing invoice-numbering
// coverage still runs while F4 can assert the exact number of posts.
vi.mock('../../books/src/main/books-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>
  return {
    ...actual,
    issueSalesInvoiceInBooks: (req: any) => {
      booksInvoiceCalls.push(req)
      return actual.issueSalesInvoiceInBooks(req)
    },
  }
})

import { MAX_TENDERS_DOCUMENT_UPLOAD_BYTES, TENDERS_CHANNELS } from '../src/shared/ipc'
import { createEmptyTendersDataV2, migrateTendersDataV1 } from '../src/shared/tenders-schema'
import type { TenderRecord, TendersData, TendersDataV1, TendersDataV2 } from '../src/shared/types'

const LOAD_STORE_V2_CHANNEL = 'tenders:load-store-v2'
const SAVE_STORE_V2_CHANNEL = 'tenders:save-store-v2'
const STORE_CHANGED_V2_CHANNEL = 'tenders:store-changed-v2'
const storeFile = join(testDir, 'tenders', 'tenders-data.json')
const registeredTestWebContents: any[] = []

/** Origin the main process must treat as the real Tenders renderer. */
const TRUSTED_RENDERER_URL = 'http://localhost:5179/'
const UNTRUSTED_RENDERER_URL = 'https://attacker.example/'

function validV2(revision = 0): TendersDataV2 {
  return { ...createEmptyTendersDataV2('2026-09-01T08:30:00.000Z'), revision }
}

function validV1(): TendersDataV1 {
  const data = migrateAndValidateTenders(null) as TendersDataV1
  data.version = 1
  data.updatedAt = '2026-08-20T09:15:30.000Z'
  data.workspaces[0].company.tradingName = 'IPC migration marker'
  return data
}

/**
 * A valid schema-v2 document carrying the seeded tender (ms-01 REACHED,
 * ms-02 PENDING) at the requested authoritative revision.
 */
function v2WithSeedTender(revision: number): TendersDataV2 {
  const migrated = migrateTendersDataV1(validV1(), '2026-09-01T08:30:00.000Z')
  if (!migrated.ok) throw new Error(`v2 fixture migration failed: ${migrated.error.message}`)
  return { ...migrated.data, revision }
}

function registeredWebContents(
  send: (channel: string, data: unknown) => void = vi.fn(),
  url: string = TRUSTED_RENDERER_URL,
): any {
  const webContents: any = {
    isDestroyed: () => false,
    getURL: () => url,
    send,
    once: vi.fn(),
  }
  registerTendersWebContents(webContents)
  registeredTestWebContents.push(webContents)
  return webContents
}

/**
 * Frame contract shape expected by the remediated privileged handlers:
 * `event.senderFrame.url` is the caller frame URL and `event.senderFrame.parent`
 * is null only for the top frame.
 */
function trustedFrame(): any {
  return { url: TRUSTED_RENDERER_URL, parent: null }
}

function untrustedFrame(): any {
  return { url: UNTRUSTED_RENDERER_URL, parent: null }
}

function subFrame(): any {
  return { url: TRUSTED_RENDERER_URL, parent: {} }
}

function event(sender: any, senderFrame: any = trustedFrame()): { sender: any; senderFrame: any } {
  return { sender, senderFrame }
}

function deliveryRecorder(): {
  send: (channel: string, data: unknown) => void
  deliveries: Array<{ channel: string; data: any }>
} {
  const deliveries: Array<{ channel: string; data: any }> = []
  return {
    deliveries,
    send: (channel: string, data: unknown) => {
      deliveries.push({ channel, data: data as any })
    },
  }
}

describe('Electron IPC Handlers & Security Validation', () => {
  beforeAll(() => {
    mkdirSync(testDir, { recursive: true })
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
    })
    registerTendersIpc()
  })

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    rmSync(storeFile, { force: true })
    openedPaths.length = 0
    mockBroadcasts.length = 0
    removedHandlers.length = 0
    booksInvoiceCalls.length = 0
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
      onOpenCrm: undefined,
      onOpenBooks: undefined,
      openGeneratedPath: undefined,
    })
    // Keep handlers present even if a prior test exercised the reset API.
    registerTendersIpc()
  })

  afterEach(() => {
    for (const webContents of registeredTestWebContents.splice(0)) {
      unregisterTendersWebContents(webContents)
    }
    rmSync(storeFile, { force: true })
  })

  afterAll(() => {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    } catch {}
  })

  describe('1. tenders:data-changed Push Notifications & WebContents Tracking', () => {
    it('registers active WebContents and broadcasts tenders:data-changed events', () => {
      const received: any[] = []
      const fakeWc: any = {
        isDestroyed: () => false,
        getURL: () => TRUSTED_RENDERER_URL,
        send: (channel: string, data: any) => {
          if (channel === TENDERS_CHANNELS.dataChanged) received.push(data)
        },
        once: vi.fn(),
      }

      registerTendersWebContents(fakeWc)
      expect(getActiveTendersWebContents()).toContain(fakeWc)

      const testData: TendersData = migrateAndValidateTenders(null)
      broadcastTendersData(testData)

      expect(received).toHaveLength(1)
      expect(received[0].version).toBe(1)
      expect(received[0].activeCompanyId).toBe(testData.activeCompanyId)

      // Unregister
      unregisterTendersWebContents(fakeWc)
      expect(getActiveTendersWebContents()).not.toContain(fakeWc)
    })

    it('prunes destroyed WebContents automatically without throwing', () => {
      let isDead = false
      const fakeWc: any = {
        isDestroyed: () => isDead,
        send: vi.fn(),
        once: vi.fn(),
      }

      registerTendersWebContents(fakeWc)
      expect(getActiveTendersWebContents()).toContain(fakeWc)

      isDead = true
      expect(getActiveTendersWebContents()).not.toContain(fakeWc)

      const testData: TendersData = migrateAndValidateTenders(null)
      expect(() => broadcastTendersData(testData)).not.toThrow()
    })

    it.each([
      { channel: TENDERS_CHANNELS.getStoredData, args: [] as unknown[] },
      { channel: TENDERS_CHANNELS.saveStoredData, args: ['not-valid-json'] as unknown[] },
    ])('$channel cannot enroll its sender for proposal side effects', async ({ channel, args }) => {
      const persistenceHandler = ipcHandlers.get(channel)
      const draftHandler = ipcHandlers.get(TENDERS_CHANNELS.draftProposalDoc)
      expect(persistenceHandler).toBeDefined()
      expect(draftHandler).toBeDefined()
      const unregisteredSender: any = {
        isDestroyed: () => false,
        send: vi.fn(),
        once: vi.fn(),
      }

      await persistenceHandler!({ sender: unregisteredSender }, ...args)
      const wasEnrolledByPersistence = getActiveTendersWebContents().includes(unregisteredSender)
      const proposalResult = await draftHandler!(
        { sender: unregisteredSender },
        {
          title: 'Persistence sender must remain unauthorized',
          referenceNumber: 'SEC-IPC-01',
          issuingBody: 'Security Review',
          closingDate: '2099-12-31',
          estimatedValue: 100,
          pricingConfirmed: true,
          requirements: [
            {
              id: 'req-1',
              title: 'Known requirement',
              isMandatory: true,
              status: 'FULFILLED',
              linkedVaultDocId: 'vault-1',
              healthStatus: 'VALID',
            },
          ],
          milestones: [{ name: 'Delivery', amount: 100, dueDate: '2099-11-30' }],
        },
      )
      unregisterTendersWebContents(unregisteredSender)
      if (typeof proposalResult?.path === 'string') rmSync(proposalResult.path, { force: true })

      expect(wasEnrolledByPersistence).toBe(false)
      expect(proposalResult.ok).toBe(false)
      expect(proposalResult.path).toBeUndefined()
    })
  })

  describe('2. tenders:get-stored-data and tenders:save-stored-data Handlers', () => {
    it('getStoredData returns stored JSON from disk or null when absent', async () => {
      const getHandler = ipcHandlers.get(TENDERS_CHANNELS.getStoredData)
      expect(getHandler).toBeDefined()
      const sender = registeredWebContents()

      // Before file exists
      const initial = await getHandler!(event(sender))
      expect(initial).toBeNull()

      // After writing store file
      const storeFile = join(testDir, 'tenders', 'tenders-data.json')
      const data = migrateAndValidateTenders(null)
      data.workspaces[0].company.tradingName = 'Thabo Engineering IPC Test'
      writeTendersStore(storeFile, data)

      const retrieved = await getHandler!(event(sender))
      expect(retrieved).not.toBeNull()
      const parsed = JSON.parse(retrieved)
      expect(parsed.workspaces[0].company.tradingName).toBe('Thabo Engineering IPC Test')
    })

    it('saveStoredData persists payload atomically and broadcasts update', async () => {
      const saveHandler = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(saveHandler).toBeDefined()
      const sender = registeredWebContents()

      const dataToSave = migrateAndValidateTenders(null)
      dataToSave.workspaces[0].tenders[0].estimatedValue = 999000

      const result = await saveHandler!(event(sender), JSON.stringify(dataToSave))
      expect(result.ok).toBe(true)

      const storeFile = join(testDir, 'tenders', 'tenders-data.json')
      expect(existsSync(storeFile)).toBe(true)
      const onDisk = readTendersStore(storeFile)
      expect(onDisk.workspaces[0].tenders[0].estimatedValue).toBe(999000)
    })

    it('getStoredData rejects an unregistered caller with a typed failure and no read exposure', async () => {
      const getHandler = ipcHandlers.get(TENDERS_CHANNELS.getStoredData)
      expect(getHandler).toBeDefined()
      const unregisteredSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }

      // Seed an authoritative-looking legacy file that must not leak to the caller.
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const secretBytes = JSON.stringify({ version: 1, marker: 'must-not-be-read' }, null, 2)
      writeFileSync(storeFile, secretBytes, 'utf8')

      const result = await getHandler!(event(unregisteredSender as any))

      expect(typeof result).toBe('object')
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: expect.stringMatching(/authoriz|registered Tenders WebContents/i),
        },
      })
      expect(JSON.stringify(result)).not.toContain('must-not-be-read')
      expect(readFileSync(storeFile, 'utf8')).toBe(secretBytes)
    })

    it('saveStoredData rejects an unregistered caller with a typed failure and no write or broadcast', async () => {
      const saveHandler = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(saveHandler).toBeDefined()
      const unregisteredSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
      const payload = JSON.stringify(migrateAndValidateTenders(null))

      const result = await saveHandler!(event(unregisteredSender as any), payload)

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: expect.stringMatching(/authoriz|registered Tenders WebContents/i),
        },
      })
      expect(existsSync(storeFile)).toBe(false)
      expect(unregisteredSender.send).not.toHaveBeenCalled()
      expect(mockBroadcasts).toHaveLength(0)
    })
  })

  describe('2b. Phase 2 additive typed persistence IPC (RED)', () => {
    it('registers load/save v2 handlers and rejects unregistered senders with typed authorization failures and no effects', async () => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      expect(saveHandler).toBeDefined()
      const unregisteredSender: any = {
        isDestroyed: () => false,
        send: vi.fn(),
        once: vi.fn(),
      }

      const loadResult = await loadHandler!({ sender: unregisteredSender })
      const saveResult = await saveHandler!(
        { sender: unregisteredSender },
        {
          expectedRevision: 0,
          document: validV2(0),
        },
      )

      for (const result of [loadResult, saveResult]) {
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: expect.stringMatching(/authoriz|registered Tenders WebContents/i),
          },
        })
        expect(typeof result).toBe('object')
      }
      expect(existsSync(storeFile)).toBe(false)
      expect(unregisteredSender.send).not.toHaveBeenCalled()
      expect(getActiveTendersWebContents()).not.toContain(unregisteredSender)
      expect(mockBroadcasts).toHaveLength(0)
    })

    it('authorized load returns a genuinely empty not-found v2 revision zero without creating a file or demo data', async () => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      const sender = registeredWebContents()

      const result = await loadHandler!(event(sender))

      expect(result).toEqual({
        ok: true,
        status: 'not-found',
        data: {
          schemaVersion: 2,
          revision: 0,
          updatedAt: expect.any(String),
          activeCompanyId: null,
          workspaces: [],
          issuerTemplates: [],
        },
        needsSave: false,
        warnings: [],
      })
      expect(typeof result).toBe('object')
      expect(JSON.stringify(result.data)).not.toMatch(/co-thabo|tender-wtr-04|vd-tax|demo/i)
      expect(existsSync(storeFile)).toBe(false)
    })

    it('authorized load migrates a valid v1 file in memory at revision zero while preserving data and source bytes', async () => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      const sender = registeredWebContents()
      const input = validV1()
      const originalBytes = JSON.stringify(input, null, 2)
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, originalBytes, 'utf8')

      const result = await loadHandler!(event(sender))

      expect(result).toMatchObject({
        ok: true,
        status: 'migrated',
        needsSave: true,
        data: {
          schemaVersion: 2,
          revision: 0,
          activeCompanyId: input.activeCompanyId,
        },
      })
      expect(result.data.workspaces[0].company.tradingName).toBe('IPC migration marker')
      expect(result.data.workspaces[0].dataOrigin).toBeDefined()
      expect(readFileSync(storeFile, 'utf8')).toBe(originalBytes)
    })

    it('authorized load returns the exact revision and data from a valid v2 file', async () => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      const sender = registeredWebContents()
      const input = validV2(7)
      input.issuerTemplates.push({
        id: 'ipc-v2-issuer',
        name: 'IPC v2 issuer',
        displayName: 'IPC v2 issuer',
        address: null,
        contact: null,
        refStyle: null,
        submissionMethod: null,
        submissionAddress: null,
        seenCount: 1,
        lastSeen: '2026-09-01T08:30:00.000Z',
      })
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, JSON.stringify(input, null, 2), 'utf8')

      const result = await loadHandler!(event(sender))

      expect(result).toEqual({
        ok: true,
        status: 'loaded',
        data: input,
        needsSave: false,
        warnings: [],
      })
      expect(typeof result).toBe('object')
    })

    it('authorized save commits revision one on disk before broadcasting the exact typed document to sender and every registered view', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(saveHandler).toBeDefined()
      const deliveries: Array<{
        recipient: string
        channel: string
        data: unknown
        diskAtDelivery: unknown
      }> = []
      const makeReceiver = (recipient: string) =>
        registeredWebContents((channel, data) => {
          if (channel !== STORE_CHANGED_V2_CHANNEL) return
          deliveries.push({
            recipient,
            channel,
            data,
            diskAtDelivery: JSON.parse(readFileSync(storeFile, 'utf8')),
          })
        })
      const sender = makeReceiver('sender')
      makeReceiver('other-view')
      const requested = validV2(0)

      const result = await saveHandler!(event(sender), { expectedRevision: 0, document: requested })

      expect(result).toEqual({
        ok: true,
        data: {
          ...requested,
          revision: 1,
          updatedAt: expect.any(String),
        },
      })
      expect(typeof result).toBe('object')
      expect(typeof result.data).toBe('object')
      const disk = JSON.parse(readFileSync(storeFile, 'utf8'))
      expect(disk).toEqual(result.data)
      expect(deliveries).toHaveLength(2)
      expect(deliveries.map(({ recipient }) => recipient).sort()).toEqual(['other-view', 'sender'])
      for (const delivery of deliveries) {
        expect(delivery.channel).toBe(STORE_CHANGED_V2_CHANNEL)
        expect(delivery.data).toEqual(result.data)
        expect(typeof delivery.data).toBe('object')
        expect(delivery.diskAtDelivery).toEqual(result.data)
      }

      result.data.issuerTemplates.push({
        id: 'caller-mutation',
        name: 'Caller mutation',
        displayName: 'Caller mutation',
        address: null,
        contact: null,
        refStyle: null,
        submissionMethod: null,
        submissionAddress: null,
        seenCount: 0,
        lastSeen: '2026-09-01T08:30:00.000Z',
      })
      expect(JSON.parse(readFileSync(storeFile, 'utf8'))).toEqual(disk)
    })

    it('rejects stale saves with a compact typed snapshot and performs no write or broadcast', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(saveHandler).toBeDefined()
      const sends = vi.fn()
      const sender = registeredWebContents(sends)
      const current = validV2(4)
      const stale = validV2(3)
      const originalBytes = JSON.stringify(current, null, 2)
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      writeFileSync(storeFile, originalBytes, 'utf8')

      const result = await saveHandler!(event(sender), { expectedRevision: 3, document: stale })

      // Compact conflict payload: the error and the current revision only — the
      // full authoritative document never crosses IPC.
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'REVISION_CONFLICT' },
        currentRevision: current.revision,
      })
      expect(result).not.toHaveProperty('data')
      expect(result).not.toHaveProperty('current')
      expect(result.error).not.toHaveProperty('current')
      expect(JSON.stringify(result)).not.toContain('"workspaces"')
      expect(readFileSync(storeFile, 'utf8')).toBe(originalBytes)
      expect(sends).not.toHaveBeenCalledWith(STORE_CHANGED_V2_CHANNEL, expect.anything())
    })

    it.each([
      ['invalid', { ...validV2(0), activeCompanyId: 'missing-workspace' }, 'INVALID_DATA'],
      ['future', { ...validV2(0), schemaVersion: 99 }, 'UNSUPPORTED_SCHEMA_VERSION'],
    ])(
      'rejects %s data on load and save without writing or broadcasting',
      async (_label, document, code) => {
        const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
        const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
        expect(loadHandler).toBeDefined()
        expect(saveHandler).toBeDefined()
        const sends = vi.fn()
        const sender = registeredWebContents(sends)
        const originalBytes = JSON.stringify(document, null, 2)
        mkdirSync(join(testDir, 'tenders'), { recursive: true })
        writeFileSync(storeFile, originalBytes, 'utf8')

        const loadResult = await loadHandler!(event(sender))

        expect(loadResult).toMatchObject({ ok: false, error: { code } })
        expect(loadResult).not.toHaveProperty('data')
        expect(readFileSync(storeFile, 'utf8')).toBe(originalBytes)
        rmSync(storeFile, { force: true })

        const saveResult = await saveHandler!(event(sender), { expectedRevision: 0, document })

        expect(saveResult).toMatchObject({ ok: false, error: { code } })
        expect(saveResult).not.toHaveProperty('data')
        expect(existsSync(storeFile)).toBe(false)
        expect(sends).not.toHaveBeenCalledWith(STORE_CHANGED_V2_CHANNEL, expect.anything())
      },
    )

    it('allows a legacy v1/no-file compatibility save but rejects legacy overwrite after the primary file is v2', async () => {
      const legacySave = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(legacySave).toBeDefined()
      const legacyGet = ipcHandlers.get(TENDERS_CHANNELS.getStoredData)
      expect(legacyGet).toBeDefined()
      const sender = registeredWebContents()
      const inputV1 = validV1()

      const compatibilityResult = await legacySave!(event(sender), JSON.stringify(inputV1))

      expect(compatibilityResult).toMatchObject({ ok: true })
      expect(JSON.parse(readFileSync(storeFile, 'utf8')).version).toBe(1)

      const establishedV2 = validV2(12)
      const establishedBytes = JSON.stringify(establishedV2, null, 2)
      writeFileSync(storeFile, establishedBytes, 'utf8')
      await legacyGet!(event(sender))
      expect(readFileSync(storeFile, 'utf8')).toBe(establishedBytes)
      const downgrade = validV1()
      downgrade.workspaces[0].company.tradingName = 'Must never overwrite v2'

      const rejected = await legacySave!(event(sender), JSON.stringify(downgrade))

      expect(rejected.ok).toBe(false)
      expect(rejected.error).toBeDefined()
      expect(readFileSync(storeFile, 'utf8')).toBe(establishedBytes)
    })

    it.each([2, 3])(
      'legacy save refuses to overwrite an authoritative document with integer schemaVersion %i',
      async (schemaVersion) => {
        const legacySave = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
        expect(legacySave).toBeDefined()
        const sender = registeredWebContents()
        mkdirSync(join(testDir, 'tenders'), { recursive: true })
        const authoritative = { schemaVersion, revision: 9, marker: 'authoritative-bytes' }
        const authoritativeBytes = JSON.stringify(authoritative, null, 2)
        writeFileSync(storeFile, authoritativeBytes, 'utf8')

        const result = await legacySave!(event(sender), JSON.stringify(validV1()))

        expect(result.ok).toBe(false)
        expect(result.error).toBeDefined()
        expect(readFileSync(storeFile, 'utf8')).toBe(authoritativeBytes)
      },
    )

    it('keeps a durably committed save successful when a post-commit broadcast throws', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(saveHandler).toBeDefined()
      const sender = registeredWebContents((channel) => {
        if (channel === STORE_CHANGED_V2_CHANNEL) throw new Error('simulated broadcast failure')
      })

      const result = await saveHandler!(event(sender), {
        expectedRevision: 0,
        document: validV2(0),
      })

      expect(result.ok).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.data.revision).toBe(1)
      expect(JSON.parse(readFileSync(storeFile, 'utf8'))).toEqual(result.data)
      if (result.postCommitError !== undefined) {
        expect(result.postCommitError).toMatch(/simulated broadcast failure/)
      }
    })
  })

  describe('3. Managed Document Storage Handlers (save, read, open, delete)', () => {
    it('saveDocumentFile persists RFP and Vault buffers with sanitized timestamped filenames', async () => {
      const rfpBuffer = Buffer.from('Mock RFP document content')
      const rfpResult = await saveDocumentFile(
        {
          fileName: '../../malicious_name.pdf',
          buffer: rfpBuffer,
          category: 'rfp',
        },
        testDir,
      )

      expect(rfpResult.ok).toBe(true)
      expect(rfpResult.storedPath).toMatch(/^documents\/\d+_malicious_name\.pdf$/)

      const vaultBuffer = Buffer.from('Mock Vault certificate content')
      const vaultResult = await saveDocumentFile(
        {
          fileName: 'tax clearance certificate.pdf',
          buffer: vaultBuffer,
          category: 'vault',
        },
        testDir,
      )

      expect(vaultResult.ok).toBe(true)
      expect(vaultResult.storedPath).toMatch(/^vault\/\d+_tax_clearance_certificate\.pdf$/)

      // Confirm files physically exist on disk
      const fullRfp = join(
        getTendersDocumentsDir(testDir),
        rfpResult.storedPath!.replace('documents/', ''),
      )
      expect(existsSync(fullRfp)).toBe(true)
      expect(readFileSync(fullRfp, 'utf8')).toBe('Mock RFP document content')
    })

    it('readDocumentFile retrieves stored documents as valid ArrayBuffers', async () => {
      const saved = await saveDocumentFile(
        {
          fileName: 'sample.pdf',
          buffer: Buffer.from('Sample PDF binary stream'),
          category: 'rfp',
        },
        testDir,
      )

      const readResult = await readDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(readResult.ok).toBe(true)
      expect(readResult.buffer).toBeDefined()
      expect(readResult.buffer!.byteLength).toBeGreaterThan(0)
      expect(
        readResult.buffer instanceof ArrayBuffer ||
          (readResult.buffer as any)?.constructor?.name === 'ArrayBuffer',
      ).toBe(true)

      const text = Buffer.from(readResult.buffer!).toString('utf8')
      expect(text).toBe('Sample PDF binary stream')
    })

    it('openDocumentFile delegates safely to shell.openPath', async () => {
      const saved = await saveDocumentFile(
        {
          fileName: 'open-test.pdf',
          buffer: Buffer.from('Content to open'),
          category: 'vault',
        },
        testDir,
      )

      const openResult = await openDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(openResult.ok).toBe(true)
      expect(openedPaths.length).toBeGreaterThan(0)
      expect(openedPaths[0]).toContain('open-test.pdf')
    })

    it('deleteDocumentFile removes document from disk idempotently', async () => {
      const saved = await saveDocumentFile(
        {
          fileName: 'delete-me.pdf',
          buffer: Buffer.from('Content to delete'),
          category: 'rfp',
        },
        testDir,
      )

      const delResult1 = await deleteDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(delResult1.ok).toBe(true)

      // Subsequent delete of already deleted file is idempotent
      const delResult2 = await deleteDocumentFile({ storedPath: saved.storedPath! }, testDir)
      expect(delResult2.ok).toBe(true)
    })
  })

  describe('4. Path Traversal Security Validation (resolveSafeTendersPath)', () => {
    it('allows legitimate relative paths strictly within documents/ and vault/', () => {
      const docsCheck = resolveSafeTendersPath('documents/1234_sample.pdf', testDir)
      expect(docsCheck.safe).toBe(true)
      expect(docsCheck.fullPath).toContain('documents')

      const vaultCheck = resolveSafeTendersPath('vault/5678_certificate.pdf', testDir)
      expect(vaultCheck.safe).toBe(true)
      expect(vaultCheck.fullPath).toContain('vault')
    })

    it('strictly prevents escaping storage directories via directory traversal tokens', () => {
      const attacks = [
        '../../etc/passwd',
        '..\\..\\Windows\\System32\\cmd.exe',
        'documents/../../../secret.txt',
        'vault/../../tenders-data.json',
        'documents/../tenders-data.json',
        'documents/..',
        'vault/..',
        '/etc/shadow',
        'C:\\Windows\\System32\\notepad.exe',
        '\\\\server\\share\\file.pdf',
      ]

      for (const attack of attacks) {
        const check = resolveSafeTendersPath(attack, testDir)
        expect(check.safe, `Expected ${attack} to be rejected`).toBe(false)
        expect(check.error).toBe('Directory traversal detected')
      }
    })

    it('strictly prevents null byte injection attacks', () => {
      const check = resolveSafeTendersPath('documents/file.pdf\0.png', testDir)
      expect(check.safe).toBe(false)
      expect(check.error).toBe('Null byte detected in path')
    })
  })

  describe('5. Cross-App Handlers: CRM, Sheets, Docs, and Books', () => {
    it('syncWithCrm keeps the authoritative v2 document, increments revision once, and broadcasts it', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const recorder = deliveryRecorder()
      const sender = registeredWebContents(recorder.send)
      const storePath = join(testDir, 'tenders', 'tenders-data.json')
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(5)
      writeFileSync(storePath, JSON.stringify(starting, null, 2), 'utf8')
      const tender = starting.workspaces[0].tenders[0]
      const crmDealsPath = join(testDir, 'crm', 'deals.json')

      const result = await syncHandler!(event(sender), {
        tender,
        tenderId: tender.id,
        crmDealsPath,
        tendersPath: storePath,
        userDataDir: testDir,
      })

      expect(result.ok).toBe(true)
      expect(result.dealId).toBe(`deal-tender-${tender.id}`)

      // Verify deals.json written with the expected authoritative fields
      expect(existsSync(crmDealsPath)).toBe(true)
      const crmEnvelope = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
      const deal = crmEnvelope.deals.find((d: any) => d.id === `deal-tender-${tender.id}`)
      expect(deal).toBeDefined()
      expect(deal.tenderReference).toBe(tender.referenceNumber)
      expect(deal.amount).toBe(tender.estimatedValue)
      expect(deal.expectedCloseDate).toBe(tender.closingDate)

      // The persisted Tenders document must stay authoritative v2 at revision 6
      const disk = JSON.parse(readFileSync(storePath, 'utf8'))
      expect(disk.schemaVersion).toBe(2)
      expect(disk).not.toHaveProperty('version')
      expect(disk.revision).toBe(6)
      const backLinked = disk.workspaces[0].tenders.find((t: any) => t.id === tender.id)
      expect(backLinked.linkedCrmDealId).toBe(`deal-tender-${tender.id}`)

      const v2Deliveries = recorder.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL)
      expect(v2Deliveries).toHaveLength(1)
      expect(v2Deliveries[0].data).toEqual(disk)

      // Re-sync updates in place without downgrading the schema or duplicating the deal
      const resync = await syncHandler!(event(sender), {
        tender: { ...tender, estimatedValue: 300000 },
        tenderId: tender.id,
        crmDealsPath,
        tendersPath: storePath,
        userDataDir: testDir,
      })
      expect(resync.ok).toBe(true)
      const afterResync = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
      expect(
        afterResync.deals.filter((d: any) => d.id === `deal-tender-${tender.id}`),
      ).toHaveLength(1)
      expect(afterResync.deals[0].amount).toBe(300000)
      expect(JSON.parse(readFileSync(storePath, 'utf8')).schemaVersion).toBe(2)
    })

    it('syncWithCrm reports a conflict instead of silently overwriting a newer authoritative revision', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const recorder = deliveryRecorder()
      const sender = registeredWebContents(recorder.send)
      const storePath = join(testDir, 'tenders', 'tenders-data.json')
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const current = v2WithSeedTender(5)
      const currentBytes = JSON.stringify(current, null, 2)
      writeFileSync(storePath, currentBytes, 'utf8')
      const tender = current.workspaces[0].tenders[0]

      // The caller believes it is working from revision 4, but the authoritative
      // document is already at revision 5.
      const result = await syncHandler!(event(sender), {
        tender,
        tenderId: tender.id,
        expectedRevision: 4,
        crmDealsPath: join(testDir, 'crm', 'deals.json'),
        tendersPath: storePath,
        userDataDir: testDir,
      })

      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).toMatch(/conflict|revision/i)
      expect(readFileSync(storePath, 'utf8')).toBe(currentBytes)
      expect(
        recorder.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL),
      ).toHaveLength(0)
    })

    it('exportMatrixToSheets outputs strict RFC 4180 unspaced comma delimiter and UTF-8 BOM', async () => {
      const exportHandler = ipcHandlers.get(TENDERS_CHANNELS.exportMatrixToSheets)
      expect(exportHandler).toBeDefined()

      const generatedPaths: string[] = []
      configureTendersRuntime({
        preloadPath: '',
        rendererFile: '',
        openGeneratedPath: (p: string) => {
          generatedPaths.push(p)
          return true
        },
      })
      const exportSender = registeredWebContents()

      const rows = [
        {
          id: 'REQ-01',
          category: 'TAX_COMPLIANCE',
          title: 'SARS Tax Clearance Certificate (PIN)',
          isMandatory: true,
          status: 'FULFILLED',
          linkedVaultDocId: 'vd-tax',
          healthStatus: 'VALID',
          notes: 'Standard annual clearance, verified online',
        },
      ]

      const res = await exportHandler!(
        event(exportSender),
        't-01',
        'Bulk Water Refurbishment',
        rows,
      )
      expect(res.ok).toBe(true)
      expect(existsSync(res.path)).toBe(true)
      expect(generatedPaths).toContain(res.path)

      const raw = readFileSync(res.path)
      // Check UTF-8 BOM: 0xEF, 0xBB, 0xBF
      expect(raw[0]).toBe(0xef)
      expect(raw[1]).toBe(0xbb)
      expect(raw[2]).toBe(0xbf)

      const text = raw.toString('utf8')
      const lines = text.replace(/^\uFEFF/, '').split('\n')
      expect(lines[0]).toBe(
        'Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes',
      )
      expect(lines[1]).toContain('"REQ-01"')
      expect(lines[1]).toContain('"TAX COMPLIANCE"')
      expect(lines[1]).toContain('"Mandatory / Disqualifier"')
      expect(lines[1]).toContain('"vd-tax"')
    })

    it('draftProposalDoc generates markdown proposal and invokes tab navigation', async () => {
      const draftHandler = ipcHandlers.get(TENDERS_CHANNELS.draftProposalDoc)
      expect(draftHandler).toBeDefined()

      const registeredSender = registeredWebContents()

      const generatedPaths: string[] = []
      configureTendersRuntime({
        preloadPath: '',
        rendererFile: '',
        openGeneratedPath: (p: string) => {
          generatedPaths.push(p)
          return true
        },
      })

      const tender = {
        title: 'Bulk Water Refurbishment',
        referenceNumber: 'RFP-WTR-2026-04',
        issuingBody: 'City of Ekurhuleni',
        closingDate: '2026-10-31',
        estimatedValue: 243000,
        requirements: [],
        milestones: [{ name: 'Phase 1 Mobilization', amount: 145000, dueDate: '2026-08-30' }],
      }

      const res = await draftHandler!(event(registeredSender), tender)
      expect(res.ok).toBe(true)
      expect(existsSync(res.path)).toBe(true)
      expect(generatedPaths).toContain(res.path)

      const content = readFileSync(res.path, 'utf8')
      expect(content).toContain('Commercial & Technical Tender Proposal')
      expect(content).toContain('RFP-WTR-2026-04')
      expect(content).toContain('City of Ekurhuleni')
      expect(content).toContain('Phase 1 Mobilization')
    })

    it('billMilestoneInBooks validates REACHED status and keeps the authoritative v2 document at revision plus one', async () => {
      const billHandler = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
      expect(billHandler).toBeDefined()
      const recorder = deliveryRecorder()
      const sender = registeredWebContents(recorder.send)
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(7)
      // Billing is won-only (main mirrors shared/lifecycle `milestonesAllowed`).
      starting.workspaces[0].tenders[0].status = 'WON'
      writeFileSync(storeFile, JSON.stringify(starting, null, 2), 'utf8')

      // Milestone ms-02 is PENDING -> should be rejected without touching the revision
      const rejectPending = await billHandler!(event(sender), 'tender-wtr-04', 'ms-02')
      expect(rejectPending.ok).toBe(false)
      expect(rejectPending.error).toContain('not in REACHED status')
      expect(JSON.parse(readFileSync(storeFile, 'utf8')).revision).toBe(7)

      // Milestone ms-01 is REACHED -> should succeed and commit revision 8
      const billSuccess = await billHandler!(event(sender), 'tender-wtr-04', 'ms-01')
      expect(billSuccess.ok).toBe(true)
      expect(billSuccess.invoiceNumber).toMatch(/^INV-\d{4}-\d{3}$/)
      expect(billSuccess.grandTotal).toBe(145000)

      const disk = JSON.parse(readFileSync(storeFile, 'utf8'))
      expect(disk.schemaVersion).toBe(2)
      expect(disk).not.toHaveProperty('version')
      expect(disk.revision).toBe(8)
      const ms01 = disk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
      expect(ms01?.status).toBe('BILLED')
      expect(ms01?.billedInvoiceNumber).toBe(billSuccess.invoiceNumber)
      expect(ms01?.billedInvoiceId).toBe(billSuccess.invoiceId)

      const v2Deliveries = recorder.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL)
      expect(v2Deliveries).toHaveLength(1)
      expect(v2Deliveries[0].data).toEqual(disk)
    })

    it('billMilestoneInBooks reports a conflict instead of silently overwriting a newer authoritative revision', async () => {
      const billHandler = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
      expect(billHandler).toBeDefined()
      const recorder = deliveryRecorder()
      const sender = registeredWebContents(recorder.send)
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const current = v2WithSeedTender(7)
      current.workspaces[0].tenders[0].status = 'WON'
      const currentBytes = JSON.stringify(current, null, 2)
      writeFileSync(storeFile, currentBytes, 'utf8')

      const result = await billHandler(event(sender), {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        expectedRevision: 6,
      })

      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).toMatch(/conflict|revision/i)
      expect(readFileSync(storeFile, 'utf8')).toBe(currentBytes)
      expect(
        recorder.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL),
      ).toHaveLength(0)
    })
  })

  describe('6. Bridge remediation contract (cod-7 / sec-2)', () => {
    it('accepts a registered trusted top-frame sender for privileged v2 handlers', async () => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      const sender = registeredWebContents()

      const result = await loadHandler!(event(sender, trustedFrame()))

      expect(result).toMatchObject({ ok: true, status: 'not-found' })
    })

    it.each([
      { label: 'an untrusted top-frame URL', frame: untrustedFrame() },
      { label: 'a subframe sender', frame: subFrame() },
    ])('rejects a registered sender with $label', async ({ frame }) => {
      const loadHandler = ipcHandlers.get(LOAD_STORE_V2_CHANNEL)
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(loadHandler).toBeDefined()
      expect(saveHandler).toBeDefined()
      const sender = registeredWebContents()

      const loadResult = await loadHandler!(event(sender, frame))
      const saveResult = await saveHandler!(event(sender, frame), {
        expectedRevision: 0,
        document: validV2(0),
      })

      for (const result of [loadResult, saveResult]) {
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: expect.stringMatching(/authoriz|trusted|registered Tenders WebContents/i),
          },
        })
      }
      expect(existsSync(storeFile)).toBe(false)
    })

    it('broadcasts new v2 payloads only to registered views whose URL is the trusted renderer', async () => {
      const saveHandler = ipcHandlers.get(SAVE_STORE_V2_CHANNEL)
      expect(saveHandler).toBeDefined()
      const trusted = deliveryRecorder()
      const untrusted = deliveryRecorder()
      const trustedSender = registeredWebContents(trusted.send, TRUSTED_RENDERER_URL)
      registeredWebContents(untrusted.send, UNTRUSTED_RENDERER_URL)

      const result = await saveHandler!(event(trustedSender), {
        expectedRevision: 0,
        document: validV2(0),
      })

      expect(result.ok).toBe(true)
      const disk = JSON.parse(readFileSync(storeFile, 'utf8'))
      const trustedV2 = trusted.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL)
      expect(trustedV2).toHaveLength(1)
      expect(trustedV2[0].data).toEqual(disk)
      expect(
        untrusted.deliveries.filter((d) => d.channel === STORE_CHANGED_V2_CHANNEL),
      ).toHaveLength(0)
    })

    it('exposes a test-visible reset API that clears handlers and allows clean re-registration', async () => {
      const mod = (await import('../src/main/tenders-main')) as Record<string, unknown>
      const reset = mod.resetTendersIpcForTests
      const isRegistered = mod.isTendersIpcRegisteredForTests
      expect.soft(typeof reset).toBe('function')
      expect.soft(typeof isRegistered).toBe('function')
      if (typeof reset === 'function' && typeof isRegistered === 'function') {
        try {
          expect((isRegistered as () => boolean)()).toBe(true)
          ;(reset as () => void)()
          expect(removedHandlers.length).toBeGreaterThan(0)
          for (const channel of removedHandlers) {
            expect(ipcHandlers.has(channel)).toBe(false)
          }
          expect((isRegistered as () => boolean)()).toBe(false)
        } finally {
          registerTendersIpc()
        }
        expect((isRegistered as () => boolean)()).toBe(true)
        expect(ipcHandlers.has(TENDERS_CHANNELS.loadStoreV2)).toBe(true)
      }
    })
  })

  describe('7. Privileged bridge hardening (F1–F4)', () => {
    const privilegedCalls: Array<{ label: string; channel: string; args: unknown[] }> = [
      {
        label: 'saveDocument',
        channel: TENDERS_CHANNELS.saveDocument,
        args: [{ fileName: 'evil.pdf', buffer: Buffer.from('evil'), category: 'rfp' }],
      },
      {
        label: 'readDocument',
        channel: TENDERS_CHANNELS.readDocument,
        args: [{ storedPath: 'documents/1_evil.pdf' }],
      },
      {
        label: 'openDocument',
        channel: TENDERS_CHANNELS.openDocument,
        args: [{ storedPath: 'documents/1_evil.pdf' }],
      },
      {
        label: 'deleteDocument',
        channel: TENDERS_CHANNELS.deleteDocument,
        args: [{ storedPath: 'documents/1_evil.pdf' }],
      },
      { label: 'syncWithCrm', channel: TENDERS_CHANNELS.syncWithCrm, args: [{}] },
      {
        label: 'billMilestoneInBooks',
        channel: TENDERS_CHANNELS.billMilestoneInBooks,
        args: ['tender-wtr-04', 'ms-01'],
      },
      {
        label: 'exportMatrixToSheets',
        channel: TENDERS_CHANNELS.exportMatrixToSheets,
        args: ['t1', 'Title', []],
      },
      { label: 'openInCrm', channel: TENDERS_CHANNELS.openInCrm, args: ['deal-tender-x'] },
      { label: 'openBooks', channel: TENDERS_CHANNELS.openBooks, args: [] },
    ]

    it.each(privilegedCalls)(
      '$label rejects unregistered, untrusted-origin, and subframe callers with typed INVALID_REQUEST',
      async ({ channel, args }) => {
        const handler = ipcHandlers.get(channel)
        expect(handler, `${channel} must be registered`).toBeDefined()
        const unregisteredSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
        const untrustedSender = registeredWebContents(vi.fn(), UNTRUSTED_RENDERER_URL)
        const subframeSender = registeredWebContents(vi.fn())
        const attempts = [
          { label: 'unregistered', eventArg: event(unregisteredSender as any) },
          { label: 'untrusted-origin', eventArg: event(untrustedSender, untrustedFrame()) },
          { label: 'subframe', eventArg: event(subframeSender, subFrame()) },
        ]

        for (const attempt of attempts) {
          const result = await handler!(attempt.eventArg, ...args)
          expect.soft(result, `${channel} must reject ${attempt.label}`).toMatchObject({
            ok: false,
            error: { code: 'INVALID_REQUEST' },
          })
        }
      },
    )

    it('performs no document, export, or navigation side effects for rejected senders', async () => {
      const untrustedSender = registeredWebContents(vi.fn(), UNTRUSTED_RENDERER_URL)
      const generated: string[] = []
      let crmOpened = false
      let booksOpened = false
      configureTendersRuntime({
        preloadPath: '',
        rendererFile: '',
        openGeneratedPath: (p: string) => {
          generated.push(p)
          return true
        },
        onOpenCrm: () => {
          crmOpened = true
        },
        onOpenBooks: () => {
          booksOpened = true
        },
      })

      try {
        const rejectedFrame = untrustedFrame()
        const save = await ipcHandlers.get(TENDERS_CHANNELS.saveDocument)!(
          event(untrustedSender, rejectedFrame),
          { fileName: 'evil.pdf', buffer: Buffer.from('evil'), category: 'rfp' },
        )
        expect.soft(save).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
        const docsDir = getTendersDocumentsDir(testDir)
        expect.soft(existsSync(docsDir) ? readdirSync(docsDir).length : 0).toBe(0)

        const exported = await ipcHandlers.get(TENDERS_CHANNELS.exportMatrixToSheets)!(
          event(untrustedSender, rejectedFrame),
          't1',
          'Title',
          [],
        )
        expect.soft(exported).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
        expect.soft(generated).toHaveLength(0)

        const opened = await ipcHandlers.get(TENDERS_CHANNELS.openDocument)!(
          event(untrustedSender, rejectedFrame),
          { storedPath: 'documents/1_evil.pdf' },
        )
        expect.soft(opened).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
        expect.soft(openedPaths).toHaveLength(0)

        await ipcHandlers.get(TENDERS_CHANNELS.openInCrm)!(
          event(untrustedSender, rejectedFrame),
          'deal-x',
        )
        await ipcHandlers.get(TENDERS_CHANNELS.openBooks)!(event(untrustedSender, rejectedFrame))
        expect(crmOpened).toBe(false)
        expect(booksOpened).toBe(false)
      } finally {
        configureTendersRuntime({
          preloadPath: '',
          rendererFile: '',
          onOpenCrm: undefined,
          onOpenBooks: undefined,
          openGeneratedPath: undefined,
        })
      }
    })

    it('F2: syncWithCrm ignores renderer-supplied tendersPath, crmDealsPath, and userDataDir', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const sender = registeredWebContents()
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(5)
      writeFileSync(storeFile, JSON.stringify(starting, null, 2), 'utf8')
      const tender = starting.workspaces[0].tenders[0]
      const hostileDir = join(tmpdir(), `tenders-hostile-${randomUUID().slice(0, 8)}`)
      mkdirSync(hostileDir, { recursive: true })
      const hostileTendersPath = join(hostileDir, 'tenders-data.json')
      const hostileCrmPath = join(hostileDir, 'deals.json')

      try {
        const result = await syncHandler!(event(sender), {
          tender,
          tenderId: tender.id,
          tendersPath: hostileTendersPath,
          crmDealsPath: hostileCrmPath,
          userDataDir: hostileDir,
        })

        expect(result.ok).toBe(true)
        expect(existsSync(hostileCrmPath)).toBe(false)
        expect(existsSync(hostileTendersPath)).toBe(false)

        const disk = JSON.parse(readFileSync(storeFile, 'utf8'))
        expect(disk.schemaVersion).toBe(2)
        expect(disk.revision).toBe(6)
        expect(
          disk.workspaces[0].tenders.find((t: any) => t.id === tender.id).linkedCrmDealId,
        ).toBe(`deal-tender-${tender.id}`)

        expect(existsSync(join(testDir, 'crm', 'deals.json'))).toBe(true)
      } finally {
        rmSync(hostileDir, { recursive: true, force: true })
      }
    })

    it('F3: legacy saveStoredData broadcast skips untrusted registered views but reaches trusted views', async () => {
      const saveHandler = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(saveHandler).toBeDefined()
      const trusted = deliveryRecorder()
      const untrusted = deliveryRecorder()
      const sender = registeredWebContents(trusted.send, TRUSTED_RENDERER_URL)
      registeredWebContents(untrusted.send, UNTRUSTED_RENDERER_URL)

      const result = await saveHandler!(event(sender), JSON.stringify(validV1()))

      expect(result.ok).toBe(true)
      const trustedLegacy = trusted.deliveries.filter(
        (d) => d.channel === TENDERS_CHANNELS.dataChanged,
      )
      expect(trustedLegacy).toHaveLength(1)
      expect(trustedLegacy[0].data).toMatchObject({ version: 1 })
      expect(
        untrusted.deliveries.filter((d) => d.channel === TENDERS_CHANNELS.dataChanged),
      ).toHaveLength(0)
    })

    it('F3: the watcher/legacy broadcast function skips untrusted navigated views', () => {
      const trusted = deliveryRecorder()
      const untrusted = deliveryRecorder()
      registeredWebContents(trusted.send, TRUSTED_RENDERER_URL)
      registeredWebContents(untrusted.send, UNTRUSTED_RENDERER_URL)

      broadcastTendersData(migrateAndValidateTenders(null))

      expect(
        trusted.deliveries.filter((d) => d.channel === TENDERS_CHANNELS.dataChanged),
      ).toHaveLength(1)
      expect(
        untrusted.deliveries.filter((d) => d.channel === TENDERS_CHANNELS.dataChanged),
      ).toHaveLength(0)
    })

    it('F4: a conflicted milestone mutate posts no invoice and a retry posts at most one', async () => {
      const billHandler = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
      expect(billHandler).toBeDefined()
      const sender = registeredWebContents()
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const starting = v2WithSeedTender(7)
      // Billing is won-only (main mirrors shared/lifecycle `milestonesAllowed`).
      starting.workspaces[0].tenders[0].status = 'WON'
      writeFileSync(storeFile, JSON.stringify(starting, null, 2), 'utf8')
      const bytesBefore = readFileSync(storeFile, 'utf8')

      const conflict = await billHandler!(event(sender), {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        expectedRevision: 6,
      })

      expect.soft(conflict.ok).toBe(false)
      expect.soft(booksInvoiceCalls).toHaveLength(0)
      expect.soft(readFileSync(storeFile, 'utf8')).toBe(bytesBefore)

      const retry = await billHandler!(event(sender), {
        tenderId: 'tender-wtr-04',
        milestoneId: 'ms-01',
        expectedRevision: 7,
      })

      expect(retry.ok).toBe(true)
      expect(booksInvoiceCalls).toHaveLength(1)
      expect(JSON.parse(readFileSync(storeFile, 'utf8')).revision).toBe(8)
    })

    it('F5: syncWithCrm conflict returns a compact error, not the full authoritative document', async () => {
      const syncHandler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
      expect(syncHandler).toBeDefined()
      const sender = registeredWebContents()
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const current = v2WithSeedTender(5)
      writeFileSync(storeFile, JSON.stringify(current, null, 2), 'utf8')
      const tender = current.workspaces[0].tenders[0]

      const result = await syncHandler!(event(sender), {
        tender,
        tenderId: tender.id,
        expectedRevision: 4,
      })

      expect(result.ok).toBe(false)
      expect(result).not.toHaveProperty('current')
      expect(JSON.stringify(result)).not.toContain('"workspaces"')
      expect(JSON.stringify(result)).toMatch(/REVISION_CONFLICT|conflict|currentRevision/i)
    })

    it('medium: legacy downgrade guard rejects a non-integer authoritative schemaVersion', async () => {
      const legacySave = ipcHandlers.get(TENDERS_CHANNELS.saveStoredData)
      expect(legacySave).toBeDefined()
      const sender = registeredWebContents()
      mkdirSync(join(testDir, 'tenders'), { recursive: true })
      const authoritative = { schemaVersion: 2.5, revision: 9, marker: 'authoritative-bytes' }
      const authoritativeBytes = JSON.stringify(authoritative, null, 2)
      writeFileSync(storeFile, authoritativeBytes, 'utf8')

      const result = await legacySave!(event(sender), JSON.stringify(validV1()))

      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
      expect(readFileSync(storeFile, 'utf8')).toBe(authoritativeBytes)
    })
  })

  describe('WP-14 IPC, export and diagnostic hardening', () => {
    it('fails closed when the trusted renderer origin is unconfigured', async () => {
      configureTendersRuntime({ preloadPath: '', rendererUrl: '', rendererFile: '' })
      const sender = registeredWebContents()
      const delivered: string[] = []
      const receiver = {
        isDestroyed: () => false,
        getURL: () => TRUSTED_RENDERER_URL,
        once: vi.fn(),
        send: (channel: string) => delivered.push(channel),
      }
      registerTendersWebContents(receiver)

      const load = await ipcHandlers.get(LOAD_STORE_V2_CHANNEL)!(event(sender))
      expect(load).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

      const save = await ipcHandlers.get(TENDERS_CHANNELS.saveDocument)!(event(sender), {
        fileName: 'x.pdf',
        buffer: Buffer.from('%PDF-1.4'),
        category: 'rfp',
      })
      expect(save).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

      // Broadcasts fail closed too: no configured origin ⇒ no delivery, even to
      // a registered WebContents that reports a URL.
      broadcastTendersData(migrateAndValidateTenders(null))
      expect(delivered).not.toContain(TENDERS_CHANNELS.dataChanged)

      unregisterTendersWebContents(receiver)
    })

    it('bounds saveDocument uploads and rejects immediately over the limit', async () => {
      const saveDoc = ipcHandlers.get(TENDERS_CHANNELS.saveDocument)!
      const sender = registeredWebContents()
      const docsDir = getTendersDocumentsDir(testDir)
      const countDocs = () => (existsSync(docsDir) ? readdirSync(docsDir).length : 0)
      const before = countDocs()

      const over = await saveDoc(event(sender), {
        fileName: 'huge.pdf',
        buffer: Buffer.alloc(MAX_TENDERS_DOCUMENT_UPLOAD_BYTES + 1),
        category: 'vault',
      })
      expect(over.ok).toBe(false)
      expect(over.error).toMatch(/upload limit/i)
      // Rejected before any filesystem work.
      expect(countDocs()).toBe(before)

      const atLimit = await saveDoc(event(sender), {
        fileName: 'at-limit.pdf',
        buffer: Buffer.alloc(MAX_TENDERS_DOCUMENT_UPLOAD_BYTES),
        category: 'vault',
      })
      expect(atLimit.ok).toBe(true)
      expect(typeof atLimit.storedPath).toBe('string')
    })

    it('bounds readDocument so an oversized file is never streamed back', async () => {
      const readDoc = ipcHandlers.get(TENDERS_CHANNELS.readDocument)!
      const sender = registeredWebContents()
      const vaultDir = getTendersVaultDir(testDir)
      const oversize = join(vaultDir, 'oversize.pdf')
      writeFileSync(oversize, Buffer.alloc(MAX_TENDERS_DOCUMENT_UPLOAD_BYTES + 1))

      const res = await readDoc(event(sender), { storedPath: 'vault/oversize.pdf' })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/read limit/i)

      rmSync(oversize, { force: true })
    })

    it('neutralises formula-leading CSV cells while keeping RFC 4180 quoting and the BOM', async () => {
      const exportHandler = ipcHandlers.get(TENDERS_CHANNELS.exportMatrixToSheets)!
      const sender = registeredWebContents()

      const res = await exportHandler(event(sender), 't-1', 'Formula Export', [
        {
          id: '=CMD()',
          category: '@cat',
          title: '+SUM(A1)',
          status: '-1',
          linkedDocument: '\t=2+2',
          notes: '@import',
        },
      ])
      expect(res.ok).toBe(true)

      const raw = readFileSync(res.path)
      expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf])
      const row = raw
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .split('\n')[1]
      expect(row).toContain(`"'=CMD()"`)
      expect(row).toContain(`"'@cat"`)
      expect(row).toContain(`"'+SUM(A1)"`)
      expect(row).toContain(`"'-1"`)
      expect(row).toContain(`"'\t=2+2"`)
      expect(row).toContain(`"'@import"`)
      // No cell opens directly with a formula trigger character.
      expect(row).not.toMatch(/"(?:=|\+|@|-)/)
    })
  })
})

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testDir = join(tmpdir(), `tenders-migration-test-${randomUUID().slice(0, 8)}`)

const { mockHandlers, mockBroadcasts } = vi.hoisted(() => ({
  mockHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockBroadcasts: [] as Array<{ channel: string; data: unknown }>,
}))

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
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        mockHandlers.set(channel, listener)
      },
    },
    shell: {
      openPath: vi.fn(async () => ''),
    },
    WebContentsView: class MockWebContentsView {
      webContents = {
        isDestroyed: () => false,
        send: (channel: string, data: unknown) => {
          mockBroadcasts.push({ channel, data })
        },
        once: vi.fn(),
      }
    },
  }
})

import {
  atomicWriteDocumentFile,
  CURRENT_TENDERS_SCHEMA_VERSION,
  migrateAndValidateTenders,
  readTendersStore,
  SEED_COMPANY_ID,
  SEED_TENDER_WTR_04,
  writeTendersStore,
} from '../src/main/tenders-main'
import { MOCK_COMPANY } from '../src/renderer/src/mock/company'
import { MOCK_CUSTOMERS } from '../src/renderer/src/mock/customers'
import { MOCK_VAULT } from '../src/renderer/src/mock/vault'
import { useTendersStore } from '../src/renderer/src/store'

describe('Tenders Store Migrations & Atomic Persistence', () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    mockBroadcasts.length = 0
  })

  afterEach(() => {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    } catch {}
  })

  describe('1. migrateAndValidateTenders Schema Validation & Seeding', () => {
    it('initializes clean default seed envelope when input is null or undefined', () => {
      const data = migrateAndValidateTenders(null)
      expect(data.version).toBe(CURRENT_TENDERS_SCHEMA_VERSION)
      expect(data.activeCompanyId).toBe(SEED_COMPANY_ID)
      expect(data.workspaces).toHaveLength(1)

      const seedWs = data.workspaces[0]
      expect(seedWs.id).toBe(SEED_COMPANY_ID)
      expect(seedWs.company.name).toBe(MOCK_COMPANY.name)
      expect(seedWs.customers).toHaveLength(MOCK_CUSTOMERS.length)
      expect(seedWs.vault).toHaveLength(7)
      expect(seedWs.tenders).toHaveLength(1)
      expect(seedWs.tenders[0].id).toBe(SEED_TENDER_WTR_04.id)
      expect(seedWs.tenders[0].referenceNumber).toBe('RFP-WTR-2026-04')
      expect(seedWs.tenders[0].milestones).toHaveLength(2)
    })

    it('preserves all 7 compliance documents in MOCK_VAULT during migration', () => {
      const data = migrateAndValidateTenders({})
      const vault = data.workspaces[0].vault
      expect(vault).toHaveLength(7)

      const expectedDocIds = [
        'vd-tax',
        'vd-coida',
        'vd-bbbee',
        'vd-cipc',
        'vd-directors',
        'vd-sbd',
        'vd-csd',
      ]
      for (const expectedId of expectedDocIds) {
        const found = vault.find((d) => d.id === expectedId)
        expect(found, `Missing document ${expectedId}`).toBeDefined()
        expect(found?.title).toBeTruthy()
        expect(found?.category).toBeTruthy()
      }
    })

    it('migrates legacy workspace id ws-ekurhuleni-01 and comp-zano-01 to co-thabo', () => {
      const legacyRaw = {
        version: 1,
        activeCompanyId: 'comp-zano-01',
        workspaces: [
          {
            id: 'ws-ekurhuleni-01',
            company: { name: 'Thabo Engineering (Pty) Ltd' },
            customers: [],
            vault: [],
            tenders: [],
          },
        ],
      }

      const migrated = migrateAndValidateTenders(legacyRaw)
      expect(migrated.activeCompanyId).toBe(SEED_COMPANY_ID)
      expect(migrated.workspaces[0].id).toBe(SEED_COMPANY_ID)
      // Empty legacy lists should be seeded with defaults
      expect(migrated.workspaces[0].customers.length).toBeGreaterThan(0)
      expect(migrated.workspaces[0].vault).toHaveLength(7)
      expect(migrated.workspaces[0].tenders).toHaveLength(1)
    })

    it('preserves custom workspace data without overwriting with seed defaults', () => {
      const customRaw = {
        version: 1,
        activeCompanyId: 'co-custom-99',
        workspaces: [
          {
            id: 'co-custom-99',
            name: 'Custom Contractor CC',
            company: {
              ...MOCK_COMPANY,
              name: 'Custom Contractor CC',
            },
            customers: [
              {
                id: 'c-custom-1',
                name: 'Private Client',
                contactName: 'Jane Doe',
                contactEmail: 'jane@example.com',
                contactPhone: '0112223333',
                industry: 'Private',
                status: 'ACTIVE',
                since: '2025-01-01',
                notes: '',
                requiredDocs: [],
              },
            ],
            vault: [
              {
                id: 'vd-custom-1',
                title: 'Custom Electrical License',
                category: 'TECHNICAL',
                fileUrl: 'vault/license.pdf',
                issueDate: '2026-01-01',
                expiryDate: '2027-01-01',
                isCertified: false,
                certifiedDate: null,
                metadata: {},
              },
            ],
            tenders: [],
          },
        ],
      }

      const migrated = migrateAndValidateTenders(customRaw)
      expect(migrated.activeCompanyId).toBe('co-custom-99')
      expect(migrated.workspaces[0].id).toBe('co-custom-99')
      expect(migrated.workspaces[0].name).toBe('Custom Contractor CC')
      expect(migrated.workspaces[0].customers).toHaveLength(1)
      expect(migrated.workspaces[0].customers[0].id).toBe('c-custom-1')
      expect(migrated.workspaces[0].vault).toHaveLength(1)
      expect(migrated.workspaces[0].vault[0].id).toBe('vd-custom-1')
    })
  })

  describe('2. Atomic Write Persistence', () => {
    it('writeTendersStore atomically persists tenders-data.json and creates directories recursively', () => {
      const targetDir = join(testDir, 'subfolder', 'deep')
      const targetFile = join(targetDir, 'tenders-data.json')

      const initialData = migrateAndValidateTenders(null)
      initialData.workspaces[0].tenders[0].estimatedValue = 550000

      writeTendersStore(targetFile, initialData)

      expect(existsSync(targetFile)).toBe(true)
      const content = JSON.parse(readFileSync(targetFile, 'utf8'))
      expect(content.workspaces[0].tenders[0].estimatedValue).toBe(550000)
    })

    it('atomicWriteDocumentFile saves buffers safely using .tmp and atomic rename', () => {
      const docPath = join(testDir, 'documents', 'test-doc.pdf')
      const testBuffer = Buffer.from('%PDF-1.4 Mock document binary content for testing')

      atomicWriteDocumentFile(docPath, testBuffer)

      expect(existsSync(docPath)).toBe(true)
      const onDisk = readFileSync(docPath)
      expect(Buffer.compare(onDisk, testBuffer)).toBe(0)
    })
  })

  describe('3. Corrupted JSON Recovery and .corrupted.bak', () => {
    it('creates .corrupted.bak and returns safe fallback envelope on invalid JSON', () => {
      const storePath = join(testDir, 'tenders-data.json')
      const corruptContent = '{ "version": 1, "unclosed_json_syntax: true, [BAD DATA]'
      writeFileSync(storePath, corruptContent, 'utf8')

      const loaded = readTendersStore(storePath)
      expect(loaded).toBeDefined()
      expect(loaded.version).toBe(CURRENT_TENDERS_SCHEMA_VERSION)

      const bakPath = `${storePath}.corrupted.bak`
      expect(existsSync(bakPath)).toBe(true)
      const bakContent = readFileSync(bakPath, 'utf8')
      expect(bakContent).toBe(corruptContent)
    })

    it('returns default seed data when file does not exist', () => {
      const nonExistentPath = join(testDir, 'does-not-exist.json')
      const data = readTendersStore(nonExistentPath)
      expect(data.workspaces).toHaveLength(1)
      expect(data.workspaces[0].vault).toHaveLength(7)
    })
  })

  describe('4. Zustand Store Serialization & Rehydration (store.ts)', () => {
    it('partialize retains durable relative paths and strips transient blob: URLs', () => {
      const storeOptions = (useTendersStore as any).persist
      expect(storeOptions).toBeDefined()

      const partialize = storeOptions.getOptions().partialize
      expect(typeof partialize).toBe('function')

      const fakeState: any = {
        page: 'tenders',
        activeCompanyId: 'co-thabo',
        activeCustomerId: null,
        view: 'workspace',
        activeTenderId: 'tender-wtr-04',
        activeRequirementId: null,
        zoom: 1,
        currentPage: 1,
        issuerTemplates: [],
        onboardingDone: true,
        tourActive: true, // transient
        shredding: { stage: 'extracting', message: 'extracting', page: 1, total: 10 }, // transient
        workspaces: [
          {
            id: 'co-thabo',
            company: MOCK_COMPANY,
            customers: MOCK_CUSTOMERS,
            vault: [
              {
                id: 'vd-1',
                title: 'Durable Vault Doc',
                category: 'COMPLIANCE',
                fileUrl: 'vault/1788569533926_tax.pdf', // durable path
                issueDate: null,
                expiryDate: null,
                isCertified: false,
                certifiedDate: null,
                metadata: {},
              },
              {
                id: 'vd-2',
                title: 'Transient Session Vault Doc',
                category: 'COMPLIANCE',
                fileUrl: 'blob:http://localhost:5173/a1b2c3d4', // blob URL
                issueDate: null,
                expiryDate: null,
                isCertified: false,
                certifiedDate: null,
                metadata: {},
              },
            ],
            tenders: [
              {
                ...SEED_TENDER_WTR_04,
                id: 't-durable',
                fileUrl: 'documents/1788569533922_rfp.pdf', // durable path
              },
              {
                ...SEED_TENDER_WTR_04,
                id: 't-transient',
                fileUrl: 'blob:http://localhost:5173/e5f6g7h8', // blob URL
              },
            ],
          },
        ],
      }

      const partialized = partialize(fakeState)
      expect(partialized.workspaces).toHaveLength(1)
      const ws = partialized.workspaces[0]

      // Durable paths preserved
      expect(ws.vault.find((d: any) => d.id === 'vd-1').fileUrl).toBe('vault/1788569533926_tax.pdf')
      expect(ws.tenders.find((t: any) => t.id === 't-durable').fileUrl).toBe('documents/1788569533922_rfp.pdf')

      // Blob URLs blanked
      expect(ws.vault.find((d: any) => d.id === 'vd-2').fileUrl).toBeNull()
      expect(ws.tenders.find((t: any) => t.id === 't-transient').fileUrl).toBe('')
    })

    it('onRehydrateStorage restores default seed tender and clears transient UI state', () => {
      const storeOptions = (useTendersStore as any).persist
      const onRehydrateStorage = storeOptions.getOptions().onRehydrateStorage
      expect(typeof onRehydrateStorage).toBe('function')

      const onRehydrated = onRehydrateStorage()

      const stateToRehydrate: any = {
        activeCompanyId: 'co-thabo',
        workspaces: [
          {
            id: 'co-thabo',
            company: MOCK_COMPANY,
            customers: MOCK_CUSTOMERS,
            vault: [],
            tenders: [], // empty tenders array
          },
        ],
        shredding: { stage: 'done' },
        pendingFocus: { requirementId: 'req-1', token: 1 },
        tourActive: true,
      }

      onRehydrated(stateToRehydrate)

      // Empty tenders restored with default seed tender
      expect(stateToRehydrate.workspaces[0].tenders).toHaveLength(1)
      expect(stateToRehydrate.workspaces[0].tenders[0].id).toBe(SEED_TENDER_WTR_04.id)

      // Transient state cleared
      expect(stateToRehydrate.shredding).toBeNull()
      expect(stateToRehydrate.pendingFocus).toBeNull()
      expect(stateToRehydrate.tourActive).toBe(false)
    })
  })
})

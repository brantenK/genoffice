import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
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
import {
  createEmptyTendersDataV2,
  migrateTendersData,
  migrateTendersDataV1,
  TENDERS_SCHEMA_VERSION,
  validateTendersDataV2,
} from '../src/shared/tenders-schema'
import { parseClosingDate } from '../src/shared/readiness'
import type {
  CompanyProfile,
  Customer,
  IssuerTemplate,
  RequirementRecord,
  TenderRecord,
  TendersDataV1,
  TendersDataV2,
  TendersWorkspaceV2,
  VaultDoc,
} from '../src/shared/types'

const V1_UPDATED_AT = '2026-08-20T09:15:30.000Z'
const MIGRATED_AT = '2026-09-13T10:30:00.000Z'
const SECOND_MIGRATED_AT = '2027-01-02T03:04:05.000Z'

function syntheticCompany(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    name: 'Example Office Supplies (Pty) Ltd',
    tradingName: 'Example Office Supplies',
    registrationNumber: 'REG-EXAMPLE-001',
    vatNumber: 'VAT-EXAMPLE-001',
    taxPin: 'TAX-EXAMPLE-001',
    bbbeeLevel: 'Level 1',
    bbbeeBlackOwnership: '100%',
    csdSupplierNumber: 'CSD-EXAMPLE-001',
    founded: '2020',
    employees: '12',
    industry: 'Office supplies',
    description: 'Synthetic company profile used only for schema tests.',
    address: '1 Example Street, Test City',
    phone: '+27 10 000 0000',
    email: 'schema@example.test',
    website: 'https://example.test',
    directors: [
      {
        name: 'Example Director',
        role: 'Director',
        idNumber: 'TEST-ID-001',
      },
    ],
    projects: [
      {
        id: 'project-example-1',
        title: 'Synthetic delivery project',
        client: 'Example client',
        value: 'R 10 000',
        period: '2025',
        status: 'COMPLETED',
        description: 'Synthetic project used only for schema tests.',
        sector: 'Supplies',
      },
    ],
    ...overrides,
  }
}

function syntheticCustomer(id: string, name: string): Customer {
  return {
    id,
    name,
    contactName: 'Example Contact',
    contactEmail: `${id}@example.test`,
    contactPhone: '+27 10 000 0001',
    industry: 'Public sector',
    status: 'ACTIVE',
    since: '2025-01-01',
    notes: 'Synthetic schema fixture.',
    requiredDocs: [
      {
        docCategory: 'COMPLIANCE',
        label: 'Tax compliance evidence',
        fulfilled: true,
        linkedVaultDocId: 'vault-example-1',
      },
    ],
  }
}

function syntheticVaultDoc(id: string, title: string): VaultDoc {
  return {
    id,
    title,
    category: 'COMPLIANCE',
    fileUrl: `vault/${id}.pdf`,
    issueDate: '2026-01-01',
    expiryDate: '2027-01-01',
    isCertified: false,
    certifiedDate: null,
    metadata: {
      'arbitrary dynamic key': 'accepted value',
      'another-key': 'another value',
    },
  }
}

function syntheticRequirement(id: string, order: number): RequirementRecord {
  return {
    id,
    ruleKey: order === 1 ? 'tax_pin' : 'cipc',
    title: order === 1 ? 'Tax compliance evidence' : 'Company registration evidence',
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    verbatimClause: `Synthetic requirement ${order}`,
    pageNumber: order,
    boundingBox: { top: 0.1, left: 0.2, width: 0.7, height: 0.05 },
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order,
    confidence: 0.9,
    notes: `Requirement note ${order}`,
    status: 'FULFILLED',
    linkedVaultDocId: order === 1 ? 'vault-example-1' : 'vault-example-2',
    reason: null,
    suggestedVaultDocIds: [],
  }
}

function syntheticTender(overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: 'tender-example-1',
    title: 'Supply and Delivery of Office Computers',
    referenceNumber: 'ICT/EXAMPLE/001',
    issuingBody: 'Example Procurement Office',
    closingDate: '2026-12-18T12:00:00.000Z',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: 'https://example.test/tenders',
    signatureChecks: { declaration: true },
    status: 'IN_PROGRESS',
    createdAt: '2026-08-01T08:00:00.000Z',
    fileName: 'example-rfp.pdf',
    fileUrl: 'documents/example-rfp.pdf',
    numPages: 12,
    ocrPages: 1,
    requirements: [
      syntheticRequirement('requirement-example-1', 1),
      syntheticRequirement('requirement-example-2', 2),
    ],
    linkedCrmDealId: null,
    estimatedValue: 115_000,
    pricingConfirmed: true,
    milestones: [
      {
        id: 'milestone-example-1',
        name: 'Equipment delivery',
        title: 'Equipment delivery',
        description: 'Synthetic milestone one.',
        amount: 75_000,
        dueDate: '2027-01-15',
        status: 'PENDING',
      },
      {
        id: 'milestone-example-2',
        name: 'Acceptance',
        amount: 40_000,
        status: 'REACHED',
        completedDate: '2027-01-20',
        billedInvoiceId: 'invoice-example-1',
        billedInvoiceNumber: 'INV-EXAMPLE-001',
        billedAt: '2027-01-20T08:00:00.000Z',
        billedDate: '2027-01-20',
      },
    ],
    ...overrides,
  }
}

function syntheticIssuer(id: string, name: string): IssuerTemplate {
  return {
    id,
    name,
    displayName: name,
    address: null,
    contact: 'procurement@example.test',
    refStyle: 'ICT/YYYY/NNN',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: 'https://example.test/submit',
    seenCount: 2,
    lastSeen: '2026-08-20T09:15:30.000Z',
  }
}

function validV1(): TendersDataV1 {
  return {
    version: 1,
    updatedAt: V1_UPDATED_AT,
    activeCompanyId: 'workspace-example-1',
    workspaces: [
      {
        id: 'workspace-example-1',
        name: 'Example Office Supplies',
        company: syntheticCompany(),
        customers: [
          syntheticCustomer('customer-example-1', 'Example Customer One'),
          syntheticCustomer('customer-example-2', 'Example Customer Two'),
        ],
        vault: [
          syntheticVaultDoc('vault-example-1', 'Tax compliance certificate'),
          syntheticVaultDoc('vault-example-2', 'Company registration certificate'),
        ],
        tenders: [syntheticTender()],
      },
    ],
    issuerTemplates: [
      syntheticIssuer('issuer-example-1', 'Example Issuer One'),
      syntheticIssuer('issuer-example-2', 'Example Issuer Two'),
    ],
  }
}

function validV2(): TendersDataV2 {
  const source = validV1()
  return {
    schemaVersion: 2,
    revision: 0,
    updatedAt: source.updatedAt,
    activeCompanyId: source.activeCompanyId,
    workspaces: source.workspaces.map((workspace) => ({ ...workspace, dataOrigin: 'user' })),
    issuerTemplates: source.issuerTemplates,
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function reverseObjectKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, child]) => [key, reverseObjectKeyOrder(child)]),
    ) as T
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

/**
 * Frozen representation of the historical in-app demo domain. Recognition must
 * compare the complete domain snapshot, not merely these well-known IDs.
 */
const HISTORICAL_DEMO_V1 = deepFreeze<TendersDataV1>({
  version: 1,
  updatedAt: '2026-08-01T08:00:00.000Z',
  activeCompanyId: SEED_COMPANY_ID,
  workspaces: [
    {
      id: SEED_COMPANY_ID,
      name: 'Thabo Engineering (Pty) Ltd',
      company: clone(MOCK_COMPANY),
      customers: clone(MOCK_CUSTOMERS),
      vault: clone(MOCK_VAULT),
      tenders: [clone(SEED_TENDER_WTR_04)],
    },
  ],
  issuerTemplates: [],
})

type MigrationSuccess = {
  ok: true
  data: TendersDataV2
  sourceVersion: 1 | 2
  migrated: boolean
  warnings: string[]
}

function expectMigrationSuccess(result: unknown): asserts result is MigrationSuccess {
  expect(result).toMatchObject({ ok: true })
  if (!result || typeof result !== 'object' || !('data' in result)) {
    throw new Error('Expected a successful migration result with data')
  }
}

function expectValidationSuccess(
  result: unknown,
): asserts result is { ok: true; data: TendersDataV2 } {
  expect(result).toMatchObject({ ok: true })
  if (!result || typeof result !== 'object' || !('data' in result)) {
    throw new Error('Expected a successful validation result with data')
  }
}

function expectRejected(
  result: unknown,
  code: 'INVALID' | 'MISSING' | 'UNSUPPORTED' = 'INVALID',
  path?: RegExp,
): void {
  expect(result).toMatchObject({ ok: false, error: { code } })
  expect(result).not.toHaveProperty('data')
  if (path) {
    const issues = (result as { issues?: Array<{ path?: string }> }).issues ?? []
    expect(
      issues.some((issue) => path.test(issue.path ?? '')),
      `expected a path-addressed issue matching ${path}`,
    ).toBe(true)
  }
}

const LEGACY_VAULT_REFERENCE_REWRITTEN = 'LEGACY_VAULT_REFERENCE_REWRITTEN'

function expectLegacyVaultRewriteWarning(result: MigrationSuccess, path: string): void {
  expect(
    result.warnings.some(
      (warning) => warning.includes(LEGACY_VAULT_REFERENCE_REWRITTEN) && warning.includes(path),
    ),
    `expected ${LEGACY_VAULT_REFERENCE_REWRITTEN} warning for ${path}`,
  ).toBe(true)
}

type SchemaLane = {
  label: string
  make: () => any
  validate: (input: any) => unknown
}

const SCHEMA_LANES: SchemaLane[] = [
  {
    label: 'v1 migration',
    make: validV1,
    validate: (input) => migrateTendersDataV1(input, MIGRATED_AT),
  },
  {
    label: 'v2 validation',
    make: validV2,
    validate: validateTendersDataV2,
  },
]

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
    it('partialize persists UI preferences only and never domain payloads', () => {
      const storeOptions = (useTendersStore as any).persist
      expect(storeOptions).toBeDefined()

      const partialize = storeOptions.getOptions().partialize
      expect(typeof partialize).toBe('function')

      // Deliberately populated domain state: the old v1 behaviour serialized
      // these into localStorage, the v2 contract must not.
      const fakeState: any = {
        page: 'tenders',
        activeCompanyId: 'co-thabo',
        activeCustomerId: null,
        view: 'workspace',
        activeTenderId: 'tender-wtr-04',
        activeRequirementId: 'req-1',
        zoom: 1.25,
        currentPage: 4,
        issuerTemplates: [],
        onboardingDone: true,
        tourActive: true, // transient
        shredding: { stage: 'extracting', message: 'extracting', page: 1, total: 10 }, // transient
        workspaces: [
          {
            id: 'co-thabo',
            name: MOCK_COMPANY.name,
            dataOrigin: 'user',
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
            ],
          },
        ],
      }

      const partialized = partialize(fakeState)

      // New contract: ONLY the UI preference keys are persisted.
      expect(Object.keys(partialized).sort()).toEqual(
        [
          'activeRequirementId',
          'activeTenderId',
          'currentPage',
          'onboardingDone',
          'page',
          'view',
          'zoom',
        ].sort(),
      )
      expect(partialized).toEqual({
        page: 'tenders',
        view: 'workspace',
        zoom: 1.25,
        currentPage: 4,
        onboardingDone: true,
        activeTenderId: 'tender-wtr-04',
        activeRequirementId: 'req-1',
      })

      // Domain keys are absent even though the input state has them populated.
      for (const domainKey of ['workspaces', 'tenders', 'customers', 'vault']) {
        expect(partialized).not.toHaveProperty(domainKey)
      }
    })

    it('onRehydrateStorage clears transient UI state and injects no demo/seed data', () => {
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
            tenders: [], // empty tenders must stay empty
          },
          {
            id: 'co-empty',
            company: MOCK_COMPANY,
            customers: [],
            vault: [],
            // deliberately missing `tenders`
          },
        ],
        shredding: { stage: 'done' },
        pendingFocus: { requirementId: 'req-1', token: 1 },
        tourActive: true,
      }

      onRehydrated(stateToRehydrate)

      // No demo/seed tender is injected into any workspace.
      expect(stateToRehydrate.workspaces[0].tenders).toHaveLength(0)
      for (const ws of stateToRehydrate.workspaces) {
        expect(ws.tenders ?? []).toHaveLength(0)
      }
      const serialized = JSON.stringify(stateToRehydrate.workspaces)
      expect(serialized).not.toContain('tender-wtr-04')
      expect(serialized).not.toContain('RFP-WTR-2026-04')

      // Transient state cleared.
      expect(stateToRehydrate.shredding).toBeNull()
      expect(stateToRehydrate.pendingFocus).toBeNull()
      expect(stateToRehydrate.tourActive).toBe(false)
    })
  })
})

describe('Phase 2 pure persisted-schema v2 contract', () => {
  describe('v1 to v2 migration', () => {
    it('migrates a complete valid v1 document without changing domain content or order', () => {
      const input = validV1()
      const result = migrateTendersDataV1(input, MIGRATED_AT)

      expectMigrationSuccess(result)
      expect(result).toMatchObject({ sourceVersion: 1, migrated: true })
      expect(result.data.schemaVersion).toBe(TENDERS_SCHEMA_VERSION)
      expect(result.data.revision).toBe(0)
      expect(result.data.updatedAt).toBe(V1_UPDATED_AT)
      expect(result.data.activeCompanyId).toBe(input.activeCompanyId)
      expect(result.data.issuerTemplates).toEqual(input.issuerTemplates)
      expect(result.data.workspaces).toHaveLength(input.workspaces.length)

      const { dataOrigin, ...migratedWorkspace } = result.data.workspaces[0]
      expect(dataOrigin).toBe('user')
      expect(migratedWorkspace).toEqual(input.workspaces[0])
      expect(result.data.workspaces[0].customers.map((customer) => customer.id)).toEqual([
        'customer-example-1',
        'customer-example-2',
      ])
      expect(result.data.workspaces[0].tenders[0].requirements.map((item) => item.id)).toEqual([
        'requirement-example-1',
        'requirement-example-2',
      ])
      expect(result.data.issuerTemplates.map((issuer) => issuer.id)).toEqual([
        'issuer-example-1',
        'issuer-example-2',
      ])

      const v2Validation = validateTendersDataV2(result.data)
      expectValidationSuccess(v2Validation)
      expect(v2Validation.data).toEqual(result.data)
    })

    it('migrates an empty v1 envelope to a genuinely empty v2 document', () => {
      const input: TendersDataV1 = {
        version: 1,
        updatedAt: V1_UPDATED_AT,
        activeCompanyId: '',
        workspaces: [],
        issuerTemplates: [],
      }

      const result = migrateTendersDataV1(input, MIGRATED_AT)

      expectMigrationSuccess(result)
      expect(result).toMatchObject({ sourceVersion: 1, migrated: true })
      expect(result.data).toEqual({
        schemaVersion: 2,
        revision: 0,
        updatedAt: V1_UPDATED_AT,
        activeCompanyId: null,
        workspaces: [],
        issuerTemplates: [],
      })
      expect(JSON.stringify(result.data)).not.toMatch(/co-thabo|tender-wtr-04|vd-tax|c-1/)
    })

    it('preserves intentionally empty nested arrays on a custom workspace and marks it user data', () => {
      const input: TendersDataV1 = {
        version: 1,
        updatedAt: V1_UPDATED_AT,
        activeCompanyId: 'workspace-empty-custom',
        workspaces: [
          {
            id: 'workspace-empty-custom',
            name: 'Empty Custom Workspace',
            company: syntheticCompany({ name: 'Empty Custom Workspace' }),
            customers: [],
            vault: [],
            tenders: [],
          },
        ],
        issuerTemplates: [],
      }

      const result = migrateTendersDataV1(input, MIGRATED_AT)

      expectMigrationSuccess(result)
      expect(result.data.workspaces[0]).toMatchObject({
        id: 'workspace-empty-custom',
        dataOrigin: 'user',
        customers: [],
        vault: [],
        tenders: [],
      })
    })

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not a date', 'not-a-date'],
      ['calendar-invalid', '2026-02-30T10:00:00.000Z'],
    ])('uses injected migratedAt only when legacy updatedAt is %s', (_label, updatedAt) => {
      const input = validV1() as TendersDataV1 & { updatedAt?: string }
      if (updatedAt === undefined) delete input.updatedAt
      else input.updatedAt = updatedAt

      const result = migrateTendersDataV1(input as TendersDataV1, MIGRATED_AT)

      expectMigrationSuccess(result)
      expect(result.data.updatedAt).toBe(MIGRATED_AT)
    })

    it('does not mutate a deeply frozen v1 input', () => {
      const input = deepFreeze(validV1())
      const before = clone(input)

      const result = migrateTendersDataV1(input, MIGRATED_AT)

      expectMigrationSuccess(result)
      expect(input).toEqual(before)
      expect(Object.isFrozen(input)).toBe(true)
      expect(Object.isFrozen(input.workspaces[0].tenders[0].requirements)).toBe(true)
    })

    it('is idempotent after v1 migration and does not retimestamp valid v2 data', () => {
      const first = migrateTendersData(validV1(), MIGRATED_AT)
      expectMigrationSuccess(first)

      const second = migrateTendersData(first.data, SECOND_MIGRATED_AT)
      expectMigrationSuccess(second)

      expect(second).toMatchObject({ sourceVersion: 2, migrated: false })
      expect(second.data).toEqual(first.data)
      expect(second.data.updatedAt).toBe(V1_UPDATED_AT)
    })

    it('classifies only the exact frozen historical demo domain as demo data', () => {
      const fixtureDigest = createHash('sha256')
        .update(JSON.stringify(HISTORICAL_DEMO_V1))
        .digest('hex')
      expect(fixtureDigest).toBe('51be177ccbf139d6741e1e0d08a6645d768063fa0ecfcace7768c212735c09aa')

      const exact = migrateTendersDataV1(HISTORICAL_DEMO_V1, MIGRATED_AT)
      expectMigrationSuccess(exact)
      expect(exact.data.workspaces[0].dataOrigin).toBe('demo')

      const edited = clone(HISTORICAL_DEMO_V1)
      edited.workspaces[0].tenders[0].title = `${edited.workspaces[0].tenders[0].title} — edited`
      const editedResult = migrateTendersDataV1(edited, MIGRATED_AT)
      expectMigrationSuccess(editedResult)
      expect(editedResult.data.workspaces[0].dataOrigin).toBe('user')

      const custom = migrateTendersDataV1(validV1(), MIGRATED_AT)
      expectMigrationSuccess(custom)
      expect(custom.data.workspaces[0].dataOrigin).toBe('user')
    })

    it('classifies the exact historical demo as demo regardless of object key insertion order', () => {
      const reordered = reverseObjectKeyOrder(clone(HISTORICAL_DEMO_V1))
      expect(reordered).toEqual(HISTORICAL_DEMO_V1)
      expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(HISTORICAL_DEMO_V1))

      const result = migrateTendersDataV1(reordered, MIGRATED_AT)

      expectMigrationSuccess(result)
      expect(result.data.workspaces[0].dataOrigin).toBe('demo')
    })

    it.each([
      [
        'top-level timestamp',
        (input: TendersDataV1) => {
          input.updatedAt = '2026-08-01T08:00:01.000Z'
        },
      ],
      [
        'workspace name',
        (input: TendersDataV1) => {
          input.workspaces[0].name = `${input.workspaces[0].name} edited`
        },
      ],
      [
        'customer notes',
        (input: TendersDataV1) => {
          input.workspaces[0].customers[0].notes += ' edited'
        },
      ],
      [
        'vault metadata value',
        (input: TendersDataV1) => {
          input.workspaces[0].vault[0].metadata.__classificationProbe = 'edited'
        },
      ],
    ])(
      'classifies the historical demo as user data after any %s content change',
      (_label, mutate) => {
        const edited = clone(HISTORICAL_DEMO_V1)
        mutate(edited)

        const result = migrateTendersDataV1(edited, MIGRATED_AT)

        expectMigrationSuccess(result)
        expect(result.data.workspaces[0].dataOrigin).toBe('user')
      },
    )

    it.each([
      [
        'requirement ID',
        (input: TendersDataV1) => {
          input.workspaces[0].tenders[0].requirements.push(
            clone(input.workspaces[0].tenders[0].requirements[0]),
          )
        },
        /requirements.*2.*id/,
      ],
      [
        'milestone ID',
        (input: TendersDataV1) => {
          input.workspaces[0].tenders[0].milestones!.push(
            clone(input.workspaces[0].tenders[0].milestones![0]),
          )
        },
        /milestones.*2.*id/,
      ],
      [
        'company project ID',
        (input: TendersDataV1) => {
          input.workspaces[0].company.projects.push(clone(input.workspaces[0].company.projects[0]))
        },
        /company.*projects.*1.*id/,
      ],
    ] as Array<[string, (input: TendersDataV1) => void, RegExp]>)(
      'rejects a duplicate v1 %s',
      (_label, mutate, path) => {
        const input = validV1()
        mutate(input)

        expectRejected(migrateTendersDataV1(input, MIGRATED_AT), 'INVALID', path)
      },
    )

    it.each([
      ['blank', ''],
      ['unknown', 'workspace-does-not-exist'],
    ])('rejects a nonempty v1 document with a %s activeCompanyId', (_label, activeCompanyId) => {
      const input = validV1()
      input.activeCompanyId = activeCompanyId

      expectRejected(migrateTendersDataV1(input, MIGRATED_AT), 'INVALID', /activeCompanyId/)
    })

    it('preserves nullable and omitted optional values without inventing fields', () => {
      const input = validV1()
      const tender = input.workspaces[0].tenders[0]
      tender.referenceNumber = null
      tender.issuingBody = null
      tender.submissionMethod = null
      tender.submissionAddress = null
      tender.linkedCrmDealId = null
      tender.estimatedValue = null
      delete tender.pricingConfirmed
      delete tender.milestones
      delete input.workspaces[0].name

      const result = migrateTendersDataV1(input, MIGRATED_AT)

      expectMigrationSuccess(result)
      const migratedTender = result.data.workspaces[0].tenders[0]
      expect(migratedTender.referenceNumber).toBeNull()
      expect(migratedTender.issuingBody).toBeNull()
      expect(migratedTender.submissionMethod).toBeNull()
      expect(migratedTender.submissionAddress).toBeNull()
      expect(migratedTender.linkedCrmDealId).toBeNull()
      expect(migratedTender.estimatedValue).toBeNull()
      expect(migratedTender).not.toHaveProperty('pricingConfirmed')
      expect(migratedTender).not.toHaveProperty('milestones')
      expect(result.data.workspaces[0]).not.toHaveProperty('name')
    })

    it.each([
      {
        label: 'VaultDoc.metadata',
        entries: [
          ['__proto__', 'metadata proto value'],
          ['constructor', 'metadata constructor value'],
          ['prototype', 'metadata prototype value'],
        ] as const,
        install(input: TendersDataV1, record: Record<string, string | boolean>) {
          input.workspaces[0].vault[0].metadata = record as Record<string, string>
        },
        select(data: TendersDataV2) {
          return data.workspaces[0].vault[0].metadata
        },
      },
      {
        label: 'TenderRecord.signatureChecks',
        entries: [
          ['__proto__', true],
          ['constructor', false],
          ['prototype', true],
        ] as const,
        install(input: TendersDataV1, record: Record<string, string | boolean>) {
          input.workspaces[0].tenders[0].signatureChecks = record as Record<string, boolean>
        },
        select(data: TendersDataV2) {
          return data.workspaces[0].tenders[0].signatureChecks
        },
      },
    ])(
      'preserves prototype-named own keys in $label through migration and v2 validation',
      ({ entries, install, select }) => {
        const input = validV1()
        const dynamicRecord = Object.fromEntries(entries) as Record<string, string | boolean>
        install(input, dynamicRecord)

        expect(Object.getPrototypeOf(dynamicRecord)).toBe(Object.prototype)
        for (const [key, value] of entries) {
          expect(Object.hasOwn(dynamicRecord, key)).toBe(true)
          expect(dynamicRecord[key]).toBe(value)
        }

        const migration = migrateTendersDataV1(input, MIGRATED_AT)
        expectMigrationSuccess(migration)

        const validation = validateTendersDataV2(migration.data)
        expectValidationSuccess(validation)

        const migratedRecord = select(validation.data)
        expect(Object.getPrototypeOf(migratedRecord)).toBe(Object.prototype)
        for (const [key, value] of entries) {
          expect(Object.hasOwn(migratedRecord, key)).toBe(true)
          expect(migratedRecord[key]).toBe(value)
        }
        expect(Object.getPrototypeOf({})).toBe(Object.prototype)
      },
    )
  })

  describe('empty creation and migration dispatch rejection', () => {
    it('creates a deterministic empty v2 document without demo content', () => {
      const data = createEmptyTendersDataV2(MIGRATED_AT)

      expect(data).toEqual({
        schemaVersion: 2,
        revision: 0,
        updatedAt: MIGRATED_AT,
        activeCompanyId: null,
        workspaces: [],
        issuerTemplates: [],
      })
      expectValidationSuccess(validateTendersDataV2(data))
    })

    it.each([
      ['malformed string', 'invalid'],
      ['impossible RFC3339 date', '2026-02-30T10:00:00.000Z'],
      ['invalid Date object', new Date(Number.NaN)],
    ])('deterministically throws for an explicit %s creation timestamp', (_label, timestamp) => {
      expect(() => createEmptyTendersDataV2(timestamp)).toThrow()
    })

    it.each([
      [
        'year 0000',
        (() => {
          const value = new Date(0)
          value.setUTCFullYear(0)
          return value
        })(),
        /^0000-/,
      ],
      [
        'extended year',
        (() => {
          const value = new Date(0)
          value.setUTCFullYear(10_000)
          return value
        })(),
        /^\+\d{6}-/,
      ],
    ])(
      'rejects a valid JS Date whose ISO serialization uses unsupported %s syntax',
      (_label, timestamp, unsupportedSyntax) => {
        expect(Number.isNaN(timestamp.getTime())).toBe(false)
        expect(timestamp.toISOString()).toMatch(unsupportedSyntax)
        expect(() => createEmptyTendersDataV2(timestamp)).toThrow()
      },
    )

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['string', 'not a tenders document'],
      ['boolean', false],
      ['array', []],
      ['empty object', {}],
    ])('rejects %s input without returning seeded or partial data', (_label, input) => {
      const result = migrateTendersData(input, MIGRATED_AT)

      expectRejected(result)
      expect(JSON.stringify(result)).not.toMatch(/co-thabo|tender-wtr-04|vd-tax|c-1/)
    })

    it.each([
      ['future legacy version', { ...validV1(), version: 3 }],
      ['future v2-style schemaVersion', { ...validV2(), schemaVersion: 3 }],
    ])('rejects a %s as unsupported rather than coercing it', (_label, input) => {
      const result = migrateTendersData(input, MIGRATED_AT)

      expectRejected(result, 'UNSUPPORTED')
    })
  })

  describe('same-workspace vault reference integrity', () => {
    const addForeignVaultDocument = (input: any): string => {
      const foreignWorkspace = clone(input.workspaces[0])
      foreignWorkspace.id = 'workspace-example-foreign'
      foreignWorkspace.name = 'Foreign Workspace'
      const foreignId = 'vault-foreign-only'
      foreignWorkspace.vault.push(syntheticVaultDoc(foreignId, 'Foreign workspace document'))
      input.workspaces.push(foreignWorkspace)
      return foreignId
    }

    const unresolvedReferenceCases: Array<
      [string, (input: any, foreignId: string) => void, RegExp]
    > = [
      [
        'CustomerDoc.linkedVaultDocId',
        (input, foreignId) => {
          input.workspaces[0].customers[0].requiredDocs[0].linkedVaultDocId = foreignId
        },
        /customers.*0.*requiredDocs.*0.*linkedVaultDocId/,
      ],
      [
        'RequirementRecord.linkedVaultDocId',
        (input, foreignId) => {
          input.workspaces[0].tenders[0].requirements[0].linkedVaultDocId = foreignId
        },
        /requirements.*0.*linkedVaultDocId/,
      ],
      [
        'RequirementRecord.suggestedVaultDocIds entry',
        (input, foreignId) => {
          input.workspaces[0].tenders[0].requirements[0].suggestedVaultDocIds = [
            'vault-example-1',
            foreignId,
          ]
        },
        /requirements.*0.*suggestedVaultDocIds.*1/,
      ],
    ]

    it.each(
      SCHEMA_LANES.flatMap((lane) =>
        unresolvedReferenceCases.map(
          ([field, mutate, path]) =>
            [
              `${lane.label} rejects a cross-workspace-only ${field} reference`,
              lane,
              mutate,
              path,
            ] as const,
        ),
      ),
    )('%s', (_name, lane, mutate, path) => {
      const input = lane.make()
      const foreignId = addForeignVaultDocument(input)
      mutate(input, foreignId)

      expectRejected(lane.validate(input), 'INVALID', path)
    })

    it.each(SCHEMA_LANES)(
      '$label accepts all resolvable same-workspace vault references',
      (lane) => {
        const input = lane.make()
        input.workspaces[0].customers[0].requiredDocs[0].linkedVaultDocId = 'vault-example-2'
        input.workspaces[0].tenders[0].requirements[0].linkedVaultDocId = 'vault-example-1'
        input.workspaces[0].tenders[0].requirements[0].suggestedVaultDocIds = [
          'vault-example-1',
          'vault-example-2',
        ]

        const result = lane.validate(input)
        expectMigrationSuccess(result)
      },
    )

    const legacyAliasReferenceCases: Array<[string, (input: any, alias: string) => void, string]> =
      [
        [
          'CustomerDoc.linkedVaultDocId',
          (input, alias) => {
            input.workspaces[0].customers[0].requiredDocs[0].linkedVaultDocId = alias
          },
          'workspaces.0.customers.0.requiredDocs.0.linkedVaultDocId',
        ],
        [
          'RequirementRecord.linkedVaultDocId',
          (input, alias) => {
            input.workspaces[0].tenders[0].requirements[0].linkedVaultDocId = alias
          },
          'workspaces.0.tenders.0.requirements.0.linkedVaultDocId',
        ],
        [
          'RequirementRecord.suggestedVaultDocIds entry',
          (input, alias) => {
            input.workspaces[0].tenders[0].requirements[0].suggestedVaultDocIds = [alias]
          },
          'workspaces.0.tenders.0.requirements.0.suggestedVaultDocIds.0',
        ],
      ]

    const spacedVaultId = 'tax compliance'
    const hyphenatedVaultAlias = 'tax-compliance'
    const makeSpacedIdV2 = (): TendersDataV2 => {
      const input = validV2()
      const workspace = input.workspaces[0]
      workspace.vault[0].id = spacedVaultId
      workspace.vault[0].fileUrl = 'vault/archive/tax-compliance.pdf'
      for (const customer of workspace.customers) {
        customer.requiredDocs[0].linkedVaultDocId = spacedVaultId
      }
      workspace.tenders[0].requirements[0].linkedVaultDocId = spacedVaultId
      return input
    }

    const makeExactIdOnlyV2 = (reference: string): TendersDataV2 => {
      const input = validV2()
      const workspace = input.workspaces[0]
      const exactVaultId = 'vault example 1'
      const document = syntheticVaultDoc(exactVaultId, 'Exact ID regression document')
      document.fileUrl = 'vault/archive/vault-example-1.pdf'
      workspace.vault = [document]

      for (const customer of workspace.customers) {
        for (const requiredDoc of customer.requiredDocs) {
          requiredDoc.linkedVaultDocId = reference
        }
      }
      for (const tender of workspace.tenders) {
        for (const requirement of tender.requirements) {
          requirement.linkedVaultDocId = reference
          requirement.suggestedVaultDocIds = [reference]
        }
      }

      return input
    }

    it('v2 rejects a file-stem alias when every vault reference misses the exact spaced ID', () => {
      const input = makeExactIdOnlyV2('vault-example-1')

      expectRejected(
        validateTendersDataV2(input),
        'INVALID',
        /workspaces.*0.*customers.*0.*requiredDocs.*0.*linkedVaultDocId/,
      )
    })

    it('v2 accepts the exact spaced VaultDoc ID in every customer, requirement, and suggested reference', () => {
      const exactVaultId = 'vault example 1'
      const input = makeExactIdOnlyV2(exactVaultId)

      const result = validateTendersDataV2(input)

      expectValidationSuccess(result)
      const workspace = result.data.workspaces[0]
      const references = [
        ...workspace.customers.flatMap((customer) =>
          customer.requiredDocs.map((requiredDoc) => requiredDoc.linkedVaultDocId),
        ),
        ...workspace.tenders.flatMap((tender) =>
          tender.requirements.flatMap((requirement) => [
            requirement.linkedVaultDocId,
            ...requirement.suggestedVaultDocIds,
          ]),
        ),
      ]
      expect(references).not.toHaveLength(0)
      expect(references.every((reference) => reference === exactVaultId)).toBe(true)
    })

    it('v2 multi-document workspaces reject every file-stem alias while accepting the exact spaced VaultDoc ID', () => {
      const exactVaultId = 'vault example 1'
      const fileStemAlias = 'vault-example-1'
      const input = validV2()
      const workspace = input.workspaces[0]
      workspace.vault[0].id = exactVaultId
      workspace.vault[0].fileUrl = 'vault/archive/vault-example-1.pdf'
      expect(workspace.vault.length).toBeGreaterThanOrEqual(2)

      const installEveryReference = (data: TendersDataV2, reference: string): string[] => {
        const paths: string[] = []
        const targetWorkspace = data.workspaces[0]
        targetWorkspace.customers.forEach((customer, customerIndex) => {
          customer.requiredDocs.forEach((requiredDoc, requiredDocIndex) => {
            requiredDoc.linkedVaultDocId = reference
            paths.push(
              `workspaces.0.customers.${customerIndex}.requiredDocs.${requiredDocIndex}.linkedVaultDocId`,
            )
          })
        })
        targetWorkspace.tenders.forEach((tender, tenderIndex) => {
          tender.requirements.forEach((requirement, requirementIndex) => {
            const requirementPath = `workspaces.0.tenders.${tenderIndex}.requirements.${requirementIndex}`
            requirement.linkedVaultDocId = reference
            requirement.suggestedVaultDocIds = [reference]
            paths.push(
              `${requirementPath}.linkedVaultDocId`,
              `${requirementPath}.suggestedVaultDocIds.0`,
            )
          })
        })
        return paths
      }

      const expectedAliasPaths = installEveryReference(input, fileStemAlias)
      const aliasResult = validateTendersDataV2(input)

      expectRejected(aliasResult)
      const rejectedPaths = (aliasResult as { issues: Array<{ path: string }> }).issues.map(
        (issue) => issue.path,
      )
      expect(rejectedPaths).toEqual(expect.arrayContaining(expectedAliasPaths))
      expect(rejectedPaths).toHaveLength(expectedAliasPaths.length)

      const exactInput = clone(input)
      installEveryReference(exactInput, exactVaultId)
      expectValidationSuccess(validateTendersDataV2(exactInput))
    })

    it.each(legacyAliasReferenceCases)(
      'v2 rejects hyphenated file stem alias tax-compliance for %s when the exact ID is tax compliance',
      (_field, install, path) => {
        const input = makeSpacedIdV2()
        install(input, hyphenatedVaultAlias)

        expectRejected(validateTendersDataV2(input), 'INVALID', new RegExp(path))
      },
    )

    it('v2 accepts only the exact spaced VaultDoc ID across customer, requirement, and suggested references', () => {
      const input = makeSpacedIdV2()
      input.workspaces[0].tenders[0].requirements[0].suggestedVaultDocIds = [spacedVaultId]

      const result = validateTendersDataV2(input)

      expectValidationSuccess(result)
      const workspace = result.data.workspaces[0]
      expect(workspace.customers[0].requiredDocs[0].linkedVaultDocId).toBe(spacedVaultId)
      expect(workspace.tenders[0].requirements[0].linkedVaultDocId).toBe(spacedVaultId)
      expect(workspace.tenders[0].requirements[0].suggestedVaultDocIds).toEqual([spacedVaultId])
    })

    it('keeps v1 filename-stem compatibility separate by rewriting tax-compliance to the exact tax compliance ID', () => {
      const input = validV1()
      const workspace = input.workspaces[0]
      workspace.vault[0].id = spacedVaultId
      workspace.vault[0].fileUrl = 'vault/archive/tax-compliance.pdf'
      for (const customer of workspace.customers) {
        customer.requiredDocs[0].linkedVaultDocId = hyphenatedVaultAlias
      }
      workspace.tenders[0].requirements[0].linkedVaultDocId = hyphenatedVaultAlias
      workspace.tenders[0].requirements[0].suggestedVaultDocIds = [hyphenatedVaultAlias]

      const result = migrateTendersDataV1(input, MIGRATED_AT)

      expectMigrationSuccess(result)
      const migratedWorkspace = result.data.workspaces[0]
      expect(migratedWorkspace.customers[0].requiredDocs[0].linkedVaultDocId).toBe(spacedVaultId)
      expect(migratedWorkspace.tenders[0].requirements[0].linkedVaultDocId).toBe(spacedVaultId)
      expect(migratedWorkspace.tenders[0].requirements[0].suggestedVaultDocIds).toEqual([
        spacedVaultId,
      ])
      expectValidationSuccess(validateTendersDataV2(result.data))
    })

    it.each(
      legacyAliasReferenceCases.flatMap(([field, install, path]) =>
        [
          ['fileUrl basename', 'tax-compliance.pdf'],
          ['fileUrl stem', 'tax-compliance'],
        ].map(
          ([aliasKind, alias]) =>
            [`v2 rejects a ${field} matching only a ${aliasKind}`, install, path, alias] as const,
        ),
      ),
    )('%s', (_name, install, path, alias) => {
      const input = validV2()
      input.workspaces[0].vault[0].fileUrl = 'vault/archive/tax-compliance.pdf'
      install(input, alias)

      expectRejected(validateTendersDataV2(input), 'INVALID', new RegExp(path))
    })

    it.each([
      {
        name: 'customer linked document basename',
        alias: 'tax-compliance.pdf',
        expectedId: 'vault-example-1',
        path: 'workspaces.0.customers.0.requiredDocs.0.linkedVaultDocId',
        install(input: TendersDataV1, alias: string) {
          input.workspaces[0].customers[0].requiredDocs[0].linkedVaultDocId = alias
        },
        select(data: TendersDataV2) {
          return data.workspaces[0].customers[0].requiredDocs[0].linkedVaultDocId
        },
      },
      {
        name: 'requirement linked document path',
        alias: 'vault/archive/tax-compliance.pdf',
        expectedId: 'vault-example-1',
        path: 'workspaces.0.tenders.0.requirements.0.linkedVaultDocId',
        install(input: TendersDataV1, alias: string) {
          input.workspaces[0].tenders[0].requirements[0].linkedVaultDocId = alias
        },
        select(data: TendersDataV2) {
          return data.workspaces[0].tenders[0].requirements[0].linkedVaultDocId
        },
      },
      {
        name: 'suggested document filename stem',
        alias: 'company-registration',
        expectedId: 'vault-example-2',
        path: 'workspaces.0.tenders.0.requirements.0.suggestedVaultDocIds.0',
        install(input: TendersDataV1, alias: string) {
          input.workspaces[0].tenders[0].requirements[0].suggestedVaultDocIds = [alias]
        },
        select(data: TendersDataV2) {
          return data.workspaces[0].tenders[0].requirements[0].suggestedVaultDocIds[0]
        },
      },
    ])('v1 rewrites a unique legacy $name to its VaultDoc ID and warns at its path', (testCase) => {
      const input = validV1()
      input.workspaces[0].vault[0].fileUrl = 'vault/archive/tax-compliance.pdf'
      input.workspaces[0].vault[1].fileUrl = 'vault/company/company-registration.pdf'
      testCase.install(input, testCase.alias)

      const result = migrateTendersDataV1(input, MIGRATED_AT)

      expectMigrationSuccess(result)
      expect(testCase.select(result.data)).toBe(testCase.expectedId)
      expectLegacyVaultRewriteWarning(result, testCase.path)
      expectValidationSuccess(validateTendersDataV2(result.data))

      const migratedWorkspace = result.data.workspaces[0]
      const retainedReferences = [
        migratedWorkspace.customers[0].requiredDocs[0].linkedVaultDocId,
        ...migratedWorkspace.tenders[0].requirements.flatMap((requirement) => [
          requirement.linkedVaultDocId,
          ...requirement.suggestedVaultDocIds,
        ]),
      ].filter((reference): reference is string => reference !== null)
      const retainedVaultIds = new Set(migratedWorkspace.vault.map((document) => document.id))
      expect(retainedReferences.every((reference) => retainedVaultIds.has(reference))).toBe(true)
    })

    it.each(
      legacyAliasReferenceCases.flatMap(([field, install, path]) => [
        [`rejects an ambiguous ${field} filename alias`, install, path, 'ambiguous'] as const,
        [`rejects an unmatched ${field} filename alias`, install, path, 'unmatched'] as const,
      ]),
    )('%s', (_name, install, path, condition) => {
      const input = validV1()
      if (condition === 'ambiguous') {
        input.workspaces[0].vault[0].fileUrl = 'vault/first/shared-document.pdf'
        input.workspaces[0].vault[1].fileUrl = 'vault/second/shared-document.pdf'
        install(input, 'shared-document')
      } else {
        install(input, 'missing-document.pdf')
      }

      expectRejected(migrateTendersDataV1(input, MIGRATED_AT), 'INVALID', new RegExp(path))
    })
  })

  describe('persisted identifier whitespace', () => {
    const whitespaceIdCases: Array<[string, (input: any) => void, RegExp]> = [
      [
        'workspace ID',
        (input) => {
          input.workspaces[0].id = ' \t '
        },
        /workspaces.*0.*id/,
      ],
      [
        'customer ID',
        (input) => {
          input.workspaces[0].customers[0].id = '\n  '
        },
        /customers.*0.*id/,
      ],
      [
        'vault document ID',
        (input) => {
          input.workspaces[0].vault[0].id = '   '
        },
        /vault.*0.*id/,
      ],
      [
        'tender ID',
        (input) => {
          input.workspaces[0].tenders[0].id = '\r\n'
        },
        /tenders.*0.*id/,
      ],
      [
        'requirement ID',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].id = '\t'
        },
        /requirements.*0.*id/,
      ],
      [
        'milestone ID',
        (input) => {
          input.workspaces[0].tenders[0].milestones[0].id = ' \n '
        },
        /milestones.*0.*id/,
      ],
      [
        'company project ID',
        (input) => {
          input.workspaces[0].company.projects[0].id = '  '
        },
        /company.*projects.*0.*id/,
      ],
      [
        'issuer template ID',
        (input) => {
          input.issuerTemplates[0].id = '\t \r'
        },
        /issuerTemplates.*0.*id/,
      ],
    ]

    it.each(
      SCHEMA_LANES.flatMap((lane) =>
        whitespaceIdCases.map(
          ([scope, mutate, path]) =>
            [`${lane.label} rejects a whitespace-only ${scope}`, lane, mutate, path] as const,
        ),
      ),
    )('%s', (_name, lane, mutate, path) => {
      const input = lane.make()
      mutate(input)

      expectRejected(lane.validate(input), 'INVALID', path)
    })

    it.each(SCHEMA_LANES)('$label preserves non-empty IDs containing internal spaces', (lane) => {
      const input = lane.make()
      const workspace = input.workspaces[0]
      const expected = {
        workspace: 'workspace example 1',
        customer: 'customer example 1',
        vault: 'vault example 1',
        tender: 'tender example 1',
        requirement: 'requirement example 1',
        milestone: 'milestone example 1',
        project: 'project example 1',
        issuer: 'issuer example 1',
      }

      input.activeCompanyId = expected.workspace
      workspace.id = expected.workspace
      workspace.customers[0].id = expected.customer
      const originalVaultId = workspace.vault[0].id
      workspace.vault[0].id = expected.vault
      for (const customer of workspace.customers) {
        for (const requiredDoc of customer.requiredDocs) {
          if (requiredDoc.linkedVaultDocId === originalVaultId) {
            requiredDoc.linkedVaultDocId = expected.vault
          }
        }
      }
      workspace.tenders[0].id = expected.tender
      workspace.tenders[0].requirements[0].id = expected.requirement
      for (const tender of workspace.tenders) {
        for (const requirement of tender.requirements) {
          if (requirement.linkedVaultDocId === originalVaultId) {
            requirement.linkedVaultDocId = expected.vault
          }
          requirement.suggestedVaultDocIds = requirement.suggestedVaultDocIds.map((reference) =>
            reference === originalVaultId ? expected.vault : reference,
          )
        }
      }
      workspace.tenders[0].milestones[0].id = expected.milestone
      workspace.company.projects[0].id = expected.project
      input.issuerTemplates[0].id = expected.issuer

      const result = lane.validate(input)
      expectMigrationSuccess(result)

      const migratedWorkspace = result.data.workspaces[0]
      expect(result.data.activeCompanyId).toBe(expected.workspace)
      expect(migratedWorkspace.id).toBe(expected.workspace)
      expect(migratedWorkspace.customers[0].id).toBe(expected.customer)
      expect(migratedWorkspace.vault[0].id).toBe(expected.vault)
      expect(migratedWorkspace.customers[0].requiredDocs[0].linkedVaultDocId).toBe(expected.vault)
      expect(migratedWorkspace.tenders[0].id).toBe(expected.tender)
      expect(migratedWorkspace.tenders[0].requirements[0].id).toBe(expected.requirement)
      expect(migratedWorkspace.tenders[0].requirements[0].linkedVaultDocId).toBe(expected.vault)
      expect(migratedWorkspace.tenders[0].milestones![0].id).toBe(expected.milestone)
      expect(migratedWorkspace.company.projects[0].id).toBe(expected.project)
      expect(result.data.issuerTemplates[0].id).toBe(expected.issuer)
    })
  })

  describe('persisted numeric ranges', () => {
    const integerFields: Array<[string, (input: any, value: number) => void, RegExp]> = [
      [
        'tender numPages',
        (input, value) => {
          input.workspaces[0].tenders[0].numPages = value
        },
        /numPages/,
      ],
      [
        'tender ocrPages',
        (input, value) => {
          input.workspaces[0].tenders[0].ocrPages = value
        },
        /ocrPages/,
      ],
      [
        'requirement pageNumber',
        (input, value) => {
          input.workspaces[0].tenders[0].requirements[0].pageNumber = value
        },
        /requirements.*0.*pageNumber/,
      ],
      [
        'requirement order',
        (input, value) => {
          input.workspaces[0].tenders[0].requirements[0].order = value
        },
        /requirements.*0.*order/,
      ],
      [
        'additional-clause pageNumber',
        (input, value) => {
          input.workspaces[0].tenders[0].requirements[0].additionalClauses = [
            { text: 'Related clause', pageNumber: value },
          ]
        },
        /additionalClauses.*0.*pageNumber/,
      ],
      [
        'issuer seenCount',
        (input, value) => {
          input.issuerTemplates[0].seenCount = value
        },
        /issuerTemplates.*0.*seenCount/,
      ],
    ]
    const invalidIntegers: Array<[string, number]> = [
      ['negative', -1],
      ['fractional', 1.5],
      ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ]

    it.each(
      SCHEMA_LANES.flatMap((lane) =>
        integerFields.flatMap(([field, mutate, path]) =>
          invalidIntegers.map(
            ([kind, value]) =>
              [`${lane.label} rejects a ${kind} ${field}`, lane, mutate, path, value] as const,
          ),
        ),
      ),
    )('%s', (_name, lane, mutate, path, value) => {
      const input = lane.make()
      mutate(input, value)

      expectRejected(lane.validate(input), 'INVALID', path)
    })

    const boundedNumberCases: Array<[string, (input: any) => void, RegExp]> = [
      [
        'ocrPages above numPages',
        (input) => {
          input.workspaces[0].tenders[0].ocrPages = input.workspaces[0].tenders[0].numPages + 1
        },
        /ocrPages/,
      ],
      [
        'zero requirement pageNumber',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].pageNumber = 0
        },
        /requirements.*0.*pageNumber/,
      ],
      [
        'requirement pageNumber above tender numPages',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].pageNumber =
            input.workspaces[0].tenders[0].numPages + 1
        },
        /requirements.*0.*pageNumber/,
      ],
      [
        'negative match confidence',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].confidence = -0.01
        },
        /requirements.*0.*confidence/,
      ],
      [
        'match confidence above one',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].confidence = 1.01
        },
        /requirements.*0.*confidence/,
      ],
      [
        'negative boundingBox top',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].boundingBox.top = -0.01
        },
        /boundingBox.*top/,
      ],
      [
        'boundingBox left above one',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].boundingBox.left = 1.01
        },
        /boundingBox.*left/,
      ],
      [
        'negative boundingBox width',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].boundingBox.width = -0.01
        },
        /boundingBox.*width/,
      ],
      [
        'boundingBox height above one',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].boundingBox.height = 1.01
        },
        /boundingBox.*height/,
      ],
      [
        'non-finite boundingBox coordinate',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].boundingBox.width =
            Number.POSITIVE_INFINITY
        },
        /boundingBox.*width/,
      ],
      [
        'boundingBox horizontal extent above one',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].boundingBox.left = 0.4
          input.workspaces[0].tenders[0].requirements[0].boundingBox.width = 0.7
        },
        /boundingBox/,
      ],
      [
        'boundingBox vertical extent above one',
        (input) => {
          input.workspaces[0].tenders[0].requirements[0].boundingBox.top = 0.9
          input.workspaces[0].tenders[0].requirements[0].boundingBox.height = 0.2
        },
        /boundingBox/,
      ],
      [
        'negative estimatedValue',
        (input) => {
          input.workspaces[0].tenders[0].estimatedValue = -0.01
        },
        /estimatedValue/,
      ],
      [
        'non-finite estimatedValue',
        (input) => {
          input.workspaces[0].tenders[0].estimatedValue = Number.NaN
        },
        /estimatedValue/,
      ],
      [
        'negative milestone amount',
        (input) => {
          input.workspaces[0].tenders[0].milestones[0].amount = -0.01
        },
        /milestones.*0.*amount/,
      ],
      [
        'non-finite milestone amount',
        (input) => {
          input.workspaces[0].tenders[0].milestones[0].amount = Number.NEGATIVE_INFINITY
        },
        /milestones.*0.*amount/,
      ],
    ]

    it.each(
      SCHEMA_LANES.flatMap((lane) =>
        boundedNumberCases.map(
          ([condition, mutate, path]) =>
            [`${lane.label} rejects ${condition}`, lane, mutate, path] as const,
        ),
      ),
    )('%s', (_name, lane, mutate, path) => {
      const input = lane.make()
      mutate(input)

      expectRejected(lane.validate(input), 'INVALID', path)
    })

    it.each(SCHEMA_LANES)('$label accepts documented numeric boundaries', (lane) => {
      const input = lane.make()
      const tender = input.workspaces[0].tenders[0]
      tender.numPages = 2
      tender.ocrPages = 2
      tender.estimatedValue = 0
      tender.requirements[0].pageNumber = 1
      tender.requirements[0].order = 0
      tender.requirements[0].confidence = 0
      tender.requirements[0].boundingBox = { top: 0, left: 0, width: 1, height: 1 }
      tender.requirements[0].additionalClauses = [{ text: 'Last page clause', pageNumber: 2 }]
      tender.requirements[1].pageNumber = 2
      tender.requirements[1].order = Number.MAX_SAFE_INTEGER
      tender.requirements[1].confidence = 1
      tender.milestones[0].amount = 0
      input.issuerTemplates[0].seenCount = 0

      expectMigrationSuccess(lane.validate(input))
    })

    it.each(SCHEMA_LANES)('$label accepts a zero-page tender with no requirements', (lane) => {
      const input = lane.make()
      const tender = input.workspaces[0].tenders[0]
      tender.numPages = 0
      tender.ocrPages = 0
      tender.requirements = []

      expectMigrationSuccess(lane.validate(input))
    })
  })

  describe('strict nested persisted dates', () => {
    const supportedClosingDates = [
      '2026-12-18',
      '30 November 2026 at 11h00',
      'Dec 18, 2026 14:30',
      '18/12/2026 14:30',
    ]

    it.each(
      SCHEMA_LANES.flatMap((lane) =>
        supportedClosingDates.map(
          (closingDate) =>
            [
              `${lane.label} accepts supported persisted tender closingDate ${closingDate}`,
              lane,
              closingDate,
            ] as const,
        ),
      ),
    )('%s', (_name, lane, closingDate) => {
      const input = lane.make()
      input.workspaces[0].tenders[0].closingDate = closingDate

      expectMigrationSuccess(lane.validate(input))
    })

    it.each(supportedClosingDates)(
      'v1 migration preserves valid closingDate text verbatim: %s',
      (closingDate) => {
        const input = validV1()
        input.workspaces[0].tenders[0].closingDate = closingDate

        const result = migrateTendersDataV1(input, MIGRATED_AT)

        expectMigrationSuccess(result)
        expect(result.data.workspaces[0].tenders[0].closingDate).toBe(closingDate)
      },
    )

    it.each(
      SCHEMA_LANES.flatMap((lane) =>
        [
          ['2026-12-18T12:00:00.000Z', '2026-12-18T12:00:00.000Z'],
          ['2026-12-18T14:00:00.000+02:00', '2026-12-18T12:00:00.000Z'],
        ].map(
          ([closingDate, expectedInstant]) =>
            [
              `${lane.label} accepts an RFC3339 closingDate through the shared parser and preserves ${closingDate}`,
              lane,
              closingDate,
              expectedInstant,
            ] as const,
        ),
      ),
    )('%s', (_name, lane, closingDate, expectedInstant) => {
      const input = lane.make()
      input.workspaces[0].tenders[0].closingDate = closingDate

      const parsed = parseClosingDate(closingDate)
      expect(parsed).not.toBeNull()
      expect(Number.isFinite(parsed?.getTime())).toBe(true)
      expect(parsed?.toISOString()).toBe(expectedInstant)

      const result = lane.validate(input)
      expectMigrationSuccess(result)
      expect(result.data.workspaces[0].tenders[0].closingDate).toBe(closingDate)
    })

    it.each(SCHEMA_LANES)(
      '$label accepts a null tender closingDate allowed by the domain',
      (lane) => {
        const input = lane.make()
        input.workspaces[0].tenders[0].closingDate = null

        const result = lane.validate(input)

        expectMigrationSuccess(result)
        expect(result.data.workspaces[0].tenders[0].closingDate).toBeNull()
      },
    )

    it.each(
      SCHEMA_LANES.flatMap((lane) =>
        [
          'not-a-date',
          '2026-99-99',
          '2026-02-30',
          '2026-02-30T12:00:00.000Z',
          '2026-12-18T12:00:00.000',
          'Feb 30, 2026',
          '30 November 2026 at 24h00',
          'Dec 18, 2026 14:60',
          '18/12/2026 25:30',
        ].map(
          (closingDate) =>
            [
              `${lane.label} rejects malformed or impossible tender closingDate ${closingDate}`,
              lane,
              closingDate,
            ] as const,
        ),
      ),
    )('%s', (_name, lane, closingDate) => {
      const input = lane.make()
      input.workspaces[0].tenders[0].closingDate = closingDate

      expect(parseClosingDate(closingDate)).toBeNull()
      expectRejected(lane.validate(input), 'INVALID', /workspaces.*0.*tenders.*0.*closingDate/)
    })

    it('migrates a live billed v1 milestone with RFC3339 billedDate and billedAt unchanged', () => {
      const input = validV1()
      const billedDate = '2026-09-13T10:30:00.000Z'
      const billedAt = '2026-09-13T12:30:00.000+02:00'
      const milestone = input.workspaces[0].tenders[0].milestones![1]
      milestone.status = 'BILLED'
      milestone.billedDate = billedDate
      milestone.billedAt = billedAt

      const result = migrateTendersDataV1(input, MIGRATED_AT)

      expectMigrationSuccess(result)
      const migratedMilestone = result.data.workspaces[0].tenders[0].milestones![1]
      expect(migratedMilestone.status).toBe('BILLED')
      expect(migratedMilestone.billedDate).toBe(billedDate)
      expect(migratedMilestone.billedAt).toBe(billedAt)

      const validation = validateTendersDataV2(result.data)
      expectValidationSuccess(validation)
      expect(validation.data.workspaces[0].tenders[0].milestones![1].billedDate).toBe(billedDate)
      expect(validation.data.workspaces[0].tenders[0].milestones![1].billedAt).toBe(billedAt)
    })

    it.each(SCHEMA_LANES)(
      '$label accepts fixture-compatible date-only and RFC3339 values',
      (lane) => {
        const input = lane.make()
        const workspace = input.workspaces[0]
        const tender = workspace.tenders[0]
        tender.createdAt = '2024-02-29T23:59:59.123+02:00'
        input.issuerTemplates[0].lastSeen = '2026-08-20T09:15:30Z'
        tender.milestones[0].dueDate = '2028-02-29'
        tender.milestones[1].completedDate = '2027-01-20'
        tender.milestones[1].billedAt = '2027-01-20T08:00:00.000Z'
        tender.milestones[1].billedDate = '2027-01-20'
        workspace.vault[0].issueDate = '2026-01-01'
        workspace.vault[0].expiryDate = '2027-01-01'
        workspace.vault[0].certifiedDate = '2026-02-28'
        workspace.vault[1].issueDate = '2026-01-01T00:00:00Z'
        workspace.vault[1].expiryDate = '2027-01-01T00:00:00.000+02:00'
        workspace.vault[1].certifiedDate = '2026-02-28T12:30:00Z'
        workspace.customers[0].since = '2025-01-01'

        expectMigrationSuccess(lane.validate(input))
      },
    )

    const invalidDateCases: Array<[string, (input: any) => void, RegExp]> = [
      [
        'TenderRecord.createdAt impossible day',
        (input) => {
          input.workspaces[0].tenders[0].createdAt = '2026-02-30T10:00:00.000Z'
        },
        /tenders.*0.*createdAt/,
      ],
      [
        'IssuerTemplate.lastSeen malformed timestamp',
        (input) => {
          input.issuerTemplates[0].lastSeen = '2026-08-20 09:15:30'
        },
        /issuerTemplates.*0.*lastSeen/,
      ],
      [
        'milestone dueDate impossible month',
        (input) => {
          input.workspaces[0].tenders[0].milestones[0].dueDate = '2027-13-15'
        },
        /milestones.*0.*dueDate/,
      ],
      [
        'milestone completedDate impossible day',
        (input) => {
          input.workspaces[0].tenders[0].milestones[1].completedDate = '2027-04-31'
        },
        /milestones.*1.*completedDate/,
      ],
      [
        'milestone billedAt timestamp without timezone',
        (input) => {
          input.workspaces[0].tenders[0].milestones[1].billedAt = '2027-01-20T08:00:00'
        },
        /milestones.*1.*billedAt/,
      ],
      [
        'milestone billedDate malformed date',
        (input) => {
          input.workspaces[0].tenders[0].milestones[1].billedDate = '20 January 2027'
        },
        /milestones.*1.*billedDate/,
      ],
      [
        'vault issueDate impossible month',
        (input) => {
          input.workspaces[0].vault[0].issueDate = '2026-00-01'
        },
        /vault.*0.*issueDate/,
      ],
      [
        'vault expiryDate impossible day',
        (input) => {
          input.workspaces[0].vault[0].expiryDate = '2027-02-29'
        },
        /vault.*0.*expiryDate/,
      ],
      [
        'vault certifiedDate malformed date',
        (input) => {
          input.workspaces[0].vault[0].certifiedDate = '2026/02/28'
        },
        /vault.*0.*certifiedDate/,
      ],
      [
        'customer since impossible leap day',
        (input) => {
          input.workspaces[0].customers[0].since = '2025-02-29'
        },
        /customers.*0.*since/,
      ],
    ]

    it.each(
      SCHEMA_LANES.flatMap((lane) =>
        invalidDateCases.map(
          ([field, mutate, path]) =>
            [`${lane.label} rejects invalid ${field}`, lane, mutate, path] as const,
        ),
      ),
    )('%s', (_name, lane, mutate, path) => {
      const input = lane.make()
      mutate(input)

      expectRejected(lane.validate(input), 'INVALID', path)
    })
  })

  describe('strict v2 validation', () => {
    it('accepts a complete valid v2 document and preserves dynamic metadata keys', () => {
      const input = validV2()

      const result = validateTendersDataV2(input)

      expectValidationSuccess(result)
      expect(result.data).toEqual(input)
      expect(result.data.workspaces[0].vault[0].metadata).toEqual({
        'arbitrary dynamic key': 'accepted value',
        'another-key': 'another value',
      })
    })

    it('accepts requirements that share an acyclic boundingBox object and carry own undefined optionals', () => {
      // Reproduces the built-app shredder failure: a shared box object (a DAG)
      // plus structured-clone style `additionalClauses: undefined` / `notes:
      // undefined` own properties used to fail aggregate/optional validation.
      const input = validV2()
      const tender = input.workspaces[0].tenders[0]
      const [first, second] = tender.requirements
      const sharedBox = { top: 0.1, left: 0.2, width: 0.7, height: 0.05 }
      first.boundingBox = sharedBox
      second.boundingBox = sharedBox
      ;(first as any).additionalClauses = undefined
      ;(first as any).notes = undefined
      ;(second as any).additionalClauses = undefined
      ;(second as any).notes = undefined

      const result = validateTendersDataV2(input)

      expectValidationSuccess(result)
      // The two boxes remain distinct in the validated output.
      const boxes = result.data.workspaces[0].tenders[0].requirements.map((r) => r.boundingBox)
      expect(new Set(boxes).size).toBe(boxes.length)
    })

    it('normalizes own undefined linkedVaultDocId/reason optionals to null', () => {
      const input = validV2()
      const requirement = input.workspaces[0].tenders[0].requirements[0] as any
      requirement.linkedVaultDocId = undefined
      requirement.reason = undefined

      const result = validateTendersDataV2(input)

      expectValidationSuccess(result)
      const parsed = result.data.workspaces[0].tenders[0].requirements[0]
      expect(parsed.linkedVaultDocId).toBeNull()
      expect(parsed.reason).toBeNull()
    })

    it('still rejects a requirement whose required linkedVaultDocId key is absent', () => {
      const input = validV2()
      const requirement = input.workspaces[0].tenders[0].requirements[0] as any
      delete requirement.linkedVaultDocId

      expectRejected(validateTendersDataV2(input), 'MISSING', /linkedVaultDocId/)
    })

    it('still rejects a cyclic document via the aggregate-string guard', () => {
      const cyclic = validV2() as any
      const node: any = { text: 'valid clause text' }
      node.self = node
      cyclic.workspaces[0].tenders[0].requirements[0].additionalClauses = [node]

      const result = validateTendersDataV2(cyclic)

      expect(result).toMatchObject({ ok: false })
      const issues = (result as { issues?: Array<{ message?: string }> }).issues ?? []
      expect(
        issues.some((issue) => /aggregate string content exceeds/i.test(issue.message ?? '')),
      ).toBe(true)
    })

    it.each([
      ['negative', -1],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
      ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
      ['string', '0'],
    ])('rejects a %s revision', (_label, revision) => {
      const input = validV2() as any
      input.revision = revision

      expectRejected(validateTendersDataV2(input), 'INVALID', /revision/)
    })

    it.each([
      [
        'null active company with workspaces',
        (input: TendersDataV2) => {
          input.activeCompanyId = null
        },
      ],
      [
        'unknown active company ID',
        (input: TendersDataV2) => {
          input.activeCompanyId = 'workspace-does-not-exist'
        },
      ],
      [
        'nonnull active company in an empty document',
        (input: TendersDataV2) => {
          input.workspaces = []
          input.activeCompanyId = 'workspace-example-1'
        },
      ],
    ])('rejects %s', (_label, mutate) => {
      const input = validV2()
      mutate(input)

      expectRejected(validateTendersDataV2(input), 'INVALID', /activeCompanyId/)
    })

    it('rejects duplicate workspace IDs with the duplicate path', () => {
      const input = validV2()
      input.workspaces.push(clone(input.workspaces[0]))

      expectRejected(validateTendersDataV2(input), 'INVALID', /workspaces.*1.*id/)
    })

    it.each<[string, (workspace: TendersWorkspaceV2, document: TendersDataV2) => void, RegExp]>([
      [
        'customer IDs',
        (workspace) => workspace.customers.push(clone(workspace.customers[0])),
        /workspaces.*0.*customers.*2.*id/,
      ],
      [
        'vault document IDs',
        (workspace) => workspace.vault.push(clone(workspace.vault[0])),
        /workspaces.*0.*vault.*2.*id/,
      ],
      [
        'tender IDs',
        (workspace) => workspace.tenders.push(clone(workspace.tenders[0])),
        /workspaces.*0.*tenders.*1.*id/,
      ],
      [
        'tender references',
        (workspace) => {
          workspace.tenders.push({
            ...clone(workspace.tenders[0]),
            id: 'tender-example-2',
          })
        },
        /workspaces.*0.*tenders.*1.*referenceNumber/,
      ],
      [
        'requirement IDs',
        (workspace) => {
          workspace.tenders[0].requirements.push(clone(workspace.tenders[0].requirements[0]))
        },
        /workspaces.*0.*tenders.*0.*requirements.*2.*id/,
      ],
      [
        'milestone IDs',
        (workspace) => {
          workspace.tenders[0].milestones!.push(clone(workspace.tenders[0].milestones![0]))
        },
        /workspaces.*0.*tenders.*0.*milestones.*2.*id/,
      ],
      [
        'issuer template IDs',
        (_workspace, document) => {
          document.issuerTemplates.push(clone(document.issuerTemplates[0]))
        },
        /issuerTemplates.*2.*id/,
      ],
    ])('rejects duplicate nested %s with a path-addressed issue', (_label, mutate, path) => {
      const input = validV2()
      mutate(input.workspaces[0], input)

      expectRejected(validateTendersDataV2(input), 'INVALID', path)
    })

    it('rejects the whole document when one nested tender is invalid', () => {
      const input = validV2()
      input.workspaces[0].tenders.push(
        syntheticTender({
          id: 'tender-example-invalid',
          referenceNumber: 'ICT/EXAMPLE/INVALID',
          status: 'NOT_A_TENDER_STATUS' as TenderRecord['status'],
        }),
      )

      const result = validateTendersDataV2(input)

      expectRejected(result, 'INVALID', /workspaces.*0.*tenders.*1.*status/)
      expect(result).not.toHaveProperty('data')
    })

    it.each([
      [
        'top-level field',
        (input: any) => {
          input.unexpectedTopLevel = true
        },
        /unexpectedTopLevel/,
      ],
      [
        'workspace field',
        (input: any) => {
          input.workspaces[0].unexpectedWorkspaceField = true
        },
        /workspaces.*0.*unexpectedWorkspaceField/,
      ],
      [
        'nested tender field',
        (input: any) => {
          input.workspaces[0].tenders[0].unexpectedTenderField = true
        },
        /workspaces.*0.*tenders.*0.*unexpectedTenderField/,
      ],
      [
        'nested requirement field',
        (input: any) => {
          input.workspaces[0].tenders[0].requirements[0].unexpectedRequirementField = true
        },
        /requirements.*0.*unexpectedRequirementField/,
      ],
    ])('rejects an unknown %s', (_label, mutate, path) => {
      const input = validV2() as any
      mutate(input)

      expectRejected(validateTendersDataV2(input), 'INVALID', path)
    })

    it.each([
      ['schemaVersion', 'schemaVersion'],
      ['revision', 'revision'],
      ['updatedAt', 'updatedAt'],
      ['activeCompanyId', 'activeCompanyId'],
      ['workspaces', 'workspaces'],
      ['issuerTemplates', 'issuerTemplates'],
    ])('rejects a missing required top-level %s field', (_label, key) => {
      const input = validV2() as any
      delete input[key]

      expectRejected(validateTendersDataV2(input), 'MISSING', new RegExp(key))
    })

    it('rejects a missing required nested field', () => {
      const input = validV2() as any
      delete input.workspaces[0].tenders[0].requirements[0].title

      expectRejected(
        validateTendersDataV2(input),
        'MISSING',
        /workspaces.*0.*tenders.*0.*requirements.*0.*title/,
      )
    })

    it.each([
      [
        'workspace dataOrigin',
        (input: any) => {
          input.workspaces[0].dataOrigin = 'imported'
        },
        /dataOrigin/,
      ],
      [
        'customer status',
        (input: any) => {
          input.workspaces[0].customers[0].status = 'DELETED'
        },
        /customers.*0.*status/,
      ],
      [
        'vault category',
        (input: any) => {
          input.workspaces[0].vault[0].category = 'LEGAL'
        },
        /vault.*0.*category/,
      ],
      [
        'tender status',
        (input: any) => {
          input.workspaces[0].tenders[0].status = 'DRAFT'
        },
        /tenders.*0.*status/,
      ],
      [
        'submission method',
        (input: any) => {
          input.workspaces[0].tenders[0].submissionMethod = 'COURIER'
        },
        /submissionMethod/,
      ],
      [
        'requirement category',
        (input: any) => {
          input.workspaces[0].tenders[0].requirements[0].category = 'OTHER'
        },
        /requirements.*0.*category/,
      ],
      [
        'requirement risk',
        (input: any) => {
          input.workspaces[0].tenders[0].requirements[0].riskLevel = 'UNKNOWN'
        },
        /riskLevel/,
      ],
      [
        'requirement fulfillment status',
        (input: any) => {
          input.workspaces[0].tenders[0].requirements[0].status = 'UNDER_REVIEW'
        },
        /requirements.*0.*status/,
      ],
      [
        'milestone status',
        (input: any) => {
          input.workspaces[0].tenders[0].milestones[0].status = 'CANCELLED'
        },
        /milestones.*0.*status/,
      ],
    ])('rejects an invalid %s enum value', (_label, mutate, path) => {
      const input = validV2() as any
      mutate(input)

      expectRejected(validateTendersDataV2(input), 'INVALID', path)
    })

    it.each([
      [
        'estimated tender value',
        (input: any) => {
          input.workspaces[0].tenders[0].estimatedValue = Number.POSITIVE_INFINITY
        },
        /estimatedValue/,
      ],
      [
        'tender page count',
        (input: any) => {
          input.workspaces[0].tenders[0].numPages = Number.NaN
        },
        /numPages/,
      ],
      [
        'requirement confidence',
        (input: any) => {
          input.workspaces[0].tenders[0].requirements[0].confidence = Number.NEGATIVE_INFINITY
        },
        /confidence/,
      ],
      [
        'requirement bounding box coordinate',
        (input: any) => {
          input.workspaces[0].tenders[0].requirements[0].boundingBox.top = Number.NaN
        },
        /boundingBox.*top/,
      ],
      [
        'milestone amount',
        (input: any) => {
          input.workspaces[0].tenders[0].milestones[0].amount = Number.POSITIVE_INFINITY
        },
        /milestones.*0.*amount/,
      ],
      [
        'issuer seen count',
        (input: any) => {
          input.issuerTemplates[0].seenCount = Number.NaN
        },
        /issuerTemplates.*0.*seenCount/,
      ],
    ])('rejects a non-finite %s', (_label, mutate, path) => {
      const input = validV2() as any
      mutate(input)

      expectRejected(validateTendersDataV2(input), 'INVALID', path)
    })

    it.each([
      ['plain text', 'not-a-date'],
      ['date only', '2026-09-13'],
      ['impossible date', '2026-02-30T10:00:00.000Z'],
      ['missing timezone', '2026-09-13T10:30:00'],
    ])('rejects updatedAt when it is %s instead of valid RFC3339', (_label, updatedAt) => {
      const input = validV2()
      input.updatedAt = updatedAt

      expectRejected(validateTendersDataV2(input), 'INVALID', /updatedAt/)
    })

    it('validates v2 without adding omitted optional fields', () => {
      const input = validV2()
      const workspace = input.workspaces[0]
      const tender = workspace.tenders[0]
      const requirement = tender.requirements[0]
      delete workspace.name
      delete tender.linkedCrmDealId
      delete tender.estimatedValue
      delete tender.pricingConfirmed
      delete tender.milestones
      delete requirement.additionalClauses
      delete requirement.confidence
      delete requirement.notes
      delete requirement.notApplicableReason

      const result = validateTendersDataV2(input)

      expectValidationSuccess(result)
      expect(result.data).toEqual(input)
      expect(result.data.workspaces[0]).not.toHaveProperty('name')
      expect(result.data.workspaces[0].tenders[0]).not.toHaveProperty('milestones')
      expect(result.data.workspaces[0].tenders[0].requirements[0]).not.toHaveProperty(
        'notApplicableReason',
      )
    })

    it('does not retimestamp a valid v2 document during dispatch', () => {
      const input = validV2()
      const result = migrateTendersData(input, SECOND_MIGRATED_AT)

      expectMigrationSuccess(result)
      expect(result).toMatchObject({ sourceVersion: 2, migrated: false })
      expect(result.data.updatedAt).toBe(V1_UPDATED_AT)
      expect(result.data).toEqual(input)
    })
  })
})

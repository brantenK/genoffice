import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Security review sec-2: resource-bound contract for the authoritative Tenders
// persistence path. Production does not enforce these yet, so the RED lane uses
// local constants. Proposed exported names (from either
// `src/shared/tenders-schema.ts` or `src/shared/tenders-persistence.ts`):
//
//   MAX_TENDERS_STORE_FILE_BYTES          = 8 * 1024 * 1024       (load raw file)
//   MAX_TENDERS_DOCUMENT_BYTES            = 1.5 * 1024 * 1024     (save + broadcast)
//   MAX_TENDERS_WORKSPACES                = 100
//   MAX_TENDERS_CUSTOMERS_PER_WORKSPACE   = 10_000
//   MAX_TENDERS_VAULT_DOCS_PER_WORKSPACE  = 10_000
//   MAX_TENDERS_TENDERS_PER_WORKSPACE     = 5_000
//   MAX_TENDERS_REQUIREMENTS_PER_TENDER   = 5_000
//   MAX_TENDERS_MILESTONES_PER_TENDER     = 5_000
//   MAX_TENDERS_ISSUER_TEMPLATES          = 1_000
//   MAX_TENDERS_SINGLE_STRING_CHARS       = 32_768
//   MAX_TENDERS_AGGREGATE_STRING_CHARS    = 1_048_576
//   MAX_TENDERS_DYNAMIC_ENTRIES           = 2_000
//   MAX_TENDERS_DYNAMIC_KEY_CHARS         = 256
//   MAX_TENDERS_SCHEMA_ISSUES             = 500
//   MAX_TENDERS_REQUIRED_DOCS_PER_CUSTOMER        = 1_000
//   MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT = 1_000
//   MAX_TENDERS_IPC_PAYLOAD_BYTES                 = 2 * 1024 * 1024  (outer IPC request)
// ─────────────────────────────────────────────────────────────────────────────

const ORIGINAL_ISO = '2026-08-20T09:15:30.000Z'
const CLOCK_ISO = '2026-09-14T10:11:12.345Z'
const FIXED_NOW = new Date(CLOCK_ISO)

const ASSUMED_MAX_STORE_FILE_BYTES = 8 * 1024 * 1024
const ASSUMED_MAX_DOCUMENT_BYTES = 1.5 * 1024 * 1024
const ASSUMED_MAX_WORKSPACES = 100
const ASSUMED_MAX_CUSTOMERS_PER_WORKSPACE = 10_000
const ASSUMED_MAX_VAULT_DOCS_PER_WORKSPACE = 10_000
const ASSUMED_MAX_TENDERS_PER_WORKSPACE = 5_000
const ASSUMED_MAX_REQUIREMENTS_PER_TENDER = 5_000
const ASSUMED_MAX_MILESTONES_PER_TENDER = 5_000
const ASSUMED_MAX_ISSUER_TEMPLATES = 1_000
const ASSUMED_MAX_SINGLE_STRING_CHARS = 32_768
const ASSUMED_MAX_AGGREGATE_STRING_CHARS = 1_048_576
const ASSUMED_MAX_DYNAMIC_ENTRIES = 2_000
const ASSUMED_MAX_DYNAMIC_KEY_CHARS = 256
const ASSUMED_MAX_SCHEMA_ISSUES = 500
const ASSUMED_MAX_REQUIRED_DOCS_PER_CUSTOMER = 1_000
const ASSUMED_MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT = 1_000
const ASSUMED_MAX_IPC_PAYLOAD_BYTES = 2 * 1024 * 1024

const { electronMock, userDataState, ipcHandlers } = vi.hoisted(() => {
  const userDataState = { dir: '' }
  const ipcHandlers = new Map<string, (...args: any[]) => any>()
  const electronMock = {
    app: {
      getPath: () => userDataState.dir,
      isReady: () => true,
    },
    ipcMain: {
      handle: (channel: string, listener: (...args: any[]) => any) => {
        ipcHandlers.set(channel, listener)
      },
    },
    shell: {
      openPath: async () => '',
    },
    WebContentsView: class MockWebContentsView {},
  }
  return { electronMock, userDataState, ipcHandlers }
})

vi.mock('electron', () => electronMock)

import {
  broadcastTendersData,
  configureTendersRuntime,
  registerTendersIpc,
  registerTendersWebContents,
  stopTendersStoreWatcher,
  unregisterTendersWebContents,
} from '../src/main/tenders-main'
import { createTendersStore } from '../src/main/tenders-store'
import { TENDERS_CHANNELS } from '../src/shared/ipc'
import { TENDERS_PERSISTENCE_FILE_NAME } from '../src/shared/tenders-persistence'
import {
  createEmptyTendersDataV2,
  migrateTendersDataV1,
  validateTendersDataV2,
} from '../src/shared/tenders-schema'
import type {
  CompanyWorkspace,
  ContractMilestone,
  Customer,
  CustomerDoc,
  IssuerTemplate,
  RequirementRecord,
  TenderRecord,
  TendersData,
  TendersDataV1,
  TendersDataV2,
  TendersWorkspaceV2,
  VaultDoc,
} from '../src/shared/types'

const roots: string[] = []
const registeredWebContents: Array<{ isDestroyed: () => boolean }> = []

/** Trusted renderer origin: privileged handlers fail closed without it. */
const TRUSTED_RENDERER_URL = 'http://localhost:5179/'

beforeAll(() => {
  configureTendersRuntime({
    preloadPath: '',
    rendererUrl: TRUSTED_RENDERER_URL,
    rendererFile: '',
  })
})

async function uniqueDirectory(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tenders-bounds-${label}-${randomUUID()}-`))
  roots.push(root)
  return root
}

function storePath(directory: string): string {
  return join(directory, TENDERS_PERSISTENCE_FILE_NAME)
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function makeBoundingBox(): RequirementRecord['boundingBox'] {
  return { top: 0, left: 0, width: 0, height: 0 }
}

function makeRequirement(
  index: number,
  overrides: Partial<RequirementRecord> = {},
): RequirementRecord {
  return {
    id: `req-${index}`,
    ruleKey: `rule-${index}`,
    title: `Requirement ${index}`,
    category: 'GENERAL_RETURNABLE',
    isMandatory: false,
    verbatimClause: '',
    pageNumber: 1,
    boundingBox: makeBoundingBox(),
    riskLevel: 'INFORMATIONAL',
    order: index,
    status: 'OUTSTANDING',
    linkedVaultDocId: null,
    reason: null,
    suggestedVaultDocIds: [],
    ...overrides,
  }
}

function makeMilestone(
  index: number,
  overrides: Partial<ContractMilestone> = {},
): ContractMilestone {
  return {
    id: `milestone-${index}`,
    name: `Milestone ${index}`,
    amount: 0,
    status: 'PENDING',
    ...overrides,
  }
}

function makeCustomer(index: number, overrides: Partial<Customer> = {}): Customer {
  return {
    id: `customer-${index}`,
    name: `Customer ${index}`,
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    industry: '',
    status: 'INACTIVE',
    since: '2026-01-01',
    notes: '',
    requiredDocs: [],
    ...overrides,
  }
}

function makeCustomerDoc(index: number, overrides: Partial<CustomerDoc> = {}): CustomerDoc {
  return {
    docCategory: 'COMPLIANCE',
    label: `Document ${index}`,
    fulfilled: false,
    linkedVaultDocId: null,
    ...overrides,
  }
}

function makeVaultDoc(index: number, overrides: Partial<VaultDoc> = {}): VaultDoc {
  return {
    id: `vault-${index}`,
    title: `Vault document ${index}`,
    category: 'COMPLIANCE',
    fileUrl: null,
    issueDate: null,
    expiryDate: null,
    isCertified: false,
    certifiedDate: null,
    metadata: {},
    ...overrides,
  }
}

function makeTender(index: number, overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: `tender-${index}`,
    title: `Tender ${index}`,
    referenceNumber: null,
    issuingBody: null,
    closingDate: null,
    submissionMethod: null,
    submissionAddress: null,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: ORIGINAL_ISO,
    fileName: `tender-${index}.pdf`,
    fileUrl: '',
    numPages: 1,
    ocrPages: 0,
    requirements: [],
    ...overrides,
  }
}

function makeCompany(): CompanyWorkspace['company'] {
  return {
    name: 'Company',
    tradingName: 'Company',
    registrationNumber: '',
    vatNumber: '',
    taxPin: '',
    bbbeeLevel: '',
    bbbeeBlackOwnership: '',
    csdSupplierNumber: '',
    founded: '',
    employees: '',
    industry: '',
    description: '',
    address: '',
    phone: '',
    email: '',
    website: '',
    directors: [],
    projects: [],
  }
}

function makeWorkspace(
  index: number,
  overrides: Partial<TendersWorkspaceV2> = {},
): TendersWorkspaceV2 {
  return {
    id: `workspace-${index}`,
    name: `Workspace ${index}`,
    company: makeCompany(),
    customers: [],
    vault: [],
    tenders: [],
    dataOrigin: 'user',
    ...overrides,
  }
}

function makeIssuer(index: number, overrides: Partial<IssuerTemplate> = {}): IssuerTemplate {
  return {
    id: `issuer-${index}`,
    name: `Issuer ${index}`,
    displayName: `Issuer ${index}`,
    address: null,
    contact: null,
    refStyle: null,
    submissionMethod: null,
    submissionAddress: null,
    seenCount: 0,
    lastSeen: ORIGINAL_ISO,
    ...overrides,
  }
}

function makeData(
  workspaces: TendersWorkspaceV2[],
  issuerTemplates: IssuerTemplate[] = [],
): TendersDataV2 {
  return {
    schemaVersion: 2,
    revision: 0,
    updatedAt: ORIGINAL_ISO,
    activeCompanyId: workspaces[0]?.id ?? null,
    workspaces,
    issuerTemplates,
  }
}

function validData(): TendersDataV2 {
  return makeData([
    makeWorkspace(0, {
      customers: [makeCustomer(0)],
      vault: [makeVaultDoc(0)],
      tenders: [
        makeTender(0, {
          requirements: [makeRequirement(0, { linkedVaultDocId: 'vault-0' })],
          milestones: [makeMilestone(0)],
        }),
      ],
    }),
  ])
}

function toV1Workspace(workspace: TendersWorkspaceV2): CompanyWorkspace {
  const { dataOrigin: _dataOrigin, ...rest } = workspace
  return rest
}

/**
 * Build a schema-valid v2 document whose `JSON.stringify` byte length is exactly
 * `targetBytes`. Requirements are grown until one more would overshoot, then the
 * final requirement's `notes` string is padded (one ASCII byte per character) to
 * land precisely on the target. The padding stays under the single-string cap
 * and the aggregate stays well under the aggregate-string cap.
 */
function buildDocumentAtBytes(targetBytes: number, revision = 0): TendersDataV2 {
  const build = (requirementCount: number, padding: number): TendersDataV2 => {
    const requirements = Array.from({ length: requirementCount }, (_, index) =>
      makeRequirement(index),
    )
    if (requirements.length > 0) {
      requirements[requirements.length - 1].notes = 'P'.repeat(padding)
    }
    return {
      ...makeData([
        makeWorkspace(0, {
          tenders: [makeTender(0, { requirements, numPages: 1 })],
        }),
      ]),
      revision,
    }
  }

  let low = 0
  let high = ASSUMED_MAX_REQUIREMENTS_PER_TENDER
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (byteLength(build(mid, 0)) <= targetBytes) low = mid
    else high = mid - 1
  }

  const baseBytes = byteLength(build(low, 0))
  const padding = targetBytes - baseBytes
  if (padding < 0 || padding > ASSUMED_MAX_SINGLE_STRING_CHARS) {
    throw new Error(
      `Cannot deterministically reach ${targetBytes} bytes (base=${baseBytes}, padding=${padding}).`,
    )
  }
  return build(low, padding)
}

function expectSchemaValid(result: ReturnType<typeof validateTendersDataV2>): void {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`Expected valid data, received ${result.error.code}`)
}

function expectSchemaInvalid(
  result: ReturnType<typeof validateTendersDataV2>,
  path?: string,
  messagePattern?: RegExp,
): void {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Expected schema validation to fail')
  expect(result.issues.length).toBeGreaterThan(0)
  if (path) {
    expect(
      result.issues.some((issue) => issue.path === path || issue.path.startsWith(`${path}.`)),
      `expected an issue addressed at or below "${path}"`,
    ).toBe(true)
  }
  if (messagePattern) {
    expect(result.issues.some((issue) => messagePattern.test(issue.message))).toBe(true)
  }
}

const COUNT_CASES: Array<{
  name: string
  limit: number
  path: string
  build: (count: number) => TendersDataV2
}> = [
  {
    name: 'workspaces',
    limit: ASSUMED_MAX_WORKSPACES,
    path: 'workspaces',
    build: (count) => makeData(Array.from({ length: count }, (_, index) => makeWorkspace(index))),
  },
  {
    name: 'customers per workspace',
    limit: ASSUMED_MAX_CUSTOMERS_PER_WORKSPACE,
    path: 'workspaces.0.customers',
    build: (count) =>
      makeData([
        makeWorkspace(0, {
          customers: Array.from({ length: count }, (_, index) => makeCustomer(index)),
        }),
      ]),
  },
  {
    name: 'vault documents per workspace',
    limit: ASSUMED_MAX_VAULT_DOCS_PER_WORKSPACE,
    path: 'workspaces.0.vault',
    build: (count) =>
      makeData([
        makeWorkspace(0, {
          vault: Array.from({ length: count }, (_, index) => makeVaultDoc(index)),
        }),
      ]),
  },
  {
    name: 'tenders per workspace',
    limit: ASSUMED_MAX_TENDERS_PER_WORKSPACE,
    path: 'workspaces.0.tenders',
    build: (count) =>
      makeData([
        makeWorkspace(0, {
          tenders: Array.from({ length: count }, (_, index) => makeTender(index)),
        }),
      ]),
  },
  {
    name: 'requirements per tender',
    limit: ASSUMED_MAX_REQUIREMENTS_PER_TENDER,
    path: 'workspaces.0.tenders.0.requirements',
    build: (count) =>
      makeData([
        makeWorkspace(0, {
          tenders: [
            makeTender(0, {
              numPages: 1,
              requirements: Array.from({ length: count }, (_, index) => makeRequirement(index)),
            }),
          ],
        }),
      ]),
  },
  {
    name: 'milestones per tender',
    limit: ASSUMED_MAX_MILESTONES_PER_TENDER,
    path: 'workspaces.0.tenders.0.milestones',
    build: (count) =>
      makeData([
        makeWorkspace(0, {
          tenders: [
            makeTender(0, {
              milestones: Array.from({ length: count }, (_, index) => makeMilestone(index)),
            }),
          ],
        }),
      ]),
  },
  {
    name: 'issuer templates',
    limit: ASSUMED_MAX_ISSUER_TEMPLATES,
    path: 'issuerTemplates',
    build: (count) =>
      makeData(
        [makeWorkspace(0)],
        Array.from({ length: count }, (_, index) => makeIssuer(index)),
      ),
  },
  {
    name: 'required documents per customer',
    limit: ASSUMED_MAX_REQUIRED_DOCS_PER_CUSTOMER,
    path: 'workspaces.0.customers.0.requiredDocs',
    build: (count) =>
      makeData([
        makeWorkspace(0, {
          customers: [
            makeCustomer(0, {
              requiredDocs: Array.from({ length: count }, (_, index) => makeCustomerDoc(index)),
            }),
          ],
        }),
      ]),
  },
  {
    name: 'additional clauses per requirement',
    limit: ASSUMED_MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT,
    path: 'workspaces.0.tenders.0.requirements.0.additionalClauses',
    build: (count) =>
      makeData([
        makeWorkspace(0, {
          tenders: [
            makeTender(0, {
              numPages: 1,
              requirements: [
                makeRequirement(0, {
                  additionalClauses: Array.from({ length: count }, (_, index) => ({
                    text: `Clause ${index}`,
                    pageNumber: 1,
                  })),
                }),
              ],
            }),
          ],
        }),
      ]),
  },
]

function makeReceiver(): {
  webContents: {
    isDestroyed: () => boolean
    once: () => void
    send: (channel: string, data: unknown) => void
  }
  received: Array<{ channel: string; data: unknown }>
} {
  const received: Array<{ channel: string; data: unknown }> = []
  const webContents = {
    isDestroyed: () => false,
    getURL: () => TRUSTED_RENDERER_URL,
    once: () => undefined,
    send: (channel: string, data: unknown) => {
      received.push({ channel, data })
    },
  }
  registerTendersWebContents(webContents as never)
  registeredWebContents.push(webContents)
  return { webContents, received }
}

afterEach(async () => {
  for (const webContents of registeredWebContents.splice(0)) {
    unregisterTendersWebContents(webContents as never)
  }
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('sec-2 Tenders persistence resource bounds', () => {
  describe('load raw file size', () => {
    it('rejects an on-disk store larger than the documented maximum with READ_FAILED', async () => {
      const directory = await uniqueDirectory('load-too-large')
      const document = validData()
      const documentBytes = byteLength(document)
      const padding = ' '.repeat(ASSUMED_MAX_STORE_FILE_BYTES + 4_096 - documentBytes)
      await writeFile(storePath(directory), `${padding}${JSON.stringify(document)}`, 'utf8')

      const result = await createTendersStore({ directory, now: () => FIXED_NOW }).load()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected oversized file to be rejected')
      expect(result.error.code).toBe('READ_FAILED')
      expect(result).not.toHaveProperty('data')
      expect(result.error.message).toMatch(/size|limit|large|exceed|byte/i)
    })

    it('loads a valid v2 document from a file just below the documented maximum', async () => {
      const directory = await uniqueDirectory('load-just-below')
      const document = validData()
      const documentBytes = byteLength(document)
      const padding = ' '.repeat(ASSUMED_MAX_STORE_FILE_BYTES - 1_024 - documentBytes)
      await writeFile(storePath(directory), `${padding}${JSON.stringify(document)}`, 'utf8')

      const result = await createTendersStore({ directory, now: () => FIXED_NOW }).load()

      expect(result.ok).toBe(true)
      if (!result.ok)
        throw new Error(`Expected just-below-limit file to load: ${result.error.code}`)
      expect(result.status).toBe('loaded')
      expect(result.data).toEqual(document)
    })
  })

  describe('schema collection count bounds', () => {
    it.each(COUNT_CASES)('accepts $name at the documented $limit limit', ({ build, limit }) => {
      expectSchemaValid(validateTendersDataV2(build(limit)))
    })

    it.each(COUNT_CASES)(
      'rejects $name above the documented $limit limit',
      ({ build, limit, path }) => {
        expectSchemaInvalid(validateTendersDataV2(build(limit + 1)), path)
      },
    )
  })

  describe('schema string and dynamic-key bounds', () => {
    it('accepts a single string at the documented per-field limit', () => {
      const document = validData()
      document.workspaces[0].company.description = 'D'.repeat(ASSUMED_MAX_SINGLE_STRING_CHARS)
      expectSchemaValid(validateTendersDataV2(document))
    })

    it('rejects a single string above the documented per-field limit at an addressed path', () => {
      const document = validData()
      document.workspaces[0].company.description = 'D'.repeat(ASSUMED_MAX_SINGLE_STRING_CHARS + 1)
      expectSchemaInvalid(validateTendersDataV2(document), 'workspaces.0.company.description')
    })

    it('accepts aggregate string content just below the documented document total', () => {
      const perString = ASSUMED_MAX_SINGLE_STRING_CHARS
      const document = makeData([
        makeWorkspace(0, {
          tenders: [
            makeTender(0, {
              numPages: 1,
              // 31 * 32 KiB = 1,015,808 chars, safely below the 1 MiB aggregate cap
              // even after the small fixed identifiers and titles are included.
              requirements: Array.from({ length: 31 }, (_, index) =>
                makeRequirement(index, { notes: 'A'.repeat(perString) }),
              ),
            }),
          ],
        }),
      ])
      expectSchemaValid(validateTendersDataV2(document))
    })

    it('rejects aggregate string content above the documented document total', () => {
      const perString = ASSUMED_MAX_SINGLE_STRING_CHARS
      const document = makeData([
        makeWorkspace(0, {
          tenders: [
            makeTender(0, {
              numPages: 1,
              // 33 * 32 KiB = 1,081,344 chars exceeds the 1 MiB aggregate cap on its own.
              requirements: Array.from({ length: 33 }, (_, index) =>
                makeRequirement(index, { notes: 'A'.repeat(perString) }),
              ),
            }),
          ],
        }),
      ])
      expectSchemaInvalid(
        validateTendersDataV2(document),
        undefined,
        /aggregate|total|combined|too (?:large|much|long)|exceed|limit|size/i,
      )
    })

    it('accepts metadata entries at the documented count limit', () => {
      const metadata: Record<string, string> = {}
      for (let index = 0; index < ASSUMED_MAX_DYNAMIC_ENTRIES; index += 1) {
        metadata[`k${index}`] = 'v'
      }
      const document = makeData([makeWorkspace(0, { vault: [makeVaultDoc(0, { metadata })] })])
      expectSchemaValid(validateTendersDataV2(document))
    })

    it('rejects metadata entries above the documented count limit', () => {
      const metadata: Record<string, string> = {}
      for (let index = 0; index <= ASSUMED_MAX_DYNAMIC_ENTRIES; index += 1) {
        metadata[`k${index}`] = 'v'
      }
      const document = makeData([makeWorkspace(0, { vault: [makeVaultDoc(0, { metadata })] })])
      expectSchemaInvalid(validateTendersDataV2(document), 'workspaces.0.vault.0.metadata')
    })

    it('accepts a metadata key at the documented dynamic-key length limit', () => {
      const key = 'K'.repeat(ASSUMED_MAX_DYNAMIC_KEY_CHARS)
      const document = makeData([
        makeWorkspace(0, { vault: [makeVaultDoc(0, { metadata: { [key]: 'v' } })] }),
      ])
      expectSchemaValid(validateTendersDataV2(document))
    })

    it('rejects a metadata key above the documented dynamic-key length limit', () => {
      const key = 'K'.repeat(ASSUMED_MAX_DYNAMIC_KEY_CHARS + 1)
      const document = makeData([
        makeWorkspace(0, { vault: [makeVaultDoc(0, { metadata: { [key]: 'v' } })] }),
      ])
      expectSchemaInvalid(validateTendersDataV2(document), `workspaces.0.vault.0.metadata.${key}`)
    })

    it('accepts signature checks at the documented count limit', () => {
      const signatureChecks: Record<string, boolean> = {}
      for (let index = 0; index < ASSUMED_MAX_DYNAMIC_ENTRIES; index += 1) {
        signatureChecks[`s${index}`] = true
      }
      const document = makeData([
        makeWorkspace(0, { tenders: [makeTender(0, { signatureChecks })] }),
      ])
      expectSchemaValid(validateTendersDataV2(document))
    })

    it('rejects signature checks above the documented count limit', () => {
      const signatureChecks: Record<string, boolean> = {}
      for (let index = 0; index <= ASSUMED_MAX_DYNAMIC_ENTRIES; index += 1) {
        signatureChecks[`s${index}`] = true
      }
      const document = makeData([
        makeWorkspace(0, { tenders: [makeTender(0, { signatureChecks })] }),
      ])
      expectSchemaInvalid(validateTendersDataV2(document), 'workspaces.0.tenders.0.signatureChecks')
    })

    it('accepts a signature-check key at the documented dynamic-key length limit', () => {
      const key = 'S'.repeat(ASSUMED_MAX_DYNAMIC_KEY_CHARS)
      const document = makeData([
        makeWorkspace(0, { tenders: [makeTender(0, { signatureChecks: { [key]: true } })] }),
      ])
      expectSchemaValid(validateTendersDataV2(document))
    })

    it('rejects a signature-check key above the documented dynamic-key length limit', () => {
      const key = 'S'.repeat(ASSUMED_MAX_DYNAMIC_KEY_CHARS + 1)
      const document = makeData([
        makeWorkspace(0, { tenders: [makeTender(0, { signatureChecks: { [key]: true } })] }),
      ])
      expectSchemaInvalid(
        validateTendersDataV2(document),
        `workspaces.0.tenders.0.signatureChecks.${key}`,
      )
    })
  })

  describe('schema issue reporting bound', () => {
    it('caps the total reported issue count at the documented maximum', () => {
      const document = makeData([
        makeWorkspace(0, {
          tenders: [
            makeTender(0, {
              numPages: 1,
              requirements: Array.from({ length: ASSUMED_MAX_SCHEMA_ISSUES + 200 }, (_, index) =>
                makeRequirement(index, { status: 'NOT_A_STATUS' as RequirementRecord['status'] }),
              ),
            }),
          ],
        }),
      ])

      const result = validateTendersDataV2(document)

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected invalid data')
      expect(result.issues.length).toBeGreaterThan(0)
      expect(result.issues.length).toBeLessThanOrEqual(ASSUMED_MAX_SCHEMA_ISSUES)
      expect(result.error.issues.length).toBeLessThanOrEqual(ASSUMED_MAX_SCHEMA_ISSUES)
    })
  })

  describe('save and broadcast serialized size bounds', () => {
    it('rejects an oversized document as INVALID_DATA before writing and preserves the prior file', async () => {
      const directory = await uniqueDirectory('save-too-large')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      const prior = await store.save({ expectedRevision: 0, document: validData() })
      expect(prior.ok).toBe(true)
      const priorBytes = await readFile(storePath(directory), 'utf8')

      const oversized = buildDocumentAtBytes(ASSUMED_MAX_DOCUMENT_BYTES + 1, 1)
      const rejected = await store.save({ expectedRevision: 1, document: oversized })

      expect(rejected.ok).toBe(false)
      if (rejected.ok) throw new Error('Expected oversized document to be rejected')
      expect(rejected.error.code).toBe('INVALID_DATA')
      expect(rejected.error.message).toMatch(/size|limit|large|exceed|byte/i)
      expect(rejected).not.toHaveProperty('data')
      expect(await readFile(storePath(directory), 'utf8')).toBe(priorBytes)
    })

    it('accepts a document whose serialized size is exactly at the documented maximum', async () => {
      const directory = await uniqueDirectory('save-at-limit')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      const document = buildDocumentAtBytes(ASSUMED_MAX_DOCUMENT_BYTES, 0)
      expect(byteLength(document)).toBe(ASSUMED_MAX_DOCUMENT_BYTES)

      const result = await store.save({ expectedRevision: 0, document })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(`Expected at-limit document to save: ${result.error.code}`)
      expect(result.data.revision).toBe(1)
    })

    it('broadcasts a document whose serialized size is exactly at the documented maximum', () => {
      const { received } = makeReceiver()
      const document = buildDocumentAtBytes(ASSUMED_MAX_DOCUMENT_BYTES)

      broadcastTendersData(document as unknown as TendersData)

      expect(
        received.filter((entry) => entry.channel === TENDERS_CHANNELS.dataChanged),
      ).toHaveLength(1)
    })

    it('does not broadcast a document whose serialized size exceeds the documented maximum', () => {
      const { received } = makeReceiver()
      const document = buildDocumentAtBytes(ASSUMED_MAX_DOCUMENT_BYTES + 1)

      broadcastTendersData(document as unknown as TendersData)

      expect(received).toHaveLength(0)
    })
  })

  describe('IPC outer payload size bound', () => {
    // The outer `SaveTendersRequest` must be measured and rejected before the
    // store performs structuredClone/validation work. The observable contract is:
    //   - rejection result (typed persistence failure, no `data`)
    //   - no store write
    //   - no `store-changed-v2` broadcast
    //   - payload-size failure takes precedence over schema issues
    //
    // Required hook (production): enforce `MAX_TENDERS_IPC_PAYLOAD_BYTES` at the
    // IPC boundary (or at the very start of `commit`) by measuring the raw
    // serialized request before cloning or validating it. If the reviewer wants
    // the pre-clone *timing* asserted directly, add an injectable seam such as
    // `CreateTendersStoreOptions.measurePayloadBytes?: (request) => number`
    // (or an injectable clone), so the test can assert measurement happens
    // before the first clone without relying on wall-clock timing.
    let ipcUserDataDir = ''

    function ipcStorePath(): string {
      return join(ipcUserDataDir, 'tenders', TENDERS_PERSISTENCE_FILE_NAME)
    }

    beforeAll(async () => {
      ipcUserDataDir = await mkdtemp(join(tmpdir(), `tenders-bounds-ipc-${randomUUID()}-`))
      userDataState.dir = ipcUserDataDir
      registerTendersIpc()
    })

    afterAll(async () => {
      stopTendersStoreWatcher()
      if (ipcUserDataDir) await rm(ipcUserDataDir, { recursive: true, force: true })
    })

    beforeEach(async () => {
      await rm(ipcStorePath(), { force: true })
    })

    it('rejects an oversized save request before any store write or broadcast', async () => {
      const sender = makeReceiver()
      const handler = ipcHandlers.get(TENDERS_CHANNELS.saveStoreV2)
      expect(handler).toBeDefined()
      const request = {
        expectedRevision: 0,
        document: validData(),
        padding: 'X'.repeat(ASSUMED_MAX_IPC_PAYLOAD_BYTES),
      }
      expect(byteLength(request)).toBeGreaterThan(ASSUMED_MAX_IPC_PAYLOAD_BYTES)

      const result = await handler!({ sender: sender.webContents }, request)

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected oversized IPC request to be rejected')
      expect(['INVALID_REQUEST', 'INVALID_DATA']).toContain(result.error.code)
      expect(result.error.message).toMatch(/size|limit|large|exceed|byte|payload/i)
      expect(result).not.toHaveProperty('data')
      await expect(stat(ipcStorePath())).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        sender.received.filter((entry) => entry.channel === TENDERS_CHANNELS.storeChangedV2),
      ).toHaveLength(0)
    })

    it('reports the payload-size failure instead of schema issues, proving the guard precedes validation', async () => {
      const sender = makeReceiver()
      const handler = ipcHandlers.get(TENDERS_CHANNELS.saveStoreV2)
      expect(handler).toBeDefined()
      const request = {
        expectedRevision: 0,
        document: { ...validData(), activeCompanyId: 'missing-workspace' },
        padding: 'X'.repeat(ASSUMED_MAX_IPC_PAYLOAD_BYTES),
      }

      const result = await handler!({ sender: sender.webContents }, request)

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Expected oversized IPC request to be rejected')
      expect(result.error.message).toMatch(/size|limit|large|exceed|byte|payload/i)
      expect(result.error.schemaIssues ?? []).toHaveLength(0)
      await expect(stat(ipcStorePath())).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        sender.received.filter((entry) => entry.channel === TENDERS_CHANNELS.storeChangedV2),
      ).toHaveLength(0)
    })
  })

  describe('existing valid fixtures', () => {
    it('keeps ordinary empty, v2, and migrated v1 fixtures accepted', () => {
      expect(validateTendersDataV2(createEmptyTendersDataV2(ORIGINAL_ISO)).ok).toBe(true)
      expect(validateTendersDataV2(validData()).ok).toBe(true)

      const v1: TendersDataV1 = {
        version: 1,
        updatedAt: ORIGINAL_ISO,
        activeCompanyId: 'workspace-0',
        workspaces: [toV1Workspace(makeWorkspace(0, { tenders: [makeTender(0)] }))],
        issuerTemplates: [makeIssuer(0)],
      }
      const migrated = migrateTendersDataV1(v1, ORIGINAL_ISO)
      expect(migrated.ok).toBe(true)
    })

    it('round-trips the ordinary valid fixture through the authoritative store', async () => {
      const directory = await uniqueDirectory('valid-roundtrip')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })

      const saved = await store.save({ expectedRevision: 0, document: validData() })
      expect(saved.ok).toBe(true)

      const loaded = await store.load()
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) throw new Error(`Expected round-trip load: ${loaded.error.code}`)
      expect(loaded.data.revision).toBe(1)
    })
  })
})

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Security review sec-2: resource-bound contract for the authoritative Tenders
// persistence path.
//
//   MAX_TENDERS_STORE_FILE_BYTES          = 8 * 1024 * 1024       (load raw file)
//   MAX_TENDERS_DOCUMENT_BYTES            = 4 * 1024 * 1024       (save + broadcast)
//   MAX_TENDERS_WORKSPACES                = 100
//   MAX_TENDERS_CUSTOMERS_PER_WORKSPACE   = 10_000
//   MAX_TENDERS_VAULT_DOCS_PER_WORKSPACE  = 10_000
//   MAX_TENDERS_TENDERS_PER_WORKSPACE     = 5_000
//   MAX_TENDERS_REQUIREMENTS_PER_TENDER   = 5_000
//   MAX_TENDERS_MILESTONES_PER_TENDER     = 5_000
//   MAX_TENDERS_ISSUER_TEMPLATES          = 1_000
//   MAX_TENDERS_SINGLE_STRING_CHARS       = 32_768
//   MAX_TENDERS_AGGREGATE_STRING_CHARS    = 4 * 1024 * 1024  (never binds first)
//   MAX_TENDERS_DYNAMIC_ENTRIES           = 2_000
//   MAX_TENDERS_DYNAMIC_KEY_CHARS         = 256
//   MAX_TENDERS_SCHEMA_ISSUES             = 500
//   MAX_TENDERS_REQUIRED_DOCS_PER_CUSTOMER        = 1_000
//   MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT = 1_000
//   MAX_TENDERS_REVIEW_CONFLICTS                  = 128
//   MAX_TENDERS_PAGE_STATES                       = 5_000
//   MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD       = 16
//   MAX_TENDERS_IPC_PAYLOAD_BYTES                 = 5 * 1024 * 1024  (outer IPC request)
// ─────────────────────────────────────────────────────────────────────────────

const ORIGINAL_ISO = '2026-08-20T09:15:30.000Z'
const CLOCK_ISO = '2026-09-14T10:11:12.345Z'
const FIXED_NOW = new Date(CLOCK_ISO)

const ASSUMED_MAX_STORE_FILE_BYTES = 8 * 1024 * 1024
const ASSUMED_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
const ASSUMED_MAX_WORKSPACES = 100
const ASSUMED_MAX_CUSTOMERS_PER_WORKSPACE = 10_000
const ASSUMED_MAX_VAULT_DOCS_PER_WORKSPACE = 10_000
const ASSUMED_MAX_TENDERS_PER_WORKSPACE = 5_000
const ASSUMED_MAX_REQUIREMENTS_PER_TENDER = 5_000
const ASSUMED_MAX_MILESTONES_PER_TENDER = 5_000
const ASSUMED_MAX_ISSUER_TEMPLATES = 1_000
const ASSUMED_MAX_SINGLE_STRING_CHARS = 32_768
/**
 * Equal to the document byte ceiling in characters: the aggregate text bound is
 * held above the byte bound so it can never be the document's binding limit (see
 * `MAX_TENDERS_AGGREGATE_STRING_CHARS`). It is a backstop, not a budget.
 */
const ASSUMED_MAX_AGGREGATE_STRING_CHARS = 4 * 1024 * 1024
const ASSUMED_MAX_DYNAMIC_ENTRIES = 2_000
const ASSUMED_MAX_DYNAMIC_KEY_CHARS = 256
const ASSUMED_MAX_SCHEMA_ISSUES = 500
const ASSUMED_MAX_REQUIRED_DOCS_PER_CUSTOMER = 1_000
const ASSUMED_MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT = 1_000
const ASSUMED_MAX_REVIEW_CONFLICTS = 128
const ASSUMED_MAX_PAGE_STATES = 5_000
const ASSUMED_MAX_REVIEW_CANDIDATES_PER_FIELD = 16
const ASSUMED_MAX_IPC_PAYLOAD_BYTES = 5 * 1024 * 1024

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
import { createManagedDocumentStore } from '../src/main/document-store'
import { TENDERS_CHANNELS } from '../src/shared/ipc'
import {
  TENDERS_PERSISTENCE_FILE_NAME,
  type SaveTendersResult,
} from '../src/shared/tenders-persistence'
import {
  MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT,
  MAX_TENDERS_AGGREGATE_STRING_CHARS,
  MAX_TENDERS_DOCUMENT_BYTES,
  MAX_TENDERS_IPC_PAYLOAD_BYTES,
  MAX_TENDERS_MANAGED_FILES,
  MAX_TENDERS_MANAGED_INDEX_BYTES,
  MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD,
  MAX_TENDERS_REQUIREMENTS_PER_TENDER,
  MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD,
  MAX_TENDERS_STORE_FILE_BYTES,
} from '../src/shared/tenders-persistence'
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

/**
 * String content counted the way the schema's aggregate bound counts it: every
 * string value, object keys excluded.
 */
function aggregateChars(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (!value || typeof value !== 'object') return 0
  let total = 0
  for (const child of Object.values(value as Record<string, unknown>)) {
    total += aggregateChars(child)
  }
  return total
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
 * `targetBytes`. Tenders (one requirement each) are grown until one more would
 * overshoot, then the last requirement's `notes` is padded (one ASCII byte per
 * character) to land precisely on the target. One tender is ~650 bytes, so the
 * padding needed is well under the single-string cap and the aggregate string
 * total stays under the aggregate cap.
 */
function buildDocumentAtBytes(targetBytes: number, revision = 0): TendersDataV2 {
  const build = (tenderCount: number, padding: number): TendersDataV2 => {
    const workspaces: TendersWorkspaceV2[] = []
    let remaining = tenderCount
    let workspaceIndex = 0
    while (remaining > 0 && workspaces.length < ASSUMED_MAX_WORKSPACES) {
      const count = Math.min(ASSUMED_MAX_TENDERS_PER_WORKSPACE, remaining)
      remaining -= count
      workspaces.push(
        makeWorkspace(workspaceIndex, {
          tenders: Array.from({ length: count }, (_, index) =>
            makeTender(workspaceIndex * 10_000 + index, {
              requirements: [makeRequirement(index)],
            }),
          ),
        }),
      )
      workspaceIndex += 1
    }
    if (padding > 0) {
      const last = workspaces[workspaces.length - 1]
      last.tenders[last.tenders.length - 1].requirements[0].notes = 'P'.repeat(padding)
    }
    return { ...makeData(workspaces), revision }
  }

  // 500 bytes is a safe lower bound for one tender, so the search never builds a
  // document materially larger than the target.
  let low = 0
  let high = Math.ceil(targetBytes / 500)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (byteLength(build(mid, 0)) <= targetBytes) low = mid
    else high = mid - 1
  }

  const baseBytes = byteLength(build(low, 0))
  let padding = targetBytes - baseBytes
  if (padding > 0) {
    // Adding the `notes` key itself costs a fixed overhead; measure and subtract it
    // so the padding lands exactly on the target rather than that many bytes over.
    padding -= byteLength(build(low, padding)) - (baseBytes + padding)
  }
  if (low < 1 || padding < 0 || padding > ASSUMED_MAX_SINGLE_STRING_CHARS) {
    throw new Error(
      `Cannot deterministically reach ${targetBytes} bytes (base=${baseBytes}, padding=${padding}).`,
    )
  }
  const document = build(low, padding)
  if (byteLength(document) !== targetBytes) {
    throw new Error(`Reached ${byteLength(document)} bytes instead of ${targetBytes}.`)
  }
  return document
}

/**
 * The document shape intake verification creates at its own caps: one shredded
 * tender with 5 000 requirements, 5 000 per-page extraction states, 5 000
 * requirement reviews and 16 candidates for each of the eight readiness-critical
 * fields. Measured at 3 026 314 compact bytes — 1.9x the 1.5 MiB ceiling this
 * suite pins — so it is the regression fixture for the wedge.
 */
function heavyWorkspaceDocument(): TendersDataV2 {
  const fieldReview = (index: number) => ({
    extractedValue: `Extracted value ${index}`,
    sourcePage: index + 1,
    sourceClause: `Clause ${index}`,
    confidence: 0.9,
    candidates: Array.from({ length: ASSUMED_MAX_REVIEW_CANDIDATES_PER_FIELD }, (_, candidate) => ({
      value: `Candidate ${candidate} for field ${index}`,
      sourcePage: candidate + 1,
      sourceClause: `Clause ${candidate}`,
      score: 0.5,
    })),
    state: 'confirmed' as const,
    reviewedAt: ORIGINAL_ISO,
  })
  return makeData([
    makeWorkspace(0, {
      tenders: [
        makeTender(0, {
          numPages: ASSUMED_MAX_PAGE_STATES,
          ocrPages: 0,
          requirements: Array.from({ length: ASSUMED_MAX_REQUIREMENTS_PER_TENDER }, (_, index) =>
            makeRequirement(index),
          ),
          intakeVerification: {
            fields: {
              title: fieldReview(0),
              referenceNumber: fieldReview(1),
              issuingBody: fieldReview(2),
              contactEmail: fieldReview(3),
              closingDate: fieldReview(4),
              submissionMethod: fieldReview(5),
              submissionDestination: fieldReview(6),
              estimatedValue: fieldReview(7),
            },
            requirements: Object.fromEntries(
              Array.from({ length: ASSUMED_MAX_REQUIREMENTS_PER_TENDER }, (_, index) => [
                `req-${index}`,
                {
                  state: 'verified' as const,
                  originalTitle: `Requirement ${index}`,
                  originalCategory: 'GENERAL_RETURNABLE',
                  correctedAt: ORIGINAL_ISO,
                },
              ]),
            ),
            pages: Array.from({ length: ASSUMED_MAX_PAGE_STATES }, (_, index) => ({
              pageNumber: index + 1,
              state: 'manually-reviewed' as const,
              method: null,
              confidence: null,
              reviewedAt: ORIGINAL_ISO,
            })),
            contactEmail: null,
            conflicts: [],
            createdAt: ORIGINAL_ISO,
            updatedAt: ORIGINAL_ISO,
          },
        }),
      ],
    }),
  ])
}

/**
 * Schema-valid document whose *pretty-printed* size is far larger than its
 * compact size: an empty string in an array costs three compact bytes and a full
 * indented line (measured ratio 3.57 for this shape). Used to prove the store
 * never writes a file the loader would reject.
 */
function emptyStringConflictsDocument(tenderCount: number, revision = 0): TendersDataV2 {
  return {
    ...makeData([
      makeWorkspace(0, {
        tenders: Array.from({ length: tenderCount }, (_, index) =>
          makeTender(index, {
            requirements: [],
            intakeVerification: {
              fields: {},
              requirements: {},
              conflicts: Array.from({ length: ASSUMED_MAX_REVIEW_CONFLICTS }, () => ''),
              contactEmail: null,
              createdAt: ORIGINAL_ISO,
              updatedAt: ORIGINAL_ISO,
            },
          }),
        ),
      }),
    ]),
    revision,
  }
}

function expectSchemaValid(result: ReturnType<typeof validateTendersDataV2>): void {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`Expected valid data, received ${result.error.code}`)
}

function expectSaveSuccess(
  result: SaveTendersResult,
): asserts result is Extract<SaveTendersResult, { ok: true }> {
  expect(result.ok).toBe(true)
  if ('error' in result) throw new Error(`Expected save success, received ${result.error.code}`)
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

    it('accepts a text-heavy document just below the aggregate string ceiling', () => {
      const perString = ASSUMED_MAX_SINGLE_STRING_CHARS
      // The most content a fixture can build one 32 KiB string at a time and still
      // fit: 127 * 32 KiB = 4,161,536 characters, below the ceiling even after the
      // fixed identifiers and titles are counted.
      const count = Math.floor(ASSUMED_MAX_AGGREGATE_STRING_CHARS / perString) - 1
      const document = makeData([
        makeWorkspace(0, {
          tenders: [
            makeTender(0, {
              numPages: 1,
              requirements: Array.from({ length: count }, (_, index) =>
                makeRequirement(index, { notes: 'A'.repeat(perString) }),
              ),
            }),
          ],
        }),
      ])
      expect(aggregateChars(document)).toBeLessThanOrEqual(ASSUMED_MAX_AGGREGATE_STRING_CHARS)
      expectSchemaValid(validateTendersDataV2(document))
    })

    it('rejects aggregate string content above the aggregate string ceiling', () => {
      const perString = ASSUMED_MAX_SINGLE_STRING_CHARS
      // One 32 KiB string beyond what the ceiling admits (129 * 32 KiB = 4,227,072
      // characters) — the finest boundary step available at the single-string cap.
      const count = Math.floor(ASSUMED_MAX_AGGREGATE_STRING_CHARS / perString) + 1
      const document = makeData([
        makeWorkspace(0, {
          tenders: [
            makeTender(0, {
              numPages: 1,
              requirements: Array.from({ length: count }, (_, index) =>
                makeRequirement(index, { notes: 'A'.repeat(perString) }),
              ),
            }),
          ],
        }),
      ])
      expect(aggregateChars(document)).toBeGreaterThan(ASSUMED_MAX_AGGREGATE_STRING_CHARS)
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

  describe('documented byte ceilings', () => {
    it('exports the documented ceilings and keeps them ordered so no smaller cap binds first', () => {
      expect(MAX_TENDERS_DOCUMENT_BYTES).toBe(ASSUMED_MAX_DOCUMENT_BYTES)
      expect(MAX_TENDERS_IPC_PAYLOAD_BYTES).toBe(ASSUMED_MAX_IPC_PAYLOAD_BYTES)
      expect(MAX_TENDERS_STORE_FILE_BYTES).toBe(ASSUMED_MAX_STORE_FILE_BYTES)
      expect(MAX_TENDERS_AGGREGATE_STRING_CHARS).toBe(ASSUMED_MAX_AGGREGATE_STRING_CHARS)
      // The envelope ceiling must never bind before the document ceiling the
      // renderer mirrors and reports with an actionable message.
      expect(ASSUMED_MAX_IPC_PAYLOAD_BYTES).toBeGreaterThan(ASSUMED_MAX_DOCUMENT_BYTES)
      // The document ceiling is at most half the store-file ceiling: the committed
      // file is the same document pretty-printed, which measured ~1.8x for
      // record-heavy documents. Any document whose indented form would not fit is
      // refused by the store before it can replace a readable primary.
      expect(ASSUMED_MAX_DOCUMENT_BYTES).toBeLessThanOrEqual(ASSUMED_MAX_STORE_FILE_BYTES / 2)
      // The aggregate *text* ceiling must never bind before the byte ceiling either,
      // or the refusal names no field and no way forward. Every counted character
      // costs at least one byte of the compact JSON the byte ceiling measures (keys,
      // punctuation and escapes add bytes without adding characters), so holding the
      // character ceiling at the byte ceiling makes it unreachable by construction.
      expect(MAX_TENDERS_AGGREGATE_STRING_CHARS).toBeGreaterThanOrEqual(MAX_TENDERS_DOCUMENT_BYTES)
    })
  })

  describe('save and broadcast serialized size bounds', () => {
    it('commits the measured intake-verification workspace the previous ceiling rejected', async () => {
      const directory = await uniqueDirectory('heavy-workspace')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      const document = heavyWorkspaceDocument()
      const bytes = byteLength(document)

      // Measured 3 026 314 bytes: one tender at the requirement cap with page
      // states, requirement reviews and 16 candidates per readiness-critical
      // field. It is 1.9x the 1.5 MiB ceiling this fix raises, so this is the
      // regression test for the wedge (every autosave failed, no way out).
      expect(bytes).toBeGreaterThan(1.5 * 1024 * 1024)
      expect(bytes).toBeLessThanOrEqual(ASSUMED_MAX_DOCUMENT_BYTES)
      // The same fixture carries 910 274 counted characters — 87% of the old 1 MiB
      // aggregate text ceiling — so a document only ~15% larger than it was refused
      // with a message naming no field: the same non-actionable wedge. At least 2x
      // headroom is the guard that the text ceiling cannot become the binding
      // document bound again.
      const chars = aggregateChars(document)
      expect(chars).toBeLessThan(ASSUMED_MAX_AGGREGATE_STRING_CHARS)
      expect(chars * 2).toBeLessThanOrEqual(ASSUMED_MAX_AGGREGATE_STRING_CHARS)
      expectSchemaValid(validateTendersDataV2(document))

      const saved = await store.save({ expectedRevision: 0, document })

      expectSaveSuccess(saved)
      expect(saved.data.revision).toBe(1)
      const loaded = await store.load()
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) throw new Error(`Expected heavy workspace to load: ${loaded.error.code}`)
      const tender = loaded.data.workspaces[0].tenders[0]
      expect(tender.requirements).toHaveLength(ASSUMED_MAX_REQUIREMENTS_PER_TENDER)
      expect(tender.intakeVerification?.pages).toHaveLength(ASSUMED_MAX_PAGE_STATES)
      // `fields` is a partial map, so the title field is optional here: a fixture
      // that failed to decide it must fail this assertion, which is why the
      // optional read is what keeps the assertion honest rather than a claim that
      // the member is always there.
      expect(tender.intakeVerification?.fields.title?.candidates).toHaveLength(
        ASSUMED_MAX_REVIEW_CANDIDATES_PER_FIELD,
      )
    })

    it('rejects an oversized document as INVALID_DATA before writing and preserves the prior file', async () => {
      const directory = await uniqueDirectory('save-too-large')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      const prior = await store.save({ expectedRevision: 0, document: validData() })
      expect(prior.ok).toBe(true)
      const priorBytes = await readFile(storePath(directory), 'utf8')

      const oversized = buildDocumentAtBytes(ASSUMED_MAX_DOCUMENT_BYTES + 1, 1)
      expect(byteLength(oversized)).toBe(ASSUMED_MAX_DOCUMENT_BYTES + 1)
      const rejected = await store.save({ expectedRevision: 1, document: oversized })

      expect(rejected.ok).toBe(false)
      if (rejected.ok) throw new Error('Expected oversized document to be rejected')
      expect(rejected.error.code).toBe('INVALID_DATA')
      expect(rejected.error.message).toMatch(/size|limit|large|exceed|byte/i)
      expect(rejected).not.toHaveProperty('data')
      expect(await readFile(storePath(directory), 'utf8')).toBe(priorBytes)
    })

    it('accepts a document whose serialized size is exactly at the documented maximum and writes a file the loader reads back', async () => {
      const directory = await uniqueDirectory('save-at-limit')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      const document = buildDocumentAtBytes(ASSUMED_MAX_DOCUMENT_BYTES, 0)
      expect(byteLength(document)).toBe(ASSUMED_MAX_DOCUMENT_BYTES)

      const result = await store.save({ expectedRevision: 0, document })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(`Expected at-limit document to save: ${result.error.code}`)
      expect(result.data.revision).toBe(1)
      // The committed file is the same document pretty-printed, so a document at
      // the compact ceiling must still leave the file inside the store-file
      // ceiling the loader enforces on read.
      const onDisk = await stat(storePath(directory))
      expect(onDisk.size).toBeLessThanOrEqual(ASSUMED_MAX_STORE_FILE_BYTES)
      const loaded = await store.load()
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) throw new Error(`Expected at-limit file to load: ${loaded.error.code}`)
      expect(loaded.data.revision).toBe(1)
    })

    it('refuses a document whose pretty-printed file would exceed the store-file ceiling without replacing the readable primary', async () => {
      const directory = await uniqueDirectory('save-file-ceiling')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      const prior = await store.save({ expectedRevision: 0, document: validData() })
      expectSaveSuccess(prior)
      const priorBytes = await readFile(storePath(directory), 'utf8')

      // Schema-valid and inside the compact ceiling, but its indented form does not
      // fit the store-file ceiling: committing it would leave a primary the loader
      // refuses (a post-rename read-back failure), so the store must not write.
      const document = emptyStringConflictsDocument(3_000, 1)
      expectSchemaValid(validateTendersDataV2(document))
      expect(byteLength(document)).toBeLessThanOrEqual(ASSUMED_MAX_DOCUMENT_BYTES)
      expect(Buffer.byteLength(JSON.stringify(document, null, 2), 'utf8')).toBeGreaterThan(
        ASSUMED_MAX_STORE_FILE_BYTES,
      )

      const rejected = await store.save({ expectedRevision: 1, document })

      expect(rejected.ok).toBe(false)
      if (rejected.ok) throw new Error('Expected the store-file ceiling to reject the commit')
      expect(rejected.error.code).toBe('INVALID_DATA')
      expect(rejected.error.message).toMatch(/store file|on disk/i)
      expect(rejected.error.message).toMatch(String(ASSUMED_MAX_STORE_FILE_BYTES))
      expect(rejected).not.toHaveProperty('data')
      expect(await readFile(storePath(directory), 'utf8')).toBe(priorBytes)
      // No temp artifact and no backup were created for a refused commit.
      expect(await readdir(directory)).toEqual([TENDERS_PERSISTENCE_FILE_NAME])
      const loaded = await store.load()
      expect(loaded.ok).toBe(true)
      if (!loaded.ok)
        throw new Error(`Expected the prior document to survive: ${loaded.error.code}`)
      expect(loaded.data.revision).toBe(1)
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

// ── what the managed-index ceiling does and does not bound ────────────────────
//
// The claim this replaces: `MAX_TENDERS_MANAGED_INDEX_BYTES` was documented as
// *the memory/IO bound*, which it is not. It measures the COMPACT SERIALIZED bytes
// of `<baseDir>/managed-documents.json`; the live objects `JSON.parse` produces are
// several times larger, and an index at or over the ceiling is still read and still
// written by the non-growing lifecycle paths. The claim it does support — an index
// this large can no longer GROW through the app — is what `writeIndex` enforces,
// and both halves are measured here on a real index read by the real store.

describe('the managed-index ceiling is a serialized-bytes growth cap, not a memory cost', () => {
  /** One index record at the store's own 80-character name clamp. */
  function seedRecord(index: number): Record<string, unknown> {
    const name = `${String(index).padStart(5, '0')}-${'n'.repeat(70)}.pdf`
    return {
      id: `mf-bounds-${index}`,
      category: 'rfp',
      relativePath: `documents/${name}`,
      fileName: name,
      mimeType: 'application/pdf',
      size: 1_000_000,
      hash: 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      state: 'active',
    }
  }

  /**
   * A record adopted from a file the app did not write, so its name is far past
   * the clamp `writeIndex` applies — the residual the constant's own comment
   * discloses. These are what make the BYTE ceiling reachable below the record
   * count cap, which is the case that matters for the over-ceiling disclosure.
   */
  function longNamedRecord(index: number): Record<string, unknown> {
    const name = `${String(index).padStart(5, '0')}-${'x'.repeat(4_000)}.pdf`
    return {
      id: `mf-long-${index}`,
      category: 'rfp',
      relativePath: `documents/${name}`,
      fileName: name,
      mimeType: 'application/pdf',
      size: 1_000_000,
      hash: 'b'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      state: 'active',
    }
  }

  function serialize(records: Array<Record<string, unknown>>): string {
    return JSON.stringify({ version: 1, updatedAt: '2026-01-01T00:00:00.000Z', records })
  }

  /** Write an index file directly — the same compact shape `writeIndex` writes. */
  async function storeWithIndex(
    records: Array<Record<string, unknown>>,
  ): Promise<{ baseDir: string; bytes: number }> {
    const baseDir = await mkdtemp(join(tmpdir(), 'tenders-index-bound-'))
    await mkdir(join(baseDir, 'documents'), { recursive: true })
    await writeFile(join(baseDir, 'managed-documents.json'), serialize(records), 'utf8')
    return { baseDir, bytes: Buffer.byteLength(serialize(records), 'utf8') }
  }

  /** Enough long-named records to put the file past the byte ceiling, under the count cap. */
  async function overCeilingRecords(): Promise<Array<Record<string, unknown>>> {
    const records = Array.from({ length: 600 }, (_, index) => longNamedRecord(index))
    const { baseDir } = await storeWithIndex(records)
    await rm(baseDir, { recursive: true, force: true })
    expect(Buffer.byteLength(serialize(records), 'utf8')).toBeGreaterThan(
      MAX_TENDERS_MANAGED_INDEX_BYTES,
    )
    expect(records.length).toBeLessThan(MAX_TENDERS_MANAGED_FILES)
    return records
  }

  it('measures live objects several times the serialized bytes, so it is not a memory bound', async () => {
    const { baseDir } = await storeWithIndex(
      Array.from({ length: 5_000 }, (_, index) => seedRecord(index)),
    )
    try {
      const serialized = await readFile(join(baseDir, 'managed-documents.json'), 'utf8')
      const before = process.memoryUsage()
      const listed = await createManagedDocumentStore({ baseDir }).listRecords()
      const after = process.memoryUsage()
      expect(listed).toHaveLength(5_000)

      const multiple = (after.heapUsed - before.heapUsed) / Buffer.byteLength(serialized, 'utf8')
      // Measured 5.05x. Asserted with slack for a different V8 heap layout, but far
      // enough above 1x that "the serialized size IS the memory cost" is refuted by
      // this test rather than merely unproven.
      expect(
        multiple,
        'a parsed index costs several times its serialized size in live objects',
      ).toBeGreaterThan(2)
      // ...and the shape a store-written index has sits well inside the ceiling, so
      // the count cap is what a full store reports.
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(MAX_TENDERS_MANAGED_INDEX_BYTES)
      expect(5_000 * MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD).toBeLessThanOrEqual(
        MAX_TENDERS_MANAGED_INDEX_BYTES,
      )
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('still reads and writes an index that is already over the ceiling', async () => {
    // The residual the comment discloses, pinned rather than assumed: an index over
    // the ceiling is READ in full, and a write that adds no record is allowed past
    // it, so a full index can never wedge the user out of deleting a document.
    const records = await overCeilingRecords()
    const { baseDir } = await storeWithIndex(records)
    try {
      const store = createManagedDocumentStore({ baseDir })
      const listed = await store.listRecords()
      expect(listed, 'an over-ceiling index is read, never refused').toHaveLength(records.length)

      // A non-growing write on that index: the record's file is not on disk, so
      // the store marks it `missing` and WRITES the index back. The refusal it
      // reports is about the file, never about the index size.
      const trashed = await store.trash(listed[0]!.relativePath)
      expect(trashed.ok).toBe(false)
      if (trashed.ok) throw new Error('a missing file is reported, not moved')
      expect(trashed.error).toMatch(/not found on disk/i)
      expect(trashed.error).not.toMatch(/index is full/i)
      const after = await store.listRecords()
      expect(after.find((record) => record.id === listed[0]!.id)?.state).toBe('missing')

      // Emptying the trash is the other non-growing write, and the way back under
      // the ceiling.
      const emptied = await store.cleanupTrash({ all: true })
      expect(emptied.ok, 'an over-ceiling index must not block emptying the trash').toBe(true)
      expect(
        (await store.listRecords()).filter((record) => record.state === 'trashed'),
      ).toHaveLength(0)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('refuses a GROWING write past the ceiling, which is the claim it does support', async () => {
    // The same over-ceiling index with a record added: this is the check the
    // ceiling exists for, and the refusal names the index rather than a count —
    // reachable below the record cap only with a name the app did not write, which
    // is exactly the residual documented on the constant.
    const records = await overCeilingRecords()
    const { baseDir } = await storeWithIndex(records)
    try {
      const refused = await createManagedDocumentStore({ baseDir }).save({
        fileName: 'new-rfp.pdf',
        buffer: Buffer.from('x'),
        category: 'rfp',
      })
      expect(refused.ok).toBe(false)
      if (refused.ok) throw new Error('an over-ceiling index must refuse a growing write')
      expect(refused.error).toMatch(/index is full/i)
      expect(refused.error).toMatch(new RegExp(String(MAX_TENDERS_MANAGED_INDEX_BYTES)))
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })
})

// ── the AI core's numeric mirrors, pinned to what they mirror ─────────────────
//
// `shared/ai-extraction.ts` is a plain local module that may not import
// `tenders-persistence.ts`, so it RESTATES three of its bounds instead of reading
// them (the docs record this as an open gap: "the three numeric mirrors are not
// pinned by any test yet"). This closes it from the persistence side, by reading
// the constants out of the core's own source — the technique the suite already uses
// for values a module cannot import.
//
// It matters because a mirror that drifts is a mirror that promises something the
// document will refuse: a result set larger than the tender cap fails the whole
// save, and a candidate list longer than the per-field cap rejects the document on
// its next autosave.

describe('the AI core’s numeric mirrors of the persistence bounds', () => {
  /** Locate the core from either cwd (`-w` or repo root). */
  function coreSource(): string {
    let dir = process.cwd()
    for (let depth = 0; depth < 6; depth += 1) {
      for (const candidate of [
        join(dir, 'src', 'shared', 'ai-extraction.ts'),
        join(dir, 'apps', 'tenders', 'src', 'shared', 'ai-extraction.ts'),
      ]) {
        try {
          return readFileSync(candidate, 'utf8')
        } catch {
          // try the next location
        }
      }
      dir = dirname(dir)
    }
    throw new Error(`Could not locate src/shared/ai-extraction.ts from ${process.cwd()}`)
  }

  const AI_CORE_SOURCE = coreSource()

  function coreConstant(name: string): number {
    const match = new RegExp(`export const ${name} = ([0-9_]+)`).exec(AI_CORE_SOURCE)
    if (!match) throw new Error(`shared/ai-extraction.ts no longer exports ${name}`)
    return Number(match[1]!.replace(/_/g, ''))
  }

  it('mirrors the tender requirement cap exactly', () => {
    expect(coreConstant('MAX_REQUIREMENTS_PER_RESULT')).toBe(MAX_TENDERS_REQUIREMENTS_PER_TENDER)
  })

  it('mirrors the per-field candidate cap exactly', () => {
    expect(coreConstant('MAX_METADATA_CANDIDATES_PER_FIELD')).toBe(
      MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD,
    )
  })

  it('holds the additional-clause cap far below the document’s own', () => {
    // Not a mirror: deliberately far below, because one requirement may carry many
    // quoted clauses and the document cap is per requirement, not per reply.
    const core = coreConstant('MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT')
    expect(core).toBeLessThanOrEqual(MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT)
    expect(core).toBeLessThan(MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT / 10)
  })
})

/**
 * Phase 4 / WP-11 + WP-8 — authoritative store actions.
 *
 * The store is the only writer of the v2 document; these tests exercise the
 * lifecycle state machine through the real store actions, the override audit,
 * and the company/customer archive/restore CRUD, asserting the mutations reach
 * `saveStoreV2` (CAS revision tracking) and never touch localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CompanyProfile,
  Customer,
  RequirementRecord,
  TenderRecord,
  TendersDataV2,
  TendersWorkspaceV2,
  VaultDoc,
} from '../src/shared/types'
import type {
  SaveTendersRequest,
  SaveTendersResult,
  TendersLoadResult,
} from '../src/shared/tenders-persistence'
import { civilDateToRfc3339 } from '../src/renderer/src/components/OutcomeDialog'
import { validateTendersDataV2 } from '../src/shared/tenders-schema'
import type { TendersState } from '../src/renderer/src/store'

const STORE_MODULE = '../src/renderer/src/store'
const AT = '2026-09-01T00:00:00.000Z'
const NEXT = '2026-09-01T00:00:01.000Z'

type ApiMock = {
  loadStoreV2: ReturnType<typeof vi.fn>
  saveStoreV2: ReturnType<typeof vi.fn>
  onStoreChangedV2: ReturnType<typeof vi.fn>
}

let api: ApiMock

function installTendersApiMock(): void {
  api = {
    loadStoreV2: vi.fn(),
    saveStoreV2: vi.fn(),
    onStoreChangedV2: vi.fn(() => () => {}),
  }
  ;(window as unknown as Record<string, unknown>).tendersApi = api
}

beforeEach(() => {
  vi.resetModules()
  window.localStorage.clear()
  vi.useFakeTimers()
  installTendersApiMock()
})

afterEach(() => {
  vi.useRealTimers()
  window.localStorage.clear()
  ;(window as unknown as Record<string, unknown>).tendersApi = undefined
})

async function importStore(): Promise<{ getState: () => any }> {
  const mod = (await import(STORE_MODULE)) as unknown as {
    useTendersStore: { getState: () => any }
  }
  return mod.useTendersStore
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1000)
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function company(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    name: 'Test Co',
    tradingName: 'Test Co',
    registrationNumber: 'REG-1',
    vatNumber: 'VAT-1',
    taxPin: 'TAX-1',
    bbbeeLevel: 'Level 2',
    bbbeeBlackOwnership: '51%',
    csdSupplierNumber: 'CSD-1',
    founded: '2019',
    employees: '25',
    industry: 'Construction',
    description: 'Synthetic company.',
    address: '1 Test Street',
    phone: '+27 10 000 0000',
    email: 'test@example.test',
    website: 'https://example.test',
    directors: [],
    projects: [],
    ...overrides,
  }
}

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-1',
    name: 'Example Customer',
    contactName: 'Contact',
    contactEmail: 'c@example.test',
    contactPhone: '+27 10 000 0001',
    industry: 'Public sector',
    status: 'ACTIVE',
    since: '2025-01-01',
    notes: 'Synthetic.',
    requiredDocs: [],
    ...overrides,
  }
}

function vaultDoc(): VaultDoc {
  return {
    id: 'vd-1',
    title: 'Tax clearance',
    category: 'COMPLIANCE',
    fileUrl: 'vault/tax.pdf',
    issueDate: null,
    expiryDate: '2027-01-01',
    isCertified: false,
    certifiedDate: null,
    metadata: {},
  }
}

function requirement(): RequirementRecord {
  return {
    id: 'req-1',
    ruleKey: 'tax_pin',
    title: 'Tax clearance',
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    verbatimClause: 'A valid SARS tax clearance certificate must be submitted.',
    pageNumber: 1,
    boundingBox: { top: 0.1, left: 0.1, width: 0.8, height: 0.05 },
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 10,
    status: 'FULFILLED',
    linkedVaultDocId: 'vd-1',
    reason: null,
    suggestedVaultDocIds: [],
  }
}

function tender(overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: 'tender-1',
    title: 'Supply and Delivery of Office Computers',
    referenceNumber: 'ICT/2026/041',
    issuingBody: 'Provincial Administration Office',
    closingDate: '2026-12-18',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: null,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: AT,
    fileName: 'rfp.pdf',
    fileUrl: 'documents/rfp.pdf',
    numPages: 4,
    ocrPages: 0,
    requirements: [requirement()],
    ...overrides,
  }
}

function documentV2(tenderRecord: TenderRecord): TendersDataV2 {
  const workspace: TendersWorkspaceV2 = {
    id: 'ws-1',
    name: 'Test Co',
    dataOrigin: 'user',
    company: company(),
    customers: [customer()],
    vault: [vaultDoc()],
    tenders: [tenderRecord],
  }
  return {
    schemaVersion: 2,
    revision: 4,
    updatedAt: AT,
    activeCompanyId: 'ws-1',
    workspaces: [workspace],
    issuerTemplates: [],
  }
}

function loadOk(data: TendersDataV2): TendersLoadResult {
  return { ok: true, status: 'loaded', data, needsSave: false, warnings: [] }
}

function useSuccessfulSave(): void {
  api.saveStoreV2.mockImplementation(async (request: SaveTendersRequest) => {
    const result: SaveTendersResult = {
      ok: true,
      data: {
        ...clone(request.document),
        revision: request.expectedRevision + 1,
        updatedAt: NEXT,
      },
    }
    return result
  })
}

async function hydrate(tenderRecord = tender()): Promise<{ getState: () => any }> {
  api.loadStoreV2.mockResolvedValue(loadOk(documentV2(tenderRecord)))
  useSuccessfulSave()
  const store = await importStore()
  await store.getState().hydrateFromMain()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  return store
}

function savedDocument(index: number): TendersDataV2 {
  return (api.saveStoreV2.mock.calls[index][0] as SaveTendersRequest).document as TendersDataV2
}

function savedTender(index: number): TenderRecord {
  return savedDocument(index).workspaces[0].tenders[0]
}

describe('lifecycle store actions', () => {
  it('walks the assembly chain and persists the status with appended history', async () => {
    const store = await hydrate()
    const s = store.getState()

    expect(s.transitionTenderStatus('tender-1', 'READY_TO_ASSEMBLE')).toEqual({ ok: true })
    expect(s.transitionTenderStatus('tender-1', 'PACK_GENERATED')).toEqual({ ok: true })
    expect(
      s.transitionTenderStatus('tender-1', 'READY_FOR_SUBMISSION', { reason: 'pack ready' }),
    ).toEqual({ ok: true })
    await settle()

    const tenderNow = store.getState().tenders[0] as TenderRecord
    expect(tenderNow.status).toBe('READY_FOR_SUBMISSION')
    expect(tenderNow.lifecycle?.map((event) => event.to)).toEqual([
      'READY_TO_ASSEMBLE',
      'PACK_GENERATED',
      'READY_FOR_SUBMISSION',
    ])
    expect(tenderNow.lifecycle?.[2].reason).toBe('pack ready')

    const persisted = savedTender(api.saveStoreV2.mock.calls.length - 1)
    expect(persisted.status).toBe('READY_FOR_SUBMISSION')
    expect(persisted.lifecycle).toHaveLength(3)
  })

  it('denies an invalid transition without mutating state', async () => {
    const store = await hydrate()
    const s = store.getState()

    const denied = s.transitionTenderStatus('tender-1', 'WON')
    expect(denied.ok).toBe(false)
    expect(denied.error).toBeTruthy()
    await settle()

    expect((store.getState().tenders[0] as TenderRecord).status).toBe('IN_PROGRESS')
    expect(api.saveStoreV2).not.toHaveBeenCalled()
  })

  it('audits a blocker-overridden submission without ever claiming cleared', async () => {
    const store = await hydrate()
    const s = store.getState()
    s.transitionTenderStatus('tender-1', 'READY_TO_ASSEMBLE')
    s.transitionTenderStatus('tender-1', 'PACK_GENERATED')
    s.transitionTenderStatus('tender-1', 'READY_FOR_SUBMISSION')

    const blockedSnapshot = {
      ready: false,
      score: 40,
      failedCheckIds: ['requirements'],
      blockingCheckIds: ['requirements'],
      capturedAt: AT,
    }
    const denied = s.recordSubmission('tender-1', {
      submittedAt: AT,
      method: 'EMAIL',
      destination: 'tenders@example.test',
      readiness: blockedSnapshot,
      readinessIsCurrent: true,
    })
    expect(denied.ok).toBe(false)

    const allowed = s.recordSubmission('tender-1', {
      submittedAt: AT,
      method: 'EMAIL',
      destination: 'tenders@example.test',
      confirmationReference: 'REF-9',
      readiness: blockedSnapshot,
      readinessIsCurrent: true,
      blockerOverrideReason: 'Manager approved late submission.',
    })
    expect(allowed.ok).toBe(true)
    await settle()

    const tenderNow = store.getState().tenders[0] as TenderRecord
    expect(tenderNow.status).toBe('SUBMITTED')
    expect(tenderNow.submission?.blockerOverrideReason).toBe('Manager approved late submission.')
    expect(tenderNow.submission?.readiness?.ready).toBe(false)
    expect(tenderNow.submission?.readiness?.blockingCheckIds).toEqual(['requirements'])

    const persisted = savedTender(api.saveStoreV2.mock.calls.length - 1)
    expect(persisted.submission?.readiness?.ready).toBe(false)
    expect(persisted.submission?.blockerOverrideReason).toBe('Manager approved late submission.')
    expect(persisted.lifecycle?.at(-1)?.to).toBe('SUBMITTED')
  })

  it('records submission with a clear checkpoint, evidence, and a won outcome', async () => {
    const store = await hydrate()
    const s = store.getState()
    s.transitionTenderStatus('tender-1', 'READY_TO_ASSEMBLE')
    s.transitionTenderStatus('tender-1', 'PACK_GENERATED')
    s.transitionTenderStatus('tender-1', 'READY_FOR_SUBMISSION')

    const clearSnapshot = {
      ready: true,
      score: 100,
      failedCheckIds: [],
      blockingCheckIds: [],
      capturedAt: AT,
    }
    expect(
      s.recordSubmission('tender-1', {
        submittedAt: AT,
        method: 'ELECTRONIC',
        destination: 'https://portal.example.test',
        readiness: clearSnapshot,
        readinessIsCurrent: true,
      }).ok,
    ).toBe(true)
    expect((store.getState().tenders[0] as TenderRecord).status).toBe('SUBMITTED')

    // Evidence recorded moves to SUBMITTED_EVIDENCED without a re-checkpoint.
    expect(
      s.recordSubmission('tender-1', {
        submittedAt: AT,
        method: 'ELECTRONIC',
        destination: 'https://portal.example.test',
        evidence: { kind: 'portal-confirmation', reference: 'vd-1', note: 'receipt saved' },
        readiness: clearSnapshot,
        readinessIsCurrent: true,
      }).ok,
    ).toBe(true)
    expect((store.getState().tenders[0] as TenderRecord).status).toBe('SUBMITTED_EVIDENCED')

    expect(s.recordOutcome('tender-1', { status: 'won', awardedValue: 115000 }).ok).toBe(true)
    await settle()

    const tenderNow = store.getState().tenders[0] as TenderRecord
    expect(tenderNow.status).toBe('WON')
    expect(tenderNow.outcome?.status).toBe('won')
    expect(tenderNow.outcome?.awardedValue).toBe(115000)
    expect(tenderNow.submission?.evidence?.kind).toBe('portal-confirmation')

    const persisted = savedTender(api.saveStoreV2.mock.calls.length - 1)
    expect(persisted.status).toBe('WON')
    expect(persisted.submission?.readiness?.ready).toBe(true)
    expect(persisted.outcome?.status).toBe('won')
  })

  it('rejects an outcome that does not match the requested state', async () => {
    const store = await hydrate()
    const s = store.getState()
    s.transitionTenderStatus('tender-1', 'READY_TO_ASSEMBLE')
    s.transitionTenderStatus('tender-1', 'PACK_GENERATED')
    s.transitionTenderStatus('tender-1', 'READY_FOR_SUBMISSION')
    s.recordSubmission('tender-1', {
      submittedAt: AT,
      method: 'EMAIL',
      readiness: {
        ready: true,
        score: 100,
        failedCheckIds: [],
        blockingCheckIds: [],
        capturedAt: AT,
      },
      readinessIsCurrent: true,
    })

    // recordOutcome derives the target from the outcome status, so a mismatch
    // is only reachable through the generic transition action.
    const denied = s.transitionTenderStatus('tender-1', 'LOST', {
      outcome: {
        status: 'won',
        noticeDate: null,
        reason: null,
        awardedValue: null,
        evidenceReference: null,
        recordedAt: AT,
      },
    })
    expect(denied.ok).toBe(false)
    expect((store.getState().tenders[0] as TenderRecord).status).toBe('SUBMITTED')
  })

  it('persists an outcome recorded from the dialog civil date as a schema-valid RFC3339 record', async () => {
    const store = await hydrate()
    const s = store.getState()
    s.transitionTenderStatus('tender-1', 'READY_TO_ASSEMBLE')
    s.transitionTenderStatus('tender-1', 'PACK_GENERATED')
    s.transitionTenderStatus('tender-1', 'READY_FOR_SUBMISSION')
    s.recordSubmission('tender-1', {
      submittedAt: AT,
      method: 'EMAIL',
      readiness: {
        ready: true,
        score: 100,
        failedCheckIds: [],
        blockingCheckIds: [],
        capturedAt: AT,
      },
      readinessIsCurrent: true,
    })

    // Exactly what OutcomeDialog now sends for the E2E notice date '2026-10-01'.
    const outcome = s.recordOutcome('tender-1', {
      status: 'won',
      noticeDate: civilDateToRfc3339('2026-10-01'),
      awardedValue: 1250000,
    })
    expect(outcome.ok).toBe(true)
    await settle()

    const index = api.saveStoreV2.mock.calls.length - 1
    const persisted = savedTender(index)
    expect(persisted.status).toBe('WON')
    expect(persisted.outcome?.noticeDate).toBe('2026-10-01T00:00:00.000Z')
    expect(validateTendersDataV2(savedDocument(index)).ok).toBe(true)
  })
})

describe('company & customer CRUD (archive/restore)', () => {
  it('updates and soft-archives a customer without deleting it', async () => {
    const store = await hydrate()
    const s = store.getState()

    s.updateCustomer('cust-1', { name: 'Renamed Customer', notes: 'updated' })
    expect(store.getState().customers[0].name).toBe('Renamed Customer')

    s.archiveCustomer('cust-1')
    expect(store.getState().customers).toHaveLength(1)
    expect(store.getState().customers[0].archivedAt).toBeTruthy()

    s.restoreCustomer('cust-1')
    expect(store.getState().customers[0].archivedAt).toBeNull()
    await settle()

    const persisted = savedDocument(api.saveStoreV2.mock.calls.length - 1)
    const persistedCustomer = persisted.workspaces[0].customers[0]
    expect(persistedCustomer.name).toBe('Renamed Customer')
    expect(persistedCustomer.archivedAt).toBeNull()
  })

  it('soft-archives and restores a company (workspace) profile', async () => {
    const store = await hydrate()
    const s = store.getState()

    s.archiveCompany('ws-1')
    expect(store.getState().company.archivedAt).toBeTruthy()
    expect(store.getState().workspaces[0].company.archivedAt).toBeTruthy()

    s.restoreCompany('ws-1')
    expect(store.getState().company.archivedAt).toBeNull()
    await settle()

    const persisted = savedDocument(api.saveStoreV2.mock.calls.length - 1)
    expect(persisted.workspaces[0].company.archivedAt).toBeNull()
  })

  it('never writes lifecycle/CRUD state to localStorage', async () => {
    const store = await hydrate()
    const s = store.getState()
    s.transitionTenderStatus('tender-1', 'READY_TO_ASSEMBLE')
    s.archiveCustomer('cust-1')
    await settle()

    const blob = Array.from(
      { length: window.localStorage.length },
      (_, i) => window.localStorage.getItem(window.localStorage.key(i) ?? '') ?? '',
    ).join('\n')
    expect(blob).not.toContain('lifecycle')
    expect(blob).not.toContain('archivedAt')
    expect(blob).not.toContain('submission')
  })
})

describe('updateTender patch contract', () => {
  it('excludes lifecycle-managed fields at the type level', () => {
    type Patch = Parameters<TendersState['updateTender']>[1]

    // @ts-expect-error status must go through transitionTenderStatus
    const statusPatch: Patch = { status: 'WON' }
    // @ts-expect-error lifecycle is append-only via the lifecycle actions
    const lifecyclePatch: Patch = { lifecycle: [] }
    // @ts-expect-error submission must go through recordSubmission
    const submissionPatch: Patch = { submission: null }
    // @ts-expect-error outcome must go through recordOutcome
    const outcomePatch: Patch = { outcome: null }

    const allowed: Patch = { title: 'ok' }
    void statusPatch
    void lifecyclePatch
    void submissionPatch
    void outcomePatch
    expect(allowed.title).toBe('ok')
  })
})

/**
 * GREEN regression tests for the Tenders renderer v2 store cutover (Phase 2,
 * Task 2B).
 *
 * These tests encode the frozen target API/behaviour from
 * `docs/tenders-hardening/phase-2-remaining.md` (Task 2B) and
 * `docs/tenders-hardening/contracts-and-invariants.md` (§2–§3). The v2 cutover
 * is implemented, so these lock in the authoritative-store behaviour: hydrate
 * from `loadStoreV2`, persist through `saveStoreV2`, keep localStorage UI-only,
 * and never resurrect demo data.
 *
 * The store module holds module-level state and a `persist` middleware, so it
 * is re-imported fresh per test (`vi.resetModules()` + dynamic import) and
 * localStorage is cleared between tests. IPC is mocked on `window.tendersApi`
 * before the store is imported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AppPage,
  CompanyProfile,
  Customer,
  IssuerTemplate,
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
  TendersPersistenceErrorCode,
} from '../src/shared/tenders-persistence'

// ── frozen target store surface ───────────────────────────────────────────────

type HydrationStatus = 'loading' | 'ready' | 'error'
type SaveStatus = 'loading' | 'saving' | 'saved' | 'error' | 'conflict'

/**
 * The store state the GREEN lane must provide. Existing domain slices are
 * included so assertions read like the real store; the v2 additions are the
 * hydration/save status fields and the three new actions.
 */
interface V2StoreState {
  workspaces: TendersWorkspaceV2[]
  activeCompanyId: string | null
  company: CompanyProfile
  customers: Customer[]
  vault: VaultDoc[]
  tenders: TenderRecord[]
  issuerTemplates: IssuerTemplate[]

  hydrationStatus: HydrationStatus
  hydrationError: string | null
  saveStatus: SaveStatus
  saveError: string | null
  hasWorkspaces: boolean

  hydrateFromMain: () => Promise<void>
  reloadCommittedFromMain: () => Promise<void>
  retrySave: () => void

  addCompany: (company: CompanyProfile) => string
  addCustomer: (customer: Customer) => void
  addVaultDoc: (doc: VaultDoc) => void
  updateTender: (id: string, patch: Partial<TenderRecord>) => void
  updateRequirement: (tenderId: string, reqId: string, patch: Partial<RequirementRecord>) => void

  setPage: (page: AppPage) => void
  setView: (view: string) => void
  setZoom: (zoom: number) => void
  setOnboardingDone: () => void
}

interface StoreApi {
  getState: () => V2StoreState
}

const STORE_MODULE = '../src/renderer/src/store'

// ── IPC mock ──────────────────────────────────────────────────────────────────

type ApiMock = {
  loadStoreV2: ReturnType<typeof vi.fn>
  saveStoreV2: ReturnType<typeof vi.fn>
  onStoreChangedV2: ReturnType<typeof vi.fn>
}

let api: ApiMock
let storeChangedCallback: ((data: TendersDataV2) => void) | null = null

function installTendersApiMock(): void {
  storeChangedCallback = null
  api = {
    loadStoreV2: vi.fn(),
    saveStoreV2: vi.fn(),
    onStoreChangedV2: vi.fn((callback: (data: TendersDataV2) => void) => {
      storeChangedCallback = callback
      return () => {
        storeChangedCallback = null
      }
    }),
  }
  ;(window as unknown as Record<string, unknown>).tendersApi = api
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

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
  storeChangedCallback = null
})

async function importStore(): Promise<StoreApi> {
  const mod = (await import(STORE_MODULE)) as unknown as { useTendersStore: StoreApi }
  return mod.useTendersStore
}

function state(store: StoreApi): V2StoreState {
  return store.getState()
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/** Let debounced/queued saves run deterministically under fake timers. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2000)
  await flushMicrotasks()
}

function callHydrate(store: StoreApi): Promise<void> {
  const current = state(store)
  expect(typeof current.hydrateFromMain, 'hydrateFromMain must exist on the store').toBe('function')
  return current.hydrateFromMain()
}

async function hydrate(store: StoreApi): Promise<void> {
  await callHydrate(store)
  await flushMicrotasks()
}

function callReload(store: StoreApi): Promise<void> {
  const current = state(store)
  expect(
    typeof current.reloadCommittedFromMain,
    'reloadCommittedFromMain must exist on the store',
  ).toBe('function')
  return current.reloadCommittedFromMain()
}

async function reload(store: StoreApi): Promise<void> {
  await callReload(store)
  await flushMicrotasks()
}

function callRetry(store: StoreApi): void {
  const current = state(store)
  expect(typeof current.retrySave, 'retrySave must exist on the store').toBe('function')
  current.retrySave()
}

function saveCall(index: number): SaveTendersRequest {
  const call = api.saveStoreV2.mock.calls[index]
  return call[0] as SaveTendersRequest
}

function saveCallCount(): number {
  return api.saveStoreV2.mock.calls.length
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

/** A manually-resolved promise so a save can be held "in flight". */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function readsLocalStorage(): string[] {
  const values: string[] = []
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key) values.push(window.localStorage.getItem(key) ?? '')
  }
  return values
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const LOADED_AT = '2026-09-01T00:00:00.000Z'
const NEXT_AT = '2026-09-01T00:00:01.000Z'

/**
 * Minimal, stable string that only appears in the legacy seeded/demo domain.
 * Used to prove not-found hydration does not resurrect demo data.
 */
const MOCK_SENTINELS = {
  company: 'Thabo Engineering (Pty) Ltd',
} as const

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function company(name: string): CompanyProfile {
  return {
    name,
    tradingName: name,
    registrationNumber: 'REG-TEST-001',
    vatNumber: 'VAT-TEST-001',
    taxPin: 'TAX-TEST-001',
    bbbeeLevel: 'Level 2',
    bbbeeBlackOwnership: '51%',
    csdSupplierNumber: 'CSD-TEST-001',
    founded: '2019',
    employees: '25',
    industry: 'Construction',
    description: 'Synthetic company for renderer store tests.',
    address: '1 Test Street, Test City',
    phone: '+27 10 000 0000',
    email: 'test@example.test',
    website: 'https://example.test',
    directors: [],
    projects: [],
  }
}

function customer(id: string, name: string): Customer {
  return {
    id,
    name,
    contactName: 'Test Contact',
    contactEmail: `${id}@example.test`,
    contactPhone: '+27 10 000 0001',
    industry: 'Public sector',
    status: 'ACTIVE',
    since: '2025-01-01',
    notes: 'Synthetic customer.',
    requiredDocs: [],
  }
}

function vaultDoc(id: string, title: string): VaultDoc {
  return {
    id,
    title,
    category: 'COMPLIANCE',
    fileUrl: `vault/${id}.pdf`,
    issueDate: null,
    expiryDate: null,
    isCertified: false,
    certifiedDate: null,
    metadata: {},
  }
}

function requirement(id: string, order: number): RequirementRecord {
  return {
    id,
    ruleKey: `rule-${order}`,
    title: `Requirement ${order}`,
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    verbatimClause: `Clause ${order}`,
    pageNumber: order,
    boundingBox: { top: 0.1, left: 0.1, width: 0.8, height: 0.05 },
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order,
    confidence: 0.9,
    status: 'OUTSTANDING',
    linkedVaultDocId: null,
    reason: null,
    suggestedVaultDocIds: [],
  }
}

function tender(id: string, overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id,
    title: `Tender ${id}`,
    referenceNumber: `REF-${id}`,
    issuingBody: 'Test Issuer',
    closingDate: '2026-12-31T12:00:00.000Z',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: null,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: '2026-08-01T08:00:00.000Z',
    fileName: `${id}.pdf`,
    fileUrl: `documents/${id}.pdf`,
    numPages: 10,
    ocrPages: 0,
    requirements: [requirement('req-1', 1)],
    ...overrides,
  }
}

function workspace(
  id: string,
  name: string,
  overrides: Partial<TendersWorkspaceV2> = {},
): TendersWorkspaceV2 {
  return {
    id,
    name,
    dataOrigin: 'user',
    company: company(name),
    customers: [customer(`cust-${id}`, `${name} Customer`)],
    vault: [vaultDoc(`vd-${id}`, `${name} Doc`)],
    tenders: [tender(`tender-${id}`)],
    ...overrides,
  }
}

function documentV2(
  revision: number,
  workspaces: TendersWorkspaceV2[],
  activeCompanyId: string | null = workspaces[0]?.id ?? null,
  updatedAt = LOADED_AT,
): TendersDataV2 {
  return {
    schemaVersion: 2,
    revision,
    updatedAt,
    activeCompanyId,
    workspaces,
    issuerTemplates: [],
  }
}

function makeLoadedDoc(revision = 7): TendersDataV2 {
  return documentV2(revision, [workspace('ws-1', 'Loaded Co')], 'ws-1')
}

function emptyDoc(): TendersDataV2 {
  return documentV2(0, [], null)
}

function loadOk(
  status: 'loaded' | 'migrated' | 'not-found',
  data: TendersDataV2,
  needsSave = false,
): TendersLoadResult {
  return { ok: true, status, data, needsSave, warnings: [] }
}

function loadErr(code: TendersPersistenceErrorCode, message: string): TendersLoadResult {
  return { ok: false, error: { code, message } }
}

function saveOk(data: TendersDataV2): SaveTendersResult {
  return { ok: true, data }
}

function saveErr(
  code: TendersPersistenceErrorCode,
  message: string,
  current?: TendersDataV2,
): SaveTendersResult {
  return current
    ? { ok: false, error: { code, message }, current }
    : { ok: false, error: { code, message } }
}

function saveConflict(message: string, current: TendersDataV2): SaveTendersResult {
  return { ok: false, error: { code: 'REVISION_CONFLICT', message, current }, current }
}

/** Main owns `revision + 1`; the mock echoes the committed snapshot back. */
function commitFromRequest(request: SaveTendersRequest): SaveTendersResult {
  return saveOk({
    ...clone(request.document),
    revision: request.expectedRevision + 1,
    updatedAt: NEXT_AT,
  })
}

function useSuccessfulSave(): void {
  api.saveStoreV2.mockImplementation(async (request: SaveTendersRequest) =>
    commitFromRequest(request),
  )
}

function findSavedDocument(index: number): TendersDataV2 {
  return saveCall(index).document
}

function vaultIdsIn(document: TendersDataV2, workspaceId: string): string[] {
  const target = document.workspaces.find((candidate) => candidate.id === workspaceId)
  return target ? target.vault.map((doc) => doc.id) : []
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Tenders renderer store v2 cutover', () => {
  describe('hydrateFromMain', () => {
    it('loaded: adopts the document, reports ready, and uses the loaded revision for the next save', async () => {
      const loaded = makeLoadedDoc(7)
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', loaded, false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      const hydrated = state(store)
      expect(hydrated.hydrationStatus).toBe('ready')
      expect(hydrated.hydrationError).toBeNull()
      expect(hydrated.hasWorkspaces).toBe(true)
      expect(hydrated.workspaces).toHaveLength(1)
      expect(hydrated.workspaces[0].id).toBe('ws-1')
      expect(hydrated.activeCompanyId).toBe('ws-1')
      expect(hydrated.company.name).toBe('Loaded Co')
      expect(hydrated.tenders).toHaveLength(1)
      expect(hydrated.tenders[0].id).toBe('tender-ws-1')

      // Hydration itself must not write back.
      expect(api.saveStoreV2).not.toHaveBeenCalled()

      // The committed revision must be the loaded revision.
      state(store).addCustomer(customer('cust-rev', 'Revision Customer'))
      await settle()

      expect(saveCallCount()).toBeGreaterThanOrEqual(1)
      expect(saveCall(0).expectedRevision).toBe(7)
    })

    it('not-found: renders the empty workspace with no demo seeding and no save', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('not-found', emptyDoc(), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      const hydrated = state(store)
      expect(hydrated.workspaces).toHaveLength(0)
      expect(hydrated.hasWorkspaces).toBe(false)
      expect(hydrated.tenders).toHaveLength(0)
      expect(hydrated.customers).toHaveLength(0)
      expect(hydrated.activeCompanyId).toBeNull()

      const serialized = JSON.stringify(hydrated.workspaces)
      expect(serialized).not.toContain('co-thabo')
      expect(serialized).not.toContain('tender-wtr-04')
      expect(serialized).not.toContain(MOCK_SENTINELS.company)

      expect(api.saveStoreV2).not.toHaveBeenCalled()
    })

    it('migrated: renders migrated data and commits exactly once at expectedRevision 0 (sequential double hydrate)', async () => {
      const migrated = makeLoadedDoc(0)
      api.loadStoreV2.mockResolvedValue(loadOk('migrated', migrated, true))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)
      await hydrate(store)
      await settle()

      const hydrated = state(store)
      expect(hydrated.hydrationStatus).toBe('ready')
      expect(hydrated.workspaces).toHaveLength(1)
      expect(hydrated.workspaces[0].id).toBe('ws-1')

      expect(saveCallCount()).toBe(1)
      expect(saveCall(0).expectedRevision).toBe(0)
      expect(saveCall(0).document.schemaVersion).toBe(2)
    })

    it('migrated: guards StrictMode double-invocation (concurrent hydrate commits once)', async () => {
      const migrated = makeLoadedDoc(0)
      api.loadStoreV2.mockResolvedValue(loadOk('migrated', migrated, true))
      useSuccessfulSave()

      const store = await importStore()
      await Promise.all([callHydrate(store), callHydrate(store)])
      await settle()

      expect(saveCallCount()).toBe(1)
      expect(saveCall(0).expectedRevision).toBe(0)
      expect(state(store).hydrationStatus).toBe('ready')
    })

    it('migrated: a failed migration commit can be retried by hydrating again', async () => {
      const migrated = makeLoadedDoc(0)
      api.loadStoreV2.mockResolvedValue(loadOk('migrated', migrated, true))
      api.saveStoreV2
        .mockResolvedValueOnce(saveErr('WRITE_FAILED', 'disk is full'))
        .mockImplementation(async (request: SaveTendersRequest) => commitFromRequest(request))

      const store = await importStore()
      await hydrate(store)
      await flushMicrotasks()

      // First migration attempt fails and is surfaced.
      expect(saveCallCount()).toBe(1)
      expect(state(store).saveStatus).toBe('error')

      // The migration latch must have been released, so a retry commits again
      // at expectedRevision 0 and succeeds.
      await hydrate(store)
      await flushMicrotasks()

      expect(saveCallCount()).toBe(2)
      expect(saveCall(1).expectedRevision).toBe(0)
      expect(state(store).hydrationStatus).toBe('ready')
      expect(state(store).saveStatus).toBe('saved')
    })

    it('migrated: a mutation during a slow migration commit defers the save until migration resolves', async () => {
      const migrated = makeLoadedDoc(0)
      api.loadStoreV2.mockResolvedValue(loadOk('migrated', migrated, true))
      const migrationSave = deferred<SaveTendersResult>()
      api.saveStoreV2
        .mockImplementationOnce(() => migrationSave.promise)
        .mockImplementation(async (request: SaveTendersRequest) => commitFromRequest(request))

      const store = await importStore()
      // Start hydration; it pauses on the slow migration commit.
      const hydrating = callHydrate(store)
      await flushMicrotasks()

      expect(saveCallCount()).toBe(1)
      expect(saveCall(0).expectedRevision).toBe(0)

      // A user edit lands while the migration write is in flight. Its 300 ms
      // debounce would elapse long before the slow write resolves.
      state(store).addVaultDoc(vaultDoc('vd-during-migration', 'Edit During Migration'))
      await vi.advanceTimersByTimeAsync(1000)
      await flushMicrotasks()

      // No concurrent save was dispatched with the stale revision 0.
      expect(saveCallCount()).toBe(1)

      // Migration resolves at revision 1; the deferred save then runs at rev 1.
      migrationSave.resolve(commitFromRequest(saveCall(0)))
      await hydrating
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(1000)
      await flushMicrotasks()

      expect(saveCallCount()).toBe(2)
      expect(saveCall(1).expectedRevision).toBe(1)
      expect(vaultIdsIn(saveCall(1).document, 'ws-1')).toContain('vd-during-migration')
    })

    it.each<[TendersPersistenceErrorCode, string]>([
      ['READ_FAILED', 'the store file could not be read'],
      ['UNSUPPORTED_SCHEMA_VERSION', 'the store file is from a newer Tenders'],
    ])(
      'failure %s: enters an explicit error state and never writes local state over the document',
      async (code, message) => {
        api.loadStoreV2.mockResolvedValue(loadErr(code, message))
        useSuccessfulSave()

        const store = await importStore()
        await hydrate(store)

        const failed = state(store)
        expect(failed.hydrationStatus).toBe('error')
        expect(typeof failed.hydrationError).toBe('string')
        expect(failed.hydrationError).toBeTruthy()

        // No write-over: nothing is saved and no empty local state is committed.
        expect(api.saveStoreV2).not.toHaveBeenCalled()
      },
    )
  })

  describe('mutation persistence', () => {
    it('saves mutations with the current revision and adopts the returned committed snapshot', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-new', 'Newly Added Doc'))
      await settle()

      expect(saveCallCount()).toBeGreaterThanOrEqual(1)
      const first = saveCall(0)
      expect(first.expectedRevision).toBe(7)
      expect(first.document.schemaVersion).toBe(2)
      expect(first.document.revision).toBe(7)
      expect(vaultIdsIn(first.document, 'ws-1')).toContain('vd-new')

      // The returned committed snapshot is adopted (edit + next revision).
      const afterSave = state(store)
      expect(afterSave.saveStatus).toBe('saved')
      expect(afterSave.vault.map((doc) => doc.id)).toContain('vd-new')

      // The committed revision advances to the returned `data.revision`.
      const callsBefore = saveCallCount()
      state(store).updateTender('tender-ws-1', { title: 'Renamed After Commit' })
      await settle()

      const next = saveCall(callsBefore)
      expect(next.expectedRevision).toBe(8)
      expect(findSavedDocument(callsBefore).workspaces[0].tenders[0].title).toBe(
        'Renamed After Commit',
      )
    })

    it('serialises saves: a mutation during an in-flight save defers exactly one follow-up with the fresh revision', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      const firstSave = deferred<SaveTendersResult>()
      const secondSave = deferred<SaveTendersResult>()
      api.saveStoreV2
        .mockImplementationOnce(() => firstSave.promise)
        .mockImplementationOnce(() => secondSave.promise)

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-inflight-1', 'In Flight One'))
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()

      expect(saveCallCount()).toBe(1)
      expect(saveCall(0).expectedRevision).toBe(7)

      // Second edit lands while the first save is still awaiting main.
      state(store).addVaultDoc(vaultDoc('vd-inflight-2', 'In Flight Two'))
      await vi.advanceTimersByTimeAsync(1000)
      await flushMicrotasks()

      // No concurrent save was dispatched with the same stale revision.
      expect(saveCallCount()).toBe(1)

      // Main commits the first save at revision 8.
      firstSave.resolve(commitFromRequest(saveCall(0)))
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(1000)
      await flushMicrotasks()

      // Exactly one follow-up ran, reading the freshly committed revision.
      expect(saveCallCount()).toBe(2)
      expect(saveCall(1).expectedRevision).toBe(8)
      expect(vaultIdsIn(saveCall(1).document, 'ws-1')).toEqual(
        expect.arrayContaining(['vd-inflight-1', 'vd-inflight-2']),
      )

      secondSave.resolve(commitFromRequest(saveCall(1)))
      await flushMicrotasks()
      expect(state(store).saveStatus).toBe('saved')
    })
  })

  describe('save failure and retry', () => {
    it('keeps the unsaved edit on WRITE_FAILED and retries with the same revision', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      api.saveStoreV2
        .mockResolvedValueOnce(saveErr('WRITE_FAILED', 'disk is full'))
        .mockImplementation(async (request: SaveTendersRequest) => commitFromRequest(request))

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-unsaved', 'Unsaved Edit'))
      await settle()

      const failed = state(store)
      expect(failed.saveStatus).toBe('error')
      expect(typeof failed.saveError).toBe('string')
      expect(failed.saveError).toBeTruthy()
      // The edit is never dropped and never falsely claimed as saved.
      expect(failed.saveStatus).not.toBe('saved')
      expect(failed.vault.map((doc) => doc.id)).toContain('vd-unsaved')

      const callsBeforeRetry = saveCallCount()
      callRetry(store)
      await settle()

      expect(saveCallCount()).toBeGreaterThan(callsBeforeRetry)
      const unsavedSaves = api.saveStoreV2.mock.calls
        .map((call) => call[0] as SaveTendersRequest)
        .filter((request) => vaultIdsIn(request.document, 'ws-1').includes('vd-unsaved'))
      expect(unsavedSaves.length).toBeGreaterThanOrEqual(2)
      for (const request of unsavedSaves) {
        // The pending edit was never committed, so every attempt must reuse rev 7.
        expect(request.expectedRevision).toBe(7)
      }
      expect(state(store).saveStatus).toBe('saved')
    })
  })

  describe('renderer pre-validation', () => {
    it('never sends an invalid document to saveStoreV2 and surfaces the failing field path', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      // A closing date the permissive display parser accepts but the strict
      // schema rejects must not brick the whole workspace on save.
      state(store).updateTender('tender-ws-1', { closingDate: 'Friday, 30 November 2026' })
      await settle()

      expect(api.saveStoreV2).not.toHaveBeenCalled()
      expect(state(store).saveStatus).toBe('error')
      expect(state(store).saveError).toBeTruthy()
      expect(state(store).saveError).toContain('workspaces.0.tenders.0.closingDate')
      expect(state(store).saveError).toContain('closing date')
    })
  })

  describe('revision conflict', () => {
    it('surfaces conflict without a blind write, then reload adopts the committed document', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      const committed = clone(makeLoadedDoc(9))
      committed.workspaces[0].vault = [vaultDoc('vd-disk', 'Committed On Disk')]
      // Every save while conflicted fails with the same conflict, so an
      // accidental blind retry is caught as an assertion failure rather than
      // an unhandled undefined result.
      api.saveStoreV2.mockResolvedValue(saveConflict('expected revision 7 but found 9', committed))

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-conflict', 'Conflicting Edit'))
      await settle()

      const conflicted = state(store)
      expect(conflicted.saveStatus).toBe('conflict')
      // Never blind-writes: the local edit stays local.
      expect(conflicted.vault.map((doc) => doc.id)).toContain('vd-conflict')

      const staleWrites = () =>
        api.saveStoreV2.mock.calls
          .map((call) => call[0] as SaveTendersRequest)
          .filter((request) => request.expectedRevision === 7).length
      const staleAfterFirstAttempt = staleWrites()
      await settle()
      expect(staleWrites()).toBe(staleAfterFirstAttempt)

      // reloadCommittedFromMain adopts the disk revision/document and clears conflict.
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', committed, false))
      await reload(store)
      await settle()

      const reloaded = state(store)
      expect(reloaded.saveStatus).not.toBe('conflict')
      expect(reloaded.vault.map((doc) => doc.id)).toContain('vd-disk')
      expect(staleWrites()).toBe(staleAfterFirstAttempt)

      // The next save uses the disk revision, proving the committed revision advanced.
      const callsBefore = saveCallCount()
      state(store).updateTender('tender-ws-1', { title: 'After Reload' })
      await settle()
      expect(saveCall(callsBefore).expectedRevision).toBe(9)
    })
  })

  describe('external store changes', () => {
    it('applies a newer external commit and ignores an echo of the current revision', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      expect(api.onStoreChangedV2).toHaveBeenCalled()
      expect(typeof storeChangedCallback).toBe('function')

      const external = clone(makeLoadedDoc(10))
      external.workspaces[0].vault = [vaultDoc('vd-external', 'External Commit')]
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', external, false))

      storeChangedCallback?.(external)
      await settle()

      expect(state(store).vault.map((doc) => doc.id)).toContain('vd-external')

      // The next save uses the externally committed revision.
      const callsBefore = saveCallCount()
      state(store).addVaultDoc(vaultDoc('vd-after-external', 'After External'))
      await settle()
      expect(saveCall(callsBefore).expectedRevision).toBe(10)

      // An echo of the already-current revision must be a no-op.
      const echo = clone(external)
      echo.workspaces[0].vault = [vaultDoc('vd-echo', 'Echoed Commit')]
      storeChangedCallback?.(echo)
      await settle()

      expect(state(store).vault.map((doc) => doc.id)).not.toContain('vd-echo')
    })

    it('does not clobber an in-flight local edit with the originator own-broadcast echo', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      const firstSave = deferred<SaveTendersResult>()
      const secondSave = deferred<SaveTendersResult>()
      api.saveStoreV2
        .mockImplementationOnce(() => firstSave.promise)
        .mockImplementationOnce(() => secondSave.promise)

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-echo-1', 'First Edit'))
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      expect(saveCallCount()).toBe(1)

      // Second edit arrives while the first save is still in flight.
      state(store).addVaultDoc(vaultDoc('vd-echo-2', 'Second Edit'))

      // The originator's own commit echo (rev 8, without the second edit)
      // arrives before the saveStoreV2 reply and must not be adopted.
      const echo = clone(makeLoadedDoc(8))
      echo.workspaces[0].vault = [vaultDoc('vd-echo-1', 'First Edit')]
      storeChangedCallback?.(echo)
      await flushMicrotasks()

      expect(state(store).vault.map((doc) => doc.id)).toEqual(
        expect.arrayContaining(['vd-echo-1', 'vd-echo-2']),
      )

      // First save resolves; the deferred follow-up persists BOTH edits at rev 8.
      firstSave.resolve(commitFromRequest(saveCall(0)))
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(1000)
      await flushMicrotasks()

      expect(saveCallCount()).toBe(2)
      expect(saveCall(1).expectedRevision).toBe(8)
      expect(vaultIdsIn(saveCall(1).document, 'ws-1')).toEqual(
        expect.arrayContaining(['vd-echo-1', 'vd-echo-2']),
      )

      secondSave.resolve(commitFromRequest(saveCall(1)))
      await flushMicrotasks()
    })
  })

  describe('localStorage scope', () => {
    it('persists UI preferences only, never domain payloads', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      state(store).addCustomer(customer('cust-secret', 'SECRET_CUSTOMER_NAME'))
      state(store).addVaultDoc(vaultDoc('vd-secret', 'SECRET_VAULT_TITLE'))
      state(store).updateTender('tender-ws-1', { title: 'SECRET_TENDER_TITLE' })
      state(store).setPage('tenders')
      state(store).setZoom(1.5)
      state(store).setOnboardingDone()
      await settle()

      const blob = readsLocalStorage().join('\n')
      expect(blob).not.toMatch(/"workspaces"\s*:/)
      expect(blob).not.toMatch(/"tenders"\s*:/)
      expect(blob).not.toMatch(/"customers"\s*:/)
      expect(blob).not.toMatch(/"vault"\s*:/)
      expect(blob).not.toContain('SECRET_CUSTOMER_NAME')
      expect(blob).not.toContain('SECRET_VAULT_TITLE')
      expect(blob).not.toContain('SECRET_TENDER_TITLE')

      // UI preferences may still persist.
      expect(window.localStorage.length).toBeGreaterThan(0)
    })

    it('purges the legacy v1 localStorage key on startup without touching other keys', async () => {
      window.localStorage.setItem('zanostack-tenders-v1', JSON.stringify({ workspaces: ['v1'] }))
      window.localStorage.setItem('unrelated-key', 'keep-me')
      api.loadStoreV2.mockResolvedValue(loadOk('not-found', emptyDoc(), false))
      useSuccessfulSave()

      await importStore()

      expect(window.localStorage.getItem('zanostack-tenders-v1')).toBeNull()
      expect(window.localStorage.getItem('unrelated-key')).toBe('keep-me')
    })
  })

  describe('hasWorkspaces', () => {
    it('tracks the workspace list going from empty to populated and back', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('not-found', emptyDoc(), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)
      expect(state(store).hasWorkspaces).toBe(false)

      state(store).addCompany(company('Fresh Co'))
      await settle()
      expect(state(store).hasWorkspaces).toBe(true)
      expect(state(store).workspaces).toHaveLength(1)

      // The authoritative store reports an empty workspace list again (removal).
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', emptyDoc(), false))
      await reload(store)
      await settle()
      expect(state(store).hasWorkspaces).toBe(false)
      expect(state(store).workspaces).toHaveLength(0)
    })
  })
})

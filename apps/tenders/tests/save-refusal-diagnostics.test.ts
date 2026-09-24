/**
 * Save-refusal diagnostics for the Tenders renderer store.
 *
 * A refused save used to leave the same trace as a committed one: nothing. The
 * `saveStatus`/`saveError` state was set for the UI, but no line was logged, so
 * an intermittent save failure (the e2e `upload-save-vault-document` flake)
 * could not be attributed to the branch that refused it — the captured console
 * was silent. These tests pin the fix: every refusal branch emits exactly one
 * warning naming its code, and a save that commits emits none.
 *
 * The warnings must come from the refusal *paths*, not merely exist as source
 * text, so every assertion here drives the real store through the same harness
 * `tests/renderer-store-v2.test.ts` uses (module-level state ⇒
 * `vi.resetModules()` + dynamic import, `window.tendersApi` mocked before the
 * import, fake timers for the 300 ms debounce).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real store types are the contract these tests assert against: the refusal
// vocabulary and the details shape come from the store module itself, so a
// renamed code or field fails to compile here. The module is re-imported per
// test through a cast (see `StoreModule`), as in `renderer-store-v2.test.ts`.
import type {
  TendersSaveRefusalDetails,
  TendersSaveRefusalTarget,
  TendersSaveRefusalTargetInput,
  TendersState,
} from '../src/renderer/src/store'
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
  TendersPersistenceErrorCode,
} from '../src/shared/tenders-persistence'
import { MAX_TENDERS_DOCUMENT_BYTES } from '../src/shared/tenders-persistence'

// ── store surface ─────────────────────────────────────────────────────────────

interface StoreApi {
  getState: () => TendersState
}

const STORE_MODULE = '../src/renderer/src/store'

type StoreModule = {
  useTendersStore: StoreApi
  describeTendersSaveTarget: (input: TendersSaveRefusalTargetInput) => TendersSaveRefusalTarget
  formatTendersSaveRefusal: (details: TendersSaveRefusalDetails) => string
  warnTendersSaveRefused: (details: TendersSaveRefusalDetails) => void
}

// ── IPC mock ──────────────────────────────────────────────────────────────────

type ApiMock = {
  loadStoreV2: ReturnType<typeof vi.fn>
  saveStoreV2: ReturnType<typeof vi.fn>
  onStoreChangedV2: ReturnType<typeof vi.fn>
}

let api: ApiMock
/**
 * Explicit shape rather than `ReturnType<typeof vi.spyOn>`: the generic
 * overload leaves `mock.calls` as `any`, which is not type-checked here (the
 * workspace typecheck covers `src`, not `tests`).
 */
interface WarnSpy {
  mock: { calls: unknown[][] }
  mockRestore: () => void
}
let warnSpy: WarnSpy

function installTendersApiMock(): void {
  api = {
    loadStoreV2: vi.fn(),
    saveStoreV2: vi.fn(),
    onStoreChangedV2: vi.fn(() => () => {}),
  }
  ;(window as unknown as Record<string, unknown>).tendersApi = api
}

function removeTendersApi(): void {
  ;(window as unknown as Record<string, unknown>).tendersApi = undefined
}

beforeEach(() => {
  vi.resetModules()
  window.localStorage.clear()
  vi.useFakeTimers()
  installTendersApiMock()
  // Silenced, but still recorded: the assertions read the recorded calls.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  vi.useRealTimers()
  window.localStorage.clear()
  removeTendersApi()
})

// ── warning capture ───────────────────────────────────────────────────────────

/** Every `console.warn` line the store emitted, as text. */
function warnLines(): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]))
}

/** Only the refusal lines, i.e. the diagnostics this feature adds. */
function refusalLines(): string[] {
  return warnLines().filter((line) => line.startsWith('tenders: save refused'))
}

/** The refusal codes emitted so far, in order. */
function refusalCodes(): string[] {
  return refusalLines().map((line) => /\[([A-Z_]+)\]/.exec(line)?.[1] ?? 'no-code')
}

function refusalCount(code: string): number {
  return refusalCodes().filter((emitted) => emitted === code).length
}

/** The single refusal line for `code`; fails loudly when it is not exactly one. */
function refusalLineFor(code: string): string {
  const matches = refusalLines().filter((line) => line.includes(`[${code}]`))
  expect(matches, `expected exactly one ${code} refusal line, got ${matches.length}`).toHaveLength(
    1,
  )
  return matches[0]
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

async function importStoreModule(): Promise<StoreModule> {
  return (await import(STORE_MODULE)) as unknown as StoreModule
}

async function importStore(): Promise<StoreApi> {
  return (await importStoreModule()).useTendersStore
}

function state(store: StoreApi): TendersState {
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

async function hydrate(store: StoreApi): Promise<void> {
  await state(store).hydrateFromMain()
  await flushMicrotasks()
}

async function reload(store: StoreApi): Promise<void> {
  await state(store).reloadCommittedFromMain()
  await flushMicrotasks()
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

// ── fixtures (same shapes as renderer-store-v2.test.ts) ───────────────────────

const LOADED_AT = '2026-09-01T00:00:00.000Z'
const NEXT_AT = '2026-09-01T00:00:01.000Z'
/** Distinctive content that must never reach a refusal line. */
const SECRET_MARKER = 'SECRET-CLIENT-CONFIDENTIAL-PARAGRAPH'

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

function loadOk(
  status: 'loaded' | 'migrated' | 'not-found',
  data: TendersDataV2,
  needsSave = false,
): TendersLoadResult {
  return { ok: true, status, data, needsSave, warnings: [] }
}

function saveOk(data: TendersDataV2): SaveTendersResult {
  return { ok: true, data }
}

function saveErr(code: TendersPersistenceErrorCode, message: string): SaveTendersResult {
  return { ok: false, error: { code, message } }
}

function saveConflict(message: string, current: TendersDataV2): SaveTendersResult {
  return { ok: false, error: { code: 'REVISION_CONFLICT', message }, current }
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

/** Three tenders at the requirement cap: measured over the document ceiling. */
function growOverCeiling(store: StoreApi): void {
  const huge = Array.from({ length: 5_000 }, (_, index) => requirement(`big-${index}`, index))
  state(store).updateTender('tender-ws-1', { requirements: huge })
  state(store).addTender(tender('tender-big-2', { requirements: huge }))
  state(store).addTender(tender('tender-big-3', { requirements: huge }))
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Tenders store save-refusal diagnostics', () => {
  describe('the refusal line itself', () => {
    it('names the code, path, reason, field and document counts in one grep-able line', async () => {
      const module = await importStoreModule()
      const document = makeLoadedDoc(7)
      document.workspaces[0].company.description = SECRET_MARKER

      const line = module.formatTendersSaveRefusal({
        code: 'SCHEMA_INVALID',
        path: 'autosave',
        reason: 'workspaces.0.tenders.0.closingDate: closing date must be an RFC 3339 instant',
        fieldPath: 'workspaces.0.tenders.0.closingDate',
        target: module.describeTendersSaveTarget(document),
      })

      expect(line).toContain('tenders: save refused [SCHEMA_INVALID] at autosave')
      expect(line).toContain('field workspaces.0.tenders.0.closingDate')
      expect(line).toContain('closing date must be an RFC 3339 instant')
      expect(line).toContain('revision 7')
      expect(line).toContain(`updatedAt ${LOADED_AT}`)
      expect(line).toContain('1 workspace(s), 1 tender(s), 1 customer(s), 1 vault doc(s)')
      // Counts and revision only: never the document's content.
      expect(line).not.toContain(SECRET_MARKER)
    })

    it('carries the ceilings for a size refusal and drops updatedAt when no document was built', async () => {
      const module = await importStoreModule()

      const sized = module.formatTendersSaveRefusal({
        code: 'DOCUMENT_OVER_SIZE',
        path: 'migration-commit',
        reason: 'Tenders data is 4.1 MB and the save limit is 4.0 MB.',
        size: {
          documentBytes: 4_300_000,
          documentLimitBytes: MAX_TENDERS_DOCUMENT_BYTES,
          fileBytes: 5_100_000,
          fileLimitBytes: 5_000_000,
        },
        target: module.describeTendersSaveTarget(makeLoadedDoc(0)),
      })
      expect(sized).toContain('document 4300000B of 4194304B, file 5100000B of 5000000B')

      const noDocument = module.formatTendersSaveRefusal({
        code: 'NO_IPC_BRIDGE',
        path: 'autosave',
        reason: 'window.tendersApi.saveStoreV2 is unavailable, so the edit cannot be written',
        target: module.describeTendersSaveTarget({
          workspaces: [],
          revision: 0,
          updatedAt: null,
        }),
      })
      expect(noDocument).toContain('revision 0, 0 workspace(s)')
      expect(noDocument).not.toContain('updatedAt')
    })
  })

  describe('refusal branches warn when they refuse', () => {
    it('DOCUMENT_OVER_SIZE: the size pre-check refuses and names the ceilings', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)
      growOverCeiling(store)
      await settle()

      expect(api.saveStoreV2).not.toHaveBeenCalled()
      const line = refusalLineFor('DOCUMENT_OVER_SIZE')
      expect(line).toContain('at autosave')
      expect(line).toMatch(/document \d+B of \d+B, file \d+B of \d+B/)
      expect(line).toContain('revision 7')
      expect(line).toContain('3 tender(s)')
      expect(state(store).saveStatus).toBe('error')
    })

    it('SCHEMA_INVALID: validation refuses and names the failing field path', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      state(store).updateTender('tender-ws-1', { closingDate: 'Friday, 30 November 2026' })
      await settle()

      expect(api.saveStoreV2).not.toHaveBeenCalled()
      const line = refusalLineFor('SCHEMA_INVALID')
      expect(line).toContain('at autosave')
      expect(line).toContain('field workspaces.0.tenders.0.closingDate')
      expect(line).toContain('1 tender(s)')
    })

    it('STORE_REFUSED: main answering ok:false is logged with its error code', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      api.saveStoreV2.mockResolvedValue(saveErr('WRITE_FAILED', 'disk is full'))

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-refused', 'Refused Edit'))
      await settle()

      expect(saveCallCount()).toBe(1)
      const line = refusalLineFor('STORE_REFUSED')
      expect(line).toContain('store code WRITE_FAILED')
      expect(line).toContain('disk is full')
      expect(line).toContain('revision 7')
      expect(state(store).saveStatus).toBe('error')
    })

    it('REVISION_CONFLICT: main answering a conflict is logged with its error code', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      const committed = clone(makeLoadedDoc(9))
      api.saveStoreV2.mockResolvedValue(saveConflict('expected revision 7 but found 9', committed))

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-conflict', 'Conflicting Edit'))
      await settle()

      const line = refusalLineFor('REVISION_CONFLICT')
      expect(line).toContain('at autosave')
      expect(line).toContain('store code REVISION_CONFLICT')
      expect(line).toContain('expected revision 7 but found 9')
      expect(state(store).saveStatus).toBe('conflict')
    })

    it('SAVE_THREW: a throwing round trip is logged instead of vanishing', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      api.saveStoreV2.mockRejectedValue(new Error('ipc channel closed'))

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-threw', 'Throwing Edit'))
      await settle()

      const line = refusalLineFor('SAVE_THREW')
      expect(line).toContain('ipc channel closed')
      expect(line).toContain('revision 7')
      expect(state(store).saveStatus).toBe('error')
    })

    it('SAVE_BLOCKED_BY_CONFLICT: a latched conflict names the refusal once per episode', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      const committed = clone(makeLoadedDoc(9))
      api.saveStoreV2.mockResolvedValue(saveConflict('expected revision 7 but found 9', committed))

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-conflict', 'Conflicting Edit'))
      await settle()
      expect(state(store).saveStatus).toBe('conflict')
      expect(refusalCount('SAVE_BLOCKED_BY_CONFLICT')).toBe(0)

      // Edits made through the conflict are refused by the latch, not by a save
      // attempt. Three mutations must still produce one line, not three.
      state(store).addVaultDoc(vaultDoc('vd-latched-1', 'Latched One'))
      await settle()
      state(store).addVaultDoc(vaultDoc('vd-latched-2', 'Latched Two'))
      await settle()
      state(store).addVaultDoc(vaultDoc('vd-latched-3', 'Latched Three'))
      await settle()

      expect(refusalCount('SAVE_BLOCKED_BY_CONFLICT')).toBe(1)
      const line = refusalLineFor('SAVE_BLOCKED_BY_CONFLICT')
      expect(line).toContain('at autosave')
      expect(line).toContain('expected revision 7 but found 9')
      // The line describes the document as it stood when the latch refused the
      // first of the three edits (the fixture's own doc plus two additions).
      expect(line).toContain('3 vault doc(s)')
      // The edits stay on screen and the save is never blind-written.
      expect(state(store).vault.map((doc) => doc.id)).toContain('vd-latched-3')
    })

    it('SAVE_BLOCKED_BY_CONFLICT: a new conflict episode after a reload warns again', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      const committed = clone(makeLoadedDoc(9))
      api.saveStoreV2.mockResolvedValue(saveConflict('expected revision 7 but found 9', committed))

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-ep-1', 'Episode One'))
      await settle()
      state(store).addVaultDoc(vaultDoc('vd-ep-2', 'Episode Two'))
      await settle()
      expect(refusalCount('SAVE_BLOCKED_BY_CONFLICT')).toBe(1)

      // The user resolves the conflict by adopting the committed document.
      await reload(store)
      expect(state(store).saveStatus).toBe('saved')

      state(store).addVaultDoc(vaultDoc('vd-ep-3', 'Episode Three'))
      await settle()
      expect(state(store).saveStatus).toBe('conflict')

      state(store).addVaultDoc(vaultDoc('vd-ep-4', 'Episode Four'))
      await settle()

      expect(refusalCount('SAVE_BLOCKED_BY_CONFLICT')).toBe(2)
    })

    it('NO_IPC_BRIDGE: a missing bridge is named once per module load, not per edit', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      // The bridge goes away (or was never there, as in the renderer-only dev
      // server): nothing can be written from here on.
      removeTendersApi()

      state(store).addVaultDoc(vaultDoc('vd-nobridge-1', 'No Bridge One'))
      await settle()
      state(store).addVaultDoc(vaultDoc('vd-nobridge-2', 'No Bridge Two'))
      await settle()
      state(store).addVaultDoc(vaultDoc('vd-nobridge-3', 'No Bridge Three'))
      await settle()

      expect(saveCallCount()).toBe(0)
      expect(refusalCount('NO_IPC_BRIDGE')).toBe(1)
      const line = refusalLineFor('NO_IPC_BRIDGE')
      expect(line).toContain('window.tendersApi.saveStoreV2 is unavailable')
      // Named at the first refused edit (the fixture's own doc plus one).
      expect(line).toContain('2 vault doc(s)')
    })

    it('DOCUMENT_OVER_SIZE at migration-commit: the v1 migration refusal is named too', async () => {
      const migrated = documentV2(0, [workspace('ws-1', 'Migrated Co')])
      migrated.workspaces[0].company.description = 'x'.repeat(MAX_TENDERS_DOCUMENT_BYTES + 1)
      api.loadStoreV2.mockResolvedValue(loadOk('migrated', migrated, true))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      expect(api.saveStoreV2).not.toHaveBeenCalled()
      const line = refusalLineFor('DOCUMENT_OVER_SIZE')
      expect(line).toContain('at migration-commit')
      expect(line).toContain('revision 0')
      expect(state(store).saveStatus).toBe('error')
    })

    it('SAVE_THREW at migration-commit: a throwing migration commit is named too', async () => {
      const migrated = makeLoadedDoc(0)
      api.loadStoreV2.mockResolvedValue(loadOk('migrated', migrated, true))
      api.saveStoreV2.mockRejectedValue(new Error('ipc channel closed'))

      const store = await importStore()
      await hydrate(store)

      const line = refusalLineFor('SAVE_THREW')
      expect(line).toContain('at migration-commit')
      expect(line).toContain('ipc channel closed')
      expect(state(store).saveStatus).toBe('error')
    })
  })

  describe('anti-noise: a save that commits warns about nothing', () => {
    it('emits no refusal line for a successful save, and none for later ones either', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-ok-1', 'Committed One'))
      await settle()
      state(store).addVaultDoc(vaultDoc('vd-ok-2', 'Committed Two'))
      await settle()

      // A save really happened (so the absence of a warning is meaningful).
      expect(saveCallCount()).toBeGreaterThanOrEqual(2)
      expect(state(store).saveStatus).toBe('saved')
      expect(refusalLines()).toEqual([])
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('emits no refusal line for a save that is merely deferred behind an in-flight one', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      const inFlight = deferred<SaveTendersResult>()
      api.saveStoreV2
        .mockImplementationOnce(() => inFlight.promise)
        .mockImplementation(async (request: SaveTendersRequest) => commitFromRequest(request))

      const store = await importStore()
      await hydrate(store)

      state(store).addVaultDoc(vaultDoc('vd-inflight', 'First Edit'))
      await vi.advanceTimersByTimeAsync(400)
      await flushMicrotasks()
      expect(saveCallCount()).toBe(1)

      // A second edit lands while the first save is still in flight: deferred,
      // never refused — so it must not be reported as a refusal.
      state(store).addVaultDoc(vaultDoc('vd-deferred', 'Deferred Edit'))
      await vi.advanceTimersByTimeAsync(400)
      await flushMicrotasks()
      expect(refusalLines()).toEqual([])

      inFlight.resolve(commitFromRequest(api.saveStoreV2.mock.calls[0][0] as SaveTendersRequest))
      await settle()

      expect(saveCallCount()).toBeGreaterThanOrEqual(2)
      expect(state(store).saveStatus).toBe('saved')
      expect(refusalLines()).toEqual([])
    })

    it('emits no refusal line for a near-ceiling save that still commits', async () => {
      api.loadStoreV2.mockResolvedValue(loadOk('loaded', makeLoadedDoc(7), false))
      useSuccessfulSave()

      const store = await importStore()
      await hydrate(store)

      // Two tenders at the requirement cap: inside the ceilings, above the 80%
      // headroom threshold, so this save carries an advisory and must not be
      // mistaken for a refusal.
      const big = Array.from({ length: 5_000 }, (_, index) =>
        requirement(`big-${index}`, index + 1),
      )
      state(store).updateTender('tender-ws-1', { requirements: big, numPages: 5_000 })
      state(store).addTender(tender('tender-big-2', { requirements: big, numPages: 5_000 }))
      await settle()

      expect(saveCallCount()).toBeGreaterThanOrEqual(1)
      expect(state(store).saveStatus).toBe('saved')
      expect(state(store).saveSizeWarning).toMatch(/save limit/)
      expect(refusalLines()).toEqual([])
    })
  })
})

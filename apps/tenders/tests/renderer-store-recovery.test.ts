/**
 * Phase 5 / WP-2 — explicit recovery in the renderer store.
 *
 * A RECOVERY_REQUIRED hydration failure must never substitute a candidate or an
 * empty document: the store exposes the validated candidates and only adopts a
 * document after an explicit restore. A successful restore adopts the returned
 * document and advances the committed revision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyTendersDataV2 } from '../src/shared/tenders-schema'
import { MOCK_COMPANY } from '../src/renderer/src/mock/company'
import type { TendersDataV2, TendersWorkspaceV2 } from '../src/shared/types'
import type {
  SaveTendersRequest,
  TendersLoadResult,
  TendersRecoveryCandidate,
} from '../src/shared/tenders-persistence'

const STORE_MODULE = '../src/renderer/src/store'
const AT = '2026-09-01T00:00:00.000Z'
const NEXT = '2026-09-01T00:00:01.000Z'

type ApiMock = {
  loadStoreV2: ReturnType<typeof vi.fn>
  saveStoreV2: ReturnType<typeof vi.fn>
  onStoreChangedV2: ReturnType<typeof vi.fn>
  listRecoveryCandidates: ReturnType<typeof vi.fn>
  restoreRecoveryCandidate: ReturnType<typeof vi.fn>
}

let api: ApiMock

function installTendersApiMock(): void {
  api = {
    loadStoreV2: vi.fn(),
    saveStoreV2: vi.fn(),
    onStoreChangedV2: vi.fn(() => () => {}),
    listRecoveryCandidates: vi.fn(),
    restoreRecoveryCandidate: vi.fn(),
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

function candidate(overrides: Partial<TendersRecoveryCandidate> = {}): TendersRecoveryCandidate {
  return {
    id: 'backups/tenders-data.2.json',
    path: 'backups/tenders-data.2.json',
    source: 'backup',
    reason: 'newer revision than primary',
    updatedAt: AT,
    revision: 4,
    valid: true,
    sizeBytes: 2048,
    ...overrides,
  }
}

function recoveryFailure(candidates: TendersRecoveryCandidate[]): TendersLoadResult {
  return {
    ok: false,
    error: { code: 'RECOVERY_REQUIRED', message: 'The primary store file is unreadable.' },
    recoveryCandidates: candidates,
  }
}

function restoredDocument(): TendersDataV2 {
  const workspace: TendersWorkspaceV2 = {
    id: 'ws-restored',
    name: 'Restored Co',
    dataOrigin: 'user',
    company: clone(MOCK_COMPANY),
    customers: [],
    vault: [],
    tenders: [],
  }
  return {
    ...createEmptyTendersDataV2(AT),
    revision: 5,
    activeCompanyId: 'ws-restored',
    workspaces: [workspace],
  }
}

describe('renderer store explicit recovery', () => {
  it('enters an explicit recovery state without substituting any document', async () => {
    api.loadStoreV2.mockResolvedValue(recoveryFailure([candidate()]))
    api.listRecoveryCandidates.mockResolvedValue({ ok: true, candidates: [candidate()] })

    const store = await importStore()
    await store.getState().hydrateFromMain()
    await settle()

    const state = store.getState()
    expect(state.recoveryRequired).toBe(true)
    expect(state.recoveryCandidates).toHaveLength(1)
    expect(state.recoveryCandidates[0].id).toBe('backups/tenders-data.2.json')
    expect(state.hydrationStatus).toBe('error')
    // Never substitutes: the workspace list stays empty.
    expect(state.workspaces).toHaveLength(0)
    expect(state.hasWorkspaces).toBe(false)
  })

  it('restores an explicit candidate, adopts the returned document and clears recovery', async () => {
    api.loadStoreV2.mockResolvedValue(recoveryFailure([candidate()]))
    api.restoreRecoveryCandidate.mockResolvedValue({
      ok: true,
      data: restoredDocument(),
      currentRevision: 5,
    })
    api.saveStoreV2.mockImplementation(async (request: SaveTendersRequest) => ({
      ok: true,
      data: { ...clone(request.document), revision: request.expectedRevision + 1, updatedAt: NEXT },
    }))

    const store = await importStore()
    await store.getState().hydrateFromMain()
    await settle()
    expect(store.getState().recoveryRequired).toBe(true)

    const result = await store.getState().restoreRecoveryCandidate('backups/tenders-data.2.json')
    expect(result).toEqual({ ok: true })
    await settle()

    const state = store.getState()
    expect(state.recoveryRequired).toBe(false)
    expect(state.recoveryCandidates).toEqual([])
    expect(state.hydrationStatus).toBe('ready')
    expect(state.workspaces).toHaveLength(1)
    expect(state.workspaces[0].id).toBe('ws-restored')
    expect(state.hasWorkspaces).toBe(true)

    // The committed revision comes from the restored document; the next save
    // must use it rather than a stale value.
    state.addCustomer({
      id: 'cust-1',
      name: 'Restored Customer',
      contactName: '',
      contactEmail: '',
      contactPhone: '',
      industry: '',
      status: 'ACTIVE',
      since: '2025-01-01',
      notes: '',
      requiredDocs: [],
    })
    await settle()
    const lastRequest = api.saveStoreV2.mock.calls.at(-1)?.[0] as SaveTendersRequest
    expect(lastRequest.expectedRevision).toBe(5)
  })

  it('surfaces a failed restore without leaving recovery', async () => {
    api.loadStoreV2.mockResolvedValue(recoveryFailure([candidate()]))
    api.restoreRecoveryCandidate.mockResolvedValue({
      ok: false,
      error: { code: 'WRITE_FAILED', message: 'disk full' },
    })

    const store = await importStore()
    await store.getState().hydrateFromMain()
    await settle()

    const result = await store.getState().restoreRecoveryCandidate('backups/tenders-data.2.json')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/disk full/i)

    const state = store.getState()
    expect(state.recoveryRequired).toBe(true)
    expect(state.recoveryError).toMatch(/disk full/i)
    expect(state.workspaces).toHaveLength(0)
  })

  it('refreshRecoveryCandidates re-lists without touching the primary', async () => {
    api.loadStoreV2.mockResolvedValue(recoveryFailure([]))
    api.listRecoveryCandidates.mockResolvedValue({
      ok: true,
      candidates: [candidate({ id: 'tmp/tenders-data.tmp.json', source: 'temporary' })],
    })

    const store = await importStore()
    await store.getState().hydrateFromMain()
    await settle()
    expect(store.getState().recoveryCandidates).toEqual([])

    await store.getState().refreshRecoveryCandidates()
    expect(store.getState().recoveryCandidates).toHaveLength(1)
    expect(store.getState().recoveryCandidates[0].source).toBe('temporary')
  })

  it('a normal load clears any prior recovery state', async () => {
    api.loadStoreV2.mockResolvedValue(recoveryFailure([candidate()]))
    const store = await importStore()
    await store.getState().hydrateFromMain()
    await settle()
    expect(store.getState().recoveryRequired).toBe(true)

    api.loadStoreV2.mockResolvedValue({
      ok: true,
      status: 'loaded',
      data: restoredDocument(),
      needsSave: false,
      warnings: [],
    })
    await store.getState().hydrateFromMain()
    await settle()

    expect(store.getState().recoveryRequired).toBe(false)
    expect(store.getState().recoveryCandidates).toEqual([])
  })
})

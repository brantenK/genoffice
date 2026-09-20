/**
 * Phase 4 / WP-8 follow-up — authoritative demo workspace.
 *
 * `addDemoWorkspace` must force `dataOrigin: 'demo'`, persist through the
 * authoritative v2 store, survive a simulated restart, and stay distinct from
 * `addCompany` (which always writes `dataOrigin: 'user'`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyTendersDataV2 } from '../src/shared/tenders-schema'
import { MOCK_COMPANY } from '../src/renderer/src/mock/company'
import { MOCK_CUSTOMERS } from '../src/renderer/src/mock/customers'
import { MOCK_VAULT } from '../src/renderer/src/mock/vault'
import type { TenderRecord, TendersDataV2, TendersWorkspaceV2 } from '../src/shared/types'
import type {
  SaveTendersRequest,
  SaveTendersResult,
  TendersLoadResult,
} from '../src/shared/tenders-persistence'

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

function demoWorkspace(
  id: string,
  dataOrigin: TendersWorkspaceV2['dataOrigin'],
): TendersWorkspaceV2 {
  return {
    id,
    name: MOCK_COMPANY.name,
    dataOrigin,
    company: clone(MOCK_COMPANY),
    customers: clone(MOCK_CUSTOMERS),
    vault: clone(MOCK_VAULT),
    tenders: [] as TenderRecord[],
  }
}

function loadOk(data: TendersDataV2): TendersLoadResult {
  return { ok: true, status: 'loaded', data, needsSave: false, warnings: [] }
}

function useSuccessfulSave(): void {
  api.saveStoreV2.mockImplementation(async (request: SaveTendersRequest) => {
    const result: SaveTendersResult = {
      ok: true,
      data: { ...clone(request.document), revision: request.expectedRevision + 1, updatedAt: NEXT },
    }
    return result
  })
}

async function hydrateEmpty(): Promise<{ getState: () => any }> {
  api.loadStoreV2.mockResolvedValue(loadOk(createEmptyTendersDataV2(AT)))
  useSuccessfulSave()
  const store = await importStore()
  await store.getState().hydrateFromMain()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  return store
}

function savedDocument(): TendersDataV2 {
  const call = api.saveStoreV2.mock.calls.at(-1)
  return (call?.[0] as SaveTendersRequest).document as TendersDataV2
}

describe('addDemoWorkspace', () => {
  it('inserts, activates and persists an isolated demo workspace', async () => {
    const store = await hydrateEmpty()
    const id = store.getState().addDemoWorkspace(demoWorkspace('co-demo-1', 'demo'))
    expect(id).toBe('co-demo-1')
    await settle()

    const state = store.getState()
    expect(state.workspaces).toHaveLength(1)
    expect(state.workspaces[0].dataOrigin).toBe('demo')
    expect(state.activeCompanyId).toBe('co-demo-1')
    expect(state.hasWorkspaces).toBe(true)

    const persisted = savedDocument()
    expect(persisted.workspaces).toHaveLength(1)
    expect(persisted.workspaces[0].dataOrigin).toBe('demo')
    expect(persisted.activeCompanyId).toBe('co-demo-1')
  })

  it('round-trips across a simulated restart', async () => {
    const store = await hydrateEmpty()
    store.getState().addDemoWorkspace(demoWorkspace('co-demo-restart', 'demo'))
    await settle()
    const committed = savedDocument()

    // Simulated restart: fresh module registry, fresh store, load the snapshot.
    vi.resetModules()
    installTendersApiMock()
    api.loadStoreV2.mockResolvedValue(loadOk(committed))
    useSuccessfulSave()
    const restarted = await importStore()
    await restarted.getState().hydrateFromMain()
    for (let i = 0; i < 12; i += 1) await Promise.resolve()

    const state = restarted.getState()
    expect(state.workspaces).toHaveLength(1)
    expect(state.workspaces[0].id).toBe('co-demo-restart')
    expect(state.workspaces[0].dataOrigin).toBe('demo')
    expect(state.activeCompanyId).toBe('co-demo-restart')
  })

  it('is distinct from addCompany and forces the demo origin', async () => {
    const store = await hydrateEmpty()

    // addCompany always writes a user workspace.
    const userId = store.getState().addCompany(clone(MOCK_COMPANY))
    await settle()
    expect(store.getState().workspaces.find((ws: any) => ws.id === userId)?.dataOrigin).toBe('user')

    // Even when a caller claims 'user', addDemoWorkspace forces 'demo'.
    const demoId = store.getState().addDemoWorkspace(demoWorkspace('co-demo-2', 'user'))
    await settle()

    const demo = store.getState().workspaces.find((ws: any) => ws.id === demoId)
    expect(demo?.dataOrigin).toBe('demo')
    const persisted = savedDocument()
    expect(persisted.workspaces.find((ws) => ws.id === userId)?.dataOrigin).toBe('user')
    expect(persisted.workspaces.find((ws) => ws.id === demoId)?.dataOrigin).toBe('demo')
  })

  it('does not write demo data to localStorage', async () => {
    const store = await hydrateEmpty()
    store.getState().addDemoWorkspace(demoWorkspace('co-demo-3', 'demo'))
    await settle()

    const blob = Array.from(
      { length: window.localStorage.length },
      (_, i) => window.localStorage.getItem(window.localStorage.key(i) ?? '') ?? '',
    ).join('\n')
    expect(blob).not.toContain('dataOrigin')
    expect(blob).not.toContain(MOCK_COMPANY.name)
  })
})

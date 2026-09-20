/**
 * Phase 4 / WP-10 follow-up — preload exposure for `updateTenderOutcome`.
 *
 * The main handler exists; this proves the preload bridge exposes the member
 * and forwards it to the right IPC channel with the request object untouched
 * (trust/bounds stay in main).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exposeInMainWorld, invoke, on, removeListener } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true, dealId: 'deal-1' })),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}))

import { TENDERS_CHANNELS, type TendersApi } from '../src/shared/ipc'

let exposed: TendersApi | undefined

beforeEach(async () => {
  vi.resetModules()
  exposeInMainWorld.mockReset()
  invoke.mockClear()
  exposeInMainWorld.mockImplementation((_key: string, api: TendersApi) => {
    exposed = api
  })
  await import('../src/preload/index')
})

describe('preload tenders bridge', () => {
  it('exposes updateTenderOutcome to the renderer', () => {
    expect(exposeInMainWorld).toHaveBeenCalledWith('tendersApi', expect.anything())
    expect(typeof exposed?.updateTenderOutcome).toBe('function')
  })

  it('forwards updateTenderOutcome to the typed channel with the request', async () => {
    const request = {
      tenderId: 'tender-1',
      outcome: 'won' as const,
      amount: 115000,
      reason: 'best price',
      noticeDate: '2026-12-20T00:00:00.000Z',
    }
    const result = await exposed!.updateTenderOutcome(request)

    expect(invoke).toHaveBeenCalledWith(TENDERS_CHANNELS.updateTenderOutcome, request)
    expect(result).toEqual({ ok: true, dealId: 'deal-1' })
  })

  it('forwards the updated saveDocument / deleteDocument shapes', async () => {
    const saveReq = {
      fileName: 'doc.pdf',
      buffer: new ArrayBuffer(0),
      category: 'vault' as const,
    }
    await exposed!.saveDocument(saveReq)
    expect(invoke).toHaveBeenCalledWith(TENDERS_CHANNELS.saveDocument, saveReq)

    const deleteReq = { storedPath: 'vault/1_doc.pdf', id: 'mf-1' }
    await exposed!.deleteDocument(deleteReq)
    expect(invoke).toHaveBeenCalledWith(TENDERS_CHANNELS.deleteDocument, deleteReq)
  })

  it.each([
    ['listDocumentTrash', TENDERS_CHANNELS.listDocumentTrash, [] as unknown[]],
    ['restoreDocument', TENDERS_CHANNELS.restoreDocument, [{ id: 'trash-1' }]],
    [
      'replaceDocument',
      TENDERS_CHANNELS.replaceDocument,
      [{ storedPath: 'vault/1.pdf', fileName: '1.pdf', buffer: new ArrayBuffer(0) }],
    ],
    ['reconcileDocuments', TENDERS_CHANNELS.reconcileDocuments, [] as unknown[]],
    ['cleanupDocumentTrash', TENDERS_CHANNELS.cleanupDocumentTrash, [{ all: true }]],
    ['listRecoveryCandidates', TENDERS_CHANNELS.listRecoveryCandidates, [] as unknown[]],
    [
      'restoreRecoveryCandidate',
      TENDERS_CHANNELS.restoreRecoveryCandidate,
      [{ id: 'backups/tenders-data.2.json' }],
    ],
  ])('exposes and forwards %s to its channel', async (method, channel, args) => {
    const fn = (exposed as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]
    expect(typeof fn).toBe('function')
    await fn(...args)
    expect(invoke).toHaveBeenCalledWith(channel, ...args)
  })
})

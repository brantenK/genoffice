/**
 * Phase 4 / WP-10 follow-up — preload exposure for `updateTenderOutcome`.
 *
 * The main handler exists; this proves the preload bridge exposes the member
 * and forwards it to the right IPC channel with the request object untouched
 * (trust/bounds stay in main).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exposeInMainWorld, invoke, on, removeListener, ipcRendererStub } = vi.hoisted(() => {
  const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true, dealId: 'deal-1' }))
  const on = vi.fn()
  const removeListener = vi.fn()
  return {
    exposeInMainWorld: vi.fn(),
    invoke,
    on,
    removeListener,
    ipcRendererStub: { invoke, on, removeListener },
  }
})

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: ipcRendererStub,
}))

import {
  AI_CHANNELS,
  TENDERS_CHANNELS,
  type AiSettings,
  type AiStreamChunk,
  type AiStreamRequest,
  type TendersApi,
} from '../src/shared/ipc'

let exposed: TendersApi | undefined

beforeEach(async () => {
  vi.resetModules()
  exposeInMainWorld.mockReset()
  invoke.mockClear()
  on.mockClear()
  removeListener.mockClear()
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

  it('projects the tender id into the proposal payload so main can verify readiness', async () => {
    await exposed!.draftProposalDoc({
      id: 'tender-1',
      title: 'Supply and Delivery of Office Computers',
      referenceNumber: 'ICT/2026/041',
      issuingBody: 'Provincial Administration Office',
      closingDate: '2026-12-18',
      estimatedValue: 115000,
      pricingConfirmed: true,
      status: 'IN_PROGRESS',
      fileUrl: 'documents/rfp.pdf',
      requirements: [
        {
          id: 'req-tax',
          title: 'Valid SARS Tax Clearance / TCS PIN',
          verbatimClause: 'Bidders must submit valid proof of tax compliance.',
          isMandatory: true,
          status: 'FULFILLED',
          linkedVaultDocId: 'vault-tax',
          healthStatus: 'VALID',
          ruleKey: 'tax_pin',
          reason: null,
          notApplicableReason: null,
          notes: null,
          riskLevel: 'CRITICAL_DISQUALIFIER',
        },
      ],
      milestones: [
        { id: 'ms-1', name: 'Delivery', amount: 115000, dueDate: '2026-11-30', status: 'PENDING' },
      ],
      signatureChecks: { declaration: true },
    })

    expect(invoke).toHaveBeenCalledWith(
      TENDERS_CHANNELS.draftProposalDoc,
      expect.objectContaining({ id: 'tender-1', pricingConfirmed: true }),
    )
    const payload = invoke.mock.calls.at(-1)?.[1] as Record<string, unknown>
    // The readiness-critical fields survive the projection; unrelated record
    // fields (e.g. fileUrl, riskLevel) do not.
    expect(payload.id).toBe('tender-1')
    expect(payload).not.toHaveProperty('fileUrl')
    expect(payload.requirements).toEqual([
      expect.objectContaining({ id: 'req-tax', ruleKey: 'tax_pin', status: 'FULFILLED' }),
    ])
    expect((payload.requirements as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'riskLevel',
    )
    expect(payload.milestones).toEqual([
      { id: 'ms-1', name: 'Delivery', amount: 115000, dueDate: '2026-11-30' },
    ])
    expect(payload.signatureChecks).toEqual({ declaration: true })
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

/**
 * Shared AI surface. The `ai:*` handlers are registered exactly once by the
 * shell's main process (`registerAiIpc()` from the docs app) and Tenders runs in
 * that same process, so the bridge is a pure pass-through: it must reach the
 * shell's channels and must NOT try to own them (a second `ipcMain.handle` on
 * the same channel throws "second handler"). What these tests pin is the wire
 * contract the AI extraction pass is written against.
 */
describe('preload tenders bridge — shared AI channels', () => {
  const streamRequest = {
    requestId: 'req-1',
    settings: { provider: 'openai', providers: {} } as unknown as AiSettings,
    system: 'extract the requirements',
    messages: [{ role: 'user', text: 'clause text' }],
  } satisfies AiStreamRequest

  it('exposes the four AI members as functions', () => {
    for (const member of ['getAiSettings', 'aiStream', 'aiStreamCancel', 'onAiStream']) {
      expect(typeof (exposed as unknown as Record<string, unknown>)[member], member).toBe(
        'function',
      )
    }
  })

  it('reads settings through the shell-registered ai:get-settings channel', async () => {
    await exposed!.getAiSettings()
    expect(invoke).toHaveBeenCalledWith(AI_CHANNELS.getSettings)
    expect(AI_CHANNELS.getSettings).toBe('ai:get-settings')
  })

  it('forwards aiStream to ai:stream with the request untouched', async () => {
    await exposed!.aiStream(streamRequest)
    expect(AI_CHANNELS.stream).toBe('ai:stream')
    expect(invoke).toHaveBeenCalledWith(AI_CHANNELS.stream, streamRequest)
    // Same reference: the bridge adds no fields, so main validates exactly what
    // the renderer sent (settings, messages, tools, maxTokens).
    expect(invoke.mock.calls.at(-1)?.[1]).toBe(streamRequest)
  })

  it('forwards aiStreamCancel to ai:stream-cancel with the request id', async () => {
    await exposed!.aiStreamCancel('req-1')
    expect(AI_CHANNELS.streamCancel).toBe('ai:stream-cancel')
    expect(invoke).toHaveBeenCalledWith(AI_CHANNELS.streamCancel, 'req-1')
  })

  it('delivers ai:stream-chunk payloads to the subscriber and unsubscribes on demand', () => {
    const chunks: AiStreamChunk[] = []
    const unsubscribe = exposed!.onAiStream((chunk) => chunks.push(chunk))

    expect(AI_CHANNELS.streamChunk).toBe('ai:stream-chunk')
    expect(on).toHaveBeenCalledWith(AI_CHANNELS.streamChunk, expect.any(Function))
    const listener = on.mock.calls.at(-1)?.[1] as (event: unknown, chunk: AiStreamChunk) => void

    listener({}, { requestId: 'req-1', type: 'delta', text: 'clause 4.2' })
    listener({}, { requestId: 'req-1', type: 'done' })
    expect(chunks).toEqual([
      { requestId: 'req-1', type: 'delta', text: 'clause 4.2' },
      { requestId: 'req-1', type: 'done' },
    ])

    unsubscribe()
    // Removes THIS listener from THIS channel — not a blanket removeAllListeners,
    // so a second extraction pass (or the AI panel) keeps its own subscription.
    expect(removeListener).toHaveBeenCalledWith(AI_CHANNELS.streamChunk, listener)
  })

  it('never hands the renderer ipcRenderer: every exposed member is a function', () => {
    expect(exposed).not.toBe(ipcRendererStub)
    const members = Object.entries(exposed as unknown as Record<string, unknown>)
    expect(members.length).toBeGreaterThan(0)
    for (const [key, value] of members) {
      expect(typeof value, key).toBe('function')
    }
    for (const leaked of ['ipcRenderer', 'invoke', 'send', 'on', 'removeListener']) {
      expect(Object.keys(exposed as unknown as Record<string, unknown>), leaked).not.toContain(
        leaked,
      )
    }
  })
})

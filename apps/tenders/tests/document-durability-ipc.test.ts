/**
 * IPC surface for the durability work (Phase 5 WP-9 managed files + WP-2
 * recovery). Every new channel is behind the same `isTrustedTendersEvent` gate;
 * untrusted callers are rejected with no side effects. Electron is mocked.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => (globalThis as any).__tendersDurabilityDir,
    isReady: () => true,
  },
  ipcMain: {
    handle: (channel: string, listener: (...args: any[]) => any) => {
      ipcHandlers.set(channel, listener)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    },
  },
  shell: { openPath: vi.fn(async () => '') },
  WebContentsView: class MockWebContentsView {
    webContents = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
  },
}))

import {
  configureTendersRuntime,
  registerTendersIpc,
  registerTendersWebContents,
  resetTendersIpcForTests,
} from '../src/main/tenders-main'
import { TENDERS_CHANNELS } from '../src/shared/ipc'
import { createEmptyTendersDataV2 } from '../src/shared/tenders-schema'
import type { TendersDataV2 } from '../src/shared/types'

const TRUSTED_RENDERER_URL = 'http://localhost:5179/'
const ISO = '2026-09-14T10:11:12.345Z'

let testDir = ''

const NEW_CHANNELS = [
  TENDERS_CHANNELS.listDocumentTrash,
  TENDERS_CHANNELS.restoreDocument,
  TENDERS_CHANNELS.replaceDocument,
  TENDERS_CHANNELS.reconcileDocuments,
  TENDERS_CHANNELS.cleanupDocumentTrash,
  TENDERS_CHANNELS.listRecoveryCandidates,
  TENDERS_CHANNELS.restoreRecoveryCandidate,
] as const

function makeTestDir(): string {
  const dir = join(tmpdir(), `tenders-dur-ipc-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  ;(globalThis as any).__tendersDurabilityDir = dir
  return dir
}

function trustedEvent(): { sender: any; senderFrame: any } {
  const sender: any = { isDestroyed: () => false, getURL: () => TRUSTED_RENDERER_URL }
  registerTendersWebContents(sender)
  return { sender, senderFrame: { url: TRUSTED_RENDERER_URL, parent: null } }
}

function untrustedEvent(): { sender: any; senderFrame: any } {
  // Never registered with the main process.
  const sender: any = { isDestroyed: () => false, getURL: () => TRUSTED_RENDERER_URL }
  return { sender, senderFrame: { url: TRUSTED_RENDERER_URL, parent: null } }
}

function validV2(revision = 0): TendersDataV2 {
  return { ...createEmptyTendersDataV2(ISO), revision }
}

function handler(channel: string): (...args: any[]) => any {
  const found = ipcHandlers.get(channel)
  if (!found) throw new Error(`Handler not registered: ${channel}`)
  return found
}

function tendersBaseDir(): string {
  return join(testDir, 'tenders')
}

describe('managed-file + recovery IPC', () => {
  beforeEach(() => {
    testDir = makeTestDir()
    resetTendersIpcForTests()
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
    })
    registerTendersIpc()
  })

  afterEach(() => {
    resetTendersIpcForTests()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('rejects every new channel from an untrusted sender with no side effects', async () => {
    for (const channel of NEW_CHANNELS) {
      const result = await handler(channel)(untrustedEvent())
      expect(result, channel).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: expect.stringMatching(/authoriz|trusted|registered/i),
        },
      })
    }
    expect(existsSync(join(tendersBaseDir(), 'documents'))).toBe(false)
    expect(existsSync(join(tendersBaseDir(), '.trash'))).toBe(false)
    expect(existsSync(join(tendersBaseDir(), 'backups'))).toBe(false)
  })

  it('round-trips save -> trash -> list -> restore through the handlers', async () => {
    const save = handler(TENDERS_CHANNELS.saveDocument)
    const saved = await save(trustedEvent(), {
      fileName: 'policy.pdf',
      buffer: Buffer.from('policy bytes'),
      category: 'rfp',
    })
    expect(saved.ok).toBe(true)
    expect(saved.storedPath).toMatch(/^documents\//)
    expect(saved.id).toMatch(/^mf-/)

    expect((await handler(TENDERS_CHANNELS.listDocumentTrash)(trustedEvent())).entries).toEqual([])

    const deleted = await handler(TENDERS_CHANNELS.deleteDocument)(trustedEvent(), {
      storedPath: saved.storedPath,
    })
    expect(deleted.ok).toBe(true)
    expect(deleted.trashId).toMatch(/^mf-/)

    const trash = await handler(TENDERS_CHANNELS.listDocumentTrash)(trustedEvent())
    expect(trash.ok).toBe(true)
    expect(trash.entries).toHaveLength(1)
    const entry = trash.entries[0]
    expect(entry.deletedFrom).toBe(saved.storedPath)
    expect(existsSync(join(tendersBaseDir(), saved.storedPath))).toBe(false)

    const restored = await handler(TENDERS_CHANNELS.restoreDocument)(trustedEvent(), {
      id: entry.id,
    })
    expect(restored.ok).toBe(true)
    expect(restored.storedPath).toMatch(/^documents\//)
    expect(existsSync(join(tendersBaseDir(), restored.storedPath))).toBe(true)
    expect(
      (await handler(TENDERS_CHANNELS.listDocumentTrash)(trustedEvent())).entries,
    ).toHaveLength(0)
  })

  it('replaces a document and reports reconciliation + cleanup', async () => {
    const saved = await handler(TENDERS_CHANNELS.saveDocument)(trustedEvent(), {
      fileName: 'old.pdf',
      buffer: Buffer.from('old'),
      category: 'vault',
    })
    const replaced = await handler(TENDERS_CHANNELS.replaceDocument)(trustedEvent(), {
      storedPath: saved.storedPath,
      fileName: 'new.pdf',
      buffer: Buffer.from('new'),
    })
    expect(replaced.ok).toBe(true)
    expect(replaced.previousTrashed).toBe(true)
    expect(replaced.storedPath).toMatch(/^vault\//)

    const reconciled = await handler(TENDERS_CHANNELS.reconcileDocuments)(trustedEvent())
    expect(reconciled.ok).toBe(true)
    expect(reconciled.reconciliation.activeCount).toBe(1)
    expect(reconciled.reconciliation.trashed).toHaveLength(1)

    // Move the active file away to trigger a missing report.
    rmSync(join(tendersBaseDir(), replaced.storedPath), { force: true })
    const afterMissing = await handler(TENDERS_CHANNELS.reconcileDocuments)(trustedEvent())
    expect(afterMissing.reconciliation.missing).toHaveLength(1)

    const cleaned = await handler(TENDERS_CHANNELS.cleanupDocumentTrash)(trustedEvent(), {
      all: true,
    })
    expect(cleaned.ok).toBe(true)
    expect(cleaned.removed).toBe(1)
  })

  it('validates request shapes for restore/cleanup/recovery', async () => {
    expect(
      await handler(TENDERS_CHANNELS.restoreDocument)(trustedEvent(), { id: '' }),
    ).toMatchObject({ ok: false })
    expect(
      await handler(TENDERS_CHANNELS.cleanupDocumentTrash)(trustedEvent(), { olderThanMs: -1 }),
    ).toMatchObject({ ok: false })
    const traversal = await handler(TENDERS_CHANNELS.restoreRecoveryCandidate)(trustedEvent(), {
      id: '../../secret.json',
    })
    expect(traversal).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('deletes by managed record id, which takes precedence over the stored path', async () => {
    const saved = await handler(TENDERS_CHANNELS.saveDocument)(trustedEvent(), {
      fileName: 'by-id.pdf',
      buffer: Buffer.from('by id'),
      category: 'rfp',
    })
    const other = await handler(TENDERS_CHANNELS.saveDocument)(trustedEvent(), {
      fileName: 'other.pdf',
      buffer: Buffer.from('other'),
      category: 'rfp',
    })
    const remove = handler(TENDERS_CHANNELS.deleteDocument)

    // An unknown id is refused rather than silently deleting a path.
    expect(await remove(trustedEvent(), { id: 'mf-does-not-exist' })).toMatchObject({ ok: false })
    // An id and a path that disagree are refused too.
    expect(
      await remove(trustedEvent(), { id: saved.id, storedPath: other.storedPath }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/different documents/i) })
    expect(existsSync(join(tendersBaseDir(), other.storedPath))).toBe(true)

    // The id alone is enough (the preferred form), and it trashes that document.
    const deleted = await remove(trustedEvent(), { id: saved.id })
    expect(deleted.ok).toBe(true)
    expect(deleted.trashId).toBe(saved.id)
    expect(existsSync(join(tendersBaseDir(), saved.storedPath))).toBe(false)
    const trash = await handler(TENDERS_CHANNELS.listDocumentTrash)(trustedEvent())
    expect(trash.entries.map((entry: any) => entry.recordId)).toEqual([saved.id])
  })

  it('refuses the test reset outside a test runner without deleting user data', async () => {
    mkdirSync(join(tendersBaseDir(), 'documents'), { recursive: true })
    const sentinel = join(tendersBaseDir(), 'documents', 'keep-me.pdf')
    writeFileSync(sentinel, 'user data', 'utf8')

    const savedVitest = process.env.VITEST
    const savedNodeEnv = process.env.NODE_ENV
    process.env.VITEST = ''
    process.env.NODE_ENV = 'production'
    try {
      expect(() => resetTendersIpcForTests()).toThrow(/test-only/i)
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST
      else process.env.VITEST = savedVitest
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = savedNodeEnv
    }

    expect(existsSync(sentinel)).toBe(true)
    // The refusal happens before the handlers are removed.
    expect(handler(TENDERS_CHANNELS.loadStoreV2)).toBeDefined()
  })

  it('surfaces recovery candidates and restores them explicitly', async () => {
    const saveStore = handler(TENDERS_CHANNELS.saveStoreV2)
    const first = await saveStore(trustedEvent(), { expectedRevision: 0, document: validV2(0) })
    expect(first.ok).toBe(true)
    const second = await saveStore(trustedEvent(), {
      expectedRevision: 1,
      document: { ...validV2(1) },
    })
    expect(second.ok).toBe(true)

    // Two commits => one last-known-good backup.
    const candidateList = await handler(TENDERS_CHANNELS.listRecoveryCandidates)(trustedEvent())
    expect(candidateList.ok).toBe(true)
    expect(candidateList.candidates.length).toBeGreaterThan(0)
    const backup = candidateList.candidates.find((candidate: any) => candidate.source === 'backup')
    expect(backup).toBeDefined()

    // Corrupt the primary: load must ask for recovery, never auto-substitute.
    writeFileSync(join(tendersBaseDir(), 'tenders-data.json'), '{broken', 'utf8')
    const load = await handler(TENDERS_CHANNELS.loadStoreV2)(trustedEvent())
    expect(load.ok).toBe(false)
    expect(load.error.code).toBe('RECOVERY_REQUIRED')
    expect(load.recoveryCandidates?.length ?? 0).toBeGreaterThan(0)
    expect(load).not.toHaveProperty('data')

    const restored = await handler(TENDERS_CHANNELS.restoreRecoveryCandidate)(trustedEvent(), {
      id: backup.id,
    })
    expect(restored.ok).toBe(true)
    const reloaded = JSON.parse(readFileSync(join(tendersBaseDir(), 'tenders-data.json'), 'utf8'))
    expect(reloaded.schemaVersion).toBe(2)
    expect(reloaded.revision).toBeGreaterThanOrEqual(1)
  })
})

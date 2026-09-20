/**
 * Managed-document lifecycle (Phase 5 WP-9): metadata, soft-delete/undo,
 * replace-then-trash ordering, reconciliation, link warnings and bounds.
 *
 * Pure main-side tests (no electron): the store works against a temp directory.
 */
import { basename, join } from 'node:path'
import { mkdtemp, readFile, readdir, rm, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createManagedDocumentStore,
  findManagedFileLinks,
  sanitizeManagedFileName,
  toManagedRelativePath,
} from '../src/main/document-store'
import { MAX_TENDERS_DOCUMENT_UPLOAD_BYTES } from '../src/shared/ipc'
import type { TendersDataV2 } from '../src/shared/types'

const roots: string[] = []

async function tempBaseDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tenders-docs-${randomUUID().slice(0, 8)}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function store(baseDir: string, hooks?: { beforeIndexWrite?: () => void | Promise<void> }) {
  return createManagedDocumentStore({ baseDir, hooks })
}

describe('managed-document metadata + save', () => {
  it('records id, relative path, size, MIME, hash and timestamps on save', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    const bytes = Buffer.from('Mock RFP document content')

    const saved = await managed.save({
      fileName: '../../malicious_name.pdf',
      buffer: bytes,
      category: 'rfp',
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    expect(saved.record.id).toMatch(/^mf-/)
    expect(saved.record.relativePath).toMatch(/^documents\/\d+_malicious_name\.pdf$/)
    expect(saved.record.fileName).toBe('malicious_name.pdf')
    expect(saved.record.mimeType).toBe('application/pdf')
    expect(saved.record.size).toBe(bytes.byteLength)
    expect(saved.record.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(saved.record.createdAt).toBeTruthy()
    expect(saved.record.updatedAt).toBeTruthy()
    expect(saved.record.state).toBe('active')

    const full = join(baseDir, saved.record.relativePath)
    expect(existsSync(full)).toBe(true)
    expect(await readFile(full, 'utf8')).toBe('Mock RFP document content')

    // Metadata is durable in its own index file.
    const index = JSON.parse(await readFile(join(baseDir, 'managed-documents.json'), 'utf8'))
    expect(index.records).toHaveLength(1)
    expect(index.records[0].id).toBe(saved.record.id)
  })

  it('rejects an oversize buffer before writing', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    const oversize = Buffer.alloc(MAX_TENDERS_DOCUMENT_UPLOAD_BYTES + 1)
    const result = await managed.save({ fileName: 'big.pdf', buffer: oversize, category: 'rfp' })
    expect(result.ok).toBe(false)
    expect(existsSync(join(baseDir, 'documents'))).toBe(false)
  })
})

describe('soft-delete trash + undo across restart', () => {
  it('moves the file to trash (never hard-unlinks) and lists a restorable entry', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    const saved = await managed.save({
      fileName: 'certificate.pdf',
      buffer: Buffer.from('vault bytes'),
      category: 'vault',
    })
    if (!saved.ok) throw new Error(saved.error)

    const trashed = await managed.trash(saved.record.relativePath)
    expect(trashed.ok).toBe(true)
    if (!trashed.ok) return
    expect(trashed.entry?.trashedPath).toMatch(/^\.trash\//)

    // Original path is free; the bytes still exist in the trash directory.
    expect(existsSync(join(baseDir, saved.record.relativePath))).toBe(false)
    expect(existsSync(join(baseDir, trashed.entry!.trashedPath))).toBe(true)
    const trash = await managed.listTrash()
    expect(trash).toHaveLength(1)
    expect(trash[0].deletedFrom).toBe(saved.record.relativePath)

    // Second delete is idempotent.
    expect((await managed.trash(saved.record.relativePath)).ok).toBe(true)
  })

  it('undoes a delete across a simulated restart', async () => {
    const baseDir = await tempBaseDir()
    const first = store(baseDir)
    const saved = await first.save({
      fileName: 'tax.pdf',
      buffer: Buffer.from('tax bytes'),
      category: 'vault',
    })
    if (!saved.ok) throw new Error(saved.error)
    const trashed = await first.trash(saved.record.relativePath)
    if (!trashed.ok || !trashed.entry) throw new Error('trash failed')

    // Restart: a brand-new store instance reads the same metadata index.
    const restarted = store(baseDir)
    const trash = await restarted.listTrash()
    expect(trash.map((entry) => entry.id)).toContain(trashed.entry.id)

    const restored = await restarted.restore(trashed.entry.id)
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    expect(restored.record.state).toBe('active')
    expect(existsSync(join(baseDir, restored.restoredPath))).toBe(true)
    expect(await readFile(join(baseDir, restored.restoredPath), 'utf8')).toBe('tax bytes')
    expect(await restarted.listTrash()).toHaveLength(0)
  })
})

describe('replace-then-trash ordering', () => {
  it('commits the replacement before trashing the previous file', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    const old = await managed.save({
      fileName: 'old.pdf',
      buffer: Buffer.from('old content'),
      category: 'rfp',
    })
    if (!old.ok) throw new Error(old.error)

    const replaced = await managed.replace({
      storedPath: old.record.relativePath,
      fileName: 'new.pdf',
      buffer: Buffer.from('new content'),
    })
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) return
    expect(replaced.previousTrashed).toBe(true)

    expect(existsSync(join(baseDir, replaced.record.relativePath))).toBe(true)
    expect(existsSync(join(baseDir, old.record.relativePath))).toBe(false)
    const trash = await managed.listTrash()
    expect(trash).toHaveLength(1)
    expect(trash[0].deletedFrom).toBe(old.record.relativePath)
  })

  it('leaves the previous file intact when the replacement commit fails', async () => {
    const baseDir = await tempBaseDir()
    let failNextIndexWrite = false
    const managed = store(baseDir, {
      beforeIndexWrite: () => {
        if (failNextIndexWrite) {
          failNextIndexWrite = false
          throw new Error('simulated index commit failure')
        }
      },
    })
    const old = await managed.save({
      fileName: 'old.pdf',
      buffer: Buffer.from('old content'),
      category: 'rfp',
    })
    if (!old.ok) throw new Error(old.error)

    failNextIndexWrite = true
    const replaced = await managed.replace({
      storedPath: old.record.relativePath,
      fileName: 'new.pdf',
      buffer: Buffer.from('new content'),
    })
    expect(replaced.ok).toBe(false)

    // Old file still present, nothing trashed, no half-written replacement.
    expect(existsSync(join(baseDir, old.record.relativePath))).toBe(true)
    expect(await managed.listTrash()).toHaveLength(0)
    const documents = await readdir(join(baseDir, 'documents'))
    expect(documents).toEqual([basename(old.record.relativePath)])
    expect(documents.filter((name) => name.includes('new'))).toHaveLength(0)
  })
})

describe('reconciliation', () => {
  it('reports missing and orphaned files and lists trashed entries', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    const kept = await managed.save({
      fileName: 'kept.pdf',
      buffer: Buffer.from('kept'),
      category: 'rfp',
    })
    const removed = await managed.save({
      fileName: 'removed.pdf',
      buffer: Buffer.from('removed'),
      category: 'vault',
    })
    const trashed = await managed.save({
      fileName: 'trashed.pdf',
      buffer: Buffer.from('trashed'),
      category: 'vault',
    })
    if (!kept.ok || !removed.ok || !trashed.ok) throw new Error('save failed')

    // Delete a tracked file out from under the store.
    await unlink(join(baseDir, removed.record.relativePath))
    // A stray file with no metadata record.
    await writeFile(join(baseDir, 'documents', '999_stray.pdf'), 'stray', 'utf8')
    await managed.trash(trashed.record.relativePath)

    const report = await managed.reconcile()
    expect(report.missing.map((entry) => entry.relativePath)).toEqual([removed.record.relativePath])
    expect(report.orphaned).toContain('documents/999_stray.pdf')
    expect(report.trashed.map((entry) => entry.deletedFrom)).toEqual([trashed.record.relativePath])
    expect(report.activeCount).toBe(1)

    // The missing state is persisted for the next run.
    const records = await managed.listRecords()
    expect(records.find((record) => record.id === removed.record.id)?.state).toBe('missing')
  })
})

describe('link-aware references', () => {
  it('finds tenders, vault documents and customers referencing a file', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    const saved = await managed.save({
      fileName: 'linked.pdf',
      buffer: Buffer.from('linked'),
      category: 'vault',
    })
    if (!saved.ok) throw new Error(saved.error)

    const document = {
      workspaces: [
        {
          vault: [{ id: 'vd-1', title: 'Linked cert', fileUrl: saved.record.relativePath }],
          tenders: [{ id: 't-1', title: 'Roads tender', fileUrl: saved.record.relativePath }],
          customers: [
            {
              id: 'c-1',
              name: 'Buyer Co',
              requiredDocs: [{ linkedVaultDocId: 'vd-1' }],
            },
          ],
        },
      ],
    } as unknown as TendersDataV2

    const links = findManagedFileLinks(saved.record.relativePath, document)
    expect(links).toEqual(
      expect.arrayContaining([
        { kind: 'vault', id: 'vd-1', label: 'Linked cert' },
        { kind: 'tender', id: 't-1', label: 'Roads tender' },
        { kind: 'customer', id: 'c-1', label: 'Buyer Co' },
      ]),
    )
    expect(findManagedFileLinks('vault/other.pdf', document)).toEqual([])
  })
})

describe('path confinement + cleanup', () => {
  it('accepts only managed relative paths and sanitizes names', () => {
    expect(toManagedRelativePath('documents/1_a.pdf')).toBe('documents/1_a.pdf')
    expect(toManagedRelativePath('vault/2_b.pdf')).toBe('vault/2_b.pdf')
    for (const attack of [
      '../../etc/passwd',
      'documents/../tenders-data.json',
      'documents/..',
      '/etc/shadow',
      'C:\\Windows\\System32\\notepad.exe',
      'other/1_a.pdf',
      'documents/a/b.pdf',
      'documents/file.pdf\0.png',
    ]) {
      expect(toManagedRelativePath(attack), attack).toBeNull()
    }
    expect(sanitizeManagedFileName('../../evil name.pdf', 'rfp')).toBe('evil_name.pdf')
    expect(sanitizeManagedFileName('...', 'vault')).toBe('document.pdf')
  })

  it('purges trash only on an explicit cleanup request', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    const saved = await managed.save({
      fileName: 'gone.pdf',
      buffer: Buffer.from('gone'),
      category: 'rfp',
    })
    if (!saved.ok) throw new Error(saved.error)
    const trashed = await managed.trash(saved.record.relativePath)
    if (!trashed.ok || !trashed.entry) throw new Error('trash failed')

    // Default cleanup removes nothing.
    expect((await managed.cleanupTrash()).removed).toBe(0)
    expect(await managed.listTrash()).toHaveLength(1)

    expect((await managed.cleanupTrash({ all: true })).removed).toBe(1)
    expect(await managed.listTrash()).toHaveLength(0)
    expect(existsSync(join(baseDir, trashed.entry.trashedPath))).toBe(false)
  })
})

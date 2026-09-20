/**
 * Rotating backups + explicit recovery (Phase 5 WP-2 remainder).
 *
 * The store keeps last-known-good copies of the previous `tenders-data.json`.
 * `load` never substitutes an empty or backup document; a corrupt primary with
 * recoverable copies surfaces RECOVERY_REQUIRED, and restore is explicit.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createTendersStore, type TendersStore } from '../src/main/tenders-store'
import {
  MAX_TENDERS_BACKUPS,
  TENDERS_PERSISTENCE_FILE_NAME,
} from '../src/shared/tenders-persistence'
import { createEmptyTendersDataV2 } from '../src/shared/tenders-schema'
import type { IssuerTemplate, TendersDataV2 } from '../src/shared/types'

const ISO = '2026-09-14T10:11:12.345Z'
const roots: string[] = []

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tenders-recovery-${randomUUID().slice(0, 8)}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function storePath(directory: string): string {
  return join(directory, TENDERS_PERSISTENCE_FILE_NAME)
}

function issuer(id: string): IssuerTemplate {
  return {
    id,
    name: `Issuer ${id}`,
    displayName: `Issuer ${id}`,
    address: null,
    contact: null,
    refStyle: null,
    submissionMethod: null,
    submissionAddress: null,
    seenCount: 1,
    lastSeen: ISO,
  }
}

function document(revision: number, issuerIds: string[]): TendersDataV2 {
  return { ...createEmptyTendersDataV2(ISO), revision, issuerTemplates: issuerIds.map(issuer) }
}

async function commit(
  store: TendersStore,
  revision: number,
  issuerIds: string[],
): Promise<TendersDataV2> {
  const result = await store.save({
    expectedRevision: revision,
    document: document(revision, issuerIds),
  })
  if (!result.ok) throw new Error(`commit at ${revision} failed: ${result.error.message}`)
  return result.data
}

function backupRevisions(names: string[]): number[] {
  return names
    .map((name) => /^tenders-data\.(\d+)\.json$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((left, right) => left - right)
}

describe('rotating backups', () => {
  it('keeps the last N previous commits and drops the oldest', async () => {
    const directory = await tempDir()
    const store = createTendersStore({ directory, now: () => new Date(ISO) })

    // First commit has no previous file, so no backup yet.
    await commit(store, 0, ['a'])
    expect(existsSync(join(directory, 'backups'))).toBe(false)

    // Each later commit backs up the previous committed revision.
    for (let revision = 1; revision <= 6; revision += 1) {
      await commit(store, revision, [String.fromCharCode(97 + revision)])
    }

    const names = await readdir(join(directory, 'backups'))
    const revisions = backupRevisions(names)
    expect(revisions.length).toBe(MAX_TENDERS_BACKUPS)
    expect(revisions).toEqual([2, 3, 4, 5, 6])
    expect(revisions).not.toContain(1)
    expect(names.some((name) => name.includes('primary-corrupt'))).toBe(false)
  })

  it('lists backups and leftover temporary files as recovery candidates', async () => {
    const directory = await tempDir()
    const store = createTendersStore({ directory, now: () => new Date(ISO) })
    await commit(store, 0, ['a'])
    await commit(store, 1, ['b'])

    // A leftover temp file from a crashed write.
    await writeFile(
      join(directory, 'tenders-data.crashed.tmp'),
      JSON.stringify(document(0, ['tmp'])),
      'utf8',
    )

    const candidates = await store.listRecoveryCandidates()
    const backupCandidate = candidates.find((candidate) => candidate.source === 'backup')
    expect(backupCandidate).toMatchObject({
      id: 'backups/tenders-data.1.json',
      valid: true,
      revision: 1,
    })
    expect(backupCandidate?.sizeBytes).toBeGreaterThan(0)
    const temporary = candidates.find((candidate) => candidate.source === 'temporary')
    expect(temporary?.id).toBe('tenders-data.crashed.tmp')
    // Newest revision first.
    expect(candidates[0].revision).toBeGreaterThanOrEqual(
      candidates[candidates.length - 1].revision ?? 0,
    )
  })

  it('marks an unreadable candidate invalid instead of throwing', async () => {
    const directory = await tempDir()
    const store = createTendersStore({ directory, now: () => new Date(ISO) })
    await commit(store, 0, ['a'])
    await commit(store, 1, ['b'])
    await writeFile(join(directory, 'backups', 'tenders-data.999.json'), '{broken', 'utf8')

    const candidates = await store.listRecoveryCandidates()
    const broken = candidates.find((candidate) => candidate.id.endsWith('999.json'))
    expect(broken?.valid).toBe(false)
    expect(broken?.reason).toBeTruthy()
  })
})

describe('explicit recovery', () => {
  it('restores a chosen backup at a monotonic revision (never auto-applied)', async () => {
    const directory = await tempDir()
    const store = createTendersStore({ directory, now: () => new Date(ISO) })
    await commit(store, 0, ['a'])
    await commit(store, 1, ['b'])
    await commit(store, 2, ['c'])

    const restored = await store.restoreRecoveryCandidate('backups/tenders-data.1.json')
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    expect(restored.data.revision).toBe(4)
    expect(restored.data.issuerTemplates[0]?.name).toBe('Issuer a')
    const onDisk = JSON.parse(await readFile(storePath(directory), 'utf8'))
    expect(onDisk.revision).toBe(4)
    expect(onDisk.issuerTemplates[0]?.name).toBe('Issuer a')
  })

  it('rejects a candidate id outside the store directory', async () => {
    const directory = await tempDir()
    const store = createTendersStore({ directory, now: () => new Date(ISO) })
    await commit(store, 0, ['a'])

    for (const id of [
      '../../secret.json',
      'backups/../tenders-data.json',
      'tenders-data.json',
      '/etc/shadow',
      'C:\\Windows\\notepad.exe',
      '',
    ]) {
      const result = await store.restoreRecoveryCandidate(id)
      expect(result.ok, id).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST')
    }
  })
})

describe('corrupt primary never auto-substitutes', () => {
  it('returns RECOVERY_REQUIRED with candidates and no data', async () => {
    const directory = await tempDir()
    const store = createTendersStore({ directory, now: () => new Date(ISO) })
    await commit(store, 0, ['a'])
    await commit(store, 1, ['b'])
    await writeFile(storePath(directory), '{broken', 'utf8')

    const result = await store.load()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('RECOVERY_REQUIRED')
    expect(result.recoveryCandidates?.length ?? 0).toBeGreaterThan(0)
    expect(result).not.toHaveProperty('data')
    expect(JSON.stringify(result)).not.toMatch(/issuer-a|issuer-b/i)
  })

  it('keeps READ_FAILED (no recovery screen) when no candidates exist', async () => {
    const directory = await tempDir()
    await writeFile(storePath(directory), '{broken', 'utf8')
    const store = createTendersStore({ directory, now: () => new Date(ISO) })

    const result = await store.load()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('READ_FAILED')
  })

  it('recovers over a corrupt primary by quarantining it first', async () => {
    const directory = await tempDir()
    const store = createTendersStore({ directory, now: () => new Date(ISO) })
    await commit(store, 0, ['a'])
    await commit(store, 1, ['b'])
    await writeFile(storePath(directory), '{broken', 'utf8')

    const restored = await store.restoreRecoveryCandidate('backups/tenders-data.1.json')
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    expect(restored.data.revision).toBe(1)
    expect(restored.data.issuerTemplates[0]?.name).toBe('Issuer a')

    const recovered = JSON.parse(await readFile(storePath(directory), 'utf8'))
    expect(recovered.revision).toBe(1)
    const backups = await readdir(join(directory, 'backups'))
    expect(backups.some((name) => name.startsWith('primary-corrupt-'))).toBe(true)
  })

  it('does not let a malformed candidate replace the current document', async () => {
    const directory = await tempDir()
    const store = createTendersStore({ directory, now: () => new Date(ISO) })
    await commit(store, 0, ['a'])
    await commit(store, 1, ['b'])
    const before = await readFile(storePath(directory), 'utf8')
    await writeFile(join(directory, 'backups', 'tenders-data.999.json'), '{broken', 'utf8')

    const restored = await store.restoreRecoveryCandidate('backups/tenders-data.999.json')
    expect(restored.ok).toBe(false)
    if (!restored.ok) expect(['READ_FAILED', 'INVALID_DATA']).toContain(restored.error.code)
    expect(await readFile(storePath(directory), 'utf8')).toBe(before)
  })
})

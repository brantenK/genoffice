// @vitest-environment node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { BOOKS_CHANNELS } from '../../src/shared/ipc'
import type { BooksDataEnvelope } from '../../src/shared/types'
import { bootBooksE2E, type BooksE2ESession } from '../helpers/books-e2e'
import { FNB_SETTLEMENT_CSV, emptyLedger } from './fixtures'

vi.mock('electron', async () => {
  const { createElectronModule } = await import('../helpers/electron-mock')
  return createElectronModule()
})

// Booting the real module re-imports its whole graph; the shared runner is
// slow under parallel load, so these journeys get more room than the unit suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

interface BackupResult {
  ok: boolean
  path?: string
  error?: string
}

interface RestoreResult {
  ok: boolean
  error?: string
  restoredData?: BooksDataEnvelope
}

interface BackupFileInfo {
  name: string
  path: string
  size: number
  modifiedAt: string
}

function accountBalance(data: BooksDataEnvelope, id: string): number {
  return data.accounts.find((account) => account.id === id)?.balance ?? Number.NaN
}

describe('Books e2e: backup and restore', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  const backupNow = () => session.invoke<BackupResult>(BOOKS_CHANNELS.backupNow)
  const listBackups = () => session.invoke<BackupFileInfo[]>(BOOKS_CHANNELS.listBackups)
  const restoreBackup = (name: string) =>
    session.invoke<RestoreResult>(BOOKS_CHANNELS.restoreBackup, name)

  it('restores the pre-mutation ledger and keeps the audit trail', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Bulk water pipeline maintenance',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)

    const before = (await session.loadData())!
    const backup = await backupNow()
    expect(backup.ok).toBe(true)
    const backupPath = backup.path!
    expect(existsSync(backupPath)).toBe(true)
    expect(session.backupsDir).toBe(backupPath.replace(/[/\\][^/\\]+$/, ''))

    const listed = await listBackups()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: basename(backupPath), path: backupPath })
    expect(listed[0].size).toBeGreaterThan(0)
    expect(Number.isNaN(Date.parse(listed[0].modifiedAt))).toBe(false)

    const imported = await session.invoke<{ ok: boolean; importedCount?: number }>(
      BOOKS_CHANNELS.importBankStatementCsv,
      FNB_SETTLEMENT_CSV,
    )
    expect(imported.ok).toBe(true)
    const mutated = (await session.loadData())!
    expect(mutated.bankTransactions).toHaveLength(1)
    expect(accountBalance(mutated, 'acc-bank')).toBe(23000)

    const restored = await restoreBackup(basename(backupPath))
    expect(restored.ok).toBe(true)
    expect(restored.restoredData?.invoices).toEqual(before.invoices)

    const after = (await session.loadData())!
    expect(after.invoices).toEqual(before.invoices)
    expect(after.journalEntries).toEqual(before.journalEntries)
    expect(after.parties).toEqual(before.parties)
    expect(after.accounts).toEqual(before.accounts)
    expect(after.bankTransactions).toEqual([])
    expect(accountBalance(after, 'acc-bank')).toBe(0)

    // Evidence recorded after the backup is never erased by a restore.
    const actions = (after.auditLog ?? []).map((entry) => entry.action)
    expect(actions).toContain('invoice.issue')
    expect(actions).toContain('bank.import')
    expect(actions).toContain('backup.restore')

    const safetyCopies = session
      .listFiles(session.backupsDir)
      .filter((name) => name.startsWith('pre-restore-'))
    expect(safetyCopies).toHaveLength(1)
    const safety = JSON.parse(
      readFileSync(join(session.backupsDir, safetyCopies[0]), 'utf8'),
    ) as BooksDataEnvelope
    expect(safety.bankTransactions).toHaveLength(1)
    expect(safety.invoices).toEqual(before.invoices)

    const broadcast = session
      .broadcasts()
      .filter((message) => message.channel === BOOKS_CHANNELS.dataChanged)
      .at(-1)
    expect((broadcast?.args[0] as BooksDataEnvelope)?.invoices).toEqual(before.invoices)
  })

  it('resolves restore names inside the backups directory only', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const bytes = session.readBooksFile()

    // A valid-JSON backup-shaped file one level up must never be restorable.
    writeFileSync(
      join(session.booksDir, 'books-backup-outside.json'),
      JSON.stringify(emptyLedger()),
    )

    expect(await restoreBackup('../books-backup-outside.json')).toEqual({
      ok: false,
      error: 'Backup file not found',
    })
    expect(await restoreBackup('..\\..\\books-backup-outside.json')).toEqual({
      ok: false,
      error: 'Backup file not found',
    })
    expect(await restoreBackup('')).toEqual({ ok: false, error: 'Invalid backup name' })
    expect(await restoreBackup('books-data.json')).toEqual({
      ok: false,
      error: 'Invalid backup name',
    })
    expect(await restoreBackup('evil.json')).toEqual({ ok: false, error: 'Invalid backup name' })

    const missing = await restoreBackup('books-backup-19700101-000000.json')
    expect(missing).toEqual({ ok: false, error: 'Backup file not found' })

    expect(session.readBooksFile()).toBe(bytes)
  })

  it('refuses to restore a backup that is not a books ledger', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const bytes = session.readBooksFile()

    const backupDir = session.backupsDir
    mkdirSync(backupDir, { recursive: true })
    const corruptName = 'books-backup-20260101-000000.json'
    const wrongShapeName = 'books-backup-20260101-000001.json'
    writeFileSync(join(backupDir, corruptName), '{"version": 1, "accounts": [', 'utf8')
    writeFileSync(join(backupDir, wrongShapeName), '{"hello": "world"}', 'utf8')

    const corrupt = await restoreBackup(corruptName)
    expect(corrupt.ok).toBe(false)
    expect(corrupt.error).toContain('Backup file is not valid JSON')

    const wrongShape = await restoreBackup(wrongShapeName)
    expect(wrongShape.ok).toBe(false)
    expect(wrongShape.error).toBe('Backup file is not a books ledger (missing accounts/invoices)')

    expect(session.readBooksFile()).toBe(bytes)
    expect(await listBackups()).toHaveLength(2)
  })

  it('fails a backup request when no ledger exists yet and prunes beyond ten backups', async () => {
    const empty = await backupNow()
    expect(empty.ok).toBe(false)
    expect(empty.error).toBe('Books data file does not exist')

    expect(await session.saveData(emptyLedger())).toBe(true)
    for (let i = 0; i < 11; i++) {
      const created = await backupNow()
      expect(created.ok).toBe(true)
      // Space the backups apart: same-millisecond backup names collide in
      // exportBackup (books-backup-<stamp>-<Date.now()>) and overwrite each other.
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(await listBackups()).toHaveLength(10)
    expect(
      session.listFiles(session.backupsDir).filter((name) => name.startsWith('books-backup-')),
    ).toHaveLength(10)
  })
})

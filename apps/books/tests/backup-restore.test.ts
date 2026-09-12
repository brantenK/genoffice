import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportBackup, listBackups, pruneBackups, restoreBackup } from '../src/main/backup-restore'
import {
  CURRENT_BOOKS_SCHEMA_VERSION,
  DEFAULT_BOOK_SETTINGS,
  migrateAndValidateBooks,
  readBooksStore,
  writeBooksStore,
} from '../src/main/books-core'
import { CORE_ACCOUNTS } from '../src/shared/chart'

describe('Backup & Restore Suite', () => {
  let testDir: string
  let booksFilePath: string
  let backupsDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `books-backup-test-${randomUUID().slice(0, 8)}`)
    mkdirSync(testDir, { recursive: true })
    booksFilePath = join(testDir, 'books-data.json')
    backupsDir = join(testDir, 'backups')
  })

  afterEach(() => {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    } catch {}
  })

  const writeSampleStore = (companyName: string, partyName: string): void => {
    writeBooksStore(booksFilePath, {
      version: CURRENT_BOOKS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      settings: { ...DEFAULT_BOOK_SETTINGS, companyName },
      accounts: [...CORE_ACCOUNTS],
      parties: [{ id: 'p1', name: partyName, type: 'Customer', outstandingBalance: 0 }],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
    })
  }

  const writeBackupFile = (name: string, content: string, mtimeSeconds: number): string => {
    if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true })
    const p = join(backupsDir, name)
    writeFileSync(p, content, 'utf8')
    const t = new Date(Date.UTC(2026, 8, 7, 10, 0, mtimeSeconds))
    utimesSync(p, t, t)
    return p
  }

  describe('exportBackup', () => {
    it('creates a valid backup file in the backups directory', () => {
      writeSampleStore('Zano Consulting', 'Acme Corp')
      const result = exportBackup(booksFilePath)

      expect(result.ok).toBe(true)
      expect(result.path).toBeDefined()

      const name = result.path!.replace(/\\/g, '/').split('/').pop()!
      expect(name).toMatch(/^books-backup-\d{8}-\d{6}\.json$/)
      expect(result.path).toBe(join(backupsDir, name))

      const raw = JSON.parse(readFileSync(result.path!, 'utf8'))
      expect(migrateAndValidateBooks(raw).settings.companyName).toBe('Zano Consulting')
    })

    it('creates the backups directory on demand', () => {
      writeSampleStore('Zano Consulting', 'Acme Corp')
      expect(existsSync(backupsDir)).toBe(false)
      const result = exportBackup(booksFilePath)
      expect(result.ok).toBe(true)
      expect(existsSync(backupsDir)).toBe(true)
    })

    it('returns an error when the books data file does not exist', () => {
      const result = exportBackup(booksFilePath)
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.path).toBeUndefined()
    })

    it('honours an explicit backups directory', () => {
      writeSampleStore('Zano Consulting', 'Acme Corp')
      const customDir = join(testDir, 'custom-backups')
      const result = exportBackup(booksFilePath, customDir)
      expect(result.ok).toBe(true)
      expect(result.path).toContain(customDir)
      expect(existsSync(join(customDir, result.path!.replace(/\\/g, '/').split('/').pop()!))).toBe(
        true,
      )
    })
  })

  describe('listBackups', () => {
    it('lists backups newest first and filters out non-backup files', () => {
      writeBackupFile('books-backup-20260907-100000.json', '{"seq":1}', 1)
      writeBackupFile('books-backup-20260907-100001.json', '{"seq":2}', 2)
      writeBackupFile('books-backup-20260907-100002.json', '{"seq":3}', 3)
      writeFileSync(join(backupsDir, 'notes.txt'), 'not a backup', 'utf8')
      writeFileSync(join(backupsDir, 'pre-restore-20260907-100003.json'), '{}', 'utf8')
      writeFileSync(join(backupsDir, 'other.json'), '{}', 'utf8')
      writeFileSync(join(backupsDir, 'books-backup.json'), '{}', 'utf8')

      const backups = listBackups(backupsDir)

      expect(backups).toHaveLength(3)
      expect(backups.map((b) => b.name)).toEqual([
        'books-backup-20260907-100002.json',
        'books-backup-20260907-100001.json',
        'books-backup-20260907-100000.json',
      ])
      expect(backups[0].size).toBe('{"seq":3}'.length)
      expect(backups[0].modifiedAt).toBe(new Date(Date.UTC(2026, 8, 7, 10, 0, 3)).toISOString())
      expect(backups[0].path).toBe(join(backupsDir, backups[0].name))
    })

    it('returns an empty list for a missing or empty backups directory', () => {
      expect(listBackups(join(testDir, 'does-not-exist'))).toEqual([])
      mkdirSync(backupsDir, { recursive: true })
      expect(listBackups(backupsDir)).toEqual([])
    })
  })

  describe('restoreBackup', () => {
    it('round-trips: restore returns the exact backed-up state', () => {
      writeSampleStore('Zano Consulting', 'Acme Corp')
      const backup = exportBackup(booksFilePath)
      expect(backup.ok).toBe(true)

      // Mutate the live store after the backup was taken.
      writeSampleStore('Mutated Company', 'Mutated Party')

      const result = restoreBackup(backup.path!, booksFilePath)
      expect(result.ok).toBe(true)

      const restored = readBooksStore(booksFilePath)
      const expected = migrateAndValidateBooks(JSON.parse(readFileSync(backup.path!, 'utf8')))
      expect(restored.settings.companyName).toBe('Zano Consulting')
      expect(restored.parties[0].name).toBe('Acme Corp')
      // Restore retains the ledger payload while appending the required audit
      // event; audit history must never be rewound by an old backup.
      const { auditLog: restoredAudit, ...restoredLedger } = restored
      const { auditLog: _expectedAudit, ...expectedLedger } = expected
      expect(restoredLedger).toEqual(expectedLedger)
      expect(restoredAudit?.some((entry) => entry.action === 'backup.restore')).toBe(true)
    })

    it('rejects a corrupt/truncated backup without touching the current file', () => {
      writeSampleStore('Zano Consulting', 'Acme Corp')
      const originalContent = readFileSync(booksFilePath, 'utf8')

      const corruptPath = writeBackupFile(
        'books-backup-20260907-100000.json',
        originalContent.slice(0, Math.floor(originalContent.length / 2)),
        1,
      )

      const result = restoreBackup(corruptPath, booksFilePath)
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()

      // Current file untouched — byte-for-byte.
      expect(readFileSync(booksFilePath, 'utf8')).toBe(originalContent)
      // No safety copy was created (validation failed before anything ran).
      const files = readdirSync(backupsDir)
      expect(files.some((f) => f.startsWith('pre-restore-'))).toBe(false)
    })

    it('rejects a missing backup file', () => {
      writeSampleStore('Zano Consulting', 'Acme Corp')
      const result = restoreBackup(join(backupsDir, 'books-backup-nope.json'), booksFilePath)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Backup file not found')
    })

    it('creates a pre-restore safety copy of the current data', () => {
      writeSampleStore('Zano Consulting', 'Acme Corp')
      const backup = exportBackup(booksFilePath)
      expect(backup.ok).toBe(true)

      writeSampleStore('Mutated Company', 'Mutated Party')
      const result = restoreBackup(backup.path!, booksFilePath)
      expect(result.ok).toBe(true)

      const files = readdirSync(backupsDir)
      const safetyFile = files.find((f) => f.startsWith('pre-restore-'))
      expect(safetyFile).toBeDefined()
      expect(safetyFile).toMatch(/^pre-restore-\d{8}-\d{6}\.json$/)

      const safety = migrateAndValidateBooks(
        JSON.parse(readFileSync(join(backupsDir, safetyFile!), 'utf8')),
      )
      expect(safety.settings.companyName).toBe('Mutated Company')
      expect(safety.parties[0].name).toBe('Mutated Party')
    })

    it('restores even when the live store does not exist (fresh install)', () => {
      writeSampleStore('Zano Consulting', 'Acme Corp')
      const backup = exportBackup(booksFilePath)
      expect(backup.ok).toBe(true)

      rmSync(booksFilePath, { force: true })
      const result = restoreBackup(backup.path!, booksFilePath)
      expect(result.ok).toBe(true)
      expect(readBooksStore(booksFilePath).settings.companyName).toBe('Zano Consulting')
    })
  })

  describe('pruneBackups', () => {
    it('deletes the oldest backups beyond keep and returns the count removed', () => {
      for (let i = 1; i <= 12; i++) {
        writeBackupFile(
          `books-backup-20260907-1000${String(i).padStart(2, '0')}.json`,
          `{"seq":${i}}`,
          i,
        )
      }

      const removed = pruneBackups(backupsDir, 10)
      expect(removed).toBe(2)

      const remaining = listBackups(backupsDir)
      expect(remaining).toHaveLength(10)
      // The two oldest (seq 1, 2) are gone; the newest ten remain.
      expect(remaining.map((b) => b.name)).not.toContain('books-backup-20260907-100001.json')
      expect(remaining.map((b) => b.name)).not.toContain('books-backup-20260907-100002.json')
      expect(remaining.map((b) => b.name)).toContain('books-backup-20260907-100012.json')
    })

    it('defaults to keeping 10 backups', () => {
      for (let i = 1; i <= 13; i++) {
        writeBackupFile(
          `books-backup-20260907-2000${String(i).padStart(2, '0')}.json`,
          `{"seq":${i}}`,
          i,
        )
      }
      expect(pruneBackups(backupsDir)).toBe(3)
      expect(listBackups(backupsDir)).toHaveLength(10)
    })

    it('returns 0 for a missing backups directory', () => {
      expect(pruneBackups(join(testDir, 'does-not-exist'))).toBe(0)
    })
  })

  describe('restoreBackup shape validation (review fix)', () => {
    it('rejects valid-JSON files that are not books ledgers, leaving the store untouched', () => {
      writeFileSync(booksFilePath, JSON.stringify({ version: 1, accounts: [], invoices: [] }, null, 2), 'utf8')
      const original = readFileSync(booksFilePath, 'utf8')

      const backupsDir = join(testDir, 'backups')
      mkdirSync(backupsDir, { recursive: true })
      for (const [name, payload] of [
        ['books-backup-string.json', '"hello"'],
        ['books-backup-null.json', 'null'],
        ['books-backup-arr.json', '[]'],
        ['books-backup-obj.json', '{}'],
        ['books-backup-missing.json', JSON.stringify({ version: 1, journalEntries: [] })],
      ]) {
        const p = join(backupsDir, name)
        writeFileSync(p, payload, 'utf8')
        const result = restoreBackup(p, booksFilePath)
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/not a books ledger|Invalid|valid/i)
        // The live store is byte-identical after the rejected restore.
        expect(readFileSync(booksFilePath, 'utf8')).toBe(original)
      }
    })

    it('still allows restoring a genuine empty ledger (shape-valid)', () => {
      writeFileSync(booksFilePath, JSON.stringify({ version: 1, accounts: [], invoices: [] }, null, 2), 'utf8')
      const backupsDir = join(testDir, 'backups')
      mkdirSync(backupsDir, { recursive: true })
      const backupPath = join(backupsDir, 'books-backup-empty.json')
      writeFileSync(backupPath, JSON.stringify({ version: 1, accounts: [], invoices: [], journalEntries: [], parties: [], settings: {} }, null, 2), 'utf8')
      const result = restoreBackup(backupPath, booksFilePath)
      expect(result.ok).toBe(true)
      const restored = JSON.parse(readFileSync(booksFilePath, 'utf8'))
      expect(Array.isArray(restored.accounts)).toBe(true)
      expect(Array.isArray(restored.invoices)).toBe(true)
    })
  })
})
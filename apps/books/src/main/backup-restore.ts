/**
 * apps/books/src/main/backup-restore.ts
 *
 * Pure backup & restore engine for the books store (no electron imports — only
 * node builtins and books-core), so it can be exercised by plain Node tooling
 * and vitest exactly like books-core. All file copies are atomic (write tmp +
 * rename) and restores are guarded: a backup is validated through
 * migrateAndValidateBooks BEFORE anything is touched, and the current store is
 * safety-copied to `<backups>/pre-restore-<timestamp>.json` before it is
 * replaced. A corrupt backup is never restored.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { migrateAndValidateBooks } from './books-core'
import { MAX_AUDIT_ENTRIES, createAuditEntry } from '../shared/audit'
import type { AuditEntry, BooksDataEnvelope } from '../shared/types'
import type { BackupFileInfo, BackupResult } from '../shared/ipc'

/** Files listBackups considers backups (restore safety copies are excluded). */
const BACKUP_FILE_PATTERN = /^books-backup-.*\.json$/
const PRE_RESTORE_PATTERN = /^pre-restore-.*\.json$/

/** Reject backup files larger than this (protects the main process from OOM). */
export const MAX_BACKUP_SIZE_BYTES = 100 * 1024 * 1024

/**
 * A valid books ledger must be a plain object carrying the core arrays.
 * migrateAndValidateBooks is a never-throwing normalizer, so it alone cannot
 * gate a restore: a valid-JSON file that is not books data (e.g. `"hello"`,
 * `[]`, `{}`) would otherwise restore as an empty ledger.
 */
export function isBooksLedgerShape(raw: unknown): boolean {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      Array.isArray((raw as { accounts?: unknown }).accounts) &&
      Array.isArray((raw as { invoices?: unknown }).invoices),
  )
}

/** Local timestamp in the backup filename format: YYYYMMDD-HHmmss. */
function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/** Directory holding backup files for a books-data.json path. */
export function backupsDirFor(booksDataPath: string, backupsDir?: string): string {
  return backupsDir || join(booksDataPath.replace(/[/\\][^/\\]+$/, ''), 'backups')
}

/** Reads a file within a hard size cap; returns null when too large. */
function readFileCapped(path: string): string | null {
  try {
    const size = statSync(path).size
    if (size > MAX_BACKUP_SIZE_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Copies the current books-data.json (if it exists) into the backups directory
 * as books-backup-YYYYMMDD-HHmmss.json. The backups directory is created on
 * demand and the copy is atomic (write tmp + rename).
 */
export function exportBackup(booksDataPath: string, backupsDir?: string): BackupResult {
  try {
    if (!booksDataPath || !existsSync(booksDataPath)) {
      return { ok: false, error: 'Books data file does not exist' }
    }

    const content = readFileCapped(booksDataPath)
    if (content === null) {
      return { ok: false, error: `Books data file exceeds the ${MAX_BACKUP_SIZE_BYTES} byte backup cap` }
    }

    const dir = backupsDirFor(booksDataPath, backupsDir)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    let targetPath = join(dir, `books-backup-${timestamp()}.json`)
    if (existsSync(targetPath)) {
      targetPath = join(dir, `books-backup-${timestamp()}-${Date.now()}.json`)
    }

    const tmp = `${targetPath}.${Date.now()}.tmp`
    try {
      writeFileSync(tmp, content, 'utf8')
      renameSync(tmp, targetPath)
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {}
      throw err
    }

    return { ok: true, path: targetPath }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to create backup' }
  }
}

/**
 * Lists backup files (books-backup-*.json) in the backups directory, newest
 * first. Non-backup files (including pre-restore safety copies) are ignored.
 */
export function listBackups(backupsDir: string): BackupFileInfo[] {
  try {
    if (!backupsDir || !existsSync(backupsDir)) return []
    const entries = readdirSync(backupsDir, { withFileTypes: true })
    const backups: BackupFileInfo[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !BACKUP_FILE_PATTERN.test(entry.name)) continue
      const filePath = join(backupsDir, entry.name)
      let stat
      try {
        stat = statSync(filePath)
      } catch {
        continue
      }
      backups.push({
        name: entry.name,
        path: filePath,
        size: stat.size,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
      })
    }
    return backups.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  } catch {
    return []
  }
}

/**
 * Restores a backup over the live books store. The backup is validated through
 * migrateAndValidateBooks BEFORE anything is touched; a corrupt or truncated
 * backup is rejected with the current store left untouched. When the current
 * store exists, it is safety-copied to `<backups>/pre-restore-<timestamp>.json`
 * before the backup is copied over it (atomic).
 */
export function restoreBackup(
  backupPath: string,
  booksDataPath: string,
): { ok: boolean; restoredData?: BooksDataEnvelope; error?: string } {
  try {
    if (!backupPath || !existsSync(backupPath)) {
      return { ok: false, error: 'Backup file not found' }
    }
    // A symlink in the backups dir must not be restored through the IPC.
    try {
      if (!lstatSync(backupPath).isFile()) {
        return { ok: false, error: 'Backup path is not a regular file' }
      }
    } catch (err: any) {
      return { ok: false, error: `Cannot stat backup file: ${err?.message || 'stat failed'}` }
    }

    // Validate BEFORE touching anything: size cap, parse, ledger SHAPE, then
    // migrate. migrateAndValidateBooks alone cannot gate a restore — it is a
    // never-throwing normalizer that would accept any valid-JSON non-books
    // file as an empty ledger.
    const content = readFileCapped(backupPath)
    if (content === null) {
      return {
        ok: false,
        error: `Backup file exceeds the ${MAX_BACKUP_SIZE_BYTES} byte restore cap`,
      }
    }
    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch (err: any) {
      return { ok: false, error: `Backup file is not valid JSON: ${err?.message || 'parse error'}` }
    }
    if (!isBooksLedgerShape(raw)) {
      return { ok: false, error: 'Backup file is not a books ledger (missing accounts/invoices)' }
    }
    let validated: BooksDataEnvelope
    try {
      validated = migrateAndValidateBooks(raw)
    } catch (err: any) {
      return { ok: false, error: `Backup failed validation: ${err?.message || 'invalid backup'}` }
    }

    // Preserve the ACTIVE audit trail across restore. Backups describe a
    // historical ledger state, but they must never erase evidence recorded
    // after the backup was taken. Merge by immutable entry id, newest-first,
    // then append the restore event before the single atomic replacement.
    let liveAudit: AuditEntry[] = []
    if (existsSync(booksDataPath)) {
      try {
        liveAudit = migrateAndValidateBooks(JSON.parse(readFileSync(booksDataPath, 'utf8'))).auditLog || []
      } catch {
        // A malformed current store is still safety-copied below; the restore
        // may recover it, but no untrusted audit payload is merged.
      }
    }
    const auditById = new Map<string, AuditEntry>()
    for (const entry of [...(validated.auditLog || []), ...liveAudit]) {
      if (!auditById.has(entry.id)) auditById.set(entry.id, entry)
    }
    const restoreEntry = createAuditEntry('backup.restore', `Restored backup ${join(backupPath).split(/[/\\]/).pop() || 'backup'}`)
    auditById.set(restoreEntry.id, restoreEntry)
    validated = {
      ...validated,
      auditLog: Array.from(auditById.values())
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, MAX_AUDIT_ENTRIES),
    }

    // Safety-copy the current store before replacing it (if one exists) —
    // atomically, with a collision-proof name.
    if (existsSync(booksDataPath)) {
      const backupsDir = backupsDirFor(booksDataPath)
      if (!existsSync(backupsDir)) {
        mkdirSync(backupsDir, { recursive: true })
      }
      let safetyPath = join(backupsDir, `pre-restore-${timestamp()}.json`)
      if (existsSync(safetyPath)) {
        safetyPath = join(backupsDir, `pre-restore-${timestamp()}-${Date.now()}.json`)
      }
      const safetyTmp = `${safetyPath}.${Date.now()}.tmp`
      try {
        writeFileSync(safetyTmp, readFileSync(booksDataPath, 'utf8'), 'utf8')
        renameSync(safetyTmp, safetyPath)
      } catch (err) {
        try {
          if (existsSync(safetyTmp)) unlinkSync(safetyTmp)
        } catch {}
        throw err
      }
    }

    // Atomic replace books-data.json with the MIGRATED payload (never the raw
    // bytes), so the file on disk always matches what the renderer sees.
    const dir = booksDataPath.replace(/[/\\][^/\\]+$/, '')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const tmp = `${booksDataPath}.${Date.now()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf8')
      renameSync(tmp, booksDataPath)
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {}
      throw err
    }

    return { ok: true, restoredData: validated }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to restore backup' }
  }
}

/**
 * Deletes the oldest backups AND pre-restore safety copies beyond `keep`
 * (newest kept). Returns the number of files removed.
 */
export function pruneBackups(backupsDir: string, keep = 10): number {
  try {
    if (!backupsDir || !existsSync(backupsDir)) return 0
    const keepCount = Math.max(0, keep)
    const backups = listBackups(backupsDir)
    let removed = 0
    for (const backup of backups.slice(keepCount)) {
      try {
        unlinkSync(backup.path)
        removed++
      } catch {
        // A file that vanished between listing and unlinking is fine.
      }
    }
    // Pre-restore safety copies are capped the same way.
    let preRestore: { path: string; modifiedAt: string }[] = []
    try {
      preRestore = readdirSync(backupsDir, { withFileTypes: true })
        .filter((e) => e.isFile() && PRE_RESTORE_PATTERN.test(e.name))
        .map((e) => {
          const filePath = join(backupsDir, e.name)
          try {
            return { path: filePath, modifiedAt: new Date(statSync(filePath).mtimeMs).toISOString() }
          } catch {
            return null
          }
        })
        .filter((x): x is { path: string; modifiedAt: string } => x !== null)
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    } catch {}
    for (const copy of preRestore.slice(keepCount)) {
      try {
        unlinkSync(copy.path)
        removed++
      } catch {}
    }
    return removed
  } catch {
    return 0
  }
}

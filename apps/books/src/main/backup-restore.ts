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
import {
  isBooksLedgerShape,
  ledgerRecordCount,
  mayReplaceLedger,
  migrateAndValidateBooks,
} from './books-core'
import { MAX_AUDIT_ENTRIES, createAuditEntry } from '../shared/audit'
import { BACKUP_NAME_PATTERN, SAFETY_COPY_NAME_PATTERN } from '../shared/ipc'
import type { AuditEntry, BooksDataEnvelope } from '../shared/types'
import type { BackupFileInfo, BackupResult } from '../shared/ipc'

/** Reject backup files larger than this (protects the main process from OOM). */
export const MAX_BACKUP_SIZE_BYTES = 100 * 1024 * 1024

/**
 * A valid books ledger must be a plain object carrying the core arrays.
 * `migrateAndValidateBooks` is a never-throwing normalizer, so it alone cannot
 * gate a restore: a valid-JSON file that is not books data (e.g. `"hello"`,
 * `[]`, `{}`) would otherwise restore as an empty ledger. Resolving that
 * distinction now lives in books-core, because the store read must make exactly
 * the same one.
 */
export { isBooksLedgerShape }

/** Local timestamp in the backup filename format: YYYYMMDD-HHmmss. */
function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/**
 * Names this process has already handed out.
 *
 * A backup name only has to be unique among the files that exist — but pruning
 * deletes the oldest, which frees the bare `books-backup-<stamp>.json` name for
 * reuse, and a caller still holding that path would then be reading a different
 * backup's bytes. Issued names are therefore remembered for the life of the
 * process, so a name freed by pruning is never issued twice. (Two processes
 * sharing one backups directory can still collide; the exclusive create below
 * is what keeps that from destroying either file.)
 */
const issuedBackupNames = new Set<string>()

/** The first claim keeps the historical bare name; later ones can never repeat. */
function backupClaimSuffix(attempt: number): string {
  return attempt === 0 ? '' : `-${Date.now()}-${attempt}`
}

/**
 * Writes a backup, claiming its name atomically.
 *
 * A check-then-write is not enough: two `books:backup-now` calls inside the
 * same millisecond both see the same free name and the second rename silently
 * destroys the first backup. The exclusive create (`flag: 'wx'`) is the claim —
 * whichever caller loses the race gets a new candidate instead of someone
 * else's file.
 */
function writeBackupClaiming(
  dir: string,
  pathFor: (suffix: string) => string,
  content: string,
): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = pathFor(backupClaimSuffix(attempt))
    if (issuedBackupNames.has(candidate)) continue
    try {
      writeFileSync(candidate, content, { encoding: 'utf8', flag: 'wx' })
      issuedBackupNames.add(candidate)
      return candidate
    } catch (err: any) {
      // EEXIST is the expected race outcome; anything else is a real failure.
      if (err?.code !== 'EEXIST') throw err
    }
  }
  throw new Error(`Could not claim a unique backup name in ${dir}`)
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

/** Atomic write (temporary file + rename) so a reader never sees a partial file. */
function writeFileAtomicBytes(targetPath: string, content: string): void {
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
      return {
        ok: false,
        error: `Books data file exceeds the ${MAX_BACKUP_SIZE_BYTES} byte backup cap`,
      }
    }

    const dir = backupsDirFor(booksDataPath, backupsDir)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const targetPath = writeBackupClaiming(
      dir,
      (suffix) => join(dir, `books-backup-${timestamp()}${suffix}.json`),
      content,
    )

    return { ok: true, path: targetPath }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to create backup' }
  }
}

/**
 * Lists the restore points in `backupsDir` whose names match `pattern`,
 * newest first. Files that do not (a loose `notes.txt`, a corrupt-store
 * forensic copy) are ignored.
 */
function listRestorePoints(
  backupsDir: string,
  pattern: RegExp,
  kind: 'backup' | 'safety-copy',
): BackupFileInfo[] {
  try {
    if (!backupsDir || !existsSync(backupsDir)) return []
    const entries = readdirSync(backupsDir, { withFileTypes: true })
    const points: BackupFileInfo[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue
      const filePath = join(backupsDir, entry.name)
      let stat
      try {
        stat = statSync(filePath)
      } catch {
        continue
      }
      points.push({
        name: entry.name,
        path: filePath,
        size: stat.size,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        kind,
      })
    }
    return points.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  } catch {
    return []
  }
}

/**
 * Lists backup files (books-backup-*.json) in the backups directory, newest
 * first. The pre-restore safety copies are listed separately by
 * `listSafetyCopies`, so each kind is pruned on its own terms.
 */
export function listBackups(backupsDir: string): BackupFileInfo[] {
  return listRestorePoints(backupsDir, BACKUP_NAME_PATTERN, 'backup')
}

/**
 * Lists the pre-restore safety copies (pre-restore-*.json) this app wrote
 * before replacing the live ledger, newest first. They are restore points in
 * their own right: a safety copy is how a restore is undone.
 */
export function listSafetyCopies(backupsDir: string): BackupFileInfo[] {
  return listRestorePoints(backupsDir, SAFETY_COPY_NAME_PATTERN, 'safety-copy')
}

/**
 * Restores a backup over the live books store. The backup is validated through
 * migrateAndValidateBooks BEFORE anything is touched, and it must pass the same
 * empty-replacement guard every other writer passes. Because the user picked
 * and confirmed this file, the restore is allowed to be one that leaves the
 * books empty — a deliberately empty backup restored over a populated ledger is
 * how a user starts over. When the current store exists, it is safety-copied to
 * `<backups>/pre-restore-<timestamp>.json` before the backup is copied over it
 * (atomic), and that copy is itself listed and restorable. A corrupt backup is
 * never restored.
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
    // The same read tells the shrink guard what the restore is about to
    // replace; a store that cannot be read yields null, and restoring over it
    // is the recovery path the guard must not block.
    let liveStored: BooksDataEnvelope | null = null
    if (existsSync(booksDataPath)) {
      try {
        liveStored = migrateAndValidateBooks(JSON.parse(readFileSync(booksDataPath, 'utf8')))
      } catch {
        // A malformed current store is still safety-copied below; the restore
        // may recover it, but no untrusted audit payload is merged.
      }
    }
    const liveAudit: AuditEntry[] = liveStored?.auditLog || []
    const auditById = new Map<string, AuditEntry>()
    for (const entry of [...(validated.auditLog || []), ...liveAudit]) {
      if (!auditById.has(entry.id)) auditById.set(entry.id, entry)
    }
    const restoreEntry = createAuditEntry(
      'backup.restore',
      `Restored backup ${join(backupPath).split(/[/\\]/).pop() || 'backup'}`,
    )
    auditById.set(restoreEntry.id, restoreEntry)
    validated = {
      ...validated,
      auditLog: Array.from(auditById.values())
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, MAX_AUDIT_ENTRIES),
    }

    // A restore is a real write to the live ledger, so it passes the same
    // empty-replacement guard every other writer passes — and it names its
    // reason: the file being restored is the one the user chose and confirmed,
    // so 'user-restored-empty-backup' is a decision, not an accident. The guard
    // still refuses what a restore cannot do at all (a corrupt, oversized or
    // non-ledger file, refused above), and a live store that cannot be read is
    // never treated as populated.
    const allowed = mayReplaceLedger(liveStored, ledgerRecordCount(validated), {
      emptyLedgerReason: 'user-restored-empty-backup',
    })
    if (!allowed.ok) return { ok: false, error: allowed.error }

    // Safety-copy the current store before replacing it (if one exists) —
    // atomically, with a name no concurrent restore can claim as well.
    if (existsSync(booksDataPath)) {
      const backupsDir = backupsDirFor(booksDataPath)
      if (!existsSync(backupsDir)) {
        mkdirSync(backupsDir, { recursive: true })
      }
      writeBackupClaiming(
        backupsDir,
        (suffix) => join(backupsDir, `pre-restore-${timestamp()}${suffix}.json`),
        readFileSync(booksDataPath, 'utf8'),
      )
    }

    // Atomic replace books-data.json with the MIGRATED payload (never the raw
    // bytes), so the file on disk always matches what the renderer sees. The
    // restored ledger keeps the backed-up revision: a restore is a deliberate
    // return to that state, not a new edit of the live sequence.
    const dir = booksDataPath.replace(/[/\\][^/\\]+$/, '')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileAtomicBytes(booksDataPath, JSON.stringify(validated, null, 2))

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
        .filter((e) => e.isFile() && SAFETY_COPY_NAME_PATTERN.test(e.name))
        .map((e) => {
          const filePath = join(backupsDir, e.name)
          try {
            return {
              path: filePath,
              modifiedAt: new Date(statSync(filePath).mtimeMs).toISOString(),
            }
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

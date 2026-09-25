// Managed-document lifecycle (Phase 5 WP-9).
//
// Tenders-managed documents (RFP packs and vault attachments) get durable
// metadata — id, relative path, size, MIME, SHA-256, timestamps and a
// missing-state — plus a soft-delete lifecycle: a user delete moves the file to
// a Tenders trash directory (never a hard unlink), and can be undone across a
// restart. Startup reconciliation reports files that went missing or appeared
// without metadata; nothing is ever silently deleted or substituted.
//
// Metadata lives in `<baseDir>/managed-documents.json` (its own bounded, atomic
// index), so the strict v2 authority document schema is untouched.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { TendersDataV2 } from '../shared/types'
import { MAX_TENDERS_DOCUMENT_UPLOAD_BYTES } from '../shared/ipc'
import {
  MAX_TENDERS_MANAGED_FILE_NAME_CHARS,
  MAX_TENDERS_MANAGED_FILES,
  MAX_TENDERS_MANAGED_INDEX_BYTES,
  MAX_TENDERS_TRASH_ENTRIES,
  type DocumentReconciliation,
  type ManagedFileCategory,
  type ManagedFileLink,
  type ManagedFileRecord,
  type ManagedFileTrashEntry,
} from '../shared/tenders-persistence'
import { renameWithBoundedRetryAsync } from './tenders-paths'

export const MANAGED_DOCUMENTS_INDEX_FILE = 'managed-documents.json' as const
export const MANAGED_DOCUMENTS_TRASH_DIR = '.trash' as const

/**
 * Quarantined copies of an unparseable metadata index kept beside it.
 *
 * A corrupt index is renamed to `managed-documents.json.corrupt-<timestamp>.json`
 * so nothing is discarded, and that rename is the ONE path that can add a file to
 * the base directory without any other bound applying to it. Without a bound, a
 * file that keeps corrupting (a bad sector, a sync client racing the store, a
 * reader that leaves partial bytes) accumulates one copy per read, forever — the
 * app grows the user's disk every time it opens a document view.
 *
 * Five, matching `MAX_TENDERS_BACKUPS` — the rotating last-known-good copies in
 * this same Tenders directory. Both exist for the same reason: a bounded recent
 * window of recovery material, oldest discarded first. The newest copies are the
 * ones that describe the failure that just happened, which are the ones worth
 * keeping.
 */
export const MAX_TENDERS_INDEX_QUARANTINE_FILES = 5

const MANAGED_SUBDIRS = new Set<string>(['documents', 'vault'])

/** Longest trailing extension worth preserving when a name is clamped. */
const MANAGED_EXTENSION_MAX_CHARS = 20

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip',
}

export function managedMimeType(fileName: string): string {
  const extension = fileName.toLowerCase().replace(/^.*\./, '')
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

/** Confine a stored path to exactly `documents/<name>` or `vault/<name>`. */
export function toManagedRelativePath(storedPath: unknown): string | null {
  if (typeof storedPath !== 'string' || storedPath.length === 0 || storedPath.includes('\0')) {
    return null
  }
  const normalized = storedPath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.length !== 2) return null
  const [directory, name] = segments
  if (!MANAGED_SUBDIRS.has(directory)) return null
  if (!name || name === '.' || name === '..' || name.includes('..')) return null
  return `${directory}/${name}`
}

/** Confine a trashed path to exactly `.trash/<name>` (mirrors the save layout). */
function toManagedTrashRelativePath(storedPath: unknown): string | null {
  if (typeof storedPath !== 'string' || storedPath.length === 0 || storedPath.includes('\0')) {
    return null
  }
  const normalized = storedPath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.length !== 2) return null
  const [directory, name] = segments
  if (directory !== MANAGED_DOCUMENTS_TRASH_DIR) return null
  if (!name || name === '.' || name === '..' || name.includes('..')) return null
  return `${directory}/${name}`
}

/**
 * Real (symlink-resolved) root of a managed subdirectory. `mkdir` first, then
 * `realpath`, so the root is a name the filesystem itself resolves rather than
 * one this module composed. Returns `null` when the directory cannot be created
 * or resolved, which callers treat as a refusal: a root that cannot be proven is
 * not a root to write into.
 */
function realManagedRootSync(baseDir: string, directory: string): string | null {
  const root = join(baseDir, directory)
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    return realpathSync(root)
  } catch {
    return null
  }
}

async function realManagedRoot(baseDir: string, directory: string): Promise<string | null> {
  const root = join(baseDir, directory)
  try {
    await mkdir(root, { recursive: true })
    return await realpath(root)
  } catch {
    return null
  }
}

/**
 * Is the managed root a directory the app may write into? `realpath` alone is
 * not enough: it happily follows a symlink planted at `documents/` and reports
 * the directory it points at, which is a real path outside the Tenders data
 * directory that would then satisfy every prefix check downstream.
 *
 * So the check runs against the LEXICAL root — `<base>/documents`, `<base>/vault`,
 * `<base>/.trash` — which is where a planted link would sit, and against the base
 * directory above it. Both must exist and neither may be a link.
 */
export function assertRealManagedRoot(
  baseDir: string,
  directory: string,
): { ok: true } | { ok: false } {
  return diagnoseManagedRoot(baseDir, directory).ok ? { ok: true } : { ok: false }
}

/**
 * Why the managed root cannot be written through, as the sentence the user is
 * shown, or `null` when it can.
 *
 * `assertRealManagedRoot` answers yes/no, and both "a link is planted here" and
 * "the path is not there at all" were reported to the user as "could not be
 * resolved for writing" — a message that describes neither where the problem is
 * nor what to do about it. A planted entry is also the one condition in this
 * store that, left unexplained, reads as the feature being broken forever, so the
 * sentence names the entry and the way out.
 *
 * The refusal itself is unchanged and must stay: a link at `documents/` may not
 * be written through, because `realpath` follows it and every prefix check
 * afterwards would then agree with the escape.
 */
export function diagnoseManagedRoot(
  baseDir: string,
  directory: string,
): { ok: boolean; reason?: string } {
  const candidates: Array<{ path: string; label: string }> = [
    { path: baseDir, label: 'the Tenders data directory' },
    { path: join(baseDir, directory), label: `${directory}/` },
  ]
  for (const candidate of candidates) {
    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(candidate.path)
    } catch {
      return {
        ok: false,
        reason: `${candidate.label} is not readable at ${candidate.path}, so managed documents cannot be written. Reopen Tenders, or check that the folder still exists.`,
      }
    }
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        reason: `${candidate.label} at ${candidate.path} is a link, not a folder inside the Tenders data directory, so documents are not written through it. Rename or remove that ${stats.isDirectory() ? 'link' : 'entry'} and save again — the rest of the app keeps working.`,
      }
    }
  }
  return { ok: true }
}

/**
 * `true` when `candidate` is strictly inside `root` once both are compared as
 * real (symlink-resolved) paths, with neither `..` nor a drive prefix left in
 * lexical form.
 *
 * Windows compares case-insensitively: `realpath` preserves the caller's case on
 * the drive letter, so `c:\Users\x\Documents` and `C:\Users\x\Documents` are the
 * same directory but not the same string. The same folder read through a
 * `OneDrive` path and through its real location compares equal too, because both
 * sides went through `realpath` first.
 */
export function isRealPathInside(root: string | null, candidate: string | null): boolean {
  if (!root || !candidate) return false
  const normalizedRoot = root.endsWith(sep) ? root : root + sep
  const left = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
  const right = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  if (right === (left.endsWith(sep) ? left.slice(0, -1) : left)) return false
  return right.startsWith(left)
}

/**
 * The real, confinement-checked path of one managed leaf (a document under
 * `documents/` or `vault/`, or a trashed file under `.trash/`).
 *
 * Lexical confinement alone is not containment. A symlink or NTFS junction
 * planted at one managed leaf — or replacing `documents/` itself — passes every
 * text check and still resolves outside the Tenders directory. This product
 * ingests untrusted third-party PDFs, so the check that matters is the one the
 * filesystem makes: resolve the real path and re-assert the prefix.
 *
 * Rejection is the default. A leaf that resolves outside its root, or whose leaf
 * component is a symlink (a link is never a document this app wrote: it writes
 * with `flag: 'wx'` into a name it composed), is refused with `'escaped'`;
 * `'missing'` means the leaf simply is not there yet.
 */
export function resolveConfinedManagedPath(
  baseDir: string,
  relativePath: string,
  kind: 'file' | 'trash' = 'file',
):
  | { ok: true; path: string; root: string }
  | { ok: false; reason: 'invalid' | 'escaped' | 'missing' } {
  const confined =
    kind === 'trash'
      ? toManagedTrashRelativePath(relativePath)
      : toManagedRelativePath(relativePath)
  if (!confined) return { ok: false, reason: 'invalid' }
  const directory = confined.split('/')[0]
  const root = realManagedRootSync(baseDir, directory)
  if (!root) return { ok: false, reason: 'escaped' }
  const fullPath = resolve(root, confined.slice(directory.length + 1))
  if (!isRealPathInside(root, fullPath)) return { ok: false, reason: 'escaped' }
  if (!existsSync(fullPath)) return { ok: false, reason: 'missing' }
  try {
    if (lstatSync(fullPath).isSymbolicLink()) return { ok: false, reason: 'escaped' }
  } catch {
    return { ok: false, reason: 'missing' }
  }
  return { ok: true, path: fullPath, root }
}

/**
 * Clean one caller-supplied file name and clamp its length. The clamp is what
 * keeps the derived record budget true (see
 * `MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD`) and keeps the derived paths
 * inside the filesystem's 255-character component limit, so a long name can
 * neither break the record arithmetic nor make a later soft-delete fail.
 */
export function sanitizeManagedFileName(fileName: unknown, category: ManagedFileCategory): string {
  const raw = typeof fileName === 'string' && fileName.length > 0 ? basename(fileName) : ''
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_')
  if (!cleaned || cleaned.replace(/[._-]/g, '').length === 0) {
    return category === 'rfp' ? 'tender.pdf' : 'document.pdf'
  }
  return clampManagedFileName(cleaned)
}

/** Truncate to the documented limit, keeping a plausible extension. */
function clampManagedFileName(cleaned: string): string {
  if (cleaned.length <= MAX_TENDERS_MANAGED_FILE_NAME_CHARS) return cleaned
  const dot = cleaned.lastIndexOf('.')
  // A trailing "extension" longer than any real one is part of the name, not an
  // extension to preserve.
  const extension =
    dot > 0 && cleaned.length - dot <= MANAGED_EXTENSION_MAX_CHARS ? cleaned.slice(dot) : ''
  const keep = MAX_TENDERS_MANAGED_FILE_NAME_CHARS - extension.length
  return `${cleaned.slice(0, keep)}${extension}`
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

interface ManagedIndexFile {
  version: 1
  updatedAt: string
  records: ManagedFileRecord[]
}

export interface ManagedDocumentStoreHooks {
  /** Test seam: called before each metadata index write; may throw. */
  beforeIndexWrite?: () => void | Promise<void>
}

export interface ManagedDocumentStoreOptions {
  baseDir: string
  now?: () => Date
  hooks?: ManagedDocumentStoreHooks
}

export interface ManagedSaveInput {
  fileName: string
  buffer: Buffer
  category: ManagedFileCategory
  mimeType?: string
}

export type ManagedSaveResult =
  { ok: true; record: ManagedFileRecord } | { ok: false; error: string }

export type ManagedTrashResult =
  { ok: true; entry?: ManagedFileTrashEntry } | { ok: false; error: string }

export type ManagedRestoreResult =
  { ok: true; record: ManagedFileRecord; restoredPath: string } | { ok: false; error: string }

export type ManagedReplaceResult =
  | { ok: true; record: ManagedFileRecord; previousTrashed: boolean; warning?: string }
  | { ok: false; error: string }

export interface ManagedDocumentStore {
  save(input: ManagedSaveInput): Promise<ManagedSaveResult>
  replace(input: {
    storedPath: string
    fileName: string
    buffer: Buffer
    mimeType?: string
  }): Promise<ManagedReplaceResult>
  trash(storedPath: string, options?: { replacedBy?: string }): Promise<ManagedTrashResult>
  restore(idOrPath: string): Promise<ManagedRestoreResult>
  listTrash(): Promise<ManagedFileTrashEntry[]>
  listRecords(): Promise<ManagedFileRecord[]>
  reconcile(): Promise<DocumentReconciliation>
  cleanupTrash(options?: { all?: boolean; olderThanMs?: number }): Promise<{
    ok: true
    removed: number
  }>
}

function isManagedRecord(raw: unknown): raw is ManagedFileRecord {
  if (!raw || typeof raw !== 'object') return false
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return false
  if (record.category !== 'rfp' && record.category !== 'vault') return false
  // Re-confine paths read back from disk: restore/cleanupTrash `rename`/`unlink`
  // under `join(baseDir, ...)`, so a tampered index must not point outside the
  // managed subtrees. Invalid records are dropped rather than acted on.
  if (
    typeof record.relativePath !== 'string' ||
    toManagedRelativePath(record.relativePath) === null
  )
    return false
  if (
    record.trashedPath !== undefined &&
    record.trashedPath !== null &&
    (typeof record.trashedPath !== 'string' ||
      toManagedTrashRelativePath(record.trashedPath) === null)
  ) {
    return false
  }
  if (typeof record.fileName !== 'string') return false
  if (typeof record.mimeType !== 'string') return false
  if (typeof record.size !== 'number' || !Number.isFinite(record.size) || record.size < 0)
    return false
  if (typeof record.hash !== 'string') return false
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return false
  if (record.state !== 'active' && record.state !== 'trashed' && record.state !== 'missing') {
    return false
  }
  return true
}

/**
 * Serialize one record for the on-disk index. Null-valued optional fields are
 * omitted: they carry no information and cost roughly a third of the index,
 * which is the binding limit long before the record-count caps are reached.
 * `normalizeRecord` restores them on read, so every caller still sees the
 * documented `ManagedFileRecord` shape.
 */
function toIndexRecord(record: ManagedFileRecord): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    id: record.id,
    category: record.category,
    relativePath: record.relativePath,
    fileName: record.fileName,
    mimeType: record.mimeType,
    size: record.size,
    hash: record.hash,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    state: record.state,
  }
  if (record.trashedAt) compact.trashedAt = record.trashedAt
  if (record.trashedPath) compact.trashedPath = record.trashedPath
  if (record.missingAt) compact.missingAt = record.missingAt
  if (record.replacedBy) compact.replacedBy = record.replacedBy
  return compact
}

/** Restore the documented shape for fields `toIndexRecord` may have omitted. */
function normalizeRecord(record: ManagedFileRecord): ManagedFileRecord {
  return {
    ...record,
    trashedAt: record.trashedAt ?? null,
    trashedPath: record.trashedPath ?? null,
    missingAt: record.missingAt ?? null,
    replacedBy: record.replacedBy ?? null,
  }
}

function toTrashEntry(record: ManagedFileRecord): ManagedFileTrashEntry {
  return {
    id: record.id,
    recordId: record.id,
    fileName: record.fileName,
    category: record.category,
    size: record.size,
    hash: record.hash,
    trashedAt: record.trashedAt ?? record.updatedAt,
    deletedFrom: record.relativePath,
    trashedPath: record.trashedPath ?? '',
  }
}

/**
 * Pure link lookup: which tenders/customers/vault documents reference a managed
 * relative path. Used by the delete path to warn before a soft-delete.
 */
export function findManagedFileLinks(
  relativePath: string,
  document: TendersDataV2,
): ManagedFileLink[] {
  const links: ManagedFileLink[] = []
  for (const workspace of document.workspaces) {
    const linkedVaultIds = new Set<string>()
    for (const vaultDoc of workspace.vault) {
      if (vaultDoc.fileUrl === relativePath) {
        links.push({ kind: 'vault', id: vaultDoc.id, label: vaultDoc.title })
        linkedVaultIds.add(vaultDoc.id)
      }
    }
    for (const tender of workspace.tenders) {
      if (tender.fileUrl === relativePath) {
        links.push({ kind: 'tender', id: tender.id, label: tender.title })
      }
    }
    if (linkedVaultIds.size > 0) {
      for (const customer of workspace.customers) {
        const references = customer.requiredDocs.some(
          (required) =>
            required.linkedVaultDocId !== null && linkedVaultIds.has(required.linkedVaultDocId),
        )
        if (references) links.push({ kind: 'customer', id: customer.id, label: customer.name })
      }
    }
  }
  return links
}

export function createManagedDocumentStore(
  options: ManagedDocumentStoreOptions,
): ManagedDocumentStore {
  const baseDir = options.baseDir
  const indexPath = join(baseDir, MANAGED_DOCUMENTS_INDEX_FILE)
  const trashDir = join(baseDir, MANAGED_DOCUMENTS_TRASH_DIR)
  const clock = (): Date => (options.now ? options.now() : new Date())
  const clockIso = (): string => clock().toISOString()

  let queue: Promise<unknown> = Promise.resolve()
  function withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function atomicWrite(path: string, data: Buffer | string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
      // Flush the bytes to the device before the rename publishes them at the
      // final path. Without this a power loss can leave a record that says
      // `active` pointing at a zero-length file. Best-effort: a filesystem that
      // refuses fsync must not turn an otherwise successful write into a failed
      // save (the bytes are already written; the rename is still atomic).
      try {
        const handle = await open(temporary, 'r+')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      } catch {
        // fsync unavailable — the write itself succeeded
      }
      await renameWithBoundedRetryAsync(temporary, path)
    } catch (error: unknown) {
      try {
        await unlink(temporary)
      } catch {
        // preserve the original failure
      }
      throw error
    }
  }

  async function readIndex(): Promise<ManagedIndexFile> {
    let raw: string
    try {
      raw = await readFile(indexPath, 'utf8')
    } catch (error: unknown) {
      if (isMissingError(error)) return { version: 1, updatedAt: clockIso(), records: [] }
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as { records?: unknown; updatedAt?: unknown }
      const records = Array.isArray(parsed.records)
        ? parsed.records.filter(isManagedRecord).map(normalizeRecord)
        : []
      return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : clockIso(),
        records,
      }
    } catch (error: unknown) {
      // Never discard a corrupt index silently: quarantine it so reconciliation
      // can report every previously-managed file as orphaned. The quarantine is
      // then PRUNED, because this rename is the one thing here that adds a file
      // outside every other bound: an index that keeps corrupting would otherwise
      // leave one copy per read, forever.
      const quarantine = `${indexPath}.corrupt-${Date.now()}.json`
      try {
        await rename(indexPath, quarantine)
        await pruneIndexQuarantine()
      } catch {
        // best effort
      }
      return { version: 1, updatedAt: clockIso(), records: [] }
    }
  }

  /**
   * Keep only the newest `MAX_TENDERS_INDEX_QUARANTINE_FILES` quarantined copies,
   * discarding the oldest.
   *
   * The timestamp is parsed out of the name rather than taken from `stat`: two
   * copies written in the same second would otherwise sort by a filesystem mtime
   * that cannot separate them, and the ORDER is the whole point — the newest
   * copies describe the failure that just happened. The name is this module's own
   * (`${indexPath}.corrupt-<Date.now()>.json`), so a non-matching entry is not a
   * copy this store made and is left alone rather than unlinked.
   */
  async function pruneIndexQuarantine(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(baseDir)
    } catch {
      return
    }
    const prefix = `${MANAGED_DOCUMENTS_INDEX_FILE}.corrupt-`
    const quarantines = names
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .map((name) => ({ name, stamp: Number.parseInt(name.slice(prefix.length, -5), 10) }))
      .filter((entry) => Number.isFinite(entry.stamp))
      .sort((left, right) => left.stamp - right.stamp)
    const excess = quarantines.slice(
      0,
      Math.max(0, quarantines.length - MAX_TENDERS_INDEX_QUARANTINE_FILES),
    )
    for (const entry of excess) {
      try {
        await unlink(join(baseDir, entry.name))
      } catch {
        // best effort: a copy that cannot be removed must not fail the read
      }
    }
  }

  async function writeIndex(index: ManagedIndexFile, previousRecordCount: number): Promise<void> {
    await options.hooks?.beforeIndexWrite?.()
    index.version = 1
    index.updatedAt = clockIso()
    const serialized = JSON.stringify({
      version: index.version,
      updatedAt: index.updatedAt,
      records: index.records.map(toIndexRecord),
    })
    const serializedBytes = Buffer.byteLength(serialized, 'utf8')
    // The byte cap bounds GROWTH of the metadata collection. Lifecycle
    // transitions that do not add a record (trash / restore / cleanup) stay
    // allowed, so a full index can never wedge the user out of deleting a
    // document — deleting and emptying the trash are exactly how the collection
    // shrinks again. Every record the store writes now fits
    // `MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD` (file names are clamped to
    // `MAX_TENDERS_MANAGED_FILE_NAME_CHARS`), so `MAX_TENDERS_MANAGED_FILES`
    // records always fit inside this ceiling and the record-count cap binds
    // first by construction; this check is therefore only reachable with an index
    // written by an older build or edited outside the app — the second reason it
    // must not block the lifecycle transitions above.
    if (
      serializedBytes > MAX_TENDERS_MANAGED_INDEX_BYTES &&
      index.records.length > previousRecordCount
    ) {
      throw new Error(
        `Managed-document metadata index is full (${serializedBytes} bytes > ${MAX_TENDERS_MANAGED_INDEX_BYTES} bytes); remove documents or empty the trash before adding more.`,
      )
    }
    await mkdir(baseDir, { recursive: true })
    await atomicWrite(indexPath, serialized)
  }

  /**
   * A name no file under `root` already uses. `root` is the already-resolved real
   * directory, so the probe is one `existsSync` — resolving it again per save
   * would double the syscalls on the hot write path for no extra proof.
   */
  function uniqueStoredName(root: string, cleanName: string): string {
    const base = `${clock().getTime()}_${cleanName}`
    if (!existsSync(join(root, base))) return base
    return `${clock().getTime()}_${randomUUID().slice(0, 8)}_${cleanName}`
  }

  async function uniqueTrashName(id: string, fileName: string): Promise<string> {
    const base = `${id}__${fileName}`
    if (!existsSync(join(trashDir, base))) return base
    return `${id}__${randomUUID().slice(0, 8)}__${fileName}`
  }

  const save = (input: ManagedSaveInput): Promise<ManagedSaveResult> =>
    withLock(async () => {
      const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer)
      if (buffer.byteLength > MAX_TENDERS_DOCUMENT_UPLOAD_BYTES) {
        return { ok: false, error: 'Document exceeds the upload limit.' }
      }
      const cleanName = sanitizeManagedFileName(input.fileName, input.category)
      const index = await readIndex()
      const recordsBefore = index.records.length
      // The record cap is derived to stay reachable inside the index byte
      // ceiling, so a full store refuses here — with a limit the user can count —
      // rather than from the byte check in `writeIndex`.
      if (index.records.length >= MAX_TENDERS_MANAGED_FILES) {
        return { ok: false, error: 'Managed-document metadata limit reached.' }
      }
      const directory = input.category === 'rfp' ? 'documents' : 'vault'
      // `mkdir` first so a first-ever save still creates the directory, then take
      // the REAL root: a symlink or junction planted at `documents/` passes every
      // lexical check and still resolves outside the Tenders directory, so the
      // prefix has to be re-asserted against the path the filesystem resolves.
      // A root that cannot be proven is a refusal, not a write.
      const root = await realManagedRoot(baseDir, directory)
      const rootDiagnosis = diagnoseManagedRoot(baseDir, directory)
      if (!rootDiagnosis.ok) {
        return {
          ok: false,
          error:
            rootDiagnosis.reason ??
            'The managed document directory could not be resolved for writing.',
        }
      }
      const storedName = uniqueStoredName(root as string, cleanName)
      const relativePath = `${directory}/${storedName}`
      const fullPath = resolve(root as string, storedName)
      if (!isRealPathInside(root, fullPath)) {
        return {
          ok: false,
          error: 'The managed document path resolves outside the Tenders data directory.',
        }
      }
      try {
        await atomicWrite(fullPath, buffer)
      } catch (error: unknown) {
        return { ok: false, error: errorMessage(error, 'Failed to write document.') }
      }
      const now = clockIso()
      const record: ManagedFileRecord = {
        id: `mf-${randomUUID()}`,
        category: input.category,
        relativePath,
        fileName: cleanName,
        mimeType: input.mimeType ?? managedMimeType(cleanName),
        size: buffer.byteLength,
        hash: sha256Hex(buffer),
        createdAt: now,
        updatedAt: now,
        state: 'active',
        trashedAt: null,
        trashedPath: null,
        missingAt: null,
        replacedBy: null,
      }
      index.records.push(record)
      try {
        await writeIndex(index, recordsBefore)
      } catch (error: unknown) {
        // The metadata commit failed, so the file must not stay behind: a file in
        // `documents/` with no metadata record is invisible in the app — not
        // listed, not deletable, not cleanable from the trash. Removing it is the
        // contract (a failed managed commit leaves nothing half-written, which
        // `replace` depends on), so that is tried FIRST.
        let removed = false
        try {
          await unlink(fullPath)
          removed = true
        } catch {
          // The file could not be removed, which is the case that used to leave a
          // document the user could only find by hand. A SECOND, independent route
          // writes the record into the index the failure left on disk, so the file
          // is tracked even though its commit reported failure. Only when BOTH the
          // removal and that route fail is the index reconciled against the
          // directory, so the file is at worst reported as an orphan the user can
          // see.
          if (!index.records.some((entry) => entry.id === record.id)) index.records.push(record)
          const appended = await appendRecordToIndexOnDisk(record)
          if (!appended) await reconcileUntrackedFiles()
        }
        // The in-memory index is left as the failure left it. Whether the file
        // survived or not, the next read re-reads the file on disk, so a caller
        // never sees a record for a document that is not there.
        return { ok: false, error: errorMessage(error, 'Failed to record document metadata.') }
      }
      return { ok: true, record }
    })

  /**
   * Append one record to the metadata index sitting on disk, as a second route
   * past a failed `writeIndex`.
   *
   * Returns `true` when the record is durable in the index. It re-reads the file
   * rather than trusting the in-memory copy, because the in-memory copy is what
   * the failing commit was holding; a record already present is left alone, so a
   * commit that failed only AFTER the rename (the bytes are on disk, the fsync or
   * the accounting threw) is not written twice.
   */
  async function appendRecordToIndexOnDisk(record: ManagedFileRecord): Promise<boolean> {
    let current: ManagedIndexFile
    try {
      current = await readIndex()
    } catch {
      return false
    }
    if (current.records.some((entry) => entry.id === record.id)) return true
    current.records.push(record)
    try {
      const serialized = JSON.stringify({
        version: 1,
        updatedAt: clockIso(),
        records: current.records.map(toIndexRecord),
      })
      await atomicWrite(indexPath, serialized)
      return true
    } catch {
      return false
    }
  }

  /**
   * Record whatever is in `documents/` and `vault/` and has no metadata record, so
   * a file that reached the disk without one is visible in the app instead of
   * invisible. Used only on the path where both index-write routes have failed;
   * the ordinary `reconcile` reports these as orphans for the user to decide on,
   * which is why this only runs when the alternative is an unlisted file.
   */
  async function reconcileUntrackedFiles(): Promise<void> {
    let index: ManagedIndexFile
    try {
      index = await readIndex()
    } catch {
      return
    }
    const known = new Set(index.records.map((entry) => entry.relativePath))
    let added = 0
    for (const directory of MANAGED_SUBDIRS) {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(join(baseDir, directory), { withFileTypes: true, encoding: 'utf8' })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith('.tmp')) continue
        const relativePath = `${directory}/${entry.name}`
        if (known.has(relativePath)) continue
        const category: ManagedFileCategory = directory === 'vault' ? 'vault' : 'rfp'
        let size = 0
        let hash = ''
        try {
          const bytes = await readFile(join(baseDir, relativePath))
          size = bytes.byteLength
          hash = sha256Hex(bytes)
        } catch {
          // leave size/hash unknown; being listed is what matters here
        }
        const now = clockIso()
        index.records.push({
          id: `mf-${randomUUID()}`,
          category,
          relativePath,
          fileName: sanitizeManagedFileName(entry.name.replace(/^\d+_/, ''), category),
          mimeType: managedMimeType(entry.name),
          size,
          hash,
          createdAt: now,
          updatedAt: now,
          state: 'active',
          trashedAt: null,
          trashedPath: null,
          missingAt: null,
          replacedBy: null,
        })
        known.add(relativePath)
        added += 1
      }
    }
    if (added === 0) return
    try {
      await atomicWrite(
        indexPath,
        JSON.stringify({
          version: 1,
          updatedAt: clockIso(),
          records: index.records.map(toIndexRecord),
        }),
      )
    } catch {
      // best effort: the file stays reported as an orphan by the next reconcile
    }
  }

  /** Move an active (or adopted) file into the trash. Never hard-unlinks. */
  const trashInternal = async (
    relativePath: string,
    replacedBy?: string,
  ): Promise<ManagedTrashResult> =>
    withLock(async () => {
      const index = await readIndex()
      const recordsBefore = index.records.length
      const existing = index.records.find(
        (record) => record.relativePath === relativePath && record.state === 'active',
      )
      // A link at the leaf is never a document this app wrote (`save` writes into
      // a name it composed, with `flag: 'wx'`), so the move is refused for it —
      // that is what stops a planted link from making the app relocate whatever
      // it points at.
      const confined = resolveConfinedManagedPath(baseDir, relativePath)
      if (!confined.ok && confined.reason === 'escaped') {
        return {
          ok: false,
          error: 'The document resolves to a link outside the Tenders data directory.',
        }
      }
      const fullPath = confined.ok ? confined.path : join(baseDir, relativePath)
      const fileExists = confined.ok

      // Idempotent: a second delete of a trashed (or already-missing) file is ok.
      if (!fileExists && !existing) return { ok: true }
      if (!fileExists && existing) {
        const now = clockIso()
        existing.state = 'missing'
        existing.missingAt = now
        existing.updatedAt = now
        await writeIndex(index, recordsBefore)
        return { ok: false, error: 'File not found on disk.' }
      }

      // Checked before the adopt-untracked-file branch below, so a full trash
      // cannot grow the record collection on its way to refusing.
      const trashCount = index.records.filter((record) => record.state === 'trashed').length
      if (trashCount >= MAX_TENDERS_TRASH_ENTRIES) {
        return { ok: false, error: 'Trash limit reached; clean up trash before deleting more.' }
      }

      let record = existing
      if (!record) {
        // Adopting an untracked file adds a record, so the record cap binds here
        // too: the check in `save` never sees this path, and without it the
        // collection could grow past `MAX_TENDERS_MANAGED_FILES` through
        // soft-deletes alone — the user would be shown a count above the
        // documented capacity, refused only by the invisible byte ceiling.
        if (index.records.length >= MAX_TENDERS_MANAGED_FILES) {
          return {
            ok: false,
            error:
              'Managed-document metadata limit reached; the file was not deleted. Empty the trash before deleting more.',
          }
        }
        // Adopt an untracked file rather than risk an unrecoverable unlink.
        const category: ManagedFileCategory = relativePath.startsWith('vault/') ? 'vault' : 'rfp'
        let size = 0
        let hash = ''
        try {
          const bytes = await readFile(fullPath)
          size = bytes.byteLength
          hash = sha256Hex(bytes)
        } catch {
          // leave size/hash unknown; the move below is what matters
        }
        const now = clockIso()
        record = {
          id: `mf-${randomUUID()}`,
          category,
          relativePath,
          // Clamped like every other stored name, so an externally-placed long
          // name cannot push the record past its documented serialized budget.
          fileName: sanitizeManagedFileName(basename(relativePath).replace(/^\d+_/, ''), category),
          mimeType: managedMimeType(relativePath),
          size,
          hash,
          createdAt: now,
          updatedAt: now,
          state: 'active',
          trashedAt: null,
          trashedPath: null,
          missingAt: null,
          replacedBy: null,
        }
        index.records.push(record)
      }

      // The trash destination is confined on the same terms: `mkdir` first, then
      // re-assert the `.trash/` prefix against the resolved root.
      const realTrashDir = await realManagedRoot(baseDir, MANAGED_DOCUMENTS_TRASH_DIR)
      const trashDiagnosis = diagnoseManagedRoot(baseDir, MANAGED_DOCUMENTS_TRASH_DIR)
      if (!trashDiagnosis.ok) {
        return {
          ok: false,
          error: trashDiagnosis.reason ?? 'The document trash directory could not be resolved.',
        }
      }
      const trashName = await uniqueTrashName(record.id, record.fileName)
      const trashedPath = `${MANAGED_DOCUMENTS_TRASH_DIR}/${trashName}`
      const trashedFull = resolve(realTrashDir as string, trashName)
      if (!isRealPathInside(realTrashDir, trashedFull)) {
        return { ok: false, error: 'The trash path resolves outside the Tenders data directory.' }
      }
      try {
        await rename(fullPath, trashedFull)
      } catch (error: unknown) {
        return { ok: false, error: errorMessage(error, 'Failed to move document to trash.') }
      }
      const now = clockIso()
      record.state = 'trashed'
      record.trashedAt = now
      record.trashedPath = trashedPath
      record.updatedAt = now
      record.missingAt = null
      if (replacedBy) record.replacedBy = replacedBy
      try {
        await writeIndex(index, recordsBefore)
      } catch (error: unknown) {
        // Roll the move back so a failed metadata commit cannot lose the file.
        try {
          await rename(trashedFull, fullPath)
        } catch {
          // best effort
        }
        return { ok: false, error: errorMessage(error, 'Failed to record soft-delete.') }
      }
      return { ok: true, entry: toTrashEntry(record) }
    })

  const restore = (idOrPath: string): Promise<ManagedRestoreResult> =>
    withLock(async () => {
      const index = await readIndex()
      const recordsBefore = index.records.length
      const record = index.records.find(
        (candidate) =>
          candidate.state === 'trashed' &&
          (candidate.id === idOrPath ||
            candidate.trashedPath === idOrPath ||
            candidate.relativePath === idOrPath),
      )
      if (!record || !record.trashedPath) {
        return { ok: false, error: 'Trash entry not found.' }
      }
      const trashed = resolveConfinedManagedPath(baseDir, record.trashedPath, 'trash')
      if (!trashed.ok) {
        if (trashed.reason === 'escaped') {
          return {
            ok: false,
            error: 'The trash entry resolves to a link outside the Tenders data directory.',
          }
        }
        const now = clockIso()
        record.state = 'missing'
        record.missingAt = now
        record.updatedAt = now
        await writeIndex(index, recordsBefore)
        return { ok: false, error: 'Trashed file is missing.' }
      }
      const trashedFull = trashed.path
      let targetRelative = record.relativePath
      const unresolvable = (directory: string) => ({
        ok: false as const,
        error:
          diagnoseManagedRoot(baseDir, directory).reason ??
          'The managed document directory could not be resolved.',
      })
      let targetRoot = await realManagedRoot(baseDir, targetRelative.split('/')[0])
      if (!diagnoseManagedRoot(baseDir, targetRelative.split('/')[0]).ok) {
        return unresolvable(targetRelative.split('/')[0])
      }
      if (
        isRealPathInside(
          targetRoot,
          resolve(targetRoot as string, targetRelative.split('/')[1] ?? ''),
        )
      ) {
        const directory = targetRelative.split('/')[0]
        targetRelative = `${directory}/${clock().getTime()}_${randomUUID().slice(0, 8)}_${record.fileName}`
        targetRoot = await realManagedRoot(baseDir, directory)
        if (!diagnoseManagedRoot(baseDir, directory).ok) return unresolvable(directory)
      }
      const restoredFull = resolve(targetRoot as string, targetRelative.split('/')[1] ?? '')
      if (!isRealPathInside(targetRoot, restoredFull)) {
        return { ok: false, error: 'The restore path resolves outside the Tenders data directory.' }
      }
      try {
        await rename(trashedFull, restoredFull)
      } catch (error: unknown) {
        return { ok: false, error: errorMessage(error, 'Failed to restore document.') }
      }
      const now = clockIso()
      record.relativePath = targetRelative
      record.state = 'active'
      record.trashedAt = null
      record.trashedPath = null
      record.missingAt = null
      record.updatedAt = now
      try {
        await writeIndex(index, recordsBefore)
      } catch (error: unknown) {
        try {
          await rename(restoredFull, trashedFull)
        } catch {
          // best effort
        }
        return { ok: false, error: errorMessage(error, 'Failed to record restore.') }
      }
      return { ok: true, record, restoredPath: targetRelative }
    })

  return {
    save,
    trash: (storedPath, trashOptions) => {
      const relativePath = toManagedRelativePath(storedPath)
      if (!relativePath) return Promise.resolve({ ok: false, error: 'Invalid managed path.' })
      return trashInternal(relativePath, trashOptions?.replacedBy)
    },
    replace: async (input) => {
      const previousPath = toManagedRelativePath(input.storedPath)
      if (!previousPath) return { ok: false, error: 'Invalid managed path.' }
      const category: ManagedFileCategory = previousPath.startsWith('vault/') ? 'vault' : 'rfp'
      // 1. Commit the replacement file + metadata first.
      const created = await save({
        fileName: input.fileName,
        buffer: input.buffer,
        category,
        mimeType: input.mimeType,
      })
      if (!created.ok) return created
      // 2. Only after the new commit succeeds, move the old file to trash.
      const trashed = await trashInternal(previousPath, created.record.id)
      if (!trashed.ok) {
        return {
          ok: true,
          record: created.record,
          previousTrashed: false,
          warning: trashed.error,
        }
      }
      return { ok: true, record: created.record, previousTrashed: true }
    },
    restore,
    listTrash: () =>
      withLock(async () => {
        const index = await readIndex()
        return index.records.filter((record) => record.state === 'trashed').map(toTrashEntry)
      }),
    listRecords: () =>
      withLock(async () => {
        const index = await readIndex()
        return index.records.map((record) => ({ ...record }))
      }),
    reconcile: () =>
      withLock(async (): Promise<DocumentReconciliation> => {
        const index = await readIndex()
        const recordsBefore = index.records.length
        const missing: DocumentReconciliation['missing'] = []
        let changed = false
        for (const record of index.records) {
          if (record.state === 'trashed') continue
          // A record whose leaf is a link (or whose directory resolves outside
          // the Tenders data directory) is not a readable document and must not
          // report as `active`: the same confinement every read path applies.
          const confined = resolveConfinedManagedPath(baseDir, record.relativePath)
          if (confined.ok === false && confined.reason === 'escaped') {
            if (record.state === 'missing') continue
            const now = clockIso()
            record.state = 'missing'
            record.missingAt = now
            record.updatedAt = now
            changed = true
            missing.push({
              id: record.id,
              relativePath: record.relativePath,
              fileName: record.fileName,
              lastSeenAt: now,
            })
            continue
          }
          const present = confined.ok
          if (record.state === 'missing') {
            // Symmetric heal: a file that comes back (restored from a backup, an
            // undelete, a sync that caught up) returns its record to `active`
            // instead of leaving it permanently `missing` — otherwise the record
            // could never be cleared and the file would also be reported
            // orphaned.
            if (!present) continue
            record.state = 'active'
            record.missingAt = null
            record.updatedAt = clockIso()
            changed = true
            continue
          }
          if (!present) {
            const now = clockIso()
            record.state = 'missing'
            record.missingAt = now
            record.updatedAt = now
            changed = true
            missing.push({
              id: record.id,
              relativePath: record.relativePath,
              fileName: record.fileName,
              lastSeenAt: now,
            })
          }
        }
        const activePaths = new Set(
          index.records.filter((record) => record.state === 'active').map((r) => r.relativePath),
        )
        const orphaned: string[] = []
        for (const directory of MANAGED_SUBDIRS) {
          const full = join(baseDir, directory)
          if (!existsSync(full)) continue
          for (const entry of readdirSync(full, { withFileTypes: true })) {
            if (!entry.isFile() || entry.name.endsWith('.tmp')) continue
            const relative = `${directory}/${entry.name}`
            if (!activePaths.has(relative)) orphaned.push(relative)
          }
        }
        if (changed) await writeIndex(index, recordsBefore)
        return {
          missing,
          orphaned: orphaned.sort(),
          trashed: index.records.filter((record) => record.state === 'trashed').map(toTrashEntry),
          activeCount: activePaths.size,
        }
      }),
    cleanupTrash: (cleanupOptions) =>
      withLock(async () => {
        const index = await readIndex()
        const recordsBefore = index.records.length
        const olderThanMs = cleanupOptions?.olderThanMs
        const purgeAll = cleanupOptions?.all === true
        const keep: ManagedFileRecord[] = []
        let removed = 0
        for (const record of index.records) {
          if (record.state === 'trashed' && record.trashedPath) {
            const trashedAt = record.trashedAt ? Date.parse(record.trashedAt) : 0
            const eligible =
              purgeAll ||
              (typeof olderThanMs === 'number' &&
                Number.isFinite(olderThanMs) &&
                Date.now() - trashedAt >= olderThanMs)
            if (eligible) {
              // Purge only the file the confined path proves is this entry, so a
              // link planted at a trashed leaf can never make the cleanup unlink
              // whatever it points at.
              const target = resolveConfinedManagedPath(baseDir, record.trashedPath, 'trash')
              if (target.ok) {
                try {
                  await unlink(target.path)
                } catch {
                  // already gone
                }
              }
              removed += 1
              continue
            }
          }
          keep.push(record)
        }
        index.records = keep
        await writeIndex(index, recordsBefore)
        return { ok: true, removed }
      }),
  }
}

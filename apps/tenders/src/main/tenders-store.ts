import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { TendersDataV2 } from '../shared/types'
import {
  createEmptyTendersDataV2,
  migrateTendersData,
  validateTendersDataV2,
} from '../shared/tenders-schema'
import type {
  SaveTendersRequest,
  SaveTendersResult,
  TendersLoadResult,
  TendersPersistenceError,
  TendersPersistenceErrorCode,
  TendersRecoveryCandidate,
} from '../shared/tenders-persistence'
import { TENDERS_PERSISTENCE_FILE_NAME } from '../shared/tenders-persistence'
import {
  MAX_TENDERS_BACKUPS,
  MAX_TENDERS_DOCUMENT_BYTES,
  MAX_TENDERS_RECOVERY_CANDIDATES,
  MAX_TENDERS_STORE_FILE_BYTES,
} from '../shared/tenders-persistence'

const BACKUPS_DIR = 'backups'
const BACKUP_FILE = /^tenders-data\.(\d+)\.json$/
const QUARANTINE_FILE = /^primary-corrupt-(\d+)\.json$/
/** Keep at most this many quarantined corrupt primaries; oldest are pruned. */
const MAX_QUARANTINE_FILES = 5

/**
 * The store's own file-name stem — `tenders-data` for `tenders-data.json`.
 * Everything this module writes beside the primary is named after it: the
 * rotating backups `tenders-data.<revision>.json` and the write temp
 * `tenders-data.json.<uuid>.tmp`.
 */
const STORE_FILE_STEM = TENDERS_PERSISTENCE_FILE_NAME.replace(/\.[^.]+$/, '')

/**
 * Is this the name of a temporary file THIS store could have left behind?
 *
 * A crashed commit leaves `<primary>.<uuid>.tmp` (`tenders-data.json.<uuid>.tmp`)
 * in the store directory, and that leftover holds a complete, validated document,
 * so it is a genuine recovery candidate. Other writers keep their own atomic
 * temps in the same directory — the reminder scheduler commits
 * `reminders.json.<uuid>.tmp` here — and those hold no tender document at all.
 * Offering one as a recoverable copy of the user's tender data would be a
 * misreport, so the scan is keyed on the store's own name and nothing else.
 */
function isStoreTemporaryFileName(name: string): boolean {
  return name.startsWith(`${STORE_FILE_STEM}.`) && name.endsWith('.tmp')
}

export interface TendersStoreHooks {
  /**
   * Test seam: awaited inside the commit lock, after validation and the revision
   * check but before anything is written. Lets a test occupy one store's path
   * lock deterministically (mirrors `ManagedDocumentStoreHooks.beforeIndexWrite`).
   */
  beforeCommit?: () => void | Promise<void>
}

export interface TendersStoreOptions {
  directory: string
  now?: () => Date
  onCommitted?: (document: TendersDataV2) => void | Promise<void>
  hooks?: TendersStoreHooks
}

export type TendersStoreMutator = (
  document: TendersDataV2,
) => TendersDataV2 | Promise<TendersDataV2>

export interface TendersStore {
  load(): Promise<TendersLoadResult>
  save(request: SaveTendersRequest): Promise<SaveTendersResult>
  mutate(expectedRevision: number, mutator: TendersStoreMutator): Promise<SaveTendersResult>
  /** Read-only list of recoverable on-disk copies (never auto-applied). */
  listRecoveryCandidates(): Promise<TendersRecoveryCandidate[]>
  /** Explicit user restore of one candidate; never automatic. */
  restoreRecoveryCandidate(candidateId: string): Promise<SaveTendersResult>
}

type ReadState =
  | { kind: 'not-found'; data: TendersDataV2 }
  | { kind: 'loaded'; data: TendersDataV2; warnings: string[]; migrated: boolean }
  | { kind: 'error'; error: TendersPersistenceError }

const pathLocks = new Map<string, Promise<void>>()

function persistenceError(
  code: TendersPersistenceErrorCode,
  message: string,
  schemaIssues?: TendersPersistenceError['schemaIssues'],
  current?: TendersDataV2,
): TendersPersistenceError {
  return {
    code,
    message,
    ...(schemaIssues ? { schemaIssues } : {}),
    ...(current ? { current } : {}),
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function revisionIsValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function sameDocument(left: TendersDataV2, right: TendersDataV2): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function withPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  pathLocks.set(path, settled)
  settled.then(() => {
    if (pathLocks.get(path) === settled) pathLocks.delete(path)
  })
  return result
}

export function createTendersStore(options: TendersStoreOptions): TendersStore {
  const filePath = resolve(join(options.directory, TENDERS_PERSISTENCE_FILE_NAME))

  const clock = (): Date => (options.now ? options.now() : new Date())

  const readState = async (): Promise<ReadState> => {
    try {
      const information = await stat(filePath)
      if (information.size > MAX_TENDERS_STORE_FILE_BYTES) {
        return {
          kind: 'error',
          error: persistenceError(
            'READ_FAILED',
            `Tenders store file size ${information.size} exceeds limit of ${MAX_TENDERS_STORE_FILE_BYTES} bytes.`,
          ),
        }
      }
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        return {
          kind: 'error',
          error: persistenceError(
            'READ_FAILED',
            error instanceof Error ? error.message : 'Unable to inspect Tenders data.',
          ),
        }
      }
    }
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        try {
          return { kind: 'not-found', data: createEmptyTendersDataV2(clock()) }
        } catch (creationError: unknown) {
          return {
            kind: 'error',
            error: persistenceError(
              'READ_FAILED',
              creationError instanceof Error
                ? creationError.message
                : 'Unable to create empty Tenders data.',
            ),
          }
        }
      }
      return {
        kind: 'error',
        error: persistenceError(
          'READ_FAILED',
          error instanceof Error ? error.message : 'Unable to read Tenders data.',
        ),
      }
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_TENDERS_STORE_FILE_BYTES) {
      return {
        kind: 'error',
        error: persistenceError(
          'READ_FAILED',
          `Tenders store file size exceeds limit of ${MAX_TENDERS_STORE_FILE_BYTES} bytes.`,
        ),
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error: unknown) {
      return {
        kind: 'error',
        error: persistenceError(
          'READ_FAILED',
          error instanceof Error ? error.message : 'Tenders data is not valid JSON.',
        ),
      }
    }
    const migrated = migrateTendersData(parsed, clock())
    if (!migrated.ok) {
      const code =
        migrated.error.code === 'UNSUPPORTED' ? 'UNSUPPORTED_SCHEMA_VERSION' : 'INVALID_DATA'
      return {
        kind: 'error',
        error: persistenceError(code, migrated.error.message, migrated.issues),
      }
    }
    return {
      kind: 'loaded',
      data: clone(migrated.data),
      warnings: [...migrated.warnings],
      migrated: migrated.migrated,
    }
  }

  const backupsDirectory = join(options.directory, BACKUPS_DIR)

  const rotateBackups = async (): Promise<void> => {
    try {
      const names = (await readdir(backupsDirectory)).filter((name) => BACKUP_FILE.test(name))
      const ordered = names
        .map((name) => ({ name, revision: Number(BACKUP_FILE.exec(name)![1]) }))
        .sort((left, right) => left.revision - right.revision)
      while (ordered.length > MAX_TENDERS_BACKUPS) {
        const oldest = ordered.shift()
        if (!oldest) break
        try {
          await unlink(join(backupsDirectory, oldest.name))
        } catch {
          // best effort
        }
      }
    } catch {
      // no backups directory yet
    }
  }

  /**
   * Quarantined corrupt primaries use their own name shape, so they do not match
   * BACKUP_FILE and would otherwise accumulate. Prune the oldest beyond the cap;
   * best-effort, so a failed prune never blocks recovery.
   */
  const rotateQuarantine = async (): Promise<void> => {
    try {
      const names = (await readdir(backupsDirectory)).filter((name) => QUARANTINE_FILE.test(name))
      const ordered = names
        .map((name) => ({ name, stamp: Number(QUARANTINE_FILE.exec(name)![1]) }))
        .sort((left, right) => left.stamp - right.stamp)
      while (ordered.length > MAX_QUARANTINE_FILES) {
        const oldest = ordered.shift()
        if (!oldest) break
        try {
          await unlink(join(backupsDirectory, oldest.name))
        } catch {
          // best effort
        }
      }
    } catch {
      // no backups directory yet
    }
  }

  /**
   * Copy the currently-committed primary into the rotating backup set before it
   * is replaced (last-known-good copies). Best-effort: a failed backup never
   * blocks the new commit. The very first commit has no previous file, so no
   * backup is created.
   */
  const backupExistingPrimary = async (): Promise<void> => {
    if (!existsSync(filePath)) return
    try {
      const raw = await readFile(filePath, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > MAX_TENDERS_STORE_FILE_BYTES) return
      const migrated = migrateTendersData(JSON.parse(raw), clock())
      if (!migrated.ok) return
      await mkdir(backupsDirectory, { recursive: true })
      const target = join(backupsDirectory, `tenders-data.${migrated.data.revision}.json`)
      if (!existsSync(target)) {
        await writeFile(target, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      }
      await rotateBackups()
    } catch {
      // backups are best-effort; the primary commit is unaffected
    }
  }

  /** Only recovery candidates inside this store directory are ever read. */
  const normalizeCandidateId = (id: unknown): string | null => {
    if (typeof id !== 'string' || id.length === 0 || id.includes('\0')) return null
    const normalized = id.replace(/\\/g, '/')
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('..')) {
      return null
    }
    const leaf = normalized.split('/').pop() ?? ''
    if (normalized.startsWith(`${BACKUPS_DIR}/`) && BACKUP_FILE.test(leaf)) return normalized
    // Only the store's own temp files, never another writer's (see
    // `isStoreTemporaryFileName`).
    if (!normalized.includes('/') && isStoreTemporaryFileName(normalized)) return normalized
    return null
  }

  const scanRecoveryCandidates = async (): Promise<TendersRecoveryCandidate[]> => {
    const candidates: TendersRecoveryCandidate[] = []
    const consider = async (
      id: string,
      source: TendersRecoveryCandidate['source'],
    ): Promise<void> => {
      const full = join(options.directory, id)
      try {
        const information = await stat(full)
        if (!information.isFile()) return
        let valid = false
        let revision: number | undefined
        let updatedAt: string | undefined
        let reason: string | undefined
        try {
          const migrated = migrateTendersData(JSON.parse(await readFile(full, 'utf8')), clock())
          if (migrated.ok) {
            valid = true
            revision = migrated.data.revision
            updatedAt = migrated.data.updatedAt
          } else {
            reason = migrated.error.message
          }
        } catch (error: unknown) {
          reason = error instanceof Error ? error.message : 'Candidate is unreadable.'
        }
        candidates.push({
          id,
          path: id,
          source,
          valid,
          ...(reason ? { reason } : {}),
          ...(updatedAt ? { updatedAt } : {}),
          ...(revision !== undefined ? { revision } : {}),
          sizeBytes: information.size,
        })
      } catch {
        // candidate disappeared between listing and stat
      }
    }
    try {
      for (const name of await readdir(backupsDirectory)) {
        if (BACKUP_FILE.test(name)) await consider(`${BACKUPS_DIR}/${name}`, 'backup')
      }
    } catch {
      // no backups directory
    }
    try {
      for (const name of await readdir(options.directory)) {
        if (isStoreTemporaryFileName(name)) await consider(name, 'temporary')
      }
    } catch {
      // store directory unreadable
    }
    candidates.sort((left, right) => {
      const revisionDelta = (right.revision ?? -1) - (left.revision ?? -1)
      return revisionDelta !== 0 ? revisionDelta : left.id.localeCompare(right.id)
    })
    return candidates.slice(0, MAX_TENDERS_RECOVERY_CANDIDATES)
  }

  const loadInternal = async (): Promise<TendersLoadResult> => {
    const state = await readState()
    if (state.kind === 'error') {
      // A corrupt/invalid primary is never replaced by an empty or backup
      // document. When recoverable copies exist, surface RECOVERY_REQUIRED so the
      // client can offer an explicit restore.
      if (state.error.code === 'READ_FAILED' || state.error.code === 'INVALID_DATA') {
        const candidates = await scanRecoveryCandidates()
        if (candidates.length > 0) {
          return {
            ok: false,
            error: {
              code: 'RECOVERY_REQUIRED',
              message: state.error.message,
              ...(state.error.schemaIssues ? { schemaIssues: state.error.schemaIssues } : {}),
            },
            recoveryCandidates: candidates,
          }
        }
      }
      return { ok: false, error: state.error }
    }
    if (state.kind === 'not-found')
      return {
        ok: true,
        status: 'not-found',
        data: clone(state.data),
        needsSave: false,
        warnings: [],
      }
    return {
      ok: true,
      status: state.migrated ? 'migrated' : 'loaded',
      data: clone(state.data),
      needsSave: state.migrated,
      warnings: [...state.warnings],
    }
  }

  /**
   * Full validation of a save request: shape, revision agreement, the published
   * compact-document ceiling, and the schema walk.
   *
   * The walk's own `TendersDataV2` is returned rather than discarded, because it is
   * what the commit writes: the walk is the only thing that decides the parsed shape
   * (it defaults absent optionals and drops unknown keys), so a caller that kept the
   * request's object would be committing a document the walk never approved. Returning
   * it is also what makes a second walk of the same payload unnecessary — see
   * `commitDurably`.
   */
  const validateRequest = (
    request: SaveTendersRequest,
  ): { ok: true; data: TendersDataV2 } | { ok: false; data: SaveTendersResult } => {
    if (
      !request ||
      typeof request !== 'object' ||
      !revisionIsValid(request.expectedRevision) ||
      !request.document ||
      typeof request.document !== 'object'
    ) {
      return {
        ok: false,
        data: {
          ok: false,
          error: persistenceError(
            'INVALID_REQUEST',
            'A valid expectedRevision and document are required.',
          ),
        },
      }
    }
    if (request.document.revision !== request.expectedRevision) {
      return {
        ok: false,
        data: {
          ok: false,
          error: persistenceError(
            'INVALID_REQUEST',
            'expectedRevision must match document.revision.',
          ),
        },
      }
    }
    // The compact document ceiling is measured before the schema walk so an
    // over-size document is refused with the ceiling the UI mirrors and reports
    // with a way forward — otherwise the walk's aggregate-text check (which runs
    // first, `tenders-schema.ts`) answers with a limit that names no field and no
    // way forward. Unmeasurable input (a cyclic document) falls through to the
    // walk, which reports it as INVALID_DATA.
    try {
      const compactBytes = Buffer.byteLength(JSON.stringify(request.document), 'utf8')
      if (compactBytes > MAX_TENDERS_DOCUMENT_BYTES) {
        return {
          ok: false,
          data: {
            ok: false,
            error: persistenceError(
              'INVALID_DATA',
              `Serialized Tenders document size exceeds limit of ${MAX_TENDERS_DOCUMENT_BYTES} bytes.`,
            ),
          },
        }
      }
    } catch {
      // Not serializable — let schema validation describe it.
    }
    const validated = validateTendersDataV2(request.document)
    if (!validated.ok) {
      const code =
        validated.error.code === 'UNSUPPORTED' ? 'UNSUPPORTED_SCHEMA_VERSION' : 'INVALID_DATA'
      return {
        ok: false,
        data: { ok: false, error: persistenceError(code, validated.error.message, validated.issues) },
      }
    }
    return { ok: true, data: validated.data }
  }

  const commitDurably = async (request: SaveTendersRequest): Promise<SaveTendersResult> => {
    // ONE validation of the request's document for the whole commit. `validateRequest`
    // returns the walk's own `TendersDataV2` because the walk is what decides the
    // parsed shape: it defaults absent optional fields, drops unknown keys, and runs
    // the cross-field checks in `semanticChecks` that a structural read cannot. The
    // document that is WRITTEN is that parsed value, not the caller's object, so
    // validating the caller's object again below it would be a second full walk of
    // the same payload — through `aggregateStrings` and every value parser — over
    // the same bytes, for an answer already in hand.
    //
    // This cost is paid in the process that drives the UI: the same synchronous walk
    // ran twice per commit, and nothing between the two calls reads the payload or
    // suspends (it is followed directly by the file read). The guarantee is unchanged
    // because `validateRequest` validates exactly what is later written — `clone(of
    // the walk's data)`, with only `revision` and `updatedAt` replaced, both of which
    // are themselves checked (revision against the request, the timestamp as a finite
    // value here and again by `parseV2` on the read-back) — and the write is followed
    // by a full re-parse of the file that was written.
    const validated = validateRequest(request)
    if (!validated.ok) return validated.data

    const currentState = await readState()
    if (currentState.kind === 'error') return { ok: false, error: currentState.error }
    if (currentState.data.revision !== request.expectedRevision) {
      const current = clone(currentState.data)
      return {
        ok: false,
        error: persistenceError(
          'REVISION_CONFLICT',
          'The Tenders document revision has changed.',
          undefined,
          current,
        ),
        current,
      }
    }

    // Test seam: awaited inside the commit lock, so a test can occupy this store's
    // path lock deterministically. Undefined in production.
    await options.hooks?.beforeCommit?.()

    let updatedAt: string
    try {
      updatedAt = clock().toISOString()
    } catch (error: unknown) {
      return {
        ok: false,
        error: persistenceError(
          'WRITE_FAILED',
          error instanceof Error ? error.message : 'Unable to create commit timestamp.',
        ),
      }
    }
    // `validated.data` is the walk's own parsed document, and the delta applied to
    // it is two fields the walk has just checked on the same object: `revision` is
    // the request's own (already asserted to be a valid non-negative integer and
    // already compared against `document.revision`) incremented, and `updatedAt` is
    // the commit clock's RFC3339 string. Neither can change another field, and both
    // are re-checked on the way back in — `readState` re-parses the file this writes
    // with `validateTendersDataV2` and the read-back is compared to this value below.
    const committed: TendersDataV2 = {
      ...clone(validated.data),
      revision: request.expectedRevision + 1,
      updatedAt,
    }

    const serialized = JSON.stringify(committed, null, 2)
    const compactBytes = Buffer.byteLength(JSON.stringify(committed), 'utf8')
    if (compactBytes > MAX_TENDERS_DOCUMENT_BYTES) {
      return {
        ok: false,
        error: persistenceError(
          'INVALID_DATA',
          `Serialized Tenders document size exceeds limit of ${MAX_TENDERS_DOCUMENT_BYTES} bytes.`,
        ),
      }
    }
    // The committed file is the same document pretty-printed, so indentation can
    // push it past the store-file ceiling that `readState` enforces on load. Check
    // before writing: a document the loader would refuse must never replace a
    // readable primary (a post-rename read-back failure would leave an unloadable
    // file behind).
    const serializedBytes = Buffer.byteLength(serialized, 'utf8')
    if (serializedBytes > MAX_TENDERS_STORE_FILE_BYTES) {
      return {
        ok: false,
        error: persistenceError(
          'INVALID_DATA',
          `Serialized Tenders document would be ${serializedBytes} bytes on disk, above the ${MAX_TENDERS_STORE_FILE_BYTES}-byte store file limit.`,
        ),
      }
    }
    // Rotate the previous committed file into the backup set before replacing
    // it. Best-effort: the new commit proceeds even if the backup fails.
    await backupExistingPrimary()

    const tempPath = `${filePath}.${randomUUID()}.tmp`
    try {
      await mkdir(options.directory, { recursive: true })
      await writeFile(tempPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      const handle = await open(tempPath, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tempPath, filePath)
    } catch (error: unknown) {
      let cleanupDetail = ''
      try {
        await unlink(tempPath)
      } catch (cleanupError: unknown) {
        cleanupDetail = ` Temporary-file cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}.`
      }
      const original = error instanceof Error ? error.message : 'Unable to commit Tenders data.'
      return { ok: false, error: persistenceError('WRITE_FAILED', `${original}.${cleanupDetail}`) }
    }

    const readback = await readState()
    if (readback.kind !== 'loaded' || !sameDocument(readback.data, committed)) {
      return {
        ok: false,
        error: persistenceError(
          'WRITE_FAILED',
          'Committed Tenders data did not match the full read-back payload.',
        ),
      }
    }
    return { ok: true, data: clone(readback.data) }
  }

  const notifyAfterCommit = async (result: SaveTendersResult): Promise<SaveTendersResult> => {
    if (!result.ok || !options.onCommitted) return result
    try {
      await options.onCommitted(clone(result.data))
      return result
    } catch (error: unknown) {
      return { ...result, postCommitError: error instanceof Error ? error.message : String(error) }
    }
  }

  const restoreRecoveryCandidate = async (candidateId: string): Promise<SaveTendersResult> => {
    const id = normalizeCandidateId(candidateId)
    if (!id) {
      return {
        ok: false,
        error: persistenceError('INVALID_REQUEST', 'Invalid recovery candidate id.'),
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(options.directory, id), 'utf8'))
    } catch (error: unknown) {
      return {
        ok: false,
        error: persistenceError(
          'READ_FAILED',
          error instanceof Error ? error.message : 'Candidate is unreadable.',
        ),
      }
    }
    const migrated = migrateTendersData(parsed, clock())
    if (!migrated.ok) {
      return {
        ok: false,
        error: persistenceError('INVALID_DATA', migrated.error.message, migrated.issues),
      }
    }
    const state = await readState()
    if (state.kind === 'error') {
      // Explicit recovery over an unreadable primary: quarantine the corrupt
      // file first (never overwrite it silently), then commit the candidate as a
      // fresh revision.
      try {
        await mkdir(backupsDirectory, { recursive: true })
        await rename(filePath, join(backupsDirectory, `primary-corrupt-${Date.now()}.json`))
      } catch {
        return {
          ok: false,
          error: persistenceError(
            'WRITE_FAILED',
            'Unable to quarantine the unreadable primary before recovery.',
          ),
        }
      }
      // Bound the quarantine set so repeated recoveries cannot accumulate.
      await rotateQuarantine()
      const recovered: TendersDataV2 = {
        ...clone(migrated.data),
        revision: 0,
        updatedAt: clock().toISOString(),
      }
      const validated = validateTendersDataV2(recovered)
      if (!validated.ok) {
        return {
          ok: false,
          error: persistenceError('INVALID_DATA', validated.error.message, validated.issues),
        }
      }
      return withPathLock(filePath, () =>
        commitDurably({ expectedRevision: 0, document: validated.data }),
      ).then(notifyAfterCommit)
    }
    const expectedRevision = state.data.revision
    const document: TendersDataV2 = { ...clone(migrated.data), revision: expectedRevision }
    const validated = validateTendersDataV2(document)
    if (!validated.ok) {
      return {
        ok: false,
        error: persistenceError('INVALID_DATA', validated.error.message, validated.issues),
      }
    }
    return withPathLock(filePath, () =>
      commitDurably({ expectedRevision, document: validated.data }),
    ).then(notifyAfterCommit)
  }

  return {
    load: () => withPathLock(filePath, loadInternal),
    save: (request) => {
      let snapshot: SaveTendersRequest
      try {
        snapshot = clone(request)
      } catch (error: unknown) {
        return Promise.resolve({
          ok: false,
          error: persistenceError(
            'INVALID_REQUEST',
            error instanceof Error ? error.message : 'Request cannot be cloned.',
          ),
        })
      }
      return withPathLock(filePath, () => commitDurably(snapshot)).then(notifyAfterCommit)
    },
    mutate: (expectedRevision, mutator) => {
      if (!revisionIsValid(expectedRevision) || typeof mutator !== 'function') {
        return Promise.resolve({
          ok: false,
          error: persistenceError(
            'INVALID_REQUEST',
            'A valid expectedRevision and mutator are required.',
          ),
        })
      }
      return withPathLock(filePath, async () => {
        const state = await readState()
        if (state.kind === 'error') return { ok: false, error: state.error } as SaveTendersResult
        const current = clone(state.data)
        if (current.revision !== expectedRevision) {
          return {
            ok: false,
            error: persistenceError(
              'REVISION_CONFLICT',
              'The Tenders document revision has changed.',
              undefined,
              clone(current),
            ),
            current: clone(current),
          } as SaveTendersResult
        }
        return { ok: true, data: current } as SaveTendersResult
      }).then(async (snapshotResult) => {
        if (!snapshotResult.ok) return snapshotResult
        let proposed: TendersDataV2
        try {
          proposed = await mutator(clone(snapshotResult.data))
        } catch (error: unknown) {
          return {
            ok: false,
            error: persistenceError(
              'INVALID_REQUEST',
              error instanceof Error ? error.message : 'Mutator failed.',
            ),
          }
        }
        const validation = validateTendersDataV2(proposed)
        if (!validation.ok)
          return {
            ok: false,
            error: persistenceError('INVALID_DATA', validation.error.message, validation.issues),
          }
        if (sameDocument(validation.data, snapshotResult.data)) {
          return { ok: true, data: clone(snapshotResult.data) }
        }
        return withPathLock(filePath, () =>
          commitDurably({ expectedRevision, document: validation.data }),
        ).then(notifyAfterCommit)
      })
    },
    listRecoveryCandidates: () => withPathLock(filePath, scanRecoveryCandidates),
    restoreRecoveryCandidate,
  }
}

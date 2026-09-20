import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTendersStore } from '../src/main/tenders-store'
import {
  TENDERS_PERSISTENCE_FILE_NAME,
  type SaveTendersResult,
  type TendersLoadResult,
} from '../src/shared/tenders-persistence'
import {
  createEmptyTendersDataV2,
  migrateTendersDataV1,
  validateTendersDataV2,
} from '../src/shared/tenders-schema'
import type { IssuerTemplate, TendersDataV1, TendersDataV2 } from '../src/shared/types'

const CLOCK_ISO = '2026-09-14T10:11:12.345Z'
const ORIGINAL_ISO = '2026-08-20T09:15:30.000Z'
const FIXED_NOW = new Date(CLOCK_ISO)
// Proposed export: MAX_TENDERS_STORE_FILE_BYTES (shared with
// tenders-persistence-bounds.test.ts).
const ASSUMED_MAX_STORE_FILE_BYTES = 8 * 1024 * 1024
const roots: string[] = []

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 750): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function isSettledWithin<T>(promise: Promise<T>, timeoutMs = 250): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
}

async function uniqueDirectory(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tenders-store-${label}-${randomUUID()}-`))
  roots.push(root)
  return root
}

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
    lastSeen: ORIGINAL_ISO,
  }
}

function validV2(revision = 0, issuerIds: string[] = ['issuer-one']): TendersDataV2 {
  return {
    ...createEmptyTendersDataV2(ORIGINAL_ISO),
    revision,
    issuerTemplates: issuerIds.map(issuer),
  }
}

function validV1WithMigrationWarning(): TendersDataV1 {
  return {
    version: 1,
    updatedAt: 'not-a-date',
    activeCompanyId: '',
    workspaces: [],
    issuerTemplates: [issuer('legacy-issuer')],
  }
}

function expectLoadSuccess(
  result: TendersLoadResult,
): asserts result is Extract<TendersLoadResult, { ok: true }> {
  expect(result.ok).toBe(true)
  if ('error' in result) throw new Error(`Expected load success, received ${result.error.code}`)
}

function expectLoadFailure(
  result: TendersLoadResult,
  code: string,
): asserts result is Extract<TendersLoadResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, error: { code } })
  expect(result).not.toHaveProperty('data')
  if (result.ok) throw new Error(`Expected load failure ${code}`)
}

function expectSaveSuccess(
  result: SaveTendersResult,
): asserts result is Extract<SaveTendersResult, { ok: true }> {
  expect(result.ok).toBe(true)
  if ('error' in result) throw new Error(`Expected save success, received ${result.error.code}`)
}

function expectSaveFailure(
  result: SaveTendersResult,
  code: string,
): asserts result is Extract<SaveTendersResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, error: { code } })
  expect(result).not.toHaveProperty('data')
  if (result.ok) throw new Error(`Expected save failure ${code}`)
}

async function readDocument(directory: string): Promise<TendersDataV2> {
  return JSON.parse(await readFile(storePath(directory), 'utf8')) as TendersDataV2
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Phase 2 authoritative Tenders store', () => {
  describe('load', () => {
    it('returns a genuinely empty revision-zero v2 document for a missing file without creating or seeding it', async () => {
      const directory = await uniqueDirectory('missing')
      const result = await createTendersStore({ directory, now: () => FIXED_NOW }).load()

      expectLoadSuccess(result)
      expect(result).toEqual({
        ok: true,
        status: 'not-found',
        data: createEmptyTendersDataV2(CLOCK_ISO),
        needsSave: false,
        warnings: [],
      })
      expect(JSON.stringify(result.data)).not.toMatch(/co-thabo|tender-wtr-04|vd-tax|demo/i)
      await expect(stat(storePath(directory))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('loads valid v2 data exactly as a validated deep clone without requiring a save', async () => {
      const directory = await uniqueDirectory('v2')
      const input = validV2(7, ['issuer-one', 'issuer-two'])
      await writeFile(storePath(directory), JSON.stringify(input), 'utf8')
      const validated = validateTendersDataV2(input)
      if (!validated.ok) throw new Error('Test fixture must be valid')

      const result = await createTendersStore({ directory, now: () => FIXED_NOW }).load()

      expectLoadSuccess(result)
      expect(result).toMatchObject({ status: 'loaded', needsSave: false, warnings: [] })
      expect(result.data).toEqual(validated.data)
      expect(result.data).not.toBe(input)
      expect(result.data.issuerTemplates).not.toBe(input.issuerTemplates)
    })

    it('migrates valid v1 only in memory, preserves warnings, and leaves the source unchanged until save', async () => {
      const directory = await uniqueDirectory('v1')
      const input = validV1WithMigrationWarning()
      const originalBytes = JSON.stringify(input, null, 2)
      await writeFile(storePath(directory), originalBytes, 'utf8')
      const expected = migrateTendersDataV1(input, CLOCK_ISO)
      if (!expected.ok) throw new Error('Test fixture must migrate')

      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      const result = await store.load()

      expectLoadSuccess(result)
      expect(result).toEqual({
        ok: true,
        status: 'migrated',
        data: expected.data,
        needsSave: true,
        warnings: expected.warnings,
      })
      expect(result.data.revision).toBe(0)
      expect(result.warnings).not.toHaveLength(0)
      expect(await readFile(storePath(directory), 'utf8')).toBe(originalBytes)

      const saved = await store.save({ expectedRevision: 0, document: result.data })
      expectSaveSuccess(saved)
      expect(await readFile(storePath(directory), 'utf8')).not.toBe(originalBytes)
    })

    it.each([
      [
        'malformed JSON',
        async (directory: string) => writeFile(storePath(directory), '{broken', 'utf8'),
      ],
      ['read failure', async (directory: string) => mkdir(storePath(directory))],
    ])('returns READ_FAILED with no data or demo fallback for %s', async (_label, arrange) => {
      const directory = await uniqueDirectory('read-failure')
      await arrange(directory)

      // Contract choice: all primary-file read/JSON decoding failures are READ_FAILED.
      const result = await createTendersStore({ directory, now: () => FIXED_NOW }).load()

      expectLoadFailure(result, 'READ_FAILED')
      expect(JSON.stringify(result)).not.toMatch(/co-thabo|tender-wtr-04|vd-tax/)
    })

    it('rejects a future schema version without exposing data', async () => {
      const directory = await uniqueDirectory('future')
      await writeFile(
        storePath(directory),
        JSON.stringify({ ...validV2(), schemaVersion: 99 }),
        'utf8',
      )

      const result = await createTendersStore({ directory, now: () => FIXED_NOW }).load()

      expectLoadFailure(result, 'UNSUPPORTED_SCHEMA_VERSION')
    })

    it('rejects an oversized primary file by size before parsing its contents', async () => {
      const directory = await uniqueDirectory('oversized-parse-order')
      // Implementation note: this test asserts an observable consequence of the
      // required size-check-before-read behavior. Production must `stat()` the
      // primary file and reject when its size exceeds MAX_TENDERS_STORE_FILE_BYTES
      // *before* calling readFile/JSON.parse. Read-timing itself is not observable
      // without a filesystem seam, so the contract is encoded as: a non-JSON,
      // oversized file reports the size bound rather than a JSON parse failure.
      await writeFile(storePath(directory), 'X'.repeat(ASSUMED_MAX_STORE_FILE_BYTES + 4096), 'utf8')

      const result = await createTendersStore({ directory, now: () => FIXED_NOW }).load()

      expectLoadFailure(result, 'READ_FAILED')
      expect(result.error.message).toMatch(/size|limit|large|exceed|byte/i)
      expect(result.error.message).not.toMatch(/json|parse|unexpected|token/i)
    })
  })

  describe('save', () => {
    it('commits a new revision-one document with the main-controlled timestamp and returns exact disk data', async () => {
      const directory = await uniqueDirectory('first-save')
      const requested = validV2(0)
      const result = await createTendersStore({ directory, now: () => FIXED_NOW }).save({
        expectedRevision: 0,
        document: requested,
      })

      expectSaveSuccess(result)
      expect(result.data).toEqual({ ...requested, revision: 1, updatedAt: CLOCK_ISO })
      expect(await readDocument(directory)).toEqual(result.data)
      expect(validateTendersDataV2(await readDocument(directory))).toMatchObject({ ok: true })
    })

    it('requires both expectedRevision and document.revision to equal existing revision N', async () => {
      const directory = await uniqueDirectory('revision-n')
      await writeFile(storePath(directory), JSON.stringify(validV2(4)), 'utf8')
      const requested = validV2(4, ['replacement'])

      const result = await createTendersStore({ directory, now: () => FIXED_NOW }).save({
        expectedRevision: 4,
        document: requested,
      })

      expectSaveSuccess(result)
      expect(result.data).toEqual({ ...requested, revision: 5, updatedAt: CLOCK_ISO })
    })

    it('returns REVISION_CONFLICT with the current document and performs no write or callback', async () => {
      const directory = await uniqueDirectory('conflict')
      const current = validV2(3)
      const originalBytes = JSON.stringify(current, null, 2)
      await writeFile(storePath(directory), originalBytes, 'utf8')
      const onCommitted = vi.fn()

      const result = await createTendersStore({
        directory,
        now: () => FIXED_NOW,
        onCommitted,
      }).save({
        expectedRevision: 2,
        document: validV2(2, ['stale-change']),
      })

      expectSaveFailure(result, 'REVISION_CONFLICT')
      expect(result.current).toEqual(current)
      expect(await readFile(storePath(directory), 'utf8')).toBe(originalBytes)
      expect(onCommitted).not.toHaveBeenCalled()
    })

    it('rejects an expectedRevision/document revision mismatch as INVALID_REQUEST without writing', async () => {
      const directory = await uniqueDirectory('bad-request')
      const original = validV2(2)
      const originalBytes = JSON.stringify(original)
      await writeFile(storePath(directory), originalBytes, 'utf8')
      const onCommitted = vi.fn()

      const result = await createTendersStore({
        directory,
        now: () => FIXED_NOW,
        onCommitted,
      }).save({
        expectedRevision: 2,
        document: validV2(1),
      })

      expectSaveFailure(result, 'INVALID_REQUEST')
      expect(await readFile(storePath(directory), 'utf8')).toBe(originalBytes)
      expect(onCommitted).not.toHaveBeenCalled()
    })

    it('rejects invalid v2 data as INVALID_DATA with schema issues and no write', async () => {
      const directory = await uniqueDirectory('invalid-data')
      const original = validV2(0)
      const originalBytes = JSON.stringify(original)
      await writeFile(storePath(directory), originalBytes, 'utf8')
      const invalid = { ...original, activeCompanyId: 'missing-workspace' }
      const onCommitted = vi.fn()

      const result = await createTendersStore({
        directory,
        now: () => FIXED_NOW,
        onCommitted,
      }).save({
        expectedRevision: 0,
        document: invalid,
      })

      expectSaveFailure(result, 'INVALID_DATA')
      expect(result.error.schemaIssues).not.toHaveLength(0)
      expect(await readFile(storePath(directory), 'utf8')).toBe(originalBytes)
      expect(onCommitted).not.toHaveBeenCalled()
    })

    it('returns WRITE_FAILED for a deterministic impossible file target and preserves the blocking file', async () => {
      const root = await uniqueDirectory('write-failure')
      const blocker = join(root, 'not-a-directory')
      const blockerBytes = 'do-not-replace'
      await writeFile(blocker, blockerBytes, 'utf8')
      const onCommitted = vi.fn()

      const result = await createTendersStore({
        directory: blocker,
        now: () => FIXED_NOW,
        onCommitted,
      }).save({
        expectedRevision: 0,
        document: validV2(0),
      })

      expectSaveFailure(result, 'WRITE_FAILED')
      expect(await readFile(blocker, 'utf8')).toBe(blockerBytes)
      expect(onCommitted).not.toHaveBeenCalled()
    })

    it('atomically commits without temp artifacts and invokes callback only after readable disk data matches', async () => {
      const directory = await uniqueDirectory('atomic')
      let diskSeenByCallback: TendersDataV2 | undefined
      const onCommitted = vi.fn(async (document: TendersDataV2) => {
        diskSeenByCallback = await readDocument(directory)
        expect(diskSeenByCallback).toEqual(document)
      })
      const store = createTendersStore({ directory, now: () => FIXED_NOW, onCommitted })

      const result = await store.save({ expectedRevision: 0, document: validV2(0) })

      expectSaveSuccess(result)
      expect(onCommitted).toHaveBeenCalledOnce()
      expect(diskSeenByCallback).toEqual(result.data)
      expect(await readdir(directory)).toEqual([TENDERS_PERSISTENCE_FILE_NAME])
    })

    it('serializes two saves at the same revision so exactly one commits and one conflicts', async () => {
      const directory = await uniqueDirectory('concurrent-saves')
      const onCommitted = vi.fn()
      const store = createTendersStore({ directory, now: () => FIXED_NOW, onCommitted })

      const results = await Promise.all([
        store.save({ expectedRevision: 0, document: validV2(0, ['change-a']) }),
        store.save({ expectedRevision: 0, document: validV2(0, ['change-b']) }),
      ])

      expect(results.filter((result) => result.ok)).toHaveLength(1)
      const failure = results.find((result) => !result.ok)
      expect(failure).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
      expect((await readDocument(directory)).revision).toBe(1)
      expect(onCommitted).toHaveBeenCalledOnce()
    })

    it('reports a rejected post-commit notification as success and preserves the durable revision', async () => {
      const directory = await uniqueDirectory('post-commit-rejection')
      const notificationFailure = new Error('notification failed after durable commit')
      const onCommitted = vi
        .fn()
        .mockRejectedValueOnce(notificationFailure)
        .mockResolvedValue(undefined)
      const store = createTendersStore({ directory, now: () => FIXED_NOW, onCommitted })
      const requested = validV2(0, ['durably-committed'])
      const committed = { ...requested, revision: 1, updatedAt: CLOCK_ISO }

      const first = await settleWithin(store.save({ expectedRevision: 0, document: requested }))
      const expectedFirst = {
        ok: true,
        data: committed,
        postCommitError: notificationFailure.message,
      } satisfies SaveTendersResult

      expect(first).toEqual(expectedFirst)
      expect(first).not.toMatchObject({ error: { code: 'WRITE_FAILED' } })
      const loaded = await settleWithin(store.load())
      expectLoadSuccess(loaded)
      expect(loaded.data).toEqual(committed)

      const second = await settleWithin(
        store.save({
          expectedRevision: 1,
          document: { ...committed, issuerTemplates: [issuer('queue-still-usable')] },
        }),
      )
      expectSaveSuccess(second)
      expect(second.data).toMatchObject({ revision: 2 })
    })

    it('snapshots the complete save request synchronously before a queued operation can release', async () => {
      const directory = await uniqueDirectory('save-snapshot')
      const callbackEntered = deferred()
      const releaseCallback = deferred()
      const onCommitted = vi.fn(async (document: TendersDataV2) => {
        if (document.revision === 1) {
          callbackEntered.resolve()
          await releaseCallback.promise
        }
      })
      const store = createTendersStore({ directory, now: () => FIXED_NOW, onCommitted })
      const firstSave = store.save({ expectedRevision: 0, document: validV2(0, ['queue-blocker']) })
      await settleWithin(callbackEntered.promise)

      const originalDocument = validV2(1, ['snapshotted'])
      const expectedCommitted = {
        ...structuredClone(originalDocument),
        revision: 2,
        updatedAt: CLOCK_ISO,
      }
      const request = { expectedRevision: 1, document: originalDocument }
      const queuedSave = store.save(request)
      request.expectedRevision = 99
      request.document.revision = 99
      request.document.issuerTemplates[0].name = 'mutated after save returned'
      releaseCallback.resolve()

      expectSaveSuccess(await settleWithin(firstSave))
      const result = await settleWithin(queuedSave)
      expectSaveSuccess(result)
      expect(result.data).toEqual(expectedCommitted)
      expect(await readDocument(directory)).toEqual(expectedCommitted)
    })

    it('uses one process-wide lock for separate stores resolving to the same persistence path', async () => {
      const directory = await uniqueDirectory('cross-store-save-lock')
      const storeA = createTendersStore({ directory, now: () => FIXED_NOW })
      const storeB = createTendersStore({ directory: join(directory, '.'), now: () => FIXED_NOW })

      const results = await settleWithin(
        Promise.all([
          storeA.save({ expectedRevision: 0, document: validV2(0, ['instance-a']) }),
          storeB.save({ expectedRevision: 0, document: validV2(0, ['instance-b']) }),
        ]),
      )

      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok)).toHaveLength(1)
      expect(results.find((result) => !result.ok)).toMatchObject({
        ok: false,
        error: { code: 'REVISION_CONFLICT' },
      })
      const successful = results.find((result) => result.ok)
      if (!successful?.ok) throw new Error('Expected exactly one successful cross-store save')
      expect(await readDocument(directory)).toEqual(successful.data)
    })

    it('does not make an operation in a different directory wait for an occupied path lock', async () => {
      const directoryA = await uniqueDirectory('path-lock-a')
      const directoryB = await uniqueDirectory('path-lock-b')
      await writeFile(storePath(directoryA), JSON.stringify(validV2(1, ['a'])), 'utf8')
      const mutatorEntered = deferred()
      const releaseMutator = deferred()
      const storeA = createTendersStore({ directory: directoryA, now: () => FIXED_NOW })
      const storeB = createTendersStore({ directory: directoryB, now: () => FIXED_NOW })
      const blocked = storeA.mutate(1, async (document) => {
        mutatorEntered.resolve()
        await releaseMutator.promise
        return document
      })
      await settleWithin(mutatorEntered.promise)

      const independentSave = storeB.save({ expectedRevision: 0, document: validV2(0, ['b']) })
      const settledIndependently = await isSettledWithin(independentSave)
      releaseMutator.resolve()

      expect(settledIndependently).toBe(true)
      expectSaveSuccess(await settleWithin(independentSave))
      expectSaveSuccess(await settleWithin(blocked))
    })

    it('allows onCommitted to await load on the same store and observe the exact committed data', async () => {
      const directory = await uniqueDirectory('callback-reentrant-load')
      let store: ReturnType<typeof createTendersStore>
      let observed: TendersLoadResult | undefined
      const onCommitted = vi.fn(async () => {
        observed = await settleWithin(store.load(), 350)
      })
      store = createTendersStore({ directory, now: () => FIXED_NOW, onCommitted })

      const result = await settleWithin(
        store.save({ expectedRevision: 0, document: validV2(0, ['callback-load']) }),
        900,
      )

      expectSaveSuccess(result)
      if (!observed) throw new Error('onCommitted did not observe a load result')
      expectLoadSuccess(observed)
      expect(observed.data).toEqual(result.data)
      expect(onCommitted).toHaveBeenCalledOnce()
    })

    it('keeps the queue usable after a write failure', async () => {
      const root = await uniqueDirectory('write-failure-recovery')
      const directory = join(root, 'replaceable-blocker')
      await writeFile(directory, 'blocking file', 'utf8')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })

      const failed = await settleWithin(store.save({ expectedRevision: 0, document: validV2(0) }))
      expectSaveFailure(failed, 'WRITE_FAILED')
      await rm(directory)
      await mkdir(directory)

      const recovered = await settleWithin(
        store.save({ expectedRevision: 0, document: validV2(0, ['recovered']) }),
      )
      expectSaveSuccess(recovered)
      expect((await readDocument(directory)).issuerTemplates[0].id).toBe('recovered')
    })

    it('preserves the original write error and reports failure to clean its temporary file', async () => {
      const root = await uniqueDirectory('dual-write-failure')
      const directory = join(root, 'directory-is-a-file')
      await writeFile(directory, 'blocking file', 'utf8')

      const result = await createTendersStore({ directory, now: () => FIXED_NOW }).save({
        expectedRevision: 0,
        document: validV2(0),
      })

      expectSaveFailure(result, 'WRITE_FAILED')
      expect(result.error.message).toContain(directory)
      expect(result.error.message).toMatch(/temp(?:orary)?[^.]*clean|clean(?:up|ing)[^.]*temp/i)
    })

    it('returns and notifies the exact first payload even when another instance commits the next revision', async () => {
      const directory = await uniqueDirectory('readback-identity')
      const callbackEntered = deferred()
      const releaseCallback = deferred()
      let callbackDocument: TendersDataV2 | undefined
      const storeA = createTendersStore({
        directory,
        now: () => FIXED_NOW,
        onCommitted: async (document) => {
          callbackDocument = document
          callbackEntered.resolve()
          await releaseCallback.promise
        },
      })
      const storeB = createTendersStore({ directory, now: () => FIXED_NOW })
      const firstRequested = validV2(0, ['first-exact-payload'])
      const firstSave = storeA.save({ expectedRevision: 0, document: firstRequested })
      await settleWithin(callbackEntered.promise)

      const secondRequested = validV2(1, ['competing-next-payload'])
      const secondSave = storeB.save({ expectedRevision: 1, document: secondRequested })
      const secondSettledBeforeRelease = await isSettledWithin(secondSave)
      releaseCallback.resolve()
      const [first, second] = await settleWithin(Promise.all([firstSave, secondSave]))

      expect(secondSettledBeforeRelease).toBe(true)
      expectSaveSuccess(first)
      expectSaveSuccess(second)
      expect(first.data).toEqual({ ...firstRequested, revision: 1, updatedAt: CLOCK_ISO })
      expect(callbackDocument).toEqual(first.data)
      expect(second.data).toEqual({ ...secondRequested, revision: 2, updatedAt: CLOCK_ISO })
      expect(await readDocument(directory)).toEqual(second.data)
    })
  })

  describe('mutate', () => {
    it('gives the mutator a clone, validates its output, and increments revision exactly once', async () => {
      const directory = await uniqueDirectory('mutate-clone')
      const callerHeld = validV2(0)
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      const initial = await store.save({ expectedRevision: 0, document: callerHeld })
      expectSaveSuccess(initial)
      const snapshot = structuredClone(initial.data)
      let received: TendersDataV2 | undefined

      const result = await store.mutate(1, (document) => {
        received = document
        document.issuerTemplates.push(issuer('mutated'))
        return document
      })

      expectSaveSuccess(result)
      expect(received).not.toBe(initial.data)
      expect(initial.data).toEqual(snapshot)
      expect(callerHeld).toEqual(validV2(0))
      expect(result.data.revision).toBe(2)
      expect(result.data.issuerTemplates.map((item) => item.id)).toContain('mutated')
    })

    it('turns thrown and invalid mutator results into typed failures without writing or callback', async () => {
      const directory = await uniqueDirectory('bad-mutator')
      const onCommitted = vi.fn()
      const store = createTendersStore({ directory, now: () => FIXED_NOW, onCommitted })
      const initial = await store.save({ expectedRevision: 0, document: validV2(0) })
      expectSaveSuccess(initial)
      onCommitted.mockClear()
      const before = await readFile(storePath(directory), 'utf8')

      const thrown = await store.mutate(1, () => {
        throw new Error('mutator exploded')
      })
      expectSaveFailure(thrown, 'INVALID_REQUEST')
      const invalid = await store.mutate(1, (document) => ({
        ...document,
        activeCompanyId: 'missing',
      }))
      expectSaveFailure(invalid, 'INVALID_DATA')

      expect(await readFile(storePath(directory), 'utf8')).toBe(before)
      expect(onCommitted).not.toHaveBeenCalled()
    })

    it('preserves chained updates and conflicts one of two concurrent mutations at the same revision', async () => {
      const directory = await uniqueDirectory('mutation-order')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      expectSaveSuccess(await store.save({ expectedRevision: 0, document: validV2(0, []) }))

      const first = await store.mutate(1, (document) => ({
        ...document,
        issuerTemplates: [...document.issuerTemplates, issuer('first')],
      }))
      expectSaveSuccess(first)
      const second = await store.mutate(2, (document) => ({
        ...document,
        issuerTemplates: [...document.issuerTemplates, issuer('second')],
      }))
      expectSaveSuccess(second)
      expect(second.data.issuerTemplates.map((item) => item.id)).toEqual(['first', 'second'])

      const concurrent = await Promise.all([
        store.mutate(3, (document) => ({
          ...document,
          issuerTemplates: [...document.issuerTemplates, issuer('third-a')],
        })),
        store.mutate(3, (document) => ({
          ...document,
          issuerTemplates: [...document.issuerTemplates, issuer('third-b')],
        })),
      ])
      expect(concurrent.filter((result) => result.ok)).toHaveLength(1)
      expect(concurrent.find((result) => !result.ok)).toMatchObject({
        ok: false,
        error: { code: 'REVISION_CONFLICT' },
      })
      const final = await readDocument(directory)
      expect(final.revision).toBe(4)
      expect(final.issuerTemplates.map((item) => item.id)).toEqual(
        expect.arrayContaining(['first', 'second']),
      )
    })

    it('allows an async mutator to await load without deadlock and then settle with a commit or clean conflict', async () => {
      const directory = await uniqueDirectory('mutator-reentrant-load')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      expectSaveSuccess(await store.save({ expectedRevision: 0, document: validV2(0, []) }))
      let observed: TendersLoadResult | undefined

      const result = await settleWithin(
        store.mutate(1, async (document) => {
          observed = await settleWithin(store.load(), 350)
          document.issuerTemplates.push(issuer('async-mutator'))
          return document
        }),
        900,
      )

      expect(result.ok || (!result.ok && result.error.code === 'REVISION_CONFLICT')).toBe(true)
      if (!observed) throw new Error('Async mutator did not observe a load result')
      expectLoadSuccess(observed)
      if (result.ok) {
        expect(result.data.issuerTemplates.map((item) => item.id)).toContain('async-mutator')
        expect((await readDocument(directory)).revision).toBe(2)
      }
    })

    it('serializes same-revision mutations across separate store instances', async () => {
      const directory = await uniqueDirectory('cross-store-mutate-lock')
      await writeFile(storePath(directory), JSON.stringify(validV2(1, [])), 'utf8')
      const storeA = createTendersStore({ directory, now: () => FIXED_NOW })
      const storeB = createTendersStore({ directory: join(directory, '.'), now: () => FIXED_NOW })

      const results = await settleWithin(
        Promise.all([
          storeA.mutate(1, (document) => ({
            ...document,
            issuerTemplates: [...document.issuerTemplates, issuer('mutate-a')],
          })),
          storeB.mutate(1, (document) => ({
            ...document,
            issuerTemplates: [...document.issuerTemplates, issuer('mutate-b')],
          })),
        ]),
      )

      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok)).toHaveLength(1)
      expect(results.find((result) => !result.ok)).toMatchObject({
        ok: false,
        error: { code: 'REVISION_CONFLICT' },
      })
      expect((await readDocument(directory)).revision).toBe(2)
    })

    it('keeps the queue usable after a mutator throws', async () => {
      const directory = await uniqueDirectory('mutator-throw-recovery')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      expectSaveSuccess(await store.save({ expectedRevision: 0, document: validV2(0, []) }))

      const failed = await store.mutate(1, () => {
        throw new Error('expected mutator rejection')
      })
      expectSaveFailure(failed, 'INVALID_REQUEST')

      const recovered = await settleWithin(
        store.mutate(1, (document) => ({
          ...document,
          issuerTemplates: [issuer('after-throw')],
        })),
      )
      expectSaveSuccess(recovered)
      expect(recovered.data.issuerTemplates[0].id).toBe('after-throw')
    })

    it('does not increment the revision, write, or notify when the mutator returns an unchanged document', async () => {
      const directory = await uniqueDirectory('mutate-noop')
      const onCommitted = vi.fn()
      const store = createTendersStore({ directory, now: () => FIXED_NOW, onCommitted })
      const initial = await store.save({ expectedRevision: 0, document: validV2(0, ['stable']) })
      expectSaveSuccess(initial)
      onCommitted.mockClear()
      const before = await readFile(storePath(directory), 'utf8')

      const noop = await settleWithin(store.mutate(1, (document) => document))

      expectSaveSuccess(noop)
      expect(noop.data.revision).toBe(1)
      expect(await readFile(storePath(directory), 'utf8')).toBe(before)
      expect(onCommitted).not.toHaveBeenCalled()

      // A structurally-equal clone is also a no-op, not a new revision.
      const cloned = await settleWithin(store.mutate(1, (document) => structuredClone(document)))
      expectSaveSuccess(cloned)
      expect(cloned.data.revision).toBe(1)
      expect(await readFile(storePath(directory), 'utf8')).toBe(before)
      expect(onCommitted).not.toHaveBeenCalled()

      // The unchanged no-ops must leave the revision ready for a real commit.
      const changed = await settleWithin(
        store.mutate(1, (document) => ({
          ...document,
          issuerTemplates: [...document.issuerTemplates, issuer('changed-once')],
        })),
      )
      expectSaveSuccess(changed)
      expect(changed.data.revision).toBe(2)
      expect(onCommitted).toHaveBeenCalledOnce()
      expect((await readDocument(directory)).revision).toBe(2)
    })
  })

  describe('isolation and path boundary', () => {
    it('never exposes mutable internal references through save or load results', async () => {
      const directory = await uniqueDirectory('references')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      const saved = await store.save({ expectedRevision: 0, document: validV2(0) })
      expectSaveSuccess(saved)
      saved.data.issuerTemplates[0].name = 'tampered save result'

      const firstLoad = await store.load()
      expectLoadSuccess(firstLoad)
      expect(firstLoad.data.issuerTemplates[0].name).toBe('Issuer issuer-one')
      firstLoad.data.issuerTemplates[0].name = 'tampered load result'

      expect((await readDocument(directory)).issuerTemplates[0].name).toBe('Issuer issuer-one')
      const secondLoad = await store.load()
      expectLoadSuccess(secondLoad)
      expect(secondLoad.data.issuerTemplates[0].name).toBe('Issuer issuer-one')
    })

    it('uses exactly directory/tenders-data.json and the store module has no renderer, demo, or userData dependency', async () => {
      const directory = await uniqueDirectory('path')
      const store = createTendersStore({ directory, now: () => FIXED_NOW })
      expectSaveSuccess(await store.save({ expectedRevision: 0, document: validV2(0) }))

      expect(await readdir(directory)).toEqual([TENDERS_PERSISTENCE_FILE_NAME])
      expect(await readDocument(directory)).toMatchObject({ schemaVersion: 2, revision: 1 })

      const source = await readFile(
        join(import.meta.dirname, '..', 'src', 'main', 'tenders-store.ts'),
        'utf8',
      )
      expect(source).not.toMatch(/userData|renderer|(?:^|[/\\])demo(?:[/\\]|['"])/)
    })
  })
})

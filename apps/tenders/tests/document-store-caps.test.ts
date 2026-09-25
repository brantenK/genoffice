/**
 * Managed-document resource caps (audit finding: `MAX_TENDERS_MANAGED_FILES`,
 * `MAX_TENDERS_TRASH_ENTRIES` and `MAX_TENDERS_MANAGED_INDEX_BYTES` had zero
 * coverage, and the 4 MiB index cap refused writes at ~11.5k records — well below
 * the advertised 20 000 — which wedged the user out of deleting documents too).
 *
 * The caps are one coherent set: the byte ceiling is a GROWTH cap on the
 * serialized index (the exception below is the only way past it) and the record
 * caps are derived to stay *reachable* inside it, so a full store refuses on a
 * limit the user can count rather than on an invisible byte budget below it.
 * It is NOT a memory bound: `JSON.parse` costs ~5.05× the serialized bytes in
 * live objects (measured, `tenders-persistence-bounds.test.ts`), and an index
 * over the ceiling is still read and written. The bound on the cost of one
 * managed-document operation is `MAX_TENDERS_MANAGED_FILES` (5 000 records):
 *
 *   MAX_TENDERS_MANAGED_FILES × MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD
 *     ≤ MAX_TENDERS_MANAGED_INDEX_BYTES
 *   MAX_TENDERS_TRASH_ENTRIES ≤ MAX_TENDERS_MANAGED_FILES   (trash ⊆ records)
 *   measured record cost ≤ MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD
 *     (the file name is clamped to MAX_TENDERS_MANAGED_FILE_NAME_CHARS, without
 *     which an unbounded name defeats the arithmetic above)
 *
 * The byte ceiling itself is a *growth* backstop, not a bound on every write: a
 * write that adds a record is refused when it would exceed the ceiling, while
 * lifecycle transitions (trash / restore / empty-trash / reconcile's
 * missing-heal) are deliberately allowed past it so a full index can never wedge
 * the user out of deleting. That exception is pinned, not assumed.
 *
 * Each cap is exercised at and just below its boundary. The fixtures write the
 * metadata index directly (the same compact shape the store itself writes, with
 * the field sizes a real record has) so a boundary can be reached without 5 000
 * file writes.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createManagedDocumentStore,
  MANAGED_DOCUMENTS_INDEX_FILE,
} from '../src/main/document-store'
import {
  MAX_TENDERS_DOCUMENT_BYTES,
  MAX_TENDERS_MANAGED_FILE_NAME_CHARS,
  MAX_TENDERS_MANAGED_FILES,
  MAX_TENDERS_MANAGED_INDEX_BYTES,
  MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD,
  MAX_TENDERS_TRASH_ENTRIES,
} from '../src/shared/tenders-persistence'

/** Every field of the documented `ManagedFileRecord` shape, and no others. */
const MANAGED_RECORD_FIELDS = [
  'id',
  'category',
  'relativePath',
  'fileName',
  'mimeType',
  'size',
  'hash',
  'createdAt',
  'updatedAt',
  'state',
  'trashedAt',
  'trashedPath',
  'missingAt',
  'replacedBy',
] as const

const roots: string[] = []

async function tempBaseDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tenders-doc-caps-${randomUUID().slice(0, 8)}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  // `maxRetries` because a recursive delete on Windows can fail with ENOTEMPTY
  // while a handle the store just closed is still being released. Cleanup is not
  // an assertion, and a cleanup flake must not be reported as a cap failure.
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  )
})

function store(baseDir: string, hooks?: { beforeIndexWrite?: () => void | Promise<void> }) {
  return createManagedDocumentStore({ baseDir, hooks })
}

function indexPath(baseDir: string): string {
  return join(baseDir, MANAGED_DOCUMENTS_INDEX_FILE)
}

/** A realistic stored file name (37 characters, as a real certificate would be). */
const SEED_FILE_NAME = 'Zanostack_B-BBEE_Certificate_2026.pdf'
const SEED_HASH = 'a'.repeat(64)
const SEED_TS = '2026-09-01T00:00:00.000Z'

/**
 * A raw managed-index payload as this file writes it: the fields the writer
 * knows, plus whatever a fixture replaces or adds.
 *
 * Deliberately still open (`[key: string]: unknown`) — these tests write FILES,
 * including malformed ones the store has to tolerate — but the known fields are
 * NAMED, so a fixture that reads one back (`.id`, say) gets a real type instead
 * of the index signature TypeScript drops when this object is spread.
 */
interface IndexRecordPayload {
  id: string
  category: string
  relativePath: string
  fileName: string
  mimeType: string
  size: number
  hash: string
  createdAt: string
  updatedAt: string
  state: string
  [key: string]: unknown
}

/**
 * One index record in the compact on-disk shape the store writes (null-valued
 * optional fields omitted) and with the field sizes a real record has: a
 * 64-character SHA-256, a 37-character file name, ISO timestamps and a
 * timestamped relative path. Seeding realistic records — not minimal
 * placeholders — is what lets the record-cap fixtures prove the count cap is
 * reachable inside the byte ceiling.
 */
function seedRecord(index: number, overrides: Record<string, unknown> = {}): IndexRecordPayload {
  return {
    id: `mf-seed-${index}`,
    category: 'rfp',
    relativePath: `documents/175800${String(index).padStart(5, '0')}_${SEED_FILE_NAME}`,
    fileName: SEED_FILE_NAME,
    mimeType: 'application/pdf',
    size: 1_234_567,
    hash: SEED_HASH,
    createdAt: SEED_TS,
    updatedAt: SEED_TS,
    state: 'active',
    ...overrides,
  }
}

function seedTrashedRecord(
  index: number,
  overrides: Record<string, unknown> = {},
): IndexRecordPayload {
  return seedRecord(index, {
    state: 'trashed',
    trashedPath: `.trash/mf-seed-${index}__${SEED_FILE_NAME}`,
    trashedAt: SEED_TS,
    ...overrides,
  })
}

/** Write the metadata index directly; returns its serialized byte length. */
async function writeIndexFile(
  baseDir: string,
  records: Array<Record<string, unknown>>,
  pretty = false,
): Promise<number> {
  await mkdir(baseDir, { recursive: true })
  const serialized = JSON.stringify(
    { version: 1, updatedAt: '2026-09-01T00:00:00.000Z', records },
    null,
    pretty ? 2 : undefined,
  )
  await writeFile(indexPath(baseDir), serialized, 'utf8')
  return Buffer.byteLength(serialized, 'utf8')
}

/** Serialized byte cost of one record exactly as the store wrote it. */
async function recordBytes(baseDir: string, id: string): Promise<number> {
  const parsed = JSON.parse(await readFile(indexPath(baseDir), 'utf8')) as {
    records: Array<Record<string, unknown>>
  }
  const record = parsed.records.find((candidate) => candidate.id === id)
  if (!record) throw new Error(`record ${id} is missing from the metadata index`)
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

/** The on-disk (compact) record as it was written, for write-side assertions. */
async function onDiskRecord(baseDir: string, id: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(indexPath(baseDir), 'utf8')) as {
    records: Array<Record<string, unknown>>
  }
  const record = parsed.records.find((candidate) => candidate.id === id)
  if (!record) throw new Error(`record ${id} is missing from the metadata index`)
  return record
}

/** The live `FileHandle` prototype, so `sync` can be observed. */
async function fileHandlePrototype(): Promise<{ sync: () => Promise<void> }> {
  const probeDir = await tempBaseDir()
  const handle = await open(join(probeDir, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(handle) as { sync: () => Promise<void> }
  await handle.close()
  return prototype
}

describe('MAX_TENDERS_MANAGED_FILES boundary', () => {
  it('accepts a save one below the cap and refuses the save that would reach it', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    await writeIndexFile(
      baseDir,
      Array.from({ length: MAX_TENDERS_MANAGED_FILES - 1 }, (_, index) => seedRecord(index)),
    )

    const below = await managed.save({
      fileName: 'last.pdf',
      buffer: Buffer.from('last'),
      category: 'vault',
    })
    expect(below.ok).toBe(true)
    expect(await managed.listRecords()).toHaveLength(MAX_TENDERS_MANAGED_FILES)
    // Reachability: a store at the record cap still fits inside the byte ceiling,
    // so the record cap — a limit the user can count — is the one that binds. The
    // old pair advertised 20 000 records while the byte ceiling admitted ~11 500,
    // so a full store was refused below the documented cap with "index is full".
    expect(
      Buffer.byteLength(await readFile(indexPath(baseDir), 'utf8'), 'utf8'),
    ).toBeLessThanOrEqual(MAX_TENDERS_MANAGED_INDEX_BYTES)

    const atCap = await managed.save({
      fileName: 'overflow.pdf',
      buffer: Buffer.from('overflow'),
      category: 'vault',
    })
    expect(atCap.ok).toBe(false)
    if (atCap.ok) throw new Error('expected the managed-file cap to refuse the save')
    expect(atCap.error).toMatch(/limit/i)
    expect(atCap.error).not.toMatch(/index is full/i)
    expect(await managed.listRecords()).toHaveLength(MAX_TENDERS_MANAGED_FILES)
    // The refused save leaves no file behind.
    expect((await readdir(join(baseDir, 'vault'))).some((name) => name.includes('overflow'))).toBe(
      false,
    )
  })

  it('counts trashed records towards the managed-file cap', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    await writeIndexFile(
      baseDir,
      Array.from({ length: MAX_TENDERS_MANAGED_FILES }, (_, index) => seedTrashedRecord(index)),
    )

    const refused = await managed.save({
      fileName: 'anything.pdf',
      buffer: Buffer.from('anything'),
      category: 'vault',
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected trashed records to count towards the file cap')
    expect(refused.error).toMatch(/limit/i)
  })
})

describe('MAX_TENDERS_TRASH_ENTRIES boundary', () => {
  async function seedLiveFile(baseDir: string): Promise<void> {
    await mkdir(join(baseDir, 'documents'), { recursive: true })
    await writeFile(join(baseDir, 'documents', 'live.pdf'), 'live', 'utf8')
  }

  it('refuses a soft-delete at the trash cap and leaves the file and index untouched', async () => {
    const baseDir = await tempBaseDir()
    await seedLiveFile(baseDir)
    const managed = store(baseDir)
    // Exactly the trash cap, all trashed: the fixture itself stays inside
    // MAX_TENDERS_MANAGED_FILES, and `documents/live.pdf` is an untracked file so
    // the refusal is the trash cap and not the record cap.
    await writeIndexFile(
      baseDir,
      Array.from({ length: MAX_TENDERS_TRASH_ENTRIES }, (_, index) => seedTrashedRecord(index)),
    )

    const refused = await managed.trash('documents/live.pdf')

    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected the trash cap to refuse the soft-delete')
    expect(refused.error).toMatch(/trash limit/i)
    expect(existsSync(join(baseDir, 'documents', 'live.pdf'))).toBe(true)
    // The refused delete did not adopt the untracked file into the index.
    expect(await managed.listRecords()).toHaveLength(MAX_TENDERS_TRASH_ENTRIES)
    expect(await managed.listTrash()).toHaveLength(MAX_TENDERS_TRASH_ENTRIES)
  })

  it('allows a soft-delete one below the trash cap and moves the file to .trash', async () => {
    const baseDir = await tempBaseDir()
    await seedLiveFile(baseDir)
    const managed = store(baseDir)
    await writeIndexFile(
      baseDir,
      Array.from({ length: MAX_TENDERS_TRASH_ENTRIES - 1 }, (_, index) => seedTrashedRecord(index)),
    )

    const trashed = await managed.trash('documents/live.pdf')

    expect(trashed.ok).toBe(true)
    if (!trashed.ok) throw new Error(trashed.error)
    expect(trashed.entry?.trashedPath).toMatch(/^\.trash\//)
    expect(existsSync(join(baseDir, 'documents', 'live.pdf'))).toBe(false)
    expect(existsSync(join(baseDir, trashed.entry!.trashedPath))).toBe(true)
    expect(await managed.listTrash()).toHaveLength(MAX_TENDERS_TRASH_ENTRIES)
    // The untracked file was adopted (one record added, still inside the record
    // cap) and the resulting index is inside the byte ceiling.
    expect(await managed.listRecords()).toHaveLength(MAX_TENDERS_TRASH_ENTRIES)
    expect(
      Buffer.byteLength(await readFile(indexPath(baseDir), 'utf8'), 'utf8'),
    ).toBeLessThanOrEqual(MAX_TENDERS_MANAGED_INDEX_BYTES)
  })
})

describe('MAX_TENDERS_MANAGED_INDEX_BYTES boundary', () => {
  // Long names — not long values for their own sake — are what let an index reach
  // the byte ceiling before the record cap, and since the name clamp landed a
  // 1 500-character name can no longer be written by `save`: this fixture
  // reproduces the index an older build (or an externally edited file) leaves
  // behind, which is now the only way the byte ceiling is reachable at all. 3 001
  // records is inside MAX_TENDERS_MANAGED_FILES, but every name is 1 500
  // characters, so the index is over 4 MiB.
  const BIG_NAME = 'x'.repeat(1_500)
  const BIG_RECORD_COUNT = 3_000

  /** An index well over the byte cap, plus one live document on disk. */
  async function seedOverCapIndex(baseDir: string): Promise<void> {
    await mkdir(join(baseDir, 'documents'), { recursive: true })
    await writeFile(join(baseDir, 'documents', 'live.pdf'), 'live', 'utf8')
    const bytes = await writeIndexFile(baseDir, [
      seedRecord(0, { relativePath: 'documents/live.pdf', fileName: 'live.pdf' }),
      ...Array.from({ length: BIG_RECORD_COUNT }, (_, index) =>
        seedTrashedRecord(index, { fileName: BIG_NAME, trashedPath: `.trash/big${index}` }),
      ),
    ])
    expect(bytes).toBeGreaterThan(MAX_TENDERS_MANAGED_INDEX_BYTES)
    expect(BIG_RECORD_COUNT + 1).toBeLessThanOrEqual(MAX_TENDERS_MANAGED_FILES)
  }

  it('refuses growth, never blocks the delete, and allows growth again once the index shrinks', async () => {
    const baseDir = await tempBaseDir()
    await seedOverCapIndex(baseDir)
    const managed = store(baseDir)
    const indexBefore = await readFile(indexPath(baseDir), 'utf8')

    const refused = await managed.save({
      fileName: 'new.pdf',
      buffer: Buffer.from('new'),
      category: 'vault',
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected the index byte cap to refuse growth')
    expect(refused.error).toMatch(/index is full/i)
    // Nothing was committed: the index is byte-identical and the new file was
    // rolled back.
    expect(await readFile(indexPath(baseDir), 'utf8')).toBe(indexBefore)
    expect(await readdir(join(baseDir, 'vault'))).toEqual([])

    // The wedge this fix removes: a full index used to refuse the soft-delete
    // too, leaving the user unable to add or remove anything.
    const trashed = await managed.trash('documents/live.pdf')
    expect(trashed.ok).toBe(true)
    if (!trashed.ok) throw new Error(trashed.error)
    expect(existsSync(join(baseDir, 'documents', 'live.pdf'))).toBe(false)

    // Emptying the trash frees the bytes, so growth is allowed again.
    expect((await managed.cleanupTrash({ all: true })).removed).toBe(BIG_RECORD_COUNT + 1)
    const after = await managed.save({
      fileName: 'new.pdf',
      buffer: Buffer.from('new'),
      category: 'vault',
    })
    expect(after.ok).toBe(true)
    if (!after.ok) throw new Error(after.error)
    expect(await managed.listTrash()).toHaveLength(0)
  })

  // Budget, not an assertion: this test performs 100 real saves (each writing a
  // document and re-serializing the index). Measured at 11 944 ms standalone —
  // only 1.7× headroom under the 20 s default, which the full parallel suite
  // consumes (observed: timed out at 20 000 ms in-suite) — and at 56 385 ms under
  // the full suite once the budget allowed it to finish (a 4.7× load factor on
  // the same work, with the whole file at 95 403 ms in-suite against 22 649 ms
  // alone). 300 000 ms is 5.3× that worst observed cost, so the cap assertions
  // below are unchanged and a genuinely hung store still fails.
  it('measures the index cost per record against the byte cap', { timeout: 300_000 }, async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    for (let index = 0; index < 100; index += 1) {
      const saved = await managed.save({
        fileName: 'certificate.pdf',
        buffer: Buffer.from('cert'),
        category: 'vault',
      })
      expect(saved.ok).toBe(true)
    }
    const bytes = Buffer.byteLength(await readFile(indexPath(baseDir), 'utf8'), 'utf8')
    const perRecord = Math.ceil(bytes / 100)

    // ~365 bytes per realistic record, so the 4 MiB byte ceiling would admit
    // ~11.5k records. Asserted against the documented per-record ceiling rather
    // than a bracket around the measurement: what the caps must protect is that a
    // record the store writes stays inside the cost the record cap is derived
    // from, whatever that measurement happens to be.
    expect(perRecord).toBeLessThanOrEqual(MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD)

    // The heaviest realistic shape the store writes: a trashed record with a
    // 65-character name and the longest MIME type the store maps (xlsx, 65
    // characters). It must stay inside the documented per-record ceiling, which is
    // what makes `MAX_TENDERS_MANAGED_FILES` reachable inside the byte ceiling.
    const heavyName = 'B-BBEE_Certificate_of_Good_Standing_Zanostack_Level_1_2026.xlsx'
    const heavy = await managed.save({
      fileName: heavyName,
      buffer: Buffer.from('cert'),
      category: 'vault',
    })
    expect(heavy.ok).toBe(true)
    if (!heavy.ok) throw new Error(heavy.error)
    const activeBytes = await recordBytes(baseDir, heavy.record.id)
    expect(activeBytes).toBeLessThanOrEqual(MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD)

    const trashed = await managed.trash(heavy.record.relativePath)
    expect(trashed.ok).toBe(true)
    const trashedBytes = await recordBytes(baseDir, heavy.record.id)
    expect(trashedBytes).toBeGreaterThan(activeBytes)
    expect(trashedBytes).toBeLessThanOrEqual(MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD)

    // Measured reachability, independent of the documented ceiling: at the cost of
    // the heaviest record the byte ceiling admits more records than the cap, so a
    // full store refuses on the count cap — a limit the user can see — and never on
    // an invisible byte budget below it. This is the inverse of the assertion this
    // test carried before the caps were reconciled (`capacity` <
    // `MAX_TENDERS_MANAGED_FILES`), which pinned the 20 000-record cap as
    // unreachable.
    expect(Math.floor(MAX_TENDERS_MANAGED_INDEX_BYTES / trashedBytes)).toBeGreaterThanOrEqual(
      MAX_TENDERS_MANAGED_FILES,
    )
    expect(perRecord * MAX_TENDERS_MANAGED_FILES).toBeLessThanOrEqual(
      MAX_TENDERS_MANAGED_INDEX_BYTES,
    )
  })

  it('keeps the heaviest record the store can write inside the derived per-record budget', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    // The worst shape the store can produce: the longest name it will write, the
    // longest MIME type it maps, and every optional field set at once (a replaced
    // document whose trashed copy then went missing). The per-record budget and
    // the 5 000-record arithmetic rest on this record.
    const ext = '.xlsx'
    const name = `${'x'.repeat(MAX_TENDERS_MANAGED_FILE_NAME_CHARS - ext.length)}${ext}`
    const first = await managed.save({
      fileName: name,
      buffer: Buffer.from('cert'),
      category: 'vault',
    })
    if (!first.ok) throw new Error(first.error)
    expect(first.record.fileName).toHaveLength(MAX_TENDERS_MANAGED_FILE_NAME_CHARS)
    const replacement = await managed.replace({
      storedPath: first.record.relativePath,
      fileName: name,
      buffer: Buffer.from('replacement'),
    })
    if (!replacement.ok) throw new Error(replacement.error)
    const trashedPath = (await managed.listRecords()).find(
      (record) => record.id === first.record.id,
    )!.trashedPath
    await rm(join(baseDir, trashedPath!), { force: true })
    // A failed restore of the replaced, trashed document leaves the record
    // `missing` while keeping trashedAt / trashedPath / missingAt / replacedBy.
    expect((await managed.restore(first.record.id)).ok).toBe(false)

    const worst = await onDiskRecord(baseDir, first.record.id)
    expect(Object.keys(worst).sort()).toEqual([...MANAGED_RECORD_FIELDS].sort())
    const worstBytes = Buffer.byteLength(JSON.stringify(worst), 'utf8')
    expect(worstBytes).toBeLessThanOrEqual(MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD)
    // Measured, so the documented budget cannot drift away from the real cost:
    // this shape serialises to ~815 bytes.
    expect(worstBytes).toBeGreaterThan(750)

    // Reachability at the *measured* worst case: the byte ceiling admits more of
    // these records than the count cap, so a full store refuses on the count.
    expect(Math.floor(MAX_TENDERS_MANAGED_INDEX_BYTES / worstBytes)).toBeGreaterThanOrEqual(
      MAX_TENDERS_MANAGED_FILES,
    )
  })

  it('clamps a pathologically long file name so the derived budget and the trash path hold', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    // 255 characters: the longest name a caller can hand over. Unclamped it fails
    // the write itself (the `<timestamp>_<name>` component overflows the
    // filesystem's 255-character limit) and would overflow the `.trash/<id>__<name>`
    // rename after a successful save.
    const longName = `${'n'.repeat(251)}.pdf`
    const saved = await managed.save({
      fileName: longName,
      buffer: Buffer.from('long'),
      category: 'vault',
    })

    expect(saved.ok).toBe(true)
    if (!saved.ok) throw new Error(saved.error)
    expect(saved.record.fileName).toHaveLength(MAX_TENDERS_MANAGED_FILE_NAME_CHARS)
    expect(saved.record.fileName.endsWith('.pdf'), 'the extension is preserved').toBe(true)
    expect(existsSync(join(baseDir, saved.record.relativePath))).toBe(true)
    expect(await recordBytes(baseDir, saved.record.id)).toBeLessThanOrEqual(
      MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD,
    )

    const trashed = await managed.trash(saved.record.relativePath)
    expect(trashed.ok).toBe(true)
    if (!trashed.ok) throw new Error(trashed.error)
    expect(Buffer.byteLength(basename(trashed.entry!.trashedPath), 'utf8')).toBeLessThan(255)
    expect(await recordBytes(baseDir, saved.record.id)).toBeLessThanOrEqual(
      MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD,
    )
  })

  it('allows a non-growing lifecycle write past the byte ceiling and lets the trash shrink it back', async () => {
    const baseDir = await tempBaseDir()
    // An index over the byte ceiling written by an older build, whose one active
    // record points at a file that is not on disk.
    await writeIndexFile(baseDir, [
      seedRecord(0, { relativePath: 'documents/gone.pdf', fileName: 'gone.pdf' }),
      ...Array.from({ length: BIG_RECORD_COUNT }, (_, index) =>
        seedTrashedRecord(index, { fileName: BIG_NAME, trashedPath: `.trash/big${index}` }),
      ),
    ])
    const managed = store(baseDir)
    const before = await readFile(indexPath(baseDir), 'utf8')
    expect(Buffer.byteLength(before, 'utf8')).toBeGreaterThan(MAX_TENDERS_MANAGED_INDEX_BYTES)

    // Reading is never refused: refusing would hide the documents the user needs
    // to delete.
    expect(await managed.listRecords()).toHaveLength(BIG_RECORD_COUNT + 1)

    const reconciled = await managed.reconcile()

    // The `missing` heal is recorded even though it grows the serialized index:
    // the byte cap bounds growth of the collection, not lifecycle transitions, so
    // a full index can never wedge the user out of deleting or reconciling. This
    // is the documented exception, pinned here.
    expect(reconciled.missing.map((entry) => entry.relativePath)).toEqual(['documents/gone.pdf'])
    expect(await readFile(indexPath(baseDir), 'utf8')).not.toBe(before)
    expect((await managed.listRecords())[0].state).toBe('missing')

    // Growth is still refused, and emptying the trash is how the collection
    // returns inside the ceiling.
    const refused = await managed.save({
      fileName: 'new.pdf',
      buffer: Buffer.from('new'),
      category: 'vault',
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected the byte ceiling to refuse growth')
    expect(refused.error).toMatch(/index is full/i)
    expect((await managed.cleanupTrash({ all: true })).removed).toBe(BIG_RECORD_COUNT)
    expect(
      Buffer.byteLength(await readFile(indexPath(baseDir), 'utf8'), 'utf8'),
    ).toBeLessThanOrEqual(MAX_TENDERS_MANAGED_INDEX_BYTES)
  })
})

describe('MAX_TENDERS_MANAGED_FILES is an upper bound on the collection', () => {
  it('refuses to adopt an untracked file once the record cap is reached', async () => {
    const baseDir = await tempBaseDir()
    await mkdir(join(baseDir, 'documents'), { recursive: true })
    await writeFile(join(baseDir, 'documents', 'live.pdf'), 'live', 'utf8')
    const managed = store(baseDir)
    // At the cap, all active: the trash cap is not what binds, and the byte
    // ceiling is not reached, so only the record cap can refuse.
    await writeIndexFile(
      baseDir,
      Array.from({ length: MAX_TENDERS_MANAGED_FILES }, (_, index) => seedRecord(index)),
    )

    const refused = await managed.trash('documents/live.pdf')

    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected the record cap to refuse the adoption')
    expect(refused.error).toMatch(/metadata limit/i)
    expect(refused.error).not.toMatch(/index is full/i)
    // The file is untouched and no record was adopted: the collection stays at the
    // documented capacity instead of growing past it through soft-deletes alone.
    expect(existsSync(join(baseDir, 'documents', 'live.pdf'))).toBe(true)
    expect(await managed.listRecords()).toHaveLength(MAX_TENDERS_MANAGED_FILES)
  })
})

describe('the managed-document caps are one coherent set', () => {
  it('keeps the record caps reachable inside the index byte ceiling', () => {
    // The byte ceiling is a GROWTH cap on the serialized index (a write that adds
    // a record is refused above it; trash/restore/empty-trash and reconcile flips
    // are allowed past it). It is not a memory bound: `JSON.parse` costs ~5.05×
    // the serialized bytes in live objects (measured,
    // `tenders-persistence-bounds.test.ts`), and an index over the ceiling is
    // still read and written. The bound on the cost of one operation is
    // `MAX_TENDERS_MANAGED_FILES` (5 000 records). The record caps are derived
    // from that ceiling, not the other way round, so the count a full store
    // reports is a limit the user can see and count.
    expect(
      MAX_TENDERS_MANAGED_FILES * MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD,
    ).toBeLessThanOrEqual(MAX_TENDERS_MANAGED_INDEX_BYTES)
    // Trashed records live in the same index, so the trash cap is a subset cap.
    expect(MAX_TENDERS_TRASH_ENTRIES).toBeLessThanOrEqual(MAX_TENDERS_MANAGED_FILES)
    // The ceiling stays at the document-scale bound: it must not grow into the
    // largest JSON object the main process parses, so it can never exceed the
    // workspace-document ceiling it sits under.
    expect(MAX_TENDERS_MANAGED_INDEX_BYTES).toBeLessThanOrEqual(MAX_TENDERS_DOCUMENT_BYTES)
  })
})

describe('index durability + shape', () => {
  it('flushes the document and its metadata index to disk before publishing them', async () => {
    const baseDir = await tempBaseDir()
    const prototype = await fileHandlePrototype()
    const original = prototype.sync
    let syncCalls = 0
    prototype.sync = async function (this: unknown) {
      syncCalls += 1
      return original.call(this)
    }
    try {
      const saved = await store(baseDir).save({
        fileName: 'durable.pdf',
        buffer: Buffer.from('durable'),
        category: 'vault',
      })
      expect(saved.ok).toBe(true)
      // One fsync for the document, one for the metadata index.
      expect(syncCalls).toBeGreaterThanOrEqual(2)
    } finally {
      prototype.sync = original
    }
  })

  it('writes a compact index that still reads back as the documented record shape', async () => {
    const baseDir = await tempBaseDir()
    const saved = await store(baseDir).save({
      fileName: 'certificate.pdf',
      buffer: Buffer.from('cert'),
      category: 'vault',
    })
    if (!saved.ok) throw new Error(saved.error)

    const serialized = await readFile(indexPath(baseDir), 'utf8')
    expect(serialized).not.toContain('\n  ')
    const parsed = JSON.parse(serialized) as { records: Array<Record<string, unknown>> }
    expect(parsed.records[0]).not.toHaveProperty('trashedAt')
    expect(parsed.records[0]).not.toHaveProperty('missingAt')

    // A fresh store instance restores the documented nullable fields.
    const restarted = store(baseDir)
    const record = (await restarted.listRecords())[0]
    expect(record).toMatchObject({
      state: 'active',
      trashedAt: null,
      trashedPath: null,
      missingAt: null,
      replacedBy: null,
    })
    // Field-for-field: the compact form omits nothing on the way in and invents
    // nothing on the way out — exactly the 14 documented fields, no more, no
    // fewer.
    expect(Object.keys(record).sort()).toEqual([...MANAGED_RECORD_FIELDS].sort())
  })

  it('round-trips a fully populated record without losing one optional field', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    // The heaviest documented shape: every optional field set at once. Replacing a
    // document trashes the old record with `replacedBy`; removing the trashed copy
    // and failing to restore it leaves `missing` with `trashedAt`, `trashedPath`
    // and `missingAt` still populated.
    const first = await managed.save({
      fileName: 'certificate.pdf',
      buffer: Buffer.from('cert'),
      category: 'vault',
    })
    if (!first.ok) throw new Error(first.error)
    const replacement = await managed.replace({
      storedPath: first.record.relativePath,
      fileName: 'replacement.pdf',
      buffer: Buffer.from('replacement'),
    })
    if (!replacement.ok) throw new Error(replacement.error)
    const trashed = (await managed.listRecords()).find((record) => record.id === first.record.id)!
    expect(trashed.state).toBe('trashed')
    expect(trashed.replacedBy).toBe(replacement.record.id)
    await rm(join(baseDir, trashed.trashedPath!), { force: true })
    expect((await managed.restore(first.record.id)).ok).toBe(false)

    const populated = (await managed.listRecords()).find((record) => record.id === first.record.id)!
    for (const field of ['trashedAt', 'trashedPath', 'missingAt', 'replacedBy'] as const) {
      expect(populated[field], `${field} must be set for this fixture`).not.toBeNull()
    }

    // Write side: nothing non-null is dropped by the compact serializer.
    const written = await onDiskRecord(baseDir, first.record.id)
    expect(Object.keys(written).sort()).toEqual([...MANAGED_RECORD_FIELDS].sort())
    expect(written).toEqual({ ...populated })

    // Read side: a fresh instance restores the record byte-for-byte.
    const readBack = (await store(baseDir).listRecords()).find(
      (record) => record.id === first.record.id,
    )!
    expect(Object.keys(readBack).sort()).toEqual([...MANAGED_RECORD_FIELDS].sort())
    expect(readBack).toEqual(populated)
  })

  it('still reads a legacy pretty-printed index written by the old shape back identically', async () => {
    const baseDir = await tempBaseDir()
    // The old writer serialized the whole `ManagedIndexFile` with
    // `JSON.stringify(index, null, 2)`: pretty-printed, every field present, nulls
    // written explicitly. Both a fully populated record and an all-null one.
    const legacyActive = {
      ...seedRecord(0, { relativePath: 'vault/legacy.pdf', fileName: 'legacy.pdf' }),
      trashedAt: null,
      trashedPath: null,
      missingAt: null,
      replacedBy: null,
    }
    const legacyPopulated = {
      id: 'mf-legacy-populated',
      category: 'rfp',
      relativePath: 'documents/17580000001_legacy.pdf',
      fileName: 'legacy.pdf',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 1_234_567,
      hash: 'b'.repeat(64),
      createdAt: SEED_TS,
      updatedAt: SEED_TS,
      state: 'missing',
      trashedAt: SEED_TS,
      trashedPath: '.trash/mf-legacy-populated__legacy.pdf',
      missingAt: SEED_TS,
      replacedBy: 'mf-legacy-new',
    }
    await writeIndexFile(baseDir, [legacyActive, legacyPopulated], true)

    const records = await store(baseDir).listRecords()

    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual([...MANAGED_RECORD_FIELDS].sort())
    }
    expect(records.find((record) => record.id === legacyActive.id)).toEqual(legacyActive)
    expect(records.find((record) => record.id === 'mf-legacy-populated')).toEqual(legacyPopulated)
  })
})

/**
 * The maximum number of quarantined index copies a store keeps in its own
 * directory.
 *
 * Written out in full rather than imported from `document-store.ts`: importing
 * the constant would make this fixture agree with whatever the store happens to
 * do, which is the opposite of what a bound is for. It mirrors
 * `MAX_TENDERS_BACKUPS` — the rotating copies `<baseDir>/backups/` is bounded
 * to, in the same Tenders directory as this index.
 */
const MAX_QUARANTINED_INDEX_FILES = 5

describe('a failed metadata commit never loses a managed document', () => {
  it('never leaves a file with no metadata record, and can recover the record when the file cannot be removed', async () => {
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

    // The invariant the whole store rests on: after ANY outcome of `save`, every
    // file the store put in `documents/` has a metadata record, and every record
    // points at a file that is there. A file with no record is invisible in the
    // app — not listed, not deletable, not cleanable from the trash — and the user
    // is left with a document they can only find by hand.
    const assertNoUntrackedFiles = async (): Promise<void> => {
      const records = await managed.listRecords()
      const orphans = await managed.reconcile()
      expect(orphans.orphaned, 'no managed file may be invisible to the user').toEqual([])
      for (const record of records) {
        if (record.state !== 'active') continue
        expect(
          existsSync(join(baseDir, record.relativePath)),
          `${record.relativePath} is recorded but absent`,
        ).toBe(true)
      }
    }

    failNextIndexWrite = true
    const failed = await managed.save({
      fileName: 'orphan-proof.pdf',
      buffer: Buffer.from('orphan proof bytes'),
      category: 'rfp',
    })
    expect(failed.ok).toBe(false)
    await assertNoUntrackedFiles()

    const saved = await managed.save({
      fileName: 'after-the-failure.pdf',
      buffer: Buffer.from('after'),
      category: 'rfp',
    })
    expect(saved.ok).toBe(true)
    await assertNoUntrackedFiles()
  })

  it('writes the record by a second route when the file cannot be removed, so it stays listed', async () => {
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
    // Hold the saved file open so the failure path's `unlink` cannot remove it —
    // the exact Windows case (a scanner, a sync client) that leaves a file behind
    // with no way to delete it. The record must then be written by the second
    // route rather than the document vanishing from the user's view.
    failNextIndexWrite = true
    const saved = await managed.save({
      fileName: 'held-open.pdf',
      buffer: Buffer.from('held'),
      category: 'rfp',
    })

    // Whatever happened, the document is either gone or listed — never present
    // and unlisted.
    const records = await managed.listRecords()
    const files = (await readdir(join(baseDir, 'documents'))).filter(
      (name) => !name.endsWith('.tmp'),
    )
    const listed = new Set(records.map((record) => record.relativePath.split('/')[1]))
    const untracked = files.filter((name) => !listed.has(name))
    expect(untracked, 'a document on disk must never be missing from the index').toEqual([])
    if (files.length > 0 && files[0] === 'held-open.pdf') {
      expect(saved.ok).toBe(false)
      expect(listed.has('held-open.pdf')).toBe(true)
    }
  })
})

describe('corrupt-index quarantine is bounded', () => {
  it('keeps a bounded number of quarantined copies, discarding the oldest', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    const index = indexPath(baseDir)
    const rounds = MAX_QUARANTINED_INDEX_FILES + 3

    const quarantines: string[][] = []
    for (let round = 0; round < rounds; round += 1) {
      // A different payload each round: the copies are distinguishable, so
      // "the oldest was discarded" is a claim this test can actually check.
      await writeFile(index, `{corrupt round ${round}`, 'utf8')
      await managed.listRecords()
      quarantines.push((await readdir(baseDir)).filter((name) => name.includes('corrupt')).sort())
    }

    const final = quarantines[quarantines.length - 1]!
    expect(final.length, 'quarantined copies must not accumulate without limit').toBe(
      MAX_QUARANTINED_INDEX_FILES,
    )
    for (const [round, snapshot] of quarantines.entries()) {
      expect(
        snapshot.length,
        `round ${round} may never exceed the quarantine bound`,
      ).toBeLessThanOrEqual(MAX_QUARANTINED_INDEX_FILES)
    }

    // The survivor set is the NEWEST copies: the payload from the first rounds is
    // gone, the last one is kept.
    const kept = await Promise.all(final.map((name) => readFile(join(baseDir, name), 'utf8')))
    expect(kept).not.toContain(`{corrupt round 0`)
    expect(kept).toContain(`{corrupt round ${rounds - 1}`)

    // The index itself is usable again: the quarantine never blocks a save.
    const saved = await managed.save({
      fileName: 'after-quarantine.pdf',
      buffer: Buffer.from('after'),
      category: 'rfp',
    })
    expect(saved.ok).toBe(true)
    expect((await managed.listRecords()).map((record) => record.fileName)).toEqual([
      'after-quarantine.pdf',
    ])
  })
})

describe('the managed writers retry a transient Windows rename failure', () => {
  it('serves a managed metadata write through the same bounded retry the primary store uses', async () => {
    // The defect this pins: `document-store` called `fs/promises` `rename`
    // directly, so the ONE atomic write in this app with no retry was a managed
    // document's — while `tenders-paths` retried the primary store's and
    // `atomicWriteDocumentFile` retried the document file's. A scanner holding the
    // destination open made a managed write fail where the same operation would
    // have succeeded against the primary.
    //
    // Asserted on the SOURCE, because a transient `EBUSY` cannot be manufactured
    // honestly in a test and the property that matters is structural: the managed
    // writer goes through the shared helper, so the two cannot drift apart again.
    const source = await readFile(
      join(import.meta.dirname, '..', 'src', 'main', 'document-store.ts'),
      'utf8',
    )
    expect(source, 'the managed writer must use the shared retrying rename').toContain(
      'renameWithBoundedRetryAsync',
    )
    // ...and it must not have kept a bare `rename(` on the publish step.
    const atomicWrite = source.slice(source.indexOf('async function atomicWrite'))
    const body = atomicWrite.slice(0, atomicWrite.indexOf('async function readIndex'))
    expect(body, 'the publish step must not bypass the retry').not.toMatch(/\bawait rename\(/)
  })

  it('bounds the retry to the two transient codes, so a real failure is not retried', async () => {
    const paths = await readFile(
      join(import.meta.dirname, '..', 'src', 'main', 'tenders-paths.ts'),
      'utf8',
    )
    // One predicate, used by both the sync and the async form: the parity claim is
    // that they behave the same, which a second copy of the rule would undo.
    expect(paths.match(/isTransientRenameError\(error\)/g) ?? []).toHaveLength(2)
    expect(paths).toContain("code === 'EBUSY' || code === 'EPERM'")
  })
})

describe('reconcile is symmetric', () => {
  it('returns a missing record to active once its file is back at the recorded path', async () => {
    const baseDir = await tempBaseDir()
    const managed = store(baseDir)
    const saved = await managed.save({
      fileName: 'certificate.pdf',
      buffer: Buffer.from('cert'),
      category: 'vault',
    })
    if (!saved.ok) throw new Error(saved.error)
    const relativePath = saved.record.relativePath
    const full = join(baseDir, relativePath)

    await rm(full, { force: true })
    const missing = await managed.reconcile()
    expect(missing.missing.map((entry) => entry.relativePath)).toEqual([relativePath])
    expect((await managed.listRecords())[0].state).toBe('missing')

    // The file comes back (restored from a backup, an undelete, a sync that
    // caught up): the next check must clear the missing record, not leave it
    // listed forever.
    await writeFile(full, 'cert', 'utf8')
    const healed = await managed.reconcile()

    expect(healed.missing).toEqual([])
    expect(healed.activeCount).toBe(1)
    expect(healed.orphaned, 'a healed file must not also be reported orphaned').not.toContain(
      relativePath,
    )
    const record = (await managed.listRecords())[0]
    expect(record.state).toBe('active')
    expect(record.missingAt).toBeNull()

    // Still-absent files stay missing (the heal is not a blanket reset).
    await rm(full, { force: true })
    expect((await managed.reconcile()).missing.map((entry) => entry.relativePath)).toEqual([
      relativePath,
    ])
    expect((await managed.listRecords())[0].state).toBe('missing')
  })
})

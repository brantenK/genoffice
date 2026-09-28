// @vitest-environment node

/**
 * Hostile persistence: crash mid-write, disk-full, concurrent writers and
 * backup/restore under all of the above — driven through the REAL IPC
 * handlers (books-main) against a temp store, with node:fs interruption
 * points the atomic writer actually exercises (writeFileSync, renameSync).
 *
 * Pinned contracts:
 * - a stale .tmp (or any partial-state sibling) next to a good ledger must
 *   never be mistaken for the ledger: the next load returns the LAST GOOD
 *   LEDGER, the good file is untouched, and later saves still work;
 * - a disk-full write is REFUSED, the store file stays byte-identical, the
 *   error surfaces, and no empty ledger is ever persisted;
 * - two real module boots hammering one store file never lose an invoice,
 *   never duplicate an invoice number, never regress the revision, and a
 *   stale writer is told about the conflict with the current ledger;
 * - restores keep the pre-restore safety copy restorable, recover (or
 *   coherently refuse) over crashed and disk-full states, and backup files
 *   are never written empty.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { BOOKS_CHANNELS, type BooksDataEnvelope, type SaveDataResult } from '../../src/shared/ipc'
import type { BooksData } from '../../src/shared/types'
import { bootBooksE2E, createUserDataDir, type BooksE2ESession } from './helpers/books-e2e'
import { emptyLedger } from './e2e/fixtures'

vi.mock('electron', async () => {
  const { createElectronModule } = await import('./helpers/electron-mock')
  return createElectronModule()
})

// Disk-failure injection at the two points the atomic writer uses. The flags
// live in vi.hoisted so the hoisted vi.mock factory can read them.
const fsFailure = vi.hoisted(() => ({
  renameFailure: null as Error | null,
  writeFailure: null as Error | null,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs')
  return {
    ...actual,
    default: actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsFailure.writeFailure) throw fsFailure.writeFailure
      return actual.writeFileSync(...args)
    }) as typeof actual.writeFileSync,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      if (fsFailure.renameFailure) throw fsFailure.renameFailure
      return actual.renameSync(...args)
    }) as typeof actual.renameSync,
  }
})

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const ENOSPC = new Error("ENOSPC: no space left on device, write 'books-data.json'")
const EACCES = new Error("EACCES: permission denied, rename 'books-data.json'")

let session: BooksE2ESession

beforeEach(async () => {
  fsFailure.renameFailure = null
  fsFailure.writeFailure = null
  session = await bootBooksE2E()
})

afterEach(() => {
  fsFailure.renameFailure = null
  fsFailure.writeFailure = null
  session?.dispose()
})

async function seedLedgerWithInvoice(): Promise<{
  envelope: BooksDataEnvelope
  stored: BooksData
  bytes: string
}> {
  await expect(session.saveData(emptyLedger())).resolves.toBe(true)
  const issued = session.modules.issueSalesInvoiceInBooks({
    booksDataPath: session.booksDataPath,
    partyName: 'Rand Water Authority',
    itemDescription: 'Bulk water pipeline maintenance',
    amount: 23000,
    date: '2026-08-05',
  })
  expect(issued.ok).toBe(true)
  const bytes = session.readBooksFile()
  return { envelope: session.readStoredData(), stored: JSON.parse(bytes) as BooksData, bytes }
}

function tmpFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    : []
}

/** A realistic stale .tmp: the shape writeFileAtomic leaves behind on a kill. */
function writeStaleTmp(): string {
  const stale = join(session.booksDir, `books-data.json.${Date.now()}.crash01.tmp`)
  writeFileSync(stale, '{"version":1,"settings":{"companyName":"killed mid-write"', 'utf8')
  return stale
}

describe('hostile: crash mid-write (stale .tmp and other partial-state shapes)', () => {
  it('a stale .tmp beside a good ledger is ignored: load returns the last good ledger', async () => {
    const { bytes } = await seedLedgerWithInvoice()
    const stale = writeStaleTmp()
    // More partial-state shapes the atomic writer can leave behind: a
    // half-written safety copy tmp and an orphan forensic tmp.
    writeFileSync(join(session.booksDir, `books-data.json.bak.${Date.now()}.tmp`), '{"bak":', 'utf8')
    writeFileSync(
      join(session.booksDir, `books-data.json.corrupt-abc123.${Date.now()}.tmp`),
      '{"corrupt":',
      'utf8',
    )

    const loaded = await session.loadData()
    expect(loaded, 'the last good ledger loads, never an empty ledger').toBeTruthy()
    expect(loaded!.invoices).toHaveLength(1)
    expect(loaded!.invoices[0].partyName).toBe('Rand Water Authority')
    expect(session.readBooksFile()).toBe(bytes) // the load never touched the good file
    expect(existsSync(stale), 'the stale tmp itself is left for forensics').toBe(true)
  })

  it('saving over a crashed-write state still works and the store stays valid', async () => {
    await seedLedgerWithInvoice()
    writeStaleTmp()
    const loaded = (await session.loadData())!
    const next: BooksDataEnvelope = {
      ...loaded,
      settings: { ...loaded.settings, companyName: 'Crashed Then Saved (Pty) Ltd' },
    }
    const save = await session.saveDataResult(next, loaded.revision)
    expect(save.ok, save.ok ? '' : save.error).toBe(true)
    const stored = session.readStoredData()
    expect(stored.settings.companyName).toBe('Crashed Then Saved (Pty) Ltd')
    expect(stored.invoices).toHaveLength(1) // nothing lost to the stale tmp
    expect(tmpFiles(session.booksDir).length).toBeGreaterThan(0) // the stale tmps remain harmless
  })

  it('a mid-write kill (tmp present, rename never ran) recovers to the pre-write ledger', async () => {
    const { bytes } = await seedLedgerWithInvoice()
    const loaded = (await session.loadData())!
    // The write starts: the tmp is fully written, then the process dies before
    // the rename. Next boot: the pre-write ledger, not the new one, not empty.
    fsFailure.renameFailure = new Error('process killed between tmp-write and rename')
    const attempted = await session.saveDataResult(
      { ...loaded, settings: { ...loaded.settings, companyName: 'Doomed Write (Pty) Ltd' } },
      loaded.revision,
    )
    fsFailure.renameFailure = null
    expect(attempted.ok).toBe(false) // the throw surfaced as a refused write
    expect(session.readBooksFile()).toBe(bytes) // byte-identical pre-write ledger
    const recovered = await session.loadData()
    expect(recovered!.invoices).toHaveLength(1)
    expect(recovered!.invoices[0].partyName).toBe('Rand Water Authority')
    // A retry after the crash succeeds normally.
    const retry = await session.saveDataResult(
      { ...recovered!, settings: { ...recovered!.settings, companyName: 'Recovered (Pty) Ltd' } },
      recovered!.revision,
    )
    expect(retry.ok).toBe(true)
    expect(session.readStoredData().settings.companyName).toBe('Recovered (Pty) Ltd')
  })
})

describe('hostile: disk-full and permission failures', () => {
  it('ENOSPC on the atomic rename refuses the save and keeps the file byte-identical', async () => {
    const { bytes, envelope } = await seedLedgerWithInvoice()
    const before = readdirSync(session.booksDir).length
    fsFailure.renameFailure = ENOSPC

    const save = await session.saveDataResult(
      { ...envelope, settings: { ...envelope.settings, companyName: 'Never Landed (Pty) Ltd' } },
      envelope.revision,
    )
    fsFailure.renameFailure = null
    expect(save.ok).toBe(false)
    expect(save.ok ? '' : save.error).toMatch(/space|ENOSPC|no space/i)
    expect(session.readBooksFile()).toBe(bytes) // byte-identical: nothing truncated, nothing emptied
    expect(readdirSync(session.booksDir).length).toBe(before) // no stray tmps, no new files

    // The store is still perfectly readable and a later save lands.
    const loaded = await session.loadData()
    expect(loaded!.invoices).toHaveLength(1)
    const retry = await session.saveDataResult(
      { ...loaded!, settings: { ...loaded!.settings, companyName: 'After Crash (Pty) Ltd' } },
      loaded!.revision,
    )
    expect(retry.ok).toBe(true)
  })

  it('ENOSPC on the tmp write itself refuses the save and leaves no partial tmp', async () => {
    const { bytes, envelope } = await seedLedgerWithInvoice()
    fsFailure.writeFailure = ENOSPC
    const save = await session.saveDataResult(
      { ...envelope, settings: { ...envelope.settings, companyName: 'No Tmp (Pty) Ltd' } },
      envelope.revision,
    )
    fsFailure.writeFailure = null
    expect(save.ok).toBe(false)
    expect(session.readBooksFile()).toBe(bytes)
    expect(tmpFiles(session.booksDir)).toEqual([]) // the failed tmp was cleaned up
  })

  it('an EACCES rename is refused with a readable error and the ledger intact', async () => {
    const { bytes, envelope } = await seedLedgerWithInvoice()
    fsFailure.renameFailure = EACCES
    const save = await session.saveDataResult(
      { ...envelope, settings: { ...envelope.settings, companyName: 'Denied (Pty) Ltd' } },
      envelope.revision,
    )
    fsFailure.renameFailure = null
    expect(save.ok).toBe(false)
    expect(save.ok ? '' : save.error).toMatch(/denied|EACCES|permission/i)
    expect(session.readBooksFile()).toBe(bytes)
    expect((await session.loadData())!.invoices).toHaveLength(1)
  })

  it('a disk-full backup refuses with an error; the ledger and its backups are untouched', async () => {
    const { bytes } = await seedLedgerWithInvoice()
    const backupsDir = join(session.booksDir, 'backups')
    fsFailure.writeFailure = ENOSPC
    const backup = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.backupNow,
    )
    fsFailure.writeFailure = null
    expect(backup.ok).toBe(false)
    expect(backup.error ?? '').toMatch(/space|ENOSPC|no space/i)
    expect(session.readBooksFile()).toBe(bytes)
    expect(existsSync(backupsDir) ? readdirSync(backupsDir).filter((n) => n.endsWith('.json')) : []).toEqual([])
  })

  it('an EACCES restore is refused and the live ledger stays byte-identical', async () => {
    const { bytes } = await seedLedgerWithInvoice()
    const backup = await session.invoke<{ ok: boolean; path?: string }>(BOOKS_CHANNELS.backupNow)
    expect(backup.ok).toBe(true)
    fsFailure.renameFailure = EACCES
    const restored = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.restoreBackup,
      backup.path!.replace(/^.*[/\\]/, ''),
    )
    fsFailure.renameFailure = null
    expect(restored.ok).toBe(false)
    expect(session.readBooksFile()).toBe(bytes)
  })
})

describe('hostile: concurrent writers on one store file', () => {
  it('interleaved real writers: no lost invoice, unique numbers, monotonic revision, conflicts reported', async () => {
    const userDataDir = createUserDataDir()
    const a = await bootBooksE2E({ userDataDir })
    const b = await bootBooksE2E({ userDataDir })
    try {
      expect(a.booksDataPath).toBe(b.booksDataPath)
      expect(await a.saveData(emptyLedger())).toBe(true)

      // B starts from the shared baseline; A hammers internal writes.
      let bLedger = (await b.loadData())!
      const bRevision = bLedger.revision
      const bParties = new Set(bLedger.parties.map((p) => p.name))

      for (let round = 0; round < 10; round += 1) {
        // A: a real internal posting (numbered by the shared numbering engine).
        const issued = a.modules.issueSalesInvoiceInBooks({
          booksDataPath: a.booksDataPath,
          partyName: `Interleave A ${round}`,
          itemDescription: 'Round work',
          amount: 1000 + round,
          date: '2026-08-05',
        })
        expect(issued.ok).toBe(true)

        // B: a full-ledger save built from ITS snapshot (a party + invoice),
        // sent from the revision B last saw — the realistic stale client.
        const partyName = `Interleave B ${round}`
        const next: BooksData = {
          ...bLedger,
          settings: { ...bLedger.settings },
          parties: [
            ...bLedger.parties,
            {
              id: `party-b-${round}`,
              name: partyName,
              type: 'Customer',
              outstandingBalance: 0,
            },
          ],
          invoices: [
            ...bLedger.invoices,
            {
              id: `inv-b-${round}`,
              invoiceNumber: `INV-9999-${String(round).padStart(3, '0')}`,
              type: 'Sales',
              partyId: `party-b-${round}`,
              partyName,
              date: '2026-08-06',
              dueDate: '2026-08-06',
              items: [],
              subtotal: 500,
              taxTotal: 75,
              grandTotal: 575,
              outstandingAmount: 575,
              status: 'Unpaid',
              createdAt: '2026-08-06T00:00:00.000Z',
              updatedAt: '2026-08-06T00:00:00.000Z',
            },
          ],
        }
        const attempted: SaveDataResult = await b.saveDataResult(next, bLedger.revision)
        if (attempted.ok) {
          bLedger = (await b.loadData())!
        } else {
          // The conflict must be REPORTED, carrying the ledger that won.
          expect(attempted.conflict).toBe(true)
          expect(attempted.current).toBeTruthy()
          bLedger = attempted.current!
          bLedger = {
            ...bLedger,
            parties: [
              ...bLedger.parties,
              {
                id: `party-b-${round}`,
                name: partyName,
                type: 'Customer',
                outstandingBalance: 0,
              },
            ],
            invoices: [
              ...bLedger.invoices,
              {
                id: `inv-b-${round}`,
                invoiceNumber: `INV-9999-${String(round).padStart(3, '0')}`,
                type: 'Sales',
                partyId: `party-b-${round}`,
                partyName,
                date: '2026-08-06',
                dueDate: '2026-08-06',
                items: [],
                subtotal: 500,
                taxTotal: 75,
                grandTotal: 575,
                outstandingAmount: 575,
                status: 'Unpaid',
                createdAt: '2026-08-06T00:00:00.000Z',
                updatedAt: '2026-08-06T00:00:00.000Z',
              },
            ],
          }
          const reapplied = await b.saveDataResult(bLedger, bLedger.revision)
          expect(reapplied.ok, reapplied.ok ? '' : reapplied.error).toBe(true)
          bLedger = (await b.loadData())!
        }
      }

      // Interleaved real import from A while B holds a stale snapshot: the
      // import lands (A is the live main-process path).
      await a.invoke(BOOKS_CHANNELS.importBankStatementCsv, 'Date,Description,Reference,Amount\n2026-08-07,"EFT interleave","",250.00\n')
      const stored = a.readStoredData()

      // No lost invoice: all 10 of A's + all 10 of B's, uniquely numbered.
      const numbers = stored.invoices.map((i) => i.invoiceNumber)
      expect(numbers.filter((n) => n.startsWith('INV-2026-')).length).toBe(10)
      expect(numbers.filter((n) => n.startsWith('INV-9999-')).length).toBe(10)
      expect(new Set(numbers).size).toBe(numbers.length)
      const storedPartyNames = new Set(stored.parties.map((p) => p.name))
      for (const name of bParties) {
        expect(storedPartyNames.has(name), `party ${name} must survive the interleaving`).toBe(
          true,
        )
      }
      // Revision monotonic per observation, and at least the 20 increments.
      expect(stored.revision).toBeGreaterThanOrEqual(bRevision + 20)
      // The store is still a balanced, complete ledger.
      expect(stored.journalEntries.every((j) => j.totalDebit === j.totalCredit)).toBe(true)
      const storedA = await a.loadData()
      expect(storedA!.invoices.length).toBe(stored.invoices.length)
    } finally {
      a.dispose()
      b.dispose()
    }
  })
})

describe('hostile: backup and restore under the above', () => {
  it('restore keeps the pre-restore safety copy restorable, and the undo restores back', async () => {
    const { envelope } = await seedLedgerWithInvoice()
    const beforeBytes = session.readBooksFile()
    const backup = await session.invoke<{ ok: true; path: string }>(BOOKS_CHANNELS.backupNow)
    expect(backup.ok).toBe(true)

    // Mutate the live ledger after the backup.
    const next: BooksDataEnvelope = {
      ...envelope,
      settings: { ...envelope.settings, companyName: 'Mutated After Backup (Pty) Ltd' },
    }
    expect(await session.saveDataResult(next, envelope.revision)).toMatchObject({ ok: true })
    expect(session.readStoredData().invoices).toHaveLength(1)

    const backupName = backup.path.replace(/^.*[/\\]/, '')
    const restored = await session.invoke<{ ok: true }>(BOOKS_CHANNELS.restoreBackup, backupName)
    expect(restored.ok).toBe(true)

    // The pre-restore safety copy holds the mutated ledger and is restorable
    // in turn — the undo of the undo.
    const listed = await session.invoke<{ name: string; kind: string }[]>(
      BOOKS_CHANNELS.listBackups,
    )
    const safety = listed.filter((l) => l.kind === 'safety-copy')
    expect(safety.length).toBeGreaterThan(0)
    const undo = await session.invoke<{ ok: true }>(
      BOOKS_CHANNELS.restoreBackup,
      safety[0].name,
    )
    expect(undo.ok).toBe(true)
    expect(session.readStoredData().settings.companyName).toBe('Mutated After Backup (Pty) Ltd')
    expect(session.readBooksFile()).not.toBe(beforeBytes) // back to the mutated state, not the backup
  })

  it('restoring over a crashed/corrupt store recovers it and keeps the corrupt bytes restorable', async () => {
    await seedLedgerWithInvoice()
    const backup = await session.invoke<{ ok: true; path: string }>(BOOKS_CHANNELS.backupNow)
    expect(backup.ok).toBe(true)

    // Crash-shaped store: a good file replaced with half-written JSON.
    const corrupt = '{"version":1,"settings":{"companyName":"Branten"'
    session.writeBooksFile(corrupt)
    expect((await session.loadDataResult()).readable).toBe(false)

    const backupName = backup.path.replace(/^.*[/\\]/, '')
    const restored = await session.invoke<{ ok: true }>(BOOKS_CHANNELS.restoreBackup, backupName)
    expect(restored.ok).toBe(true)
    const recovered = session.readStoredData()
    expect(recovered.invoices).toHaveLength(1)
    expect(recovered.auditLog.some((entry) => entry.action === 'backup.restore')).toBe(true)

    // The corrupt bytes were safety-copied before the replace: the forensic
    // trail of what was there is restorable in turn.
    const listed = await session.invoke<{ name: string; kind: string }[]>(
      BOOKS_CHANNELS.listBackups,
    )
    const safety = listed.filter((l) => l.kind === 'safety-copy')
    expect(safety.length).toBeGreaterThan(0)
    const preRestoreBytes = readFileSync(
      join(session.booksDir, 'backups', safety[0].name),
      'utf8',
    )
    expect(preRestoreBytes).toBe(corrupt)
  })

  it('a corrupt backup is never restored and the live ledger is untouched', async () => {
    const { bytes } = await seedLedgerWithInvoice()
    const backupsDir = join(session.booksDir, 'backups')
    mkdirSync(backupsDir, { recursive: true })
    writeFileSync(join(backupsDir, 'books-backup-20260928-120000.json'), '{"nonsense":true}', 'utf8')
    const restored = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.restoreBackup,
      'books-backup-20260928-120000.json',
    )
    expect(restored.ok).toBe(false)
    expect(restored.error ?? '').toMatch(/ledger|missing accounts/i)
    expect(session.readBooksFile()).toBe(bytes)
  })

  it('backups are never written empty — including after a crash-shaped store', async () => {
    await seedLedgerWithInvoice()
    writeStaleTmp()
    const backup = await session.invoke<{ ok: true; path: string }>(BOOKS_CHANNELS.backupNow)
    expect(backup.ok).toBe(true)
    const content = readFileSync(backup.path!, 'utf8')
    expect(content.length).toBeGreaterThan(2)
    expect(JSON.parse(content).invoices).toHaveLength(1)

    // A second backup within the same second must not collide or truncate.
    const second = await session.invoke<{ ok: true; path: string }>(BOOKS_CHANNELS.backupNow)
    expect(second.ok).toBe(true)
    expect(second.path).not.toBe(backup.path)
    expect(readFileSync(second.path!, 'utf8').length).toBeGreaterThan(2)
    // Every backup on disk is non-empty, parseable JSON.
    for (const name of readdirSync(join(session.booksDir, 'backups'))) {
      const stat = statSync(join(session.booksDir, 'backups', name))
      expect(stat.size, `${name} must not be empty`).toBeGreaterThan(2)
    }
  })
})

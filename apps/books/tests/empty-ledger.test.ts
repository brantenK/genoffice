/**
 * Empty-ledger reachability and the rules around it (D1/D2).
 *
 * Two defects are pinned here, and they pull in opposite directions:
 *
 *  - the shrink guard had grown into a dead end: the last invoice could not be
 *    deleted, a deliberately empty backup could not be restored, and the only
 *    thing the user was told was developer prose;
 *  - the guard still has to stop an ACCIDENTAL empty write, so a stale payload
 *    and a payload whose records the migration drops must both stay refused.
 *
 * The journeys below run the real renderer action and the real `books:*`
 * handlers against a temp `userData` directory, and check the bytes on disk —
 * not just the result code.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOOKS_CHANNELS,
  validateRestoreName,
  validateSaveIntent,
  type BackupFileInfo,
  type BooksApi,
  type LoadDataResult,
  type RestoreBackupResult,
  type SaveDataResult,
} from '../src/shared/ipc'
import { useBooksStore } from '../src/renderer/src/store'
import type { Invoice } from '../src/shared/types'
import { bootBooksE2E, type BooksE2ESession } from './helpers/books-e2e'
import { emptyLedger } from './e2e/fixtures'

vi.mock('electron', async () => {
  const { createElectronModule } = await import('./helpers/electron-mock')
  return createElectronModule()
})

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/**
 * The renderer's own bridge to the booted main process: every call goes through
 * the real `books:*` handler the preload bridge reaches.
 */
function bridgeTo(session: BooksE2ESession): BooksApi {
  const unsupported = async () => {
    throw new Error('not used by this test')
  }
  return {
    loadData: () => session.invoke<LoadDataResult>(BOOKS_CHANNELS.loadData),
    saveData: (data, revision, intent) =>
      session.invoke<SaveDataResult>(BOOKS_CHANNELS.saveData, data, revision, intent),
    onDataChanged: () => () => undefined,
    exportToSheets: async () => ({ ok: true }),
    openInPdf: async () => ({ ok: true }),
    openInCrm: async () => false,
    openInTenders: async () => false,
    importBankStatementCsv: unsupported,
    reconcileTransaction: unsupported,
    getSettlementSuggestions: async () => [],
    backupNow: () => session.invoke(BOOKS_CHANNELS.backupNow),
    listBackups: () => session.invoke<BackupFileInfo[]>(BOOKS_CHANNELS.listBackups),
    restoreBackup: (name) =>
      session.invoke<RestoreBackupResult>(BOOKS_CHANNELS.restoreBackup, name),
  }
}

describe('empty ledger: the user can delete their last record (D1)', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
    // Drive the real renderer actions over the real handlers.
    window.booksApi = bridgeTo(session)
  })

  afterEach(() => {
    window.booksApi = undefined
    session?.dispose()
  })

  it('empties the books when the last POSTED invoice is deleted', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const stored = session.readStoredData()
    expect(stored.invoices).toHaveLength(1)
    expect(stored.journalEntries).toHaveLength(1)

    await useBooksStore.getState().loadData()
    await useBooksStore.getState().deleteInvoice(useBooksStore.getState().data.invoices[0].id)

    expect(useBooksStore.getState().lastError).toBeNull()
    const after = session.readStoredData()
    expect(after.invoices).toEqual([])
    expect(after.journalEntries).toEqual([])
    expect(after.revision).toBeGreaterThan(stored.revision)
    // The delete is still an audited event, on an otherwise empty ledger.
    expect(after.auditLog?.[0]?.action).toBe('invoice.delete')
    // ...and the renderer is showing the empty ledger it actually saved.
    expect(useBooksStore.getState().data.invoices).toEqual([])
  })

  it('empties the books when the last DRAFT invoice is deleted', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    await useBooksStore.getState().loadData()
    await useBooksStore.getState().saveInvoice({
      type: 'Sales',
      partyName: 'Draft Customer',
      status: 'Draft',
      items: [
        { id: 'it-1', description: 'Quoted work', qty: 1, rate: 5000, taxRate: 15, amount: 5000 },
      ],
    })
    const drafted = session.readStoredData()
    expect(drafted.invoices).toHaveLength(1)
    // A draft posts nothing, so the ledger holds no journals at all.
    expect(drafted.journalEntries).toEqual([])

    await useBooksStore.getState().deleteInvoice(useBooksStore.getState().data.invoices[0].id)

    expect(useBooksStore.getState().lastError).toBeNull()
    const after = session.readStoredData()
    expect(after.invoices).toEqual([])
    expect(after.journalEntries).toEqual([])
  })

  it('leaves no dead end behind: the emptied ledger accepts new records', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    await useBooksStore.getState().loadData()
    await useBooksStore.getState().saveInvoice({
      type: 'Sales',
      partyName: 'Draft Customer',
      status: 'Draft',
      items: [
        { id: 'it-1', description: 'Quoted work', qty: 1, rate: 5000, taxRate: 15, amount: 5000 },
      ],
    })
    await useBooksStore.getState().deleteInvoice(useBooksStore.getState().data.invoices[0].id)
    expect(session.readStoredData().invoices).toEqual([])

    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work after clearing the books',
      amount: 11500,
      date: '2026-08-06',
    })
    expect(issued.ok).toBe(true)
    expect(session.readStoredData().invoices).toHaveLength(1)
  })
})

describe('empty ledger: the guard still refuses an accidental empty write', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  /** A populated ledger: one posted invoice and its journal. */
  const populate = async (): Promise<string> => {
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    return session.readBooksFile()
  }

  it('refuses a stale payload that would empty the books, even with a reason attached', async () => {
    await populate()
    const snapshot = (await session.loadData())!
    const staleRevision = snapshot.revision

    // Another writer moves the store on, so the snapshot is now stale.
    const current = session.readStoredData()
    expect(
      await session.saveData({
        ...current,
        settings: { ...current.settings, companyName: 'Renamed Co' },
      }),
    ).toBe(true)
    const newerRevision = session.readStoredData().revision
    expect(newerRevision).toBeGreaterThan(staleRevision)
    const newerBytes = session.readBooksFile()

    // The reason does not turn the staleness check into a formality: a client
    // that never saw the newer ledger is refused, intent and all.
    const refused = await session.invoke<SaveDataResult>(
      BOOKS_CHANNELS.saveData,
      { ...snapshot, invoices: [], journalEntries: [] },
      staleRevision,
      { emptyLedger: 'user-deleted-last-record' },
    )
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('the stale empty write must not be accepted')
    expect(refused.conflict).toBe(true)
    expect(refused.current?.revision).toBe(newerRevision)
    expect(session.readBooksFile()).toBe(newerBytes)

    // The store the client is handed is a ledger it can act on: deleting from
    // THAT revision is the write that lands. The payload is the one the
    // renderer's delete produces — records gone, balances re-derived from the
    // journals it kept.
    const adopted = refused.current!
    const landed = await session.invoke<SaveDataResult>(
      BOOKS_CHANNELS.saveData,
      session.modules.recomputeLedger({ ...adopted, invoices: [], journalEntries: [] }),
      adopted.revision,
      { emptyLedger: 'user-deleted-last-record' },
    )
    expect(landed).toMatchObject({ ok: true })
    const after = session.readStoredData()
    expect(after.invoices).toEqual([])
    expect(after.journalEntries).toEqual([])
    expect(session.modules.ledgerRecordCount(after)).toBe(0)
  })

  it('refuses a payload of decoy records the migration would drop (D5)', async () => {
    const before = await populate()
    const revision = session.readStoredData().revision

    // Raw arrays that look populated, every entry lacking a string id: the
    // migration keeps none of them. Counting what was SENT is what let this
    // empty the file; counting what the migration KEEPS refuses it.
    const decoys = {
      ...session.readStoredData(),
      invoices: [{ id: 42, invoiceNumber: 'INV-2026-009' }, { decoy: true }],
      journalEntries: [{ id: null, items: [] }, { entryNumber: 'JE-2026-009' }],
    }
    const outcome = session.modules.writeBooksStore(session.booksDataPath, decoys, {
      expectedRevision: revision,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.error).toMatch(/Nothing was saved/)
    expect(session.readBooksFile()).toBe(before)
    expect(session.readStoredData().invoices).toHaveLength(1)
  })

  it('refuses a save that says nothing about emptying the books', async () => {
    const before = await populate()
    const current = (await session.loadData())!

    const refused = await session.invoke<SaveDataResult>(
      BOOKS_CHANNELS.saveData,
      { ...current, invoices: [], journalEntries: [] },
      current.revision,
    )
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error).toMatch(/Nothing was saved/)
    expect(session.readBooksFile()).toBe(before)
  })

  it('refuses a save intent this channel may not carry', async () => {
    const before = await populate()
    const current = (await session.loadData())!
    const empty = { ...current, invoices: [], journalEntries: [] }

    const payloads: unknown[] = [
      { emptyLedger: 'user-restored-empty-backup' },
      { emptyLedger: 'please' },
      { emptyLedger: true },
      { emptyLedger: 'user-deleted-last-record', extra: true },
      { somethingElse: true },
      'yes',
      42,
      [],
    ]
    for (const intent of payloads) {
      const refused = await session.invoke<SaveDataResult>(
        BOOKS_CHANNELS.saveData,
        empty,
        current.revision,
        intent,
      )
      expect(refused.ok, JSON.stringify(intent)).toBe(false)
      expect(refused.ok ? '' : refused.error, JSON.stringify(intent)).toBeTruthy()
    }
    // Not one of them wrote anything.
    expect(session.readBooksFile()).toBe(before)
    expect(session.readStoredData().invoices).toHaveLength(1)
  })

  it('tells the user what happened and what to do, in prose', async () => {
    await populate()
    const current = (await session.loadData())!

    const refused = await session.invoke<SaveDataResult>(
      BOOKS_CHANNELS.saveData,
      { ...current, invoices: [], journalEntries: [] },
      current.revision,
    )
    expect(refused.ok).toBe(false)
    const message = refused.ok ? '' : refused.error

    // The refusal is read by a person: not "Refusing to replace a ledger with 2
    // records with an empty one", and nothing that leaks the guard's internals.
    expect(message).not.toMatch(/Refusing/)
    expect(message).not.toMatch(/revision|schema|payload|record count|undefined|null/i)
    expect(message).toMatch(/^[A-Z][^.!?]*[.!?]/)
    expect(message.trim().split(/\s+/).length).toBeGreaterThan(12)
    // What happened, that nothing was written, and what to do next.
    expect(message).toMatch(/Nothing was saved/)
    expect(message).toMatch(/Reload/)
    expect(message).toMatch(/invoices and journal entries/)
  })

  it('speaks about a single record without pretending there are two', async () => {
    // A ledger holding exactly one record: a draft invoice, and no journals
    // because a draft posts nothing.
    const draft: Invoice = {
      id: 'inv-draft-1',
      invoiceNumber: 'INV-2026-001',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'Draft Customer',
      date: '2026-08-05',
      dueDate: '2026-09-05',
      items: [],
      subtotal: 0,
      taxTotal: 0,
      grandTotal: 0,
      outstandingAmount: 0,
      status: 'Draft',
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    }
    expect(await session.saveData({ ...emptyLedger(), invoices: [draft] })).toBe(true)
    const current = (await session.loadData())!
    expect(current.invoices).toHaveLength(1)
    expect(current.journalEntries).toEqual([])

    const refused = await session.invoke<SaveDataResult>(
      BOOKS_CHANNELS.saveData,
      { ...current, invoices: [], journalEntries: [] },
      current.revision,
    )
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error).toMatch(/1 invoice or journal entry/)
  })
})

describe('empty ledger: an intentionally empty backup restores (D1)', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('restores an empty backup over a populated ledger and keeps the way back', async () => {
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const populatedBytes = session.readBooksFile()

    mkdirSync(session.backupsDir, { recursive: true })
    const name = 'books-backup-20260101-000000.json'
    writeFileSync(join(session.backupsDir, name), JSON.stringify(emptyLedger()), 'utf8')

    const restored = await session.invoke<RestoreBackupResult>(BOOKS_CHANNELS.restoreBackup, name)
    expect(restored.ok).toBe(true)
    expect(session.readStoredData().invoices).toEqual([])
    expect(session.readStoredData().journalEntries).toEqual([])

    // The populated books are not lost: they are the pre-restore safety copy,
    // and restoring that copy brings them back through the same channel.
    const copies = session
      .listFiles(session.backupsDir)
      .filter((file) => file.startsWith('pre-restore-'))
    expect(copies).toHaveLength(1)
    expect(readFileSync(join(session.backupsDir, copies[0]), 'utf8')).toBe(populatedBytes)

    const undone = await session.invoke<RestoreBackupResult>(
      BOOKS_CHANNELS.restoreBackup,
      copies[0],
    )
    expect(undone.ok).toBe(true)
    expect(session.readStoredData().invoices).toHaveLength(1)
  })

  it('still refuses a backup that is not a books ledger, writing nothing', async () => {
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const before = session.readBooksFile()

    mkdirSync(session.backupsDir, { recursive: true })
    writeFileSync(join(session.backupsDir, 'books-backup-20260101-000000.json'), '[]', 'utf8')
    const notALedger = await session.invoke<RestoreBackupResult>(
      BOOKS_CHANNELS.restoreBackup,
      'books-backup-20260101-000000.json',
    )
    expect(notALedger.ok).toBe(false)
    expect(session.readBooksFile()).toBe(before)
  })
})

describe('empty ledger: restore names stay inside the backups directory (D2)', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('rejects traversal, absolute and wildcard pre-restore names', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    mkdirSync(session.backupsDir, { recursive: true })
    // A real safety copy one level up, and a real one inside: neither may be
    // reached by a name that is not a plain file name.
    writeFileSync(
      join(session.booksDir, 'pre-restore-20260101-000000.json'),
      JSON.stringify(emptyLedger({ companyName: 'Escaped Co' })),
      'utf8',
    )
    writeFileSync(
      join(session.backupsDir, 'pre-restore-20260101-000000.json'),
      JSON.stringify(emptyLedger({ companyName: 'Inside Co' })),
      'utf8',
    )
    const before = session.readBooksFile()

    const hostile = [
      '../pre-restore-20260101-000000.json',
      '..\\pre-restore-20260101-000000.json',
      'backups/pre-restore-20260101-000000.json',
      'backups\\pre-restore-20260101-000000.json',
      'C:\\books\\backups\\pre-restore-20260101-000000.json',
      'C:pre-restore-20260101-000000.json',
      '/pre-restore-20260101-000000.json',
      '..',
      'pre-restore-*.json',
      'pre-restore-20260101-00000?.json',
      'pre-restore-[0-9]*.json',
      'pre-restore-20260101-000000.txt',
      'evil.json',
      'books-data.json',
      '',
    ]
    for (const name of hostile) {
      const rejected = await session.invoke<RestoreBackupResult>(BOOKS_CHANNELS.restoreBackup, name)
      expect(rejected.ok, name).toBe(false)
      expect(rejected.error, name).toBeTruthy()
    }
    // Not the escaped file, not the store, not the safety copy inside: none of
    // those names reached a file.
    expect(session.readBooksFile()).toBe(before)
    expect(session.readStoredData().settings.companyName).not.toBe('Escaped Co')

    // The same rules as a value: the guard refuses what it cannot resolve.
    for (const name of hostile) {
      expect(validateRestoreName(name).ok, name).toBe(false)
    }
    expect(validateRestoreName('pre-restore-20260101-000000.json')).toEqual({
      ok: true,
      value: 'pre-restore-20260101-000000.json',
    })
    expect(validateRestoreName('books-backup-20260101-000000.json').ok).toBe(true)
    // Widening the prefix is not enough: it is still a name this app writes.
    expect(validateRestoreName('pre-restore-anything.txt').ok).toBe(false)
  })

  it('lists the safety copies the backup engine really wrote, and restores one', async () => {
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const populatedBytes = session.readBooksFile()

    const created = await session.invoke<{ ok: boolean; path?: string }>(BOOKS_CHANNELS.backupNow)
    expect(created.ok).toBe(true)

    // Restore the backup over the live store, which safety-copies it first.
    const restored = await session.invoke<RestoreBackupResult>(
      BOOKS_CHANNELS.restoreBackup,
      created.path!.replace(/[/\\]/g, '/').split('/').pop()!,
    )
    expect(restored.ok).toBe(true)

    const listed = await session.invoke<BackupFileInfo[]>(BOOKS_CHANNELS.listBackups)
    const safetyCopies = listed.filter((entry) => entry.kind === 'safety-copy')
    const backups = listed.filter((entry) => entry.kind !== 'safety-copy')
    expect(backups).toHaveLength(1)
    expect(safetyCopies).toHaveLength(1)
    expect(safetyCopies[0].name).toMatch(/^pre-restore-\d{8}-\d{6}/)
    expect(safetyCopies[0].path).toBe(join(session.backupsDir, safetyCopies[0].name))
    // Newest first across both kinds.
    expect(listed.map((entry) => entry.modifiedAt)).toEqual(
      [...listed]
        .map((entry) => entry.modifiedAt)
        .sort()
        .reverse(),
    )

    // The safety copy holds the ledger the restore replaced, and restoring it
    // is the undo the backup dialogue promises.
    expect(readFileSync(safetyCopies[0].path, 'utf8')).toBe(populatedBytes)
    const undone = await session.invoke<RestoreBackupResult>(
      BOOKS_CHANNELS.restoreBackup,
      safetyCopies[0].name,
    )
    expect(undone.ok).toBe(true)
    expect(session.readStoredData().invoices).toHaveLength(1)
    expect(session.readStoredData().journalEntries).toHaveLength(1)
  })
})

describe('empty ledger: refusing to be emptied is decided by the caller', () => {
  it('accepts only the reason the save channel may carry', () => {
    expect(validateSaveIntent(undefined)).toEqual({ ok: true, value: {} })
    expect(validateSaveIntent(null)).toEqual({ ok: true, value: {} })
    expect(validateSaveIntent({})).toEqual({ ok: true, value: {} })
    expect(validateSaveIntent({ emptyLedger: 'user-deleted-last-record' })).toEqual({
      ok: true,
      value: { emptyLedger: 'user-deleted-last-record' },
    })
    // A restore states its own reason inside the main process, never here.
    expect(validateSaveIntent({ emptyLedger: 'user-restored-empty-backup' }).ok).toBe(false)
    expect(validateSaveIntent({ emptyLedger: 'anything-else' }).ok).toBe(false)
    expect(validateSaveIntent({ emptyLedger: true }).ok).toBe(false)
    expect(validateSaveIntent({ emptyLedger: 'user-deleted-last-record', more: 1 }).ok).toBe(false)
    expect(validateSaveIntent({ more: 1 }).ok).toBe(false)
    expect(validateSaveIntent([]).ok).toBe(false)
    expect(validateSaveIntent('user-deleted-last-record').ok).toBe(false)
  })
})

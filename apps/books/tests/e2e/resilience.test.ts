// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { BOOKS_CHANNELS } from '../../src/shared/ipc'
import {
  allJournalsBalanced,
  calculateInvoiceTotals,
  computeAccountBalances,
  createSalesInvoiceJournal,
  nextInvoiceNumber,
  recomputePartyBalances,
} from '../../src/shared/accounting'
import type {
  BooksData,
  BooksDataEnvelope,
  Invoice,
  Party,
  SettlementSuggestion,
} from '../../src/shared/types'
import { bootBooksE2E, createUserDataDir, type BooksE2ESession } from '../helpers/books-e2e'
import { emptyLedger } from './fixtures'

vi.mock('electron', async () => {
  const { createElectronModule } = await import('../helpers/electron-mock')
  return createElectronModule()
})

// Booting the real module re-imports its whole graph; the shared runner is
// slow under parallel load, so these journeys get more room than the unit suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const CORRUPT_BYTES = '{"version":1,"settings":{"companyName":"Branten Solutions (Pty) Ltd"'

function accountBalance(data: BooksDataEnvelope | BooksData, id: string): number {
  return data.accounts.find((account) => account.id === id)?.balance ?? Number.NaN
}

/** The renderer's invoice-save shape: post a journal for a new invoice and derive balances. */
function postSalesInvoiceFromSnapshot(
  snapshot: BooksData,
  partyName: string,
  inclusiveAmount: number,
  date: string,
): BooksData {
  const party: Party = {
    id: `party-${partyName
      .toLowerCase()
      .replace(/[^a-z]/g, '')
      .slice(0, 8)}`,
    name: partyName,
    type: 'Customer',
    outstandingBalance: 0,
  }
  const items: Invoice['items'] = [
    {
      id: `item-${party.id}`,
      itemCode: 'COMMERCIAL-DELIVERY',
      description: 'Commercial delivery',
      accountId: 'acc-sales',
      accountName: 'Sales',
      qty: 1,
      rate: inclusiveAmount,
      taxRate: 15,
      amount: inclusiveAmount,
    },
  ]
  const totals = calculateInvoiceTotals(items, { taxInclusive: true })
  const now = new Date().toISOString()
  const invoice: Invoice = {
    id: `inv-${party.id}`,
    invoiceNumber: nextInvoiceNumber(snapshot.invoices, 'Sales', date),
    type: 'Sales',
    partyId: party.id,
    partyName,
    date,
    dueDate: date,
    items,
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    outstandingAmount: totals.grandTotal,
    status: 'Unpaid',
    createdAt: now,
    updatedAt: now,
  }
  const invoices = [invoice, ...snapshot.invoices]
  const journalEntries = [
    createSalesInvoiceJournal(invoice, snapshot.accounts, party),
    ...snapshot.journalEntries,
  ]
  return {
    ...snapshot,
    invoices,
    journalEntries,
    parties: recomputePartyBalances(invoices, [...snapshot.parties, party]),
    accounts: computeAccountBalances(snapshot.accounts, journalEntries),
  }
}

describe('Books e2e: corrupt store recovery', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('reports a corrupt store instead of an empty ledger, and writes one forensic copy per payload', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Bulk water pipeline maintenance',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    expect(session.readStoredData().invoices).toHaveLength(1)

    session.writeBooksFile(CORRUPT_BYTES)

    // The store exists but cannot be read: that is NOT a first run, and it must
    // never be answered with an empty ledger the next save would persist.
    const loaded = await session.loadDataResult()
    expect(loaded.ok).toBe(true)
    expect(loaded.readable).toBe(false)
    expect(loaded.data).toBeNull()
    expect(loaded.readable === false && loaded.error).toBeTruthy()

    // The corrupt bytes are kept verbatim, with one forensic copy each.
    expect(session.readBooksFile()).toBe(CORRUPT_BYTES)
    const files = session.listFiles()
    const stampCopies = files.filter((name) => name.startsWith('books-data.json.corrupt-'))
    expect(stampCopies).toHaveLength(1)
    expect(files).toContain('books-data.json.corrupted.bak')
    expect(readFileSync(join(session.booksDir, stampCopies[0]), 'utf8')).toBe(CORRUPT_BYTES)
    expect(readFileSync(join(session.booksDir, 'books-data.json.corrupted.bak'), 'utf8')).toBe(
      CORRUPT_BYTES,
    )
    expect(existsSync(session.booksDataPath)).toBe(true)

    // Re-reading the same broken bytes must not keep manufacturing copies.
    const afterFirst = session.listFiles().length
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await session.loadDataResult()
    }
    expect(session.listFiles().length).toBe(afterFirst)

    const suggestions = await session.invoke<SettlementSuggestion[]>(
      BOOKS_CHANNELS.getSettlementSuggestions,
    )
    expect(suggestions).toEqual([])
  })
})

describe('Books e2e: closed periods and schema versions', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  async function seedClosedLedger(): Promise<{ invoiceId: string; closed: BooksDataEnvelope }> {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Bulk water pipeline maintenance',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const open = (await session.loadData())!
    const closed: BooksDataEnvelope = {
      ...open,
      settings: { ...open.settings, closedThrough: '2026-08-31' },
    }
    expect(await session.saveData(closed)).toBe(true)
    return { invoiceId: issued.invoice!.id, closed }
  }

  it('rejects a raw save that rewrites a closed period', async () => {
    const { invoiceId, closed } = await seedClosedLedger()
    const closedBytes = session.readBooksFile()

    const tampered: BooksDataEnvelope = {
      ...closed,
      invoices: closed.invoices.map((invoice) =>
        invoice.id === invoiceId
          ? { ...invoice, subtotal: 1, taxTotal: 0.15, grandTotal: 1.15 }
          : invoice,
      ),
    }
    expect(await session.saveData(tampered)).toBe(false)
    expect(session.readBooksFile()).toBe(closedBytes)

    const deleted: BooksDataEnvelope = {
      ...closed,
      invoices: [],
      journalEntries: [],
    }
    expect(await session.saveData(deleted)).toBe(false)
    expect(session.readBooksFile()).toBe(closedBytes)

    const reopened: BooksDataEnvelope = {
      ...closed,
      settings: { ...closed.settings, closedThrough: '' },
    }
    expect(await session.saveData(reopened)).toBe(false)
    expect(session.readBooksFile()).toBe(closedBytes)

    // Late settlement of a locked invoice is allowed: status and outstanding
    // may still move after the close.
    const settled: BooksDataEnvelope = {
      ...closed,
      invoices: closed.invoices.map((invoice) => ({
        ...invoice,
        status: 'Paid' as const,
        outstandingAmount: 0,
      })),
    }
    expect(await session.saveData(settled)).toBe(true)
    expect(session.readStoredData().settings.closedThrough).toBe('2026-08-31')
  })

  it('refuses to post a new invoice dated inside the closed period', async () => {
    const { closed } = await seedClosedLedger()

    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'City of Cape Town',
      itemDescription: 'Late-dated work',
      amount: 5000,
      date: '2026-08-20',
    })
    expect(issued.ok).toBe(false)
    expect(issued.error).toBe(
      'Cannot issue an invoice dated in a closed period: 2026-08-20 (closed through 2026-08-31)',
    )
    expect(session.readStoredData().invoices).toHaveLength(closed.invoices.length)
  })

  it('refuses a newer-than-supported schema version and stamps a version-less payload', async () => {
    // A file written by a newer build can carry fields this one would drop on
    // the next write, so it is refused rather than carried forward.
    const refused = await session.saveDataResult({ ...emptyLedger(), version: 99 })
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error).toContain('newer version of Zano Books')
    expect(existsSync(session.booksDataPath)).toBe(false)

    // A payload with no version is stamped with the current schema version.
    expect(await session.saveData({ ...emptyLedger(), version: undefined })).toBe(true)
    expect(session.readStoredData().version).toBe(1)
  })
})

describe('Books e2e: concurrent writers', () => {
  let sessions: BooksE2ESession[] = []

  afterEach(() => {
    for (const session of sessions) session.dispose()
    sessions = []
  })

  it('refuses the stale writer, then lands its invoice from the revision it was handed', async () => {
    const userDataDir = createUserDataDir()
    const a = await bootBooksE2E({ userDataDir })
    const b = await bootBooksE2E({ userDataDir })
    sessions = [a, b]
    expect(a.booksDataPath).toBe(b.booksDataPath)

    expect(await a.saveData(emptyLedger())).toBe(true)
    const staleSnapshot = (await b.loadData())!

    const issued = a.modules.issueSalesInvoiceInBooks({
      booksDataPath: a.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Bulk water pipeline maintenance',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    expect(issued.invoice?.invoiceNumber).toBe('INV-2026-001')
    const afterIssue = a.readBooksFile()

    const interleaved = postSalesInvoiceFromSnapshot(
      staleSnapshot,
      'City of Cape Town',
      11500,
      '2026-08-06',
    )
    expect(interleaved.invoices[0].invoiceNumber).toBe('INV-2026-001')
    const refused = await b.saveDataResult(interleaved, staleSnapshot.revision)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('the stale write must be refused')
    expect(refused.conflict).toBe(true)
    expect(refused.current?.invoices.map((invoice) => invoice.invoiceNumber)).toEqual([
      'INV-2026-001',
    ])
    // The store is exactly as the winner left it: nothing was merged, nothing
    // was lost, and no second invoice was given the colliding number.
    expect(a.readBooksFile()).toBe(afterIssue)

    // B applies its invoice on top of what it was handed.
    const adopted = refused.current!
    const reapplied = postSalesInvoiceFromSnapshot(
      adopted,
      'City of Cape Town',
      11500,
      '2026-08-06',
    )
    expect(await b.saveDataResult(reapplied, adopted.revision)).toMatchObject({ ok: true })

    const stored = a.readStoredData()
    const numbers = stored.invoices.map((invoice) => invoice.invoiceNumber)
    expect([...numbers].sort()).toEqual(['INV-2026-001', 'INV-2026-002'])
    expect(new Set(numbers).size).toBe(numbers.length)
    expect(stored.invoices.map((invoice) => invoice.partyName).sort()).toEqual([
      'City of Cape Town',
      'Rand Water Authority',
    ])
    expect(accountBalance(stored, 'acc-ar')).toBe(34500)
    expect(allJournalsBalanced(stored.journalEntries)).toBe(true)
  })

  it('refuses a store of valid JSON that is not a ledger, and recovers it from a backup', async () => {
    const session = await bootBooksE2E()
    sessions = [session]
    expect(await session.saveData(emptyLedger())).toBe(true)

    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Bulk water pipeline maintenance',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    // A real backup to recover from, before the store is damaged.
    const backup = await session.invoke<{ ok: boolean; path?: string }>(BOOKS_CHANNELS.backupNow)
    expect(backup.ok).toBe(true)

    // A settings file, a spreadsheet export, anything that parses as JSON but
    // is not a ledger. It must not load as an empty ledger, and the next save
    // must not persist that emptiness over the real books.
    session.writeBooksFile('{"companyName":"Branten Solutions","accounts":"nope"}')
    const load = await session.loadDataResult()
    expect(load.ok).toBe(true)
    expect(load.readable).toBe(false)
    const unreadable = load.ok && load.readable === false ? load : null
    expect(unreadable?.error).toContain('not a books ledger')
    expect(unreadable?.forensicPath).toBeTruthy()
    expect(existsSync(unreadable!.forensicPath!)).toBe(true)
    expect(session.readBooksFile()).toBe('{"companyName":"Branten Solutions","accounts":"nope"}')

    const save = await session.saveDataResult(emptyLedger())
    expect(save.ok).toBe(false)
    expect(session.readBooksFile()).toBe('{"companyName":"Branten Solutions","accounts":"nope"}')

    // The backup still holds the ledger, and restoring it is the way back.
    const restored = await session.invoke<{ ok: boolean; restoredData?: BooksDataEnvelope }>(
      BOOKS_CHANNELS.restoreBackup,
      basename(backup.path!),
    )
    expect(restored.ok).toBe(true)
    expect(session.readStoredData().invoices).toHaveLength(1)
    expect(readFileSync(backup.path!, 'utf8')).toContain('INV-2026-001')
  })
})

// @vitest-environment node

/**
 * Durability & concurrency suite for the Zano Books store.
 *
 * Every case here drives the REAL `books:save-data` / `books:load-data`
 * handlers and the real ledger writers against a temp `userData` directory,
 * and then inspects the bytes on disk — because the defects this suite pins
 * were all invisible to a result code: a lost invoice still answered `true`,
 * and a read error still answered with a valid-looking empty ledger.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOKS_CHANNELS } from '../src/shared/ipc'
import {
  allJournalsBalanced,
  calculateInvoiceTotals,
  computeAccountBalances,
  createSalesInvoiceJournal,
  nextInvoiceNumber,
  recomputePartyBalances,
} from '../src/shared/accounting'
import { journalReferencesInvoice } from '../src/shared/credit-notes'
import type { BooksData, BooksDataEnvelope, Invoice, Party } from '../src/shared/types'
import { CURRENT_BOOKS_SCHEMA_VERSION } from '../src/main/books-core'
import { exportBackup, pruneBackups } from '../src/main/backup-restore'
import { bootBooksE2E, createUserDataDir, type BooksE2ESession } from './helpers/books-e2e'
import { emptyLedger } from './e2e/fixtures'

vi.mock('electron', async () => {
  const { createElectronModule } = await import('./helpers/electron-mock')
  return createElectronModule()
})

// Booting the real module re-imports its whole graph; these journeys get more
// room than the unit suite because the shared runner is slow under parallel load.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

function accountBalance(data: BooksDataEnvelope | BooksData, id: string): number {
  return data.accounts.find((account) => account.id === id)?.balance ?? Number.NaN
}

/** The renderer's invoice-save shape: post a journal, derive balances. */
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

describe('durability: lost updates and invoice numbering', () => {
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
    const revisionAfterSetup = a.revision()

    // `b` reads after the setup and then goes stale: `a` posts first.
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
    expect(a.readStoredData().revision).toBe(revisionAfterSetup + 1)
    const afterIssue = a.readBooksFile()

    // `b` posts the invoice it computed from its stale snapshot, whose number
    // collides with the one `a` just committed. Nothing is written: the write
    // is refused and `b` is handed the ledger it lost the race against.
    const interleaved = postSalesInvoiceFromSnapshot(
      staleSnapshot,
      'City of Cape Town',
      11500,
      '2026-08-06',
    )
    const conflict = await b.saveDataResult(interleaved, staleSnapshot.revision)
    expect(conflict.ok).toBe(false)
    if (conflict.ok) throw new Error('the stale write must not be accepted')
    expect(conflict.conflict).toBe(true)
    expect(conflict.error).toContain('Nothing was saved')
    expect(conflict.current?.revision).toBe(revisionAfterSetup + 1)
    expect(conflict.current?.invoices.map((invoice) => invoice.invoiceNumber)).toEqual([
      'INV-2026-001',
    ])
    expect(a.readBooksFile()).toBe(afterIssue)

    // The staggered writer adopts what it was handed and applies its invoice on
    // top, which is the write the conflict told it to make.
    const adopted = conflict.current!
    const reapplied = postSalesInvoiceFromSnapshot(
      adopted,
      'City of Cape Town',
      11500,
      '2026-08-06',
    )
    expect(await b.saveDataResult(reapplied, adopted.revision)).toMatchObject({ ok: true })

    const stored = a.readStoredData()
    const numbers = stored.invoices.map((invoice) => invoice.invoiceNumber)
    expect(numbers).toHaveLength(2)
    expect(new Set(numbers).size).toBe(numbers.length)
    expect([...numbers].sort()).toEqual(['INV-2026-001', 'INV-2026-002'])
    expect(stored.invoices.map((invoice) => invoice.partyName).sort()).toEqual([
      'City of Cape Town',
      'Rand Water Authority',
    ])

    // AR equals the sum of the invoices actually posted, and the journals back it.
    expect(accountBalance(stored, 'acc-ar')).toBe(34500)
    expect(allJournalsBalanced(stored.journalEntries)).toBe(true)
    expect(stored.revision).toBeGreaterThan(revisionAfterSetup + 1)
  })

  it('serializes many concurrent issuers so no number is duplicated', async () => {
    const userDataDir = createUserDataDir()
    const a = await bootBooksE2E({ userDataDir })
    sessions = [a]
    expect(await a.saveData(emptyLedger())).toBe(true)

    const results = Array.from({ length: 8 }, (_, index) =>
      a.modules.issueSalesInvoiceInBooks({
        booksDataPath: a.booksDataPath,
        partyName: `Party ${index}`,
        itemDescription: 'Concurrent work',
        amount: 1000 + index,
        date: '2026-08-07',
      }),
    )
    for (const result of results) expect(result.ok).toBe(true)

    const stored = a.readStoredData()
    const numbers = stored.invoices.map((invoice) => invoice.invoiceNumber)
    expect(numbers).toHaveLength(8)
    expect(new Set(numbers).size).toBe(8)
    expect(allJournalsBalanced(stored.journalEntries)).toBe(true)
  })
})

describe('durability: a stale save is refused, never merged', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  /**
   * Setup plus two posted invoices, and the ledger as a READER sees it. What
   * that reader later sends is a real competing ledger — non-empty, with ids
   * the migration keeps — so nothing but the revision check can refuse it.
   */
  async function seededLedger(): Promise<{
    snapshot: BooksDataEnvelope
    firstId: string
    secondId: string
  }> {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const first = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Bulk water pipeline maintenance',
      amount: 23000,
      date: '2026-08-05',
    })
    const second = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'City of Cape Town',
      itemDescription: 'Second delivery',
      amount: 11500,
      date: '2026-08-06',
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const snapshot = (await session.loadData())!
    expect(snapshot.invoices).toHaveLength(2)
    return { snapshot, firstId: first.invoice!.id, secondId: second.invoice!.id }
  }

  it('rejects a stale save with conflict, the stored ledger and not one byte written', async () => {
    const { snapshot } = await seededLedger()
    const storedRevision = session.readStoredData().revision

    // Writer A renames the company; writer B still holds the pre-rename ledger.
    const a = (await session.loadData())!
    expect(
      await session.saveData({ ...a, settings: { ...a.settings, companyName: 'Renamed Co' } }),
    ).toBe(true)
    const storedBytes = session.readBooksFile()
    const newerRevision = session.readStoredData().revision
    expect(newerRevision).toBeGreaterThan(storedRevision)
    const safetyPath = join(session.booksDir, 'books-data.json.bak')
    const safetyBefore = readFileSync(safetyPath, 'utf8')

    const refused = await session.saveDataResult(snapshot, snapshot.revision)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('the stale write must not be accepted')
    expect(refused.conflict).toBe(true)
    expect(refused.error).toContain('Nothing was saved')
    // The client is handed the ledger it lost the race against, so it has
    // something real to adopt instead of a bare failure.
    expect(refused.current?.revision).toBe(newerRevision)
    expect(refused.current?.settings.companyName).toBe('Renamed Co')

    // Refusing means refusing: no revision bump, no rewrite, no rotation of the
    // pre-overwrite safety copy.
    expect(session.readBooksFile()).toBe(storedBytes)
    expect(session.readStoredData().revision).toBe(newerRevision)
    expect(readFileSync(safetyPath, 'utf8')).toBe(safetyBefore)
  })

  it('lets the very next write succeed once it carries the returned revision', async () => {
    const { snapshot } = await seededLedger()

    // The store moves on after the snapshot was taken, which is what makes the
    // snapshot stale.
    const a = (await session.loadData())!
    expect(
      await session.saveData({ ...a, settings: { ...a.settings, companyName: 'Renamed Co' } }),
    ).toBe(true)

    const refused = await session.saveDataResult(snapshot, snapshot.revision)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('the stale write must not be accepted')
    const adopted = refused.current!
    expect(adopted.revision).toBeGreaterThan(snapshot.revision)
    expect(adopted.settings.companyName).toBe('Renamed Co')

    // The store's recovery adopts `current`; the payload it sends next carries
    // that revision, and it must not be a dead end.
    const landed = await session.saveDataResult(
      { ...adopted, settings: { ...adopted.settings, companyName: 'Recovered Co' } },
      adopted.revision,
    )
    expect(landed).toMatchObject({ ok: true })
    expect(session.readStoredData().settings.companyName).toBe('Recovered Co')
    expect(session.readStoredData().revision).toBe(adopted.revision + 1)
  })

  it('judges staleness only on the revision argument, never the payload revision', async () => {
    const { snapshot } = await seededLedger()
    const a = (await session.loadData())!
    expect(
      await session.saveData({ ...a, settings: { ...a.settings, companyName: 'Renamed Co' } }),
    ).toBe(true)
    const storedBytes = session.readBooksFile()

    // A payload whose own revision field claims the store is its equal cannot
    // certify itself: the explicit argument is stale, so the write is refused.
    const claiming: BooksDataEnvelope = { ...snapshot, revision: 99 }
    const refused = await session.saveDataResult(claiming, snapshot.revision)
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error).toContain('Nothing was saved')
    expect(session.readBooksFile()).toBe(storedBytes)

    // And the reverse: a payload carrying a stale revision field is data, not a
    // cursor — the explicit argument is current, so the write lands.
    const current = (await session.loadData())!
    const older: BooksDataEnvelope = { ...current, revision: 0 }
    expect(
      await session.saveDataResult(
        { ...older, settings: { ...older.settings, companyName: 'Current Co' } },
        current.revision,
      ),
    ).toMatchObject({ ok: true })
    expect(session.readStoredData().settings.companyName).toBe('Current Co')
    expect(session.readStoredData().revision).toBe(current.revision + 1)
  })

  it('keeps the newer payments, bank lines, parties and audit entries (D1a)', async () => {
    const { snapshot, firstId } = await seededLedger()
    const invoice = session.readStoredData().invoices.find((entry) => entry.id === firstId)!

    // Writer A commits a payment, an imported statement line, a new party and
    // an audit entry — the evidence a stale merge used to erase.
    const a = (await session.loadData())!
    const committed: BooksDataEnvelope = {
      ...a,
      payments: [
        {
          id: 'pay-1',
          partyId: invoice.partyId,
          partyName: invoice.partyName,
          date: '2026-08-20',
          type: 'received',
          method: 'Bank Transfer',
          allocations: [{ invoiceId: firstId, invoiceNumber: invoice.invoiceNumber, amount: 5000 }],
          total: 5000,
          createdAt: new Date().toISOString(),
        },
      ],
      bankTransactions: [
        {
          id: 'tx-1',
          accountId: 'acc-bank',
          date: '2026-08-20',
          description: 'EFT DEPOSIT RAND WATER',
          reference: invoice.invoiceNumber,
          amount: 5000,
          reconciled: false,
        },
      ],
      parties: [
        ...a.parties,
        { id: 'party-new', name: 'New Customer', type: 'Customer', outstandingBalance: 0 },
      ],
      auditLog: [
        {
          id: 'audit-payment',
          timestamp: new Date().toISOString(),
          action: 'payment.record',
          summary: 'Recorded R5000 from Rand Water Authority',
        },
        ...(a.auditLog ?? []),
      ],
    }
    expect(await session.saveData(committed)).toBe(true)
    const newer = session.readStoredData()
    const newerBytes = session.readBooksFile()

    // The stale writer holds both invoices, so its payload looks legitimate —
    // nothing but the revision check stands between it and the newer evidence.
    const refused = await session.saveDataResult(snapshot, snapshot.revision)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('the stale write must not be accepted')
    expect(refused.conflict).toBe(true)

    const stored = session.readStoredData()
    expect(stored.payments).toEqual(newer.payments)
    expect(stored.bankTransactions).toEqual(newer.bankTransactions)
    expect(stored.parties).toEqual(newer.parties)
    expect(stored.auditLog).toEqual(newer.auditLog)
    expect(stored.payments?.map((payment) => payment.id)).toEqual(['pay-1'])
    expect(stored.bankTransactions?.map((tx) => tx.id)).toEqual(['tx-1'])
    expect(stored.parties.map((party) => party.id)).toContain('party-new')
    // The invoice still points at a party that exists.
    expect(stored.parties.map((party) => party.id)).toContain(stored.invoices[0].partyId)
    expect(session.readBooksFile()).toBe(newerBytes)
  })

  it('keeps the newer edit to an invoice the stale writer also holds (D1b)', async () => {
    const { snapshot, firstId } = await seededLedger()

    const a = (await session.loadData())!
    const edited: BooksDataEnvelope = {
      ...a,
      invoices: a.invoices.map((invoice) =>
        invoice.id === firstId ? { ...invoice, notes: 'Edited by the newer writer' } : invoice,
      ),
    }
    expect(await session.saveData(edited)).toBe(true)

    // The stale writer holds the same invoice with the OLD notes.
    expect(snapshot.invoices.find((invoice) => invoice.id === firstId)?.notes).not.toBe(
      'Edited by the newer writer',
    )
    const refused = await session.saveDataResult(snapshot, snapshot.revision)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('the stale write must not be accepted')

    const stored = session.readStoredData()
    expect(stored.invoices.find((invoice) => invoice.id === firstId)?.notes).toBe(
      'Edited by the newer writer',
    )
    // ...and the accounts still describe the stored invoices and journals.
    const outstanding = stored.invoices.reduce(
      (sum, invoice) => sum + (invoice.outstandingAmount ?? invoice.grandTotal),
      0,
    )
    expect(accountBalance(stored, 'acc-ar')).toBe(outstanding)
    expect(allJournalsBalanced(stored.journalEntries)).toBe(true)
  })

  it('does not resurrect an invoice and journal the newer writer deleted (D1c)', async () => {
    const { snapshot, firstId, secondId } = await seededLedger()
    const both = (await session.loadData())!
    const doomed = both.invoices.find((invoice) => invoice.id === firstId)!

    // Writer A deletes the first invoice, journal and all, as a CURRENT writer.
    const keptJournals = both.journalEntries.filter(
      (entry) => !journalReferencesInvoice(entry, doomed.invoiceNumber),
    )
    expect(keptJournals.length).toBe(both.journalEntries.length - 1)
    // The renderer derives balances from journals before it saves, so the
    // deletion carries accounts that match the journals it kept.
    expect(
      await session.saveData(
        session.modules.recomputeLedger({
          ...both,
          invoices: both.invoices.filter((invoice) => invoice.id !== firstId),
          journalEntries: keptJournals,
        }),
      ),
    ).toBe(true)
    const afterDelete = session.readStoredData()
    expect(afterDelete.invoices.map((invoice) => invoice.id)).toEqual([secondId])
    expect(accountBalance(afterDelete, 'acc-ar')).toBe(11500)

    // The stale writer still holds both, and posting them back must not undo the
    // deletion it never saw.
    expect(snapshot.invoices.map((invoice) => invoice.id)).toEqual([secondId, firstId])
    const refused = await session.saveDataResult(snapshot, snapshot.revision)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('the stale write must not be accepted')
    const stored = session.readStoredData()
    expect(stored.invoices.map((invoice) => invoice.id)).toEqual([secondId])
    expect(stored.invoices.map((invoice) => invoice.invoiceNumber)).toEqual(['INV-2026-002'])
    expect(
      stored.journalEntries.some((entry) => journalReferencesInvoice(entry, doomed.invoiceNumber)),
    ).toBe(false)
    expect(accountBalance(stored, 'acc-ar')).toBe(11500)
    expect(allJournalsBalanced(stored.journalEntries)).toBe(true)
  })

  it('increments the revision on every successful write and echoes it', async () => {
    const seen: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await session.saveDataResult(emptyLedger())
      expect(result.ok).toBe(true)
      if (result.ok) seen.push(result.revision)
    }
    expect(seen).toEqual([1, 2, 3])
    expect(session.readStoredData().revision).toBe(3)
  })

  it('refuses a non-numeric revision instead of trusting it', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const json = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.saveData,
      emptyLedger(),
      'one',
    )
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Revision')
  })
})

describe('durability: an unreadable store is never an empty ledger', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('reports a corrupt store and refuses to overwrite it', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const goodBytes = session.readBooksFile()

    session.writeBooksFile('{"version":1,"settings":')
    const load = await session.loadDataResult()
    expect(load.ok).toBe(true)
    expect(load.readable).toBe(false)
    expect(load.data).toBeNull()
    expect(load.error).toContain('not valid JSON')
    // The reply names the salvage copy, so the user can be told where it is.
    const unreadable = load.ok && load.readable === false ? load : null
    expect(unreadable?.forensicPath).toBeTruthy()
    expect(readFileSync(unreadable!.forensicPath!, 'utf8')).toBe('{"version":1,"settings":')

    // A save on top of an unreadable store must refuse, not write an empty ledger.
    const save = await session.saveDataResult(emptyLedger())
    expect(save.ok).toBe(false)
    expect(session.readBooksFile()).toBe('{"version":1,"settings":')

    // Restoring the good bytes brings the ledger straight back.
    session.writeBooksFile(goodBytes)
    const recovered = (await session.loadData())!
    expect(recovered.invoices).toHaveLength(1)
  })

  it('refuses valid JSON that is not a ledger, keeps a copy and overwrites nothing', async () => {
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const populated = session.readBooksFile()

    const notLedgers = [
      'null',
      '[]',
      '"hello"',
      '42',
      '{}',
      '{"hello":"world"}',
      '{"accounts":"nope","invoices":[]}',
      '{"accounts":[],"invoices":"nope"}',
    ]
    for (const payload of notLedgers) {
      session.writeBooksFile(payload)

      // Parses fine, is not a ledger: that is not a first run and not an empty
      // ledger either — it is an unreadable store.
      const load = await session.loadDataResult()
      expect(load.ok, payload).toBe(true)
      expect(load.readable, payload).toBe(false)
      const unreadable = load.ok && load.readable === false ? load : null
      expect(unreadable?.error, payload).toContain('not a books ledger')
      expect(unreadable?.forensicPath, payload).toBeTruthy()
      // The bytes are kept verbatim and the file itself is untouched.
      expect(readFileSync(unreadable!.forensicPath!, 'utf8'), payload).toBe(payload)
      expect(session.readBooksFile(), payload).toBe(payload)

      // Saving over it would have written an empty ledger; it must not.
      const save = await session.saveDataResult(emptyLedger())
      expect(save.ok, payload).toBe(false)
      expect(session.readBooksFile(), payload).toBe(payload)
    }

    // The real ledger is still recoverable by putting the bytes back.
    session.writeBooksFile(populated)
    expect((await session.loadData())!.invoices).toHaveLength(1)
  })

  it('still treats a genuinely absent file as the normal first run', async () => {
    expect(existsSync(session.booksDataPath)).toBe(false)
    const load = await session.loadDataResult()
    expect(load.ok).toBe(true)
    expect(load.readable).toBe(true)
    expect(load.data).toBeNull()

    // The first-run save is the one write that may start a fresh ledger.
    expect(await session.saveData(emptyLedger())).toBe(true)
    expect(session.readStoredData().revision).toBe(1)
  })
})

describe('durability: pre-overwrite safety copy and shrink guard', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('keeps the previous ledger in books-data.json.bak before replacing it', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const withInvoice = session.readBooksFile()

    // The next write replaces a populated ledger, so the previous bytes survive.
    const current = (await session.loadData())!
    expect(
      await session.saveData({
        ...current,
        settings: {
          ...current.settings,
          companyName: 'Renamed Co',
        },
      }),
    ).toBe(true)

    const backupPath = join(session.booksDir, 'books-data.json.bak')
    expect(existsSync(backupPath)).toBe(true)
    expect(JSON.parse(readFileSync(backupPath, 'utf8'))).toEqual(JSON.parse(withInvoice))
  })

  it('refuses a current writer that would shrink a populated ledger to nothing', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const populated = session.readBooksFile()

    // Re-read first: this save is from a CURRENT client, so nothing is merged
    // and the shrink refusal is what has to stop it — and the refusal has to be
    // something a person can act on, not the guard's record arithmetic.
    const current = (await session.loadData())!
    const destructive = await session.saveDataResult({
      ...current,
      invoices: [],
      journalEntries: [],
    })
    expect(destructive.ok).toBe(false)
    expect(destructive.ok ? '' : destructive.error).toMatch(
      /Nothing was saved: this change would have emptied your books/,
    )
    expect(destructive.ok ? '' : destructive.error).not.toMatch(/Refusing|record count/i)
    expect(session.readBooksFile()).toBe(populated)
  })

  it('refuses a payload of decoy records the migration would drop (D5)', async () => {
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const populated = session.readBooksFile()

    // The raw arrays look populated, but every entry lacks a string id, so the
    // migration keeps none of them. Counting what was SENT let this empty the
    // file; counting what the migration KEEPS refuses it.
    const decoys = {
      ...session.readStoredData(),
      invoices: [{ id: 42, invoiceNumber: 'INV-2026-009' }, { decoy: true }],
      journalEntries: [{ id: null, items: [] }, { entryNumber: 'JE-2026-009' }],
    }
    const outcome = session.modules.writeBooksStore(session.booksDataPath, decoys)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.error).toMatch(/Nothing was saved/)
    expect(session.readBooksFile()).toBe(populated)
    expect(session.readStoredData().invoices).toHaveLength(1)
  })

  it('ignores the delete reason when the write names no revision (D1)', async () => {
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const populated = session.readBooksFile()

    // The reason is only honoured together with the revision the write acts on:
    // a writer that names neither cannot empty books it never read.
    const outcome = session.modules.writeBooksStore(
      session.booksDataPath,
      { ...emptyLedger(), revision: session.readStoredData().revision },
      { emptyLedger: 'user-deleted-last-record' },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.error).toMatch(/Nothing was saved/)
    expect(session.readBooksFile()).toBe(populated)

    // With the revision it does act on, the same reason is the user's delete
    // and the empty replacement lands.
    const revision = session.readStoredData().revision
    const landed = session.modules.writeBooksStore(
      session.booksDataPath,
      { ...emptyLedger(), revision },
      { expectedRevision: revision, emptyLedger: 'user-deleted-last-record' },
    )
    expect(landed).toMatchObject({ ok: true })
    expect(session.readStoredData().invoices).toEqual([])
    expect(session.readStoredData().journalEntries).toEqual([])
  })

  it('still allows restoring a genuine empty ledger when there is no ledger to lose', async () => {
    // The recovery path: the store exists but cannot be read (or does not exist
    // at all). Restoring an empty backup over it is deliberate, and the bytes
    // that were there are kept.
    const corrupt = '{"version":1,"settings":'
    session.writeBooksFile(corrupt)
    mkdirSync(session.backupsDir, { recursive: true })
    const name = 'books-backup-20260101-000000.json'
    writeFileSync(join(session.backupsDir, name), JSON.stringify(emptyLedger()), 'utf8')

    const restored = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.restoreBackup,
      name,
    )
    expect(restored.ok).toBe(true)
    expect(session.readStoredData().invoices).toEqual([])

    // The unreadable bytes are still on disk as the pre-restore safety copy.
    const safety = session
      .listFiles(session.backupsDir)
      .filter((file) => file.startsWith('pre-restore-'))
    expect(safety).toHaveLength(1)
    expect(readFileSync(join(session.backupsDir, safety[0]), 'utf8')).toBe(corrupt)
  })

  it('restores an empty backup over a populated ledger, keeping the books it replaced', async () => {
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    const populated = session.readBooksFile()

    mkdirSync(session.backupsDir, { recursive: true })
    const name = 'books-backup-20260101-000000.json'
    writeFileSync(join(session.backupsDir, name), JSON.stringify(emptyLedger()), 'utf8')

    // A restore is the user's own confirmed choice of file, so it states its
    // reason and is allowed to leave the books empty. That is what makes
    // "start over" reachable at all.
    const restored = await session.invoke<{ ok: boolean; error?: string; restoredData?: unknown }>(
      BOOKS_CHANNELS.restoreBackup,
      name,
    )
    expect(restored.ok).toBe(true)
    expect(restored.restoredData).toBeDefined()
    expect(session.readStoredData().invoices).toEqual([])

    // The populated ledger it replaced is not gone: it is the pre-restore
    // safety copy, which is itself a restorable file.
    const safety = session
      .listFiles(session.backupsDir)
      .filter((file) => file.startsWith('pre-restore-'))
    expect(safety).toHaveLength(1)
    expect(readFileSync(join(session.backupsDir, safety[0]), 'utf8')).toBe(populated)
  })
})

describe('durability: an operation that stored nothing writes nothing', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('does not bump the revision, rotate the safety copy or broadcast for a bank import that stored no line', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)
    // Let the file watcher's debounce settle before counting broadcasts.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const beforeBytes = session.readBooksFile()
    const beforeRevision = session.readStoredData().revision
    const beforeBroadcasts = session.broadcasts().length

    // Nothing valid in the statement at all.
    const empty = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.importBankStatementCsv,
      'Date,Description,Amount\n,,,\nnot-a-row\n',
    )
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain('No valid transactions')
    expect(session.readBooksFile()).toBe(beforeBytes)
    expect(session.readStoredData().revision).toBe(beforeRevision)

    // A statement whose every line is already stored. It reports the duplicate
    // and changes nothing; the imported line itself is written once, below.
    const csv = 'Date,Description,Amount\n2026-09-01,EFT DEPOSIT RAND WATER,5000.00'
    const first = await session.invoke<{ ok: boolean; importedCount?: number }>(
      BOOKS_CHANNELS.importBankStatementCsv,
      csv,
    )
    expect(first.ok).toBe(true)
    expect(first.importedCount).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const afterImportBytes = session.readBooksFile()
    const afterImportRevision = session.readStoredData().revision
    const afterImportBroadcasts = session.broadcasts().length
    const safetyPath = join(session.booksDir, 'books-data.json.bak')
    const afterImportSafety = readFileSync(safetyPath, 'utf8')
    expect(afterImportRevision).toBeGreaterThan(beforeRevision)

    const reimport = await session.invoke<{
      ok: boolean
      importedCount?: number
      skippedDuplicates?: number
    }>(BOOKS_CHANNELS.importBankStatementCsv, csv)
    expect(reimport.ok).toBe(true)
    expect(reimport.importedCount).toBe(0)
    expect(reimport.skippedDuplicates).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 200))
    // Not one byte, not one revision, not one broadcast, and the safety copy of
    // the previous ledger was not rotated: a client tracking the revision is not
    // pushed into the stale path by an operation that did nothing.
    expect(session.readBooksFile()).toBe(afterImportBytes)
    expect(session.readStoredData().revision).toBe(afterImportRevision)
    expect(session.broadcasts().length).toBe(afterImportBroadcasts)
    expect(readFileSync(safetyPath, 'utf8')).toBe(afterImportSafety)
  })
})

describe('durability: forensic copies are written once per payload', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('does not amplify the file count when a corrupt store is loaded repeatedly', async () => {
    const corrupt = '{"version":1,"invoices":['
    session.writeBooksFile(corrupt)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await session.loadDataResult()
      // The bytes under test never change, so no further copy is justified.
      expect(session.readBooksFile()).toBe(corrupt)
    }

    const files = session.listFiles()
    expect(files.filter((name) => name.startsWith('books-data.json.corrupt-'))).toHaveLength(1)
    expect(files.filter((name) => name.endsWith('.corrupted.bak'))).toHaveLength(1)
    expect(files).toHaveLength(3)
  })

  it('takes a fresh forensic copy when the corrupt payload itself changes', async () => {
    session.writeBooksFile('{"version":1,"invoices":[')
    await session.loadDataResult()
    session.writeBooksFile('{"version":1,"parties":[')
    await session.loadDataResult()

    const copies = session.listFiles().filter((name) => name.startsWith('books-data.json.corrupt-'))
    expect(copies).toHaveLength(2)
  })
})

describe('durability: schema versions', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('refuses a newer schema version and stamps a version-less payload', async () => {
    const future = await session.saveDataResult({ ...emptyLedger(), version: 99 })
    expect(future.ok).toBe(false)
    expect(future.ok ? '' : future.error).toContain('newer version')
    expect(existsSync(session.booksDataPath)).toBe(false)

    expect(await session.saveData({ ...emptyLedger(), version: undefined })).toBe(true)
    expect(session.readStoredData().version).toBe(1)
  })

  it('refuses to load a store written by a newer schema rather than downgrading it', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const future = { ...session.readStoredData(), version: 99 }
    session.writeBooksFile(JSON.stringify(future))

    const load = await session.loadDataResult()
    expect(load.ok).toBe(true)
    expect(load.readable).toBe(false)
    expect(load.error).toContain('newer version')
    expect(JSON.parse(session.readBooksFile()).version).toBe(99)
  })

  it('refuses a version that is not a schema number instead of re-stamping it', async () => {
    const nonsense: Array<number | string | null | boolean | object> = [
      -5,
      1.9,
      '2',
      null,
      true,
      Number.NaN,
      { major: 2 },
    ]
    for (const version of nonsense) {
      const payload: BooksData = { ...emptyLedger(), version: version as number }
      const refused = await session.saveDataResult(payload)
      expect(refused.ok, String(version)).toBe(false)
      expect(refused.ok ? '' : refused.error, String(version)).toContain('schema version')
      // Nothing was written for any of them.
      expect(existsSync(session.booksDataPath), String(version)).toBe(false)
    }
  })

  it('refuses to load a store whose version is not a schema number', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const original = session.readBooksFile()
    session.writeBooksFile(JSON.stringify({ ...session.readStoredData(), version: '2' }))

    const load = await session.loadDataResult()
    expect(load.ok).toBe(true)
    expect(load.readable).toBe(false)
    expect(load.error).toContain('schema version')
    // ...and the file is left alone rather than re-stamped as version 1.
    expect(JSON.parse(session.readBooksFile()).version).toBe('2')
    const save = await session.saveDataResult(emptyLedger())
    expect(save.ok).toBe(false)
    expect(JSON.parse(session.readBooksFile()).version).toBe('2')
    expect(original).not.toBe(session.readBooksFile())
  })

  it('reads the pre-ledger schema 0 payload and stamps it with the current version', async () => {
    // Version 0 is the format this app's first releases wrote: balances and no
    // journals. It is readable, so it is listed in the migration registry, and
    // what comes back is the migrated ledger at the CURRENT version.
    const legacy: BooksData = { ...emptyLedger(), version: 0 }
    expect(await session.saveData(legacy)).toBe(true)
    expect(session.readStoredData().version).toBe(CURRENT_BOOKS_SCHEMA_VERSION)
    // A version-less payload is the same story.
    expect(await session.saveData({ ...emptyLedger(), version: undefined })).toBe(true)
    expect(session.readStoredData().version).toBe(CURRENT_BOOKS_SCHEMA_VERSION)
  })
})

describe('durability: hostile IPC payloads are rejected without throwing', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('rejects an oversized CSV on the export channel', async () => {
    const result = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.exportToSheets,
      'Trial Balance',
      'x'.repeat(5_000_001),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('character cap')
  })

  it('rejects an invoice payload missing required fields on the PDF channel', async () => {
    const result = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.openInPdf,
      { id: 'inv-1', type: 'Sales' },
      'Fallback Co',
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('invoiceNumber')
    expect(session.openedPaths()).toEqual([])
  })

  it('rejects a non-string transaction id on the reconcile channel', async () => {
    const result = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.reconcileTransaction,
      42,
      'inv-1',
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('transactionId must be a string')
  })

  it('rejects a traversal backup name without resolving it', async () => {
    const escaped = JSON.stringify(emptyLedger())
    writeFileSync(join(session.booksDir, 'books-backup-outside.json'), escaped, 'utf8')

    const traversals = ['../books-backup-outside.json', '..\\..\\books-backup-outside.json', '..']
    for (const name of traversals) {
      const result = await session.invoke<{ ok: boolean; error?: string }>(
        BOOKS_CHANNELS.restoreBackup,
        name,
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
    }
    // Nothing outside the backups directory was read or restored.
    expect(existsSync(session.booksDataPath)).toBe(false)
    // A name that is simply not a backup is reported as invalid.
    const notABackup = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.restoreBackup,
      'books-data.json',
    )
    expect(notABackup).toEqual({ ok: false, error: 'Invalid backup name' })
  })

  it('rejects a non-string CSV on the bank import channel', async () => {
    const result = await session.invoke<{ ok: boolean; error?: string }>(
      BOOKS_CHANNELS.importBankStatementCsv,
      { csv: 'Date,Description,Amount\n2026-09-01,X,1.00' },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('CSV payload must be a string')
  })
})

describe('durability: generated files never collide', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  /** A backup of a ledger that names itself, so a path can be traced to its call. */
  async function saveAndBackup(company: string): Promise<string> {
    const current = (await session.loadData())!
    expect(
      await session.saveData({
        ...current,
        settings: { ...current.settings, companyName: company },
      }),
    ).toBe(true)
    const result = await session.invoke<{ ok: boolean; path?: string }>(BOOKS_CHANNELS.backupNow)
    expect(result.ok).toBe(true)
    return result.path!
  }

  it('gives every rapid backup call its own file, capped at ten, and never another call its name', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)

    const calls: Array<{ path: string; company: string }> = []
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const company = `Rapid Co ${attempt}`
      const path = await saveAndBackup(company)
      // The file this call reports really exists — it was not renamed away.
      expect(existsSync(path)).toBe(true)
      expect(JSON.parse(readFileSync(path, 'utf8')).settings.companyName).toBe(company)
      calls.push({ path, company })
    }

    // Every call was given a name of its own, and a name it was given is never
    // handed to a later call: pruning may delete an old backup, but the path a
    // caller still holds can never come back pointing at a different ledger.
    expect(new Set(calls.map((call) => call.path)).size).toBe(calls.length)
    for (const call of calls) {
      if (!existsSync(call.path)) continue
      expect(JSON.parse(readFileSync(call.path, 'utf8')).settings.companyName).toBe(call.company)
    }

    const listed = await session.invoke<Array<{ name: string; path: string }>>(
      BOOKS_CHANNELS.listBackups,
    )
    expect(listed).toHaveLength(10)
    expect(new Set(listed.map((entry) => entry.name)).size).toBe(10)
    for (const entry of listed) {
      expect(existsSync(entry.path)).toBe(true)
    }
  })

  it('never reissues a backup name, even when pruning has freed it', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)

    const calls: Array<{ path: string; company: string }> = []
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const company = `Pruned Co ${attempt}`
      const current = session.readStoredData()
      expect(
        await session.saveData({
          ...current,
          settings: { ...current.settings, companyName: company },
        }),
      ).toBe(true)

      const result = exportBackup(session.booksDataPath)
      expect(result.ok).toBe(true)
      calls.push({ path: result.path!, company })
      // Pruning is what frees a name for reuse; it runs after every backup.
      pruneBackups(session.backupsDir, 10)
    }

    // Forty backup calls inside the same second used to produce 37 distinct
    // paths; each call now gets one of its own.
    expect(new Set(calls.map((call) => call.path)).size).toBe(40)
    for (const call of calls) {
      // A pruned backup may be gone — but if the file is still there it holds
      // the bytes this call reported, never a later call's ledger.
      if (!existsSync(call.path)) continue
      expect(JSON.parse(readFileSync(call.path, 'utf8')).settings.companyName).toBe(call.company)
    }
  })

  it('produces a distinct file per export of the same invoice number', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)

    const paths: string[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await session.invoke<{ ok: boolean; path?: string }>(
        BOOKS_CHANNELS.openInPdf,
        issued.invoice,
        'Fallback Co',
      )
      expect(result.ok).toBe(true)
      paths.push(result.path!)
    }

    expect(new Set(paths).size).toBe(3)
    for (const path of paths) {
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path).subarray(0, 5).toString('latin1')).toBe('%PDF-')
      rmSync(path, { force: true })
    }
  })

  it('gives the same invoice number a new path after the shell renamed the old export', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)

    const first = await session.invoke<{ ok: boolean; path?: string }>(
      BOOKS_CHANNELS.openInPdf,
      issued.invoice,
      'Fallback Co',
    )
    expect(first.ok).toBe(true)
    // The shell renames what it opened, or the user moves it — either way the
    // name is free again. `existsSync` used to see that as "reuse it", handing
    // the shell a second path for a document it already had open.
    const moved = `${first.path!}.reopened.pdf`
    renameSync(first.path!, moved)

    const second = await session.invoke<{ ok: boolean; path?: string }>(
      BOOKS_CHANNELS.openInPdf,
      issued.invoice,
      'Fallback Co',
    )
    expect(second.ok).toBe(true)
    expect(second.path).not.toBe(first.path)
    expect(existsSync(second.path!)).toBe(true)
    expect(readFileSync(second.path!).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    // The renamed original was not overwritten.
    expect(readFileSync(moved).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('never repeats a generated path, however many exports run', async () => {
    const csv = 'Account,Debit,Credit\nacc-bank,23000.00,0.00'
    const paths: string[] = []
    // Frozen clock: with `Date.now()` no longer moving, uniqueness cannot come
    // from the stamp at all — only from the monotonic sequence.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await session.invoke<{ ok: boolean; path?: string }>(
          BOOKS_CHANNELS.exportToSheets,
          'Trial Balance',
          csv,
        )
        expect(result.ok).toBe(true)
        paths.push(result.path!)
        // Free the name immediately: uniqueness must not depend on the file
        // still being there.
        rmSync(result.path!, { force: true })
      }
    } finally {
      vi.useRealTimers()
    }
    expect(new Set(paths).size).toBe(200)
  })
})

describe('durability: the audit trail names an actor', () => {
  let session: BooksE2ESession

  beforeEach(async () => {
    session = await bootBooksE2E()
  })

  afterEach(() => {
    session?.dispose()
  })

  it('stamps the OS user onto entries the renderer could not attribute', async () => {
    expect(await session.saveData(emptyLedger())).toBe(true)
    const issued = session.modules.issueSalesInvoiceInBooks({
      booksDataPath: session.booksDataPath,
      partyName: 'Rand Water Authority',
      itemDescription: 'Work',
      amount: 23000,
      date: '2026-08-05',
    })
    expect(issued.ok).toBe(true)

    // A renderer-saved entry arrives with no actor at all.
    const stored = (await session.loadData())!
    const anonymous: BooksDataEnvelope = {
      ...stored,
      auditLog: [
        {
          id: 'audit-anon',
          timestamp: new Date().toISOString(),
          action: 'settings.update',
          summary: 'Updated settings',
        },
        ...(stored.auditLog ?? []),
      ],
    }
    expect(await session.saveData(anonymous)).toBe(true)

    const audit = session.readStoredData().auditLog ?? []
    expect(audit.length).toBeGreaterThan(0)
    for (const entry of audit) {
      expect(entry.actor).toBeTruthy()
    }
  })
})

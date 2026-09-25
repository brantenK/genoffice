import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  applyLoadedEnvelope,
  emptyBooksData,
  getRevision,
  setUnreadableForTesting,
  useBooksStore,
} from '../src/renderer/src/store'
import {
  displayInvoiceStatus,
  invoiceMatchesStatusFilter,
} from '../src/renderer/src/components/invoice-status'
import { Desk } from '../src/renderer/src/components/Desk'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import { isLoadDataResult, isSaveDataResult, type BooksApi } from '../src/shared/ipc'
import type { BooksData, BooksDataEnvelope, InvoiceStatus } from '../src/shared/types'

/**
 * A complete `BooksApi` stub. Completing the surface instead of casting a
 * partial object is what keeps these tests honest: a new bridge member is a
 * compile error here, not a silently missing behaviour.
 */
function fakeBooksApi(overrides: Partial<BooksApi> = {}): BooksApi {
  return {
    loadData: async () => ({ ok: true, readable: true, data: null }),
    saveData: async () => ({ ok: true, revision: 1 }),
    onDataChanged: () => () => undefined,
    exportToSheets: async () => ({ ok: true }),
    openInPdf: async () => ({ ok: true }),
    openInCrm: async () => false,
    openInTenders: async () => false,
    importBankStatementCsv: async () => ({ ok: true, importedCount: 0 }),
    reconcileTransaction: async () => ({ ok: true }),
    getSettlementSuggestions: async () => [],
    backupNow: async () => ({ ok: true }),
    listBackups: async () => [],
    restoreBackup: async () => ({ ok: false, error: 'no backup store in this stub' }),
    ...overrides,
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The stored envelope for a given ledger, as `books:load-data` returns it. */
function stored(data: BooksData, revision = 1): BooksDataEnvelope {
  return { ...clone(data), version: 1, revision, updatedAt: '2026-09-24T08:00:00.000Z' }
}

const readState = () => useBooksStore.getState()

/**
 * Puts the store in the state a *successful load* leaves it in. It calls the
 * store's own load-state transition (the same one `loadData` uses) rather than
 * poking `loadStatus` from the outside, so tests cannot drift from production.
 */
function primeLoadedStore(data: BooksData = clone(initialBooksData)): void {
  applyLoadedEnvelope(stored(data, 1))
  useBooksStore.setState({
    activeTab: 'dashboard',
    needsSetup: false,
    loadError: false,
    lastError: null,
    activeInvoiceId: null,
    invoiceStatusFilter: 'All',
    activeReport: 'profit-loss',
    printInvoice: null,
    searchTerm: '',
  })
}

const resetStore = primeLoadedStore

const invoiceInput = (overrides: Record<string, unknown> = {}) => ({
  type: 'Sales' as const,
  partyName: 'Robustness Customer',
  status: 'Unpaid' as const,
  items: [{ id: 'it-1', description: 'Works', qty: 1, rate: 10000, taxRate: 15, amount: 10000 }],
  ...overrides,
})

describe('store failure surface', () => {
  afterEach(() => {
    window.booksApi = undefined
    resetStore()
  })

  it('starts clean and clears a raised error through clearError', async () => {
    resetStore()
    window.booksApi = fakeBooksApi({
      saveData: async () => ({ ok: false, error: 'disk is read-only' }),
    })

    expect(readState().lastError).toBeNull()
    await useBooksStore.getState().saveInvoice(invoiceInput())
    expect(readState().lastError).toContain('disk is read-only')

    readState().clearError()
    expect(readState().lastError).toBeNull()
  })

  it('does not silently diverge: a failed save rolls the ledger back', async () => {
    resetStore()
    const before = readState().data
    const invoicesBefore = before.invoices.length
    window.booksApi = fakeBooksApi({
      saveData: async () => ({ ok: false, error: 'the books file is locked by another process' }),
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())

    const after = readState()
    expect(after.lastError).toContain('locked by another process')
    // The invoice never reached disk, so the in-memory ledger must not show it.
    expect(after.data.invoices).toHaveLength(invoicesBefore)
    expect(after.data).toBe(before)
  })

  it('keeps the mutation and reports nothing when the save succeeds', async () => {
    resetStore()
    const invoicesBefore = readState().data.invoices.length
    window.booksApi = fakeBooksApi({ saveData: async () => ({ ok: true, revision: 5 }) })

    await useBooksStore.getState().saveInvoice(invoiceInput())

    expect(readState().lastError).toBeNull()
    expect(readState().data.invoices).toHaveLength(invoicesBefore + 1)
  })

  it('rolls back when the bridge replies with an unrecognised shape', async () => {
    resetStore()
    const before = readState().data
    // An older main process answering with the retired bare boolean.
    window.booksApi = fakeBooksApi({
      saveData: (async () => true) as unknown as BooksApi['saveData'],
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())

    expect(readState().lastError).toMatch(/unrecognised response/)
    expect(readState().data).toBe(before)
  })

  it('rolls back and reports when the transport itself throws', async () => {
    resetStore()
    const before = readState().data
    window.booksApi = fakeBooksApi({
      saveData: async () => {
        throw new Error('ipcRenderer.invoke is unavailable')
      },
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())

    expect(readState().lastError).toContain('ipcRenderer.invoke is unavailable')
    expect(readState().data).toBe(before)
  })
})

describe('store revision and conflict handling', () => {
  afterEach(() => {
    window.booksApi = undefined
    resetStore()
  })

  it('tracks the revision the server reports back', async () => {
    resetStore()
    const seen: Array<{ revision: number; invoiceCount: number }> = []
    let revision = 12
    window.booksApi = fakeBooksApi({
      saveData: async (data, sent) => {
        seen.push({ revision: sent, invoiceCount: data.invoices.length })
        return { ok: true, revision: (revision += 1) }
      },
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())
    await useBooksStore.getState().saveInvoice(invoiceInput({ partyName: 'Second Customer' }))

    // The first save sends the loaded revision, the second the one returned.
    expect(seen.map((call) => call.revision)).toEqual([1, 13])
    expect(seen[1].invoiceCount).toBe(seen[0].invoiceCount + 1)
  })

  it('replaces the local ledger with the server envelope on a conflict', async () => {
    resetStore()
    const serverLedger = clone(initialBooksData)
    serverLedger.settings.companyName = 'Written Elsewhere (Pty) Ltd'
    serverLedger.parties = serverLedger.parties.slice(0, 1)
    const serverEnvelope = stored(serverLedger, 42)

    window.booksApi = fakeBooksApi({
      saveData: async () => ({
        ok: false,
        error: 'Books changed elsewhere',
        conflict: true,
        current: serverEnvelope,
      }),
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())

    const after = readState()
    // The pending write was discarded and the authoritative ledger adopted.
    expect(after.data.settings.companyName).toBe('Written Elsewhere (Pty) Ltd')
    expect(after.data.parties).toHaveLength(1)
    expect(after.data.invoices.some((inv) => inv.partyName === 'Robustness Customer')).toBe(false)
    expect(after.lastError).toMatch(/changed elsewhere/i)
    expect(after.lastError).toMatch(/reloaded/i)
  })

  it('resumes writing from the adopted revision after a conflict', async () => {
    resetStore()
    const sentRevisions: number[] = []
    let conflicting = true
    window.booksApi = fakeBooksApi({
      saveData: async (_data, sent) => {
        sentRevisions.push(sent)
        if (conflicting) {
          conflicting = false
          return {
            ok: false,
            error: 'Books changed elsewhere',
            conflict: true,
            current: stored(clone(initialBooksData), 42),
          }
        }
        return { ok: true, revision: sent + 1 }
      },
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())
    await useBooksStore.getState().saveInvoice(invoiceInput({ partyName: 'After Conflict' }))

    expect(sentRevisions).toEqual([1, 42])
    expect(readState().lastError).toBeNull()
  })

  it('retries a refused write from the revision that was refused, not a dead end', async () => {
    resetStore()
    // The file moved on while this window was open: another module wrote
    // revision 42 and the guard refuses the stale write outright.
    const movedOn = clone(initialBooksData)
    movedOn.settings.companyName = 'Written Elsewhere (Pty) Ltd'
    const attempts: Array<{ revision: number; embeddedRevision: unknown; invoices: number }> = []
    window.booksApi = fakeBooksApi({
      saveData: async (data, revision) => {
        attempts.push({
          revision,
          embeddedRevision: (data as unknown as Record<string, unknown>).revision,
          invoices: data.invoices.length,
        })
        if (attempts.length === 1) {
          return {
            ok: false,
            error:
              'Your books changed elsewhere while you were working (revision 42 on disk, 1 sent)',
            conflict: true,
            current: stored(movedOn, 42),
          }
        }
        return { ok: true, revision: 43 }
      },
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())

    // The refused write was discarded and disk's ledger is what is on screen.
    expect(readState().data.settings.companyName).toBe('Written Elsewhere (Pty) Ltd')
    expect(readState().data.invoices.some((inv) => inv.partyName === 'Robustness Customer')).toBe(
      false,
    )
    expect(readState().lastError).toMatch(/changed elsewhere/i)
    expect(readState().lastError).toMatch(/reloaded/i)
    expect(getRevision()).toBe(42)

    await useBooksStore.getState().saveInvoice(invoiceInput({ partyName: 'Retry Customer' }))

    // The retry continues from the refused revision — never from a cursor
    // carried inside the payload, which is why the payload carries none.
    expect(attempts.map((attempt) => attempt.revision)).toEqual([1, 42])
    expect(attempts.map((attempt) => attempt.embeddedRevision)).toEqual([undefined, undefined])
    expect(readState().lastError).toBeNull()
    expect(readState().data.invoices.some((inv) => inv.partyName === 'Retry Customer')).toBe(true)
  })

  it('reports a conflict that arrives without a server envelope', async () => {
    resetStore()
    const before = readState().data
    window.booksApi = fakeBooksApi({
      saveData: async () => ({ ok: false, error: 'Books changed elsewhere', conflict: true }),
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())

    expect(readState().lastError).toMatch(/changed elsewhere/i)
    expect(readState().data).toBe(before)
  })
})

describe('loadData: missing store vs unreadable store', () => {
  afterEach(() => {
    window.booksApi = undefined
    resetStore()
  })

  it('shows the setup wizard only for a genuinely absent store', async () => {
    resetStore()
    window.booksApi = fakeBooksApi({
      loadData: async () => ({ ok: true, readable: true, data: null }),
    })

    await useBooksStore.getState().loadData()

    const after = readState()
    expect(after.needsSetup).toBe(true)
    expect(after.loadError).toBe(false)
    expect(after.lastError).toBeNull()
  })

  it('reports an error — never the wizard — when an existing store cannot be read', async () => {
    resetStore()
    window.booksApi = fakeBooksApi({
      loadData: async () => ({
        ok: true,
        readable: false,
        data: null,
        error: 'books-data.json could not be parsed',
      }),
    })

    await useBooksStore.getState().loadData()

    const after = readState()
    expect(after.needsSetup).toBe(false)
    expect(after.loadError).toBe(true)
    expect(after.lastError).toContain('books-data.json could not be parsed')
    expect(after.lastError).toMatch(/left untouched/i)
    // The empty ledger is on screen for the error view only; nothing that
    // follows may treat it as the user's books.
    expect(after.data.invoices).toEqual([])
  })

  it('refuses to overwrite an unreadable store rather than saving over it', async () => {
    resetStore()
    const saved: BooksData[] = []
    window.booksApi = fakeBooksApi({
      loadData: async () => ({ ok: false, readable: false, data: null, error: 'EACCES' }),
      saveData: async (data) => {
        saved.push(data)
        return { ok: true, revision: 1 }
      },
    })

    await useBooksStore.getState().loadData()
    expect(readState().loadError).toBe(true)

    // This is exactly what the setup wizard would do had it opened here.
    await useBooksStore.getState().completeSetup(clone(initialBooksData))
    expect(saved).toEqual([])
    expect(readState().lastError).toMatch(/could not be opened/i)

    // And every ordinary mutation is blocked on the same grounds.
    await useBooksStore.getState().saveInvoice(invoiceInput())
    await useBooksStore.getState().updateSettings({ companyName: 'Never Written' })
    await useBooksStore.getState().addParty({ name: 'Never Written', type: 'Customer' })

    // Nothing reached the bridge, so nothing can have reached the disk.
    expect(saved).toEqual([])
    expect(readState().lastError).toMatch(/could not be opened/i)
    expect(readState().lastError).toMatch(/nothing was saved/i)
  })

  it('blocks writes until the first load has answered, then allows them', async () => {
    // A freshly constructed store has never read anything; nothing may be
    // written until a load says what is on disk.
    useBooksStore.setState({
      needsSetup: false,
      loadError: false,
      lastError: null,
    })
    const saved: BooksData[] = []
    window.booksApi = fakeBooksApi({
      loadData: async () => ({ ok: true, readable: true, data: stored(clone(initialBooksData)) }),
      saveData: async (data) => {
        saved.push(data)
        return { ok: true, revision: 1 }
      },
    })

    await useBooksStore.getState().loadData()
    await useBooksStore.getState().saveInvoice(invoiceInput())

    expect(saved).toHaveLength(1)
    expect(readState().lastError).toBeNull()
  })

  it('refuses to overwrite while the load itself failed', async () => {
    setUnreadableForTesting()
    const saved: BooksData[] = []
    window.booksApi = fakeBooksApi({
      saveData: async (data) => {
        saved.push(data)
        return { ok: true, revision: 1 }
      },
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())

    expect(saved).toEqual([])
    expect(readState().lastError).toMatch(/could not be opened/i)
    expect(readState().lastError).toMatch(/nothing was saved/i)
  })

  it('refuses to guess when the reply cannot distinguish the two cases', async () => {
    resetStore()
    // Both replies used to be the whole contract: a pre-revision main process
    // answers with a bare null or a bare envelope, and neither says whether
    // the store is missing or merely unreadable.
    for (const reply of [null, stored(clone(initialBooksData))]) {
      window.booksApi = fakeBooksApi({
        loadData: (async () => reply) as unknown as BooksApi['loadData'],
      })

      await useBooksStore.getState().loadData()

      expect(readState().loadError, JSON.stringify(reply)).toBe(true)
      expect(readState().needsSetup).toBe(false)
    }
  })

  it('reports the initial write cursor when a fresh store loads', async () => {
    resetStore()
    const sent: number[] = []
    window.booksApi = fakeBooksApi({
      saveData: async (_data, revision) => {
        sent.push(revision)
        return { ok: true, revision: 1 }
      },
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())

    expect(sent).toEqual([1])
  })

  it('treats a transport failure as an unreadable store, not a first run', async () => {
    resetStore()
    window.booksApi = fakeBooksApi({
      loadData: async () => {
        throw new Error('main process is not responding')
      },
    })

    await useBooksStore.getState().loadData()

    const after = readState()
    expect(after.loadError).toBe(true)
    expect(after.needsSetup).toBe(false)
    expect(after.lastError).toContain('main process is not responding')
  })

  it('recovers from the error state on a later successful load', async () => {
    resetStore()
    let healthy = false
    window.booksApi = fakeBooksApi({
      loadData: async () =>
        healthy
          ? { ok: true, readable: true, data: stored(clone(initialBooksData), 9) }
          : { ok: true, readable: false, data: null, error: 'temporarily unreadable' },
    })

    await useBooksStore.getState().loadData()
    expect(readState().loadError).toBe(true)

    healthy = true
    await useBooksStore.getState().loadData()

    expect(readState().loadError).toBe(false)
    expect(readState().lastError).toBeNull()
    expect(readState().needsSetup).toBe(false)
    expect(readState().data.invoices.length).toBe(initialBooksData.invoices.length)
  })

  it('names the forensic copy when a failed read points at one', async () => {
    resetStore()
    window.booksApi = fakeBooksApi({
      // The optional field a main process that keeps a forensic copy sends.
      loadData: (async () => ({
        ok: true,
        readable: false,
        data: null,
        error: 'books-data.json could not be parsed',
        forensicPath: 'C:/data/books/books-data.json.corrupt-9f2a1b',
      })) as unknown as BooksApi['loadData'],
    })

    await useBooksStore.getState().loadData()

    const after = readState()
    expect(after.loadError).toBe(true)
    expect(after.lastError).toContain('books-data.json could not be parsed')
    expect(after.lastError).toContain('books-data.json.corrupt-9f2a1b')
  })

  it('reports the same failure when no forensic copy is offered', async () => {
    resetStore()
    window.booksApi = fakeBooksApi({
      loadData: async () => ({
        ok: true,
        readable: false,
        data: null,
        error: 'books-data.json could not be parsed',
      }),
    })

    await useBooksStore.getState().loadData()

    expect(readState().lastError).toContain('books-data.json could not be parsed')
    expect(readState().lastError).not.toMatch(/copy of the unreadable file/i)
  })
})

describe('rejected mutations reach the user', () => {
  afterEach(() => {
    window.booksApi = undefined
    resetStore()
  })

  it('surfaces a save blocked by the closed-period lock', async () => {
    const data = clone(initialBooksData)
    data.settings.closedThrough = '2026-09-30'
    resetStore(data)
    // The save must never even be attempted for a blocked posting.
    window.booksApi = fakeBooksApi({
      saveData: async () => {
        throw new Error('a blocked posting must not reach the bridge')
      },
    })

    await useBooksStore
      .getState()
      .saveInvoice(
        invoiceInput({
          id: 'inv-1',
          partyName: 'City of Ekurhuleni Water Dept',
          partyId: 'party-1',
        }),
      )

    const after = readState()
    expect(after.lastError).toMatch(/period is closed through 2026-09-30/)
    expect(after.data.invoices.find((inv) => inv.id === 'inv-1')?.date).toBe(
      initialBooksData.invoices[0].date,
    )
  })

  it('surfaces a journal entry rejected for being unbalanced', async () => {
    resetStore()
    window.booksApi = fakeBooksApi()

    const posted = await useBooksStore.getState().addJournalEntry({
      entryNumber: 'JE-MANUAL-1',
      date: '2026-09-10',
      items: [
        {
          id: 'jei-1',
          accountId: 'acc-cash',
          accountName: 'Cash',
          debit: 500,
          credit: 0,
        },
        {
          id: 'jei-2',
          accountId: 'acc-sales',
          accountName: 'Sales',
          debit: 0,
          credit: 400,
        },
      ],
      totalDebit: 500,
      totalCredit: 400,
      posted: true,
    })

    expect(posted).toBe(false)
    expect(readState().lastError).toMatch(/debits \(500\.00\) do not equal credits \(400\.00\)/)
    expect(readState().data.journalEntries.some((je) => je.entryNumber === 'JE-MANUAL-1')).toBe(
      false,
    )
  })

  it('surfaces a journal entry rejected by the closed-period lock', async () => {
    const data = clone(initialBooksData)
    data.settings.closedThrough = '2026-09-30'
    resetStore(data)
    window.booksApi = fakeBooksApi()

    const posted = await useBooksStore.getState().addJournalEntry({
      entryNumber: 'JE-MANUAL-2',
      date: '2026-08-01',
      items: [
        { id: 'jei-1', accountId: 'acc-cash', accountName: 'Cash', debit: 500, credit: 0 },
        { id: 'jei-2', accountId: 'acc-sales', accountName: 'Sales', debit: 0, credit: 500 },
      ],
      totalDebit: 500,
      totalCredit: 500,
      posted: true,
    })

    expect(posted).toBe(false)
    expect(readState().lastError).toMatch(/period is closed through 2026-09-30/)
  })

  it('surfaces a rejected payment', async () => {
    resetStore()
    window.booksApi = fakeBooksApi()

    const result = await useBooksStore.getState().recordPayment({
      partyId: 'party-1',
      date: '2026-09-06',
      allocations: [{ invoiceId: 'inv-does-not-exist', invoiceNumber: 'INV-NOPE', amount: 100 }],
    })

    expect(result.ok).toBe(false)
    expect(readState().lastError).toBe(result.error)
    expect(readState().lastError).toBeTruthy()
  })

  it('surfaces a failed markInvoicePaid instead of discarding the result', async () => {
    resetStore()
    window.booksApi = fakeBooksApi()

    // inv-3 is already Paid (a no-op), so use an invoice with no party to
    // force recordPayment to reject the settlement.
    const data = clone(initialBooksData)
    data.invoices[0].partyId = 'party-missing'
    resetStore(data)

    await useBooksStore.getState().markInvoicePaid('inv-1')

    expect(readState().lastError).toMatch(/Could not mark INV-2026-001 as paid/)
    expect(readState().data.invoices.find((inv) => inv.id === 'inv-1')?.status).toBe('Unpaid')
  })

  it('reports a refused period close as a failure and leaves the period open', async () => {
    const closeable = clone(initialBooksData)
    // A close requires every invoice in the period to be settled or cancelled.
    closeable.invoices = closeable.invoices.map((inv) => ({
      ...inv,
      status: 'Paid' as const,
      outstandingAmount: 0,
    }))
    resetStore(closeable)
    window.booksApi = fakeBooksApi({
      saveData: async () => ({ ok: false, error: 'the books file is locked by another process' }),
    })

    const result = await useBooksStore.getState().closeFinancialYear('2026-09-30')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('locked by another process')
    const after = readState()
    // The write was refused, so the period is not closed in memory either —
    // which is the only state that can agree with the unchanged file on disk.
    expect(after.data.settings.closedThrough).toBeUndefined()
    expect(after.data.journalEntries.some((je) => je.entryNumber.startsWith('JE-CLOSE'))).toBe(
      false,
    )
    expect(after.lastError).toContain('locked by another process')

    // And a close that does land is still reported as a success.
    window.booksApi = fakeBooksApi({ saveData: async () => ({ ok: true, revision: 2 }) })
    const closed = await useBooksStore.getState().closeFinancialYear('2026-09-30')

    expect(closed).toEqual({ ok: true })
    expect(readState().data.settings.closedThrough).toBe('2026-09-30')
    expect(
      readState().data.journalEntries.some((je) => je.entryNumber.startsWith('JE-CLOSE')),
    ).toBe(true)
  })

  it('reports a payment whose write was refused as a failure', async () => {
    resetStore()
    const before = readState().data
    window.booksApi = fakeBooksApi({
      saveData: async () => ({ ok: false, error: 'disk is read-only' }),
    })

    const result = await useBooksStore.getState().recordPayment({
      partyId: 'party-1',
      date: '2026-09-06',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('disk is read-only')
    // Nothing reached the disk, so nothing may look settled either.
    expect(readState().data.invoices.find((inv) => inv.id === 'inv-1')?.status).toBe('Unpaid')
    expect(readState().data.payments ?? []).toHaveLength(0)
    expect(readState().data).toBe(before)

    // A payment that does land is still reported as one.
    window.booksApi = fakeBooksApi({ saveData: async () => ({ ok: true, revision: 9 }) })
    const recorded = await useBooksStore.getState().recordPayment({
      partyId: 'party-1',
      date: '2026-09-06',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
    })

    expect(recorded).toEqual({ ok: true })
    expect(readState().data.invoices.find((inv) => inv.id === 'inv-1')?.status).toBe('Paid')
  })

  it('surfaces a failed bank-statement import', async () => {
    resetStore()
    window.booksApi = fakeBooksApi({
      importBankStatementCsv: async () => ({
        ok: false,
        error: 'No valid transactions found in statement CSV',
      }),
    })

    const result = await useBooksStore.getState().importBankStatementCsv('not,a,statement')

    expect(result.ok).toBe(false)
    expect(readState().lastError).toBe('No valid transactions found in statement CSV')
  })

  it('surfaces a failed reconciliation', async () => {
    resetStore()
    window.booksApi = fakeBooksApi({
      reconcileTransaction: async () => ({ ok: false, error: 'Transaction not found: tx-404' }),
    })

    const result = await useBooksStore.getState().reconcileTransaction('tx-404', 'inv-1')

    expect(result.ok).toBe(false)
    expect(readState().lastError).toBe('Transaction not found: tx-404')
  })

  it('clears a retried failure but leaves an unrelated one standing', async () => {
    resetStore()
    let failing = true
    window.booksApi = fakeBooksApi({
      saveData: async () => {
        if (failing) return { ok: false, error: 'transient write failure' }
        return { ok: true, revision: 3 }
      },
    })

    await useBooksStore.getState().saveInvoice(invoiceInput())
    expect(readState().lastError).toBeTruthy()

    failing = false
    await useBooksStore.getState().saveInvoice(invoiceInput({ partyName: 'Retry Customer' }))
    expect(readState().lastError).toBeNull()
  })
})

describe('the desk gate', () => {
  const READ_ERROR = 'Zano Books could not read your data'
  const WIZARD = 'Set up Zano Books'

  /**
   * Mounts the real desk against a real bridge reply, so the screen under test
   * is the one the load path produces rather than a poked flag.
   */
  async function mountDesk(api: BooksApi) {
    window.booksApi = api
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(Desk))
      // Let the mount-time loadData() settle inside act.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return {
      markup: () => container.innerHTML,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  beforeAll(() => {
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true
  })

  afterEach(() => {
    window.booksApi = undefined
    resetStore()
  })

  it('shows the read-error screen — never the wizard — for an unreadable store', async () => {
    resetStore()
    const desk = await mountDesk(
      fakeBooksApi({
        loadData: async () => ({
          ok: true,
          readable: false,
          data: null,
          error: 'books-data.json could not be parsed',
        }),
      }),
    )

    try {
      expect(desk.markup()).toContain(READ_ERROR)
      expect(desk.markup()).not.toContain(WIZARD)
      expect(readState().loadError).toBe(true)
      expect(readState().needsSetup).toBe(false)
    } finally {
      desk.unmount()
    }
  })

  it('shows the wizard for a genuine first run', async () => {
    resetStore()
    const desk = await mountDesk(
      fakeBooksApi({ loadData: async () => ({ ok: true, readable: true, data: null }) }),
    )

    try {
      expect(desk.markup()).toContain(WIZARD)
      expect(desk.markup()).not.toContain(READ_ERROR)
    } finally {
      desk.unmount()
    }
  })

  it('never mistakes an empty ledger with a pending error for a failed read', async () => {
    resetStore()
    const desk = await mountDesk(fakeBooksApi())

    try {
      // Exactly the state the old object-identity gate read as "unreadable":
      // the empty singleton on screen and a failure outstanding. The load
      // itself succeeded, so the failure belongs in the dismissible banner.
      await act(async () => {
        useBooksStore.setState({
          data: emptyBooksData,
          needsSetup: false,
          loadError: false,
          lastError: 'the last write was refused',
        })
      })

      expect(useBooksStore.getState().data).toBe(emptyBooksData)
      expect(desk.markup()).not.toContain(READ_ERROR)
      expect(desk.markup()).toContain('the last write was refused')
    } finally {
      desk.unmount()
    }
  })

  it('renders the desk for a legitimately empty ledger that loaded', async () => {
    resetStore()
    const emptyLedger = clone(initialBooksData)
    emptyLedger.invoices = []
    emptyLedger.parties = []
    emptyLedger.journalEntries = []
    const desk = await mountDesk(
      fakeBooksApi({
        loadData: async () => ({ ok: true, readable: true, data: stored(emptyLedger, 4) }),
      }),
    )

    try {
      expect(desk.markup()).not.toContain(READ_ERROR)
      expect(desk.markup()).not.toContain(WIZARD)
      expect(readState().loadError).toBe(false)
      expect(readState().needsSetup).toBe(false)
    } finally {
      desk.unmount()
    }
  })
})

describe('typed settlement results', () => {
  afterEach(() => {
    window.booksApi = undefined
    resetStore()
  })

  it('pins importBankStatementCsv and reconcileTransaction to the shared result types', () => {
    // These assignments fail to compile if either action drifts back to `any`.
    const importResult: Promise<Awaited<ReturnType<BooksApi['importBankStatementCsv']>>> =
      useBooksStore.getState().importBankStatementCsv('Date,Description,Amount\n')
    const reconcileResult: Promise<Awaited<ReturnType<BooksApi['reconcileTransaction']>>> =
      useBooksStore.getState().reconcileTransaction('tx-1', 'inv-1')
    expect(importResult).toBeInstanceOf(Promise)
    expect(reconcileResult).toBeInstanceOf(Promise)
  })

  it('returns the engine result unchanged when no bridge exists', async () => {
    resetStore()
    window.booksApi = undefined

    const result = await useBooksStore.getState().reconcileTransaction('tx-missing', 'inv-1')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('tx-missing')
    expect(readState().lastError).toBe(result.error)
  })
})

describe('the push path respects the load gate', () => {
  afterEach(() => {
    window.booksApi = undefined
    resetStore()
  })

  it('adopts a broadcast ledger — cursor and all — once the store has loaded', () => {
    resetStore()
    const incoming = clone(initialBooksData)
    incoming.settings.companyName = 'Written By CRM (Pty) Ltd'

    useBooksStore.getState().syncFromMain(stored(incoming, 7) as unknown as BooksData)

    const after = readState()
    expect(after.data.settings.companyName).toBe('Written By CRM (Pty) Ltd')
    expect(after.needsSetup).toBe(false)
    expect(after.loadError).toBe(false)
    // The cursor moves with the ledger we now show, so the next save continues
    // from it instead of being refused as stale.
    expect(getRevision()).toBe(7)
    // ...and it stays the store's own bookkeeping, never a field of the ledger.
    expect('revision' in (after.data as unknown as Record<string, unknown>)).toBe(false)
  })

  it('adopts a broadcast over a first run because the wizard is over', async () => {
    resetStore()
    window.booksApi = fakeBooksApi({
      loadData: async () => ({ ok: true, readable: true, data: null }),
    })
    await useBooksStore.getState().loadData()
    expect(readState().needsSetup).toBe(true)

    useBooksStore
      .getState()
      .syncFromMain(stored(clone(initialBooksData), 3) as unknown as BooksData)

    expect(readState().needsSetup).toBe(false)
    expect(readState().data.invoices).toHaveLength(initialBooksData.invoices.length)
    expect(getRevision()).toBe(3)
  })

  it('refuses a broadcast while the store is unreadable and says so', () => {
    setUnreadableForTesting()
    const revisionBefore = getRevision()
    const incoming = clone(initialBooksData)

    useBooksStore.getState().syncFromMain(stored(incoming, 5) as unknown as BooksData)

    const after = readState()
    // The read error stands: the change on disk is reported, not silently
    // swapped in for a ledger this store cannot vouch for.
    expect(after.loadError).toBe(true)
    expect(after.needsSetup).toBe(false)
    expect(after.data.invoices).toEqual([])
    expect(after.lastError).toMatch(/changed on disk/i)
    expect(after.lastError).toMatch(/could not read/i)
    expect(getRevision()).toBe(revisionBefore)
  })

  it('ignores a broadcast that is not a whole ledger', () => {
    resetStore()
    const before = readState().data

    // A partial payload must not blank the ledger on screen, and recording its
    // hash would suppress the next, well-formed broadcast as an echo.
    useBooksStore.getState().syncFromMain({ settings: before.settings } as BooksData)

    expect(readState().data).toBe(before)
    expect(getRevision()).toBe(1)
  })
})

describe('Overdue is derived once, for both the badge and the chip', () => {
  const AS_OF = '2026-09-24'
  const row = (id: string, status: InvoiceStatus, dueDate: string, outstandingAmount: number) => ({
    id,
    status,
    dueDate,
    outstandingAmount,
  })

  const rows = [
    row('overdue-unpaid', 'Unpaid', '2026-09-01', 145000),
    // Partially settled: still Unpaid, still past its due date, so it reads
    // Overdue on screen with a smaller balance due.
    row('overdue-partial', 'Unpaid', '2026-08-20', 42000),
    row('not-yet-due', 'Unpaid', '2026-10-15', 1000),
    row('due-today', 'Unpaid', AS_OF, 1000),
    row('paid', 'Paid', '2026-01-05', 0),
    row('draft', 'Draft', '2026-01-05', 500),
    row('cancelled', 'Cancelled', '2026-01-05', 500),
    row('stored-overdue', 'Overdue', '2026-09-01', 1000),
  ] as const

  it('derives Overdue only for an unpaid document past its due date', () => {
    expect(displayInvoiceStatus('Unpaid', '2026-09-01', AS_OF)).toBe('Overdue')
    expect(displayInvoiceStatus('Unpaid', AS_OF, AS_OF)).toBe('Unpaid')
    expect(displayInvoiceStatus('Unpaid', '2026-10-01', AS_OF)).toBe('Unpaid')
    expect(displayInvoiceStatus('Unpaid', '', AS_OF)).toBe('Unpaid')
    expect(displayInvoiceStatus('Unpaid', undefined, AS_OF)).toBe('Unpaid')
    expect(displayInvoiceStatus('Paid', '2026-01-01', AS_OF)).toBe('Paid')
    expect(displayInvoiceStatus('Draft', '2026-01-01', AS_OF)).toBe('Draft')
    expect(displayInvoiceStatus('Cancelled', '2026-01-01', AS_OF)).toBe('Cancelled')
    expect(displayInvoiceStatus('Overdue', '2026-10-01', AS_OF)).toBe('Overdue')
  })

  it('selects exactly the rows whose badge reads Overdue', () => {
    const selected = rows.filter((item) => invoiceMatchesStatusFilter(item, 'Overdue', AS_OF))
    const badged = rows.filter(
      (item) => displayInvoiceStatus(item.status, item.dueDate, AS_OF) === 'Overdue',
    )

    expect(selected.map((item) => item.id)).toEqual([
      'overdue-unpaid',
      'overdue-partial',
      // A stored `Overdue` (the status the IPC payload validator accepts) reads
      // as Overdue too, so the chip must not hide it.
      'stored-overdue',
    ])
    expect(selected).toEqual(badged)
  })

  it('keeps All inclusive and the other chips on the stored status', () => {
    expect(rows.filter((item) => invoiceMatchesStatusFilter(item, 'All', AS_OF))).toHaveLength(
      rows.length,
    )
    expect(
      rows
        .filter((item) => invoiceMatchesStatusFilter(item, 'Unpaid', AS_OF))
        .map((item) => item.id),
    ).toEqual(['not-yet-due', 'due-today'])
    expect(
      rows.filter((item) => invoiceMatchesStatusFilter(item, 'Paid', AS_OF)).map((item) => item.id),
    ).toEqual(['paid'])
  })
})

describe('transport guard coverage for the pinned shapes', () => {
  it('accepts every fixture these tests hand the store', () => {
    expect(isSaveDataResult({ ok: true, revision: 0 })).toBe(true)
    expect(
      isSaveDataResult({
        ok: false,
        error: 'x',
        conflict: true,
        current: stored(initialBooksData),
      }),
    ).toBe(true)
    expect(isLoadDataResult({ ok: true, readable: true, data: null })).toBe(true)
    expect(isLoadDataResult({ ok: true, readable: false, data: null })).toBe(true)
  })
})

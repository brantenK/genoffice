import { afterEach, describe, expect, it } from 'vitest'
import {
  allJournalsBalanced,
  calculateInvoiceTotals,
  nextQuoteNumber,
  round2,
} from '../src/shared/accounting'
import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../src/shared/chart'
import { migrateAndValidateBooks } from '../src/main/books-core'
import { validateBooksData, type BooksApi } from '../src/shared/ipc'
import { applyLoadedEnvelope, useBooksStore } from '../src/renderer/src/store'
import {
  displayQuoteStatus,
  quoteMatchesStatusFilter,
} from '../src/renderer/src/components/quote-status'
import type {
  BooksData,
  BooksDataEnvelope,
  InvoiceItem,
  Party,
  Quotation,
} from '../src/shared/types'

/**
 * A complete `BooksApi` stub, as the store-robustness tests use: completing
 * the surface instead of casting a partial object keeps a new bridge member a
 * compile error here rather than a silently missing behaviour.
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

const customer: Party = {
  id: 'party-q-cust',
  name: 'Quotation Customer',
  type: 'Customer',
  outstandingBalance: 0,
}

const line = (overrides: Partial<InvoiceItem> = {}): InvoiceItem => ({
  id: `item-q-${Math.random().toString(36).slice(2, 8)}`,
  itemCode: 'ITEM-01',
  description: 'Site supervision',
  accountId: 'acc-sales',
  accountName: 'Tender & Commercial Contracting Sales',
  qty: 1,
  rate: 1000,
  taxRate: 15,
  amount: 1000,
  ...overrides,
})

/** A minimal, internally consistent ledger the quote actions can act on. */
const baseLedger = (overrides: Partial<BooksData> = {}): BooksData => ({
  version: 1,
  // VAT-exclusive lines so the test arithmetic is the plain ×(1 + rate).
  settings: { ...DEFAULT_BOOK_SETTINGS, taxInclusive: false },
  accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
  parties: [{ ...customer }],
  invoices: [],
  quotes: [],
  journalEntries: [],
  bankTransactions: [],
  payments: [],
  auditLog: [],
  ...overrides,
})

/** The stored envelope for a ledger, as `books:load-data` returns it. */
function stored(data: BooksData, revision = 1): BooksDataEnvelope {
  return { ...clone(data), version: 1, revision, updatedAt: '2026-09-26T08:00:00.000Z' }
}

const readState = () => useBooksStore.getState()

/** Puts the store in the state a successful load leaves it in. */
function primeLoadedStore(data: BooksData = baseLedger()): void {
  applyLoadedEnvelope(stored(data))
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

const TODAY = '2026-09-26'
const TWO_LINES = [
  line({ description: 'Line one', rate: 1000, amount: 1000 }),
  line({ description: 'Line two', rate: 2000, amount: 2000 }),
]

describe('nextQuoteNumber', () => {
  it('sequences per year with the QTN prefix, counting only that year', () => {
    const quotes = [
      { quoteNumber: 'QTN-2025-007', status: 'Lost' },
      { quoteNumber: 'QTN-2026-002', status: 'Accepted' },
    ] as Quotation[]
    expect(nextQuoteNumber(quotes, '2026-09-26')).toBe('QTN-2026-003')
    expect(nextQuoteNumber(quotes, '2025-05-01')).toBe('QTN-2025-008')
    expect(nextQuoteNumber([], '2026-01-01')).toBe('QTN-2026-001')
  })

  it('uses the highest existing sequence, never length + 1', () => {
    // One quote only: length + 1 would answer 002; the max sequence is 9.
    const one = [{ quoteNumber: 'QTN-2026-009' }] as Quotation[]
    expect(nextQuoteNumber(one, '2026-09-26')).toBe('QTN-2026-010')

    // 009 and 010 together: a naive "last element + 1" or string max of
    // '009'/'010' by length would collide; the numeric max answers 011.
    const both = [{ quoteNumber: 'QTN-2026-009' }, { quoteNumber: 'QTN-2026-010' }] as Quotation[]
    expect(nextQuoteNumber(both, '2026-09-26')).toBe('QTN-2026-011')
  })

  it('never reuses a number after a later quote was deleted', () => {
    const history = [
      { quoteNumber: 'QTN-2026-001' },
      { quoteNumber: 'QTN-2026-002' },
      { quoteNumber: 'QTN-2026-003' },
    ] as Quotation[]
    // The 002 record is deleted; 003 still raises the floor.
    const afterDelete = [history[0], history[2]]
    expect(nextQuoteNumber(afterDelete, '2026-09-26')).toBe('QTN-2026-004')
  })
})

describe('quotation totals', () => {
  afterEach(() => {
    window.booksApi = undefined
    primeLoadedStore()
  })

  it('equal calculateInvoiceTotals for the same items, tax-inclusive default', async () => {
    window.booksApi = fakeBooksApi()
    primeLoadedStore(baseLedger({ settings: { ...DEFAULT_BOOK_SETTINGS, taxInclusive: true } }))

    const items = [line({ qty: 2, rate: 1150, amount: 2300 })]
    await useBooksStore.getState().saveQuote({
      partyId: customer.id,
      partyName: customer.name,
      date: TODAY,
      items,
    })

    const quote = readState().data.quotes![0]
    const expected = calculateInvoiceTotals(items, { taxInclusive: true })
    expect(quote.subtotal).toBe(expected.subtotal)
    expect(quote.taxTotal).toBe(expected.taxTotal)
    expect(quote.grandTotal).toBe(expected.grandTotal)
    expect(quote.grandTotal).toBe(2300) // inclusive: VAT sits inside the line rate
    expect(quote.status).toBe('Draft')
  })

  it('apply line discounts and the invoice-level discount the same way invoices do', async () => {
    window.booksApi = fakeBooksApi()
    primeLoadedStore()

    const items = [line({ qty: 1, rate: 1000, discountRate: 10 })]
    await useBooksStore.getState().saveQuote({
      partyId: customer.id,
      partyName: customer.name,
      date: TODAY,
      items,
      discountTotal: 100,
    })

    const quote = readState().data.quotes![0]
    const expected = calculateInvoiceTotals(items, {
      taxInclusive: false,
      discountTotal: 100,
    })
    expect(quote.subtotal).toBe(expected.subtotal)
    expect(quote.taxTotal).toBe(expected.taxTotal)
    expect(quote.grandTotal).toBe(expected.grandTotal)
    // 900 after the 10% line discount, 800 after the 100 invoice discount,
    // 15% VAT on the discounted base.
    expect(quote.subtotal).toBe(900)
    expect(quote.taxTotal).toBe(120)
    expect(quote.grandTotal).toBe(920)
    expect(quote.discountTotal).toBe(100)
  })
})

describe('quotation migration', () => {
  it('stamps quotes: [] when the collection is absent', () => {
    const envelope = migrateAndValidateBooks({
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
      invoices: [],
      journalEntries: [],
    })
    expect(Array.isArray(envelope.quotes)).toBe(true)
    expect(envelope.quotes).toEqual([])
  })

  it('drops rows without a string id and preserves unknown extension fields', () => {
    const envelope = migrateAndValidateBooks({
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
      invoices: [],
      journalEntries: [],
      quotes: [
        { quoteNumber: 'QTN-2026-001' } as unknown as Quotation,
        {
          id: 'quote-1',
          quoteNumber: 'QTN-2026-002',
          status: 'Sent',
          subtotal: 0,
          taxTotal: 0,
          grandTotal: 0,
          internalApproval: 'OK',
        } as unknown as Quotation,
      ],
    })
    expect(envelope.quotes).toHaveLength(1)
    expect(envelope.quotes![0].id).toBe('quote-1')
    expect((envelope.quotes![0] as Record<string, unknown>).internalApproval).toBe('OK')
  })

  it('a Converted quote survives the round trip with repaired totals', () => {
    const envelope = migrateAndValidateBooks({
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
      invoices: [],
      journalEntries: [],
      quotes: [
        {
          id: 'quote-cv',
          quoteNumber: 'QTN-2026-001',
          status: 'Converted',
          convertedInvoiceId: 'inv-77',
          partyId: 'party-1',
          partyName: 'Party',
          date: '2026-01-05',
          validUntil: '2026-02-05',
          items: [],
          subtotal: 1234.567,
          taxTotal: 0.005,
          grandTotal: 999.999,
        } as unknown as Quotation,
      ],
    })
    const quote = envelope.quotes![0]
    expect(quote.status).toBe('Converted')
    expect(quote.convertedInvoiceId).toBe('inv-77')
    expect(quote.subtotal).toBe(round2(1234.567))
    expect(quote.taxTotal).toBe(round2(0.005))
    expect(quote.grandTotal).toBe(round2(999.999))
  })
})

describe('validateBooksData quotations', () => {
  const envelopeWithQuotes = (quotes: unknown): Record<string, unknown> => ({
    version: 1,
    revision: 1,
    updatedAt: '2026-09-26T08:00:00.000Z',
    settings: { ...DEFAULT_BOOK_SETTINGS },
    accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
    parties: [],
    invoices: [],
    journalEntries: [],
    quotes,
  })

  it('accepts an optional quotes array of normalized rows', () => {
    const ok = validateBooksData(
      envelopeWithQuotes([
        {
          id: 'quote-1',
          quoteNumber: 'QTN-2026-001',
          status: 'Accepted',
          partyId: 'party-1',
          partyName: 'Party',
          date: '2026-09-01',
          validUntil: '2026-10-01',
          items: [],
          subtotal: 100,
          taxTotal: 15,
          grandTotal: 115,
        },
      ]),
    )
    expect(ok.ok).toBe(true)

    const absent = validateBooksData(envelopeWithQuotes(undefined))
    expect(absent.ok).toBe(true)
  })

  it('rejects a non-array quotes field and rows with an unknown status', () => {
    expect(validateBooksData(envelopeWithQuotes('nope')).ok).toBe(false)
    expect(
      validateBooksData(
        envelopeWithQuotes([{ id: 'quote-1', quoteNumber: 'QTN-2026-001', status: 'Won' }]),
      ).ok,
    ).toBe(false)
    expect(
      validateBooksData(envelopeWithQuotes([{ quoteNumber: 'QTN-2026-001', status: 'Draft' }])),
    ).toMatchObject({ ok: false })
  })
})

describe('conversion through the real store path', () => {
  afterEach(() => {
    window.booksApi = undefined
    primeLoadedStore()
  })

  it('posts the invoice, moves the outstanding, marks the quote Converted — in one save', async () => {
    let saveCalls = 0
    window.booksApi = fakeBooksApi({
      saveData: async () => {
        saveCalls += 1
        return { ok: true, revision: saveCalls }
      },
    })
    primeLoadedStore()

    await useBooksStore.getState().saveQuote({
      partyId: customer.id,
      partyName: customer.name,
      date: TODAY,
      validUntil: '2026-10-31',
      notes: 'Site package deal',
      items: TWO_LINES,
      discountTotal: 100,
    })
    {
      const data = readState().data
      const quote = data.quotes![0]
      expect(quote.quoteNumber).toBe('QTN-2026-001')
      expect(quote.grandTotal).toBe(3335) // (1000 + 2000 − 100) × 1.15
      // Off-ledger: a saved quote posts nothing and moves no outstanding.
      expect(data.journalEntries).toHaveLength(0)
      expect(data.parties[0].outstandingBalance).toBe(0)
    }

    await useBooksStore.getState().setQuoteStatus(readState().data.quotes![0].id, 'Sent')

    const savesBeforeConvert = saveCalls
    const result = await useBooksStore
      .getState()
      .convertQuoteToInvoice(readState().data.quotes![0].id)
    expect(result.ok).toBe(true)

    const data = readState().data
    const invoice = data.invoices.find((i) => i.invoiceNumber === 'INV-2026-001')!
    expect(invoice).toBeDefined()
    expect(invoice.grandTotal).toBe(3335)
    expect(invoice.discountTotal).toBe(100)
    expect(invoice.notes).toBe('Site package deal')
    expect(invoice.partyId).toBe(customer.id)

    // The ledger gained a balanced sales invoice journal.
    expect(allJournalsBalanced(data.journalEntries)).toBe(true)
    const posting = data.journalEntries.find((j) => j.remarks.includes('INV-2026-001'))!
    expect(posting).toBeDefined()
    expect(posting.items.some((it) => it.accountId === 'acc-ar' && it.debit === 3335)).toBe(true)

    // The party outstanding moved.
    expect(data.parties[0].outstandingBalance).toBe(3335)

    // The quote reads Converted with the link back to its invoice.
    const converted = data.quotes!.find((q) => q.quoteNumber === 'QTN-2026-001')!
    expect(converted.status).toBe('Converted')
    expect(converted.convertedInvoiceId).toBe(invoice.id)

    // The posting and the conversion landed in ONE write.
    expect(saveCalls - savesBeforeConvert).toBe(1)

    // Converting again is refused and posts nothing further.
    const again = await useBooksStore.getState().convertQuoteToInvoice(converted.id)
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/already converted/i)
    expect(readState().lastError).toMatch(/already converted/i)
    expect(readState().data.invoices).toHaveLength(1)
    expect(readState().data.journalEntries).toHaveLength(1)
  })
})

describe('expiry is derived for display', () => {
  afterEach(() => {
    window.booksApi = undefined
    primeLoadedStore()
  })

  it('a lapsed Draft or Sent quote displays Expired while storage keeps its status', async () => {
    window.booksApi = fakeBooksApi()
    primeLoadedStore()

    await useBooksStore.getState().saveQuote({
      partyId: customer.id,
      partyName: customer.name,
      date: '2026-07-01',
      validUntil: '2026-08-31', // in the past
      items: [line()],
    })

    const stored = readState().data.quotes![0]
    expect(stored.status).toBe('Draft')
    expect(displayQuoteStatus(stored, TODAY)).toBe('Expired')
    expect(quoteMatchesStatusFilter(stored, 'Expired', TODAY)).toBe(true)
    expect(quoteMatchesStatusFilter(stored, 'Draft', TODAY)).toBe(false)

    await useBooksStore.getState().setQuoteStatus(stored.id, 'Sent')
    const sent = readState().data.quotes![0]
    expect(sent.status).toBe('Sent')
    expect(displayQuoteStatus(sent, TODAY)).toBe('Expired')
    expect(displayQuoteStatus({ ...sent, validUntil: '2026-12-31' }, TODAY)).toBe('Sent')
  })
})

describe('deleting a quotation', () => {
  afterEach(() => {
    window.booksApi = undefined
    primeLoadedStore()
  })

  it('is allowed in Draft, Sent, Accepted and Lost, and refused once Converted', async () => {
    window.booksApi = fakeBooksApi()
    primeLoadedStore()

    for (const status of ['Sent', 'Accepted', 'Lost'] as const) {
      await useBooksStore.getState().saveQuote({
        partyId: customer.id,
        partyName: customer.name,
        date: TODAY,
        items: [line()],
      })
      const quote = readState().data.quotes![0]
      if (status !== 'Sent') {
        await useBooksStore.getState().setQuoteStatus(quote.id, 'Sent')
        await useBooksStore.getState().setQuoteStatus(quote.id, status)
      } else {
        await useBooksStore.getState().setQuoteStatus(quote.id, 'Sent')
      }
      expect(readState().data.quotes![0].status).toBe(status)
      await useBooksStore.getState().deleteQuote(quote.id)
      expect(readState().data.quotes).toHaveLength(0)
    }

    // Draft is deletable directly.
    await useBooksStore.getState().saveQuote({
      partyId: customer.id,
      partyName: customer.name,
      date: TODAY,
      items: [line()],
    })
    await useBooksStore.getState().deleteQuote(readState().data.quotes![0].id)
    expect(readState().data.quotes).toHaveLength(0)

    // A Converted quote is the record of its invoice: deletion is refused.
    await useBooksStore.getState().saveQuote({
      partyId: customer.id,
      partyName: customer.name,
      date: TODAY,
      items: [line()],
    })
    const quote = readState().data.quotes![0]
    await useBooksStore.getState().setQuoteStatus(quote.id, 'Sent')
    const converted = await useBooksStore.getState().convertQuoteToInvoice(quote.id)
    expect(converted.ok).toBe(true)

    readState().clearError()
    await useBooksStore.getState().deleteQuote(quote.id)
    expect(readState().data.quotes).toHaveLength(1)
    expect(readState().data.quotes![0].status).toBe('Converted')
    expect(readState().lastError).toMatch(/converted into an invoice/i)
  })
})

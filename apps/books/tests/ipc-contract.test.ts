/**
 * Zano Books IPC contract suite.
 *
 * The fixtures below pin what every `books:*` handler really resolves with
 * against the declared `BooksApi` surface: `satisfies` rejects a field the
 * declaration dropped (now an excess property) or retyped, and a field it
 * newly requires. `apps/books/tsconfig.json` includes only `src`, so the last
 * test in this file runs the TypeScript compiler over this file itself — that
 * is what makes those pins fail the suite when the declaration drifts again.
 *
 * The other half pins the runtime guards exported from `src/shared/ipc.ts`,
 * which a later stage applies in the main process before it trusts an IPC
 * payload.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import {
  BACKUP_NAME_PATTERN,
  BOOKS_CHANNELS,
  MAX_CSV_CHARS,
  MAX_ID_CHARS,
  isLoadDataResult,
  isSaveDataResult,
  validateBackupName,
  validateBooksData,
  validateCsvString,
  validateInvoicePayload,
  validateNonEmptyString,
  validateRevision,
  type BooksApi,
  type ValidationResult,
} from '../src/shared/ipc'
import type {
  BooksData,
  BooksDataEnvelope,
  Invoice,
  SettlementSuggestion,
} from '../src/shared/types'
import {
  registerBooksIpc,
  resetBooksIpcForTesting,
  stopBooksStoreWatcher,
} from '../src/main/books-main'

const electronBridge = vi.hoisted(() => ({
  registeredChannels: [] as string[],
  invocations: [] as unknown[][],
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  /**
   * When true, `ipcRenderer.invoke` really calls the handler `ipcMain.handle`
   * registered — so a preload bridge call can be driven end to end through the
   * production handler instead of only being observed.
   */
  dispatchToHandlers: false,
  exposed: undefined as unknown,
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  userDataDir: '',
}))

vi.mock('electron', () => ({
  app: { getPath: () => electronBridge.userDataDir },
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      electronBridge.registeredChannels.push(channel)
      electronBridge.handlers.set(channel, listener)
    },
  },
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      electronBridge.exposed = { key, api }
    },
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      electronBridge.invocations.push([channel, ...args])
      if (!electronBridge.dispatchToHandlers) return undefined
      const handler = electronBridge.handlers.get(channel)
      return handler ? await handler({ sender: undefined }, ...args) : undefined
    },
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const set = electronBridge.listeners.get(channel) ?? new Set()
      set.add(listener)
      electronBridge.listeners.set(channel, set)
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      electronBridge.listeners.get(channel)?.delete(listener)
    },
  },
  WebContentsView: class {},
}))

/** Every member the preload bridge must expose, pinned to the declared keys. */
const API_MEMBERS = [
  'loadData',
  'saveData',
  'onDataChanged',
  'exportToSheets',
  'openInPdf',
  'openInCrm',
  'openInTenders',
  'importBankStatementCsv',
  'reconcileTransaction',
  'getSettlementSuggestions',
  'backupNow',
  'listBackups',
  'restoreBackup',
] as const satisfies ReadonlyArray<keyof BooksApi>

const THIS_FILE = fileURLToPath(import.meta.url)
const BACKUP_NAME = 'books-backup-20260924-101010.json'

// --- Handler result fixtures -------------------------------------------------

const envelopeFixture = {
  ...initialBooksData,
  version: 1,
  revision: 3,
  updatedAt: '2026-09-24T08:00:00.000Z',
} satisfies BooksDataEnvelope

/**
 * `loadData` distinguishes a genuine first run from an existing store that
 * could not be read: `readable: false` is what stops the renderer opening the
 * setup wizard over books it failed to open.
 */
const loadDataFixtures = [
  { ok: true, readable: true, data: null },
  { ok: true, readable: true, data: envelopeFixture },
  { ok: true, readable: false, data: null, error: 'books-data.json is not valid JSON' },
  {
    ok: true,
    readable: false,
    data: null,
    error: 'books-data.json is not valid JSON',
    forensicPath: 'C:/data/books/books-data.json.corrupt-1f2e3d4c5b6a7988',
  },
  { ok: false, readable: false, data: null, error: 'EACCES: permission denied' },
] satisfies Array<Awaited<ReturnType<BooksApi['loadData']>>>

/** `saveData` reports the new revision, or why the write was rejected. */
const saveDataFixtures = [
  { ok: true, revision: 4 },
  { ok: false, error: 'Cannot modify journal entry je-1 in the closed period through 2026-03-31' },
  { ok: false, error: 'Books changed elsewhere', conflict: true, current: envelopeFixture },
] satisfies Array<Awaited<ReturnType<BooksApi['saveData']>>>

const importFixture = {
  ok: true,
  importedCount: 2,
  skippedDuplicates: 1,
  netAdjustment: 1500.5,
  newBankBalance: null,
  transactions: [
    {
      id: 'tx-1',
      accountId: 'acc-bank',
      date: '2026-09-01',
      description: 'EFT DEPOSIT CITY OF EKURHULENI',
      reference: 'INV-2026-001',
      amount: 1500.5,
      reconciled: false,
    },
  ],
} satisfies Awaited<ReturnType<BooksApi['importBankStatementCsv']>>

const importFailureFixture = {
  ok: false,
  error: 'No valid transactions found in statement CSV',
} satisfies Awaited<ReturnType<BooksApi['importBankStatementCsv']>>

const reconcileFixture = {
  ok: true,
  transactionId: 'tx-1',
  invoiceId: 'inv-1',
  invoiceNumber: 'INV-2026-001',
  settledAmount: 1500.5,
  remainingOutstanding: 0,
  invoiceStatus: 'Paid',
  partyBalance: 0,
  tenderMilestonePaid: false,
  matchedMilestoneId: 'ms-1',
  matchedTenderId: 'tender-1',
} satisfies Awaited<ReturnType<BooksApi['reconcileTransaction']>>

const reconcileFailureFixture = {
  ok: false,
  error: 'Transaction not found: tx-404',
} satisfies Awaited<ReturnType<BooksApi['reconcileTransaction']>>

/** `restoreBackup` echoes the migrated ledger back for the live broadcast. */
const restoreFixture = {
  ok: true,
  restoredData: envelopeFixture,
} satisfies Awaited<ReturnType<BooksApi['restoreBackup']>>

const restoreFailureFixture = {
  ok: false,
  error: 'Backup file not found',
} satisfies Awaited<ReturnType<BooksApi['restoreBackup']>>

const suggestionFixture = {
  transactionId: 'tx-1',
  invoiceId: 'inv-1',
  invoiceNumber: 'INV-2026-001',
  partyName: 'City of Ekurhuleni Water Dept',
  invoiceType: 'Sales',
  amount: 1500.5,
  confidence: 'HIGH',
  reason: 'Exact amount match and contains invoice number: INV-2026-001',
} satisfies SettlementSuggestion

const suggestionsFixture = [suggestionFixture] satisfies Awaited<
  ReturnType<BooksApi['getSettlementSuggestions']>
>

const backupsFixture = [
  {
    name: BACKUP_NAME,
    path: `C:\\data\\books\\backups\\${BACKUP_NAME}`,
    size: 4096,
    modifiedAt: '2026-09-24T10:10:10.000Z',
  },
] satisfies Awaited<ReturnType<BooksApi['listBackups']>>

const backupNowFixture = {
  ok: true,
  path: `C:/data/books/backups/${BACKUP_NAME}`,
} satisfies Awaited<ReturnType<BooksApi['backupNow']>>

const generatedFileFixtures = [
  { ok: true, path: 'C:/tmp/Tax_Invoice_INV-2026-001.pdf' },
  { ok: false, error: 'Failed to generate invoice PDF' },
]
const exportedFileFixtures = generatedFileFixtures satisfies Awaited<
  ReturnType<BooksApi['exportToSheets']>
>[]
const openedFileFixtures = generatedFileFixtures satisfies Awaited<
  ReturnType<BooksApi['openInPdf']>
>[]

// --- Guard helpers -----------------------------------------------------------

/** A real ledger with one field swapped for a hostile value. */
function ledger(patch: Record<string, unknown> = {}): unknown {
  return { ...initialBooksData, ...patch }
}

const HOSTILE_INPUTS: unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '',
  '   ',
  [],
  [1, 2],
  {},
  { accounts: [] },
  new Date(),
  () => undefined,
]

function rejection(result: ValidationResult<unknown>): string {
  return result.ok ? '' : result.error
}

describe('declared BooksApi surface', () => {
  it('carries the fields every handler really resolves with', () => {
    expect(loadDataFixtures[0].data).toBeNull()
    expect(loadDataFixtures[1].ok && loadDataFixtures[1].data?.revision).toBe(3)
    expect(validateBooksData(loadDataFixtures[1].data).ok).toBe(true)
    expect(saveDataFixtures[0]).toEqual({ ok: true, revision: 4 })
    expect(saveDataFixtures[1].ok).toBe(false)
    expect(saveDataFixtures[2]).toMatchObject({ ok: false, conflict: true })

    expect(importFixture.transactions).toHaveLength(1)
    expect(importFixture.newBankBalance).toBeNull()
    expect(importFailureFixture.ok).toBe(false)

    expect(reconcileFixture.invoiceStatus).toBe('Paid')
    expect(reconcileFixture.tenderMilestonePaid).toBe(false)
    expect(reconcileFailureFixture.error).toContain('tx-404')

    expect(validateBooksData(restoreFixture.restoredData).ok).toBe(true)
    expect(restoreFailureFixture.ok).toBe(false)

    expect(suggestionsFixture[0].confidence).toBe('HIGH')
    expect(BACKUP_NAME_PATTERN.test(backupsFixture[0].name)).toBe(true)
    expect(backupNowFixture.path).toContain('books-backup-')
    expect(exportedFileFixtures[1].ok).toBe(false)
    expect(openedFileFixtures[1].ok).toBe(false)
  })
})

describe('preload bridge', () => {
  async function exposeBridge(): Promise<Record<string, unknown>> {
    ;(process as { contextIsolated?: boolean }).contextIsolated = true
    await import('../src/preload/index')
    const exposed = electronBridge.exposed as { key: string; api: Record<string, unknown> }
    expect(exposed.key).toBe('booksApi')
    return exposed.api
  }

  beforeEach(() => {
    electronBridge.listeners.clear()
    electronBridge.invocations.length = 0
  })

  it('exposes every declared member as a function and leaks no transport', async () => {
    const api = await exposeBridge()

    expect(Object.keys(api).sort()).toEqual([...API_MEMBERS].sort())
    for (const member of API_MEMBERS) {
      expect(typeof api[member], member).toBe('function')
    }
    for (const leaked of ['ipcRenderer', 'invoke', 'send', 'on', 'removeListener']) {
      expect(api).not.toHaveProperty(leaked)
    }
  })

  it('routes the reworked channels to their declared names', async () => {
    const api = await exposeBridge()

    await (api.loadData as () => Promise<unknown>)()
    expect(electronBridge.invocations.at(-1)).toEqual([BOOKS_CHANNELS.loadData])

    const csv = 'Date,Description,Amount\n2026-09-01,EFT DEPOSIT,1500.50\n'
    await (api.importBankStatementCsv as (csv: string) => Promise<unknown>)(csv)
    expect(electronBridge.invocations.at(-1)).toEqual([BOOKS_CHANNELS.importBankStatementCsv, csv])

    await (api.reconcileTransaction as (a: string, b: string) => Promise<unknown>)('tx-1', 'inv-1')
    expect(electronBridge.invocations.at(-1)).toEqual([
      BOOKS_CHANNELS.reconcileTransaction,
      'tx-1',
      'inv-1',
    ])

    await (api.restoreBackup as (name: string) => Promise<unknown>)(BACKUP_NAME)
    expect(electronBridge.invocations.at(-1)).toEqual([BOOKS_CHANNELS.restoreBackup, BACKUP_NAME])
  })

  /**
   * The bridge is built with an inline structural literal, so a handler's
   * parameter list can be shortened without the compiler noticing. That is how
   * `saveData` came to drop the `revision` argument and every save in the app
   * failed with "Revision must be a finite number" — so the argument list is
   * pinned here, and the pinned call is replayed into the REAL handler.
   */
  it('passes books:save-data exactly the two arguments its handler requires', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'books-preload-save-'))
    electronBridge.userDataDir = userDataDir
    electronBridge.registeredChannels.length = 0
    electronBridge.handlers.clear()
    electronBridge.dispatchToHandlers = true
    try {
      resetBooksIpcForTesting()
      registerBooksIpc()
      const api = await exposeBridge()

      const reply = await (api.saveData as (data: BooksData, revision: number) => Promise<unknown>)(
        initialBooksData,
        0,
      )

      // Exactly [channel, data, revision]: no more, and above all no fewer.
      expect(electronBridge.invocations.at(-1)).toEqual([
        BOOKS_CHANNELS.saveData,
        initialBooksData,
        0,
      ])
      // And the production handler accepted exactly that call.
      expect(reply).toMatchObject({ ok: true, revision: 1 })
      const written = JSON.parse(
        readFileSync(join(userDataDir, 'books', 'books-data.json'), 'utf8'),
      )
      expect(written.revision).toBe(1)
      expect(written.accounts).toHaveLength(initialBooksData.accounts.length)
    } finally {
      electronBridge.dispatchToHandlers = false
      stopBooksStoreWatcher()
      resetBooksIpcForTesting()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('subscribes onDataChanged to the push channel and drops only its own listener', async () => {
    const api = await exposeBridge()
    const received: BooksData[] = []

    const unsubscribe = (api.onDataChanged as (cb: (data: BooksData) => void) => () => void)(
      (data) => {
        received.push(data)
      },
    )

    const listeners = electronBridge.listeners.get(BOOKS_CHANNELS.dataChanged)
    expect(listeners?.size).toBe(1)
    const [listener] = [...(listeners ?? [])]
    listener({}, initialBooksData)
    expect(received).toEqual([initialBooksData])

    unsubscribe()
    expect(electronBridge.listeners.get(BOOKS_CHANNELS.dataChanged)?.size).toBe(0)
  })
})

describe('BOOKS_CHANNELS', () => {
  beforeEach(() => {
    electronBridge.registeredChannels.length = 0
    electronBridge.userDataDir = mkdtempSync(join(tmpdir(), 'books-ipc-contract-'))
    resetBooksIpcForTesting()
  })

  afterEach(() => {
    stopBooksStoreWatcher()
    resetBooksIpcForTesting()
    rmSync(electronBridge.userDataDir, { recursive: true, force: true })
  })

  it('backs every request channel with a registered handler and keeps push channels out of ipcMain', () => {
    registerBooksIpc()
    const registered = new Set(electronBridge.registeredChannels)
    const pushOnly: string[] = [BOOKS_CHANNELS.dataChanged, BOOKS_CHANNELS.DATA_CHANGED]

    expect(registered.size).toBeGreaterThan(0)
    for (const [key, channel] of Object.entries(BOOKS_CHANNELS)) {
      if (pushOnly.includes(channel)) {
        expect(registered.has(channel), key).toBe(false)
        continue
      }
      expect(registered.has(channel), key).toBe(true)
    }
  })

  it('reaches every request channel through the preload bridge', async () => {
    registerBooksIpc()
    const registered = new Set(electronBridge.registeredChannels)
    const reachable = API_MEMBERS.filter((member) => member !== 'onDataChanged')

    for (const member of reachable) {
      expect(registered.has(BOOKS_CHANNELS[member]), member).toBe(true)
    }
  })

  it('names each channel once, apart from the documented dataChanged alias', () => {
    const keysByChannel = new Map<string, string[]>()
    for (const [key, channel] of Object.entries(BOOKS_CHANNELS)) {
      keysByChannel.set(channel, [...(keysByChannel.get(channel) ?? []), key])
    }

    const duplicates = [...keysByChannel.entries()]
      .filter(([, keys]) => keys.length > 1)
      .map(([channel, keys]) => [channel, [...keys].sort()])

    expect(duplicates).toEqual([['books:data-changed', ['DATA_CHANGED', 'dataChanged']]])
  })

  it('keeps no unreachable alias channel', () => {
    expect(Object.keys(BOOKS_CHANNELS)).not.toContain('getData')
    expect(Object.values(BOOKS_CHANNELS)).not.toContain('books:get-data')
  })
})

describe('validateBooksData', () => {
  it('accepts the seed ledger and its stored envelope', () => {
    expect(validateBooksData(initialBooksData)).toEqual({ ok: true, value: initialBooksData })
    expect(validateBooksData(envelopeFixture).ok).toBe(true)
    expect(validateBooksData({ ...initialBooksData, payments: [], auditLog: [] }).ok).toBe(true)
  })

  it('rejects a payload that is not an object', () => {
    for (const payload of HOSTILE_INPUTS) {
      expect(validateBooksData(payload).ok, String(payload)).toBe(false)
    }
    expect(rejection(validateBooksData('ledger'))).toMatch(/must be an object/)
  })

  it('rejects a payload without the core arrays', () => {
    expect(rejection(validateBooksData(ledger({ settings: 'nope' })))).toMatch(/settings/)
    expect(rejection(validateBooksData({ settings: {}, accounts: [], parties: [] }))).toMatch(
      /invoices/,
    )
    expect(rejection(validateBooksData(ledger({ accounts: 'nope' })))).toMatch(/accounts/)
    expect(rejection(validateBooksData(ledger({ parties: null })))).toMatch(/parties/)
    expect(rejection(validateBooksData(ledger({ journalEntries: 0 })))).toMatch(/journalEntries/)
    expect(rejection(validateBooksData(ledger({ invoices: [] })))).toBe('')
  })

  it('rejects wrong field types in every record kind', () => {
    expect(
      rejection(validateBooksData(ledger({ accounts: [{ id: 'acc-bank', balance: '485250' }] }))),
    ).toMatch(/balance must be a finite number/)
    expect(rejection(validateBooksData(ledger({ accounts: [{ balance: 0 }] })))).toMatch(
      /non-empty id/,
    )
    expect(rejection(validateBooksData(ledger({ parties: [{ id: 'p-1' }] })))).toMatch(
      /outstandingBalance/,
    )
    expect(
      rejection(
        validateBooksData(
          ledger({ invoices: [{ ...initialBooksData.invoices[0], status: 'Mostly paid' }] }),
        ),
      ),
    ).toMatch(/status/)
    expect(
      rejection(
        validateBooksData(
          ledger({ invoices: [{ ...initialBooksData.invoices[0], type: 'Credit' }] }),
        ),
      ),
    ).toMatch(/type must be Sales or Purchase/)
    expect(
      rejection(
        validateBooksData(
          ledger({ invoices: [{ ...initialBooksData.invoices[0], grandTotal: '145000' }] }),
        ),
      ),
    ).toMatch(/grandTotal must be a finite number/)
    expect(
      rejection(
        validateBooksData(
          ledger({ invoices: [{ ...initialBooksData.invoices[0], items: 'none' }] }),
        ),
      ),
    ).toMatch(/items must be an array/)
    expect(
      rejection(
        validateBooksData(
          ledger({
            journalEntries: [
              { id: 'je-1', items: [{ debit: 10, credit: 0 }], totalDebit: '10', totalCredit: 10 },
            ],
          }),
        ),
      ),
    ).toMatch(/totals must be finite numbers/)
    expect(
      rejection(
        validateBooksData(
          ledger({
            journalEntries: [
              {
                id: 'je-1',
                items: [{ debit: Number.NaN, credit: 0 }],
                totalDebit: 0,
                totalCredit: 0,
              },
            ],
          }),
        ),
      ),
    ).toMatch(/debit and credit/)
    expect(rejection(validateBooksData(ledger({ bankTransactions: 'none' })))).toMatch(
      /bankTransactions/,
    )
    expect(
      rejection(
        validateBooksData(
          ledger({
            bankTransactions: [
              { id: 'tx-1', date: '2026-09-01', description: 'X', amount: 5, reconciled: 'yes' },
            ],
          }),
        ),
      ),
    ).toMatch(/reconciled must be a boolean/)
    expect(rejection(validateBooksData(ledger({ payments: 'none' })))).toMatch(/payments/)
    expect(rejection(validateBooksData(ledger({ auditLog: 'none' })))).toMatch(/auditLog/)
    expect(rejection(validateBooksData(ledger({ auditLog: [{}] })))).toMatch(/audit entry/)
    expect(
      rejection(
        validateBooksData(ledger({ settings: { ...initialBooksData.settings, companyName: 42 } })),
      ),
    ).toMatch(/companyName must be a string/)
    expect(
      rejection(
        validateBooksData(
          ledger({ settings: { ...initialBooksData.settings, taxInclusive: 'yes' } }),
        ),
      ),
    ).toMatch(/taxInclusive must be a boolean/)
  })

  it('rejects NaN, infinite and negative amounts the domain forbids', () => {
    expect(
      rejection(validateBooksData(ledger({ accounts: [{ id: 'acc-bank', balance: Number.NaN }] }))),
    ).toMatch(/finite number/)
    expect(
      rejection(
        validateBooksData(
          ledger({ accounts: [{ id: 'acc-bank', balance: Number.POSITIVE_INFINITY }] }),
        ),
      ),
    ).toMatch(/finite number/)
    expect(
      rejection(
        validateBooksData(
          ledger({ settings: { ...initialBooksData.settings, defaultTaxRate: Number.NaN } }),
        ),
      ),
    ).toMatch(/non-negative number/)
    expect(
      rejection(
        validateBooksData(
          ledger({
            bankTransactions: [
              {
                id: 'tx-1',
                date: '2026-09-01',
                description: 'X',
                amount: 5,
                reconciled: false,
                paymentLinks: [{ paymentId: 'pay-1', amount: 0 }],
              },
            ],
          }),
        ),
      ),
    ).toMatch(/positive amount/)
    expect(
      rejection(
        validateBooksData(
          ledger({
            payments: [
              {
                id: 'pay-1',
                partyId: 'p-1',
                date: '2026-09-01',
                type: 'received',
                allocations: [{ invoiceId: 'inv-1', amount: -1500.5 }],
              },
            ],
          }),
        ),
      ),
    ).toMatch(/non-negative amount/)
    expect(
      rejection(
        validateBooksData(
          ledger({
            payments: [
              {
                id: 'pay-1',
                partyId: 'p-1',
                date: '2026-09-01',
                type: 'refunded',
                allocations: [],
              },
            ],
          }),
        ),
      ),
    ).toMatch(/type must be received, paid or refund/)
  })
})

describe('validateInvoicePayload', () => {
  const storedInvoice: Invoice = initialBooksData.invoices[0]

  it('accepts a stored invoice, discounts included', () => {
    expect(validateInvoicePayload(storedInvoice)).toEqual({ ok: true, value: storedInvoice })
    expect(
      validateInvoicePayload({
        ...storedInvoice,
        items: [{ ...storedInvoice.items[0], discountRate: 10 }],
      }).ok,
    ).toBe(true)
  })

  it('rejects anything that is not an invoice payload', () => {
    for (const payload of HOSTILE_INPUTS) {
      expect(validateInvoicePayload(payload).ok, String(payload)).toBe(false)
    }
    expect(rejection(validateInvoicePayload({ ...storedInvoice, items: [] }))).toBe('')
    expect(rejection(validateInvoicePayload({ ...storedInvoice, id: '' }))).toMatch(/non-empty id/)
    expect(rejection(validateInvoicePayload({ ...storedInvoice, invoiceNumber: '' }))).toMatch(
      /invoiceNumber/,
    )
    expect(rejection(validateInvoicePayload({ ...storedInvoice, status: 'Draft-ish' }))).toMatch(
      /status/,
    )
    expect(rejection(validateInvoicePayload({ ...storedInvoice, items: 'none' }))).toMatch(
      /items must be an array/,
    )
    expect(
      rejection(
        validateInvoicePayload({
          ...storedInvoice,
          items: [{ ...storedInvoice.items[0], taxRate: 'fifteen' }],
        }),
      ),
    ).toMatch(/taxRate/)
    expect(
      rejection(
        validateInvoicePayload({
          ...storedInvoice,
          items: [{ ...storedInvoice.items[0], taxRate: -5 }],
        }),
      ),
    ).toMatch(/taxRate must be a non-negative number/)
    expect(
      rejection(
        validateInvoicePayload({
          ...storedInvoice,
          items: [{ ...storedInvoice.items[0], taxRate: Number.NaN }],
        }),
      ),
    ).toMatch(/taxRate/)
    expect(
      rejection(
        validateInvoicePayload({
          ...storedInvoice,
          items: [{ ...storedInvoice.items[0], discountRate: -1 }],
        }),
      ),
    ).toMatch(/discountRate/)
    expect(
      rejection(
        validateInvoicePayload({
          ...storedInvoice,
          items: [{ ...storedInvoice.items[0], qty: Number.POSITIVE_INFINITY }],
        }),
      ),
    ).toMatch(/qty/)
    expect(
      rejection(
        validateInvoicePayload({
          ...storedInvoice,
          items: [{ ...storedInvoice.items[0], amount: Number.NaN }],
        }),
      ),
    ).toMatch(/amount/)
  })
})

describe('validateCsvString', () => {
  it('accepts the CSV text the export and import paths send', () => {
    const csv = 'Date,Description,Amount\n2026-09-01,EFT DEPOSIT,1500.50\n'
    expect(validateCsvString(csv)).toEqual({ ok: true, value: csv })
    expect(validateCsvString('a'.repeat(1000)).ok).toBe(true)
  })

  it('rejects non-strings and empty payloads', () => {
    for (const payload of HOSTILE_INPUTS) {
      expect(validateCsvString(payload).ok, String(payload)).toBe(false)
    }
    expect(rejection(validateCsvString(undefined))).toMatch(/must be a string/)
    expect(rejection(validateCsvString('   \n'))).toMatch(/must not be empty/)
  })

  it('rejects oversized text by character count and by UTF-8 byte size', () => {
    expect(rejection(validateCsvString('a'.repeat(MAX_CSV_CHARS + 1)))).toMatch(/character cap/)
    // 3M three-byte characters stay under the character cap but exceed the byte cap.
    expect(rejection(validateCsvString('税'.repeat(3_000_000)))).toMatch(/byte cap/)
  })
})

describe('validateNonEmptyString', () => {
  it('accepts ids and trims surrounding whitespace', () => {
    expect(validateNonEmptyString('tx-1', 'transactionId')).toEqual({
      ok: true,
      value: 'tx-1',
    })
    expect(validateNonEmptyString('  inv-1  ', 'invoiceId')).toEqual({
      ok: true,
      value: 'inv-1',
    })
  })

  it('rejects non-strings, empty strings and hostile ids', () => {
    for (const payload of HOSTILE_INPUTS) {
      expect(validateNonEmptyString(payload, 'invoiceId').ok, String(payload)).toBe(false)
    }
    expect(rejection(validateNonEmptyString(42, 'transactionId'))).toBe(
      'transactionId must be a string',
    )
    expect(rejection(validateNonEmptyString('', 'transactionId'))).toBe(
      'transactionId must not be empty',
    )
    expect(rejection(validateNonEmptyString('tx\u0000-1', 'transactionId'))).toMatch(
      /control characters/,
    )
    expect(
      rejection(validateNonEmptyString('t'.repeat(MAX_ID_CHARS + 1), 'transactionId')),
    ).toMatch(/character cap/)
  })
})

describe('validateBackupName', () => {
  it('accepts the file names the backup engine writes', () => {
    expect(validateBackupName(BACKUP_NAME)).toEqual({ ok: true, value: BACKUP_NAME })
    expect(validateBackupName('books-backup-20260924-101010-1730000000000.json').ok).toBe(true)
    expect(validateBackupName(`  ${BACKUP_NAME}  `)).toEqual({ ok: true, value: BACKUP_NAME })
    expect(BACKUP_NAME_PATTERN.test(BACKUP_NAME)).toBe(true)
  })

  it('rejects non-strings, empty and non-backup names', () => {
    for (const payload of HOSTILE_INPUTS) {
      expect(validateBackupName(payload).ok, String(payload)).toBe(false)
    }
    expect(rejection(validateBackupName('   '))).toMatch(/must not be empty/)
    expect(rejection(validateBackupName('pre-restore-20260924-101010.json'))).toMatch(
      /must match books-backup-/,
    )
    expect(rejection(validateBackupName('books-backup-20260924.txt'))).toMatch(
      /must match books-backup-/,
    )
    expect(rejection(validateBackupName('books-data.json'))).toMatch(/must match books-backup-/)
    expect(rejection(validateBackupName(`${'b'.repeat(MAX_ID_CHARS)}.json`))).toMatch(
      /character cap/,
    )
  })

  it('rejects anything that could escape the backups directory', () => {
    expect(rejection(validateBackupName('..'))).toMatch(/\.\./)
    expect(rejection(validateBackupName('../books-backup-20260924-101010.json'))).toMatch(/\.\./)
    expect(rejection(validateBackupName('books-backup-..json'))).toMatch(/\.\./)
    expect(rejection(validateBackupName('backups/books-backup-20260924-101010.json'))).toMatch(
      /path separators/,
    )
    expect(rejection(validateBackupName('C:\\books-backup-20260924-101010.json'))).toMatch(
      /path separators/,
    )
    expect(rejection(validateBackupName('/books-backup-20260924-101010.json'))).toMatch(
      /path separators/,
    )
    expect(rejection(validateBackupName('C:books-backup-20260924-101010.json'))).toMatch(
      /absolute path/,
    )
  })
})

describe('every validator', () => {
  const validators: Array<[string, (raw: unknown) => ValidationResult<unknown>]> = [
    ['validateBooksData', validateBooksData],
    ['validateInvoicePayload', validateInvoicePayload],
    ['validateCsvString', validateCsvString],
    ['validateBackupName', validateBackupName],
    ['validateNonEmptyString', (raw) => validateNonEmptyString(raw, 'id')],
  ]

  it('answers with a result object instead of throwing', () => {
    for (const [name, validate] of validators) {
      for (const payload of HOSTILE_INPUTS) {
        let result: ValidationResult<unknown> | undefined
        expect(
          () => {
            result = validate(payload)
          },
          `${name} threw on ${String(payload)}`,
        ).not.toThrow()

        expect(result, `${name} answered nothing for ${String(payload)}`).toBeDefined()
        expect(result?.ok, `${name} accepted ${String(payload)}`).toBe(false)
        expect(rejection(result!).length, `${name} gave no reason`).toBeGreaterThan(0)
      }
    }
  })
})

describe('validateRevision', () => {
  it('accepts the revision counters a store can carry', () => {
    expect(validateRevision(0)).toEqual({ ok: true, value: 0 })
    expect(validateRevision(41)).toEqual({ ok: true, value: 41 })
  })

  it('rejects fractional, negative, infinite and non-numeric revisions', () => {
    // Every hostile input, plus the one value the shared HOSTILE_INPUTS list
    // contains that is a legitimate revision (0) and is excluded here.
    for (const payload of [...HOSTILE_INPUTS, '3', 1.5]) {
      if (payload === 0) continue
      expect(validateRevision(payload).ok, String(payload)).toBe(false)
    }
    expect(rejection(validateRevision(1.5))).toMatch(/whole number/)
    expect(rejection(validateRevision(-1))).toMatch(/must not be negative/)
    expect(rejection(validateRevision(Number.POSITIVE_INFINITY))).toMatch(/finite number/)
    expect(rejection(validateRevision('3'))).toMatch(/finite number/)
  })
})

describe('transport guards', () => {
  it('narrows every loadData variant the contract allows', () => {
    for (const fixture of loadDataFixtures) {
      expect(isLoadDataResult(fixture), JSON.stringify(fixture)).toBe(true)
    }
    expect(isLoadDataResult({ ok: true, readable: false, data: null })).toBe(true)
    // The salvage copy is optional, but when a reply names one it must be a
    // path the renderer can give back to the user.
    expect(
      isLoadDataResult({
        ok: true,
        readable: false,
        data: null,
        forensicPath: 'C:/data/books/books-data.json.corrupt-1f2e3d4c5b6a7988',
      }),
    ).toBe(true)
    expect(isLoadDataResult({ ok: true, readable: false, data: null, forensicPath: '' })).toBe(
      false,
    )
    expect(isLoadDataResult({ ok: true, readable: false, data: null, forensicPath: 42 })).toBe(
      false,
    )
  })

  it('refuses a bare null or envelope from a main process that predates revisions', () => {
    // Both replies used to be the whole contract; neither can say whether the
    // store is missing or merely unreadable, so neither may pass as a success.
    expect(isLoadDataResult(null)).toBe(false)
    expect(isLoadDataResult(undefined)).toBe(false)
    expect(isLoadDataResult(envelopeFixture)).toBe(false)
    expect(isLoadDataResult({ ...envelopeFixture })).toBe(false)
  })

  it('refuses a malformed loadData reply', () => {
    expect(isLoadDataResult({ ok: true, readable: true, data: { version: 1 } })).toBe(false)
    expect(isLoadDataResult({ ok: true, readable: true, data: 'ledger' })).toBe(false)
    expect(isLoadDataResult({ ok: true, readable: true })).toBe(false)
    // The reason on the unreadable arm is optional but must be a real string.
    expect(isLoadDataResult({ ok: true, readable: false, data: null, error: '' })).toBe(false)
    expect(isLoadDataResult({ ok: true, readable: false, data: null, error: 42 })).toBe(false)
    expect(isLoadDataResult({ ok: true, readable: 'maybe', data: null })).toBe(false)
    expect(isLoadDataResult({ ok: false, readable: false, data: null })).toBe(false)
    expect(
      isLoadDataResult({ ok: false, readable: false, data: envelopeFixture, error: 'x' }),
    ).toBe(false)
    for (const payload of HOSTILE_INPUTS) {
      expect(isLoadDataResult(payload), String(payload)).toBe(false)
    }
  })

  it('narrows every saveData variant the contract allows', () => {
    for (const fixture of saveDataFixtures) {
      expect(isSaveDataResult(fixture), JSON.stringify(fixture)).toBe(true)
    }
    expect(isSaveDataResult({ ok: false, error: 'nope' })).toBe(true)
  })

  it('refuses the bare boolean saveData used to answer with', () => {
    expect(isSaveDataResult(true)).toBe(false)
    expect(isSaveDataResult(false)).toBe(false)
  })

  it('refuses a malformed saveData reply', () => {
    expect(isSaveDataResult({ ok: true })).toBe(false)
    expect(isSaveDataResult({ ok: true, revision: '4' })).toBe(false)
    expect(isSaveDataResult({ ok: true, revision: Number.NaN })).toBe(false)
    expect(isSaveDataResult({ ok: false })).toBe(false)
    expect(isSaveDataResult({ ok: false, error: '   ' })).toBe(false)
    expect(isSaveDataResult({ ok: false, error: 'x', conflict: false })).toBe(false)
    expect(isSaveDataResult({ ok: false, error: 'x', current: { version: 1 } })).toBe(false)
    for (const payload of HOSTILE_INPUTS) {
      expect(isSaveDataResult(payload), String(payload)).toBe(false)
    }
  })
})

describe('declared contract pins', () => {
  it('keeps saveData and loadData off their old loose shapes', () => {
    // A revision on the success arm: `saveData` must report the new cursor.
    const saved: Awaited<ReturnType<BooksApi['saveData']>> = { ok: true, revision: 7 }
    if (!saved.ok) throw new Error('narrowing')
    const revision: number = saved.revision
    expect(revision).toBe(7)

    // A conflict carries the server ledger back for the renderer to adopt.
    const conflicted: Awaited<ReturnType<BooksApi['saveData']>> = {
      ok: false,
      error: 'Books changed elsewhere',
      conflict: true,
      current: envelopeFixture,
    }
    expect(conflicted.ok).toBe(false)
    if (conflicted.ok) throw new Error('narrowing')
    expect(conflicted.current?.revision).toBe(3)

    // `loadData` is a discriminated union: the readable arm alone exposes data.
    const loaded: Awaited<ReturnType<BooksApi['loadData']>> = {
      ok: true,
      readable: true,
      data: envelopeFixture,
    }
    if (!loaded.ok || !loaded.readable) throw new Error('narrowing')
    const envelope: BooksDataEnvelope | null = loaded.data
    expect(envelope?.revision).toBe(3)

    // @ts-expect-error a bare envelope no longer satisfies the load contract
    const legacyLoad: Awaited<ReturnType<BooksApi['loadData']>> = envelopeFixture
    // @ts-expect-error a bare revision-only reply is not a save result
    const legacySave: Awaited<ReturnType<BooksApi['saveData']>> = { ok: true }
    // @ts-expect-error an error arm without a reason is not a save failure
    const reasonless: Awaited<ReturnType<BooksApi['saveData']>> = { ok: false }
    expect([legacyLoad, legacySave, reasonless]).toHaveLength(3)
  })

  it('typechecks this file against the declared BooksApi surface', () => {
    const program = ts.createProgram([THIS_FILE], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      types: ['node'],
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      isolatedModules: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      forceConsistentCasingInFileNames: true,
    })

    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter(
        (diagnostic) =>
          diagnostic.file !== undefined &&
          basename(diagnostic.file.fileName) === basename(THIS_FILE),
      )
      .map((diagnostic) => {
        const position = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
        return `${basename(THIS_FILE)}:${position.line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
      })

    expect(diagnostics).toEqual([])
  }, 60_000)
})

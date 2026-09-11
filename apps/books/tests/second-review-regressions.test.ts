import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  allJournalsBalanced,
  accountsMatchJournals,
  round2,
} from '../src/shared/accounting'
import { planImportCoverage } from '../src/shared/payments'
import {
  importBankStatement,
  issueSalesInvoiceInBooks,
  migrateAndValidateBooks,
  readBooksStore,
  writeBooksStore,
} from '../src/main/books-core'
import { exportBackup, restoreBackup } from '../src/main/backup-restore'
import { useBooksStore } from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import type { JournalEntry } from '../src/shared/types'

describe('Second-pass review regressions', () => {
  let testDir: string
  let booksDataPath: string

  beforeEach(() => {
    testDir = join(tmpdir(), `books-second-review-${randomUUID().slice(0, 8)}`)
    mkdirSync(testDir, { recursive: true })
    booksDataPath = join(testDir, 'books-data.json')
    useBooksStore.setState({
      activeTab: 'dashboard',
      data: JSON.parse(JSON.stringify(initialBooksData)),
      needsSetup: false,
      activeInvoiceId: null,
      invoiceStatusFilter: 'All',
      activeReport: 'profit-loss',
      printInvoice: null,
      searchTerm: '',
    })
  })

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  const state = () => useBooksStore.getState().data
  const expectInvariants = () => {
    const data = state()
    expect(allJournalsBalanced(data.journalEntries)).toBe(true)
    expect(accountsMatchJournals(data.accounts, data.journalEntries)).toBe(true)
  }

  it('rejects journal headers whose totals do not equal their lines', () => {
    const malformed: JournalEntry = {
      id: 'je-bad-header',
      entryNumber: 'JE-BAD',
      date: '2026-09-01',
      posted: true,
      totalDebit: 0,
      totalCredit: 0,
      items: [
        { id: 'a', accountId: 'acc-bank', accountName: 'Bank', debit: 100, credit: 0 },
        { id: 'b', accountId: 'acc-sales', accountName: 'Sales', debit: 0, credit: 100 },
      ],
    }
    expect(allJournalsBalanced([malformed])).toBe(false)
  })

  it('persists refund payments through migration/reload', () => {
    const migrated = migrateAndValidateBooks({
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: {},
      accounts: [],
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
      payments: [
        {
          id: 'pay-refund',
          partyId: 'p1',
          partyName: 'Customer',
          date: '2026-09-01',
          type: 'refund',
          allocations: [{ invoiceId: 'cn1', invoiceNumber: 'CN-1', amount: 115 }],
          total: 115,
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    })
    writeBooksStore(booksDataPath, migrated)
    const reloaded = readBooksStore(booksDataPath)
    expect(reloaded.payments).toHaveLength(1)
    expect(reloaded.payments![0].type).toBe('refund')
  })

  it('consumes a payment only once across two identical statement lines', () => {
    const data = JSON.parse(JSON.stringify(initialBooksData))
    data.payments = [
      {
        id: 'pay-one',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-09-01',
        type: 'received',
        allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
        total: 145000,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]
    const plan = planImportCoverage(data, [
      {
        id: 'tx-1',
        accountId: 'acc-bank',
        date: '2026-09-10',
        description: 'EFT City of Ekurhuleni INV-2026-001',
        amount: 145000,
        reconciled: false,
      },
      {
        id: 'tx-2',
        accountId: 'acc-bank',
        date: '2026-09-11',
        description: 'EFT City of Ekurhuleni INV-2026-001',
        amount: 145000,
        reconciled: false,
      },
    ])
    expect(plan.get('tx-1')!.coveredAmount).toBe(145000)
    expect(plan.get('tx-1')!.fullyCovered).toBe(true)
    expect(plan.get('tx-2')!.coveredAmount).toBe(0)
    expect(plan.get('tx-2')!.fullyCovered).toBe(false)
  })

  it('markInvoicePaid reuses payment linking and does not double-book a later statement import', async () => {
    const initial = state()
    useBooksStore.setState({
      data: {
        ...initial,
        bankTransactions: [
          {
            id: 'tx-mark-paid',
            accountId: 'acc-bank',
            date: '2026-09-10',
            description: 'EFT City of Ekurhuleni INV-2026-001',
            amount: 145000,
            reconciled: false,
          },
        ],
      },
    })
    await useBooksStore.getState().markInvoicePaid('inv-1')
    const after = state()
    expect(after.payments).toHaveLength(1)
    expect(after.bankTransactions![0].reconciled).toBe(true)
    expect(after.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(630250)
    expectInvariants()
  })

  it('partial payment after import clears only its share of Suspense and does not double-book Bank', async () => {
    writeBooksStore(booksDataPath, state())
    const imported = importBankStatement({
      booksDataPath,
      csvContent: [
        'Date,Description,Reference,Amount',
        '2026-09-10,"EFT City of Ekurhuleni INV-2026-001","",145000.00',
      ].join('\n'),
    })
    expect(imported.ok).toBe(true)
    useBooksStore.setState({ data: readBooksStore(booksDataPath) })

    const paid = await useBooksStore.getState().recordPayment({
      partyId: 'party-1',
      date: '2026-09-10',
      allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 50000 }],
    })
    expect(paid.ok).toBe(true)
    const data = state()
    expect(data.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(630250)
    expect(data.accounts.find((a) => a.id === 'acc-suspense')!.balance).toBe(-95000)
    expect(data.bankTransactions![0].reconciled).toBe(false)
    expect(data.bankTransactions![0].paymentLinks![0].amount).toBe(50000)
    expectInvariants()
  })

  it('core cross-app invoice issuance rejects a date inside a closed period', () => {
    const locked = JSON.parse(JSON.stringify(initialBooksData))
    locked.settings.closedThrough = '2026-09-30'
    writeBooksStore(booksDataPath, locked)
    const result = issueSalesInvoiceInBooks({
      booksDataPath,
      partyName: 'Cross App Co',
      itemDescription: 'Locked work',
      amount: 11500,
      date: '2026-09-01',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/closed period/i)
  })

  it('restore preserves current audit history and appends exactly one restore event', () => {
    const before = JSON.parse(JSON.stringify(initialBooksData))
    before.auditLog = [
      {
        id: 'audit-before',
        timestamp: '2026-09-02T00:00:00.000Z',
        action: 'invoice.save',
        summary: 'Current audit history',
      },
    ]
    writeBooksStore(booksDataPath, before)
    const backup = exportBackup(booksDataPath)
    expect(backup.ok).toBe(true)

    const live = readBooksStore(booksDataPath)
    live.auditLog = [
      ...live.auditLog!,
      {
        id: 'audit-after',
        timestamp: '2026-09-03T00:00:00.000Z',
        action: 'payment.record',
        summary: 'Must survive restore',
      },
    ]
    writeBooksStore(booksDataPath, live)

    const result = restoreBackup(backup.path!, booksDataPath)
    expect(result.ok).toBe(true)
    const restored = readBooksStore(booksDataPath)
    const actions = restored.auditLog!.map((entry) => entry.id)
    expect(actions).toContain('audit-before')
    expect(actions).toContain('audit-after')
    expect(restored.auditLog!.filter((entry) => entry.action === 'backup.restore')).toHaveLength(1)
  })
})

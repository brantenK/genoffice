import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountsMatchJournals, allJournalsBalanced } from '../src/shared/accounting'
import { MAX_AUDIT_ENTRIES, appendAudit, createAuditEntry } from '../src/shared/audit'
import { computeDataHash, useBooksStore } from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import { migrateAndValidateBooks } from '../src/main/books-main'
import type { BooksApi } from '../src/shared/ipc'
import type { BooksData } from '../src/shared/types'

/**
 * Phase 3 audit-log suite: entry shape, newest-first append with a 500-entry
 * cap, store actions persisting a matching audit entry, syncFromMain
 * carry-through, hash sensitivity, and the ledger-first invariant holding
 * after every audited mutation.
 */
describe('Audit log', () => {
  let savedPayloads: BooksData[]

  beforeEach(() => {
    savedPayloads = []
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
    // Spy on persist(): capture every payload the store tries to save.
    window.booksApi = {
      saveData: async (data: BooksData) => {
        savedPayloads.push(data)
        return true
      },
    } as BooksApi
  })

  afterEach(() => {
    window.booksApi = undefined
  })

  const storeData = () => useBooksStore.getState().data
  const expectStoreInvariants = () => {
    const d = storeData()
    expect(allJournalsBalanced(d.journalEntries)).toBe(true)
    expect(accountsMatchJournals(d.accounts, d.journalEntries)).toBe(true)
  }
  const lastPersisted = () => savedPayloads[savedPayloads.length - 1]

  describe('createAuditEntry', () => {
    it('produces a well-formed entry with id, ISO timestamp and extra fields', () => {
      const entry = createAuditEntry('invoice.save', 'Saved invoice INV-2026-001 (Unpaid)', {
        invoiceNumber: 'INV-2026-001',
        paymentId: 'pay-1',
        amount: 145000,
        actor: 'admin',
      })
      expect(entry.id).toMatch(/^audit-\d+-\d+$/)
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp)
      expect(entry.action).toBe('invoice.save')
      expect(entry.summary).toBe('Saved invoice INV-2026-001 (Unpaid)')
      expect(entry.invoiceNumber).toBe('INV-2026-001')
      expect(entry.paymentId).toBe('pay-1')
      expect(entry.amount).toBe(145000)
      expect(entry.actor).toBe('admin')
    })

    it('works without extra fields', () => {
      const entry = createAuditEntry('party.add', 'Added party Acme (Customer)')
      expect(entry.action).toBe('party.add')
      expect(entry.invoiceNumber).toBeUndefined()
      expect(entry.paymentId).toBeUndefined()
      expect(entry.amount).toBeUndefined()
      expect(entry.actor).toBeUndefined()
    })
  })

  describe('appendAudit', () => {
    it('prepends the newest entry and returns a new data object', () => {
      const base = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      const e1 = createAuditEntry('journal.add', 'Posted journal entry JE-2026-050')
      const e2 = createAuditEntry('journal.add', 'Posted journal entry JE-2026-051')
      const withE1 = appendAudit(base, e1)
      const withE2 = appendAudit(withE1, e2)
      expect(withE2).not.toBe(base)
      expect(withE2.auditLog!.map((e) => e.id)).toEqual([e2.id, e1.id])
      expect(withE2.auditLog![0].summary).toBe('Posted journal entry JE-2026-051')
    })

    it('caps the log at the 500 most recent entries', () => {
      let data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      for (let i = 0; i < 505; i++) {
        data = appendAudit(data, createAuditEntry('journal.add', `Entry ${i}`))
      }
      expect(data.auditLog).toHaveLength(MAX_AUDIT_ENTRIES)
      expect(data.auditLog![0].summary).toBe('Entry 504')
      expect(data.auditLog![MAX_AUDIT_ENTRIES - 1].summary).toBe('Entry 5')
      // The oldest entries fell off the cap.
      expect(data.auditLog!.some((e) => e.summary === 'Entry 4')).toBe(false)
    })
  })

  describe('Store actions append and persist audit entries', () => {
    it('saveInvoice appends an invoice.save entry persisted through persist()', async () => {
      await useBooksStore.getState().saveInvoice({
        type: 'Sales',
        partyName: 'Audit Customer',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'Works', qty: 1, rate: 10000, taxRate: 15, amount: 10000 },
        ],
      })
      expectStoreInvariants()
      const d = storeData()
      expect(d.auditLog![0].action).toBe('invoice.save')
      expect(d.auditLog![0].summary).toContain('(Unpaid)')
      expect(d.auditLog![0].invoiceNumber).toBeTruthy()
      expect(d.auditLog![0].amount).toBe(11500)

      // The entry travelled with the mutation through persist() to the API.
      expect(savedPayloads.length).toBeGreaterThan(0)
      const persisted = lastPersisted()
      expect(persisted.auditLog![0].action).toBe('invoice.save')
      expect(persisted.auditLog![0].summary).toBe(d.auditLog![0].summary)
      expect(persisted.auditLog![0].invoiceNumber).toBe(d.auditLog![0].invoiceNumber)
      expect(persisted.auditLog![0].amount).toBe(11500)
    })

    it('recordPayment appends a payment.record entry with paymentId and amount', async () => {
      const store = useBooksStore.getState()
      const res = await store.recordPayment({
        partyId: 'party-1',
        date: '2026-09-06',
        method: 'Bank Transfer',
        allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 5000 }],
      })
      expect(res.ok).toBe(true)
      expectStoreInvariants()
      const d = storeData()
      expect(d.auditLog![0].action).toBe('payment.record')
      expect(d.auditLog![0].paymentId).toBe(d.payments![0].id)
      expect(d.auditLog![0].amount).toBe(5000)
      expect(d.auditLog![0].summary).toContain('City of Ekurhuleni Water Dept')
      expect(lastPersisted().auditLog![0].action).toBe('payment.record')
    })

    it('deletePayment appends a payment.delete entry', async () => {
      const store = useBooksStore.getState()
      await store.recordPayment({
        partyId: 'party-1',
        date: '2026-09-06',
        allocations: [{ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-001', amount: 145000 }],
      })
      const paymentId = storeData().payments![0].id
      await store.deletePayment(paymentId)
      expectStoreInvariants()
      const d = storeData()
      expect(d.auditLog![0].action).toBe('payment.delete')
      expect(d.auditLog![0].paymentId).toBe(paymentId)
      expect(d.auditLog![0].amount).toBe(145000)
      // The delete entry sits on top of the record entry.
      expect(d.auditLog![1].action).toBe('payment.record')
    })

    it('saveCreditNote appends a credit-note.issue entry', async () => {
      const res = await useBooksStore.getState().saveCreditNote({
        originalInvoiceId: 'inv-1',
        date: '2026-09-06',
        notes: 'Audit-log credit note',
      })
      expect(res.ok).toBe(true)
      expectStoreInvariants()
      const d = storeData()
      expect(d.auditLog![0].action).toBe('credit-note.issue')
      expect(d.auditLog![0].invoiceNumber).toMatch(/^CN-/)
      expect(d.auditLog![0].summary).toContain('INV-2026-001')
      expect(d.auditLog![0].amount).toBe(res.creditNote!.grandTotal)
    })

    it('updateSettings appends a settings.update entry', async () => {
      await useBooksStore.getState().updateSettings({ companyName: 'Zano Renamed (Pty) Ltd' })
      const d = storeData()
      expect(d.auditLog![0].action).toBe('settings.update')
      expect(d.auditLog![0].summary).toContain('Zano Renamed (Pty) Ltd')
      expectStoreInvariants()
    })
  })

  describe('syncFromMain', () => {
    it('carries auditLog through into the store data', () => {
      const incoming = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      incoming.auditLog = [
        createAuditEntry('invoice.save', 'Saved invoice INV-2026-099 (Unpaid)', {
          invoiceNumber: 'INV-2026-099',
        }),
        createAuditEntry('party.add', 'Added party External Sync (Customer)'),
      ]
      useBooksStore.getState().syncFromMain(incoming)
      const d = storeData()
      expect(d.auditLog).toHaveLength(2)
      expect(d.auditLog![0].action).toBe('invoice.save')
      expect(d.auditLog![0].invoiceNumber).toBe('INV-2026-099')
      expect(d.auditLog![1].action).toBe('party.add')
      expectStoreInvariants()
    })

    it('defaults to an empty audit log when incoming data has none', () => {
      const incoming = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      useBooksStore.getState().syncFromMain(incoming)
      expect(storeData().auditLog).toEqual([])
    })
  })

  describe('computeDataHash', () => {
    it('changes when the audit log changes', () => {
      const base = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      const withAudit = appendAudit(base, createAuditEntry('test.action', 'Test entry'))
      expect(computeDataHash(base)).not.toBe(computeDataHash(withAudit))
    })
  })

  describe('migrateAndValidateBooks carry-through', () => {
    it('keeps valid audit entries, drops invalid ones and caps at 500', () => {
      const raw = JSON.parse(JSON.stringify(initialBooksData)) as Record<string, unknown>
      raw.auditLog = [
        createAuditEntry('invoice.save', 'Saved invoice INV-2026-001 (Unpaid)', {
          invoiceNumber: 'INV-2026-001',
          amount: 145000,
        }),
        { id: 'audit-invalid', timestamp: 'x', action: 42, summary: 'bad' },
        {
          id: 'audit-minimal',
          timestamp: '2026-09-01T00:00:00.000Z',
          action: 'party.add',
          summary: 'Added party Minimal (Customer)',
        },
      ]
      const env = migrateAndValidateBooks(raw)
      expect(env.auditLog).toHaveLength(2)
      expect(env.auditLog![0].action).toBe('invoice.save')
      expect(env.auditLog![0].invoiceNumber).toBe('INV-2026-001')
      expect(env.auditLog![0].amount).toBe(145000)
      expect(env.auditLog![1].action).toBe('party.add')
    })

    it('caps a too-long stored audit log at 500 during migration', () => {
      const raw = JSON.parse(JSON.stringify(initialBooksData)) as Record<string, unknown>
      const entries = []
      for (let i = 0; i < 505; i++) {
        entries.push({
          ...createAuditEntry('journal.add', `Migrated entry ${i}`),
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        })
      }
      raw.auditLog = entries // deliberately oldest-first, as an untrusted backup might be
      const env = migrateAndValidateBooks(raw)
      expect(env.auditLog).toHaveLength(MAX_AUDIT_ENTRIES)
      // Migration sorts newest-first before capping, retaining the actual
      // latest 500 rather than trusting a reordered input order.
      expect(env.auditLog![0].summary).toBe('Migrated entry 504')
      expect(env.auditLog![MAX_AUDIT_ENTRIES - 1].summary).toBe('Migrated entry 5')
    })
  })

  describe('Audit entry validation (review fix)', () => {
    it('migration drops entries with unparseable timestamps', () => {
      const migrated = migrateAndValidateBooks({
        version: 1,
        updatedAt: new Date().toISOString(),
        settings: {},
        accounts: [],
        parties: [],
        invoices: [],
        journalEntries: [],
        bankTransactions: [],
        auditLog: [
          { id: 'a1', timestamp: 'garbage', action: 'x', summary: 'bad timestamp' },
          { id: 'a2', timestamp: new Date().toISOString(), action: 'y', summary: 'good' },
        ],
      })
      expect(migrated.auditLog).toHaveLength(1)
      expect(migrated.auditLog![0].id).toBe('a2')
    })
  })
})
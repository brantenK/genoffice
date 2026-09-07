import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  accountsMatchJournals,
  allJournalsBalanced,
  computeAccountBalances,
  nextInvoiceNumber,
  nextJournalNumber,
  createOpeningJournal,
  round2,
} from '../src/shared/accounting'
import { CORE_ACCOUNTS, EMPTY_ACCOUNTS } from '../src/shared/chart'
import {
  readBooksStore,
  writeBooksStore,
  importBankStatement,
  executeReconciliation,
  issueSalesInvoiceInBooks,
  migrateAndValidateBooks,
} from '../src/main/books-main'
import { useBooksStore } from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import type { BankTransaction, Invoice, JournalEntry } from '../src/shared/types'

/**
 * Phase 1 ledger-first invariant suite: after every mutation, stored account
 * balances must equal the balances derived from journal entries, and every
 * journal entry must be balanced (debits === credits).
 */
describe('Ledger-first invariants (balances == sum of journals)', () => {
  let testDir: string
  let booksDataPath: string

  beforeEach(() => {
    testDir = join(tmpdir(), `books-invariants-${randomUUID().slice(0, 8)}`)
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
    try {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    } catch {}
  })

  const storeState = () => useBooksStore.getState().data
  const expectStoreInvariants = () => {
    const d = storeState()
    expect(allJournalsBalanced(d.journalEntries)).toBe(true)
    expect(accountsMatchJournals(d.accounts, d.journalEntries)).toBe(true)
  }

  describe('computeAccountBalances', () => {
    it('derives leaf balances signed by normal side and rolls groups up', () => {
      const journals: JournalEntry[] = [
        {
          id: 'je-1',
          entryNumber: 'JE-2026-001',
          date: '2026-09-01',
          posted: true,
          totalDebit: 115000,
          totalCredit: 115000,
          items: [
            { id: 'i1', accountId: 'acc-bank', accountName: 'Bank', debit: 115000, credit: 0 },
            { id: 'i2', accountId: 'acc-sales', accountName: 'Sales', debit: 0, credit: 115000 },
          ],
        },
      ]
      const accounts = computeAccountBalances(EMPTY_ACCOUNTS, journals)
      expect(accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(115000)
      expect(accounts.find((a) => a.id === 'acc-sales')!.balance).toBe(115000)
      // acc-bank parent chain rolls up; sales rolls up into Income.
      expect(accounts.find((a) => a.id === 'acc-curr-asset')!.balance).toBe(115000)
      expect(accounts.find((a) => a.id === 'acc-asset')!.balance).toBe(115000)
      expect(accounts.find((a) => a.id === 'acc-income')!.balance).toBe(115000)
    })

    it('handles credit-normal accounts (Liability/Equity/Income) with negative signing', () => {
      const journals: JournalEntry[] = [
        {
          id: 'je-1',
          entryNumber: 'JE-2026-002',
          date: '2026-09-01',
          posted: true,
          totalDebit: 115000,
          totalCredit: 115000,
          items: [
            { id: 'i1', accountId: 'acc-ar', accountName: 'AR', debit: 115000, credit: 0 },
            { id: 'i2', accountId: 'acc-sales', accountName: 'Sales', debit: 0, credit: 100000 },
            { id: 'i3', accountId: 'acc-vat', accountName: 'VAT', debit: 0, credit: 15000 },
          ],
        },
      ]
      const accounts = computeAccountBalances(EMPTY_ACCOUNTS, journals)
      expect(accounts.find((a) => a.id === 'acc-sales')!.balance).toBe(100000)
      expect(accounts.find((a) => a.id === 'acc-vat')!.balance).toBe(15000)
      expect(accounts.find((a) => a.id === 'acc-income')!.balance).toBe(100000)
    })
  })

  describe('Renderer store actions preserve the invariant', () => {
    it('saveInvoice (sales) keeps balances == journals and posts a balanced entry', async () => {
      const store = useBooksStore.getState()
      await store.saveInvoice({
        type: 'Sales',
        partyName: 'Invariant Customer',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'Works', qty: 1, rate: 10000, taxRate: 15, amount: 10000 },
        ],
      })
      expectStoreInvariants()
      const d = storeState()
      expect(d.journalEntries[0].totalDebit).toBe(d.journalEntries[0].totalCredit)
    })

    it('saveInvoice (purchase) keeps balances == journals and debits VAT input on the asset side', async () => {
      const store = useBooksStore.getState()
      const vatInBefore = store.data.accounts.find((a) => a.id === 'acc-vat-in')!.balance
      await store.saveInvoice({
        type: 'Purchase',
        partyName: 'Invariant Supplier',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'Materials', qty: 1, rate: 20000, taxRate: 15, amount: 20000 },
        ],
      })
      expectStoreInvariants()
      const d = storeState()
      const vatIn = d.accounts.find((a) => a.id === 'acc-vat-in')!
      expect(vatIn.rootType).toBe('Asset')
      expect(vatIn.balance).toBe(round2(vatInBefore + 3000))
    })

    it('markInvoicePaid keeps balances == journals', async () => {
      const store = useBooksStore.getState()
      await store.saveInvoice({
        id: 'inv-inv-1',
        type: 'Sales',
        partyName: 'Paying Invariant Client',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'Works', qty: 1, rate: 10000, taxRate: 15, amount: 10000 },
        ],
      })
      await store.markInvoicePaid('inv-inv-1')
      expectStoreInvariants()
    })

    it('deleteInvoice reverses journals and keeps balances == journals', async () => {
      const store = useBooksStore.getState()
      const baselineAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
      await store.saveInvoice({
        id: 'inv-del-1',
        type: 'Sales',
        partyName: 'Ephemeral Invariant Client',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'Works', qty: 1, rate: 10000, taxRate: 15, amount: 10000 },
        ],
      })
      await store.deleteInvoice('inv-del-1')
      expectStoreInvariants()
      expect(storeState().accounts.find((a) => a.id === 'acc-ar')!.balance).toBe(baselineAr)
    })

    it('editing a posted invoice reverses and re-posts so the ledger agrees', async () => {
      const store = useBooksStore.getState()
      await store.saveInvoice({
        id: 'inv-edit-1',
        type: 'Sales',
        partyName: 'Edit Co',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'Works', qty: 1, rate: 10000, taxRate: 15, amount: 10000 },
        ],
      })
      const arAfterCreate = storeState().accounts.find((a) => a.id === 'acc-ar')!.balance
      const journalCountAfterCreate = storeState().journalEntries.length

      // Change the value of the posted invoice.
      await store.saveInvoice({
        id: 'inv-edit-1',
        type: 'Sales',
        partyName: 'Edit Co',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'Works', qty: 1, rate: 20000, taxRate: 15, amount: 20000 },
        ],
      })

      expectStoreInvariants()
      const d = storeState()
      const inv = d.invoices.find((i) => i.id === 'inv-edit-1')!
      const ar = d.accounts.find((a) => a.id === 'acc-ar')!.balance
      // Old posting (11,500) reversed, new posting (23,000) posted:
      // journals return to the pre-edit count, AR reflects the new value.
      expect(d.journalEntries.length).toBe(journalCountAfterCreate)
      expect(ar).toBe(round2(arAfterCreate - 11500 + inv.grandTotal))
      expect(ar).toBe(round2(195500 + inv.grandTotal))
    })

    it('editing a PARTIALLY settled invoice preserves the paid portion', async () => {
      const store = useBooksStore.getState()
      // Create an 11,500 invoice, then settle 5,000 of it via a bank
      // transaction (direct settlement path in the renderer fallback).
      await store.saveInvoice({
        id: 'inv-partial-1',
        type: 'Sales',
        partyName: 'Partial Client',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'Works', qty: 1, rate: 10000, taxRate: 15, amount: 10000 },
        ],
      })
      useBooksStore.setState({
        data: {
          ...storeState(),
          bankTransactions: [
            {
              id: 'tx-partial-1',
              accountId: 'acc-bank',
              date: '2026-09-10',
              description: 'Partial EFT',
              amount: 5000,
              reconciled: false,
            },
          ],
        },
      })
      const reconciled = await useBooksStore
        .getState()
        .reconcileTransaction('tx-partial-1', 'inv-partial-1')
      expect(reconciled.ok).toBe(true)
      expect(reconciled.remainingOutstanding).toBe(6500)

      const bankBefore = storeState().accounts.find((a) => a.id === 'acc-bank')!.balance
      expect(bankBefore).toBe(round2(485250 + 5000))

      // Edit the partially settled invoice to a larger amount.
      await store.saveInvoice({
        id: 'inv-partial-1',
        type: 'Sales',
        partyName: 'Partial Client',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'Works', qty: 1, rate: 20000, taxRate: 15, amount: 20000 },
        ],
      })

      expectStoreInvariants()
      const d = storeState()
      const inv = d.invoices.find((i) => i.id === 'inv-partial-1')!
      const ar = d.accounts.find((a) => a.id === 'acc-ar')!.balance
      const bank = d.accounts.find((a) => a.id === 'acc-bank')!.balance
      // The 5,000 already paid must survive the reverse-and-repost:
      // AR = opening 195,500 + new 23,000 - paid 5,000; bank keeps the 5,000.
      expect(ar).toBe(round2(195500 + inv.grandTotal - 5000))
      expect(bank).toBe(round2(485250 + 5000))
      expect(inv.outstandingAmount).toBe(round2(inv.grandTotal - 5000))
    })

    it('addJournalEntry rejects unbalanced entries and keeps balances == journals', async () => {
      const store = useBooksStore.getState()
      const ok = await store.addJournalEntry({
        date: '2026-09-01',
        remarks: 'Unbalanced attempt',
        items: [{ id: 'i1', accountId: 'acc-bank', accountName: 'Bank', debit: 100, credit: 0 }],
      })
      expect(ok).toBe(false)
      expectStoreInvariants()
    })

    it('addJournalEntry posts balanced manual entries via recompute', async () => {
      const store = useBooksStore.getState()
      const ok = await store.addJournalEntry({
        date: '2026-09-01',
        remarks: 'Manual transfer',
        items: [
          { id: 'i1', accountId: 'acc-bank', accountName: 'Bank', debit: 250, credit: 0 },
          { id: 'i2', accountId: 'acc-cash', accountName: 'Cash', debit: 0, credit: 250 },
        ],
      })
      expect(ok).toBe(true)
      expectStoreInvariants()
      const d = storeState()
      expect(d.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(round2(485250 + 250))
      expect(d.accounts.find((a) => a.id === 'acc-cash')!.balance).toBe(round2(15000 - 250))
    })
  })

  describe('Central invoice & journal numbering', () => {
    const mkInvoice = (invoiceNumber: string): Invoice => ({
      id: `inv-${invoiceNumber}`,
      invoiceNumber,
      type: 'Sales',
      partyId: 'p',
      partyName: 'P',
      date: '2026-01-01',
      dueDate: '2026-02-01',
      items: [],
      subtotal: 1,
      taxTotal: 0,
      grandTotal: 1,
      outstandingAmount: 1,
      status: 'Unpaid',
      createdAt: '',
      updatedAt: '',
    })

    it('nextInvoiceNumber uses max sequence, never length+1', () => {
      // With 001 and 003 present (002 deleted), length-based numbering would
      // collide on 003; max-based numbering continues past the highest seen.
      const remaining = [mkInvoice('INV-2026-001'), mkInvoice('INV-2026-003')]
      expect(nextInvoiceNumber(remaining, 'Sales', '2026-05-01')).toBe('INV-2026-004')
      expect(nextInvoiceNumber([], 'Purchase', '2026-05-01')).toBe('BILL-2026-001')
    })

    it('nextJournalNumber never reuses a number after deletion', () => {
      const jes: JournalEntry[] = [
        {
          id: 'j1',
          entryNumber: 'JE-2026-001',
          date: '2026-01-01',
          items: [],
          totalDebit: 0,
          totalCredit: 0,
          posted: true,
        },
        {
          id: 'j2',
          entryNumber: 'JE-2026-002',
          date: '2026-01-02',
          items: [],
          totalDebit: 0,
          totalCredit: 0,
          posted: true,
        },
      ]
      expect(nextJournalNumber(jes, '2026-01-03')).toBe('JE-2026-003')
    })
  })

  describe('Opening balances & migration', () => {
    it('createOpeningJournal always balances and derives residual into retained earnings', () => {
      const accounts = EMPTY_ACCOUNTS.map((a) => ({ ...a }))
      const bank = accounts.find((a) => a.id === 'acc-bank')!
      bank.balance = 50000
      const sales = accounts.find((a) => a.id === 'acc-sales')!
      sales.balance = 120000

      const je = createOpeningJournal(accounts, { date: '2026-03-01' })
      expect(je.totalDebit).toBe(je.totalCredit)
      expect(allJournalsBalanced([je])).toBe(true)
      // Unbalanced legacy input (50k debit vs 120k credit) is absorbed by retained.
      const retainedItem = je.items.find((i) => i.accountId === 'acc-retained')
      expect(retainedItem).toBeDefined()
      expect(retainedItem!.debit).toBe(70000)
    })

    it('migrates legacy stores with an opening entry and satisfies the invariant after read', () => {
      writeBooksStore(booksDataPath, {
        version: 0,
        updatedAt: new Date().toISOString(),
        settings: { companyName: 'Legacy Co', currency: 'ZAR', currencySymbol: 'R' },
        accounts: [
          {
            id: 'acc-bank',
            name: 'Old Bank',
            rootType: 'Asset',
            accountType: 'Bank',
            parentId: 'acc-curr-asset',
            isGroup: false,
            balance: 50000,
          },
          {
            id: 'acc-sales',
            name: 'Old Sales',
            rootType: 'Income',
            accountType: 'Direct Income',
            parentId: 'acc-income',
            isGroup: false,
            balance: 120000,
          },
        ],
        parties: [],
        invoices: [],
        journalEntries: [],
        bankTransactions: [],
      })

      const migrated = readBooksStore(booksDataPath)
      expect(migrated.journalEntries.some((je) => je.entryNumber.startsWith('JE-OPENING'))).toBe(
        true,
      )
      expect(allJournalsBalanced(migrated.journalEntries)).toBe(true)
      expect(accountsMatchJournals(migrated.accounts, migrated.journalEntries)).toBe(true)
      expect(migrated.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(50000)
      expect(migrated.accounts.find((a) => a.id === 'acc-sales')!.balance).toBe(120000)
    })

    it('legacy VAT input account is migrated to the asset side', () => {
      const migrated = migrateAndValidateBooks({
        version: 1,
        updatedAt: new Date().toISOString(),
        settings: { companyName: 'Co', currency: 'ZAR', currencySymbol: 'R' },
        accounts: [
          {
            id: 'acc-vat-in',
            name: 'SARS VAT Input',
            rootType: 'Liability',
            accountType: 'Tax',
            parentId: 'acc-curr-liab',
            isGroup: false,
            balance: 0,
          },
        ],
        parties: [],
        invoices: [],
        journalEntries: [],
        bankTransactions: [],
      })
      const vatIn = migrated.accounts.find((a) => a.id === 'acc-vat-in')!
      expect(vatIn.rootType).toBe('Asset')
      expect(vatIn.parentId).toBe('acc-curr-asset')
    })
  })

  describe('issueSalesInvoiceInBooks (single posting path)', () => {
    it('creates the invoice, posts a balanced journal, recomputes balances, broadcasts', () => {
      const res = issueSalesInvoiceInBooks({
        booksDataPath,
        partyName: 'Ekurhuleni Water Dept',
        itemDescription: 'Milestone 1 per RFP-WTR-2026-04',
        amount: 145000,
      })
      expect(res.ok).toBe(true)
      expect(res.invoice).toBeDefined()
      const inv = res.invoice!
      expect(inv.invoiceNumber).toBe('INV-2026-001')
      expect(inv.type).toBe('Sales')
      expect(round2(inv.subtotal + inv.taxTotal)).toBe(inv.grandTotal)
      expect(inv.grandTotal).toBe(145000)

      const data = readBooksStore(booksDataPath)
      expect(data.invoices).toHaveLength(1)
      expect(allJournalsBalanced(data.journalEntries)).toBe(true)
      expect(accountsMatchJournals(data.accounts, data.journalEntries)).toBe(true)
      const ar = data.accounts.find((a) => a.id === 'acc-ar')!
      expect(ar.balance).toBe(inv.grandTotal)
      const vat = data.accounts.find((a) => a.id === 'acc-vat')!
      expect(vat.balance).toBe(inv.taxTotal)
    })

    it('numbers invoices sequentially without collision across calls', () => {
      issueSalesInvoiceInBooks({ booksDataPath, partyName: 'A', itemDescription: 'X', amount: 100 })
      issueSalesInvoiceInBooks({ booksDataPath, partyName: 'B', itemDescription: 'Y', amount: 200 })
      const data = readBooksStore(booksDataPath)
      const numbers = data.invoices.map((i) => i.invoiceNumber)
      expect(new Set(numbers).size).toBe(numbers.length)
      expect(numbers).toContain('INV-2026-001')
      expect(numbers).toContain('INV-2026-002')
    })

    it('rejects non-positive amounts and missing party names', () => {
      const badAmount = issueSalesInvoiceInBooks({
        booksDataPath,
        partyName: 'A',
        itemDescription: 'X',
        amount: 0,
      })
      expect(badAmount.ok).toBe(false)
      const badParty = issueSalesInvoiceInBooks({
        booksDataPath,
        partyName: '  ',
        itemDescription: 'X',
        amount: 100,
      })
      expect(badParty.ok).toBe(false)
    })
  })

  describe('Bank import & reconciliation post journals (Suspense)', () => {
    it('importBankStatement posts a bank/suspense journal and updates the bank balance from journals', () => {
      const csv = [
        'Date,Description,Reference,Amount',
        '2026-09-05,"EFT Deposit","INV-2026-001",115000.00',
        '2026-09-06,"Supplier Payment","",-23000.00',
      ].join('\n')

      const res = importBankStatement({ booksDataPath, csvContent: csv })
      expect(res.ok).toBe(true)
      expect(res.importedCount).toBe(2)

      const data = readBooksStore(booksDataPath)
      expect(allJournalsBalanced(data.journalEntries)).toBe(true)
      expect(accountsMatchJournals(data.accounts, data.journalEntries)).toBe(true)
      const bank = data.accounts.find((a) => a.id === 'acc-bank')!
      const suspense = data.accounts.find((a) => a.id === 'acc-suspense')!
      // Deposit posts Dr Bank 115,000 / Cr Suspense; withdrawal Cr Bank / Dr
      // Suspense. Suspense (asset, debit-normal) mirrors the bank movement.
      expect(bank.balance).toBe(round2(115000 - 23000))
      expect(suspense.balance).toBe(round2(23000 - 115000))
      expect(res.newBankBalance).toBe(bank.balance)
    })

    it('reconciliation of an imported transaction reclasses suspense against AR without touching bank', () => {
      issueSalesInvoiceInBooks({
        booksDataPath,
        partyName: 'Transnet SOC Ltd',
        itemDescription: 'Works',
        amount: 115000,
      })
      const inv = readBooksStore(booksDataPath).invoices[0]

      const csv = [
        'Date,Description,Reference,Amount',
        '2026-09-10,"EFT INV-2026-001 Transnet","INV-2026-001",115000.00',
      ].join('\n')
      const importRes = importBankStatement({ booksDataPath, csvContent: csv })
      expect(importRes.ok).toBe(true)

      const tx: BankTransaction = readBooksStore(booksDataPath).bankTransactions[0]
      const reconRes = executeReconciliation({
        booksDataPath,
        transactionId: tx.id,
        invoiceId: inv.id,
      })
      expect(reconRes.ok).toBe(true)
      expect(reconRes.invoiceStatus).toBe('Paid')

      const data = readBooksStore(booksDataPath)
      expect(allJournalsBalanced(data.journalEntries)).toBe(true)
      expect(accountsMatchJournals(data.accounts, data.journalEntries)).toBe(true)

      const bank = data.accounts.find((a) => a.id === 'acc-bank')!
      const ar = data.accounts.find((a) => a.id === 'acc-ar')!
      const suspense = data.accounts.find((a) => a.id === 'acc-suspense')!
      // Bank keeps the import movement only; AR is settled via suspense reclass.
      expect(bank.balance).toBe(115000)
      expect(ar.balance).toBe(0)
      expect(suspense.balance).toBe(0)
    })

    it('renderer fallback reconcile of imported transactions clears suspense', async () => {
      const store = useBooksStore.getState()
      const tx: BankTransaction = {
        id: 'tx-import-1',
        accountId: 'acc-bank',
        date: '2026-09-10',
        description: 'EFT Payment',
        reference: 'INV-2026-001',
        amount: 57500,
        reconciled: false,
      }
      // Simulate an already-imported transaction (import journal present).
      const importJournal: JournalEntry = {
        id: 'je-import-tx-import-1',
        entryNumber: 'JE-2026-IMP-1',
        date: '2026-09-10',
        posted: true,
        totalDebit: 57500,
        totalCredit: 57500,
        remarks: 'Bank statement import: tx-import-1 - EFT Payment',
        items: [
          { id: 'b1', accountId: 'acc-bank', accountName: 'Bank', debit: 57500, credit: 0 },
          { id: 'b2', accountId: 'acc-suspense', accountName: 'Suspense', debit: 0, credit: 57500 },
        ],
      }

      useBooksStore.setState({
        data: {
          ...store.data,
          bankTransactions: [tx],
          journalEntries: [importJournal, ...store.data.journalEntries],
        },
      })
      await store.saveInvoice({
        id: 'inv-recon-1',
        type: 'Sales',
        partyName: 'Recon Client',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'Works', qty: 1, rate: 50000, taxRate: 15, amount: 50000 },
        ],
      })

      const res = await useBooksStore.getState().reconcileTransaction('tx-import-1', 'inv-recon-1')
      expect(res.ok).toBe(true)
      expectStoreInvariants()
      const d = storeState()
      const suspense = d.accounts.find((a) => a.id === 'acc-suspense')!
      expect(suspense.balance).toBe(0)
      const ar = d.accounts.find((a) => a.id === 'acc-ar')!
      // Opening AR 195,500 + invoice posting 57,500 - reclass settlement 57,500.
      expect(ar.balance).toBe(195500)
    })
  })
})

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  writeBooksStore,
  readBooksStore,
  executeReconciliation,
  computeSettlementSuggestions,
} from '../src/main/books-main'
import { useBooksStore } from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import type { BooksDataEnvelope, Invoice, BankTransaction, Party } from '../src/shared/types'

describe('F19 & F12/F13 Bank Reconciliation Engine Suite', () => {
  let testDir: string
  let booksDataPath: string
  let tendersDataPath: string

  beforeEach(() => {
    testDir = join(tmpdir(), `books-recon-test-${randomUUID().slice(0, 8)}`)
    mkdirSync(join(testDir, 'books'), { recursive: true })
    mkdirSync(join(testDir, 'tenders'), { recursive: true })
    booksDataPath = join(testDir, 'books', 'books-data.json')
    tendersDataPath = join(testDir, 'tenders', 'tenders-data.json')

    useBooksStore.setState({
      activeTab: 'dashboard',
      data: JSON.parse(JSON.stringify(initialBooksData)),
      activeInvoiceId: null,
      invoiceStatusFilter: 'All',
      activeReport: 'profit-loss',
      printInvoice: null,
      searchTerm: '',
    })
  })

  afterEach(() => {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    } catch {}
  })

  describe('Exact Settlement Math & Journal Generation', () => {
    it('executes full exact reconciliation: sets Paid, posts balanced journal, updates balances', () => {
      const party: Party = {
        id: 'party-cust-1',
        name: 'Transnet SOC Ltd',
        type: 'Customer',
        outstandingBalance: 115000,
      }

      const invoice: Invoice = {
        id: 'inv-101',
        invoiceNumber: 'INV-2026-101',
        type: 'Sales',
        partyId: party.id,
        partyName: party.name,
        status: 'Unpaid',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        subtotal: 100000,
        taxTotal: 15000,
        grandTotal: 115000,
        outstandingAmount: 115000,
        items: [],
      }

      const bankTx: BankTransaction = {
        id: 'tx-dep-101',
        accountId: 'acc-bank',
        date: '2026-09-05',
        description: 'EFT Settlement INV-2026-101 Transnet',
        reference: 'INV-2026-101',
        amount: 115000,
        reconciled: false,
      }

      const seedData = {
        ...initialBooksData,
        parties: [party],
        invoices: [invoice],
        bankTransactions: [bankTx],
      }
      writeBooksStore(booksDataPath, seedData)

      const preData = readBooksStore(booksDataPath)
      const preAr = preData.accounts.find((a) => a.id === 'acc-ar')!.balance
      const preJournals = preData.journalEntries.length

      const res = executeReconciliation({
        booksDataPath,
        transactionId: 'tx-dep-101',
        invoiceId: 'inv-101',
      })

      expect(res.ok).toBe(true)
      expect(res.settledAmount).toBe(115000)
      expect(res.remainingOutstanding).toBe(0)
      expect(res.invoiceStatus).toBe('Paid')

      const postData = readBooksStore(booksDataPath)
      const updatedTx = postData.bankTransactions.find((t) => t.id === 'tx-dep-101')!
      expect(updatedTx.reconciled).toBe(true)
      expect(updatedTx.matchedInvoiceId).toBe('inv-101')

      const updatedInv = postData.invoices.find((i) => i.id === 'inv-101')!
      expect(updatedInv.status).toBe('Paid')
      expect(updatedInv.outstandingAmount).toBe(0)

      // AR is deducted by settledAmount
      const postAr = postData.accounts.find((a) => a.id === 'acc-ar')!.balance
      expect(postAr).toBe(Math.max(0, preAr - 115000))

      // Party balance is recomputed to 0
      const updatedParty = postData.parties.find((p) => p.id === party.id)!
      expect(updatedParty.outstandingBalance).toBe(0)

      // Balanced settlement journal is prepended
      expect(postData.journalEntries.length).toBe(preJournals + 1)
      const settlementJ = postData.journalEntries[0]
      expect(settlementJ.totalDebit).toBe(115000)
      expect(settlementJ.totalCredit).toBe(115000)
      const bankItem = settlementJ.items.find((i) => i.accountId === 'acc-bank')
      const arItem = settlementJ.items.find((i) => i.accountId === 'acc-ar')
      expect(bankItem?.debit).toBe(115000)
      expect(arItem?.credit).toBe(115000)
    })
  })

  describe('Partial Settlement Math & Multi-Step Settlement', () => {
    it('binds to actual tx.amount on partial settlement, keeps invoice Unpaid, and deducts outstanding', () => {
      const invoice: Invoice = {
        id: 'inv-part-1',
        invoiceNumber: 'INV-PART-01',
        type: 'Sales',
        partyId: 'p-corp',
        partyName: 'Corporate Client',
        status: 'Unpaid',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        subtotal: 50000,
        taxTotal: 7500,
        grandTotal: 57500,
        outstandingAmount: 57500,
        items: [],
      }

      const partialTx: BankTransaction = {
        id: 'tx-part-1',
        accountId: 'acc-bank',
        date: '2026-09-03',
        description: 'First Tranche (R20,000)',
        amount: 20000,
        reconciled: false,
      }

      writeBooksStore(booksDataPath, {
        ...initialBooksData,
        parties: [{ id: 'p-corp', name: 'Corporate Client', type: 'Customer', outstandingBalance: 57500 }],
        invoices: [invoice],
        bankTransactions: [partialTx],
      })

      const res = executeReconciliation({
        booksDataPath,
        transactionId: 'tx-part-1',
        invoiceId: 'inv-part-1',
      })

      expect(res.ok).toBe(true)
      expect(res.settledAmount).toBe(20000)
      expect(res.remainingOutstanding).toBe(37500)
      expect(res.invoiceStatus).toBe('Unpaid')

      const postData = readBooksStore(booksDataPath)
      const inv = postData.invoices.find((i) => i.id === 'inv-part-1')!
      expect(inv.status).toBe('Unpaid')
      expect(inv.outstandingAmount).toBe(37500)

      const party = postData.parties.find((p) => p.id === 'p-corp')!
      expect(party.outstandingBalance).toBe(37500)

      const journal = postData.journalEntries[0]
      expect(journal.totalDebit).toBe(20000)
      expect(journal.totalCredit).toBe(20000)
    })

    it('settles invoice completely across two successive partial bank transactions', () => {
      const invoice: Invoice = {
        id: 'inv-two-step',
        invoiceNumber: 'INV-2STEP',
        type: 'Sales',
        partyId: 'p-corp',
        partyName: 'Corporate Client',
        status: 'Unpaid',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        subtotal: 10000,
        taxTotal: 1500,
        grandTotal: 11500,
        outstandingAmount: 11500,
        items: [],
      }

      const tx1: BankTransaction = {
        id: 'tx-step-1',
        accountId: 'acc-bank',
        date: '2026-09-02',
        description: 'Tranche 1',
        amount: 6000,
        reconciled: false,
      }
      const tx2: BankTransaction = {
        id: 'tx-step-2',
        accountId: 'acc-bank',
        date: '2026-09-04',
        description: 'Tranche 2 (final)',
        amount: 5500,
        reconciled: false,
      }

      writeBooksStore(booksDataPath, {
        ...initialBooksData,
        parties: [{ id: 'p-corp', name: 'Corporate Client', type: 'Customer', outstandingBalance: 11500 }],
        invoices: [invoice],
        bankTransactions: [tx1, tx2],
      })

      // First reconciliation
      const res1 = executeReconciliation({ booksDataPath, transactionId: 'tx-step-1', invoiceId: 'inv-two-step' })
      expect(res1.ok).toBe(true)
      expect(res1.remainingOutstanding).toBe(5500)
      expect(res1.invoiceStatus).toBe('Unpaid')

      // Second reconciliation
      const res2 = executeReconciliation({ booksDataPath, transactionId: 'tx-step-2', invoiceId: 'inv-two-step' })
      expect(res2.ok).toBe(true)
      expect(res2.remainingOutstanding).toBe(0)
      expect(res2.invoiceStatus).toBe('Paid')

      const finalData = readBooksStore(booksDataPath)
      const inv = finalData.invoices.find((i) => i.id === 'inv-two-step')!
      expect(inv.status).toBe('Paid')
      expect(inv.outstandingAmount).toBe(0)

      const party = finalData.parties.find((p) => p.id === 'p-corp')!
      expect(party.outstandingBalance).toBe(0)
    })

    it('settles purchase bills against negative bank withdrawal transactions', () => {
      const bill: Invoice = {
        id: 'pb-recon-1',
        invoiceNumber: 'BILL-REC-01',
        type: 'Purchase',
        partyId: 'p-supp',
        partyName: 'Material Supplier',
        status: 'Unpaid',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        subtotal: 20000,
        taxTotal: 3000,
        grandTotal: 23000,
        outstandingAmount: 23000,
        items: [],
      }

      const tx: BankTransaction = {
        id: 'tx-bill-pay',
        accountId: 'acc-bank',
        date: '2026-09-05',
        description: 'Supplier Payment EFT Material Supplier',
        amount: -23000,
        reconciled: false,
      }

      writeBooksStore(booksDataPath, {
        ...initialBooksData,
        parties: [{ id: 'p-supp', name: 'Material Supplier', type: 'Supplier', outstandingBalance: 23000 }],
        invoices: [bill],
        bankTransactions: [tx],
      })

      const res = executeReconciliation({
        booksDataPath,
        transactionId: 'tx-bill-pay',
        invoiceId: 'pb-recon-1',
      })

      expect(res.ok).toBe(true)
      expect(res.settledAmount).toBe(23000)
      expect(res.invoiceStatus).toBe('Paid')

      const postData = readBooksStore(booksDataPath)
      const settlementJ = postData.journalEntries[0]
      expect(settlementJ.totalDebit).toBe(23000)
      expect(settlementJ.totalCredit).toBe(23000)

      const apItem = settlementJ.items.find((i) => i.accountId === 'acc-ap')
      const bankItem = settlementJ.items.find((i) => i.accountId === 'acc-bank')
      expect(apItem?.debit).toBe(23000)
      expect(bankItem?.credit).toBe(23000)
    })
  })

  describe('Cross-App Tender Milestone Back-Propagation', () => {
    it('does NOT transition tender milestone to PAID on partial settlement', () => {
      const tenderStoreContent = {
        version: 1,
        updatedAt: new Date().toISOString(),
        workspaces: [
          {
            id: 'ws-1',
            tenders: [
              {
                id: 'tender-wtr',
                referenceNumber: 'RFP-WTR-2026-04',
                title: 'Water Treatment Refurbishment',
                milestones: [
                  {
                    id: 'm-1',
                    title: 'Engineering Site Delivery',
                    amount: 50000,
                    status: 'BILLED',
                    billedInvoiceId: 'inv-tender-1',
                    billedInvoiceNumber: 'INV-TENDER-01',
                  },
                ],
              },
            ],
          },
        ],
      }
      writeFileSync(tendersDataPath, JSON.stringify(tenderStoreContent, null, 2), 'utf8')

      const invoice: Invoice = {
        id: 'inv-tender-1',
        invoiceNumber: 'INV-TENDER-01',
        type: 'Sales',
        partyId: 'p-wtr',
        partyName: 'Department of Water & Sanitation',
        tenderReference: 'RFP-WTR-2026-04',
        status: 'Unpaid',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        subtotal: 50000,
        taxTotal: 7500,
        grandTotal: 57500,
        outstandingAmount: 57500,
        items: [],
      }

      // Partial payment of 20000
      const tx: BankTransaction = {
        id: 'tx-tender-partial',
        accountId: 'acc-bank',
        date: '2026-09-05',
        description: 'Partial Grant Water Dept RFP-WTR-2026-04',
        amount: 20000,
        reconciled: false,
      }

      writeBooksStore(booksDataPath, {
        ...initialBooksData,
        parties: [{ id: 'p-wtr', name: 'Department of Water & Sanitation', type: 'Customer', outstandingBalance: 57500 }],
        invoices: [invoice],
        bankTransactions: [tx],
      })

      const res = executeReconciliation({
        booksDataPath,
        tendersDataPath,
        transactionId: 'tx-tender-partial',
        invoiceId: 'inv-tender-1',
      })

      expect(res.ok).toBe(true)
      expect(res.tenderMilestonePaid).toBe(false)

      const tendersPost = JSON.parse(readFileSync(tendersDataPath, 'utf8'))
      const milestone = tendersPost.workspaces[0].tenders[0].milestones[0]
      expect(milestone.status).toBe('BILLED') // Still BILLED, NOT PAID
    })

    it('transitions tender milestone to PAID when invoice is FULLY settled', () => {
      const tenderStoreContent = {
        version: 1,
        updatedAt: new Date().toISOString(),
        workspaces: [
          {
            id: 'ws-1',
            tenders: [
              {
                id: 'tender-wtr',
                referenceNumber: 'RFP-WTR-2026-04',
                title: 'Water Treatment Refurbishment',
                milestones: [
                  {
                    id: 'm-1',
                    title: 'Engineering Site Delivery',
                    amount: 50000,
                    status: 'BILLED',
                    billedInvoiceId: 'inv-tender-full',
                    billedInvoiceNumber: 'INV-TENDER-FULL',
                  },
                ],
              },
            ],
          },
        ],
      }
      writeFileSync(tendersDataPath, JSON.stringify(tenderStoreContent, null, 2), 'utf8')

      const invoice: Invoice = {
        id: 'inv-tender-full',
        invoiceNumber: 'INV-TENDER-FULL',
        type: 'Sales',
        partyId: 'p-wtr',
        partyName: 'Department of Water & Sanitation',
        tenderReference: 'RFP-WTR-2026-04',
        status: 'Unpaid',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        subtotal: 50000,
        taxTotal: 7500,
        grandTotal: 57500,
        outstandingAmount: 57500,
        items: [],
      }

      const tx: BankTransaction = {
        id: 'tx-tender-full',
        accountId: 'acc-bank',
        date: '2026-09-05',
        description: 'Full Payment DWS RFP-WTR-2026-04 INV-TENDER-FULL',
        amount: 57500,
        reconciled: false,
      }

      writeBooksStore(booksDataPath, {
        ...initialBooksData,
        parties: [{ id: 'p-wtr', name: 'Department of Water & Sanitation', type: 'Customer', outstandingBalance: 57500 }],
        invoices: [invoice],
        bankTransactions: [tx],
      })

      const res = executeReconciliation({
        booksDataPath,
        tendersDataPath,
        transactionId: 'tx-tender-full',
        invoiceId: 'inv-tender-full',
      })

      expect(res.ok).toBe(true)
      expect(res.tenderMilestonePaid).toBe(true)
      expect(res.matchedMilestoneId).toBe('m-1')

      const tendersPost = JSON.parse(readFileSync(tendersDataPath, 'utf8'))
      const milestone = tendersPost.workspaces[0].tenders[0].milestones[0]
      expect(milestone.status).toBe('PAID')
    })
  })

  describe('Reconciliation Rejection Guards', () => {
    it('rejects double-reconciliation of already reconciled transaction', () => {
      const tx: BankTransaction = {
        id: 'tx-done',
        accountId: 'acc-bank',
        date: '2026-09-01',
        description: 'Done',
        amount: 1000,
        reconciled: true,
      }
      const inv: Invoice = {
        id: 'inv-open',
        invoiceNumber: 'INV-OPEN',
        type: 'Sales',
        status: 'Unpaid',
        items: [],
        subtotal: 1000,
        taxTotal: 0,
        grandTotal: 1000,
        outstandingAmount: 1000,
        date: '2026-09-01',
        dueDate: '2026-10-01',
      }
      writeBooksStore(booksDataPath, {
        ...initialBooksData,
        invoices: [inv],
        bankTransactions: [tx],
      })

      const res = executeReconciliation({ booksDataPath, transactionId: 'tx-done', invoiceId: 'inv-open' })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/already reconciled/i)
    })

    it('rejects reconciliation of draft or cancelled invoices', () => {
      const tx: BankTransaction = { id: 'tx-1', accountId: 'acc-bank', date: '2026-09-01', description: 'Test', amount: 5000, reconciled: false }
      const draftInv: Invoice = {
        id: 'inv-draft',
        invoiceNumber: 'DRAFT-1',
        type: 'Sales',
        status: 'Draft',
        items: [],
        subtotal: 5000,
        taxTotal: 0,
        grandTotal: 5000,
        outstandingAmount: 5000,
        date: '2026-09-01',
        dueDate: '2026-10-01',
      }
      const cancelledInv: Invoice = {
        ...draftInv,
        id: 'inv-cancel',
        status: 'Cancelled',
      }

      writeBooksStore(booksDataPath, { ...initialBooksData, invoices: [draftInv, cancelledInv], bankTransactions: [tx] })

      const resDraft = executeReconciliation({ booksDataPath, transactionId: 'tx-1', invoiceId: 'inv-draft' })
      expect(resDraft.ok).toBe(false)
      expect(resDraft.error).toMatch(/draft/i)

      const resCancel = executeReconciliation({ booksDataPath, transactionId: 'tx-1', invoiceId: 'inv-cancel' })
      expect(resCancel.ok).toBe(false)
      expect(resCancel.error).toMatch(/cancelled/i)
    })

    it('rejects transaction direction mismatches (withdrawal against Sales, deposit against Purchase)', () => {
      const salesInv: Invoice = {
        id: 'inv-sales',
        invoiceNumber: 'INV-S',
        type: 'Sales',
        status: 'Unpaid',
        items: [],
        subtotal: 5000,
        taxTotal: 0,
        grandTotal: 5000,
        outstandingAmount: 5000,
        date: '2026-09-01',
        dueDate: '2026-10-01',
      }
      const purchaseBill: Invoice = {
        id: 'inv-purchase',
        invoiceNumber: 'BILL-P',
        type: 'Purchase',
        status: 'Unpaid',
        items: [],
        subtotal: 5000,
        taxTotal: 0,
        grandTotal: 5000,
        outstandingAmount: 5000,
        date: '2026-09-01',
        dueDate: '2026-10-01',
      }

      const withdrawalTx: BankTransaction = { id: 'tx-w', accountId: 'acc-bank', date: '2026-09-01', description: 'Debit', amount: -5000, reconciled: false }
      const depositTx: BankTransaction = { id: 'tx-d', accountId: 'acc-bank', date: '2026-09-01', description: 'Credit', amount: 5000, reconciled: false }

      writeBooksStore(booksDataPath, {
        ...initialBooksData,
        invoices: [salesInv, purchaseBill],
        bankTransactions: [withdrawalTx, depositTx],
      })

      const res1 = executeReconciliation({ booksDataPath, transactionId: 'tx-w', invoiceId: 'inv-sales' })
      expect(res1.ok).toBe(false)
      expect(res1.error).toMatch(/debit\/withdrawal.*Sales/i)

      const res2 = executeReconciliation({ booksDataPath, transactionId: 'tx-d', invoiceId: 'inv-purchase' })
      expect(res2.ok).toBe(false)
      expect(res2.error).toMatch(/credit\/deposit.*Purchase/i)
    })
  })

  describe('Settlement Suggestions Algorithm', () => {
    it('suggests exact matches with HIGH confidence when invoice number or party token is present', () => {
      const invoice: Invoice = {
        id: 'inv-sugg-1',
        invoiceNumber: 'INV-9901',
        partyName: 'Sasol Synfuels',
        type: 'Sales',
        status: 'Unpaid',
        subtotal: 30000,
        taxTotal: 4500,
        grandTotal: 34500,
        outstandingAmount: 34500,
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [],
      }
      const tx: BankTransaction = {
        id: 'tx-sugg-1',
        accountId: 'acc-bank',
        date: '2026-09-05',
        description: 'EFT Deposit Sasol INV-9901',
        amount: 34500,
        reconciled: false,
      }

      const suggestions = computeSettlementSuggestions({
        ...initialBooksData,
        invoices: [invoice],
        bankTransactions: [tx],
      })

      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].invoiceId).toBe('inv-sugg-1')
      expect(suggestions[0].confidence).toBe('HIGH')
      expect(suggestions[0].reason).toContain('INV-9901')
    })
  })
})

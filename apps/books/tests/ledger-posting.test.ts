import { describe, it, expect, beforeEach } from 'vitest'
import {
  round2,
  createSalesInvoiceJournal,
  createPurchaseBillJournal,
  createSettlementJournal,
} from '../src/shared/accounting'
import { CORE_ACCOUNTS } from '../src/main/books-main'
import { useBooksStore } from '../src/renderer/src/store'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import type { Invoice, Party } from '../src/shared/types'

describe('F18 Ledger Posting & Store State Machine Suite', () => {
  beforeEach(() => {
    // Reset Zustand store with cloned initial state
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

  describe('Sales Invoice Journal Generation & Posting', () => {
    it('creates a strictly balanced sales journal with multi-account credits', () => {
      const party: Party = {
        id: 'party-cust-1',
        name: 'Transnet Engineering',
        type: 'Customer',
        outstandingBalance: 0,
      }

      const invoice: Invoice = {
        id: 'inv-multi-acc',
        invoiceNumber: 'INV-2026-901',
        type: 'Sales',
        partyId: party.id,
        partyName: party.name,
        date: '2026-09-01',
        dueDate: '2026-10-01',
        status: 'Unpaid',
        items: [
          {
            id: 'it-1',
            description: 'Locomotive Sub-assembly',
            qty: 2,
            rate: 40000,
            taxRate: 15,
            amount: 80000,
            accountId: 'acc-sales',
          },
          {
            id: 'it-2',
            description: 'Technical Advisory & Certification',
            qty: 10,
            rate: 2000,
            taxRate: 15,
            amount: 20000,
            accountId: 'acc-consult',
          },
        ],
        subtotal: 100000,
        taxTotal: 15000,
        grandTotal: 115000,
        outstandingAmount: 115000,
      }

      const journal = createSalesInvoiceJournal(invoice, CORE_ACCOUNTS, party)
      expect(journal.totalDebit).toBe(115000)
      expect(journal.totalCredit).toBe(115000)
      expect(journal.posted).toBe(true)

      const arItem = journal.items.find((i) => i.accountId === 'acc-ar')
      const salesItem = journal.items.find((i) => i.accountId === 'acc-sales')
      const consultItem = journal.items.find((i) => i.accountId === 'acc-consult')
      const vatItem = journal.items.find((i) => i.accountId === 'acc-vat' || i.accountId === 'acc-vat-out')

      expect(arItem?.debit).toBe(115000)
      expect(arItem?.credit).toBe(0)
      expect(salesItem?.credit).toBe(80000)
      expect(salesItem?.debit).toBe(0)
      expect(consultItem?.credit).toBe(20000)
      expect(consultItem?.debit).toBe(0)
      expect(vatItem?.credit).toBe(15000)
      expect(vatItem?.debit).toBe(0)
    })

    it('store.saveInvoice posts sales invoice and updates ledger accounts & party balance', async () => {
      const store = useBooksStore.getState()
      const initialAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
      const initialSales = store.data.accounts.find((a) => a.id === 'acc-sales')!.balance
      const initialVat = store.data.accounts.find((a) => a.id === 'acc-vat')!.balance
      const initialJournalsCount = store.data.journalEntries.length

      await store.saveInvoice({
        type: 'Sales',
        partyName: 'Apex Industrial Corp',
        invoiceNumber: 'INV-APEX-001',
        date: '2026-09-02',
        dueDate: '2026-10-02',
        status: 'Unpaid',
        items: [
          {
            id: 'it-1',
            description: 'Plant Automation System',
            qty: 1,
            rate: 50000,
            taxRate: 15,
            amount: 50000,
            accountId: 'acc-sales',
          },
        ],
      })

      const updated = useBooksStore.getState().data
      expect(updated.journalEntries.length).toBe(initialJournalsCount + 1)
      const postedJournal = updated.journalEntries[0]
      expect(postedJournal.totalDebit).toBe(57500)
      expect(postedJournal.totalCredit).toBe(57500)

      const updatedAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
      const updatedSales = updated.accounts.find((a) => a.id === 'acc-sales')!.balance
      const updatedVat = updated.accounts.find((a) => a.id === 'acc-vat')!.balance

      expect(updatedAr).toBe(round2(initialAr + 57500))
      expect(updatedSales).toBe(round2(initialSales + 50000))
      expect(updatedVat).toBe(round2(initialVat + 7500))

      const party = updated.parties.find((p) => p.name === 'Apex Industrial Corp')
      expect(party).toBeDefined()
      expect(party?.outstandingBalance).toBe(57500)
    })
  })

  describe('Purchase Bill Journal Generation & Posting', () => {
    it('creates a strictly balanced purchase journal with expense and input tax debits', () => {
      const party: Party = {
        id: 'party-supp-2',
        name: 'Omni Materials Ltd',
        type: 'Supplier',
        outstandingBalance: 0,
      }

      const bill: Invoice = {
        id: 'bill-omni',
        invoiceNumber: 'PB-2026-101',
        type: 'Purchase',
        partyId: party.id,
        partyName: party.name,
        date: '2026-09-01',
        dueDate: '2026-10-01',
        status: 'Unpaid',
        items: [
          {
            id: 'it-1',
            description: 'Structural Steel Beams',
            qty: 10,
            rate: 6000,
            taxRate: 15,
            amount: 60000,
            accountId: 'acc-materials',
          },
        ],
        subtotal: 60000,
        taxTotal: 9000,
        grandTotal: 69000,
        outstandingAmount: 69000,
      }

      const journal = createPurchaseBillJournal(bill, CORE_ACCOUNTS, party)
      expect(journal.totalDebit).toBe(69000)
      expect(journal.totalCredit).toBe(69000)

      const apItem = journal.items.find((i) => i.accountId === 'acc-ap')
      const matItem = journal.items.find((i) => i.accountId === 'acc-materials')
      const vatInItem = journal.items.find((i) => i.accountId === 'acc-vat-in' || i.accountId === 'acc-vat')

      expect(apItem?.credit).toBe(69000)
      expect(apItem?.debit).toBe(0)
      expect(matItem?.debit).toBe(60000)
      expect(matItem?.credit).toBe(0)
      expect(vatInItem?.debit).toBe(9000)
      expect(vatInItem?.credit).toBe(0)
    })

    it('store.saveInvoice posts purchase bill and updates Accounts Payable & Direct Expense', async () => {
      const store = useBooksStore.getState()
      const initialAp = store.data.accounts.find((a) => a.id === 'acc-ap')!.balance
      const initialMat = store.data.accounts.find((a) => a.id === 'acc-materials')!.balance
      const initialVatIn = store.data.accounts.find((a) => a.id === 'acc-vat-in')!.balance

      await store.saveInvoice({
        type: 'Purchase',
        partyName: 'Omni Materials Ltd',
        invoiceNumber: 'PB-OMNI-002',
        date: '2026-09-02',
        dueDate: '2026-10-02',
        status: 'Unpaid',
        items: [
          {
            id: 'it-1',
            description: 'Heavy Grade Fasteners',
            qty: 100,
            rate: 200,
            taxRate: 15,
            amount: 20000,
            accountId: 'acc-materials',
          },
        ],
      })

      const updated = useBooksStore.getState().data
      const updatedAp = updated.accounts.find((a) => a.id === 'acc-ap')!.balance
      const updatedMat = updated.accounts.find((a) => a.id === 'acc-materials')!.balance
      const updatedVatIn = updated.accounts.find((a) => a.id === 'acc-vat-in')!.balance

      expect(updatedAp).toBe(round2(initialAp + 23000))
      expect(updatedMat).toBe(round2(initialMat + 20000))
      expect(updatedVatIn).toBe(round2(initialVatIn + 3000))

      const supplier = updated.parties.find((p) => p.name === 'Omni Materials Ltd')
      expect(supplier).toBeDefined()
      expect(supplier?.outstandingBalance).toBe(23000)
    })
  })

  describe('Draft-to-Posted Invoice Lifecycle Transitions', () => {
    it('Draft invoice creation does NOT post journal entries or mutate ledger accounts', async () => {
      const store = useBooksStore.getState()
      const initialAccounts = JSON.stringify(store.data.accounts)
      const initialJournalsCount = store.data.journalEntries.length

      await store.saveInvoice({
        id: 'inv-draft-1',
        type: 'Sales',
        partyName: 'Draft Customer Co',
        invoiceNumber: 'DRAFT-001',
        status: 'Draft',
        items: [
          {
            id: 'it-1',
            description: 'Unconfirmed Consulting Scope',
            qty: 1,
            rate: 30000,
            taxRate: 15,
            amount: 30000,
            accountId: 'acc-sales',
          },
        ],
      })

      const stateAfterDraft = useBooksStore.getState().data
      expect(stateAfterDraft.journalEntries.length).toBe(initialJournalsCount)
      expect(JSON.stringify(stateAfterDraft.accounts)).toBe(initialAccounts)

      const draftInv = stateAfterDraft.invoices.find((i) => i.id === 'inv-draft-1')
      expect(draftInv).toBeDefined()
      expect(draftInv?.status).toBe('Draft')
    })

    it('transitioning Draft to Unpaid posts balanced entry and updates balances', async () => {
      const store = useBooksStore.getState()
      await store.saveInvoice({
        id: 'inv-draft-2',
        type: 'Sales',
        partyName: 'Target Customer',
        invoiceNumber: 'DRAFT-002',
        status: 'Draft',
        items: [
          {
            id: 'it-1',
            description: 'Pre-approved Project Phase',
            qty: 1,
            rate: 20000,
            taxRate: 15,
            amount: 20000,
            accountId: 'acc-sales',
          },
        ],
      })

      const journalsBeforePosting = useBooksStore.getState().data.journalEntries.length
      const arBefore = useBooksStore.getState().data.accounts.find((a) => a.id === 'acc-ar')!.balance

      // Now approve/transition to Unpaid
      await store.saveInvoice({
        id: 'inv-draft-2',
        status: 'Unpaid',
      })

      const stateAfterPost = useBooksStore.getState().data
      expect(stateAfterPost.journalEntries.length).toBe(journalsBeforePosting + 1)
      const arAfter = stateAfterPost.accounts.find((a) => a.id === 'acc-ar')!.balance
      expect(arAfter).toBe(round2(arBefore + 23000))

      const postedInv = stateAfterPost.invoices.find((i) => i.id === 'inv-draft-2')
      expect(postedInv?.status).toBe('Unpaid')
      expect(postedInv?.outstandingAmount).toBe(23000)
    })
  })

  describe('Payment Settlement Journals & Mark Paid', () => {
    it('markInvoicePaid creates balanced settlement journal (Debit Bank, Credit AR) for Sales', async () => {
      const store = useBooksStore.getState()
      // Create unpaid invoice first
      await store.saveInvoice({
        id: 'inv-to-pay',
        type: 'Sales',
        partyName: 'Paying Customer',
        invoiceNumber: 'INV-PAY-01',
        status: 'Unpaid',
        items: [
          {
            id: 'it-1',
            description: 'Engineering Design Work',
            qty: 1,
            rate: 10000,
            taxRate: 15,
            amount: 10000,
            accountId: 'acc-sales',
          },
        ],
      })

      const preState = useBooksStore.getState().data
      const preBank = preState.accounts.find((a) => a.id === 'acc-bank')!.balance
      const preAr = preState.accounts.find((a) => a.id === 'acc-ar')!.balance
      const preJournalsCount = preState.journalEntries.length

      await store.markInvoicePaid('inv-to-pay')

      const postState = useBooksStore.getState().data
      expect(postState.journalEntries.length).toBe(preJournalsCount + 1)
      const settlementJournal = postState.journalEntries[0]
      expect(settlementJournal.totalDebit).toBe(11500)
      expect(settlementJournal.totalCredit).toBe(11500)

      const bankItem = settlementJournal.items.find((i) => i.accountId === 'acc-bank')
      const arItem = settlementJournal.items.find((i) => i.accountId === 'acc-ar')
      expect(bankItem?.debit).toBe(11500)
      expect(arItem?.credit).toBe(11500)

      const postBank = postState.accounts.find((a) => a.id === 'acc-bank')!.balance
      const postAr = postState.accounts.find((a) => a.id === 'acc-ar')!.balance
      expect(postBank).toBe(round2(preBank + 11500))
      expect(postAr).toBe(round2(preAr - 11500))

      const inv = postState.invoices.find((i) => i.id === 'inv-to-pay')
      expect(inv?.status).toBe('Paid')
      expect(inv?.outstandingAmount).toBe(0)
    })

    it('markInvoicePaid creates balanced settlement journal (Debit AP, Credit Bank) for Purchase Bill', async () => {
      const store = useBooksStore.getState()
      await store.saveInvoice({
        id: 'bill-to-pay',
        type: 'Purchase',
        partyName: 'Creditor Supplier',
        invoiceNumber: 'BILL-PAY-01',
        status: 'Unpaid',
        items: [
          {
            id: 'it-1',
            description: 'Site Cement Supplies',
            qty: 1,
            rate: 8000,
            taxRate: 15,
            amount: 8000,
            accountId: 'acc-materials',
          },
        ],
      })

      const preState = useBooksStore.getState().data
      const preBank = preState.accounts.find((a) => a.id === 'acc-bank')!.balance
      const preAp = preState.accounts.find((a) => a.id === 'acc-ap')!.balance

      await store.markInvoicePaid('bill-to-pay')

      const postState = useBooksStore.getState().data
      const postBank = postState.accounts.find((a) => a.id === 'acc-bank')!.balance
      const postAp = postState.accounts.find((a) => a.id === 'acc-ap')!.balance

      expect(postBank).toBe(round2(preBank - 9200))
      expect(postAp).toBe(round2(preAp - 9200))

      const bill = postState.invoices.find((i) => i.id === 'bill-to-pay')
      expect(bill?.status).toBe('Paid')
      expect(bill?.outstandingAmount).toBe(0)
    })

    it('immediate settlement on saveInvoice with status: Paid posts posting and settlement journals', async () => {
      const store = useBooksStore.getState()
      const preJournals = store.data.journalEntries.length

      await store.saveInvoice({
        type: 'Sales',
        partyName: 'Cash Customer',
        invoiceNumber: 'CASH-001',
        status: 'Paid',
        items: [
          {
            id: 'it-1',
            description: 'Walk-in Consulting',
            qty: 1,
            rate: 4000,
            taxRate: 15,
            amount: 4000,
            accountId: 'acc-consult',
          },
        ],
      })

      const postData = useBooksStore.getState().data
      // Created 2 journals: posting journal + settlement journal
      expect(postData.journalEntries.length).toBe(preJournals + 2)

      const [settlementJ, postingJ] = postData.journalEntries.slice(0, 2)
      expect(postingJ.totalDebit).toBe(4600)
      expect(postingJ.totalCredit).toBe(4600)
      expect(settlementJ.totalDebit).toBe(4600)
      expect(settlementJ.totalCredit).toBe(4600)

      const inv = postData.invoices[0]
      expect(inv.status).toBe('Paid')
      expect(inv.outstandingAmount).toBe(0)
    })
  })

  describe('Invoice Deletion Reversals', () => {
    it('deleteInvoice reverses ledger balances and clears party outstanding balance', async () => {
      const store = useBooksStore.getState()
      const baselineAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
      const baselineSales = store.data.accounts.find((a) => a.id === 'acc-sales')!.balance
      const baselineVat = store.data.accounts.find((a) => a.id === 'acc-vat')!.balance

      // Create invoice
      await store.saveInvoice({
        id: 'inv-to-delete',
        type: 'Sales',
        partyName: 'Ephemeral Client',
        invoiceNumber: 'INV-DEL-01',
        status: 'Unpaid',
        items: [
          {
            id: 'it-1',
            description: 'Retainer to be cancelled',
            qty: 1,
            rate: 25000,
            taxRate: 15,
            amount: 25000,
            accountId: 'acc-sales',
          },
        ],
      })

      // Confirm posted
      let intermediate = useBooksStore.getState().data
      expect(intermediate.accounts.find((a) => a.id === 'acc-ar')!.balance).toBe(round2(baselineAr + 28750))

      // Delete invoice
      await store.deleteInvoice('inv-to-delete')

      const finalData = useBooksStore.getState().data
      expect(finalData.invoices.some((i) => i.id === 'inv-to-delete')).toBe(false)
      expect(finalData.accounts.find((a) => a.id === 'acc-ar')!.balance).toBe(baselineAr)
      expect(finalData.accounts.find((a) => a.id === 'acc-sales')!.balance).toBe(baselineSales)
      expect(finalData.accounts.find((a) => a.id === 'acc-vat')!.balance).toBe(baselineVat)

      const party = finalData.parties.find((p) => p.name === 'Ephemeral Client')
      expect(party?.outstandingBalance).toBe(0)
    })

    it('deleteInvoice on draft invoice leaves balances untouched', async () => {
      const store = useBooksStore.getState()
      const initialSnap = JSON.stringify(store.data.accounts)

      await store.saveInvoice({
        id: 'draft-to-delete',
        type: 'Sales',
        partyName: 'Draft Client',
        status: 'Draft',
        items: [{ id: '1', description: 'Item', qty: 1, rate: 5000, taxRate: 15, amount: 5000 }],
      })

      await store.deleteInvoice('draft-to-delete')
      const postSnap = JSON.stringify(useBooksStore.getState().data.accounts)
      expect(postSnap).toBe(initialSnap)
    })
  })
})

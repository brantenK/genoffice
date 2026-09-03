import { create } from 'zustand'
import type {
  BooksData,
  BooksNavigationTab,
  Invoice,
  InvoiceStatus,
  JournalEntry,
  Party,
  ReportType,
} from '../../shared/types'
import { initialBooksData } from './mock/initialData'

interface BooksState {
  activeTab: BooksNavigationTab
  data: BooksData
  activeInvoiceId: string | null
  invoiceStatusFilter: 'All' | InvoiceStatus
  activeReport: ReportType
  printInvoice: Invoice | null
  searchTerm: string

  // Actions
  setActiveTab: (tab: BooksNavigationTab) => void
  setActiveInvoiceId: (id: string | null) => void
  setInvoiceStatusFilter: (status: 'All' | InvoiceStatus) => void
  setActiveReport: (report: ReportType) => void
  setPrintInvoice: (invoice: Invoice | null) => void
  setSearchTerm: (term: string) => void
  loadData: () => Promise<void>
  saveInvoice: (invoice: Partial<Invoice>) => Promise<void>
  markInvoicePaid: (invoiceId: string) => Promise<void>
  deleteInvoice: (invoiceId: string) => Promise<void>
  addParty: (party: Omit<Party, 'id' | 'outstandingBalance'>) => Promise<void>
  addJournalEntry: (entry: Omit<JournalEntry, 'id' | 'posted'>) => Promise<void>
  persist: () => Promise<void>
}

export const useBooksStore = create<BooksState>((set, get) => ({
  activeTab: 'dashboard',
  data: initialBooksData,
  activeInvoiceId: null,
  invoiceStatusFilter: 'All',
  activeReport: 'profit-loss',
  printInvoice: null,
  searchTerm: '',

  setActiveTab: (tab) => set({ activeTab: tab, activeInvoiceId: null }),
  setActiveInvoiceId: (id) => set({ activeInvoiceId: id }),
  setInvoiceStatusFilter: (status) => set({ invoiceStatusFilter: status }),
  setActiveReport: (report) => set({ activeReport: report }),
  setPrintInvoice: (invoice) => set({ printInvoice: invoice }),
  setSearchTerm: (term) => set({ searchTerm: term }),

  loadData: async () => {
    if (window.booksApi?.loadData) {
      try {
        const stored = await window.booksApi.loadData()
        if (stored && stored.accounts && stored.invoices) {
          set({ data: stored })
          return
        }
      } catch (err) {
        console.warn('[books-store] Failed to load data from IPC:', err)
      }
    }
    // Fallback to initial seed
    set({ data: initialBooksData })
  },

  persist: async () => {
    const { data } = get()
    if (window.booksApi?.saveData) {
      try {
        await window.booksApi.saveData(data)
      } catch (err) {
        console.error('[books-store] Failed to save data:', err)
      }
    }
  },

  saveInvoice: async (partial) => {
    const { data, persist } = get()
    const now = new Date().toISOString()
    const items = partial.items || []

    const subtotal = items.reduce((sum, it) => sum + (it.qty * it.rate), 0)
    const taxTotal = items.reduce((sum, it) => sum + (it.qty * it.rate * (it.taxRate / 100)), 0)
    const grandTotal = subtotal + taxTotal
    const outstanding = partial.status === 'Paid' ? 0 : grandTotal

    let nextInvoices = [...data.invoices]
    let targetInvoice: Invoice

    if (partial.id) {
      // Update
      targetInvoice = {
        ...(data.invoices.find((i) => i.id === partial.id)!),
        ...partial,
        subtotal,
        taxTotal,
        grandTotal,
        outstandingAmount: outstanding,
        updatedAt: now,
      } as Invoice
      nextInvoices = nextInvoices.map((inv) => (inv.id === partial.id ? targetInvoice : inv))
    } else {
      // Create new
      const prefix = partial.type === 'Purchase' ? 'BILL' : 'INV'
      const year = new Date().getFullYear()
      const count = nextInvoices.filter((i) => i.type === (partial.type || 'Sales')).length + 1
      const invoiceNumber = `${prefix}-${year}-${String(count).padStart(3, '0')}`

      targetInvoice = {
        id: `inv-${Date.now()}`,
        invoiceNumber,
        type: partial.type || 'Sales',
        partyId: partial.partyId || '',
        partyName: partial.partyName || 'Customer',
        date: partial.date || new Date().toISOString().split('T')[0],
        dueDate: partial.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
        items,
        subtotal,
        taxTotal,
        grandTotal,
        outstandingAmount: outstanding,
        status: partial.status || 'Unpaid',
        notes: partial.notes || 'Payment due within 30 days.',
        tenderReference: partial.tenderReference,
        crmDealId: partial.crmDealId,
        createdAt: now,
        updatedAt: now,
      }
      nextInvoices.unshift(targetInvoice)
    }

    // Update party outstanding balance correctly with diff
    const prevInvoice = partial.id ? data.invoices.find((i) => i.id === partial.id) : null
    const prevOutstanding = prevInvoice ? prevInvoice.outstandingAmount : 0
    const balanceDiff = targetInvoice.outstandingAmount - prevOutstanding

    const nextParties = data.parties.map((p) => {
      if (p.id === targetInvoice.partyId) {
        return { ...p, outstandingBalance: Math.max(0, p.outstandingBalance + balanceDiff) }
      }
      return p
    })

    // Auto-update double-entry accounts for new invoices
    let nextAccounts = [...data.accounts]
    let nextJournals = [...data.journalEntries]

    if (!partial.id && targetInvoice.status !== 'Draft') {
      if (targetInvoice.type === 'Sales') {
        nextAccounts = nextAccounts.map((acc) => {
          if (acc.id === 'acc-ar') return { ...acc, balance: acc.balance + targetInvoice.grandTotal }
          if (acc.id === 'acc-vat') return { ...acc, balance: acc.balance + targetInvoice.taxTotal }
          if (acc.id === 'acc-sales') return { ...acc, balance: acc.balance + targetInvoice.subtotal }
          return acc
        })
        // Record Journal Entry
        nextJournals.unshift({
          id: `je-${Date.now()}`,
          entryNumber: `JE-${new Date().getFullYear()}-${String(nextJournals.length + 1).padStart(3, '0')}`,
          date: targetInvoice.date,
          items: [
            {
              id: `je-i-1`,
              accountId: 'acc-ar',
              accountName: 'Accounts Receivable (Debtors)',
              partyId: targetInvoice.partyId,
              partyName: targetInvoice.partyName,
              debit: targetInvoice.grandTotal,
              credit: 0,
              remark: `Invoice ${targetInvoice.invoiceNumber}`,
            },
            {
              id: `je-i-2`,
              accountId: 'acc-sales',
              accountName: 'Tender & Commercial Contracting Sales',
              debit: 0,
              credit: targetInvoice.subtotal,
              remark: `Sales Revenue`,
            },
            ...(targetInvoice.taxTotal > 0
              ? [
                  {
                    id: `je-i-3`,
                    accountId: 'acc-vat',
                    accountName: 'SARS VAT Output Payable',
                    debit: 0,
                    credit: targetInvoice.taxTotal,
                    remark: `15% VAT Output`,
                  },
                ]
              : []),
          ],
          totalDebit: targetInvoice.grandTotal,
          totalCredit: targetInvoice.grandTotal,
          remarks: `System invoice posting for ${targetInvoice.invoiceNumber}`,
          posted: true,
        })
      } else {
        // Purchase Bill
        nextAccounts = nextAccounts.map((acc) => {
          if (acc.id === 'acc-ap') return { ...acc, balance: acc.balance + targetInvoice.grandTotal }
          if (acc.id === 'acc-materials') return { ...acc, balance: acc.balance + targetInvoice.subtotal }
          return acc
        })
      }
    }

    set({
      data: {
        ...data,
        invoices: nextInvoices,
        parties: nextParties,
        accounts: nextAccounts,
        journalEntries: nextJournals,
      },
      activeInvoiceId: null,
    })

    await persist()
  },

  markInvoicePaid: async (invoiceId) => {
    const { data, persist } = get()
    const target = data.invoices.find((i) => i.id === invoiceId)
    if (!target) return

    const prevOutstanding = target.outstandingAmount

    const nextInvoices = data.invoices.map((inv) =>
      inv.id === invoiceId ? { ...inv, status: 'Paid' as InvoiceStatus, outstandingAmount: 0 } : inv,
    )

    const nextParties = data.parties.map((p) => {
      if (p.id === target.partyId) {
        return { ...p, outstandingBalance: Math.max(0, p.outstandingBalance - prevOutstanding) }
      }
      return p
    })

    // Auto-record double-entry payment in Bank
    const nextAccounts = data.accounts.map((acc) => {
      if (acc.id === 'acc-bank') {
        const adjustment = target.type === 'Sales' ? target.grandTotal : -target.grandTotal
        return { ...acc, balance: acc.balance + adjustment }
      }
      if (acc.id === 'acc-ar' && target.type === 'Sales') {
        return { ...acc, balance: Math.max(0, acc.balance - target.grandTotal) }
      }
      if (acc.id === 'acc-ap' && target.type === 'Purchase') {
        return { ...acc, balance: Math.max(0, acc.balance - target.grandTotal) }
      }
      return acc
    })

    set({
      data: {
        ...data,
        invoices: nextInvoices,
        parties: nextParties,
        accounts: nextAccounts,
      },
    })

    await persist()
  },

  deleteInvoice: async (invoiceId) => {
    const { data, persist } = get()
    const target = data.invoices.find((i) => i.id === invoiceId)
    if (!target) return

    const nextInvoices = data.invoices.filter((i) => i.id !== invoiceId)
    const nextParties = data.parties.map((p) => {
      if (p.id === target.partyId) {
        return { ...p, outstandingBalance: Math.max(0, p.outstandingBalance - target.outstandingAmount) }
      }
      return p
    })

    set({
      data: {
        ...data,
        invoices: nextInvoices,
        parties: nextParties,
      },
      activeInvoiceId: null,
    })

    await persist()
  },

  addParty: async (party) => {
    const { data, persist } = get()
    const newParty: Party = {
      ...party,
      id: `party-${Date.now()}`,
      outstandingBalance: 0,
    }
    set({
      data: {
        ...data,
        parties: [...data.parties, newParty],
      },
    })
    await persist()
  },

  addJournalEntry: async (entry) => {
    const { data, persist } = get()
    const count = data.journalEntries.length + 1
    const entryNumber = `JE-${new Date().getFullYear()}-${String(count).padStart(3, '0')}`
    const newEntry: JournalEntry = {
      ...entry,
      id: `je-${Date.now()}`,
      entryNumber,
      posted: true,
    }

    // Apply debit/credit to accounts
    const nextAccounts = [...data.accounts]
    for (const item of entry.items) {
      const idx = nextAccounts.findIndex((a) => a.id === item.accountId)
      if (idx !== -1) {
        const acc = nextAccounts[idx]
        const isAssetOrExpense = acc.rootType === 'Asset' || acc.rootType === 'Expense'
        const netChange = isAssetOrExpense ? item.debit - item.credit : item.credit - item.debit
        nextAccounts[idx] = { ...acc, balance: acc.balance + netChange }
      }
    }

    set({
      data: {
        ...data,
        journalEntries: [newEntry, ...data.journalEntries],
        accounts: nextAccounts,
      },
    })

    await persist()
  },
}))

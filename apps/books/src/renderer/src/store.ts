import { create } from 'zustand'
import type {
  BankTransaction,
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
  importBankStatementCsv: (csvContent: string) => Promise<any>
  reconcileTransaction: (transactionId: string, invoiceId: string) => Promise<any>
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

  importBankStatementCsv: async (csvContent: string) => {
    if (window.booksApi?.importBankStatementCsv) {
      const res = await window.booksApi.importBankStatementCsv(csvContent)
      if (res.ok) {
        await get().loadData()
      }
      return res
    }

    // Local in-memory fallback
    const { data, persist } = get()
    const lines = csvContent.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    if (lines.length < 2) {
      return { ok: false, error: 'No valid transactions found in statement CSV' }
    }
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/['"]/g, ''))
    const dateIdx = headers.findIndex((h) => h.includes('date'))
    const descIdx = headers.findIndex((h) => h.includes('desc') || h.includes('details') || h.includes('narrative'))
    const refIdx = headers.findIndex((h) => h.includes('ref'))
    const amountIdx = headers.findIndex((h) => h === 'amount' || h === 'value')
    const debitIdx = headers.findIndex((h) => h.includes('debit'))
    const creditIdx = headers.findIndex((h) => h.includes('credit'))

    const parsed: BankTransaction[] = []
    for (let i = 1; i < lines.length; i++) {
      const cols: string[] = []
      let curr = ''
      let inQuote = false
      for (let c = 0; c < lines[i].length; c++) {
        const char = lines[i][c]
        if (char === '"') inQuote = !inQuote
        else if (char === ',' && !inQuote) { cols.push(curr.trim()); curr = '' }
        else curr += char
      }
      cols.push(curr.trim())
      if (cols.length === 0 || !cols.some((c) => c.length > 0)) continue

      const date = dateIdx >= 0 && cols[dateIdx] ? cols[dateIdx] : new Date().toISOString().split('T')[0]
      const description = descIdx >= 0 && cols[descIdx] ? cols[descIdx] : 'Bank Transaction'
      const reference = refIdx >= 0 && cols[refIdx] ? cols[refIdx] : ''
      let amount = 0
      if (amountIdx >= 0 && cols[amountIdx]) {
        let clean = cols[amountIdx].replace(/[R$\s]/g, '').replace(/,/g, '')
        if (clean.startsWith('(') && clean.endsWith(')')) clean = '-' + clean.slice(1, -1)
        amount = parseFloat(clean) || 0
      } else if (debitIdx >= 0 || creditIdx >= 0) {
        const deb = parseFloat(debitIdx >= 0 && cols[debitIdx] ? cols[debitIdx].replace(/[R$\s]/g, '').replace(/,/g, '') : '0') || 0
        const cred = parseFloat(creditIdx >= 0 && cols[creditIdx] ? cols[creditIdx].replace(/[R$\s]/g, '').replace(/,/g, '') : '0') || 0
        amount = cred > 0 ? cred : -deb
      }
      if (isNaN(amount) || amount === 0) continue
      parsed.push({
        id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        accountId: 'acc-bank',
        date,
        description,
        reference,
        amount: Math.round(amount * 100) / 100,
        reconciled: false,
      })
    }

    if (parsed.length === 0) {
      return { ok: false, error: 'No valid transactions found in statement CSV' }
    }

    const existing = data.bankTransactions || []
    const existingFps = new Set(existing.map((t) => `${t.date}|${t.description}|${t.amount}`))
    const toAdd: BankTransaction[] = []
    let netAdjustment = 0

    for (const tx of parsed) {
      const fp = `${tx.date}|${tx.description}|${tx.amount}`
      if (!existingFps.has(fp)) {
        toAdd.push(tx)
        netAdjustment += tx.amount
        existingFps.add(fp)
      }
    }

    const nextAccounts = data.accounts.map((a) => {
      if (a.id === 'acc-bank') {
        return { ...a, balance: Math.round((a.balance + netAdjustment) * 100) / 100 }
      }
      return a
    })
    const bankAccount = nextAccounts.find((a) => a.id === 'acc-bank')

    set({
      data: {
        ...data,
        bankTransactions: [...existing, ...toAdd],
        accounts: nextAccounts,
      },
    })
    await persist()

    return {
      ok: true,
      importedCount: toAdd.length,
      skippedDuplicates: parsed.length - toAdd.length,
      netAdjustment: Math.round(netAdjustment * 100) / 100,
      newBankBalance: bankAccount ? bankAccount.balance : null,
      transactions: toAdd,
    }
  },

  reconcileTransaction: async (transactionId: string, invoiceId: string) => {
    if (window.booksApi?.reconcileTransaction) {
      const res = await window.booksApi.reconcileTransaction(transactionId, invoiceId)
      if (res.ok) {
        await get().loadData()
      }
      return res
    }

    // Local in-memory fallback
    const { data, persist } = get()
    const tx = (data.bankTransactions || []).find((t) => t.id === transactionId)
    if (!tx) return { ok: false, error: `Transaction not found: ${transactionId}` }
    if (tx.reconciled) return { ok: false, error: `Transaction already reconciled: ${transactionId}` }

    const inv = (data.invoices || []).find((i) => i.id === invoiceId)
    if (!inv) return { ok: false, error: `Invoice not found: ${invoiceId}` }
    if (inv.status === 'Paid') return { ok: false, error: `Invoice already marked Paid: ${invoiceId}` }

    const settledAmount = inv.outstandingAmount

    const nextBankTransactions = (data.bankTransactions || []).map((t) =>
      t.id === transactionId
        ? { ...t, reconciled: true, matchedInvoiceId: inv.id, reconciledAt: new Date().toISOString() }
        : t
    )

    const nextInvoices = data.invoices.map((i) =>
      i.id === invoiceId
        ? { ...i, status: 'Paid' as InvoiceStatus, outstandingAmount: 0, updatedAt: new Date().toISOString() }
        : i
    )

    const party = data.parties.find((p) => p.id === inv.partyId || p.name === inv.partyName)
    const nextParties = data.parties.map((p) => {
      if (party && p.id === party.id) {
        return { ...p, outstandingBalance: Math.max(0, Math.round((p.outstandingBalance - settledAmount) * 100) / 100) }
      }
      return p
    })

    const nextAccounts = data.accounts.map((acc) => {
      if (inv.type === 'Sales' && acc.id === 'acc-ar') {
        return { ...acc, balance: Math.max(0, Math.round((acc.balance - settledAmount) * 100) / 100) }
      }
      if (inv.type === 'Purchase' && acc.id === 'acc-ap') {
        return { ...acc, balance: Math.max(0, Math.round((acc.balance - settledAmount) * 100) / 100) }
      }
      return acc
    })

    const jeNumber = `JE-${new Date().getFullYear()}-${String(data.journalEntries.length + 1).padStart(3, '0')}`
    const today = new Date().toISOString().split('T')[0]
    const journalItems =
      inv.type === 'Sales'
        ? [
            { id: `jei-rec-1`, accountId: 'acc-bank', accountName: 'FNB Business Cheque Account', debit: settledAmount, credit: 0 },
            { id: `jei-rec-2`, accountId: 'acc-ar', accountName: 'Accounts Receivable (Debtors)', debit: 0, credit: settledAmount, partyId: party?.id, partyName: party?.name },
          ]
        : [
            { id: `jei-rec-1`, accountId: 'acc-ap', accountName: 'Accounts Payable (Creditors)', debit: settledAmount, credit: 0, partyId: party?.id, partyName: party?.name },
            { id: `jei-rec-2`, accountId: 'acc-bank', accountName: 'FNB Business Cheque Account', debit: 0, credit: settledAmount },
          ]

    const newJournalEntry: JournalEntry = {
      id: `je-${Date.now()}`,
      entryNumber: jeNumber,
      date: today,
      totalDebit: settledAmount,
      totalCredit: settledAmount,
      remarks: `1-Click Bank Reconciliation: Transaction ${tx.description} for Invoice ${inv.invoiceNumber}`,
      posted: true,
      items: journalItems,
    }

    set({
      data: {
        ...data,
        bankTransactions: nextBankTransactions,
        invoices: nextInvoices,
        parties: nextParties,
        accounts: nextAccounts,
        journalEntries: [newJournalEntry, ...data.journalEntries],
      },
    })

    await persist()
    return { ok: true }
  },
}))


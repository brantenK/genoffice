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
import {
  round2,
  calculateInvoiceTotals,
  createSalesInvoiceJournal,
  createPurchaseBillJournal,
  createSettlementJournal,
  recomputePartyBalances,
  parseBankStatementCsv,
  deduplicateBankTransactions,
} from '../../shared/accounting'

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
  syncFromMain: (incomingData: BooksData) => void
  persist: () => Promise<void>
}

let lastSavedHash = ''

export function computeDataHash(data: BooksData): string {
  try {
    return JSON.stringify({
      version: data.version,
      settings: data.settings,
      accounts: data.accounts,
      parties: data.parties,
      invoices: data.invoices,
      journalEntries: data.journalEntries,
      bankTransactions: data.bankTransactions,
    })
  } catch {
    return String(data)
  }
}

export function getLastSavedHash(): string {
  return lastSavedHash
}

export function setLastSavedHash(hash: string): void {
  lastSavedHash = hash
}

function getBooksApi() {
  return typeof window !== 'undefined' ? window.booksApi : undefined
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
    const api = getBooksApi()
    if (api?.loadData) {
      try {
        const stored = await api.loadData()
        if (stored && stored.accounts && stored.invoices) {
          lastSavedHash = computeDataHash(stored)
          set({ data: stored })
          return
        }
      } catch (err) {
        console.warn('[books-store] Failed to load data from IPC:', err)
      }
    }
    // Fallback to initial seed
    lastSavedHash = computeDataHash(initialBooksData)
    set({ data: initialBooksData })
  },

  syncFromMain: (incomingData: BooksData) => {
    if (!incomingData) return
    const incomingHash = computeDataHash(incomingData)
    if (incomingHash === lastSavedHash) {
      // Layer 2 loop suppression: incoming payload matches last saved data
      return
    }
    lastSavedHash = incomingHash

    const accounts = Array.isArray(incomingData.accounts) ? incomingData.accounts : []
    const invoices = Array.isArray(incomingData.invoices) ? incomingData.invoices : []
    const parties = Array.isArray(incomingData.parties)
      ? recomputePartyBalances(invoices, incomingData.parties)
      : []
    const journalEntries = Array.isArray(incomingData.journalEntries)
      ? incomingData.journalEntries
      : []
    const bankTransactions = Array.isArray(incomingData.bankTransactions)
      ? incomingData.bankTransactions
      : []
    const settings = incomingData.settings || get().data.settings

    const nextData: BooksData = {
      ...incomingData,
      settings,
      accounts,
      parties,
      invoices,
      journalEntries,
      bankTransactions,
    }

    set({ data: nextData })
    // CRITICAL: Do NOT call persist() here to avoid loop!
  },

  persist: async () => {
    const { data } = get()
    lastSavedHash = computeDataHash(data)
    const api = getBooksApi()
    if (api?.saveData) {
      try {
        await api.saveData(data)
      } catch (err) {
        console.error('[books-store] Failed to save data:', err)
      }
    }
  },

  saveInvoice: async (partial) => {
    const { data, persist } = get()
    const now = new Date().toISOString()
    const oldInvoice = partial.id ? data.invoices.find((i) => i.id === partial.id) : undefined
    const isEdit = !!oldInvoice

    const rawItems = partial.items || oldInvoice?.items || []
    const items = rawItems.map((it, idx) => {
      let lineAmt = 0
      if (it.qty != null && it.rate != null && !isNaN(Number(it.qty)) && !isNaN(Number(it.rate))) {
        lineAmt = round2(Number(it.qty) * Number(it.rate))
      } else if (it.amount != null && !isNaN(Number(it.amount))) {
        lineAmt = round2(Number(it.amount))
      }
      return {
        ...it,
        id: it.id || `item-${Date.now()}-${idx}`,
        qty: Number(it.qty) || 0,
        rate: Number(it.rate) || 0,
        taxRate: it.taxRate !== undefined ? Number(it.taxRate) : 15,
        amount: lineAmt,
      }
    })

    const totals = calculateInvoiceTotals(items)
    const status: InvoiceStatus = partial.status || oldInvoice?.status || 'Unpaid'

    let outstandingAmount: number
    if (!isEdit) {
      outstandingAmount = status === 'Paid' ? 0 : totals.grandTotal
    } else {
      if (status === 'Paid') {
        outstandingAmount = 0
      } else if (oldInvoice.status === 'Draft' && status !== 'Draft') {
        outstandingAmount = totals.grandTotal
      } else if (partial.outstandingAmount !== undefined) {
        outstandingAmount = round2(partial.outstandingAmount)
      } else if (oldInvoice.outstandingAmount === oldInvoice.grandTotal) {
        outstandingAmount = totals.grandTotal
      } else {
        const paidSoFar = round2(oldInvoice.grandTotal - oldInvoice.outstandingAmount)
        outstandingAmount = Math.max(0, round2(totals.grandTotal - paidSoFar))
      }
    }

    const type = partial.type || oldInvoice?.type || 'Sales'

    const targetInvoice: Invoice = {
      id: partial.id || `inv-${Date.now()}`,
      invoiceNumber:
        partial.invoiceNumber ||
        oldInvoice?.invoiceNumber ||
        (() => {
          const prefix = type === 'Purchase' ? 'BILL' : 'INV'
          const year = new Date().getFullYear()
          const count = data.invoices.filter((i) => i.type === type).length + 1
          return `${prefix}-${year}-${String(count).padStart(3, '0')}`
        })(),
      type,
      partyId: partial.partyId || oldInvoice?.partyId || '',
      partyName:
        partial.partyName || oldInvoice?.partyName || (type === 'Sales' ? 'Customer' : 'Supplier'),
      date: partial.date || oldInvoice?.date || now.split('T')[0],
      dueDate:
        partial.dueDate ||
        oldInvoice?.dueDate ||
        new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
      items,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      outstandingAmount,
      status,
      notes:
        partial.notes !== undefined
          ? partial.notes
          : oldInvoice?.notes || 'Payment due within 30 days.',
      tenderReference:
        partial.tenderReference !== undefined
          ? partial.tenderReference
          : oldInvoice?.tenderReference,
      crmDealId: partial.crmDealId !== undefined ? partial.crmDealId : oldInvoice?.crmDealId,
      createdAt: oldInvoice ? oldInvoice.createdAt : now,
      updatedAt: now,
    }

    // Determine if this save is a posting event (F7)
    const isPosting =
      (!oldInvoice && targetInvoice.status !== 'Draft') ||
      (oldInvoice && oldInvoice.status === 'Draft' && targetInvoice.status !== 'Draft')

    const nextAccounts = data.accounts.map((a) => ({ ...a }))
    const nextJournals = [...data.journalEntries]

    // Resolve or auto-create party
    const partiesPool = [...data.parties]
    let resolvedParty =
      partiesPool.find((p) => p.id === targetInvoice.partyId) ||
      partiesPool.find((p) => p.name.toLowerCase() === targetInvoice.partyName.toLowerCase())

    if (!resolvedParty && targetInvoice.partyName) {
      const newPartyId = targetInvoice.partyId || `party-${Date.now()}`
      resolvedParty = {
        id: newPartyId,
        name: targetInvoice.partyName,
        type: targetInvoice.type === 'Sales' ? 'Customer' : 'Supplier',
        outstandingBalance: 0,
      }
      partiesPool.push(resolvedParty)
      targetInvoice.partyId = newPartyId
    } else if (resolvedParty && !targetInvoice.partyId) {
      targetInvoice.partyId = resolvedParty.id
    }

    if (isPosting) {
      if (targetInvoice.type === 'Sales') {
        // Sales Invoice posting (F5): Debit AR, Credit Sales Revenue, Credit VAT Output
        const journal = createSalesInvoiceJournal(targetInvoice, nextAccounts, resolvedParty)
        nextJournals.unshift(journal)

        // Increment AR
        const arAcc = nextAccounts.find((a) => a.id === 'acc-ar')
        if (arAcc) {
          arAcc.balance = round2(arAcc.balance + targetInvoice.grandTotal)
        }

        // Increment Revenue accounts for line items
        const incomeGroups = new Map<string, number>()
        for (const it of targetInvoice.items) {
          const accId = it.accountId || 'acc-sales'
          incomeGroups.set(accId, round2((incomeGroups.get(accId) || 0) + it.amount))
        }
        if (incomeGroups.size === 0) {
          incomeGroups.set('acc-sales', targetInvoice.subtotal)
        } else {
          const entries = Array.from(incomeGroups.entries())
          const sumAmt = entries.reduce((s, [, amt]) => round2(s + amt), 0)
          const diff = round2(targetInvoice.subtotal - sumAmt)
          if (diff !== 0 && entries.length > 0) {
            incomeGroups.set(
              entries[entries.length - 1][0],
              round2(incomeGroups.get(entries[entries.length - 1][0])! + diff),
            )
          }
        }
        for (const [accId, amt] of incomeGroups.entries()) {
          const acc = nextAccounts.find((a) => a.id === accId)
          if (acc) {
            acc.balance = round2(acc.balance + amt)
          }
        }

        // Increment VAT Output
        if (targetInvoice.taxTotal !== 0) {
          const vatAcc = nextAccounts.find((a) => a.id === 'acc-vat' || a.id === 'acc-vat-out')
          if (vatAcc) {
            vatAcc.balance = round2(vatAcc.balance + targetInvoice.taxTotal)
          }
        }
      } else {
        // Purchase Bill posting (F6): Debit Expense, Debit VAT Input, Credit AP
        const journal = createPurchaseBillJournal(targetInvoice, nextAccounts, resolvedParty)
        nextJournals.unshift(journal)

        // Increment AP
        const apAcc = nextAccounts.find((a) => a.id === 'acc-ap')
        if (apAcc) {
          apAcc.balance = round2(apAcc.balance + targetInvoice.grandTotal)
        }

        // Increment Expense accounts for line items
        const expenseGroups = new Map<string, number>()
        for (const it of targetInvoice.items) {
          const accId = it.accountId || 'acc-materials'
          expenseGroups.set(accId, round2((expenseGroups.get(accId) || 0) + it.amount))
        }
        if (expenseGroups.size === 0) {
          expenseGroups.set('acc-materials', targetInvoice.subtotal)
        } else {
          const entries = Array.from(expenseGroups.entries())
          const sumAmt = entries.reduce((s, [, amt]) => round2(s + amt), 0)
          const diff = round2(targetInvoice.subtotal - sumAmt)
          if (diff !== 0 && entries.length > 0) {
            expenseGroups.set(
              entries[entries.length - 1][0],
              round2(expenseGroups.get(entries[entries.length - 1][0])! + diff),
            )
          }
        }
        for (const [accId, amt] of expenseGroups.entries()) {
          const acc = nextAccounts.find((a) => a.id === accId)
          if (acc) {
            acc.balance = round2(acc.balance + amt)
          }
        }

        // Increment VAT Input
        if (targetInvoice.taxTotal > 0) {
          const vatInAcc =
            nextAccounts.find((a) => a.id === 'acc-vat-in') ||
            nextAccounts.find((a) => a.id === 'acc-vat')
          if (vatInAcc) {
            vatInAcc.balance = round2(vatInAcc.balance + targetInvoice.taxTotal)
          }
        }
      }

      // Immediate settlement if created as 'Paid'
      if (targetInvoice.status === 'Paid') {
        const settlementJournal = createSettlementJournal(
          targetInvoice,
          nextAccounts,
          targetInvoice.grandTotal,
          resolvedParty,
        )
        nextJournals.unshift(settlementJournal)

        if (targetInvoice.type === 'Sales') {
          const bankAcc = nextAccounts.find((a) => a.id === 'acc-bank')
          if (bankAcc) bankAcc.balance = round2(bankAcc.balance + targetInvoice.grandTotal)
          const arAcc = nextAccounts.find((a) => a.id === 'acc-ar')
          if (arAcc) arAcc.balance = Math.max(0, round2(arAcc.balance - targetInvoice.grandTotal))
        } else {
          const apAcc = nextAccounts.find((a) => a.id === 'acc-ap')
          if (apAcc) apAcc.balance = Math.max(0, round2(apAcc.balance - targetInvoice.grandTotal))
          const bankAcc = nextAccounts.find((a) => a.id === 'acc-bank')
          if (bankAcc) bankAcc.balance = round2(bankAcc.balance - targetInvoice.grandTotal)
        }
      }
    }

    const nextInvoices = oldInvoice
      ? data.invoices.map((inv) => (inv.id === targetInvoice.id ? targetInvoice : inv))
      : [targetInvoice, ...data.invoices]

    // Enforce Party Balance Invariant (F9)
    const nextParties = recomputePartyBalances(nextInvoices, partiesPool)

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
    const inv = data.invoices.find((i) => i.id === invoiceId)
    if (!inv) return
    if (inv.status === 'Paid') return

    const settlementAmount = round2(
      inv.outstandingAmount > 0 ? inv.outstandingAmount : inv.grandTotal,
    )
    const party =
      data.parties.find((p) => p.id === inv.partyId) ||
      data.parties.find((p) => p.name.toLowerCase() === inv.partyName.toLowerCase())

    const nextAccounts = data.accounts.map((a) => ({ ...a }))
    const nextJournals = [...data.journalEntries]

    if (settlementAmount > 0) {
      // Generate settlement journal (F8)
      const settlementJournal = createSettlementJournal(inv, nextAccounts, settlementAmount, party)
      nextJournals.unshift(settlementJournal)

      // Update ledger balances
      if (inv.type === 'Sales') {
        const bankAcc = nextAccounts.find((a) => a.id === 'acc-bank')
        if (bankAcc) bankAcc.balance = round2(bankAcc.balance + settlementAmount)
        const arAcc = nextAccounts.find((a) => a.id === 'acc-ar')
        if (arAcc) arAcc.balance = Math.max(0, round2(arAcc.balance - settlementAmount))
      } else {
        const apAcc = nextAccounts.find((a) => a.id === 'acc-ap')
        if (apAcc) apAcc.balance = Math.max(0, round2(apAcc.balance - settlementAmount))
        const bankAcc = nextAccounts.find((a) => a.id === 'acc-bank')
        if (bankAcc) bankAcc.balance = round2(bankAcc.balance - settlementAmount)
      }
    }

    const nextInvoices = data.invoices.map((i) =>
      i.id === invoiceId
        ? {
            ...i,
            status: 'Paid' as InvoiceStatus,
            outstandingAmount: 0,
            updatedAt: new Date().toISOString(),
          }
        : i,
    )

    // Recompute party balances (F9)
    const nextParties = recomputePartyBalances(nextInvoices, data.parties)

    set({
      data: {
        ...data,
        invoices: nextInvoices,
        parties: nextParties,
        accounts: nextAccounts,
        journalEntries: nextJournals,
      },
    })

    await persist()
  },

  deleteInvoice: async (invoiceId) => {
    const { data, persist } = get()
    const target = data.invoices.find((i) => i.id === invoiceId)
    if (!target) return

    const nextAccounts = data.accounts.map((a) => ({ ...a }))
    let nextJournals = [...data.journalEntries]

    if (target.status !== 'Draft') {
      if (target.type === 'Sales') {
        const arReduction =
          target.status === 'Paid'
            ? 0
            : target.outstandingAmount > 0
              ? target.outstandingAmount
              : target.grandTotal
        const bankReduction = round2(target.grandTotal - arReduction)

        if (arReduction > 0) {
          const arAcc = nextAccounts.find((a) => a.id === 'acc-ar')
          if (arAcc) arAcc.balance = Math.max(0, round2(arAcc.balance - arReduction))
        }
        if (bankReduction > 0) {
          const bankAcc = nextAccounts.find((a) => a.id === 'acc-bank')
          if (bankAcc) bankAcc.balance = round2(bankAcc.balance - bankReduction)
        }

        const incomeGroups = new Map<string, number>()
        for (const it of target.items || []) {
          const accId = it.accountId || 'acc-sales'
          incomeGroups.set(accId, round2((incomeGroups.get(accId) || 0) + it.amount))
        }
        if (incomeGroups.size === 0) {
          incomeGroups.set('acc-sales', target.subtotal)
        } else {
          const entries = Array.from(incomeGroups.entries())
          const sumAmt = entries.reduce((s, [, amt]) => round2(s + amt), 0)
          const diff = round2(target.subtotal - sumAmt)
          if (diff !== 0 && entries.length > 0) {
            incomeGroups.set(
              entries[entries.length - 1][0],
              round2(incomeGroups.get(entries[entries.length - 1][0])! + diff),
            )
          }
        }
        for (const [accId, amt] of incomeGroups.entries()) {
          const acc = nextAccounts.find((a) => a.id === accId)
          if (acc) acc.balance = Math.max(0, round2(acc.balance - amt))
        }

        if (target.taxTotal !== 0) {
          const vatAcc = nextAccounts.find((a) => a.id === 'acc-vat' || a.id === 'acc-vat-out')
          if (vatAcc) vatAcc.balance = Math.max(0, round2(vatAcc.balance - target.taxTotal))
        }
      } else {
        const apReduction =
          target.status === 'Paid'
            ? 0
            : target.outstandingAmount > 0
              ? target.outstandingAmount
              : target.grandTotal
        const bankAddition = round2(target.grandTotal - apReduction)

        if (apReduction > 0) {
          const apAcc = nextAccounts.find((a) => a.id === 'acc-ap')
          if (apAcc) apAcc.balance = Math.max(0, round2(apAcc.balance - apReduction))
        }
        if (bankAddition > 0) {
          const bankAcc = nextAccounts.find((a) => a.id === 'acc-bank')
          if (bankAcc) bankAcc.balance = round2(bankAcc.balance + bankAddition)
        }

        const expenseGroups = new Map<string, number>()
        for (const it of target.items || []) {
          const accId = it.accountId || 'acc-materials'
          expenseGroups.set(accId, round2((expenseGroups.get(accId) || 0) + it.amount))
        }
        if (expenseGroups.size === 0) {
          expenseGroups.set('acc-materials', target.subtotal)
        } else {
          const entries = Array.from(expenseGroups.entries())
          const sumAmt = entries.reduce((s, [, amt]) => round2(s + amt), 0)
          const diff = round2(target.subtotal - sumAmt)
          if (diff !== 0 && entries.length > 0) {
            expenseGroups.set(
              entries[entries.length - 1][0],
              round2(expenseGroups.get(entries[entries.length - 1][0])! + diff),
            )
          }
        }
        for (const [accId, amt] of expenseGroups.entries()) {
          const acc = nextAccounts.find((a) => a.id === accId)
          if (acc) acc.balance = Math.max(0, round2(acc.balance - amt))
        }

        if (target.taxTotal !== 0) {
          const vatInAcc =
            nextAccounts.find((a) => a.id === 'acc-vat-in') ||
            nextAccounts.find((a) => a.id === 'acc-vat')
          if (vatInAcc) vatInAcc.balance = Math.max(0, round2(vatInAcc.balance - target.taxTotal))
        }
      }

      nextJournals = nextJournals.filter((je) => {
        const matchesRemarks = je.remarks && je.remarks.includes(target.invoiceNumber)
        const matchesItem = je.items.some(
          (it) => it.remark && it.remark.includes(target.invoiceNumber),
        )
        return !matchesRemarks && !matchesItem
      })
    }

    const nextInvoices = data.invoices.filter((i) => i.id !== invoiceId)
    const nextParties = recomputePartyBalances(nextInvoices, data.parties)

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
        nextAccounts[idx] = { ...acc, balance: round2(acc.balance + netChange) }
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
    const api = getBooksApi()
    if (api?.importBankStatementCsv) {
      const res = await api.importBankStatementCsv(csvContent)
      if (res.ok) {
        await get().loadData()
      }
      return res
    }

    // Local in-memory fallback
    const { data, persist } = get()
    const parsed = parseBankStatementCsv(csvContent)
    if (parsed.length === 0) {
      return { ok: false, error: 'No valid transactions found in statement CSV' }
    }

    const existing = data.bankTransactions || []
    const { toAdd, skippedDuplicates, netAdjustment } = deduplicateBankTransactions(
      parsed,
      existing,
    )

    const nextAccounts = data.accounts.map((a) => {
      if (a.id === 'acc-bank') {
        return { ...a, balance: round2(a.balance + netAdjustment) }
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
      skippedDuplicates,
      netAdjustment,
      newBankBalance: bankAccount ? bankAccount.balance : null,
      transactions: toAdd,
    }
  },

  reconcileTransaction: async (transactionId: string, invoiceId: string) => {
    const api = getBooksApi()
    if (api?.reconcileTransaction) {
      const res = await api.reconcileTransaction(transactionId, invoiceId)
      if (res.ok) {
        await get().loadData()
      }
      return res
    }

    // Local in-memory fallback
    const { data, persist } = get()
    const tx = (data.bankTransactions || []).find((t) => t.id === transactionId)
    if (!tx) return { ok: false, error: `Transaction not found: ${transactionId}` }
    if (tx.reconciled)
      return { ok: false, error: `Transaction already reconciled: ${transactionId}` }

    const inv = (data.invoices || []).find((i) => i.id === invoiceId)
    if (!inv) return { ok: false, error: `Invoice not found: ${invoiceId}` }
    if (
      inv.status === 'Paid' ||
      (inv.outstandingAmount !== undefined && inv.outstandingAmount <= 0)
    ) {
      return { ok: false, error: `Invoice already marked Paid: ${invoiceId}` }
    }
    if (inv.status === 'Draft') {
      return { ok: false, error: `Cannot reconcile a draft invoice: ${invoiceId}` }
    }
    if (inv.status === 'Cancelled') {
      return { ok: false, error: `Cannot reconcile a cancelled invoice: ${invoiceId}` }
    }

    // Direction validation
    if (inv.type === 'Sales' && tx.amount <= 0) {
      return {
        ok: false,
        error: 'Cannot reconcile a debit/withdrawal transaction against a Sales invoice',
      }
    }
    if (inv.type === 'Purchase' && tx.amount >= 0) {
      return {
        ok: false,
        error: 'Cannot reconcile a credit/deposit transaction against a Purchase bill',
      }
    }

    // Settlement math
    const txAmt = round2(Math.abs(tx.amount))
    const currentOutstanding = round2(
      inv.outstandingAmount !== undefined && inv.outstandingAmount > 0
        ? inv.outstandingAmount
        : inv.grandTotal,
    )
    const settledAmount = round2(Math.min(txAmt, currentOutstanding))
    const remainingOutstanding = round2(currentOutstanding - settledAmount)
    const nextStatus = remainingOutstanding <= 0 ? 'Paid' : 'Unpaid'

    const nextBankTransactions = (data.bankTransactions || []).map((t) =>
      t.id === transactionId
        ? {
            ...t,
            reconciled: true,
            matchedInvoiceId: inv.id,
            reconciledAt: new Date().toISOString(),
          }
        : t,
    )

    const nextInvoices = data.invoices.map((i) =>
      i.id === invoiceId
        ? {
            ...i,
            status: nextStatus as InvoiceStatus,
            outstandingAmount: remainingOutstanding,
            updatedAt: new Date().toISOString(),
          }
        : i,
    )

    const party = data.parties.find((p) => p.id === inv.partyId || p.name === inv.partyName)
    const nextParties = recomputePartyBalances(nextInvoices, data.parties)
    const updatedParty = nextParties.find((p) => p.id === inv.partyId || p.name === inv.partyName)

    const nextAccounts = data.accounts.map((acc) => {
      if (inv.type === 'Sales' && acc.id === 'acc-ar') {
        return { ...acc, balance: Math.max(0, round2(acc.balance - settledAmount)) }
      }
      if (inv.type === 'Purchase' && acc.id === 'acc-ap') {
        return { ...acc, balance: Math.max(0, round2(acc.balance - settledAmount)) }
      }
      return acc
    })

    const jeNumber = `JE-${new Date().getFullYear()}-${String(data.journalEntries.length + 1).padStart(3, '0')}`
    const settlementJournal = createSettlementJournal(
      inv,
      nextAccounts,
      settledAmount,
      updatedParty || party,
      jeNumber,
      'acc-bank',
      `1-Click Bank Reconciliation: Transaction ${tx.description} for Invoice ${inv.invoiceNumber}`,
    )

    set({
      data: {
        ...data,
        bankTransactions: nextBankTransactions,
        invoices: nextInvoices,
        parties: nextParties,
        accounts: nextAccounts,
        journalEntries: [settlementJournal, ...data.journalEntries],
      },
    })

    await persist()
    return {
      ok: true,
      transactionId: tx.id,
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      settledAmount,
      remainingOutstanding,
      invoiceStatus: nextStatus,
      partyBalance: updatedParty ? updatedParty.outstandingBalance : party?.outstandingBalance,
    }
  },
}))

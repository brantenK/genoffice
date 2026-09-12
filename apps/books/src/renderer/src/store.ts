import { create } from 'zustand'
import type {
  BooksData,
  BooksNavigationTab,
  CompanySettings,
  Invoice,
  InvoiceItem,
  InvoiceStatus,
  JournalEntry,
  Party,
  PaymentAllocation,
  ReportType,
} from '../../shared/types'
import { EMPTY_ACCOUNTS, DEFAULT_BOOK_SETTINGS } from '../../shared/chart'
import { appendAudit, createAuditEntry } from '../../shared/audit'
import {
  round2,
  calculateInvoiceTotals,
  createSalesInvoiceJournal,
  createPurchaseBillJournal,
  createSettlementJournal,
  createBankImportJournal,
  createReconciliationJournal,
  computeAccountBalances,
  nextInvoiceNumber,
  nextJournalNumber,
  recomputePartyBalances,
  parseBankStatementCsv,
  deduplicateBankTransactions,
} from '../../shared/accounting'
import {
  applyPayment,
  createPaymentJournal,
  dropInvoiceFromPayments,
  linkPaymentToBankTransaction,
  paymentCoverage,
  planImportCoverage,
} from '../../shared/payments'
import { closePeriod, isDateLocked } from '../../shared/closing'
import {
  createCreditNoteJournal,
  validateCreditNote,
  repostPlanForPartialSettlement,
  reversalJournalRemoval,
} from '../../shared/credit-notes'

/** A fresh, empty ledger — shown until the first-run setup wizard saves. */
export const emptyBooksData: BooksData = {
  version: 1,
  updatedAt: new Date().toISOString(),
  settings: { ...DEFAULT_BOOK_SETTINGS },
  accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
  parties: [],
  invoices: [],
  journalEntries: [],
  bankTransactions: [],
}

interface BooksState {
  activeTab: BooksNavigationTab
  data: BooksData
  /** True on first run, when no books-data.json exists yet. */
  needsSetup: boolean
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
  completeSetup: (ledger: BooksData) => Promise<void>
  updateSettings: (patch: Partial<CompanySettings>) => Promise<void>
  closeFinancialYear: (throughDate: string) => Promise<{ ok: boolean; error?: string }>
  saveCreditNote: (input: {
    originalInvoiceId: string
    date?: string
    items?: InvoiceItem[]
    notes?: string
  }) => Promise<{ ok: boolean; creditNote?: Invoice; error?: string }>
  loadData: () => Promise<void>
  saveInvoice: (invoice: Partial<Invoice>) => Promise<void>
  markInvoicePaid: (invoiceId: string) => Promise<void>
  deleteInvoice: (invoiceId: string) => Promise<void>
  addParty: (party: Omit<Party, 'id' | 'outstandingBalance'>) => Promise<void>
  addJournalEntry: (entry: Omit<JournalEntry, 'id' | 'posted'>) => Promise<boolean>
  importBankStatementCsv: (csvContent: string) => Promise<any>
  reconcileTransaction: (transactionId: string, invoiceId: string) => Promise<any>
  recordPayment: (input: {
    partyId: string
    date?: string
    type?: 'received' | 'paid' | 'refund'
    method?: string
    reference?: string
    allocations: PaymentAllocation[]
  }) => Promise<{ ok: boolean; error?: string }>
  deletePayment: (paymentId: string) => Promise<void>
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
      payments: data.payments,
      auditLog: data.auditLog,
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
  data: emptyBooksData,
  needsSetup: false,
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

  completeSetup: async (ledger) => {
    const api = getBooksApi()
    const setupLedger = appendAudit(
      ledger,
      createAuditEntry(
        'setup.complete',
        `Completed first-run setup for ${ledger.settings?.companyName || 'new company'}`,
      ),
    )
    if (!api?.saveData) {
      lastSavedHash = computeDataHash(setupLedger)
      set({ data: setupLedger, needsSetup: false })
      return
    }
    const saved = await api.saveData(setupLedger)
    lastSavedHash = computeDataHash(setupLedger)
    set({ data: setupLedger, needsSetup: !saved })
  },

  updateSettings: async (patch) => {
    const { data, persist } = get()
    const nextSettings = {
      ...data.settings,
      ...patch,
      defaultTaxRate:
        patch.defaultTaxRate !== undefined
          ? round2(Number(patch.defaultTaxRate) || 0)
          : data.settings.defaultTaxRate,
      taxInclusive:
        patch.taxInclusive !== undefined ? Boolean(patch.taxInclusive) : data.settings.taxInclusive,
    }
    set({
      data: appendAudit(
        { ...data, settings: nextSettings, updatedAt: new Date().toISOString() },
        createAuditEntry('settings.update', `Updated settings for ${nextSettings.companyName}`),
      ),
    })
    await persist()
  },

  closeFinancialYear: async (throughDate) => {
    const { data, persist } = get()
    const result = closePeriod(data, throughDate)
    if (!result.ok || !result.data) {
      return { ok: false, error: result.error || 'Unable to close the financial year' }
    }
    set({
      data: appendAudit(
        result.data,
        createAuditEntry(
          'period.close',
          `Closed financial period through ${throughDate} — income and expenses moved to retained earnings`,
        ),
      ),
    })
    await persist()
    return { ok: true }
  },

  loadData: async () => {
    const api = getBooksApi()
    if (api?.loadData) {
      try {
        const stored = await api.loadData()
        if (stored && stored.accounts && stored.invoices) {
          lastSavedHash = computeDataHash(stored)
          set({ data: stored, needsSetup: false })
          return
        }
        // No store on disk yet — first run: show the setup wizard.
        set({ data: emptyBooksData, needsSetup: true })
        return
      } catch (err) {
        console.warn('[books-store] Failed to load data from IPC:', err)
      }
    }
    // No IPC bridge (dev fallback): treat as unconfigured.
    set({ data: emptyBooksData, needsSetup: true })
  },

  syncFromMain: (incomingData: BooksData) => {
    if (!incomingData) return
    const incomingHash = computeDataHash(incomingData)
    if (incomingHash === lastSavedHash) {
      // Layer 2 loop suppression: incoming payload matches last saved data
      return
    }
    lastSavedHash = incomingHash

    // A real ledger arrived (e.g. written by CRM/Tenders while the setup
    // wizard was showing) — the first-run state is over.
    if (Array.isArray(incomingData.accounts) && Array.isArray(incomingData.invoices)) {
      useBooksStore.setState({ needsSetup: false })
    }

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
    const payments = Array.isArray(incomingData.payments) ? incomingData.payments : []
    const auditLog = Array.isArray(incomingData.auditLog) ? incomingData.auditLog : []
    const settings = incomingData.settings || get().data.settings

    const nextData: BooksData = {
      ...incomingData,
      settings,
      accounts,
      parties,
      invoices,
      journalEntries,
      bankTransactions,
      payments,
      auditLog,
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

    // A multi-invoice payment has one balanced journal. Editing only one of
    // its invoices would require splitting/re-posting that payment journal;
    // block the edit until that dedicated allocation editor exists rather than
    // silently deleting the other invoice's settlement from the ledger.
    if (
      oldInvoice &&
      (data.payments || []).some(
        (payment) =>
          payment.allocations.length > 1 &&
          payment.allocations.some((allocation) => allocation.invoiceId === oldInvoice.id),
      )
    ) {
      console.warn(
        `[books-store] Rejected edit of ${oldInvoice.invoiceNumber}: it belongs to a multi-invoice payment`,
      )
      return
    }

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

    const totals = calculateInvoiceTotals(items, {
      taxInclusive: data.settings.taxInclusive,
      discountTotal: partial.discountTotal !== undefined ? Number(partial.discountTotal) : 0,
      roundOff: partial.roundOff !== undefined ? Number(partial.roundOff) : 0,
    })
    let status: InvoiceStatus = partial.status || oldInvoice?.status || 'Unpaid'

    let outstandingAmount: number
    if (!isEdit) {
      outstandingAmount = status === 'Paid' ? 0 : totals.grandTotal
    } else {
      // I5: a paid invoice edited to a larger amount is no longer fully
      // paid — the plan keeps the already-received portion paid and turns
      // the delta back into outstanding, instead of blindly re-settling the
      // whole new total.
      const wasPostedEdit = oldInvoice.status !== 'Draft' && oldInvoice.status !== 'Cancelled'
      if (wasPostedEdit) {
        const plan = repostPlanForPartialSettlement(oldInvoice, {
          ...oldInvoice,
          grandTotal: totals.grandTotal,
          status,
        })
        if (partial.outstandingAmount !== undefined) {
          outstandingAmount = round2(partial.outstandingAmount)
        } else {
          outstandingAmount = plan.newOutstanding
          status = plan.status
        }
      } else if (status === 'Paid') {
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
        nextInvoiceNumber(data.invoices, type, partial.date),
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
      ...(partial.discountTotal !== undefined
        ? { discountTotal: Number(partial.discountTotal) }
        : {}),
      ...(partial.roundOff !== undefined ? { roundOff: Number(partial.roundOff) } : {}),
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

    // Determine if this save is a posting event: every non-draft invoice
    // must be reflected in the ledger. Editing a previously posted invoice
    // reverses its old entries and re-posts with the new line items, so the
    // ledger always agrees with the invoice (never a stale posting).
    const isPosting = targetInvoice.status !== 'Draft'
    const wasPosted =
      oldInvoice && oldInvoice.status !== 'Draft' && oldInvoice.status !== 'Cancelled'

    // Closed-period lock: nothing new may post into a locked period (period
    // close moved income/expense to retained earnings). Editing an invoice
    // whose OLD date is locked also fires: the reversal removes a posting
    // that the close already swept, which would un-close the period.
    const lockedTargetDate = isPosting && isDateLocked(data, targetInvoice.date)
    const lockedOldDate =
      isPosting && wasPosted && oldInvoice ? isDateLocked(data, oldInvoice.date) : false
    if (lockedTargetDate || lockedOldDate) {
      console.warn(
        `[books-store] Rejected posting into closed period: ${targetInvoice.date} (closed through ${data.settings.closedThrough})`,
      )
      return
    }

    // Ledger-first: posting only appends journal entries; account balances
    // are always recomputed from the journals afterwards.
    const nextJournals = [...data.journalEntries]
    let nextPayments = data.payments || []

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
      // Editing a previously posted invoice: reverse its old entries first,
      // then re-post with the new line items.
      if (wasPosted) {
        const oldNumber = oldInvoice.invoiceNumber
        nextJournals.splice(
          0,
          nextJournals.length,
          ...reversalJournalRemoval(oldNumber, nextJournals),
        )

        // C1: the payment journals die with the reversed posting, so the
        // Payment records referencing this invoice must die with them —
        // otherwise deletePayment later reverses a journal that no longer
        // exists and the invoice/ledger/party state silently diverges.
        nextPayments = dropInvoiceFromPayments(data.payments || [], oldInvoice.id, oldNumber)

        // The old settlement journal is removed with the old posting, so the
        // already-paid portion must be re-posted as a settlement — otherwise
        // editing a partially settled invoice would wipe the paid amount from
        // the ledger. This covers BOTH the Unpaid and the Paid-edit case: a
        // paid invoice edited to a larger amount is no longer fully paid, and
        // only the amount actually received may hit Bank (I5).
        const plan = repostPlanForPartialSettlement(oldInvoice, targetInvoice)
        if (plan.paidAmount > 0) {
          nextJournals.unshift(
            createSettlementJournal(
              targetInvoice,
              data.accounts,
              plan.paidAmount,
              resolvedParty,
              nextJournalNumber(nextJournals, targetInvoice.date),
            ),
          )
        }
      }

      const postingJournal =
        targetInvoice.type === 'Sales'
          ? createSalesInvoiceJournal(targetInvoice, data.accounts, resolvedParty)
          : createPurchaseBillJournal(targetInvoice, data.accounts, resolvedParty)
      nextJournals.unshift(postingJournal)

      // Immediate settlement only for invoices created (not edited) as 'Paid'
      // — edited invoices settle exactly the previously-paid portion above.
      if (targetInvoice.status === 'Paid' && !wasPosted) {
        const settlementJournal = createSettlementJournal(
          targetInvoice,
          data.accounts,
          targetInvoice.grandTotal,
          resolvedParty,
        )
        nextJournals.unshift(settlementJournal)
      }
    }

    const nextInvoices = oldInvoice
      ? data.invoices.map((inv) => (inv.id === targetInvoice.id ? targetInvoice : inv))
      : [targetInvoice, ...data.invoices]

    // Ledger-first: derive balances from journals, then enforce the party
    // balance invariant from open invoices.
    const nextAccounts = computeAccountBalances(data.accounts, nextJournals)
    const nextParties = recomputePartyBalances(nextInvoices, partiesPool)

    set({
      data: appendAudit(
        {
          ...data,
          invoices: nextInvoices,
          parties: nextParties,
          accounts: nextAccounts,
          journalEntries: nextJournals,
          payments: nextPayments,
        },
        createAuditEntry(
          'invoice.save',
          `Saved invoice ${targetInvoice.invoiceNumber} (${targetInvoice.status})`,
          { invoiceNumber: targetInvoice.invoiceNumber, amount: round2(targetInvoice.grandTotal) },
        ),
      ),
      activeInvoiceId: null,
    })

    await persist()
  },

  markInvoicePaid: async (invoiceId) => {
    const { data } = get()
    const inv = data.invoices.find((i) => i.id === invoiceId)
    if (!inv || inv.status === 'Paid') return
    const settlementAmount = round2(
      inv.outstandingAmount > 0 ? inv.outstandingAmount : inv.grandTotal,
    )
    if (settlementAmount <= 0) return

    // Mark Paid is a convenience UI action, not a second settlement engine.
    // Route it through recordPayment so statement linking, partial coverage,
    // audit history, and deletion all behave exactly like a normal receipt.
    await get().recordPayment({
      partyId: inv.partyId,
      date: new Date().toISOString().split('T')[0],
      method: 'Manual settlement',
      reference: `Marked paid: ${inv.invoiceNumber}`,
      allocations: [
        {
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amount: settlementAmount,
        },
      ],
    })
  },

  deleteInvoice: async (invoiceId) => {
    const { data, persist } = get()
    const target = data.invoices.find((i) => i.id === invoiceId)
    if (!target) return

    if (
      (data.payments || []).some(
        (payment) =>
          payment.allocations.length > 1 &&
          payment.allocations.some((allocation) => allocation.invoiceId === target.id),
      )
    ) {
      console.warn(
        `[books-store] Rejected delete of ${target.invoiceNumber}: it belongs to a multi-invoice payment`,
      )
      return
    }

    // Closed-period lock: deleting a posted invoice removes a posting the
    // close already swept — retained earnings would be misstated forever.
    if (target.status !== 'Draft' && isDateLocked(data, target.date)) {
      console.warn(
        `[books-store] Rejected deleting invoice dated in closed period: ${target.invoiceNumber} (${target.date}, closed through ${data.settings.closedThrough})`,
      )
      return
    }

    // Reversal is journal-based: drop every entry that references this
    // invoice, then recompute balances from the remaining journals.
    let nextJournals = [...data.journalEntries]
    if (target.status !== 'Draft') {
      nextJournals = nextJournals.filter((je) => {
        const matchesRemarks = je.remarks && je.remarks.includes(target.invoiceNumber)
        const matchesItem = je.items.some(
          (it) => it.remark && it.remark.includes(target.invoiceNumber),
        )
        return !matchesRemarks && !matchesItem
      })
    }

    // C1: payment journals die with the reversed posting — the Payment
    // records referencing this invoice must die with them.
    const nextPayments = dropInvoiceFromPayments(
      data.payments || [],
      target.id,
      target.invoiceNumber,
    )

    const nextInvoices = data.invoices.filter((i) => i.id !== invoiceId)
    const nextAccounts = computeAccountBalances(data.accounts, nextJournals)
    const nextParties = recomputePartyBalances(nextInvoices, data.parties)

    set({
      data: appendAudit(
        {
          ...data,
          invoices: nextInvoices,
          parties: nextParties,
          accounts: nextAccounts,
          journalEntries: nextJournals,
          payments: nextPayments,
        },
        createAuditEntry('invoice.delete', `Deleted invoice ${target.invoiceNumber}`, {
          invoiceNumber: target.invoiceNumber,
          amount: round2(target.grandTotal),
        }),
      ),
      activeInvoiceId: null,
    })

    await persist()
  },

  saveCreditNote: async (input) => {
    const { data, persist } = get()
    const original = data.invoices.find((i) => i.id === input.originalInvoiceId)
    if (!original) return { ok: false, error: 'Original invoice not found' }
    if (original.status === 'Draft' || original.status === 'Cancelled') {
      return { ok: false, error: 'Cannot credit a draft or cancelled invoice' }
    }

    // Closed-period lock: the reversal journal Dr's income dated in the
    // locked period — crediting an invoice the close already swept would
    // un-close the period.
    if (isDateLocked(data, original.date)) {
      return {
        ok: false,
        error: `Cannot credit ${original.invoiceNumber}: it is dated in a closed period (closed through ${data.settings.closedThrough})`,
      }
    }

    const now = new Date().toISOString()
    const items: InvoiceItem[] =
      input.items && input.items.length > 0
        ? input.items
        : original.items.map((it) => ({ ...it, id: `cn-item-${Date.now()}-${it.id}` }))

    // M5: a full credit note of a discounted invoice must mirror the
    // original's discount/round-off so its totals match and validation
    // (capped at the original grandTotal) can pass.
    const totals = calculateInvoiceTotals(items, {
      taxInclusive: data.settings.taxInclusive,
      discountTotal:
        input.items && input.items.length > 0
          ? 0
          : original.discountTotal !== undefined
            ? Number(original.discountTotal)
            : 0,
      roundOff:
        input.items && input.items.length > 0
          ? 0
          : original.roundOff !== undefined
            ? Number(original.roundOff)
            : 0,
    })

    const creditNote: Invoice = {
      id: `cn-${Date.now()}`,
      invoiceNumber: nextInvoiceNumber(data.invoices, original.type, input.date, 'CN'),
      type: original.type,
      partyId: original.partyId,
      partyName: original.partyName,
      date: input.date || now.split('T')[0],
      dueDate: original.dueDate,
      items,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      ...(original.discountTotal !== undefined ? { discountTotal: original.discountTotal } : {}),
      ...(original.roundOff !== undefined ? { roundOff: original.roundOff } : {}),
      // A credit note reduces what the party owes: the outstanding balance
      // is negative so recomputePartyBalances subtracts it.
      outstandingAmount: -round2(totals.grandTotal),
      status: 'Unpaid',
      creditNote: true,
      creditedInvoiceId: original.id,
      notes:
        input.notes !== undefined ? input.notes : `Credit note against ${original.invoiceNumber}`,
      createdAt: now,
      updatedAt: now,
    }

    // I2: cumulative credit notes against the same invoice may never exceed
    // the original total.
    const existingCreditNotes = data.invoices.filter(
      (i) => i.creditNote && i.creditedInvoiceId === original.id,
    )
    const validation = validateCreditNote({
      invoice: creditNote,
      originalInvoice: original,
      paidAmount: 0,
      existingCreditNotes,
    })
    if (!validation.ok) return { ok: false, error: validation.error }

    const party =
      data.parties.find((p) => p.id === original.partyId) ||
      data.parties.find((p) => p.name.toLowerCase() === original.partyName.toLowerCase())

    // Ledger-first: post the balanced reversal journal, then derive balances.
    const nextJournals = [
      createCreditNoteJournal(
        creditNote,
        data.accounts,
        party,
        nextJournalNumber(data.journalEntries, creditNote.date),
      ),
      ...data.journalEntries,
    ]
    const nextInvoices = [creditNote, ...data.invoices]
    const nextAccounts = computeAccountBalances(data.accounts, nextJournals)
    const nextParties = recomputePartyBalances(nextInvoices, data.parties)

    set({
      data: appendAudit(
        {
          ...data,
          invoices: nextInvoices,
          parties: nextParties,
          accounts: nextAccounts,
          journalEntries: nextJournals,
        },
        createAuditEntry(
          'credit-note.issue',
          `Issued credit note ${creditNote.invoiceNumber} against ${original.invoiceNumber}`,
          { invoiceNumber: creditNote.invoiceNumber, amount: round2(creditNote.grandTotal) },
        ),
      ),
      activeInvoiceId: null,
    })

    await persist()
    return { ok: true, creditNote }
  },

  addParty: async (party) => {
    const { data, persist } = get()
    const newParty: Party = {
      ...party,
      id: `party-${Date.now()}`,
      outstandingBalance: 0,
    }
    set({
      data: appendAudit(
        {
          ...data,
          parties: [...data.parties, newParty],
        },
        createAuditEntry('party.add', `Added party ${newParty.name} (${newParty.type})`),
      ),
    })
    await persist()
  },

  addJournalEntry: async (entry) => {
    const { data, persist } = get()
    // Closed-period lock: a manual entry dated in the locked period could
    // un-zero income/expense the close already swept.
    if (entry.date && isDateLocked(data, entry.date)) {
      console.warn(
        `[books-store] Rejected journal entry dated in closed period: ${entry.date} (closed through ${data.settings.closedThrough})`,
      )
      return false
    }
    const sumDebits = round2((entry.items || []).reduce((s, it) => s + (it.debit || 0), 0))
    const sumCredits = round2((entry.items || []).reduce((s, it) => s + (it.credit || 0), 0))
    if (sumDebits !== sumCredits) {
      console.warn('[books-store] Rejected unbalanced journal entry', entry)
      return false
    }
    const entryNumber = nextJournalNumber(data.journalEntries, entry.date)
    const newEntry: JournalEntry = {
      ...entry,
      id: `je-${Date.now()}`,
      entryNumber,
      totalDebit: sumDebits,
      totalCredit: sumCredits,
      posted: true,
    }

    // Ledger-first: append the entry, then derive balances from journals.
    const nextJournals = [newEntry, ...data.journalEntries]
    const nextAccounts = computeAccountBalances(data.accounts, nextJournals)

    set({
      data: appendAudit(
        {
          ...data,
          journalEntries: nextJournals,
          accounts: nextAccounts,
        },
        createAuditEntry(
          'journal.add',
          `Posted journal entry ${newEntry.entryNumber} (${sumDebits.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
          { amount: round2(sumDebits) },
        ),
      ),
    })

    await persist()
    return true
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

    // I3 parity with the main-process path: plan payment coverage the same
    // way (fully covered lines pre-reconciled with no journal; partially
    // covered lines post only the uncovered remainder).
    const coverage = planImportCoverage(data, toAdd)
    const storedToAdd = toAdd.map((tx) => {
      const plan = coverage.get(tx.id)
      if (!plan || !plan.fullyCovered) return tx
      return {
        ...tx,
        reconciled: true,
        matchedInvoiceId: plan.matchedInvoiceId,
        reconciledAt: new Date().toISOString(),
      }
    })

    // Ledger-first: each imported transaction posts against Bank Suspense.
    const nextJournals = [...data.journalEntries]
    for (const tx of toAdd) {
      const plan = coverage.get(tx.id)
      const uncovered = round2(Math.abs(tx.amount || 0) - (plan?.coveredAmount || 0))
      if (uncovered <= 0.005) continue
      const remainderTx = { ...tx, amount: tx.amount > 0 ? uncovered : -uncovered }
      nextJournals.unshift(
        createBankImportJournal(remainderTx, data.accounts, nextJournalNumber(nextJournals, tx.date)),
      )
    }
    const nextAccounts = computeAccountBalances(data.accounts, nextJournals)
    const bankAccount = nextAccounts.find((a) => a.id === 'acc-bank')

    set({
      data: appendAudit(
        {
          ...data,
          bankTransactions: [...existing, ...storedToAdd],
          journalEntries: nextJournals,
          accounts: nextAccounts,
        },
        createAuditEntry(
          'bank.import',
          `Imported ${toAdd.length} bank transaction${toAdd.length === 1 ? '' : 's'} from CSV (${skippedDuplicates} duplicate${skippedDuplicates === 1 ? '' : 's'} skipped)`,
        ),
      ),
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

    // Ledger-first: if the transaction was imported from a bank statement,
    // its import journal already moved the bank account, so this leg clears
    // suspense against Receivable/Payable. Legacy transactions post the full
    // direct settlement (Dr/Cr Bank). Balances derive from journals.
    const hasImportJournal = (data.journalEntries || []).some(
      (je) => je.remarks && je.remarks.includes(`Bank statement import: ${tx.id}`),
    )
    let settlementJournal: JournalEntry
    if (hasImportJournal) {
      settlementJournal = createReconciliationJournal(
        tx,
        inv,
        data.accounts,
        settledAmount,
        nextJournalNumber(data.journalEntries, tx.date),
      )
    } else {
      settlementJournal = createSettlementJournal(
        inv,
        data.accounts,
        settledAmount,
        updatedParty || party,
        nextJournalNumber(data.journalEntries, tx.date),
        'acc-bank',
        `1-Click Bank Reconciliation: Transaction ${tx.description} for Invoice ${inv.invoiceNumber}`,
      )
    }
    const nextJournals = [settlementJournal, ...data.journalEntries]
    const nextAccounts = computeAccountBalances(data.accounts, nextJournals)

    set({
      data: appendAudit(
        {
          ...data,
          bankTransactions: nextBankTransactions,
          invoices: nextInvoices,
          parties: nextParties,
          accounts: nextAccounts,
          journalEntries: nextJournals,
        },
        createAuditEntry(
          'bank.reconcile',
          `Reconciled ${tx.description || 'bank transaction'} against invoice ${inv.invoiceNumber}`,
          { invoiceNumber: inv.invoiceNumber, amount: round2(settledAmount) },
        ),
      ),
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

  recordPayment: async (input) => {
    const { data, persist } = get()

    // Pure validation + allocation (never mutates balances directly).
    const result = applyPayment(data, input)
    if (!result.ok || !result.payment || !result.updatedInvoices) {
      return { ok: false, error: result.error || 'Unable to record payment' }
    }
    const payment = result.payment

    // Phase-3 unification: the payment IS the bank movement — pre-reconcile
    // any matching unreconciled statement line so the same cash can never be
    // double-posted by a later statement import.
    const linked = linkPaymentToBankTransaction(data, payment)

    // C1: when the matched transaction already has an import journal (Flow B:
    // statement imported BEFORE the payment), the bank movement is already
    // booked — the payment leg must clear Suspense instead of moving Bank a
    // second time (same convention as createReconciliationJournal).
    const matchedTx = linked.matchedTransactionId
      ? (linked.bankTransactions.find((t) => t.id === linked.matchedTransactionId) ?? null)
      : null
    const hasImportJournal =
      matchedTx !== null &&
      (data.journalEntries || []).some((je) =>
        je.remarks ? je.remarks.includes(`Bank statement import: ${matchedTx.id}`) : false,
      )

    // Ledger-first: post the balanced payment journal, then derive balances.
    const journal = createPaymentJournal(
      payment,
      result.updatedInvoices,
      data.accounts,
      nextJournalNumber(data.journalEntries, payment.date),
      hasImportJournal
        ? { suspenseAmount: linked.coveredAmount || 0 }
        : undefined,
    )
    const nextJournals = [journal, ...data.journalEntries]
    const nextAccounts = computeAccountBalances(data.accounts, nextJournals)
    const nextParties = recomputePartyBalances(result.updatedInvoices, data.parties)

    set({
      data: appendAudit(
        {
          ...data,
          bankTransactions: linked.bankTransactions,
          payments: [payment, ...(data.payments || [])],
          invoices: result.updatedInvoices,
          journalEntries: nextJournals,
          accounts: nextAccounts,
          parties: nextParties,
        },
        createAuditEntry(
          'payment.record',
          `Recorded ${payment.type} payment of ${payment.total.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} from ${payment.partyName}`,
          { paymentId: payment.id, amount: round2(payment.total) },
        ),
      ),
    })

    await persist()
    return { ok: true }
  },

  deletePayment: async (paymentId) => {
    const { data, persist } = get()
    const payment = (data.payments || []).find((p) => p.id === paymentId)
    if (!payment) return

    // Restore each allocation onto its invoice (status back to Unpaid when > 0).
    // Refunds restore in the opposite direction: a refunded credit note's
    // credit balance grows back (outstanding -= amount).
    const nextInvoices = data.invoices.map((inv) => {
      const alloc = payment.allocations.find((a) => a.invoiceId === inv.id)
      if (!alloc) return inv
      const current = round2(
        inv.outstandingAmount !== undefined && inv.outstandingAmount !== null
          ? inv.outstandingAmount
          : inv.grandTotal,
      )
      const restored = round2(
        payment.type === 'refund' ? current - alloc.amount : current + alloc.amount,
      )
      return {
        ...inv,
        outstandingAmount: restored,
        // Restoring a full refund turns a paid credit note back into an
        // unpaid negative balance; only an exact zero stays Paid.
        status: (restored === 0 ? 'Paid' : 'Unpaid') as InvoiceStatus,
        updatedAt: new Date().toISOString(),
      }
    })

    // Reversal is journal-based: drop the payment's entries (matched by the
    // `Payment ${paymentId}` marker in entry or item remarks), then recompute.
    const nextJournals = data.journalEntries.filter((je) => {
      const matchesRemarks = je.remarks && je.remarks.includes(`Payment ${paymentId}`)
      const matchesItem = je.items.some(
        (it) => it.remark && it.remark.includes(`Payment ${paymentId}`),
      )
      return !matchesRemarks && !matchesItem
    })

    // Exact payment-to-statement reversal: remove only links owned by this
    // payment (never infer ownership from invoice/text), then replace any
    // prior import remainder journal with the new uncovered statement amount.
    let nextBankTransactions = data.bankTransactions || []
    const affectedTxs = (data.bankTransactions || []).filter((t) =>
      (t.paymentLinks || []).some((link) => link.paymentId === payment.id),
    )
    for (const affected of affectedTxs) {
      // Drop all old import journals for this statement line; the remainder
      // is recalculated below after removing the payment link.
      for (let i = nextJournals.length - 1; i >= 0; i--) {
        if (nextJournals[i].remarks?.includes(`Bank statement import: ${affected.id}`)) {
          nextJournals.splice(i, 1)
        }
      }
      const remainingLinks = (affected.paymentLinks || []).filter(
        (link) => link.paymentId !== payment.id,
      )
      const covered = paymentCoverage({ ...affected, paymentLinks: remainingLinks })
      const uncovered = round2(Math.abs(affected.amount) - covered)
      const fullyCovered = uncovered <= 0.005
      const firstLink = remainingLinks[0]
      nextBankTransactions = nextBankTransactions.map((t) =>
        t.id === affected.id
          ? {
              ...t,
              paymentLinks: remainingLinks.length > 0 ? remainingLinks : undefined,
              reconciled: fullyCovered,
              matchedInvoiceId: fullyCovered ? firstLink?.invoiceId : undefined,
              reconciledAt: fullyCovered ? new Date().toISOString() : undefined,
            }
          : t,
      )
      if (uncovered > 0.005) {
        nextJournals.unshift(
          createBankImportJournal(
            { ...affected, amount: affected.amount > 0 ? uncovered : -uncovered },
            data.accounts,
            nextJournalNumber(nextJournals, affected.date),
          ),
        )
      }
    }

    const nextAccounts = computeAccountBalances(data.accounts, nextJournals)
    const nextParties = recomputePartyBalances(nextInvoices, data.parties)

    set({
      data: appendAudit(
        {
          ...data,
          bankTransactions: nextBankTransactions,
          payments: (data.payments || []).filter((p) => p.id !== paymentId),
          invoices: nextInvoices,
          journalEntries: nextJournals,
          accounts: nextAccounts,
          parties: nextParties,
        },
        createAuditEntry('payment.delete', `Deleted payment ${payment.id}`, {
          paymentId: payment.id,
          amount: round2(payment.total),
        }),
      ),
    })

    await persist()
  },
}))

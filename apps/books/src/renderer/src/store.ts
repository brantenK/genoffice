import { create } from 'zustand'
import type {
  BooksData,
  BooksDataEnvelope,
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
  isLoadDataResult,
  isSaveDataResult,
  type BankStatementImportResult,
  type BookLoadStatus,
  type ReconcileTransactionResult,
  type SaveDataFailure,
  type SaveIntent,
} from '../../shared/ipc'
import {
  round2,
  calculateInvoiceTotals,
  createSalesInvoiceJournal,
  createPurchaseBillJournal,
  createSettlementJournal,
  createBankImportJournal,
  computeAccountBalances,
  nextInvoiceNumber,
  nextJournalNumber,
  recomputePartyBalances,
} from '../../shared/accounting'
import { applyBankStatementImport, applyReconciliation } from '../../shared/settlement'
import {
  applyPayment,
  createPaymentJournal,
  dropInvoiceFromPayments,
  linkPaymentToBankTransaction,
  paymentCoverage,
} from '../../shared/payments'
import { closePeriod, isDateLocked } from '../../shared/closing'
import {
  createCreditNoteJournal,
  mentionsReference,
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

/**
 * The last failure the user must know about — a rejected mutation, or a
 * write that did not land. Null when nothing is outstanding.
 */
interface BooksState {
  activeTab: BooksNavigationTab
  data: BooksData
  /** True on first run, when no books-data.json exists yet. */
  needsSetup: boolean
  /**
   * True when a books store exists but could not be read. Distinct from
   * `needsSetup`: the setup wizard must never open over an unreadable store,
   * because saving it would replace the user's real books with an empty one.
   */
  loadError: boolean
  /**
   * The last failure the user must know about — a rejected mutation, or a
   * write that did not land. Null when nothing is outstanding.
   */
  lastError: string | null
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
  clearError: () => void
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
  importBankStatementCsv: (csvContent: string) => Promise<BankStatementImportResult>
  reconcileTransaction: (
    transactionId: string,
    invoiceId: string,
  ) => Promise<ReconcileTransactionResult>
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
  /**
   * Writes the ledger and reports whether it landed. Callers that tell the
   * user "saved" or "done" must return this outcome, not a bare success.
   *
   * `intent` states that this write is MEANT to leave the books empty — the
   * user deleting their last record. Anything a user did not ask for is
   * written without it, and the main process then refuses to empty the books.
   */
  persist: (intent?: SaveIntent) => Promise<PersistResult>
}

let lastSavedHash = ''

/**
 * The last ledger this store saw persisted (or loaded) successfully. A failed
 * write rolls back to it, so the renderer never presents a save that did not
 * land. Explicitly `BooksData | null` rather than `undefined` so a boot with
 * no store behind it is a value the rollback path can reason about.
 */
let lastGoodSnapshot: BooksData | null = null

/**
 * The revision of the ledger currently in `lastGoodSnapshot`. It is sent with
 * every save so the main process can reject a write from a stale client, and
 * replaced by the revision the server reports back.
 */
let currentRevision = 0

export function getRevision(): number {
  return currentRevision
}

export function setRevision(revision: number): void {
  currentRevision = Number.isFinite(revision) ? revision : 0
}

export function getLastGoodSnapshot(): BooksData | null {
  return lastGoodSnapshot
}

/** Records `data` as the last state known to be on disk. */
export function setLastGoodSnapshot(data: BooksData | null): void {
  lastGoodSnapshot = data
}

/** The audit actor this process knows about, when it knows one at all. */
function localAuditActor(): string | undefined {
  const fromProcess =
    typeof process !== 'undefined' && process?.env
      ? process.env.BOOKS_AUDIT_ACTOR || process.env.USERNAME || process.env.USER
      : undefined
  const actor = String(fromProcess || '').trim()
  return actor.length > 0 ? actor : undefined
}

/**
 * Appends an audit entry with an explicit actor when the writer knows one.
 *
 * A store action runs in the renderer, which cannot name the OS user that the
 * main process stamps on the write. Passing an empty or fabricated actor would
 * be worse than passing none, so the field is simply omitted and the main
 * write path fills it in. When the environment does name an actor (a
 * single-user desktop, or a test), it is passed through.
 */
function appendAuditEntry(
  data: BooksData,
  action: string,
  summary: string,
  extra?: Parameters<typeof createAuditEntry>[2],
): BooksData {
  const actor = localAuditActor()
  const entry = createAuditEntry(action, summary, {
    ...extra,
    ...(actor && !extra?.actor ? { actor } : {}),
  })
  return appendAudit(data, entry)
}

/** First line of an unknown thrown value, for a message a user can read. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  const text = String(error ?? '').trim()
  return text || 'Unknown error'
}

/**
 * The forensic copy a failed load may point at, when the main process keeps
 * one. Read defensively: the field is optional and a renderer built against a
 * main process that never sends it simply has no path to show.
 */
function forensicPathOf(result: unknown): string | undefined {
  const value = (result as { forensicPath?: unknown } | null)?.forensicPath
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Whether the ledger currently on screen came from a successful read. Only a
 * `loaded` or `first-run` status may be written back through the bridge: while
 * a store is unreadable (or has never been read at all) the in-memory ledger is
 * a placeholder, and saving it would replace the user's real books. The
 * bridgeless path is exempt because there is no file behind it to protect.
 */
let loadStatus: BookLoadStatus = 'unknown'

export function getLoadStatus(): BookLoadStatus {
  return loadStatus
}

/** The refusal message for a write attempted while the store is unknown/unreadable. */
export function writeBlockedMessage(): string {
  return loadStatus === 'unreadable'
    ? 'Your books could not be opened, so nothing was saved. Fix or restore the books file, then reload before making changes.'
    : 'Your books have not finished loading, so nothing was saved. Reload the module before making changes.'
}

/** A ledger that may still carry the envelope's write cursor. */
type PossiblyRevised = BooksData & { revision?: number }

/**
 * The ledger without the envelope-only `revision`. The cursor is the store's
 * own bookkeeping and travels as the explicit `saveData` argument; a stale
 * copy left inside a payload could otherwise be mistaken for the writer's
 * position on disk, which turns every conflict retry into the same conflict.
 */
function ledgerWithoutRevision(ledger: PossiblyRevised): BooksData {
  const { revision: _revision, ...rest } = ledger
  return rest
}

/** The write cursor of a payload the main process sent, when it sent one. */
function revisionOf(ledger: BooksData): number | undefined {
  const value = (ledger as PossiblyRevised).revision
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Adopts an authoritative envelope: the ledger, the write cursor and the
 * load status move together, because a ledger from a successful read is the
 * only thing worth writing back. `loadData` and the conflict path both use it.
 */
export function applyLoadedEnvelope(envelope: BooksDataEnvelope): void {
  const snapshot = ledgerWithoutRevision(envelope)
  loadStatus = 'loaded'
  // A reply with no usable cursor (a main process predating revisions) is the
  // migrated default rather than `undefined`, which the guard would reject.
  setRevision(envelope.revision)
  lastGoodSnapshot = snapshot
  lastSavedHash = computeDataHash(snapshot)
  useBooksStore.setState({ data: snapshot, needsSetup: false, loadError: false })
}

function clearedError(): { lastError: null } {
  return { lastError: null }
}

/**
 * Records a failure the user must see and clears it again when the same
 * operation is retried successfully, so a stale banner cannot outlive the
 * problem it described.
 */
function failed(key: string, message: string): void {
  lastFailureKey = key
  useBooksStore.setState({ lastError: message })
}

function succeeded(key: string): void {
  if (lastFailureKey === key) {
    lastFailureKey = null
    useBooksStore.setState({ lastError: null })
  }
}

let lastFailureKey: string | null = null

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

/** Outcome of one write attempt, flattened for the calling action. */
type BridgeSaveOutcome = { ok: true; revision: number } | { ok: false; reason: string }

/**
 * What one write attempt did, as a calling action has to report it. A mutation
 * that reached the user as "done" while the write was refused is the failure
 * this shape exists to prevent.
 */
export type PersistResult = { ok: true } | { ok: false; error: string }

/**
 * Writes the ledger through the preload bridge and keeps the store's view of
 * "what is really on disk" honest:
 *
 * - a successful write records the new revision and last-good snapshot;
 * - a conflict replaces the local ledger with the server's `current`, because
 *   the pending write is discarded and the books on screen must match disk;
 * - any other failure restores the last-good snapshot, so the UI can never
 *   present a mutation that did not land.
 *
 * Every rejection (transport throw, unrecognised reply, guarded write) also
 * raises `lastError`.
 */
async function saveThroughBridge(
  api: NonNullable<Window['booksApi']>,
  payload: BooksData,
  intent?: SaveIntent,
): Promise<BridgeSaveOutcome> {
  // The revision is the explicit second argument and is never read out of the
  // ledger: the body describes the books, the argument describes the writer's
  // position. Sending both from one object is what made a conflict permanent.
  const ledger = ledgerWithoutRevision(payload)
  let raw: unknown
  try {
    raw = await api.saveData(ledger, currentRevision, intent)
  } catch (err) {
    return failSave(`Could not save your changes: ${messageOf(err)}`)
  }

  if (!isSaveDataResult(raw)) {
    return failSave('Could not save your changes: the app returned an unrecognised response')
  }
  if (raw.ok) {
    setRevision(raw.revision)
    lastGoodSnapshot = ledger
    lastSavedHash = computeDataHash(ledger)
    succeeded('persist')
    return { ok: true, revision: raw.revision }
  }

  const failure = raw as SaveDataFailure
  if (failure.conflict && failure.current) {
    // The write did not land, so the ledger on screen is replaced by the one
    // the server holds — cursor included, so the retry continues from the
    // revision that was just refused rather than replaying the stale one.
    applyLoadedEnvelope(failure.current)
    return failSave(
      'Your books changed elsewhere since you loaded them, so this change was discarded and the latest books were reloaded. Review the ledger and try again.',
    )
  }
  if (failure.conflict) {
    return failSave(
      'Your books changed elsewhere, so this change was discarded. Reload the module and try again.',
    )
  }
  return failSave(`Could not save your changes: ${failure.error}`)
}

function failSave(reason: string): BridgeSaveOutcome {
  restoreLastGood()
  failed('persist', reason)
  return { ok: false, reason }
}

/** Rolls the in-memory ledger back to the last state known to be persisted. */
function restoreLastGood(): void {
  if (lastGoodSnapshot) {
    useBooksStore.setState({ data: lastGoodSnapshot })
    lastSavedHash = computeDataHash(lastGoodSnapshot)
  }
}

/**
 * An existing store that exists but could not be read. This must never be
 * mistaken for a first run: `needsSetup` stays false so the setup wizard
 * cannot invite the user to write an empty ledger over their real books.
 */
function unreadableStore(message: string): void {
  lastFailureKey = 'load'
  loadStatus = 'unreadable'
  lastGoodSnapshot = null
  useBooksStore.setState({
    data: emptyBooksData,
    needsSetup: false,
    loadError: true,
    lastError: message,
  })
}

export function setUnreadableForTesting(): void {
  unreadableStore('books-data.json could not be read')
}

export const useBooksStore = create<BooksState>((set, get) => ({
  activeTab: 'dashboard',
  data: emptyBooksData,
  needsSetup: false,
  loadError: false,
  lastError: null,
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
  clearError: () => {
    lastFailureKey = null
    set(clearedError())
  },

  completeSetup: async (ledger) => {
    const api = getBooksApi()

    // Setup may only run when the load said there are no books yet. A store
    // that could not be read (or was never read) is not a first run, and the
    // wizard's version of this call would wipe the ledger behind it.
    if (loadStatus === 'unreadable' || loadStatus === 'unknown') {
      failed('setup', writeBlockedMessage())
      set({ needsSetup: true })
      return
    }

    const setupLedger = appendAuditEntry(
      ledger,
      'setup.complete',
      `Completed first-run setup for ${ledger.settings?.companyName || 'new company'}`,
    )
    if (!api?.saveData) {
      lastSavedHash = computeDataHash(setupLedger)
      lastGoodSnapshot = setupLedger
      loadStatus = 'loaded'
      set({ data: setupLedger, needsSetup: false, loadError: false, ...clearedError() })
      return
    }
    const result = await saveThroughBridge(api, setupLedger)
    if (!result.ok) {
      // The wizard owns the message it shows for a failed first save; the
      // store must not claim the setup landed, so the wizard stays up.
      failed('setup', `Could not save your books: ${result.reason}`)
      set({ needsSetup: true })
      return
    }
    lastGoodSnapshot = setupLedger
    lastSavedHash = computeDataHash(setupLedger)
    loadStatus = 'loaded'
    succeeded('setup')
    set({ data: setupLedger, needsSetup: false, loadError: false })
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
      data: appendAuditEntry(
        { ...data, settings: nextSettings, updatedAt: new Date().toISOString() },
        'settings.update',
        `Updated settings for ${nextSettings.companyName}`,
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
      data: appendAuditEntry(
        result.data,
        'period.close',
        `Closed financial period through ${throughDate} — income and expenses moved to retained earnings`,
      ),
    })
    // The close is only real once it is on disk: a refused write rolls the
    // ledger back, and reporting success here would leave the settings screen
    // confirming a closed period the store never recorded.
    const saved = await persist()
    return saved.ok ? { ok: true } : { ok: false, error: saved.error }
  },

  loadData: async () => {
    const api = getBooksApi()
    if (api?.loadData) {
      let raw: unknown
      try {
        raw = await api.loadData()
      } catch (err) {
        // A transport failure says nothing about whether books exist. Showing
        // the wizard here would invite the user to save an empty ledger over
        // their real books; surface the error and refuse to overwrite instead.
        unreadableStore(`Could not open your books: ${messageOf(err)}`)
        return
      }

      // A main process predating the discriminated result answers with a bare
      // envelope or null. That reply cannot distinguish "no books" from
      // "unreadable", so it is treated as unreadable rather than guessed at.
      const result = isLoadDataResult(raw)
        ? raw
        : !Array.isArray(raw) && typeof raw === 'object' && raw !== null && 'accounts' in raw
          ? ({ ok: true, readable: false, data: null } as const)
          : raw === null || raw === undefined
            ? ({ ok: true, readable: false, data: null } as const)
            : ({ ok: false, readable: false, data: null, error: 'unrecognised response' } as const)

      if (!result.ok) {
        console.warn('[books-store] Failed to load data from IPC:', result.error)
        unreadableStore(`Could not open your books: ${result.error}`)
        return
      }
      if (!result.readable) {
        const detail = result.error ? `: ${result.error}` : ''
        console.warn(`[books-store] Books store exists but could not be read${detail}`)
        // The main process keeps a copies-on-first-read forensic copy of bytes
        // it could not parse; naming it turns "your file is broken" into
        // something the user (or support) can actually look at.
        const forensic = forensicPathOf(result)
        unreadableStore(
          `Your books could not be opened${detail}. They were left untouched — fix or restore the store before saving again.` +
            (forensic ? ` A copy of the unreadable file was kept at ${forensic}.` : ''),
        )
        return
      }
      if (result.data && result.data.accounts && result.data.invoices) {
        applyLoadedEnvelope(result.data)
        succeeded('load')
        return
      }
      // No store on disk yet — a genuine first run: show the setup wizard.
      loadStatus = 'first-run'
      currentRevision = 0
      lastGoodSnapshot = null
      lastSavedHash = ''
      set({ data: emptyBooksData, needsSetup: true, loadError: false, ...clearedError() })
      return
    }
    // No IPC bridge (dev fallback): treat as unconfigured.
    currentRevision = 0
    lastGoodSnapshot = null
    set({ data: emptyBooksData, needsSetup: true, ...clearedError() })
  },

  syncFromMain: (incomingData: BooksData) => {
    if (!incomingData) return

    // A push may not paper over a failed read. The ledger in memory is a
    // placeholder and this store cannot vouch for either copy, so adopting the
    // broadcast would hide the one thing the user has to act on — and clearing
    // the error state would open a desk over books nobody can vouch for. The
    // change on disk is reported instead; writes stay refused until a load
    // succeeds.
    if (loadStatus === 'unreadable') {
      failed(
        'load',
        'Your books were changed on disk by another ZanoStack module, but this copy could not read them, so the change is not shown. Reload once the books file can be read.',
      )
      return
    }

    const incomingHash = computeDataHash(incomingData)
    if (incomingHash === lastSavedHash) {
      // Layer 2 loop suppression: incoming payload matches last saved data
      return
    }

    // Only a whole ledger is adopted. A malformed broadcast must not blank the
    // ledger on screen, and recording its hash would suppress the next, correct
    // one — so it is dropped before anything is written down.
    if (!Array.isArray(incomingData.accounts) || !Array.isArray(incomingData.invoices)) {
      console.warn('[books-store] Ignored a broadcast that is not a whole ledger')
      return
    }
    lastSavedHash = incomingHash

    // A real ledger arrived (e.g. written by CRM/Tenders while the setup
    // wizard was showing) — the first-run state is over.
    useBooksStore.setState({ needsSetup: false, loadError: false })

    const invoices = incomingData.invoices
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

    const nextData = ledgerWithoutRevision({
      ...incomingData,
      settings,
      accounts: incomingData.accounts,
      parties,
      invoices,
      journalEntries,
      bankTransactions,
      payments,
      auditLog,
    })

    // The broadcast is the main process's own read of the store, so the write
    // cursor moves with it: keeping the old one would make the next save look
    // stale for a ledger this window is already showing. Adopting exactly what
    // arrived (never a maximum) keeps the cursor honest about which ledger is
    // on screen, so a stale broadcast surfaces as a conflict, not as data loss.
    const incomingRevision = revisionOf(incomingData)
    if (incomingRevision !== undefined) setRevision(incomingRevision)

    set({ data: nextData })
    // CRITICAL: Do NOT call persist() here to avoid loop!
  },

  persist: async (intent) => {
    const { data } = get()
    // Optimistically advance the hash so an echo of this write from another
    // window is recognised as our own; a failed write corrects it below.
    lastSavedHash = computeDataHash(data)

    // An unreadable store is never written over, bridge or not: the ledger in
    // memory is a placeholder, and it must not be presented as saved.
    if (loadStatus === 'unreadable') {
      lastSavedHash = lastGoodSnapshot ? computeDataHash(lastGoodSnapshot) : ''
      restoreLastGood()
      failed('persist', writeBlockedMessage())
      return { ok: false, error: writeBlockedMessage() }
    }

    const api = getBooksApi()
    if (!api?.saveData) {
      // No bridge (dev browser, headless renderer): the in-memory ledger is the
      // only copy there is, so there is no file for the load gate to protect.
      lastGoodSnapshot = data
      succeeded('persist')
      return { ok: true }
    }

    // A store that has never been read may not be written through the bridge:
    // the file behind it is unknown, so the write could replace real books.
    if (loadStatus === 'unknown') {
      lastSavedHash = lastGoodSnapshot ? computeDataHash(lastGoodSnapshot) : ''
      restoreLastGood()
      failed('persist', writeBlockedMessage())
      return { ok: false, error: writeBlockedMessage() }
    }

    const outcome = await saveThroughBridge(api, data, intent)
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.reason }
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
      const message = `Cannot edit ${oldInvoice.invoiceNumber}: it is settled by a payment covering several invoices.`
      console.warn(
        `[books-store] Rejected edit of ${oldInvoice.invoiceNumber}: multi-invoice payment`,
      )
      failed('invoice.save', message)
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
      const message = `Cannot post ${targetInvoice.invoiceNumber} dated ${targetInvoice.date}: the period is closed through ${data.settings.closedThrough}.`
      console.warn(`[books-store] Rejected posting into closed period: ${targetInvoice.date}`)
      failed('invoice.save', message)
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
      data: appendAuditEntry(
        {
          ...data,
          invoices: nextInvoices,
          parties: nextParties,
          accounts: nextAccounts,
          journalEntries: nextJournals,
          payments: nextPayments,
        },
        'invoice.save',
        `Saved invoice ${targetInvoice.invoiceNumber} (${targetInvoice.status})`,
        { invoiceNumber: targetInvoice.invoiceNumber, amount: round2(targetInvoice.grandTotal) },
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
    const result = await get().recordPayment({
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
    // recordPayment already reported a rejection; the invoice stays unpaid and
    // the user must hear about it rather than see a silently ignored click.
    if (!result.ok) {
      failed('invoice.pay', `Could not mark ${inv.invoiceNumber} as paid: ${result.error}`)
    }
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
      const message = `Cannot delete ${target.invoiceNumber}: it is settled by a payment covering several invoices.`
      console.warn(
        `[books-store] Rejected delete of ${target.invoiceNumber}: multi-invoice payment`,
      )
      failed('invoice.delete', message)
      return
    }

    // Closed-period lock: deleting a posted invoice removes a posting the
    // close already swept — retained earnings would be misstated forever.
    if (target.status !== 'Draft' && isDateLocked(data, target.date)) {
      const message = `Cannot delete ${target.invoiceNumber}: it is dated ${target.date}, inside the period closed through ${data.settings.closedThrough}.`
      console.warn(`[books-store] Rejected deleting invoice dated in closed period`)
      failed('invoice.delete', message)
      return
    }

    // Reversal is journal-based: drop every entry that references this
    // invoice, then recompute balances from the remaining journals.
    let nextJournals = [...data.journalEntries]
    if (target.status !== 'Draft') {
      nextJournals = reversalJournalRemoval(target.invoiceNumber, nextJournals)
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
      data: appendAuditEntry(
        {
          ...data,
          invoices: nextInvoices,
          parties: nextParties,
          accounts: nextAccounts,
          journalEntries: nextJournals,
          payments: nextPayments,
        },
        'invoice.delete',
        `Deleted invoice ${target.invoiceNumber}`,
        {
          invoiceNumber: target.invoiceNumber,
          amount: round2(target.grandTotal),
        },
      ),
      activeInvoiceId: null,
    })

    // The user removed a record on purpose. If that record was the last one,
    // the resulting empty ledger is what they asked for, so the write states
    // its reason — the main process refuses to empty a populated ledger without
    // one. (The reason only decides anything when the write really is empty,
    // and then the deleted record was the last record.)
    await persist({ emptyLedger: 'user-deleted-last-record' })
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
      data: appendAuditEntry(
        {
          ...data,
          invoices: nextInvoices,
          parties: nextParties,
          accounts: nextAccounts,
          journalEntries: nextJournals,
        },
        'credit-note.issue',
        `Issued credit note ${creditNote.invoiceNumber} against ${original.invoiceNumber}`,
        { invoiceNumber: creditNote.invoiceNumber, amount: round2(creditNote.grandTotal) },
      ),
      activeInvoiceId: null,
    })

    const saved = await persist()
    if (!saved.ok) return { ok: false, error: saved.error }
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
      data: appendAuditEntry(
        {
          ...data,
          parties: [...data.parties, newParty],
        },
        'party.add',
        `Added party ${newParty.name} (${newParty.type})`,
      ),
    })
    await persist()
  },

  addJournalEntry: async (entry) => {
    const { data, persist } = get()
    // Closed-period lock: a manual entry dated in the locked period could
    // un-zero income/expense the close already swept.
    if (entry.date && isDateLocked(data, entry.date)) {
      const message = `Cannot post a journal entry dated ${entry.date}: the period is closed through ${data.settings.closedThrough}.`
      console.warn(`[books-store] Rejected journal entry dated in closed period: ${entry.date}`)
      failed('journal.add', message)
      return false
    }
    const sumDebits = round2((entry.items || []).reduce((s, it) => s + (it.debit || 0), 0))
    const sumCredits = round2((entry.items || []).reduce((s, it) => s + (it.credit || 0), 0))
    if (sumDebits !== sumCredits) {
      const message = `Cannot post the journal entry: debits (${sumDebits.toFixed(2)}) do not equal credits (${sumCredits.toFixed(2)}).`
      console.warn('[books-store] Rejected unbalanced journal entry')
      failed('journal.add', message)
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
      data: appendAuditEntry(
        {
          ...data,
          journalEntries: nextJournals,
          accounts: nextAccounts,
        },
        'journal.add',
        `Posted journal entry ${newEntry.entryNumber} (${sumDebits.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
        { amount: round2(sumDebits) },
      ),
    })

    // The caller keeps the form open on `false`, so a refused write must be
    // reported as one — the entry is in memory only until the save lands.
    const saved = await persist()
    return saved.ok
  },

  importBankStatementCsv: async (csvContent: string) => {
    const api = getBooksApi()
    if (api?.importBankStatementCsv) {
      const res = await api.importBankStatementCsv(csvContent)
      if (res.ok) {
        await get().loadData()
        succeeded('bank.import')
      } else {
        failed('bank.import', res.error || 'The bank statement could not be imported.')
      }
      return res
    }

    // No IPC bridge (dev browser): run the shared engine in-process instead
    // of a private copy, so the import behaves identically either way.
    const { data, persist } = get()
    const { result, ledger } = applyBankStatementImport(data, csvContent)
    if (!result.ok || !ledger) {
      failed('bank.import', result.error || 'The bank statement could not be imported.')
      return result
    }
    set({ data: ledger })
    const saved = await persist()
    if (!saved.ok) return { ...result, ok: false, error: saved.error }
    succeeded('bank.import')
    return result
  },

  reconcileTransaction: async (transactionId: string, invoiceId: string) => {
    const api = getBooksApi()
    if (api?.reconcileTransaction) {
      const res = await api.reconcileTransaction(transactionId, invoiceId)
      if (res.ok) {
        await get().loadData()
        succeeded('bank.reconcile')
      } else {
        failed('bank.reconcile', res.error || 'The transaction could not be reconciled.')
      }
      return res
    }

    // No IPC bridge (dev browser): run the shared engine in-process instead
    // of a private copy, so the UI and the backend settle identically.
    const { data, persist } = get()
    const { result, ledger } = applyReconciliation(data, { transactionId, invoiceId })
    if (!result.ok || !ledger) {
      failed('bank.reconcile', result.error || 'The transaction could not be reconciled.')
      return result
    }
    set({ data: ledger })
    const saved = await persist()
    if (!saved.ok) return { ...result, ok: false, error: saved.error }
    succeeded('bank.reconcile')
    return result
  },

  recordPayment: async (input) => {
    const { data, persist } = get()

    // Pure validation + allocation (never mutates balances directly).
    const result = applyPayment(data, input)
    if (!result.ok || !result.payment || !result.updatedInvoices) {
      const reason = result.error || 'Unable to record payment'
      failed('payment.record', reason)
      return { ok: false, error: reason }
    }
    const payment = result.payment

    // Phase-3 unification: the payment IS the bank movement — pre-reconcile
    // any matching unreconciled statement line so the same cash can never be
    // double-posted by a later statement import.
    const linked = linkPaymentToBankTransaction(data, payment)

    // C1: when the matched transaction already has an import journal (Flow B:
    // statement imported BEFORE the payment), the bank movement is already
    // booked — the payment leg must clear Suspense instead of moving Bank a
    // second time, same as the reconciliation settlement leg.
    const matchedTx = linked.matchedTransactionId
      ? (linked.bankTransactions.find((t) => t.id === linked.matchedTransactionId) ?? null)
      : null
    const hasImportJournal =
      matchedTx !== null &&
      (data.journalEntries || []).some((je) =>
        mentionsReference(je.remarks, `Bank statement import: ${matchedTx.id}`),
      )

    // Ledger-first: post the balanced payment journal, then derive balances.
    const journal = createPaymentJournal(
      payment,
      result.updatedInvoices,
      data.accounts,
      nextJournalNumber(data.journalEntries, payment.date),
      hasImportJournal ? { suspenseAmount: linked.coveredAmount || 0 } : undefined,
    )
    const nextJournals = [journal, ...data.journalEntries]
    const nextAccounts = computeAccountBalances(data.accounts, nextJournals)
    const nextParties = recomputePartyBalances(result.updatedInvoices, data.parties)

    set({
      data: appendAuditEntry(
        {
          ...data,
          bankTransactions: linked.bankTransactions,
          payments: [payment, ...(data.payments || [])],
          invoices: result.updatedInvoices,
          journalEntries: nextJournals,
          accounts: nextAccounts,
          parties: nextParties,
        },
        'payment.record',
        `Recorded ${payment.type} payment of ${payment.total.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} from ${payment.partyName}`,
        { paymentId: payment.id, amount: round2(payment.total) },
      ),
    })

    // Reporting success here is what made a refused write invisible: the caller
    // (markInvoicePaid included) must hear the real outcome.
    const saved = await persist()
    if (!saved.ok) return { ok: false, error: saved.error }
    succeeded('payment.record')
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
      if (mentionsReference(je.remarks, `Payment ${paymentId}`)) return false
      return !je.items.some((it) => mentionsReference(it.remark, `Payment ${paymentId}`))
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
        if (mentionsReference(nextJournals[i].remarks, `Bank statement import: ${affected.id}`)) {
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
      data: appendAuditEntry(
        {
          ...data,
          bankTransactions: nextBankTransactions,
          payments: (data.payments || []).filter((p) => p.id !== paymentId),
          invoices: nextInvoices,
          journalEntries: nextJournals,
          accounts: nextAccounts,
          parties: nextParties,
        },
        'payment.delete',
        `Deleted payment ${payment.id}`,
        {
          paymentId: payment.id,
          amount: round2(payment.total),
        },
      ),
    })

    await persist()
  },
}))

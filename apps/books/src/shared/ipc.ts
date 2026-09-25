import type {
  BankTransaction,
  BooksData,
  BooksDataEnvelope,
  Invoice,
  InvoiceStatus,
  Payment,
  SettlementSuggestion,
} from './types'

export const BOOKS_CHANNELS = {
  loadData: 'books:load-data',
  saveData: 'books:save-data',
  dataChanged: 'books:data-changed',
  DATA_CHANGED: 'books:data-changed',
  exportToSheets: 'books:export-to-sheets',
  openInPdf: 'books:open-in-pdf',
  openInCrm: 'books:open-in-crm',
  openInTenders: 'books:open-in-tenders',
  importBankStatementCsv: 'books:import-bank-statement-csv',
  reconcileTransaction: 'books:reconcile-transaction',
  getSettlementSuggestions: 'books:get-settlement-suggestions',
  backupNow: 'books:backup-now',
  listBackups: 'books:list-backups',
  restoreBackup: 'books:restore-backup',
} as const

export interface BackupResult {
  ok: boolean
  path?: string
  error?: string
}

export interface BackupFileInfo {
  name: string
  path: string
  size: number
  modifiedAt: string
  /**
   * `'safety-copy'` marks the automatic pre-restore copies of the live ledger
   * — the undo a restore leaves behind — as opposed to a backup the user made.
   * Optional so a listing from a main process that predates safety copies
   * still satisfies this shape; a missing kind means a backup.
   */
  kind?: 'backup' | 'safety-copy'
}

/** Result of `books:import-bank-statement-csv` (books-core importBankStatement). */
export interface BankStatementImportResult {
  ok: boolean
  importedCount?: number
  skippedDuplicates?: number
  netAdjustment?: number
  /** Balance of acc-bank after the import, or null when the account is missing. */
  newBankBalance?: number | null
  /** The statement lines stored by this import (pre-reconciled lines included). */
  transactions?: BankTransaction[]
  error?: string
}

/** Result of `books:reconcile-transaction` (books-main executeReconciliation). */
export interface ReconcileTransactionResult {
  ok: boolean
  error?: string
  transactionId?: string
  invoiceId?: string
  invoiceNumber?: string
  settledAmount?: number
  /** Cash on the line that the invoice could not absorb; held as a credit. */
  unappliedAmount?: number
  remainingOutstanding?: number
  invoiceStatus?: string
  partyBalance?: number
  /** True when a matching tender milestone was back-propagated as PAID. */
  tenderMilestonePaid?: boolean
  matchedMilestoneId?: string
  matchedTenderId?: string
}

/** Result of `books:restore-backup` (backup-restore restoreBackup). */
export interface RestoreBackupResult {
  ok: boolean
  /** The migrated ledger written to disk, echoed back for a live broadcast. */
  restoredData?: BooksDataEnvelope
  error?: string
}

/**
 * Why a write is allowed to replace a populated ledger with an empty one.
 *
 * Emptying the books is refused by default, because a payload can look
 * populated and still be empty after migration. The two reasons below are the
 * only ones there are, and each names an action the user took and confirmed:
 * the guard is therefore never bypassed by a corrupt or stale payload, only by
 * a caller stating which user action it is carrying out.
 */
export type EmptyLedgerReason = 'user-deleted-last-record' | 'user-restored-empty-backup'

/**
 * What one save MEANS to do to the ledger, as the renderer states it over IPC.
 * Omitting it is the ordinary case and the empty-replacement guard applies;
 * setting it is the writer's explicit claim that leaving no invoices and no
 * journal entries is the point of this write.
 */
export interface SaveIntent {
  emptyLedger?: EmptyLedgerReason
}

/**
 * Result of `books:load-data`.
 *
 * `LoadDataResult` is a discriminated union because "there are no books yet"
 * and "the books exist but could not be read" demand opposite reactions: the
 * first is a genuine first run that shows the setup wizard, the second must
 * never be answered with an empty ledger — saving that would overwrite the
 * user's real books. `readable: false` also describes a client that predates
 * the discriminated contract (an older main process answering with a bare
 * `null`/envelope), so the renderer refuses to guess rather than assume.
 *
 * `forensicPath` is where the main process kept a copy of the unreadable bytes,
 * so the user can be told what to salvage instead of only that something broke.
 */
export type LoadDataResult =
  | { ok: true; readable: true; data: BooksDataEnvelope | null }
  | { ok: true; readable: false; data: null; error?: string; forensicPath?: string }
  | { ok: false; readable: false; data: null; error: string }

/**
 * The outcome of the most recent `loadData()`. Exported so the store's own
 * actions — and its tests — can ask whether the ledger on screen came from a
 * successful read. Only that answer may be written back: a client whose load
 * failed has no idea what it would be replacing.
 */
export type BookLoadStatus = 'unknown' | 'first-run' | 'loaded' | 'unreadable'

export interface SaveDataSuccess {
  ok: true
  /** Revision of the write just persisted; the client tracks it for the next save. */
  revision: number
}

export interface SaveDataFailure {
  ok: false
  error: string
  /** True when the write lost an optimistic-revision race against another writer. */
  conflict?: true
  /** The ledger as it stands on disk when the write did not land. */
  current?: BooksDataEnvelope
}

/**
 * Result of `books:save-data`. A bare boolean cannot say *why* a write was
 * rejected, so the renderer could not tell a closed-period guard from a
 * concurrent writer.
 */
export type SaveDataResult = SaveDataSuccess | SaveDataFailure

export interface BooksApi {
  /** The stored envelope, or a diagnosis of why it could not be produced. */
  loadData: () => Promise<LoadDataResult>
  /**
   * Persists the ledger. The payload carries the `revision` the client last
   * loaded so the main process can detect a concurrent writer.
   *
   * `intent` is the writer's explicit statement about a write the user made on
   * purpose and that leaves the books empty (deleting the last record). It is
   * only honoured together with a current `revision`; a write that omits it is
   * judged by the empty-replacement guard.
   */
  saveData: (data: BooksData, revision: number, intent?: SaveIntent) => Promise<SaveDataResult>
  onDataChanged: (callback: (data: BooksData) => void) => () => void
  exportToSheets: (
    reportName: string,
    csvContent: string,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>
  openInPdf: (
    invoice: Invoice,
    companyName: string,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>
  openInCrm: () => Promise<boolean>
  openInTenders: () => Promise<boolean>
  importBankStatementCsv: (csvContent: string) => Promise<BankStatementImportResult>
  reconcileTransaction: (
    transactionId: string,
    invoiceId: string,
  ) => Promise<ReconcileTransactionResult>
  getSettlementSuggestions: () => Promise<SettlementSuggestion[]>
  backupNow: () => Promise<BackupResult>
  listBackups: () => Promise<BackupFileInfo[]>
  restoreBackup: (backupName: string) => Promise<RestoreBackupResult>
}

/**
 * A validator verdict: the checked value, or the reason a payload was
 * rejected. Validators never throw, so a handler can answer with an error
 * instead of crashing the main process.
 */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Hard caps for CSV text crossing the IPC boundary. */
export const MAX_CSV_CHARS = 5_000_000
export const MAX_CSV_BYTES = 8 * 1024 * 1024
/** Cap for machine-generated identifiers and file names. */
export const MAX_ID_CHARS = 200
/** The only file names `books:restore-backup` may resolve to a backup. */
export const BACKUP_NAME_PATTERN = /^books-backup-.*\.json$/
/**
 * The pre-restore safety copies `restoreBackup` writes before it replaces the
 * live ledger. Same shape rule as a backup name under its own prefix: they are
 * restore points in their own right (the undo a restore leaves behind), so the
 * restore channel resolves them too.
 */
export const SAFETY_COPY_NAME_PATTERN = /^pre-restore-.*\.json$/

const INVOICE_STATUSES = [
  'Draft',
  'Unpaid',
  'Paid',
  'Overdue',
  'Cancelled',
] as const satisfies readonly InvoiceStatus[]
const INVOICE_TYPES = ['Sales', 'Purchase'] as const satisfies readonly Invoice['type'][]
const PAYMENT_TYPES = ['received', 'paid', 'refund'] as const satisfies readonly Payment['type'][]
const SETTINGS_TEXT_FIELDS = [
  'companyName',
  'taxNumber',
  'currency',
  'currencySymbol',
  'financialYearStart',
  'address',
  'email',
  'phone',
] as const

function invalid<T>(error: string): ValidationResult<T> {
  return { ok: false, error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

/** True when the text carries a control character (never valid in an id). */
function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Exact UTF-8 length without Buffer/TextEncoder, so the guard is portable. */
function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

function settingsError(settings: Record<string, unknown>): string | null {
  for (const field of SETTINGS_TEXT_FIELDS) {
    const value = settings[field]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `Company setting ${field} must be a string`
    }
  }
  const defaultTaxRate = settings.defaultTaxRate
  if (
    defaultTaxRate !== undefined &&
    defaultTaxRate !== null &&
    !isNonNegativeNumber(defaultTaxRate)
  ) {
    return 'Company setting defaultTaxRate must be a non-negative number'
  }
  const taxInclusive = settings.taxInclusive
  if (taxInclusive !== undefined && taxInclusive !== null && typeof taxInclusive !== 'boolean') {
    return 'Company setting taxInclusive must be a boolean'
  }
  return null
}

function invoiceCoreError(raw: unknown): string | null {
  if (!isRecord(raw)) return 'Every invoice must be an object'
  if (!isNonEmptyString(raw.id)) return 'Every invoice must carry a non-empty id'
  const id = raw.id
  if (!isNonEmptyString(raw.invoiceNumber)) {
    return `Invoice ${id} invoiceNumber must be a non-empty string`
  }
  const type = raw.type
  if (typeof type !== 'string' || !INVOICE_TYPES.includes(type as Invoice['type'])) {
    return `Invoice ${id} type must be Sales or Purchase`
  }
  const status = raw.status
  if (typeof status !== 'string' || !INVOICE_STATUSES.includes(status as InvoiceStatus)) {
    return `Invoice ${id} status is not a known invoice status`
  }
  if (!Array.isArray(raw.items)) return `Invoice ${id} items must be an array`
  for (const field of ['subtotal', 'taxTotal', 'grandTotal', 'outstandingAmount'] as const) {
    if (!isFiniteNumber(raw[field])) return `Invoice ${id} ${field} must be a finite number`
  }
  return null
}

function invoiceItemError(raw: unknown): string | null {
  if (!isRecord(raw)) return 'Every invoice item must be an object'
  for (const field of ['qty', 'rate', 'amount'] as const) {
    if (!isFiniteNumber(raw[field])) return `Invoice item ${field} must be a finite number`
  }
  if (!isNonNegativeNumber(raw.taxRate)) {
    return 'Invoice item taxRate must be a non-negative number'
  }
  const discountRate = raw.discountRate
  if (discountRate !== undefined && discountRate !== null && !isNonNegativeNumber(discountRate)) {
    return 'Invoice item discountRate must be a non-negative number'
  }
  return null
}

function invoicePayloadError(raw: unknown): string | null {
  const core = invoiceCoreError(raw)
  if (core) return core
  for (const item of (raw as { items: unknown[] }).items) {
    const problem = invoiceItemError(item)
    if (problem) return problem
  }
  return null
}

function journalEntryError(raw: unknown): string | null {
  if (!isRecord(raw)) return 'Every journal entry must be an object'
  if (!isNonEmptyString(raw.id)) return 'Every journal entry must carry a non-empty id'
  const id = raw.id
  if (!Array.isArray(raw.items)) return `Journal entry ${id} items must be an array`
  for (const item of raw.items) {
    if (!isRecord(item) || !isFiniteNumber(item.debit) || !isFiniteNumber(item.credit)) {
      return `Journal entry ${id} items must carry finite debit and credit amounts`
    }
  }
  if (!isFiniteNumber(raw.totalDebit) || !isFiniteNumber(raw.totalCredit)) {
    return `Journal entry ${id} totals must be finite numbers`
  }
  return null
}

function bankTransactionError(raw: unknown): string | null {
  if (!isRecord(raw)) return 'Every bank transaction must be an object'
  if (!isNonEmptyString(raw.id)) return 'Every bank transaction must carry a non-empty id'
  const id = raw.id
  if (typeof raw.date !== 'string' || typeof raw.description !== 'string') {
    return `Bank transaction ${id} must carry a date and a description`
  }
  if (!isFiniteNumber(raw.amount)) return `Bank transaction ${id} amount must be a finite number`
  if (typeof raw.reconciled !== 'boolean') {
    return `Bank transaction ${id} reconciled must be a boolean`
  }
  const links = raw.paymentLinks
  if (links === undefined || links === null) return null
  if (!Array.isArray(links)) return `Bank transaction ${id} paymentLinks must be an array`
  for (const link of links) {
    if (!isRecord(link) || !isNonEmptyString(link.paymentId)) {
      return `Bank transaction ${id} payment links must carry a payment id`
    }
    if (!isFiniteNumber(link.amount) || link.amount <= 0) {
      return `Bank transaction ${id} payment links must carry a positive amount`
    }
  }
  return null
}

function paymentError(raw: unknown): string | null {
  if (!isRecord(raw)) return 'Every payment must be an object'
  if (!isNonEmptyString(raw.id)) return 'Every payment must carry a non-empty id'
  const id = raw.id
  if (!isNonEmptyString(raw.partyId)) return `Payment ${id} must carry a non-empty partyId`
  if (typeof raw.date !== 'string') return `Payment ${id} date must be a string`
  const type = raw.type
  if (typeof type !== 'string' || !PAYMENT_TYPES.includes(type as Payment['type'])) {
    return `Payment ${id} type must be received, paid or refund`
  }
  if (!Array.isArray(raw.allocations) || raw.allocations.length === 0) {
    return `Payment ${id} allocations must be a non-empty array`
  }
  for (const allocation of raw.allocations) {
    if (!isRecord(allocation) || !isNonEmptyString(allocation.invoiceId)) {
      return `Payment ${id} allocations must carry an invoice id`
    }
    if (!isNonNegativeNumber(allocation.amount)) {
      return `Payment ${id} allocations must carry a non-negative amount`
    }
  }
  return null
}

function auditEntryError(raw: unknown): string | null {
  if (!isRecord(raw)) return 'Every audit entry must be an object'
  if (!isNonEmptyString(raw.id)) return 'Every audit entry must carry a non-empty id'
  if (typeof raw.timestamp !== 'string' || !isNonEmptyString(raw.action)) {
    return 'Every audit entry must carry a timestamp and an action'
  }
  if (typeof raw.summary !== 'string') return 'Every audit entry must carry a summary'
  return null
}

/**
 * Guard for the ledger payload of `books:save-data` — a stored envelope
 * satisfies the same shape. It rejects a payload whose structure could
 * corrupt the store and never repairs or mutates what it accepts.
 */
export function validateBooksData(raw: unknown): ValidationResult<BooksData> {
  if (!isRecord(raw)) return invalid('Ledger payload must be an object')
  if (!isRecord(raw.settings)) return invalid('Ledger payload must carry settings')
  const problem = settingsError(raw.settings)
  if (problem) return invalid(problem)
  for (const field of ['accounts', 'parties', 'invoices', 'journalEntries'] as const) {
    if (!Array.isArray(raw[field])) return invalid(`Ledger ${field} must be an array`)
  }

  for (const account of raw.accounts as unknown[]) {
    if (!isRecord(account)) return invalid('Every account must be an object')
    if (!isNonEmptyString(account.id)) return invalid('Every account must carry a non-empty id')
    if (!isFiniteNumber(account.balance)) {
      return invalid(`Account ${account.id} balance must be a finite number`)
    }
  }

  for (const party of raw.parties as unknown[]) {
    if (!isRecord(party)) return invalid('Every party must be an object')
    if (!isNonEmptyString(party.id)) return invalid('Every party must carry a non-empty id')
    if (!isFiniteNumber(party.outstandingBalance)) {
      return invalid(`Party ${party.id} outstandingBalance must be a finite number`)
    }
  }

  for (const invoice of raw.invoices as unknown[]) {
    const invoiceProblem = invoiceCoreError(invoice)
    if (invoiceProblem) return invalid(invoiceProblem)
  }

  for (const entry of raw.journalEntries as unknown[]) {
    const journalProblem = journalEntryError(entry)
    if (journalProblem) return invalid(journalProblem)
  }

  const bankTransactions = raw.bankTransactions
  if (bankTransactions !== undefined && bankTransactions !== null) {
    if (!Array.isArray(bankTransactions)) {
      return invalid('Ledger bankTransactions must be an array')
    }
    for (const transaction of bankTransactions) {
      const bankProblem = bankTransactionError(transaction)
      if (bankProblem) return invalid(bankProblem)
    }
  }

  const payments = raw.payments
  if (payments !== undefined && payments !== null) {
    if (!Array.isArray(payments)) return invalid('Ledger payments must be an array')
    for (const payment of payments) {
      const paymentProblem = paymentError(payment)
      if (paymentProblem) return invalid(paymentProblem)
    }
  }

  const auditLog = raw.auditLog
  if (auditLog !== undefined && auditLog !== null) {
    if (!Array.isArray(auditLog)) return invalid('Ledger auditLog must be an array')
    for (const entry of auditLog) {
      const entryProblem = auditEntryError(entry)
      if (entryProblem) return invalid(entryProblem)
    }
  }

  return { ok: true, value: raw as unknown as BooksData }
}

/** Guard for the `books:open-in-pdf` payload: a whole stored invoice. */
export function validateInvoicePayload(raw: unknown): ValidationResult<Invoice> {
  const problem = invoicePayloadError(raw)
  if (problem) return invalid(problem)
  return { ok: true, value: raw as Invoice }
}

/**
 * Guard for the CSV text of `books:export-to-sheets` and
 * `books:import-bank-statement-csv`: a non-empty string inside the explicit
 * character and UTF-8 byte caps.
 */
export function validateCsvString(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return invalid('CSV payload must be a string')
  if (!raw.trim()) return invalid('CSV payload must not be empty')
  if (raw.length > MAX_CSV_CHARS) {
    return invalid(`CSV payload exceeds the ${MAX_CSV_CHARS} character cap`)
  }
  if (utf8ByteLength(raw) > MAX_CSV_BYTES) {
    return invalid(`CSV payload exceeds the ${MAX_CSV_BYTES} byte cap`)
  }
  return { ok: true, value: raw }
}

/**
 * Guard for identifier arguments such as the `books:reconcile-transaction`
 * ids: a non-empty, control-character-free string inside the id length cap.
 */
export function validateNonEmptyString(raw: unknown, field: string): ValidationResult<string> {
  if (typeof raw !== 'string') return invalid(`${field} must be a string`)
  const value = raw.trim()
  if (!value) return invalid(`${field} must not be empty`)
  if (value.length > MAX_ID_CHARS) {
    return invalid(`${field} exceeds the ${MAX_ID_CHARS} character cap`)
  }
  if (hasControlChars(value)) return invalid(`${field} must not contain control characters`)
  return { ok: true, value }
}

/**
 * The structural rules a restore point's name has to satisfy: a plain file
 * name inside the backups directory, nothing that could address a path.
 */
function plainFileNameError(name: string): string | null {
  if (!name) return 'Backup name must not be empty'
  if (name.length > MAX_ID_CHARS) {
    return `Backup name exceeds the ${MAX_ID_CHARS} character cap`
  }
  if (name.includes('..')) return 'Backup name must not contain ".."'
  if (name.includes('/') || name.includes('\\')) {
    return 'Backup name must not contain path separators'
  }
  if (/^[a-zA-Z]:/.test(name)) return 'Backup name must not be an absolute path'
  return null
}

/** Guard for the `books:restore-backup` argument: a plain backup file name
 * (`books-backup-<timestamp>.json`) that cannot escape the backups directory.
 */
export function validateBackupName(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return invalid('Backup name must be a string')
  const name = raw.trim()
  const structural = plainFileNameError(name)
  if (structural) return invalid(structural)
  if (!BACKUP_NAME_PATTERN.test(name)) {
    return invalid('Backup name must match books-backup-<timestamp>.json')
  }
  return { ok: true, value: name }
}

/**
 * Guard for the `books:restore-backup` argument when it may also name one of
 * the pre-restore safety copies. The safety copies widen WHAT may be named,
 * never what a valid name is: every structural rule of `validateBackupName`
 * still applies, and wildcards are refused too, because a name that can only
 * ever stand for several files is not something this handler can resolve.
 */
export function validateRestoreName(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return invalid('Backup name must be a string')
  const name = raw.trim()
  const structural = plainFileNameError(name)
  if (structural) return invalid(structural)
  if (/[*?[\]]/.test(name)) return invalid('Backup name must not contain wildcards')
  if (BACKUP_NAME_PATTERN.test(name) || SAFETY_COPY_NAME_PATTERN.test(name)) {
    return { ok: true, value: name }
  }
  return invalid(
    'Backup name must match books-backup-<timestamp>.json or pre-restore-<timestamp>.json',
  )
}

/**
 * Guard for the `books:save-data` intent argument. Only the reason the save
 * channel can legitimately carry is accepted — deleting the user's last record
 * — and the object must carry nothing else, so this cannot become a general
 * "trust me" flag. A restore states its own reason inside the main process,
 * which is why it is not accepted here.
 */
export function validateSaveIntent(raw: unknown): ValidationResult<SaveIntent> {
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (!isRecord(raw)) return invalid('Save intent must be an object')
  const keys = Object.keys(raw)
  if (keys.length === 0) return { ok: true, value: {} }
  if (keys.some((key) => key !== 'emptyLedger')) {
    return invalid('Save intent carries an unrecognised field')
  }
  const reason = raw.emptyLedger
  if (reason === undefined || reason === null) return { ok: true, value: {} }
  if (reason !== 'user-deleted-last-record') {
    return invalid('Save intent must name a reason this channel may carry')
  }
  return { ok: true, value: { emptyLedger: reason } }
}

// --- Transport guards --------------------------------------------------------
// `ipcRenderer.invoke` resolves with `any`, so every result the renderer reads
// is typed by hope alone. These guards narrow a raw bridge reply to the
// declared contract: an unrecognised shape is reported as a failure the store
// can surface, never coerced into a success.

/** Guard for the `books:save-data` argument: the payload revision. */
export function validateRevision(raw: unknown): ValidationResult<number> {
  if (!isFiniteNumber(raw)) return invalid('Revision must be a finite number')
  if (!Number.isInteger(raw)) return invalid('Revision must be a whole number')
  if (raw < 0) return invalid('Revision must not be negative')
  return { ok: true, value: raw }
}

/** True for a stored envelope: the ledger plus its schema/updatedAt header. */
function isBooksDataEnvelope(raw: unknown): raw is BooksDataEnvelope {
  if (!isRecord(raw)) return false
  if (!isFiniteNumber(raw.version)) return false
  if (typeof raw.updatedAt !== 'string') return false
  if (!isRecord(raw.settings)) return false
  for (const field of ['accounts', 'parties', 'invoices', 'journalEntries'] as const) {
    if (!Array.isArray(raw[field])) return false
  }
  return true
}

/**
 * Narrows a bridge reply for `books:load-data` to `LoadDataResult`. Anything
 * unrecognised — including a bare `null`, a bare envelope or an envelope
 * without a revision (a pre-revision main process) — becomes the unreadable
 * variant, whose only safe handling is to refuse to write over the store.
 */
export function isLoadDataResult(raw: unknown): raw is LoadDataResult {
  if (!isRecord(raw)) return false
  if (typeof raw.ok !== 'boolean') return false
  if (raw.ok === true) {
    if (raw.readable === true) {
      return raw.data === null || isBooksDataEnvelope(raw.data)
    }
    if (raw.readable === false) {
      // The reason is optional, but when present it must be a useable string.
      return (
        raw.data === null &&
        (raw.error === undefined || isNonEmptyString(raw.error)) &&
        (raw.forensicPath === undefined || isNonEmptyString(raw.forensicPath))
      )
    }
    return false
  }
  return raw.data === null && isNonEmptyString(raw.error)
}

/** Narrows a bridge reply for `books:save-data` to `SaveDataResult`. */
export function isSaveDataResult(raw: unknown): raw is SaveDataResult {
  if (!isRecord(raw)) return false
  if (raw.ok === true) return isFiniteNumber(raw.revision) && raw.revision >= 0
  if (raw.ok !== false) return false
  if (!isNonEmptyString(raw.error)) return false
  if (raw.conflict !== undefined && raw.conflict !== true) return false
  if (raw.current !== undefined && !isBooksDataEnvelope(raw.current)) return false
  return true
}

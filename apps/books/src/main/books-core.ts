/**
 * apps/books/src/main/books-core.ts
 *
 * Pure books-core: the ledger-first migration/normalization engine and the
 * single posting path for sales invoices created outside the Books renderer
 * (CRM won-deals, Tenders milestones). Zero electron imports — only node
 * builtins (fs/path/crypto) and the shared accounting/chart modules, so plain
 * Node tooling (e.g. `npx tsx tools/verify-suite-workflows.mjs`) can import
 * and exercise the REAL posting logic instead of a duplicated copy.
 *
 * The settlement engines (bank import, settlement suggestions, 1-click
 * reconciliation) live in the pure shared module `../shared/settlement`; the
 * thin wrappers below only own the ledger read-modify-write around them.
 *
 * books-main.ts imports everything from here and re-exports it, so all
 * existing consumers (crm-main, tenders-main, tests) keep working unchanged.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  round2,
  createSalesInvoiceJournal,
  createOpeningJournal,
  accountsMatchJournals,
  nextInvoiceNumber,
} from '../shared/accounting'
import { applyBankStatementImport, applyReconciliation, deriveLedger } from '../shared/settlement'
import type { BankStatementImportResult, ReconciliationCoreResult } from '../shared/settlement'
import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../shared/chart'
import { appendAudit, createAuditEntry } from '../shared/audit'
import { isDateLocked } from '../shared/closing'
import { MAX_AUDIT_ENTRIES } from '../shared/audit'
import type { EmptyLedgerReason } from '../shared/ipc'
import type {
  Account,
  AuditEntry,
  BankTransaction,
  BooksData,
  BooksDataEnvelope,
  CompanySettings,
  Invoice,
  JournalEntry,
  Party,
  Payment,
  PaymentAllocation,
} from '../shared/types'

export { computeSettlementSuggestions } from '../shared/settlement'
export type { BankStatementImportResult, ReconciliationCoreResult } from '../shared/settlement'

export const CURRENT_BOOKS_SCHEMA_VERSION = 1

/**
 * Every schema version this build knows how to READ, oldest first. A stored
 * version must appear here; anything else is refused rather than carried
 * forward, because a file written by a different build can hold fields (and
 * invariants) this one would silently drop on the next write.
 *
 * Version 0 is the pre-ledger format: account balances with no journals, which
 * `normalizeLedger` migrates forward by synthesizing an opening entry. It is
 * listed because this build really does read it, and payloads carrying it are
 * read and then written at the current version.
 */
export const BOOKS_SCHEMA_MIGRATIONS = [0, 1] as const

/** The oldest version the registry above covers; below it, data predates the ledger. */
export const OLDEST_BOOKS_SCHEMA_VERSION = BOOKS_SCHEMA_MIGRATIONS[0]

/**
 * Thrown when a payload was written by a newer schema than this build
 * supports. Destructive callers catch it; the IPC layer reports it.
 */
export class UnsupportedBooksSchemaError extends Error {
  readonly version: number

  constructor(version: number) {
    super(
      `Books data was written by a newer version of Zano Books (schema ${version}, this build supports up to ${CURRENT_BOOKS_SCHEMA_VERSION}). Update the app before opening it.`,
    )
    this.name = 'UnsupportedBooksSchemaError'
    this.version = version
  }
}

/**
 * Thrown when the version field is present but is not a version this app ever
 * wrote (`1.9`, `"2"`, `null`, `true`, `-5`). Distinct from
 * `UnsupportedBooksSchemaError` — a newer schema is a future format, whereas
 * this is not a format at all — but refused for the same reason: re-stamping it
 * as the current version would drop whatever it meant and hand the truncated
 * ledger back to be written over the original.
 */
export class InvalidBooksSchemaVersionError extends Error {
  readonly declaredVersion: unknown

  constructor(declaredVersion: unknown) {
    super(
      `Books data declares an unrecognised schema version (${describeVersion(declaredVersion)}). This build reads schema ${BOOKS_SCHEMA_MIGRATIONS.join(', ')}.`,
    )
    this.name = 'InvalidBooksSchemaVersionError'
    this.declaredVersion = declaredVersion
  }
}

/** A short, always-readable rendering of an untrusted version value. */
function describeVersion(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value)
  return Object.prototype.toString.call(value)
}

/** True for a version this build can read: an integer in the migration registry. */
export function isSupportedBooksSchemaVersion(version: unknown): version is number {
  return (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    (BOOKS_SCHEMA_MIGRATIONS as readonly number[]).includes(version)
  )
}

/** Entry-number prefix marking a synthesized/opening-balances journal entry. */
export const OPENING_JOURNAL_PREFIX = 'JE-OPENING'

/**
 * Recomputes account balances strictly from journal entries and party
 * balances from open invoices. No migration/synthesis — call this on live
 * data that has just been mutated. Delegates the derivation to the shared
 * settlement module so the renderer derives balances exactly the same way.
 */
export function recomputeLedger(data: BooksDataEnvelope): BooksDataEnvelope {
  return {
    ...deriveLedger(data),
    version: data.version ?? CURRENT_BOOKS_SCHEMA_VERSION,
    revision: data.revision ?? 0,
    updatedAt: data.updatedAt || new Date().toISOString(),
  }
}

/**
 * Ledger-first normalization for raw/on-disk payloads: synthesizes a balanced
 * opening-balances journal entry when the stored balances cannot be derived
 * from the existing journals (true legacy data), then recomputes every
 * balance from journals. Idempotent — once balances are journal-derived the
 * synthesis never fires again.
 */
export function normalizeLedger(data: BooksDataEnvelope): BooksDataEnvelope {
  const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((a) => ({ ...a }))
  const journalEntries = Array.isArray(data.journalEntries) ? [...data.journalEntries] : []

  const hasOpening = journalEntries.some((je) =>
    String(je.entryNumber || '').startsWith(OPENING_JOURNAL_PREFIX),
  )
  const balancesMatchJournals = accountsMatchJournals(accounts, journalEntries)
  if (!hasOpening && !balancesMatchJournals) {
    const hasBalances = accounts.some((a) => !a.isGroup && round2(a.balance || 0) !== 0)
    if (hasBalances) {
      const opening = createOpeningJournal(accounts, {
        date: data.settings?.financialYearStart || undefined,
      })
      journalEntries.unshift(opening)
    }
  }

  return recomputeLedger({ ...data, journalEntries })
}

export function migrateAndValidateBooks(raw: unknown): BooksDataEnvelope {
  const now = new Date().toISOString()
  if (!raw || typeof raw !== 'object') {
    return {
      version: CURRENT_BOOKS_SCHEMA_VERSION,
      revision: 0,
      updatedAt: now,
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
      payments: [],
      auditLog: [],
    }
  }

  const r = raw as Record<string, unknown>
  // An absent version is a pre-versioning payload (stamped with the current
  // one). Any version that IS present must be one this build can read: a
  // version above this build's means a newer writer, and `1.9`, `"2"`, `null`,
  // `true` or `-5` are not schema versions at all. Both are refused, because
  // normalizing them would drop whatever that writer meant and hand the
  // truncated ledger back to be written over the original.
  const declaredVersion = r.version
  if (declaredVersion !== undefined && !isSupportedBooksSchemaVersion(declaredVersion)) {
    if (
      typeof declaredVersion === 'number' &&
      Number.isInteger(declaredVersion) &&
      declaredVersion > CURRENT_BOOKS_SCHEMA_VERSION
    ) {
      throw new UnsupportedBooksSchemaError(declaredVersion)
    }
    throw new InvalidBooksSchemaVersionError(declaredVersion)
  }
  // A supported version is read and migrated forward: everything this function
  // returns is stamped with the version it will be written as.
  const version = CURRENT_BOOKS_SCHEMA_VERSION
  const revision =
    typeof r.revision === 'number' && Number.isFinite(r.revision) && r.revision >= 0
      ? Math.trunc(r.revision)
      : 0
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt.trim() ? r.updatedAt : now

  const settings: CompanySettings =
    r.settings && typeof r.settings === 'object'
      ? { ...DEFAULT_BOOK_SETTINGS, ...(r.settings as Partial<CompanySettings>) }
      : { ...DEFAULT_BOOK_SETTINGS }

  const existingAccounts: Account[] = Array.isArray(r.accounts) ? (r.accounts as Account[]) : []
  const accountsMap = new Map<string, Account>()
  for (const acc of existingAccounts) {
    if (acc && typeof acc.id === 'string') {
      accountsMap.set(acc.id, {
        ...acc,
        balance: typeof acc.balance === 'number' && Number.isFinite(acc.balance) ? acc.balance : 0,
      })
    }
  }

  for (const core of EMPTY_ACCOUNTS) {
    if (!accountsMap.has(core.id)) {
      accountsMap.set(core.id, { ...core })
    } else {
      const existing = accountsMap.get(core.id)!
      if (existing.parentId === undefined) existing.parentId = core.parentId
      if (existing.isGroup === undefined) existing.isGroup = core.isGroup
      if (!existing.rootType) existing.rootType = core.rootType
      if (!existing.accountType) existing.accountType = core.accountType
      if (!existing.name) existing.name = core.name
    }
  }

  // VAT Input is an asset-side receivable from SARS, never a liability.
  const vatIn = accountsMap.get('acc-vat-in')
  if (vatIn) {
    vatIn.rootType = 'Asset'
    vatIn.accountType = 'Tax'
    vatIn.parentId = 'acc-curr-asset'
    vatIn.isGroup = false
  }

  const accounts = Array.from(accountsMap.values())

  const rawParties = Array.isArray(r.parties) ? (r.parties as Party[]) : []
  const parties: Party[] = rawParties
    .filter((p) => p && typeof p.id === 'string')
    .map((p) => ({
      ...p,
      outstandingBalance: round2(p.outstandingBalance),
    }))

  const rawInvoices = Array.isArray(r.invoices) ? (r.invoices as Invoice[]) : []
  const invoices: Invoice[] = rawInvoices
    .filter((inv) => inv && typeof inv.id === 'string')
    .map((inv) => ({
      ...inv,
      subtotal: round2(inv.subtotal),
      taxTotal: round2(inv.taxTotal),
      grandTotal: round2(inv.grandTotal),
      outstandingAmount: round2(inv.outstandingAmount),
    }))

  const rawJournals = Array.isArray(r.journalEntries) ? (r.journalEntries as JournalEntry[]) : []
  const journalEntries: JournalEntry[] = rawJournals
    .filter((je) => je && typeof je.id === 'string')
    .map((je) => ({
      ...je,
      totalDebit: round2(je.totalDebit),
      totalCredit: round2(je.totalCredit),
      items: Array.isArray(je.items)
        ? je.items.map((item) => ({
            ...item,
            debit: round2(item.debit),
            credit: round2(item.credit),
          }))
        : [],
    }))

  const rawBankTx = Array.isArray(r.bankTransactions) ? r.bankTransactions : []
  const bankTransactions: BankTransaction[] = []
  for (const item of rawBankTx) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as any).id === 'string' &&
      typeof (item as any).date === 'string' &&
      typeof (item as any).description === 'string' &&
      typeof (item as any).amount === 'number' &&
      Number.isFinite((item as any).amount) &&
      typeof (item as any).reconciled === 'boolean'
    ) {
      // Spread all fields first to preserve extension fields (e.g. swiftMessageId, customRef),
      // then overlay validated known fields with normalised values.
      bankTransactions.push({
        ...(item as any),
        id: (item as any).id,
        accountId: 'acc-bank',
        date: (item as any).date,
        description: (item as any).description,
        reference: typeof (item as any).reference === 'string' ? (item as any).reference : '',
        amount: round2((item as any).amount),
        reconciled: (item as any).reconciled,
        matchedInvoiceId:
          typeof (item as any).matchedInvoiceId === 'string'
            ? (item as any).matchedInvoiceId
            : undefined,
        reconciledAt:
          typeof (item as any).reconciledAt === 'string' ? (item as any).reconciledAt : undefined,
        paymentLinks: Array.isArray((item as any).paymentLinks)
          ? (item as any).paymentLinks
              .filter(
                (link: any) =>
                  link &&
                  typeof link.paymentId === 'string' &&
                  typeof link.amount === 'number' &&
                  Number.isFinite(link.amount) &&
                  link.amount > 0,
              )
              .map((link: any) => ({
                paymentId: link.paymentId,
                amount: round2(link.amount),
                invoiceId: typeof link.invoiceId === 'string' ? link.invoiceId : undefined,
              }))
          : undefined,
      })
    }
  }

  const rawPayments = Array.isArray(r.payments) ? r.payments : []
  const payments: Payment[] = []
  for (const item of rawPayments) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    if (
      typeof p.id !== 'string' ||
      typeof p.partyId !== 'string' ||
      typeof p.date !== 'string' ||
      (p.type !== 'received' && p.type !== 'paid' && p.type !== 'refund') ||
      !Array.isArray(p.allocations)
    ) {
      continue
    }
    // Sanitize allocations: keep only entries with a valid invoiceId and a
    // finite amount (rounded), then derive total strictly from allocations so
    // payment.total always equals the sum of its allocations.
    const allocations: PaymentAllocation[] = []
    for (const rawAlloc of p.allocations) {
      if (!rawAlloc || typeof rawAlloc !== 'object') continue
      const a = rawAlloc as Record<string, unknown>
      if (typeof a.invoiceId !== 'string') continue
      allocations.push({
        invoiceId: a.invoiceId,
        invoiceNumber: typeof a.invoiceNumber === 'string' ? a.invoiceNumber : a.invoiceId,
        amount: round2(Number(a.amount) || 0),
      })
    }
    if (allocations.length === 0) continue
    payments.push({
      id: p.id,
      partyId: p.partyId,
      partyName: typeof p.partyName === 'string' ? p.partyName : '',
      date: p.date,
      type: p.type as Payment['type'],
      method: typeof p.method === 'string' ? p.method : undefined,
      reference: typeof p.reference === 'string' ? p.reference : undefined,
      allocations,
      total: round2(allocations.reduce((s, a) => s + a.amount, 0)),
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : now,
    })
  }

  const rawAudit = Array.isArray(r.auditLog) ? r.auditLog : []
  const auditLog: AuditEntry[] = []
  for (const item of rawAudit) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (
      typeof e.id !== 'string' ||
      typeof e.timestamp !== 'string' ||
      Number.isNaN(Date.parse(e.timestamp)) ||
      new Date(e.timestamp).toISOString() !== e.timestamp ||
      typeof e.action !== 'string' ||
      typeof e.summary !== 'string'
    ) {
      continue
    }
    auditLog.push({
      id: e.id,
      timestamp: e.timestamp,
      action: e.action,
      summary: e.summary,
      actor: typeof e.actor === 'string' ? e.actor : undefined,
      invoiceNumber: typeof e.invoiceNumber === 'string' ? e.invoiceNumber : undefined,
      paymentId: typeof e.paymentId === 'string' ? e.paymentId : undefined,
      amount:
        typeof e.amount === 'number' && Number.isFinite(e.amount) ? round2(e.amount) : undefined,
    })
  }
  // Normalize untrusted input order before capping: newest-first, then keep
  // only the recent history so a reordered backup cannot evict new entries.
  const cappedAuditLog = auditLog
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_AUDIT_ENTRIES)

  const envelope: BooksDataEnvelope = {
    version,
    revision,
    updatedAt,
    settings,
    accounts,
    parties,
    invoices,
    journalEntries,
    bankTransactions,
    payments,
    auditLog: cappedAuditLog,
  }

  // Ledger-first: balances are always derived from journals, never stored.
  return normalizeLedger(envelope)
}

/** A fresh, empty ledger — first-run state before the setup wizard runs. */
export function createEmptyBooksEnvelope(): BooksDataEnvelope {
  return {
    version: CURRENT_BOOKS_SCHEMA_VERSION,
    revision: 0,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_BOOK_SETTINGS },
    accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a })),
    parties: [],
    invoices: [],
    journalEntries: [],
    bankTransactions: [],
    payments: [],
    auditLog: [],
  }
}

/** The store file name every books path is addressed by. */
export const BOOKS_STORE_FILENAME = 'books-data.json'

/** Resolves a caller's base directory or file path to the store file path. */
export function booksStorePath(baseDirOrPath: string): string {
  return baseDirOrPath.endsWith(BOOKS_STORE_FILENAME)
    ? baseDirOrPath
    : join(baseDirOrPath, BOOKS_STORE_FILENAME)
}

/**
 * True when the path is the store file itself. The watcher uses it so a
 * forensic copy, a safety copy or a `.tmp` file it just wrote cannot be
 * mistaken for a ledger change (which used to feed a self-sustaining loop).
 */
export function isBooksStoreFile(candidate: string, storePath: string): boolean {
  const name = candidate.replace(/[/\\]/g, '/').split('/').pop() || ''
  return name === booksStorePath(storePath).replace(/[/\\]/g, '/').split('/').pop()
}

/** Why a store read could not produce a ledger. */
export type BooksStoreReadFailureKind = 'io' | 'corrupt' | 'unsupported-schema'

export interface BooksStoreReadFailure {
  ok: false
  kind: BooksStoreReadFailureKind
  error: string
  /** Present when the bytes were readable: the content-hashed forensic copy. */
  forensicPath?: string
}

export interface BooksStoreReadSuccess {
  ok: true
  /** null when no store exists yet — the genuine first-run case. */
  data: BooksDataEnvelope | null
}

export type BooksStoreReadResult = BooksStoreReadSuccess | BooksStoreReadFailure

function storeSiblingName(filePath: string, sibling: string): string {
  return filePath ? `${filePath}.${sibling}` : sibling
}

/** Stable name for the forensic copy of one distinct corrupt payload. */
function forensicCopyName(filePath: string, contentHash: string): string {
  return storeSiblingName(filePath, `corrupt-${contentHash.slice(0, 16)}`)
}

function writeFileAtomic(targetPath: string, content: string): void {
  const tmp = `${targetPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, targetPath)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    throw err
  }
}

/**
 * Writes the forensic copies for a corrupt store ONCE per distinct payload:
 * a content-addressed `<file>.corrupt-<hash>` plus the legacy
 * `<file>.corrupted.bak` (kept because existing tooling and tests look for
 * it). Re-reading the same broken bytes therefore adds no files, which is
 * what stops the forensic/watcher amplification loop.
 */
function writeForensicCopies(filePath: string, content: string): string {
  const hash = createHash('sha256').update(content).digest('hex')
  const forensics = forensicCopyName(filePath, hash)
  const legacy = storeSiblingName(filePath, 'corrupted.bak')
  try {
    if (!existsSync(forensics)) writeFileAtomic(forensics, content)
    if (!existsSync(legacy)) writeFileAtomic(legacy, content)
  } catch (err) {
    console.error('books-main: failed to write corrupt-store forensic copy', err)
  }
  return forensics
}

/**
 * A payload that can be read as a ledger: a plain object carrying the two core
 * arrays. `migrateAndValidateBooks` cannot gate on this — it is a
 * never-throwing normalizer that turns anything into a ledger — so every path
 * that reads bytes from disk checks the shape FIRST. A valid-JSON file that is
 * not one (null, [], a string, an object without the arrays) is not an empty
 * ledger: normalizing it would produce one, and the next save would write that
 * empty ledger over the user's books.
 */
export function isBooksLedgerShape(raw: unknown): boolean {
  return Boolean(
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Array.isArray((raw as { accounts?: unknown }).accounts) &&
    Array.isArray((raw as { invoices?: unknown }).invoices),
  )
}

/**
 * Strict store read: distinguishes a genuinely absent file (first run) from a
 * file that is present but unreadable. The absence distinction is the whole
 * point — an I/O error, corrupt bytes or valid JSON that is not a ledger must
 * never be reported as an empty ledger, because the next ordinary save would
 * then write that empty ledger over the user's real books. Every unreadable
 * payload that really was bytes keeps a forensic copy of those bytes.
 */
export function readBooksStoreStrict(
  baseDirOrPath: string,
  options: { forensic?: boolean } = {},
): BooksStoreReadResult {
  const filePath = booksStorePath(baseDirOrPath)
  if (!existsSync(filePath)) return { ok: true, data: null }

  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (err: any) {
    return {
      ok: false,
      kind: 'io',
      error: `The books file could not be read (${err?.message || 'unknown I/O error'})`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err: any) {
    const forensicPath =
      options.forensic === false ? undefined : writeForensicCopies(filePath, content)
    return {
      ok: false,
      kind: 'corrupt',
      error: `The books file is not valid JSON (${err?.message || 'parse error'})`,
      forensicPath,
    }
  }

  // Valid JSON is not a ledger. `null`, `[]`, a string, a number, an object
  // without the arrays and an object whose arrays are the wrong type all used
  // to load as `readable: true` with an empty envelope — and the next save
  // overwrote the file with that empty ledger, with no copy of the original.
  if (!isBooksLedgerShape(parsed)) {
    const forensicPath =
      options.forensic === false ? undefined : writeForensicCopies(filePath, content)
    return {
      ok: false,
      kind: 'corrupt',
      error: 'The books file is not a books ledger (missing accounts/invoices)',
      forensicPath,
    }
  }

  try {
    return { ok: true, data: migrateAndValidateBooks(parsed) }
  } catch (err: any) {
    if (
      err instanceof UnsupportedBooksSchemaError ||
      err instanceof InvalidBooksSchemaVersionError
    ) {
      return { ok: false, kind: 'unsupported-schema', error: err.message }
    }
    throw err
  }
}

/**
 * Lenient store read: the ledger if one can be produced, otherwise a fresh
 * empty envelope. Read paths that only ever DISPLAY data may use this; every
 * path that writes must use `readBooksStoreStrict` (or the serialized
 * mutations below) so an unreadable store can never be overwritten.
 */
export function readBooksStore(baseDirOrPath: string): BooksDataEnvelope {
  const result = readBooksStoreStrict(baseDirOrPath)
  if (result.ok) return result.data ?? createEmptyBooksEnvelope()
  console.error(`books-main: could not read books store ${baseDirOrPath}:`, result.error)
  return createEmptyBooksEnvelope()
}

/**
 * Optional observer notified with the validated JSON after every successful
 * atomic store write. books-main registers it to keep its lastBroadcastJson
 * cache in sync (internal writes must suppress redundant watcher broadcasts);
 * pure/headless consumers simply leave it unset.
 */
let storeWriteObserver: ((json: string) => void) | undefined

export function setStoreWriteObserver(fn: ((json: string) => void) | undefined): void {
  storeWriteObserver = fn
}

/** What one write means for the ledger it replaces. */
export interface BooksWriteIntent {
  /**
   * The revision the writer believes is on disk. When it lags the stored
   * revision another writer won the race, so the write is refused instead of
   * silently discarding their ledger — and the refusal carries the stored
   * ledger, so the client can adopt it and write again from that revision.
   *
   * This argument is the ONLY authority on what the writer had seen: the
   * payload's own `revision` field is data, never a cursor (a client that just
   * adopted the ledger a conflict returned carries that ledger's revision, and
   * treating it as a claim about its snapshot would let the next write pass
   * unnoticed while the file kept moving).
   */
  expectedRevision?: number
  /**
   * The writer's explicit statement that this write is MEANT to leave the
   * books with no invoices and no journal entries. Only the two reasons in
   * `EmptyLedgerReason` exist, and each names a user action that was confirmed
   * before the write: deleting the last record from the books, or restoring a
   * deliberately empty backup.
   *
   * Emptying the books is refused without it, and it is only honoured together
   * with `expectedRevision`, so a writer that did not see the books it would be
   * emptying is refused by the revision check instead. The reason is consulted
   * only when the write really does empty the books, so passing it alongside an
   * ordinary write changes nothing.
   */
  emptyLedger?: EmptyLedgerReason
}

/**
 * The outcome of one write. A refusal carries `conflict` and the stored ledger
 * when the writer lost an optimistic-revision race: the client must refresh
 * from `current` rather than retry blindly.
 */
export type BooksWriteOutcome =
  | { ok: true; revision: number }
  | { ok: false; error: string; conflict?: true; current?: BooksDataEnvelope }

/** Sentinel distinguishing "no store yet" from "the store could not be read". */
const UNREADABLE = Symbol('books-store-unreadable')

/** The stored ledger, null when absent, or UNREADABLE when it cannot be read. */
function readStoredForWrite(filePath: string): BooksDataEnvelope | null | typeof UNREADABLE {
  const read = readBooksStoreStrict(filePath, { forensic: false })
  if (!read.ok) {
    console.error(`books-main: refusing to write over an unreadable store: ${read.error}`)
    return UNREADABLE
  }
  return read.data
}

/** Counts the records a shrink guard protects: the ledger-of-record kinds. */
export function ledgerRecordCount(data: BooksDataEnvelope): number {
  return (data.invoices?.length || 0) + (data.journalEntries?.length || 0)
}

/** One record of the two ledger-of-record kinds, as sent by a caller. */
function isIdentifiedRecord(entry: unknown): boolean {
  return Boolean(
    entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string',
  )
}

/**
 * The record count of what the caller actually sent, judged on what the
 * MIGRATION WOULD KEEP: `migrateAndValidateBooks` drops an invoice or journal
 * without a string `id`, so counting the raw arrays let a payload of decoys
 * pass the shrink guard while the write emptied the file. The opening journal
 * `normalizeLedger` synthesizes is excluded too — it is not a record anybody
 * entered, so "delete everything" must not look like a one-record write just
 * because the empty payload legitimately carried account balances.
 */
function sentLedgerRecordCount(data: unknown): number {
  const raw = (data ?? {}) as { invoices?: unknown; journalEntries?: unknown }
  const kept = (value: unknown) =>
    Array.isArray(value) ? value.filter(isIdentifiedRecord).length : 0
  const journals = Array.isArray(raw.journalEntries)
    ? raw.journalEntries.filter(
        (entry) =>
          isIdentifiedRecord(entry) &&
          !String((entry as { entryNumber?: unknown }).entryNumber || '').startsWith(
            OPENING_JOURNAL_PREFIX,
          ),
      ).length
    : 0
  return kept(raw.invoices) + journals
}

/**
 * The refusal shown when an empty write would replace populated books. It is
 * read by a person, so it says what happened, that nothing was written, and
 * what to do next — never the record arithmetic the guard works with.
 */
function emptyReplacementRefusal(storedRecords: number): string {
  const records =
    storedRecords === 1
      ? '1 invoice or journal entry'
      : `${storedRecords} invoices and journal entries`
  return (
    `Nothing was saved: this change would have emptied your books, removing ${records}. ` +
    `Reload the books to see the data that is really there, then delete the records you meant to remove.`
  )
}

/**
 * The rule that keeps an ACCIDENTAL write from replacing a populated ledger
 * with an empty one, shared by the serialized writer and the restore engine so
 * neither can empty the books on its own.
 *
 * `emptyLedgerReason` is the caller's explicit statement that emptying the
 * books is the point of this write (see `EmptyLedgerReason`); the deliberate
 * callers — the user's delete of their last record, and a restore of an empty
 * backup — are the only ones that pass it. Everything else is refused, which is
 * what stops a payload whose records the migration would drop from wiping a
 * ledger that looked populated on the way in.
 */
export function mayReplaceLedger(
  stored: BooksDataEnvelope | null,
  incomingRecordCount: number,
  options: { emptyLedgerReason?: EmptyLedgerReason } = {},
): { ok: true } | { ok: false; error: string } {
  if (!stored) return { ok: true }
  const storedRecords = ledgerRecordCount(stored)
  if (storedRecords === 0 || incomingRecordCount > 0) return { ok: true }
  if (options.emptyLedgerReason) return { ok: true }
  return { ok: false, error: emptyReplacementRefusal(storedRecords) }
}

function staleWriteError(expectedRevision: number, storedRevision: number): string {
  return `Your books changed elsewhere while you were working (revision ${storedRevision} on disk, ${expectedRevision} sent). Nothing was saved; reload to see the newer books and apply your change again.`
}

/**
 * One queued write: validates, applies the intent guards against the file it
 * is about to replace, takes the pre-overwrite safety copy and commits
 * atomically with the next revision number.
 */
function commitBooksStore(
  filePath: string,
  data: unknown,
  options: BooksWriteIntent = {},
): BooksWriteOutcome {
  const validated = migrateAndValidateBooks(data)
  // The guard must judge what the CALLER sent, not the migrated ledger:
  // normalizeLedger synthesizes an opening journal for a payload that emptied
  // the accounts, which would otherwise make "delete everything" look like a
  // one-record write.
  const sentRecordCount = sentLedgerRecordCount(data)

  // Always read: the revision this write continues and the safety copy come
  // from what is really on disk right now.
  const stored = readStoredForWrite(filePath)
  if (stored === UNREADABLE) {
    return { ok: false, error: 'Refusing to overwrite books that could not be read' }
  }

  // A stale writer is REFUSED, not merged. Merging two competing ledgers cannot
  // be made safe — it silently dropped the newer writer's payments, bank lines,
  // parties and audit trail, reverted their edits to a shared invoice, and even
  // resurrected records they had deleted — so the stale write is rejected whole
  // and handed the ledger it lost the race against.
  if (
    stored &&
    options.expectedRevision !== undefined &&
    stored.revision > options.expectedRevision
  ) {
    return {
      ok: false,
      conflict: true,
      error: staleWriteError(options.expectedRevision, stored.revision),
      current: stored,
    }
  }

  // What the writer declared this write MEANS to do — honoured only together
  // with the revision it is acting on, so a client that did not see the books
  // it would be emptying is still refused by the staleness check above.
  const allowed = mayReplaceLedger(stored, sentRecordCount, {
    emptyLedgerReason: options.expectedRevision === undefined ? undefined : options.emptyLedger,
  })
  if (!allowed.ok) return { ok: false, error: allowed.error }

  // The safety copy is written by the same code that replaces the file, so a
  // caller cannot forget it: one generation, atomically, before the rename.
  if (stored && ledgerRecordCount(stored) > 0) {
    try {
      writeFileAtomic(storeSiblingName(filePath, 'bak'), JSON.stringify(stored, null, 2))
    } catch (err) {
      console.error('books-main: failed to write the pre-overwrite safety copy', err)
    }
  }

  const next: BooksDataEnvelope = { ...validated, revision: (stored?.revision ?? 0) + 1 }
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  try {
    writeFileAtomic(filePath, JSON.stringify(next, null, 2))
  } catch (e) {
    console.error('books-main: failed to atomically write books store', filePath, e)
    throw e
  }
  storeWriteObserver?.(JSON.stringify(next))

  return { ok: true, revision: next.revision }
}

/**
 * Serialization of every read-modify-write on one store path.
 *
 * There is exactly one main process, so a module-level chain is enough to make
 * the whole read → mutate → write sequence atomic with respect to every other
 * writer in it (the renderer's save, CRM won-deal invoicing, Tenders milestone
 * billing, bank import, reconciliation). Without it two writers both read
 * revision N, both compute `INV-2026-001` and the second write silently
 * discards the first invoice.
 */
const storeWriteQueue = new Map<string, Promise<unknown>>()

function enqueueStoreWrite<T>(baseDirOrPath: string, task: () => Promise<T> | T): Promise<T> {
  const key = booksStorePath(baseDirOrPath)
  const previous = storeWriteQueue.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  storeWriteQueue.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/**
 * The ONE way a main-process caller performs a read-modify-write on the
 * ledger: `fn` receives the stored ledger (null on a genuine first run) and
 * returns the ledger to persist, or `{ abort }` to leave the store untouched
 * (a ledger that is present but unreadable always aborts).
 */
export async function mutateBooksStore<T>(
  baseDirOrPath: string,
  fn: (
    current: BooksDataEnvelope | null,
  ) =>
    | { data: BooksData }
    | { data: BooksData; intent?: BooksWriteIntent }
    | { abort: string }
    | { abort: string; kind: BooksStoreReadFailureKind },
  options: BooksWriteIntent = {},
): Promise<BooksWriteOutcome & { value?: T }> {
  return enqueueStoreWrite(baseDirOrPath, () => {
    const filePath = booksStorePath(baseDirOrPath)
    const read = readBooksStoreStrict(filePath)
    if (!read.ok) return { ok: false as const, error: read.error }

    let produced: { data?: BooksData; abort?: string; intent?: BooksWriteIntent }
    try {
      produced = fn(read.data)
    } catch (err: any) {
      return { ok: false as const, error: err?.message || 'Failed to update the books store' }
    }
    if (produced.abort !== undefined) return { ok: false as const, error: produced.abort }
    if (!produced.data) return { ok: false as const, error: 'No ledger was produced' }

    return commitBooksStore(filePath, produced.data, {
      ...options,
      ...produced.intent,
    })
  })
}

/**
 * Queued, guarded store write for callers that already hold the ledger they
 * want persisted. Serialized against every other books writer in the process.
 */
export function writeBooksStoreAsync(
  baseDirOrPath: string,
  data: unknown,
  options: BooksWriteIntent = {},
): Promise<BooksWriteOutcome> {
  return enqueueStoreWrite(baseDirOrPath, () =>
    commitBooksStore(booksStorePath(baseDirOrPath), data, options),
  )
}

/** The reason a synchronous write could not produce a ledger. */
export class BooksWriteRefusedError extends Error {
  readonly conflict: boolean
  readonly current?: BooksDataEnvelope

  constructor(outcome: { error: string; conflict?: boolean; current?: BooksDataEnvelope }) {
    super(outcome.error)
    this.name = 'BooksWriteRefusedError'
    this.conflict = outcome.conflict === true
    this.current = outcome.current
  }
}

/**
 * Synchronous store write for pure/headless callers (tools, tests) and for
 * the write half of a synchronous mutation. It goes through the same guards
 * and safety copy as the async path; it only skips waiting on the queue,
 * which a synchronous caller cannot do.
 */
export function writeBooksStore(
  baseDirOrPath: string,
  data: unknown,
  options: BooksWriteIntent = {},
): BooksWriteOutcome {
  return commitBooksStore(booksStorePath(baseDirOrPath), data, options)
}

/**
 * What a queued mutation hands back to the writer.
 *
 * `unchanged` is the explicit "this operation changed nothing" answer: the
 * ledger it read is left alone, so a no-op never bumps the revision, rotates
 * the safety copy or tells every other client the books moved.
 */
type BooksMutationProduct<T> =
  | { data: BooksData; value?: T; intent?: BooksWriteIntent }
  | { abort: string }
  | { unchanged: true; value: T }

/**
 * Reads, mutates and persists the ledger atomically with respect to every
 * other books writer in the process. Synchronous, so the tools and tests that
 * drive the pure core keep their existing call shape.
 */
export function mutateBooksStoreSync<T>(
  baseDirOrPath: string,
  fn: (current: BooksDataEnvelope | null) => BooksMutationProduct<T>,
  options: BooksWriteIntent = {},
):
  | { ok: true; value: T; revision: number }
  | { ok: false; error: string; conflict?: true; current?: BooksDataEnvelope } {
  const filePath = booksStorePath(baseDirOrPath)
  const read = readBooksStoreStrict(filePath)
  if (!read.ok) return { ok: false, error: read.error }

  let produced: BooksMutationProduct<T>
  try {
    produced = fn(read.data)
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to update the books store' }
  }
  if ('abort' in produced) return { ok: false, error: produced.abort }
  if ('unchanged' in produced) {
    return { ok: true, value: produced.value, revision: read.data?.revision ?? 0 }
  }
  if (!produced.data) return { ok: false, error: 'No ledger was produced' }

  const outcome = commitBooksStore(filePath, produced.data, {
    ...options,
    ...produced.intent,
  })
  return outcome.ok ? { ok: true, value: produced.value as T, revision: outcome.revision } : outcome
}

export interface IssueSalesInvoiceInput {
  booksDataPath: string
  partyName: string
  itemDescription: string
  /** VAT-inclusive target amount (grandTotal ≈ amount). */
  amount: number
  itemCode?: string
  accountId?: string
  accountName?: string
  tenderReference?: string
  crmDealId?: string
  notes?: string
  date?: string
  dueDate?: string
  taxRate?: number
}

export interface IssueSalesInvoiceResult {
  ok: boolean
  invoice?: Invoice
  error?: string
}

/**
 * THE single posting path for sales invoices created outside the Books
 * renderer (CRM won-deals, Tenders milestones). Owns the whole lifecycle:
 * party resolution, VAT-inclusive pricing, central invoice numbering,
 * journal posting, ledger recompute and persistence+broadcast. Callers must
 * never post journals or mutate account balances themselves.
 */
export function issueSalesInvoiceInBooks(input: IssueSalesInvoiceInput): IssueSalesInvoiceResult {
  try {
    if (!input || !input.booksDataPath) return { ok: false, error: 'booksDataPath is required' }

    const crmDealId = typeof input.crmDealId === 'string' ? input.crmDealId.trim() : ''
    const amount = round2(Number(input.amount) || 0)
    if (amount <= 0) return { ok: false, error: 'Invoice amount must be greater than 0' }
    const partyName = String(input.partyName || '').trim()
    if (!partyName) return { ok: false, error: 'Party name is required' }

    // The whole read → number → post → write cycle runs inside one queued
    // mutation, so no other writer can slip a journal between the read and the
    // write and leave this invoice with a duplicate number (or lost entirely).
    const outcome = mutateBooksStoreSync<IssueSalesInvoiceResult>(input.booksDataPath, (stored) => {
      const booksData = stored ?? createEmptyBooksEnvelope()
      if (crmDealId) {
        const existingInvoice = booksData.invoices.find(
          (invoice) => invoice.crmDealId === crmDealId,
        )
        if (existingInvoice) {
          return { data: booksData, value: { ok: true, invoice: existingInvoice } }
        }
      }

      let party = booksData.parties.find((p) => p.name.toLowerCase() === partyName.toLowerCase())
      if (!party) {
        party = {
          id: `party-${randomUUID().slice(0, 8)}`,
          name: partyName,
          type: 'Customer',
          email: '',
          outstandingBalance: 0,
        }
        booksData.parties.push(party)
      }

      const today = input.date || new Date().toISOString().split('T')[0]
      if (isDateLocked(booksData, today)) {
        return {
          data: booksData,
          value: {
            ok: false,
            error: `Cannot issue an invoice dated in a closed period: ${today} (closed through ${booksData.settings.closedThrough})`,
          },
        }
      }
      const dueDate =
        input.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
      // M2: an explicit 0 (zero-rated) must stay 0 — only a missing/NaN rate
      // falls back to the 15% default.
      const taxRate =
        input.taxRate !== undefined && input.taxRate !== null && input.taxRate !== 0
          ? round2(Number(input.taxRate) || 15)
          : input.taxRate === 0
            ? 0
            : 15
      // VAT-inclusive pricing: derive subtotal from the inclusive amount, then
      // recompute tax from the subtotal so invoice totals always equal the
      // journal posting exactly (never `grandTotal / 1.15` inversion drift).
      const subtotal = round2(amount / (1 + taxRate / 100))
      const taxTotal = round2(subtotal * (taxRate / 100))
      const grandTotal = round2(subtotal + taxTotal)

      const salesAcc = booksData.accounts.find(
        (a) => a.id === (input.accountId || 'acc-sales'),
      ) || {
        id: input.accountId || 'acc-sales',
        name: input.accountName || 'Tender & Commercial Contracting Sales',
      }

      const invoiceNumber = nextInvoiceNumber(booksData.invoices, 'Sales', today)
      const invoice: Invoice = {
        id: `inv-${randomUUID().slice(0, 8)}`,
        invoiceNumber,
        type: 'Sales',
        partyId: party.id,
        partyName: party.name,
        date: today,
        dueDate,
        items: [
          {
            id: `item-${randomUUID().slice(0, 8)}`,
            itemCode: input.itemCode || 'COMMERCIAL-DELIVERY',
            description: input.itemDescription || 'Commercial Delivery & Services',
            accountId: salesAcc.id,
            accountName: salesAcc.name,
            qty: 1,
            rate: subtotal,
            taxRate,
            amount: subtotal,
          },
        ],
        subtotal,
        taxTotal,
        grandTotal,
        outstandingAmount: grandTotal,
        status: 'Unpaid',
        notes: input.notes || 'Payment terms: Net 30 days upon invoice receipt.',
        tenderReference: input.tenderReference,
        crmDealId: crmDealId || undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      booksData.invoices.unshift(invoice)
      booksData.journalEntries.unshift(
        createSalesInvoiceJournal(invoice, booksData.accounts, party),
      )
      booksData.updatedAt = new Date().toISOString()

      const normalized = recomputeLedger(
        appendAudit(
          booksData,
          createAuditEntry('invoice.issue', `Issued ${invoice.invoiceNumber} to ${party.name}`, {
            invoiceNumber: invoice.invoiceNumber,
            amount: invoice.grandTotal,
          }),
        ),
      )

      return { data: normalized, value: { ok: true, invoice } }
    })

    if (!outcome.ok) return { ok: false, error: outcome.error }
    return outcome.value ?? { ok: false, error: 'Failed to create sales invoice in Books' }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to create sales invoice in Books' }
  }
}

/**
 * Bank-statement CSV import against the on-disk ledger. The shared
 * settlement engine owns the behaviour (dedupe, payment coverage, import
 * journals); this wrapper owns the ledger read-modify-write, which runs
 * inside the serialized mutation queue so a concurrent invoice posting can
 * never be overwritten by the import.
 */
export function importBankStatement({
  booksDataPath,
  csvContent,
}: {
  booksDataPath: string
  csvContent: string
}): BankStatementImportResult {
  const outcome = mutateBooksStoreSync<BankStatementImportResult>(booksDataPath, (stored) => {
    const { result, ledger } = applyBankStatementImport(
      stored ?? createEmptyBooksEnvelope(),
      csvContent,
    )
    // An import that stored no line — a CSV with nothing valid in it, or one
    // whose every line is already a duplicate — changed nothing. Writing the
    // ledger back would still bump the revision, rotate the `.bak` safety copy
    // and broadcast a change, pushing every revision-tracking client into the
    // stale path for an operation that did not touch the books.
    if (!result.ok || !ledger || (result.importedCount ?? 0) === 0) {
      return { unchanged: true, value: result }
    }
    return { data: ledger, value: result }
  })
  if (!outcome.ok) return { ok: false, error: outcome.error }
  return outcome.value ?? { ok: false, error: 'Failed to import bank statement' }
}

/**
 * 1-click bank reconciliation against the on-disk ledger. The shared
 * settlement engine owns the settlement maths and journals; this wrapper
 * owns the ledger read-modify-write. Cross-app tender back-propagation lives
 * in books-main's executeReconciliation wrapper.
 */
export function executeReconciliationCore({
  booksDataPath,
  transactionId,
  invoiceId,
}: {
  booksDataPath: string
  transactionId: string
  invoiceId: string
}): ReconciliationCoreResult {
  const outcome = mutateBooksStoreSync<ReconciliationCoreResult>(booksDataPath, (stored) => {
    const { result, ledger } = applyReconciliation(stored ?? createEmptyBooksEnvelope(), {
      transactionId,
      invoiceId,
    })
    if (!result.ok || !ledger) return { data: stored ?? createEmptyBooksEnvelope(), value: result }
    return { data: ledger, value: result }
  })
  if (!outcome.ok) return { ok: false, error: outcome.error }
  return outcome.value ?? { ok: false, error: 'Failed to reconcile transaction' }
}

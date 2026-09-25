import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'
import { app, ipcMain, WebContentsView, type WebContents } from 'electron'
import {
  BOOKS_CHANNELS,
  validateBooksData,
  validateCsvString,
  validateInvoicePayload,
  validateNonEmptyString,
  validateRestoreName,
  validateRevision,
  validateSaveIntent,
  type LoadDataResult,
  type SaveDataResult,
} from '../shared/ipc'
import type { BooksData, BooksDataEnvelope, CompanySettings, Invoice } from '../shared/types'
import { validateClosedPeriodMutation } from '../shared/closing'
import {
  exportBackup,
  listBackups,
  listSafetyCopies,
  pruneBackups,
  restoreBackup,
} from './backup-restore'

// Pure books-core (no electron imports): schema constants, ledger-first
// migration/normalization, store IO and the single sales-invoice posting
// path. Re-exported below so all existing consumers/tests importing from
// books-main keep working unchanged.
export * from './books-core'
import {
  BOOKS_STORE_FILENAME,
  computeSettlementSuggestions,
  executeReconciliationCore,
  importBankStatement,
  isBooksStoreFile,
  migrateAndValidateBooks,
  readBooksStore,
  readBooksStoreStrict,
  setStoreWriteObserver,
  writeBooksStore,
  type BooksWriteIntent,
} from './books-core'

export * from '../shared/accounting'
import { round2 } from '../shared/accounting'
import { CORE_ACCOUNTS, DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../shared/chart'
import { buildInvoicePdf } from '../shared/reports'

// Re-exported for callers/tests that historically imported them from here.
export { CORE_ACCOUNTS, DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS }

const activeBooksWebContents = new Set<WebContents>()
let booksFileWatcher: FSWatcher | null = null
let lastBroadcastJson = ''
let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null
let watchedBooksFilePath = ''
let watchedBooksDir = ''

// Every pure-core write (CRM/Tenders included) must refresh live Books
// renderers. Renderer-originated writes carry an exclude sender through
// persistBooksData; core-originated writes broadcast to every active view.
let coreWriteExcludeSender: WebContents | undefined
setStoreWriteObserver((json: string) => {
  try {
    broadcastBooksData(JSON.parse(json) as BooksData, coreWriteExcludeSender)
  } catch {
    // writeBooksStore only serializes valid JSON; keep the write successful
    // even if an observer cannot decode/broadcast a notification.
  }
})

export function registerBooksWebContents(wc: WebContents): void {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
  activeBooksWebContents.add(wc)
  if (typeof wc.once === 'function') {
    wc.once('destroyed', () => {
      activeBooksWebContents.delete(wc)
    })
  }
}

export function unregisterBooksWebContents(wc: WebContents): void {
  activeBooksWebContents.delete(wc)
}

export function getActiveBooksWebContents(): WebContents[] {
  return Array.from(activeBooksWebContents).filter(
    (wc) => typeof wc.isDestroyed !== 'function' || !wc.isDestroyed(),
  )
}

export function clearActiveBooksWebContents(): void {
  activeBooksWebContents.clear()
}

export function getLastBroadcastJson(): string {
  return lastBroadcastJson
}

export function setLastBroadcastJson(json: string): void {
  lastBroadcastJson = json
}

export function broadcastBooksData(data: BooksData, excludeSender?: WebContents): void {
  const json = JSON.stringify(data)
  lastBroadcastJson = json
  for (const wc of activeBooksWebContents) {
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
      continue
    }
    // Layer 1 loop suppression: skip excludeSender
    if (excludeSender) {
      if (wc === excludeSender) continue
      if (
        (wc as any).id &&
        (excludeSender as any).id &&
        (wc as any).id === (excludeSender as any).id
      )
        continue
    }
    try {
      wc.send(BOOKS_CHANNELS.dataChanged, data)
    } catch (err) {
      console.warn('books-main: failed to broadcast dataChanged to WebContents:', err)
    }
  }
}

/**
 * The OS user stamped on audit entries whose writer could not name one. The
 * renderer has no identity to offer, so without this the audit log is
 * anonymous — and an unattributable ledger is not evidence.
 */
let auditActor: string | undefined

export function setAuditActor(actor: string | undefined): void {
  auditActor = actor
}

function resolveAuditActor(): string {
  if (auditActor !== undefined) return auditActor
  try {
    auditActor = userInfo().username || ''
  } catch {
    auditActor = ''
  }
  return auditActor
}

/**
 * Stamps the OS user onto every audit entry that arrived without one, in the
 * single place every write passes through — so entries created by the
 * renderer (which knows no OS identity) are attributable too.
 */
function stampAuditActors(data: BooksDataEnvelope, actor: string): BooksDataEnvelope {
  if (!actor) return data
  const auditLog = data.auditLog
  if (!Array.isArray(auditLog) || auditLog.length === 0) return data
  if (!auditLog.some((entry) => !entry.actor || !String(entry.actor).trim())) return data
  return {
    ...data,
    auditLog: auditLog.map((entry) =>
      !entry.actor || !String(entry.actor).trim() ? { ...entry, actor } : entry,
    ),
  }
}

export function persistBooksData(
  baseDirOrPath: string,
  data: unknown,
  excludeSender?: WebContents,
  intent: BooksWriteIntent = {},
): SaveDataResult {
  const validated = migrateAndValidateBooks(data)
  const actor = resolveAuditActor()
  // writeBooksStore triggers the core write observer above. Pin the sender
  // only for this synchronous atomic write so the observer emits exactly one
  // data-changed event to peers, never an echo plus a duplicate broadcast.
  coreWriteExcludeSender = excludeSender
  try {
    return writeBooksStore(baseDirOrPath, stampAuditActors(validated, actor), intent)
  } finally {
    coreWriteExcludeSender = undefined
  }
}

export function startBooksStoreWatcher(targetPath?: string): void {
  const filePath = targetPath || getStoragePath()
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (booksFileWatcher) {
    // Same directory, different file: the existing watcher covers it, because
    // it only reacts to the one store name it was started for. Closing it and
    // reopening would race the events of the write being made right now.
    if (dir === watchedBooksDir) {
      watchedBooksFilePath = filePath
      return
    }
    stopBooksStoreWatcher()
  }

  watchedBooksFilePath = filePath
  watchedBooksDir = dir
  try {
    booksFileWatcher = watch(dir, (_eventType, filename) => {
      // Only the store itself counts. The forensic copies, the safety copy and
      // the atomic-write temporaries all live in this directory and all used
      // to match the old `includes('books-data.json')` test, so an unreadable
      // store fed its own recovery copies back in as fresh "changes".
      const watchName = typeof filename === 'string' ? filename : ''
      if (watchName && !isBooksStoreFile(watchName, watchedBooksFilePath)) return
      if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
      watchDebounceTimer = setTimeout(() => {
        try {
          if (!watchedBooksFilePath || !existsSync(watchedBooksFilePath)) return
          const read = readBooksStoreStrict(watchedBooksFilePath, { forensic: false })
          if (!read.ok || !read.data) return
          const currentJson = JSON.stringify(read.data)
          if (currentJson !== lastBroadcastJson) {
            lastBroadcastJson = currentJson
            broadcastBooksData(read.data)
          }
        } catch (err) {
          console.warn('books-main: error in file watcher handler:', err)
        }
      }, 100)
    })
  } catch (err) {
    console.warn(`books-main: could not start ${BOOKS_STORE_FILENAME} watcher:`, err)
  }
}

export function stopBooksStoreWatcher(): void {
  watchedBooksFilePath = ''
  watchedBooksDir = ''
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer)
    watchDebounceTimer = null
  }
  if (booksFileWatcher) {
    try {
      booksFileWatcher.close()
    } catch {}
    booksFileWatcher = null
  }
}

export function resetBooksIpcForTesting(): void {
  ipcRegistered = false
  clearActiveBooksWebContents()
  stopBooksStoreWatcher()
}

export interface BooksRuntimeConfig {
  preloadPath: string
  rendererUrl?: string | undefined
  rendererFile: string
  openGeneratedPath?: (path: string) => boolean
  onOpenCrm?: () => void
  onOpenTenders?: () => void
}

let runtime: BooksRuntimeConfig = {
  preloadPath: '',
  rendererFile: '',
}

let ipcRegistered = false

function getStoragePath(): string {
  const dir = join(app.getPath('userData'), 'books')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, BOOKS_STORE_FILENAME)
}

/** Backups directory next to the live books-data.json (created on demand). */
function getBackupsDir(): string {
  const booksDataPath = getStoragePath()
  const dir = dirname(booksDataPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, 'backups')
}

export function configureBooksRuntime(config: BooksRuntimeConfig): void {
  runtime = { ...runtime, ...config }
}

/** A safe file-name stem for a generated report or invoice file. */
function safeFileStem(raw: unknown, fallback: string): string {
  const stem = String(raw ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80)
  return stem || fallback
}

/** Writes generated output through a temporary file so readers never see a
 *  half-written report, and so two windows cannot interleave their bytes. */
function writeGeneratedFile(targetPath: string, content: string | Uint8Array): void {
  const dir = dirname(targetPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmp = `${targetPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, targetPath)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    throw err
  }
}

/**
 * The directory one generated export is written into.
 *
 * The file NAME stays exactly what it always was, but every export gets its own
 * directory carrying a millisecond stamp plus a process-monotonic sequence —
 * so the path is unique because of the stamp, never because `existsSync` said
 * the name was free. Checking the filesystem only sees the files still in
 * place: once the shell renamed the export, or the user moved it, the old name
 * was free again and the next export handed the shell a path it already had
 * open in a tab.
 */
let generatedExportSequence = 0

function uniqueGeneratedDir(): string {
  generatedExportSequence += 1
  return join(tmpdir(), 'zano-books-exports', `${Date.now()}-${generatedExportSequence}`)
}

/** A path no other export of this or any later run can be holding. */
function uniqueGeneratedPath(stem: string, extension: string): string {
  return join(uniqueGeneratedDir(), `${stem}${extension}`)
}

export function registerBooksIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  // Start file watcher for external changes
  startBooksStoreWatcher()

  // Load persistence. The result is discriminated so the renderer can tell
  // "no books yet" (first run) from "the books exist but could not be read",
  // which must never be answered with an empty ledger: saving that would
  // overwrite the user's real books.
  ipcMain.handle(BOOKS_CHANNELS.loadData, (_e): LoadDataResult => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const read = readBooksStoreStrict(getStoragePath())
      if (read.ok) return { ok: true, readable: true, data: read.data }
      console.error(`[books-main] Could not read the books store: ${read.error}`)
      // The forensic copy is the user's way back to the data, so the path goes
      // with the diagnosis.
      return {
        ok: true,
        readable: false,
        data: null,
        error: read.error,
        ...(read.forensicPath ? { forensicPath: read.forensicPath } : {}),
      }
    } catch (err: any) {
      return {
        ok: false,
        readable: false,
        data: null,
        error: err?.message || 'Failed to load books data',
      }
    }
  })

  // Save persistence. The payload carries the revision the client last loaded,
  // so a stale snapshot is rejected instead of clobbering a newer ledger. The
  // optional third argument is the client's explicit statement about a save
  // the user made on purpose that leaves the books empty (deleting the last
  // record); anything else it might carry is refused before the write.
  ipcMain.handle(
    BOOKS_CHANNELS.saveData,
    (_e, data: unknown, revision: unknown, intent: unknown): SaveDataResult => {
      if (_e?.sender) registerBooksWebContents(_e.sender)
      const validated = validateBooksData(data)
      if (!validated.ok) {
        console.warn(`[books-main] Rejected raw save: ${validated.error}`)
        return { ok: false, error: validated.error }
      }
      const revisionGuard = validateRevision(revision)
      if (!revisionGuard.ok) return { ok: false, error: revisionGuard.error }
      const intentGuard = validateSaveIntent(intent)
      if (!intentGuard.ok) {
        console.warn(`[books-main] Rejected raw save: ${intentGuard.error}`)
        return { ok: false, error: intentGuard.error }
      }

      try {
        const p = getStoragePath()
        const read = readBooksStoreStrict(p, { forensic: false })
        if (!read.ok) {
          return { ok: false, error: `Could not open your books: ${read.error}` }
        }
        const previous = read.data
        if (previous) {
          const guard = validateClosedPeriodMutation(previous, validated.value)
          if (!guard.ok) {
            console.warn(`[books-main] Rejected raw save: ${guard.error}`)
            return { ok: false, error: guard.error || 'The change was rejected' }
          }
        }
        const outcome = persistBooksData(p, validated.value, _e?.sender, {
          expectedRevision: revisionGuard.value,
          ...intentGuard.value,
        })
        return outcome
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Failed to save books data' }
      }
    },
  )

  // Cross-App: Export to Sheets
  ipcMain.handle(BOOKS_CHANNELS.exportToSheets, (_e, reportName: unknown, csvContent: unknown) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    const csv = validateCsvString(csvContent)
    if (!csv.ok) return { ok: false, error: csv.error }
    try {
      const safeName = safeFileStem(reportName, 'Financial_Report')
      // The stamp stays in the file name (callers and the shell both expect it
      // there); the per-export directory is what makes the path unique.
      const targetPath = uniqueGeneratedPath(`${safeName}_${Date.now()}`, '.csv')
      writeGeneratedFile(targetPath, csv.value)

      if (runtime.openGeneratedPath) {
        runtime.openGeneratedPath(targetPath)
      }
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to export report to Sheets' }
    }
  })

  // Cross-App: Print & Sign in PDF (real PDF via pdf-lib)
  ipcMain.handle(BOOKS_CHANNELS.openInPdf, async (_e, invoice: unknown, companyName: unknown) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    const validated = validateInvoicePayload(invoice)
    if (!validated.ok) return { ok: false, error: validated.error }
    const invoiceNo = safeFileStem(validated.value.invoiceNumber, 'INV-0001')
    // One directory per export: two exports of the same invoice number — or of
    // the same number after the shell renamed the first file — never share a
    // path, and the file name stays the one the shell titles the tab with.
    const targetPath = uniqueGeneratedPath(`Tax_Invoice_${invoiceNo}`, '.pdf')

    // Company details come from the books store; fall back to the passed
    // name only when the store is unreachable.
    let settings: CompanySettings
    try {
      const stored = readBooksStoreStrict(getStoragePath(), { forensic: false })
      if (!stored.ok || !stored.data) {
        settings = {
          ...DEFAULT_BOOK_SETTINGS,
          companyName:
            typeof companyName === 'string' && companyName.trim()
              ? companyName
              : DEFAULT_BOOK_SETTINGS.companyName,
        }
      } else {
        settings = stored.data.settings
      }
    } catch {
      settings = {
        ...DEFAULT_BOOK_SETTINGS,
        companyName:
          typeof companyName === 'string' && companyName.trim()
            ? companyName
            : DEFAULT_BOOK_SETTINGS.companyName,
      }
    }

    const result = await writeInvoicePdf(validated.value, settings, targetPath)
    if (result.ok && runtime.openGeneratedPath) {
      runtime.openGeneratedPath(targetPath)
    }
    return result
  })

  // Cross-App: Open CRM
  ipcMain.handle(BOOKS_CHANNELS.openInCrm, (_e) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    if (runtime.onOpenCrm) {
      runtime.onOpenCrm()
      return true
    }
    return false
  })

  // Cross-App: Open Tenders
  ipcMain.handle(BOOKS_CHANNELS.openInTenders, (_e) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    if (runtime.onOpenTenders) {
      runtime.onOpenTenders()
      return true
    }
    return false
  })

  // Bank reconciliation: Import CSV
  ipcMain.handle(BOOKS_CHANNELS.importBankStatementCsv, (_e, csvContent: unknown) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    const csv = validateCsvString(csvContent)
    if (!csv.ok) return { ok: false, error: csv.error }
    try {
      const p = getStoragePath()
      const result = importBankStatement({ booksDataPath: p, csvContent: csv.value })
      // Only a landed import moved the books: a CSV with nothing valid in it,
      // or one whose lines were all duplicates, wrote nothing and has nothing
      // to announce.
      if (result.ok && (result.importedCount ?? 0) > 0) {
        const read = readBooksStoreStrict(p, { forensic: false })
        if (read.ok && read.data) broadcastBooksData(read.data)
      }
      return result
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to import bank statement' }
    }
  })

  // Bank reconciliation: Reconcile transaction with invoice
  ipcMain.handle(
    BOOKS_CHANNELS.reconcileTransaction,
    (_e, transactionId: unknown, invoiceId: unknown) => {
      if (_e?.sender) registerBooksWebContents(_e.sender)
      const txGuard = validateNonEmptyString(transactionId, 'transactionId')
      if (!txGuard.ok) return { ok: false, error: txGuard.error }
      const invoiceGuard = validateNonEmptyString(invoiceId, 'invoiceId')
      if (!invoiceGuard.ok) return { ok: false, error: invoiceGuard.error }
      try {
        const p = getStoragePath()
        const result = executeReconciliation({
          booksDataPath: p,
          transactionId: txGuard.value,
          invoiceId: invoiceGuard.value,
        })
        if (result.ok) {
          const read = readBooksStoreStrict(p, { forensic: false })
          if (read.ok && read.data) broadcastBooksData(read.data)
        }
        return result
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Failed to reconcile transaction' }
      }
    },
  )

  // Bank reconciliation: Get settlement suggestions
  ipcMain.handle(BOOKS_CHANNELS.getSettlementSuggestions, (_e) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const read = readBooksStoreStrict(getStoragePath(), { forensic: false })
      // A store that cannot be read yields no suggestions rather than
      // suggestions computed from a fabricated empty ledger.
      if (!read.ok || !read.data) return []
      return computeSettlementSuggestions(read.data)
    } catch {
      return []
    }
  })

  // Backup & Restore: create a fresh backup of the live store
  ipcMain.handle(BOOKS_CHANNELS.backupNow, (_e) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const p = getStoragePath()
      const result = exportBackup(p)
      // Keep the backups directory tidy: the oldest backups beyond 10 are
      // pruned automatically after every successful backup.
      if (result.ok) {
        pruneBackups(getBackupsDir(), 10)
      }
      return result
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to create backup' }
    }
  })

  // Backup & Restore: list the restore points (newest first) — the backups the
  // user made, plus the pre-restore safety copies this app writes before every
  // restore. They are labelled by kind so the two never blur: a safety copy is
  // the undo of a restore, and it is restorable in turn.
  ipcMain.handle(BOOKS_CHANNELS.listBackups, (_e) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const dir = getBackupsDir()
      return [...listBackups(dir), ...listSafetyCopies(dir)].sort((a, b) =>
        b.modifiedAt.localeCompare(a.modifiedAt),
      )
    } catch {
      return []
    }
  })

  // Backup & Restore: restore a backup (or a pre-restore safety copy) by name.
  // The name is resolved inside the backups dir — the renderer never supplies a
  // raw path — and only ever to a plain file name matching one of the two
  // restore-point shapes this app writes.
  ipcMain.handle(BOOKS_CHANNELS.restoreBackup, (_e, backupName: unknown) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    const nameGuard = validateRestoreName(backupName)
    if (!nameGuard.ok) {
      // A name that tries to escape the backups directory never resolves to a
      // file inside it, so it is reported exactly like a missing one. Anything
      // else is simply not a restore-point name.
      const escapes = typeof backupName === 'string' && /(^|[\\/])\.\.([\\/]|$)/.test(backupName)
      return { ok: false, error: escapes ? 'Backup file not found' : 'Invalid backup name' }
    }
    try {
      const p = getStoragePath()
      const name = basename(nameGuard.value)
      const result = restoreBackup(join(getBackupsDir(), name), p)
      if (result.ok && result.restoredData) {
        // restoreBackup already made one atomic audited commit (including a
        // merged active trail); broadcast that exact persisted envelope.
        broadcastBooksData(result.restoredData)
        pruneBackups(getBackupsDir(), 10)
      }
      return result
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to restore backup' }
    }
  })
}

/**
 * Generates a real PDF for an invoice via buildInvoicePdf and writes it to
 * disk. Exported so tests can exercise the openInPdf generation path without
 * an electron runtime. The write is atomic: a partial file must never be
 * opened, and a concurrent export must not interleave with this one.
 */
export async function writeInvoicePdf(
  invoice: Invoice,
  settings: CompanySettings,
  targetPath: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const pdfBytes = await buildInvoicePdf(invoice, settings)
    writeGeneratedFile(targetPath, pdfBytes)
    return { ok: true, path: targetPath }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Failed to generate invoice PDF' }
  }
}

export function executeReconciliation({
  booksDataPath,
  transactionId,
  invoiceId,
  tendersDataPath,
}: {
  booksDataPath: string
  transactionId: string
  invoiceId: string
  tendersDataPath?: string
}): {
  ok: boolean
  error?: string
  transactionId?: string
  invoiceId?: string
  invoiceNumber?: string
  settledAmount?: number
  /** Cash on the line the invoice could not absorb; held as a party credit. */
  unappliedAmount?: number
  remainingOutstanding?: number
  invoiceStatus?: string
  partyBalance?: number
  tenderMilestonePaid?: boolean
  matchedMilestoneId?: string
  matchedTenderId?: string
} {
  // The pure settlement core (no electron) marks the transaction reconciled,
  // settles the invoice, posts the journal, recomputes and persists. This
  // wrapper adds the cross-app tender milestone back-propagation.
  const core = executeReconciliationCore({ booksDataPath, transactionId, invoiceId })
  if (!core.ok) return { ...core, tenderMilestonePaid: false }

  let tenderMilestonePaid = false
  let matchedMilestoneId: string | undefined
  let matchedTenderId: string | undefined

  // CRITICAL: Only propagate PAID to tender milestone if invoice is FULLY settled!
  const isFullySettled = core.invoiceStatus === 'Paid' || (core.remainingOutstanding ?? 1) <= 0

  if (isFullySettled) {
    try {
      let inv: Invoice | undefined
      try {
        inv = readBooksStore(booksDataPath).invoices.find((i) => i.id === invoiceId)
      } catch {}
      const settledAmount = round2(core.settledAmount || 0)

      let candidatePath = tendersDataPath
      if (!candidatePath && booksDataPath) {
        const fromBooks = resolve(booksDataPath, '..', '..', 'tenders', 'tenders-data.json')
        if (existsSync(fromBooks)) candidatePath = fromBooks
      }
      if (!candidatePath && app?.getPath) {
        try {
          const fromApp = join(app.getPath('userData'), 'tenders', 'tenders-data.json')
          if (existsSync(fromApp)) candidatePath = fromApp
        } catch {}
      }
      if (!candidatePath) {
        if (booksDataPath) {
          candidatePath = resolve(booksDataPath, '..', '..', 'tenders', 'tenders-data.json')
        } else if (app?.getPath) {
          try {
            candidatePath = join(app.getPath('userData'), 'tenders', 'tenders-data.json')
          } catch {}
        }
      }

      if (candidatePath && existsSync(candidatePath) && inv) {
        let tendersData: any = null
        let writeFn: any = null
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const tendersModule = require('../../../tenders/src/main/tenders-main')
          if (
            typeof tendersModule.readTendersStore === 'function' &&
            typeof tendersModule.writeTendersStore === 'function'
          ) {
            tendersData = tendersModule.readTendersStore(candidatePath)
            writeFn = tendersModule.writeTendersStore
          }
        } catch {
          // Fallback to direct file read if require fails
          try {
            const raw = readFileSync(candidatePath, 'utf8')
            tendersData = JSON.parse(raw)
            writeFn = (p: string, d: any) => {
              writeFileSync(p, JSON.stringify(d, null, 2), 'utf8')
            }
          } catch {}
        }

        if (tendersData && typeof writeFn === 'function') {
          let modified = false
          const nowIso = new Date().toISOString()

          for (const ws of tendersData.workspaces || []) {
            for (const t of ws.tenders || []) {
              for (const m of t.milestones || []) {
                const matchByInvoiceId = Boolean(m.billedInvoiceId && m.billedInvoiceId === inv.id)
                const matchByInvoiceNum = Boolean(
                  m.billedInvoiceNumber &&
                  inv.invoiceNumber &&
                  m.billedInvoiceNumber === inv.invoiceNumber,
                )
                const matchByRefAndAmount = Boolean(
                  (inv.tenderReference || (inv as any).tenderRef) &&
                  t.referenceNumber === (inv.tenderReference || (inv as any).tenderRef) &&
                  (m.status === 'BILLED' || m.status === 'REACHED') &&
                  Math.round(m.amount * 100) === Math.round(settledAmount * 100),
                )

                if (matchByInvoiceId || matchByInvoiceNum || matchByRefAndAmount) {
                  m.status = 'PAID'
                  m.paidAt = nowIso
                  m.paidDate = nowIso
                  if (!m.billedInvoiceId) m.billedInvoiceId = inv.id
                  if (!m.billedInvoiceNumber && inv.invoiceNumber)
                    m.billedInvoiceNumber = inv.invoiceNumber
                  modified = true
                  tenderMilestonePaid = true
                  matchedMilestoneId = m.id
                  matchedTenderId = t.id
                  break
                }
              }
              if (tenderMilestonePaid) break
            }
            if (tenderMilestonePaid) break
          }

          if (modified) {
            tendersData.updatedAt = nowIso
            writeFn(candidatePath, tendersData)
          }
        }
      }
    } catch (err) {
      console.warn('[books-main] Failed to propagate payment to tenders:', err)
    }
  }

  return {
    ...core,
    tenderMilestonePaid,
    matchedMilestoneId,
    matchedTenderId,
  }
}

export function createBooksView(): WebContentsView {
  registerBooksIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  registerBooksWebContents(view.webContents)

  if (runtime.rendererUrl) {
    view.webContents.loadURL(runtime.rendererUrl)
  } else {
    view.webContents.loadFile(runtime.rendererFile)
  }

  return view
}

import { existsSync, mkdirSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { app, ipcMain, WebContentsView, type WebContents } from 'electron'
import { BOOKS_CHANNELS } from '../shared/ipc'
import type { BooksData, CompanySettings, Invoice } from '../shared/types'
import { validateClosedPeriodMutation } from '../shared/closing'
import { exportBackup, listBackups, pruneBackups, restoreBackup } from './backup-restore'

// Pure books-core (no electron imports): schema constants, ledger-first
// migration/normalization, store IO and the single sales-invoice posting
// path. Re-exported below so all existing consumers/tests importing from
// books-main keep working unchanged.
export * from './books-core'
import {
  computeSettlementSuggestions,
  executeReconciliationCore,
  importBankStatement,
  migrateAndValidateBooks,
  readBooksStore,
  setStoreWriteObserver,
  writeBooksStore,
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

export function persistBooksData(
  baseDirOrPath: string,
  data: unknown,
  excludeSender?: WebContents,
): void {
  const validated = migrateAndValidateBooks(data)
  // writeBooksStore triggers the core write observer above. Pin the sender
  // only for this synchronous atomic write so the observer emits exactly one
  // data-changed event to peers, never an echo plus a duplicate broadcast.
  coreWriteExcludeSender = excludeSender
  try {
    writeBooksStore(baseDirOrPath, validated)
  } finally {
    coreWriteExcludeSender = undefined
  }
}

export function startBooksStoreWatcher(targetPath?: string): void {
  const filePath = targetPath || getStoragePath()
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (booksFileWatcher) {
    if (watchedBooksFilePath === filePath) {
      return
    }
    stopBooksStoreWatcher()
  }

  watchedBooksFilePath = filePath
  try {
    booksFileWatcher = watch(dir, (_eventType, filename) => {
      const isBooksFile = !filename || filename.includes('books-data.json')
      const isNotTmp = !filename || !filename.endsWith('.tmp')
      if (isBooksFile && isNotTmp) {
        if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
        watchDebounceTimer = setTimeout(() => {
          try {
            if (existsSync(filePath)) {
              const currentData = readBooksStore(filePath)
              const currentJson = JSON.stringify(currentData)
              if (currentJson !== lastBroadcastJson) {
                lastBroadcastJson = currentJson
                broadcastBooksData(currentData)
              }
            }
          } catch (err) {
            console.warn('books-main: error in file watcher handler:', err)
          }
        }, 100)
      }
    })
  } catch (err) {
    console.warn('books-main: could not start books-data.json watcher:', err)
  }
}

export function stopBooksStoreWatcher(): void {
  watchedBooksFilePath = ''
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
  return join(dir, 'books-data.json')
}

/** Backups directory next to the live books-data.json (created on demand). */
function getBackupsDir(): string {
  const booksDataPath = getStoragePath()
  const dir = booksDataPath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, 'backups')
}

export function configureBooksRuntime(config: BooksRuntimeConfig): void {
  runtime = { ...runtime, ...config }
}

export function registerBooksIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  // Start file watcher for external changes
  startBooksStoreWatcher()

  const handleGetData = (_e: any) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const p = getStoragePath()
      if (existsSync(p)) {
        return readBooksStore(p)
      }
      return null
    } catch {
      return null
    }
  }

  // Load persistence (support both loadData and getData alias)
  ipcMain.handle(BOOKS_CHANNELS.loadData, handleGetData)
  ipcMain.handle('books:get-data', handleGetData)

  // Save persistence
  ipcMain.handle(BOOKS_CHANNELS.saveData, (_e, data: BooksData) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const p = getStoragePath()
      const previous = existsSync(p) ? readBooksStore(p) : undefined
      if (previous) {
        const guard = validateClosedPeriodMutation(previous, data)
        if (!guard.ok) {
          console.warn(`[books-main] Rejected raw save: ${guard.error}`)
          return false
        }
      }
      persistBooksData(p, data, _e?.sender)
      return true
    } catch {
      return false
    }
  })

  // Cross-App: Export to Sheets
  ipcMain.handle(BOOKS_CHANNELS.exportToSheets, (_e, reportName: string, csvContent: string) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const safeName = (reportName || 'Financial_Report').replace(/[^a-zA-Z0-9_-]/g, '_')
      const targetPath = join(tmpdir(), `${safeName}_${Date.now()}.csv`)
      writeFileSync(targetPath, csvContent, 'utf8')

      if (runtime.openGeneratedPath) {
        runtime.openGeneratedPath(targetPath)
      }
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to export report to Sheets' }
    }
  })

  // Cross-App: Print & Sign in PDF (real PDF via pdf-lib)
  ipcMain.handle(BOOKS_CHANNELS.openInPdf, async (_e, invoice: Invoice, _companyName: string) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const invoiceNo = (invoice?.invoiceNumber || 'INV-0001').replace(/[^a-zA-Z0-9_-]/g, '_')
      const targetPath = join(tmpdir(), `Tax_Invoice_${invoiceNo}.pdf`)

      // Company details come from the books store; fall back to the passed
      // name only when the store is unreachable.
      let settings: CompanySettings
      try {
        settings = readBooksStore(getStoragePath()).settings
      } catch {
        settings = {
          ...DEFAULT_BOOK_SETTINGS,
          companyName: _companyName || DEFAULT_BOOK_SETTINGS.companyName,
        }
      }

      const result = await writeInvoicePdf(invoice, settings, targetPath)
      if (result.ok && runtime.openGeneratedPath) {
        runtime.openGeneratedPath(targetPath)
      }
      return result
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to open invoice in PDF' }
    }
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
  ipcMain.handle(BOOKS_CHANNELS.importBankStatementCsv, (_e, csvContent: string) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const p = getStoragePath()
      const result = importBankStatement({ booksDataPath: p, csvContent })
      if (result.ok) {
        const freshData = readBooksStore(p)
        broadcastBooksData(freshData)
      }
      return result
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to import bank statement' }
    }
  })

  // Bank reconciliation: Reconcile transaction with invoice
  ipcMain.handle(
    BOOKS_CHANNELS.reconcileTransaction,
    (_e, transactionId: string, invoiceId: string) => {
      if (_e?.sender) registerBooksWebContents(_e.sender)
      try {
        const p = getStoragePath()
        const result = executeReconciliation({ booksDataPath: p, transactionId, invoiceId })
        if (result.ok) {
          const freshData = readBooksStore(p)
          broadcastBooksData(freshData)
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
      const p = getStoragePath()
      const data = readBooksStore(p)
      return computeSettlementSuggestions(data)
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

  // Backup & Restore: list available backups (newest first)
  ipcMain.handle(BOOKS_CHANNELS.listBackups, (_e) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      return listBackups(getBackupsDir())
    } catch {
      return []
    }
  })

  // Backup & Restore: restore a backup by name (resolved inside the backups
  // dir — the renderer never supplies a raw path)
  ipcMain.handle(BOOKS_CHANNELS.restoreBackup, (_e, backupName: string) => {
    if (_e?.sender) registerBooksWebContents(_e.sender)
    try {
      const p = getStoragePath()
      const name = basename(String(backupName || ''))
      if (!/^books-backup-.*\.json$/.test(name)) {
        return { ok: false, error: 'Invalid backup name' }
      }
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
 * an electron runtime.
 */
export async function writeInvoicePdf(
  invoice: Invoice,
  settings: CompanySettings,
  targetPath: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const pdfBytes = await buildInvoicePdf(invoice, settings)
    writeFileSync(targetPath, pdfBytes)
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

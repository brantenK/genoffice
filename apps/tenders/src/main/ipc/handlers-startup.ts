// The startup work that precedes every registered channel.
//
// Split out of `ipc/handlers.ts` with no behaviour change. `registerTendersIpc`
// runs this first, once per process, and the channels are registered only after
// it returns.
import { recordDiagnosticsStart, tendersAppVersion } from '../composition-services'
import { getTendersDiagnosticsLog } from '../diagnostics-sink'
import { startTendersReminders } from './engines'
import { managedDocumentStore } from '../store-registry'

/**
 * Everything that must happen before a renderer can reach a channel.
 *
 * The first line in the log file, so a file attached to a support request says
 * what wrote it and which build. This is the only caller of
 * `recordDiagnosticsStart`: the sink is built here for the first time, and the
 * `ipcRegistered` guard in `registerTendersIpc` keeps the line from being written
 * twice. It is written BEFORE anything else can record — `startTendersReminders`
 * below records its own info line on its first check, and a header that arrives
 * second is not a header.
 */
export function runTendersIpcStartup(): void {
  recordDiagnosticsStart(getTendersDiagnosticsLog(), tendersAppVersion())

  // The legacy `tenders-data.json` watcher is NOT started here any more. It read
  // the v1 file back on every change and broadcast it on `tenders:data-changed`,
  // a channel with no subscribers since the authoritative v2 store landed — a
  // background reader nobody consumed. `getStoredData` (in `./store-channels`)
  // still serves the legacy file on demand; nothing watches it.
  //
  // Best-effort startup reconciliation of managed documents (Phase 5 WP-9):
  // persist missing/orphaned state now; the renderer shows the full report via
  // `tenders:reconcile-documents`. A failure never blocks startup.
  void managedDocumentStore()
    .reconcile()
    .catch(() => {})

  // Deadline reminders start with the same hook as the store watcher, so the
  // store is available before the first check reads it. `start()` is idempotent
  // and runs one check immediately; `will-quit` stops the timer (see
  // `registerRemindersQuitHook` in `./engines`).
  startTendersReminders()
}

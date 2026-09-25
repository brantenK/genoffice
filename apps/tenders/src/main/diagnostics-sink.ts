// The Tenders main process's one diagnostics sink, and the helpers that write to it.
//
// Split out of `main/tenders-main.ts` with no behaviour change. Every failure
// this app already knows about — a corrupt store, a refused read, a dropped
// notification — used to reach `console.warn` and nothing else, which on a
// packaged build means it reached nowhere a support engineer can look. This
// module owns the sink's lifecycle (including the test seam) and the
// content-safe `recordDiagnostic` every other main module calls.
//
// The sink itself (`createDiagnosticsLog`) is a separate, Electron-free module:
// it takes a directory and a clock. Resolving that directory in a real Electron
// process belongs here.
import { app } from 'electron'
import {
  createDiagnosticsLog,
  diagnosticsLogDir,
  recordDiagnosticsStart,
  type DiagnosticsLog,
} from './diagnostics-log'
import { errorMessage } from './main-utils'

let diagnosticsLog: DiagnosticsLog | null = null
let diagnosticsLogOverride: DiagnosticsLog | null = null

/**
 * The runtime seams this sink reads. `tenders-main.ts` owns the single override
 * object; this module is handed the two fields it needs through
 * `configureDiagnosticsSink`, so neither module has to import the other.
 */
let sinkOptions: { diagnosticsLog?: DiagnosticsLog; now?: () => Date } = {}

/** Install the sink seams (called by `setTendersEngineOverrides`). */
export function configureDiagnosticsSink(options: {
  diagnosticsLog?: DiagnosticsLog
  now?: () => Date
}): void {
  sinkOptions = options ?? {}
}

/** Drop the memoised sink, so the next use rebuilds it in the current userData. */
export function resetDiagnosticsSink(): void {
  diagnosticsLog = null
}

/**
 * The diagnostics sink for this process. `createDiagnosticsLog` takes an
 * injected clock, and the tests inject a whole sink through
 * `setTendersEngineOverrides({ diagnosticsLog })`, so no test writes to the real
 * data directory or waits on a real rotation.
 */
export function getTendersDiagnosticsLog(): DiagnosticsLog {
  if (sinkOptions.diagnosticsLog) return sinkOptions.diagnosticsLog
  if (diagnosticsLogOverride) return diagnosticsLogOverride
  if (diagnosticsLog) return diagnosticsLog
  diagnosticsLog = createDiagnosticsLog({
    dir: diagnosticsLogDir(app.getPath('userData')),
    ...(sinkOptions.now ? { now: sinkOptions.now } : {}),
  })
  return diagnosticsLog
}

/** The absolute path of the live log, for the user-facing "where is it" answer. */
export function tendersDiagnosticsPath(): string {
  return getTendersDiagnosticsLog().path()
}

/**
 * The running version, for the log's first line.
 *
 * `app.getVersion()` is always present in a real Electron process; this guards
 * the read so a host that does not expose it cannot make the startup
 * diagnostic the reason the app fails to start. A log line saying `unknown` is
 * still a log line that says what wrote it.
 */
export function tendersAppVersion(): string {
  try {
    return typeof app.getVersion === 'function' ? app.getVersion() : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Test seam: install a sink, or `null` to rebuild the real one on next use. */
export function setTendersDiagnosticsLogForTests(log: DiagnosticsLog | null): void {
  diagnosticsLogOverride = log
}

export function recordDiagnostic(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  try {
    getTendersDiagnosticsLog().record({ level, source, message, ...(detail ? { detail } : {}) })
  } catch {
    // The sink never throws by contract; a sink that is not there yet must not
    // turn a diagnostic into a failure of the operation being diagnosed.
  }
}

/** Record a legacy-read refusal, naming the file and the reason. */
export function noteLegacyReadFailure(path: string, error: unknown): void {
  recordDiagnostic('error', 'tenders-main', 'The saved Tenders file could not be read.', {
    path,
    reason: errorMessage(error, 'unknown'),
  })
}

export { recordDiagnosticsStart }

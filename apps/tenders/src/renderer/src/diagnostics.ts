// The renderer's half of the Tenders diagnostics sink.
//
// The renderer cannot write a file — it is sandboxed with no Node access, by
// design — so everything it wants a support engineer to see has to cross the
// bridge to main, which owns the log file (`main/diagnostics-log.ts`). This module
// is that crossing, and it is deliberately tiny: build a `DiagnosticsEntry`, hand
// it to main, and never let the trip fail the app.
//
// THREE RULES, enforced here rather than promised:
//
//  1. **No bridge means no-op, never a throw.** A renderer opened without the
//     preload (`dev:renderer`, a stale build) must still run its diagnostics —
//     logging is the last thing that should break the app. Every call checks the
//     bridge and returns quietly when it is absent or partial.
//  2. **A rejected `invoke` is swallowed.** `tenders:diagnostics-record` can fail
//     (no handler registered, the window closing); the promise rejection is
//     caught so it cannot surface as an unhandled rejection in the renderer.
//  3. **Document content is never sent.** The `detail` object is reduced with the
//     SAME rule main's sink applies (`sanitizeDiagnosticsDetail` below is a
//     deliberate copy of it), minus the filesystem: primitives only, strings cut,
//     a bounded number of keys. The renderer therefore cannot push a tender across
//     the bridge even by accident, and main's own sanitizer is the second line of
//     defence rather than the only one.
//
// `console` still receives everything: a dev session with devtools open loses
// nothing, and the file is what makes a PACKAGED session diagnosable.
//
// ── THE INTERFACE MAIN MUST IMPLEMENT (this module does not edit main) ────────
//
//   Channel name, on `TENDERS_CHANNELS` in `src/shared/ipc.ts`:
//     diagnosticsRecord: 'tenders:diagnostics-record'
//     diagnosticsPath:   'tenders:diagnostics-path'
//
//   Channel `tenders:diagnostics-record` — `ipcRenderer.invoke`, one argument:
//     `DiagnosticsEntry` = { level: 'info' | 'warn' | 'error'; source: string;
//                            message: string;
//                            detail?: Record<string, string | number | boolean | null> }
//   It must begin with `isTrustedTendersEvent(event)`, call
//   `createDiagnosticsLog(...).record(entry)`, and resolve `true`. It must never
//   reject: a logging call that throws in main would turn a diagnostic into a
//   renderer failure on the other side.
//
//   Channel `tenders:diagnostics-path` — `ipcRenderer.invoke`, no argument,
//   resolves the live log's absolute path as a `string`, so the app can TELL THE
//   USER where the file is. Guarded by `isTrustedTendersEvent` as well: a path is
//   small but it is still not something an untrusted frame should be handed.
//
//   Preload (`src/preload/index.ts`), on the `tendersApi` object:
//     recordDiagnostics: (entry: TendersDiagnosticsEntry) =>
//       ipcRenderer.invoke(TENDERS_CHANNELS.diagnosticsRecord, entry)
//     diagnosticsPath: () => ipcRenderer.invoke(TENDERS_CHANNELS.diagnosticsPath)
import type { DiagnosticsEntry, DiagnosticsLevel } from '../../main/diagnostics-log'

export type { DiagnosticsEntry, DiagnosticsLevel }

/**
 * The subset of the preload bridge this module uses. Declared structurally (the
 * same way `ai/transport.ts` declares `TendersAiBridge`) so a test can supply a
 * fake bridge without touching `window`, and so a bridge that has not been
 * extended yet simply reads as absent.
 */
export interface TendersDiagnosticsBridge {
  recordDiagnostics(entry: DiagnosticsEntry): Promise<unknown> | unknown
}

/**
 * Longest detail string forwarded. A copy of main's own bound on purpose: the rule
 * is the caller's too, and a test can pin both against the same number.
 */
export const DIAGNOSTICS_MAX_DETAIL_CHARS = 500

/** At most this many `detail` keys are forwarded. Beyond it, a caller bug, not a diagnostic. */
export const DIAGNOSTICS_MAX_DETAIL_KEYS = 24

/** Longest `message` forwarded, in characters. */
export const DIAGNOSTICS_MAX_MESSAGE_CHARS = 2_000

/**
 * Longest `source` forwarded, in characters. Matches
 * `MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS` in `shared/ipc.ts`, which is what main
 * enforces on arrival — if this were larger, a long source would build an entry
 * main refuses and the diagnostic would vanish at the one moment it mattered.
 */
export const DIAGNOSTICS_MAX_SOURCE_CHARS = 64

/**
 * Detail KEYS the renderer refuses to forward, whatever their value. A mirror of
 * the sink's own list in `main/diagnostics-log.ts` (kept here rather than imported
 * because the renderer must not pull a `node:fs` module into its bundle): names
 * that only ever carry document content are dropped, so neither side of the bridge
 * can be the one that lets a clause through.
 */
const REFUSED_DETAIL_KEYS = new Set([
  'document',
  'tender',
  'tenderTitle',
  'title',
  'name',
  'company',
  'companyName',
  'customer',
  'customers',
  'requirement',
  'requirements',
  'clause',
  'verbatimClause',
  'sourceClause',
  'text',
  'pageText',
  'content',
  'body',
  'proposal',
  'description',
  'notes',
  'extractedValue',
  'candidates',
  'workspaces',
  'vault',
  'buffer',
  'raw',
  'html',
  'markdown',
])

/**
 * The preload's diagnostics surface, or null when this build does not expose it.
 * Partial is absent: a bridge missing `recordDiagnostics` is no bridge, exactly as
 * `ai/transport.ts` treats a partial AI bridge.
 */
export function tendersDiagnosticsBridge(): TendersDiagnosticsBridge | null {
  if (typeof window === 'undefined') return null
  const api = window.tendersApi as unknown as Partial<TendersDiagnosticsBridge> | undefined
  if (!api || typeof api.recordDiagnostics !== 'function') return null
  return {
    recordDiagnostics: (entry) => api.recordDiagnostics?.(entry),
  }
}

/**
 * The detail object as it may cross the bridge: primitives only, document-bearing
 * keys refused, strings cut, non-finite numbers dropped, `undefined` dropped, key
 * count bounded.
 *
 * A deliberate copy of `sanitizeDiagnosticsDetail` in `main/diagnostics-log.ts`,
 * not an import: the renderer must not pull a `node:fs` module into its bundle for
 * a rule this small, and a caller reading either file should see the same contract
 * without a hop through the main process. Main re-applies its own rule on arrival,
 * so this copy is the first line of defence rather than the only one.
 */
export function sanitizeDiagnosticsDetail(
  detail: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  if (!detail || typeof detail !== 'object') return {}
  const out: Record<string, string | number | boolean | null> = {}
  let keys = 0
  for (const [key, value] of Object.entries(detail)) {
    if (keys >= DIAGNOSTICS_MAX_DETAIL_KEYS) break
    if (value === undefined) continue
    if (REFUSED_DETAIL_KEYS.has(key)) continue
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      continue
    }
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    out[key] = typeof value === 'string' ? value.slice(0, DIAGNOSTICS_MAX_DETAIL_CHARS) : value
    keys += 1
  }
  return out
}

/**
 * Collapse whitespace and cut to `limit` characters — the CUT INCLUDING ITS
 * MARKER, which is the part that matters: main enforces its own hard limit on
 * `source` and `message`, so a trim that returned `limit + marker.length`
 * characters would build an entry the channel refuses and lose the diagnostic
 * exactly when it was needed. With `limit` at least the marker's length the result
 * is exactly `limit` characters or fewer; a `limit` too small for the marker still
 * returns at most `limit` characters, just without it.
 */
function trim(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  const marker = '…[truncated]'
  if (limit <= marker.length) return text.slice(0, limit)
  return `${text.slice(0, limit - marker.length)}${marker}`
}

/**
 * Build the entry that will be sent: the caller's level, source and message, with
 * the detail reduced to what may leave the renderer. Pure, so a test can assert the
 * exact payload without a bridge.
 */
export function buildDiagnosticsEntry(entry: DiagnosticsEntry): DiagnosticsEntry {
  const detail = sanitizeDiagnosticsDetail(entry.detail)
  return {
    level: entry.level,
    source: trim(entry.source, DIAGNOSTICS_MAX_SOURCE_CHARS),
    message: trim(entry.message, DIAGNOSTICS_MAX_MESSAGE_CHARS),
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
  }
}

/** What `createRendererDiagnostics` returns: the renderer's logger. */
export interface RendererDiagnostics {
  info(source: string, message: string, detail?: Record<string, unknown>): void
  warn(source: string, message: string, detail?: Record<string, unknown>): void
  error(source: string, message: string, detail?: Record<string, unknown>): void
  /** Record a built entry; the generic form the three named levels go through. */
  record(entry: DiagnosticsEntry): void
}

export interface RendererDiagnosticsOptions {
  /**
   * The bridge to forward through. Defaults to {@link tendersDiagnosticsBridge}
   * (read per call, so a bridge that appears later still works). `null` explicitly
   * means "no bridge", which is what makes the no-op path testable.
   */
  bridge?: TendersDiagnosticsBridge | null
  /** Where the sink writes. Defaults to `console`, which devtools still shows. */
  sink?: Pick<Console, 'info' | 'warn' | 'error'>
}

/**
 * The renderer logger.
 *
 * Every call does two things: it mirrors to `console` (so a dev session is
 * unchanged) and it forwards the built entry to main (so a packaged session is
 * diagnosable). Neither can throw: an absent bridge, a bridge whose `invoke`
 * rejects, a `console` that has been stubbed out — all are contained, because a
 * logging call is never a reason for the app to stop.
 */
export function createRendererDiagnostics(
  options: RendererDiagnosticsOptions = {},
): RendererDiagnostics {
  const sink = options.sink ?? console

  function record(entry: DiagnosticsEntry): void {
    const built = buildDiagnosticsEntry(entry)
    try {
      sink[built.level](`tenders [${built.source}] ${built.message}`, built.detail ?? {})
    } catch {
      // A console that cannot be written to still gets the entry forwarded.
    }
    const bridge = options.bridge === undefined ? tendersDiagnosticsBridge() : options.bridge
    if (!bridge) return
    try {
      // A rejected `invoke` (no handler, a closing window) must not surface as an
      // unhandled rejection; the entry is simply lost, which is the right price
      // for a diagnostic.
      void Promise.resolve(bridge.recordDiagnostics(built)).catch(() => undefined)
    } catch {
      // A bridge that throws synchronously is treated exactly like one that
      // rejects: the entry is dropped and the app carries on.
    }
  }

  return {
    info: (source, message, detail) => record({ level: 'info', source, message, detail }),
    warn: (source, message, detail) => record({ level: 'warn', source, message, detail }),
    error: (source, message, detail) => record({ level: 'error', source, message, detail }),
    record,
  }
}

/**
 * The renderer-wide logger. One instance, so the store and the AI paths share a
 * single source of `source`-prefixed lines; it reads the bridge per call, so it
 * is correct whether the preload was ready at bundle load or not.
 */
export const rendererDiagnostics: RendererDiagnostics = createRendererDiagnostics()

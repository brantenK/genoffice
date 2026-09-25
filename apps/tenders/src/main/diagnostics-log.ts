// The Tenders diagnostic log — the one place a packaged user's problem can be
// seen afterwards.
//
// The finding this file answers is blunt: the app had NO log sink at all. Every
// diagnostic in main (the reminders scheduler's `log` hook, the store's failures)
// and every diagnostic in the renderer (the save-refusal warnings) went to a
// `console` that a packaged Electron app does not give the user any way to read —
// no devtools, no file, nothing. A support request could therefore only ever be
// answered by guesswork.
//
// WHAT THIS FILE IS:
//
//  * **Append-only, one line per entry.** `record()` is synchronous and returns
//    nothing: a diagnostic is fire-and-forget, and the app never waits for a log
//    write before continuing. Each entry becomes exactly one line, so `grep` and
//    `tail` both work on a file that is being written live.
//  * **Bounded, and provably so.** The live file never passes `maxBytes`; when it
//    would, it is rotated to `<name>.1` (the previous `.1` becomes `.2`, … and the
//    oldest is dropped) and a fresh file is started. With `maxFiles` generations
//    the directory can never hold more than `maxBytes × maxFiles` bytes, no
//    matter how long the app runs or how loud a loop gets.
//  * **Never throws.** A logger that can fail the app is worse than no logger:
//    every filesystem call here is wrapped, and a failure is swallowed (a
//    `console.warn`, best-effort) rather than propagated. If the directory does
//    not exist, cannot be created, or is read-only, the app carries on.
//  * **Never records document content.** The `detail` object is stripped to
//    VALUES this module is willing to write — strings, numbers, booleans, null —
//    and each string is truncated; an object or array in `detail` is not walked.
//    This is the same rule the save-refusal diagnostics already follow (counts and
//    reasons, never the document), made a property of the sink itself so no caller
//    can break it by passing a tender through.
//  * **No Electron import.** The sink takes a directory and a clock, so it runs in
//    a plain Node test and in main identically. Wiring it into `tenders-main.ts`
//    (the IPC channel, `app.getPath('userData')`) belongs to that file.
//
// The honest limitation, stated rather than implied: the file lives on THIS
// machine. Nothing here is uploaded, nothing is networked, and closing the app
// cannot lose an entry that was already recorded (each `record()` is a completed
// synchronous append).
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ── the contract ─────────────────────────────────────────────────────────────

/** How loud an entry is. `info` is routine, `warn` is a contained failure, `error` is a real one. */
export type DiagnosticsLevel = 'info' | 'warn' | 'error'

/**
 * One diagnostic. `message` is a complete, human-readable sentence — the same
 * copy the app would show a user — and `detail` carries machine-readable context
 * (counts, codes, revisions). Nothing here is allowed to hold document text.
 */
export interface DiagnosticsEntry {
  level: DiagnosticsLevel
  /** Where it came from, e.g. `tenders-main`, `store`, `reminders`. */
  source: string
  message: string
  detail?: Record<string, unknown>
}

export interface DiagnosticsLog {
  /** Append one entry. Synchronous, never throws, never waits on disk. */
  record(entry: DiagnosticsEntry): void
  /** The live file's absolute path. Exported so a user can be told where to look. */
  path(): string
  /**
   * Flush anything buffered. This sink writes every entry synchronously, so
   * there is never anything to flush — it exists so a caller that must be sure
   * before reporting the path has one call to await.
   */
  flush(): Promise<void>
}

export interface CreateDiagnosticsLogOptions {
  /** Directory the log (and its rotated generations) live in. Created if absent. */
  dir: string
  /** Ceiling on the live file, in bytes. Default {@link DEFAULT_DIAGNOSTICS_MAX_BYTES}. */
  maxBytes?: number
  /** How many files to keep in total, live file included. Default {@link DEFAULT_DIAGNOSTICS_MAX_FILES}. */
  maxFiles?: number
  /** The clock. Injected so a test can pin timestamps without waiting. */
  now?: () => Date
}

// ── the bounds ───────────────────────────────────────────────────────────────

/** The live file's name, inside `dir`. */
export const DIAGNOSTICS_FILE_NAME = 'tenders-diagnostics.log' as const

/**
 * Default ceiling on the live file: 1 MiB. A line is a few hundred bytes, so this
 * is several thousand entries — far more than a session produces and small enough
 * that attaching it to a support request is reasonable.
 */
export const DEFAULT_DIAGNOSTICS_MAX_BYTES = 1024 * 1024

/**
 * Default number of files kept in total: the live file plus two rotated
 * generations. The directory can therefore never exceed
 * `DEFAULT_DIAGNOSTICS_MAX_BYTES × DEFAULT_DIAGNOSTICS_MAX_FILES` (3 MiB).
 */
export const DEFAULT_DIAGNOSTICS_MAX_FILES = 3

/**
 * Longest `message` this sink will write, in characters. A runaway interpolation
 * (a whole serialized document, say) is cut here rather than filling the file —
 * the entry still exists, but it cannot become the document dump the
 * never-record-content rule forbids.
 */
export const DIAGNOSTICS_MAX_MESSAGE_CHARS = 2_000

/** Longest detail STRING this sink will write, in characters. */
export const DIAGNOSTICS_MAX_DETAIL_CHARS = 500

/**
 * How many keys of one `detail` object are written. A `detail` with a hundred
 * keys is a caller mistake, not a diagnostic; the entry is still recorded and the
 * extras are dropped rather than ballooning the line.
 */
const MAX_DETAIL_KEYS = 24

/**
 * The dir the app's diagnostics live in, as a function of its user-data root.
 * Exported so the wiring wave resolves the same path this module writes to
 * without either importing the other.
 */
export function diagnosticsLogDir(userDataDir: string): string {
  return join(userDataDir, 'tenders')
}

/** The live log's absolute path for a given directory. */
export function diagnosticsLogPath(dir: string): string {
  return join(dir, DIAGNOSTICS_FILE_NAME)
}

// ── the content rule ─────────────────────────────────────────────────────────

/**
 * Detail KEYS the sink refuses outright, whatever their value.
 *
 * The structural rule (no objects or arrays) stops a whole document being passed
 * as a value, but a caller can still hand over a single field's text as a string —
 * a `verbatimClause`, a tender `title`, a page's `text` — and a string is
 * structurally indistinguishable from a status code. This list is the second half
 * of the rule: names that only ever carry document content are dropped, so the
 * mistake cannot be recorded even by a caller who meant no harm. The save-refusal
 * diagnostics this sink was built for already log counts and codes only; this
 * makes that a property of the sink rather than a habit of its callers.
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
 * Is this a value the sink is willing to write as a detail VALUE?
 *
 * Only primitives. An object or an array is deliberately NOT walked: the deepest
 * a caller could hide a tender is inside an object it passed as a value, and
 * refusing the whole value is a rule the sink can enforce on its own rather than
 * a promise each caller has to keep. A caller with a nested value should flatten
 * it to the counts and codes it actually means.
 */
function isWritableDetailValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

/**
 * The detail object as this sink will write it: primitives only, keys that only
 * ever carry document content refused, strings cut to
 * {@link DIAGNOSTICS_MAX_DETAIL_CHARS}, at most {@link MAX_DETAIL_KEYS} keys.
 * `undefined` values are dropped rather than written as `null` — "not set" and
 * "set to nothing" are different facts and the log should not merge them.
 */
export function sanitizeDiagnosticsDetail(
  detail: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  if (!detail || typeof detail !== 'object') return {}
  const out: Record<string, string | number | boolean | null> = {}
  let keys = 0
  for (const [key, value] of Object.entries(detail)) {
    if (keys >= MAX_DETAIL_KEYS) break
    if (value === undefined) continue
    if (REFUSED_DETAIL_KEYS.has(key)) continue
    if (!isWritableDetailValue(value)) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    out[key] = typeof value === 'string' ? value.slice(0, DIAGNOSTICS_MAX_DETAIL_CHARS) : value
    keys += 1
  }
  return out
}

// ── one line ─────────────────────────────────────────────────────────────────

/** An ISO timestamp for a date that may be invalid; the epoch stands in rather than throwing. */
function isoTimestamp(at: Date): string {
  return at instanceof Date && !Number.isNaN(at.getTime())
    ? at.toISOString()
    : new Date(0).toISOString()
}

function trimMessage(message: unknown): string {
  if (typeof message !== 'string') return ''
  const text = message.replace(/\s+/g, ' ').trim()
  return text.length > DIAGNOSTICS_MAX_MESSAGE_CHARS
    ? `${text.slice(0, DIAGNOSTICS_MAX_MESSAGE_CHARS)}…[truncated]`
    : text
}

/**
 * Render one entry as the single line that goes in the file: a UTC timestamp, the
 * level, the source, the message, then the sanitized detail as compact JSON.
 *
 * Newlines in the message are collapsed to spaces by {@link trimMessage}, which is
 * what makes "one entry is one line" true rather than merely usual — a `tail -f`
 * on this file reads whole entries, and a multi-line message would break that.
 */
export function formatDiagnosticsLine(entry: DiagnosticsEntry, at: Date): string {
  const detail = sanitizeDiagnosticsDetail(entry.detail)
  const suffix = Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : ''
  return `${isoTimestamp(at)} [${entry.level}] ${String(entry.source)}: ${trimMessage(
    entry.message,
  )}${suffix}\n`
}

// ── the sink ─────────────────────────────────────────────────────────────────

/** A positive integer bound, or the documented default when it is absent/unusable. */
function resolveBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Build the sink. Construction performs no I/O (nothing is written until the first
 * `record()`), so a bad directory costs the app nothing until there is actually
 * something to say — and even then it costs nothing, because every write here is
 * contained.
 */
export function createDiagnosticsLog(options: CreateDiagnosticsLogOptions): DiagnosticsLog {
  const dir = options.dir
  const filePath = diagnosticsLogPath(dir)
  const maxBytes = resolveBound(options.maxBytes, DEFAULT_DIAGNOSTICS_MAX_BYTES)
  const maxFiles = resolveBound(options.maxFiles, DEFAULT_DIAGNOSTICS_MAX_FILES)
  const now = options.now ?? ((): Date => new Date())

  /**
   * Set while a rotation could not be completed (an unwritable directory). The
   * sink then stops trying to rotate for the rest of its life rather than
   * retrying the same doomed rename on every entry — the alternative is a
   * logging failure that scales with how much the app is failing, which is
   * exactly backwards.
   */
  let rotationDisabled = false

  function warnOnceAboutDisk(message: string): void {
    try {
      // Best-effort and non-recursive: the sink's own failure never reaches the
      // app, and console.warn cannot throw in a normal runtime.
      console.warn(`tenders diagnostics: ${message}`)
    } catch {
      // A console that cannot be written to is the end of this path.
    }
  }

  /** The live file's size in bytes, or 0 when it does not exist yet. */
  function sizeOf(path: string): number {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  /**
   * Rotate `file → file.1 → file.2 …`, dropping the oldest kept generation. The
   * highest index is `maxFiles - 1`, so with the default of 3 the files kept are
   * `name`, `name.1`, `name.2` — never a fourth.
   */
  function rotate(): boolean {
    if (rotationDisabled) return false
    try {
      const oldest = maxFiles > 1 ? `${filePath}.${maxFiles - 1}` : null
      if (oldest) {
        try {
          unlinkSync(oldest)
        } catch {
          // The oldest generation is usually absent; nothing to drop.
        }
      }
      for (let index = maxFiles - 2; index >= 1; index -= 1) {
        try {
          renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`)
        } catch {
          // This generation was never written; the chain simply has a gap.
        }
      }
      if (maxFiles > 1) {
        renameSync(filePath, `${filePath}.1`)
      } else {
        // Keeping only the live file: the previous generation is discarded.
        unlinkSync(filePath)
      }
      return true
    } catch (error: unknown) {
      rotationDisabled = true
      warnOnceAboutDisk(
        `rotation failed (${
          error instanceof Error ? error.message : String(error)
        }), so the log will not be rotated again this session`,
      )
      return false
    }
  }

  function ensureDir(): boolean {
    try {
      mkdirSync(dir, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  /** The clock reading, or the epoch when the injected clock throws. */
  function safeNow(): Date {
    try {
      const value = now()
      return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date(0)
    } catch {
      return new Date(0)
    }
  }

  /**
   * Cut one formatted line until it fits `maxBytes`, marking the cut. A single
   * entry larger than the whole ceiling is the one case a rotation cannot fix (a
   * rotation would just move the over-size file aside), so the line itself is
   * what gives: the entry still exists and still says what happened, and the file
   * still honours its bound. `maxBytes` is at least 1, so this terminates.
   */
  function fitToCap(line: string): string | null {
    if (Buffer.byteLength(line, 'utf8') <= maxBytes) return line
    const marker = '…[truncated to fit the log ceiling]\n'
    const budget = maxBytes - Buffer.byteLength(marker, 'utf8')
    if (budget <= 0) return null
    // `slice` counts UTF-16 units, so the result is at most `budget` UTF-8 bytes.
    const head = line.slice(0, budget)
    const trimmed = head.endsWith('\n') ? head : head.slice(0, Math.max(0, budget - 1))
    return `${trimmed}${marker}`
  }

  function record(entry: DiagnosticsEntry): void {
    try {
      if (!ensureDir()) {
        warnOnceAboutDisk(`the log directory ${dir} could not be created`)
        return
      }
      const fitted = fitToCap(formatDiagnosticsLine(entry, safeNow()))
      if (fitted === null) return
      const bytes = Buffer.byteLength(fitted, 'utf8')
      const current = sizeOf(filePath)
      if (current > 0 && current + bytes > maxBytes) {
        // Rotate first; if the rotation worked the fresh file has room. If it did
        // not (an unwritable directory, a live file that is itself a directory),
        // this entry is dropped rather than appended — losing a diagnostic line
        // is survivable, and an unbounded file is the failure this whole module
        // exists to prevent. The live file is emptied first so a rotation that
        // cannot rename still cannot leave the file over its ceiling.
        if (!rotate()) {
          try {
            writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 })
          } catch {
            return
          }
        }
      }
      appendFileSync(filePath, fitted, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // The whole point: a logging failure must not break the app.
    }
  }

  return {
    record,
    path: (): string => filePath,
    flush: async (): Promise<void> => {
      // Every entry is already a completed synchronous append, so there is
      // nothing buffered. Kept so a caller that must be certain (before telling
      // the user where the file is) has one call to await.
      await Promise.resolve()
    },
  }
}

/**
 * Record the single line a fresh session starts with, so a file attached to a
 * support request says what wrote it. The `record()` contract already makes this
 * safe; the guard here is so a future change to `record` cannot turn the header
 * into a startup failure.
 */
export function recordDiagnosticsStart(log: DiagnosticsLog, version: string): void {
  try {
    log.record({
      level: 'info',
      source: 'diagnostics',
      message: `Zanostack Tenders diagnostics started (version ${version}).`,
      detail: { version },
    })
  } catch {
    // Never throws, by contract.
  }
}

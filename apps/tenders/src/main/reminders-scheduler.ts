// Deadline reminders — the main-process scheduler and the OS notification path.
//
// `shared/reminders.ts` decides WHICH reminders are due; this file decides only
// how to learn what tenders exist, how to remember what was already shown, and
// how to put a warning in front of the user. It is the first place in this fork
// that raises an Electron `Notification`, and the audit finding it answers is
// blunt: the app had NO reminder mechanism at all — a manual `.ics` export and
// an on-screen countdown, nothing that survives the app being closed — so a user
// who shut the app was never warned about a closing time, which is the product's
// stated job.
//
// WHAT THIS DOES NOT DO, stated here rather than discovered by the user:
//
//  * **A reminder fires only while the app is running.** `Notification` is a
//    live-process API: if the app is closed when a threshold passes, nothing is
//    sent, and the warning is only surfaced the next time the app is opened
//    (marked `late`, so the copy never pretends the user was warned on time).
//    There is no background daemon, no OS scheduler and no cloud push here, and
//    this module never implies otherwise. The sentence the UI should show is
//    exported as `REMINDERS_RUNTIME_LIMITATION`, and `start()` reports it through
//    the log hook.
//  * **A reminder is a deadline fact, never a verdict on the bid.** The
//    notification body is `describeReminder`'s sentence (plus an explicit clause
//    when the warning is late); it never says a tender is ready, confirmed or
//    compliant. Readiness stays the local rule engine's job and every extracted
//    field stays `unconfirmed` until a human confirms it — nothing here writes
//    `confirmed` anywhere, and nothing here can make a page's text exist.
//  * **Nothing is networked.** The schedule is computed on this machine from the
//    store the app already has, exactly like the local rule engine. Reminders are
//    not an online feature and do not become one.
//
// HOW IT IS BUILT:
//
//  * **Every side effect is injected.** The clock (`now`), the notifier
//    (`notify`), the tender reader (`readTenders`), the timer primitives
//    (`setIntervalImpl` / `clearIntervalImpl`) and the logger (`log`) all have
//    defaults, so the whole scheduler — dedupe across restarts, settings, the
//    corrupt-file path, timer lifecycle — is testable with no Electron, no real
//    clock, no real timer and no waiting.
//  * **It does not import `tenders-main.ts`.** The IPC wiring, the trusted-sender
//    check and the `userData` path belong to the wave that owns them; this file
//    takes `userDataDir` and a reader function, and exports
//    `remindersStatePath` so that wave resolves the same file.
//  * **The file is the single source of truth.** Every check re-reads
//    `<userDataDir>/tenders/reminders.json` rather than trusting a memory copy,
//    so a second window, a restart or a hand-edited file can never desync the
//    schedule. Writes are atomic (unique temp file + rename, mode 0600, the same
//    discipline as the tender store) and pruned on every write.
//  * **Checks are serialised.** Two overlapping checks would both read the same
//    ledger and both notify about the same threshold; a queue means a check
//    always sees the previous check's ledger, which is what makes ONCE-ONLY true
//    rather than merely likely.
//  * **A corrupt file fails toward notifying.** Per the pure core's documented
//    rule, an unreadable/unrecognised state file is treated as "no ledger" — a
//    duplicate warning is a nuisance, silently missing a closing time is the
//    failure this feature exists to prevent.
//  * **A failure never kills the schedule.** A throw from the tender reader, from
//    the notifier or from a disk write is logged and contained: the ledger is
//    left intact, `checkNow` still resolves, and the interval keeps running.
//
// One deliberate trade-off, because it is the honest reading of the ledger:
// `dueReminders` records a threshold the moment the schedule decides to act on
// it, and this module persists exactly that ledger whether or not the OS
// displayed anything. A notification the platform cannot show is reported
// through the log hook (naming the tender and threshold) but is NOT re-armed
// with `forgetReminders`: an unsupported platform cannot be made to show
// anything by retrying, retrying would re-decide the same threshold on every
// check forever, and re-arming would let a reminder fire at an arbitrary later
// moment. Because the ledger decision is identical whether or not notifications
// work, availability can never cause a reminder to fire twice.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  describeReminder,
  dueReminders,
  emptyReminderLedger,
  normalizeReminderSettings,
  parseReminderLedger,
  pruneReminderLedger,
  serializeReminderLedger,
  DEFAULT_REMINDER_SETTINGS,
  type DueReminder,
  type ReminderLedger,
  type ReminderSettings,
  type ReminderTender,
} from '../shared/reminders'

// ── where the state lives ────────────────────────────────────────────────────

/** The `tenders` directory beside the store's own, e.g. `<userData>/tenders`. */
export function remindersStateDir(userDataDir: string): string {
  return join(userDataDir, 'tenders')
}

/**
 * The settings + ledger file: `<userDataDir>/tenders/reminders.json`, beside the
 * authoritative tender store. Exported so the wave that owns the app wiring
 * resolves it identically to this module, which never has to know about
 * Electron. It is deliberately NOT the store file: the strict v2 authority
 * document schema stays untouched by a dedupe ledger.
 */
export function remindersStatePath(userDataDir: string): string {
  return join(remindersStateDir(userDataDir), REMINDERS_STATE_FILE_NAME)
}

export const REMINDERS_STATE_FILE_NAME = 'reminders.json' as const

/**
 * The layout version of the state file. A file this build did not write is
 * ignored entirely (settings back to the documented default, ledger empty),
 * because the pure core's rule is that a ledger which cannot be understood must
 * never suppress a warning about a closing time.
 */
export const REMINDERS_STATE_VERSION = 1 as const

/**
 * Ceiling on the state file this module will read. The file is written only by
 * this module, always pruned to deadlines within the core's retention window, so
 * the real size is bounded by (open tenders × configured thresholds) and sits far
 * below this. A larger file can only come from outside the app, and is treated as
 * unreadable — i.e. as no ledger at all, which fails toward notifying.
 */
export const MAX_REMINDERS_STATE_BYTES = 4 * 1024 * 1024

/**
 * How often the schedule is re-checked while the app is running. The tightest
 * default lead time is two hours, so a quarter-hour poll bounds how late a
 * warning can be to fifteen minutes — negligible against that lead time, and
 * cheap: a check is one small file read and a pure computation unless something
 * actually changed.
 */
export const DEFAULT_REMINDER_CHECK_INTERVAL_MS = 15 * 60_000

// ── the honesty sentence about what a reminder cannot do ─────────────────────

/**
 * The one sentence that states the real limitation, exported so the settings
 * surface and the IPC wave can show the same words this module logs. A reminder
 * is a live-process notification: closing the app means the check stops, and the
 * next time the app opens the warning is delivered late (and says so).
 */
export const REMINDERS_RUNTIME_LIMITATION =
  'Deadline reminders are checked only while Zanostack Tenders is running. If the app is closed when a reminder falls due, no notification is sent at that time; the next time the app is opened it warns about deadlines still ahead, and says the warning is late.'

/** Logged when the platform cannot raise an OS notification at all. */
export const NOTIFICATIONS_UNAVAILABLE_MESSAGE =
  'Desktop notifications are not available here, so a due deadline reminder could not be shown. It was still recorded in the reminder ledger, so it cannot fire twice.'

/** Logged when the platform exposes notifications but reports them unsupported. */
export const NOTIFICATIONS_UNSUPPORTED_MESSAGE =
  'This system reports that desktop notifications are not supported, so a due deadline reminder could not be shown. It was still recorded in the reminder ledger, so it cannot fire twice.'

// ── injected seams ───────────────────────────────────────────────────────────

export interface ReminderLogEvent {
  level: 'info' | 'warn'
  /** Plain-language, safe to show; never claims a bid is ready or confirmed. */
  message: string
  /** Set when the event is about one specific reminder. */
  tenderId?: string
  thresholdId?: string
}

export type ReminderLog = (event: ReminderLogEvent) => void

/** Reads the tenders the schedule should consider. Injected: never imported. */
export type ReadReminderTenders = () => Promise<ReminderTender[]>

/**
 * What a notifier is handed. `body` is the honest sentence from
 * `describeReminder` (see `composeReminderNotification`) — a notifier must not
 * invent copy of its own, and must never add a readiness, confirmation or
 * compliance claim.
 */
export interface ReminderNotification {
  title: string
  body: string
  reminder: DueReminder
}

export type ReminderNotifier = (notification: ReminderNotification) => void

/** Timer primitives, injected so a test can prove the lifecycle with no wall time. */
export type ReminderTimerHandle = ReturnType<typeof setInterval>

export interface RemindersSchedulerOptions {
  /** Root of the app's data; the state file lives at `remindersStatePath(…)`. */
  userDataDir: string
  /** The clock. Injected so a test never waits for a real deadline. */
  now?: () => Date
  /**
   * Raises one reminder. Defaults to an Electron `Notification`, which degrades
   * silently (via the log hook) when Electron or the platform cannot show one.
   */
  notify?: ReminderNotifier
  /** The tender source. Main passes a reader over the authoritative store. */
  readTenders?: ReadReminderTenders
  /** How often to re-check while running. */
  intervalMs?: number
  log?: ReminderLog
  setIntervalImpl?: (callback: () => void, ms: number) => ReminderTimerHandle
  clearIntervalImpl?: (handle: ReminderTimerHandle) => void
}

export interface RemindersCheckResult {
  /** How many reminders this check produced (see `checkNow`). */
  fired: number
  /** The reminders to show, most urgent first, as the pure core ordered them. */
  reminders: DueReminder[]
  /** The ledger as persisted — feed-back is what makes each reminder once-only. */
  ledger: ReminderLedger
}

export interface RemindersState {
  settings: ReminderSettings
  ledger: ReminderLedger
}

/**
 * The contract the IPC wave wires against.
 *
 *  - `start()` — idempotent; schedules the periodic check and runs one
 *    immediately, so a deadline that passed while the app was closed is
 *    surfaced as soon as the app opens.
 *  - `stop()` — idempotent; clears the pending timer so a process can exit and a
 *    test can end cleanly. Work already in flight is left to finish.
 *  - `checkNow()` — runs one check and resolves; it never rejects, because a
 *    rejected interval callback would end the schedule.
 *  - `readState()` — the persisted settings and ledger; never rejects.
 *  - `writeSettings()` — merges a partial settings object, persists it and
 *    returns what was actually written. REJECTS when it could not be persisted,
 *    so a caller cannot believe a setting was saved when it was not.
 *  - `setReadTenders()` — replaces the tender source for later checks.
 */
export interface RemindersScheduler {
  start(): void
  stop(): void
  checkNow(): Promise<RemindersCheckResult>
  readState(): Promise<RemindersState>
  writeSettings(settings: Partial<ReminderSettings>): Promise<ReminderSettings>
  setReadTenders(fn: ReadReminderTenders): void
}

// ── honest notification copy ─────────────────────────────────────────────────

/** On-time title. A scheduling fact; never a statement about the bid. */
export const REMINDER_NOTIFICATION_TITLE = 'Tender closing soon'

/**
 * Late title. `late` means the threshold instant had already passed before the
 * schedule ran — the app was closed, or the tender arrived after its mark — so
 * the title says the warning is late rather than implying it arrived on time.
 */
export const REMINDER_NOTIFICATION_TITLE_LATE = 'Tender closing soon — late warning'

/**
 * The honest body for a reminder: `describeReminder`'s sentence verbatim, plus an
 * explicit clause when the warning is late (the pure core's own note is that the
 * copy "must not pretend the user was warned on time"). Nothing here claims the
 * bid is ready, confirmed or compliant — the sentence names the tender, the
 * remaining time and the closing instant, and stops there.
 */
export function composeReminderNotification(reminder: DueReminder): ReminderNotification {
  const sentence = describeReminder(reminder)
  if (!reminder.late) {
    return { title: REMINDER_NOTIFICATION_TITLE, body: sentence, reminder }
  }
  return {
    title: REMINDER_NOTIFICATION_TITLE_LATE,
    body: `${sentence} This warning is late: it was due ${reminder.thresholdLabel} before closing, and that moment had already passed.`,
    reminder,
  }
}

// ── the default notifier: Electron, or a silent, reported degradation ────────

/**
 * The slice of Electron's `Notification` this module uses, declared structurally
 * so the Electron-present path is provable with a fake and so this file never
 * imports Electron.
 */
export interface ElectronNotificationLike {
  show(): void
}

export interface ElectronNotificationConstructor {
  new (options: { title: string; body: string }): ElectronNotificationLike
  isSupported?(): boolean
}

export interface ElectronModuleLike {
  Notification?: ElectronNotificationConstructor
}

export type ElectronLoader = () => ElectronModuleLike | null

/**
 * The real loader: Electron's main entry, loaded lazily so a module import can
 * never fail just because Electron is absent (the unit suite imports this file
 * outside Electron). The main bundle is CommonJS — `apps/tenders/out/main/index.js`
 * emits `require("electron")` — so `require` is in scope in the app and the same
 * lazy lookup other fork code uses works here. Anything unexpected — no
 * `require`, no Electron, an Electron that failed to install, or a bare Node
 * process where `require('electron')` is the binary path string — returns null
 * and the caller degrades through the log hook.
 */
const defaultElectronLoader: ElectronLoader = () => {
  try {
    if (typeof require !== 'function') return null
    // Lazy and CommonJS on purpose: a static `import` would be resolved when the
    // module is imported (breaking the unit suite) and Electron must stay
    // optional. Same suppression as `apps/books/src/main/books-main.ts`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('electron') as ElectronModuleLike | null
    return loaded && typeof loaded === 'object' ? loaded : null
  } catch {
    return null
  }
}

export interface ElectronNotifierOptions {
  log?: ReminderLog
  /** Injected so the Electron-present path is proved without importing Electron. */
  loadElectron?: ElectronLoader
}

/**
 * The default notifier. It raises an OS notification when Electron can, and
 * otherwise reports through the log hook and returns quietly — a missing or
 * unsupported platform must never throw into the schedule. `show()` itself is
 * left to throw: the scheduler contains it and logs the failure per reminder.
 */
export function createElectronNotifier(options: ElectronNotifierOptions = {}): ReminderNotifier {
  const { log } = options
  const load = options.loadElectron ?? defaultElectronLoader
  return (notification) => {
    const module = load()
    const Notification = module?.Notification
    if (typeof Notification !== 'function') {
      log?.({
        level: 'warn',
        message: NOTIFICATIONS_UNAVAILABLE_MESSAGE,
        tenderId: notification.reminder.tenderId,
        thresholdId: notification.reminder.thresholdId,
      })
      return
    }
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
      log?.({
        level: 'warn',
        message: NOTIFICATIONS_UNSUPPORTED_MESSAGE,
        tenderId: notification.reminder.tenderId,
        thresholdId: notification.reminder.thresholdId,
      })
      return
    }
    const shown = new Notification({ title: notification.title, body: notification.body })
    shown.show()
  }
}

// ── the state file ───────────────────────────────────────────────────────────

interface RemindersStateFile {
  version: number
  settings: ReminderSettings
  ledger: ReminderLedger
}

function defaultState(): RemindersState {
  return {
    settings: normalizeReminderSettings(DEFAULT_REMINDER_SETTINGS),
    ledger: emptyReminderLedger(),
  }
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

// ── the scheduler ────────────────────────────────────────────────────────────

export function createRemindersScheduler(options: RemindersSchedulerOptions): RemindersScheduler {
  const statePath = remindersStatePath(options.userDataDir)
  const clock = options.now ?? (() => new Date())
  const intervalMs = Math.max(1000, options.intervalMs ?? DEFAULT_REMINDER_CHECK_INTERVAL_MS)
  const log = options.log
  const setIntervalImpl = options.setIntervalImpl ?? setInterval
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval
  const notify = options.notify ?? createElectronNotifier({ log })
  let readTenders = options.readTenders
  let timer: ReminderTimerHandle | null = null

  /**
   * One queue for every check and every write, so a check always reads the
   * ledger the previous one persisted. Without this, an interval tick landing
   * during a slow read would compute from a stale ledger and notify twice about
   * the same threshold. Same discipline as the store's `withPathLock`.
   */
  let queue: Promise<unknown> = Promise.resolve()
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation)
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  function nowOrNull(): Date | null {
    try {
      const value = clock()
      return value instanceof Date && !isNaN(value.getTime()) ? value : null
    } catch (error: unknown) {
      log?.({
        level: 'warn',
        message: `The clock could not be read: ${messageOf(error, 'unknown error')}`,
      })
      return null
    }
  }

  /**
   * Read the settings + ledger. Never rejects and never loses anything on a
   * failure it can describe: an absent file is a first run (silent), anything
   * else is reported and answered with the defaults, which fails toward
   * notifying.
   */
  async function readState(): Promise<RemindersState> {
    let raw: string
    try {
      raw = await readFile(statePath, 'utf8')
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return defaultState()
      log?.({
        level: 'warn',
        message: `The reminder settings and ledger could not be read, so reminders start fresh: ${messageOf(error, 'unreadable file')}`,
      })
      return defaultState()
    }
    const bytes = Buffer.byteLength(raw, 'utf8')
    if (bytes > MAX_REMINDERS_STATE_BYTES) {
      log?.({
        level: 'warn',
        message: `The reminder settings and ledger file is ${bytes} bytes, above the ${MAX_REMINDERS_STATE_BYTES}-byte ceiling this app reads, so it was ignored and reminders start fresh.`,
      })
      return defaultState()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error: unknown) {
      log?.({
        level: 'warn',
        message: `The reminder settings and ledger file is damaged and was ignored, so reminders start fresh rather than skipping a warning: ${messageOf(error, 'not valid JSON')}`,
      })
      return defaultState()
    }
    const record = parsed as Partial<RemindersStateFile> | null
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      record.version !== REMINDERS_STATE_VERSION
    ) {
      log?.({
        level: 'warn',
        message:
          'The reminder settings and ledger file is in a form this version does not use, so it was ignored and reminders start fresh.',
      })
      return defaultState()
    }
    // Both readers are total: unusable settings fall back to the documented
    // defaults, and unusable ledger entries are dropped rather than trusted.
    return {
      settings: normalizeReminderSettings(record.settings),
      ledger: parseReminderLedger(record.ledger),
    }
  }

  /**
   * Write the settings + ledger atomically (unique temp file, then rename, mode
   * 0600 — the store's own discipline), pruned to the core's retention window so
   * the file cannot grow without bound. Throws on failure; every caller decides
   * whether that is contained.
   */
  async function writeState(settings: ReminderSettings, ledger: ReminderLedger): Promise<void> {
    const now = nowOrNull()
    const pruned = now ? pruneReminderLedger(ledger, now) : parseReminderLedger(ledger)
    const payload: RemindersStateFile = {
      version: REMINDERS_STATE_VERSION,
      settings: normalizeReminderSettings(settings),
      ledger: pruned,
    }
    const serialized = JSON.stringify(payload)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_REMINDERS_STATE_BYTES) {
      // Not refused: dropping entries here would suppress a warning. The count is
      // bounded by (open tenders × thresholds), so this is a loud signal rather
      // than a routine path.
      log?.({
        level: 'warn',
        message: `The reminder settings and ledger is ${bytes} bytes, above the ${MAX_REMINDERS_STATE_BYTES}-byte ceiling this app reads back; reminders are still recorded, but the file is larger than expected.`,
      })
    }
    const temporary = `${statePath}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await mkdir(remindersStateDir(options.userDataDir), { recursive: true })
      await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, statePath)
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  /** The reminders this check produced, from the reader the caller supplied. */
  async function loadTenders(): Promise<ReminderTender[] | null> {
    if (typeof readTenders !== 'function') {
      log?.({
        level: 'warn',
        message:
          'No tender source has been given to the reminder schedule yet, so this check found nothing to consider. Nothing was recorded and no deadline was missed by it.',
      })
      return null
    }
    try {
      const tenders = await readTenders()
      if (!Array.isArray(tenders)) {
        log?.({
          level: 'warn',
          message:
            'The tender source returned something that is not a list of tenders, so this check considered nothing.',
        })
        return null
      }
      return tenders
    } catch (error: unknown) {
      log?.({
        level: 'warn',
        message: `The tender list could not be read, so this check considered nothing and the reminder ledger was left untouched: ${messageOf(error, 'unreadable tender list')}`,
      })
      return null
    }
  }

  async function runCheck(): Promise<RemindersCheckResult> {
    const state = await readState()
    const tenders = await loadTenders()
    if (tenders === null) return { fired: 0, reminders: [], ledger: state.ledger }

    const now = nowOrNull()
    if (!now) return { fired: 0, reminders: [], ledger: state.ledger }

    let result: { reminders: DueReminder[]; ledger: ReminderLedger }
    try {
      result = dueReminders(tenders, state.settings, now, state.ledger)
    } catch (error: unknown) {
      log?.({
        level: 'warn',
        message: `The reminder schedule could not be computed, so nothing fired and the ledger was left untouched: ${messageOf(error, 'unusable tender data')}`,
      })
      return { fired: 0, reminders: [], ledger: state.ledger }
    }

    for (const reminder of result.reminders) {
      const notification = composeReminderNotification(reminder)
      try {
        notify(notification)
      } catch (error: unknown) {
        // Contained: a notifier that throws must not end the schedule. The
        // ledger is still written from the core's decision — see the module
        // header on why a dropped notification is reported rather than re-armed.
        log?.({
          level: 'warn',
          message: `The deadline reminder could not be shown: ${messageOf(error, 'the notifier failed')}`,
          tenderId: reminder.tenderId,
          thresholdId: reminder.thresholdId,
        })
      }
    }

    // Only touch the disk when the ledger actually changed, so a quiet check is
    // free — but prune on every write, which is what bounds the file.
    const changed = serializeReminderLedger(result.ledger) !== serializeReminderLedger(state.ledger)
    if (changed) {
      try {
        await writeState(state.settings, result.ledger)
      } catch (error: unknown) {
        log?.({
          level: 'warn',
          message: `The reminder ledger could not be saved, so a reminder may be shown again after a restart: ${messageOf(error, 'the write failed')}`,
        })
      }
    }

    return { fired: result.reminders.length, reminders: result.reminders, ledger: result.ledger }
  }

  /**
   * Run one check. Serialised, and it never rejects: a rejected interval
   * callback would end the schedule, and an unhandled rejection here would take
   * the process down over a reminder.
   */
  function checkNow(): Promise<RemindersCheckResult> {
    return enqueue(async () => {
      try {
        return await runCheck()
      } catch (error: unknown) {
        log?.({
          level: 'warn',
          message: `The reminder check failed and nothing fired: ${messageOf(error, 'unexpected failure')}`,
        })
        return { fired: 0, reminders: [], ledger: emptyReminderLedger() }
      }
    })
  }

  return {
    start(): void {
      if (timer !== null) return
      log?.({ level: 'info', message: REMINDERS_RUNTIME_LIMITATION })
      timer = setIntervalImpl(() => {
        void checkNow()
      }, intervalMs)
      // One check straight away: the app may have been closed when a threshold
      // passed, and that is exactly the warning this feature exists to deliver.
      void checkNow()
    },
    stop(): void {
      if (timer === null) return
      clearIntervalImpl(timer)
      timer = null
    },
    checkNow,
    readState,
    writeSettings(settings: Partial<ReminderSettings>): Promise<ReminderSettings> {
      return enqueue(async () => {
        const state = await readState()
        const patch: Partial<ReminderSettings> = {}
        if (settings && typeof settings === 'object') {
          // Own keys only, and `undefined` is not an instruction to clear: a
          // partial write changes what it names and nothing else.
          if (settings.enabled !== undefined) patch.enabled = settings.enabled
          if (settings.thresholds !== undefined) patch.thresholds = settings.thresholds
        }
        const merged = normalizeReminderSettings({ ...state.settings, ...patch })
        // Throws when it cannot persist: the caller must not be told a setting
        // was saved when the next check would not honour it.
        await writeState(merged, state.ledger)
        return merged
      })
    },
    setReadTenders(fn: ReadReminderTenders): void {
      if (typeof fn !== 'function') {
        log?.({
          level: 'warn',
          message:
            'A tender source was expected here, so the reminder schedule kept the one it had.',
        })
        return
      }
      readTenders = fn
    },
  }
}

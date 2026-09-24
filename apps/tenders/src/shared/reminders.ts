// Pure deadline-reminder scheduling — no Electron, no clock, no storage.
//
// The audit found Zanostack Tenders had NO reminder mechanism at all: a manual
// `.ics` export and an on-screen countdown, nothing that survives the app being
// closed. So a user who shut the app was never warned about a closing time,
// which is the one thing this product exists to prevent. This module is the
// scheduling core UNDER the Electron `Notification` path a later wave wires up:
// every decision here is a pure function of (tenders, settings, now, ledger), so
// it is testable with no Electron, no real clock and no disk, and the
// notification path can never invent a reminder the schedule does not justify.
//
// The closing instant comes from the ONE parser — `parseClosingDate` in
// `./readiness`, which anchors civil SA values to SAST (+02:00) — and is
// rendered by that same module's `formatClosingInstant`, so a reminder can never
// disagree with the readiness gate or the countdown badge about when a bid
// actually closes, or about how that instant is written. A reminder is a scheduling fact only: it never claims a
// tender is ready, confirmed or compliant.
import {
  closingDisplayTimeZone,
  formatClosingInstant,
  formatDeadlineDelta,
  parseClosingDate,
} from './readiness'
import type { TenderRecord, TenderStatus } from './types'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** The only fields a reminder needs from a tender. */
export type ReminderTender = Pick<TenderRecord, 'id' | 'title' | 'closingDate' | 'status'>

// ── Settings ─────────────────────────────────────────────────────────────────

export interface ReminderThreshold {
  /**
   * Stable id, persisted in the ledger. Changing an id re-arms that reminder,
   * so ids are part of the persisted contract and must not be reused for a
   * different lead time.
   */
  id: string
  /** Human lead time, e.g. "7 days" / "2 hours". */
  label: string
  /** How long before the closing instant this reminder becomes due. */
  leadMs: number
}

/**
 * Documented default lead times: a week out (start assembling), three days
 * (chase outstanding documents), one day (final check against the returnables)
 * and two hours (submit now). The list is ordered longest lead first — display
 * order only; which reminder fires is decided by the algorithm, never by list
 * position.
 */
export const DEFAULT_REMINDER_THRESHOLDS: readonly ReminderThreshold[] = [
  { id: '7d', label: '7 days', leadMs: 7 * DAY_MS },
  { id: '3d', label: '3 days', leadMs: 3 * DAY_MS },
  { id: '1d', label: '1 day', leadMs: DAY_MS },
  { id: '2h', label: '2 hours', leadMs: 2 * HOUR_MS },
]

export interface ReminderSettings {
  /**
   * Master switch. `false` means `dueReminders` returns nothing at all and the
   * app behaves exactly as it did before reminders existed.
   */
  enabled: boolean
  /** Ordered, configurable lead times (see `DEFAULT_REMINDER_THRESHOLDS`). */
  thresholds: ReminderThreshold[]
}

/**
 * Default is ENABLED. Reminders are computed entirely on this machine — no
 * network, no model, nothing leaves the app — and "don't miss the closing time"
 * is the product's stated job, so the honest default is to warn. The flag exists
 * because an unrequested OS notification is intrusive: a user (or an operator)
 * can turn reminders off, and with `enabled: false` the schedule is inert.
 */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: true,
  thresholds: [...DEFAULT_REMINDER_THRESHOLDS],
}

/**
 * Coerce persisted/partial settings into a usable shape: an absent threshold
 * list falls back to the documented default, an explicitly EMPTY list means "no
 * reminders" (a user who switched every lead time off is not silently given four
 * back), unusable entries are dropped, duplicate ids keep their first entry, and
 * the list is returned longest lead first.
 */
export function normalizeReminderSettings(
  settings?: Partial<ReminderSettings> | null,
): ReminderSettings {
  const enabled =
    typeof settings?.enabled === 'boolean' ? settings.enabled : DEFAULT_REMINDER_SETTINGS.enabled
  const raw = settings?.thresholds
  if (raw === undefined) return { enabled, thresholds: [...DEFAULT_REMINDER_THRESHOLDS] }

  const seen = new Set<string>()
  const thresholds: ReminderThreshold[] = []
  for (const candidate of raw) {
    if (!candidate) continue
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const leadMs = Number(candidate.leadMs)
    if (!id || seen.has(id) || !Number.isFinite(leadMs) || leadMs <= 0) continue
    seen.add(id)
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
    thresholds.push({ id, label: label || id, leadMs })
  }
  thresholds.sort((a, b) => b.leadMs - a.leadMs)
  return { enabled, thresholds }
}

// ── Which tenders are still open ─────────────────────────────────────────────

/**
 * Statuses that are still before submission — the only ones a closing-time
 * reminder is meaningful for (see the pipeline order in `./lifecycle`). This is
 * an explicit allow-list, not "anything not submitted": an unrecognised or newly
 * added status must fail closed and produce NO notification rather than spam the
 * user about a tender that is already submitted, won, lost or archived.
 */
export const OPEN_TENDER_STATUSES: readonly TenderStatus[] = [
  'IN_PROGRESS',
  'READY_TO_ASSEMBLE',
  'PACK_GENERATED',
  'READY_FOR_SUBMISSION',
]

export function isOpenTenderStatus(status: TenderStatus): boolean {
  return OPEN_TENDER_STATUSES.includes(status)
}

// ── Dedupe ledger ────────────────────────────────────────────────────────────

export const REMINDER_LEDGER_VERSION = 1

/**
 * How long a ledger entry is kept after the closing instant it refers to. The
 * point of the ledger is dedupe, not history: a tender that closed months ago
 * must not keep its entries forever, and nothing can be re-notified about a
 * deadline that is this far past.
 */
export const REMINDER_LEDGER_RETENTION_DAYS = 30

/**
 * Why a (tender, threshold, closing instant) is recorded.
 *
 *  - `notified` — the user was actually told.
 *  - `skipped-stale` — the threshold had already passed when the tender was
 *    first considered (the app was closed, or the tender was imported late), so
 *    it was deliberately NOT fired. Recorded so a burst of stale warnings can
 *    never be emitted later; the entry is honest about not having been shown.
 */
export type ReminderLedgerDisposition = 'notified' | 'skipped-stale'

export interface ReminderLedgerEntry {
  tenderId: string
  thresholdId: string
  /** The closing instant this decision was made for, as an ISO UTC string. */
  closingAt: string
  /** When the decision was made, as an ISO UTC string. */
  handledAt: string
  disposition: ReminderLedgerDisposition
}

/**
 * Serialisable dedupe memory. A reminder fires at most once per
 * (tender, threshold, closing instant), and the ledger survives an app restart
 * because it is plain JSON.
 */
export interface ReminderLedger {
  version: number
  entries: ReminderLedgerEntry[]
}

export function emptyReminderLedger(): ReminderLedger {
  return { version: REMINDER_LEDGER_VERSION, entries: [] }
}

function ledgerKey(tenderId: string, thresholdId: string, closingAt: string): string {
  return `${tenderId}\u0000${thresholdId}\u0000${closingAt}`
}

function isoInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  return isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * Read a ledger that came off disk (or from an older build).
 *
 * Fail-open toward notifying: a ledger whose `version` is not the one this build
 * writes is discarded, and entries that do not validate are dropped, because a
 * corrupt or misunderstood ledger must never SUPPRESS a warning about a closing
 * time. Re-notifying is a nuisance; silently missing the deadline is the failure
 * this module exists to prevent.
 */
export function parseReminderLedger(raw: unknown): ReminderLedger {
  const record = raw as { version?: unknown; entries?: unknown } | null | undefined
  if (!record || typeof record !== 'object' || Array.isArray(record)) return emptyReminderLedger()
  if (record.version !== REMINDER_LEDGER_VERSION) return emptyReminderLedger()

  const seen = new Set<string>()
  const entries: ReminderLedgerEntry[] = []
  for (const candidate of Array.isArray(record.entries) ? record.entries : []) {
    const entry = candidate as Partial<ReminderLedgerEntry> | null | undefined
    if (!entry || typeof entry !== 'object') continue
    const tenderId = typeof entry.tenderId === 'string' ? entry.tenderId.trim() : ''
    const thresholdId = typeof entry.thresholdId === 'string' ? entry.thresholdId.trim() : ''
    const closingAt = isoInstant(entry.closingAt)
    const handledAt = isoInstant(entry.handledAt) ?? closingAt
    if (!tenderId || !thresholdId || !closingAt || !handledAt) continue
    // Instants, not strings: `2026-11-30T09:00:00.000Z` and
    // `2026-11-30T11:00:00+02:00` are the same deadline and must suppress alike.
    const key = ledgerKey(tenderId, thresholdId, closingAt)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      tenderId,
      thresholdId,
      closingAt,
      handledAt,
      disposition: entry.disposition === 'skipped-stale' ? 'skipped-stale' : 'notified',
    })
  }
  return { version: REMINDER_LEDGER_VERSION, entries }
}

/** The ledger as the JSON to persist. Deterministic for a given ledger. */
export function serializeReminderLedger(ledger: ReminderLedger): string {
  return JSON.stringify(parseReminderLedger(ledger))
}

/**
 * Drop entries for deadlines that are long past, so the ledger cannot grow
 * forever. Pruning is by the CLOSING INSTANT and nothing else — deliberately not
 * by tender status: the lifecycle allows a tender to move backwards (a pack is
 * re-opened), and an entry dropped early would re-notify a deadline the user has
 * already been warned about.
 */
export function pruneReminderLedger(
  ledger: ReminderLedger,
  now: Date,
  retentionDays: number = REMINDER_LEDGER_RETENTION_DAYS,
): ReminderLedger {
  const parsed = parseReminderLedger(ledger)
  const nowMs = now.getTime()
  // An unusable clock must not be read as "everything is ancient": wiping the
  // ledger would re-notify deadlines the user has already been warned about.
  if (isNaN(nowMs)) return parsed
  const cutoffMs = nowMs - retentionDays * DAY_MS
  return {
    version: REMINDER_LEDGER_VERSION,
    entries: parsed.entries.filter((entry) => new Date(entry.closingAt).getTime() >= cutoffMs),
  }
}

function upsertEntries(
  ledger: ReminderLedger,
  additions: readonly ReminderLedgerEntry[],
): ReminderLedger {
  if (additions.length === 0) return ledger
  const entries = [...ledger.entries]
  const index = new Map(
    entries.map((entry, at) => [ledgerKey(entry.tenderId, entry.thresholdId, entry.closingAt), at]),
  )
  for (const addition of additions) {
    const key = ledgerKey(addition.tenderId, addition.thresholdId, addition.closingAt)
    const existing = index.get(key)
    if (existing === undefined) {
      index.set(key, entries.length)
      entries.push(addition)
    } else {
      entries[existing] = addition
    }
  }
  return { version: REMINDER_LEDGER_VERSION, entries }
}

// ── The schedule ─────────────────────────────────────────────────────────────

export interface DueReminder {
  tenderId: string
  tenderTitle: string
  /** The threshold this reminder fires for (the most urgent one crossed). */
  thresholdId: string
  thresholdLabel: string
  leadMs: number
  /** The closing instant this reminder is about, ISO UTC. */
  closingAt: string
  /** The closing value exactly as stored on the tender (raw, unparsed). */
  closingDate: string
  /** The instant this threshold became due: `closingAt - leadMs`, ISO UTC. */
  dueAt: string
  /** Time left until closing as of the `now` the schedule ran at. */
  remainingMs: number
  /**
   * True when the threshold instant had already passed before this reminder was
   * produced — the app was not running then (or the tender was imported late).
   * The copy must not pretend the user was warned on time.
   */
  late: boolean
  /** Crossed thresholds deliberately not fired, so they never fire later. */
  skippedThresholdIds: string[]
  skippedThresholdLabels: string[]
}

export interface DueRemindersResult {
  /** Reminders to show now, most urgent first. */
  reminders: DueReminder[]
  /**
   * The ledger to persist. It already records everything in `reminders` (plus
   * the stale thresholds that were deliberately skipped), so feeding it back
   * into the next call is what makes each reminder fire at most once.
   */
  ledger: ReminderLedger
}

function entryFor(
  tenderId: string,
  thresholdId: string,
  closingAt: string,
  handledAt: Date,
  disposition: ReminderLedgerDisposition,
): ReminderLedgerEntry {
  return { tenderId, thresholdId, closingAt, handledAt: handledAt.toISOString(), disposition }
}

/**
 * Which reminders are due right now.
 *
 * Pure: `now` and the sent-ledger are inputs, never read from the clock or from
 * disk. Rules, all documented because each one is a product decision:
 *
 *  - A threshold is crossed once `now >= closing - leadMs` (inclusive: a reminder
 *    is due exactly at its lead time, which is the instant a scheduler wakes).
 *  - Only open tenders are considered. A submitted / won / lost / archived
 *    tender is never reminded about its closing time.
 *  - A tender with no closing date, or one the canonical parser rejects, gets NO
 *    reminder — you cannot warn about a date you do not have — and no ledger
 *    entry (there is nothing to key on).
 *  - A tender whose closing instant has passed gets no reminder: it is too late
 *    to warn, and readiness already reports it as closed.
 *  - FIRST CONSIDERATION AFTER SEVERAL THRESHOLDS PASSED (a late import, or the
 *    app closed for days): at most ONE reminder fires — the most urgent crossed
 *    threshold — and every other crossed threshold is recorded as
 *    `skipped-stale`. Firing the week-out, three-day and one-day warnings at once
 *    would be a burst of stale alarms about a deadline that is already imminent;
 *    the single most urgent one carries the actionable fact (how long is left).
 *    The skipped thresholds are recorded, not left unsent, so they cannot trickle
 *    out one per call afterwards.
 *  - A MOVED DEADLINE IS NEVER SUPPRESSED: a ledger entry suppresses only the
 *    exact (tender, threshold, closing instant) it was written for. Moving the
 *    closing date — earlier or later — makes every existing entry refer to a
 *    deadline that no longer exists, so the thresholds for the new instant fire
 *    again.
 *  - Returning to a previously notified instant (A → B → A) IS suppressed: the
 *    entry for A was never invalidated. Documented rather than hidden — the user
 *    was told about that exact deadline.
 */
export function dueReminders(
  tenders: readonly ReminderTender[],
  settings: ReminderSettings,
  now: Date,
  alreadySent?: ReminderLedger,
): DueRemindersResult {
  const ledger = pruneReminderLedger(parseReminderLedger(alreadySent), now)
  const { enabled, thresholds } = normalizeReminderSettings(settings)
  if (!enabled || thresholds.length === 0) return { reminders: [], ledger }

  const handled = new Set(
    ledger.entries.map((entry) => ledgerKey(entry.tenderId, entry.thresholdId, entry.closingAt)),
  )
  const nowMs = now.getTime()
  const reminders: DueReminder[] = []
  const additions: ReminderLedgerEntry[] = []

  for (const tender of tenders) {
    if (!isOpenTenderStatus(tender.status)) continue
    const closing = parseClosingDate(tender.closingDate)
    if (!closing) continue
    const closingMs = closing.getTime()
    if (nowMs >= closingMs) continue
    const closingAt = closing.toISOString()

    const unsent = thresholds.filter(
      (threshold) =>
        nowMs >= closingMs - threshold.leadMs &&
        !handled.has(ledgerKey(tender.id, threshold.id, closingAt)),
    )
    if (unsent.length === 0) continue

    const chosen = unsent.reduce((best, candidate) =>
      candidate.leadMs < best.leadMs ? candidate : best,
    )
    const skipped = unsent.filter((threshold) => threshold.id !== chosen.id)
    const remainingMs = closingMs - nowMs

    reminders.push({
      tenderId: tender.id,
      tenderTitle: tender.title,
      thresholdId: chosen.id,
      thresholdLabel: chosen.label,
      leadMs: chosen.leadMs,
      closingAt,
      closingDate: tender.closingDate ?? '',
      dueAt: new Date(closingMs - chosen.leadMs).toISOString(),
      remainingMs,
      late: remainingMs < chosen.leadMs,
      skippedThresholdIds: skipped.map((threshold) => threshold.id),
      skippedThresholdLabels: skipped.map((threshold) => threshold.label),
    })

    for (const threshold of unsent) {
      // Record within the same pass too, so a duplicated tender row cannot fire
      // the same reminder twice in one call.
      handled.add(ledgerKey(tender.id, threshold.id, closingAt))
      additions.push(
        entryFor(
          tender.id,
          threshold.id,
          closingAt,
          now,
          threshold.id === chosen.id ? 'notified' : 'skipped-stale',
        ),
      )
    }
  }

  reminders.sort(
    (a, b) =>
      a.remainingMs - b.remainingMs ||
      a.tenderId.localeCompare(b.tenderId) ||
      a.thresholdId.localeCompare(b.thresholdId),
  )
  return { reminders, ledger: upsertEntries(ledger, additions) }
}

/**
 * Record reminders as shown. `dueReminders` already does this, so this is for a
 * caller that displayed only a subset (the OS refused some, or the user muted
 * one): record exactly what was shown and hand the result back next time.
 */
export function markRemindersSent(
  ledger: ReminderLedger,
  reminders: readonly DueReminder[],
  sentAt: Date,
): ReminderLedger {
  const parsed = parseReminderLedger(ledger)
  return upsertEntries(
    parsed,
    reminders.map((reminder) =>
      entryFor(reminder.tenderId, reminder.thresholdId, reminder.closingAt, sentAt, 'notified'),
    ),
  )
}

/**
 * Undo the recording of reminders that were due but never reached the user, so
 * the next call re-arms them. A dropped notification is a missed deadline, so
 * the failure path must be able to put the schedule back rather than swallow it.
 */
export function forgetReminders(
  ledger: ReminderLedger,
  reminders: readonly DueReminder[],
): ReminderLedger {
  const parsed = parseReminderLedger(ledger)
  const keys = new Set(
    reminders.map((reminder) =>
      ledgerKey(reminder.tenderId, reminder.thresholdId, reminder.closingAt),
    ),
  )
  return {
    version: REMINDER_LEDGER_VERSION,
    entries: parsed.entries.filter(
      (entry) => !keys.has(ledgerKey(entry.tenderId, entry.thresholdId, entry.closingAt)),
    ),
  }
}

/**
 * The earliest future instant at which an unrecorded threshold becomes due, so a
 * scheduler can sleep until then instead of polling. Returns `null` when nothing
 * is scheduled. Only strictly-future instants are reported: a threshold that is
 * already crossed is `dueReminders`' job, not a timer's.
 */
export function nextReminderAt(
  tenders: readonly ReminderTender[],
  settings: ReminderSettings,
  now: Date,
  alreadySent?: ReminderLedger,
): Date | null {
  const ledger = pruneReminderLedger(parseReminderLedger(alreadySent), now)
  const { enabled, thresholds } = normalizeReminderSettings(settings)
  if (!enabled || thresholds.length === 0) return null

  const handled = new Set(
    ledger.entries.map((entry) => ledgerKey(entry.tenderId, entry.thresholdId, entry.closingAt)),
  )
  const nowMs = now.getTime()
  let earliest = Infinity

  for (const tender of tenders) {
    if (!isOpenTenderStatus(tender.status)) continue
    const closing = parseClosingDate(tender.closingDate)
    if (!closing) continue
    const closingMs = closing.getTime()
    if (nowMs >= closingMs) continue
    const closingAt = closing.toISOString()
    for (const threshold of thresholds) {
      const dueAtMs = closingMs - threshold.leadMs
      if (dueAtMs <= nowMs) continue
      if (handled.has(ledgerKey(tender.id, threshold.id, closingAt))) continue
      if (dueAtMs < earliest) earliest = dueAtMs
    }
  }
  return earliest === Infinity ? null : new Date(earliest)
}

// ── Honest copy ──────────────────────────────────────────────────────────────

/**
 * The reminder's closing instant, in the words the countdown badge uses plus the
 * honesty suffix: an SAST-anchored civil value says `SAST`, a value carrying an
 * explicit offset says it is the reader's own clock. Both the rendering and the
 * timezone decision come from `./readiness` — the module that owns closing-date
 * parsing and the SAST anchor — so the badge and this sentence are one
 * implementation rather than two that agree by inspection.
 */
function renderClosingInstant(closingAt: string, raw: string): string {
  const date = new Date(closingAt)
  if (isNaN(date.getTime())) return raw.trim() || closingAt
  const timeZone = closingDisplayTimeZone(raw)
  return `${formatClosingInstant(date, raw)} ${timeZone ? 'SAST' : '(your local time)'}`
}

/**
 * The honest user-facing sentence: which tender, which lead time, how long is
 * left, and the closing instant in SAST. It states the remaining time as of the
 * `now` the schedule ran at (a reminder carries that instant rather than reading
 * a clock), and it never claims readiness, confirmation or compliance — a
 * reminder is a deadline fact, not a verdict on the bid.
 */
export function describeReminder(reminder: DueReminder): string {
  const closing = renderClosingInstant(reminder.closingAt, reminder.closingDate)
  if (reminder.remainingMs <= 0) {
    return `${reminder.tenderTitle} has closed — it closed ${formatDeadlineDelta(reminder.remainingMs)} ago (${closing}).`
  }
  return `${reminder.tenderTitle} closes in ${formatDeadlineDelta(reminder.remainingMs)} — ${closing} (${reminder.thresholdLabel} before closing).`
}

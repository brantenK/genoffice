/**
 * DEADLINE REMINDERS — the main-process scheduler and its OS notification path.
 *
 * Regression context (verified audit finding): Zanostack Tenders had NO reminder
 * mechanism at all — a manual `.ics` export and an on-screen countdown, nothing
 * that survives closing the app — so a user who shut the app was never warned
 * about a closing time, which is the product's stated job. `main/reminders-scheduler.ts`
 * is the first code in this fork to raise an Electron `Notification`, and these
 * tests prove the properties that make that safe:
 *
 *  - ONCE-ONLY across repeated checks AND across a restart (the ledger round-trips
 *    through the real file, and a second scheduler instance is what a restart is);
 *  - a corrupt, over-size or unrecognised state file FAILS TOWARD NOTIFYING,
 *    never toward silence;
 *  - a failure in the tender reader, the notifier or the disk never kills the
 *    schedule and never loses the ledger;
 *  - settings persist and are honoured, including "no reminders at all";
 *  - `start()`/`stop()` are idempotent and `stop()` leaves no pending timer;
 *  - the notification copy is `describeReminder`'s sentence and never claims a
 *    bid is ready, confirmed or compliant.
 *
 * Everything is injected: the clock, the notifier, the tender reader, the timer
 * primitives and the logger. No test touches the network, waits on a real
 * deadline, or imports Electron — the Electron-present path is proved with a
 * structural fake, and the Electron-absent path with a loader that returns null.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REMINDER_CHECK_INTERVAL_MS,
  MAX_REMINDERS_STATE_BYTES,
  NOTIFICATIONS_UNAVAILABLE_MESSAGE,
  NOTIFICATIONS_UNSUPPORTED_MESSAGE,
  REMINDERS_RUNTIME_LIMITATION,
  REMINDERS_STATE_VERSION,
  REMINDER_NOTIFICATION_TITLE,
  REMINDER_NOTIFICATION_TITLE_LATE,
  composeReminderNotification,
  createElectronNotifier,
  createRemindersScheduler,
  remindersStateDir,
  remindersStatePath,
  type ElectronNotificationConstructor,
  type ElectronNotificationLike,
  type ReadReminderTenders,
  type ReminderLogEvent,
  type ReminderNotification,
  type RemindersScheduler,
  type RemindersSchedulerOptions,
  type ReminderTimerHandle,
} from '../src/main/reminders-scheduler'
import {
  DEFAULT_REMINDER_THRESHOLDS,
  describeReminder,
  type ReminderLedger,
  type ReminderLedgerEntry,
  type ReminderSettings,
  type ReminderTender,
} from '../src/shared/reminders'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "30 November 2026 at 11:00" is 11:00 SAST = 09:00Z (the canonical anchoring). */
const CLOSING_RAW = '30 November 2026 at 11:00'
const CLOSING = new Date('2026-11-30T09:00:00.000Z')
/** The fixture instant the 7-day mark falls on: exactly seven days before closing. */
const NOW_MS = CLOSING.getTime() - 7 * DAY

let dir: string
let nowMs: number
let tenders: ReminderTender[]
let reader: ReadReminderTenders
let sent: ReminderNotification[]
let logs: ReminderLogEvent[]
let timers: Map<ReminderTimerHandle, () => void>
let cleared: ReminderTimerHandle[]
let timerIds: number

function tender(overrides: Partial<ReminderTender> = {}): ReminderTender {
  return {
    id: 't-1',
    title: 'Roads rehabilitation RFP',
    closingDate: CLOSING_RAW,
    status: 'IN_PROGRESS',
    ...overrides,
  }
}

function entry(overrides: Partial<ReminderLedgerEntry> = {}): ReminderLedgerEntry {
  return {
    tenderId: 't-1',
    thresholdId: '7d',
    closingAt: CLOSING.toISOString(),
    handledAt: new Date(NOW_MS).toISOString(),
    disposition: 'notified',
    ...overrides,
  }
}

function ledgerWith(entries: ReminderLedgerEntry[]): ReminderLedger {
  return { version: 1, entries }
}

/** A scheduler wired to the injected clock, notifier, reader, timers and log. */
function build(overrides: Partial<RemindersSchedulerOptions> = {}): RemindersScheduler {
  return createRemindersScheduler({
    userDataDir: dir,
    now: () => new Date(nowMs),
    notify: (notification) => {
      sent.push(notification)
    },
    readTenders: () => reader(),
    intervalMs: HOUR,
    log: (event) => {
      logs.push(event)
    },
    setIntervalImpl: (callback) => {
      timerIds += 1
      const handle = { id: timerIds } as unknown as ReminderTimerHandle
      timers.set(handle, callback)
      return handle
    },
    clearIntervalImpl: (handle) => {
      cleared.push(handle)
      timers.delete(handle)
    },
    ...overrides,
  })
}

async function seedState(payload: string | object): Promise<void> {
  await mkdir(remindersStateDir(dir), { recursive: true })
  await writeFile(
    remindersStatePath(dir),
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    'utf8',
  )
}

async function stateFile(): Promise<{
  version?: unknown
  settings?: ReminderSettings
  ledger?: ReminderLedger
}> {
  return JSON.parse(await readFile(remindersStatePath(dir), 'utf8'))
}

async function stateFileExists(): Promise<boolean> {
  try {
    await readFile(remindersStatePath(dir), 'utf8')
    return true
  } catch {
    return false
  }
}

function messages(): string[] {
  return logs.map((event) => event.message)
}

/** The persisted ledger, or null when no state file has been written. */
async function persistedLedger(): Promise<ReminderLedger | null> {
  if (!(await stateFileExists())) return null
  return (await stateFile()).ledger ?? null
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenders-reminders-'))
  nowMs = NOW_MS
  tenders = [tender()]
  reader = async () => tenders
  sent = []
  logs = []
  timers = new Map()
  cleared = []
  timerIds = 0
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ── timer lifecycle ──────────────────────────────────────────────────────────

describe('timer lifecycle', () => {
  it('start() schedules one periodic check and is idempotent', async () => {
    const scheduler = build()
    scheduler.start()
    expect(timers.size).toBe(1)
    scheduler.start()
    scheduler.start()
    expect(timers.size).toBe(1)
    scheduler.stop()
    await scheduler.checkNow()
  })

  it('stop() clears the pending timer, is idempotent, and is safe before start()', async () => {
    const scheduler = build()
    scheduler.start()
    const [handle] = [...timers.keys()]
    scheduler.stop()
    expect(cleared).toEqual([handle])
    expect(timers.size).toBe(0)
    scheduler.stop()
    expect(cleared).toHaveLength(1)

    const never = build()
    expect(() => never.stop()).not.toThrow()
    expect(cleared).toHaveLength(1)
    await scheduler.checkNow()
  })

  it('the default timer seam uses the global setInterval and clearInterval', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    try {
      const scheduler = build({
        setIntervalImpl: undefined,
        clearIntervalImpl: undefined,
        intervalMs: 3_600_000,
      })
      scheduler.start()
      // Flush the immediate check so nothing is still in flight when the temp
      // directory goes away, then stop so no real timer outlives the test.
      await scheduler.checkNow()
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 3_600_000)
      const handle = setIntervalSpy.mock.results[0]?.value as ReminderTimerHandle
      scheduler.stop()
      expect(clearIntervalSpy).toHaveBeenCalledWith(handle)
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  it('the scheduled callback runs a check', async () => {
    tenders = []
    const scheduler = build()
    scheduler.start()
    await scheduler.checkNow()
    expect(sent).toHaveLength(0)

    tenders = [tender()]
    for (const callback of [...timers.values()]) callback()
    // Queued behind the callback's own check, so this resolves after it ran.
    await scheduler.checkNow()
    expect(sent).toHaveLength(1)
    scheduler.stop()
  })

  it('start() runs one immediate check, so a deadline crossed while closed is surfaced on open', async () => {
    const scheduler = build()
    scheduler.start()
    // Queued behind the immediate check: proves it ran, and that it ran once.
    const result = await scheduler.checkNow()
    expect(result.fired).toBe(0)
    expect(sent).toHaveLength(1)
    expect(await stateFileExists()).toBe(true)
    scheduler.stop()
  })

  it('start() reports the while-running-only limitation through the log hook', async () => {
    const scheduler = build()
    scheduler.start()
    await scheduler.checkNow()
    expect(messages()).toContain(REMINDERS_RUNTIME_LIMITATION)
    scheduler.stop()
  })
})

// ── once-only and durability ─────────────────────────────────────────────────

describe('once-only and durability', () => {
  it('a due reminder notifies exactly once, however often checkNow runs', async () => {
    const scheduler = build()
    const first = await scheduler.checkNow()
    expect(first.fired).toBe(1)
    expect(first.reminders).toHaveLength(1)
    expect(first.reminders[0].thresholdId).toBe('7d')
    expect(sent).toHaveLength(1)

    const second = await scheduler.checkNow()
    const third = await scheduler.checkNow()
    expect(second.fired).toBe(0)
    expect(second.reminders).toEqual([])
    expect(third.fired).toBe(0)
    expect(sent).toHaveLength(1)
    expect(second.ledger.entries).toHaveLength(first.ledger.entries.length)
  })

  it('the ledger survives a restart in a fresh scheduler and still does not double-fire', async () => {
    const before = build()
    expect((await before.checkNow()).fired).toBe(1)

    // A fresh instance over the same directory is what an app restart is.
    const after = build()
    const state = await after.readState()
    expect(state.ledger.entries).toHaveLength(1)
    expect(state.ledger.entries[0].disposition).toBe('notified')
    expect((await after.checkNow()).fired).toBe(0)
    expect(sent).toHaveLength(1)
  })

  it('a moved closing date is never suppressed by the old ledger', async () => {
    const scheduler = build()
    expect((await scheduler.checkNow()).fired).toBe(1)

    // The RFP extends the deadline by half an hour, with `now` already past the
    // old 7-day mark. Entries are keyed by the closing INSTANT, so the new
    // instant's thresholds are unrecorded and warn again.
    nowMs = CLOSING.getTime() - 7 * DAY + HOUR
    tenders = [tender({ closingDate: '30 November 2026 at 11:30' })]
    const moved = await scheduler.checkNow()
    expect(moved.fired).toBe(1)
    expect(moved.reminders[0].closingAt).toBe('2026-11-30T09:30:00.000Z')
    expect(sent).toHaveLength(2)
    expect(sent[1].reminder.closingAt).not.toBe(sent[0].reminder.closingAt)
  })

  it('concurrent checkNow calls fire once, because checks are serialised', async () => {
    const scheduler = build()
    const [left, right] = await Promise.all([scheduler.checkNow(), scheduler.checkNow()])
    expect(left.fired + right.fired).toBe(1)
    expect(sent).toHaveLength(1)
  })
})

// ── settings ─────────────────────────────────────────────────────────────────

describe('settings', () => {
  it('writeSettings persists and is honoured by the next check', async () => {
    const scheduler = build()
    const written = await scheduler.writeSettings({ enabled: false })
    expect(written.enabled).toBe(false)
    expect(written.thresholds).toHaveLength(DEFAULT_REMINDER_THRESHOLDS.length)

    expect((await scheduler.checkNow()).fired).toBe(0)
    expect(sent).toHaveLength(0)

    // Re-enabling must still warn: a disabled schedule records nothing.
    await scheduler.writeSettings({ enabled: true })
    expect((await scheduler.checkNow()).fired).toBe(1)
    expect(sent).toHaveLength(1)
  })

  it('a disabled schedule writes no ledger entries', async () => {
    const scheduler = build()
    await scheduler.writeSettings({ enabled: false })
    await scheduler.checkNow()
    expect((await stateFile()).ledger?.entries).toEqual([])
  })

  it('writeSettings returns the normalized settings it persisted, keeping the rest of a partial', async () => {
    const scheduler = build()
    const disabled = await scheduler.writeSettings({ enabled: false })
    expect(disabled).toEqual({ enabled: false, thresholds: DEFAULT_REMINDER_THRESHOLDS })

    const narrowed = await scheduler.writeSettings({
      thresholds: [{ id: 'z', label: 'z', leadMs: HOUR }],
    })
    expect(narrowed.enabled).toBe(false)
    expect(narrowed.thresholds).toEqual([{ id: 'z', label: 'z', leadMs: HOUR }])

    const junk = await scheduler.writeSettings({
      thresholds: [{ id: '  ', label: '', leadMs: 0 }],
    })
    expect(junk.thresholds).toEqual([])
    expect(await scheduler.writeSettings({})).toEqual(junk)
  })

  it('an explicitly empty threshold list means no reminders, and stays empty across a restart', async () => {
    const scheduler = build()
    await scheduler.writeSettings({ thresholds: [] })
    expect((await scheduler.checkNow()).fired).toBe(0)
    expect(sent).toHaveLength(0)
    expect((await build().readState()).settings.thresholds).toEqual([])
  })

  it('settings survive a restart', async () => {
    const scheduler = build()
    await scheduler.writeSettings({
      enabled: false,
      thresholds: [{ id: '3d', label: '3 days', leadMs: 3 * DAY }],
    })
    const state = await build().readState()
    expect(state.settings).toEqual({
      enabled: false,
      thresholds: [{ id: '3d', label: '3 days', leadMs: 3 * DAY }],
    })
  })

  it('writeSettings rejects when it cannot persist, so a caller is never told otherwise', async () => {
    // A file where the directory should be: every mkdir/write under it fails.
    await writeFile(join(dir, 'tenders'), 'not a directory', 'utf8')
    const scheduler = build()
    await expect(scheduler.writeSettings({ enabled: false })).rejects.toThrow()
    // Nothing was persisted, so the settings are still the documented defaults.
    expect((await scheduler.readState()).settings.enabled).toBe(true)
  })
})

// ── corrupt and hostile state files ──────────────────────────────────────────

describe('state-file failures fail toward notifying', () => {
  it('a corrupt state file is treated as no ledger, then rewritten as valid', async () => {
    await seedState('{ this is not json')
    const scheduler = build()
    const result = await scheduler.checkNow()
    expect(result.fired).toBe(1)
    expect(sent).toHaveLength(1)
    expect(messages().some((message) => message.includes('damaged'))).toBe(true)
    expect((await stateFile()).ledger?.entries).toHaveLength(1)
  })

  it('an over-size state file is treated as no ledger', async () => {
    const padding = 'x'.repeat(MAX_REMINDERS_STATE_BYTES + 1024)
    await seedState(
      `{"version":1,"settings":{},"ledger":{"version":1,"entries":[]},"pad":"${padding}"}`,
    )
    const scheduler = build()
    expect((await scheduler.checkNow()).fired).toBe(1)
    expect(
      messages().some((message) => message.includes(`above the ${MAX_REMINDERS_STATE_BYTES}-byte`)),
    ).toBe(true)
  })

  it('a state file from another version is ignored rather than trusted to suppress', async () => {
    const settings = { enabled: true, thresholds: [...DEFAULT_REMINDER_THRESHOLDS] }
    // With the current version, this entry suppresses the only crossed threshold.
    await seedState({ version: REMINDERS_STATE_VERSION, settings, ledger: ledgerWith([entry()]) })
    expect((await build().checkNow()).fired).toBe(0)

    // From an unrecognised version, it must not suppress anything.
    await seedState({ version: 99, settings, ledger: ledgerWith([entry()]) })
    const scheduler = build()
    expect((await scheduler.checkNow()).fired).toBe(1)
    expect(messages().some((message) => message.includes('form this version does not use'))).toBe(
      true,
    )
  })
})

// ── which tenders are considered ─────────────────────────────────────────────

describe('which tenders are considered', () => {
  it('a non-open tender produces nothing', async () => {
    const scheduler = build()
    for (const status of ['SUBMITTED', 'WON', 'LOST', 'ARCHIVED'] as const) {
      tenders = [tender({ status })]
      expect((await scheduler.checkNow()).fired).toBe(0)
    }
    expect(sent).toHaveLength(0)
  })

  it('a tender with no closing date produces nothing and records nothing', async () => {
    tenders = [tender({ closingDate: '' })]
    const scheduler = build()
    expect((await scheduler.checkNow()).fired).toBe(0)
    expect(await stateFileExists()).toBe(false)
  })

  it('a tender whose closing instant has passed produces nothing', async () => {
    nowMs = CLOSING.getTime() + MINUTE
    const scheduler = build()
    expect((await scheduler.checkNow()).fired).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('only the most urgent crossed threshold fires, and the rest are recorded as skipped', async () => {
    // 90 minutes before closing: the 7-day, 3-day, 1-day and 2-hour marks are all
    // crossed, and exactly one warning — the actionable one — is shown.
    nowMs = CLOSING.getTime() - 90 * MINUTE
    const scheduler = build()
    const result = await scheduler.checkNow()
    expect(result.fired).toBe(1)
    expect(result.reminders[0].thresholdId).toBe('2h')
    expect(result.reminders[0].skippedThresholdIds.sort()).toEqual(['1d', '3d', '7d'])

    const entries = (await persistedLedger())?.entries ?? []
    expect(entries).toHaveLength(4)
    expect(entries.filter((item) => item.disposition === 'notified')).toHaveLength(1)
    expect(entries.filter((item) => item.disposition === 'skipped-stale')).toHaveLength(3)
  })
})

// ── failures are contained ───────────────────────────────────────────────────

describe('failures are contained', () => {
  it('a throwing tender reader is contained, loses no ledger, and leaves no double-fire', async () => {
    const scheduler = build()
    expect((await scheduler.checkNow()).fired).toBe(1)
    expect(sent).toHaveLength(1)

    reader = async () => {
      throw new Error('store unavailable')
    }
    const failed = await scheduler.checkNow()
    expect(failed.fired).toBe(0)
    expect(failed.reminders).toEqual([])
    expect(messages().some((message) => message.includes('store unavailable'))).toBe(true)
    expect((await persistedLedger())?.entries).toHaveLength(1)

    reader = async () => tenders
    expect((await scheduler.checkNow()).fired).toBe(0)
    expect(sent).toHaveLength(1)
  })

  it('a reader that returns something other than a list is contained', async () => {
    reader = (async () => ({ id: 't-1' })) as unknown as ReadReminderTenders
    const scheduler = build()
    const result = await scheduler.checkNow()
    expect(result.fired).toBe(0)
    expect(messages().some((message) => message.includes('not a list of tenders'))).toBe(true)
  })

  it('no tender source at all is reported and still resolves', async () => {
    const scheduler = build({ readTenders: undefined })
    const result = await scheduler.checkNow()
    expect(result).toEqual({ fired: 0, reminders: [], ledger: { version: 1, entries: [] } })
    expect(messages().some((message) => message.includes('No tender source'))).toBe(true)
  })

  it('a throwing notifier is contained, is reported per reminder, and does not retry forever', async () => {
    const scheduler = build({
      notify: () => {
        throw new Error('notification service refused')
      },
    })
    const result = await scheduler.checkNow()
    expect(result.fired).toBe(1)
    expect(sent).toHaveLength(0)
    const failure = logs.find((event) => event.message.includes('notification service refused'))
    expect(failure?.level).toBe('warn')
    expect(failure?.tenderId).toBe('t-1')
    expect(failure?.thresholdId).toBe('7d')
    expect((await persistedLedger())?.entries).toHaveLength(1)
    expect((await scheduler.checkNow()).fired).toBe(0)
  })

  it('a disk write failure is contained and checkNow still resolves with the decision', async () => {
    await writeFile(join(dir, 'tenders'), 'not a directory', 'utf8')
    const scheduler = build()
    const result = await scheduler.checkNow()
    expect(result.fired).toBe(1)
    expect(result.reminders).toHaveLength(1)
    expect(messages().some((message) => message.includes('could not be saved'))).toBe(true)
  })

  it('setReadTenders swaps the source used by later checks', async () => {
    const scheduler = build({ readTenders: async () => [] })
    expect((await scheduler.checkNow()).fired).toBe(0)
    scheduler.setReadTenders(async () => [tender()])
    expect((await scheduler.checkNow()).fired).toBe(1)
  })

  it('an unusable setReadTenders argument keeps the source it had', async () => {
    const scheduler = build()
    scheduler.setReadTenders(undefined as unknown as ReadReminderTenders)
    expect((await scheduler.checkNow()).fired).toBe(1)
    expect(messages().some((message) => message.includes('kept the one it had'))).toBe(true)
  })
})

// ── bounds ───────────────────────────────────────────────────────────────────

describe('bounds', () => {
  it('pruning on write drops long-past entries so the file cannot grow forever', async () => {
    const ancient = Array.from({ length: 200 }, (_, index) =>
      entry({
        tenderId: `old-${index}`,
        closingAt: new Date(NOW_MS - 400 * DAY).toISOString(),
        disposition: 'notified',
      }),
    )
    const retained = entry({
      tenderId: 'future',
      thresholdId: '7d',
      closingAt: new Date(NOW_MS + 40 * DAY).toISOString(),
    })
    await seedState({
      version: REMINDERS_STATE_VERSION,
      settings: { enabled: true, thresholds: [...DEFAULT_REMINDER_THRESHOLDS] },
      ledger: ledgerWith([...ancient, retained]),
    })
    const before = Buffer.byteLength(await readFile(remindersStatePath(dir), 'utf8'), 'utf8')

    const scheduler = build({ readTenders: async () => [] })
    expect((await scheduler.checkNow()).fired).toBe(0)
    const after = Buffer.byteLength(await readFile(remindersStatePath(dir), 'utf8'), 'utf8')
    const entries = (await persistedLedger())?.entries ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0].tenderId).toBe('future')
    expect(after).toBeLessThan(before)
  })
})

// ── the Electron notification path ───────────────────────────────────────────

class FakeNotification implements ElectronNotificationLike {
  static shown: { title: string; body: string }[] = []
  static supported = true
  static isSupported(): boolean {
    return FakeNotification.supported
  }
  constructor(private readonly options: { title: string; body: string }) {}
  show(): void {
    FakeNotification.shown.push(this.options)
  }
}

const THROWING_NOTIFICATION = class {
  static isSupported(): boolean {
    return true
  }
  constructor(_options: { title: string; body: string }) {}
  show(): void {
    throw new Error('the desktop refused the notification')
  }
} as unknown as ElectronNotificationConstructor

describe('the Electron notification path', () => {
  beforeEach(() => {
    FakeNotification.shown = []
    FakeNotification.supported = true
  })

  it('the built-in default notifier is safe with no injection at all', async () => {
    // No `notify` override, so this is the real default path in this environment,
    // where Electron's Notification may be present or absent. Either way the
    // schedule must survive it and record the decision exactly once.
    const scheduler = build({ notify: undefined })
    const result = await scheduler.checkNow()
    expect(result.fired).toBe(1)
    expect(sent).toHaveLength(0)
    expect((await persistedLedger())?.entries).toHaveLength(1)
    expect((await scheduler.checkNow()).fired).toBe(0)
  })

  it('the default notifier degrades gracefully when Electron is absent', async () => {
    const notifier = createElectronNotifier({
      log: (event) => logs.push(event),
      loadElectron: () => null,
    })
    const scheduler = build({ notify: notifier })
    const result = await scheduler.checkNow()

    expect(result.fired).toBe(1)
    expect(FakeNotification.shown).toHaveLength(0)
    const unavailable = logs.find((event) => event.message === NOTIFICATIONS_UNAVAILABLE_MESSAGE)
    expect(unavailable?.level).toBe('warn')
    expect(unavailable?.tenderId).toBe('t-1')
    // Still recorded, so the same reminder cannot fire again when they come back.
    expect((await persistedLedger())?.entries).toHaveLength(1)
    expect((await scheduler.checkNow()).fired).toBe(0)
  })

  it('the default notifier reports an unsupported platform without throwing', async () => {
    FakeNotification.supported = false
    const notifier = createElectronNotifier({
      log: (event) => logs.push(event),
      loadElectron: () => ({ Notification: FakeNotification }),
    })
    const scheduler = build({ notify: notifier })
    expect((await scheduler.checkNow()).fired).toBe(1)
    expect(FakeNotification.shown).toHaveLength(0)
    expect(messages()).toContain(NOTIFICATIONS_UNSUPPORTED_MESSAGE)
  })

  it('the default notifier shows a notification through Electron when one is available', async () => {
    const notifier = createElectronNotifier({
      log: (event) => logs.push(event),
      loadElectron: () => ({ Notification: FakeNotification }),
    })
    const scheduler = build({ notify: notifier })
    const result = await scheduler.checkNow()

    expect(FakeNotification.shown).toHaveLength(1)
    expect(FakeNotification.shown[0].title).toBe(REMINDER_NOTIFICATION_TITLE)
    expect(FakeNotification.shown[0].body).toBe(describeReminder(result.reminders[0]))
    expect(logs).toEqual([])
  })

  it('a throwing Electron notification is contained and reported per reminder', async () => {
    const notifier = createElectronNotifier({
      log: (event) => logs.push(event),
      loadElectron: () => ({ Notification: THROWING_NOTIFICATION }),
    })
    const scheduler = build({ notify: notifier })
    const result = await scheduler.checkNow()
    expect(result.fired).toBe(1)
    expect(
      logs.some((event) => event.message.includes('the desktop refused the notification')),
    ).toBe(true)
    expect((await persistedLedger())?.entries).toHaveLength(1)
  })
})

// ── honest copy ──────────────────────────────────────────────────────────────

describe('notification copy is honest', () => {
  const READINESS_WORDS = /\b(ready|confirmed|compliant|compliance|submitted|approved)\b/i

  it("the body is describeReminder's sentence and claims nothing about the bid", async () => {
    const scheduler = build()
    const result = await scheduler.checkNow()
    const [notification] = sent
    expect(notification.body).toBe(describeReminder(result.reminders[0]))
    expect(notification.title).toBe(REMINDER_NOTIFICATION_TITLE)
    expect(`${notification.title} ${notification.body}`).not.toMatch(READINESS_WORDS)
    expect(notification.reminder.late).toBe(false)
  })

  it('a late warning says it is late instead of pretending it arrived on time', async () => {
    // Six days out: the 7-day mark passed while the app was closed.
    nowMs = CLOSING.getTime() - 6 * DAY
    const scheduler = build()
    const result = await scheduler.checkNow()
    const [notification] = sent
    expect(result.reminders[0].late).toBe(true)
    expect(notification.title).toBe(REMINDER_NOTIFICATION_TITLE_LATE)
    expect(notification.body.startsWith(describeReminder(result.reminders[0]))).toBe(true)
    expect(notification.body).toContain('This warning is late')
    expect(notification.body).toContain('7 days')
    expect(`${notification.title} ${notification.body}`).not.toMatch(READINESS_WORDS)
  })

  it('composeReminderNotification carries the reminder through unchanged', () => {
    const reminder = {
      tenderId: 't-9',
      tenderTitle: 'Water treatment works',
      thresholdId: '2h',
      thresholdLabel: '2 hours',
      leadMs: 2 * HOUR,
      closingAt: CLOSING.toISOString(),
      closingDate: CLOSING_RAW,
      dueAt: new Date(CLOSING.getTime() - 2 * HOUR).toISOString(),
      remainingMs: 30 * MINUTE,
      late: false,
      skippedThresholdIds: [],
      skippedThresholdLabels: [],
    }
    const notification = composeReminderNotification(reminder)
    expect(notification.reminder).toBe(reminder)
    expect(notification.body).toBe(describeReminder(reminder))
  })

  it('the default check interval is the documented quarter hour', () => {
    expect(DEFAULT_REMINDER_CHECK_INTERVAL_MS).toBe(15 * MINUTE)
  })
})

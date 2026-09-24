/**
 * DEADLINE REMINDERS — the pure scheduling core.
 *
 * Regression context (verified audit finding): Zanostack Tenders had NO reminder
 * mechanism at all — a manual `.ics` export and an on-screen countdown, nothing
 * that survives closing the app — so a user who shut the app was never warned
 * about a closing time, which is the product's stated job. These tests cover the
 * schedule underneath the Electron `Notification` path with no Electron, no real
 * clock and no storage: `now` and the sent-ledger are always passed in.
 *
 * The invariant that matters is ONCE-ONLY: a reminder that fires twice is the
 * failure a user notices, so the once-only guarantee is proved by calling the
 * function repeatedly with the ledger it returned (including after a JSON
 * round-trip, which is what an app restart is).
 */
import { describe, expect, it } from 'vitest'
import { formatDeadlineDelta } from '../src/shared/readiness'
import {
  DEFAULT_REMINDER_SETTINGS,
  DEFAULT_REMINDER_THRESHOLDS,
  REMINDER_LEDGER_RETENTION_DAYS,
  describeReminder,
  dueReminders,
  emptyReminderLedger,
  forgetReminders,
  isOpenTenderStatus,
  markRemindersSent,
  nextReminderAt,
  normalizeReminderSettings,
  parseReminderLedger,
  pruneReminderLedger,
  serializeReminderLedger,
  type DueReminder,
  type ReminderLedger,
  type ReminderTender,
} from '../src/shared/reminders'
import { deadlineStatus } from '../src/renderer/src/deadline'
import type { TenderStatus } from '../src/shared/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "30 November 2026 at 11:00" is 11:00 SAST = 09:00Z (the canonical anchoring). */
const CLOSING_RAW = '30 November 2026 at 11:00'
const CLOSING = new Date('2026-11-30T09:00:00.000Z')

/** The instant each default threshold becomes due, computed independently here. */
const DUE = {
  '7d': new Date(CLOSING.getTime() - 7 * DAY),
  '3d': new Date(CLOSING.getTime() - 3 * DAY),
  '1d': new Date(CLOSING.getTime() - DAY),
  '2h': new Date(CLOSING.getTime() - 2 * HOUR),
}

function tender(overrides: Partial<ReminderTender> = {}): ReminderTender {
  return {
    id: 't-1',
    title: 'Roads rehabilitation RFP',
    closingDate: CLOSING_RAW,
    status: 'IN_PROGRESS',
    ...overrides,
  }
}

function fire(
  now: Date,
  options: {
    tenders?: ReminderTender[]
    ledger?: ReminderLedger
    settings?: Parameters<typeof dueReminders>[1]
  } = {},
) {
  return dueReminders(
    options.tenders ?? [tender()],
    options.settings ?? DEFAULT_REMINDER_SETTINGS,
    now,
    options.ledger,
  )
}

// ── Settings ─────────────────────────────────────────────────────────────────

describe('reminder settings', () => {
  it('ships the documented default lead times, longest first, with unique ids', () => {
    expect(DEFAULT_REMINDER_SETTINGS.enabled).toBe(true)
    expect(DEFAULT_REMINDER_THRESHOLDS.map((t) => t.id)).toEqual(['7d', '3d', '1d', '2h'])
    expect(DEFAULT_REMINDER_THRESHOLDS.map((t) => t.leadMs)).toEqual([
      7 * DAY,
      3 * DAY,
      1 * DAY,
      2 * HOUR,
    ])
    expect(DEFAULT_REMINDER_THRESHOLDS.map((t) => t.label)).toEqual([
      '7 days',
      '3 days',
      '1 day',
      '2 hours',
    ])
  })

  it('falls back to the default list when thresholds are absent, and does not share state', () => {
    const normalized = normalizeReminderSettings(undefined)
    expect(normalized).toEqual(DEFAULT_REMINDER_SETTINGS)
    expect(normalized.thresholds).not.toBe(DEFAULT_REMINDER_THRESHOLDS)
    normalized.thresholds.pop()
    expect(DEFAULT_REMINDER_SETTINGS.thresholds).toHaveLength(4)
  })

  it('treats an explicitly empty list as "no reminders" rather than restoring defaults', () => {
    expect(normalizeReminderSettings({ thresholds: [] })).toEqual({ enabled: true, thresholds: [] })
    expect(fire(DUE['2h'], { settings: { enabled: true, thresholds: [] } }).reminders).toEqual([])
  })

  it('drops unusable thresholds, keeps the first of duplicate ids and sorts by lead time', () => {
    const normalized = normalizeReminderSettings({
      thresholds: [
        { id: '  ', label: 'blank', leadMs: HOUR },
        { id: 'zero', label: 'zero', leadMs: 0 },
        { id: 'nan', label: 'nan', leadMs: Number.NaN },
        { id: 'neg', label: 'neg', leadMs: -HOUR },
        { id: 'a', label: '', leadMs: HOUR },
        { id: 'a', label: 'duplicate', leadMs: 2 * HOUR },
        { id: 'b', label: 'two hours', leadMs: 2 * HOUR },
      ],
    })
    expect(normalized.thresholds).toEqual([
      { id: 'b', label: 'two hours', leadMs: 2 * HOUR },
      { id: 'a', label: 'a', leadMs: HOUR },
    ])
  })

  it('keeps a non-boolean enabled value from silently disabling reminders', () => {
    expect(normalizeReminderSettings({ enabled: 'yes' as unknown as boolean }).enabled).toBe(true)
  })

  it('returns nothing at all when reminders are switched off', () => {
    const result = fire(DUE['2h'], { settings: { enabled: false, thresholds: [] } })
    expect(result.reminders).toEqual([])
    const off = fire(DUE['2h'], {
      settings: { ...DEFAULT_REMINDER_SETTINGS, enabled: false },
    })
    expect(off.reminders).toEqual([])
    expect(
      nextReminderAt([tender()], { ...DEFAULT_REMINDER_SETTINGS, enabled: false }, DUE['7d']),
    ).toBe(null)
  })
})

// ── Threshold boundaries ─────────────────────────────────────────────────────

describe('threshold boundaries', () => {
  it('does not fire the 7-day reminder one minute before it is due', () => {
    expect(fire(new Date(DUE['7d'].getTime() - MINUTE)).reminders).toEqual([])
  })

  it('fires the 7-day reminder exactly at its lead time, on time', () => {
    const result = fire(DUE['7d'])
    expect(result.reminders).toHaveLength(1)
    expect(result.reminders[0]).toMatchObject({
      tenderId: 't-1',
      thresholdId: '7d',
      closingAt: CLOSING.toISOString(),
      dueAt: DUE['7d'].toISOString(),
      remainingMs: 7 * DAY,
      late: false,
      skippedThresholdIds: [],
    })
  })

  it('fires one minute after the lead time, marked late', () => {
    const result = fire(new Date(DUE['7d'].getTime() + MINUTE))
    expect(result.reminders).toHaveLength(1)
    expect(result.reminders[0].late).toBe(true)
    expect(result.reminders[0].remainingMs).toBe(7 * DAY - MINUTE)
  })

  it('fires each configured threshold exactly at its own boundary and not before', () => {
    for (const threshold of DEFAULT_REMINDER_THRESHOLDS) {
      const due = DUE[threshold.id as keyof typeof DUE]
      const settings = { enabled: true, thresholds: [threshold] }

      const early = fire(new Date(due.getTime() - MINUTE), { settings })
      expect(early.reminders, `${threshold.id} must not fire early`).toEqual([])

      const onTime = fire(due, { settings })
      expect(onTime.reminders.map((r) => r.thresholdId)).toEqual([threshold.id])
      expect(onTime.reminders[0].late).toBe(false)

      const late = fire(new Date(due.getTime() + MINUTE), { settings })
      expect(late.reminders.map((r) => r.thresholdId)).toEqual([threshold.id])
      expect(late.reminders[0].late).toBe(true)
    }
  })

  it('walks one tender through the whole ladder, one reminder per threshold', () => {
    const fired: string[] = []
    let ledger = emptyReminderLedger()
    for (const id of ['7d', '3d', '1d', '2h'] as const) {
      const result = fire(DUE[id], { ledger })
      ledger = result.ledger
      fired.push(...result.reminders.map((r) => r.thresholdId))
    }
    expect(fired).toEqual(['7d', '3d', '1d', '2h'])

    const afterClosing = fire(new Date(CLOSING.getTime() + HOUR), { ledger })
    expect(afterClosing.reminders).toEqual([])
  })
})

// ── Once-only, across calls and restarts ─────────────────────────────────────

describe('once-only guarantee', () => {
  it('never fires the same reminder twice when the returned ledger is carried', () => {
    const now = DUE['3d']
    let ledger = emptyReminderLedger()
    const fired: string[] = []
    for (let call = 0; call < 5; call += 1) {
      const result = fire(now, { ledger })
      ledger = result.ledger
      fired.push(...result.reminders.map((r) => r.thresholdId))
    }
    expect(fired).toEqual(['3d'])
  })

  it('survives an app restart through the serialised ledger', () => {
    const first = fire(DUE['1d'])
    expect(first.reminders).toHaveLength(1)

    // What a restart does: write the ledger, read it back, run the schedule again.
    const persisted = serializeReminderLedger(first.ledger)
    const reloaded = parseReminderLedger(JSON.parse(persisted))
    expect(reloaded).toEqual(first.ledger)
    expect(fire(DUE['1d'], { ledger: reloaded }).reminders).toEqual([])
    expect(fire(new Date(DUE['1d'].getTime() + 5 * HOUR), { ledger: reloaded }).reminders).toEqual(
      [],
    )
  })

  it('fires the next threshold after the previous one is recorded', () => {
    const first = fire(DUE['7d'])
    const second = fire(DUE['1d'], { ledger: first.ledger })
    expect(second.reminders.map((r) => r.thresholdId)).toEqual(['1d'])
  })

  it('is pure: identical inputs give identical output and the inputs are not mutated', () => {
    const tenders = [tender()]
    const ledger = emptyReminderLedger()
    const before = JSON.stringify({ tenders, ledger })
    const a = dueReminders(tenders, DEFAULT_REMINDER_SETTINGS, DUE['7d'], ledger)
    const b = dueReminders(tenders, DEFAULT_REMINDER_SETTINGS, DUE['7d'], ledger)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify({ tenders, ledger })).toBe(before)
    expect(a.ledger).not.toBe(ledger)
  })

  it('records what it returned, with an honest disposition per threshold', () => {
    const result = fire(new Date(CLOSING.getTime() - 30 * MINUTE))
    expect(result.reminders).toHaveLength(1)
    const byThreshold = Object.fromEntries(
      result.ledger.entries.map((entry) => [entry.thresholdId, entry.disposition]),
    )
    expect(byThreshold).toEqual({
      '7d': 'skipped-stale',
      '3d': 'skipped-stale',
      '1d': 'skipped-stale',
      '2h': 'notified',
    })
  })

  it('fires one reminder per tender even if the same tender appears twice', () => {
    const duplicated = [tender(), tender()]
    const result = dueReminders(duplicated, DEFAULT_REMINDER_SETTINGS, DUE['7d'])
    expect(result.reminders).toHaveLength(1)
  })
})

// ── Ledger serialisation, validation, pruning ────────────────────────────────

describe('ledger', () => {
  it('round-trips through JSON unchanged', () => {
    const ledger = fire(DUE['3d']).ledger
    expect(parseReminderLedger(JSON.parse(serializeReminderLedger(ledger)))).toEqual(ledger)
    expect(JSON.parse(serializeReminderLedger(ledger))).toMatchObject({ version: 1 })
  })

  it('matches instants rather than strings, so an offset form still suppresses', () => {
    const ledger: ReminderLedger = {
      version: 1,
      entries: [
        {
          tenderId: 't-1',
          thresholdId: '7d',
          // The same instant as 2026-11-30T09:00:00.000Z, written differently.
          closingAt: '2026-11-30T11:00:00+02:00',
          handledAt: '2026-11-23T09:00:00.000Z',
          disposition: 'notified',
        },
      ],
    }
    expect(parseReminderLedger(ledger).entries[0].closingAt).toBe(CLOSING.toISOString())
    expect(fire(DUE['7d'], { ledger }).reminders).toEqual([])
  })

  it('discards an unusable ledger and drops invalid entries, failing open toward notifying', () => {
    expect(parseReminderLedger(undefined)).toEqual(emptyReminderLedger())
    expect(parseReminderLedger(null)).toEqual(emptyReminderLedger())
    expect(parseReminderLedger('nonsense')).toEqual(emptyReminderLedger())
    expect(parseReminderLedger([])).toEqual(emptyReminderLedger())
    expect(parseReminderLedger({})).toEqual(emptyReminderLedger())

    const fromFutureBuild = {
      version: 99,
      entries: [
        {
          tenderId: 't-1',
          thresholdId: '7d',
          closingAt: CLOSING.toISOString(),
          handledAt: CLOSING.toISOString(),
          disposition: 'notified',
        },
      ],
    }
    expect(parseReminderLedger(fromFutureBuild).entries).toEqual([])

    const mixed = {
      version: 1,
      entries: [
        // dropped: no tender
        { tenderId: '', thresholdId: '7d', closingAt: CLOSING.toISOString() },
        // dropped: no threshold
        { tenderId: 't-1', thresholdId: '', closingAt: CLOSING.toISOString() },
        // dropped: no closing instant
        { tenderId: 't-1', thresholdId: '1d', closingAt: 'not a date' },
        // kept: an unreadable handledAt falls back to the closing instant, and an
        // unknown disposition is never read as "skipped-stale"
        {
          tenderId: 't-1',
          thresholdId: '3d',
          closingAt: CLOSING.toISOString(),
          handledAt: 'not a date',
          disposition: 'nonsense',
        },
        // kept, normalised onto the same instant
        {
          tenderId: 't-1',
          thresholdId: '7d',
          closingAt: '2026-11-30T11:00:00+02:00',
          handledAt: CLOSING.toISOString(),
          disposition: 'notified',
        },
        // dropped: the same (tender, threshold, instant) as the entry above
        {
          tenderId: 't-1',
          thresholdId: '7d',
          closingAt: CLOSING.toISOString(),
          handledAt: CLOSING.toISOString(),
          disposition: 'notified',
        },
      ],
    }
    expect(parseReminderLedger(mixed).entries).toEqual([
      {
        tenderId: 't-1',
        thresholdId: '3d',
        closingAt: CLOSING.toISOString(),
        handledAt: CLOSING.toISOString(),
        disposition: 'notified',
      },
      {
        tenderId: 't-1',
        thresholdId: '7d',
        closingAt: CLOSING.toISOString(),
        handledAt: CLOSING.toISOString(),
        disposition: 'notified',
      },
    ])
  })

  it('prunes entries for deadlines long past and keeps recent ones', () => {
    const now = new Date('2026-11-30T09:00:00.000Z')
    const ledger: ReminderLedger = {
      version: 1,
      entries: [
        {
          tenderId: 'old',
          thresholdId: '7d',
          closingAt: new Date(now.getTime() - 40 * DAY).toISOString(),
          handledAt: new Date(now.getTime() - 47 * DAY).toISOString(),
          disposition: 'notified',
        },
        {
          tenderId: 'recent',
          thresholdId: '1d',
          closingAt: new Date(now.getTime() - 10 * DAY).toISOString(),
          handledAt: new Date(now.getTime() - 11 * DAY).toISOString(),
          disposition: 'notified',
        },
        {
          tenderId: 'future',
          thresholdId: '3d',
          closingAt: new Date(now.getTime() + 30 * DAY).toISOString(),
          handledAt: now.toISOString(),
          disposition: 'skipped-stale',
        },
      ],
    }
    const pruned = pruneReminderLedger(ledger, now)
    expect(pruned.entries.map((entry) => entry.tenderId)).toEqual(['recent', 'future'])
    expect(pruneReminderLedger(ledger, now, 60).entries).toHaveLength(3)
    expect(REMINDER_LEDGER_RETENTION_DAYS).toBe(30)
  })

  it('prunes a long-closed tender out of the ledger as part of the schedule', () => {
    const closed = tender({ closingDate: '1 June 2026 at 11:00' })
    // One day before closing, three thresholds have passed, so the only reminder
    // is the most urgent of them and all three are recorded.
    const first = fire(new Date('2026-05-31T09:00:00.000Z'), { tenders: [closed] })
    expect(first.reminders.map((r) => r.thresholdId)).toEqual(['1d'])
    expect(first.ledger.entries).toHaveLength(3)

    // 40 days later the deadline is far behind, so its entries go.
    const later = fire(new Date('2026-07-11T09:00:00.000Z'), {
      tenders: [closed],
      ledger: first.ledger,
    })
    expect(later.reminders).toEqual([])
    expect(later.ledger.entries).toEqual([])
  })

  it('keeps a tender closed for less than the retention window out of the way without re-firing', () => {
    const closed = tender({ closingDate: '1 June 2026 at 11:00' })
    const first = fire(new Date('2026-05-31T09:00:00.000Z'), { tenders: [closed] })
    const later = fire(new Date('2026-06-10T09:00:00.000Z'), {
      tenders: [closed],
      ledger: first.ledger,
    })
    expect(later.reminders).toEqual([])
    expect(later.ledger.entries).toHaveLength(3)
  })

  it('keeps the ledger when the clock is unusable, rather than re-notifying', () => {
    const ledger = fire(DUE['7d']).ledger
    expect(pruneReminderLedger(ledger, new Date('not a clock')).entries).toEqual(ledger.entries)
    const result = fire(new Date('not a clock'), { ledger })
    expect(result.reminders).toEqual([])
    expect(result.ledger.entries).toEqual(ledger.entries)
  })

  it('re-arms a reminder whose delivery failed, and marking is idempotent', () => {
    const result = fire(DUE['7d'])
    const reminder = result.reminders[0]
    expect(markRemindersSent(result.ledger, [reminder], DUE['7d'])).toEqual(result.ledger)

    const rolledBack = forgetReminders(result.ledger, [reminder])
    expect(rolledBack.entries).toEqual([])
    expect(fire(DUE['7d'], { ledger: rolledBack }).reminders.map((r) => r.thresholdId)).toEqual([
      '7d',
    ])
  })
})

// ── Edges ────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('never reminds about a date it does not have', () => {
    const unknown = tender({ closingDate: null })
    const result = fire(DUE['7d'], { tenders: [unknown] })
    expect(result.reminders).toEqual([])
    expect(result.ledger.entries).toEqual([])
  })

  it('never reminds about an unparseable closing date', () => {
    for (const raw of ['', '   ', 'sometime next week', '2026-99-99', '24h00 on the due date']) {
      const result = fire(DUE['7d'], { tenders: [tender({ closingDate: raw })] })
      expect(result.reminders, `"${raw}" must not schedule a reminder`).toEqual([])
    }
  })

  it('does not remind about a tender whose closing instant has passed', () => {
    expect(fire(CLOSING).reminders).toEqual([])
    expect(fire(new Date(CLOSING.getTime() + MINUTE)).reminders).toEqual([])
    expect(fire(new Date(CLOSING.getTime() + 90 * DAY)).reminders).toEqual([])
  })

  it('does not remind about a tender that is no longer open', () => {
    const notOpen: TenderStatus[] = [
      'SUBMITTED',
      'SUBMITTED_EVIDENCED',
      'WON',
      'LOST',
      'WITHDRAWN',
      'CANCELLED',
      'ARCHIVED',
    ]
    for (const status of notOpen) {
      expect(isOpenTenderStatus(status)).toBe(false)
      expect(fire(DUE['1d'], { tenders: [tender({ status })] }).reminders).toEqual([])
    }
    for (const status of [
      'IN_PROGRESS',
      'READY_TO_ASSEMBLE',
      'PACK_GENERATED',
      'READY_FOR_SUBMISSION',
    ] as TenderStatus[]) {
      expect(isOpenTenderStatus(status)).toBe(true)
      expect(fire(DUE['1d'], { tenders: [tender({ status })] }).reminders).toHaveLength(1)
    }
  })

  it('returns nothing, and prunes, for an empty tender list', () => {
    const ledger = fire(DUE['1d']).ledger
    const result = dueReminders(
      [],
      DEFAULT_REMINDER_SETTINGS,
      new Date('2027-02-01T00:00:00Z'),
      ledger,
    )
    expect(result.reminders).toEqual([])
    expect(result.ledger.entries).toEqual([])
  })

  describe('tender first seen after thresholds have passed', () => {
    it('fires only the most urgent crossed threshold, never a burst of stale ones', () => {
      // Imported half an hour before closing: all four thresholds have passed.
      const now = new Date(CLOSING.getTime() - 30 * MINUTE)
      const first = fire(now)
      expect(first.reminders).toHaveLength(1)
      expect(first.reminders[0]).toMatchObject({
        thresholdId: '2h',
        remainingMs: 30 * MINUTE,
        late: true,
        skippedThresholdIds: ['7d', '3d', '1d'],
        skippedThresholdLabels: ['7 days', '3 days', '1 day'],
      })
      // The stale ones must not trickle out one per call afterwards.
      const second = fire(new Date(now.getTime() + MINUTE), { ledger: first.ledger })
      expect(second.reminders).toEqual([])
    })

    it('drops only the thresholds already gone and keeps the ones still ahead', () => {
      const threeHoursOut = new Date(CLOSING.getTime() - 3 * HOUR)
      const first = fire(threeHoursOut)
      expect(first.reminders[0]).toMatchObject({
        thresholdId: '1d',
        skippedThresholdIds: ['7d', '3d'],
      })
      const atTwoHours = fire(DUE['2h'], { ledger: first.ledger })
      expect(atTwoHours.reminders.map((r) => r.thresholdId)).toEqual(['2h'])
    })

    it('stays silent for a tender added with every threshold still ahead', () => {
      const tenDaysOut = new Date(CLOSING.getTime() - 10 * DAY)
      const result = fire(tenDaysOut)
      expect(result.reminders).toEqual([])
      expect(result.ledger.entries).toEqual([])
    })
  })

  describe('a rescheduled closing date', () => {
    const movedLater = '15 December 2026 at 11:00'
    const movedEarlier = '20 November 2026 at 11:00'

    it('fires again when the deadline moves later, instead of suppressing it', () => {
      const first = fire(DUE['7d'])
      expect(first.reminders).toHaveLength(1)

      const rescheduled = tender({ closingDate: movedLater })
      const newClosing = new Date('2026-12-15T09:00:00.000Z')
      const result = fire(new Date(newClosing.getTime() - 7 * DAY), {
        tenders: [rescheduled],
        ledger: first.ledger,
      })
      expect(result.reminders).toHaveLength(1)
      expect(result.reminders[0]).toMatchObject({
        thresholdId: '7d',
        closingAt: newClosing.toISOString(),
        late: false,
      })
    })

    it('fires again when the deadline moves earlier', () => {
      const first = fire(DUE['7d'])
      const rescheduled = tender({ closingDate: movedEarlier })
      const newClosing = new Date('2026-11-20T09:00:00.000Z')
      const result = fire(new Date(newClosing.getTime() - 7 * DAY), {
        tenders: [rescheduled],
        ledger: first.ledger,
      })
      expect(result.reminders).toHaveLength(1)
      expect(result.reminders[0].closingAt).toBe(newClosing.toISOString())
    })

    it('treats the moved instant as a fresh ladder, not as already-warned thresholds', () => {
      const first = fire(DUE['7d'])
      const rescheduled = tender({ closingDate: movedEarlier })
      const newClosing = new Date('2026-11-20T09:00:00.000Z')
      const now = new Date(newClosing.getTime() - 2 * HOUR)
      const result = fire(now, { tenders: [rescheduled], ledger: first.ledger })
      expect(result.reminders[0]).toMatchObject({
        thresholdId: '2h',
        closingAt: newClosing.toISOString(),
      })
    })
  })

  it('interleaves several tenders, most urgent first, and then goes quiet', () => {
    const near = tender({ id: 'near', title: 'Near closing', closingDate: CLOSING_RAW })
    const far = tender({ id: 'far', title: 'Far closing', closingDate: '1 December 2026 at 11:00' })
    // `far` closes at 2026-12-01T09:00Z, so at the same instant it is 26 h out and
    // its most urgent crossed threshold is the three-day one.
    const now = new Date('2026-11-30T07:00:00.000Z')
    const first = dueReminders([far, near], DEFAULT_REMINDER_SETTINGS, now)
    expect(first.reminders.map((r) => [r.tenderId, r.thresholdId])).toEqual([
      ['near', '2h'],
      ['far', '3d'],
    ])
    expect(first.reminders.map((r) => r.remainingMs)).toEqual([2 * HOUR, 26 * HOUR])

    const second = dueReminders([far, near], DEFAULT_REMINDER_SETTINGS, now, first.ledger)
    expect(second.reminders).toEqual([])
    expect(second.ledger).toEqual(first.ledger)
  })
})

// ── nextReminderAt ───────────────────────────────────────────────────────────

describe('nextReminderAt', () => {
  it('reports the earliest future threshold instant for a scheduler to sleep to', () => {
    expect(
      nextReminderAt([tender()], DEFAULT_REMINDER_SETTINGS, new Date('2026-09-01T00:00:00Z')),
    ).toEqual(DUE['7d'])
  })

  it('advances to the next threshold once the previous one is recorded', () => {
    const ledger = fire(DUE['7d']).ledger
    expect(nextReminderAt([tender()], DEFAULT_REMINDER_SETTINGS, DUE['7d'], ledger)).toEqual(
      DUE['3d'],
    )
  })

  it('returns null when nothing is scheduled, and never reports an already-due threshold', () => {
    expect(
      nextReminderAt([tender({ closingDate: null })], DEFAULT_REMINDER_SETTINGS, DUE['7d']),
    ).toBe(null)
    expect(nextReminderAt([], DEFAULT_REMINDER_SETTINGS, DUE['7d'])).toBe(null)
    expect(
      nextReminderAt([tender({ status: 'ARCHIVED' })], DEFAULT_REMINDER_SETTINGS, DUE['7d']),
    ).toBe(null)
    // Every threshold already crossed: that is `dueReminders`' job, not a timer's.
    expect(
      nextReminderAt(
        [tender()],
        DEFAULT_REMINDER_SETTINGS,
        new Date(CLOSING.getTime() - 30 * MINUTE),
      ),
    ).toBe(null)
  })
})

// ── Honest copy ──────────────────────────────────────────────────────────────

describe('describeReminder', () => {
  it('names the tender, the lead time, the time left and the closing instant in SAST', () => {
    const reminder = fire(DUE['7d']).reminders[0]
    const sentence = describeReminder(reminder)
    expect(sentence).toContain('Roads rehabilitation RFP')
    expect(sentence).toContain(`closes in ${formatDeadlineDelta(7 * DAY)}`)
    expect(sentence).toContain('7 days before closing')
    expect(sentence).toContain('Mon, 30 Nov 2026, 11:00 SAST')
  })

  it('renders the same closing instant the countdown badge renders', () => {
    const now = DUE['1d']
    const reminder = fire(now).reminders[0]
    const badge = deadlineStatus(CLOSING_RAW, now)
    expect(badge.formatted).toBe('Mon, 30 Nov 2026, 11:00')
    expect(describeReminder(reminder)).toContain(`${badge.formatted} SAST`)
  })

  it('renders an offset-carrying closing value on the reader clock, not as SAST', () => {
    const raw = '2026-11-30T09:00:00.000Z'
    const reminder = fire(DUE['1d'], { tenders: [tender({ closingDate: raw })] }).reminders[0]
    const sentence = describeReminder(reminder)
    expect(sentence).toContain('(your local time)')
    expect(sentence).not.toContain('SAST')
    expect(sentence).toContain(deadlineStatus(raw, DUE['1d']).formatted)
  })

  it('states that the deadline passed rather than pretending a warning is current', () => {
    const reminder = fire(DUE['2h']).reminders[0]
    const stale: DueReminder = { ...reminder, remainingMs: -90 * MINUTE }
    expect(describeReminder(stale)).toContain('has closed')
    expect(describeReminder(stale)).toContain('1h 30m ago')
  })

  it('never claims the bid is ready, confirmed or compliant', () => {
    const sentences = [
      describeReminder(fire(DUE['7d']).reminders[0]),
      describeReminder({ ...fire(DUE['7d']).reminders[0], remainingMs: -HOUR }),
    ]
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/\bready\b/i)
      expect(sentence).not.toMatch(/\bconfirmed\b/i)
      expect(sentence).not.toMatch(/\bcompliant\b/i)
      expect(sentence).not.toMatch(/\bcleared\b/i)
    }
  })
})

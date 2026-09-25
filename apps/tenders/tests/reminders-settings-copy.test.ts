// Reminder-settings honesty guard.
//
// The reminder engines (the pure schedule in `shared/reminders.ts`, the
// main-process scheduler behind the `tenders:reminders-*` channels) can only do
// anything for a user who can see them. This guard covers the settings surface
// that makes them reachable — `components/pages/ProfilePage.tsx` — and the one
// fact that surface must never soften:
//
//   * the schedule is checked ONLY while the app is running. There is no
//     background service, so a reminder cannot wake a closed app. That sentence
//     is not the renderer's to write: it arrives on `getReminders()` as
//     `limitation` and must be rendered verbatim, never paraphrased into
//     something softer and never hidden in a tooltip;
//   * a reminder is a nudge raised by this app on this machine, on one channel.
//     Nothing may claim it is sent by e-mail, SMS or any other channel, and a
//     platform that cannot raise notifications must be described rather than
//     papered over with a switch that does nothing;
//   * no guarantee-shaped claim ("will never miss", "guaranteed", "always
//     reminds") may appear: a closing time can still be missed with the app
//     closed, which is exactly the limit above;
//   * the lead times come from the settings shape (`DEFAULT_REMINDER_THRESHOLDS`,
//     `ReminderSettings.thresholds`), never from a second copy of the default
//     list kept in the page, and their bounds are the published IPC bounds;
//   * a settings write that FAILED is surfaced. `setReminders` rejects when it
//     cannot persist, so a switch that flipped on screen without the schedule
//     following it is the bug this guard exists to prevent.
//
// There is no rendered-component harness by design, so the JSX-level claims are
// asserted against comment-stripped source — the pattern `ai-honesty-copy` and
// `limitations-copy` already use. The claims that ARE behaviour (the id/label
// shape a row writes, the bounds, an inert switched-off schedule, a lead time the
// ledger has already recorded) are tested as real functions of the shared core
// the surface reads, with no network and no component tree. Each test below says
// which kind it is.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_TENDERS_REMINDER_LEAD_MS, MAX_TENDERS_REMINDER_THRESHOLDS } from '../src/shared/ipc'
import { parseClosingDate } from '../src/shared/readiness'
import {
  DEFAULT_REMINDER_THRESHOLDS,
  nextReminderAt,
  normalizeReminderSettings,
  type ReminderSettings,
  type ReminderTender,
} from '../src/shared/reminders'

/** Locate `apps/tenders/src/renderer/src` from the workspace or the repo root. */
function resolveRendererSrc(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const fromRepoRoot = join(dir, 'apps', 'tenders', 'src', 'renderer', 'src')
    if (existsSync(fromRepoRoot)) return fromRepoRoot
    const fromWorkspace = join(dir, 'src', 'renderer', 'src')
    if (existsSync(fromWorkspace)) return fromWorkspace
    dir = dirname(dir)
  }
  throw new Error('Could not locate apps/tenders/src/renderer/src from ' + process.cwd())
}

const SRC = resolveRendererSrc()
const PROFILE = 'components/pages/ProfilePage.tsx'

/**
 * The reminders surface is the tail of the profile page, from its own header
 * marker to the end of the file. It is sliced out rather than read whole because
 * the page's contact block legitimately prints the word "e-mail" for a company
 * address, and a channel guard scoped to the whole file could never tell that
 * apart from a claim about how a reminder reaches the user.
 */
const SECTION_MARKER = '// ── deadline reminders'

function profileSource(): string {
  return readFileSync(join(SRC, PROFILE), 'utf8')
}

function remindersSource(): string {
  const source = profileSource()
  const at = source.indexOf(SECTION_MARKER)
  expect(at, `${PROFILE} no longer carries a deadline-reminders section`).toBeGreaterThan(-1)
  const section = source.slice(at)
  expect(
    section.length,
    'the deadline-reminders section is present and substantial',
  ).toBeGreaterThan(1500)
  return section
}

/**
 * Source with comments removed and everything else — code, JSX, string literals —
 * intact. Structural claims are matched against this, because a raw-source regex
 * is satisfied by a comment that merely mentions the pattern.
 */
function codeText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** Reduce a source file to the copy a user could actually read. */
function copyText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1')) // line comments (keep "https://")
    .join(' ')
    .replace(/<[^>]*>/g, ' ') // JSX tags
    .replace(/\s+/g, ' ')
    .trim()
}

const CODE = codeText(remindersSource())
const COPY = copyText(remindersSource())

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** The closing instant every schedule test below is about. */
const CLOSING = '30 November 2026 at 11:00'

function tenderAt(closingDate: string | null, status: ReminderTender['status'] = 'IN_PROGRESS') {
  return { id: 'tender-1', title: 'Water reticulation upgrade', closingDate, status }
}

const OPEN_SETTINGS: ReminderSettings = {
  enabled: true,
  thresholds: [...DEFAULT_REMINDER_THRESHOLDS],
}

// ── the settings shape the surface writes (behaviour, not source) ─────────────

describe('the lead-time shape the settings surface writes', () => {
  /**
   * The surface writes `{ id, label, leadMs }` per row, deriving the id from the
   * lead itself (`DEFAULT_REMINDER_THRESHOLDS` keeps its documented id, anything
   * else is `lead-<ms>`). This is that shape — the ids the page's own rule
   * produces — put through the reader the scheduler uses: nothing may be dropped,
   * re-labelled or reordered into a different reminder.
   */
  it('keeps every derived lead time through the round trip', () => {
    const draft = [
      { id: '7d', label: '7 days', leadMs: 7 * DAY_MS },
      { id: 'lead-432000000', label: '5 days', leadMs: 5 * DAY_MS },
      { id: '2h', label: '2 hours', leadMs: 2 * HOUR_MS },
    ]
    const written = normalizeReminderSettings({ enabled: true, thresholds: draft })
    expect(written.enabled).toBe(true)
    expect(written.thresholds, 'longest lead first, none dropped').toEqual([
      { id: '7d', label: '7 days', leadMs: 7 * DAY_MS },
      { id: 'lead-432000000', label: '5 days', leadMs: 5 * DAY_MS },
      { id: '2h', label: '2 hours', leadMs: 2 * HOUR_MS },
    ])
  })

  it('the documented defaults the surface offers back are exactly the documented ones', () => {
    const written = normalizeReminderSettings({
      enabled: true,
      thresholds: [...DEFAULT_REMINDER_THRESHOLDS],
    })
    expect(written.thresholds).toHaveLength(DEFAULT_REMINDER_THRESHOLDS.length)
    for (const documented of DEFAULT_REMINDER_THRESHOLDS) {
      expect(written.thresholds, `the documented ${documented.id} survives`).toContainEqual(
        documented,
      )
    }
  })

  it('a duplicate lead time is dropped by the reader, which is why the surface refuses one', () => {
    // Two rows set to the same lead time derive the same id, and the reader keeps
    // only the first — a user who believed both were set would be reminded once.
    const duplicated = normalizeReminderSettings({
      enabled: true,
      thresholds: [
        { id: 'lead-3600000', label: '1 hour', leadMs: HOUR_MS },
        { id: 'lead-3600000', label: '1 hour', leadMs: HOUR_MS },
      ],
    })
    expect(duplicated.thresholds).toHaveLength(1)
    // The surface refuses that draft instead of sending it, and says why.
    expect(CODE, 'the surface must refuse a duplicate lead time').toMatch(
      /Two lead times are the same/,
    )
    expect(CODE, 'the duplicate check runs before the save').toMatch(
      /const problem = reminderDraftProblem\(rows\)[\s\S]{0,120}return/,
    )
  })

  it('the bounds the form offers are the bounds the app publishes', () => {
    // Behaviour: the published IPC bounds are the numbers the copy is built from.
    expect(MAX_TENDERS_REMINDER_LEAD_MS).toBe(365 * DAY_MS)
    expect(MAX_TENDERS_REMINDER_THRESHOLDS).toBe(12)
    // Source: the form states its maximum from that constant rather than a number
    // typed into the copy, and its minimum is the smallest unit it offers.
    expect(CODE, 'the maximum is the IPC bound, not a number typed here').toContain(
      'MAX_TENDERS_REMINDER_LEAD_MS',
    )
    expect(CODE, 'the maximum in the copy is derived from it').toMatch(
      /const MAX_REMINDER_LEAD_DAYS = MAX_TENDERS_REMINDER_LEAD_MS \/ DAY_MS/,
    )
    expect(CODE, 'the minimum is one hour').toMatch(/const MIN_REMINDER_LEAD_MS = 3_600_000/)
    expect(COPY, 'and the copy says so').toMatch(/at least 1 hour/i)
    expect(COPY, 'and states the maximum').toMatch(/at most/i)
  })
})

describe('what the schedule the surface reports actually does', () => {
  it('is inert while reminders are off, and with no lead times set', () => {
    const now = new Date('2026-11-01T00:00:00.000Z')
    const tenders = [tenderAt(CLOSING)]
    expect(nextReminderAt(tenders, OPEN_SETTINGS, now), 'a live schedule').not.toBeNull()
    expect(
      nextReminderAt(tenders, { ...OPEN_SETTINGS, enabled: false }, now),
      'switched off means nothing is scheduled',
    ).toBeNull()
    expect(
      nextReminderAt(tenders, { enabled: true, thresholds: [] }, now),
      'no lead times means nothing can fire, even switched on',
    ).toBeNull()
    // The surface says both of those in words rather than showing an empty list.
    expect(COPY).toMatch(/No reminder is scheduled while reminders are off/i)
    expect(COPY).toMatch(/No reminder is scheduled: no lead times are set/i)
  })

  it('does not schedule a lead time the ledger has already recorded', () => {
    const now = new Date('2026-11-01T00:00:00.000Z')
    const closing = parseClosingDate(CLOSING)
    expect(closing, 'the closing value used here must parse').not.toBeNull()
    const closingAt = closing!.toISOString()
    const tenders = [tenderAt(CLOSING)]
    expect(nextReminderAt(tenders, OPEN_SETTINGS, now)?.toISOString()).toBe(
      new Date(closing!.getTime() - 7 * DAY_MS).toISOString(),
    )
    const ledger = {
      version: 1,
      entries: [
        {
          tenderId: 'tender-1',
          thresholdId: '7d',
          closingAt,
          handledAt: now.toISOString(),
          disposition: 'notified' as const,
        },
      ],
    }
    expect(
      nextReminderAt(tenders, OPEN_SETTINGS, now, ledger)?.toISOString(),
      'the warned lead time is not scheduled again',
    ).toBe(new Date(closing!.getTime() - 3 * DAY_MS).toISOString())
  })
})

// ── the limitation sentence ───────────────────────────────────────────────────

describe('the runtime limitation is shown, verbatim, where reminders are configured', () => {
  it('renders the sentence the IPC response carries', () => {
    expect(CODE, 'the limitation travels on getReminders()').toMatch(
      /setLimitation\(res\.limitation\)/,
    )
    expect(CODE, 'and is rendered as visible text').toMatch(
      /data-testid="reminders-limitation"[\s\S]{0,400}\{limitation\}/,
    )
    expect(CODE, 'it is never carried by a tooltip alone').not.toMatch(/title=\{[^}]*limitation/)
  })

  it('never restates the sentence in this file, so it cannot drift or soften', () => {
    expect(
      COPY,
      'the limitation must not be paraphrased into the renderer — it is main’s sentence',
    ).not.toMatch(
      /checked only while|no notification is sent at that time|says the warning is late/i,
    )
  })

  it('the guards are not vacuous: a paraphrase is caught', () => {
    expect(
      copyText('<p>Deadline reminders are checked only while Zanostack Tenders is running.</p>'),
    ).toMatch(/checked only while/)
  })
})

// ── honest copy: no guarantee, one channel ────────────────────────────────────

describe('the surface promises a nudge, not an outcome', () => {
  const GUARANTEES: Array<{ pattern: RegExp; asserts: string }> = [
    { pattern: /will never miss/i, asserts: 'a closing time will never be missed' },
    {
      pattern: /never miss (?:a|the|your) (?:deadline|closing)/i,
      asserts: 'no deadline is missed',
    },
    { pattern: /\bguarantee/i, asserts: 'an outcome is guaranteed' },
    { pattern: /always reminds?/i, asserts: 'the app always reminds the user' },
    { pattern: /we(?:'| wi)ll remind you/i, asserts: 'the team reminds the user' },
    {
      pattern: /make sure you (?:never|don’t|don't) miss/i,
      asserts: 'the app makes sure nothing is missed',
    },
    {
      pattern: /so you (?:never|don’t|don't) miss/i,
      asserts: 'the app stops a deadline being missed',
    },
  ]

  it('makes no guarantee-shaped claim', () => {
    for (const { pattern, asserts } of GUARANTEES) {
      expect(pattern.test(COPY), `${PROFILE} claims ${asserts} (matched ${String(pattern)})`).toBe(
        false,
      )
    }
  })

  it('the guarantee guard has teeth on the claims it rejects', () => {
    for (const shipped of [
      'You will never miss a closing time with Tenders.',
      'Guaranteed reminders for every deadline.',
      'Tenders always reminds you in time.',
      'We will remind you before every closing time.',
    ]) {
      expect(
        GUARANTEES.some(({ pattern }) => pattern.test(shipped)),
        `must reject: ${shipped}`,
      ).toBe(true)
    }
    expect(
      GUARANTEES.some(({ pattern }) =>
        pattern.test('A reminder is a nudge while the app is open, not a promise.'),
      ),
      'the honest sentence must not be caught',
    ).toBe(false)
  })

  it('claims one channel only, and describes a platform that cannot show it', () => {
    expect(COPY, 'the channel is named').toMatch(/desktop notification/i)
    expect(COPY, 'and named as the only one').toMatch(/only channel/i)
    expect(COPY, 'and nothing is sent to anyone else').toMatch(/nothing is sent to anyone else/i)
    expect(COPY, 'an unsupported platform is described, not papered over').toMatch(
      /does not support desktop notifications/i,
    )
    // Nothing here may offer a second channel.
    for (const channel of [
      /\bemail\b/i,
      /e-?mail/i,
      /\bsms\b/i,
      /text message/i,
      /push notification/i,
      /whatsapp/i,
      /\bmail\b/i,
      /\bslack\b/i,
      /telegram/i,
    ]) {
      expect(
        channel.test(COPY),
        `${PROFILE} offers a reminder channel other than a desktop notification (matched ${String(channel)})`,
      ).toBe(false)
    }
  })

  it('the channel guard has teeth on a channel claim', () => {
    for (const shipped of [
      'You will get an email before closing.',
      'Reminders are sent by SMS.',
      'A text message is sent two hours before closing.',
    ]) {
      expect(
        [/\bemail\b/i, /e-?mail/i, /\bsms\b/i, /text message/i].some((pattern) =>
          pattern.test(shipped),
        ),
        `must reject: ${shipped}`,
      ).toBe(true)
    }
  })

  it('offers no switch it cannot back, and no readiness or confirmation claim', () => {
    const toggleAt = CODE.indexOf('data-testid="reminders-enabled-toggle"')
    expect(toggleAt, 'the switch exists').toBeGreaterThan(-1)
    expect(
      CODE.slice(Math.max(0, toggleAt - 600), toggleAt),
      'the switch renders only once the settings have been read',
    ).toContain('{settings && (')
    expect(CODE, 'a missing bridge is reported instead of a dead switch').toMatch(
      /no reminder settings to this page/,
    )
    expect(CODE, 'a failed read shows the reason').toMatch(/data-testid="reminders-unavailable"/)
    // A reminder is a scheduling fact: this surface never writes a verdict.
    expect(CODE, 'nothing here writes a confirmed or readiness claim').not.toMatch(
      /confirmed|readiness|updateTender\(/,
    )
  })
})

// ── the switch's pointer target ───────────────────────────────────────────────

describe('the reminder switch clears the minimum pointer target', () => {
  /**
   * The e2e a11y journey (`e2e/tenders-a11y-theme.spec.ts`, "interactive targets
   * below 24x24px") measures the rendered border box of every interactive control
   * and fails below 24px. It measured this switch at 16x16 while it carried the
   * app's shared `FORM_CHECKBOX_CLASS` (`size-4 box-content p-1`): on a checkbox
   * the user-agent stylesheet owns `padding`, which computes to `0px`, so the
   * `p-1` added nothing and the box stayed at the 16px `size-4`.
   *
   * The shared class has since been fixed to `size-6` and now measures 24px, so
   * the two classes are equivalent today; what this guard pins is that the switch
   * still sizes ITSELF with `size-6` — `calc(var(--spacing) * 6)`, i.e. 24px with
   * the app's `--spacing: .25rem` — rather than depending on the shared class.
   */
  it('sizes itself at 24px instead of reusing the shared checkbox', () => {
    const at = CODE.indexOf('data-testid="reminders-enabled-toggle"')
    expect(at, 'the switch exists').toBeGreaterThan(-1)
    const field = CODE.slice(at, at + 320)
    expect(field, 'the switch must size itself, not inherit the shared checkbox box').not.toContain(
      'FORM_CHECKBOX_CLASS',
    )
    expect(field, 'the switch carries its own sizing').toContain(
      'className={REMINDER_SWITCH_CLASS}',
    )
    expect(
      CODE,
      'and that sizing is size-6 (24px), with no padding for a checkbox to ignore',
    ).toMatch(/const REMINDER_SWITCH_CLASS =[\s\S]{0,40}'size-6 cursor-pointer/)
  })

  it('the guard is not vacuous: the pre-fix shape is caught', () => {
    const at = CODE.indexOf('data-testid="reminders-enabled-toggle"')
    // The shape this guard was written for: the switch carrying the shared class
    // back when that class measured 16x16. The assertion above rejects exactly
    // this, whatever the shared class measures today.
    const before = CODE.slice(at, at + 320).replace(
      'className={REMINDER_SWITCH_CLASS}',
      'className={FORM_CHECKBOX_CLASS}',
    )
    expect(before, 'the pre-fix field really does carry the shared class').toContain(
      'FORM_CHECKBOX_CLASS',
    )
    expect(before, 'and the guard rejects exactly that').not.toContain(
      'className={REMINDER_SWITCH_CLASS}',
    )
  })
})

// ── the settings shape drives the list ────────────────────────────────────────

describe('the lead times come from the settings shape', () => {
  it('reads the persisted list and the shared documented defaults', () => {
    expect(CODE, 'the saved list comes from the response').toMatch(/res\.settings\.thresholds/)
    expect(CODE, 'the rows are built from that list').toMatch(/reminderRows\(/)
    expect(CODE, 'the documented defaults come from the shared module').toContain(
      'DEFAULT_REMINDER_THRESHOLDS',
    )
  })

  it('carries no second copy of the default lead times', () => {
    expect(CODE, 'an inline threshold table is the drift this guards').not.toMatch(/\{\s*id:\s*'/)
    expect(CODE, 'nor the documented ids spelled out').not.toMatch(/id: '(?:7d|3d|1d|2h)'/)
    expect(CODE, 'nor a literal lead time').not.toMatch(/\bleadMs:\s*\d/)
    expect(
      CODE,
      'the id is derived from the lead, keeping a documented id where one matches',
    ).toMatch(/DEFAULT_REMINDER_THRESHOLDS\.find\([\s\S]{0,80}\)[\s\S]{0,120}lead-\$\{leadMs\}/)
  })
})

// ── a settings write that failed ──────────────────────────────────────────────

describe('a settings write that did not land is surfaced', () => {
  it('reads the answer of every settings write, and shows the reason main gave', () => {
    const writes = CODE.match(/const res = await api\.setReminders\(/g) ?? []
    expect(
      writes,
      'both settings writes (the switch and the lead times) read their answer',
    ).toHaveLength(2)
    expect(CODE, 'a refused write returns before touching the state it would have shown').toMatch(
      /if \(!res\.ok\) \{\s*setSettingsError\(res\.error\.message\)\s*return\s*\}/,
    )
    expect(CODE, 'main’s own message is what the user sees').toMatch(/res\.error\.message/)
    expect(CODE, 'the refusal is rendered as an alert').toMatch(/role="alert"/)
    expect(CODE).toContain('data-testid="reminders-save-error"')
    expect(
      CODE,
      'a fire-and-forget settings write is the silent failure this replaced',
    ).not.toMatch(/void api\.setReminders\(/)
  })

  it('distinguishes a failed check from a check that found nothing', () => {
    expect(CODE, 'a failed check shows the reason').toMatch(
      /if \(!res\.ok\) \{\s*setCheckError\(res\.error\.message\)\s*return\s*\}/,
    )
    expect(CODE).toContain('data-testid="reminders-check-error"')
    expect(CODE, 'a zero-result check says the check ran').toMatch(/The check ran/)
    expect(CODE, 'and says which setting made it a no-op').toMatch(/nothing could fire/)
    expect(CODE, 'the result is only rendered from an answered check').toMatch(
      /data-testid="reminders-check-result"/,
    )
  })

  it('the failure guards are not vacuous: the pre-fix shapes are caught', () => {
    expect('void api.setReminders({ enabled: true })').toMatch(/void api\.setReminders\(/)
    expect('const res = await api.setReminders({ enabled: true })').not.toMatch(
      /if \(!res\.ok\) \{\s*setSettingsError\(res\.error\.message\)\s*return\s*\}/,
    )
  })
})

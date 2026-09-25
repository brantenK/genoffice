import { describe, expect, it } from 'vitest'
import {
  assessDocHealth as assessCanonicalDocHealth,
  assessReadiness,
  daysBetween as sharedDaysBetween,
  formatDeadlineDelta,
  parseClosingDate,
} from '../src/shared/readiness'
import * as deadlineModule from '../src/renderer/src/deadline'
import * as compatReadiness from '../src/renderer/src/readiness'
import { deadlineStatus } from '../src/renderer/src/deadline'
import { buildIcs, buildRunway } from '../src/renderer/src/calendar'
import {
  assessDocHealth as assessGapDocHealth,
  daysBetween as gapDaysBetween,
  POLICE_STAMP_WINDOW_DAYS,
} from '../src/renderer/src/gap'
import { MOCK_COMPANY } from '../src/renderer/src/mock/company'
import { extractTenderMeta } from '../src/renderer/src/pdf/shred'
import type {
  CompanyProfile,
  PageLine,
  RequirementRecord,
  TenderRecord,
  VaultDoc,
} from '../src/shared/types'

const NOW = new Date('2026-09-01T00:00:00Z')

/** The closing line the audit found importing as `null` (defect 3). */
const PARENTHETICAL_CLOSING = '30 November 2026 at 11:00 (No late submissions will be accepted)'
/**
 * 11:00 on an SA tender is 11:00 SAST = 09:00Z. The instant is deliberately NOT
 * 11:00Z: anchoring SA wall-clock deadlines to UTC made the gate and the
 * countdown run two hours late, so a bidder could believe they had until 11:00
 * when the deadline had already passed at 09:00Z.
 */
const CLOSING_INSTANT = Date.parse('2026-11-30T09:00:00.000Z')

function requirement(overrides: Partial<RequirementRecord> = {}): RequirementRecord {
  return {
    id: 'req-sbd',
    ruleKey: 'sbd_forms',
    title: 'Signed SBD returnable forms',
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    verbatimClause: 'Completed and signed SBD 4 form is a mandatory disqualifying returnable.',
    pageNumber: 1,
    boundingBox: { top: 0.1, left: 0.1, width: 0.8, height: 0.05 },
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 1,
    status: 'FULFILLED',
    linkedVaultDocId: null,
    reason: null,
    suggestedVaultDocIds: [],
    ...overrides,
  }
}

/**
 * A tender that is fully prepared apart from the deadline: one signature-only
 * returnable whose checkbox is confirmed, no document evidence required, and a
 * complete company profile. It reaches `ready: true` whenever the deadline is
 * open, which is what makes it a usable probe for the deadline gate.
 */
function preparedTender(overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: 'tender-closing-day',
    title: 'Supply and Delivery of Office Computers',
    referenceNumber: 'ICT/2026/041',
    issuingBody: 'Provincial Administration Office',
    closingDate: PARENTHETICAL_CLOSING,
    submissionMethod: 'ELECTRONIC',
    submissionAddress: 'procurement@example.test',
    signatureChecks: { sbd_forms: true },
    status: 'IN_PROGRESS',
    createdAt: '2026-08-01',
    fileName: 'office-computers-rfp.pdf',
    fileUrl: 'documents/office-computers-rfp.pdf',
    numPages: 12,
    ocrPages: 0,
    requirements: [requirement()],
    ...overrides,
  }
}

function vaultDoc(overrides: Partial<VaultDoc> = {}): VaultDoc {
  return {
    id: 'vault-tax',
    title: 'SARS Tax Clearance Certificate',
    category: 'COMPLIANCE',
    fileUrl: 'vault/tax-clearance.pdf',
    issueDate: '2026-01-01',
    expiryDate: '2026-09-30',
    isCertified: false,
    certifiedDate: null,
    metadata: {},
    ...overrides,
  }
}

function deadlineCheckOf(report: ReturnType<typeof assessReadiness>) {
  const check = report.checks.find((candidate) => candidate.id === 'deadline')
  if (!check) throw new Error('readiness report has no deadline check')
  return check
}

function makeLine(
  text: string,
  pageNumber = 1,
  box = { top: 0.1, left: 0.1, width: 0.8, height: 0.02 },
): PageLine {
  return { pageNumber, text, box }
}

function makePage(pageNumber: number, lines: (string | PageLine)[]) {
  const normLines: PageLine[] = lines.map((line, index) =>
    typeof line === 'string'
      ? makeLine(line, pageNumber, {
          top: 0.05 + index * 0.04,
          left: 0.1,
          width: 0.8,
          height: 0.025,
        })
      : line,
  )
  return {
    pageNumber,
    width: 595,
    height: 842,
    text: normLines.map((line) => line.text).join('\n'),
    lines: normLines,
    needsOcr: false,
  }
}

function makeDoc(...pages: ReturnType<typeof makePage>[]) {
  return {
    numPages: pages.length,
    pages,
    textPages: pages.length,
    ocrPages: 0,
  }
}

describe('one shared closing-date parser', () => {
  it('is the same function for readiness, the countdown badge and the compat entry point', () => {
    expect(deadlineModule.parseClosingDate).toBe(parseClosingDate)
    expect(compatReadiness.parseClosingDate).toBe(parseClosingDate)
  })

  it('shares the day maths and the police-stamp window with gap analysis', () => {
    expect(gapDaysBetween).toBe(sharedDaysBetween)
    expect(POLICE_STAMP_WINDOW_DAYS).toBe(90)
  })

  it('delegates vault document health to the canonical implementation', () => {
    const supported = vaultDoc()
    const canonical = assessCanonicalDocHealth(supported, NOW)
    const gapReport = assessGapDocHealth(supported, NOW)

    // Same health and the same day counts for every supported date value.
    expect(gapReport).toEqual(canonical)

    // An impossible date is no longer reported as VALID by the vault path: the
    // canonical parser rejects it and readiness reports INVALID_DATE, so the
    // runway must not clear what the readiness gate blocks.
    const impossible = vaultDoc({ expiryDate: '2026-99-99' })
    expect(assessCanonicalDocHealth(impossible, NOW).health).toBe('INVALID_DATE')
    expect(assessGapDocHealth(impossible, NOW).health).not.toBe('VALID')
    expect(assessGapDocHealth(impossible, NOW).health).toBe('NO_EXPIRY_INFO')
  })
})

describe('closing-date parser table', () => {
  it.each([
    // SA wall-clock civil values are anchored to SAST (+02:00): 11:00 SAST is
    // the 09:00Z instant at which the deadline actually passes. These pins were
    // updated from the previous UTC anchor deliberately.
    ['30 November 2026 at 11:00', '2026-11-30T09:00:00.000Z'],
    // Trailing parenthetical noise must not block a real deadline (audit defect 3).
    [PARENTHETICAL_CLOSING, '2026-11-30T09:00:00.000Z'],
    ['30 November 2026 at 11:00 (submissions by email only)', '2026-11-30T09:00:00.000Z'],
    ['30 November 2026 at 11:00, no late submissions', '2026-11-30T09:00:00.000Z'],
    ['30 November 2026 (No late submissions will be accepted)', '2026-11-30T21:59:00.000Z'],
    ['02 December 2026 at 11:00 SAST', '2026-12-02T09:00:00.000Z'],
    // End of day is 23:59 SAST = 21:59Z — the latest SA civil instant of the date.
    ['30 November 2026', '2026-11-30T21:59:00.000Z'],
    ['November 30, 2026', '2026-11-30T21:59:00.000Z'],
    ['30 Nov 2026 at 11h00', '2026-11-30T09:00:00.000Z'],
    ['2026-11-30 11:00', '2026-11-30T09:00:00.000Z'],
    ['30/11/2026 11:00', '2026-11-30T09:00:00.000Z'],
    // An explicit offset is already a real instant and is left alone.
    ['2026-12-18T14:00:00.000+02:00', '2026-12-18T12:00:00.000Z'],
  ])('accepts %j as the SAST-anchored instant %s', (raw, expectedIso) => {
    expect(parseClosingDate(raw)?.toISOString()).toBe(expectedIso)
  })

  it.each([
    ['not-a-date'],
    ['2026-99-99'],
    ['2026-02-30'],
    ['2026-12-18T12:00:00.000'], // timezone-less datetime
    ['30 November 2026 at 24h00'],
    ['Dec 18, 2026 14:60'],
    // A parenthetical clock time is date/time information, not noise: accepting
    // it either swallows the real closing time or invents one, so it fails closed
    // (the intake-review journey relies on this string needing manual entry).
    ['30 November 2026 (11:00)'],
    ['Friday, 30 November 2026 (11:00)'],
    // Trailing text that could be a competing or amended deadline is never swallowed.
    ['30 November 2026 deadline extended to 15 December 2026'],
    ['30 November 2026 at 11:00 (closing 12:00)'],
    ['30 November 2026 at 11:00 (ref RFP-WTR-2026-04)'],
    ['30 November 2026 at 11'],
    // A spelled-out clock time carries time information the parser does not
    // represent. It used to be treated as noise and silently resolved to end of
    // day — ~12 h after the stated time — so it now fails closed instead.
    ['30 November 2026 at noon'],
    ['30 November 2026 (midday)'],
    ['30 November 2026 at midnight'],
  ])('rejects ambiguous or impossible closing date %j', (raw) => {
    expect(parseClosingDate(raw)).toBeNull()
  })
})

describe('closing-day boundaries: the gate and the badge agree', () => {
  it.each([
    ['a full day before closing', '2026-11-29T09:00:00.000Z', true],
    ['one hour before closing', '2026-11-30T08:00:00.000Z', true],
    ['one minute before closing', '2026-11-30T08:59:00.000Z', true],
    ['exactly at the closing instant', '2026-11-30T09:00:00.000Z', false],
    ['one hour after closing', '2026-11-30T10:00:00.000Z', false],
  ])('%s', (_label, nowIso, open) => {
    const now = new Date(nowIso)
    const tender = preparedTender()
    const report = assessReadiness(tender, [], MOCK_COMPANY, now)
    const check = deadlineCheckOf(report)
    const badge = deadlineStatus(tender.closingDate, now)
    const delta = formatDeadlineDelta(CLOSING_INSTANT - now.getTime())

    // Gate and badge decide the same thing about the same instant…
    expect(check.passed).toBe(open)
    expect(badge.urgency === 'closed').toBe(!open)
    expect(check.passed).toBe(badge.urgency !== 'closed')
    // …and describe it with the same delta, so "closes in 1h 0m" can never sit
    // next to a gate that says the tender already closed.
    expect(badge.countdownLabel.toLowerCase()).toContain(delta)
    expect(check.detail.toLowerCase()).toContain(delta)
    expect(check.detail).not.toContain('day(s)')

    // With everything else prepared, the deadline is the only thing that can
    // still clear or block readiness.
    expect(report.ready).toBe(open)
    expect(report.blockingFailedCount).toBe(open ? 0 : 1)
  })

  it('keeps the closing day open until its closing time instead of rounding to closed', () => {
    const now = new Date('2026-11-30T08:00:00.000Z')
    const report = assessReadiness(preparedTender(), [], MOCK_COMPANY, now)
    const check = deadlineCheckOf(report)

    expect(check.detail).toBe('Closes in 1h 0m.')
    expect(check.passed).toBe(true)
    expect(report.ready).toBe(true)
    expect(deadlineStatus(PARENTHETICAL_CLOSING, now).countdownLabel).toBe('closes in 1h 0m')
  })

  it('reports the elapsed time once the closing instant has passed', () => {
    const now = new Date('2026-11-30T10:00:00.000Z')
    const report = assessReadiness(preparedTender(), [], MOCK_COMPANY, now)
    const check = deadlineCheckOf(report)

    expect(check.detail).toBe('This tender closed 1h 0m ago.')
    expect(check.passed).toBe(false)
    expect(deadlineStatus(PARENTHETICAL_CLOSING, now).countdownLabel).toBe('Closed 1h 0m ago')
  })

  it('still blocks when the closing date cannot be parsed at all', () => {
    const report = assessReadiness(
      preparedTender({ closingDate: 'Friday, 30 November 2026 (11:00)' }),
      [],
      MOCK_COMPANY,
      new Date('2026-11-01T00:00:00.000Z'),
    )
    const check = deadlineCheckOf(report)

    expect(check.passed).toBe(false)
    expect(check.detail).toMatch(/confirm the deadline manually/i)
    expect(report.ready).toBe(false)
  })
})

describe('the shred boundary keeps the tolerated closing line', () => {
  it('stores the audit closing line instead of null, so readiness does not block on re-entry', () => {
    const line = makeLine(`Closing Date: ${PARENTHETICAL_CLOSING}`, 1)
    const meta = extractTenderMeta(makeDoc(makePage(1, [line])), 'Fallback Title')

    expect(meta.closingDate).toBe(PARENTHETICAL_CLOSING)
    expect(parseClosingDate(meta.closingDate)?.toISOString()).toBe('2026-11-30T09:00:00.000Z')
  })

  it('still refuses a closing line the parser rejects', () => {
    const line = makeLine('Closing Date: Friday, 30 November 2026 (11:00)', 1)
    const meta = extractTenderMeta(makeDoc(makePage(1, [line])), 'Fallback Title')

    expect(meta.closingDate).toBeNull()
  })

  it('shows the user the closing line it refused instead of dropping it silently', () => {
    const line = makeLine('Closing Date: 30 November 2026, 11:00', 1)
    const meta = extractTenderMeta(makeDoc(makePage(1, [line])), 'Fallback Title')

    // Still no stored value and no parser candidate — the strict gate is intact…
    expect(meta.closingDate).toBeNull()
    expect(meta.candidates.closingDate).toEqual([])
    // …but the raw text the document carried reaches the review UI's conflict
    // list, so the user is told what the document said and can confirm it.
    expect(meta.conflicts.some((note) => note.includes('30 November 2026, 11:00'))).toBe(true)
    expect(meta.conflicts.some((note) => /could not be read/i.test(note))).toBe(true)
  })
})

describe('closing-time display', () => {
  it('renders civil closing text in SAST, whatever the machine timezone', () => {
    const originalTimezone = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      const now = new Date('2026-11-01T00:00:00.000Z')

      // Civil text: the wall time exactly as the RFP states it. Rendered in SAST
      // (not UTC and not the reader's clock), so "11:00" is 11:00 on every machine.
      expect(deadlineStatus('30 November 2026 at 11:00', now).formatted).toContain('11:00')
      expect(deadlineStatus(PARENTHETICAL_CLOSING, now).formatted).toContain('11:00')
      expect(deadlineStatus('30 November 2026', now).formatted).toContain('23:59')
      // An explicit offset is a real instant: 09:00Z is 11:00 in SAST, and the
      // reader's clock is what matters for it.
      expect(deadlineStatus('2026-11-30T09:00:00Z', now).date?.toISOString()).toBe(
        '2026-11-30T09:00:00.000Z',
      )
      // The target submit time is 24h earlier, in the same frame of reference.
      const badge = deadlineStatus('30 November 2026 at 11:00', now)
      expect(badge.submitByLabel).toContain('11:00')
      expect(badge.submitBy?.toISOString()).toBe('2026-11-29T09:00:00.000Z')
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ
      else process.env.TZ = originalTimezone
    }
  })

  it('anchors the closing instant, the badge and the gate to 11:00 SAST', () => {
    const now = new Date('2026-11-01T00:00:00.000Z')
    const badge = deadlineStatus('30 November 2026 at 11:00', now)

    // 11:00 SAST is 09:00Z — not 11:00Z. The countdown therefore expires two
    // hours earlier than the UTC anchor it replaced.
    expect(badge.date?.toISOString()).toBe('2026-11-30T09:00:00.000Z')
    expect(
      deadlineStatus('30 November 2026 at 11:00', new Date('2026-11-30T08:59:00Z')).urgency,
    ).not.toBe('closed')
    expect(
      deadlineStatus('30 November 2026 at 11:00', new Date('2026-11-30T09:00:00Z')).urgency,
    ).toBe('closed')
  })

  it('reaches every urgency band, including "soon"', () => {
    const at = (nowIso: string) =>
      deadlineStatus('30 November 2026 at 11:00', new Date(nowIso)).urgency

    expect(at('2026-11-01T00:00:00Z')).toBe('comfortable') // a month out
    expect(at('2026-11-26T09:00:00Z')).toBe('soon') // 4 days out, outside the 24h window
    expect(at('2026-11-30T08:00:00Z')).toBe('urgent') // inside the final 24h
    expect(at('2026-11-30T09:00:00Z')).toBe('closed')
  })
})

describe('the runway uses the same closing instant', () => {
  it('keeps civil closing dates on the canonical SAST-anchored instant in any timezone', () => {
    const originalTimezone = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      const now = new Date('2026-11-01T00:00:00.000Z')
      const tender = preparedTender({ closingDate: '2026-11-30' })
      const closing = buildRunway([], [tender], now).find((item) => item.kind === 'TENDER_CLOSING')
      const submitBy = buildRunway([], [tender], now).find(
        (item) => item.kind === 'TENDER_SUBMIT_BY',
      )

      // End of the stated SA civil day: 23:59 SAST = 21:59Z.
      expect(closing?.date).toBe('2026-11-30T21:59:00.000Z')
      expect(submitBy?.date).toBe('2026-11-29T21:59:00.000Z')
      expect(closing?.date).toBe(deadlineStatus('2026-11-30', now).date?.toISOString())
      // `daysAway` is a whole-day reading of the SA civil calendar: 1 Nov → 30 Nov
      // is 29 days. It used to be `Math.round` over raw instants, which added the
      // 21:59Z wall clock of the end-of-day closing back onto the count.
      expect(closing?.daysAway).toBe(29)
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ
      else process.env.TZ = originalTimezone
    }
  })

  it('shows the day the RFP states for a date-only closing, not the next one', () => {
    const now = new Date('2026-11-01T00:00:00.000Z')
    const item = buildRunway([], [preparedTender({ closingDate: '2026-11-30' })], now).find(
      (candidate) => candidate.kind === 'TENDER_CLOSING',
    )

    // What the runway row renders, expressed in the SA civil calendar the RFP
    // was written in. The old UTC anchor put this at 23:59Z = 01:59 on 1 Dec SAST.
    expect(
      new Date(item!.date).toLocaleDateString('en-ZA', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Africa/Johannesburg',
      }),
    ).toBe('30 Nov 2026')
    // …and the same day for a closing with a stated time.
    const timed = buildRunway(
      [],
      [preparedTender({ closingDate: '30 November 2026 at 11:00' })],
      now,
    ).find((candidate) => candidate.kind === 'TENDER_CLOSING')
    expect(
      new Date(timed!.date).toLocaleDateString('en-ZA', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Africa/Johannesburg',
      }),
    ).toBe('30 Nov 2026')
  })

  it('never prints a NaN day count for a vault expiry date that is not a real date', () => {
    const now = new Date('2026-11-01T00:00:00.000Z')
    const items = buildRunway([vaultDoc({ expiryDate: '2026-99-99' })], [], now)

    expect(items.some((item) => /NaN/.test(item.note))).toBe(false)
    // No expiry event can be scheduled for a value that is not a date; readiness
    // reports the same document as INVALID_DATE and blocks.
    expect(items.some((item) => item.kind === 'VAULT_EXPIRY')).toBe(false)
    expect(assessCanonicalDocHealth(vaultDoc({ expiryDate: '2026-99-99' }), now).health).toBe(
      'INVALID_DATE',
    )
  })

  it('emits the .ics at the real deadline instant, not the SA wall clock', () => {
    const now = new Date('2026-11-01T00:00:00.000Z')
    const timed = buildIcs(
      buildRunway([], [preparedTender({ closingDate: '30 November 2026 at 11:00' })], now),
    )
    const dated = buildIcs(buildRunway([], [preparedTender({ closingDate: '2026-11-30' })], now))

    // 11:00 SAST = 09:00Z, so a calendar shows 11:00 in Johannesburg.
    expect(timed).toContain('DTSTART:20261130T090000Z')
    expect(timed).toContain('DTSTART:20261129T090000Z') // submit-by, 24h earlier
    // Date-only closing: end of the stated SA civil day.
    expect(dated).toContain('DTSTART:20261130T215900Z')
    expect(timed).not.toContain('DTSTART:20261130T110000Z')
  })
})

describe('the load-bearing readiness invariant survives the instant comparison', () => {
  it('reaches ready:true only while the deadline is open and everything else is prepared', () => {
    expect(
      assessReadiness(preparedTender(), [], MOCK_COMPANY, new Date('2026-11-30T08:00:00.000Z'))
        .ready,
    ).toBe(true)
  })

  it('never clears an unfulfilled mandatory requirement, even with the deadline open', () => {
    const report = assessReadiness(
      preparedTender({
        requirements: [
          requirement(),
          requirement({
            id: 'req-tax',
            ruleKey: 'tax_pin',
            title: 'Valid SARS Tax Clearance / TCS PIN',
            status: 'OUTSTANDING',
            linkedVaultDocId: null,
          }),
        ],
      }),
      [],
      MOCK_COMPANY,
      new Date('2026-11-30T08:00:00.000Z'),
    )

    expect(deadlineCheckOf(report).passed).toBe(true)
    expect(report.ready).toBe(false)
    expect(report.checks.find((check) => check.id === 'requirements')?.passed).toBe(false)
  })

  it('never clears an unreviewed OCR-required page, even with the deadline open', () => {
    const report = assessReadiness(
      preparedTender({ ocrPages: 2 }),
      [],
      MOCK_COMPANY,
      new Date('2026-11-30T08:00:00.000Z'),
    )

    expect(deadlineCheckOf(report).passed).toBe(true)
    expect(report.ready).toBe(false)
    expect(report.checks.find((check) => check.id === 'page-extraction')?.passed).toBe(false)
  })

  it('never clears an unconfirmed intake-critical field, even with the deadline open', () => {
    const report = assessReadiness(
      preparedTender({
        intakeVerification: {
          fields: {
            // The real member, not the `value` this fixture used to carry: a
            // field can hold a parsed value and still be undecided, which is
            // exactly the case readiness must not clear.
            closingDate: {
              extractedValue: PARENTHETICAL_CLOSING,
              sourcePage: 1,
              sourceClause: PARENTHETICAL_CLOSING,
              confidence: 0.9,
              candidates: [],
              state: 'unconfirmed',
              reviewedAt: null,
            },
          },
          requirements: {},
          pages: [],
          contactEmail: null,
          conflicts: [],
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      }),
      [],
      MOCK_COMPANY,
      new Date('2026-11-30T08:00:00.000Z'),
    )

    expect(deadlineCheckOf(report).passed).toBe(true)
    expect(report.ready).toBe(false)
    expect(report.checks.find((check) => check.id === 'intake-review')?.passed).toBe(false)
  })
})

describe('document health is unchanged for supported dates', () => {
  it('agrees with readiness on expiry days at the closing date', () => {
    const company: CompanyProfile = MOCK_COMPANY
    const closing = '2026-12-18'
    const report = assessReadiness(
      preparedTender({
        closingDate: closing,
        requirements: [
          requirement({
            id: 'req-tax',
            ruleKey: 'tax_pin',
            title: 'Valid SARS Tax Clearance / TCS PIN',
            linkedVaultDocId: 'vault-tax',
          }),
        ],
      }),
      [vaultDoc({ expiryDate: closing })],
      company,
      NOW,
    )

    expect(report.checks.find((check) => check.id === 'docs-at-closing')?.passed).toBe(true)
    expect(assessGapDocHealth(vaultDoc({ expiryDate: closing }), NOW).health).toBe('VALID')
  })
})

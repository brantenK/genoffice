/**
 * MONEY CORRECTNESS — the rand parser behind the confirmed bid valuation.
 *
 * Regression context (verified audit finding): the extraction-review step parsed
 * money with `raw.replace(/[^\d]/g, '')`, so the source line "R 1 200 000,00"
 * was persisted — and later printed into a client-facing proposal as the
 * "Confirmed Total Bid Valuation" — as 120000000 (100x too large),
 * "R 850 000,50" as 85000050, and "R 2.5 million" as 25 (a million-fold
 * understatement). Every case below asserts an exact value, and the ambiguous
 * forms assert a refusal rather than a guess.
 */
import { describe, expect, it } from 'vitest'

import {
  extractMoneyLiterals,
  formatRandAmount,
  parseMoney,
  parseMoneyDetailed,
  safeMoneyLocale,
} from '../src/shared/money'
import { deriveTenderReview, valuationEdit } from '../src/renderer/src/components/ExtractionReview'
import { parseAwardedValue } from '../src/renderer/src/components/OutcomeDialog'
import { formatMoney } from '../src/renderer/src/components/TenderLifecyclePanel'
import { generateProposalMarkdown, type ProposalInput } from '../src/main/proposal-generator'
import type { PageExtraction } from '../src/shared/types'

const NBSP = '\u00a0'
const NARROW_NBSP = '\u202f'

function extractionWith(lines: string[]): PageExtraction {
  return {
    numPages: 1,
    textPages: 1,
    ocrPages: 0,
    pages: [
      {
        pageNumber: 1,
        width: 595,
        height: 842,
        text: lines.join('\n'),
        needsOcr: false,
        lines: lines.map((text, index) => ({
          pageNumber: 1,
          text,
          box: { top: index * 12, left: 0, width: 500, height: 12 },
        })),
      },
    ],
  }
}

/** Value candidates the review step would offer for a tender's source lines. */
function valueCandidateValues(lines: string[]): string[] {
  const review = deriveTenderReview({
    meta: {
      title: 'Supply and delivery of pumps',
      referenceNumber: null,
      issuingBody: null,
      closingDate: null,
      submissionMethod: null,
      submissionAddress: null,
    },
    extraction: extractionWith(lines),
  })
  return (review.fields.estimatedValue?.candidates ?? []).map((candidate) => candidate.value)
}

describe('rand parsing — South African and international conventions', () => {
  it.each([
    ['R 1 200 000,00', 1_200_000],
    ['1,200,000.00', 1_200_000],
    ['R1200000', 1_200_000],
    ['850 000', 850_000],
    ['R 850 000,50', 850_000.5],
    ['R 1 200 000', 1_200_000],
    ['1 200 000,00', 1_200_000],
    ['R 1,200,000', 1_200_000],
    ['R 1.200.000', 1_200_000],
    ['ZAR 850 000', 850_000],
    ['R 850 000 rand', 850_000],
    ['Rand 850 000', 850_000],
    ['R 2 500 000.00', 2_500_000],
    ['R 0,50', 0.5],
    ['R 500', 500],
    ['  1 200 000  ', 1_200_000],
    [`R${NBSP}1${NBSP}200${NBSP}000,00`, 1_200_000],
    [`R${NARROW_NBSP}1${NARROW_NBSP}200${NARROW_NBSP}000,00`, 1_200_000],
  ])('parses %s as %d', (raw, expected) => {
    expect(parseMoney(raw)).toBe(expected)
  })

  it.each([['1.200'], ['1,200'], ['R 1.200 million'], ['R 1 200.000']])(
    'refuses the ambiguous form %s instead of guessing',
    (raw) => {
      const result = parseMoneyDetailed(raw)
      expect(parseMoney(raw)).toBeNull()
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('ambiguous-separator')
      expect(result.message).toMatch(/ambiguous/i)
    },
  )

  it('refuses malformed grouping instead of reading the digits it contains', () => {
    for (const raw of ['R 1 20 000', 'R 1,20,000', 'R 500 000.', 'R ,50', 'R 1.2345']) {
      const result = parseMoneyDetailed(raw)
      expect(parseMoney(raw), raw).toBeNull()
      expect(result.ok, raw).toBe(false)
    }
  })

  it('reads magnitude suffixes as a multiplier and never drops them', () => {
    expect(parseMoney('R 1.2m')).toBe(1_200_000)
    expect(parseMoney('R 1,2m')).toBe(1_200_000)
    expect(parseMoney('R 2.5 million')).toBe(2_500_000)
    expect(parseMoney('R 2.5million')).toBe(2_500_000)
    expect(parseMoney('R 100k')).toBe(100_000)
    expect(parseMoney('R 12 thousand')).toBe(12_000)
    expect(parseMoney('R 3bn')).toBe(3_000_000_000)
    expect(parseMoney('R 1 200 million')).toBe(1_200_000_000)
    // Bilingual SA documents: the Afrikaans/Dutch forms carry the same value.
    expect(parseMoney('R 2,5 miljoen')).toBe(2_500_000)
    expect(parseMoney('R 1 miljard')).toBe(1_000_000_000)
    expect(parseMoney('R 500 duisend')).toBe(500_000)
  })

  it('reads the plural and alternate scale words instead of dropping them', () => {
    // A suffix that is dropped leaves the bare digits, which understates the
    // amount a thousand- or million-fold — so every form the documents use is
    // listed, and the plural forms multiply just like the singular.
    expect(parseMoney('R 2,5 miljoene')).toBe(2_500_000)
    expect(parseMoney('R 500 duisende')).toBe(500_000)
    expect(parseMoney('R 1,5 miljarde')).toBe(1_500_000_000)
    expect(parseMoney('R 2.5 millions')).toBe(2_500_000)
    expect(parseMoney('R 500 thousands')).toBe(500_000)
    expect(parseMoney('R 3 billions')).toBe(3_000_000_000)
    expect(extractMoneyLiterals('Kontrakwaarde: R 2,5 miljoene')).toEqual(['R 2,5 miljoene'])
  })

  it('refuses a single-letter suffix that a space turns into a unit', () => {
    // `R 1.2m` is 1,2 million in SA usage, but after a space `m` is a metre and
    // `k` a kilogram as easily as a magnitude, so the spaced form is refused
    // rather than guessed: "Trenching R 500 m" is a rate, not 500 million.
    for (const raw of ['R 500 m', 'R 250 m', 'R 2.5 m', 'R 2.5 M', 'R 500 k', 'R 100 k']) {
      const result = parseMoneyDetailed(raw)
      expect(parseMoney(raw), raw).toBeNull()
      expect(result.ok, raw).toBe(false)
      if (result.ok) continue
      expect(result.error, raw).toBe('ambiguous-magnitude')
      expect(result.message, raw).toMatch(/ambiguous/i)
    }
    // Tight against the digits the suffix is unambiguous — that is the SA form.
    expect(parseMoney('R1.2m')).toBe(1_200_000)
    expect(parseMoney('R 1.2m')).toBe(1_200_000)
    expect(parseMoney('R 500k')).toBe(500_000)
    expect(parseMoney('R 100k')).toBe(100_000)
  })

  it('offers no value candidate for a metre rate read as millions', () => {
    expect(extractMoneyLiterals('Trenching R 500 m')).toEqual([])
    expect(extractMoneyLiterals('Cable @ R 250 m')).toEqual([])
    expect(extractMoneyLiterals('Supply and install R 2.5 m')).toEqual([])
    expect(extractMoneyLiterals('R 500 k')).toEqual([])
    expect(valueCandidateValues(['Trenching R 500 m'])).toEqual([])
    expect(valueCandidateValues(['Cable @ R 250 m'])).toEqual([])
    expect(valueCandidateValues(['Supply and install R 2.5 m'])).toEqual([])
  })

  it('offers the multiplied value for the plural scale words', () => {
    expect(valueCandidateValues(['Kontrakwaarde: R 2,5 miljoene'])).toEqual(['2500000'])
    expect(valueCandidateValues(['Waarde: R 500 duisende'])).toEqual(['500000'])
    expect(valueCandidateValues(['Waarde: R 1,5 miljarde'])).toEqual(['1500000000'])
    expect(valueCandidateValues(['R 2.5 millions'])).toEqual(['2500000'])
    expect(valueCandidateValues(['R 2.5 millions'])).not.toContain('2.5')
  })

  it('refuses a scale word whose value is not unambiguous instead of truncating', () => {
    // "biljoen" is 10^9 in Afrikaans and 10^12 in Dutch, so the amount is not
    // readable: it must not come back as 2,5.
    expect(parseMoney('R 2.5 biljoen')).toBeNull()
    expect(extractMoneyLiterals('R 2.5 biljoen')).toEqual([])
    expect(extractMoneyLiterals('R 2.5 mln')).toEqual([])
    // The plural of an ambiguous word is refused just as the singular is.
    expect(parseMoney('R 2,5 biljoene')).toBeNull()
    expect(extractMoneyLiterals('R 2,5 biljoene')).toEqual([])
    expect(valueCandidateValues(['Waarde: R 2,5 biljoene'])).toEqual([])
  })

  it('refuses an accounting negative rather than flipping the sign', () => {
    // Decision (documented in `src/shared/money.ts`): "(R 500 000)" is a
    // negative amount. A bid value cannot be negative and the persisted
    // `estimatedValue` must be non-negative, so the amount is refused with an
    // explanation instead of being recorded as R 500 000.
    const result = parseMoneyDetailed('(R 500 000)')
    expect(parseMoney('(R 500 000)')).toBeNull()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('negative')
    expect(result.message).toMatch(/cannot be negative/i)

    for (const raw of ['R -500 000', '-R 500 000', 'R 500 000-', 'R \u2212500 000']) {
      expect(parseMoney(raw), raw).toBeNull()
      expect(parseMoneyDetailed(raw).ok, raw).toBe(false)
    }
  })

  it('refuses zero, empty and non-money text', () => {
    expect(parseMoneyDetailed('R 0').ok).toBe(false)
    expect(parseMoneyDetailed('0,00').ok).toBe(false)
    expect(parseMoneyDetailed('').ok).toBe(false)
    expect(parseMoneyDetailed('   ').ok).toBe(false)
    expect(parseMoney('R')).toBeNull()
    expect(parseMoney('about R 500 000 per m\u00b2')).toBeNull()
    expect(parseMoney('R 1 200 000 000 000 000 000')).toBeNull()
    expect(parseMoneyDetailed('R 1 200 000 000 000 000 000').ok).toBe(false)
  })

  it('accepts an already-numeric amount without re-reading it', () => {
    expect(parseMoney(1_200_000)).toBe(1_200_000)
    expect(parseMoney(850_000.5)).toBe(850_000.5)
    expect(parseMoney(0)).toBeNull()
    expect(parseMoney(-1)).toBeNull()
    expect(parseMoney(Number.NaN)).toBeNull()
    expect(parseMoney(Number.POSITIVE_INFINITY)).toBeNull()
    expect(parseMoney(null)).toBeNull()
    expect(parseMoney(undefined)).toBeNull()
    expect(parseMoney({})).toBeNull()
  })
})

describe('the three audit regressions', () => {
  it('reads "R 1 200 000,00" as 1 200 000, not 120 000 000', () => {
    expect(parseMoney('R 1 200 000,00')).toBe(1_200_000)
    expect(parseMoney('R 1 200 000,00')).not.toBe(120_000_000)
    expect(parseMoneyDetailed('R 1 200 000,00')).toMatchObject({
      ok: true,
      value: 1_200_000,
      canonical: '1200000',
    })
  })

  it('reads "R 850 000,50" as 850 000,50, not 85 000 050', () => {
    expect(parseMoney('R 850 000,50')).toBe(850_000.5)
    expect(parseMoney('R 850 000,50')).not.toBe(85_000_050)
  })

  it('reads "R 2.5 million" as 2 500 000, not 25', () => {
    expect(parseMoney('R 2.5 million')).toBe(2_500_000)
    expect(parseMoney('R 2.5 million')).not.toBe(25)
  })
})

describe('money literal scanning in tender source text', () => {
  it('finds rand literals and keeps a magnitude suffix attached', () => {
    expect(extractMoneyLiterals('Estimated value: R 1 200 000,00 (VAT incl.)')).toEqual([
      'R 1 200 000,00',
    ])
    expect(extractMoneyLiterals('The contract value is R 2.5 million for 36 months')).toEqual([
      'R 2.5 million',
    ])
    expect(extractMoneyLiterals('Budget R1.2m')).toEqual(['R1.2m'])
    expect(extractMoneyLiterals('R 500 000 or R 750 000')).toEqual(['R 500 000', 'R 750 000'])
    expect(extractMoneyLiterals('R 500 000 each')).toEqual(['R 500 000'])
  })

  it('does not treat a per-unit rate as a tender value', () => {
    // Slash, square/cubic metre, a bare measurement unit, "per" with a unit,
    // and a rate period: all of these make the amount a price per unit, so
    // offering it as the tender value would overstate the bid by the quantity.
    for (const line of [
      'Unit rate R 250/m\u00b2',
      'Rate: R 250 m\u00b2',
      'R 250 per m\u00b2',
      'R 250 m2',
      'R 2 500 per day',
      'Unit rate R 250 per unit',
      'R 250 per hour',
      'R 250 kg',
      'R 250 per person',
      'R 500 000 per annum',
      'R 500 000 monthly',
      'R 500 000 per km',
    ]) {
      expect(extractMoneyLiterals(line), line).toEqual([])
      expect(valueCandidateValues([line]), line).toEqual([])
    }
    // An ordinary word after the amount does not make it a rate.
    expect(extractMoneyLiterals('R 500 000 each')).toEqual(['R 500 000'])
    expect(extractMoneyLiterals('R 500 000 set aside')).toEqual(['R 500 000'])
    expect(extractMoneyLiterals('R 500 000 per the RFP')).toEqual(['R 500 000'])
    expect(extractMoneyLiterals('R 500 000 excluding VAT')).toEqual(['R 500 000'])
    expect(extractMoneyLiterals('brand 500')).toEqual([])
  })

  it('refuses to merge whitespace-joined digits into one absurd amount', () => {
    // A flattened table row puts the next column right after the amount, and a
    // fourth group is as likely to be that column as a grouping separator, so
    // the run is refused instead of concatenated into 1200000100.
    expect(parseMoney('R 1 200 000 100')).toBeNull()
    expect(extractMoneyLiterals('R 1 200 000 100')).toEqual([])
    expect(valueCandidateValues(['R 1 200 000 100'])).toEqual([])
    expect(parseMoney('R 1 200 000 1 200 000')).toBeNull()
    expect(extractMoneyLiterals('R 1 200 000 1 200 000')).toEqual([])
    expect(parseMoney('R 1 20 000')).toBeNull()
    // Three groups is an ordinary South African amount and still reads exactly.
    expect(parseMoney('R 1 200 000')).toBe(1_200_000)
    expect(extractMoneyLiterals('Estimated value: R 1 200 000')).toEqual(['R 1 200 000'])
    expect(valueCandidateValues(['Estimated value: R 1 200 000'])).toEqual(['1200000'])
    // Without spaces the digits are unambiguous at any length, and a grouped
    // amount written with commas is not whitespace-joined at all.
    expect(parseMoney('1200000100')).toBe(1_200_000_100)
    expect(parseMoney('1,200,000,100')).toBe(1_200_000_100)
  })

  it('reads stacked currency decorations as decoration, not as a second amount', () => {
    expect(parseMoney('ZAR R 850 000')).toBe(850_000)
    expect(parseMoney('R ZAR 850 000')).toBe(850_000)
    expect(parseMoney('R R 850 000')).toBe(850_000)
    expect(parseMoney('ZAR 850 000 rand')).toBe(850_000)
    expect(extractMoneyLiterals('ZAR R 850 000')).toEqual(['R 850 000'])
    expect(valueCandidateValues(['Estimated value: ZAR R 850 000'])).toEqual(['850000'])
  })

  it('refuses an amount that is not exact at cent precision', () => {
    // 850000.555 printed as R 850 000,56 would be a number the record never
    // held, so the sub-cent amount is refused rather than rounded.
    const result = parseMoneyDetailed(850_000.555)
    expect(parseMoney(850_000.555)).toBeNull()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('too-precise')
    expect(result.message).toMatch(/two decimal places/i)
    // Cent-exact values still pass, including ones whose binary form is inexact.
    expect(parseMoney(850_000.5)).toBe(850_000.5)
    expect(parseMoney(0.07)).toBe(0.07)
    expect(parseMoney(1.1)).toBe(1.1)
    expect(parseMoney(Number.MAX_SAFE_INTEGER)).toBeNull()
  })
})

describe('the review step never offers a garbage or truncated value', () => {
  it('offers the corrected value for the audit source lines', () => {
    expect(valueCandidateValues(['Estimated contract value: R 1 200 000,00'])).toEqual(['1200000'])
    expect(valueCandidateValues(['Estimated contract value: R 1 200 000,00'])).not.toContain(
      '120000000',
    )
    expect(valueCandidateValues(['The tender value is R 2.5 million'])).toEqual(['2500000'])
    expect(valueCandidateValues(['The tender value is R 2.5 million'])).not.toContain('25')
    expect(valueCandidateValues(['Bid amount: R 850 000,50'])).toEqual(['850000.5'])
    expect(valueCandidateValues(['Kontrakwaarde: R 2,5 miljoen'])).toEqual(['2500000'])
  })

  it('offers no candidate for an ambiguous or rate-only amount', () => {
    expect(valueCandidateValues(['Estimated value: R 1.200'])).toEqual([])
    expect(valueCandidateValues(['Unit rate R 250/m\u00b2'])).toEqual([])
    expect(valueCandidateValues(['Waarde: R 2,5 biljoen'])).toEqual([])
  })

  it('keeps competing amounts as separate candidates instead of merging them', () => {
    expect(valueCandidateValues(['Tender value R 1 200 000,00 or R 2 400 000,00']).sort()).toEqual([
      '1200000',
      '2400000',
    ])
  })
})

describe('the single rand formatter round-trips through the parser', () => {
  it('formats every amount the proposal document prints in a parseable form', () => {
    for (const locale of ['en-ZA', 'en-US', 'de-DE', undefined]) {
      // 1 200 000 000 and 123 456 789 012,34 are grouped into four and five
      // groups, which is where the grouping conventions actually diverge.
      for (const value of [
        500, 850_000.5, 1_200_000, 2_500_000, 120_000_000, 1_200_000_000, 123_456_789_012.34,
      ]) {
        const printed = formatRandAmount(value, locale)
        expect(printed.startsWith('R '), printed).toBe(true)
        expect(parseMoney(printed), `${locale ?? 'default'} ${printed}`).toBe(value)
      }
    }
  })

  it('formats exactly as the proposal document expects', () => {
    const expected = `R ${new Intl.NumberFormat('en-ZA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(1_200_000)}`
    expect(formatRandAmount(1_200_000, 'en-ZA')).toBe(expected)
    expect(formatRandAmount(1_200_000)).toBe(expected)
  })

  it('falls back to en-ZA for an unusable locale', () => {
    expect(safeMoneyLocale(undefined)).toBe('en-ZA')
    expect(safeMoneyLocale('')).toBe('en-ZA')
    expect(safeMoneyLocale('en_US')).toBe('en-ZA')
    expect(safeMoneyLocale('en-US')).toBe('en-US')
  })

  it('rejects a locale whose formatting the parser cannot read back', () => {
    // `en-IN` groups as `12,00,000` and `ar-EG` writes Arabic-Indic digits;
    // neither is a rand amount this module can read, and a locale is only kept
    // when its output round-trips, so the printed amount can never be one the
    // parser refuses.
    expect(safeMoneyLocale('en-IN')).toBe('en-ZA')
    expect(safeMoneyLocale('ar-EG')).toBe('en-ZA')
    expect(formatRandAmount(1_200_000, 'en-IN')).toBe(formatRandAmount(1_200_000, 'en-ZA'))
    expect(parseMoney(formatRandAmount(1_200_000, 'en-IN'))).toBe(1_200_000)
    expect(parseMoney(formatRandAmount(1_200_000, 'ar-EG'))).toBe(1_200_000)
    // A readable locale is left alone.
    expect(safeMoneyLocale('de-DE')).toBe('de-DE')
    expect(safeMoneyLocale('fr-FR')).toBe('fr-FR')
  })
})

describe('the outcome dialog records only an amount the shared parser reads exactly', () => {
  it('reads "R 2.5 million" as 2 500 000, not 2,5', () => {
    // The dialog used to strip every non-digit/non-dot character from the
    // awarded value, so this amount was persisted as 2.5.
    expect(parseAwardedValue('R 2.5 million')).toEqual({ ok: true, value: 2_500_000 })
    expect(parseMoneyDetailed('R 2.5 million')).toMatchObject({ ok: true, value: 2_500_000 })
  })

  it('reads a fully separated amount exactly', () => {
    expect(parseAwardedValue('R 1 200 000,00')).toEqual({ ok: true, value: 1_200_000 })
    expect(parseAwardedValue('R 1.200.000,00')).toEqual({ ok: true, value: 1_200_000 })
    expect(parseAwardedValue('R 850 000,50')).toEqual({ ok: true, value: 850_000.5 })
  })

  it('refuses an ambiguous amount instead of recording the smaller number', () => {
    // "R 1.200" is 1,2 in SA style and 1 200 in US style. The dialog used to
    // record it as 1.2 without ever asking.
    const result = parseAwardedValue('R 1.200')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/ambiguous/i)
  })

  it('refuses zero, a negative and non-money text, carrying the reason', () => {
    for (const raw of ['R 0', '0', '0,00', '(R 500 000)', 'R -500 000', 'about four million']) {
      const result = parseAwardedValue(raw)
      expect(result.ok, raw).toBe(false)
      if (result.ok) continue
      expect(result.message.length, raw).toBeGreaterThan(0)
    }
  })

  it('treats a blank field as "not stated yet" rather than zero', () => {
    expect(parseAwardedValue('')).toEqual({ ok: true, value: null })
    expect(parseAwardedValue('   ')).toEqual({ ok: true, value: null })
  })
})

describe('a refused valuation edit withdraws the confirmation', () => {
  it('confirms exactly the amount the parser read', () => {
    expect(valuationEdit('R 1 200 000')).toEqual({
      ok: true,
      patch: { estimatedValue: 1_200_000, pricingConfirmed: true },
    })
    expect(valuationEdit('  R 2.5 million ')).toEqual({
      ok: true,
      patch: { estimatedValue: 2_500_000, pricingConfirmed: true },
    })
  })

  it('clears both the value and the confirmation when the field is emptied', () => {
    expect(valuationEdit('')).toEqual({
      ok: true,
      patch: { estimatedValue: null, pricingConfirmed: false },
    })
    expect(valuationEdit('   ')).toEqual({
      ok: true,
      patch: { estimatedValue: null, pricingConfirmed: false },
    })
  })

  it('withdraws the confirmation when the edit is refused', () => {
    // The stale behaviour: the refusal returned the message and left
    // `pricingConfirmed: true`, so the proposal kept printing the earlier
    // R 1 200 000,00 while the field showed what the user had just typed.
    for (const raw of ['R 1.200', 'R 500 m', 'R 0', '(R 500 000)', 'R 1 200 000 100']) {
      const edit = valuationEdit(raw)
      expect(edit.ok, raw).toBe(false)
      if (edit.ok) continue
      expect(edit.patch, raw).toEqual({ pricingConfirmed: false })
      expect(edit.patch, raw).not.toHaveProperty('estimatedValue')
      expect(edit.message.length, raw).toBeGreaterThan(0)
    }
  })

  it('stops the client-facing proposal printing the earlier amount', () => {
    // The whole point of the field: an amount the user is replacing must not
    // survive as a confirmed valuation in the document.
    const confirmed: ProposalInput = {
      title: 'Supply and Delivery of Pumps',
      estimatedValue: 1_200_000,
      pricingConfirmed: true,
      requirements: [],
      milestones: [],
    }
    expect(generateProposalMarkdown(confirmed)).toContain('Confirmed Total Bid Valuation')

    const edit = valuationEdit('R 1.200')
    expect(edit.ok).toBe(false)
    if (edit.ok) return
    const afterRefusal = generateProposalMarkdown({ ...confirmed, ...edit.patch })
    expect(afterRefusal).not.toContain('Confirmed Total Bid Valuation')
    expect(afterRefusal).not.toContain('1 200 000')
    expect(afterRefusal).toMatch(/pricing[^\n]*(?:not provided|unconfirmed)/i)
  })
})

describe('the lifecycle panel prints the awarded value with the shared formatter', () => {
  it('formats the awarded value exactly as the proposal document does', () => {
    // It used to print `R 850 000.5` from `value.toLocaleString('en-ZA')`, so
    // the panel and the proposal showed the same amount two different ways.
    // en-ZA groups with a no-break space, which is what the document prints.
    expect(formatMoney(850_000.5)).toBe(`R 850${NBSP}000,50`)
    expect(formatMoney(1_250_000)).toBe(`R 1${NBSP}250${NBSP}000,00`)
    expect(formatMoney(850_000.5)).toBe(formatRandAmount(850_000.5))
    expect(parseMoney(formatMoney(1_250_000))).toBe(1_250_000)
  })

  it('says "Not stated" for a missing awarded value instead of R 0,00', () => {
    expect(formatMoney(null)).toBe('Not stated')
    expect(formatMoney(undefined)).toBe('Not stated')
  })
})

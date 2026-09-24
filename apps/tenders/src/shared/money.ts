// South African rand parsing and formatting — pure, no I/O, no dependencies.
//
// A mis-read rand amount is not a cosmetic bug: the value confirmed in the
// extraction-review step is printed into a client-facing document as the
// "Confirmed Total Bid Valuation". The previous renderer parser stripped every
// non-digit character (`raw.replace(/[^\d]/g, '')`), so "R 1 200 000,00" became
// 120000000 (100x too large), "R 850 000,50" became 85000050 and
// "R 2.5 million" became 25 (catastrophic understatement). Nothing here ever
// truncates an amount to the digits it happens to contain.
//
// Rules (each one is a decision, not an accident):
//
//  - `R`, `ZAR`, `Rand`/`Rands` around the amount are decoration, not value, and
//    they stack: `ZAR R 850 000` is 850000.
//  - Spaces group (`850 000` = 850000), including non-breaking and narrow
//    no-break spaces, which PDF text extraction emits; the three-group limit on
//    plain-space runs is the next rule.
//  - `,` and `.` group when the amount also carries a decimal separator or
//    repeats the separator: `1,200,000` = `1.200.000` = `1 200 000` = 1200000.
//    Groups after the first must be exactly three digits.
//  - The decimal separator is the last `,` or `.` followed by one or two
//    digits, in either SA style (`1 200 000,00`) or international style
//    (`1,200,000.00`).
//  - A *lone* `,` or `.` before exactly three digits is genuinely ambiguous —
//    `1.200` is 1,2 in SA style and 1 200 in US style — so it is REJECTED
//    rather than guessed. The same applies to `1,200` and to `1 200.000`.
//  - A whitespace-joined digit run is one amount only while it keeps the
//    three-digit discipline *and* stays within three groups. A plain space is
//    the character PDF text extraction emits for a column gap, so
//    `R 1 200 000 100` is REFUSED rather than concatenated into 1200000100 — it
//    is just as likely to be two numbers from a flattened table row. No-break
//    and narrow no-break spaces can only come from typesetting, so they group
//    without that limit (which is what lets `formatRandAmount` output round-trip
//    at any magnitude), and the free-text literal scanner applies the
//    three-group limit to every kind of whitespace, because there the
//    adjacency is live whatever the space is.
//  - Magnitude suffixes (`k`, `thousand`, `m`, `mn`, `mil`, `million`, `bn`,
//    `billion`, and the unambiguous Afrikaans/Dutch `miljoen`, `miljard`,
//    `duisend`, `duizend`) multiply the amount: `R 1.2m` = 1200000,
//    `R 2.5 million` = 2500000, `R 2,5 miljoen` = 2500000. The forms are listed
//    exhaustively, plurals included (`millions`, `miljoene`, `duisende`),
//    because a suffix is never dropped: dropping one understates the amount a
//    thousand- or million-fold, so a scale word must either multiply the amount
//    or make the literal unusable — it may never leave the bare digits.
//  - A single-letter suffix must be tight against the digits. `R1.2m` is
//    1 200 000, but after a space a single letter is a unit as easily as a
//    magnitude — `m` is metres, `k` is kilos — so `R 500 m` is REFUSED rather
//    than guessed at 500 million.
//  - A scale word whose value is not unambiguous (`biljoen` is 10^9 in
//    Afrikaans and 10^12 in Dutch, `mln`, `mio`, `crore`, `lakh`) makes the
//    literal unusable rather than silently truncated.
//  - A literal followed by a unit or by "per" (`R 250/m²`, `R 2 500 per day`,
//    `R 250 kg`) is a rate, not the tender value, and is not offered as one.
//  - Accounting negatives (`(R 500 000)`, `-R 500 000`, `R 500 000-`) are
//    REJECTED. A bid value cannot be negative, and flipping the sign to keep a
//    number would invent a value the document never stated.
//  - Zero is REJECTED: a zero valuation must not look confirmed.
//  - Amounts above the exact-integer range, and amounts that are not exact at
//    cent precision (`850000.555`), are REJECTED rather than rounded.
//  - Anything that is not a single money literal after normalisation is
//    rejected; there is no partial extraction and no best-effort guess.

export type MoneyParseErrorCode =
  | 'empty'
  | 'not-a-number'
  | 'ambiguous-separator'
  | 'ambiguous-magnitude'
  | 'invalid-grouping'
  | 'negative'
  | 'zero'
  | 'too-precise'
  | 'out-of-range'

export interface MoneyParseSuccess {
  ok: true
  /** The rand amount, e.g. `1200000` or `850000.5`. */
  value: number
  /** Canonical plain form of the amount, e.g. `"1200000"` / `"850000.5"`. */
  canonical: string
}

export interface MoneyParseFailure {
  ok: false
  error: MoneyParseErrorCode
  /** Honest, user-facing reason the amount was not accepted. */
  message: string
}

export type MoneyParseResult = MoneyParseSuccess | MoneyParseFailure

// ── normalisation ────────────────────────────────────────────────────────────

// Every Unicode space (`\u00a0`, `\u1680`, `\u2000`-`\u200a`, `\u202f`, `\u205f`,
// `\u3000`) is matched by `\s`, so no space is rewritten here on purpose: the
// difference between a plain space and a no-break space is load-bearing (see
// `MAX_PLAIN_SPACE_GROUPS`), and rewriting it away would erase that.
const UNICODE_MINUSES = /[\u2212\u2010-\u2015\u2043]/g
const CURRENCY_PREFIX = /^(?:zar|rands?|r)\.?\s*/i
const CURRENCY_SUFFIX = /\s*(?:zar|rands?)$/i
const MAGNITUDE_SUFFIX = /\s*([A-Za-z]+)\.?$/
const ACCOUNTING_NEGATIVE = /^\(.*\)$/s
const NUMERIC_BODY = /^[\d\s.,]+$/
const SEPARATOR = /[.,]/g
const GROUP_SPLIT = /[\s.,]+/
/** A plain ASCII space used between two digits, i.e. a grouping separator. */
const PLAIN_SPACE_GROUP = /\d \d/
/** `R 1 200 000` is three groups; a fourth is refused (see the header). */
const MAX_PLAIN_SPACE_GROUPS = 3

/**
 * Every scale-word form the parser reads, with its multiplier. The forms are
 * listed rather than derived by stripping a plural, so that adding a form is a
 * deliberate decision and a scale word can never be dropped: a form that is
 * missing here makes the literal unusable, it never leaves the bare digits.
 */
const MAGNITUDE_FORMS: ReadonlyArray<readonly [string, number]> = [
  ['billion', 1_000_000_000],
  ['billions', 1_000_000_000],
  ['bn', 1_000_000_000],
  ['million', 1_000_000],
  ['millions', 1_000_000],
  ['mn', 1_000_000],
  ['mil', 1_000_000],
  ['m', 1_000_000],
  ['thousand', 1_000],
  ['thousands', 1_000],
  ['k', 1_000],
  // Bilingual South African documents use the Afrikaans/Dutch forms too, and
  // each of these has one unambiguous value in both languages.
  ['miljard', 1_000_000_000],
  ['miljarde', 1_000_000_000],
  ['miljoen', 1_000_000],
  ['miljoene', 1_000_000],
  ['duisend', 1_000],
  ['duisende', 1_000],
  ['duizend', 1_000],
  ['duizenden', 1_000],
]

const MAGNITUDE_MULTIPLIER = new Map(MAGNITUDE_FORMS)

/** The multi-letter forms, longest first, for the literal scanner. */
const MAGNITUDE_WORDS = MAGNITUDE_FORMS.map(([form]) => form)
  .filter((form) => form.length > 1)
  .sort((left, right) => right.length - left.length)
  .join('|')

/**
 * Suffixes that double as a unit of measure once a space separates them from
 * the digits, so they are only read as a magnitude when they are tight.
 */
const TIGHT_ONLY_SUFFIXES = new Set(['m', 'k'])

/**
 * Scale words whose value is not unambiguous (Dutch `biljoen` is 10^12 while
 * Afrikaans `biljoen` is 10^9, `mio`/`mln`/`mrd` are non-South-African
 * abbreviations). An amount written with one of these is refused rather than
 * offered as the truncated number, so `R 2.5 biljoen` is never read as 2,5.
 */
const AMBIGUOUS_SCALE_WORDS = new Set([
  'biljoen',
  'biljoene',
  'biljard',
  'biljarde',
  'triljoen',
  'triljoene',
  'triljard',
  'triljarde',
  'mio',
  'mln',
  'mrd',
  'crore',
  'crores',
  'lakh',
  'lakhs',
])

/**
 * Units that turn the amount before them into a rate: `R 250/m²`,
 * `R 2 500 per day`, `R 250 kg`. Measurements and time words are a unit on
 * their own; counting nouns are only a unit after "per", so `R 500 000 set
 * aside` stays the tender value while `R 250 per unit` does not.
 */
const MEASURE_UNIT =
  'm|km|cm|mm|kg|g|mg|t|ton|tonne|metre|meter|litre|liter|l|ml|ha|kwh|kw|hp|hour|hr|minute|second|day|week|month|quarter|annum|year|shift'
const COUNT_UNIT = 'unit|item|person|people|point|copy|set|lot'
const RATE_PERIOD = 'monthly|annually|weekly|daily|hourly|quarterly'

/**
 * A literal followed by one of these is a rate, not the tender value. Applied
 * in code rather than as a regex lookahead: a lookahead would only make the
 * literal pattern backtrack into a shorter literal (`R 250/m²` would come back
 * as `R 25`).
 */
const PER_UNIT_AFTER = new RegExp(
  `^(?:\\s*[²³/]` +
    `|\\s*per\\s*(?:[²³/]|(?:${MEASURE_UNIT}|${COUNT_UNIT})s?\\b)` +
    `|\\s*(?:${MEASURE_UNIT})s?[²³23]?\\b` +
    `|\\s*(?:${RATE_PERIOD})\\b)`,
  'i',
)

const AMOUNT_MESSAGE = 'Enter a rand amount, for example 1 200 000 or 1 200 000,00.'
const NEGATIVE_MESSAGE =
  'A bid value cannot be negative. Enter the positive rand amount, or mark the value not stated.'
const ZERO_MESSAGE = 'Enter an amount greater than zero, or mark the value not stated.'
const RANGE_MESSAGE = 'That amount is too large to record. Check the digits and try again.'
const PRECISION_MESSAGE =
  'A rand amount has at most two decimal places (cents). Round the amount and try again.'
const GROUPING_MESSAGE =
  'Group the digits in threes (1 200 000) or leave the separators out (1200000).'
const MERGE_MESSAGE =
  'Four or more space-separated groups read as two amounts side by side (a flattened table row) as easily as one. Type the digits plainly (1200000100) or write the amount with a magnitude.'

function failure(error: MoneyParseErrorCode, message: string): MoneyParseFailure {
  return { ok: false, error, message }
}

function ambiguousSeparatorMessage(text: string): string {
  const separatorIndex = Math.max(text.lastIndexOf(','), text.lastIndexOf('.'))
  const decimalReading = Number(
    `${text.slice(0, separatorIndex).replace(/[^\d]/g, '')}.${text.slice(separatorIndex + 1)}`,
  )
  const groupedReading = Number(text.replace(/[^\d]/g, ''))
  return `"${text}" is ambiguous — it could be ${decimalReading} or ${groupedReading}. Write the cents after a comma (for example 1 200 000,00) or type the digits plainly (1200000).`
}

function ambiguousMagnitudeMessage(text: string): string {
  return `"${text}" is ambiguous: a single letter after a space reads as a unit (m = metres) as easily as a magnitude. Write the digits plainly (500000000) or keep the suffix tight (500m).`
}

// ── numeric body ─────────────────────────────────────────────────────────────

interface NumericBody {
  /** Every digit, decimal point removed, e.g. "85000050". */
  digits: string
  /** How many of those trailing digits are the cents fraction. */
  fractionDigits: number
}

/**
 * Strip grouping separators, requiring groups of three after the first.
 *
 * A plain-space run is additionally capped at three groups: from four groups on
 * the run is indistinguishable from two amounts that a text extractor placed
 * side by side, so it is refused instead of concatenated.
 */
function ungroup(text: string): string | MoneyParseFailure {
  const groups = text.split(GROUP_SPLIT)
  if (groups.some((group) => !/^\d+$/.test(group)))
    return failure('invalid-grouping', GROUPING_MESSAGE)
  if (groups.length === 1) return groups[0]
  if (PLAIN_SPACE_GROUP.test(text) && groups.length > MAX_PLAIN_SPACE_GROUPS)
    return failure('invalid-grouping', MERGE_MESSAGE)
  if (groups[0].length > 3) return failure('invalid-grouping', GROUPING_MESSAGE)
  if (groups.slice(1).some((group) => group.length !== 3))
    return failure('invalid-grouping', GROUPING_MESSAGE)
  return groups.join('')
}

/**
 * Split a separator-bearing digit run into its digits and its cents fraction.
 * Rejects the ambiguous lone `,`/`.` before three digits instead of guessing.
 */
function parseNumericBody(text: string): NumericBody | MoneyParseFailure {
  let lastIndex = -1
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index]
    if (char === ',' || char === '.') {
      lastIndex = index
      break
    }
  }
  if (lastIndex === -1) {
    const digits = ungroup(text)
    return typeof digits === 'string' ? { digits, fractionDigits: 0 } : digits
  }
  const after = text.slice(lastIndex + 1)
  if (!/^\d+$/.test(after)) return failure('invalid-grouping', GROUPING_MESSAGE)
  if (after.length <= 2) {
    const digits = ungroup(text.slice(0, lastIndex))
    return typeof digits === 'string'
      ? { digits: `${digits}${after}`, fractionDigits: after.length }
      : digits
  }
  if (after.length === 3) {
    // `1.200` / `1,200`: a thousands group in one convention, a decimal in the
    // other. With two or more separators the separators must be grouping, so
    // only the lone case is refused.
    if ((text.match(SEPARATOR) ?? []).length === 1)
      return failure('ambiguous-separator', ambiguousSeparatorMessage(text))
    const digits = ungroup(text)
    return typeof digits === 'string' ? { digits, fractionDigits: 0 } : digits
  }
  return failure('invalid-grouping', GROUPING_MESSAGE)
}

// ── parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a rand amount, reporting why it was refused. Use this when the reason
 * must reach the user; `parseMoney` is the `number | null` convenience.
 */
export function parseMoneyDetailed(raw: unknown): MoneyParseResult {
  if (typeof raw === 'number') {
    // An already-parsed amount: keep it exact or refuse it, never re-read it.
    if (!Number.isFinite(raw)) return failure('not-a-number', AMOUNT_MESSAGE)
    if (raw < 0) return failure('negative', NEGATIVE_MESSAGE)
    if (raw === 0) return failure('zero', ZERO_MESSAGE)
    const cents = Math.round(raw * 100)
    if (!Number.isSafeInteger(cents)) return failure('out-of-range', RANGE_MESSAGE)
    // The amount itself must be exact at cent precision. Checking only the
    // rounded cents would let 850000.555 through and print it as R 850 000,56.
    if (cents / 100 !== raw) return failure('too-precise', PRECISION_MESSAGE)
    return { ok: true, value: raw, canonical: String(raw) }
  }
  if (typeof raw !== 'string') return failure('not-a-number', AMOUNT_MESSAGE)

  const normalised = raw.normalize('NFC').replace(UNICODE_MINUSES, '-').trim()
  if (!normalised) return failure('empty', AMOUNT_MESSAGE)
  if (ACCOUNTING_NEGATIVE.test(normalised)) return failure('negative', NEGATIVE_MESSAGE)

  const body = stripCurrencyDecoration(normalised)
  if (body.startsWith('-') || body.endsWith('-')) return failure('negative', NEGATIVE_MESSAGE)

  let numeric = body
  let multiplier = 1
  const magnitude = MAGNITUDE_SUFFIX.exec(numeric)
  if (magnitude) {
    const token = magnitude[1]
    const multiplierFor = MAGNITUDE_MULTIPLIER.get(token.toLowerCase())
    if (multiplierFor === undefined) return failure('not-a-number', AMOUNT_MESSAGE)
    // A single letter only means a magnitude when it is tight against the
    // digits: `R1.2m` is millions, `R 500 m` is a metre rate as easily as 500
    // million, so the spaced form is refused rather than guessed.
    if (TIGHT_ONLY_SUFFIXES.has(token.toLowerCase()) && /\s/.test(numeric[magnitude.index] ?? ''))
      return failure('ambiguous-magnitude', ambiguousMagnitudeMessage(raw))
    multiplier = multiplierFor
    numeric = numeric.slice(0, magnitude.index).trim()
  }

  if (!numeric || !/\d/.test(numeric) || !NUMERIC_BODY.test(numeric))
    return failure('not-a-number', AMOUNT_MESSAGE)

  const parsed = parseNumericBody(numeric)
  if ('ok' in parsed) return parsed

  const unscaled = Number(parsed.digits)
  if (!Number.isSafeInteger(unscaled)) return failure('out-of-range', RANGE_MESSAGE)
  const scaled = unscaled * multiplier
  // All arithmetic stays in exact integers until the final division, so a
  // magnitude suffix cannot introduce rounding drift into a rand amount.
  if (!Number.isSafeInteger(scaled * 100)) return failure('out-of-range', RANGE_MESSAGE)
  const value = Math.round((scaled * 100) / 10 ** parsed.fractionDigits) / 100
  if (!Number.isFinite(value)) return failure('out-of-range', RANGE_MESSAGE)
  if (value === 0) return failure('zero', ZERO_MESSAGE)
  if (value < 0) return failure('negative', NEGATIVE_MESSAGE)

  return { ok: true, value, canonical: String(value) }
}

/** The rand amount in `raw`, or `null` when it is not a single money literal. */
export function parseMoney(raw: unknown): number | null {
  const result = parseMoneyDetailed(raw)
  return result.ok ? result.value : null
}

/**
 * Strip every currency decoration around an amount, outermost first, so a
 * stacked decoration (`ZAR R 850 000`) is decoration too and not a second
 * amount. Loops until nothing is left to strip; each pass consumes at least one
 * character, so it terminates.
 */
function stripCurrencyDecoration(text: string): string {
  let out = text
  for (;;) {
    const next = out.replace(CURRENCY_PREFIX, '').replace(CURRENCY_SUFFIX, '').trim()
    if (next === out) return out
    out = next
  }
}

// ── scanning free text ───────────────────────────────────────────────────────

/**
 * Rand literal scanner for free text (tender source lines).
 *
 * The literal must start with a currency marker and end with a digit, so a
 * trailing separator or space cannot leak in. A magnitude suffix is part of the
 * literal on purpose: handing `"R 2.5"` to the parser instead of
 * `"R 2.5 million"` would understate the amount a million-fold. The suffix is
 * only absorbed when it is tight (`R1.2m`) or a word (`R 2.5 million`), never
 * as a spaced single letter — `R 500 m` is a metre rate.
 *
 * A literal that is followed by a per-unit marker (a slash, a unit word, or
 * "per" with a unit) is a rate — `R 250/m²`, `R 2 500 per day`, `R 250 kg` —
 * not the tender value, so it is not offered as a value candidate. That check
 * runs in code, not as a lookahead: a lookahead would only make the regex
 * backtrack into a shorter literal (`R 250/m²` would come back as `R 25`). A
 * literal followed by an ambiguous scale word, or by a spaced single-letter
 * suffix whose reading is live, is dropped for the same reason.
 *
 * A literal spread over more than three whitespace-separated groups is dropped
 * as well: in free text a fourth group is as likely to be the next column of a
 * flattened table row as a grouping separator, so nothing is offered rather than
 * a concatenation.
 *
 * This only finds literals; `parseMoney` decides whether each one is usable.
 */
const MONEY_LITERAL = new RegExp(
  `(?:^|[^A-Za-z0-9_])((?:ZAR|RANDS?|R)\\s*\\d[\\d\\s.,]*\\d` +
    `(?:\\s*(?:${MAGNITUDE_WORDS})\\b|[mk]\\b(?![²³23]))?)`,
  'gi',
)

const NEXT_WORD = /^\s*([A-Za-z]+)/

/** The digit run inside a scanned literal, without currency or magnitude. */
function literalDigits(literal: string): string {
  return stripCurrencyDecoration(literal).replace(MAGNITUDE_SUFFIX, '').trim()
}

export function extractMoneyLiterals(text: string): string[] {
  if (typeof text !== 'string' || !text) return []
  const out: string[] = []
  for (const match of text.matchAll(MONEY_LITERAL)) {
    const literal = match[1]?.trim()
    if (!literal) continue
    const after = text.slice(match.index + match[0].length)
    if (PER_UNIT_AFTER.test(after)) continue
    const nextWord = NEXT_WORD.exec(after)?.[1]?.toLowerCase()
    // `R 2.5 biljoen` is not readable, and `R 500 m` / `R 500 k` could be a
    // unit or a magnitude: neither may be offered as the bare digits.
    if (nextWord && (AMBIGUOUS_SCALE_WORDS.has(nextWord) || TIGHT_ONLY_SUFFIXES.has(nextWord)))
      continue
    if (literalDigits(literal).split(/\s+/).filter(Boolean).length > MAX_PLAIN_SPACE_GROUPS)
      continue
    out.push(literal)
  }
  return out
}

// ── formatting ───────────────────────────────────────────────────────────────

const ROUND_TRIP_LOCALES = new Map<string, string>()

/**
 * A locale whose formatted rand amount the parser reads back exactly, falling
 * back to `en-ZA`. A locale `Intl` accepts is not enough: Indian digit grouping
 * (`12,34,567`) and non-Latin digits (`ar-EG`) produce amounts this module
 * cannot read, and printing a number the parser refuses is exactly the drift the
 * formatter exists to prevent.
 */
export function safeMoneyLocale(value: string | undefined): string {
  if (!value) return 'en-ZA'
  const cached = ROUND_TRIP_LOCALES.get(value)
  if (cached !== undefined) return cached
  let resolved = 'en-ZA'
  try {
    const probe = `R ${new Intl.NumberFormat(value, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(123_456_789_012.34)}`
    if (parseMoney(probe) === 123_456_789_012.34) resolved = value
  } catch {
    resolved = 'en-ZA'
  }
  ROUND_TRIP_LOCALES.set(value, resolved)
  return resolved
}

/**
 * The one rand formatter: `R 1 200 000,00`. Used by the proposal document and
 * the extraction-review display so the printed amount and the parsed amount can
 * never drift apart. The output round-trips through `parseMoney` at every
 * magnitude, because `safeMoneyLocale` only lets a locale through whose
 * formatting the parser reads back.
 */
export function formatRandAmount(value: number, locale?: string): string {
  return `R ${new Intl.NumberFormat(safeMoneyLocale(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}`
}

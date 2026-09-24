// Tender discovery — the pure core.
//
// Tenders has always started with the user pasting a link. This module is the
// additive alternative: it turns National Treasury's public eTenders open data
// into a list of opportunities the user can pick from. It is deliberately the
// *pure* half of that feature — parsing, normalising, filtering, scoring, the
// cache envelope and every URL the client is allowed to build. It performs no
// I/O: no `fetch`, no `node:*`, no clock (every time-dependent function takes
// `now`), no randomness, no locale. `main/discovery-client.ts` owns the wire and
// the disk, and its network call is injected, so the whole feature is testable
// with zero network.
//
// Why it is shaped this way:
//
//  * **The source is a public beta and says so.** Treasury labels the whole feed
//    public beta, states that accuracy is not guaranteed, and states it must not
//    be used for critical decision making or legal purposes. Municipalities and
//    state-owned enterprises appear only when they volunteer their data, and
//    POPIA redaction is applied at source. `describeCoverage()` returns that in
//    plain language for the UI to show verbatim; the limits are surfaced, never
//    hidden.
//  * **Nothing here can claim readiness.** A discovered opportunity is
//    machine-produced and unverified, so every one carries `provenance:
//    'discovery-feed'` and `reviewState: 'unconfirmed'` — the single review state
//    a machine may write (see `AI_SUGGESTION_REVIEW_STATE` in `ai-extraction.ts`
//    for the same rule). Nothing in this module can produce `confirmed`.
//  * **Defensive to the observed reality, not to the documented shape.** Two
//    first-hand facts drive the parsers: the live API answers with LOWERCASE
//    wrapper keys (`{ uri, version, releases, links }`) while the monthly bulk
//    archive answers with PASCALCASE ones (`{ Uri, Version, Releases, … }`) for
//    the same OCDS 1.1 payload, and the archive states `value.amount: 0` for
//    every single release. So key lookup is case-insensitive (`field`), and a
//    stated zero is read as "no value stated" rather than as a R 0 tender —
//    which is also what the suite's own `parseMoney` decides about zero.
//  * **Reject with a reason, never throw and never repair.** Every dropped record
//    and every refused document link is recorded (`DiscoveryParseIssue`), because
//    a silently repaired field would be a fabricated one.
//  * **A missing closing date is flagged, not invented.** An opportunity with no
//    readable closing instant stays listable — it is a real tender — but carries
//    `closingState: 'missing' | 'unparseable'` plus a plain-language note, so no
//    surface can show it as if the source had stated a date.
//  * **Scoring is inspectable.** `scoreOpportunity` reports which profile term
//    matched which field and which terms matched nothing, so the owner can judge
//    the matching instead of trusting a number.

import { parseMoney } from './money'
import { parseClosingDate } from './readiness'
import type { CompanyProfile } from './types'

// ── the Treasury hosts (the client's allow-list, and every URL we build) ──────

/** The keyless OCDS 1.1 API. */
export const OCDS_API_HOST = 'ocds-api.etenders.gov.za'
/** The bulk-archive site (monthly `.json` / `.csv` / `.xlsx` dumps). */
export const BULK_ARCHIVE_HOST = 'data.etenders.gov.za'
/** Where tender documents are linked from. Never fetched by the client. */
export const TENDER_DOCUMENT_HOST = 'www.etenders.gov.za'

/**
 * Every host this feature may ever talk to. The client refuses any URL whose
 * host is not exactly one of these (see `isAllowedDiscoveryUrl`) — including a
 * suffix look-alike such as `ocds-api.etenders.gov.za.evil.example`, which a
 * naive `endsWith` check would accept.
 */
export const DISCOVERY_ALLOWED_HOSTS: readonly string[] = [
  OCDS_API_HOST,
  BULK_ARCHIVE_HOST,
  TENDER_DOCUMENT_HOST,
]

/** The public-domain licence Treasury publishes the feed under. */
export const DISCOVERY_LICENCE_URL = 'https://opendatacommons.org/licenses/pddl/1-0/'
/** Human-readable entry point for the bulk archive. */
export const BULK_ARCHIVE_LEARN_MORE_URL = 'https://data.etenders.gov.za/Home/LearnMore'

/**
 * The widest date range the live feed reliably serves. Wide ranges fail
 * outright, so callers page in small windows (`splitWindow`) instead.
 */
export const DISCOVERY_MAX_WINDOW_DAYS = 7

/**
 * Is this URL one the client may request? https only, exact host match against
 * the allow-list, and no embedded credentials — so a URL cannot smuggle a user
 * name, a password or a look-alike host past the caller.
 */
export function isAllowedDiscoveryUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  return DISCOVERY_ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase())
}

/**
 * A civil date (`YYYY-MM-DD`) — the form the feed's `dateFrom`/`dateTo` take.
 * An unreadable instant gives `''` rather than a made-up date, so a caller that
 * passes one cannot put `NaN-NaN-NaN` on the wire or in the cache.
 */
export function civilDate(instant: Date): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return ''
  const year = String(instant.getUTCFullYear()).padStart(4, '0')
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0')
  const day = String(instant.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** A closed publication window. Both ends are civil dates and inclusive. */
export interface DiscoveryWindow {
  from: string
  to: string
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/

/** True when both ends are civil dates and `from` is not after `to`. */
export function isValidWindow(window: DiscoveryWindow | null | undefined): boolean {
  if (!window || typeof window.from !== 'string' || typeof window.to !== 'string') return false
  if (!CIVIL_DATE.test(window.from) || !CIVIL_DATE.test(window.to)) return false
  return window.from <= window.to
}

/** Days spanned by a window, inclusive of both ends. `null` when unreadable. */
export function windowDays(window: DiscoveryWindow): number | null {
  if (!isValidWindow(window)) return null
  const from = Date.parse(`${window.from}T00:00:00Z`)
  const to = Date.parse(`${window.to}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to)) return null
  return Math.round((to - from) / 86_400_000) + 1
}

/**
 * Split a window into consecutive sub-windows of at most `maxDays` each, so the
 * live feed is asked for ranges it can actually answer. The pieces tile the
 * window exactly: no gap and no overlap, in chronological order. Returns `[]`
 * for an unreadable window or a non-positive `maxDays`.
 */
export function splitWindow(window: DiscoveryWindow, maxDays: number): DiscoveryWindow[] {
  if (!isValidWindow(window) || !Number.isFinite(maxDays) || maxDays < 1) return []
  const step = Math.floor(maxDays)
  const start = Date.parse(`${window.from}T00:00:00Z`)
  const end = Date.parse(`${window.to}T00:00:00Z`)
  const pieces: DiscoveryWindow[] = []
  let cursor = start
  while (cursor <= end) {
    const last = Math.min(cursor + (step - 1) * 86_400_000, end)
    pieces.push({ from: civilDate(new Date(cursor)), to: civilDate(new Date(last)) })
    cursor = last + 86_400_000
  }
  return pieces
}

/** How far back a refresh looks for newly published releases. */
export const DISCOVERY_DEFAULT_LOOKBACK_DAYS = 14

/**
 * The window a refresh uses when the caller names none: the last
 * `lookbackDays` days of publications, ending today. The feed's date filter is
 * a publication filter, so a short lookback is what catches what is new — the
 * closing dates of those releases are read from each record.
 */
export function defaultDiscoveryWindow(
  now: Date,
  lookbackDays = DISCOVERY_DEFAULT_LOOKBACK_DAYS,
): DiscoveryWindow {
  const days = Number.isFinite(lookbackDays) && lookbackDays >= 0 ? Math.floor(lookbackDays) : 0
  const from = new Date(now.getTime() - days * 86_400_000)
  return { from: civilDate(from), to: civilDate(now) }
}

// ── URLs (built here, requested by the client) ───────────────────────────────

/**
 * Page size asked of the live API. Measured first-hand on 2026-09-24: a
 * two-record page answered in 30 s, a 50-record page returned HTTP 500 after
 * 49 s, and a 200-record page never answered at all. The behaviour is not
 * monotonic — the feed is simply unreliable — so the page is kept small, the
 * walk follows `links.next` rather than trusting the echoed page size, and the
 * client retries.
 */
export const DISCOVERY_PAGE_SIZE = 25

/** One page of OCDS releases for a closed window. `dateFrom`/`dateTo` are required. */
export function ocdsReleasesUrl(request: {
  window: DiscoveryWindow
  pageNumber?: number
  pageSize?: number
}): string {
  const params = new URLSearchParams()
  params.set('PageNumber', String(request.pageNumber ?? 1))
  params.set('PageSize', String(request.pageSize ?? DISCOVERY_PAGE_SIZE))
  params.set('dateFrom', request.window.from)
  params.set('dateTo', request.window.to)
  return `https://${OCDS_API_HOST}/api/OCDSReleases?${params.toString()}`
}

/** The canonical record for one ocid. The ocid is path-encoded, so it cannot escape the path. */
export function ocdsReleaseUrl(ocid: string): string {
  return `https://${OCDS_API_HOST}/api/OCDSReleases/release/${encodeURIComponent(ocid)}`
}

/** The DataTables endpoint listing the monthly archive files. */
export function bulkArchiveListingUrl(): string {
  const params = new URLSearchParams({
    sEcho: '1',
    iColumns: '1',
    iDisplayStart: '0',
    iDisplayLength: '100',
  })
  return `https://${BULK_ARCHIVE_HOST}/Home/GetFiles?${params.toString()}`
}

/** One monthly archive file, e.g. `01072026.json` (the first of the month, DDMMYYYY). */
export function bulkArchiveUrl(fileName: string): string {
  const params = new URLSearchParams({ fileName })
  return `https://${BULK_ARCHIVE_HOST}/Home/DownloadFile/?${params.toString()}`
}

/** A file offered by the archive listing. */
export interface BulkArchiveFile {
  /** The label the site shows, e.g. `July 2026`. */
  monthName: string
  /** e.g. `01072026.json`. */
  fileName: string
  /** Absolute download URL on the archive host. */
  url: string
  /** Lower-cased extension without the dot, e.g. `json`. */
  format: string
}

const FILE_NAME_IN_HREF = /fileName=([A-Za-z0-9._-]+)/

/**
 * The month a bulk-archive file covers, as `YYYY-MM`, or null when the name is
 * not one. The name is the first of the month as `DDMMYYYY` (`01072026.json` is
 * July 2026) — which does NOT sort chronologically as a string, so anything that
 * orders the archive has to go through this.
 */
export function bulkArchiveMonth(fileName: string): string | null {
  const match = /^(\d{2})(\d{2})(\d{4})(?:\.|$)/.exec(fileName)
  if (!match) return null
  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2000) return null
  return `${match[3]}-${match[2]}`
}

/**
 * Read the archive listing. The site answers a DataTables payload whose rows
 * carry an HTML anchor (`{ monthName, downloadLink }`); the `fileName` is pulled
 * out of that markup rather than trusted as a URL, and every built URL is
 * re-checked against the allow-list. Junk, or a row without a readable
 * `fileName`, is dropped — the client simply has fewer candidates.
 */
export function parseBulkArchiveListing(raw: unknown): BulkArchiveFile[] {
  const record = asRecord(raw)
  const rows = asArray(field(record, 'aaData'))
  const files: BulkArchiveFile[] = []
  for (const row of rows) {
    const entry = asRecord(row)
    if (!entry) continue
    const href = asText(field(entry, 'downloadLink')) ?? ''
    const match = FILE_NAME_IN_HREF.exec(href)
    if (!match) continue
    const fileName = match[1]
    const url = bulkArchiveUrl(fileName)
    if (!isAllowedDiscoveryUrl(url)) continue
    const dot = fileName.lastIndexOf('.')
    files.push({
      monthName: asText(field(entry, 'monthName')) ?? fileName,
      fileName,
      url,
      format: dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase(),
    })
  }
  return files
}

// ── the normalised opportunity ───────────────────────────────────────────────

/** Where the bytes came from. The bulk archive lags the live feed. */
export type DiscoverySource = 'ocds-api' | 'bulk-archive'

/** How honestly the closing date came out of the source. */
export type ClosingState = 'parsed' | 'missing' | 'unparseable'

/** Marks a record as produced by the discovery feed rather than by a person. */
export const DISCOVERY_PROVENANCE = 'discovery-feed' as const
export type DiscoveryProvenance = typeof DISCOVERY_PROVENANCE

/**
 * The one review state a discovered record may carry. Identical in spirit to
 * `AI_SUGGESTION_REVIEW_STATE`: importing an opportunity must leave every field
 * `unconfirmed`, and only a human action can move it. Nothing in this module can
 * write `confirmed`.
 */
export const DISCOVERY_REVIEW_STATE = 'unconfirmed' as const
export type DiscoveryReviewState = typeof DISCOVERY_REVIEW_STATE

/** A value the source stated. Absent (or a stated zero) means no value is known. */
export interface OpportunityValue {
  amount: number
  currency: string | null
}

/** A linked tender document. Never mirrored — the app opens it on etenders.gov.za. */
export interface OpportunityDocument {
  url: string
  title: string | null
  format: string | null
  documentType: string | null
}

/** Which text the province was inferred from, so the UI can say how it knows. */
export type ProvinceSource = 'buyer' | 'title' | 'description'

export interface Opportunity {
  ocid: string
  /** The release id, when the source carried one. */
  releaseId: string | null
  title: string
  description: string
  /** The procuring entity, as named by the source. */
  buyer: string | null
  /** The tender's own reference (`tender.id`), usable as `referenceNumber`. */
  reference: string | null
  /** The source's status word (`active`, `complete`, `cancelled`, …), unmodified. */
  status: string | null
  /** OCDS `mainProcurementCategory` (`goods` / `works` / `services`). */
  category: string | null
  value: OpportunityValue | null
  documents: OpportunityDocument[]
  /** Document links refused because they were not http(s) — never opened. */
  refusedDocumentLinks: number
  province: string | null
  provinceSource: ProvinceSource | null
  /** Publication instant, when the source stated one it can be read from. */
  publishedAt: string | null
  /** The closing string exactly as the source stated it, or null. */
  closingRaw: string | null
  /** The closing instant, or null when the source stated none we can read. */
  closingAt: string | null
  closingState: ClosingState
  /** Plain-language reason for a closing that is missing or unreadable. */
  closingNote: string | null
  tags: string[]
  source: DiscoverySource
  /** Canonical Treasury record for this ocid. */
  sourceUrl: string
  /** Everything else worth telling the user, in display order. */
  warnings: string[]
  provenance: DiscoveryProvenance
  reviewState: DiscoveryReviewState
}

// ── defensive readers ────────────────────────────────────────────────────────

/** Bounds. A hostile or broken payload must not become an unbounded record. */
export const MAX_OPPORTUNITY_TITLE_CHARS = 300
export const MAX_OPPORTUNITY_DESCRIPTION_CHARS = 4_000
export const MAX_OPPORTUNITY_BUYER_CHARS = 200
export const MAX_OPPORTUNITY_CLOSING_CHARS = 120
export const MAX_OPPORTUNITY_DOCUMENTS = 50
export const MAX_OPPORTUNITY_TAGS = 16
export const MAX_OPPORTUNITY_ID_CHARS = 128
export const MAX_OPPORTUNITY_WARNINGS = 12

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Case-insensitive field read. The same OCDS payload arrives with lowercase
 * wrapper keys from the live API and PascalCase ones from the bulk archive, so
 * nothing here may depend on the case the source happened to use.
 */
function field(record: Record<string, unknown> | null, name: string): unknown {
  if (!record) return undefined
  if (name in record) return record[name]
  const wanted = name.toLowerCase()
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) return record[key]
  }
  return undefined
}

/** A non-empty, whitespace-collapsed string, or null. Never a coerced value. */
function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : null
}

/** A non-empty identifier within bounds, or null. */
function asId(value: unknown): string | null {
  const text = asText(value)
  if (!text || text.length > MAX_OPPORTUNITY_ID_CHARS) return null
  return text
}

const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * An exact instant. Only an RFC 3339 timestamp carrying its own offset qualifies
 * — a bare civil date is deliberately NOT accepted here, because reading a
 * publication date as a SAST-anchored instant would invent a time the source
 * never stated. Closing dates go through the canonical `parseClosingDate`
 * instead, which owns that SAST rule.
 */
function asInstant(value: unknown): string | null {
  const text = asText(value)
  if (!text || !RFC3339_INSTANT.test(text)) return null
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * A stated amount. `parseMoney` already refuses a zero as "not a money literal";
 * a raw numeric zero is refused here for the same reason, because the archive
 * states `amount: 0` for every release it publishes (measured: 849 of 849 in the
 * July 2026 dump). Reading that as R 0 would be a fabricated value.
 */
function usableAmount(value: unknown): { amount: number } | { statedZero: true } | null {
  let raw: number | null = null
  if (typeof value === 'number') raw = Number.isFinite(value) ? value : null
  else if (typeof value === 'string') raw = parseMoney(value)
  if (raw === null) return null
  if (raw === 0) return { statedZero: true }
  if (raw < 0) return null
  return { amount: raw }
}

// ── provinces ────────────────────────────────────────────────────────────────

/** The nine provinces, in the form the app displays. */
export const SA_PROVINCES: readonly string[] = [
  'Eastern Cape',
  'Free State',
  'Gauteng',
  'KwaZulu-Natal',
  'Limpopo',
  'Mpumalanga',
  'Northern Cape',
  'North West',
  'Western Cape',
]

/**
 * Place names that identify a province. Only names that are unambiguous are
 * listed — a province name, or a metro that is wholly inside one province — so
 * an inference never has to guess. Nothing here is a street address.
 */
const PROVINCE_PLACES: Record<string, string> = {
  'eastern cape': 'Eastern Cape',
  'free state': 'Free State',
  gauteng: 'Gauteng',
  'kwa-zulu natal': 'KwaZulu-Natal',
  'kwazulu natal': 'KwaZulu-Natal',
  'kwazulu-natal': 'KwaZulu-Natal',
  zululand: 'KwaZulu-Natal',
  limpopo: 'Limpopo',
  mpumalanga: 'Mpumalanga',
  'northern cape': 'Northern Cape',
  'north west': 'North West',
  'north-west': 'North West',
  'western cape': 'Western Cape',
  'cape town': 'Western Cape',
  'city of cape town': 'Western Cape',
  stellenbosch: 'Western Cape',
  'george municipality': 'Western Cape',
  bloemfontein: 'Free State',
  johannesburg: 'Gauteng',
  'city of johannesburg': 'Gauteng',
  'city of tshwane': 'Gauteng',
  tshwane: 'Gauteng',
  pretoria: 'Gauteng',
  ekurhuleni: 'Gauteng',
  'nelson mandela bay': 'Eastern Cape',
  'buffalo city': 'Eastern Cape',
  etekwini: 'KwaZulu-Natal',
  durban: 'KwaZulu-Natal',
  pietermaritzburg: 'KwaZulu-Natal',
  rustenburg: 'North West',
  mbombela: 'Mpumalanga',
  nelspruit: 'Mpumalanga',
  'sol plaatje': 'Northern Cape',
  kimberley: 'Northern Cape',
}

/** Canonicalise a province name or code, or null when it is not one. */
export function normaliseProvince(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value) return null
  const text = value.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!text) return null
  for (const province of SA_PROVINCES) {
    if (province.toLowerCase() === text) return province
  }
  const code = text.replace(/[^a-z]/g, '')
  const byCode: Record<string, string> = {
    ec: 'Eastern Cape',
    fs: 'Free State',
    gp: 'Gauteng',
    kzn: 'KwaZulu-Natal',
    lp: 'Limpopo',
    mp: 'Mpumalanga',
    nc: 'Northern Cape',
    nw: 'North West',
    wc: 'Western Cape',
  }
  return byCode[code] ?? null
}

/**
 * The province a piece of text names, or null. Matches whole place names only
 * (`Western Cape`, `City of Cape Town`) against word boundaries, so "Cape" alone
 * never decides anything. Used for the company's own address and, more loosely,
 * for a buyer's name — the caller records where it came from
 * (`provinceSource`), so the UI can say how it knows rather than asserting.
 */
export function provinceFromText(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || !text) return null
  const haystack = ` ${text
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()} `
  if (haystack.trim().length === 0) return null
  let best: { province: string; length: number } | null = null
  for (const [place, province] of Object.entries(PROVINCE_PLACES)) {
    if (!haystack.includes(` ${place} `)) continue
    if (!best || place.length > best.length) best = { province, length: place.length }
  }
  return best?.province ?? null
}

// ── parsing ──────────────────────────────────────────────────────────────────

/** Why a record was dropped. Every drop is reported, never silent. */
export type DiscoveryDropCode =
  'not-an-object' | 'missing-ocid' | 'missing-title' | 'duplicate-ocid'

export interface DiscoveryParseIssue {
  /** Where the record sat in the payload, e.g. `releases[3]`. */
  path: string
  code: DiscoveryDropCode
  /** Plain-language detail, safe to show. */
  detail: string
}

/** How the payload was shaped — diagnostics for the client and its tests. */
export type DiscoveryPayloadShape = 'single-release' | 'releases-array' | 'package' | 'unusable'

export interface DiscoveryParseResult {
  opportunities: Opportunity[]
  issues: DiscoveryParseIssue[]
  shape: DiscoveryPayloadShape
  /**
   * The wrapper's `links.next`, when the payload carried one. Unvalidated: the
   * client re-checks it with `isAllowedDiscoveryUrl` before requesting it.
   */
  next: string | null
}

export interface SingleReleaseParseResult {
  opportunity: Opportunity | null
  issues: DiscoveryParseIssue[]
  shape: DiscoveryPayloadShape
}

/**
 * Every array the feed might wrap its releases in. Lowercase and PascalCase both
 * appear in the wild (`releases` from the API, `Releases` from the archive), and
 * `data` is accepted because a generic JSON envelope is a plausible future.
 */
function releaseArray(record: Record<string, unknown>): unknown[] | null {
  for (const key of ['releases', 'data']) {
    const value = field(record, key)
    if (Array.isArray(value)) return value
  }
  return null
}

/** Does this object look like an OCDS release rather than a package? */
function looksLikeRelease(record: Record<string, unknown>): boolean {
  return field(record, 'ocid') !== undefined || field(record, 'tender') !== undefined
}

/** The wrapper's `links.next`, when it carries one. Unvalidated on purpose. */
function nextLink(record: Record<string, unknown>): string | null {
  return asText(field(asRecord(field(record, 'links')), 'next'))
}

function unusableReason(
  record: Record<string, unknown>,
): { code: DiscoveryDropCode; detail: string } | null {
  if (asId(field(record, 'ocid')) === null) {
    return {
      code: 'missing-ocid',
      detail: 'The record carries no usable ocid, so it cannot be identified.',
    }
  }
  const tender = asRecord(field(record, 'tender'))
  if (asText(field(tender, 'title')) === null) {
    return {
      code: 'missing-title',
      detail: 'The record carries no usable tender title, so there is nothing to list.',
    }
  }
  return null
}

/** A fresh, fully-typed opportunity with every field explicitly present. */
function emptyOpportunity(ocid: string): Opportunity {
  return {
    ocid,
    releaseId: null,
    title: '',
    description: '',
    buyer: null,
    reference: null,
    status: null,
    category: null,
    value: null,
    documents: [],
    refusedDocumentLinks: 0,
    province: null,
    provinceSource: null,
    publishedAt: null,
    closingRaw: null,
    closingAt: null,
    closingState: 'missing',
    closingNote: null,
    tags: [],
    source: 'ocds-api',
    sourceUrl: ocdsReleaseUrl(ocid),
    warnings: [],
    provenance: DISCOVERY_PROVENANCE,
    reviewState: DISCOVERY_REVIEW_STATE,
  }
}

function pushWarning(warnings: string[], warning: string): void {
  if (warnings.length >= MAX_OPPORTUNITY_WARNINGS) return
  if (warnings.includes(warning)) return
  warnings.push(warning)
}

/** Read the closing date honestly: raw string kept, instant only when parsed. */
function readClosing(tender: Record<string, unknown> | null, opportunity: Opportunity): void {
  const period = asRecord(field(tender, 'tenderPeriod'))
  const raw = asText(field(period, 'endDate'))
  if (raw === null) {
    opportunity.closingState = 'missing'
    opportunity.closingNote = 'The source stated no closing date for this tender.'
    pushWarning(opportunity.warnings, opportunity.closingNote)
    return
  }
  const capped = raw.slice(0, MAX_OPPORTUNITY_CLOSING_CHARS)
  opportunity.closingRaw = capped
  const parsed = parseClosingDate(capped)
  if (parsed === null) {
    opportunity.closingState = 'unparseable'
    opportunity.closingNote = `The closing date the source stated ("${capped}") could not be read, so no closing instant is claimed.`
    pushWarning(opportunity.warnings, opportunity.closingNote)
    return
  }
  opportunity.closingState = 'parsed'
  opportunity.closingAt = parsed.toISOString()
  if (raw.length > MAX_OPPORTUNITY_CLOSING_CHARS) {
    pushWarning(
      opportunity.warnings,
      'The closing text the source stated was longer than any real date, so only its first part was read.',
    )
  }
}

function readDocuments(tender: Record<string, unknown> | null, opportunity: Opportunity): void {
  const documents = asArray(field(tender, 'documents'))
  let refused = 0
  for (const entry of documents) {
    const document = asRecord(entry)
    if (!document) {
      refused += 1
      continue
    }
    const url = asText(field(document, 'url'))
    if (url === null || !/^https?:\/\//i.test(url)) {
      refused += 1
      continue
    }
    if (opportunity.documents.length >= MAX_OPPORTUNITY_DOCUMENTS) {
      refused += 1
      continue
    }
    opportunity.documents.push({
      url,
      title: asText(field(document, 'title')) ?? asText(field(document, 'description')),
      format: asText(field(document, 'format')),
      documentType: asText(field(document, 'documentType')),
    })
  }
  opportunity.refusedDocumentLinks = refused
  if (refused > 0) {
    pushWarning(
      opportunity.warnings,
      `${refused} document link${refused === 1 ? '' : 's'} on this tender could not be used and ${refused === 1 ? 'was' : 'were'} skipped.`,
    )
  }
}

function readValue(tender: Record<string, unknown> | null, opportunity: Opportunity): void {
  const value = asRecord(field(tender, 'value'))
  if (!value) return
  const currency = asText(field(value, 'currency'))
  const amount = field(value, 'amount')
  const usable = usableAmount(amount)
  if (usable === null) {
    if (amount !== undefined && amount !== null) {
      pushWarning(
        opportunity.warnings,
        'The value the source stated could not be read as an amount, so no value is shown.',
      )
    }
    return
  }
  if ('statedZero' in usable) {
    pushWarning(
      opportunity.warnings,
      'The source stated a value of 0, which is recorded as "no value stated" rather than as a R 0 tender.',
    )
    return
  }
  opportunity.value = { amount: usable.amount, currency }
}

/**
 * Map one raw OCDS release onto the normalised shape, or null when the record is
 * unusable. `source` records where the bytes came from; it never changes what the
 * record says.
 */
export function normaliseOpportunity(
  release: unknown,
  source: DiscoverySource = 'ocds-api',
): Opportunity | null {
  const record = asRecord(release)
  if (!record) return null
  const ocid = asId(field(record, 'ocid'))
  if (ocid === null) return null
  const tender = asRecord(field(record, 'tender'))
  const title = asText(field(tender, 'title'))
  if (title === null) return null

  const opportunity = emptyOpportunity(ocid)
  opportunity.source = source
  opportunity.title = title.slice(0, MAX_OPPORTUNITY_TITLE_CHARS)
  if (title.length > MAX_OPPORTUNITY_TITLE_CHARS) {
    pushWarning(
      opportunity.warnings,
      'The tender title was longer than a title, so it was cut to fit the list.',
    )
  }
  opportunity.releaseId = asId(field(record, 'id'))
  opportunity.reference = asText(field(tender, 'id'))
  opportunity.status = asText(field(tender, 'status'))
  opportunity.publishedAt = asInstant(field(record, 'date'))

  const description = asText(field(tender, 'description')) ?? ''
  opportunity.description = description.slice(0, MAX_OPPORTUNITY_DESCRIPTION_CHARS)
  if (description.length > MAX_OPPORTUNITY_DESCRIPTION_CHARS) {
    pushWarning(
      opportunity.warnings,
      'The tender description was longer than the list shows, so it was cut.',
    )
  }

  const buyer = asText(field(asRecord(field(record, 'buyer')), 'name'))
  const procuringEntity = asText(field(asRecord(field(tender, 'procuringEntity')), 'name'))
  const named = buyer ?? procuringEntity
  opportunity.buyer = named === null ? null : named.slice(0, MAX_OPPORTUNITY_BUYER_CHARS)

  const category = asText(field(tender, 'mainProcurementCategory'))
  opportunity.category = category === null ? null : category.toLowerCase()

  opportunity.tags = asArray(field(record, 'tag'))
    .map((tag) => asText(tag))
    .filter((tag): tag is string => tag !== null)
    .slice(0, MAX_OPPORTUNITY_TAGS)

  readValue(tender, opportunity)
  readDocuments(tender, opportunity)
  readClosing(tender, opportunity)

  // Where a tender sits is inferred from the text the source gave, and the
  // source of the inference is recorded so no surface has to present a guess as
  // a fact. Buyer name first: a provincial department names its province.
  const candidates: { source: ProvinceSource; text: string | null }[] = [
    { source: 'buyer', text: opportunity.buyer },
    { source: 'title', text: opportunity.title },
    { source: 'description', text: opportunity.description },
  ]
  for (const candidate of candidates) {
    const province = provinceFromText(candidate.text)
    if (province === null) continue
    opportunity.province = province
    opportunity.provinceSource = candidate.source
    break
  }

  return opportunity
}

/** Where a record sits in the payload, for the issue list. */
function at(path: string, index: number): string {
  return path === '' ? `releases[${index}]` : `${path}[${index}]`
}

/**
 * Parse a whole page: a `releases[]` array, a package wrapper around one, or a
 * single release. Never throws. Unusable records are dropped with a reason, and
 * a repeated ocid is kept once (a release can legitimately repeat across pages)
 * with the repeat reported.
 */
export function parseOcdsPage(
  raw: unknown,
  source: DiscoverySource = 'ocds-api',
): DiscoveryParseResult {
  const issues: DiscoveryParseIssue[] = []
  const opportunities: Opportunity[] = []
  const seen = new Set<string>()

  const record = asRecord(raw)
  if (record === null) {
    const array = Array.isArray(raw) ? raw : null
    if (array === null) {
      return {
        opportunities,
        issues: [
          {
            path: '',
            code: 'not-an-object',
            detail:
              'The response was not a JSON object or array, so nothing could be read from it.',
          },
        ],
        shape: 'unusable',
        next: null,
      }
    }
    return collect(array, '', issues, opportunities, seen, source, 'releases-array', null)
  }

  const releases = releaseArray(record)
  if (releases !== null) {
    return collect(
      releases,
      'releases',
      issues,
      opportunities,
      seen,
      source,
      'package',
      nextLink(record),
    )
  }
  if (looksLikeRelease(record)) {
    return collect([record], '', issues, opportunities, seen, source, 'single-release', null)
  }
  return {
    opportunities,
    issues: [
      {
        path: '',
        code: 'not-an-object',
        detail:
          'The response carried no releases array and no release, so nothing could be read from it.',
      },
    ],
    shape: 'unusable',
    next: null,
  }
}

function collect(
  releases: unknown[],
  path: string,
  issues: DiscoveryParseIssue[],
  opportunities: Opportunity[],
  seen: Set<string>,
  source: DiscoverySource,
  shape: DiscoveryPayloadShape,
  next: string | null,
): DiscoveryParseResult {
  releases.forEach((release, index) => {
    const where = at(path, index)
    const record = asRecord(release)
    if (record === null) {
      issues.push({
        path: where,
        code: 'not-an-object',
        detail: 'The entry was not a JSON object, so it was skipped.',
      })
      return
    }
    const reason = unusableReason(record)
    if (reason !== null) {
      issues.push({ path: where, code: reason.code, detail: reason.detail })
      return
    }
    const opportunity = normaliseOpportunity(record, source)
    if (opportunity === null) {
      issues.push({
        path: where,
        code: 'missing-ocid',
        detail: 'The entry could not be normalised into an opportunity.',
      })
      return
    }
    if (seen.has(opportunity.ocid)) {
      issues.push({
        path: where,
        code: 'duplicate-ocid',
        detail: `The ocid ${opportunity.ocid} already appeared in this response and was not listed twice.`,
      })
      return
    }
    seen.add(opportunity.ocid)
    opportunities.push(opportunity)
  })
  return { opportunities, issues, shape, next }
}

/**
 * Parse exactly one release — the `GET /release/{ocid}` response. Accepts the
 * same three shapes as `parseOcdsPage` and takes the first usable record, so a
 * wrapper around one release answers correctly.
 */
export function parseOcdsRelease(
  raw: unknown,
  source: DiscoverySource = 'ocds-api',
): SingleReleaseParseResult {
  const page = parseOcdsPage(raw, source)
  return {
    opportunity: page.opportunities[0] ?? null,
    issues: page.issues,
    shape: page.shape,
  }
}

// ── filtering ────────────────────────────────────────────────────────────────

/** The filter derived from the user's company profile, or set by hand. */
export interface DiscoveryFilter {
  /** Province names to keep. Empty = every province, including unknown ones. */
  provinces: string[]
  /** Categories to keep (`goods` / `works` / `services`). Empty = all. */
  categories: string[]
  /** Relevance terms from the company profile. Empty = no relevance filtering. */
  keywords: string[]
  /** Lowest relevance kept. Ignored when `keywords` is empty. */
  minScore: number
  /** Closing window, in days from `now`. Null = that end is unbounded. */
  minDaysFromNow: number | null
  maxDaysFromNow: number | null
  /** Value range in rand, applied only to opportunities whose value is known. */
  minValue: number | null
  maxValue: number | null
  /** Keep opportunities the source says are complete/cancelled/withdrawn, and past closings. */
  includeClosed: boolean
  /** Keep opportunities whose closing date is missing or unreadable. */
  includeUnknownClosing: boolean
  /** Keep only opportunities whose value is known. */
  requireKnownValue: boolean
}

/**
 * Every filter starts wide open: no province, category, relevance or value
 * narrowing. The one thing it does hide is a tender the source itself says is
 * finished — `complete`, `cancelled`, `withdrawn`, `unsuccessful` — because a
 * closed tender is not an opportunity. `includeClosed: true` shows those too.
 */
export const DEFAULT_DISCOVERY_FILTER: DiscoveryFilter = {
  provinces: [],
  categories: [],
  keywords: [],
  minScore: 0,
  minDaysFromNow: null,
  maxDaysFromNow: null,
  minValue: null,
  maxValue: null,
  includeClosed: false,
  includeUnknownClosing: true,
  requireKnownValue: false,
}

/** Words that carry no sector meaning, so they never become relevance terms. */
const KEYWORD_STOPWORDS = new Set([
  'and',
  'any',
  'are',
  'award',
  'been',
  'but',
  'can',
  'company',
  'each',
  'for',
  'from',
  'has',
  'have',
  'its',
  'may',
  'more',
  'most',
  'not',
  'other',
  'our',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'upon',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
  'services',
  'service',
  'supply',
  'supplier',
  'provider',
  'solutions',
  'projects',
  'project',
  'limited',
  'pty',
  'ltd',
  'cc',
  'inc',
  'south',
  'africa',
  'african',
  'based',
  'including',
  'various',
])

/** Longest and shortest relevance term accepted. */
export const MAX_DISCOVERY_KEYWORDS = 24
const MIN_KEYWORD_CHARS = 3
const MAX_KEYWORD_CHARS = 40

/** Normalise text for matching: lowercase, letters/digits only, single spaces. */
function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Relevance terms from free text: a short sector phrase (when every word in it
 * carries meaning) plus its meaningful words, lowercased, deduplicated and
 * sorted so the derived filter is deterministic.
 *
 * What is dropped and why: English function words and generic business words
 * (`services`, `supply`, `pty`) are dropped, because they appear in almost every
 * tender and would make the score meaningless; single digits are dropped for the
 * same reason. A word must be at least three characters — except a two-character
 * word that was written in capitals in the source, which is an acronym (`PV`,
 * `IT`, `HR`) rather than a function word. The phrase is only kept when it is two
 * or three words with no function word among them, so a whole sentence from a
 * description never becomes one "term". Capped at `MAX_DISCOVERY_KEYWORDS`,
 * alphabetically, so the cap is reproducible rather than order-dependent.
 */
export function keywordsFromText(text: string | null | undefined): string[] {
  if (typeof text !== 'string' || !text) return []
  const normalised = normaliseText(text)
  if (!normalised) return []
  const terms = new Set<string>()
  const rawWords = text.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0)
  const words = normalised.split(' ')
  if (
    words.length >= 2 &&
    words.length <= 3 &&
    normalised.length <= MAX_KEYWORD_CHARS &&
    words.every((word) => !KEYWORD_STOPWORDS.has(word) && word.length >= 2)
  ) {
    terms.add(normalised)
  }
  for (const raw of rawWords) {
    const word = raw.toLowerCase()
    const acronym = raw.length === 2 && /^[A-Z]{2}$/.test(raw)
    if (!acronym && word.length < MIN_KEYWORD_CHARS) continue
    if (word.length > MAX_KEYWORD_CHARS) continue
    if (KEYWORD_STOPWORDS.has(word)) continue
    if (/^\d+$/.test(word)) continue
    terms.add(word)
  }
  return [...terms].sort().slice(0, MAX_DISCOVERY_KEYWORDS)
}

/**
 * The discovery filter a company profile implies. The company's own address
 * decides the province (so a Cape Town business is offered Western Cape work
 * first) and its industry plus description decide the relevance terms. Nothing
 * else is narrowed: an opportunity is never hidden because of a guess.
 */
export function deriveDiscoveryFilter(
  profile: Pick<CompanyProfile, 'industry' | 'description' | 'address'>,
): DiscoveryFilter {
  const province = provinceFromText(profile?.address ?? null)
  const keywords = [
    ...keywordsFromText(profile?.industry ?? null),
    ...keywordsFromText(profile?.description ?? null),
  ]
  const unique = [...new Set(keywords)].sort().slice(0, MAX_DISCOVERY_KEYWORDS)
  return {
    ...DEFAULT_DISCOVERY_FILTER,
    provinces: province === null ? [] : [province],
    keywords: unique,
  }
}

/** Which field a term matched in. The weights below decide the score. */
export type ScoreField = 'title' | 'category' | 'buyer' | 'description'

/**
 * How much a match is worth, by field. A term in the title is the strongest
 * evidence the tender is about that thing; a term buried in the description is
 * the weakest. One point per term is the ceiling, so the score stays a plain
 * ratio of "terms matched, weighted by where".
 */
export const SCORE_FIELD_WEIGHTS: Record<ScoreField, number> = {
  title: 1,
  category: 0.8,
  buyer: 0.4,
  description: 0.25,
}

const SCORE_FIELD_LABEL: Record<ScoreField, string> = {
  title: 'title',
  category: 'category',
  buyer: 'buyer name',
  description: 'description',
}

export interface ScoreMatch {
  /** The profile term that matched. */
  term: string
  field: ScoreField
  /** The weight the field earned. */
  weight: number
}

export interface OpportunityScore {
  /** Matched weight ÷ one point per term, clamped to 0–1. */
  score: number
  earned: number
  available: number
  matches: ScoreMatch[]
  /** Terms that matched nothing here — the honest half of the explanation. */
  unmatched: string[]
  /** Plain-language summary, safe to show next to the score. */
  explanation: string
}

/** Does the normalised haystack contain this term as a whole word or phrase? */
function containsTerm(haystack: string, term: string): boolean {
  if (!haystack || !term) return false
  return ` ${haystack} `.includes(` ${term} `)
}

/**
 * Score one opportunity against the filter's terms, and explain it. The score is
 * a plain ratio — one point available per term, awarded at the weight of the
 * strongest field the term appears in — so `matches` and `unmatched` together
 * account for the number exactly. No term is counted twice, and no match is
 * inferred from a substring (`it` does not match `item`).
 */
export function scoreOpportunity(
  opportunity: Opportunity,
  filter: DiscoveryFilter,
): OpportunityScore {
  const terms = [...new Set(filter.keywords.map(normaliseText).filter((term) => term.length > 0))]
  if (terms.length === 0) {
    return {
      score: 0,
      earned: 0,
      available: 0,
      matches: [],
      unmatched: [],
      explanation:
        'No relevance terms are set on the company profile, so nothing here has been scored against it.',
    }
  }
  const haystacks: Record<ScoreField, string> = {
    title: normaliseText(opportunity.title),
    category: normaliseText(opportunity.category ?? ''),
    buyer: normaliseText(opportunity.buyer ?? ''),
    description: normaliseText(opportunity.description),
  }
  const order: ScoreField[] = ['title', 'category', 'buyer', 'description']
  const matches: ScoreMatch[] = []
  const unmatched: string[] = []
  let earned = 0
  for (const term of terms) {
    const hit = order.find((fieldName) => containsTerm(haystacks[fieldName], term))
    if (!hit) {
      unmatched.push(term)
      continue
    }
    const weight = SCORE_FIELD_WEIGHTS[hit]
    earned += weight
    matches.push({ term, field: hit, weight })
  }
  const available = terms.length
  const score = available === 0 ? 0 : Math.min(1, earned / available)
  const shown = matches.map((match) => `"${match.term}" in the ${SCORE_FIELD_LABEL[match.field]}`)
  const explanation =
    matches.length === 0
      ? `None of the ${available} company profile terms appear in this tender.`
      : `${matches.length} of ${available} company profile terms matched — ${shown.join(', ')}.`
  return { score, earned, available, matches, unmatched, explanation }
}

/** Why an opportunity was filtered out. Every reason is a code the UI can word. */
export type FilterExclusionCode =
  | 'status-closed'
  | 'closing-passed'
  | 'closing-window'
  | 'closing-unknown'
  | 'province'
  | 'province-unknown'
  | 'category'
  | 'category-unknown'
  | 'relevance'
  | 'value-range'
  | 'value-unknown'

export interface FilterExclusion {
  code: FilterExclusionCode
  /** Plain-language reason, safe to show. */
  message: string
}

/** Statuses that mean the buyer has finished with this tender. */
const CLOSED_STATUSES = new Set(['complete', 'cancelled', 'canceled', 'withdrawn', 'unsuccessful'])

const DAY_MS = 86_400_000

/**
 * Why this opportunity is not in the list, or null when it is. Kept separate
 * from `filterOpportunities` so a surface can explain what it hid instead of
 * just hiding it — a filtered-out tender is never a silent loss.
 *
 * Order of the checks is the order of the reasons a bidder cares about: is the
 * tender still open, is it in my area, is it my kind of work, does it suit me.
 */
export function exclusionReason(
  opportunity: Opportunity,
  filter: DiscoveryFilter,
  now: Date,
): FilterExclusion | null {
  const status = (opportunity.status ?? '').toLowerCase()
  if (!filter.includeClosed && CLOSED_STATUSES.has(status)) {
    return {
      code: 'status-closed',
      message: `The source says this tender is ${status}, so it is no longer open.`,
    }
  }
  if (opportunity.closingState !== 'parsed' || opportunity.closingAt === null) {
    if (!filter.includeUnknownClosing) {
      return {
        code: 'closing-unknown',
        message:
          opportunity.closingNote ??
          'The closing date is not known, so this tender cannot be scheduled.',
      }
    }
  } else {
    const closing = new Date(opportunity.closingAt)
    if (Number.isNaN(closing.getTime())) {
      return {
        code: 'closing-unknown',
        message: 'The closing instant on this tender is not a usable date.',
      }
    }
    const days = (closing.getTime() - now.getTime()) / DAY_MS
    if (days < 0 && !filter.includeClosed) {
      return {
        code: 'closing-passed',
        message: `This tender closed on ${opportunity.closingRaw ?? opportunity.closingAt}.`,
      }
    }
    if (filter.minDaysFromNow !== null && days < filter.minDaysFromNow) {
      return {
        code: 'closing-window',
        message: `This tender closes in ${Math.max(0, Math.round(days))} days, sooner than the window asks for.`,
      }
    }
    if (filter.maxDaysFromNow !== null && days > filter.maxDaysFromNow) {
      return {
        code: 'closing-window',
        message: `This tender closes in ${Math.round(days)} days, later than the window asks for.`,
      }
    }
  }

  if (filter.provinces.length > 0) {
    const wanted = filter.provinces.map((province) =>
      (normaliseProvince(province) ?? province).trim().toLowerCase(),
    )
    if (opportunity.province === null) {
      return {
        code: 'province-unknown',
        message:
          'The source does not say where this tender is, so it could not be matched to a province.',
      }
    }
    if (!wanted.includes(opportunity.province.toLowerCase())) {
      return {
        code: 'province',
        message: `This tender reads as ${opportunity.province}, outside the provinces you chose.`,
      }
    }
  }

  if (filter.categories.length > 0) {
    const wanted = filter.categories.map((category) => category.trim().toLowerCase())
    if (opportunity.category === null) {
      return {
        code: 'category-unknown',
        message: 'The source states no procurement category for this tender.',
      }
    }
    if (!wanted.includes(opportunity.category)) {
      return {
        code: 'category',
        message: `This tender is categorised as ${opportunity.category}, outside the categories you chose.`,
      }
    }
  }

  if (filter.keywords.length > 0 && filter.minScore > 0) {
    const score = scoreOpportunity(opportunity, filter)
    if (score.score < filter.minScore) {
      return {
        code: 'relevance',
        message: `This tender scores ${score.score.toFixed(2)} against your profile, below the ${filter.minScore.toFixed(2)} you asked for. ${score.explanation}`,
      }
    }
  }

  const amount = opportunity.value?.amount ?? null
  if (amount === null) {
    if (filter.requireKnownValue) {
      return {
        code: 'value-unknown',
        message: 'The source states no value for this tender.',
      }
    }
  } else {
    if (filter.minValue !== null && amount < filter.minValue) {
      return {
        code: 'value-range',
        message: `This tender is valued at ${amount}, below the range you asked for.`,
      }
    }
    if (filter.maxValue !== null && amount > filter.maxValue) {
      return {
        code: 'value-range',
        message: `This tender is valued at ${amount}, above the range you asked for.`,
      }
    }
  }

  return null
}

/** The opportunities that survive the filter, in the order they arrived. */
export function filterOpportunities(
  opportunities: readonly Opportunity[],
  filter: DiscoveryFilter,
  now: Date,
): Opportunity[] {
  return opportunities.filter((opportunity) => exclusionReason(opportunity, filter, now) === null)
}

export interface RankedOpportunity {
  opportunity: Opportunity
  score: OpportunityScore
}

/**
 * The order a discovery list should be read in: most relevant first, then the
 * soonest closing, then by title so the order is stable. Opportunities with no
 * known closing instant sort after those that have one — an unknown deadline is
 * not treated as an urgent one.
 */
export function rankOpportunities(
  opportunities: readonly Opportunity[],
  filter: DiscoveryFilter,
): RankedOpportunity[] {
  return opportunities
    .map((opportunity) => ({ opportunity, score: scoreOpportunity(opportunity, filter) }))
    .sort((a, b) => {
      if (b.score.score !== a.score.score) return b.score.score - a.score.score
      const left = a.opportunity.closingAt
      const right = b.opportunity.closingAt
      if (left !== right) {
        if (left === null) return 1
        if (right === null) return -1
        return left < right ? -1 : 1
      }
      return a.opportunity.title.localeCompare(b.opportunity.title, 'en')
    })
}

// ── what the feed is, and is not ─────────────────────────────────────────────

export interface CoverageSource {
  label: string
  url: string
  licence: string
}

export interface CoverageStatement {
  /** One-line summary for a heading. */
  summary: string
  /** Short labels, e.g. `Public beta`. */
  badges: string[]
  /** The limits and facts, in display order, meant to be shown verbatim. */
  points: string[]
  sources: CoverageSource[]
  /** Everything above as one paragraph, for a copy/paste or a screen reader. */
  text: string
}

/**
 * What the discovery feed covers, in plain language, for the UI to show
 * verbatim. Every claim here is one Treasury itself makes or one this app
 * verified against the feed; nothing is softened into a promise, and the limits
 * are stated as plainly as the capabilities. It is a function rather than a
 * constant so a caller cannot mutate the statement the rest of the app shows.
 */
export function describeCoverage(): CoverageStatement {
  const summary =
    'Listings come from National Treasury’s eTenders open data — the same public feed the eTenders site is built on. It is a public beta, and it is not complete.'
  const badges = [
    'Public beta',
    'No login required',
    'Accuracy not guaranteed',
    'Not for legal or critical decisions',
  ]
  const points = [
    'Coverage starts in January 2024. Nothing older is in this feed.',
    'National and provincial departments publish here. Municipalities and state-owned enterprises appear only when they volunteer their data to Treasury, so a tender you already know about may be missing.',
    'Treasury labels the whole feed a public beta and states that its accuracy is not guaranteed.',
    'Treasury states the feed must not be used for critical decision making or legal purposes. Always work from the official tender document, not from this list.',
    'Personal information is redacted at the source under POPIA before Treasury publishes it, so contact details may be absent.',
    'The monthly bulk archive lags the live feed by one to two months, and is used only when the live feed cannot be reached.',
    'Tender documents are linked, not copied. The app opens the document on etenders.gov.za and never mirrors it.',
    'Every closing date is shown as the source stated it. A date this app cannot read is flagged as unreadable, never guessed.',
    'Values are almost never published in this feed. A tender with no stated value shows no value rather than a zero.',
    'The live feed is slow — a request can take a minute — and it sometimes fails. The app retries, pages in small date ranges, and says so when it could not get everything.',
    'Nothing found here is confirmed. Every field stays unconfirmed until you check it against the official document.',
  ]
  return {
    summary,
    badges,
    points,
    sources: [
      {
        label: 'eTenders OCDS API (National Treasury)',
        url: `https://${OCDS_API_HOST}/api/OCDSReleases`,
        licence: 'Public Domain Dedication and Licence (PDDL) 1.0',
      },
      {
        label: 'eTenders monthly bulk archive',
        url: BULK_ARCHIVE_LEARN_MORE_URL,
        licence: 'Public Domain Dedication and Licence (PDDL) 1.0',
      },
    ],
    text: [summary, ...points].join(' '),
  }
}

// ── the on-disk cache envelope ───────────────────────────────────────────────

/** Bump when the stored shape changes; an older envelope is refused, not guessed at. */
export const DISCOVERY_CACHE_VERSION = 1

/**
 * How long a cached list stays fresh. Tender notices change on the scale of
 * days, so six hours keeps a morning's list usable through a working day while
 * still refreshing often enough to catch a new publication.
 */
export const DISCOVERY_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1_000

/** The file the client writes inside its cache directory. */
export const DISCOVERY_CACHE_FILE_NAME = 'discovery-cache.json'

export interface DiscoveryCacheEnvelope {
  version: number
  /** Instant the fetch that produced this cache finished. */
  fetchedAt: string
  /** The publication window that was requested. */
  window: DiscoveryWindow
  /** Where the records came from. */
  source: DiscoverySource
  /** False when a page, a window or the fallback failed, so the list is partial. */
  complete: boolean
  opportunities: Opportunity[]
  /** Why the list is partial or unusual, in display order. */
  warnings: string[]
}

export interface CreateCacheRequest {
  fetchedAt: string
  window: DiscoveryWindow
  source: DiscoverySource
  complete: boolean
  opportunities: Opportunity[]
  warnings?: string[]
}

/** Build an envelope, so the client never hand-assembles one. */
export function createDiscoveryCache(request: CreateCacheRequest): DiscoveryCacheEnvelope {
  return {
    version: DISCOVERY_CACHE_VERSION,
    fetchedAt: request.fetchedAt,
    window: { from: request.window.from, to: request.window.to },
    source: request.source,
    complete: request.complete,
    opportunities: request.opportunities,
    warnings: [...(request.warnings ?? [])],
  }
}

/**
 * Is this cache too old to show as current? A cache whose `fetchedAt` cannot be
 * read is stale — an unknown age is not a fresh one. A `fetchedAt` in the future
 * (a clock that moved backwards) is not stale, because the data cannot be older
 * than the clock claims.
 */
export function isCacheStale(
  cache: DiscoveryCacheEnvelope,
  now: Date,
  maxAgeMs: number = DISCOVERY_CACHE_MAX_AGE_MS,
): boolean {
  const fetchedAt = Date.parse(cache.fetchedAt)
  if (Number.isNaN(fetchedAt)) return true
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return true
  return now.getTime() - fetchedAt > maxAgeMs
}

/**
 * Re-read one cached opportunity defensively, or drop it. The stored facts are
 * re-derived rather than trusted: a closing state is recomputed from the stored
 * instant, a document link is re-checked, a province must be a real province,
 * and a value must be a positive amount. A hand-edited or truncated cache file
 * therefore cannot inject a record the app would otherwise refuse.
 */
function coerceOpportunity(stored: unknown, fallbackSource: DiscoverySource): Opportunity | null {
  const record = asRecord(stored)
  if (!record) return null
  const ocid = asId(field(record, 'ocid'))
  const title = asText(field(record, 'title'))
  if (ocid === null || title === null) return null

  const opportunity = emptyOpportunity(ocid)
  opportunity.title = title.slice(0, MAX_OPPORTUNITY_TITLE_CHARS)
  opportunity.releaseId = asId(field(record, 'releaseId'))
  opportunity.description = (asText(field(record, 'description')) ?? '').slice(
    0,
    MAX_OPPORTUNITY_DESCRIPTION_CHARS,
  )
  const buyer = asText(field(record, 'buyer'))
  opportunity.buyer = buyer === null ? null : buyer.slice(0, MAX_OPPORTUNITY_BUYER_CHARS)
  opportunity.reference = asText(field(record, 'reference'))
  opportunity.status = asText(field(record, 'status'))
  const category = asText(field(record, 'category'))
  opportunity.category = category === null ? null : category.toLowerCase()
  opportunity.publishedAt = asInstant(field(record, 'publishedAt'))

  const storedSource = asText(field(record, 'source'))
  opportunity.source =
    storedSource === 'ocds-api' || storedSource === 'bulk-archive' ? storedSource : fallbackSource

  const closingRaw = asText(field(record, 'closingRaw'))
  const closingAt = asInstant(field(record, 'closingAt'))
  opportunity.closingRaw =
    closingRaw === null ? null : closingRaw.slice(0, MAX_OPPORTUNITY_CLOSING_CHARS)
  opportunity.closingAt = closingAt
  opportunity.closingState =
    closingAt !== null ? 'parsed' : closingRaw !== null ? 'unparseable' : 'missing'
  const note = asText(field(record, 'closingNote'))
  opportunity.closingNote = opportunity.closingState === 'parsed' ? null : note

  const documents = asArray(field(record, 'documents'))
  for (const entry of documents) {
    const document = asRecord(entry)
    const url = document ? asText(field(document, 'url')) : null
    if (url === null || !/^https?:\/\//i.test(url)) {
      opportunity.refusedDocumentLinks += 1
      continue
    }
    if (opportunity.documents.length >= MAX_OPPORTUNITY_DOCUMENTS) {
      opportunity.refusedDocumentLinks += 1
      continue
    }
    opportunity.documents.push({
      url,
      title: asText(field(document, 'title')),
      format: asText(field(document, 'format')),
      documentType: asText(field(document, 'documentType')),
    })
  }

  const valueRecord = asRecord(field(record, 'value'))
  const usable = valueRecord ? usableAmount(field(valueRecord, 'amount')) : null
  if (usable !== null && !('statedZero' in usable)) {
    opportunity.value = {
      amount: usable.amount,
      currency: asText(field(valueRecord, 'currency')),
    }
  }

  const province = normaliseProvince(asText(field(record, 'province')))
  if (province !== null) {
    opportunity.province = province
    const stored = asText(field(record, 'provinceSource'))
    opportunity.provinceSource =
      stored === 'buyer' || stored === 'title' || stored === 'description' ? stored : null
  }

  opportunity.tags = asArray(field(record, 'tags'))
    .map((tag) => asText(tag))
    .filter((tag): tag is string => tag !== null)
    .slice(0, MAX_OPPORTUNITY_TAGS)
  for (const warning of asArray(field(record, 'warnings'))) {
    const text = asText(warning)
    if (text !== null) pushWarning(opportunity.warnings, text)
  }
  return opportunity
}

/**
 * Read a stored cache envelope, or null when it is not one this version can use.
 * A wrong version, a missing window or an unreadable `fetchedAt` refuses the
 * whole envelope; unusable entries inside it are dropped with a warning, so one
 * bad record cannot cost the user the rest of their list.
 */
export function parseDiscoveryCache(raw: unknown): DiscoveryCacheEnvelope | null {
  const record = asRecord(raw)
  if (!record) return null
  const version = field(record, 'version')
  if (typeof version !== 'number' || Math.floor(version) !== DISCOVERY_CACHE_VERSION) return null
  const fetchedAt = asInstant(field(record, 'fetchedAt'))
  if (fetchedAt === null) return null
  const window = asRecord(field(record, 'window'))
  const from = asText(field(window, 'from'))
  const to = asText(field(window, 'to'))
  if (from === null || to === null || !isValidWindow({ from, to })) return null
  const storedSource = asText(field(record, 'source'))
  const source: DiscoverySource = storedSource === 'bulk-archive' ? 'bulk-archive' : 'ocds-api'

  const opportunities: Opportunity[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of asArray(field(record, 'opportunities'))) {
    const opportunity = coerceOpportunity(entry, source)
    if (opportunity === null || seen.has(opportunity.ocid)) {
      dropped += 1
      continue
    }
    seen.add(opportunity.ocid)
    opportunities.push(opportunity)
  }

  const warnings: string[] = []
  for (const warning of asArray(field(record, 'warnings'))) {
    const text = asText(warning)
    if (text !== null) warnings.push(text)
  }
  if (dropped > 0) {
    warnings.push(
      `${dropped} saved ${dropped === 1 ? 'listing was' : 'listings were'} unreadable and ${dropped === 1 ? 'was' : 'were'} skipped.`,
    )
  }

  return {
    version: DISCOVERY_CACHE_VERSION,
    fetchedAt,
    window: { from, to },
    source,
    complete: field(record, 'complete') === true,
    opportunities,
    warnings,
  }
}

// Find tenders — the user-facing half of tender discovery.
//
// The engine underneath (`shared/discovery.ts` + `main/discovery-client.ts`) has
// existed since the discovery wave; this page is what makes it reachable. Three
// rules shape it, and all three are honesty rules rather than layout ones:
//
//  * **Nothing here is confirmed, and nothing here says otherwise.** A listing
//    is machine-sourced from National Treasury's open data: it is the SOURCE's
//    claim, not this app's finding. So a listing is a *lead* — "Add to workspace"
//    downloads the linked document and runs it through the ordinary intake
//    (`intakeTenderFile` in `TenderList.tsx`), which lands it as a normal tender
//    with every field `unconfirmed`, the review gate, readiness, the compliance
//    matrix and the optional AI pass exactly as an imported file does. The
//    listing's own provenance is recorded in the review's conflict list
//    (`provenanceNote` below), which is persisted with the tender.
//  * **The limits are stated where the list is, not behind a link.**
//    `describeCoverage()` is rendered verbatim and always, because the honest
//    position is not a footnote: the feed is a public beta, its accuracy is not
//    guaranteed, Treasury states it must not be used for critical decision
//    making or legal purposes, and municipalities and state-owned enterprises
//    appear only when they volunteer their data. Nothing in this pane may imply
//    the app has seen every tender.
//  * **Every failure looks like a failure.** An empty list from a failed fetch
//    is the one thing this pane must never show: a read or a refresh that did
//    not work says so, in the engine's own words, with a retry — and the saved
//    list keeps working with no network connection, saying when it was fetched
//    and whether it is older than the freshness window this app keeps.
//
// The pane's own side effects are all behind one injectable seam
// (`discoveryBridge()`), so the transport can be replaced in a test and the pane
// never touches `ipcRenderer` — the preload exposes functions only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  Filter,
  MapPin,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react'
import {
  DISCOVERY_CACHE_MAX_AGE_MS,
  DISCOVERY_PROVENANCE,
  SA_PROVINCES,
  deriveDiscoveryFilter,
  describeCoverage,
  exclusionReason,
  filterOpportunities,
  isCacheStale,
  rankOpportunities,
  type DiscoveryCacheEnvelope,
  type DiscoveryFilter,
  type DiscoverySource,
  type FilterExclusion,
  type Opportunity,
  type OpportunityDocument,
  type OpportunityScore,
  type ScoreMatch,
} from '../../../../shared/discovery'
import type {
  DiscoveryDownloadDocumentResponse,
  DiscoveryReadCacheResponse,
  DiscoveryRefreshResponse,
  TendersIpcError,
} from '../../../../shared/ipc'
import { formatRandAmount } from '../../../../shared/money'
import { deadlineStatus, urgencyClasses, useNow } from '../../deadline'
import { useTendersStore } from '../../store'
import { DocxImportCancelledError, DocxPreflightError } from '../../intake/docx'
import { PdfImportCancelledError, PdfPreflightError } from '../../pdf/extract'
import { intakeTenderFile, readAiExtractionPreference, tenderSourceKind } from '../TenderList'
import { Badge, Button, FORM_CONTROL_CLASS, FORM_LABEL_CLASS, Spinner } from '../ui'

/**
 * The two filter checkboxes' own sizing.
 *
 * These controls carried this class while the shared `FORM_CHECKBOX_CLASS`
 * measured 16x16: it was `size-4 box-content border-4 border-transparent`, and
 * neither the padding nor the transparent border grows a native checkbox (the
 * e2e a11y journey reads the rendered border box). The shared class has since
 * been fixed to `size-6` — measured at 23.93x23.93, i.e. the same 24px box this
 * class gives — so the two are equivalent today and this is a deliberate
 * page-local class rather than a different size.
 *
 * `size-6` is `calc(var(--spacing) * 6)`: exactly 24px on both axes, with no
 * padding or border left for a box-sizing rule to reinterpret — the sizing the
 * sidebar's collapse control and the reminders switch use too.
 */
const DISCOVERY_CHECKBOX_CLASS =
  'size-6 cursor-pointer rounded accent-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none'

// ── the injectable transport ─────────────────────────────────────────────────

/**
 * The three discovery calls this pane makes, as one object.
 *
 * It exists so the pane has a single, replaceable seam: every side effect it has
 * goes through here, so a test can drive the pane's read, refresh and download
 * paths without Electron and without a network, and the pane never reaches for
 * `window.tendersApi` in three different places. The preload bridge exposes
 * functions only (never `ipcRenderer`), and this is the only place that touches
 * it.
 */
export interface DiscoveryBridge {
  readCache: () => Promise<DiscoveryReadCacheResponse>
  refresh: () => Promise<DiscoveryRefreshResponse>
  downloadDocument: (request: {
    url: string
    fileName?: string
  }) => Promise<DiscoveryDownloadDocumentResponse>
}

/** The live bridge, or null in a build that has none (the honest "unavailable"). */
export function discoveryBridge(): DiscoveryBridge | null {
  if (typeof window === 'undefined') return null
  const api = window.tendersApi
  const readCache = api?.discoveryReadCache?.bind(api)
  const refresh = api?.discoveryRefresh?.bind(api)
  const downloadDocument = api?.discoveryDownloadDocument?.bind(api)
  if (!readCache || !refresh || !downloadDocument) return null
  return {
    readCache: () => readCache(),
    refresh: () => refresh(),
    downloadDocument: (request) => downloadDocument(request),
  }
}

/** What a discovery call answers with: the data, or the engine's own refusal. */
export type SavedListResult =
  | { ok: true; cache: DiscoveryCacheEnvelope | null; stale: boolean; warnings: string[] }
  | { ok: false; error: TendersIpcError }

/** A bridge-less build is a failure with a reason, never an empty list. */
const NO_BRIDGE: TendersIpcError = {
  code: 'UNAVAILABLE',
  message: 'Tender discovery is not available in this build.',
}

/**
 * Read the saved list. No network, so this is the offline path: it answers from
 * the last successful fetch on this machine and reports how old it is.
 */
export async function readSavedList(bridge: DiscoveryBridge | null): Promise<SavedListResult> {
  if (!bridge) return { ok: false, error: NO_BRIDGE }
  try {
    const res = await bridge.readCache()
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, cache: res.cache, stale: res.stale, warnings: res.warnings }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'READ_FAILED',
        message: `The saved tender list could not be read. ${
          error instanceof Error ? error.message : 'No reason was reported.'
        }`,
      },
    }
  }
}

/** Fetch the latest listings. The only networked action on this page. */
export async function refreshSavedList(
  bridge: DiscoveryBridge | null,
): Promise<
  | { ok: true; cache: DiscoveryCacheEnvelope; complete: boolean; warnings: string[] }
  | { ok: false; error: TendersIpcError }
> {
  if (!bridge) return { ok: false, error: NO_BRIDGE }
  try {
    const res = await bridge.refresh()
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, cache: res.cache, complete: res.complete, warnings: res.warnings }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'REFRESH_FAILED',
        message: `The eTenders feed could not be reached. ${
          error instanceof Error ? error.message : 'No reason was reported.'
        }`,
      },
    }
  }
}

// ── one document, one tender ─────────────────────────────────────────────────

/**
 * The provenance a tender added from the feed carries into its review.
 *
 * This is the whole answer to "where did this come from?": it names the feed,
 * the record it came from and the fact that the source — not this app — stated
 * the listing. It is written into the review's conflict list, which the schema
 * persists on the tender (`intakeVerification.conflicts`) and which the review
 * step shows at the top, so it cannot be lost by a restart or hidden behind a
 * hover.
 */
export function provenanceNote(opportunity: Opportunity): string {
  return (
    `Added from National Treasury’s eTenders open data (${DISCOVERY_PROVENANCE}), ocid ${opportunity.ocid}. ` +
    `This listing is machine-sourced and unverified: it is what the source published, not something this app confirmed. ` +
    `Nothing on this tender is confirmed until you check it against the official tender document. ` +
    `Source record: ${opportunity.sourceUrl}`
  )
}

/** The honest line for a document that was not downloaded. */
export function downloadFailureMessage(error: TendersIpcError): string {
  // The engine's own message is shown verbatim: it already says what happened
  // (a blocked host, a timeout, a refusal) and re-wording it would lose that.
  return `That document could not be downloaded. ${error.message}`
}

/** The honest line for a downloaded document the intake would not read. */
export function addFailureMessage(error: unknown): string {
  if (error instanceof PdfImportCancelledError || error instanceof DocxImportCancelledError) {
    return 'Adding that document was cancelled, so no tender was created.'
  }
  if (error instanceof PdfPreflightError || error instanceof DocxPreflightError) {
    // A typed, user-visible reason (oversize, too many pages, a protected file).
    return `That document could not be added: ${error.message}`
  }
  const message = error instanceof Error ? error.message : ''
  if (/unsupported document type/i.test(message)) {
    return 'That document could not be added: this app reads PDF and Word .docx documents, and the link is neither.'
  }
  return 'That document could not be read into a tender. Is it damaged or password-protected?'
}

export type AddOpportunityResult = { ok: true; tenderId: string } | { ok: false; message: string }

/**
 * Add one listed document to the workspace: download it, then run it through the
 * ordinary intake.
 *
 * The download is stored as an ordinary managed document by main, so the intake
 * adopts that file (`storedPath`) instead of writing a second copy — and a
 * cancelled or failed intake deletes it rather than leaving an orphan. The AI
 * pass follows the same remembered opt-in an imported file does: this path
 * invents no second policy about sending a document to a model.
 */
export async function addOpportunityDocument(
  bridge: DiscoveryBridge | null,
  opportunity: Opportunity,
  document: OpportunityDocument,
  signal?: AbortSignal,
): Promise<AddOpportunityResult> {
  if (!bridge) return { ok: false, message: NO_BRIDGE.message }
  const name = documentName(document)
  const res = await bridge.downloadDocument(
    name ? { url: document.url, fileName: name } : { url: document.url },
  )
  if (!res.ok) return { ok: false, message: downloadFailureMessage(res.error) }
  const file = new File([res.buffer], res.fileName, { type: res.mimeType })
  try {
    const { tenderId } = await intakeTenderFile(file, {
      signal: signal ?? new AbortController().signal,
      storedPath: res.storedPath,
      aiExtraction: readAiExtractionPreference(),
      reviewNotes: [provenanceNote(opportunity)],
    })
    return { ok: true, tenderId }
  } catch (error) {
    return { ok: false, message: addFailureMessage(error) }
  }
}

// ── what a row says ──────────────────────────────────────────────────────────

const FIELD_LABEL: Record<ScoreMatch['field'], string> = {
  title: 'title',
  category: 'category',
  buyer: 'buyer name',
  description: 'description',
}

/** One relevance match as a chip: which profile term, and where it matched. */
export function matchLabel(match: ScoreMatch): string {
  return `“${match.term}” in the ${FIELD_LABEL[match.field]}`
}

/** The relevance line, always with the reason behind it. */
export function relevanceText(score: OpportunityScore): string {
  if (score.available === 0) return score.explanation
  return `${Math.round(score.score * 100)}% relevant — ${score.explanation}`
}

const CATEGORY_LABEL: Record<string, string> = {
  goods: 'Goods',
  works: 'Works',
  services: 'Services',
}

/** The feed's category word as a label. A missing category stays missing. */
export function categoryLabel(category: string | null): string {
  if (category === null || category.trim().length === 0) return 'No category stated'
  return CATEGORY_LABEL[category.toLowerCase()] ?? category
}

/**
 * The value line. The feed almost never publishes one, and the archive states a
 * literal zero for every release, which the core already reads as "no value
 * stated" — so an absent value says so rather than showing a R 0 tender.
 */
export function valueDisplay(value: Opportunity['value']): string {
  if (value === null) return 'No value stated by the source'
  const currency = value.currency
  if (currency === null || currency.toUpperCase() === 'ZAR') return formatRandAmount(value.amount)
  // A stated non-rand currency is printed with its own code, never as rand.
  return `${currency} ${value.amount}`
}

/** How the province was decided, so an inference is never shown as a fact. */
export function provinceNote(opportunity: Opportunity): string {
  if (opportunity.province === null) return 'The source does not say where this tender is.'
  switch (opportunity.provinceSource) {
    case 'buyer':
      return 'read from the buyer’s name'
    case 'title':
      return 'read from the tender title'
    case 'description':
      return 'read from the description'
    default:
      return 'stated by the source'
  }
}

export interface ClosingDisplay {
  /** `parsed` only when the source stated a date this app could read. */
  state: 'parsed' | 'missing' | 'unparseable'
  countdown: string
  /** The closing time as the source stated it (SAST-anchored, as elsewhere). */
  formatted: string
  /** The source's own closing text, when it stated one. */
  raw: string | null
  /**
   * Why there is no countdown. Non-null for every state that is not `parsed` —
   * an opportunity with no readable closing date is flagged, never given one.
   */
  flag: string | null
}

/**
 * The closing line for one listing.
 *
 * A listing whose closing date is missing or unreadable stays listable — it is a
 * real tender — but it is flagged as such and carries no countdown: this app
 * does not invent a deadline, and it does not let a listing without one look
 * like a listing that has one.
 */
export function closingDisplay(opportunity: Opportunity, now: Date): ClosingDisplay {
  const raw = opportunity.closingRaw
  if (opportunity.closingState === 'parsed' && opportunity.closingAt !== null) {
    const status = deadlineStatus(raw, now)
    if (status.date !== null) {
      return {
        state: 'parsed',
        countdown: status.countdownLabel,
        formatted: status.formatted,
        raw,
        flag: null,
      }
    }
  }
  // Anything the source DID state but this app cannot count down to is flagged as
  // unreadable — with the source's own words quoted — rather than being reported
  // as "no closing date", which would be a different (and untrue) statement.
  if (raw !== null) {
    return {
      state: 'unparseable',
      countdown: '',
      formatted: '',
      raw,
      flag:
        opportunity.closingNote ??
        `The closing date the source stated (“${raw}”) could not be read, so no date is claimed.`,
    }
  }
  return {
    state: 'missing',
    countdown: '',
    formatted: '',
    raw,
    flag:
      opportunity.closingNote ??
      'The source states no closing date for this tender, so there is none to count down to.',
  }
}

/** The name a linked document is offered under: its own, else the link's last part. */
export function documentName(document: OpportunityDocument): string {
  const title = document.title?.trim() ?? ''
  if (/\.[A-Za-z0-9]{2,5}$/.test(title)) return title
  try {
    const segments = new URL(document.url).pathname.split('/').filter((part) => part.length > 0)
    const last = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]).trim() : ''
    if (last) return last
  } catch {
    // The link is whatever the feed stated; a title or a fallback name is enough.
  }
  return title
}

/** Relevance terms typed into the filter box: comma- or space-separated. */
export function parseKeywordInput(text: string): string[] {
  const terms: string[] = []
  for (const raw of text.split(/[,\n]+/)) {
    const term = raw.replace(/\s+/g, ' ').trim().toLowerCase()
    if (term.length === 0 || terms.includes(term)) continue
    terms.push(term)
  }
  return terms
}

/** How the pane names the source a saved list came from. */
export function sourceLabel(source: DiscoverySource): string {
  return source === 'bulk-archive'
    ? 'the eTenders monthly bulk archive (which lags the live feed by one to two months)'
    : 'the live eTenders feed'
}

/** When a saved list was fetched, pinned to the product's own clock (SAST). */
export function fetchedAtText(fetchedAt: string): string {
  const date = new Date(fetchedAt)
  if (Number.isNaN(date.getTime())) return 'at an unreadable time'
  return date.toLocaleString('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Johannesburg',
  })
}

/** The age line for the saved list, including whether it is stale and complete. */
export function cacheStatusText(cache: DiscoveryCacheEnvelope, stale: boolean): string {
  const hours = Math.round(DISCOVERY_CACHE_MAX_AGE_MS / 3_600_000)
  const parts = [`Saved ${fetchedAtText(cache.fetchedAt)} from ${sourceLabel(cache.source)}.`]
  parts.push(
    stale
      ? `That is older than the ${hours}-hour freshness window this app keeps, so it may be out of date.`
      : `It is inside the ${hours}-hour freshness window this app keeps.`,
  )
  if (!cache.complete) {
    parts.push('The fetch that produced it did not finish, so it may be missing tenders.')
  }
  return parts.join(' ')
}

/** One hidden listing and the reason the filter hid it. */
export interface HiddenOpportunity {
  opportunity: Opportunity
  exclusion: FilterExclusion
}

// ── the page ─────────────────────────────────────────────────────────────────

export function DiscoverPage() {
  const company = useTendersStore((s) => s.company)
  const setPage = useTendersStore((s) => s.setPage)
  const now = useNow(60_000)
  const bridge = useMemo(() => discoveryBridge(), [])

  const [cache, setCache] = useState<DiscoveryCacheEnvelope | null>(null)
  const [stale, setStale] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [loadError, setLoadError] = useState<TendersIpcError | null>(null)
  /** A read has finished, so "nothing matched" is distinguishable from "not read yet". */
  const [read, setRead] = useState(false)
  const [busy, setBusy] = useState<'read' | 'refresh' | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; message: string } | null>(null)
  const [addingUrl, setAddingUrl] = useState<string | null>(null)
  const addAbortRef = useRef<AbortController | null>(null)

  // The filter starts from the company profile — its address decides the
  // province and its industry/description decide the relevance terms — so the
  // first list a user sees is already about their own business. Nothing else is
  // narrowed: a listing is never hidden because of a guess.
  const profileFilter = useMemo(() => deriveDiscoveryFilter(company), [company])
  const [filter, setFilter] = useState<DiscoveryFilter>(profileFilter)
  const [keywordText, setKeywordText] = useState(() => profileFilter.keywords.join(', '))

  const load = useCallback(async () => {
    setBusy('read')
    const result = await readSavedList(bridge)
    setBusy(null)
    setRead(true)
    if (!result.ok) {
      // A failed read is a failed read. The list below is NOT shown empty:
      // "nothing matched" and "the fetch failed" are different statements.
      setLoadError(result.error)
      return
    }
    setLoadError(null)
    setCache(result.cache)
    setStale(result.stale)
    setWarnings(result.warnings)
  }, [bridge])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    setBusy('refresh')
    setNotice(null)
    const result = await refreshSavedList(bridge)
    setBusy(null)
    setRead(true)
    if (!result.ok) {
      setNotice({ tone: 'warn', message: result.error.message })
      return
    }
    setLoadError(null)
    setCache(result.cache)
    setStale(isCacheStale(result.cache, new Date()))
    setWarnings(result.warnings)
    const count = result.cache.opportunities.length
    setNotice({
      tone: result.complete ? 'ok' : 'warn',
      message: result.complete
        ? `Fetched ${count} listing${count === 1 ? '' : 's'} published in ${result.cache.window.from} to ${result.cache.window.to}.`
        : 'The fetch did not finish, so this list may be missing tenders — the reasons are listed above.',
    })
  }, [bridge])

  const add = useCallback(
    async (opportunity: Opportunity, document: OpportunityDocument) => {
      addAbortRef.current?.abort()
      const controller = new AbortController()
      addAbortRef.current = controller
      setAddingUrl(document.url)
      setNotice(null)
      const result = await addOpportunityDocument(bridge, opportunity, document, controller.signal)
      if (addAbortRef.current === controller) {
        addAbortRef.current = null
        setAddingUrl(null)
      }
      if (!result.ok) {
        setNotice({ tone: 'warn', message: result.message })
        return
      }
      // The intake activated the tender, so land on it: the review gate is the
      // next thing the user has to meet, exactly as after an import.
      setPage('tenders')
    },
    [bridge, setPage],
  )

  const cancelAdd = useCallback(() => {
    addAbortRef.current?.abort()
  }, [])

  const listings = cache?.opportunities ?? []
  const visible = useMemo(
    () => rankOpportunities(filterOpportunities(listings, filter, now), filter),
    [listings, filter, now],
  )
  const hidden = useMemo<HiddenOpportunity[]>(() => {
    const out: HiddenOpportunity[] = []
    for (const opportunity of listings) {
      const exclusion = exclusionReason(opportunity, filter, now)
      if (exclusion !== null) out.push({ opportunity, exclusion })
    }
    return out
  }, [listings, filter, now])

  const coverage = describeCoverage()

  const applyKeywords = (text: string): void => {
    setKeywordText(text)
    setFilter((current) => ({ ...current, keywords: parseKeywordInput(text) }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-8 py-5">
        <h1
          id="discover-page-heading"
          className="inline-flex items-center gap-2 text-xl font-bold text-[var(--text)]"
        >
          <Search size={20} className="text-[var(--accent)]" aria-hidden="true" /> Find tenders
        </h1>
        <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
          Listings published by National Treasury’s eTenders open data. This is a place to start
          looking, not a list of everything out there: a listing is what the source published, so
          nothing here is confirmed until you open the official document and check it.
        </p>
      </div>

      {/* The page's own landmark, named by the page heading beside it (the
          `aria-labelledby` pattern `OverviewPage`/`ProfilePage` use), so a
          screen-reader user can jump to "Find tenders" and land on the pane
          rather than on a region that only repeats the heading's words. */}
      <section
        aria-labelledby="discover-page-heading"
        className="mx-auto w-full max-w-5xl flex-1 px-8 py-8"
      >
        {/* What the feed is, and is not — rendered verbatim from
            `describeCoverage()` and always on screen, in every state. */}
        <section
          data-testid="discovery-coverage"
          aria-label="What this feed covers and what it does not"
          className="rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-4"
        >
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <ShieldAlert size={15} className="text-[var(--warn)]" aria-hidden="true" />
            Read this before you rely on the list
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {coverage.summary}
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {coverage.badges.map((badge) => (
              <li key={badge}>
                <Badge tone="amber">{badge}</Badge>
              </li>
            ))}
          </ul>
          <ul className="mt-3 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            {coverage.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <ul className="mt-3 space-y-0.5 text-[11px] text-[var(--text-tertiary)]">
            {coverage.sources.map((source) => (
              <li key={source.url}>
                {source.label} — {source.url} — {source.licence}
              </li>
            ))}
          </ul>
        </section>

        {/* The saved list's age, and how the last fetch went. */}
        <section
          data-testid="discovery-status"
          aria-label="Saved list status"
          className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
        >
          {cache === null ? (
            <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {read
                ? 'No list has been fetched on this machine yet, so there is nothing saved to show.'
                : 'Reading the list saved on this machine…'}
            </p>
          ) : (
            <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {cacheStatusText(cache, stale)}
            </p>
          )}
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="discovery-refresh"
              disabled={busy !== null}
              onClick={() => void refresh()}
              title="Fetch the latest listings from the eTenders feed"
            >
              {busy === 'refresh' ? <Spinner className="size-3.5" /> : <RefreshCw size={13} />}
              {busy === 'refresh' ? 'Fetching…' : 'Fetch latest'}
            </Button>
          </div>
        </section>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          Fetching needs a network connection and reaches National Treasury’s own servers, which can
          take up to a minute and sometimes fail. The saved list above needs no network connection
          and is always shown, however the fetch goes.
        </p>

        {warnings.length > 0 && (
          <div
            role="status"
            data-testid="discovery-warnings"
            className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2.5 text-[12px] text-[var(--text-secondary)]"
          >
            <AlertTriangle
              size={14}
              className="mt-0.5 shrink-0 text-[var(--warn)]"
              aria-hidden="true"
            />
            <ul className="min-w-0 flex-1 list-disc space-y-0.5 pl-4 leading-relaxed">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        {notice && (
          <div
            role={notice.tone === 'warn' ? 'alert' : 'status'}
            data-testid="discovery-notice"
            className={`mt-4 flex flex-wrap items-start gap-2 rounded-lg border px-3 py-2.5 text-[12px] text-[var(--text-secondary)] ${
              notice.tone === 'warn'
                ? 'border-[var(--warn-border)] bg-[var(--warn-bg)]'
                : 'border-[var(--success-border)] bg-[var(--success-bg)]'
            }`}
          >
            {notice.tone === 'warn' ? (
              <AlertTriangle
                size={14}
                className="mt-0.5 shrink-0 text-[var(--warn)]"
                aria-hidden="true"
              />
            ) : (
              <CheckCircle2
                size={14}
                className="mt-0.5 shrink-0 text-[var(--success)]"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1 leading-relaxed">{notice.message}</span>
            <div className="flex shrink-0 items-center gap-2">
              {addingUrl !== null && (
                <Button size="sm" variant="default" onClick={cancelAdd}>
                  Cancel
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {/* A read that failed is reported as a failure, with the engine's own
            reason and a retry — never as an empty list. */}
        {loadError && (
          <div
            role="alert"
            data-testid="discovery-error"
            className="mt-4 flex flex-wrap items-start gap-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2.5 text-[12px] text-[var(--text-secondary)]"
          >
            <AlertTriangle
              size={14}
              className="mt-0.5 shrink-0 text-[var(--danger)]"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="leading-relaxed">{loadError.message}</p>
              <p className="mt-1 leading-relaxed text-[var(--text-tertiary)]">
                The listings the feed gave are not shown at all, because an unread list would look
                like a list with nothing in it.
              </p>
            </div>
            <Button
              size="sm"
              variant="default"
              data-testid="discovery-retry"
              onClick={() => void load()}
            >
              Try again
            </Button>
          </div>
        )}

        {/* Filters, seeded from the company profile. */}
        <section
          data-testid="discovery-filters"
          aria-label="Filters"
          className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4"
        >
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            <Filter size={14} className="text-[var(--accent)]" aria-hidden="true" /> Narrow the list
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <label className={FORM_LABEL_CLASS} htmlFor="discovery-province">
                Province
              </label>
              <select
                id="discovery-province"
                data-testid="discovery-province"
                className={FORM_CONTROL_CLASS}
                value={filter.provinces[0] ?? ''}
                onChange={(event) =>
                  setFilter((current) => ({
                    ...current,
                    provinces: event.target.value ? [event.target.value] : [],
                  }))
                }
              >
                <option value="">All provinces (and listings whose province is not stated)</option>
                {SA_PROVINCES.map((province) => (
                  <option key={province} value={province}>
                    {province}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={FORM_LABEL_CLASS} htmlFor="discovery-category">
                Category
              </label>
              <select
                id="discovery-category"
                data-testid="discovery-category"
                className={FORM_CONTROL_CLASS}
                value={filter.categories[0] ?? ''}
                onChange={(event) =>
                  setFilter((current) => ({
                    ...current,
                    categories: event.target.value ? [event.target.value] : [],
                  }))
                }
              >
                <option value="">All categories</option>
                <option value="goods">Goods</option>
                <option value="works">Works</option>
                <option value="services">Services</option>
              </select>
            </div>
            <div>
              <label className={FORM_LABEL_CLASS} htmlFor="discovery-min-score">
                Relevance
              </label>
              <select
                id="discovery-min-score"
                data-testid="discovery-min-score"
                className={FORM_CONTROL_CLASS}
                value={String(filter.minScore)}
                onChange={(event) =>
                  setFilter((current) => ({ ...current, minScore: Number(event.target.value) }))
                }
              >
                <option value="0">Any relevance</option>
                <option value="0.5">At least half my terms</option>
                <option value="1">Every one of my terms</option>
              </select>
            </div>
          </div>
          <div className="mt-3">
            <label className={FORM_LABEL_CLASS} htmlFor="discovery-keywords">
              Relevance terms (from your company profile — comma-separated)
            </label>
            <input
              id="discovery-keywords"
              data-testid="discovery-keywords"
              type="text"
              className={FORM_CONTROL_CLASS}
              value={keywordText}
              onChange={(event) => applyKeywords(event.target.value)}
              placeholder="e.g. water, pipeline, construction"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              Every listing is scored against these terms and the pane says which term matched where
              — a relevance number with no explanation would be a number to trust blindly.
            </p>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                data-testid="discovery-include-closed"
                className={DISCOVERY_CHECKBOX_CLASS}
                checked={filter.includeClosed}
                onChange={(event) =>
                  setFilter((current) => ({ ...current, includeClosed: event.target.checked }))
                }
              />
              Include tenders the source says are closed
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                data-testid="discovery-include-unknown-closing"
                className={DISCOVERY_CHECKBOX_CLASS}
                checked={filter.includeUnknownClosing}
                onChange={(event) =>
                  setFilter((current) => ({
                    ...current,
                    includeUnknownClosing: event.target.checked,
                  }))
                }
              />
              Include listings with no readable closing date
            </label>
            <Button
              size="sm"
              variant="default"
              data-testid="discovery-reset-filters"
              onClick={() => {
                setFilter(profileFilter)
                setKeywordText(profileFilter.keywords.join(', '))
              }}
            >
              Reset to my company profile
            </Button>
          </div>
          {profileFilter.provinces.length > 0 && (
            <p className="mt-2 text-[11px] text-[var(--text-tertiary)]">
              Province {profileFilter.provinces[0]} and {profileFilter.keywords.length} relevance
              term{profileFilter.keywords.length === 1 ? '' : 's'} came from your company profile. A
              province filter also hides listings whose province the source does not state.
            </p>
          )}
        </section>

        {/* The list itself, named by its own visible heading so the region a
            screen reader announces and the heading on screen say the same
            thing — including how many listings the filters are showing. */}
        <section aria-labelledby="discover-listings-heading" className="mt-6">
          <h2
            id="discover-listings-heading"
            className="mb-3 text-sm font-semibold text-[var(--text)]"
          >
            Listings{' '}
            {listings.length > 0 && (
              <span className="text-[var(--text-tertiary)]">
                ({visible.length} of {listings.length} shown)
              </span>
            )}
          </h2>

          {busy === 'read' && cache === null && !loadError ? (
            <p className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-6 text-sm text-[var(--text-secondary)]">
              <Spinner className="size-4" /> Reading the list saved on this machine…
            </p>
          ) : loadError ? null : listings.length === 0 ? (
            <p
              data-testid="discovery-empty"
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]"
            >
              {cache === null
                ? 'Nothing is saved yet. Fetch the latest listings above — that needs a network connection, and the saved list keeps working without one.'
                : `The saved list has no listings in it for the window it fetched (${cache.window.from} to ${cache.window.to}). That is what the feed answered with, which is not the same as there being no tenders.`}
            </p>
          ) : visible.length === 0 ? (
            <p
              data-testid="discovery-empty"
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]"
            >
              None of the {listings.length} saved listing
              {listings.length === 1 ? '' : 's'} match the filters above — every one of them is
              listed with the reason it was hidden.
            </p>
          ) : (
            <ul className="space-y-3">
              {visible.map(({ opportunity, score }) => (
                <OpportunityRow
                  key={opportunity.ocid}
                  opportunity={opportunity}
                  score={score}
                  now={now}
                  addingUrl={addingUrl}
                  onAdd={(document) => void add(opportunity, document)}
                />
              ))}
            </ul>
          )}

          {/* Nothing is hidden silently: every filtered-out listing says why. */}
          {hidden.length > 0 && (
            <details
              data-testid="discovery-hidden"
              className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
            >
              <summary className="cursor-pointer text-[12px] font-medium text-[var(--text-secondary)]">
                {hidden.length} saved listing{hidden.length === 1 ? '' : 's'} hidden by your filters
                — click to see why
              </summary>
              <ul className="mt-2 space-y-1.5">
                {hidden.map(({ opportunity, exclusion }) => (
                  <li
                    key={opportunity.ocid}
                    className="text-[11px] leading-relaxed text-[var(--text-secondary)]"
                  >
                    <span className="font-medium text-[var(--text)]">{opportunity.title}</span> —{' '}
                    {exclusion.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </section>
    </div>
  )
}

/** One listing: what the source stated, why it scored what it scored, and how to add it. */
function OpportunityRow({
  opportunity,
  score,
  now,
  addingUrl,
  onAdd,
}: {
  opportunity: Opportunity
  score: OpportunityScore
  now: Date
  addingUrl: string | null
  onAdd: (document: OpportunityDocument) => void
}) {
  const closing = closingDisplay(opportunity, now)
  const status = deadlineStatus(opportunity.closingRaw, now)
  return (
    <li
      data-testid="discovery-row"
      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            data-testid="discovery-row-title"
            className="text-sm font-semibold text-[var(--text)]"
          >
            {opportunity.title}
          </h3>
          <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
            {opportunity.buyer ?? 'The source states no buyer name'}
          </p>
        </div>
        <Badge tone={opportunity.source === 'bulk-archive' ? 'amber' : 'slate'}>
          {opportunity.source === 'bulk-archive'
            ? 'From the monthly archive'
            : 'From the live feed'}
        </Badge>
      </div>

      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">
        {closing.state === 'parsed' ? (
          <span
            data-testid="discovery-row-closing"
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${urgencyClasses(status.urgency)}`}
            title={closing.formatted}
          >
            <Clock size={11} /> {closing.countdown}
          </span>
        ) : (
          <span
            data-testid="discovery-closing-unknown"
            className="inline-flex items-center gap-1 rounded-full border border-[var(--warn-border)] bg-[var(--warn-bg)] px-2 py-0.5 font-semibold text-[var(--warn)]"
            title={closing.flag ?? undefined}
          >
            <CalendarClock size={11} />
            {closing.state === 'unparseable'
              ? 'Closing date unreadable as stated'
              : 'No closing date stated by the source'}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <FileText size={11} /> {categoryLabel(opportunity.category)}
        </span>
        <span>{valueDisplay(opportunity.value)}</span>
        <span className="inline-flex items-center gap-1" title={provinceNote(opportunity)}>
          <MapPin size={11} /> {opportunity.province ?? 'Province not stated by the source'}
        </span>
        {opportunity.publishedAt && <span>published {fetchedAtText(opportunity.publishedAt)}</span>}
      </p>

      {closing.flag !== null && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--warn)]">{closing.flag}</p>
      )}
      {closing.raw !== null && (
        <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
          Closing as the source stated it: “{closing.raw}”
        </p>
      )}

      {/* Relevance, with the terms that produced it. */}
      <p
        data-testid="discovery-row-relevance"
        className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]"
      >
        {relevanceText(score)}
      </p>
      {score.matches.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {score.matches.map((match) => (
            <li key={`${match.term}-${match.field}`}>
              <Badge tone="indigo">{matchLabel(match)}</Badge>
            </li>
          ))}
        </ul>
      )}

      {opportunity.warnings.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          {opportunity.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div
        data-testid="discovery-row-documents"
        className="mt-3 border-t border-[var(--border-subtle)] pt-3"
      >
        {opportunity.documents.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
            The source links no document for this listing
            {opportunity.refusedDocumentLinks > 0
              ? `, and the ${opportunity.refusedDocumentLinks} link${opportunity.refusedDocumentLinks === 1 ? '' : 's'} it did carry could not be used`
              : ''}
            . There is nothing to add to the workspace from here — open the listing on the eTenders
            site instead.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {opportunity.documents.map((document) => {
              const name = documentName(document)
              const kind = tenderSourceKind({ name, type: document.format ?? '' })
              const busy = addingUrl === document.url
              return (
                <li key={document.url} className="flex flex-wrap items-center gap-2">
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]"
                    title={document.url}
                  >
                    {name || 'linked document'}
                    {document.format ? ` · ${document.format}` : ''}
                    {kind === null ? ' · not a PDF or .docx link' : ''}
                  </span>
                  <Button
                    size="sm"
                    variant="default"
                    data-testid="discovery-add"
                    disabled={addingUrl !== null}
                    onClick={() => onAdd(document)}
                    title="Download this document and add it to the workspace as a tender"
                  >
                    {busy ? <Spinner className="size-3.5" /> : <Download size={13} />}
                    {busy ? 'Adding…' : 'Add to workspace'}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          Adding downloads the document from etenders.gov.za into this app’s own document store and
          runs the ordinary intake on it: it lands as a tender with every field unconfirmed, waiting
          for your review, with the listing it came from recorded on it. Tender documents are
          linked, not copied, by the app until you ask for one.
        </p>
        <p className="mt-1 text-[11px] break-all text-[var(--text-tertiary)]">
          Source record: {opportunity.sourceUrl}
        </p>
      </div>
    </li>
  )
}

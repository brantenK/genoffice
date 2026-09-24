// Tender discovery — the main-process client.
//
// The wire and the disk for `shared/discovery.ts`. Everything that makes a
// decision about *what the feed says* lives in the pure core; this file decides
// only how to ask, how hard to try, and what to keep. It is the second place in
// the fork that reaches the network (the first is optional AI extraction), and
// it is shaped so that reach is bounded and provable:
//
//  * **The network call is injected.** `fetchImpl` defaults to `globalThis.fetch`
//    and every test passes a fake, so the whole client — retries, timeouts, the
//    byte cap, the fallback, the cache — is exercised with zero network and a
//    deterministic clock (`now`) and delay (`sleep`).
//  * **https only, on an allow-list, with redirects re-checked.** Every URL is
//    validated by the core's `isAllowedDiscoveryUrl` before it is requested, and
//    redirects are followed MANUALLY so a 302 to another host is validated
//    rather than trusted. A look-alike host, a plain-http URL, or a URL carrying
//    credentials is refused with `BLOCKED_URL` and never fetched.
//  * **Bounded everywhere.** A per-request timeout (the live feed is genuinely
//    slow — a first-hand request took 30 s, and a 200-record page never
//    answered at all), a hard byte cap enforced while the body is read rather
//    than after, bounded exponential-backoff retries on 5xx/timeout/network
//    only, small date windows, a page cap, and a cap on what is written to disk.
//  * **No credential, no key.** The OCDS API is keyless and documented; nothing
//    here reads or sends a secret.
//  * **The live feed is the default, the archive is the fallback.** When every
//    live window fails, the monthly bulk archive is read instead, and the cache
//    records that it did (`source: 'bulk-archive'`) along with a plain-language
//    warning that the archive lags. A fallback is never presented as the live
//    feed.
//  * **A failed refresh never destroys a good cache.** A refresh writes only
//    when it has something to write; otherwise the previous cache is left alone
//    and the failure is returned.
//  * **Offline works.** `readCache()` reads the last successful fetch from
//    `<userData>/tenders/discovery/`, so the list survives a restart and is
//    available with no network at all.
//
// It deliberately does NOT import `tenders-main.ts`: the IPC wiring, the trusted
// sender check and the userData path resolution belong to the wave that owns
// them. This file takes its cache directory as an option and exports
// `discoveryCacheDir` so that wave resolves it the same way.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  bulkArchiveListingUrl,
  bulkArchiveMonth,
  createDiscoveryCache,
  defaultDiscoveryWindow,
  DISCOVERY_CACHE_FILE_NAME,
  DISCOVERY_CACHE_MAX_AGE_MS,
  DISCOVERY_MAX_WINDOW_DAYS,
  DISCOVERY_PAGE_SIZE,
  isAllowedDiscoveryUrl,
  isCacheStale,
  isValidWindow,
  ocdsReleaseUrl,
  ocdsReleasesUrl,
  parseBulkArchiveListing,
  parseDiscoveryCache,
  parseOcdsPage,
  parseOcdsRelease,
  splitWindow,
  windowDays,
} from '../shared/discovery'
import type {
  DiscoveryCacheEnvelope,
  DiscoveryParseIssue,
  DiscoverySource,
  DiscoveryWindow,
  Opportunity,
} from '../shared/discovery'

// ── bounds (every one of these is a decision, not a default) ─────────────────

/**
 * Per-request timeout. The live feed took 30 s to answer a two-record page in a
 * first-hand measurement, so a tight timeout would fail on every honest request;
 * 45 s leaves room for a slow answer while still ending a hung one.
 */
export const DISCOVERY_REQUEST_TIMEOUT_MS = 45_000

/** Attempts per request, including the first. */
export const DISCOVERY_MAX_ATTEMPTS = 3

/** First backoff delay; doubled per attempt, capped by the next constant. */
export const DISCOVERY_BACKOFF_BASE_MS = 750

/** Longest wait between attempts. */
export const DISCOVERY_MAX_BACKOFF_MS = 8_000

/**
 * Records asked for per page. Measured: a two-record page answered in 30 s, while
 * a 200-record page never answered at all, so the page is kept modest and the
 * walk follows `links.next` instead of asking for everything at once.
 */
export const DISCOVERY_PAGE_SIZE_DEFAULT = DISCOVERY_PAGE_SIZE

/** Pages followed per window. */
export const DISCOVERY_MAX_PAGES = 20

/**
 * Hard ceiling on one response body, enforced while reading. The largest real
 * payload is the monthly archive at ~1.1 MB (measured for July 2026), so this is
 * generous for the feed and far below anything that could exhaust memory.
 */
export const DISCOVERY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Redirect hops followed, each one re-validated against the allow-list. */
export const DISCOVERY_MAX_REDIRECTS = 3

/** Archive files tried by the fallback, newest first. */
export const DISCOVERY_MAX_ARCHIVE_FILES = 2

/** Windows fetched by one refresh. Bounds the number of requests a refresh makes. */
export const DISCOVERY_MAX_WINDOWS_PER_REFRESH = 6

/** Opportunities kept in the cache. */
export const DISCOVERY_MAX_CACHED_OPPORTUNITIES = 2_000

/** Bytes the serialised cache may occupy on disk. */
export const DISCOVERY_MAX_CACHE_BYTES = 4 * 1024 * 1024

/**
 * The cache directory for a userData root: `<userData>/tenders/discovery`, i.e.
 * beside the store's own `tenders` directory. Exported so the wave that owns the
 * app wiring resolves it identically to the store, and so this module never has
 * to know about Electron.
 */
export function discoveryCacheDir(userDataDir: string): string {
  return join(userDataDir, 'tenders', 'discovery')
}

// ── the injected fetch ───────────────────────────────────────────────────────

export interface DiscoveryFetchInit {
  signal?: AbortSignal
  headers?: Record<string, string>
  /**
   * Always `'manual'`: redirects are followed by this client, one hop at a time,
   * so every hop is re-checked against the allow-list instead of being trusted.
   */
  redirect?: 'manual'
}

export interface DiscoveryHttpReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
  cancel?(): Promise<void> | void
  releaseLock?(): void
}

export interface DiscoveryHttpBody {
  getReader(): DiscoveryHttpReader
}

/**
 * The subset of a `Response` this client uses. Declared structurally so a test
 * can supply a plain object, and so `globalThis.fetch` is assignable to it
 * (see `defaultDiscoveryFetch`).
 */
export interface DiscoveryHttpResponse {
  status: number
  ok?: boolean
  headers?: { get(name: string): string | null } | null
  body?: DiscoveryHttpBody | null
  text?(): Promise<string>
}

export type DiscoveryFetch = (
  url: string,
  init?: DiscoveryFetchInit,
) => Promise<DiscoveryHttpResponse>

/** The real network. Assignable to `DiscoveryFetch`, which the typecheck proves. */
const defaultDiscoveryFetch: DiscoveryFetch = (url, init) => globalThis.fetch(url, init)

// ── results ──────────────────────────────────────────────────────────────────

export type DiscoveryErrorCode =
  /** The request itself was unusable (a window, an ocid, an option). */
  | 'INVALID_REQUEST'
  /** The URL was not https, not on the allow-list, or carried credentials. */
  | 'BLOCKED_URL'
  /** The caller cancelled. */
  | 'ABORTED'
  /** The request did not answer inside the timeout. */
  | 'TIMEOUT'
  /** The request failed before a response (DNS, socket, TLS). */
  | 'NETWORK'
  /** A non-retryable status, or retries exhausted on a retryable one. */
  | 'HTTP_STATUS'
  /** The body exceeded the byte cap and was abandoned mid-read. */
  | 'RESPONSE_TOO_LARGE'
  /** The body was not JSON, or was JSON of a shape nothing could be read from. */
  | 'MALFORMED_BODY'
  /** The stored cache could not be read or was not a cache this version uses. */
  | 'CACHE_READ'
  /** The cache could not be written. */
  | 'CACHE_WRITE'

export interface DiscoveryError {
  code: DiscoveryErrorCode
  /** Plain-language reason, safe to show. */
  message: string
  url?: string
  status?: number
  attempts?: number
}

export interface DiscoveryFailure {
  ok: false
  error: DiscoveryError
}

// ── listOpportunities ────────────────────────────────────────────────────────

export interface ListOpportunitiesRequest {
  window: DiscoveryWindow
  pageSize?: number
  signal?: AbortSignal
}

export interface ListOpportunitiesSuccess {
  ok: true
  opportunities: Opportunity[]
  issues: DiscoveryParseIssue[]
  warnings: string[]
  /** Pages actually read. */
  pages: number
  /** Pages that failed after the first succeeded. */
  failedPages: number
  source: DiscoverySource
  /** True when the walk stopped before the source ran out — read `warnings`. */
  truncated: boolean
}

export type ListOpportunitiesResult = ListOpportunitiesSuccess | DiscoveryFailure

// ── fetchRelease ─────────────────────────────────────────────────────────────

export interface FetchReleaseOptions {
  signal?: AbortSignal
}

export interface FetchReleaseSuccess {
  ok: true
  opportunity: Opportunity | null
  issues: DiscoveryParseIssue[]
  warnings: string[]
}

export type FetchReleaseResult = FetchReleaseSuccess | DiscoveryFailure

// ── refreshCache ─────────────────────────────────────────────────────────────

export interface RefreshCacheRequest {
  window?: DiscoveryWindow
  signal?: AbortSignal
}

export interface RefreshCacheSuccess {
  ok: true
  cache: DiscoveryCacheEnvelope
  /** False when a window or the fallback failed, so the list is partial. */
  complete: boolean
  warnings: string[]
}

export type RefreshCacheResult = RefreshCacheSuccess | DiscoveryFailure

// ── readCache ────────────────────────────────────────────────────────────────

export interface ReadCacheSuccess {
  ok: true
  /** Null when nothing has been fetched yet. */
  cache: DiscoveryCacheEnvelope | null
  /** True when there is no cache, or it is older than the freshness bound. */
  stale: boolean
  warnings: string[]
}

export type ReadCacheResult = ReadCacheSuccess | DiscoveryFailure

export interface DiscoveryClient {
  listOpportunities(request: ListOpportunitiesRequest): Promise<ListOpportunitiesResult>
  fetchRelease(ocid: string, options?: FetchReleaseOptions): Promise<FetchReleaseResult>
  refreshCache(request?: RefreshCacheRequest): Promise<RefreshCacheResult>
  readCache(): Promise<ReadCacheResult>
}

export interface DiscoveryClientOptions {
  /** Where the cache lives. Use `discoveryCacheDir(app.getPath('userData'))`. */
  cacheDir: string
  fetchImpl?: DiscoveryFetch
  now?: () => Date
  /** Delay between retries. Injected so a test's retry path costs no wall time. */
  sleep?: (ms: number) => Promise<void>
  requestTimeoutMs?: number
  maxAttempts?: number
  backoffBaseMs?: number
  maxBackoffMs?: number
  pageSize?: number
  maxPages?: number
  maxBytesPerResponse?: number
  maxRedirects?: number
  maxArchiveFiles?: number
  maxWindowsPerRefresh?: number
  maxCachedOpportunities?: number
  maxCacheBytes?: number
  /** How far back `refreshCache` looks when the caller names no window. */
  lookbackDays?: number
  /** Set false to skip the bulk-archive fallback entirely. */
  bulkArchiveFallback?: boolean
}

// ── bounded body reading ─────────────────────────────────────────────────────

type BodyRead = { ok: true; text: string } | { ok: false; reason: 'too-large' | 'unreadable' }

/**
 * Read a body, refusing it the moment it passes `maxBytes` rather than after it
 * has all been buffered — a cap that only measures is not a cap. Falls back to
 * `text()` (with a measured check) for a response that exposes no stream.
 */
async function readCappedBody(
  response: DiscoveryHttpResponse,
  maxBytes: number,
): Promise<BodyRead> {
  const reader = response.body?.getReader?.()
  if (reader) {
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        total += value.byteLength
        if (total > maxBytes) {
          try {
            await reader.cancel?.()
          } catch {
            // A body we are already refusing does not need its stream closed politely.
          }
          return { ok: false, reason: 'too-large' }
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock?.()
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { ok: true, text: new TextDecoder().decode(merged) }
  }
  if (typeof response.text === 'function') {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      return { ok: false, reason: 'too-large' }
    return { ok: true, text }
  }
  return { ok: false, reason: 'unreadable' }
}

function statusOk(response: DiscoveryHttpResponse): boolean {
  if (typeof response.ok === 'boolean') return response.ok
  return response.status >= 200 && response.status < 300
}

/** 5xx, 408 and 429 are worth another attempt; everything else is not. */
function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

// ── the client ───────────────────────────────────────────────────────────────

export function createDiscoveryClient(options: DiscoveryClientOptions): DiscoveryClient {
  const fetchImpl = options.fetchImpl ?? defaultDiscoveryFetch
  const now = options.now ?? (() => new Date())
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const requestTimeoutMs = options.requestTimeoutMs ?? DISCOVERY_REQUEST_TIMEOUT_MS
  const maxAttempts = Math.max(1, options.maxAttempts ?? DISCOVERY_MAX_ATTEMPTS)
  const backoffBaseMs = options.backoffBaseMs ?? DISCOVERY_BACKOFF_BASE_MS
  const maxBackoffMs = options.maxBackoffMs ?? DISCOVERY_MAX_BACKOFF_MS
  const pageSize = Math.max(1, options.pageSize ?? DISCOVERY_PAGE_SIZE_DEFAULT)
  const maxPages = Math.max(1, options.maxPages ?? DISCOVERY_MAX_PAGES)
  const maxBytes = options.maxBytesPerResponse ?? DISCOVERY_MAX_RESPONSE_BYTES
  const maxRedirects = Math.max(0, options.maxRedirects ?? DISCOVERY_MAX_REDIRECTS)
  const maxArchiveFiles = Math.max(1, options.maxArchiveFiles ?? DISCOVERY_MAX_ARCHIVE_FILES)
  const maxWindows = Math.max(1, options.maxWindowsPerRefresh ?? DISCOVERY_MAX_WINDOWS_PER_REFRESH)
  const maxCached = Math.max(
    1,
    options.maxCachedOpportunities ?? DISCOVERY_MAX_CACHED_OPPORTUNITIES,
  )
  const maxCacheBytes = Math.max(1024, options.maxCacheBytes ?? DISCOVERY_MAX_CACHE_BYTES)
  const lookbackDays = options.lookbackDays
  const archiveFallback = options.bulkArchiveFallback !== false
  const cachePath = join(options.cacheDir, DISCOVERY_CACHE_FILE_NAME)

  function failure(
    code: DiscoveryErrorCode,
    message: string,
    extra: Omit<DiscoveryError, 'code' | 'message'> = {},
  ): DiscoveryFailure {
    return { ok: false, error: { code, message, ...extra } }
  }

  /** One attempt's timing, wired to both the caller's signal and our own clock. */
  function armRequest(signal: AbortSignal | undefined): {
    controller: AbortController
    dispose: () => void
    timedOut: () => boolean
  } {
    const controller = new AbortController()
    let timedOut = false
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, requestTimeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)
    // A caller that aborted between the check and the listener would otherwise
    // wait out the whole timeout before its cancellation was noticed.
    if (signal?.aborted) controller.abort()
    return {
      controller,
      timedOut: () => timedOut,
      dispose: () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      },
    }
  }

  /**
   * Fetch one allowed URL as text, with retries. Returns the body's text plus the
   * status of the response it came from.
   */
  async function requestText(
    url: string,
    signal: AbortSignal | undefined,
    accept: string,
  ): Promise<{ ok: true; text: string; status: number } | DiscoveryFailure> {
    if (!isAllowedDiscoveryUrl(url)) {
      return failure(
        'BLOCKED_URL',
        'That address is not one of the eTenders hosts this app is allowed to read, so nothing was requested.',
        { url },
      )
    }
    let lastError: DiscoveryError | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) {
        return failure('ABORTED', 'The discovery request was cancelled.', {
          url,
          attempts: attempt - 1,
        })
      }
      const armed = armRequest(signal)
      try {
        let target = url
        let redirects = 0
        for (;;) {
          const response = await fetchImpl(target, {
            signal: armed.controller.signal,
            headers: { accept },
            redirect: 'manual',
          })
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers?.get?.('location') ?? null
            const next = location === null ? null : resolveRedirect(target, location)
            if (next === null || !isAllowedDiscoveryUrl(next) || redirects >= maxRedirects) {
              return failure(
                'BLOCKED_URL',
                'The eTenders host redirected somewhere this app is not allowed to read, so nothing was followed.',
                { url: target, status: response.status, attempts: attempt },
              )
            }
            redirects += 1
            target = next
            continue
          }
          if (!statusOk(response)) {
            lastError = {
              code: 'HTTP_STATUS',
              message: retryableStatus(response.status)
                ? `The eTenders feed answered with status ${response.status}.`
                : `The eTenders feed refused this request with status ${response.status}.`,
              url: target,
              status: response.status,
              attempts: attempt,
            }
            if (!retryableStatus(response.status)) return { ok: false, error: lastError }
            break
          }
          const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
          if (Number.isFinite(declared) && declared > maxBytes) {
            return failure(
              'RESPONSE_TOO_LARGE',
              'The eTenders feed sent more data than this app will read, so it was refused.',
              { url: target, attempts: attempt },
            )
          }
          const body = await readCappedBody(response, maxBytes)
          if (!body.ok) {
            return failure(
              body.reason === 'too-large' ? 'RESPONSE_TOO_LARGE' : 'NETWORK',
              body.reason === 'too-large'
                ? 'The eTenders feed sent more data than this app will read, so it was refused.'
                : 'The eTenders feed sent a reply this app could not read.',
              { url: target, attempts: attempt },
            )
          }
          return { ok: true, text: body.text, status: response.status }
        }
      } catch (error) {
        if (signal?.aborted) {
          return failure('ABORTED', 'The discovery request was cancelled.', {
            url,
            attempts: attempt,
          })
        }
        const timedOut = armed.timedOut()
        lastError = {
          code: timedOut ? 'TIMEOUT' : 'NETWORK',
          message: timedOut
            ? `The eTenders feed did not answer within ${Math.round(requestTimeoutMs / 1000)} seconds.`
            : 'The eTenders feed could not be reached.',
          url,
          attempts: attempt,
        }
      } finally {
        armed.dispose()
      }
      if (attempt < maxAttempts) {
        const delay = Math.min(backoffBaseMs * 2 ** (attempt - 1), maxBackoffMs)
        await sleep(delay)
      }
    }
    return {
      ok: false,
      error: lastError ?? { code: 'NETWORK', message: 'The eTenders feed could not be reached.' },
    }
  }

  /** A JSON body, or a `MALFORMED_BODY` failure naming what was wrong. */
  async function requestJson(
    url: string,
    signal: AbortSignal | undefined,
    accept: string,
  ): Promise<{ ok: true; value: unknown } | DiscoveryFailure> {
    const response = await requestText(url, signal, accept)
    if (!response.ok) return response
    try {
      return { ok: true, value: JSON.parse(response.text) }
    } catch {
      return failure(
        'MALFORMED_BODY',
        'The eTenders feed answered with something that is not JSON, so nothing could be read from it.',
        { url },
      )
    }
  }

  async function listOpportunities(
    request: ListOpportunitiesRequest,
  ): Promise<ListOpportunitiesResult> {
    const window = request.window
    if (!isValidWindow(window)) {
      return failure(
        'INVALID_REQUEST',
        'A discovery request needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
      )
    }
    const days = windowDays(window)
    if (days === null) {
      return failure('INVALID_REQUEST', 'That date window could not be read.')
    }
    if (days > DISCOVERY_MAX_WINDOW_DAYS) {
      return failure(
        'INVALID_REQUEST',
        `That window spans ${days} days. The eTenders feed reliably answers at most ${DISCOVERY_MAX_WINDOW_DAYS} days at a time — use splitWindow() or refreshCache().`,
      )
    }

    const opportunities: Opportunity[] = []
    const issues: DiscoveryParseIssue[] = []
    const warnings: string[] = []
    const seen = new Set<string>()
    let pages = 0
    let failedPages = 0
    let truncated = false

    const first = ocdsReleasesUrl({
      window,
      pageNumber: 1,
      pageSize: Math.max(1, request.pageSize ?? pageSize),
    })
    let url: string | null = first
    while (url !== null && pages < maxPages) {
      const page = await requestJson(url, request.signal, 'application/json')
      if (!page.ok) {
        if (pages === 0) return page
        failedPages += 1
        truncated = true
        warnings.push(
          `${page.error.message} Only the first ${pages} page${pages === 1 ? '' : 's'} of this window could be read, so this list may be missing tenders.`,
        )
        break
      }
      const parsed = parseOcdsPage(page.value, 'ocds-api')
      pages += 1
      for (const opportunity of parsed.opportunities) {
        if (seen.has(opportunity.ocid)) {
          issues.push({
            path: opportunity.ocid,
            code: 'duplicate-ocid',
            detail: `The ocid ${opportunity.ocid} already appeared earlier in this walk and was not listed twice.`,
          })
          continue
        }
        seen.add(opportunity.ocid)
        opportunities.push(opportunity)
      }
      issues.push(...parsed.issues)
      if (parsed.shape === 'unusable') {
        warnings.push(
          'One page of this window carried nothing that could be read as an OCDS release.',
        )
      }
      if (parsed.next === null) break
      if (!isAllowedDiscoveryUrl(parsed.next)) {
        truncated = true
        warnings.push(
          'The feed offered a next page on a host this app is not allowed to read, so the walk stopped there.',
        )
        break
      }
      if (pages >= maxPages) {
        truncated = true
        warnings.push(
          `This window has more than ${maxPages} pages; only the first ${maxPages} were read, so this list may be missing tenders.`,
        )
        break
      }
      url = parsed.next
    }

    return {
      ok: true,
      opportunities,
      issues,
      warnings,
      pages,
      failedPages,
      source: 'ocds-api',
      truncated,
    }
  }

  async function fetchRelease(
    ocid: string,
    fetchOptions: FetchReleaseOptions = {},
  ): Promise<FetchReleaseResult> {
    const trimmed = typeof ocid === 'string' ? ocid.trim() : ''
    if (!trimmed || trimmed.length > 128) {
      return failure('INVALID_REQUEST', 'A release lookup needs the tender’s ocid.')
    }
    const url = ocdsReleaseUrl(trimmed)
    const page = await requestJson(url, fetchOptions.signal, 'application/json')
    if (!page.ok) return page
    const parsed = parseOcdsRelease(page.value, 'ocds-api')
    const warnings: string[] = []
    if (parsed.opportunity === null) {
      warnings.push('That ocid did not come back as a tender this app could read.')
    }
    return {
      ok: true,
      opportunity: parsed.opportunity,
      issues: parsed.issues,
      warnings,
    }
  }

  /**
   * Read the monthly bulk archive instead of the live feed. The newest files are
   * used, and the month they cover is reported so the lag is never hidden. The
   * requested window is NOT applied here: the archive is monthly, its records are
   * the honest contents of that month, and relevance by closing date is the
   * filter's job at display time.
   */
  async function readBulkArchive(
    signal: AbortSignal | undefined,
    warnings: string[],
  ): Promise<
    { ok: true; opportunities: Opportunity[]; issues: DiscoveryParseIssue[] } | DiscoveryFailure
  > {
    const listing = await requestJson(bulkArchiveListingUrl(), signal, 'application/json')
    if (!listing.ok) return listing
    const files = parseBulkArchiveListing(listing.value)
      .filter((file) => file.format === 'json')
      .sort((a, b) =>
        (bulkArchiveMonth(b.fileName) ?? '').localeCompare(bulkArchiveMonth(a.fileName) ?? ''),
      )
    if (files.length === 0) {
      return failure(
        'MALFORMED_BODY',
        'The eTenders bulk archive listed no monthly file this app could read.',
      )
    }
    const tried = files.slice(0, maxArchiveFiles)
    const opportunities: Opportunity[] = []
    const issues: DiscoveryParseIssue[] = []
    const seen = new Set<string>()
    const months: string[] = []
    for (const file of tried) {
      const body = await requestJson(file.url, signal, 'application/json')
      if (!body.ok) {
        warnings.push(`${file.monthName}: ${body.error.message}`)
        continue
      }
      const parsed = parseOcdsPage(body.value, 'bulk-archive')
      issues.push(...parsed.issues)
      months.push(bulkArchiveMonth(file.fileName) ?? file.monthName)
      for (const opportunity of parsed.opportunities) {
        if (seen.has(opportunity.ocid)) continue
        seen.add(opportunity.ocid)
        opportunities.push(opportunity)
      }
      if (opportunities.length > 0) break
    }
    if (opportunities.length === 0) {
      return failure(
        'MALFORMED_BODY',
        'The eTenders bulk archive carried nothing that could be read as a tender.',
      )
    }
    const covered = months.length > 0 ? months.join(', ') : 'an unknown month'
    warnings.push(
      `The live eTenders feed could not be reached, so these listings come from the monthly bulk archive for ${covered}, which lags the live feed.`,
    )
    return { ok: true, opportunities, issues }
  }

  function writeCache(
    envelope: DiscoveryCacheEnvelope,
  ): Promise<{ ok: true; envelope: DiscoveryCacheEnvelope } | DiscoveryFailure> {
    return writeCacheEnvelope(cachePath, envelope, maxCached, maxCacheBytes)
  }

  async function refreshCache(request: RefreshCacheRequest = {}): Promise<RefreshCacheResult> {
    const window = request.window ?? defaultDiscoveryWindow(now(), lookbackDays)
    if (!isValidWindow(window)) {
      return failure(
        'INVALID_REQUEST',
        'A discovery refresh needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
      )
    }
    const warnings: string[] = []
    const opportunities: Opportunity[] = []
    const seen = new Set<string>()
    let complete = true
    let failedWindows = 0
    let source: DiscoverySource = 'ocds-api'

    const pieces = splitWindow(window, DISCOVERY_MAX_WINDOW_DAYS)
    if (pieces.length > maxWindows) {
      complete = false
      warnings.push(
        `This window needs ${pieces.length} requests and the app makes at most ${maxWindows}, so only the most recent part was fetched.`,
      )
    }
    const wanted = pieces.slice(Math.max(0, pieces.length - maxWindows))

    for (const piece of wanted) {
      const result = await listOpportunities({ window: piece, signal: request.signal })
      if (!result.ok) {
        if (result.error.code === 'ABORTED') return result
        complete = false
        failedWindows += 1
        warnings.push(`${piece.from} to ${piece.to}: ${result.error.message}`)
        continue
      }
      if (result.truncated) complete = false
      warnings.push(...result.warnings)
      for (const opportunity of result.opportunities) {
        if (seen.has(opportunity.ocid)) continue
        seen.add(opportunity.ocid)
        opportunities.push(opportunity)
      }
    }

    // An empty result is only a failure when a window actually failed: a feed
    // that answered every window and had nothing in it is a real, if dull,
    // answer, and it is cached as one. A failure with nothing to show falls back
    // to the archive, or reports the failure rather than overwriting a good
    // cache with an empty one.
    if (opportunities.length === 0 && failedWindows > 0) {
      if (!archiveFallback) {
        return failure(
          'HTTP_STATUS',
          `Nothing could be read from the eTenders feed. ${warnings.join(' ')}`.trim(),
          { attempts: maxAttempts },
        )
      }
      const fallback = await readBulkArchive(request.signal, warnings)
      if (!fallback.ok) {
        if (fallback.error.code === 'ABORTED') return fallback
        warnings.push(fallback.error.message)
        return failure(
          'HTTP_STATUS',
          `Nothing could be read from the eTenders feed or its bulk archive. ${warnings.join(' ')}`.trim(),
          { attempts: maxAttempts },
        )
      }
      complete = false
      source = 'bulk-archive'
      for (const opportunity of fallback.opportunities) {
        if (seen.has(opportunity.ocid)) continue
        seen.add(opportunity.ocid)
        opportunities.push(opportunity)
      }
    }

    const envelope = createDiscoveryCache({
      fetchedAt: now().toISOString(),
      window,
      source,
      complete,
      opportunities,
      warnings,
    })
    const written = await writeCache(envelope)
    if (!written.ok) return written
    return { ok: true, cache: written.envelope, complete, warnings: written.envelope.warnings }
  }

  async function readCache(): Promise<ReadCacheResult> {
    let raw: string
    try {
      raw = await readFile(cachePath, 'utf8')
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'ENOENT') {
        return { ok: true, cache: null, stale: true, warnings: [] }
      }
      return failure('CACHE_READ', 'The saved tender list could not be read from disk.')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return failure('CACHE_READ', 'The saved tender list is damaged and could not be read.')
    }
    const cache = parseDiscoveryCache(parsed)
    if (cache === null) {
      return failure('CACHE_READ', 'The saved tender list is in a form this version cannot read.')
    }
    return { ok: true, cache, stale: isCacheStale(cache, now()), warnings: cache.warnings }
  }

  return { listOpportunities, fetchRelease, refreshCache, readCache }
}

/** Resolve a `Location` header against the URL that sent it, or null. */
function resolveRedirect(base: string, location: string): string | null {
  try {
    return new URL(location, base).toString()
  } catch {
    return null
  }
}

/**
 * Trim a list to the cache's bounds: newest publications first, then a byte
 * ceiling on the serialised envelope. Deterministic, and it says what it dropped.
 */
function trimForCache(
  envelope: DiscoveryCacheEnvelope,
  maxCount: number,
  maxBytes: number,
): DiscoveryCacheEnvelope {
  const ordered = [...envelope.opportunities].sort((a, b) => {
    const left = a.publishedAt ?? ''
    const right = b.publishedAt ?? ''
    if (left !== right) return right.localeCompare(left)
    return a.ocid.localeCompare(b.ocid)
  })
  let kept = ordered.slice(0, maxCount)
  const warnings = [...envelope.warnings]
  if (ordered.length > kept.length) {
    warnings.push(
      `Only the ${kept.length} most recently published listings were saved; ${ordered.length - kept.length} older ones were left out of the saved list.`,
    )
  }
  const build = (list: Opportunity[]): DiscoveryCacheEnvelope => ({
    ...envelope,
    opportunities: list,
    warnings,
  })
  let candidate = build(kept)
  let guard = 0
  while (JSON.stringify(candidate).length > maxBytes && kept.length > 1 && guard < 32) {
    guard += 1
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)))
    candidate = build(kept)
    if (
      !warnings.includes('The saved list was shortened to fit the space the app allows for it.')
    ) {
      warnings.push('The saved list was shortened to fit the space the app allows for it.')
    }
    candidate = build(kept)
  }
  return candidate
}

/**
 * Write the envelope atomically: a uniquely named temporary file, then a rename,
 * both under the cache directory, so a crash mid-write cannot leave a half-file
 * where the app expects a cache. Mode 0600, like the rest of the app's data.
 *
 * Returns the envelope that was actually written — trimmed to the cache's
 * bounds — so a caller never reports a list longer than the one it saved.
 */
async function writeCacheEnvelope(
  cachePath: string,
  envelope: DiscoveryCacheEnvelope,
  maxCount: number,
  maxBytes: number,
): Promise<{ ok: true; envelope: DiscoveryCacheEnvelope } | DiscoveryFailure> {
  const directory = cachePath.replace(/[/\\][^/\\]+$/, '')
  const trimmed = trimForCache(envelope, maxCount, maxBytes)
  try {
    await mkdir(directory, { recursive: true })
    const temporary = `${cachePath}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(trimmed), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporary, cachePath)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    return { ok: true, envelope: trimmed }
  } catch {
    return {
      ok: false,
      error: { code: 'CACHE_WRITE', message: 'The tender list could not be saved to disk.' },
    }
  }
}

/**
 * Re-exported so a caller can read the freshness bound, the file name and the
 * directory from one module without reaching into the core for the first two.
 */
export { DISCOVERY_CACHE_FILE_NAME, DISCOVERY_CACHE_MAX_AGE_MS }

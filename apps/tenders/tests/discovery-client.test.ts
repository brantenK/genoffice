// Tender discovery — the main-process client.
//
// Every test here runs against an INJECTED fetch: no test touches the network,
// and none waits on a real clock (the retry delay and the current time are both
// injected). What is being proved is the client's own safety story, one property
// per test — https and an exact host allow-list, a byte cap enforced while the
// body is read, bounded retries that never retry a refusal, a manual redirect
// walk, a bulk-archive fallback that is labelled as such, and a cache that
// survives a restart without ever being overwritten by a failed refresh.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDiscoveryClient,
  discoveryCacheDir,
  DISCOVERY_CACHE_FILE_NAME,
} from '../src/main/discovery-client'
import type {
  DiscoveryClient,
  DiscoveryFetch,
  DiscoveryFetchInit,
  DiscoveryHttpResponse,
} from '../src/main/discovery-client'
import { DISCOVERY_CACHE_MAX_AGE_MS } from '../src/shared/discovery'
import type { DiscoveryWindow } from '../src/shared/discovery'

const NOW = new Date('2026-09-24T09:00:00Z')
const WINDOW: DiscoveryWindow = { from: '2026-09-01', to: '2026-09-07' }
const API = 'https://ocds-api.etenders.gov.za/api/OCDSReleases'
const ARCHIVE_LISTING = 'https://data.etenders.gov.za/Home/GetFiles'

// ── the fake feed ────────────────────────────────────────────────────────────

interface RecordedCall {
  url: string
  accept: string | null
  redirect: string | null
}

interface FakeFeed {
  fetchImpl: DiscoveryFetch
  calls: RecordedCall[]
  /** Calls whose URL contains this substring. */
  count: (substring: string) => number
  urls: () => string[]
}

/**
 * A fetch double that records what it was asked for. `respond` is called per
 * request with the number of times that exact URL has been seen, which is what
 * lets a test say "500 on the first attempt, then the real page".
 */
function fakeFeed(
  respond: (call: {
    url: string
    index: number
    attemptForUrl: number
    signal?: AbortSignal
  }) => DiscoveryHttpResponse | Promise<DiscoveryHttpResponse>,
): FakeFeed {
  const calls: RecordedCall[] = []
  const fetchImpl: DiscoveryFetch = async (url, init) => {
    const attemptForUrl = calls.filter((call) => call.url === url).length + 1
    calls.push({ url, accept: init?.headers?.accept ?? null, redirect: init?.redirect ?? null })
    return respond({ url, index: calls.length, attemptForUrl, signal: init?.signal })
  }
  return {
    fetchImpl,
    calls,
    count: (substring) => calls.filter((call) => call.url.includes(substring)).length,
    urls: () => calls.map((call) => call.url),
  }
}

/** A buffered reply, with an optional declared length. */
function reply(options: {
  status?: number
  body?: string
  contentLength?: number
  location?: string
}): DiscoveryHttpResponse {
  const status = options.status ?? 200
  const headers: Record<string, string> = {}
  if (options.contentLength !== undefined) headers['content-length'] = String(options.contentLength)
  if (options.location !== undefined) headers.location = options.location
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: null,
    text: async () => options.body ?? '',
  }
}

function json(value: unknown, status = 200): DiscoveryHttpResponse {
  return reply({ status, body: JSON.stringify(value) })
}

/** A body that streams more bytes than any cap should allow. */
function streaming(
  body: string,
  options: { chunkSize?: number; contentLength?: number } = {},
): DiscoveryHttpResponse {
  const bytes = new TextEncoder().encode(body)
  const size = options.chunkSize ?? bytes.byteLength
  let offset = 0
  let cancelled = false
  const headers: Record<string, string> = {}
  if (options.contentLength !== undefined) headers['content-length'] = String(options.contentLength)
  return {
    status: 200,
    ok: true,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (cancelled || offset >= bytes.byteLength) return { done: true }
          const slice = bytes.slice(offset, Math.min(offset + size, bytes.byteLength))
          offset += slice.byteLength
          return { done: false, value: slice }
        },
        cancel: async () => {
          cancelled = true
          streamsCancelled.push(true)
        },
        releaseLock: () => undefined,
      }),
    },
  }
}

const streamsCancelled: boolean[] = []

/** A request that never answers, like a real fetch against a hung server. */
function hang(signal?: AbortSignal): Promise<DiscoveryHttpResponse> {
  return new Promise((_resolve, reject) => {
    if (!signal) return
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

// ── real payload fixtures (trimmed from the live feed) ───────────────────────

function release(ocid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ocid,
    id: `${ocid}-2026-09-07`,
    date: '2026-09-07T00:00:00Z',
    tag: ['compiled'],
    tender: {
      id: 'RFQ 19 OF 2026',
      title: `Tender ${ocid}`,
      status: 'active',
      mainProcurementCategory: 'goods',
      description: 'Supply and delivery of office furniture.',
      value: { amount: 0, currency: 'ZAR' },
      documents: [],
      tenderPeriod: { startDate: '2026-09-07T00:00:00Z', endDate: '2026-09-11T11:00:00Z' },
    },
    buyer: { id: '480', name: 'Nelson Mandela National Museum' },
    ...overrides,
  }
}

/** The API's lowercase wrapper. */
function apiPage(releases: unknown[], next?: string): Record<string, unknown> {
  return {
    uri: `${API}?PageNumber=1`,
    version: '1.1',
    releases,
    ...(next ? { links: { next } } : {}),
  }
}

/** The archive's PascalCase wrapper, and the DataTables listing beside it. */
function archivePage(releases: unknown[]): Record<string, unknown> {
  return { Uri: 'https://data.etenders.gov.za/', Version: '1.1', Releases: releases }
}

function archiveListing(fileNames: string[]): Record<string, unknown> {
  return {
    sEcho: '1',
    iTotalRecords: fileNames.length,
    aaData: fileNames.map((fileName) => ({
      monthName: fileName,
      downloadLink: `<a href='DownloadFile/?fileName=${fileName}'>JSON</a>`,
    })),
  }
}

// ── harness ──────────────────────────────────────────────────────────────────

let cacheDir: string

beforeEach(async () => {
  streamsCancelled.length = 0
  cacheDir = await mkdtemp(join(tmpdir(), 'tenders-discovery-'))
})

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
})

function client(
  feed: FakeFeed,
  overrides: Partial<Parameters<typeof createDiscoveryClient>[0]> = {},
): DiscoveryClient {
  return createDiscoveryClient({
    cacheDir,
    fetchImpl: feed.fetchImpl,
    now: () => NOW,
    sleep: async () => undefined,
    ...overrides,
  })
}

// ── listing ──────────────────────────────────────────────────────────────────

describe('listOpportunities', () => {
  it('asks the documented endpoint for a closed window and reads the page', async () => {
    const feed = fakeFeed(() => json(apiPage([release('ocds-a')])))
    const result = await client(feed).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.opportunities.map((entry) => entry.ocid)).toEqual(['ocds-a'])
    expect(result.pages).toBe(1)
    expect(result.failedPages).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.source).toBe('ocds-api')
    expect(result.warnings).toEqual([])

    const requested = new URL(feed.calls[0].url)
    expect(requested.origin + requested.pathname).toBe(API)
    expect(requested.searchParams.get('dateFrom')).toBe('2026-09-01')
    expect(requested.searchParams.get('dateTo')).toBe('2026-09-07')
    expect(requested.searchParams.get('PageNumber')).toBe('1')
    expect(feed.calls[0].accept).toBe('application/json')
    // Redirects are followed by the client, one validated hop at a time.
    expect(feed.calls[0].redirect).toBe('manual')
  })

  it('follows links.next to the end of the window, and keeps a repeat only once', async () => {
    const second = `${API}?PageNumber=2&PageSize=25&dateFrom=2026-09-01&dateTo=2026-09-07`
    const feed = fakeFeed(({ url }) =>
      url.includes('PageNumber=2')
        ? json(apiPage([release('ocds-b'), release('ocds-a')]))
        : json(apiPage([release('ocds-a')], second)),
    )
    const result = await client(feed).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pages).toBe(2)
    expect(result.opportunities.map((entry) => entry.ocid)).toEqual(['ocds-a', 'ocds-b'])
    expect(result.issues.some((issue) => issue.code === 'duplicate-ocid')).toBe(true)
  })

  it('refuses a window wider than the feed reliably answers, without asking', async () => {
    const feed = fakeFeed(() => json(apiPage([release('ocds-a')])))
    const result = await client(feed).listOpportunities({
      window: { from: '2026-08-01', to: '2026-09-24' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_REQUEST')
    expect(result.error.message).toContain('7 days')
    expect(feed.calls).toHaveLength(0)
  })

  it('refuses a window that is not two dates', async () => {
    const feed = fakeFeed(() => json(apiPage([])))
    const result = await client(feed).listOpportunities({
      window: { from: '01/09/2026', to: '2026-09-07' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST')
    expect(feed.calls).toHaveLength(0)
  })

  it('reports a page that fails after the first one, keeping what it did read', async () => {
    const second = `${API}?PageNumber=2`
    const feed = fakeFeed(({ url }) =>
      url.includes('PageNumber=2')
        ? reply({ status: 500, body: 'boom' })
        : json(apiPage([release('ocds-a')], second)),
    )
    const result = await client(feed, { maxAttempts: 1 }).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.opportunities.map((entry) => entry.ocid)).toEqual(['ocds-a'])
    expect(result.pages).toBe(1)
    expect(result.failedPages).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.warnings.join(' ')).toContain('may be missing tenders')
  })

  it('stops at the page cap and says the list may be incomplete', async () => {
    const feed = fakeFeed(({ index }) =>
      json(apiPage([release(`ocds-${index}`)], `${API}?PageNumber=${index + 1}`)),
    )
    const result = await client(feed, { maxPages: 3 }).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pages).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.warnings.join(' ')).toContain('more than 3 pages')
  })
})

// ── retries, timeouts and cancellation ───────────────────────────────────────

describe('retries and bounds', () => {
  it('retries a 500 and succeeds, waiting between attempts', async () => {
    const delays: number[] = []
    const feed = fakeFeed(({ attemptForUrl }) =>
      attemptForUrl === 1
        ? reply({ status: 500, body: 'boom' })
        : json(apiPage([release('ocds-a')])),
    )
    const result = await client(feed, {
      backoffBaseMs: 10,
      sleep: async (ms) => {
        delays.push(ms)
      },
    }).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.opportunities).toHaveLength(1)
    expect(feed.calls).toHaveLength(2)
    expect(delays).toEqual([10])
  })

  it('gives up after the attempt bound, with bounded backoff', async () => {
    const delays: number[] = []
    const feed = fakeFeed(() => reply({ status: 503, body: 'unavailable' }))
    const result = await client(feed, {
      backoffBaseMs: 10,
      maxBackoffMs: 15,
      maxAttempts: 4,
      sleep: async (ms) => {
        delays.push(ms)
      },
    }).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('HTTP_STATUS')
    expect(result.error.status).toBe(503)
    expect(result.error.attempts).toBe(4)
    expect(feed.calls).toHaveLength(4)
    expect(delays).toEqual([10, 15, 15])
  })

  it('does not retry a refusal', async () => {
    const feed = fakeFeed(() => reply({ status: 400, body: 'bad request' }))
    const result = await client(feed, { maxAttempts: 4 }).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.attempts).toBe(1)
    expect(feed.calls).toHaveLength(1)
  })

  it('times out a request that never answers, and retries it', async () => {
    const feed = fakeFeed(({ signal }) => hang(signal))
    const result = await client(feed, {
      requestTimeoutMs: 10,
      maxAttempts: 2,
      backoffBaseMs: 1,
    }).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('TIMEOUT')
    expect(result.error.attempts).toBe(2)
    expect(result.error.message).toContain('did not answer within')
    expect(feed.calls).toHaveLength(2)
  })

  it('reports a network failure without inventing a status', async () => {
    const feed = fakeFeed(() => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    const result = await client(feed, { maxAttempts: 2, backoffBaseMs: 1 }).listOpportunities({
      window: WINDOW,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NETWORK')
    expect(result.error.status).toBeUndefined()
  })

  it('honours the caller’s cancellation instead of hammering the feed', async () => {
    const feed = fakeFeed(() => json(apiPage([release('ocds-a')])))
    const controller = new AbortController()
    controller.abort()
    const result = await client(feed).listOpportunities({
      window: WINDOW,
      signal: controller.signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ABORTED')
    expect(feed.calls).toHaveLength(0)
  })
})

// ── the allow-list ───────────────────────────────────────────────────────────

describe('the host allow-list', () => {
  it('refuses to follow a next page on another host', async () => {
    const feed = fakeFeed(() =>
      json(apiPage([release('ocds-a')], 'https://evil.example/api/OCDSReleases')),
    )
    const result = await client(feed).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(result.warnings.join(' ')).toContain('not allowed to read')
    expect(feed.urls().every((url) => url.includes('etenders.gov.za'))).toBe(true)
  })

  it('refuses to follow a next page that is not https', async () => {
    const feed = fakeFeed(() =>
      json(apiPage([release('ocds-a')], 'http://ocds-api.etenders.gov.za/x')),
    )
    const result = await client(feed).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(feed.calls).toHaveLength(1)
  })

  it('refuses a redirect off the allow-list, and never requests the target', async () => {
    const feed = fakeFeed(() =>
      reply({ status: 302, location: 'https://ocds-api.etenders.gov.za.evil.example/x' }),
    )
    const result = await client(feed).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('BLOCKED_URL')
    expect(feed.urls().every((url) => !url.includes('evil.example'))).toBe(true)
  })

  it('follows a redirect that stays on an allowed host', async () => {
    const moved = `${API}?PageNumber=1&PageSize=25&dateFrom=2026-09-01&dateTo=2026-09-07&moved=1`
    const feed = fakeFeed(({ url }) =>
      url.includes('moved=1')
        ? json(apiPage([release('ocds-a')]))
        : reply({ status: 302, location: moved }),
    )
    const result = await client(feed).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.opportunities).toHaveLength(1)
    expect(feed.calls).toHaveLength(2)
    expect(feed.calls[1].url).toContain('moved=1')
  })

  it('keeps a release lookup on the Treasury host even for a hostile ocid', async () => {
    const feed = fakeFeed(() => json(release('ocds-a')))
    const result = await client(feed).fetchRelease('../../evil')
    expect(result.ok).toBe(true)
    const requested = new URL(feed.calls[0].url)
    expect(requested.host).toBe('ocds-api.etenders.gov.za')
    expect(requested.pathname).toBe('/api/OCDSReleases/release/..%2F..%2Fevil')
  })

  it('refuses an ocid that is not one, without asking', async () => {
    const feed = fakeFeed(() => json(release('ocds-a')))
    for (const ocid of ['', '   ', 'x'.repeat(129)]) {
      const result = await client(feed).fetchRelease(ocid)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST')
    }
    expect(feed.calls).toHaveLength(0)
  })
})

// ── the byte cap ─────────────────────────────────────────────────────────────

describe('the byte cap', () => {
  it('abandons a body that streams past the cap, and cancels the stream', async () => {
    const feed = fakeFeed(() => streaming('x'.repeat(4_000)))
    const result = await client(feed, { maxBytesPerResponse: 1_000 }).listOpportunities({
      window: WINDOW,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('RESPONSE_TOO_LARGE')
    // A refusal is not worth another attempt.
    expect(feed.calls).toHaveLength(1)
    expect(streamsCancelled).toEqual([true])
  })

  it('refuses a declared length over the cap without reading the body', async () => {
    const feed = fakeFeed(() => reply({ body: '{}', contentLength: 999_999 }))
    const result = await client(feed, { maxBytesPerResponse: 1_000 }).listOpportunities({
      window: WINDOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('RESPONSE_TOO_LARGE')
    expect(feed.calls).toHaveLength(1)
  })

  it('measures a buffered body it cannot stream', async () => {
    const feed = fakeFeed(() => reply({ body: 'x'.repeat(4_000) }))
    const result = await client(feed, { maxBytesPerResponse: 1_000 }).listOpportunities({
      window: WINDOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('RESPONSE_TOO_LARGE')
  })

  it('accepts a body inside the cap', async () => {
    const feed = fakeFeed(() => streaming(JSON.stringify(apiPage([release('ocds-a')]))))
    const result = await client(feed, { maxBytesPerResponse: 100_000 }).listOpportunities({
      window: WINDOW,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.opportunities).toHaveLength(1)
  })
})

// ── malformed bodies ─────────────────────────────────────────────────────────

describe('malformed bodies', () => {
  it('reports an HTML error page rather than failing with a parse error', async () => {
    const feed = fakeFeed(() => reply({ body: '<html><body>Server Error</body></html>' }))
    const result = await client(feed).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('MALFORMED_BODY')
    expect(result.error.message).toContain('not JSON')
  })

  it('reports JSON that carries no release', async () => {
    const feed = fakeFeed(() => json({ unexpected: true }))
    const result = await client(feed).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.opportunities).toEqual([])
    expect(result.warnings.join(' ')).toContain('nothing that could be read')
  })
})

// ── fetchRelease ─────────────────────────────────────────────────────────────

describe('fetchRelease', () => {
  it('reads one release', async () => {
    const feed = fakeFeed(() => json(release('ocds-9t57fa-169278')))
    const result = await client(feed).fetchRelease('ocds-9t57fa-169278')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.opportunity?.ocid).toBe('ocds-9t57fa-169278')
    expect(result.opportunity?.reviewState).toBe('unconfirmed')
    expect(result.warnings).toEqual([])
  })

  it('reports a missing release without retrying', async () => {
    const feed = fakeFeed(() => reply({ status: 404, body: 'not found' }))
    const result = await client(feed, { maxAttempts: 3 }).fetchRelease('ocds-gone')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.status).toBe(404)
    expect(result.error.attempts).toBe(1)
    expect(feed.calls).toHaveLength(1)
  })

  it('says so when the record is not a tender it can read', async () => {
    const feed = fakeFeed(() => json({ ocid: 'ocds-x', tender: {} }))
    const result = await client(feed).fetchRelease('ocds-x')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.opportunity).toBeNull()
    expect(result.warnings.join(' ')).toContain('did not come back as a tender')
  })
})

// ── refreshCache, and the bulk-archive fallback ──────────────────────────────

describe('refreshCache', () => {
  it('splits a wide window into the pieces the feed answers', async () => {
    const feed = fakeFeed(({ url }) =>
      json(apiPage([release(`ocds-${new URL(url).searchParams.get('dateFrom')}`)])),
    )
    const result = await client(feed).refreshCache({
      window: { from: '2026-09-01', to: '2026-09-14' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.complete).toBe(true)
    expect(result.cache.source).toBe('ocds-api')
    expect(result.cache.opportunities).toHaveLength(2)
    const froms = feed.urls().map((url) => new URL(url).searchParams.get('dateFrom'))
    expect(froms).toEqual(['2026-09-01', '2026-09-08'])
    const tos = feed.urls().map((url) => new URL(url).searchParams.get('dateTo'))
    expect(tos).toEqual(['2026-09-07', '2026-09-14'])
  })

  it('caps how many windows one refresh asks for, and says it did', async () => {
    const feed = fakeFeed(() => json(apiPage([release('ocds-a')])))
    const result = await client(feed, { maxWindowsPerRefresh: 1 }).refreshCache({
      window: { from: '2026-09-01', to: '2026-09-21' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.complete).toBe(false)
    expect(feed.calls).toHaveLength(1)
    expect(result.warnings.join(' ')).toContain('at most 1')
  })

  it('writes an empty cache when a working feed really has nothing in the window', async () => {
    const feed = fakeFeed(() => json(apiPage([])))
    const result = await client(feed).refreshCache({ window: WINDOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.complete).toBe(true)
    expect(result.cache.opportunities).toEqual([])
    const stored = JSON.parse(await readFile(join(cacheDir, DISCOVERY_CACHE_FILE_NAME), 'utf8'))
    expect(stored.opportunities).toEqual([])
  })

  it('falls back to the monthly bulk archive, and says which month it used', async () => {
    const feed = fakeFeed(({ url }) => {
      if (url.startsWith(ARCHIVE_LISTING))
        return json(archiveListing(['01072026.json', '01062026.json']))
      if (url.includes('01072026.json')) return json(archivePage([release('ocds-archive-1')]))
      return reply({ status: 500, body: 'boom' })
    })
    const result = await client(feed, { maxAttempts: 2, backoffBaseMs: 1 }).refreshCache({
      window: WINDOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.complete).toBe(false)
    expect(result.cache.source).toBe('bulk-archive')
    expect(result.cache.opportunities.map((entry) => entry.ocid)).toEqual(['ocds-archive-1'])
    expect(result.cache.opportunities[0].source).toBe('bulk-archive')
    expect(result.warnings.join(' ')).toContain('bulk archive for 2026-07')
    expect(result.warnings.join(' ')).toContain('lags the live feed')
    // The newest archive file was chosen, not the first one listed.
    expect(feed.count('01072026.json')).toBe(1)
    expect(feed.count('01062026.json')).toBe(0)
  })

  it('does not fall back when the caller turns the archive off, and saves nothing', async () => {
    const feed = fakeFeed(({ url }) =>
      url.startsWith(ARCHIVE_LISTING)
        ? json(archiveListing(['01072026.json']))
        : reply({ status: 500, body: 'boom' }),
    )
    const result = await client(feed, {
      maxAttempts: 1,
      bulkArchiveFallback: false,
    }).refreshCache({ window: WINDOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Nothing could be read')
    expect(feed.count('GetFiles')).toBe(0)
    // A failed refresh never replaces a good list with an empty one.
    const read = await client(feed).readCache()
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.cache).toBeNull()
  })

  it('fails honestly when neither the feed nor the archive answers, and keeps the old cache', async () => {
    const good = fakeFeed(() => json(apiPage([release('ocds-good')])))
    const first = await client(good).refreshCache({ window: WINDOW })
    expect(first.ok).toBe(true)

    const broken = fakeFeed(() => reply({ status: 500, body: 'boom' }))
    const result = await client(broken, { maxAttempts: 1 }).refreshCache({ window: WINDOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('HTTP_STATUS')
    expect(result.error.message).toContain('bulk archive')

    const cached = await client(broken).readCache()
    expect(cached.ok).toBe(true)
    if (!cached.ok) return
    expect(cached.cache?.opportunities.map((entry) => entry.ocid)).toEqual(['ocds-good'])
  })

  it('reports an archive listing that offers no usable file', async () => {
    const feed = fakeFeed(({ url }) =>
      url.startsWith(ARCHIVE_LISTING)
        ? json({
            aaData: [
              {
                monthName: 'July 2026',
                downloadLink: '<a href="https://evil.example/x.json">JSON</a>',
              },
            ],
          })
        : reply({ status: 500, body: 'boom' }),
    )
    const result = await client(feed, { maxAttempts: 1 }).refreshCache({ window: WINDOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('no monthly file')
  })

  it('refuses to refresh an unreadable window', async () => {
    const feed = fakeFeed(() => json(apiPage([])))
    const result = await client(feed).refreshCache({ window: { from: 'x', to: 'y' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST')
    expect(feed.calls).toHaveLength(0)
  })
})

// ── the cache on disk ────────────────────────────────────────────────────────

describe('the cache on disk', () => {
  it('round-trips a refresh through a restart, and goes stale on the app’s own clock', async () => {
    const feed = fakeFeed(() => json(apiPage([release('ocds-a')])))
    const written = await client(feed).refreshCache({ window: WINDOW })
    expect(written.ok).toBe(true)

    // A new client, a new process, the same directory: the list is still there.
    const restarted = client(fakeFeed(() => reply({ status: 500 })))
    const read = await restarted.readCache()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.cache?.opportunities.map((entry) => entry.ocid)).toEqual(['ocds-a'])
    expect(read.cache?.window).toEqual(WINDOW)
    expect(read.stale).toBe(false)

    const later = createDiscoveryClient({
      cacheDir,
      fetchImpl: feed.fetchImpl,
      now: () => new Date(NOW.getTime() + DISCOVERY_CACHE_MAX_AGE_MS + 1),
    })
    const stale = await later.readCache()
    expect(stale.ok).toBe(true)
    if (stale.ok) expect(stale.stale).toBe(true)
  })

  it('writes a cache with the version the core expects, and nothing secret', async () => {
    const feed = fakeFeed(() => json(apiPage([release('ocds-a')])))
    await client(feed).refreshCache({ window: WINDOW })
    const raw = await readFile(join(cacheDir, DISCOVERY_CACHE_FILE_NAME), 'utf8')
    const stored = JSON.parse(raw)
    expect(stored.version).toBe(1)
    expect(stored.fetchedAt).toBe(NOW.toISOString())
    expect(stored.complete).toBe(true)
    expect(raw.toLowerCase()).not.toContain('apikey')
    expect(raw.toLowerCase()).not.toContain('token')
  })

  it('reports no cache as an empty, stale answer rather than an error', async () => {
    const read = await client(fakeFeed(() => reply({ status: 500 }))).readCache()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.cache).toBeNull()
    expect(read.stale).toBe(true)
    expect(read.warnings).toEqual([])
  })

  it('reports a damaged cache instead of pretending there is none', async () => {
    await writeFile(join(cacheDir, DISCOVERY_CACHE_FILE_NAME), 'not json at all', 'utf8')
    const read = await client(fakeFeed(() => reply({ status: 500 }))).readCache()
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error.code).toBe('CACHE_READ')

    await writeFile(
      join(cacheDir, DISCOVERY_CACHE_FILE_NAME),
      JSON.stringify({ version: 99 }),
      'utf8',
    )
    const wrongVersion = await client(fakeFeed(() => reply({ status: 500 }))).readCache()
    expect(wrongVersion.ok).toBe(false)
    if (!wrongVersion.ok) expect(wrongVersion.error.code).toBe('CACHE_READ')
  })

  it('keeps the cache inside the space the app allows, and says what it left out', async () => {
    const feed = fakeFeed(() =>
      json(apiPage([release('ocds-a'), release('ocds-b'), release('ocds-c')])),
    )
    const result = await client(feed, { maxCachedOpportunities: 2 }).refreshCache({
      window: WINDOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cache.opportunities).toHaveLength(2)
    expect(result.warnings.join(' ')).toContain('2 most recently published')
    const stored = JSON.parse(await readFile(join(cacheDir, DISCOVERY_CACHE_FILE_NAME), 'utf8'))
    expect(stored.opportunities).toHaveLength(2)
  })

  it('writes nothing when the cache directory cannot be created', async () => {
    const feed = fakeFeed(() => json(apiPage([release('ocds-a')])))
    const unwritable = createDiscoveryClient({
      // A path under a file, not a directory: mkdir must fail.
      cacheDir: join(cacheDir, DISCOVERY_CACHE_FILE_NAME, 'nested'),
      fetchImpl: feed.fetchImpl,
      now: () => NOW,
      sleep: async () => undefined,
    })
    await writeFile(join(cacheDir, DISCOVERY_CACHE_FILE_NAME), 'x', 'utf8')
    const result = await unwritable.refreshCache({ window: WINDOW })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CACHE_WRITE')
  })
})

describe('discoveryCacheDir', () => {
  it('sits beside the store’s own tenders directory', () => {
    expect(discoveryCacheDir('/home/user/.config/Zanostack Tenders')).toBe(
      join('/home/user/.config/Zanostack Tenders', 'tenders', 'discovery'),
    )
    expect(DISCOVERY_CACHE_FILE_NAME).toBe('discovery-cache.json')
  })
})

// ── the default fetch ────────────────────────────────────────────────────────

describe('the default fetch', () => {
  it('uses globalThis.fetch when none is injected, and never a key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify(apiPage([release('ocds-a')])),
    } as unknown as Response)
    try {
      const result = await createDiscoveryClient({
        cacheDir,
        now: () => NOW,
        sleep: async () => undefined,
      }).listOpportunities({ window: WINDOW })
      expect(result.ok).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
      const [url, init] = spy.mock.calls[0]
      expect(String(url)).toContain('ocds-api.etenders.gov.za')
      expect(init?.redirect).toBe('manual')
      expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/key|token|secret/i)
    } finally {
      spy.mockRestore()
    }
  })
})

// ── the injected-fetch contract ──────────────────────────────────────────────

describe('the injected fetch contract', () => {
  it('is asked for exactly the URL, headers and redirect mode the client promises', async () => {
    const seen: { url: string; init: DiscoveryFetchInit | undefined }[] = []
    const fetchImpl: DiscoveryFetch = async (url, init) => {
      seen.push({ url, init })
      return json(apiPage([release('ocds-a')]))
    }
    const result = await createDiscoveryClient({
      cacheDir,
      fetchImpl,
      now: () => NOW,
      sleep: async () => undefined,
    }).listOpportunities({ window: WINDOW })
    expect(result.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].init?.headers).toEqual({ accept: 'application/json' })
    expect(seen[0].init?.signal).toBeInstanceOf(AbortSignal)
    expect(seen[0].init?.redirect).toBe('manual')
  })
})

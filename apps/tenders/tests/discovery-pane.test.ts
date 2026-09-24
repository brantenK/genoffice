// The "Find tenders" pane — the user-facing half of tender discovery.
//
// The pane is where a listing becomes reachable, and it is also where the whole
// feature can lie to a user: about how much of the market it saw, about a
// deadline the source never stated, and about whether a fetch failed or simply
// found nothing. So this file tests the pane's decisions rather than its markup
// — the app has no rendered-component harness by design (see
// `renderer-display-locale.test.ts`), and the rendered journey lives in
// `e2e/tenders-discovery.spec.ts` against the built shell.
//
// What is asserted as REAL BEHAVIOUR (executed here):
//
//  * the transport seam (`discoveryBridge`) and both load paths, including that
//    a refusal from the engine is surfaced with the engine's own words rather
//    than being turned into an empty list;
//  * every line a row prints about a listing: the closing countdown and the
//    flag that replaces it when the source stated no readable date, the value,
//    the province and how it was decided, and the relevance score with the
//    terms that produced it;
//  * "Add to workspace" end to end: a document served by a fake bridge is run
//    through the REAL intake (a real .docx, built here), and the tender that
//    lands is asserted to be a normal tender — the document's own metadata, the
//    review gate demanding a human decision on every field, and the listing's
//    provenance recorded on the record itself.
//
// What is asserted as a SOURCE GUARD (weaker, and marked where it appears): that
// the pane renders `describeCoverage()` rather than restating it, and that the
// page is wired into the sidebar. The coverage statement's own content is
// asserted as data, which is the part that can actually regress.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DISCOVERY_CACHE_MAX_AGE_MS,
  DISCOVERY_CACHE_VERSION,
  describeCoverage,
  scoreOpportunity,
  type DiscoveryCacheEnvelope,
  type DiscoveryFilter,
  type Opportunity,
} from '../src/shared/discovery'
import { INTAKE_CRITICAL_REVIEW_FIELDS, type CompanyProfile } from '../src/shared/types'
import type { ManagedFileRecord } from '../src/shared/tenders-persistence'
import { formatRandAmount } from '../src/shared/money'
import { useTendersStore } from '../src/renderer/src/store'
import { DOCX_MIME, readAiExtractionPreference } from '../src/renderer/src/components/TenderList'
import { DocxImportCancelledError } from '../src/renderer/src/intake/docx'
import {
  addFailureMessage,
  addOpportunityDocument,
  cacheStatusText,
  categoryLabel,
  closingDisplay,
  discoveryBridge,
  documentName,
  downloadFailureMessage,
  matchLabel,
  parseKeywordInput,
  provinceNote,
  provenanceNote,
  readSavedList,
  refreshSavedList,
  relevanceText,
  valueDisplay,
  type DiscoveryBridge,
} from '../src/renderer/src/components/pages/DiscoverPage'
/** Locate `apps/tenders/src/renderer/src` from either cwd (`-w` or repo root). */
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
const PANE = 'components/pages/DiscoverPage.tsx'

/** Source with comments removed, so a guard cannot be satisfied by prose. */
function codeText(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** Copy a user could read: tags and comments stripped, whitespace collapsed. */
function copyText(relativePath: string): string {
  return codeText(relativePath)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const AT = '2026-09-24T08:00:00.000Z'
const NOW = new Date(AT)

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const DOC_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const P = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`

/** A real (minimal) .docx carrying a cover block and two recognisable clauses. */
async function buildDocx(lines: string[]): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/document.xml',
    `${XML_DECL}<w:document ${DOC_NS}><w:body>${lines.map(P).join('')}` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>',
  )
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

/** The document the fake feed serves: its own title and reference, not the feed's. */
const DOCX_TITLE = 'E2E Discovered Bulk Water Pipeline Phase 3'
const DOCX_REFERENCE = 'DWS/RFP-2026/0099'
const DOCX_LINES = [
  'REQUEST FOR PROPOSALS',
  DOCX_TITLE,
  `Reference Number: ${DOCX_REFERENCE}`,
  'DEPARTMENT OF WATER AND SANITATION',
  'A valid SARS Tax Clearance Certificate or TCS PIN confirming tax compliance at bid closing.',
]

/** A listing the feed published. The title deliberately differs from the document's. */
function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    ocid: 'ocds-9t5lmn-2026-0001',
    releaseId: 'ocds-9t5lmn-2026-0001-01',
    title: 'SUPPLY OF WATER METERING EQUIPMENT',
    description: 'Supply and delivery of bulk water metering equipment in Gauteng.',
    buyer: 'City of Cape Town',
    reference: 'WC/2026/0001',
    status: 'active',
    category: 'goods',
    value: { amount: 850_000, currency: 'ZAR' },
    documents: [],
    refusedDocumentLinks: 0,
    province: 'Western Cape',
    provinceSource: 'buyer',
    publishedAt: '2026-09-20T00:00:00.000Z',
    closingRaw: '30 November 2026 at 11:00',
    closingAt: '2026-11-30T09:00:00.000Z',
    closingState: 'parsed',
    closingNote: null,
    tags: ['tender'],
    source: 'ocds-api',
    sourceUrl: 'https://ocds-api.etenders.gov.za/api/OCDSReleases/release/ocds-9t5lmn-2026-0001',
    warnings: [],
    provenance: 'discovery-feed',
    reviewState: 'unconfirmed',
    ...overrides,
  }
}

function cache(
  opportunities: Opportunity[],
  overrides: Partial<DiscoveryCacheEnvelope> = {},
): DiscoveryCacheEnvelope {
  return {
    version: DISCOVERY_CACHE_VERSION,
    fetchedAt: AT,
    window: { from: '2026-09-17', to: '2026-09-24' },
    source: 'ocds-api' as const,
    complete: true,
    opportunities,
    warnings: [],
    ...overrides,
  }
}

function company(): CompanyProfile {
  return {
    name: 'Cape Water Works',
    tradingName: 'Cape Water Works',
    registrationNumber: 'REG-1',
    vatNumber: 'VAT-1',
    taxPin: 'TAX-1',
    bbbeeLevel: 'Level 2',
    bbbeeBlackOwnership: '51%',
    csdSupplierNumber: 'CSD-1',
    founded: '2019',
    employees: '25',
    industry: 'Bulk water pipeline construction',
    description: 'Pipeline rehabilitation and metering.',
    address: 'Cape Town',
    phone: '+27 10 000 0000',
    email: 'test@example.test',
    website: 'https://example.test',
    directors: [],
    projects: [],
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

// ── the transport seam ───────────────────────────────────────────────────────

describe('the discovery bridge', () => {
  it('is absent in a build with no bridge, and says so instead of pretending', async () => {
    delete (window as unknown as Record<string, unknown>).tendersApi
    expect(discoveryBridge()).toBeNull()
    const read = await readSavedList(null)
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.error.message).toMatch(/not available in this build/i)
  })

  it('reaches the preload functions when they exist', async () => {
    const readCache = vi
      .fn()
      .mockResolvedValue({ ok: true, cache: null, stale: true, warnings: [] })
    const refresh = vi
      .fn()
      .mockResolvedValue({ ok: true, cache: cache([]), complete: true, warnings: [] })
    const downloadDocument = vi.fn()
    ;(window as unknown as Record<string, unknown>).tendersApi = {
      discoveryReadCache: readCache,
      discoveryRefresh: refresh,
      discoveryDownloadDocument: downloadDocument,
    }

    const bridge = discoveryBridge()
    expect(bridge).not.toBeNull()
    const read = await bridge!.readCache()
    expect(read.ok).toBe(true)
    expect(readCache).toHaveBeenCalledTimes(1)
  })
})

// ── the saved list, offline, and what a failure looks like ───────────────────

describe('reading the saved list', () => {
  it('answers from the cache with its age and warnings, with no network at all', async () => {
    const saved = cache([opportunity()])
    const bridge: DiscoveryBridge = {
      readCache: async () => ({
        ok: true,
        cache: saved,
        stale: false,
        warnings: ['one page failed'],
      }),
      refresh: async () => ({ ok: true, cache: saved, complete: true, warnings: [] }),
      downloadDocument: async () => ({ ok: false, error: { code: 'BLOCKED_URL', message: 'no' } }),
    }
    const result = await readSavedList(bridge)
    expect(result).toEqual({ ok: true, cache: saved, stale: false, warnings: ['one page failed'] })
  })

  it('surfaces the engine’s own refusal verbatim, never as an empty list', async () => {
    const message = 'The saved tender list is damaged and could not be read.'
    const bridge: DiscoveryBridge = {
      readCache: async () => ({ ok: false, error: { code: 'CACHE_READ', message } }),
      refresh: async () => ({ ok: false, error: { code: 'NETWORK', message: 'no' } }),
      downloadDocument: async () => ({ ok: false, error: { code: 'BLOCKED_URL', message: 'no' } }),
    }
    const result = await readSavedList(bridge)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('CACHE_READ')
    expect(result.error.message).toBe(message)
  })

  it('turns a rejected call into a failure with a reason, not an exception', async () => {
    const bridge: DiscoveryBridge = {
      readCache: async () => {
        throw new Error('IPC exploded')
      },
      refresh: async () => {
        throw new Error('IPC exploded')
      },
      downloadDocument: async () => {
        throw new Error('IPC exploded')
      },
    }
    const read = await readSavedList(bridge)
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.error.message).toContain('IPC exploded')
    const refreshed = await refreshSavedList(bridge)
    expect(refreshed.ok).toBe(false)
  })

  it('reports a partial fetch as partial rather than as a complete list', async () => {
    const partial = cache([opportunity()], { complete: false })
    const bridge: DiscoveryBridge = {
      readCache: async () => ({ ok: true, cache: partial, stale: true, warnings: [] }),
      refresh: async () => ({
        ok: true,
        cache: partial,
        complete: false,
        warnings: ['2026-09-17 to 2026-09-24: the feed did not answer.'],
      }),
      downloadDocument: async () => ({ ok: false, error: { code: 'BLOCKED_URL', message: 'no' } }),
    }
    const result = await refreshSavedList(bridge)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.complete).toBe(false)
    expect(result.warnings).toHaveLength(1)
    expect(cacheStatusText(partial, true)).toMatch(/did not finish, so it may be missing tenders/)
  })
})

// ── what a row says ──────────────────────────────────────────────────────────

describe('the closing line', () => {
  it('counts down to a closing date the source stated', () => {
    const display = closingDisplay(opportunity(), NOW)
    expect(display.state).toBe('parsed')
    expect(display.countdown).toMatch(/^closes in /)
    expect(display.raw).toBe('30 November 2026 at 11:00')
    expect(display.flag).toBeNull()
  })

  it('flags a listing whose source stated no closing date, and invents none', () => {
    const display = closingDisplay(
      opportunity({
        closingRaw: null,
        closingAt: null,
        closingState: 'missing',
        closingNote: 'The source stated no closing date for this tender.',
      }),
      NOW,
    )
    expect(display.state).toBe('missing')
    expect(display.countdown).toBe('')
    expect(display.formatted).toBe('')
    expect(display.flag).toBe('The source stated no closing date for this tender.')
  })

  it('flags an unreadable closing date and quotes what the source actually said', () => {
    const display = closingDisplay(
      opportunity({
        closingRaw: 'see the addendum',
        closingAt: null,
        closingState: 'unparseable',
        closingNote: null,
      }),
      NOW,
    )
    expect(display.state).toBe('unparseable')
    expect(display.countdown).toBe('')
    expect(display.flag).toContain('see the addendum')
    expect(display.flag).toMatch(/could not be read/)
  })

  it('flags a listing whose stated instant is unusable rather than counting it down', () => {
    // `closingState: 'parsed'` with an unreadable raw string: the display falls
    // back to the honest state instead of printing an empty countdown.
    const display = closingDisplay(
      opportunity({ closingRaw: 'not a date at all', closingAt: AT, closingState: 'parsed' }),
      NOW,
    )
    expect(display.state).toBe('unparseable')
    expect(display.countdown).toBe('')
    expect(display.flag).not.toBeNull()
  })
})

describe('the facts a row prints', () => {
  it('prints the source’s value, or says the source stated none', () => {
    expect(valueDisplay({ amount: 850_000, currency: 'ZAR' })).toBe(formatRandAmount(850_000))
    expect(valueDisplay({ amount: 850_000, currency: null })).toBe(formatRandAmount(850_000))
    expect(valueDisplay({ amount: 12_000, currency: 'USD' })).toBe('USD 12000')
    expect(valueDisplay(null)).toBe('No value stated by the source')
  })

  it('says how the province was decided, and says when it was not', () => {
    expect(provinceNote(opportunity())).toBe('read from the buyer’s name')
    expect(provinceNote(opportunity({ provinceSource: 'title' }))).toBe(
      'read from the tender title',
    )
    expect(provinceNote(opportunity({ province: null, provinceSource: null }))).toBe(
      'The source does not say where this tender is.',
    )
  })

  it('keeps a missing category missing instead of defaulting it', () => {
    expect(categoryLabel('goods')).toBe('Goods')
    expect(categoryLabel('works')).toBe('Works')
    expect(categoryLabel(null)).toBe('No category stated')
  })

  it('explains the relevance score with the terms that produced it', () => {
    const filter: DiscoveryFilter = {
      provinces: [],
      categories: [],
      keywords: ['water', 'metering', 'unrelated'],
      minScore: 0,
      minDaysFromNow: null,
      maxDaysFromNow: null,
      minValue: null,
      maxValue: null,
      includeClosed: false,
      includeUnknownClosing: true,
      requireKnownValue: false,
    }
    const scored = scoreOpportunity(opportunity(), filter)
    const text = relevanceText(scored)
    expect(text).toMatch(/^\d+% relevant — /)
    expect(text).toContain('2 of 3 company profile terms matched')
    expect(scored.matches.map(matchLabel)).toContain('“water” in the title')
    expect(scored.unmatched).toContain('unrelated')
    // With no terms set the pane says so rather than printing 0% relevance.
    expect(relevanceText(scoreOpportunity(opportunity(), { ...filter, keywords: [] }))).toMatch(
      /No relevance terms are set on the company profile/,
    )
  })

  it('reads the filter box without inventing terms', () => {
    expect(parseKeywordInput('water, pipeline ,, water\nmetering')).toEqual([
      'water',
      'pipeline',
      'metering',
    ])
    expect(parseKeywordInput('   ')).toEqual([])
  })
})

describe('the age line for the saved list', () => {
  it('names when it was fetched, and says whether it is stale', () => {
    const fresh = cacheStatusText(cache([opportunity()]), false)
    expect(fresh).toMatch(/^Saved /)
    expect(fresh).toMatch(/live eTenders feed/)
    expect(fresh).toMatch(
      new RegExp(
        `inside the ${Math.round(DISCOVERY_CACHE_MAX_AGE_MS / 3_600_000)}-hour freshness window`,
      ),
    )

    const stale = cacheStatusText(cache([opportunity()], { source: 'bulk-archive' }), true)
    expect(stale).toMatch(/monthly bulk archive/)
    expect(stale).toMatch(/older than the .* freshness window/)
  })

  it('survives an unreadable fetched-at stamp without printing a date', () => {
    expect(cacheStatusText(cache([], { fetchedAt: 'not-a-date' }), true)).toMatch(
      /at an unreadable time/,
    )
  })
})

// ── the honest failure lines ─────────────────────────────────────────────────

describe('failure copy', () => {
  it('shows the download refusal in the engine’s own words', () => {
    const message = 'Only tender documents on ocds-api.etenders.gov.za can be downloaded.'
    expect(downloadFailureMessage({ code: 'BLOCKED_URL', message })).toContain(message)
  })

  it('names an unsupported document instead of blaming the network', () => {
    expect(addFailureMessage(new Error('Unsupported document type.'))).toMatch(
      /reads PDF and Word \.docx documents/,
    )
    expect(addFailureMessage(new DocxImportCancelledError())).toMatch(/was cancelled/)
    expect(addFailureMessage(new Error('boom'))).toMatch(/damaged or password-protected/)
  })
})

// ── "Add to workspace" ───────────────────────────────────────────────────────

/** The fake feed's own document link, on the one host main allows. */
const DOCUMENT_URL = 'https://www.etenders.gov.za/Documents/e2e-discovered-rfp.docx'

function documentLink() {
  return {
    url: DOCUMENT_URL,
    title: 'e2e-discovered-rfp.docx',
    format: DOCX_MIME,
    documentType: 'tenderNotice',
  }
}

describe('adding a listed document to the workspace', () => {
  /** The store autosaves through this bridge; a mock keeps the run quiet. */
  let api: { saveDocument: ReturnType<typeof vi.fn>; saveStoreV2: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    api = {
      saveDocument: vi.fn(),
      saveStoreV2: vi.fn().mockResolvedValue({ ok: true, revision: 1 }),
    }
    ;(window as unknown as Record<string, unknown>).tendersApi = api
    useTendersStore.getState().addCompany(company())
  })

  it('runs the real intake, and the tender it lands is unconfirmed and reviewable', async () => {
    const bytes = await buildDocx(DOCX_LINES)
    const saveDocument = api.saveDocument
    const bridge: DiscoveryBridge = {
      readCache: async () => ({ ok: true, cache: null, stale: true, warnings: [] }),
      refresh: async () => ({ ok: true, cache: cache([]), complete: true, warnings: [] }),
      downloadDocument: async () => ({
        ok: true,
        record: {
          id: 'file-1',
          relativePath: 'documents/1789_e2e-discovered-rfp.docx',
          fileName: 'e2e-discovered-rfp.docx',
          mimeType: DOCX_MIME,
        } as unknown as ManagedFileRecord,
        storedPath: 'documents/1789_e2e-discovered-rfp.docx',
        fileName: 'e2e-discovered-rfp.docx',
        mimeType: DOCX_MIME,
        byteLength: bytes.byteLength,
        buffer: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      }),
    }

    const listing = opportunity()
    const result = await addOpportunityDocument(bridge, listing, documentLink())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)

    const state = useTendersStore.getState()
    const tender = state.tenders.find((candidate) => candidate.id === result.tenderId)
    expect(tender, 'the document must land as a tender').toBeTruthy()
    if (!tender) throw new Error('unreachable')

    // (1) The tender is built from the DOCUMENT, not from the listing's own
    // title: the feed's title is a label, the file is the tender.
    expect(tender.title).toBe(DOCX_TITLE)
    expect(tender.referenceNumber).toBe(DOCX_REFERENCE)
    expect(tender.title).not.toBe(listing.title)

    // (2) The downloaded managed file is adopted, not written a second time.
    expect(tender.fileUrl).toBe('documents/1789_e2e-discovered-rfp.docx')
    expect(
      saveDocument,
      'the intake must not re-save an already-stored document',
    ).not.toHaveBeenCalled()

    // (3) The compliance matrix was populated by the local engine.
    expect(tender.requirements.length).toBeGreaterThan(0)

    // (4) The review gate still demands a human decision on every field: a
    // discovered tender is machine-sourced, exactly like an AI suggestion, and
    // nothing automated may write `confirmed`.
    const review = state.tenderReviews[tender.id]
    expect(review, 'the review must be seeded').toBeTruthy()
    if (!review) throw new Error('unreachable')
    for (const key of INTAKE_CRITICAL_REVIEW_FIELDS) {
      expect(review.fields[key]?.state ?? 'unconfirmed', `${key} must be unconfirmed`).toBe(
        'unconfirmed',
      )
    }
    expect(Object.values(review.fields).every((field) => field!.state === 'unconfirmed')).toBe(true)
    expect(Object.values(review.requirements).every((entry) => entry.state === 'unreviewed')).toBe(
      true,
    )
    expect(JSON.stringify(review)).not.toContain('"suggestedBy":"ai"')

    // (5) The listing's provenance is recorded ON the tender (persisted with it
    // as `intakeVerification.conflicts`, and shown at the top of the review).
    expect(tender.intakeVerification?.conflicts).toContain(provenanceNote(listing))
    expect(provenanceNote(listing)).toContain(listing.ocid)
    expect(provenanceNote(listing)).toContain(listing.sourceUrl)
    expect(provenanceNote(listing)).toMatch(/machine-sourced and unverified/)
    expect(provenanceNote(listing)).toMatch(
      /Nothing on this tender is confirmed until you check it/,
    )

    // (6) The tender is activated, so the review gate is the next thing on
    // screen — the same landing an imported file gives.
    expect(state.activeTenderId).toBe(tender.id)
    expect(state.view).toBe('workspace')

    // (7) The AI pass is not started behind the user's back: it follows the same
    // remembered opt-in an import does (off unless they turned it on).
    expect(readAiExtractionPreference()).toBe(false)
  })

  it('creates no tender at all when the download is refused', async () => {
    const message = 'Only tender documents on ocds-api.etenders.gov.za can be downloaded.'
    const bridge: DiscoveryBridge = {
      readCache: async () => ({ ok: true, cache: null, stale: true, warnings: [] }),
      refresh: async () => ({ ok: true, cache: cache([]), complete: true, warnings: [] }),
      downloadDocument: async () => ({ ok: false, error: { code: 'BLOCKED_URL', message } }),
    }
    const result = await addOpportunityDocument(bridge, opportunity(), documentLink())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain(message)
    expect(useTendersStore.getState().tenders).toHaveLength(0)
  })

  it('creates no tender when the document is not one the intake can read', async () => {
    const bytes = new TextEncoder().encode('this is not a document at all')
    const bridge: DiscoveryBridge = {
      readCache: async () => ({ ok: true, cache: null, stale: true, warnings: [] }),
      refresh: async () => ({ ok: true, cache: cache([]), complete: true, warnings: [] }),
      downloadDocument: async () => ({
        ok: true,
        record: {} as unknown as ManagedFileRecord,
        storedPath: 'documents/not-a-document.bin',
        fileName: 'not-a-document.bin',
        mimeType: 'application/octet-stream',
        byteLength: bytes.byteLength,
        buffer: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      }),
    }
    const result = await addOpportunityDocument(bridge, opportunity(), documentLink())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toMatch(
      /reads PDF and Word \.docx documents|damaged or password-protected/,
    )
    expect(useTendersStore.getState().tenders).toHaveLength(0)
  })

  it('names a linked document from its own name, else from the link', () => {
    expect(documentName(documentLink())).toBe('e2e-discovered-rfp.docx')
    expect(
      documentName({ url: DOCUMENT_URL, title: 'Tender notice', format: null, documentType: null }),
    ).toBe('e2e-discovered-rfp.docx')
    expect(
      documentName({
        url: 'https://www.etenders.gov.za/a/b/c.pdf',
        title: null,
        format: null,
        documentType: null,
      }),
    ).toBe('c.pdf')
  })
})

// ── the coverage statement the pane must show ────────────────────────────────

describe('the coverage statement', () => {
  it('states the limits the pane exists to surface', () => {
    const coverage = describeCoverage()
    const text = [coverage.summary, ...coverage.points].join(' ')
    // Every one of these is a claim Treasury itself makes or this app verified;
    // if one is dropped, the pane can no longer show it.
    expect(text).toMatch(/public beta/i)
    expect(text).toMatch(
      /municipalities and state-owned enterprises appear only when they volunteer/i,
    )
    expect(text).toMatch(/accuracy is not guaranteed/i)
    expect(text).toMatch(/must not be used for critical decision making or legal purposes/i)
    expect(text).toMatch(/Nothing found here is confirmed/i)
    expect(coverage.badges.length).toBeGreaterThan(0)
    expect(coverage.sources.length).toBeGreaterThan(0)
  })
})

// ── source guards (weaker than the executed tests above) ─────────────────────

describe('the pane renders what the core says, rather than restating it', () => {
  it('renders describeCoverage() and every part of it', () => {
    const code = codeText(PANE)
    expect(code, 'the pane must call the core').toMatch(/describeCoverage\(\)/)
    expect(code, 'the summary must be rendered').toMatch(/coverage\.summary/)
    expect(code, 'the badges must be rendered').toMatch(/coverage\.badges\.map\(/)
    expect(code, 'every limit must be rendered').toMatch(/coverage\.points\.map\(/)
    expect(code, 'the sources must be rendered').toMatch(/coverage\.sources\.map\(/)
  })

  it('does not restate the coverage copy as its own prose', () => {
    // A guard with teeth: if the pane started spelling the limits out itself,
    // the statement it shows could drift from the one the core owns.
    const copy = copyText(PANE)
    for (const phrase of [
      'public beta',
      'accuracy is not guaranteed',
      'critical decision making',
      'volunteer their data',
      'PDDL',
    ]) {
      expect(copy, `the pane must not carry its own copy of “${phrase}”`).not.toMatch(
        new RegExp(phrase, 'i'),
      )
    }
  })

  it('uses the suite’s theme tokens and primitives, not raw palette colours', () => {
    const code = codeText(PANE)
    expect(code, 'the pane must use the shared primitives').toMatch(/from '\.\.\/ui'/)
    expect(code, 'a raw palette colour would not follow the light/dark theme').not.toMatch(
      /\b(?:text|bg|border)-(?:red|green|amber|slate|emerald|blue|violet|indigo)-\d{2,3}\b/,
    )
    expect(code, 'the pane is a labelled section, never a second <main>').not.toContain('<main')
  })
})

describe('the page is reachable from the sidebar', () => {
  it('is a nav item that renders the pane', () => {
    const app = codeText('components/App.tsx')
    expect(app).toContain("import { DiscoverPage } from './pages/DiscoverPage'")
    // The nav label deliberately avoids the word "Tenders": a second sidebar item
    // containing it would be ambiguous for a reader looking at two items that both
    // end in the word, and for every name-based locator in the e2e suite (a role
    // name matches case-insensitively as a substring).
    expect(app, 'the nav item must be labelled').toMatch(/page: DISCOVER_PAGE, label: 'Discover'/)
    expect(app, 'the page must render the pane').toMatch(
      /\{page === 'discover' && <DiscoverPage \/>\}/,
    )
  })
})

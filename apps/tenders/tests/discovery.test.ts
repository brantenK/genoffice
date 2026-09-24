// Tender discovery — the pure core.
//
// Every fixture here is trimmed from a REAL payload fetched first-hand on
// 2026-09-24, because the shape that matters is the one the feed actually sends,
// not the one its documentation describes. Two of those facts are load-bearing
// and are pinned below: the live API answers with LOWERCASE wrapper keys
// (`{ uri, version, releases, links }`) while the monthly bulk archive answers
// with PASCALCASE ones (`{ Uri, Version, Releases }`) for the same OCDS 1.1
// payload; and the archive states `value.amount: 0` for every release it
// publishes (849 of 849 in the July 2026 dump), which must never be read as a
// R 0 tender.
//
// The honesty rules this file guards are the product rules, not cosmetics:
// a missing closing date is flagged rather than invented, a stated zero is not a
// value, a refused document link is counted rather than opened, a province is
// only ever inferred from a place name the source actually wrote, and nothing
// here can produce a record a human has not confirmed.
import { describe, expect, it } from 'vitest'
import {
  bulkArchiveMonth,
  bulkArchiveUrl,
  bulkArchiveListingUrl,
  civilDate,
  createDiscoveryCache,
  DEFAULT_DISCOVERY_FILTER,
  defaultDiscoveryWindow,
  deriveDiscoveryFilter,
  describeCoverage,
  DISCOVERY_CACHE_VERSION,
  DISCOVERY_MAX_WINDOW_DAYS,
  DISCOVERY_PROVENANCE,
  DISCOVERY_REVIEW_STATE,
  exclusionReason,
  filterOpportunities,
  isAllowedDiscoveryUrl,
  isCacheStale,
  isValidWindow,
  keywordsFromText,
  normaliseOpportunity,
  normaliseProvince,
  ocdsReleaseUrl,
  ocdsReleasesUrl,
  parseBulkArchiveListing,
  parseDiscoveryCache,
  parseOcdsPage,
  parseOcdsRelease,
  provinceFromText,
  rankOpportunities,
  SA_PROVINCES,
  scoreOpportunity,
  SCORE_FIELD_WEIGHTS,
  splitWindow,
  windowDays,
} from '../src/shared/discovery'
import type { DiscoveryCacheEnvelope, DiscoveryFilter, Opportunity } from '../src/shared/discovery'

/** A fixed clock. Nothing in this module reads the real one. */
const NOW = new Date('2026-09-24T09:00:00Z')

// ── fixtures trimmed from the live feed ──────────────────────────────────────

/** The live API's release, as fetched for the window 2026-09-01..2026-09-07. */
function apiRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ocid: 'ocds-9t57fa-169278',
    id: 'ocds-9t57fa-169278-2026-09-07',
    date: '2026-09-07T00:00:00Z',
    tag: ['compiled'],
    initiationType: 'tender',
    tender: {
      id: 'RFQ 19 OF 2026',
      title: 'RFQ 19 OF 2026',
      status: 'active',
      mainProcurementCategory: 'goods',
      description: 'Supply and delivery of office furniture.',
      value: { amount: 0, currency: 'ZAR' },
      documents: [
        {
          id: '5e9cabff-694e-452d-a201-b9cdee59dfc1',
          documentType: 'basic',
          title: 'application for procurement support officer.pdf',
          url: 'https://www.etenders.gov.za/home/Download?blobName=5e9cabff.pdf',
          format: 'pdf',
          language: 'en',
        },
      ],
      tenderPeriod: { startDate: '2026-09-07T00:00:00Z', endDate: '2026-09-11T11:00:00Z' },
    },
    buyer: { id: '480', name: 'Nelson Mandela National Museum' },
    language: 'en',
    ...overrides,
  }
}

/** The live API's package wrapper: lowercase keys, `links.next` for the walk. */
function apiPage(releases: unknown[], next?: string): Record<string, unknown> {
  return {
    uri: 'https://ocds-api.etenders.gov.za/api/OCDSReleases?PageNumber=1&PageSize=2',
    version: '1.1',
    publishedDate: '2026-09-24T12:47:55Z',
    publisher: { name: 'National Treasury (South Africa)', uri: 'https://data.etenders.gov.za/' },
    license: 'https://opendatacommons.org/licenses/pddl/1-0/',
    releases,
    ...(next ? { links: { next } } : {}),
  }
}

/**
 * A release from the July 2026 bulk archive, whose wrapper keys are PascalCase.
 * Its buyer names its own province, its value is the archive's placeholder zero,
 * and its status is `complete` — all three are real and all three are pinned.
 */
function archiveRelease(): Record<string, unknown> {
  return {
    ocid: 'ocds-9t57fa-163682',
    id: 'ocds-9t57fa-163682-2026-07-28',
    date: '2026-07-28T00:00:00Z',
    tag: ['compiled'],
    tender: {
      id: 'LEDA/SEC/2026/27-4A',
      title: 'LEDA/SEC/2026/27-4A',
      status: 'complete',
      mainProcurementCategory: 'services',
      description: 'Security services for the agency offices.',
      value: { amount: 0, currency: 'ZAR' },
      documents: [
        {
          id: 'cf56b340-6a6b-46cf-9214-3fe9a76dd772',
          documentType: 'basic',
          title: 'BID DOCUMENT SECURITY SERVICES 2026 (19 AUGUST 2026).pdf',
          url: 'https://www.etenders.gov.za/home/Download?blobName=cf56b340.pdf&downloadedFileName=BID%20DOCUMENT.pdf',
          format: 'pdf',
        },
      ],
      tenderPeriod: { startDate: '2026-07-28T00:00:00Z', endDate: '2026-08-19T11:00:00Z' },
    },
    buyer: { id: '361', name: 'Limpopo - Economic Development Agency' },
  }
}

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const base = normaliseOpportunity(apiRelease())
  if (base === null) throw new Error('fixture did not normalise')
  return { ...base, ...overrides }
}

/** The API release with fields replaced inside its `tender` object. */
function withTender(overrides: Record<string, unknown>): Record<string, unknown> {
  const base = apiRelease()
  return apiRelease({ tender: { ...(base.tender as Record<string, unknown>), ...overrides } })
}

function filter(overrides: Partial<DiscoveryFilter> = {}): DiscoveryFilter {
  return { ...DEFAULT_DISCOVERY_FILTER, ...overrides }
}

// ── the payload shapes ───────────────────────────────────────────────────────

describe('parseOcdsPage — every shape the feed sends', () => {
  it('reads the live API’s lowercase package wrapper and its next-page link', () => {
    const next = 'https://ocds-api.etenders.gov.za/api/OCDSReleases?PageNumber=2&PageSize=2'
    const page = parseOcdsPage(apiPage([apiRelease()], next))
    expect(page.shape).toBe('package')
    expect(page.opportunities).toHaveLength(1)
    expect(page.opportunities[0].ocid).toBe('ocds-9t57fa-169278')
    expect(page.issues).toEqual([])
    expect(page.next).toBe(next)
  })

  it('reads the bulk archive’s PascalCase package wrapper for the same payload', () => {
    const archive = {
      Uri: 'https://data.etenders.gov.za/',
      Version: '1.1',
      PublishedDate: '2026-08-01T00:00:00Z',
      Publisher: { Name: 'National Treasury (South Africa)' },
      License: 'https://opendatacommons.org/licenses/pddl/1-0/',
      Releases: [archiveRelease()],
      PageNumber: 0,
      PageSize: 0,
      TotalRecords: 0,
      TotalPages: 0,
      Links: {},
    }
    const page = parseOcdsPage(archive, 'bulk-archive')
    expect(page.shape).toBe('package')
    expect(page.opportunities).toHaveLength(1)
    expect(page.opportunities[0].source).toBe('bulk-archive')
    expect(page.opportunities[0].title).toBe('LEDA/SEC/2026/27-4A')
  })

  it('reads a bare releases array', () => {
    const page = parseOcdsPage([apiRelease()])
    expect(page.shape).toBe('releases-array')
    expect(page.opportunities).toHaveLength(1)
  })

  it('reads a generic `data` envelope, because a wrapper key is not guaranteed', () => {
    const page = parseOcdsPage({ data: [apiRelease()] })
    expect(page.shape).toBe('package')
    expect(page.opportunities).toHaveLength(1)
  })

  it('reads a single release on its own — the /release/{ocid} answer', () => {
    const page = parseOcdsPage(apiRelease())
    expect(page.shape).toBe('single-release')
    expect(page.opportunities).toHaveLength(1)
  })

  it('never throws on junk, and says what it could not read', () => {
    for (const junk of [null, undefined, 42, 'not json', true, {}, { releases: 'nope' }]) {
      const page = parseOcdsPage(junk)
      expect(page.opportunities).toEqual([])
      expect(page.shape).toBe('unusable')
      expect(page.issues).toHaveLength(1)
      expect(page.issues[0].code).toBe('not-an-object')
      expect(page.issues[0].detail.length).toBeGreaterThan(10)
    }
  })

  it('never throws on a truncated payload', () => {
    expect(() => parseOcdsPage('{"releases": [{"ocid": "a", "tender": {"tit')).not.toThrow()
    expect(parseOcdsPage('{"releases": [').opportunities).toEqual([])
  })

  it('drops records that cannot be listed, with a reason and a path, and keeps the rest', () => {
    const page = parseOcdsPage(
      apiPage([
        apiRelease(),
        null,
        { tender: { title: 'no ocid here' } },
        { ocid: 'ocds-x-1', tender: {} },
        { ocid: 'ocds-x-2', tender: { title: 12345 } },
        apiRelease({ ocid: 'ocds-x-3' }),
      ]),
    )
    expect(page.opportunities.map((entry) => entry.ocid)).toEqual([
      'ocds-9t57fa-169278',
      'ocds-x-3',
    ])
    expect(page.issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['releases[1]', 'not-an-object'],
      ['releases[2]', 'missing-ocid'],
      ['releases[3]', 'missing-title'],
      ['releases[4]', 'missing-title'],
    ])
    for (const issue of page.issues) expect(issue.detail.length).toBeGreaterThan(10)
  })

  it('keeps a repeated ocid once and reports the repeat instead of hiding it', () => {
    const page = parseOcdsPage(apiPage([apiRelease(), apiRelease()]))
    expect(page.opportunities).toHaveLength(1)
    expect(page.issues).toHaveLength(1)
    expect(page.issues[0].code).toBe('duplicate-ocid')
  })

  it('tolerates a whitespace-padded ocid but refuses an unusable one', () => {
    const page = parseOcdsPage(apiPage([apiRelease({ ocid: '  ocds-9t57fa-169278  ' })]))
    expect(page.opportunities[0].ocid).toBe('ocds-9t57fa-169278')
    expect(parseOcdsPage(apiPage([apiRelease({ ocid: '   ' })])).opportunities).toEqual([])
    expect(parseOcdsPage(apiPage([apiRelease({ ocid: 'x'.repeat(200) })])).issues[0].code).toBe(
      'missing-ocid',
    )
  })
})

describe('parseOcdsRelease — the single-record lookup', () => {
  it('takes the first usable record out of any wrapper', () => {
    expect(parseOcdsRelease(apiRelease()).opportunity?.ocid).toBe('ocds-9t57fa-169278')
    expect(parseOcdsRelease(apiPage([apiRelease()])).opportunity?.ocid).toBe('ocds-9t57fa-169278')
    expect(parseOcdsRelease([apiRelease()]).opportunity?.ocid).toBe('ocds-9t57fa-169278')
  })

  it('returns null with a reason rather than throwing', () => {
    const result = parseOcdsRelease({ ocid: 'ocds-x', tender: {} })
    expect(result.opportunity).toBeNull()
    expect(result.issues[0].code).toBe('missing-title')
    expect(parseOcdsRelease('nope').opportunity).toBeNull()
  })
})

// ── the normalised record ────────────────────────────────────────────────────

describe('normaliseOpportunity — mapping, honestly', () => {
  it('maps the fields a tender record needs', () => {
    const entry = opportunity()
    expect(entry).toMatchObject({
      ocid: 'ocds-9t57fa-169278',
      releaseId: 'ocds-9t57fa-169278-2026-09-07',
      title: 'RFQ 19 OF 2026',
      reference: 'RFQ 19 OF 2026',
      status: 'active',
      category: 'goods',
      buyer: 'Nelson Mandela National Museum',
      publishedAt: '2026-09-07T00:00:00.000Z',
      closingState: 'parsed',
      closingAt: '2026-09-11T11:00:00.000Z',
      closingRaw: '2026-09-11T11:00:00Z',
      tags: ['compiled'],
      source: 'ocds-api',
      provenance: DISCOVERY_PROVENANCE,
      reviewState: DISCOVERY_REVIEW_STATE,
    })
    expect(entry.sourceUrl).toBe(
      'https://ocds-api.etenders.gov.za/api/OCDSReleases/release/ocds-9t57fa-169278',
    )
    expect(entry.documents).toEqual([
      {
        url: 'https://www.etenders.gov.za/home/Download?blobName=5e9cabff.pdf',
        title: 'application for procurement support officer.pdf',
        format: 'pdf',
        documentType: 'basic',
      },
    ])
  })

  it('carries machine provenance and the one review state a machine may write', () => {
    const entry = opportunity()
    expect(entry.provenance).toBe('discovery-feed')
    expect(entry.reviewState).toBe('unconfirmed')
    expect(DISCOVERY_REVIEW_STATE).toBe('unconfirmed')
  })

  it('reads the archive’s buyer province without inventing one', () => {
    const entry = normaliseOpportunity(archiveRelease(), 'bulk-archive')
    expect(entry?.province).toBe('Limpopo')
    expect(entry?.provinceSource).toBe('buyer')
    expect(entry?.category).toBe('services')
    expect(entry?.status).toBe('complete')
    expect(entry?.documents).toHaveLength(1)
    expect(entry?.source).toBe('bulk-archive')
  })

  it('records a stated zero as no value, because that is what the feed means', () => {
    const entry = opportunity()
    expect(entry.value).toBeNull()
    expect(entry.warnings.join(' ')).toContain('no value stated')
  })

  it('reads a stated amount, and a string amount through the suite’s rand parser', () => {
    expect(
      normaliseOpportunity(withTender({ value: { amount: 850000, currency: 'ZAR' } }))?.value,
    ).toEqual({
      amount: 850000,
      currency: 'ZAR',
    })
    expect(
      normaliseOpportunity(withTender({ value: { amount: 'R 1 200 000,00' } }))?.value,
    ).toEqual({
      amount: 1200000,
      currency: null,
    })
  })

  it('refuses an unreadable amount rather than guessing one', () => {
    const parsed = normaliseOpportunity(withTender({ value: { amount: 'about a million' } }))
    expect(parsed?.value).toBeNull()
    expect(parsed?.warnings.join(' ')).toContain('could not be read as an amount')
  })

  it('treats an empty procurement category as unknown, not as a category', () => {
    expect(normaliseOpportunity(withTender({ mainProcurementCategory: '' }))?.category).toBeNull()
  })

  it('refuses a document link that is not http(s), and counts it', () => {
    const parsed = normaliseOpportunity(
      withTender({
        documents: [
          { url: 'javascript:alert(1)', title: 'not a document' },
          { url: 'file:///C:/secrets.pdf' },
          { title: 'no url at all' },
          { url: 'https://www.etenders.gov.za/home/Download?blobName=ok.pdf' },
        ],
      }),
    )
    expect(parsed?.documents.map((document) => document.url)).toEqual([
      'https://www.etenders.gov.za/home/Download?blobName=ok.pdf',
    ])
    expect(parsed?.refusedDocumentLinks).toBe(3)
    expect(parsed?.warnings.join(' ')).toContain('3 document links')
  })

  it('caps what one record can carry', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      url: `https://www.etenders.gov.za/home/Download?blobName=${index}.pdf`,
    }))
    const parsed = normaliseOpportunity(withTender({ documents: many }))
    expect(parsed?.documents).toHaveLength(50)
    expect(parsed?.refusedDocumentLinks).toBe(30)
  })

  it('drops the record rather than listing something with no title or no ocid', () => {
    expect(normaliseOpportunity(null)).toBeNull()
    expect(normaliseOpportunity('a string')).toBeNull()
    expect(normaliseOpportunity({ tender: { title: 'orphan' } })).toBeNull()
    expect(normaliseOpportunity({ ocid: 'ocds-x', tender: { title: '   ' } })).toBeNull()
  })

  it('only accepts an exact instant for a publication date', () => {
    const withoutOffset = normaliseOpportunity(apiRelease({ date: '2026-09-07T00:00:00' }))
    expect(withoutOffset?.publishedAt).toBeNull()
    expect(normaliseOpportunity(apiRelease({ date: 'nonsense' }))?.publishedAt).toBeNull()
  })
})

describe('closing dates — flagged, never invented', () => {
  it('keeps an opportunity with no closing date, and says so', () => {
    const parsed = normaliseOpportunity(withTender({ tenderPeriod: {} }))
    expect(parsed).not.toBeNull()
    expect(parsed?.closingState).toBe('missing')
    expect(parsed?.closingAt).toBeNull()
    expect(parsed?.closingRaw).toBeNull()
    expect(parsed?.closingNote).toContain('no closing date')
  })

  it('keeps the raw string and refuses to claim an instant it cannot read', () => {
    for (const raw of ['TBC', '2026-13-45', 'soon', '30 February 2026', '2026-11-30T11:00:00']) {
      const parsed = normaliseOpportunity(withTender({ tenderPeriod: { endDate: raw } }))
      expect(parsed?.closingRaw).toBe(raw)
      expect(parsed?.closingAt).toBeNull()
      expect(parsed?.closingState).toBe('unparseable')
      expect(parsed?.closingNote).toContain('could not be read')
    }
  })

  it('reads a SAST civil closing as the instant the deadline actually passes', () => {
    const parsed = normaliseOpportunity(
      withTender({ tenderPeriod: { endDate: '30 November 2026 at 11:00' } }),
    )
    expect(parsed?.closingAt).toBe('2026-11-30T09:00:00.000Z')
  })

  it('reads an RFC 3339 closing with an offset exactly as stated', () => {
    const parsed = normaliseOpportunity(
      withTender({ tenderPeriod: { endDate: '2026-11-30T11:00:00+02:00' } }),
    )
    expect(parsed?.closingAt).toBe('2026-11-30T09:00:00.000Z')
  })
})

// ── provinces ────────────────────────────────────────────────────────────────

describe('province inference', () => {
  it('reads a province name, a metro that sits inside one, and nothing else', () => {
    expect(provinceFromText('Limpopo - Economic Development Agency')).toBe('Limpopo')
    expect(provinceFromText('City of Cape Town')).toBe('Western Cape')
    expect(provinceFromText('Nelson Mandela Bay Municipality')).toBe('Eastern Cape')
    expect(provinceFromText('Nelson Mandela National Museum')).toBeNull()
    expect(provinceFromText('Cape')).toBeNull()
    expect(provinceFromText('')).toBeNull()
    expect(provinceFromText(null)).toBeNull()
  })

  it('prefers the longest place name it finds', () => {
    expect(provinceFromText('City of Cape Town, Western Cape')).toBe('Western Cape')
  })

  it('canonicalises a province name or code', () => {
    expect(normaliseProvince('western cape')).toBe('Western Cape')
    expect(normaliseProvince('WC')).toBe('Western Cape')
    expect(normaliseProvince('KZN')).toBe('KwaZulu-Natal')
    expect(normaliseProvince('Atlantis')).toBeNull()
    for (const province of SA_PROVINCES) expect(normaliseProvince(province)).toBe(province)
  })
})

// ── the filter derived from the company profile ──────────────────────────────

describe('deriveDiscoveryFilter', () => {
  it('takes the province from the company address and terms from industry and description', () => {
    const derived = deriveDiscoveryFilter({
      industry: 'Solar PV installation',
      description: 'We install rooftop solar panels for commercial clients.',
      address: '12 Long Street, Cape Town',
    })
    expect(derived.provinces).toEqual(['Western Cape'])
    expect(derived.keywords).toContain('solar')
    expect(derived.keywords).toContain('pv')
    expect(derived.keywords).toContain('installation')
    expect(derived.keywords).toContain('rooftop')
    expect(derived.keywords).not.toContain('we')
    expect(derived.keywords).not.toContain('for')
    expect(derived.keywords).toEqual([...derived.keywords].sort())
  })

  it('narrows nothing else — a profile never hides work by guesswork', () => {
    const derived = deriveDiscoveryFilter({
      industry: 'Construction',
      description: '',
      address: '',
    })
    expect(derived.provinces).toEqual([])
    expect(derived.minScore).toBe(0)
    expect(derived.categories).toEqual([])
    expect(derived.includeUnknownClosing).toBe(true)
    expect(derived.includeClosed).toBe(false)
    expect(derived.requireKnownValue).toBe(false)
  })

  it('derives no terms from a description that is only function words', () => {
    expect(keywordsFromText('We are a company that does things')).not.toContain('we')
    expect(keywordsFromText('')).toEqual([])
    expect(keywordsFromText(null)).toEqual([])
  })

  it('caps the term list deterministically', () => {
    const many = Array.from({ length: 60 }, (_, index) => `sectorword${index}xx`).join(' ')
    const terms = keywordsFromText(many)
    expect(terms).toHaveLength(24)
    expect(terms).toEqual([...terms].sort())
  })
})

// ── scoring, and its explanation ─────────────────────────────────────────────

describe('scoreOpportunity — transparent, inspectable', () => {
  const terms = filter({ keywords: ['solar', 'installation', 'wind'] })

  it('reports which term matched which field, and which matched nothing', () => {
    const entry = opportunity({
      title: 'Installation of solar panels',
      description: 'Rooftop solar work for a clinic.',
      category: 'goods',
    })
    const score = scoreOpportunity(entry, terms)
    expect(score.matches).toEqual([
      { term: 'solar', field: 'title', weight: SCORE_FIELD_WEIGHTS.title },
      { term: 'installation', field: 'title', weight: SCORE_FIELD_WEIGHTS.title },
    ])
    expect(score.unmatched).toEqual(['wind'])
    expect(score.earned).toBe(2)
    expect(score.available).toBe(3)
    expect(score.score).toBeCloseTo(2 / 3)
    expect(score.explanation).toContain('2 of 3 company profile terms matched')
    expect(score.explanation).toContain('"solar" in the title')
  })

  it('weighs a title match above a category, buyer or description match', () => {
    const one = ['furniture']
    const inTitle = scoreOpportunity(
      opportunity({ title: 'Office furniture', description: '' }),
      filter({ keywords: one }),
    )
    const inCategory = scoreOpportunity(
      opportunity({ title: 'X', category: 'furniture' }),
      filter({ keywords: one }),
    )
    const inBuyer = scoreOpportunity(
      opportunity({ title: 'X', buyer: 'Furniture Board' }),
      filter({ keywords: one }),
    )
    const inDescription = scoreOpportunity(
      opportunity({ title: 'X', description: 'Office furniture supply' }),
      filter({ keywords: one }),
    )
    expect(inTitle.score).toBe(1)
    expect(inCategory.score).toBe(SCORE_FIELD_WEIGHTS.category)
    expect(inBuyer.score).toBe(SCORE_FIELD_WEIGHTS.buyer)
    expect(inDescription.score).toBe(SCORE_FIELD_WEIGHTS.description)
    expect(inTitle.score).toBeGreaterThan(inCategory.score)
    expect(inCategory.score).toBeGreaterThan(inBuyer.score)
    expect(inBuyer.score).toBeGreaterThan(inDescription.score)
  })

  it('matches whole words only, so a short term cannot match by accident', () => {
    const score = scoreOpportunity(
      opportunity({ title: 'Item 4: stationery', description: '' }),
      filter({ keywords: ['it'] }),
    )
    expect(score.matches).toEqual([])
    expect(score.score).toBe(0)
  })

  it('counts a term once, in its strongest field', () => {
    const score = scoreOpportunity(
      opportunity({ title: 'Solar', description: 'Solar solar solar', category: 'goods' }),
      filter({ keywords: ['solar'] }),
    )
    expect(score.matches).toHaveLength(1)
    expect(score.earned).toBe(1)
    expect(score.score).toBe(1)
  })

  it('says plainly when nothing has been scored against a profile', () => {
    const score = scoreOpportunity(opportunity(), filter())
    expect(score.score).toBe(0)
    expect(score.available).toBe(0)
    expect(score.explanation).toContain('No relevance terms')
  })

  it('explains a zero rather than leaving it bare', () => {
    const score = scoreOpportunity(opportunity({ title: 'Nothing in common' }), terms)
    expect(score.score).toBe(0)
    expect(score.explanation).toContain('None of the 3 company profile terms')
  })
})

// ── filtering ────────────────────────────────────────────────────────────────

describe('filterOpportunities and its reasons', () => {
  /** An open, priced-enough tender that no default rule excludes. */
  const open = opportunity({
    province: 'Gauteng',
    provinceSource: 'buyer',
    category: 'goods',
    status: 'active',
    closingAt: '2026-10-10T09:00:00.000Z',
    closingState: 'parsed',
    closingRaw: '2026-10-10T09:00:00Z',
  })
  const variant = (overrides: Partial<Opportunity>): Opportunity => ({ ...open, ...overrides })

  it('keeps an open tender untouched by default', () => {
    expect(exclusionReason(open, filter(), NOW)).toBeNull()
  })

  it('hides a tender the source says is finished, because it is not an opportunity', () => {
    for (const status of ['complete', 'cancelled', 'canceled', 'withdrawn', 'unsuccessful']) {
      expect(exclusionReason(variant({ status }), filter(), NOW)?.code).toBe('status-closed')
      expect(exclusionReason(variant({ status }), filter(), NOW)?.message).toContain(status)
    }
    expect(
      exclusionReason(variant({ status: 'complete' }), filter({ includeClosed: true }), NOW),
    ).toBeNull()
    expect(exclusionReason(open, filter(), NOW)).toBeNull()
  })

  it('narrows by province, and says when it could not tell', () => {
    expect(exclusionReason(open, filter({ provinces: ['Western Cape'] }), NOW)?.code).toBe(
      'province',
    )
    expect(exclusionReason(open, filter({ provinces: ['Gauteng'] }), NOW)).toBeNull()
    expect(exclusionReason(open, filter({ provinces: ['GP'] }), NOW)).toBeNull()
    expect(exclusionReason(open, filter({ provinces: ['gauteng'] }), NOW)).toBeNull()
    expect(exclusionReason(open, filter({ provinces: ['Western Cape'] }), NOW)?.message).toContain(
      'Gauteng',
    )
    expect(
      exclusionReason(variant({ province: null }), filter({ provinces: ['Gauteng'] }), NOW)?.code,
    ).toBe('province-unknown')
    expect(exclusionReason(variant({ province: null }), filter(), NOW)).toBeNull()
  })

  it('narrows by category, and says when the source states none', () => {
    expect(exclusionReason(open, filter({ categories: ['works'] }), NOW)?.code).toBe('category')
    expect(exclusionReason(open, filter({ categories: ['GOODS'] }), NOW)).toBeNull()
    expect(
      exclusionReason(variant({ category: null }), filter({ categories: ['goods'] }), NOW)?.code,
    ).toBe('category-unknown')
  })

  it('narrows by the closing window and by a deadline that has passed', () => {
    // The fixture closes on 2026-10-10, sixteen days after NOW.
    expect(exclusionReason(open, filter({ maxDaysFromNow: 10 }), NOW)?.code).toBe('closing-window')
    expect(exclusionReason(open, filter({ minDaysFromNow: 30 }), NOW)?.code).toBe('closing-window')
    expect(exclusionReason(open, filter({ minDaysFromNow: 5, maxDaysFromNow: 30 }), NOW)).toBeNull()
    expect(exclusionReason(open, filter({ maxDaysFromNow: 10 }), NOW)?.message).toContain('16 days')
    const past = variant({
      closingAt: '2026-09-01T09:00:00.000Z',
      closingRaw: '2026-09-01T09:00:00Z',
    })
    expect(exclusionReason(past, filter(), NOW)?.code).toBe('closing-passed')
    expect(exclusionReason(past, filter({ includeClosed: true }), NOW)).toBeNull()
    expect(exclusionReason(past, filter(), NOW)?.message).toContain('2026-09-01')
  })

  it('keeps an unknown closing date by default and drops it only when asked', () => {
    const unknown = variant({
      closingState: 'missing',
      closingAt: null,
      closingRaw: null,
      closingNote: null,
    })
    expect(exclusionReason(unknown, filter(), NOW)).toBeNull()
    expect(exclusionReason(unknown, filter({ includeUnknownClosing: false }), NOW)?.code).toBe(
      'closing-unknown',
    )
  })

  it('narrows by value only where a value is known', () => {
    const priced = variant({ value: { amount: 500_000, currency: 'ZAR' } })
    expect(exclusionReason(priced, filter({ minValue: 1_000_000 }), NOW)?.code).toBe('value-range')
    expect(exclusionReason(priced, filter({ maxValue: 100_000 }), NOW)?.code).toBe('value-range')
    expect(
      exclusionReason(priced, filter({ minValue: 100_000, maxValue: 1_000_000 }), NOW),
    ).toBeNull()
    const unpriced = variant({ value: null })
    expect(exclusionReason(unpriced, filter({ minValue: 1 }), NOW)).toBeNull()
    expect(exclusionReason(unpriced, filter({ requireKnownValue: true }), NOW)?.code).toBe(
      'value-unknown',
    )
  })

  it('narrows by relevance only when the profile has terms to score against', () => {
    const scoreFilter = filter({ keywords: ['solar'], minScore: 0.5 })
    expect(exclusionReason(open, scoreFilter, NOW)?.code).toBe('relevance')
    expect(exclusionReason(open, scoreFilter, NOW)?.message).toContain('0.00')
    expect(exclusionReason(variant({ title: 'Solar plant' }), scoreFilter, NOW)).toBeNull()
    // A minimum score with no terms would hide everything, so it is ignored.
    expect(exclusionReason(open, filter({ minScore: 0.9 }), NOW)).toBeNull()
  })

  it('returns the survivors in the order they arrived', () => {
    const list = [
      variant({ ocid: 'a', province: 'Gauteng' }),
      variant({ ocid: 'b', province: 'Western Cape' }),
      variant({ ocid: 'c', province: 'Gauteng' }),
    ]
    expect(
      filterOpportunities(list, filter({ provinces: ['Gauteng'] }), NOW).map((entry) => entry.ocid),
    ).toEqual(['a', 'c'])
  })
})

describe('rankOpportunities', () => {
  it('puts the most relevant first, then the soonest closing, then title order', () => {
    const list = [
      opportunity({ ocid: 'later', title: 'B tender', closingAt: '2026-12-01T09:00:00.000Z' }),
      opportunity({ ocid: 'soon', title: 'A tender', closingAt: '2026-10-01T09:00:00.000Z' }),
      opportunity({ ocid: 'unknown', title: 'C tender', closingAt: null, closingState: 'missing' }),
      opportunity({
        ocid: 'relevant',
        title: 'Solar tender',
        closingAt: '2026-11-01T09:00:00.000Z',
      }),
    ]
    const ranked = rankOpportunities(list, filter({ keywords: ['solar'] }))
    expect(ranked.map((entry) => entry.opportunity.ocid)).toEqual([
      'relevant',
      'soon',
      'later',
      'unknown',
    ])
    expect(ranked[0].score.score).toBe(1)
  })
})

// ── URLs and the allow-list ──────────────────────────────────────────────────

describe('URLs the client may build', () => {
  it('sends the required date range and a page', () => {
    const url = ocdsReleasesUrl({
      window: { from: '2026-09-01', to: '2026-09-07' },
      pageNumber: 2,
      pageSize: 10,
    })
    const parsed = new URL(url)
    expect(parsed.host).toBe('ocds-api.etenders.gov.za')
    expect(parsed.pathname).toBe('/api/OCDSReleases')
    expect(parsed.searchParams.get('dateFrom')).toBe('2026-09-01')
    expect(parsed.searchParams.get('dateTo')).toBe('2026-09-07')
    expect(parsed.searchParams.get('PageNumber')).toBe('2')
    expect(parsed.searchParams.get('PageSize')).toBe('10')
  })

  it('encodes an ocid so it cannot escape the release path', () => {
    expect(ocdsReleaseUrl('ocds-9t57fa-169278')).toBe(
      'https://ocds-api.etenders.gov.za/api/OCDSReleases/release/ocds-9t57fa-169278',
    )
    const escaped = ocdsReleaseUrl('../../evil')
    expect(new URL(escaped).host).toBe('ocds-api.etenders.gov.za')
    expect(new URL(escaped).pathname.startsWith('/api/OCDSReleases/release/')).toBe(true)
    expect(isAllowedDiscoveryUrl(escaped)).toBe(true)
  })

  it('builds the archive listing and file URLs on the archive host', () => {
    expect(new URL(bulkArchiveListingUrl()).host).toBe('data.etenders.gov.za')
    const file = new URL(bulkArchiveUrl('01072026.json'))
    expect(file.host).toBe('data.etenders.gov.za')
    expect(file.searchParams.get('fileName')).toBe('01072026.json')
  })

  it('refuses every URL that is not https, on a Treasury host, and credential-free', () => {
    expect(isAllowedDiscoveryUrl('https://ocds-api.etenders.gov.za/api/OCDSReleases')).toBe(true)
    expect(isAllowedDiscoveryUrl('https://OCDS-API.ETENDERS.GOV.ZA/api/OCDSReleases')).toBe(true)
    expect(isAllowedDiscoveryUrl('https://data.etenders.gov.za/Home/GetFiles')).toBe(true)
    expect(isAllowedDiscoveryUrl('https://www.etenders.gov.za/home/Download?blobName=x.pdf')).toBe(
      true,
    )
    expect(isAllowedDiscoveryUrl('http://ocds-api.etenders.gov.za/api/OCDSReleases')).toBe(false)
    expect(isAllowedDiscoveryUrl('https://ocds-api.etenders.gov.za.evil.example/x')).toBe(false)
    expect(isAllowedDiscoveryUrl('https://evil.example/?host=ocds-api.etenders.gov.za')).toBe(false)
    expect(isAllowedDiscoveryUrl('https://user:pass@ocds-api.etenders.gov.za/x')).toBe(false)
    expect(isAllowedDiscoveryUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedDiscoveryUrl('file:///C:/secrets.json')).toBe(false)
    expect(isAllowedDiscoveryUrl('not a url')).toBe(false)
    expect(isAllowedDiscoveryUrl('')).toBe(false)
  })
})

describe('parseBulkArchiveListing', () => {
  it('reads the DataTables payload the archive site really sends', () => {
    const listing = {
      sEcho: '1',
      iTotalRecords: 31,
      aaData: [
        {
          monthName: 'July 2026',
          downloadLink:
            "<a href='DownloadFile/?fileName=01072026.json' title='Download JSON File'>JSON</a><a href='DownloadFile/?fileName=01072026.csv'>CSV</a>",
        },
        {
          monthName: 'January 2024',
          downloadLink: "<a href='DownloadFile/?fileName=01012024.json'>JSON</a>",
        },
      ],
    }
    const files = parseBulkArchiveListing(listing)
    expect(files).toEqual([
      {
        monthName: 'July 2026',
        fileName: '01072026.json',
        url: 'https://data.etenders.gov.za/Home/DownloadFile/?fileName=01072026.json',
        format: 'json',
      },
      {
        monthName: 'January 2024',
        fileName: '01012024.json',
        url: 'https://data.etenders.gov.za/Home/DownloadFile/?fileName=01012024.json',
        format: 'json',
      },
    ])
  })

  it('reads only the first file of a row, so one month is one JSON file', () => {
    const files = parseBulkArchiveListing({
      aaData: [
        {
          monthName: 'July 2026',
          downloadLink: "<a href='DownloadFile/?fileName=01072026.json'>JSON</a>",
        },
      ],
    })
    expect(files).toHaveLength(1)
    expect(files[0].format).toBe('json')
  })

  it('never throws on junk', () => {
    for (const junk of [
      null,
      42,
      'html',
      {},
      { aaData: 'no' },
      { aaData: [null, {}, { monthName: 'x' }] },
    ]) {
      expect(parseBulkArchiveListing(junk)).toEqual([])
    }
  })

  it('orders the archive by month, which a file name does not do as a string', () => {
    expect(bulkArchiveMonth('01072026.json')).toBe('2026-07')
    expect(bulkArchiveMonth('01012024.json')).toBe('2024-01')
    expect(bulkArchiveMonth('junk.json')).toBeNull()
    expect(bulkArchiveMonth('01132026.json')).toBeNull()
    const names = ['01012024.json', '01122025.json', '01072026.json']
    const ordered = [...names].sort((a, b) =>
      (bulkArchiveMonth(b) ?? '').localeCompare(bulkArchiveMonth(a) ?? ''),
    )
    expect(ordered).toEqual(['01072026.json', '01122025.json', '01012024.json'])
  })
})

// ── windows ──────────────────────────────────────────────────────────────────

describe('windows', () => {
  it('splits a window into small pieces that tile it exactly', () => {
    expect(splitWindow({ from: '2026-09-01', to: '2026-09-14' }, 7)).toEqual([
      { from: '2026-09-01', to: '2026-09-07' },
      { from: '2026-09-08', to: '2026-09-14' },
    ])
    expect(splitWindow({ from: '2026-09-01', to: '2026-09-01' }, 7)).toEqual([
      { from: '2026-09-01', to: '2026-09-01' },
    ])
    expect(splitWindow({ from: '2026-09-01', to: '2026-09-07' }, 7)).toEqual([
      { from: '2026-09-01', to: '2026-09-07' },
    ])
  })

  it('never leaves a gap or an overlap, for any window and any piece size', () => {
    for (let maxDays = 1; maxDays <= 10; maxDays += 1) {
      const pieces = splitWindow({ from: '2026-08-15', to: '2026-09-20' }, maxDays)
      expect(pieces.length).toBeGreaterThan(0)
      expect(pieces[0].from).toBe('2026-08-15')
      expect(pieces[pieces.length - 1].to).toBe('2026-09-20')
      for (const piece of pieces) {
        expect(isValidWindow(piece)).toBe(true)
        expect(windowDays(piece)).toBeLessThanOrEqual(maxDays)
      }
      for (let index = 1; index < pieces.length; index += 1) {
        const previous = Date.parse(`${pieces[index - 1].to}T00:00:00Z`)
        const current = Date.parse(`${pieces[index].from}T00:00:00Z`)
        expect(current - previous).toBe(86_400_000)
      }
    }
  })

  it('refuses an unreadable window instead of guessing', () => {
    expect(isValidWindow({ from: '2026-09-07', to: '2026-09-01' })).toBe(false)
    expect(isValidWindow({ from: '07/09/2026', to: '2026-09-07' })).toBe(false)
    expect(isValidWindow({ from: '2026-09-07', to: '' })).toBe(false)
    expect(isValidWindow(null)).toBe(false)
    expect(windowDays({ from: '07/09/2026', to: '2026-09-07' })).toBeNull()
    expect(splitWindow({ from: 'nope', to: 'nope' }, 7)).toEqual([])
    expect(splitWindow({ from: '2026-09-01', to: '2026-09-07' }, 0)).toEqual([])
  })

  it('counts the days a window spans, inclusive of both ends', () => {
    expect(windowDays({ from: '2026-09-01', to: '2026-09-07' })).toBe(7)
    expect(windowDays({ from: '2026-09-01', to: '2026-09-01' })).toBe(1)
  })

  it('defaults a refresh to the recent past, ending today', () => {
    expect(defaultDiscoveryWindow(NOW, 14)).toEqual({ from: '2026-09-10', to: '2026-09-24' })
    expect(defaultDiscoveryWindow(NOW, 0)).toEqual({ from: '2026-09-24', to: '2026-09-24' })
    expect(windowDays(defaultDiscoveryWindow(NOW, 14))).toBe(15)
    expect(civilDate(NOW)).toBe('2026-09-24')
  })

  it('gives no date at all for an instant it cannot read', () => {
    expect(civilDate(new Date('nonsense'))).toBe('')
    expect(isValidWindow({ from: '', to: '2026-09-24' })).toBe(false)
    expect(splitWindow({ from: '', to: '2026-09-24' }, 7)).toEqual([])
  })

  it('keeps the feed’s reliable window bound at a week', () => {
    expect(DISCOVERY_MAX_WINDOW_DAYS).toBe(7)
  })
})

// ── the cache envelope ───────────────────────────────────────────────────────

describe('the cache envelope', () => {
  const envelope: DiscoveryCacheEnvelope = createDiscoveryCache({
    fetchedAt: '2026-09-24T06:00:00.000Z',
    window: { from: '2026-09-10', to: '2026-09-24' },
    source: 'ocds-api',
    complete: true,
    opportunities: [opportunity()],
    warnings: ['nothing unusual'],
  })

  it('round-trips through JSON unchanged', () => {
    const parsed = parseDiscoveryCache(JSON.parse(JSON.stringify(envelope)))
    expect(parsed).toEqual(envelope)
    expect(parsed?.version).toBe(DISCOVERY_CACHE_VERSION)
  })

  it('is fresh inside the bound, stale past it, and stale when the age is unknown', () => {
    // Fetched at 06:00Z, so the six-hour bound expires at 12:00Z.
    expect(isCacheStale(envelope, new Date('2026-09-24T09:00:00Z'))).toBe(false)
    expect(isCacheStale(envelope, new Date('2026-09-24T11:59:59Z'))).toBe(false)
    expect(isCacheStale(envelope, new Date('2026-09-24T12:00:00Z'))).toBe(false)
    expect(isCacheStale(envelope, new Date('2026-09-24T12:00:01Z'))).toBe(true)
    expect(isCacheStale(envelope, new Date('2026-09-25T06:00:00Z'))).toBe(true)
    expect(isCacheStale({ ...envelope, fetchedAt: 'whenever' }, NOW)).toBe(true)
    expect(isCacheStale(envelope, NOW, 3 * 60 * 60 * 1_000)).toBe(false)
    expect(isCacheStale(envelope, NOW, 3 * 60 * 60 * 1_000 - 1)).toBe(true)
    expect(isCacheStale(envelope, NOW, -1)).toBe(true)
  })

  it('does not call a future fetch time stale — the clock moved, not the data', () => {
    expect(isCacheStale(envelope, new Date('2026-09-24T05:00:00Z'))).toBe(false)
  })

  it('refuses an envelope it cannot use instead of guessing at it', () => {
    expect(parseDiscoveryCache(null)).toBeNull()
    expect(parseDiscoveryCache({})).toBeNull()
    expect(parseDiscoveryCache({ ...envelope, version: 2 })).toBeNull()
    expect(parseDiscoveryCache({ ...envelope, fetchedAt: 'nonsense' })).toBeNull()
    expect(
      parseDiscoveryCache({ ...envelope, window: { from: '2026-09-24', to: '2026-09-10' } }),
    ).toBeNull()
    expect(parseDiscoveryCache({ ...envelope, opportunities: 'not an array' })).not.toBeNull()
  })

  it('re-derives what it reads, so a tampered entry cannot claim more than it has', () => {
    const tampered = {
      ...envelope,
      opportunities: [
        {
          ...opportunity(),
          closingState: 'parsed',
          closingAt: null,
          closingRaw: 'TBC',
          province: 'Atlantis',
          provinceSource: 'buyer',
          value: { amount: 0, currency: 'ZAR' },
          documents: [{ url: 'javascript:alert(1)' }, { url: 'https://www.etenders.gov.za/x.pdf' }],
          source: 'not-a-source',
        },
      ],
    }
    const parsed = parseDiscoveryCache(tampered)
    const entry = parsed?.opportunities[0]
    expect(entry?.closingState).toBe('unparseable')
    expect(entry?.closingAt).toBeNull()
    expect(entry?.province).toBeNull()
    expect(entry?.provinceSource).toBeNull()
    expect(entry?.value).toBeNull()
    expect(entry?.documents.map((document) => document.url)).toEqual([
      'https://www.etenders.gov.za/x.pdf',
    ])
    expect(entry?.refusedDocumentLinks).toBe(1)
    expect(entry?.source).toBe('ocds-api')
    expect(entry?.reviewState).toBe('unconfirmed')
  })

  it('drops unusable and repeated entries with a warning, and keeps the rest', () => {
    const parsed = parseDiscoveryCache({
      ...envelope,
      opportunities: [
        opportunity({ ocid: 'keep' }),
        null,
        { title: 'no ocid' },
        opportunity({ ocid: 'keep' }),
      ],
    })
    expect(parsed?.opportunities.map((entry) => entry.ocid)).toEqual(['keep'])
    expect(
      parsed?.warnings.some((warning) => warning.includes('3 saved listings were unreadable')),
    ).toBe(true)
  })
})

// ── what the feed is, and is not ─────────────────────────────────────────────

describe('describeCoverage', () => {
  const coverage = describeCoverage()
  const all = [coverage.summary, ...coverage.points, coverage.text].join(' ')

  it('states the limits Treasury states, rather than hiding them', () => {
    expect(all).toContain('public beta')
    expect(all).toContain('accuracy is not guaranteed')
    expect(all).toContain('critical decision making or legal purposes')
    expect(all).toContain('volunteer their data')
    expect(all).toContain('POPIA')
    expect(all).toContain('January 2024')
    expect(all).toContain('lags the live feed')
    expect(all).toContain('linked, not copied')
  })

  it('never claims a value or a date the feed does not carry', () => {
    expect(all).toContain('shows no value rather than a zero')
    expect(all).toContain('never guessed')
    expect(all).toContain('unconfirmed')
  })

  it('attributes the source and its licence, and gives the UI one paragraph', () => {
    expect(coverage.badges.length).toBeGreaterThan(0)
    expect(coverage.sources).toHaveLength(2)
    for (const source of coverage.sources) {
      expect(source.url.startsWith('https://')).toBe(true)
      expect(source.licence).toContain('PDDL')
    }
    expect(coverage.text.startsWith(coverage.summary)).toBe(true)
    for (const point of coverage.points) expect(point.length).toBeGreaterThan(20)
    expect(coverage.text).toContain(coverage.points[0])
  })

  it('returns a fresh statement each time, so no caller can edit the shared one', () => {
    const first = describeCoverage()
    first.points.push('a claim this app does not make')
    expect(describeCoverage().points).not.toContain('a claim this app does not make')
  })
})

/**
 * Phase 3 lane E — authoritative intake verification.
 *
 * Covers three things the Wave-2 work must guarantee:
 *  1. The strict v2 schema accepts the additive `intakeVerification` field
 *     (and keeps accepting documents that predate it), while still rejecting
 *     unknown fields, bad enums, out-of-range values and unbounded collections.
 *  2. `assessReadiness` blocks on unconfirmed readiness-critical fields and on
 *     OCR-required/unreviewed pages, but is completely unchanged when a tender
 *     carries no intake-verification state.
 *  3. The renderer store writes review + page state into the authoritative
 *     document and persists it through `saveStoreV2` with CAS revision tracking,
 *     round-tripping across a restart — and never writes localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CompanyProfile,
  FieldReview,
  IntakeVerification,
  PageExtractionState,
  RequirementRecord,
  TenderRecord,
  TendersDataV2,
  TendersWorkspaceV2,
  VaultDoc,
} from '../src/shared/types'
import { assessReadiness } from '../src/shared/readiness'
import {
  MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD,
  MAX_TENDERS_REVIEW_CONFLICTS,
  type SaveTendersRequest,
  type SaveTendersResult,
  type TendersLoadResult,
} from '../src/shared/tenders-persistence'
import { TENDERS_SCHEMA_VERSION, validateTendersDataV2 } from '../src/shared/tenders-schema'

const NOW = new Date('2026-09-01T00:00:00.000Z')

// ── schema fixtures ───────────────────────────────────────────────────────────

function company(): CompanyProfile {
  return {
    name: 'Test Co',
    tradingName: 'Test Co',
    registrationNumber: 'REG-1',
    vatNumber: 'VAT-1',
    taxPin: 'TAX-1',
    bbbeeLevel: 'Level 2',
    bbbeeBlackOwnership: '51%',
    csdSupplierNumber: 'CSD-1',
    founded: '2019',
    employees: '25',
    industry: 'Construction',
    description: 'Synthetic company.',
    address: '1 Test Street',
    phone: '+27 10 000 0000',
    email: 'test@example.test',
    website: 'https://example.test',
    directors: [],
    projects: [],
  }
}

function requirement(id = 'req-1', pageNumber = 1): RequirementRecord {
  return {
    id,
    ruleKey: 'tax_pin',
    title: 'Tax clearance',
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    verbatimClause: 'A valid SARS tax clearance certificate must be submitted.',
    pageNumber,
    boundingBox: { top: 0.1, left: 0.1, width: 0.8, height: 0.05 },
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 10,
    confidence: 0.9,
    status: 'FULFILLED',
    linkedVaultDocId: 'vd-1',
    reason: null,
    suggestedVaultDocIds: [],
  }
}

function vulcanTender(overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: 'tender-1',
    title: 'Supply and Delivery of Office Computers',
    referenceNumber: 'ICT/2026/041',
    issuingBody: 'Provincial Administration Office',
    closingDate: '2026-12-18',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: null,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: '2026-08-01T00:00:00.000Z',
    fileName: 'rfp.pdf',
    fileUrl: 'documents/rfp.pdf',
    numPages: 4,
    ocrPages: 0,
    requirements: [requirement()],
    ...overrides,
  }
}

function fieldReview(overrides: Partial<FieldReview> = {}): FieldReview {
  return {
    extractedValue: null,
    sourcePage: null,
    sourceClause: null,
    confidence: null,
    candidates: [],
    state: 'unconfirmed',
    reviewedAt: null,
    ...overrides,
  }
}

function pageState(overrides: Partial<PageExtractionState> = {}): PageExtractionState {
  return {
    pageNumber: 1,
    state: 'native',
    method: 'native-text',
    confidence: null,
    reviewedAt: null,
    ...overrides,
  }
}

function intake(overrides: Partial<IntakeVerification> = {}): IntakeVerification {
  return {
    fields: {},
    requirements: {},
    pages: [pageState()],
    contactEmail: null,
    conflicts: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A fully-confirmed intake for every readiness-critical field. */
function confirmedIntake(overrides: Partial<IntakeVerification> = {}): IntakeVerification {
  return intake({
    fields: {
      title: fieldReview({
        extractedValue: 'Supply and Delivery of Office Computers',
        state: 'confirmed',
      }),
      referenceNumber: fieldReview({ extractedValue: 'ICT/2026/041', state: 'confirmed' }),
      issuingBody: fieldReview({
        extractedValue: 'Provincial Administration Office',
        state: 'confirmed',
      }),
      closingDate: fieldReview({ extractedValue: '2026-12-18', state: 'confirmed' }),
      submissionMethod: fieldReview({ extractedValue: 'ELECTRONIC', state: 'confirmed' }),
      submissionDestination: fieldReview({ extractedValue: null, state: 'not_stated' }),
    },
    ...overrides,
  })
}

function documentV2(tender: TenderRecord): TendersDataV2 {
  const workspace: TendersWorkspaceV2 = {
    id: 'ws-1',
    name: 'Test Co',
    dataOrigin: 'user',
    company: company(),
    customers: [],
    vault: [
      {
        id: 'vd-1',
        title: 'Tax clearance',
        category: 'COMPLIANCE',
        fileUrl: 'vault/tax.pdf',
        issueDate: null,
        expiryDate: null,
        isCertified: false,
        certifiedDate: null,
        metadata: {},
      },
    ],
    tenders: [tender],
  }
  return {
    schemaVersion: TENDERS_SCHEMA_VERSION,
    revision: 0,
    updatedAt: '2026-09-01T00:00:00.000Z',
    activeCompanyId: 'ws-1',
    workspaces: [workspace],
    issuerTemplates: [],
  }
}

function issuePaths(result: ReturnType<typeof validateTendersDataV2>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.path)
}

// ── 1. schema ─────────────────────────────────────────────────────────────────

describe('intakeVerification schema', () => {
  it('accepts a v2 document with no intakeVerification (older documents)', () => {
    const result = validateTendersDataV2(documentV2(vulcanTender()))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.workspaces[0].tenders[0].intakeVerification).toBeUndefined()
    }
  })

  it('accepts and round-trips a fully-populated intakeVerification', () => {
    const verification = confirmedIntake({
      requirements: {
        'req-1': {
          state: 'verified',
          originalTitle: 'Tax clearance',
          originalCategory: 'MANDATORY_STAGE_1',
          correctedAt: null,
        },
      },
      pages: [
        pageState({ pageNumber: 1 }),
        pageState({ pageNumber: 2, state: 'ocr-required', method: null }),
      ],
      conflicts: ['Multiple closing dates found: a | b'],
      contactEmail: 'tenders@example.test',
    })
    const result = validateTendersDataV2(
      documentV2(vulcanTender({ intakeVerification: verification })),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.workspaces[0].tenders[0].intakeVerification).toEqual(verification)
    }
  })

  it('rejects an unknown field inside intakeVerification', () => {
    const bad = { ...intake(), surprise: true } as unknown as IntakeVerification
    const result = validateTendersDataV2(documentV2(vulcanTender({ intakeVerification: bad })))
    expect(result.ok).toBe(false)
    expect(issuePaths(result)).toContain('workspaces.0.tenders.0.intakeVerification.surprise')
  })

  it('rejects an unknown review field key', () => {
    const bad = intake({ fields: { bogus: fieldReview() } as IntakeVerification['fields'] })
    const result = validateTendersDataV2(documentV2(vulcanTender({ intakeVerification: bad })))
    expect(result.ok).toBe(false)
    expect(issuePaths(result)).toContain('workspaces.0.tenders.0.intakeVerification.fields.bogus')
  })

  it('rejects invalid review/page enums', () => {
    const badField = intake({
      fields: { title: fieldReview({ state: 'maybe' as FieldReview['state'] }) },
    })
    expect(
      validateTendersDataV2(documentV2(vulcanTender({ intakeVerification: badField }))).ok,
    ).toBe(false)

    const badPage = intake({
      pages: [pageState({ state: 'ocr-maybe' as PageExtractionState['state'] })],
    })
    expect(
      validateTendersDataV2(documentV2(vulcanTender({ intakeVerification: badPage }))).ok,
    ).toBe(false)
  })

  it('rejects page state outside the page range and duplicate page state', () => {
    const outOfRange = intake({ pages: [pageState({ pageNumber: 9 })] })
    const rangeResult = validateTendersDataV2(
      documentV2(vulcanTender({ numPages: 4, intakeVerification: outOfRange })),
    )
    expect(rangeResult.ok).toBe(false)
    expect(issuePaths(rangeResult)).toContain(
      'workspaces.0.tenders.0.intakeVerification.pages.0.pageNumber',
    )

    const duplicate = intake({
      pages: [pageState({ pageNumber: 1 }), pageState({ pageNumber: 1 })],
    })
    const duplicateResult = validateTendersDataV2(
      documentV2(vulcanTender({ intakeVerification: duplicate })),
    )
    expect(duplicateResult.ok).toBe(false)
  })

  it('rejects a candidate score outside 0..1 and a non-RFC3339 review timestamp', () => {
    const badScore = intake({
      fields: {
        title: fieldReview({
          candidates: [{ value: 'x', sourcePage: 1, sourceClause: 'x', score: 1.5 }],
        }),
      },
    })
    const scoreResult = validateTendersDataV2(
      documentV2(vulcanTender({ intakeVerification: badScore })),
    )
    expect(scoreResult.ok).toBe(false)
    expect(issuePaths(scoreResult)).toContain(
      'workspaces.0.tenders.0.intakeVerification.fields.title.candidates.0.score',
    )

    const badTime = intake({
      fields: { title: fieldReview({ reviewedAt: 'yesterday' }) },
    })
    expect(
      validateTendersDataV2(documentV2(vulcanTender({ intakeVerification: badTime }))).ok,
    ).toBe(false)
  })

  it('rejects unbounded collections', () => {
    const candidates = Array.from(
      { length: MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD + 1 },
      (_, index) => ({ value: `c${index}`, sourcePage: null, sourceClause: null, score: 0.5 }),
    )
    const badCandidates = intake({ fields: { title: fieldReview({ candidates }) } })
    expect(
      validateTendersDataV2(documentV2(vulcanTender({ intakeVerification: badCandidates }))).ok,
    ).toBe(false)

    const conflicts = Array.from({ length: MAX_TENDERS_REVIEW_CONFLICTS + 1 }, (_, i) => `c${i}`)
    const badConflicts = intake({ conflicts })
    expect(
      validateTendersDataV2(documentV2(vulcanTender({ intakeVerification: badConflicts }))).ok,
    ).toBe(false)
  })
})

// ── 2. readiness ──────────────────────────────────────────────────────────────

describe('readiness intake-verification gate', () => {
  function blockingIds(report: ReturnType<typeof assessReadiness>): string[] {
    return report.checks.filter((check) => check.blocking && !check.passed).map((check) => check.id)
  }

  it('adds no intake checks when a tender has no verification state', () => {
    const report = assessReadiness(vulcanTender(), [], company(), NOW)
    expect(report.checks.some((check) => check.id === 'intake-review')).toBe(false)
    expect(report.checks.some((check) => check.id === 'page-extraction')).toBe(false)
  })

  it('blocks while a readiness-critical field is unconfirmed', () => {
    const report = assessReadiness(
      vulcanTender({ intakeVerification: intake({ fields: { title: fieldReview() } }) }),
      [],
      company(),
      NOW,
    )
    const check = report.checks.find((candidate) => candidate.id === 'intake-review')
    expect(check?.passed).toBe(false)
    expect(check?.blocking).toBe(true)
    expect(blockingIds(report)).toContain('intake-review')
  })

  it('blocks while competing candidates remain unresolved', () => {
    const report = assessReadiness(
      vulcanTender({
        intakeVerification: intake({
          fields: {
            closingDate: fieldReview({
              candidates: [
                {
                  value: '2026-12-18',
                  sourcePage: 1,
                  sourceClause: 'Closing Date: 2026-12-18',
                  score: 1,
                },
                {
                  value: '2026-12-21',
                  sourcePage: 2,
                  sourceClause: 'Amended Closing Date: 2026-12-21',
                  score: 0.9,
                },
              ],
            }),
          },
        }),
      }),
      [],
      company(),
      NOW,
    )
    const check = report.checks.find((candidate) => candidate.id === 'intake-review')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/Competing candidates remain/i)
  })

  it('blocks when an OCR-required page has not been manually reviewed', () => {
    const report = assessReadiness(
      vulcanTender({
        intakeVerification: confirmedIntake({
          pages: [
            pageState({ pageNumber: 1 }),
            pageState({ pageNumber: 2, state: 'ocr-required', method: null }),
          ],
        }),
      }),
      [],
      company(),
      NOW,
    )
    const check = report.checks.find((candidate) => candidate.id === 'page-extraction')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toContain('p.2 (ocr-required)')
    expect(blockingIds(report)).toContain('page-extraction')
  })

  it('unblocks once the page is manually reviewed', () => {
    const report = assessReadiness(
      vulcanTender({
        intakeVerification: confirmedIntake({
          pages: [
            pageState({ pageNumber: 1 }),
            pageState({
              pageNumber: 2,
              state: 'manually-reviewed',
              method: 'manual',
              reviewedAt: '2026-09-01T00:00:00.000Z',
            }),
          ],
        }),
      }),
      [],
      company(),
      NOW,
    )
    const check = report.checks.find((candidate) => candidate.id === 'page-extraction')
    expect(check?.passed).toBe(true)
    expect(blockingIds(report)).not.toContain('page-extraction')
  })

  it('does not otherwise change readiness for a fully-confirmed document with native pages', () => {
    const without = assessReadiness(vulcanTender(), [], company(), NOW)
    const withIntake = assessReadiness(
      vulcanTender({ intakeVerification: confirmedIntake() }),
      [],
      company(),
      NOW,
    )
    expect(blockingIds(withIntake)).toEqual(blockingIds(without))
    expect(
      withIntake.checks
        .filter((c) => c.id.startsWith('intake') || c.id === 'page-extraction')
        .every((c) => c.passed),
    ).toBe(true)
    // Weight-free gates: the published score is unchanged.
    expect(withIntake.score).toBe(without.score)
  })

  // ── fail-closed unreadable-page gate (Oracle R2) ──────────────────────────

  /** A vault that satisfies the FULFILLED, expiry-required tax-clearance requirement. */
  function readyVault(): VaultDoc[] {
    return [
      {
        id: 'vd-1',
        title: 'Tax clearance',
        category: 'COMPLIANCE',
        fileUrl: 'vault/tax.pdf',
        issueDate: null,
        expiryDate: '2027-06-30',
        isCertified: false,
        certifiedDate: null,
        metadata: {},
      },
    ]
  }

  function reviewedPage(pageNumber: number): PageExtractionState {
    return pageState({
      pageNumber,
      state: 'manually-reviewed',
      method: 'manual',
      reviewedAt: '2026-09-01T00:00:00.000Z',
    })
  }

  it('migrated tender: unreadable pages with no review state fail readiness (fail-closed)', () => {
    // v1→v2 migration carries `ocrPages > 0` but writes no `intakeVerification`
    // at all, so no per-page review state exists. Readiness must still fail.
    const migrated = vulcanTender({ ocrPages: 2 })
    expect(migrated.intakeVerification).toBeUndefined()

    // The same tender without unreadable pages is otherwise ready, so
    // page-extraction is the sole new blocker for the migrated document.
    expect(assessReadiness(vulcanTender(), readyVault(), company(), NOW).ready).toBe(true)

    const report = assessReadiness(migrated, readyVault(), company(), NOW)
    const check = report.checks.find((candidate) => candidate.id === 'page-extraction')
    expect(check).toBeDefined()
    expect(check?.passed).toBe(false)
    expect(check?.blocking).toBe(true)
    expect(check?.detail).toMatch(/unreadable page|not readable without review/i)
    expect(blockingIds(report)).toContain('page-extraction')
    expect(report.ready).toBe(false)
  })

  it('an empty page review does not clear unreadable pages', () => {
    // A Workspace-seeded review created without source access has `pages: []`.
    const report = assessReadiness(
      vulcanTender({ ocrPages: 2, intakeVerification: confirmedIntake({ pages: [] }) }),
      readyVault(),
      company(),
      NOW,
    )
    const check = report.checks.find((candidate) => candidate.id === 'page-extraction')
    expect(check?.passed).toBe(false)
    expect(blockingIds(report)).toContain('page-extraction')
  })

  it('unblocks when every unreadable page is individually manually reviewed', () => {
    const report = assessReadiness(
      vulcanTender({
        ocrPages: 2,
        intakeVerification: confirmedIntake({
          pages: [pageState({ pageNumber: 1 }), reviewedPage(2), reviewedPage(3)],
        }),
      }),
      readyVault(),
      company(),
      NOW,
    )
    const check = report.checks.find((candidate) => candidate.id === 'page-extraction')
    expect(check?.passed).toBe(true)
    expect(blockingIds(report)).not.toContain('page-extraction')
  })

  it('partially reviewed unreadable pages stay blocked', () => {
    const report = assessReadiness(
      vulcanTender({
        ocrPages: 3,
        intakeVerification: confirmedIntake({
          pages: [pageState({ pageNumber: 1 }), reviewedPage(2)],
        }),
      }),
      readyVault(),
      company(),
      NOW,
    )
    const check = report.checks.find((candidate) => candidate.id === 'page-extraction')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/2 unreadable page/i)
    expect(blockingIds(report)).toContain('page-extraction')
  })

  it('ocrPages === 0 with no review state is unchanged (no intake/page checks)', () => {
    const baseline = assessReadiness(vulcanTender(), readyVault(), company(), NOW)
    expect(baseline.checks.some((c) => c.id === 'page-extraction')).toBe(false)
    expect(baseline.checks.some((c) => c.id === 'intake-review')).toBe(false)
    expect(baseline.ready).toBe(true)
  })
})

// ── 3. store round-trip ───────────────────────────────────────────────────────

type ApiMock = {
  loadStoreV2: ReturnType<typeof vi.fn>
  saveStoreV2: ReturnType<typeof vi.fn>
  onStoreChangedV2: ReturnType<typeof vi.fn>
}

interface StoreState {
  hydrateFromMain: () => Promise<void>
  tenderReviews: Record<string, IntakeVerification>
  workspaces: TendersWorkspaceV2[]
  setTenderReview: (tenderId: string, review: IntakeVerification) => void
  updateFieldReview: (tenderId: string, field: string, patch: Partial<FieldReview>) => void
  setPageExtractionState: (
    tenderId: string,
    pageNumber: number,
    patch: Partial<PageExtractionState>,
  ) => void
  markPageReviewed: (tenderId: string, pageNumber: number) => void
}

interface StoreApi {
  getState: () => StoreState
}

const STORE_MODULE = '../src/renderer/src/store'
const TENDER_ID = 'tender-1'

let api: ApiMock
let storeChangedCallback: ((data: TendersDataV2) => void) | null = null

function installTendersApiMock(): void {
  storeChangedCallback = null
  api = {
    loadStoreV2: vi.fn(),
    saveStoreV2: vi.fn(),
    onStoreChangedV2: vi.fn((callback: (data: TendersDataV2) => void) => {
      storeChangedCallback = callback
      return () => {
        storeChangedCallback = null
      }
    }),
  }
  ;(window as unknown as Record<string, unknown>).tendersApi = api
}

function loadOk(
  status: 'loaded' | 'migrated' | 'not-found',
  data: TendersDataV2,
): TendersLoadResult {
  return { ok: true, status, data, needsSave: false, warnings: [] }
}

function commitFromRequest(request: SaveTendersRequest): SaveTendersResult {
  return {
    ok: true,
    data: {
      ...(JSON.parse(JSON.stringify(request.document)) as TendersDataV2),
      revision: request.expectedRevision + 1,
      updatedAt: '2026-09-01T00:00:01.000Z',
    },
  }
}

function useSuccessfulSave(): void {
  api.saveStoreV2.mockImplementation(async (request: SaveTendersRequest) =>
    commitFromRequest(request),
  )
}

async function importStore(): Promise<StoreApi> {
  const mod = (await import(STORE_MODULE)) as unknown as { useTendersStore: StoreApi }
  return mod.useTendersStore
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2000)
  await flushMicrotasks()
}

function savedDocument(index: number): TendersDataV2 {
  return (api.saveStoreV2.mock.calls[index][0] as SaveTendersRequest).document
}

function savedReview(index: number): IntakeVerification | undefined {
  return savedDocument(index).workspaces[0].tenders[0].intakeVerification
}

function localStorageBlob(): string {
  const values: string[] = []
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key) values.push(`${key}=${window.localStorage.getItem(key) ?? ''}`)
  }
  return values.join('\n')
}

describe('intake verification store round-trip', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    vi.useFakeTimers()
    installTendersApiMock()
  })

  afterEach(() => {
    vi.useRealTimers()
    window.localStorage.clear()
    ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    storeChangedCallback = null
  })

  it('persists review state into the authoritative document and adopts it across a restart', async () => {
    api.loadStoreV2.mockResolvedValue(loadOk('loaded', documentV2(vulcanTender())))
    useSuccessfulSave()

    const store = await importStore()
    await store.getState().hydrateFromMain()
    await flushMicrotasks()

    const review = confirmedIntake({
      pages: [pageState({ pageNumber: 1 })],
      conflicts: ['Multiple closing dates found'],
    })
    store.getState().setTenderReview(TENDER_ID, review)
    await settle()

    expect(api.saveStoreV2).toHaveBeenCalledTimes(1)
    expect(savedReview(0)).toEqual(review)
    expect((api.saveStoreV2.mock.calls[0][0] as SaveTendersRequest).expectedRevision).toBe(0)

    // "Restart": the committed document (echoed by the mock) is what main would
    // return on the next launch. The review slice must rebuild from it.
    const committed = savedDocument(0)
    vi.resetModules()
    api.loadStoreV2.mockResolvedValue(loadOk('loaded', committed))
    const restarted = await importStore()
    await restarted.getState().hydrateFromMain()
    await flushMicrotasks()

    expect(restarted.getState().tenderReviews[TENDER_ID]).toEqual(review)
  })

  it('persists field and page-state mutations with CAS revision tracking', async () => {
    api.loadStoreV2.mockResolvedValue(loadOk('loaded', documentV2(vulcanTender())))
    useSuccessfulSave()

    const store = await importStore()
    await store.getState().hydrateFromMain()
    await flushMicrotasks()

    store.getState().setTenderReview(TENDER_ID, confirmedIntake())
    await settle()
    expect((api.saveStoreV2.mock.calls[0][0] as SaveTendersRequest).expectedRevision).toBe(0)

    store.getState().updateFieldReview(TENDER_ID, 'referenceNumber', {
      state: 'corrected',
      extractedValue: 'ICT/2026/041',
    })
    store.getState().setPageExtractionState(TENDER_ID, 2, { state: 'ocr-required', method: null })
    await settle()

    expect(api.saveStoreV2).toHaveBeenCalledTimes(2)
    const second = api.saveStoreV2.mock.calls[1][0] as SaveTendersRequest
    expect(second.expectedRevision).toBe(1)
    const persisted = savedReview(1)
    expect(persisted?.fields.referenceNumber?.state).toBe('corrected')
    expect(persisted?.pages?.find((page) => page.pageNumber === 2)?.state).toBe('ocr-required')

    store.getState().markPageReviewed(TENDER_ID, 2)
    await settle()
    expect(savedReview(2)?.pages?.find((page) => page.pageNumber === 2)?.state).toBe(
      'manually-reviewed',
    )
  })

  it('purges the superseded localStorage review key and never writes intake state to localStorage', async () => {
    window.localStorage.setItem('zanostack-tenders-review-v1', JSON.stringify({ stale: true }))
    api.loadStoreV2.mockResolvedValue(loadOk('loaded', documentV2(vulcanTender())))
    useSuccessfulSave()

    const store = await importStore()
    expect(window.localStorage.getItem('zanostack-tenders-review-v1')).toBeNull()

    await store.getState().hydrateFromMain()
    await flushMicrotasks()
    store.getState().setTenderReview(TENDER_ID, confirmedIntake())
    await settle()

    const blob = localStorageBlob()
    expect(blob).not.toContain('intakeVerification')
    expect(blob).not.toContain('zanostack-tenders-review-v1')
    // The authoritative document still received the review.
    expect(savedReview(0)).toBeDefined()
  })
})

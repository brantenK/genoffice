import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assessDocHealth,
  assessReadiness,
  docsAtClosing,
  isRequirementResolved,
  parseClosingDate,
} from '../src/shared/readiness'
import { MOCK_COMPANY } from '../src/renderer/src/mock/company'
import { TENDER_RULES } from '../src/shared/rules'
import type { CompanyProfile, RequirementRecord, TenderRecord, VaultDoc } from '../src/shared/types'

const NOW = new Date('2026-09-01T00:00:00Z')

type FutureRequirementResolution = Parameters<typeof isRequirementResolved>[0] & {
  notApplicableReason?: string | null
}

type EvidenceKind = 'DOCUMENT' | 'SIGNATURE' | 'NONE'
type ValidityKind = 'EXPIRY_REQUIRED' | 'CERTIFICATION_WINDOW' | 'PERMANENT' | 'NONE'
type FutureTenderRule = (typeof TENDER_RULES)[number] & {
  evidenceKind?: EvidenceKind
  validityKind?: ValidityKind
}

/**
 * Review-backed classifications for actual rule-catalogue entries. The rationale is
 * deliberately kept beside each key so additions are an auditable decision rather
 * than an unexplained readiness allow-list.
 */
const DOCUMENT_BACKED_RULE_REVIEW = {
  tax_pin: {
    rationale: 'The returnable is a SARS certificate or TCS PIN document.',
    validityKind: 'EXPIRY_REQUIRED',
  },
  cipc: {
    rationale: 'The catalogue explicitly requests CIPC company-registration documents.',
    validityKind: 'PERMANENT',
  },
  vat: {
    rationale: 'The catalogue requests a VAT registration certificate or number.',
    validityKind: 'PERMANENT',
  },
  csd: {
    rationale: 'The returnable is proof of Central Supplier Database registration.',
    validityKind: 'PERMANENT',
  },
  financials: {
    rationale: 'The returnable is a set of audited financial statements or accounts.',
    validityKind: 'NONE',
  },
  turnover: {
    rationale: 'The turnover threshold must be evidenced by financial statements or accounts.',
    validityKind: 'NONE',
  },
  coida: {
    rationale: 'The returnable is a COIDA Letter of Good Standing that expires.',
    validityKind: 'EXPIRY_REQUIRED',
  },
  director_ids: {
    rationale: 'The returnable is certified identity-document copies.',
    validityKind: 'CERTIFICATION_WINDOW',
  },
  police_certification: {
    rationale: 'The returnable must carry a current Commissioner of Oaths certification.',
    validityKind: 'CERTIFICATION_WINDOW',
  },
  experience: {
    rationale: 'Experience must be evidenced by project records or reference letters.',
    validityKind: 'NONE',
  },
  key_personnel: {
    rationale: 'The catalogue explicitly requests CVs and qualification documents.',
    validityKind: 'NONE',
  },
  bid_security: {
    rationale: 'The returnable is a bid bond, guarantee, or security-deposit document.',
    validityKind: 'EXPIRY_REQUIRED',
  },
  bbbee: {
    rationale: 'The returnable is a B-BBEE certificate or sworn affidavit that expires.',
    validityKind: 'EXPIRY_REQUIRED',
  },
  methodology: {
    rationale: 'The catalogue explicitly requests a methodology or work-programme submission.',
    validityKind: 'NONE',
  },
  subcontracting: {
    rationale: 'The catalogue requests a subcontracting or enterprise-development plan.',
    validityKind: 'NONE',
  },
  joint_venture: {
    rationale: 'The returnable is a joint-venture or consortium agreement.',
    validityKind: 'NONE',
  },
  pricing_schedule: {
    rationale:
      'The returnable is a completed pricing schedule / price proposal (FINANCIAL vault category).',
    validityKind: 'NONE',
  },
  bill_of_quantities: {
    rationale:
      'The returnable is a priced bill of quantities / bill of materials (FINANCIAL vault category).',
    validityKind: 'NONE',
  },
} as const satisfies Record<string, { rationale: string; validityKind: ValidityKind }>

const reviewedDocumentRules = TENDER_RULES.filter((rule) => rule.key in DOCUMENT_BACKED_RULE_REVIEW)

const COMPANY_RULE_FIELDS = [
  ['cipc', 'registrationNumber'],
  ['tax_pin', 'taxPin'],
  ['vat', 'vatNumber'],
  ['bbbee', 'bbbeeLevel'],
  ['csd', 'csdSupplierNumber'],
] as const satisfies ReadonlyArray<readonly [string, keyof CompanyProfile]>

function requirement(overrides: Partial<RequirementRecord> = {}): RequirementRecord {
  return {
    id: 'req-tax',
    ruleKey: 'tax_pin',
    title: 'Valid SARS Tax Clearance / TCS PIN',
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    verbatimClause: 'Bidders must submit valid proof of tax compliance.',
    pageNumber: 1,
    boundingBox: { top: 0.1, left: 0.1, width: 0.8, height: 0.05 },
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 1,
    status: 'FULFILLED',
    linkedVaultDocId: 'vault-tax',
    reason: null,
    suggestedVaultDocIds: [],
    ...overrides,
  }
}

function catalogueRequirement(
  rule: (typeof TENDER_RULES)[number],
  overrides: Partial<RequirementRecord> = {},
): RequirementRecord {
  return requirement({
    id: `req-${rule.key}`,
    ruleKey: rule.key,
    title: rule.title,
    category: rule.category,
    riskLevel: rule.riskLevel,
    order: rule.order,
    verbatimClause: `Bidders must submit ${rule.title}.`,
    ...overrides,
  })
}

function companyWithout(field: keyof CompanyProfile): CompanyProfile {
  return { ...MOCK_COMPANY, [field]: '' }
}

function tender(overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: 'tender-readiness-invariant',
    title: 'Supply and Delivery of Office Computers',
    referenceNumber: 'ICT/2026/041',
    issuingBody: 'Provincial Administration Office',
    closingDate: '2026-12-18',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: 'procurement@example.test',
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: '2026-08-01',
    fileName: 'office-computers-rfp.pdf',
    fileUrl: 'documents/office-computers-rfp.pdf',
    numPages: 12,
    ocrPages: 0,
    requirements: [],
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
    expiryDate: '2027-12-31',
    isCertified: false,
    certifiedDate: null,
    metadata: {},
    ...overrides,
  }
}

function blockingCheck(report: ReturnType<typeof assessReadiness>, id: string) {
  return report.checks.find((check) => check.id === id)
}

describe('readiness blocking invariants', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns ready:false when the requirement matrix is empty and therefore unaudited', () => {
    const report = assessReadiness(tender({ requirements: [] }), [], MOCK_COMPANY)

    expect(report.ready).toBe(false)
    expect(blockingCheck(report, 'requirements')?.passed).toBe(false)
  })

  it('returns ready:false for an OUTSTANDING mandatory requirement', () => {
    const report = assessReadiness(
      tender({
        requirements: [
          requirement({
            status: 'OUTSTANDING',
            linkedVaultDocId: null,
          }),
        ],
      }),
      [],
      MOCK_COMPANY,
      NOW,
    )

    expect(report.ready).toBe(false)
    expect(blockingCheck(report, 'requirements')?.passed).toBe(false)
    expect(blockingCheck(report, 'requirements')?.detail).toContain(
      'Valid SARS Tax Clearance / TCS PIN',
    )
  })

  it('returns ready:false when required evidence will be expired at closing', () => {
    const report = assessReadiness(
      tender({ requirements: [requirement()] }),
      [vaultDoc({ expiryDate: '2026-11-30' })],
      MOCK_COMPANY,
      NOW,
    )

    expect(report.ready).toBe(false)
    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(false)
    expect(blockingCheck(report, 'docs-at-closing')?.detail).toMatch(/expires.*before closing/i)
  })

  it('returns ready:false when a fulfilled mandatory evidence requirement points to a missing document', () => {
    const report = assessReadiness(
      tender({
        requirements: [requirement({ linkedVaultDocId: 'vault-document-that-does-not-exist' })],
      }),
      [],
      MOCK_COMPANY,
      NOW,
    )

    expect(report.ready, 'a dangling evidence link must not allow the readiness gate to pass').toBe(
      false,
    )
    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(false)
  })

  it('returns ready:false when a fulfilled mandatory tax_pin requirement has no linked document', () => {
    const report = assessReadiness(
      tender({
        requirements: [requirement({ linkedVaultDocId: null })],
      }),
      [],
      MOCK_COMPANY,
    )

    expect(report.ready).toBe(false)
    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(false)
  })

  it('exempts a signature-only requirement from document evidence when its checkbox is confirmed', () => {
    const report = assessReadiness(
      tender({
        signatureChecks: { sbd_forms: true },
        requirements: [
          requirement({
            id: 'req-sbd',
            ruleKey: 'sbd_forms',
            title: 'Signed SBD returnable forms',
            linkedVaultDocId: null,
          }),
        ],
      }),
      [],
      MOCK_COMPANY,
    )

    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(true)
    expect(blockingCheck(report, 'signatures')?.passed).toBe(true)
    expect(report.ready).toBe(true)
  })

  it('returns ready:false when a signature-dependent returnable is not confirmed', () => {
    const report = assessReadiness(
      tender({
        signatureChecks: { sbd_forms: false },
        requirements: [
          requirement({
            id: 'req-sbd',
            ruleKey: 'sbd_forms',
            title: 'Signed SBD returnable forms',
            linkedVaultDocId: null,
          }),
        ],
      }),
      [],
      MOCK_COMPANY,
      NOW,
    )

    expect(report.ready).toBe(false)
    expect(blockingCheck(report, 'signatures')?.passed).toBe(false)
    expect(blockingCheck(report, 'signatures')?.detail).toMatch(/not yet confirmed/i)
  })
})

describe('catalogue-owned document evidence semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('contains every reviewed document-backed key in the actual rule catalogue', () => {
    expect(reviewedDocumentRules.map((rule) => rule.key).sort()).toEqual(
      Object.keys(DOCUMENT_BACKED_RULE_REVIEW).sort(),
    )
  })

  it('owns complete evidence and validity classifications in the rule catalogue', () => {
    const futureCatalogue = TENDER_RULES as FutureTenderRule[]
    const catalogueDocumentKeys = futureCatalogue
      .filter((rule) => rule.evidenceKind === 'DOCUMENT')
      .map((rule) => rule.key)
      .sort()

    expect(catalogueDocumentKeys).toEqual(Object.keys(DOCUMENT_BACKED_RULE_REVIEW).sort())
    for (const rule of reviewedDocumentRules as FutureTenderRule[]) {
      const review =
        DOCUMENT_BACKED_RULE_REVIEW[rule.key as keyof typeof DOCUMENT_BACKED_RULE_REVIEW]
      expect(rule, review.rationale).toMatchObject({
        evidenceKind: 'DOCUMENT',
        validityKind: review.validityKind,
      })
    }
  })

  it.each(
    reviewedDocumentRules.map(
      (rule) =>
        [
          rule.key,
          DOCUMENT_BACKED_RULE_REVIEW[rule.key as keyof typeof DOCUMENT_BACKED_RULE_REVIEW]
            .rationale,
          rule,
        ] as const,
    ),
  )('%s cannot pass without linked evidence: %s', (_key, _rationale, rule) => {
    const report = assessReadiness(
      tender({
        requirements: [catalogueRequirement(rule, { linkedVaultDocId: null })],
      }),
      [],
      MOCK_COMPANY,
    )

    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(false)
    expect(report.ready).toBe(false)
  })

  it.each([
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
  ] as const)('does not accept a linked document with a %s fileUrl', (_label, fileUrl) => {
    const taxRule = TENDER_RULES.find((rule) => rule.key === 'tax_pin')!
    const report = assessReadiness(
      tender({ requirements: [catalogueRequirement(taxRule)] }),
      [vaultDoc({ fileUrl })],
      MOCK_COMPANY,
    )

    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(false)
    expect(report.ready).toBe(false)
  })

  it('applies the strictest validity rule to a shared document regardless of requirement order', () => {
    const permanentRule = TENDER_RULES.find((rule) => rule.key === 'cipc')!
    const expiryRequiredRule = TENDER_RULES.find((rule) => rule.key === 'tax_pin')!
    const permanentRequirement = catalogueRequirement(permanentRule, {
      id: 'req-permanent-cipc',
      linkedVaultDocId: 'vault-shared',
    })
    const expiryRequiredRequirement = catalogueRequirement(expiryRequiredRule, {
      id: 'req-expiring-tax',
      linkedVaultDocId: 'vault-shared',
    })
    const sharedDocument = vaultDoc({
      id: 'vault-shared',
      expiryDate: null,
    })

    const states = [
      [permanentRequirement, expiryRequiredRequirement],
      [expiryRequiredRequirement, permanentRequirement],
    ].map((requirements) => {
      const report = assessReadiness(tender({ requirements }), [sharedDocument], MOCK_COMPANY)
      const [document] = docsAtClosing(tender({ requirements }), [sharedDocument])
      return {
        docsPassed: blockingCheck(report, 'docs-at-closing')?.passed,
        ready: report.ready,
        health: document.healthAtClosing.health,
        willFail: document.willFail,
        associatedRequirements: [...document.requirementTitles].sort(),
      }
    })

    const expectedAssociation = [permanentRule.title, expiryRequiredRule.title].sort()
    expect(states).toEqual([
      {
        docsPassed: false,
        ready: false,
        health: 'UNKNOWN',
        willFail: true,
        associatedRequirements: expectedAssociation,
      },
      {
        docsPassed: false,
        ready: false,
        health: 'UNKNOWN',
        willFail: true,
        associatedRequirements: expectedAssociation,
      },
    ])
  })

  it.each(
    reviewedDocumentRules
      .filter(
        (rule) =>
          DOCUMENT_BACKED_RULE_REVIEW[rule.key as keyof typeof DOCUMENT_BACKED_RULE_REVIEW]
            .validityKind === 'EXPIRY_REQUIRED',
      )
      .map((rule) => [rule.key, rule] as const),
  )('blocks time-valid %s evidence whose required expiry is unknown', (_ruleKey, rule) => {
    const report = assessReadiness(
      tender({ requirements: [catalogueRequirement(rule)] }),
      [vaultDoc({ expiryDate: null })],
      MOCK_COMPANY,
    )

    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(false)
    expect(report.ready).toBe(false)
  })

  it('treats a certification date without an isCertified confirmation as unknown and blocking', () => {
    const certificationRule = TENDER_RULES.find((rule) => rule.key === 'director_ids')!
    const tenderRecord = tender({ requirements: [catalogueRequirement(certificationRule)] })
    const document = vaultDoc({
      isCertified: false,
      certifiedDate: '2026-08-15',
      expiryDate: null,
    })
    const [documentAtClosing] = docsAtClosing(tenderRecord, [document])
    const report = assessReadiness(tenderRecord, [document], MOCK_COMPANY)

    expect(documentAtClosing.healthAtClosing.health).toBe('UNKNOWN')
    expect(documentAtClosing.willFail).toBe(true)
    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(false)
    expect(report.ready).toBe(false)
  })

  it.each(
    reviewedDocumentRules
      .filter(
        (rule) =>
          DOCUMENT_BACKED_RULE_REVIEW[rule.key as keyof typeof DOCUMENT_BACKED_RULE_REVIEW]
            .validityKind === 'CERTIFICATION_WINDOW',
      )
      .map((rule) => [rule.key, rule] as const),
  )('blocks certified %s evidence when its certification date is unknown', (_ruleKey, rule) => {
    const report = assessReadiness(
      tender({ requirements: [catalogueRequirement(rule)] }),
      [vaultDoc({ isCertified: true, certifiedDate: null })],
      MOCK_COMPANY,
    )

    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(false)
    expect(report.ready).toBe(false)
  })

  it('allows permanent CIPC evidence without an expiry date', () => {
    const cipcRule = TENDER_RULES.find((rule) => rule.key === 'cipc')!
    const report = assessReadiness(
      tender({ requirements: [catalogueRequirement(cipcRule)] }),
      [vaultDoc({ category: 'GOVERNANCE', expiryDate: null })],
      MOCK_COMPANY,
    )

    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(true)
    expect(report.ready).toBe(true)
  })

  it('skips document evidence for an explicitly justified N/A requirement', () => {
    const taxRule = TENDER_RULES.find((rule) => rule.key === 'tax_pin')!
    const report = assessReadiness(
      tender({
        requirements: [
          catalogueRequirement(taxRule, {
            status: 'NOT_APPLICABLE',
            linkedVaultDocId: null,
            notApplicableReason:
              'The issuing authority confirmed this requirement is inapplicable.',
          }),
        ],
      }),
      [],
      MOCK_COMPANY,
    )

    expect(blockingCheck(report, 'requirements')?.passed).toBe(true)
    expect(blockingCheck(report, 'docs-at-closing')?.passed).toBe(true)
    expect(report.ready).toBe(true)
  })

  it('blocks original_docs until its explicit manual confirmation is checked', () => {
    const originalDocumentsRule = TENDER_RULES.find((rule) => rule.key === 'original_docs')!
    const report = assessReadiness(
      tender({
        signatureChecks: { original_docs: false },
        requirements: [
          catalogueRequirement(originalDocumentsRule, {
            linkedVaultDocId: null,
          }),
        ],
      }),
      [],
      MOCK_COMPANY,
    )

    expect(blockingCheck(report, 'signatures')?.passed).toBe(false)
    expect(report.ready).toBe(false)
  })

  it('passes the original_docs manual check when explicitly confirmed', () => {
    const originalDocumentsRule = TENDER_RULES.find((rule) => rule.key === 'original_docs')!
    const report = assessReadiness(
      tender({
        signatureChecks: { original_docs: true },
        requirements: [
          catalogueRequirement(originalDocumentsRule, {
            linkedVaultDocId: null,
          }),
        ],
      }),
      [],
      MOCK_COMPANY,
    )
    const signatures = blockingCheck(report, 'signatures')

    expect(signatures?.passed).toBe(true)
    expect(signatures?.detail).toMatch(/all 1 signature item.*confirmed/i)
    expect(report.ready).toBe(true)
  })
})

describe('company-profile readiness semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(COMPANY_RULE_FIELDS)(
    'makes missing %s profile data blocking for an applicable mandatory requirement',
    (ruleKey, companyField) => {
      const rule = TENDER_RULES.find((candidate) => candidate.key === ruleKey)!
      const report = assessReadiness(
        tender({ requirements: [catalogueRequirement(rule)] }),
        [vaultDoc()],
        companyWithout(companyField),
      )

      expect(blockingCheck(report, 'company-details')?.passed).toBe(false)
      expect(blockingCheck(report, 'company-details')?.blocking).toBe(true)
      expect(report.ready).toBe(false)
    },
  )

  it.each(COMPANY_RULE_FIELDS)(
    'does not create a company blocker for optional %s requirements',
    (ruleKey, companyField) => {
      const rule = TENDER_RULES.find((candidate) => candidate.key === ruleKey)!
      const report = assessReadiness(
        tender({
          requirements: [
            catalogueRequirement(rule, {
              isMandatory: false,
              linkedVaultDocId: null,
            }),
          ],
        }),
        [],
        companyWithout(companyField),
      )

      expect(blockingCheck(report, 'company-details')?.passed).toBe(true)
      expect(report.ready).toBe(true)
    },
  )

  it.each(COMPANY_RULE_FIELDS)(
    'does not create a company blocker for explicitly N/A %s requirements',
    (ruleKey, companyField) => {
      const rule = TENDER_RULES.find((candidate) => candidate.key === ruleKey)!
      const report = assessReadiness(
        tender({
          requirements: [
            catalogueRequirement(rule, {
              status: 'NOT_APPLICABLE',
              linkedVaultDocId: null,
              notApplicableReason:
                'The issuing authority confirmed this requirement is inapplicable.',
            }),
          ],
        }),
        [],
        companyWithout(companyField),
      )

      expect(blockingCheck(report, 'company-details')?.passed).toBe(true)
      expect(report.ready).toBe(true)
    },
  )
})

describe('NOT_APPLICABLE audit justification', () => {
  it.each([
    ['no dedicated value', undefined],
    ['a null dedicated value', null],
    ['a whitespace-only dedicated value', '   \t'],
  ])('does not resolve with %s', (_label, notApplicableReason) => {
    const candidate: FutureRequirementResolution = {
      status: 'NOT_APPLICABLE',
      reason: null,
      notApplicableReason,
    }

    expect(isRequirementResolved(candidate)).toBe(false)
  })

  it('does not treat the generic automated reason as an N/A audit justification', () => {
    const candidate: FutureRequirementResolution = {
      status: 'NOT_APPLICABLE',
      reason: 'Automatically classified from stale extraction output',
    }

    expect(isRequirementResolved(candidate)).toBe(false)
  })

  it('resolves N/A only with an explicit dedicated justification', () => {
    const candidate: FutureRequirementResolution = {
      status: 'NOT_APPLICABLE',
      reason: null,
      notApplicableReason: 'The tender is for goods and does not include construction work.',
    }

    expect(isRequirementResolved(candidate)).toBe(true)
  })
})

describe('strict civil-date handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['2026-99-99', '2026-02-30', 'sometime in December 2026'])(
    'rejects invalid or ambiguous closing date %j',
    (raw) => {
      expect(parseClosingDate(raw)).toBeNull()
    },
  )

  it.each([
    ['2026-12-18T12:00:00.000Z', '2026-12-18T12:00:00.000Z'],
    ['2026-12-18T14:00:00.000+02:00', '2026-12-18T12:00:00.000Z'],
  ])(
    'parses strict RFC3339 closing timestamp %j to the correct finite instant',
    (raw, expectedIso) => {
      const parsed = parseClosingDate(raw)

      expect(parsed).not.toBeNull()
      expect(Number.isFinite(parsed?.getTime())).toBe(true)
      expect(parsed?.toISOString()).toBe(expectedIso)
    },
  )

  it.each(['2026-12-18T12:00:00.000', '2026-02-30T12:00:00.000Z'])(
    'rejects non-RFC3339 or impossible closing timestamp %j',
    (raw) => {
      expect(parseClosingDate(raw)).toBeNull()
    },
  )

  it.each([
    ['November 30, 2026', '2026-11-30T23:59:00.000Z'],
    ['Dec 18, 2026 14:30', '2026-12-18T14:30:00.000Z'],
    ['30 November 2026 at 11h00', '2026-11-30T11:00:00.000Z'],
  ])('parses supported closing date %j to the correct finite instant', (raw, expectedIso) => {
    const parsed = parseClosingDate(raw)

    expect(parsed).not.toBeNull()
    expect(Number.isFinite(parsed?.getTime())).toBe(true)
    expect(parsed?.toISOString()).toBe(expectedIso)
  })

  it.each(['Dec 18, 2026 00:30 pm', 'Dec 18, 2026 13:00 pm'])(
    'rejects out-of-range 12-hour clock input %j',
    (raw) => {
      expect(parseClosingDate(raw)).toBeNull()
    },
  )

  it.each([
    ['Dec 18, 2026 12:30 am', '2026-12-18T00:30:00.000Z'],
    ['Dec 18, 2026 12:30 pm', '2026-12-18T12:30:00.000Z'],
    ['Dec 18, 2026 1:30 pm', '2026-12-18T13:30:00.000Z'],
    ['Dec 18, 2026 00:30', '2026-12-18T00:30:00.000Z'],
    ['Dec 18, 2026 23:59', '2026-12-18T23:59:00.000Z'],
  ])('accepts valid 12-hour or 24-hour clock input %j', (raw, expectedIso) => {
    expect(parseClosingDate(raw)?.toISOString()).toBe(expectedIso)
  })

  it.each(['February 30, 2026', 'Nov 31, 2026 14:30'])(
    'rejects invalid month-first closing date %j',
    (raw) => {
      expect(parseClosingDate(raw)).toBeNull()
    },
  )

  it.each([
    ['issue date', { issueDate: 'not-a-date', expiryDate: null }],
    ['expiry date', { expiryDate: '2026-99-99' }],
  ] as const)(
    'reports an explicit unknown/invalid health for an invalid %s',
    (_label, overrides) => {
      const report = assessDocHealth(vaultDoc(overrides), NOW)

      expect(['UNKNOWN', 'INVALID_DATE']).toContain(report.health)
      expect(report.health).not.toBe('VALID')
    },
  )

  it('treats matching civil closing and expiry dates as valid through that day', () => {
    const closingDate = '2026-12-18'
    const tenderRecord = tender({
      closingDate,
      requirements: [requirement()],
    })
    const result = docsAtClosing(tenderRecord, [vaultDoc({ expiryDate: closingDate })])

    expect(result).toHaveLength(1)
    expect(result[0].healthAtClosing.daysUntilExpiry).toBe(0)
    expect(result[0].healthAtClosing.health).toBe('VALID')
    expect(result[0].willFail).toBe(false)
  })

  it('produces the same valid result for matching civil dates in different timezones', () => {
    const originalTimezone = process.env.TZ
    const timezones = ['UTC', 'Africa/Johannesburg', 'America/New_York', 'Pacific/Auckland']

    try {
      const results = timezones.map((timezone) => {
        process.env.TZ = timezone
        const closingDate = '2026-12-18'
        const [entry] = docsAtClosing(tender({ closingDate, requirements: [requirement()] }), [
          vaultDoc({ expiryDate: closingDate }),
        ])
        return {
          timezone,
          daysUntilExpiry: entry.healthAtClosing.daysUntilExpiry,
          health: entry.healthAtClosing.health,
          willFail: entry.willFail,
        }
      })

      expect(results).toEqual(
        timezones.map((timezone) => ({
          timezone,
          daysUntilExpiry: 0,
          health: 'VALID',
          willFail: false,
        })),
      )
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ
      else process.env.TZ = originalTimezone
    }
  })
})

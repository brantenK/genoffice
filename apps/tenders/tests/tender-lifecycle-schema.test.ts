/**
 * Phase 4 / WP-11 — schema compatibility for the additive lifecycle fields.
 *
 * No version bump: documents without `submission` / `outcome` / `lifecycle`
 * (and without customer/company `archivedAt`) validate exactly as before, while
 * present fields are validated strictly (unknown keys, bad enums, bad dates,
 * uncapped collections all rejected).
 */
import { describe, expect, it } from 'vitest'
import { TENDERS_SCHEMA_VERSION, validateTendersDataV2 } from '../src/shared/tenders-schema'
import {
  MAX_TENDERS_LIFECYCLE_HISTORY,
  MAX_TENDERS_READINESS_BLOCKERS,
} from '../src/shared/tenders-persistence'
import type {
  CompanyProfile,
  Customer,
  RequirementRecord,
  TenderRecord,
  TendersDataV2,
  TendersWorkspaceV2,
  VaultDoc,
} from '../src/shared/types'

const AT = '2026-09-01T00:00:00.000Z'

function company(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
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
    ...overrides,
  }
}

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-1',
    name: 'Example Customer',
    contactName: 'Contact',
    contactEmail: 'c@example.test',
    contactPhone: '+27 10 000 0001',
    industry: 'Public sector',
    status: 'ACTIVE',
    since: '2025-01-01',
    notes: 'Synthetic.',
    requiredDocs: [],
    ...overrides,
  }
}

function vaultDoc(): VaultDoc {
  return {
    id: 'vd-1',
    title: 'Tax clearance',
    category: 'COMPLIANCE',
    fileUrl: 'vault/tax.pdf',
    issueDate: null,
    expiryDate: '2027-01-01',
    isCertified: false,
    certifiedDate: null,
    metadata: {},
  }
}

function requirement(): RequirementRecord {
  return {
    id: 'req-1',
    ruleKey: 'tax_pin',
    title: 'Tax clearance',
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    verbatimClause: 'A valid SARS tax clearance certificate must be submitted.',
    pageNumber: 1,
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

function tender(overrides: Partial<TenderRecord> = {}): TenderRecord {
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
    createdAt: AT,
    fileName: 'rfp.pdf',
    fileUrl: 'documents/rfp.pdf',
    numPages: 4,
    ocrPages: 0,
    requirements: [requirement()],
    ...overrides,
  }
}

function documentV2(tenderRecord: TenderRecord, customerRecord?: Customer): TendersDataV2 {
  const workspace: TendersWorkspaceV2 = {
    id: 'ws-1',
    name: 'Test Co',
    dataOrigin: 'user',
    company: company(),
    customers: customerRecord ? [customerRecord] : [customer()],
    vault: [vaultDoc()],
    tenders: [tenderRecord],
  }
  return {
    schemaVersion: TENDERS_SCHEMA_VERSION,
    revision: 0,
    updatedAt: AT,
    activeCompanyId: 'ws-1',
    workspaces: [workspace],
    issuerTemplates: [],
  }
}

function expectIssue(result: ReturnType<typeof validateTendersDataV2>, path: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.issues.map((issue) => issue.path)).toContain(path)
  }
}

describe('lifecycle schema compatibility', () => {
  it('validates legacy documents with none of the new fields', () => {
    const result = validateTendersDataV2(documentV2(tender()))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const parsed = result.data.workspaces[0].tenders[0]
      expect(parsed).not.toHaveProperty('submission')
      expect(parsed).not.toHaveProperty('outcome')
      expect(parsed).not.toHaveProperty('lifecycle')
      expect(result.data.workspaces[0].customers[0]).not.toHaveProperty('archivedAt')
      expect(result.data.workspaces[0].company).not.toHaveProperty('archivedAt')
    }
  })

  it('keeps every legacy status valid, including SUBMITTED without a submission record', () => {
    for (const status of [
      'IN_PROGRESS',
      'READY_FOR_SUBMISSION',
      'SUBMITTED',
      'ARCHIVED',
    ] as const) {
      const result = validateTendersDataV2(documentV2(tender({ status })))
      expect(result.ok, status).toBe(true)
    }
  })

  it('accepts every new lifecycle status', () => {
    for (const status of [
      'READY_TO_ASSEMBLE',
      'PACK_GENERATED',
      'SUBMITTED_EVIDENCED',
      'WON',
      'LOST',
      'WITHDRAWN',
      'CANCELLED',
    ] as const) {
      const result = validateTendersDataV2(documentV2(tender({ status })))
      expect(result.ok, status).toBe(true)
    }
    expectIssue(
      validateTendersDataV2(documentV2(tender({ status: 'NOT_A_STATUS' as never }))),
      'workspaces.0.tenders.0.status',
    )
  })

  it('round-trips submission, outcome and lifecycle exactly', () => {
    const submission = {
      submittedAt: AT,
      timeZone: 'Africa/Johannesburg',
      method: 'EMAIL' as const,
      destination: 'tenders@example.test',
      confirmationReference: 'REF-9',
      evidence: { kind: 'email-receipt', reference: 'vd-1', note: 'sent 09:12' },
      person: 'A Person',
      notes: 'Submitted from reception.',
      readiness: {
        ready: false,
        score: 42,
        failedCheckIds: ['requirements'],
        blockingCheckIds: ['requirements'],
        capturedAt: AT,
      },
      blockerOverrideReason: 'Manager approved late submission.',
    }
    const outcome = {
      status: 'won' as const,
      noticeDate: '2026-12-20T00:00:00.000Z',
      reason: 'Best price.',
      awardedValue: 115000,
      evidenceReference: 'vd-1',
      recordedAt: AT,
    }
    const lifecycle = [
      { at: AT, from: null, to: 'IN_PROGRESS' as const, reason: 'imported' },
      { at: AT, from: 'SUBMITTED' as const, to: 'SUBMITTED_EVIDENCED' as const, reason: null },
    ]
    const result = validateTendersDataV2(
      documentV2(tender({ status: 'WON', submission, outcome, lifecycle })),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const parsed = result.data.workspaces[0].tenders[0]
      expect(parsed.submission).toEqual(submission)
      expect(parsed.outcome).toEqual(outcome)
      expect(parsed.lifecycle).toEqual(lifecycle)
    }
  })

  it('accepts explicit null submission/outcome and round-trips them', () => {
    const result = validateTendersDataV2(documentV2(tender({ submission: null, outcome: null })))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const parsed = result.data.workspaces[0].tenders[0]
      expect(parsed.submission).toBeNull()
      expect(parsed.outcome).toBeNull()
    }
  })

  it('rejects unknown keys inside submission/outcome/lifecycle', () => {
    expectIssue(
      validateTendersDataV2(documentV2(tender({ submission: { surprise: true } as never }))),
      'workspaces.0.tenders.0.submission.surprise',
    )
    expectIssue(
      validateTendersDataV2(
        documentV2(
          tender({
            outcome: {
              status: 'won',
              noticeDate: null,
              reason: null,
              awardedValue: null,
              evidenceReference: null,
              recordedAt: AT,
              extra: 1,
            } as never,
          }),
        ),
      ),
      'workspaces.0.tenders.0.outcome.extra',
    )
    expectIssue(
      validateTendersDataV2(
        documentV2(
          tender({
            lifecycle: [{ at: AT, from: null, to: 'IN_PROGRESS', reason: null, x: 1 }] as never,
          }),
        ),
      ),
      'workspaces.0.tenders.0.lifecycle.0.x',
    )
  })

  it('rejects bad enums, dates and numbers', () => {
    expectIssue(
      validateTendersDataV2(
        documentV2(tender({ submission: { ...minimalSubmission(), method: 'COURIER' } as never })),
      ),
      'workspaces.0.tenders.0.submission.method',
    )
    expectIssue(
      validateTendersDataV2(
        documentV2(
          tender({ submission: { ...minimalSubmission(), submittedAt: 'yesterday' } as never }),
        ),
      ),
      'workspaces.0.tenders.0.submission.submittedAt',
    )
    expectIssue(
      validateTendersDataV2(
        documentV2(
          tender({
            outcome: {
              status: 'made-up',
              noticeDate: null,
              reason: null,
              awardedValue: null,
              evidenceReference: null,
              recordedAt: AT,
            } as never,
          }),
        ),
      ),
      'workspaces.0.tenders.0.outcome.status',
    )
    expectIssue(
      validateTendersDataV2(
        documentV2(
          tender({
            outcome: {
              status: 'won',
              noticeDate: null,
              reason: null,
              awardedValue: -5,
              evidenceReference: null,
              recordedAt: AT,
            } as never,
          }),
        ),
      ),
      'workspaces.0.tenders.0.outcome.awardedValue',
    )
    expectIssue(
      validateTendersDataV2(
        documentV2(
          tender({
            lifecycle: [{ at: 'nope', from: null, to: 'IN_PROGRESS', reason: null }] as never,
          }),
        ),
      ),
      'workspaces.0.tenders.0.lifecycle.0.at',
    )
    expectIssue(
      validateTendersDataV2(
        documentV2(
          tender({ lifecycle: [{ at: AT, from: null, to: 'BOGUS', reason: null }] as never }),
        ),
      ),
      'workspaces.0.tenders.0.lifecycle.0.to',
    )
  })

  it('accepts a zero amount and refuses a negative one on both money fields', () => {
    // Stored rand amounts must admit zero — the money PARSER's refusal of a `R 0`
    // literal is about not confirming a zero valuation, not about storage.
    // See `nonnegativeAmount` in `tenders-schema.ts`.
    const zeroValue = documentV2(
      tender({
        estimatedValue: 0,
        outcome: {
          status: 'won',
          noticeDate: null,
          reason: null,
          awardedValue: 0,
          evidenceReference: null,
          recordedAt: AT,
        },
      }),
    )
    const accepted = validateTendersDataV2(zeroValue)
    expect(accepted.ok).toBe(true)
    if (accepted.ok) {
      const parsed = accepted.data.workspaces[0].tenders[0]
      expect(parsed.estimatedValue).toBe(0)
      expect(parsed.outcome?.awardedValue).toBe(0)
    }

    expectIssue(
      validateTendersDataV2(documentV2(tender({ estimatedValue: -0.01 }))),
      'workspaces.0.tenders.0.estimatedValue',
    )
    expectIssue(
      validateTendersDataV2(
        documentV2(
          tender({
            outcome: {
              status: 'won',
              noticeDate: null,
              reason: null,
              awardedValue: -0.01,
              evidenceReference: null,
              recordedAt: AT,
            } as never,
          }),
        ),
      ),
      'workspaces.0.tenders.0.outcome.awardedValue',
    )
  })

  it('rejects uncapped lifecycle history and readiness blocker lists', () => {
    const tooManyEvents = Array.from({ length: MAX_TENDERS_LIFECYCLE_HISTORY + 1 }, () => ({
      at: AT,
      from: null,
      to: 'IN_PROGRESS' as const,
      reason: null,
    }))
    expectIssue(
      validateTendersDataV2(documentV2(tender({ lifecycle: tooManyEvents }))),
      'workspaces.0.tenders.0.lifecycle',
    )

    const tooManyBlockers = Array.from(
      { length: MAX_TENDERS_READINESS_BLOCKERS + 1 },
      (_, index) => `check-${index}`,
    )
    expectIssue(
      validateTendersDataV2(
        documentV2(
          tender({
            submission: {
              ...minimalSubmission(),
              readiness: {
                ready: false,
                score: 0,
                failedCheckIds: tooManyBlockers,
                blockingCheckIds: tooManyBlockers,
                capturedAt: AT,
              },
            } as never,
          }),
        ),
      ),
      'workspaces.0.tenders.0.submission.readiness.blockingCheckIds',
    )
  })
})

describe('AI provenance schema compatibility', () => {
  it('validates a requirement written before the provenance marker existed', () => {
    const result = validateTendersDataV2(documentV2(tender()))
    expect(result.ok).toBe(true)
    if (result.ok) {
      // No key is invented on read: an unmarked requirement is never re-labelled
      // as a model suggestion (absent means the local rule engine).
      expect(result.data.workspaces[0].tenders[0].requirements[0]).not.toHaveProperty('suggestedBy')
    }
  })

  it('accepts and round-trips a model-suggested requirement', () => {
    const aiRequirement: RequirementRecord = { ...requirement(), suggestedBy: 'ai' }
    const result = validateTendersDataV2(documentV2(tender({ requirements: [aiRequirement] })))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.workspaces[0].tenders[0].requirements[0]).toEqual(aiRequirement)
    }
  })

  it('accepts an explicit parser marker and rejects an unrecognised origin', () => {
    const parserRequirement: RequirementRecord = { ...requirement(), suggestedBy: 'parser' }
    expect(
      validateTendersDataV2(documentV2(tender({ requirements: [parserRequirement] }))).ok,
    ).toBe(true)
    expectIssue(
      validateTendersDataV2(
        documentV2(tender({ requirements: [{ ...requirement(), suggestedBy: 'human' } as never] })),
      ),
      'workspaces.0.tenders.0.requirements.0.suggestedBy',
    )
  })
})

describe('archive flags schema', () => {
  it('accepts null and RFC3339 archivedAt on customer and company', () => {
    const withArchive = documentV2(tender(), customer({ archivedAt: AT }))
    withArchive.workspaces[0].company = company({ archivedAt: AT })
    const result = validateTendersDataV2(withArchive)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.workspaces[0].customers[0].archivedAt).toBe(AT)
      expect(result.data.workspaces[0].company.archivedAt).toBe(AT)
    }

    const cleared = validateTendersDataV2(documentV2(tender(), customer({ archivedAt: null })))
    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(cleared.data.workspaces[0].customers[0].archivedAt).toBeNull()
  })

  it('rejects a malformed archivedAt', () => {
    expectIssue(
      validateTendersDataV2(
        documentV2(tender(), customer({ archivedAt: 'last tuesday' as never })),
      ),
      'workspaces.0.customers.0.archivedAt',
    )
  })
})

function minimalSubmission() {
  return {
    submittedAt: AT,
    timeZone: null,
    method: 'PHYSICAL' as const,
    destination: null,
    confirmationReference: null,
    evidence: null,
    person: null,
    notes: null,
    readiness: null,
    blockerOverrideReason: null,
  }
}

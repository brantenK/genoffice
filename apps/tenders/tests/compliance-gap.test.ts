import { describe, expect, it } from 'vitest'
import {
  assessDocHealth,
  AUTO_LINK_THRESHOLD,
  daysBetween,
  healthSummary,
  matchVaultDocs,
  matchVaultDocsWithConfidence,
  POLICE_STAMP_WINDOW_DAYS,
  applyGapToRequirement,
  applyGapToRequirements,
} from '../src/renderer/src/gap'
import {
  assessReadiness,
  checkCompanyDetails,
  docsAtClosing,
  signatureRuleKeys,
  SIGNATURE_RULE_KEYS,
} from '../src/renderer/src/readiness'
import type {
  CompanyProfile,
  RequirementRecord,
  TenderRecord,
  VaultDoc,
} from '../src/shared/types'
import { MOCK_COMPANY } from '../src/renderer/src/mock/company'
import { MOCK_VAULT } from '../src/renderer/src/mock/vault'

function createMockReq(overrides: Partial<RequirementRecord> = {}): RequirementRecord {
  return {
    id: 'req-tax',
    ruleKey: 'tax_pin',
    title: 'Valid SARS Tax Clearance / TCS PIN',
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    verbatimClause: 'Bidders must submit a valid SARS Tax Clearance Certificate.',
    pageNumber: 1,
    boundingBox: { top: 0.1, left: 0.1, width: 0.8, height: 0.05 },
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 10,
    status: 'OUTSTANDING',
    linkedVaultDocId: null,
    reason: null,
    suggestedVaultDocIds: [],
    ...overrides,
  }
}

function createMockDoc(overrides: Partial<VaultDoc> = {}): VaultDoc {
  return {
    id: 'doc-1',
    title: 'SARS Tax Clearance Certificate',
    category: 'COMPLIANCE',
    fileUrl: 'vault/tax.pdf',
    issueDate: '2026-01-01',
    expiryDate: '2027-01-01',
    isCertified: false,
    certifiedDate: null,
    metadata: {},
    ...overrides,
  }
}

describe('Compliance Gap Analysis & Document Health Evaluation', () => {
  describe('1. Document Health Assessment & Expiry Calculation', () => {
    it('calculates days between two dates accurately', () => {
      const d1 = new Date('2026-10-31T00:00:00Z')
      const d2 = new Date('2026-10-01T00:00:00Z')
      expect(daysBetween(d1, d2)).toBe(30)
      expect(daysBetween(d2, d1)).toBe(-30)
    })

    it('identifies a VALID document with future expiry and uncertified status', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const doc = createMockDoc({
        expiryDate: '2026-12-01T00:00:00Z',
        isCertified: false,
      })
      const report = assessDocHealth(doc, now)
      expect(report.health).toBe('VALID')
      expect(report.daysUntilExpiry).toBeGreaterThan(0)
      expect(report.stampDaysLeft).toBeNull()
      expect(healthSummary(doc, report)).toContain('Valid — expires in')
    })

    it('identifies an EXPIRED document when expiry date has passed', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const doc = createMockDoc({
        expiryDate: '2026-08-01T00:00:00Z',
      })
      const report = assessDocHealth(doc, now)
      expect(report.health).toBe('EXPIRED')
      expect(report.daysUntilExpiry).toBeLessThan(0)
      expect(healthSummary(doc, report)).toContain('Expired 31 days ago')
    })

    it('identifies NO_EXPIRY_INFO when both expiryDate and certifiedDate are missing', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const doc = createMockDoc({
        expiryDate: null,
        isCertified: false,
        certifiedDate: null,
      })
      const report = assessDocHealth(doc, now)
      expect(report.health).toBe('NO_EXPIRY_INFO')
      expect(report.daysUntilExpiry).toBeNull()
      expect(report.stampDaysLeft).toBeNull()
      expect(healthSummary(doc, report)).toBe('No expiry date on file')
    })
  })

  describe('2. Strict 90-Day Police Stamp Certification Window', () => {
    it('verifies POLICE_STAMP_WINDOW_DAYS constant is strictly 90 days', () => {
      expect(POLICE_STAMP_WINDOW_DAYS).toBe(90)
    })

    it('evaluates certified document as VALID when police stamp is within 90 days', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      // 30 days old: well inside the 90 day window
      const doc = createMockDoc({
        title: 'Certified Director ID Copy',
        isCertified: true,
        certifiedDate: '2026-08-02T00:00:00Z',
        expiryDate: null,
      })
      const report = assessDocHealth(doc, now)
      expect(report.health).toBe('VALID')
      expect(report.daysSinceCertified).toBe(30)
      expect(report.stampDaysLeft).toBe(60)
      expect(healthSummary(doc, report)).toContain('Valid — stamp fresh, 60 stamp days left')
    })

    it('evaluates certified document as STALE_CERTIFICATION when police stamp exceeds 90 days', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      // 95 days old: exceeds the 90 day window
      const doc = createMockDoc({
        title: 'Certified Director ID Copy',
        isCertified: true,
        certifiedDate: '2026-05-29T00:00:00Z',
        expiryDate: null,
      })
      const report = assessDocHealth(doc, now)
      expect(report.health).toBe('STALE_CERTIFICATION')
      expect(report.daysSinceCertified).toBe(95)
      expect(report.stampDaysLeft).toBe(-5)
      expect(healthSummary(doc, report)).toContain('Police stamp 95 days old — exceeds 90-day window')
    })

    it('flags EXPIRED ahead of STALE_CERTIFICATION if both expiry and stamp have lapsed', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const doc = createMockDoc({
        expiryDate: '2026-08-15T00:00:00Z', // expired 17 days ago
        isCertified: true,
        certifiedDate: '2026-05-01T00:00:00Z', // 123 days old stamp
      })
      const report = assessDocHealth(doc, now)
      expect(report.health).toBe('EXPIRED')
    })
  })

  describe('3. Keyword Matching & Auto-Link Confidence (0.5 Threshold)', () => {
    it('verifies AUTO_LINK_THRESHOLD is strictly 0.5', () => {
      expect(AUTO_LINK_THRESHOLD).toBe(0.5)
    })

    it('matches vault docs by keywords and boosts confidence on category agreement', () => {
      const req = createMockReq({
        ruleKey: 'tax_pin', // hints: category 'COMPLIANCE', keywords: ['tax', 'tcs', 'sars', 'pin']
      })
      const vault: VaultDoc[] = [
        createMockDoc({
          id: 'v-tax-comp',
          title: 'SARS Tax Clearance Certificate (TCS PIN)',
          category: 'COMPLIANCE',
        }),
        createMockDoc({
          id: 'v-tax-fin',
          title: 'SARS Tax Assessment',
          category: 'FINANCIAL', // category mismatch penalty (-0.20)
        }),
        createMockDoc({
          id: 'v-other',
          title: 'Company Fleet Registration',
          category: 'GOVERNANCE',
        }),
      ]

      const matches = matchVaultDocsWithConfidence(req, vault)
      expect(matches.length).toBe(2)
      expect(matches[0].doc.id).toBe('v-tax-comp')
      expect(matches[0].confidence).toBeGreaterThan(matches[1].confidence)
      expect(matches[0].confidence).toBeGreaterThanOrEqual(AUTO_LINK_THRESHOLD)
    })

    it('auto-links best candidate when confidence >= 0.5', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const req = createMockReq({ ruleKey: 'tax_pin' })
      const vault: VaultDoc[] = [
        createMockDoc({
          id: 'v-tax',
          title: 'SARS Tax Clearance Certificate',
          category: 'COMPLIANCE',
          expiryDate: '2027-01-01',
        }),
      ]

      const updated = applyGapToRequirement(req, vault, now)
      expect(updated.linkedVaultDocId).toBe('v-tax')
      expect(updated.status).toBe('FULFILLED')
      expect(updated.reason).toContain('SARS Tax Clearance Certificate — Valid')
    })

    it('does NOT auto-link when confidence < 0.5 and requests user confirmation', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const req = createMockReq({
        ruleKey: 'tax_pin', // keywords: ['tax', 'tcs', 'sars', 'pin'], category: 'COMPLIANCE'
      })
      // Only 1 weak keyword match with category mismatch: confidence < 0.5
      const vault: VaultDoc[] = [
        createMockDoc({
          id: 'v-weak',
          title: 'Annual Income Tax Log',
          category: 'TECHNICAL', // mismatch
        }),
      ]

      const matches = matchVaultDocsWithConfidence(req, vault)
      expect(matches[0].confidence).toBeLessThan(AUTO_LINK_THRESHOLD)

      const updated = applyGapToRequirement(req, vault, now)
      expect(updated.linkedVaultDocId).toBeNull()
      expect(updated.status).toBe('OUTSTANDING')
      expect(updated.suggestedVaultDocIds).toContain('v-weak')
      expect(updated.reason).toContain('low confidence')
      expect(updated.reason).toContain('confirm manually')
    })

    it('marks requirement OUTSTANDING when no matching document exists in vault', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const req = createMockReq({ ruleKey: 'coida' })
      const vault: VaultDoc[] = [
        createMockDoc({
          id: 'v-other',
          title: 'Employee Safety Training Manual',
          category: 'TECHNICAL',
        }),
      ]

      const updated = applyGapToRequirement(req, vault, now)
      expect(updated.linkedVaultDocId).toBeNull()
      expect(updated.suggestedVaultDocIds).toHaveLength(0)
      expect(updated.status).toBe('OUTSTANDING')
      expect(updated.reason).toBe('No matching document found in the company vault.')
    })

    it('marks requirement as ACTION_REQUIRED if linked document is EXPIRED or STALE_CERTIFICATION', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const req = createMockReq({ ruleKey: 'coida' })
      const vault: VaultDoc[] = [
        createMockDoc({
          id: 'v-coida-exp',
          title: 'COIDA Letter of Good Standing',
          category: 'COMPLIANCE',
          expiryDate: '2026-07-01', // expired 2 months ago
        }),
      ]

      const updated = applyGapToRequirement(req, vault, now)
      expect(updated.linkedVaultDocId).toBe('v-coida-exp')
      expect(updated.status).toBe('ACTION_REQUIRED')
      expect(updated.reason).toContain('Expired')
    })

    it('tie-breaks multiple linkable matches by health ranking and earliest expiry', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const req = createMockReq({ ruleKey: 'tax_pin' })
      const vault: VaultDoc[] = [
        createMockDoc({
          id: 'v-tax-exp',
          title: 'SARS Tax Clearance 2025',
          category: 'COMPLIANCE',
          expiryDate: '2026-01-01', // EXPIRED (rank 0)
        }),
        createMockDoc({
          id: 'v-tax-valid-1',
          title: 'SARS Tax Clearance 2026',
          category: 'COMPLIANCE',
          expiryDate: '2027-06-01', // VALID (rank 3), expires 2027-06-01
        }),
        createMockDoc({
          id: 'v-tax-valid-2',
          title: 'SARS Tax Clearance TCS PIN 2026',
          category: 'COMPLIANCE',
          expiryDate: '2027-02-01', // VALID (rank 3), expires 2027-02-01 (freshest / earliest expiry)
        }),
      ]

      const updated = applyGapToRequirement(req, vault, now)
      expect(updated.linkedVaultDocId).toBe('v-tax-valid-2')
      expect(updated.status).toBe('FULFILLED')
    })

    it('applyGapToRequirements evaluates multiple requirements across vault returnables', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const reqs: RequirementRecord[] = [
        createMockReq({ id: 'r-1', ruleKey: 'tax_pin', title: 'Tax PIN' }),
        createMockReq({ id: 'r-2', ruleKey: 'cipc', title: 'CIPC Registration' }),
      ]

      const updated = applyGapToRequirements(reqs, MOCK_VAULT, now)
      expect(updated).toHaveLength(2)
      expect(updated.find((r) => r.ruleKey === 'tax_pin')?.linkedVaultDocId).toBe('vd-tax')
      expect(updated.find((r) => r.ruleKey === 'cipc')?.linkedVaultDocId).toBe('vd-cipc')
    })
  })

  describe('4. Readiness Gate, Closing Date Evaluation & Score Calculation', () => {
    it('detects documents that will expire before the tender closing date', () => {
      // Document is valid today (2026-09-01) but expires on 2026-10-15.
      // Tender closing date is 2026-10-31!
      const vault: VaultDoc[] = [
        createMockDoc({
          id: 'v-temp',
          title: 'Short-term Tax Clearance',
          category: 'COMPLIANCE',
          expiryDate: '2026-10-15',
        }),
      ]
      const tender: TenderRecord = {
        id: 'tender-1',
        title: 'Municipal Works',
        referenceNumber: 'RFP-01',
        issuingBody: 'City',
        closingDate: '2026-10-31',
        submissionMethod: 'PHYSICAL',
        submissionAddress: 'City Hall',
        signatureChecks: {},
        status: 'IN_PROGRESS',
        createdAt: '2026-08-01',
        fileName: 'rfp.pdf',
        fileUrl: 'documents/rfp.pdf',
        numPages: 10,
        ocrPages: 0,
        requirements: [
          createMockReq({
            id: 'r-1',
            ruleKey: 'tax_pin',
            linkedVaultDocId: 'v-temp',
            status: 'FULFILLED',
          }),
        ],
      }

      const docs = docsAtClosing(tender, vault)
      expect(docs).toHaveLength(1)
      expect(docs[0].willFail).toBe(true)
      expect(docs[0].healthAtClosing.health).toBe('EXPIRED')
    })

    it('identifies signature rule keys and checks confirmed status', () => {
      const tender: TenderRecord = {
        id: 'tender-1',
        title: 'Tender',
        referenceNumber: 'REF',
        issuingBody: 'Issuer',
        closingDate: '2026-12-31',
        submissionMethod: 'PHYSICAL',
        submissionAddress: 'Drop Box',
        signatureChecks: {
          sbd_forms: true,
          signed_initialled: false,
        },
        status: 'IN_PROGRESS',
        createdAt: '2026-08-01',
        fileName: 'rfp.pdf',
        fileUrl: '',
        numPages: 10,
        ocrPages: 0,
        requirements: [
          createMockReq({ id: 'r-sbd', ruleKey: 'sbd_forms' }),
          createMockReq({ id: 'r-sign', ruleKey: 'signed_initialled' }),
        ],
      }

      const sigKeys = signatureRuleKeys(tender)
      expect(sigKeys).toContain('sbd_forms')
      expect(sigKeys).toContain('signed_initialled')
      for (const k of sigKeys) {
        expect(SIGNATURE_RULE_KEYS).toContain(k)
      }
    })

    it('verifies company details consistency and reports missing required fields', () => {
      const incompleteCompany: CompanyProfile = {
        ...MOCK_COMPANY,
        taxPin: '',
        vatNumber: '',
        csdSupplierNumber: '',
      }
      const tender: TenderRecord = {
        id: 'tender-1',
        title: 'Tender',
        referenceNumber: 'REF',
        issuingBody: 'Issuer',
        closingDate: '2026-12-31',
        submissionMethod: 'PHYSICAL',
        submissionAddress: 'Drop Box',
        signatureChecks: {},
        status: 'IN_PROGRESS',
        createdAt: '2026-08-01',
        fileName: 'rfp.pdf',
        fileUrl: '',
        numPages: 10,
        ocrPages: 0,
        requirements: [
          createMockReq({ id: 'r-1', title: 'SARS Tax Pin Requirement' }),
          createMockReq({ id: 'r-2', title: 'CSD Supplier Registration' }),
        ],
      }

      const mismatches = checkCompanyDetails(tender, incompleteCompany)
      expect(mismatches.some((m) => m.field === 'Tax PIN')).toBe(true)
      expect(mismatches.some((m) => m.field === 'CSD supplier number')).toBe(true)
    })

    it('calculates readiness score and determines ready status (false when blocking checks fail)', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const tender: TenderRecord = {
        id: 'tender-1',
        title: 'Municipal Works',
        referenceNumber: 'RFP-01',
        issuingBody: 'City of Ekurhuleni',
        closingDate: '2026-10-31',
        submissionMethod: 'PHYSICAL',
        submissionAddress: 'Civic Centre',
        signatureChecks: {
          sbd_forms: true,
        },
        status: 'IN_PROGRESS',
        createdAt: '2026-08-01',
        fileName: 'rfp.pdf',
        fileUrl: '',
        numPages: 10,
        ocrPages: 0,
        requirements: [
          createMockReq({
            id: 'r-1',
            ruleKey: 'sbd_forms',
            status: 'OUTSTANDING', // unfulfilled -> requirements check fails
          }),
        ],
      }

      const report = assessReadiness(tender, MOCK_VAULT, MOCK_COMPANY, now)
      expect(report.ready).toBe(false)
      expect(report.blockingFailedCount).toBeGreaterThan(0)
      expect(report.score).toBeLessThan(100)
      expect(report.nextBestAction).not.toBeNull()
    })

    it('achieves 100% readiness score and ready = true when all criteria are satisfied', () => {
      const now = new Date('2026-09-01T00:00:00Z')
      const vault: VaultDoc[] = [
        createMockDoc({
          id: 'v-tax-fresh',
          title: 'SARS Tax Clearance Certificate',
          category: 'COMPLIANCE',
          expiryDate: '2027-12-31',
        }),
      ]

      const tender: TenderRecord = {
        id: 'tender-1',
        title: 'Municipal Works',
        referenceNumber: 'RFP-01',
        issuingBody: 'City of Ekurhuleni',
        closingDate: '2026-10-31',
        submissionMethod: 'PHYSICAL',
        submissionAddress: 'Civic Centre',
        signatureChecks: {},
        status: 'IN_PROGRESS',
        createdAt: '2026-08-01',
        fileName: 'rfp.pdf',
        fileUrl: '',
        numPages: 10,
        ocrPages: 0,
        requirements: [
          createMockReq({
            id: 'r-1',
            ruleKey: 'tax_pin',
            status: 'FULFILLED',
            linkedVaultDocId: 'v-tax-fresh',
          }),
        ],
      }

      const report = assessReadiness(tender, vault, MOCK_COMPANY, now)
      expect(report.ready).toBe(true)
      expect(report.blockingFailedCount).toBe(0)
      expect(report.score).toBe(100)
      expect(report.nextBestAction).toBeNull()
    })
  })
})

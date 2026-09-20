/**
 * Phase 4 blocker remediation — silent-loss regressions.
 *
 * D1: copying a demo tender must not carry vault references that the target
 * workspace cannot satisfy (the copy would be rejected on save, leaving a
 * false "Copied" success).
 * D2: the outcome dialog collects a civil date but the persisted field is an
 * RFC3339 instant; conversion must produce a schema-valid value or fail closed.
 */
import { describe, expect, it } from 'vitest'
import { cleanCopiedTender } from '../src/renderer/src/components/TenderLifecyclePanel'
import { civilDateToRfc3339 } from '../src/renderer/src/components/OutcomeDialog'
import { validateTendersDataV2 } from '../src/shared/tenders-schema'
import { makeLifecycleEvent } from '../src/shared/lifecycle'
import type {
  CompanyProfile,
  RequirementRecord,
  TenderRecord,
  TendersDataV2,
  TendersWorkspaceV2,
  VaultDoc,
} from '../src/shared/types'

const AT = '2026-09-01T00:00:00.000Z'

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
    description: 'Synthetic.',
    address: '1 Test Street',
    phone: '+27 10 000 0000',
    email: 'test@example.test',
    website: 'https://example.test',
    directors: [],
    projects: [],
  }
}

function vaultDoc(id: string): VaultDoc {
  return {
    id,
    title: `Doc ${id}`,
    category: 'COMPLIANCE',
    fileUrl: `vault/${id}.pdf`,
    issueDate: null,
    expiryDate: '2027-01-01',
    isCertified: false,
    certifiedDate: null,
    metadata: {},
  }
}

function requirement(overrides: Partial<RequirementRecord> = {}): RequirementRecord {
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
    status: 'OUTSTANDING',
    linkedVaultDocId: null,
    reason: null,
    suggestedVaultDocIds: [],
    ...overrides,
  }
}

function demoTender(): TenderRecord {
  return {
    id: 'tender-demo',
    title: 'Sample tender',
    referenceNumber: 'DEMO-001',
    issuingBody: 'Sample issuer',
    closingDate: '2026-12-18',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: null,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: AT,
    fileName: 'demo.pdf',
    fileUrl: 'documents/demo.pdf',
    numPages: 2,
    ocrPages: 0,
    requirements: [
      requirement({ id: 'req-a', linkedVaultDocId: 'vd-demo', suggestedVaultDocIds: ['vd-demo'] }),
      requirement({
        id: 'req-b',
        ruleKey: 'cipc',
        linkedVaultDocId: null,
        suggestedVaultDocIds: ['vd-demo'],
      }),
    ],
  }
}

function workspace(
  id: string,
  dataOrigin: 'user' | 'demo',
  vaultIds: string[],
  tenders: TenderRecord[],
): TendersWorkspaceV2 {
  return {
    id,
    name: id,
    dataOrigin,
    company: company(),
    customers: [],
    vault: vaultIds.map(vaultDoc),
    tenders,
  }
}

function documentV2(workspaces: TendersWorkspaceV2[], activeCompanyId: string): TendersDataV2 {
  return {
    schemaVersion: 2,
    revision: 0,
    updatedAt: AT,
    activeCompanyId,
    workspaces,
    issuerTemplates: [],
  }
}

function asCopy(tender: TenderRecord): TenderRecord {
  return {
    ...tender,
    id: 't-copy',
    status: 'IN_PROGRESS',
    submission: null,
    outcome: null,
    linkedCrmDealId: null,
    lifecycle: [makeLifecycleEvent(null, 'IN_PROGRESS', 'Copied from the sample workspace', AT)],
  }
}

describe('D1 — copying a demo tender into a user workspace', () => {
  const targetVaultIds = new Set(['vd-target'])

  it('an un-cleaned copy is schema-invalid (documents the silent-loss defect)', () => {
    const demo = demoTender()
    const naive = asCopy(structuredClone(demo)) // no reference cleanup
    const target = workspace('ws-user', 'user', ['vd-target'], [naive])
    const demoWs = workspace('ws-demo', 'demo', ['vd-demo'], [demo])
    const result = validateTendersDataV2(documentV2([demoWs, target], target.id))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) => /linkedVaultDocId/.test(issue.path) || /vault/i.test(issue.message),
        ),
      ).toBe(true)
    }
  })

  it('drops references the target vault cannot satisfy and validates', () => {
    const demo = demoTender()
    const cleaned = asCopy(cleanCopiedTender(demo, targetVaultIds))
    const target = workspace('ws-user', 'user', ['vd-target'], [cleaned])
    const demoWs = workspace('ws-demo', 'demo', ['vd-demo'], [demo])

    expect(cleaned.requirements[0].linkedVaultDocId).toBeNull()
    expect(cleaned.requirements[0].suggestedVaultDocIds).toEqual([])
    expect(cleaned.requirements[1].suggestedVaultDocIds).toEqual([])

    const result = validateTendersDataV2(documentV2([demoWs, target], target.id))
    expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true)
    if (result.ok) {
      // The e2e contract on the copied tender.
      const copied = result.data.workspaces.find((ws) => ws.id === 'ws-user')!.tenders[0]
      expect(copied.status).toBe('IN_PROGRESS')
      expect(copied.submission).toBeNull()
      expect(copied.outcome).toBeNull()
      expect(copied.linkedCrmDealId ?? null).toBeNull()
      expect(copied.lifecycle?.[0].reason).toBe('Copied from the sample workspace')
      // The demo workspace keeps its own record.
      expect(result.data.workspaces.find((ws) => ws.id === 'ws-demo')!.tenders[0].id).toBe(
        'tender-demo',
      )
    }
  })

  it('keeps a reference that the target vault actually provides', () => {
    const demo = demoTender()
    const withTargetRef: TenderRecord = {
      ...demo,
      requirements: [
        requirement({
          id: 'req-a',
          linkedVaultDocId: 'vd-target',
          suggestedVaultDocIds: ['vd-target'],
        }),
      ],
    }
    const cleaned = cleanCopiedTender(withTargetRef, targetVaultIds)
    expect(cleaned.requirements[0].linkedVaultDocId).toBe('vd-target')
    expect(cleaned.requirements[0].suggestedVaultDocIds).toEqual(['vd-target'])
    const target = workspace('ws-user', 'user', ['vd-target'], [asCopy(cleaned)])
    const demoWs = workspace('ws-demo', 'demo', ['vd-demo'], [demo])
    const result = validateTendersDataV2(documentV2([demoWs, target], target.id))
    expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true)
  })

  it('does not mutate the source tender', () => {
    const demo = demoTender()
    cleanCopiedTender(demo, targetVaultIds)
    expect(demo.requirements[0].linkedVaultDocId).toBe('vd-demo')
    expect(demo.requirements[0].suggestedVaultDocIds).toEqual(['vd-demo'])
  })
})

describe('D2 — outcome notice date conversion', () => {
  it('converts the e2e civil date to an RFC3339 instant', () => {
    expect(civilDateToRfc3339('2026-10-01')).toBe('2026-10-01T00:00:00.000Z')
  })

  it('returns null for an empty field (explicitly cleared)', () => {
    expect(civilDateToRfc3339('')).toBeNull()
    expect(civilDateToRfc3339(null)).toBeNull()
    expect(civilDateToRfc3339(undefined)).toBeNull()
    expect(civilDateToRfc3339('   ')).toBeNull()
  })

  it('rejects malformed and impossible dates instead of producing a wrong instant', () => {
    expect(civilDateToRfc3339('2026-2-1')).toBeNull()
    expect(civilDateToRfc3339('not-a-date')).toBeNull()
    expect(civilDateToRfc3339('2026-02-30')).toBeNull()
    expect(civilDateToRfc3339('2026-13-01')).toBeNull()
  })

  it('produces a value the outcome schema accepts', () => {
    const noticeDate = civilDateToRfc3339('2026-10-01')
    const tender: TenderRecord = {
      ...demoTender(),
      status: 'WON',
      requirements: [],
      outcome: {
        status: 'won',
        noticeDate,
        reason: null,
        awardedValue: 1250000,
        evidenceReference: null,
        recordedAt: AT,
      },
    }
    const demoWs = workspace('ws-demo', 'demo', ['vd-demo'], [tender])
    const target = workspace('ws-user', 'user', ['vd-target'], [])
    const result = validateTendersDataV2(documentV2([demoWs, target], 'ws-user'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.workspaces[0].tenders[0].outcome?.noticeDate).toBe(
        '2026-10-01T00:00:00.000Z',
      )
    }
  })
})

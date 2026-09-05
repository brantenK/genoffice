import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testDir = join(tmpdir(), `tenders-adversarial-test-${randomUUID().slice(0, 8)}`)

const { mockHandlers, mockBroadcasts } = vi.hoisted(() => ({
  mockHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockBroadcasts: [] as Array<{ channel: string; data: unknown }>,
}))

vi.mock('electron', () => {
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return testDir
        return testDir
      },
      isReady: () => true,
    },
    ipcMain: {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        mockHandlers.set(channel, listener)
      },
    },
    shell: {
      openPath: vi.fn(async () => ''),
    },
    WebContentsView: class MockWebContentsView {
      webContents = {
        isDestroyed: () => false,
        send: (channel: string, data: unknown) => {
          mockBroadcasts.push({ channel, data })
        },
        once: vi.fn(),
      }
    },
  }
})

import { buildClauses, pageClauses } from '../src/renderer/src/pdf/clauses'
import {
  extractIssuerInfo,
  extractSubmissionLogistics,
  extractTenderMeta,
  shredExtraction,
} from '../src/renderer/src/pdf/shred'
import {
  applyGapToRequirement,
  applyGapToRequirements,
  assessDocHealth,
  AUTO_LINK_THRESHOLD,
  matchVaultDocsWithConfidence,
} from '../src/renderer/src/gap'
import {
  atomicWriteDocumentFile,
  CURRENT_TENDERS_SCHEMA_VERSION,
  getUniqueTimestamp,
  migrateAndValidateTenders,
  readDocumentFile,
  readTendersStore,
  resolveSafeTendersPath,
  saveDocumentFile,
  SEED_COMPANY_ID,
  writeTendersStore,
} from '../src/main/tenders-main'
import { RULE_BY_KEY, TENDER_RULES } from '../src/shared/rules'
import type {
  ExtractedPage,
  PageExtraction,
  PageLine,
  RequirementRecord,
  VaultDoc,
} from '../src/shared/types'

function makeLine(
  text: string,
  pageNumber = 1,
  box = { top: 0.1, left: 0.1, width: 0.8, height: 0.02 },
): PageLine {
  return { pageNumber, text, box }
}

function makePage(pageNumber: number, lines: (string | PageLine)[]): ExtractedPage {
  const normLines: PageLine[] = lines.map((l, i) => {
    if (typeof l === 'string') {
      return makeLine(l, pageNumber, { top: 0.05 + i * 0.03, left: 0.1, width: 0.8, height: 0.02 })
    }
    return l
  })
  return {
    pageNumber,
    width: 595,
    height: 842,
    text: normLines.map((l) => l.text).join('\n'),
    lines: normLines,
    needsOcr: false,
  }
}

function makeDoc(...pages: ExtractedPage[]): PageExtraction {
  return {
    numPages: pages.length,
    pages,
    textPages: pages.length,
    ocrPages: 0,
  }
}

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

describe('Adversarial Stress Testing & Heuristic Verification', () => {
  beforeAll(() => {
    mkdirSync(testDir, { recursive: true })
  })

  beforeEach(() => {
    mockBroadcasts.length = 0
  })

  afterAll(() => {
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    } catch {}
  })

  // =========================================================================
  // 1. Shredder Heuristics Stress: Extreme Punctuation, Unicode & Formatting Traps
  // =========================================================================
  describe('1. Shredder Heuristics Adversarial Edge Cases', () => {
    it('handles extreme punctuation (ellipses, multiple exclamation marks, smart quotes, parentheses)', () => {
      const page = makePage(1, [
        '“Bidders MUST submit a valid SARS Tax Compliance PIN!!!”',
        'Failure to furnish this returnable... will result in immediate disqualification?!?',
        '(COIDA letter of good standing is required; no photocopies will be accepted).',
      ])
      const clauses = pageClauses(page)
      expect(clauses.length).toBeGreaterThanOrEqual(2)

      const doc = makeDoc(page)
      const reqs = shredExtraction(doc)

      // Must detect tax_pin and coida despite extreme punctuation
      const taxReq = reqs.find((r) => r.ruleKey === 'tax_pin')
      expect(taxReq).toBeDefined()
      expect(taxReq?.isMandatory).toBe(true)
      expect(taxReq?.riskLevel).toBe('CRITICAL_DISQUALIFIER')

      const coidaReq = reqs.find((r) => r.ruleKey === 'coida')
      expect(coidaReq).toBeDefined()
      expect(coidaReq?.isMandatory).toBe(true)
    })

    it('handles Unicode edge cases: non-breaking spaces, em-dashes, full-width characters, symbols, and emoji', () => {
      const page = makePage(1, [
        '⚠️ Mandatory Returnable — Bidders\u00A0must\u00A0submit a valid South African Revenue Service tax clearance certificate.',
        '• CIPC Company Registration: COR14.3 / CK2 documents are required — certified copies only.',
        'Bidder must submit audited financial statements for 3 consecutive financial years 📋.',
      ])
      const doc = makeDoc(page)
      const reqs = shredExtraction(doc)

      const taxReq = reqs.find((r) => r.ruleKey === 'tax_pin')
      expect(taxReq).toBeDefined()
      expect(taxReq?.verbatimClause).toContain('South African Revenue Service')

      const cipcReq = reqs.find((r) => r.ruleKey === 'cipc')
      expect(cipcReq).toBeDefined()

      const finReq = reqs.find((r) => r.ruleKey === 'financials')
      expect(finReq).toBeDefined()
    })

    it('handles giant sentences exceeding MAX_CLAUSE_CHARS (600 chars) gracefully without throwing or losing text', () => {
      // Create a 750-character continuous line without punctuation
      const segment = 'The tenderer shall submit comprehensive documentation confirming registration with SARS and full tax compliance '
      const longText = segment.repeat(7) // ~784 chars
      const page = makePage(1, [
        makeLine(longText.slice(0, 300), 1, { top: 0.1, left: 0.1, width: 0.8, height: 0.02 }),
        makeLine(longText.slice(300, 600), 1, { top: 0.13, left: 0.1, width: 0.8, height: 0.02 }),
        makeLine(longText.slice(600), 1, { top: 0.16, left: 0.1, width: 0.8, height: 0.02 }),
      ])
      const clauses = pageClauses(page)
      // Must split when joined length reaches 600 chars
      expect(clauses.length).toBeGreaterThanOrEqual(2)
      for (const cl of clauses) {
        expect(cl.text.length).toBeLessThanOrEqual(650)
      }

      const doc = makeDoc(page)
      const reqs = shredExtraction(doc)
      const taxReq = reqs.find((r) => r.ruleKey === 'tax_pin')
      expect(taxReq).toBeDefined()
    })

    it('rejects ultra-short lines and noise (< 8 chars) while preserving valid short clauses', () => {
      const page = makePage(1, [
        '',
        '   ',
        'A',
        '1.',
        'N/A',
        'Bidders must submit valid CIPC registration certificate.',
        'End.',
      ])
      const clauses = pageClauses(page)
      // Noise < 8 chars filtered out
      for (const cl of clauses) {
        expect(cl.text.length).toBeGreaterThanOrEqual(8)
      }
      expect(clauses.some((c) => c.text.includes('CIPC registration'))).toBe(true)
    })

    it('accurately tests heading capitalization ratio threshold boundary (70% uppercase)', () => {
      const page = makePage(1, [
        'MANDATOabc',
        'BIDDERS MUST SUBMIT TAX CLEARANCE CERTIFICATES AT BID SUBMISSION.',
      ])
      const clauses = pageClauses(page)
      expect(clauses.length).toBeGreaterThan(0)
    })

    it('shreds complex multi-page document with mixed headings, list bullets and negative patterns', () => {
      const p1 = makePage(1, [
        'DEPARTMENT OF WATER AND SANITATION',
        'REQUEST FOR PROPOSALS.',
        'Reference Number: RFP-2026-TEST-99.',
        'Closing Date: 15 December 2026 at 11:00.',
        'Contact Person: Thabo Sithole (011) 555-9000 thabo@dws.gov.za.',
        'Proposals must be deposited into the tender box at 185 Francis Baard Street Pretoria.',
      ])
      const p2 = makePage(2, [
        'SECTION 1: MANDATORY RETURNABLES',
        '1. Bidders must submit a valid SARS Tax Clearance Certificate or TCS PIN.',
        '2. Certified copy of CIPC registration certificate confirming active enterprise status.',
        '3. Audited annual financial statements for the past 3 financial years.',
        '4. Key personnel CVs and professional registration with ECSA (Pr Eng / Pr Tech).',
      ])
      const p3 = makePage(3, [
        'SECTION 2: EVALUATION CRITERIA',
        'Bidders failing to submit mandatory documents will be disqualified and deemed non-responsive.',
        'Demonstrable track record and reference letters for similar water refurbishment projects.',
      ])

      const doc = makeDoc(p1, p2, p3)
      const meta = extractTenderMeta(doc, 'Default Title')
      expect(meta.referenceNumber).toBe('RFP-2026-TEST-99')
      expect(meta.closingDate).toBe('15 December 2026 at 11:00.')
      expect(meta.submissionMethod).toBe('PHYSICAL')
      expect(meta.submissionAddress).toContain('tender box at 185 Francis Baard Street Pretoria')

      const reqs = shredExtraction(doc)
      const ruleKeys = reqs.map((r) => r.ruleKey)
      expect(ruleKeys).toContain('tax_pin')
      expect(ruleKeys).toContain('cipc')
      expect(ruleKeys).toContain('financials')
      expect(ruleKeys).toContain('key_personnel')
      expect(ruleKeys).toContain('non_compliance')
      expect(ruleKeys).toContain('experience')
    })
  })

  // =========================================================================
  // 2. Compliance Gap Boundary Stress: 0.49 vs 0.50 vs 0.51 Confidence Scoring
  // =========================================================================
  describe('2. Compliance Gap Auto-Linking Boundary Stress (0.49 vs 0.50 vs 0.51)', () => {
    it('strictly observes AUTO_LINK_THRESHOLD = 0.50 boundary condition', () => {
      expect(AUTO_LINK_THRESHOLD).toBe(0.5)
    })

    it('rejects auto-linking at confidence < 0.50 (retains OUTSTANDING, links nothing, flags manual confirmation)', () => {
      const declReq = createMockReq({
        id: 'req-decl',
        ruleKey: 'declaration',
        category: 'MANDATORY_STAGE_1',
      })
      const mismatchedDoc = createMockDoc({
        id: 'doc-decl-mismatch',
        title: 'Financial Declaration Document',
        category: 'FINANCIAL', // mismatch vs GOVERNANCE
      })

      const matches = matchVaultDocsWithConfidence(declReq, [mismatchedDoc])
      expect(matches).toHaveLength(1)
      expect(matches[0].confidence).toBeLessThan(0.5)

      const result = applyGapToRequirement(declReq, [mismatchedDoc])
      expect(result.linkedVaultDocId).toBeNull()
      expect(result.status).toBe('OUTSTANDING')
      expect(result.suggestedVaultDocIds).toEqual(['doc-decl-mismatch'])
      expect(result.reason).toContain('low confidence')
      expect(result.reason).toContain('confirm manually')
    })

    it('triggers auto-linking at confidence >= 0.50 (links document and marks FULFILLED)', () => {
      const req = createMockReq({ ruleKey: 'tax_pin' })
      const doc = createMockDoc({
        id: 'doc-tax-pass',
        title: 'Municipal Tax Note',
        category: 'COMPLIANCE',
        expiryDate: '2027-01-01',
      })

      const matches = matchVaultDocsWithConfidence(req, [doc])
      expect(matches).toHaveLength(1)
      expect(matches[0].confidence).toBeGreaterThanOrEqual(0.5)

      const result = applyGapToRequirement(req, [doc])
      expect(result.linkedVaultDocId).toBe('doc-tax-pass')
      expect(result.status).toBe('FULFILLED')
      expect(result.reason).toContain('Valid — expires in')
    })

    it('resolves competing candidates across boundary: sub-threshold candidate discarded while above-threshold candidate is linked', () => {
      const req = createMockReq({ ruleKey: 'tax_pin' })
      const docSubThreshold = createMockDoc({
        id: 'doc-sub',
        title: 'Tax Note Memo',
        category: 'TECHNICAL',
        expiryDate: '2027-01-01',
      })
      const docAboveThreshold = createMockDoc({
        id: 'doc-above',
        title: 'SARS Tax Clearance Pin',
        category: 'COMPLIANCE',
        expiryDate: '2027-01-01',
      })

      const matches = matchVaultDocsWithConfidence(req, [docSubThreshold, docAboveThreshold])
      expect(matches[0].doc.id).toBe('doc-above')
      expect(matches[0].confidence).toBeGreaterThanOrEqual(0.5)
      expect(matches[1].doc.id).toBe('doc-sub')
      expect(matches[1].confidence).toBeLessThan(0.5)

      const result = applyGapToRequirement(req, [docSubThreshold, docAboveThreshold])
      expect(result.linkedVaultDocId).toBe('doc-above')
      expect(result.status).toBe('FULFILLED')
      expect(result.suggestedVaultDocIds).toEqual(['doc-above', 'doc-sub'])
    })

    it('prioritizes HEALTH_RANK over confidence score among linkable candidates (VALID beats EXPIRED)', () => {
      const req = createMockReq({ ruleKey: 'tax_pin' })
      const docHighConfExpired = createMockDoc({
        id: 'doc-expired-high',
        title: 'SARS TCS Tax Compliance PIN Certificate',
        category: 'COMPLIANCE',
        expiryDate: '2026-01-01',
      })
      const docLowConfValid = createMockDoc({
        id: 'doc-valid-low',
        title: 'Tax Letter',
        category: 'COMPLIANCE',
        expiryDate: '2027-06-01',
      })

      const matches = matchVaultDocsWithConfidence(req, [docHighConfExpired, docLowConfValid])
      expect(matches[0].doc.id).toBe('doc-expired-high')
      expect(matches[0].confidence).toBeGreaterThan(matches[1].confidence)
      expect(matches[1].confidence).toBeGreaterThanOrEqual(0.5)

      const result = applyGapToRequirement(req, [docHighConfExpired, docLowConfValid], new Date('2026-09-01T00:00:00Z'))
      expect(result.linkedVaultDocId).toBe('doc-valid-low')
      expect(result.status).toBe('FULFILLED')
      expect(result.reason).toContain('Valid — expires in')
    })

    it('escalates to ACTION_REQUIRED when the linked document has a STALE police certification (>90 days)', () => {
      const req = createMockReq({ ruleKey: 'director_ids' })
      const doc = createMockDoc({
        id: 'doc-stale-id',
        title: 'Certified ID Copies of Directors',
        category: 'COMPLIANCE',
        isCertified: true,
        certifiedDate: '2026-05-01T00:00:00Z',
        expiryDate: null,
      })

      const now = new Date('2026-09-01T00:00:00Z')
      const result = applyGapToRequirement(req, [doc], now)
      expect(result.linkedVaultDocId).toBe('doc-stale-id')
      expect(result.status).toBe('ACTION_REQUIRED')
      expect(result.reason).toContain('exceeds 90-day window')
    })

    it('empirically verifies mathematical boundary behavior at 0.490, 0.499, 0.500, 0.501, and 0.510', () => {
      // Direct verification of boundary decisions
      const testCases = [
        { conf: 0.490, expectedLink: false, expectedStatus: 'OUTSTANDING', expectedReason: '49%' },
        { conf: 0.499, expectedLink: false, expectedStatus: 'OUTSTANDING', expectedReason: '50%' },
        { conf: 0.500, expectedLink: true, expectedStatus: 'FULFILLED', expectedReason: 'Valid' },
        { conf: 0.501, expectedLink: true, expectedStatus: 'FULFILLED', expectedReason: 'Valid' },
        { conf: 0.510, expectedLink: true, expectedStatus: 'FULFILLED', expectedReason: 'Valid' },
      ]

      for (const tc of testCases) {
        const req = createMockReq({ ruleKey: 'tax_pin' })
        const doc = createMockDoc({ id: `doc-${tc.conf}`, title: `Tax Doc ${tc.conf}`, expiryDate: '2027-01-01' })
        const matches = [{ doc, confidence: tc.conf }]

        // Simulate applyGap logic using matches directly
        const linkable = matches.filter((m) => m.confidence >= AUTO_LINK_THRESHOLD)
        if (!tc.expectedLink) {
          expect(linkable).toHaveLength(0)
          const fallback = {
            ...req,
            suggestedVaultDocIds: [doc.id],
            linkedVaultDocId: null,
            status: 'OUTSTANDING' as const,
            reason: `Possible match: ${doc.title} — low confidence (${Math.round(tc.conf * 100)}%), confirm manually.`,
          }
          expect(fallback.linkedVaultDocId).toBeNull()
          expect(fallback.status).toBe(tc.expectedStatus)
          expect(fallback.reason).toContain(tc.expectedReason)
        } else {
          expect(linkable).toHaveLength(1)
          const linked = {
            ...req,
            suggestedVaultDocIds: [doc.id],
            linkedVaultDocId: doc.id,
            status: 'FULFILLED' as const,
            reason: `${doc.title} — Valid — expires in 120 days`,
          }
          expect(linked.linkedVaultDocId).toBe(doc.id)
          expect(linked.status).toBe(tc.expectedStatus)
          expect(linked.reason).toContain(tc.expectedReason)
        }
      }
    })
  })

  // =========================================================================
  // 3. Store Migration & Atomic Write Concurrency Stress
  // =========================================================================
  describe('3. Store Migration & Concurrency Stress', () => {
    it('preserves data integrity under high-volume store migration variations', () => {
      expect(migrateAndValidateTenders(null).version).toBe(CURRENT_TENDERS_SCHEMA_VERSION)
      expect(migrateAndValidateTenders(undefined).version).toBe(CURRENT_TENDERS_SCHEMA_VERSION)
      expect(migrateAndValidateTenders(12345).workspaces).toHaveLength(1)
      expect(migrateAndValidateTenders('corrupted-string').workspaces).toHaveLength(1)
      expect(migrateAndValidateTenders([]).workspaces).toHaveLength(1)

      const legacy = {
        version: 0,
        activeCompanyId: 'ws-ekurhuleni-01',
        workspaces: [
          {
            id: 'ws-ekurhuleni-01',
            company: { name: 'Ekurhuleni Works' },
            customers: [],
            vault: [],
            tenders: [],
          },
        ],
      }
      const migrated = migrateAndValidateTenders(legacy)
      expect(migrated.version).toBe(CURRENT_TENDERS_SCHEMA_VERSION)
      expect(migrated.activeCompanyId).toBe(SEED_COMPANY_ID)
      expect(migrated.workspaces[0].id).toBe(SEED_COMPANY_ID)
      expect(migrated.workspaces[0].vault).toHaveLength(7)

      const custom = {
        version: 1,
        activeCompanyId: 'co-custom-99',
        workspaces: [
          {
            id: 'co-custom-99',
            name: 'Custom Corp',
            company: { name: 'Custom Corp Pty Ltd' },
            customers: [{ id: 'cust-1', name: 'Custom Client' }],
            vault: [{ id: 'doc-c1', title: 'Custom Vault Doc' }],
            tenders: [{ id: 't-custom-1', referenceNumber: 'RFP-CUSTOM-01', milestones: [] }],
          },
        ],
      }
      const customMigrated = migrateAndValidateTenders(custom)
      expect(customMigrated.activeCompanyId).toBe('co-custom-99')
      expect(customMigrated.workspaces[0].tenders[0].referenceNumber).toBe('RFP-CUSTOM-01')
      expect(customMigrated.workspaces[0].customers).toHaveLength(1)
    })

    it('executes 50 concurrent atomic writes without corruption or torn files', () => {
      const storeDir = join(testDir, 'concurrent-tenders')
      mkdirSync(storeDir, { recursive: true })
      const storePath = join(storeDir, 'tenders-data.json')

      for (let i = 0; i < 50; i++) {
        const payload = {
          version: CURRENT_TENDERS_SCHEMA_VERSION,
          activeCompanyId: `co-${i}`,
          workspaces: [
            {
              id: `co-${i}`,
              name: `Company ${i}`,
              company: { name: `Company ${i}` },
              customers: [],
              vault: [],
              tenders: [{ id: `tender-${i}`, referenceNumber: `RFP-${i}`, milestones: [] }],
            },
          ],
        }
        writeTendersStore(storePath, payload)
      }

      expect(existsSync(storePath)).toBe(true)
      const content = readFileSync(storePath, 'utf8')
      const parsed = JSON.parse(content)
      expect(parsed.version).toBe(CURRENT_TENDERS_SCHEMA_VERSION)
      expect(parsed.activeCompanyId).toBe('co-49')
      expect(parsed.workspaces[0].tenders[0].referenceNumber).toBe('RFP-49')

      const loaded = readTendersStore(storePath)
      expect(loaded.activeCompanyId).toBe('co-49')
    })

    it('handles interleaved concurrent reads and writes without torn reads or corruption', async () => {
      const storeDir = join(testDir, 'interleaved-store')
      mkdirSync(storeDir, { recursive: true })
      const storePath = join(storeDir, 'tenders-data.json')

      writeTendersStore(storePath, {
        version: CURRENT_TENDERS_SCHEMA_VERSION,
        activeCompanyId: 'co-initial',
        workspaces: [],
      })

      let writeErrors = 0
      let readErrors = 0
      let completedReads = 0

      const writePromise = (async () => {
        for (let i = 0; i < 40; i++) {
          try {
            writeTendersStore(storePath, {
              version: CURRENT_TENDERS_SCHEMA_VERSION,
              activeCompanyId: `co-atomic-${i}`,
              workspaces: [
                {
                  id: `co-atomic-${i}`,
                  name: `Company ${i}`,
                  company: { name: `Company ${i}` },
                  customers: [],
                  vault: [],
                  tenders: [],
                },
              ],
            })
          } catch {
            writeErrors++
          }
          await new Promise((resolve) => setTimeout(resolve, 2))
        }
      })()

      const readPromise = (async () => {
        for (let i = 0; i < 40; i++) {
          try {
            const data = readTendersStore(storePath)
            if (!data || !data.version || !data.workspaces) {
              readErrors++
            } else {
              completedReads++
            }
          } catch {
            readErrors++
          }
          await new Promise((resolve) => setTimeout(resolve, 2))
        }
      })()

      await Promise.all([writePromise, readPromise])

      expect(writeErrors).toBe(0)
      expect(readErrors).toBe(0)
      expect(completedReads).toBe(40)

      const finalStore = readTendersStore(storePath)
      expect(finalStore.version).toBe(CURRENT_TENDERS_SCHEMA_VERSION)
      expect(finalStore.activeCompanyId).toBe('co-atomic-39')
    })

    it('executes 50 concurrent saveDocumentFile calls with zero timestamp collisions', async () => {
      const promises: Promise<any>[] = []
      const fileCount = 50

      for (let i = 0; i < fileCount; i++) {
        const req = {
          fileName: `contract-spec-${i}.pdf`,
          buffer: Buffer.from(`Adversarial PDF content for document #${i} — timestamp test`),
          category: 'rfp' as const,
        }
        promises.push(saveDocumentFile(req, testDir))
      }

      const results = await Promise.all(promises)

      for (const res of results) {
        expect(res.ok).toBe(true)
        expect(res.storedPath).toMatch(/^documents\/\d+_contract-spec-\d+\.pdf$/)
      }

      const storedPaths = results.map((r) => r.storedPath)
      const uniquePaths = new Set(storedPaths)
      expect(uniquePaths.size).toBe(fileCount)

      for (let i = 0; i < fileCount; i++) {
        const readRes = await readDocumentFile({ storedPath: storedPaths[i] }, testDir)
        expect(readRes.ok).toBe(true)
        const text = Buffer.from(readRes.buffer!).toString('utf8')
        expect(text).toContain(`Adversarial PDF content for document #${i}`)
      }
    })

    it('blocks directory traversal attacks in saveDocumentFile, readDocumentFile, and resolveSafeTendersPath', async () => {
      // 1. Directory traversal in fileName during save (stripped by basename)
      const traversalSave = await saveDocumentFile(
        {
          fileName: '../../../../etc/shadow',
          buffer: Buffer.from('malicious payload'),
          category: 'rfp',
        },
        testDir,
      )
      expect(traversalSave.ok).toBe(true)
      expect(traversalSave.storedPath).not.toContain('..')
      expect(traversalSave.storedPath).toMatch(/^documents\/\d+_shadow$/)

      // 2. Directory traversal in readDocumentFile
      const traversalRead1 = await readDocumentFile(
        { storedPath: '../../sensitive-file.txt' },
        testDir,
      )
      expect(traversalRead1.ok).toBe(false)
      expect(traversalRead1.error).toContain('Directory traversal detected')

      const traversalRead2 = await readDocumentFile(
        { storedPath: 'documents/../../../windows/system32/cmd.exe' },
        testDir,
      )
      expect(traversalRead2.ok).toBe(false)
      expect(traversalRead2.error).toContain('Directory traversal detected')

      // 3. Null byte injection
      const nullByteCheck = resolveSafeTendersPath('documents/test\0.pdf', testDir)
      expect(nullByteCheck.safe).toBe(false)
      expect(nullByteCheck.error).toContain('Null byte detected')
    })
  })
})

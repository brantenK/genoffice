import { describe, expect, it } from 'vitest'
import { buildClauses, pageClauses, type Clause } from '../src/renderer/src/pdf/clauses'
import {
  extractIssuerInfo,
  extractSubmissionLogistics,
  extractTenderMeta,
  shredExtraction,
} from '../src/renderer/src/pdf/shred'
import {
  DISQUALIFIER_LANGUAGE,
  MANDATORY_LANGUAGE,
  RULE_BY_KEY,
  TENDER_RULES,
} from '../src/shared/rules'
import type { ExtractedPage, PageExtraction, PageLine } from '../src/shared/types'

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
      return makeLine(l, pageNumber, { top: 0.05 + i * 0.04, left: 0.1, width: 0.8, height: 0.025 })
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

describe('Shredder Heuristics & Clause Reconstruction', () => {
  describe('1. Clause Reconstruction & Noise Filtering in clauses.ts', () => {
    it('stitches wrapped lines into a single sentence-level clause', () => {
      const page = makePage(1, [
        'Bidders must submit a valid SARS Tax Clearance Certificate',
        'or TCS PIN issued by the South African Revenue Service',
        'confirming active tax compliance at bid closing.',
      ])
      const clauses = pageClauses(page)
      expect(clauses).toHaveLength(1)
      expect(clauses[0].text).toBe(
        'Bidders must submit a valid SARS Tax Clearance Certificate or TCS PIN issued by the South African Revenue Service confirming active tax compliance at bid closing.',
      )
      expect(clauses[0].lines).toHaveLength(3)
      expect(clauses[0].pageNumber).toBe(1)
    })

    it('flushes clauses upon encountering terminal sentence punctuation (.!?)', () => {
      const page = makePage(1, [
        'All bids will remain valid for 90 days from the closing date.',
        'Joint venture agreements must be registered with the CIPC and certified.',
      ])
      const clauses = pageClauses(page)
      expect(clauses).toHaveLength(2)
      expect(clauses[0].text).toContain('remain valid for 90 days')
      expect(clauses[1].text).toContain('Joint venture agreements must be registered')
    })

    it('splits clauses when a large vertical gap (paragraph break) is encountered', () => {
      const line1 = makeLine('Section 1: General Requirements.', 1, {
        top: 0.1,
        left: 0.1,
        width: 0.5,
        height: 0.02,
      })
      // Gap > 2.5 * height: next.top (0.25) - prevBottom (0.12) = 0.13 > 0.05
      const line2 = makeLine('Section 2: Technical Specifications continuation', 1, {
        top: 0.25,
        left: 0.1,
        width: 0.5,
        height: 0.02,
      })
      const page = makePage(1, [line1, line2])
      const clauses = pageClauses(page)
      expect(clauses).toHaveLength(2)
      expect(clauses[0].text).toBe('Section 1: General Requirements.')
      expect(clauses[1].text).toBe('Section 2: Technical Specifications continuation')
    })

    it('detects list item boundaries (bullets, numbers, letters) and starts new clauses', () => {
      const page = makePage(1, [
        'The contractor must satisfy the following criteria:',
        '1. Minimum 5 years demonstrable experience in bulk water pipeline infrastructure.',
        '2. Certified proof of ownership of yellow metal plant and earthmoving equipment.',
        '- Valid letter of good standing from the Compensation Commissioner.',
        '• Valid certified copy of B-BBEE rating certificate or sworn affidavit.',
        'a) Submission of audited annual financial statements for the past 3 financial years.',
      ])
      const clauses = pageClauses(page)
      expect(clauses.length).toBeGreaterThanOrEqual(5)
      expect(clauses.some((c) => c.text.startsWith('1.'))).toBe(true)
      expect(clauses.some((c) => c.text.startsWith('2.'))).toBe(true)
      expect(clauses.some((c) => c.text.startsWith('-'))).toBe(true)
      expect(clauses.some((c) => c.text.startsWith('•'))).toBe(true)
      expect(clauses.some((c) => c.text.startsWith('a)'))).toBe(true)
    })

    it('isolates ALL-CAPS headings as standalone clauses without joining body text', () => {
      const page = makePage(1, [
        'MANDATORY EVALUATION CRITERIA',
        'Bidders failing to submit required returnables will be declared non-responsive.',
      ])
      const clauses = pageClauses(page)
      expect(clauses).toHaveLength(2)
      expect(clauses[0].text).toBe('MANDATORY EVALUATION CRITERIA')
      expect(clauses[1].text).toContain('Bidders failing to submit')
    })

    it('discards noise lines shorter than 8 characters and ignores empty lines', () => {
      const page = makePage(1, [
        '   ',
        'Page 1',
        '',
        'Bulk water reticulation works contract specifications for municipal infrastructure.',
        '    ',
        'End',
      ])
      const clauses = pageClauses(page)
      expect(clauses).toHaveLength(1)
      expect(clauses[0].text).toBe(
        'Bulk water reticulation works contract specifications for municipal infrastructure.',
      )
    })

    it('splits clauses that exceed MAX_CLAUSE_CHARS (600 characters)', () => {
      const longSentencePart = 'The contractor shall continuously furnish and maintain all necessary equipment, materials, qualified personnel, and certified testing apparatus to ensure strict adherence to municipal standards. '
      const fullText = longSentencePart.repeat(5) // ~750 characters
      const lines = [
        fullText.slice(0, 200),
        fullText.slice(200, 400),
        fullText.slice(400, 600),
        fullText.slice(600),
      ]
      const page = makePage(1, lines)
      const clauses = pageClauses(page)
      expect(clauses.length).toBeGreaterThan(1)
      for (const clause of clauses) {
        expect(clause.lines.length).toBeGreaterThan(0)
      }
    })

    it('computes accurate union bounding boxes across stitched lines', () => {
      const l1 = makeLine('Line one text without punctuation', 1, { top: 0.1, left: 0.15, width: 0.4, height: 0.03 })
      const l2 = makeLine('Line two text continues here.', 1, { top: 0.14, left: 0.1, width: 0.6, height: 0.03 })
      const page = makePage(1, [l1, l2])
      const clauses = pageClauses(page)
      expect(clauses).toHaveLength(1)
      const box = clauses[0].box
      expect(box.left).toBeCloseTo(0.1)
      expect(box.top).toBeCloseTo(0.1)
      // right is max(0.15 + 0.4, 0.1 + 0.6) = 0.7. width = 0.7 - 0.1 = 0.6
      expect(box.width).toBeCloseTo(0.6)
      // bottom is max(0.1 + 0.03, 0.14 + 0.03) = 0.17. height = 0.17 - 0.1 = 0.07
      expect(box.height).toBeCloseTo(0.07)
    })

    it('buildClauses stitches across multiple pages in correct reading order', () => {
      const page1 = makePage(1, ['First page requirements text clause.'])
      const page2 = makePage(2, ['Second page specifications text clause.'])
      const doc = makeDoc(page1, page2)
      const clauses = buildClauses(doc)
      expect(clauses).toHaveLength(2)
      expect(clauses[0].pageNumber).toBe(1)
      expect(clauses[1].pageNumber).toBe(2)
    })
  })

  describe('2. Rule Matching, Scoring & Confidence Heuristics in shred.ts', () => {
    it('verifies the shared rule catalogue contains 25 comprehensive evaluation rules', () => {
      expect(TENDER_RULES.length).toBe(25)
      for (const rule of TENDER_RULES) {
        expect(rule.key).toBeTruthy()
        expect(rule.title).toBeTruthy()
        expect(rule.patterns.length).toBeGreaterThan(0)
        expect(rule.category).toMatch(/^(MANDATORY_STAGE_1|FUNCTIONALITY_STAGE_2|FINANCIAL_STAGE_3|GENERAL_RETURNABLE)$/)
        expect(rule.riskLevel).toMatch(/^(CRITICAL_DISQUALIFIER|POINT_SCORED|INFORMATIONAL)$/)
        expect(RULE_BY_KEY[rule.key]).toBe(rule)
      }

      // Verify domain categories represented in rules and vaultHints:
      // Technical, Financial, Legal/Governance, Experience, Personnel
      const categories = new Set(TENDER_RULES.map((r) => r.category))
      expect(categories).toContain('MANDATORY_STAGE_1')
      expect(categories).toContain('FUNCTIONALITY_STAGE_2')
      expect(categories).toContain('FINANCIAL_STAGE_3')
      expect(categories).toContain('GENERAL_RETURNABLE')

      const vaultCategories = new Set(TENDER_RULES.map((r) => r.vaultHints.category))
      expect(vaultCategories).toContain('COMPLIANCE')
      expect(vaultCategories).toContain('FINANCIAL')
      expect(vaultCategories).toContain('TECHNICAL')
      expect(vaultCategories).toContain('GOVERNANCE')
      expect(vaultCategories).toContain('CV')
    })

    it('extracts mandatory compliance rules: Tax PIN, COIDA, B-BBEE, CIPC, Director IDs, CSD', () => {
      const doc = makeDoc(
        makePage(1, [
          'EVALUATION OF RETURNABLE COMPLIANCE DOCUMENTS',
          'A valid SARS Tax Clearance Certificate or TCS PIN must be submitted with the tender.',
          'Proof of active COIDA Letter of Good Standing from the Compensation Fund is mandatory.',
          'Bidders must submit a valid Broad-Based Black Economic Empowerment (B-BBEE) verification certificate or sworn affidavit.',
          'Certified copy of CIPC company registration documents (COR 14.3 or CK1) is required.',
          'Certified copies of identity documents (ID) of all directors must be attached.',
          'Central Supplier Database (CSD) supplier registration number (MAAA number) must be provided.',
        ]),
      )

      const reqs = shredExtraction(doc)
      const ruleKeys = reqs.map((r) => r.ruleKey)
      expect(ruleKeys).toContain('tax_pin')
      expect(ruleKeys).toContain('coida')
      expect(ruleKeys).toContain('bbbee')
      expect(ruleKeys).toContain('cipc')
      expect(ruleKeys).toContain('director_ids')
      expect(ruleKeys).toContain('csd')

      for (const key of ['tax_pin', 'coida', 'cipc', 'director_ids', 'csd']) {
        const item = reqs.find((r) => r.ruleKey === key)
        expect(item).toBeDefined()
        expect(item?.isMandatory).toBe(true)
        expect(item?.category).toBe('MANDATORY_STAGE_1')
      }
    })

    it('identifies Stage 2 Functionality & Technical rules (Experience, Key Personnel, Methodology)', () => {
      const doc = makeDoc(
        makePage(2, [
          'STAGE 2: TECHNICAL FUNCTIONALITY EVALUATION',
          'Demonstrable proven relevant experience on similar projects in water infrastructure must be submitted.',
          'Curriculum vitae (CV) and professional registration of key personnel (Pr Eng / Pr Tech) required.',
          'Comprehensive project implementation methodology and work programme schedule required.',
        ]),
      )

      const reqs = shredExtraction(doc)
      const ruleKeys = reqs.map((r) => r.ruleKey)
      expect(ruleKeys).toContain('experience')
      expect(ruleKeys).toContain('key_personnel')
      expect(ruleKeys).toContain('methodology')

      for (const k of ['experience', 'key_personnel', 'methodology']) {
        const item = reqs.find((r) => r.ruleKey === k)
        expect(item?.category).toBe('FUNCTIONALITY_STAGE_2')
        expect(item?.riskLevel).toBe('POINT_SCORED')
      }
    })

    it('identifies Stage 3 Financial & Commercial rules (Financial Statements, Turnover, PPPFA, Bid Security)', () => {
      const doc = makeDoc(
        makePage(3, [
          'STAGE 3: COMMERCIAL & FINANCIAL EVALUATION',
          'Audited financial statements for the past 3 consecutive years are required from all bidders.',
          'Minimum annual turnover of R 15 million is required to qualify.',
          'Tenderers must submit a bid guarantee or performance security bond of 10% of the bid sum.',
          'Tenders will be evaluated in accordance with the Preferential Procurement Policy Framework Act (PPPFA) 80/20 preference points system.',
          'A minimum of 30% subcontracting to designated local enterprise development entities is required.',
        ]),
      )

      const reqs = shredExtraction(doc)
      const ruleKeys = reqs.map((r) => r.ruleKey)
      expect(ruleKeys).toContain('financials')
      expect(ruleKeys).toContain('turnover')
      expect(ruleKeys).toContain('bid_security')
      expect(ruleKeys).toContain('pppfa')
      expect(ruleKeys).toContain('subcontracting')

      const finReq = reqs.find((r) => r.ruleKey === 'financials')
      expect(finReq?.category).toBe('FINANCIAL_STAGE_3')
      const secReq = reqs.find((r) => r.ruleKey === 'bid_security')
      expect(secReq?.riskLevel).toBe('CRITICAL_DISQUALIFIER')
    })

    it('discards negative pattern matches (e.g. police_certification with good standing)', () => {
      const doc = makeDoc(
        makePage(1, [
          // Matches "letter of good standing" which has a negative filter in police_certification
          'The letter of good standing must be certified and not older than 3 months.',
        ]),
      )
      const reqs = shredExtraction(doc)
      // Should match coida, but police_certification should NOT trigger because "good standing" is in negative list
      expect(reqs.some((r) => r.ruleKey === 'police_certification')).toBe(false)
      expect(reqs.some((r) => r.ruleKey === 'coida')).toBe(true)
    })

    it('computes higher confidence score for corroborated clauses across multiple pages', () => {
      // Single mention
      const docSingle = makeDoc(
        makePage(1, [
          'Bidders are required to submit a valid SARS tax compliance status PIN.',
        ]),
      )
      const reqSingle = shredExtraction(docSingle).find((r) => r.ruleKey === 'tax_pin')

      // Corroborated across two pages with mandatory language
      const docMulti = makeDoc(
        makePage(1, [
          'Bidders must submit a valid SARS Tax Clearance Certificate or TCS PIN, failing which the bid will be disqualified.',
        ]),
        makePage(3, [
          'Tax compliance status PIN issued by SARS will be verified online on e-Filing before award.',
        ]),
      )
      const reqMulti = shredExtraction(docMulti).find((r) => r.ruleKey === 'tax_pin')

      expect(reqSingle).toBeDefined()
      expect(reqMulti).toBeDefined()
      expect(reqMulti!.confidence!).toBeGreaterThan(reqSingle!.confidence!)
      expect(reqMulti!.notes).toContain('Also referenced on p. 3')
      expect(reqMulti!.additionalClauses).toBeDefined()
      expect(reqMulti!.additionalClauses!.length).toBeGreaterThan(0)
    })

    it('filters out near-duplicate clauses from additionalClauses', () => {
      const doc = makeDoc(
        makePage(1, [
          'Bidders must submit a certified copy of the CIPC company registration document.',
        ]),
        makePage(2, [
          // Near identical sentence
          'Bidders must submit a certified copy of the CIPC company registration document.',
        ]),
      )
      const reqs = shredExtraction(doc)
      const cipcReq = reqs.find((r) => r.ruleKey === 'cipc')
      expect(cipcReq).toBeDefined()
      // Near-duplicate on page 2 should be filtered out from additionalClauses
      expect(cipcReq?.additionalClauses).toBeUndefined()
    })
  })

  describe('3. Tender Metadata Extraction (Title, Ref, Issuer, Closing Date, Logistics)', () => {
    it('extracts tender title, reference number, issuing authority, and closing date', () => {
      const doc = makeDoc(
        makePage(1, [
          'CITY OF EKURHULENI METROPOLITAN MUNICIPALITY',
          'WATER AND SANITATION DEPARTMENT',
          'INVITATION TO TENDER',
          'Bulk Water Metering & Valve Refurbishment Programme',
          'Tender Reference Number: RFP-WTR-2026-04',
          'Closing Date: 31 October 2026 at 11:00',
          'Contact Person: Mr Sipho Mthembu · Tel: 011 999 4432',
          'Proposals must be deposited into the bid box at Civic Centre, Kempton Park.',
        ]),
      )

      const meta = extractTenderMeta(doc, 'Fallback Title')
      expect(meta.title).toBe('Bulk Water Metering & Valve Refurbishment Programme')
      expect(meta.referenceNumber).toBe('RFP-WTR-2026-04')
      expect(meta.issuingBody).toContain('CITY OF EKURHULENI')
      expect(meta.closingDate).toBe('31 October 2026 at 11:00')
      expect(meta.submissionMethod).toBe('PHYSICAL')
      expect(meta.submissionAddress).toContain('bid box at Civic Centre, Kempton Park.')
    })

    it('falls back to default title when no recognizable title heading is present', () => {
      const doc = makeDoc(
        makePage(1, [
          'General notes on project requirements.',
          'Reference Number: BID-2026-99',
        ]),
      )
      const meta = extractTenderMeta(doc, 'Default Document Title')
      expect(meta.title).toBe('Default Document Title')
      expect(meta.referenceNumber).toBe('BID-2026-99')
    })

    it('identifies Electronic submission methods (portals and e-tenders)', () => {
      const doc = makeDoc(
        makePage(1, [
          'REQUEST FOR PROPOSALS',
          'Tender Ref: DWS/2026/10',
          'Bids must be submitted electronically via the National Treasury e-tender portal before closing time.',
        ]),
      )
      const logistics = extractSubmissionLogistics(doc)
      expect(logistics.submissionMethod).toBe('ELECTRONIC')
      expect(logistics.submissionAddress).toContain('e-tender portal')
    })

    it('identifies Email submission methods', () => {
      const doc = makeDoc(
        makePage(1, [
          'REQUEST FOR QUOTATION',
          'Tender No: RFQ-SANRAL-08',
          'Submissions must be sent via email to tenders@sanral.co.za no later than 12:00 on the closing date.',
        ]),
      )
      const logistics = extractSubmissionLogistics(doc)
      expect(logistics.submissionMethod).toBe('EMAIL')
      expect(logistics.submissionAddress).toContain('tenders@sanral.co.za')
    })

    it('extracts complete issuer letterhead contact details', () => {
      const doc = makeDoc(
        makePage(1, [
          'DEPARTMENT OF WATER AND SANITATION',
          'Private Bag X313, Pretoria, 0001',
          'Contact Person: Director SCM · Tel: 012 336 7500',
          'Email enquiries: scm@dws.gov.za',
          'REQUEST FOR PROPOSALS',
          'Ref No: DWS/RFP-2026/0034',
        ]),
      )
      const issuer = extractIssuerInfo(doc, {
        referenceNumber: 'DWS/RFP-2026/0034',
        issuingBody: 'Department of Water and Sanitation',
      })
      expect(issuer).not.toBeNull()
      expect(issuer?.name).toBe('DEPARTMENT OF WATER AND SANITATION')
      expect(issuer?.displayName).toBe('Department of Water and Sanitation')
      expect(issuer?.address).toContain('Private Bag X313, Pretoria, 0001')
      expect(issuer?.contact).toContain('Director SCM')
      expect(issuer?.contact).toContain('012 336 7500')
      expect(issuer?.refStyle).toContain('DWS/RFP-2026/0034')
    })
  })

  describe('4. South African Tender Heuristics & Edge Cases', () => {
    it('detects and scores CIDB contractor grading clauses', () => {
      const doc = makeDoc(
        makePage(2, [
          'CIDB CONTRACTOR GRADING REQUIREMENT',
          'Only contractors registered with the CIDB with a contractor grading designation of 7CE or higher are eligible to bid.',
        ]),
      )
      const clauses = buildClauses(doc)
      const cidbHeading = clauses.find((c) => c.text === 'CIDB CONTRACTOR GRADING REQUIREMENT')
      const cidbBody = clauses.find((c) => c.text.includes('7CE or higher'))
      expect(cidbHeading).toBeDefined()
      expect(cidbBody).toBeDefined()
      expect(cidbBody?.text).toContain('CIDB with a contractor grading designation of 7CE or higher')
    })

    it('matches South African SBD returnable forms (SBD 4, SBD 6.1)', () => {
      const doc = makeDoc(
        makePage(2, [
          'RETURNABLE SBD FORMS',
          'Completed and signed SBD 4 (Declaration of Interest) form is a mandatory disqualifying returnable.',
          'Duly signed SBD 6.1 preference points claim form in terms of preferential procurement regulations.',
        ]),
      )
      const reqs = shredExtraction(doc)
      const sbdReq = reqs.find((r) => r.ruleKey === 'sbd_forms')
      expect(sbdReq).toBeDefined()
      expect(sbdReq?.isMandatory).toBe(true)
      expect(sbdReq?.riskLevel).toBe('CRITICAL_DISQUALIFIER')
    })

    it('extracts B-BBEE Level & Ownership requirements with point-scoring designation', () => {
      const doc = makeDoc(
        makePage(2, [
          'PREFERENTIAL PROCUREMENT & B-BBEE STATUS',
          'Bidders will receive preference points based on their Broad-Based Black Economic Empowerment level and valid BEE certificate.',
        ]),
      )
      const reqs = shredExtraction(doc)
      const bbbeeReq = reqs.find((r) => r.ruleKey === 'bbbee')
      expect(bbbeeReq).toBeDefined()
      expect(bbbeeReq?.riskLevel).toBe('POINT_SCORED')
    })

    it('detects mandatory signing and initialling on every page', () => {
      const doc = makeDoc(
        makePage(1, [
          'Bidders must sign and initial every page of the tender document. Failure to comply will result in disqualification.',
        ]),
      )
      const reqs = shredExtraction(doc)
      const signReq = reqs.find((r) => r.ruleKey === 'signed_initialled')
      expect(signReq).toBeDefined()
      expect(signReq?.isMandatory).toBe(true)
      expect(signReq?.riskLevel).toBe('CRITICAL_DISQUALIFIER')
    })

    it('detects plant and equipment schedule requirements in functionality', () => {
      const doc = makeDoc(
        makePage(2, [
          'FUNCTIONALITY: PLANT AND EQUIPMENT SCHEDULE',
          'The bidder must provide proof of ownership or plant hire agreements for essential earthmoving plant, excavators, and flow calibration equipment.',
        ]),
      )
      const clauses = buildClauses(doc)
      const plantHeading = clauses.find((c) => c.text === 'FUNCTIONALITY: PLANT AND EQUIPMENT SCHEDULE')
      const plantBody = clauses.find((c) => c.text.includes('proof of ownership or plant hire'))
      expect(plantHeading).toBeDefined()
      expect(plantBody).toBeDefined()
    })
  })
})

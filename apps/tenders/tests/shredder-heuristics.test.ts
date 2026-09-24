import { describe, expect, it } from 'vitest'
import {
  buildClauses,
  normalizePdfText,
  pageClauses,
  type Clause,
} from '../src/renderer/src/pdf/clauses'
import {
  extractClosingDateCandidates,
  extractIssuerCandidates,
  extractIssuerInfo,
  extractReferenceCandidates,
  extractSubmissionCandidates,
  extractSubmissionLogistics,
  extractTenderMeta,
  shredExtraction,
} from '../src/renderer/src/pdf/shred'
import { parseClosingDate as parseDisplayClosingDate } from '../src/renderer/src/deadline'
import { parseClosingDate as parseStrictClosingDate } from '../src/shared/readiness'
import {
  DISQUALIFIER_LANGUAGE,
  MANDATORY_LANGUAGE,
  RULE_BY_KEY,
  TENDER_RULES,
} from '../src/shared/rules'
import type { ExtractedPage, PageExtraction, PageLine } from '../src/shared/types'

/**
 * Closing-date strings the shared `parseClosingDate` rejects, so they must reach
 * the store as `null`, never as raw text. Each carries date/time information the
 * parser deliberately refuses to guess at: a weekday-prefixed date, a bracketed
 * clock time, a comma-separated `11h00` tail, and a year-first slash date. The
 * same values WITHOUT the comma (`30 Nov 2026 11h00`) are supported — it is the
 * exact string that is unsupported, not the date it describes.
 */
const UNSUPPORTED_CLOSING_DATES = [
  'Friday, 30 November 2026',
  '30 November 2026 (11:00)',
  '30 Nov 2026, 11h00',
  '2026/11/30',
] as const

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
      const longSentencePart =
        'The contractor shall continuously furnish and maintain all necessary equipment, materials, qualified personnel, and certified testing apparatus to ensure strict adherence to municipal standards. '
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
      const l1 = makeLine('Line one text without punctuation', 1, {
        top: 0.1,
        left: 0.15,
        width: 0.4,
        height: 0.03,
      })
      const l2 = makeLine('Line two text continues here.', 1, {
        top: 0.14,
        left: 0.1,
        width: 0.6,
        height: 0.03,
      })
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
    it('verifies the shared rule catalogue contains 27 comprehensive evaluation rules', () => {
      expect(TENDER_RULES.length).toBe(27)
      for (const rule of TENDER_RULES) {
        expect(rule.key).toBeTruthy()
        expect(rule.title).toBeTruthy()
        expect(rule.patterns.length).toBeGreaterThan(0)
        expect(rule.category).toMatch(
          /^(MANDATORY_STAGE_1|FUNCTIONALITY_STAGE_2|FINANCIAL_STAGE_3|GENERAL_RETURNABLE)$/,
        )
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
        makePage(1, ['Bidders are required to submit a valid SARS tax compliance status PIN.']),
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
        makePage(1, ['General notes on project requirements.', 'Reference Number: BID-2026-99']),
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
      expect(cidbBody?.text).toContain(
        'CIDB with a contractor grading designation of 7CE or higher',
      )
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
      const plantHeading = clauses.find(
        (c) => c.text === 'FUNCTIONALITY: PLANT AND EQUIPMENT SCHEDULE',
      )
      const plantBody = clauses.find((c) => c.text.includes('proof of ownership or plant hire'))
      expect(plantHeading).toBeDefined()
      expect(plantBody).toBeDefined()
    })
  })

  describe('5. v2 persistence shape of shredder output', () => {
    // One sentence matching two rules (cipc + tax_pin) means both requirements
    // would otherwise point at the SAME clause boundingBox object, producing a
    // DAG that trips the v2 aggregate-string guard and blocks saveStoreV2.
    it('emits a fresh boundingBox per requirement and never an undefined-valued own property', () => {
      const doc = makeDoc(
        makePage(1, [
          'Bidders must submit a certified copy of CIPC company registration documents and a valid SARS tax clearance certificate or TCS PIN.',
        ]),
      )

      const reqs = shredExtraction(doc)
      expect(reqs.length).toBeGreaterThanOrEqual(2)
      expect(reqs.some((r) => r.ruleKey === 'cipc')).toBe(true)
      expect(reqs.some((r) => r.ruleKey === 'tax_pin')).toBe(true)

      const seenBoxes = new Set<object>()
      for (const req of reqs) {
        expect(seenBoxes.has(req.boundingBox)).toBe(false)
        seenBoxes.add(req.boundingBox)
      }

      for (const req of reqs) {
        const undefinedKeys = Object.entries(req)
          .filter(([, value]) => value === undefined)
          .map(([key]) => key)
        expect(undefinedKeys).toEqual([])
      }
    })

    it('omits additionalClauses/notes keys entirely when there is nothing to add', () => {
      const doc = makeDoc(
        makePage(1, [
          'Bidders must submit a certified copy of CIPC company registration documents.',
        ]),
      )
      const cipc = shredExtraction(doc).find((r) => r.ruleKey === 'cipc')
      expect(cipc).toBeDefined()
      expect(Object.prototype.hasOwnProperty.call(cipc, 'additionalClauses')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(cipc, 'notes')).toBe(false)
    })
  })

  describe('6. Closing-date sanitization at the shred boundary', () => {
    it('has one closing-date parser: the display parser IS the strict schema parser', () => {
      // The audit's closing-date defect: readiness' strict UTC parser and the
      // badge's lenient local-time parser were two functions, so the countdown
      // badge and the readiness gate could disagree about the same RFP line.
      // They are now the same shared `parseClosingDate`; identity is asserted
      // here (and in closing-date-parser.test.ts) so a second parser cannot
      // reappear and reopen the divergence.
      expect(parseDisplayClosingDate).toBe(parseStrictClosingDate)

      // ...and the shred boundary stays strict: no supported form means null,
      // never the raw text, so an unparseable closing date cannot be stored.
      for (const raw of UNSUPPORTED_CLOSING_DATES) {
        expect(parseStrictClosingDate(raw), `strict should reject ${raw}`).toBeNull()
      }
    })

    it('stores null for extracted dates the strict schema rejects (never the raw text)', () => {
      for (const raw of UNSUPPORTED_CLOSING_DATES) {
        const doc = makeDoc(makePage(1, [`Closing Date: ${raw}`]))
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.closingDate, raw).toBeNull()
      }
    })

    it('reports a refused closing line to the review UI instead of dropping it', () => {
      // A realistic SA closing line the parser cannot represent: the raw text
      // must still reach the user (via the review conflict notes) so they can
      // confirm or retype it, rather than the deadline vanishing with no reason.
      const doc = makeDoc(makePage(1, ['Closing Date: 30 November 2026, 11:00']))
      const meta = extractTenderMeta(doc, 'Fallback Title')

      expect(meta.closingDate).toBeNull()
      expect(meta.candidates.closingDate).toEqual([])
      const note = meta.conflicts.find((candidate) => /could not be read/i.test(candidate))
      expect(note).toBeDefined()
      expect(note).toContain('30 November 2026, 11:00')
    })

    it('adds no closing-date note when the document carried a readable closing line', () => {
      const doc = makeDoc(makePage(1, ['Closing Date: 30 November 2026 at 11:00']))
      const meta = extractTenderMeta(doc, 'Fallback Title')

      expect(meta.conflicts.some((note) => /could not be read/i.test(note))).toBe(false)
    })

    it('preserves an extracted date the strict schema accepts', () => {
      const doc = makeDoc(
        makePage(1, ['INVITATION TO TENDER', 'Closing Date: 30 November 2026 at 11:00']),
      )
      const meta = extractTenderMeta(doc, 'Fallback Title')
      expect(meta.closingDate).toBe('30 November 2026 at 11:00')
      expect(parseStrictClosingDate(meta.closingDate)).not.toBeNull()
    })

    it('preserves numeric and ISO civil dates the schema accepts', () => {
      for (const raw of ['2026-11-30', '30/11/2026', '30 November 2026']) {
        const doc = makeDoc(makePage(1, [`Closing Date: ${raw}`]))
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.closingDate, raw).toBe(raw)
        expect(parseStrictClosingDate(raw), raw).not.toBeNull()
      }
    })

    it('strips only a trailing sentence terminator before the strict gate', () => {
      const doc = makeDoc(makePage(1, ['Closing Date: 15 December 2026 at 11:00.']))
      const meta = extractTenderMeta(doc, 'Fallback Title')
      expect(meta.closingDate).toBe('15 December 2026 at 11:00')
      expect(parseStrictClosingDate(meta.closingDate)).not.toBeNull()
    })
  })

  describe('7. Phase 3 parser improvements (WP-6 producer side)', () => {
    describe('text normalisation', () => {
      it('normalises Unicode spaces/dashes and OCR punctuation deterministically', () => {
        const raw = 'B\u00a0BBEE \u2013 tax\u2010clearance \u201cX\u201d\u2026 tab\ttab'
        const normalized = normalizePdfText(raw)
        expect(normalized).toBe('B BBEE - tax-clearance "X"... tab tab')
        // No residual Unicode spaces/dashes/quotes/ellipsis.
        expect(normalized).not.toMatch(/[\u00a0\u2010-\u2015\u2018-\u201f\u2026]/)
      })

      it('matches a rule across NBSP and non-breaking-hyphen OCR variants', () => {
        const doc = makeDoc(
          makePage(1, [
            'Bidders must submit a valid B\u2011BBEE\u00a0certificate or sworn affidavit.',
          ]),
        )
        const reqs = shredExtraction(doc)
        expect(reqs.some((r) => r.ruleKey === 'bbbee')).toBe(true)
      })
    })

    describe('repeated running headers/footers', () => {
      const header = 'CITY OF EXAMPLE METRO - REQUEST FOR PROPOSALS'
      const footer = (n: number): PageLine =>
        makeLine(`Page ${n} of 3`, n, { top: 0.95, left: 0.4, width: 0.2, height: 0.02 })

      it('strips boilerplate repeated across pages without touching body text', () => {
        const doc = makeDoc(
          makePage(1, [
            header,
            'Bidders must submit a valid SARS Tax Clearance Certificate.',
            footer(1),
          ]),
          makePage(2, [
            header,
            'Audited financial statements for the past 3 financial years are required.',
            footer(2),
          ]),
          makePage(3, [
            header,
            'Bidders must provide a certified copy of CIPC registration documents.',
            footer(3),
          ]),
        )

        const clauseTexts = buildClauses(doc).map((c) => c.text)
        expect(clauseTexts.some((t) => t.includes('REQUEST FOR PROPOSALS'))).toBe(false)
        expect(clauseTexts.some((t) => /page\s*\d+\s*of\s*3/i.test(t))).toBe(false)
        expect(clauseTexts.some((t) => t.includes('Tax Clearance Certificate'))).toBe(true)

        const reqs = shredExtraction(doc)
        expect(reqs.some((r) => r.ruleKey === 'tax_pin')).toBe(true)
        expect(reqs.some((r) => r.ruleKey === 'cipc')).toBe(true)
      })

      it('does not strip repeated top-of-page body text on a two-page document', () => {
        const body =
          'Bidders must submit a certified copy of the CIPC company registration document.'
        const doc = makeDoc(makePage(1, [body]), makePage(2, [body]))
        expect(buildClauses(doc).some((c) => c.text.includes('CIPC company registration'))).toBe(
          true,
        )
        expect(shredExtraction(doc).some((r) => r.ruleKey === 'cipc')).toBe(true)
      })

      it('preserves a repeated band line that ends a sentence (terminator guard)', () => {
        // A genuine body sentence that happens to sit in the header band and
        // repeat on every page must NOT be stripped: the conservative guard
        // rejects any candidate label that ends a sentence.
        const sentence = 'Bidders must submit a valid tax clearance certificate.'
        const doc = makeDoc(
          makePage(1, [sentence, 'First page body requirement text here.']),
          makePage(2, [sentence, 'Second page body requirement text here.']),
          makePage(3, [sentence, 'Third page body requirement text here.']),
        )
        expect(buildClauses(doc).some((c) => c.text.includes('tax clearance certificate'))).toBe(
          true,
        )
        expect(shredExtraction(doc).some((r) => r.ruleKey === 'tax_pin')).toBe(true)
      })

      it('preserves a repeated band line longer than the 60-character label cap', () => {
        // Documented limitation: a long running header is deliberately kept
        // rather than risk deleting body content it cannot be distinguished
        // from. Repeat it on every page at the top of the band.
        const longHeader =
          'THIS RUNNING HEADER IS DELIBERATELY LONGER THAN THE CONSERVATIVE SIXTY CHARACTER LABEL CAP'
        const doc = makeDoc(
          makePage(1, [longHeader, 'First page body requirement text here.']),
          makePage(2, [longHeader, 'Second page body requirement text here.']),
          makePage(3, [longHeader, 'Third page body requirement text here.']),
        )
        expect(buildClauses(doc).some((c) => c.text.includes('DELIBERATELY LONGER'))).toBe(true)
      })

      it('preserves repeated body text outside the header/footer band', () => {
        const body =
          'The contractor must maintain the reticulation network during the defects period.'
        const doc = makeDoc(
          makePage(1, ['Page one heading', 'padding a', 'padding b', 'padding c', body]),
          makePage(2, ['Page two heading', 'padding a', 'padding b', 'padding c', body]),
          makePage(3, ['Page three heading', 'padding a', 'padding b', 'padding c', body]),
        )
        expect(buildClauses(doc).some((c) => c.text.includes('reticulation network'))).toBe(true)
      })

      it('preserves a band label repeated on fewer than half the pages', () => {
        // Repeated on 2 of 5 pages < ceil(5 / 2) = 3, so it is not strippable.
        const partial = 'DRAFT FOR DISCUSSION'
        const doc = makeDoc(
          makePage(1, [partial, 'First page body requirement text here.']),
          makePage(2, [partial, 'Second page body requirement text here.']),
          makePage(3, ['UNRELATED HEADING THREE', 'Third page body requirement text here.']),
          makePage(4, ['UNRELATED HEADING FOUR', 'Fourth page body requirement text here.']),
          makePage(5, ['UNRELATED HEADING FIVE', 'Fifth page body requirement text here.']),
        )
        expect(buildClauses(doc).some((c) => c.text.includes('DRAFT FOR DISCUSSION'))).toBe(true)
      })
    })

    describe('whole-document metadata scoring', () => {
      it('finds the reference and closing date when they are not on page 1', () => {
        const doc = makeDoc(
          makePage(1, ['CITY OF CAPE TOWN', 'INVITATION TO TENDER']),
          makePage(2, [
            'Tender Reference Number: RFP-2026-77',
            'Closing Date: 30 November 2026 at 11:00',
          ]),
        )
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.referenceNumber).toBe('RFP-2026-77')
        expect(meta.closingDate).toBe('30 November 2026 at 11:00')
      })

      it('keeps unknown metadata unknown rather than fabricating it', () => {
        const doc = makeDoc(makePage(1, ['General notes on project requirements.']))
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.referenceNumber).toBeNull()
        expect(meta.closingDate).toBeNull()
        expect(meta.issuingBody).toBeNull()
        expect(meta.submissionMethod).toBeNull()
        expect(meta.submissionAddress).toBeNull()
        expect(meta.candidates.closingDate).toEqual([])
        expect(meta.conflicts).toEqual([])
      })
    })

    describe('issuing-authority scoring', () => {
      it('prefers the government letterhead over a sub-department line', () => {
        const doc = makeDoc(
          makePage(1, [
            'CITY OF EKURHULENI METROPOLITAN MUNICIPALITY',
            'WATER AND SANITATION DEPARTMENT',
            'INVITATION TO TENDER',
          ]),
        )
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.issuingBody).toContain('CITY OF EKURHULENI')
      })

      it('honours an explicit issuer label adjacency', () => {
        const doc = makeDoc(
          makePage(1, ['INVITATION TO TENDER', 'Issued by: Provincial Administration Office']),
        )
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.issuingBody).toBe('Provincial Administration Office')
      })

      it('surfaces competing issuing authorities instead of silently picking one', () => {
        const doc = makeDoc(
          makePage(1, [
            'CITY OF ALPHA METROPOLITAN MUNICIPALITY',
            'CITY OF BETA METROPOLITAN MUNICIPALITY',
            'INVITATION TO TENDER',
          ]),
        )
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.candidates.issuingBody).toEqual(
          expect.arrayContaining([
            'CITY OF ALPHA METROPOLITAN MUNICIPALITY',
            'CITY OF BETA METROPOLITAN MUNICIPALITY',
          ]),
        )
        expect(meta.conflicts.some((c) => /issuing authorities/i.test(c))).toBe(true)
      })

      it('returns no authority when nothing qualifies', () => {
        const doc = makeDoc(makePage(1, ['General notes on project requirements.']))
        expect(extractIssuerCandidates(doc)).toEqual([])
      })

      it('does not flag a subordinate department line as a competing authority', () => {
        const doc = makeDoc(
          makePage(1, [
            'MATJHABENG LOCAL MUNICIPALITY',
            'SUPPLY CHAIN MANAGEMENT',
            'INVITATION TO TENDER',
          ]),
        )
        // The full ranked list still exposes the department line…
        expect(extractIssuerCandidates(doc).map((c) => c.value)).toEqual(
          expect.arrayContaining(['MATJHABENG LOCAL MUNICIPALITY', 'SUPPLY CHAIN MANAGEMENT']),
        )
        // …but only the genuine authority is a competing candidate.
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.issuingBody).toBe('MATJHABENG LOCAL MUNICIPALITY')
        expect(meta.candidates.issuingBody).toEqual(['MATJHABENG LOCAL MUNICIPALITY'])
        expect(meta.conflicts.some((c) => /issuing authorities/i.test(c))).toBe(false)
      })
    })

    describe('pricing / BOQ rules', () => {
      it('catalogues pricing-schedule and bill-of-quantities rules as document-backed', () => {
        expect(RULE_BY_KEY.pricing_schedule).toBeDefined()
        expect(RULE_BY_KEY.pricing_schedule.category).toBe('FINANCIAL_STAGE_3')
        expect(RULE_BY_KEY.pricing_schedule.riskLevel).toBe('CRITICAL_DISQUALIFIER')
        expect(RULE_BY_KEY.pricing_schedule.evidenceKind).toBe('DOCUMENT')
        expect(RULE_BY_KEY.pricing_schedule.vaultHints.category).toBe('FINANCIAL')
        expect(RULE_BY_KEY.bill_of_quantities).toBeDefined()
        expect(RULE_BY_KEY.bill_of_quantities.category).toBe('FINANCIAL_STAGE_3')
        expect(RULE_BY_KEY.bill_of_quantities.evidenceKind).toBe('DOCUMENT')
      })

      it('detects a required pricing schedule and marks it mandatory', () => {
        const doc = makeDoc(
          makePage(1, ['A completed pricing schedule must be submitted with the tender.']),
        )
        const req = shredExtraction(doc).find((r) => r.ruleKey === 'pricing_schedule')
        expect(req).toBeDefined()
        expect(req?.isMandatory).toBe(true)
        expect(req?.category).toBe('FINANCIAL_STAGE_3')
      })

      it('detects a bill of quantities / BOQ requirement', () => {
        const doc = makeDoc(
          makePage(2, ['The bill of quantities (BOQ) must be priced and submitted.']),
        )
        expect(shredExtraction(doc).some((r) => r.ruleKey === 'bill_of_quantities')).toBe(true)
      })
    })

    describe('B-BBEE OCR/punctuation variants', () => {
      it('matches B-BBEE across punctuation and OCR spacing variants', () => {
        const variants = ['B-BBEE', 'BBBEE', 'B.BBEE', 'B - B B E E', 'B\u2011BBEE']
        for (const variant of variants) {
          const doc = makeDoc(makePage(1, [`Bidders must submit a valid ${variant} certificate.`]))
          const hits = shredExtraction(doc).filter((r) => r.ruleKey === 'bbbee')
          expect(hits.length, variant).toBe(1)
        }
      })
    })

    describe('competing candidates and conflicts', () => {
      it('exposes both closing dates and flags the conflict', () => {
        const doc = makeDoc(
          makePage(1, ['Closing Date: 30 November 2026 at 11:00']),
          makePage(2, ['Closing Date: 15 December 2026 at 11:00']),
        )
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.closingDate).toBe('30 November 2026 at 11:00')
        expect(extractClosingDateCandidates(doc).map((c) => c.value)).toEqual([
          '30 November 2026 at 11:00',
          '15 December 2026 at 11:00',
        ])
        expect(meta.candidates.closingDate).toHaveLength(2)
        expect(meta.conflicts.some((c) => /multiple closing dates/i.test(c))).toBe(true)
      })

      it('never surfaces a closing date the strict schema rejects', () => {
        const doc = makeDoc(
          makePage(1, ['Closing Date: 2026/11/30', 'Closing Date: Friday, 30 November 2026']),
        )
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(extractClosingDateCandidates(doc)).toEqual([])
        expect(meta.closingDate).toBeNull()
        expect(meta.candidates.closingDate).toEqual([])
      })

      it('exposes competing submission methods and destinations', () => {
        const doc = makeDoc(
          makePage(1, [
            'Submissions must be sent via email to tenders@example.test no later than 12:00.',
          ]),
          makePage(2, [
            'Bids must be deposited into the bid box at Civic Centre before closing time.',
          ]),
        )
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(extractSubmissionCandidates(doc).length).toBeGreaterThanOrEqual(2)
        expect(meta.candidates.submissionMethod).toEqual(
          expect.arrayContaining(['EMAIL', 'PHYSICAL']),
        )
        expect(meta.candidates.submissionAddress.length).toBeGreaterThanOrEqual(2)
        expect(meta.conflicts.some((c) => /submission/i.test(c))).toBe(true)
      })

      it('exposes competing reference numbers', () => {
        const doc = makeDoc(
          makePage(1, ['Tender Reference Number: RFP-2026-01']),
          makePage(2, ['Reference Number: RFP-2026-02']),
        )
        const references = extractReferenceCandidates(doc)
        expect(references.map((r) => r.value)).toEqual(['RFP-2026-01', 'RFP-2026-02'])
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.referenceNumber).toBe('RFP-2026-01')
        expect(meta.conflicts.some((c) => /multiple reference numbers/i.test(c))).toBe(true)
      })
    })

    describe('amended / extended deadlines', () => {
      it('captures "the closing date is amended to <date>" as a competing candidate', () => {
        const doc = makeDoc(
          makePage(1, [
            'Closing Date: 23 January 2027 at 11:00',
            'The closing date is amended to 30 January 2027 at 11:00.',
          ]),
        )
        expect(extractClosingDateCandidates(doc).map((c) => c.value)).toEqual([
          '23 January 2027 at 11:00',
          '30 January 2027 at 11:00',
        ])
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.candidates.closingDate).toHaveLength(2)
        expect(meta.conflicts.some((c) => /multiple closing dates/i.test(c))).toBe(true)
      })

      it('captures "the closing date is extended to <date>"', () => {
        const doc = makeDoc(
          makePage(1, ['The closing date is extended to 21 December 2026 at 11:00.']),
        )
        expect(extractClosingDateCandidates(doc).map((c) => c.value)).toEqual([
          '21 December 2026 at 11:00',
        ])
      })

      it('captures a labelled "Amended Closing Date: <date>"', () => {
        const doc = makeDoc(makePage(1, ['Amended Closing Date: 27 November 2026 at 11:00']))
        expect(extractClosingDateCandidates(doc).map((c) => c.value)).toEqual([
          '27 November 2026 at 11:00',
        ])
      })
    })

    describe('timezone abbreviations', () => {
      it('normalises a SAST-abbreviated civil time to a supported strict date', () => {
        const doc = makeDoc(makePage(1, ['Closing Date: 02 December 2026 at 11:00 SAST']))
        const meta = extractTenderMeta(doc, 'Fallback Title')
        expect(meta.closingDate).toBe('02 December 2026 at 11:00')
        expect(parseStrictClosingDate(meta.closingDate)).not.toBeNull()
        expect(meta.candidates.closingDate).toEqual(['02 December 2026 at 11:00'])
      })
    })

    describe('OCR-variant mandatory phrase recall', () => {
      it('recalls director_ids, police_certification and financials OCR wording', () => {
        const doc = makeDoc(
          makePage(2, [
            'Identity papers of all directors of the bidding entity must be attached.',
            'Every supporting document must be endorsed by a Commissioner of Oaths and dated within 90 days.',
            'Statements of audited accounts for the past three years are required.',
          ]),
        )
        const keys = shredExtraction(doc).map((r) => r.ruleKey)
        expect(keys).toContain('director_ids')
        expect(keys).toContain('police_certification')
        expect(keys).toContain('financials')
      })

      it('recalls the canonical director_ids / police_certification / financials wording', () => {
        const doc = makeDoc(
          makePage(2, [
            'Certified copies of the identity documents of all directors of the bidding entity must be attached.',
            'Every supporting document must be certified by a Commissioner of Oaths and not older than three months.',
            'Audited financial statements for the past three consecutive years are required.',
          ]),
        )
        const keys = shredExtraction(doc).map((r) => r.ruleKey)
        expect(keys).toContain('director_ids')
        expect(keys).toContain('police_certification')
        expect(keys).toContain('financials')
      })
    })
  })
})

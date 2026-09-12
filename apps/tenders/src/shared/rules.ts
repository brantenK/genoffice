// Zanostack Tenders rule catalogue — deterministic patterns for South-African-style
// tender returnables / evaluation criteria. Shared by:
//  - client heuristic shredder (src/client/pdf/shred.ts)
//  - server gap analysis (matching requirements -> vault docs)
//  - LLM refine route (sends rule list for classification)
//  - seed generator + tests
import type { DocCategory, RequirementCategory, RiskLevel } from './types'

export interface TenderRule {
  key: string
  title: string
  category: RequirementCategory
  riskLevel: RiskLevel
  /** order in the checklist */
  order: number
  /** regexes tested against each rendered line (case-insensitive) */
  patterns: RegExp[]
  /** if any of these appear in the same line, the hit is discarded */
  negative?: RegExp[]
  /** used by gap analysis to suggest vault documents */
  vaultHints: { category?: DocCategory; keywords: string[] }
  notes?: string
}

// Build regexes once (case-insensitive, global-free)
const rx = (s: string) => new RegExp(s, 'i')

export const TENDER_RULES: TenderRule[] = [
  {
    key: 'tax_pin',
    title: 'Valid SARS Tax Clearance / TCS PIN',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 10,
    patterns: [
      rx('tax\\s*(clearance|status|compliance|pin|certificate)'),
      rx('\\btcs\\s*pin\\b'),
      rx('south african revenue service')
    ],
    vaultHints: { category: 'COMPLIANCE', keywords: ['tax', 'tcs', 'sars', 'pin'] },
    notes: 'TCS PINs are valid for 12 months from issue.'
  },
  {
    key: 'coida',
    title: 'COIDA Letter of Good Standing',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 20,
    patterns: [
      rx('\\bcoida\\b'),
      rx('compensation\\s*(for occupational injuries|fund)'),
      rx('letter of good standing'),
      rx('employment\\s*compensation')
    ],
    vaultHints: { category: 'COMPLIANCE', keywords: ['coida', 'good standing', 'compensation'] },
    notes: 'Letters of good standing typically expire annually.'
  },
  {
    key: 'bbbee',
    title: 'B-BBEE Certificate / Sworn Affidavit',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'POINT_SCORED',
    order: 30,
    patterns: [
      rx('b[- ]?bbbee'),
      rx('broad[- ]based black economic empowerment'),
      rx('\\bbee\\s*(certificate|affidavit|status|level|recognition|scorecard)'),
      rx('empowerment\\s*(status|level|certificate)')
    ],
    vaultHints: { category: 'COMPLIANCE', keywords: ['bbbee', 'bee', 'affidavit', 'empowerment'] },
    notes: 'EME/QSE affidavits are valid for 12 months; generic certificates valid until the next verification.'
  },
  {
    key: 'cipc',
    title: 'CIPC Company Registration Documents',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 40,
    patterns: [
      rx('\\bcipc\\b'),
      rx('companies and intellectual property commission'),
      rx('(company|close corporation|cc)\\s*registration'),
      rx('\\b(ck|cor)\\s*\\d'),
      rx('memorandum of incorporation'),
      rx('certified\\s*(copy\\s*of\\s*the\\s*)?(registration|incorporation)')
    ],
    vaultHints: { category: 'GOVERNANCE', keywords: ['cipc', 'registration', 'ck', 'cor', 'incorporation'] }
  },
  {
    key: 'director_ids',
    title: 'Certified ID Copies of Directors / Members',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 50,
    patterns: [
      rx('certified\\s*(copy|copies)\\s*of\\s*(the\\s*)?(id|identity|passport)'),
      rx('(director|member|partner|owner|shareholder)s?[^.]{0,60}(id|identity|passport)\\s*(copy|copies|document)'),
      rx('(id|identity)\\s*(copy|copies|documents?)[^.]{0,40}(director|member|owner)')
    ],
    vaultHints: { category: 'COMPLIANCE', keywords: ['id copy', 'identity', 'passport', 'certified id', 'director'] },
    notes: 'ID copies must be certified within the last 3 months (police stamp).'
  },
  {
    key: 'police_certification',
    title: 'Documents Certified by Commissioner of Oaths (≤ 3 Months)',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 60,
    patterns: [
      rx('certif\\w*[^.]{0,50}(3|three|90)\\s*(months?|days?)'),
      rx('(police|commissioner of oaths)[^.]{0,60}(stamp|certif|attest)'),
      rx('(stamp|certif\\w*)[^.]{0,50}(not older than|younger than)')
    ],
    negative: [rx('good standing')],
    vaultHints: { category: 'COMPLIANCE', keywords: ['certified', 'police', 'oaths', 'id copy'] },
    notes: 'Zanostack Tenders flags any vault document whose certification stamp is older than 90 days.'
  },
  {
    key: 'csd',
    title: 'CSD / Central Supplier Database Registration',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 70,
    patterns: [rx('central supplier database'), rx('\\bcsd\\b'), rx('supplier\\s*(database|registration|number)')],
    vaultHints: { category: 'COMPLIANCE', keywords: ['csd', 'supplier database', 'supplier'] }
  },
  {
    key: 'vat',
    title: 'VAT Registration Number',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'INFORMATIONAL',
    order: 80,
    patterns: [rx('\\bvat\\s*(registration|number|certificate)'), rx('value added tax')],
    vaultHints: { category: 'FINANCIAL', keywords: ['vat', 'tax'] }
  },
  {
    key: 'sbd_forms',
    title: 'Signed SBD / MBD Returnable Forms',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 90,
    patterns: [rx('\\b(sbd|mbd)\\s*\\d'), rx('returnable\\s*(document|form|s)?\\b'), rx('\\bannexure\\s*[a-z]\\b')],
    vaultHints: { category: 'GOVERNANCE', keywords: ['sbd', 'mbd', 'form', 'returnable'] }
  },
  {
    key: 'signed_initialled',
    title: 'All Pages Signed & Initialled',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 100,
    patterns: [
      rx('sign(ed|ing)?\\s*(and|&|or|,)?\\s*initial'),
      rx('initial(l)?(ed|ling)?\\s*(each|all|every)\\s*page'),
      rx('paraph\\w*\\s*(each|all|every)'),
      rx('every page[^.]{0,40}(sign|initial)')
    ],
    vaultHints: { category: 'GOVERNANCE', keywords: ['signed', 'initialled'] }
  },
  {
    key: 'original_docs',
    title: 'Original / Certified Documents Only',
    category: 'GENERAL_RETURNABLE',
    riskLevel: 'INFORMATIONAL',
    order: 110,
    patterns: [rx('original\\s*(documents?|copies?|certificates?|receipts?)'), rx('no\\s*(photocopies|copies)\\s*(will be\\s*)?accepted')],
    vaultHints: { category: 'GOVERNANCE', keywords: ['original'] }
  },
  {
    key: 'validity_period',
    title: 'Bid Validity Period',
    category: 'GENERAL_RETURNABLE',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 120,
    patterns: [rx('validity\\s*(period|of)\\s*(the\\s*)?(bid|offer|proposal|quotation|tender)?'), rx('bids?\\s*(remain|valid)\\s*valid\\s*for'), rx('valid\\s*for\\s*(a\\s*(further\\s*)?)?\\d+\\s*(days?|months?)')],
    vaultHints: { category: 'GOVERNANCE', keywords: ['validity'] }
  },
  {
    key: 'non_compliance',
    title: 'Non-Compliance / Disqualification Clause',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 130,
    patterns: [
      rx('fail(s|ure|ing)?\\s*to\\s*(comply|submit|provide|furnish)'),
      rx('non[- ]responsive'),
      rx('(will|may|shall)?\\s*be\\s*(disqualified|rejected|returned)'),
      rx('not\\s*be\\s*(considered|evaluated)'),
      rx('disqualif\\w*')
    ],
    vaultHints: { category: 'GOVERNANCE', keywords: [] }
  },
  {
    key: 'experience',
    title: 'Relevant Experience / Similar Projects',
    category: 'FUNCTIONALITY_STAGE_2',
    riskLevel: 'POINT_SCORED',
    order: 200,
    patterns: [
      rx('(relevant|proven|demonstrable)\\s*(experience|track record|capability)'),
      rx('similar\\s*(projects?|contracts?|works?|installations?)'),
      rx('reference\\s*(projects?|lists?|letters?|sites?)'),
      rx('track record')
    ],
    vaultHints: { category: 'TECHNICAL', keywords: ['experience', 'reference', 'track record', 'project'] }
  },
  {
    key: 'key_personnel',
    title: 'Key Personnel CVs & Qualifications',
    category: 'FUNCTIONALITY_STAGE_2',
    riskLevel: 'POINT_SCORED',
    order: 210,
    patterns: [
      rx('curriculum vitae|\\bcv\\b|\\bcvs\\b'),
      rx('key\\s*(personnel|staff|people|team)'),
      rx('(professional|engineer|technician|manager)s?\\s*(qualifications?|registration|certificates?)'),
      rx('\\bpr\\s*(eng|tech)\\b'),
      rx('sac\\w*\\s*(registered|registration)')
    ],
    vaultHints: { category: 'CV', keywords: ['cv', 'curriculum', 'personnel', 'qualification', 'engineer'] }
  },
  {
    key: 'methodology',
    title: 'Methodology / Work Programme Submission',
    category: 'FUNCTIONALITY_STAGE_2',
    riskLevel: 'POINT_SCORED',
    order: 220,
    patterns: [rx('methodolog\\w*'), rx('work\\s*(programme|program|plan|schedule)'), rx('implementation\\s*(plan|programme|approach)'), rx('project\\s*(plan|approach|method)')],
    vaultHints: { category: 'TECHNICAL', keywords: ['methodology', 'programme', 'plan'] }
  },
  {
    key: 'financials',
    title: 'Audited Financial Statements (3 Years)',
    category: 'FINANCIAL_STAGE_3',
    riskLevel: 'POINT_SCORED',
    order: 300,
    patterns: [
      rx('audited\\s*financial'),
      rx('financial\\s*statements?'),
      rx('management\\s*accounts?'),
      rx('annual\\s*financial\\s*statements?')
    ],
    vaultHints: { category: 'FINANCIAL', keywords: ['financial', 'audited', 'statements', 'management accounts'] }
  },
  {
    key: 'turnover',
    title: 'Minimum Annual Turnover Requirement',
    category: 'FINANCIAL_STAGE_3',
    riskLevel: 'POINT_SCORED',
    order: 310,
    patterns: [rx('annual\\s*turnover'), rx('turnover\\s*(of|r\\s*\\d|exceeding|at least|minimum)'), rx('average\\s*annual\\s*turnover')],
    vaultHints: { category: 'FINANCIAL', keywords: ['turnover', 'financial'] }
  },
  {
    key: 'bid_security',
    title: 'Bid Security / Guarantee Deposit',
    category: 'FINANCIAL_STAGE_3',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 320,
    patterns: [
      rx('bid\\s*(bond|security|guarantee)'),
      rx('security\\s*deposit'),
      rx('performance\\s*(guarantee|bond|security)'),
      rx('guarantee\\s*(of|for)\\s*r\\s*\\d')
    ],
    vaultHints: { category: 'FINANCIAL', keywords: ['guarantee', 'bond', 'security'] }
  },
  {
    key: 'pppfa',
    title: 'Preferential Procurement (80:20 / 90:10) Scoring',
    category: 'FINANCIAL_STAGE_3',
    riskLevel: 'POINT_SCORED',
    order: 330,
    patterns: [rx('preferential procurement'), rx('(80|90)\\s*[:/]\\s*(20|10)'), rx('pppfa'), rx('preferential points?')],
    vaultHints: { category: 'GOVERNANCE', keywords: ['preferential', 'pppfa'] }
  },
  {
    key: 'subcontracting',
    title: 'Sub-Contracting / Enterprise Development Target',
    category: 'FINANCIAL_STAGE_3',
    riskLevel: 'POINT_SCORED',
    order: 340,
    patterns: [
      rx('sub[- ]?contract(ing|ed)?\\s*(plan|target|%|portion|percentage|to)'),
      rx('enterprise\\s*(and supplier)?\\s*development'),
      rx('local\\s*(content|production|manufacturing)')
    ],
    vaultHints: { category: 'GOVERNANCE', keywords: ['sub-contract', 'subcontract', 'enterprise development', 'local content'] }
  },
  {
    key: 'joint_venture',
    title: 'Joint Venture / Consortium Agreement',
    category: 'GENERAL_RETURNABLE',
    riskLevel: 'INFORMATIONAL',
    order: 400,
    patterns: [rx('joint\\s*venture'), rx('\\bconsortium\\b'), rx('\\bJV\\b')],
    vaultHints: { category: 'GOVERNANCE', keywords: ['joint venture', 'consortium'] }
  },
  {
    key: 'declaration',
    title: 'Declaration of Interest / Deregistration Certificate',
    category: 'MANDATORY_STAGE_1',
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 410,
    patterns: [
      rx('declaration\\s*of\\s*interest'),
      rx('conflict\\s*of\\s*interest'),
      rx('deregistration\\s*certificate'),
      rx('declaration\\s*of\\s*(bid|tender)')
    ],
    vaultHints: { category: 'GOVERNANCE', keywords: ['declaration', 'interest'] }
  },
  {
    key: 'closing_time',
    title: 'Closing Date & Late Submission Rule',
    category: 'GENERAL_RETURNABLE',
    riskLevel: 'INFORMATIONAL',
    order: 500,
    patterns: [
      rx('closing\\s*(date|time)'),
      rx('late\\s*(submissions?|bids?|tenders?)'),
      rx('no\\s*later\\s*than'),
      rx('deposited\\s*in\\s*the\\s*(bid|tender)\\s*box')
    ],
    vaultHints: { category: 'GOVERNANCE', keywords: [] }
  },
  {
    key: 'contact_person',
    title: 'Clarifications Contact Person',
    category: 'GENERAL_RETURNABLE',
    riskLevel: 'INFORMATIONAL',
    order: 510,
    patterns: [
      rx('contact\\s*(person|details|officer|information)'),
      rx('clarifications?\\s*(may|should|must|can)\\s*be'),
      rx('enquir\\w*\\s*(may|should|must|can)?\\s*be\\s*directed')
    ],
    vaultHints: { category: 'GOVERNANCE', keywords: [] }
  }
]

export const RULE_BY_KEY: Record<string, TenderRule> = Object.fromEntries(
  TENDER_RULES.map((r) => [r.key, r])
)

/** Mandatory-sounding language inside a matched clause. */
export const MANDATORY_LANGUAGE = /(must|shall|is\s*(\/\s*are)?\s*required|are\s*required|failing\s*which|no\s*(bid|tender|offer)\s*will\s*be|will\s*(be\s*)?(disqualified|rejected|returned|excluded))/i

/** Disqualifying language — escalates risk to CRITICAL_DISQUALIFIER. */
export const DISQUALIFIER_LANGUAGE = /(disqualif|rejected|non[- ]responsive|will\s*not\s*be\s*(considered|evaluated|accepted)|fail(s|ure|ing)?\s*to\s*(comply|submit|provide|furnish)|failing\s*which|returnable)/i

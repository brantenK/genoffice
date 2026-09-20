// Synthetic Tenders intake corpus — fixture specs + gold annotations.
//
// These are SYNTHETIC documents authored for measurement only. They are NOT
// real tenders and their accuracy numbers are NOT evidence of real-world parser
// quality. They exist so Phase 3 intake can be measured deterministically and
// offline until a licensed/anonymised real corpus is available.
//
// Gold annotations are the ground truth a corrected intake flow must produce.
// They are generated from the same specs that render the PDFs (single source of
// truth) and written to
//   apps/tenders/tests/fixtures/tenders-corpus/gold/<id>.json
// by `generate-fixtures.mjs`.

/** Rule catalogue metadata mirrored for gold classification (not parser output). */
export const RULE_META = {
  tax_pin: { category: 'MANDATORY_STAGE_1', risk: 'CRITICAL_DISQUALIFIER' },
  coida: { category: 'MANDATORY_STAGE_1', risk: 'CRITICAL_DISQUALIFIER' },
  bbbee: { category: 'MANDATORY_STAGE_1', risk: 'POINT_SCORED' },
  cipc: { category: 'MANDATORY_STAGE_1', risk: 'CRITICAL_DISQUALIFIER' },
  director_ids: { category: 'MANDATORY_STAGE_1', risk: 'CRITICAL_DISQUALIFIER' },
  police_certification: { category: 'MANDATORY_STAGE_1', risk: 'CRITICAL_DISQUALIFIER' },
  csd: { category: 'MANDATORY_STAGE_1', risk: 'CRITICAL_DISQUALIFIER' },
  vat: { category: 'MANDATORY_STAGE_1', risk: 'INFORMATIONAL' },
  sbd_forms: { category: 'MANDATORY_STAGE_1', risk: 'CRITICAL_DISQUALIFIER' },
  signed_initialled: { category: 'MANDATORY_STAGE_1', risk: 'CRITICAL_DISQUALIFIER' },
  original_docs: { category: 'GENERAL_RETURNABLE', risk: 'INFORMATIONAL' },
  validity_period: { category: 'GENERAL_RETURNABLE', risk: 'CRITICAL_DISQUALIFIER' },
  non_compliance: { category: 'MANDATORY_STAGE_1', risk: 'CRITICAL_DISQUALIFIER' },
  experience: { category: 'FUNCTIONALITY_STAGE_2', risk: 'POINT_SCORED' },
  key_personnel: { category: 'FUNCTIONALITY_STAGE_2', risk: 'POINT_SCORED' },
  methodology: { category: 'FUNCTIONALITY_STAGE_2', risk: 'POINT_SCORED' },
  financials: { category: 'FINANCIAL_STAGE_3', risk: 'POINT_SCORED' },
  turnover: { category: 'FINANCIAL_STAGE_3', risk: 'POINT_SCORED' },
  bid_security: { category: 'FINANCIAL_STAGE_3', risk: 'CRITICAL_DISQUALIFIER' },
  pppfa: { category: 'FINANCIAL_STAGE_3', risk: 'POINT_SCORED' },
  subcontracting: { category: 'FINANCIAL_STAGE_3', risk: 'POINT_SCORED' },
  pricing_schedule: { category: 'FINANCIAL_STAGE_3', risk: 'CRITICAL_DISQUALIFIER' },
  bill_of_quantities: { category: 'FINANCIAL_STAGE_3', risk: 'POINT_SCORED' },
  joint_venture: { category: 'GENERAL_RETURNABLE', risk: 'INFORMATIONAL' },
  declaration: { category: 'MANDATORY_STAGE_1', risk: 'CRITICAL_DISQUALIFIER' },
  closing_time: { category: 'GENERAL_RETURNABLE', risk: 'INFORMATIONAL' },
  contact_person: { category: 'GENERAL_RETURNABLE', risk: 'INFORMATIONAL' },
}

/** Canonical, parser-friendly wording for each catalogue requirement. */
export const REQ_SENTENCE = {
  tax_pin: 'A valid SARS Tax Clearance Certificate or TCS PIN must be submitted with the bid.',
  coida:
    'A valid COIDA Letter of Good Standing from the Compensation Fund must be attached to the bid.',
  bbbee:
    'Bidders must submit a valid Broad-Based Black Economic Empowerment (B-BBEE) certificate or sworn affidavit.',
  cipc: 'A certified copy of the CIPC company registration documents (COR 14.3 or CK1) is required.',
  director_ids:
    'Certified copies of the identity documents of all directors of the bidding entity must be attached.',
  police_certification:
    'Every supporting document must be certified by a Commissioner of Oaths and not older than three months.',
  csd: 'The Central Supplier Database (CSD) supplier registration number must be provided.',
  vat: 'A valid VAT registration number must be indicated on the pricing schedule.',
  sbd_forms: 'All returnable SBD forms must be completed and signed by the authorised bidder.',
  signed_initialled: 'The bidder must sign and initial every page of the tender document.',
  original_docs: 'Only original documents will be accepted for the returnable annexures.',
  validity_period: 'Bids will remain valid for 90 days from the closing date.',
  non_compliance:
    'Failure to submit the required documents will result in the bid being declared non-responsive.',
  experience: 'Bidders must demonstrate proven experience on similar projects of comparable value.',
  key_personnel:
    'Curriculum vitae and professional registration of key personnel must be submitted with the bid.',
  methodology:
    'A comprehensive project implementation methodology and work programme must be provided.',
  financials: 'Audited financial statements for the past three consecutive years are required.',
  turnover: 'A minimum annual turnover of R 5 million is required to qualify.',
  bid_security: 'A bid security guarantee of R 50 000 must accompany the bid.',
  pppfa:
    'Tenders will be evaluated using the 80/20 preferential procurement scoring system in terms of the PPPFA.',
  subcontracting:
    'A minimum of 30% subcontracting to designated local enterprise development entities is required.',
  joint_venture: 'Joint venture agreements must be registered with the CIPC before submission.',
  declaration: 'A signed declaration of interest must be submitted with the bid documents.',
  closing_time: 'Bidders must deliver their submissions before the closing date and time.',
  contact_person: 'Clarifications may be directed to the contact person listed on the cover page.',
}

const CRITICAL_FIELDS = [
  'title',
  'referenceNumber',
  'issuingBody',
  'closingDateTime',
  'submissionMethod',
  'submissionDestination',
]

/** Build a standard single-column cover page line list. */
function coverLines(f) {
  const lines = [f.issuer]
  if (f.dept) lines.push(f.dept)
  lines.push(f.heading)
  lines.push(f.title)
  if (f.ref) lines.push(`${f.refLabel ?? 'Tender Reference Number'}: ${f.ref}`)
  lines.push(`Closing Date: ${f.closingLine}`)
  if (f.contactLine) lines.push(f.contactLine)
  if (f.submitLine) lines.push(f.submitLine)
  return lines
}

/** Requirement block lines for a set of rule keys, with optional OCR variants. */
export function reqLines(keys, variants = {}) {
  const lines = ['MANDATORY RETURNABLE DOCUMENTS AND EVALUATION CRITERIA']
  for (const key of keys) {
    lines.push(variants[key] ?? REQ_SENTENCE[key])
  }
  return lines
}

const PRICING_SENTENCE = {
  pricing_schedule:
    'Pricing must be submitted on the prescribed pricing schedule in South African Rand, inclusive of VAT.',
  bill_of_quantities:
    'A detailed bill of quantities (BOQ) with unit rates and totals must be completed for every line item.',
}

function pricingLines(keys) {
  return keys.map((key) => PRICING_SENTENCE[key] ?? key)
}

/**
 * Normalise a fixture config into { pages, gold }.
 * `opts.pages` (when present) overrides the default cover+body assembly.
 */
function fx(opts) {
  const scannedOnlyEarly = opts.scannedOnly === true
  // The rule catalogue treats the closing date/time and the clarifications
  // contact as GENERAL_RETURNABLE rules. Whenever the cover states them the
  // parser legitimately lifts them, so gold must list them too — otherwise the
  // false-positive metric would count correct extractions as errors.
  const autoKeys = []
  if (!scannedOnlyEarly && opts.closingLine) autoKeys.push('closing_time')
  if (!scannedOnlyEarly && opts.contactLine) autoKeys.push('contact_person')
  const pricingKeys = [...new Set(opts.pricing ?? [])]
  // Pricing/BOQ rules are real catalogue requirements, so they belong in the
  // expected set as well as in the pricing subset used for pricing recall.
  const expectedRequirementKeys = [
    ...new Set([...(opts.requirements ?? []), ...autoKeys, ...pricingKeys]),
  ]
  const derivedMandatory = expectedRequirementKeys.filter((key) => {
    const meta = RULE_META[key]
    return meta && (meta.category === 'MANDATORY_STAGE_1' || meta.risk === 'CRITICAL_DISQUALIFIER')
  })
  const derivedDisqualifiers = expectedRequirementKeys.filter(
    (key) => RULE_META[key]?.risk === 'CRITICAL_DISQUALIFIER',
  )

  const pages = opts.pages ?? [
    { mode: 'native', layout: 'single', lines: coverLines(opts) },
    ...(opts.body ?? []),
  ]

  const scannedPages = opts.scannedPages ?? []
  const scannedOnly = opts.scannedOnly === true

  // A fixture is "clearable" when the document itself is unambiguous and
  // complete: no scanned page that must block readiness and no competing
  // critical value. A correct intake could auto-clear such a fixture; a
  // confidently-wrong parse of any other fixture is a false readiness.
  const hasConflict = Object.keys(opts.conflicts ?? {}).length > 0
  const defaultClearable =
    opts.scannedOnly !== true && (opts.scannedPages?.length ?? 0) === 0 && !hasConflict

  const gold = {
    id: opts.id,
    synthetic: true,
    sector: opts.sector,
    issuerType: opts.issuerType,
    tags: opts.tags ?? [],
    title: scannedOnly ? null : (opts.title ?? null),
    titleAlternatives: scannedOnly ? [] : (opts.titleAlternatives ?? []),
    referenceNumber: scannedOnly ? null : (opts.ref ?? null),
    issuingBody: scannedOnly ? null : (opts.issuer ?? null),
    closingDateTime: scannedOnly ? null : (opts.goldClosing ?? opts.closingLine ?? null),
    submissionMethod: scannedOnly ? null : (opts.method ?? null),
    submissionDestination: scannedOnly ? null : (opts.destination ?? null),
    expectedRequirementKeys,
    mandatoryRequirements: opts.mandatory ?? derivedMandatory,
    disqualifiers: opts.disqualifiers ?? derivedDisqualifiers,
    pricingRequirements: pricingKeys,
    conflicts: opts.conflicts ?? {},
    unconfirmedFields: opts.unconfirmedFields ?? (scannedOnly ? [...CRITICAL_FIELDS] : []),
    scannedPages: scannedOnly ? (opts.pageNumbers ?? [1]) : scannedPages,
    pageCount: pages.length,
    clearable: opts.clearable ?? defaultClearable,
    sources: scannedOnly
      ? { unavailable: 'scanned-only fixture has no text layer' }
      : buildSources(opts, expectedRequirementKeys),
  }

  return { pages, gold }
}

function buildSources(opts, requirementKeys) {
  const reqPage = opts.reqPage ?? 2
  const sources = {
    title: { page: 1, clauseContains: opts.title },
    referenceNumber: opts.ref
      ? { page: 1, clauseContains: `${opts.refLabel ?? 'Tender Reference Number'}: ${opts.ref}` }
      : null,
    issuingBody: { page: 1, clauseContains: opts.issuer },
    closingDateTime: { page: 1, clauseContains: `Closing Date: ${opts.closingLine}` },
    submissionMethod: { page: opts.submitPage ?? 1, clauseContains: opts.destination },
    submissionDestination: { page: opts.submitPage ?? 1, clauseContains: opts.destination },
    requirements: Object.fromEntries(requirementKeys.map((key) => [key, { page: reqPage }])),
  }
  if (opts.conflictSource) Object.assign(sources, opts.conflictSource)
  return sources
}

// ── fixture matrix ────────────────────────────────────────────────────────────

/** Office-equipment, municipal issuer, pricing schedule + BOQ, physical. */
function officeFixtures() {
  return [
    fx({
      id: 'ofc-gov-clean-001',
      sector: 'office-equipment',
      issuerType: 'government',
      tags: ['office-equipment', 'government', 'native', 'clean', 'pricing-schedule'],
      issuer: 'DEPARTMENT OF PUBLIC WORKS AND INFRASTRUCTURE',
      dept: 'OFFICE EQUIPMENT PROCUREMENT',
      heading: 'INVITATION TO TENDER',
      title: 'Supply and Delivery of Multifunction Office Printers',
      ref: 'DPWI-OFC-2026-0114',
      refLabel: 'Tender Reference Number',
      closingLine: '30 November 2026 at 11:00',
      contactLine: 'Contact Person: Ms Naledi Khumalo · Tel: 012 406 1200',
      submitLine:
        'Completed bids must be deposited into the bid box at the DPWI reception, Pretoria.',
      method: 'PHYSICAL',
      destination: 'bid box at the DPWI reception, Pretoria',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'director_ids',
        'csd',
        'sbd_forms',
        'signed_initialled',
        'declaration',
        'experience',
        'methodology',
        'financials',
        'non_compliance',
      ],
      pricing: ['pricing_schedule', 'bill_of_quantities'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'coida', 'bbbee', 'cipc', 'director_ids', 'csd']),
        },
        {
          mode: 'native',
          layout: 'table',
          columnXs: [50, 230, 420],
          rows: [
            ['Item', 'Description', 'Quantity'],
            ['1', 'Multifunction printer A3 mono', '40'],
            ['2', 'Multifunction printer A3 colour', '25'],
            ['3', 'Consumables and toner', '1 lot'],
            ['Note', 'Pricing must be submitted on the prescribed pricing schedule.', ''],
          ],
        },
        {
          mode: 'native',
          layout: 'single',
          lines: pricingLines(['pricing_schedule', 'bill_of_quantities']),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines([
            'sbd_forms',
            'signed_initialled',
            'declaration',
            'experience',
            'methodology',
            'financials',
            'non_compliance',
          ]),
        },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'ofc-mun-boq-002',
      sector: 'office-equipment',
      issuerType: 'municipal',
      tags: ['office-equipment', 'municipal', 'pricing-schedule', 'boq', 'table'],
      issuer: 'CITY OF EKURHULENI METROPOLITAN MUNICIPALITY',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Framework Contract for Office Equipment and Consumables',
      ref: 'RFP-OFC-2026-0087',
      closingLine: '15 December 2026 at 10:00',
      contactLine: 'Contact Person: Mr Sipho Mthembu · Tel: 011 999 4432',
      submitLine:
        'Proposals must be deposited into the tender box at the Civic Centre, Kempton Park.',
      method: 'PHYSICAL',
      destination: 'tender box at the Civic Centre, Kempton Park',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'csd',
        'sbd_forms',
        'financials',
        'turnover',
        'pppfa',
      ],
      pricing: ['bill_of_quantities', 'pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'coida', 'bbbee', 'cipc', 'csd', 'sbd_forms']),
        },
        {
          mode: 'native',
          layout: 'table',
          columnXs: [50, 235, 430],
          rows: [
            ['No.', 'BOQ line item', 'Unit rate (R)'],
            ['1', 'A4 multifunction printer', ''],
            ['2', 'Toner cartridge black', ''],
            ['3', 'Toner cartridge colour', ''],
            ['4', 'Paper A4 80gsm per box', ''],
          ],
        },
        {
          mode: 'native',
          layout: 'single',
          lines: pricingLines(['bill_of_quantities', 'pricing_schedule']),
        },
        { mode: 'native', layout: 'single', lines: reqLines(['financials', 'turnover', 'pppfa']) },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'ofc-mun-email-003',
      sector: 'office-equipment',
      issuerType: 'municipal',
      tags: ['office-equipment', 'municipal', 'email', 'pricing-schedule'],
      issuer: 'NELSON MANDELA BAY METROPOLITAN MUNICIPALITY',
      dept: 'SUPPLY CHAIN MANAGEMENT UNIT',
      heading: 'REQUEST FOR QUOTATION',
      title: 'Quotation for Laptops, Docking Stations and Monitors',
      ref: 'RFQ-SCM-2026-0451',
      refLabel: 'Reference No',
      closingLine: '04 December 2026 at 12:00',
      contactLine: 'Contact Person: Ms Anele Dlamini · Tel: 041 506 1900',
      submitLine:
        'Submissions must be sent by email to scmquotes@mandela.gov.za before the closing time.',
      method: 'EMAIL',
      destination: 'scmquotes@mandela.gov.za',
      requirements: ['tax_pin', 'bbbee', 'csd', 'sbd_forms', 'signed_initialled', 'financials'],
      pricing: ['pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'bbbee', 'csd', 'sbd_forms']),
        },
        { mode: 'native', layout: 'single', lines: pricingLines(['pricing_schedule']) },
        { mode: 'native', layout: 'single', lines: reqLines(['signed_initialled', 'financials']) },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'ofc-prov-two-col-004',
      sector: 'office-equipment',
      issuerType: 'provincial-government',
      tags: ['office-equipment', 'provincial', 'two-column', 'native'],
      issuer: 'GAUTENG DEPARTMENT OF HEALTH',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'INVITATION TO BID',
      title: 'Supply of Office Furniture for Regional Hospitals',
      ref: 'GT-DOH-2026-0233',
      closingLine: '22 January 2027 at 11:00',
      contactLine: 'Contact Person: Mr Peter Nkosi · Tel: 011 355 3000',
      submitLine:
        'Bids must be delivered to the bid box at the Bank of Lisbon Building, Johannesburg.',
      method: 'PHYSICAL',
      destination: 'bid box at the Bank of Lisbon Building, Johannesburg',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'director_ids',
        'csd',
        'sbd_forms',
        'experience',
        'non_compliance',
      ],
      pricing: ['bill_of_quantities', 'pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'two-column',
          left: [
            'SECTION A: COMPLIANCE',
            'A valid SARS Tax Clearance Certificate or TCS PIN must be',
            'submitted with the bid, failing which the bid will be',
            'disqualified.',
            'A valid COIDA Letter of Good Standing from the Compensation',
            'Fund must be attached to the bid.',
            'Bidders must submit a valid Broad-Based Black Economic',
            'Empowerment (B-BBEE) certificate or sworn affidavit.',
          ],
          right: [
            'SECTION B: GOVERNANCE',
            'A certified copy of the CIPC company registration documents',
            '(COR 14.3 or CK1) is required.',
            'Certified copies of the identity documents of all directors',
            'of the bidding entity must be attached.',
            'The Central Supplier Database (CSD) supplier registration',
            'number must be provided.',
            'All returnable SBD forms must be completed and signed.',
          ],
        },
        {
          mode: 'native',
          layout: 'table',
          columnXs: [50, 240, 430],
          rows: [
            ['Item', 'Furniture description', 'Qty'],
            ['1', 'Executive desk 1800mm', '12'],
            ['2', 'Ergonomic office chair', '48'],
            ['3', 'Steel filing cabinet 4 drawer', '60'],
          ],
        },
        { mode: 'native', layout: 'single', lines: pricingLines(['bill_of_quantities']) },
        { mode: 'native', layout: 'single', lines: reqLines(['experience']) },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'ofc-gov-scan-005',
      sector: 'office-equipment',
      issuerType: 'government',
      tags: ['office-equipment', 'government', 'scanned-only', 'ocr-required'],
      issuer: 'DEPARTMENT OF BASIC EDUCATION',
      heading: 'INVITATION TO TENDER',
      title: 'Supply of Office Equipment (scanned advertisement)',
      ref: 'DBE-OFC-2026-0340',
      closingLine: '18 December 2026 at 11:00',
      method: 'PHYSICAL',
      destination: 'bid box at Sol Plaatje House, Pretoria',
      pages: [{ mode: 'scan' }, { mode: 'scan' }],
      scannedOnly: true,
      pageNumbers: [1, 2],
    }),

    fx({
      id: 'ofc-gov-mixed-006',
      sector: 'office-equipment',
      issuerType: 'government',
      tags: ['office-equipment', 'government', 'mixed', 'ocr-required'],
      issuer: 'SOUTH AFRICAN POLICE SERVICE',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'INVITATION TO TENDER',
      title: 'Procurement of Office Equipment for Police Stations',
      ref: 'SAPS-OFC-2026-0788',
      closingLine: '27 November 2026 at 11:00',
      contactLine: 'Contact Person: Capt Mokoena · Tel: 012 393 2000',
      submitLine: 'Bids must be deposited into the bid box at the SAPS Head Office, Pretoria.',
      method: 'PHYSICAL',
      destination: 'bid box at the SAPS Head Office, Pretoria',
      requirements: ['tax_pin', 'coida', 'bbbee', 'csd', 'sbd_forms'],
      pricing: ['bill_of_quantities', 'pricing_schedule'],
      body: [
        { mode: 'scan' },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'coida', 'bbbee', 'csd', 'sbd_forms']),
        },
        { mode: 'native', layout: 'single', lines: pricingLines(['bill_of_quantities']) },
        { mode: 'scan' },
      ],
      scannedPages: [2, 5],
      reqPage: 3,
    }),

    fx({
      id: 'ofc-mun-conflict-007',
      sector: 'office-equipment',
      issuerType: 'municipal',
      tags: ['office-equipment', 'municipal', 'conflict', 'amended-deadline'],
      issuer: 'CITY OF TSHWANE METROPOLITAN MUNICIPALITY',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'INVITATION TO TENDER',
      title: 'Supply of Office Equipment and Consumables',
      ref: 'COT-OFC-2026-0155',
      closingLine: '20 November 2026 at 11:00',
      contactLine: 'Contact Person: Ms Lindiwe Mahlangu · Tel: 012 358 9999',
      submitLine: 'Bids must be deposited into the bid box at the Tshwane House, Pretoria.',
      method: 'PHYSICAL',
      destination: 'bid box at the Tshwane House, Pretoria',
      requirements: ['tax_pin', 'bbbee', 'cipc', 'csd', 'sbd_forms'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'bbbee', 'cipc', 'csd', 'sbd_forms']),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: [
            'ADDENDUM NO. 1 TO TENDER COT-OFC-2026-0155',
            'The closing date of the above tender is hereby amended.',
            'Amended Closing Date: 27 November 2026 at 11:00',
            'Bidders are advised that no other conditions of the tender have changed.',
          ],
        },
      ],
      goldClosing: null,
      conflicts: { closingDateTime: true },
      unconfirmedFields: ['closingDateTime'],
      conflictSource: {
        closingDateTime: { page: 1, clauseContains: 'Closing Date: 20 November 2026 at 11:00' },
      },
    }),

    fx({
      id: 'ofc-gov-tz-008',
      sector: 'office-equipment',
      issuerType: 'government',
      tags: ['office-equipment', 'government', 'timezone', 'rfc3339'],
      issuer: 'DEPARTMENT OF INTERNATIONAL RELATIONS AND COOPERATION',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Provision of Office Equipment for Missions Abroad',
      ref: 'DIRCO-OFC-2026-0099',
      closingLine: '2026-12-11T11:00:00+02:00',
      contactLine: 'Contact Person: Mr Johan van der Merwe · Tel: 012 351 0000',
      submitLine: 'Proposals must be delivered to the tender box at OR Tambo Building, Pretoria.',
      method: 'PHYSICAL',
      destination: 'tender box at OR Tambo Building, Pretoria',
      requirements: ['tax_pin', 'coida', 'bbbee', 'csd', 'sbd_forms', 'financials'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'coida', 'bbbee', 'csd', 'sbd_forms', 'financials']),
        },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'ofc-gov-tz-sast-009',
      sector: 'office-equipment',
      issuerType: 'government',
      tags: ['office-equipment', 'government', 'timezone', 'unsupported-abbreviation'],
      issuer: 'DEPARTMENT OF TRANSPORT',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'INVITATION TO TENDER',
      title: 'Supply of Office Equipment for Driver Testing Centres',
      ref: 'DOT-OFC-2026-0666',
      closingLine: '02 December 2026 at 11:00 SAST',
      contactLine: 'Contact Person: Ms Refilwe Sithole · Tel: 012 309 3000',
      submitLine: 'Bids must be deposited into the bid box at Forum Building, Pretoria.',
      method: 'PHYSICAL',
      destination: 'bid box at Forum Building, Pretoria',
      requirements: ['tax_pin', 'bbbee', 'csd', 'sbd_forms'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'bbbee', 'csd', 'sbd_forms']),
        },
      ],
      // The strict schema parser does not accept a trailing zone abbreviation,
      // so gold keeps the intended civil value while the parser returns null.
      goldClosing: '02 December 2026 at 11:00',
      reqPage: 2,
    }),

    fx({
      id: 'ofc-corp-table-010',
      sector: 'office-equipment',
      issuerType: 'corporate',
      tags: ['office-equipment', 'corporate', 'table', 'incidental-false-positive'],
      issuer: 'SASOL SOUTH AFRICA LIMITED',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Supply of Office Equipment to Sasol Head Office',
      ref: 'SASOL-OFC-2026-0071',
      closingLine: '08 December 2026 at 12:00',
      contactLine: 'Contact Person: Procurement Desk · Tel: 011 441 3111',
      submitLine: 'Proposals must be uploaded to the Sasol supplier portal before closing.',
      method: 'ELECTRONIC',
      destination: 'Sasol supplier portal',
      requirements: ['tax_pin', 'bbbee', 'cipc', 'sbd_forms', 'financials'],
      pricing: ['bill_of_quantities', 'pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'table',
          columnXs: [50, 220, 420],
          rows: [
            ['Requirement', 'Detail', 'Returnable'],
            ['Tax', 'A valid SARS Tax Clearance Certificate or TCS PIN must be submitted.', 'Yes'],
            [
              'Empowerment',
              'Bidders must submit a valid BBBEE certificate or sworn affidavit.',
              'Yes',
            ],
            [
              'Registration',
              'A certified copy of the CIPC company registration documents is required.',
              'Yes',
            ],
            [
              'Forms',
              'All returnable SBD forms must be completed and signed by the bidder.',
              'Yes',
            ],
            [
              'Financials',
              'Audited financial statements for the past three consecutive years are required.',
              'Yes',
            ],
            // Incidental identifiers, NOT requirements: the parser should not
            // turn these into compliance-matrix items.
            [
              'Supplier info',
              'The bidder CIPC registration number must be quoted on the pricing schedule.',
              'No',
            ],
            [
              'Supplier info',
              'The bidder VAT registration number must appear on the invoice.',
              'No',
            ],
          ],
        },
        { mode: 'native', layout: 'single', lines: pricingLines(['bill_of_quantities']) },
      ],
      reqPage: 2,
    }),
  ]
}

/** Construction / civil issuers, BOQ and CIDB-style functionality. */
function civilFixtures() {
  return [
    fx({
      id: 'civ-mun-clean-011',
      sector: 'construction-civil',
      issuerType: 'municipal',
      tags: ['construction', 'municipal', 'native', 'clean'],
      issuer: 'CITY OF CAPE TOWN MUNICIPALITY',
      dept: 'TRANSPORT AND URBAN DEVELOPMENT',
      heading: 'INVITATION TO TENDER',
      title: 'Bulk Water Pipeline Rehabilitation in Khayelitsha',
      ref: 'CCT-CIV-2026-1420',
      closingLine: '29 January 2027 at 10:00',
      contactLine: 'Contact Person: Mr Deon Adams · Tel: 021 400 4300',
      submitLine: 'Tenders must be deposited into the tender box at the Civic Centre, Cape Town.',
      method: 'PHYSICAL',
      destination: 'tender box at the Civic Centre, Cape Town',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'director_ids',
        'csd',
        'sbd_forms',
        'signed_initialled',
        'non_compliance',
        'experience',
        'key_personnel',
        'methodology',
        'bid_security',
        'pppfa',
      ],
      pricing: ['bill_of_quantities', 'pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'coida', 'bbbee', 'cipc', 'director_ids', 'csd']),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines([
            'sbd_forms',
            'signed_initialled',
            'non_compliance',
            'experience',
            'key_personnel',
            'methodology',
            'bid_security',
            'pppfa',
          ]),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: pricingLines(['bill_of_quantities', 'pricing_schedule']),
        },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'civ-prov-boq-012',
      sector: 'construction-civil',
      issuerType: 'provincial-government',
      tags: ['construction', 'provincial', 'boq', 'bid-security'],
      issuer: 'KWAZULU-NATAL DEPARTMENT OF TRANSPORT',
      dept: 'ROADS AND BRIDGES',
      heading: 'INVITATION TO BID',
      title: 'Upgrade of Provincial Road P27/1 with Ancillary Works',
      ref: 'KZN-DOT-2026-0567',
      closingLine: '05 February 2027 at 11:00',
      contactLine: 'Contact Person: Mr Sibusiso Ndlovu · Tel: 033 355 8000',
      submitLine:
        'Bids must be deposited into the bid box at the Inkosi Albert Luthuli Central Hospital complex, Durban.',
      method: 'PHYSICAL',
      destination: 'bid box at the Inkosi Albert Luthuli Central Hospital complex, Durban',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'csd',
        'sbd_forms',
        'experience',
        'financials',
        'turnover',
        'bid_security',
      ],
      pricing: ['bill_of_quantities'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'coida', 'bbbee', 'csd', 'sbd_forms']),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['experience', 'financials', 'turnover', 'bid_security']),
        },
        {
          mode: 'native',
          layout: 'table',
          columnXs: [50, 240, 430],
          rows: [
            ['BOQ item', 'Description', 'Rate (R)'],
            ['1.1', 'Site establishment and mobilisation', ''],
            ['2.3', 'Bulk earthworks and layer works', ''],
            ['3.1', 'Asphalt surfacing 40mm', ''],
            ['4.2', 'Stormwater culverts and drainage', ''],
          ],
        },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'civ-mun-two-col-013',
      sector: 'construction-civil',
      issuerType: 'municipal',
      tags: ['construction', 'municipal', 'two-column'],
      issuer: 'BUFFALO CITY METROPOLITAN MUNICIPALITY',
      dept: 'ENGINEERING SERVICES',
      heading: 'INVITATION TO TENDER',
      title: 'Construction of Stormwater Reticulation in Mdantsane',
      ref: 'BCM-CIV-2026-0891',
      closingLine: '12 February 2027 at 11:00',
      contactLine: 'Contact Person: Mr Lutho Mbeki · Tel: 043 705 2000',
      submitLine: 'Tenders must be deposited into the tender box at the East London City Hall.',
      method: 'PHYSICAL',
      destination: 'tender box at the East London City Hall',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'csd',
        'sbd_forms',
        'experience',
        'methodology',
        'non_compliance',
      ],
      body: [
        {
          mode: 'native',
          layout: 'two-column',
          left: [
            'COMPLIANCE RETURNABLES',
            'A valid SARS Tax Clearance Certificate or TCS PIN must be',
            'submitted with the bid, failing which the bid will be',
            'disqualified.',
            'A valid COIDA Letter of Good Standing from the Compensation',
            'Fund must be attached to the bid.',
            'Bidders must submit a valid B-BBEE certificate or sworn',
            'affidavit.',
          ],
          right: [
            'FUNCTIONALITY CRITERIA',
            'Bidders must demonstrate proven experience on similar',
            'projects of comparable value.',
            'A comprehensive project implementation methodology and work',
            'programme must be provided.',
            'A certified copy of the CIPC company registration documents',
            'is required.',
            'The Central Supplier Database (CSD) supplier registration',
            'number must be provided.',
          ],
        },
        { mode: 'native', layout: 'single', lines: reqLines(['sbd_forms']) },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'civ-gov-scan-014',
      sector: 'construction-civil',
      issuerType: 'government',
      tags: ['construction', 'government', 'scanned-only', 'ocr-required'],
      issuer: 'SOUTH AFRICAN NATIONAL ROADS AGENCY SOC LIMITED',
      heading: 'INVITATION TO TENDER',
      title: 'Routine Road Maintenance (scanned drawings)',
      ref: 'SANRAL-CIV-2026-1102',
      closingLine: '16 January 2027 at 11:00',
      method: 'PHYSICAL',
      destination: 'bid box at SANRAL House, Pretoria',
      pages: [{ mode: 'scan' }, { mode: 'scan' }, { mode: 'scan' }],
      scannedOnly: true,
      pageNumbers: [1, 2, 3],
    }),

    fx({
      id: 'civ-gov-mixed-015',
      sector: 'construction-civil',
      issuerType: 'government',
      tags: ['construction', 'government', 'mixed', 'ocr-required'],
      issuer: 'DEPARTMENT OF WATER AND SANITATION',
      dept: 'CONSTRUCTION MANAGEMENT',
      heading: 'INVITATION TO BID',
      title: 'Construction of the Vlakfontein Bulk Water Reservoir',
      ref: 'DWS-CIV-2026-0455',
      closingLine: '19 February 2027 at 11:00',
      contactLine: 'Contact Person: Director SCM · Tel: 012 336 7500',
      submitLine: 'Bids must be deposited into the bid box at the Sedibeng Building, Pretoria.',
      method: 'PHYSICAL',
      destination: 'bid box at the Sedibeng Building, Pretoria',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'csd',
        'sbd_forms',
        'experience',
        'methodology',
        'bid_security',
      ],
      body: [
        { mode: 'scan' },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines([
            'tax_pin',
            'coida',
            'bbbee',
            'csd',
            'sbd_forms',
            'experience',
            'methodology',
            'bid_security',
          ]),
        },
        { mode: 'vector' },
      ],
      scannedPages: [2, 4],
      reqPage: 3,
    }),

    fx({
      id: 'civ-mun-conflict-016',
      sector: 'construction-civil',
      issuerType: 'municipal',
      tags: [
        'construction',
        'municipal',
        'conflict',
        'amended-deadline',
        'conflicting-destination',
      ],
      issuer: 'MANGAUNG METROPOLITAN MUNICIPALITY',
      dept: 'ENGINEERING SERVICES',
      heading: 'INVITATION TO TENDER',
      title: 'Rehabilitation of Water and Sewer Networks in Bloemfontein',
      ref: 'MAN-CIV-2026-0310',
      closingLine: '23 January 2027 at 11:00',
      contactLine: 'Contact Person: Mr Thabo Moloi · Tel: 051 409 8000',
      submitLine:
        'Tenders must be deposited into the tender box at Bram Fischer Building, Bloemfontein.',
      method: 'PHYSICAL',
      destination: 'tender box at Bram Fischer Building, Bloemfontein',
      requirements: ['tax_pin', 'bbbee', 'csd', 'sbd_forms', 'experience', 'bid_security'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'bbbee', 'csd', 'sbd_forms', 'experience', 'bid_security']),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: [
            'ADDENDUM 2: CLARIFICATIONS AND AMENDMENTS',
            'The closing date is amended to 30 January 2027 at 11:00.',
            'Bids must instead be submitted electronically via the municipal e-tender portal.',
            'The original bid box submission point no longer applies.',
          ],
        },
      ],
      goldClosing: null,
      conflicts: { closingDateTime: true },
      unconfirmedFields: ['closingDateTime'],
      conflictSource: {
        closingDateTime: { page: 1, clauseContains: 'Closing Date: 23 January 2027 at 11:00' },
      },
    }),

    fx({
      id: 'civ-gov-tz-017',
      sector: 'construction-civil',
      issuerType: 'government',
      tags: ['construction', 'government', 'timezone', 'rfc3339'],
      issuer: 'DEPARTMENT OF PUBLIC WORKS AND INFRASTRUCTURE',
      dept: 'CONSTRUCTION AND MAINTENANCE',
      heading: 'INVITATION TO BID',
      title: 'Refurbishment of Government Buildings in Polokwane',
      ref: 'DPWI-CIV-2026-0912',
      closingLine: '2027-01-27T11:00:00+02:00',
      contactLine: 'Contact Person: Mr Koena Rasebotsa · Tel: 015 295 1000',
      submitLine: 'Bids must be deposited into the bid box at the Polokwane Public Works offices.',
      method: 'PHYSICAL',
      destination: 'bid box at the Polokwane Public Works offices',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'csd',
        'sbd_forms',
        'experience',
        'key_personnel',
      ],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines([
            'tax_pin',
            'coida',
            'bbbee',
            'cipc',
            'csd',
            'sbd_forms',
            'experience',
            'key_personnel',
          ]),
        },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'civ-corp-table-018',
      sector: 'construction-civil',
      issuerType: 'corporate',
      tags: ['construction', 'corporate', 'table', 'boq'],
      issuer: 'TRANSNET SOC LIMITED',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Civil Works Framework for Rail Siding Maintenance',
      ref: 'TN-CIV-2026-0478',
      closingLine: '10 February 2027 at 12:00',
      contactLine: 'Contact Person: Transnet Procurement Desk · Tel: 011 308 3000',
      submitLine: 'Proposals must be uploaded to the Transnet e-procurement portal before closing.',
      method: 'ELECTRONIC',
      destination: 'Transnet e-procurement portal',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'sbd_forms',
        'experience',
        'financials',
        'bid_security',
      ],
      pricing: ['bill_of_quantities', 'pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'table',
          columnXs: [50, 220, 420],
          rows: [
            ['Returnable', 'Requirement', 'Mandatory'],
            ['Tax', 'A valid SARS Tax Clearance Certificate or TCS PIN must be submitted.', 'Yes'],
            ['COIDA', 'A valid COIDA Letter of Good Standing must be attached.', 'Yes'],
            ['B-BBEE', 'Bidders must submit a valid B-BBEE certificate or sworn affidavit.', 'Yes'],
            [
              'CIPC',
              'A certified copy of the CIPC company registration documents is required.',
              'Yes',
            ],
            [
              'Experience',
              'Bidders must demonstrate proven experience on similar projects.',
              'Yes',
            ],
            [
              'Financials',
              'Audited financial statements for the past three consecutive years are required.',
              'Yes',
            ],
            ['Security', 'A bid security guarantee of R 100 000 must accompany the bid.', 'Yes'],
          ],
        },
        { mode: 'native', layout: 'single', lines: pricingLines(['bill_of_quantities']) },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'civ-mun-ocr-019',
      sector: 'construction-civil',
      issuerType: 'municipal',
      tags: ['construction', 'municipal', 'ocr-variants', 'ligature-gap', 'nbsp', 'en-dash'],
      issuer: 'MATJHABENG LOCAL MUNICIPALITY',
      dept: 'TECHNICAL SERVICES',
      heading: 'INVITATION TO TENDER',
      title: 'Construction of Sanitation Infrastructure in Welkom',
      ref: 'MAT-CIV-2026-0533',
      closingLine: '26 January 2027 at 11:00',
      contactLine: 'Contact Person: Mr Piet Erasmus · Tel: 057 391 3000',
      submitLine:
        'Tenders must be deposited into the tender box at the Matjhabeng Civic Centre, Welkom.',
      method: 'PHYSICAL',
      destination: 'tender box at the Matjhabeng Civic Centre, Welkom',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'director_ids',
        'csd',
        'police_certification',
        'sbd_forms',
        'key_personnel',
        'financials',
        'subcontracting',
      ],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'coida', 'bbbee', 'cipc', 'director_ids', 'csd'], {
            // OCR punctuation variants: curly quotes and NBSP are parseable
            // (\s covers NBSP); the "Central Supplier Database" NBSP below
            // breaks a literal-space rule, and the phrasing gaps model OCR
            // wording drift the parser must still recall.
            bbbee:
              'Bidders must submit a valid Broad\u2013Based Black Economic Empowerment (B\u2013BBEE) certificate or sworn affidavit.',
            cipc: '\u201CA certified copy of the CIPC company registration documents is required,\u201D stated the notice.',
            director_ids:
              'Identity papers of all directors of the bidding entity must be attached.',
            csd: 'The Central\u00A0Supplier\u00A0Database supplier number must be provided.',
            coida:
              'A valid COIDA Letter\u00A0of\u00A0Good\u00A0Standing from the Compensation Fund must be attached.',
          }),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(
            ['police_certification', 'sbd_forms', 'key_personnel', 'financials', 'subcontracting'],
            {
              police_certification:
                'Every supporting document must be endorsed by a Commissioner of Oaths and dated within 90 days.',
              key_personnel:
                'Personnel r\u00e9sum\u00e9s and professional registrations must be submitted.',
              financials: 'Statements of audited accounts for the past three years are required.',
              subcontracting:
                'A minimum of 30% sub\u2013contracting to local enterprise development entities is required.',
            },
          ),
        },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'civ-gov-annex-020',
      sector: 'construction-civil',
      issuerType: 'government',
      tags: ['construction', 'government', 'annexures', 'forms', 'sbd'],
      issuer: 'DEPARTMENT OF HUMAN SETTLEMENTS',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'INVITATION TO TENDER',
      title: 'Construction of Low-Cost Housing Units in Mbombela',
      ref: 'DHS-CIV-2026-0621',
      closingLine: '02 February 2027 at 11:00',
      contactLine: 'Contact Person: Ms Nomvula Zulu · Tel: 013 766 5000',
      submitLine:
        'Tenders must be deposited into the bid box at the Riverside Government Complex, Mbombela.',
      method: 'PHYSICAL',
      destination: 'bid box at the Riverside Government Complex, Mbombela',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'director_ids',
        'csd',
        'sbd_forms',
        'signed_initialled',
        'declaration',
        'non_compliance',
        'pppfa',
      ],
      pricing: ['bill_of_quantities', 'pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'coida', 'bbbee', 'cipc', 'director_ids', 'csd']),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['sbd_forms', 'signed_initialled', 'declaration', 'non_compliance']),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: [
            'ANNEXURE A: RETURNABLE FORMS',
            'Completed and signed SBD 4 (Declaration of Interest) form is a mandatory disqualifying returnable.',
            'Duly signed SBD 6.1 preference points claim form in terms of the preferential procurement regulations.',
            'ANNEXURE B: PRICING SCHEDULE',
            'The priced bill of quantities must be completed and submitted as Annexure B.',
          ],
        },
      ],
      reqPage: 2,
    }),
  ]
}

/** Professional services issuers, RFQ pricing and annexures. */
function professionalFixtures() {
  return [
    fx({
      id: 'pro-gov-clean-021',
      sector: 'professional-services',
      issuerType: 'government',
      tags: ['professional-services', 'government', 'native', 'clean'],
      issuer: 'DEPARTMENT OF TRADE, INDUSTRY AND COMPETITION',
      dept: 'OFFICE OF THE DIRECTOR-GENERAL',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Provision of Management Consulting Services',
      ref: 'DTIC-PRO-2026-0143',
      closingLine: '11 December 2026 at 11:00',
      contactLine: 'Contact Person: Ms Thandi Nkosi · Tel: 012 394 1000',
      submitLine: 'Proposals must be deposited into the bid box at the dtic Campus, Pretoria.',
      method: 'PHYSICAL',
      destination: 'bid box at the dtic Campus, Pretoria',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'director_ids',
        'csd',
        'sbd_forms',
        'signed_initialled',
        'declaration',
        'experience',
        'key_personnel',
        'methodology',
        'financials',
        'pppfa',
      ],
      pricing: ['pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines([
            'tax_pin',
            'coida',
            'bbbee',
            'cipc',
            'director_ids',
            'csd',
            'sbd_forms',
            'signed_initialled',
            'declaration',
          ]),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['experience', 'key_personnel', 'methodology', 'financials', 'pppfa']),
        },
        { mode: 'native', layout: 'single', lines: pricingLines(['pricing_schedule']) },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'pro-mun-rfq-022',
      sector: 'professional-services',
      issuerType: 'municipal',
      tags: ['professional-services', 'municipal', 'rfq', 'pricing-schedule'],
      issuer: 'STELLENBOSCH MUNICIPALITY',
      dept: 'FINANCIAL SERVICES',
      heading: 'REQUEST FOR QUOTATION',
      title: 'Appointment of a Service Provider for Municipal Financial Audit Support',
      ref: 'STB-PRO-2026-0288',
      refLabel: 'Reference No',
      closingLine: '09 December 2026 at 12:00',
      contactLine: 'Contact Person: Mr Willem Botha · Tel: 021 808 8111',
      submitLine:
        'Quotations must be sent by email to scm@stellenbosch.gov.za before the closing time.',
      method: 'EMAIL',
      destination: 'scm@stellenbosch.gov.za',
      requirements: [
        'tax_pin',
        'bbbee',
        'csd',
        'sbd_forms',
        'experience',
        'key_personnel',
        'financials',
      ],
      pricing: ['pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'bbbee', 'csd', 'sbd_forms']),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['experience', 'key_personnel', 'financials']),
        },
        { mode: 'native', layout: 'single', lines: pricingLines(['pricing_schedule']) },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'pro-prov-two-col-023',
      sector: 'professional-services',
      issuerType: 'provincial-government',
      tags: ['professional-services', 'provincial', 'two-column'],
      issuer: 'WESTERN CAPE DEPARTMENT OF HEALTH AND WELLNESS',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Provision of Legal Advisory Services to District Hospitals',
      ref: 'WCGH-PRO-2026-0399',
      closingLine: '15 January 2027 at 11:00',
      contactLine: 'Contact Person: Ms Ayesha Harris · Tel: 021 483 4000',
      submitLine:
        'Proposals must be delivered to the bid box at the Bellville Health Park, Cape Town.',
      method: 'PHYSICAL',
      destination: 'bid box at the Bellville Health Park, Cape Town',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'csd',
        'sbd_forms',
        'experience',
        'key_personnel',
        'methodology',
        'financials',
        'non_compliance',
      ],
      body: [
        {
          mode: 'native',
          layout: 'two-column',
          left: [
            'MANDATORY COMPLIANCE',
            'A valid SARS Tax Clearance Certificate or TCS PIN must be',
            'submitted, failing which the bid will be disqualified.',
            'A valid COIDA Letter of Good Standing must be attached.',
            'Bidders must submit a valid B-BBEE certificate or sworn',
            'affidavit.',
            'A certified copy of the CIPC company registration documents',
            'is required.',
          ],
          right: [
            'FUNCTIONALITY',
            'Bidders must demonstrate proven experience on similar',
            'professional services projects.',
            'Curriculum vitae and professional registration of key',
            'personnel must be submitted.',
            'A comprehensive project implementation methodology and work',
            'programme must be provided.',
            'Audited financial statements for the past three years are',
            'required.',
          ],
        },
        { mode: 'native', layout: 'single', lines: reqLines(['csd', 'sbd_forms']) },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'pro-gov-scan-024',
      sector: 'professional-services',
      issuerType: 'government',
      tags: ['professional-services', 'government', 'scanned-only', 'ocr-required'],
      issuer: 'SOUTH AFRICAN REVENUE SERVICE',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Provision of Specialist Advisory Services (scanned)',
      ref: 'SARS-PRO-2026-0777',
      closingLine: '20 January 2027 at 11:00',
      method: 'PHYSICAL',
      destination: 'bid box at the SARS Head Office, Pretoria',
      pages: [{ mode: 'scan' }, { mode: 'scan' }],
      scannedOnly: true,
      pageNumbers: [1, 2],
    }),

    fx({
      id: 'pro-gov-mixed-025',
      sector: 'professional-services',
      issuerType: 'government',
      tags: ['professional-services', 'government', 'mixed', 'ocr-required'],
      issuer: 'DEPARTMENT OF ENVIRONMENTAL AFFAIRS',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Provision of Environmental Impact Assessment Services',
      ref: 'DEA-PRO-2026-0663',
      closingLine: '22 December 2026 at 11:00',
      contactLine: 'Contact Person: Mr Kagiso Sithole · Tel: 012 399 9000',
      submitLine:
        'Proposals must be deposited into the bid box at the Environment House, Pretoria.',
      method: 'PHYSICAL',
      destination: 'bid box at the Environment House, Pretoria',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'csd',
        'sbd_forms',
        'experience',
        'key_personnel',
        'methodology',
      ],
      body: [
        { mode: 'scan' },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines([
            'tax_pin',
            'coida',
            'bbbee',
            'csd',
            'sbd_forms',
            'experience',
            'key_personnel',
            'methodology',
          ]),
        },
        { mode: 'scan' },
      ],
      scannedPages: [2, 4],
      reqPage: 3,
    }),

    fx({
      id: 'pro-mun-conflict-026',
      sector: 'professional-services',
      issuerType: 'municipal',
      tags: ['professional-services', 'municipal', 'conflict', 'amended-deadline'],
      issuer: 'ETHEKWINI MUNICIPALITY',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Provision of Internal Audit Services to the Municipality',
      ref: 'ETH-PRO-2026-0512',
      closingLine: '14 December 2026 at 11:00',
      contactLine: 'Contact Person: Mr Rajen Naidoo · Tel: 031 311 1111',
      submitLine: 'Proposals must be deposited into the tender box at the Durban City Hall.',
      method: 'PHYSICAL',
      destination: 'tender box at the Durban City Hall',
      requirements: [
        'tax_pin',
        'bbbee',
        'cipc',
        'csd',
        'sbd_forms',
        'experience',
        'key_personnel',
        'financials',
      ],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines([
            'tax_pin',
            'bbbee',
            'cipc',
            'csd',
            'sbd_forms',
            'experience',
            'key_personnel',
            'financials',
          ]),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: [
            'ADDENDUM NO. 1',
            'The closing date is extended to 21 December 2026 at 11:00.',
            'All other terms and conditions remain unchanged.',
          ],
        },
      ],
      goldClosing: null,
      conflicts: { closingDateTime: true },
      unconfirmedFields: ['closingDateTime'],
      conflictSource: {
        closingDateTime: { page: 1, clauseContains: 'Closing Date: 14 December 2026 at 11:00' },
      },
    }),

    fx({
      id: 'pro-gov-tz-027',
      sector: 'professional-services',
      issuerType: 'government',
      tags: ['professional-services', 'government', 'timezone', 'rfc3339'],
      issuer: 'DEPARTMENT OF COMMUNICATIONS AND DIGITAL TECHNOLOGIES',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Provision of Digital Transformation Advisory Services',
      ref: 'DCDT-PRO-2026-0198',
      closingLine: '2026-12-18T11:00:00+02:00',
      contactLine: 'Contact Person: Ms Palesa Mokoena · Tel: 012 427 8000',
      submitLine:
        'Proposals must be deposited into the bid box at the iParioli Office Park, Pretoria.',
      method: 'PHYSICAL',
      destination: 'bid box at the iParioli Office Park, Pretoria',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'csd',
        'sbd_forms',
        'experience',
        'methodology',
        'financials',
      ],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines([
            'tax_pin',
            'coida',
            'bbbee',
            'cipc',
            'csd',
            'sbd_forms',
            'experience',
            'methodology',
            'financials',
          ]),
        },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'pro-corp-table-028',
      sector: 'professional-services',
      issuerType: 'corporate',
      tags: ['professional-services', 'corporate', 'table', 'pricing-schedule'],
      issuer: 'ESKOM HOLDINGS SOC LIMITED',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Provision of Engineering Consultancy Services',
      ref: 'ESKOM-PRO-2026-0955',
      closingLine: '08 January 2027 at 12:00',
      contactLine: 'Contact Person: Eskom Procurement Desk · Tel: 011 800 8111',
      submitLine: 'Proposals must be uploaded to the Eskom tender portal before closing.',
      method: 'ELECTRONIC',
      destination: 'Eskom tender portal',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'sbd_forms',
        'experience',
        'key_personnel',
        'financials',
        'turnover',
      ],
      pricing: ['pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'table',
          columnXs: [50, 220, 420],
          rows: [
            ['Returnable', 'Requirement', 'Mandatory'],
            ['Tax', 'A valid SARS Tax Clearance Certificate or TCS PIN must be submitted.', 'Yes'],
            ['COIDA', 'A valid COIDA Letter of Good Standing must be attached.', 'Yes'],
            ['B-BBEE', 'Bidders must submit a valid BBBEE certificate or sworn affidavit.', 'Yes'],
            [
              'CIPC',
              'A certified copy of the CIPC company registration documents is required.',
              'Yes',
            ],
            [
              'Experience',
              'Bidders must demonstrate proven experience on similar projects.',
              'Yes',
            ],
            [
              'Personnel',
              'Curriculum vitae and professional registration of key personnel must be submitted.',
              'Yes',
            ],
            [
              'Financials',
              'Audited financial statements for the past three consecutive years are required.',
              'Yes',
            ],
            [
              'Turnover',
              'A minimum annual turnover of R 10 million is required to qualify.',
              'Yes',
            ],
          ],
        },
        { mode: 'native', layout: 'single', lines: pricingLines(['pricing_schedule']) },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'pro-gov-ocr-029',
      sector: 'professional-services',
      issuerType: 'government',
      tags: ['professional-services', 'government', 'ocr-variants', 'curly-quotes', 'em-dash'],
      issuer: 'DEPARTMENT OF SOCIAL DEVELOPMENT',
      dept: 'SUPPLY CHAIN MANAGEMENT',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Provision of Social Work Support Services',
      ref: 'DSD-PRO-2026-0345',
      closingLine: '19 December 2026 at 11:00',
      contactLine: 'Contact Person: Ms Zanele Dube · Tel: 012 312 7500',
      submitLine: 'Proposals must be deposited into the bid box at the HSRC Building, Pretoria.',
      method: 'PHYSICAL',
      destination: 'bid box at the HSRC Building, Pretoria',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'csd',
        'sbd_forms',
        'experience',
        'key_personnel',
        'methodology',
        'non_compliance',
      ],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['tax_pin', 'coida', 'bbbee', 'cipc', 'csd', 'sbd_forms'], {
            bbbee:
              'Bidders must submit a valid \u201CBroad\u2013Based Black Economic Empowerment\u201D (BBBEE) certificate or sworn affidavit.',
            tax_pin:
              'A valid SARS Tax Clearance Certificate or TCS PIN must be submitted \u2014 failing which the bid will be disqualified.',
          }),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(['experience', 'key_personnel', 'methodology', 'non_compliance']),
        },
      ],
      reqPage: 2,
    }),

    fx({
      id: 'pro-mun-annex-030',
      sector: 'professional-services',
      issuerType: 'municipal',
      tags: ['professional-services', 'municipal', 'annexures', 'b-bbee-variants'],
      issuer: 'JOHANNESBURG METROPOLITAN MUNICIPALITY',
      dept: 'GROUP FINANCE',
      heading: 'REQUEST FOR PROPOSALS',
      title: 'Appointment of Transaction Advisors for Infrastructure Projects',
      ref: 'JHB-PRO-2026-0729',
      closingLine: '16 December 2026 at 11:00',
      contactLine: 'Contact Person: Mr Mandla Zwane · Tel: 011 407 7000',
      submitLine:
        'Proposals must be deposited into the tender box at the Metro Centre, Braamfontein.',
      method: 'PHYSICAL',
      destination: 'tender box at the Metro Centre, Braamfontein',
      requirements: [
        'tax_pin',
        'coida',
        'bbbee',
        'cipc',
        'director_ids',
        'csd',
        'sbd_forms',
        'signed_initialled',
        'declaration',
        'experience',
        'key_personnel',
        'financials',
        'pppfa',
        'subcontracting',
      ],
      pricing: ['pricing_schedule'],
      body: [
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines(
            [
              'tax_pin',
              'coida',
              'bbbee',
              'cipc',
              'director_ids',
              'csd',
              'sbd_forms',
              'signed_initialled',
            ],
            {
              bbbee:
                '\u201CBidders must submit a valid B BBEE certificate or sworn affidavit,\u201D the notice states.',
            },
          ),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: reqLines([
            'declaration',
            'experience',
            'key_personnel',
            'financials',
            'pppfa',
            'subcontracting',
          ]),
        },
        {
          mode: 'native',
          layout: 'single',
          lines: [
            'ANNEXURE C: DECLARATION AND PRICING',
            'A signed declaration of interest must be submitted with the bid documents.',
            'The pricing schedule must be completed in South African Rand and include VAT.',
          ],
        },
      ],
      reqPage: 2,
    }),
  ]
}

export const CORPUS = [...officeFixtures(), ...civilFixtures(), ...professionalFixtures()]

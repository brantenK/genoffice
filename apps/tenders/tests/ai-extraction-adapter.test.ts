// AI extraction — renderer integration guard (transport, adapter, opt-in).
//
// Three claims this file exists to keep true, all of them testable with no
// network and no Electron:
//
//  1. **The local engine is untouched.** The model call is injected
//     (`AiCompletion`), so the whole path — chunk, prompt, reply, validate,
//     merge, adapt, review — runs against a deterministic double. `fetch` is
//     stubbed and asserted to stay unused.
//  2. **Provenance is honest and the persisted shape is legal.** Everything a
//     model produced is written `suggestedBy: 'ai'`; nothing the core uses
//     internally (`provenance`, `score`, `field`, …) leaks into a
//     `ReviewCandidate` / `ExtractedRequirement`; and the resulting document is
//     put through the real schema rather than a hand-written key list.
//  3. **Nothing a model produces is ever a decision.** No code path here can
//     write `state: 'confirmed'`, and a human decision already made is never
//     overwritten.
//
// The allowed-key assertions read the schema's own key sets out of
// `shared/tenders-schema.ts` (they are private to it) for the same reason the
// readiness-weight guard parses `CHECK_WEIGHTS`: a guard with a copied list can
// be kept green by editing the guard and the schema together.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiSettings } from '@genoffice/ai-provider/browser'
import {
  buildExtractionChunks,
  runAiExtraction,
  type AiCompletion,
  type ExtractionChunking,
  type MergedExtraction,
} from '../src/shared/ai-extraction'
import { TENDER_RULES } from '../src/shared/rules'
import { TENDERS_SCHEMA_VERSION, validateTendersDataV2 } from '../src/shared/tenders-schema'
import type { AiStreamChunk, AiStreamRequest } from '../src/shared/ipc'
import type {
  CompanyProfile,
  IntakeVerification,
  PageExtractionState,
  RequirementRecord,
  TenderRecord,
  TendersDataV2,
  TendersWorkspaceV2,
} from '../src/shared/types'
import { AI_VISION_METHOD } from '../src/shared/types'
import {
  AI_EXTRACTION_RULES,
  AI_VALUE_PROVENANCE,
  adaptAiExtraction,
  buildExtractionRuleCatalogue,
  checkDuplicateReference,
  markModelReadPages,
  mergeAiIntoReview,
  toExtractedRequirement,
  toReviewCandidate,
} from '../src/renderer/src/ai/extract-with-ai'
import {
  AI_EXTRACTION_CANCELLED_MESSAGE,
  AI_EXTRACTION_EMPTY_REPLY_MESSAGE,
  AI_EXTRACTION_TRUNCATED_MESSAGE,
  createTendersCompletion,
  modelIsConfigured,
  readAiReadiness,
  tendersAiBridge,
  type TendersAiBridge,
} from '../src/renderer/src/ai/transport'
import { aiExtractionAvailability } from '../src/shared/ai-extraction'
import {
  AI_EXTRACTION_PREF_KEY,
  persistAiExtractionPreference,
  readAiExtractionPreference,
  type AiPreferenceStorage,
} from '../src/renderer/src/components/TenderList'

const AT = '2026-09-01T00:00:00.000Z'

/** A settings object with one usable provider, shaped like the shell's own. */
function settingsWith(provider: string, config: Record<string, string>): AiSettings {
  return { provider, providers: { [provider]: config } } as unknown as AiSettings
}

const SETTINGS = settingsWith('anthropic', { apiKey: 'sk-test', model: 'claude-test' })

// ── the schema's own key sets ─────────────────────────────────────────────────

/** Locate `src/shared/tenders-schema.ts` from either cwd (`-w` or repo root). */
function resolveSchemaPath(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of [
      join(dir, 'src', 'shared', 'tenders-schema.ts'),
      join(dir, 'apps', 'tenders', 'src', 'shared', 'tenders-schema.ts'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
    dir = dirname(dir)
  }
  throw new Error(`Could not locate src/shared/tenders-schema.ts from ${process.cwd()}`)
}

const SCHEMA_SOURCE = readFileSync(resolveSchemaPath(), 'utf8')

/** One `const NAME = new Set([...])` key set, read from the schema itself. */
function schemaKeySet(name: string): Set<string> {
  const start = SCHEMA_SOURCE.indexOf(`const ${name} = new Set([`)
  if (start < 0) throw new Error(`tenders-schema.ts no longer declares ${name}`)
  const open = SCHEMA_SOURCE.indexOf('[', start)
  const body = SCHEMA_SOURCE.slice(open + 1, SCHEMA_SOURCE.indexOf(']', open))
  const keys = new Set<string>()
  for (const [, key] of body.matchAll(/'([A-Za-z0-9_]+)'/g)) keys.add(key)
  if (keys.size === 0) throw new Error(`${name} parsed empty — the guard would check nothing`)
  return keys
}

const REQUIREMENT_KEYS = schemaKeySet('REQUIREMENT')
const REVIEW_CANDIDATE_KEYS = schemaKeySet('REVIEW_CANDIDATE')

function expectOnlyAllowedKeys(value: object, allowed: Set<string>, what: string): void {
  for (const key of Object.keys(value)) {
    expect(allowed.has(key), `${what} carries the key "${key}", which the schema rejects`).toBe(
      true,
    )
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const PAGE_TEXT_1 =
  'REQUEST FOR PROPOSALS\nReference Number: ICT/2026/042\nA valid SARS Tax Clearance must be submitted.'
const PAGE_TEXT_2 = 'A COIDA letter of good standing is required for all bidders.'

function chunking(): ExtractionChunking {
  return buildExtractionChunks({
    pages: [
      { pageNumber: 1, text: PAGE_TEXT_1 },
      { pageNumber: 2, text: PAGE_TEXT_2 },
    ],
    numPages: 2,
  })
}

const MODEL_REPLY = JSON.stringify({
  metadata: [
    {
      field: 'title',
      value: 'Supply and Delivery of Laptops',
      pageNumber: 1,
      sourceClause: 'REQUEST FOR PROPOSALS',
      confidence: 0.9,
    },
    {
      field: 'referenceNumber',
      value: 'ICT/2026/042',
      pageNumber: 1,
      sourceClause: 'Reference Number: ICT/2026/042',
      confidence: 0.8,
    },
  ],
  requirements: [
    {
      ruleKey: 'tax_pin',
      title: 'Tax clearance',
      verbatimClause: 'A valid SARS Tax Clearance must be submitted.',
      pageNumber: 1,
      boundingBox: { top: 0.1, left: 0.1, width: 0.5, height: 0.05 },
      confidence: 0.7,
    },
    {
      ruleKey: 'coida',
      title: 'COIDA letter',
      verbatimClause: 'A COIDA letter of good standing is required for all bidders.',
      pageNumber: 2,
      boundingBox: { top: 0.2, left: 0.1, width: 0.5, height: 0.05 },
      confidence: 0.6,
    },
  ],
  warnings: ['the page-2 header was unclear'],
})

/** A model double: one reply per chunk, with no network anywhere near it. */
function replyCompletion(reply: string | ((user: string) => string)): AiCompletion & {
  calls: Array<{ system: string; user: string }>
} {
  const calls: Array<{ system: string; user: string }> = []
  const completion: AiCompletion = async ({ system, user }) => {
    calls.push({ system, user })
    return typeof reply === 'function' ? reply(user) : reply
  }
  return Object.assign(completion, { calls })
}

async function mergedFrom(
  completion: AiCompletion,
  chunks: ExtractionChunking = chunking(),
): Promise<MergedExtraction> {
  const run = await runAiExtraction({
    completion,
    chunking: chunks,
    context: { rules: AI_EXTRACTION_RULES, numPages: 2 },
    fileName: 'rfp.pdf',
    tenderTitle: 'RFP',
  })
  return run.merged
}

/** One page per chunk, so a failure on one page cannot hide behind another. */
function perPageChunking(): ExtractionChunking {
  return buildExtractionChunks({
    pages: [
      { pageNumber: 1, text: PAGE_TEXT_1 },
      { pageNumber: 2, text: PAGE_TEXT_2 },
    ],
    numPages: 2,
    maxChars: PAGE_TEXT_1.length,
  })
}

function emptyReview(): IntakeVerification {
  return {
    fields: {},
    requirements: {},
    pages: [],
    contactEmail: null,
    conflicts: [],
    createdAt: AT,
    updatedAt: AT,
  }
}

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

function requirementRecord(overrides: Partial<RequirementRecord> = {}): RequirementRecord {
  return {
    id: 'req-tax_pin',
    ruleKey: 'tax_pin',
    title: 'Valid SARS Tax Clearance / TCS PIN',
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    verbatimClause: 'A valid SARS Tax Clearance must be submitted.',
    pageNumber: 1,
    boundingBox: { top: 0.1, left: 0.1, width: 0.5, height: 0.05 },
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 10,
    status: 'OUTSTANDING',
    linkedVaultDocId: null,
    reason: null,
    suggestedVaultDocIds: [],
    ...overrides,
  }
}

function tenderRecord(overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: 'tender-1',
    title: 'Supply and Delivery of Laptops',
    referenceNumber: 'ICT/2026/042',
    issuingBody: 'Provincial Administration Office',
    closingDate: '2026-12-18',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: null,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: AT,
    fileName: 'rfp.pdf',
    fileUrl: 'documents/rfp.pdf',
    numPages: 2,
    ocrPages: 0,
    requirements: [],
    ...overrides,
  }
}

function documentV2(tenders: TenderRecord[]): TendersDataV2 {
  const workspace: TendersWorkspaceV2 = {
    id: 'ws-1',
    name: 'Test Co',
    dataOrigin: 'user',
    company: company(),
    customers: [],
    vault: [],
    tenders,
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

// ── provenance ────────────────────────────────────────────────────────────────

describe('AI extraction adapter — provenance', () => {
  it('translates the core’s ai-suggested provenance into the schema’s ai', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const adaptation = adaptAiExtraction({ merged })
    const candidate = adaptation.candidates.title?.[0]
    expect(candidate).toBeDefined()
    expect(candidate!.suggestedBy).toBe(AI_VALUE_PROVENANCE)
    expect(AI_VALUE_PROVENANCE).toBe('ai')
    expect(adaptation.requirements[0]!.suggestedBy).toBe('ai')
  })

  it('never emits an absent or unknown provenance on anything a model produced', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const adaptation = adaptAiExtraction({ merged })
    const produced = [...Object.values(adaptation.candidates).flat(), ...adaptation.requirements]
    expect(produced.length).toBeGreaterThan(0)
    for (const item of produced) {
      expect(item.suggestedBy, 'a model-produced value must say who produced it').toBe('ai')
    }
  })

  it('keeps the parser’s own value and provenance when both read the same field', () => {
    // The parser read the reference number; the model suggests the same one. The
    // review must keep the parser’s entry, not relabel it as a suggestion.
    const review: IntakeVerification = {
      ...emptyReview(),
      fields: {
        referenceNumber: {
          extractedValue: 'ICT/2026/042',
          sourcePage: 1,
          sourceClause: 'Reference Number: ICT/2026/042',
          confidence: 0.8,
          candidates: [
            {
              value: 'ICT/2026/042',
              sourcePage: 1,
              sourceClause: 'Reference Number: ICT/2026/042',
              score: 1,
            },
          ],
          state: 'unconfirmed',
          reviewedAt: null,
        },
      },
    }
    const mergedReview = mergeAiIntoReview(
      review,
      {
        candidates: {
          referenceNumber: [
            toReviewCandidate({
              value: 'ICT/2026/042',
              pageNumber: 1,
              sourceClause: 'Reference Number: ICT/2026/042',
              score: 0.8,
            }),
          ],
        },
        requirements: [],
        skippedRuleKeys: [],
        rejections: [],
        warnings: [],
        unreadPages: [],
        duplicateReference: null,
        summary: '',
      },
      AT,
    )
    const field = mergedReview.fields.referenceNumber!
    expect(field.extractedValue).toBe('ICT/2026/042')
    expect(field.candidates).toHaveLength(1)
    expect(field.candidates[0]!.suggestedBy, 'the parser’s own read must stay unmarked').toBe(
      undefined,
    )
  })
})

// ── the persisted shape ───────────────────────────────────────────────────────

describe('AI extraction adapter — the persisted shape', () => {
  it('emits only keys the schema allows, on candidates and requirements', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const adaptation = adaptAiExtraction({ merged })
    const candidates = Object.values(adaptation.candidates).flat()
    expect(candidates.length).toBeGreaterThan(0)
    expect(adaptation.requirements.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      expectOnlyAllowedKeys(candidate, REVIEW_CANDIDATE_KEYS, 'a review candidate')
    }
    for (const requirement of adaptation.requirements) {
      expectOnlyAllowedKeys(requirement, REQUIREMENT_KEYS, 'an extracted requirement')
    }
    // The core's internal vocabulary must not survive the translation.
    for (const candidate of candidates) {
      expect(candidate).not.toHaveProperty('provenance')
      expect(candidate).not.toHaveProperty('field')
      expect(candidate).not.toHaveProperty('pageNumber')
      expect(candidate).not.toHaveProperty('confidence')
    }
    for (const requirement of adaptation.requirements) {
      expect(requirement).not.toHaveProperty('provenance')
    }
    // The schema really does reject those keys, so this is not a formality.
    expect(REQUIREMENT_KEYS.has('provenance')).toBe(false)
    expect(REVIEW_CANDIDATE_KEYS.has('field')).toBe(false)
  })

  it('produces a document the real schema accepts', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const adaptation = adaptAiExtraction({ merged, existingRuleKeys: ['tax_pin'] })
    const review = mergeAiIntoReview(emptyReview(), adaptation, AT)
    const requirements: RequirementRecord[] = [
      requirementRecord(),
      ...adaptation.requirements.map((requirement) => ({
        ...requirement,
        status: 'OUTSTANDING' as const,
        linkedVaultDocId: null,
        reason: null,
        suggestedVaultDocIds: [],
      })),
    ]
    const result = validateTendersDataV2(
      documentV2([
        tenderRecord({
          requirements,
          intakeVerification: review,
          referenceNumber: null,
        }),
      ]),
    )
    expect(result.ok ? [] : result.issues).toEqual([])
  })
})

// ── the rule catalogue ────────────────────────────────────────────────────────

describe('AI extraction adapter — the rule catalogue', () => {
  it('mirrors the local catalogue field by field', () => {
    expect(AI_EXTRACTION_RULES).toHaveLength(TENDER_RULES.length)
    expect(AI_EXTRACTION_RULES.map((rule) => rule.ruleKey)).toEqual(
      TENDER_RULES.map((rule) => rule.key),
    )
    for (const rule of TENDER_RULES) {
      const projected = AI_EXTRACTION_RULES.find((entry) => entry.ruleKey === rule.key)!
      expect(projected.title).toBe(rule.title)
      expect(projected.category).toBe(rule.category)
      expect(projected.riskLevel).toBe(rule.riskLevel)
      expect(projected.order).toBe(rule.order)
      expect(projected.isMandatory).toBe(
        rule.category === 'MANDATORY_STAGE_1' || rule.riskLevel === 'CRITICAL_DISQUALIFIER',
      )
    }
  })

  it('keeps the catalogue authoritative over the model', async () => {
    // A hostile reply claiming a general returnable is mandatory and not risky.
    const merged = await mergedFrom(
      replyCompletion(
        JSON.stringify({
          requirements: [
            {
              ruleKey: 'joint_venture',
              title: 'Joint venture agreement',
              category: 'MANDATORY_STAGE_1',
              isMandatory: true,
              riskLevel: 'CRITICAL_DISQUALIFIER',
              verbatimClause: 'A joint venture agreement must be attached.',
              pageNumber: 1,
              boundingBox: { top: 0, left: 0, width: 0, height: 0 },
              confidence: 0.9,
            },
          ],
        }),
      ),
    )
    const requirement = adaptAiExtraction({ merged }).requirements[0]!
    const rule = TENDER_RULES.find((entry) => entry.key === 'joint_venture')!
    expect(requirement.category).toBe(rule.category)
    expect(requirement.riskLevel).toBe(rule.riskLevel)
    expect(requirement.isMandatory).toBe(false)
    expect(requirement.order).toBe(rule.order)
  })

  it('builds the catalogue from any catalogue it is given', () => {
    const projected = buildExtractionRuleCatalogue([
      {
        key: 'only_rule',
        title: 'Only rule',
        category: 'GENERAL_RETURNABLE',
        riskLevel: 'INFORMATIONAL',
        evidenceKind: 'NONE',
        validityKind: 'NONE',
        order: 7,
        patterns: [],
        vaultHints: { keywords: [] },
      },
    ])
    expect(projected).toEqual([
      {
        ruleKey: 'only_rule',
        title: 'Only rule',
        category: 'GENERAL_RETURNABLE',
        isMandatory: false,
        riskLevel: 'INFORMATIONAL',
        order: 7,
      },
    ])
  })
})

// ── the duplicate reference number ────────────────────────────────────────────

describe('AI extraction adapter — duplicate reference numbers', () => {
  const existing = [tenderRecord({ id: 'tender-1', title: 'Earlier import' })]

  it('reports a colliding reference number in plain language', () => {
    const check = checkDuplicateReference('ICT/2026/042', existing, { excludeTenderId: 'tender-2' })
    expect(check.value).toBe('ICT/2026/042')
    expect(check.tenderTitles).toEqual(['Earlier import'])
    expect(check.message).toMatch(/already on tender “Earlier import”/)
    expect(check.message).toMatch(/cannot share a reference number/)
    expect(check.message).toMatch(/confirm the right reference there, or remove the earlier import/)
  })

  it('does not fire on the tender’s own reference or on a case-different value', () => {
    expect(
      checkDuplicateReference('ICT/2026/042', existing, { excludeTenderId: 'tender-1' }).message,
    ).toBeNull()
    expect(checkDuplicateReference('ict/2026/042', existing).message).toBeNull()
    expect(checkDuplicateReference(null, existing).message).toBeNull()
    expect(checkDuplicateReference('   ', existing).message).toBeNull()
    expect(checkDuplicateReference('ICT/2026/042', []).message).toBeNull()
  })

  it('the collision it reports is the one the schema actually rejects', () => {
    const shared = 'ICT/2026/042'
    const rejected = validateTendersDataV2(
      documentV2([
        tenderRecord({ id: 'tender-1', referenceNumber: shared }),
        tenderRecord({ id: 'tender-2', referenceNumber: shared }),
      ]),
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.issues.map((issue) => issue.path)).toContain(
        'workspaces.0.tenders.1.referenceNumber',
      )
    }
    // The same two tenders validate once the colliding reference is not written.
    const accepted = validateTendersDataV2(
      documentV2([
        tenderRecord({ id: 'tender-1', referenceNumber: shared }),
        tenderRecord({ id: 'tender-2', referenceNumber: null }),
      ]),
    )
    expect(accepted.ok).toBe(true)
  })

  it('surfaces the model’s reference number when it collides with another tender', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const adaptation = adaptAiExtraction({
      merged,
      existingTenders: [tenderRecord({ id: 'tender-1', title: 'Earlier import' })],
      tenderId: 'tender-2',
    })
    expect(adaptation.duplicateReference?.value).toBe('ICT/2026/042')
    expect(adaptation.duplicateReference?.message).toMatch(/Earlier import/)
    // …and the same run is clean when the colliding tender is the one being read.
    const selfOnly = adaptAiExtraction({
      merged,
      existingTenders: [tenderRecord({ id: 'tender-2', title: 'This tender' })],
      tenderId: 'tender-2',
    })
    expect(selfOnly.duplicateReference).toBeNull()
  })
})

// ── merging into the review ───────────────────────────────────────────────────

describe('AI extraction adapter — merging into the review', () => {
  it('fills an empty field from the model as unconfirmed, marked ai', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const adaptation = adaptAiExtraction({ merged })
    const review = mergeAiIntoReview(emptyReview(), adaptation, AT)
    expect(review.fields.title).toMatchObject({
      extractedValue: 'Supply and Delivery of Laptops',
      sourcePage: 1,
      state: 'unconfirmed',
      reviewedAt: null,
      suggestedBy: 'ai',
    })
    expect(review.fields.title!.confidence).toBeCloseTo(0.9)
    expect(review.updatedAt).toBe(AT)
  })

  it('adds the model’s value as a candidate beside the parser’s', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const adaptation = adaptAiExtraction({ merged })
    const review: IntakeVerification = {
      ...emptyReview(),
      fields: {
        title: {
          extractedValue: 'RFP from the parser',
          sourcePage: 1,
          sourceClause: 'REQUEST FOR PROPOSALS',
          confidence: 0.5,
          candidates: [
            {
              value: 'RFP from the parser',
              sourcePage: 1,
              sourceClause: 'REQUEST FOR PROPOSALS',
              score: 0.4,
            },
          ],
          state: 'unconfirmed',
          reviewedAt: null,
        },
      },
    }
    const field = mergeAiIntoReview(review, adaptation, AT).fields.title!
    expect(field.extractedValue, 'the parser’s value is not replaced').toBe('RFP from the parser')
    expect(field.suggestedBy, 'the field still belongs to the parser').toBeUndefined()
    expect(field.candidates.map((candidate) => candidate.value)).toEqual([
      'Supply and Delivery of Laptops',
      'RFP from the parser',
    ])
    expect(field.candidates[0]!.suggestedBy).toBe('ai')
    expect(field.candidates[1]!.suggestedBy).toBeUndefined()
  })

  it('never touches a field a human has already decided', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const adaptation = adaptAiExtraction({ merged })
    const review: IntakeVerification = {
      ...emptyReview(),
      fields: {
        title: {
          extractedValue: null,
          sourcePage: null,
          sourceClause: null,
          confidence: null,
          candidates: [],
          state: 'not_stated',
          reviewedAt: AT,
        },
      },
    }
    const field = mergeAiIntoReview(review, adaptation, AT).fields.title!
    expect(field.state).toBe('not_stated')
    expect(field.reviewedAt).toBe(AT)
    expect(
      field.extractedValue,
      'a decided field is not filled in behind the user’s back',
    ).toBeNull()
    expect(field.candidates).toHaveLength(1)
  })

  it('registers new requirements as unreviewed and caps the candidate list', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const adaptation = adaptAiExtraction({ merged, existingRuleKeys: ['tax_pin'] })
    expect(adaptation.requirements.map((requirement) => requirement.ruleKey)).toEqual(['coida'])
    expect(adaptation.skippedRuleKeys).toEqual(['tax_pin'])
    const review = mergeAiIntoReview(emptyReview(), adaptation, AT)
    expect(review.requirements['ai-req-coida']).toMatchObject({ state: 'unreviewed' })
    expect(Object.keys(review.requirements)).toHaveLength(1)

    // 40 suggestions for one field collapse to the schema's per-field ceiling.
    const many = Array.from({ length: 40 }, (_, index) =>
      toReviewCandidate({
        value: `candidate-${index}`,
        pageNumber: 1,
        sourceClause: null,
        score: 0.5,
      }),
    )
    const capped = mergeAiIntoReview(
      emptyReview(),
      {
        ...adaptation,
        candidates: { title: many },
      },
      AT,
    )
    expect(capped.fields.title!.candidates).toHaveLength(16)
    expect(
      validateTendersDataV2(
        documentV2([
          tenderRecord({ intakeVerification: capped, requirements: [requirementRecord()] }),
        ]),
      ).ok,
    ).toBe(true)
  })

  it('never produces a confirmed field, whatever the model says', async () => {
    // A reply that tries to assert a decision, plus a review that already carries
    // one: neither can turn a suggestion into a decision.
    const merged = await mergedFrom(
      replyCompletion(
        JSON.stringify({
          metadata: [
            { field: 'title', value: 'Asserted title', pageNumber: 1, confidence: 1 },
            { field: 'issuingBody', value: 'Asserted body', pageNumber: 1, confidence: 1 },
          ],
        }),
      ),
    )
    const adaptation = adaptAiExtraction({ merged })
    const review = mergeAiIntoReview(emptyReview(), adaptation, AT)
    for (const field of Object.values(review.fields)) {
      expect(field.state).toBe('unconfirmed')
    }
    expect(review.fields.issuingBody!.suggestedBy).toBe('ai')
  })
})

// ── the whole path, with an injected model call ───────────────────────────────

describe('AI extraction path with an injected model call (no network)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drives chunk → prompt → reply → validate → merge → review with no network', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const completion = replyCompletion(MODEL_REPLY)

    const merged = await mergedFrom(completion)

    // One call per chunk, each carrying the strict-JSON contract and the catalogue.
    expect(completion.calls).toHaveLength(chunking().chunks.length)
    expect(completion.calls[0]!.system).toMatch(/ONE strict JSON object/)
    expect(completion.calls[0]!.user).toMatch(/--- PAGE 1 ---/)
    expect(merged.provenance).toBe('ai-suggested')
    expect(merged.reviewState).toBe('unconfirmed')
    expect(merged.unreadPages).toEqual([])

    const adaptation = adaptAiExtraction({ merged })
    const review = mergeAiIntoReview(emptyReview(), adaptation, AT)
    expect(review.fields.referenceNumber!.extractedValue).toBe('ICT/2026/042')
    expect(review.requirements['ai-req-tax_pin']).toBeDefined()
    expect(review.requirements['ai-req-coida']).toBeDefined()
    expect(
      fetchSpy,
      'the model call is injected; nothing here may reach the network',
    ).not.toHaveBeenCalled()
  })

  it('degrades to the local result when the model call throws', async () => {
    const merged = await mergedFrom(async () => {
      throw new Error('no API key configured')
    })
    expect(merged.metadata).toEqual([])
    expect(merged.requirements).toEqual([])
    expect(
      merged.warnings.some((warning) => /no API key configured/.test(warning)),
      'the reason must be surfaced, not swallowed',
    ).toBe(true)
    const adaptation = adaptAiExtraction({ merged, existingRuleKeys: ['tax_pin', 'coida'] })
    expect(adaptation.requirements).toEqual([])
    // The local rows are untouched: the adapter only ever adds.
    expect(adaptation.skippedRuleKeys).toEqual([])
    expect(adaptation.summary).toMatch(/read 0 of 2 pages/)
    expect(adaptation.summary).toMatch(/0 requirements/)
  })

  it('keeps every other chunk’s output when one chunk fails', async () => {
    let call = 0
    const merged = await mergedFrom(async () => {
      call += 1
      if (call === 1) throw new Error('chunk one timed out')
      return MODEL_REPLY
    }, perPageChunking())
    expect(merged.warnings.some((warning) => /chunk one timed out/.test(warning))).toBe(true)
    expect(merged.pagesRead.map((page) => page.pageNumber)).toEqual([2])
    expect(merged.unreadPages, 'a page no reader obtained must keep blocking readiness').toEqual([
      1,
    ])
  })

  it('stops sending chunks once the run is cancelled', async () => {
    const controller = new AbortController()
    const seen: number[] = []
    const run = await runAiExtraction({
      completion: async ({ user }) => {
        seen.push(seen.length + 1)
        controller.abort()
        return MODEL_REPLY
      },
      chunking: buildExtractionChunks({
        pages: [
          { pageNumber: 1, text: PAGE_TEXT_1 },
          { pageNumber: 2, text: PAGE_TEXT_2 },
        ],
        numPages: 2,
        // One page per chunk, so the abort lands between two sends.
        maxChars: PAGE_TEXT_1.length,
      }),
      context: { rules: AI_EXTRACTION_RULES, numPages: 2 },
      signal: controller.signal,
    })
    expect(seen, 'the second chunk is never sent').toHaveLength(1)
    expect(run.outcomes[1]!.error).toMatch(/cancelled/)
    expect(run.merged.unreadPages).toEqual([2])
  })
})

// ── the transport ─────────────────────────────────────────────────────────────

interface BridgeHarness extends TendersAiBridge {
  requests: AiStreamRequest[]
  cancels: string[]
  listeners(): number
  emits: AiStreamChunk[]
  emit(chunk: AiStreamChunk): void
}

/** A bridge double: no Electron, no network, fully deterministic. */
function makeBridge(
  options: {
    settings?: AiSettings
    onStart?: (request: AiStreamRequest) => void
    startThrows?: Error
    startRejects?: Error
    settingsError?: Error
  } = {},
): BridgeHarness {
  const handlers = new Set<(chunk: AiStreamChunk) => void>()
  const harness: BridgeHarness = {
    requests: [],
    cancels: [],
    emits: [],
    listeners: () => handlers.size,
    emit(chunk) {
      harness.emits.push(chunk)
      for (const handler of [...handlers]) handler(chunk)
    },
    getAiSettings: async () => {
      if (options.settingsError) throw options.settingsError
      return options.settings ?? SETTINGS
    },
    aiStream(request) {
      harness.requests.push(request)
      if (options.startThrows) throw options.startThrows
      if (options.startRejects) return Promise.reject(options.startRejects)
      options.onStart?.(request)
      return undefined
    },
    aiStreamCancel(requestId) {
      harness.cancels.push(requestId)
    },
    onAiStream(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }
  return harness
}

describe('the AI transport', () => {
  it('accumulates only its own requestId and resolves with the whole reply', async () => {
    const bridge = makeBridge()
    const progress: number[] = []
    const completion = createTendersCompletion({
      bridge,
      settings: SETTINGS,
      newRequestId: () => 'req-1',
      onProgress: (info) => progress.push(info.chars),
    })
    const promise = completion({ system: 's', user: 'u' })
    // The listener is subscribed before the request is sent, so nothing is missed.
    expect(bridge.requests).toHaveLength(1)
    expect(bridge.listeners()).toBe(1)
    bridge.emit({ requestId: 'someone-else', type: 'delta', text: 'ignored' })
    bridge.emit({ requestId: 'req-1', type: 'delta', text: '{"a":' })
    bridge.emit({ requestId: 'req-1', type: 'reasoning', text: 'thinking' })
    bridge.emit({ requestId: 'req-1', type: 'ping' })
    bridge.emit({ requestId: 'req-1', type: 'delta', text: '1}' })
    bridge.emit({ requestId: 'req-1', type: 'done' })
    await expect(promise).resolves.toBe('{"a":1}')
    expect(progress).toEqual([5, 7])
    expect(bridge.listeners(), 'the listener is released when the call settles').toBe(0)
    expect(bridge.cancels).toEqual([])
  })

  it('sends the settings it was given, with no tools', async () => {
    const bridge = makeBridge()
    const completion = createTendersCompletion({
      bridge,
      settings: SETTINGS,
      newRequestId: () => 'req-2',
    })
    const promise = completion({ system: 'sys', user: 'usr' })
    expect(bridge.requests[0]).toEqual({
      requestId: 'req-2',
      settings: SETTINGS,
      system: 'sys',
      messages: [{ role: 'user', text: 'usr' }],
      tools: [],
    })
    bridge.emit({ requestId: 'req-2', type: 'done' })
    await expect(promise).rejects.toThrow(AI_EXTRACTION_EMPTY_REPLY_MESSAGE)
  })

  it('puts the images it is given on the user message, and no key at all without them', async () => {
    // The wire shape the provider protocols map: `AgentImage` on the user
    // message, which is what the vision pass needs and what it used to have to
    // decorate the bridge to reach.
    const image = { base64: 'cGFnZS0y', mime: 'image/jpeg' }
    const bridge = makeBridge()
    const promise = createTendersCompletion({
      bridge,
      settings: SETTINGS,
      newRequestId: () => 'req-img',
    })({ system: 'sys', user: 'usr', images: [image] })
    expect(bridge.requests[0]?.messages).toEqual([{ role: 'user', text: 'usr', images: [image] }])
    bridge.emit({ requestId: 'req-img', type: 'delta', text: 'page text' })
    bridge.emit({ requestId: 'req-img', type: 'done' })
    await expect(promise).resolves.toBe('page text')

    // No images (and an empty list) is the plain text request, byte for byte:
    // the `images` key is absent rather than an empty array.
    for (const images of [undefined, [] as { base64: string; mime: string }[]]) {
      const plain = makeBridge()
      const textOnly = createTendersCompletion({
        bridge: plain,
        settings: SETTINGS,
        newRequestId: () => 'req-txt',
      })({ system: 'sys', user: 'usr', ...(images ? { images } : {}) })
      expect(plain.requests[0]?.messages).toEqual([{ role: 'user', text: 'usr' }])
      expect('images' in (plain.requests[0]?.messages[0] ?? {})).toBe(false)
      plain.emit({ requestId: 'req-txt', type: 'done' })
      await expect(textOnly).rejects.toThrow(AI_EXTRACTION_EMPTY_REPLY_MESSAGE)
    }
  })

  it('releases its listener on every settle path', async () => {
    const cases: Array<(bridge: BridgeHarness) => void> = [
      (bridge) => bridge.emit({ requestId: 'req', type: 'error', error: 'Rate limited' }),
      (bridge) => bridge.emit({ requestId: 'req', type: 'done' }),
      (bridge) => bridge.emit({ requestId: 'req', type: 'done', stopReason: 'max_tokens' }),
    ]
    for (const settle of cases) {
      const bridge = makeBridge()
      const completion = createTendersCompletion({
        bridge,
        settings: SETTINGS,
        newRequestId: () => 'req',
      })
      const promise = completion({ system: 's', user: 'u' })
      settle(bridge)
      await expect(promise).rejects.toThrow()
      expect(bridge.listeners()).toBe(0)
    }
  })

  it('reports an error chunk, an empty reply and a truncated reply as failures', async () => {
    const failing = async (chunk: AiStreamChunk, expected: string | RegExp): Promise<void> => {
      const bridge = makeBridge()
      const completion = createTendersCompletion({
        bridge,
        settings: SETTINGS,
        newRequestId: () => 'req',
      })
      const promise = completion({ system: 's', user: 'u' })
      bridge.emit(chunk)
      await expect(promise).rejects.toThrow(expected)
    }
    await failing({ requestId: 'req', type: 'error', error: 'Rate limited' }, 'Rate limited')
    await failing({ requestId: 'req', type: 'error' }, /failed/)
    await failing({ requestId: 'req', type: 'done' }, AI_EXTRACTION_EMPTY_REPLY_MESSAGE)
    await failing(
      { requestId: 'req', type: 'done', stopReason: 'max_tokens' },
      AI_EXTRACTION_TRUNCATED_MESSAGE,
    )
  })

  it('stops a reply that runs away, and cancels it in main', async () => {
    const bridge = makeBridge()
    const completion = createTendersCompletion({
      bridge,
      settings: SETTINGS,
      newRequestId: () => 'req',
      maxChars: 4,
    })
    const promise = completion({ system: 's', user: 'u' })
    bridge.emit({ requestId: 'req', type: 'delta', text: '12345' })
    await expect(promise).rejects.toThrow(/passed 4 characters/)
    expect(bridge.cancels).toEqual(['req'])
    expect(bridge.listeners()).toBe(0)
  })

  it('cancels the request in main and rejects when the signal aborts', async () => {
    const bridge = makeBridge()
    const controller = new AbortController()
    const completion = createTendersCompletion({
      bridge,
      settings: SETTINGS,
      newRequestId: () => 'req-3',
    })
    const promise = completion({ system: 's', user: 'u', signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toThrow(AI_EXTRACTION_CANCELLED_MESSAGE)
    expect(bridge.cancels).toEqual(['req-3'])
    expect(bridge.listeners()).toBe(0)
    // An already-aborted signal never reaches main at all.
    const aborted = new AbortController()
    aborted.abort()
    const bridge2 = makeBridge()
    const completion2 = createTendersCompletion({ bridge: bridge2, settings: SETTINGS })
    await expect(completion2({ system: 's', user: 'u', signal: aborted.signal })).rejects.toThrow(
      AI_EXTRACTION_CANCELLED_MESSAGE,
    )
    expect(bridge2.requests).toEqual([])
  })

  it('fails the chunk when the bridge cannot start the stream', async () => {
    const throwing = makeBridge({ startThrows: new Error('no handler registered') })
    await expect(
      createTendersCompletion({ bridge: throwing, settings: SETTINGS })({
        system: 's',
        user: 'u',
      }),
    ).rejects.toThrow('no handler registered')
    expect(throwing.listeners()).toBe(0)

    const rejecting = makeBridge({ startRejects: new Error('window closed') })
    await expect(
      createTendersCompletion({ bridge: rejecting, settings: SETTINGS })({
        system: 's',
        user: 'u',
      }),
    ).rejects.toThrow('window closed')
    expect(rejecting.listeners()).toBe(0)
  })
})

// ── readiness, the bridge and the opt-in preference ───────────────────────────

describe('AI readiness and the opt-in preference', () => {
  afterEach(() => {
    delete (window as { tendersApi?: unknown }).tendersApi
  })

  it('is not offered without a usable model, and says what is actually missing', async () => {
    const unconfigured = makeBridge({
      settings: settingsWith('anthropic', { apiKey: '', model: 'claude-test' }),
    })
    const readiness = await readAiReadiness(unconfigured)
    expect(readiness.ready).toBe(false)
    if (!readiness.ready) {
      expect(readiness.code).toBe('model-not-configured')
      // The shared helper's own message for this reason, not a generic hint
      // restated here: the model IS set, the key is what is missing, and a hint
      // that says "configure a model" would name the wrong thing.
      const helper = aiExtractionAvailability({
        settings: settingsWith('anthropic', { apiKey: '', model: 'claude-test' }),
      })
      expect(helper.available).toBe(false)
      expect(readiness.message).toBe(helper.available ? '' : helper.message)
      expect(readiness.message).toMatch(/No API key is set for the AI provider "anthropic"/)
      expect(readiness.message, 'and the offline engine is named as the alternative').toMatch(
        /offline rule engine/,
      )
      expect(readiness.message, 'while nothing is called verified').not.toMatch(
        /verified|accurate|confirmed by/i,
      )
    }
  })

  it('offers the pass when a model is configured', async () => {
    const readiness = await readAiReadiness(makeBridge())
    expect(readiness.ready).toBe(true)
    if (readiness.ready) expect(readiness.settings).toEqual(SETTINGS)
    expect(modelIsConfigured(SETTINGS)).toBe(true)
    // A custom endpoint accepts anonymous requests; Genspark authenticates with
    // the gsk login, so neither needs a key.
    expect(modelIsConfigured(settingsWith('custom', { model: 'llama', baseUrl: 'http://x' }))).toBe(
      true,
    )
    expect(modelIsConfigured(settingsWith('genspark', { model: 'claude-opus-4-7' }))).toBe(true)
    expect(modelIsConfigured(settingsWith('anthropic', { apiKey: '  ', model: 'm' }))).toBe(false)
    expect(modelIsConfigured(settingsWith('anthropic', { apiKey: 'k', model: ' ' }))).toBe(false)
    expect(modelIsConfigured(settingsWith('anthropic', {}))).toBe(false)
    expect(modelIsConfigured(null)).toBe(false)
  })

  it('reports an unreadable bridge or settings instead of throwing', async () => {
    const missing = await readAiReadiness(null)
    expect(missing.ready).toBe(false)
    if (!missing.ready) expect(missing.code).toBe('bridge-unavailable')

    const broken = await readAiReadiness(makeBridge({ settingsError: new Error('disk error') }))
    expect(broken.ready).toBe(false)
    if (!broken.ready) {
      expect(broken.code).toBe('settings-unavailable')
      expect(broken.message).toMatch(/disk error/)
    }
  })

  it('reads the bridge off window.tendersApi, and answers null without it', () => {
    expect(tendersAiBridge()).toBeNull()
    const bridge = makeBridge()
    ;(window as { tendersApi?: unknown }).tendersApi = {
      getAiSettings: bridge.getAiSettings,
      aiStream: bridge.aiStream,
      aiStreamCancel: bridge.aiStreamCancel,
      onAiStream: bridge.onAiStream,
    }
    const mapped = tendersAiBridge()
    expect(mapped).not.toBeNull()
    expect(mapped!.onAiStream(() => undefined)).toBeTypeOf('function')
    // A partial bridge is no bridge: it must not half-work.
    ;(window as { tendersApi?: unknown }).tendersApi = { getAiSettings: bridge.getAiSettings }
    expect(tendersAiBridge()).toBeNull()
  })

  it('round-trips the opt-in preference, defaulting to off', () => {
    const store = new Map<string, string>()
    const storage: AiPreferenceStorage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value)
      },
    }
    // Off unless the user turned it on: AI is never on by default.
    expect(readAiExtractionPreference(storage)).toBe(false)
    persistAiExtractionPreference(true, storage)
    expect(store.get(AI_EXTRACTION_PREF_KEY)).toBe('{"enabled":true}')
    expect(readAiExtractionPreference(storage)).toBe(true)
    persistAiExtractionPreference(false, storage)
    expect(readAiExtractionPreference(storage)).toBe(false)

    // Malformed or unavailable storage means OFF, never a crash.
    store.set(AI_EXTRACTION_PREF_KEY, 'not json')
    expect(readAiExtractionPreference(storage)).toBe(false)
    store.set(AI_EXTRACTION_PREF_KEY, '{"enabled":"yes"}')
    expect(readAiExtractionPreference(storage)).toBe(false)
    expect(readAiExtractionPreference(null)).toBe(false)
    const throwing: AiPreferenceStorage = {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
    }
    expect(readAiExtractionPreference(throwing)).toBe(false)
    expect(() => persistAiExtractionPreference(true, throwing)).not.toThrow()
  })
})

// ── the shape helpers, on their own ──────────────────────────────────────────

describe('AI extraction adapter — the translation helpers', () => {
  it('translate one item without inventing or dropping a member', () => {
    const candidate = toReviewCandidate({
      value: 'ICT/2026/042',
      pageNumber: null,
      sourceClause: null,
      score: 0.5,
    })
    expect(candidate).toEqual({
      value: 'ICT/2026/042',
      sourcePage: null,
      sourceClause: null,
      score: 0.5,
      suggestedBy: 'ai',
    })

    const record = toExtractedRequirement({
      id: 'ai-req-coida',
      ruleKey: 'coida',
      title: 'COIDA letter',
      category: 'MANDATORY_STAGE_1',
      isMandatory: true,
      verbatimClause: 'A COIDA letter is required.',
      pageNumber: 2,
      boundingBox: { top: 0.2, left: 0.1, width: 0.5, height: 0.05 },
      riskLevel: 'CRITICAL_DISQUALIFIER',
      order: 20,
      confidence: 0.6,
      provenance: 'ai-suggested',
      notes: '',
    })
    expect(record.suggestedBy).toBe('ai')
    expect(record).not.toHaveProperty('provenance')
    expect(record, 'an empty note is absent, not an empty string').not.toHaveProperty('notes')
    expect(record, 'no corroborating clauses means no member at all').not.toHaveProperty(
      'additionalClauses',
    )
    expectOnlyAllowedKeys(record, REQUIREMENT_KEYS, 'an extracted requirement')
  })
})

// ── the vision pass's page states ─────────────────────────────────────────────

describe('AI extraction adapter — the vision pass wiring', () => {
  it('says what the vision pass did, and says nothing when it did nothing', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const withoutVision = adaptAiExtraction({ merged })
    expect(withoutVision.summary).not.toMatch(/read by the model/)

    const sentence =
      '2 pages without a text layer were read by the model — everything lifted from them is a suggestion you still have to confirm.'
    const withVision = adaptAiExtraction({ merged, visionSummary: sentence })
    expect(withVision.summary).toContain(sentence)
    // Everything the summary said before the vision pass is still said.
    expect(withVision.summary).toContain('AI extraction read')
    expect(withVision.candidates).toEqual(withoutVision.candidates)
    // An empty sentence adds nothing, so a document with no scanned page reads
    // exactly as it did before this lane existed.
    expect(adaptAiExtraction({ merged, visionSummary: '   ' }).summary).toBe(withoutVision.summary)
  })

  it('keeps the page states a vision read wrote, and keeps the document valid', async () => {
    const merged = await mergedFrom(replyCompletion(MODEL_REPLY))
    const adaptation = adaptAiExtraction({ merged })
    const pages: PageExtractionState[] = [
      { pageNumber: 1, state: 'native', method: 'native-text', confidence: null, reviewedAt: null },
      { pageNumber: 2, state: 'ocr-required', method: null, confidence: null, reviewedAt: null },
    ]
    const marked = markModelReadPages(pages, { scannedPages: [2], readPages: [2] })
    const review = mergeAiIntoReview({ ...emptyReview(), pages: marked }, adaptation, AT)

    // The state a vision read writes: content available, no human decision.
    expect(review.pages).toEqual([
      pages[0],
      {
        pageNumber: 2,
        state: 'ai-extracted',
        method: AI_VISION_METHOD,
        confidence: null,
        reviewedAt: null,
      },
    ])
    for (const field of Object.values(review.fields)) {
      expect(field?.state, 'a model read may never decide a field').not.toBe('confirmed')
    }
    // The schema accepts the state and the method — this is the shape the review
    // step persists, so an illegal one would fail every autosave.
    const result = validateTendersDataV2(
      documentV2([
        tenderRecord({
          requirements: [requirementRecord()],
          intakeVerification: review,
          referenceNumber: null,
          ocrPages: 1,
        }),
      ]),
    )
    expect(result.ok ? [] : result.issues).toEqual([])
  })
})

// ── the wiring itself ─────────────────────────────────────────────────────────

/**
 * Locate one renderer source file from either cwd (`-w` or repo root).
 *
 * Source-order assertions, not behaviour: the invariant they pin — "the AI pass
 * can never delay or remove the local result" — lives in the ORDER the import
 * path does things, and there is no React renderer in this lane to observe it
 * (the app has no DOM testing library, and adding one is not this item's call).
 */
function readRendererSource(relative: string): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of [
      join(dir, 'src', 'renderer', 'src', relative),
      join(dir, 'apps', 'tenders', 'src', 'renderer', 'src', relative),
    ]) {
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
    }
    dir = dirname(dir)
  }
  throw new Error(`Could not locate src/renderer/src/${relative} from ${process.cwd()}`)
}

describe('the TenderList wiring', () => {
  const source = readRendererSource('components/TenderList.tsx')

  it('never awaits the AI pass, so the local result cannot be delayed', () => {
    expect(source, 'the pass must be started, not awaited').toMatch(/void runAiPass\(/)
    expect(source, 'an awaited pass would delay the tender appearing').not.toMatch(
      /await runAiPass\(/,
    )
  })

  it('starts the pass only after the local result is committed and shown', () => {
    const committed = source.indexOf('setActiveTender(record.id)')
    const started = source.indexOf('void runAiPass(')
    expect(committed, 'the import no longer activates the tender it just added').toBeGreaterThan(-1)
    expect(started).toBeGreaterThan(committed)
  })

  it('gates the pass on the remembered preference', () => {
    expect(source).toMatch(/if \(aiEnabledRef\.current\) \{/)
    expect(source).toMatch(/useState<boolean>\(\(\) => readAiExtractionPreference\(\)\)/)
    expect(source, 'the preference is written on every toggle').toMatch(
      /persistAiExtractionPreference\(enabled\)/,
    )
    expect(source, 'the AI pass must be cancellable mid-run').toMatch(/cancelAiRun/)
  })
})

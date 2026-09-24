// AI extraction core — behaviour guard.
//
// The AI pass is additive to the local rule engine: it must work with no network
// (the model call is injected, and every test here uses a deterministic double),
// it must never present a machine suggestion as the parser's own extraction, and
// nothing it produces may ever read as a confirmed field. These tests pin the
// chunking boundaries, the strict-JSON prompt, defensive parsing, per-bound
// rejection, and the merge/dedupe/ranking contract.
//
// It also scans the module's own source for Node-only or provider imports: the file
// has to run in a browser context, so a single `node:` or `@genoffice/ai-provider`
// import would break the contract the rest of these tests assume.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTAKE_CRITICAL_REVIEW_FIELDS } from '../src/shared/types'
import {
  AI_BASE_URL_PROVIDERS,
  AI_FALLBACK_PROVIDER,
  AI_KEYLESS_PROVIDERS,
  AI_PROVIDER_AUTH_KINDS,
  AI_SIGN_IN_PROVIDERS,
  AI_SUGGESTION_PROVENANCE,
  AI_SUGGESTION_REVIEW_STATE,
  DEFAULT_AI_CONFIDENCE,
  INTAKE_METADATA_FIELDS,
  MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT,
  MAX_METADATA_CANDIDATES_PER_FIELD,
  MAX_PARSED_ITEMS_PER_CHUNK,
  MAX_REQUIREMENT_CLAUSE_CHARS,
  MAX_REQUIREMENT_TITLE_CHARS,
  aiExtractionAvailability,
  buildExtractionChunks,
  buildExtractionPrompt,
  isAiSuggested,
  markProvenance,
  mergeExtractionChunks,
  parseExtractionReply,
  runAiExtraction,
  validateSuggestions,
  type AiAvailability,
  type AiAvailabilityInput,
  type AiCompletion,
  type AiProviderConfigLike,
  type ChunkExtractionOutcome,
  type ExtractionChunk,
  type ExtractionRuleCatalogue,
  type ParsedExtractionReply,
} from '../src/shared/ai-extraction'

/** Locate the module on disk whether Vitest runs from the workspace or the repo root. */
function resolveModulePath(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of [
      join(dir, 'src', 'shared', 'ai-extraction.ts'),
      join(dir, 'apps', 'tenders', 'src', 'shared', 'ai-extraction.ts'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
    dir = dirname(dir)
  }
  throw new Error(`Could not locate src/shared/ai-extraction.ts from ${process.cwd()}`)
}

const MODULE_PATH = resolveModulePath()

const RULES: ExtractionRuleCatalogue = [
  {
    ruleKey: 'tax_pin',
    title: 'Valid SARS Tax Clearance / TCS PIN',
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    riskLevel: 'CRITICAL_DISQUALIFIER',
    order: 10,
  },
  {
    ruleKey: 'bbbee',
    title: 'B-BBEE Certificate / Sworn Affidavit',
    category: 'MANDATORY_STAGE_1',
    isMandatory: true,
    riskLevel: 'POINT_SCORED',
    order: 30,
  },
  {
    ruleKey: 'pricing_schedule',
    title: 'Completed Pricing Schedule',
    category: 'FINANCIAL_STAGE_3',
    isMandatory: false,
    riskLevel: 'POINT_SCORED',
    order: 200,
  },
]

const CONTEXT = { rules: RULES, numPages: 6 }

function page(pageNumber: number, text: string): { pageNumber: number; text: string } {
  return { pageNumber, text }
}

/** A reply as the model would write it, ready to be parsed. */
function replyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    metadata: [],
    requirements: [],
    warnings: [],
    ...overrides,
  })
}

function requirementJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleKey: 'tax_pin',
    title: 'Valid SARS Tax Clearance / TCS PIN',
    verbatimClause: 'A valid SARS Tax Clearance Certificate must be submitted.',
    pageNumber: 2,
    boundingBox: { top: 0.1, left: 0.1, width: 0.4, height: 0.05 },
    confidence: 0.8,
    ...overrides,
  }
}

function metadataJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    field: 'referenceNumber',
    value: 'DWS/RFP-2026/0034',
    pageNumber: 1,
    sourceClause: 'Reference: DWS/RFP-2026/0034',
    confidence: 0.7,
    ...overrides,
  }
}

/** Parse and assert success, so a test's intent stays on the validation step. */
function parseOk(raw: string, context = {}): ParsedExtractionReply {
  const parsed = parseExtractionReply(raw, context)
  if (!parsed.ok) throw new Error(`expected a parseable reply, got: ${parsed.error}`)
  return parsed.reply
}

function chunkOf(...pages: { pageNumber: number; text: string }[]): ExtractionChunk {
  return {
    index: 0,
    pages: pages.map((item) => ({ ...item, truncated: false })),
    chars: pages.reduce((total, item) => total + item.text.length, 0),
  }
}

// ── module shape ──────────────────────────────────────────────────────────────

describe('module shape', () => {
  it('declares exactly the intake-critical review fields', () => {
    expect([...INTAKE_METADATA_FIELDS]).toEqual([...INTAKE_CRITICAL_REVIEW_FIELDS])
  })

  it('imports nothing Node-only or provider-specific', () => {
    // Comments name the packages this file must not import, so strip them first.
    const source = readFileSync(MODULE_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    const imports = source.match(/^import[^\n]*$/gm) ?? []
    expect(imports).toHaveLength(1)
    expect(imports[0]).toContain('import type')
    expect(imports[0]).toContain("'./types'")
    for (const forbidden of [
      'ai-provider',
      'ai-search',
      'node:',
      'electron',
      'fetch(',
      'require(',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('marks provenance additively without mutating the input', () => {
    const suggestion = { value: 'x' }
    const marked = markProvenance(suggestion)
    expect(marked).toEqual({ value: 'x', provenance: AI_SUGGESTION_PROVENANCE })
    expect(suggestion).toEqual({ value: 'x' })
    expect(isAiSuggested(marked)).toBe(true)
    expect(isAiSuggested(suggestion)).toBe(false)
    expect(isAiSuggested(null)).toBe(false)
    expect(markProvenance(marked).provenance).toBe(AI_SUGGESTION_PROVENANCE)
  })
})

// ── chunking ──────────────────────────────────────────────────────────────────

describe('buildExtractionChunks', () => {
  it('packs pages up to the budget without splitting a page', () => {
    const chunking = buildExtractionChunks({
      pages: [page(1, 'a'.repeat(10)), page(2, 'b'.repeat(10)), page(3, 'c'.repeat(10))],
      numPages: 3,
      maxChars: 20,
    })
    expect(chunking.chunks.map((chunk) => chunk.pages.map((p) => p.pageNumber))).toEqual([
      [1, 2],
      [3],
    ])
    expect(chunking.chunks.map((chunk) => chunk.chars)).toEqual([20, 10])
    expect(chunking.chunks.map((chunk) => chunk.index)).toEqual([0, 1])
  })

  it('keeps a page that lands exactly on the budget in the same chunk', () => {
    const chunking = buildExtractionChunks({
      pages: [page(1, 'a'.repeat(10)), page(2, 'b'.repeat(10))],
      numPages: 2,
      maxChars: 20,
    })
    expect(chunking.chunks).toHaveLength(1)
    expect(chunking.chunks[0].chars).toBe(20)
  })

  it('pushes a page that is one character over the budget into the next chunk', () => {
    const chunking = buildExtractionChunks({
      pages: [page(1, 'a'.repeat(10)), page(2, 'b'.repeat(11))],
      numPages: 2,
      maxChars: 20,
    })
    expect(chunking.chunks.map((chunk) => chunk.pages.map((p) => p.pageNumber))).toEqual([[1], [2]])
  })

  it('truncates a single page larger than the whole budget and records it', () => {
    const chunking = buildExtractionChunks({
      pages: [page(1, 'a'.repeat(50)), page(2, 'b'.repeat(5))],
      numPages: 2,
      maxChars: 20,
    })
    expect(chunking.chunks).toHaveLength(2)
    expect(chunking.chunks[0].pages[0]).toEqual({
      pageNumber: 1,
      text: 'a'.repeat(20),
      truncated: true,
    })
    expect(chunking.chunks[0].chars).toBe(20)
    expect(chunking.truncatedPages).toEqual([1])
    expect(
      chunking.warnings.some((warning) => warning.includes('more than the 20-character budget')),
    ).toBe(true)
    expect(chunking.chunks[1].pages.map((p) => p.pageNumber)).toEqual([2])
  })

  it('returns no chunks for an empty page list', () => {
    const chunking = buildExtractionChunks({ pages: [], numPages: 0 })
    expect(chunking.chunks).toEqual([])
    expect(chunking.warnings).toEqual([
      'No page text was available, so no AI extraction request was made.',
    ])
  })

  it('preserves page numbers, sorts them and drops duplicates and out-of-range pages', () => {
    const chunking = buildExtractionChunks({
      pages: [
        page(3, 'third'),
        page(1, 'first'),
        page(1, 'duplicate'),
        page(9, 'beyond the document'),
        page(0, 'not a page'),
        page(2.5, 'not a page number'),
      ],
      numPages: 4,
    })
    expect(chunking.inputPages).toEqual([1, 3])
    expect(chunking.chunks[0].pages.map((p) => p.pageNumber)).toEqual([1, 3])
    expect(chunking.warnings).toEqual([
      'Ignored a page entry with an invalid page number (0).',
      'Ignored a duplicate entry for page 1.',
      'Ignored a page entry with an invalid page number (2.5).',
      'Ignored page 9: the document has 4 page(s).',
    ])
  })

  it('never sends a page with no text layer and records it as textless', () => {
    const chunking = buildExtractionChunks({
      pages: [page(1, 'cover page'), page(2, '   \n  '), page(3, 'terms')],
      numPages: 3,
    })
    expect(chunking.textlessPages).toEqual([2])
    expect(chunking.chunks[0].pages.map((p) => p.pageNumber)).toEqual([1, 3])
  })

  it('refuses a budget that cannot hold a chunk', () => {
    expect(() =>
      buildExtractionChunks({ pages: [page(1, 'x')], numPages: 1, maxChars: 0 }),
    ).toThrow(TypeError)
    expect(() =>
      buildExtractionChunks({ pages: [page(1, 'x')], numPages: 1, maxChars: Number.NaN }),
    ).toThrow(TypeError)
  })
})

// ── prompt ────────────────────────────────────────────────────────────────────

describe('buildExtractionPrompt', () => {
  const chunk = chunkOf(
    page(2, 'A valid SARS Tax Clearance Certificate must be submitted.'),
    page(3, 'B-BBEE level 1 is required.'),
  )

  it('demands one strict JSON object with no fences', () => {
    const { system } = buildExtractionPrompt(chunk, { ...CONTEXT, chunkIndex: 0, chunkCount: 2 })
    expect(system).toContain('ONE strict JSON object and nothing else')
    expect(system).toContain('No markdown, no code fences')
    expect(system).toContain('no trailing commas')
    expect(system).toContain('Every number must be a JSON number, not a string')
  })

  it('carries the whole known rule catalogue so keys cannot be invented', () => {
    const { system } = buildExtractionPrompt(chunk, CONTEXT)
    expect(system).toContain('Known rule catalogue (3 keys):')
    expect(system).toContain('ruleKey | title | category | mandatory')
    for (const rule of RULES) {
      expect(system).toContain(rule.ruleKey)
      expect(system).toContain(rule.title)
      expect(system).toContain(rule.category)
    }
    expect(system).toContain(
      'tax_pin | Valid SARS Tax Clearance / TCS PIN | MANDATORY_STAGE_1 | yes',
    )
    expect(system).toContain(
      'pricing_schedule | Completed Pricing Schedule | FINANCIAL_STAGE_3 | no',
    )
    expect(system).toContain('MUST be one of the keys in the catalogue below')
  })

  it('states the honesty rules and the six intake-critical metadata fields', () => {
    const { system } = buildExtractionPrompt(chunk, CONTEXT)
    expect(system).toContain('You are a SUGGESTION engine')
    expect(system).toContain('Never state or imply that anything is confirmed')
    expect(system).toContain('Never paraphrase, normalise, translate or guess')
    expect(system).toContain('Never invent a key')
    expect(system).toContain('"submissionMethod" must be one of PHYSICAL, ELECTRONIC, EMAIL')
    for (const field of INTAKE_METADATA_FIELDS) expect(system).toContain(`"${field}"`)
    expect(system).not.toContain('"estimatedValue"')
    expect(system).not.toContain('"contactEmail"')
  })

  it('marks each page and keeps pages outside the chunk out of the user turn', () => {
    const { user } = buildExtractionPrompt(chunk, {
      ...CONTEXT,
      fileName: 'DWS-RFP-2026-0034.pdf',
      tenderTitle: 'Water reticulation upgrade',
      chunkIndex: 0,
      chunkCount: 2,
    })
    expect(user).toContain('--- PAGE 2 ---')
    expect(user).toContain('A valid SARS Tax Clearance Certificate must be submitted.')
    expect(user).toContain('--- PAGE 3 ---')
    expect(user).toContain('Document: DWS-RFP-2026-0034.pdf')
    expect(user).toContain('Tender title hint: Water reticulation upgrade')
    expect(user).toContain('pages 2–3 of 6')
    expect(user).toContain('This is chunk 1 of 2.')
    expect(user).not.toContain('--- PAGE 1 ---')
    expect(user).not.toContain('--- PAGE 4 ---')
  })

  it('states the page and bounding-box bounds the model must respect', () => {
    const { system } = buildExtractionPrompt(chunk, CONTEXT)
    expect(system).toContain('an integer from 1 to 6')
    expect(system).toContain('left+width at most 1 and top+height at most 1')
  })
})

// ── parsing ───────────────────────────────────────────────────────────────────

describe('parseExtractionReply', () => {
  it('reads a clean JSON object', () => {
    const reply = parseOk(
      replyJson({ metadata: [metadataJson()], requirements: [requirementJson()] }),
    )
    expect(reply.requirements).toHaveLength(1)
    expect(reply.requirements[0].ruleKey).toBe('tax_pin')
    expect(reply.requirements[0].pageNumber).toBe(2)
    expect(reply.requirements[0].boundingBox).toEqual({
      top: 0.1,
      left: 0.1,
      width: 0.4,
      height: 0.05,
    })
    expect(reply.metadata[0].field).toBe('referenceNumber')
    expect(reply.metadata[0].value).toBe('DWS/RFP-2026/0034')
  })

  it('reads JSON inside a markdown fence', () => {
    const raw = '```json\n' + replyJson({ requirements: [requirementJson()] }) + '\n```'
    expect(parseOk(raw).requirements).toHaveLength(1)
  })

  it('tolerates prose before and after the object', () => {
    const raw =
      'Sure — here is the extraction you asked for:\n\n' +
      replyJson({ requirements: [requirementJson()] }) +
      '\n\nLet me know if you need anything else.'
    const reply = parseOk(raw)
    expect(reply.requirements).toHaveLength(1)
    expect(reply.requirements[0].ruleKey).toBe('tax_pin')
  })

  it('tolerates a trailing comma before a closing brace', () => {
    const raw =
      '{"requirements":[{"ruleKey":"tax_pin","title":"Tax","verbatimClause":"x","pageNumber":1,}],}'
    expect(parseOk(raw).requirements[0].title).toBe('Tax')
  })

  it('keeps a brace inside a quoted clause from unbalancing the scan', () => {
    const raw =
      'Note: {"requirements":[{"ruleKey":"tax_pin","title":"Tax {sic}","verbatimClause":"a { b","pageNumber":1}]} done'
    expect(parseOk(raw).requirements[0].title).toBe('Tax {sic}')
  })

  it('unwraps one level of envelope', () => {
    const raw = JSON.stringify({
      extraction: JSON.parse(replyJson({ requirements: [requirementJson()] })),
    })
    expect(parseOk(raw).requirements).toHaveLength(1)
  })

  it('records the chunk page range on the parsed reply', () => {
    const reply = parseOk(replyJson(), { chunk: chunkOf(page(4, 'x'), page(5, 'y')) })
    expect(reply.pageNumbers).toEqual([4, 5])
    expect(reply.chunkIndex).toBe(0)
  })

  it('carries the model’s own warnings', () => {
    const reply = parseOk(replyJson({ warnings: ['page 3 is a scan', 42] }))
    expect(reply.warnings).toEqual(['page 3 is a scan', '42'])
  })

  it('coerces numeric strings and yes/no booleans, and reads aliases', () => {
    const raw = replyJson({
      requirements: [
        {
          key: 'tax_pin',
          title: 'Tax',
          clause: 'A valid tax clearance is required.',
          page: '3',
          confidence: '0.9',
          isMandatory: 'yes',
        },
      ],
    })
    const item = parseOk(raw).requirements[0]
    expect(item.ruleKey).toBe('tax_pin')
    expect(item.verbatimClause).toBe('A valid tax clearance is required.')
    expect(item.pageNumber).toBe(3)
    expect(item.confidence).toBe(0.9)
    expect(item.isMandatory).toBe(true)
    expect(item.boundingBox).toBeNull()
    expect(item.boundingBoxMalformed).toBe(false)
  })

  it('flags a bounding box that is not four numbers without throwing', () => {
    const raw = replyJson({
      requirements: [requirementJson({ boundingBox: { top: 0.1, left: 'x' } })],
    })
    const item = parseOk(raw).requirements[0]
    expect(item.boundingBox).toBeNull()
    expect(item.boundingBoxMalformed).toBe(true)
  })

  it('drops junk items with a warning instead of failing the whole reply', () => {
    const raw = replyJson({
      metadata: ['nonsense', { field: 'title' }, metadataJson()],
      requirements: [42, requirementJson()],
    })
    const reply = parseOk(raw)
    expect(reply.metadata).toHaveLength(1)
    expect(reply.requirements).toHaveLength(1)
    expect(reply.warnings).toEqual([
      'metadata[0] was not a JSON object and was ignored.',
      'metadata[1] had no field/value pair and was ignored.',
      'requirements[0] was not a JSON object and was ignored.',
    ])
  })

  it('keeps an item with no ruleKey so validation can reject it with a reason', () => {
    const raw = replyJson({ requirements: [requirementJson({ ruleKey: undefined })] })
    const reply = parseOk(raw)
    expect(reply.requirements).toHaveLength(1)
    expect(reply.requirements[0].ruleKey).toBe('')
  })

  it('bounds how many entries it will lift', () => {
    const many = Array.from({ length: MAX_PARSED_ITEMS_PER_CHUNK + 5 }, () => requirementJson())
    const reply = parseOk(replyJson({ requirements: many }))
    expect(reply.requirements).toHaveLength(MAX_PARSED_ITEMS_PER_CHUNK)
    expect(reply.warnings.some((warning) => warning.includes('only the first 128 were read'))).toBe(
      true,
    )
  })

  it('fails cleanly on an empty reply', () => {
    const result = parseExtractionReply('   ')
    expect(result).toEqual({ ok: false, error: 'The model returned an empty reply.' })
  })

  it('fails cleanly on truncated JSON', () => {
    const result = parseExtractionReply('{"requirements":[{"ruleKey":"tax_pin"')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('was not valid JSON')
  })

  it('fails cleanly on a root array', () => {
    const result = parseExtractionReply('[{"ruleKey":"tax_pin"}]')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(
      'The model reply was a JSON array; a single JSON object was expected.',
    )
  })

  it('fails cleanly on a scalar root', () => {
    const result = parseExtractionReply('"nothing to report"')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('a single JSON object was expected')
  })

  it('fails cleanly when a collection is the wrong type', () => {
    for (const raw of [replyJson({ requirements: 42 }), replyJson({ metadata: 'none' })]) {
      const result = parseExtractionReply(raw)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error).toContain('an array was expected')
    }
  })

  it('never throws, whatever the model returns', () => {
    const hostile = [
      '',
      '   \n\t ',
      'not json at all',
      '{}',
      'null',
      'undefined',
      '{]',
      '{"a":',
      '{"requirements":{}}',
      '{"requirements":[null]}',
      '{"requirements":[{"ruleKey":123}]}',
      '{"boundingBox":[]}',
      '{"metadata":[{"field":null,"value":null}]}',
      '\\u0000',
      '{"requirements":[{"ruleKey":"tax_pin","confidence":1e999}]}',
      '```\n```',
    ]
    for (const raw of hostile) {
      expect(() => parseExtractionReply(raw)).not.toThrow()
      const result = parseExtractionReply(raw)
      expect(typeof result.ok).toBe('boolean')
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
    }
  })
})

// ── validation ────────────────────────────────────────────────────────────────

describe('validateSuggestions', () => {
  function validate(raw: string, context = CONTEXT) {
    return validateSuggestions(parseOk(raw), context)
  }

  it('accepts a good payload and stamps provenance on every accepted item', () => {
    const result = validate(
      replyJson({ metadata: [metadataJson()], requirements: [requirementJson()] }),
    )
    expect(result.rejections).toEqual([])
    expect(result.requirements).toHaveLength(1)
    expect(result.metadata).toHaveLength(1)
    const requirement = result.requirements[0]
    expect(requirement).toMatchObject({
      id: 'ai-req-tax_pin',
      ruleKey: 'tax_pin',
      category: 'MANDATORY_STAGE_1',
      isMandatory: true,
      riskLevel: 'CRITICAL_DISQUALIFIER',
      order: 10,
      pageNumber: 2,
      confidence: 0.8,
      provenance: AI_SUGGESTION_PROVENANCE,
    })
    expect(requirement.additionalClauses).toBeUndefined()
    expect(requirement.notes).toBeUndefined()
    expect(isAiSuggested(result.metadata[0])).toBe(true)
    expect(result.metadata[0].score).toBe(0.7)
  })

  it('takes category, mandatory flag, risk and order from the catalogue, not the model', () => {
    const result = validate(
      replyJson({
        requirements: [
          requirementJson({
            category: 'GENERAL_RETURNABLE',
            isMandatory: false,
            riskLevel: 'INFORMATIONAL',
            order: 999,
          }),
        ],
      }),
    )
    expect(result.requirements[0]).toMatchObject({
      category: 'MANDATORY_STAGE_1',
      isMandatory: true,
      riskLevel: 'CRITICAL_DISQUALIFIER',
      order: 10,
    })
  })

  it('rejects a requirement page outside the document', () => {
    const result = validate(replyJson({ requirements: [requirementJson({ pageNumber: 7 })] }))
    expect(result.requirements).toEqual([])
    expect(result.rejections).toHaveLength(1)
    expect(result.rejections[0]).toMatchObject({
      kind: 'requirement',
      path: 'requirements[0].pageNumber',
      code: 'PAGE_OUT_OF_RANGE',
    })
    expect(result.rejections[0].reason).toContain('does not exist in this document (1–6)')
  })

  it('rejects a requirement that cites no page at all', () => {
    const result = validate(replyJson({ requirements: [requirementJson({ pageNumber: null })] }))
    expect(result.rejections[0]).toMatchObject({ code: 'PAGE_MISSING' })
  })

  it('rejects an unknown or empty rule key', () => {
    const unknown = validate(
      replyJson({ requirements: [requirementJson({ ruleKey: 'made_up_rule' })] }),
    )
    expect(unknown.rejections[0]).toMatchObject({
      code: 'UNKNOWN_RULE_KEY',
      path: 'requirements[0].ruleKey',
    })
    expect(unknown.rejections[0].reason).toContain('cannot be matched to a vault document later')

    const empty = validate(replyJson({ requirements: [requirementJson({ ruleKey: undefined })] }))
    expect(empty.rejections[0]).toMatchObject({ code: 'UNKNOWN_RULE_KEY' })
  })

  it('rejects a bounding box whose members leave 0–1', () => {
    for (const box of [
      { top: -0.1, left: 0.1, width: 0.2, height: 0.2 },
      { top: 0.1, left: 0.1, width: 0.2, height: 1.5 },
      { top: 2, left: 0, width: 0, height: 0 },
    ]) {
      const result = validate(replyJson({ requirements: [requirementJson({ boundingBox: box })] }))
      expect(result.requirements).toEqual([])
      expect(result.rejections[0]).toMatchObject({ code: 'BOUNDING_BOX_INVALID' })
    }
  })

  it('rejects a bounding box that overflows the page, exactly as the schema does', () => {
    const horizontal = validate(
      replyJson({
        requirements: [
          requirementJson({ boundingBox: { top: 0, left: 0.6, width: 0.5, height: 0.1 } }),
        ],
      }),
    )
    expect(horizontal.rejections[0]).toMatchObject({ code: 'BOUNDING_BOX_INVALID' })

    const vertical = validate(
      replyJson({
        requirements: [
          requirementJson({ boundingBox: { top: 0.95, left: 0, width: 0.1, height: 0.1 } }),
        ],
      }),
    )
    expect(vertical.rejections[0]).toMatchObject({ code: 'BOUNDING_BOX_INVALID' })

    // 0.7 + 0.3 = 0.9999999999999999 in IEEE-754, and the persistence schema compares
    // exactly, so a box that lands inside the page must be accepted.
    const inside = validate(
      replyJson({
        requirements: [
          requirementJson({ boundingBox: { top: 0, left: 0.7, width: 0.3, height: 0.1 } }),
        ],
      }),
    )
    expect(inside.rejections).toEqual([])
    expect(inside.requirements).toHaveLength(1)
  })

  it('rejects a malformed bounding box', () => {
    const result = validate(
      replyJson({ requirements: [requirementJson({ boundingBox: { top: 0.1, left: 'x' } })] }),
    )
    expect(result.rejections[0]).toMatchObject({ code: 'BOUNDING_BOX_INVALID' })
  })

  it('rejects a confidence outside 0–1', () => {
    const result = validate(replyJson({ requirements: [requirementJson({ confidence: 2 })] }))
    expect(result.rejections[0]).toMatchObject({
      code: 'CONFIDENCE_OUT_OF_RANGE',
      path: 'requirements[0].confidence',
    })
    expect(result.rejections[0].reason).toContain('outside 0–1')
  })

  it('rejects duplicate requirement ids', () => {
    const result = validate(
      replyJson({
        requirements: [
          requirementJson({ id: 'shared-id' }),
          requirementJson({ id: 'shared-id', ruleKey: 'bbbee', title: 'B-BBEE' }),
        ],
      }),
    )
    expect(result.requirements).toHaveLength(1)
    expect(result.rejections[0]).toMatchObject({
      code: 'DUPLICATE_REQUIREMENT_ID',
      path: 'requirements[1].id',
    })
  })

  it('rejects an empty title and an over-long title', () => {
    const empty = validate(replyJson({ requirements: [requirementJson({ title: '  ' })] }))
    expect(empty.rejections[0]).toMatchObject({ code: 'EMPTY_TITLE' })

    const long = validate(
      replyJson({
        requirements: [requirementJson({ title: 'x'.repeat(MAX_REQUIREMENT_TITLE_CHARS + 1) })],
      }),
    )
    expect(long.rejections[0]).toMatchObject({ code: 'TITLE_TOO_LONG' })
  })

  it('rejects an over-long verbatim clause', () => {
    const result = validate(
      replyJson({
        requirements: [
          requirementJson({ verbatimClause: 'x'.repeat(MAX_REQUIREMENT_CLAUSE_CHARS + 1) }),
        ],
      }),
    )
    expect(result.rejections[0]).toMatchObject({ code: 'CLAUSE_TOO_LONG' })
  })

  it('rejects metadata fields outside the six intake-critical ones', () => {
    for (const field of ['estimatedValue', 'contactEmail', 'nonsense']) {
      const result = validate(replyJson({ metadata: [metadataJson({ field })] }))
      expect(result.metadata).toEqual([])
      expect(result.rejections[0]).toMatchObject({
        code: 'METADATA_FIELD_NOT_ALLOWED',
        path: 'metadata[0].field',
      })
      expect(result.rejections[0].reason).toContain('intake-critical')
    }
  })

  it('drops a metadata entry with no field name at parse time', () => {
    const parsed = parseExtractionReply(replyJson({ metadata: [metadataJson({ field: '' })] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.reply.metadata).toEqual([])
    expect(parsed.reply.warnings).toEqual(['metadata[0] had no field/value pair and was ignored.'])
  })

  it('rejects blank, over-long and out-of-range metadata values', () => {
    const blank = validate(replyJson({ metadata: [metadataJson({ value: '   ' })] }))
    expect(blank.rejections[0]).toMatchObject({ code: 'METADATA_VALUE_EMPTY' })

    const long = validate(replyJson({ metadata: [metadataJson({ value: 'x'.repeat(600) })] }))
    expect(long.rejections[0]).toMatchObject({ code: 'METADATA_VALUE_TOO_LONG' })

    const page = validate(replyJson({ metadata: [metadataJson({ pageNumber: 99 })] }))
    expect(page.rejections[0]).toMatchObject({ code: 'PAGE_OUT_OF_RANGE' })

    const confidence = validate(replyJson({ metadata: [metadataJson({ confidence: -1 })] }))
    expect(confidence.rejections[0]).toMatchObject({ code: 'CONFIDENCE_OUT_OF_RANGE' })
  })

  it('accepts a metadata value with no page but says so', () => {
    const result = validate(
      replyJson({ metadata: [metadataJson({ pageNumber: null, sourceClause: null })] }),
    )
    expect(result.metadata[0].pageNumber).toBeNull()
    expect(result.metadata[0].sourceClause).toBeNull()
    expect(result.warnings.some((warning) => warning.includes('no source page'))).toBe(true)
  })

  it('drops an over-long quoted source line rather than cutting it short', () => {
    const result = validate(
      replyJson({ metadata: [metadataJson({ sourceClause: 'x'.repeat(2_100) })] }),
    )
    expect(result.metadata[0].sourceClause).toBeNull()
    expect(
      result.warnings.some((warning) => warning.includes('dropped rather than cut short')),
    ).toBe(true)
  })

  it('offers a requirement without a box or confidence, but records both', () => {
    const result = validate(
      replyJson({ requirements: [requirementJson({ boundingBox: null, confidence: null })] }),
    )
    expect(result.rejections).toEqual([])
    expect(result.requirements[0].boundingBox).toEqual({ top: 0, left: 0, width: 0, height: 0 })
    expect(result.requirements[0].confidence).toBe(DEFAULT_AI_CONFIDENCE)
    expect(result.warnings.some((warning) => warning.includes('no bounding box'))).toBe(true)
    expect(
      result.warnings.filter((warning) => warning.includes('stated no confidence')),
    ).toHaveLength(1)
  })

  it('synthesises unique ids and drops duplicate metadata values within a chunk', () => {
    const result = validate(
      replyJson({
        requirements: [requirementJson(), requirementJson({ id: 'explicit' })],
        metadata: [metadataJson(), metadataJson({ value: 'dws/rfp-2026/0034 ' })],
      }),
    )
    expect(result.requirements.map((item) => item.id)).toEqual(['ai-req-tax_pin', 'explicit'])
    expect(result.metadata).toHaveLength(1)
  })

  it('replaces a model id that is too long to be an id', () => {
    const result = validate(replyJson({ requirements: [requirementJson({ id: 'x'.repeat(200) })] }))
    expect(result.requirements[0].id).toBe('ai-req-tax_pin')
    expect(result.warnings.some((warning) => warning.includes('longer than 128 characters'))).toBe(
      true,
    )
  })

  it('caps how much one chunk may add', () => {
    const many = Array.from({ length: 70 }, (_, index) => requirementJson({ id: `id-${index}` }))
    const result = validate(replyJson({ requirements: many }))
    expect(result.requirements).toHaveLength(64)
    expect(result.rejections).toHaveLength(6)
    expect(result.rejections[0]).toMatchObject({ code: 'REQUIREMENT_LIMIT_EXCEEDED' })
  })

  it('keeps an empty result empty', () => {
    const result = validate(replyJson())
    expect(result).toEqual({ metadata: [], requirements: [], rejections: [], warnings: [] })
  })
})

// ── merging ───────────────────────────────────────────────────────────────────

describe('mergeExtractionChunks', () => {
  function outcome(
    chunkIndex: number,
    pageNumbers: number[],
    raw: string | null,
    error?: string,
  ): ChunkExtractionOutcome {
    if (raw === null) {
      return { chunkIndex, pageNumbers, validation: null, error: error ?? 'the call failed' }
    }
    return {
      chunkIndex,
      pageNumbers,
      validation: validateSuggestions(parseOk(raw), CONTEXT),
    }
  }

  function chunking(...pageNumbers: number[]): ReturnType<typeof buildExtractionChunks> {
    return buildExtractionChunks({
      pages: pageNumbers.map((pageNumber) => page(pageNumber, `text of page ${pageNumber}`)),
      numPages: CONTEXT.numPages,
    })
  }

  function merge(outcomes: ChunkExtractionOutcome[], visionPages: number[] = []) {
    return mergeExtractionChunks(outcomes, {
      ...CONTEXT,
      chunking: chunking(1, 2, 3, 4, 5, 6),
      visionPages,
    })
  }

  it('de-duplicates metadata by value and ranks a value seen twice above one seen once', () => {
    const merged = merge([
      outcome(
        0,
        [1],
        replyJson({
          metadata: [
            metadataJson({ value: 'DWS/RFP-2026/0034', confidence: 0.6 }),
            metadataJson({ value: 'One-off value', confidence: 0.6 }),
          ],
        }),
      ),
      outcome(
        1,
        [2],
        replyJson({
          metadata: [metadataJson({ value: 'DWS/RFP-2026/0034', confidence: 0.6, pageNumber: 2 })],
        }),
      ),
    ])
    expect(merged.metadata).toHaveLength(2)
    const [first, second] = merged.metadata
    expect(first.value).toBe('DWS/RFP-2026/0034')
    expect(first.score).toBeCloseTo(0.7, 10)
    expect(second.value).toBe('One-off value')
    expect(second.score).toBeCloseTo(0.6, 10)
    expect(first.score).toBeGreaterThan(second.score)
    expect(first.pageNumber).toBe(1)
    expect(merged.metadata.every((item) => item.provenance === AI_SUGGESTION_PROVENANCE)).toBe(true)
  })

  it('orders metadata candidates by field order, then score', () => {
    const merged = merge([
      outcome(
        0,
        [1],
        replyJson({
          metadata: [
            metadataJson({ field: 'issuingBody', value: 'Dept of Water', confidence: 0.4 }),
            metadataJson({ field: 'title', value: 'Water reticulation upgrade', confidence: 0.5 }),
            metadataJson({
              field: 'title',
              value: 'Water reticulation upgrade (amended)',
              confidence: 0.9,
            }),
          ],
        }),
      ),
    ])
    expect(merged.metadata.map((item) => [item.field, item.value])).toEqual([
      ['title', 'Water reticulation upgrade (amended)'],
      ['title', 'Water reticulation upgrade'],
      ['issuingBody', 'Dept of Water'],
    ])
  })

  it('caps candidates per field and says what it dropped', () => {
    const many = Array.from({ length: MAX_METADATA_CANDIDATES_PER_FIELD + 3 }, (_, index) =>
      metadataJson({ field: 'issuingBody', value: `Issuer ${index}`, confidence: 0.5 }),
    )
    const merged = merge([outcome(0, [1], replyJson({ metadata: many }))])
    expect(merged.metadata).toHaveLength(MAX_METADATA_CANDIDATES_PER_FIELD)
    expect(
      merged.rejections.filter((item) => item.code === 'METADATA_LIMIT_EXCEEDED'),
    ).toHaveLength(3)
  })

  it('merges requirements by ruleKey, one per rule, with corroboration', () => {
    const merged = merge([
      outcome(
        0,
        [1],
        replyJson({
          requirements: [
            requirementJson({
              confidence: 0.5,
              pageNumber: 1,
              verbatimClause: 'Tax clearance required.',
            }),
            requirementJson({
              ruleKey: 'bbbee',
              title: 'B-BBEE',
              confidence: 0.4,
              pageNumber: 1,
              verbatimClause: 'B-BBEE level 1.',
            }),
          ],
        }),
      ),
      outcome(
        1,
        [2],
        replyJson({
          requirements: [
            requirementJson({
              confidence: 0.9,
              pageNumber: 2,
              verbatimClause: 'A valid TCS PIN is required.',
            }),
          ],
        }),
      ),
    ])
    expect(merged.requirements.map((item) => item.ruleKey)).toEqual(['tax_pin', 'bbbee'])
    const taxPin = merged.requirements[0]
    expect(taxPin.pageNumber).toBe(2)
    expect(taxPin.verbatimClause).toBe('A valid TCS PIN is required.')
    expect(taxPin.confidence).toBe(1)
    expect(taxPin.additionalClauses).toEqual([{ text: 'Tax clearance required.', pageNumber: 1 }])
    expect(taxPin.notes).toContain('Also referenced on p. 1')
    expect(taxPin.id).toBe('ai-req-tax_pin')
  })

  it('caps corroborating clauses per requirement', () => {
    const pageCount = MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT + 3
    const wideContext = { rules: RULES, numPages: pageCount }
    const outcomes: ChunkExtractionOutcome[] = Array.from({ length: pageCount }, (_, index) => ({
      chunkIndex: index,
      pageNumbers: [index + 1],
      validation: validateSuggestions(
        parseOk(
          replyJson({
            requirements: [
              requirementJson({
                confidence: 0.5,
                pageNumber: index + 1,
                verbatimClause: `Clause on page ${index + 1}.`,
              }),
            ],
          }),
        ),
        wideContext,
      ),
    }))
    const merged = mergeExtractionChunks(outcomes, {
      ...wideContext,
      chunking: buildExtractionChunks({
        pages: Array.from({ length: pageCount }, (_, index) => page(index + 1, 'text')),
        numPages: pageCount,
      }),
    })
    expect(merged.requirements).toHaveLength(1)
    expect(merged.requirements[0].additionalClauses).toHaveLength(
      MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT,
    )
    expect(merged.requirements[0].additionalClauses?.[0]).toEqual({
      text: 'Clause on page 2.',
      pageNumber: 2,
    })
    expect(merged.requirements[0].confidence).toBe(1)
    expect(merged.requirements[0].notes).toContain(`p. ${pageCount}`)
  })

  it('keeps requirement ids unique across different rules', () => {
    const merged = merge([
      outcome(0, [1], replyJson({ requirements: [requirementJson({ id: 'same-id' })] })),
      outcome(
        1,
        [2],
        replyJson({
          requirements: [
            requirementJson({
              id: 'same-id',
              ruleKey: 'bbbee',
              title: 'B-BBEE',
              verbatimClause: 'B-BBEE level 1.',
              pageNumber: 2,
            }),
          ],
        }),
      ),
    ])
    const ids = merged.requirements.map((item) => item.id)
    expect(ids).toEqual(['ai-req-tax_pin', 'same-id'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(merged.warnings.some((warning) => warning.includes('stay unique'))).toBe(true)
  })

  it('records which pages were read and by what method', () => {
    const merged = merge([outcome(0, [1, 2], replyJson()), outcome(1, [3], replyJson())], [5])
    expect(merged.pagesRead).toEqual([
      { pageNumber: 1, method: 'native-text', chunkIndex: 0 },
      { pageNumber: 2, method: 'native-text', chunkIndex: 0 },
      { pageNumber: 3, method: 'native-text', chunkIndex: 1 },
      { pageNumber: 5, method: 'ai-vision', chunkIndex: null },
    ])
    expect(merged.unreadPages).toEqual([4, 6])
  })

  it('leaves a failed chunk’s pages unread and says why', () => {
    const merged = merge([
      outcome(0, [1, 2], replyJson({ requirements: [requirementJson({ pageNumber: 1 })] })),
      outcome(1, [3, 4], null, 'the provider rejected the API key'),
    ])
    expect(merged.unreadPages).toEqual([3, 4, 5, 6])
    expect(merged.warnings.some((warning) => warning.includes('pages 3–4'))).toBe(true)
    expect(
      merged.warnings.some((warning) => warning.includes('the provider rejected the API key')),
    ).toBe(true)
    expect(merged.requirements).toHaveLength(1)
  })

  it('treats a page with no text layer as unread even when the chunks cover it', () => {
    const merged = mergeExtractionChunks([outcome(0, [1], replyJson())], {
      ...CONTEXT,
      numPages: 2,
      chunking: buildExtractionChunks({ pages: [page(1, 'text'), page(2, '')], numPages: 2 }),
    })
    expect(merged.pagesRead).toEqual([{ pageNumber: 1, method: 'native-text', chunkIndex: 0 }])
    expect(merged.unreadPages).toEqual([2])
  })

  it('carries the unconfirmed review state and never says confirmed', () => {
    const merged = merge([
      outcome(0, [1], replyJson({ metadata: [metadataJson()], requirements: [requirementJson()] })),
    ])
    expect(merged.provenance).toBe(AI_SUGGESTION_PROVENANCE)
    expect(merged.reviewState).toBe(AI_SUGGESTION_REVIEW_STATE)
    expect(merged.reviewState).toBe('unconfirmed')
    // No review state other than "unconfirmed" may appear anywhere in the result.
    expect(JSON.stringify(merged)).not.toContain('"confirmed"')
    expect(merged.metadata.every(isAiSuggested)).toBe(true)
    expect(merged.requirements.every(isAiSuggested)).toBe(true)
  })

  it('survives an empty run', () => {
    const merged = merge([])
    expect(merged.metadata).toEqual([])
    expect(merged.requirements).toEqual([])
    expect(merged.unreadPages).toEqual([1, 2, 3, 4, 5, 6])
  })
})

// ── the pipeline with an injected model call ──────────────────────────────────

describe('runAiExtraction', () => {
  const pages = [
    page(1, 'Cover page with reference DWS/RFP-2026/0034'),
    page(2, 'A valid SARS Tax Clearance Certificate is required.'),
  ]

  it('drives an injected completion with no network and merges the replies', async () => {
    const calls: { system: string; user: string }[] = []
    const completion: AiCompletion = async ({ system, user }) => {
      calls.push({ system, user })
      return replyJson({
        metadata: [metadataJson()],
        requirements: [requirementJson({ pageNumber: 2 })],
      })
    }
    const chunking = buildExtractionChunks({ pages, numPages: 2 })
    const { merged, outcomes } = await runAiExtraction({
      completion,
      chunking,
      context: { rules: RULES, numPages: 2 },
      fileName: 'DWS-RFP-2026-0034.pdf',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].system).toContain('ONE strict JSON object')
    expect(calls[0].user).toContain('--- PAGE 2 ---')
    expect(outcomes).toHaveLength(1)
    expect(merged.requirements).toHaveLength(1)
    expect(merged.metadata).toHaveLength(1)
    expect(merged.pagesRead).toHaveLength(2)
    expect(merged.reviewState).toBe('unconfirmed')
  })

  it('keeps going when the model call throws, and never throws itself', async () => {
    const completion: AiCompletion = async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:443')
    }
    const chunking = buildExtractionChunks({ pages, numPages: 2 })
    const { merged, outcomes } = await runAiExtraction({
      completion,
      chunking,
      context: { rules: RULES, numPages: 2 },
    })
    expect(outcomes[0].error).toContain('ECONNREFUSED')
    expect(merged.requirements).toEqual([])
    expect(merged.unreadPages).toEqual([1, 2])
  })

  it('reports an unreadable reply honestly instead of guessing', async () => {
    const completion: AiCompletion = async () => 'I could not read that document.'
    const chunking = buildExtractionChunks({ pages, numPages: 2 })
    const { merged, outcomes } = await runAiExtraction({
      completion,
      chunking,
      context: { rules: RULES, numPages: 2 },
    })
    expect(outcomes[0].validation).toBeNull()
    expect(outcomes[0].error).toContain('was not valid JSON')
    expect(merged.unreadPages).toEqual([1, 2])
  })

  it('does not call the model at all when the run is already cancelled', async () => {
    let calls = 0
    const completion: AiCompletion = async () => {
      calls += 1
      return replyJson()
    }
    const chunking = buildExtractionChunks({ pages, numPages: 2 })
    const { merged, outcomes } = await runAiExtraction({
      completion,
      chunking,
      context: { rules: RULES, numPages: 2 },
      signal: AbortSignal.abort(),
    })
    expect(calls).toBe(0)
    expect(outcomes[0].error).toContain('cancelled')
    expect(merged.unreadPages).toEqual([1, 2])
  })

  it('reports progress before each chunk', async () => {
    const seen: number[][] = []
    const chunking = buildExtractionChunks({
      pages: [page(1, 'a'.repeat(15)), page(2, 'b'.repeat(15))],
      numPages: 2,
      maxChars: 20,
    })
    const { merged } = await runAiExtraction({
      completion: async () => replyJson(),
      chunking,
      context: { rules: RULES, numPages: 2 },
      onChunk: (info) => seen.push(info.pageNumbers),
    })
    expect(seen).toEqual([[1], [2]])
    expect(merged.pagesRead).toHaveLength(2)
  })
})

// ── availability ──────────────────────────────────────────────────────────────

/** Locate the suite's provider catalogue on disk — the module under test must not import it. */
function resolveCataloguePath(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'packages', 'ai-provider', 'src', 'providers.ts')
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  throw new Error(`Could not locate packages/ai-provider/src/providers.ts from ${process.cwd()}`)
}

const CATALOGUE_SOURCE = readFileSync(resolveCataloguePath(), 'utf8')

/** Locate the suite's provider registry on disk — the module under test must not import it. */
function resolveRegistryPath(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'packages', 'ai-provider', 'src', 'registry.ts')
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  throw new Error(`Could not locate packages/ai-provider/src/registry.ts from ${process.cwd()}`)
}

const REGISTRY_SOURCE = readFileSync(resolveRegistryPath(), 'utf8')

/** Provider ids the catalogue's `AI_PROVIDERS` declares, in order. */
function catalogueIds(): string[] {
  const start = CATALOGUE_SOURCE.indexOf('export const AI_PROVIDERS')
  const body = CATALOGUE_SOURCE.slice(start, CATALOGUE_SOURCE.indexOf('\n]', start))
  return [...body.matchAll(/^\s*id: '([a-z0-9-]+)',?\s*$/gm)].map((match) => match[1])
}

/** Provider ids the catalogue's `AI_PROVIDERS` marks with `<flag>: true`. */
function catalogueIdsFlagged(flag: string): string[] {
  const start = CATALOGUE_SOURCE.indexOf('export const AI_PROVIDERS')
  const body = CATALOGUE_SOURCE.slice(start, CATALOGUE_SOURCE.indexOf('\n]', start))
  const ids: string[] = []
  let current: string | null = null
  for (const line of body.split('\n')) {
    const id = /^\s*id: '([a-z0-9-]+)',?\s*$/.exec(line)
    if (id) current = id[1]
    if (new RegExp(`^\\s*${flag}: true,?\\s*$`).test(line) && current !== null) ids.push(current)
  }
  return ids
}

/**
 * The `capabilities.auth` each registry adapter declares, by provider id — the
 * value the request path itself reads. Adapter keys sit at two spaces of
 * indentation, so the parse cannot wander into a nested `resolveEndpoint` body.
 */
function registryAuthKinds(): Map<string, string> {
  const start = REGISTRY_SOURCE.indexOf('export const AI_PROVIDER_ADAPTERS')
  const body = REGISTRY_SOURCE.slice(start, REGISTRY_SOURCE.indexOf('\n}', start))
  const kinds = new Map<string, string>()
  let current: string | null = null
  for (const line of body.split('\n')) {
    const key = /^  '?([a-z0-9-]+)'?: \{$/.exec(line)
    if (key) current = key[1]
    const auth = /capabilities: \{ auth: '([a-z-]+)'/.exec(line)
    if (auth && current !== null && !kinds.has(current)) kinds.set(current, auth[1])
  }
  return kinds
}

/** Provider ids whose registry adapter declares `<auth>`. */
function registryIdsWithAuth(auth: string): string[] {
  return [...registryAuthKinds()].filter(([, kind]) => kind === auth).map(([id]) => id)
}

/** The literal provider ids `activeProvider` returns when a stored selection is unusable. */
function activeProviderFallbacks(): string[] {
  const start = CATALOGUE_SOURCE.indexOf('export function activeProvider')
  const body = CATALOGUE_SOURCE.slice(start, CATALOGUE_SOURCE.indexOf('\n}', start))
  return [...body.matchAll(/return '([a-z0-9-]+)'/g)].map((match) => match[1])
}

function unavailable(input: AiAvailabilityInput): Extract<AiAvailability, { available: false }> {
  const result = aiExtractionAvailability(input)
  if (result.available) throw new Error(`expected unavailable, got provider ${result.provider}`)
  return result
}

function available(input: AiAvailabilityInput): Extract<AiAvailability, { available: true }> {
  const result = aiExtractionAvailability(input)
  if (!result.available) throw new Error(`expected available, got reason ${result.reason}`)
  return result
}

describe('aiExtractionAvailability', () => {
  /**
   * Settings shaped the way the shell hands them over: the user's selected
   * provider with its own config. For the key/model cases the selection is the
   * fallback provider itself, so the reason names the provider whose key or model
   * is actually missing instead of the one the suite would fall back to.
   */
  const selected = (provider: string, config: AiProviderConfigLike): AiAvailabilityInput => ({
    settings: { provider, providers: { [provider]: config } },
  })
  const kimi = (apiKey: string, model = 'kimi-k3'): AiAvailabilityInput =>
    selected('kimi', { apiKey, model })

  it('is available when the selected provider has a key and a model', () => {
    expect(available(kimi('sk-user'))).toEqual({
      available: true,
      provider: 'kimi',
      model: 'kimi-k3',
      visionCapable: null,
    })
  })

  it('reports no provider when there are no settings at all', () => {
    for (const input of [
      {},
      { settings: null },
      { settings: {} },
      { settings: { provider: '   ' } },
      // neither the selection nor the fallback has a config object
      { settings: { provider: 'kimi', providers: {} } },
    ]) {
      const result = unavailable(input)
      expect(result.reason).toBe('no-provider-configured')
      expect(result.message).toContain('No AI provider is configured')
    }
  })

  it('treats an empty key as no key', () => {
    const result = unavailable(selected('anthropic', { apiKey: '', model: 'claude-sonnet' }))
    expect(result.reason).toBe('no-api-key')
    expect(result.message).toContain('"anthropic"')
  })

  it('treats a whitespace-only key as no key, like the suite’s own guard', () => {
    // `apps/slides/src/main/ai-ipc.ts` gates the stream on `config.apiKey`, and
    // `activeProvider` trims: a key of spaces is a 401, not a configuration.
    expect(
      unavailable(selected('anthropic', { apiKey: ' \t ', model: 'claude-sonnet' })).reason,
    ).toBe('no-api-key')
  })

  it('reports a missing model', () => {
    const result = unavailable(selected('anthropic', { apiKey: 'sk-a', model: '' }))
    expect(result.reason).toBe('no-model')
    expect(result.message).toContain('"anthropic"')
  })

  it('keeps the three reasons and their messages distinct', () => {
    const cases = [
      unavailable({}),
      unavailable(selected('anthropic', { apiKey: '', model: 'claude-sonnet' })),
      unavailable(selected('anthropic', { apiKey: 'sk-a', model: '' })),
    ]
    expect(cases.map((result) => result.reason)).toEqual([
      'no-provider-configured',
      'no-api-key',
      'no-model',
    ])
    expect(new Set(cases.map((result) => result.reason)).size).toBe(3)
    expect(new Set(cases.map((result) => result.message)).size).toBe(3)
  })

  it('falls back to the BYOK default when the stored selection is unusable', () => {
    const result = available({
      settings: {
        provider: 'kimi',
        providers: {
          kimi: { apiKey: '', model: 'kimi-k3' },
          anthropic: { apiKey: 'sk-a', model: 'claude-sonnet' },
        },
      },
    })
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-sonnet')
  })

  it('takes a base URL as the credential for the providers that need one', () => {
    const providers = {
      custom: { apiKey: 'k', model: 'llama3' },
      anthropic: { apiKey: '', model: 'claude-sonnet' },
    }
    // No base URL: the selection is not usable, so the fallback is judged instead.
    expect(unavailable({ settings: { provider: 'custom', providers } }).reason).toBe('no-api-key')
    // With one, the selection is usable — and the api key stays OPTIONAL, which
    // is what `activeProvider` documents for the anonymous OpenAI-compatible
    // endpoints (Ollama, LM Studio, vLLM) this provider exists for.
    const withBaseUrl = (apiKey: string): AiAvailabilityInput => ({
      settings: {
        provider: 'custom',
        providers: { ...providers, custom: { apiKey, model: 'llama3', baseUrl: 'http://x/v1' } },
      },
    })
    for (const apiKey of ['k', '', '   ']) {
      expect(available(withBaseUrl(apiKey))).toMatchObject({ provider: 'custom', model: 'llama3' })
    }
    // A model is still required of it, exactly as `activeProvider` requires one.
    expect(
      unavailable({
        settings: { provider: 'custom', providers: { custom: { baseUrl: 'http://x/v1' } } },
        fallbackProvider: 'custom',
      }).reason,
    ).toBe('no-model')
    // When the base URL IS the credential and it is missing, the message names
    // the base URL rather than an api key this provider never needed. The reason
    // stays the documented "the credential is missing" one.
    const missingBaseUrl = unavailable({
      settings: { provider: 'custom', providers: { custom: { apiKey: 'k', model: 'llama3' } } },
      fallbackProvider: 'custom',
    })
    expect(missingBaseUrl.reason).toBe('no-api-key')
    expect(missingBaseUrl.message).toContain('no base URL')
  })

  it('accepts a keyless CLI provider with no key and no model', () => {
    const result = available({
      settings: { provider: 'codex', providers: { codex: { apiKey: '', model: '' } } },
    })
    expect(result.provider).toBe('codex')
    expect(result.model).toBe('')
  })

  it('accepts a provider the app signs in for, and still requires its model', () => {
    // Genspark's key never reaches the settings file: the main process fetches
    // one from the app login for the request (`gskApiKey()` in the shared
    // `ai:stream` handler), so no key is ever asked of the user.
    const genspark = (model: string): AiAvailabilityInput => ({
      settings: { provider: 'genspark', providers: { genspark: { apiKey: '', model } } },
    })
    expect(available(genspark('claude-opus-4-7'))).toEqual({
      available: true,
      provider: 'genspark',
      model: 'claude-opus-4-7',
      visionCapable: null,
    })
    // …but a model id IS required of it, exactly as the main-process guard
    // requires one of every provider but codex.
    const noModel = unavailable({ ...genspark('   '), fallbackProvider: 'genspark' })
    expect(noModel.reason).toBe('no-model')
    expect(noModel.message).toContain('"genspark"')
  })

  it('echoes the caller’s own vision answer instead of inventing a fourth reason', () => {
    expect(available({ ...kimi('sk-user'), visionCapable: false }).visionCapable).toBe(false)
    expect(available({ ...kimi('sk-user'), visionCapable: true }).visionCapable).toBe(true)
    // A text-only model is still available for pages that carry a text layer.
    const textOnly = selected('anthropic', { apiKey: '', model: 'claude-sonnet' })
    expect(unavailable({ ...textOnly, visionCapable: true }).reason).toBe('no-api-key')
  })

  it('needs no caller-supplied override list to answer', () => {
    // The credential rule belongs to this module: a caller able to extend the
    // keyless or base-URL set could make one settings object answer two ways,
    // which is the drift the single source of truth exists to prevent.
    const source = readFileSync(MODULE_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    const input = /export interface AiAvailabilityInput \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    expect(input, 'the availability input carries the settings').toContain('settings')
    expect(input, 'and no provider-set override to construct').not.toMatch(
      /keyless|baseUrl|providers\?:/,
    )
    // …and the three credential shapes really are answered from the settings.
    expect(available(selected('codex', { apiKey: '', model: '' })).provider).toBe('codex')
    expect(available(selected('genspark', { model: 'claude-opus-4-7' })).provider).toBe('genspark')
    expect(available(selected('custom', { model: 'llama3', baseUrl: 'http://x' })).provider).toBe(
      'custom',
    )
    expect(unavailable(selected('anthropic', { apiKey: '', model: 'claude-sonnet' })).reason).toBe(
      'no-api-key',
    )
  })

  it('matches the suite catalogue and activeProvider it restates', () => {
    expect(catalogueIdsFlagged('needsCliPath')).toEqual([...AI_KEYLESS_PROVIDERS])
    expect(catalogueIdsFlagged('needsBaseUrl')).toEqual([...AI_BASE_URL_PROVIDERS])
    const fallbacks = activeProviderFallbacks()
    expect(fallbacks.length).toBeGreaterThan(0)
    expect([...new Set(fallbacks)]).toEqual([AI_FALLBACK_PROVIDER])
    // The auth table is exactly the catalogue's exceptions, and each entry says
    // what the request path itself reads: the CLI providers are the catalogue's
    // `needsCliPath` ids (registry auth `codex-chatgpt`), the base-URL ones its
    // `needsBaseUrl` ids, the sign-in ones the registry's `gsk-login` adapters.
    expect(registryIdsWithAuth('codex-chatgpt')).toEqual([...AI_KEYLESS_PROVIDERS])
    expect(registryIdsWithAuth('gsk-login')).toEqual([...AI_SIGN_IN_PROVIDERS])
    expect(
      [...AI_KEYLESS_PROVIDERS, ...AI_BASE_URL_PROVIDERS, ...AI_SIGN_IN_PROVIDERS].sort(),
    ).toEqual(Object.keys(AI_PROVIDER_AUTH_KINDS).sort())
    // Every other catalogue provider is a plain api-key provider on both sides.
    const exceptions = new Set(Object.keys(AI_PROVIDER_AUTH_KINDS))
    const apiKeyProviders = registryIdsWithAuth('api-key')
    expect(catalogueIds().length).toBeGreaterThan(exceptions.size)
    for (const id of catalogueIds()) {
      if (exceptions.has(id)) continue
      expect(AI_PROVIDER_AUTH_KINDS[id], `${id} is not an exception`).toBeUndefined()
      expect(apiKeyProviders, `${id} authenticates with a key`).toContain(id)
    }
  })
})

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { extractAllPages, loadPdfDocument } from '../src/renderer/src/pdf/extract'
import {
  extractSubmissionLogistics,
  extractTenderMeta,
  shredExtraction,
} from '../src/renderer/src/pdf/shred'
import { parseClosingDate } from '../src/shared/readiness'

/**
 * SYNTHETIC CORPUS HARNESS — Phase 3 (Tenders intake), Wave 1 lane A.
 *
 * This suite runs the REAL parser (`pdf/extract.ts` + `pdf/shred.ts`) over a
 * code-generated, offline corpus and scores it against gold annotations. The
 * fixtures are SYNTHETIC: they are not real tenders and these numbers are not
 * real-world accuracy evidence. They are a deterministic baseline that a
 * parser lane can move.
 *
 * A hard gate enforces the Phase 3 exit criterion `falseReadinessCount === 0`
 * plus quality floors (metadata accuracy, requirement recall, false-positive
 * rate) so a degenerate parser cannot pass trivially. The gate is GREEN; the
 * suite reports the measured baseline and the fixtures are never loosened.
 */

// Resolve the fixture directory without machine-specific absolute paths. Works
// whether Vitest runs from the app workspace (npm test -w) or the repo root.
function resolveCorpusDir(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const fromWorkspace = join(dir, 'tests', 'fixtures', 'tenders-corpus')
    if (existsSync(join(fromWorkspace, 'gold'))) return fromWorkspace
    const fromRepoRoot = join(dir, 'apps', 'tenders', 'tests', 'fixtures', 'tenders-corpus')
    if (existsSync(join(fromRepoRoot, 'gold'))) return fromRepoRoot
    dir = dirname(dir)
  }
  return join(process.cwd(), 'tests', 'fixtures', 'tenders-corpus')
}

const CORPUS_DIR = resolveCorpusDir()
const GOLD_DIR = join(CORPUS_DIR, 'gold')
const METRICS_PATH = join(CORPUS_DIR, 'metrics.json')

function goldPath(id: string): string {
  return join(GOLD_DIR, `${id}.json`)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

interface Gold {
  id: string
  clearable: boolean
  scannedPages: number[]
  pageCount: number
  expectedRequirementKeys: string[]
  mandatoryRequirements: string[]
  disqualifiers: string[]
  closingDateTime: string | null
  unconfirmedFields: string[]
  conflicts: Record<string, boolean>
  sector: string
  issuerType: string
  tags: string[]
  /** The committed PDF hash the fixture is proved reproducible against. */
  pdfSha256: string
  [key: string]: unknown
}

// ── the fixture tooling, typed at the module boundary ─────────────────────────
//
// `tools/tenders-corpus/*.mjs` is plain ESM tooling with no declaration files, so
// a static import of it is an implicit `any` (TS7016) and every callback over its
// values an implicit-any parameter. These interfaces describe exactly what this
// harness reads, and the modules are loaded through `createRequire` — a call whose
// argument is a path string, so the modules are TYPED at the boundary rather than
// suppressed. A rename or a shape change in the tooling now fails this file's
// typecheck instead of silently becoming `any`.
//
// (The alternative — a `.d.mts` beside each tool — is the better home for these
// types, but those files are outside this test's ownership.)

/** One synthetic fixture from `tools/tenders-corpus/corpus.mjs`. */
interface CorpusFixture {
  gold: Gold
  pages: unknown[]
}

/** The metric report `tools/tenders-corpus/metrics.mjs#computeMetrics` returns. */
interface MetricsReport {
  corpusKind: string
  fixtureCount: number
  metrics: {
    criticalMetadataAccuracy: {
      overall: number | null
      perField: Record<string, { correct: number; total: number }>
    }
    criticalRequirementRecall: {
      overall: number | null
      mandatory: number | null
      disqualifiers: number | null
      expected: number
      found: number
      missed: string[]
    }
    falsePositiveRate: {
      overall: number | null
      falsePositives: number
      extracted: number
      detail: string[]
    }
    conflictDetectionAccuracy: { overall: number | null; correct: number; total: number }
    unconfirmedClassificationAccuracy: { overall: number | null; correct: number; total: number }
    nativeVsScannedPageAccuracy: { overall: number | null; correct: number; total: number }
    pricingRequirementRecall: {
      overall: number | null
      expected: number
      detected: number
      note: string
    }
    falseReadinessCount: { count: number; target: number; fixtures: string[] }
  }
  fixtures: Array<{ id: string }>
}

const requireTool = createRequire(import.meta.url)

const generateTools = requireTool('../../../tools/tenders-corpus/generate.mjs') as {
  buildFixturePdf(fixture: CorpusFixture): Promise<Uint8Array>
}

const corpusTools = requireTool('../../../tools/tenders-corpus/corpus.mjs') as {
  CORPUS: CorpusFixture[]
}

const metricsTools = requireTool('../../../tools/tenders-corpus/metrics.mjs') as {
  CRITICAL_FIELDS: string[]
  /** `records` is the array this harness builds below (`Record_`). */
  computeMetrics(records: readonly Record_[]): MetricsReport
}

const { buildFixturePdf } = generateTools
const { CORPUS } = corpusTools
const { CRITICAL_FIELDS, computeMetrics } = metricsTools

interface Record_ {
  gold: Gold
  goldClosingInstant: string | null
  actual: {
    title: string | null
    fallbackTitleUsed: boolean
    referenceNumber: string | null
    issuingBody: string | null
    closingDateTime: string | null
    closingInstant: string | null
    submissionMethod: string | null
    submissionDestination: string | null
    requirementKeys: string[]
    conflictedFields: string[]
    parserConflictNotes: string[]
    perPageNeedsOcr: boolean[]
    textPages: number
    ocrPages: number
  }
}

function round(value: number | null): string {
  if (value === null) return 'n/a'
  return `${(value * 100).toFixed(1)}%`
}

describe('Tenders synthetic intake corpus harness', () => {
  it('inventory: fixtures cover the required matrix and gold is present + stable', async () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(25)
    expect(CORPUS.length).toBeLessThanOrEqual(40)

    const sectors = new Set(CORPUS.map((fixture) => fixture.gold.sector))
    expect(sectors).toEqual(
      new Set(['office-equipment', 'construction-civil', 'professional-services']),
    )

    const issuerTypes = new Set(CORPUS.map((fixture) => fixture.gold.issuerType))
    expect(issuerTypes.has('municipal')).toBe(true)
    expect(issuerTypes.has('government')).toBe(true)

    const tags = CORPUS.flatMap((fixture) => fixture.gold.tags)
    const count = (tag: string) => tags.filter((entry) => entry === tag).length
    expect(count('scanned-only')).toBeGreaterThanOrEqual(3)
    expect(count('mixed')).toBeGreaterThanOrEqual(3)
    expect(count('timezone')).toBeGreaterThanOrEqual(2)
    expect(count('ocr-variants')).toBeGreaterThanOrEqual(2)
    const conflictTagged = tags.filter((tag) =>
      ['conflict', 'amended-deadline', 'conflicting-destination'].includes(tag),
    ).length
    expect(conflictTagged).toBeGreaterThanOrEqual(3)
    const layoutTagged = tags.filter((tag) => ['two-column', 'table'].includes(tag)).length
    expect(layoutTagged).toBeGreaterThanOrEqual(6)
    const pricingTagged = tags.filter((tag) => ['pricing-schedule', 'boq'].includes(tag)).length
    expect(pricingTagged).toBeGreaterThanOrEqual(6)
    expect(tags).toContain('annexures')
    expect(tags).toContain('forms')

    const ids = new Set<string>()
    for (const fixture of CORPUS) {
      const id = fixture.gold.id
      expect(ids.has(id), `duplicate fixture id ${id}`).toBe(false)
      ids.add(id)

      const bytes = await buildFixturePdf(fixture)
      const hash = sha256(bytes)
      const gold = JSON.parse(readFileSync(goldPath(id), 'utf8')) as Gold
      expect(gold.id).toBe(id)

      // Determinism: the generated bytes hash must match the committed gold
      // annotation produced by `tools/tenders-corpus/generate-fixtures.mjs`.
      expect(hash, `fixture ${id} is not reproducible from the generator`).toBe(gold.pdfSha256)
      expect(fixture.pages.length).toBe(gold.pageCount)

      // Build twice — byte-for-byte reproducible within a run.
      const bytesAgain = await buildFixturePdf(fixture)
      expect(sha256(bytesAgain)).toBe(hash)
    }
  })

  let report: MetricsReport

  // Budget, not an assertion: this hook builds every corpus fixture and runs the
  // real parser over all of them, measured at ~7.8 s standalone (the whole file
  // is 9 707 ms) against vitest's 10 s default `hookTimeout` — 1.3× headroom,
  // which the full parallel suite consumes (observed in-suite: "Hook timed out in
  // 10000ms" while the file is green alone). 120 000 ms is ~15× the measured
  // cost, so a genuinely hung parser still fails. No assertion is changed.
  beforeAll(async () => {
    const records: Record_[] = []

    for (const fixture of CORPUS) {
      const id = fixture.gold.id
      const gold = JSON.parse(readFileSync(goldPath(id), 'utf8')) as Gold
      const bytes = await buildFixturePdf(fixture)

      const doc = await loadPdfDocument(toArrayBuffer(bytes))
      const extraction = await extractAllPages(doc)

      const meta = extractTenderMeta(extraction, '')
      const logistics = extractSubmissionLogistics(extraction)
      const requirements = shredExtraction(extraction)

      const closingInstant = meta.closingDate
        ? (parseClosingDate(meta.closingDate)?.toISOString() ?? null)
        : null

      // Competing candidates the parser surfaced (requires user confirmation).
      const candidates = (meta as any).candidates ?? {}
      const conflictedFields: string[] = []
      if ((candidates.referenceNumber?.length ?? 0) > 1) conflictedFields.push('referenceNumber')
      if ((candidates.issuingBody?.length ?? 0) > 1) conflictedFields.push('issuingBody')
      if ((candidates.closingDate?.length ?? 0) > 1) conflictedFields.push('closingDateTime')
      if ((candidates.submissionMethod?.length ?? 0) > 1) conflictedFields.push('submissionMethod')
      if ((candidates.submissionAddress?.length ?? 0) > 1)
        conflictedFields.push('submissionDestination')

      records.push({
        gold,
        goldClosingInstant: gold.closingDateTime
          ? (parseClosingDate(gold.closingDateTime)?.toISOString() ?? null)
          : null,
        actual: {
          title: meta.title || null,
          fallbackTitleUsed: meta.title === '',
          referenceNumber: meta.referenceNumber,
          issuingBody: meta.issuingBody,
          closingDateTime: meta.closingDate,
          closingInstant,
          submissionMethod: meta.submissionMethod,
          submissionDestination: meta.submissionAddress ?? logistics.submissionAddress,
          requirementKeys: requirements.map((requirement) => requirement.ruleKey),
          conflictedFields,
          parserConflictNotes: (meta as any).conflicts ?? [],
          perPageNeedsOcr: extraction.pages.map((page) => page.needsOcr),
          textPages: extraction.textPages,
          ocrPages: extraction.ocrPages,
        },
      })
    }

    report = computeMetrics(records)

    // The machine-readable report is written ONLY when explicitly requested
    // (`TENDERS_UPDATE_CORPUS_METRICS=1`): a test must not rewrite a tracked
    // fixture file as a side effect. The console report below always prints.
    if (process.env.TENDERS_UPDATE_CORPUS_METRICS === '1') {
      mkdirSync(CORPUS_DIR, { recursive: true })
      const prettierModule = await import('prettier')
      const prettierApi = prettierModule.default ?? prettierModule
      const prettierOptions = (await prettierApi.resolveConfig(METRICS_PATH)) ?? {}
      writeFileSync(
        METRICS_PATH,
        await prettierApi.format(JSON.stringify(report), {
          ...prettierOptions,
          filepath: METRICS_PATH,
        }),
        'utf8',
      )
    }

    const { metrics } = report
    const lines = [
      '',
      'SYNTHETIC CORPUS BASELINE (not real-world accuracy evidence)',
      `fixtures: ${report.fixtureCount}`,
      `critical-metadata accuracy:        ${round(metrics.criticalMetadataAccuracy.overall)}`,
      `  per field: ${CRITICAL_FIELDS.map(
        (field) =>
          `${field}=${round(metrics.criticalMetadataAccuracy.perField[field].correct / Math.max(1, metrics.criticalMetadataAccuracy.perField[field].total))}`,
      ).join(' ')}`,
      `critical-requirement recall:       ${round(metrics.criticalRequirementRecall.overall)} (mandatory ${round(metrics.criticalRequirementRecall.mandatory)}, disqualifiers ${round(metrics.criticalRequirementRecall.disqualifiers)})`,
      `false-positive rate:               ${round(metrics.falsePositiveRate.overall)} (${metrics.falsePositiveRate.falsePositives}/${metrics.falsePositiveRate.extracted})`,
      `conflict-detection accuracy:       ${round(metrics.conflictDetectionAccuracy.overall)} (${metrics.conflictDetectionAccuracy.correct}/${metrics.conflictDetectionAccuracy.total})`,
      `unconfirmed classification:        ${round(metrics.unconfirmedClassificationAccuracy.overall)} (${metrics.unconfirmedClassificationAccuracy.correct}/${metrics.unconfirmedClassificationAccuracy.total})`,
      `native-vs-scanned page accuracy:   ${round(metrics.nativeVsScannedPageAccuracy.overall)} (${metrics.nativeVsScannedPageAccuracy.correct}/${metrics.nativeVsScannedPageAccuracy.total})`,
      `pricing/BOQ requirement recall:    ${round(metrics.pricingRequirementRecall.overall)} (${metrics.pricingRequirementRecall.detected}/${metrics.pricingRequirementRecall.expected})`,
      `FALSE READINESS COUNT:             ${metrics.falseReadinessCount.count} (target ${metrics.falseReadinessCount.target})`,
      `  false-readiness fixtures: ${metrics.falseReadinessCount.fixtures.join(', ') || '(none)'}`,
      '',
    ]
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))
  }, 120_000)

  it('metrics: computes a well-formed, machine-readable report from the real parser', () => {
    const { metrics } = report
    const overallMetadata = Object.values(metrics.criticalMetadataAccuracy.perField).reduce(
      (sum: number, entry: any) => sum + entry.total,
      0,
    )
    expect(overallMetadata).toBe(report.fixtureCount * CRITICAL_FIELDS.length)
    expect(metrics.nativeVsScannedPageAccuracy.total).toBeGreaterThan(0)
    expect(report.fixtures).toHaveLength(report.fixtureCount)
  })

  it('Phase 3 exit criterion: false-readiness is 0 and the parse is not degenerate', () => {
    // GREEN gate. The false-readiness assertion alone could be satisfied by a
    // parser that returns nothing, so it is paired with quality floors. These
    // thresholds are far below the measured corpus values and are NOT a fixture
    // loosening; the corpus is never edited to make this pass.
    expect(report.metrics.falseReadinessCount.count, 'false-readiness count must be 0').toBe(0)
    expect(
      report.metrics.criticalMetadataAccuracy.overall,
      'critical-metadata accuracy floor',
    ).toBeGreaterThanOrEqual(0.9)
    expect(
      report.metrics.criticalRequirementRecall.overall,
      'critical-requirement recall floor',
    ).toBeGreaterThanOrEqual(0.9)
    expect(
      report.metrics.falsePositiveRate.overall,
      'false-positive rate ceiling',
    ).toBeLessThanOrEqual(0.05)
  })
})

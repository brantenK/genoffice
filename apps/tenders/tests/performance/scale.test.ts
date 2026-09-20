/**
 * WP-15 scale path: import preflight, cancellation, canvas virtualisation and
 * vault-keyword indexing.
 *
 * The FAST tests below run with the normal suite. The measured benchmarks are
 * gated behind `TENDERS_BENCH=1` so `npm test` stays fast; run them with:
 *
 *   $env:TENDERS_BENCH='1'; npm test -w @genoffice/tenders -- tests/performance/scale.test.ts
 *   (optional) $env:TENDERS_BENCH_PAGES='500' to choose the native-page count.
 *
 * Benchmarks are deterministic and offline: the PDF is generated in-process with
 * pdf-lib (fixed dates), the vault/requirement matrices are synthetic and
 * seeded, and no network or wall-clock-dependent parsing is involved.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cpus, totalmem } from 'node:os'
import { deflateSync } from 'node:zlib'
import { applyGapToRequirementsIndexed, buildVaultKeywordIndex } from '../../src/renderer/src/store'
import { applyGapToRequirements } from '../../src/renderer/src/gap'
import { PAGE_OVERSCAN, pageWindow } from '../../src/renderer/src/components/PdfViewer'
import {
  assertPdfBytesWithinLimit,
  assertPdfPagesWithinLimit,
  extractAllPages,
  formatBytes,
  loadPdfDocument,
  PDF_PREFLIGHT_LIMITS,
  PdfImportCancelledError,
  PdfPreflightError,
} from '../../src/renderer/src/pdf/extract'
import { TENDER_RULES } from '../../src/shared/rules'
import type { DocCategory, RequirementRecord, VaultDoc } from '../../src/shared/types'

const RUN_BENCH = Boolean(process.env.TENDERS_BENCH)

// ── import preflight ──────────────────────────────────────────────────────────

describe('import preflight limits', () => {
  it('rejects a file above the byte limit before it is read', () => {
    let caught: unknown
    try {
      assertPdfBytesWithinLimit(PDF_PREFLIGHT_LIMITS.maxBytes + 1)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PdfPreflightError)
    const err = caught as PdfPreflightError
    expect(err.code).toBe('FILE_TOO_LARGE')
    expect(err.actual).toBe(PDF_PREFLIGHT_LIMITS.maxBytes + 1)
    expect(err.limit).toBe(PDF_PREFLIGHT_LIMITS.maxBytes)
    expect(err.message).toMatch(/limit/i)
  })

  it('accepts a file exactly at the byte limit', () => {
    expect(() => assertPdfBytesWithinLimit(PDF_PREFLIGHT_LIMITS.maxBytes)).not.toThrow()
  })

  it('rejects a document above the page limit before any page is read', () => {
    let caught: unknown
    try {
      assertPdfPagesWithinLimit(PDF_PREFLIGHT_LIMITS.maxPages + 1)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PdfPreflightError)
    const err = caught as PdfPreflightError
    expect(err.code).toBe('TOO_MANY_PAGES')
    expect(err.message).toMatch(/pages per document/i)
  })

  it('accepts a document exactly at the page limit', () => {
    expect(() => assertPdfPagesWithinLimit(PDF_PREFLIGHT_LIMITS.maxPages)).not.toThrow()
  })

  it('formats limits so the UI can publish them', () => {
    expect(formatBytes(100 * 1024 * 1024)).toBe('100.0 MB')
    expect(formatBytes(512)).toBe('512 B')
    expect(PDF_PREFLIGHT_LIMITS.maxPages).toBeGreaterThan(0)
  })
})

// ── cancellation ──────────────────────────────────────────────────────────────

interface FakePage {
  pageNumber: number
  getViewport: (opts: { scale: number }) => {
    width: number
    height: number
    transform: number[]
  }
  getTextContent: () => Promise<{ items: unknown[] }>
  cleanup: () => void
}

function fakePage(pageNumber: number): FakePage {
  return {
    pageNumber,
    getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] }),
    getTextContent: async () => ({ items: [] }),
    cleanup: () => {},
  }
}

function fakeDoc(numPages: number): {
  numPages: number
  getPage: (n: number) => Promise<FakePage>
} {
  return { numPages, getPage: async (n) => fakePage(n) }
}

describe('import cancellation', () => {
  it('aborts promptly, reads no further pages, and returns no partial result', async () => {
    const controller = new AbortController()
    const progress: number[] = []
    const promise = extractAllPages(
      fakeDoc(100) as never,
      (page) => {
        progress.push(page)
        if (page === 3) controller.abort()
      },
      { signal: controller.signal },
    )

    await expect(promise).rejects.toBeInstanceOf(PdfImportCancelledError)
    // Pages 1-3 completed (the abort happened during page 3's progress event);
    // page 4 was never read.
    expect(progress).toEqual([1, 2, 3])
  })

  it('aborting before the first page reads nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    let reads = 0
    const doc = {
      numPages: 5,
      getPage: async (n: number) => {
        reads += 1
        return fakePage(n)
      },
    }

    await expect(
      extractAllPages(doc as never, undefined, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(PdfImportCancelledError)
    expect(reads).toBe(0)
  })

  it('completes normally without a signal', async () => {
    const result = await extractAllPages(fakeDoc(4) as never)
    expect(result.numPages).toBe(4)
    expect(result.pages).toHaveLength(4)
  })
})

// ── canvas virtualisation ─────────────────────────────────────────────────────

describe('pdf canvas virtualisation window', () => {
  it('bounds retained canvases regardless of document size', () => {
    const window = pageWindow(250, 500)
    expect(window.from).toBe(250 - PAGE_OVERSCAN)
    expect(window.to).toBe(250 + PAGE_OVERSCAN)
    expect(window.to - window.from + 1).toBe(2 * PAGE_OVERSCAN + 1)
  })

  it('clamps at both document edges', () => {
    expect(pageWindow(1, 500).from).toBe(1)
    expect(pageWindow(2, 500).from).toBe(1)
    expect(pageWindow(500, 500).to).toBe(500)
    expect(pageWindow(499, 500).to).toBe(500)
  })

  it('renders nothing for an empty document', () => {
    expect(pageWindow(1, 0)).toEqual({ from: 0, to: -1 })
  })
})

// ── vault keyword indexing ────────────────────────────────────────────────────

const VAULT_KEYWORDS = [
  'tax',
  'coida',
  'bbbee',
  'cipc',
  'director',
  'csd',
  'vat',
  'sbd',
  'experience',
  'cv',
  'methodology',
  'financial',
  'turnover',
  'guarantee',
  'preferential',
  'subcontract',
  'joint venture',
  'declaration',
  'closing',
  'contact',
  'pricing',
  'bill of quantities',
  'audit',
  'police',
  'id copy',
  'passport',
  'registration',
]

function syntheticVault(count: number): VaultDoc[] {
  const categories: DocCategory[] = ['COMPLIANCE', 'FINANCIAL', 'TECHNICAL', 'GOVERNANCE', 'CV']
  return Array.from({ length: count }, (_, index) => ({
    id: `vd-${index}`,
    title:
      index % 3 === 0
        ? `${VAULT_KEYWORDS[index % VAULT_KEYWORDS.length]} document ${index}`
        : `Generic document ${index}`,
    category: categories[index % categories.length],
    fileUrl: `vault/${index}.pdf`,
    issueDate: null,
    expiryDate: index % 5 === 0 ? '2025-01-01' : '2027-01-01',
    isCertified: index % 2 === 0,
    certifiedDate: index % 2 === 0 ? '2026-06-01' : null,
    metadata: {},
  }))
}

function syntheticRequirements(extra = 0): RequirementRecord[] {
  const reqs: RequirementRecord[] = TENDER_RULES.map((rule, index) => ({
    id: `req-${rule.key}`,
    ruleKey: rule.key,
    title: rule.title,
    category: rule.category,
    isMandatory: true,
    verbatimClause: `Bidders must submit ${rule.title}.`,
    pageNumber: 1,
    boundingBox: { top: 0.1, left: 0.1, width: 0.2, height: 0.05 },
    riskLevel: rule.riskLevel,
    order: rule.order + index,
    status: 'OUTSTANDING',
    linkedVaultDocId: null,
    reason: null,
    suggestedVaultDocIds: [],
  }))
  for (let i = 0; i < extra; i += 1) {
    // Keep a real catalogue ruleKey so the full-vault scan path is actually
    // exercised (a non-catalogue key would skip the per-requirement scan).
    reqs.push({ ...reqs[i % reqs.length], id: `req-extra-${i}` })
  }
  return reqs
}

describe('vault keyword indexing', () => {
  it('is exactly equivalent to the full-vault scan across the whole catalogue', () => {
    const vault = syntheticVault(200)
    const reqs = syntheticRequirements(3)
    const now = new Date('2026-09-01T00:00:00Z')

    const baseline = applyGapToRequirements(reqs, vault, now)
    const indexed = applyGapToRequirementsIndexed(reqs, buildVaultKeywordIndex(vault), now)

    expect(indexed).toEqual(baseline)
  })

  it('returns the same result for an empty vault', () => {
    const reqs = syntheticRequirements()
    const now = new Date('2026-09-01T00:00:00Z')
    expect(applyGapToRequirementsIndexed(reqs, buildVaultKeywordIndex([]), now)).toEqual(
      applyGapToRequirements(reqs, [], now),
    )
  })

  it('only returns documents carrying a rule hint keyword, in vault order', () => {
    const vault = syntheticVault(60)
    const index = buildVaultKeywordIndex(vault)
    const candidates = index.candidatesFor('tax_pin')
    const ids = candidates.map((doc) => doc.id)
    const expectedIds = vault
      .filter((doc) => /tax|tcs|sars|pin/i.test(doc.title))
      .map((doc) => doc.id)
    expect(ids).toEqual(expectedIds)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ── measured benchmarks (gated) ───────────────────────────────────────────────
//
// The benchmarks write `tests/performance/results.json` (override with
// `TENDERS_BENCH_OUT`) so a release gate can consume measured numbers plus the
// machine/environment they were measured on. Run via `node tools/tenders-bench.mjs`
// or directly with `TENDERS_BENCH=1` in the app workspace.

interface MemorySample {
  tMs: number
  heapUsedMB: number
  rssMB: number
  externalMB: number
  arrayBuffersMB: number
}

interface MemoryTraceSummary {
  samples: MemorySample[]
  sampleCount: number
  peakHeapUsedMB: number
  peakRssMB: number
  heapDeltaMB: number
  rssDeltaMB: number
}

function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100
}

function sampleMemory(): Omit<MemorySample, 'tMs'> {
  const memory = process.memoryUsage()
  return {
    heapUsedMB: toMb(memory.heapUsed),
    rssMB: toMb(memory.rss),
    externalMB: toMb(memory.external),
    arrayBuffersMB: toMb(memory.arrayBuffers),
  }
}

/**
 * Run `work` while sampling process memory, so the published envelope is a
 * trajectory (allocations, peaks, settling) rather than a single delta.
 */
async function traceMemory<T>(
  work: () => Promise<T>,
  intervalMs = 20,
): Promise<{ result: T; memory: MemoryTraceSummary }> {
  const started = Date.now()
  const samples: MemorySample[] = []
  const take = (): void => {
    samples.push({ tMs: Date.now() - started, ...sampleMemory() })
  }
  take()
  const timer = setInterval(take, intervalMs)
  try {
    const result = await work()
    take()
    const peakHeapUsedMB = Math.max(...samples.map((sample) => sample.heapUsedMB))
    const peakRssMB = Math.max(...samples.map((sample) => sample.rssMB))
    return {
      result,
      memory: {
        samples,
        sampleCount: samples.length,
        peakHeapUsedMB,
        peakRssMB,
        heapDeltaMB:
          Math.round((samples[samples.length - 1].heapUsedMB - samples[0].heapUsedMB) * 100) / 100,
        rssDeltaMB: Math.round((samples[samples.length - 1].rssMB - samples[0].rssMB) * 100) / 100,
      },
    }
  } finally {
    clearInterval(timer)
  }
}

interface TimingStats {
  runs: number[]
  minMs: number
  medianMs: number
  maxMs: number
}

function timingStats(runs: number[]): TimingStats {
  const sorted = [...runs].sort((a, b) => a - b)
  return {
    runs,
    minMs: sorted[0],
    medianMs: sorted[Math.floor(sorted.length / 2)],
    maxMs: sorted[sorted.length - 1],
  }
}

async function buildNativePdf(pageCount: number, linesPerPage: number): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const fixed = new Date('2026-01-01T00:00:00.000Z')
  doc.setCreationDate(fixed)
  doc.setModificationDate(fixed)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = doc.addPage([595, 842])
    let y = 780
    for (let line = 0; line < linesPerPage; line += 1) {
      const body =
        line % 6 === 5
          ? `Bidders must submit a valid SARS Tax Clearance Certificate or TCS Pin (page ${pageIndex + 1}, line ${line + 1}).`
          : `Synthetic requirement line ${line + 1} for page ${pageIndex + 1}: deliverable and compliance wording.`
      page.drawText(body, { x: 50, y, size: 10, font })
      y -= 18
    }
  }
  return doc.save()
}

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index]
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

/**
 * Deterministic, effectively-incompressible RGB PNG. Large scanned annexures are
 * the realistic reason tender packs approach the byte ceiling; this reproduces
 * their byte weight without adding text items (so bytes and text density can be
 * measured separately).
 */
function noisePng(width: number, height: number, seed: number): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let state = seed >>> 0
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width * 3; x += 1) {
      state ^= state << 13
      state >>>= 0
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      raw[y * (width * 3 + 1) + 1 + x] = state & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  // Return a plain Uint8Array: a Node Buffer from another realm fails
  // pdf-lib's `instanceof Uint8Array` check under the vitest jsdom pool.
  return new Uint8Array(png)
}

/**
 * A near-byte-ceiling document with a realistic composition: one native text
 * cover plus a set of image-only "scanned" pages. Each image is a distinct
 * XObject, so the file size scales with the image count.
 */
async function buildImageHeavyPdf(imageCount: number, imageSize: number): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const fixed = new Date('2026-01-01T00:00:00.000Z')
  doc.setCreationDate(fixed)
  doc.setModificationDate(fixed)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const cover = doc.addPage([595, 842])
  cover.drawText('Scanned tender pack cover', { x: 50, y: 780, size: 14, font })
  cover.drawText('Bidders must submit a valid SARS Tax Clearance Certificate or TCS PIN.', {
    x: 50,
    y: 750,
    size: 11,
    font,
  })
  for (let index = 0; index < imageCount; index += 1) {
    const image = await doc.embedPng(noisePng(imageSize, imageSize, 1000 + index))
    const page = doc.addPage([595, 842])
    page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 })
  }
  return doc.save()
}

function parseCountList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback
  const values = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  return values.length > 0 ? values : fallback
}

function parsePageList(raw: string | undefined): number[] {
  return parseCountList(raw, [250, 500, 1000])
}

function readPdfjsVersion(): string {
  try {
    const pkgPath = join(process.cwd(), '..', '..', 'node_modules', 'pdfjs-dist', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

const BENCH_RUNS = Math.max(1, Number(process.env.TENDERS_BENCH_RUNS ?? 3))
const BENCH_OUT = process.env.TENDERS_BENCH_OUT
  ? process.env.TENDERS_BENCH_OUT
  : join(process.cwd(), 'tests', 'performance', 'results.json')

const benchReport: Record<string, unknown> = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  gate: 'TENDERS_BENCH=1',
  synthetic: true,
  env: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    totalMemGB: Math.round((totalmem() / (1024 * 1024 * 1024)) * 10) / 10,
    pdfjs: readPdfjsVersion(),
    fixture: 'pdf-lib synthetic pages (fixed creation date): native text + image-heavy scanned',
  },
  preflight: { ...PDF_PREFLIGHT_LIMITS },
  runs: BENCH_RUNS,
  measurements: {} as Record<string, unknown>,
  largestPageCountExercised: 0,
  notes: [
    'Parse timings include pdfjs document load + full text/coordinate extraction, not PDF file read.',
    'heapUsed/rss come from process.memoryUsage() sampled during the run; GC timing makes peaks noisy.',
    'The byte ceiling is measured on an image-heavy composition (native text has negligible byte weight but dominates memory).',
    'TEXT DENSITY, not file bytes, drives peak memory: see limitAssessment.textDensity; a line-count guard is recommended alongside the byte guard.',
  ],
}

interface ParsedMeasurement {
  pages: number
  bytes: number
}

interface ByteCeilingMeasurement {
  bytes: number
  bytesLabel: string
  pages: number
  images: number
  parseMs: { medianMs: number; minMs: number; maxMs: number }
  memory: { peakHeapUsedMB: number; peakRssMB: number }
  composition?: string
}

interface ByteStressMeasurement {
  bytes: number
  lines: number
  memory: { peakHeapUsedMB: number; peakRssMB: number }
}

/** Derive the measured envelope + a plain verdict against the published limits. */
function summarizeEnvelope(): void {
  const measurements = benchReport.measurements as Record<string, unknown>
  const byteCeiling = measurements.byteCeiling as ByteCeilingMeasurement | undefined
  const byteStress = measurements.byteStress as ByteStressMeasurement | undefined
  const parsed: ParsedMeasurement[] = [
    ...((measurements.nativeParseSweep as ParsedMeasurement[] | undefined) ?? []),
    ...(byteStress ? [byteStress] : []),
    ...(byteCeiling ? [byteCeiling] : []),
  ]
  const largestPageCountParsed = parsed.reduce((max, entry) => Math.max(max, entry.pages), 0)
  const largestBytesParsed = parsed.reduce((max, entry) => Math.max(max, entry.bytes), 0)
  benchReport.largestPageCountExercised = largestPageCountParsed
  benchReport.largestBytesParsed = largestBytesParsed
  benchReport.largestBytesParsedLabel = formatBytes(largestBytesParsed)

  // Actionable density proxy: peak heap per text line, measured on the
  // text-dense byte-stress point.
  let textDensity: Record<string, unknown> = {
    measured: false,
    note: 'No text-dense document was measured.',
  }
  if (byteStress && byteStress.lines > 0) {
    const peakHeapMbPerLine = byteStress.memory.peakHeapUsedMB / byteStress.lines
    textDensity = {
      measured: true,
      source: 'byteStress',
      bytes: byteStress.bytes,
      bytesLabel: formatBytes(byteStress.bytes),
      lines: byteStress.lines,
      bytesPerLine: Math.round(byteStress.bytes / byteStress.lines),
      peakHeapUsedMB: byteStress.memory.peakHeapUsedMB,
      peakHeapMbPerLine: Math.round(peakHeapMbPerLine * 10000) / 10000,
      // Lines whose projected peak heap would reach ~1 GB on this machine.
      recommendedMaxTextLinesAt1GBHeap: Math.floor(1024 / peakHeapMbPerLine),
      note: 'Peak heap scales with extracted text lines, not file bytes. A line-count guard is recommended alongside the byte guard.',
    }
  }
  benchReport.textDensity = textDensity

  const bytesMeasured = Boolean(byteCeiling) && byteCeiling.bytes > 0
  benchReport.limitAssessment = {
    maxPages: {
      limit: PDF_PREFLIGHT_LIMITS.maxPages,
      largestPageCountParsed,
      // "Met" means the limit itself was exercised: the parser handled at least
      // `limit` pages. The sweep intentionally probes above it for headroom.
      met: largestPageCountParsed >= PDF_PREFLIGHT_LIMITS.maxPages,
      headroomPages: Math.max(0, largestPageCountParsed - PDF_PREFLIGHT_LIMITS.maxPages),
      note:
        largestPageCountParsed >= PDF_PREFLIGHT_LIMITS.maxPages
          ? `Covered: parsed ${largestPageCountParsed} pages, at/above the ${PDF_PREFLIGHT_LIMITS.maxPages}-page limit.`
          : `Not covered: largest parsed document was ${largestPageCountParsed} pages, below the ${PDF_PREFLIGHT_LIMITS.maxPages}-page limit.`,
    },
    maxBytes: {
      limit: PDF_PREFLIGHT_LIMITS.maxBytes,
      limitLabel: formatBytes(PDF_PREFLIGHT_LIMITS.maxBytes),
      largestBytesParsed,
      largestBytesParsedLabel: formatBytes(largestBytesParsed),
      met: bytesMeasured && byteCeiling!.bytes <= PDF_PREFLIGHT_LIMITS.maxBytes,
      parseMeasured: bytesMeasured,
      composition: byteCeiling?.composition,
      measuredPeakRssMB: byteCeiling?.memory.peakRssMB,
      measuredPeakHeapMB: byteCeiling?.memory.peakHeapUsedMB,
      measuredParseMs: byteCeiling?.parseMs.medianMs,
      note: bytesMeasured
        ? `Covered: parsed a ${byteCeiling!.bytesLabel} ${byteCeiling!.composition ?? 'document'} within the ${formatBytes(PDF_PREFLIGHT_LIMITS.maxBytes)} guard. Byte count remains a poor memory proxy for TEXT-DENSE PDFs (see textDensity); the byte guard and a line-count guard are complementary.`
        : 'No PDF near the byte ceiling was parsed. The limit is verified as a pre-read guard only.',
    },
  }
}

async function flushBenchReport(): Promise<void> {
  try {
    summarizeEnvelope()
    mkdirSync(dirname(BENCH_OUT), { recursive: true })
    let serialized = `${JSON.stringify(benchReport, null, 2)}\n`
    try {
      const prettierModule = (await import('prettier')) as unknown as {
        format?: (source: string, options: Record<string, unknown>) => Promise<string>
        resolveConfig?: (path: string) => Promise<Record<string, unknown> | null>
        default?: {
          format: (source: string, options: Record<string, unknown>) => Promise<string>
          resolveConfig: (path: string) => Promise<Record<string, unknown> | null>
        }
      }
      const prettier = prettierModule.default ?? prettierModule
      if (prettier.resolveConfig && prettier.format) {
        const options = (await prettier.resolveConfig(BENCH_OUT)) ?? {}
        serialized = await prettier.format(JSON.stringify(benchReport), {
          ...options,
          filepath: BENCH_OUT,
        })
      }
    } catch {
      // Prettier is best-effort here; the raw JSON is still machine-readable.
    }
    writeFileSync(BENCH_OUT, serialized, 'utf8')
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.error('[bench] failed to write results file', error)
  }
}

describe.skipIf(!RUN_BENCH)('measured scale benchmarks (TENDERS_BENCH=1)', () => {
  afterAll(async () => {
    await flushBenchReport()
  })

  it('sweeps native page counts and traces memory across a full parse', async () => {
    const pageCounts = parsePageList(process.env.TENDERS_BENCH_PAGES)
    const linesPerPage = Number(process.env.TENDERS_BENCH_LINES ?? 20)
    const sweep: unknown[] = []

    for (const pages of pageCounts) {
      const buildStarted = Date.now()
      const bytes = await buildNativePdf(pages, linesPerPage)
      const buildMs = Date.now() - buildStarted
      const runTimings: number[] = []
      const traces: MemoryTraceSummary[] = []
      let lines = 0
      let textPages = 0
      let ocrPages = 0

      // Warm-up parse (discarded): pdfjs module init and JIT otherwise skew the
      // first measured run and inflate the reported variance.
      const warmupStarted = Date.now()
      await traceMemory(async () => {
        const warm = bytes.slice(0)
        const doc = await loadPdfDocument(
          warm.buffer.slice(warm.byteOffset, warm.byteOffset + warm.byteLength) as ArrayBuffer,
        )
        return extractAllPages(doc)
      })
      const warmupMs = Date.now() - warmupStarted

      for (let run = 0; run < BENCH_RUNS; run += 1) {
        const copy = bytes.slice(0)
        const started = Date.now()
        const { result: extraction, memory } = await traceMemory(async () => {
          const doc = await loadPdfDocument(
            copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
          )
          expect(doc.numPages).toBe(pages)
          return extractAllPages(doc)
        })
        runTimings.push(Date.now() - started)
        traces.push(memory)
        lines = extraction.pages.reduce((total, page) => total + page.lines.length, 0)
        textPages = extraction.textPages
        ocrPages = extraction.ocrPages
      }

      const stats = timingStats(runTimings)
      const worstTrace = traces.reduce((a, b) => (b.peakHeapUsedMB > a.peakHeapUsedMB ? b : a))
      sweep.push({
        pages,
        linesPerPage,
        bytes: bytes.byteLength,
        bytesLabel: formatBytes(bytes.byteLength),
        buildMs,
        warmupMs,
        parseMs: stats,
        lines,
        textPages,
        ocrPages,
        memory: {
          peakHeapUsedMB: worstTrace.peakHeapUsedMB,
          peakRssMB: worstTrace.peakRssMB,
          heapDeltaMB: worstTrace.heapDeltaMB,
          rssDeltaMB: worstTrace.rssDeltaMB,
          sampleCount: worstTrace.sampleCount,
          trace: worstTrace.samples,
        },
      })
      benchReport.largestPageCountExercised = Math.max(
        Number(benchReport.largestPageCountExercised),
        pages,
      )
      // eslint-disable-next-line no-console
      console.log(
        `[bench] native pages=${pages} bytes=${formatBytes(bytes.byteLength)} ` +
          `parseMs=${stats.medianMs} (min ${stats.minMs} / max ${stats.maxMs}) ` +
          `peakHeap=${worstTrace.peakHeapUsedMB}MB peakRss=${worstTrace.peakRssMB}MB lines=${lines}`,
      )
      await flushBenchReport()
    }

    ;(benchReport.measurements as Record<string, unknown>).nativeParseSweep = sweep
    expect(sweep.length).toBe(pageCounts.length)
    for (const entry of sweep as Array<{ parseMs: TimingStats }>) {
      // Generous ceiling: a normal native parse must stay well within a minute.
      expect(entry.parseMs.maxMs).toBeLessThan(60_000)
    }
  }, 300_000)

  it('measures a byte-stressed native document (multi-MB, not 100 MB)', async () => {
    const stressPages = Number(process.env.TENDERS_BENCH_STRESS_PAGES ?? 500)
    const stressLines = Number(process.env.TENDERS_BENCH_STRESS_LINES ?? 500)
    const buildStarted = Date.now()
    const bytes = await buildNativePdf(stressPages, stressLines)
    const buildMs = Date.now() - buildStarted

    const warmupStarted = Date.now()
    await traceMemory(async () => {
      const warm = bytes.slice(0)
      const doc = await loadPdfDocument(
        warm.buffer.slice(warm.byteOffset, warm.byteOffset + warm.byteLength) as ArrayBuffer,
      )
      return extractAllPages(doc)
    })
    const warmupMs = Date.now() - warmupStarted

    const runTimings: number[] = []
    const traces: MemoryTraceSummary[] = []
    let lines = 0
    for (let run = 0; run < BENCH_RUNS; run += 1) {
      const copy = bytes.slice(0)
      const started = Date.now()
      const { result: extraction, memory } = await traceMemory(async () => {
        const doc = await loadPdfDocument(
          copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
        )
        expect(doc.numPages).toBe(stressPages)
        return extractAllPages(doc)
      })
      runTimings.push(Date.now() - started)
      traces.push(memory)
      lines = extraction.pages.reduce((total, page) => total + page.lines.length, 0)
    }
    const worstTrace = traces.reduce((a, b) => (b.peakHeapUsedMB > a.peakHeapUsedMB ? b : a))
    const stats = timingStats(runTimings)
    const entry = {
      pages: stressPages,
      linesPerPage: stressLines,
      bytes: bytes.byteLength,
      bytesLabel: formatBytes(bytes.byteLength),
      buildMs,
      warmupMs,
      parseMs: stats,
      lines,
      bytesPerLine: lines > 0 ? Math.round(bytes.byteLength / lines) : null,
      memory: {
        peakHeapUsedMB: worstTrace.peakHeapUsedMB,
        peakRssMB: worstTrace.peakRssMB,
        heapDeltaMB: worstTrace.heapDeltaMB,
        rssDeltaMB: worstTrace.rssDeltaMB,
        sampleCount: worstTrace.sampleCount,
        trace: worstTrace.samples,
      },
      note: 'Text-dense byte-stress point: shows peak heap scales with text lines, not bytes.',
    }
    ;(benchReport.measurements as Record<string, unknown>).byteStress = entry
    // eslint-disable-next-line no-console
    console.log(
      `[bench] byte-stress pages=${stressPages} bytes=${formatBytes(bytes.byteLength)} ` +
        `parseMs=${stats.medianMs} (min ${stats.minMs} / max ${stats.maxMs}) ` +
        `peakHeap=${worstTrace.peakHeapUsedMB}MB peakRss=${worstTrace.peakRssMB}MB`,
    )
    await flushBenchReport()
    expect(stats.maxMs).toBeLessThan(60_000)
  }, 300_000)

  it('measures parsing a near-byte-ceiling image-heavy document', async () => {
    const targetMb = Number(process.env.TENDERS_BENCH_BYTES_MB ?? 96)
    const imageBytesMb = Number(process.env.TENDERS_BENCH_IMAGE_MB ?? 12)
    const imageCount = Math.max(1, Math.round(targetMb / imageBytesMb))

    const buildStarted = Date.now()
    const bytes = await buildImageHeavyPdf(imageCount, 2000)
    const buildMs = Date.now() - buildStarted

    // This must be a legitimate in-limit document: it passes its own preflight.
    expect(bytes.byteLength).toBeLessThanOrEqual(PDF_PREFLIGHT_LIMITS.maxBytes)
    expect(() => assertPdfBytesWithinLimit(bytes.byteLength)).not.toThrow()

    const warmupStarted = Date.now()
    await traceMemory(async () => {
      const warm = bytes.slice(0)
      const doc = await loadPdfDocument(
        warm.buffer.slice(warm.byteOffset, warm.byteOffset + warm.byteLength) as ArrayBuffer,
      )
      return extractAllPages(doc)
    })
    const warmupMs = Date.now() - warmupStarted

    const runTimings: number[] = []
    const traces: MemoryTraceSummary[] = []
    let lines = 0
    let pages = 0
    for (let run = 0; run < BENCH_RUNS; run += 1) {
      const copy = bytes.slice(0)
      const started = Date.now()
      const { result: extraction, memory } = await traceMemory(async () => {
        const doc = await loadPdfDocument(
          copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
        )
        return extractAllPages(doc)
      })
      runTimings.push(Date.now() - started)
      traces.push(memory)
      pages = extraction.numPages
      lines = extraction.pages.reduce((total, page) => total + page.lines.length, 0)
    }
    const worstTrace = traces.reduce((a, b) => (b.peakRssMB > a.peakRssMB ? b : a))
    const stats = timingStats(runTimings)
    const entry = {
      images: imageCount,
      pages,
      bytes: bytes.byteLength,
      bytesLabel: formatBytes(bytes.byteLength),
      buildMs,
      warmupMs,
      parseMs: stats,
      lines,
      bytesPerLine: lines > 0 ? Math.round(bytes.byteLength / lines) : null,
      memory: {
        peakHeapUsedMB: worstTrace.peakHeapUsedMB,
        peakRssMB: worstTrace.peakRssMB,
        heapDeltaMB: worstTrace.heapDeltaMB,
        rssDeltaMB: worstTrace.rssDeltaMB,
        sampleCount: worstTrace.sampleCount,
        trace: worstTrace.samples,
      },
      composition: `1 native cover + ${imageCount} image-only scanned pages (distinct noise PNGs)`,
      note: 'Byte ceiling measured on the common image-heavy (scanned) composition: large bytes, few text items.',
    }
    ;(benchReport.measurements as Record<string, unknown>).byteCeiling = entry
    // eslint-disable-next-line no-console
    console.log(
      `[bench] byte-ceiling images=${imageCount} bytes=${formatBytes(bytes.byteLength)} ` +
        `parseMs=${stats.medianMs} (min ${stats.minMs} / max ${stats.maxMs}) ` +
        `peakHeap=${worstTrace.peakHeapUsedMB}MB peakRss=${worstTrace.peakRssMB}MB lines=${lines}`,
    )
    await flushBenchReport()
    expect(stats.maxMs).toBeLessThan(120_000)
    expect(bytes.byteLength).toBeLessThanOrEqual(PDF_PREFLIGHT_LIMITS.maxBytes)
  }, 600_000)

  it('verifies the 100 MB byte guard and measures buffer-hold cost (no full parse)', () => {
    const limit = PDF_PREFLIGHT_LIMITS.maxBytes
    expect(() => assertPdfBytesWithinLimit(limit + 1)).toThrow(PdfPreflightError)
    expect(() => assertPdfBytesWithinLimit(limit)).not.toThrow()

    const before = sampleMemory()
    const allocStarted = Date.now()
    const buffer = Buffer.allocUnsafe(limit)
    // Touch the buffer so the allocation is resident rather than lazily mapped.
    buffer[0] = 1
    buffer[limit - 1] = 1
    const allocMs = Date.now() - allocStarted
    const after = sampleMemory()
    const entry = {
      maxBytes: limit,
      maxBytesLabel: formatBytes(limit),
      allocMs,
      arrayBuffersDeltaMB: Math.round((after.arrayBuffersMB - before.arrayBuffersMB) * 100) / 100,
      rssDeltaMB: Math.round((after.rssMB - before.rssMB) * 100) / 100,
      fullParseMeasured: false,
      parseMeasuredIn: 'byteCeiling',
      note: 'This test verifies the pre-read guard and the 100 MB buffer-hold cost. The near-ceiling full parse is measured separately in `byteCeiling`.',
    }
    ;(benchReport.measurements as Record<string, unknown>).byteGuard = entry
    // eslint-disable-next-line no-console
    console.log(
      `[bench] byte guard max=${formatBytes(limit)} allocMs=${allocMs} ` +
        `arrayBuffersDelta=${entry.arrayBuffersDeltaMB}MB rssDelta=${entry.rssDeltaMB}MB`,
    )
    // Release promptly; the guard itself is the contract under test.
    void buffer
  })

  it('measures canvas-window retention and its memory ceiling', () => {
    const totalPages = Number(process.env.TENDERS_BENCH_CANVAS_PAGES ?? 500)
    const canvasBytes = Number(process.env.TENDERS_BENCH_CANVAS_BYTES ?? 595 * 842 * 4)
    let maxRetained = 0
    for (let position = 1; position <= totalPages; position += 1) {
      const window = pageWindow(position, totalPages)
      maxRetained = Math.max(maxRetained, window.to - window.from + 1)
    }
    const window = pageWindow(Math.floor(totalPages / 2), totalPages)

    const before = sampleMemory()
    const buffers = Array.from({ length: maxRetained }, () => Buffer.allocUnsafe(canvasBytes))
    buffers[0][0] = 1
    const after = sampleMemory()
    const entry = {
      totalPages,
      overscan: PAGE_OVERSCAN,
      maxRetainedCanvases: maxRetained,
      windowAtMidpoint: window,
      canvasBytes,
      windowCanvasMB: toMb(maxRetained * canvasBytes),
      projectedFullDocCanvasMB: toMb(totalPages * canvasBytes),
      measuredWindowAllocDeltaMB:
        Math.round((after.arrayBuffersMB - before.arrayBuffersMB) * 100) / 100,
      savingFactor: Math.round((totalPages / maxRetained) * 100) / 100,
      note: 'Window allocation is measured; the full-document figure is a projection (pages × canvas bytes).',
    }
    ;(benchReport.measurements as Record<string, unknown>).canvasWindow = entry
    // eslint-disable-next-line no-console
    console.log(
      `[bench] canvas window total=${totalPages} retained=${maxRetained} ` +
        `windowMB=${entry.windowCanvasMB} projectedFullMB=${entry.projectedFullDocCanvasMB} ` +
        `saving=${entry.savingFactor}x`,
    )
    expect(maxRetained).toBe(2 * PAGE_OVERSCAN + 1)
  })

  it('measures the vault-index saving across requirement counts', async () => {
    const vaultSize = Number(process.env.TENDERS_BENCH_VAULT ?? 10000)
    const requirementCounts = parseCountList(process.env.TENDERS_BENCH_REQS, [2000, 5000])
    const vault = syntheticVault(vaultSize)
    const now = new Date('2026-09-01T00:00:00Z')
    const sweep: unknown[] = []

    for (const requirementCount of requirementCounts) {
      const reqs = syntheticRequirements(requirementCount)

      // Warm-up (discarded) so the first measured run is not JIT-bound.
      applyGapToRequirements(reqs, vault, now)
      applyGapToRequirementsIndexed(reqs, buildVaultKeywordIndex(vault), now)

      const baselineRuns: number[] = []
      const indexBuildRuns: number[] = []
      const indexedRuns: number[] = []
      for (let run = 0; run < BENCH_RUNS; run += 1) {
        let started = Date.now()
        applyGapToRequirements(reqs, vault, now)
        baselineRuns.push(Date.now() - started)
        started = Date.now()
        const index = buildVaultKeywordIndex(vault)
        indexBuildRuns.push(Date.now() - started)
        started = Date.now()
        applyGapToRequirementsIndexed(reqs, index, now)
        indexedRuns.push(Date.now() - started)
      }

      const baseline = timingStats(baselineRuns)
      const indexBuild = timingStats(indexBuildRuns)
      const indexed = timingStats(indexedRuns)
      const entry = {
        vaultSize,
        requirementCount,
        baselineMs: baseline,
        indexBuildMs: indexBuild,
        indexedMs: indexed,
        speedup:
          Math.round(
            (baseline.medianMs / Math.max(1, indexBuild.medianMs + indexed.medianMs)) * 100,
          ) / 100,
        note: 'Indexed path includes one index build per run; the index is reused across requirements.',
      }
      sweep.push(entry)
      // eslint-disable-next-line no-console
      console.log(
        `[bench] vault index vault=${vaultSize} reqs=${requirementCount} ` +
          `baselineMs=${baseline.medianMs} indexBuildMs=${indexBuild.medianMs} ` +
          `indexedMs=${indexed.medianMs} speedup=${entry.speedup}x`,
      )
      await flushBenchReport()
    }

    ;(benchReport.measurements as Record<string, unknown>).vaultIndexSweep = sweep
    expect(sweep.length).toBe(requirementCounts.length)
    for (const entry of sweep as Array<{
      baselineMs: TimingStats
      indexBuildMs: TimingStats
      indexedMs: TimingStats
    }>) {
      expect(entry.indexBuildMs.medianMs + entry.indexedMs.medianMs).toBeLessThanOrEqual(
        entry.baselineMs.medianMs + 5,
      )
    }
  }, 300_000)

  it('bounds retained canvases for a 500-page document', () => {
    const retained = pageWindow(250, 500)
    // eslint-disable-next-line no-console
    console.log(
      `[bench] canvas retention: total=500 retained=${retained.to - retained.from + 1} ` +
        `window=[${retained.from},${retained.to}] overscan=${PAGE_OVERSCAN}`,
    )
    expect(retained.to - retained.from + 1).toBe(7)
  })
})

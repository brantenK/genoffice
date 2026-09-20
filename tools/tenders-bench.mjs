#!/usr/bin/env node
// Non-interactive runner for the Tenders WP-15 scale benchmarks.
//
//   node tools/tenders-bench.mjs
//   node tools/tenders-bench.mjs --pages 250,500,1000 --runs 2 --stress-pages 500 --stress-lines 500
//   node tools/tenders-bench.mjs --vault 10000 --reqs 2000
//   node tools/tenders-bench.mjs --bytes-mb 96 --image-mb 12
//
// It runs the gated vitest file in the app workspace with TENDERS_BENCH=1 and
// then prints a compact summary from `apps/tenders/tests/performance/results.json`
// (override the output path with TENDERS_BENCH_OUT). Offline and deterministic.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const appDir = join(repoRoot, 'apps', 'tenders')
const vitestBin = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
const resultsPath =
  process.env.TENDERS_BENCH_OUT ?? join(appDir, 'tests', 'performance', 'results.json')

function readFlag(flags, name) {
  const index = flags.indexOf(name)
  return index >= 0 ? flags[index + 1] : undefined
}

const flags = process.argv.slice(2)
const env = { ...process.env, TENDERS_BENCH: '1' }
const envMap = {
  '--pages': 'TENDERS_BENCH_PAGES',
  '--lines': 'TENDERS_BENCH_LINES',
  '--runs': 'TENDERS_BENCH_RUNS',
  '--stress-pages': 'TENDERS_BENCH_STRESS_PAGES',
  '--stress-lines': 'TENDERS_BENCH_STRESS_LINES',
  '--vault': 'TENDERS_BENCH_VAULT',
  '--reqs': 'TENDERS_BENCH_REQS',
  '--canvas-pages': 'TENDERS_BENCH_CANVAS_PAGES',
  '--bytes-mb': 'TENDERS_BENCH_BYTES_MB',
  '--image-mb': 'TENDERS_BENCH_IMAGE_MB',
}
for (const [flag, variable] of Object.entries(envMap)) {
  const value = readFlag(flags, flag)
  if (value !== undefined) env[variable] = value
}

if (!existsSync(vitestBin)) {
  console.error(`[tenders-bench] vitest not found at ${vitestBin}; run npm install first.`)
  process.exit(1)
}

console.log('[tenders-bench] running gated scale benchmarks (TENDERS_BENCH=1)…')
const result = spawnSync(process.execPath, [vitestBin, 'run', 'tests/performance/scale.test.ts'], {
  cwd: appDir,
  env,
  stdio: 'inherit',
})

if (result.status !== 0) {
  console.error(`[tenders-bench] vitest exited with code ${result.status}`)
}

if (!existsSync(resultsPath)) {
  console.error(`[tenders-bench] no results file at ${resultsPath}`)
  process.exit(result.status === 0 ? 1 : (result.status ?? 1))
}

const report = JSON.parse(readFileSync(resultsPath, 'utf8'))
const measurements = report.measurements ?? {}
const env_line = report.env ?? {}
console.log('\n[tenders-bench] summary')
console.log(
  `  machine: node ${env_line.node} | ${env_line.platform}/${env_line.arch} | ` +
    `${env_line.cpuCount} cpus | ${env_line.totalMemGB} GB | pdfjs ${env_line.pdfjs}`,
)
for (const entry of measurements.nativeParseSweep ?? []) {
  console.log(
    `  native pages=${entry.pages} bytes=${entry.bytesLabel} warmupMs=${entry.warmupMs} ` +
      `parseMs=${entry.parseMs?.medianMs} (min ${entry.parseMs?.minMs} / max ${entry.parseMs?.maxMs}) ` +
      `heapDeltaMB=${entry.memory?.heapDeltaMB} peakHeapMB=${entry.memory?.peakHeapUsedMB} ` +
      `peakRssMB=${entry.memory?.peakRssMB}`,
  )
}
if (measurements.byteStress) {
  const entry = measurements.byteStress
  console.log(
    `  byte-stress pages=${entry.pages} bytes=${entry.bytesLabel} ` +
      `parseMs=${entry.parseMs?.medianMs} peakHeapMB=${entry.memory?.peakHeapUsedMB}`,
  )
}
if (measurements.byteCeiling) {
  const entry = measurements.byteCeiling
  console.log(
    `  byte-ceiling images=${entry.images} pages=${entry.pages} bytes=${entry.bytesLabel} ` +
      `parseMs=${entry.parseMs?.medianMs} (min ${entry.parseMs?.minMs} / max ${entry.parseMs?.maxMs}) ` +
      `peakHeapMB=${entry.memory?.peakHeapUsedMB} peakRssMB=${entry.memory?.peakRssMB} lines=${entry.lines}`,
  )
}
if (measurements.byteGuard) {
  const entry = measurements.byteGuard
  console.log(
    `  byte-guard max=${entry.maxBytesLabel} allocMs=${entry.allocMs} ` +
      `arrayBuffersDeltaMB=${entry.arrayBuffersDeltaMB} (fullParseMeasured=${entry.fullParseMeasured})`,
  )
}
if (measurements.canvasWindow) {
  const entry = measurements.canvasWindow
  console.log(
    `  canvas retained=${entry.maxRetainedCanvases}/${entry.totalPages} ` +
      `windowMB=${entry.windowCanvasMB} projectedFullMB=${entry.projectedFullDocCanvasMB} ` +
      `saving=${entry.savingFactor}x`,
  )
}
const vaultSweep =
  measurements.vaultIndexSweep ?? (measurements.vaultIndex ? [measurements.vaultIndex] : [])
for (const entry of vaultSweep) {
  console.log(
    `  vault index vault=${entry.vaultSize} reqs=${entry.requirementCount} ` +
      `baselineMs=${entry.baselineMs?.medianMs} indexBuildMs=${entry.indexBuildMs?.medianMs} ` +
      `indexedMs=${entry.indexedMs?.medianMs} speedup=${entry.speedup}x`,
  )
}
console.log(
  `  largestPageCountExercised=${report.largestPageCountExercised} ` +
    `largestBytesParsed=${report.largestBytesParsed}`,
)
if (report.limitAssessment) {
  const pages = report.limitAssessment.maxPages
  const bytes = report.limitAssessment.maxBytes
  console.log(
    `  limits: pages ${pages.met ? 'MET' : 'NOT MET'} ` +
      `(parsed ${pages.largestPageCountParsed} vs limit ${pages.limit}, ` +
      `headroom ${pages.headroomPages}); ` +
      `bytes ${bytes.met ? 'MET' : 'NOT MET'} ` +
      `(parseMeasured=${bytes.parseMeasured}, largest parsed ` +
      `${(bytes.largestBytesParsed / 1048576).toFixed(2)} MB vs ` +
      `${(bytes.limit / 1048576).toFixed(0)} MB guard)`,
  )
}
if (report.textDensity?.measured) {
  const density = report.textDensity
  console.log(
    `  text density: bytes/line=${density.bytesPerLine} peakHeap/line=${density.peakHeapMbPerLine}MB ` +
      `(recommendedMaxTextLinesAt1GBHeap=${density.recommendedMaxTextLinesAt1GBHeap})`,
  )
}
console.log(`  results: ${resultsPath}`)

process.exit(result.status ?? 0)

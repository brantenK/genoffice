#!/usr/bin/env node
/**
 * Record, or check against, the fork's known test baseline.
 *
 * Why it exists: in the 2026-09-22 sync, e2e showed 32 failures that looked
 * merge-caused. Running the same suites on the pre-merge commit proved 16 of 19
 * affected specs were *already* broken — the fork's own Home redesign, not the
 * merge. Without that comparison the work would have gone into fixing damage the
 * merge never did, or worse, into "fixing" the fork's deliberate UI to satisfy
 * stale upstream specs. This makes that comparison a recorded artefact instead of
 * something someone has to think to do.
 *
 * The baseline is a list of FAILING test IDs, not just counts: a count can match
 * while the set of failures changed underneath it (observed here — the `sheets`
 * failures were a different three each run).
 *
 * Usage:
 *   node fork/tools/baseline.mjs --write                        # record the current state
 *   node fork/tools/baseline.mjs --write --with-e2e --repeat 2   # the trustworthy form
 *   node fork/tools/baseline.mjs                                # check against fork/BASELINE.md
 *   node fork/tools/baseline.mjs --with-e2e
 *
 * `--repeat N` runs each suite N times and splits the results: a test that fails
 * in every run is a known failure, one that fails in only some runs is recorded
 * as **flaky** and is deliberately *not* treated as a known failure — baking a
 * flake in would hide a genuine regression in that same test. A single run cannot
 * tell the two apart, and this disk produces flakes, so use `--repeat 2` when
 * recording the baseline you will judge a sync against.
 *
 * Exits non-zero when a test fails that the baseline does not list. A test that
 * the baseline lists but now passes is reported as FIXED (and is not a failure) —
 * refresh the baseline to lock that in.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE = join(root, 'fork', 'BASELINE.md')
const write = process.argv.includes('--write')
const withE2e = process.argv.includes('--with-e2e')
// --repeat N: run each suite N times and split deterministic failures from flakes.
const repeatIdx = process.argv.indexOf('--repeat')
const repeat = repeatIdx === -1 ? 1 : Math.max(1, Number(process.argv[repeatIdx + 1]) || 1)

/** Every workspace that declares a `test` script. */
function testableWorkspaces() {
  const found = []
  for (const dir of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, dir))) {
      const pkgPath = join(root, dir, entry, 'package.json')
      if (!existsSync(pkgPath)) continue
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg.scripts?.test) found.push(pkg.name)
    }
  }
  return found
}

function runVitest(workspace) {
  const r = spawnSync('npm', ['run', 'test', '-w', workspace], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const counts = /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?/.exec(out)
  // vitest prints ` FAIL  <file> > <title>` for each failing test
  const failing = [...out.matchAll(/^\s*FAIL\s+(.+?)\s*$/gm)].map((m) => m[1].trim())
  return {
    failed: counts ? Number(counts[1] ?? 0) : r.status === 0 ? 0 : 1,
    passed: counts ? Number(counts[2] ?? 0) : 0,
    skipped: counts ? Number(counts[3] ?? 0) : 0,
    failing: [...new Set(failing)].sort(),
  }
}

/**
 * One e2e failure ID, normalised. Playwright's line reporter appends the
 * duration (`… › title (22.6s)`) and, on a retry, a marker (`(retry #1)`); both
 * change run to run, so keeping them would make every comparison a false
 * regression.
 */
function e2eId(raw) {
  // The reporter appends a duration and, on a retry, a marker — in either order,
  // so strip repeatedly until the id stops changing.
  let id = raw.trim()
  for (;;) {
    const next = id
      .replace(/\s*\(retry #\d+\)\s*$/, '')
      .replace(/\s*\(\d+(?:\.\d+)?m?s\)\s*$/, '')
      .trim()
    if (next === id) return id
    id = next
  }
}

function runE2e() {
  const r = spawnSync('npm', ['run', 'test:e2e'], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const failing = [...out.matchAll(/^\s*x\s+\d+\s+(.+?)\s*$/gm)].map((m) => e2eId(m[1]))
  const counts = /^\s*(\d+) failed$/m.exec(out)
  return {
    failed: counts ? Number(counts[1]) : r.status === 0 ? 0 : 1,
    failing: [...new Set(failing)].sort(),
  }
}

function parseBaseline(text) {
  const sections = {}
  let current = null
  for (const line of text.split('\n')) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      current = heading[1].trim()
      sections[current] = []
      continue
    }
    const item = /^-\s+(.+)$/.exec(line)
    if (item && current) sections[current].push(item[1].trim())
  }
  return sections
}

/**
 * Run a suite `repeat` times and split its failures in two:
 *
 *   failing — failed in EVERY run: deterministic, so it is a known failure.
 *   flaky   — failed in SOME runs: unstable on this disk. Recorded separately and
 *             NOT treated as a known failure, because baking a flake in would hide
 *             a genuine regression in that same test.
 *
 * A single run cannot tell the two apart, which is why `--repeat` exists; the
 * default of 1 records every failure as deterministic and says so in the header.
 */
function measure(run, repeat) {
  const runs = []
  for (let i = 0; i < repeat; i++) runs.push(run())
  const counts = runs.reduce(
    (acc, r) => ({
      passed: Math.max(acc.passed, r.passed ?? 0),
      failed: Math.max(acc.failed ?? 0, r.failed ?? 0),
      skipped: Math.max(acc.skipped ?? 0, r.skipped ?? 0),
    }),
    { passed: 0, failed: 0, skipped: 0 },
  )
  const everywhere = runs.reduce(
    (acc, r, i) => (i === 0 ? new Set(r.failing) : intersect(acc, r.failing)),
    null,
  )
  const anywhere = new Set(runs.flatMap((r) => r.failing))
  return {
    ...counts,
    failing: [...everywhere].sort(),
    flaky: [...anywhere].filter((f) => !everywhere.has(f)).sort(),
  }
}

const intersect = (set, list) => new Set(list.filter((f) => set.has(f)))

const workspaces = testableWorkspaces()
const measured = {}
console.log(
  `baseline: measuring ${workspaces.length} workspace(s)${withE2e ? ' + e2e' : ''}` +
    `${repeat > 1 ? `, ${repeat} runs each` : ''} …`,
)
for (const ws of workspaces) {
  process.stdout.write(`  ${ws} … `)
  measured[ws] = measure(() => runVitest(ws), repeat)
  const r = measured[ws]
  console.log(
    `${r.passed} passed, ${r.failed} failed${r.flaky.length ? `, ${r.flaky.length} flaky` : ''}`,
  )
}
if (withE2e) {
  process.stdout.write(`  e2e${repeat > 1 ? ` (${repeat} runs)` : ''} … `)
  measured['e2e'] = measure(runE2e, repeat)
  const r = measured['e2e']
  console.log(`${r.failed} failed${r.flaky.length ? `, ${r.flaky.length} flaky` : ''}`)
}

if (write) {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  const lines = [
    '# Test baseline',
    '',
    `Recorded at \`${sha}\` on ${new Date().toISOString().slice(0, 10)}` +
      `${withE2e ? ' (unit + e2e)' : ' (unit only — re-run with --with-e2e)'}` +
      `${repeat > 1 ? `, ${repeat} runs each` : ''}.`,
    '',
    'These are the tests that already fail, so `npm run check:baseline` can tell a',
    'regression from the background noise. Refresh with',
    '`node fork/tools/baseline.mjs --write --with-e2e` once a fix has landed, and read',
    'this as "known-bad", not as "accepted".',
    '',
  ]
  if (repeat === 1) {
    lines.push(
      'Recorded from a **single run**, so a failure that only happens under load is',
      'listed as known. Use `--repeat 2` (slower) when you need to tell a real failure',
      'from a flake — flakes then land under "flaky" instead.',
      '',
    )
  }
  for (const [ws, r] of Object.entries(measured)) {
    lines.push(`## ${ws}`, '')
    lines.push(`${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped`, '')
    if (r.failing.length === 0) lines.push('- (nothing failing)', '')
    else for (const f of r.failing) lines.push(`- ${f}`)
    lines.push('')
    if (r.flaky.length > 0) {
      lines.push(`## ${ws} (flaky)`, '')
      lines.push('Failed in some runs but not all — not treated as a known failure.', '')
      for (const f of r.flaky) lines.push(`- ${f}`)
      lines.push('')
    }
  }
  writeFileSync(BASELINE, lines.join('\n'))
  console.log(`\nbaseline: written to fork/BASELINE.md`)
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error('baseline: fork/BASELINE.md does not exist — record one with --write first')
  process.exit(1)
}

const known = parseBaseline(readFileSync(BASELINE, 'utf8'))
const regressions = []
const fixed = []
const flaked = []

for (const [ws, r] of Object.entries(measured)) {
  const before = new Set(known[ws] ?? [])
  const knownFlaky = new Set(known[`${ws} (flaky)`] ?? [])
  for (const f of r.failing) {
    if (before.has(f)) continue
    // a known flake failing again is noise, not a regression — but say so
    if (knownFlaky.has(f)) flaked.push(`${ws}: ${f}`)
    else regressions.push(`${ws}: ${f}`)
  }
  for (const f of before) if (!r.failing.includes(f)) fixed.push(`${ws}: ${f}`)
}

console.log('')
if (flaked.length > 0) {
  console.log(`Known flaky, failing again (${flaked.length}) — not a regression:`)
  for (const f of flaked) console.log(`  ${f}`)
}
if (fixed.length > 0) {
  console.log(`FIXED since the baseline (${fixed.length}) — refresh the baseline to lock these in:`)
  for (const f of fixed) console.log(`  ${f}`)
}
if (regressions.length > 0) {
  console.error(`\nNEW FAILURES not in the baseline (${regressions.length}):`)
  for (const r of regressions) console.error(`  ${r}`)
  process.exit(1)
}
console.log('baseline: no new failures')
process.exit(0)

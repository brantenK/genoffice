#!/usr/bin/env node
/**
 * One-shot verification for a fork sync — run this instead of remembering the
 * order by hand.
 *
 * Why it exists: every costly mistake in the 2026-09-22 sync was an ordering or
 * coverage gap, not a git problem. The rebrand sweep has to run *before* the
 * locale bundles or new keys render verbatim; the brand gate is only meaningful
 * once the sweep has run; and the e2e suite has to run alone, because this
 * checkout lives on a OneDrive-synced disk where two heavy suites at once produce
 * failures that pass in isolation. `fork/RUNBOOK.md` has the full rationale.
 *
 * READ-ONLY: this never rewrites a file. Step 1 runs the sweep in `--dry` mode and
 * fails if it *would* change anything, so "the tree is fully swept" is a check
 * rather than something you have to remember to do.
 *
 * Usage:
 *   node fork/tools/verify-sync.mjs             # everything
 *   node fork/tools/verify-sync.mjs --fast      # skip build:all and e2e
 *   node fork/tools/verify-sync.mjs --no-e2e    # skip e2e only
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE = join(root, 'fork', 'BASELINE.md')
const fast = process.argv.includes('--fast')
const noE2e = fast || process.argv.includes('--no-e2e')

/** Cheap, read-only gates. Run in this order; each is quick. */
const CHEAP = [
  {
    name: 'sweep is a no-op (tree fully rebranded)',
    run: () => {
      const out = capture('node', ['fork/rebrand-sweep.mjs', '--dry'])
      const m = /rebranded (\d+) occurrence/.exec(out)
      if (!m) return { ok: false, detail: 'could not read the sweep report' }
      const n = Number(m[1])
      return n === 0
        ? { ok: true, detail: '0 occurrences to change' }
        : {
            ok: false,
            detail: `${n} occurrence(s) still need sweeping — run: node fork/rebrand-sweep.mjs`,
          }
    },
  },
  { name: 'locales rebuilt', run: () => npm(['run', 'prebuild:locales']) },
  { name: 'brand gate', run: () => npm(['run', 'check:brand']) },
  { name: 'fork chrome intact', run: () => npm(['run', 'check:app-chrome']) },
  { name: 'theme tokens', run: () => npm(['run', 'check:theme-colors']) },
  { name: 'english comments', run: () => npm(['run', 'check:english-comments']) },
  { name: 'skill version', run: () => npm(['run', 'check:skill-version']) },
  { name: 'formatting', run: () => npm(['run', 'format:check']) },
  { name: 'typecheck (all workspaces)', run: () => npm(['run', 'typecheck']) },
  { name: 'typecheck (e2e)', run: () => npm(['run', 'check:e2e-types']) },
  { name: 'no new failures vs baseline', run: () => npm(['run', 'check:baseline']) },
]

/** Expensive gates — only reached when every cheap check passed. */
const HEAVY = [
  { name: 'build:all', run: () => npm(['run', 'build:all']) },
  { name: 'e2e (alone; new failures vs baseline)', run: e2eAgainstBaseline },
]

/** The `## <name>` list in fork/BASELINE.md — failing test IDs, one per line. */
function baselineSection(name) {
  if (!existsSync(BASELINE)) return null
  const out = []
  let current = null
  for (const line of readFileSync(BASELINE, 'utf8').split('\n')) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      current = heading[1].trim()
      continue
    }
    const item = /^-\s+(.+)$/.exec(line)
    if (item && current === name) out.push(item[1].trim())
  }
  return out
}

/**
 * e2e is compared against the baseline's own `## e2e` section, so a NEW e2e
 * failure fails the run while the known ones do not. Without this the suite would
 * be run and then ignored, which is how a real regression slips through.
 */
function e2eAgainstBaseline() {
  const r = spawnSync('npm', ['run', 'test:e2e'], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const failing = [
    ...new Set([...out.matchAll(/^\s*x\s+\d+\s+(.+?)\s*$/gm)].map((m) => m[1].trim())),
  ]
  const known = baselineSection('e2e')
  if (known === null) {
    return r.status === 0
      ? { ok: true, detail: 'no fork/BASELINE.md — nothing to compare against' }
      : { ok: false, detail: `${failing.length} e2e failure(s) and no baseline to compare against` }
  }
  const regressions = failing.filter((f) => !known.includes(f))
  if (regressions.length > 0) {
    return { ok: false, detail: `NEW e2e failure(s): ${regressions.join(' | ')}` }
  }
  return { ok: true, detail: `${failing.length} known e2e failure(s), none new` }
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: true })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

function npm(args) {
  const r = spawnSync('npm', args, { cwd: root, stdio: 'pipe', encoding: 'utf8', shell: true })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status === 0) return { ok: true, detail: '' }
  // The useful part is the tail: each of these tools prints its own summary last.
  // npm's own noise (`> script`, `npm error ...`) is stripped so the real reason
  // survives instead of a progress line.
  const lines = out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^>/.test(l) && !/^npm (error|notice|warn)/.test(l))
  const strong = lines.filter((l) => /FAILED|NEW FAILURES|error TS|violation|✗/.test(l))
  const detail = (strong.length > 0 ? strong : lines.slice(-3)).slice(-3).join('\n      ')
  return { ok: false, detail: detail || 'failed' }
}

function runGroup(label, checks) {
  console.log(`\n${label}`)
  const results = []
  for (const check of checks) {
    process.stdout.write(`  ${check.name} … `)
    let result
    try {
      result = check.run()
    } catch (err) {
      result = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    results.push({ ...check, ...result })
    console.log(result.ok ? 'ok' : 'FAIL')
    if (!result.ok && result.detail) console.log(`      ${result.detail}`)
  }
  return results
}

console.log('verify-sync: read-only checks, in the order that matters')

const cheap = runGroup('Cheap gates', CHEAP)
const cheapFailed = cheap.filter((r) => !r.ok)

let heavy = []
if (cheapFailed.length > 0) {
  console.log(`\nSkipping build:all and e2e: ${cheapFailed.length} cheap gate(s) failed.`)
} else if (noE2e) {
  console.log(`\nSkipping build:all and e2e (${fast ? '--fast' : '--no-e2e'}).`)
} else {
  heavy = runGroup('Heavy gates (e2e runs alone on purpose)', HEAVY)
}

const all = [...cheap, ...heavy]
const failed = all.filter((r) => !r.ok)

console.log(`\n${'='.repeat(60)}`)
console.log(`verify-sync: ${all.length - failed.length}/${all.length} checks passed`)
for (const f of failed) console.log(`  FAILED  ${f.name}`)
console.log('='.repeat(60))

process.exit(failed.length > 0 ? 1 : 0)

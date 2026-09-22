#!/usr/bin/env node
/**
 * Trademark & brand linter for Zanostack.
 *
 * Two tiers:
 *
 *   1. FATAL — the upstream product name ("GenOffice") inside files the rebrand
 *      sweep owns. A hit means the sweep has not been run since something
 *      re-introduced the name, so the gate fails and the sync stops.
 *
 *   2. ADVISORY — the upstream vendor name ("Genspark"), which the sweep does
 *      not migrate (it renames products, not the vendor). Reported with a count
 *      but never fatal: the fork still carries hundreds of these inside its i18n
 *      dictionaries, left over from the sign-in surfaces it removed from the UI.
 *      They ship in the bundle, but no code path renders them today, and
 *      burning them down touches every locale shard at once (see CLAUDE.md on
 *      the i18n key-set invariant). Tracked in fork/COMPLIANCE.md.
 *
 * The scanned scope deliberately mirrors fork/rebrand-sweep.mjs
 * (SWEPT_DIRS / SWEPT_ROOT_FILES / SWEPT_EXTENSIONS) so a file can never be
 * swept but unchecked, or checked but unsweepable.
 *
 * Usage: node fork/tools/check-brand.mjs
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Keep in sync with fork/rebrand-sweep.mjs.
const SWEPT_DIRS = ['apps/', 'packages/', 'e2e/', 'skills/', 'scripts/', 'tools/', '.github/']
const SWEPT_ROOT_FILES = ['README.md', 'CONTRIBUTING.md', 'PRIVACY.md']
const SWEPT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.html',
  '.css',
  '.md',
  '.sh',
  '.cmd',
  '.nsh',
  '.cjs',
  '.mjs',
  '.js',
  '.py',
  '.yml',
]

const tracked = execFileSync('git', ['ls-files', ...SWEPT_DIRS, ...SWEPT_ROOT_FILES], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((f) => {
    if (f.includes('fixtures/') || f.endsWith('package-lock.json') || f.endsWith('.xsd')) {
      return false
    }
    if (SWEPT_ROOT_FILES.includes(f)) return true
    if (f.endsWith('package.json')) return f !== 'package.json'
    if (SWEPT_EXTENSIONS.some((ext) => f.endsWith(ext))) return true
    return f.startsWith('packages/cli/bin/')
  })

// Deliberately allowed, even though they contain an upstream name:
//   - @genoffice/* npm scopes and GENOFFICE_* env vars (technical identifiers)
//   - GenOfficeStaticFormFills / GenOfficeFormField (PDF format keys, protected
//     by the sweep's "not followed by an uppercase letter" rule)
//   - https://github.com/genspark-ai/ repository links
// Lines documenting upstream licensing/origins are skipped wholesale, as are
// lines carrying the `brand-check-ignore` marker (an explicit, commented
// exemption for text that must match an artefact the fork does not own — the
// sweep honours the same marker, so the exemption is stable across syncs).
const LINE_EXEMPT = /Apache-2\.0|upstream|github\.com\/genspark-ai|brand-check-ignore/

// Non-global: a /g/ regex used with .test() carries lastIndex across lines and
// silently skips matches. Counting uses a fresh global copy instead.
const FATAL_RULES = [
  {
    name: 'Bare "GenOffice" (product name)',
    pattern: /(?<![@/A-Za-z0-9_$])GenOffice(?![A-Z0-9_$])/,
    hint: 'run: node fork/rebrand-sweep.mjs',
  },
]

const ADVISORY_RULES = [
  {
    name: 'Bare "Genspark" (vendor name)',
    // Case-sensitive on purpose: 'genspark' as a provider id, GENSPARK_* as
    // constants, and identifiers like isGenspark/aiGensparkAccount are
    // technical, not user-visible. German-style compounds (Genspark-Konto)
    // still match, since '-' is not in the guard class.
    pattern: /(?<![A-Za-z0-9_$])Genspark(?![A-Za-z0-9_$])/,
  },
]

const fatal = []
const advisoryByFile = new Map()

for (const rel of tracked) {
  let content
  try {
    content = readFileSync(join(root, rel), 'utf8')
  } catch {
    continue // deleted or unreadable (submodule, lockfile artifact)
  }

  content.split('\n').forEach((line, index) => {
    if (LINE_EXEMPT.test(line)) return

    for (const rule of FATAL_RULES) {
      if (rule.pattern.test(line)) {
        fatal.push({ rule: rule.name, rel, line: index + 1, text: line.trim() })
      }
    }

    for (const rule of ADVISORY_RULES) {
      const global = new RegExp(rule.pattern.source, 'g')
      const hits = line.match(global)
      if (hits) {
        advisoryByFile.set(rel, (advisoryByFile.get(rel) ?? 0) + hits.length)
      }
    }
  })
}

for (const v of fatal) {
  console.error(`❌ [${v.rule}] ${v.rel}:${v.line}`)
  console.error(`   ${v.text}`)
}

const advisoryTotal = [...advisoryByFile.values()].reduce((sum, n) => sum + n, 0)

if (advisoryTotal > 0) {
  const top = [...advisoryByFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  console.log(
    `\nℹ️  ${advisoryTotal} advisory "Genspark" occurrence(s) in ${advisoryByFile.size} file(s) — not fatal, see fork/COMPLIANCE.md`,
  )
  for (const [rel, n] of top) console.log(`     ${String(n).padStart(5)}  ${rel}`)
  if (advisoryByFile.size > top.length) {
    console.log(`     ... and ${advisoryByFile.size - top.length} more file(s)`)
  }
}

if (fatal.length > 0) {
  console.error(
    `\nFound ${fatal.length} brand violation(s). Run 'node fork/rebrand-sweep.mjs', then re-run this check.`,
  )
  process.exit(1)
}

console.log('✅ Brand check passed: no unauthorized upstream product name found.')
process.exit(0)

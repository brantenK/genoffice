#!/usr/bin/env node
/**
 * Trademark & brand linter for Zanostack.
 * Ensures no bare upstream names ("GenOffice", "Genspark") leak into user-visible
 * tracked source files.
 *
 * Usage: node fork/tools/check-brand.mjs
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Files to check: tracked source files under apps/ and packages/
const tracked = execFileSync('git', ['ls-files', 'apps/', 'packages/'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(
    (f) =>
      (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.html') || f.endsWith('.json')) &&
      !f.includes('.test.') &&
      !f.includes('fixtures/') &&
      !f.includes('package-lock.json'),
  )

// Forbidden patterns: user-visible references to upstream names.
// Deliberately allows technical identifiers:
//   - @genoffice/* package scopes
//   - GENOFFICE_* env vars
//   - GenOfficeStaticFormFills, GenOfficeFormField (followed by uppercase)
//   - https://github.com/genspark-ai/ (repository links)
const FORBIDDEN_RULES = [
  {
    name: 'Bare "GenOffice" (user-visible)',
    pattern: /(?<![@/A-Za-z0-9_$])GenOffice(?![A-Z0-9_$])/g,
  },
  {
    name: '"Genspark" in UI/metadata',
    pattern: /(?<!https:\/\/github\.com\/)genspark-ai\/(?!genoffice)/gi,
  },
]

let violations = 0

for (const rel of tracked) {
  const fullPath = join(root, rel)
  let content
  try {
    content = readFileSync(fullPath, 'utf8')
  } catch {
    continue
  }

  const lines = content.split('\n')
  lines.forEach((line, index) => {
    // Skip comments that explicitly document upstream licensing/origins
    if (line.includes('Apache-2.0') || line.includes('upstream') || line.includes('github.com/genspark-ai')) {
      return
    }

    for (const rule of FORBIDDEN_RULES) {
      if (rule.pattern.test(line)) {
        console.error(`❌ [${rule.name}] ${rel}:${index + 1}`)
        console.error(`   ${line.trim()}`)
        violations++
      }
    }
  })
}

if (violations > 0) {
  console.error(`\nFound ${violations} brand violation(s). Please review and sweep with 'node fork/rebrand-sweep.mjs'.`)
  process.exit(1)
} else {
  console.log('✅ Brand check passed: Zero unauthorized upstream brand occurrences found.')
  process.exit(0)
}

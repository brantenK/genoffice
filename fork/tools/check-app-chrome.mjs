#!/usr/bin/env node
/**
 * Fork-chrome guard for Zanostack.
 *
 * The rebrand sweep protects brand *strings*. It cannot protect the fork's
 * structural UI work, and neither can the brand gate — those are class names,
 * design tokens and component registrations, not product names. Upstream
 * rewrites the same files, so a conflict resolved in upstream's favour can drop
 * a fork-only rule and leave the UI silently unstyled: no error, no test
 * failure, just a broken-looking screen.
 *
 * This asserts the fork's own chrome still exists after a merge. It is
 * deliberately a small, explicit list of the things the fork added to files
 * upstream also owns — see fork/COMPLIANCE.md for the running rationale.
 *
 * Usage: node fork/tools/check-app-chrome.mjs
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const HOME_TSX = 'apps/shell/src/renderer/src/Home.tsx'
const HOME_CSS = 'apps/shell/src/renderer/src/home.css'
const TOKENS_CSS = 'packages/ui/src/tokens.css'
const TABBAR_TSX = 'apps/shell/src/renderer/src/TabBar.tsx'

// `min` is the number of required matches, so a token that must exist in every
// theme block can be enforced without listing each block.
const CHECKS = [
  // The Home app launcher: markup lives only in the fork's Home.tsx, styling
  // only in the fork's home.css. Upstream has no equivalent in either file, so
  // resolving either one in upstream's favour removes it.
  {
    label: 'Home launcher markup (app-nav)',
    file: HOME_TSX,
    pattern: /className="app-nav"/,
    min: 1,
  },
  { label: 'Home launcher heading', file: HOME_TSX, pattern: /app-nav-heading/, min: 1 },
  { label: 'Home launcher item', file: HOME_TSX, pattern: /app-nav-item/, min: 1 },
  { label: 'Zano logo asset reference', file: HOME_TSX, pattern: /zano-logo\.png/, min: 1 },

  { label: 'Home launcher styles (.app-nav)', file: HOME_CSS, pattern: /^\.app-nav\s*\{/m, min: 1 },
  {
    label: 'Home launcher heading styles',
    file: HOME_CSS,
    pattern: /^\.app-nav-heading\s*\{/m,
    min: 1,
  },
  { label: 'Home launcher item styles', file: HOME_CSS, pattern: /^\.app-nav-item\s*\{/m, min: 1 },

  // Canvas action styling, fork-only in the same file.
  { label: 'Canvas actions styles', file: HOME_CSS, pattern: /^\.canvas-actions\s*\{/m, min: 1 },
  { label: 'Canvas primary styles', file: HOME_CSS, pattern: /^\.canvas-primary\s*\{/m, min: 1 },

  // Fork-only design tokens. --gs-panel-bg is a surface colour, so it must be
  // defined once per theme block (light, dark, system-dark) per CLAUDE.md.
  {
    label: 'Design token --gs-panel-bg (all theme blocks)',
    file: TOKENS_CSS,
    pattern: /--gs-panel-bg\s*:/g,
    min: 3,
  },
  {
    label: 'Design token --gs-font-display',
    file: TOKENS_CSS,
    pattern: /--gs-font-display\s*:/g,
    min: 1,
  },

  // Fork-only tab kinds. TabKind gaining members invalidates upstream's
  // exhaustive Record<TabKind, …> maps, so a merge can drop the icons.
  { label: 'Tab icon: crm', file: TABBAR_TSX, pattern: /^\s*crm:/m, min: 1 },
  { label: 'Tab icon: tenders', file: TABBAR_TSX, pattern: /^\s*tenders:/m, min: 1 },
  { label: 'Tab icon: books', file: TABBAR_TSX, pattern: /^\s*books:/m, min: 1 },
]

const failures = []

for (const check of CHECKS) {
  let content
  try {
    content = readFileSync(join(root, check.file), 'utf8')
  } catch {
    failures.push(`${check.label} — ${check.file} is missing or unreadable`)
    continue
  }

  // Fresh global regex per call: a shared /g/ regex carries lastIndex between
  // matches and would under-count.
  const global = new RegExp(check.pattern.source, check.pattern.flags.includes('g') ? 'gm' : 'm')
  const found = content.match(global)?.length ?? 0

  if (found < check.min) {
    failures.push(
      `${check.label} — expected ${check.min} match(es) of ${check.pattern} in ${check.file}, found ${found}`,
    )
  }
}

if (failures.length > 0) {
  console.error('❌ Fork chrome is missing after the merge:\n')
  for (const f of failures) console.error(`   - ${f}`)
  console.error(
    `\n${failures.length} check(s) failed. The fork's own UI work was likely dropped while resolving a conflict.`,
  )
  console.error('Re-apply it before merging product — see fork/COMPLIANCE.md.')
  process.exit(1)
}

console.log(`✅ Fork chrome intact: ${CHECKS.length} check(s) passed.`)
process.exit(0)

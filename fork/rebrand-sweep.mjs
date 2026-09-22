#!/usr/bin/env node
/**
 * Rebrand sweep for the commercial fork — the thin, re-appliable branding
 * layer. Reads fork/brand.json and rewrites user-visible upstream branding
 * across tracked sources. Idempotent: after changing brand.json, run again to
 * migrate from the current name to the new one.
 *
 * What it touches (user-visible surface only):
 *   - "GenOffice Docs" / bare "GenOffice" / "GenTeam" string literals across the
 *     upstream-owned directories listed in SWEPT_DIRS (main-process i18n
 *     dictionaries, shell onboarding strings, window titles, save-folder
 *     defaults, test assertions, renderer CSS, docs and prompts, and the
 *     packaging/installer scripts).
 *   - Packaging identity: apps/shell/electron-builder.cjs (appId, productName,
 *     executableName, deb/rpm artifact + package names, maintainer/vendor) and
 *     apps/shell/package.json ("productName" — feeds the Electron app name and
 *     the userData directory).
 *
 * What it deliberately protects (do NOT rename — kept for merge sanity and
 * format stability):
 *   - npm scope identifiers: @genoffice/*
 *   - environment variable prefix: GENOFFICE_*
 *   - PDF format keys: GenOfficeStaticFormFills, GenOfficeFormField
 *     (any "GenOffice" followed by an uppercase letter is left alone)
 *   - lowercase standalone identifiers / file names (genoffice.desktop etc.)
 *
 * What it deliberately never reads:
 *   - NOTICE and LICENSE (Apache-2.0 §4 requires the upstream copyright line)
 *   - fork/ — brand.json's previousNames and the compliance notes name upstream
 *     on purpose; rewriting them would break the sweep itself
 *   - tools/ooxml-validate/schemas/*.xsd (must stay byte-identical to ISO/IEC
 *     29500, per NOTICE)
 *
 * Not handled here (needs real brand assets or UI decisions):
 *   - icon files under apps/shell/build/
 *   - the Genspark sign-in UI flow (see fork/COMPLIANCE.md)
 *   - bare "Genspark" strings (the sweep migrates product names, not the
 *     upstream vendor name — fork/tools/check-brand.mjs flags those)
 *
 * Usage: node fork/rebrand-sweep.mjs [--dry]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dry = process.argv.includes('--dry')

const brand = JSON.parse(readFileSync(join(root, 'fork', 'brand.json'), 'utf8'))
const product = brand.productName
if (!product || /example/i.test(product)) {
  console.warn('warning: brand.json still carries placeholder values')
}

// Names to migrate away from: upstream's, any previously recorded ones, and
// the current value (re-running with the same name is a no-op, which keeps
// the script safely re-runnable).
const previousNames = [...new Set([...(brand.previousNames ?? []), 'GenOffice', product])]

// A line containing this marker is left verbatim by both this sweep and
// fork/tools/check-brand.mjs. Use it only for text that must match an artefact
// the fork does not own — e.g. a font binary's embedded family name — and
// always with a comment saying why.
const IGNORE_MARKER = 'brand-check-ignore'

// --- packaging identity -----------------------------------------------------

const builderRel = join('apps', 'shell', 'electron-builder.cjs')
const builderPath = join(root, builderRel)
let builderText = readFileSync(builderPath, 'utf8')
const builderBefore = builderText
builderText = builderText
  .replace(/appId: '[^']*'/, `appId: '${brand.appId}'`)
  .replace(/productName: '[^']*'/, `productName: '${product}'`)
  .replace(/executableName: '[^']*'/, `executableName: '${brand.executableName}'`)
  .replace(/maintainer: '[^']*'/, `maintainer: '${brand.company} <${brand.companyEmail}>'`)
  .replace(/vendor: '[^']*'/, `vendor: '${brand.company} <${brand.companyEmail}>'`)
  .replace(/packageName: '[^']*'/g, `packageName: '${brand.packageName}'`)
  .replace(
    /artifactName: 'genoffice_\$\{version\}/g,
    `artifactName: '${brand.packageName}_\${version}`,
  )
  .replace(
    /artifactName: 'genoffice-\$\{version\}/g,
    `artifactName: '${brand.packageName}-\${version}`,
  )

// --- shell package identity (Electron app.name / userData dir) --------------

const shellPkgRel = join('apps', 'shell', 'package.json')
const shellPkgPath = join(root, shellPkgRel)
const shellPkg = JSON.parse(readFileSync(shellPkgPath, 'utf8'))
const shellPkgChanged = shellPkg.productName !== product

// --- tracked sources --------------------------------------------------------

// "GenOffice" followed by an uppercase letter is a protected compound
// identifier (GenOfficeStaticFormFills, GenOfficeFormField); anything else in
// source text is user-visible branding. Both names are also guarded on the
// left so camelCase identifiers (openGenOffice, onbJoinGenTeam) survive —
// product names with spaces would otherwise produce invalid syntax.
function namePattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Z])`, 'g')
}

// Directories whose contents are upstream's and must be re-branded. This is
// deliberately an allowlist rather than "everything under the repo": fork-owned
// paths legitimately reference the upstream name — `fork/brand.json`'s
// `previousNames` array and the COMPLIANCE/RUNBOOK notes would be corrupted by
// a rewrite — and NOTICE/LICENSE must keep the upstream copyright line verbatim
// (Apache-2.0 §4). Test files are swept too: upstream's own tests assert the
// old brand against sources the sweep rewrites, so leaving them out produces
// failing tests that the brand gate reports as clean.
//
// `docs/` is excluded on purpose: it holds upstream's own project documentation,
// including 19 translated copies of upstream's README (~800 occurrences). The
// fork does not ship those, and rewriting them buys no product branding while
// adding conflict surface on every future sync. Tracked as an open item in
// fork/COMPLIANCE.md instead.
const SWEPT_DIRS = ['apps/', 'packages/', 'e2e/', 'skills/', 'scripts/', 'tools/', '.github/']

// Root-level documents that carry user-visible branding. NOTICE and LICENSE are
// absent on purpose — see above.
const SWEPT_ROOT_FILES = ['README.md', 'CONTRIBUTING.md', 'PRIVACY.md']

// Extensions re-branded inside those directories. `.xsd` is absent on purpose:
// tools/ooxml-validate/schemas must stay byte-identical to the published
// ISO/IEC 29500 schemas (see NOTICE).
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
    // extensionless CLI launcher, e.g. packages/cli/bin/genoffice
    return f.startsWith('packages/cli/bin/')
  })

let touchedFiles = 0
let touchedLines = 0
for (const rel of tracked) {
  const path = join(root, rel)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    continue // deleted or unreadable (submodule, lockfile artifact)
  }

  let count = 0
  // Line-based so a line carrying IGNORE_MARKER is left verbatim. Needed for
  // assertions that must match an artefact the sweep does not own — e.g. the
  // embedded family name inside a bundled .woff2, which only changes when the
  // font is regenerated.
  const rewritten = text.split('\n').map((line) => {
    if (line.includes(IGNORE_MARKER)) return line
    let next = line
    for (const name of previousNames) {
      // `product` is in previousNames so the sweep is idempotent, but a no-op
      // self-rename must not be reported as a change — otherwise --dry inflates
      // the count by every already-correct occurrence.
      next = next.replace(namePattern(`${name} Docs`), (match) => {
        const replacement = `${product} Docs`
        if (match === replacement) return match
        count++
        return replacement
      })
      next = next.replace(namePattern(name), (match) => {
        if (match === product) return match
        count++
        return product
      })
    }
    if (brand.genTeamName) {
      const teamPattern = new RegExp(
        '(?<![A-Za-z0-9_$])' + brand.genTeamName + '(?![A-Za-z0-9_$])',
        'g',
      )
      next = next.replace(teamPattern, (match) => {
        if (match === product) return match
        count++
        return product
      })
    }
    return next
  })
  text = rewritten.join('\n')
  if (count > 0) {
    if (!dry) writeFileSync(path, text)
    touchedFiles++
    touchedLines += count
    console.log(`${String(count).padStart(4)}  ${rel}`)
  }
}

// --- write packaging files --------------------------------------------------

if (!dry) {
  if (builderText !== builderBefore) writeFileSync(builderPath, builderText)
  if (shellPkgChanged) {
    shellPkg.productName = product
    writeFileSync(shellPkgPath, JSON.stringify(shellPkg, null, 2) + '\n')
  }
}

if (builderText !== builderBefore) console.log(`   1  ${builderRel}`)
if (shellPkgChanged) console.log(`   1  ${shellPkgRel}`)
console.log(
  `\n${dry ? '[dry run] ' : ''}rebranded ${touchedLines} occurrence(s) in ${touchedFiles} source file(s) → "${product}"`,
)

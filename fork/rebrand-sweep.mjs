#!/usr/bin/env node
/**
 * Rebrand sweep for the commercial fork — the thin, re-appliable branding
 * layer. Reads fork/brand.json and rewrites user-visible upstream branding
 * across tracked sources. Idempotent: after changing brand.json, run again to
 * migrate from the current name to the new one.
 *
 * What it touches (user-visible surface only):
 *   - "GenOffice Docs" / bare "GenOffice" / "GenTeam" string literals in
 *     apps/* and packages/* sources (main-process i18n dictionaries, shell
 *     onboarding strings, window titles, save-folder defaults, README-style
 *     comments are swept incidentally).
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
 * Not handled here (needs real brand assets or UI decisions):
 *   - icon files under apps/shell/build/
 *   - the Genspark sign-in UI flow (see fork/COMPLIANCE.md)
 *   - onboarding copy that points users at upstream's GitHub repo
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
  .replace(/artifactName: 'genoffice_\$\{version\}/g, `artifactName: '${brand.packageName}_\${version}`)
  .replace(/artifactName: 'genoffice-\$\{version\}/g, `artifactName: '${brand.packageName}-\${version}`)

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

const tracked = execFileSync('git', ['ls-files', 'apps/', 'packages/', 'e2e/'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(
    (f) =>
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.includes('.test.') &&
      !f.includes('fixtures/'),
  )

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
  for (const name of previousNames) {
    text = text.replace(namePattern(`${name} Docs`), () => {
      count++
      return `${product} Docs`
    })
    text = text.replace(namePattern(name), () => {
      count++
      return product
    })
  }
  if (brand.genTeamName) {
    const teamPattern = new RegExp(
      '(?<![A-Za-z0-9_$])' + brand.genTeamName + '(?![A-Za-z0-9_$])',
      'g',
    )
    text = text.replace(teamPattern, () => {
      count++
      return product
    })
  }
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

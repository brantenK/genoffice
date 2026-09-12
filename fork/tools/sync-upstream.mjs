#!/usr/bin/env node
/**
 * Safe, automated upstream sync script for Zanostack.
 *
 * Steps:
 *   1. Verifies git working directory is clean.
 *   2. Ensures 'upstream' remote exists (points to genspark-ai/genoffice).
 *   3. Updates local 'main' branch cleanly via fast-forward only.
 *   4. Merges 'main' into the active 'product' branch.
 *   5. Automatically runs 'node fork/rebrand-sweep.mjs' and 'npm run prebuild:locales'.
 *   6. Runs 'node fork/tools/check-brand.mjs'.
 *
 * Usage: node fork/tools/sync-upstream.mjs [--dry-run]
 */

import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dryRun = process.argv.includes('--dry-run')

function run(cmd, options = {}) {
  console.log(`> ${cmd}`)
  if (dryRun) return ''
  return execSync(cmd, { cwd: root, stdio: options.silent ? 'pipe' : 'inherit', encoding: 'utf8' })
}

function runOutput(cmd) {
  try {
    return execSync(cmd, { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

console.log('🔄 Starting Upstream Sync for Zanostack...')
if (dryRun) {
  console.log('ℹ️ Running in --dry-run mode: no changes will be made.')
}

// 1. Check working directory status
const status = runOutput('git status --porcelain')
if (status.length > 0 && !dryRun) {
  console.error('\n⚠️ Your working directory has uncommitted changes.')
  console.error('Please commit or stash your changes before syncing with upstream:')
  console.error(status)
  process.exit(1)
}

// 2. Verify / configure remotes
const remotes = runOutput('git remote -v')
if (!remotes.includes('upstream')) {
  console.log('ℹ️ Adding upstream remote (https://github.com/genspark-ai/genoffice.git)...')
  run('git remote add upstream https://github.com/genspark-ai/genoffice.git')
}

// 3. Fetch upstream
console.log('\n📥 Fetching latest commits from upstream...')
run('git fetch upstream')

// 4. Update 'main' mirror
const currentBranch = runOutput('git rev-parse --abbrev-ref HEAD')
console.log(`\n📌 Current branch: ${currentBranch}`)

console.log('\n⏩ Updating mirror branch "main"...')
run('git checkout main')
try {
  run('git merge --ff-only upstream/main')
} catch (e) {
  console.error('\n❌ Fast-forward of main failed! main must remain an exact mirror of upstream/main.')
  console.error('Do not commit directly to main. Reverting back to your previous branch...')
  if (!dryRun) run(`git checkout ${currentBranch}`)
  process.exit(1)
}

// Optional: push updated main to origin
try {
  console.log('\n📤 Pushing updated main to origin...')
  run('git push origin main')
} catch {
  console.log('ℹ️ (Could not push main to origin; continuing with local sync)')
}

// 5. Merge into product branch
console.log(`\n🔀 Merging updated main into ${currentBranch}...`)
run(`git checkout ${currentBranch}`)

try {
  run('git merge main -m "chore: sync with upstream/main"')
} catch (e) {
  console.warn('\n⚠️ Merge encountered conflicts!')
  console.warn('Resolve the conflicts in your editor, then run:')
  console.warn('  git add <resolved-files>')
  console.warn('  git commit')
  console.warn('  node fork/rebrand-sweep.mjs')
  console.warn('  npm run prebuild:locales')
  process.exit(1)
}

// 6. Post-merge rebrand sweep and locale rebuild
console.log('\n✨ Running automated rebrand sweep...')
run('node fork/rebrand-sweep.mjs')

console.log('\n🌐 Rebuilding locale bundles...')
run('npm run prebuild:locales')

// 7. Verify brand integrity
console.log('\n🛡️ Checking brand integrity...')
run('node fork/tools/check-brand.mjs')

console.log('\n🎉 Sync completed successfully! Your Zanostack branch is now up to date with upstream.')
console.log('Recommended next step: run "npm run typecheck && npm test" to verify tests.')

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import brand from '../../../fork/brand.json'
import { LEGACY_USER_DATA_DIRS, newestLegacyProfileDir } from '../src/main/legacy-user-data'

/**
 * The legacy-profile migration list (`src/main/legacy-user-data.ts`) is what
 * carries a user's workspace across a rebrand, and it used to be a hand-copy of
 * `fork/brand.json`'s `previousNames` with nothing keeping the two in sync: a
 * rebrand that added a name to brand.json silently stopped migrating the profile
 * of that name, leaving the user with an empty workspace and no error at all.
 * These tests fail when the list and brand.json disagree.
 *
 * `newestLegacyProfileDir` moves with the list, so its ranking rules are pinned
 * here too — the guard must not be able to break the migration it protects.
 */

/**
 * Names upstream used before the fork existed, recorded in no fork-owned file.
 * Adding one here is a deliberate decision, which is why the equality check
 * below has to be updated with it.
 */
const UPSTREAM_ONLY_NAMES = ['AI Office']

const tempDirs: string[] = []

function tempAppDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shell-legacy-profile-'))
  tempDirs.push(dir)
  return dir
}

function legacyProfile(appDataDir: string, name: string, file = 'profile.json'): string {
  const dir = join(appDataDir, name)
  mkdirSync(dir, { recursive: true })
  if (file) writeFileSync(join(dir, file), '{}', 'utf8')
  return dir
}

function age(dir: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(dir, when, when)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('legacy userData migration list', () => {
  it('names exactly fork/brand.json previousNames plus the upstream-only names', () => {
    expect([...LEGACY_USER_DATA_DIRS].sort()).toEqual(
      [...new Set([...brand.previousNames, ...UPSTREAM_ONLY_NAMES])].sort(),
    )
  })

  it('covers every name fork/brand.json records as a previous name', () => {
    // The assertion above is the guard; this one names the failure mode a
    // rebrand hits — the new previous name missing from the migration list.
    for (const name of brand.previousNames) {
      expect(LEGACY_USER_DATA_DIRS, `${name} is missing from the migration list`).toContain(name)
    }
  })

  it('lists no name twice (a duplicate would double-count one profile)', () => {
    expect(new Set(LEGACY_USER_DATA_DIRS).size).toBe(LEGACY_USER_DATA_DIRS.length)
  })
})

describe('newestLegacyProfileDir', () => {
  it('returns null when no legacy profile exists', () => {
    expect(newestLegacyProfileDir(tempAppDataDir())).toBeNull()
  })

  it('never migrates from an empty profile directory', () => {
    const appDataDir = tempAppDataDir()
    const empty = legacyProfile(appDataDir, LEGACY_USER_DATA_DIRS[0], '')
    expect(newestLegacyProfileDir(appDataDir)).toBeNull()

    // A fresh, empty profile is not a source even next to an older used one.
    age(empty, 0)
    const used = legacyProfile(appDataDir, LEGACY_USER_DATA_DIRS[1])
    age(used, 3600)
    expect(newestLegacyProfileDir(appDataDir)).toBe(used)
  })

  it('migrates from the profile written last, not the newest product name', () => {
    const appDataDir = tempAppDataDir()
    const older = legacyProfile(appDataDir, LEGACY_USER_DATA_DIRS[0])
    const newer = legacyProfile(appDataDir, LEGACY_USER_DATA_DIRS[1])
    age(older, 3600)
    age(newer, 60)
    expect(newestLegacyProfileDir(appDataDir)).toBe(newer)

    // Writing the older-named profile last makes it the source instead.
    age(older, 0)
    expect(newestLegacyProfileDir(appDataDir)).toBe(older)
  })
})

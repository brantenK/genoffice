import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every product name this app has ever had was its own Electron userData
 * directory, so an upgrade from any of them has to carry the profile across: a
 * rename without a migration presents the user with an empty workspace and no
 * error at all.
 *
 * The fork-owned names are exactly `fork/brand.json`'s `previousNames` — a
 * rebrand records the name it replaces there, and
 * `tests/legacy-user-data-dirs.test.ts` fails when this list and that file
 * disagree, so a name added there and forgotten here is caught instead of
 * silently stopping the migration. `AI Office` is the one hand-maintained entry:
 * upstream's earlier name, recorded in no fork-owned file.
 *
 * Each entry carries brand-check-ignore because these are directory names on the
 * user's disk, not branding: the rebrand sweep and the brand linter must leave
 * them exactly as they are.
 */
export const LEGACY_USER_DATA_DIRS = [
  'Zano Office', // brand-check-ignore
  'GenOffice', // brand-check-ignore
  'AI Office', // brand-check-ignore
  'ExampleOffice', // brand-check-ignore
]

/**
 * The legacy profile directory to migrate from, or null when there is none.
 * Ranked by directory mtime so that when a user has more than one legacy
 * profile the one written last — the profile they actually used — wins; empty
 * directories are never a source.
 */
export function newestLegacyProfileDir(appDataDir: string): string | null {
  let newest: { dir: string; mtimeMs: number } | null = null
  for (const name of LEGACY_USER_DATA_DIRS) {
    const dir = join(appDataDir, name)
    try {
      if (readdirSync(dir).length === 0) continue
      const { mtimeMs } = statSync(dir)
      if (!newest || mtimeMs > newest.mtimeMs) newest = { dir, mtimeMs }
    } catch {
      // absent or unreadable — not a migration source
    }
  }
  return newest?.dir ?? null
}

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_VERSION, BOOKS_VERSION, BOOKS_VERSION_LABEL } from '../src/shared/app-version'

/**
 * The UI used to print a hardcoded 'Zano Books v0.37' while package.json said
 * 0.1.0. The version now has exactly one source of truth, and this suite makes
 * drift a test failure instead of a shipped lie.
 */
describe('app version', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    name: string
    version: string
  }

  it('equals the version in apps/books/package.json', () => {
    expect(manifest.name).toBe('@genoffice/books')
    expect(APP_VERSION).toBe(manifest.version)
    expect(BOOKS_VERSION).toBe(manifest.version)
  })

  it('is a plain semver string', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
  })

  it('renders the label the UI chrome shows', () => {
    expect(BOOKS_VERSION_LABEL).toBe(`Zano Books v${APP_VERSION}`)
    // The stale literal that motivated the module.
    expect(BOOKS_VERSION_LABEL).not.toBe('Zano Books v0.37')
  })
})

// OCR honesty guard — Phase 3 (Tenders intake), WP-7 alpha.
//
// Only `needsOcr` DETECTION ships: pages with no text layer are flagged and block
// readiness until a person reviews them. No OCR is performed anywhere in the
// renderer. This guard fails if user-facing copy drifts back into claiming that
// scanned / image-only pages are read, or that an OCR step handles them.
//
// It deliberately scans source text rather than rendering components: the copy
// lives in JSX and is wrapped across lines, so phrases are matched against the
// whitespace-collapsed, comment-stripped file content (a phrase split over two
// lines still fails, as it should).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Locate `apps/tenders/src/renderer/src` without machine-specific paths. Works
 * whether Vitest runs from the app workspace (`npm test -w`) or the repo root.
 */
function resolveRendererSrc(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const fromRepoRoot = join(dir, 'apps', 'tenders', 'src', 'renderer', 'src')
    if (existsSync(fromRepoRoot)) return fromRepoRoot
    const fromWorkspace = join(dir, 'src', 'renderer', 'src')
    if (existsSync(fromWorkspace)) return fromWorkspace
    dir = dirname(dir)
  }
  throw new Error('Could not locate apps/tenders/src/renderer/src from ' + process.cwd())
}

const SRC = resolveRendererSrc()

/** Reduce a source file to the copy a user could actually read. */
function copyText(absoluteFile: string): string {
  return readFileSync(absoluteFile, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1')) // line comments (keep "https://")
    .join(' ')
    .replace(/<[^>]*>/g, ' ') // JSX tags
    .replace(/\s+/g, ' ')
    .trim()
}

function listRendererSources(dir = SRC): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listRendererSources(path))
    else if (/\.tsx?$/.test(entry.name)) out.push(relative(SRC, path).split(sep).join('/'))
  }
  return out
}

/** Copy surfaces a user actually reads on the scanned-page journey. */
const COPY_SURFACES = [
  'components/OnboardingModal.tsx',
  'components/GuidedTour.tsx',
  'components/pages/TutorialsPage.tsx',
]

/**
 * Phrasings that claim scanned / image-only pages are read, or that an OCR step
 * runs. Each entry explains what the copy would be asserting.
 */
const FORBIDDEN_CLAIMS: Array<{ pattern: RegExp; asserts: string }> = [
  { pattern: /including scanned/i, asserts: 'every page is read, including scanned pages' },
  { pattern: /scanned pages? via ocr/i, asserts: 'OCR reads scanned pages' },
  { pattern: /via ocr/i, asserts: 'OCR is performed' },
  { pattern: /\bocr\s+step\b/i, asserts: 'an OCR step runs in the app' },
  { pattern: /handles? them automatically/i, asserts: 'scanned pages need no manual review' },
  { pattern: /reads? every page/i, asserts: 'every page is read' },
]

/**
 * The strongest claim phrasings, checked across the WHOLE renderer so a claim
 * cannot simply move to another component.
 */
const FORBIDDEN_ANYWHERE = [FORBIDDEN_CLAIMS[0], FORBIDDEN_CLAIMS[1], FORBIDDEN_CLAIMS[3]]

/** A surface that names scanned / image-only pages must also state the outcome. */
const SCANNED_MENTION = /scanned|image-only|saved as images/i
const HONEST_CONSEQUENCE = /not extracted|no text layer|does not read|by hand|manually reviewed/i

describe('OCR honesty copy (WP-7 alpha)', () => {
  it.each(COPY_SURFACES)('%s does not claim scanned pages are read', (file) => {
    const text = copyText(join(SRC, file))
    for (const { pattern, asserts } of FORBIDDEN_CLAIMS) {
      expect(pattern.test(text), `${file} claims ${asserts} (matched ${String(pattern)})`).toBe(
        false,
      )
    }
  })

  it.each(COPY_SURFACES)('%s says what happens to scanned pages when it names them', (file) => {
    const text = copyText(join(SRC, file))
    if (!SCANNED_MENTION.test(text)) return
    expect(
      HONEST_CONSEQUENCE.test(text),
      `${file} names scanned/image-only pages but never says their text is not extracted`,
    ).toBe(true)
  })

  it('never claims scanned pages are read anywhere in the renderer', () => {
    for (const file of listRendererSources()) {
      const text = copyText(join(SRC, file))
      for (const { pattern, asserts } of FORBIDDEN_ANYWHERE) {
        expect(pattern.test(text), `${file} claims ${asserts} (matched ${String(pattern)})`).toBe(
          false,
        )
      }
    }
  })

  it('keeps the per-page review copy honest', () => {
    const review = copyText(join(SRC, 'components/ExtractionReview.tsx'))
    // The shipping statement of the limitation (also asserted by the built-Electron
    // intake-review E2E spec) must survive.
    expect(review).toMatch(/does not read scanned pages/)
    expect(review).toMatch(/no text layer/i)
    // ...and it must say the text was not extracted, not merely that it is unread.
    expect(review).toMatch(/not extracted|nothing on it was extracted/i)
    expect(review).not.toMatch(/via ocr/i)
    expect(review).not.toMatch(/\bocr\s+step\b/i)
  })
})

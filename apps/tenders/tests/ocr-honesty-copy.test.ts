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

/**
 * Copy surfaces a user actually reads on the scanned-page journey.
 *
 * Naming scanned / image-only pages obliges a surface to state the outcome, so
 * every entry here is held to the consequence check below — including
 * `TenderList`, whose card badge names the count ("{n} scanned pages — text not
 * extracted"). There is no exemption list: an exemption is exactly how the badge
 * shipped naming scanned pages while saying nothing about their text.
 */
const COPY_SURFACES = [
  'components/OnboardingModal.tsx',
  'components/GuidedTour.tsx',
  'components/pages/TutorialsPage.tsx',
  'components/TenderList.tsx',
]

/**
 * The unqualified universal claim: "the text layer of every page" with no
 * "that has one" / "that has a text layer" qualifier. The honest shipping copy
 * qualifies it, which is why the qualifier is excluded here rather than the
 * pattern dropped — an unqualified claim asserts no page is ever skipped.
 */
const UNIVERSAL_TEXT_LAYER_CLAIM = /text layer of (?:every|all) pages?(?!\s+that\b)/i

/**
 * Phrasings that claim scanned / image-only pages are read, or that an OCR step
 * runs. Each entry explains what the copy would be asserting.
 *
 * `anywhere: true` marks the strongest claim shapes, checked across the WHOLE
 * renderer so a claim cannot simply move to another component.
 */
const FORBIDDEN_CLAIMS: Array<{ pattern: RegExp; asserts: string; anywhere?: boolean }> = [
  {
    pattern: /including scanned/i,
    asserts: 'every page is read, including scanned pages',
    anywhere: true,
  },
  { pattern: /scanned pages? via ocr/i, asserts: 'OCR reads scanned pages', anywhere: true },
  { pattern: /via ocr/i, asserts: 'OCR is performed' },
  { pattern: /\bocr\s+step\b/i, asserts: 'an OCR step runs in the app', anywhere: true },
  { pattern: /handles? them automatically/i, asserts: 'scanned pages need no manual review' },
  { pattern: /reads? every page/i, asserts: 'every page is read' },
  {
    pattern: UNIVERSAL_TEXT_LAYER_CLAIM,
    asserts: 'the text layer of every page is extracted, so no page is skipped',
    anywhere: true,
  },
  { pattern: /reads? the text layer/i, asserts: "the app reads a page's text layer" },
]

/** The strongest claim phrasings, checked across the WHOLE renderer. */
const FORBIDDEN_ANYWHERE = FORBIDDEN_CLAIMS.filter((claim) => claim.anywhere)

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

  it('the universal text-layer claim pattern still has teeth', () => {
    // The phrasing that shipped and slipped the old blocklist must match...
    expect(
      UNIVERSAL_TEXT_LAYER_CLAIM.test('Zanostack Tenders extracts the text layer of every page.'),
    ).toBe(true)
    // ...while the honest qualified phrasing that replaced it must not, so the
    // lookahead cannot be widened until the pattern catches nothing at all.
    expect(
      UNIVERSAL_TEXT_LAYER_CLAIM.test(
        'Zanostack Tenders extracts the text layer of every page that has one.',
      ),
    ).toBe(false)
  })

  it('the consequence check has teeth on every surface that names scanned pages', () => {
    // The badge exactly as it shipped before the fix: a count, no outcome. The
    // consequence check must reject it, otherwise folding `TenderList` into
    // `COPY_SURFACES` proves nothing.
    const badgeWithoutConsequence = '3 scanned pages'
    expect(SCANNED_MENTION.test(badgeWithoutConsequence)).toBe(true)
    expect(HONEST_CONSEQUENCE.test(badgeWithoutConsequence)).toBe(false)
    // ...and the surface that carries it must stay in the checked list: moving it
    // back out to an exemption is the defect, not a refactor.
    expect(COPY_SURFACES).toContain('components/TenderList.tsx')
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

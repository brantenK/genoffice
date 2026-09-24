// Scanned-page honesty guard — Phase 3 (Tenders intake), extended for optional AI
// extraction.
//
// Two different claims have to hold at once, and they are not the same claim:
//
//   * the LOCAL engine never reads a page that has no text layer. Pages without
//     one are flagged (`needsOcr`) and block readiness until a person reviews
//     them, and no OCR runs anywhere in the renderer.
//   * AI extraction CAN read such a page — by sending its image to the model
//     provider the user configured. That is a different actor reading by a
//     different mechanism, so a surface may only say scanned pages are read when
//     it names AI as the reader.
//
// The old unconditional bans on naming OCR are therefore gone: they would forbid
// describing the AI path. In their place, every "scanned pages are read" shape
// must name AI in the same sentence as the claim, and the qualifier has to be
// there — one parked in another sentence, or in a neighbouring limit of the same
// notice, does not license it (all three directions are pinned below). The
// universal "text layer of every page" claim stays unconditionally forbidden: no
// reading path, local or model, reads a text layer off a page that has none.
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
  'components/LimitationsNotice.tsx',
  'components/TenderList.tsx',
]

/**
 * Naming AI anywhere is what turns "scanned pages are read" from a false claim
 * into the true one: the model provider reads the page's image, and the surface
 * that says so is describing the optional path rather than the local engine.
 */
const AI_QUALIFIER = /\bAI\b|AI extraction|AI provider|model provider|configured model/i

interface ClaimShape {
  pattern: RegExp
  asserts: string
  /**
   * True when naming AI as the reader makes the shape honest. The universal
   * text-layer claim is deliberately not in this group: qualifying it with AI
   * cannot rescue it, because a model reads a page's image, never a text layer
   * the page does not have.
   */
  aiQualifiable: boolean
  /**
   * True for the positive verb shapes, which copy can also use negated
   * ("does not read scanned pages"). That negation is the honest sentence and
   * must not be caught, so the words immediately before the verb decide.
   */
  negatable?: boolean
}

/**
 * The unqualified universal claim: "the text layer of every page" with no
 * "that has one" / "that has a text layer" qualifier. The honest shipping copy
 * qualifies it, which is why the qualifier is excluded here rather than the
 * pattern dropped — an unqualified claim asserts no page is ever skipped.
 */
const UNIVERSAL_TEXT_LAYER_CLAIM = /text layer of (?:every|all) pages?(?!\s+that\b)/i

/**
 * Phrasings that claim scanned / image-only pages are read. Each entry explains
 * what the copy would be asserting; the two flags decide whether naming AI — or
 * negating the verb — makes the shape honest.
 */
const CLAIM_SHAPES: ClaimShape[] = [
  {
    pattern: /including scanned/i,
    asserts: 'every page is read, including scanned pages',
    aiQualifiable: true,
  },
  { pattern: /scanned pages? via ocr/i, asserts: 'OCR reads scanned pages', aiQualifiable: true },
  { pattern: /via ocr/i, asserts: 'OCR is performed', aiQualifiable: true },
  { pattern: /\bocr\s+step\b/i, asserts: 'an OCR step runs in the app', aiQualifiable: true },
  {
    pattern: /handles? them automatically/i,
    asserts: 'scanned pages need no manual review',
    aiQualifiable: true,
  },
  { pattern: /reads? every page/i, asserts: 'every page is read', aiQualifiable: true },
  {
    pattern: /\b(?:reads?|extracts?)\b[^.]{0,40}\bscanned\b/i,
    asserts: 'scanned pages are read',
    aiQualifiable: true,
    negatable: true,
  },
  {
    pattern: /scanned pages? (?:are|get|gets|can be) read\b/i,
    asserts: 'scanned pages are read',
    aiQualifiable: true,
  },
  {
    pattern: UNIVERSAL_TEXT_LAYER_CLAIM,
    asserts: 'the text layer of every page is extracted, so no page is skipped',
    aiQualifiable: false,
  },
  {
    pattern: /reads? the text layer/i,
    asserts: "the app reads a page's text layer",
    aiQualifiable: false,
  },
]

/** A surface that names scanned / image-only pages must also state the outcome. */
const SCANNED_MENTION = /scanned|image-only|saved as images/i
const HONEST_CONSEQUENCE = /not extracted|no text layer|does not read|by hand|manually reviewed/i

function matchesWithIndex(pattern: RegExp, text: string): Array<{ match: string; index: number }> {
  const scanner = new RegExp(pattern.source, pattern.flags.replace(/g/g, '') + 'g')
  const out: Array<{ match: string; index: number }> = []
  for (const found of text.matchAll(scanner)) out.push({ match: found[0], index: found.index ?? 0 })
  return out
}

/**
 * `AI` named in the same sentence as the claim, so it is doing the reading the
 * claim describes. Sentence scope, not a character window: a neighbouring limit
 * or paragraph that happens to mention AI must not license an absolute claim
 * about the whole document.
 */
function aiQualifiedInSentence(text: string, index: number, length: number): boolean {
  const from = text.lastIndexOf('.', index) + 1
  const to = text.indexOf('.', index + length)
  return AI_QUALIFIER.test(text.slice(from, to === -1 ? text.length : to))
}

/** "does not read scanned pages" is the honest sentence, not the claim. */
function isNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 32), index)
  return /(?:\bnot|\bnever|\bno|cannot|can't|without)\s+(?:\w+\s+){0,2}$/i.test(before)
}

/** Every scanned-page claim in `text` that no AI qualifier (or negation) rescues. */
function claimViolations(text: string): Array<{ asserts: string; pattern: RegExp; match: string }> {
  const out: Array<{ asserts: string; pattern: RegExp; match: string }> = []
  for (const shape of CLAIM_SHAPES) {
    for (const { match, index } of matchesWithIndex(shape.pattern, text)) {
      if (shape.negatable && isNegated(text, index)) continue
      if (shape.aiQualifiable && aiQualifiedInSentence(text, index, match.length)) continue
      out.push({ asserts: shape.asserts, pattern: shape.pattern, match })
    }
  }
  return out
}

function expectNoClaimViolations(file: string, text: string): void {
  expect(
    claimViolations(text).map(
      (violation) => `${violation.asserts} (matched ${String(violation.pattern)})`,
    ),
    `${file} claims scanned pages are read without naming AI as the reader`,
  ).toEqual([])
}

describe('scanned-page honesty copy (local engine, plus optional AI)', () => {
  it.each(COPY_SURFACES)('%s does not claim scanned pages are read without naming AI', (file) => {
    expectNoClaimViolations(file, copyText(join(SRC, file)))
  })

  it.each(COPY_SURFACES)('%s says what happens to scanned pages when it names them', (file) => {
    const text = copyText(join(SRC, file))
    if (!SCANNED_MENTION.test(text)) return
    expect(
      HONEST_CONSEQUENCE.test(text),
      `${file} names scanned/image-only pages but never says their text is not extracted`,
    ).toBe(true)
  })

  it('never makes an unqualified scanned-page claim anywhere in the renderer', () => {
    for (const file of listRendererSources()) {
      expectNoClaimViolations(file, copyText(join(SRC, file)))
    }
  })

  it('the claim check still has teeth on the copy that shipped', () => {
    // The phrasings the guard exists to reject: none of them names AI, so none of
    // them can be the optional path.
    for (const shipped of [
      'Zanostack Tenders reads every page, including scanned pages.',
      'Scanned pages are read via OCR.',
      'An OCR step handles them automatically.',
      'Tenders reads scanned pages too.',
      'Zanostack Tenders extracts the text layer of every page.',
    ]) {
      expect(claimViolations(shipped).length, `must reject: ${shipped}`).toBeGreaterThan(0)
    }
  })

  it('accepts the AI-qualified claim and the local negation, and nothing looser', () => {
    // The honest AI path, stated as the AI path.
    expect(
      claimViolations('AI extraction can read scanned pages the local engine cannot.'),
    ).toEqual([])
    // The honest local limitation.
    expect(
      claimViolations('Zanostack does not read scanned pages, so nothing on them was extracted.'),
    ).toEqual([])
    // ...but a qualifier parked in another sentence does not license the claim:
    // sentence scope is what keeps "mention AI somewhere" from passing as honesty.
    const distant = `AI extraction is optional. ${'Padding sentence. '.repeat(20)}Tenders reads every page, including scanned pages.`
    expect(claimViolations(distant).length).toBeGreaterThan(0)
    // ...and neither does one in a neighbouring limit of the same notice.
    const nextLimit =
      'Tenders reads every page, including scanned pages. AI extraction is optional.'
    expect(claimViolations(nextLimit).length).toBeGreaterThan(0)
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
    // ...and naming AI cannot rescue it: a model reads the page image, not a text
    // layer the page does not have.
    expect(
      claimViolations(
        'AI extraction extracts the text layer of every page, including the scanned ones.',
      ).length,
    ).toBeGreaterThan(0)
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
    // The surfaces this feature's copy changes are checked for the claim too.
    expect(COPY_SURFACES).toContain('components/LimitationsNotice.tsx')
  })

  it('keeps the per-page review copy honest', () => {
    const review = copyText(join(SRC, 'components/ExtractionReview.tsx'))
    // The shipping statement of the limitation (also asserted by the built-Electron
    // intake-review E2E spec) must survive: the local engine does not read a page
    // with no text layer.
    expect(review).toMatch(/(?:does not|doesn't|never) reads?\b|not read\b/i)
    expect(review).toMatch(/no text layer/i)
    // ...and it must say the text was not extracted, not merely that it is unread.
    expect(review).toMatch(/not extracted|nothing on it was extracted/i)
    // ...and if it ever says a model read such a page, that claim must name AI.
    expectNoClaimViolations('components/ExtractionReview.tsx', review)
  })
})

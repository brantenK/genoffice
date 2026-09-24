// AI honesty guard — the claims the optional AI extraction path obliges.
//
// Until AI extraction existed, "the local engine does not read scanned pages" was
// the whole truth, and "nothing leaves this machine" was true without a caveat.
// Both changed the moment a model could be asked to read the document: the app is
// only entirely local while AI extraction is OFF, and a model's answer is a
// suggestion the user still has to confirm — never a verified fact.
//
// So this guard pins the position in both directions, on every surface this
// feature's copy touches:
//
//   * REQUIRED — the surface states that AI extraction is optional, that the local
//     engine is the offline always-available default, that using AI sends the
//     document's text (or a scanned page's image) to the model provider the user
//     configured, and that what the model returns is unconfirmed until the user
//     confirms it.
//   * FORBIDDEN — the old absolutes: scanned pages read without naming AI, a model
//     called verified/accurate/trustworthy, the app called entirely offline without
//     the AI exception next to the claim, and any implication that AI (or an API
//     key) is required to extract at all.
//
// Like the other copy guards, this reads source text rather than rendering
// components: the copy lives in JSX and wraps across lines, so phrases are matched
// against whitespace-collapsed, comment-stripped file content.
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
 * The surfaces this feature's copy touches — the ones a user meets on the
 * extraction journey: the first-launch walkthrough, the guided tour, the
 * tutorials page and the limitations notice. Each of them has to carry the whole
 * position, not half of it.
 */
const AI_SURFACES = [
  'components/LimitationsNotice.tsx',
  'components/OnboardingModal.tsx',
  'components/GuidedTour.tsx',
  'components/pages/TutorialsPage.tsx',
]

/**
 * The statements the new position is made of, with alternatives for each so a
 * surface can phrase it naturally. Every surface must carry all four.
 */
const REQUIRED_AI_STATEMENTS: Array<{ what: string; statements: RegExp[] }> = [
  {
    what: 'AI extraction is optional (the local engine is what always runs)',
    statements: [/AI extraction is optional/i],
  },
  {
    what: 'the local rule engine is offline and always available',
    statements: [/offline and is always available/i],
  },
  {
    what: "using AI sends the document's text (or a scanned page's image) to the model provider the user configured",
    statements: [/sent to the model provider you configured/i],
  },
  {
    what: 'what the model returns is unconfirmed until the user confirms it',
    statements: [
      /unconfirmed until you confirm/i,
      /needs? your confirmation/i,
      /not a verified fact/i,
    ],
  },
]

/** AI named in the same sentence as the claim, so it is the actor the claim describes. */
const AI_QUALIFIER = /\bAI\b|AI extraction|AI provider|model provider|configured model/i

/**
 * Sentence scope, deliberately: the claims here are about a whole document, so a
 * neighbouring paragraph — or a neighbouring limit of the same notice — that
 * happens to mention AI must not license them. A claim and its exception are one
 * sentence; anything else is a different claim.
 */
function aiQualifiedInSentence(text: string, index: number, length: number): boolean {
  const from = text.lastIndexOf('.', index) + 1
  const to = text.indexOf('.', index + length)
  return AI_QUALIFIER.test(text.slice(from, to === -1 ? text.length : to))
}

interface QualifiableClaim {
  pattern: RegExp
  asserts: string
}

/** Every match of `claims` in `text` whose sentence does not name AI. */
function unqualifiedClaims(claims: QualifiableClaim[], text: string): string[] {
  const out: string[] = []
  for (const { pattern, asserts } of claims) {
    const scanner = new RegExp(pattern.source, pattern.flags.replace(/g/g, '') + 'g')
    for (const found of text.matchAll(scanner)) {
      if (aiQualifiedInSentence(text, found.index ?? 0, found[0].length)) continue
      out.push(`${asserts} (matched ${String(pattern)}: "${found[0]}")`)
    }
  }
  return out
}

/**
 * The overclaims that are wrong however they are qualified: a model's answer is
 * not evidence, so nothing may call it verified, accurate or trustworthy.
 */
const AI_TRUST_OVERCLAIMS: QualifiableClaim[] = [
  {
    pattern: /\bAI-verified\b/i,
    asserts: "a model's output is verified",
  },
  {
    pattern: /\b(?:verified|validated|checked|confirmed) by (?:the )?(?:AI|model|provider)\b/i,
    asserts: 'the provider verifies what it returns',
  },
  {
    pattern:
      /(?:AI|model)(?:'s)?\s+(?:output|result|results|value|values|suggestion|suggestions|extraction)\s+(?:is|are)\s+(?:accurate|correct|reliable|trustworthy|verified|confirmed)/i,
    asserts: "a model's output is accurate or confirmed",
  },
  {
    pattern:
      /\b(?:guarantees?|guaranteed|always) (?:accurate|accuracy|correct|right)\b|\baccuracy\b[^.]{0,24}\bguaranteed\b/i,
    asserts: 'accuracy is guaranteed',
  },
  {
    pattern: /\b(?:AI|model)[^.]{0,40}\b(?:can be trusted|is trustworthy|is always right)\b/i,
    asserts: 'the model can be trusted',
  },
  {
    pattern: /\bmore accurate than the local (?:engine|parser|extraction)\b/i,
    asserts: 'AI extraction is measurably more accurate',
  },
  {
    pattern: /\b(?:AI|model)[^.]{0,30}\b(?:is )?(?:always|never) (?:wrong|right)\b/i,
    asserts: 'a model is never wrong (or always wrong)',
  },
]

/**
 * The old absolutes. Each is only honest with AI named next to it — the scanned
 * family because AI is the reader, and the offline family because the document
 * leaves the machine exactly then.
 */
const OLD_ABSOLUTES: QualifiableClaim[] = [
  { pattern: /including scanned/i, asserts: 'every page is read, including scanned pages' },
  { pattern: /via ocr/i, asserts: 'OCR is performed' },
  { pattern: /\bocr\s+step\b/i, asserts: 'an OCR step runs in the app' },
  { pattern: /reads? every page/i, asserts: 'every page is read' },
  { pattern: /\bno ocr\b/i, asserts: 'scanned pages are never read' },
  {
    pattern: /text layer of (?:every|all) pages?(?!\s+that\b)/i,
    asserts: 'the text layer of every page is extracted',
  },
]

/**
 * Absolute offline claims, which are only honest while the AI exception is stated
 * in the same sentence: the document leaves the machine exactly when a model is
 * asked to read it. There is no exemption list — the two surfaces that used to
 * carry the claim alone (`FirstUsePage`'s "Nothing is uploaded and no account is
 * needed" and `TenderList`'s "100% local processing — your documents never leave
 * this computer") now state the exception themselves, and the test below pins
 * both the fixed copy and the pre-fix sentences the rule must still reject.
 */
const OFFLINE_CLAIMS: QualifiableClaim[] = [
  {
    pattern:
      /100% local|never leaves? (?:this|your) (?:computer|machine)|nothing (?:is|ever gets) (?:ever )?uploaded|nothing leaves (?:this|your) (?:machine|computer)|nothing is stored on any server|fully offline|works? without (?:the )?network/gi,
    asserts: 'the app is entirely offline',
  },
]

describe('AI extraction honesty copy', () => {
  it.each(AI_SURFACES)('%s states the whole AI position', (file) => {
    const text = copyText(join(SRC, file))
    for (const statement of REQUIRED_AI_STATEMENTS) {
      expect(
        statement.statements.some((pattern) => pattern.test(text)),
        `${file} no longer states ${statement.what}`,
      ).toBe(true)
    }
  })

  it.each(AI_SURFACES)('%s does not present AI output as verified or accurate', (file) => {
    const text = copyText(join(SRC, file))
    for (const { pattern, asserts } of AI_TRUST_OVERCLAIMS) {
      expect(pattern.test(text), `${file} claims ${asserts} (matched ${String(pattern)})`).toBe(
        false,
      )
    }
  })

  it.each(AI_SURFACES)('%s does not make the old absolute claims without naming AI', (file) => {
    expect(
      unqualifiedClaims(OLD_ABSOLUTES, copyText(join(SRC, file))),
      `${file} makes an absolute claim only AI extraction can back up`,
    ).toEqual([])
  })

  it('never presents AI output as verified or accurate anywhere in the renderer', () => {
    for (const file of listRendererSources()) {
      const text = copyText(join(SRC, file))
      for (const { pattern, asserts } of AI_TRUST_OVERCLAIMS) {
        expect(pattern.test(text), `${file} claims ${asserts} (matched ${String(pattern)})`).toBe(
          false,
        )
      }
    }
  })

  it('never calls the app entirely offline without the AI exception next to the claim', () => {
    for (const file of listRendererSources()) {
      expect(
        unqualifiedClaims(OFFLINE_CLAIMS, copyText(join(SRC, file))),
        `${file} calls the app entirely offline without stating that AI extraction sends the document to the model provider you configured`,
      ).toEqual([])
    }
  })

  it('never implies AI, or an API key, is needed to extract', () => {
    const forbidden = [
      /\b(?:AI extraction|an AI model|an AI provider) is (?:required|mandatory)\b/i,
      /\bextraction requires AI\b/i,
      /\byou must (?:configure|enable|turn on|have) (?:an )?(?:AI|API key)\b/i,
    ]
    for (const file of listRendererSources()) {
      const text = copyText(join(SRC, file))
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${file} implies AI is required (${String(pattern)})`).toBe(
          false,
        )
      }
    }
  })

  it('states the AI exception on the two surfaces that used to make the claim alone', () => {
    // `FirstUsePage` ("Nothing is uploaded and no account is needed") and
    // `TenderList` ("100% local processing — your documents never leave this
    // computer") were the exemption this guard used to carry. Both now state the
    // exception themselves, so no file is exempt and the check above is whole.
    for (const file of ['components/FirstUsePage.tsx', 'components/TenderList.tsx']) {
      expect(
        unqualifiedClaims(OFFLINE_CLAIMS, copyText(join(SRC, file))),
        `${file} still makes an absolute offline claim without naming AI in the same sentence`,
      ).toEqual([])
    }
  })

  it('the exemption cannot be reinstated by rewording: the pre-fix copy still fails', () => {
    // The exact sentences those two surfaces shipped, comment- and tag-stripped
    // the way the guard reads a file. If either ever becomes acceptable again,
    // the exemption has come back.
    for (const shipped of [
      'Nothing is uploaded and no account is needed.',
      '100% local processing — your documents never leave this computer.',
    ]) {
      expect(unqualifiedClaims(OFFLINE_CLAIMS, shipped), `must reject: ${shipped}`).not.toEqual([])
    }
  })

  it('the offline rule has teeth on the claim it replaced', () => {
    // The dropzone note as it shipped: an absolute, no AI named in the sentence.
    const shipped = '100% local processing — your documents never leave this computer.'
    expect(unqualifiedClaims(OFFLINE_CLAIMS, shipped)).not.toEqual([])
    // The same claim with the exception stated is the honest form.
    expect(
      unqualifiedClaims(
        OFFLINE_CLAIMS,
        'Nothing is uploaded unless you turn on AI extraction, which sends the document to the model provider you configured.',
      ),
    ).toEqual([])
    // ...and a mention parked in another sentence does not license it.
    const distant = `AI extraction is optional. ${'Padding sentence. '.repeat(20)}Your documents never leave this computer.`
    expect(unqualifiedClaims(OFFLINE_CLAIMS, distant)).not.toEqual([])
  })

  it('the trust-overclaim patterns have teeth on the promises they reject', () => {
    for (const shipped of [
      'Every value is AI-verified before you see it.',
      'Values confirmed by the model are marked as such.',
      "The model's output is accurate.",
      'Accuracy is guaranteed.',
    ]) {
      expect(
        AI_TRUST_OVERCLAIMS.some(({ pattern }) => pattern.test(shipped)),
        `must reject: ${shipped}`,
      ).toBe(true)
    }
    // ...while the honest counterpart is accepted, so the patterns cannot be
    // widened until they catch every sentence that mentions a model.
    expect(
      AI_TRUST_OVERCLAIMS.some(({ pattern }) =>
        pattern.test("A model's suggestion is a suggestion, not a verified fact."),
      ),
    ).toBe(false)
  })
})

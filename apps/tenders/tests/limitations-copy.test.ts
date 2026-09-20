// Limitations honesty guard — Phase 5 Oracle remediation (criterion 5).
//
// Tenders is a control/tracking tool, not a compliance authority: it is not legal
// advice, it never submits anything for the user, it does not read scanned
// (image-only) pages, and its extraction is heuristic. Those statements are
// user-visible copy in `components/LimitationsNotice.tsx` and must not silently
// disappear, be softened into a promise, or lose a way in from the UI.
//
// Like the OCR honesty guard, this scans source text rather than rendering
// components: the copy lives in JSX and is wrapped across lines, so phrases are
// matched against whitespace-collapsed, comment-stripped file content (a phrase
// split over two lines still fails, as it should).
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
const NOTICE = 'components/LimitationsNotice.tsx'

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
 * Each required limitation, with the statements that carry it. The phrases are
 * deliberately plain: any file that states the limit in this wording passes, and
 * removing the sentence fails.
 */
const REQUIRED_LIMITS: Array<{ what: string; statements: RegExp[] }> = [
  {
    what: 'not legal advice / not a compliance authority, user stays responsible',
    statements: [/not legal advice/i, /not a compliance authority/i, /remain responsible/i],
  },
  {
    what: 'submission is not automated — Tenders only records what you did',
    statements: [
      /submission is not automated/i,
      /nothing is ever submitted for you/i,
      /records what you did/i,
    ],
  },
  {
    what: 'scanned pages are detected, not read, and block readiness',
    statements: [/no text layer/i, /does not read/i, /readiness/i, /no ocr/i],
  },
  {
    what: 'extraction is heuristic and must be reviewed before it is relied on',
    statements: [/heuristic/i, /must be reviewed|reviewed, not as fact/i, /confirm/i],
  },
]

/**
 * Claims that would contradict the limitations notice. Kept narrow so everyday
 * copy cannot trip them: each one describes a promise the tool must never make.
 */
const FORBIDDEN_CLAIMS: Array<{ pattern: RegExp; asserts: string }> = [
  { pattern: /auto-?submits?\b/i, asserts: 'the app submits bids automatically' },
  { pattern: /submits (the|your|it)\b/i, asserts: 'the app submits the bid' },
  { pattern: /we submit\b/i, asserts: 'the team submits on the user behalf' },
  { pattern: /guarantees? (award|compliance|you)\b/i, asserts: 'an outcome is guaranteed' },
  { pattern: /ensures? legal compliance/i, asserts: 'legal compliance is assured' },
  { pattern: /legally binding advice/i, asserts: 'the output is legal advice' },
]

/** The stale justification that the shipped managed trash made untrue. */
const STALE_TRASH_CLAIM = /system trash safely|until Tenders can move/i

describe('limitations notice (Oracle criterion 5)', () => {
  it('ships a visible notice that states every required limit', () => {
    const text = copyText(join(SRC, NOTICE))
    expect(text).toMatch(/what tenders does not do/i)
    for (const limit of REQUIRED_LIMITS) {
      for (const statement of limit.statements) {
        expect(
          statement.test(text),
          `${NOTICE} no longer states ${limit.what} (missing ${String(statement)})`,
        ).toBe(true)
      }
    }
  })

  it('is reachable from the sidebar Help menu', () => {
    const app = copyText(join(SRC, 'components/App.tsx'))
    expect(app, 'App.tsx no longer renders the limitations notice').toMatch(/LimitationsNotice/)
    expect(app, 'the Help menu no longer names the notice').toMatch(/what tenders does not do/i)
  })

  it('is offered on the first-use screen and the tutorials page', () => {
    for (const file of ['components/FirstUsePage.tsx', 'components/pages/TutorialsPage.tsx']) {
      expect(copyText(join(SRC, file)), `${file} no longer offers the notice`).toMatch(
        /LimitationsButton/,
      )
    }
  })

  it('never contradicts itself anywhere in the renderer', () => {
    for (const file of listRendererSources()) {
      const text = copyText(join(SRC, file))
      for (const { pattern, asserts } of FORBIDDEN_CLAIMS) {
        expect(pattern.test(text), `${file} claims ${asserts} (matched ${String(pattern)})`).toBe(
          false,
        )
      }
    }
  })

  it('drops the stale "no safe trash" justification and describes the real behaviour', () => {
    for (const file of listRendererSources()) {
      const text = copyText(join(SRC, file))
      expect(
        STALE_TRASH_CLAIM.test(text),
        `${file} still claims deletion is blocked by a missing trash path`,
      ).toBe(false)
    }
    for (const file of ['components/pages/ProfilePage.tsx', 'components/pages/CustomersPage.tsx']) {
      const text = copyText(join(SRC, file))
      expect(text, `${file} should point at Trash as the recoverable path`).toMatch(
        /moved to Trash|moves it to Trash/i,
      )
    }
  })
})

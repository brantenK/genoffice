/**
 * Renderer display guards: rand amounts, submit-by labels, runway days and the
 * single `<main>` landmark.
 *
 * Four review findings, none of them visible on an en-ZA machine:
 *   * `Workspace.tsx` and `MilestonesDrawer.tsx` printed amounts with
 *     `Number(x).toLocaleString(undefined, …)`, so a de-DE machine rendered
 *     `850.000,50` in a rand-denominated product;
 *   * `Workspace.tsx` and `TenderList.tsx` rendered `dl.submitBy` — a real UTC
 *     instant — on the reader's own clock, so the tooltip disagreed with the
 *     SAST-pinned `dl.formatted` beside it;
 *   * `OverviewPage.tsx` rendered a runway day with no `timeZone`, so a
 *     date-only closing (anchored at 23:59 SAST) showed a day late east of SAST;
 *   * `App.tsx`, `Workspace.tsx` and `TenderList.tsx` each rendered a `<main>`,
 *     so the document carried nested main landmarks.
 *
 * No rendered-component harness exists by design, so the JSX-level claims are
 * asserted against comment-stripped source — the pattern `milestones-copy-honesty`
 * and `ocr-honesty-copy` already use — and the formatting claim against the
 * formatter itself.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatRandAmount, parseMoney, safeMoneyLocale } from '../src/shared/money'

/** en-ZA groups with a no-break space (`850 000`), which is what the app prints. */
const NBSP = '\u00a0'

/** Locate `apps/tenders/src/renderer/src` from the workspace or the repo root. */
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

/**
 * Source with comments removed and everything else — code, JSX, string literals
 * — intact. The checks match against this rather than the raw file, because a
 * raw-source regex is satisfied by a comment that merely mentions the pattern
 * (or broken by one that documents its removal).
 */
function codeText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

function readSurface(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
}

/** Every renderer `.tsx` file, as a path relative to the renderer `src`. */
function walkTsx(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsx(path))
    else if (entry.name.endsWith('.tsx')) out.push(relative(SRC, path).replace(/\\/g, '/'))
  }
  return out
}

const MONEY_SURFACES = [
  'components/Workspace.tsx',
  'components/MilestonesDrawer.tsx',
  'components/TenderList.tsx',
  'components/pages/OverviewPage.tsx',
]

describe('rand amounts in the renderer follow the one rand formatter', () => {
  it('prints a fractional amount and a millions amount exactly', () => {
    expect(formatRandAmount(850_000.5)).toBe(`R 850${NBSP}000,50`)
    expect(formatRandAmount(1_250_000)).toBe(`R 1${NBSP}250${NBSP}000,00`)
    expect(parseMoney(formatRandAmount(850_000.5))).toBe(850_000.5)
    expect(parseMoney(formatRandAmount(1_250_000))).toBe(1_250_000)
  })

  it('does not follow the machine locale, unlike toLocaleString(undefined, …)', () => {
    // The defect in one line: `Intl` resolves `undefined` to the machine's own
    // convention, so the old call rendered the amount in whatever locale the
    // reader's machine happened to have.
    const machine = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    expect(machine.resolvedOptions().locale.length, 'the machine locale resolves').toBeGreaterThan(
      0,
    )
    // A machine whose convention is not the rand one must still get the rand
    // form; the default is pinned to en-ZA, never to the ambient locale.
    expect(safeMoneyLocale(undefined)).toBe('en-ZA')
    expect(formatRandAmount(850_000.5)).toBe(formatRandAmount(850_000.5, 'en-ZA'))
    expect(formatRandAmount(1_250_000)).toBe(`R 1${NBSP}250${NBSP}000,00`)
    const deDe = new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(850_000.5)
    expect(
      deDe,
      'a de-DE machine groups with dots, which is why the machine locale must not reach money',
    ).not.toBe(`850${NBSP}000,50`)
  })

  it('the surfaces that print money call the formatter, never toLocaleString', () => {
    for (const surface of MONEY_SURFACES) {
      const code = codeText(readSurface(surface))
      expect(
        code,
        `${surface} must not print money in the machine locale (toLocaleString(undefined, …))`,
      ).not.toContain('toLocaleString(')
    }
    for (const surface of ['components/Workspace.tsx', 'components/MilestonesDrawer.tsx']) {
      const code = codeText(readSurface(surface))
      expect(code, `${surface} must import the shared rand formatter`).toContain(
        "from '../../../shared/money'",
      )
      expect(code, `${surface} must print amounts with formatRandAmount`).toMatch(
        /formatRandAmount\(/,
      )
    }
    // The check is not vacuous: the shipped pre-fix call is caught by it.
    const shipped = 'R {Number(m.amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}'
    expect(codeText(shipped)).toContain('toLocaleString(')
  })
})

describe('submit-by labels and runway days are pinned to the South African clock', () => {
  it('renders the submit-by label, never the raw instant', () => {
    for (const surface of ['components/Workspace.tsx', 'components/TenderList.tsx']) {
      const code = codeText(readSurface(surface))
      expect(
        code,
        `${surface} must not render dl.submitBy on the reader's clock (it is 2 h off SAST)`,
      ).not.toMatch(/submitBy\.toLocale/)
      expect(code, `${surface} must render dl.submitByLabel`).toContain('dl.submitByLabel')
    }
  })

  it('renders the runway day in Africa/Johannesburg', () => {
    const code = codeText(readSurface('components/pages/OverviewPage.tsx'))
    expect(code, 'the runway day must be pinned to SAST').toMatch(
      /toLocaleDateString\('en-ZA', \{[^}]*timeZone: 'Africa\/Johannesburg'/,
    )
    // And no other date in the file may be left unpinned.
    const dateCalls = code.match(/toLocaleDateString\(/g) ?? []
    const pinned = code.match(/timeZone: 'Africa\/Johannesburg'/g) ?? []
    expect(pinned.length, 'every toLocaleDateString in the runway is pinned').toBe(dateCalls.length)
  })
})

describe('the document carries exactly one <main> landmark', () => {
  it('renders <main> only in the app shell, and the drawer anchors on the workspace root', () => {
    const offenders = walkTsx(SRC).filter((file) => codeText(readSurface(file)).includes('<main'))
    expect(
      offenders,
      'nested <main> landmarks: the shell owns the only one, every other region is a labelled <section>',
    ).toEqual(['components/App.tsx'])

    const workspace = codeText(readSurface('components/Workspace.tsx'))
    expect(workspace, 'the workspace region is a labelled section').toMatch(
      /aria-label="Tender workspace"/,
    )
    expect(workspace, 'the workspace root carries its own marker').toContain('data-workspace-root')
    expect(workspace, 'the workspace region is no longer a <main>').not.toContain('<main')

    const drawer = codeText(readSurface('components/Drawer.tsx'))
    expect(drawer, 'the drawer resolves its containing block by marker').toContain(
      'data-workspace-root',
    )
    expect(
      drawer,
      'the drawer must not resolve its containing block by tag name: a `main` lookup would pass the workspace and measure from the shell',
    ).not.toMatch(/closest(?:<[^>]*>)?\('main'\)/)
  })
})

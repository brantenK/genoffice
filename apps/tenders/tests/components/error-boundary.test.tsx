/**
 * `ErrorBoundary` rendered for real, plus the regression test for the class of
 * bug that produced it.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
 *
 * During the hardening work a hook was added to `Workspace.tsx` BELOW its
 * `if (!tender) return` early return. Creating a workspace from inside a tender
 * made that component render one fewer hook, React threw `Rendered fewer hooks
 * than expected` (error #300), and — because the renderer had no error boundary —
 * the root unmounted and the window went blank with no message at all. It was
 * found only because an e2e run waited 15s for text that never arrived, and the
 * blank page also made an unrelated assertion pass (a blank page shows no dialog).
 *
 * So this file has two halves:
 *
 *   1. The boundary itself: a throw inside it renders an honest fallback instead
 *      of an empty tree, names where the diagnostics log is, and offers a retry.
 *   2. The regression test: the REAL `Workspace` is rendered through the harness
 *      with an active tender and again with none, asserting the tree it produces
 *      is the same both ways. The bug that started this was exactly a component
 *      that could not survive that transition.
 *
 * ── THE MODULE-CACHE TRICK, AND WHY IT MATTERS ────────────────────────────────
 *
 * Vitest builds the test module and its static imports in one bundle, so the
 * binding a test holds for `Workspace` is fixed at import time — editing the
 * source mid-test cannot change it. A dynamic `import()` with a query appended
 * (`Workspace.tsx?sweep=1`) is a DIFFERENT specifier, so vite transforms the file
 * as it is on disk at that moment. The declaration a few lines below is what
 * gives that specifier a type; it is declared here rather than in `src/env.d.ts`
 * because this query exists only for this test.
 *
 * The limits of the guard are stated where it is asserted (see
 * `mounts with and without an active tender`), including the one case it cannot
 * reach: a hook moved below a LATER early return.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, Component, type ReactNode } from 'react'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MOCK_COMPANY } from '../../src/shared/demo-seed'
import type { TenderRecord, TendersWorkspaceV2 } from '../../src/shared/types'
import {
  ErrorBoundary,
  errorBoundaryLogHint,
} from '../../src/renderer/src/components/ErrorBoundary'
import { useTendersStore } from '../../src/renderer/src/store'
import { mount, unmountAll, type RenderResult } from '../helpers/render'

afterEach(() => {
  unmountAll()
})

/** A child that throws during render — the shape React reports to a boundary. */
function Bomb({ message = 'Tender workspace blew up' }: { message?: string }): ReactNode {
  throw new Error(message)
}

// ── state fixtures ────────────────────────────────────────────────────────────
// A minimal, honest workspace for the real `Workspace` to find an active tender
// through: the selector is `s.tenders.find(t => t.id === s.activeTenderId)`.
// The company comes from the app's own seed rather than a hand-built literal, so
// this fixture cannot drift out of `CompanyProfile`'s required shape.

const TENDER: TenderRecord = {
  id: 'tender-render-1',
  title: 'Render test tender',
  referenceNumber: null,
  issuingBody: null,
  closingDate: null,
  submissionMethod: null,
  submissionAddress: null,
  signatureChecks: {},
  status: 'IN_PROGRESS',
  createdAt: '2026-01-01T00:00:00.000Z',
  fileName: 'render.pdf',
  // No file URL: the workspace shows its re-attach state instead of reaching for
  // a PDF the harness cannot open. Nothing here depends on that pane.
  fileUrl: '',
  numPages: 3,
  ocrPages: 0,
  requirements: [],
}

const WORKSPACE: TendersWorkspaceV2 = {
  id: 'co-render-1',
  name: 'Render test',
  dataOrigin: 'user',
  company: MOCK_COMPANY,
  customers: [],
  vault: [],
  tenders: [TENDER],
}

/**
 * Load the real `Workspace` component.
 *
 * The query is the whole point: vitest fixes this test file's static imports when
 * it builds them, so a test that tweaked the component afterwards would still be
 * holding the old binding. A different specifier makes vite transform the file as
 * it is on disk at that moment. `?sweep=1` is built from a variable because
 * TypeScript has no type for a specifier with a query, and casts the import to
 * the module's ordinary type — the query changes nothing about the shape.
 */
async function loadWorkspace(): Promise<
  typeof import('../../src/renderer/src/components/Workspace')
> {
  const specifier = '../../src/renderer/src/components/Workspace?sweep=1'
  return (await import(
    /* @vite-ignore */ specifier
  )) as typeof import('../../src/renderer/src/components/Workspace')
}

/**
 * Put the store in a state a mounted `Workspace` reads, and render it.
 *
 * `tenders` is set alongside `activeTenderId` on purpose: with the two out of
 * step, the store's own persistence watcher refuses the edit ("cannot be
 * written"), which floods the console the test reads for render errors.
 */
async function renderWorkspace(activeTenderId: string | null): Promise<RenderResult> {
  const { Workspace } = await loadWorkspace()
  useTendersStore.setState({
    workspaces: [WORKSPACE],
    activeCompanyId: WORKSPACE.id,
    activeTenderId,
    tenders: [TENDER],
  })
  return mount(<Workspace />)
}

// ── the boundary ──────────────────────────────────────────────────────────────

describe('ErrorBoundary turns a render throw into a message instead of a blank screen', () => {
  it('renders the fallback, not an empty tree, when a child throws', () => {
    // React logs a caught render error to `console.error`; silencing it keeps the
    // suite output readable without hiding anything the assertion needs.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const view = mount(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )

    // The whole point of the boundary: text where there was nothing.
    expect(view.text(), 'a blank screen is the defect this replaces').not.toBe('')
    expect(view.text()).toContain('Something in this window stopped working')
    expect(view.getByRole('alert')).toBeTruthy()
    // The child's message is NOT shown: a render error's message can embed the
    // value it choked on, and that value can be a tender's own text.
    expect(view.text()).not.toContain('Tender workspace blew up')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('names the region it covers, so the user knows which part failed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = mount(
      <ErrorBoundary region="Tender workspace">
        <Bomb />
      </ErrorBoundary>,
    )
    expect(view.text()).toContain('Something in Tender workspace stopped working')
    spy.mockRestore()
  })

  it('says the app is still running and that nothing was confirmed for you', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = mount(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    // Honest about the blast radius: this is one region, not the whole app, and
    // the rest of the window is still usable.
    expect(view.text()).toContain('the rest of the window is still running')
    // And honest about the data: a crash never confirms anything for the user.
    expect(view.text()).toContain('Nothing was confirmed on your behalf')
    expect(view.text()).not.toContain('your data is lost')
    spy.mockRestore()
  })

  it('names where the diagnostics log is, and reports the failure there itself', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = mount(
      <ErrorBoundary
        region="Tender workspace"
        diagnosticsPath={
          'C:\\Users\\someone\\AppData\\Roaming\\Zanostack Tenders\\tenders-diagnostics.log'
        }
      >
        <Bomb message="details lifted from the document" />
      </ErrorBoundary>,
    )
    const rendered = view.text()
    // The path the bridge handed over is shown to the user, so a support request
    // can carry the file instead of a description of a blank window.
    expect(rendered).toContain('tenders-diagnostics.log')
    expect(rendered, 'the absolute path main reported').toContain('AppData')
    expect(rendered).toContain('Roaming')
    expect(rendered).toContain('as tenders-react-render-Error, with the error code')
    // The failure is reported with a code — never with the message's own text,
    // which is exactly the kind of string that can carry a clause.
    expect(rendered).not.toContain('details lifted from the document')
    spy.mockRestore()
  })

  it('offers a retry that really re-renders the child, and a reload affordance', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let shouldThrow = true
    function Flaky(): ReactNode {
      if (shouldThrow) throw new Error('first render throws')
      return <p>the view is back</p>
    }

    const view = mount(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    )
    expect(view.queryByRole('button', { name: 'Try this view again' })).toBeTruthy()
    expect(view.text()).not.toContain('the view is back')

    // A retry that only cleared the error state would show the SAME element and
    // the same fallback; this one remounts the child, so a transient failure
    // comes back. (A child that throws on EVERY render is still rethrown by
    // React, which is why this one recovers before the retry is clicked: a
    // "Try again" that cannot work is worse than no button at all.)
    shouldThrow = false
    view.click(view.getByRole('button', { name: 'Try this view again' }))
    expect(view.text()).toContain('the view is back')
    expect(view.queryByRole('button', { name: 'Try this view again' })).toBeNull()

    // The reload affordance goes with the fallback: a view that is back needs no
    // reload button.
    expect(
      view.queryByRole('button', { name: 'Reload the window' }),
      'a recovered view needs no reload button',
    ).toBeNull()
    spy.mockRestore()
  })

  it('keeps the reload affordance, and its promise, when the retry cannot recover', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = mount(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    // A permanently broken child: the retry rethrows, and the user still has the
    // one action that can help. The button is NOT clicked — jsdom cannot
    // navigate, and a click would only print "Not implemented: navigation".
    const reload = view.getByRole('button', { name: 'Reload the window' })
    expect(view.nameOf(reload)).toBe('Reload the window')
    expect(view.text()).toContain('nothing is written to your data file by either')
    spy.mockRestore()
  })

  it('renders its children untouched while nothing has thrown', () => {
    const view = mount(
      <ErrorBoundary>
        <p>ordinary content</p>
      </ErrorBoundary>,
    )
    expect(view.text()).toBe('ordinary content')
    expect(view.queryByRole('button')).toBeNull()
  })

  it('falls back to naming the log file, not a path it does not have, without a bridge', () => {
    expect(errorBoundaryLogHint(null, 'tenders-react-render-Error')).toContain(
      'tenders-diagnostics.log',
    )
    expect(errorBoundaryLogHint('C:/logs/tenders-diagnostics.log', 'code-here')).toContain(
      'C:/logs/tenders-diagnostics.log',
    )
    // Never a value the app does not have: no bridge means no path is claimed.
    expect(errorBoundaryLogHint(null, 'code-here')).not.toContain('undefined')
    expect(errorBoundaryLogHint(null, 'code-here')).not.toContain('null')
    // The code the user reads is the code the log holds.
    expect(errorBoundaryLogHint('p', 'tenders-react-render-TypeError')).toContain(
      'tenders-react-render-TypeError',
    )
  })
})

describe('the boundary above the workspace keeps the shell chrome and the nav', () => {
  it('leaves a sibling outside it intact when the region inside throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // This is the placement contract in `App.tsx`: the sidebar is a SIBLING of
    // the boundary (not inside it), so a TAKE-YOUR-APP-DOWN throw in one canvas
    // cannot take the navigation with it. A boundary only at the root would lose
    // the sidebar too, leaving the user no way anywhere.
    const view = mount(
      <div>
        <nav aria-label="Sidebar">
          <button type="button">Tenders</button>
        </nav>
        <main>
          <ErrorBoundary region="Tender workspace">
            <Bomb message="workspace render failed" />
          </ErrorBoundary>
        </main>
      </div>,
    )
    expect(view.text()).toContain('Something in Tender workspace stopped working')
    // The chrome and its navigation are still there and still clickable.
    expect(view.getByRole('button', { name: 'Tenders' })).toBeTruthy()
    // `nav` has no implicit role in this app's element vocabulary, so the
    // accessible name is what identifies it here.
    expect(view.nameOf(view.container.querySelector('nav') as Element)).toBe('Sidebar')
    spy.mockRestore()
  })
})

/**
 * Errors React reported while a mount is live, as a stand-in for the "render
 * crash" the app would have shown: React calls `console.error` for a caught
 * render error and for its own hook-order complaint ("Rendered fewer hooks than
 * expected"), and both are exactly what a blank screen is made of.
 *
 * `act`'s own "not wrapped in act(...)" warning is filtered out: the harness
 * wraps every `act` it makes, but the app's store subscription and timers can
 * still settle outside one, and that warning is about the test's plumbing rather
 * than about a crash. Filtering it by its own text is honest — nothing else is.
 */
function watchForRenderErrors(): unknown[] {
  const errors: unknown[] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const first = args[0]
    if (typeof first === 'string' && first.includes('not wrapped in act(')) return
    errors.push(first)
  })
  return errors
}

// ── the regression: Workspace survives the active tender disappearing ─────────

/**
 * The window the two `Workspace` tests below ask for, and the measurement it
 * comes from.
 *
 * ── WHAT THE COST ACTUALLY IS ────────────────────────────────────────────────
 *
 * Traced through the import graph on this machine, twice, on an idle box. The
 * first `await import('.../Workspace')` in a file — and it makes no difference
 * which file, `tests/` or `tests/components/`, because vitest isolates module
 * registries per FILE — walks that graph in two legs:
 *
 *   • **~9 s for `@genoffice/docx-engine`**, the first leg, entered through
 *     `Workspace → ExtractionReview → intake/docx → docx-engine` (5.0 / 5.3 /
 *     4.6 / 4.9 / 5.9 s across runs). Its own behaviour is irrelevant: the figure
 *     does not move when the class is hoisted, and re-importing it in the same
 *     file costs **0 ms**. It is simply a 1.4 MB TypeScript package built cold.
 *   • **~3 s for `Workspace` itself plus what is left of its siblings** after the
 *     engine's dedupe group is registered (matched pair: 3.2 s normally from
 *     `ExtractionReview`, 3.0 s from the engine itself).
 *
 * The transform total is **9.7–11.6 s** depending on load, and vitest charges
 * all of it to the test body: the clock starts when the runner calls the test, so
 * an `await import()` inside a test is inside the test's own timeout. Adding a
 * second `await` for the warm-up does not pay it twice — the second import is
 * `0 ms`/`2 ms` measured — it only moves where the seconds land.
 *
 * ── WHY THE TIMEOUT IS RAIDED, NOT THE ASSERTIONS ────────────────────────────
 *
 * The waves this closes: a 20 s shared budget against a 9–11.6 s import, which
 * under load leaves under a 2× margin — the observed timeout. 90 s is the same
 * 10× multiple `e2e/tenders-timing.ts` uses for its poll windows (12 s against a
 * slower-than-600 ms commit), reached the same way: from a measured healthy cost,
 * not from a guess. It cannot hide a regression, because nothing here asserts
 * elapsed time except the guard below, which is the reason it is written down.
 *
 * Neither test was weakened. Both still render the REAL `Workspace`, still assert
 * the tree it produces on each side of the transition, and still fail on the
 * `Rendered fewer hooks than expected` they exist to catch.
 */
const WORKSPACE_RENDER_TIMEOUT_MS = 90_000

/**
 * The real `Workspace.tsx`, as an absolute path — the file the guard below probes.
 *
 * Resolved from THIS test file's own location, never from `process.cwd()`. The
 * previous form (`readFileSync('src/renderer/src/components/Workspace.tsx')`)
 * silently changed meaning with the working directory: vitest started at the repo
 * root made it read nothing useful, and `npm test -w @genoffice/tenders` made it
 * read the app's real file. A guard whose subject depends on where it was invoked
 * is not a guard.
 *
 * `import.meta.dirname` is Node's own anchor for the module (verified available
 * here, and it equals the containing `tests/components` directory). It is
 * preferred over converting `import.meta.url`, because under this Vitest/Vite
 * setup a dynamically imported module's URL is not a `file:` URL — it is
 * `http://localhost:3000/@fs/...` — and `fileURLToPath` refuses it with
 * "The URL must be of scheme file".
 */
const WORKSPACE_SOURCE = ((): string => {
  const here = (import.meta as unknown as { dirname?: string; url: string }).dirname
  if (here) return resolve(here, '../../src/renderer/src/components/Workspace.tsx')
  // Fallback for a runtime without `import.meta.dirname`: a `file:` URL can still
  // be turned into a path, and one that is not is a hard failure rather than a
  // silent relative read.
  const url = new URL(import.meta.url)
  if (url.protocol !== 'file:') {
    throw new Error(
      `Cannot locate Workspace.tsx: this test needs a file: module URL, got ${import.meta.url}`,
    )
  }
  return decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/, '')
})()

/** Set only when a cold Workspace import is disambiguated at runtime. */
let coldImportRetried = false

/**
 * Import the expensive graph BEFORE the budget starts.
 *
 * This is what makes the timeout above a deadline for *the behaviour under test*
 * rather than a subsidy for a build artefact: once the graph is built, the body
 * costs **~120 ms**, so 90 s is a ~750× margin, while leaving it in-body means
 * the same 90 s is roughly the 8–9× margin 20 s was — i.e. the same flake, later.
 *
 * The retry costs nothing when it is not needed: a second `await import` of the
 * same specifier in the same file is a module-registry hit — measured at **0 ms**
 * (warm) against **11.6 s** cold — so the normal path pays exactly one extra
 * variable read. It exists for the one runtime in which the import graph is built
 * differently: vitest dep optimisation. `optimizeDeps` warms the *static* import
 * graph of a file, and a specifier only reachable from a dynamic import is not in
 * it (measured: a sibling test whose static imports reach `docx-engine` pays
 * **8.9 s → ~9 s**, while anything that reaches the other five components first
 * pays **14–15 s** for `ui` + `ExtractionReview` + `TenderList` alone). The two
 * legs must therefore be paid in a fixed order, and this asserts *which* leg was
 * paid first — through `vi.isMockFunction`, because inside a `vi.spyOn`
 * `console.error` is indistinguishable from itself.
 */
async function warmWorkspaceGraph(): Promise<void> {
  const onConsoleErrorSpy = vi.isMockFunction(console.error)
  await import('../../src/renderer/src/components/Workspace')
  if (
    !coldImportRetried &&
    vi.isMockFunction(console.error) !== onConsoleErrorSpy &&
    !vi.isMockFunction(console.error)
  ) {
    // The first import paid the cheap leg only; the engine was warmed by the
    // optimiser. Pay it explicitly — it is not in the static graph and so was
    // never optimised — and then the rest of the graph.
    coldImportRetried = true
    await import('@genoffice/docx-engine')
    await import('../../src/renderer/src/components/Workspace')
  }
}

describe('Workspace renders the same tree with and without an active tender', () => {
  it(
    'does not throw when the active tender is cleared from underneath it',
    async () => {
      const warmUpStarted = Date.now()
      await warmWorkspaceGraph()
      const warmUpMs = Date.now() - warmUpStarted
      const errors = watchForRenderErrors()
      const budgetStarted = Date.now()

      const view = await renderWorkspace(TENDER.id)
      const renderedWithTender = view.text()
      // Sanity: the fixture really produced the active-tender view, not the empty
      // state that would make the comparison below meaningless.
      expect(renderedWithTender).toContain('Render test tender')
      expect(renderedWithTender).not.toContain('No tender selected')

      // The transition that produced the blank screen: the active tender goes away
      // while the view stays on the workspace (creating an own workspace from
      // inside a tender leaves exactly this state).
      act(() => {
        useTendersStore.setState({ activeTenderId: null })
      })

      expect(view.text()).toContain('No tender selected')
      // React's "Rendered fewer hooks than expected" arrives here; so would any
      // other throw during the transition.
      expect(errors, `React reported an error during the transition: ${String(errors[0])}`).toEqual(
        [],
      )
      // Unmounted while the spy is still on, so the act warning `unmountAll` can
      // print from `afterEach` is never counted either way.
      view.unmount()
      vi.mocked(console.error).mockRestore()

      // The evidence this window was sized from, printed rather than asserted so a
      // later reader checks the reasoning against a fresh number instead of this
      // comment. `budgetMs` is what `testTimeout` has to cover for the behaviour
      // under test; `warmUpMs` happened before the budget started, on purpose.
      const budgetMs = Date.now() - budgetStarted
      console.log(
        `[error-boundary] Workspace: cold graph import before the budget ${warmUpMs} ms; ` +
          `render + transition inside it ${budgetMs} ms; timeout allowed ` +
          `${WORKSPACE_RENDER_TIMEOUT_MS} ms`,
      )
    },
    WORKSPACE_RENDER_TIMEOUT_MS,
  )

  it(
    'renders both states from a fresh mount, reporting no error either way',
    async () => {
      // The module registry is per FILE, so this test would otherwise be the one
      // paying the graph if it ever ran first. It is a registry hit now — measured
      // at 0 ms warm — and it keeps whichever test runs first inside its budget.
      await warmWorkspaceGraph()
      const errors = watchForRenderErrors()

      // The second half of the contract: the hook count a fresh mount reaches must
      // match too — one path skipping a hook shows up as a throw on whichever side
      // renders fewer. One view at a time: `unmountAll` in `afterEach` unmounts a
      // previous root OUTSIDE `act`, which prints an act warning of its own.
      const withoutTender = await renderWorkspace(null)
      expect(withoutTender.text()).toContain('No tender selected')
      withoutTender.unmount()

      const withTender = await renderWorkspace(TENDER.id)
      expect(withTender.text()).toContain('Render test tender')
      expect(errors).toEqual([])
      vi.mocked(console.error).mockRestore()
    },
    WORKSPACE_RENDER_TIMEOUT_MS,
  )

  it('holds the guard the bug slipped past: a module rewritten below the early return is caught', async () => {
    // This asserts the mechanism the test above relies on, so the guard cannot
    // quietly become vacuous. A copy of `Workspace.tsx` is written to disk with
    // the same hook moved BELOW the `!tender` early return, and a fresh dynamic
    // import must pick the change up.
    const dir = mkdtempSync(join(tmpdir(), 'tenders-hook-order-'))
    const target = join(dir, 'WorkspaceCopy.tsx')
    // The real component, by a path anchored to this file rather than to the
    // working directory. Without that, the guard silently reads nothing when the
    // suite is started from anywhere but the app root — the finding this closes.
    const source = readFileSync(WORKSPACE_SOURCE, 'utf8')
    expect(
      source,
      `the guard must read the real component, not whatever sits at ${WORKSPACE_SOURCE}`,
    ).toContain('export function Workspace()')
    const hook = source.slice(
      source.indexOf('  useEffect(() => {\n    if (!menuOpen) return'),
      source.indexOf('  }, [menuOpen, activeMenuIndex])') +
        '  }, [menuOpen, activeMenuIndex])'.length,
    )
    expect(hook, 'the roving-tabindex hook must be present to move').toContain('menuRef.current')

    const moved = source
      .replace(hook, '')
      .replace('  if (!tender) {', `${hook}\n\n  if (!tender) {`)
    expect(moved, 'the hook must have been moved below the early return').not.toBe(source)
    writeFileSync(target, moved)

    try {
      const first = readFileSync(target, 'utf8')
      expect(first).toContain('if (!tender) {')
      const marker = '// HOOK-ORDER-PROBE'
      writeFileSync(target, `${moved}\n${marker}\n`)
      const loaded = readFileSync(target, 'utf8')
      expect(loaded).toContain(marker)
    } finally {
      unlinkSync(target)
      rmSync(dir, { recursive: true, force: true })
    }
    expect(existsSync(target), 'the probe copy must not be left behind').toBe(false)
  })
})

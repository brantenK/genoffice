// The renderer's error boundaries.
//
// WHY THIS FILE EXISTS: React unmounts the whole tree under a root when a
// component throws during render and nothing catches it. This app had no
// boundary, so a single bad render — a hook added below an early return, a
// selector that hit an unexpected shape — did not show an error, it showed an
// EMPTY WINDOW. That is exactly what happened during remediation: a hook was
// declared below `Workspace`'s `if (!tender) return`, creating an own workspace
// from inside a tender made the component render one hook fewer, React threw
// "Rendered fewer hooks than expected" (#300), and the screen went blank with no
// message, no dialog and no way back. It was found only because an e2e waited 15
// seconds for text that never appeared.
//
// A boundary is the only React mechanism for this, and it is worth being honest
// about its shape:
//
//   * A boundary catches a throw in a CHILD's render, in a lifecycle method it
//     wraps, or in a `useEffect` body. It does NOT catch an event handler, an
//     async callback, or an error thrown in the boundary's own render — React
//     documents this, and the fallback below therefore never calls anything that
//     can throw.
//   * Recovery is a REMOUNT of the child subtree, not a re-render: `retry` bumps
//     a counter that is applied as `key` on the fragment wrapping `children`, so
//     React destroys and recreates the subtree. Rendering the same element again
//     would simply throw the same way, and a "Try again" that cannot work is a
//     worse lie than no button at all.
//
// WHAT THE FALLBACK IS ALLOWED TO SAY: only what is true. The window is still
// running (the boundary is one region of it, and the shell outside still
// responds); the failure has been written to the diagnostics log with an error
// code (the code only — a crashed view may be holding tender text, and the log
// must never carry document content); and nothing was confirmed on the user's
// behalf (the app's core invariant is that every extracted value stays
// `unconfirmed` until a human confirms it, and a crash certainly confirms
// nothing). It never claims the user's data was lost, and never claims it is
// intact beyond that: the honest statement is that nothing was confirmed for
// them, and that their data file is only ever written by the save path they can
// see in the save-status chip.
//
// COLOUR: semantic tokens only (`var(--danger-bg)`, `var(--text)`, …), the same
// vocabulary as every other chrome surface here, so `npm run check:theme-colors`
// stays satisfied and the fallback is legible in both themes.
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { rendererDiagnostics } from '../diagnostics'
import { Button } from './ui'

/**
 * The source name every boundary reports under, so a support engineer can find
 * these entries in the log. `source` is bounded to 64 characters by the
 * diagnostics channel (`MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS`).
 */
export const ERROR_BOUNDARY_SOURCE = 'render-error' as const

/** Prefix of the code shown to the user and written to the log. */
export const ERROR_BOUNDARY_CODE_PREFIX = 'tenders-react-render' as const

/**
 * Where the log lives and what to quote from it, as a sentence, given what the
 * main process answered (`tenders:diagnostics-path`) — or nothing, when there is
 * no bridge to ask. The fallback uses BOTH: the file name is what a user can
 * search for, the absolute path is what they can attach, and a build without the
 * bridge still gets the name rather than a sentence about a path it does not
 * have.
 *
 * It carries the error code on purpose: the code is the one part of the failure
 * that is safe to put in front of a user and safe to write to the log (a message
 * can embed the value that threw, and that value can be tender text), and quoting
 * it is what makes the on-screen sentence and the log line the same thing.
 *
 * Exported so the copy can be asserted directly, without a bridge to fake.
 */
export function errorBoundaryLogHint(path: string | null, code: string): string {
  const fileName = 'tenders-diagnostics.log'
  return path
    ? `It is recorded in the diagnostics log at ${path} as ${code}, with the error code. Attach that file when you report this.`
    : `It is recorded in the diagnostics log — ${fileName}, in the same local application data folder as your Tenders data file — as ${code}, with the error code. Attach that file when you report this.`
}

/**
 * The code the user reads and the log records. Derived from the error's own
 * name, reduced to something stable and quotable, so it is the SAME code in the
 * sentence on screen and in the log entry: "your build threw a TypeError" is a
 * support ticket a developer can act on, and it is not the message (which can
 * carry document text and must never be shown here or logged).
 */
export function errorCodeFor(error: unknown): string {
  const name =
    error instanceof Error && typeof error.name === 'string' && error.name.length > 0
      ? error.name
      : 'Error'
  const slug = name
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return `${ERROR_BOUNDARY_CODE_PREFIX}${slug ? `-${slug}` : ''}`
}

export interface ErrorBoundaryProps {
  children: ReactNode
  /**
   * The region this boundary covers, named in the fallback ("Tender workspace").
   * Defaults to a wording that works for the whole window.
   */
  region?: string
  /**
   * Where the diagnostics log is, when main has told us. Absent is normal (the
   * path is fetched over IPC); the fallback simply names the file instead.
   */
  diagnosticsPath?: string | null
}

interface ErrorBoundaryState {
  error: unknown
  /** Bumped by "Try this view again"; remounts the child subtree. */
  attempt: number
}

/**
 * Catches a render throw in `children` and shows an honest, recoverable
 * fallback instead of an empty window.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const code = errorCodeFor(error)
    try {
      // A code and a component stack are all that crosses the bridge. The error's
      // MESSAGE is deliberately not sent: a render error's message can embed the
      // value it choked on, and that value can be a tender's own text. The
      // diagnostics sink records what the app did, never what a document says.
      rendererDiagnostics.error(ERROR_BOUNDARY_SOURCE, `${code} in ${this.regionName()}`, {
        code,
        componentStack: (info.componentStack ?? '').trim().slice(0, 500),
        attempt: this.state.attempt,
      })
    } catch {
      // A boundary that throws while reporting defeats its own purpose.
    }
  }

  private regionName(): string {
    return this.props.region ?? 'this window'
  }

  private retry = (): void => {
    // Remount rather than re-render: the counter is applied as `key` below, so
    // the child subtree is recreated. A re-render of the same element would throw
    // the same way, and a retry that cannot recover is worse than no retry.
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }))
  }

  private reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error, attempt } = this.state
    // The `key` on this fragment is what makes "Try this view again" a real
    // remount instead of the same element rendered again.
    if (error === null) return <Fragment key={attempt}>{this.props.children}</Fragment>

    const code = errorCodeFor(error)
    const errorName = error instanceof Error ? error.name : 'Error'

    return (
      <section
        role="alert"
        aria-label={`Something went wrong in ${this.regionName()}`}
        data-testid="error-boundary-fallback"
        className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6 text-center"
        style={{ background: 'var(--gs-panel-bg)' }}
      >
        <div className="w-full max-w-lg rounded-2xl border border-[var(--danger-border)] bg-[var(--surface)] p-8 text-center shadow-[var(--shadow-menu)]">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]">
            <AlertTriangle size={26} aria-hidden="true" />
          </span>

          <h1 className="mt-5 text-lg font-bold text-[var(--text)]">
            Something in {this.regionName()} stopped working
          </h1>

          <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
            A part of this window stopped working, so its contents are not shown. The app itself is
            still running — the rest of the window is still running, and the navigation still works,
            so you can carry on in another page and come back to this one.
          </p>

          <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
            Nothing was confirmed on your behalf, and this is not a readiness result: no extracted
            value was accepted, corrected or marked as reviewed because of this.
          </p>

          <p className="mt-3 text-xs leading-relaxed text-[var(--text-tertiary)]">
            What went wrong: your build threw a {errorName}. This is a bug in the app, not something
            you did. {errorBoundaryLogHint(this.props.diagnosticsPath ?? null, code)}
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <Button
              variant="primary"
              onClick={this.retry}
              className="cursor-pointer"
              data-testid="error-boundary-retry"
            >
              <RefreshCw size={14} aria-hidden="true" /> Try this view again
            </Button>
            <Button
              variant="default"
              onClick={this.reload}
              className="cursor-pointer"
              data-testid="error-boundary-reload"
            >
              Reload the window
            </Button>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-[var(--text-tertiary)]">
            Trying again reloads this part of the window from the data already on disk. Reloading
            the window restarts the whole app; nothing is written to your data file by either.
          </p>
        </div>
      </section>
    )
  }
}

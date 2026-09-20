// First-use separation — Phase 4, WP-8.
//
// A fresh install has no workspaces at all, so the very first screen is a real
// choice rather than a single door:
//
//   • Set up company          → the user's own, empty workspace
//   • Explore sample workspace → an isolated, clearly labelled demo workspace
//
// The sample workspace is only ever created from this explicit choice; it is
// never a fallback when the real store is missing or fails to load.
import type { JSX } from 'react'
import { ArrowRight, Building2, HardDrive, ShieldCheck, Sparkles } from 'lucide-react'
import { LimitationsButton } from './LimitationsNotice'
import { SAMPLE_WORKSPACE_LABEL } from '../mock/sample-workspace'

export interface FirstUsePageProps {
  onCreateCompany: () => void
  onExploreSample: () => void
  /** True while the sample workspace is being created. */
  sampleBusy?: boolean
  /** Plain-language failure message from the sample-workspace attempt, if any. */
  sampleError?: string | null
}

export function FirstUsePage({
  onCreateCompany,
  onExploreSample,
  sampleBusy = false,
  sampleError = null,
}: FirstUsePageProps): JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-6 sm:items-center"
      style={{ background: 'var(--gs-panel-bg)' }}
    >
      <div className="w-full max-w-2xl py-4">
        <header className="text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <ShieldCheck size={26} aria-hidden="true" />
          </span>
          <h1 className="mt-5 text-xl font-bold text-[var(--text)]">No company workspaces yet</h1>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-[var(--text-secondary)]">
            Zanostack Tenders starts empty — there are no records until you add them. Choose how you
            want to begin.
          </p>
        </header>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {/* Real workspace */}
          <section
            className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-menu)]"
            aria-labelledby="first-use-company-heading"
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
              <Building2 size={18} aria-hidden="true" />
            </span>
            <h2
              id="first-use-company-heading"
              className="mt-3 text-sm font-bold text-[var(--text)]"
            >
              Set up company
            </h2>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-[var(--text-secondary)]">
              Your own workspace, starting empty. Enter your company details now — only the trading
              name is required, and you can fill in registration numbers, directors and projects
              later.
            </p>
            <button
              type="button"
              onClick={onCreateCompany}
              className="mt-4 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-dark)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] focus-visible:outline-none"
            >
              Create company workspace <ArrowRight size={14} aria-hidden="true" />
            </button>
          </section>

          {/* Sample workspace */}
          <section
            className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-menu)]"
            aria-labelledby="first-use-sample-heading"
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
              <Sparkles size={18} aria-hidden="true" />
            </span>
            <h2 id="first-use-sample-heading" className="mt-3 text-sm font-bold text-[var(--text)]">
              Explore sample workspace
            </h2>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-[var(--text-secondary)]">
              A prefilled sample company with sample customers and documents, so you can try
              shredding, gap analysis and readiness straight away. It opens in its own workspace
              labelled “{SAMPLE_WORKSPACE_LABEL}”, kept apart from your own records — and you can
              create your real workspace at any time.
            </p>
            <button
              type="button"
              onClick={onExploreSample}
              disabled={sampleBusy}
              className="mt-4 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {sampleBusy ? 'Opening sample workspace…' : 'Open sample workspace'}
            </button>
          </section>
        </div>

        {sampleError && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs font-medium text-[var(--danger)]"
          >
            {sampleError}
          </p>
        )}

        <p className="mt-6 flex items-start justify-center gap-1.5 text-center text-xs leading-relaxed text-[var(--text-tertiary)]">
          <HardDrive size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Everything you add is written to this machine's local application store as you work, so
            it is still here next time you open Tenders. Nothing is uploaded and no account is
            needed.
          </span>
        </p>

        {/* Honest limits, reachable before the first record is created. */}
        <div className="mt-4 flex justify-center">
          <LimitationsButton title="Read what Tenders does not do: not legal advice, no automated submission, no OCR, review every extracted value" />
        </div>
      </div>
    </div>
  )
}

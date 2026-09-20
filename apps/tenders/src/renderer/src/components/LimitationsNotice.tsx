// Limitations notice — Phase 5 Oracle remediation (criterion 5).
//
// Tenders is a control/tracking tool: it is not legal advice, it is not a
// compliance authority, it never submits anything for you, it does not read
// scanned (image-only) pages, and its extraction is heuristic. Those limits are
// stated here in plain language so a user can find them before trusting a
// readiness score.
//
// Reachable from three places: the sidebar Help menu (App.tsx), the first-use
// screen (FirstUsePage) and the tutorials page (TutorialsPage). It renders
// through the shared Dialog primitive, so it is a labelled modal with Escape,
// a Tab trap and focus restored to whatever opened it.
//
// Chrome colours are semantic tokens only; document data never appears here.
import { useState } from 'react'
import { ClipboardCheck, FileSearch, Scale, Send, ShieldAlert } from 'lucide-react'
import { Dialog } from './Dialog'
import { Button } from './ui'

interface Limit {
  key: string
  icon: React.ReactNode
  title: string
  body: React.ReactNode
}

const LIMITS: Limit[] = [
  {
    key: 'not-advice',
    icon: <Scale size={15} aria-hidden="true" />,
    title: 'Not legal advice',
    body: (
      <>
        Tenders is not legal advice, and it is not a compliance authority. It helps you track what a
        tender asks for and what you hold — you remain responsible for your bid's compliance. Read
        the tender document itself, and take advice where the stakes are high.
      </>
    ),
  },
  {
    key: 'no-submission',
    icon: <Send size={15} aria-hidden="true" />,
    title: 'Submission is not automated',
    body: (
      <>
        Nothing is ever submitted for you. Tenders records what you did — the method, the
        confirmation reference, the evidence you filed — and the submission itself is yours to make
        through the issuer's own channel before the closing time.
      </>
    ),
  },
  {
    key: 'no-ocr',
    icon: <FileSearch size={15} aria-hidden="true" />,
    title: 'Scanned pages are detected, not read',
    body: (
      <>
        Pages saved as images have no text layer. Tenders flags them, and they block readiness until
        you open each page and mark it reviewed — it does not read them, and there is no OCR in this
        build. Treat those pages as unread until you have checked them yourself.
      </>
    ),
  },
  {
    key: 'heuristic',
    icon: <ClipboardCheck size={15} aria-hidden="true" />,
    title: 'Extraction is a best guess that must be reviewed',
    body: (
      <>
        Requirements, dates and submission details are extracted heuristically and can be wrong.
        Every value is offered for review, not as fact — confirm the critical fields against the
        source pages before you rely on the readiness score.
      </>
    ),
  },
]

export interface LimitationsNoticeProps {
  onClose: () => void
}

/** The notice itself. Rendered by whatever trigger the user pressed. */
export function LimitationsNotice({ onClose }: LimitationsNoticeProps) {
  return (
    <Dialog
      title="What Tenders does not do"
      subtitle="The honest limits of this tool, before you rely on it for a bid."
      icon={<ShieldAlert size={16} className="text-[var(--warn)]" aria-hidden="true" />}
      closeLabel="Close limitations notice"
      size="lg"
      onClose={onClose}
      footer={
        <Button variant="primary" data-autofocus onClick={onClose}>
          Understood
        </Button>
      }
    >
      {/* The scrolling belongs to this region, not to Dialog's body: it needs its
          own accessible name, keyboard reachability and focus ring (WCAG 2.1.1),
          and Dialog's body only accepts a className. */}
      <div
        role="group"
        aria-label="Limitations of Tenders"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto scroll-thin px-5 py-4 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset focus-visible:outline-none"
      >
        <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          Zanostack Tenders is a control and tracking tool for your own bid work. These limits are
          deliberate — knowing them is what keeps a submission safe.
        </p>

        <ul className="mt-4 space-y-3">
          {LIMITS.map((limit) => (
            <li
              key={limit.key}
              className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] p-3"
            >
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--surface)] text-[var(--text-secondary)]">
                {limit.icon}
              </span>
              <div className="min-w-0">
                <h3 className="text-[13px] font-semibold text-[var(--text)]">{limit.title}</h3>
                <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  {limit.body}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          Everything you add stays on this machine. Files and records are written to Tenders' local
          application store, nothing is uploaded, and no account is needed.
        </p>
      </div>
    </Dialog>
  )
}

export interface LimitationsButtonProps {
  /** Button text; defaults to the notice's own name so every trigger matches. */
  label?: string
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  className?: string
  title?: string
}

/**
 * Self-contained trigger: the button and the notice it opens. Pages use this so
 * the entry point stays identical everywhere and no page has to own the state.
 */
export function LimitationsButton({
  label = 'What Tenders does not do',
  variant = 'ghost',
  size = 'sm',
  className,
  title,
}: LimitationsButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        title={title ?? label}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <ShieldAlert size={13} aria-hidden="true" /> {label}
      </Button>
      {open && <LimitationsNotice onClose={() => setOpen(false)} />}
    </>
  )
}

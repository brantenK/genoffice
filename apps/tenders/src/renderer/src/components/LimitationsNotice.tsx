// Limitations notice — Phase 5 Oracle remediation (criterion 5), extended for
// optional AI extraction.
//
// Tenders is a control/tracking tool: it is not legal advice, it is not a
// compliance authority, it never submits anything for you, and its extraction is
// heuristic. The scanned-page limit is now stated as the conditional it is: the
// LOCAL engine does not read a page without a text layer, while AI extraction —
// which you have to configure and turn on — can read such a page by sending its
// image to the model provider you chose. Those limits are stated here in plain
// language so a user can find them before trusting a readiness score.
//
// Reachable from three places: the sidebar Help menu (App.tsx), the first-use
// screen (FirstUsePage) and the tutorials page (TutorialsPage). It renders
// through the shared Dialog primitive, so it is a labelled modal with Escape,
// a Tab trap and focus restored to whatever opened it.
//
// Chrome colours are semantic tokens only; document data never appears here.
import { useState } from 'react'
import { ClipboardCheck, FileSearch, Scale, Send, ShieldAlert, Sparkles } from 'lucide-react'
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
    key: 'scanned-pages',
    icon: <FileSearch size={15} aria-hidden="true" />,
    title: 'Scanned pages are detected, not read by the local engine',
    body: (
      <>
        Pages saved as images have no text layer. The local engine does not read them — it flags
        them, and they block readiness until you open each page and mark it reviewed. Treat those
        pages as unread until you have checked them yourself, or until you have used AI extraction
        on them (below), which still leaves every value it returns for you to confirm.
      </>
    ),
  },
  {
    key: 'ai-optional',
    icon: <Sparkles size={15} aria-hidden="true" />,
    title: 'AI extraction is optional — and it sends your document to your provider',
    body: (
      <>
        Tenders' own rule engine runs offline and is always available: no API key, no network —
        nothing leaves this machine unless you turn on AI extraction. AI extraction is optional, and
        it is not part of Tenders — it is a model provider you configure yourself, with your own API
        key. When you use it, the document's text — or the image of a scanned page — is sent to the
        model provider you configured, and everything the model suggests is unconfirmed until you
        confirm it yourself. A model's suggestion is a suggestion, not a verified fact: it can be
        wrong in the same ways the local engine can, and it can be confidently wrong in ways the
        local engine cannot. With AI extraction switched off, Tenders is entirely local again.
      </>
    ),
  },
  {
    key: 'heuristic',
    icon: <ClipboardCheck size={15} aria-hidden="true" />,
    title: 'Extraction is a best guess that must be reviewed',
    body: (
      <>
        Requirements, dates and submission details are extracted heuristically — or, when you use AI
        extraction, suggested by a model — and either way they can be wrong. Every value is offered
        for review, not as fact, and a model's output arrives no more confirmed than the local
        engine's: confirm the critical fields against the source pages before you rely on the
        readiness score.
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
          Your files, records and settings stay on this machine: they are written to Tenders' local
          application store, no account is needed, and nothing is uploaded unless you turn on AI
          extraction — which sends the document's text, or a scanned page's image, to the model
          provider you configured.
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

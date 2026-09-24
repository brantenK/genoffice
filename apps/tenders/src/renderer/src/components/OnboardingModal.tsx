// First-launch welcome walkthrough: multi-slide introduction to Zanostack Tenders.
// Rendered by App.tsx while `onboardingDone` is false. Final slide offers to
// launch the interactive spotlight tour of the live UI. Uses the shared Dialog
// primitive, so it is a labelled modal with Escape/Tab-trap/focus restore.
import { useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  Building2,
  FileSearch,
  FolderOpen,
  ListChecks,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react'
import { useTendersStore } from '../store'
import { isSampleWorkspace } from '../mock/sample-workspace'
import { Dialog } from './Dialog'
import { Button } from './ui'

interface Slide {
  icon: React.ReactNode
  title: string
  body: React.ReactNode
}

const SLIDES: Slide[] = [
  {
    icon: <ShieldCheck size={22} />,
    title: 'Welcome to Zanostack Tenders',
    body: (
      <>
        <p>
          Your tender compliance workspace. Zanostack Tenders shreds RFP documents on this machine,
          builds a compliance matrix of every requirement, and cross-references your company vault
          to show exactly what you have — and what's missing.
        </p>
        <p className="mt-3">
          <strong>Local-first.</strong> Your files and records are saved on this machine in Tenders'
          own application store, so they are still here next time you open it. Nothing is uploaded
          and no account is needed — with one exception: if you turn on AI extraction, the document
          you extract is sent to the model provider you configured.
        </p>
      </>
    ),
  },
  {
    icon: <Building2 size={22} />,
    title: 'One workspace per company',
    body: (
      <>
        <p>
          Each company you add gets its <strong>own customers, document vault and tenders</strong>.
          Switch companies from the switcher at the bottom-left of the sidebar at any time — active
          data follows the selected company.
        </p>
        <p className="mt-3">
          Start by reviewing the <strong>Company Profile</strong> page: registration numbers, VAT
          &amp; tax PIN, B-BBEE level, directors and past projects are all used in gap analysis and
          bid readiness.
        </p>
      </>
    ),
  },
  {
    icon: <FolderOpen size={22} />,
    title: 'The document vault',
    body: (
      <>
        <p>
          The <strong>Documents</strong> page is your compliance vault: certificates, tax
          clearances, B-BBEE affidavits, CVs and more, each with category, issue, expiry and
          certification dates.
        </p>
        <p className="mt-3">
          Zanostack Tenders health-checks every document: <strong>expired</strong> docs are flagged
          red, and certified stamps older than <strong>90 days</strong> are flagged as stale (SA
          police-stamp rule) so you can re-certify before it costs you a bid.
        </p>
      </>
    ),
  },
  {
    icon: <FileSearch size={22} />,
    title: 'Shred a tender in one drop',
    body: (
      <>
        <p>
          Open <strong>Tenders</strong> and drag an RFP PDF onto the dropzone (or load the demo
          RFP). Tenders' own rule engine runs offline and is always available: it extracts the text
          layer of every page that has one and lifts out requirements, closing dates, submission
          logistics and the issuing authority.
        </p>
        <p className="mt-3">
          Pages saved as images have no text layer, so the text on them is not extracted. The local
          engine does not read them; Tenders lists those pages for you, and they block readiness
          until you open each one and mark it reviewed.
        </p>
        <p className="mt-3">
          <strong>AI extraction is optional.</strong> If you configure a model provider, you can let
          a model read the document instead — including the pages saved as images above. When you
          use it, the document's text, or the image of a scanned page, is sent to the model provider
          you configured, and everything the model suggests is unconfirmed until you confirm it.
          Leave AI extraction off and nothing leaves this machine.
        </p>
        <p className="mt-3">
          Each requirement is auto-matched against your vault with a confidence score; strong
          matches are linked automatically, weaker ones are offered for you to confirm manually.
        </p>
      </>
    ),
  },
  {
    icon: <ListChecks size={22} />,
    title: 'Compliance matrix & readiness',
    body: (
      <>
        <p>
          The tender workspace shows the <strong>compliance matrix</strong> on the left and the
          source PDF on the right. Click any requirement to jump to its source clause in the
          document, zoom in, or open the drawer tools:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>
            <strong>Company vault</strong> — every vault document with its health, and which
            requirements use it (read-only).
          </li>
          <li>
            <strong>Link a document</strong> — each requirement row has its own vault-document
            picker: choose a document to link it, or “— no vault doc —” to unlink.
          </li>
          <li>
            <strong>Bid readiness</strong> — a weighted 0–100 score with your biggest gains
            highlighted.
          </li>
        </ul>
      </>
    ),
  },
  {
    icon: <Users size={22} />,
    title: 'Customers & the big picture',
    body: (
      <>
        <p>
          Track <strong>Customers</strong> and their required documents, and keep an eye on the{' '}
          <strong>Overview</strong> page: vault health, renewal runway with calendar export,
          expiring documents and pipeline at a glance.
        </p>
        <p className="mt-3">
          When you're done here, take the <strong>guided tour</strong> of the live UI — or find
          step-by-step guides any time on the <strong>Tutorials</strong> page.
        </p>
      </>
    ),
  },
]

export function OnboardingModal() {
  const setOnboardingDone = useTendersStore((s) => s.setOnboardingDone)
  const startTour = useTendersStore((s) => s.startTour)
  const setPage = useTendersStore((s) => s.setPage)
  const inSampleWorkspace = useTendersStore((s) =>
    isSampleWorkspace(s.workspaces.find((ws) => ws.id === s.activeCompanyId)),
  )
  const [slide, setSlide] = useState(0)

  const last = slide === SLIDES.length - 1
  const current = SLIDES[slide]

  const finish = (tour: boolean) => {
    setOnboardingDone()
    if (tour) {
      startTour()
    }
  }

  const skipToTutorials = () => {
    setOnboardingDone()
    setPage('tutorials')
  }

  return (
    <Dialog
      title="Zanostack Tenders"
      subtitle={`Slide ${slide + 1} of ${SLIDES.length}`}
      icon={
        <span className="flex size-7 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-dark)]">
          <ShieldCheck size={15} aria-hidden="true" />
        </span>
      }
      closeLabel="Close intro"
      onClose={() => finish(false)}
      size="md"
      bodyClassName="overflow-y-auto scroll-thin"
      footerClassName="justify-between"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={slide === 0}
            onClick={() => setSlide((s) => s - 1)}
          >
            Back
          </Button>
          <div className="flex items-center gap-2">
            {!last && (
              <Button
                variant="ghost"
                size="sm"
                className="hidden sm:inline-flex"
                onClick={skipToTutorials}
              >
                <BookOpen size={14} aria-hidden="true" /> Go to tutorials
              </Button>
            )}
            {last ? (
              <>
                <Button variant="default" size="sm" onClick={() => finish(false)}>
                  Jump right in
                </Button>
                <Button variant="primary" size="sm" onClick={() => finish(true)}>
                  Take the guided tour <ArrowRight size={14} aria-hidden="true" />
                </Button>
              </>
            ) : (
              <Button variant="primary" size="sm" onClick={() => setSlide((s) => s + 1)}>
                Next <ArrowRight size={14} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex items-center justify-end px-5 pt-3">
        <Button variant="ghost" size="sm" onClick={() => finish(false)}>
          Skip intro
        </Button>
      </div>

      {/* slide body */}
      <div className="px-5 pt-1 pb-4">
        <div className="flex items-start gap-3">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent-dark)]"
            aria-hidden="true"
          >
            {current.icon}
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold tracking-tight text-[var(--text)]">
              {current.title}
            </h3>
            <div className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              {current.body}
            </div>
            {inSampleWorkspace && (
              <p className="mt-3 rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                You are looking at a{' '}
                <strong className="text-[var(--text)]">sample workspace</strong> — every record in
                it is demonstration data. Create your own workspace from the switcher at the bottom
                of the sidebar before preparing a real bid.
              </p>
            )}
          </div>
        </div>

        {last && (
          <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3">
            <Sparkles
              size={15}
              className="mt-0.5 shrink-0 text-[var(--accent-dark)]"
              aria-hidden="true"
            />
            <p className="text-[12px] leading-relaxed text-[var(--text)]">
              Tip: the <strong>Tutorials</strong> page (sidebar, last item) has a detailed how-to
              guide for every feature — you can return to it any time, and re-run this tour from the
              Help button.
            </p>
          </div>
        )}

        {/* slide picker: 24px targets, each with an accessible name */}
        <div className="mt-5 flex items-center justify-center gap-0.5">
          {SLIDES.map((s, i) => (
            <button
              key={s.title}
              type="button"
              title={s.title}
              aria-label={`Go to slide ${i + 1}: ${s.title}`}
              aria-current={i === slide ? 'true' : undefined}
              onClick={() => setSlide(i)}
              className="flex size-6 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            >
              <span
                className={`h-1.5 rounded-full transition-all ${
                  i === slide ? 'w-5 bg-[var(--accent)]' : 'w-1.5 bg-[var(--border-strong)]'
                }`}
              />
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

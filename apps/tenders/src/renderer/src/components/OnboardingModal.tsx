// First-launch welcome walkthrough: multi-slide introduction to Zanostack Tenders.
// Rendered by App.tsx while `onboardingDone` is false. Final slide offers to
// launch the interactive spotlight tour of the live UI.
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
  Users
} from 'lucide-react'
import { useTendersStore } from '../store'

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
          Your tender compliance workspace. Zanostack Tenders shreds RFP documents in your
          browser, builds a compliance matrix of every requirement, and cross-references
          your company vault to show exactly what you have — and what's missing.
        </p>
        <p className="mt-3">
          <strong>100% client-side.</strong> Your documents never leave this browser —
          there is no server and nothing is uploaded anywhere.
        </p>
      </>
    )
  },
  {
    icon: <Building2 size={22} />,
    title: 'One workspace per company',
    body: (
      <>
        <p>
          Each company you add gets its <strong>own customers, document vault and
          tenders</strong>. Switch companies from the switcher at the bottom-left of
          the sidebar at any time — active data follows the selected company.
        </p>
        <p className="mt-3">
          Start by reviewing the <strong>Company Profile</strong> page: registration
          numbers, VAT &amp; tax PIN, B-BBEE level, directors and past projects are all
          used in gap analysis and bid readiness.
        </p>
      </>
    )
  },
  {
    icon: <FolderOpen size={22} />,
    title: 'The document vault',
    body: (
      <>
        <p>
          The <strong>Documents</strong> page is your compliance vault: certificates,
          tax clearances, B-BBEE affidavits, CVs and more, each with category, issue,
          expiry and certification dates.
        </p>
        <p className="mt-3">
          Zanostack Tenders health-checks every document: <strong>expired</strong> docs are
          flagged red, and certified stamps older than <strong>90 days</strong> are
          flagged as stale (SA police-stamp rule) so you can re-certify before it
          costs you a bid.
        </p>
      </>
    )
  },
  {
    icon: <FileSearch size={22} />,
    title: 'Shred a tender in one drop',
    body: (
      <>
        <p>
          Open <strong>Tenders</strong> and drag an RFP PDF onto the dropzone (or load
          the demo RFP). Zanostack Tenders reads every page — including scanned pages — and
          extracts requirements, closing dates, submission logistics and the issuing
          authority.
        </p>
        <p className="mt-3">
          Each requirement is auto-matched against your vault with a confidence score;
          strong matches are linked automatically, weaker ones are offered for you to
          confirm manually.
        </p>
      </>
    )
  },
  {
    icon: <ListChecks size={22} />,
    title: 'Compliance matrix & readiness',
    body: (
      <>
        <p>
          The tender workspace shows the <strong>compliance matrix</strong> on the left
          and the source PDF on the right. Click any requirement to jump to its source
          clause in the document, zoom in, or open the drawer tools:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>
            <strong>Company vault</strong> — link or unlink vault documents per
            requirement.
          </li>
          <li>
            <strong>Bid readiness</strong> — a weighted 0–100 score with your biggest
            gains highlighted.
          </li>
        </ul>
      </>
    )
  },
  {
    icon: <Users size={22} />,
    title: 'Customers & the big picture',
    body: (
      <>
        <p>
          Track <strong>Customers</strong> and their required documents, and keep an
          eye on the <strong>Overview</strong> page: vault health, renewal runway with
          calendar export, expiring documents and pipeline at a glance.
        </p>
        <p className="mt-3">
          When you're done here, take the <strong>guided tour</strong> of the live UI —
          or find step-by-step guides any time on the <strong>Tutorials</strong> page.
        </p>
      </>
    )
  }
]

export function OnboardingModal() {
  const setOnboardingDone = useTendersStore((s) => s.setOnboardingDone)
  const startTour = useTendersStore((s) => s.startTour)
  const setPage = useTendersStore((s) => s.setPage)
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
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* header */}
        <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-6 py-4">
          <span className="flex size-9 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <ShieldCheck size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-900">Zanostack Tenders</p>
            <p className="text-[11px] text-slate-400">
              Slide {slide + 1} of {SLIDES.length}
            </p>
          </div>
          <button
            type="button"
            onClick={() => finish(false)}
            className="cursor-pointer rounded-md px-2.5 py-1.5 text-[12px] font-medium text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            Skip intro
          </button>
        </div>

        {/* slide body */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
              {current.icon}
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-bold tracking-tight text-slate-900">
                {current.title}
              </h2>
              <div className="mt-2 text-sm leading-relaxed text-slate-600">
                {current.body}
              </div>
            </div>
          </div>

          {last && (
            <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3">
              <Sparkles size={15} className="mt-0.5 shrink-0 text-indigo-500" />
              <p className="text-[12px] leading-relaxed text-indigo-900">
                Tip: the <strong>Tutorials</strong> page (sidebar, last item) has a
                detailed how-to guide for every feature — you can return to it any
                time, and re-run this tour from the Help button.
              </p>
            </div>
          )}
        </div>

        {/* progress dots + footer */}
        <div className="border-t border-slate-100 px-6 py-4">
          <div className="mb-4 flex items-center justify-center gap-1.5">
            {SLIDES.map((s, i) => (
              <button
                key={s.title}
                type="button"
                title={s.title}
                onClick={() => setSlide(i)}
                className={`h-1.5 cursor-pointer rounded-full transition-all ${
                  i === slide ? 'w-6 bg-indigo-500' : 'w-1.5 bg-slate-200 hover:bg-slate-300'
                }`}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={slide === 0}
              onClick={() => setSlide((s) => s - 1)}
              className="cursor-pointer rounded-lg px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-0"
            >
              Back
            </button>
            <div className="flex items-center gap-2">
              {!last && (
                <button
                  type="button"
                  onClick={skipToTutorials}
                  className="hidden cursor-pointer items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 sm:inline-flex"
                >
                  <BookOpen size={14} /> Go to tutorials
                </button>
              )}
              {last ? (
                <>
                  <button
                    type="button"
                    onClick={() => finish(false)}
                    className="cursor-pointer rounded-lg px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-100"
                  >
                    Jump right in
                  </button>
                  <button
                    type="button"
                    onClick={() => finish(true)}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-indigo-700"
                  >
                    Take the guided tour <ArrowRight size={14} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setSlide((s) => s + 1)}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-indigo-700"
                >
                  Next <ArrowRight size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

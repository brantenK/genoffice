// Interactive spotlight tour of the live UI. Each step locates its target
// element via a `data-tour` attribute; the spotlight is a fixed div with an
// oversized box-shadow that dims everything except the target, with a
// floating tooltip beside it. Non-modal: the UI stays visible underneath.
import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import type { AppPage } from '../../shared/types'
import { useTendersStore } from '../store'

interface TourStep {
  /** value of the data-tour attribute to spotlight */
  target: string
  /** page the tour should navigate to before locating the target */
  page: AppPage
  title: string
  body: React.ReactNode
  /** optional prep, e.g. leaving the tender workspace back to the list */
  before?: () => void
}

const STEPS: TourStep[] = [
  {
    target: 'tour-nav',
    page: 'overview',
    title: 'Navigate the workspace',
    body: (
      <>
        <p>
          The sidebar takes you everywhere: <strong>Overview</strong> for health and deadlines,{' '}
          <strong>Customers</strong>, <strong>Documents</strong> (your vault),{' '}
          <strong>Tenders</strong> (compliance matrix), <strong>Company Profile</strong> and{' '}
          <strong>Tutorials</strong>.
        </p>
        <p className="mt-2">
          Collapse the sidebar with the round arrow on its right edge to gain screen space.
        </p>
      </>
    ),
  },
  {
    target: 'tour-company-switcher',
    page: 'overview',
    title: 'One workspace per company',
    body: (
      <>
        <p>
          Click your company name here to switch between workspaces — each keeps its own customers,
          vault and tenders. Use <strong>“Add company”</strong> in the switcher to create a second
          workspace.
        </p>
      </>
    ),
  },
  {
    target: 'tour-help',
    page: 'overview',
    title: 'Help is always here',
    body: (
      <>
        <p>
          This Help button re-runs this guided tour any time, and jumps to the{' '}
          <strong>Tutorials</strong> page with a detailed how-to guide for every feature.
        </p>
      </>
    ),
  },
  {
    target: 'tour-kpi',
    page: 'overview',
    title: 'Your compliance dashboard',
    body: (
      <>
        <p>
          KPI cards show vault documents, active customers, loaded tenders and completed projects —
          click any card to jump to that page. Below them,
          <strong> “Needs attention”</strong> banners call out expired documents, stale police
          stamps and docs expiring within 60 days.
        </p>
      </>
    ),
  },
  {
    target: 'tour-runway',
    page: 'overview',
    title: 'Renewal runway & calendar',
    body: (
      <>
        <p>
          Everything with a date, in order: document expiries, 90-day police-stamp windows, tender
          closing dates and recommended submit-by times. Use <strong>Download .ics</strong> to take
          the whole runway into your calendar.
        </p>
      </>
    ),
  },
  {
    target: 'tour-doc-filters',
    page: 'documents',
    title: 'Filter the vault',
    body: (
      <>
        <p>
          Filter documents by <strong>category</strong> (compliance, financial, technical,
          governance, CV) and by <strong>health</strong>: valid, expired, stale stamp, or no expiry
          info. Expired documents always sort to the top.
        </p>
        <p className="mt-2">
          Certified stamps older than <strong>90 days</strong> are flagged as stale (SA police-stamp
          rule) — re-certify before submitting a bid.
        </p>
      </>
    ),
  },
  {
    target: 'tour-doc-upload',
    page: 'documents',
    title: 'Vault documents',
    body: (
      <>
        <p>
          Click any document card to inspect its metadata, issue / expiry / certified dates, and
          open the PDF. Click a card to open its detail panel; click again to close.
        </p>
      </>
    ),
  },
  {
    target: 'tour-dropzone',
    page: 'tenders',
    before: () => useTendersStore.getState().setView('list'),
    title: 'Shred a tender RFP',
    body: (
      <>
        <p>
          Drag &amp; drop an RFP PDF here (or <strong>Choose PDF</strong>), or press{' '}
          <strong>Load demo RFP</strong> to try the full workflow right now.
        </p>
        <p className="mt-2">
          Zanostack Tenders reads every page in your browser — including scanned pages — builds the
          compliance matrix, auto-links matching vault documents and recognizes the issuing
          authority from its letterhead.
        </p>
      </>
    ),
  },
  {
    target: 'tour-tutorials-nav',
    page: 'tutorials',
    title: "That's the tour!",
    body: (
      <>
        <p>
          For step-by-step guides to every feature — shredding, gap analysis, readiness scoring,
          issuers, deadlines and more — open the <strong>Tutorials</strong> page any time.
        </p>
        <p className="mt-2">Happy bidding.</p>
      </>
    ),
  },
]

export function GuidedTour() {
  const tourActive = useTendersStore((s) => s.tourActive)
  const endTour = useTendersStore((s) => s.endTour)
  const setPage = useTendersStore((s) => s.setPage)
  const [idx, setIdx] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)

  // reset when the tour (re)starts
  useEffect(() => {
    if (tourActive) {
      setIdx(0)
      setRect(null)
    }
  }, [tourActive])

  // navigate to the step's page, then locate + spotlight the target
  useEffect(() => {
    if (!tourActive) return
    const step = STEPS[Math.min(idx, STEPS.length - 1)]
    setPage(step.page)
    step.before?.()
    let cancelled = false
    let attempts = 0
    let settleTimer: number | undefined
    const locate = () => {
      if (cancelled) return
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      if (!el) {
        // page may still be rendering — retry for a couple of seconds
        if (attempts++ < 120) requestAnimationFrame(locate)
        else setRect(null)
        return
      }
      el.scrollIntoView({ block: 'center' })
      setRect(el.getBoundingClientRect())
      // re-measure once smooth scrolling settles
      settleTimer = window.setTimeout(() => {
        if (!cancelled) setRect(el.getBoundingClientRect())
      }, 350)
    }
    requestAnimationFrame(locate)
    return () => {
      cancelled = true
      window.clearTimeout(settleTimer)
    }
  }, [idx, tourActive, setPage])

  // keep the spotlight glued to the target through resizes + scrolls
  useEffect(() => {
    if (!tourActive) return
    const step = STEPS[Math.min(idx, STEPS.length - 1)]
    const update = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      setRect(el ? el.getBoundingClientRect() : null)
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, { capture: true })
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, { capture: true })
    }
  }, [idx, tourActive])

  // Escape ends the tour
  useEffect(() => {
    if (!tourActive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endTour()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tourActive, endTour])

  if (!tourActive) return null

  const step = STEPS[Math.min(idx, STEPS.length - 1)]
  const last = idx >= STEPS.length - 1

  // tooltip placement
  const TOOLTIP_W = 340
  const PAD = 6
  let tooltipStyle: React.CSSProperties
  if (rect) {
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - TOOLTIP_W / 2, 12),
      window.innerWidth - TOOLTIP_W - 12,
    )
    const below = rect.bottom + 300 < window.innerHeight
    tooltipStyle = below
      ? { left, top: rect.bottom + PAD + 14, width: TOOLTIP_W }
      : { left, top: rect.top - PAD - 14, width: TOOLTIP_W, transform: 'translateY(-100%)' }
  } else {
    tooltipStyle = {
      left: Math.max(12, window.innerWidth / 2 - TOOLTIP_W / 2),
      top: '40%',
      width: TOOLTIP_W,
    }
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-[80]">
      {/* spotlight hole — giant box-shadow dims everything except the target */}
      {rect && (
        <div
          className="fixed rounded-xl ring-2 ring-indigo-500/80 transition-all duration-300"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.62)',
          }}
        />
      )}
      {!rect && <div className="fixed inset-0 bg-slate-950/60" />}

      {/* tooltip */}
      <div
        className="pointer-events-auto fixed rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl"
        style={tooltipStyle}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500">
            Guided tour · {idx + 1} / {STEPS.length}
          </p>
          <button
            type="button"
            onClick={endTour}
            className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            End tour
          </button>
        </div>
        <h3 className="text-sm font-bold text-slate-900">{step.title}</h3>
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-slate-600">{step.body}</div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={idx === 0}
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-0"
          >
            <ArrowLeft size={13} /> Back
          </button>
          <div className="flex items-center gap-1">
            {STEPS.map((s, i) => (
              <span
                key={s.title}
                className={`size-1.5 rounded-full ${i === idx ? 'w-4 bg-indigo-500' : 'bg-slate-200'}`}
              />
            ))}
          </div>
          {last ? (
            <button
              type="button"
              onClick={endTour}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-700"
            >
              <Check size={13} /> Done
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setIdx((i) => Math.min(STEPS.length - 1, i + 1))}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-700"
            >
              Next <ArrowRight size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

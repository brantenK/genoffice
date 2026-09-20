// Interactive spotlight tour of the live UI. Each step locates its target
// element via a `data-tour` attribute; the spotlight is a fixed div with an
// oversized box-shadow that dims everything except the target, with a
// floating tooltip beside it.
//
// The tooltip is the tour's dialog surface: it carries the shared overlay
// accessibility contract (role/aria-modal/labelled heading/Escape/Tab trap/
// focus restore) from Dialog.tsx, and every colour is a theme token.
import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import type { AppPage } from '../../shared/types'
import { useTendersStore } from '../store'
import { useOverlayBehaviour } from './Dialog'
import { Button } from './ui'

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
          Zanostack Tenders reads your PDF in the browser, builds the compliance matrix, auto-links
          matching vault documents and recognizes the issuing authority from its letterhead.
        </p>
        <p className="mt-2">
          Pages saved as images have no text layer: their text is not extracted, and they block
          readiness until you review them by hand.
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

interface TourTooltipProps {
  step: TourStep
  idx: number
  last: boolean
  style: React.CSSProperties
  onEnd: () => void
  onBack: () => void
  onNext: () => void
}

/**
 * The tooltip itself. Split out so the overlay behaviour mounts with the tour
 * (the parent renders `null` while the tour is inactive) — Escape and the Tab
 * trap come from the shared hook, and focus returns to the opener on close.
 */
function TourTooltip({ step, idx, last, style, onEnd, onBack, onNext }: TourTooltipProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useOverlayBehaviour(panelRef, onEnd)

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={style}
      className="pointer-events-auto fixed rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-[var(--text)] shadow-[var(--shadow-modal-strong)] outline-none"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold tracking-wide text-[var(--accent-dark)] uppercase">
          Guided tour · {idx + 1} / {STEPS.length}
        </p>
        <Button variant="ghost" size="sm" onClick={onEnd}>
          End tour
        </Button>
      </div>
      <h3 id={titleId} className="text-sm font-bold text-[var(--text)]">
        {step.title}
      </h3>
      <div className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
        {step.body}
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" disabled={idx === 0} onClick={onBack}>
          <ArrowLeft size={13} aria-hidden="true" /> Back
        </Button>
        <div className="flex items-center gap-1" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span
              key={s.title}
              className={`size-1.5 rounded-full ${
                i === idx ? 'w-4 bg-[var(--accent)]' : 'bg-[var(--border-strong)]'
              }`}
            />
          ))}
        </div>
        {last ? (
          <Button variant="primary" size="sm" data-autofocus onClick={onEnd}>
            <Check size={13} aria-hidden="true" /> Done
          </Button>
        ) : (
          <Button variant="primary" size="sm" data-autofocus onClick={onNext}>
            Next <ArrowRight size={13} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  )
}

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

  // Escape ends the tour (handled by the tooltip's shared overlay behaviour)

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
          className="fixed rounded-xl ring-2 ring-[var(--accent)] transition-all duration-300"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: '0 0 0 9999px var(--color-bg-overlay)',
          }}
        />
      )}
      {!rect && <div className="fixed inset-0 bg-[var(--color-bg-overlay)]" />}

      <TourTooltip
        step={step}
        idx={idx}
        last={last}
        style={tooltipStyle}
        onEnd={endTour}
        onBack={() => setIdx((i) => Math.max(0, i - 1))}
        onNext={() => setIdx((i) => Math.min(STEPS.length - 1, i + 1))}
      />
    </div>
  )
}

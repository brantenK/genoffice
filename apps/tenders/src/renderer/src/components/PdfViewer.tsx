// Scrollable PDF viewer: stacked page canvases with a clickable highlight
// overlay per page. Clicking a clause box selects the requirement (PDF -> list);
// the store's pendingFocus scrolls to a requirement's page (list -> PDF).
//
// WP-12: the pane carries a sticky context header (document + page + zoom) so
// the reader always knows where they are; `.pdf-scroll` reserves matching
// scroll padding so a located clause lands below the header, never under it.
import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { RequirementRecord } from '../../shared/types'
import { useTendersStore } from '../store'
import { ZoomControls } from './RequirementList'

interface PdfViewerProps {
  doc: PDFDocumentProxy
  requirements: RequirementRecord[]
  /** Tender title shown in the pane's sticky context header. */
  title?: string
  /**
   * Increments each time the pane is re-activated in compact mode. A hidden
   * pane has no scroll geometry, so the locate must be re-issued once the pane
   * is laid out; this token triggers that re-locate.
   */
  activationToken?: number
}

/** Pages kept rendered on either side of the current page before eviction. */
export const PAGE_OVERSCAN = 3

/**
 * Pure virtualisation policy: the inclusive page range whose canvases are kept.
 * Retention is bounded to `2 * overscan + 1` pages regardless of document size,
 * so a 500-page tender never holds hundreds of canvases.
 */
export function pageWindow(
  currentPage: number,
  totalPages: number,
  overscan = PAGE_OVERSCAN,
): { from: number; to: number } {
  const total = Math.max(0, Math.floor(totalPages))
  if (total === 0) return { from: 0, to: -1 }
  const clamped = Math.min(Math.max(1, Math.floor(currentPage) || 1), total)
  return {
    from: Math.max(1, clamped - overscan),
    to: Math.min(total, clamped + overscan),
  }
}

export function PdfViewer({ doc, requirements, title, activationToken = 0 }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const zoom = useTendersStore((s) => s.zoom)
  const pendingFocus = useTendersStore((s) => s.pendingFocus)
  const activeRequirementId = useTendersStore((s) => s.activeRequirementId)
  const setActiveRequirement = useTendersStore((s) => s.setActiveRequirement)
  const clearFocus = useTendersStore((s) => s.clearFocus)
  const setCurrentPage = useTendersStore((s) => s.setCurrentPage)
  const currentPage = useTendersStore((s) => s.currentPage)
  const [width, setWidth] = useState(700)

  // While a programmatic locate is in flight (or settling), the scroll-tracking
  // observer must NOT be allowed to overwrite the pinned page. The hidden→
  // visible pane transition can deliver a stale page-1 entry AFTER the pin,
  // which would silently revert `currentPage` to 1 with nothing to correct it.
  //
  // Releasing on the first sighting of the pinned page is not enough: a late
  // page-1 entry can still arrive after that and win. So the pin is held for a
  // short settle window, during which the observer accepts only the pinned
  // page; when the window closes the pin is re-asserted once (correcting any
  // stray write) and then normal tracking resumes. `null` = tracking freely.
  const pinnedPageRef = useRef<number | null>(null)
  const pinReleaseRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear any pending pin on unmount only; a new locate replaces it explicitly.
  useEffect(
    () => () => {
      if (pinReleaseRef.current) clearTimeout(pinReleaseRef.current)
      pinReleaseRef.current = null
      pinnedPageRef.current = null
    },
    [],
  )

  // measure available width
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 48))
    ro.observe(el)
    setWidth(el.clientWidth - 48)
    return () => ro.disconnect()
  }, [])

  const pageWidth = Math.max(320, width * zoom)

  // list -> PDF: scroll the target page into view when a checklist item focuses
  useEffect(() => {
    if (!pendingFocus) return
    const req = requirements.find((r) => r.id === pendingFocus.requirementId)
    if (!req) return
    const el = containerRef.current?.querySelector(`[data-page="${req.pageNumber}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const t = setTimeout(() => clearFocus(), 700)
    return () => clearTimeout(t)
  }, [pendingFocus, requirements, clearFocus])

  // Compact pane re-activation: the pane was `display:none` while hidden, so
  // its scroll position and the IntersectionObserver state are stale. Once it
  // is laid out again, re-locate the selected requirement's page so the
  // "preserve selected requirement and page when switching" contract holds.
  //
  // This must be deterministic rather than a single fixed frame: the pane can
  // be re-activated while the PDF document is still loading (or while its page
  // wrappers are still being committed), so `[data-page="<n>"]` may not exist
  // yet. A one-shot `requestAnimationFrame` raced that and intermittently lost
  // the locate. Instead, the locate runs in a bounded poll that waits for the
  // target page element to appear (or a short deadline to elapse), then scrolls
  // it into view and pins the indicator exactly. The effect is keyed on the
  // activation token AND `doc.numPages` (the pages-ready signal), so it re-runs
  // when the document finishes loading.
  useEffect(() => {
    if (activationToken <= 0) return
    if (doc.numPages < 1) return

    let cancelled = false
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    // Generous but bounded: the locate gives up long before the E2E poll's
    // 30s, and only after the page wrappers have had time to commit.
    const deadline = Date.now() + 4000

    const attempt = (): void => {
      if (cancelled) return
      const el = containerRef.current
      const id = useTendersStore.getState().activeRequirementId
      const req = id ? requirements.find((r) => r.id === id) : undefined
      const page = el && req ? el.querySelector(`[data-page="${req.pageNumber}"]`) : null

      if (page && req) {
        // Arm the guard BEFORE the scroll: stale observer entries from the
        // hidden→visible transition can arrive immediately after this.
        pinnedPageRef.current = req.pageNumber
        if (pinReleaseRef.current) clearTimeout(pinReleaseRef.current)
        // Hold the pin for a short settle window. 1500ms is far longer than the
        // pane-transition observer flush (which lands within a frame or two)
        // yet short enough that a deliberate user scroll immediately after the
        // switch is only briefly masked.
        pinReleaseRef.current = setTimeout(() => {
          pinReleaseRef.current = null
          const settled = pinnedPageRef.current
          pinnedPageRef.current = null
          // Re-assert the pinned page so any stray late entry is corrected
          // before the observer takes over again.
          if (settled !== null) setCurrentPage(settled)
        }, 1500)
        // Target is in the DOM: scroll it in and pin the indicator exactly.
        page.scrollIntoView({ behavior: 'auto', block: 'start' })
        // The observer may not fire for a programmatic jump when the target is
        // already at the top; set the page explicitly so the indicator is exact.
        setCurrentPage(req.pageNumber)
        return
      }
      if (Date.now() > deadline) return

      // The viewer may not be mounted yet (doc still loading) or the page
      // wrappers may still be committing; retry on the next paint, with a
      // timeout fallback for when rAF is throttled while the pane is shown.
      raf = requestAnimationFrame(() => {
        timer = setTimeout(attempt, 16)
      })
    }

    attempt()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
    }
  }, [activationToken, doc.numPages, requirements, setCurrentPage])

  // track current page while scrolling
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const n = Number((e.target as HTMLElement).dataset.page)
          if (!(n > 0)) continue
          const pinned = pinnedPageRef.current
          if (pinned !== null) {
            // A programmatic locate owns the indicator for its whole settle
            // window. Accept only the pinned page; ignore stale entries
            // (typically the hidden→visible page-1 report). The release timer
            // re-asserts the pin and hands control back — releasing here on
            // first sighting would let a late stale entry win.
            if (n === pinned) setCurrentPage(n)
            continue
          }
          setCurrentPage(n)
        }
      },
      { root: el, threshold: 0.4 },
    )
    el.querySelectorAll('[data-page]').forEach((p) => io.observe(p))
    return () => io.disconnect()
  }, [doc, setCurrentPage])

  const byPage = new Map<number, RequirementRecord[]>()
  for (const r of requirements) {
    const list = byPage.get(r.pageNumber) ?? []
    list.push(r)
    byPage.set(r.pageNumber, list)
  }

  const window = pageWindow(currentPage, doc.numPages)

  return (
    <div
      ref={containerRef}
      data-testid="pdf-scroll"
      className="pdf-scroll h-full min-h-0 overflow-y-auto scroll-thin bg-[var(--canvas)]"
    >
      {/* Sticky context header: which document and where the reader is. */}
      <div
        data-testid="pdf-context-header"
        className="pdf-context-header flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-1.5"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-[var(--text)]" title={title}>
            {title || 'Tender document'}
          </p>
          <p className="truncate text-[10px] text-[var(--text-tertiary)]">
            Source document · click a highlighted clause to select it
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-[var(--text-tertiary)]">of {doc.numPages}</span>
          <ZoomControls />
        </div>
      </div>

      <div
        className="mx-auto flex flex-col items-center gap-6 px-6 py-6"
        style={{ width: pageWidth, maxWidth: '100%' }}
      >
        {Array.from({ length: doc.numPages }, (_, i) => i + 1).map((n) => (
          <PdfPage
            key={n}
            doc={doc}
            pageNumber={n}
            width={pageWidth}
            active={n >= window.from && n <= window.to}
            pageRequirements={byPage.get(n) ?? []}
            activeRequirementId={activeRequirementId}
            onSelect={setActiveRequirement}
          />
        ))}
        <p className="pb-4 text-center text-xs text-[var(--text-tertiary)]">End of document</p>
      </div>
    </div>
  )
}

function PdfPage({
  doc,
  pageNumber,
  width,
  active,
  pageRequirements,
  activeRequirementId,
  onSelect,
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  width: number
  active: boolean
  pageRequirements: RequirementRecord[]
  activeRequirementId: string | null
  onSelect: (id: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rendered, setRendered] = useState(false)

  // Render only while the page is inside the virtualisation window, and EVICT
  // the canvas (release the backing bitmap) as soon as it leaves. The wrapper
  // stays mounted so scroll height, jump targets and the highlight overlay are
  // unaffected.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!active) {
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      setRendered(false)
      return
    }

    let cancelled = false
    let task: { promise: Promise<void>; cancel: () => void } | null = null

    ;(async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const unscaled = page.getViewport({ scale: 1 })
      const scale = (width / unscaled.width) * Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale })
      const currentCanvas = canvasRef.current
      if (!currentCanvas) return
      currentCanvas.width = viewport.width
      currentCanvas.height = viewport.height
      const ctx = currentCanvas.getContext('2d')
      if (!ctx) return
      // pdfjs v6 requires the canvas element in render params.
      task = page.render({ canvasContext: ctx, canvas: currentCanvas, viewport })
      await task.promise
      if (!cancelled) setRendered(true)
    })().catch(() => {})

    return () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {
        /* already done */
      }
    }
  }, [doc, pageNumber, width, active])

  return (
    <div data-page={pageNumber} className="relative shrink-0 shadow-md" style={{ width }}>
      {/* page canvas (rendered only inside the window; evicted when it leaves) */}
      <canvas ref={canvasRef} className="block w-full bg-white" style={{ aspectRatio: '0.707' }} />
      {(!active || !rendered) && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-white text-xs text-[var(--text-tertiary)]"
          style={{ aspectRatio: '0.707' }}
        >
          Page {pageNumber}
        </div>
      )}

      {/* highlight overlay */}
      <div className="absolute inset-0">
        {pageRequirements.map((r) => {
          const active = r.id === activeRequirementId
          return (
            <button
              key={r.id}
              type="button"
              title={r.title}
              onClick={() => onSelect(r.id)}
              className={`absolute cursor-pointer transition-colors ${
                active
                  ? 'border-2 border-indigo-500 bg-indigo-400/35 shadow-[0_0_0_4px_rgba(99,102,241,0.25)]'
                  : 'border-2 border-amber-400/70 bg-amber-300/20 hover:bg-amber-300/40'
              }`}
              style={{
                top: `${r.boundingBox.top * 100}%`,
                left: `${r.boundingBox.left * 100}%`,
                width: `${r.boundingBox.width * 100}%`,
                height: `${Math.max(r.boundingBox.height * 100, 1.2)}%`,
              }}
            />
          )
        })}
      </div>

      {/* page number chip — sits over the white page, so it uses the dark
          chrome surface with the light text token (contrast ≈ 15:1). */}
      <span className="absolute -top-2.5 left-2 rounded bg-[var(--text)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--surface)]">
        {pageNumber}
      </span>
    </div>
  )
}

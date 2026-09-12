// Scrollable PDF viewer: stacked page canvases with a clickable highlight
// overlay per page. Clicking a clause box selects the requirement (PDF -> list);
// the store's pendingFocus scrolls to a requirement's page (list -> PDF).
import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { RequirementRecord } from '../../shared/types'
import { useTendersStore } from '../store'

interface PdfViewerProps {
  doc: PDFDocumentProxy
  requirements: RequirementRecord[]
}

export function PdfViewer({ doc, requirements }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const zoom = useTendersStore((s) => s.zoom)
  const pendingFocus = useTendersStore((s) => s.pendingFocus)
  const activeRequirementId = useTendersStore((s) => s.activeRequirementId)
  const setActiveRequirement = useTendersStore((s) => s.setActiveRequirement)
  const clearFocus = useTendersStore((s) => s.clearFocus)
  const setCurrentPage = useTendersStore((s) => s.setCurrentPage)
  const [width, setWidth] = useState(700)

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

  // track current page while scrolling
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const n = Number((e.target as HTMLElement).dataset.page)
            if (n > 0) setCurrentPage(n)
          }
        }
      },
      { root: el, threshold: 0.4 }
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

  return (
    <div ref={containerRef} className="h-full overflow-y-auto scroll-thin bg-slate-200/70 px-6 py-6">
      <div className="mx-auto flex flex-col items-center gap-6" style={{ width: pageWidth, maxWidth: '100%' }}>
        {Array.from({ length: doc.numPages }, (_, i) => i + 1).map((n) => (
          <PdfPage
            key={n}
            doc={doc}
            pageNumber={n}
            width={pageWidth}
            pageRequirements={byPage.get(n) ?? []}
            activeRequirementId={activeRequirementId}
            onSelect={setActiveRequirement}
          />
        ))}
        <p className="pb-4 text-center text-xs text-slate-400">End of document</p>
      </div>
    </div>
  )
}

function PdfPage({
  doc,
  pageNumber,
  width,
  pageRequirements,
  activeRequirementId,
  onSelect
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  width: number
  pageRequirements: RequirementRecord[]
  activeRequirementId: string | null
  onSelect: (id: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(pageNumber <= 3)
  const [rendered, setRendered] = useState(false)

  // render page lazily when near the viewport
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true)
      },
      { rootMargin: '800px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: { promise: Promise<void>; cancel: () => void } | null = null

    ;(async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const unscaled = page.getViewport({ scale: 1 })
      const scale = (width / unscaled.width) * Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // pdfjs v6 requires the canvas element in render params.
      task = page.render({ canvasContext: ctx, canvas, viewport })
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
  }, [doc, pageNumber, width, visible])

  return (
    <div
      ref={wrapRef}
      data-page={pageNumber}
      className="relative shrink-0 shadow-md"
      style={{ width }}
    >
      {/* page canvas (kept mounted once visible so scroll position is stable) */}
      <canvas
        ref={canvasRef}
        className="block w-full bg-white"
        style={{ aspectRatio: '0.707' }}
      />
      {!rendered && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-white text-xs text-slate-300"
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
                height: `${Math.max(r.boundingBox.height * 100, 1.2)}%`
              }}
            />
          )
        })}
      </div>

      {/* page number chip */}
      <span className="absolute -top-2.5 left-2 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-medium text-white">
        {pageNumber}
      </span>
    </div>
  )
}

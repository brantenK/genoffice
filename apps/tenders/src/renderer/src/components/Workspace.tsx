// Workspace view: split-pane shell — compliance matrix (left) + embedded PDF
// viewer (right). Loads the active tender's PDF into a PDFDocumentProxy for the
// viewer, and hosts the company-vault + bid-readiness drawers. Shows a live
// closing-date countdown, the recommended submit-by time, the submission
// method/address, and a re-attach flow when the PDF's object URL died on reload.
import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  ClipboardCheck,
  Clock,
  FileText,
  FileUp,
  Hash,
  Mail,
  MapPin,
  Monitor,
  RefreshCw,
  ShieldAlert,
  Table
} from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { deadlineStatus, urgencyClasses, useNow } from '../deadline'
import { loadPdfDocument } from '../pdf/extract'
import { selectActiveTender, useTendersStore } from '../store'
import { SUBMISSION_METHOD_LABEL } from '../../shared/types'
import { PdfViewer } from './PdfViewer'
import { GapSummaryBar, RequirementList, ZoomControls } from './RequirementList'
import { ReadinessDrawer } from './ReadinessDrawer'
import { VaultDrawer } from './VaultDrawer'
import { Badge, Button, Spinner } from './ui'

export function Workspace() {
  const tender = useTendersStore(selectActiveTender)
  const setView = useTendersStore((s) => s.setView)
  const setPage = useTendersStore((s) => s.setPage)
  const rerunGap = useTendersStore((s) => s.rerunGap)
  const updateTender = useTendersStore((s) => s.updateTender)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  const [vaultOpen, setVaultOpen] = useState(false)
  const [readinessOpen, setReadinessOpen] = useState(false)
  const reattachRef = useRef<HTMLInputElement | null>(null)
  const now = useNow(60_000)

  // Load the tender's PDF (object URL) into pdfjs for the viewer. Object URLs
  // die on page reload (persisted state blanks fileUrl), so a blank fileUrl is
  // the re-attach state — nothing to fetch until the user re-picks the PDF.
  useEffect(() => {
    if (!tender) return
    if (!tender.fileUrl) {
      setDoc(null)
      setDocError(null)
      return
    }
    let cancelled = false
    let loaded: PDFDocumentProxy | null = null
    setDoc(null)
    setDocError(null)
    ;(async () => {
      const res = await fetch(tender.fileUrl)
      const buf = await res.arrayBuffer()
      loaded = await loadPdfDocument(buf)
      if (!cancelled) setDoc(loaded)
    })().catch(() => {
      if (!cancelled) setDocError('Could not open the tender PDF in the viewer.')
    })
    return () => {
      cancelled = true
      // PDFDocumentProxy has no destroy() in pdfjs v6; cleanup releases memory.
      void loaded?.cleanup().catch(() => {})
    }
  }, [tender?.id, tender?.fileUrl])

  if (!tender) {
    return (
      <main className="flex flex-1 items-center justify-center text-sm text-slate-400">
        No tender selected.
      </main>
    )
  }

  const dl = deadlineStatus(tender.closingDate, now)
  const MethodIcon =
    tender.submissionMethod === 'EMAIL'
      ? Mail
      : tender.submissionMethod === 'PHYSICAL'
        ? MapPin
        : Monitor

  const handleReattach = (file: File) => {
    const url = URL.createObjectURL(file)
    updateTender(tender.id, { fileUrl: url, fileName: file.name })
  }

  return (
    <main className="relative flex min-h-0 flex-1 flex-col">
      {/* tender header bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={() => { setView('list'); setPage('tenders') }}>
          <ArrowLeft size={14} /> Tenders
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-bold text-slate-900" title={tender.title}>
            {tender.title}
          </h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
            {tender.issuingBody && (
              <span className="inline-flex items-center gap-1">
                <Building2 size={11} /> {tender.issuingBody}
              </span>
            )}
            {tender.referenceNumber && (
              <span className="inline-flex items-center gap-1">
                <Hash size={11} /> {tender.referenceNumber}
              </span>
            )}
            {dl.date && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${urgencyClasses(dl.urgency)}`}
                title={`${dl.formatted}${dl.submitBy ? ` · target submit by ${dl.submitBy.toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`}
              >
                <Clock size={11} /> {dl.countdownLabel}
              </span>
            )}
            {dl.insideSubmitWindow && dl.date && (
              <Badge tone="amber" className="ring-1 ring-amber-200">Inside 24h submit window</Badge>
            )}
            {dl.submitBy && (
              <span
                className="inline-flex items-center gap-1"
                title="Recommended: submit a full day before closing"
              >
                <CalendarClock size={11} /> submit by{' '}
                {dl.submitBy.toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            {tender.submissionMethod && (
              <span
                className="inline-flex items-center gap-1"
                title={tender.submissionAddress ?? SUBMISSION_METHOD_LABEL[tender.submissionMethod]}
              >
                <MethodIcon size={11} /> {SUBMISSION_METHOD_LABEL[tender.submissionMethod]}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <FileText size={11} /> {tender.numPages} pages
              {tender.ocrPages > 0 && (
                <Badge tone="amber" className="ml-1">
                  {tender.ocrPages} scanned
                </Badge>
              )}
            </span>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <GapSummaryBar tender={tender} />
          <ZoomControls />
          <Button size="sm" variant="default" onClick={rerunGap} title="Re-run gap analysis">
            <RefreshCw size={13} /> Re-run gap
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={async () => {
              await window.tendersApi?.exportMatrixToSheets(
                tender.id,
                tender.title,
                tender.requirements
              )
            }}
            title="Export compliance matrix to Zanostack Sheets"
          >
            <Table size={13} /> Sheets
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={async () => {
              await window.tendersApi?.draftProposalDoc(tender)
            }}
            title="Draft tender proposal in Zanostack Docs"
          >
            <FileText size={13} /> Draft Docs
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={async () => {
              await window.tendersApi?.syncWithCrm({
                name: `Tender: ${tender.title}`,
                amount: tender.estimatedValue || 250000,
                companyName: tender.issuingBody || 'Government / Enterprise Buyer',
                notes: `Closing: ${tender.closingDate || 'TBD'}. Verified returnables: ${tender.requirements.filter((r) => r.status === 'FULFILLED').length}/${tender.requirements.length}.`,
              })
              await window.tendersApi?.openInCrm()
            }}
            title="Sync this tender opportunity with Zanostack CRM"
          >
            <Building2 size={13} /> CRM
          </Button>
          <Button
            size="sm"
            variant={readinessOpen ? 'primary' : 'default'}
            onClick={() => setReadinessOpen((v) => !v)}
            title="Open the pre-submission readiness checklist"
          >
            <ClipboardCheck size={14} /> Bid readiness
          </Button>
          <Button size="sm" variant="primary" onClick={() => setVaultOpen((v) => !v)}>
            <ShieldAlert size={14} /> Company vault
          </Button>
        </div>
      </div>

      {/* split panes */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-[42%] min-w-[340px] shrink-0 border-r border-slate-200">
          <RequirementList tender={tender} />
        </aside>
        <section className="relative min-w-0 flex-1">
          {!tender.fileUrl ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-amber-50 text-amber-500 ring-1 ring-amber-200">
                <FileUp size={20} />
              </span>
              <div>
                <p className="text-sm font-semibold text-slate-800">Re-attach the tender PDF</p>
                <p className="mt-1 max-w-sm text-xs text-slate-500">
                  The original file link expired when the page reloaded. Pick the PDF
                  again to view it here — your compliance matrix is untouched.
                </p>
              </div>
              <input
                ref={reattachRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleReattach(file)
                  e.target.value = ''
                }}
              />
              <Button size="sm" variant="primary" onClick={() => reattachRef.current?.click()}>
                <FileUp size={14} /> Choose PDF
              </Button>
            </div>
          ) : doc ? (
            <PdfViewer doc={doc} requirements={tender.requirements} />
          ) : docError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-red-500">
              {docError}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
              <Spinner /> Opening PDF…
            </div>
          )}
        </section>

        {/* vault drawer */}
        {vaultOpen && <VaultDrawer onClose={() => setVaultOpen(false)} />}

        {/* bid-readiness drawer */}
        {readinessOpen && <ReadinessDrawer onClose={() => setReadinessOpen(false)} />}
      </div>
    </main>
  )
}

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
  Table,
  Award,
  Zap
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
import { MilestonesDrawer } from './MilestonesDrawer'
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
  const [milestonesOpen, setMilestonesOpen] = useState(false)
  const [billingId, setBillingId] = useState<string | null>(null)
  const reattachRef = useRef<HTMLInputElement | null>(null)
  const now = useNow(60_000)

  // Load the tender's PDF into pdfjs for the viewer.
  // If tender.fileUrl is a stored path on disk, read via IPC readDocument.
  // If tender.fileUrl is an ephemeral blob or web url, fetch it directly.
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
      let buf: ArrayBuffer | null = null
      if (
        typeof window !== 'undefined' &&
        window.tendersApi?.readDocument &&
        !tender.fileUrl.startsWith('blob:') &&
        !tender.fileUrl.startsWith('http') &&
        !tender.fileUrl.startsWith('/')
      ) {
        try {
          const res = await window.tendersApi.readDocument({ storedPath: tender.fileUrl })
          if (res?.ok && res.buffer) {
            buf = res.buffer
          }
        } catch (readErr) {
          console.warn('tenders: failed to read document from disk via IPC', readErr)
        }
      }
      if (!buf) {
        const res = await fetch(tender.fileUrl)
        buf = await res.arrayBuffer()
      }
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

  const handleReattach = async (file: File) => {
    let url = ''
    if (typeof window !== 'undefined' && window.tendersApi?.saveDocument) {
      try {
        const buffer = await file.arrayBuffer()
        const saveRes = await window.tendersApi.saveDocument({
          fileName: file.name,
          buffer,
          category: 'rfp'
        })
        if (saveRes?.ok && saveRes.storedPath) {
          url = saveRes.storedPath
        }
      } catch (err) {
        console.warn('tenders: failed to persist reattached RFP document via IPC', err)
      }
    }
    if (!url) {
      url = URL.createObjectURL(file)
    }
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
          {tender.linkedCrmDealId ? (
            <Button
              size="sm"
              variant="default"
              onClick={async () => {
                await window.tendersApi?.openInCrm(tender.linkedCrmDealId || `deal-tender-${tender.id}`)
              }}
              title="Open linked deal in Zanostack CRM"
              className="border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 font-medium"
            >
              <Building2 size={13} className="text-purple-600" />
              <span>CRM Deal</span>
              <Badge tone="violet" className="ml-1 text-[10px] px-1 py-0 font-semibold">Linked</Badge>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="default"
              onClick={async () => {
                const deterministicDealId = `deal-tender-${tender.id}`
                const res = await (window.tendersApi?.syncWithCrm as any)?.({
                  id: deterministicDealId,
                  tenderId: tender.id,
                  name: `${tender.referenceNumber ? `${tender.referenceNumber} - ` : ''}${tender.title}`,
                  companyName: tender.issuingBody || 'Government / Enterprise Buyer',
                  amount: tender.estimatedValue || 0,
                  stage: 'proposal',
                  expectedCloseDate: tender.closingDate || undefined,
                  notes: `Tender Ref: ${tender.referenceNumber || 'N/A'}\nIssuing Authority: ${tender.issuingBody || 'N/A'}`,
                  tenderReference: tender.referenceNumber || undefined,
                  tender,
                })
                if (res && res.ok && res.dealId) {
                  updateTender(tender.id, { linkedCrmDealId: res.dealId })
                }
                await window.tendersApi?.openInCrm(res?.dealId || deterministicDealId)
              }}
              title="Sync this tender opportunity with Zanostack CRM"
            >
              <Building2 size={13} /> CRM
            </Button>
          )}
          <Button
            size="sm"
            variant={readinessOpen ? 'primary' : 'default'}
            onClick={() => setReadinessOpen((v) => !v)}
            title="Open the pre-submission readiness checklist"
          >
            <ClipboardCheck size={14} /> Bid readiness
          </Button>
          <Button
            size="sm"
            variant={milestonesOpen ? 'primary' : 'default'}
            onClick={() => setMilestonesOpen((v) => !v)}
            title="Open contract delivery milestones & Books billing"
          >
            <Award size={14} /> Milestones
            {tender.milestones && tender.milestones.some((m) => m.status === 'REACHED') && (
              <Badge tone="indigo" className="ml-1 px-1.5 py-0 text-[10px] font-bold">
                {tender.milestones.filter((m) => m.status === 'REACHED').length} ready
              </Badge>
            )}
          </Button>
          <Button size="sm" variant="primary" onClick={() => setVaultOpen((v) => !v)}>
            <ShieldAlert size={14} /> Company vault
          </Button>
        </div>
      </div>

      {/* split panes */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[42%] min-w-[340px] shrink-0 flex-col border-r border-slate-200">
          {tender.milestones && tender.milestones.length > 0 && (
            <div className="shrink-0 border-b border-indigo-100 bg-indigo-50/40 p-2.5 px-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-semibold text-indigo-900 flex items-center gap-1">
                  <Award size={12} className="text-indigo-600" /> Contract Delivery Milestones
                </span>
                <button
                  type="button"
                  onClick={() => setMilestonesOpen(true)}
                  className="text-[10px] text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer"
                >
                  View all ({tender.milestones.length})
                </button>
              </div>
              <div className="space-y-1.5">
                {tender.milestones.map((m) => {
                  if (m.status === 'REACHED') {
                    return (
                      <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg bg-white p-2 border border-indigo-200 shadow-xs">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-slate-900 truncate">{m.name || m.title}</div>
                          <div className="text-[10px] text-slate-500">R {Number(m.amount).toLocaleString()} · Ready to Bill</div>
                        </div>
                        <button
                          type="button"
                          disabled={billingId === m.id}
                          onClick={async () => {
                            setBillingId(m.id)
                            try {
                              const res = await window.tendersApi?.billMilestoneInBooks(tender.id, m.id)
                              if (res && res.ok) {
                                const nowIso = new Date().toISOString()
                                const updated = (tender.milestones || []).map((x) =>
                                  x.id === m.id
                                    ? {
                                        ...x,
                                        status: 'BILLED' as const,
                                        billedInvoiceId: res.invoiceId,
                                        billedInvoiceNumber: res.invoiceNumber,
                                        billedAt: nowIso,
                                        billedDate: nowIso,
                                      }
                                    : x,
                                )
                                updateTender(tender.id, { milestones: updated })
                                await window.tendersApi?.openBooks?.()
                              }
                            } finally {
                              setBillingId(null)
                            }
                          }}
                          className="shrink-0 inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 cursor-pointer"
                        >
                          {billingId === m.id ? <Spinner /> : <Zap size={11} className="text-amber-300" />} Bill Milestone in Zano Books
                        </button>
                      </div>
                    )
                  }
                  if (m.status === 'BILLED') {
                    return (
                      <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg bg-white/80 p-2 border border-slate-200">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-slate-700 truncate">{m.name || m.title}</div>
                          <div className="text-[10px] text-slate-400">R {Number(m.amount).toLocaleString()}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => window.tendersApi?.openBooks?.()}
                          className="shrink-0 inline-flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 cursor-pointer"
                          title="Open invoice in Zano Books"
                        >
                          <FileText size={11} /> {m.billedInvoiceNumber || 'INV-2026'}
                        </button>
                      </div>
                    )
                  }
                  if (m.status === 'PAID') {
                    const paidDateStr = (m as any).paidAt ? new Date((m as any).paidAt).toLocaleDateString() : 'Settled'
                    return (
                      <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50/70 p-2 border border-emerald-200 shadow-xs">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-emerald-950 truncate flex items-center gap-1.5">
                            <span>{m.name || m.title}</span>
                            <span className="inline-flex items-center rounded-full bg-emerald-100 px-1.5 py-0.2 text-[10px] font-bold text-emerald-800">
                              PAID
                            </span>
                          </div>
                          <div className="text-[10px] text-emerald-700 font-medium">
                            R {Number(m.amount).toLocaleString()} · Paid {paidDateStr}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => window.tendersApi?.openBooks?.()}
                          className="shrink-0 inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50 cursor-pointer transition-colors"
                          title="Open settled invoice in Zano Books"
                        >
                          <FileText size={11} /> {m.billedInvoiceNumber || 'View Invoice'}
                        </button>
                      </div>
                    )
                  }
                  return null
                })}
              </div>
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <RequirementList tender={tender} />
          </div>
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

        {/* contract milestones drawer */}
        {milestonesOpen && <MilestonesDrawer onClose={() => setMilestonesOpen(false)} />}
      </div>
    </main>
  )
}

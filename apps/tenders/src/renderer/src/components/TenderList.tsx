// Dashboard: dropzone + tender cards + demo loader + shred progress.
import { useCallback, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookMarked,
  CheckCircle2,
  Clock,
  FileText,
  FolderOpen,
  Hash,
  Loader2,
  Mail,
  MapPin,
  Monitor,
  ShieldCheck,
  Trash2,
  Upload
} from 'lucide-react'
import { applyGapToRequirements } from '../gap'
import { deadlineStatus, urgencyClasses, useNow } from '../deadline'
import { extractAllPages, loadPdfDocument } from '../pdf/extract'
import { extractIssuerInfo, extractTenderMeta, shredExtraction } from '../pdf/shred'
import { buildTenderRecord, useTendersStore } from '../store'
import { assessReadiness } from '../readiness'
import {
  SUBMISSION_METHOD_LABEL,
  TENDER_STATUS_LABEL,
  type RequirementRecord,
  type TenderRecord
} from '../../shared/types'
import { Badge, Button, Spinner } from './ui'

let tenderSeq = 0

async function shredFile(file: File): Promise<TenderRecord> {
  const setShredding = useTendersStore.getState().setShredding
  try {
    setShredding({ stage: 'loading', message: 'Reading PDF…', page: 0, total: 0 })
    const buf = await file.arrayBuffer()
    const doc = await loadPdfDocument(buf)

    setShredding({ stage: 'extracting', message: 'Extracting text & coordinates…', page: 0, total: doc.numPages })
    const ex = await extractAllPages(doc, (page, total) =>
      useTendersStore.getState().setShredding({
        stage: 'extracting',
        message: 'Extracting text & coordinates…',
        page,
        total
      })
    )

    setShredding({ stage: 'shredding', message: 'Matching compliance rules…', page: ex.numPages, total: ex.numPages })
    await new Promise((r) => setTimeout(r, 120)) // let the UI paint
    const extracted = shredExtraction(ex)
    const meta = extractTenderMeta(ex, file.name.replace(/\.pdf$/i, ''))

    setShredding({ stage: 'analysing', message: 'Running vault gap analysis…', page: ex.numPages, total: ex.numPages })
    const requirements: RequirementRecord[] = applyGapToRequirements(
      extracted.map((r) => ({ ...r, status: 'OUTSTANDING' as const, linkedVaultDocId: null, reason: null, suggestedVaultDocIds: [] })),
      useTendersStore.getState().vault
    )

    // letterhead analysis — recognize the issuing authority and store a
    // template so recurring buyers are auto-recognized next time
    const issuer = extractIssuerInfo(ex, {
      referenceNumber: meta.referenceNumber,
      issuingBody: meta.issuingBody
    })
    if (issuer) {
      useTendersStore.getState().upsertIssuerTemplate({
        id: '',
        name: issuer.name,
        displayName: issuer.displayName,
        address: issuer.address,
        contact: issuer.contact,
        refStyle: issuer.refStyle,
        submissionMethod: meta.submissionMethod,
        submissionAddress: meta.submissionAddress,
        seenCount: 1,
        lastSeen: new Date().toISOString()
      })
    }

    const url = URL.createObjectURL(file)
    const record = buildTenderRecord(
      `t-${Date.now()}-${tenderSeq++}`,
      file.name,
      url,
      ex,
      requirements,
      meta.title,
      {
        referenceNumber: meta.referenceNumber,
        issuingBody: meta.issuingBody,
        closingDate: meta.closingDate,
        submissionMethod: meta.submissionMethod,
        submissionAddress: meta.submissionAddress
      }
    )
    setShredding({ stage: 'done', message: 'Done', page: ex.numPages, total: ex.numPages })
    return record
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setShredding({ stage: 'error', message: msg, page: 0, total: 0 })
    throw err
  }
}

export function TenderList() {
  const tenders = useTendersStore((s) => s.tenders)
  const shredding = useTendersStore((s) => s.shredding)
  const vault = useTendersStore((s) => s.vault)
  const company = useTendersStore((s) => s.company)
  const now = useNow(60_000)
  const issuerTemplates = useTendersStore((s) => s.issuerTemplates)
  const addTender = useTendersStore((s) => s.addTender)
  const removeTender = useTendersStore((s) => s.removeTender)
  const removeIssuerTemplate = useTendersStore((s) => s.removeIssuerTemplate)
  const setActiveTender = useTendersStore((s) => s.setActiveTender)
  const setShredding = useTendersStore((s) => s.setShredding)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(
    async (file: File) => {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        setError('Only PDF files are supported.')
        return
      }
      setError(null)
      try {
        const record = await shredFile(file)
        addTender(record)
        setActiveTender(record.id)
      } catch {
        setError('Could not process that PDF. Is it encrypted or malformed?')
        setTimeout(() => setShredding(null), 2500)
      }
    },
    [addTender, setActiveTender, setShredding]
  )

  const loadDemo = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('./demo/sample-rfp.pdf').catch(() => fetch('/demo/sample-rfp.pdf'))
      if (!res.ok) throw new Error('demo asset missing')
      const blob = await res.blob()
      await handleFile(new File([blob], 'sample-rfp.pdf', { type: 'application/pdf' }))
    } catch {
      setError('Demo RFP could not be loaded.')
    }
  }, [handleFile])

  const busy = shredding !== null && shredding.stage !== 'done' && shredding.stage !== 'error'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      <div className="border-b border-slate-200 bg-white px-8 py-5">
        <h1 className="text-xl font-bold text-slate-900">Tenders</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Drop a tender RFP pack — Zanostack Tenders shreds it in your browser into a compliance matrix,
          cross-references your company vault, and highlights every source clause.
        </p>
      </div>
    <main className="mx-auto w-full max-w-5xl flex-1 px-8 py-8">
      {/* Dropzone */}
      <section
        data-tour="tour-dropzone"
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const f = e.dataTransfer.files?.[0]
          if (f && !busy) void handleFile(f)
        }}
        className={`rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragOver ? 'border-indigo-400 bg-indigo-50/60' : 'border-slate-300 bg-white'
        }`}
      >
        {busy ? (
          <ShredProgress />
        ) : (
          <>
            <Upload className="mx-auto size-8 text-slate-400" />
            <p className="mt-3 text-sm font-medium text-slate-700">
              Drag &amp; drop a tender RFP (PDF), or
            </p>
            <div className="mt-3 flex items-center justify-center gap-2">
              <Button variant="primary" onClick={() => inputRef.current?.click()}>
                <FolderOpen size={15} /> Choose PDF
              </Button>
              <Button onClick={loadDemo}>
                <FileText size={15} /> Load demo RFP
              </Button>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              100% client-side processing — your documents never leave this browser.
            </p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
            e.target.value = ''
          }}
        />
        {error && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-red-600">
            <AlertTriangle size={14} /> {error}
          </p>
        )}
      </section>

      {/* Tender list */}
      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">
          Tenders {tenders.length > 0 && <span className="text-slate-400">({tenders.length})</span>}
        </h2>
        {tenders.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
            No tenders yet — load the demo RFP to see the full compliance workflow.
          </p>
        ) : (
          <ul className="space-y-3">
            {tenders.map((t) => {
              const counts = countsFor(t)
              const dl = deadlineStatus(t.closingDate, now)
              const readiness = assessReadiness(t, vault, company, now)
              const MethodIcon =
                t.submissionMethod === 'EMAIL' ? Mail : t.submissionMethod === 'PHYSICAL' ? MapPin : Monitor
              return (
                <li
                  key={t.id}
                  className="group cursor-pointer rounded-lg border border-slate-200 bg-white p-4 transition-shadow hover:shadow-md"
                  onClick={() => {
                    setActiveTender(t.id)
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">{t.title}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1">
                          <FileText size={12} /> {t.fileName}
                        </span>
                        {t.referenceNumber && <span>Ref {t.referenceNumber}</span>}
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
                        {t.submissionMethod && (
                          <span
                            className="inline-flex items-center gap-1"
                            title={t.submissionAddress ?? SUBMISSION_METHOD_LABEL[t.submissionMethod]}
                          >
                            <MethodIcon size={12} /> {SUBMISSION_METHOD_LABEL[t.submissionMethod]}
                          </span>
                        )}
                        <span>{t.numPages} pages</span>
                        {t.ocrPages > 0 && (
                          <Badge tone="amber">{t.ocrPages} scanned page{t.ocrPages === 1 ? '' : 's'}</Badge>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {t.status === 'READY_FOR_SUBMISSION' && readiness.ready && (
                        <Badge tone="green">
                          <ShieldCheck size={12} /> {TENDER_STATUS_LABEL[t.status]}
                        </Badge>
                      )}
                      <span className="text-xs font-semibold text-slate-700">
                        {counts.fulfilled}/{counts.total} fulfilled
                      </span>
                      <button
                        type="button"
                        title="Remove tender"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeTender(t.id)
                        }}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
                      >
                        <Trash2 size={14} className="text-slate-400 hover:text-red-500" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all"
                      style={{ width: `${counts.total ? (counts.fulfilled / counts.total) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="mt-2 flex gap-3 text-[11px] text-slate-500">
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 size={12} className="text-emerald-500" /> {counts.fulfilled} fulfilled
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <AlertTriangle size={12} className="text-amber-500" /> {counts.actionRequired} action
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Loader2 size={12} className="text-red-400" /> {counts.outstanding} outstanding
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Recognized issuer letterhead templates */}
      {issuerTemplates.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-1 text-sm font-semibold text-slate-700">
            Recognized issuers{' '}
            <span className="text-slate-400">({issuerTemplates.length})</span>
          </h2>
          <p className="mb-3 text-xs text-slate-400">
            Letterhead templates captured from shredded tenders — recurring buyers are
            auto-recognized, with their usual reference style and submission logistics on file.
          </p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {issuerTemplates.map((tpl) => {
              const MethodIcon =
                tpl.submissionMethod === 'EMAIL'
                  ? Mail
                  : tpl.submissionMethod === 'PHYSICAL'
                    ? MapPin
                    : Monitor
              return (
                <li
                  key={tpl.id}
                  className="group relative rounded-lg border border-slate-200 bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-2 pr-7">
                    <p className="inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold text-slate-900">
                      <BookMarked size={13} className="shrink-0 text-indigo-500" />
                      <span className="truncate" title={tpl.displayName}>
                        {tpl.displayName}
                      </span>
                    </p>
                    <button
                      type="button"
                      title="Forget this issuer template"
                      onClick={() => removeIssuerTemplate(tpl.id)}
                      className="absolute right-2 top-2 cursor-pointer rounded-md p-1.5 text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600">
                    seen {tpl.seenCount} tender{tpl.seenCount === 1 ? '' : 's'} · last{' '}
                    {new Date(tpl.lastSeen).toLocaleDateString('en-ZA', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric'
                    })}
                  </p>
                  <div className="mt-2 space-y-1 text-[11px] text-slate-500">
                    {tpl.refStyle && (
                      <p className="flex items-start gap-1.5">
                        <Hash size={11} className="mt-0.5 shrink-0 text-slate-400" />
                        <span>{tpl.refStyle}</span>
                      </p>
                    )}
                    {tpl.address && (
                      <p className="flex items-start gap-1.5">
                        <MapPin size={11} className="mt-0.5 shrink-0 text-slate-400" />
                        <span className="line-clamp-2">{tpl.address}</span>
                      </p>
                    )}
                    {tpl.contact && (
                      <p className="flex items-start gap-1.5">
                        <Mail size={11} className="mt-0.5 shrink-0 text-slate-400" />
                        <span className="line-clamp-2">{tpl.contact}</span>
                      </p>
                    )}
                    {tpl.submissionMethod && (
                      <p className="flex items-start gap-1.5">
                        <MethodIcon size={11} className="mt-0.5 shrink-0 text-slate-400" />
                        <span
                          className="line-clamp-2"
                          title={tpl.submissionAddress ?? undefined}
                        >
                          {SUBMISSION_METHOD_LABEL[tpl.submissionMethod]}
                          {tpl.submissionAddress ? ` — ${tpl.submissionAddress}` : ''}
                        </span>
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </main>
    </div>
  )
}

function countsFor(t: TenderRecord) {
  let fulfilled = 0
  let actionRequired = 0
  let outstanding = 0
  for (const r of t.requirements) {
    if (r.status === 'FULFILLED') fulfilled++
    else if (r.status === 'ACTION_REQUIRED') actionRequired++
    else if (r.status === 'OUTSTANDING') outstanding++
  }
  return { total: t.requirements.length, fulfilled, actionRequired, outstanding }
}

function ShredProgress() {
  const s = useTendersStore((s2) => s2.shredding)
  if (!s) return null
  const pct = s.total > 0 ? Math.round((s.page / s.total) * 100) : null
  const icon = s.stage === 'error' ? <AlertTriangle className="mx-auto size-8 text-red-400" /> : <Spinner className="mx-auto size-7" />
  return (
    <div className="py-2">
      {icon}
      <p className={`mt-3 text-sm font-medium ${s.stage === 'error' ? 'text-red-600' : 'text-slate-700'}`}>
        {s.stage === 'error' ? 'Shredding failed' : s.message}
      </p>
      {s.stage !== 'error' && (
        <>
          {pct !== null && (
            <div className="mx-auto mt-3 h-1.5 w-56 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
          <p className="mt-2 text-xs text-slate-400">
            page {s.page} / {s.total || '?'}
          </p>
        </>
      )}
    </div>
  )
}

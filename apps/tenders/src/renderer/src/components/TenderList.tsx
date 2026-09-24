// Dashboard: dropzone + tender cards + demo loader + shred progress.
import { useCallback, useRef, useState } from 'react'
import {
  AlertTriangle,
  BadgeCheck,
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
  Upload,
} from 'lucide-react'
import { deadlineStatus, urgencyClasses, useNow } from '../deadline'
import {
  assertPdfBytesWithinLimit,
  assertPdfPagesWithinLimit,
  extractAllPages,
  formatBytes,
  loadPdfDocument,
  PDF_PREFLIGHT_LIMITS,
  PdfImportCancelledError,
  PdfPreflightError,
} from '../pdf/extract'
import { extractIssuerInfo, extractTenderMeta, shredExtraction } from '../pdf/shred'
import {
  applyGapToRequirementsIndexed,
  buildTenderRecord,
  buildVaultKeywordIndex,
  useTendersStore,
} from '../store'
import { assessReadiness } from '../readiness'
import {
  isDemoAssetUrl,
  SUBMISSION_METHOD_LABEL,
  TENDER_OUTCOME_LABEL,
  type RequirementRecord,
  type TenderDataOrigin,
  type TenderRecord,
} from '../../shared/types'
import { deriveTenderReview, gateConflictingMeta, summarizeReview } from './ExtractionReview'
import { lifecycleCardSummary } from './TenderLifecyclePanel'
import { Badge, Button, Spinner } from './ui'
import { Dialog } from './Dialog'

/**
 * The bundled sample RFP, in both document-relative (`./`) and root-relative
 * form. A missing asset answers with a non-OK *response* — it does not reject —
 * so the fallback below is driven by `res.ok`, not only by a thrown fetch.
 */
const DEMO_RFP_URLS = ['./demo/sample-rfp.pdf', '/demo/sample-rfp.pdf'] as const

/** File name the bundled sample RFP is imported under. */
const DEMO_RFP_FILE_NAME = 'sample-rfp.pdf'

/** Label shown on a tender that came from the bundled sample RFP. */
export const DEMO_TENDER_LABEL = 'Demo import'

/** Why a demo-imported tender is labelled: it is not the user's own document. */
export const DEMO_TENDER_HINT =
  'Imported from the bundled sample RFP — demonstration data, not a real tender.'

/** Short form of the same statement, used in the list's explanatory line. */
export const DEMO_TENDER_NOTE = 'demonstration data, not a real tender.'

/**
 * A tender shredded from the bundled sample RFP is marked on the record itself
 * (`TenderRecord.dataOrigin`) instead of in a session-scoped renderer Set, so
 * the label survives a restart. The renderer can only ever write `'demo'` — the
 * schema rejects `'user'` — so this flag can never promote a record.
 */
export function isDemoTender(tender: Pick<TenderRecord, 'dataOrigin'>): boolean {
  return tender.dataOrigin === 'demo'
}

/**
 * Fetch the bundled sample RFP, trying each candidate URL and falling back on a
 * non-OK response as well as on a rejected request. Throws with an accurate
 * reason (which URL answered what) when none of them resolves.
 */
export async function fetchDemoRfp(
  fetchImpl: (input: string) => Promise<Response> = (input) => fetch(input),
): Promise<Response> {
  const attempts: string[] = []
  for (const url of DEMO_RFP_URLS) {
    try {
      const response = await fetchImpl(url)
      if (response.ok) return response
      attempts.push(`${url} → HTTP ${response.status}`)
    } catch (err) {
      attempts.push(`${url} → ${err instanceof Error ? err.message : 'request failed'}`)
    }
  }
  throw new Error(`no demo asset: ${attempts.join('; ')}`)
}

/**
 * The document store reports raw I/O failures (`EPERM: …`, absolute paths). A
 * user-facing alert describes the failure in plain language instead, passing
 * through only a store-authored size/limit message.
 */
export function persistFailureReason(detail: string | null | undefined): string {
  if (detail && /upload limit|limit reached/i.test(detail)) {
    return 'the document store rejected it as too large'
  }
  return 'the document store could not write it to this machine'
}

let tenderSeq = 0

async function shredFile(
  file: File,
  signal: AbortSignal,
  dataOrigin?: TenderDataOrigin,
): Promise<{
  record: TenderRecord
  extraction: Awaited<ReturnType<typeof extractAllPages>>
  meta: ReturnType<typeof extractTenderMeta>
  /**
   * Non-null when the RFP could not be persisted and fell back to a blob. The
   * value is a plain-language reason, never the raw store/I-O error.
   */
  persistError: string | null
}> {
  const setShredding = useTendersStore.getState().setShredding
  const throwIfAborted = (): void => {
    if (signal.aborted) throw new PdfImportCancelledError()
  }
  try {
    // Preflight BEFORE reading the file buffer.
    assertPdfBytesWithinLimit(file.size)
    setShredding({ stage: 'loading', message: 'Reading PDF…', page: 0, total: 0 })
    throwIfAborted()
    const buf = await file.arrayBuffer()
    const doc = await loadPdfDocument(buf)

    // Page-count preflight BEFORE any page is read or rendered.
    assertPdfPagesWithinLimit(doc.numPages)
    throwIfAborted()

    setShredding({
      stage: 'extracting',
      message: 'Extracting text & coordinates…',
      page: 0,
      total: doc.numPages,
    })
    const ex = await extractAllPages(
      doc,
      (page, total) =>
        useTendersStore.getState().setShredding({
          stage: 'extracting',
          message: 'Extracting text & coordinates…',
          page,
          total,
        }),
      { signal },
    )
    throwIfAborted()

    setShredding({
      stage: 'shredding',
      message: 'Matching compliance rules…',
      page: ex.numPages,
      total: ex.numPages,
    })
    await new Promise((r) => setTimeout(r, 120)) // let the UI paint
    throwIfAborted()
    const extracted = shredExtraction(ex)
    const meta = extractTenderMeta(ex, file.name.replace(/\.pdf$/i, ''))

    setShredding({
      stage: 'analysing',
      message: 'Running vault gap analysis…',
      page: ex.numPages,
      total: ex.numPages,
    })
    // ONE vault keyword index for this analysis pass; each requirement matches
    // against a prefiltered candidate set instead of rescanning the vault.
    const vaultIndex = buildVaultKeywordIndex(useTendersStore.getState().vault)
    const requirements: RequirementRecord[] = applyGapToRequirementsIndexed(
      extracted.map((r) => ({
        ...r,
        status: 'OUTSTANDING' as const,
        linkedVaultDocId: null,
        reason: null,
        suggestedVaultDocIds: [],
      })),
      vaultIndex,
    )

    // letterhead analysis — recognize the issuing authority and store a
    // template so recurring buyers are auto-recognized next time
    const issuer = extractIssuerInfo(ex, {
      referenceNumber: meta.referenceNumber,
      issuingBody: meta.issuingBody,
    })

    throwIfAborted()
    let fileUrl = ''
    // A failure here is never silent: it is returned so the list can show a
    // visible warning that the imported PDF is only a session blob.
    let persistError: string | null = null
    if (typeof window !== 'undefined' && window.tendersApi?.saveDocument) {
      let storedPath: string | null = null
      try {
        const buffer = await file.arrayBuffer()
        const saveRes = await window.tendersApi.saveDocument({
          fileName: file.name,
          buffer,
          category: 'rfp',
        })
        if (saveRes?.ok && saveRes.storedPath) {
          storedPath = saveRes.storedPath
          fileUrl = saveRes.storedPath
        } else {
          persistError = persistFailureReason(saveRes?.error)
        }
      } catch (saveErr) {
        persistError = persistFailureReason(saveErr instanceof Error ? saveErr.message : null)
      }
      // If the import was cancelled while the document was being reserved,
      // release it so a cancelled import leaves no orphan file.
      if (signal.aborted) {
        if (storedPath) {
          try {
            await window.tendersApi.deleteDocument?.({ storedPath })
          } catch {
            /* best-effort cleanup */
          }
        }
        throw new PdfImportCancelledError()
      }
    }
    if (!fileUrl) {
      fileUrl = URL.createObjectURL(file)
    }
    // Only now (after the last cancellation checkpoint) mutate authoritative
    // state, so a cancelled import leaves no issuer template or partial tender.
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
        lastSeen: new Date().toISOString(),
      })
    }
    // A readiness-critical field is only imported when the parse is
    // unambiguous. Competing candidates stay in the review step for resolution
    // instead of one of them silently deciding the deadline/method/destination.
    const gated = gateConflictingMeta(meta)
    const record = buildTenderRecord(
      `t-${Date.now()}-${tenderSeq++}`,
      file.name,
      fileUrl,
      ex,
      requirements,
      meta.title,
      {
        referenceNumber: meta.referenceNumber,
        issuingBody: meta.issuingBody,
        closingDate: gated.closingDate,
        submissionMethod: gated.submissionMethod,
        submissionAddress: gated.submissionAddress,
      },
    )
    setShredding({ stage: 'done', message: 'Done', page: ex.numPages, total: ex.numPages })
    // The origin rides on the record, so it is committed with the tender and is
    // still there after a restart.
    return {
      record: dataOrigin ? { ...record, dataOrigin } : record,
      extraction: ex,
      meta,
      persistError,
    }
  } catch (err) {
    if (err instanceof PdfImportCancelledError) {
      // Clean cancellation: no tender is added, no partial state is kept.
      setShredding(null)
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    setShredding({ stage: 'error', message: msg, page: 0, total: 0 })
    throw err
  }
}

export function TenderList() {
  const tenders = useTendersStore((s) => s.tenders)
  const shredding = useTendersStore((s) => s.shredding)
  const vault = useTendersStore((s) => s.vault)
  const customers = useTendersStore((s) => s.customers)
  const company = useTendersStore((s) => s.company)
  const now = useNow(60_000)
  const issuerTemplates = useTendersStore((s) => s.issuerTemplates)
  const tenderReviews = useTendersStore((s) => s.tenderReviews)
  const addTender = useTendersStore((s) => s.addTender)
  const removeTender = useTendersStore((s) => s.removeTender)
  const removeIssuerTemplate = useTendersStore((s) => s.removeIssuerTemplate)
  const setActiveTender = useTendersStore((s) => s.setActiveTender)
  const setShredding = useTendersStore((s) => s.setShredding)
  const setTenderReview = useTendersStore((s) => s.setTenderReview)
  const updateTender = useTendersStore((s) => s.updateTender)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Visible (role="alert") notice when an imported RFP could not be persisted
  // and is only a session blob — never a silent console warning.
  const [storageWarning, setStorageWarning] = useState<{
    tenderId: string
    message: string
  } | null>(null)
  // Tender removal goes through the managed-file lifecycle: an in-app
  // confirmation first, then a soft-delete of the RFP into .trash (recoverable).
  // A failed trash keeps the record and surfaces the reason (fail closed).
  const [pendingDelete, setPendingDelete] = useState<TenderRecord | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const importAbortRef = useRef<AbortController | null>(null)
  const lastImportFileRef = useRef<File | null>(null)

  const cancelImport = useCallback(() => {
    importAbortRef.current?.abort()
  }, [])

  const handleFile = useCallback(
    async (file: File, options?: { dataOrigin?: TenderDataOrigin }): Promise<string | null> => {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        setError('Only PDF files are supported.')
        return null
      }
      setError(null)
      setStorageWarning(null)
      const controller = new AbortController()
      importAbortRef.current?.abort()
      importAbortRef.current = controller
      try {
        const { record, extraction, meta, persistError } = await shredFile(
          file,
          controller.signal,
          options?.dataOrigin,
        )
        if (controller.signal.aborted) return null
        addTender(record)
        if (persistError) {
          // The tender imports fine, but the PDF fell back to an object URL that
          // dies on reload. Say so, and offer to retry the save.
          lastImportFileRef.current = file
          setStorageWarning({
            tenderId: record.id,
            message: `The PDF could not be saved to the workspace — ${persistError}. It is open for this session only and must be re-attached before you rely on it after a restart.`,
          })
        }
        // Seed the extraction review from the parser's candidates so the user
        // sees competing values and source pages straight away.
        setTenderReview(
          record.id,
          deriveTenderReview({
            meta,
            extraction,
            requirements: record.requirements,
            estimatedValue: record.estimatedValue ?? null,
          }),
        )
        setActiveTender(record.id)
        return record.id
      } catch (err) {
        if (err instanceof PdfImportCancelledError) {
          setError('Import cancelled.')
          return null
        }
        if (err instanceof PdfPreflightError) {
          // Typed, user-visible reason (oversize file / too many pages).
          setError(err.message)
          return null
        }
        setError('Could not process that PDF. Is it encrypted or malformed?')
        setTimeout(() => setShredding(null), 2500)
        return null
      } finally {
        if (importAbortRef.current === controller) importAbortRef.current = null
      }
    },
    [addTender, setActiveTender, setShredding, setTenderReview],
  )

  /** Retry persisting the RFP that previously fell back to a session blob. */
  const retryPersistStorage = useCallback(async () => {
    const warning = storageWarning
    const file = lastImportFileRef.current
    if (!warning || !file || typeof window === 'undefined' || !window.tendersApi?.saveDocument) {
      return
    }
    try {
      const buffer = await file.arrayBuffer()
      const res = await window.tendersApi.saveDocument({
        fileName: file.name,
        buffer,
        category: 'rfp',
      })
      if (res?.ok && res.storedPath) {
        // Point the stored tender at the now-durable file and clear the warning.
        updateTender(warning.tenderId, { fileUrl: res.storedPath })
        setStorageWarning(null)
        return
      }
      setStorageWarning({
        ...warning,
        message: `The PDF still could not be saved to the workspace — ${persistFailureReason(
          res?.error,
        )}. It remains available for this session only.`,
      })
    } catch (err) {
      setStorageWarning({
        ...warning,
        message: `The PDF still could not be saved to the workspace — ${persistFailureReason(
          err instanceof Error ? err.message : null,
        )}. It remains available for this session only.`,
      })
    }
  }, [storageWarning, updateTender])

  /** A workspace-relative managed file path (not a blob/http/demo URL). */
  const managedTenderPath = (url: string | null | undefined): string | null => {
    if (!url) return null
    if (url.startsWith('blob:') || url.startsWith('http') || isDemoAssetUrl(url)) return null
    return url
  }

  /** Human-readable records that reference this tender before it is removed. */
  const tenderReferences = (t: TenderRecord): string[] => {
    const refs: string[] = []
    const path = managedTenderPath(t.fileUrl)
    if (t.linkedCrmDealId) refs.push(`CRM deal ${t.linkedCrmDealId}`)
    if (path) {
      for (const other of tenders) {
        if (other.id !== t.id && other.fileUrl === path) refs.push(`tender “${other.title}”`)
      }
      const linkedVaultIds = new Set<string>()
      for (const doc of vault) {
        if (doc.fileUrl === path) {
          refs.push(`vault document “${doc.title}”`)
          linkedVaultIds.add(doc.id)
        }
      }
      if (linkedVaultIds.size > 0) {
        for (const customer of customers) {
          if (
            customer.requiredDocs.some(
              (required) =>
                required.linkedVaultDocId !== null && linkedVaultIds.has(required.linkedVaultDocId),
            )
          ) {
            refs.push(`customer “${customer.name}”`)
          }
        }
      }
    }
    const milestoneCount = t.milestones?.length ?? 0
    if (milestoneCount > 0) refs.push(`${milestoneCount} contract milestone(s)`)
    return refs
  }

  const requestRemoveTender = useCallback((t: TenderRecord) => {
    setDeleteError(null)
    setDeleteNotice(null)
    setPendingDelete(t)
  }, [])

  const cancelRemoveTender = useCallback(() => setPendingDelete(null), [])

  const performRemoveTender = useCallback(
    async (t: TenderRecord) => {
      setDeleteError(null)
      setDeleteNotice(null)
      const storedPath = managedTenderPath(t.fileUrl)
      if (storedPath) {
        if (!window.tendersApi?.deleteDocument) {
          // Fail closed: keep the record so its RFP is never orphaned silently.
          setDeleteError(
            'Document deletion is unavailable in this build; the tender was not removed.',
          )
          return
        }
        setDeleteBusy(true)
        try {
          const res = await window.tendersApi.deleteDocument({ storedPath })
          if (!res?.ok) {
            setDeleteError(
              res?.error || 'Could not move the RFP to Trash; the tender was not removed.',
            )
            return
          }
          const notes: string[] = [...(res.warnings ?? [])]
          if (res.links && res.links.length > 0) {
            notes.push(
              `Referenced by ${res.links.length} record(s): ${res.links
                .map((link) => `${link.kind} “${link.label}”`)
                .join(', ')}.`,
            )
          }
          if (res.trashId) notes.push('The RFP was moved to Trash (recoverable).')
          if (notes.length > 0) setDeleteNotice(notes.join(' '))
        } catch (err) {
          setDeleteError(err instanceof Error ? err.message : String(err))
          return
        } finally {
          setDeleteBusy(false)
        }
      } else if (t.fileUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(t.fileUrl)
      }
      // Only after the file is safely in Trash (or there was none) is the record
      // removed, so reconcile never sees a false orphan.
      removeTender(t.id)
    },
    [removeTender],
  )

  const confirmRemoveTender = useCallback(() => {
    const t = pendingDelete
    setPendingDelete(null)
    if (t) void performRemoveTender(t)
  }, [pendingDelete, performRemoveTender])

  const pendingReferences = pendingDelete ? tenderReferences(pendingDelete) : []

  const loadDemo = useCallback(async () => {
    setError(null)
    try {
      const response = await fetchDemoRfp()
      const blob = await response.blob()
      // The origin is recorded on the tender itself, so the "Demo import" marker
      // is committed with it and survives a restart.
      await handleFile(new File([blob], DEMO_RFP_FILE_NAME, { type: 'application/pdf' }), {
        dataOrigin: 'demo',
      })
    } catch (err) {
      // Visible, accurate failure — never the raw fetch error.
      console.warn('tenders: bundled demo RFP could not be loaded', err)
      setError(
        'The bundled sample RFP could not be loaded. Choose a PDF from your own machine instead — shredding works exactly the same.',
      )
    }
  }, [handleFile])

  const busy = shredding !== null && shredding.stage !== 'done' && shredding.stage !== 'error'
  // Read from the persisted flag, not from a session Set, so the note is right
  // after a restart too.
  const hasDemoImport = tenders.some(isDemoTender)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-8 py-5">
        <h1 className="text-xl font-bold text-[var(--text)]">Tenders</h1>
        <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
          Drop a tender RFP (one PDF at a time) — Zanostack Tenders shreds it locally on this
          machine into a compliance matrix, cross-references your company vault, and highlights
          every source clause.
        </p>
      </div>
      <section aria-label="Tender list" className="mx-auto w-full max-w-5xl flex-1 px-8 py-8">
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
            dragOver
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border-strong)] bg-[var(--surface)]'
          }`}
        >
          {busy ? (
            <ShredProgress onCancel={cancelImport} />
          ) : (
            <>
              <Upload className="mx-auto size-8 text-[var(--text-tertiary)]" />
              <p className="mt-3 text-sm font-medium text-[var(--text-secondary)]">
                Drag &amp; drop a tender RFP (PDF), or
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <Button variant="primary" onClick={() => inputRef.current?.click()}>
                  <FolderOpen size={15} /> Choose PDF
                </Button>
                <Button onClick={loadDemo} title={DEMO_TENDER_HINT}>
                  <FileText size={15} /> Load demo RFP
                </Button>
              </div>
              <p className="mt-3 text-xs text-[var(--text-tertiary)]">
                100% local processing — your documents never leave this computer.
              </p>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                Import limits: up to {PDF_PREFLIGHT_LIMITS.maxPages} pages ·{' '}
                {formatBytes(PDF_PREFLIGHT_LIMITS.maxBytes)} per PDF.
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
            <p
              role="alert"
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--danger)]"
            >
              <AlertTriangle size={14} aria-hidden="true" /> {error}
            </p>
          )}
        </section>

        {/* The import succeeded but the PDF is not durable — visible, retryable. */}
        {storageWarning && (
          <div
            role="alert"
            className="mt-4 flex flex-wrap items-start gap-2 rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2.5 text-[12px] text-[var(--text-secondary)]"
          >
            <AlertTriangle
              size={14}
              className="mt-0.5 shrink-0 text-[var(--warn)]"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 leading-relaxed">{storageWarning.message}</span>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="default" onClick={() => void retryPersistStorage()}>
                Retry save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setStorageWarning(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {/* Removal feedback: the RFP's trash outcome / link warnings. */}
        {deleteNotice && (
          <div
            role="status"
            data-testid="delete-tender-notice"
            className="mt-4 flex flex-wrap items-start gap-2 rounded-lg border border-[var(--success-border)] bg-[var(--success-bg)] px-3 py-2.5 text-[12px] text-[var(--text-secondary)]"
          >
            <CheckCircle2
              size={14}
              className="mt-0.5 shrink-0 text-[var(--success)]"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 leading-relaxed">{deleteNotice}</span>
            <Button size="sm" variant="ghost" onClick={() => setDeleteNotice(null)}>
              Dismiss
            </Button>
          </div>
        )}
        {deleteError && (
          <div
            role="alert"
            data-testid="delete-tender-error"
            className="mt-4 flex flex-wrap items-start gap-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2.5 text-[12px] text-[var(--text-secondary)]"
          >
            <AlertTriangle
              size={14}
              className="mt-0.5 shrink-0 text-[var(--danger)]"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 leading-relaxed">{deleteError}</span>
            <Button size="sm" variant="ghost" onClick={() => setDeleteError(null)}>
              Dismiss
            </Button>
          </div>
        )}

        {/* Tender list */}
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-[var(--text)]">
            Tenders{' '}
            {tenders.length > 0 && (
              <span className="text-[var(--text-tertiary)]">({tenders.length})</span>
            )}
          </h2>
          {hasDemoImport && (
            <p className="mb-3 text-xs text-[var(--text-tertiary)]">
              <strong className="font-semibold text-[var(--text-secondary)]">
                {DEMO_TENDER_LABEL}
              </strong>{' '}
              marks a tender shredded from the bundled sample RFP — {DEMO_TENDER_NOTE}
            </p>
          )}
          {tenders.length === 0 ? (
            <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
              No tenders yet — drop an RFP PDF (or load the bundled demo RFP) to see the full
              compliance workflow.
            </p>
          ) : (
            <ul className="space-y-3">
              {tenders.map((t) => {
                const counts = countsFor(t)
                const dl = deadlineStatus(t.closingDate, now)
                const readiness = assessReadiness(t, vault, company, now)
                const review = tenderReviews[t.id]
                const reviewSummary = summarizeReview(t, review)
                const lifecycle = lifecycleCardSummary(t)
                const demoImport = isDemoTender(t)
                const MethodIcon =
                  t.submissionMethod === 'EMAIL'
                    ? Mail
                    : t.submissionMethod === 'PHYSICAL'
                      ? MapPin
                      : Monitor
                return (
                  <li
                    key={t.id}
                    data-testid="tender-card"
                    data-demo-import={demoImport ? 'true' : undefined}
                    className="group relative rounded-lg border border-[var(--border)] bg-[var(--surface)] transition-shadow hover:shadow-md"
                  >
                    {/* The card itself is the control: a real button, so Tab +
                        Enter/Space open a tender exactly like a mouse click. */}
                    <button
                      type="button"
                      onClick={() => setActiveTender(t.id)}
                      className="block w-full cursor-pointer rounded-lg p-4 text-left focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
                    >
                      <div className="flex items-start justify-between gap-3 pr-8">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[var(--text)]">
                            {t.title}
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
                            {demoImport && (
                              <span title={DEMO_TENDER_HINT}>
                                <Badge tone="violet">{DEMO_TENDER_LABEL}</Badge>
                              </span>
                            )}
                            <span className="inline-flex items-center gap-1">
                              <FileText size={12} /> {t.fileName}
                            </span>
                            {t.referenceNumber && <span>Ref {t.referenceNumber}</span>}
                            {dl.date && (
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${urgencyClasses(dl.urgency)}`}
                                title={`${dl.formatted}${dl.submitByLabel ? ` · target submit by ${dl.submitByLabel}` : ''}`}
                              >
                                <Clock size={11} /> {dl.countdownLabel}
                              </span>
                            )}
                            {dl.insideSubmitWindow && dl.date && (
                              <Badge tone="amber" className="ring-1 ring-[var(--warn-border)]">
                                Inside 24h submit window
                              </Badge>
                            )}
                            {t.submissionMethod && (
                              <span
                                className="inline-flex items-center gap-1"
                                title={
                                  t.submissionAddress ?? SUBMISSION_METHOD_LABEL[t.submissionMethod]
                                }
                              >
                                <MethodIcon size={12} />{' '}
                                {SUBMISSION_METHOD_LABEL[t.submissionMethod]}
                              </span>
                            )}
                            <span>{t.numPages} pages</span>
                            {t.ocrPages > 0 && (
                              // Naming scanned pages obliges the badge to state
                              // their outcome: nothing on them was extracted, so
                              // the count is work to review, not text to search.
                              <Badge tone="amber">
                                {t.ocrPages} scanned page{t.ocrPages === 1 ? '' : 's'} — text not
                                extracted
                              </Badge>
                            )}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          {reviewSummary.complete ? (
                            <Badge tone="green" className="ring-1 ring-[var(--success-border)]">
                              <BadgeCheck size={12} /> Extraction reviewed
                            </Badge>
                          ) : (
                            <Badge tone="amber" className="ring-1 ring-[var(--warn-border)]">
                              <AlertTriangle size={12} /> Review{' '}
                              {reviewSummary.pendingFields +
                                reviewSummary.requirementAttention.length}{' '}
                              to confirm
                            </Badge>
                          )}
                          {/* lifecycle status + proof of submission + outcome */}
                          <Badge tone={lifecycle.tone}>
                            <ShieldCheck size={12} /> {lifecycle.label}
                          </Badge>
                          {lifecycle.evidence && (
                            <Badge tone={lifecycle.evidenceTone}>{lifecycle.evidence}</Badge>
                          )}
                          {lifecycle.override && (
                            <span title="Submitted with blockers using an audited override">
                              <Badge tone="red">Override</Badge>
                            </span>
                          )}
                          {t.outcome && (
                            <Badge tone="violet">{TENDER_OUTCOME_LABEL[t.outcome.status]}</Badge>
                          )}
                          {t.status === 'READY_FOR_SUBMISSION' && readiness.ready && (
                            <Badge tone="green">Checks clear</Badge>
                          )}
                          <span className="text-xs font-semibold text-[var(--text-secondary)]">
                            {counts.fulfilled}/{counts.total} fulfilled
                          </span>
                        </div>
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--canvas)]">
                        <div
                          className="h-full rounded-full bg-[var(--accent)] transition-all"
                          style={{
                            width: `${counts.total ? (counts.fulfilled / counts.total) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <div className="mt-2 flex gap-3 text-[11px] text-[var(--text-secondary)]">
                        <span className="inline-flex items-center gap-1">
                          <CheckCircle2 size={12} className="text-[var(--success)]" />{' '}
                          {counts.fulfilled} fulfilled
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <AlertTriangle size={12} className="text-[var(--warn)]" />{' '}
                          {counts.actionRequired} action
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Loader2 size={12} className="text-[var(--danger)]" />{' '}
                          {counts.outstanding} outstanding
                        </span>
                      </div>
                    </button>
                    {/* Removal is a sibling of the card button, never nested in
                        it: two real buttons, both keyboard reachable. */}
                    <button
                      type="button"
                      title="Remove tender"
                      aria-label="Remove tender"
                      disabled={deleteBusy}
                      onClick={() => requestRemoveTender(t)}
                      className="absolute top-3 right-3 inline-flex min-h-6 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2
                        size={14}
                        className="text-[var(--text-tertiary)] hover:text-[var(--danger)]"
                      />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* Recognized issuer letterhead templates */}
        {issuerTemplates.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">
              Recognized issuers{' '}
              <span className="text-[var(--text-tertiary)]">({issuerTemplates.length})</span>
            </h2>
            <p className="mb-3 text-xs text-[var(--text-tertiary)]">
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
                    className="group relative rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
                  >
                    <div className="flex items-start justify-between gap-2 pr-7">
                      <p className="inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
                        <BookMarked size={13} className="shrink-0 text-[var(--accent)]" />
                        <span className="truncate" title={tpl.displayName}>
                          {tpl.displayName}
                        </span>
                      </p>
                      <button
                        type="button"
                        title="Forget this issuer template"
                        aria-label="Forget this issuer template"
                        onClick={() => removeIssuerTemplate(tpl.id)}
                        className="absolute right-2 top-2 cursor-pointer rounded-md p-1.5 text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--hover)] hover:text-[var(--danger)] group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {/* `lastSeen` is a real instant — the RFC3339 stamp the store
                        writes when it recognizes the issuer — not a civil date
                        someone typed, so it stays on the reader's own clock like
                        every other instant the app prints. */}
                    <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent-dark)]">
                      seen {tpl.seenCount} tender{tpl.seenCount === 1 ? '' : 's'} · last{' '}
                      {new Date(tpl.lastSeen).toLocaleDateString('en-ZA', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </p>
                    <div className="mt-2 space-y-1 text-[11px] text-[var(--text-secondary)]">
                      {tpl.refStyle && (
                        <p className="flex items-start gap-1.5">
                          <Hash size={11} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
                          <span>{tpl.refStyle}</span>
                        </p>
                      )}
                      {tpl.address && (
                        <p className="flex items-start gap-1.5">
                          <MapPin
                            size={11}
                            className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
                          />
                          <span className="line-clamp-2">{tpl.address}</span>
                        </p>
                      )}
                      {tpl.contact && (
                        <p className="flex items-start gap-1.5">
                          <Mail size={11} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
                          <span className="line-clamp-2">{tpl.contact}</span>
                        </p>
                      )}
                      {tpl.submissionMethod && (
                        <p className="flex items-start gap-1.5">
                          <MethodIcon
                            size={11}
                            className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
                          />
                          <span className="line-clamp-2" title={tpl.submissionAddress ?? undefined}>
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
      </section>

      {/* Managed-file confirmation: the RFP is moved to .trash (recoverable) and
          the record is only removed after that succeeds. */}
      {pendingDelete && (
        <div data-testid="delete-tender-dialog" className="fixed inset-0 z-[75]">
          <Dialog
            title="Remove tender?"
            subtitle={`“${pendingDelete.title}” will be removed from the workspace.`}
            icon={<Trash2 size={16} aria-hidden="true" />}
            size="md"
            onClose={cancelRemoveTender}
            footer={
              <>
                {/* Destructive action: Cancel takes initial focus so a stray
                    Enter/Space does not remove. Escape and backdrop also cancel. */}
                <Button variant="ghost" data-autofocus onClick={cancelRemoveTender}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  data-testid="delete-tender-confirm"
                  disabled={deleteBusy}
                  onClick={confirmRemoveTender}
                >
                  Remove tender
                </Button>
              </>
            }
          >
            <div className="space-y-2 px-5 py-4 text-sm leading-relaxed text-[var(--text-secondary)]">
              <p>
                The RFP file{pendingDelete.fileName ? ` “${pendingDelete.fileName}”` : ''} is moved
                to Trash and can be restored from the Documents trash. Removing the tender deletes
                its compliance matrix and review from the workspace.
              </p>
              {pendingReferences.length > 0 && (
                <p
                  data-testid="delete-tender-links"
                  className="rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-xs"
                >
                  Also referenced by: {pendingReferences.join(', ')}.
                </p>
              )}
            </div>
          </Dialog>
        </div>
      )}
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

function ShredProgress({ onCancel }: { onCancel?: () => void }) {
  const s = useTendersStore((s2) => s2.shredding)
  if (!s) return null
  const pct = s.total > 0 ? Math.round((s.page / s.total) * 100) : null
  const icon =
    s.stage === 'error' ? (
      <AlertTriangle className="mx-auto size-8 text-[var(--danger)]" />
    ) : (
      <Spinner className="mx-auto size-7" />
    )
  return (
    <div className="py-2">
      {icon}
      <p
        role={s.stage === 'error' ? 'alert' : undefined}
        className={`mt-3 text-sm font-medium ${s.stage === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]'}`}
      >
        {s.stage === 'error' ? 'Shredding failed' : s.message}
      </p>
      {s.stage !== 'error' && (
        <>
          {pct !== null && (
            <div className="mx-auto mt-3 h-1.5 w-56 overflow-hidden rounded-full bg-[var(--surface-subtle)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          <p className="mt-2 text-xs text-[var(--text-tertiary)]">
            page {s.page} / {s.total || '?'}
          </p>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="mt-3 cursor-pointer rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--hover)]"
            >
              Cancel import
            </button>
          )}
        </>
      )}
    </div>
  )
}

// Dashboard: dropzone + tender cards + demo loader + shred progress.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
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
import {
  assertDocxBytesWithinLimit,
  DOCX_PREFLIGHT_LIMITS,
  DocxImportCancelledError,
  DocxPreflightError,
  docxParseProgressMessage,
  extractDocxIntake,
  groupThousands,
} from '../intake/docx'
import { extractIssuerInfo, extractTenderMeta, shredExtraction } from '../pdf/shred'
import { MAX_TENDERS_DOCUMENT_UPLOAD_BYTES } from '../../../shared/ipc'
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
  type PageExtraction,
  type RequirementRecord,
  type TenderDataOrigin,
  type TenderRecord,
} from '../../shared/types'
import {
  deriveTenderReview,
  gateConflictingMeta,
  isWordDocumentName,
  summarizeReview,
} from './ExtractionReview'
import { lifecycleCardSummary } from './TenderLifecyclePanel'
import { Badge, Button, Spinner } from './ui'
import { Dialog } from './Dialog'
import type { ExtractionRejection } from '../../../shared/ai-extraction'
import { MAX_TENDERS_REVIEW_CONFLICTS } from '../../../shared/tenders-persistence'
import {
  AI_EXTRACTION_CHUNK_BUDGET_MS,
  AI_EXTRACTION_RULES,
  AI_EXTRACTION_RUN_BUDGET_MS,
  adaptAiExtraction,
  checkDuplicateReference,
  createVisionCompletion,
  markModelReadPages,
  mergeAiIntoReview,
  runTenderAiPass,
  settingsSupportVision,
  type AiPageImage,
  type AiPassProgress,
  type AiRunBudget,
  type AiVisionCompletion,
  type DuplicateReferenceCheck,
  type TenderAiPassVision,
} from '../ai/extract-with-ai'
import {
  createTendersCompletion,
  readAiReadiness,
  tendersAiBridge,
  type AiReadiness,
} from '../ai/transport'
import { renderPageImage as renderPdfPageImage } from '../pdf/page-image'

/**
 * The bundled sample RFP, in both document-relative (`./`) and root-relative
 * form. A missing asset answers with a non-OK *response* — it does not reject —
 * so the fallback below is driven by `res.ok`, not only by a thrown fetch.
 */
const DEMO_RFP_URLS = ['./demo/sample-rfp.pdf', '/demo/sample-rfp.pdf'] as const

/** File name the bundled sample RFP is imported under. */
const DEMO_RFP_FILE_NAME = 'sample-rfp.pdf'

/**
 * What the dropzone tells the user it will accept — and what it tells them about
 * the SMALLER limit that decides whether the document can be kept.
 *
 * Two different bounds run here, and publishing only the first one was a promise
 * the app could not keep: a PDF up to `PDF_PREFLIGHT_LIMITS.maxBytes` (100 MiB) is
 * read, shredded and committed in full, but the managed-document store refuses to
 * SAVE anything above `MAX_TENDERS_DOCUMENT_UPLOAD_BYTES` (25 MiB) — so a document
 * between the two numbers imported fine and then existed only as a session blob,
 * which the user had not been warned to expect when they chose the file. The
 * import itself is unaffected either way, which is why the sentence says what
 * actually happens rather than pretending the file is refused.
 *
 * Every number is read from the constant that ENFORCES it, and
 * `tests/docx-intake.test.ts` asserts each one appears here, so the copy cannot
 * drift away from the guard again.
 */
export function intakeLimitDisclosure(): string {
  return (
    `Import limits: up to ${groupThousands(PDF_PREFLIGHT_LIMITS.maxPages)} pages and ` +
    `${formatBytes(PDF_PREFLIGHT_LIMITS.maxBytes)} per PDF, or up to ` +
    `${groupThousands(DOCX_PREFLIGHT_LIMITS.maxLines)} text lines and ` +
    `${formatBytes(DOCX_PREFLIGHT_LIMITS.maxBytes)} per Word .docx. A document above ` +
    `${formatBytes(MAX_TENDERS_DOCUMENT_UPLOAD_BYTES)} still imports and is shredded, but is too ` +
    `large to save into the workspace: it stays open for this session only and has to be re-attached ` +
    `after a restart.`
  )
}

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

// ── the optional AI pass ─────────────────────────────────────────────────────
//
// The local rule engine is what always runs: it is offline, needs no key, and
// its result is committed and shown before a model is ever called. AI extraction
// is an OPT-IN second reader, remembered between imports as a UI preference —
// `localStorage`, the same place the workspace split already keeps its own
// preference (`SPLIT_STORAGE_KEY` in `Workspace.tsx`), and deliberately NOT the
// authoritative document: an extraction preference is not tender data, and a
// preference that lived in the document would be a domain edit on a toggle.

/** localStorage key for the opt-in AI-extraction preference. */
export const AI_EXTRACTION_PREF_KEY = 'zanostack-tenders-ai-extraction'

/** The slice of `Storage` the preference needs, so a test can supply its own. */
export interface AiPreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function aiPreferenceStorage(): AiPreferenceStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    // Storage unavailable (private mode / disabled): the toggle still works for
    // this session, it just is not remembered.
    return null
  }
}

/** Read the remembered choice. Absent, unreadable or malformed means OFF. */
export function readAiExtractionPreference(storage?: AiPreferenceStorage | null): boolean {
  const store = storage === undefined ? aiPreferenceStorage() : storage
  if (!store) return false
  try {
    const raw = store.getItem(AI_EXTRACTION_PREF_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { enabled?: unknown }
    return parsed?.enabled === true
  } catch {
    return false
  }
}

/** Remember the choice for the next import. A failure here is non-fatal. */
export function persistAiExtractionPreference(
  enabled: boolean,
  storage?: AiPreferenceStorage | null,
): void {
  const store = storage === undefined ? aiPreferenceStorage() : storage
  if (!store) return
  try {
    store.setItem(AI_EXTRACTION_PREF_KEY, JSON.stringify({ enabled }))
  } catch {
    // Non-fatal: the toggle still applies to this session.
  }
}

/** How many refusal reasons are shown before the rest are summarised. */
const AI_REJECTION_PREVIEW_LIMIT = 3

/** One surfaced AI message: what happened, and the reasons behind it. */
interface AiNotice {
  tone: 'info' | 'warn'
  message: string
  details?: string[]
}

/** Live progress of the AI pass: one entry per step, in the order it happens. */
interface AiRunProgress {
  phase: 'text' | 'vision-read' | 'vision-extract'
  /** 0-based index within the phase */
  index: number
  /** how many units the phase has (chunks, or pages for a vision read) */
  total: number
  pageNumbers: number[]
  chars: number
}

/**
 * Shown when the configured model cannot be used to read an image. The pages
 * without a text layer then cannot be read by AI at all, so the pass says so
 * instead of quietly doing nothing with them.
 */
const IMAGE_READING_UNAVAILABLE_MESSAGE =
  'The model you configured cannot be used to read an image.'

/**
 * Shown when the source is a Word .docx and the pass reaches the pages the local
 * extractor flagged.
 *
 * A .docx has no rendered pages, so there is no page image for a model to read —
 * whatever the configured model can do. Those pages are then cleared the only
 * way left: a person compares each one against the original document and marks
 * it reviewed, which is what the review step offers.
 */
export const WORD_DOCUMENT_VISION_MESSAGE =
  'This tender came from a Word .docx, which has no rendered pages, so there is no page image to read.'

// ── which intake path a chosen file takes ────────────────────────────────────

/** The MIME type Word writes for a .docx, accepted alongside the extension. */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** The two document types intake reads. */
export type TenderSourceKind = 'pdf' | 'docx'

/**
 * Which reader a chosen file goes to.
 *
 * The NAME decides first: an OS-reported MIME type is a hint the file name
 * contradicts often enough to matter (a .docx dragged from an archive, a PDF
 * served as octet-stream), and the extension is what the user recognises. The
 * type is only consulted for a file whose name carries neither extension.
 * Null means intake cannot read it at all, which is the caller's error message
 * to give.
 */
export function tenderSourceKind(file: { name: string; type: string }): TenderSourceKind | null {
  if (/\.pdf$/i.test(file.name)) return 'pdf'
  if (/\.docx$/i.test(file.name)) return 'docx'
  if (file.type === 'application/pdf') return 'pdf'
  if (file.type === DOCX_MIME) return 'docx'
  return null
}

/**
 * What a tender card says about its source document's own page count.
 *
 * A .docx that declares no page break is ONE page to this app — the whole file —
 * and printing "1 page" beside a Word document would read as a printed page
 * number. So a flowing .docx says what it is instead, and a .docx that declares
 * breaks says where the numbers came from.
 */
export function documentPageSummary(tender: Pick<TenderRecord, 'fileName' | 'numPages'>): string {
  if (!isWordDocumentName(tender.fileName)) return `${tender.numPages} pages`
  return tender.numPages > 1
    ? `${tender.numPages} pages (declared by the .docx)`
    : '1 continuous block of text (no page breaks declared)'
}

// ── the AI pass's vision capability ──────────────────────────────────────────

export interface ImportVisionArgs {
  /**
   * The parsed PDF, or null when the source is a Word .docx. A .docx has no
   * rendered pages, so nothing can be rendered into a page image.
   */
  doc: PDFDocumentProxy | null
  /** Whether the configured model can read an image at all. */
  supportsVision: boolean
  /** Built only when a page image can actually be read, so it is never wasted. */
  createCompletion: () => AiVisionCompletion
  renderPageImage: (doc: PDFDocumentProxy, pageNumber: number) => Promise<AiPageImage>
  /**
   * Ceilings for a vision pass that is given no run budget of its own. The pass
   * hands the reader its own remaining budget whenever it has one; this is the
   * fallback for the callers that do not (see `TenderAiPassVision.budget`).
   */
  budget?: AiRunBudget
}

/**
 * What the optional AI pass may do about the pages the local extractor flagged.
 *
 * The order matters and is the whole point of this function: a Word .docx
 * refuses a vision read BEFORE the model's own capability is consulted. A
 * vision-capable model would otherwise be handed a renderer for a document that
 * cannot be rendered, and the run would fail on a file it had read perfectly.
 * With the reason given, the pass reports it, and the flagged pages keep
 * blocking readiness until a person reviews them.
 */
export function importVision(args: ImportVisionArgs): TenderAiPassVision {
  const doc = args.doc
  if (!doc) return { available: false, reason: WORD_DOCUMENT_VISION_MESSAGE }
  if (!args.supportsVision) return { available: false, reason: IMAGE_READING_UNAVAILABLE_MESSAGE }
  return {
    available: true,
    completion: args.createCompletion(),
    renderPageImage: (pageNumber) => args.renderPageImage(doc, pageNumber),
    ...(args.budget ? { budget: args.budget } : {}),
  }
}

function rejectionDetails(rejections: readonly ExtractionRejection[]): string[] {
  const shown = rejections.slice(0, AI_REJECTION_PREVIEW_LIMIT).map((item) => item.reason)
  const rest = rejections.length - shown.length
  return rest > 0 ? [...shown, `…and ${rest} more.`] : shown
}

/**
 * What the pass is doing right now, in one line a user can read.
 *
 * Every step names the reader. A phase label is still copy a user reads, so the
 * scanned-page honesty guard (`tests/ocr-honesty-copy.test.ts`) polices it: the
 * words "read"/"read it"/"extract" next to "scanned" would claim a page whose
 * text was never obtained had been read, and the row this label sits in says AI
 * extraction, so it says whose reading this is.
 */
export function aiRunLabel(run: AiRunProgress): string {
  const step = `${Math.min(run.index + 1, Math.max(run.total, 1))} of ${Math.max(run.total, 1)}`
  const pages = run.pageNumbers.length > 0 ? ` (${pageRangeLabel(run.pageNumbers)})` : ''
  if (run.phase === 'vision-read') return `the model reading a page image, ${step}${pages}`
  if (run.phase === 'vision-extract') return `chunk ${step} of what the model read${pages}`
  return `chunk ${step}${pages}`
}

/** "pages 4–7" / "page 3" for a chunk's page range. */
function pageRangeLabel(pageNumbers: readonly number[]): string {
  if (pageNumbers.length === 0) return 'no pages'
  const first = pageNumbers[0]
  const last = pageNumbers[pageNumbers.length - 1]
  if (pageNumbers.length === 1) return `page ${first}`
  const contiguous = pageNumbers.every(
    (page, index) => index === 0 || page === pageNumbers[index - 1] + 1,
  )
  return contiguous ? `pages ${first}–${last}` : `pages ${pageNumbers.join(', ')}`
}

// ── the AI pass's own state, reachable from wherever the user is ──────────────
//
// The pass is fire-and-forget and it enriches the tender that was just imported
// — and importing ACTIVATES that tender, which unmounts this component for the
// workspace view. State kept in a `useState` here was therefore gone before the
// run had even started: the user turned AI on, imported, landed in the workspace
// and could never see whether it ran, what it found, whether it failed, or cancel
// it.
//
// So the run's state lives in this module-level store instead — plain data with
// `subscribe`/`getSnapshot`, the shape the suite already uses for renderer-only
// state (`packages/ui/src/ai-panel-prefs-store.ts`), readable by the list view
// and by the workspace, and testable without a component harness.
//
// It is UI state and it stays UI state. Nothing here is written to the tender or
// to the persisted document: `store.ts`'s `partialize` enumerates the keys that
// are persisted and no key of this store is among them. A run's findings reach
// the document only the way any other suggestion does — `updateTender` /
// `setTenderReview`, as `unconfirmed` review material a person still has to
// confirm.

/** Where a run is: in flight, finished, or stopped without producing anything. */
export type AiPassStatus = 'running' | 'done' | 'cancelled' | 'failed' | 'unavailable'

/** What a finished run produced, refused, or could not do. */
export interface AiPassOutcome {
  /** One honest sentence describing what the pass produced. */
  summary: string
  /** Suggestions the core refused, with the reason. */
  rejections: ExtractionRejection[]
  /** Everything else worth saying (truncated pages, chunks that failed, …). */
  warnings: string[]
  /** Pages no reading method obtained — these still block readiness. */
  unreadPages: number[]
  /** Pages whose image a model actually read, ascending. */
  readPages: number[]
  /** Why no page image was read at all; null when one was. */
  visionSkippedReason: string | null
  /** Pages the model did not read, and why. */
  visionUnread: { pageNumber: number; reason: string }[]
  /** The model's strongest reference already belongs to another tender. */
  duplicateReference: string | null
}

/** One run of the optional AI pass, as the UI needs to see it. */
export interface AiPassState {
  /** Which attempt this is. Updates from any other attempt are refused. */
  runId: number
  tenderId: string
  tenderTitle: string
  status: AiPassStatus
  /** The step in flight, for `'running'`; null once the run has stopped. */
  progress: AiRunProgress | null
  /** What a finished run produced, for `'done'`; null otherwise. */
  outcome: AiPassOutcome | null
  /** Why the run produced nothing, for `'failed'` and `'unavailable'`. */
  failure: string | null
}

let aiPassState: AiPassState | null = null
let aiPassSeq = 0
/** Aborts the run in flight; null when nothing is in flight. */
let aiPassAbort: (() => void) | null = null
const aiPassListeners = new Set<() => void>()

function emitAiPass(next: AiPassState | null): void {
  aiPassState = next
  for (const listener of aiPassListeners) listener()
}

export function subscribeAiPass(listener: () => void): () => void {
  aiPassListeners.add(listener)
  return () => {
    aiPassListeners.delete(listener)
  }
}

/** The run's state, or null when there is nothing to report. */
export function getAiPassState(): AiPassState | null {
  return aiPassState
}

/** The same state as a React value; null means "nothing to report". */
export function useAiPass(): AiPassState | null {
  return useSyncExternalStore(subscribeAiPass, getAiPassState, () => null)
}

/**
 * Start a run and make it visible. `cancel` is how the store stops the work: the
 * pass owns its own `AbortController`, so the store holds only the handle.
 */
export function startAiPass(input: {
  tenderId: string
  tenderTitle: string
  cancel?: () => void
}): number {
  aiPassSeq += 1
  aiPassAbort = input.cancel ?? null
  emitAiPass({
    runId: aiPassSeq,
    tenderId: input.tenderId,
    tenderTitle: input.tenderTitle,
    status: 'running',
    progress: { phase: 'text', index: 0, total: 1, pageNumbers: [], chars: 0 },
    outcome: null,
    failure: null,
  })
  return aiPassSeq
}

/** The run this id still owns, or null when it has been stopped or superseded. */
function liveAiPass(runId: number): AiPassState | null {
  return aiPassState && aiPassState.runId === runId ? aiPassState : null
}

/** Report the step now in flight. A stopped or superseded run is ignored. */
export function reportAiPassProgress(runId: number, progress: AiPassProgress): void {
  const run = liveAiPass(runId)
  if (!run || run.status !== 'running') return
  emitAiPass({ ...run, progress: { ...progress, chars: 0 } })
}

/** Report text the model has streamed back so far within the current step. */
export function reportAiPassChars(runId: number, chars: number): void {
  const run = liveAiPass(runId)
  if (!run || run.status !== 'running' || !run.progress) return
  emitAiPass({ ...run, progress: { ...run.progress, chars } })
}

/**
 * The run finished and produced `outcome`.
 *
 * Returns false — and records nothing — when the run was cancelled or superseded,
 * which is how a stopped run can never apply a partial result: the caller gates
 * every write on this answer, so the tender keeps exactly what the local engine
 * produced.
 */
export function finishAiPass(runId: number, outcome: AiPassOutcome): boolean {
  const run = liveAiPass(runId)
  if (!run || run.status !== 'running') return false
  aiPassAbort = null
  emitAiPass({ ...run, status: 'done', progress: null, outcome, failure: null })
  return true
}

/**
 * The run stopped without producing anything: a failure, or a refusal to start
 * (no model configured, a model that cannot read an image, no bridge).
 */
export function failAiPass(
  runId: number,
  message: string,
  status: 'failed' | 'unavailable' = 'failed',
): boolean {
  const run = liveAiPass(runId)
  if (!run || run.status !== 'running') return false
  aiPassAbort = null
  emitAiPass({ ...run, status, progress: null, outcome: null, failure: message })
  return true
}

/**
 * Stop the run in progress: abort the work, and record that nothing from it was
 * applied.
 *
 * `runId` is given by the run's own unwinding path so a superseded attempt cannot
 * cancel the attempt that replaced it; the UI omits it and stops whatever is
 * actually in flight.
 */
export function cancelAiPass(runId?: number): boolean {
  const run = aiPassState
  if (!run || run.status !== 'running') return false
  if (runId !== undefined && run.runId !== runId) return false
  const abort = aiPassAbort
  aiPassAbort = null
  abort?.()
  emitAiPass({ ...run, status: 'cancelled', progress: null, outcome: null, failure: null })
  return true
}

/**
 * Forget a stopped run's report. A run still in flight is not dismissable — the
 * only way to end it is to cancel it, so the cancel control cannot be dismissed
 * out from under a user who needs it.
 */
export function dismissAiPass(): void {
  if (aiPassState?.status === 'running') return
  aiPassAbort = null
  emitAiPass(null)
}

/** What a stopped or finished run says in one line. */
export function aiPassMessage(state: AiPassState): string {
  switch (state.status) {
    case 'done':
      return state.outcome?.summary ?? ''
    case 'cancelled':
      return 'AI extraction was cancelled, so nothing from that run was applied. The local extraction is unchanged.'
    case 'failed':
      return `AI extraction failed: ${state.failure ?? 'no reason reported'}. The local extraction is unaffected.`
    case 'unavailable':
      return state.failure ?? ''
    default:
      return ''
  }
}

/**
 * Everything a finished run has to say, one line each: the refusals with their
 * reasons, the warnings the adapter returned, a duplicate reference, and the
 * pages no reader obtained. Pure, so the panel and the tests agree on the copy.
 */
export function aiPassDetails(state: AiPassState): string[] {
  const outcome = state.outcome
  if (!outcome) return []
  const details: string[] = []
  if (outcome.duplicateReference) details.push(outcome.duplicateReference)
  details.push(...outcome.warnings)
  details.push(...rejectionDetails(outcome.rejections))
  for (const page of outcome.visionUnread) {
    details.push(`Page ${page.pageNumber} was not read: ${page.reason}`)
  }
  if (outcome.unreadPages.length > 0) {
    const count = outcome.unreadPages.length
    details.push(
      `${pageRangeLabel(outcome.unreadPages)} — no reader obtained the text, so ${
        count === 1 ? 'it still blocks' : 'they still block'
      } readiness.`,
    )
  }
  return details
}

/**
 * The AI pass's feedback, rendered from wherever the user is: the list view and
 * the workspace both mount it, so turning AI on and importing cannot leave the
 * run invisible. It renders nothing when there is nothing to report — with AI off
 * the store is never written to at all, so this adds no UI and no extra render.
 *
 * `tenderId` scopes the report to the tender on screen: in the workspace,
 * progress and findings for a document the user is not looking at would be
 * feedback about the wrong tender. `className` carries the host's own spacing, so
 * a host that has nothing to report gets no empty gap.
 */
export function AiPassPanel({ tenderId, className }: { tenderId?: string; className?: string }) {
  const state = useAiPass()
  const cancelAiRun = useCallback(() => {
    cancelAiPass()
  }, [])
  if (!state) return null
  if (tenderId !== undefined && state.tenderId !== tenderId) return null

  if (state.status === 'running') {
    const progress = state.progress
    const chars = progress?.chars ?? 0
    return (
      <div
        role="status"
        data-testid="ai-extraction-progress"
        className={`flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2.5 text-[12px] text-[var(--text-secondary)] ${className ?? ''}`}
      >
        <Loader2
          size={14}
          className="shrink-0 animate-spin text-[var(--accent)]"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 leading-relaxed">
          AI extraction — {progress ? aiRunLabel(progress) : 'starting'}
          {chars > 0 ? `, ${chars} characters received` : ''}. The local extraction is already
          saved; this only adds suggestions to the review.
        </span>
        <Button size="sm" variant="default" onClick={cancelAiRun}>
          Cancel AI extraction
        </Button>
      </div>
    )
  }

  const message = aiPassMessage(state)
  const details = aiPassDetails(state)
  if (message.length === 0 && details.length === 0) return null
  // A refusal or a failure is a warning; a finished run that refused nothing and
  // warned about nothing is information.
  const warn =
    state.status === 'failed' ||
    state.status === 'unavailable' ||
    (state.outcome?.rejections.length ?? 0) > 0 ||
    (state.outcome?.warnings.length ?? 0) > 0
  return (
    <div
      role={warn ? 'alert' : 'status'}
      data-testid="intake-notice"
      className={`flex flex-wrap items-start gap-2 rounded-lg border px-3 py-2.5 text-[12px] text-[var(--text-secondary)] ${
        warn
          ? 'border-[var(--warn-border)] bg-[var(--warn-bg)]'
          : 'border-[var(--border)] bg-[var(--surface-subtle)]'
      } ${className ?? ''}`}
    >
      {warn ? (
        <AlertTriangle
          size={14}
          className="mt-0.5 shrink-0 text-[var(--warn)]"
          aria-hidden="true"
        />
      ) : (
        <Sparkles size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="leading-relaxed">{message}</p>
        {details.length > 0 && (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 leading-relaxed">
            {details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={dismissAiPass}>
        Dismiss
      </Button>
    </div>
  )
}

/** What a caller can change about the intake, for one file. */
export interface ShredTenderOptions {
  /**
   * Marks the tender as coming from the bundled sample RFP rather than the
   * user's own document (`TenderRecord.dataOrigin`).
   */
  dataOrigin?: TenderDataOrigin
  /**
   * A managed-store path the file's bytes are ALREADY saved at.
   *
   * A document downloaded from the discovery feed is stored by main before the
   * renderer sees it (`tenders:discovery-download-document` saves it as an `rfp`
   * through the same managed-document store the upload path uses), so the intake
   * adopts that file instead of writing a second copy of it. When present, a
   * cancelled import deletes that stored document rather than leaving an orphan
   * the user never asked for.
   */
  storedPath?: string
}

/**
 * THE intake sequence: one chosen or downloaded document in, one fully-built
 * tender record out.
 *
 * Both intake paths go through here — the dropzone/file input in `TenderList`
 * (a PDF or a Word .docx the user picked) and the discovery pane's "Add to
 * workspace" (a document the app downloaded from the eTenders feed) — so a
 * discovered tender gets the same byte/page preflights, the same local rule
 * engine, the same vault gap analysis, the same issuer template, the same
 * duplicate-reference refusal and the same persistence as an imported one.
 * `TenderList`'s `shredFile` and `intakeTenderFile` below are thin callers.
 */
export async function shredTenderFile(
  file: File,
  signal: AbortSignal,
  options: ShredTenderOptions = {},
): Promise<{
  record: TenderRecord
  extraction: Awaited<ReturnType<typeof extractAllPages>>
  meta: ReturnType<typeof extractTenderMeta>
  /**
   * Non-null when the RFP could not be persisted and fell back to a blob. The
   * value is a plain-language reason, never the raw store/I-O error.
   */
  persistError: string | null
  /**
   * The reference number the parser read already belongs to another tender in
   * this workspace. The record was imported with `referenceNumber: null` and the
   * value is kept in the review annotation instead; `message` says so in plain
   * language (null when there is no collision).
   */
  duplicateReference: DuplicateReferenceCheck
  /**
   * The parsed PDF. Handed back ONLY so the optional AI pass can render a page
   * that has no text layer — the caller owns releasing it (`cleanup()`), so a
   * document whose import fails or whose pass never runs is not left open.
   * Null when the source was a Word .docx: there is no page to render, and the
   * AI pass is told so (see `importVision`).
   */
  doc: PDFDocumentProxy | null
}> {
  const setShredding = useTendersStore.getState().setShredding
  const dataOrigin = options.dataOrigin
  const kind = tenderSourceKind(file)
  if (!kind) throw new Error('Unsupported document type.')
  const wordDocument = kind === 'docx'
  // Each intake path reports its own cancellation, so a cancelled Word import is
  // never described as a cancelled PDF one.
  const throwIfAborted = (): void => {
    if (!signal.aborted) return
    throw wordDocument ? new DocxImportCancelledError() : new PdfImportCancelledError()
  }
  // ONE macrotask between the app's own stages. Each stage below holds the thread
  // by itself — the .docx parse for seconds on a text-heavy document (see the
  // responsiveness note in intake/docx.ts), `shredExtraction` ~1 s on a
  // 24 500-line one — and running two of them back to back makes one unbroken
  // stretch in which the frame cannot repaint and a queued Cancel click cannot be
  // dispatched. A task boundary is where both happen, so the stretches are bounded
  // by the longest single stage instead of by their sum, and the abort check is
  // placed after it so a cancel that lands in the gap stops the import before the
  // next stage's work rather than after it.
  const paintAndCheckAbort = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    throwIfAborted()
  }
  let openedDoc: PDFDocumentProxy | null = null
  // ONE read of the file for the whole import: the same buffer feeds the reader
  // (the PDF parse, or the .docx parse) and the persistence write.
  //
  // Reading it twice — once here and once in the save below — put two full copies
  // of the document's bytes on the heap at the same time for as long as the
  // import ran: `File.arrayBuffer()` returns a fresh ArrayBuffer each call, so a
  // 100 MB PDF held ~200 MB of buffers, on top of whatever the reader allocates.
  // `loadPdfDocument` slices its argument before handing it to pdfjs (which MAY
  // detach what it is given), so the reader never takes ownership of this buffer
  // and reusing it for the write is safe; `extractDocxIntake` reads an
  // `ArrayBuffer` in place, with no copy of its own.
  let fileBytes: ArrayBuffer | null = null
  try {
    let ex: PageExtraction
    if (wordDocument) {
      // Byte preflight BEFORE reading the file buffer, then the line budget that
      // stands in for the PDF path's page budget: a .docx declares its own pages
      // (one, when it declares none), so the cost this bounds is the text, not a
      // page count.
      assertDocxBytesWithinLimit(file.size)
      setShredding({ stage: 'loading', message: 'Reading Word document…', page: 0, total: 0 })
      throwIfAborted()
      fileBytes = await file.arrayBuffer()
      throwIfAborted()
      // The parse is one library call with no internal seam, so this is the only
      // place progress for it can come from. `everyMs: 0` samples once before the
      // parse runs — which is a cancellation check at a third moment, after the
      // bytes have been read — and installs no timer: `setInterval` is clamped to
      // about 1 s between this document's own frames, so polling could not report
      // anything the parse had not already yielded, while the sample itself would
      // block the loop for the interval it waited out. The wait is instead shown
      // honestly and continuously by the spinner `ShredProgress` already renders,
      // with the message saying what the parse is doing and, for the parse itself,
      // why it cannot say how far along it is — a text-heavy .docx holds the
      // thread for seconds in one unbroken block, so a bar derived from any of
      // this would be an invention. `total: 0` is what keeps it indeterminate:
      // `ShredProgress` draws no bar and no page counter without a total.
      ex = await extractDocxIntake(fileBytes, {
        signal,
        onProgress: (progress) =>
          setShredding({
            stage: 'loading',
            message: docxParseProgressMessage(progress),
            page: 0,
            total: 0,
          }),
      })
      throwIfAborted()
    } else {
      // Preflight BEFORE reading the file buffer.
      assertPdfBytesWithinLimit(file.size)
      setShredding({ stage: 'loading', message: 'Reading PDF…', page: 0, total: 0 })
      throwIfAborted()
      fileBytes = await file.arrayBuffer()
      const doc = await loadPdfDocument(fileBytes)
      openedDoc = doc

      // Page-count preflight BEFORE any page is read or rendered.
      assertPdfPagesWithinLimit(doc.numPages)
      throwIfAborted()

      setShredding({
        stage: 'extracting',
        message: 'Extracting text & coordinates…',
        page: 0,
        total: doc.numPages,
      })
      ex = await extractAllPages(
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
    }

    // No per-page progress for a Word document: it has no pages being read, so
    // the bar would count something that never happens (the store renders the
    // counter only when there is a total — see `ShredProgress`). What the Word
    // path reports instead is the phase of its parse, never a fraction of it.
    const progressTotal = wordDocument ? 0 : ex.numPages
    setShredding({
      stage: 'shredding',
      message: 'Matching compliance rules…',
      page: progressTotal,
      total: progressTotal,
    })
    await new Promise((r) => setTimeout(r, 120)) // let the UI paint
    throwIfAborted()
    const extracted = shredExtraction(ex)
    // A task boundary between the two: measured on a 24 500-line Word document,
    // `shredExtraction` holds the thread ~1.05 s and `extractTenderMeta` ~0.8 s, so
    // back to back they are one 1.85 s stretch the frame cannot paint through.
    await paintAndCheckAbort()
    const meta = extractTenderMeta(ex, file.name.replace(/\.(?:pdf|docx)$/i, ''))

    setShredding({
      stage: 'analysing',
      message: 'Running vault gap analysis…',
      page: progressTotal,
      total: progressTotal,
    })
    // …so the message above is actually painted before the analysis below runs.
    await paintAndCheckAbort()
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
    if (options.storedPath) {
      // The bytes are already a managed document — a discovery download is saved
      // by main before the intake sees it — so the tender adopts that file
      // instead of the app writing a second copy of it.
      fileUrl = options.storedPath
      // Same cancellation contract as the upload path below: a cancelled import
      // must not leave a stored document nobody owns.
      if (signal.aborted) {
        try {
          await window.tendersApi?.deleteDocument?.({ storedPath: options.storedPath })
        } catch {
          /* best-effort cleanup */
        }
        throw wordDocument ? new DocxImportCancelledError() : new PdfImportCancelledError()
      }
    } else if (typeof window !== 'undefined' && window.tendersApi?.saveDocument) {
      let storedPath: string | null = null
      try {
        // The buffer this import already read — NOT a second `file.arrayBuffer()`.
        // The reader above never takes ownership of it, so the write sends the
        // same bytes the parser read and one document holds one buffer.
        const buffer = fileBytes ?? (await file.arrayBuffer())
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
        throw wordDocument ? new DocxImportCancelledError() : new PdfImportCancelledError()
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
    // The same rule for the reference number, for a different reason: the schema
    // refuses the ENTIRE document when two tenders carry the same non-null
    // reference, so a re-import (or an RFP lifted from the same source twice)
    // must not write it to the record. The value is not lost — the review step
    // still shows it as the parser's own extraction, and `handleFile` says why
    // the tender's own reference was left blank.
    const duplicateReference = checkDuplicateReference(
      meta.referenceNumber,
      useTendersStore.getState().tenders,
    )
    const record = buildTenderRecord(
      `t-${Date.now()}-${tenderSeq++}`,
      file.name,
      fileUrl,
      ex,
      requirements,
      meta.title,
      {
        referenceNumber: duplicateReference.message === null ? meta.referenceNumber : null,
        issuingBody: meta.issuingBody,
        closingDate: gated.closingDate,
        submissionMethod: gated.submissionMethod,
        submissionAddress: gated.submissionAddress,
      },
    )
    setShredding({ stage: 'done', message: 'Done', page: progressTotal, total: progressTotal })
    // The origin rides on the record, so it is committed with the tender and is
    // still there after a restart.
    return {
      record: dataOrigin ? { ...record, dataOrigin } : record,
      extraction: ex,
      meta,
      persistError,
      duplicateReference,
      doc: openedDoc,
    }
  } catch (err) {
    // Nothing will render from a document whose import failed, so release it
    // here rather than leaving it open for the life of the window.
    void openedDoc?.cleanup().catch(() => {})
    if (err instanceof PdfImportCancelledError || err instanceof DocxImportCancelledError) {
      // Clean cancellation: no tender is added, no partial state is kept.
      setShredding(null)
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    setShredding({ stage: 'error', message: msg, page: 0, total: 0 })
    throw err
  }
}

/** The intake sequence, called with the options its two entry points pass in. */
async function shredFile(
  file: File,
  signal: AbortSignal,
  options: ShredTenderOptions = {},
): Promise<Awaited<ReturnType<typeof shredTenderFile>>> {
  return shredTenderFile(file, signal, options)
}

// ── the optional AI pass, for either intake path ─────────────────────────────
//
// Module-level, so the discovery pane's "Add to workspace" starts the same pass
// an imported file does: one implementation, one abort handle, and therefore one
// run in flight per app — a newer import supersedes an older one exactly as it
// did when the handle was a ref on `TenderList`.

/** Aborts the AI pass started by an intake; null when nothing is in flight. */
let importAiAbort: AbortController | null = null

/** Stop the intake's AI pass in flight, if any. */
export function abortAiPass(): void {
  importAiAbort?.abort()
}

export interface ImportAiPassArgs {
  tenderId: string
  fileName: string
  tenderTitle: string
  extraction: PageExtraction
  /** Null when the source is a Word .docx — see `importVision`. */
  doc: PDFDocumentProxy | null
  /** Lets a host keep its own readiness display current (the list's AI toggle). */
  onReadiness?: (readiness: AiReadiness) => void
}

/**
 * The additive AI pass, started AFTER the local result is committed and shown.
 *
 * It is never awaited by the import path: a slow, failed or cancelled model
 * call cannot delay the tender, and it cannot remove anything the local engine
 * found. Whatever it does produce lands in the review step as suggestions —
 * `unconfirmed`, `suggestedBy: 'ai'` — and its refusals, warnings and the
 * duplicate-reference case are reported rather than swallowed.
 *
 * It also owns the pages without a text layer: each one the parser flagged
 * `needsOcr` is rendered to an image and handed to the model, and the page is
 * recorded `ai-extracted` ONLY when a reading of it actually came back. A model
 * that cannot read an image, a render that fails and a cancelled run all leave
 * those pages blocking exactly as they were.
 */
export async function runAiPass(args: ImportAiPassArgs): Promise<void> {
  // The run is made visible BEFORE anything can refuse it: "no model
  // configured" is one of the outcomes the user has to be able to see, and a
  // refusal recorded after the fact is a refusal nobody reads.
  importAiAbort?.abort()
  const controller = new AbortController()
  importAiAbort = controller
  const runId = startAiPass({
    tenderId: args.tenderId,
    tenderTitle: args.tenderTitle,
    cancel: () => controller.abort(),
  })
  try {
    const bridge = tendersAiBridge()
    const readiness = await readAiReadiness(bridge)
    args.onReadiness?.(readiness)
    if (!readiness.ready) {
      failAiPass(runId, readiness.message, 'unavailable')
      return
    }
    // Readiness can only be `ready` with a bridge in hand; this is what tells
    // the compiler so.
    if (!bridge) {
      failAiPass(runId, 'AI extraction is unavailable in this build.', 'unavailable')
      return
    }
    // A model that cannot take an image is not asked to, and neither is a
    // model reading a Word .docx: that file has no rendered page to hand it.
    // Either way the pages without text keep blocking and the pass says why.
    //
    // The run gets one wall clock for all its phases (`AiRunBudget`), and both
    // model calls carry their own ceiling on that same clock: the vision read via
    // `callTimeoutMs` with the per-call budget, and every text chunk via the
    // budget `runTenderAiPass` hands down. Without them `chunkCount × latency`
    // was unbounded — only a manual Cancel ended a run against a slow provider.
    const vision = importVision({
      doc: args.doc,
      supportsVision: settingsSupportVision(readiness.settings),
      createCompletion: () =>
        createVisionCompletion({
          bridge,
          settings: readiness.settings,
          onProgress: (progress) => reportAiPassChars(runId, progress.chars),
          callTimeoutMs: AI_EXTRACTION_CHUNK_BUDGET_MS,
        }),
      renderPageImage: (doc, pageNumber) =>
        renderPdfPageImage(doc, pageNumber, { signal: controller.signal }),
      budget: {
        chunkBudgetMs: AI_EXTRACTION_CHUNK_BUDGET_MS,
        runBudgetMs: AI_EXTRACTION_CHUNK_BUDGET_MS,
      },
    })
    try {
      const completion = createTendersCompletion({
        bridge,
        settings: readiness.settings,
        onProgress: (progress) => reportAiPassChars(runId, progress.chars),
        // The per-call ceiling: the run's own driver stops waiting at this figure
        // and names the reason, and this is what cancels the request in main so a
        // provider cannot go on streaming into a chunk the run has given up on.
        callTimeoutMs: AI_EXTRACTION_CHUNK_BUDGET_MS,
      })
      const pass = await runTenderAiPass({
        completion,
        pages: args.extraction.pages.map((page) => ({
          pageNumber: page.pageNumber,
          text: page.text,
          needsOcr: page.needsOcr,
        })),
        numPages: args.extraction.numPages,
        rules: AI_EXTRACTION_RULES,
        fileName: args.fileName,
        tenderTitle: args.tenderTitle,
        signal: controller.signal,
        vision,
        budget: {
          chunkBudgetMs: AI_EXTRACTION_CHUNK_BUDGET_MS,
          runBudgetMs: AI_EXTRACTION_RUN_BUDGET_MS,
        },
        onProgress: (progress) => reportAiPassProgress(runId, progress),
      })
      if (controller.signal.aborted) {
        // Either the user cancelled or a newer import superseded this run. The
        // store already recorded that, and `cancelAiPass` is given this run's
        // id so a superseded attempt cannot cancel the one that replaced it.
        cancelAiPass(runId)
        return
      }
      // Read the tender back from the store: the user may have removed a
      // requirement (or the tender) while the model was working.
      const state = useTendersStore.getState()
      const tender = state.tenders.find((candidate) => candidate.id === args.tenderId)
      if (!tender) {
        failAiPass(
          runId,
          'the tender this run was for is no longer in the workspace, so nothing was applied',
        )
        return
      }
      const adaptation = adaptAiExtraction({
        merged: pass.merged,
        existingRuleKeys: tender.requirements.map((requirement) => requirement.ruleKey),
        existingTenders: state.tenders,
        tenderId: args.tenderId,
        visionSummary: pass.vision.summary,
      })
      // The store decides whether this run may still report. A run cancelled or
      // superseded between the model answering and here is refused, so a
      // stopped run can never write a partial result into the tender.
      const accepted = finishAiPass(runId, {
        summary: adaptation.summary,
        rejections: adaptation.rejections,
        warnings: adaptation.warnings,
        unreadPages: adaptation.unreadPages,
        readPages: pass.vision.readPages,
        visionSkippedReason: pass.vision.skippedReason,
        visionUnread: pass.vision.unread,
        duplicateReference: adaptation.duplicateReference?.message ?? null,
      })
      if (!accepted) return
      if (adaptation.requirements.length > 0) {
        // AI rows go through the same vault gap analysis as the parser's, so a
        // suggestion is matched against the vault exactly like a parsed rule.
        const vaultIndex = buildVaultKeywordIndex(state.vault)
        const added: RequirementRecord[] = applyGapToRequirementsIndexed(
          adaptation.requirements.map((requirement) => ({
            ...requirement,
            status: 'OUTSTANDING' as const,
            linkedVaultDocId: null,
            reason: null,
            suggestedVaultDocIds: [],
          })),
          vaultIndex,
        )
        useTendersStore
          .getState()
          .updateTender(args.tenderId, { requirements: [...tender.requirements, ...added] })
      }
      const review = useTendersStore.getState().tenderReviews[args.tenderId]
      if (review) {
        // The page states are written from the vision pass's own per-page
        // result, never from what the model said about itself: a page is
        // marked `ai-extracted` only where a reading of its image came back,
        // and only where the parser had flagged it `needsOcr`.
        const withPages = review.pages
          ? {
              ...review,
              pages: markModelReadPages(review.pages, {
                scannedPages: pass.vision.scannedPages,
                readPages: pass.vision.readPages,
              }),
            }
          : review
        useTendersStore
          .getState()
          .setTenderReview(args.tenderId, mergeAiIntoReview(withPages, adaptation))
      }
    } catch (error) {
      // Nothing is discarded: the local extraction is already committed, and
      // this only adds a visible reason why the AI pass produced nothing. A
      // run that was already stopped keeps its own state — a cancelled run
      // cannot be relabelled as a failure, nor the other way round.
      failAiPass(runId, error instanceof Error ? error.message : String(error))
    } finally {
      // Only the run that still owns the ref clears it: a second import
      // supersedes this one, and the newer run must survive this one's
      // unwinding.
      if (importAiAbort === controller) importAiAbort = null
    }
  } finally {
    // The parsed document was handed over only so a flagged page could be
    // rendered, and every path through this pass is done with it. A Word
    // .docx has none to release.
    void args.doc?.cleanup().catch(() => {})
  }
}

// ── one intake path for both entry points ────────────────────────────────────
//
// `TenderList`'s file input and the discovery pane's "Add to workspace" both end
// here, so a tender that came from the eTenders feed is built by the same code as
// one the user chose: the same review gate, the same readiness inputs, the same
// compliance matrix, and the same optional AI pass. What differs is only where
// the bytes came from — and that difference is recorded, never hidden (see
// `reviewNotes`, which the discovery pane uses for provenance).

export interface TenderIntakeOptions {
  signal: AbortSignal
  dataOrigin?: TenderDataOrigin
  /** A managed-store path the bytes are already saved at (see `ShredTenderOptions`). */
  storedPath?: string
  /** Run the optional AI pass after the local result is committed. */
  aiExtraction?: boolean
  /**
   * Extra notes for the review step's own conflict list. They are persisted with
   * the tender (`intakeVerification.conflicts`) and shown at the top of the
   * review, which is where a reader has to meet them before confirming anything.
   * The discovery pane records a machine-sourced tender's provenance this way.
   */
  reviewNotes?: string[]
  onReadiness?: (readiness: AiReadiness) => void
  /** The RFP could not be persisted and is only a session blob. */
  onPersistFailure?: (failure: { tenderId: string; label: string; message: string }) => void
  /** The parser read a reference that already belongs to another tender. */
  onDuplicateReference?: (message: string) => void
}

export interface TenderIntakeResult {
  tenderId: string
  record: TenderRecord
}

/**
 * Read one document into a tender and commit it. Throws the intake's own typed
 * errors (`PdfPreflightError` / `DocxPreflightError` / the two cancel errors) so
 * each caller words its failure for its own surface; everything the two callers
 * share is decided here.
 */
export async function intakeTenderFile(
  file: File,
  options: TenderIntakeOptions,
): Promise<TenderIntakeResult> {
  const kind = tenderSourceKind(file)
  // How this import's own messages name the file: "the PDF" is wrong for a Word
  // document, and the two paths fail in different ways.
  const label = kind === 'docx' ? 'Word document' : 'PDF'
  const { record, extraction, meta, persistError, duplicateReference, doc } = await shredFile(
    file,
    options.signal,
    { dataOrigin: options.dataOrigin, storedPath: options.storedPath },
  )
  if (options.signal.aborted) {
    // The import was cancelled after the shred: nothing is added, no partial
    // state is kept, and the parsed document is released.
    void doc?.cleanup().catch(() => {})
    throw kind === 'docx' ? new DocxImportCancelledError() : new PdfImportCancelledError()
  }
  const store = useTendersStore.getState()
  store.addTender(record)
  if (persistError) {
    // The tender imports fine, but the document fell back to an object URL that
    // dies on reload. Say so, and offer to retry the save.
    options.onPersistFailure?.({
      tenderId: record.id,
      label,
      message: `The ${label} could not be saved to the workspace — ${persistError}. It is open for this session only and must be re-attached before you rely on it after a restart.`,
    })
  }
  // Seed the extraction review from the parser's candidates so the user sees
  // competing values and source pages straight away. Every field arrives
  // `unconfirmed` — a discovered tender is machine-sourced exactly like a model
  // suggestion, and only a human action moves a field out of that state.
  const seeded = deriveTenderReview({
    meta,
    extraction,
    requirements: record.requirements,
    estimatedValue: record.estimatedValue ?? null,
  })
  const notes = (options.reviewNotes ?? []).filter((note) => note.trim().length > 0)
  store.setTenderReview(
    record.id,
    notes.length === 0
      ? seeded
      : {
          ...seeded,
          // The caller's notes lead, and the whole list is clamped to what the
          // schema accepts, so a provenance note can never push a review over
          // the bound and make every autosave of the document fail.
          conflicts: [...notes, ...seeded.conflicts].slice(0, MAX_TENDERS_REVIEW_CONFLICTS),
        },
  )
  store.setActiveTender(record.id)
  // A reference number that already belongs to another tender is kept in review
  // rather than written to the record (the schema refuses the whole document on a
  // duplicate), so say so instead of letting every autosave fail with a
  // path-shaped schema error.
  if (duplicateReference.message !== null)
    options.onDuplicateReference?.(duplicateReference.message)
  // The local result is committed and visible; the AI pass starts now and is
  // deliberately not awaited. For a Word .docx `doc` is null and the pass is
  // told there is no page image to read.
  if (options.aiExtraction) {
    void runAiPass({
      tenderId: record.id,
      fileName: record.fileName,
      tenderTitle: record.title,
      extraction,
      doc,
      onReadiness: options.onReadiness,
    })
  } else {
    // Nothing will render from it: release the parsed document now rather than
    // leaving it open for the life of the window.
    void doc?.cleanup().catch(() => {})
  }
  return { tenderId: record.id, record }
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
  const removeTender = useTendersStore((s) => s.removeTender)
  const removeIssuerTemplate = useTendersStore((s) => s.removeIssuerTemplate)
  const setActiveTender = useTendersStore((s) => s.setActiveTender)
  const setShredding = useTendersStore((s) => s.setShredding)
  const updateTender = useTendersStore((s) => s.updateTender)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Visible (role="alert") notice when an imported RFP could not be persisted
  // and is only a session blob — never a silent console warning.
  const [storageWarning, setStorageWarning] = useState<{
    tenderId: string
    /** How the message names the file: "PDF" or "Word document". */
    label: string
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

  // ── the optional AI pass ───────────────────────────────────────────────────
  // OFF unless the user turned it on, and remembered between imports (see
  // `readAiExtractionPreference`). `aiReadiness` answers "can it be offered at
  // all?" — with no model configured the toggle is not shown silently, the
  // reason is stated instead.
  const [aiEnabled, setAiEnabled] = useState<boolean>(() => readAiExtractionPreference())
  const [aiReadiness, setAiReadiness] = useState<AiReadiness | null>(null)
  // The AI pass's own progress, outcome and cancel handle live in the module-level
  // store above, NOT here: importing a tender activates it, which unmounts this
  // component, so state kept here would be gone before the run it describes.
  // `intakeNotice` is left for the one intake message that is not the AI pass's:
  // a reference number the parser read that already belongs to another tender.
  const [intakeNotice, setIntakeNotice] = useState<AiNotice | null>(null)
  // Read by the import callback without re-creating it on every toggle.
  const aiEnabledRef = useRef(aiEnabled)
  aiEnabledRef.current = aiEnabled

  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void readAiReadiness().then((readiness) => {
        if (alive) setAiReadiness(readiness)
      })
    }
    refresh()
    // The settings surface lives in the shell, so a model configured while this
    // view is open is picked up when the user comes back to it — otherwise the
    // opt-in would stay hidden until a reload.
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const toggleAiExtraction = useCallback((enabled: boolean) => {
    setAiEnabled(enabled)
    persistAiExtractionPreference(enabled)
    // The run in flight belongs to the intake, not to this view, so the handle
    // is the module-level one (see `abortAiPass`).
    if (!enabled) abortAiPass()
  }, [])

  const cancelImport = useCallback(() => {
    importAbortRef.current?.abort()
  }, [])

  const handleFile = useCallback(
    async (file: File, options?: { dataOrigin?: TenderDataOrigin }): Promise<string | null> => {
      const kind = tenderSourceKind(file)
      if (!kind) {
        setError('Only PDF and Word (.docx) documents are supported.')
        return null
      }
      // How this import's own messages name the file: "the PDF" is wrong for a
      // Word document, and the two paths fail in different ways.
      const label = kind === 'docx' ? 'Word document' : 'PDF'
      setError(null)
      setStorageWarning(null)
      const controller = new AbortController()
      importAbortRef.current?.abort()
      importAbortRef.current = controller
      try {
        // The whole sequence lives in `intakeTenderFile`, so this path and the
        // discovery pane's "Add to workspace" cannot drift apart. This view owns
        // only what is its own: the visible error, the storage warning and the
        // duplicate-reference notice.
        const { tenderId } = await intakeTenderFile(file, {
          signal: controller.signal,
          dataOrigin: options?.dataOrigin,
          aiExtraction: aiEnabledRef.current,
          onReadiness: setAiReadiness,
          onPersistFailure: (failure) => {
            lastImportFileRef.current = file
            setStorageWarning({
              tenderId: failure.tenderId,
              label: failure.label,
              message: failure.message,
            })
          },
          // Intake feedback, not the AI pass's, so it stays in this view's own
          // state — reported at the moment of the import, alongside the card it
          // belongs to.
          onDuplicateReference: (message) => setIntakeNotice({ tone: 'warn', message }),
        })
        if (controller.signal.aborted) return null
        return tenderId
      } catch (err) {
        if (err instanceof PdfImportCancelledError || err instanceof DocxImportCancelledError) {
          setError('Import cancelled.')
          return null
        }
        if (err instanceof PdfPreflightError || err instanceof DocxPreflightError) {
          // Typed, user-visible reason (oversize file, too many pages/lines, a
          // protected or unreadable package).
          setError(err.message)
          return null
        }
        setError(
          kind === 'docx'
            ? 'Could not read that Word document. Is it damaged or password-protected?'
            : 'Could not process that PDF. Is it encrypted or malformed?',
        )
        setTimeout(() => setShredding(null), 2500)
        return null
      } finally {
        if (importAbortRef.current === controller) importAbortRef.current = null
      }
    },
    [setShredding],
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
        message: `The ${warning.label} still could not be saved to the workspace — ${persistFailureReason(
          res?.error,
        )}. It remains available for this session only.`,
      })
    } catch (err) {
      setStorageWarning({
        ...warning,
        message: `The ${warning.label} still could not be saved to the workspace — ${persistFailureReason(
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
        'The bundled sample RFP could not be loaded. Choose a PDF or a Word .docx from your own machine instead — shredding works exactly the same.',
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
          Drop a tender RFP (one PDF at a time, or a Word .docx) — Zanostack Tenders shreds it
          locally on this machine into a compliance matrix, cross-references your company vault, and
          shows every source clause.
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
                Drag &amp; drop a tender RFP (PDF or Word .docx), or
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <Button variant="primary" onClick={() => inputRef.current?.click()}>
                  <FolderOpen size={15} /> Choose document
                </Button>
                <Button onClick={loadDemo} title={DEMO_TENDER_HINT}>
                  <FileText size={15} /> Load demo RFP
                </Button>
              </div>
              {/* The claim that shipped here ("100% local processing — your
                  documents never leave this computer") stopped being true the
                  moment a model could be asked to read the document, so the
                  exception is stated in the same sentence as the claim. */}
              <p className="mt-3 text-xs text-[var(--text-tertiary)]">
                The local rule engine runs on this machine, offline, and is always available.
                Nothing is uploaded unless you turn on AI extraction, which sends the document to
                the model provider you configured.
              </p>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">{intakeLimitDisclosure()}</p>
              {/* Optional AI extraction: off unless the user turns it on, and
                  remembered between imports. Offered only when a model is
                  actually configured — otherwise the reason is stated plainly
                  instead of a toggle that could only fail. */}
              <div className="mt-4 flex flex-col items-center gap-1.5">
                {aiReadiness?.ready === true ? (
                  <>
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                      <input
                        type="checkbox"
                        checked={aiEnabled}
                        onChange={(e) => toggleAiExtraction(e.target.checked)}
                        data-testid="ai-extraction-toggle"
                        className="size-3.5 cursor-pointer accent-[var(--accent)]"
                      />
                      <Sparkles size={13} className="text-[var(--accent)]" aria-hidden="true" />
                      AI extraction (optional)
                    </label>
                    <p className="max-w-md text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                      The local rule engine always runs first, offline. With this on, the model
                      provider you configured in Settings is also asked to suggest extra
                      requirements and metadata — the document's text is sent to that provider, and
                      so is a scanned page's image when that model can read one (a Word .docx has no
                      page images, so only its text is sent). Everything it returns is unconfirmed
                      until you confirm it. You can cancel a run at any time.
                    </p>
                    {!settingsSupportVision(aiReadiness.settings) && (
                      <p
                        data-testid="ai-extraction-no-vision"
                        className="max-w-md text-[11px] leading-relaxed text-[var(--warn)]"
                      >
                        {IMAGE_READING_UNAVAILABLE_MESSAGE}, so pages without a text layer will not
                        be read by AI and will keep blocking readiness until you review them
                        yourself.
                      </p>
                    )}
                  </>
                ) : aiReadiness ? (
                  <p
                    data-testid="ai-extraction-unavailable"
                    className="max-w-md text-[11px] leading-relaxed text-[var(--text-tertiary)]"
                  >
                    {aiReadiness.message}
                  </p>
                ) : null}
              </div>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={`application/pdf,.pdf,${DOCX_MIME},.docx`}
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

        {/* The AI pass runs only AFTER the local result is committed and shown,
            so this never blocks the tender from appearing — and it can be
            cancelled mid-run. The panel reads the module-level store rather than
            this component's state, so the same progress row, the same cancel
            control and the same findings are on screen in the workspace too:
            importing activates the tender, which unmounts this component. */}
        <AiPassPanel className="mt-4" />

        {/* The one intake message that is not the AI pass's: a reference number the
            parser read that already belongs to another tender. It has its own
            testid because the AI pass's outcome notice can be on screen at the
            same time, and two elements answering to one testid are not
            addressable. */}
        {intakeNotice && (
          <div
            role={intakeNotice.tone === 'warn' ? 'alert' : 'status'}
            data-testid="intake-reference-notice"
            className={`mt-4 flex flex-wrap items-start gap-2 rounded-lg border px-3 py-2.5 text-[12px] text-[var(--text-secondary)] ${
              intakeNotice.tone === 'warn'
                ? 'border-[var(--warn-border)] bg-[var(--warn-bg)]'
                : 'border-[var(--border)] bg-[var(--surface-subtle)]'
            }`}
          >
            {intakeNotice.tone === 'warn' ? (
              <AlertTriangle
                size={14}
                className="mt-0.5 shrink-0 text-[var(--warn)]"
                aria-hidden="true"
              />
            ) : (
              <Sparkles
                size={14}
                className="mt-0.5 shrink-0 text-[var(--accent)]"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="leading-relaxed">{intakeNotice.message}</p>
              {intakeNotice.details && intakeNotice.details.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 leading-relaxed">
                  {intakeNotice.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
            <Button size="sm" variant="ghost" onClick={() => setIntakeNotice(null)}>
              Dismiss
            </Button>
          </div>
        )}

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
              No tenders yet — drop a tender RFP (a PDF or a Word .docx), or load the bundled demo
              RFP, to see the full compliance workflow.
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
                            <span>{documentPageSummary(t)}</span>
                            {t.ocrPages > 0 && (
                              // Naming pages whose text was never obtained obliges
                              // the badge to state their outcome: nothing on them
                              // was extracted, so the count is work to review, not
                              // text to search. A Word .docx has no scanner, so a
                              // page of it that holds no text holds a picture —
                              // calling that "scanned" would name a mechanism that
                              // never ran on this file.
                              <Badge tone="amber">
                                {isWordDocumentName(t.fileName)
                                  ? `${t.ocrPages} picture-only page${
                                      t.ocrPages === 1 ? '' : 's'
                                    } — text not extracted`
                                  : `${t.ocrPages} scanned page${
                                      t.ocrPages === 1 ? '' : 's'
                                    } — text not extracted`}
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
          {/* The page counter is rendered only when the import actually has pages
              being read. A Word .docx has none (it declares its own pages, and
              the whole file is one block), and "page 0 / ?" would report progress
              through something that never happens. */}
          {s.total > 0 && (
            <p className="mt-2 text-xs text-[var(--text-tertiary)]">
              page {s.page} / {s.total}
            </p>
          )}
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

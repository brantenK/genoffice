// Workspace view: split-pane shell — compliance matrix (left) + embedded PDF
// viewer (right). Loads the active tender's PDF into a PDFDocumentProxy for the
// viewer, and hosts the company-vault + bid-readiness drawers. Shows a live
// closing-date countdown, the recommended submit-by time, the submission
// method/address, and a re-attach flow when the PDF's object URL died on reload.
//
// WP-12 — responsive workspace and action hierarchy:
//   • Wide: a draggable matrix/PDF split whose proportion is persisted (key
//     `zanostack-tenders-workspace-split-v1`) and clamped to sensible bounds.
//   • Compact (short containers, e.g. 800×600): a Requirements ⇄ PDF segmented
//     switch shows one pane at a time; both stay mounted so the selected
//     requirement and current PDF page survive the switch.
//   • Metadata and low-frequency actions move into a labelled overflow menu.
//   • Action hierarchy: review blockers → readiness/submission → evidence vault,
//     with export/proposal/CRM/milestones demoted.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Building2,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Clock,
  FileText,
  FileUp,
  Mail,
  MapPin,
  Monitor,
  MoreHorizontal,
  RefreshCw,
  ShieldAlert,
  Table,
  Award,
  Zap,
  X,
} from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { deadlineStatus, urgencyClasses, useNow } from '../deadline'
import { extractAllPages, loadPdfDocument } from '../pdf/extract'
import { assessReadiness } from '../readiness'
import { selectActiveTender, useTendersStore } from '../store'
import {
  SUBMISSION_METHOD_LABEL,
  type ContractMilestone,
  type TenderRecord,
} from '../../shared/types'
import { milestonesAllowed } from '../../../shared/lifecycle'
import { formatRandAmount } from '../../../shared/money'
import { PdfViewer } from './PdfViewer'
import {
  AI_SUGGESTION_ACCESSIBLE_NAME,
  AI_SUGGESTION_LABEL,
  AI_SUGGESTION_TITLE,
  ExtractionReview,
  deriveTenderReview,
  isWordDocumentName,
  refreshTenderReview,
  summarizeReview,
  wordDocumentPaginationNote,
} from './ExtractionReview'
import {
  SAMPLE_WRITE_BLOCKED_REASON,
  TenderLifecyclePanel,
  crossAppWritesBlocked,
} from './TenderLifecyclePanel'
import { RequirementList } from './RequirementList'
import { ReadinessDrawer } from './ReadinessDrawer'
import { VaultDrawer } from './VaultDrawer'
import {
  MilestonesDrawer,
  runMilestoneBilling,
  type MilestoneBillingFeedback,
} from './MilestonesDrawer'
import { SaveStatus } from './SaveStatus'
import { AiPassPanel } from './TenderList'
import { Badge, Button, Spinner } from './ui'

/** Container width at (or above) which the matrix/PDF split is comfortable. */
const WIDE_MIN_CONTAINER_PX = 900
/** Default / minimum / maximum share of the container given to the matrix. */
const SPLIT_DEFAULT = 0.42
const SPLIT_MIN = 0.3
const SPLIT_MAX = 0.66
/** Hard pixel floors and the handle's width, used to clamp the proportion. */
const MIN_MATRIX_PX = 300
const MIN_PDF_PX = 340
const HANDLE_PX = 6
const SPLIT_STORAGE_KEY = 'zanostack-tenders-workspace-split-v1'
/**
 * Readable floor (CSS px) for the tender-title container. `responsive.css`
 * zeroes `min-width` on every toolbar child so the toolbar can wrap at large
 * text sizes; without an explicit floor the toolbar's buttons squeeze the title
 * down to a single character (measured: `S…` at a 1359px viewport), and the
 * countdown badge spills under the save chip.
 *
 * Applied inline because a class-level floor loses to that stylesheet rule.
 * Deliberately in px, not `rem`: the toolbar's buttons scale with the text too,
 * so a text-relative floor would grow at exactly the zoom level where the row
 * has the least room to give, turning a wrapping toolbar into a starved one.
 */
const TITLE_MIN_WIDTH = 240

/** Cross-app actions whose failure is surfaced in the workspace header. */
type CrossAppAction = 'sheets' | 'docs' | 'crm' | 'books'

/** One surfaced cross-app failure: what failed, why, and how to repeat it. */
interface ToolError {
  action: CrossAppAction
  message: string
  /** Re-open target for the CRM action, so Retry repeats the same request. */
  dealId?: string
}

const TOOL_ERROR_TITLE: Record<CrossAppAction, string> = {
  sheets: 'Export to Sheets failed',
  docs: 'Draft proposal failed',
  crm: 'Open CRM deal failed',
  books: 'Open Books failed',
}

function clampFraction(value: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value))
}

/** Read the persisted split proportion; falls back to the default on any error. */
function readStoredFraction(): number {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return SPLIT_DEFAULT
    const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY)
    if (!raw) return SPLIT_DEFAULT
    const parsed = JSON.parse(raw) as { matrixFraction?: unknown }
    const value = Number(parsed?.matrixFraction)
    return Number.isFinite(value) ? clampFraction(value) : SPLIT_DEFAULT
  } catch {
    return SPLIT_DEFAULT
  }
}

function persistFraction(value: number): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify({ matrixFraction: value }))
  } catch {
    // Storage unavailable (private mode / disabled) — the split still works.
  }
}

/** Observe an element's content width (0 until first measurement). */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

type CompactPane = 'requirements' | 'pdf'

export function Workspace() {
  const tender = useTendersStore(selectActiveTender)
  const setView = useTendersStore((s) => s.setView)
  const setPage = useTendersStore((s) => s.setPage)
  const rerunGap = useTendersStore((s) => s.rerunGap)
  const updateTender = useTendersStore((s) => s.updateTender)
  const setTenderReview = useTendersStore((s) => s.setTenderReview)
  const tenderReviews = useTendersStore((s) => s.tenderReviews)
  const focusRequirement = useTendersStore((s) => s.focusRequirement)
  const activeRequirementId = useTendersStore((s) => s.activeRequirementId)
  const currentPage = useTendersStore((s) => s.currentPage)
  const zoom = useTendersStore((s) => s.zoom)
  const vault = useTendersStore((s) => s.vault)
  const company = useTendersStore((s) => s.company)
  const saveStatus = useTendersStore((s) => s.saveStatus)
  const saveError = useTendersStore((s) => s.saveError)
  const saveSizeWarning = useTendersStore((s) => s.saveSizeWarning)
  const retrySave = useTendersStore((s) => s.retrySave)
  const reloadCommittedFromMain = useTendersStore((s) => s.reloadCommittedFromMain)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  // Bumped by the error state's "Try again" so the load effect re-runs without
  // the user having to change the tender.
  const [pdfReloadToken, setPdfReloadToken] = useState(0)
  // Visible (role="alert") notice when a re-attached PDF could not be persisted.
  const [pdfSaveError, setPdfSaveError] = useState<string | null>(null)
  const [vaultOpen, setVaultOpen] = useState(false)
  const [readinessOpen, setReadinessOpen] = useState(false)
  const [milestonesOpen, setMilestonesOpen] = useState(false)
  const [billingId, setBillingId] = useState<string | null>(null)
  const [billingFeedback, setBillingFeedback] = useState<MilestoneBillingFeedback | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [crmBusy, setCrmBusy] = useState(false)
  const [crmError, setCrmError] = useState<string | null>(null)
  // Every cross-app call — Sheets export, Docs draft, opening the linked CRM
  // deal, opening Books — surfaces a failed, refused or unavailable bridge
  // visibly (role=alert) with a retry, exactly like CRM sync and billing. A
  // discarded `{ok:false}` / `false` would leave the user believing the other
  // app had opened.
  const [toolError, setToolError] = useState<ToolError | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * Which overflow item is the menu's active descendant.
   *
   * A `role="menu"` promises a roving tabindex: exactly one item is tabbable,
   * Arrow/Home/End move between them, and a disabled item is never landed on.
   * The index is kept here so the tabindex is rendered from state rather than
   * written into the DOM behind React's back.
   */
  const [menuActiveIndex, setMenuActiveIndex] = useState(0)
  const [activePane, setActivePane] = useState<CompactPane>('requirements')
  const [matrixFraction, setMatrixFraction] = useState<number>(() => readStoredFraction())
  const [dragging, setDragging] = useState(false)
  const reattachRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const dragPointerRef = useRef<number | null>(null)
  const [splitRef, splitWidth] = useElementWidth<HTMLDivElement>()
  const now = useNow(60_000)

  // Cross-app writes (CRM sync, Books billing) stay off inside a sample workspace
  // — the tender can be copied into the user's own workspace first.
  const sampleWritesBlocked = useTendersStore((s) =>
    crossAppWritesBlocked(s.workspaces, s.activeCompanyId),
  )

  // Opening the linked CRM deal is a cross-app call like any other: the main
  // handler answers `{ok:false}` when no CRM window can be opened, and a
  // rejection must not vanish either.
  const openCrmDeal = useCallback(async (dealId: string) => {
    setToolError(null)
    try {
      const res = await window.tendersApi?.openInCrm(dealId)
      if (!res) {
        setToolError({
          action: 'crm',
          message: 'The CRM bridge is unavailable in this build.',
          dealId,
        })
        return
      }
      if (!res.ok) {
        // The main handler adds a message on a refused request (an unauthorized
        // sender); the plain `{ok:false}` case means no CRM window to open.
        const detail = (res as { error?: { message?: string } }).error?.message
        setToolError({
          action: 'crm',
          message: detail
            ? `Zanostack CRM refused to open the linked deal: ${detail}`
            : 'Zanostack CRM did not open the linked deal. Retry when the CRM app is available.',
          dealId,
        })
      }
    } catch (err) {
      setToolError({
        action: 'crm',
        message: err instanceof Error ? err.message : String(err),
        dealId,
      })
    }
  }, [])

  // Same contract for the Books window: `false` means it did not open.
  const openBooksTab = useCallback(async () => {
    setToolError(null)
    try {
      const opened = await window.tendersApi?.openBooks?.()
      if (opened === undefined) {
        setToolError({
          action: 'books',
          message: 'The Books bridge is unavailable in this build.',
        })
        return
      }
      if (!opened) {
        setToolError({
          action: 'books',
          message: 'Zanostack Books did not open. Retry once the Books app is available.',
        })
      }
    } catch (err) {
      setToolError({
        action: 'books',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [])

  const syncCrm = useCallback(async () => {
    if (!tender) return
    setCrmError(null)
    setCrmBusy(true)
    const deterministicDealId = `deal-tender-${tender.id}`
    let dealId: string | undefined
    try {
      const res = await window.tendersApi?.syncWithCrm({
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
      if (!res || !res.ok) {
        setCrmError(res?.error || 'CRM sync failed. Retry when the CRM app is available.')
        return
      }
      dealId = res.dealId || deterministicDealId
      if (res.dealId) updateTender(tender.id, { linkedCrmDealId: res.dealId })
    } catch (err) {
      setCrmError(err instanceof Error ? err.message : String(err))
      return
    } finally {
      setCrmBusy(false)
    }
    // Opening the deal is a separate cross-app call, made only after the sync
    // has been persisted: a failure here is reported as "the deal did not open",
    // never as a failed sync, and it is never silently discarded.
    if (dealId) await openCrmDeal(dealId)
  }, [tender, updateTender, openCrmDeal])

  // Export the compliance matrix to Sheets. A missing bridge, `{ok:false}` or a
  // thrown rejection is reported instead of being discarded.
  const runExportMatrix = useCallback(async () => {
    if (!tender) return
    setToolError(null)
    try {
      const res = await window.tendersApi?.exportMatrixToSheets(
        tender.id,
        tender.title,
        tender.requirements,
      )
      if (!res) {
        setToolError({
          action: 'sheets',
          message: 'The Sheets bridge is unavailable in this build.',
        })
        return
      }
      if (!res.ok) {
        setToolError({
          action: 'sheets',
          message: res.error || 'Zanostack Sheets did not accept the compliance matrix.',
        })
      }
    } catch (err) {
      setToolError({
        action: 'sheets',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [tender])

  // Draft the tender proposal in Docs; same visible-failure contract as above.
  const runDraftProposal = useCallback(async () => {
    if (!tender) return
    setToolError(null)
    try {
      const res = await window.tendersApi?.draftProposalDoc(tender)
      if (!res) {
        setToolError({ action: 'docs', message: 'The Docs bridge is unavailable in this build.' })
        return
      }
      if (!res.ok) {
        setToolError({
          action: 'docs',
          message: res.error || 'Zanostack Docs did not accept the proposal draft.',
        })
      }
    } catch (err) {
      setToolError({
        action: 'docs',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [tender])

  const retryToolAction = useCallback(() => {
    if (!toolError) return
    if (toolError.action === 'docs') void runDraftProposal()
    else if (toolError.action === 'sheets') void runExportMatrix()
    else if (toolError.action === 'crm') void openCrmDeal(toolError.dealId ?? '')
    else void openBooksTab()
  }, [toolError, runExportMatrix, runDraftProposal, openCrmDeal, openBooksTab])

  const review = tender ? tenderReviews[tender.id] : undefined
  const reviewSummary = useMemo(
    () => (tender ? summarizeReview(tender, review) : null),
    [tender, review],
  )

  // A Word .docx is not a PDF: it has no rendered pages, so it is never handed
  // to pdfjs (which could only fail, and would be reported as "the tender PDF
  // could not be opened" for a document that was read perfectly). The source
  // pane shows the clauses the extractor lifted instead.
  const wordDocument = isWordDocumentName(tender?.fileName)

  const readiness = useMemo(
    () => (tender ? assessReadiness(tender, vault, company, now) : null),
    [tender, vault, company, now],
  )

  // Compact when the workspace container (not the window) is too short for a
  // comfortable side-by-side split. Container-based so collapsing the app
  // sidebar instantly widens the workspace.
  const compact = splitWidth > 0 && splitWidth < WIDE_MIN_CONTAINER_PX

  // Effective share of the container for the matrix pane, clamped so neither
  // pane drops below its pixel floor at the current container width.
  const effectiveFraction = useMemo(() => {
    if (splitWidth <= 0) return matrixFraction
    const minFraction = Math.max(SPLIT_MIN, MIN_MATRIX_PX / splitWidth)
    const maxFraction = Math.min(SPLIT_MAX, 1 - (MIN_PDF_PX + HANDLE_PX) / splitWidth)
    if (maxFraction <= minFraction) return clampFraction(matrixFraction)
    return Math.min(maxFraction, Math.max(minFraction, matrixFraction))
  }, [matrixFraction, splitWidth])

  const commitFraction = useCallback((value: number) => {
    const next = clampFraction(value)
    setMatrixFraction(next)
    persistFraction(next)
  }, [])

  const handleSplitPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragPointerRef.current = event.pointerId
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const handleSplitPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragPointerRef.current !== event.pointerId) return
      const rect = splitRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      setMatrixFraction(clampFraction((event.clientX - rect.left) / rect.width))
    },
    [splitRef],
  )

  const handleSplitPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragPointerRef.current !== event.pointerId) return
      dragPointerRef.current = null
      setDragging(false)
      persistFraction(clampFraction(matrixFraction))
    },
    [matrixFraction],
  )

  const handleSplitKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      let next: number | null = null
      if (event.key === 'ArrowLeft') next = matrixFraction - 0.03
      else if (event.key === 'ArrowRight') next = matrixFraction + 0.03
      else if (event.key === 'Home') next = SPLIT_MIN
      else if (event.key === 'End') next = SPLIT_MAX
      if (next === null) return
      event.preventDefault()
      commitFraction(next)
    },
    [matrixFraction, commitFraction],
  )

  // Bumped every time the PDF pane is (re-)activated in compact mode. The
  // viewer watches this and re-locates the selected requirement once the pane
  // is actually laid out (a hidden pane has no scroll geometry, so the locate
  // must be re-issued rather than relying on the mount-time scroll).
  const [pdfActivation, setPdfActivation] = useState(0)

  const showCompactPane = useCallback(
    (next: CompactPane) => {
      setActivePane(next)
      // Switching to the PDF with a requirement selected must still locate it.
      // `focusRequirement` sets pendingFocus for the normal list→PDF path; the
      // activation counter additionally forces a re-locate for an already
      // selected requirement (whose pendingFocus has long been cleared).
      if (next === 'pdf') {
        const id = useTendersStore.getState().activeRequirementId
        if (id) focusRequirement(id)
        setPdfActivation((n) => n + 1)
      }
    },
    [focusRequirement],
  )

  // Every tender must be reviewed before it can be treated as extracted. A
  // tender imported before this feature (or whose review annotations were lost)
  // gets a review seeded from its current values, so the gate can never be
  // silently skipped.
  useEffect(() => {
    if (!tender || review) return
    setTenderReview(
      tender.id,
      deriveTenderReview({
        meta: {
          title: tender.title,
          referenceNumber: tender.referenceNumber,
          issuingBody: tender.issuingBody,
          closingDate: tender.closingDate,
          submissionMethod: tender.submissionMethod,
          submissionAddress: tender.submissionAddress,
        },
        requirements: tender.requirements,
        estimatedValue: tender.estimatedValue ?? null,
      }),
    )
  }, [tender, review, setTenderReview])

  // Overflow menu: Escape closes and restores focus to the trigger; a click
  // outside closes. Escape lives on the document so it also closes the menu from
  // the trigger itself; the menu's own Arrow/Home/End/Tab handling is bound to
  // the menu element below, where those keys belong.
  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        menuTriggerRef.current?.focus()
      }
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || menuTriggerRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [menuOpen])

  const handleReReadSource = useCallback(async () => {
    if (!doc || !tender || !review) return null
    const extraction = await extractAllPages(doc)
    setTenderReview(
      tender.id,
      refreshTenderReview(review, {
        meta: {
          title: tender.title,
          referenceNumber: tender.referenceNumber,
          issuingBody: tender.issuingBody,
          closingDate: tender.closingDate,
          submissionMethod: tender.submissionMethod,
          submissionAddress: tender.submissionAddress,
        },
        extraction,
        requirements: tender.requirements,
        estimatedValue: tender.estimatedValue ?? null,
      }),
    )
    return extraction
  }, [doc, tender, review, setTenderReview])

  // Load the tender's PDF into pdfjs for the viewer.
  // If tender.fileUrl is a stored path on disk, read via IPC readDocument.
  // If tender.fileUrl is an ephemeral blob or web url, fetch it directly.
  // A Word .docx is skipped entirely: `WordSourcePane` shows the extracted
  // clauses, and no page highlight exists to jump to.
  useEffect(() => {
    if (!tender) return
    if (wordDocument) {
      setDoc(null)
      setDocError(null)
      return
    }
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
      // A stored-path read failure is terminal: the fallback `fetch` below
      // cannot resolve a filesystem path, and letting it run would overwrite
      // the specific diagnostic with a generic one.
      let storedReadFailed = false
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
          } else if (res && !res.ok) {
            // A user-triggered read failure must be visible, not console-only.
            storedReadFailed = true
            if (!cancelled) {
              setDocError(
                `Could not read the stored tender PDF: ${res.error || 'the document store refused the request.'}`,
              )
            }
          }
        } catch (readErr) {
          storedReadFailed = true
          if (!cancelled) {
            setDocError(
              `Could not read the stored tender PDF: ${
                readErr instanceof Error ? readErr.message : String(readErr)
              }`,
            )
          }
        }
      }
      if (!buf && !storedReadFailed) {
        const res = await fetch(tender.fileUrl)
        buf = await res.arrayBuffer()
      }
      if (!buf) return
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
  }, [tender?.id, tender?.fileUrl, pdfReloadToken, wordDocument])

  // Everything the overflow menu needs to render and to drive its roving
  // tabindex — including the `useEffect` below — is declared HERE, above the
  // `!tender` early return. A hook behind that return runs on a render with an
  // active tender and is skipped by the very next render without one, which React
  // answers with "Rendered fewer hooks than expected" and a torn-down tree: the
  // whole view went blank the moment the active tender disappeared (creating an
  // own workspace from inside a tender workspace leaves the view on `'workspace'`
  // with nothing selected). Every branch of this component must therefore reach
  // the same hooks in the same order.
  // Contract milestones and Books billing are only exposed for a won tender.
  const canBill = tender ? milestonesAllowed(tender.status) : false

  const closeMenuThen = (action: () => void) => () => {
    setMenuOpen(false)
    action()
  }

  // The overflow menu's items, in render order. Declared as data rather than as
  // inline JSX so the menu can reason about its own items: which of them are
  // enabled decides where Arrow/Home/End may land, and which one carries the
  // roving tabindex. The visual result is byte-for-byte the same menu.
  const menuItems: Array<{
    testId: string
    icon: React.ReactNode
    label: string
    onClick?: () => void
    disabled?: boolean
    title?: string
  }> = [
    {
      testId: 'overflow-action-rerun-gap',
      icon: <RefreshCw size={13} aria-hidden="true" />,
      label: 'Re-run gap analysis',
      onClick: closeMenuThen(rerunGap),
    },
    ...(compact
      ? [
          {
            testId: 'overflow-action-sheets',
            icon: <Table size={13} aria-hidden="true" />,
            label: 'Export matrix to Sheets',
            onClick: closeMenuThen(() => void runExportMatrix()),
          },
          {
            testId: 'overflow-action-draft-docs',
            icon: <FileText size={13} aria-hidden="true" />,
            label: 'Draft proposal in Docs',
            onClick: closeMenuThen(() => void runDraftProposal()),
          },
          sampleWritesBlocked
            ? {
                testId: 'overflow-action-crm',
                icon: <Building2 size={13} aria-hidden="true" />,
                label: 'CRM sync',
                disabled: true,
                title: SAMPLE_WRITE_BLOCKED_REASON,
              }
            : tender?.linkedCrmDealId
              ? {
                  testId: 'overflow-action-crm',
                  icon: <Building2 size={13} aria-hidden="true" />,
                  label: 'Open CRM deal',
                  onClick: closeMenuThen(
                    () => void openCrmDeal(tender.linkedCrmDealId || `deal-tender-${tender.id}`),
                  ),
                }
              : {
                  testId: 'overflow-action-crm',
                  icon: <Building2 size={13} aria-hidden="true" />,
                  label: 'Sync to CRM',
                  disabled: crmBusy,
                  onClick: closeMenuThen(() => void syncCrm()),
                },
          ...(canBill
            ? [
                {
                  testId: 'overflow-action-milestones',
                  icon: <Award size={13} aria-hidden="true" />,
                  label: 'Contract milestones',
                  onClick: closeMenuThen(() => setMilestonesOpen(true)),
                },
              ]
            : []),
        ]
      : []),
  ]
  // A disabled action is never the active one, and the active index is resolved
  // from what actually rendered, so a menu whose items changed under it (CRM
  // going busy, billing becoming possible) cannot leave the roving tabindex on a
  // control the user cannot use.
  const enabledMenuIndexes = menuItems
    .map((item, index) => (item.disabled === true ? -1 : index))
    .filter((index) => index >= 0)
  const activeMenuIndex = enabledMenuIndexes.includes(menuActiveIndex)
    ? menuActiveIndex
    : (enabledMenuIndexes[0] ?? 0)

  /**
   * The keyboard contract `role="menu"` promises, implemented over the enabled
   * items: Down/Up move (wrapping), Home/End jump to the ends, Tab closes the
   * menu and lets focus leave it. Enter and Space are the buttons' own click, so
   * they need no handler here.
   */
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      setMenuOpen(false)
      return
    }
    const count = enabledMenuIndexes.length
    if (count === 0) return
    const current = enabledMenuIndexes.indexOf(activeMenuIndex)
    const at = (position: number): void => {
      event.preventDefault()
      setMenuActiveIndex(enabledMenuIndexes[((position % count) + count) % count] ?? 0)
    }
    if (event.key === 'ArrowDown') at(current + 1)
    else if (event.key === 'ArrowUp') at(current - 1)
    else if (event.key === 'Home') at(0)
    else if (event.key === 'End') at(count - 1)
  }

  // Roving tabindex, the other half of the `role="menu"` promise: opening moves
  // focus to the active item, and every move focuses the item it names. Only that
  // item is tabbable, so Tab leaves the menu (and closes it) rather than walking
  // the list. Declared here, above the early return, beside the items it indexes.
  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[activeMenuIndex]?.focus()
  }, [menuOpen, activeMenuIndex])

  if (!tender) {
    return (
      <section
        aria-label="Tender workspace"
        className="flex flex-1 items-center justify-center text-sm text-[var(--text-tertiary)]"
      >
        No tender selected.
      </section>
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
    setPdfSaveError(null)
    let url = ''
    if (typeof window !== 'undefined' && window.tendersApi?.saveDocument) {
      try {
        const buffer = await file.arrayBuffer()
        const saveRes = await window.tendersApi.saveDocument({
          fileName: file.name,
          buffer,
          category: 'rfp',
        })
        if (saveRes?.ok && saveRes.storedPath) {
          url = saveRes.storedPath
        } else {
          // Visible, not console-only: the viewer still opens the file, but it
          // is a session blob that dies on reload.
          setPdfSaveError(
            `The PDF could not be saved to the workspace: ${
              saveRes?.error || 'the document store rejected the file.'
            } It is open for this session only and must be re-attached before you rely on it after a restart.`,
          )
        }
      } catch (err) {
        setPdfSaveError(
          `The PDF could not be saved to the workspace: ${
            err instanceof Error ? err.message : String(err)
          }. It is open for this session only and must be re-attached before you rely on it after a restart.`,
        )
      }
    }
    if (!url) {
      url = URL.createObjectURL(file)
    }
    updateTender(tender.id, { fileUrl: url, fileName: file.name })
  }

  return (
    <section
      aria-label="Tender workspace"
      data-workspace-root
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {/* tender header bar */}
      <div
        data-testid="workspace-context-header"
        className="workspace-context-header workspace-toolbar flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2.5"
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setView('list')
            setPage('tenders')
          }}
        >
          <ArrowLeft size={14} /> Tenders
        </Button>
        {/* The title keeps a readable floor (`TITLE_MIN_WIDTH`): without it the
            toolbar's buttons squeeze the title to one character and the
            countdown badge spills under the save chip. The toolbar still wraps,
            so the action buttons move onto more rows instead of clipping. */}
        <div className="min-w-0 flex-1" style={{ minWidth: TITLE_MIN_WIDTH }}>
          <h1 className="truncate text-sm font-bold text-[var(--text)]" title={tender.title}>
            {tender.title}
          </h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-tertiary)]">
            {dl.date && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${urgencyClasses(dl.urgency)}`}
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
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <SaveStatus
            status={saveStatus}
            message={saveError}
            warning={saveSizeWarning}
            onRetry={retrySave}
            onReload={reloadCommittedFromMain}
          />
          {/* Primary hierarchy: 1) blockers, 2) readiness/submission, 3) vault. */}
          <Button
            size="sm"
            variant={reviewSummary && !reviewSummary.complete ? 'primary' : 'default'}
            onClick={() => setReviewOpen((v) => !v)}
            title="Review and correct the values lifted from this document"
          >
            <BadgeCheck size={14} /> Review extraction
            {reviewSummary && !reviewSummary.complete && (
              <Badge tone="amber" className="ml-1 px-1.5 py-0 text-[10px] font-bold">
                {reviewSummary.pendingFields +
                  reviewSummary.requirementAttention.length +
                  reviewSummary.pendingPages.length}
              </Badge>
            )}
          </Button>
          <Button
            size="sm"
            variant={readiness?.ready ? 'primary' : 'default'}
            onClick={() => setReadinessOpen((v) => !v)}
            title="Open the pre-submission readiness checklist"
          >
            <ClipboardCheck size={14} /> Bid readiness
            {readiness && readiness.blockingFailedCount > 0 && (
              <Badge tone="red" className="ml-1 px-1.5 py-0 text-[10px] font-bold">
                {readiness.blockingFailedCount}
              </Badge>
            )}
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={() => setVaultOpen((v) => !v)}
            title="Open the company evidence vault"
          >
            <ShieldAlert size={14} /> Company vault
          </Button>

          {/* Secondary actions stay inline in wide mode (space allows) and move
              into the overflow menu in compact mode. */}
          {!compact && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void runExportMatrix()}
                title="Export compliance matrix to Zanostack Sheets"
              >
                <Table size={13} /> Sheets
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void runDraftProposal()}
                title="Draft tender proposal in Zanostack Docs"
              >
                <FileText size={13} /> Draft Docs
              </Button>
              {sampleWritesBlocked ? (
                <Button size="sm" variant="ghost" disabled title={SAMPLE_WRITE_BLOCKED_REASON}>
                  <Building2 size={13} /> CRM
                </Button>
              ) : tender.linkedCrmDealId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void openCrmDeal(tender.linkedCrmDealId || `deal-tender-${tender.id}`)
                  }
                  title="Open linked deal in Zanostack CRM"
                >
                  <Building2 size={13} /> CRM Deal
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={crmBusy}
                  onClick={() => void syncCrm()}
                  title="Sync this tender opportunity with Zanostack CRM"
                >
                  {crmBusy ? <Spinner className="size-3" /> : <Building2 size={13} />} CRM
                </Button>
              )}
              {canBill && (
                <Button
                  size="sm"
                  variant={milestonesOpen ? 'primary' : 'ghost'}
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
              )}
            </>
          )}

          {/* Labelled overflow menu: tender metadata + low-frequency actions. */}
          <div className="relative">
            <button
              ref={menuTriggerRef}
              type="button"
              data-testid="workspace-overflow-trigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls="workspace-overflow-menu"
              onClick={() => {
                // Opening lands on the first action the user can actually use,
                // which is where the roving tabindex then lives.
                if (!menuOpen) setMenuActiveIndex(enabledMenuIndexes[0] ?? 0)
                setMenuOpen(!menuOpen)
              }}
              title="More actions and tender details"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            >
              <MoreHorizontal size={15} aria-hidden="true" />
              <span>More actions</span>
              <ChevronDown
                size={12}
                aria-hidden="true"
                className={menuOpen ? 'rotate-180 transition-transform' : 'transition-transform'}
              />
            </button>

            {menuOpen && (
              <div
                ref={menuRef}
                id="workspace-overflow-menu"
                data-testid="workspace-overflow-menu"
                className="workspace-menu absolute right-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-menu)]"
              >
                <div className="border-b border-[var(--border-subtle)] px-3 py-2.5">
                  <p className="text-[10px] font-semibold tracking-wide text-[var(--text-tertiary)] uppercase">
                    Tender details
                  </p>
                  <dl className="mt-1.5 space-y-1 text-[11px]">
                    <MetaRow label="Reference">{tender.referenceNumber || 'Not stated'}</MetaRow>
                    <MetaRow label="Issuing body">{tender.issuingBody || 'Not stated'}</MetaRow>
                    <MetaRow label="Closing">{dl.formatted || 'Not stated'}</MetaRow>
                    <MetaRow label="Submit by">{dl.submitByLabel ?? 'Not stated'}</MetaRow>
                    <MetaRow label="Submission">
                      {tender.submissionMethod
                        ? `${SUBMISSION_METHOD_LABEL[tender.submissionMethod]}${tender.submissionAddress ? ` · ${tender.submissionAddress}` : ''}`
                        : 'Not stated'}
                    </MetaRow>
                    {review?.contactEmail &&
                      review.fields?.contactEmail?.state !== 'unconfirmed' && (
                        <MetaRow label="Contact">{review.contactEmail}</MetaRow>
                      )}
                    <MetaRow label="Document">
                      {wordDocument ? (
                        <>
                          {wordDocumentPaginationNote(tender)}
                          {tender.ocrPages > 0
                            ? ` ${tender.ocrPages} page${
                                tender.ocrPages === 1 ? '' : 's'
                              } hold no text.`
                            : ''}
                        </>
                      ) : (
                        <>
                          {tender.numPages} pages
                          {tender.ocrPages > 0 ? ` · ${tender.ocrPages} scanned` : ''}
                        </>
                      )}
                    </MetaRow>
                  </dl>
                </div>

                <div
                  role="menu"
                  aria-label="More actions"
                  onKeyDown={onMenuKeyDown}
                  className="py-1"
                >
                  {menuItems.map((item, index) => (
                    <MenuItem
                      key={item.testId}
                      testId={item.testId}
                      icon={item.icon}
                      tabIndex={index === activeMenuIndex ? 0 : -1}
                      {...(item.onClick ? { onClick: item.onClick } : {})}
                      {...(item.disabled === true ? { disabled: true } : {})}
                      {...(item.title ? { title: item.title } : {})}
                    >
                      {item.label}
                    </MenuItem>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* The optional AI pass reports here, because this is where the user is:
          importing a tender activates it and switches to this view, so feedback
          rendered only by the list would be unmounted before the run started. The
          panel scopes itself to the tender on screen and renders nothing when no
          run is in flight or reported — with AI off, nothing appears at all. */}
      <AiPassPanel tenderId={tender.id} className="mx-4 my-2 shrink-0" />

      {/* Re-attached PDF could not be persisted — visible, not console-only. */}
      {pdfSaveError && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-1 border-b border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-2 text-[11px]"
        >
          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--warn)]">
            <AlertTriangle size={12} aria-hidden="true" /> PDF not saved to the workspace
          </span>
          <span className="min-w-0 flex-1 leading-relaxed text-[var(--text-secondary)]">
            {pdfSaveError}
          </span>
          <button
            type="button"
            onClick={() => setPdfSaveError(null)}
            className="ml-auto shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* CRM sync failure: surfaced with a retry instead of being swallowed */}
      {crmError && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-2 text-[11px]"
        >
          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--danger-text)]">
            <AlertTriangle size={12} aria-hidden="true" /> CRM sync failed
          </span>
          <span className="text-[var(--text-secondary)]">{crmError}</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void syncCrm()}
              disabled={crmBusy}
              className="cursor-pointer rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => setCrmError(null)}
              className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Cross-app failure: surfaced with a retry instead of an unhandled
          rejection or a silently discarded `{ok:false}` / `false`. */}
      {toolError && (
        <div
          role="alert"
          data-testid="workspace-tool-error"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-2 text-[11px]"
        >
          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--danger-text)]">
            <AlertTriangle size={12} aria-hidden="true" /> {TOOL_ERROR_TITLE[toolError.action]}
          </span>
          <span className="text-[var(--text-secondary)]">{toolError.message}</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={retryToolAction}
              className="cursor-pointer rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => setToolError(null)}
              className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* lifecycle: status, proof of submission, outcome and append-only history */}
      <TenderLifecyclePanel onOpenMilestones={() => setMilestonesOpen(true)} />

      {/* extraction-review gate: always visible, never a hidden modal */}
      {reviewSummary && (
        <div
          className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 ${
            reviewSummary.complete
              ? 'border-[var(--success-border)] bg-[var(--success-bg)]'
              : 'border-[var(--warn-border)] bg-[var(--warn-bg)]'
          }`}
        >
          {reviewSummary.complete ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
                <CheckCircle2 size={13} className="text-[var(--success)]" aria-hidden="true" />
                Extraction reviewed
              </span>
              <span className="text-[11px] text-[var(--text-secondary)]">
                Every field was confirmed, corrected or marked not stated, and every page has a text
                layer or was reviewed.
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
                <AlertTriangle size={13} className="text-[var(--warn)]" aria-hidden="true" />
                Extraction review incomplete
              </span>
              <span className="text-[11px] text-[var(--text-secondary)]">
                {reviewSummary.pendingFields} field
                {reviewSummary.pendingFields === 1 ? '' : 's'} to confirm
                {reviewSummary.requirementAttention.length > 0
                  ? `, ${reviewSummary.requirementAttention.length} requirement${
                      reviewSummary.requirementAttention.length === 1 ? '' : 's'
                    } to verify`
                  : ''}
                {reviewSummary.pendingPages.length > 0
                  ? `, ${reviewSummary.pendingPages.length} page${
                      reviewSummary.pendingPages.length === 1 ? '' : 's'
                    } with no readable text to review`
                  : ''}
                {reviewSummary.pagesUnclassified
                  ? `, ${tender.ocrPages} page${
                      tender.ocrPages === 1 ? '' : 's'
                    } with no recorded text layer`
                  : ''}
                {reviewSummary.conflictingFields.length > 0
                  ? ` — ${reviewSummary.conflictingFields.length} with competing values`
                  : ''}
                . Check each value against its source page before the bid is treated as ready.
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={() => setReviewOpen((v) => !v)}
              title="Open the extraction review step"
            >
              {reviewOpen ? 'Hide review' : 'Review now'}
            </Button>
          </div>
        </div>
      )}

      {/* Compact mode: one pane at a time, with a labelled segmented switch. */}
      {compact && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <div
            data-testid="workspace-pane-switch"
            role="group"
            aria-label="Workspace view"
            className="workspace-segmented"
          >
            <button
              type="button"
              data-testid="pane-switch-requirements"
              aria-pressed={activePane === 'requirements'}
              onClick={() => showCompactPane('requirements')}
              className="cursor-pointer rounded-[var(--radius-6)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            >
              Requirements
            </button>
            <button
              type="button"
              data-testid="pane-switch-pdf"
              aria-pressed={activePane === 'pdf'}
              onClick={() => showCompactPane('pdf')}
              className="cursor-pointer rounded-[var(--radius-6)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
            >
              {wordDocument ? 'Source' : 'PDF'}
            </button>
          </div>
          <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
            {wordDocument ? 'Word .docx' : `p.${currentPage} · ${Math.round(zoom * 100)}%`}
          </span>
        </div>
      )}

      {/* split panes */}
      <div ref={splitRef} data-testid="workspace-split" className="flex min-h-0 min-w-0 flex-1">
        <aside
          data-testid="workspace-matrix-pane"
          data-pane="requirements"
          data-active={!compact || activePane === 'requirements'}
          className={clsx(
            'workspace-pane flex min-h-0 min-w-0 flex-col',
            compact
              ? activePane === 'requirements'
                ? 'flex-1'
                : // Kept mounted so list state/scroll survive the pane switch;
                  // responsive.css removes it from layout and a11y.
                  ''
              : 'shrink-0 border-r border-[var(--border)]',
          )}
          style={!compact ? { flexBasis: `${effectiveFraction * 100}%`, minWidth: 0 } : undefined}
        >
          {canBill && tender.milestones && tender.milestones.length > 0 && (
            <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-subtle)] p-2.5 px-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-semibold text-[var(--text)] flex items-center gap-1">
                  <Award size={12} className="text-[var(--accent)]" aria-hidden="true" /> Contract
                  Delivery Milestones
                </span>
                <button
                  type="button"
                  onClick={() => setMilestonesOpen(true)}
                  className="inline-flex min-h-6 items-center text-[10px] text-[var(--accent-dark)] hover:text-[var(--text)] font-medium cursor-pointer"
                >
                  View all ({tender.milestones.length})
                </button>
              </div>
              {/* Billing feedback: the shared handler's outcome, always visible
                  and never a success claim unless the post actually succeeded. */}
              {billingFeedback && (
                <div
                  role="alert"
                  className={`mb-2 flex items-start gap-2 rounded-md border px-2 py-1.5 text-[11px] ${
                    billingFeedback.kind === 'success'
                      ? 'border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--text-secondary)]'
                      : 'border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--text-secondary)]'
                  }`}
                >
                  {billingFeedback.kind === 'success' ? (
                    <CheckCircle2
                      size={12}
                      className="mt-0.5 shrink-0 text-[var(--success)]"
                      aria-hidden="true"
                    />
                  ) : (
                    <AlertTriangle
                      size={12}
                      className="mt-0.5 shrink-0 text-[var(--danger)]"
                      aria-hidden="true"
                    />
                  )}
                  <div className="flex-1">
                    <div>{billingFeedback.message}</div>
                    {/* A warning rides on a successful post (the invoice exists;
                        something after it did not). Rendering it keeps the
                        success claim honest instead of hiding the caveat. */}
                    {billingFeedback.warning && (
                      <div className="mt-1 font-medium text-[var(--text-tertiary)]">
                        {billingFeedback.warning}
                      </div>
                    )}
                    {billingFeedback.kind === 'error' &&
                      billingFeedback.retryable &&
                      billingId === null && (
                        <button
                          type="button"
                          onClick={() => {
                            const target = tender.milestones?.find(
                              (x) => x.id === billingFeedback.milestoneId,
                            )
                            if (target) {
                              setBillingFeedback(null)
                              void runMilestoneBilling(tender, target, {
                                onBusy: setBillingId,
                                onFeedback: setBillingFeedback,
                              })
                            }
                          }}
                          className="mt-1 inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--danger-border)] bg-[var(--surface)] px-2 py-0.5 font-semibold text-[var(--danger)] hover:bg-[var(--hover)]"
                        >
                          Retry billing
                        </button>
                      )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setBillingFeedback(null)}
                    className="shrink-0 text-current opacity-70 hover:opacity-100"
                    aria-label="Dismiss billing message"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
              <div className="space-y-1.5">
                {tender.milestones.map((m) => {
                  if (m.status === 'REACHED') {
                    return (
                      <div
                        key={m.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface)] p-2 border border-[var(--border)] shadow-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-[var(--text)] truncate">
                            {m.name || m.title}
                          </div>
                          <div className="text-[10px] text-[var(--text-tertiary)]">
                            {formatRandAmount(Number(m.amount))} · Ready to Bill
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={billingId === m.id || sampleWritesBlocked}
                          title={sampleWritesBlocked ? SAMPLE_WRITE_BLOCKED_REASON : undefined}
                          onClick={() =>
                            void runMilestoneBilling(tender, m, {
                              onBusy: setBillingId,
                              onFeedback: setBillingFeedback,
                            })
                          }
                          className="shrink-0 inline-flex items-center gap-1 rounded bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-dark)] disabled:opacity-50 cursor-pointer"
                        >
                          {billingId === m.id ? <Spinner /> : <Zap size={11} aria-hidden="true" />}{' '}
                          Bill Milestone in Zano Books
                        </button>
                      </div>
                    )
                  }
                  if (m.status === 'BILLED') {
                    return (
                      <div
                        key={m.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-subtle)] p-2 border border-[var(--border)]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-[var(--text-secondary)] truncate">
                            {m.name || m.title}
                          </div>
                          <div className="text-[10px] text-[var(--text-tertiary)]">
                            {formatRandAmount(Number(m.amount))}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void openBooksTab()}
                          className="shrink-0 inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent-dark)] hover:bg-[var(--hover)] cursor-pointer"
                          title="Open invoice in Zano Books"
                        >
                          <FileText size={11} aria-hidden="true" />{' '}
                          {/* Never invent an invoice reference: when Books did
                              not return a number, say what the control does. */}
                          {m.billedInvoiceNumber || 'Open in Books'}
                        </button>
                      </div>
                    )
                  }
                  if (m.status === 'PAID') {
                    const paidMilestone = m as ContractMilestone & { paidAt?: string | null }
                    const paidDateStr = paidMilestone.paidAt
                      ? new Date(paidMilestone.paidAt).toLocaleDateString()
                      : 'Settled'
                    return (
                      <div
                        key={m.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-[var(--success-bg)] p-2 border border-[var(--success-border)] shadow-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-[var(--text)] truncate flex items-center gap-1.5">
                            <span>{m.name || m.title}</span>
                            <span className="inline-flex items-center rounded-full border border-[var(--success-border)] px-1.5 py-0.2 text-[10px] font-bold text-[var(--text-secondary)]">
                              PAID
                            </span>
                          </div>
                          <div className="text-[10px] text-[var(--text-secondary)] font-medium">
                            {formatRandAmount(Number(m.amount))} · Paid {paidDateStr}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void openBooksTab()}
                          className="shrink-0 inline-flex items-center gap-1 rounded border border-[var(--success-border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-dark)] hover:bg-[var(--hover)] cursor-pointer transition-colors"
                          title="Open settled invoice in Zano Books"
                        >
                          <FileText size={11} aria-hidden="true" />{' '}
                          {m.billedInvoiceNumber || 'Open in Books'}
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
            {reviewOpen && review ? (
              <div className="h-full overflow-hidden">
                <ExtractionReview
                  tender={tender}
                  review={review}
                  pdfReady={doc !== null || wordDocument}
                  onBack={() => setReviewOpen(false)}
                  // A Word .docx has no PDF to re-read, and offering the control
                  // disabled would be a dead end: the button is simply absent.
                  onReReadSource={wordDocument ? undefined : handleReReadSource}
                  onOpenRequirement={(requirementId) => focusRequirement(requirementId)}
                />
              </div>
            ) : (
              <RequirementList tender={tender} />
            )}
          </div>
        </aside>

        {/* Resizable split handle — wide mode only. */}
        {!compact && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize compliance matrix and PDF panes"
            aria-valuenow={Math.round(effectiveFraction * 100)}
            aria-valuemin={Math.round(SPLIT_MIN * 100)}
            aria-valuemax={Math.round(SPLIT_MAX * 100)}
            tabIndex={0}
            data-testid="workspace-split-handle"
            data-dragging={dragging ? 'true' : undefined}
            onPointerDown={handleSplitPointerDown}
            onPointerMove={handleSplitPointerMove}
            onPointerUp={handleSplitPointerUp}
            onPointerCancel={handleSplitPointerUp}
            onKeyDown={handleSplitKeyDown}
            className="workspace-split-handle"
          />
        )}

        <section
          data-testid="workspace-pdf-pane"
          data-pane="pdf"
          data-active={!compact || activePane === 'pdf'}
          className="workspace-pane relative min-w-0 flex-1"
        >
          {/* One hidden file input serves every unreadable-PDF state. It lives
              outside the branches because the re-attach affordance must exist
              wherever the PDF cannot be shown — not only when `fileUrl` is
              missing (the stored-PDF read-failure state had no control at all). */}
          <input
            ref={reattachRef}
            type="file"
            accept="application/pdf"
            data-testid="pdf-reattach-input"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleReattach(file)
              e.target.value = ''
            }}
          />
          {wordDocument ? (
            <WordSourcePane tender={tender} />
          ) : !tender.fileUrl ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-[var(--warn-bg)] text-[var(--warn)] ring-1 ring-[var(--warn-border)]">
                <FileUp size={20} />
              </span>
              <div>
                <p className="text-sm font-semibold text-[var(--text)]">Re-attach the tender PDF</p>
                <p className="mt-1 max-w-sm text-xs text-[var(--text-tertiary)]">
                  The original file link expired when the page reloaded. Pick the PDF again to view
                  it here — your compliance matrix is untouched.
                </p>
              </div>
              <Button size="sm" variant="primary" onClick={() => reattachRef.current?.click()}>
                <FileUp size={14} /> Choose PDF
              </Button>
            </div>
          ) : doc ? (
            <PdfViewer
              doc={doc}
              requirements={tender.requirements}
              title={tender.title}
              activationToken={pdfActivation}
            />
          ) : docError ? (
            /* Actionable failure: the same re-attach control as the missing-link
               state, plus a retry of the read itself — never a dead end that
               tells the user to re-attach with no way to do it. */
            <div
              role="alert"
              className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
            >
              <span className="flex size-11 items-center justify-center rounded-full bg-[var(--danger-bg)] text-[var(--danger)] ring-1 ring-[var(--danger-border)]">
                <AlertTriangle size={20} aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold text-[var(--text)]">
                  The tender PDF could not be opened
                </p>
                <p className="mt-1 max-w-sm text-xs leading-relaxed text-[var(--text-secondary)]">
                  {docError}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" variant="primary" onClick={() => reattachRef.current?.click()}>
                  <FileUp size={14} /> Re-attach the PDF
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => setPdfReloadToken((n) => n + 1)}
                  title="Read the stored tender PDF again"
                >
                  <RefreshCw size={14} /> Try again
                </Button>
              </div>
              <p className="max-w-sm text-[11px] text-[var(--text-tertiary)]">
                Re-attaching replaces the link on this tender; your compliance matrix and review
                decisions are untouched.
              </p>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--text-tertiary)]">
              <Spinner /> Opening PDF…
            </div>
          )}
        </section>

        {/* vault drawer */}
        {vaultOpen && <VaultDrawer onClose={() => setVaultOpen(false)} />}

        {/* bid-readiness drawer */}
        {readinessOpen && <ReadinessDrawer onClose={() => setReadinessOpen(false)} />}

        {/* contract milestones drawer — won tenders only */}
        {milestonesOpen && canBill && <MilestonesDrawer onClose={() => setMilestonesOpen(false)} />}
      </div>
    </section>
  )
}

/**
 * The source pane for a Word .docx import.
 *
 * A .docx has no rendered pages, so there is no page to show and no page
 * highlight a clause could be located on. The pane therefore shows what the
 * local extractor actually read — each requirement's own clause text, on the
 * page number the document itself declares — and states how those page numbers
 * were derived (`docxPaginationNote`, via `wordDocumentPaginationNote`).
 *
 * Every clause block carries `data-page`, which is what the review step's
 * "open source" affordance scrolls to: a clause jump lands on the clause text
 * instead of on a page highlight that does not exist. A clause a model
 * suggested is marked as such — it is a quote of a suggestion, not of the file.
 */
function WordSourcePane({ tender }: { tender: TenderRecord }) {
  const activeRequirementId = useTendersStore((s) => s.activeRequirementId)
  const listRef = useRef<HTMLUListElement | null>(null)
  const withClause = tender.requirements.filter(
    (requirement) => requirement.verbatimClause.trim().length > 0,
  )
  const paginationNote = wordDocumentPaginationNote(tender)

  // Locating a requirement in the matrix must land on its clause here: the PDF
  // viewer's own locate has no page to scroll to for a .docx, so without this
  // the jump would highlight a clause the user cannot see.
  useEffect(() => {
    if (!activeRequirementId) return
    const element = listRef.current?.querySelector(`[data-requirement="${activeRequirementId}"]`)
    if (element instanceof HTMLElement) element.scrollIntoView({ block: 'nearest' })
  }, [activeRequirementId])

  return (
    <div data-testid="word-source-pane" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
          <FileText size={13} className="text-[var(--accent)]" aria-hidden="true" />
          Word document — the text this app read
        </p>
        {paginationNote && (
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
            {paginationNote}
          </p>
        )}
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          The .docx is not rendered in this pane. These are the clauses the local extractor lifted
          from its text; open the file itself in Word to read it as it was written.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-4 py-3">
        {withClause.length === 0 ? (
          <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-4 text-center text-xs text-[var(--text-secondary)]">
            No requirement clause was lifted from this document, so there is no source text to show
            here. The document's own text is in the file itself.
          </p>
        ) : (
          <ul ref={listRef} className="space-y-2.5">
            {withClause.map((requirement) => {
              const active = requirement.id === activeRequirementId
              return (
                <li
                  key={requirement.id}
                  data-page={requirement.pageNumber}
                  data-requirement={requirement.id}
                  data-active={active ? 'true' : undefined}
                  className={`rounded-lg border px-3 py-2.5 ${
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] bg-[var(--surface)]'
                  }`}
                >
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-[var(--text)]">
                    <span>{requirement.title}</span>
                    <span className="font-normal text-[var(--text-tertiary)]">
                      p.{requirement.pageNumber}
                    </span>
                    {requirement.suggestedBy === 'ai' && (
                      /* Named, not just tooltipped: a screen reader has no hover,
                         so the marker's meaning has to be its accessible name. */
                      <span
                        role="note"
                        aria-label={AI_SUGGESTION_ACCESSIBLE_NAME}
                        title={AI_SUGGESTION_TITLE}
                      >
                        <Badge tone="violet">{AI_SUGGESTION_LABEL}</Badge>
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)] italic">
                    “{requirement.verbatimClause}”
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/** One labelled row in the overflow menu's metadata section. */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[var(--text-tertiary)]">{label}</dt>
      <dd className="min-w-0 text-right break-words text-[var(--text-secondary)]">{children}</dd>
    </div>
  )
}

/**
 * One action in the overflow menu.
 *
 * `tabIndex` is passed in rather than fixed here: the menu owns the roving
 * tabindex (`role="menu"` promises exactly one tabbable item), so this component
 * must not decide it.
 */
function MenuItem({
  testId,
  icon,
  children,
  onClick,
  disabled,
  title,
  tabIndex = -1,
}: {
  testId: string
  icon: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
  tabIndex?: number
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      tabIndex={tabIndex}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:bg-[var(--hover)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="shrink-0 text-[var(--text-tertiary)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

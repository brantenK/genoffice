// Zanostack Tenders global state (Zustand): multi-company workspace with
// authoritative v2 store synchronization via typed IPC (loadStoreV2, saveStoreV2,
// onStoreChangedV2). Domain records (workspaces, tenders, customers, vault) are
// authoritative on disk in userData/tenders/tenders-data.json and are never
// persisted to localStorage. UI preferences (active page, view, zoom, onboarding)
// are persisted to localStorage under key 'zanostack-tenders-ui'.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AppPage,
  CompanyProfile,
  Customer,
  FieldReview,
  IntakeVerification,
  PageExtraction,
  PageExtractionState,
  RequirementRecord,
  RequirementReview,
  ReviewFieldKey,
  SubmissionMethod,
  TenderOutcomeRecord,
  TenderOutcomeStatus,
  TenderReadinessSnapshot,
  TenderRecord,
  TenderStatus,
  TenderSubmissionEvidence,
  TenderSubmissionRecord,
  TendersData,
  TendersDataV2,
  TendersWorkspaceV2,
  VaultDoc,
} from '../../shared/types'
import { validateTendersDataV2 } from '../../shared/tenders-schema'
import type { TendersCloseFlushResult } from '../../shared/ipc'
import {
  MAX_TENDERS_DOCUMENT_BYTES,
  MAX_TENDERS_STORE_FILE_BYTES,
} from '../../shared/tenders-persistence'
import type { TendersRecoveryCandidate } from '../../shared/tenders-persistence'
import {
  appendLifecycleEvent,
  evaluateTransition,
  makeLifecycleEvent,
  outcomeStatusToTenderStatus,
} from '../../shared/lifecycle'
import { RULE_BY_KEY } from '../../shared/rules'
import { applyGapToRequirement } from './gap'
import { findIssuerTemplate } from './issuer'

export type View = 'list' | 'workspace' // within the Tenders page
export type ShredStage =
  'idle' | 'loading' | 'extracting' | 'shredding' | 'analysing' | 'done' | 'error'

export interface ShredProgress {
  stage: ShredStage
  message: string
  page: number
  total: number
}

export type HydrationStatus = 'loading' | 'ready' | 'error'
export type SaveStatus = 'loading' | 'saving' | 'saved' | 'error' | 'conflict'

/** Backwards-compatible workspace alias. */
export type CompanyWorkspace = TendersWorkspaceV2

/** Letterhead analysis result — a recognized issuing-authority template. */
export interface IssuerTemplate {
  id: string
  /** normalized issuing-body name (uppercase, trimmed) */
  name: string
  /** display name (as lifted from the letterhead) */
  displayName: string
  /** postal / physical address lifted from the letterhead */
  address: string | null
  /** contact person + phone/email if present */
  contact: string | null
  /** e.g. "RFP Reference Number: DWS/RFP-YYYY/NNNN" style description */
  refStyle: string | null
  /** submission logistics commonly used by this issuer */
  submissionMethod: SubmissionMethod | null
  submissionAddress: string | null
  /** how many tenders from this issuer have been shredded */
  seenCount: number
  /** ISO timestamp of last sighting */
  lastSeen: string
}

// ── WP-6 extraction review ──────────────────────────────────────────────────
// Review annotations (field confirmations + provenance + competing candidates)
// and per-page OCR extraction state are part of the AUTHORITATIVE v2 document:
// they live on `TenderRecord.intakeVerification` and persist through
// `saveStoreV2` with the same CAS revision tracking as every other domain
// record. `tenderReviews` is only an in-memory projection of those records for
// the UI; nothing review-related is written to localStorage. Losing the cache
// is safe — it is rebuilt from the committed snapshot after every load/save.
export type {
  FieldReview,
  IntakeVerification,
  PageExtractionState,
  PageExtractionStatus,
  RequirementReview,
  RequirementReviewState,
  ReviewCandidate,
  ReviewFieldKey,
  ReviewFieldState,
} from '../../shared/types'

/** Backwards-compatible alias: the persisted intake-verification slice. */
export type TenderReview = IntakeVerification

export const EMPTY_COMPANY: CompanyProfile = {
  name: '',
  tradingName: '',
  registrationNumber: '',
  vatNumber: '',
  taxPin: '',
  bbbeeLevel: '',
  bbbeeBlackOwnership: '',
  csdSupplierNumber: '',
  founded: '',
  employees: '',
  industry: '',
  description: '',
  address: '',
  phone: '',
  email: '',
  website: '',
  directors: [],
  projects: [],
}

// ── Lifecycle (WP-11) store contracts ────────────────────────────────────────
// Every lifecycle mutation is validated by the pure `shared/lifecycle` state
// machine before it touches the authoritative document, and appends one
// lifecycle history entry (when the status actually changes).

export interface LifecycleActionResult {
  ok: boolean
  error?: string
}

/**
 * Non-lifecycle tender fields a generic caller may patch. `status`,
 * `submission`, `outcome` and `lifecycle` are intentionally excluded so
 * `updateTender` can never bypass `evaluateTransition`/`recordSubmission`/
 * `recordOutcome` or skip the append-only history. Use the lifecycle actions
 * for those.
 */
export type TenderRecordPatch = Partial<
  Omit<TenderRecord, 'id' | 'status' | 'lifecycle' | 'submission' | 'outcome'>
>

export interface RecordSubmissionInput {
  /** RFC3339 instant the bid was submitted. */
  submittedAt: string
  timeZone?: string | null
  method: SubmissionMethod
  destination?: string | null
  confirmationReference?: string | null
  evidence?: { kind: string; reference?: string | null; note?: string | null } | null
  person?: string | null
  notes?: string | null
  /** Current readiness checkpoint (build with `readinessSnapshotFromReport`). */
  readiness?: TenderReadinessSnapshot | null
  /** True only when `readiness` reflects the tender's current revision. */
  readinessIsCurrent?: boolean
  /** Supplying this allows submitting with blockers; it is audited, never "cleared". */
  blockerOverrideReason?: string | null
}

export interface RecordOutcomeInput {
  status: Exclude<TenderOutcomeStatus, 'pending'>
  noticeDate?: string | null
  reason?: string | null
  awardedValue?: number | null
  evidenceReference?: string | null
  at?: string
}

export interface TransitionTenderOptions {
  readiness?: TenderReadinessSnapshot | null
  readinessIsCurrent?: boolean
  blockerOverrideReason?: string | null
  reason?: string | null
  submission?: TenderSubmissionRecord | null
  outcome?: TenderOutcomeRecord | null
  at?: string
}

function findTender(state: TendersState, tenderId: string): TenderRecord | undefined {
  for (const workspace of state.workspaces) {
    const tender = workspace.tenders.find((candidate) => candidate.id === tenderId)
    if (tender) return tender
  }
  return undefined
}

function normalizeSubmissionEvidence(
  evidence: RecordSubmissionInput['evidence'],
): TenderSubmissionEvidence | null {
  if (!evidence) return null
  const kind = evidence.kind?.trim()
  if (!kind) return null
  return {
    kind,
    reference: evidence.reference?.trim() ? evidence.reference.trim() : null,
    note: evidence.note?.trim() ? evidence.note.trim() : null,
  }
}

let focusToken = 0
let companySeq = 0
let templateSeq = 0
let vaultSeq = 0

let committedRevision = 0
let isSyncingFromMain = false
let isMigrating = false
let migrationCommitted = false
let isHydrating = false
let isSaveInFlight = false
let isSavePending = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let storeChangedUnsub: (() => void) | null = null
let closeFlushUnsub: (() => void) | null = null
/**
 * The save attempt currently running (if any). The shell's close guard awaits
 * this instead of starting a second save against the same `expectedRevision`,
 * which the store would reject as a false conflict.
 */
let activeSave: Promise<void> | null = null
/**
 * True while the in-memory document holds an edit the authoritative store has
 * not committed. Set when an edit schedules a save and cleared only by a commit
 * that adopted the authoritative snapshot (or by adopting one from main), so a
 * failed or refused save keeps reporting uncommitted work.
 */
let hasUncommittedEdits = false

/** Legacy v1 localStorage key that used to hold the full domain payload. */
const LEGACY_LOCAL_STORAGE_KEY = 'zanostack-tenders-v1'

/**
 * Superseded key that briefly held review annotations outside the authoritative
 * document. Intake verification now lives on `TenderRecord.intakeVerification`,
 * so this key is purged and never written again.
 */
const LEGACY_REVIEW_STORAGE_KEY = 'zanostack-tenders-review-v1'

/**
 * One-time best-effort purge of legacy localStorage payloads. The v2 renderer
 * keeps only UI preferences in localStorage; stale v1 domain data and the
 * superseded review key must not survive the cutover. Guarded so a non-browser
 * or storage-disabled environment cannot throw during module init.
 */
function purgeLegacyLocalStorage(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY)
      window.localStorage.removeItem(LEGACY_REVIEW_STORAGE_KEY)
    }
  } catch {
    // localStorage unavailable (e.g. disabled/private mode); non-fatal.
  }
}

purgeLegacyLocalStorage()

/**
 * Subscribe to main's pre-close flush request (the shell's dirty-close guard) as
 * soon as the renderer bundle loads, not at first hydration: a window closed
 * while the view is still starting up must be answered rather than timing out
 * into a prompt. Flushing before hydration is harmless — it commits whatever the
 * store currently holds, which is nothing.
 */
function installCloseFlushGuard(): void {
  if (typeof window === 'undefined' || !window.tendersApi?.onCloseFlushRequest) return
  if (closeFlushUnsub) return
  closeFlushUnsub = window.tendersApi.onCloseFlushRequest((requestId: number) => {
    void respondToCloseFlushRequest(requestId)
  })
}

installCloseFlushGuard()

/**
 * Project the authoritative `TenderRecord.intakeVerification` slices into the
 * UI-facing map. This cache is rebuilt from the committed document on every
 * load/save/broadcast — it is never a source of truth and is never persisted.
 */
function reviewsFromWorkspaces(workspaces: TendersWorkspaceV2[]): Record<string, TenderReview> {
  const out: Record<string, TenderReview> = {}
  for (const workspace of workspaces) {
    for (const tender of workspace.tenders) {
      if (tender.intakeVerification) out[tender.id] = tender.intakeVerification
    }
  }
  return out
}

/** Empty authoritative intake-verification record (all fields unconfirmed). */
function emptyIntakeReview(now: string = new Date().toISOString()): TenderReview {
  return {
    fields: {},
    requirements: {},
    pages: [],
    contactEmail: null,
    conflicts: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** Mint a fresh vault doc id (used by the upload flow in DocumentsPage). */
export function newVaultDocId(): string {
  return `vd-${Date.now()}-${vaultSeq++}`
}

// ── Vault keyword index (WP-15) ─────────────────────────────────────────────
// `applyGapToRequirement` scans the whole vault per requirement. Build the
// keyword → document index ONCE per analysis pass and hand the matcher only the
// candidate documents for the requirement's rule. Because the matcher ignores
// any document whose title has no hint-keyword hit, the prefiltered run is
// byte-for-byte equivalent to the full scan (see the equivalence test).
export interface VaultKeywordIndex {
  /** Documents carrying at least one vault-hint keyword for `ruleKey`, vault order. */
  candidatesFor: (ruleKey: string) => VaultDoc[]
}

export function buildVaultKeywordIndex(vault: VaultDoc[]): VaultKeywordIndex {
  const titles = vault.map((doc) => doc.title.toLowerCase())
  const keywords = new Set<string>()
  for (const rule of Object.values(RULE_BY_KEY)) {
    for (const keyword of rule.vaultHints.keywords) keywords.add(keyword.toLowerCase())
  }
  const byKeyword = new Map<string, number[]>()
  for (const keyword of keywords) {
    const indices: number[] = []
    for (let index = 0; index < titles.length; index += 1) {
      if (titles[index].includes(keyword)) indices.push(index)
    }
    byKeyword.set(keyword, indices)
  }
  return {
    candidatesFor: (ruleKey: string) => {
      const rule = RULE_BY_KEY[ruleKey]
      if (!rule) return []
      const seen = new Set<number>()
      for (const keyword of rule.vaultHints.keywords) {
        for (const index of byKeyword.get(keyword.toLowerCase()) ?? []) seen.add(index)
      }
      return [...seen].sort((a, b) => a - b).map((index) => vault[index])
    },
  }
}

/**
 * Gap analysis for a whole tender using a prebuilt vault keyword index. Results
 * are identical to `applyGapToRequirements`; only the vault rescan is removed.
 */
export function applyGapToRequirementsIndexed(
  reqs: RequirementRecord[],
  index: VaultKeywordIndex,
  now?: Date,
): RequirementRecord[] {
  return reqs.map((req) => applyGapToRequirement(req, index.candidatesFor(req.ruleKey), now))
}

/** Derive company-scoped views. Returns safe empty company when no workspaces exist. */
function deriveViews(workspaces: TendersWorkspaceV2[], activeCompanyId: string | null) {
  const ws = workspaces.find((w) => w.id === activeCompanyId) ?? workspaces[0]
  if (!ws) {
    return {
      workspaces,
      activeCompanyId: null,
      company: EMPTY_COMPANY,
      customers: [],
      vault: [],
      tenders: [],
      hasWorkspaces: false,
    }
  }
  return {
    workspaces,
    activeCompanyId: ws.id,
    company: ws.company,
    customers: ws.customers,
    vault: ws.vault,
    tenders: ws.tenders,
    hasWorkspaces: true,
  }
}

export function cancelPendingSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

/** Fraction of a size ceiling at which the save indicator starts warning. */
const SAVE_SIZE_WARNING_RATIO = 0.8

function megabyteLabel(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Renderer-side size pre-check for one save attempt, mirroring the two ceilings
 * main enforces: the compact document (`MAX_TENDERS_DOCUMENT_BYTES`) and the
 * pretty-printed file `tenders-store` writes (`MAX_TENDERS_STORE_FILE_BYTES`).
 *
 * Without it an over-size workspace fails the whole `saveStoreV2` round trip on
 * every autosave with no way for the user to know what to do. This measures bytes
 * only — schema validation stays in `validateTendersDataV2` and still runs after
 * it (it is what reports a field-level problem), so the pre-check is an
 * *addition* to that walk, not a replacement: measured, the two serializations
 * cost ~108 ms for a 5.4 MB document, and the schema walk runs on top.
 */
export interface TendersSaveSizeCheck {
  /** Bytes of the compact JSON document, as main measures it. */
  documentBytes: number
  documentLimitBytes: number
  /** Bytes of the pretty-printed file a commit would write. */
  fileBytes: number
  fileLimitBytes: number
  /** True when `saveStoreV2` would be rejected on size. */
  overLimit: boolean
  /** True when a ceiling is close but not reached. */
  nearLimit: boolean
  /** Actionable message while `overLimit`; null otherwise. */
  error: string | null
  /** Early heads-up while `nearLimit`; null otherwise. */
  warning: string | null
}

export function checkTendersSaveSize(document: TendersDataV2): TendersSaveSizeCheck {
  const encoder = new TextEncoder()
  const documentBytes = encoder.encode(JSON.stringify(document)).length
  // Exactly what the authoritative store writes: the same document, 2-space
  // indented, so indentation-driven growth cannot slip past this check.
  const fileBytes = encoder.encode(JSON.stringify(document, null, 2)).length
  const overDocument = documentBytes > MAX_TENDERS_DOCUMENT_BYTES
  const overFile = fileBytes > MAX_TENDERS_STORE_FILE_BYTES
  const overLimit = overDocument || overFile
  const nearLimit =
    !overLimit &&
    (documentBytes >= MAX_TENDERS_DOCUMENT_BYTES * SAVE_SIZE_WARNING_RATIO ||
      fileBytes >= MAX_TENDERS_STORE_FILE_BYTES * SAVE_SIZE_WARNING_RATIO)
  // The advisory must name the ceiling that is actually about to bind: an
  // indentation-heavy document can sit at 97% of the store-file ceiling while its
  // compact form is only at 60% of the document ceiling, and quoting the document
  // ceiling there would send the user looking at the wrong number.
  const documentShare = documentBytes / MAX_TENDERS_DOCUMENT_BYTES
  const fileShare = fileBytes / MAX_TENDERS_STORE_FILE_BYTES
  const remedy =
    'Nothing was lost — this change is still only on screen. Delete tenders, vault documents or customers you no longer need, then retry.'
  return {
    documentBytes,
    documentLimitBytes: MAX_TENDERS_DOCUMENT_BYTES,
    fileBytes,
    fileLimitBytes: MAX_TENDERS_STORE_FILE_BYTES,
    overLimit,
    nearLimit,
    error: overDocument
      ? `Tenders data is ${megabyteLabel(documentBytes)} and the save limit is ${megabyteLabel(
          MAX_TENDERS_DOCUMENT_BYTES,
        )}. ${remedy}`
      : overFile
        ? `Tenders data would write a ${megabyteLabel(fileBytes)} file, above the ${megabyteLabel(
            MAX_TENDERS_STORE_FILE_BYTES,
          )} store file limit. ${remedy}`
        : null,
    warning: nearLimit
      ? fileShare > documentShare
        ? `Tenders data would write a ${megabyteLabel(fileBytes)} file, approaching the ${megabyteLabel(
            MAX_TENDERS_STORE_FILE_BYTES,
          )} store file limit. Delete anything you no longer need before saving is blocked.`
        : `Tenders data is ${megabyteLabel(documentBytes)} of the ${megabyteLabel(
            MAX_TENDERS_DOCUMENT_BYTES,
          )} save limit. Delete anything you no longer need before saving is blocked.`
      : null,
  }
}

/**
 * `checkTendersSaveSize`, or `null` when the document cannot be measured (for
 * example a cyclic reference). Every save path uses this so an unmeasurable
 * document falls through to schema validation and the authoritative store's own
 * guards instead of failing with a serialization error.
 */
function measureTendersSaveSize(document: TendersDataV2): TendersSaveSizeCheck | null {
  try {
    return checkTendersSaveSize(document)
  } catch {
    return null
  }
}

export function scheduleSaveToMain(): void {
  if (isSyncingFromMain) return
  if (typeof window === 'undefined' || !window.tendersApi?.saveStoreV2) return

  // An edit that reaches here is uncommitted work even when the save itself is
  // deferred (a save in flight) or refused (a conflict): the shell's close guard
  // must never treat such an edit as already durable.
  hasUncommittedEdits = true

  const currentStatus = useTendersStore.getState().saveStatus
  if (currentStatus === 'conflict') {
    // Never blind-write when in conflict
    return
  }

  cancelPendingSave()

  // A save is already in flight, or the initial v1 migration commit owns the
  // revision: defer exactly one follow-up instead of dispatching a concurrent
  // save that would reuse the same `expectedRevision` and be rejected with a
  // false REVISION_CONFLICT. The follow-up runs after the in-flight save or
  // migration resolves and reads the freshly committed revision.
  if (isSaveInFlight || isMigrating) {
    isSavePending = true
    return
  }

  saveTimer = setTimeout(() => {
    saveTimer = null
    void runSaveToMain()
  }, 300)
}

/** Run (or join) one save attempt, tracking it so the close guard can await it. */
function runSaveToMain(): Promise<void> {
  if (activeSave) return activeSave
  const run = performSaveToMain().finally(() => {
    if (activeSave === run) activeSave = null
  })
  activeSave = run
  return run
}

async function performSaveToMain(): Promise<void> {
  if (isSaveInFlight || isMigrating) {
    isSavePending = true
    return
  }
  if (typeof window === 'undefined' || !window.tendersApi?.saveStoreV2) return

  const s = useTendersStore.getState()
  if (s.saveStatus === 'conflict') return

  isSaveInFlight = true

  const expectedRevision = committedRevision
  const document: TendersDataV2 = {
    schemaVersion: 2,
    revision: expectedRevision,
    updatedAt: new Date().toISOString(),
    activeCompanyId: s.activeCompanyId,
    workspaces: s.workspaces,
    issuerTemplates: s.issuerTemplates || [],
  }

  // Size pre-check first: it mirrors main's ceilings and takes precedence over
  // schema issues exactly as main's IPC-boundary payload check does. An over-size
  // workspace must report what to do instead of failing every autosave silently.
  const size = measureTendersSaveSize(document)
  if (size?.overLimit) {
    isSaveInFlight = false
    isSavePending = false
    useTendersStore.setState({
      saveStatus: 'error',
      saveError: size.error,
      saveSizeWarning: null,
    })
    return
  }

  // Belt-and-braces: never hand an invalid document to the authoritative
  // store. A single extracted/edited field the strict schema cannot represent
  // (for example a human closing-date string) must surface as a field-level
  // error instead of failing whole-document validation on every save and
  // bricking the workspace.
  const validation = validateTendersDataV2(document)
  if (!validation.ok) {
    isSaveInFlight = false
    isSavePending = false
    const first = validation.issues[0]
    useTendersStore.setState({
      saveStatus: 'error',
      saveError: first
        ? first.path
          ? `${first.path}: ${first.message}`
          : first.message
        : 'Tenders data failed schema validation.',
    })
    return
  }

  useTendersStore.setState({
    saveStatus: 'saving',
    saveError: null,
    saveSizeWarning: size?.warning ?? null,
  })

  try {
    const result = await window.tendersApi.saveStoreV2({
      expectedRevision,
      document,
    })

    if (result.ok) {
      committedRevision = result.data.revision
      // Adopt the returned snapshot only when nothing newer was queued while
      // this save was in flight; otherwise the newer local edits must survive.
      const hasNewerWork = isSavePending || saveTimer !== null
      if (!hasNewerWork) {
        // The committed snapshot is now the whole document; nothing local is
        // left uncommitted (the shell's close guard relies on this).
        hasUncommittedEdits = false
        isSyncingFromMain = true
        try {
          const activeId = result.data.activeCompanyId || (result.data.workspaces[0]?.id ?? null)
          const views = deriveViews(result.data.workspaces, activeId)
          useTendersStore.setState({
            ...views,
            issuerTemplates: result.data.issuerTemplates || [],
            tenderReviews: reviewsFromWorkspaces(result.data.workspaces),
            saveStatus: 'saved',
            saveError: null,
          })
        } finally {
          isSyncingFromMain = false
        }
      } else {
        useTendersStore.setState({ saveStatus: 'saved', saveError: null })
      }
    } else {
      // A failure is terminal until the user retries; never auto-loop on it.
      isSavePending = false
      if (result.error.code === 'REVISION_CONFLICT') {
        useTendersStore.setState({ saveStatus: 'conflict', saveError: result.error.message })
      } else {
        useTendersStore.setState({ saveStatus: 'error', saveError: result.error.message })
      }
    }
  } catch (err) {
    isSavePending = false
    useTendersStore.setState({
      saveStatus: 'error',
      saveError: err instanceof Error ? err.message : String(err),
    })
  } finally {
    isSaveInFlight = false
    if (isSavePending) {
      isSavePending = false
      scheduleSaveToMain()
    }
  }
}

/**
 * Does the in-memory document hold anything the authoritative store does not?
 * Only an adopting commit (or an adoption from main) clears the edit flag, so a
 * failed or refused save keeps reporting uncommitted work.
 */
function hasUncommittedWork(): boolean {
  return hasUncommittedEdits || isSaveInFlight || isSavePending || saveTimer !== null || isMigrating
}

/**
 * A v1→v2 migration commit owns the revision while it runs, so a save started
 * against it would be a false conflict. Bounded: a migration that never settles
 * must not hang the close guard (main's own timeout is the outer bound).
 */
async function waitForMigrationToSettle(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isMigrating && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * Commit any debounced edit right now and report whether everything is durable.
 * This is the renderer half of the shell's dirty-close guard: the window is about
 * to close, so the 300 ms debounce must not be waited out, and a save already in
 * flight is awaited rather than raced with a second one against the same
 * `expectedRevision`.
 */
export async function flushSaveToMain(): Promise<TendersCloseFlushResult> {
  const wasDirty = hasUncommittedWork()
  cancelPendingSave()
  if (isMigrating) await waitForMigrationToSettle()
  if (activeSave) await activeSave
  // An edit that arrived during the first attempt queues a follow-up; flush it
  // too (bounded — a save that keeps failing reports `ok: false` and prompts).
  for (let attempt = 0; attempt < 3 && hasUncommittedWork(); attempt += 1) {
    cancelPendingSave()
    await runSaveToMain()
    if (activeSave) await activeSave
  }
  return {
    dirty: wasDirty,
    ok: !hasUncommittedWork(),
    error: useTendersStore.getState().saveError,
  }
}

/**
 * Answer main's pre-close flush request (the shell's window close guard). A reply
 * that cannot be delivered leaves main's guard to time out and prompt; nothing
 * here can make the edit durable, and a silent drop is the defect being fixed.
 */
export async function respondToCloseFlushRequest(requestId: number): Promise<void> {
  let result: TendersCloseFlushResult
  try {
    result = await flushSaveToMain()
  } catch (error: unknown) {
    // Conservative: an unexpected failure cannot prove the edit is on disk, so
    // report it as uncommitted work and let main ask the user.
    result = {
      dirty: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    await window.tendersApi?.reportCloseFlush?.(requestId, result)
  } catch {
    // Nothing further the renderer can do; main prompts on its own timeout.
  }
}

export interface TendersState {
  // ── navigation ──────────────────────────────────────────────────────────────
  page: AppPage
  setPage: (p: AppPage) => void

  // ── multi-company ────────────────────────────────────────────────────────────
  workspaces: TendersWorkspaceV2[]
  activeCompanyId: string | null
  setActiveCompany: (id: string) => void
  addCompany: (company: CompanyProfile) => string
  /**
   * Insert an isolated sample workspace. Forces `dataOrigin: 'demo'` so sample
   * records can never be confused with (or written into) user data. Persists
   * through the authoritative v2 store like any other mutation.
   */
  addDemoWorkspace: (workspace: TendersWorkspaceV2) => string
  updateActiveCompany: (company: CompanyProfile) => void
  /** Soft-archive/restore the company (workspace). No destructive delete. */
  archiveCompany: (id: string) => void
  restoreCompany: (id: string) => void

  // ── company-scoped views (active company) ────────────────────────────────────
  company: CompanyProfile
  setCompany: (c: CompanyProfile) => void
  customers: Customer[]
  vault: VaultDoc[]
  tenders: TenderRecord[]
  activeCustomerId: string | null
  setActiveCustomer: (id: string | null) => void
  addCustomer: (c: Customer) => void
  removeCustomer: (id: string) => void
  updateCustomer: (id: string, patch: Partial<Customer>) => void
  /** Soft-archive/restore a customer. No destructive delete (see WP-8 note). */
  archiveCustomer: (id: string) => void
  restoreCustomer: (id: string) => void

  // ── vault (workspace) ────────────────────────────────────────────────────
  addVaultDoc: (d: VaultDoc) => void
  updateVaultDoc: (id: string, patch: Partial<VaultDoc>) => void
  removeVaultDoc: (id: string) => void

  // ── tenders (workspace) ─────────────────────────────────────────────────────
  view: View
  activeTenderId: string | null
  activeRequirementId: string | null
  /** set when a checklist item requests viewer focus; viewer clears after scroll */
  pendingFocus: { requirementId: string; token: number } | null
  zoom: number
  currentPage: number
  shredding: ShredProgress | null

  // ── recognized issuer templates (letterhead analysis) ────────────────────────
  issuerTemplates: IssuerTemplate[]
  upsertIssuerTemplate: (tpl: IssuerTemplate) => IssuerTemplate
  removeIssuerTemplate: (id: string) => void

  // ── onboarding ───────────────────────────────────────────────────────────────
  onboardingDone: boolean
  setOnboardingDone: () => void
  restartOnboarding: () => void
  tourActive: boolean
  startTour: () => void
  endTour: () => void

  // actions
  setView: (v: View) => void
  setActiveTender: (id: string | null) => void
  setActiveRequirement: (id: string | null) => void
  focusRequirement: (id: string) => void
  clearFocus: () => void
  setZoom: (z: number) => void
  setCurrentPage: (p: number) => void
  addTender: (t: TenderRecord) => void
  removeTender: (id: string) => void
  updateTender: (id: string, patch: TenderRecordPatch) => void
  updateRequirement: (tenderId: string, reqId: string, patch: Partial<RequirementRecord>) => void
  setSignatureCheck: (tenderId: string, ruleKey: string, checked: boolean) => void
  setShredding: (p: ShredProgress | null) => void
  rerunGap: () => void

  // ── lifecycle (WP-11) — validated by shared/lifecycle ───────────────────────
  /** Record proof of submission and move to SUBMITTED / SUBMITTED_EVIDENCED. */
  recordSubmission: (tenderId: string, input: RecordSubmissionInput) => LifecycleActionResult
  /** Record an outcome (won/lost/withdrawn/cancelled) and move the status. */
  recordOutcome: (tenderId: string, input: RecordOutcomeInput) => LifecycleActionResult
  /** Guarded status transition for non-submission moves (assemble/pack/archive). */
  transitionTenderStatus: (
    tenderId: string,
    to: TenderStatus,
    options?: TransitionTenderOptions,
  ) => LifecycleActionResult

  // ── extraction review (WP-6) ─────────────────────────────────────────────
  tenderReviews: Record<string, TenderReview>
  /** Replace the whole review annotation for a tender. */
  setTenderReview: (tenderId: string, review: TenderReview) => void
  /** Patch one reviewed metadata field (confirm / correct / not stated). */
  updateFieldReview: (tenderId: string, field: ReviewFieldKey, patch: Partial<FieldReview>) => void
  /** Patch the review-scoped contact e-mail. */
  setReviewContactEmail: (tenderId: string, contactEmail: string | null) => void
  /** Patch one requirement's review state. */
  updateRequirementReview: (
    tenderId: string,
    requirementId: string,
    patch: Partial<RequirementReview>,
  ) => void
  /** Upsert the per-page OCR extraction state for one page. */
  setPageExtractionState: (
    tenderId: string,
    pageNumber: number,
    patch: Partial<PageExtractionState>,
  ) => void
  /** Replace the whole per-page extraction state list for a tender. */
  setPageExtractionStates: (tenderId: string, pages: PageExtractionState[]) => void
  /** Mark a page as manually reviewed (unblocks the OCR readiness gate). */
  markPageReviewed: (tenderId: string, pageNumber: number) => void
  /** Append a requirement the parser missed (repair without re-importing). */
  addRequirement: (tenderId: string, requirement: RequirementRecord) => void
  /** Remove a requirement the parser invented. */
  removeRequirement: (tenderId: string, requirementId: string) => void

  // ── authoritative v2 persistence state & actions ───────────────────────────
  hydrationStatus: HydrationStatus
  hydrationError: string | null
  saveStatus: SaveStatus
  saveError: string | null
  /**
   * Advisory heads-up set on each save attempt while the document is approaching
   * a save ceiling (`checkTendersSaveSize`). Never an error and never blocks a
   * save — it exists so the workspace is visibly filling up before saving is
   * blocked. `null` while there is headroom or while a size error is showing.
   */
  saveSizeWarning: string | null
  hasWorkspaces: boolean

  // ── explicit recovery (Phase 5 WP-2) ───────────────────────────────────────
  /** True when hydration failed with RECOVERY_REQUIRED (never substitute). */
  recoveryRequired: boolean
  recoveryCandidates: TendersRecoveryCandidate[]
  recoveryError: string | null
  recoveryBusy: boolean

  hydrateFromMain: () => Promise<void>
  reloadCommittedFromMain: () => Promise<void>
  retrySave: () => void
  /** Re-list validated recovery candidates without touching the primary. */
  refreshRecoveryCandidates: () => Promise<void>
  /** Explicitly restore one candidate; on success adopt the returned document. */
  restoreRecoveryCandidate: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** Dismiss the recovery screen after the user has dealt with it. */
  clearRecovery: () => void

  // ── legacy main-renderer compatibility forwarders ───────────────────────────
  loadFromMain: () => Promise<void>
  syncFromMain: (data: TendersData) => void
  saveToMain: () => void
}

export const useTendersStore = create<TendersState>()(
  persist(
    (set, get: () => TendersState): TendersState => {
      const patchActive = (
        patch: (ws: TendersWorkspaceV2) => Partial<TendersWorkspaceV2>,
      ): void => {
        const s = get()
        if (!s.activeCompanyId) return
        const workspaces = s.workspaces.map((ws) =>
          ws.id === s.activeCompanyId ? { ...ws, ...patch(ws) } : ws,
        )
        const ws = workspaces.find((w) => w.id === s.activeCompanyId) ?? workspaces[0]
        if (!ws) return
        set({
          workspaces,
          company: ws.company,
          customers: ws.customers,
          vault: ws.vault,
          tenders: ws.tenders,
          tenderReviews: reviewsFromWorkspaces(workspaces),
          hasWorkspaces: true,
        })
      }

      /** Read-write the authoritative intake-verification slice for a tender. */
      const writeIntakeReview = (tenderId: string, next: TenderReview): void => {
        const s = get()
        let found = false
        const workspaces = s.workspaces.map((ws) => {
          const index = ws.tenders.findIndex((t) => t.id === tenderId)
          if (index < 0) return ws
          found = true
          const tenders = ws.tenders.slice()
          tenders[index] = { ...tenders[index], intakeVerification: next }
          return { ...ws, tenders }
        })
        if (found) {
          const ws = workspaces.find((w) => w.id === s.activeCompanyId) ?? workspaces[0]
          set({
            workspaces,
            ...(ws
              ? {
                  company: ws.company,
                  customers: ws.customers,
                  vault: ws.vault,
                  tenders: ws.tenders,
                }
              : {}),
            tenderReviews: reviewsFromWorkspaces(workspaces),
          })
        } else {
          // A review for a tender that is not in any workspace cannot be
          // authoritative; keep it only in the transient UI cache.
          set({ tenderReviews: { ...s.tenderReviews, [tenderId]: next } })
        }
      }

      /** Patch one tender in whichever workspace owns it; refreshes active views. */
      const patchTender = (
        tenderId: string,
        updater: (tender: TenderRecord) => TenderRecord,
      ): boolean => {
        const s = get()
        let found = false
        const workspaces = s.workspaces.map((ws) => {
          const index = ws.tenders.findIndex((t) => t.id === tenderId)
          if (index < 0) return ws
          found = true
          const tenders = ws.tenders.slice()
          tenders[index] = updater(tenders[index])
          return { ...ws, tenders }
        })
        if (!found) return false
        const ws = workspaces.find((w) => w.id === s.activeCompanyId) ?? workspaces[0]
        set({
          workspaces,
          ...(ws
            ? {
                company: ws.company,
                customers: ws.customers,
                vault: ws.vault,
                tenders: ws.tenders,
              }
            : {}),
          tenderReviews: reviewsFromWorkspaces(workspaces),
        })
        return true
      }

      /** Soft-archive/restore a company (workspace) profile. */
      const setCompanyArchived = (workspaceId: string, archivedAt: string | null): void => {
        const s = get()
        const workspaces = s.workspaces.map((ws) =>
          ws.id === workspaceId ? { ...ws, company: { ...ws.company, archivedAt } } : ws,
        )
        const active = workspaces.find((w) => w.id === s.activeCompanyId)
        set({ workspaces, ...(active ? { company: active.company } : {}) })
      }

      /**
       * Validate one status change with the pure state machine and, when
       * allowed, write the new status/records plus one appended history entry.
       */
      const applyTransition = (
        current: TenderRecord,
        to: TenderStatus,
        options: TransitionTenderOptions,
      ): LifecycleActionResult => {
        const decision = evaluateTransition(current.status, to, {
          readiness: options.readiness ?? null,
          readinessIsCurrent: options.readinessIsCurrent,
          blockerOverrideReason: options.blockerOverrideReason ?? null,
          submission: options.submission ?? current.submission ?? null,
          outcome: options.outcome ?? current.outcome ?? null,
        })
        if (!decision.allowed) {
          return { ok: false, error: decision.reason ?? 'Transition not allowed.' }
        }
        const at = options.at ?? new Date().toISOString()
        const statusChanged = current.status !== to
        // History is append-only; the schema bounds it at
        // MAX_TENDERS_LIFECYCLE_HISTORY (500). Reaching that requires 500
        // explicit user status changes, so no auto-trim is applied — an
        // over-full history fails validation and is surfaced via `saveStatus`
        // (with Retry) rather than silently dropping an audit entry.
        const updated = patchTender(current.id, (tender) => ({
          ...tender,
          status: to,
          ...(statusChanged
            ? {
                lifecycle: appendLifecycleEvent(
                  tender.lifecycle,
                  makeLifecycleEvent(tender.status, to, options.reason ?? null, at),
                ),
              }
            : {}),
          ...(options.submission !== undefined ? { submission: options.submission } : {}),
          ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
        }))
        if (!updated) return { ok: false, error: 'Tender not found.' }
        return { ok: true }
      }

      return {
        // ── navigation ──────────────────────────────────────────────────────────
        page: 'overview',
        setPage: (p) => set({ page: p }),

        // ── multi-company ────────────────────────────────────────────────────────
        workspaces: [],
        activeCompanyId: null,
        setActiveCompany: (id) => {
          const s = get()
          if (!s.workspaces.some((w) => w.id === id)) return
          const views = deriveViews(s.workspaces, id)
          set({
            ...views,
            activeTenderId: null,
            activeRequirementId: null,
            activeCustomerId: null,
            view: 'list',
            currentPage: 1,
          })
        },
        addCompany: (company) => {
          const id = `co-${Date.now()}-${companySeq++}`
          const ws: TendersWorkspaceV2 = {
            id,
            name: company.name || company.tradingName,
            dataOrigin: 'user',
            company: { ...company },
            customers: [],
            vault: [],
            tenders: [],
          }
          const nextWorkspaces = [...get().workspaces, ws]
          const views = deriveViews(nextWorkspaces, id)
          set({
            ...views,
            tenderReviews: reviewsFromWorkspaces(nextWorkspaces),
          })
          return id
        },
        addDemoWorkspace: (workspace) => {
          // Force the demo origin: this action can never smuggle sample records
          // into a user workspace, and callers cannot accidentally mark sample
          // data as user data. It goes through the same authoritative v2 path
          // as every other mutation (subscriber -> saveStoreV2 + validation).
          const id = workspace.id || `co-demo-${Date.now()}-${companySeq++}`
          const demo: TendersWorkspaceV2 = { ...workspace, id, dataOrigin: 'demo' }
          const nextWorkspaces = [...get().workspaces, demo]
          const views = deriveViews(nextWorkspaces, demo.id)
          set({
            ...views,
            tenderReviews: reviewsFromWorkspaces(nextWorkspaces),
          })
          return demo.id
        },
        updateActiveCompany: (company) => patchActive(() => ({ company })),
        // Soft-archive only: WP-8 destructive company/customer delete is deferred
        // until it can reuse the managed-file/trash semantics (see report).
        archiveCompany: (id) => setCompanyArchived(id, new Date().toISOString()),
        restoreCompany: (id) => setCompanyArchived(id, null),

        // ── company-scoped views (active company) ────────────────────────────────
        company: EMPTY_COMPANY,
        setCompany: (c) => get().updateActiveCompany(c),
        customers: [],
        vault: [],
        tenders: [],
        activeCustomerId: null,
        setActiveCustomer: (id) => set({ activeCustomerId: id }),
        addCustomer: (c) => patchActive((ws) => ({ customers: [...ws.customers, c] })),
        removeCustomer: (id) =>
          patchActive((ws) => ({ customers: ws.customers.filter((c) => c.id !== id) })),
        updateCustomer: (id, patch) =>
          patchActive((ws) => ({
            customers: ws.customers.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c)),
          })),
        archiveCustomer: (id) => {
          const at = new Date().toISOString()
          patchActive((ws) => ({
            customers: ws.customers.map((c) => (c.id === id ? { ...c, archivedAt: at } : c)),
          }))
        },
        restoreCustomer: (id) =>
          patchActive((ws) => ({
            customers: ws.customers.map((c) => (c.id === id ? { ...c, archivedAt: null } : c)),
          })),

        // ── vault (workspace) ──────────────────────────────────────────────
        addVaultDoc: (d) => patchActive((ws) => ({ vault: [...ws.vault, d] })),
        updateVaultDoc: (id, patch) =>
          patchActive((ws) => ({
            vault: ws.vault.map((d) => (d.id === id ? { ...d, ...patch } : d)),
          })),
        removeVaultDoc: (id) =>
          patchActive((ws) => ({ vault: ws.vault.filter((d) => d.id !== id) })),

        // ── tenders (workspace) ─────────────────────────────────────────────────
        view: 'list',
        activeTenderId: null,
        activeRequirementId: null,
        pendingFocus: null,
        zoom: 1,
        currentPage: 1,
        shredding: null,

        setView: (v) => set({ view: v }),
        setActiveTender: (id) =>
          set({
            activeTenderId: id,
            activeRequirementId: null,
            currentPage: 1,
            view: id ? 'workspace' : 'list',
          }),
        setActiveRequirement: (id) => set({ activeRequirementId: id }),
        focusRequirement: (id) =>
          set({
            activeRequirementId: id,
            pendingFocus: { requirementId: id, token: ++focusToken },
          }),
        clearFocus: () => set({ pendingFocus: null }),
        setZoom: (z) => set({ zoom: Math.min(3, Math.max(0.5, z)) }),
        setCurrentPage: (p) => set({ currentPage: p }),

        addTender: (t) => patchActive((ws) => ({ tenders: [...ws.tenders, t] })),

        removeTender: (id) => {
          const removingActive = get().activeTenderId === id
          // patchActive rebuilds `tenderReviews` from the authoritative tenders,
          // so the removed tender's verification slice disappears with it.
          patchActive((ws) => ({ tenders: ws.tenders.filter((t) => t.id !== id) }))
          if (removingActive) {
            set({ activeTenderId: null, view: 'list' })
          }
        },

        updateTender: (id, patch) =>
          patchActive((ws) => ({
            tenders: ws.tenders.map((t) => (t.id === id ? { ...t, ...patch } : t)),
          })),

        updateRequirement: (tenderId, reqId, patch) =>
          patchActive((ws) => ({
            tenders: ws.tenders.map((t) =>
              t.id !== tenderId
                ? t
                : {
                    ...t,
                    requirements: t.requirements.map((r) =>
                      r.id === reqId ? { ...r, ...patch } : r,
                    ),
                  },
            ),
          })),

        setSignatureCheck: (tenderId, ruleKey, checked) =>
          patchActive((ws) => ({
            tenders: ws.tenders.map((t) =>
              t.id !== tenderId
                ? t
                : { ...t, signatureChecks: { ...t.signatureChecks, [ruleKey]: checked } },
            ),
          })),

        setShredding: (p) => set({ shredding: p }),

        // ── issuer templates ─────────────────────────────────────────────────────
        issuerTemplates: [],
        upsertIssuerTemplate: (tpl) => {
          const existing = findIssuerTemplate(get().issuerTemplates, tpl.name, tpl.refStyle)
          if (existing) {
            const merged: IssuerTemplate = {
              ...existing,
              displayName: tpl.displayName || existing.displayName,
              address: tpl.address ?? existing.address,
              contact: tpl.contact ?? existing.contact,
              refStyle: tpl.refStyle ?? existing.refStyle,
              submissionMethod: tpl.submissionMethod ?? existing.submissionMethod,
              submissionAddress: tpl.submissionAddress ?? existing.submissionAddress,
              seenCount: existing.seenCount + 1,
              lastSeen: new Date().toISOString(),
            }
            set({
              issuerTemplates: get().issuerTemplates.map((t) =>
                t.id === existing.id ? merged : t,
              ),
            })
            return merged
          }
          const created: IssuerTemplate = {
            ...tpl,
            name: tpl.name.toUpperCase().trim(),
            id: `iss-${Date.now()}-${templateSeq++}`,
            seenCount: Math.max(1, tpl.seenCount),
            lastSeen: new Date().toISOString(),
          }
          set({ issuerTemplates: [...get().issuerTemplates, created] })
          return created
        },
        removeIssuerTemplate: (id) =>
          set({ issuerTemplates: get().issuerTemplates.filter((t) => t.id !== id) }),

        // ── onboarding ─────────────────────────────────────────────────────────
        onboardingDone: false,
        setOnboardingDone: () => set({ onboardingDone: true }),
        restartOnboarding: () => set({ onboardingDone: false }),
        tourActive: false,
        startTour: () => set({ tourActive: true }),
        endTour: () => set({ tourActive: false }),

        rerunGap: () => {
          const state = get()
          const id = state.activeTenderId
          if (!id) return
          const tender = state.tenders.find((t) => t.id === id)
          if (!tender) return
          // One index per analysis pass; no vault rescan per requirement.
          const index = buildVaultKeywordIndex(state.vault)
          const updated = applyGapToRequirementsIndexed(tender.requirements, index)
          get().updateTender(id, { requirements: updated })
        },

        // ── lifecycle (WP-11) ──────────────────────────────────────────────────
        // All three actions run the pure shared/lifecycle guards before writing
        // and persist through the same authoritative v2 document + CAS path.
        recordSubmission: (tenderId, input) => {
          const current = findTender(get(), tenderId)
          if (!current) return { ok: false, error: 'Tender not found.' }
          const evidence = normalizeSubmissionEvidence(input.evidence)
          const submission: TenderSubmissionRecord = {
            submittedAt: input.submittedAt,
            timeZone: input.timeZone ?? null,
            method: input.method,
            destination: input.destination ?? null,
            confirmationReference: input.confirmationReference ?? null,
            evidence,
            person: input.person ?? null,
            notes: input.notes ?? null,
            readiness: input.readiness ?? null,
            blockerOverrideReason: input.blockerOverrideReason?.trim()
              ? input.blockerOverrideReason.trim()
              : null,
          }
          return applyTransition(current, evidence ? 'SUBMITTED_EVIDENCED' : 'SUBMITTED', {
            readiness: input.readiness ?? null,
            readinessIsCurrent: input.readinessIsCurrent,
            blockerOverrideReason: input.blockerOverrideReason ?? null,
            submission,
            reason: input.notes ?? null,
          })
        },
        recordOutcome: (tenderId, input) => {
          const current = findTender(get(), tenderId)
          if (!current) return { ok: false, error: 'Tender not found.' }
          const at = input.at ?? new Date().toISOString()
          const outcome: TenderOutcomeRecord = {
            status: input.status,
            noticeDate: input.noticeDate ?? null,
            reason: input.reason ?? null,
            awardedValue: input.awardedValue ?? null,
            evidenceReference: input.evidenceReference ?? null,
            recordedAt: at,
          }
          return applyTransition(current, outcomeStatusToTenderStatus(input.status), {
            outcome,
            reason: input.reason ?? null,
            at,
          })
        },
        transitionTenderStatus: (tenderId, to, options = {}) => {
          const current = findTender(get(), tenderId)
          if (!current) return { ok: false, error: 'Tender not found.' }
          return applyTransition(current, to, options)
        },

        // ── extraction review & page extraction state (WP-6 / WP-7) ───────────
        // `tenderReviews` is a projection of `TenderRecord.intakeVerification`;
        // every mutation below writes the authoritative document and persists
        // through `saveStoreV2` with the same CAS revision tracking as any other
        // domain edit. Nothing here touches localStorage.
        tenderReviews: {},

        setTenderReview: (tenderId, review) => {
          writeIntakeReview(tenderId, review)
        },

        updateFieldReview: (tenderId, field, patch) => {
          const current = get().tenderReviews[tenderId]
          if (!current) return
          const previous: FieldReview = current.fields[field] ?? {
            extractedValue: null,
            sourcePage: null,
            sourceClause: null,
            confidence: null,
            candidates: [],
            state: 'unconfirmed',
            reviewedAt: null,
          }
          writeIntakeReview(tenderId, {
            ...current,
            fields: { ...current.fields, [field]: { ...previous, ...patch } },
            updatedAt: new Date().toISOString(),
          })
        },

        setReviewContactEmail: (tenderId, contactEmail) => {
          const current = get().tenderReviews[tenderId]
          if (!current) return
          writeIntakeReview(tenderId, {
            ...current,
            contactEmail,
            updatedAt: new Date().toISOString(),
          })
        },

        updateRequirementReview: (tenderId, requirementId, patch) => {
          const current = get().tenderReviews[tenderId]
          if (!current) return
          const previous: RequirementReview = current.requirements[requirementId] ?? {
            state: 'unreviewed',
            originalTitle: null,
            originalCategory: null,
            correctedAt: null,
          }
          writeIntakeReview(tenderId, {
            ...current,
            requirements: {
              ...current.requirements,
              [requirementId]: { ...previous, ...patch },
            },
            updatedAt: new Date().toISOString(),
          })
        },

        setPageExtractionState: (tenderId, pageNumber, patch) => {
          const current = get().tenderReviews[tenderId] ?? emptyIntakeReview()
          const pages = current.pages ? current.pages.slice() : []
          const index = pages.findIndex((page) => page.pageNumber === pageNumber)
          const previous: PageExtractionState =
            index >= 0
              ? pages[index]
              : { pageNumber, state: 'native', method: null, confidence: null, reviewedAt: null }
          const nextPage: PageExtractionState = { ...previous, ...patch, pageNumber }
          if (index >= 0) pages[index] = nextPage
          else pages.push(nextPage)
          writeIntakeReview(tenderId, { ...current, pages, updatedAt: new Date().toISOString() })
        },

        setPageExtractionStates: (tenderId, pages) => {
          const current = get().tenderReviews[tenderId] ?? emptyIntakeReview()
          writeIntakeReview(tenderId, {
            ...current,
            pages: pages.map((page) => ({ ...page })),
            updatedAt: new Date().toISOString(),
          })
        },

        markPageReviewed: (tenderId, pageNumber) => {
          get().setPageExtractionState(tenderId, pageNumber, {
            state: 'manually-reviewed',
            reviewedAt: new Date().toISOString(),
          })
        },

        addRequirement: (tenderId, requirement) =>
          patchActive((ws) => ({
            tenders: ws.tenders.map((t) =>
              t.id !== tenderId ? t : { ...t, requirements: [...t.requirements, requirement] },
            ),
          })),

        removeRequirement: (tenderId, requirementId) =>
          patchActive((ws) => ({
            tenders: ws.tenders.map((t) => {
              if (t.id !== tenderId) return t
              const requirements = t.requirements.filter((r) => r.id !== requirementId)
              const intake = t.intakeVerification
              if (!intake || !intake.requirements[requirementId]) {
                return { ...t, requirements }
              }
              const remaining = Object.fromEntries(
                Object.entries(intake.requirements).filter(([key]) => key !== requirementId),
              )
              return {
                ...t,
                requirements,
                intakeVerification: {
                  ...intake,
                  requirements: remaining,
                  updatedAt: new Date().toISOString(),
                },
              }
            }),
          })),

        // ── authoritative v2 persistence state & actions ───────────────────────
        hydrationStatus: 'loading',
        hydrationError: null,
        saveStatus: 'saved',
        saveError: null,
        saveSizeWarning: null,
        hasWorkspaces: false,
        // Explicit recovery: never auto-substitute a candidate or empty doc.
        recoveryRequired: false,
        recoveryCandidates: [],
        recoveryError: null,
        recoveryBusy: false,

        hydrateFromMain: async () => {
          if (typeof window === 'undefined' || !window.tendersApi?.loadStoreV2) {
            set({ hydrationStatus: 'ready' })
            return
          }

          // Ensure multi-window broadcast listener is registered
          if (!storeChangedUnsub && window.tendersApi?.onStoreChangedV2) {
            storeChangedUnsub = window.tendersApi.onStoreChangedV2((externalDoc: TendersDataV2) => {
              if (externalDoc.revision <= committedRevision) return
              // F1: never adopt a broadcast while our own save/migration owns
              // the revision. tenders-main broadcasts the commit to every
              // trusted WebContents (including the originator) before the
              // saveStoreV2 reply, so adopting here would clobber edits made
              // during the in-flight save and the queued follow-up would then
              // persist the clobbered state. The originator is not threaded
              // through the store's sender-agnostic onCommitted callback, so
              // we reconcile on the renderer instead: the save reply adopts
              // the committed snapshot (when no newer edit is pending), and a
              // genuine external write that we skipped surfaces as a
              // REVISION_CONFLICT on the next save (never a silent overwrite).
              if (isSaveInFlight || isSavePending || isMigrating) return
              committedRevision = externalDoc.revision
              isSyncingFromMain = true
              try {
                const activeId =
                  externalDoc.activeCompanyId || (externalDoc.workspaces[0]?.id ?? null)
                const views = deriveViews(externalDoc.workspaces, activeId)
                set({
                  ...views,
                  issuerTemplates: externalDoc.issuerTemplates || [],
                  tenderReviews: reviewsFromWorkspaces(externalDoc.workspaces),
                  hasWorkspaces: externalDoc.workspaces.length > 0,
                  saveStatus: 'saved',
                  saveError: null,
                })
              } finally {
                isSyncingFromMain = false
              }
            })
          }

          // Shell dirty-close guard: main asks for a flush before the window
          // closes; the renderer answers on `reportCloseFlush`. Registered at
          // bundle load already — this is the second chance when the bridge was
          // not ready then.
          if (!closeFlushUnsub && window.tendersApi?.onCloseFlushRequest) {
            closeFlushUnsub = window.tendersApi.onCloseFlushRequest((requestId: number) => {
              void respondToCloseFlushRequest(requestId)
            })
          }

          if (isHydrating) return
          isHydrating = true
          set({ hydrationStatus: 'loading', hydrationError: null })

          try {
            const res = await window.tendersApi.loadStoreV2()
            if (!res.ok) {
              // Recovery is an explicit user decision. A RECOVERY_REQUIRED
              // failure never substitutes empty/demo/backup data; the app shows
              // the recovery screen with the validated candidates instead.
              if (res.error.code === 'RECOVERY_REQUIRED') {
                set({
                  hydrationStatus: 'error',
                  hydrationError: res.error.message || 'The Tenders store needs recovery.',
                  saveStatus: 'error',
                  saveError: res.error.message || 'Store load failed.',
                  recoveryRequired: true,
                  recoveryCandidates: res.recoveryCandidates ?? [],
                  recoveryError: null,
                })
                return
              }
              set({
                hydrationStatus: 'error',
                hydrationError: res.error.message || 'Unable to read Tenders data.',
                saveStatus: 'error',
                saveError: res.error.message || 'Store load failed.',
                recoveryRequired: false,
                recoveryCandidates: [],
              })
              return
            }

            // A successful load clears any prior recovery state.
            set({ recoveryRequired: false, recoveryCandidates: [], recoveryError: null })

            if (!isMigrating) {
              committedRevision = res.data.revision
            }

            if (res.status === 'not-found') {
              // The document was replaced by the authoritative (empty) one.
              hasUncommittedEdits = false
              isSyncingFromMain = true
              try {
                set({
                  workspaces: [],
                  activeCompanyId: null,
                  company: EMPTY_COMPANY,
                  customers: [],
                  vault: [],
                  tenders: [],
                  issuerTemplates: [],
                  tenderReviews: {},
                  hasWorkspaces: false,
                  hydrationStatus: 'ready',
                  hydrationError: null,
                  saveStatus: 'saved',
                  saveError: null,
                })
              } finally {
                isSyncingFromMain = false
              }
              return
            }

            if (res.status === 'loaded') {
              // The document was replaced by the authoritative one.
              hasUncommittedEdits = false
              isSyncingFromMain = true
              try {
                const activeId = res.data.activeCompanyId || (res.data.workspaces[0]?.id ?? null)
                const views = deriveViews(res.data.workspaces, activeId)
                set({
                  ...views,
                  issuerTemplates: res.data.issuerTemplates || [],
                  tenderReviews: reviewsFromWorkspaces(res.data.workspaces),
                  hasWorkspaces: res.data.workspaces.length > 0,
                  hydrationStatus: 'ready',
                  hydrationError: null,
                  saveStatus: 'saved',
                  saveError: null,
                })
              } finally {
                isSyncingFromMain = false
              }
              return
            }

            if (res.status === 'migrated') {
              isSyncingFromMain = true
              try {
                const activeId = res.data.activeCompanyId || (res.data.workspaces[0]?.id ?? null)
                const views = deriveViews(res.data.workspaces, activeId)
                set({
                  ...views,
                  issuerTemplates: res.data.issuerTemplates || [],
                  tenderReviews: reviewsFromWorkspaces(res.data.workspaces),
                  hasWorkspaces: res.data.workspaces.length > 0,
                  hydrationStatus: 'ready',
                  hydrationError: null,
                })
              } finally {
                isSyncingFromMain = false
              }

              if (res.needsSave && !isMigrating && !migrationCommitted) {
                isMigrating = true
                try {
                  // The same size pre-check every other save path runs: a v1 store
                  // that migrates into a document over a ceiling would otherwise
                  // fail here with main's raw refusal, which names no field and no
                  // way forward — the non-actionable class the pre-check removes.
                  const migratedSize = measureTendersSaveSize(res.data)
                  if (migratedSize?.overLimit) {
                    // The migrated document is not durable, so the shell's close
                    // guard must still see uncommitted work.
                    hasUncommittedEdits = true
                    set({
                      saveStatus: 'error',
                      saveError: migratedSize.error,
                      saveSizeWarning: null,
                    })
                  } else {
                    const saveRes = await window.tendersApi.saveStoreV2({
                      expectedRevision: 0,
                      document: res.data,
                    })
                    if (saveRes.ok) {
                      committedRevision = saveRes.data.revision
                      // Latch the successful commit exactly once; a later
                      // hydrate must not re-commit the same migration.
                      migrationCommitted = true
                      // The migrated document is now the authoritative one; a save
                      // deferred by the migration latch re-marks the edit below.
                      hasUncommittedEdits = false
                      set({
                        saveStatus: 'saved',
                        saveError: null,
                        saveSizeWarning: migratedSize?.warning ?? null,
                      })
                    } else {
                      set({
                        saveStatus:
                          saveRes.error.code === 'REVISION_CONFLICT' ? 'conflict' : 'error',
                        saveError: saveRes.error.message,
                      })
                    }
                  }
                } catch (saveErr) {
                  set({
                    saveStatus: 'error',
                    saveError: saveErr instanceof Error ? saveErr.message : String(saveErr),
                  })
                } finally {
                  // Always release the latch so a failed migration can be
                  // retried; success is separately latched by migrationCommitted.
                  isMigrating = false
                }
                // A save requested while migration held the latch can now run
                // against the freshly committed revision.
                if (isSavePending) {
                  isSavePending = false
                  scheduleSaveToMain()
                }
              }
              return
            }
          } catch (err) {
            set({
              hydrationStatus: 'error',
              hydrationError: err instanceof Error ? err.message : String(err),
              saveStatus: 'error',
              saveError: err instanceof Error ? err.message : String(err),
            })
          } finally {
            isHydrating = false
          }
        },

        reloadCommittedFromMain: async () => {
          if (typeof window === 'undefined' || !window.tendersApi?.loadStoreV2) return
          // The user explicitly chose the committed document over the local one.
          cancelPendingSave()
          hasUncommittedEdits = false
          set({ saveStatus: 'loading', saveError: null })
          try {
            const res = await window.tendersApi.loadStoreV2()
            if (res.ok) {
              committedRevision = res.data.revision
              isSyncingFromMain = true
              try {
                const activeId = res.data.activeCompanyId || (res.data.workspaces[0]?.id ?? null)
                const views = deriveViews(res.data.workspaces, activeId)
                set({
                  ...views,
                  issuerTemplates: res.data.issuerTemplates || [],
                  tenderReviews: reviewsFromWorkspaces(res.data.workspaces),
                  hasWorkspaces: res.data.workspaces.length > 0,
                  saveStatus: 'saved',
                  saveError: null,
                })
              } finally {
                isSyncingFromMain = false
              }
            } else {
              set({ saveStatus: 'error', saveError: res.error.message })
            }
          } catch (err) {
            set({
              saveStatus: 'error',
              saveError: err instanceof Error ? err.message : String(err),
            })
          }
        },

        retrySave: () => {
          cancelPendingSave()
          scheduleSaveToMain()
        },

        // ── explicit recovery (Phase 5 WP-2) ───────────────────────────────────
        refreshRecoveryCandidates: async () => {
          if (typeof window === 'undefined' || !window.tendersApi?.listRecoveryCandidates) return
          set({ recoveryBusy: true, recoveryError: null })
          try {
            const res = await window.tendersApi.listRecoveryCandidates()
            if (!res?.ok) {
              set({ recoveryError: res?.error || 'Could not list recovery candidates.' })
              return
            }
            set({ recoveryCandidates: res.candidates ?? [] })
          } catch (err) {
            set({ recoveryError: err instanceof Error ? err.message : String(err) })
          } finally {
            set({ recoveryBusy: false })
          }
        },

        restoreRecoveryCandidate: async (id) => {
          if (typeof window === 'undefined' || !window.tendersApi?.restoreRecoveryCandidate) {
            return { ok: false, error: 'Recovery is unavailable in this build.' }
          }
          set({ recoveryBusy: true, recoveryError: null })
          try {
            const res = await window.tendersApi.restoreRecoveryCandidate({ id })
            if (!res?.ok || !res.data) {
              const message = res?.error?.message || 'Could not restore the selected candidate.'
              set({ recoveryError: message })
              return { ok: false, error: message }
            }
            // Adopt the restored document directly, exactly as a load would; the
            // main process has already written it as the new authoritative file.
            committedRevision = res.currentRevision ?? res.data.revision
            hasUncommittedEdits = false
            isSyncingFromMain = true
            try {
              const activeId = res.data.activeCompanyId || (res.data.workspaces[0]?.id ?? null)
              const views = deriveViews(res.data.workspaces, activeId)
              set({
                ...views,
                issuerTemplates: res.data.issuerTemplates || [],
                tenderReviews: reviewsFromWorkspaces(res.data.workspaces),
                hasWorkspaces: res.data.workspaces.length > 0,
                hydrationStatus: 'ready',
                hydrationError: null,
                saveStatus: 'saved',
                saveError: null,
                recoveryRequired: false,
                recoveryCandidates: [],
                recoveryError: null,
              })
            } finally {
              isSyncingFromMain = false
            }
            return { ok: true }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            set({ recoveryError: message })
            return { ok: false, error: message }
          } finally {
            set({ recoveryBusy: false })
          }
        },

        clearRecovery: () =>
          set({ recoveryRequired: false, recoveryCandidates: [], recoveryError: null }),

        // ── legacy main-renderer compatibility forwarders ─────────────────────
        loadFromMain: async () => get().hydrateFromMain(),
        syncFromMain: (data: TendersData) => {
          if (!data || !Array.isArray(data.workspaces)) return
          const activeCompanyId = data.activeCompanyId || (data.workspaces[0]?.id ?? null)
          const workspaces = data.workspaces as TendersWorkspaceV2[]
          const views = deriveViews(workspaces, activeCompanyId)
          set({
            ...views,
            issuerTemplates: data.issuerTemplates || [],
            tenderReviews: reviewsFromWorkspaces(workspaces),
            shredding: null,
            pendingFocus: null,
            tourActive: false,
          })
        },
        saveToMain: () => {
          scheduleSaveToMain()
        },
      }
    },
    {
      name: 'zanostack-tenders-ui',
      version: 1,
      // localStorage holds UI preferences ONLY. Domain data (workspaces,
      // tenders, customers, vault) is authoritative on disk via saveStoreV2.
      partialize: (s) => ({
        page: s.page,
        view: s.view,
        zoom: s.zoom,
        currentPage: s.currentPage,
        onboardingDone: s.onboardingDone,
        activeTenderId: s.activeTenderId,
        activeRequirementId: s.activeRequirementId,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // Clear transient UI flags only. Never synthesize demo/seed domain data.
        state.shredding = null
        state.pendingFocus = null
        state.tourActive = false
      },
    },
  ),
)

useTendersStore.subscribe((state, prevState) => {
  if (isSyncingFromMain) return
  if (
    state.workspaces !== prevState.workspaces ||
    state.activeCompanyId !== prevState.activeCompanyId ||
    state.issuerTemplates !== prevState.issuerTemplates
  ) {
    scheduleSaveToMain()
  }
})

export const useTenderGuard = useTendersStore

/** Convenience selector: active tender object. */
export const selectActiveTender = (s: TendersState): TenderRecord | null =>
  s.tenders.find((t) => t.id === s.activeTenderId) ?? null

/** Convenience selector: active company workspace. */
export const selectActiveCompanyWs = (s: TendersState): CompanyWorkspace | null =>
  s.workspaces.find((w) => w.id === s.activeCompanyId) ?? s.workspaces[0] ?? null

/** Build a TenderRecord from a completed shred. */
export function buildTenderRecord(
  id: string,
  fileName: string,
  fileUrl: string,
  ex: PageExtraction,
  requirements: RequirementRecord[],
  title: string,
  meta: {
    referenceNumber: string | null
    issuingBody: string | null
    closingDate: string | null
    submissionMethod: SubmissionMethod | null
    submissionAddress: string | null
  },
): TenderRecord {
  return {
    id,
    title,
    referenceNumber: meta.referenceNumber,
    issuingBody: meta.issuingBody,
    closingDate: meta.closingDate,
    submissionMethod: meta.submissionMethod,
    submissionAddress: meta.submissionAddress,
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: new Date().toISOString(),
    fileName,
    fileUrl,
    numPages: ex.numPages,
    ocrPages: ex.ocrPages,
    requirements,
  }
}

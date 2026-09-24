// IPC channel definitions and context bridge API for Zanostack Tenders

import type { TendersData, TendersDataV2 } from './types'
import type {
  DocumentReconciliation,
  ManagedFileLink,
  ManagedFileRecord,
  ManagedFileTrashEntry,
  SaveTendersRequest,
  SaveTendersResult,
  TendersLoadResult,
  TendersRecoveryCandidate,
} from './tenders-persistence'

/**
 * Suite UI theme preference as chosen by the user in the shell
 * (`'system'` = follow the OS). Kept for completeness; the shell Settings owns
 * the preference UI.
 */
export type TendersUiTheme = 'light' | 'dark' | 'system'

/**
 * The theme value published over the suite channels. The shell main process
 * resolves `'system'` to `light | dark` using `nativeTheme.shouldUseDarkColors`
 * (Electron 43 does not propagate `themeSource` to `prefers-color-scheme` in any
 * renderer), so renderers apply this explicit value to `<html data-theme>`
 * instead of using the media query. Channels are shared across every app.
 */
export type TendersResolvedTheme = 'light' | 'dark'

export const SUITE_THEME_CHANNELS = {
  /** Resolved theme (`light | dark`). */
  getTheme: 'app:get-theme',
  /** Broadcast of the resolved theme. */
  themeChanged: 'app:theme-changed',
} as const

export const TENDERS_CHANNELS = {
  getStoredData: 'tenders:get-stored-data',
  saveStoredData: 'tenders:save-stored-data',
  dataChanged: 'tenders:data-changed',
  saveDocument: 'tenders:save-document',
  readDocument: 'tenders:read-document',
  openDocument: 'tenders:open-document',
  deleteDocument: 'tenders:delete-document',
  exportMatrixToSheets: 'tenders:export-matrix-to-sheets',
  draftProposalDoc: 'tenders:draft-proposal-doc',
  syncWithCrm: 'tenders:sync-with-crm',
  updateTenderOutcome: 'tenders:update-tender-outcome',
  openInCrm: 'tenders:open-in-crm',
  billMilestoneInBooks: 'tenders:bill-milestone-in-books',
  openBooks: 'tenders:open-books',
  loadStoreV2: 'tenders:load-store-v2',
  saveStoreV2: 'tenders:save-store-v2',
  storeChangedV2: 'tenders:store-changed-v2',
  /**
   * Shell dirty-close guard. Tenders autosaves behind a 300 ms debounce, so the
   * shell cannot know whether an edit is still only in renderer memory: main
   * sends `closeFlushRequest` to the view before the window closes, and the
   * renderer commits whatever is pending and answers on `closeFlushResult`.
   */
  closeFlushRequest: 'tenders:close-flush-request',
  closeFlushResult: 'tenders:close-flush-result',
  // Managed-document lifecycle (Phase 5 WP-9). Main-side handlers plus the
  // preload bridge (`preload/index.ts`) that exposes them to the renderer.
  listDocumentTrash: 'tenders:list-document-trash',
  restoreDocument: 'tenders:restore-document',
  replaceDocument: 'tenders:replace-document',
  reconcileDocuments: 'tenders:reconcile-documents',
  cleanupDocumentTrash: 'tenders:cleanup-document-trash',
  // Rotating backups + explicit recovery (Phase 5 WP-2 remainder).
  listRecoveryCandidates: 'tenders:list-recovery-candidates',
  restoreRecoveryCandidate: 'tenders:restore-recovery-candidate',
} as const

export interface SaveDocumentRequest {
  fileName: string
  buffer: ArrayBuffer | Uint8Array
  category: 'rfp' | 'vault'
}

export interface SaveDocumentResponse {
  ok: boolean
  storedPath?: string
  /** Managed-document metadata id (Phase 5 WP-9). */
  id?: string
  record?: ManagedFileRecord
  error?: string
}

/**
 * Maximum size of a document uploaded through `saveDocument` / served by
 * `readDocument`. A single persisted attachment/RFP is bounded here so a
 * renderer cannot stream an unbounded buffer across IPC. Distinct from the
 * `tenders-data.json` document bound in `tenders-persistence.ts`.
 */
export const MAX_TENDERS_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * Bounds for the compliance-matrix export (`exportMatrixToSheets`). The matrix is
 * written to a temp CSV, so an unbounded row/cell count would let a renderer
 * allocate an arbitrarily large file. Mirrors `MAX_TENDERS_REQUIREMENTS_PER_TENDER`
 * (5000 rows) and `MAX_TENDERS_SINGLE_STRING_CHARS` (32768 chars per cell).
 */
export const MAX_TENDERS_MATRIX_EXPORT_ROWS = 5000
export const MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS = 32768

/**
 * Ceiling for one serialized `exportMatrixToSheets` payload — the compliance
 * matrix the handler turns into a CSV in `tmpdir()` before handing the file to
 * the OS. Checked before any CSV work, so an over-bound request never allocates
 * the file.
 *
 * Its own bound, deliberately not the IPC envelope's (`MAX_TENDERS_IPC_PAYLOAD_BYTES`
 * in `tenders-persistence.ts`, which the `saveStoreV2` request uses): a raised
 * envelope once loosened this export for a reason that had nothing to do with it,
 * and nothing then reported the change. What this number bounds is the export, so
 * the export states it. A legitimate payload is one tender's requirement list —
 * the rows the renderer reads out of the workspace document — which is a strict
 * subset of the document the store already accepts (`MAX_TENDERS_DOCUMENT_BYTES`,
 * 4 MiB), so a payload above this ceiling exceeds the whole workspace document and
 * no export read from the store can reach it. Held *below* the envelope on
 * purpose: the export then answers for itself, and a payload between the two is
 * refused by this check (pinned by `tests/tenders-main-write-bounds.test.ts`).
 */
export const MAX_TENDERS_MATRIX_EXPORT_BYTES = 4 * 1024 * 1024

/**
 * `saveStoreV2` reply. Conflict replies are COMPACT: they carry
 * `currentRevision`, never the full authoritative `current` document (that
 * document is only ever read back through `loadStoreV2`).
 */
export type SaveTendersIpcResult = SaveTendersResult & { currentRevision?: number }

/**
 * Renderer's answer to a `closeFlushRequest` (shell dirty-close guard).
 * `dirty` is the state the renderer was in when the flush started; `ok` is the
 * state after it — an uncommitted edit left behind (a failed or refused save)
 * reports `ok: false` and main must not close silently on it.
 */
export interface TendersCloseFlushResult {
  dirty: boolean
  ok: boolean
  /** Renderer-side save error when the flush could not commit. */
  error: string | null
}

export interface ReadDocumentRequest {
  storedPath: string
}

export interface ReadDocumentResponse {
  ok: boolean
  buffer?: ArrayBuffer
  error?: string
}

export interface OpenDocumentRequest {
  storedPath: string
}

export interface OpenDocumentResponse {
  ok: boolean
  error?: string
}

export interface DeleteDocumentRequest {
  storedPath: string
  /** Managed record id, when the caller has it (preferred over storedPath). */
  id?: string
}

export interface DeleteDocumentResponse {
  ok: boolean
  error?: string
  /** Records that reference the file; surfaced before/after a soft-delete. */
  links?: ManagedFileLink[]
  /** Human-readable warnings (e.g. "linked by 2 tenders"). */
  warnings?: string[]
  /** Trash entry id when the delete was a soft-delete (undo handle). */
  trashId?: string
}

// ── Managed-document lifecycle IPC (Phase 5 WP-9) ────────────────────────────

export interface ListDocumentTrashResponse {
  ok: boolean
  entries?: ManagedFileTrashEntry[]
  error?: string
}

export interface RestoreDocumentRequest {
  /** Trash entry id (or trashed relative path) from `listDocumentTrash`. */
  id: string
}

export interface RestoreDocumentResponse {
  ok: boolean
  record?: ManagedFileRecord
  /** Relative path the file was restored to. */
  storedPath?: string
  error?: string
}

export interface ReplaceDocumentRequest {
  /** Existing managed relative path being replaced. */
  storedPath: string
  fileName: string
  buffer: ArrayBuffer | Uint8Array
}

export interface ReplaceDocumentResponse {
  ok: boolean
  record?: ManagedFileRecord
  storedPath?: string
  /** True when the previous file was moved to trash after the new commit. */
  previousTrashed?: boolean
  warning?: string
  error?: string
}

export interface ReconcileDocumentsResponse {
  ok: boolean
  reconciliation?: DocumentReconciliation
  error?: string
}

export interface CleanupDocumentTrashRequest {
  /** Purge everything (explicit user action). */
  all?: boolean
  /** Or purge entries trashed at least this long ago. */
  olderThanMs?: number
}

export interface CleanupDocumentTrashResponse {
  ok: boolean
  removed?: number
  error?: string
}

// ── Recovery IPC (rotating backups, Phase 5 WP-2) ────────────────────────────

export interface ListRecoveryCandidatesResponse {
  ok: boolean
  candidates?: TendersRecoveryCandidate[]
  error?: string
}

export interface RestoreRecoveryCandidateRequest {
  /** Candidate id from `listRecoveryCandidates` (never an absolute path). */
  id: string
}

export interface RestoreRecoveryCandidateResponse {
  ok: boolean
  data?: TendersDataV2
  currentRevision?: number
  error?: { code: string; message: string }
}

export interface BillMilestoneRequest {
  tenderId: string
  milestoneId: string
  expectedRevision?: number
  tenderReference?: string
  issuingAuthority?: string
  milestoneTitle?: string
  /**
   * Compatibility echo only. The invoice amount is ALWAYS derived from the
   * canonical milestone in the authoritative document; a value that does not
   * match it is rejected rather than billed. Main ignores the descriptive
   * fields (`tenderReference`, `issuingAuthority`, `milestoneTitle`) for the
   * invoice and resolves them from the canonical tender.
   */
  amount?: number
  notes?: string
}

export interface BillMilestoneResult {
  ok: boolean
  invoiceNumber?: string
  invoiceId?: string
  tenderReference?: string
  grandTotal?: number
  subtotal?: number
  taxTotal?: number
  error?: string
  /**
   * True when the invoice already existed (Books dedupes on the idempotency
   * key) and the tender was reconciled to it, rather than a new invoice being
   * posted by this call.
   */
  reconciled?: boolean
  /** Non-fatal note (e.g. the invoice posted but the tender link retried). */
  warning?: string
  /** Present on a revision conflict so the caller can retry against it. */
  currentRevision?: number
}

export type TenderOutcomeValue = 'won' | 'lost' | 'withdrawn' | 'cancelled'

export interface UpdateTenderOutcomeRequest {
  tenderId: string
  dealId?: string
  outcome: TenderOutcomeValue
  amount?: number
  reason?: string
  noticeDate?: string
}

export interface UpdateTenderOutcomeResult {
  ok: boolean
  dealId?: string
  error?: string
}

export interface SyncWithCrmRequest {
  id?: string
  dealId?: string
  tenderId?: string
  tenderReference?: string
  name?: string
  companyName?: string
  amount?: number
  stage?: string
  expectedCloseDate?: string
  notes?: string
  expectedRevision?: number
  [key: string]: unknown
}

export interface TendersApiBridge {
  getStoredData: () => Promise<string | null>
  saveStoredData: (json: string) => Promise<{ ok: boolean; error?: string }>
  onDataChanged: (callback: (data: TendersData) => void) => () => void
  saveDocument: (req: SaveDocumentRequest) => Promise<SaveDocumentResponse>
  readDocument: (req: ReadDocumentRequest) => Promise<ReadDocumentResponse>
  openDocument: (req: OpenDocumentRequest) => Promise<OpenDocumentResponse>
  deleteDocument: (req: DeleteDocumentRequest) => Promise<DeleteDocumentResponse>
  loadStoreV2: () => Promise<TendersLoadResult>
  saveStoreV2: (request: SaveTendersRequest) => Promise<SaveTendersIpcResult>
  onStoreChangedV2: (callback: (data: TendersDataV2) => void) => () => void
}

export interface TendersApi extends TendersApiBridge {
  /** Subscribe to main's pre-close flush request; returns an unsubscribe function. */
  onCloseFlushRequest: (handler: (requestId: number) => void) => () => void
  /** Answer a `closeFlushRequest`; main resolves its close guard on this reply. */
  reportCloseFlush: (requestId: number, result: TendersCloseFlushResult) => Promise<void>
  getStoredData: () => Promise<string | null>
  saveStoredData: (json: string) => Promise<{ ok: boolean; error?: string }>
  onDataChanged: (callback: (data: TendersData) => void) => () => void
  saveDocument: (req: SaveDocumentRequest) => Promise<SaveDocumentResponse>
  readDocument: (req: ReadDocumentRequest) => Promise<ReadDocumentResponse>
  openDocument: (req: OpenDocumentRequest) => Promise<OpenDocumentResponse>
  deleteDocument: (req: DeleteDocumentRequest) => Promise<DeleteDocumentResponse>
  // Managed-document + recovery surface. Optional until the preload bridge is
  // wired in the follow-up lane.
  listDocumentTrash?: () => Promise<ListDocumentTrashResponse>
  restoreDocument?: (req: RestoreDocumentRequest) => Promise<RestoreDocumentResponse>
  replaceDocument?: (req: ReplaceDocumentRequest) => Promise<ReplaceDocumentResponse>
  reconcileDocuments?: () => Promise<ReconcileDocumentsResponse>
  cleanupDocumentTrash?: (
    req?: CleanupDocumentTrashRequest,
  ) => Promise<CleanupDocumentTrashResponse>
  listRecoveryCandidates?: () => Promise<ListRecoveryCandidatesResponse>
  restoreRecoveryCandidate?: (
    req: RestoreRecoveryCandidateRequest,
  ) => Promise<RestoreRecoveryCandidateResponse>
  exportMatrixToSheets: (
    tenderId: string,
    tenderTitle: string,
    matrixRows: any[],
  ) => Promise<{ ok: boolean; path?: string; error?: string }>
  draftProposalDoc: (tender: any) => Promise<{ ok: boolean; path?: string; error?: string }>
  syncWithCrm: (
    dealData: SyncWithCrmRequest,
  ) => Promise<{ ok: boolean; dealId?: string; error?: string }>
  /** Exposed by the preload bridge; the main handler owns validation/trust. */
  updateTenderOutcome: (request: UpdateTenderOutcomeRequest) => Promise<UpdateTenderOutcomeResult>
  openInCrm: (dealId?: string) => Promise<{ ok: boolean }>
  billMilestoneInBooks: (
    tenderIdOrPayload: string | BillMilestoneRequest,
    milestoneId?: string,
  ) => Promise<BillMilestoneResult>
  openBooks: () => Promise<boolean>
  /** Read the resolved suite theme (`light | dark`) (Phase 5 / WP-13). */
  getTheme: () => Promise<TendersResolvedTheme>
  /** Subscribe to resolved suite theme changes; returns an unsubscribe function. */
  onThemeChanged: (handler: (theme: TendersResolvedTheme) => void) => () => void
}

declare global {
  interface Window {
    tendersApi?: TendersApi
  }
}

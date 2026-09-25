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
import type {
  DiscoveryCacheEnvelope,
  DiscoveryParseIssue,
  DiscoverySource,
  DiscoveryWindow,
  Opportunity,
} from './discovery'
import type { DueReminder, ReminderLedger, ReminderSettings } from './reminders'

/**
 * Canonical AI types live in `@genoffice/ai-provider` (shared with docs / pdf /
 * sheets / slides), so the wire shape is never restated here. `AiSettings` comes
 * from the package's browser-safe subpath. `AiStreamRequest` / `AiStreamChunk`
 * are only re-exported from the package root today; every one of these is a
 * type-only import + type-only re-export, which the bundler erases, so no
 * Node-backed transport can reach the renderer bundle through them.
 */
import type { AiSettings } from '@genoffice/ai-provider/browser'
import type { AiStreamChunk, AiStreamRequest } from '@genoffice/ai-provider'
export type { AiSettings, AiStreamChunk, AiStreamRequest }

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

/**
 * App-wide shared AI channels — pass-through only, exactly like the PDF pane's
 * `AI_CHANNELS`. `ipcMain.handle` for every one of these is registered ONCE for
 * the whole suite by the shell's main process (`registerAiIpc()`, the docs app's
 * function, called at module scope in `apps/shell/src/main/index.ts`), and
 * Tenders runs as a WebContentsView inside that same process, so the handlers
 * are already live whenever Tenders is open. Tenders must NEVER register them:
 * a second `ipcMain.handle` on the same channel throws
 * "Attempted to register a second handler for 'ai:stream'".
 *
 * Consequence for the renderer: AI is OPTIONAL and additive. With no API key
 * (or no network) the stream answers with an `error` chunk — the local rule
 * engine stays the offline default and must keep working untouched.
 */
export const AI_CHANNELS = {
  /** BYOK settings (`userData/ai-settings.json`), owned by the shell. */
  getSettings: 'ai:get-settings',
  /** One streaming turn: invoke with an `AiStreamRequest`. */
  stream: 'ai:stream',
  /** Per-request stream chunks broadcast back to this webContents. */
  streamChunk: 'ai:stream-chunk',
  /** Abort an in-flight stream by its `requestId`. */
  streamCancel: 'ai:stream-cancel',
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
  // Tender discovery (National Treasury's eTenders open data). Additive and
  // optional: the local rule engine stays the offline, always-available default,
  // and nothing here is reachable without an explicit user action. The handlers
  // live in `main/tenders-main.ts` and pass every call through to the injected
  // discovery client (`main/discovery-client.ts`).
  discoveryList: 'tenders:discovery-list',
  discoveryRefresh: 'tenders:discovery-refresh',
  discoveryReadCache: 'tenders:discovery-read-cache',
  discoveryRelease: 'tenders:discovery-release',
  discoveryDownloadDocument: 'tenders:discovery-download-document',
  // Deadline reminders (the app's only notification path). The schedule is
  // computed on this machine from the authoritative store; nothing is networked.
  remindersGet: 'tenders:reminders-get',
  remindersSet: 'tenders:reminders-set',
  remindersCheck: 'tenders:reminders-check',
  /**
   * Diagnostics. The renderer reports a failure it can see but main cannot (a
   * renderer-side refusal, a dropped extraction), and reads back where the log
   * lives so the user can be told. Both are behind the same trusted-sender gate
   * as every other handler; neither can read the log back, so a renderer can add
   * to the record and never browse it.
   */
  diagnosticsRecord: 'tenders:diagnostics-record',
  diagnosticsPath: 'tenders:diagnostics-path',
} as const

/**
 * The levels a renderer may report at. Identical to the sink's own
 * `DiagnosticsLevel`; restated here because `shared/` must not reach into
 * `main/` (the sink is a main-process module).
 */
export type TendersDiagnosticsLevel = 'info' | 'warn' | 'error'

/** Longest message the diagnostics channel will carry, in characters. */
export const MAX_TENDERS_DIAGNOSTIC_MESSAGE_CHARS = 2_000

/** Longest `source` the diagnostics channel will carry, in characters. */
export const MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS = 64

/** Most `detail` keys the diagnostics channel will carry. */
export const MAX_TENDERS_DIAGNOSTIC_DETAIL_KEYS = 24

export interface RecordDiagnosticsRequest {
  level: TendersDiagnosticsLevel
  source: string
  message: string
  detail?: Record<string, unknown>
}

export interface RecordDiagnosticsResponse {
  ok: boolean
  error?: string
}

export interface DiagnosticsPathResponse {
  ok: boolean
  /** Absolute path of the live log. Present only when `ok`. */
  path?: string
  error?: string
}

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

// ── Tender discovery (National Treasury eTenders open data) ──────────────────
//
// The wire contract for the five discovery channels. The shapes mirror the
// results of `main/discovery-client.ts` (which is where the allow-list, the byte
// caps, the retries and the cache actually live) so the renderer can branch on
// `ok` exactly as the client does, and every failure carries the client's own
// plain-language message — the renderer shows it, it does not re-word it.

/**
 * A refused call on the discovery / reminder channels. `message` is
 * plain-language and safe to show verbatim — the renderer shows it, it does not
 * re-word it.
 *
 * `code` is a string rather than a union on purpose: the unions belong to the
 * engines (the discovery client's `DiscoveryErrorCode`, the store's
 * `TendersPersistenceErrorCode`), and a renderer must treat an unrecognised code
 * as a failure (it branches on `ok`), so restating a union here would be a
 * second source of truth that could drift.
 */
export interface TendersIpcError {
  code: string
  message: string
  /** The URL that was refused or failed, when the failure was about one. */
  url?: string
  /** The HTTP status, when the failure was about one. */
  status?: number
  /** Attempts made, when the engine retried. */
  attempts?: number
}

/** The shape every discovery / reminder refusal takes, trusted-sender rejections included. */
export interface TendersIpcFailure {
  ok: false
  error: TendersIpcError
}

export interface DiscoveryListRequest {
  /** A publication window of at most seven days (see `splitWindow`). */
  window: DiscoveryWindow
  /** Records per page. Bounded by the handler before it reaches the wire. */
  pageSize?: number
}

/** Mirrors the client's `ListOpportunitiesSuccess`. */
export type DiscoveryListResponse =
  | {
      ok: true
      opportunities: Opportunity[]
      issues: DiscoveryParseIssue[]
      warnings: string[]
      pages: number
      failedPages: number
      source: DiscoverySource
      /** True when the walk stopped before the source ran out — read `warnings`. */
      truncated: boolean
    }
  | TendersIpcFailure

export interface DiscoveryRefreshRequest {
  /** Defaults to the client's documented lookback window. */
  window?: DiscoveryWindow
}

/** Mirrors the client's `RefreshCacheSuccess`. */
export type DiscoveryRefreshResponse =
  | {
      ok: true
      cache: DiscoveryCacheEnvelope
      /** False when a window or the fallback failed, so the list is partial. */
      complete: boolean
      warnings: string[]
    }
  | TendersIpcFailure

/** Mirrors the client's `ReadCacheSuccess`. `cache` is null before a first fetch. */
export type DiscoveryReadCacheResponse =
  | { ok: true; cache: DiscoveryCacheEnvelope | null; stale: boolean; warnings: string[] }
  | TendersIpcFailure

export interface DiscoveryReleaseRequest {
  /** The OCDS ocid, from a listed opportunity. */
  ocid: string
}

/** Mirrors the client's `FetchReleaseSuccess`. */
export type DiscoveryReleaseResponse =
  | {
      ok: true
      opportunity: Opportunity | null
      issues: DiscoveryParseIssue[]
      warnings: string[]
    }
  | TendersIpcFailure

export interface DiscoveryDownloadDocumentRequest {
  /**
   * The document link from the feed. It is NOT fetched as given: the handler
   * re-checks it with the discovery allow-list (https, exact Treasury host, no
   * embedded credentials) and refuses anything else before any request is made.
   */
  url: string
  /** Optional stored name. Defaults to the last segment of the link. */
  fileName?: string
}

/**
 * A document the app downloaded into its own managed document store, so the
 * renderer can run the ordinary intake on it. `record`/`storedPath` are the
 * durable handle (`readDocument` / `openDocument` / `deleteDocument` all accept
 * them); `buffer` is the same bytes, so the intake can run without a second
 * round trip.
 */
export type DiscoveryDownloadDocumentResponse =
  | {
      ok: true
      record: ManagedFileRecord
      /** Managed relative path, e.g. `documents/1789_etender.pdf`. */
      storedPath: string
      /** The name the document was stored under (sanitized and clamped). */
      fileName: string
      mimeType: string
      byteLength: number
      buffer: ArrayBuffer
    }
  | TendersIpcFailure

/**
 * Ceiling on one downloaded tender document, enforced while the body is read.
 * Deliberately the same number the managed store refuses to save above
 * (`MAX_TENDERS_DOCUMENT_UPLOAD_BYTES`): a document larger than that cannot be
 * stored, so downloading it would spend the user's bandwidth to reach a
 * refusal.
 */
export const MAX_DISCOVERY_DOWNLOAD_BYTES = MAX_TENDERS_DOCUMENT_UPLOAD_BYTES

/** Longest document link accepted from the renderer. */
export const MAX_DISCOVERY_DOCUMENT_URL_CHARS = 2048

/** Longest stored name accepted for a downloaded document. */
export const MAX_DISCOVERY_DOCUMENT_FILE_NAME_CHARS = 512

// ── Deadline reminders ──────────────────────────────────────────────────────

/**
 * Bounds on a settings patch from the renderer. `normalizeReminderSettings`
 * drops unusable entries rather than refusing them, which is right for a file
 * this app wrote and wrong for a payload it was handed: silently dropping a
 * threshold would let a user believe a lead time was set when it was not, so the
 * handler refuses the whole patch instead (and says so).
 */
export const MAX_TENDERS_REMINDER_THRESHOLDS = 12
export const MAX_TENDERS_REMINDER_LABEL_CHARS = 64
/** Longest lead time accepted: one year before closing. */
export const MAX_TENDERS_REMINDER_LEAD_MS = 365 * 24 * 60 * 60 * 1000

/** The persisted settings and dedupe ledger, plus the limitation sentence. */
export type RemindersStateResponse =
  | {
      ok: true
      settings: ReminderSettings
      ledger: ReminderLedger
      /**
       * `REMINDERS_RUNTIME_LIMITATION` from `main/reminders-scheduler.ts`: the one
       * sentence stating that reminders are checked only while the app runs. It
       * travels on this response so the settings surface can show the real reach
       * of a notification without importing a main-process module.
       */
      limitation: string
    }
  | TendersIpcFailure

/** A partial settings write: what it names changes, nothing else. */
export interface RemindersSetRequest {
  enabled?: boolean
  thresholds?: Array<{ id: string; label?: string; leadMs: number }>
}

export type RemindersSetResponse =
  { ok: true; settings: ReminderSettings; limitation: string } | TendersIpcFailure

/**
 * One check's outcome. The dedupe ledger is deliberately NOT returned: it is
 * main's memory of what has already been shown, not something a renderer should
 * be able to write back.
 */
export type RemindersCheckResponse =
  { ok: true; fired: number; reminders: DueReminder[] } | TendersIpcFailure

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
  // ── Shared AI surface (AI extraction pass) ────────────────────────────────
  // Pass-throughs to the shell-registered `ai:*` handlers (see `AI_CHANNELS`).
  // The bridge adds nothing: settings, message list, tools and maxTokens reach
  // main exactly as the renderer built them.
  /** BYOK settings from the shell (`userData/ai-settings.json`). */
  getAiSettings: () => Promise<AiSettings>
  /** Start one streaming turn. Resolves when main has taken the request; the
   * answer arrives as `ai:stream-chunk` events via `onAiStream`. */
  aiStream: (request: AiStreamRequest) => Promise<void>
  /** Abort an in-flight stream by its `requestId` (the `AiStreamRequest` id). */
  aiStreamCancel: (requestId: string) => Promise<void>
  /** Subscribe to this view's stream chunks; returns an unsubscribe function. */
  onAiStream: (handler: (chunk: AiStreamChunk) => void) => () => void
  // ── Tender discovery + deadline reminders ─────────────────────────────────
  // Thin pass-throughs to the handlers in `main/tenders-main.ts`. The bridge
  // validates nothing: the allow-list, the byte caps, the trusted-sender check
  // and the store all stay in main.
  /** List opportunities published in a window (at most seven days wide). */
  discoveryList: (request: DiscoveryListRequest) => Promise<DiscoveryListResponse>
  /** Refresh the saved list. Optional window; defaults to the documented lookback. */
  discoveryRefresh: (request?: DiscoveryRefreshRequest) => Promise<DiscoveryRefreshResponse>
  /** Read the saved list. Available with no network at all; null before a first fetch. */
  discoveryReadCache: () => Promise<DiscoveryReadCacheResponse>
  /** Read one canonical Treasury record by ocid. */
  discoveryFetchRelease: (request: DiscoveryReleaseRequest) => Promise<DiscoveryReleaseResponse>
  /**
   * Download a tender document into the app's own document store. The URL is
   * re-checked against the discovery allow-list in main, so only an https link
   * on a Treasury host is ever fetched.
   */
  discoveryDownloadDocument: (
    request: DiscoveryDownloadDocumentRequest,
  ) => Promise<DiscoveryDownloadDocumentResponse>
  /** The reminder settings and dedupe ledger, plus the honest runtime limitation. */
  getReminders: () => Promise<RemindersStateResponse>
  /** Merge a partial settings change and persist it. */
  setReminders: (settings: RemindersSetRequest) => Promise<RemindersSetResponse>
  /** Run one reminder check now (the settings surface's "check now"). */
  checkReminders: () => Promise<RemindersCheckResponse>
  /**
   * Record one diagnostic entry from the renderer. Main validates the shape and
   * the bounds and writes it through the same rotating sink it uses itself; the
   * renderer never sees a path, a file handle or a log reader.
   */
  recordDiagnostics?: (request: RecordDiagnosticsRequest) => Promise<RecordDiagnosticsResponse>
  /** Where the diagnostics log is, so the UI can tell the user. */
  diagnosticsPath?: () => Promise<DiagnosticsPathResponse>
}

declare global {
  interface Window {
    tendersApi?: TendersApi
  }
}

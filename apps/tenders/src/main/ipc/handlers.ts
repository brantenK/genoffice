// The Tenders IPC surface: all thirty-three `ipcMain.handle` registrations.
//
// Split out of `main/tenders-main.ts` with no behaviour change. The invariant this
// file exists to keep is stated once, at the top, because it is what the whole
// security posture rests on:
//
//   **Every handler begins with `isTrustedTendersEvent`** (in `ipc/trust.ts`).
//
// A request that fails that gate returns `unauthorizedTendersRequest()` and
// reaches no side effect at all — not a store read, not a disk write, not a
// network call.
//
// Beyond the gate, the handlers here validate the SHAPE of what they were sent and
// pass the meaning on: the discovery client owns what a window, an ocid or a
// document link means, the store owns what a revision conflict is, and this file
// does not re-word either one's answer.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { ipcMain } from 'electron'
import {
  MAX_TENDERS_DIAGNOSTIC_DETAIL_KEYS,
  MAX_TENDERS_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS,
  MAX_TENDERS_MATRIX_EXPORT_BYTES,
  MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS,
  MAX_TENDERS_MATRIX_EXPORT_ROWS,
  TENDERS_CHANNELS,
  type BillMilestoneRequest,
  type BillMilestoneResult,
  type CleanupDocumentTrashRequest,
  type DeleteDocumentRequest,
  type DiagnosticsPathResponse,
  type DiscoveryDownloadDocumentRequest,
  type DiscoveryListRequest,
  type DiscoveryListResponse,
  type DiscoveryReadCacheResponse,
  type DiscoveryRefreshRequest,
  type DiscoveryRefreshResponse,
  type DiscoveryReleaseRequest,
  type DiscoveryReleaseResponse,
  type OpenDocumentRequest,
  type ReadDocumentRequest,
  type RecordDiagnosticsResponse,
  type RemindersCheckResponse,
  type RemindersSetRequest,
  type RemindersSetResponse,
  type RemindersStateResponse,
  type ReplaceDocumentRequest,
  type RestoreDocumentRequest,
  type RestoreRecoveryCandidateRequest,
  type SaveDocumentRequest,
} from '../../shared/ipc'
import {
  MAX_TENDERS_IPC_PAYLOAD_BYTES,
  type SaveTendersRequest,
  type TendersPersistenceError,
} from '../../shared/tenders-persistence'
import type { ContractMilestone, TenderRecord, TendersDataV2 } from '../../shared/types'
import { milestonesAllowed } from '../../shared/lifecycle'
import { validateTendersDataV2 } from '../../shared/tenders-schema'
import type { ReadinessBinding, ReadinessReport } from '../../shared/readiness'
import { isRecord } from '../readiness-snapshot'
import { errorMessage } from '../main-utils'
import { recordDiagnostic } from '../diagnostics-sink'
import { getTendersDiagnosticsLog, tendersDiagnosticsPath } from '../diagnostics-sink'
import { readTendersStore, LEGACY_TENDERS_READ_FAILED } from '../legacy-store'
import { getUniqueTimestamp } from '../tenders-paths'
import { REMINDERS_RUNTIME_LIMITATION } from '../reminders-scheduler'
import { buildCanonicalReadinessReport } from '../readiness-binding'
import { expectedReadinessBinding, generateProposalMarkdown } from '../proposal-generator'
import {
  managedDocumentStore,
  authoritativeStore as getAuthoritativeTendersStore,
} from '../store-registry'
import {
  saveDocumentFile,
  readDocumentFile,
  openDocumentFile,
  deleteDocumentFile,
  listDocumentTrashFile,
  restoreDocumentFile,
  replaceDocumentFile,
  reconcileDocumentFiles,
  cleanupDocumentTrash,
  listRecoveryCandidatesFile,
  restoreRecoveryCandidateFile,
} from '../document-lifecycle'
import {
  getDiscoveryClient,
  getRemindersScheduler,
  downloadDiscoveryDocument,
  discoveryFailure,
  validateReminderSettingsPatch,
  startTendersReminders,
} from './engines'
import { validProposalPayload, writeGeneratedProposal } from './proposal-payload'
import { isTrustedTendersEvent, unauthorizedTendersRequest } from './trust'
import { isTendersIpcRegistered, markTendersIpcRegistered } from './registration-state'
import {
  getStoragePath,
  listLegacyRecoveryCandidates,
  noteLegacyReadFailure,
  getIntegrations,
  runtime,
  closeFlushWaiters,
  recordDiagnosticsStart,
  tendersAppVersion,
  findTenderById,
  openOwningApp,
  TENDERS_DEMO_WRITE_ERROR,
  tendersNotWonBillingError,
} from '../composition-services'

export function registerTendersIpc(): void {
  if (isTendersIpcRegistered()) return

  // The first line in the log file, so a file attached to a support request says
  // what wrote it and which build. This is the only caller of
  // `recordDiagnosticsStart`: the sink is built here for the first time, and the
  // `ipcRegistered` guard above keeps the line from being written twice. It is
  // written BEFORE anything else can record — `startTendersReminders` below
  // records its own info line on its first check, and a header that arrives
  // second is not a header.
  recordDiagnosticsStart(getTendersDiagnosticsLog(), tendersAppVersion())

  // The legacy `tenders-data.json` watcher is NOT started here any more. It read
  // the v1 file back on every change and broadcast it on `tenders:data-changed`,
  // a channel with no subscribers since the authoritative v2 store landed — a
  // background reader nobody consumed. `getStoredData` (below) still serves the
  // legacy file on demand; nothing watches it.
  //
  // Best-effort startup reconciliation of managed documents (Phase 5 WP-9):
  // persist missing/orphaned state now; the renderer shows the full report via
  // `tenders:reconcile-documents`. A failure never blocks startup.
  void managedDocumentStore()
    .reconcile()
    .catch(() => {})

  // Deadline reminders start with the same hook as the store watcher, so the
  // store is available before the first check reads it. `start()` is idempotent
  // and runs one check immediately; `will-quit` stops the timer (see
  // `registerRemindersQuitHook`).
  startTendersReminders()

  ipcMain.handle(TENDERS_CHANNELS.loadStoreV2, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    const result = await getAuthoritativeTendersStore().load()
    if (!result.ok) {
      // A store that could not be read is the one failure a user will report as
      // "my data is gone", and the answer has to be in the record: the code, the
      // message and how many recovery copies main can see.
      recordDiagnostic('error', 'store', result.error.message, {
        code: result.error.code,
        candidates: result.recoveryCandidates?.length ?? 0,
      })
    }
    return result
  })

  ipcMain.handle(TENDERS_CHANNELS.saveStoreV2, async (_e, request: SaveTendersRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
      if (payloadBytes > MAX_TENDERS_IPC_PAYLOAD_BYTES) {
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: `IPC payload exceeds ${MAX_TENDERS_IPC_PAYLOAD_BYTES} bytes.`,
          },
        }
      }
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: error instanceof Error ? error.message : 'IPC payload cannot be serialized.',
        },
      }
    }
    // A submission readiness checkpoint is a renderer-authored claim; the
    // authoritative store recomputes the ones a commit introduces or changes
    // against canonical readiness (see `gateTendersCommits`), so no write path —
    // this one or the legacy `saveStoredData` channel — can persist a clear
    // receipt for a blocked tender.
    const result = await getAuthoritativeTendersStore().save(request)
    if (result.ok) return result
    // A refused save is the failure the user sees as "my edit did not stick".
    // Recorded with its code, so an intermittent refusal can be attributed to
    // the branch that produced it rather than to "saving sometimes fails".
    recordDiagnostic('warn', 'store', result.error.message, { code: result.error.code })
    // Compact conflict payload: never ship the full authoritative document over
    // IPC. The renderer only needs the error and the current revision; it
    // reveals its conflict UI from `code`, and reloads via `loadStoreV2`.
    return {
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.schemaIssues ? { schemaIssues: result.error.schemaIssues } : {}),
      },
      currentRevision: result.current?.revision ?? result.error.current?.revision,
    }
  })

  // Shell dirty-close guard reply: the renderer reports whether its debounced
  // edit was committed. The reply is accepted only from the very view the
  // request was sent to — a sender that cannot identify itself is not that view.
  ipcMain.handle(TENDERS_CHANNELS.closeFlushResult, async (_e, payload: unknown) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    const reply = isRecord(payload) ? payload : null
    const requestId = typeof reply?.requestId === 'number' ? reply.requestId : null
    const waiter = requestId === null ? undefined : closeFlushWaiters.get(requestId)
    const senderId = (_e.sender as { id?: unknown } | undefined)?.id
    const fromGuardedView =
      waiter !== undefined && typeof senderId === 'number' && senderId === waiter.webContentsId
    if (!waiter || requestId === null || !fromGuardedView) {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'No close-flush request is outstanding for this reply.',
        },
      }
    }
    closeFlushWaiters.delete(requestId)
    waiter.settle({
      dirty: reply?.dirty === true,
      ok: reply?.ok === true,
      error: typeof reply?.error === 'string' && reply.error.length > 0 ? reply.error : null,
    })
    return { ok: true }
  })

  // Persistence in userData/tenders/
  //
  // The legacy read path. It answers with the file that is actually on disk, or
  // `null` when there is no file at all — never with a synthesized document and
  // never with a silent empty one. A file that exists but cannot be read or
  // parsed used to be reported as `null`, which the renderer showed as "no saved
  // data": apparent data loss, with the real failure invisible. It now fails
  // CLOSED with the shared `TendersIpcFailure` shape the other privileged
  // handlers already return, names the recovery copies main can see, and asks the
  // caller to restore one — the same posture `loadStoreV2` takes for the
  // authoritative store.
  ipcMain.handle(TENDERS_CHANNELS.getStoredData, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    const p = getStoragePath()
    if (!existsSync(p)) return null
    try {
      return JSON.stringify(readTendersStore(p))
    } catch (err) {
      noteLegacyReadFailure(p, err)
      const candidates = await listLegacyRecoveryCandidates()
      return {
        ok: false,
        error: {
          code: 'RECOVERY_REQUIRED',
          message: LEGACY_TENDERS_READ_FAILED,
        },
        ...(candidates.length ? { recoveryCandidates: candidates } : {}),
      }
    }
  })

  // Legacy write channel — v2 documents only. The shipping renderer persists
  // exclusively through `saveStoreV2`; this channel is kept for caller
  // compatibility but no longer writes outside the authoritative store. A v2
  // document commits through the same lock, revision check and atomic write
  // path, and a v1/legacy payload is rejected, so it can never re-seed demo
  // company/vault/tender data into (or overwrite) the user's store.
  ipcMain.handle(TENDERS_CHANNELS.saveStoredData, async (_e, json: string) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      let parsed: unknown
      try {
        parsed = typeof json === 'string' ? JSON.parse(json) : json
      } catch (error: any) {
        return { ok: false, error: error?.message || 'Failed to parse Tenders payload' }
      }
      const validated = validateTendersDataV2(parsed)
      if (!validated.ok) {
        return {
          ok: false,
          error: `Legacy persistence accepts only a schema-v2 document: ${validated.error.message}`,
        }
      }
      const result = await getAuthoritativeTendersStore().save({
        expectedRevision: validated.data.revision,
        document: validated.data,
      })
      if (result.ok) return { ok: true }
      recordDiagnostic('warn', 'store', result.error.message, { code: result.error.code })
      return { ok: false, error: result.error.message }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save stored data' }
    }
  })

  // Persistent Document & Vault Disk Storage (R2)
  ipcMain.handle(TENDERS_CHANNELS.saveDocument, async (_e, req: SaveDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return saveDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.readDocument, async (_e, req: ReadDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return readDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.openDocument, async (_e, req: OpenDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return openDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.deleteDocument, async (_e, req: DeleteDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return deleteDocumentFile(req)
  })

  // Managed-document lifecycle (Phase 5 WP-9). Every handler is behind the same
  // trusted-sender gate and validates its request shape before touching disk.
  ipcMain.handle(TENDERS_CHANNELS.listDocumentTrash, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return listDocumentTrashFile()
  })

  ipcMain.handle(TENDERS_CHANNELS.restoreDocument, async (_e, req: RestoreDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.id !== 'string' ||
      req.id.length === 0 ||
      req.id.length > 512
    ) {
      return { ok: false, error: 'A valid trash entry id is required' }
    }
    return restoreDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.replaceDocument, async (_e, req: ReplaceDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.storedPath !== 'string' ||
      typeof req.fileName !== 'string' ||
      req.fileName.length > 512
    ) {
      return { ok: false, error: 'storedPath and fileName are required' }
    }
    return replaceDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.reconcileDocuments, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return reconcileDocumentFiles()
  })

  ipcMain.handle(
    TENDERS_CHANNELS.cleanupDocumentTrash,
    async (_e, req: CleanupDocumentTrashRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      return cleanupDocumentTrash(req)
    },
  )

  // Rotating backups + explicit recovery (Phase 5 WP-2 remainder).
  ipcMain.handle(TENDERS_CHANNELS.listRecoveryCandidates, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return listRecoveryCandidatesFile()
  })

  ipcMain.handle(
    TENDERS_CHANNELS.restoreRecoveryCandidate,
    async (_e, req: RestoreRecoveryCandidateRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      if (
        !req ||
        typeof req !== 'object' ||
        typeof req.id !== 'string' ||
        req.id.length === 0 ||
        req.id.length > 512
      ) {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'A valid candidate id is required.' },
        }
      }
      return restoreRecoveryCandidateFile(req)
    },
  )

  // ── Tender discovery ───────────────────────────────────────────────────────
  // Every handler is behind the same trusted-sender gate as the rest of this
  // file, validates the request's SHAPE (never its meaning — the client owns
  // what a window, an ocid or a document link means), and passes the client's
  // own result straight back, so the renderer sees exactly the message the
  // engine produced rather than a re-worded one.

  ipcMain.handle(
    TENDERS_CHANNELS.discoveryList,
    async (_e, request: DiscoveryListRequest): Promise<DiscoveryListResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      if (!isRecord(request) || !isRecord(request.window)) {
        return discoveryFailure(
          'INVALID_REQUEST',
          'A discovery request needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
        )
      }
      const from = request.window.from
      const to = request.window.to
      if (typeof from !== 'string' || typeof to !== 'string') {
        return discoveryFailure(
          'INVALID_REQUEST',
          'A discovery request needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
        )
      }
      const pageSize = typeof request.pageSize === 'number' ? request.pageSize : undefined
      if (request.pageSize !== undefined && typeof request.pageSize !== 'number') {
        return discoveryFailure('INVALID_REQUEST', 'A discovery page size must be a number.')
      }
      if (
        pageSize !== undefined &&
        (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > 100)
      ) {
        return discoveryFailure('INVALID_REQUEST', 'A discovery page size must be from 1 to 100.')
      }
      // The dates' meaning (a real civil date, a window the feed can answer) is
      // the client's own check, and its refusal is the one the user is shown.
      return getDiscoveryClient().listOpportunities({
        window: { from, to },
        ...(pageSize === undefined ? {} : { pageSize: Math.floor(pageSize) }),
      })
    },
  )

  ipcMain.handle(
    TENDERS_CHANNELS.discoveryRefresh,
    async (_e, request: DiscoveryRefreshRequest): Promise<DiscoveryRefreshResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      if (request !== undefined && !isRecord(request)) {
        return discoveryFailure(
          'INVALID_REQUEST',
          'A discovery refresh takes no arguments but a window.',
        )
      }
      const window = isRecord(request) ? request.window : undefined
      if (window !== undefined) {
        if (!isRecord(window) || typeof window.from !== 'string' || typeof window.to !== 'string') {
          return discoveryFailure(
            'INVALID_REQUEST',
            'A discovery refresh needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
          )
        }
        return getDiscoveryClient().refreshCache({ window: { from: window.from, to: window.to } })
      }
      return getDiscoveryClient().refreshCache()
    },
  )

  ipcMain.handle(
    TENDERS_CHANNELS.discoveryReadCache,
    async (_e): Promise<DiscoveryReadCacheResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      // Reads the last successful fetch from disk; no network, so the list is
      // available offline exactly as the local rule engine is.
      return getDiscoveryClient().readCache()
    },
  )

  ipcMain.handle(
    TENDERS_CHANNELS.discoveryRelease,
    async (_e, request: DiscoveryReleaseRequest): Promise<DiscoveryReleaseResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      const ocid = isRecord(request) && typeof request.ocid === 'string' ? request.ocid.trim() : ''
      if (!ocid || ocid.length > 128) {
        return discoveryFailure('INVALID_REQUEST', 'A release lookup needs the tender’s ocid.')
      }
      return getDiscoveryClient().fetchRelease(ocid)
    },
  )

  ipcMain.handle(
    TENDERS_CHANNELS.discoveryDownloadDocument,
    async (_e, request: DiscoveryDownloadDocumentRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      return downloadDiscoveryDocument(request)
    },
  )

  // ── Deadline reminders ─────────────────────────────────────────────────────
  // The schedule itself runs in main (`startTendersReminders`); these three
  // channels are the settings surface and a manual check. `writeSettings` rejects
  // when it could not persist, so that rejection is turned into an honest
  // `ok: false` here rather than being allowed to surface as an opaque IPC error;
  // `readState`/`checkNow` are documented never to reject, and their guards exist
  // so that if one ever did the renderer would still get an answer.

  ipcMain.handle(TENDERS_CHANNELS.remindersGet, async (_e): Promise<RemindersStateResponse> => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const state = await getRemindersScheduler().readState()
      return {
        ok: true,
        settings: state.settings,
        ledger: state.ledger,
        limitation: REMINDERS_RUNTIME_LIMITATION,
      }
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: 'READ_FAILED',
          message:
            error instanceof Error ? error.message : 'The reminder settings could not be read.',
        },
      }
    }
  })

  ipcMain.handle(
    TENDERS_CHANNELS.remindersSet,
    async (_e, settings: RemindersSetRequest): Promise<RemindersSetResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      const validated = validateReminderSettingsPatch(settings)
      if (!validated.ok) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: validated.error } }
      }
      try {
        const written = await getRemindersScheduler().writeSettings(validated.patch)
        return { ok: true, settings: written, limitation: REMINDERS_RUNTIME_LIMITATION }
      } catch (error: unknown) {
        // `writeSettings` rejects when it could not persist, so a caller is never
        // told a lead time was saved when the next check would not honour it.
        return {
          ok: false,
          error: {
            code: 'WRITE_FAILED',
            message: `The reminder settings could not be saved: ${
              error instanceof Error ? error.message : 'the write failed'
            }`,
          },
        }
      }
    },
  )

  ipcMain.handle(TENDERS_CHANNELS.remindersCheck, async (_e): Promise<RemindersCheckResponse> => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const result = await getRemindersScheduler().checkNow()
      // The ledger stays in main: it is the memory that makes each reminder
      // once-only, not something a renderer should be able to write back.
      return { ok: true, fired: result.fired, reminders: result.reminders }
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: 'CHECK_FAILED',
          message:
            error instanceof Error ? error.message : 'The reminder check could not be completed.',
        },
      }
    }
  })

  // ── Diagnostics ────────────────────────────────────────────────────────────
  // The renderer reports a failure main cannot see (a refusal it detected, an
  // extraction that came back empty) and reads back where the log lives. Main
  // owns the bounds and the sink; the renderer can append entries but can never
  // read the log back, so the diagnostics surface is write-only from the UI.
  ipcMain.handle(
    TENDERS_CHANNELS.diagnosticsRecord,
    (_e, request: unknown): RecordDiagnosticsResponse => {
      if (!isTrustedTendersEvent(_e)) {
        return { ok: false, error: 'Sender is not a registered Tenders WebContents.' }
      }
      if (!isRecord(request)) return { ok: false, error: 'A diagnostics entry is required.' }
      const { level, source, message } = request
      if (level !== 'info' && level !== 'warn' && level !== 'error') {
        return { ok: false, error: 'A diagnostics level must be info, warn or error.' }
      }
      if (
        typeof source !== 'string' ||
        source.trim().length === 0 ||
        source.length > MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS
      ) {
        return {
          ok: false,
          error: `A diagnostics source is required and may be at most ${MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS} characters.`,
        }
      }
      if (
        typeof message !== 'string' ||
        message.trim().length === 0 ||
        message.length > MAX_TENDERS_DIAGNOSTIC_MESSAGE_CHARS
      ) {
        return {
          ok: false,
          error: `A diagnostics message is required and may be at most ${MAX_TENDERS_DIAGNOSTIC_MESSAGE_CHARS} characters.`,
        }
      }
      if (request.detail !== undefined && !isRecord(request.detail)) {
        return { ok: false, error: 'Diagnostics detail must be an object when supplied.' }
      }
      const detail = isRecord(request.detail) ? request.detail : null
      if (detail && Object.keys(detail).length > MAX_TENDERS_DIAGNOSTIC_DETAIL_KEYS) {
        return {
          ok: false,
          error: `Diagnostics detail may carry at most ${MAX_TENDERS_DIAGNOSTIC_DETAIL_KEYS} keys.`,
        }
      }
      try {
        getTendersDiagnosticsLog().record({
          level,
          source,
          message,
          ...(detail ? { detail } : {}),
        })
      } catch {
        // The sink never throws by contract; a renderer must not see an exception
        // for a diagnostic that could not be written.
      }
      return { ok: true }
    },
  )

  ipcMain.handle(TENDERS_CHANNELS.diagnosticsPath, (_e): DiagnosticsPathResponse => {
    if (!isTrustedTendersEvent(_e)) {
      return { ok: false, error: 'Sender is not a registered Tenders WebContents.' }
    }
    try {
      return { ok: true, path: tendersDiagnosticsPath() }
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error, 'The diagnostics log path is unavailable.') }
    }
  })

  // Cross-App: Export Compliance Matrix to Sheets
  ipcMain.handle(
    TENDERS_CHANNELS.exportMatrixToSheets,
    (_e, _tenderId: string, tenderTitle: string, matrixRows: any[]) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      try {
        // Bounded before any CSV work: the export writes a temp file, so an
        // unbounded row/cell count would let a caller allocate an arbitrarily
        // large file from a single IPC message.
        if (_tenderId !== undefined && (typeof _tenderId !== 'string' || _tenderId.length > 200)) {
          return { ok: false, error: 'A valid tender id is required.' }
        }
        if (
          tenderTitle !== undefined &&
          (typeof tenderTitle !== 'string' || tenderTitle.length > 500)
        ) {
          return { ok: false, error: 'A valid tender title is required.' }
        }
        if (matrixRows !== undefined && !Array.isArray(matrixRows)) {
          return { ok: false, error: 'matrixRows must be an array.' }
        }
        const matrixRowList = matrixRows ?? []
        if (matrixRowList.length > MAX_TENDERS_MATRIX_EXPORT_ROWS) {
          return {
            ok: false,
            error: `Compliance matrix export is limited to ${MAX_TENDERS_MATRIX_EXPORT_ROWS} rows.`,
          }
        }
        for (const row of matrixRowList) {
          const cells: unknown[] = isRecord(row) ? Object.values(row) : [row]
          for (const value of cells) {
            if (typeof value === 'string' && value.length > MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS) {
              return {
                ok: false,
                error: `A compliance matrix cell exceeds ${MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS} characters.`,
              }
            }
          }
        }
        try {
          const payloadBytes = Buffer.byteLength(
            JSON.stringify({ tenderTitle: tenderTitle ?? '', matrixRows: matrixRowList }),
            'utf8',
          )
          if (payloadBytes > MAX_TENDERS_MATRIX_EXPORT_BYTES) {
            return {
              ok: false,
              error: `Compliance matrix export exceeds ${MAX_TENDERS_MATRIX_EXPORT_BYTES} bytes.`,
            }
          }
        } catch {
          return { ok: false, error: 'The compliance matrix payload cannot be serialized.' }
        }

        const BOM = '\uFEFF'
        const header =
          'Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes\n'
        // RFC 4180 quoting plus spreadsheet formula neutralisation: any cell
        // that begins with = + - @ TAB or CR is prefixed with an apostrophe so
        // a spreadsheet app cannot evaluate it as a formula. The BOM and
        // comma-delimited quoting are unchanged.
        const neutralizeFormula = (value: string): string =>
          /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
        const escapeCsv = (str: unknown): string => {
          if (str === null || str === undefined) return '""'
          const s = neutralizeFormula(String(str)).replace(/"/g, '""')
          return `"${s}"`
        }

        const rows = (matrixRows || [])
          .map((r, idx) => {
            const reqId = escapeCsv(r.id || `REQ-${idx + 1}`)
            const cat = escapeCsv((r.category || 'GENERAL').replace(/_/g, ' '))
            const reqText = escapeCsv(r.title || r.verbatimClause || r.requirementText || '')
            const isMand =
              r.isMandatory !== undefined
                ? Boolean(r.isMandatory)
                : r.mandatory !== undefined
                  ? Boolean(r.mandatory)
                  : r.riskLevel === 'HIGH' || r.riskLevel === 'CRITICAL'
            const mandText = escapeCsv(isMand ? 'Mandatory / Disqualifier' : 'Standard Returnable')
            const status = escapeCsv(r.status || 'UNDER_REVIEW')
            const linkedDoc = escapeCsv(r.linkedVaultDocId || r.linkedDocument || 'None')
            const health = escapeCsv(
              r.healthStatus || (r.linkedVaultDocId ? 'VALID' : 'NO_ATTACHMENT'),
            )
            const notes = escapeCsv(r.notes || r.reason || '')
            return [reqId, cat, reqText, mandText, status, linkedDoc, health, notes].join(',')
          })
          .join('\n')

        const csvContent = BOM + header + rows
        const sanitizedTitle = (tenderTitle || 'Tender').replace(/[^a-zA-Z0-9_-]/g, '_')
        const targetPath = join(
          tmpdir(),
          `${sanitizedTitle}_Compliance_Matrix_${getUniqueTimestamp()}.csv`,
        )
        writeFileSync(targetPath, csvContent, 'utf8')

        if (runtime.openGeneratedPath) {
          runtime.openGeneratedPath(targetPath)
        }
        return { ok: true, path: targetPath }
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Failed to export compliance matrix to Sheets' }
      }
    },
  )

  // Cross-App: Draft Proposal in Docs
  ipcMain.handle(TENDERS_CHANNELS.draftProposalDoc, async (_e, tender: unknown) => {
    if (!isTrustedTendersEvent(_e)) {
      return { ok: false, error: 'Unauthorized Tenders WebContents sender' }
    }
    if (!validProposalPayload(tender)) {
      return { ok: false, error: 'Invalid proposal payload' }
    }
    try {
      // Main owns the canonical readiness snapshot: it resolves the requested
      // tender from the authoritative document (never from renderer-supplied
      // data), assesses company/vault readiness itself, and binds the report to
      // the exact tender id + revision + fingerprint. The generator verifies the
      // binding before it may emit ready language, so a stale or mismatched
      // report cannot clear a proposal.
      const requestedId =
        isRecord(tender) && typeof (tender as { id?: unknown }).id === 'string'
          ? (tender as { id: string }).id
          : ''
      let readinessReport: ReadinessReport | undefined
      let expectedBinding: (Partial<ReadinessBinding> & { required?: boolean }) | undefined
      if (requestedId) {
        const loaded = await getAuthoritativeTendersStore().load()
        if (loaded.ok) {
          const canonical = buildCanonicalReadinessReport(loaded.data, requestedId)
          // Derive the expectation from the requested id + loaded revision, not
          // from the report's own binding (that comparison would be tautological).
          // On any drift the binding is undefined, so the report is also withheld
          // and the generator cannot emit ready language.
          const binding = expectedReadinessBinding({
            requestedTenderId: requestedId,
            loadedRevision: loaded.data.revision,
            canonicalTenderId: canonical.tender?.id ?? '',
            reportBinding: canonical.report?.binding,
          })
          if (canonical.ok && canonical.report && binding) {
            readinessReport = canonical.report
            expectedBinding = binding
          }
        }
      }
      const content = generateProposalMarkdown(tender, { readinessReport, expectedBinding })
      const targetPath = writeGeneratedProposal(content)
      if (runtime.openGeneratedPath) runtime.openGeneratedPath(targetPath)
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to draft proposal in Docs' }
    }
  })

  // Cross-App: Sync with CRM (typed port; Tenders never touches the CRM store)
  ipcMain.handle(TENDERS_CHANNELS.syncWithCrm, async (_e, dealData: any) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const integrations = getIntegrations()
      const upsertTenderOpportunity = integrations.upsertTenderOpportunity
      // Resolve the port BEFORE any side effect: with CRM disabled there is no
      // partial application at all.
      if (!upsertTenderOpportunity) {
        return { ok: false, error: 'CRM integration is not configured.' }
      }

      const authoritativeStore = getAuthoritativeTendersStore()
      const loaded = await authoritativeStore.load()
      if (!loaded.ok) return { ok: false, error: loaded.error.message }

      // Validation (contracts §6 item 2): the caller's expected revision is
      // checked FIRST, before any side effect at all. It used to be read only
      // inside the mutate below — by which point nothing had been written, but
      // the caller's own validation had not run either, so a caller that was
      // simply wrong about the revision still reached the CRM port. A refusal
      // here writes nothing and opens nothing.
      const requestedRevision =
        typeof dealData?.expectedRevision === 'number' ? dealData.expectedRevision : null
      if (requestedRevision !== null && requestedRevision !== loaded.data.revision) {
        return {
          ok: false,
          error:
            `Revision conflict: expected revision ${requestedRevision} but the authoritative ` +
            `document is at revision ${loaded.data.revision}.`,
          currentRevision: loaded.data.revision,
        }
      }

      const payloadTender: TenderRecord | undefined =
        dealData && typeof dealData.tender === 'object'
          ? (dealData.tender as TenderRecord)
          : undefined
      const tenderId =
        (typeof dealData?.tenderId === 'string' && dealData.tenderId) ||
        payloadTender?.id ||
        (typeof dealData?.id === 'string' && dealData.id.startsWith('deal-tender-')
          ? dealData.id.replace('deal-tender-', '')
          : '') ||
        ''

      const resolved = tenderId ? findTenderById(loaded.data, tenderId) : null
      // Main-side demo isolation: never write to CRM from a demonstration
      // workspace, even if the renderer guard were bypassed. Rejection happens
      // before any mutation, so there is no side effect.
      if (resolved?.workspace.dataOrigin === 'demo') {
        return { ok: false, error: TENDERS_DEMO_WRITE_ERROR }
      }
      // Identity and the back-link come from the canonical document; the deal
      // content prefers the renderer's explicit sync payload (its historical
      // contract), falling back to the canonical tender.
      const tender = payloadTender ?? resolved?.tender
      const effectiveTenderId = resolved?.tender.id ?? tenderId

      const deterministicDealId =
        (typeof dealData?.dealId === 'string' && dealData.dealId) ||
        (typeof dealData?.id === 'string' && dealData.id !== effectiveTenderId
          ? dealData.id
          : effectiveTenderId
            ? `deal-tender-${effectiveTenderId}`
            : `deal-tender-${Date.now()}`)

      const refNum =
        tender?.referenceNumber || dealData?.tenderReference || dealData?.referenceNumber || ''
      const rawTitle = tender?.title || dealData?.title || dealData?.name || 'Tender Opportunity'
      const title =
        refNum && rawTitle.startsWith(`${refNum} - `)
          ? rawTitle.replace(`${refNum} - `, '')
          : rawTitle
      const dealName = refNum ? `${refNum} - ${title}` : title
      const companyName =
        tender?.issuingBody || dealData?.companyName || 'Government / Enterprise Buyer'
      const rawAmount =
        typeof tender?.estimatedValue === 'number'
          ? tender.estimatedValue
          : typeof dealData?.amount === 'number' && Number.isFinite(dealData.amount)
            ? dealData.amount
            : 0
      const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0
      const stage = typeof dealData?.stage === 'string' ? dealData.stage : 'proposal'
      const expectedCloseDate =
        tender?.closingDate || dealData?.expectedCloseDate || dealData?.closingDate || undefined
      const notes =
        dealData?.notes ||
        (refNum
          ? `Tender Ref: ${refNum}\nIssuing Authority: ${companyName}`
          : `Issuing Authority: ${companyName}`)

      // The CRM upsert runs first, and the back-link is committed only once it
      // has succeeded. `{ ok: true }` is returned only when BOTH halves are
      // durable: a deal that was written without the back-link leaves the tender
      // still calling itself unsynced, and a caller told "synced" for that is
      // being lied to. The CRM upsert is idempotent (deterministic id), so a
      // retry after a failed back-link reconciles to exactly one deal.
      let dealId = deterministicDealId
      try {
        const upserted = await upsertTenderOpportunity({
          dealId: deterministicDealId,
          tenderId: effectiveTenderId,
          tenderReference: refNum || null,
          name: dealName,
          companyName,
          amount,
          stage,
          expectedCloseDate,
          notes,
        })
        if (!upserted.ok) {
          // The deal was NOT written, so no back-link may be committed: the
          // authoritative document must not claim a sync that did not happen.
          return { ok: false, error: upserted.error || 'CRM upsert failed.' }
        }
        dealId = upserted.dealId || dealId
      } catch (crmError: unknown) {
        // Same reasoning as a refused upsert: the CRM write did not complete, so
        // the tender must not be back-linked and the caller must not be told the
        // sync succeeded. The deterministic deal id makes a retry safe.
        return {
          ok: false,
          dealId: deterministicDealId,
          error: crmError instanceof Error ? crmError.message : String(crmError),
        }
      }

      // The CRM write is done; commit the back-link now, against the revision the
      // authority is actually at. A conflict here is reported as a failure — the
      // deal exists and the retry is idempotent.
      if (resolved && dealId !== resolved.tender.linkedCrmDealId) {
        const committed = await authoritativeStore.mutate(loaded.data.revision, (document) => {
          const target = findTenderById(document, resolved.tender.id)
          if (target) target.tender.linkedCrmDealId = dealId
          return document
        })
        if (!committed.ok) {
          return {
            ok: false,
            dealId,
            error:
              `The CRM deal was saved, but the tender could not be linked to it ` +
              `(${committed.error.message}). Retrying is safe.`,
            currentRevision: committed.current?.revision ?? committed.error.current?.revision,
          }
        }
      }

      return { ok: true, dealId }
    } catch (e: any) {
      return { ok: false, error: e?.message }
    }
  })

  // Cross-App: Record tender outcome on the CRM opportunity (typed port)
  ipcMain.handle(TENDERS_CHANNELS.updateTenderOutcome, async (_e, request: any) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const tenderId = typeof request?.tenderId === 'string' ? request.tenderId : ''
      const outcome = request?.outcome
      if (!tenderId) return { ok: false, error: 'A tender id is required.' }
      if (
        outcome !== 'won' &&
        outcome !== 'lost' &&
        outcome !== 'withdrawn' &&
        outcome !== 'cancelled'
      ) {
        return { ok: false, error: `Unknown tender outcome: ${String(outcome)}` }
      }
      const updateTenderOutcome = getIntegrations().updateTenderOutcome
      if (!updateTenderOutcome) {
        return { ok: false, error: 'CRM integration is not configured.' }
      }
      const loaded = await getAuthoritativeTendersStore().load()
      if (!loaded.ok) return { ok: false, error: loaded.error.message }
      const resolved = findTenderById(loaded.data, tenderId)
      if (!resolved) return { ok: false, error: `Tender not found: ${tenderId}` }
      const dealId =
        (typeof request?.dealId === 'string' && request.dealId) ||
        resolved.tender.linkedCrmDealId ||
        `deal-tender-${tenderId}`
      const result = await updateTenderOutcome({
        dealId,
        tenderId,
        outcome,
        amount: typeof request?.amount === 'number' ? request.amount : undefined,
        reason: typeof request?.reason === 'string' ? request.reason : undefined,
        noticeDate: typeof request?.noticeDate === 'string' ? request.noticeDate : undefined,
      })
      return result
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to record tender outcome' }
    }
  })

  ipcMain.handle(TENDERS_CHANNELS.openInCrm, (_e, dealId) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    const integrations = getIntegrations()
    if (integrations.openAppAt || runtime.onOpenCrm) {
      openOwningApp({ app: 'crm', entityId: typeof dealId === 'string' ? dealId : undefined })
      return { ok: true }
    }
    return { ok: false }
  })

  // Cross-App: Open Books tab
  ipcMain.handle(TENDERS_CHANNELS.openBooks, (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (getIntegrations().openAppAt || runtime.onOpenBooks) {
      openOwningApp({ app: 'books' })
      return true
    }
    return false
  })

  // Cross-App: Bill Milestone in Zano Books
  ipcMain.handle(
    TENDERS_CHANNELS.billMilestoneInBooks,
    async (
      _e,
      tenderIdOrPayload: string | BillMilestoneRequest,
      milestoneIdArg?: string,
    ): Promise<BillMilestoneResult | { ok: false; error: TendersPersistenceError }> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      try {
        let tenderId: string
        let milestoneId: string
        let tenderReference: string | undefined
        let customAmount: number | undefined
        let customNotes: string | undefined
        let expectedRevision: number | undefined

        if (typeof tenderIdOrPayload === 'object' && tenderIdOrPayload !== null) {
          tenderId = tenderIdOrPayload.tenderId
          milestoneId = tenderIdOrPayload.milestoneId
          tenderReference = tenderIdOrPayload.tenderReference
          customAmount = tenderIdOrPayload.amount
          customNotes = tenderIdOrPayload.notes
          expectedRevision = tenderIdOrPayload.expectedRevision
        } else {
          tenderId = String(tenderIdOrPayload || '')
          milestoneId = String(milestoneIdArg || '')
        }

        const issueMilestoneInvoice = getIntegrations().issueMilestoneInvoice
        if (!issueMilestoneInvoice) {
          return { ok: false, error: 'Books integration is not configured.' }
        }

        const authoritativeStore = getAuthoritativeTendersStore()
        const loadedTenders = await authoritativeStore.load()
        if (!loadedTenders.ok) return { ok: false, error: loadedTenders.error.message }
        const tendersData = loadedTenders.data

        const located =
          (tenderId ? findTenderById(tendersData, tenderId) : null) ??
          (() => {
            if (!tenderReference) return null
            for (const workspace of tendersData.workspaces) {
              const tender = workspace.tenders.find(
                (candidate) => candidate.referenceNumber === tenderReference,
              )
              if (tender) return { workspace, tender }
            }
            return null
          })()

        if (!located) {
          return {
            ok: false,
            error: `Tender not found: ${tenderId || tenderReference || 'unknown'}`,
          }
        }

        const foundTender = located.tender
        // Main-side demo isolation: a demonstration workspace may never raise an
        // invoice. Rejected before any reservation/side effect.
        if (located.workspace.dataOrigin === 'demo') {
          return { ok: false, error: TENDERS_DEMO_WRITE_ERROR }
        }
        const foundMilestone: ContractMilestone | undefined = foundTender.milestones?.find(
          (candidate) => candidate.id === milestoneId,
        )
        if (!foundMilestone) {
          return { ok: false, error: `Milestone not found: ${milestoneId}` }
        }

        const billingIdempotencyKey = `tender-milestone-${foundTender.id}-${foundMilestone.id}`

        // Already billed (e.g. a retry after a lost response): idempotent
        // success. Never post a second invoice. This reconciliation path is
        // exempt from the won gate below so a retry cannot double-post.
        if (foundMilestone.status === 'BILLED' || foundMilestone.billedInvoiceId) {
          return {
            ok: true,
            reconciled: true,
            invoiceId: foundMilestone.billedInvoiceId,
            invoiceNumber: foundMilestone.billedInvoiceNumber,
          }
        }

        // Won-only gating (mirrors shared/lifecycle `milestonesAllowed`): a
        // tender that is not won must not expose or raise milestone billing.
        if (foundMilestone.status !== 'REACHED') {
          return {
            ok: false,
            error: `Milestone is not reached. Current status: ${foundMilestone.status} (Milestone is not in REACHED status)`,
          }
        }

        if (!milestonesAllowed(foundTender.status)) {
          return { ok: false, error: tendersNotWonBillingError(foundTender.status) }
        }

        // The invoice amount is derived from the canonical milestone only, so a
        // caller cannot raise an invoice for an arbitrary amount on a won
        // tender. A supplied `amount` is a compatibility echo and must match the
        // milestone exactly; a mismatch is rejected rather than billed.
        const canonicalAmount = Number(foundMilestone.amount ?? 0)
        if (customAmount !== undefined) {
          const requestedAmount = Number(customAmount)
          if (!Number.isFinite(requestedAmount) || requestedAmount !== canonicalAmount) {
            return {
              ok: false,
              error: `The requested billing amount (${String(customAmount)}) does not match the milestone amount (${canonicalAmount}); the milestone amount is authoritative.`,
            }
          }
        }
        const billAmount = canonicalAmount
        if (billAmount <= 0) {
          return {
            ok: false,
            error: `Milestone billing amount must be greater than 0: ${billAmount}`,
          }
        }

        // Pre-post revision validation: `mutate` with an unchanged document is a
        // revision check, not a write (the store returns ok without committing),
        // so this is NOT a reservation. It does guarantee that a stale caller
        // posts zero invoices; a competing writer that moves the revision between
        // this check and the link commit is reconciled below, and the Books
        // idempotency key keeps it to at most one invoice.
        const reservationRevision = expectedRevision ?? tendersData.revision
        const reservation = await authoritativeStore.mutate(
          reservationRevision,
          (document) => document,
        )
        if (!reservation.ok) {
          return {
            ok: false,
            error: reservation.error.message,
            currentRevision: reservation.current?.revision ?? reservation.error.current?.revision,
          }
        }

        // Invoice identity comes from the canonical tender/milestone, never from
        // the caller: the party, the reference and the line description must not
        // be settable from a renderer payload.
        const issuer = foundTender.issuingBody || 'Issuing authority not recorded'
        const today = new Date().toISOString().split('T')[0]
        const dueDate =
          foundMilestone.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
        const ref = foundTender.referenceNumber || foundTender.id
        const mName = foundMilestone.name || foundMilestone.title || 'Delivery Milestone'
        const itemDescription = `${mName} per ${ref}`

        // Single posting path via the typed port; Books owns party resolution,
        // VAT-inclusive pricing, numbering, journal posting and persistence.
        // `billingIdempotencyKey` makes the post retry-safe.
        const invoice = await issueMilestoneInvoice({
          tenderId: foundTender.id,
          milestoneId: foundMilestone.id,
          idempotencyKey: billingIdempotencyKey,
          partyName: issuer,
          itemDescription,
          itemCode: 'TENDER-PROGRESS',
          accountId: 'acc-sales',
          accountName: 'Tender & Commercial Contracting Sales',
          amount: billAmount,
          tenderReference: ref,
          notes: customNotes || 'Payment terms: 30 days net from tax invoice submission.',
          date: today,
          dueDate,
        })

        if (!invoice.ok || !invoice.invoiceId) {
          return { ok: false, error: invoice.error || 'Failed to bill milestone in Books' }
        }

        const invoiceId = invoice.invoiceId
        const invoiceNumber = invoice.invoiceNumber

        const applyBilling = (document: TendersDataV2, at: string): void => {
          const target = findTenderById(document, foundTender.id)
          const milestone = target?.tender.milestones?.find(
            (candidate) => candidate.id === foundMilestone.id,
          )
          if (!milestone) return
          milestone.status = 'BILLED'
          milestone.billedInvoiceId = invoiceId
          milestone.billedInvoiceNumber = invoiceNumber
          milestone.billedAt = at
          milestone.billedDate = at
        }

        const nowIso = new Date().toISOString()
        let committed = await authoritativeStore.mutate(reservationRevision, (document) => {
          applyBilling(document, nowIso)
          return document
        })
        let reconciled = false
        let warning: string | undefined

        if (!committed.ok) {
          // Reconcile: a competing writer may already have billed this
          // milestone, or the revision moved. Reload once and either adopt the
          // existing billing or retry the link exactly once with the fresh
          // revision. The invoice already exists (and is deduped by key), so a
          // retry can never double-post.
          let latest = committed.current
          if (!latest) {
            const reloaded = await authoritativeStore.load()
            if (reloaded.ok) latest = reloaded.data
          }
          const latestData = latest ?? tendersData
          const latestTarget = findTenderById(latestData, foundTender.id)
          const latestMilestone = latestTarget?.tender.milestones?.find(
            (candidate) => candidate.id === foundMilestone.id,
          )
          if (latestMilestone?.status === 'BILLED' || latestMilestone?.billedInvoiceId) {
            reconciled = true
            warning = 'Milestone was already billed; reused the existing invoice.'
          } else {
            const retry = await authoritativeStore.mutate(latestData.revision, (document) => {
              applyBilling(document, nowIso)
              return document
            })
            if (retry.ok) {
              committed = retry
            } else {
              // The invoice exists (deduped by key), but this call could not
              // commit the tender link. Report failure so the UI surfaces the
              // retry; the retry reconciles without double-posting.
              return {
                ok: false,
                error:
                  'Invoice posted; the milestone link could not be committed. Retry to reconcile the tender.',
                invoiceId,
                invoiceNumber,
                tenderReference: ref,
                currentRevision: retry.current?.revision ?? latestData.revision,
              }
            }
          }
        }

        // Open the owning app at the returned invoice.
        openOwningApp({ app: 'books', entityId: invoiceId })

        return {
          ok: true,
          invoiceNumber,
          invoiceId,
          tenderReference: ref,
          grandTotal: invoice.grandTotal,
          subtotal: invoice.subtotal,
          taxTotal: invoice.taxTotal,
          ...(reconciled ? { reconciled: true } : {}),
          ...(warning ? { warning } : {}),
        }
      } catch (err: any) {
        return {
          ok: false,
          error: err?.message || 'Failed to bill milestone in Books',
        }
      }
    },
  )
  markTendersIpcRegistered()
}

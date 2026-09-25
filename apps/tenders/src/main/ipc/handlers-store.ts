// The store channels: the authoritative v2 load/save pair, the shell's
// dirty-close reply, the retired-but-served legacy read (and its write twin),
// and the compliance-matrix CSV export.
//
// What holds these six together is that they are the only channels that touch
// the AUTHORITATIVE DOCUMENT or the legacy v1 file on it, and that both write
// paths go through the same store lock, revision check and atomic write. Split
// out of `ipc/handlers.ts` with no behaviour change; the store those two paths
// share is reached through `store-registry`, never re-implemented here.
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_TENDERS_MATRIX_EXPORT_BYTES,
  MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS,
  MAX_TENDERS_MATRIX_EXPORT_ROWS,
  TENDERS_CHANNELS,
} from '../../shared/ipc'
import {
  MAX_TENDERS_IPC_PAYLOAD_BYTES,
  type SaveTendersRequest,
} from '../../shared/tenders-persistence'
import { validateTendersDataV2 } from '../../shared/tenders-schema'
import { isRecord } from '../readiness-snapshot'
import { recordDiagnostic } from '../diagnostics-sink'
import { readTendersStore, LEGACY_TENDERS_READ_FAILED } from '../legacy-store'
import { getUniqueTimestamp } from '../tenders-paths'
import { authoritativeStore as getAuthoritativeTendersStore } from '../store-registry'
import { isTrustedTendersEvent, unauthorizedTendersRequest } from './trust'
import type { TendersIpcRegistry } from './handler-context'
import {
  getStoragePath,
  listLegacyRecoveryCandidates,
  noteLegacyReadFailure,
  runtime,
  closeFlushWaiters,
} from '../composition-services'

export function registerTendersStoreChannels(ipc: TendersIpcRegistry): void {
  ipc.handle(TENDERS_CHANNELS.loadStoreV2, async (_e) => {
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

  ipc.handle(TENDERS_CHANNELS.saveStoreV2, async (_e, request: SaveTendersRequest) => {
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
  ipc.handle(TENDERS_CHANNELS.closeFlushResult, async (_e, payload: unknown) => {
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
  ipc.handle(TENDERS_CHANNELS.getStoredData, async (_e) => {
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
  ipc.handle(TENDERS_CHANNELS.saveStoredData, async (_e, json: string) => {
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

  // Cross-App: Export Compliance Matrix to Sheets
  ipc.handle(
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
}

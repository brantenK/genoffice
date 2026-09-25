// The diagnostics channels: the renderer's failure report and the log's path.
//
// Split out of `ipc/handlers.ts` with no behaviour change. The renderer reports a
// failure main cannot see (a refusal it detected, an extraction that came back
// empty) and reads back where the log lives. Main owns the bounds and the sink;
// the renderer can append entries but can never read the log back, so the
// diagnostics surface is write-only from the UI.
import {
  MAX_TENDERS_DIAGNOSTIC_DETAIL_KEYS,
  MAX_TENDERS_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS,
  TENDERS_CHANNELS,
  type DiagnosticsPathResponse,
  type RecordDiagnosticsResponse,
} from '../../shared/ipc'
import { isRecord } from '../readiness-snapshot'
import { errorMessage } from '../main-utils'
import { getTendersDiagnosticsLog, tendersDiagnosticsPath } from '../diagnostics-sink'
import { isTrustedTendersEvent } from './trust'
import type { TendersIpcRegistry } from './handler-context'

export function registerTendersDiagnosticsChannels(ipc: TendersIpcRegistry): void {
  ipc.handle(
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

  ipc.handle(TENDERS_CHANNELS.diagnosticsPath, (_e): DiagnosticsPathResponse => {
    if (!isTrustedTendersEvent(_e)) {
      return { ok: false, error: 'Sender is not a registered Tenders WebContents.' }
    }
    try {
      return { ok: true, path: tendersDiagnosticsPath() }
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error, 'The diagnostics log path is unavailable.') }
    }
  })
}

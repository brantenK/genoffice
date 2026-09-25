// The deadline-reminder channels: the settings surface and a manual check.
//
// Split out of `ipc/handlers.ts` with no behaviour change. The schedule itself
// runs in main (`startTendersReminders` in `./engines`); these three channels are
// what the renderer can read and change. `writeSettings` rejects when it could not
// persist, so that rejection is turned into an honest `ok: false` here rather
// than being allowed to surface as an opaque IPC error; `readState`/`checkNow`
// are documented never to reject, and their guards exist so that if one ever did
// the renderer would still get an answer.
import {
  TENDERS_CHANNELS,
  type RemindersCheckResponse,
  type RemindersSetRequest,
  type RemindersSetResponse,
  type RemindersStateResponse,
} from '../../shared/ipc'
import { REMINDERS_RUNTIME_LIMITATION } from '../reminders-scheduler'
import { getRemindersScheduler, validateReminderSettingsPatch } from './engines'
import { isTrustedTendersEvent, unauthorizedTendersRequest } from './trust'
import type { TendersIpcRegistry } from './handler-context'

export function registerTendersReminderChannels(ipc: TendersIpcRegistry): void {
  ipc.handle(TENDERS_CHANNELS.remindersGet, async (_e): Promise<RemindersStateResponse> => {
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

  ipc.handle(
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

  ipc.handle(TENDERS_CHANNELS.remindersCheck, async (_e): Promise<RemindersCheckResponse> => {
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
}

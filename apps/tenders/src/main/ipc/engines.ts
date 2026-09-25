// The two wired engines: the tender-discovery client and the deadline-reminder
// scheduler — their construction, their lifecycle, and the one document download
// that bridges them.
//
// Split out of `main/tenders-main.ts` with no behaviour change. Both engines are
// complete and tested on their own; what this module adds is the transport and the
// lifecycle. Three rules shape it:
//
//  * **The renderer never names a network target.** The discovery client is
//    built here with the app's own cache directory, and a document link from the
//    feed is re-checked with the client's allow-list (`isAllowedDiscoveryUrl`)
//    before anything is requested.
//  * **A downloaded document becomes an ordinary managed document.** It is
//    written through the same managed-document store the RFP upload path uses
//    (`saveDocumentFile` in `document-lifecycle.ts`), so it lands in `documents/`
//    with durable metadata and the renderer can read, open and delete it with the
//    channels that already exist. There is deliberately no second storage
//    location.
//  * **Every side effect is injectable.** `setTendersEngineOverrides` swaps the
//    client factory, the scheduler factory, the download's fetch, the clock and
//    the notifier, so the whole IPC surface is provable with no network, no disk
//    and no waiting. Production never calls it.
import { app } from 'electron'
import {
  MAX_DISCOVERY_DOCUMENT_FILE_NAME_CHARS,
  MAX_DISCOVERY_DOCUMENT_URL_CHARS,
  MAX_DISCOVERY_DOWNLOAD_BYTES,
  type DiscoveryDownloadDocumentRequest,
  type DiscoveryDownloadDocumentResponse,
  type TendersIpcFailure,
} from '../../shared/ipc'
import { isAllowedDiscoveryUrl, DISCOVERY_ALLOWED_HOSTS } from '../../shared/discovery'
import type { ReminderSettings, ReminderTender } from '../../shared/reminders'
import type { TendersDataV2 } from '../../shared/types'
import {
  MAX_TENDERS_REMINDER_LABEL_CHARS,
  MAX_TENDERS_REMINDER_LEAD_MS,
  MAX_TENDERS_REMINDER_THRESHOLDS,
} from '../../shared/ipc'
import {
  createDiscoveryClient,
  discoveryCacheDir,
  type DiscoveryClient,
  type DiscoveryClientOptions,
  type DiscoveryFetch,
  type DiscoveryFetchInit,
  type DiscoveryHttpResponse,
} from '../discovery-client'
import {
  createRemindersScheduler,
  type ReminderLog,
  type ReminderNotifier,
  type RemindersScheduler,
  type RemindersSchedulerOptions,
} from '../reminders-scheduler'
import { recordDiagnostic } from '../diagnostics-sink'
import type { DiagnosticsLog } from '../diagnostics-log'
import { isRecord } from '../readiness-snapshot'
import { managedDocumentStore, authoritativeStore } from '../store-registry'

/** The slice of a `Response` the document download uses (a superset of the client's). */
export interface DiscoveryDocumentResponse extends DiscoveryHttpResponse {
  /** Present on a real `Response`: the byte-exact fallback for a streamless one. */
  arrayBuffer?(): Promise<ArrayBuffer>
}

export type DiscoveryDocumentFetch = (
  url: string,
  init?: DiscoveryFetchInit,
) => Promise<DiscoveryDocumentResponse>

/** The real network, assignable to `DiscoveryDocumentFetch` (the typecheck proves it). */
const defaultDiscoveryDocumentFetch: DiscoveryDocumentFetch = (url, init) =>
  globalThis.fetch(url, init)

/** How long one document download may take. Mirrors the client's per-request bound. */
export const DISCOVERY_DOWNLOAD_TIMEOUT_MS = 45_000

/** Redirect hops followed while downloading, each re-checked against the allow-list. */
export const DISCOVERY_DOWNLOAD_MAX_REDIRECTS = 3

/**
 * The injected seams for the two engines. Every field is optional and the
 * defaults are the real thing, so production passes nothing and the tests can
 * replace exactly what they need to observe.
 */
export interface TendersEngineOverrides {
  /** The network the discovery client uses. */
  discoveryFetch?: DiscoveryFetch
  /** The network the document download uses. */
  documentFetch?: DiscoveryDocumentFetch
  /** Builds the discovery client (defaults to `createDiscoveryClient`). */
  createDiscoveryClient?: (options: DiscoveryClientOptions) => DiscoveryClient
  /** Builds the reminder scheduler (defaults to `createRemindersScheduler`). */
  createRemindersScheduler?: (options: RemindersSchedulerOptions) => RemindersScheduler
  /** Replaces the OS notifier (defaults to the Electron `Notification`). */
  reminderNotifier?: ReminderNotifier
  /** Replaces the reminder log hook (defaults to this app's console log). */
  reminderLog?: ReminderLog
  /** The clock the client and the scheduler read (defaults to the real one). */
  now?: () => Date
  /** Where the discovery client keeps its cache (defaults to the app's userData). */
  discoveryCacheDir?: string
  /** The scheduler's `userDataDir` (defaults to the app's userData). */
  remindersUserDataDir?: string
  /** Replaces the diagnostics sink (defaults to the real rotating file). */
  diagnosticsLog?: DiagnosticsLog
}

let engineOverrides: TendersEngineOverrides = {}
const discoveryClients = new Map<string, DiscoveryClient>()
let remindersScheduler: RemindersScheduler | null = null

/**
 * Replace (or clear) the engine seams. A client or a schedule built from the
 * previous seams is dropped rather than reused: mixing them would make the
 * transport unreproducible in exactly the tests this seam exists for.
 */
export function setTendersEngineOverrides(overrides: TendersEngineOverrides | null): void {
  engineOverrides = overrides ?? {}
  discoveryClients.clear()
  stopTendersReminders()
  remindersScheduler = null
}

/**
 * The app's reminder log. The scheduler reports every dropped notification and
 * every unreadable state file through this hook, so passing it is what keeps
 * "the platform could not show this" visible instead of silent.
 *
 * It now goes to the diagnostics file as well as the console. A reminder that
 * never reached the user is exactly the kind of contained failure a support
 * engineer needs to see afterwards, and `console.warn` on a packaged build is
 * read by nobody.
 */
const defaultReminderLog: ReminderLog = (event) => {
  const subject = [event.tenderId, event.thresholdId].filter(Boolean).join(' ')
  const line = `tenders-main: reminders: ${event.message}${subject ? ` (${subject})` : ''}`
  if (event.level === 'warn') console.warn(line)
  else console.info(line)
  recordDiagnostic(event.level === 'warn' ? 'warn' : 'info', 'reminders', event.message, {
    ...(event.tenderId ? { tenderId: event.tenderId } : {}),
    ...(event.thresholdId ? { thresholdId: event.thresholdId } : {}),
  })
}

/** The discovery client for this app's data directory (memoised per cache dir). */
export function getDiscoveryClient(): DiscoveryClient {
  const cacheDir = engineOverrides.discoveryCacheDir ?? discoveryCacheDir(app.getPath('userData'))
  const existing = discoveryClients.get(cacheDir)
  if (existing) return existing
  const build = engineOverrides.createDiscoveryClient ?? createDiscoveryClient
  const client = build({
    cacheDir,
    ...(engineOverrides.discoveryFetch ? { fetchImpl: engineOverrides.discoveryFetch } : {}),
    ...(engineOverrides.now ? { now: engineOverrides.now } : {}),
  })
  discoveryClients.set(cacheDir, client)
  return client
}

/**
 * The authoritative tender list the schedule reads — resolved from the store
 * main owns, never from a renderer payload or a caller-supplied path. A load
 * that fails throws, so the scheduler reports "the tender list could not be
 * read" rather than mistaking an unreadable store for an empty one.
 */
async function readReminderTenders(): Promise<ReminderTender[]> {
  const loaded = await authoritativeStore().load()
  if (!loaded.ok) throw new Error(loaded.error.message)
  const tenders: ReminderTender[] = []
  for (const workspace of loaded.data.workspaces) {
    for (const tender of workspace.tenders) {
      tenders.push({
        id: tender.id,
        title: tender.title,
        closingDate: tender.closingDate,
        status: tender.status,
      })
    }
  }
  return tenders
}

export function getRemindersScheduler(): RemindersScheduler {
  if (remindersScheduler) return remindersScheduler
  const build = engineOverrides.createRemindersScheduler ?? createRemindersScheduler
  remindersScheduler = build({
    userDataDir: engineOverrides.remindersUserDataDir ?? app.getPath('userData'),
    readTenders: readReminderTenders,
    log: engineOverrides.reminderLog ?? defaultReminderLog,
    ...(engineOverrides.reminderNotifier ? { notify: engineOverrides.reminderNotifier } : {}),
    ...(engineOverrides.now ? { now: engineOverrides.now } : {}),
  })
  return remindersScheduler
}

let remindersQuitHookRegistered = false

/**
 * Stop the schedule when the process is really going away, so no timer outlives
 * the app. `will-quit` rather than `before-quit`: the shell's dirty-document
 * close flow can cancel `before-quit`, and a cancelled quit must not silently
 * end reminders.
 */
export function registerRemindersQuitHook(): void {
  if (remindersQuitHookRegistered) return
  if (typeof (app as { on?: unknown }).on !== 'function') return
  remindersQuitHookRegistered = true
  app.on('will-quit', () => stopTendersReminders())
}

/**
 * Start the deadline schedule. Called from `registerTendersIpc` — the same hook
 * that starts the store watcher — so the store is available before the first
 * check reads it. `start()` is idempotent and runs one check immediately, which
 * is what surfaces a deadline that fell due while the app was closed.
 *
 * The schedule is tied to the PROCESS, not to a window: it keeps running while
 * the app runs even if the user closes the Tenders tab, which is what lets a
 * deadline warning arrive while they are working elsewhere. `will-quit` is what
 * ends it (see `registerRemindersQuitHook`), and closing the app is the one
 * thing that does stop it — the scheduler's own `REMINDERS_RUNTIME_LIMITATION`
 * sentence states that to the user.
 */
export function startTendersReminders(): void {
  registerRemindersQuitHook()
  getRemindersScheduler().start()
}

/** Stop the schedule. Idempotent; safe to call when nothing was ever started. */
export function stopTendersReminders(): void {
  remindersScheduler?.stop()
}

// ── the document download ────────────────────────────────────────────────────

type DocumentBodyRead =
  { ok: true; bytes: Buffer } | { ok: false; reason: 'too-large' | 'unreadable' }

/**
 * Read a document body, refusing it the moment it passes `maxBytes` rather than
 * after it has all been buffered — a cap that only measures is not a cap. The
 * stream is preferred (a real `Response` always exposes one); a streamless
 * response falls back to its own bytes, and one with neither is refused rather
 * than decoded as text, because decoding a PDF as text would corrupt it.
 */
async function readCappedDocumentBody(
  response: DiscoveryDocumentResponse,
  maxBytes: number,
): Promise<DocumentBodyRead> {
  const reader = response.body?.getReader?.()
  if (reader) {
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        total += value.byteLength
        if (total > maxBytes) {
          try {
            await reader.cancel?.()
          } catch {
            // A body already being refused needs no polite close.
          }
          return { ok: false, reason: 'too-large' }
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock?.()
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { ok: true, bytes: Buffer.from(merged) }
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) return { ok: false, reason: 'too-large' }
    return { ok: true, bytes: Buffer.from(buffer) }
  }
  return { ok: false, reason: 'unreadable' }
}

/** Resolve a `Location` header against the URL that sent it, or null. */
function resolveDocumentRedirect(base: string, location: string): string | null {
  try {
    return new URL(location, base).toString()
  } catch {
    return null
  }
}

/**
 * The name a downloaded document is stored under. The caller's name wins when it
 * gave a usable one; otherwise the last segment of the link. Either way the
 * managed store sanitizes and clamps it (`sanitizeManagedFileName`), so nothing
 * here can put a path or an over-long name on disk.
 */
export function discoveryDocumentFileName(url: string, provided?: string): string {
  const claimed = typeof provided === 'string' ? provided.trim() : ''
  if (claimed) return claimed
  try {
    const segments = new URL(url).pathname.split('/').filter((segment) => segment.length > 0)
    const last = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]).trim() : ''
    if (last) return last
  } catch {
    // The link was validated before this point; an unreadable one has no name.
  }
  return 'tender-document'
}

export function discoveryFailure(
  code: string,
  message: string,
  extra: { url?: string; status?: number } = {},
): TendersIpcFailure {
  return { ok: false, error: { code, message, ...extra } }
}

const tooLargeDocumentMessage = (): string =>
  `The tender document is larger than the ${MAX_DISCOVERY_DOWNLOAD_BYTES} bytes this app will store, so it was not downloaded.`

/**
 * Download one tender document from the feed and store it as a managed document.
 *
 * The link comes from the renderer, so it is treated as hostile input: it is
 * re-checked against the discovery allow-list (https, exact Treasury host, no
 * embedded credentials) BEFORE any request, redirects are followed manually and
 * re-checked one hop at a time, the body is capped while it is read, and the
 * whole request has a timeout. What lands on disk is an ordinary managed
 * document, saved through the same store the RFP upload path uses.
 */
export async function downloadDiscoveryDocument(
  req: DiscoveryDownloadDocumentRequest,
  overrideUserData?: string,
): Promise<DiscoveryDownloadDocumentResponse> {
  if (!isRecord(req)) {
    return discoveryFailure(
      'INVALID_REQUEST',
      'A document download needs the tender document link to fetch.',
    )
  }
  const url = typeof req.url === 'string' ? req.url.trim() : ''
  if (!url || url.length > MAX_DISCOVERY_DOCUMENT_URL_CHARS) {
    return discoveryFailure(
      'INVALID_REQUEST',
      'A document download needs the tender document link to fetch.',
    )
  }
  const claimedName = typeof req.fileName === 'string' ? req.fileName.trim() : ''
  if (claimedName.length > MAX_DISCOVERY_DOCUMENT_FILE_NAME_CHARS) {
    return discoveryFailure(
      'INVALID_REQUEST',
      `A stored document name may be at most ${MAX_DISCOVERY_DOCUMENT_FILE_NAME_CHARS} characters.`,
    )
  }
  // Before the network, and before any disk work: the renderer may name a link,
  // but only an https URL on a Treasury host this app already reads is ever
  // requested. A plain-http link, a `file:` URL, a look-alike host such as
  // `ocds-api.etenders.gov.za.evil.example`, and a URL carrying credentials are
  // all refused here with nothing fetched.
  if (!isAllowedDiscoveryUrl(url)) {
    return discoveryFailure(
      'BLOCKED_URL',
      `Only tender documents on ${DISCOVERY_ALLOWED_HOSTS.join(', ')} can be downloaded, so that address was not requested.`,
      { url },
    )
  }

  const fetchImpl = engineOverrides.documentFetch ?? defaultDiscoveryDocumentFetch
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, DISCOVERY_DOWNLOAD_TIMEOUT_MS)

  try {
    let target = url
    let redirects = 0
    for (;;) {
      const response = await fetchImpl(target, {
        signal: controller.signal,
        headers: { accept: 'application/pdf, application/octet-stream, */*' },
        redirect: 'manual',
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location') ?? null
        const next = location === null ? null : resolveDocumentRedirect(target, location)
        if (
          next === null ||
          !isAllowedDiscoveryUrl(next) ||
          redirects >= DISCOVERY_DOWNLOAD_MAX_REDIRECTS
        ) {
          return discoveryFailure(
            'BLOCKED_URL',
            'The eTenders host redirected this document somewhere this app is not allowed to read, so nothing was downloaded.',
            { url: target, status: response.status },
          )
        }
        redirects += 1
        target = next
        continue
      }
      if (!(response.status >= 200 && response.status < 300)) {
        return discoveryFailure(
          'HTTP_STATUS',
          `The eTenders host refused this document with status ${response.status}.`,
          { url: target, status: response.status },
        )
      }
      const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
      if (Number.isFinite(declared) && declared > MAX_DISCOVERY_DOWNLOAD_BYTES) {
        return discoveryFailure('RESPONSE_TOO_LARGE', tooLargeDocumentMessage(), { url: target })
      }
      const body = await readCappedDocumentBody(response, MAX_DISCOVERY_DOWNLOAD_BYTES)
      if (!body.ok) {
        return body.reason === 'too-large'
          ? discoveryFailure('RESPONSE_TOO_LARGE', tooLargeDocumentMessage(), { url: target })
          : discoveryFailure(
              'NETWORK',
              'The eTenders host sent a document this app could not read, so nothing was saved.',
              { url: target },
            )
      }
      if (body.bytes.byteLength === 0) {
        return discoveryFailure(
          'MALFORMED_BODY',
          'The eTenders host answered this document link with nothing, so no document was saved.',
          { url: target },
        )
      }
      const bytes = body.bytes
      const saved = await managedDocumentStore(overrideUserData).save({
        fileName: discoveryDocumentFileName(target, claimedName),
        buffer: bytes,
        category: 'rfp',
      })
      if (!saved.ok) {
        return discoveryFailure(
          'CACHE_WRITE',
          `The document was downloaded but could not be saved into the tender document store: ${saved.error}`,
          { url: target },
        )
      }
      return {
        ok: true,
        record: saved.record,
        storedPath: saved.record.relativePath,
        fileName: saved.record.fileName,
        mimeType: saved.record.mimeType,
        byteLength: bytes.byteLength,
        buffer: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      }
    }
  } catch {
    return timedOut
      ? discoveryFailure(
          'TIMEOUT',
          `The eTenders host did not answer within ${Math.round(DISCOVERY_DOWNLOAD_TIMEOUT_MS / 1000)} seconds, so nothing was saved.`,
          { url },
        )
      : discoveryFailure(
          'NETWORK',
          'The eTenders host could not be reached, so nothing was saved.',
          { url },
        )
  } finally {
    clearTimeout(timer)
  }
}

// ── the reminder settings patch ──────────────────────────────────────────────

type ReminderSettingsPatch =
  { ok: true; patch: Partial<ReminderSettings> } | { ok: false; error: string }

/**
 * Validate a settings patch from the renderer. `normalizeReminderSettings` drops
 * unusable entries rather than refusing them, which is right for a file this app
 * wrote and wrong for a payload it was handed: a silently dropped threshold
 * would let a user believe a lead time was set when it was not. So an unusable
 * patch is refused whole, with a reason. Unknown keys are ignored, exactly as
 * `writeSettings` ignores them: a partial write changes what it names.
 */
export function validateReminderSettingsPatch(value: unknown): ReminderSettingsPatch {
  if (!isRecord(value)) {
    return { ok: false, error: 'A reminder settings change must be an object.' }
  }
  const patch: Partial<ReminderSettings> = {}
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      return { ok: false, error: 'Reminders can only be switched on or off with true or false.' }
    }
    patch.enabled = value.enabled
  }
  if (value.thresholds !== undefined) {
    if (!Array.isArray(value.thresholds)) {
      return { ok: false, error: 'The reminder lead times must be a list.' }
    }
    if (value.thresholds.length > MAX_TENDERS_REMINDER_THRESHOLDS) {
      return {
        ok: false,
        error: `At most ${MAX_TENDERS_REMINDER_THRESHOLDS} reminder lead times can be set.`,
      }
    }
    const thresholds: ReminderSettings['thresholds'] = []
    for (const candidate of value.thresholds) {
      if (!isRecord(candidate)) {
        return { ok: false, error: 'Every reminder lead time needs an id and a lead time.' }
      }
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
      if (!id || id.length > MAX_TENDERS_REMINDER_LABEL_CHARS) {
        return {
          ok: false,
          error: `Every reminder lead time needs an id of at most ${MAX_TENDERS_REMINDER_LABEL_CHARS} characters.`,
        }
      }
      const leadMs = candidate.leadMs
      if (
        typeof leadMs !== 'number' ||
        !Number.isFinite(leadMs) ||
        leadMs <= 0 ||
        leadMs > MAX_TENDERS_REMINDER_LEAD_MS
      ) {
        return {
          ok: false,
          error: `A reminder lead time must be more than zero and at most ${MAX_TENDERS_REMINDER_LEAD_MS} milliseconds before closing.`,
        }
      }
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
      if (label.length > MAX_TENDERS_REMINDER_LABEL_CHARS) {
        return {
          ok: false,
          error: `A reminder label may be at most ${MAX_TENDERS_REMINDER_LABEL_CHARS} characters.`,
        }
      }
      thresholds.push({ id, label: label || id, leadMs })
    }
    patch.thresholds = thresholds
  }
  return { ok: true, patch }
}

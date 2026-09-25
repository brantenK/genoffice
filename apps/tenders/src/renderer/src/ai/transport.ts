// AI extraction transport — the one place the renderer reaches a model.
//
// It builds the core's injected model call (`AiCompletion` from
// `../../shared/ai-extraction`) on top of the suite's shared AI bridge
// (`window.tendersApi.getAiSettings/aiStream/aiStreamCancel/onAiStream`, the
// `ai:*` channels the shell registers once for every app). The core therefore
// stays a pure function of its input, and every test of the extraction pipeline
// can pass a deterministic double instead of this file.
//
// Shape and why:
//
//  * **The core's questions, answered from the suite's own catalogue.**
//    `AiSettings` is a type, the message shape comes from `../../shared/ipc`
//    (which re-exports the canonical provider types), and the extraction core is
//    a plain local module — so this file carries no transport of its own and the
//    module runs in a plain jsdom test with no aliases, the same rule
//    `shared/ipc.ts` and `shared/ai-extraction.ts` follow. One VALUE comes from
//    `@genoffice/ai-provider/browser`, because the core may import no workspace
//    package and so asks its caller for it: `modelLacksVision`, a pure catalogue
//    read (no fetch, no Electron, no state). The credential rule is NOT asked of
//    this file — the core owns it and derives it from the provider capabilities
//    itself, so no caller can answer it differently.
//  * **Settings are read, never written.** `getAiSettings()` returns the BYOK
//    settings the shell owns; the renderer passes the whole object back on the
//    request and the main process injects the key. This file never sees a key it
//    did not receive from main.
//  * **One listener per call, always released.** `onAiStream` is subscribed
//    before `aiStream` is invoked (so no early delta is missed) and unsubscribed
//    on every settle path — resolve, reject, abort, timeout, failure — so a long
//    extraction run cannot leak a listener per chunk.
//  * **Bounded, and honest about it.** Every call arms the same two watchdogs the
//    agent transports use: a silence timer re-armed by each chunk for this
//    request, and an absolute cap that wire activity cannot extend. A dead stream
//    therefore ends in a plain-language error instead of a spinner waiting for a
//    Cancel click, and the request is cancelled in main on the way out. Both
//    bounds are options, so a test can use milliseconds where a run uses minutes.
//  * **A failure is a rejection, never a partial value.** The core records the
//    reason and keeps every other chunk's output, which is what makes the AI
//    pass additive: nothing a model does can remove the local engine's result.
//  * **The failure's CLASS survives to the user.** The shell's `ai:stream`
//    handler classifies an error chunk as `'timeout' | 'credits' | 'network' |
//    'overloaded'` (see the `ai:stream` handler in `apps/docs/src/main/docs-main.ts`).
//    Those are exactly the four failures a BYOK user has to tell apart — an
//    account with no credit, a provider that is rate-limiting, a dead
//    connection, a provider that stopped answering — so the class message leads
//    the error and the provider's own words follow it in brackets, instead of
//    one indistinguishable sentence for all four.
//  * **One availability decision.** `aiAvailabilityFor` delegates to
//    `aiExtractionAvailability` in `../../shared/ai-extraction`, which owns the
//    answer, its reason vocabulary and the message that goes with each reason.
//    `readAiReadiness` adds only the two things that core cannot know — is there
//    a bridge at all, and did the settings load — and passes the helper's own
//    message through, because it names the provider and the thing that is
//    actually missing. `modelIsConfigured` is that same answer as a boolean.
//  * **The request carries the images it is given.** `createTendersCompletion`
//    emits the core's `{ system, user }` as one user message, plus any
//    `images` the caller attached — the wire shape every provider protocol maps
//    — so the vision pass needs no decorator over the bridge.

import { modelLacksVision, type AiSettings } from '@genoffice/ai-provider/browser'
import type { AiStreamChunk, AiStreamRequest } from '../../../shared/ipc'
import {
  aiExtractionAvailability,
  type AiAvailability,
  type AiCompletion,
  type AiUnavailableReason,
} from '../../../shared/ai-extraction'

/**
 * The subset of the preload bridge this transport uses. Declared structurally so
 * a test can supply a fake bridge without touching `window`.
 */
export interface TendersAiBridge {
  getAiSettings(): Promise<AiSettings>
  aiStream(request: AiStreamRequest): Promise<void> | void
  aiStreamCancel(requestId: string): Promise<void> | void
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
}

/**
 * The shared AI bridge, or null when this build does not expose it. Optional
 * because `window.tendersApi` itself is optional: a renderer opened without the
 * preload must degrade to the offline engine, not throw.
 */
export function tendersAiBridge(): TendersAiBridge | null {
  if (typeof window === 'undefined') return null
  const api = window.tendersApi
  if (
    !api ||
    typeof api.getAiSettings !== 'function' ||
    typeof api.aiStream !== 'function' ||
    typeof api.aiStreamCancel !== 'function' ||
    typeof api.onAiStream !== 'function'
  ) {
    return null
  }
  return {
    getAiSettings: () => api.getAiSettings(),
    aiStream: (request) => api.aiStream(request),
    aiStreamCancel: (requestId) => api.aiStreamCancel(requestId),
    onAiStream: (handler) => api.onAiStream(handler),
  }
}

/**
 * Ceiling on one chunk's accumulated reply. A chunk is one page range of one
 * tender, and the prompt asks for a single small JSON object, so a reply this
 * long is a runaway (or a model ignoring the format) rather than an answer:
 * stopping there is cheaper than parsing megabytes of prose, and the core
 * reports the cut instead of guessing.
 */
export const AI_EXTRACTION_MAX_REPLY_CHARS = 200_000

/** The run was cancelled — by the user, or before it was sent. */
export const AI_EXTRACTION_CANCELLED_MESSAGE = 'The AI extraction run was cancelled.'

/** The model finished without sending any reply text. */
export const AI_EXTRACTION_EMPTY_REPLY_MESSAGE = 'The model returned an empty reply.'

/** The model's reply was cut off by its own output limit, so it cannot be trusted. */
export const AI_EXTRACTION_TRUNCATED_MESSAGE =
  'The model stopped because it reached its output limit, so its reply was incomplete.'

/** An error chunk arrived with no message of its own. */
export const AI_EXTRACTION_UNKNOWN_ERROR_MESSAGE = 'The model request failed.'

/**
 * The failure classes the shell's `ai:stream` handler classifies an error chunk
 * into (`errorCode` on `AiStreamChunk`, from `@genoffice/ai-provider`). Exactly
 * the four a BYOK user has to be able to tell apart.
 */
export type AiExtractionErrorClass = NonNullable<AiStreamChunk['errorCode']>

/**
 * What each classified failure means, for a user who runs their own key.
 *
 * The wording follows the classifier it comes from, never beyond it: the class is
 * the shell's own answer (a credits notice, a 429/overload, a connectivity error
 * code, a provider call that hit its timeout), and the provider's raw text is
 * kept in brackets beside it so a support engineer still sees what the provider
 * actually said. None of these messages claims anything about the extraction —
 * a failed chunk means those pages were not read, which the core's own warning
 * says in its own words.
 */
export const AI_EXTRACTION_ERROR_CLASS_MESSAGES: Record<AiExtractionErrorClass, string> = {
  timeout: 'The AI provider stopped responding, so the request timed out.',
  credits:
    'Your AI provider account has no credit left, so it refused the request. Top up the account or switch provider in Settings.',
  network:
    'The suite could not reach the AI provider — a connectivity failure (DNS, a refused or dropped connection, or a proxy/VPN), not a problem with the document.',
  overloaded:
    'The AI provider is at capacity or rate-limiting requests right now, so it refused this one. That is usually temporary — try again shortly.',
}

/**
 * The provider layer classifies `timeout`/`credits`/`network`/`overloaded` and
 * nothing else, so an authentication failure arrives unclassified, as the
 * protocol layers' own text (`HTTP 401: …`, `Claude HTTP 401: …`). That text is
 * accurate and useless: a 401 always means the same thing and always has the
 * same fix, so it is the one raw reason this file rewrites — into a statement of
 * what the provider said plus the two things the user can check.
 */
const AUTH_FAILURE_PATTERN =
  /\b401\b|\bunauthor(?:ized|ised)\b|\binvalid[_ ]?api[_ ]?key\b|\bapi[_ ]?key[_ ]?not valid\b|\bauthentication_error\b/i

/** The actionable sentence a recognisable authentication failure gets. */
export const AI_EXTRACTION_AUTH_FAILURE_MESSAGE =
  'The AI provider rejected the request as unauthorised (HTTP 401). Check that the API key in Settings is the one for this provider, and that it is allowed to use this model.'

/**
 * What one failed chunk reports.
 *
 * A classified failure says which class it is and repeats the provider's own
 * words after it, so a wrong key, an empty account, a rate limit and a dead
 * connection stop looking identical. An unclassified failure is the provider's
 * own text — except for a recognisable authentication failure, which gets the
 * actionable sentence above (with the provider's text still quoted, so nothing
 * is hidden), because "HTTP 401" alone tells a user nothing they can do.
 */
export function aiExtractionErrorMessage(
  code: AiExtractionErrorClass | undefined,
  reason: string,
): string {
  if (code !== undefined) return `${AI_EXTRACTION_ERROR_CLASS_MESSAGES[code]} (${reason})`
  return AUTH_FAILURE_PATTERN.test(reason)
    ? `${AI_EXTRACTION_AUTH_FAILURE_MESSAGE} The provider said: "${reason}"`
    : reason
}

/**
 * Silence watchdog for one chunk's call: no wire activity at all for this long
 * means the stream is dead, so the call is cancelled instead of leaving the UI
 * waiting for a Cancel click. Same bound as the agent transports
 * (`IPC_STREAM_SILENCE_TIMEOUT_MS` in `packages/agent-core/src/electron-transport.ts`,
 * 240 s), and for the same reason: it is longer than the main process's own idle
 * timeout, so the localized main-process error wins whenever that one fires.
 */
export const AI_EXTRACTION_SILENCE_TIMEOUT_MS = 240_000

/**
 * Absolute wall-clock cap for one chunk's call; wire activity never extends it.
 * A stream that dribbles one character at a time is still a dead run, and the
 * extraction pass has a whole tender to get through.
 */
export const AI_EXTRACTION_ABSOLUTE_TIMEOUT_MS = 15 * 60_000

function describeDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * What a stopped call reports. Says what happened and what it means for the
 * result — nothing was read from that reply, and the local engine's extraction
 * is untouched — rather than blaming the network or the user.
 */
export function aiExtractionTimeoutMessage(
  kind: 'silence' | 'absolute',
  timeoutMs: number,
): string {
  const waited = describeDuration(timeoutMs)
  return kind === 'absolute'
    ? `The model call passed ${waited} without finishing, so it was cancelled. Nothing was read from that reply, and the local rule engine's extraction is unchanged.`
    : `The model sent nothing for ${waited}, so the request was cancelled. Nothing was read from that reply, and the local rule engine's extraction is unchanged.`
}

/** The suite's own answer to "can this model read a scanned page's image?". */
function modelCanReadImages(model: string): boolean | null {
  // An empty model id is a CLI provider that picks its own model: unknowable
  // here, and the helper documents `null` as "the caller did not ask".
  return model.length === 0 ? null : !modelLacksVision(model)
}

/**
 * Can this user run AI extraction, and if not, why? — the ONE decision.
 *
 * `aiExtractionAvailability` in `../../shared/ai-extraction` owns the answer, the
 * reason vocabulary (`'no-provider-configured' | 'no-api-key' | 'no-model'`), the
 * message that goes with each reason AND the credential rule itself — derived
 * there from the provider capabilities, so this file supplies no override and no
 * second opinion. The only thing it adds is the vision answer, which the helper
 * deliberately takes as an input because it may import no workspace package.
 *
 * Unavailable is not an error and never a reason to stop: the local rule engine
 * is the offline, always-available default, and the caller shows the message as
 * the reason the OPTIONAL AI pass is off.
 */
export function aiAvailabilityFor(settings: AiSettings | null | undefined): AiAvailability {
  const answer = aiExtractionAvailability({ settings })
  if (!answer.available) return answer
  // Asked twice on purpose: the vision answer is an INPUT to the helper, so it
  // can only be given once the helper's own provider resolution has said which
  // model will actually be used. Both calls are pure and cheap.
  return aiExtractionAvailability({ settings, visionCapable: modelCanReadImages(answer.model) })
}

/**
 * Is a model actually usable? The same answer as `aiAvailabilityFor`, as a
 * boolean — it decides nothing itself, so it cannot disagree with what
 * `readAiReadiness` offers and what a run would accept.
 */
export function modelIsConfigured(settings: AiSettings | null | undefined): boolean {
  return aiAvailabilityFor(settings).available
}

export type AiReadinessCode = 'bridge-unavailable' | 'settings-unavailable' | 'model-not-configured'

/**
 * Can the optional AI pass be offered at all, and with which settings?
 *
 * Two of the three refusals are this file's own business — a build with no
 * bridge, and settings that could not be read — because the shared helper takes
 * settings as an input and cannot know either. Everything else is the helper's
 * answer, passed through with its own `reason`, so there is exactly one place
 * that decides what "configured" means.
 */
export type AiReadiness =
  | {
      ready: true
      settings: AiSettings
      /** The helper's own answer: which provider and model will be used. */
      availability: Extract<AiAvailability, { available: true }>
    }
  | {
      ready: false
      code: AiReadinessCode
      message: string
      /**
       * The helper's reason, when the helper is the one that refused. Absent for
       * a missing bridge or unreadable settings, which are not availability
       * answers at all.
       */
      reason?: AiUnavailableReason
    }

/**
 * Never throws: a bridge that is absent, or settings that cannot be read, answer
 * with a plain-language reason the caller shows instead of a silent no-op. The
 * caller decides what to do with it; the local engine's result is unaffected
 * either way.
 */
export async function readAiReadiness(
  bridge: TendersAiBridge | null | undefined = tendersAiBridge(),
): Promise<AiReadiness> {
  if (!bridge) {
    return {
      ready: false,
      code: 'bridge-unavailable',
      message:
        'AI extraction is unavailable in this build. It is optional — the local rule engine needs nothing but this machine.',
    }
  }
  let settings: AiSettings
  try {
    settings = await bridge.getAiSettings()
  } catch (error) {
    return {
      ready: false,
      code: 'settings-unavailable',
      message: `AI extraction could not read your AI settings (${messageOf(error)}), so it was not offered. The local rule engine is unaffected.`,
    }
  }
  const availability = aiAvailabilityFor(settings)
  if (!availability.available) {
    return {
      ready: false,
      // Retained as the single "a model is not usable" code, whatever the
      // helper's more specific reason is: the reason travels beside it.
      code: 'model-not-configured',
      reason: availability.reason,
      // The helper's own message, not a generic hint restated here: it names the
      // provider and the thing that is actually missing (a key, a base URL or a
      // model) and points at the offline engine that already ran. A caller that
      // rewrote it here would be the second copy of this copy that this feature
      // removed everywhere else.
      message: availability.message,
    }
  }
  return { ready: true, settings, availability }
}

/** Progress of one model call, reported as the reply streams in. */
export interface AiCompletionProgress {
  requestId: string
  /** characters accumulated so far */
  chars: number
}

export interface CreateTendersCompletionOptions {
  bridge: TendersAiBridge
  /** Settings for this run, as returned by `readAiReadiness`. */
  settings: AiSettings
  /** Injected for deterministic tests; defaults to `crypto.randomUUID()`. */
  newRequestId?: () => string
  /** Overrides `AI_EXTRACTION_MAX_REPLY_CHARS`. */
  maxChars?: number
  /** Overrides `AI_EXTRACTION_SILENCE_TIMEOUT_MS`. A non-positive value is ignored. */
  silenceTimeoutMs?: number
  /** Overrides `AI_EXTRACTION_ABSOLUTE_TIMEOUT_MS`. A non-positive value is ignored. */
  absoluteTimeoutMs?: number
  /**
   * Ceiling on THIS call, on a wall clock that wire activity cannot extend. The
   * extraction run hands down its remaining budget through this option, so one
   * slow chunk cannot carry the whole run past its deadline; absent means
   * `AI_EXTRACTION_ABSOLUTE_TIMEOUT_MS`. A non-positive value is ignored.
   */
  callTimeoutMs?: number
  /** Called on every delta, so the caller can show the reply growing. */
  onProgress?: (progress: AiCompletionProgress) => void
}

function messageOf(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
  const text = raw.trim()
  return (text.length === 0 ? 'unknown error' : text).slice(0, 300)
}

function resolveMaxChars(value: number | undefined): number {
  if (value === undefined) return AI_EXTRACTION_MAX_REPLY_CHARS
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : AI_EXTRACTION_MAX_REPLY_CHARS
}

/** A configured bound, or the documented default when it is absent or unusable. */
function resolveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * One image on the outgoing user message, in the wire shape every provider
 * protocol maps.
 *
 * Read off `AiStreamRequest` itself — the user arm of `AgentMessage`, whose
 * `images` are `AgentImage` (`{ base64, mime }`, raw base64 with no `data:`
 * prefix) — rather than restated here, so a change to the request type is a
 * change to this one, and `anthropic.ts` / `openai-compatible.ts` / `gemini.ts`
 * keep reading exactly what they already read.
 */
export type TendersRequestImage = NonNullable<
  Extract<AiStreamRequest['messages'][number], { role: 'user' }>['images']
>[number]

/**
 * The extraction core's injected call, plus the images a vision read attaches.
 *
 * `AiCompletion` carries text only, so a caller that has an image — the vision
 * pass reading a page with no text layer — cannot travel through it. Deriving
 * this from `AiCompletion` and adding one optional field keeps one implementation
 * of the stream lifecycle (one listener, the watchdogs, the reply ceiling,
 * `stopReason`) for both passes, and it stays assignable to `AiCompletion`
 * wherever the core asks for one, because the extra field is optional.
 */
export type TendersCompletion = (
  args: Parameters<AiCompletion>[0] & {
    /** Images for the user message; absent or empty means a plain text request. */
    images?: readonly TendersRequestImage[]
  },
) => ReturnType<AiCompletion>

/**
 * Build the `TendersCompletion` the extraction core calls, one request per chunk.
 *
 * Resolves with the whole reply text. Rejects — never resolves partially — when
 * the stream errors, is cancelled, goes silent past `silenceTimeoutMs`, outlives
 * `absoluteTimeoutMs`, comes back empty, is cut off by the output limit, or
 * overruns `maxChars`; the core turns that into a per-chunk reason and keeps
 * every other chunk's result. The `signal` is honoured for the whole call:
 * aborting cancels the request in the main process and releases the listener.
 *
 * `images` ride on the single user message. With none, the request is byte for
 * byte what it always was — no empty `images` key, so the protocols' own
 * `!m.images?.length` check and the plain-text wire shape are untouched.
 */
export function createTendersCompletion(
  options: CreateTendersCompletionOptions,
): TendersCompletion {
  const { bridge, settings } = options
  const maxChars = resolveMaxChars(options.maxChars)
  const silenceTimeoutMs = resolveTimeout(
    options.silenceTimeoutMs,
    AI_EXTRACTION_SILENCE_TIMEOUT_MS,
  )
  const absoluteTimeoutMs = resolveTimeout(
    options.absoluteTimeoutMs,
    AI_EXTRACTION_ABSOLUTE_TIMEOUT_MS,
  )
  // The per-call ceiling the extraction run hands down, so a slow call cannot
  // occupy more than its share of the run's budget. Both are bounded, so the
  // call is bounded by the smaller of them.
  const callTimeoutMs = resolveTimeout(options.callTimeoutMs, AI_EXTRACTION_ABSOLUTE_TIMEOUT_MS)
  const newRequestId =
    options.newRequestId ??
    ((): string =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`)

  return ({ system, user, images, signal }) =>
    new Promise<string>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error(AI_EXTRACTION_CANCELLED_MESSAGE))
        return
      }
      const requestId = newRequestId()
      let text = ''
      let settled = false
      let unsubscribe: (() => void) | null = null
      let silenceTimer: ReturnType<typeof setTimeout> | null = null
      let absoluteTimer: ReturnType<typeof setTimeout> | null = null
      let callTimer: ReturnType<typeof setTimeout> | null = null

      const clearWatchdogs = (): void => {
        if (silenceTimer !== null) clearTimeout(silenceTimer)
        if (absoluteTimer !== null) clearTimeout(absoluteTimer)
        if (callTimer !== null) clearTimeout(callTimer)
        silenceTimer = null
        absoluteTimer = null
        callTimer = null
      }

      const settle = (outcome: { ok: true; text: string } | { ok: false; error: string }): void => {
        if (settled) return
        settled = true
        clearWatchdogs()
        signal?.removeEventListener('abort', onAbort)
        const dispose = unsubscribe
        unsubscribe = null
        if (dispose) {
          try {
            dispose()
          } catch {
            // A bridge that cannot unsubscribe must not turn a result into a failure.
          }
        }
        if (outcome.ok) resolve(outcome.text)
        else reject(new Error(outcome.error))
      }

      const cancelInMain = (): void => {
        try {
          void bridge.aiStreamCancel(requestId)
        } catch {
          // Cancelling is best-effort: the run has already settled locally.
        }
      }

      const onAbort = (): void => {
        cancelInMain()
        settle({ ok: false, error: AI_EXTRACTION_CANCELLED_MESSAGE })
      }

      /**
       * The stream went quiet, or outlived its cap. Cancel it in main so the
       * provider stops working, and fail the chunk with a reason the core can
       * report — the alternative is a UI waiting on a reply that will not come.
       */
      const onTimeout = (kind: 'silence' | 'absolute', timeoutMs: number): void => {
        if (settled) return
        cancelInMain()
        settle({ ok: false, error: aiExtractionTimeoutMessage(kind, timeoutMs) })
      }

      /** Any chunk for this request proves the stream is alive. */
      const armSilence = (): void => {
        if (silenceTimer !== null) clearTimeout(silenceTimer)
        silenceTimer = setTimeout(() => onTimeout('silence', silenceTimeoutMs), silenceTimeoutMs)
      }

      try {
        // Subscribe BEFORE starting: the first delta can arrive before the
        // `aiStream` promise resolves.
        unsubscribe = bridge.onAiStream((chunk) => {
          if (settled || chunk.requestId !== requestId) return
          // 'reasoning', 'tool-call' and 'ping' carry no reply text, but they do
          // prove the wire is alive, so they re-arm the watchdog like any delta.
          armSilence()
          if (chunk.type === 'delta') {
            text += chunk.text ?? ''
            options.onProgress?.({ requestId, chars: text.length })
            if (text.length > maxChars) {
              cancelInMain()
              settle({
                ok: false,
                error: `The model reply passed ${maxChars} characters and was stopped before it could be read.`,
              })
            }
            return
          }
          if (chunk.type === 'done') {
            if (chunk.stopReason === 'max_tokens') {
              settle({ ok: false, error: AI_EXTRACTION_TRUNCATED_MESSAGE })
              return
            }
            if (text.trim().length === 0) {
              settle({ ok: false, error: AI_EXTRACTION_EMPTY_REPLY_MESSAGE })
              return
            }
            settle({ ok: true, text })
            return
          }
          if (chunk.type === 'error') {
            const reason = chunk.error?.trim()
            // The class the shell put on the chunk is carried into the reason,
            // so the same failure is not reported as one indistinguishable
            // sentence for a wrong key, an empty account and a rate limit.
            settle({
              ok: false,
              error: aiExtractionErrorMessage(
                chunk.errorCode,
                reason && reason.length > 0 ? reason : AI_EXTRACTION_UNKNOWN_ERROR_MESSAGE,
              ),
            })
          }
          // 'reasoning' is the model thinking and 'tool-call'/'ping' carry no
          // reply text: extraction asks for one JSON object, so neither is part
          // of the answer. Their only effect is the watchdog re-arm above.
        })
      } catch (error) {
        settle({ ok: false, error: messageOf(error) })
        return
      }

      if (settled) return
      signal?.addEventListener('abort', onAbort, { once: true })
      // Armed before the request is sent, so a stream that never answers at all
      // is bounded too — not only one that dies mid-reply.
      armSilence()
      absoluteTimer = setTimeout(() => onTimeout('absolute', absoluteTimeoutMs), absoluteTimeoutMs)
      // …and the per-call ceiling the extraction run hands down, so one slow chunk
      // cannot occupy more than its share of the run's budget. It cancels the
      // request in main exactly as the absolute cap does, which is what stops a
      // provider from streaming on after the run has given up on that chunk.
      callTimer = setTimeout(() => onTimeout('absolute', callTimeoutMs), callTimeoutMs)
      const attached = images === undefined ? [] : [...images]
      const request: AiStreamRequest = {
        requestId,
        settings,
        system,
        // One user message: the prompt, plus the images this call carries. The
        // `images` key is omitted entirely when there are none, so a text chunk
        // sends exactly the request it sent before this existed.
        messages: [
          { role: 'user', text: user, ...(attached.length > 0 ? { images: attached } : {}) },
        ],
        tools: [],
      }
      try {
        // A rejected `invoke` (no handler registered, a closed window) must fail
        // the chunk instead of leaving the promise pending forever.
        Promise.resolve(bridge.aiStream(request)).catch((error: unknown) =>
          settle({ ok: false, error: messageOf(error) }),
        )
      } catch (error) {
        settle({ ok: false, error: messageOf(error) })
      }
    })
}

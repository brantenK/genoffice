import type {
  AgentStreamRequest,
  AgentToolCall,
  AgentToolDef,
  AgentTransport,
  AgentMessage,
} from './types'

/**
 * One streamed chunk pushed back over an Electron IPC bridge. Structurally
 * identical to ai-provider's AiStreamChunk; declared here so this package
 * stays dependency-free.
 */
export interface IpcStreamChunk {
  requestId: string
  /** 'ping' = wire-level keepalive; re-arms the silence watchdog and carries no payload;
   * 'reasoning' = model thinking delta (text carries it) */
  type: 'delta' | 'reasoning' | 'tool-call' | 'done' | 'error' | 'ping'
  text?: string
  toolCall?: AgentToolCall
  error?: string
  /** machine-readable error cause; maps to the localized timeout/credits/network/overloaded message */
  errorCode?: 'timeout' | 'credits' | 'network' | 'overloaded'
  /** normalized stop reason on 'done' ('max_tokens' = cut off by the token limit) */
  stopReason?: string
}

/** The request forwarded to the main process to start one streaming turn. */
export interface IpcStreamStart<S> {
  requestId: string
  settings: S
  system: string
  messages: AgentMessage[]
  tools: AgentToolDef[]
}

/**
 * Renderer-side silence watchdog: the main process re-arms it with keepalive
 * pings on wire activity, so firing means the turn is dead (main-process stall,
 * lost chunks) and the run must fail instead of leaving the UI busy forever.
 * Longer than the main-process idle timeout (180s) so that one (localized) wins.
 */
export const IPC_STREAM_SILENCE_TIMEOUT_MS = 240_000

/** Absolute wall-clock cap for one model turn; wire activity never extends it. */
export const IPC_STREAM_ABSOLUTE_TIMEOUT_MS = 15 * 60_000

export interface IpcTransportOptions<S> {
  /** subscribe to stream chunks; returns the unsubscribe function */
  onStream(listener: (chunk: IpcStreamChunk) => void): () => void
  /** forward the start request to the main process; a returned promise reports handler failure */
  start(request: IpcStreamStart<S>): void | Promise<unknown>
  /** abort the in-flight turn in the main process */
  cancel(requestId: string): void
  getSettings(): S
  /** localized fallback when an error chunk carries no message */
  unknownErrorText(): string
  /** localized message for timeouts (errorCode 'timeout' and the silence watchdog) */
  timeoutErrorText?(): string
  /** localized message for exhausted credits (errorCode 'credits') */
  creditsErrorText?(): string
  /** localized message for network connectivity failures (errorCode 'network') */
  networkErrorText?(): string
  /** localized message for capacity/rate-limit failures (errorCode 'overloaded') */
  overloadedErrorText?(): string
}

/**
 * AgentTransport over an Electron IPC bridge: the main process talks to the
 * LLM providers (avoids renderer CORS) and streams chunks back per requestId.
 * Each app wires in its own preload bridge and i18n via the options.
 */
export function createIpcTransport<S>(options: IpcTransportOptions<S>): AgentTransport {
  const timeoutText = () => options.timeoutErrorText?.() ?? options.unknownErrorText()
  return {
    stream(request: AgentStreamRequest, cb) {
      const requestId = crypto.randomUUID()
      let settled = false
      let silenceTimer: ReturnType<typeof setTimeout> | undefined
      let absoluteTimer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe: (() => void) | undefined
      let unsubscribePending = false
      let lastPhase: string | undefined
      const clearTimers = () => {
        clearTimeout(silenceTimer)
        clearTimeout(absoluteTimer)
      }
      const disposeSubscription = () => {
        if (!unsubscribe) {
          unsubscribePending = true
          return
        }
        const dispose = unsubscribe
        unsubscribe = undefined
        dispose()
      }
      const settle = () => {
        settled = true
        clearTimers()
        disposeSubscription()
      }
      const emitPhase = (kind: 'thinking' | 'responding' | 'tool-input') => {
        if (lastPhase === kind) return
        lastPhase = kind
        cb.onPhase?.({ kind })
      }
      const fail = (error: string) => {
        if (settled) return
        settle()
        cb.onError(error)
      }
      const timeout = () => {
        if (settled) return
        fail(timeoutText())
        options.cancel(requestId)
      }
      const armSilence = () => {
        clearTimeout(silenceTimer)
        silenceTimer = setTimeout(timeout, IPC_STREAM_SILENCE_TIMEOUT_MS)
      }
      unsubscribe = options.onStream((chunk) => {
        if (chunk.requestId !== requestId || settled) return
        if (chunk.type === 'ping') {
          armSilence()
          cb.onActivity?.({ kind: 'wire', at: Date.now() })
        } else if (chunk.type === 'delta') {
          armSilence()
          emitPhase('responding')
          cb.onActivity?.({ kind: 'text', at: Date.now() })
          cb.onDelta(chunk.text ?? '')
        } else if (chunk.type === 'reasoning') {
          armSilence()
          emitPhase('thinking')
          cb.onActivity?.({ kind: 'reasoning', at: Date.now() })
          if (chunk.text) cb.onReasoning?.(chunk.text)
        } else if (chunk.type === 'tool-call') {
          armSilence()
          if (chunk.toolCall) {
            emitPhase('tool-input')
            cb.onActivity?.({ kind: 'tool-input', at: Date.now() })
            cb.onToolCall(chunk.toolCall)
          }
        } else if (chunk.type === 'done') {
          settle()
          if (chunk.stopReason) cb.onStopReason?.(chunk.stopReason)
          cb.onDone()
        } else {
          settle()
          cb.onError(
            chunk.errorCode === 'timeout'
              ? timeoutText()
              : chunk.errorCode === 'credits'
                ? (options.creditsErrorText?.() ?? chunk.error ?? options.unknownErrorText())
                : chunk.errorCode === 'network'
                  ? (options.networkErrorText?.() ?? chunk.error ?? options.unknownErrorText())
                  : chunk.errorCode === 'overloaded'
                    ? (options.overloadedErrorText?.() ?? chunk.error ?? options.unknownErrorText())
                    : (chunk.error ?? options.unknownErrorText()),
          )
        }
      })
      if (unsubscribePending) {
        disposeSubscription()
      }
      if (settled) {
        return { cancel: () => undefined }
      }
      armSilence()
      absoluteTimer = setTimeout(timeout, IPC_STREAM_ABSOLUTE_TIMEOUT_MS)
      try {
        // a rejected/thrown start would otherwise leave the run pending until the watchdog
        Promise.resolve(
          options.start({
            requestId,
            settings: options.getSettings(),
            system: request.system,
            messages: request.messages,
            tools: request.tools,
          }),
        ).catch((err: unknown) => {
          fail(err instanceof Error ? err.message : options.unknownErrorText())
        })
      } catch (err) {
        fail(err instanceof Error ? err.message : options.unknownErrorText())
      }
      return {
        cancel: () => {
          clearTimers()
          options.cancel(requestId)
        },
      }
    },
  }
}

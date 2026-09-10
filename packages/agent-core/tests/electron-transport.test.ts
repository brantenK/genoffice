import { describe, expect, it, vi } from 'vitest'
import {
  createIpcTransport,
  IPC_STREAM_ABSOLUTE_TIMEOUT_MS,
  IPC_STREAM_SILENCE_TIMEOUT_MS,
  type IpcStreamChunk,
  type IpcStreamStart,
} from '../src'

interface FakeSettings {
  provider: string
}

function setup(
  startImpl?: (request: IpcStreamStart<FakeSettings>) => void | Promise<unknown>,
  creditsErrorText?: () => string,
  networkErrorText?: () => string,
  overloadedErrorText?: () => string,
) {
  let listener: ((chunk: IpcStreamChunk) => void) | undefined
  const unsubscribe = vi.fn(() => {
    listener = undefined
  })
  const started: IpcStreamStart<FakeSettings>[] = []
  const cancelled: string[] = []
  const transport = createIpcTransport<FakeSettings>({
    onStream: (l) => {
      listener = l
      return unsubscribe
    },
    start: (request) => {
      started.push(request)
      return startImpl?.(request)
    },
    cancel: (requestId) => cancelled.push(requestId),
    getSettings: () => ({ provider: 'genspark' }),
    unknownErrorText: () => 'unknown error',
    timeoutErrorText: () => 'timed out',
    ...(creditsErrorText ? { creditsErrorText } : {}),
    ...(networkErrorText ? { networkErrorText } : {}),
    ...(overloadedErrorText ? { overloadedErrorText } : {}),
  })
  const cb = {
    onDelta: vi.fn(),
    onReasoning: vi.fn(),
    onToolCall: vi.fn(),
    onPhase: vi.fn(),
    onActivity: vi.fn(),
    onStopReason: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
  const handle = transport.stream({ system: 'sys', messages: [], tools: [] }, cb)
  const emit = (chunk: Omit<IpcStreamChunk, 'requestId'> & { requestId?: string }) =>
    listener?.({ requestId: started[0]!.requestId, ...chunk })
  return { started, cancelled, cb, handle, emit, unsubscribe }
}

describe('createIpcTransport', () => {
  it('starts one request with settings and forwards deltas and tool calls', () => {
    const { started, cb, emit } = setup()
    expect(started).toHaveLength(1)
    expect(started[0]!.settings).toEqual({ provider: 'genspark' })
    expect(started[0]!.system).toBe('sys')

    emit({ type: 'delta', text: 'hi' })
    emit({ type: 'delta' })
    emit({ type: 'tool-call', toolCall: { id: 'c1', name: 'read', input: {} } })
    expect(cb.onDelta).toHaveBeenNthCalledWith(1, 'hi')
    expect(cb.onDelta).toHaveBeenNthCalledWith(2, '')
    expect(cb.onToolCall).toHaveBeenCalledWith({ id: 'c1', name: 'read', input: {} })
  })

  it('forwards reasoning chunks separately from text deltas', () => {
    const { cb, emit } = setup()
    emit({ type: 'reasoning', text: 'thinking…' })
    emit({ type: 'reasoning' }) // payload-less chunk carries nothing
    expect(cb.onReasoning).toHaveBeenCalledTimes(1)
    expect(cb.onReasoning).toHaveBeenCalledWith('thinking…')
    expect(cb.onDelta).not.toHaveBeenCalled()
  })

  it('maps matching chunks to phases and timestamped semantic activity', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'))
      const { cb, emit } = setup()
      const at = Date.now()

      emit({ type: 'ping' })
      emit({ type: 'reasoning', text: 'private reasoning' })
      emit({ type: 'delta', text: 'visible answer' })
      emit({ type: 'tool-call', toolCall: { id: 'c1', name: 'read', input: {} } })

      expect(cb.onPhase.mock.calls.map(([phase]) => phase)).toEqual([
        { kind: 'thinking' },
        { kind: 'responding' },
        { kind: 'tool-input' },
      ])
      expect(cb.onActivity.mock.calls.map(([activity]) => activity)).toEqual([
        { kind: 'wire', at },
        { kind: 'reasoning', at },
        { kind: 'text', at },
        { kind: 'tool-input', at },
      ])
      expect(cb.onActivity.mock.calls.flat()).not.toContain('private reasoning')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores chunks for other requestIds', () => {
    const { cb, emit } = setup()
    emit({ requestId: 'someone-else', type: 'delta', text: 'nope' })
    expect(cb.onDelta).not.toHaveBeenCalled()
  })

  it('unsubscribes on done', () => {
    const { cb, emit, unsubscribe } = setup()
    emit({ type: 'done' })
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onStopReason).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('forwards a stopReason carried on the done chunk before onDone', () => {
    const { cb, emit } = setup()
    emit({ type: 'done', stopReason: 'max_tokens' })
    expect(cb.onStopReason).toHaveBeenCalledWith('max_tokens')
    expect(cb.onDone).toHaveBeenCalledTimes(1)
  })

  it.each(['done', 'error'] as const)('handles a synchronous %s emitted during subscription', (type) => {
    const requestId = '00000000-0000-4000-8000-000000000001' as `${string}-${string}-${string}-${string}-${string}`
    const unsubscribe = vi.fn()
    const start = vi.fn()
    const transport = createIpcTransport({
      onStream: (listener) => {
        listener({
          requestId,
          type,
          ...(type === 'error' ? { error: 'sync failure' } : {}),
        })
        return unsubscribe
      },
      start,
      cancel: vi.fn(),
      getSettings: () => ({ provider: 'genspark' }),
      unknownErrorText: () => 'unknown error',
    })
    const cb = {
      onDelta: vi.fn(),
      onToolCall: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(requestId)
    expect(() => transport.stream({ system: 'sys', messages: [], tools: [] }, cb)).not.toThrow()
    expect(start).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(cb.onDone).toHaveBeenCalledTimes(type === 'done' ? 1 : 0)
    expect(cb.onError).toHaveBeenCalledTimes(type === 'error' ? 1 : 0)
  })

  it('emits phases only when their kind changes while preserving activity per chunk', () => {
    const { cb, emit } = setup()
    emit({ type: 'reasoning', text: 'one' })
    emit({ type: 'reasoning', text: 'two' })
    emit({ type: 'delta', text: 'a' })
    emit({ type: 'delta', text: 'b' })
    emit({ type: 'reasoning', text: 'three' })

    expect(cb.onPhase.mock.calls.map(([phase]) => phase)).toEqual([
      { kind: 'thinking' },
      { kind: 'responding' },
      { kind: 'thinking' },
    ])
    expect(cb.onActivity).toHaveBeenCalledTimes(5)
  })

  it('maps error chunks to onError with the localized fallback', () => {
    const { cb, emit, unsubscribe } = setup()
    emit({ type: 'error' })
    expect(cb.onError).toHaveBeenCalledWith('unknown error')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('cancel forwards the requestId to the bridge', () => {
    const { started, cancelled, handle } = setup()
    handle.cancel()
    expect(cancelled).toEqual([started[0]!.requestId])
  })

  it('maps a timeout error code to the localized timeout message', () => {
    const { cb, emit } = setup()
    emit({ type: 'error', error: 'AI request timed out: no data received', errorCode: 'timeout' })
    expect(cb.onError).toHaveBeenCalledWith('timed out')
  })

  it('maps a credits error code to the localized credits message', () => {
    const { cb, emit } = setup(undefined, () => 'credits used up')
    emit({
      type: 'error',
      error: 'Your Genspark credits have been exhausted.',
      errorCode: 'credits',
    })
    expect(cb.onError).toHaveBeenCalledWith('credits used up')
  })

  it('maps a network error code to the localized network message', () => {
    const { cb, emit } = setup(undefined, undefined, () => 'network problem')
    emit({
      type: 'error',
      error: 'Claude fetch failed: fetch failed cause=ECONNRESET',
      errorCode: 'network',
    })
    expect(cb.onError).toHaveBeenCalledWith('network problem')
  })

  it('a network error code without networkErrorText falls back to the carried text', () => {
    const { cb, emit } = setup()
    emit({
      type: 'error',
      error: 'Claude fetch failed: fetch failed cause=ECONNRESET',
      errorCode: 'network',
    })
    expect(cb.onError).toHaveBeenCalledWith('Claude fetch failed: fetch failed cause=ECONNRESET')
  })

  it('a credits error code without creditsErrorText falls back to the carried text', () => {
    const { cb, emit } = setup()
    emit({
      type: 'error',
      error: 'Your Genspark credits have been exhausted.',
      errorCode: 'credits',
    })
    expect(cb.onError).toHaveBeenCalledWith('Your Genspark credits have been exhausted.')
  })

  it('maps an overloaded error code to the localized busy message', () => {
    const { cb, emit } = setup(undefined, undefined, undefined, () => 'service busy')
    emit({
      type: 'error',
      error: 'HTTP 429: {"error":{"type":"engine_overloaded_error"}}',
      errorCode: 'overloaded',
    })
    expect(cb.onError).toHaveBeenCalledWith('service busy')
  })

  it('an overloaded error code without overloadedErrorText falls back to the carried text', () => {
    const { cb, emit } = setup()
    emit({
      type: 'error',
      error: 'HTTP 429: engine overloaded',
      errorCode: 'overloaded',
    })
    expect(cb.onError).toHaveBeenCalledWith('HTTP 429: engine overloaded')
  })

  it('fails the run after prolonged silence; pings re-arm the watchdog', () => {
    vi.useFakeTimers()
    try {
      const { cb, emit, started, cancelled } = setup()
      emit({ type: 'delta', text: 'x' })
      vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS - 1)
      emit({ type: 'ping' })
      vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS - 1)
      expect(cb.onError).not.toHaveBeenCalled()
      vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS)
      expect(cb.onError).toHaveBeenCalledWith('timed out')
      expect(cancelled).toEqual([started[0]!.requestId])
    } finally {
      vi.useRealTimers()
    }
  })

  it('done disarms the silence watchdog', () => {
    vi.useFakeTimers()
    try {
      const { cb, emit } = setup()
      emit({ type: 'done' })
      vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS * 2)
      expect(cb.onError).not.toHaveBeenCalled()
      expect(cb.onDone).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails at the absolute turn deadline even when pings prevent silence', () => {
    vi.useFakeTimers()
    try {
      const { cb, emit, started, cancelled, unsubscribe } = setup()
      let elapsed = 0
      const pingEvery = Math.floor(IPC_STREAM_SILENCE_TIMEOUT_MS / 2)
      while (elapsed + pingEvery < IPC_STREAM_ABSOLUTE_TIMEOUT_MS) {
        vi.advanceTimersByTime(pingEvery)
        elapsed += pingEvery
        emit({ type: 'ping' })
      }
      expect(cb.onError).not.toHaveBeenCalled()

      vi.advanceTimersByTime(IPC_STREAM_ABSOLUTE_TIMEOUT_MS - elapsed)

      expect(cb.onError).toHaveBeenCalledTimes(1)
      expect(cb.onError).toHaveBeenCalledWith('timed out')
      expect(cancelled).toEqual([started[0]!.requestId])
      expect(unsubscribe).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS)
      expect(cb.onError).toHaveBeenCalledTimes(1)
      expect(cancelled).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('absolute timeout reports its error even when bridge cancellation completes synchronously', () => {
    vi.useFakeTimers()
    try {
      let listener: ((chunk: IpcStreamChunk) => void) | undefined
      let requestId = ''
      const unsubscribe = vi.fn()
      const cancel = vi.fn((id: string) => listener?.({ requestId: id, type: 'done' }))
      const transport = createIpcTransport({
        onStream: (next) => {
          listener = next
          return unsubscribe
        },
        start: (request) => {
          requestId = request.requestId
        },
        cancel,
        getSettings: () => ({ provider: 'genspark' }),
        unknownErrorText: () => 'unknown error',
        timeoutErrorText: () => 'timed out',
      })
      const cb = {
        onDelta: vi.fn(),
        onToolCall: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      }
      transport.stream({ system: 'sys', messages: [], tools: [] }, cb)

      let elapsed = 0
      const pingEvery = Math.floor(IPC_STREAM_SILENCE_TIMEOUT_MS / 2)
      while (elapsed + pingEvery < IPC_STREAM_ABSOLUTE_TIMEOUT_MS) {
        vi.advanceTimersByTime(pingEvery)
        elapsed += pingEvery
        listener?.({ requestId, type: 'ping' })
      }
      vi.advanceTimersByTime(IPC_STREAM_ABSOLUTE_TIMEOUT_MS - elapsed)

      expect(cancel).toHaveBeenCalledTimes(1)
      expect(cb.onError).toHaveBeenCalledTimes(1)
      expect(cb.onError).toHaveBeenCalledWith('timed out')
      expect(cb.onDone).not.toHaveBeenCalled()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['done', 'error'] as const)('%s disarms the absolute watchdog', (type) => {
    vi.useFakeTimers()
    try {
      const { cb, emit, cancelled } = setup()
      emit(type === 'done' ? { type } : { type, error: 'failed' })
      vi.advanceTimersByTime(IPC_STREAM_ABSOLUTE_TIMEOUT_MS * 2)
      expect(cancelled).toHaveLength(0)
      expect(cb.onError).toHaveBeenCalledTimes(type === 'error' ? 1 : 0)
      expect(cb.onDone).toHaveBeenCalledTimes(type === 'done' ? 1 : 0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel disarms both watchdogs without locally settling the stream', () => {
    vi.useFakeTimers()
    try {
      const { cb, handle, emit, started, cancelled, unsubscribe } = setup()
      handle.cancel()
      vi.advanceTimersByTime(IPC_STREAM_ABSOLUTE_TIMEOUT_MS * 2)
      expect(cancelled).toEqual([started[0]!.requestId])
      expect(unsubscribe).not.toHaveBeenCalled()
      expect(cb.onDone).not.toHaveBeenCalled()
      expect(cb.onError).not.toHaveBeenCalled()

      emit({ type: 'done' })
      expect(cb.onDone).toHaveBeenCalledTimes(1)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rejected start fails the run instead of leaving it pending', async () => {
    const { cb } = setup(() => Promise.reject(new Error('no handler registered')))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cb.onError).toHaveBeenCalledWith('no handler registered')
    expect(cb.onDone).not.toHaveBeenCalled()
  })
})

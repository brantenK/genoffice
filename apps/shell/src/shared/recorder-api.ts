/** state of the tutorial recorder's main-process machine, mirrored by the REC pill */
export type RecorderState = 'idle' | 'acquiring' | 'recording' | 'saving' | 'saved' | 'error'

/** error message keys — each must exist in the shell renderer strings tables */
export type RecorderErrorKey = 'recTutorialNoSource' | 'recTutorialSaveFailed'

/** the pill's mirror of the recorder; pushed on every state change */
export interface RecorderStatus {
  state: RecorderState
  /** message key into the shell strings table, present when state is 'error' */
  error?: RecorderErrorKey
  /** absolute path of the saved .webm, present when state is 'saved' */
  path?: string
}

export type RecorderStartResult =
  | { ok: true; sourceId: string; width: number; height: number }
  | { ok: false; error?: RecorderErrorKey }

export type RecorderSaveResult = { saved: boolean; path?: string }

export interface RecorderApi {
  /**
   * arm the recorder: main resolves the shell window's capture source and
   * enters 'recording'; the renderer then opens the desktop stream and starts
   * its MediaRecorder (a failure there aborts back to idle via stop)
   */
  start(): Promise<RecorderStartResult>
  /**
   * end the recording (main enters 'saving' and awaits the save invoke), or —
   * with `{ abort: true }` — back out to idle because the capture never
   * produced a recording (stream/encoder failure, system stopped sharing)
   */
  stop(options?: { abort?: boolean }): Promise<void>
  /** deliver the accumulated webm bytes; main runs the save dialog + write */
  save(bytes: Uint8Array): Promise<RecorderSaveResult>
  /** open the saved recording in its OS default player */
  reveal(path: string): Promise<void>
  /** current status (the pill's initial mirror before the first push) */
  status(): Promise<RecorderStatus>
  /** subscribe to state changes; returns unsubscribe */
  onChanged(handler: (status: RecorderStatus) => void): () => void
}

export const RECORDER_CHANNELS = {
  start: 'recorder:start',
  stop: 'recorder:stop',
  save: 'recorder:save',
  reveal: 'recorder:reveal',
  status: 'recorder:status',
  changed: 'recorder:changed',
} as const

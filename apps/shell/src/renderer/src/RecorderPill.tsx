import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RecorderApi, RecorderStatus } from '../../shared/recorder-api'
import { useI18n } from './locale'

declare global {
  interface Window {
    aiOfficeRecorder: RecorderApi
  }
}

/** mm:ss for the recording timer */
function formatElapsed(seconds: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
}

/** getUserMedia constraints for the desktop stream main resolved a source id for */
function desktopStreamConstraints(sourceId: string): MediaStreamConstraints {
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
    },
  }
  return { video: video as unknown as MediaTrackConstraints, audio: false }
}

/**
 * The REC pill at the strip's trailing end: click to record the shell window
 * itself to a .webm (a click-ripple overlay is injected into the visible
 * content), click again to pick a destination and save. The pill mirrors the
 * main-process state machine via recorder status pushes; the capture itself
 * (getUserMedia + MediaRecorder + accumulated chunks) lives in this renderer.
 */
export function RecorderPill() {
  const { t } = useI18n()
  const [status, setStatus] = useState<RecorderStatus>({ state: 'idle' })
  const statusRef = useRef(status)
  statusRef.current = status
  const [elapsed, setElapsed] = useState(0)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const selectAbortRef = useRef(false)

  const releaseCapture = (): void => {
    recorderRef.current = null
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())
  }

  useEffect(() => {
    void window.aiOfficeRecorder.status().then(setStatus)
    return window.aiOfficeRecorder.onChanged((next) => {
      // the capture is gone whenever the state leaves the recording/saving
      // pair — an abort, a finished save, or an error
      if (next.state !== 'recording' && next.state !== 'saving') releaseCapture()
      setStatus(next)
    })
  }, [])

  // nothing outlives the pill itself
  useEffect(() => () => releaseCapture(), [])

  useEffect(() => {
    if (status.state !== 'recording') {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [status.state])

  const startRecording = async (): Promise<void> => {
    try {
      const started = await window.aiOfficeRecorder.start()
      if (!started.ok) return
      // a prior session's capture may still be alive (track ended mid-take)
      releaseCapture()
      selectAbortRef.current = false
      // Codec choice: Electron 43's Chromium reports isTypeSupported=true for
      // VP9, but its VP9 encoder emits an empty stream (110-byte header only —
      // verified by the e2e codec probe), so VP8 is the reliable default.
      const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      )
      // Capture candidates in order: the shell window first, then the screen.
      // When a module view covers the window, Electron's window capture surface
      // can be starved of frames on Windows (verified via the capture probe),
      // so the recorder self-heals by falling back to the screen source.
      const candidates = [started.sourceId, started.fallbackSourceId].filter(
        (id): id is string => Boolean(id),
      )
      let liveRecorder: MediaRecorder | null = null
      let liveStream: MediaStream | null = null
      let liveChunks: Blob[] = []
      let index = 0
      // Windows can starve a fresh desktop capture session for a few seconds
      // (observed intermittently with a module view covering the window), so
      // each candidate gets a generous frame deadline and the whole pass
      // repeats once after a pause before the recorder gives up.
      for (let pass = 0; pass < 2 && !liveRecorder; pass++) {
        if (pass > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
        index = 0
        for (const sourceId of candidates) {
          if (selectAbortRef.current) break
          try {
            index += 1
            const stream = await navigator.mediaDevices.getUserMedia(
              desktopStreamConstraints(sourceId),
            )
            const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
            const chunks: Blob[] = []
            recorder.ondataavailable = (event) => {
              if (event.data.size > 0) chunks.push(event.data)
            }
            // NOTE: no 'ended' listener on candidate tracks — stopping a starved
            // candidate fires 'ended' by design, and an abort here would kill
            // the recording right as the next candidate engages. The chosen
            // stream gets its own ended listener after the loop.
            recorder.start(500)
            const produced = await new Promise<boolean>((resolve) => {
              const check = setInterval(() => {
                if (selectAbortRef.current || chunks.length > 0) {
                  clearInterval(check)
                  resolve(chunks.length > 0)
                }
              }, 50)
              setTimeout(() => {
                clearInterval(check)
                resolve(false)
              }, 3500)
            })
            if (selectAbortRef.current) {
              try {
                recorder.stop()
              } catch {
                /* user stopped during selection */
              }
              stream.getTracks().forEach((track) => track.stop())
              break
            }
            if (produced) {
              liveRecorder = recorder
              liveStream = stream
              liveChunks = chunks
              break
            }
            try {
              recorder.stop()
            } catch {
              /* never produced */
            }
            stream.getTracks().forEach((track) => track.stop())
          } catch {
            // this source could not be opened; try the next candidate
          }
        }
      }
      if (!liveRecorder || !liveStream) {
        // no candidate produced frames: back out of the armed recording
        await window.aiOfficeRecorder.stop({ abort: true })
        return
      }
      liveStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        // the system ended the capture under us — abort the armed recording
        void window.aiOfficeRecorder.stop({ abort: true })
      })
      streamRef.current = liveStream
      recorderRef.current = liveRecorder
      chunksRef.current = liveChunks
      // capture confirmed live — now safe to run the ripple injection
      // (injecting before the capture starts can starve it)
      await window.aiOfficeRecorder.inject()
    } catch (err) {
      // stream or encoder unavailable: back out of the armed recording
      await window.aiOfficeRecorder.stop({ abort: true })
    }
  }

  const stopRecording = async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      // a renderer reload remounted the pill without the live capture, or the
      // user clicked stop while candidate selection was still running: either
      // way there is nothing to save — abort and let the selection loop unwind
      if (statusRef.current.state === 'recording') selectAbortRef.current = true
      await window.aiOfficeRecorder.stop({ abort: true })
      return
    }
    await window.aiOfficeRecorder.stop()
    await new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true })
      recorder.stop()
    })
    const blob = new Blob(chunksRef.current, { type: 'video/webm' })
    releaseCapture()
    await window.aiOfficeRecorder.save(new Uint8Array(await blob.arrayBuffer()))
  }

  const onPillClick = (): void => {
    const current = statusRef.current
    if (current.state === 'idle') void startRecording()
    else if (current.state === 'recording') void stopRecording()
    else if (current.state === 'acquiring') {
        selectAbortRef.current = true
      void window.aiOfficeRecorder.stop({ abort: true })
    } else if (current.state === 'saved' && current.path) void window.aiOfficeRecorder.reveal(current.path)
  }

  const state = status.state
  let content: ReactNode
  let title: string
  let ariaLabel: string
  if (state === 'recording') {
    content = (
      <>
        <span className="rec-pill-dot" aria-hidden="true" />
        <span className="rec-pill-timer" data-rec-timer="">
          {formatElapsed(elapsed)}
        </span>
      </>
    )
    title = t('recTooltipRecording')
    ariaLabel = t('recTutorialStop')
  } else if (state === 'acquiring' || state === 'saving') {
    content = <span className="rec-pill-spinner" aria-hidden="true" />
    title = state === 'acquiring' ? t('recTooltipIdle') : t('recTutorialSaving')
    ariaLabel = title
  } else if (state === 'saved') {
    content = (
      <>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4.5 12.5L9.5 17.5L19.5 7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="rec-pill-label">{t('recTutorialSaved')}</span>
      </>
    )
    title = t('recTutorialSaved')
    ariaLabel = title
  } else if (state === 'error') {
    content = <span className="rec-pill-dot rec-pill-dot-error" aria-hidden="true" />
    title = t(status.error ?? 'recTutorialSaveFailed')
    ariaLabel = title
  } else {
    content = (
      <>
        <span className="rec-pill-dot" aria-hidden="true" />
        <span className="rec-pill-label">{t('recTutorialRecord')}</span>
      </>
    )
    title = t('recTooltipIdle')
    ariaLabel = title
  }

  return (
    <button
      type="button"
      className={`rec-pill ${state === 'recording' ? 'recording' : ''}`}
      data-rec-pill=""
      data-state={state}
      title={title}
      aria-label={ariaLabel}
      onClick={onPillClick}
    >
      {content}
    </button>
  )
}

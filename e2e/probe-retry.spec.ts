import { test } from '@playwright/test'
import { launchShell, closeAndSaveVideo, openAppFromHome } from './helpers'

/**
 * THROWAWAY diagnostic (delete before commit): with a module view attached,
 * does the FIRST desktop capture attempt starve while a retry works?
 */
test('probe: first-capture starvation vs retry', async () => {
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'probe-retry' })
  try {
    await openAppFromHome(launched.page, 'books')
    const selfId = await launched.app.evaluate(async ({ desktopCapturer, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      })
      return win.getMediaSourceId()
    })
    const result = await launched.page.evaluate(async (selfId) => {
      const record = async (attempt: number) => {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: selfId },
          } as unknown as MediaTrackConstraints,
          audio: false,
        })
        const chunks: Blob[] = []
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
        const events: number[] = []
        rec.ondataavailable = (e) => {
          events.push(e.data.size)
          if (e.data.size > 0) chunks.push(e.data)
        }
        rec.start(500)
        await new Promise((r) => setTimeout(r, 1200))
        await new Promise<void>((res) => {
          rec.addEventListener('stop', () => res(), { once: true })
          rec.stop()
        })
        stream.getTracks().forEach((t) => t.stop())
        return { attempt, bytes: new Blob(chunks).size, events: events.length }
      }
      const attempts = []
      for (let i = 1; i <= 3; i++) attempts.push(await record(i))
      return attempts
    }, selfId)
    console.log('PROBE-RETRY ' + JSON.stringify(result))
  } finally {
    await closeAndSaveVideo(launched, 'probe-retry')
  }
})

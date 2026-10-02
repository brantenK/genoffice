import { test } from '@playwright/test'
import { launchShell, closeAndSaveVideo, openAppFromHome } from './helpers'

/**
 * THROWAWAY diagnostic (delete before commit): does SCREEN capture work while
 * a module view (books) is attached and covering the window? The tutorial
 * recorder's self-healing fallback depends on this.
 */
test('probe: screen capture with a module view attached', async () => {
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'probe-screen' })
  try {
    await openAppFromHome(launched.page, 'books')
    const ids = await launched.app.evaluate(async ({ desktopCapturer, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      })
      return {
        selfId: win.getMediaSourceId(),
        screenSourceId: sources.find((s) => s.id.startsWith('screen:'))?.id ?? null,
        windowVariants: sources
          .filter((s) => s.id.startsWith(`window:${win.getMediaSourceId().split(':')[1]}:`))
          .map((s) => s.id),
      }
    })
    console.log('PROBE-IDS ' + JSON.stringify(ids))
    const result = await launched.page.evaluate(async (ids) => {
      const record = async (sourceId: string, ms: number) => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId },
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
          await new Promise((r) => setTimeout(r, ms))
          await new Promise<void>((res) => {
            rec.addEventListener('stop', () => res(), { once: true })
            rec.stop()
          })
          stream.getTracks().forEach((t) => t.stop())
          return { bytes: new Blob(chunks).size, events: events.length }
        } catch (err) {
          return { error: String(err) }
        }
      }
      return {
        screen: ids.screenSourceId ? await record(ids.screenSourceId, 1500) : { error: 'none' },
        window: await record(ids.selfId, 1500),
      }
    }, ids)
    console.log('PROBE-CAPTURES ' + JSON.stringify(result))
  } finally {
    await closeAndSaveVideo(launched, 'probe-screen')
  }
})

import { rmSync, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, openAppFromHome } from './helpers'

/**
 * Tutorial Recorder spec: the REC pill in the tab strip records the shell
 * window itself to a .webm through the REAL capture path (desktopCapturer →
 * the window's own source id → MediaRecorder VP8; only the native save dialog
 * is stubbed), injects a click-ripple overlay into the visible content, and
 * saves. A second test covers the no-source error path.
 *
 * Note: the recording stream must be the real desktop capture — a canvas
 * captureStream stub starves as soon as a module tab occludes the chrome
 * page (Chromium stops compositing covered pages), which no real user hits.
 */

test.describe('tutorial recorder', () => {
  test('records the shell window, ripples on clicks, and saves the webm', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-tutorial-e2e-'))
    const outPath = join(scratch, 'tutorial.webm')
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'tutorial-recorder',
    })
    try {
      // deterministic save destination only — the capture path stays real
      await launched.app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, outPath)

      await openAppFromHome(launched.page, 'books')
      const books = await waitForPageWithUrl(launched.app, 'books')

      const pill = launched.page.locator('[data-rec-pill]')
      await pill.click()
      await expect(pill).toHaveAttribute('data-state', 'recording')
      await expect(launched.page.locator('[data-rec-timer]')).toHaveText(/^\d{2}:\d{2}$/)

      // the visible surface (the books view) got the click-ripple overlay
      const injected = await books.evaluate(
        () => Boolean((window as { __zanoRecRipple?: unknown }).__zanoRecRipple),
      )
      expect(injected).toBe(true)

      // real clicks in the content: harmless here, and the ripple layer is live
      await books.getByText('Set up Zano Books').first().click()
      await expect(books.locator('#zano-rec-ripple-layer')).toBeAttached()

      // real desktop frames accumulate; the pill's pulsing indicator alone
      // keeps the encoder fed while the window is otherwise static
      await launched.page.waitForTimeout(2500)

      await pill.click()
      await expect(pill).toHaveAttribute('data-state', 'saved')

      const { size } = statSync(outPath)
      expect(size).toBeGreaterThan(1024)

      // the saved state reverts on its own
      await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    } finally {
      await closeAndSaveVideo(launched, 'tutorial-recorder-save')
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('surfaces the no-source error on the pill', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'tutorial-recorder-nosource',
    })
    try {
      await launched.app.evaluate(({ desktopCapturer }) => {
        desktopCapturer.getSources = async () => []
      })
      const pill = launched.page.locator('[data-rec-pill]')
      await pill.click()
      await expect(pill).toHaveAttribute('data-state', 'error')
      await expect(pill).toHaveAttribute('title', 'Could not find the app window to record')
      // the error state reverts to idle after its beat
      await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    } finally {
      await closeAndSaveVideo(launched, 'tutorial-recorder-nosource')
    }
  })
})

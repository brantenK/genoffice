import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

/**
 * The docs tab the user actually sees.
 *
 * The fork keeps a hidden docs renderer warmed during idle
 * (`TabManager.prewarmDocs`, scheduled ~800ms after the shell loads) so the
 * first docs tab opens without the module cold-start. That warm view is
 * detached and never laid out: it reports `window.innerWidth === 0` forever
 * while still exposing a `.ProseMirror` and the `data-*` flags on `<html>`.
 * A document opened at runtime therefore produces TWO pages whose URL contains
 * `://docs/`, and `waitForPageWithUrl` may return either one. Measure the
 * laid-out page: it is the only docs page with a non-zero viewport.
 */
async function waitForVisibleDocsPage(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const candidate of app.windows()) {
      const href =
        candidate.url() || (await candidate.evaluate(() => window.location.href).catch(() => ''))
      if (!href.includes('://docs/')) continue
      const laidOut = await candidate
        .evaluate(() => window.innerWidth > 0 && window.innerHeight > 0)
        .catch(() => false)
      if (laidOut) return candidate
    }
    if (Date.now() >= deadline) throw new Error('No laid-out docs page appeared')
    await new Promise((r) => setTimeout(r, 250))
  }
}

test('AI panel side persists across restart and updates an open Docs tab without losing the draft', async () => {
  const fixture = join(__dirname, 'assets/justify-pagegap-fr.docx')
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'ai-panel-side' })
  const { page } = launched
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.locator('.set-nav-item').filter({ hasText: 'General' }).click()
    await page.getByRole('button', { name: 'AI sidebar position', exact: true }).click()
    await page.getByRole('option', { name: 'Right', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'AI sidebar position', exact: true }),
    ).toContainText('Right')
    await page.screenshot({ path: screenshotPath('ai-panel-side-settings') })
    await page.locator('.set-close').click()
    await page.evaluate((path) => window.aiOffice.openPath(path), fixture)
    const editor = await waitForVisibleDocsPage(launched.app)
    await expect(editor.locator('.ProseMirror').first()).toBeVisible()
    await expect(editor.locator('html')).toHaveAttribute('data-ai-panel-side', 'right')
    const dock = editor.locator('.ai-dock')
    const content = editor.locator('.app-content')
    expect((await dock.boundingBox())!.x).toBeGreaterThan((await content.boundingBox())!.x)
    const draft = editor.locator('.ai-composer textarea')
    await draft.fill('Keep this unsent draft when switching sides')

    await editor.getByRole('button', { name: 'Move AI panel to the left', exact: true }).click()
    await expect(editor.locator('html')).toHaveAttribute('data-ai-panel-side', 'left')
    expect((await dock.boundingBox())!.x).toBeLessThan((await content.boundingBox())!.x)
    await expect(draft).toHaveValue('Keep this unsent draft when switching sides')
    await editor.getByRole('button', { name: 'Move AI panel to the right', exact: true }).click()
    await expect(editor.locator('html')).toHaveAttribute('data-ai-panel-side', 'right')
    const before = (await dock.boundingBox())!.width
    const resizer = editor.locator('.ai-panel-resizer')
    await resizer.hover({ position: { x: 3, y: 100 } })
    const handle = (await resizer.boundingBox())!
    await editor.mouse.move(handle.x + 3, handle.y + 100)
    await editor.mouse.down()
    await expect(editor.locator('.ai-panel')).toHaveClass(/ai-panel-resizing/)
    await editor.mouse.move(handle.x - 47, handle.y + 100, { steps: 5 })
    await editor.mouse.up()
    await expect.poll(async () => (await dock.boundingBox())!.width).toBeGreaterThan(before + 30)
    await editor.getByRole('button', { name: 'Collapse panel', exact: true }).click()
    await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(34)
    await editor.locator('.ai-rail').click()
    await expect(draft).toBeVisible()
    await expect(draft).toHaveValue('Keep this unsent draft when switching sides')
    await editor.getByRole('button', { name: 'View', exact: true }).click()
    await editor.getByRole('button', { name: 'Navigation Pane', exact: true }).click()
    await expect(editor.locator('.nav-pane')).toBeVisible()
    expect((await editor.locator('.nav-pane').boundingBox())!.x).toBeLessThan(
      (await editor.locator('.editor-area').boundingBox())!.x,
    )
    expect((await dock.boundingBox())!.x).toBeGreaterThan(
      (await editor.locator('.editor-area').boundingBox())!.x,
    )
    await editor.screenshot({ path: screenshotPath('ai-panel-side-docs-right') })
    const saved = JSON.parse(
      await readFile(join(launched.userDataDir, 'app-settings.json'), 'utf8'),
    )
    expect(saved.aiPanelSide).toBe('right')
  } finally {
    await closeAndSaveVideo(launched, 'ai-panel-side')
  }

  const restarted = await launchShell({
    userDataDir: launched.userDataDir,
    videoDir: 'ai-panel-side-restart',
    openFile: fixture,
  })
  try {
    const editor = await waitForVisibleDocsPage(restarted.app)
    await expect(editor.locator('.ProseMirror').first()).toBeVisible()
    await expect(editor.locator('html')).toHaveAttribute('data-ai-panel-side', 'right')
    expect((await editor.locator('.ai-dock').boundingBox())!.x).toBeGreaterThan(
      (await editor.locator('.app-content').boundingBox())!.x,
    )
  } finally {
    await closeAndSaveVideo(restarted, 'ai-panel-side-restart')
  }
})

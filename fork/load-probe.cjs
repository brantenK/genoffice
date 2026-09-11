/** Load-time probe: launches the built shell, measures the shell renderer and
 *  a fresh docs-tab renderer load, prints navigation timing. Not part of CI. */
const { _electron: electron } = require('@playwright/test')
const { join, resolve } = require('node:path')

const SHELL_DIR = resolve(__dirname, '../apps/shell')

async function measurePageLoad(app, label) {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const timing = await page.evaluate(() => {
    const t = performance.getEntriesByType('navigation')[0]
    const paint = performance.getEntriesByType('paint').find((p) => p.name === 'first-paint')
    return {
      domContentLoaded: t ? t.domContentLoadedEventEnd - t.startTime : null,
      loadEventEnd: t ? t.loadEventEnd - t.startTime : null,
      firstPaint: paint ? paint.startTime : null,
    }
  })
  console.log(`[${label}] domContentLoaded=${Math.round(timing.domContentLoaded)}ms load=${Math.round(timing.loadEventEnd)}ms firstPaint=${Math.round(timing.firstPaint)}ms`)
  return page
}

;(async () => {
  const app = await electron.launch({
    executablePath: require('electron/index.js'),
    args: [SHELL_DIR],
    env: { ...process.env, GENOFFICE_USER_DATA: join(require('node:os').tmpdir(), `zno-load-${Date.now()}`) },
  })
  const home = await measurePageLoad(app, 'shell home')
  // open a docs tab through the shell's own quick-start entry
  await home.locator('.nav-item').first().waitFor({ state: 'visible' }).catch(() => {})
  await home.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('AI Docs'))
    ;(btn || document.querySelector('button')).click()
  })
  await new Promise((r) => setTimeout(r, 2500))
  const wcs = app.windows()
  console.log('windows open:', wcs.length)
  for (const w of wcs) {
    const url = w.url()
    if (url.includes('docs')) {
      const timing = await w.evaluate(() => {
        const t = performance.getEntriesByType('navigation')[0]
        return t ? Math.round(t.loadEventEnd - t.startTime) : null
      })
      console.log(`[docs module] load=${timing}ms url=${url.slice(0, 80)}`)
    }
  }
  await app.close()
})().catch((e) => { console.error(e); process.exit(1) })
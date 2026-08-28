/** Startup/tab-open latency probe (assessment run): cold start to interactive
 *  Home, then docs and sheets tab opens. Not part of CI. */
const { _electron: electron } = require('@playwright/test')
const { join, resolve } = require('node:path')

const SHELL_DIR = resolve(__dirname, '../apps/shell')
const t0 = Date.now()

async function openQuickStart(page, label) {
  const clickedAt = Date.now()
  await page.evaluate((lbl) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(lbl))
    if (!btn) throw new Error('no quick-start button: ' + lbl)
    btn.click()
  }, label)
  return clickedAt
}

;(async () => {
  const app = await electron.launch({
    executablePath: require('electron/index.js'),
    args: [SHELL_DIR],
    env: { ...process.env, GENOFFICE_USER_DATA: join(require('node:os').tmpdir(), `zno-perf-${Date.now()}`) },
  })
  const home = await app.firstWindow()
  await home.waitForLoadState('domcontentloaded')
  const shell = await home.evaluate(() => {
    const t = performance.getEntriesByType('navigation')[0]
    return {
      load: t ? Math.round(t.loadEventEnd - t.startTime) : null,
      now: Date.now(),
    }
  })
  console.log(`[cold start] spawn->renderer loaded ${shell.now - t0}ms (renderer load itself ${shell.load}ms)`)

  // docs tab — let the idle pre-warm finish first (real users click seconds later)
  await new Promise((r) => setTimeout(r, 3000))
  const tDocs = Date.now()
  await openQuickStart(home, 'AI Docs')
  // poll for real interactivity (ribbon visible) instead of a fixed sleep
  let interactiveMs = null
  const pollUntil = Date.now() + 8000
  while (Date.now() < pollUntil) {
    const docsWc = app.windows().find((w) => w.url().includes('docs/out'))
    if (docsWc) {
      const ready = await docsWc.evaluate(() => {
        const el = document.querySelector('.ribbon, .ribbon-root, [class*="ribbon"]')
        return el ? { ribbon: true, navStart: performance.getEntriesByType('navigation')[0]?.startTime ?? 0 } : { ribbon: false }
      }).catch(() => ({ ribbon: false }))
      if (ready.ribbon) {
        interactiveMs = Date.now() - tDocs
        console.log(`[docs tab] click->ribbon ${interactiveMs}ms, renderer navStart ${Math.round(ready.navStart)}ms before click, load ${Math.round((await docsWc.evaluate(() => { const t = performance.getEntriesByType('navigation')[0]; return t ? t.loadEventEnd - t.startTime : 0 }))) }ms`)
        break
      }
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  if (interactiveMs === null) console.log('[docs tab] ribbon never appeared within 8s')

  // sheets tab
  const tSheets = await openQuickStart(home, 'AI Sheets')
  await new Promise((r) => setTimeout(r, 4000))
  const sheetsWcs = app.windows().filter((w) => w.url().includes('sheets/out'))
  const sheetsTiming = sheetsWcs.length
    ? await sheetsWcs[0].evaluate(() => {
        const t = performance.getEntriesByType('navigation')[0]
        return t ? Math.round(t.loadEventEnd - t.startTime) : null
      }).catch(() => null)
    : null
  const ready = sheetsWcs.length
    ? await sheetsWcs[0].evaluate(() => document.body.textContent?.includes('Sheet1')).catch(() => false)
    : false
  console.log(`[sheets tab] click->window ${Date.now() - tSheets}ms, module load ${sheetsTiming}ms, grid painted: ${ready}`)

  await app.close()
  console.log(`[total] ${Date.now() - t0}ms`)
})().catch((e) => { console.error(e); process.exit(1) })
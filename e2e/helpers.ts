/**
 * Shared launcher for Electron E2E tests.
 *
 * Each test boots the built shell (`apps/shell/out`) against a scratch
 * userData dir (via GENOFFICE_USER_DATA) so runs never touch real settings
 * and never collide with a running install's single-instance lock.
 * Build first: `npm run build:all`.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

export const SHELL_DIR = resolve(__dirname, '../apps/shell')
export const ARTIFACTS_DIR = resolve(__dirname, 'artifacts')

const SHELL_MAIN = join(SHELL_DIR, 'out/main/index.js')

interface LaunchOptions {
  /** reuse a previous scratch dir to simulate a second launch */
  userDataDir?: string
  /** UI language override (GENOFFICE_LANG); defaults to English for stable assertions */
  lang?: string
  /** pre-seed app-settings.json with onboardingSeen=true to start at the home screen */
  onboardingSeen?: boolean
  /** subdir of e2e/artifacts to store this launch's video in */
  videoDir: string
  /** absolute document path passed as argv, opened in an editor tab on launch */
  openFile?: string
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
}

export async function launchShell(options: LaunchOptions): Promise<LaunchedApp> {
  if (!existsSync(SHELL_MAIN)) {
    throw new Error(`Missing build output at ${SHELL_MAIN} — run \`npm run build:all\` first`)
  }
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), 'genoffice-e2e-')))
  if (options.onboardingSeen) {
    await writeFile(
      join(userDataDir, 'app-settings.json'),
      JSON.stringify({ onboardingSeen: true }),
    )
  }
  const require = createRequire(join(SHELL_DIR, 'package.json'))
  const executablePath = require('electron') as unknown as string
  // ELECTRON_RUN_AS_NODE (set by VS Code/CI hosts) would boot Electron as
  // plain Node with no windows — strip it so the app always starts as an app
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...hostEnv } = process.env
  // Linux CI runners restrict unprivileged user namespaces (no usable SUID
  // sandbox) and run under xvfb without GPU — without these the window opens
  // but the renderer never loads. The suite drives trusted local builds only.
  // Switches go before the app path so Chromium is guaranteed to consume them
  // and they never leak into the argv the app parses for documents to open.
  const args: string[] = []
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu')
  args.push(SHELL_DIR)
  if (options.openFile) args.push(options.openFile)
  const app = await electron.launch({
    executablePath,
    args,
    env: {
      ...hostEnv,
      GENOFFICE_USER_DATA: userDataDir,
      GENOFFICE_LANG: options.lang ?? 'en',
      ...(process.platform === 'linux' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}),
    },
    // Playwright's Electron screencast wedges the page CDP session on Linux
    // (page.url() stays empty, no lifecycle events, evaluate hangs) — record
    // only where it works
    recordVideo:
      process.platform === 'linux'
        ? undefined
        : {
            dir: join(ARTIFACTS_DIR, options.videoDir),
            size: { width: 1280, height: 800 },
          },
  })
  const page = await app.firstWindow()
  await waitForDocumentReady(app, page)
  return { app, page, userDataDir }
}

/**
 * Playwright can attach to the Electron window mid-navigation and miss the
 * load lifecycle events entirely (Linux timing) — waitForLoadState then hangs
 * on a page that is actually loaded. Polling through evaluate uses the live
 * CDP session instead of the missed events.
 */
async function waitForDocumentReady(
  app: ElectronApplication,
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // the pre-navigation about:blank document also reports readyState complete
    const ready = await page
      .evaluate(() =>
        document.readyState !== 'loading' && window.location.href !== 'about:blank'
          ? document.readyState
          : null,
      )
      .catch(() => null)
    if (ready) return
    await new Promise((r) => setTimeout(r, 100))
  }
  // process list tells renderer-spawn failures apart from slow loads
  const diag = await app
    .evaluate(({ app: electronApp, BrowserWindow }) => ({
      processes: electronApp.getAppMetrics().map((m) => m.type),
      contents: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
    }))
    .catch((e) => String(e))
  throw new Error(`Shell window never loaded (url: ${page.url()}, diag: ${JSON.stringify(diag)})`)
}

/**
 * Close the app and return the recorded video path for the given page.
 *
 * Open editor tabs trigger a native Save/Don't Save/Cancel dialog on close,
 * which would block app.close() forever — stub the dialog to answer
 * "Don't Save" (button index 1) so shutdown stays unattended.
 *
 * The shell's dirty-document close flow can cancel the window close and wait
 * on a renderer that never answers (docs query timeout), which leaves
 * Playwright's close() promise dangling and fails the worker with "Worker
 * teardown timeout" while every test is green. So the shutdown is bounded:
 * quit -> destroy the windows (bypasses the close flow) -> kill, and close()
 * is called exactly once against an already-exited process.
 */
export async function closeAndSaveVideo(
  launched: LaunchedApp,
  name: string,
): Promise<string | undefined> {
  const video = launched.page.video()
  await launched.app
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox
    })
    .catch(() => {})
  // Capture the OS pid while Playwright state is alive: process() throws once
  // the application is torn down, and a lingering OS process is what makes the
  // worker die with "Worker teardown timeout" even though every test is green.
  const launchedPid = ((): number | undefined => {
    try {
      return launched.app.process()?.pid
    } catch {
      return undefined
    }
  })()
  const osProcessAlive = (): boolean => {
    if (typeof launchedPid !== 'number') return false
    try {
      process.kill(launchedPid, 0)
      return true
    } catch {
      return false
    }
  }
  const processExited = (): boolean => {
    // After the app exits, Playwright tears its ElectronApplication state down
    // and process() throws — fall back to the OS pid to tell "state gone" apart
    // from "process actually gone".
    try {
      const proc = launched.app.process()
      if (!proc) return !osProcessAlive()
      return proc.exitCode !== null || proc.signalCode !== null || !osProcessAlive()
    } catch {
      return !osProcessAlive()
    }
  }
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (processExited()) return true
      if (Date.now() >= deadline) return processExited()
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  // 1) Ask the app to quit; Electron then runs its normal shutdown.
  await launched.app.evaluate(({ app }) => app.quit()).catch(() => {})
  let exited = await waitForExit(6_000)
  // 2) The dirty-document close flow may refuse to close the window: destroy
  //    the windows so `window-all-closed` quits without that async flow.
  if (!exited) {
    await launched.app
      .evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.destroy()
        }
      })
      .catch(() => {})
    exited = await waitForExit(6_000)
  }
  // 3) Last resort: kill the process so the suite never wedges.
  if (!exited) {
    try {
      launched.app.process()?.kill()
    } catch {
      // already gone
    }
    if (osProcessAlive() && typeof launchedPid === 'number') {
      try {
        process.kill(launchedPid)
      } catch {
        // already gone
      }
    }
    await waitForExit(4_000)
  }
  // close() only while the process is (still) alive: against an already-exited
  // app Playwright's close() can wait forever for a close event that already
  // fired. An exited app needs no close — the worker releases it on exit.
  if (!processExited()) {
    await Promise.race([
      launched.app.close().catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, 8_000)),
    ])
  }
  if (!video) return undefined
  const target = join(ARTIFACTS_DIR, 'videos', `${name}.webm`)
  // Finalization is async once the process exits; retry briefly before giving up.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await Promise.race([
        video.saveAs(target),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('saveAs timeout')), 5_000),
        ),
      ])
      return target
    } catch {
      await new Promise((r) => setTimeout(r, 750))
    }
  }
  return undefined
}

export function screenshotPath(name: string): string {
  return join(ARTIFACTS_DIR, 'screenshots', `${name}.png`)
}

/**
 * Wait for a page whose URL contains `urlPart` (e.g. an editor WebContentsView).
 * Checks windows that already exist before listening, so it never races the
 * view being created between launch and the first waitForEvent call.
 */
export async function waitForPageWithUrl(
  app: ElectronApplication,
  urlPart: string,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const candidate of app.windows()) {
      if (candidate.url().includes(urlPart)) return candidate
      // page.url() stays empty when attach raced navigation; ask the document
      const href = await candidate.evaluate(() => window.location.href).catch(() => '')
      if (href.includes(urlPart)) return candidate
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`No window with URL containing "${urlPart}"`)
    await app.waitForEvent('window', { timeout: Math.min(remaining, 1_000) }).catch(() => {})
  }
}

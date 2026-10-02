import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ipcMain, shell, webContents } from 'electron'
import type {
  BrowserWindow,
  DesktopCapturerSource,
  SaveDialogOptions,
  SaveDialogReturnValue,
  SourcesOptions,
  WebContents,
} from 'electron'

import type { TabManager } from './tab-manager'
import type {
  RecorderErrorKey,
  RecorderState,
  RecorderSaveResult,
  RecorderStartResult,
  RecorderStatus,
} from '../shared/recorder-api'
import { RECORDER_CHANNELS } from '../shared/recorder-api'

/**
 * Tutorial Recorder: the main-process half of the REC pill in the tab strip.
 * It owns the idle → acquiring → recording → saving → saved → idle | error
 * state machine, resolves the capture source for the shell window itself, and
 * drives the click-ripple overlay injected into whichever surface is visible
 * (a module tab's WebContentsView, or the shell window's own webContents for
 * Home). The webm capture itself lives in the renderer (MediaRecorder over the
 * desktop stream); main only runs the save dialog and writes the bytes.
 */

/** how long the pill's "saved" state lingers before reverting to idle */
const SAVED_REVERT_MS = 6000
/** how long the pill's error state lingers before reverting to idle */
const ERROR_REVERT_MS = 4000

export interface TutorialRecorderDeps {
  /** the shell window (null before creation / after close) */
  getWindow: () => BrowserWindow | null
  /** the shell's tab manager (null before creation) */
  getTabManager: () => TabManager | null
  /** localized save-dialog title from the main-process strings table */
  saveDialogTitle: () => string
  /** directory the save dialog starts in (the OS videos folder) */
  defaultDir: () => string
  /** @genoffice/electron-utils showSaveDialogWithMemory, bound to its dialog module */
  showSaveDialog: (
    parent: BrowserWindow | null,
    options: SaveDialogOptions,
    fallbackDir?: string,
  ) => Promise<SaveDialogReturnValue>
  /** electron desktopCapturer.getSources */
  getSources: (options: SourcesOptions) => Promise<DesktopCapturerSource[]>
  /** clock for the suggested file name; injectable for tests */
  now: () => Date
}

/**
 * Injected into the visible surface when a recording starts (and re-injected
 * on tab switches): a fixed overlay layer that spawns a ring at every
 * pointerdown. Idempotent via the window flag, so a re-injection is a no-op
 * and the cleanup script can fully remove the effect.
 */
export const RIPPLE_SCRIPT = `(() => {
  if (window.__zanoRecRipple) return false
  const layer = document.createElement('div')
  layer.id = 'zano-rec-ripple-layer'
  const style = document.createElement('style')
  style.textContent = [
    '#zano-rec-ripple-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647}',
    '#zano-rec-ripple-layer .zano-rec-ripple{position:absolute;width:36px;height:36px;margin:-18px 0 0 -18px;border:2px solid rgba(229,72,77,0.8);border-radius:50%;animation:zano-rec-ripple 450ms ease-out forwards;}',
    '@keyframes zano-rec-ripple{from{transform:scale(0.35);opacity:0.9}to{transform:scale(2.4);opacity:0}}',
  ].join('')
  layer.appendChild(style)
  const onPointerDown = (event) => {
    const ring = document.createElement('span')
    ring.className = 'zano-rec-ripple'
    ring.style.left = event.clientX + 'px'
    ring.style.top = event.clientY + 'px'
    layer.appendChild(ring)
    setTimeout(() => ring.remove(), 450)
  }
  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  document.documentElement.appendChild(layer)
  window.__zanoRecRipple = { onPointerDown, layer }
  return true
})()`

/** removes everything RIPPLE_SCRIPT installed; safe to run when absent */
export const RIPPLE_CLEANUP_SCRIPT = `(() => {
  const rec = window.__zanoRecRipple
  if (!rec) return false
  document.removeEventListener('pointerdown', rec.onPointerDown, true)
  rec.layer.remove()
  delete window.__zanoRecRipple
  return true
})()`

/** suggested save file name: Zanostack-Tutorial-YYYYMMDD-HHmmss.webm, local time */
function saveFileName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `Zanostack-Tutorial-${stamp}.webm`
}

export class TutorialRecorder {
  private current: RecorderStatus = { state: 'idle' }
  private revertTimer: ReturnType<typeof setTimeout> | null = null
  /** webContents ids that got the ripple overlay while recording */
  private readonly injected = new Set<number>()

  constructor(private readonly deps: TutorialRecorderDeps) {}

  status(): RecorderStatus {
    return this.current
  }

  /** state probe — a helper instead of inline comparisons because TS narrows
   *  `this.current.state` to a literal after the first check, and the machine
   *  moves through set() calls it cannot see */
  private stateIs(state: RecorderState): boolean {
    return this.current.state === state
  }

  async start(): Promise<RecorderStartResult> {
    if (!this.stateIs('idle')) return { ok: false }
    this.set({ state: 'acquiring' })
    const source = await this.resolveSource()
    if (!this.stateIs('acquiring')) {
      // aborted (or disposed) while the source listing was in flight
      return { ok: false }
    }
    if (!source) {
      this.fail('recTutorialNoSource')
      return { ok: false, error: 'recTutorialNoSource' }
    }
    // the renderer opens the stream + MediaRecorder now; main treats the armed
    // capture as recording (a failure there aborts back to idle via stop)
    this.set({ state: 'recording' })
    // the ripple injection is deferred: the pill calls inject() once its
    // capture is confirmed live — injecting between getSources and the
    // capture start can starve the capture session (verified via the
    // e2e capture probe)
    return {
      ok: true,
      sourceId: source.sourceId,
      fallbackSourceId: source.fallbackSourceId,
      width: source.width,
      height: source.height,
    }
  }

  async stop(options?: { abort?: boolean }): Promise<void> {
    if (options?.abort) {
      // the renderer could not start the capture (or the system ended it):
      // back to idle silently, no save dialog
      if (this.stateIs('acquiring') || this.stateIs('recording')) this.reset()
      return
    }
    if (!this.stateIs('recording')) return
    // the renderer stops its MediaRecorder and follows with save(); the
    // ripple overlay goes away with the recording. No idle hop in between:
    // the pill releases its capture on idle and would drop the bytes.
    this.clearRevertTimer()
    this.cleanupInjected()
    this.set({ state: 'saving' })
  }

  async save(bytes: Uint8Array): Promise<RecorderSaveResult> {
    if (!this.stateIs('saving')) return { saved: false }
    // a MediaRecorder that stopped before producing any frame has nothing to save
    if (bytes.length === 0) {
      this.reset()
      return { saved: false }
    }
    const fallbackDir = this.deps.defaultDir()
    try {
      const result = await this.deps.showSaveDialog(
        this.deps.getWindow(),
        {
          title: this.deps.saveDialogTitle(),
          defaultPath: join(fallbackDir, saveFileName(this.deps.now())),
          filters: [{ name: 'WebM video', extensions: ['webm'] }],
        },
        fallbackDir,
      )
      if (result.canceled || !result.filePath) {
        this.reset()
        return { saved: false }
      }
      writeFileSync(result.filePath, bytes)
      this.set({ state: 'saved', path: result.filePath })
      this.revertTimer = setTimeout(() => this.reset(), SAVED_REVERT_MS)
      return { saved: true, path: result.filePath }
    } catch {
      this.fail('recTutorialSaveFailed')
      return { saved: false }
    }
  }

  /**
   * the shell's tab-strip change hook: while recording, the ripple overlay
   * must be live on whichever surface just became visible
   */
  onTabManagerChanged(): void {
    if (!this.stateIs('recording')) return
    this.injectIntoActiveSurface()
  }

  /** window close / app quit while recording: abort silently (no save dialog),
   *  tear the overlays down best-effort and leave the machine back at idle */
  dispose(): void {
    this.clearRevertTimer()
    this.cleanupInjected()
    this.current = { state: 'idle' }
  }

  /**
   * the desktopCapturer source that captures this very window: matched by the
   * media source id the window reports, falling back to the first window
   * source (the shell is the app's only window in practice); null → error state
   */
  private async resolveSource(): Promise<{
    sourceId: string
    fallbackSourceId?: string
    width: number
    height: number
  } | null> {
    const win = this.deps.getWindow()
    if (!win || win.isDestroyed()) return null
    const sources = await this.deps.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    })
    const selfId = win.getMediaSourceId()
    const selfMatch = sources.find((source) => source.id === selfId)
    const matched = selfMatch ?? sources.find((source) => source.id.startsWith('window:'))
    if (!matched) return null
    // When a module view covers the window, Electron's window capture surface
    // can be starved of frames on Windows — the screen source is the recorder's
    // self-healing fallback (the renderer retries with it if the window
    // produces no frames).
    const screenFallback = sources.find((source) => source.id.startsWith('screen:'))
    const bounds = win.getContentBounds()
    return {
      sourceId: matched.id,
      fallbackSourceId: screenFallback?.id,
      width: bounds.width,
      height: bounds.height,
    }
  }

  /** the surface currently on screen: the active tab's view, or the shell
   *  window's own webContents for Home (which has no view of its own) */
  private activeWebContents(): WebContents | null {
    const active = this.deps.getTabManager()?.activeTab()
    if (active?.view) return active.view.webContents
    return this.deps.getWindow()?.webContents ?? null
  }

  private injectIntoActiveSurface(): number | null {
    const target = this.activeWebContents()
    if (!target || target.isDestroyed()) return null
    if (this.injected.has(target.id)) return target.id
    this.injected.add(target.id)
    void target
      .executeJavaScript(RIPPLE_SCRIPT, false)
      .catch((err) => {
        // dropped (navigation / crash mid-injection): a later change can retry
        console.log('[rec-diag-main] inject failed on', target.id, String(err))
        this.injected.delete(target.id)
      })
    return target.id
  }

  /** public hook for the pill: run the ripple injection once the capture is
   *  confirmed live (see start() for why the injection is deferred) */
  injectNow(): number | null {
    return this.injectIntoActiveSurface()
  }

  /** run the ripple cleanup in every surface that got it; each is best-effort
   *  — a destroyed surface is skipped without disturbing the others */
  private cleanupInjected(): void {
    for (const id of this.injected) {
      try {
        const target = webContents.fromId(id)
        if (target && !target.isDestroyed()) {
          void target.executeJavaScript(RIPPLE_CLEANUP_SCRIPT, false).catch(() => {})
        }
      } catch {
        // the webContents died between the set and the lookup
      }
    }
    this.injected.clear()
  }

  /** enter the error state and auto-revert to idle after a beat */
  private fail(errorKey: RecorderErrorKey): void {
    this.clearRevertTimer()
    this.cleanupInjected()
    this.set({ state: 'error', error: errorKey })
    this.revertTimer = setTimeout(() => this.reset(), ERROR_REVERT_MS)
  }

  private reset(): void {
    this.clearRevertTimer()
    this.cleanupInjected()
    this.set({ state: 'idle' })
  }

  private clearRevertTimer(): void {
    if (this.revertTimer) {
      clearTimeout(this.revertTimer)
      this.revertTimer = null
    }
  }

  private set(next: RecorderStatus): void {
    this.current = next
    const win = this.deps.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(RECORDER_CHANNELS.changed, next)
    }
  }
}

/** create the recorder and wire its renderer-facing IPC; one per app run */
export function registerRecorderIpc(deps: TutorialRecorderDeps): TutorialRecorder {
  const recorder = new TutorialRecorder(deps)
  ipcMain.handle(RECORDER_CHANNELS.start, () => recorder.start())
  ipcMain.handle(RECORDER_CHANNELS.stop, (_event, options: unknown) => {
    const abort =
      typeof options === 'object' && options !== null && (options as { abort?: unknown }).abort === true
    return recorder.stop(abort ? { abort: true } : undefined)
  })
  ipcMain.handle(RECORDER_CHANNELS.save, (_event, bytes: unknown) => {
    return recorder.save(bytes instanceof Uint8Array ? bytes : new Uint8Array(0))
  })
  ipcMain.handle(RECORDER_CHANNELS.inject, () => {
    return recorder.injectNow()
  })
  ipcMain.handle(RECORDER_CHANNELS.reveal, (_event, path: unknown) => {
    // scoped to the file this recorder just saved: a compromised renderer
    // cannot point the OS player at arbitrary paths
    const saved = recorder.status().path
    if (typeof path === 'string' && saved && path === saved) void shell.openPath(path)
  })
  ipcMain.handle(RECORDER_CHANNELS.status, () => recorder.status())
  return recorder
}

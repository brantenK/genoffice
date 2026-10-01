import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(() => Promise.resolve('')) },
  webContents: { fromId: vi.fn(() => undefined) },
}))

/**
 * TutorialRecorder (src/main/tutorial-recorder.ts): the REC pill's main
 * process state machine, capture-source resolution, ripple-overlay injection
 * and the save path. Electron is mocked; the save tests write real bytes into
 * a temp directory.
 */

import { ipcMain, webContents } from 'electron'
import type { BrowserWindow, DesktopCapturerSource, SaveDialogReturnValue } from 'electron'
import { RECORDER_CHANNELS } from '../src/shared/recorder-api'
import type { RecorderStatus } from '../src/shared/recorder-api'
import {
  RIPPLE_CLEANUP_SCRIPT,
  RIPPLE_SCRIPT,
  TutorialRecorder,
  registerRecorderIpc,
} from '../src/main/tutorial-recorder'
import type { TutorialRecorderDeps } from '../src/main/tutorial-recorder'
import type { TabManager } from '../src/main/tab-manager'

interface FakeWebContents {
  id: number
  isDestroyed: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
}

interface FakeWindow {
  isDestroyed: ReturnType<typeof vi.fn>
  getMediaSourceId: ReturnType<typeof vi.fn>
  getContentBounds: () => { width: number; height: number }
  webContents: FakeWebContents & { send: ReturnType<typeof vi.fn> }
}

let nextWebContentsId = 1

function makeFakeWebContents(): FakeWebContents {
  return {
    id: nextWebContentsId++,
    isDestroyed: vi.fn(() => false),
    executeJavaScript: vi.fn(() => Promise.resolve(true)),
  }
}

function pushedStates(window: FakeWindow): string[] {
  return window.webContents.send.mock.calls
    .filter((call) => call[0] === RECORDER_CHANNELS.changed)
    .map((call) => (call[1] as RecorderStatus).state)
}

interface Harness {
  window: FakeWindow
  sources: Array<{ id: string }>
  dialogOptions: unknown[]
  dialogResult: { canceled: boolean; filePath?: string }
  dialogError: boolean
  recorder: TutorialRecorder
  tempDir: string
  setActiveTabView: (view: { webContents: FakeWebContents } | null) => void
}

function makeHarness(overrides?: Partial<TutorialRecorderDeps>): Harness {
  const webContentsFake = { ...makeFakeWebContents(), send: vi.fn() }
  const window: FakeWindow = {
    isDestroyed: vi.fn(() => false),
    getMediaSourceId: vi.fn(() => 'window:42:0'),
    getContentBounds: () => ({ width: 1280, height: 800 }),
    webContents: webContentsFake,
  }
  let activeTabView: { webContents: FakeWebContents } | null = null
  const harness: Harness = {
    window,
    sources: [{ id: 'window:42:0' }],
    dialogOptions: [],
    dialogResult: { canceled: false, filePath: '' },
    dialogError: false,
    recorder: null as unknown as TutorialRecorder,
    tempDir: mkdtempSync(join(tmpdir(), 'tutorial-recorder-test-')),
    setActiveTabView: (view) => {
      activeTabView = view
    },
  }
  const tabManager = {
    activeTab: () =>
      activeTabView ? { id: 't1', kind: 'books', view: activeTabView } : undefined,
  } as unknown as TabManager
  const deps: TutorialRecorderDeps = {
    getWindow: () => window as unknown as BrowserWindow,
    getTabManager: () => tabManager,
    saveDialogTitle: () => 'Save Tutorial Recording',
    defaultDir: () => harness.tempDir,
    showSaveDialog: async (_parent, options) => {
      harness.dialogOptions.push(options)
      if (harness.dialogError) throw new Error('dialog exploded')
      return harness.dialogResult as unknown as SaveDialogReturnValue
    },
    getSources: async () => harness.sources as unknown as DesktopCapturerSource[],
    now: () => new Date(2026, 8, 7, 9, 5, 3),
    ...overrides,
  }
  harness.recorder = new TutorialRecorder(deps)
  return harness
}

beforeEach(() => {
  nextWebContentsId = 1
})

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(webContents.fromId).mockReset()
  vi.mocked(webContents.fromId).mockImplementation(() => undefined)
})

describe('capture source resolution', () => {
  it('matches the window source by getMediaSourceId', async () => {
    const h = makeHarness()
    const result = await h.recorder.start()
    expect(result).toEqual({ ok: true, sourceId: 'window:42:0', width: 1280, height: 800 })
    expect(h.recorder.status().state).toBe('recording')
  })

  it('falls back to the first window source when the self id is absent', async () => {
    const h = makeHarness()
    h.sources = [{ id: 'window:7:0' }, { id: 'screen:0:0' }]
    const result = await h.recorder.start()
    expect(result).toMatchObject({ ok: true, sourceId: 'window:7:0' })
  })

  it('enters the error state when no window source exists, then reverts', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.sources = [{ id: 'screen:0:0' }]
    const result = await h.recorder.start()
    expect(result).toEqual({ ok: false, error: 'recTutorialNoSource' })
    expect(h.recorder.status()).toEqual({ state: 'error', error: 'recTutorialNoSource' })
    expect(pushedStates(h.window)).toEqual(['acquiring', 'error'])
    await vi.advanceTimersByTimeAsync(4001)
    expect(h.recorder.status().state).toBe('idle')
  })

  it('resolves nothing when the window is already gone', async () => {
    vi.useFakeTimers()
    const h = makeHarness({ getWindow: () => null })
    const result = await h.recorder.start()
    expect(result).toEqual({ ok: false, error: 'recTutorialNoSource' })
  })
})

describe('state machine', () => {
  it('walks idle → acquiring → recording → saving → saved → idle', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.dialogResult = { canceled: false, filePath: join(h.tempDir, 'take.webm') }
    await h.recorder.start()
    expect(pushedStates(h.window)).toEqual(['acquiring', 'recording'])

    await h.recorder.stop()
    expect(h.recorder.status().state).toBe('saving')

    const saved = await h.recorder.save(new Uint8Array([1, 2, 3]))
    expect(saved).toEqual({ saved: true, path: join(h.tempDir, 'take.webm') })
    expect(h.recorder.status().state).toBe('saved')
    expect(pushedStates(h.window)).toEqual(['acquiring', 'recording', 'saving', 'saved'])

    await vi.advanceTimersByTimeAsync(6001)
    expect(h.recorder.status().state).toBe('idle')
    expect(pushedStates(h.window)).toEqual(['acquiring', 'recording', 'saving', 'saved', 'idle'])
  })

  it('aborts back to idle without a save dialog', async () => {
    const h = makeHarness()
    await h.recorder.start()
    await h.recorder.stop({ abort: true })
    expect(h.recorder.status().state).toBe('idle')
  })

  it('returns to idle when the save dialog is cancelled', async () => {
    const h = makeHarness()
    h.dialogResult = { canceled: true }
    await h.recorder.start()
    await h.recorder.stop()
    const saved = await h.recorder.save(new Uint8Array([1]))
    expect(saved).toEqual({ saved: false })
    expect(h.recorder.status().state).toBe('idle')
  })

  it('enters the error state when saving fails, then reverts', async () => {
    vi.useFakeTimers()
    const h = makeHarness()
    h.dialogError = true
    await h.recorder.start()
    await h.recorder.stop()
    const saved = await h.recorder.save(new Uint8Array([1]))
    expect(saved).toEqual({ saved: false })
    expect(h.recorder.status()).toEqual({ state: 'error', error: 'recTutorialSaveFailed' })
    await vi.advanceTimersByTimeAsync(4001)
    expect(h.recorder.status().state).toBe('idle')
  })

  it('ignores saves outside the saving state and empty recordings', async () => {
    const h = makeHarness()
    expect(await h.recorder.save(new Uint8Array([1]))).toEqual({ saved: false })
    expect(h.recorder.status().state).toBe('idle')

    await h.recorder.start()
    await h.recorder.stop()
    expect(await h.recorder.save(new Uint8Array(0))).toEqual({ saved: false })
    // an empty recording has nothing to save: the machine still returns to idle
    expect(h.recorder.status().state).toBe('idle')
  })

  it('only starts from idle', async () => {
    const h = makeHarness()
    await h.recorder.start()
    expect(await h.recorder.start()).toEqual({ ok: false })
    expect(h.recorder.status().state).toBe('recording')
  })
})

describe('save path', () => {
  it('writes the bytes and suggests a zero-padded local-time file name', async () => {
    const h = makeHarness()
    const target = join(h.tempDir, 'picked.webm')
    h.dialogResult = { canceled: false, filePath: target }

    await h.recorder.start()
    await h.recorder.stop()
    const bytes = new Uint8Array([10, 20, 30, 40])
    const saved = await h.recorder.save(bytes)

    expect(h.dialogOptions).toHaveLength(1)
    // now() is new Date(2026, 8, 7, 9, 5, 3) — local, zero-padded
    expect(h.dialogOptions[0]).toMatchObject({
      title: 'Save Tutorial Recording',
      defaultPath: join(h.tempDir, 'Zanostack-Tutorial-20260907-090503.webm'),
    })
    expect(saved).toEqual({ saved: true, path: target })
    expect(Array.from(readFileSync(target))).toEqual([10, 20, 30, 40])
  })

  it('writes no file when the dialog is cancelled', async () => {
    const h = makeHarness()
    h.dialogResult = { canceled: true }
    await h.recorder.start()
    await h.recorder.stop()
    await h.recorder.save(new Uint8Array([1, 2]))
    expect(existsSync(join(h.tempDir, 'Zanostack-Tutorial-20260907-090503.webm'))).toBe(false)
    expect(h.recorder.status().state).toBe('idle')
  })
})

describe('ripple overlay', () => {
  it('RIPPLE_SCRIPT is idempotent and non-interactive; cleanup removes it', () => {
    expect(RIPPLE_SCRIPT).toContain('__zanoRecRipple')
    expect(RIPPLE_SCRIPT).toContain('zano-rec-ripple-layer')
    expect(RIPPLE_SCRIPT).toContain('pointer-events:none')
    expect(RIPPLE_SCRIPT).toContain('capture: true')
    expect(RIPPLE_SCRIPT).toContain('passive: true')
    expect(RIPPLE_SCRIPT).toContain('position:fixed;inset:0')
    expect(RIPPLE_CLEANUP_SCRIPT).toContain('removeEventListener')
    expect(RIPPLE_CLEANUP_SCRIPT).toContain('delete window.__zanoRecRipple')
    expect(RIPPLE_CLEANUP_SCRIPT).toContain('layer.remove()')
  })

  it('injects once per surface and re-injects when the active surface changes', async () => {
    const h = makeHarness()
    const books = makeFakeWebContents()
    const tenders = makeFakeWebContents()
    h.setActiveTabView({ webContents: books })

    await h.recorder.start()
    expect(books.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(books.executeJavaScript).toHaveBeenCalledWith(RIPPLE_SCRIPT, false)

    // switch to another tab: the overlay must follow the visible surface
    h.setActiveTabView({ webContents: tenders })
    h.recorder.onTabManagerChanged()
    expect(tenders.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(tenders.executeJavaScript).toHaveBeenCalledWith(RIPPLE_SCRIPT, false)

    // switching back does not re-inject an already-injected surface
    h.setActiveTabView({ webContents: books })
    h.recorder.onTabManagerChanged()
    expect(books.executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('injects into the shell window webContents when there is no active view (Home)', async () => {
    const h = makeHarness({ getTabManager: () => null })
    await h.recorder.start()
    expect(h.window.webContents.executeJavaScript).toHaveBeenCalledWith(RIPPLE_SCRIPT, false)
  })

  it('cleans up every injected surface on stop', async () => {
    const h = makeHarness()
    const books = makeFakeWebContents()
    const tenders = makeFakeWebContents()
    h.setActiveTabView({ webContents: books })
    await h.recorder.start()
    h.setActiveTabView({ webContents: tenders })
    h.recorder.onTabManagerChanged()

    vi.mocked(webContents.fromId).mockImplementation(((
      id: number,
    ) => (id === books.id ? books : id === tenders.id ? tenders : undefined)) as typeof webContents.fromId)

    await h.recorder.stop()
    expect(books.executeJavaScript).toHaveBeenCalledWith(RIPPLE_CLEANUP_SCRIPT, false)
    expect(tenders.executeJavaScript).toHaveBeenCalledWith(RIPPLE_CLEANUP_SCRIPT, false)
  })

  it('skips destroyed surfaces during cleanup', async () => {
    const h = makeHarness()
    const books = makeFakeWebContents()
    h.setActiveTabView({ webContents: books })
    await h.recorder.start()

    vi.mocked(webContents.fromId).mockImplementation(((id: number) => {
      if (id !== books.id) return undefined
      books.isDestroyed.mockReturnValue(true)
      return books
    }) as typeof webContents.fromId)

    await h.recorder.stop()
    expect(books.executeJavaScript).not.toHaveBeenCalledWith(RIPPLE_CLEANUP_SCRIPT, false)
  })
})

describe('quit / dispose', () => {
  it('dispose aborts silently: cleanup + idle, no further pushes', async () => {
    const h = makeHarness()
    const books = makeFakeWebContents()
    h.setActiveTabView({ webContents: books })
    await h.recorder.start()

    vi.mocked(webContents.fromId).mockImplementation(((
      id: number,
    ) => (id === books.id ? books : undefined)) as typeof webContents.fromId)

    const pushesBefore = pushedStates(h.window).length
    h.recorder.dispose()
    expect(h.recorder.status().state).toBe('idle')
    expect(books.executeJavaScript).toHaveBeenCalledWith(RIPPLE_CLEANUP_SCRIPT, false)
    expect(pushedStates(h.window)).toHaveLength(pushesBefore)
  })
})

describe('IPC registration', () => {
  it('registers start/stop/save/reveal/status handlers', () => {
    vi.mocked(ipcMain.handle).mockClear()
    registerRecorderIpc({
      getWindow: () => null,
      getTabManager: () => null,
      saveDialogTitle: () => '',
      defaultDir: () => tmpdir(),
      showSaveDialog: async () => ({ canceled: true }) as unknown as SaveDialogReturnValue,
      getSources: async () => [],
      now: () => new Date(2026, 8, 7, 9, 5, 3),
    })
    const channels = vi.mocked(ipcMain.handle).mock.calls.map((call) => call[0])
    expect(channels).toEqual([
      RECORDER_CHANNELS.start,
      RECORDER_CHANNELS.stop,
      RECORDER_CHANNELS.save,
      RECORDER_CHANNELS.reveal,
      RECORDER_CHANNELS.status,
    ])
  })
})

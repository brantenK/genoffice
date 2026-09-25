/**
 * A fake `electron` module for `vi.mock('electron', ...)`.
 *
 * It implements exactly what `src/main/books-main.ts` imports — `app`,
 * `ipcMain` and `WebContentsView` — with faithful behaviour where the books
 * handlers depend on it: `ipcMain.handle` records the handler body so a test
 * can invoke it over its real channel, and a created view records every
 * `webContents.send` so broadcast assertions look at the same data the
 * renderer would receive.
 *
 * The mutable state lives on `globalThis` (keyed by a `Symbol.for`) so it is
 * shared between the test file, this helper and the mocked module even after
 * `vi.resetModules()` hands the module under test a fresh registry.
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface MockSentMessage {
  channel: string
  args: unknown[]
}

export class MockWebContents {
  readonly id: string
  readonly sent: MockSentMessage[] = []
  readonly loaded: string[] = []
  private destroyed = false
  private readonly destroyedListeners: Array<() => void> = []

  constructor(id = `wc-${randomUUID().slice(0, 8)}`) {
    this.id = id
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) {
      throw new Error(`Cannot send to destroyed WebContents: ${channel}`)
    }
    this.sent.push({ channel, args })
  }

  once(event: string, listener: () => void): void {
    if (event === 'destroyed') this.destroyedListeners.push(listener)
  }

  loadURL(url: string): Promise<void> {
    this.loaded.push(url)
    return Promise.resolve()
  }

  loadFile(file: string): Promise<void> {
    this.loaded.push(file)
    return Promise.resolve()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const listener of [...this.destroyedListeners]) listener()
  }
}

export interface MockWebContentsViewOptions {
  webPreferences?: Record<string, unknown>
}

export class MockWebContentsView {
  readonly webContents: MockWebContents
  readonly constructorOptions: MockWebContentsViewOptions

  constructor(options: MockWebContentsViewOptions = {}) {
    this.constructorOptions = options
    this.webContents = new MockWebContents()
    getElectronMockState().views.push(this)
  }
}

export type MockIpcHandler = (event: unknown, ...args: any[]) => unknown

export interface ElectronMockState {
  userDataDir: string
  isPackaged: boolean
  handlers: Map<string, MockIpcHandler>
  handlerOrder: string[]
  views: MockWebContentsView[]
}

const STATE_KEY = Symbol.for('@genoffice/books/tests/electron-mock')
const globalWithState = globalThis as unknown as Record<symbol, ElectronMockState | undefined>

export function getElectronMockState(): ElectronMockState {
  if (!globalWithState[STATE_KEY]) {
    globalWithState[STATE_KEY] = {
      userDataDir: join(tmpdir(), 'books-e2e-unspecified-userData'),
      isPackaged: false,
      handlers: new Map(),
      handlerOrder: [],
      views: [],
    }
  }
  return globalWithState[STATE_KEY]!
}

/** Resets the registry for a new boot while keeping the state object identity. */
export function resetElectronMockState(options: {
  userDataDir: string
  isPackaged?: boolean
}): ElectronMockState {
  const state = getElectronMockState()
  state.userDataDir = options.userDataDir
  state.isPackaged = options.isPackaged ?? false
  state.handlers = new Map()
  state.handlerOrder = []
  state.views = []
  return state
}

export function createElectronModule(): {
  app: {
    readonly isPackaged: boolean
    getPath(name: string): string
  }
  ipcMain: {
    handle(channel: string, listener: MockIpcHandler): void
    removeHandler(channel: string): void
  }
  WebContentsView: typeof MockWebContentsView
} {
  const app = {
    get isPackaged(): boolean {
      return getElectronMockState().isPackaged
    },
    getPath(name: string): string {
      const state = getElectronMockState()
      switch (name) {
        case 'userData':
          return state.userDataDir
        case 'temp':
          return tmpdir()
        case 'logs':
          return join(state.userDataDir, 'logs')
        default:
          throw new Error(`electron-mock: app.getPath('${name}') is not implemented`)
      }
    },
  }

  const ipcMain = {
    handle(channel: string, listener: MockIpcHandler): void {
      const state = getElectronMockState()
      if (state.handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      state.handlers.set(channel, listener)
      state.handlerOrder.push(channel)
    },
    removeHandler(channel: string): void {
      getElectronMockState().handlers.delete(channel)
    },
  }

  return { app, ipcMain, WebContentsView: MockWebContentsView }
}

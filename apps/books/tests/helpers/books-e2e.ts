/**
 * In-process end-to-end harness for the Zano Books main process.
 *
 * It boots the REAL `src/main/books-main.ts` module (its real
 * `registerBooksIpc` bodies, its real ledger/persistence engines) against a
 * fresh temp `userData` directory and drives it over the real IPC channels the
 * preload bridge uses — headless, no Electron binary and no GUI.
 *
 * The test file must mock electron itself, e.g.
 *
 *   vi.mock('electron', async () => {
 *     const { createElectronModule } = await import('./helpers/electron-mock')
 *     return createElectronModule()
 *   })
 *
 * which is why the module under test is imported dynamically here.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import {
  getElectronMockState,
  resetElectronMockState,
  type MockIpcHandler,
  type MockWebContentsView,
} from './electron-mock'
import { BOOKS_CHANNELS, type LoadDataResult, type SaveDataResult } from '../../src/shared/ipc'
import type * as BooksMainModule from '../../src/main/books-main'
import type { BooksData, BooksDataEnvelope } from '../../src/shared/types'

export type BooksMain = typeof BooksMainModule

/** One boot of the module: its exports, its view, its handler registry and the
 * paths its runtime config opened. */
interface ActiveBoot {
  modules: BooksMain
  view: MockWebContentsView
  handlers: Map<string, MockIpcHandler>
  openedPaths: string[]
}

export interface BootOptions {
  /** Reuse an existing directory instead of creating a temp one. */
  userDataDir?: string
  isPackaged?: boolean
}

export interface BooksE2ESession {
  readonly userDataDir: string
  readonly booksDir: string
  readonly booksDataPath: string
  readonly backupsDir: string
  /** The booted module namespace, for real exported entry points (e.g. issueSalesInvoiceInBooks). */
  readonly modules: BooksMain
  /** The WebContentsView createBooksView() built; its webContents receives broadcast events. */
  readonly view: MockWebContentsView
  /**
   * Invokes a channel on this boot's handler registry the way ipcRenderer.invoke
   * does: structured-cloned arguments, a `{ sender }` event, a rejected promise
   * on a throw and an error for an unregistered channel.
   */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /**
   * The stored envelope, or null when there is no store yet. Throws when the
   * store exists but could not be read — the case a boolean-shaped helper
   * cannot express, and the one it used to hide.
   */
  loadData(): Promise<BooksDataEnvelope | null>
  /** The raw discriminated reply from `books:load-data`, unmodified. */
  loadDataResult(): Promise<LoadDataResult>
  /**
   * Persists `data` and resolves true only when the write landed. `revision`
   * defaults to the revision this session last observed, so a naive caller
   * behaves like a well-behaved client; pass one to exercise a stale writer.
   */
  saveData(data: BooksData, revision?: number): Promise<boolean>
  /** The raw discriminated reply from `books:save-data`, unmodified. */
  saveDataResult(data: BooksData, revision?: number): Promise<SaveDataResult>
  /** The revision the last load/save observed on this session. */
  revision(): number
  /**
   * Channels registered, in registration order. The mocked ipcMain keeps one
   * registry per process (as Electron does per app), so with two sessions
   * alive at once this reports the most recently booted one.
   */
  handlerChannels(): string[]
  /** Every message this boot's view received through webContents.send. */
  broadcasts(): Array<{ channel: string; args: unknown[] }>
  /** Paths handed to runtime.openGeneratedPath (Sheets export, invoice PDF). */
  openedPaths(): string[]
  readBooksFile(): string
  writeBooksFile(content: string): void
  readStoredData(): BooksDataEnvelope
  listFiles(dir?: string): string[]
  /** App restart: fresh module registry, same userData directory and data. */
  restart(): Promise<void>
  /** Fresh module registry AND an empty data directory, same userData directory. */
  reset(): Promise<void>
  /** Stops the file watcher and removes the temp userData directory. */
  dispose(): void
}

export function createUserDataDir(prefix = 'books-e2e-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Every boot in one process shares the mocked `ipcMain`, so boots are
 * serialized: a second boot must not reset the handler registry while an
 * earlier module instance is still importing and about to register its
 * channels (which the mock — like real Electron — refuses to double-register).
 */
let bootChain: Promise<unknown> = Promise.resolve()

function enqueueBoot<T>(task: () => Promise<T>): Promise<T> {
  const next = bootChain.then(task, task)
  bootChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function loadBooksModule(userDataDir: string, isPackaged?: boolean): Promise<ActiveBoot> {
  return enqueueBoot(async () => {
    vi.resetModules()
    const { handlers } = resetElectronMockState({ userDataDir, isPackaged })
    const modules = (await import('../../src/main/books-main')) as BooksMain
    const openedPaths: string[] = []
    modules.configureBooksRuntime({
      preloadPath: join(userDataDir, 'preload.js'),
      rendererFile: join(userDataDir, 'index.html'),
      openGeneratedPath: (target: string) => {
        openedPaths.push(target)
        return true
      },
    })
    const view = modules.createBooksView() as unknown as MockWebContentsView
    return { modules, view, handlers, openedPaths }
  })
}

function stopBoot(boot: ActiveBoot): void {
  try {
    boot.modules.stopBooksStoreWatcher()
  } catch {}
  try {
    boot.modules.resetBooksIpcForTesting()
  } catch {}
}

async function invokeHandler(boot: ActiveBoot, channel: string, args: unknown[]): Promise<unknown> {
  const handler = boot.handlers.get(channel)
  if (!handler) {
    throw new Error(`No handler registered for '${channel}'`)
  }
  const payload = structuredClone(args) as unknown[]
  const result = await handler({ sender: boot.view.webContents }, ...payload)
  return result === undefined ? undefined : (structuredClone(result) as unknown)
}

export async function bootBooksE2E(options: BootOptions = {}): Promise<BooksE2ESession> {
  const userDataDir = options.userDataDir ?? createUserDataDir()
  const booksDir = join(userDataDir, 'books')
  const booksDataPath = join(booksDir, 'books-data.json')
  const backupsDir = join(booksDir, 'backups')

  let boot = await loadBooksModule(userDataDir, options.isPackaged)

  const readBooksFile = (): string => readFileSync(booksDataPath, 'utf8')
  // The revision this session last observed, so `saveData` without an explicit
  // revision behaves like a renderer that just loaded.
  let observedRevision = 0

  const session: BooksE2ESession = {
    userDataDir,
    booksDir,
    booksDataPath,
    backupsDir,
    get modules() {
      return boot.modules
    },
    get view() {
      return boot.view
    },
    invoke: ((channel: string, ...args: unknown[]) =>
      invokeHandler(boot, channel, args)) as BooksE2ESession['invoke'],
    loadDataResult: async () => {
      const result = (await session.invoke<LoadDataResult>(
        BOOKS_CHANNELS.loadData,
      )) as LoadDataResult
      if (result?.ok && result.readable && result.data) observedRevision = result.data.revision
      return result
    },
    loadData: async () => {
      const result = await session.loadDataResult()
      if (result.ok && result.readable) return result.data
      throw new Error(`books:load-data could not produce a ledger: ${result.error ?? 'unreadable'}`)
    },
    saveDataResult: async (data: BooksData, revision?: number) => {
      const result = (await session.invoke<SaveDataResult>(
        BOOKS_CHANNELS.saveData,
        data,
        revision ?? observedRevision,
      )) as SaveDataResult
      if (result?.ok) observedRevision = result.revision
      return result
    },
    saveData: async (data: BooksData, revision?: number) =>
      Boolean((await session.saveDataResult(data, revision)).ok),
    revision: () => observedRevision,
    handlerChannels: () => [...getElectronMockState().handlerOrder],
    broadcasts: () =>
      boot.view.webContents.sent.map((message) => ({ ...message, args: [...message.args] })),
    openedPaths: () => [...boot.openedPaths],
    readBooksFile,
    writeBooksFile: (content: string) => {
      writeFileSync(booksDataPath, content, 'utf8')
    },
    readStoredData: () => JSON.parse(readBooksFile()) as BooksDataEnvelope,
    listFiles: (dir?: string) => {
      const target = dir ?? booksDir
      return existsSync(target) ? readdirSync(target).sort() : []
    },
    restart: async () => {
      stopBoot(boot)
      boot = await loadBooksModule(userDataDir, options.isPackaged)
    },
    reset: async () => {
      stopBoot(boot)
      rmSync(booksDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
      boot = await loadBooksModule(userDataDir, options.isPackaged)
    },
    dispose: () => {
      stopBoot(boot)
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    },
  }

  return session
}

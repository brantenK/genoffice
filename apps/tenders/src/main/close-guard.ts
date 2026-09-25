// The shell's dirty-close guard for the Tenders view.
//
// Split out of `main/tenders-main.ts` with no behaviour change. Tenders autosaves
// behind a 300 ms debounce and holds the only copy of an edit until that save
// commits, so a window close inside the debounce window used to drop the edit
// silently. The shell therefore asks the view to flush before it closes (see the
// `win.on('close')` guard in apps/shell/src/main/index.ts).
//
// The shape is "ask, never assume": a renderer that does not answer in time, or
// answers that it could not commit, gets a dialog rather than a silent close, and
// a dialog that cannot be shown keeps the window open.
import { dialog, type WebContents } from 'electron'
import type { BrowserWindow } from 'electron'
import { TENDERS_CHANNELS, type TendersCloseFlushResult } from '../shared/ipc'
import { closeFlushWaiters } from './composition-services'

/** In-flight close-guard flushes, keyed by the WebContents being guarded. */
const pendingCloseFlushes = new Map<number, Promise<TendersCloseFlushResult | null>>()
let closeFlushRequestSeq = 0

/**
 * How long the close guard waits for the renderer's flush reply. A renderer that
 * does not answer cannot prove the edit is durable, so the guard prompts instead
 * of closing silently (same fail-closed shape as the docs close check).
 */
const CLOSE_FLUSH_TIMEOUT_MS = 10_000

/**
 * Ask the Tenders renderer to commit its debounced edit and report the outcome.
 * Resolves `null` when no reply arrives in time (a wedged or unloaded renderer).
 */
function requestCloseFlush(contents: WebContents): Promise<TendersCloseFlushResult | null> {
  const pending = pendingCloseFlushes.get(contents.id)
  if (pending) return pending
  const request = new Promise<TendersCloseFlushResult | null>((resolve) => {
    const requestId = (closeFlushRequestSeq += 1)
    const timer = setTimeout(() => {
      closeFlushWaiters.delete(requestId)
      resolve(null)
    }, CLOSE_FLUSH_TIMEOUT_MS)
    closeFlushWaiters.set(requestId, {
      webContentsId: contents.id,
      settle: (result) => {
        clearTimeout(timer)
        resolve(result)
      },
    })
    try {
      contents.send(TENDERS_CHANNELS.closeFlushRequest, requestId)
    } catch {
      // A send failure is a renderer that cannot answer — the same as a timeout.
      closeFlushWaiters.delete(requestId)
      clearTimeout(timer)
      resolve(null)
    }
  }).finally(() => {
    pendingCloseFlushes.delete(contents.id)
  })
  pendingCloseFlushes.set(contents.id, request)
  return request
}

/**
 * Last resort before uncommitted work is discarded: ask, never assume. A dialog
 * that cannot be shown fails closed (the window stays open).
 */
async function confirmDiscardingTendersChanges(
  parent: BrowserWindow | null | undefined,
  detail: string,
): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    message: 'Close Zanostack with unsaved Tenders changes?',
    detail,
    buttons: ['Close anyway', 'Keep Zanostack open'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  try {
    const { response } =
      parent && typeof parent.isDestroyed === 'function' && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options)
    return response === 0
  } catch {
    return false
  }
}

/**
 * Close guard for the Tenders view: `true` means the caller may close.
 * A clean renderer (nothing uncommitted) passes straight through; otherwise the
 * pending edit is committed first, and a flush that could not commit prompts
 * instead of dropping the edit.
 */
export async function requestTendersClose(
  contents: WebContents,
  parent?: BrowserWindow | null,
): Promise<boolean> {
  if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) {
    return true
  }
  // A view that has not finished loading holds no renderer state at all (the
  // store hydrates from disk after load), so there is nothing to flush and no
  // reply to wait for.
  if (typeof contents.isLoading === 'function' && contents.isLoading()) return true
  const outcome = await requestCloseFlush(contents)
  if (outcome === null) {
    return confirmDiscardingTendersChanges(
      parent,
      'Tenders did not respond to the close check, so its latest changes may not be saved.',
    )
  }
  if (outcome.ok || !outcome.dirty) return true
  return confirmDiscardingTendersChanges(
    parent,
    outcome.error
      ? `Your latest Tenders changes could not be saved: ${outcome.error}`
      : 'Your latest Tenders changes could not be saved.',
  )
}

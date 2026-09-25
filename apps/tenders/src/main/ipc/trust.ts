// The trusted-sender gate for the Tenders IPC surface.
//
// Split out of `main/tenders-main.ts` with no behaviour change. This is the
// module the invariant lives in: EVERY `ipcMain.handle` in `ipc/handlers.ts`
// begins with `isTrustedTendersEvent`, and a request that fails it never reaches
// a side effect.
//
// The gate is deliberately paranoid and fails closed:
//  * the sender must be a REGISTERED Tenders WebContents (`registerTendersWebContents`),
//  * it must be a top-level frame (no `parent`),
//  * and its URL must match the configured trusted renderer origin or file. With
//    no configured origin there is no way to prove the sender is the real
//    renderer, so an unconfigured runtime refuses everything.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { WebContents } from 'electron'
import type { TendersPersistenceError } from '../../shared/tenders-persistence'
import { getActiveTendersWebContents } from '../web-contents-registry'

/**
 * The trusted-renderer configuration and the live view set. Both are owned by the
 * composition root and handed in here, so the trust decision reads from one place
 * and the modules that register views and the modules that check them cannot
 * disagree.
 */
let rendererConfig: { rendererUrl?: string | undefined; rendererFile: string } = {
  rendererFile: '',
}

export function configureTrustedRenderer(config: {
  rendererUrl?: string | undefined
  rendererFile: string
}): void {
  rendererConfig = { rendererUrl: config.rendererUrl, rendererFile: config.rendererFile }
}

export function trustedRendererUrl(url: string): boolean {
  try {
    if (
      rendererConfig.rendererUrl &&
      new URL(url).origin === new URL(rendererConfig.rendererUrl).origin
    )
      return true
    if (rendererConfig.rendererFile) {
      const expected = rendererConfig.rendererFile.startsWith('file:')
        ? rendererConfig.rendererFile
        : pathToFileURL(resolve(rendererConfig.rendererFile)).href
      return new URL(url).href === new URL(expected).href
    }
  } catch {}
  return false
}

export function isTrustedTendersEvent(
  event: { sender?: unknown; senderFrame?: { url?: string; parent?: unknown } | null } | undefined,
): boolean {
  const sender = event?.sender
  if (!getActiveTendersWebContents().some((wc) => wc === sender)) return false
  if (event?.senderFrame?.parent !== undefined && event.senderFrame.parent !== null) return false
  // Fail closed when the trusted renderer origin was never configured: with no
  // expected origin there is no way to prove the sender is the real renderer.
  if (!rendererConfig.rendererUrl && !rendererConfig.rendererFile) return false
  const url =
    event?.senderFrame?.url ||
    (sender && typeof (sender as { getURL?: () => string }).getURL === 'function'
      ? (sender as { getURL: () => string }).getURL()
      : '')
  return typeof url === 'string' && trustedRendererUrl(url)
}

export function isTrustedTendersWebContents(wc: WebContents): boolean {
  if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false
  // Fail closed for an unconfigured origin, and for any object that cannot
  // report its URL (a real Electron WebContents always can).
  if (!rendererConfig.rendererUrl && !rendererConfig.rendererFile) return false
  if (typeof (wc as unknown as { getURL?: () => string }).getURL !== 'function') return false
  const url = (wc as unknown as { getURL: () => string }).getURL()
  return trustedRendererUrl(url)
}

export function unauthorizedTendersRequest(): { ok: false; error: TendersPersistenceError } {
  return {
    ok: false,
    error: { code: 'INVALID_REQUEST', message: 'Sender is not a registered Tenders WebContents.' },
  }
}

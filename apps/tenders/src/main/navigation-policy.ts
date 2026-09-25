// Deny-by-default navigation for the Tenders view.
//
// Split out of `main/tenders-main.ts` with no behaviour change. Values like
// `VaultDoc.fileUrl` / `TenderRecord.fileUrl` are STORE DATA, so without this a
// `window.open(doc.fileUrl, '_blank')` would follow an `http(s):` URL read from
// the store, and any link or injected script could navigate the privileged view
// away from the trusted renderer.
import { existsSync } from 'node:fs'
import { WebContentsView, type WebContents } from 'electron'
import { trustedRendererUrl } from './ipc/trust'
import { runtime } from './composition-services'
import { registerTendersIpc } from './ipc/handlers'
import { registerTendersWebContents, getActiveTendersWebContents } from './web-contents-registry'

/**
 * Is this navigation target safe for the privileged Tenders view? Only the
 * configured trusted renderer origin/file and in-session `blob:` object URLs are
 * allowed; the origin check fails closed when no trusted renderer is configured.
 */
function allowedTendersNavigation(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false
  if (isTrustedRendererBlobUrl(url)) return true
  return trustedRendererUrl(url)
}

/**
 * Is this a `blob:` object URL owned by the trusted renderer?
 *
 * `blob:` is NOT an origin of its own: a blob URL inherits the origin of the
 * context that created it, and its serialization is
 * `blob:<creator-origin>/<uuid>`. That means `blob:https://attacker.example/x`
 * is a URL a foreign document can construct, and an unqualified
 * `url.startsWith('blob:')` would have allowed it to navigate the privileged
 * view. Only the renderer ever creates these in practice — the four call sites
 * are `URL.createObjectURL` in `renderer/src/calendar.ts`,
 * `renderer/src/components/TenderList.tsx`,
 * `renderer/src/components/Workspace.tsx` and `renderer/src/mock/vault.ts`, all
 * of which are the trusted view — so qualifying by that origin costs nothing and
 * closes the foreign-blob hole.
 *
 * The no-`//` prefix rule matches the HTML "blob URL" definition: the creator's
 * origin is serialized with a single leading slash, so anything of the form
 * `blob://host/...` is not a blob URL this renderer could have made.
 */
function isTrustedRendererBlobUrl(url: string): boolean {
  if (!url.startsWith('blob:')) return false
  if (!runtime.rendererUrl && !runtime.rendererFile) return false
  if (url.startsWith('blob://')) return false
  try {
    const creator = new URL(url.slice('blob:'.length))
    if (creator.origin === 'null' || creator.origin === '') return false
    return trustedRendererUrl(creator.href)
  } catch {
    return false
  }
}

/**
 * Deny-by-default navigation for the Tenders view (contracts §6 item 9). Values
 * like `VaultDoc.fileUrl` / `TenderRecord.fileUrl` are store data, so without
 * this a `window.open(doc.fileUrl, '_blank')` would follow an `http(s):` URL read
 * from the store, and any link or injected script could navigate the privileged
 * view away from the trusted renderer.
 */
export function applyTendersNavigationPolicy(wc: WebContents): void {
  if (!wc) return
  if (typeof wc.setWindowOpenHandler === 'function') {
    wc.setWindowOpenHandler(({ url }) => ({
      action: allowedTendersNavigation(url) ? 'allow' : 'deny',
    }))
  }
  if (typeof wc.on === 'function') {
    wc.on('will-navigate', (event, url) => {
      if (!allowedTendersNavigation(url)) event.preventDefault()
    })
  }
}

export function createTendersView(): WebContentsView {
  registerTendersIpc()

  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  registerTendersWebContents(view.webContents)
  applyTendersNavigationPolicy(view.webContents)

  if (runtime.rendererUrl) {
    void view.webContents.loadURL(runtime.rendererUrl)
  } else if (runtime.rendererFile && existsSync(runtime.rendererFile)) {
    void view.webContents.loadFile(runtime.rendererFile)
  }

  return view
}

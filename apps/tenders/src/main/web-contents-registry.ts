// The live Tenders views, and the broadcast channel to them.
//
// Split out of `main/tenders-main.ts` with no behaviour change. This is the set
// the trusted-sender gate checks a request against (`ipc/trust.ts` reads it
// through `configureRegisteredWebContents`) and the set the authoritative store
// broadcasts a committed document to, so it is the one place that knows which
// renderers are live.
//
// Registering is idempotent and self-cleaning: a view that is destroyed removes
// itself, so a crashed renderer cannot leave a dead entry behind that the gate
// would then have to special-case.
import type { WebContents } from 'electron'
import { TENDERS_CHANNELS } from '../shared/ipc'
import { MAX_TENDERS_DOCUMENT_BYTES } from '../shared/tenders-persistence'
import type { TendersData } from '../shared/types'

/**
 * Is this the trusted renderer? Declared as a seam so this module does not import
 * `ipc/trust.ts` (which reads the live set from here) and form a cycle. The root
 * installs the real predicate.
 */
let trustedTarget: (wc: WebContents) => boolean = () => false

export function configureBroadcastTrust(predicate: (wc: WebContents) => boolean): void {
  trustedTarget = predicate
}

function isBroadcastTarget(wc: WebContents): boolean {
  return trustedTarget(wc)
}

const activeTendersWebContents = new Set<WebContents>()
let lastBroadcastJson = ''

export function registerTendersWebContents(wc: WebContents): void {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
  activeTendersWebContents.add(wc)
  if (typeof wc.once === 'function') {
    wc.once('destroyed', () => {
      activeTendersWebContents.delete(wc)
    })
  }
}

export function unregisterTendersWebContents(wc: WebContents): void {
  activeTendersWebContents.delete(wc)
}

export function getActiveTendersWebContents(): WebContents[] {
  return Array.from(activeTendersWebContents).filter(
    (wc) => typeof wc.isDestroyed !== 'function' || !wc.isDestroyed(),
  )
}

/** Drop every registered view (test-only reset). */
export function clearActiveTendersWebContents(): void {
  activeTendersWebContents.clear()
  lastBroadcastJson = ''
}

/**
 * Broadcast a v1 document on `tenders:data-changed`. The legacy stack's only
 * remaining broadcast path; the v2 store has its own (`storeChangedV2`).
 */
export function broadcastTendersData(data: TendersData): void {
  const json = JSON.stringify(data)
  if (Buffer.byteLength(json, 'utf8') > MAX_TENDERS_DOCUMENT_BYTES) return
  lastBroadcastJson = json
  for (const wc of activeTendersWebContents) {
    if (isBroadcastTarget(wc)) {
      try {
        wc.send(TENDERS_CHANNELS.dataChanged, data)
      } catch (err) {
        console.warn('tenders-main: failed to broadcast dataChanged to WebContents:', err)
      }
    }
  }
}

/** The last document broadcast, so the legacy watcher can suppress a repeat. */
export function getLastBroadcastJson(): string {
  return lastBroadcastJson
}

export function setLastBroadcastJson(json: string): void {
  lastBroadcastJson = json
}

// The legacy `tenders-data.json` file watcher — retired from production, kept for
// the tests that pin its behaviour.
//
// Split out of `main/tenders-main.ts` with no behaviour change. `registerTendersIpc`
// no longer starts this watcher at all: `tenders:data-changed` has had zero
// subscribers since the v2 store landed, so a background reader whose result no
// consumer sees is pure risk. The tests that pin the watcher's own behaviour drive
// it directly through `startTendersStoreWatcher`, which is why it still exists and
// why `legacyWatcherAllowed` gates it.
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { readTendersStore } from './legacy-store'
import {
  broadcastTendersData,
  getLastBroadcastJson,
  setLastBroadcastJson,
} from './web-contents-registry'
import { getStoragePath } from './composition-services'

let fileWatcher: FSWatcher | null = null
let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null
let watchedFilePath = ''

/**
 * Is this process a test runner? The legacy store watcher is a deliberate,
 * fully-executed piece of machinery that must not be running in production (see
 * the retirement note above), but the tests that pin its behaviour drive it
 * directly through `startTendersStoreWatcher`.
 */
function legacyWatcherAllowed(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
}

export function startTendersStoreWatcher(targetPath?: string): void {
  // Retirement guard for the production path: `registerTendersIpc` no longer
  // starts the watcher at all (`tenders:data-changed` has had zero subscribers
  // since the v2 store landed), and this second gate means even an accidental
  // re-introduction cannot put a live `fs.watch` back on a shipping build.
  // Tests set VITEST, so the watcher's own suite still exercises it for real.
  if (!legacyWatcherAllowed()) return
  const filePath = targetPath || getStoragePath()
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (fileWatcher) {
    if (watchedFilePath === filePath) {
      return
    }
    stopTendersStoreWatcher()
  }

  watchedFilePath = filePath
  try {
    fileWatcher = watch(dir, (_eventType, filename) => {
      if (filename && filename.includes('tenders-data.json') && !filename.endsWith('.tmp')) {
        if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
        watchDebounceTimer = setTimeout(() => {
          try {
            if (existsSync(filePath)) {
              const currentData = readTendersStore(filePath)
              const currentJson = JSON.stringify(currentData)
              if (currentJson !== getLastBroadcastJson()) {
                setLastBroadcastJson(currentJson)
                broadcastTendersData(currentData)
              }
            }
          } catch (err) {
            console.warn('tenders-main: error in file watcher handler:', err)
          }
        }, 100)
      }
    })
  } catch (err) {
    console.warn('tenders-main: could not start tenders-data.json watcher:', err)
  }
}

export function stopTendersStoreWatcher(): void {
  watchedFilePath = ''
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer)
    watchDebounceTimer = null
  }
  if (fileWatcher) {
    try {
      fileWatcher.close()
    } catch {}
    fileWatcher = null
  }
}

// The Tenders main process ENTRY POINT — and now nothing else.
//
// This file used to be 3,702 lines doing four unrelated jobs at once: the IPC
// surface, the path/demo-seed utility layer, the store wiring, and the
// composition root for the two engines. It is now a thin root that constructs the
// services, owns the test reset, and re-exports each module's public surface.
//
// WHERE EVERYTHING WENT. Each module below is a real unit with one
// responsibility; the code moved verbatim, so nothing about the behaviour
// changed.
//
//   legacy-store.ts           the retired v1 `tenders-data.json` read/validate/write
//   legacy-store-watcher.ts   the retired v1 `fs.watch` (kept for its own tests)
//   tenders-paths.ts          every path decision + the atomic-write primitives
//   diagnostics-sink.ts       the one diagnostics sink and its helpers
//   readiness-snapshot.ts     the submission-readiness gate's snapshot rules
//   document-lifecycle.ts     save/read/open/delete/restore/replace/reconcile
//   seed-workspaces.ts        the v1 demo seed (no longer a data *source*)
//   store-registry.ts         the store seam the modules above reach through
//   composition-services.ts   runtime config + store directory + close-flush map
//   web-contents-registry.ts  the live view set and the v1 broadcast
//   navigation-policy.ts      deny-by-default navigation for the view
//   close-guard.ts            the shell's dirty-close guard
//   ipc/trust.ts              the trusted-sender gate (the security invariant)
//   ipc/handlers.ts           the registration root — no bodies, one call per domain
//   ipc/handlers-store.ts     the store channels: v2 load/save, close-flush reply,
//                             legacy read/write, compliance export (6)
//   ipc/handlers-documents.ts the document lifecycle channels (11)
//   ipc/handlers-discovery.ts the discovery channels (5)
//   ipc/handlers-reminders.ts the reminder channels (3)
//   ipc/handlers-diagnostics.ts the diagnostics channels (2)
//   ipc/handlers-proposals.ts the proposal channel (1)
//   ipc/handlers-cross-app.ts the CRM/Books cross-app channels (5)
//   ipc/engines.ts            the discovery client + reminder scheduler wiring
//   ipc/proposal-payload.ts   the proposal payload bounds
//
// WHY THIS FILE STILL EXPORTS EVERYTHING. `apps/books/src/main/books-main.ts`
// resolves this module by path at runtime and calls `readTendersStore` /
// `writeTendersStore`, and about a dozen Tenders test files import named symbols
// from this exact path. The re-exports below are therefore the module's contract
// and are kept deliberately identical: same names, same signatures, same
// behaviour. Moving a caller is a separate change; this one is structural only.
//
// THE DEPENDENCY DIRECTION IS NOW ONE-WAY. This file no longer imports anything
// from `renderer/`: the demo data it needs comes from `shared/demo-seed.ts`, so
// the renderer's browser-only code (`window.open`, `URL.createObjectURL`,
// `fetch`) can no longer be dragged into the main bundle's import graph.
import { resolve } from 'node:path'
import { rmSync } from 'node:fs'
import { ipcMain } from 'electron'
import { TENDERS_CHANNELS } from '../shared/ipc'
import type { TendersDataV2 } from '../shared/types'
import { createTendersStore, type TendersStore } from './tenders-store'
import { createManagedDocumentStore, type ManagedDocumentStore } from './document-store'
import {
  setTendersEngineOverrides as applyEngineOverrides,
  type TendersEngineOverrides,
} from './ipc/engines'
import { configureDiagnosticsSink, resetDiagnosticsSink } from './diagnostics-sink'
import { configureManagedDocumentStore, configureAuthoritativeStore } from './store-registry'
import { isTrustedTendersWebContents } from './ipc/trust'
import { configureTendersRuntime, clearCloseFlushWaiters } from './composition-services'
import {
  getActiveTendersWebContents,
  broadcastTendersData,
  clearActiveTendersWebContents,
  configureBroadcastTrust,
} from './web-contents-registry'
import { setLegacyTendersBroadcast } from './legacy-store'
import { stopTendersStoreWatcher } from './legacy-store-watcher'
import { getTendersBaseDir } from './tenders-paths'
import {
  claimsClearSubmissionReadiness,
  repairSubmissionReadinessSnapshots,
} from './readiness-snapshot'
import { recordDiagnostic } from './diagnostics-sink'
import { isRecord } from './main-utils'
import { clearTendersIpcRegistered, isTendersIpcRegistered } from './ipc/registration-state'

/** Cache of authoritative stores per resolved directory: one directory, one store. */
const authoritativeTendersStores = new Map<string, TendersStore>()
const managedDocumentStores = new Map<string, ManagedDocumentStore>()

/**
 * Wrap the authoritative store so the submission-readiness gate is part of its
 * COMMIT rather than the prelude of one IPC caller. `saveStoreV2` and the legacy
 * `saveStoredData` channel — plus the internal `mutate` used by CRM sync and
 * milestone billing — all commit through here, so a forged `ready: true` receipt
 * can no longer ride a sibling channel into the store.
 *
 * `restoreRecoveryCandidate` is deliberately not gated: its input is a
 * main-authored backup of a document that already committed through this gate,
 * never a renderer payload.
 */
function gateTendersCommits(store: TendersStore): TendersStore {
  const gate = async (document: unknown, previous: TendersDataV2 | null): Promise<void> => {
    if (!isRecord(document) || !claimsClearSubmissionReadiness(document)) return
    try {
      const repaired = repairSubmissionReadinessSnapshots(
        document as unknown as TendersDataV2,
        previous,
        new Date(),
      )
      if (repaired > 0) {
        const message = `Recomputed ${repaired} submission readiness checkpoint(s) that contradicted canonical readiness.`
        console.warn(`tenders-main: ${message}`)
        recordDiagnostic('warn', 'readiness-gate', message, { recomputed: repaired })
      }
    } catch {
      // A document malformed enough to break the recomputation cannot commit
      // either: the store validates the document before it writes.
    }
  }
  return {
    ...store,
    save: async (request) => {
      // The previously committed document is the baseline the carried-over
      // exemption compares against; read it only when a claim needs checking.
      const previous = claimsClearSubmissionReadiness(request?.document) ? await store.load() : null
      await gate(request?.document, previous?.ok ? previous.data : null)
      return store.save(request)
    },
    mutate: (expectedRevision, mutator) =>
      store.mutate(expectedRevision, async (document) => {
        const proposed = await mutator(document)
        await gate(proposed, document)
        return proposed
      }),
  }
}

/**
 * The authoritative store for the app-owned Tenders directory. There is NO path
 * override: the store location is always resolved in main from
 * `app.getPath('userData')`, so a renderer-supplied path can never reopen the
 * renderer-path hole (all callers pass no argument).
 */
function buildAuthoritativeTendersStore(): TendersStore {
  const directory = resolve(getTendersBaseDir())
  const existing = authoritativeTendersStores.get(directory)
  if (existing) return existing
  const store = gateTendersCommits(
    createTendersStore({
      directory,
      onCommitted: async (document: TendersDataV2) => {
        const failures: string[] = []
        for (const wc of getActiveTendersWebContents()) {
          if (!isTrustedTendersWebContents(wc)) continue
          try {
            wc.send(TENDERS_CHANNELS.storeChangedV2, structuredClone(document))
          } catch (error: unknown) {
            failures.push(error instanceof Error ? error.message : String(error))
          }
        }
        if (failures.length > 0) throw new Error(failures.join('; '))
      },
    }),
  )
  authoritativeTendersStores.set(directory, store)
  return store
}

/** Managed-document metadata store for the active Tenders base directory. */
function buildManagedDocumentStore(overrideUserData?: string): ManagedDocumentStore {
  const directory = resolve(getTendersBaseDir(overrideUserData))
  const existing = managedDocumentStores.get(directory)
  if (existing) return existing
  const store = createManagedDocumentStore({ baseDir: directory })
  managedDocumentStores.set(directory, store)
  return store
}

// ── the composition ──────────────────────────────────────────────────────────
//
// Every injected seam is installed here, in one place, so "who wires what" is a
// question this file answers by being read top to bottom.

// The registry must not import the trust gate (the gate reads the registry), so
// the predicate is installed here, from the one module that owns the trust rule.
configureBroadcastTrust(isTrustedTendersWebContents)
configureManagedDocumentStore(buildManagedDocumentStore)
configureAuthoritativeStore(buildAuthoritativeTendersStore)
// The v1 writer reaches its broadcast through this seam rather than importing the
// v2 registry, which is what keeps `legacy-store.ts` free of store machinery.
setLegacyTendersBroadcast(broadcastTendersData)

/**
 * Replace (or clear) the engine seams. A client or a schedule built from the
 * previous seams is dropped rather than reused: mixing them would make the
 * transport unreproducible in exactly the tests this seam exists for. The
 * diagnostics sink follows the same seams, so a test that injects a sink also
 * points the modules that write to it at that sink.
 */
export function setTendersEngineOverrides(overrides: TendersEngineOverrides | null): void {
  applyEngineOverrides(overrides)
  configureDiagnosticsSink({
    ...(overrides?.diagnosticsLog ? { diagnosticsLog: overrides.diagnosticsLog } : {}),
    ...(overrides?.now ? { now: overrides.now } : {}),
  })
}

/**
 * Is the process running under a test runner? `resetTendersIpcForTests` deletes
 * the real `documents/`, `vault/`, `.trash`, `backups/` and
 * `managed-documents.json` under the user's Tenders directory, so it must never
 * run outside tests. Evaluated per call so a test can prove the refusal.
 */
function tendersTestModeActive(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
}

export function isTendersIpcRegisteredForTests(): boolean {
  return isTendersIpcRegistered()
}

/** Test-only reset of the Tenders IPC surface and the on-disk fixtures. */
export function resetTendersIpcForTests(): void {
  if (!tendersTestModeActive()) {
    throw new Error(
      'resetTendersIpcForTests() is test-only and refuses to delete the user Tenders data.',
    )
  }
  for (const channel of Object.values(TENDERS_CHANNELS)) ipcMain.removeHandler(channel)
  stopTendersStoreWatcher()
  // A pending reminder timer must not outlive the reset: `start()` schedules a
  // real interval, and a test that left one running would keep the process (and
  // the next test's schedule) alive. The engine seams go with it, so the next
  // registration builds its client and schedule from whatever the test sets.
  setTendersEngineOverrides(null)
  clearActiveTendersWebContents()
  authoritativeTendersStores.clear()
  managedDocumentStores.clear()
  // Re-install the store factories: the caches above were just dropped, and the
  // next caller must build a store for the NEW user-data directory.
  configureManagedDocumentStore(buildManagedDocumentStore)
  configureAuthoritativeStore(buildAuthoritativeTendersStore)
  clearCloseFlushWaiters()
  // Drop the memoised diagnostics sink: it is built from `app.getPath('userData')`,
  // which a test changes between cases, so keeping it would point the next case's
  // diagnostics at the previous case's directory.
  resetDiagnosticsSink()
  const baseDirectory = getTendersBaseDir()
  try {
    rmSync(resolve(baseDirectory, 'documents'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(resolve(baseDirectory, 'vault'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(resolve(baseDirectory, '.trash'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(resolve(baseDirectory, 'backups'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(resolve(baseDirectory, 'managed-documents.json'), { force: true })
  } catch {}
  clearTendersIpcRegistered()
}

// Install the store factories at module load: `registerTendersIpc` starts the
// reminder schedule, whose reader reaches the authoritative store before any test
// has had a chance to call the reset above.
configureManagedDocumentStore(buildManagedDocumentStore)
configureAuthoritativeStore(buildAuthoritativeTendersStore)

// ── re-exports: the module's contract, unchanged ─────────────────────────────

export { configureTendersRuntime, type TendersRuntimeConfig } from './composition-services'

export {
  getTendersBaseDir,
  getTendersDocumentsDir,
  getTendersVaultDir,
  resolveSafeTendersPath,
  resolveConfinedTendersPath,
  atomicWriteDocumentFile,
  renameWithBoundedRetry,
  getUniqueTimestamp,
} from './tenders-paths'

export {
  getTendersDiagnosticsLog,
  tendersDiagnosticsPath,
  setTendersDiagnosticsLogForTests,
} from './diagnostics-sink'

export {
  CURRENT_TENDERS_SCHEMA_VERSION,
  LEGACY_TENDERS_READ_FAILED,
  LegacyTendersReadError,
  migrateAndValidateTenders,
  readTendersStore,
  writeTendersStore,
} from './legacy-store'

export { startTendersStoreWatcher, stopTendersStoreWatcher } from './legacy-store-watcher'

export { SEED_COMPANY_ID, SEED_TENDER_WTR_04, createDefaultSeedWorkspaces } from './seed-workspaces'

export {
  claimsClearSubmissionReadiness,
  repairSubmissionReadinessSnapshots,
} from './readiness-snapshot'

export {
  saveDocumentFile,
  readDocumentFile,
  openDocumentFile,
  deleteDocumentFile,
  listDocumentTrashFile,
  restoreDocumentFile,
  replaceDocumentFile,
  reconcileDocumentFiles,
  cleanupDocumentTrash,
  listRecoveryCandidatesFile,
  restoreRecoveryCandidateFile,
} from './document-lifecycle'

export {
  registerTendersWebContents,
  unregisterTendersWebContents,
  getActiveTendersWebContents,
  broadcastTendersData,
} from './web-contents-registry'

export { TENDERS_DEMO_WRITE_ERROR, tendersNotWonBillingError } from './composition-services'

export type {
  DiscoveryDocumentResponse,
  DiscoveryDocumentFetch,
  TendersEngineOverrides,
} from './ipc/engines'

export {
  DISCOVERY_DOWNLOAD_TIMEOUT_MS,
  DISCOVERY_DOWNLOAD_MAX_REDIRECTS,
  startTendersReminders,
  stopTendersReminders,
  downloadDiscoveryDocument,
  discoveryDocumentFileName,
  validateReminderSettingsPatch,
} from './ipc/engines'

export { registerTendersIpc } from './ipc/handlers'

export { applyTendersNavigationPolicy, createTendersView } from './navigation-policy'

export { requestTendersClose } from './close-guard'

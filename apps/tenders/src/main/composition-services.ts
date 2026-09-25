// The services and live state the composition root owns and the IPC handlers use.
//
// Split out of `main/tenders-main.ts` with no behaviour change. `tenders-main.ts`
// is still the composition root — it CONSTRUCTS all of this — but the handlers
// reach it through this module, so the handler registry does not have to import
// the root (which imports the handler registry) and there is no cycle.
//
// What is wired here, and by whom:
//   * `runtime`              — `configureTendersRuntime` (this module).
//   * `getIntegrations` / `openOwningApp` — built from the integrations port.
//   * `getStoragePath`, the legacy recovery list, the legacy-read note and
//     `findTenderById` — small helpers whose only dependency is a module.
//   * the close-flush waiter map — shared with the dirty-close guard.
import { join } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { app } from 'electron'
import type { TenderRecord, TendersDataV2 } from '../shared/types'
import type { TendersRecoveryCandidate } from '../shared/tenders-persistence'
import {
  resolveTendersIntegrations,
  setInjectedTendersIntegrations,
  type TendersIntegrations,
} from './integrations'
import { getTendersBaseDir } from './tenders-paths'
import { recordDiagnostic, noteLegacyReadFailure } from './diagnostics-sink'
import type { TendersCloseFlushResult } from '../shared/ipc'
import { configureTrustedRenderer } from './ipc/trust'

/** The runtime configuration the shell installs before a view is created. */
export interface TendersRuntimeConfig {
  preloadPath: string
  rendererUrl?: string | undefined
  rendererFile: string
  openGeneratedPath?: (path: string) => boolean
  onOpenCrm?: (dealId?: string) => void
  onOpenBooks?: (invoiceId?: string) => void
  /**
   * Composition-root injected cross-app ports (CRM/Books). Omit to use the
   * built-in adapters; pass `{}` to run with integrations disabled.
   */
  integrations?: TendersIntegrations
}

/**
 * The live runtime configuration. Deliberately a single MUTATED object rather
 * than a reassigned binding: handlers hold a reference to it for the life of the
 * process, so replacing the object would leave them reading the old one.
 */
export const runtime: TendersRuntimeConfig = {
  preloadPath: '',
  rendererFile: '',
}

export function configureTendersRuntime(config: TendersRuntimeConfig): void {
  if ('integrations' in config) setInjectedTendersIntegrations(config.integrations)
  Object.assign(runtime, config)
  // The trusted-sender gate reads the renderer origin/file from its own module,
  // so the two must never disagree. Installed from the MERGED runtime rather than
  // the patch: a later call that names only `openGeneratedPath` must not blank the
  // renderer origin an earlier call established.
  configureTrustedRenderer({
    rendererUrl: runtime.rendererUrl,
    rendererFile: runtime.rendererFile,
  })
}

/** Effective cross-app ports (injected by the shell, else built-in adapters). */
export function getIntegrations(): TendersIntegrations {
  return resolveTendersIntegrations({ userDataDir: app.getPath('userData') })
}

/** Open the owning app at a returned entity (CRM deal / Books invoice). */
export function openOwningApp(target: { app: 'crm' | 'books'; entityId?: string }): void {
  const integrations = getIntegrations()
  if (integrations.openAppAt) {
    integrations.openAppAt(target)
    return
  }
  // Legacy runtime callbacks remain supported for callers that have not
  // migrated to the typed `openAppAt` port.
  if (target.app === 'crm') runtime.onOpenCrm?.(target.entityId)
  else runtime.onOpenBooks?.(target.entityId)
}

/** The path of the legacy v1 store file. */
export function getStoragePath(): string {
  return join(getTendersBaseDir(), 'tenders-data.json')
}

/** Resolve a tender from the authoritative document (never from renderer paths). */
export function findTenderById(
  document: TendersDataV2,
  tenderId: string,
): { workspace: TendersDataV2['workspaces'][number]; tender: TenderRecord } | null {
  for (const workspace of document.workspaces) {
    const tender = workspace.tenders.find((candidate) => candidate.id === tenderId)
    if (tender) return { workspace, tender }
  }
  return null
}

/**
 * The recoverable copies main can see for a legacy file it could not read: the
 * `.corrupted.bak` it just quarantined alongside the live file. Deliberately NOT
 * the v2 store's own candidate list — that store owns a different document, and
 * offering its backups for a v1 file would be a recovery path that restores the
 * wrong thing.
 */
export function listLegacyRecoveryCandidates(): TendersRecoveryCandidate[] {
  const candidates: TendersRecoveryCandidate[] = []
  const directory = getTendersBaseDir()
  try {
    for (const name of readdirSync(directory)) {
      if (!/\.corrupted\.bak$/.test(name)) continue
      const full = join(directory, name)
      try {
        const information = statSync(full)
        candidates.push({
          id: name,
          path: name,
          source: 'primary',
          reason: 'Quarantined copy of the file that could not be read.',
          updatedAt: information.mtime.toISOString(),
          valid: false,
          sizeBytes: information.size,
        })
      } catch {
        // the copy disappeared between listing and stat
      }
    }
  } catch {
    // the directory is unreadable; the failure above is the one to report
  }
  return candidates
}

/** Resolvers for close-flush requests main has sent and not yet heard back about. */
export const closeFlushWaiters = new Map<
  number,
  { webContentsId: number; settle: (result: TendersCloseFlushResult | null) => void }
>()

export { recordDiagnosticsStart, tendersAppVersion } from './diagnostics-sink'

/** Drop every pending close-flush waiter (test-only reset). */
export function clearCloseFlushWaiters(): void {
  closeFlushWaiters.clear()
}

/** The Tenders demo-isolation refusal for a cross-app write from demo data. */
export const TENDERS_DEMO_WRITE_ERROR =
  'Demo workspace: CRM sync and Books billing are disabled for demonstration data.'

/** Main-side won-only gate for milestone billing (mirrors `milestonesAllowed`). */
export const tendersNotWonBillingError = (status: string): string =>
  `Milestone billing is only allowed for a won tender. Current status: ${status}.`

export { noteLegacyReadFailure }

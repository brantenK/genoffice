// The Tenders IPC surface — the registration root.
//
// This file is what `main/tenders-main.ts`, `main/navigation-policy.ts` and the
// tests import: `registerTendersIpc()` registers **all thirty-three**
// `ipcMain.handle` channels, once per process. It does not hold the handler
// bodies any more; it calls the focused module that owns each domain, in order,
// and the whole security posture still rests on the one invariant stated here:
//
//   **Every handler body begins with `isTrustedTendersEvent`** (in `ipc/trust.ts`).
//
// A request that fails that gate returns its channel's unauthorized answer and
// reaches no side effect at all — not a store read, not a disk write, not a
// network call. The gate is called from each handler body rather than from a
// wrapper around it, so the invariant is a property of the bodies and can be
// checked by parsing them (the docs wave's brace-matched check does exactly that).
//
// Beyond the gate, each module validates the SHAPE of what it was sent and passes
// the meaning on: the discovery client owns what a window, an ocid or a document
// link means, the store owns what a revision conflict is, and no module re-words
// either one's answer.
//
// The domains, in registration order:
//
//   handlers-startup.ts      the work that must precede every channel (no channel)
//   handlers-store.ts        authoritative v2 load/save, close-flush reply,
//                            legacy read/write, compliance-matrix export (6)
//   handlers-documents.ts    documents, trash, recovery candidates (11)
//   handlers-discovery.ts    the feed list/cache/refresh/release/download (5)
//   handlers-reminders.ts    reminder settings and a manual check (3)
//   handlers-diagnostics.ts  the renderer's failure report and the log path (2)
//   handlers-proposals.ts    the proposal draft, the one channel that may emit
//                            "ready" language (1)
//   handlers-cross-app.ts    CRM sync/outcome/open and Books tab + milestone
//                            billing (5)
//
// The domain table above sums to 6 + 11 + 5 + 3 + 2 + 1 + 5 = 33 channels — the
// figure `TENDERS_CHANNELS` declares and the figure a per-module
// `grep -cE "^\s*ipc\.handle"` still reproduces.
import { ipcMain } from 'electron'
import { markTendersIpcRegistered, isTendersIpcRegistered } from './registration-state'
import type { TendersIpcContext, TendersIpcRegistry } from './handler-context'
import { runTendersIpcStartup } from './handlers-startup'
import { registerTendersStoreChannels } from './handlers-store'
import { registerTendersDocumentChannels } from './handlers-documents'
import { registerTendersDiscoveryChannels } from './handlers-discovery'
import { registerTendersReminderChannels } from './handlers-reminders'
import { registerTendersDiagnosticsChannels } from './handlers-diagnostics'
import { registerTendersProposalChannels } from './handlers-proposals'
import { registerTendersCrossAppChannels } from './handlers-cross-app'

export function registerTendersIpc(ipc: TendersIpcRegistry = ipcMain): void {
  if (isTendersIpcRegistered()) return

  const context: TendersIpcContext = {
    startupRan: false,
    onStartup: (run) => {
      run()
      context.startupRan = true
    },
    onChannels: (register) => {
      // Every channel module is registered after the startup work, so a channel
      // can never read a store or a schedule that does not exist yet.
      if (!context.startupRan) {
        throw new Error('Tenders IPC channels were registered before the startup work ran.')
      }
      register()
    },
  }

  context.onStartup(runTendersIpcStartup)

  context.onChannels(() => {
    registerTendersStoreChannels(ipc)
    registerTendersDocumentChannels(ipc)
    registerTendersDiscoveryChannels(ipc)
    registerTendersReminderChannels(ipc)
    registerTendersDiagnosticsChannels(ipc)
    registerTendersProposalChannels(ipc)
    registerTendersCrossAppChannels(ipc)
  })

  markTendersIpcRegistered()
}

// The shared shape of one IPC registration module.
//
// Split out of `ipc/handlers.ts` with no behaviour change. `handlers.ts` remains
// the thing that REGISTERS every channel — it calls each module below, in order,
// from `registerTendersIpc` — and this module is the one contract they all share.
//
// Two rules are worth stating once, here, because every registration module
// depends on them:
//
//  1. **The context carries no capability.** `TendersIpcContext` is a handle to
//     the ONE registration pass that is running: the ordering flag the startup
//     work sets, and the two "register the channels I own" callbacks. It holds no
//     store, no engine and no runtime config — every one of those is reached by
//     importing it from the module that owns it (`store-registry.ts`,
//     `composition-services.ts`, `ipc/engines.ts`, …). Making the context a
//     dependency bag instead would be the classic god-object failure: the whole
//     main-process surface would be reachable from a parameter.
//
//  2. **`isTrustedTendersEvent` is the first statement of every handler body.**
//     It is deliberately NOT hoisted into a wrapper that takes the handler as a
//     callback: a wrapper would put the gate one call frame away from the
//     handler, and the invariant is a property of the handler bodies. Each
//     module re-imports the gate from `./trust` and calls it first.
import type { ipcMain } from 'electron'

/** The one registration pass's ordering flag, owned by `handlers.ts`. */
export interface TendersIpcContext {
  /**
   * Whether the startup work that must precede every channel has run. Set by the
   * `onStartup` callback registered first, read by `onChannels` — so a caller
   * that (incorrectly) registered a channel module before the startup module
   * gets a hard failure rather than a half-registered surface.
   */
  startupRan: boolean
  /** Register the startup work that must precede every channel, exactly once. */
  onStartup: (run: () => void) => void
  /** Register the channels a module owns, run after the startup work. */
  onChannels: (register: () => void) => void
}

/** The Electron `ipcMain` surface a registration module needs (injectable for tests). */
export type TendersIpcRegistry = Pick<typeof ipcMain, 'handle'>

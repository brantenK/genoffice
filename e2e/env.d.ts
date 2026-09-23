/**
 * Ambient declarations for the globals the e2e specs reach through
 * `page.evaluate`. `e2e/` deliberately sits outside every app's tsconfig — it
 * drives *built* apps rather than importing them — so the handful of preload
 * surfaces the specs touch are declared here.
 *
 * Keep this in step with the preloads: a spec that needs a new surface should add
 * it here rather than cast, so the lane stays honest. The three APIs are the real
 * exported interfaces, not copies, so they cannot drift.
 */
import type { HomeApi } from '../apps/shell/src/shared/home-api'
import type { TabsApi } from '../apps/shell/src/shared/tabs-api'
import type { TendersApi } from '../apps/tenders/src/shared/ipc'

declare global {
  interface Window {
    /** shell preload: `exposeInMainWorld('aiOffice', homeApi)` */
    aiOffice: HomeApi
    /** shell preload: `exposeInMainWorld('aiOfficeTabs', tabsApi)` */
    aiOfficeTabs: TabsApi
    /** tenders preload: `exposeInMainWorld('tendersApi', tendersApi)` — optional
     *  because apps/tenders/src/shared/ipc.ts declares it that way itself. */
    tendersApi?: TendersApi
    /** axe-core, injected by the accessibility specs */
    axe?: unknown
    /** dev-only hooks, present only under GENOFFICE_DEBUG_HOOKS=1 */
    __genofficeDebug?: Record<string, (...args: never[]) => unknown>
    __genofficeDebugHooks?: boolean
  }
}

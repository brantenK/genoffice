// Sample ("demo") workspace content + origin helpers — Phase 4, WP-8.
//
// The sample workspace is deliberately isolated:
//   - it is created ONLY from the explicit first-use choice (never as a fallback
//     when a real workspace fails to load or is missing);
//   - it carries `dataOrigin: 'demo'` so every surface can label it and keep it
//     out of real bid work;
//   - its records are clones, so nothing is shared with the mocks — or with a
//     second sample workspace.
//
// The cross-app gate IS wired: `crossAppWritesBlocked()` (TenderLifecyclePanel)
// is consumed by Workspace/MilestonesDrawer to disable CRM sync and Books
// billing from a sample workspace, and is built on the `isSampleWorkspace()`
// guard below. Main enforces the same demo-origin rejection on its handlers.
import type { CompanyProfile, Customer, TendersWorkspaceV2, VaultDoc } from '../../shared/types'
import { MOCK_COMPANY } from './company'
import { MOCK_CUSTOMERS } from './customers'
import { MOCK_VAULT } from './vault'

/** Label shown wherever a sample workspace is referenced. */
export const SAMPLE_WORKSPACE_LABEL = 'Sample workspace'

export interface SampleWorkspaceContent {
  company: CompanyProfile
  customers: Customer[]
  vault: VaultDoc[]
}

/**
 * Fresh clones of the sample company, customers and documents.
 *
 * The renderer hands this to the authoritative `addDemoWorkspace(content)` store
 * action (which forces `dataOrigin: 'demo'`); see `components/FirstUsePage.tsx`.
 */
export function createSampleWorkspaceContent(): SampleWorkspaceContent {
  return structuredClone({
    company: MOCK_COMPANY,
    customers: MOCK_CUSTOMERS,
    vault: MOCK_VAULT,
  })
}

/** True when a workspace holds sample data (never the user's own records). */
export function isSampleWorkspace(workspace: { dataOrigin?: string } | null | undefined): boolean {
  return workspace?.dataOrigin === 'demo'
}

/**
 * A ready-to-persist sample workspace record (`dataOrigin: 'demo'`), with no
 * tenders — the user shreds one to try the workflow. Pure: the caller decides how
 * to put it into the store.
 */
export function createSampleWorkspaceRecord(id: string): TendersWorkspaceV2 {
  const content = createSampleWorkspaceContent()
  return {
    id,
    name: SAMPLE_WORKSPACE_LABEL,
    dataOrigin: 'demo',
    company: content.company,
    customers: content.customers,
    vault: content.vault,
    tenders: [],
  }
}

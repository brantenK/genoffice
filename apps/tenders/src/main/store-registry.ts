// The two main-process stores, held as ONE registry so every module that needs a
// store depends on this file rather than on the composition root.
//
// Split out of `main/tenders-main.ts` with no behaviour change. The stores
// themselves are built in `tenders-main.ts`; this module is the seam that hands
// them to the modules that use them, which is what keeps `ipc/engines.ts` and
// `ipc/handlers.ts` from importing the root and forming a cycle.
//
// The factories are installed by the root's composition block. A module that
// reaches for a store before that has run gets a clear refusal rather than a
// half-built store.
import { resolve } from 'node:path'
import { createManagedDocumentStore, type ManagedDocumentStore } from './document-store'
import { createTendersStore, type TendersStore } from './tenders-store'
import { getTendersBaseDir } from './tenders-paths'
import { TENDERS_CHANNELS } from '../shared/ipc'
import type { TendersDataV2 } from '../shared/types'

let managedStoreFactory: ((overrideUserData?: string) => ManagedDocumentStore) | null = null
let authoritativeStoreFactory: (() => TendersStore) | null = null

/** Install the factory that resolves the managed-document store for a directory. */
export function configureManagedDocumentStore(
  factory: (overrideUserData?: string) => ManagedDocumentStore,
): void {
  managedStoreFactory = factory
}

/** Install the factory that resolves the authoritative v2 store. */
export function configureAuthoritativeStore(factory: () => TendersStore): void {
  authoritativeStoreFactory = factory
}

/** The managed-document metadata store for the active base directory. */
export function managedDocumentStore(overrideUserData?: string): ManagedDocumentStore {
  if (!managedStoreFactory) {
    throw new Error('The managed document store was never configured.')
  }
  return managedStoreFactory(overrideUserData)
}

/** The authoritative v2 store for the app-owned Tenders directory. */
export function authoritativeStore(): TendersStore {
  if (!authoritativeStoreFactory) {
    throw new Error('The authoritative Tenders store was never configured.')
  }
  return authoritativeStoreFactory()
}

/**
 * Drop both memoised stores, so the next use rebuilds them against the current
 * `userData`. A test that changes the user-data directory between cases must not
 * be handed the previous case's store.
 */
export function resetStoreCaches(): void {
  managedStoreFactory = null
  authoritativeStoreFactory = null
}

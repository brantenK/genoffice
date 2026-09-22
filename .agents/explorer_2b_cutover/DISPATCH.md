# Dispatch: explorer_2b_cutover

- **Task**: Architecture and Implementation Plan for Renderer v2 Persistence Cutover (Phase 2 / Task 2B)
- **Agent Directory**: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_2b_cutover
- **Original Request**: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md
- **References**:
  - `docs/tenders-hardening/README.md`
  - `docs/tenders-hardening/contracts-and-invariants.md`
  - `docs/tenders-hardening/phase-2-remaining.md`
  - `apps/tenders/src/shared/tenders-persistence.ts`
  - `apps/tenders/src/shared/ipc.ts`
  - `apps/tenders/src/preload/index.ts`
  - `apps/tenders/src/main/tenders-store.ts`

## Objective
Thoroughly explore the Tenders renderer codebase and formulate the exact implementation plan for cutting renderer persistence over from localStorage to the authoritative v2 store (`loadStoreV2`, `saveStoreV2`, `onStoreChangedV2`), designing the `SaveStatus` UI component, removing domain data from `localStorage`, and retiring legacy IPC.

## Areas to Investigate
1. `apps/tenders/src/renderer/src/store.ts`:
   - Inspect existing state structure, Zustand configuration, mutations, and localStorage sync.
   - Design how the store will hold the authoritative snapshot, track `revision`, handle optimistic or queued updates, and commit via `saveStoreV2({ expectedRevision, document })`.
   - Ensure uncommitted local edits are preserved on save failures and that `REVISION_CONFLICT` is handled cleanly.
2. `apps/tenders/src/renderer/src/components/App.tsx`:
   - Inspect the hydration lifecycle.
   - Design handling for all four `loadStoreV2()` outcomes:
     - `not-found`: Clean empty workspace (no demo seeding).
     - `migrated` (`needsSave: true`): Render migrated data, commit once via `saveStoreV2({ expectedRevision: 0, document })`. Guard against React StrictMode double-invocation duplicate commits.
     - `loaded`: Direct active state initialization.
     - Failure (`READ_FAILED` / `UNSUPPORTED_SCHEMA_VERSION`): Render explicit error/recovery UI without overwriting or synthesizing empty.
   - Design the `onStoreChangedV2` multi-window sync listener and unmount cleanup.
3. Domain vs UI `localStorage`:
   - Search all references to `localStorage` across `apps/tenders/src/renderer/`.
   - Strip all domain records (workspaces, tenders, customers, vault docs) from `localStorage`.
   - Define a UI-only preferences key (for page, zoom, pane widths, etc.).
4. Legacy IPC channels:
   - Identify all components calling `getStoredData` and `saveStoredData` and plan their cutover to the v2 store.
5. Save State UI (`components/SaveStatus.tsx`):
   - Design the component states: Loading, Saving, Saved, Save Failed (with Retry), Conflict.
   - Identify where in the workspace chrome/header to mount `SaveStatus`.
   - Verify that all styling uses GenOffice CSS theme variables (no raw hex or rgb) to strictly satisfy `npm run check:theme-colors`.
6. Testing & Quality Strategy:
   - Identify unit/integration tests in `apps/tenders/tests/` to add or update.
   - Formulate E2E test scenarios for hydration, CAS mutation, conflict, and retry.

## Deliverables
Produce a comprehensive `analysis.md` and structured `handoff.md` detailing the exact files to modify/create, the data flow, code snippets, edge-case protections, and recommended implementation sequence for the worker.

## 2026-09-15T16:26:14Z
You are explorer_2b_cutover.
Your working directory is: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_2b_cutover.
Read your dispatch instructions at C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_2b_cutover\DISPATCH.md and the original request at C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md.
Also review:
- docs/tenders-hardening/README.md
- docs/tenders-hardening/contracts-and-invariants.md
- docs/tenders-hardening/phase-2-remaining.md
- apps/tenders/src/renderer/src/store.ts
- apps/tenders/src/renderer/src/components/App.tsx
- apps/tenders/src/shared/tenders-persistence.ts
- apps/tenders/src/shared/ipc.ts
- apps/tenders/src/preload/index.ts
- apps/tenders/src/main/tenders-store.ts

Your task is to explore and produce a comprehensive technical blueprint and implementation plan for cutting renderer persistence over from localStorage to the authoritative v2 store (loadStoreV2, saveStoreV2, onStoreChangedV2), implementing SaveStatus.tsx, removing domain data from localStorage, and retiring legacy IPC.
Write your analysis to analysis.md and complete handoff to handoff.md in your working directory.
When finished, send a message to parent with the summary and reference to handoff.md.


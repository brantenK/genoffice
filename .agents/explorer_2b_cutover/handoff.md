# Handoff Report: Renderer v2 Persistence Cutover Blueprint (Phase 2 / Task 2B)

## 1. Observation
1. **Existing Test Suite State**:
   - Running `npm test -w @genoffice/tenders` yields **588 passed tests** across 9 test files, with exactly 2 test files failing:
     - `apps/tenders/tests/renderer-store-v2.test.ts`: 12 failing tests out of 12. These are the explicit RED specifications for Task 2B (`hydrateFromMain`, `reloadCommittedFromMain`, `retrySave`, `hasWorkspaces`, migration single-commit, `saveStatus` states, and localStorage domain purging).
     - `apps/tenders/tests/pdf-box-bounds.test.ts`: 8 failing tests out of 8 due to missing exports (`clampNormalizedBox` and `unionBoxes` in `apps/tenders/src/renderer/src/pdf/extract.ts`).
2. **Current Store & LocalStorage**:
   - In `apps/tenders/src/renderer/src/store.ts`:
     - Line 260: `persist(..., { name: 'zanostack-tenders-v1', version: 1, partialize: (s) => ({ workspaces: s.workspaces.map(...), activeCompanyId: s.activeCompanyId, ... }), onRehydrateStorage: ... })`.
     - Lines 548–555: Automatically synthesizes `SEED_TENDER_WTR_04` if the tender list is empty.
     - Lines 233–257: `scheduleSaveToMain()` calls legacy `window.tendersApi?.saveStoredData(json)` without revision tracking.
     - Lines 461–489: `loadFromMain()` calls legacy `getStoredData()` and overwrites disk with demo data if empty.
3. **Legacy IPC Channels in Renderer**:
   - `getStoredData`, `saveStoredData`, and `onDataChanged` are used exclusively in `store.ts` (lines 235, 253, 462, 466, 485) and `App.tsx` (line 45). No other files in the renderer call them.
4. **Preload & Main Process Support**:
   - `apps/tenders/src/preload/index.ts` lines 84–91 already expose `loadStoreV2`, `saveStoreV2`, and `onStoreChangedV2`.
   - `apps/tenders/src/main/tenders-store.ts` and `tenders-main.ts` lines 844–872 already handle `loadStoreV2` and `saveStoreV2` with CAS revision checks, while line 305 broadcasts `store-changed-v2`.
5. **UI Components Drafted**:
   - `apps/tenders/src/renderer/src/components/SaveStatus.tsx` (93 lines) and `FirstRunEmpty.tsx` (43 lines) are already written and pass `npm run check:theme-colors` with 0 violations.

---

## 2. Logic Chain
1. **Separation of Authoritative Domain Data from Transient UI Preferences**:
   - Because `tenders-data.json` is the sole authoritative store owned by the main process, `store.ts` must act as an in-memory cache over the authoritative snapshot.
   - Because `renderer-store-v2.test.ts` checks that `localStorage` does not contain `"workspaces"`, `"tenders"`, `"customers"`, or `"vault"`, the Zustand `persist` middleware must be reconfigured to store only UI settings (`page`, `view`, `zoom`, `currentPage`, `onboardingDone`) under key `'zanostack-tenders-ui'`.
2. **Hydration Lifecycle Guarantees**:
   - `loadStoreV2` returns one of four statuses:
     - `'not-found'`: The store must clear all domain state to empty (`workspaces: []`, `activeCompanyId: null`, `hasWorkspaces: false`), without seeding demo tenders and without calling `saveStoreV2`.
     - `'loaded'`: The store directly adopts `res.data`, updates `committedRevision = res.data.revision`, and sets `hasWorkspaces: res.data.workspaces.length > 0`.
     - `'migrated'`: The store adopts the data. If `res.needsSave: true`, it commits once via `saveStoreV2({ expectedRevision: 0, document: res.data })`. An in-memory guard `isMigrating` prevents React StrictMode double-invocation from issuing duplicate saves.
     - Failure (`res.ok === false`): The store transitions to `hydrationStatus: 'error'`, preserving existing disk data without synthesizing empty state or overwriting.
3. **Compare-And-Swap (CAS) Mutation & Conflict Prevention**:
   - Domain mutations update local state optimistically, set `saveStatus: 'saving'`, and trigger debounced `saveStoreV2({ expectedRevision: committedRevision, document })`.
   - On success, `committedRevision` advances to `result.data.revision` and `saveStatus: 'saved'`.
   - On `WRITE_FAILED` or network error, local edits are preserved, `saveStatus: 'error'`, and the user can invoke `retrySave()` which retries with the same `committedRevision`.
   - On `REVISION_CONFLICT`, the store sets `saveStatus: 'conflict'`. It deliberately avoids blind overwrites. The user or UI calls `reloadCommittedFromMain()`, which fetches the latest disk snapshot and resets the conflict state.
4. **Multi-Window Sync**:
   - During hydration or initialization, `window.tendersApi.onStoreChangedV2` is subscribed.
   - When a notification arrives with `data.revision > committedRevision`, the store adopts the external document and advances `committedRevision = data.revision`.
   - If `data.revision <= committedRevision`, the notification is ignored as an echo or stale commit.
5. **PDF Bounding Box Safety Invariant**:
   - Shredding floating-point division causes `left + width > 1` by minute epsilon, which triggers `INVALID_DATA` in `validateTendersDataV2`.
   - Adding `clampNormalizedBox` in `apps/tenders/src/renderer/src/pdf/extract.ts` ensures all emitted boxes stay strictly within `[0, 1]`, fixing `tests/pdf-box-bounds.test.ts` and preventing rejection of shredded tenders.

---

## 3. Caveats
1. **Deferred Durability Scope (Do NOT Implement in Task 2B)**:
   - Rotating multi-file backups with candidate recovery UI.
   - Managed-file trash/undo lifecycle and orphan reconciliation.
   - Main-owned trusted readiness snapshot binding for positive proposals.
2. **Preload Rebuild Requirement**:
   - Any modifications to `src/main/`, `src/preload/`, or `src/shared/` require running `npm run build -w @genoffice/tenders` and `npm run build -w @genoffice/shell` before running built-Electron tests.
3. **Environment Limitations**:
   - Root-level `npm test` has known timeouts in unrelated workspaces (`@genoffice/docx-engine`). Always use `-w @genoffice/tenders`.

---

## 4. Conclusion
The path for cutting renderer persistence over to the authoritative v2 store is fully specified, verified against the frozen test suite, and ready for implementation by `worker_2b_cutover`:
1. Implement `clampNormalizedBox` and `unionBoxes` in `apps/tenders/src/renderer/src/pdf/extract.ts` (turns `pdf-box-bounds.test.ts` 8/8 GREEN).
2. Refactor `apps/tenders/src/renderer/src/store.ts` to implement the authoritative v2 state machine, CAS saving, and UI-only localStorage (turns `renderer-store-v2.test.ts` 12/12 GREEN).
3. Update `apps/tenders/src/renderer/src/components/App.tsx` with hydration lifecycle handling, `FirstRunEmpty` routing, and mount `SaveStatus.tsx`.
4. Run all repo verification guards (all 608 tests passing, typecheck clean, builds clean, theme check clean, format check clean).

---

## 5. Verification Method
The implementer can independently verify this plan by running:

```powershell
# 1. Verify bounding box fix
npm test -w @genoffice/tenders -- tests/pdf-box-bounds.test.ts

# 2. Verify renderer store cutover
npm test -w @genoffice/tenders -- tests/renderer-store-v2.test.ts

# 3. Full Tenders test suite (must achieve 608/608 passing)
npm test -w @genoffice/tenders

# 4. Typecheck
npm run typecheck -w @genoffice/tenders

# 5. Application and shell builds
npm run build -w @genoffice/tenders
npm run build -w @genoffice/shell

# 6. Repository hygiene guards
npm run check:theme-colors
npm run format:check
```

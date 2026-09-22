# Handoff Report: Renderer v2 Persistence Cutover (Phase 2 / Task 2B)

## 1. Observation

1. **Target Files & Changes**:
   - `apps/tenders/src/renderer/src/pdf/extract.ts`:
     - Implemented and exported `clampNormalizedBox` and `unionBoxes` bounding box normalizers that strictly enforce `0 <= left + width <= 1` and `0 <= top + height <= 1` within IEEE-754 precision limits.
     - Routed all text line extractions through `clampNormalizedBox`.
   - `apps/tenders/src/renderer/src/store.ts`:
     - Refactored `useTendersStore` to implement the authoritative v2 store lifecycle: `hydrationStatus` (`'loading' | 'ready' | 'error'`), `hydrationError`, `saveStatus` (`'loading' | 'saving' | 'saved' | 'error' | 'conflict'`), `saveError`, and `hasWorkspaces`.
     - Implemented `hydrateFromMain` handling all 4 hydration states (`not-found` with clean zero-demo workspaces, `loaded` with committed snapshot adoption, `migrated` with single-commit guard at `expectedRevision: 0`, and explicit `error` preserving disk state).
     - Implemented atomic compare-and-swap (CAS) save scheduling (`scheduleSaveToMain`) with debouncing at `expectedRevision === committedRevision`, conflict detection (`saveStatus: 'conflict'`), retry (`retrySave()`), and reload (`reloadCommittedFromMain()`).
     - Subscribed to multi-window broadcast sync listener `onStoreChangedV2` to adopt newer revisions while ignoring echo loops.
     - Configured UI-only localStorage persistence under key `'zanostack-tenders-ui'`, purging all domain data (`workspaces`, `tenders`, `customers`, `vault`).
   - `apps/tenders/src/renderer/src/components/App.tsx`:
     - Wired `hydrateFromMain()` on mount in `useEffect`.
     - Added calm loading state with centered `Spinner` when `hydrationStatus === 'loading'`.
     - Added explicit error boundary state with retry action when `hydrationStatus === 'error'`.
     - Rendered `FirstRunEmpty` with `onCreateCompany` modal trigger when `hydrationStatus === 'ready' && !hasWorkspaces`.
     - Mounted `<SaveStatus />` in the sidebar header with `saveStatus`, `saveError`, `retrySave`, and `reloadCommittedFromMain`.
   - `apps/tenders/src/renderer/src/components/Workspace.tsx`:
     - Mounted `<SaveStatus />` in the top header toolbar (`div.ml-auto.flex.items-center`).
   - `apps/tenders/src/renderer/src/components/pages/TutorialsPage.tsx`:
     - Adjusted legacy copy referencing localStorage to describe local application data storage on disk.

2. **Verification Command Results**:
   - `npm test -w @genoffice/tenders -- tests/pdf-box-bounds.test.ts`: 8/8 tests passed.
   - `npm test -w @genoffice/tenders -- tests/renderer-store-v2.test.ts`: 12/12 tests passed.
   - `npm test -w @genoffice/tenders`: 608/608 tests passed across 11 test suites (0 failures).
   - `npm run typecheck -w @genoffice/tenders`: Exited with code 0 (0 errors).
   - `npm run build -w @genoffice/tenders`: Exited with code 0 (clean Vite SSR and client bundle).
   - `npm run build -w @genoffice/shell`: Exited with code 0 (clean Electron and web bundle).
   - `npm run check:theme-colors`: Exited with code 0 ("No new raw colors in renderer CSS").
   - `npm run format:check`: Exited with code 0 ("All matched files use Prettier code style!").

---

## 2. Logic Chain

1. **Schema Integrity & PDF Coordinate Normalization**:
   - The authoritative v2 schema (`tenders-schema.ts`) rejects any document containing a bounding box where `left + width > 1` or `top + height > 1`.
   - PDF viewport coordinate transforms can drift above 1.0 due to IEEE-754 floating point calculations.
   - By implementing `clampNormalizedBox` and `unionBoxes` in `extract.ts` and passing every extracted page item through it, all bounding boxes are guaranteed to be within `[0, 1]`, preventing schema validation failures during `saveStoreV2`.
2. **Authoritative Persistence & Elimination of Dual State**:
   - `localStorage` previously held domain records, resulting in split-brain state between disk and renderer memory.
   - Reconfiguring Zustand's `persist` middleware to `'zanostack-tenders-ui'` ensures only navigation and display preferences (`page`, `view`, `zoom`, `currentPage`, `onboardingDone`, `activeTenderId`, `activeRequirementId`) are stored in `localStorage`.
   - All domain state is hydrated directly from `loadStoreV2` and updated via `saveStoreV2` using CAS revision tracking (`expectedRevision: committedRevision`).
3. **Robust Hydration & Conflict Management**:
   - On fresh installs (`not-found`), the renderer initializes a clean empty state without synthesizing mock demo data.
   - On migration (`migrated`), the renderer commits once with `expectedRevision: 0` using an `isMigrating` guard to avoid duplicate saves.
   - On conflict (`REVISION_CONFLICT`), the renderer sets `saveStatus: 'conflict'` and halts subsequent automatic saves until `reloadCommittedFromMain()` fetches the latest disk snapshot.
4. **UI State Machine & Theme Compliance**:
   - The UI provides immediate visual feedback for hydration and persistence states.
   - Loading and error boundary screens prevent partial rendering or uncoordinated mutations.
   - All components use design system CSS variables (`var(--border)`, `var(--surface)`, `var(--text)`, `var(--text-secondary)`, `var(--danger)`, etc.) with zero raw color literals, satisfying `check:theme-colors`.

---

## 3. Caveats

- **Deferred Scope (Out of Scope for Task 2B)**:
  - Rotating backup archive rotation and recovery candidate UI.
  - Managed-file orphan reconciliation and trash lifecycle.
  - Main-owned trusted readiness snapshot binding for positive proposals.
- **Node Test Isolation**:
  - Full repo test commands (`npm test`) run tests across all workspaces including `@genoffice/docx-engine` which may have independent timeouts. All tenders-hardening verification must use `-w @genoffice/tenders`.

---

## 4. Conclusion

Task 2B (Renderer v2 Persistence Cutover) is fully and genuinely implemented. The Tenders renderer store now operates strictly against the authoritative Electron main process v2 storage with compare-and-swap concurrency control. All 608 tests pass, TypeScript typechecking is clean, both `@genoffice/tenders` and `@genoffice/shell` build cleanly, theme color guards pass, and formatting conforms to Prettier standards.

---

## 5. Verification Method

Independent verification can be performed using the following commands:

```powershell
# 1. Verify PDF box clamping
npm test -w @genoffice/tenders -- tests/pdf-box-bounds.test.ts

# 2. Verify Renderer Store v2 CAS state machine & localStorage purging
npm test -w @genoffice/tenders -- tests/renderer-store-v2.test.ts

# 3. Verify full Tenders test suite (608/608 pass)
npm test -w @genoffice/tenders

# 4. Typecheck Tenders package
npm run typecheck -w @genoffice/tenders

# 5. Build Tenders and Shell
npm run build -w @genoffice/tenders; if ($?) { npm run build -w @genoffice/shell }

# 6. Repository guards
npm run check:theme-colors
npm run format:check
```

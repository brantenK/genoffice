# Dispatch: worker_2b_cutover

- **Task**: Implement Renderer v2 Persistence Cutover (Phase 2 / Task 2B)
- **Agent Directory**: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_2b_cutover
- **Original Request**: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md
- **References**:
  - `docs/tenders-hardening/README.md`
  - `docs/tenders-hardening/contracts-and-invariants.md`
  - `docs/tenders-hardening/phase-2-remaining.md`
  - `C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_2b_cutover\analysis.md`
  - `C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_2b_cutover\handoff.md`

## MANDATORY INTEGRITY WARNING
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. An auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Objective
Execute the 4-step implementation plan specified in `explorer_2b_cutover/analysis.md` to cut renderer persistence over from localStorage to the authoritative v2 store via typed IPC:
1. `apps/tenders/src/renderer/src/pdf/extract.ts`:
   - Implement and export `clampNormalizedBox` and `unionBoxes` to strictly bound boxes within `[0, 1]` on both axes.
   - Verify `npm test -w @genoffice/tenders -- tests/pdf-box-bounds.test.ts` (8/8 pass).
2. `apps/tenders/src/renderer/src/store.ts`:
   - Cut persistence over to authoritative v2 store using `loadStoreV2`, `saveStoreV2`, and `onStoreChangedV2`.
   - Implement `hydrateFromMain` handling the 4 states: `not-found` (clean empty workspace, no demo seeding), `loaded` (adopt committed snapshot directly), `migrated` (commit once with single-commit guard), and error state.
   - Implement compare-and-swap (CAS) saves via `saveStoreV2({ expectedRevision, document })` with debouncing, conflict detection (`saveStatus: 'conflict'`), retry (`retrySave()`), and reload (`reloadCommittedFromMain()`).
   - Purge all domain data (workspaces, tenders, customers, vault docs) from localStorage. Retain only UI preferences (`page`, `view`, `zoom`, `currentPage`, `onboardingDone`) under key `'zanostack-tenders-ui'`.
   - Verify `npm test -w @genoffice/tenders -- tests/renderer-store-v2.test.ts` (12/12 pass).
3. UI Integration (`apps/tenders/src/renderer/src/components/App.tsx`, `Workspace.tsx`):
   - Wire `hydrateFromMain()` on mount.
   - Handle loading, error, first-run empty (`FirstRunEmpty.tsx`), and ready states.
   - Mount `<SaveStatus />` in workspace chrome/header.
   - Ensure all styling uses CSS theme variables (zero raw hex or rgb) to satisfy `npm run check:theme-colors`.
4. Verification:
   - Full Tenders suite: `npm test -w @genoffice/tenders` (all 608 tests pass).
   - Typecheck: `npm run typecheck -w @genoffice/tenders`.
   - Builds: `npm run build -w @genoffice/tenders; if ($?) { npm run build -w @genoffice/shell }`.
   - Theme check: `npm run check:theme-colors`.
   - Formatter: `npm run format; if ($?) { npm run format:check }`.

Report all results, commands, and passing evidence in `handoff.md` and send a message to the parent orchestrator upon completion.

## 2026-09-15T16:59:21Z
You are worker_2b_cutover.
Your working directory is: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_2b_cutover.
Read your dispatch instructions at C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_2b_cutover\DISPATCH.md and the original request at C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md.
Also read the detailed blueprint and handoff from explorer_2b_cutover:
- C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_2b_cutover\analysis.md
- C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_2b_cutover\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. An auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your write scope:
- apps/tenders/src/renderer/src/pdf/extract.ts
- apps/tenders/src/renderer/src/store.ts
- apps/tenders/src/renderer/src/components/App.tsx
- apps/tenders/src/renderer/src/components/Workspace.tsx
- apps/tenders/src/renderer/src/pages/TutorialsPage.tsx (if legacy copy needs adjustment)

Implementation sequence:
Step 1: Export `clampNormalizedBox` and `unionBoxes` in `apps/tenders/src/renderer/src/pdf/extract.ts` as specified in analysis.md §4. Ensure all extracted items pass through `clampNormalizedBox`.
Verify: npm test -w @genoffice/tenders -- tests/pdf-box-bounds.test.ts (8/8 pass).

Step 2: Refactor `apps/tenders/src/renderer/src/store.ts` to implement the authoritative v2 store state machine, `hydrateFromMain` (handling 4 states: not-found, loaded, migrated, error), `scheduleSaveToMain` (CAS save with debouncing at `expectedRevision === committedRevision`), `retrySave`, `reloadCommittedFromMain`, and multi-window sync listener `onStoreChangedV2`. Configure UI-only localStorage persistence under 'zanostack-tenders-ui', purging all domain data (workspaces, tenders, customers, vault docs).
Verify: npm test -w @genoffice/tenders -- tests/renderer-store-v2.test.ts (12/12 pass).

Step 3: Update `App.tsx` and `Workspace.tsx`:
- Trigger `hydrateFromMain()` on mount in `App.tsx`.
- Render calm loading state when `hydrationStatus === 'loading'`.
- Render explicit error boundary state when `hydrationStatus === 'error'`.
- Render `FirstRunEmpty` when `hydrationStatus === 'ready' && !hasWorkspaces`.
- Mount `<SaveStatus />` in `App.tsx` and `Workspace.tsx`.
- Ensure all styling uses theme CSS variables (no raw hex or rgb) to pass npm run check:theme-colors.

Step 4: Full verification of repository guards:
- npm test -w @genoffice/tenders (all 608 tests pass with 0 failures).
- npm run typecheck -w @genoffice/tenders.
- npm run build -w @genoffice/tenders; if ($?) { npm run build -w @genoffice/shell }.
- npm run check:theme-colors.
- npm run format; if ($?) { npm run format:check }.

Document all modified files, test outputs, and verification commands in handoff.md. Send a message to parent when finished.


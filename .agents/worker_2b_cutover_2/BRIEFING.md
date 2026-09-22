# BRIEFING — 2026-09-15T21:33:00+02:00

## Mission
Cut over Zanostack Tenders renderer persistence from localStorage to the authoritative v2 store via typed IPC, enforce PDF bounding box clamping, update App/Workspace integration with SaveStatus and FirstRunEmpty, and pass all repository verification guards.

## 🔒 My Identity
- Archetype: worker
- Roles: implementer, qa, specialist
- Working directory: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_2b_cutover_2
- Original parent: 35afc8d8-67e4-4566-a753-99b3c04c6533
- Milestone: Phase 2 Durability / Task 2B Renderer v2 Persistence Cutover

## 🔒 Key Constraints
- Write scope strictly limited to:
  - `apps/tenders/src/renderer/src/pdf/extract.ts`
  - `apps/tenders/src/renderer/src/store.ts`
  - `apps/tenders/src/renderer/src/components/App.tsx`
  - `apps/tenders/src/renderer/src/components/Workspace.tsx`
  - `apps/tenders/src/renderer/src/pages/TutorialsPage.tsx` (if legacy copy needs adjustment)
- Mandatory integrity: no cheating, no mock/facade implementations, genuine state machines.
- All theme styling must use CSS theme variables (zero raw hex or rgb) to satisfy `npm run check:theme-colors`.
- All domain records (workspaces, tenders, customers, vault docs) must be purged from `localStorage`.
- All 608 tests in `@genoffice/tenders` must pass.

## Current Parent
- Conversation ID: 35afc8d8-67e4-4566-a753-99b3c04c6533
- Updated: not yet

## Task Summary
- **What to build**:
  1. `clampNormalizedBox` and `unionBoxes` in `apps/tenders/src/renderer/src/pdf/extract.ts` ensuring all box coordinates are within `[0, 1]`.
  2. v2 store in `apps/tenders/src/renderer/src/store.ts` with `hydrateFromMain` (4 states), CAS debounced `scheduleSaveToMain`, `retrySave`, `reloadCommittedFromMain`, `onStoreChangedV2`, and UI-only localStorage.
  3. UI integration in `App.tsx` and `Workspace.tsx` with hydration states (loading, error, first-run empty, ready) and `<SaveStatus />`.
  4. Repository verification (tests, typecheck, build, theme-colors, format).
- **Success criteria**: 608/608 tests pass, clean typecheck, clean builds, clean theme check, clean format check.
- **Interface contracts**: `docs/tenders-hardening/contracts-and-invariants.md`, `apps/tenders/src/shared/tenders-schema.ts`, `apps/tenders/src/shared/tenders-persistence.ts`, `apps/tenders/src/shared/ipc.ts`.
- **Code layout**: `apps/tenders/src/`

## Key Decisions Made
- Follow exact blueprint from `explorer_2b_cutover/analysis.md`.
- In-memory flags `committedRevision`, `isSyncingFromMain`, `isMigrating`, `isHydrating` to prevent race conditions and duplicate saves.

## Artifact Index
- `.agents/worker_2b_cutover_2/DISPATCH.md` — Assignment instructions
- `.agents/worker_2b_cutover_2/BRIEFING.md` — Agent state and working memory
- `.agents/worker_2b_cutover_2/progress.md` — Liveness heartbeat and task progress
- `.agents/worker_2b_cutover_2/handoff.md` — Completion report

## Change Tracker
- **Files modified**: None yet
- **Build status**: Pending
- **Pending issues**: None

## Quality Status
- **Build/test result**: Pending
- **Lint status**: Pending
- **Tests added/modified**: Pending

## Loaded Skills
- None

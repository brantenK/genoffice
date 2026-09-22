# BRIEFING — 2026-09-15T19:01:32+02:00

## Mission
Cut renderer persistence in `apps/tenders` over from localStorage to the authoritative v2 store via typed IPC, implement PDF box clamping, and wire UI state and save indicators.

## 🔒 My Identity
- Archetype: worker
- Roles: implementer, qa, specialist
- Working directory: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_2b_cutover
- Original parent: 35afc8d8-67e4-4566-a753-99b3c04c6533
- Milestone: Phase 2 Durability / Task 2B Cutover

## 🔒 Key Constraints
- DO NOT CHEAT: all implementations must be genuine.
- Write scope strictly limited to:
  - apps/tenders/src/renderer/src/pdf/extract.ts
  - apps/tenders/src/renderer/src/store.ts
  - apps/tenders/src/renderer/src/components/App.tsx
  - apps/tenders/src/renderer/src/components/Workspace.tsx
  - apps/tenders/src/renderer/src/pages/TutorialsPage.tsx (if legacy copy needs adjustment)
- Theme guard: zero raw hex or rgb colors in styling (use CSS theme variables).
- Tests: all 608 tests in `@genoffice/tenders` must pass (588 existing + 12 renderer-store-v2 + 8 pdf-box-bounds).
- Clean typecheck, build, and format.

## Current Parent
- Conversation ID: 35afc8d8-67e4-4566-a753-99b3c04c6533
- Updated: not yet

## Task Summary
- **What to build**:
  1. Box clamping in `extract.ts` (`clampNormalizedBox`, `unionBoxes`).
  2. Store v2 in `store.ts` (`hydrateFromMain`, `scheduleSaveToMain`, `retrySave`, `reloadCommittedFromMain`, `onStoreChangedV2`, UI-only localStorage).
  3. UI integration in `App.tsx` and `Workspace.tsx` (`SaveStatus`, `FirstRunEmpty`, loading/error screens).
- **Success criteria**: 608/608 tests pass, clean typecheck, clean builds (tenders + shell), clean theme check, clean format.
- **Interface contracts**: docs/tenders-hardening/contracts-and-invariants.md
- **Code layout**: apps/tenders/src/renderer/src/

## Change Tracker
- **Files modified**: None yet
- **Build status**: Pending
- **Pending issues**: None

## Quality Status
- **Build/test result**: Pending
- **Lint status**: Pending
- **Tests added/modified**: 20 target tests already present in test suite (8 box bounds + 12 store v2)

## Loaded Skills
- None specified

## Key Decisions Made
- Follow explorer_2b_cutover's analysis blueprint faithfully.

## Artifact Index
- C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_2b_cutover\BRIEFING.md
- C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_2b_cutover\progress.md
- C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_2b_cutover\handoff.md

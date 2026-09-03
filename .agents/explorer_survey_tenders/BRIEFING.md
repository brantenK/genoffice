# BRIEFING — 2026-09-03T15:12:20+02:00

## Mission
Survey the authoritative codebase and data layer for Zanostack Tenders and R1/R3 requirements (schema versioning, contract milestones, and Zano Books milestone billing integration).

## 🔒 My Identity
- Archetype: explorer
- Roles: investigator, synthesizer
- Working directory: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_tenders
- Original parent: d94f5282-fbc7-4b07-8909-cf2550459903
- Milestone: survey_tenders_r1_r3

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Investigate Zanostack Tenders and R1/R3 requirements
- Document findings in handoff.md and report to parent

## Current Parent
- Conversation ID: d94f5282-fbc7-4b07-8909-cf2550459903
- Updated: not yet

## Investigation State
- **Explored paths**:
  - `apps/tenders/package.json`
  - `apps/tenders/src/main/tenders-main.ts`
  - `apps/tenders/src/preload/index.ts`
  - `apps/tenders/src/shared/ipc.ts`, `types.ts`, `rules.ts`
  - `apps/tenders/src/renderer/src/store.ts`, `components/Workspace.tsx`, `TenderList.tsx`, `App.tsx`
  - `apps/tenders/src/renderer/src/mock/company.ts`, `customers.ts`, `vault.ts`
  - `apps/shell/src/main/index.ts`, `tab-manager.ts`
  - `apps/books/src/main/books-main.ts`, `src/shared/types.ts`, `mock/initialData.ts`
  - `apps/crm/src/main/crm-main.ts`, `crm-store.ts`, `seed-data.ts`
- **Key findings**:
  - Tenders app is `@genoffice/tenders` at `apps/tenders`, hosted via `WebContentsView` in `apps/shell` TabManager.
  - `tenders-data.json` path is defined in `tenders-main.ts` (`userData/tenders/tenders-data.json`), with IPC handlers `getStoredData`/`saveStoredData`, but currently unused by the renderer (which only uses localStorage `zanostack-tenders-v1`).
  - Neither `tenders-data.json`, `deals.json`, nor `books-data.json` have schema versioning or validation wrappers.
  - Contract milestones are completely missing from `apps/tenders` (`TenderRecord` has no `milestones` field, and `Workspace.tsx` has no milestone UI).
  - Books mock data (`initialData.ts`) already has invoice `inv-1` (`INV-2026-001`) with `tenderReference: 'RFP-WTR-2026-04'`, party `'City of Ekurhuleni Water Dept'`, description `'Phase 1 Reservoir Valve Refurbishment per RFP-WTR-2026-04'`, total R 145,000.
  - Tenders has no IPC or UI link to Books yet (only CRM via `syncWithCrm` and `openInCrm`). Shell needs `onOpenBooks` callback in `configureTendersRuntime`.
- **Unexplored areas**: None for this survey phase; all 6 questions answered with code evidence.

## Key Decisions Made
- Fully identified file layout, entry points, state management, and disconnects for Tenders.
- Identified schema migration architecture needed for R1.
- Identified contract milestone modeling, IPC channels, and Books billing bridge needed for R3.

## Artifact Index
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_tenders\DISPATCH.md — Dispatch log
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_tenders\BRIEFING.md — Situational awareness
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_tenders\progress.md — Liveness heartbeat
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_tenders\handoff.md — Final investigation handoff report

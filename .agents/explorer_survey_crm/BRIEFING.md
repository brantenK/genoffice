# BRIEFING — 2026-09-03T13:08:30Z

## Mission
Investigate Zanostack CRM codebase, userData/crm/deals.json, UI Deals table/modal, tab switching/inter-app messaging, R1/R2 integration points, test/build/brand scripts.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigator, synthesizer
- Working directory: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_crm
- Original parent: d94f5282-fbc7-4b07-8909-cf2550459903
- Milestone: Survey Phase - CRM & R1/R2

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Rely only on verified facts directly observed in code/files
- Report structured 5-component handoff.md
- Use send_message to report completion back to parent

## Current Parent
- Conversation ID: d94f5282-fbc7-4b07-8909-cf2550459903
- Updated: 2026-09-03T13:08:30Z

## Investigation State
- **Explored paths**:
  - `package.json`, `CLAUDE.md`, `fork/tools/check-brand.mjs`
  - `apps/crm/` (`package.json`, `src/main/crm-main.ts`, `src/main/crm-store.ts`, `src/main/seed-data.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `src/renderer/src/App.tsx`, `DealsTableView.tsx`, `DealModal.tsx`, `PipelineView.tsx`)
  - `apps/shell/src/main/` (`tab-manager.ts`, `index.ts`)
  - `apps/books/src/` (`main/books-main.ts`, `shared/types.ts`, `renderer/src/store.ts`, `mock/initialData.ts`, `components/Desk.tsx`)
  - `apps/tenders/src/main/tenders-main.ts` (`syncWithCrm` external direct write)
  - `$env:APPDATA\Zanostack Dev\crm\deals.json` (live file inspected)
- **Key findings**:
  - CRM package is `@genoffice/crm` under `apps/crm`.
  - `deals.json` is stored as an unversioned, unvalidated JSON array in `userData/crm/deals.json`.
  - `apps/tenders/src/main/tenders-main.ts` line 164-198 bypasses `CrmStore` and directly writes unvalidated array to `deals.json`.
  - Won deals are identified by `deal.stage === 'won'`. Neither `DealsTableView` nor `DealModal` currently has the Books invoicing action.
  - Tab manager has `openBooksTab()` and `openCrmTab()`, but CRM lacks `onOpenBooks` runtime config / IPC bridge.
  - Books invoice model already has `crmDealId?: string`. Double-entry accounting in Books auto-posts to `acc-ar`, `acc-sales`, `acc-vat`.
  - `check:brand`, `typecheck -w @genoffice/crm`, and `build -w @genoffice/crm` all verified passing with code 0.
- **Unexplored areas**: None within CRM and R1/R2 survey scope.

## Key Decisions Made
- Completed survey phase for CRM & R1/R2.
- Compiled exhaustive 5-component handoff report with exact lines, types, code blueprints, and verification method.

## Artifact Index
- handoff.md — Comprehensive findings and evidence report
- progress.md — Heartbeat and investigation status
- DISPATCH.md — Dispatch log

# BRIEFING — 2026-09-03T13:10:00Z

## Mission
Investigate the authoritative codebase and data layer for Zano Books and R1/R2/R3/R4 (state management, file layout, userData/books/books-data.json, Chart of Accounts/acc-bank, sales & tax invoices, banking view, bank statement CSV import & reconciliation, verification tools).

## 🔒 My Identity
- Archetype: explorer
- Roles: [explorer, investigator, synthesizer]
- Working directory: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_books
- Original parent: d94f5282-fbc7-4b07-8909-cf2550459903
- Milestone: survey

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Zero brand regressions (must adhere to brand check)
- Only write within .agents/explorer_survey_books

## Current Parent
- Conversation ID: d94f5282-fbc7-4b07-8909-cf2550459903
- Updated: 2026-09-03T13:10:00Z

## Investigation State
- **Explored paths**:
  - `apps/books/package.json`
  - `apps/books/src/main/books-main.ts`, `apps/books/src/main/index.ts`
  - `apps/books/src/preload/index.ts`
  - `apps/books/src/shared/types.ts`, `apps/books/src/shared/ipc.ts`
  - `apps/books/src/renderer/src/store.ts`
  - `apps/books/src/renderer/src/mock/initialData.ts`
  - `apps/books/src/renderer/src/components/Desk.tsx`
  - `apps/books/src/renderer/src/components/Dashboard.tsx`
  - `apps/books/src/renderer/src/components/InvoiceList.tsx`, `InvoiceForm.tsx`, `InvoicePrintModal.tsx`
  - `apps/books/src/renderer/src/components/ChartOfAccounts.tsx`, `PartyList.tsx`, `JournalEntryList.tsx`, `ReportsView.tsx`
  - `apps/shell/src/main/tab-manager.ts`, `apps/shell/src/main/index.ts`
  - `apps/crm/src/shared/types.ts`, `apps/tenders/src/shared/types.ts`
  - `fork/tools/check-brand.mjs`, `tools/capture-books.mjs`, root `package.json`
- **Key findings**:
  - Zano Books is located at `apps/books` with Zustand store (`useBooksStore`), Electron IPC persistence to `userData/books/books-data.json`.
  - Schema versioning, validation, and atomic writes are missing from `books-data.json` (R1 vulnerability).
  - Invoicing schema already has `tenderReference` and `crmDealId` fields in `Invoice`, perfectly positioned for R2 and R3.
  - Banking tab does NOT currently exist in Books; needs new `'banking'` tab, `BankingView.tsx` component, `BankTransaction` type, CSV parsing logic, `acc-bank` balance adjustment, suggestion matching, and 1-click reconciliation (R4).
  - Brand check passed with 0 unauthorized upstream brands; typecheck across all 22 monorepo packages passed cleanly.
  - `tools/verify-suite-workflows.mjs` does not exist and must be implemented for programmatic integration verification.
- **Unexplored areas**: None. All objectives surveyed.

## Key Decisions Made
- Survey completed. Written 5-component handoff report to `handoff.md`.

## Artifact Index
- DISPATCH.md — record of incoming dispatch
- BRIEFING.md — persistent working memory
- progress.md — liveness and heartbeat
- handoff.md — final comprehensive survey report

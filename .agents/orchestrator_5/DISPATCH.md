# Dispatch to Orchestrator 5 (Zano Books Backend Audit & Hardening)

- **Target Workspace**: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice`
- **Agent Directory**: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5`
- **Request Source**: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md` (Header `## 2026-09-05T06:42:35Z`)

## Mission
Comprehensive audit and hardening of the Zano Books backend (`apps/books`), establishing strict double-entry ledger balancing for all invoice types, full Chart of Accounts harmonization, precise bank reconciliation with partial/exact payment handling, live IPC synchronization (`books:data-changed`), and an automated test suite.

## Key Requirements & Acceptance Criteria
1. **Double-Entry Bookkeeping & Balanced Journal Posting**: Total Debits == Total Credits strictly balanced to 2 decimal places. Purchase bills generate balanced entries and update AP & Direct Expense. Accurate party balances.
2. **Chart of Accounts Harmonization & Schema Invariants**: Harmonize `books-main.ts` and `initialBooksData.ts` (all 22 standard accounts across 5 categories). Atomic persistence with temporary file renaming and backup on corrupt JSON.
3. **Bank Reconciliation & Cross-App Sync**: Support SA bank statement CSV formats (FNB, Standard Bank, Nedbank, Absa). Exact and partial settlement binding to actual transaction amounts without corrupting ledger accounts. Tender milestone `status: 'PAID'` back-propagation.
4. **Real-Time IPC Synchronization**: `books:data-changed` broadcast to active Books WebContents with loop-suppression guards.
5. **Testing & Quality**: Vitest test suite for `apps/books` with 100% pass rate. Monorepo `npm run typecheck` zero errors. Zero regressions in UI or reports.

## 2026-09-05T06:44:27Z
You are orchestrator_5, the Project Orchestrator for the comprehensive audit and hardening of the Zano Books backend (apps/books).
Summary of Requirements:
1. R1: Strict Double-Entry Bookkeeping & Balanced Journal Posting
- Total Debits == Total Credits strictly balanced to 2 decimal places.
- Sales Invoices: Debit AR, Credit Sales Revenue, Credit VAT Output Payable.
- Purchase Bills: Debit Expense/Materials, Debit VAT Input if applicable, Credit AP.
- Invoice Payments & Reversals: accurate settlement, party balances, journal postings.
- Precision: eliminate floating-point drift with strict 2 decimal place rounding.

2. R2: Chart of Accounts Harmonization & Schema Invariants
- Harmonize Chart of Accounts between Electron main process (books-main.ts) and initial seed data (initialBooksData.ts).
- Preserve full standard Chart of Accounts structure (all 22 standard accounts across 5 root categories: Assets, Liabilities, Equity, Income, Expenses, Retained Earnings, Share Capital).
- Maintain parent-child group relationships for accurate financial summaries/reports.
- Atomic persistence via temp files and renames, with automatic backup on corrupt JSON.

3. R3: Robust Bank Statement Import & Reconciliation Engine
- Accurately parse debit/credit columns, parenthetical negatives, varying headers for South African banks (FNB, Standard Bank, Nedbank, Absa).
- Deduplication collision prevention and correct bank account ledger updates.
- In executeReconciliation, bind settlements to actual transaction amounts for exact and partial settlement without corrupting ledger accounts.
- Preserve tender milestone payment back-propagation (status: 'PAID') when settling tender-linked tax invoices.

4. R4: Real-Time IPC Synchronization (books:data-changed)
- Implement books:data-changed broadcast event pipeline from Electron main process to active Books WebContents views.
- Immediate reload-free update when cross-app actions (e.g. milestone billing from Tenders) write to books-data.json.
- Loop-suppression guards to prevent echo-loops between store persistence and IPC events.

5. R5: Dedicated Automated Test Suite
- Comprehensive Vitest test suite for apps/books covering balance invariants, sales/purchase invoice posting, CSV statement parsing, reconciliation math, persistence/migrations, and IPC handlers.
- 100% tests pass and npm run typecheck passes with zero errors across the monorepo.
- Zero regressions in Books UI navigation or report generation.

## 2026-09-05T11:34:30Z
Server restart interrupted execution and quota has reset. Please resume immediately:

Current State:
- Milestone 1 (Accounting Engine & CoA Harmonization): COMPLETE and committed.
- Milestone 2 (Strict Double-Entry Journal Posting): Implementation COMPLETE by worker_books_m2_ledger — all M2 code is on disk (apps/books/src/renderer/src/store.ts, InvoiceForm.tsx, accounting.ts).
- Prior gate evaluation subagents were stopped by the server restart.

Required Actions:
1. Re-evaluate Milestone 2 gate: spawn a fresh 5-agent evaluation panel (2 reviewers + 2 challengers + 1 auditor) to evaluate the M2 implementation on disk.
2. Upon M2 gate approval: proceed with Milestones 3, 4, and 5:
   - Milestone 3: Bank Reconciliation hardening (fix executeReconciliation to use tx.amount not inv.outstandingAmount, partial settlement support, SA bank formats).
   - Milestone 4: IPC Sync (books:data-changed broadcast pipeline with loop-suppression guards).
   - Milestone 5: Automated Test Suite (apps/books Vitest configuration and dedicated tests, 100% pass rate, zero typecheck errors across monorepo).
3. Final Acceptance: monorepo verification and victory handoff report to sentinel.

## 2026-09-05T16:34:11Z
Server restart occurred and quota window has expired. You are now revived to complete execution.

Current State:
- Milestone 1 (CoA & Accounting Engine): PASSED GATE.
- Milestone 2 (Strict Double-Entry Balancing): PASSED GATE.
- Milestone 3 (Bank Reconciliation & CSV Parser): PASSED GATE.
- Milestone 4 (Real-Time IPC `books:data-changed`): PASSED GATE.
- Milestone 5: Implementation complete — all 6 dedicated test suites exist in `apps/books/tests/` (`invariants.test.ts`, `ledger-posting.test.ts`, `bank-csv-parser.test.ts`, `reconciliation.test.ts`, `persistence.test.ts`, `ipc-sync.test.ts`) and `vitest.config.ts` is configured.

Required Actions:
1. Conduct Milestone 5 Gate Evaluation (Reviewers, Challengers, Auditor).
2. Execute full Vitest test suite (`npm test -w @genoffice/books` or `npx vitest run`) and confirm 100% tests pass.
3. Verify monorepo `npm run typecheck` across all 22 packages passes with zero errors.
4. Prepare your final handoff.md and report victory completion to Sentinel for independent victory auditing.

Update your progress.md and proceed with Milestone 5 gate evaluation and final certification now.

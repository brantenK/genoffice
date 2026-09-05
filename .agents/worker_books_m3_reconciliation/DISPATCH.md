## 2026-09-05T11:51:02Z
You are worker_books_m3_reconciliation.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m3_reconciliation

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also inspect:
- Scope: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md`
- Survey Reconciliation: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_books_reconciliation\handoff.md`
- Shared Accounting Engine: `apps/books/src/shared/accounting.ts`

Your Mission:
Implement Milestone 3 (M3): Robust Bank Statement Import & Reconciliation Engine (Features F10, F11, F12, F13).

Write Ownership (You exclusively own and may edit these files):
- `apps/books/src/main/books-main.ts`
- `apps/books/src/renderer/src/store.ts`
- `apps/books/src/shared/accounting.ts` (add bank CSV parser or reconciliation math helpers if appropriate)
- `apps/books/src/renderer/src/components/Reconciliation.tsx` (if needed)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Detailed Tasks:
1. SA Bank Statement CSV Parser & Import (Feature F10):
   - In `books-main.ts` (and/or shared helper):
     - Support South African bank statement formats: FNB, Standard Bank, Nedbank, Absa.
     - Dynamic header row detection (skip introductory account/balance metadata rows until finding column header row containing "Date"/"Transaction Date", "Amount"/"Debit"/"Credit", "Description"/"Narrative"/"Reference").
     - Parse debit/credit column combinations vs single signed amount column.
     - Parse parenthetical negatives: `(1,250.00)` or `(1250.00)` -> `-1250.00`.
     - Parse decimal commas e.g. `1250,50` and spaces as thousands separators e.g. `1 250.50`, currency symbols `R`.
     - Ensure all transaction amounts are strictly rounded to 2 decimal places with `round2`.

2. Resilient Bank Transaction Deduplication (Feature F11):
   - Prevent duplicate transactions on re-importing the same CSV while preserving legitimate duplicate transactions on the same day (e.g. multiple distinct identical charges).
   - Use deterministic composite key or frequency-based matching (date + amount + description + occurrence index).
   - Ensure the bank account balance (`acc-bank`) is incremented/decremented accurately by imported non-duplicate transactions if applicable, or preserved consistently.

3. Exact & Partial Reconciliation Settlement Math (Feature F12):
   - In `books-main.ts` (`executeReconciliation`) and `store.ts` (`reconcileTransaction`):
     - Fix the critical bug where `executeReconciliation` previously assumed full invoice payment: `const settledAmount = inv.outstandingAmount`.
     - Instead, bind settlement to the actual transaction amount:
       `const txAmt = Math.abs(tx.amount)`
       `const currentOutstanding = inv.outstandingAmount > 0 ? inv.outstandingAmount : inv.grandTotal`
       `const settledAmount = round2(Math.min(txAmt, currentOutstanding))`
     - Calculate remaining outstanding balance:
       `const remainingOutstanding = round2(currentOutstanding - settledAmount)`
       `inv.outstandingAmount = remainingOutstanding`
       `inv.status = remainingOutstanding <= 0 ? 'Paid' : 'Unpaid'`
     - Generate a balanced settlement journal entry via `createSettlementJournal(inv, accounts, party, settledAmount)` and add it to `journalEntries`.
     - Update ledger balances:
       - Sales receipt: Debit `acc-bank` by `settledAmount`, Credit `acc-ar` by `settledAmount`.
       - Purchase payment: Debit `acc-ap` by `settledAmount`, Credit `acc-bank` by `settledAmount`.
     - Mark transaction as reconciled: `tx.reconciled = true`, `tx.matchedInvoiceId = inv.id`.
     - Recompute party balances via `recomputePartyBalances`.

4. Cross-App Tender Milestone Payment Back-Propagation (Feature F13):
   - When a tender-linked tax invoice is reconciled (or marked paid), inspect linked tender in `userData/tenders/tenders-data.json`.
   - IMPORTANT: Only update the tender milestone to `status: 'PAID'` if the invoice is FULLY settled (`remainingOutstanding <= 0` or `inv.status === 'Paid'`).
   - If the invoice is only partially settled (`remainingOutstanding > 0`), do NOT update the milestone status to `PAID`.

5. Verification Commands:
   - Create a dedicated test script `tools/verify-books-m3-challenger.ts` covering F10 (FNB, Standard Bank, Nedbank, Absa CSV parsing with parenthetical negatives and decimal commas), F11 (deduplication), F12 (exact and partial reconciliation math and journal posting), and F13 (tender milestone back-propagation threshold).
   - Run `npx tsx tools/verify-books-m3-challenger.ts`
   - Run `npx tsx tools/verify-books-m2-challenger.ts`
   - Run `node tools/test-challenger-m1-empirical.mjs`
   - Run `node tools/verify-suite-workflows.mjs`
   - Run `npm run typecheck -w @genoffice/books`
   - Run `npm run build -w @genoffice/books`
   - Run `npm run typecheck` across all 22 monorepo packages
   - Run `npm run check:brand`

6. Report:
   - Deliver your handoff report to `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m3_reconciliation\handoff.md`.
   - Include changes made, files modified, verification commands and exact outputs.
   - When done, send a completion message to the orchestrator.

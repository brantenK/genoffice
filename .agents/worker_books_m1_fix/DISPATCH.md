## 2026-09-05T07:33:04Z

You are worker_books_m1_fix.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m1_fix

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also read the scope and reviewer feedback reports:
- Scope: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md`
- Reviewer 1 Report: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\reviewer_1_books_m1\handoff.md`
- Reviewer 2 Report: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\reviewer_2_books_m1\handoff.md`

Your Mission:
Remediate the issues identified in the Milestone 1 Gate review.

Write Ownership (You exclusively own and may edit these files):
- `apps/books/src/shared/accounting.ts`
- `apps/books/src/main/books-main.ts`
- `apps/books/src/renderer/src/components/ChartOfAccounts.tsx`
- `tools/test-challenger-m1-empirical.mjs`

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Detailed Tasks:
1. Fix negative line items & discount handling in `apps/books/src/shared/accounting.ts`:
   - In `createSalesInvoiceJournal` and `createPurchaseBillJournal`: do NOT skip negative line items (`inc.amount < 0`).
   - If line items have negative amounts (e.g. line discount), post them with genuine debit/credit handling, or ensure they aggregate into account buckets correctly so that Total Debits == Total Credits strictly across all cases (positive, negative discounts, zero amounts, credit notes).
2. Fix `books-main.ts`:
   - In `migrateAndValidateBooks`: do NOT destructively round valid existing account balances with `round2(acc.balance)` if `acc.balance` is already a valid finite number (`typeof acc.balance === 'number' && Number.isFinite(acc.balance) ? acc.balance : 0`). This preserves sub-cent precision as tested in `test-challenger-m1-empirical.mjs` test 6.3 (`0.0000001`).
3. Fix `ChartOfAccounts.tsx`:
   - Add depth limit `if (depth > 20) return null` in `renderTree` to guard against recursion stack overflows.
4. Reconcile `tools/test-challenger-m1-empirical.mjs`:
   - Line 731: update `505` to `500 + CORE_ACCOUNTS.length` (or `530`) because `CORE_ACCOUNTS` was expanded from 5 to 30 accounts to satisfy Requirement R2 (Full Chart of Accounts across 5 root categories).
5. Build and Verify:
   - Run `npm run build -w @genoffice/books` to update `apps/books/out/main/index.js`
   - Run `npm run typecheck -w @genoffice/books`
   - Run `node tools/test-challenger-m1-empirical.mjs` and ensure all 31/31 tests PASS
   - Run `node tools/verify-suite-workflows.mjs` and ensure all 56/56 tests PASS
   - Run `npm run check:brand`
   - Write your handoff report to `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m1_fix\handoff.md` with exact command outputs.
   - Send completion message to orchestrator.

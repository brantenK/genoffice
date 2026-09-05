## 2026-09-05T07:03:10Z
You are worker_books_m1_coa_engine.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m1_coa_engine

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also read the scope and survey handoffs:
- Scope: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md`
- Survey Ledger: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_books_ledger\handoff.md`
- Survey CoA & Store: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_books_coa_store\handoff.md`

Your Mission:
Implement Milestone 1 (M1): Chart of Accounts Harmonization, Persistence Schema Invariants & Accounting Engine Foundation (Features F1, F2, F3, F4).

Write Ownership (You exclusively own and may edit these files):
- `apps/books/src/shared/accounting.ts` (create new file)
- `apps/books/src/main/books-main.ts`
- `apps/books/src/renderer/src/mock/initialData.ts`
- `apps/books/src/renderer/src/components/ChartOfAccounts.tsx`
- `apps/books/src/renderer/src/components/Dashboard.tsx`

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Detailed Tasks:
1. Create `apps/books/src/shared/accounting.ts`:
   - `round2(n: number): number` (strictly rounds to 2 decimal places: `Math.round((Number(n) || 0) * 100) / 100`).
   - `calculateInvoiceTotals(items: InvoiceItem[])`: returns `{ subtotal: number, taxTotal: number, grandTotal: number }` where `subtotal + taxTotal === grandTotal` strictly guaranteed with 2-decimal precision.
   - `createSalesInvoiceJournal(invoice: Invoice, accounts: Account[], party?: Party, jeNumber?: string)`:
     Debit: `acc-ar` (`invoice.grandTotal`), Credit: income account (item account or `acc-sales`), Credit: `acc-vat` (or `acc-vat-out`) for `taxTotal`. Total Debit == Total Credit strictly.
   - `createPurchaseBillJournal(bill: Invoice, accounts: Account[], party?: Party, jeNumber?: string)`:
     Debit: expense account (item account or `acc-materials`), Debit: `acc-vat-in` (or `acc-vat`) for `taxTotal` if `taxTotal > 0`, Credit: `acc-ap` (`bill.grandTotal`). Total Debit == Total Credit strictly.
   - `createSettlementJournal(...)`:
     Sales receipt: Debit `acc-bank`, Credit `acc-ar`. Purchase payment: Debit `acc-ap`, Credit `acc-bank`. Total Debit == Total Credit strictly.
   - `recomputePartyBalances(invoices: Invoice[], parties: Party[]): Party[]`:
     Ensures party outstandingBalance strictly equals sum of open invoice outstanding amounts.
2. Harmonize Chart of Accounts across backend and renderer:
   - Harmonize `CORE_ACCOUNTS` in `apps/books/src/main/books-main.ts` and `initialData.ts` (`apps/books/src/renderer/src/mock/initialData.ts`).
   - Ensure all 22 standard accounts across 5 root categories are defined:
     Assets (acc-bank, acc-cash, acc-ar, acc-inventory, acc-equip, acc-vehic),
     Liabilities (acc-ap, acc-vat / acc-vat-out, acc-vat-in, acc-payroll-liab),
     Equity (acc-retained, acc-capital, acc-owner-equity),
     Income (acc-sales, acc-consult, acc-interest-income),
     Expenses (acc-materials, acc-salaries, acc-rent, acc-utilities, acc-travel, acc-deprec).
   - Plus the root and subgroup group accounts: `acc-asset` (parentId: null), `acc-curr-asset` (parentId: 'acc-asset'), `acc-fixed-asset` (parentId: 'acc-asset'), `acc-liab` (parentId: null), `acc-curr-liab` (parentId: 'acc-liab'), `acc-equity` (parentId: null), `acc-income` (parentId: null), `acc-expense` (parentId: null).
   - Root groups MUST have `parentId: null` so `renderTree(null, 0)` renders properly.
3. Fix ChartOfAccounts.tsx:
   - Ensure `renderTree` handles accounts with `parentId === null || parentId === undefined` as root level.
4. Fix Dashboard.tsx:
   - Add `!a.isGroup` filter when summing `incomeAccounts` and `expenseAccounts` to prevent double-counting.
5. Harden Persistence & Corrupt Recovery in `books-main.ts`:
   - In corrupt JSON catch block: write BOTH timestamped `${filePath}.corrupt-${Date.now()}` and legacy `${filePath}.corrupted.bak`.
   - In `migrateAndValidateBooks`: backfill missing standard accounts and groups into existing stores so older or partial stores gain the full tree.
6. Verification:
   - Run typecheck: `npm run typecheck -w @genoffice/books`
   - Run existing suite checks: `node tools/verify-suite-workflows.mjs`
   - Write your handoff report to `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m1_coa_engine\handoff.md` with:
     - Changes made
     - Commands executed and exact outputs
     - Files modified
   - Send completion message to orchestrator.

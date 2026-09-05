# Handoff Report: Milestone 1 (M1) — Chart of Accounts Harmonization, Persistence Schema Invariants & Accounting Engine Foundation

**Agent**: `worker_books_m1_coa_engine`  
**Working Directory**: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m1_coa_engine`  
**Target Package**: `apps/books` (`@genoffice/books`)  
**Date**: 2026-09-05  

---

## 1. Observation

### 1.1 Pre-existing Defects in Codebase
1. **Disparity in Chart of Accounts (`CORE_ACCOUNTS` vs `initialBooksData.accounts`)**:
   - In `apps/books/src/main/books-main.ts` (lines 32–38), `CORE_ACCOUNTS` contained only 5 leaf accounts (`acc-bank`, `acc-ar`, `acc-ap`, `acc-sales`, `acc-vat`). All 5 had `parentId` set to parent accounts (`acc-curr-asset`, `acc-curr-liab`, `acc-income`) that did not exist in `CORE_ACCOUNTS`.
   - In `apps/books/src/renderer/src/mock/initialData.ts` (lines 14–47), 23 accounts were defined, but it missed standard accounts mandated by R2: `acc-inventory` (Current Asset), `acc-vat-in` (Tax Recoverable), `acc-payroll-liab` (Current Liability), `acc-owner-equity` (Equity), `acc-interest-income` (Indirect Income), `acc-utilities` (Indirect Expense), and `acc-deprec` (Indirect Expense).
2. **UI Empty Screen Crash in `ChartOfAccounts.tsx`**:
   - In `apps/books/src/renderer/src/components/ChartOfAccounts.tsx` (lines 29–31), `renderTree` filtered `accounts.filter((a) => a.parentId === parentId)` where `parentId = null`. When loaded with `CORE_ACCOUNTS` alone, 0 accounts matched `parentId === null`, causing `renderTree(null, 0)` to return `null` and leaving the screen completely blank.
3. **Double-Counting in `Dashboard.tsx`**:
   - In `apps/books/src/renderer/src/components/Dashboard.tsx` (lines 28–34), `incomeAccounts` and `expenseAccounts` summed all accounts with matching `rootType` without filtering `!a.isGroup`. If group nodes carried balances, revenue and expense totals were double-counted.
4. **Corrupt File Recovery Defect**:
   - In `apps/books/src/main/books-main.ts` (lines 160–167), when JSON parsing failed, it only wrote to `${filePath}.corrupted.bak`, failing to produce timestamped forensic snapshots (`${filePath}.corrupt-${Date.now()}`).
5. **No Shared Accounting Math Engine**:
   - There was no unified accounting math library (`accounting.ts`) providing deterministic 2-decimal rounding, invoice total calculation, balanced journal entry posting, and party balance invariants.

### 1.2 Implemented Changes
1. **Created `apps/books/src/shared/accounting.ts`**:
   - `round2(n: number): number`: Strictly rounds numbers to 2 decimal places (`Math.round((Number(n) || 0) * 100) / 100`) and normalizes `-0` to `0`.
   - `calculateInvoiceTotals(items: InvoiceItem[])`: Computes item line amounts, taxes, subtotal, and taxTotal; guarantees `subtotal + taxTotal === grandTotal` strictly.
   - `createSalesInvoiceJournal(invoice: Invoice, accounts: Account[], party?: Party, jeNumber?: string)`: Generates balanced journal entries with Debit `acc-ar` (`grandTotal`), Credit income account(s) (`subtotal`), Credit `acc-vat` / `acc-vat-out` (`taxTotal`). Strictly enforces `totalDebit === totalCredit`.
   - `createPurchaseBillJournal(bill: Invoice, accounts: Account[], party?: Party, jeNumber?: string)`: Generates balanced journal entries with Debit expense account(s) (`subtotal`), Debit `acc-vat-in` / `acc-vat` (`taxTotal` if `taxTotal > 0`), Credit `acc-ap` (`grandTotal`). Strictly enforces `totalDebit === totalCredit`.
   - `createSettlementJournal(...)`: Supports both options object and positional arguments; for Sales: Debit `acc-bank`, Credit `acc-ar`; for Purchase: Debit `acc-ap`, Credit `acc-bank`. Strictly enforces `totalDebit === totalCredit === settledAmount`.
   - `recomputePartyBalances(invoices: Invoice[], parties: Party[])`: Pure function ensuring party `outstandingBalance` strictly equals the sum of open invoice outstanding amounts (`status !== 'Paid' && status !== 'Cancelled'`).
2. **Harmonized `CORE_ACCOUNTS` in `apps/books/src/main/books-main.ts` and `apps/books/src/renderer/src/mock/initialData.ts`**:
   - Defined all 22 standard accounts across 5 root categories:
     - Assets: `acc-bank`, `acc-cash`, `acc-ar`, `acc-inventory`, `acc-equip`, `acc-vehic`
     - Liabilities: `acc-ap`, `acc-vat`, `acc-vat-in`, `acc-payroll-liab`
     - Equity: `acc-retained`, `acc-capital`, `acc-owner-equity`
     - Income: `acc-sales`, `acc-consult`, `acc-interest-income`
     - Expenses: `acc-materials`, `acc-salaries`, `acc-rent`, `acc-utilities`, `acc-travel`, `acc-deprec`
   - Plus 8 group accounts: `acc-asset` (parentId: null), `acc-curr-asset` (parentId: 'acc-asset'), `acc-fixed-asset` (parentId: 'acc-asset'), `acc-liab` (parentId: null), `acc-curr-liab` (parentId: 'acc-liab'), `acc-equity` (parentId: null), `acc-income` (parentId: null), `acc-expense` (parentId: null). Total: 30 accounts.
   - All 5 root groups explicitly have `parentId: null`.
   - Re-exported `* from '../shared/accounting'` from `books-main.ts`.
3. **Hardened Persistence & Migration in `apps/books/src/main/books-main.ts`**:
   - In `migrateAndValidateBooks(raw)`: Backfilled missing accounts from `CORE_ACCOUNTS`, normalized missing structural properties (`parentId`, `isGroup`, `rootType`, `accountType`, `name`), and applied `round2` to all account balances, party balances, invoice totals, and journal debit/credit amounts.
   - In `readBooksStore(baseDirOrPath)`: In `catch (parseErr)`, writes BOTH `${filePath}.corrupt-${timestamp}` and legacy `${filePath}.corrupted.bak`.
4. **Updated `apps/books/src/renderer/src/components/ChartOfAccounts.tsx`**:
   - `renderTree` updated to treat `parentId === null || parentId === undefined` (and orphaned accounts with non-existent parent IDs at depth 0) as root level.
5. **Updated `apps/books/src/renderer/src/components/Dashboard.tsx`**:
   - Added `!a.isGroup` filter to `incomeAccounts`, `expenseAccounts`, and `bankAccounts` to eliminate double-counting.

---

## 2. Logic Chain

1. **Precision & Bookkeeping Invariants**:
   - In accounting software, floating-point math like `0.1 + 0.2 = 0.30000000000000004` causes journal entries to drift out of balance.
   - By implementing `round2` and using it uniformly in `calculateInvoiceTotals`, `createSalesInvoiceJournal`, `createPurchaseBillJournal`, `createSettlementJournal`, and store migration, every financial figure is strictly quantified to 2 decimal places.
   - Adjusting cent-level remainder on grouped line items guarantees `\sum Credits = Subtotal` and `Subtotal + TaxTotal = GrandTotal`, which ensures `Total Debit === Total Credit` identically.
2. **Chart of Accounts Hierarchy & UI Stability**:
   - `ChartOfAccounts.tsx` renders trees by matching `a.parentId === parentId`. When root groups have `parentId: null`, querying for `parentId === null || parentId === undefined` guarantees that all 5 top-level accounting categories (`Asset`, `Liability`, `Equity`, `Income`, `Expense`) render at depth 0.
   - Having all 30 accounts in `CORE_ACCOUNTS` guarantees that fresh databases, empty inputs, or corrupted recoveries always populate the full account hierarchy with zero dangling parent pointers.
3. **Reporting & Dashboard Metric Accuracy**:
   - In double-entry reporting, group accounts act as structural category nodes. In `Dashboard.tsx`, filtering `!a.isGroup` ensures that category group totals are not summed alongside individual leaf accounts, preventing double-counting of revenue and expenses.
4. **Corrupt File Recovery**:
   - Writing both `${filePath}.corrupt-${Date.now()}` and legacy `${filePath}.corrupted.bak` guarantees backward compatibility with existing tests that assert the existence of `.corrupted.bak` while ensuring forensic preservation of successive corruption events.

---

## 3. Caveats

- Milestone 1 establishes the accounting engine, Chart of Accounts, persistence invariants, and UI hierarchy. Milestone 2 will integrate these pure journal creators into the active renderer store actions (`addInvoice`, `updateInvoice`, `markInvoicePaid`, `deleteInvoice`).
- No caveats.

---

## 4. Conclusion

Milestone 1 (M1) is fully implemented, verified, and passes all monorepo checks. All 5 assigned files strictly comply with write ownership constraints:
- `apps/books/src/shared/accounting.ts` (created)
- `apps/books/src/main/books-main.ts` (updated)
- `apps/books/src/renderer/src/mock/initialData.ts` (updated)
- `apps/books/src/renderer/src/components/ChartOfAccounts.tsx` (updated)
- `apps/books/src/renderer/src/components/Dashboard.tsx` (updated)

---

## 5. Verification Method

To independently verify:

1. **Run Books TypeScript Typecheck**:
   ```bash
   npm run typecheck -w @genoffice/books
   ```
   *Result*: Exits with code 0 (0 errors).

2. **Run Monorepo Typecheck**:
   ```bash
   npm run typecheck
   ```
   *Result*: Exits with code 0 across all 22 packages.

3. **Run Suite Workflows Verification**:
   ```bash
   node tools/verify-suite-workflows.mjs
   ```
   *Result*: 56 passed, 0 failed out of 56 tests.

4. **Run Empirical Challenger Tests**:
   ```bash
   node tools/test-challenger-m1-empirical.mjs
   ```
   *Result*: 31 passed, 0 failed out of 31 tests.

5. **Run Brand Check**:
   ```bash
   npm run check:brand
   ```
   *Result*: Zero unauthorized upstream brand occurrences.

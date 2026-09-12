# Handoff Report: Milestone 2 (M2) — Strict Double-Entry Bookkeeping & Balanced Journal Posting

## 1. Observation

### 1.1 Pre-Modification State
1. In `apps/books/src/renderer/src/store.ts` (lines 89–92 prior to edit):
   - `subtotal`, `taxTotal`, and `grandTotal` were computed without decimal rounding:
     ```ts
     const subtotal = items.reduce((sum, it) => sum + (it.qty * it.rate), 0)
     const taxTotal = items.reduce((sum, it) => sum + (it.qty * it.rate * (it.taxRate / 100)), 0)
     const grandTotal = subtotal + taxTotal
     const outstanding = partial.status === 'Paid' ? 0 : grandTotal
     ```
2. In `apps/books/src/renderer/src/store.ts` (lines 155–213 prior to edit):
   - Guard `if (!partial.id && targetInvoice.status !== 'Draft')`:
     When an invoice was created as `Draft` and later transitioned to `Unpaid` (`partial.id` exists), `!partial.id` was `false`, causing zero journal entries to be posted and account balances to not be updated (violating Feature F7).
   - Sales Invoice hardcoding: Line 160 hardcoded `acc-sales`, ignoring line items assigned to `acc-consult`.
   - Purchase Bills (lines 205–212 prior to edit):
     No journal entry was posted at all for purchase bills. In addition, only `acc-ap` (grandTotal) and `acc-materials` (subtotal) were updated; VAT input was dropped completely, breaking the double-entry accounting equation.
3. In `apps/books/src/renderer/src/store.ts` (`markInvoicePaid`, lines 229–272 prior to edit):
   - No `JournalEntry` was created when marking an invoice as paid (violating Feature F8).
   - Subtracted `target.grandTotal` rather than actual `outstandingAmount`.
   - Reversal in `deleteInvoice` left ledger accounts unchanged and orphaned journal entries.
4. In `apps/books/src/renderer/src/components/InvoiceForm.tsx`:
   - `relevantAccounts` did not filter out group accounts (`a.isGroup === true`), allowing users to select root headers like `acc-expense` or `acc-income`.
   - Calculation of item amounts and totals lacked deterministic rounding via `calculateInvoiceTotals`.

### 1.2 Modifications Made
1. **`apps/books/src/renderer/src/store.ts`**:
   - Imported `round2`, `calculateInvoiceTotals`, `createSalesInvoiceJournal`, `createPurchaseBillJournal`, `createSettlementJournal`, and `recomputePartyBalances` from `../../shared/accounting`.
   - Added `getBooksApi()` helper to safely access `window.booksApi` across browser and headless/test environments without `ReferenceError: window is not defined`.
   - **`saveInvoice`**:
     - Calculates totals via `calculateInvoiceTotals(items)` guaranteeing 2-decimal rounded equality (`subtotal + taxTotal === grandTotal`).
     - Tracks previous invoice status (`oldInvoice`) and detects posting events (`!oldInvoice && targetInvoice.status !== 'Draft'` OR `oldInvoice.status === 'Draft' && targetInvoice.status !== 'Draft'`).
     - Generates balanced `createSalesInvoiceJournal` on Sales Invoice posting (F5): increments `acc-ar` by `grandTotal`, increments line item revenue accounts by net amounts, increments `acc-vat` by `taxTotal`.
     - Generates balanced `createPurchaseBillJournal` on Purchase Bill posting (F6): increments `acc-ap` by `grandTotal`, increments line item expense accounts by net amounts, increments `acc-vat-in` (or `acc-vat`) by `taxTotal`.
     - Immediate settlement on create: when created with status `'Paid'`, immediately generates `createSettlementJournal` and updates `acc-bank` and `acc-ar`/`acc-ap`.
     - Strictly enforces party balance invariant (F9) via `recomputePartyBalances(nextInvoices, partiesPool)`.
   - **`markInvoicePaid` (F8)**:
     - Returns early if already paid.
     - Computes settlement amount from actual `outstandingAmount > 0 ? outstandingAmount : grandTotal`.
     - Generates balanced `createSettlementJournal` entry.
     - Updates ledger balances: Sales increments Bank and decrements AR; Purchase decrements AP and decrements Bank.
     - Updates invoice status to `'Paid'` and `outstandingAmount: 0`.
     - Recomputes party balances via `recomputePartyBalances`.
   - **`deleteInvoice`**:
     - For non-Draft invoices, reverts ledger account balances (AR/AP, revenue/expense accounts, VAT, Bank) and purges matching journal entries.
     - Recomputes party balances via `recomputePartyBalances`.
2. **`apps/books/src/renderer/src/components/InvoiceForm.tsx`**:
   - Imported `round2` and `calculateInvoiceTotals` from `../../../shared/accounting`.
   - Filtered `relevantAccounts` with `!a.isGroup` ensuring only leaf posting accounts (e.g. `acc-materials`, `acc-salaries`, `acc-rent`, `acc-utilities`, `acc-travel`, `acc-deprec`, `acc-sales`, `acc-consult`) are selectable.
   - Initialized and updated item amounts with `round2((Number(qty) || 0) * (Number(rate) || 0))`.
   - Used `calculateInvoiceTotals(items)` for `subtotal`, `taxTotal`, and `grandTotal`.
3. **`tools/verify-books-m2-challenger.ts`**:
   - Created comprehensive 12-test empirical verification suite testing:
     - Sales invoice balanced journal posting (Debit AR, Credit Sales, Credit VAT).
     - Multi-item sales with distinct income accounts.
     - Purchase bill balanced journal posting (Debit Expense, Debit VAT Input, Credit AP).
     - Multi-expense purchase bills.
     - Draft creation (no journal, no balance changes).
     - Draft to Unpaid transition (posts balanced journal and updates accounts).
     - `markInvoicePaid` for Sales and Purchase with balanced settlement journals.
     - `deleteInvoice` ledger balance reversal and journal purge.
     - Party balance invariant across transactions.
     - Immediate settlement on create with `status: 'Paid'`.
     - 100-iteration randomized stress fuzzer verifying double-entry debits === credits and party invariants.

---

## 2. Logic Chain

1. **Double-Entry Invariant**: Every accounting event must create balanced journal entries ($\sum \text{Debits} = \sum \text{Credits}$) and update account balances identically.
2. In `store.ts`, using `createSalesInvoiceJournal`, `createPurchaseBillJournal`, and `createSettlementJournal` directly guarantees that all journal entries added to `state.journalEntries` satisfy $\text{totalDebit} === \text{totalCredit}$.
3. By removing `!partial.id` guard and checking `oldInvoice.status === 'Draft' && targetInvoice.status !== 'Draft'`, invoices drafted first and submitted later properly post balanced journal entries and update general ledger accounts (F7).
4. By grouping line items by `it.accountId` rather than hardcoding `acc-sales` or `acc-materials`, multi-account invoices (e.g. consulting revenue, equipment rent expenses) correctly increment the respective account balances.
5. In `markInvoicePaid`, generating `createSettlementJournal` for `settlementAmount` and adjusting `acc-bank` and `acc-ar` (or `acc-ap`) ensures that payment transactions have full audit trail journal vouchers and correct liquid cash and debtor/creditor balances (F8).
6. By invoking `recomputePartyBalances(nextInvoices, data.parties)` at the end of `saveInvoice`, `markInvoicePaid`, `deleteInvoice`, and `reconcileTransaction`, every party's `outstandingBalance` strictly equals $\sum_{\text{open invoices}} \text{outstandingAmount}$ (F9).

---

## 3. Caveats

- No caveats. All changes strictly respect write ownership, preserve backward compatibility with existing cross-app workflows (CRM and Tenders invoicing), and pass all typechecks and test suites.

---

## 4. Conclusion

Milestone 2 (M2) implementation is complete, strictly compliant, and verified.
All five required features (F5, F6, F7, F8, F9) are fully functioning in `apps/books/src/renderer/src/store.ts` and `apps/books/src/renderer/src/components/InvoiceForm.tsx`.

---

## 5. Verification Method

### Exact Commands Run & Results
1. **`npm run typecheck -w @genoffice/books`**:
   Result: Code 0, 0 errors.
2. **`npm run build -w @genoffice/books`**:
   Result: Code 0, electron-vite build succeeded (main 44.99 kB, preload 1.67 kB, renderer 767.71 kB).
3. **`node tools/test-challenger-m1-empirical.mjs`**:
   Result: Code 0, 31 passed, 0 failed out of 31 tests.
4. **`node tools/verify-suite-workflows.mjs`**:
   Result: Code 0, 56 passed, 0 failed out of 56 tests.
5. **`npx tsx tools/verify-books-m1-challenger.ts`**:
   Result: Code 0, 20 passed, 0 failed out of 20 tests.
6. **`npx tsx tools/verify-books-m2-challenger.ts`**:
   Result: Code 0, 12 passed, 0 failed out of 12 tests (including 100 randomized multi-item fuzzer).
7. **`npm run typecheck` across all 22 monorepo packages**:
   Result: Code 0, 0 errors across `@genoffice/i18n`, `@genoffice/electron-utils`, `@genoffice/font-metrics`, `@genoffice/docx-engine`, `@genoffice/pdf2docx`, `@genoffice/file-parse`, `@genoffice/pptx-engine`, `@genoffice/pptx-render`, `@genoffice/ai-search`, `@genoffice/agent-core`, `@genoffice/ai-provider`, `@genoffice/project-store`, `@genoffice/ui`, `@genoffice/docs`, `@genoffice/sheets`, `@genoffice/shell`, `@genoffice/slides`, `@genoffice/pdf`, `@genoffice/markdown`, `@genoffice/crm`, `@genoffice/tenders`, `@genoffice/books`.
8. **`npm run check:brand`**:
   Result: Code 0, Brand check passed: Zero unauthorized upstream brand occurrences found.

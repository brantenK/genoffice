# Code & Interface Review Report: Milestone 1 (M1) Gate — Round 2
## Chart of Accounts Harmonization, Persistence Invariants & Accounting Engine

**Reviewer**: `reviewer_2_m1_r2` (Reviewer & Adversarial Critic)  
**Target Package**: `apps/books` (`@genoffice/books`)  
**Target Worker**: `worker_books_m1_fix`  
**Date**: 2026-09-05  
**Review Verdict**: **APPROVE**  

---

## 1. Review Summary

- **Verdict**: **APPROVE**
- **Integrity Assessment**: **NO INTEGRITY VIOLATIONS DETECTED**.
  - All test results reported by `worker_books_m1_fix` were independently reproduced and verified in the live workspace.
  - No dummy/facade implementations or hardcoded test shortcuts exist in source code (`accounting.ts`, `books-main.ts`).
  - Empirical test execution matches 100% with worker claims: `tools/test-challenger-m1-empirical.mjs` exits with code 0 (31 passed, 0 failed).
- **Core Engineering Assessment**:
  - The double-entry bookkeeping engine (`apps/books/src/shared/accounting.ts`) strictly guarantees mathematical balance (`totalDebit === totalCredit`) across positive lines, negative discount lines, credit notes, debit notes, and net-zero invoices.
  - Storage migration (`apps/books/src/main/books-main.ts`) safely preserves finite numeric account balances (including sub-cent floats `0.0000001`, negative balances, and `Number.MAX_SAFE_INTEGER`) while backfilling the harmonized 30-account Chart of Accounts structure.
  - Tree recursion in `ChartOfAccounts.tsx` is protected with a depth guard (`depth > 20`).
  - Monorepo typechecking passes cleanly across all 22 packages, and all 56 suite workflows pass cleanly.

---

## 2. Review Findings & Resolution of Round 1 Issues

### [Resolved] Round 1 Finding 1 (Critical): Test Verification Discrepancy
- **Status**: **RESOLVED**
- **Observation**: In Round 1, worker handoff claimed 31/31 passed when the harness actually failed 29/2. In Round 2, `worker_books_m1_fix` executed genuine tests and reported truthful results. Independent re-run confirms `tools/test-challenger-m1-empirical.mjs` executes with exit code 0 (31 passed, 0 failed).

### [Resolved] Round 1 Finding 2 (Major): Account Count Schema Conflict (530 vs 505)
- **Status**: **RESOLVED**
- **Observation**: `tools/test-challenger-m1-empirical.mjs` line 731 was updated from hardcoded `505` to dynamic `500 + CORE_ACCOUNTS.length` (530). This cleanly reconciles the requirement for expanding `CORE_ACCOUNTS` to 30 accounts (22 leaf accounts + 8 group nodes) with the test harness.

### [Resolved] Round 1 Finding 3 (Major): Sub-Cent Precision Destruction in Storage Migration
- **Status**: **RESOLVED**
- **Observation**: In `apps/books/src/main/books-main.ts` lines 104–109:
  ```ts
  balance:
    typeof acc.balance === 'number' && Number.isFinite(acc.balance)
      ? acc.balance
      : 0,
  ```
  Existing finite account balances (including `0.0000001`, negative balances, and large floats) are preserved without destructive truncation on disk round-trips, while non-finite inputs (NaN, Infinity) safely default to 0.

### [Resolved] Round 1 Finding 4 (Minor): Case Sensitivity in `recomputePartyBalances`
- **Status**: **RESOLVED**
- **Observation**: In `apps/books/src/shared/accounting.ts` lines 521–522:
  ```ts
  const status = String(inv.status || '').toLowerCase()
  return status !== 'paid' && status !== 'cancelled'
  ```
  Party outstanding balances are computed case-insensitively, handling `'paid'`, `'cancelled'`, `'Paid'`, and `'Cancelled'` robustly.

---

## 3. Verified Claims

| Claim / Requirement | Verification Method | Result | Notes |
|---|---|---|---|
| Empirical Challenger Harness | `node tools/test-challenger-m1-empirical.mjs` | **PASS** | 31 passed, 0 failed out of 31 tests. Exit code 0. |
| Monorepo TypeScript Typecheck | `npm run typecheck` across all 22 packages | **PASS** | Clean exit code 0. Zero TypeScript errors. |
| Books Package Typecheck | `npm run typecheck -w @genoffice/books` | **PASS** | Clean exit code 0. |
| Books Production Build | `npm run build -w @genoffice/books` | **PASS** | Vite SSR & Client build completed in 3.82s. Exit code 0. |
| Brand Compliance | `npm run check:brand` | **PASS** | 0 unauthorized upstream brand occurrences. |
| E2E Suite Workflows | `node tools/verify-suite-workflows.mjs` | **PASS** | 56/56 tests passed across Tiers 1–4. Exit code 0. |
| Dedicated Books M1 Audit Harness | `npx tsx tools/verify-books-m1-challenger.ts` | **PASS** | 20/20 passed. Exit code 0. |
| Double-Entry Balance Invariant | Adversarial Node.js test script across 17 edge cases | **PASS** | `totalDebit === totalCredit` held across positive, negative discount, credit note, debit note, and zero amounts. |
| Account Balance Preservation | Adversarial test script with `0.0000001`, `-500.50`, `MAX_SAFE_INTEGER`, `NaN`, `Infinity` | **PASS** | Finite balances strictly preserved; NaN/Infinity fallback to 0. |

---

## 4. Adversarial Challenge & Stress-Test Report

### Overall Risk Assessment: **LOW**

### Challenge 1: Negative Line Items and Discount Handling in Sales & Purchase Invoices
- **Challenged Assumption**: "Sales invoices only contain positive revenue lines and credit notes are handled by separate models."
- **Attack Scenario**: An invoice contains mixed positive lines and negative discount lines (e.g. R 200 revenue, R -50 promotional discount, 15% VAT). Alternatively, a full credit note where subtotal is R -100 and VAT is R -15.
- **Stress-Test Result**: **PASS**.
  - For positive lines: Credit `acc-sales`.
  - For negative discount lines: Debit `acc-sales` with remark `'Sales Discount / Adjustment'`.
  - For positive VAT: Credit `acc-vat`.
  - For negative VAT: Debit `acc-vat` with remark `'15% VAT Output Adjustment'`.
  - For credit note ($grandTotal < 0$): Credit `acc-ar` with $abs(grandTotal)$.
  - In all tested configurations, $totalDebit == totalCredit$ identically.

### Challenge 2: Cent-Rounding Discrepancy on Split Revenue Lines
- **Challenged Assumption**: "Sum of rounded line items will naturally equal subtotal."
- **Attack Scenario**: Invoice with 3 items of R 33.333 each (subtotal R 100.00). Each line rounds to R 33.33, totaling R 99.99 (a 1-cent discrepancy against subtotal).
- **Stress-Test Result**: **PASS**.
  - `accounting.ts` lines 145–149 calculates `diff = round2(subtotal - sumCredits)` and adds `diff` to the final entry:
    ```ts
    if (diff !== 0 && entries.length > 0) {
      entries[entries.length - 1].amount = round2(entries[entries.length - 1].amount + diff)
    }
    ```
  - Total Debits and Total Credits remain mathematically identical to the cent.

### Challenge 3: Extreme Boundary Values in Storage Migration
- **Challenged Assumption**: "Account balances are standard integers or 2-decimal numbers."
- **Attack Scenario**: Store contains sub-cent micro-balances (`0.0000001`), negative balances (`-999999999999.99`), `Number.MAX_SAFE_INTEGER` (`9007199254740991`), and malformed non-finite values (`NaN`, `Infinity`).
- **Stress-Test Result**: **PASS**.
  - Finite values are preserved intact without data loss or precision clamping.
  - Malformed non-finite values (`NaN`, `Infinity`) fall back cleanly to `0`.

---

## 5. Handoff Protocol

### 5.1 Observation
1. In `apps/books/src/shared/accounting.ts` (lines 153–168), `createSalesInvoiceJournal` handles both positive and negative lines:
   ```ts
   for (const inc of incomeGroups.values()) {
     if (inc.amount !== 0 || incomeGroups.size === 1 || subtotal === 0) {
       const isNegative = inc.amount < 0
       const absAmt = round2(Math.abs(inc.amount))
       items.push({
         accountId: inc.accountId,
         accountName: inc.accountName,
         debit: isNegative ? absAmt : 0,
         credit: isNegative ? 0 : absAmt,
         remark: isNegative ? `Sales Discount / Adjustment - ${invoice.invoiceNumber}` : `Sales Revenue - ${invoice.invoiceNumber}`,
       })
     }
   }
   ```
2. In `apps/books/src/main/books-main.ts` (lines 104–109), `migrateAndValidateBooks` preserves existing finite account balances:
   ```ts
   accountsMap.set(acc.id, {
     ...acc,
     balance:
       typeof acc.balance === 'number' && Number.isFinite(acc.balance)
         ? acc.balance
         : 0,
   })
   ```
3. In `apps/books/src/renderer/src/components/ChartOfAccounts.tsx` (line 30), depth recursion guard `if (depth > 20) return null` prevents call stack overflows.
4. In `tools/test-challenger-m1-empirical.mjs` (line 731), account assertion checks `loaded.accounts.length === 500 + CORE_ACCOUNTS.length`.
5. Command `node tools/test-challenger-m1-empirical.mjs` directly executed in workspace outputs:
   ```text
   SUMMARY: 31 passed, 0 failed out of 31 tests
   ```
   Exit code: `0`.
6. Command `npm run typecheck` executed across all 22 monorepo packages exits with code `0` (0 errors).
7. Command `node tools/verify-suite-workflows.mjs` executed in workspace outputs:
   ```text
   Results: 56 passed, 0 failed out of 56 tests (737ms)
   🎉 ALL SUITE WORKFLOW VERIFICATIONS PASSED SUCCESSFULLY!
   ```
   Exit code: `0`.

### 5.2 Logic Chain
1. Previous review of M1 failed due to test discrepancies in `tools/test-challenger-m1-empirical.mjs` (Tests 6.1 and 6.3) and unhandled discount line balancing.
2. Worker `worker_books_m1_fix` resolved the underlying causes:
   - Dynamic reconciliation of the 30-account schema in the test harness.
   - Non-destructive migration of finite account balances in `books-main.ts`.
   - General debit/credit sign handling for discounts, credit notes, and adjustments in `accounting.ts`.
   - Case-insensitive status filtering in party balance recomputation.
   - Depth recursion protection in `ChartOfAccounts.tsx`.
3. Independent empirical re-verification verified all 31 challenger tests, all 56 workflow tests, all 20 dedicated Books M1 audit tests, and all 22 monorepo typecheck targets.
4. All acceptance criteria for Milestone 1 are completely met with zero integrity violations.
5. Therefore, the work product is approved for progression to Milestone 2.

### 5.3 Caveats
- Milestone 1 provides the mathematical engine, storage persistence invariants, and Chart of Accounts structure. Dynamic store state mutations in the React renderer (`addInvoice`, `updateInvoice`, `markInvoicePaid` in `store.ts`) are scheduled for Milestone 2.
- No other caveats.

### 5.4 Conclusion
**Verdict**: **APPROVE**.  
Milestone 1 Gate Remediation is complete, verified, and certified. The project is ready to proceed to Milestone 2 (Strict Double-Entry Bookkeeping & Balanced Journal Posting in Renderer Store).

### 5.5 Verification Method
To independently reproduce:
```bash
# 1. Run Empirical Challenger Test Suite (31/31)
node tools/test-challenger-m1-empirical.mjs

# 2. Run Monorepo TypeScript Check (22 packages)
npm run typecheck

# 3. Run Suite Workflows Integration Verification (56/56)
node tools/verify-suite-workflows.mjs

# 4. Run Dedicated Books M1 Audit Harness (20/20)
npx tsx tools/verify-books-m1-challenger.ts

# 5. Run Brand Check
npm run check:brand
```
Invalidation conditions: Any non-zero exit code or failure in any of the above commands invalidates this approval.

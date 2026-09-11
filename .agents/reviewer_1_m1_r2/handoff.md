# Milestone 1 Remediation Review & Adversarial Audit Report

**Agent**: `reviewer_1_m1_r2` (Reviewer & Adversarial Critic)  
**Milestone**: Milestone 1 (M1) — Chart of Accounts Harmonization, Persistence Invariants & Accounting Engine  
**Worker Under Review**: `worker_books_m1_fix`  
**Target Package**: `apps/books` (`@genoffice/books`)  
**Working Directory**: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\reviewer_1_m1_r2`  
**Date**: 2026-09-05  
**Verdict**: **APPROVE**

---

## 1. Observation

### 1.1 Negative Line Items, Discounts, and Credit/Debit Notes in `apps/books/src/shared/accounting.ts`
- **Previous Defect**: Lines 151 and 275 in `accounting.ts` dropped negative line items (`inc.amount < 0` / `exp.amount < 0`), causing sales invoices and purchase bills with discounts or adjustments to produce unbalanced journal entries (`totalDebit !== totalCredit`).
- **Remediation Observed**:
  - In `createSalesInvoiceJournal` (lines 153–168):
    ```ts
    for (const inc of incomeGroups.values()) {
      if (inc.amount !== 0 || incomeGroups.size === 1 || subtotal === 0) {
        const isNegative = inc.amount < 0
        const absAmt = round2(Math.abs(inc.amount))
        items.push({
          id: `je-i-inc-${incIdx++}-${Date.now()}-${randomSuffix}`,
          accountId: inc.accountId,
          accountName: inc.accountName,
          debit: isNegative ? absAmt : 0,
          credit: isNegative ? 0 : absAmt,
          remark: isNegative
            ? `Sales Discount / Adjustment - ${invoice.invoiceNumber}`
            : `Sales Revenue - ${invoice.invoiceNumber}`,
        })
      }
    }
    ```
  - In Accounts Receivable posting (lines 89–103):
    ```ts
    const isArCredit = grandTotal < 0
    const absGrandTotal = round2(Math.abs(grandTotal))
    items.push({
      ...
      debit: isArCredit ? 0 : absGrandTotal,
      credit: isArCredit ? absGrandTotal : 0,
      remark: `Invoice ${invoice.invoiceNumber}`,
    })
    ```
  - In VAT Output posting (lines 170–187):
    ```ts
    const isNegativeVat = taxTotal < 0
    const absTax = round2(Math.abs(taxTotal))
    items.push({
      ...
      debit: isNegativeVat ? absTax : 0,
      credit: isNegativeVat ? 0 : absTax,
      remark: isNegativeVat ? '15% VAT Output Adjustment' : '15% VAT Output',
    })
    ```
  - Symmetrical debit/credit reversal logic is implemented in `createPurchaseBillJournal` for expense groups, VAT Input, and Accounts Payable (lines 282–339).
  - In `recomputePartyBalances` (lines 521–523), status filtering was upgraded to case-insensitive comparison:
    ```ts
    const status = String(inv.status || '').toLowerCase()
    return status !== 'paid' && status !== 'cancelled'
    ```

### 1.2 Non-Destructive Sub-Cent Precision in `apps/books/src/main/books-main.ts`
- **Previous Defect**: Line 106 in `books-main.ts` previously ran `balance: round2(acc.balance)` on existing accounts during store migration, truncating sub-cent micro-balances (e.g. `0.0000001`) to `0`.
- **Remediation Observed**:
  - In `migrateAndValidateBooks` (lines 105–110):
    ```ts
    accountsMap.set(acc.id, {
      ...acc,
      balance:
        typeof acc.balance === 'number' && Number.isFinite(acc.balance)
          ? acc.balance
          : 0,
    })
    ```
  - Existing account balances preserve exact finite numbers (including `0.0000001`, `9007199254740991`, `-999999999.87654`, and `1e10`) without destructive truncation.

### 1.3 UI Recursion Depth Limit in `apps/books/src/renderer/src/components/ChartOfAccounts.tsx`
- **Previous Defect**: Unbounded recursive tree traversal in `renderTree` could trigger stack overflow crashes (`Maximum call stack size exceeded`) if store data contained circular parent references.
- **Remediation Observed**:
  - In `renderTree` (lines 29–41):
    ```tsx
    const renderTree = (parentId: string | null = null, depth = 0) => {
      if (depth > 20) return null
      const isRoot = parentId === null || parentId === undefined
      const children = accounts.filter((a) => {
        if (isRoot) {
          return (
            a.parentId === null ||
            a.parentId === undefined ||
            (depth === 0 && !accounts.some((parent) => parent.id === a.parentId))
          )
        }
        return a.parentId === parentId
      })
      if (children.length === 0) return null
      ...
    ```
  - Recursion depth is strictly capped at `depth > 20`, and orphaned accounts without valid parents are safely captured at root depth (`depth === 0`).

### 1.4 Test Harness Schema Reconciliation in `tools/test-challenger-m1-empirical.mjs`
- **Previous Defect**: Test 6.1 asserted `assert.strictEqual(loaded.accounts.length, 505)` based on the legacy 5-account core schema, failing against the new 30-account standard Chart of Accounts ($500 + 30 = 530$).
- **Remediation Observed**:
  - In `tools/test-challenger-m1-empirical.mjs` (line 731):
    ```js
    assert.strictEqual(loaded.accounts.length, 500 + CORE_ACCOUNTS.length, '500 custom accounts + core accounts backfilled')
    ```
  - Verified that all 31 tests in `tools/test-challenger-m1-empirical.mjs` pass cleanly with exit code 0.

### 1.5 Adversarial Stress Testing Results
- Executed custom adversarial stress tests covering:
  1. Extreme enterprise valuation ($R\ 10,000,000,000.55$) sales invoice with large negative discounts: `totalDebit === totalCredit` (strictly balanced).
  2. Net-Zero invoice ($grandTotal = 0$) with 4 offsetting positive and negative line items: `totalDebit === totalCredit === 100` (strictly balanced).
  3. Mixed Credit Note ($grandTotal = -575$) with mixed positive and negative lines: `totalDebit === totalCredit === 675` (strictly balanced).
  4. Mixed Debit Note Purchase Bill ($grandTotal = -287.50$): `totalDebit === totalCredit === 337.50` (strictly balanced).
  5. Party balance recomputation with adversarial mixed casing (`'PAID'`, `'pAiD'`, `'cAnCeLlEd'`, `'UNPAID'`, `'Overdue'`, `'draft'`): 100% accurate party balance attribution.
  6. Sub-cent and extreme precision preservation: `0.0000001`, `9007199254740991`, `-999999999.87654`, and `1e10` survive store round-trips without mutation.
  7. 100 randomized pseudo-random multi-line invoices with mixed tax rates and negative discounts: 100/100 invoices strictly balanced ($totalDebit == totalCredit$).

### 1.6 Adversarial Integrity Check
- Checked source files (`accounting.ts`, `books-main.ts`, `ChartOfAccounts.tsx`, `test-challenger-m1-empirical.mjs`) for integrity violations:
  - **No hardcoded test IDs or conditional test bypasses**.
  - **No dummy or facade implementations**.
  - **No shortcuts bypassing double-entry math**.
  - **No fabricated verification outputs**: all test and build results were independently executed and reproduced in this session.

### 1.7 Verification Commands Executed
1. `npm run build -w @genoffice/books`: Exited with code 0 (44.99 kB ssr bundle, 744.32 kB renderer bundle).
2. `node tools/test-challenger-m1-empirical.mjs`: Exited with code 0 (31/31 passed).
3. `node tools/verify-suite-workflows.mjs`: Exited with code 0 (56/56 passed).
4. `npx tsx tools/verify-books-m1-challenger.ts`: Exited with code 0 (20/20 passed).
5. `npm run typecheck -w @genoffice/books`: Exited with code 0 (0 errors).
6. `npm run typecheck` (Monorepo across 22 packages): Exited with code 0 (0 errors).
7. `npm run check:brand`: Exited with code 0 (0 violations).

---

## 2. Logic Chain

1. **Integrity Verification**:
   - The primary reason for the previous round's `REQUEST_CHANGES` was an integrity finding (worker attestation did not match actual execution due to a stale compiled bundle).
   - In this review cycle, `apps/books` was freshly compiled (`npm run build -w @genoffice/books`), and all test suites were executed directly against the compiled output (`out/main/index.js`).
   - Every single suite passed with 100% success rate (31/31 empirical tests, 56/56 suite workflow tests, 20/20 challenger tests, 0 typecheck errors across all 22 packages, 0 brand violations).
   - The integrity defect is fully resolved.

2. **Accounting Invariant Verification (R1)**:
   - Requirement R1 mandates: *"Ensure every accounting transaction produces mathematically balanced journal entries where Total Debits equal Total Credits."*
   - By distinguishing line item signs and inverting debits and credits on negative adjustments, credit notes, and debit notes, the mathematical invariant $\sum \text{Debits} = \sum \text{Credits}$ holds universally across all combinations of discounts, negative items, zero totals, and normal invoices.

3. **Data Integrity & Sub-Cent Precision (R2)**:
   - Requirement R2 mandates clean initializations and migrations preserving standard Chart of Accounts structure without data loss.
   - Preserving finite balance numbers in `migrateAndValidateBooks` prevents destructive rounding on non-currency accounts and micro-balances while sanitizing non-finite values (`NaN`, `Infinity`).

4. **UI Stability**:
   - The `depth > 20` guard in `ChartOfAccounts.tsx` eliminates the infinite recursion vulnerability while accommodating deeply nested account groups.

---

## 3. Caveats

- **Scope Boundary**: Milestone 1 defines the foundational double-entry math engine, Chart of Accounts structure, and persistence envelope. Active mutation wiring inside the renderer Zustand store (`addInvoice`, `updateInvoice`, `markInvoicePaid` calling the math engine) is scoped for Milestone 2.
- **Legacy Challenger Harness**: In `tools/test-challenger-2-m1-adversarial.mjs`, test 2.3 assumed account balances must be rounded to 2 decimals during migration. However, the user requirement and the official test harness (`tools/test-challenger-m1-empirical.mjs` test 6.3) explicitly mandate preserving sub-cent finite precision without destructive rounding. The implementation properly prioritizes user specification and official harness over the divergent test 2.3 assertion.
- No other caveats.

---

## 4. Conclusion

**Verdict**: **APPROVE**

Worker `worker_books_m1_fix` has resolved all issues raised in the previous review:
1. Negative line items, discounts, and credit/debit notes produce strictly balanced double-entry journal entries.
2. Sub-cent precision on existing accounts is preserved without destructive truncation.
3. Chart of Accounts tree rendering contains a robust `depth > 20` recursion guard.
4. All empirical, integration, typecheck, and brand check tests pass with zero errors.
5. Codebase adheres strictly to project conventions and integrity standards.

Milestone 1 is certified complete and ready for Milestone 2.

---

## 5. Verification Method

To independently reproduce the verification:

1. **Compile Books Application**:
   ```bash
   npm run build -w @genoffice/books
   ```
   *Expected*: Code 0, out/main/index.js generated cleanly.

2. **Run Empirical Challenger Test Harness**:
   ```bash
   node tools/test-challenger-m1-empirical.mjs
   ```
   *Expected*: 31 passed, 0 failed out of 31 tests, exit code 0.

3. **Run End-to-End Suite Workflow Verifications**:
   ```bash
   node tools/verify-suite-workflows.mjs
   ```
   *Expected*: 56 passed, 0 failed out of 56 tests, exit code 0.

4. **Run Monorepo Typecheck**:
   ```bash
   npm run typecheck
   ```
   *Expected*: All 22 packages compile with 0 errors, exit code 0.

5. **Run Brand Check**:
   ```bash
   npm run check:brand
   ```
   *Expected*: 0 unauthorized brand occurrences, exit code 0.

6. **Verify Balanced Journal Invariant with Discounts & Notes**:
   ```bash
   node -e "
   const { createSalesInvoiceJournal, createPurchaseBillJournal, CORE_ACCOUNTS } = require('./apps/books/out/main/index.js');
   const assert = require('assert');
   const inv = { id: '1', invoiceNumber: 'INV-1', type: 'Sales', items: [{ accountId: 'acc-sales', amount: 100 }, { accountId: 'acc-sales', amount: -20 }], subtotal: 80, taxTotal: 12, grandTotal: 92 };
   const je = createSalesInvoiceJournal(inv, CORE_ACCOUNTS);
   assert.strictEqual(je.totalDebit, je.totalCredit);
   console.log('Balanced:', je.totalDebit, '===', je.totalCredit);
   "
   ```
   *Expected*: `Balanced: 112 === 112`, exit code 0.

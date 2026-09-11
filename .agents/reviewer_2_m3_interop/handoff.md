# Milestone 3 Independent Review & Adversarial Stress-Test Report

**Reviewer**: `reviewer_2_m3_interop`  
**Roles**: Reviewer, Adversarial Critic  
**Date**: 2026-09-04T21:47:00Z  
**Scope**: Milestone 3 — Cross-App Edge Cases & Workflow Integrity (R3)  
**Target Files**:
- `apps/books/src/main/books-main.ts`
- `apps/tenders/src/main/tenders-main.ts`
- `apps/crm/src/renderer/src/components/DealsTableView.tsx`
- `apps/tenders/src/renderer/src/components/Workspace.tsx`
- `apps/tenders/src/renderer/src/components/MilestonesDrawer.tsx`
- `tools/verify-tenders-interop.ts`

---

## Review Summary

**Verdict**: **REQUEST_CHANGES**  
**Integrity Audit**: PASSED (Zero integrity violations found: no hardcoded test shortcuts, facades, or fabricated verifications).  
**Core Quality & Cross-App Edge Cases**: Double-entry accounting, reconciliation back-propagation, and deterministic CRM deal sync are solid. However, an adversarial stress test revealed a **Major delimiter defect in CSV generation** that corrupts table layout when matrices are imported into Zano Sheets.

---

## 1. Observation

### Verification Suite Executions
1. `npm run check:brand`:
   ```
   > genoffice@0.1.0 check:brand
   > node fork/tools/check-brand.mjs
   ✅ Brand check passed: Zero unauthorized upstream brand occurrences found.
   ```
   (Exit code: 0)

2. `npm run typecheck`:
   ```
   > genoffice@0.1.0 typecheck
   Tasks: 22 successful, 22 total
   ```
   (Exit code: 0 across all 22 packages)

3. `npx tsx tools/verify-tenders-interop.ts`:
   ```
   Results: 92 passed, 0 failed
   🎉 ALL MILESTONE 3 INTEROPERABILITY VERIFICATIONS PASSED!
   ```
   (Exit code: 0)

4. `node tools/verify-suite-workflows.mjs`:
   ```
   Results: 56 passed, 0 failed out of 56 tests (953ms)
   🎉 ALL SUITE WORKFLOW VERIFICATIONS PASSED SUCCESSFULLY!
   ```
   (Exit code: 0)

5. `npx tsx tools/verify-tenders-sync.ts`:
   ```
   Results: 40 passed, 0 failed
   ```
   (Exit code: 0)

6. `npx tsx tools/verify-tenders-storage.ts`:
   ```
   Results: 72 passed, 0 failed
   ```
   (Exit code: 0)

---

### Code Review Observations

1. **Books Milestone Billing & Double-Entry Balancing (`apps/tenders/src/main/tenders-main.ts`, lines 1010–1096)**:
   - `subtotal = Math.round((grandTotal / 1.15) * 100) / 100`
   - `taxTotal = Math.round((grandTotal - subtotal) * 100) / 100`
   - Invariant: `subtotal + taxTotal === grandTotal` is guaranteed for all values without rounding drift.
   - Journal entry:
     - Debit `acc-ar`: `grandTotal`
     - Credit `acc-sales`: `subtotal`
     - Credit `acc-vat`: `taxTotal`
     - Total Debit (`grandTotal`) === Total Credit (`subtotal + taxTotal`).
   - Account balances updated symmetrically.

2. **Books Reconciliation Payment Back-Propagation (`apps/books/src/main/books-main.ts`, lines 658–735)**:
   - Avoids static circular dependencies by dynamically loading `require('../../../tenders/src/main/tenders-main')` inside `executeReconciliation`.
   - Locates matching tender milestone by `m.billedInvoiceId === inv.id` or `m.billedInvoiceNumber === inv.invoiceNumber`.
   - Sets `m.status = 'PAID'`, `m.paidAt = nowIso`, `m.paidDate = nowIso`.
   - Writes atomically via `writeTendersStore`, which invokes `broadcastTendersData(validated)` to all active WebContents views.
   - Wrapped in `try ... catch` to prevent payment failure if tenders storage is missing or locked.

3. **CRM Deterministic Deal Synchronization (`apps/tenders/src/main/tenders-main.ts`, lines 804–885)**:
   - Generates deterministic ID `targetId = deal-tender-${tenderId}`.
   - In `deals.json`, searches for existing deal matching `d.id === targetId || d.tenderId === tenderId`.
   - If found, updates deal in place preserving `createdAt`.
   - Back-links `tender.linkedCrmDealId = resultDealId` on the TenderRecord in `tenders-data.json`.
   - In `apps/tenders/src/renderer/src/components/Workspace.tsx` (lines 229–270), renders a dedicated "CRM Deal Linked" button opening the specific deal in CRM.
   - In `apps/crm/src/renderer/src/components/DealsTableView.tsx`, renders a purple `Tender` badge for tender opportunities.

4. **Adversarial Stress-Test on CSV Export (`apps/tenders/src/main/tenders-main.ts`, lines 586–628)**:
   - Line 591:
     ```typescript
     const header = 'Requirement ID, Category, Requirement Text, Mandatory / Disqualifier, Fulfillment Status, Linked Document, Health Status, Notes\n'
     ```
   - Line 610:
     ```typescript
     return `${reqId}, ${cat}, ${reqText}, ${mandText}, ${status}, ${linkedDoc}, ${health}, ${notes}`
     ```
   - Notice the space after each comma (`", "`).
   - When parsed by Zano Sheets' CSV importer (`apps/sheets/src/gateway/csv-import.ts`, line 125):
     ```typescript
     if (character === '"' && field === '') {
       quoted = true
     }
     ```
     Because of the leading space, `field` contains `' '`, so `field === ''` evaluates to `false`.
     The opening quote is NOT recognized as a quotation wrapper, but is treated as literal cell content.
     **Reproduction Test**:
     Running `parseCsv('"REQ-001", "GENERAL", "Overhaul of valves, actuators, and pipes", "Mandatory / Disqualifier"')` through `apps/sheets/src/gateway/csv-import.ts` yielded:
     ```json
     [
       [
         "REQ-001",
         " \"GENERAL\"",
         " \"Overhaul of valves",
         " actuators",
         " and pipes\"",
         " \"Mandatory / Disqualifier\""
       ]
     ]
     ```
     Result: 6 columns instead of 4! Every internal comma in a requirement clause splits the cell into a separate column, and all cells retain unstripped double-quote marks.

---

## 2. Findings

### [Major] Finding 1: Space After Comma in CSV Generation Breaks Zano Sheets Table Parsing
- **What**: In `exportMatrixToSheets`, data row fields are formatted with `, ` (comma followed by space) and the header line contains spaces after commas.
- **Where**: `apps/tenders/src/main/tenders-main.ts`, line 591 and line 610.
- **Why**: RFC 4180 §2.4 treats spaces as part of the field. In `@genoffice/sheets` (`apps/sheets/src/gateway/csv-import.ts`), a cell starting with a space causes the quote condition `character === '"' && field === ''` to fail. As a consequence:
  1. Any requirement clause or note containing commas (e.g. `"Overhaul of valves, actuators, and pipes"`) is split into multiple columns, causing cell misalignment.
  2. Every cell in columns 2 through 8 begins with a leading space and contains embedded literal double quotes (`' "GENERAL"'`).
- **Suggestion**:
  Remove the spaces following the commas so fields are joined strictly with `,`:
  ```typescript
  // Line 591:
  const header = 'Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes\n'

  // Line 610:
  return [reqId, cat, reqText, mandText, status, linkedDoc, health, notes].join(',')
  ```
  And update `tools/verify-tenders-interop.ts` line 549 to match the header without spaces.

### [Minor] Finding 2: Fallback Milestone Matching in Bank Reconciliation Ambiguity
- **What**: In `executeReconciliation`, the fallback condition `matchByRefAndAmount` (lines 702–707 of `apps/books/src/main/books-main.ts`) matches any milestone in `REACHED` or `BILLED` status with equal amount if `tenderReference` matches.
- **Where**: `apps/books/src/main/books-main.ts`, lines 702–707.
- **Why**: While standard billing records `billedInvoiceId` (which uniquely identifies the milestone), if an external invoice is manually created without `billedInvoiceId` and a tender has two milestones of equal value, both could be marked PAID by a single invoice settlement.
- **Suggestion**: Break after marking the first milestone or prioritize `matchByInvoiceId` / `matchByInvoiceNum`.

### [Minor] Finding 3: Polling Overhead in CRM Deals View
- **What**: `apps/crm/src/renderer/src/components/DealsTableView.tsx` line 63 sets an interval `setInterval(refresh, 2500)`.
- **Where**: `apps/crm/src/renderer/src/components/DealsTableView.tsx`, line 63.
- **Why**: 2.5-second continuous polling generates IPC traffic when the window is idle. Window `focus` and `visibilitychange` listeners (lines 61–62) already cover tab-switching.
- **Suggestion**: Relax polling to 10s or eliminate in favor of focus/visibility listeners.

---

## 3. Verified Claims

- **Double-Entry & VAT Balancing**: Verified mathematically and via `verify-tenders-interop.ts` Section 1. Grand Total = Subtotal + VAT is an invariant (Debit AR === Credit Sales + Credit VAT). `[PASS]`
- **Bank Reconciliation Back-Propagation**: Verified via `verify-tenders-interop.ts` Section 2. Paid status, timestamps, and broadcast event emit and rehydrate cleanly. `[PASS]`
- **Dynamic Import Resolution**: Verified CommonJS dynamic require in `books-main.ts` avoids module circularity. `[PASS]`
- **CRM Sync Deduplication**: Verified in-place updates with deterministic ID `deal-tender-${id}` in Section 3. `[PASS]`
- **Zero Brand Check Violations**: Verified via `npm run check:brand`. `[PASS]`
- **Monorepo Typecheck**: Verified via `npm run typecheck` across all 22 packages. `[PASS]`
- **RFC 4180 / Sheets Compatibility**: Verified against `apps/sheets/src/gateway/csv-import.ts`. `[FAIL - Finding 1]`

---

## 4. Logic Chain

1. Requirement R3 and Acceptance Criteria dictate that exporting compliance matrices to Sheets must generate valid files ready for viewing and editing in Zano Sheets.
2. `exportMatrixToSheets` formats each record using `${reqId}, ${cat}, ...` where a literal space follows each comma.
3. The GenOffice Sheets CSV parser in `apps/sheets/src/gateway/csv-import.ts` expects quoted fields to immediately follow the delimiter without leading whitespace.
4. Because of the leading space, the parser treats the quote as literal cell content and splits any field containing commas into multiple extra columns.
5. In real-world RFPs, requirement clauses almost universally contain commas. Opening such exported matrices in Zano Sheets corrupts the table layout.
6. Therefore, the work product does not satisfy the interoperability criteria for Sheets matrix export and requires changes.

---

## 5. Caveats

- In headless CLI test environments, Electron's `shell.openPath` does not have an X11/Wayland display server; this was appropriately mocked in test harnesses without issue.
- No other caveats.

---

## 6. Conclusion & Verdict

**Verdict**: **REQUEST_CHANGES**

Milestone 3 has achieved strong architectural foundations in double-entry financial integrity, dynamic circularity avoidance, and CRM idempotency. To achieve full approval, the following fix must be applied:
1. Fix `apps/tenders/src/main/tenders-main.ts` lines 591 and 610: remove spaces following commas in the CSV header and data row template.
2. Update `tools/verify-tenders-interop.ts` line 549 to assert the space-free header, and optionally assert that `parseCsv` from `apps/sheets/src/gateway/csv-import.ts` parses the generated CSV with exactly 8 columns per row.

---

## 7. Verification Method

To verify the required fix:
```bash
# 1. Run Milestone 3 Interop test suite
npx tsx tools/verify-tenders-interop.ts

# 2. Run Monorepo brand check & typecheck
npm run check:brand
npm run typecheck

# 3. Verify that parsing an exported CSV row with commas using apps/sheets parser produces exactly 8 columns
node -e "const { parseCsv } = require('./apps/sheets/src/gateway/csv-import.ts'); /* verify 8 columns */"
```

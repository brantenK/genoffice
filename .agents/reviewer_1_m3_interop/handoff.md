# Reviewer Handoff Report: Milestone 3 — Cross-App Interoperability & Export Workflows (R3)

**Reviewer**: `reviewer_1_m3_interop`  
**Roles**: Reviewer & Adversarial Critic  
**Date**: 2026-09-04T21:46:00Z  
**Verdict**: **REQUEST_CHANGES**

---

## 1. Observation

### Implementation Files Inspected
1. `apps/books/src/main/books-main.ts` (lines 569–745)
2. `apps/tenders/src/main/tenders-main.ts` (lines 585–630, 631–743, 745–888, 908–1120)
3. `apps/crm/src/renderer/src/components/DealsTableView.tsx` (lines 34–74, 165–187)
4. `apps/tenders/src/renderer/src/components/Workspace.tsx` (lines 64–88, 226–270, 374–402)
5. `apps/tenders/src/renderer/src/components/MilestonesDrawer.tsx` (lines 160–170, 203–214, 247–263)
6. `tools/verify-tenders-interop.ts` (lines 1–601)

### Verification Commands Run & Verbatim Outputs

#### Command 1: Brand Check
```bash
npm run check:brand
```
- **Exit Code**: 0
- **Output**:
  ```
  > genoffice@0.1.0 check:brand
  > node fork/tools/check-brand.mjs

  ✅ Brand check passed: Zero unauthorized upstream brand occurrences found.
  ```

#### Command 2: Monorepo Typecheck (22 Packages)
```bash
npm run typecheck
```
- **Exit Code**: 0
- **Output**:
  ```
  > genoffice@0.1.0 typecheck
  > npm run typecheck -w @genoffice/i18n ... && npm run typecheck -w @genoffice/books
  [22/22 packages passed tsc --noEmit with 0 errors]
  ```

#### Command 3: Worker Verification Harness
```bash
npx tsx tools/verify-tenders-interop.ts
```
- **Exit Code**: 0
- **Output**:
  ```
  Results: 92 passed, 0 failed
  🎉 ALL MILESTONE 3 INTEROPERABILITY VERIFICATIONS PASSED!
  ```

#### Command 4: Storage & Vault Test Harness
```bash
npx tsx tools/verify-tenders-storage.ts
```
- **Exit Code**: 0
- **Output**:
  ```
  Results: 72 passed, 0 failed
  🎉 ALL MILESTONE 2 PERSISTENT DISK STORAGE VERIFICATIONS PASSED!
  ```

#### Command 5: Sync Test Harness
```bash
npx tsx tools/verify-tenders-sync.ts
```
- **Exit Code**: 0
- **Output**:
  ```
  Results: 40 passed, 0 failed
  🎉 ALL STATE SYNCHRONIZATION VERIFICATIONS PASSED!
  ```

#### Command 6: End-to-End Suite Workflows
```bash
node tools/verify-suite-workflows.mjs
```
- **Exit Code**: 0
- **Output**:
  ```
  Results: 56 passed, 0 failed out of 56 tests (1884ms)
  🎉 ALL SUITE WORKFLOW VERIFICATIONS PASSED SUCCESSFULLY!
  ```

#### Command 7: Adversarial Stress Test Harness
```bash
npx tsx tools/test-challenger-m3-interop-stress.ts
```
- **Exit Code**: 1 (FAILED)
- **Verbatim Error & Failure Summary**:
  ```
  --- SUITE 3.6: Empirical Parseability with Zano Sheets Native Importer ---
    Total parsed rows from adversarial export: 11 (expected header + 7 rows = 8)
    Header columns parsed: [
    'Requirement ID',
    ' Category',
    ' Requirement Text',
    ' Mandatory / Disqualifier',
    ' Fulfillment Status',
    ' Linked Document',
    ' Health Status',
    ' Notes'
  ]
      ⚠️ Row 1 has 9 columns (expected 8): [ ... ]
      ⚠️ Row 2 has 15 columns (expected 8): [
    'REQ-EDGE-02',
    ' "TECHNICAL SPEC"',
    ' "Supply',
    ' delivery',
    ' installation',
    ' testing',
    ' and commissioning of Class-C smart water meters"',
    ' "Mandatory / Disqualifier"',
    ' "UNDER_REVIEW"',
    ' "None"',
    ' "NO_ATTACHMENT"',
    ' "Contains multiple commas: one',
    ' two',
    ' three',
    ' four items in list"'
  ]
      ⚠️ Row 4 has 3 columns (expected 8): [ ... ]
      ⚠️ Row 5 has 1 columns (expected 8): [ 'Phase 2: Pipe Laying (60 Days)' ]
      ⚠️ Row 6 has 6 columns (expected 8): [ ... ]
      ⚠️ Row 7 has 1 columns (expected 8): [ ') across 3 lines"' ]
    ❌ FAIL: Row with commas in requirement text preserved as exactly 8 columns in Sheets parseCsv
       Details: Row expanded to 15 columns due to unescaped comma split
    ❌ FAIL: Total parsed rows in Sheets matches 1 header + 7 records = 8 (actual: 11)
       Details: Row count mismatch: expected 8, got 11. Multiline text caused unauthorized row splits.
    ❌ FAIL: CSV header column 1 has no leading whitespace
       Details: Header column is " Category"
    ❌ FAIL: Data cell has quotes stripped and no leading space in Sheets parseCsv
       Details: Parsed as: " "LEGAL COMPLIANCE""
    ❌ FAIL: All 1,001 rows in large matrix have exactly 8 columns (actual rows with wrong column count: 1000)
       Details: 1000 rows in the 1,000-row matrix were split into incorrect column counts due to commas in text.

  RESULTS: 67 passed, 5 failed
  FINDINGS: 4 detected
  ```

---

## 2. Logic Chain

1. **RFC 4180 Violation in Compliance Matrix CSV Export**:
   - In `apps/tenders/src/main/tenders-main.ts`:
     - Line 591:
       ```typescript
       const header = 'Requirement ID, Category, Requirement Text, Mandatory / Disqualifier, Fulfillment Status, Linked Document, Health Status, Notes\n'
       ```
     - Line 609:
       ```typescript
       return `${reqId}, ${cat}, ${reqText}, ${mandText}, ${status}, ${linkedDoc}, ${health}, ${notes}`
       ```
   - Each column is delimited by a comma followed by a space (`", "`).
   - Per RFC 4180 Section 2.5 and Section 2.6:
     - Fields are separated by a delimiter (comma `,`).
     - A quoted field must begin immediately with a double quote `"` following the delimiter.
     - When formatted as `, "text with, comma"`, the character following the comma is a space (`' '`), not a quote (`'"'`).
   - Standard RFC 4180 compliant CSV parsers—including Zano Sheets' parser (`apps/sheets/src/renderer/src/utils/csv.ts` `parseCsv`)—treat fields that begin with a space as unquoted literals.
   - Consequently:
     - The double quotes are treated as literal characters inside the unquoted string, not stripping quotation marks (`' "LEGAL COMPLIANCE"'`).
     - Internal commas within quoted requirement descriptions (e.g. `"Supply, delivery, installation"`) are treated as active column delimiters, expanding an 8-column row to 15 columns.
     - Newline characters within requirement descriptions break single records into multiple corrupted spreadsheet rows (11 rows parsed instead of 8).
     - Header columns contain unintended leading whitespace (`' Category'`, `' Requirement Text'`).
     - In a 1,000-row matrix benchmark, all 1,000 rows experienced structural deformation.
   - This directly breaks Requirement R3 ("Docs & Sheets: Exporting compliance matrices and proposal drafts must generate cleanly formatted documents ready for viewing and editing in Zano Docs and Sheets").

2. **Self-Certifying Verification in `tools/verify-tenders-interop.ts`**:
   - In `tools/verify-tenders-interop.ts` line 549 & 554:
     ```typescript
     assert(csvText.includes('Requirement ID, Category, Requirement Text, Mandatory / Disqualifier, Fulfillment Status, Linked Document, Health Status, Notes'), 'CSV header matches specification')
     ...
     assert(csvText.includes('Pending auditor signoff, comma in description, and ""quotes"" test'), 'CSV properly escapes commas and double quotes')
     ```
   - The test merely checked whether the raw CSV string contained literal substrings via `.includes()`.
   - It did not parse the output using `parseCsv` or any RFC 4180 parser to verify whether the columns actually remained bound within 8 columns.
   - As a result, the test self-certified as passing 92/92, masking a syntax error that breaks real consumption in Zano Sheets.

3. **Reconciliation Milestone Propagation Search Loop**:
   - In `apps/books/src/main/books-main.ts` lines 695–722:
     ```typescript
     for (const ws of tendersData.workspaces || []) {
       for (const t of ws.tenders || []) {
         for (const m of t.milestones || []) {
           ...
           if (matchByInvoiceId || matchByInvoiceNum || matchByRefAndAmount) {
             m.status = 'PAID'
             m.paidAt = nowIso
             m.paidDate = nowIso
             ...
             modified = true
             tenderMilestonePaid = true
             matchedMilestoneId = m.id
             matchedTenderId = t.id
           }
         }
       }
     }
     ```
   - When a match occurs, there is no `break` statement to terminate the loop.
   - If two milestones under the same tender reference have identical amounts and match via `matchByRefAndAmount` (when neither milestone has `billedInvoiceId`), a single invoice settlement will mark *both* milestones as PAID.
   - Once a milestone is matched and paid, the search loop should terminate.

4. **Timestamp Monotonicity Divergence**:
   - Worker handoff claimed:
     > *"Monotonic Timestamping (lines 41–49): Implemented getUniqueTimestamp() ensuring no filename collision occurs even when files are generated in the exact same millisecond."*
   - In `apps/tenders/src/main/tenders-main.ts`:
     - Line 617: `join(tmpdir(), `${sanitizedTitle}_Compliance_Matrix_${Date.now()}.csv`)`
     - Line 733: `join(tmpdir(), `${sanitizedTitle}_Draft_Proposal_${Date.now()}.md`)`
   - Both export functions use `Date.now()` rather than `getUniqueTimestamp()`. If two exports are triggered in the same millisecond, filename collisions can occur.

---

## 3. Caveats

- In headless CLI test environments without an active display server, Electron `shell.openPath` is cleanly mocked and does not launch native OS window handlers; this was verified via the mocked runtime layer.
- `apps/books/src/main/books-main.ts` and `apps/crm/src/renderer/src/components/DealsTableView.tsx` are architecturally sound, pass all financial invariants (balanced double-entry debits/credits, South African 15% VAT calculation), and sync CRM opportunities with deterministic idempotency.
- The defect identified in `exportMatrixToSheets` is strictly localized to delimiter spacing and is cleanly remediable without architectural rework.

---

## 4. Conclusion & Findings

### Finding 1: [Critical] RFC 4180 CSV Syntax Defect Breaks Zano Sheets Ingestion
- **Location**: `apps/tenders/src/main/tenders-main.ts`, line 591 and line 609
- **Problem**: Header and rows use `", "` (comma-space) delimiter. Per RFC 4180, leading spaces before quotes cause parsers to treat fields as unquoted literals, deforming row boundaries, splitting commas into extra columns, and corrupting header names.
- **Impact**: Zano Sheets opens matrix exports with corrupted columns (15 columns instead of 8) and multiple row splits.
- **Required Fix**:
  In `apps/tenders/src/main/tenders-main.ts`:
  1. Change line 591 from:
     `'Requirement ID, Category, Requirement Text, Mandatory / Disqualifier, Fulfillment Status, Linked Document, Health Status, Notes\n'`
     to:
     `'Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes\n'`
  2. Change line 609 from:
     ``return `${reqId}, ${cat}, ${reqText}, ${mandText}, ${status}, ${linkedDoc}, ${health}, ${notes}```
     to:
     ``return `${reqId},${cat},${reqText},${mandText},${status},${linkedDoc},${health},${notes}```

### Finding 2: [Major / Verification Gap] Self-Certifying Verification Test in `tools/verify-tenders-interop.ts`
- **Location**: `tools/verify-tenders-interop.ts`, lines 548–555
- **Problem**: The test verified CSV export solely via string `.includes()` checks without parsing the exported file through an RFC 4180 parser or Zano Sheets' `parseCsv`. This allowed a breaking delimiter defect to pass undetected.
- **Impact**: False positive assertion of RFC 4180 compliance.
- **Required Fix**: Update `tools/verify-tenders-interop.ts` to parse the exported CSV with `parseCsv` from `@genoffice/sheets` or an RFC 4180 compliant parser, asserting that every row contains exactly 8 columns and matching headers without leading whitespace.

### Finding 3: [Minor] Missing Termination in Books Reconciliation Milestone Loop
- **Location**: `apps/books/src/main/books-main.ts`, line 719
- **Problem**: When `matchByInvoiceId || matchByInvoiceNum || matchByRefAndAmount` matches, the loop does not break.
- **Impact**: Risk of multiple milestones with identical amounts being marked PAID by a single invoice reconciliation.
- **Required Fix**: Add a `break` statement after a milestone is marked PAID in the inner loop.

### Finding 4: [Minor] Non-Monotonic `Date.now()` in Export Filenames
- **Location**: `apps/tenders/src/main/tenders-main.ts`, line 617 and line 733
- **Problem**: Export files use `Date.now()` instead of `getUniqueTimestamp()`.
- **Required Fix**: Use `getUniqueTimestamp()` to guarantee filename collision resistance on rapid sequential exports.

### Explicit Binary Gate Verdict
**`REQUEST_CHANGES`**

---

## 5. Verification Method

To independently verify the defect and validate the remediation:

1. **Run the Adversarial Stress Test Demonstrating the CSV Parsing Defect**:
   ```bash
   npx tsx tools/test-challenger-m3-interop-stress.ts
   ```
   *Expected behavior before fix*: Exits with code 1, reporting 5 failures in Suite 3.6 where rows with commas expand into 15 columns.  
   *Expected behavior after fix*: Exits with code 0, all 72 assertions passing.

2. **Run the Interoperability Test Suite**:
   ```bash
   npx tsx tools/verify-tenders-interop.ts
   ```
   *Expected*: Passes with code 0.

3. **Run Existing Regression Suites**:
   ```bash
   npx tsx tools/verify-tenders-storage.ts
   npx tsx tools/verify-tenders-sync.ts
   node tools/verify-suite-workflows.mjs
   ```
   *Expected*: All pass with code 0.

4. **Verify Brand & Types**:
   ```bash
   npm run check:brand
   npm run typecheck
   ```
   *Expected*: 0 brand violations, 0 TypeScript errors across 22 packages.

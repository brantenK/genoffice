# Empirical Challenger Report: Milestone 1 — Books Store & Cross-Store Data Resilience

**Agent**: Challenger 2 (`challenger_2_m1`)  
**Role**: critic, specialist (Empirical Challenger)  
**Target**: Milestone 1 Deliverables by Worker 1 (`worker_m1`)  
**Verdict**: **APPROVE**  
**Timestamp**: 2026-09-03T13:45:00Z  
**Handoff Type**: Hard (Verification complete)  
**Report Location**: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\challenger_2_m1\handoff.md`  

---

## 1. Observation

### 1.1 Empirical Challenge Test Harness (`tools/test-challenger-m1-empirical.mjs`)
An independent, multi-dimensional test harness was written and executed directly against the compiled production modules (`apps/books/out/main/index.js`, `apps/crm/out/main/index.js`, `apps/tenders/out/main/index.js`):

```powershell
node tools/test-challenger-m1-empirical.mjs
```

**Output**:
```
======================================================================
   CHALLENGER 2: EMPIRICAL BOOKS & CROSS-STORE DATA RESILIENCE HARNESS
======================================================================

--- Section 1: Books Migration & Envelope Integrity ---
  [PASS] 1.1 Unversioned legacy object is upgraded to v1 envelope with valid updatedAt
  [PASS] 1.2 Empty object {} returns valid default v1 envelope with core accounts
  [PASS] 1.3 Non-object primitives (null, undefined, string, number, array) return safe defaults without throwing
  [PASS] 1.4 Existing v1 envelope preserves original version and updatedAt timestamp
  [PASS] 1.5 Future version envelope (version: 2) preserves version number >= 1
  [PASS] 1.6 Partial settings merges custom fields while retaining default configuration
  [PASS] 1.7 readBooksStore on non-existent file returns valid default v1 envelope without error

--- Section 2: Core Account Balances Preservation ---
  [PASS] 2.1 Custom non-default positive balances on all core accounts are strictly preserved
  [PASS] 2.2 Zero balances (0) on all core accounts are NEVER overwritten by truthy default checks
  [PASS] 2.3 Negative balances (overdraft / tax refund due) are preserved without truncation or reset
  [PASS] 2.4 Partial core accounts: existing retain custom balance, missing accounts are injected with defaults
  [PASS] 2.5 Custom non-core accounts (payroll, director loan, investments) survive along with core accounts

--- Section 3: Corrupted JSON Handling & Forensics ---
books-main: Corrupted books file detected. Backed up to C:\Users\brant\AppData\Local\Temp\challenger2-m1-631cf6d6\books\books-data.json.corrupted.bak
  [PASS] 3.1 Corrupted JSON with syntax error creates .corrupted.bak and returns safe fallback
books-main: Corrupted books file detected. Backed up to C:\Users\brant\AppData\Local\Temp\challenger2-m1-e9fb6b20\books\books-data.json.corrupted.bak
  [PASS] 3.2 Zero-byte empty file triggers .corrupted.bak and returns safe fallback
books-main: Corrupted books file detected. Backed up to C:\Users\brant\AppData\Local\Temp\challenger2-m1-a053c6bc\books\books-data.json.corrupted.bak
  [PASS] 3.3 Subsequent writeBooksStore repairs file without destroying .corrupted.bak

--- Section 4: Atomic Write Safety ---
  [PASS] 4.1 writeBooksStore creates non-existent parent directory recursively
  [PASS] 4.2 Atomic write mechanics: temporary file pattern verified and no leftover tmp files
  [PASS] 4.3 Rapid sequential writes (50 iterations) execute atomically without data corruption

--- Section 5: Custom / Unknown Attributes Round-Trip ---
  [PASS] 5.1 Books: Child entity custom attributes survive writeBooksStore -> readBooksStore
  [PASS] 5.2 CRM Deals: Custom / future attributes on deals survive writeDealsStore -> readDealsStore
  [PASS] 5.3 Tenders Store: Custom attributes on workspaces & issuerTemplates survive writeTendersStore -> readTendersStore

--- Section 6: Stress & Adversarial Edge Cases ---
    ℹ️ Large payload (1000 invoices, 505 accounts): Write=4ms, Read=4ms
  [PASS] 6.1 Large dataset persistence: 1000 invoices and 500 accounts perform cleanly
  [PASS] 6.2 Unicode & special characters in party names, notes, and company settings survive round-trip
  [PASS] 6.3 Boundary numbers: extreme large numbers, fractional cents, and scientific notation

--- Section 7: Cross-Store External Sync Merge Resilience ---
  [PASS] 7.1 CRM Deals: v0 naked array correctly migrates to v1 envelope on readDealsStore
  [PASS] 7.2 CRM Deals: Deal probability clamping (0-100) and negative amount protection
  [PASS] 7.3 Tenders Store: v0 unversioned tenders migrate cleanly to v1 envelope
tenders-main: Corrupted tenders file detected. Backed up to C:\Users\brant\AppData\Local\Temp\challenger2-m1-d010a828\tenders\tenders-data.json.corrupted.bak
  [PASS] 7.4 Tenders Store: Zero-byte / corrupted tenders file generates .corrupted.bak and safe defaults

--- Section 8: Malformed Data Structures & Error Recovery ---
  [PASS] 8.1 Duplicate account IDs in Books store are merged without duplicate entries
  [PASS] 8.2 Accounts with invalid or non-string IDs are safely ignored
  [PASS] 8.3 Malformed settings (non-object or null) gracefully fall back to DEFAULT_BOOK_SETTINGS

======================================================================
SUMMARY: 31 passed, 0 failed out of 31 tests
======================================================================
```

### 1.2 Verification of Critical Criteria
1. **`books-data.json` migration from unversioned object to v1 envelope**:
   - `migrateAndValidateBooks` (`apps/books/src/main/books-main.ts:38-88`) converts unversioned objects into `{ version: 1, updatedAt: string, settings, accounts, parties, invoices, journalEntries }`.
   - Missing attributes receive standard default structures.
   - Primitives and invalid values safely degrade to valid defaults without throwing exceptions.
2. **Balance Preservation on Core Accounts (`acc-bank`, `acc-ar`, `acc-ap`, `acc-sales`, `acc-vat`)**:
   - Lines 60-74 of `books-main.ts` construct a Map of existing accounts by ID:
     ```typescript
     const accountsMap = new Map<string, Account>()
     for (const acc of existingAccounts) {
       if (acc && typeof acc.id === 'string') {
         accountsMap.set(acc.id, acc)
       }
     }
     for (const core of CORE_ACCOUNTS) {
       if (!accountsMap.has(core.id)) {
         accountsMap.set(core.id, { ...core })
       }
     }
     ```
   - Tests 2.1 through 2.4 empirically confirm that:
     - Non-default custom positive balances (e.g. `9999999.99`, `111111.11`) are preserved.
     - Crucially, `balance: 0` is **NOT** overwritten (guarded against falsy `||` coercion bugs).
     - Negative balances (e.g. `-75000.50` overdraft) are preserved without truncation.
     - Missing core accounts are auto-injected without disturbing existing ones.
3. **Corrupted JSON Handling (`.corrupted.bak`)**:
   - Lines 123-140 of `books-main.ts` catch syntax errors on `JSON.parse(content)`.
   - File content is written verbatim to `${filePath}.corrupted.bak`.
   - Tested with invalid syntax (test 3.1) and 0-byte files (test 3.2).
   - Test 3.3 confirmed that subsequent successful `writeBooksStore` calls do **not** overwrite or erase the `.corrupted.bak` forensic copy.
4. **Atomic Write Safety**:
   - Lines 143-162 of `books-main.ts` write to `${filePath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp` in the same directory, followed by `renameSync`.
   - Test 4.1 confirmed recursive directory creation.
   - Test 4.2 confirmed temporary file cleanup (0 orphaned `.tmp` files found).
   - Test 4.3 proved 50 rapid sequential writes execute atomically without corruption or race condition artifacts.
5. **Custom / Unknown Attributes Survival**:
   - Test 5.1 confirmed that custom attributes on `Account` (`customBranch`, `glAccountCode`, `tags`), `Party` (`customVendorNumber`, `tenderEligible`), `Invoice` (`crmDealId`, `tenderReference`, `customMilestoneRef`, `specialPaymentTerms`), `JournalEntry` (`auditHash`, `approvedByUserId`), and `CompanySettings` (`customRegistrationNo`, `customBranchCode`) survive disk round-trips (`writeBooksStore` -> `readBooksStore`).
   - Tests 5.2 and 5.3 confirmed custom attributes survive in CRM deals and Tenders workspaces.

### 1.3 Monorepo Health Checks
- **Brand Check**:
  `npm run check:brand`
  *Result*: Code 0 (`✅ Brand check passed: Zero unauthorized upstream brand occurrences found.`)
- **Typecheck across all 22 Monorepo Packages**:
  `npm run typecheck`
  *Result*: Code 0 cleanly across all 22 packages (`@genoffice/i18n`, `@genoffice/electron-utils`, `@genoffice/font-metrics`, `@genoffice/docx-engine`, `@genoffice/pdf2docx`, `@genoffice/file-parse`, `@genoffice/pptx-engine`, `@genoffice/pptx-render`, `@genoffice/ai-search`, `@genoffice/agent-core`, `@genoffice/ai-provider`, `@genoffice/project-store`, `@genoffice/ui`, `@genoffice/docs`, `@genoffice/sheets`, `@genoffice/shell`, `@genoffice/slides`, `@genoffice/pdf`, `@genoffice/markdown`, `@genoffice/crm`, `@genoffice/tenders`, `@genoffice/books`).
- **Full Monorepo Build**:
  `npm run build:all`
  *Result*: Code 0 cleanly for all 9 applications.
- **Workflow Verification Script**:
  `node tools/verify-suite-workflows.mjs --milestone m1`
  *Result*: Code 0 (11 passed, 0 failed).

---

## 2. Logic Chain

1. **Envelope Architecture**:
   - `BooksDataEnvelope` matches the contract specified in `PROJECT.md` (`version: 1`, `updatedAt: string`, `settings`, `accounts`, `parties`, `invoices`, `journalEntries`).
   - Legacy unversioned objects pass through `migrateAndValidateBooks` and emerge as valid envelopes without dropping data.
2. **Account Balance Integrity**:
   - `accountsMap.has(core.id)` strictly checks key presence rather than truthiness of values. This guarantees that `balance: 0`, negative balances, or floating-point decimals are never clobbered with seed values (`485250`, `195500`, etc.).
3. **Forensic Recovery**:
   - Corrupted JSON triggers atomic creation of `.corrupted.bak` with verbatim contents while returning a operational default envelope, ensuring the application remains functional without losing the user's damaged file.
4. **Crash-Resilient I/O**:
   - Writing to a `.tmp` file in the same directory and calling `renameSync` ensures filesystem-level atomic replacement, avoiding EXDEV cross-volume issues and preventing zero-byte truncation if the process terminates mid-write.
5. **Schema Forward-Compatibility**:
   - Object spreading (`...core`, `...settings`, `...d`) preserves arbitrary custom properties on entities across disk reads and writes.

---

## 3. Caveats

- **Root-level unmodeled keys**: Top-level keys placed outside the envelope schema (e.g. `raw.unknownRootProp`) are dropped during envelope normalization in all 3 stores (`crm`, `tenders`, `books`), as envelopes explicitly construct `{ version, updatedAt, ... }`. However, all entity-level custom attributes (`accounts`, `parties`, `invoices`, `journalEntries`, `deals`, `workspaces`, `templates`) are fully preserved. This matches the specification in `PROJECT.md`.
- **No other caveats**: The store implementations have been empirically tested against edge-case numbers, malformed inputs, large volumes, and rapid I/O.

---

## 4. Conclusion

**Verdict: APPROVE**

Milestone 1 satisfies all functional, structural, and resilience requirements:
- `books-data.json` migrates safely from unversioned to v1 envelope.
- Core account balances on `acc-bank`, `acc-ar`, `acc-ap`, `acc-sales`, and `acc-vat` are strictly preserved (including zero and negative balances).
- Corrupted JSON triggers `.corrupted.bak` backup and safe fallback.
- Disk writes are atomic via tmp file and `renameSync`.
- Custom and unknown attributes survive round-trips cleanly across all stores.
- Exact test score: **31 passed, 0 failed out of 31 tests** in `tools/test-challenger-m1-empirical.mjs`.
- Brand check, full 22-package typecheck, and `build:all` compile cleanly with 0 errors.

---

## 5. Verification Method

To independently reproduce the empirical findings:

1. **Run Empirical Challenger Test Harness**:
   ```powershell
   node tools/test-challenger-m1-empirical.mjs
   ```
   *Expected Output*: `SUMMARY: 31 passed, 0 failed out of 31 tests` (Exit code: 0).

2. **Run E2E Suite Workflows Runner for Milestone 1**:
   ```powershell
   node tools/verify-suite-workflows.mjs --milestone m1
   ```
   *Expected Output*: `11 passed, 0 failed out of 11 tests` (Exit code: 0).

3. **Run Brand Check**:
   ```powershell
   npm run check:brand
   ```
   *Expected Output*: `✅ Brand check passed: Zero unauthorized upstream brand occurrences found.` (Exit code: 0).

4. **Run Typecheck**:
   ```powershell
   npm run typecheck
   ```
   *Expected Output*: Exit code: 0 across all 22 packages.

5. **Run Full Build**:
   ```powershell
   npm run build:all
   ```
   *Expected Output*: Exit code: 0.

### Invalidation Conditions
- If any core account with balance `0` or negative balance is reset to `CORE_ACCOUNTS` default balances.
- If reading a corrupted JSON file overwrites the damaged file before generating `.corrupted.bak`.
- If orphaned `.tmp` files accumulate in `userData` during normal writing.
- If custom fields on invoices or accounts disappear after a load-and-save cycle.

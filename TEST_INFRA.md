# Zanostack Suite Workflow Hardening: Test Infrastructure & Methodology

## 1. Test Philosophy & Principles

The Zanostack test infrastructure implements a **Dual-Track Quality Engineering** framework tailored for sovereign, local-first multi-application desktop software. The test suite operates on the following core principles:

### 1.1 Opaque-Box & Requirement-Driven Verification
Tests are constructed from the authoritative specifications defined in `ORIGINAL_REQUEST.md` and `PROJECT.md`. Tests observe system behavior through public interface contracts, file system data envelopes, and double-entry accounting state rather than internal implementation minutiae. This ensures tests remain stable across refactoring while strictly enforcing requirements.

### 1.2 Progressive Testability
During milestone execution, test verification must support progressive execution. As features advance through Milestones M1 (Resilient Data Sync), M2 (CRM Invoicing), M3 (Tenders Milestone Billing), and M4 (Bank Statement Reconciliation), the test suite allows targeted verification of individual tiers, milestones, or features (`--tier`, `--milestone`, `--feature`) as well as full suite execution.

### 1.3 Category-Partition Methodology
Every input space is formally partitioned into functional categories:
- **Deal Stages**: `lead`, `qualified`, `proposal`, `negotiation`, `won`, `lost`.
- **Milestone States**: `PENDING`, `REACHED`, `BILLED`.
- **Bank CSV Formats**: Single signed amount column, separate Debit/Credit columns, currency symbols (`R`, `$`), thousands separators.
- **Transaction Classifications**: Customer deposits (positive), vendor/overhead withdrawals (negative).
- **Match Confidence Tiers**: `HIGH` (exact amount + token match on invoice/tender reference/counterparty), `MEDIUM` (exact amount match only), `NONE` (unmatched).

### 1.4 Boundary Value Analysis (BVA)
Boundary testing explicitly probes domain limits:
- Zero valuations (`R 0.00`) and sub-cent precision floating-point numbers.
- VAT calculations ensuring `subtotal + taxTotal === grandTotal` across odd cent amounts.
- Extreme enterprise valuations (`R 100,000,000.00+`).
- Corrupted, truncated, or zero-byte JSON stores.
- Duplicate statement imports and idempotency checks.

### 1.5 Pairwise & Combinatorial Testing
Cross-feature interactions are tested combinatorially to verify that state mutations across Zanostack CRM, Zanostack Tenders, and Zano Books do not cause regressions or race conditions when operating concurrently.

### 1.6 Workload & Real-World Simulation
Workload tests model realistic commercial workflows: municipal infrastructure tenders (e.g. `RFP-WTR-2026-04`), multi-deal enterprise sales pipelines, batch invoice settlements, and year-end trial balance ledger audits.

---

## 2. Feature Inventory Mapping (F1 – F17)

| Feature ID | Feature Name | Requirement | Milestone | Primary Scope | Test Tier | Test Case IDs |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **F1** | CRM Deals Schema Versioning & Migration | R1 | M1 | `userData/crm/deals.json` v0->v1 migration, validation, corruption backup | Tier 1, Tier 2 | `T1.R1.1`, `T1.R1.2`, `T2.R1.1`, `T2.R1.4` |
| **F2** | Tenders Data Schema Versioning & Persistence | R1 | M1 | `userData/tenders/tenders-data.json` v1 envelope, workspaces/templates validation | Tier 1, Tier 2 | `T1.R1.3`, `T2.R1.2`, `T2.R1.5` |
| **F3** | Books Data Schema Versioning & Validation | R1 | M1 | `userData/books/books-data.json` v1 envelope, chart of accounts preservation | Tier 1, Tier 2 | `T1.R1.4`, `T2.R1.3`, `T2.R1.5` |
| **F4** | Safe External Sync Merge Logic | R1 | M1 | Cross-app writes merge entities by ID without dropping existing data or schema | Tier 1, Tier 3 | `T1.R1.5`, `T1.R1.6`, `T3.4` |
| **F5** | CRM Won Deals Detection & Eligibility | R2 | M2 | Only `stage === 'won'` deals eligible for 1-click invoicing; duplicate invoice guard | Tier 1, Tier 2 | `T1.R2.1`, `T2.R2.6` |
| **F6** | CRM to Books Invoice Creation Handler | R2 | M2 | Creates formatted Sales invoice (counterparty, valuation, 15% VAT, line items) | Tier 1, Tier 2 | `T1.R2.2`, `T2.R2.1`, `T2.R2.2`, `T2.R2.3` |
| **F7** | CRM Deal Back-Reference Update | R2 | M2 | Records `invoiceId`, `invoiceNumber`, `invoicedAt` onto CRM deal in `deals.json` | Tier 1 | `T1.R2.4` |
| **F8** | CRM UI Action & Shell Tab Switch | R2 | M2 | Shell tab activation callback trigger (`onOpenBooks`) upon invoice generation | Tier 1 | `T1.R2.6` |
| **F9** | Tenders Contract Milestone Data Model | R3 | M3 | `ContractMilestone` model on tender record, seed `RFP-WTR-2026-04` reached status | Tier 1 | `T1.R3.1` |
| **F10** | Tenders to Books Milestone Billing Handler | R3 | M3 | Creates Tax invoice in Books with tender ref, issuing authority, progress amount | Tier 1, Tier 2 | `T1.R3.2`, `T1.R3.3`, `T2.R3.2`, `T2.R3.5` |
| **F11** | Tenders Milestone Status Update | R3 | M3 | Updates milestone status to `BILLED`, records `billedInvoiceId` | Tier 1, Tier 2 | `T1.R3.5`, `T2.R3.4` |
| **F12** | Tenders UI Milestone Billing Action & Tab Switch | R3 | M3 | Shell tab activation callback trigger (`onOpenBooks`) upon milestone billing | Tier 1 | `T1.R3.6` |
| **F13** | Books Banking View & Tab Affordance | R4 | M4 | Dedicated Banking view & liquid cash account balance display for `acc-bank` | Tier 1 | `T1.R4.2` |
| **F14** | Bank Statement CSV Parser & Ingestion | R4 | M4 | Ingests standard CSV statements (Date, Desc, Ref, Amount/Debit/Credit) into `acc-bank` | Tier 1, Tier 2 | `T1.R4.1`, `T2.R4.3`, `T2.R4.4` |
| **F15** | Bank Ledger Balance Adjustment | R4 | M4 | Adjusts `acc-bank.balance` in Chart of Accounts by net transaction amount | Tier 1 | `T1.R4.3` |
| **F16** | Settlement Suggestion Matching Engine | R4 | M4 | Matches unreconciled transactions against open invoices/bills (HIGH / MEDIUM score) | Tier 1, Tier 2 | `T1.R4.4`, `T1.R4.5`, `T2.R4.1`, `T3.5` |
| **F17** | 1-Click Bank Reconciliation Action | R4 | M4 | Marks invoice Paid, sets transaction reconciled, updates party, posts journal | Tier 1, Tier 3 | `T1.R4.6`, `T3.1`, `T3.2`, `T3.3` |

---

## 3. Test Architecture & Runner Invocation

### 3.1 Runner Location & Execution
The end-to-end integration test suite is located at:
`tools/verify-suite-workflows.mjs`

It is executed using standard Node.js:
```bash
node tools/verify-suite-workflows.mjs
```

### 3.2 CLI Options & Filtering
The runner supports command-line flags for granular verification:
- `--tier <1|2|3|4|all>`: Run tests in a specific tier (default: `all`).
- `--milestone <m1|m2|m3|m4|all>`: Run tests mapped to a specific milestone.
- `--feature <r1|r2|r3|r4|all>`: Run tests for a specific requirement track.
- `--verbose`: Output step-by-step diagnostic information for each test assertion.
- `--json`: Output test results in structured JSON format for automated CI/CD parsing.
- `--help`: Display usage instructions.

### 3.3 Isolation & Sandboxing
Each execution creates an isolated sandbox directory in the operating system's temporary storage (`os.tmpdir()/zanostack-test-<uuid>`). Tests operate entirely within this sandbox, preventing any alteration or corruption of active development or production user data. The sandbox is automatically purged upon completion unless debug mode is requested.

### 3.4 Exit Code Semantics
- `0`: All executed test assertions passed successfully.
- `1`: One or more test assertions failed (summary and failure stack traces displayed).
- `2`: Invalid CLI invocation arguments or runtime initialization error.

---

## 4. Coverage Thresholds & Test Suite Inventory

### Tier 1: Feature Coverage (Minimum 5 tests per requirement)
Total: **24 Tests**
- **R1 Data Sync Architecture** (6 tests):
  - `T1.R1.1`: CRM deals schema v0 legacy array to v1 envelope migration.
  - `T1.R1.2`: CRM deal field validation, sanitization, and fallback defaults.
  - `T1.R1.3`: Tenders data envelope validation and structure verification.
  - `T1.R1.4`: Books data envelope preservation and Chart of Accounts integrity.
  - `T1.R1.5`: Atomic persistence verification (`.tmp` + rename).
  - `T1.R1.6`: Safe external merge without dropping existing records or corrupting v1 envelope.
- **R2 CRM Invoicing Automation** (6 tests):
  - `T1.R2.1`: Won deal eligibility check (`stage === 'won'`).
  - `T1.R2.2`: Books Sales invoice creation with accurate party, valuation, 15% VAT, and Net 30 terms.
  - `T1.R2.3`: `crmDealId` back-link on Books sales invoice.
  - `T1.R2.4`: CRM deal back-reference update (`invoiceId`, `invoiceNumber`, `invoicedAt`).
  - `T1.R2.5`: Double-entry accounting ledger update (`acc-ar`, `acc-sales`, `acc-vat`, and Journal Entry).
  - `T1.R2.6`: Books tab activation trigger notification.
- **R3 Tenders Milestone Billing** (6 tests):
  - `T1.R3.1`: Milestone reached status eligibility (`status === 'REACHED'`).
  - `T1.R3.2`: Tax invoice creation linked to `RFP-WTR-2026-04` with progress amount.
  - `T1.R3.3`: Issuing authority party mapping & balance adjustment (`City of Ekurhuleni Water Dept`).
  - `T1.R3.4`: Milestone progress amount line item & VAT calculation (15% VAT).
  - `T1.R3.5`: Milestone status updated to `BILLED` and `billedInvoiceId` recorded.
  - `T1.R3.6`: Books tab activation trigger notification.
- **R4 Bank Statement Reconciliation** (6 tests):
  - `T1.R4.1`: Standard bank CSV statement parsing.
  - `T1.R4.2`: Bank transaction ingestion into `acc-bank`.
  - `T1.R4.3`: Bank ledger balance adjustment (`acc-bank.balance` updated by net amount).
  - `T1.R4.4`: Settlement suggestion matching for deposits against open Sales invoices.
  - `T1.R4.5`: Settlement suggestion matching for withdrawals against open Purchase bills.
  - `T1.R4.6`: 1-click reconciliation action execution (marks invoice Paid, sets transaction reconciled, updates party, posts journal).

### Tier 2: Boundary & Corner Cases (Minimum 5 tests per requirement)
Total: **22 Tests**
- **R1 Boundary Tests** (5 tests):
  - `T2.R1.1`: Corrupted JSON in `deals.json` preserves `.corrupted.bak` and avoids data wiping.
  - `T2.R1.2`: Corrupted JSON in `tenders-data.json` preserves `.corrupted.bak`.
  - `T2.R1.3`: Corrupted JSON in `books-data.json` preserves `.corrupted.bak`.
  - `T2.R1.4`: Empty / zero-byte data files initialization with safe defaults.
  - `T2.R1.5`: Schema evolution preservation (unknown/future properties preserved across round-trips).
- **R2 Boundary Tests** (6 tests):
  - `T2.R2.1`: Zero valuation deal handling (`amount: 0`) without division by zero.
  - `T2.R2.2`: Fractional cents valuation handling (e.g. `R 115,000.55`: subtotal + taxTotal == grandTotal).
  - `T2.R2.3`: Extreme valuation handling (`R 100,000,000.00`).
  - `T2.R2.4`: Missing counterparty auto-creation in Books `parties`.
  - `T2.R2.5`: Deal with missing companyName falls back gracefully to deal name.
  - `T2.R2.6`: Re-invoicing protection (prevents duplicate invoice creation for already invoiced deal).
- **R3 Boundary Tests** (5 tests):
  - `T2.R3.1`: Milestone with zero progress amount handling.
  - `T2.R3.2`: Milestone with special characters and punctuation in RFP title / issuing authority.
  - `T2.R3.3`: Attempt to bill non-existent tender or milestone ID.
  - `T2.R3.4`: Re-billing protection (rejects billing already `BILLED` milestone).
  - `T2.R3.5`: Auto-creation of issuing authority party if absent in Books.
- **R4 Boundary Tests** (6 tests):
  - `T2.R4.1`: Unmatched bank transactions remain unreconciled with zero false positive matches.
  - `T2.R4.2`: Duplicate CSV import detection (prevents duplicate transaction ingestion).
  - `T2.R4.3`: Malformed CSV rows (empty rows, trailing commas, missing amount skipped cleanly).
  - `T2.R4.4`: Currency formatting variations (`R`, commas, negative in parentheses).
  - `T2.R4.5`: Re-reconciling already reconciled transaction or paid invoice rejected.
  - `T2.R4.6`: Disambiguation between identical amounts based on text token confidence.

### Tier 3: Cross-Feature Combinations (Pairwise Workflows)
Total: **5 Tests**
- `T3.1`: CRM Deal Won -> Sales Invoice Created -> Bank CSV Import with Exact Reference -> 1-Click Reconcile -> Invoice Paid & Bank Ledger Reconciled.
- `T3.2`: Tenders Milestone Billed -> Tax Invoice Created with `RFP-WTR-2026-04` -> Bank CSV Import Referencing Tender -> 1-Click Reconcile.
- `T3.3`: Multi-Entity Commercial Batch (CRM Won Deal + Tenders Milestone + Supplier Purchase Bill + Bank CSV containing all 3 settlements in one statement).
- `T3.4`: Post-Invoicing Tenders-to-CRM External Sync (subsequent external sync leaves invoice back-references and schema envelope intact).
- `T3.5`: Dual Settlement Disambiguation (two invoices with identical amounts; verifies description/reference text matching promotes one to HIGH confidence).

### Tier 4: Real-World Application Scenarios
Total: **5 Scenarios**
- `T4.1`: Municipal Water Infrastructure Contract (`RFP-WTR-2026-04`) & Private Sector CRM Opportunity (`Helios Clean Energy`) Complete Lifecycle.
- `T4.2`: High-Volume Monthly Commercial Settlement (5 concurrent CRM deals across sectors, batch invoicing, statement import with customer deposits and overheads).
- `T4.3`: Multi-Stage Tender Delivery & Progress Payments (Phase 1 billed & paid -> Phase 2 reached & billed -> Books general ledger continuity verified).
- `T4.4`: Concurrent Cross-App Mutation Stress (simultaneous CRM deal updates, Tenders milestone billing, and bank statement import).
- `T4.5`: Financial Year-End Trial Balance Integrity (verifies `Assets === Liabilities + Equity + (Income - Expense)` across all accounts after multiple transactions, invoices, and reconciliations).

---

## 5. Verification Commands

Run the full E2E test suite:
```bash
node tools/verify-suite-workflows.mjs
```

Run specific test tiers:
```bash
node tools/verify-suite-workflows.mjs --tier 1
node tools/verify-suite-workflows.mjs --tier 2
node tools/verify-suite-workflows.mjs --tier 3
node tools/verify-suite-workflows.mjs --tier 4
```

Run specific requirement tracks:
```bash
node tools/verify-suite-workflows.mjs --feature r1
node tools/verify-suite-workflows.mjs --feature r2
node tools/verify-suite-workflows.mjs --feature r3
node tools/verify-suite-workflows.mjs --feature r4
```

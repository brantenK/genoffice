## 2026-09-03T13:14:38Z
You are the E2E Test Writer (test_writer_e2e).
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\test_writer_e2e

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md

You MUST read the project blueprint at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\PROJECT.md

Your mission:
Design and build the comprehensive E2E Testing Track for the Zanostack Suite workflows:
1. Author `TEST_INFRA.md` at project root:
   `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\TEST_INFRA.md`
   Follow the Dual Track testing methodology:
   - Test philosophy (opaque-box, requirement-driven, progressive testability, Category-Partition, BVA, Pairwise, Workload Testing)
   - Feature inventory mapping F1 through F17
   - Test architecture and runner invocation
   - Coverage thresholds: Tier 1 (>=5 per feature), Tier 2 (>=5 per feature), Tier 3 (pairwise combinations), Tier 4 (realistic scenarios)
2. Author the automated end-to-end integration test runner:
   `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\tools\verify-suite-workflows.mjs`
   - Must be directly executable via `node tools/verify-suite-workflows.mjs`
   - Must exit with code 0 on pass, non-zero on failure, with clear summary and failure details
   - Test cases:
     - **Tier 1: Feature Coverage (>=5 tests per feature)**:
       - R1 Data Sync: CRM deals schema v0->v1 migration, Tenders data envelope validation, Books data envelope preservation, atomic write verification, safe external merge (tenders syncing into crm deals without dropping records).
       - R2 CRM Invoicing: Won deal eligibility, sales invoice creation with party/valuation/lines/payment terms, crmDealId linking, deal back-reference invoiceNumber/invoiceId, Books tab activation trigger.
       - R3 Tenders Milestone Billing: Tender milestone reached status, tax invoice creation linked to RFP-WTR-2026-04, issuing authority party, progress amount line item, milestone status updated to BILLED, Books tab activation trigger.
       - R4 Bank Statement Reconciliation: CSV parsing (standard bank format), ingestion into acc-bank, bank ledger balance adjustment (net amount), settlement suggestion matching for open sales invoices (deposits) and purchase bills (withdrawals), 1-click reconciliation (marks invoice Paid, sets transaction reconciled, updates party balance, records journal entry).
     - **Tier 2: Boundary & Corner Cases (>=5 tests per feature)**:
       - Corrupted JSON handling (preserves .corrupted.bak, does not wipe data)
       - Empty data stores handling
       - Zero amount, fractional cents, extreme valuation handling
       - Missing party auto-creation
       - Unmatched bank transactions, duplicate CSV import detection
     - **Tier 3: Cross-Feature Combinations (Pairwise)**:
       - End-to-end flow: CRM deal won -> Sales invoice created -> Bank CSV imported matching exact invoice -> 1-click reconcile -> Invoice marked Paid and bank reconciled.
       - End-to-end flow: Tenders milestone billed -> Tax invoice created with RFP-WTR-2026-04 -> Bank CSV imported with payment referencing RFP-WTR-2026-04 -> 1-click reconcile.
     - **Tier 4: Real-World Application Scenarios (>=5 realistic scenarios)**:
       - Complete commercial cycle with multiple concurrent deals, tenders, invoices, and bank statement settlements.
3. Author `TEST_READY.md` at project root (`c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\TEST_READY.md`) summarizing the test suite, test counts per tier, feature checklist, and run command.

File ownership:
You own:
- `TEST_INFRA.md`
- `TEST_READY.md`
- `tools/verify-suite-workflows.mjs`

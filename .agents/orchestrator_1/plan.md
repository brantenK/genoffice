# Plan: Zanostack Suite Workflow Expansion & Hardening

## Overview
Implement resilient update/sync architecture (R1), CRM-to-Books invoicing (R2), Tenders milestone billing (R3), and Books bank statement CSV reconciliation (R4), verified by automated E2E script `tools/verify-suite-workflows.mjs`, brand check, typecheck (22 packages), and build.

## Milestones
- **M0: Survey & Project Blueprint**
  - Explorer 1: CRM codebase, deals.json schema, UI actions, IPC/store
  - Explorer 2: Tenders codebase, tenders-data.json, milestone billing UI, RFP references
  - Explorer 3: Books codebase, books-data.json, invoices, bank accounts, CSV parsing, tab navigation
  - Synthesize PROJECT.md with Feature Inventory, Interface Contracts, and Code Layout
- **M1: E2E Testing Track Setup (Parallel)**
  - Spawn E2E Testing Track Orchestrator to design and build `tools/verify-suite-workflows.mjs` test suite covering Tiers 1-4 across all 4 requirements
- **M2: Resilient Update & External Sync Architecture (R1)**
  - Schema versioning, validation, and safe data migration for deals.json, tenders-data.json, books-data.json
  - Safe external sync merge without data loss or corruption
- **M3: CRM to Zano Books Invoicing Automation (R2)**
  - 1-click invoice creation from won CRM deals with counterparty, valuation, line item, payment terms
  - Back-reference onto CRM deal
  - UI modal/table action and activating Books tab
- **M4: Tenders Contract Milestone Billing in Zano Books (R3)**
  - "Bill Milestone in Zano Books" in Tenders compliance workspace
  - Attach RFP reference and issuer to billable invoice in Books
- **M5: Bank Statement Import & Reconciliation in Zano Books (R4)**
  - Banking view CSV importer into acc-bank
  - Matching settlement suggestions for open invoices/bills
  - 1-click reconciliation adjusting bank ledger balances
- **M6: Full Acceptance, E2E Verification & Adversarial Hardening (Final Milestone)**
  - Phase 1: 100% pass of `tools/verify-suite-workflows.mjs` (Tiers 1-4)
  - Phase 2: Adversarial coverage hardening (Tier 5)
  - Full repo verification: `npm run check:brand`, `npm run typecheck`, `npm run build:all`
  - Forensic Audit: clean bill of health

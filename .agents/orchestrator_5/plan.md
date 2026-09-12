# Project Plan: Zano Books Backend Audit and Hardening (`apps/books`)

## Mission
Comprehensive audit and hardening of the Zano Books backend (`apps/books`), establishing strict double-entry ledger balancing for all invoice types, full Chart of Accounts harmonization, precise bank reconciliation with partial/exact payment handling, live IPC synchronization (`books:data-changed`), and an automated test suite.

## Phase 0: Survey & Architectural Mapping
- Spawn 3 Explorers in parallel:
  1. `explorer_books_ledger`: Double-entry invariants, sales invoices, purchase bills, payment settlements, party balance tracking, currency precision.
  2. `explorer_books_coa_store`: Chart of accounts harmonization (`books-main.ts` vs `initialBooksData.ts`, 22 accounts, 5 categories), atomic persistence, JSON corruption backup/recovery, real-time IPC synchronization (`books:data-changed`).
  3. `explorer_books_reconciliation`: Bank statement import (SA banks: FNB, Standard Bank, Nedbank, Absa), parenthetical/varying headers, transaction deduplication, reconciliation math (`executeReconciliation` partial/exact), tender milestone back-propagation, and existing/needed Vitest setup.

## Phase 1: Milestone Decomposition & Interface Contracts
- Consolidate explorer findings into `SCOPE.md`.
- Finalize milestones M1–M5:
  - M1: Strict Double-Entry Bookkeeping & Balanced Journal Posting (R1)
  - M2: Chart of Accounts Harmonization & Schema Invariants (R2)
  - M3: Robust Bank Statement Import & Reconciliation Engine (R3)
  - M4: Real-Time IPC Synchronization & Cross-App Event Pipeline (R4)
  - M5: Dedicated Automated Test Suite & Verification (R5)

## Phase 2: Iterative Execution & Quality Gates
Each milestone follows the iteration loop:
- Worker implements required changes & runs verification
- 2 Reviewers independently verify correctness, completeness, and interface contracts
- 2 Challengers adversarially stress-test edge cases and invariants
- 1 Forensic Auditor verifies zero cheating, no dummy mocks, and genuine double-entry logic
- Gate evaluation: 100% APPROVE / CLEAN required to proceed.

## Phase 3: Final Acceptance & Adversarial Hardening
- 100% passing automated Vitest suite in `apps/books`
- Zero TypeScript errors across monorepo (`npm run typecheck`)
- Final victory audit certification and handoff report to parent/sentinel.

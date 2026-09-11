# Project Plan: Zanostack Tenders Overhaul and Hardening

## Overview
Overhaul and harden Zanostack Tenders (`apps/tenders`) and its Electron backend (`tenders-main.ts`), fulfilling R1, R2, R3, and R4 with complete end-to-end verification, typechecking, and adversarial testing.

## Phase 0: Survey & Architectural Mapping
- Spawn 3 Explorers in parallel:
  1. `explorer_tenders_core`: Investigate `apps/tenders` store (Zustand), components, RFP shredder heuristics, compliance matrix, and current state of R1/R2.
  2. `explorer_tenders_backend`: Investigate `apps/tenders/src/main/tenders-main.ts`, IPC channels, persistence (`userData/tenders/tenders-data.json`), disk storage for vault/PDFs, and shell integration (`apps/shell`).
  3. `explorer_tenders_interop`: Investigate cross-app workflows (Books milestone billing double-entry & invoices, CRM deal sync, Docs proposal draft export, Sheets matrix export) and current test suites.

## Phase 1: Milestone Decomposition & Interface Contracts
- Consolidate survey findings into `PROJECT.md` update or dedicated `SCOPE.md`.
- Finalize milestones M1–M4.

## Phase 2: Execution via Iteration Loops
- M1: Unified Main-Renderer State Synchronization (R1)
- M2: Persistent Disk Storage for RFP Documents & Vault Returnables (R2)
- M3: Cross-App Interoperability & Export Workflows (R3)
- M4: Automated Testing & Verification Suite (R4)

## Phase 3: Final Acceptance & Adversarial Hardening
- Complete test suite run (100% pass)
- `npm run typecheck` across all monorepo packages (0 errors)
- Forensic audit certification.

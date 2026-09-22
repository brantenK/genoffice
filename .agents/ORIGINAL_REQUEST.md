# Original User Request

## 2026-09-03T13:00:56Z

Harden and expand the workflows of Zanostack CRM, Zanostack Tenders, and Zano Books by implementing resilient update & synchronization handling for external requests, a 1-click CRM-to-Books invoicing bridge, Tenders milestone billing into Books, and bank statement CSV reconciliation in Zano Books.

Working directory: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice
Integrity mode: development

## Requirements

### R1. Resilient Update & External Sync Architecture
Implement schema versioning, validation, and safe data migration for all 3 applications (userData/crm/deals.json, userData/tenders/tenders-data.json, and userData/books/books-data.json) so that application updates and external sync requests merge cleanly without data loss or corruption.

### R2. CRM to Zano Books Invoicing Automation
Add a direct 1-click "Create Invoice in Zano Books" workflow in Zanostack CRM for won opportunities. When triggered, it creates a formatted Sales Invoice in Zano Books with the customer counterparty, deal valuation, line-item description, and payment terms, while recording the invoice reference back onto the CRM deal.

### R3. Tenders Contract Milestone Billing in Zano Books
Add a "Bill Milestone in Zano Books" action in Zanostack Tenders. When a tender contract or project milestone is reached, it generates a tax invoice in Books linked to the tender's reference number (RFP-WTR-2026-04), issuing authority, and milestone progress amount.

### R4. Bank Statement Import & Reconciliation in Zano Books
Add a bank statement import workflow in Zano Books that accepts standard bank transaction CSV files, imports transactions into the designated Bank Account (acc-bank), and automatically suggests matching settlements for open customer invoices and supplier bills.

## Acceptance Criteria

### Interoperability & Functional Workflows
- [ ] CRM Deals table and modal include a "Create Invoice in Zano Books" action that generates a matching sales invoice in Books and activates the Books tab.
- [ ] Tenders compliance workspace includes a "Bill Milestone in Books" action that attaches the tender RFP reference and issuer to a billable invoice in Books.
- [ ] Zano Books includes a "Import Bank Statement" tool in the Banking view that parses transaction CSVs, adjusts bank ledger balances, and can reconcile unpaid invoices with 1 click.
- [ ] Data stores (crm, tenders, books) handle schema evolution and external data updates safely without dropping existing user entries.

### Objective Verification
- [ ] An automated end-to-end integration script (tools/verify-suite-workflows.mjs) executes programmatic end-to-end tests for CRM -> Books, Tenders -> Books, and bank statement parsing, exiting with code 0.
- [ ] npm run check:brand passes with 0 unauthorized upstream brand occurrences.
- [ ] npm run typecheck passes cleanly across all 22 monorepo packages.
- [ ] npm run build:all compiles all packages without error.

## Follow-up — 2026-09-03T17:23:26Z

The server restarted and quota has reset. Please resume monitoring and orchestrating the Zanostack workflow implementation. Check the state of .agents and continue from where work left off.

## 2026-09-04T18:31:53Z

Overhaul and harden Zanostack Tenders (`apps/tenders`) and its Electron backend (`tenders-main.ts`), establishing unified persistence between the renderer store and Electron main process, persistent vault/PDF disk storage, robust cross-app workflows with Books, CRM, Docs, and Sheets, and an automated test suite.

Working directory: c:/Users/brant/OneDrive/Documents/GenOffice/genoffice
Integrity mode: development

## Requirements

### R1. Unified Main-Renderer State Synchronization
Synchronize application state between the React renderer store (Zustand) and the Electron main process storage (`userData/tenders/tenders-data.json`). Data persisted via IPC or modified by cross-app operations (such as milestone billing from Books) must be immediately reflected in the user interface, eliminating stale state and desynchronization between disk and renderer memory.

### R2. Persistent Disk Storage for RFP Documents & Vault Returnables
Provide persistent file storage for uploaded tender PDFs and compliance vault documents within the application data directory. Stored documents must remain accessible across application restarts, replacing transient session-only blob URLs with durable local file paths or managed IPC retrieval.

### R3. Cross-App Interoperability & Export Workflows
Harden and elevate cross-app workflows with other GenOffice desktop applications:
- **Zano Books:** Milestone billing must create valid double-entry ledger entries and tax invoices, update tender milestones to billed, and propagate payment state updates back to tender milestones.
- **Zano CRM:** Tender opportunities must seamlessly sync into CRM deals with accurate stage, issuer, submission deadline, and estimated value.
- **Docs & Sheets:** Exporting compliance matrices and proposal drafts must generate cleanly formatted documents ready for viewing and editing in Zano Docs and Sheets.

### R4. Automated Testing and Verification Suite
Add automated unit and integration tests covering the deterministic RFP shredder heuristics, compliance gap analysis, store serialization/migrations, and Electron IPC handlers. The entire test suite and TypeScript typechecking must pass cleanly with zero regressions.

## Acceptance Criteria

### Persistence & Data Integrity
- [ ] Tenders data saved in renderer is persisted to `tenders-data.json` and loads identically on app restart.
- [ ] Milestone billing executed in the backend updates both the on-disk store and the active renderer store without requiring a reload.
- [ ] Uploaded tender PDFs and vault files are stored on disk in the user data directory and re-open successfully after restarting the app.

### Cross-App Functionality
- [ ] Billed milestones produce balanced journal entries, accounts receivable adjustments, and linked tax invoices in Zano Books.
- [ ] Tenders exported to CRM appear with expected metadata (reference, issuer, value, closing date) in CRM deals.
- [ ] Export matrix to Sheets and Draft proposal in Docs generate valid files without error and trigger corresponding shell tab navigation.

### Code Quality & Testing
- [ ] `npm run typecheck` passes with zero TypeScript errors across `apps/tenders` and dependent apps.
- [ ] A dedicated test suite for `apps/tenders` runs via automated test command (e.g. `npm test` / Vitest) and passes 100% of tests.
- [ ] No regression in existing tab navigation or shell startup behavior.

## 2026-09-05T06:42:35Z

Comprehensive audit and hardening of the Zano Books backend (`apps/books`), establishing strict double-entry ledger balancing for all invoice types, full Chart of Accounts harmonization, precise bank reconciliation with partial/exact payment handling, live IPC synchronization (`books:data-changed`), and an automated test suite.

Working directory: c:/Users/brant/OneDrive/Documents/GenOffice/genoffice
Integrity mode: development

## Requirements

### R1. Strict Double-Entry Bookkeeping & Balanced Journal Posting
Ensure every accounting transaction produces mathematically balanced journal entries where Total Debits equal Total Credits:
- **Sales Invoices:** Post balanced entries (Debit Accounts Receivable, Credit Sales Revenue, Credit VAT Output Payable).
- **Purchase Bills:** Post balanced entries (Debit Expense/Materials, Debit VAT Input if applicable, Credit Accounts Payable).
- **Invoice Payments & Reversals:** Settle balances accurately, adjusting party balances and posting corresponding ledger journal entries.
- **Precision:** Eliminate floating-point calculation drift by strictly rounding currency amounts to 2 decimal places.

### R2. Chart of Accounts Harmonization & Schema Invariants
Harmonize the Chart of Accounts between the Electron main process (`books-main.ts`) and the initial seed data (`initialBooksData.ts`):
- Ensure clean initializations and migrations preserve the full standard Chart of Accounts structure (Assets, Liabilities, Equity, Income, Expenses, Retained Earnings, Share Capital).
- Maintain parent-child group relationships so financial summaries and reports calculate correctly without missing accounts.

### R3. Robust Bank Statement Import & Reconciliation Engine
Harden the bank reconciliation engine and CSV statement import:
- Accurately parse debit/credit columns, parenthetical negatives, and varying bank statement headers.
- Eliminate transaction deduplication collisions while correctly updating bank account ledger balances.
- In `executeReconciliation`, bind settlements to actual transaction amounts rather than blindly assuming full payment, supporting exact matching and partial settlement without corrupting ledger accounts.
- Preserve tender milestone payment back-propagation (`status: 'PAID'`) when settling tender-linked tax invoices.

### R4. Real-Time IPC Synchronization (`books:data-changed`)
Implement a `books:data-changed` broadcast event pipeline from the Electron main process to active Books WebContents views:
- When cross-app actions (such as milestone billing from Zanostack Tenders) write to `books-data.json`, the active Books tab must update immediately without requiring the user to reload the tab.
- Include loop-suppression guards to prevent echo-loops between store persistence and IPC change events.

### R5. Dedicated Automated Test Suite
Establish a comprehensive Vitest automated testing suite for `apps/books`:
- Test double-entry balance invariants (Debit == Credit).
- Test Sales and Purchase invoice posting and ledger account updates.
- Test CSV statement parsing and reconciliation settlement math.
- Test store persistence, schema migrations, and IPC handlers.
- Ensure 100% tests pass and `npm run typecheck` passes with zero errors across the monorepo.

## Acceptance Criteria

### Bookkeeping & Ledger Invariants
- [ ] Every posted Journal Entry has `totalDebit === totalCredit` (strictly balanced to 2 decimal places).
- [ ] Purchase Bills generate balanced journal entries and correctly update Accounts Payable and Direct Expense accounts.
- [ ] Party outstanding balances accurately reflect invoice totals minus settled amounts.

### Chart of Accounts & Persistence
- [ ] Full Chart of Accounts (all 22 standard accounts across 5 root categories) is preserved on fresh initialization and store migrations.
- [ ] Saving data persists atomically via temporary files and renames, with automatic backup upon encountering invalid JSON.

### Bank Reconciliation & Cross-App Sync
- [ ] Bank statement CSV parser correctly handles standard South African bank statement formats (FNB, Standard Bank, Nedbank, Absa).
- [ ] Bank reconciliation creates balanced settlement journals and correctly updates Bank and AR/AP balances based on transaction amount.
- [ ] Milestone billing executed in Tenders immediately broadcasts `books:data-changed` and renders in the open Books tab without a reload.

### Code Quality & Testing
- [ ] `npm run typecheck` passes with zero TypeScript errors across `apps/books` and the monorepo.
- [ ] A dedicated test suite for `apps/books` runs via automated test command (e.g. `npm test` / Vitest) with 100% passing tests.
- [ ] Zero regressions in Books UI navigation or report generation.

## Follow-up — 2026-09-05T10:52:57Z

Server restart interrupted execution. Resume from where stopped.
Current state:
- Milestone 1 (Accounting Engine & CoA Harmonization): COMPLETE — all M1 files committed and on disk.
- Milestone 2 (Strict Double-Entry Journal Posting): Implementation COMPLETE by worker_books_m2_ledger — all M2 files modified on disk (store.ts, InvoiceForm.tsx, accounting.ts).
Action: Re-evaluate Milestone 2 gate with fresh 5-agent panel, then proceed with Milestones 3, 4, 5 and final certification.

## Follow-up — 2026-09-05T16:33:01Z

Server restart occurred and quota window has expired.
Action: Revive orchestrator_5 and complete Milestone 5 Gate Evaluation and final monorepo certification.

## 2026-09-15T04:52:08Z

Execute Phase 2 (Durability) remaining work for the Tenders 9/10 hardening project in `apps/tenders`, cutting renderer persistence over from localStorage to the authoritative v2 store via typed IPC, verifying with live smoke tests, and passing the Phase 2 Oracle gate.

Working directory: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice
Integrity mode: development

## Context & References
- Handoff index: docs/tenders-hardening/README.md
- Invariants and schema specifications: docs/tenders-hardening/contracts-and-invariants.md
- Detailed roadmap & tasks: docs/tenders-hardening/phase-2-remaining.md
- Deepwork log: .slim/deepwork/tenders-9of10.md
- Gate policy: Lighter gate (one reviewer per increment, Oracle gate only at phase end, batch findings).
- Deferred items (do NOT implement now): Rotating backups + recovery UI, managed-file lifecycle (trash/undo/orphan reconciliation), main-owned readiness snapshot binding.

## Requirements

### R1. Live Regression Smoke (Task 2A)
Verify that the built Electron app and all 14 hardened privileged IPC handlers function without authorization or origin-matching failures (`INVALID_REQUEST` / `Unauthorized`).
- Use an isolated scratch `userData` under `%LOCALAPPDATA%\Temp\opencode\`. Never touch real user profiles or terminate unrelated processes (PID 21200).
- Validate through real UI: requirement status change, upload + save vault document, export compliance matrix, generate Draft Docs, CRM sync (if available).
- Verify persistence across scratch restart.

### R2. Renderer v2 Persistence Cutover (Task 2B)
Cut renderer persistence over from localStorage to the authoritative v2 store:
- **Hydration**: In `apps/tenders/src/renderer/src/store.ts` and `components/App.tsx`, hydrate via `loadStoreV2()`.
  - `not-found`: Clean empty workspace (no demo seeding).
  - `migrated`: Render migrated data and commit once via `saveStoreV2({ expectedRevision: 0, document })`.
  - `loaded`: Set active state directly from committed snapshot.
  - Failure (`READ_FAILED` / `UNSUPPORTED_SCHEMA_VERSION`): Show explicit error/recovery state; never silently overwrite or synthesize empty.
- **Persistence**: Persist mutations via `saveStoreV2({ expectedRevision, document })`; update local store only from the returned committed snapshot.
- **Save State UI**: Implement a dedicated theme-compliant save status indicator (`components/SaveStatus.tsx` and workspace chrome) displaying Loading, Saving, Saved, Save Failed (with Retry), and Conflict.
- **Multi-window Sync**: Listen to `onStoreChangedV2` to update state if another window mutates data.
- **No Domain localStorage**: Workspaces, tenders, customers, and vault records must not be stored in `localStorage`. Retain only UI preferences (active page, zoom, pane dimensions) under a designated UI-only key.
- **Retire Legacy IPC**: Cease renderer use of `getStoredData` and `saveStoredData`.

### R3. Quality Gates & Oracle Review (Task 2C)
- Maintain TDD practices.
- Ensure all repository guards pass: full Tenders test suite (588+ passing), typecheck, Tenders and Shell builds, theme-color checks, and code formatting.
- Execute isolated built-Electron E2E verification for hydration, mutation, restart, retry on failure, and conflict detection.
- Complete the Phase 2 Oracle gate with explicit PASS evidence against revised exit criteria.

## Acceptance Criteria

### Persistence & Cutover
- [ ] Renderer hydrates correctly from `loadStoreV2` across all four states (`not-found`, `migrated`, `loaded`, error).
- [ ] No domain records (workspaces, tenders, customers, vault docs) are written to or read from `localStorage`.
- [ ] Every domain mutation persists via `saveStoreV2` with CAS revision tracking.
- [ ] Save failure preserves uncommitted local edits and surfaces Save Failed + Retry.
- [ ] `REVISION_CONFLICT` is surfaced cleanly without overwriting newer disk revisions.
- [ ] Theme guard (`npm run check:theme-colors`) passes without raw hex or rgb styling in new UI components.

### Quality & Guardrails
- [ ] `npm test -w @genoffice/tenders` passes with 0 failures (>=588 passing + new tests).
- [ ] `npm run typecheck -w @genoffice/tenders` passes with 0 errors.
- [ ] `npm run build -w @genoffice/tenders` and `npm run build -w @genoffice/shell` build cleanly.
- [ ] `npm run check:theme-colors` and `npm run format:check` pass.
- [ ] Isolated built-Electron smoke and E2E journeys succeed.
- [ ] Phase 2 Oracle gate passes with confirmation that v2 is the single authoritative source of truth.

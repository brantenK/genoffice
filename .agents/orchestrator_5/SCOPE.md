# Project Scope: Zano Books Backend Audit and Hardening (`apps/books`)

## Architecture
Zano Books (`apps/books` / `@genoffice/books`) is the core desktop accounting application within the GenOffice Electron multi-application monorepo. It manages the double-entry general ledger, chart of accounts, sales invoicing, purchase bills, bank statement imports, and reconciliation engine.

The Electron shell (`apps/shell`) hosts Books in a `WebContentsView` tab managed by `TabManager`. The backend lifecycle, file persistence, and IPC endpoints are handled by `apps/books/src/main/books-main.ts`.

### Unified Storage, Bookkeeping & Event Architecture
1. **Strict Double-Entry Bookkeeping (R1)**:
   - Fundamental invariant: Total Debits strictly equal Total Credits rounded to 2 decimal places for every transaction.
   - Sales Invoices: Debit `acc-ar`, Credit `acc-sales` (or item revenue accounts), Credit `acc-vat` (SARS VAT Output Payable).
   - Purchase Bills: Debit item expense accounts (e.g. `acc-materials`), Debit `acc-vat-in` (or `acc-vat`), Credit `acc-ap`.
   - Invoice Payments & Settlements: Generate balanced settlement JournalEntry (Debit `acc-bank`, Credit `acc-ar` for sales; Debit `acc-ap`, Credit `acc-bank` for purchase).
   - Party Balances: Enforce $\text{party.outstandingBalance} = \sum \text{openInvoice.outstandingAmount}$.
   - Shared deterministic math engine: `apps/books/src/shared/accounting.ts`.
2. **Harmonized Chart of Accounts & Resilient Persistence (R2)**:
   - Full 22 standard accounts across 5 root categories (Assets, Liabilities, Equity, Income, Expenses, Retained Earnings, Share Capital).
   - Full hierarchy with parent group accounts (`acc-asset`, `acc-curr-asset`, `acc-fixed-asset`, `acc-liab`, `acc-curr-liab`, `acc-equity`, `acc-income`, `acc-expense`).
   - Fix dangling parent IDs and blank screen in `ChartOfAccounts.tsx`.
   - Fix double-counting in `Dashboard.tsx` with `!a.isGroup` filter.
   - Atomic persistence via `.tmp` file and rename, plus timestamped corrupt JSON backup (`.corrupt-[timestamp]` and `.corrupted.bak`).
3. **Robust Bank Statement Import & Reconciliation Engine (R3)**:
   - Dynamic header detection (scanning first 10 lines) supporting South African bank formats (FNB, Standard Bank, Nedbank, Absa).
   - Robust number cleaning: debit/credit column support, parenthetical negatives `(1,250.00)`, decimal commas, currency tokens (`R`, `ZAR`).
   - Frequency-based deduplication preserving legitimate same-day charges.
   - Exact and partial settlement in `executeReconciliation` bound to actual `tx.amount`:
     $$\text{settledAmount} = \min(|\text{tx.amount}|, \text{inv.outstandingAmount})$$
   - Back-propagate `status: 'PAID'` to Tender milestones only when the linked invoice is fully settled.
4. **Real-Time IPC Synchronization Pipeline (R4)**:
   - `books:data-changed` channel in `BOOKS_CHANNELS` and `preload/index.ts`.
   - WebContents tracking, `broadcastBooksData(data, excludeSender)`, and file system watcher in `books-main.ts`.
   - Dual-layer loop suppression guards (sender exclusion in main + `lastSavedPayload` hash/string comparison in renderer).
   - Reload-free live UI updates when Tenders milestone billing or CRM won deal invoicing writes to `books-data.json`.
5. **Dedicated Automated Test Suite (R5)**:
   - Vitest configuration in `apps/books/vitest.config.ts`.
   - 6 test suites in `apps/books/tests/` testing invariants, postings, CSV parsing, reconciliation, persistence, and IPC sync.
   - 100% test pass rate and clean monorepo `npm run typecheck`.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Chart of Accounts Harmonization & Seeding | Define full 22 standard accounts + 8 root/subgroup nodes across backend and renderer, fixing blank tree crash | M1 | ORIGINAL_REQUEST §R2 |
| F2 | Shared Accounting Math Engine | Create `apps/books/src/shared/accounting.ts` with `round2`, `calculateInvoiceTotals`, and pure journal generators | M1 | ORIGINAL_REQUEST §R1 |
| F3 | Atomic Persistence & Corrupt Recovery | Timestamped `.corrupt-[timestamp]` and `.corrupted.bak` backups, atomic tmp/rename save, safe account migration backfilling | M1 | ORIGINAL_REQUEST §R2 |
| F4 | Dashboard & Report Hierarchy Consistency | Filter `!a.isGroup` in `Dashboard.tsx` to eliminate revenue/expense double-counting | M1 | ORIGINAL_REQUEST §R2 |
| F5 | Sales Invoice Balanced Journal Posting | Enforce Debit `acc-ar`, Credit `acc-sales`, Credit `acc-vat` with strictly 2-decimal rounded equality | M2 | ORIGINAL_REQUEST §R1 |
| F6 | Purchase Bill Balanced Journal Posting | Implement complete Purchase Bill journal posting: Debit Expense, Debit VAT Input, Credit `acc-ap` | M2 | ORIGINAL_REQUEST §R1 |
| F7 | Draft-to-Posted Invoice Transition | Remove `!partial.id` posting guard so invoices transitioning from Draft to Unpaid properly generate journal entries | M2 | ORIGINAL_REQUEST §R1 |
| F8 | Invoice Payment & Reversal Settlement Journals | Generate settlement JournalEntry on `markInvoicePaid`, deduct `outstandingAmount` accurately, reverse on delete | M2 | ORIGINAL_REQUEST §R1 |
| F9 | Party Outstanding Balance Invariant | Guarantee party balances strictly reflect sum of open invoice outstanding amounts | M2 | ORIGINAL_REQUEST §R1 |
| F10 | SA Bank Statement CSV Parser | Dynamic header detection, regex column mapping, parenthetical negatives, comma decimals for FNB/Standard/Nedbank/Absa | M3 | ORIGINAL_REQUEST §R3 |
| F11 | Resilient Bank Transaction Deduplication | Frequency-based deduplication preserving legitimate identical charges on same day and references | M3 | ORIGINAL_REQUEST §R3 |
| F12 | Exact & Partial Reconciliation Settlement Math | Bind settlements to actual `tx.amount`, update remaining invoice balances, deduct exact AR/AP, post exact journal | M3 | ORIGINAL_REQUEST §R3 |
| F13 | Tender Milestone Paid Back-Propagation | Back-propagate `status: 'PAID'` to tender milestone in `tenders-data.json` only upon full invoice settlement | M3 | ORIGINAL_REQUEST §R3 |
| F14 | `books:data-changed` IPC Broadcast Pipeline | Implement WebContents tracking, `broadcastBooksData`, and file system watcher in `books-main.ts` | M4 | ORIGINAL_REQUEST §R4 |
| F15 | Renderer Live Store Sync & Loop Suppression | Implement `onDataChanged` in preload, `syncFromMain` in `store.ts`, dual-layer echo suppression, and `Desk.tsx` hook | M4 | ORIGINAL_REQUEST §R4 |
| F16 | Cross-App Live Refresh Verification | Verify Tenders milestone billing and CRM invoicing instantly refresh open Books tab without reload | M4 | ORIGINAL_REQUEST §R4 |
| F17 | Vitest Test Suite Setup for `apps/books` | Create `apps/books/vitest.config.ts`, add `"test"` script to `package.json`, configure test runner | M5 | ORIGINAL_REQUEST §R5 |
| F18 | Automated Test Suites for Invariants & Ledger | Vitest tests for double-entry balance, Sales/Purchase posting, Draft transitions, party balances | M5 | ORIGINAL_REQUEST §R5 |
| F19 | Automated Test Suites for Parser & Reconciliation | Vitest tests for SA bank CSV formats, parenthetical negatives, deduplication, exact & partial reconciliation | M5 | ORIGINAL_REQUEST §R5 |
| F20 | Automated Test Suites for Persistence & IPC Sync | Vitest tests for atomic writes, corrupt JSON recovery, schema migration, `books:data-changed` push, tender sync | M5 | ORIGINAL_REQUEST §R5 |
| F21 | Monorepo Quality & Forensic Audit Certification | Clean `npm run typecheck` across all 22 packages, 100% tests passing, zero brand violations, Forensic Audit certified | M5 | ORIGINAL_REQUEST §AC |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | CoA Harmonization, Persistence Invariants & Accounting Engine | F1, F2, F3, F4 | none | DONE |
| M2 | Strict Double-Entry Bookkeeping & Balanced Journal Posting | F5, F6, F7, F8, F9 | M1 | DONE |
| M3 | Robust Bank Statement Import & Reconciliation Engine | F10, F11, F12, F13 | M1, M2 | DONE |
| M4 | Real-Time IPC Synchronization & Cross-App Event Pipeline | F14, F15, F16 | M1 | DONE |
| M5 | Dedicated Automated Test Suite & Verification | F17, F18, F19, F20, F21 | M1, M2, M3, M4 | DONE |

---

## Code Layout
- `apps/books/src/main/books-main.ts` — Electron main backend: persistence, IPC handlers, bank statement import, reconciliation, WebContents broadcast, store watcher.
- `apps/books/src/shared/accounting.ts` — Pure deterministic bookkeeping and rounding engine: `round2`, `calculateInvoiceTotals`, journal generators, party balance invariants.
- `apps/books/src/shared/types.ts` — Data models: Account, Invoice, JournalEntry, BankTransaction, Party, SettlementSuggestion.
- `apps/books/src/shared/ipc.ts` — IPC channels including `books:data-changed` and typed `BooksApi` interface.
- `apps/books/src/preload/index.ts` — Preload script exposing `window.booksApi`.
- `apps/books/src/renderer/src/store.ts` — Zustand store: invoice persistence, payment settlement, reconciliation, `syncFromMain`.
- `apps/books/src/renderer/src/mock/initialData.ts` — Harmonized initial seed data with 22 standard accounts + 8 group nodes.
- `apps/books/src/renderer/src/components/ChartOfAccounts.tsx` — Account tree rendering.
- `apps/books/src/renderer/src/components/Dashboard.tsx` — Overview metrics with `!a.isGroup` filter.
- `apps/books/src/renderer/src/components/Desk.tsx` — Top-level tab desk subscribing to `onDataChanged`.
- `apps/books/vitest.config.ts` — Vitest configuration for `apps/books`.
- `apps/books/tests/` — Automated Vitest test suites.

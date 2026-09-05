# BRIEFING — 2026-09-05T07:15:00Z

## Mission
Implement Milestone 1 (M1): Chart of Accounts Harmonization, Persistence Schema Invariants & Accounting Engine Foundation (Features F1, F2, F3, F4).

## 🔒 My Identity
- Archetype: worker
- Roles: implementer, qa, specialist
- Working directory: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m1_coa_engine
- Original parent: 3d77b420-8b70-452a-8634-e59f49e46b15
- Milestone: Milestone 1 (M1)

## 🔒 Key Constraints
- Write Ownership exclusively restricted to:
  - `apps/books/src/shared/accounting.ts` (create new file)
  - `apps/books/src/main/books-main.ts`
  - `apps/books/src/renderer/src/mock/initialData.ts`
  - `apps/books/src/renderer/src/components/ChartOfAccounts.tsx`
  - `apps/books/src/renderer/src/components/Dashboard.tsx`
- Do not modify files outside ownership.
- Genuine implementation only, no mock/facade/hardcoded tests.
- Total Debit == Total Credit strictly.
- Strict 2-decimal rounding.

## Current Parent
- Conversation ID: 3d77b420-8b70-452a-8634-e59f49e46b15
- Updated: 2026-09-05T07:15:00Z

## Task Summary
- **What to build**:
  1. `apps/books/src/shared/accounting.ts` with round2, calculateInvoiceTotals, createSalesInvoiceJournal, createPurchaseBillJournal, createSettlementJournal, recomputePartyBalances.
  2. Harmonize `CORE_ACCOUNTS` in `books-main.ts` and `initialData.ts` (22 standard accounts + 8 root/subgroup accounts with parentId: null for root groups).
  3. Fix `ChartOfAccounts.tsx` root node handling (`parentId === null || parentId === undefined`).
  4. Fix `Dashboard.tsx` double-counting by filtering `!a.isGroup`.
  5. Harden Persistence & Corrupt Recovery in `books-main.ts` (both timestamped corrupt file and legacy .corrupted.bak, backfill missing standard accounts/groups in migrateAndValidateBooks).
- **Success criteria**:
  - `npm run typecheck -w @genoffice/books` passes (exited 0).
  - `node tools/verify-suite-workflows.mjs` passes (56/56 passed).
  - All unit/invariant tests pass (exited 0).

## Key Decisions Made
- `accounting.ts`: Re-exported from `books-main.ts` so main process, IPC endpoints, and external callers have unified access to math and journal creation logic.
- `calculateInvoiceTotals`: Strict per-line and total rounding guarantees `subtotal + taxTotal === grandTotal`.
- `createSalesInvoiceJournal` / `createPurchaseBillJournal`: Group items by target account ID if provided; fall back to default sales/materials accounts; guarantee `totalDebit === totalCredit` cent-for-cent.
- `createSettlementJournal`: Supports both options object and positional arguments; produces strictly balanced settlement entries.
- `CORE_ACCOUNTS`: Expanded to 30 accounts (22 standard leaf accounts across 5 root categories + 8 group/subgroup accounts). Root groups explicitly set `parentId: null`.
- `readBooksStore`: In corrupt JSON catch block, writes both timestamped `.corrupt-${timestamp}` and legacy `.corrupted.bak`.
- `ChartOfAccounts.tsx`: Handled `parentId === null || parentId === undefined` and orphaned accounts at depth 0.
- `Dashboard.tsx`: Added `!a.isGroup` filter on income, expense, and bank accounts to prevent double-counting.

## Artifact Index
- DISPATCH.md — Dispatch instructions
- BRIEFING.md — Situational awareness
- progress.md — Liveness & heartbeat
- handoff.md — Final handoff report

## Change Tracker
- **Files modified**:
  - `apps/books/src/shared/accounting.ts`: Pure accounting engine with rounding, journal creators, and party balance invariants.
  - `apps/books/src/main/books-main.ts`: Expanded CORE_ACCOUNTS, hardened corrupt backup & migration backfilling, re-exported accounting engine.
  - `apps/books/src/renderer/src/mock/initialData.ts`: Harmonized 30 accounts with CORE_ACCOUNTS, normalized party balances.
  - `apps/books/src/renderer/src/components/ChartOfAccounts.tsx`: Fixed root tree rendering for null/undefined parentId.
  - `apps/books/src/renderer/src/components/Dashboard.tsx`: Added `!a.isGroup` filter to eliminate double-counting.
- **Build status**: PASS (`npm run typecheck -w @genoffice/books`, `npm run typecheck` monorepo, `tools/verify-suite-workflows.mjs`)
- **Pending issues**: None

## Quality Status
- **Build/test result**: PASS (56/56 suite workflows, 31/31 challenger empirical tests, monorepo typecheck 0 errors)
- **Lint status**: Clean
- **Tests added/modified**: Verified all accounting engine methods, CoA hierarchy, corrupt recovery

## Loaded Skills
- None

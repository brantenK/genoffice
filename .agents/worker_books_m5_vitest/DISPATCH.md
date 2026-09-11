## 2026-09-05T12:49:36Z
You are worker_books_m5_vitest.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m5_vitest

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also read:
- Scope: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md`
- Survey & Architecture: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_books_reconciliation\handoff.md`
- Existing implementations in:
  - `apps/books/src/shared/accounting.ts`
  - `apps/books/src/shared/ipc.ts`
  - `apps/books/src/main/books-main.ts`
  - `apps/books/src/renderer/src/store.ts`
  - `apps/books/src/preload/index.ts`
- Reference Vitest config: `apps/tenders/vitest.config.ts`

Your Mission:
Implement Milestone 5 (M5): Dedicated Automated Test Suite & Verification (Features F17, F18, F19, F20, F21).

Write Ownership (You exclusively own and may edit/create these files):
- `apps/books/package.json` (add "test": "vitest run", "test:watch": "vitest")
- `apps/books/vitest.config.ts` (create)
- `apps/books/tests/` (create test directory and all test files)
- `package.json` (at monorepo root: add `&& npm run test -w @genoffice/books` to the "test" script)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Detailed Tasks:
1. Configure Vitest for `@genoffice/books`:
   - In `apps/books/package.json`:
     - Add `"test": "vitest run"` and `"test:watch": "vitest"` to `"scripts"`.
     - In `"devDependencies"`, add `"vitest": "^4.1.0"` if needed (or verify it resolves from monorepo root).
   - In `apps/books/vitest.config.ts`:
     - Set up `defineConfig` resolving aliases for `@genoffice/docx-engine`, `@genoffice/electron-utils`, `@genoffice/project-store`, `@genoffice/i18n`, `@genoffice/ui`.
     - Configure `test.include: ['tests/**/*.test.ts']`, `test.environment: 'jsdom'`, `test.testTimeout: 20000`.
   - In root `package.json`:
     - In the `"test"` script, append ` && npm run test -w @genoffice/books` so running `npm test` at the root executes books tests alongside other packages.

2. Create Comprehensive Automated Test Suites in `apps/books/tests/`:
   Create 6 robust, genuine Vitest test suites:
   a) `apps/books/tests/invariants.test.ts`:
      - Strict double-entry equality ($\sum \text{Debits} = \sum \text{Credits}$) strictly rounded to 2 decimal places.
      - `round2` precision with floating point edge cases (e.g. `1.005`, `0.1 + 0.2`, sub-cent handling).
      - `calculateInvoiceTotals` with 15% VAT, 0% VAT, negative items (commercial discounts/rebates), credit/debit adjustments.
      - Party balance invariants (`recomputePartyBalances` matching open invoice outstanding amounts).
   b) `apps/books/tests/ledger-posting.test.ts`:
      - Sales Invoice journal generation (`createSalesInvoiceJournal`) and store posting actions in `store.ts` (`saveInvoice`).
      - Purchase Bill journal generation (`createPurchaseBillJournal`) and store posting actions.
      - Draft-to-Posted transition (Draft invoices do not post or mutate balances; transitioning to Unpaid/Paid posts balanced entries).
      - Payment settlement journals (`createSettlementJournal`, `markInvoicePaid`).
      - Invoice deletion reversals (`deleteInvoice` reversing balances and cleaning up journals).
   c) `apps/books/tests/bank-csv-parser.test.ts`:
      - Parse South African bank statement CSV formats: FNB, Standard Bank, Nedbank, Absa.
      - Dynamic metadata header detection (skipping introductory metadata rows until reaching column headers).
      - Parenthetical negatives: `(1,250.00)` -> `-1250.00`.
      - Decimal commas: `1250,50` -> `1250.50` and spaces as thousands separators: `1 250.50`.
      - Resilient frequency-based deduplication (`deduplicateBankTransactions`).
   d) `apps/books/tests/reconciliation.test.ts`:
      - Exact settlement math (`executeReconciliation` and store `reconcileTransaction`).
      - Partial settlement math: binds to actual `Math.min(Math.abs(tx.amount), currentOutstanding)`, updates `outstandingAmount`, sets status to `'Paid'` if and only if outstanding <= 0.
      - Balanced settlement journal creation for customer receipts (`acc-bank` debit, `acc-ar` credit) and supplier payments (`acc-ap` debit, `acc-bank` credit).
      - Cross-app tender milestone back-propagation: milestone status updates to `'PAID'` if and only if invoice is fully settled.
   e) `apps/books/tests/persistence.test.ts`:
      - Atomic writes (`writeBooksStore` with `.tmp` and atomic rename).
      - Corrupt JSON backup (`.corrupt-[timestamp]` and `.corrupted.bak`) without crashing process.
      - Safe schema migrations, backfilling all 22 standard accounts + 8 root/group accounts, non-destructive balance preservation.
   f) `apps/books/tests/ipc-sync.test.ts`:
      - `BOOKS_CHANNELS.dataChanged` ('books:data-changed') contract and preload listener registration/cleanup.
      - Active WebContents tracking (`activeBooksWebContents`) and auto-pruning on `destroyed`.
      - Layer 1 sender loop suppression (`broadcastBooksData(data, excludeSender)`).
      - Layer 2 hash comparison loop suppression (`computeDataHash`, `lastSavedHash`, and non-persisting `syncFromMain`).
      - Debounced filesystem watcher (`startBooksStoreWatcher`) on `books-data.json` and cross-app live sync simulation.

3. Verification Commands:
   - `npm test -w @genoffice/books` (Must pass 100% of test suites with exit code 0)
   - `npm run typecheck -w @genoffice/books` (0 errors)
   - `npm run build -w @genoffice/books` (0 errors)
   - `node tools/verify-suite-workflows.mjs` (56/56 PASS)
   - `npx tsx tools/verify-books-m4-challenger.ts` (19/19 PASS)
   - `npx tsx tools/verify-books-m3-challenger.ts` (20/20 PASS)
   - `npx tsx tools/verify-books-m2-challenger.ts` (12/12 PASS)
   - `npm run typecheck` across all 22 monorepo packages (0 errors)
   - `npm run check:brand` (0 brand violations)

4. Report:
   - Deliver your handoff report to `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m5_vitest\handoff.md`.
   - Include files created/modified, all test suites and test counts, verification commands and exact outputs.
   - When done, send a completion message to the orchestrator via send_message.

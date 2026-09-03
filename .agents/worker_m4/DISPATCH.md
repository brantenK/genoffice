# Dispatch Assignment: Worker 4 (Milestone 4)

## 2026-09-03T18:51:13Z

Implement Milestone 4: Bank Statement Import & Reconciliation in Zano Books (Features F13, F14, F15, F16, F17 in PROJECT.md):

1. **Type Definitions & Data Models (`apps/books/src/shared/types.ts`)**:
   - Define `BankTransaction` interface
   - Define `SettlementSuggestion` interface
   - Add `bankTransactions?: BankTransaction[]` to `BooksData` and `BooksDataEnvelope`
   - Add `'banking'` to `BooksNavigationTab`

2. **IPC Protocol & Preload (`apps/books/src/shared/ipc.ts` & `apps/books/src/preload/index.ts`)**:
   - In `apps/books/src/shared/ipc.ts`: add `importBankStatementCsv`, `reconcileTransaction`, `getSettlementSuggestions` to channels and BooksApi.
   - In `apps/books/src/preload/index.ts`: expose methods on `booksApi`.

3. **Main Process Implementation (`apps/books/src/main/books-main.ts`)**:
   - `migrateAndValidateBooks`: validate and preserve `bankTransactions`.
   - Implement & export: `parseBankStatementCsv`, `importBankStatement`, `computeSettlementSuggestions`, `executeReconciliation`.
   - Register IPC handlers in `registerBooksIpc`.

4. **UI Components & Desk Navigation (`apps/books/src/renderer/src/`)**:
   - `BankingView.tsx`: Clean Frappe Books aesthetic, FNB Cheque Account header, CSV import, load sample, suggestions cards, transaction ledger.
   - `Desk.tsx`: add 'banking' tab with Landmark icon.
   - `store.ts`: add actions and state for bank reconciliation.

5. **Verification & Testing**:
   - Brand check, suite verification, typecheck, build:all.

## 2026-09-05T07:17:46Z
You are challenger_1_books_m1.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\challenger_1_books_m1

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also inspect:
- Scope: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md`
- Worker M1 Handoff: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m1_coa_engine\handoff.md`

Your Mission:
Empirically stress-test Milestone 1 (M1) implementations.

Empirical Checks to Perform:
1. Accounting math edge cases (`apps/books/src/shared/accounting.ts`):
   - Test floating-point precision: e.g. amounts with .005, .004, .044, .999, negative zeroes.
   - Test `calculateInvoiceTotals` on multi-item invoices with different tax rates. Verify `subtotal + taxTotal === grandTotal` strictly.
   - Test `createSalesInvoiceJournal` and `createPurchaseBillJournal` on multi-item invoices. Verify `totalDebit === totalCredit` strictly.
   - Test `createSettlementJournal` for sales and purchase settlements. Verify debits == credits == settledAmount.
2. Chart of Accounts invariants:
   - Verify that `CORE_ACCOUNTS` and `initialData.accounts` have all 22 standard accounts + 8 root/group accounts.
   - Verify that all root group accounts have `parentId === null`.
   - Verify that no account points to a non-existent `parentId`.
3. Persistence & corrupt recovery:
   - Create a test script or harness that feeds malformed JSON into `readBooksStore` and verify that BOTH `.corrupt-[timestamp]` and `.corrupted.bak` files are created on disk.
   - Verify that fallback data retains valid core accounts.

Deliver your findings and verdict (APPROVE or REJECT) in `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\challenger_1_books_m1\handoff.md` and notify the orchestrator.

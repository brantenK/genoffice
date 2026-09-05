## 2026-09-05T08:07:31Z

Conduct a thorough, objective code review of Milestone 2 (M2): Strict Double-Entry Bookkeeping & Balanced Journal Posting in Renderer Store Actions.

Files to Review:
- apps/books/src/renderer/src/store.ts
- apps/books/src/renderer/src/components/InvoiceForm.tsx
- apps/books/src/shared/accounting.ts
- tools/verify-books-m2-challenger.ts

Review Criteria:
1. Feature F5 (Sales Invoices Balanced Journal Posting):
   - Check saveInvoice: Does it generate balanced journal entry (totalDebit === totalCredit)?
   - Does it increment acc-ar by grandTotal, revenue accounts by line item amounts, and acc-vat by taxTotal?
2. Feature F6 (Purchase Bills Balanced Journal Posting):
   - Check saveInvoice for purchase bills: Does it generate balanced journal entry?
   - Does it increment acc-ap by grandTotal, expense accounts by line item amounts, and acc-vat-in (or acc-vat) by taxTotal?
3. Feature F7 (Draft-to-Posted Transition):
   - Does transitioning an invoice from Draft to Unpaid/Paid trigger journal posting and ledger balance updates?
4. Feature F8 (Settlement Journals & Payment Math):
   - Check markInvoicePaid: Does it generate createSettlementJournal for settlementAmount?
   - Does it update Bank and AR/AP balances accurately?
   - Does deleteInvoice revert ledger balances and clean up journals?
5. Feature F9 (Party Balance Invariant):
   - Does recomputePartyBalances ensure party outstandingBalance strictly equals sum of open invoice outstanding amounts?
6. Verification Commands:
   - npm run typecheck -w @genoffice/books
   - npm run build -w @genoffice/books
   - npx tsx tools/verify-books-m2-challenger.ts
   - node tools/verify-suite-workflows.mjs
   - node tools/test-challenger-m1-empirical.mjs
   - npm run typecheck across all 22 monorepo packages

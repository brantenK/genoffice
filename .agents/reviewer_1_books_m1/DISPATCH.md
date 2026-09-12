## 2026-09-05T07:17:46Z
You are reviewer_1_books_m1.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\reviewer_1_books_m1

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also inspect:
- Scope: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md`
- Worker M1 Handoff: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m1_coa_engine\handoff.md`

Your Mission:
Conduct a thorough, objective code review of Milestone 1 (M1): Chart of Accounts Harmonization, Persistence Invariants & Accounting Engine.

Files to Review:
- `apps/books/src/shared/accounting.ts`
- `apps/books/src/main/books-main.ts`
- `apps/books/src/renderer/src/mock/initialData.ts`
- `apps/books/src/renderer/src/components/ChartOfAccounts.tsx`
- `apps/books/src/renderer/src/components/Dashboard.tsx`

Review Criteria:
1. Correctness & Precision:
   - Does `accounting.ts` ensure `round2` precision?
   - In `calculateInvoiceTotals`, does `subtotal + taxTotal === grandTotal` strictly hold?
   - Do `createSalesInvoiceJournal`, `createPurchaseBillJournal`, and `createSettlementJournal` enforce `totalDebit === totalCredit`?
2. CoA Harmonization:
   - Are all 22 standard accounts + 8 root/group nodes properly defined?
   - Are root groups configured with `parentId: null`?
   - Does `ChartOfAccounts.tsx` render without crashing or blank screen?
3. Persistence & Corruption:
   - Does `readBooksStore` in `books-main.ts` write BOTH timestamped `.corrupt-[timestamp]` and legacy `.corrupted.bak`?
   - Does `migrateAndValidateBooks` backfill missing standard accounts and groups?
4. Verification:
   - Run `npm run typecheck -w @genoffice/books`
   - Run `node tools/verify-suite-workflows.mjs`

Deliver your verdict (APPROVE or REQUEST_CHANGES) with supporting evidence in `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\reviewer_1_books_m1\handoff.md` and notify the orchestrator.

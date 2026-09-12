## 2026-09-05T11:35:19Z

You are reviewer_2_books_m2_fresh.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\reviewer_2_books_m2_fresh

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also inspect:
- Scope: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md
- Worker M2 Handoff: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m2_ledger\handoff.md

Your Mission:
Independently conduct an adversarial code and interface review of Milestone 2 (M2): Strict Double-Entry Bookkeeping & Balanced Journal Posting.

Files to Review:
- pps/books/src/renderer/src/store.ts
- pps/books/src/renderer/src/components/InvoiceForm.tsx
- pps/books/src/shared/accounting.ts
- 	ools/verify-books-m2-challenger.ts

Review Criteria:
1. UI & Account Selection (InvoiceForm.tsx):
   - Are group accounts excluded (!a.isGroup) so users cannot book directly to parent/root accounts?
   - Are line item totals and VAT calculated with calculateInvoiceTotals?
2. Edge cases in store.ts:
   - Invoices with 0% tax or exempt items.
   - What happens if an invoice is created directly with status: 'Paid'?
   - What happens on deleteInvoice for Draft vs Unpaid vs Paid invoices?
   - Is window.booksApi guarded in non-browser or test runner environments?
3. Invariant checks:
   - Does party balance recomputation strictly preserve parity between customer/supplier balances and open invoices?
4. Verification Commands:
   - 
pm run typecheck -w @genoffice/books
   - 
pm run build -w @genoffice/books
   - 
px tsx tools/verify-books-m2-challenger.ts
   - 
ode tools/verify-suite-workflows.mjs
   - 
pm run check:brand

Deliver your verdict (APPROVE or REQUEST_CHANGES) with supporting evidence in c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\reviewer_2_books_m2_fresh\handoff.md and notify the orchestrator.

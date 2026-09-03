## 2026-09-03T17:45:48Z

You are Reviewer 2 for Milestone 2 (reviewer_2_m2).
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\reviewer_2_m2

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md

You MUST read the project blueprint at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\PROJECT.md

Read TEST_READY.md at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\TEST_READY.md

Read Worker 2's handoff report at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_m2\handoff.md

Your mission:
Adversarially challenge and review Milestone 2:
1. Examine potential failure modes:
   - Does `createInvoiceInBooks` strictly reject deals that are not in `'won'` stage?
   - Does it prevent duplicate billing if triggered multiple times on the same won deal?
   - Does it correctly handle deals without a `companyName` (falls back gracefully to deal name)?
   - Does it properly compute 15% VAT and maintain balanced journal entries (`debit === credit === grandTotal`)?
   - Does clicking invoice buttons in `DealsTableView` and `DealModal` switch the shell view to Books?
2. Run verification commands:
   - `npm run check:brand`
   - `npm run typecheck`
   - `node tools/verify-suite-workflows.mjs --feature r2`
3. Deliver your structured review verdict: APPROVE or REQUEST_CHANGES.
Write your handoff report to:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\reviewer_2_m2\handoff.md
Notify me via send_message with your verdict.

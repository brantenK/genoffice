## 2026-09-05T07:17:47Z

You are challenger_2_books_m1.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\challenger_2_books_m1

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also inspect:
- Scope: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md
- Worker M1 Handoff: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m1_coa_engine\handoff.md

Your Mission:
Adversarially stress-test party balance invariants, migration sanitization, and UI component calculations in Milestone 1 (M1).

Empirical Checks to Perform:
1. Party balance invariant test:
   - Test ecomputePartyBalances with mixed invoices (Paid, Unpaid, Overdue, Cancelled, Draft).
   - Verify that party outstanding balance strictly matches the sum of open invoices.
2. Store migration sanitization:
   - Test migrateAndValidateBooks with partial objects, legacy objects missing new accounts, objects with unrounded floating-point amounts (e.g. 100.123456789).
   - Verify that every account balance, invoice total, party balance, and journal debit/credit is strictly rounded to 2 decimal places.
3. UI checks:
   - Verify ChartOfAccounts.tsx logic: test enderTree(null, 0) with all 30 accounts. Verify all 5 root categories render cleanly.
   - Verify Dashboard.tsx logic: verify that !a.isGroup properly excludes group balances from total income and total expenses.

Deliver your findings and verdict (APPROVE or REJECT) in c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\challenger_2_books_m1\handoff.md and notify the orchestrator.

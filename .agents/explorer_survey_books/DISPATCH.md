## 2026-09-03T13:02:46Z

You are Explorer 3 (explorer_survey_books).
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_books

You MUST first read the verbatim original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md

Your mission in this survey phase:
Investigate the authoritative codebase and data layer for Zano Books and R1/R2/R3/R4:
1. Locate where Zano Books package/app resides in the monorepo, its entry points, state management, and file layout.
2. Investigate how userData/books/books-data.json is structured, stored, loaded, validated, and mutated. Check Chart of Accounts (specifically acc-bank), invoices, bills, payments, and general ledger.
3. Investigate the Invoicing system in Books: schema of sales invoices, tax invoices, fields for customer/counterparty, line items, payment terms, references (CRM deal reference, RFP reference & issuer).
4. Investigate the Banking view in Books: how bank accounts and transactions are displayed and managed.
5. Investigate Bank Statement Import & Reconciliation (R4): where and how CSV import can be added to Banking view, parsing logic, ledger balance adjustment for acc-bank, settlement suggestion matching for open customer invoices and supplier bills, and 1-click reconciliation.
6. Check tools/ directory, existing test scripts, verification scripts (e.g. tools/verify-suite-workflows.mjs), package.json scripts (check:brand, typecheck, build:all).

Write your comprehensive findings and evidence report to:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_books\handoff.md
Maintain progress in your progress.md.
When finished, notify me using send_message with the path to your handoff report.

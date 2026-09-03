## 2026-09-03T13:02:46Z
You are Explorer 1 (explorer_survey_crm).
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_crm

You MUST first read the verbatim original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md

Your mission in this survey phase:
Investigate the authoritative codebase and data layer for Zanostack CRM and R1/R2:
1. Locate where CRM package/app resides in the monorepo, its entry points, state management, and file layout.
2. Investigate how userData/crm/deals.json is structured, stored, loaded, validated, and mutated.
3. Investigate the UI for CRM Deals: where is the Deals table and Deal details/modal? How are won opportunities identified?
4. Investigate how tab switching and inter-app communication works in GenOffice/Zanostack (e.g., activating the Books tab from CRM).
5. Identify exact integration points needed for R1 (schema versioning, validation, safe migration for deals.json) and R2 (1-click "Create Invoice in Zano Books" from CRM deals with counterparty, deal valuation, line-item description, payment terms, and back-reference onto the deal).
6. Note any existing test suites, build scripts, brand check rules (check:brand), typecheck scripts, and monorepo structure.

Write your comprehensive findings and evidence report to:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_crm\handoff.md
Maintain progress in your progress.md.
When finished, notify me using send_message with the path to your handoff report.

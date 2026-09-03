# Original User Request

## 2026-09-03T13:00:56Z

Harden and expand the workflows of Zanostack CRM, Zanostack Tenders, and Zano Books by implementing resilient update & synchronization handling for external requests, a 1-click CRM-to-Books invoicing bridge, Tenders milestone billing into Books, and bank statement CSV reconciliation in Zano Books.

Working directory: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice
Integrity mode: development

## Requirements

### R1. Resilient Update & External Sync Architecture
Implement schema versioning, validation, and safe data migration for all 3 applications (userData/crm/deals.json, userData/tenders/tenders-data.json, and userData/books/books-data.json) so that application updates and external sync requests merge cleanly without data loss or corruption.

### R2. CRM to Zano Books Invoicing Automation
Add a direct 1-click "Create Invoice in Zano Books" workflow in Zanostack CRM for won opportunities. When triggered, it creates a formatted Sales Invoice in Zano Books with the customer counterparty, deal valuation, line-item description, and payment terms, while recording the invoice reference back onto the CRM deal.

### R3. Tenders Contract Milestone Billing in Zano Books
Add a "Bill Milestone in Zano Books" action in Zanostack Tenders. When a tender contract or project milestone is reached, it generates a tax invoice in Books linked to the tender's reference number (RFP-WTR-2026-04), issuing authority, and milestone progress amount.

### R4. Bank Statement Import & Reconciliation in Zano Books
Add a bank statement import workflow in Zano Books that accepts standard bank transaction CSV files, imports transactions into the designated Bank Account (acc-bank), and automatically suggests matching settlements for open customer invoices and supplier bills.

## Acceptance Criteria

### Interoperability & Functional Workflows
- [ ] CRM Deals table and modal include a "Create Invoice in Zano Books" action that generates a matching sales invoice in Books and activates the Books tab.
- [ ] Tenders compliance workspace includes a "Bill Milestone in Books" action that attaches the tender RFP reference and issuer to a billable invoice in Books.
- [ ] Zano Books includes a "Import Bank Statement" tool in the Banking view that parses transaction CSVs, adjusts bank ledger balances, and can reconcile unpaid invoices with 1 click.
- [ ] Data stores (crm, tenders, books) handle schema evolution and external data updates safely without dropping existing user entries.

### Objective Verification
- [ ] An automated end-to-end integration script (tools/verify-suite-workflows.mjs) executes programmatic end-to-end tests for CRM -> Books, Tenders -> Books, and bank statement parsing, exiting with code 0.
- [ ] npm run check:brand passes with 0 unauthorized upstream brand occurrences.
- [ ] npm run typecheck passes cleanly across all 22 monorepo packages.
- [ ] npm run build:all compiles all packages without error.

## Follow-up — 2026-09-03T17:23:26Z

The server restarted and quota has reset. Please resume monitoring and orchestrating the Zanostack workflow implementation. Check the state of .agents and continue from where work left off.

## 2026-09-04T21:14:55Z

You are worker_m3_interop, an implementation and verification worker.
Your assigned working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_m3_interop

You MUST read ORIGINAL_REQUEST.md before starting work:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md
Specifically inspect the latest request dated 2026-09-04T18:31:53Z.

Also read PROJECT.md:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\PROJECT.md

And read the Explorer handoff report:
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_interop\handoff.md

Scope of Milestone 3: Cross-App Interoperability & Export Workflows (R3)
Your write ownership covers:
- apps/tenders/src/main/tenders-main.ts
- apps/books/src/main/books-main.ts
- apps/crm/src/main/crm-main.ts
- apps/crm/src/renderer/src/components/DealsTableView.tsx
- apps/tenders/src/renderer/src/components/Workspace.tsx
- apps/tenders/src/renderer/src/components/MilestonesDrawer.tsx
- tools/verify-tenders-interop.ts (verification harness)

Detailed implementation tasks:
1. **Zano Books Reconciliation Payment Back-Propagation**:
   - In `apps/books/src/main/books-main.ts` (`executeReconciliation`):
     - When reconciling an invoice that has `tenderReference` (or matching tender milestone in `tenders-data.json`):
     - Read `userData/tenders/tenders-data.json` via `readTendersStore`.
     - Find the tender milestone matching `billedInvoiceId === invoice.id` or `billedInvoiceNumber === invoice.number` (or matching reference/amount).
     - Update `milestone.status = 'PAID'` and set `milestone.paidAt = new Date().toISOString()`.
     - Atomically write `tenders-data.json` via `writeTendersStore(tendersPath, tendersData)`. (This automatically broadcasts `tenders:data-changed` to all active Tenders WebContents).
   - In `apps/tenders/src/renderer/src/components/MilestonesDrawer.tsx` / `Workspace.tsx`:
     - Render `'PAID'` badge/pill with payment date and link to invoice in Books.
2. **Zano CRM Tender Opportunity Sync Hardening**:
   - In `apps/tenders/src/main/tenders-main.ts` (`syncWithCrm`):
     - Use deterministic deal ID: `deal-tender-${tender.id}` (or `dealId` if passed).
     - Ensure the created/updated deal in `userData/crm/deals.json` includes:
       - `id: deal-tender-${tender.id}`
       - `name: ${tender.referenceNumber} - ${tender.title}`
       - `companyName: tender.issuingBody`
       - `amount: tender.estimatedValue || 0`
       - `stage: 'proposal'`
       - `expectedCloseDate: tender.closingDate`
       - `notes: Tender Ref: ${tender.referenceNumber}\nIssuing Authority: ${tender.issuingBody}`
       - `tenderReference: tender.referenceNumber`
       - `tenderId: tender.id`
     - Record `tender.linkedCrmDealId = deal.id` back onto `TenderRecord` in `tenders-data.json` and persist via `writeTendersStore`!
     - Broadcast `tenders:data-changed`.
   - In `apps/tenders/src/renderer/src/components/Workspace.tsx`:
     - Show linked CRM deal button/indicator when `tender.linkedCrmDealId` exists, allowing 1-click navigation to CRM.
   - In `apps/crm/src/renderer/src/components/DealsTableView.tsx` (or CRM store):
     - Ensure deals reload or update cleanly when switching to CRM tab.
3. **Zano Docs & Sheets Export Workflows**:
   - In `apps/tenders/src/main/tenders-main.ts`:
     - `exportMatrixToSheets`:
       - Generates properly escaped CSV with BOM (`\uFEFF`) and headers: `Requirement ID, Category, Requirement Text, Mandatory / Disqualifier, Fulfillment Status, Linked Document, Health Status, Notes`.
       - Saves to temp file `${sanitizedTitle}_Compliance_Matrix_${Date.now()}.csv`.
       - Calls `runtime.openGeneratedPath(targetPath)`.
     - `draftProposalDoc`:
       - Generates cleanly formatted proposal document with executive summary, methodology, pricing schedule, and compliance checklist.
       - Saves to temp file `${sanitizedTitle}_Draft_Proposal_${Date.now()}.md` (or `.docx`).
       - Calls `runtime.openGeneratedPath(targetPath)`.
4. **Verification**:
   - Run `npm run check:brand` (0 violations).
   - Run `npm run typecheck` across all 22 monorepo packages (0 errors).
   - Create `tools/verify-tenders-interop.ts` verifying:
     a) Billed milestones produce balanced journal entries, accounts receivable adjustments, and linked tax invoices in Zano Books.
     b) Books bank reconciliation marks linked milestone as `PAID` in `tenders-data.json` and broadcasts `tenders:data-changed`.
     c) Tenders exported to CRM appear with expected metadata (reference, issuer, value, closing date) in CRM deals with deterministic ID.
     d) Export matrix to Sheets and Draft proposal in Docs generate valid files without error and trigger corresponding shell tab navigation.
     e) Existing suites (`verify-tenders-sync.ts`, `verify-tenders-storage.ts`, `verify-suite-workflows.mjs`) continue to pass 100%.

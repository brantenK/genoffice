## 2026-09-03T13:14:38Z
You are Worker 1 (worker_m1).
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_m1

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md

You MUST read the project blueprint at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\PROJECT.md

Read the survey handoff reports:
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_crm\handoff.md
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_tenders\handoff.md
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_books\handoff.md

Your mission:
Implement Milestone 1: Resilient Update & External Sync Architecture (Features F1, F2, F3, F4 in PROJECT.md):
1. **CRM Deals Resilient Store (`userData/crm/deals.json`)**:
   - In `apps/crm/src/shared/types.ts`:
     - Update `Deal` interface with optional `invoiceId?: string`, `invoiceNumber?: string`, `invoicedAt?: string`.
     - Define `DealsStoreEnvelope` interface: `{ version: number, updatedAt: string, deals: Deal[] }`.
   - In `apps/crm/src/main/crm-store.ts`:
     - Define schema version `CURRENT_DEALS_SCHEMA_VERSION = 1`.
     - Implement migration & validation:
       - If input is raw array (v0), migrate to v1 envelope and sanitize each deal.
       - If input is object with version >= 1, validate `deals` array.
       - Field validation: ensure valid `id`, `name` (string fallback), `amount` (finite number >= 0), `stage` (valid `DealStage`), `probability` (clamped 0-100), `createdAt`, `updatedAt`. Preserve any custom attributes including invoice back-references.
       - Atomic persistence: write to `.tmp` file and rename via `renameSync`.
       - Corruption safety: if JSON parsing throws, preserve corrupted content to `.corrupted.bak` instead of silently wiping out data.
       - Export helper functions so external scripts / tests can call them directly in Node.js.
2. **Tenders Resilient Store (`userData/tenders/tenders-data.json`)**:
   - In `apps/tenders/src/shared/types.ts`:
     - Define `TendersData` envelope: `{ version: number, updatedAt: string, activeCompanyId: string, workspaces: CompanyWorkspace[], issuerTemplates: IssuerTemplate[] }`.
   - In `apps/tenders/src/main/tenders-main.ts`:
     - Implement schema versioning, migration (v0 raw object to v1 envelope), validation, and atomic writes (`.tmp` + `renameSync`).
     - Fix external sync with CRM (`syncWithCrm` lines 164-198): read CRM deals using the versioned envelope, safely merge the tender opportunity by ID (update if exists, append if new) without dropping existing deals or breaking the v1 schema envelope, and write back atomically.
3. **Books Resilient Store (`userData/books/books-data.json`)**:
   - In `apps/books/src/shared/types.ts`:
     - Define `BooksDataEnvelope` / versioned `BooksData`: `{ version: number, updatedAt: string, settings: CompanySettings, accounts: Account[], parties: Party[], invoices: Invoice[], journalEntries: JournalEntry[] }`.
   - In `apps/books/src/main/books-main.ts`:
     - Implement schema migration, validation, ensuring core accounts (`acc-bank`, `acc-ar`, `acc-ap`, `acc-sales`, `acc-vat`) and existing invoices/parties are strictly preserved.
     - Atomic file writes (`.tmp` + `renameSync`) and corruption backup.
4. **Verification**:
   - Run `npm run check:brand` (must pass with 0 unauthorized brand occurrences).
   - Run `npm run typecheck` (must pass cleanly across all 22 monorepo packages).
   - Run `npm run build:all` (must compile without error).

File ownership:
You own edits to:
- `apps/crm/src/shared/types.ts`, `apps/crm/src/main/crm-store.ts`
- `apps/tenders/src/shared/types.ts`, `apps/tenders/src/main/tenders-main.ts`
- `apps/books/src/shared/types.ts`, `apps/books/src/main/books-main.ts`

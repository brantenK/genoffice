# Survey Report: Zanostack Tenders & R1/R3 Integration Architecture

**Explorer**: Explorer 2 (`explorer_survey_tenders`)  
**Mission**: Investigate the authoritative codebase and data layer for Zanostack Tenders, schema versioning/migration (R1), and Tenders contract milestone billing in Zano Books (R3).  
**Report Location**: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_survey_tenders\handoff.md`  
**Date**: 2026-09-03  

---

## 1. Observation

### 1.1 Tenders Package Location, Entry Points, and File Layout
- **Package Name & Directory**: `@genoffice/tenders` located at `apps/tenders/` (`package.json:2`).
- **Main Process Entry**: `apps/tenders/src/main/index.ts` re-exports from `apps/tenders/src/main/tenders-main.ts`.
- **Preload Script**: `apps/tenders/src/preload/index.ts`.
- **Renderer Entry**: `apps/tenders/src/renderer/index.html` mounts `apps/tenders/src/renderer/src/main.tsx` which renders `<App />` from `apps/tenders/src/renderer/src/components/App.tsx`.
- **Hosting & Shell Integration**:
  - `apps/shell/src/main/tab-manager.ts:21,301-320`: `TabManager.openTendersTab()` creates a `WebContentsView` via `createTendersView()` from `apps/tenders/src/main/tenders-main.ts` with tab title `'Zanostack Tenders'`.
  - `apps/shell/src/main/index.ts:301-307`:
    ```ts
    configureTendersRuntime({
      preloadPath: join(TENDERS_OUT, 'preload', 'index.js'),
      rendererUrl: process.env.TENDERS_RENDERER_URL,
      rendererFile: join(TENDERS_OUT, 'renderer', 'index.html'),
      openGeneratedPath: (path) => openGeneratedDocument(path),
      onOpenCrm: () => newCrmTab(),
    })
    ```
  - Note: `apps/shell/src/main/index.ts:2944-2951` already has `newBooksTab()` defined, but `onOpenBooks` is **not** currently passed to `configureTendersRuntime`.

### 1.2 `userData/tenders/tenders-data.json` Storage & Persistence Gap
- **Storage Path in Main**: `apps/tenders/src/main/tenders-main.ts:22-28`:
  ```ts
  function getStoragePath(): string {
    const dir = join(app.getPath('userData'), 'tenders')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return join(dir, 'tenders-data.json')
  }
  ```
- **Main IPC Handlers**: `apps/tenders/src/main/tenders-main.ts:39-59`:
  - `TENDERS_CHANNELS.getStoredData`: Reads `getStoragePath()` if it exists, otherwise returns `null`.
  - `TENDERS_CHANNELS.saveStoredData`: Writes `writeFileSync(p, json, 'utf8')`.
- **Renderer Store Disconnect**:
  - `apps/tenders/src/renderer/src/store.ts:175-420`: `useTendersStore` uses Zustand's `persist` middleware configured with `name: 'zanostack-tenders-v1'` to browser `localStorage`.
  - `apps/tenders/src/renderer/src/store.ts` **never calls** `window.tendersApi?.getStoredData()` or `window.tendersApi?.saveStoredData()`.
  - Result: `userData/tenders/tenders-data.json` is never written to or read by the running Tenders UI unless bridged via IPC.

### 1.3 State of Schema Versioning in All Three Applications (R1)
- **CRM (`userData/crm/deals.json`)**:
  - Handled by `apps/crm/src/main/crm-store.ts:20,67,107`.
  - Stores a raw array `Deal[]` with no top-level schema envelope or version field (`this.readJson<Deal[]>('deals.json', [])`).
  - `apps/tenders/src/main/tenders-main.ts:170-194` directly manipulates `deals.json` via raw `readFileSync` and `JSON.parse`.
- **Books (`userData/books/books-data.json`)**:
  - Handled by `apps/books/src/main/books-main.ts:41-63` and `apps/books/src/renderer/src/store.ts:54-79`.
  - Stores raw object `BooksData { settings, accounts, parties, invoices, journalEntries }` without `schemaVersion`.
- **Tenders (`userData/tenders/tenders-data.json`)**:
  - Unstructured string passing in `tenders-main.ts:51`; no validation or version metadata.

### 1.4 Tenders Compliance Workspace and Missing Milestone Support (R3)
- **Compliance Workspace**:
  - Component: `apps/tenders/src/renderer/src/components/Workspace.tsx`.
  - Hosts `RequirementList.tsx` (compliance matrix for mandatory stage 1, functionality stage 2, financial stage 3, and general returnables), `PdfViewer.tsx`, `VaultDrawer.tsx`, and `ReadinessDrawer.tsx`.
  - Header actions (`Workspace.tsx:160-214`): "Re-run gap", "Sheets" (`exportMatrixToSheets`), "Draft Docs" (`draftProposalDoc`), "CRM" (`syncWithCrm`, `openInCrm`), "Bid readiness", "Company vault".
- **Contract Milestones are Missing**:
  - Search across `apps/tenders/src/` for "milestone" returns zero matches.
  - `TenderRecord` (`apps/tenders/src/shared/types.ts:153-171`) contains fields for title, referenceNumber, issuingBody, closingDate, submission logistics, signatureChecks, status, and requirements — but has **no** `milestones` array.
- **Authoritative RFP Reference and Invoice in Zano Books**:
  - `apps/books/src/renderer/src/mock/initialData.ts:100-131`:
    ```ts
    {
      id: 'inv-1',
      invoiceNumber: 'INV-2026-001',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      date: '2026-08-15',
      dueDate: '2026-09-15',
      items: [
        {
          id: 'item-1',
          itemCode: 'VALVE-REFURB',
          description: 'Phase 1 Reservoir Valve Refurbishment per RFP-WTR-2026-04',
          accountId: 'acc-sales',
          accountName: 'Tender & Commercial Contracting Sales',
          qty: 1,
          rate: 126086.96,
          taxRate: 15,
          amount: 126086.96,
        },
      ],
      subtotal: 126086.96,
      taxTotal: 18913.04,
      grandTotal: 145000,
      outstandingAmount: 145000,
      status: 'Unpaid',
      notes: 'Payment due within 30 days of invoice date. Ref: Tender Contract WTR-04',
      tenderReference: 'RFP-WTR-2026-04',
      createdAt: '2026-08-15T09:00:00Z',
      updatedAt: '2026-08-15T09:00:00Z',
    }
    ```
  - `apps/books/src/shared/types.ts:71`: `Invoice` already has `tenderReference?: string`.

### 1.5 Books Integration Gap in Tenders
- `apps/tenders/src/shared/ipc.ts:3-19` has no methods for Books (only `syncWithCrm` and `openInCrm`).
- `apps/tenders/src/main/tenders-main.ts:7-13` lacks `onOpenBooks?: (invoiceId?: string) => void` in `TendersRuntimeConfig`.

---

## 2. Logic Chain

1. **R1 Requirement Analysis**:
   - `ORIGINAL_REQUEST.md` R1 specifies: "Implement schema versioning, validation, and safe data migration for all 3 applications (userData/crm/deals.json, userData/tenders/tenders-data.json, and userData/books/books-data.json)".
   - Observations 1.2 and 1.3 demonstrate that currently `deals.json` is a bare array `Deal[]`, `books-data.json` is an unversioned `BooksData` object, and `tenders-data.json` is an unvalidated string store currently uncalled by the renderer store.
   - Therefore, a common envelope or backward-compatible migration schema is required:
     - CRM: migrate bare `Deal[]` to `{ version: 1, updatedAt: string, deals: Deal[] }` while ensuring read/write operations can handle both old array format and new versioned object format without data loss.
     - Tenders: structure `userData/tenders/tenders-data.json` as `{ version: 1, updatedAt: string, activeCompanyId: string, workspaces: CompanyWorkspace[], issuerTemplates: IssuerTemplate[] }` and bridge `useTendersStore` with `tendersApi.getStoredData()` / `saveStoredData()`.
     - Books: migrate bare `BooksData` to `{ version: 1, updatedAt: string, ...BooksData }` ensuring core accounts (`acc-bank`, `acc-sales`) and invoices are preserved.
     - Safe merge: external sync calls (like Tenders writing to CRM or Books) must update existing records by ID or append new records without overwriting the entire file or dropping existing items.

2. **R3 Requirement Analysis**:
   - `ORIGINAL_REQUEST.md` R3 specifies: "Add a 'Bill Milestone in Zano Books' action in Zanostack Tenders. When a tender contract or project milestone is reached, it generates a tax invoice in Books linked to the tender's reference number (RFP-WTR-2026-04), issuing authority, and milestone progress amount."
   - Observation 1.4 confirms that `TenderRecord` has no `milestones` field and the workspace has no milestone UI.
   - Observation 1.4 also shows that Books' existing mock invoice `INV-2026-001` already establishes the canonical pattern:
     - Tender Reference: `RFP-WTR-2026-04`
     - Issuing Authority: `City of Ekurhuleni Water Dept`
     - Milestone Description: `Phase 1 Reservoir Valve Refurbishment per RFP-WTR-2026-04`
     - Progress Amount: R 145,000.00 (R 126,086.96 + 15% VAT).
   - Therefore, Tenders must:
     1. Define `ContractMilestone` interface in `apps/tenders/src/shared/types.ts` (`id`, `title`, `description`, `amount`, `status: 'PENDING' | 'REACHED' | 'BILLED'`, `dueDate`, `completedDate`, `billedInvoiceId`, `billedDate`).
     2. Add `milestones?: ContractMilestone[]` to `TenderRecord`.
     3. Provide seed/default tender data for `RFP-WTR-2026-04` with a reached milestone ready for billing.
     4. Add a "Contract Milestones" section or drawer in `Workspace.tsx` displaying milestone status and progress amount.
     5. For reached milestones, display a `"Bill Milestone in Zano Books"` button.
     6. Implement `tendersApi.billMilestoneInBooks()` which writes a new Sales Invoice to `userData/books/books-data.json`, marks the milestone as `BILLED` with the invoice ID, and calls `openInBooks()` to activate the Books tab in the Shell.

---

## 3. Caveats

1. **Electron Shell Tab Switching**:
   - Tab switching in the Shell is owned by `TabManager` (`apps/shell/src/main/tab-manager.ts`).
   - For Tenders to activate Books, `apps/shell/src/main/index.ts` must wire `onOpenBooks: () => newBooksTab()` into `configureTendersRuntime`, and `openInBooks` IPC must trigger that callback.
2. **Headless Execution vs Desktop UI**:
   - The test script `tools/verify-suite-workflows.mjs` must be able to execute programmatic verification in Node.js without requiring a full Electron desktop window to be launched. Hence, the migration, schema validation, and cross-store data mutation functions must be exported as pure modules callable from Node.js scripts as well as Electron IPC.

---

## 4. Conclusion & Actionable Blueprint

### Required File Changes for R1 & R3:

1. **`apps/tenders/src/shared/types.ts`**:
   - Add `ContractMilestone` interface.
   - Update `TenderRecord` with `milestones?: ContractMilestone[]`.
   - Define `TendersData` schema envelope:
     ```ts
     export interface TendersData {
       version: number
       updatedAt: string
       activeCompanyId: string
       workspaces: CompanyWorkspace[]
       issuerTemplates: IssuerTemplate[]
     }
     ```

2. **`apps/tenders/src/shared/ipc.ts` & `apps/tenders/src/preload/index.ts`**:
   - Add channels `billMilestoneInBooks: 'tenders:bill-milestone-in-books'` and `openInBooks: 'tenders:open-in-books'`.
   - Update `TendersApi` with:
     ```ts
     billMilestoneInBooks: (data: {
       tenderId: string
       milestoneId: string
       tenderReference: string
       issuingAuthority: string
       milestoneTitle: string
       amount: number
       notes?: string
     }) => Promise<{ ok: boolean; invoiceId?: string; invoiceNumber?: string; error?: string }>
     openInBooks: (invoiceId?: string) => Promise<{ ok: boolean }>
     ```

3. **`apps/tenders/src/main/tenders-main.ts`**:
   - Update `TendersRuntimeConfig` with `onOpenBooks?: (invoiceId?: string) => void`.
   - Implement schema validation, versioning, and migration in `getStoredData` and `saveStoredData`.
   - Implement `TENDERS_CHANNELS.billMilestoneInBooks`:
     - Reads `userData/books/books-data.json`.
     - Validates or adds party for `issuingAuthority`.
     - Appends formatted Sales Invoice linked to `tenderReference` (`RFP-WTR-2026-04`), calculates VAT (15%), sets status `'Unpaid'`.
     - Writes `books-data.json` safely.
     - Updates the tender's milestone status to `'BILLED'` and stores `billedInvoiceId`.
   - Implement `TENDERS_CHANNELS.openInBooks` calling `runtime.onOpenBooks()`.

4. **`apps/shell/src/main/index.ts`**:
   - In `configureTendersRuntime`, provide `onOpenBooks: () => newBooksTab()`.

5. **`apps/tenders/src/renderer/src/store.ts`**:
   - Support loading/saving `tenders-data.json` via IPC on startup and store mutations.
   - Provide seed tender for `RFP-WTR-2026-04` (Water Reticulation Project, issuing authority "City of Ekurhuleni Water Dept", milestone "Phase 1 Reservoir Valve Refurbishment", amount R 145,000, status "REACHED").
   - Add store action `billMilestone(tenderId: string, milestoneId: string)`.

6. **`apps/tenders/src/renderer/src/components/Workspace.tsx`**:
   - Add a "Milestones" drawer or section to the compliance workspace header and sidebar.
   - Display milestones with status badges ("Reached", "Billed", "Pending").
   - Include the `"Bill Milestone in Zano Books"` button for reached milestones.
   - On click, trigger billing and switch to Books tab.

7. **Verification Script**:
   - Implement `tools/verify-suite-workflows.mjs` verifying:
     1. CRM deal -> Books invoice generation.
     2. Tenders milestone -> Books tax invoice generation with `RFP-WTR-2026-04` and `City of Ekurhuleni Water Dept`.
     3. Bank statement CSV parsing and reconciliation into `acc-bank`.
     4. R1 schema versioning & migration resilience across all 3 data files.

---

## 5. Verification Method

To verify these findings and future implementation:
1. **Brand Check**:
   ```powershell
   npm run check:brand
   ```
   Must pass with 0 unauthorized upstream brand occurrences.
2. **Typecheck**:
   ```powershell
   npm run typecheck
   ```
   Verified: Passes cleanly across all 22 monorepo packages with exit code 0 (`@genoffice/i18n`, `@genoffice/electron-utils`, `@genoffice/font-metrics`, `@genoffice/docx-engine`, `@genoffice/pdf2docx`, `@genoffice/file-parse`, `@genoffice/pptx-engine`, `@genoffice/pptx-render`, `@genoffice/ai-search`, `@genoffice/agent-core`, `@genoffice/ai-provider`, `@genoffice/project-store`, `@genoffice/ui`, `@genoffice/docs`, `@genoffice/sheets`, `@genoffice/shell`, `@genoffice/slides`, `@genoffice/pdf`, `@genoffice/markdown`, `@genoffice/crm`, `@genoffice/tenders`, `@genoffice/books`).
3. **Build**:
   ```powershell
   npm run build:all
   ```
   Must build all 9 apps cleanly.
4. **Automated End-to-End Suite Script**:
   ```powershell
   node tools/verify-suite-workflows.mjs
   ```
   Must test CRM -> Books, Tenders -> Books, and Bank reconciliation, exiting with code 0.

# Handoff Report: Zanostack CRM & R1/R2 Architecture Survey

**Agent**: Explorer 1 (`explorer_survey_crm`)  
**Mission**: Authoritative investigation of Zanostack CRM data layer, UI, inter-app communication, and integration points for Requirements R1 (resilient data & schema versioning) and R2 (CRM -> Zano Books 1-click invoicing).  
**Report Target**: `.agents/explorer_survey_crm/handoff.md`  
**Timestamp**: 2026-09-03T13:08:00Z  

---

## 1. Observation

### 1.1 Monorepo Layout and CRM Package Structure
- **Root Package Configuration**: `package.json` defines npm workspaces:
  - Lines 15–18: `"workspaces": ["apps/*", "packages/*"]`
  - There are 22 total packages checked in `npm run typecheck` (Line 30):
    - 9 apps: `docs`, `sheets`, `slides`, `pdf`, `markdown`, `crm`, `tenders`, `books`, `shell`.
    - 13 packages: `i18n`, `electron-utils`, `font-metrics`, `docx-engine`, `pdf2docx`, `file-parse`, `pptx-engine`, `pptx-render`, `ai-search`, `agent-core`, `ai-provider`, `project-store`, `ui`.
- **CRM Package Location**: `apps/crm/`
  - `apps/crm/package.json`:
    - Line 2: `"name": "@genoffice/crm"`
    - Line 3: `"productName": "Zanostack CRM"`
    - Line 8: `"main": "out/main/index.js"`
    - Lines 9–14:
      ```json
      "scripts": {
        "dev": "electron-vite dev",
        "dev:renderer": "vite --config vite.renderer.config.ts",
        "build": "electron-vite build",
        "typecheck": "tsc --noEmit"
      }
      ```
  - Dev dependencies include `@genoffice/docx-engine`, `@genoffice/electron-utils`, `@genoffice/i18n`, `@genoffice/project-store`, `@genoffice/ui`, `react` (v19.2.4), `react-dom`, `typescript` (v5.9.3), `electron` (v43.3.0), `electron-vite` (v5.0.0), `vite` (v7.3.1).
- **Source Layout of CRM**:
  - `apps/crm/src/main/`:
    - `index.ts`: Re-exports `./crm-main`, `./crm-store`, `./seed-data`.
    - `crm-main.ts`: IPC registration (`registerCrmIpc`), runtime config (`configureCrmRuntime`), view creation (`createCrmView`: WebContentsView).
    - `crm-store.ts`: File-backed storage class `CrmStore` for `deals.json`, `contacts.json`, `companies.json`, `activities.json`.
    - `seed-data.ts`: Default seed entities (`SEED_DEALS`, `SEED_CONTACTS`, `SEED_COMPANIES`, `SEED_ACTIVITIES`).
  - `apps/crm/src/preload/`:
    - `index.ts`: Exposes `window.crmApi` via `contextBridge.exposeInMainWorld('crmApi', crmApi)`.
  - `apps/crm/src/shared/`:
    - `types.ts`: TypeScript interfaces for `Deal`, `DealStage`, `Contact`, `Company`, `Activity`, `CrmStats`.
    - `ipc.ts`: Channel name constants (`CRM_CHANNELS`) and API signature (`CrmApi`).
  - `apps/crm/src/renderer/`:
    - `index.html`: Web entry point.
    - `src/main.tsx`: React entry point mounting `<App />` into `#root`.
    - `src/App.tsx`: Main CRM application layout, navigation state, data loading, and modal state management.
    - `src/components/`: `DealsTableView.tsx`, `PipelineView.tsx`, `DealModal.tsx`, `ContactsView.tsx`, `ContactModal.tsx`, `CompaniesView.tsx`, `CompanyModal.tsx`, `AnalyticsView.tsx`, `Icons.tsx`.
    - `src/styles/crm.css`: UI stylesheets.

### 1.2 CRM Data Storage (`userData/crm/deals.json`)
- **Storage Location**:
  - `apps/crm/src/main/crm-store.ts`:
    - Lines 10–13: `this.baseDir = join(userDataDir, 'crm')`
    - In dev mode, `userDataDir` is evaluated by `apps/shell/src/main/index.ts` lines 214–217:
      `process.env.GENOFFICE_USER_DATA ?? join(app.getPath('appData'), 'Zanostack Dev')`
    - Directly verified existing live file on disk:
      `C:\Users\brant\AppData\Roaming\Zanostack Dev\crm\deals.json` (Length: 2,458 bytes).
- **Data Shape on Disk**:
  - Currently stored as a flat JSON array of `Deal` objects without envelope metadata:
    ```json
    [
      {
        "id": "deal-1",
        "name": "Global Suite Migration & Deployment",
        "companyId": "comp-1",
        "companyName": "Acme Global Technologies",
        "contactId": "cont-1",
        "contactName": "Sarah Chen",
        "amount": 120000,
        "stage": "negotiation",
        "probability": 85,
        "expectedCloseDate": "2026-10-15",
        "notes": "Final contract terms in review with legal team. Focused on data privacy and local-first execution.",
        "createdAt": "2026-08-09T08:42:00.889Z",
        "updatedAt": "2026-09-01T08:42:00.889Z"
      },
      ...
    ]
    ```
- **Loading & Initialization**:
  - `apps/crm/src/main/crm-store.ts`:
    - Lines 20–23: If `deals.json` does not exist, it writes `SEED_DEALS`.
    - Lines 41–50:
      ```typescript
      private readJson<T>(file: string, fallback: T): T {
        try {
          const p = join(this.baseDir, file)
          if (!existsSync(p)) return fallback
          const content = readFileSync(p, 'utf8')
          return JSON.parse(content) as T
        } catch {
          return fallback
        }
      }
      ```
    - Lines 66–68: `getDeals(): Deal[] { return this.readJson<Deal[]>('deals.json', []) }`
- **Current Absence of Validation and Versioning**:
  - No schema version is tracked (no `version: number`).
  - No field-level validation: missing IDs, invalid numbers, unexpected strings, or unparseable dates are neither sanitized nor rejected.
  - If JSON parsing fails (e.g., partial write or syntax error), `readJson` returns `[]`, risking permanent silent overwrite of user deals upon the next write.
- **Mutation & External Sync Defect**:
  - `CrmStore.saveDeal` (`crm-store.ts` lines 70–109): Uses atomic write via temporary file (`.tmp` + `renameSync`).
  - **External Write Bypass**: In `apps/tenders/src/main/tenders-main.ts` lines 164–198 (`syncWithCrm`):
    - Lines 174–176: Directly reads `userData/crm/deals.json` and parses as raw array.
    - Lines 192–193: Unshifts new deal and directly writes back using `writeFileSync(crmDealsPath, JSON.stringify(deals, null, 2), 'utf8')`.
    - This bypasses `CrmStore`, assumes naked array format, lacks atomic safety, and will corrupt or overwrite if schema migration changes the root structure without backward compatibility.

### 1.3 UI for CRM Deals & Won Opportunity Identification
- **Deals Table**: `apps/crm/src/renderer/src/components/DealsTableView.tsx`
  - Renders a filterable table of opportunities.
  - Line 83–187: Iterates over `filtered` deals.
  - Lines 150–183: Action column renders:
    - `Proposal` button -> calls `onGenerateProposal(deal.id)` (creates proposal doc).
    - `Tenders` button -> calls `window.crmApi?.openTenders()` (switches to Tenders tab).
    - Edit deal button -> opens `DealModal`.
    - Delete deal button -> prompts confirm and deletes.
  - **Missing**: There is currently NO "Create Invoice in Zano Books" button or linked invoice status in `DealsTableView`.
- **Deal Details / Modal**: `apps/crm/src/renderer/src/components/DealModal.tsx`
  - Modal form for creating/editing deals.
  - Form fields: Name, Amount, Stage, Company, Contact, Expected Close Date, Notes.
  - **Missing**: There is currently NO action to generate a Books invoice or view linked invoice reference.
- **Pipeline / Board View**: `apps/crm/src/renderer/src/components/PipelineView.tsx`
  - Kanban columns: `lead`, `qualified`, `proposal`, `negotiation`, `won`, `lost`.
  - Popover menu has Move Stage, Create Proposal, View in Tenders, Edit, Delete.
- **Won Opportunities Identification**:
  - `DealStage` enum: `'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'` (`apps/crm/src/shared/types.ts` lines 1–7).
  - Won opportunity check: `deal.stage === 'won'`.
  - When stage is `'won'`, `probability` is set to `100` (`crm-store.ts` line 118).
  - `SEED_DEALS` contains a won deal: `deal-3` ("Clean Tech Analytics Pipeline", company: "Helios Clean Energy", amount: 85,000, stage: `'won'`).

### 1.4 Shell Tab Switching & Inter-App Communication
- **Shell Hosting Architecture**:
  - `apps/shell/src/main/tab-manager.ts` manages all tabs in the single BrowserWindow.
  - Lines 280–341:
    - `openCrmTab()`: Activates existing tab if open; otherwise creates view via `createCrmView()` and adds to tab strip.
    - `openTendersTab()`: Opens or activates Tenders tab.
    - `openBooksTab()`: Opens or activates Books tab (`kind: 'books'`, title: `'Zano Books'`).
  - Lines 343–351: `activateTab(id: string)`:
    - Hides all other WebContentsViews (`view.setVisible(false)`).
    - Sets active view visible and positions at `{ x: 0, y: TAB_STRIP_HEIGHT, width, height }`.
- **Cross-App Communication Wiring**:
  - `apps/shell/src/main/index.ts` lines 294–315:
    ```typescript
    configureCrmRuntime({
      preloadPath: join(CRM_OUT, 'preload', 'index.js'),
      rendererUrl: process.env.CRM_RENDERER_URL,
      rendererFile: join(CRM_OUT, 'renderer', 'index.html'),
      openGeneratedPath: (path) => openGeneratedDocument(path),
      onOpenTenders: () => newTendersTab(),
    })
    configureBooksRuntime({
      preloadPath: join(BOOKS_OUT, 'preload', 'index.js'),
      rendererUrl: process.env.BOOKS_RENDERER_URL,
      rendererFile: join(BOOKS_OUT, 'renderer', 'index.html'),
      openGeneratedPath: (path) => openGeneratedDocument(path),
      onOpenCrm: () => newCrmTab(),
      onOpenTenders: () => newTendersTab(),
    })
    ```
  - **Missing**:
    - `CrmRuntimeConfig` in `apps/crm/src/main/crm-main.ts` does NOT have `onOpenBooks?: () => void`.
    - `configureCrmRuntime` in `apps/shell/src/main/index.ts` does NOT wire `onOpenBooks: () => newBooksTab()`.
    - `CRM_CHANNELS` in `apps/crm/src/shared/ipc.ts` lacks `openBooks` or `createInvoiceInBooks`.

### 1.5 Zano Books Data Layer & Invoicing Architecture
- **Books Storage**: `userData/books/books-data.json` (`apps/books/src/main/books-main.ts` line 29).
- **Books Invoice Model**: `apps/books/src/shared/types.ts` lines 56–75:
  ```typescript
  export interface Invoice {
    id: string
    invoiceNumber: string
    type: InvoiceType // 'Sales' | 'Purchase'
    partyId: string
    partyName: string
    date: string
    dueDate: string
    items: InvoiceItem[]
    subtotal: number
    taxTotal: number
    grandTotal: number
    outstandingAmount: number
    status: InvoiceStatus // 'Draft' | 'Unpaid' | 'Paid' | 'Overdue' | 'Cancelled'
    notes?: string
    tenderReference?: string
    crmDealId?: string // <--- Already modelled on Invoice!
    createdAt: string
    updatedAt: string
  }
  ```
- **Books Store Double-Entry Behavior**:
  - `apps/books/src/renderer/src/store.ts` lines 81–224 (`saveInvoice`):
    - Automatically updates Party's `outstandingBalance`.
    - For new `Sales` invoices (status != 'Draft'):
      - Credits `acc-sales` (Tender & Commercial Contracting Sales) by `subtotal`.
      - Credits `acc-vat` (SARS VAT Output Payable) by `taxTotal`.
      - Debits `acc-ar` (Accounts Receivable) by `grandTotal`.
      - Automatically generates and appends a balanced `JournalEntry` (`JE-2026-xxx`).

### 1.6 Verification & Build Tooling
- **Brand Check**:
  - `node fork/tools/check-brand.mjs` (`npm run check:brand`)
  - Ran command directly: Exited 0 with message:
    `✅ Brand check passed: Zero unauthorized upstream brand occurrences found.`
- **Typecheck**:
  - Ran `npm run typecheck -w @genoffice/crm`: Exited 0 cleanly (`tsc --noEmit`).
- **Build**:
  - Ran `npm run build -w @genoffice/crm`: Exited 0 cleanly (`electron-vite build`).
- **Test Suites**:
  - Neither `apps/crm`, `apps/books`, nor `apps/tenders` currently contains local vitest test suites (checked via `find_by_name`).
  - Acceptance criteria requires `tools/verify-suite-workflows.mjs` to run end-to-end integration tests for CRM -> Books, Tenders -> Books, and bank reconciliation.

---

## 2. Logic Chain

### 2.1 Logic Chain for Requirement R1 (Resilient Data Layer & Schema Migration)
1. **Premise**: `userData/crm/deals.json` currently stores raw JSON arrays without schema versioning or validation (Obs 1.2). External apps (like Tenders in Obs 1.2) write directly to the file without using `CrmStore` methods.
2. **Failure Mode 1 (Data Corruption on Parse Error)**: In `crm-store.ts` line 41–50, a malformed JSON file immediately returns `fallback` (`[]`). If any save operation follows, the user's entire pipeline of deals is wiped clean.
3. **Failure Mode 2 (External Sync Breakage)**: If schema versioning introduces a wrapped root object (e.g. `{ version: 1, deals: [...] }`) without handling legacy arrays, `tenders-main.ts` line 175 (`deals = Array.isArray(parsed) ? parsed : []`) will either crash or overwrite the wrapper with a flat array.
4. **Resolution Architecture**:
   - Create a robust schema definition and normalization layer:
     - Detect payload shape:
       - **Legacy (v0)**: `Array.isArray(raw)` -> normalize to array of validated deals.
       - **Versioned (v1)**: `raw && typeof raw === 'object' && Array.isArray(raw.deals)` -> read deals and version.
     - Validate individual Deal records against required fields (`id`, `name`, `amount`, `stage`), providing deterministic fallbacks for missing/malformed attributes.
     - Coerce data safely (e.g., ensure `amount >= 0`, `stage` in valid set, `probability` within [0, 100]).
     - Preserve arbitrary future/custom attributes (including `invoiceId`, `invoiceNumber`, `invoicedAt`) by spreading sanitized objects.
     - Save atomically to `.tmp` with `renameSync`. If read encounters corrupted JSON, preserve a `.corrupted.bak` file before writing.
   - Update `apps/tenders/src/main/tenders-main.ts` (`syncWithCrm`) to read and write deals following the normalized versioned schema.

### 2.2 Logic Chain for Requirement R2 (CRM -> Zano Books 1-Click Invoicing)
1. **Premise**: When a deal reaches stage `'won'` in Zanostack CRM, the user needs a 1-click action to create a sales invoice in Zano Books with the customer counterparty, deal valuation, line-item description, payment terms, and back-reference onto the deal, switching to the Books tab (Obs 1.1, Obs 1.3, Obs 1.4).
2. **Deal Identification**:
   - A deal is eligible when `deal.stage === 'won'`.
   - If the deal already has `invoiceNumber` / `invoiceId`, it should display a badge/button linking to the existing invoice in Books.
3. **Data Mapping from CRM Deal to Zano Books Invoice**:
   - `deal.companyName || deal.name` -> `partyName` (and match/create `Party` in `userData/books/books-data.json`).
   - `deal.amount` -> `grandTotal` (valuation).
     - Standard tax handling: matching Books convention (15% VAT): `subtotal = Math.round((deal.amount / 1.15) * 100) / 100`, `taxTotal = Math.round((deal.amount - subtotal) * 100) / 100`.
   - `deal.name + " - Commercial Implementation & Delivery"` -> `items[0].description`.
   - `deal.notes` / default terms -> `notes` ("Payment terms: Net 30 days upon invoice receipt.").
   - `deal.id` -> `invoice.crmDealId` (already present on `Invoice` interface, Obs 1.5).
   - Generated `invoice.invoiceNumber` (e.g. `INV-2026-004`) -> saved back onto `deal.invoiceNumber` and `deal.invoiceId` in `deals.json`.
4. **Accounting Integrity in Books**:
   - Creating an invoice directly in `userData/books/books-data.json` must update:
     - `invoices`: Append the new `Invoice`.
     - `parties`: Increase party `outstandingBalance` by `grandTotal`.
     - `accounts`: Update balances for `acc-ar` (+grandTotal), `acc-sales` (+subtotal), and `acc-vat` (+taxTotal).
     - `journalEntries`: Create corresponding `JournalEntry` debiting `acc-ar` and crediting `acc-sales` & `acc-vat` (matching `apps/books/src/renderer/src/store.ts`).
5. **Tab Activation**:
   - CRM main process calls `runtime.onOpenBooks?.()` which calls `newBooksTab()` in `apps/shell/src/main/index.ts`.
   - `tabManager.openBooksTab()` activates the Books WebContentsView and reveals it immediately.
6. **UI Affordances**:
   - `DealsTableView.tsx`: In row actions for won deals, render a pill button `Invoice in Books`. If already invoiced, render `INV-XXXX` pill that navigates to Books.
   - `DealModal.tsx`: When editing a won deal, render an Invoicing section showing invoice status or "Create Invoice in Zano Books" action button.

---

## 3. Caveats

1. **Active Books Renderer State Synchronization**:
   - If Zano Books is already running in a tab when CRM creates an invoice in `userData/books/books-data.json`, Books' in-memory Zustand store might hold stale data until reloaded.
   - *Mitigation*: The Books view WebContents can be sent an IPC event (e.g., `books:reload-data`) or reloaded upon activation so the new invoice is immediately visible in the UI without restarting the application.
2. **Missing `userData/books/books-data.json` on First Run**:
   - As observed (Obs 1.6), `Zanostack Dev/books/books-data.json` is not created until Books has been opened and saved once.
   - If CRM creates an invoice before Books was ever opened, the creation logic MUST initialize `books-data.json` using `initialBooksData` (including Chart of Accounts and settings) rather than writing an empty skeleton, preventing loss of standard accounts.
3. **Currency Discrepancy**:
   - CRM displays amounts in USD format (`$85,000`), whereas Zano Books defaults to South African Rand (`R 85,000.00`, 15% VAT).
   - Numerical values map directly (1:1 float valuation), and line items reflect standard VAT calculation.
4. **Read-Only Investigation Scope**:
   - In accordance with the Explorer archetype and Key Constraints, this phase made zero modifications to the product source code or data stores. All proposed code paths and changes are documented in Section 4.

---

## 4. Conclusion & Actionable Blueprint

### 4.1 Required Changes for R1: `deals.json` Schema Versioning & Validation
1. **`apps/crm/src/shared/types.ts`**:
   - Extend `Deal` interface to include optional invoice back-reference fields:
     ```typescript
     export interface Deal {
       id: string
       name: string
       companyId?: string
       companyName?: string
       contactId?: string
       contactName?: string
       amount: number
       stage: DealStage
       probability: number
       expectedCloseDate?: string
       notes?: string
       invoiceId?: string
       invoiceNumber?: string
       invoicedAt?: string
       createdAt: string
       updatedAt: string
     }

     export interface DealsStoreEnvelope {
       version: number
       updatedAt: string
       deals: Deal[]
     }
     ```
2. **`apps/crm/src/main/crm-store.ts`**:
   - Add schema version constant `CURRENT_DEALS_SCHEMA_VERSION = 1`.
   - Implement `validateAndMigrateDeals(raw: unknown): { version: number; deals: Deal[] }`:
     - If raw is array, treat as v0, validate each item, upgrade to v1 envelope.
     - If raw is object with `version >= 1`, validate `deals` array.
     - Validate Deal attributes:
       - Ensure `id` (or assign `deal-${randomUUID().slice(0, 8)}`), `name` (string, fallback 'Untitled Opportunity'), `amount` (finite number >= 0), `stage` (one of valid `DealStage`), `probability` (clamped 0–100), `createdAt`, `updatedAt`.
       - Preserve `invoiceId`, `invoiceNumber`, `invoicedAt`, and any custom properties.
     - On read error, backup existing file to `.corrupted.bak` before returning default to avoid silent data destruction.
   - Update `getDeals()` to return `Deal[]` from the validated envelope.
   - Update `saveDeal`, `updateDealStage`, `deleteDeal` to write the versioned envelope atomically via `.tmp` and `renameSync`.
3. **`apps/tenders/src/main/tenders-main.ts`**:
   - Update `syncWithCrm` (line 164–198) to read and write `deals.json` using the versioned envelope format, ensuring external sync requests merge cleanly without overwriting the schema.

### 4.2 Required Changes for R2: CRM -> Zano Books Invoicing Automation
1. **`apps/crm/src/shared/ipc.ts`**:
   - Add to `CRM_CHANNELS`:
     ```typescript
     createInvoiceInBooks: 'crm:create-invoice-in-books',
     openBooks: 'crm:open-books',
     ```
   - Add to `CrmApi`:
     ```typescript
     createInvoiceInBooks(dealId: string): Promise<{ ok: boolean; invoiceNumber?: string; error?: string }>
     openBooks(): Promise<boolean>
     ```
2. **`apps/crm/src/preload/index.ts`**:
   - Expose `createInvoiceInBooks: (dealId: string) => ipcRenderer.invoke(CRM_CHANNELS.createInvoiceInBooks, dealId)`
   - Expose `openBooks: () => ipcRenderer.invoke(CRM_CHANNELS.openBooks)`
3. **`apps/crm/src/main/crm-main.ts`**:
   - Add `onOpenBooks?: () => void` to `CrmRuntimeConfig`.
   - Register handler for `CRM_CHANNELS.openBooks`: calls `runtime.onOpenBooks?.()`.
   - Register handler for `CRM_CHANNELS.createInvoiceInBooks`:
     - Load deal via `s.getDeals().find(d => d.id === dealId)`. Verify deal exists and `stage === 'won'`.
     - Read or seed `userData/books/books-data.json`.
     - Find or create customer party in Books matching `deal.companyName`.
     - Generate next sales invoice number `INV-${year}-${count}`.
     - Compute subtotal, VAT (15%), grandTotal (`deal.amount`).
     - Create `Invoice` object with `crmDealId: deal.id`, line-item description (`${deal.name} - Commercial Implementation & Services`), payment terms (`Net 30 days upon invoice receipt`).
     - Update Books double-entry accounts (`acc-ar`, `acc-sales`, `acc-vat`) and post `JournalEntry`.
     - Save `books-data.json` atomically.
     - Update CRM deal with `invoiceId: invoice.id`, `invoiceNumber: invoice.invoiceNumber`, `invoicedAt: new Date().toISOString()`.
     - Call `runtime.onOpenBooks?.()` to activate the Books tab in the shell.
     - Return `{ ok: true, invoiceNumber: invoice.invoiceNumber }`.
4. **`apps/shell/src/main/index.ts`**:
   - In `configureCrmRuntime`, provide `onOpenBooks: () => newBooksTab()`.
5. **CRM UI Components**:
   - `DealsTableView.tsx`:
     - For won deals (`deal.stage === 'won'`):
       - If `deal.invoiceNumber`: render a pill button `[📄 ${deal.invoiceNumber}]` that activates Books tab.
       - Else: render action button `[⚡ Invoice in Books]` that triggers `crmApi.createInvoiceInBooks(deal.id)`.
   - `DealModal.tsx`:
     - When `stage === 'won'`, render invoicing section with 1-click `Create Invoice in Zano Books` or link to existing invoice.
   - `App.tsx`:
     - Provide toast notification: "Invoice {invoiceNumber} created in Zano Books".

---

## 5. Verification Method

### 5.1 Independent Reproduction Commands
1. **Brand Trademark Check**:
   ```bash
   npm run check:brand
   ```
   *Expected*: Passes with 0 unauthorized upstream brand occurrences.
2. **Full Monorepo Typecheck (All 22 Packages)**:
   ```bash
   npm run typecheck
   ```
   *Expected*: Passes across all 22 packages with zero TypeScript compilation errors.
3. **CRM App Build**:
   ```bash
   npm run build -w @genoffice/crm
   ```
   *Expected*: Compiles main, preload, and renderer bundles into `apps/crm/out` without error.
4. **Automated Suite Workflows Verification Script** (`tools/verify-suite-workflows.mjs`):
   ```bash
   node tools/verify-suite-workflows.mjs
   ```
   *Verification Criteria*:
   - Programmatically simulates CRM deal transition to won stage.
   - Executes invoice creation bridge.
   - Reads `userData/books/books-data.json` and asserts:
     - New sales invoice exists with matching `partyName`, `grandTotal === deal.amount`, `crmDealId === deal.id`.
     - Accounts Receivable (`acc-ar`) and Sales Revenue (`acc-sales`) ledger balances reflect the invoice amount.
     - A matching journal entry is posted.
   - Reads `userData/crm/deals.json` and asserts:
     - Versioned envelope `{ version: 1, deals: [...] }` exists.
     - Won deal records `invoiceNumber` and `invoiceId`.
     - External sync update from Tenders preserves existing deals and schema version.
   - Script exits with code 0.

### 5.2 Invalidation Conditions
- If any change causes `npm run check:brand` to fail.
- If `deals.json` loses user entries when an external sync request from Tenders or another process executes.
- If creating an invoice in Books fails to record `crmDealId` on the invoice or `invoiceNumber` back on the CRM deal.
- If clicking "Create Invoice in Zano Books" fails to switch the shell tab to Zano Books.

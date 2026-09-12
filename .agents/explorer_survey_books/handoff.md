# Zano Books Architecture & Interoperability Survey (R1–R4)

## Observation

### 1. Package Location, Entry Points, and Monorepo Layout
- **Package path**: `apps/books`
- **Package manifest**: `apps/books/package.json`
  - Name: `@genoffice/books`, Product Name: `Zano Books`, Version: `0.1.0`.
  - Scripts: `"dev": "electron-vite dev"`, `"dev:renderer": "vite --config vite.renderer.config.ts"`, `"build": "electron-vite build"`, `"typecheck": "tsc --noEmit"`.
  - Dependencies: `clsx: ^2.1.1`, `lucide-react: ^1.38.0`, `zustand: ^5.0.15`.
- **Main Process**:
  - `apps/books/src/main/index.ts` re-exports from `books-main.ts`.
  - `apps/books/src/main/books-main.ts` defines `configureBooksRuntime`, `registerBooksIpc`, `getStoragePath`, and `createBooksView`:
    ```ts
    function getStoragePath(): string {
      const dir = join(app.getPath('userData'), 'books')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      return join(dir, 'books-data.json')
    }
    ```
    IPC channels registered in `registerBooksIpc()`:
    - `BOOKS_CHANNELS.loadData`: Reads `books-data.json` if exists, returns `JSON.parse` or `null`.
    - `BOOKS_CHANNELS.saveData`: Directly writes `writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')`.
    - `BOOKS_CHANNELS.exportToSheets`: Exports CSV report to temp dir and calls `runtime.openGeneratedPath`.
    - `BOOKS_CHANNELS.openInPdf`: Generates markdown tax invoice and calls `runtime.openGeneratedPath`.
    - `BOOKS_CHANNELS.openInCrm` / `openInTenders`: Delegates to runtime callbacks.
- **Preload**:
  - `apps/books/src/preload/index.ts` exposes `window.booksApi` with methods `loadData`, `saveData`, `exportToSheets`, `openInPdf`, `openInCrm`, `openInTenders`.
- **Renderer & State Management**:
  - `apps/books/src/renderer/index.html` loads `src/main.tsx`.
  - `apps/books/src/renderer/src/main.tsx` renders `<Desk />` (`apps/books/src/renderer/src/components/Desk.tsx`).
  - Store: `apps/books/src/renderer/src/store.ts` contains `useBooksStore` (Zustand). State includes:
    `activeTab`, `data` (`BooksData`), `activeInvoiceId`, `invoiceStatusFilter`, `activeReport`, `printInvoice`, `searchTerm`.
    Store actions: `setActiveTab`, `setActiveInvoiceId`, `setInvoiceStatusFilter`, `setActiveReport`, `setPrintInvoice`, `setSearchTerm`, `loadData`, `saveInvoice`, `markInvoicePaid`, `deleteInvoice`, `addParty`, `addJournalEntry`, `persist`.
  - Mock/Seed data: `apps/books/src/renderer/src/mock/initialData.ts` exports `initialBooksData: BooksData`.
- **Shell Integration**:
  - `apps/shell/src/main/index.ts` lines 308–315 configure Books runtime:
    ```ts
    configureBooksRuntime({
      preloadPath: join(BOOKS_OUT, 'preload', 'index.js'),
      rendererUrl: process.env.BOOKS_RENDERER_URL,
      rendererFile: join(BOOKS_OUT, 'renderer', 'index.html'),
      openGeneratedPath: (path) => openGeneratedDocument(path),
      onOpenCrm: () => newCrmTab(),
      onOpenTenders: () => newTendersTab(),
    })
    ```
  - `apps/shell/src/main/tab-manager.ts` lines 322–341:
    `openBooksTab(): string` creates or activates a tab with `kind: 'books'`, view: `createBooksView()`, title: `'Zano Books'`.
  - `apps/shell/src/main/index.ts` line 214–217 sets `userData` path:
    ```ts
    if (!app.isPackaged)
      app.setPath(
        'userData',
        process.env.GENOFFICE_USER_DATA ?? join(app.getPath('appData'), 'Zanostack Dev'),
      )
    ```

---

### 2. Data Structure & Storage (`userData/books/books-data.json`)
- **Type Definitions** (`apps/books/src/shared/types.ts` lines 110–116):
  ```ts
  export interface BooksData {
    settings: CompanySettings
    accounts: Account[]
    parties: Party[]
    invoices: Invoice[]
    journalEntries: JournalEntry[]
  }
  ```
- **Chart of Accounts (specifically `acc-bank`)**:
  - `acc-bank` is defined in `initialBooksData` (`apps/books/src/renderer/src/mock/initialData.ts` line 18):
    ```ts
    {
      id: 'acc-bank',
      name: 'FNB Business Cheque Account',
      rootType: 'Asset',
      accountType: 'Bank',
      parentId: 'acc-curr-asset',
      isGroup: false,
      balance: 485250
    }
    ```
  - Other key double-entry accounts in `initialBooksData`:
    - `acc-ar`: Accounts Receivable (Debtors), rootType: `Asset`, balance: `195500`.
    - `acc-ap`: Accounts Payable (Creditors), rootType: `Liability`, balance: `74200`.
    - `acc-sales`: Tender & Commercial Contracting Sales, rootType: `Income`, balance: `820000`.
    - `acc-vat`: SARS VAT Output Payable, rootType: `Liability`, balance: `38400`.
    - `acc-materials`: Direct Project Materials & Subcontractors, rootType: `Expense`, balance: `345000`.
- **Double-entry Flow in Store**:
  - `saveInvoice` (`apps/books/src/renderer/src/store.ts` lines 149–210):
    When a non-draft Sales invoice is posted:
    - `acc-ar.balance += grandTotal`
    - `acc-vat.balance += taxTotal`
    - `acc-sales.balance += subtotal`
    - Creates `JournalEntry`: Debit `acc-ar`, Credit `acc-sales`, Credit `acc-vat`.
  - `markInvoicePaid` (`apps/books/src/renderer/src/store.ts` lines 244–258):
    ```ts
    const nextAccounts = data.accounts.map((acc) => {
      if (acc.id === 'acc-bank') {
        const adjustment = target.type === 'Sales' ? target.grandTotal : -target.grandTotal
        return { ...acc, balance: acc.balance + adjustment }
      }
      if (acc.id === 'acc-ar' && target.type === 'Sales') {
        return { ...acc, balance: Math.max(0, acc.balance - target.grandTotal) }
      }
      if (acc.id === 'acc-ap' && target.type === 'Purchase') {
        return { ...acc, balance: Math.max(0, acc.balance - target.grandTotal) }
      }
      return acc
    })
    ```
- **R1 Storage Vulnerabilities**:
  - `books-data.json` lacks schema versioning (`schemaVersion` is absent).
  - No validation or migration occurs upon loading; only a check `stored && stored.accounts && stored.invoices`.
  - Writes are non-atomic (`writeFileSync` directly to destination path instead of `.tmp` and atomic rename), risking corruption during external concurrent writes or unexpected crashes.

---

### 3. Invoicing System in Books
- **Invoice Interface** (`apps/books/src/shared/types.ts` lines 56–75):
  ```ts
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
    tenderReference?: string // already modeled!
    crmDealId?: string      // already modeled!
    createdAt: string
    updatedAt: string
  }
  ```
- **Itemization** (`apps/books/src/shared/types.ts` lines 41–51):
  ```ts
  export interface InvoiceItem {
    id: string
    itemCode: string
    description: string
    accountId: string
    accountName: string
    qty: number
    rate: number
    taxRate: number // 15 for 15% VAT
    amount: number
  }
  ```
- **Party Counterparty**:
  - `Party` (`apps/books/src/shared/types.ts` lines 30–39): `id`, `name`, `type` (`'Customer' | 'Supplier'`), `email`, `phone`, `taxId`, `address`, `outstandingBalance`.
- **Cross-App References**:
  - `tenderReference` is displayed in `InvoiceList.tsx` (line 184) and `InvoicePrintModal.tsx` (line 82).
  - `crmDealId` is in the type interface, ready to be linked to CRM deals.
  - Tax invoice export is implemented in `InvoicePrintModal.tsx` and IPC channel `openInPdf` in `books-main.ts`.

---

### 4. Banking View in Books
- **Current Tab Structure** (`apps/books/src/renderer/src/components/Desk.tsx` lines 45–53):
  The current tabs are:
  - `dashboard` (Dashboard.tsx)
  - `invoices` (Sales Invoices)
  - `parties` (Customers & Parties)
  - `purchases` (Purchase Bills)
  - `accounts` (Chart of Accounts)
  - `journal` (Journal Entries)
  - `reports` (Financial Reports)
- **Current Banking Presence**:
  - There is **no dedicated `banking` tab or Banking view component** currently in Books.
  - `Dashboard.tsx` lines 36–37 and lines 140–148 display liquid bank balance by filtering accounts:
    `const bankAccounts = accounts.filter((a) => a.accountType === 'Bank' || a.accountType === 'Cash')`
    Card title: "Liquid Cash & Bank" (FNB Cheque + Petty Cash).
  - `ChartOfAccounts.tsx` displays `acc-bank` as a sub-account of `acc-curr-asset`.

---

### 5. Bank Statement Import & Reconciliation Requirements (R4)
- **Data Model Gap**:
  - `BooksData` does not currently include a `bankTransactions` list.
  - Needs `BankTransaction` interface:
    `id: string`, `accountId: string`, `date: string`, `description: string`, `reference?: string`, `amount: number` (positive for deposit, negative for withdrawal), `reconciled: boolean`, `matchedInvoiceId?: string`.
- **UI Requirement**:
  - Add `'banking'` to `BooksNavigationTab` and `navItems` in `Desk.tsx`.
  - Create `BankingView.tsx` component in `apps/books/src/renderer/src/components/`.
  - Include account summary for `acc-bank` (balance R 485,250.00).
  - Include "Import Bank Statement" button with CSV parsing support.
- **CSV Parsing Logic**:
  - Must accept standard CSV files (e.g. `Date, Description, Reference, Amount` or `Date, Description, Debit, Credit, Balance`).
  - Standard South African banking formats (FNB, Standard Bank, Nedbank, ABSA).
  - Parse dates, parse currency amounts (handle currency symbol `R`, commas, negative signs).
- **Ledger Balance Adjustment**:
  - When bank statement is imported:
    `acc-bank.balance += netTransactionSum`.
- **Settlement Suggestion Matching Logic**:
  - Candidate pool: Unpaid invoices (`status !== 'Paid' && outstandingAmount > 0`).
  - Positive bank transaction (deposit / credit) -> match against Sales Invoices (`type: 'Sales'`).
  - Negative bank transaction (withdrawal / debit) -> match against Purchase Bills (`type: 'Purchase'`).
  - Scoring:
    - High confidence: Exact amount match (`Math.abs(tx.amount) === inv.outstandingAmount`) AND text match (transaction description contains `inv.invoiceNumber`, `inv.tenderReference`, or party name).
    - Medium confidence: Exact amount match only.
- **1-Click Reconciliation Flow**:
  - Clicking "Reconcile" on a matched transaction:
    1. Sets transaction `reconciled: true, matchedInvoiceId: invoice.id`.
    2. Sets invoice `status: 'Paid', outstandingAmount: 0`.
    3. Decrements party `outstandingBalance: Math.max(0, party.outstandingBalance - invoice.outstandingAmount)`.
    4. Records double-entry Journal Entry balancing the accounts:
       - For Sales: Debit `acc-bank`, Credit `acc-ar`.
       - For Purchase: Debit `acc-ap`, Credit `acc-bank`.
       *(Note: Because `acc-bank` was already adjusted upon CSV import, the reconciliation journal updates `acc-ar` or `acc-ap` balance without double-adjusting `acc-bank`)*.

---

### 6. Tools, Tests, and Verification Scripts
- **Existing Scripts**:
  - `npm run check:brand`: Checked via `fork/tools/check-brand.mjs`. Executed and verified passing with **0 unauthorized brand occurrences**.
  - `npm run typecheck`: Checked across all 22 monorepo packages. Executed and verified passing cleanly with exit code 0.
  - `npm run build:all`: Compiles locales and all 9 target packages. Executed and verified passing cleanly with exit code 0.
- **Missing Integration Script**:
  - `tools/verify-suite-workflows.mjs` does NOT currently exist in `tools/`.
  - Must be created as a standalone Node.js ES module executing end-to-end programmatic verification:
    1. Schema validation, versioning, and migration for `userData/crm/deals.json`, `userData/tenders/tenders-data.json`, and `userData/books/books-data.json` (R1).
    2. CRM -> Books invoicing bridge: Won deal creates Sales invoice in Books, links `crmDealId`, records `invoiceId` back to deal, switches tab (R2).
    3. Tenders -> Books milestone billing: Tender milestone creates Tax invoice in Books with `tenderReference` and issuing authority party (R3).
    4. Bank statement CSV import and 1-click reconciliation: parses CSV, adjusts `acc-bank` balance, suggests matching open invoices/bills, and reconciles (R4).
    5. Exits with code 0 on success.

---

## Logic Chain

1. **R1 Logic**: `books-main.ts` directly reads and writes `userData/books/books-data.json` without schema version checks or migration logic. If external sync requests (from CRM, Tenders, or automated scripts) write to `books-data.json`, without a formal schema version and safe migration layer, fields could be missing or existing user entries could be clobbered. Adding versioning (`version: 1`), deep schema validation, safe defaults (preserving all existing accounts, parties, invoices), and atomic file writes (`.tmp` + `renameSync`) is strictly necessary and sufficient to satisfy R1.
2. **R2 Logic**: `Invoice` in Books already has `crmDealId?: string`. When a deal in CRM reaches stage `'won'`, triggering "Create Invoice in Zano Books" can read `books-data.json` (or invoke an IPC/bridge handler), construct a new Sales invoice with `invoiceNumber: INV-YYYY-XXX`, `partyName: deal.companyName`, `items` matching `deal.name` and valuation, `crmDealId: deal.id`, update `deals.json` with `invoiceNumber`/`invoiceId`, and activate the Books tab via `tabManager.openBooksTab()`. This cleanly fulfills R2.
3. **R3 Logic**: `Invoice` in Books already has `tenderReference?: string`. When a tender in Tenders reaches contract or milestone stage, "Bill Milestone in Zano Books" can construct a Tax invoice in Books with `tenderReference: tender.referenceNumber` (e.g. `RFP-WTR-2026-04`), `partyName: tender.issuingBody`, milestone progress amount as line item, post the double-entry accounting records, and activate the Books tab. This cleanly fulfills R3.
4. **R4 Logic**: Because `acc-bank` already exists in `accounts` with initial balance 485,250, adding a `banking` tab, a `bankTransactions` field to `BooksData`, a CSV parser, and a matching engine completes the banking workflow. By calculating the net amount from the imported CSV, `acc-bank.balance` is adjusted directly. The matching algorithm scores open invoices by amount and text tokens. The 1-click reconcile action links the transaction, marks the invoice `Paid`, updates party balances, and records the settlement journal entry. This satisfies R4.
5. **Verification Logic**: `tools/verify-suite-workflows.mjs` must test all four requirements (R1 schema migration, R2 CRM->Books, R3 Tenders->Books, R4 Bank CSV reconciliation) without launching full GUI windows, asserting on data layer integrity and exiting with code 0.

---

## Caveats

- **No Caveats.**
  - Monorepo package boundaries, IPC channels, data layer paths, and UI components are completely mapped and inspected.
  - Brand check (`check:brand`) and typecheck across all 22 packages were run and confirmed passing.

---

## Conclusion

1. **Zano Books codebase**: Well-structured Electron app at `apps/books`, using Zustand for reactive state and Electron IPC for persistence to `userData/books/books-data.json`.
2. **Schema & Data Layer**: Currently unversioned and unprotected against external corruption. Needs schema versioning, atomic write handling, and safe migration logic.
3. **Invoicing**: Already includes `crmDealId` and `tenderReference` fields in `Invoice`, perfectly aligned for R2 and R3 bridges.
4. **Banking View & Statement Reconciliation (R4)**: Needs a new `'banking'` navigation tab and `BankingView.tsx` component, `BankTransaction` data structure in `BooksData`, CSV parser, `acc-bank` balance adjustment, suggestion matching algorithm, and 1-click reconciliation action.
5. **Verification Script**: `tools/verify-suite-workflows.mjs` must be implemented to programmatically validate R1–R4.

---

## Verification Method

1. **Brand Linter**:
   ```bash
   npm run check:brand
   ```
   *Expected result*: Exit code 0, 0 unauthorized upstream brand occurrences.
2. **Typecheck (all 22 packages)**:
   ```bash
   npm run typecheck
   ```
   *Expected result*: All 22 packages compile cleanly with exit code 0.
3. **Books Build**:
   ```bash
   npm run build -w @genoffice/books
   ```
   *Expected result*: Electron-vite builds main, preload, and renderer bundles cleanly.
4. **Monorepo Build**:
   ```bash
   npm run build:all
   ```
   *Expected result*: All packages build successfully.
5. **Integration Script (once implemented)**:
   ```bash
   node tools/verify-suite-workflows.mjs
   ```
   *Expected result*: Exit code 0 after testing R1, R2, R3, and R4 end-to-end.

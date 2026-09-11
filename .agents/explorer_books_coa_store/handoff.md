# Handoff Report: Zano Books Chart of Accounts Harmonization (R2), Storage Persistence (R2), and Real-Time IPC Synchronization (R4)

**Agent**: `explorer_books_coa_store`  
**Working Directory**: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_books_coa_store`  
**Target Package**: `apps/books` (`@genoffice/books`)  
**Associated Apps**: `apps/tenders`, `apps/crm`, `apps/shell`  
**Date**: 2026-09-05  

---

## 1. Observation

### 1.1 Chart of Accounts Disparity Between Backend and Renderer (Requirement R2)
- **Backend definition**: `apps/books/src/main/books-main.ts` (lines 32–38):
  ```ts
  32: export const CORE_ACCOUNTS: Account[] = [
  33:   { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: 485250 },
  34:   { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', parentId: 'acc-curr-asset', isGroup: false, balance: 195500 },
  35:   { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', parentId: 'acc-curr-liab', isGroup: false, balance: 74200 },
  36:   { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 820000 },
  37:   { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 38400 },
  38: ]
  ```
  `CORE_ACCOUNTS` contains **only 5 accounts**.
- **Renderer seed definition**: `apps/books/src/renderer/src/mock/initialData.ts` (lines 14–47):
  Defines **23 accounts** (8 group accounts, 15 leaf accounts):
  - Assets: `acc-asset` (group), `acc-curr-asset` (group), `acc-bank`, `acc-cash`, `acc-ar`, `acc-fixed-asset` (group), `acc-equip`, `acc-vehic`
  - Liabilities: `acc-liab` (group), `acc-curr-liab` (group), `acc-ap`, `acc-vat`
  - Equity: `acc-equity` (group), `acc-retained`, `acc-capital`
  - Income: `acc-income` (group), `acc-sales`, `acc-consult`
  - Expenses: `acc-expense` (group), `acc-materials`, `acc-salaries`, `acc-rent`, `acc-travel`
- **Dangling Parent ID Defect**:
  The 5 accounts in `CORE_ACCOUNTS` reference `parentId: 'acc-curr-asset'`, `parentId: 'acc-curr-liab'`, and `parentId: 'acc-income'`. None of these parent group accounts exist in `CORE_ACCOUNTS`.
- **UI Blank Screen Crash in ChartOfAccounts.tsx** (`apps/books/src/renderer/src/components/ChartOfAccounts.tsx`, lines 29–31, 124):
  ```ts
  29: const renderTree = (parentId: string | null = null, depth = 0) => {
  30:   const children = accounts.filter((a) => a.parentId === parentId)
  31:   if (children.length === 0) return null
  ...
  124:   {renderTree(null, 0)}
  ```
  When `books-data.json` is missing, freshly created, or recovered from corruption, `readBooksStore` returns only `CORE_ACCOUNTS`. None of the 5 accounts have `parentId === null`. `renderTree(null, 0)` returns `null`, leaving the Chart of Accounts hierarchy view **completely empty/blank**.
- **Missing Standard Accounts from R2 Specification**:
  The requirement mandates 22 standard accounts across the 5 root categories. Comparing the codebase against the prompt specification:
  1. *Assets*: `acc-inventory` (Inventory / Materials on Hand) is missing in both backend and frontend.
  2. *Liabilities*: `acc-vat-in` (SARS VAT Input Recoverable) and `acc-payroll-liab` (Payroll & PAYE / UIF Liabilities) are missing in both backend and frontend.
  3. *Equity*: `acc-owner-equity` (Owner's Equity / Drawings) is missing in both backend and frontend.
  4. *Income*: `acc-interest-income` (Interest & Investment Income) is missing in both backend and frontend.
  5. *Expenses*: `acc-deprec` (Depreciation & Amortization) and `acc-utilities` (Utilities Expense, currently merged into `acc-rent`) are missing.
- **Account ID Convention & Aliasing**:
  Code throughout `books-main.ts`, `initialData.ts`, `store.ts`, `tenders-main.ts` (line 1059), and `crm-main.ts` (line 264) uses `acc-vat`. However, test tools (such as `tools/test-challenger-m3-interop-stress.ts` line 271) expect `acc-vat-out`. Currently there is no alias handling between `acc-vat` and `acc-vat-out`.
- **Dashboard Calculation Defect** (`apps/books/src/renderer/src/components/Dashboard.tsx`, lines 28–34):
  ```ts
  28: const incomeAccounts = accounts.filter((a) => a.rootType === 'Income')
  29: const totalIncome = incomeAccounts.reduce((acc, a) => acc + a.balance, 0)
  31: const expenseAccounts = accounts.filter((a) => a.rootType === 'Expense')
  32: const totalExpenses = expenseAccounts.reduce((acc, a) => acc + a.balance, 0)
  ```
  `Dashboard.tsx` does not filter out group accounts (`!a.isGroup`). If group accounts carry aggregated balances, revenue and expenses are double-counted. In contrast, `ReportsView.tsx` (lines 15, 18, 23, 26, 29) correctly filters `!a.isGroup`.

---

### 1.2 Storage Persistence & Schema Invariants (Requirement R2)
- **Persistence Location**: `apps/books/src/main/books-main.ts` (lines 218–224):
  ```ts
  function getStoragePath(): string {
    const dir = join(app.getPath('userData'), 'books')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return join(dir, 'books-data.json')
  }
  ```
- **Atomic Writing**: `apps/books/src/main/books-main.ts` (lines 181–200):
  Writes to a temporary file `${filePath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp` and renames atomically with `renameSync(tmp, filePath)`. Includes `try/unlinkSync(tmp)` cleanup on failure.
- **Corrupt File Handling Defect**: `apps/books/src/main/books-main.ts` (lines 160–167):
  ```ts
  160: } catch (parseErr) {
  161:   const backupPath = `${filePath}.corrupted.bak`
  162:   try {
  163:     writeFileSync(backupPath, content, 'utf8')
  164:     console.warn(`books-main: Corrupted books file detected. Backed up to ${backupPath}`)
  165:   } catch (bakErr) {
  ...
  168:   return {
  169:     version: CURRENT_BOOKS_SCHEMA_VERSION,
  170:     updatedAt: new Date().toISOString(),
  171:     settings: { ...DEFAULT_BOOK_SETTINGS },
  172:     accounts: [...CORE_ACCOUNTS],
  ...
  ```
  1. Only writes to `.corrupted.bak`. It does NOT create timestamped backups (`.corrupt-[timestamp]` or `${filePath}.corrupt-${Date.now()}`), so successive corruptions overwrite the previous backup.
  2. Fallback state only restores `CORE_ACCOUNTS` (the 5 accounts with missing parent groups), resulting in a broken, un-renderable chart of accounts.
- **Migration Incomplete Seeding**: `apps/books/src/main/books-main.ts` (lines 63–76):
  ```ts
  63: const existingAccounts: Account[] = Array.isArray(r.accounts) ? (r.accounts as Account[]) : []
  64: const accountsMap = new Map<string, Account>()
  65: for (const acc of existingAccounts) {
  66:   if (acc && typeof acc.id === 'string') {
  67:     accountsMap.set(acc.id, acc)
  68:   }
  69: }
  71: for (const core of CORE_ACCOUNTS) {
  72:   if (!accountsMap.has(core.id)) {
  73:     accountsMap.set(core.id, { ...core })
  74:   }
  75: }
  ```
  If `r.accounts` contains accounts from an older or partial schema that lack the root groups (`acc-asset`, `acc-liab`, `acc-equity`, `acc-income`, `acc-expense`) or standard accounts, `migrateAndValidateBooks` only ensures the 5 `CORE_ACCOUNTS` exist. It never backfills missing standard accounts or missing parent groups.

---

### 1.3 Real-Time IPC Synchronization & Push Pipeline (Requirement R4)
- **Channel Constants**: `apps/books/src/shared/ipc.ts` (lines 3–13):
  ```ts
  export const BOOKS_CHANNELS = {
    loadData: 'books:load-data',
    saveData: 'books:save-data',
    exportToSheets: 'books:export-to-sheets',
    openInPdf: 'books:open-in-pdf',
    openInCrm: 'books:open-in-crm',
    openInTenders: 'books:open-in-tenders',
    importBankStatementCsv: 'books:import-bank-statement-csv',
    reconcileTransaction: 'books:reconcile-transaction',
    getSettlementSuggestions: 'books:get-settlement-suggestions',
  } as const
  ```
  **Missing**: `dataChanged: 'books:data-changed'` is absent.
- **Preload Interface & Implementation**:
  - `apps/books/src/shared/ipc.ts` (lines 15–32): `BooksApi` interface lacks `onDataChanged`.
  - `apps/books/src/preload/index.ts` (lines 5–20): No listener or callback is exposed to renderer.
- **Main Process Broadcasting**: `apps/books/src/main/books-main.ts`:
  - There is NO `activeBooksWebContents` tracking set.
  - There are NO `registerBooksWebContents(wc)` or `unregisterBooksWebContents(wc)` functions.
  - There is NO `broadcastBooksData(data)` function.
  - In `createBooksView()` (lines 751–769): `view.webContents` is never registered for IPC broadcasting.
  - In `writeBooksStore()` (lines 181–200): It does NOT emit or broadcast any event.
  - There is NO file system watcher on `books-data.json`.
- **Cross-App Milestone Billing / CRM Invoicing Blind Spot**:
  - In `apps/tenders/src/main/tenders-main.ts` line 1098:
    `writeBooksStore(booksPath, booksData)` writes the milestone tax invoice and journal entry directly to disk.
  - In `apps/crm/src/main/crm-main.ts` line 305:
    `writeBooksStore(booksPath, booksData)` writes the CRM sales invoice directly to disk.
  - Because `writeBooksStore` does not broadcast and no file watcher exists, **any active Books tab remains completely unaware of newly billed milestone invoices or CRM invoices until a full restart or manual reload**.
- **Renderer Store Echo-Loops & Stale State**: `apps/books/src/renderer/src/store.ts` (lines 57–82):
  - Store only fetches data on initial mount via `loadData()`.
  - No `syncFromMain(data: BooksData)` action exists.
  - No echo-suppression guards (such as comparing incoming payload hash/JSON string against `lastSavedPayload` or `isSyncingFromMain` flag) exist.
- **Desk.tsx Lifecycle**: `apps/books/src/renderer/src/components/Desk.tsx` (lines 43–45):
  ```ts
  useEffect(() => {
    loadData()
  }, [loadData])
  ```
  No listener attached to `window.booksApi?.onDataChanged`.

---

## 2. Logic Chain

### 2.1 Chart of Accounts Inconsistency to UI Failure
1. `CORE_ACCOUNTS` in `books-main.ts` only specifies 5 leaf accounts, each with a parent ID pointing to non-existent group nodes (`acc-curr-asset`, `acc-curr-liab`, `acc-income`).
2. When the app initializes fresh, `readBooksStore` returns `accounts: [...CORE_ACCOUNTS]`.
3. The renderer receives this list and passes it to `ChartOfAccounts.tsx`.
4. `renderTree(null, 0)` filters `accounts.filter((a) => a.parentId === null)`.
5. Since all 5 accounts have non-null `parentId`s, 0 accounts match root level.
6. `renderTree` immediately returns `null`.
7. The user is presented with a blank box where the Chart of Accounts tree should be.
8. When financial statements (Balance Sheet, Profit & Loss) are computed, Equity accounts are completely missing (0 accounts), violating the fundamental accounting equation ($Assets = Liabilities + Equity$).

### 2.2 Cross-App Interoperability to Stale UI Desynchronization
1. A user in Zanostack Tenders clicks "Bill Milestone in Zano Books" for tender `RFP-WTR-2026-04`.
2. `tenders-main.ts` executes milestone billing, creates a tax invoice, posts journal entries, updates accounts, and calls `writeBooksStore(booksPath, booksData)`.
3. `writeBooksStore` persists to disk via atomic write (`.tmp` + rename).
4. However, `writeBooksStore` does not broadcast `books:data-changed`.
5. The Books renderer window has no file watcher and no IPC listener.
6. The user switches to the Zano Books tab. The invoice list, journal entry list, accounts receivable, and dashboard continue displaying the old, stale state.
7. If the user subsequently creates or edits an invoice in Books, `store.ts` calls `persist()`, sending its in-memory state (which does not contain the milestone invoice) to `saveData`, **overwriting and destroying the milestone invoice that Tenders just wrote to disk**.

### 2.3 Echo-Loop Risk in Main-to-Renderer IPC
1. If `books:data-changed` is broadcast naively on every `saveData`:
2. User edits an invoice in Books renderer $\rightarrow$ store calls `persist()` $\rightarrow$ invokes `saveData` IPC.
3. Main process saves to disk and broadcasts `books:data-changed` to all WebContents including the sender.
4. Renderer receives `books:data-changed` $\rightarrow$ triggers `syncFromMain` $\rightarrow$ Zustand store updates $\rightarrow$ can trigger component re-render or cascading persist cycles.
5. Therefore, a dual-layer loop-suppression mechanism is mathematically required:
   - Layer 1 (IPC level): Pass `event.sender` in `saveData` and omit the sender from `broadcastBooksData(data, excludeSender)`.
   - Layer 2 (Renderer level): Record `lastSavedPayload = JSON.stringify(data)` on save, and in `syncFromMain(data)`, if `JSON.stringify(data) === lastSavedPayload`, exit immediately.

---

## 3. Caveats

1. **Existing Test Compatibility**:
   - `tools/test-challenger-m1-empirical.mjs` (lines 129, 190, 315) checks:
     `assert.strictEqual(migrated.accounts.length, CORE_ACCOUNTS.length)`
     If `CORE_ACCOUNTS` in `books-main.ts` is updated to include all standard accounts and groups, `CORE_ACCOUNTS.length` increases, and both sides of the assertion stay equal.
   - `tools/verify-suite-workflows.mjs` (line 1723) and `tools/adversarial-milestone1-resilience.mjs` (line 203) assert that `${filePath}.corrupted.bak` exists. Therefore, corrupt JSON handling must write `${filePath}.corrupted.bak` AND `${filePath}.corrupt-${Date.now()}` so both legacy and timestamped backup requirements pass.
2. **Account ID Aliasing (`acc-vat` vs `acc-vat-out`)**:
   - Existing codebase uses `acc-vat` as the primary key.
   - Stress test `tools/test-challenger-m3-interop-stress.ts` uses `acc-vat-out`.
   - Account lookups and migration must treat `acc-vat` and `acc-vat-out` as synonyms or ensure `acc-vat` is aliased to `acc-vat-out` without causing duplicate accounts.
3. **File Watcher Debouncing**:
   - Node `fs.watch` on Windows often triggers multiple `change` events for a single file write.
   - The watcher must debounce with a timer (e.g. 100ms) and verify `JSON.stringify(currentData) !== lastBroadcastJson` before emitting `books:data-changed`.

---

## 4. Conclusion & Concrete Fix Plan

### 4.1 Harmonized 22 Standard Accounts Architecture
Define `STANDARD_ACCOUNTS: Account[]` containing all 5 root categories, sub-groups, and 22 standard leaf accounts:

```ts
export const STANDARD_ACCOUNTS: Account[] = [
  // 1. ASSET ROOT & SUB-GROUPS
  { id: 'acc-asset', name: 'Application of Funds (Assets)', rootType: 'Asset', accountType: 'Current Asset', parentId: null, isGroup: true, balance: 0 },
  { id: 'acc-curr-asset', name: 'Current Assets', rootType: 'Asset', accountType: 'Current Asset', parentId: 'acc-asset', isGroup: true, balance: 0 },
  { id: 'acc-fixed-asset', name: 'Fixed Assets', rootType: 'Asset', accountType: 'Fixed Asset', parentId: 'acc-asset', isGroup: true, balance: 0 },
  // Assets: Standard Leaves (6)
  { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: 485250 },
  { id: 'acc-cash', name: 'Petty Cash', rootType: 'Asset', accountType: 'Cash', parentId: 'acc-curr-asset', isGroup: false, balance: 15000 },
  { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', parentId: 'acc-curr-asset', isGroup: false, balance: 195500 },
  { id: 'acc-inventory', name: 'Inventory & Materials on Hand', rootType: 'Asset', accountType: 'Current Asset', parentId: 'acc-curr-asset', isGroup: false, balance: 0 },
  { id: 'acc-equip', name: 'Office & IT Equipment', rootType: 'Asset', accountType: 'Fixed Asset', parentId: 'acc-fixed-asset', isGroup: false, balance: 85000 },
  { id: 'acc-vehic', name: 'Site Utility Vehicles', rootType: 'Asset', accountType: 'Fixed Asset', parentId: 'acc-fixed-asset', isGroup: false, balance: 240000 },

  // 2. LIABILITY ROOT & SUB-GROUPS
  { id: 'acc-liab', name: 'Source of Funds (Liabilities)', rootType: 'Liability', accountType: 'Current Liability', parentId: null, isGroup: true, balance: 0 },
  { id: 'acc-curr-liab', name: 'Current Liabilities', rootType: 'Liability', accountType: 'Current Liability', parentId: 'acc-liab', isGroup: true, balance: 0 },
  // Liabilities: Standard Leaves (4)
  { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', parentId: 'acc-curr-liab', isGroup: false, balance: 74200 },
  { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 38400 },
  { id: 'acc-vat-in', name: 'SARS VAT Input Recoverable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 0 },
  { id: 'acc-payroll-liab', name: 'Payroll & PAYE / UIF Liabilities', rootType: 'Liability', accountType: 'Current Liability', parentId: 'acc-curr-liab', isGroup: false, balance: 0 },

  // 3. EQUITY ROOT & LEAVES
  { id: 'acc-equity', name: 'Equity & Reserves', rootType: 'Equity', accountType: 'Equity', parentId: null, isGroup: true, balance: 0 },
  // Equity: Standard Leaves (3)
  { id: 'acc-capital', name: 'Share Capital', rootType: 'Equity', accountType: 'Equity', parentId: 'acc-equity', isGroup: false, balance: 100000 },
  { id: 'acc-retained', name: 'Retained Earnings', rootType: 'Equity', accountType: 'Equity', parentId: 'acc-equity', isGroup: false, balance: 600000 },
  { id: 'acc-owner-equity', name: "Owner's Equity / Drawings", rootType: 'Equity', accountType: 'Equity', parentId: 'acc-equity', isGroup: false, balance: 0 },

  // 4. INCOME ROOT & LEAVES
  { id: 'acc-income', name: 'Income', rootType: 'Income', accountType: 'Direct Income', parentId: null, isGroup: true, balance: 0 },
  // Income: Standard Leaves (3)
  { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 820000 },
  { id: 'acc-consult', name: 'Professional Advisory Fees', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 235000 },
  { id: 'acc-interest-income', name: 'Interest & Investment Income', rootType: 'Income', accountType: 'Indirect Income', parentId: 'acc-income', isGroup: false, balance: 0 },

  // 5. EXPENSE ROOT & LEAVES
  { id: 'acc-expense', name: 'Expenses', rootType: 'Expense', accountType: 'Direct Expense', parentId: null, isGroup: true, balance: 0 },
  // Expenses: Standard Leaves (6)
  { id: 'acc-materials', name: 'Direct Project Materials & Subcontractors', rootType: 'Expense', accountType: 'Direct Expense', parentId: 'acc-expense', isGroup: false, balance: 345000 },
  { id: 'acc-salaries', name: 'Salaries & Wages', rootType: 'Expense', accountType: 'Indirect Expense', parentId: 'acc-expense', isGroup: false, balance: 380000 },
  { id: 'acc-rent', name: 'Office Rent & Utilities', rootType: 'Expense', accountType: 'Indirect Expense', parentId: 'acc-expense', isGroup: false, balance: 65000 },
  { id: 'acc-utilities', name: 'Water & Electricity Utilities', rootType: 'Expense', accountType: 'Indirect Expense', parentId: 'acc-expense', isGroup: false, balance: 0 },
  { id: 'acc-travel', name: 'Site Travel & Logistics', rootType: 'Expense', accountType: 'Indirect Expense', parentId: 'acc-expense', isGroup: false, balance: 28000 },
  { id: 'acc-deprec', name: 'Depreciation & Asset Amortization', rootType: 'Expense', accountType: 'Indirect Expense', parentId: 'acc-expense', isGroup: false, balance: 0 },
]

export const CORE_ACCOUNTS = STANDARD_ACCOUNTS
```

### 4.2 Storage Persistence Fix
In `books-main.ts`:
1. Update `readBooksStore`:
   - When encountering corrupt JSON: write `${filePath}.corrupted.bak` AND `${filePath}.corrupt-${Date.now()}`.
   - Return safe fallback envelope containing `STANDARD_ACCOUNTS`.
2. Update `migrateAndValidateBooks`:
   - Map existing accounts by ID.
   - Support `acc-vat-out` as an alias for `acc-vat`.
   - Ensure all `STANDARD_ACCOUNTS` are backfilled so hierarchy is never broken, without overwriting existing balances.
3. Update `Dashboard.tsx`:
   - Filter `accounts.filter((a) => a.rootType === 'Income' && !a.isGroup)` and `accounts.filter((a) => a.rootType === 'Expense' && !a.isGroup)` to eliminate double-counting.

### 4.3 Real-Time IPC Synchronization Fix Plan
1. **Shared IPC (`apps/books/src/shared/ipc.ts`)**:
   ```ts
   export const BOOKS_CHANNELS = {
     dataChanged: 'books:data-changed',
     ...
   }
   export interface BooksApi {
     onDataChanged?: (callback: (data: BooksData) => void) => () => void
     ...
   }
   ```
2. **Preload (`apps/books/src/preload/index.ts`)**:
   ```ts
   onDataChanged: (callback: (data: BooksData) => void) => {
     const listener = (_event: any, data: BooksData) => callback(data)
     ipcRenderer.on(BOOKS_CHANNELS.dataChanged, listener)
     return () => ipcRenderer.removeListener(BOOKS_CHANNELS.dataChanged, listener)
   }
   ```
3. **Backend (`apps/books/src/main/books-main.ts`)**:
   ```ts
   const activeBooksWebContents = new Set<WebContents>()
   let lastBroadcastJson = ''
   let booksFileWatcher: FSWatcher | null = null
   let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null

   export function registerBooksWebContents(wc: WebContents): void {
     if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
     activeBooksWebContents.add(wc)
     wc.once?.('destroyed', () => activeBooksWebContents.delete(wc))
   }

   export function unregisterBooksWebContents(wc: WebContents): void {
     activeBooksWebContents.delete(wc)
   }

   export function getActiveBooksWebContents(): WebContents[] {
     return Array.from(activeBooksWebContents).filter(wc => typeof wc.isDestroyed !== 'function' || !wc.isDestroyed())
   }

   export function broadcastBooksData(data: BooksData | BooksDataEnvelope, excludeWc?: WebContents): void {
     const json = JSON.stringify(data)
     lastBroadcastJson = json
     for (const wc of activeBooksWebContents) {
       if (wc !== excludeWc && (typeof wc.isDestroyed !== 'function' || !wc.isDestroyed())) {
         try {
           wc.send(BOOKS_CHANNELS.dataChanged, data)
         } catch (err) {
           console.warn('[books-main] Failed to broadcast books:data-changed:', err)
         }
       }
     }
   }
   ```
   - In `writeBooksStore`: call `broadcastBooksData(validated)`.
   - In `createBooksView`: call `registerBooksWebContents(view.webContents)`.
   - In `registerBooksIpc`:
     * Capture `_e?.sender` in `loadData` and register it.
     * In `saveData`: pass `_e.sender` to `broadcastBooksData(validated, _e.sender)`.
     * Start `startBooksStoreWatcher()`.
4. **Renderer Store (`apps/books/src/renderer/src/store.ts`)**:
   ```ts
   let lastSavedPayload = ''
   let isSyncingFromMain = false

   syncFromMain: (data: BooksData) => {
     if (!data || !Array.isArray(data.accounts)) return
     const payload = JSON.stringify(data)
     if (payload === lastSavedPayload) return

     lastSavedPayload = payload
     isSyncingFromMain = true
     try {
       set({ data })
     } finally {
       isSyncingFromMain = false
     }
   }
   ```
5. **Desk Component (`apps/books/src/renderer/src/components/Desk.tsx`)**:
   ```ts
   useEffect(() => {
     loadData()
     const unsub = window.booksApi?.onDataChanged?.((data) => {
       useBooksStore.getState().syncFromMain?.(data)
     })
     return () => unsub?.()
   }, [loadData])
   ```

---

## 5. Verification Method

### 5.1 Independent Test Verification
Create a dedicated test file `apps/books/tests/coa-and-ipc.test.ts` using Vitest to verify:
1. **Chart of Accounts Invariants**:
   - `STANDARD_ACCOUNTS` contains exactly 22 standard leaf accounts across all 5 root categories.
   - All accounts with `parentId !== null` reference existing parent group accounts.
   - All 5 root categories have root group nodes with `parentId === null`.
   - `migrateAndValidateBooks({})` preserves all 22 standard accounts without crashing.
   - Existing custom accounts and existing balances are not overwritten during migration.
2. **Corrupt Backup & Atomic Persistence**:
   - Writing garbage to `books-data.json` produces `${filePath}.corrupted.bak` AND a timestamped backup.
   - Safe fallback state initializes with full standard accounts.
   - Saving data creates `.tmp` file and renames atomically without dangling `.tmp` files.
3. **Real-Time IPC Push Notifications**:
   - `registerBooksWebContents` tracks active WebContents and prunes destroyed instances.
   - `broadcastBooksData` emits `books:data-changed` to registered WebContents.
   - `saveData` excludes the sender WebContents to prevent echo-loops.
   - Cross-app calls to `writeBooksStore` (e.g. from Tenders milestone billing or CRM won deals) immediately broadcast `books:data-changed`.
   - Renderer `syncFromMain` ignores incoming updates matching `lastSavedPayload`.

### 5.2 Suite Verification Commands
```powershell
npm run typecheck -w @genoffice/books
npm run build -w @genoffice/books
node tools/verify-suite-workflows.mjs
```
Expected output: 0 TypeScript errors, 100% test passes, 0 regressions.

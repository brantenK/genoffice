# Exploration and Investigation Report: Zanostack Tenders Interoperability (R3) & Testing Setup (R4)

**Agent ID:** `explorer_tenders_interop`  
**Date:** 2026-09-04T18:52:00Z  
**Target Milestone:** Tenders Overhaul & Hardening (R3 Cross-App Workflows & R4 Automated Testing)  
**Assigned Directory:** `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_interop`  
**Primary Target Files Investigated:**
- `apps/tenders/src/main/tenders-main.ts`
- `apps/tenders/src/renderer/src/components/Workspace.tsx`
- `apps/tenders/src/renderer/src/components/MilestonesDrawer.tsx`
- `apps/tenders/src/renderer/src/store.ts`
- `apps/tenders/src/renderer/src/gap.ts`
- `apps/tenders/src/renderer/src/pdf/shred.ts`
- `apps/tenders/src/shared/ipc.ts`
- `apps/tenders/src/shared/types.ts`
- `apps/tenders/package.json` & `tsconfig.json`
- `apps/books/src/main/books-main.ts` & `apps/books/src/renderer/src/store.ts`
- `apps/crm/src/main/crm-main.ts`, `apps/crm/src/main/crm-store.ts`, & `apps/crm/src/renderer/src/App.tsx`
- `apps/shell/src/main/index.ts` & `apps/shell/src/main/tab-manager.ts`
- `apps/docs/src/main/docs-main.ts` & `packages/docx-engine/src/blank.ts`
- `tools/verify-suite-workflows.mjs`

---

## 1. Observation

### 1.1 Zano Books Interoperability & Milestone Billing
1. **Milestone Billing Trigger & Invocation:**
   - In `apps/tenders/src/renderer/src/components/MilestonesDrawer.tsx` (lines 42–60):
     ```ts
     const res = await window.tendersApi?.billMilestoneInBooks(tender.id, milestone.id)
     if (res && res.ok) {
       const nowIso = new Date().toISOString()
       const updatedMilestones = (tender.milestones || []).map((m) =>
         m.id === milestone.id
           ? {
               ...m,
               status: 'BILLED' as MilestoneBillingStatus,
               billedInvoiceId: res.invoiceId,
               billedInvoiceNumber: res.invoiceNumber,
               billedAt: nowIso,
               billedDate: nowIso,
             }
           : m
       )
       updateTender(tender.id, { milestones: updatedMilestones })
       setToastMessage(`Tax Invoice ${res.invoiceNumber || res.invoiceId} successfully created in Zano Books!`)
       await window.tendersApi?.openBooks?.()
     }
     ```
   - In `apps/tenders/src/renderer/src/components/Workspace.tsx` (lines 267–284), a duplicate quick-action handler implements an identical call.
   - Preload IPC binding: `apps/tenders/src/preload/index.ts:15-16` forwards to `TENDERS_CHANNELS.billMilestoneInBooks`.

2. **Double-Entry Ledger Entries & Tax Invoice Generation in Books:**
   - Handled in `apps/tenders/src/main/tenders-main.ts` lines 434–652 (`TENDERS_CHANNELS.billMilestoneInBooks`).
   - Checks eligibility:
     - Line 490: `if (foundMilestone.status === 'BILLED' || foundMilestone.billedInvoiceId)` -> returns error `Milestone already billed`.
     - Line 498: `if (foundMilestone.status !== 'REACHED')` -> returns error `Milestone is not in REACHED status`.
     - Line 505: `if (billAmount <= 0)` -> returns error `Milestone billing amount must be greater than 0`.
   - Tax Invoice created in Books (`tenders-main.ts:544-573`):
     - `type: 'Sales'`, `status: 'Unpaid'`, `tenderReference: ref` (e.g. `RFP-WTR-2026-04`).
     - Line items: `itemCode: 'TENDER-PROGRESS'`, `description: '${mName} per ${ref}'`, `accountId: 'acc-sales'`, `rate: subtotal`, `taxRate: 15`.
     - Arithmetic:
       ```ts
       const grandTotal = Math.round(billAmount * 100) / 100
       const subtotal = Math.round((grandTotal / 1.15) * 100) / 100
       const taxTotal = Math.round((grandTotal - subtotal) * 100) / 100
       ```
   - Double-entry ledger updates (`tenders-main.ts:579-583`):
     ```ts
     for (const acc of booksData.accounts) {
       if (acc.id === 'acc-ar') acc.balance = Math.round((acc.balance + grandTotal) * 100) / 100
       if (acc.id === 'acc-sales') acc.balance = Math.round((acc.balance + subtotal) * 100) / 100
       if (acc.id === 'acc-vat') acc.balance = Math.round((acc.balance + taxTotal) * 100) / 100
     }
     ```
   - Balanced Journal Entry posted (`tenders-main.ts:586-619`):
     - Entry number `JE-${year}-${booksData.journalEntries.length + 1}`.
     - `totalDebit: grandTotal`, `totalCredit: grandTotal`, `posted: true`.
     - Debit `acc-ar`: `grandTotal`, Credit `acc-sales`: `subtotal`, Credit `acc-vat`: `taxTotal`.
   - Persistence: Calls `writeBooksStore(booksPath, booksData)` (`tenders-main.ts:621`).

3. **Tender Milestones Updated to Billed:**
   - In `tenders-main.ts:625-631`:
     ```ts
     foundMilestone.status = 'BILLED'
     foundMilestone.billedInvoiceId = invoiceId
     foundMilestone.billedInvoiceNumber = invoiceNumber
     foundMilestone.billedAt = nowIso
     foundMilestone.billedDate = nowIso
     tendersData.updatedAt = nowIso
     writeTendersStore(tendersPath, tendersData)
     ```
   - Shell callback: `runtime.onOpenBooks?.(invoiceId)` (`tenders-main.ts:634`), wired in `apps/shell/src/main/index.ts:308` to `newBooksTab()`.

4. **Payment State Update Propagation Back to Tender Milestones:**
   - Search across `apps/books/src/main/books-main.ts` and `apps/books/src/renderer/src/store.ts`:
     - In `books-main.ts:568-660` (`executeReconciliation`):
       Marks invoice `status = 'Paid'`, `outstandingAmount = 0`, updates customer `outstandingBalance`, offsets `acc-ar`, and posts journal entry (`acc-bank` debit, `acc-ar` credit).
       **Zero interaction with Tenders**: It does NOT inspect `inv.tenderReference`, does NOT open `userData/tenders/tenders-data.json`, and does NOT notify Tenders.
     - In `apps/books/src/renderer/src/store.ts:229-252` (`markInvoicePaid`):
       Only updates Books internal store and calls `persist()`.
     - In `apps/tenders/src/shared/types.ts:174`:
       `export type MilestoneBillingStatus = 'PENDING' | 'REACHED' | 'BILLED' | 'PAID'`
     - In `apps/tenders/src/renderer/src/components/MilestonesDrawer.tsx:155,176`:
       UI supports `{isPaid && <Badge tone="green">Paid</Badge>}`.
     - **Observed fact:** There is **NO code anywhere** in the application that sets a tender milestone's status to `'PAID'` or propagates Books payment updates back to Tenders.

---

### 1.2 Zano CRM Interoperability
1. **Existing Workflow:**
   - Handled in `apps/tenders/src/main/tenders-main.ts:333-414` (`TENDERS_CHANNELS.syncWithCrm`).
   - Triggered in `apps/tenders/src/renderer/src/components/Workspace.tsx` lines 195–203:
     ```ts
     await window.tendersApi?.syncWithCrm({
       name: `Tender: ${tender.title}`,
       amount: tender.estimatedValue || 250000,
       companyName: tender.issuingBody || 'Government / Enterprise Buyer',
       notes: `Closing: ${tender.closingDate || 'TBD'}. Verified returnables: ${tender.requirements.filter((r) => r.status === 'FULFILLED').length}/${tender.requirements.length}.`,
     })
     await window.tendersApi?.openInCrm()
     ```
2. **Missing & Fragile Areas:**
   - **ID and Deduplication Bug (`tenders-main.ts:368`):**
     `const targetId = dealData?.id || dealData?.dealId || dealData?.crmDealId || 'deal-tender-${Date.now()}'`
     Because `Workspace.tsx` passes neither `id`, `dealId`, nor `crmDealId`, every click generates a new timestamped deal ID (`deal-tender-1725...`) and prepends a duplicate deal to `userData/crm/deals.json`.
   - **Missing Deadline Field:**
     `tender.closingDate` is packed into a freeform string inside `notes`. The dedicated CRM deal field `Deal.expectedCloseDate` (`apps/crm/src/shared/types.ts:19`) is completely unpopulated.
   - **Missing Stage Mapping:**
     `Workspace.tsx` does not supply a `stage`. `tenders-main.ts:394` hardcodes default `'proposal'`.
   - **Missing Tender Reference:**
     `tender.referenceNumber` (e.g. `RFP-WTR-2026-04`) is omitted from deal metadata and title prefix.
   - **Missing Back-Link on Tender:**
     The generated `dealId` is returned to the renderer, but the renderer never persists `crmDealId` or `syncedToCrmAt` onto the tender record in Zustand or on disk.
   - **Stale CRM Renderer State (`apps/crm/src/renderer/src/App.tsx:87-89`):**
     CRM only executes `loadData()` once inside `useEffect(..., [])` on initial mount. When `openInCrm` switches tabs, the existing CRM tab is simply activated (`tabManager.openCrmTab()` -> `this.activateTab(existing.id)`). CRM does NOT reload `deals.json` on tab activation or window focus. The newly synced deal is invisible until the app restarts.
   - **No Deal Navigation in Shell (`apps/shell/src/main/index.ts:307`):**
     `onOpenCrm: () => newCrmTab()` ignores the `dealId` argument, so CRM cannot auto-select or open the deal modal.

---

### 1.3 Zano Docs & Sheets Interoperability
1. **Compliance Matrix to Sheets:**
   - Implementation: `apps/tenders/src/main/tenders-main.ts:231-264` (`TENDERS_CHANNELS.exportMatrixToSheets`).
   - Trigger: `Workspace.tsx:171-177`.
   - Creates CSV file at `join(tmpdir(), 'Tender_Matrix_${(tenderTitle || 'Export').replace(/[^a-zA-Z0-9_-]/g, '_')}.csv')`.
   - Navigation:
     Calls `runtime.openGeneratedPath(targetPath)`.
     In `apps/shell/src/main/index.ts:2703`: `const XLSX_RE = /\.(xlsx|xlsm|xls|csv)$/i`.
     Matches `.csv`, calling `tabManager.openSheetsTab(filePath)` and `startQueuedWorkbookNudge()`.
     **Observed Behavior:** Works as intended for tab navigation. However, the file path lacks a unique timestamp suffix (risk of file collision on re-export), and multiline clauses with raw newlines can corrupt CSV row structures.

2. **Proposal Draft to Docs:**
   - Implementation: `apps/tenders/src/main/tenders-main.ts:267-330` (`TENDERS_CHANNELS.draftProposalDoc`).
   - Trigger: `Workspace.tsx:183-191`.
   - Creates Markdown file at `join(tmpdir(), 'Bid_Response_${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.md')`.
   - Navigation in `apps/shell/src/main/index.ts:2849-2855`:
     ```ts
     if (MD_RE.test(filePath)) {
       recordRecentFile(filePath)
       const existing = tabManager.findMarkdownTabByPath(filePath)
       if (existing) tabManager.activateTab(existing)
       else tabManager.openMarkdownTab(filePath)
       return true
     }
     ```
   - **CRITICAL DEFECT:** It opens in **AI Markdown** (`kind: 'markdown'`), **NOT Zanostack Docs** (`kind: 'docs'`)!
   - Zanostack Docs (`apps/docs`) is the dedicated DOCX editor. In `apps/shell/src/main/index.ts:2702`, Docs is triggered only by `DOCX_RE = /\.docx$/i` or via shell hook `openDocsTab(undefined, { aiContent: { title, html } })`.
   - Acceptance Criteria explicitly requires:
     *"Export matrix to Sheets and Draft proposal in Docs generate valid files without error and trigger corresponding shell tab navigation."*
     The proposal draft must open in **Zanostack Docs**, not Markdown.

---

### 1.4 Testing & Verification (R4)
1. **Test Runner in `apps/tenders`:**
   - `apps/tenders/package.json:9-14`:
     ```json
     "scripts": {
       "dev": "electron-vite dev",
       "dev:renderer": "vite --config vite.renderer.config.ts",
       "build": "electron-vite build",
       "typecheck": "tsc --noEmit"
     }
     ```
     **No test runner or test script is configured.**
   - No `apps/tenders/vitest.config.ts` exists.
   - Root `package.json:29` runs tests across 18 packages/apps, but `@genoffice/tenders` is omitted.
   - Vitest `4.1.10` is installed at root. Root `vitest.config.ts:8` includes `apps/*/vitest.config.ts`.
2. **Current Tests in Repository:**
   - `apps/tenders/tests/`: **Zero tests exist** (directory does not exist).
   - `tools/verify-suite-workflows.mjs`:
     Executes 56 integration tests across Tiers 1–4, passing in 1221ms (verified via CLI run).
     **Crucial Finding:** `verify-suite-workflows.mjs` contains its own self-contained simulation functions (`executeBillMilestoneInBooks`, `migrateAndValidateTendersData`, `parseBankStatementCsv`, etc.). It does NOT test the actual source code of `apps/tenders/src/` (`shred.ts`, `gap.ts`, `tenders-main.ts`, etc.).
3. **TypeScript Typecheck Behavior:**
   - Command: `npm run typecheck -w @genoffice/tenders` (`tsc --noEmit`).
   - Result: Exits with **code 0** (0 errors).
   - Config: `apps/tenders/tsconfig.json` includes `["src", "electron.vite.config.ts", "vite.renderer.config.ts"]`. Needs `"tests"` and `"vitest.config.ts"` added once test files are introduced.

---

## 2. Logic Chain

1. **Books Milestone Billing & Double-Entry Integrity:**
   - *Observation:* `tenders-main.ts:529-621` creates `Invoice` (`type: 'Sales'`), debits `acc-ar`, credits `acc-sales` and `acc-vat`, and writes a balanced Journal Entry `JE-YYYY-X`.
   - *Logic:* The core accounting and arithmetic for billing a reached milestone is valid and compliant with South African 15% VAT calculation conventions (`subtotal = grandTotal / 1.15`, `taxTotal = grandTotal - subtotal`).
   - *Observation:* When an invoice is paid via `books-main.ts:602` (`executeReconciliation`) or `store.ts:237` (`markInvoicePaid`), no IPC message, file read/write, or hook touches `tenders-data.json`.
   - *Logic:* Because Books operates as an isolated data store and contains no back-propagation logic, tender milestones can never transition from `'BILLED'` to `'PAID'` automatically upon receipt of customer payment.
   - *Conclusion:* A payment synchronization bridge is required: either Books must inspect `invoice.tenderReference` upon reconciliation and invoke a Tenders update method, or Tenders must verify invoice payment status against Books on load/refresh and update milestones to `'PAID'`.

2. **Main-Renderer State Synchronization Gap:**
   - *Observation:* `apps/tenders/src/renderer/src/store.ts:216-218` uses Zustand `persist` with default `localStorage`. Lines 206–228 of `tenders-main.ts` provide `getStoredData` and `saveStoredData`, but renderer never calls them (0 references in `src/renderer`).
   - *Logic:* Any changes made to `userData/tenders/tenders-data.json` by Electron main (such as milestone billing or external sync) are not reflected in the active renderer unless manually patched in local component state. If the app restarts or another tab triggers an update, renderer state and disk state diverge.
   - *Conclusion:* Tenders must adopt the same pattern as Books: renderer store must call `window.tendersApi.getStoredData()` on load, write through `saveStoredData()`, and listen for main-process store update events.

3. **CRM Synchronization Defects:**
   - *Observation:* `Workspace.tsx:196-201` passes `name`, `amount`, `companyName`, and string notes to `syncWithCrm`, without `id` or `dealId`.
   - *Observation:* `tenders-main.ts:368` falls back to `deal-tender-${Date.now()}` when `id` is absent.
   - *Logic:* Without a deterministic key (such as `deal-tender-${tender.id}` or `tender.referenceNumber`), repeated clicks on the "CRM" button create duplicate deals every time.
   - *Observation:* `tender.closingDate` is not passed to `Deal.expectedCloseDate`, and CRM renderer only calls `loadData()` on initial mount.
   - *Logic:* The exported deal lacks critical deadline metadata in CRM pipeline views, and remains invisible in the CRM UI if the tab is already running.

4. **Docs Export Routing Defect:**
   - *Observation:* `tenders-main.ts:320` exports proposal drafts as `.md` files.
   - *Observation:* `apps/shell/src/main/index.ts:2849-2855` routes `.md` files to `tabManager.openMarkdownTab()`.
   - *Logic:* The proposal draft opens in the Markdown editor instead of Zanostack Docs. To satisfy R3 and acceptance criteria, it must either be created as a `.docx` file (which `routeDocumentPath` routes to `openDocsTab`) or injected via `createAiDocument` / `openDocsTab(undefined, { aiContent: { title, html } })`.

5. **Test Architecture Requirements:**
   - *Observation:* `apps/tenders` has 0 tests, no `vitest.config.ts`, and no test command in `package.json`.
   - *Observation:* Pure functions in `shred.ts` (`shredExtraction`, `extractSubmissionLogistics`, `extractIssuerInfo`), `gap.ts` (`assessDocHealth`, `matchVaultDocsWithConfidence`, `applyGapToRequirement`), `readiness.ts` (`assessReadiness`), and `tenders-main.ts` (`migrateAndValidateTenders`, `readTendersStore`, `writeTendersStore`) have zero DOM/Electron runtime dependencies and can be tested immediately in Vitest.
   - *Logic:* Adding `vitest.config.ts`, four test suites in `apps/tenders/tests/`, and `"test": "vitest run"` in `package.json` satisfies R4 with zero risk of regression.

---

## 3. Caveats

1. **Independent Verification vs In-App Testing:**
   `tools/verify-suite-workflows.mjs` executes 56 tests and passes 100%, but it verifies an internal simulation of the suite logic rather than `apps/tenders/src/`. Passing `verify-suite-workflows.mjs` is necessary but not sufficient for R4.
2. **Docs DOCX Generation Complexity:**
   Zanostack Docs renderer converts HTML to DOCX in-browser, while `@genoffice/docx-engine` in Node provides `buildBlankDocx` and paragraph-patching. If generating `.docx` from main process Node environment, `@genoffice/docx-engine` or a lightweight DOCX builder template must be used; alternatively, shell hook `openAiDocTab` can receive `{ title, html }` and leverage Docs' native HTML importer.
3. **Single-Instance Shell Lock:**
   Electron shell testing in headless CI or CLI requires `GENOFFICE_USER_DATA` pointing to a scratch directory to prevent collisions with running developer instances (`apps/shell/src/main/index.ts:213-217`).

---

## 4. Conclusion & Recommendations

### Summary Matrix

| Workflow / Area | Current State | Defect / Limitation | Recommendation for Implementation |
|---|---|---|---|
| **Books: Milestone Billing** | Functional in `tenders-main.ts` & `MilestonesDrawer.tsx` | Updates `tenders-data.json` and in-memory milestone, but not external subscribers | Keep accounting engine; emit IPC update event to renderer WebContents |
| **Books: Payment Propagation** | Completely Missing | Billed milestones never transition to `'PAID'` when invoice is paid in Books | In Books `executeReconciliation` & `markInvoicePaid`, check if `inv.tenderReference` exists, update matching milestone in `tenders-data.json` to `'PAID'`; add Tenders check on load |
| **CRM: Tender Sync** | Partial in `tenders-main.ts:333` | Generates duplicate deals on repeated clicks; `closingDate` omitted from `expectedCloseDate`; CRM UI doesn't refresh | Use deterministic deal ID `deal-tender-${tender.id}`; map `expectedCloseDate: tender.closingDate`; add `tenderReference`; save `crmDealId` to tender; notify CRM renderer |
| **Sheets: Matrix Export** | Functional in `tenders-main.ts:231` | Works; tab routes to Sheets; lacks timestamp suffix and newline sanitization | Add unique timestamp/UUID in file name; sanitize multiline strings in CSV export |
| **Docs: Proposal Draft** | Misrouted | Generates `.md` file, which opens in **AI Markdown** tab, not **Zanostack Docs** | Generate `.docx` or use Docs AI content hook (`openDocsTab(undefined, { aiContent })`) to open in Zanostack Docs |
| **State Sync (Main-Renderer)** | Desynchronized | Renderer stores to `localStorage`; ignores `userData/tenders/tenders-data.json` | Wire `useTendersStore` to `getStoredData`/`saveStoredData` via IPC; add push event on data change |
| **Test Runner (R4)** | Missing | No `vitest.config.ts`, no `npm test` script in `apps/tenders/package.json` | Add `vitest.config.ts`, add `"test": "vitest run"`, add `@genoffice/tenders` to root `package.json` `"test"` |
| **Test Coverage (R4)** | 0 tests in `apps/tenders` | Shredder, gap analysis, store migrations, and IPC handlers untested | Implement 4 test files under `apps/tenders/tests/` (heuristics, gap, store, ipc) |
| **TypeScript Typecheck** | Passes cleanly (0 errors) | `apps/tenders/tsconfig.json` does not include `tests/` | Add `"tests"` and `"vitest.config.ts"` to `tsconfig.json` |

---

### Concrete Implementation Proposals

#### 1. Books Payment Propagation (R3)
In `apps/books/src/main/books-main.ts`, inside `executeReconciliation` (after line 605):
```ts
// Propagate payment to Tenders milestone if this invoice was for a tender
if (inv.tenderReference) {
  try {
    const tendersDir = join(app.getPath('userData'), 'tenders')
    const tendersPath = join(tendersDir, 'tenders-data.json')
    if (existsSync(tendersPath)) {
      const rawTenders = readFileSync(tendersPath, 'utf8')
      const tendersData = JSON.parse(rawTenders)
      let modified = false
      for (const ws of (tendersData.workspaces || [])) {
        for (const t of (ws.tenders || [])) {
          if (t.referenceNumber === inv.tenderReference || t.milestones?.some((m: any) => m.billedInvoiceId === inv.id)) {
            for (const m of (t.milestones || [])) {
              if (m.billedInvoiceId === inv.id || (m.status === 'BILLED' && t.referenceNumber === inv.tenderReference)) {
                m.status = 'PAID'
                m.paidAt = new Date().toISOString()
                modified = true
              }
            }
          }
        }
      }
      if (modified) {
        tendersData.updatedAt = new Date().toISOString()
        const tmp = `${tendersPath}.${Date.now()}.tmp`
        writeFileSync(tmp, JSON.stringify(tendersData, null, 2), 'utf8')
        renameSync(tmp, tendersPath)
      }
    }
  } catch (err) {
    console.warn('[books-main] Failed to propagate payment to tenders:', err)
  }
}
```

#### 2. CRM Sync Hardening (R3)
In `apps/tenders/src/renderer/src/components/Workspace.tsx` (lines 195–203):
```ts
onClick={async () => {
  const deterministicDealId = tender.crmDealId || `deal-tender-${tender.id}`
  const fulfilledCount = tender.requirements.filter((r) => r.status === 'FULFILLED').length
  const totalCount = tender.requirements.length
  const readinessPct = totalCount > 0 ? Math.round((fulfilledCount / totalCount) * 100) : 50

  const res = await window.tendersApi?.syncWithCrm({
    id: deterministicDealId,
    name: `[${tender.referenceNumber || 'RFP'}] ${tender.title}`,
    amount: tender.estimatedValue || 250000,
    companyName: tender.issuingBody || 'Government / Enterprise Buyer',
    stage: 'proposal',
    probability: readinessPct,
    expectedCloseDate: tender.closingDate || undefined,
    notes: `Tender Ref: ${tender.referenceNumber || 'N/A'}. Closing: ${tender.closingDate || 'TBD'}. Verified returnables: ${fulfilledCount}/${totalCount} (${readinessPct}%).`,
  })

  if (res && res.ok && res.dealId) {
    updateTender(tender.id, { crmDealId: res.dealId, syncedToCrmAt: new Date().toISOString() })
  }
  await window.tendersApi?.openInCrm(res?.dealId || deterministicDealId)
}}
```

#### 3. Docs Proposal Export Route (R3)
In `apps/tenders/src/main/tenders-main.ts` line 320:
Either build a valid `.docx` file:
```ts
const targetPath = join(tmpdir(), `Bid_Response_${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.docx`)
// Generate minimal docx package or convert html using docx-engine
const buffer = await buildBlankDocx()
writeFileSync(targetPath, buffer)
if (runtime.openGeneratedPath) {
  runtime.openGeneratedPath(targetPath)
}
```
Or forward to shell runtime hook to open in Docs via `openDocsTab(undefined, { aiContent: { title, html } })`.

#### 4. Vitest Configuration & Setup (R4)
Create `apps/tenders/vitest.config.ts`:
```ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@genoffice/docx-engine': local('../../packages/docx-engine/src/index.ts'),
      '@genoffice/electron-utils': local('../../packages/electron-utils/src/index.ts'),
      '@genoffice/ui': local('../../packages/ui/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
})
```

Add to `apps/tenders/package.json`:
```json
"scripts": {
  ...
  "test": "vitest run",
  "test:watch": "vitest"
}
```

Add `@genoffice/tenders` to root `package.json` `"test"` script.

---

## 5. Verification Method

### Independent Verification Commands
To independently verify the observations and conclusions in this report:

1. **Verify Existing Monorepo Suite Workflows:**
   ```powershell
   node tools/verify-suite-workflows.mjs
   ```
   *Expected:* 56 passed, 0 failed. Note that tests verify internal simulation logic.

2. **Verify TypeScript Typechecking for Tenders:**
   ```powershell
   npm run typecheck -w @genoffice/tenders
   ```
   *Expected:* Exits with code 0 (`tsc --noEmit`).

3. **Verify Vitest Runner Availability:**
   ```powershell
   npx vitest --version
   ```
   *Expected:* `vitest/4.1.10 win32-x64 node-v24.14.0`.

4. **Verify Absence of Test Configuration in `apps/tenders`:**
   ```powershell
   powershell -Command "Get-Content apps/tenders/package.json | ConvertFrom-Json | Select-Object -ExpandProperty scripts"
   ```
   *Expected:* Contains `dev`, `dev:renderer`, `build`, `typecheck`. Does NOT contain `test`.

5. **Verify Routing for Proposal Draft (.md) in Shell:**
   Inspect `apps/shell/src/main/index.ts` lines 2849–2855:
   Notice `MD_RE.test(filePath)` routes strictly to `tabManager.openMarkdownTab(filePath)`, confirming the Docs vs Markdown routing defect.

6. **Verify Lack of Payment Propagation in Books:**
   Inspect `apps/books/src/main/books-main.ts` lines 568–660 (`executeReconciliation`):
   Notice neither `tenderReference` nor `userData/tenders/tenders-data.json` is referenced.

### Invalidation Conditions
This report's findings would be invalidated if:
- `apps/tenders/src/renderer/src/store.ts` is already wired to an uncommitted IPC sync mechanism that reads `tenders-data.json` on startup.
- Books already has an external event emitter dispatching payment webhooks that was relocated to another package.
- Shell tab routing treats `.md` files as Docs tabs in another unreferenced module.
All of these were searched across the entire repository and confirmed absent.

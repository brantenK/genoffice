# Tenders Backend Exploration Handoff Report

**Agent:** `explorer_tenders_backend`  
**Date:** 2026-09-04  
**Working Directory:** `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_backend`  
**Target File:** `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_backend\handoff.md`  

---

## 1. Observation

### 1.1 Store Persistence Disconnect (Renderer vs. Main Process)
* **File:** `apps/tenders/src/renderer/src/store.ts` (Lines 9-10, 216-218, 418-420, 426-432, 455-462)
  * The renderer uses Zustand's `persist` middleware configured exclusively with browser `localStorage`:
    ```ts
    // apps/tenders/src/renderer/src/store.ts:418-420
    {
      name: 'zanostack-tenders-v1',
      version: 1,
      partialize: (s) => ({ ... })
    }
    ```
  * In `partialize` (lines 427 & 431) and `onRehydrateStorage` (lines 457 & 460), `fileUrl` is intentionally blanked:
    ```ts
    // apps/tenders/src/renderer/src/store.ts:427
    tenders: ws.tenders.map((t) => ({ ...t, fileUrl: '' })),
    // apps/tenders/src/renderer/src/store.ts:431
    vault: ws.vault.map((d) => d.fileUrl?.startsWith('blob:') ? { ...d, fileUrl: null } : d)
    ```
  * **Critical Observation:** A full-text grep across `apps/tenders/src/renderer/` for `getStoredData` and `saveStoredData` yields **zero occurrences**. The renderer never reads from `userData/tenders/tenders-data.json` nor does it write UI state changes to it.
* **File:** `apps/tenders/src/main/tenders-main.ts` (Lines 206-228)
  * `ipcMain.handle(TENDERS_CHANNELS.getStoredData, ...)` and `ipcMain.handle(TENDERS_CHANNELS.saveStoredData, ...)` are defined and registered on lines 206-228, but are completely unused by the renderer.

### 1.2 Seed Data Divergence Between Main Process and Renderer Store
* **File:** `apps/tenders/src/main/tenders-main.ts` (Lines 53-90)
  * In `migrateAndValidateTenders(raw: unknown)`:
    ```ts
    // apps/tenders/src/main/tenders-main.ts:59-66
    activeCompanyId: 'comp-zano-01',
    workspaces: [
      {
        id: 'ws-ekurhuleni-01',
        name: 'Ekurhuleni Water Infrastructure',
        company: {
          name: 'Zano Consulting (Pty) Ltd',
          ...
        },
        customers: [],
        vault: [],
        tenders: [SEED_TENDER_WTR_04],
      }
    ]
    ```
* **File:** `apps/tenders/src/renderer/src/store.ts` (Lines 179-191)
  * The renderer store seeds:
    ```ts
    const SEED_COMPANY_ID = 'co-thabo'
    function seedWorkspaces(): CompanyWorkspace[] {
      return [
        {
          id: SEED_COMPANY_ID,
          company: { ...MOCK_COMPANY }, // 'Thabo Engineering (Pty) Ltd'
          customers: MOCK_CUSTOMERS,
          vault: MOCK_VAULT,             // 7 mock compliance documents
          tenders: [SEED_TENDER_WTR_04]
        }
      ]
    }
    ```
  * If the renderer hydrates from `tenders-data.json` initialized by `tenders-main.ts`, the entire mock compliance vault (`MOCK_VAULT`) and customer directory (`MOCK_CUSTOMERS`) are wiped clean because `tenders-main.ts` initialized them as empty arrays (`customers: []`, `vault: []`).

### 1.3 Atomic Write & Schema Migration in Main Process
* **File:** `apps/tenders/src/main/tenders-main.ts` (Lines 152-171)
  * Atomic write implementation:
    ```ts
    export function writeTendersStore(baseDirOrPath: string, data: unknown): void {
      const filePath = baseDirOrPath.endsWith('tenders-data.json') ? baseDirOrPath : join(baseDirOrPath, 'tenders-data.json')
      const dir = filePath.replace(/[/\\][^/\\]+$/, '')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const validated = migrateAndValidateTenders(data)
      const tmp = `${filePath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
      try {
        writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf8')
        renameSync(tmp, filePath)
      } catch (e) {
        try {
          if (existsSync(tmp)) unlinkSync(tmp)
        } catch {}
        console.error('tenders-main: failed to atomically write tenders store', filePath, e)
        throw e
      }
    }
    ```
  * `readTendersStore` (lines 111-150) handles missing files by returning default seed data and backs up corrupted files to `${filePath}.corrupted.bak` before returning defaults.

### 1.4 Lack of Main-to-Renderer IPC Push Notification
* **File:** `apps/tenders/src/main/tenders-main.ts` (Lines 434-652)
  * When `TENDERS_CHANNELS.billMilestoneInBooks` executes:
    * Updates `foundMilestone.status = 'BILLED'`, `billedInvoiceId`, `billedInvoiceNumber`, `billedAt`.
    * Writes changes to disk via `writeTendersStore(tendersPath, tendersData)`.
    * Calls `runtime.onOpenBooks?.(invoiceId)`.
    * **Direct Observation:** There is no `webContents.send()` call anywhere in `tenders-main.ts`.
  * **File:** `apps/shell/src/main/tab-manager.ts` (Lines 301-320, 343-351)
    * `TabManager.openTendersTab()` creates a `WebContentsView` via `createTendersView()` and adds it to the window.
    * `activateTab(id)` toggles visibility (`view.setVisible(true)`). It does **not** reload the WebContents.
    * Therefore, any backend data modification (such as milestone billing from Books or external sync) leaves the in-memory renderer state completely stale until a manual reload occurs.

### 1.5 Transient Blob URLs for Uploaded Documents (R2 Problem)
* **File:** `apps/tenders/src/renderer/src/components/TenderList.tsx` (Lines 84-101)
  * Uploading an RFP PDF executes:
    ```ts
    const url = URL.createObjectURL(file)
    const record = buildTenderRecord(
      `t-${Date.now()}-${tenderSeq++}`,
      file.name,
      url,
      ...
    )
    ```
* **File:** `apps/tenders/src/renderer/src/components/pages/DocumentsPage.tsx` (Lines 108, 122)
  * Uploading a vault document executes:
    ```ts
    fileUrl: data.file ? URL.createObjectURL(data.file) : null
    ```
* **File:** `apps/tenders/src/renderer/src/components/Workspace.tsx` (Lines 52-61, 97-100, 324-332)
  * If `!tender.fileUrl`, `Workspace.tsx` clears the PDF viewer and displays a fallback banner: `"PDF file not attached to this session"`, requiring the user to manually re-attach the file every time the application opens.
* **Direct Observation:** No document persistence directory exists under `userData/tenders/`. Uploaded files are never written to disk, and no IPC channels exist to save, read, or manage durable document files.

### 1.6 Cross-App Integration Workflows
* **File:** `apps/tenders/src/main/tenders-main.ts` (Lines 231-330, 333-414, 434-652)
  * `exportMatrixToSheets`: Writes CSV to `tmpdir()` and calls `runtime.openGeneratedPath(targetPath)`.
  * `draftProposalDoc`: Writes Markdown to `tmpdir()` and calls `runtime.openGeneratedPath(targetPath)`.
  * `apps/shell/src/main/index.ts` (Lines 2703, 2799-2855): `XLSX_RE` matches `.csv`, routing to `openSheetsTab`. `MD_RE` matches `.md`, routing to `openMarkdownTab` / `openDocsTab`. Both exports work as designed.
  * `syncWithCrm`: Updates `userData/crm/deals.json`. However, it does not record `tender.linkedCrmDealId` back onto `TenderRecord` in `tenders-data.json`.
  * **File:** `apps/books/src/main/books-main.ts` (Lines 568-660)
    * `executeReconciliation` marks invoices `status = 'Paid'` and creates journal entries.
    * However, it never updates `userData/tenders/tenders-data.json`. Consequently, tender milestones linked to that invoice remain stuck in `'BILLED'` status instead of progressing to `'PAID'`.

### 1.7 Testing Infrastructure Status
* **File:** `apps/tenders/package.json` (Lines 9-14)
  * Scripts contain: `"dev"`, `"dev:renderer"`, `"build"`, `"typecheck"`.
  * **Observation:** No `"test"` script exists, no `vitest` dependency is configured in `package.json`, and there is no `tests/` directory inside `apps/tenders/`.

---

## 2. Logic Chain

### 2.1 State Synchronization Gap (R1)
1. *Observation 1.1* demonstrates that `apps/tenders/src/renderer/src/store.ts` relies solely on `localStorage` ('zanostack-tenders-v1') and never invokes `tendersApi.getStoredData` or `saveStoredData`.
2. *Observation 1.4* confirms that `tenders-main.ts` modifies `tenders-data.json` directly during cross-app operations (such as `billMilestoneInBooks`) without notifying the renderer.
3. *Observation 1.4* also confirms that `TabManager` activates the Tenders tab by setting view visibility (`setVisible(true)`), which does not reload the page or trigger re-reading of `localStorage`.
4. **Logical Inference:** The on-disk store (`userData/tenders/tenders-data.json`) and the in-memory renderer Zustand store operate as disconnected data silos. Edits made in the renderer do not persist to disk, and mutations performed by the main process (or other applications like Books) are invisible to the user until an explicit page refresh.
5. **Resolution Requirement:** 
   - A bidirectional IPC synchronization mechanism is required:
     a) On application startup / renderer mount, the renderer must load initial state from `window.tendersApi.getStoredData()`.
     b) Mutations in the renderer Zustand store must automatically trigger a debounced persistence call to `window.tendersApi.saveStoredData()`.
     c) Main process operations that modify `tenders-data.json` must broadcast an IPC event (`tenders:data-changed`) across active Tenders `WebContents`.
     d) The renderer must listen for `tenders:data-changed` and update its in-memory store dynamically, guarded against feedback loops (`isSyncingFromMain` flag).

### 2.2 Seed Data Alignment Requirement
1. *Observation 1.2* shows that `tenders-main.ts:migrateAndValidateTenders` provides fallback seed data containing company `'Zano Consulting'` with empty arrays for `customers` and `vault`.
2. *Observation 1.2* shows that the renderer's `store.ts` provides `seedWorkspaces()` containing company `'Thabo Engineering'`, `MOCK_CUSTOMERS`, and 7 preloaded compliance vault records (`MOCK_VAULT`).
3. **Logical Inference:** If the renderer store is unified with `userData/tenders/tenders-data.json`, initial startup against an empty `tenders-data.json` would overwrite the mock compliance vault with an empty array.
4. **Resolution Requirement:** `tenders-main.ts` and `store.ts` must share identical seed structures, ensuring that `MOCK_VAULT` and company profile information are preserved when initializing fresh user data.

### 2.3 Persistent Disk Storage Architecture (R2)
1. *Observation 1.5* establishes that uploaded PDFs and vault documents use browser `URL.createObjectURL(file)`, which are ephemeral and discarded on reload (`fileUrl: ''` / `null`).
2. *Observation 1.5* confirms that `Workspace.tsx` forces the user to re-attach the PDF whenever `fileUrl` is empty.
3. *Observation 1.5* verifies that sandboxed WebContentsViews (`sandbox: true`, `contextIsolation: true`) cannot directly access the local filesystem via `file://` URLs.
4. In `apps/pdf/src/main/pdf-main.ts:819-824`, PDF files are loaded across the IPC boundary by passing raw bytes (`ArrayBuffer` / `Uint8Array`).
5. In `apps/tenders/src/renderer/src/pdf/extract.ts:17-21`, `loadPdfDocument(data: ArrayBuffer)` accepts an `ArrayBuffer` directly.
6. **Logical Inference:** 
   - File persistence must occur in the Electron main process under designated subdirectories in `app.getPath('userData')`:
     - Tender RFP PDFs: `userData/tenders/documents/${tenderId}.pdf` (or `documents/${tenderId}_${sanitizedFileName}`)
     - Compliance Vault returnables: `userData/tenders/vault/${vaultDocId}.pdf`
   - IPC channels must be introduced:
     - `tenders:save-document`: Transmits file name and `ArrayBuffer` from renderer to main, writing atomically to disk and returning `{ ok: true, storedPath, relativePath }`.
     - `tenders:read-document`: Reads file from disk by ID/type or relative path, returning `ArrayBuffer` to renderer.
     - `tenders:open-document`: Calls `shell.openPath` in main process to open document in system viewer.
     - `tenders:delete-document`: Removes file from disk when tender or vault doc is deleted.
   - Once the renderer receives the `ArrayBuffer`, it can immediately invoke `loadPdfDocument(buf)` and create an in-memory session `URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }))`. Storing the canonical `storedPath` or `id` in `tenders-data.json` ensures that on every application restart, the document automatically re-loads without any "re-attach" prompt.

### 2.4 Complete Cross-App Lifecycle (R3)
1. *Observation 1.6* indicates that `billMilestoneInBooks` updates milestone status to `'BILLED'` in `tenders-data.json` and creates a sales invoice in `books-data.json`.
2. *Observation 1.6* reveals that `books-main.ts:executeReconciliation` marks invoices as `'Paid'`, but never notifies or updates `tenders-data.json`.
3. **Logical Inference:** To satisfy Requirement R3 ("propagate payment state updates back to tender milestones"), `executeReconciliation` (and `markInvoicePaid`) in `books-main.ts` must inspect whether the invoice has an associated `tenderReference` or matches a milestone `billedInvoiceId`. If so, it must update the milestone status to `'PAID'` in `tenders-data.json` and emit the data change notification.
4. Similarly, `syncWithCrm` must save the resulting `crmDealId` back onto `TenderRecord.linkedCrmDealId` in `tenders-data.json`.

---

## 3. Caveats

1. **Security & Path Traversal:**
   - Any IPC handler accepting a file path or document ID to read or delete from disk (`readDocument`, `deleteDocument`) must strictly validate that the resolved path is located within `join(app.getPath('userData'), 'tenders')`. Path traversal sequences (`..`, absolute paths outside userData) must be rejected.
2. **IPC Memory Transfer Overhead:**
   - Transferring very large PDFs (>100 MB) via IPC as `ArrayBuffer` utilizes structured clone in Electron. For typical government RFP PDFs (5 MB to 30 MB), this is sub-50ms and well within memory headroom.
3. **Concurrency & File Locks on Windows:**
   - On Windows, `renameSync` can fail if an active file handle or antivirus scanner holds a temporary lock. The atomic write routine should incorporate a retry loop (e.g. 3 attempts with 20ms backoff) if `EPERM` or `EBUSY` occurs.
4. **Static Demo Files:**
   - Existing mock vault documents reference `/demo/vault/*.pdf` located in `apps/tenders/public/demo/vault/`. The document loader should distinguish between static web demo URLs (`/demo/...`) and disk-stored documents (`storedPath` or `documents/...`).

---

## 4. Conclusion & Architectural Recommendations

### 4.1 Recommended Directory & Storage Layout
```
userData/
└── tenders/
    ├── tenders-data.json             # Core database envelope (schema v1)
    ├── tenders-data.json.bak         # Automatic backup
    ├── documents/                    # RFP PDF storage
    │   ├── tender-wtr-04.pdf
    │   └── t-1788547200000-1.pdf
    └── vault/                        # Compliance Vault returnables
        ├── vd-tax.pdf
        ├── vd-coida.pdf
        └── vd-bbbee.pdf
```

### 4.2 Data Models Update (`apps/tenders/src/shared/types.ts`)
Add storage metadata to `TenderRecord` and `VaultDoc`:
```ts
export interface TenderRecord {
  ...
  storedPath?: string | null           // Relative path, e.g. "documents/tender-wtr-04.pdf"
  originalFileName?: string | null
}

export interface VaultDoc {
  ...
  storedPath?: string | null           // Relative path, e.g. "vault/vd-tax.pdf"
  originalFileName?: string | null
}
```

### 4.3 New IPC Channels (`apps/tenders/src/shared/ipc.ts`)
```ts
export const TENDERS_CHANNELS = {
  // Persistence & Sync
  getStoredData: 'tenders:get-stored-data',
  saveStoredData: 'tenders:save-stored-data',
  dataChanged: 'tenders:data-changed',

  // Document Disk Storage (R2)
  saveDocument: 'tenders:save-document',
  readDocument: 'tenders:read-document',
  openDocument: 'tenders:open-document',
  deleteDocument: 'tenders:delete-document',

  // Cross-App Workflows (R3)
  exportMatrixToSheets: 'tenders:export-matrix-to-sheets',
  draftProposalDoc: 'tenders:draft-proposal-doc',
  syncWithCrm: 'tenders:sync-with-crm',
  openInCrm: 'tenders:open-in-crm',
  billMilestoneInBooks: 'tenders:bill-milestone-in-books',
  openBooks: 'tenders:open-books',
} as const
```

### 4.4 IPC Context Bridge API (`apps/tenders/src/preload/index.ts`)
Expose the complete API to the renderer:
```ts
export interface SaveDocPayload {
  type: 'tender' | 'vault'
  id: string
  fileName: string
  data: ArrayBuffer
}

export interface TendersApi {
  getStoredData: () => Promise<string | null>
  saveStoredData: (json: string) => Promise<boolean>
  onDataChanged: (callback: (data: TendersData) => void) => () => void

  saveDocument: (payload: SaveDocPayload) => Promise<{ ok: boolean; relativePath?: string; error?: string }>
  readDocument: (type: 'tender' | 'vault', id: string) => Promise<ArrayBuffer | null>
  openDocument: (type: 'tender' | 'vault', id: string) => Promise<{ ok: boolean; error?: string }>
  deleteDocument: (type: 'tender' | 'vault', id: string) => Promise<{ ok: boolean }>

  exportMatrixToSheets: (tenderId: string, tenderTitle: string, matrixRows: any[]) => Promise<{ ok: boolean; path?: string; error?: string }>
  draftProposalDoc: (tender: any) => Promise<{ ok: boolean; path?: string; error?: string }>
  syncWithCrm: (dealData: any) => Promise<{ ok: boolean; dealId?: string; error?: string }>
  openInCrm: (dealId?: string) => Promise<{ ok: boolean }>
  billMilestoneInBooks: (tenderIdOrPayload: string | BillMilestoneRequest, milestoneId?: string) => Promise<BillMilestoneResult>
  openBooks: () => Promise<boolean>
}
```

### 4.5 Main Process Handlers Blueprint (`apps/tenders/src/main/tenders-main.ts`)
1. **Document Storage Handlers:**
   ```ts
   function getDocumentsDir(): string {
     const p = join(app.getPath('userData'), 'tenders', 'documents')
     if (!existsSync(p)) mkdirSync(p, { recursive: true })
     return p
   }

   function getVaultDir(): string {
     const p = join(app.getPath('userData'), 'tenders', 'vault')
     if (!existsSync(p)) mkdirSync(p, { recursive: true })
     return p
   }

   // Handler: tenders:save-document
   ipcMain.handle(TENDERS_CHANNELS.saveDocument, async (_e, { type, id, fileName, data }: SaveDocPayload) => {
     try {
       const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_')
       const baseDir = type === 'tender' ? getDocumentsDir() : getVaultDir()
       const targetFile = join(baseDir, `${safeId}.pdf`)
       writeFileSync(targetFile, Buffer.from(data))
       const relativePath = `${type === 'tender' ? 'documents' : 'vault'}/${safeId}.pdf`
       return { ok: true, relativePath }
     } catch (err: any) {
       return { ok: false, error: err?.message }
     }
   })

   // Handler: tenders:read-document
   ipcMain.handle(TENDERS_CHANNELS.readDocument, async (_e, type: 'tender' | 'vault', id: string) => {
     try {
       const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_')
       const baseDir = type === 'tender' ? getDocumentsDir() : getVaultDir()
       const targetFile = join(baseDir, `${safeId}.pdf`)
       if (!existsSync(targetFile)) return null
       const buf = readFileSync(targetFile)
       return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
     } catch {
       return null
     }
   })

   // Handler: tenders:open-document
   ipcMain.handle(TENDERS_CHANNELS.openDocument, async (_e, type: 'tender' | 'vault', id: string) => {
     try {
       const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_')
       const baseDir = type === 'tender' ? getDocumentsDir() : getVaultDir()
       const targetFile = join(baseDir, `${safeId}.pdf`)
       if (existsSync(targetFile)) {
         await shell.openPath(targetFile)
         return { ok: true }
       }
       return { ok: false, error: 'File not found on disk' }
     } catch (err: any) {
       return { ok: false, error: err?.message }
     }
   })
   ```

2. **Broadcast Function for Main-Renderer Sync:**
   ```ts
   export function broadcastTendersData(data: TendersData): void {
     for (const wc of webContents.getAllWebContents()) {
       if (!wc.isDestroyed()) {
         try {
           wc.send(TENDERS_CHANNELS.dataChanged, data)
         } catch {}
       }
     }
   }
   ```
   Call `broadcastTendersData(tendersData)` whenever `writeTendersStore` modifies data.

### 4.6 Renderer Store Synchronization Blueprint (`apps/tenders/src/renderer/src/store.ts`)
1. **Hydrate from IPC on Mount:**
   Add `initFromMain()`:
   ```ts
   initFromMain: async () => {
     if (window.tendersApi?.getStoredData) {
       const json = await window.tendersApi.getStoredData()
       if (json) {
         const parsed = JSON.parse(json) as TendersData
         if (parsed && Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) {
           set({
             workspaces: parsed.workspaces,
             activeCompanyId: parsed.activeCompanyId || parsed.workspaces[0].id,
             issuerTemplates: parsed.issuerTemplates || [],
             ...deriveViews(parsed.workspaces, parsed.activeCompanyId || parsed.workspaces[0].id)
           })
         }
       }
     }
   }
   ```
2. **Listen for Remote Main Updates:**
   ```ts
   if (window.tendersApi?.onDataChanged) {
     window.tendersApi.onDataChanged((data) => {
       isSyncingFromMain = true
       set({
         workspaces: data.workspaces,
         activeCompanyId: data.activeCompanyId,
         issuerTemplates: data.issuerTemplates,
         ...deriveViews(data.workspaces, data.activeCompanyId)
       })
       isSyncingFromMain = false
     })
   }
   ```
3. **Persist Mutated State to Main IPC:**
   Debounce `window.tendersApi.saveStoredData(JSON.stringify(envelope))` whenever `workspaces` or company settings mutate, skipping if `isSyncingFromMain === true`.

### 4.7 Seamless Document Opening (`apps/tenders/src/renderer/src/components/Workspace.tsx`)
In `Workspace.tsx` line 52:
```ts
useEffect(() => {
  if (!tender) return
  let cancelled = false
  let loaded: PDFDocumentProxy | null = null

  ;(async () => {
    let buf: ArrayBuffer | null = null
    // 1. Try reading persistent disk storage via IPC
    if (window.tendersApi?.readDocument) {
      buf = await window.tendersApi.readDocument('tender', tender.id)
    }
    // 2. Fall back to tender.fileUrl if present
    if (!buf && tender.fileUrl) {
      const res = await fetch(tender.fileUrl)
      buf = await res.arrayBuffer()
    }
    if (!buf) {
      if (!cancelled) setDoc(null)
      return
    }
    loaded = await loadPdfDocument(buf)
    if (!cancelled) setDoc(loaded)
  })().catch(() => {
    if (!cancelled) setDocError('Could not open the tender PDF in the viewer.')
  })

  return () => {
    cancelled = true
    void loaded?.cleanup().catch(() => {})
  }
}, [tender?.id, tender?.storedPath, tender?.fileUrl])
```
This guarantees that after app restarts, the PDF viewer automatically reopens the persistent file without prompting the user.

---

## 5. Verification Method

### 5.1 Automated Test Execution
To independently verify the implementation once coded:
1. **Workflows E2E Test Suite:**
   ```bash
   node tools/verify-suite-workflows.mjs
   ```
   *Expected outcome:* All 56 tests pass with exit code 0.

2. **Dedicated Tenders Unit & Integration Tests (R4):**
   ```bash
   npm run test -w @genoffice/tenders
   ```
   *Verification:* Vitest executes unit tests covering store schema migrations, atomic writes, corrupted file recovery, RFP shredder heuristics, compliance gap calculations, and IPC handlers.

3. **TypeScript Typecheck:**
   ```bash
   npm run typecheck -w @genoffice/tenders
   npm run typecheck
   ```
   *Verification:* Exits cleanly with zero errors across all 22 monorepo packages.

4. **Brand Integrity Check:**
   ```bash
   npm run check:brand
   ```
   *Verification:* 0 unauthorized upstream brand occurrences.

### 5.2 Manual / Behavioral Invalidation Conditions
The solution is invalid if:
* Creating or updating a tender in the renderer does not immediately update `userData/tenders/tenders-data.json`.
* Triggering `billMilestoneInBooks` in the backend updates `tenders-data.json` on disk but the active Tenders UI does not immediately reflect the `'BILLED'` status and invoice number.
* Uploading an RFP PDF or vault document does not create a corresponding `.pdf` file on disk under `userData/tenders/documents/` or `userData/tenders/vault/`.
* Quitting the application and relaunching leaves the tender PDF in a `"PDF file not attached"` state.
* Reconciling a payment in Books linked to a tender invoice fails to update the tender milestone to `'PAID'` in `tenders-data.json`.

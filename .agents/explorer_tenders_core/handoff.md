# Handoff Report: Investigation of Zanostack Tenders Frontend & Core Domain Logic

## 1. Observation

Direct code observations from the `apps/tenders` codebase, Electron main process, preload bridge, and renderer components:

### 1.1 Zustand Store Implementation & Electron State Synchronization
- **File**: `apps/tenders/src/renderer/src/store.ts`
  - **Store Creation**: Line 216 uses `create<TendersState>()(persist((set, get) => { ... }, { name: 'zanostack-tenders-v1', version: 1, ... }))`.
  - **Storage Medium**: Uses default Zustand `persist` middleware, which serializes to renderer browser `localStorage` under the key `'zanostack-tenders-v1'`. It does **not** read from or write to `userData/tenders/tenders-data.json`.
  - **Initial State Loading**: Lines 240–241: Initial state is seeded from `seedWorkspaces()` (lines 181–191), defining `SEED_COMPANY_ID = 'co-thabo'`, `MOCK_COMPANY` (Thabo Engineering), `MOCK_CUSTOMERS`, `MOCK_VAULT`, and `[SEED_TENDER_WTR_04]`.
  - **State Updates**: Handled via internal helper `patchActive` (lines 225–238), which updates in-memory React state and triggers `localStorage` re-serialization.
  - **IPC Storage Handlers Not Called**: Grep across `apps/tenders/src/renderer` confirms that `window.tendersApi.getStoredData` and `window.tendersApi.saveStoredData` are **never** invoked anywhere in the renderer.
  - **Transient / Dead Blob URL Stripping**:
    - Lines 427–432 (`partialize`):
      ```typescript
      tenders: ws.tenders.map((t) => ({ ...t, fileUrl: '' })),
      vault: ws.vault.map((d) =>
        d.fileUrl?.startsWith('blob:') ? { ...d, fileUrl: null } : d
      )
      ```
    - Lines 454–462 (`onRehydrateStorage`):
      ```typescript
      state.workspaces = state.workspaces.map((ws) => ({
        ...ws,
        tenders: ws.tenders.map((t) => ({ ...t, fileUrl: '' })),
        vault: ws.vault.map((d) =>
          d.fileUrl?.startsWith('blob:') ? { ...d, fileUrl: null } : d
        )
      }))
      ```
  - **Discrepancy with Electron Backend Fallback**:
    - In `apps/tenders/src/main/tenders-main.ts` (lines 59–88), the backend fallback schema uses `activeCompanyId: 'comp-zano-01'`, workspace `'ws-ekurhuleni-01'` with `'Zano Consulting (Pty) Ltd'`, and `vault: []`.
    - In renderer `store.ts` (lines 179–191), the seed uses `'co-thabo'` with `'Thabo Engineering (Pty) Ltd'` and full `MOCK_VAULT`.

### 1.2 Electron IPC & Milestone Billing Asynchrony
- **File**: `apps/tenders/src/main/tenders-main.ts`
  - Lines 206–228 implement `ipcMain.handle(TENDERS_CHANNELS.getStoredData, ...)` and `ipcMain.handle(TENDERS_CHANNELS.saveStoredData, ...)`, reading and writing `userData/tenders/tenders-data.json`.
  - Lines 434–652 implement `TENDERS_CHANNELS.billMilestoneInBooks`:
    - Lines 623–631 update milestone status to `'BILLED'`, assign `billedInvoiceId` and `billedInvoiceNumber`, and persist to disk via `writeTendersStore(tendersPath, tendersData)`.
    - There are **no** `webContents.send()` or broadcast events emitted to the renderer.
  - In `apps/tenders/src/renderer/src/components/Workspace.tsx` (lines 267–284) and `MilestonesDrawer.tsx` (lines 42–61):
    - Clicking "Bill Milestone in Zano Books" awaits `window.tendersApi?.billMilestoneInBooks(...)`.
    - The renderer manually patches its local Zustand store with `updateTender(...)`.
    - However, if milestone billing is triggered externally (e.g. from Books, CLI integration, or cross-tab sync), or if Books records payment (`status: 'PAID'`), the renderer has no listener and cannot update live without a full reload or manual refresh.

### 1.3 RFP Shredder Heuristics & Determinism
- **Files**:
  - `apps/tenders/src/renderer/src/pdf/extract.ts`
  - `apps/tenders/src/renderer/src/pdf/clauses.ts`
  - `apps/tenders/src/renderer/src/pdf/shred.ts`
  - `apps/tenders/src/shared/rules.ts`
- **Text Extraction Pipeline**:
  - `extractSinglePage` in `extract.ts` uses `pdfjs-dist/legacy/build/pdf.mjs`. It extracts character rects, applies viewport transformation matrices (`pdfjs.Util.applyTransform`), and clusters them into lines using vertical tolerance `Math.max(2, Math.min(it.height, cluster[0].height) * 0.5)` (lines 105–113).
  - Line coordinates are normalized `0.0–1.0` relative to viewport width/height.
- **Clause Reconstruction**:
  - `pageClauses` in `clauses.ts` stitches lines into complete sentences.
  - Splits clauses when encountering an empty line, a large vertical gap (`largeGap: next.box.top - prevBottom > prev.box.height * 2.5`), an ALL-CAPS heading (`isHeading`: length 4–90, uppercase ratio > 0.7), list start (`STARTS_BLOCK_RE: /^(?:[-•*·]|\d{1,2}[.)]|[a-z][.)])\s+/`), sentence punctuation (`endsSentence: /[.!?]["')\]]?$/`), or max length (`MAX_CLAUSE_CHARS = 600`).
  - Merges bounding boxes via `unionBox` (lines 31–37).
- **Rule Matching & Scoring**:
  - `shredExtraction` in `shred.ts` tests all reconstructed clauses against the 35 rules in `TENDER_RULES`.
  - Discards clauses matching `rule.negative` regexes (line 77).
  - Calculates deterministic sentence scores (lines 45–54):
    ```typescript
    function clauseScore(text: string): number {
      return (
        (MANDATORY_LANGUAGE.test(text) ? 3 : 0) +
        (DISQUALIFIER_LANGUAGE.test(text) ? 2 : 0) +
        Math.min(text.length / 240, 1)
      )
    }
    ```
  - Discards near-duplicates across sections using `similarText` Jaccard-like word overlap (>0.7 threshold).
  - Calculates confidence (lines 115–121):
    `Math.min(0.55 + Math.min(best.score / 6, 0.25) + corroboration + (allPages.size > 1 ? 0.1 : 0), 1)`.
  - Metadata Extraction (`extractTenderMeta` in `shred.ts` lines 278–331):
    - Evaluates page 1 for `TITLE_HEADING`, `REF_RE`, `ISSUING_HINT`, `CLOSING_RE`.
    - `extractSubmissionLogistics` (lines 181–224) tests `SUBMIT_HINT`, `EMAIL_RE`, `BID_BOX_RE`, `PORTAL_RE`, and `ADDRESS_TAIL_RE` to determine `submissionMethod` (`'PHYSICAL' | 'ELECTRONIC' | 'EMAIL'`) and drop-off address.
  - **Determinism**: The pipeline is completely deterministic: given identical PDF byte arrays or text extractions, it yields identical requirements, bounding boxes, scores, and metadata.

### 1.4 Compliance Gap Analysis Logic
- **File**: `apps/tenders/src/renderer/src/gap.ts`
  - **Document Health Assessment** (`assessDocHealth`, lines 29–47):
    - Compares `doc.expiryDate` against reference date: if `daysUntilExpiry < 0` => `health = 'EXPIRED'`.
    - If `doc.isCertified` and `certifiedDate` is set: compares against `POLICE_STAMP_WINDOW_DAYS = 90`. If `stampDaysLeft < 0` => `health = 'STALE_CERTIFICATION'`.
    - If no dates: `health = 'NO_EXPIRY_INFO'`. Otherwise `health = 'VALID'`.
  - **Vault Matching** (`matchVaultDocsWithConfidence`, lines 84–116):
    - Matches rule keywords (`rule.vaultHints.keywords`) against `doc.title.toLowerCase()`.
    - Base confidence: `Math.min(0.35 + hits.length * 0.2, 0.8) * (0.7 + 0.3 * coverage)`.
    - Category agreement bonus: `+0.15` if `doc.category === hintCategory`, `-0.20` penalty if conflicting.
  - **Auto-Linking & Status Assignment** (`applyGapToRequirement`, lines 131–188):
    - Threshold: `AUTO_LINK_THRESHOLD = 0.5`.
    - If no matches: `status = 'OUTSTANDING'`, reason notes missing document.
    - If top match `< 0.5`: `status = 'OUTSTANDING'`, reason prompts manual verification.
    - If matches `>= 0.5`: sorts by `HEALTH_RANK` (`VALID` = 3 > `NO_EXPIRY_INFO` = 2 > `STALE_CERTIFICATION` = 1 > `EXPIRED` = 0) then earliest expiry date.
    - Status assigned:
      - If best doc is `EXPIRED` or `STALE_CERTIFICATION`: `status = 'ACTION_REQUIRED'`.
      - Otherwise: `status = 'FULFILLED'`.
    - Sets `linkedVaultDocId = best.doc.id`.

### 1.5 Tender Milestones, Returnables & Documents Data Modeling
- **File**: `apps/tenders/src/shared/types.ts`
  - `TenderRecord` (lines 153–172): Contains `id`, `title`, `referenceNumber`, `issuingBody`, `closingDate`, `submissionMethod`, `submissionAddress`, `signatureChecks: Record<string, boolean>`, `status: TenderStatus`, `fileName`, `fileUrl`, `numPages`, `ocrPages`, `requirements: RequirementRecord[]`, `milestones?: ContractMilestone[]`, `estimatedValue?: number | null`, `linkedCrmDealId?: string | null`.
  - `ContractMilestone` (lines 177–190): `id`, `name`, `title?`, `description?`, `amount: number`, `dueDate?`, `completedDate?`, `status: MilestoneBillingStatus` (`'PENDING' | 'REACHED' | 'BILLED' | 'PAID'`), `billedInvoiceId?`, `billedInvoiceNumber?`, `billedAt?`, `billedDate?`.
  - `RequirementRecord` (lines 131–137): Extends `ExtractedRequirement` with `status: FulfillmentStatus`, `linkedVaultDocId: string | null`, `reason: string | null`, `suggestedVaultDocIds: string[]`.
  - `VaultDoc` (lines 141–151): `id`, `title`, `category: DocCategory`, `fileUrl: string | null`, `issueDate: string | null`, `expiryDate: string | null`, `isCertified: boolean`, `certifiedDate: string | null`, `metadata: Record<string, string>`.
  - `TendersData` (lines 215–221): Top-level envelope matching `tenders-data.json`: `version: number`, `updatedAt: string`, `activeCompanyId: string`, `workspaces: CompanyWorkspace[]`, `issuerTemplates: IssuerTemplate[]`.

### 1.6 Document Upload, Vault Returnables & PDF Handling
- **Blob URLs in Renderer**:
  - `apps/tenders/src/renderer/src/components/TenderList.tsx` (line 84): `const url = URL.createObjectURL(file); buildTenderRecord(..., url, ...)`.
  - `apps/tenders/src/renderer/src/components/Workspace.tsx` (line 98): `const url = URL.createObjectURL(file); updateTender(tender.id, { fileUrl: url, fileName: file.name })`.
  - `apps/tenders/src/renderer/src/components/pages/DocumentsPage.tsx` (lines 108, 122): `fileUrl: data.file ? URL.createObjectURL(data.file) : editDoc.fileUrl` and `fileUrl: data.file ? URL.createObjectURL(data.file) : null`.
  - `apps/tenders/src/renderer/src/components/VaultDrawer.tsx` (line 126): `<a href={doc.fileUrl} target="_blank">View PDF</a>`.
  - `apps/tenders/src/renderer/src/components/pages/DocumentsPage.tsx` (line 388): `<a href={doc.fileUrl} target="_blank">Open PDF</a>`.
- **Re-Attach Warning on Reload**:
  - In `Workspace.tsx` (lines 324–350), whenever `tender.fileUrl` is empty (which happens automatically on reload because of `partialize`), the UI renders:
    *"Re-attach the tender PDF. The original file link expired when the page reloaded. Pick the PDF again to view it here — your compliance matrix is untouched."*

---

## 2. Logic Chain

1. **Root Cause of Renderer Desynchronization (R1)**:
   - Observation 1.1 shows that `useTendersStore` uses `localStorage` exclusively.
   - Observation 1.1 shows that `getStoredData` and `saveStoredData` IPC channels are defined in `ipc.ts` and `tenders-main.ts` but never called by the React renderer.
   - Observation 1.2 shows that `billMilestoneInBooks` in `tenders-main.ts` updates `userData/tenders/tenders-data.json` on disk, but never notifies the renderer via IPC webContents.
   - *Inference*: Changes made to `tenders-data.json` (by external tools, cross-app operations, or Books) are never propagated to renderer memory. Conversely, tender edits made in the renderer never persist to `tenders-data.json`. This causes a total split-brain between disk storage and renderer state.

2. **Root Cause of PDF & Vault Attachment Expiration (R2)**:
   - Observation 1.6 shows that `TenderList.tsx`, `DocumentsPage.tsx`, and `Workspace.tsx` use `URL.createObjectURL(file)`.
   - Object URLs are scoped to the browser DOM document session and become invalid upon document reload.
   - Knowing this, `store.ts` intentionally purges `tenders.fileUrl` to `''` and `vault.fileUrl` to `null` in both `partialize` and `onRehydrateStorage`.
   - *Inference*: To satisfy Acceptance Criterion R2 ("Stored documents must remain accessible across application restarts, replacing transient session-only blob URLs with durable local file paths or managed IPC retrieval"), the app must store binary files on disk under `userData/tenders/` and reference durable paths or IDs that survive restarts.

3. **Determinism of Heuristics & Gap Analysis (R4)**:
   - Observations 1.3 and 1.4 confirm that text line grouping, clause joining, rule scoring, confidence calculation, metadata extraction, doc health checks, and gap linking use pure, deterministic algorithms without random seeds, external APIs, or non-deterministic state.
   - `pdfjs-dist/legacy/build/pdf.mjs` runs in Node.js, meaning test scripts can run extraction and shredder assertions directly in Vitest or Node test runners without requiring an Electron window.

---

## 3. Caveats

- **No Active Tests in `apps/tenders`**: Currently, `apps/tenders` has 0 automated tests (`apps/tenders/tests` does not exist). The root `package.json` test script does not invoke tests for `@genoffice/tenders`.
- **Browser-Only Dev Mode**: In Vite renderer standalone dev mode (`npm run dev:renderer`), `window.tendersApi` is undefined. State persistence and file operations must feature graceful fallback so the frontend continues to work in standalone web preview while enabling full IPC persistence in Electron.
- **File System Permissions**: On Windows, saving files inside `userData/tenders/` must ensure atomic writes (write to `.tmp` file and rename) to prevent file-lock contention with antivirus or concurrent processes.

---

## 4. Conclusion & Specific Recommendations

To implement Requirements R1, R2, and R4, the following architectural implementations are recommended:

### Recommendation for R1: Unified Main-Renderer State Synchronization
1. **Renderer Store Initialization & Persistence Bridge**:
   - In `apps/tenders/src/renderer/src/store.ts`:
     - Add `loadFromMain`: Invokes `window.tendersApi.getStoredData()`. If valid data is returned, rehydrates `workspaces`, `activeCompanyId`, and derived slices (`company`, `customers`, `vault`, `tenders`). If `null`, writes the default seed to disk via `window.tendersApi.saveStoredData(JSON.stringify(envelope))`.
     - In `patchActive` and tender update actions: Call a debounced `saveToMain(get())` that serializes current state to `window.tendersApi.saveStoredData`.
     - Harmonize seed company data between `tenders-main.ts` and `store.ts` so both use `SEED_TENDER_WTR_04` and `MOCK_VAULT`.
2. **Push Event Channel for Live Sync**:
   - In `apps/tenders/src/shared/ipc.ts`: Add `dataUpdated: 'tenders:data-updated'`.
   - In `apps/tenders/src/main/tenders-main.ts`:
     - Maintain a set of active `WebContents` from `createTendersView()`.
     - In `writeTendersStore` and `billMilestoneInBooks`: Broadcast the updated `TendersData` to all active WebContents:
       `wc.send('tenders:data-updated', tendersData)`.
   - In `apps/tenders/src/preload/index.ts`:
     - Expose `onDataUpdated: (cb: (data: TendersData) => void) => () => void`.
   - In `apps/tenders/src/renderer/src/components/App.tsx`:
     - In a top-level `useEffect`:
       ```typescript
       useEffect(() => {
         void useTendersStore.getState().loadFromMain()
         const unsub = window.tendersApi?.onDataUpdated?.((data) => {
           useTendersStore.getState().syncFromMain(data)
         })
         return () => unsub?.()
       }, [])
       ```

### Recommendation for R2: Persistent Disk Storage for RFP PDFs & Vault Returnables
1. **Electron Main Process File Storage**:
   - In `apps/tenders/src/shared/ipc.ts`, define:
     - `saveDocumentFile: 'tenders:save-document-file'`
     - `readDocumentFile: 'tenders:read-document-file'`
     - `openDocumentFile: 'tenders:open-document-file'`
   - In `apps/tenders/src/main/tenders-main.ts`:
     - Create storage directories `userData/tenders/rfps` and `userData/tenders/vault`.
     - Handler `saveDocumentFile(fileName: string, buffer: ArrayBuffer, type: 'rfp' | 'vault')`:
       Saves the file to `join(app.getPath('userData'), 'tenders', type, `${Date.now()}_${sanitizedFileName}`)` and returns the relative path `rfps/...` or `vault/...`.
     - Handler `readDocumentFile(relativePath: string)`:
       Reads the file from `join(app.getPath('userData'), 'tenders', relativePath)` and returns `ArrayBuffer`.
     - Handler `openDocumentFile(relativePath: string)`:
       Calls `electron.shell.openPath` with the resolved absolute path.
2. **Renderer Integration**:
   - In `TenderList.tsx`: When a PDF is selected, read `const buffer = await file.arrayBuffer()`, invoke `saveDocumentFile`, and store the resulting relative path in `tender.fileUrl`.
   - In `DocumentsPage.tsx`: When a vault doc is uploaded, call `saveDocumentFile`, and store the relative path in `doc.fileUrl`.
   - In `store.ts`:
     - Modify `partialize` and `onRehydrateStorage`: Do **not** wipe `fileUrl` if it contains a durable path (only blank if it strictly starts with `'blob:'`).
   - In `Workspace.tsx`:
     - In the `useEffect` that loads the PDF into pdfjs:
       ```typescript
       let buf: ArrayBuffer
       if (tender.fileUrl.startsWith('blob:') || tender.fileUrl.startsWith('http')) {
         const res = await fetch(tender.fileUrl)
         buf = await res.arrayBuffer()
       } else if (window.tendersApi?.readDocumentFile) {
         buf = await window.tendersApi.readDocumentFile(tender.fileUrl)
       }
       const loaded = await loadPdfDocument(buf)
       ```
     - This completely eliminates the "Re-attach the tender PDF" error on reload!

### Recommendation for R4: Automated Test Suite for `apps/tenders`
1. Add test suite in `apps/tenders/tests/`:
   - `shredder.test.ts`: Verify sentence stitching (`clauses.ts`), deterministic scoring, pattern matching, and metadata extraction against sample RFP texts.
   - `gap.test.ts`: Verify `assessDocHealth`, 90-day police stamp expiry, keyword matching, confidence scores, and auto-linking thresholds (`AUTO_LINK_THRESHOLD = 0.5`).
   - `store-sync.test.ts`: Verify `migrateAndValidateTenders`, atomic file persistence, IPC store synchronization, and milestone billing updates.
2. Add `"test": "vitest run"` in `apps/tenders/package.json` and register it in root `package.json` `"test"` script.

---

## 5. Verification Method

To independently verify these findings:
1. **Store Inspection**:
   - Inspect `apps/tenders/src/renderer/src/store.ts`: lines 427–432 and 456–462 confirm blob URLs are blanked on partialize/rehydrate.
   - Inspect lines 216–238: confirms state is stored only in `localStorage`.
2. **Missing IPC Invocations**:
   - Run grep command:
     `git grep "getStoredData" apps/tenders/src/renderer`
     `git grep "saveStoredData" apps/tenders/src/renderer`
     (Both return 0 matches in renderer source code).
3. **Blob URL Search**:
   - Run grep command:
     `git grep "createObjectURL" apps/tenders/src/renderer`
     (Returns matches in `TenderList.tsx:84`, `DocumentsPage.tsx:108,122`, `Workspace.tsx:98`).
4. **Automated Verification Runner**:
   - Execute the workspace test script:
     `node tools/verify-suite-workflows.mjs --feature r3`
     Confirms that backend milestone billing modifies `userData/tenders/tenders-data.json`, but currently does not sync to active renderer memory without reloading.

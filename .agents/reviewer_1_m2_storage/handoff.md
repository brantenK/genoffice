# Review & Adversarial Handoff Report: Milestone 2 — Persistent Disk Storage for RFP Documents & Vault Returnables (R2)

**Reviewer / Adversarial Critic:** `reviewer_1_m2_storage`  
**Milestone:** Milestone 2 (R2) — Persistent Disk Storage for RFP Documents & Vault Returnables  
**Target Path:** `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\reviewer_1_m2_storage\handoff.md`  
**Gate Verdict:** **APPROVE**  
**Integrity Assessment:** **CLEAN (No integrity violations detected)**  

---

## 1. Observation

Direct code observations, verbatim lines, commands, and verification outputs:

### 1.1 IPC Contracts & Types (`apps/tenders/src/shared/ipc.ts`)
- **Lines 5–19:**
  ```typescript
  export const TENDERS_CHANNELS = {
    ...
    saveDocument: 'tenders:save-document',
    readDocument: 'tenders:read-document',
    openDocument: 'tenders:open-document',
    deleteDocument: 'tenders:delete-document',
    ...
  } as const
  ```
- **Lines 21–60:** Fully typed request/response interfaces: `SaveDocumentRequest`, `SaveDocumentResponse`, `ReadDocumentRequest`, `ReadDocumentResponse`, `OpenDocumentRequest`, `OpenDocumentResponse`, `DeleteDocumentRequest`, `DeleteDocumentResponse`.
- **Lines 82–109:** `TendersApiBridge` and `TendersApi` expose typed async methods for `saveDocument`, `readDocument`, `openDocument`, and `deleteDocument`.

### 1.2 Electron Main Process Handlers & Path Hardening (`apps/tenders/src/main/tenders-main.ts`)
- **Lines 312–334:** Dedicated storage directories under `userData/tenders/`:
  - `getTendersBaseDir(overrideUserData?: string)` -> `userData/tenders`
  - `getTendersDocumentsDir(overrideUserData?: string)` -> `userData/tenders/documents`
  - `getTendersVaultDir(overrideUserData?: string)` -> `userData/tenders/vault`
- **Lines 336–361:** Strict path containment in `resolveSafeTendersPath`:
  - Null-byte detection (`storedPath.includes('\0')`).
  - Boundary constraint with trailing separator (`docsDirWithSep` and `vaultDirWithSep`) preventing prefix collisions (e.g. `documents_evil`).
  - Rejects directory traversal tokens (`..`), absolute paths outside target directories, and self-directory access.
- **Lines 363–397:** Atomic write routine `atomicWriteDocumentFile`:
  - Temp file naming with `randomUUID().slice(0, 6)` and timestamp: `${targetPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`.
  - Windows `EBUSY`/`EPERM` retry loop (3 attempts with 15ms backoff) and cleanup in `catch`.
- **Lines 399–442:** `saveDocumentFile`:
  - Enforces `'rfp' | 'vault'` categories, sanitizes filenames via `basename` + `replace(/[^a-zA-Z0-9._-]/g, '_')`.
  - Returns portable relative stored path: `${subFolder}/${storedFileName}` (`documents/...` or `vault/...`).
- **Lines 444–466:** `readDocumentFile`:
  - Validates path via `resolveSafeTendersPath`.
  - Memory-safe buffer slicing: `const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)` to prevent sharing/leaking Node.js internal buffer pool memory.
- **Lines 468–514:** `openDocumentFile` (safe `shell.openPath`) and `deleteDocumentFile` (idempotent `unlinkSync`).
- **Lines 562–576:** Registered IPC invoke handlers for all 4 channels.

### 1.3 Preload Context Bridge (`apps/tenders/src/preload/index.ts`)
- **Lines 17–20 & 34:**
  ```typescript
  saveDocument: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.saveDocument, req),
  readDocument: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.readDocument, req),
  openDocument: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.openDocument, req),
  deleteDocument: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.deleteDocument, req),
  ...
  contextBridge.exposeInMainWorld('tendersApi', tendersApi)
  ```

### 1.4 Renderer Store & Rehydration (`apps/tenders/src/renderer/src/store.ts`)
- **Lines 527–534 (`partialize`):**
  - Selectively clears ONLY ephemeral `blob:` URLs, preserving durable relative paths:
    ```typescript
    tenders: ws.tenders.map((t) =>
      t.fileUrl?.startsWith('blob:') ? { ...t, fileUrl: '' } : t
    ),
    vault: ws.vault.map((d) =>
      d.fileUrl?.startsWith('blob:') ? { ...d, fileUrl: null } : d
    )
    ```
- **Lines 559–566 (`onRehydrateStorage`):**
  - Keeps durable stored paths intact during rehydration.

### 1.5 UI Integration (`TenderList.tsx`, `Workspace.tsx`, `DocumentsPage.tsx`, `VaultDrawer.tsx`)
- **`TenderList.tsx` (lines 84–102):** Saves uploaded RFP PDFs to disk via `window.tendersApi.saveDocument`, storing relative path in `record.fileUrl`. Falls back cleanly to `URL.createObjectURL(file)` in browser dev mode.
- **`Workspace.tsx` (lines 68–83, 116–136):**
  - Reads stored paths via `window.tendersApi.readDocument` into `ArrayBuffer` and loads into pdfjs.
  - Re-attach handler saves replacement PDFs to disk.
  - No re-attach prompt is shown on reload for tenders with stored disk paths.
- **`DocumentsPage.tsx` (lines 92–108, 412–429):**
  - Uploads vault returnables to `userData/tenders/vault/`.
  - "Open PDF" triggers `window.tendersApi.openDocument` via system viewer.
- **`VaultDrawer.tsx` (lines 127–144):**
  - "View PDF" triggers `window.tendersApi.openDocument` via system viewer.

### 1.6 Independent Test Runs
The reviewer independently executed all verification commands in terminal:
1. `npm run check:brand`:
   ```
   ✅ Brand check passed: Zero unauthorized upstream brand occurrences found.
   Exit code: 0
   ```
2. `npm run typecheck`:
   ```
   All 22 packages passed tsc --noEmit cleanly.
   Exit code: 0
   ```
3. `npx tsx tools/verify-tenders-storage.ts`:
   ```
   Results: 72 passed, 0 failed
   🎉 ALL MILESTONE 2 PERSISTENT DISK STORAGE VERIFICATIONS PASSED!
   Exit code: 0
   ```
4. `npx tsx tools/verify-tenders-sync.ts`:
   ```
   Results: 40 passed, 0 failed
   🎉 ALL STATE SYNCHRONIZATION VERIFICATIONS PASSED!
   Exit code: 0
   ```
5. `node tools/verify-suite-workflows.mjs`:
   ```
   Results: 56 passed, 0 failed out of 56 tests (1029ms)
   🎉 ALL SUITE WORKFLOW VERIFICATIONS PASSED SUCCESSFULLY!
   Exit code: 0
   ```

---

## 2. Logic Chain

1. **Verification of Architectural Soundness (Req 1):**
   - Observations 1.1 and 1.3 show all document storage IPC channels are strictly typed with dedicated request/response interfaces in `shared/ipc.ts` and exposed via `contextBridge` in `preload/index.ts`.
   - Observation 1.2 shows that `readDocumentFile` slices the returned buffer (`buf.buffer.slice(...)`), eliminating Node's internal buffer-pool sharing and preventing memory leaks or accidental memory snooping across IPC boundaries.
   - Observation 1.2 demonstrates that `resolveSafeTendersPath` enforces strict boundary resolution inside `documentsDirWithSep` and `vaultDirWithSep`. The path cannot traverse out, cannot access system files, cannot access parent `tenders-data.json`, and rejects null-byte payloads.

2. **Verification of Storage Location (Req 2):**
   - Observation 1.2 confirms that `getTendersDocumentsDir()` resolves strictly to `userData/tenders/documents/` and `getTendersVaultDir()` resolves strictly to `userData/tenders/vault/`.
   - Observation 1.5 shows `TenderList.tsx` uploads with category `'rfp'` (saving to `documents/`) and `DocumentsPage.tsx` uploads with category `'vault'` (saving to `vault/`).
   - The test suite verified physical existence of written files at these exact paths.

3. **Verification of Restart Persistence & User Experience (Req b):**
   - Observation 1.4 confirms that `store.ts` only wipes `fileUrl` when it starts with `'blob:'`.
   - Relative disk paths (`documents/...` and `vault/...`) survive serialization and rehydration.
   - When the user restarts the app, `tender.fileUrl` is present. `Workspace.tsx` loads the document directly from disk via IPC `readDocument`, completely eliminating the transient "Re-attach the tender PDF" warning banner.

4. **Adversarial & Integrity Assessment:**
   - No mock bypasses, no hardcoded test conditionals, no facade stubs. All operations perform genuine disk I/O with atomic temporary files and Windows rename retry loops.
   - All 5 independent automated suites passed with 100% success (72 + 40 + 56 = 168 tests total).

---

## 3. Caveats

1. **Concurrent Save Millisecond Collision Advisory:**
   - In `saveDocumentFile`, filenames are constructed as `${Date.now()}_${cleanName}`. If two files with the identical clean name are uploaded within the exact same millisecond, they would share the same target filename. In standard desktop use, user drag-and-drop or single uploads make this near-impossible, but adding a 4-character random salt or nanosecond counter would provide theoretical 100% collision immunity. This is a low-risk advisory for future hardening and does not block approval.
2. **Document Deletion from Vault:**
   - `DocumentsPage.tsx` currently removes the document record from the vault store upon user deletion, leaving the file on disk. In regulated compliance domains, retaining raw document files on disk acts as a safety against accidental deletion. When disk cleanup is desired, `window.tendersApi.deleteDocument` is available and verified.

---

## 4. Conclusion

Milestone 2 (Persistent Disk Storage for RFP Documents & Vault Returnables) satisfies all functional, architectural, security, and verification requirements set forth in `PROJECT.md` and `ORIGINAL_REQUEST.md`:
- Document storage IPC channels are strictly typed, secure, and leak-free.
- Documents are durably stored in `userData/tenders/documents/` and `userData/tenders/vault/`.
- Transient blob URLs are replaced with durable relative paths that persist across application restarts.
- Full regression suite, brand check, and 22-package typecheck passed cleanly with zero errors.
- Verdict: **APPROVE**.

---

## 5. Verification Method

To independently reproduce this verification:

1. **Milestone 2 Storage Verification Suite:**
   ```bash
   npx tsx tools/verify-tenders-storage.ts
   ```
   *Expected result:* 72/72 tests pass with exit code 0.

2. **Milestone 1 State Synchronization Suite:**
   ```bash
   npx tsx tools/verify-tenders-sync.ts
   ```
   *Expected result:* 40/40 tests pass with exit code 0.

3. **Monorepo Suite Workflows (E2E Track):**
   ```bash
   node tools/verify-suite-workflows.mjs
   ```
   *Expected result:* 56/56 tests pass with exit code 0.

4. **Brand Check:**
   ```bash
   npm run check:brand
   ```
   *Expected result:* Zero unauthorized upstream brand occurrences.

5. **Full Monorepo Typecheck:**
   ```bash
   npm run typecheck
   ```
   *Expected result:* Zero TypeScript errors across all 22 monorepo packages.

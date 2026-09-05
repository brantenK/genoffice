# Forensic Audit Report: Milestone 2 — Persistent Disk Storage for RFP Documents & Vault Returnables

**Work Product**: Milestone 2 (`apps/tenders` storage architecture, IPC endpoints, preload bridge, renderer store persistence, document components, and `tools/verify-tenders-storage.ts`)  
**Profile**: General Project  
**Integrity Mode**: Development Mode (`ORIGINAL_REQUEST.md`)  
**Auditor**: `auditor_m2_storage`  
**Verdict**: **CLEAN**

---

## 1. Observation

Direct empirical observations made across the source code, monorepo typecheck, brand verification, and automated verification suites:

### 1.1 Modified Files & IPC Contracts
- **`apps/tenders/src/shared/ipc.ts`** (lines 5-19, 21-60, 82-109):
  - Declares channels: `saveDocument: 'tenders:save-document'`, `readDocument: 'tenders:read-document'`, `openDocument: 'tenders:open-document'`, and `deleteDocument: 'tenders:delete-document'`.
  - Defines strongly typed interfaces `SaveDocumentRequest`, `SaveDocumentResponse`, `ReadDocumentRequest`, `ReadDocumentResponse`, `OpenDocumentRequest`, `OpenDocumentResponse`, `DeleteDocumentRequest`, `DeleteDocumentResponse`.
  - Updates `TendersApiBridge` and `TendersApi` to expose these methods to the renderer context.

- **`apps/tenders/src/main/tenders-main.ts`**:
  - `getTendersBaseDir` (lines 312-318): Resolves directory `join(overrideUserData || app.getPath('userData'), 'tenders')` with recursive directory creation.
  - `getTendersDocumentsDir` (lines 320-326) and `getTendersVaultDir` (lines 328-334): Creates and returns `documents/` and `vault/` subdirectories.
  - `resolveSafeTendersPath` (lines 336-361): Resolves paths against `getTendersBaseDir()`, checks for null bytes (`\0`), and strictly enforces that resolved paths start with `docsDirWithSep` or `vaultDirWithSep` (disallowing navigation to parent directory or outside the designated folders).
  - `atomicWriteDocumentFile` (lines 363-397): Writes file content to a `.tmp` file using `randomUUID()`, then invokes `renameSync` with 3 retries (with 15ms backoff) to handle Windows `EBUSY`/`EPERM` locks, cleaning up `.tmp` on unhandled errors.
  - `saveDocumentFile` (lines 399-442): Sanitizes filenames using `basename()` and regex `replace(/[^a-zA-Z0-9._-]/g, '_')`, prefixes timestamp (`${timestamp}_${cleanName}`), and writes atomically to `documents/` or `vault/`.
  - `readDocumentFile` (lines 444-466): Validates safe path, checks file existence, reads genuine disk bytes with `readFileSync`, and returns sliced `ArrayBuffer`.
  - `openDocumentFile` (lines 468-492): Validates safe path, verifies existence, and delegates to Electron `shell.openPath()`.
  - `deleteDocumentFile` (lines 494-514): Validates safe path, and deletes file with `unlinkSync()`.
  - `registerTendersIpc` (lines 562-577): Hooks up IPC handlers for `saveDocument`, `readDocument`, `openDocument`, and `deleteDocument`.

- **`apps/tenders/src/preload/index.ts`** (lines 17-20):
  - Binds `saveDocument`, `readDocument`, `openDocument`, and `deleteDocument` via `ipcRenderer.invoke`. Exposes `tendersApi` via `contextBridge.exposeInMainWorld('tendersApi', tendersApi)`.

- **`apps/tenders/src/renderer/src/store.ts`** (lines 521-576):
  - In `partialize`:
    ```typescript
    tenders: ws.tenders.map((t) =>
      t.fileUrl?.startsWith('blob:') ? { ...t, fileUrl: '' } : t
    ),
    vault: ws.vault.map((d) =>
      d.fileUrl?.startsWith('blob:') ? { ...d, fileUrl: null } : d
    )
    ```
  - In `onRehydrateStorage`: Only blanks `fileUrl` if it strictly starts with `'blob:'`. Preserves durable relative paths (e.g. `documents/...` or `vault/...`) across application reloads and restarts.

- **`apps/tenders/src/renderer/src/components/TenderList.tsx`** (lines 84-102):
  - On PDF upload/shred, calls `window.tendersApi.saveDocument({ fileName: file.name, buffer, category: 'rfp' })`.
  - Assigns durable `storedPath` to `fileUrl`, eliminating session-only blob URLs.

- **`apps/tenders/src/renderer/src/components/Workspace.tsx`** (lines 66-87, 116-137):
  - In `useEffect`: Reads stored PDF from disk via `window.tendersApi.readDocument({ storedPath: tender.fileUrl })` when `fileUrl` is a durable path, rendering it in `pdfjs` without triggering the "Re-attach the tender PDF" warning.
  - In `handleReattach`: Persists re-attached file using `saveDocument`.

- **`apps/tenders/src/renderer/src/components/pages/DocumentsPage.tsx`** (lines 92-108, 409-430):
  - Persists uploaded compliance vault documents via `window.tendersApi.saveDocument({ category: 'vault' })`.
  - Opens vault documents using `window.tendersApi.openDocument({ storedPath: url })`.

- **`apps/tenders/src/renderer/src/components/VaultDrawer.tsx`** (lines 125-148):
  - Uses `window.tendersApi.openDocument({ storedPath: url })` to open vault PDFs via system default viewer.

### 1.2 Static Analysis & Prohibited Pattern Checks
- **Mocks & Test Bypasses in Production**:
  - Searched `apps/tenders/src` for `process.env`. Result: `No results found` (0 occurrences).
  - Searched `apps/tenders/src` for `mock`. Result: Confined strictly to seed demo fixtures (`MOCK_COMPANY`, `MOCK_CUSTOMERS`, `MOCK_VAULT` in `apps/tenders/src/renderer/src/mock/`), matching Requirement F3 ("Data Model & Seed Harmonization"). Zero mocks or stubs in IPC handlers or production logic.
- **Facade Implementations**:
  - All four IPC handlers (`saveDocument`, `readDocument`, `openDocument`, `deleteDocument`) execute genuine Node.js filesystem operations (`mkdirSync`, `writeFileSync`, `renameSync`, `readFileSync`, `unlinkSync`, `shell.openPath`). No dummy returns or facades.

### 1.3 Brand & Monorepo Health Verification
- **Brand Check (`npm run check:brand`)**:
  - Output: `✅ Brand check passed: Zero unauthorized upstream brand occurrences found.`
  - Exit Code: `0`
- **Monorepo Typecheck (`npm run typecheck`)**:
  - Compiles all 22 monorepo packages (`@genoffice/i18n`, `@genoffice/electron-utils`, `@genoffice/font-metrics`, `@genoffice/docx-engine`, `@genoffice/pdf2docx`, `@genoffice/file-parse`, `@genoffice/pptx-engine`, `@genoffice/pptx-render`, `@genoffice/ai-search`, `@genoffice/agent-core`, `@genoffice/ai-provider`, `@genoffice/project-store`, `@genoffice/ui`, `@genoffice/docs`, `@genoffice/sheets`, `@genoffice/shell`, `@genoffice/slides`, `@genoffice/pdf`, `@genoffice/markdown`, `@genoffice/crm`, `@genoffice/tenders`, `@genoffice/books`).
  - Exit Code: `0` (Zero TypeScript diagnostics).

### 1.4 Automated Test Suite Execution
- **`npx tsx tools/verify-tenders-storage.ts`**:
  - Runs 8 test categories: Directory structure, persistent save & atomic writes, filename sanitization & collision resistance, document retrieval via IPC, shell open via IPC, document deletion via IPC, path traversal prevention, and store rehydration / elimination of re-attach prompt.
  - Result: `72 passed, 0 failed` (Exit Code: `0`).
- **`npx tsx tools/verify-tenders-sync.ts`**:
  - Runs 7 test categories for state synchronization and milestone billing.
  - Result: `40 passed, 0 failed` (Exit Code: `0`).
- **`node tools/verify-suite-workflows.mjs`**:
  - Runs 56 end-to-end tests across CRM, Tenders, and Books workflows.
  - Result: `56 passed, 0 failed` (Exit Code: `0`).
- **`npx tsx tools/test-challenger-m1-data-integrity.ts`**:
  - Result: `175 passed, 0 failed` (Exit Code: `0`).
- **`npx tsx tools/test-challenger-m1-sync.ts`**:
  - Result: `61 passed, 0 failed` (Exit Code: `0`).

---

## 2. Logic Chain

1. **Premise 1 (Integrity Standards)**: A work product violates integrity if it contains hardcoded test results, facade implementations, environment bypasses (e.g. `process.env.TEST`), or fails to perform genuine disk operations as requested in `ORIGINAL_REQUEST.md` (§R2).
2. **Premise 2 (Empirical Verification of Source)**:
   - Direct inspection of `tenders-main.ts` confirms that `saveDocumentFile`, `readDocumentFile`, `openDocumentFile`, and `deleteDocumentFile` perform authentic file I/O on disk under `userData/tenders/documents/` and `userData/tenders/vault/`.
   - Direct inspection of `store.ts` confirms that only `blob:` URLs are purged upon rehydration, ensuring durable disk paths persist across app reboots.
   - Grep search confirms 0 occurrences of `process.env` in `apps/tenders/src`, proving no test flags or backdoor bypasses exist.
3. **Premise 3 (Empirical Verification of Behavior)**:
   - `tools/verify-tenders-storage.ts` executes real disk writes, reads, deletions, path traversal probes, and simulated rehydration, passing all 72 assertions without mocking the file system.
   - Path traversal attacks (`../../etc/passwd`, `..\..\Windows\System32\cmd.exe`, `documents/tender.pdf\0.png`, etc.) were independently tested and confirmed blocked.
   - Atomic writes utilize `.tmp` files with `renameSync` and Windows retry semantics, guaranteeing atomicity and fault recovery.
4. **Premise 4 (Health & Quality Standards)**:
   - `npm run check:brand` passed cleanly with 0 violations.
   - `npm run typecheck` passed cleanly across all 22 packages.
   - Cross-app workflow verification (`tools/verify-suite-workflows.mjs`) passed 56/56 checks with 0 regressions.
5. **Deduction**: Because all required capabilities are authentically implemented with genuine disk I/O, zero prohibited patterns were found, and all verification suites passed, Milestone 2 is free of integrity violations.

---

## 3. Caveats

- **No caveats.** The implementation was inspected across main, preload, renderer, shared interfaces, and verification scripts. All checks passed with zero warnings, zero TypeScript errors, and zero brand violations.

---

## 4. Conclusion

**Verdict: CLEAN**

Milestone 2 ("Persistent Disk Storage for RFP Documents & Vault Returnables") is fully and authentically implemented in accordance with `ORIGINAL_REQUEST.md` (§R2) and `PROJECT.md` (Features F5, F6, F7, F8). All operations execute genuine disk I/O with atomic guarantees and strict path traversal protection. The work product is certified as **CLEAN** and ready for Milestone 3.

---

## 5. Verification Method

To independently reproduce and verify this audit:

1. **Brand Health Check**:
   ```bash
   npm run check:brand
   ```
   *Expected*: Zero unauthorized upstream brand occurrences (Exit Code 0).

2. **Monorepo Typecheck**:
   ```bash
   npm run typecheck
   ```
   *Expected*: 22/22 packages compile cleanly with zero errors (Exit Code 0).

3. **Storage Verification Suite (M2)**:
   ```bash
   npx tsx tools/verify-tenders-storage.ts
   ```
   *Expected*: 72 passed, 0 failed (Exit Code 0).

4. **Sync Verification Suite (M1)**:
   ```bash
   npx tsx tools/verify-tenders-sync.ts
   ```
   *Expected*: 40 passed, 0 failed (Exit Code 0).

5. **Cross-App Suite Verification**:
   ```bash
   node tools/verify-suite-workflows.mjs
   ```
   *Expected*: 56 passed, 0 failed (Exit Code 0).

6. **Static Integrity Audit**:
   ```bash
   git grep "process.env" apps/tenders/src/
   ```
   *Expected*: No results found.

# Handoff Report: Milestone 2 Review (Security, Edge Cases & Persistence)

**Reviewer:** `reviewer_2_m2_storage`  
**Roles:** reviewer, critic  
**Target Milestone:** Milestone 2 — Persistent Disk Storage for RFP Documents & Vault Returnables (R2)  
**Binary Gate Verdict:** **APPROVE**  
**Date:** 2026-09-04  

---

## 1. Observation

### 1.1 Direct Inspection of Implementation Files

1. **`apps/tenders/src/shared/ipc.ts` (lines 5–59, 82–109):**
   - Declares IPC channels:
     ```typescript
     saveDocument: 'tenders:save-document',
     readDocument: 'tenders:read-document',
     openDocument: 'tenders:open-document',
     deleteDocument: 'tenders:delete-document',
     ```
   - Defines typed contracts for requests and responses (`SaveDocumentRequest/Response`, `ReadDocumentRequest/Response`, `OpenDocumentRequest/Response`, `DeleteDocumentRequest/Response`).
   - Extended `TendersApiBridge` and `TendersApi` to expose typed invoke wrappers.

2. **`apps/tenders/src/main/tenders-main.ts` (lines 312–515, 561–577):**
   - Managed directory hierarchy:
     - `getTendersBaseDir()` -> `userData/tenders`
     - `getTendersDocumentsDir()` -> `userData/tenders/documents`
     - `getTendersVaultDir()` -> `userData/tenders/vault`
   - Path security in `resolveSafeTendersPath(storedPath, overrideUserData)` (lines 336–361):
     - Validates non-empty string and rejects null bytes (`\0`).
     - Normalizes paths using `resolve(root, storedPath)`.
     - Strictly enforces that the target resides inside `userData/tenders/documents/` or `userData/tenders/vault/` via `resolved.startsWith(docsDirWithSep) && resolved !== docsDir` and `resolved.startsWith(vaultDirWithSep) && resolved !== vaultDir`.
   - Atomic file write in `atomicWriteDocumentFile(targetPath, buffer)` (lines 363–397):
     - Writes to `${targetPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`.
     - Calls `renameSync(tmp, targetPath)` with a 3-attempt retry loop specifically handling Windows contention errors (`EBUSY` / `EPERM`) with 15ms backoff.
     - Automatically unlinks `.tmp` file on write or rename failure.
   - IPC endpoints in `saveDocumentFile`, `readDocumentFile`, `openDocumentFile`, `deleteDocumentFile`:
     - Filename sanitization in `saveDocumentFile`: strips traversal and illegal characters via `basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')`.
     - `readDocumentFile`: loads buffer and returns structured `ArrayBuffer` slice.
     - `openDocumentFile`: invokes `shell.openPath(fullPath)`.
     - `deleteDocumentFile`: safe unlinking with error handling.

3. **`apps/tenders/src/preload/index.ts` (lines 17–20):**
   - Exposes `saveDocument`, `readDocument`, `openDocument`, and `deleteDocument` over `contextBridge.exposeInMainWorld('tendersApi', ...)`.

4. **`apps/tenders/src/renderer/src/store.ts` (lines 521–566):**
   - In `partialize`:
     ```typescript
     tenders: ws.tenders.map((t) =>
       t.fileUrl?.startsWith('blob:') ? { ...t, fileUrl: '' } : t
     ),
     vault: ws.vault.map((d) =>
       d.fileUrl?.startsWith('blob:') ? { ...d, fileUrl: null } : d
     )
     ```
   - In `onRehydrateStorage`: Only purges `fileUrl` if it strictly starts with `'blob:'`. Preserves relative stored paths (`documents/...` and `vault/...`).

5. **UI Integration Points:**
   - `apps/tenders/src/renderer/src/components/TenderList.tsx` (lines 84–102): invokes `window.tendersApi.saveDocument({ fileName: file.name, buffer, category: 'rfp' })` during PDF upload, saving the returned `storedPath` into the tender record with browser fallback.
   - `apps/tenders/src/renderer/src/components/Workspace.tsx` (lines 66–98, 116–137, 361–398): reads documents via `readDocument({ storedPath: tender.fileUrl })` and loads PDF bytes into pdfjs. `handleReattach` writes re-attached files to disk via `saveDocument`.
   - `apps/tenders/src/renderer/src/components/pages/DocumentsPage.tsx` (lines 92–155, 412–429): saves uploaded vault returnables via `saveDocument`, opens PDFs via `window.tendersApi.openDocument({ storedPath: url })`.
   - `apps/tenders/src/renderer/src/components/VaultDrawer.tsx` (lines 125–142): opens PDFs via `openDocument`.

---

### 1.2 Verification Command Executions

1. **Brand Compliance (`npm run check:brand`):**
   - Output: `✅ Brand check passed: Zero unauthorized upstream brand occurrences found.` (exit code 0).
2. **TypeScript Compilation (`npm run typecheck`):**
   - Output: clean compilation across all 22 monorepo packages (`@genoffice/i18n`, `@genoffice/electron-utils`, `@genoffice/font-metrics`, `@genoffice/docx-engine`, `@genoffice/pdf2docx`, `@genoffice/file-parse`, `@genoffice/pptx-engine`, `@genoffice/pptx-render`, `@genoffice/ai-search`, `@genoffice/agent-core`, `@genoffice/ai-provider`, `@genoffice/project-store`, `@genoffice/ui`, `@genoffice/docs`, `@genoffice/sheets`, `@genoffice/shell`, `@genoffice/slides`, `@genoffice/pdf`, `@genoffice/markdown`, `@genoffice/crm`, `@genoffice/tenders`, `@genoffice/books`) (exit code 0).
3. **Dedicated Milestone 2 Storage Verification (`npx tsx tools/verify-tenders-storage.ts`):**
   - Output: `72 passed, 0 failed` (exit code 0).
4. **Monorepo Suite Workflows (`node tools/verify-suite-workflows.mjs`):**
   - Output: `56 passed, 0 failed out of 56 tests` (exit code 0).
5. **State Synchronization Suite (`npx tsx tools/verify-tenders-sync.ts`):**
   - Output: `40 passed, 0 failed` (exit code 0).

---

### 1.3 Adversarial Stress-Test Findings

A comprehensive adversarial suite was executed testing `resolveSafeTendersPath`, `atomicWriteDocumentFile`, and edge cases:

| Test Case / Attack Vector | Payload | Observed Behavior | Status |
|---|---|---|---|
| Relative directory escape | `../../etc/passwd` | Rejected: `Directory traversal detected` | Pass |
| Relative escape from subfolder | `documents/../../tenders-data.json` | Rejected: `Directory traversal detected` | Pass |
| Directory root targeting | `documents/..` or `documents` | Rejected: `Directory traversal detected` | Pass |
| Windows absolute paths | `C:\Windows\System32\cmd.exe` | Rejected: `Directory traversal detected` | Pass |
| Unix absolute paths | `/etc/passwd` | Rejected: `Directory traversal detected` | Pass |
| UNC network paths | `\\server\share\file.pdf` | Rejected: `Directory traversal detected` | Pass |
| Windows reserved device names | `CON`, `PRN`, `AUX`, `NUL`, `COM1`, `LPT1` | Rejected: `Directory traversal detected` | Pass |
| Null byte poison injection | `documents/valid.pdf\0.exe` | Rejected: `Null byte detected in path` | Pass |
| Empty / whitespace paths | `""`, `"   "` | Rejected: `Stored path is required` / Traversal | Pass |
| Windows file lock contention | EBUSY / EPERM simulated | Retried up to 3x with backoff, cleaned `.tmp` | Pass |
| Application restart rehydration | Persistent disk path vs blob URL | Disk path preserved; blob wiped; viewer loads | Pass |

---

## 2. Logic Chain

1. **Path Traversal Security (Focus Area 1):**
   - `resolveSafeTendersPath` anchors resolution to the absolute directory returned by `getTendersBaseDir`.
   - By asserting `resolved.startsWith(docsDirWithSep) && resolved !== docsDir` and `resolved.startsWith(vaultDirWithSep) && resolved !== vaultDir`, any path that attempts to escape via `..`, absolute drive specifiers, UNC shares, or direct folder targeting evaluates to `false`.
   - Furthermore, `saveDocumentFile` actively sanitizes uploaded filenames via `basename()` and regex replacement (`[^a-zA-Z0-9._-]` -> `_`), preventing traversal tokens or alternate data streams from being written in the first place.
   - Therefore, arbitrary file read, open, or deletion vulnerabilities are prevented across IPC.

2. **Windows File Contention & Atomic Writes (Focus Area 2):**
   - On Windows, atomic file updates via `renameSync` can intermittently fail if background processes (such as Windows Defender or search indexing) hold open handles.
   - `atomicWriteDocumentFile` addresses this by generating a collision-resistant temporary file name (`.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`) and employing an `EBUSY`/`EPERM` retry loop with backoff.
   - Any unhandled exception triggers an unlink of the temporary file, ensuring no leftover artifacts clutter the disk.

3. **Elimination of Re-attach Warning & Durable Rehydration (Focus Area 3):**
   - Ephemeral `blob:` URLs cannot survive page reload because browser object URLs terminate with the session.
   - By transitioning to relative paths (`documents/...` and `vault/...`) stored in SQLite/JSON state, paths remain portable and persistent.
   - `store.ts` selectively wipes URLs matching `fileUrl?.startsWith('blob:')`, leaving durable stored paths intact across serialization and rehydration.
   - `Workspace.tsx` directly reads stored paths via `window.tendersApi.readDocument` into an `ArrayBuffer` and loads pdfjs, completely removing the "Re-attach the tender PDF" warning banner upon application restart.

4. **Forensic Integrity Verification:**
   - Zero hardcoded test outputs or dummy implementations detected.
   - Real binary I/O, IPC handlers, and state mutations are implemented.
   - All tests run and pass programmatically.

---

## 3. Caveats

1. **UI Orphaned File Deletion (Minor Enhancement Opportunity):**
   - While `tenders-main.ts` provides a secure, verified `deleteDocument` IPC handler, `DocumentsPage.tsx` (`handleDelete`) and `TenderList.tsx` (`removeTender`) remove records from the store without calling `window.tendersApi.deleteDocument`.
   - This prevents accidental data loss if a record is restored, but leaves unreferenced PDFs in `userData/tenders/`. An optional disk garbage collection sweep or explicit delete call can be introduced in a future maintenance cycle.
2. **Synchronous Spin-wait in File Lock Retry:**
   - The retry loop in `atomicWriteDocumentFile` uses a 15ms synchronous spin-wait capped at 3 iterations (max 45ms total). While safe for document uploads, async timer delays could be considered if high-frequency concurrent file writes are planned in future milestones.

---

## 4. Conclusion

**Verdict: APPROVE**

Milestone 2 (Persistent Disk Storage for RFP Documents & Vault Returnables) satisfies all architectural and functional requirements:
- Path traversal prevention is secure and tested against adversarial vectors.
- Atomic writes withstand Windows lock contention and clean up temporary files cleanly.
- Durable paths survive serialization and rehydration, eliminating re-attach prompts.
- All 5 automated verification and build commands pass cleanly with zero errors.

---

## 5. Verification Method

To independently verify these results:

1. **Run Brand Check:**
   ```bash
   npm run check:brand
   ```
   *Expected:* 0 unauthorized brand occurrences.

2. **Run Monorepo Typecheck:**
   ```bash
   npm run typecheck
   ```
   *Expected:* Clean compilation across all 22 monorepo packages.

3. **Run Storage Verification Suite:**
   ```bash
   npx tsx tools/verify-tenders-storage.ts
   ```
   *Expected:* 72 passed, 0 failed.

4. **Run Suite Workflows:**
   ```bash
   node tools/verify-suite-workflows.mjs
   ```
   *Expected:* 56 passed, 0 failed.

5. **Run State Sync Verification:**
   ```bash
   npx tsx tools/verify-tenders-sync.ts
   ```
   *Expected:* 40 passed, 0 failed.

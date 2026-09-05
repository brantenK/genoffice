## 2026-09-04T20:13:25Z
You are worker_m2_storage, an implementation and verification worker.
Your assigned working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_m2_storage

You MUST read ORIGINAL_REQUEST.md before starting work:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md
Specifically inspect the latest request dated 2026-09-04T18:31:53Z.

Also read PROJECT.md:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\PROJECT.md

And read the Explorer handoff reports:
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_core\handoff.md
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_backend\handoff.md

Scope of Milestone 2: Persistent Disk Storage for RFP Documents & Vault Returnables (R2)
Your write ownership covers:
- apps/tenders/src/shared/ipc.ts
- apps/tenders/src/main/tenders-main.ts
- apps/tenders/src/preload/index.ts
- apps/tenders/src/renderer/src/store.ts
- apps/tenders/src/renderer/src/components/TenderList.tsx
- apps/tenders/src/renderer/src/components/Workspace.tsx
- apps/tenders/src/renderer/src/components/pages/DocumentsPage.tsx
- apps/tenders/src/renderer/src/components/VaultDrawer.tsx
- tools/verify-tenders-storage.ts (verification harness)

Detailed implementation tasks:
1. In `apps/tenders/src/shared/ipc.ts`:
   - Add channels:
     - `TENDERS_CHANNELS.saveDocument = 'tenders:save-document'`
     - `TENDERS_CHANNELS.readDocument = 'tenders:read-document'`
     - `TENDERS_CHANNELS.openDocument = 'tenders:open-document'`
     - `TENDERS_CHANNELS.deleteDocument = 'tenders:delete-document'`
   - Define typed contracts in `TendersApiBridge` and `TendersApi`:
     - `saveDocument(req: { fileName: string; buffer: ArrayBuffer | Uint8Array; category: 'rfp' | 'vault' }): Promise<{ ok: boolean; storedPath?: string; error?: string }>`
     - `readDocument(req: { storedPath: string }): Promise<{ ok: boolean; buffer?: ArrayBuffer; error?: string }>`
     - `openDocument(req: { storedPath: string }): Promise<{ ok: boolean; error?: string }>`
     - `deleteDocument(req: { storedPath: string }): Promise<{ ok: boolean; error?: string }>`
2. In `apps/tenders/src/main/tenders-main.ts`:
   - Setup disk storage structure under `userData/tenders/documents/` (for RFP PDFs) and `userData/tenders/vault/` (for compliance returnables).
   - Implement handlers:
     - `saveDocument`: Sanitize filename, prevent directory traversal, write file atomically (.tmp + renameSync), return relative path `documents/${timestamp}_${name}` or `vault/${timestamp}_${name}`.
     - `readDocument`: Safely resolve relative path against `userData/tenders`, prevent escaping directory via `..`, read into Buffer and return `buffer.buffer`.
     - `openDocument`: Safely resolve path and call `electron.shell.openPath(fullPath)`.
     - `deleteDocument`: Safely delete file if exists.
3. In `apps/tenders/src/preload/index.ts`:
   - Expose `saveDocument`, `readDocument`, `openDocument`, `deleteDocument` on `window.tendersApi`.
4. In `apps/tenders/src/renderer/src/store.ts`:
   - Update `partialize` and `onRehydrateStorage`:
     - Do NOT blank `fileUrl` if it contains a durable stored path (`documents/...` or `vault/...`)!
     - Only wipe `fileUrl` if it strictly starts with `'blob:'`!
5. In `apps/tenders/src/renderer/src/components/`:
   - `TenderList.tsx`: When uploading RFP PDF, read `file.arrayBuffer()`, save via `window.tendersApi.saveDocument({ fileName, buffer, category: 'rfp' })`, and set `tender.fileUrl = res.storedPath`. Fall back gracefully to `createObjectURL` in browser-only dev mode.
   - `DocumentsPage.tsx`: When uploading a vault doc, save via `window.tendersApi.saveDocument({ fileName, buffer, category: 'vault' })`, set `doc.fileUrl = res.storedPath`. When clicking "Open PDF", call `window.tendersApi.openDocument({ storedPath: doc.fileUrl })`.
   - `Workspace.tsx`: When loading PDF into pdfjs, if `tender.fileUrl` is a stored path, read via `window.tendersApi.readDocument({ storedPath: tender.fileUrl })`. If loaded from disk, eliminate the "Re-attach the tender PDF" warning banner.
   - `VaultDrawer.tsx`: Open PDFs via `window.tendersApi.openDocument({ storedPath: doc.fileUrl })`.
6. Verification:
   - Run `npm run check:brand` (must pass with 0 violations).
   - Run `npm run typecheck` across monorepo packages (must pass with 0 errors).
   - Create `tools/verify-tenders-storage.ts` verifying:
     a) Uploaded tender PDFs and vault files are stored on disk under userData directory.
     b) Documents reload successfully after simulated app restart without requiring re-attachment.
     c) Path traversal attempts (`../../etc`) are rejected safely.
     d) Existing `verify-tenders-sync.ts` and `verify-suite-workflows.mjs` continue to pass.

## 2026-09-04T20:40:29Z
**Context**: Milestone 2 Worker Liveness Query
**Content**: Your progress.md has not been updated since 20:14:00Z (~26m ago). `tools/verify-tenders-storage.ts` has been created. Please report your current command execution status, test results, or blockers immediately so we can proceed to review swarm dispatch.
**Action**: Reply with status update or complete handoff.md.

# BRIEFING — 2026-09-04T18:46:00Z

## Mission
Investigate apps/tenders Electron main process, IPC, and persistence architecture for R1 and R2.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigation, synthesis
- Working directory: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_backend
- Original parent: fbcabbf4-6f44-4812-94fe-47a67abd75f4
- Milestone: Tenders Backend Exploration (R1 & R2)

## 🔒 Key Constraints
- Read-only investigation — do NOT implement or edit source code files
- Write handoff to handoff.md in working directory
- Communicate via send_message to parent (id: fbcabbf4-6f44-4812-94fe-47a67abd75f4, name: parent)

## Current Parent
- Conversation ID: fbcabbf4-6f44-4812-94fe-47a67abd75f4
- Updated: 2026-09-04T18:35:07Z

## Investigation State
- **Explored paths**:
  - `apps/tenders/src/main/tenders-main.ts`
  - `apps/tenders/src/shared/ipc.ts`
  - `apps/tenders/src/preload/index.ts`
  - `apps/tenders/src/shared/types.ts`
  - `apps/tenders/src/renderer/src/store.ts`
  - `apps/tenders/src/renderer/src/components/pages/DocumentsPage.tsx`
  - `apps/tenders/src/renderer/src/components/TenderList.tsx`
  - `apps/tenders/src/renderer/src/components/Workspace.tsx`
  - `apps/tenders/src/renderer/src/components/PdfViewer.tsx`
  - `apps/tenders/src/renderer/src/pdf/extract.ts`
  - `apps/tenders/src/renderer/src/pdf/shred.ts`
  - `apps/tenders/src/renderer/src/gap.ts`
  - `apps/shell/src/main/index.ts`
  - `apps/shell/src/main/tab-manager.ts`
  - `apps/books/src/main/books-main.ts`
  - `apps/books/src/renderer/src/store.ts`
  - `apps/crm/src/main/crm-main.ts`
  - `apps/crm/src/main/crm-store.ts`
  - `tools/verify-suite-workflows.mjs`
- **Key findings**:
  - Renderer Zustand store (`store.ts`) persists strictly to browser `localStorage` ('zanostack-tenders-v1') and completely ignores `window.tendersApi.getStoredData` and `saveStoredData`.
  - Main process `tenders-main.ts` reads and writes `userData/tenders/tenders-data.json`, but never notifies the active renderer WebContentsView of changes (`dataChanged` event is missing).
  - Seed discrepancy: `tenders-main.ts` seeds with empty vault/customers and company 'Zano Consulting', whereas renderer store seeds with 'Thabo Engineering' and populated `MOCK_VAULT`.
  - Document & PDF storage (R2): Uploaded RFP PDFs and compliance vault documents currently live only as temporary browser `blob:` URLs, explicitly blanked on reload in `store.ts`. No persistent disk file storage exists under `userData/tenders/documents/` or `userData/tenders/vault/`.
  - Missing IPC handlers for document disk persistence: `tenders:save-document`, `tenders:read-document`, `tenders:open-document`, `tenders:delete-document`.
  - Cross-app sync gap: Milestone billing in Books creates invoices and marks `foundMilestone.status = 'BILLED'`, but when invoices are paid/reconciled in Books (`executeReconciliation`), Books never updates `tenders-data.json` to `'PAID'`.
- **Unexplored areas**: None for backend exploration scope.

## Key Decisions Made
- Recommending bidirectional synchronization: renderer store async hydration from main on mount, debounced autosave to main IPC, and main-to-renderer push broadcast `tenders:data-changed`.
- Recommending durable file storage layout under `userData/tenders/documents/` and `userData/tenders/vault/` with ArrayBuffer IPC transport and `shell.openPath` integration.

## Artifact Index
- DISPATCH.md — Recorded dispatch instructions
- progress.md — Heartbeat and step progress
- handoff.md — Comprehensive 5-component report

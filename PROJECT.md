# Project: Zanostack Tenders Overhaul and Hardening

## Architecture
Zanostack Tenders (`apps/tenders` / `@genoffice/tenders`) is a core desktop application within the GenOffice Electron multi-application monorepo. It manages public and private sector RFPs, deterministic clause extraction heuristics, compliance matrices, company vault returnables, and contract delivery milestones.

The Electron shell (`apps/shell`) hosts Tenders in a `WebContentsView` tab managed by `TabManager`. The backend lifecycle and IPC endpoints are handled by `apps/tenders/src/main/tenders-main.ts`.

### Unified Storage & Data Flow Architecture
1. **Renderer-Main State Synchronization (R1)**:
   - State of truth is stored on disk at `userData/tenders/tenders-data.json`.
   - The React renderer Zustand store (`apps/tenders/src/renderer/src/store.ts`) rehydrates from disk via `window.tendersApi.getStoredData()` on mount.
   - UI state changes trigger debounced saves to disk via `window.tendersApi.saveStoredData()`.
   - Backend state modifications (e.g. milestone billing from Books or external sync) broadcast a `tenders:data-changed` push event to all active Tenders WebContents, triggering live in-memory updates without reloads.
2. **Persistent Document & Vault Disk Storage (R2)**:
   - Uploaded RFP PDFs and compliance vault files are saved to `userData/tenders/documents/` and `userData/tenders/vault/` via IPC.
   - Durable relative paths (`rfps/...`, `vault/...`) are stored in `TenderRecord.fileUrl` and `VaultDoc.fileUrl`, eliminating transient browser `blob:` URLs and avoiding re-attach prompts across application restarts.
3. **Cross-App Interoperability (R3)**:
   - **Zano Books**: Milestone billing generates Tax Invoices and balanced double-entry journal entries. Books bank statement reconciliation back-propagates payment status (`'PAID'`) to tender milestones in `tenders-data.json`.
   - **Zano CRM**: Tender export generates or updates CRM deals with deterministic ID (`deal-tender-${tender.id}`), mapping reference number, issuer, deadline (`expectedCloseDate`), and value, recording `linkedCrmDealId` on the tender.
   - **Zano Docs & Sheets**: Matrix export generates clean CSV routing to Sheets; proposal draft export generates Docs-compatible documents routing directly to Zanostack Docs.
4. **Automated Testing Suite (R4)**:
   - Dedicated Vitest suite in `apps/tenders/tests/` testing deterministic RFP heuristics, compliance gap analysis, store serialization/migration, and IPC handlers with 100% test pass and zero TypeScript errors.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Main-to-Renderer IPC Push Notifications | Broadcast `tenders:data-changed` event to active Tenders WebContents on store updates | M1 | ORIGINAL_REQUEST §R1 |
| F2 | Renderer Store Hydration & Debounced Save | Hydrate Zustand store via `getStoredData()` on mount and debounce save changes via `saveStoredData()` | M1 | ORIGINAL_REQUEST §R1 |
| F3 | Data Model & Seed Harmonization | Harmonize seed company, workspace, mock vault returnables, and customers between `tenders-main.ts` and `store.ts` | M1 | ORIGINAL_REQUEST §R1 |
| F4 | Live UI Update on External Modification | In-memory store updates on `tenders:data-changed` event without page reload, with echo-prevention guard | M1 | ORIGINAL_REQUEST §R1 |
| F5 | Managed Disk Storage Directory Structure | Establish `userData/tenders/documents` and `userData/tenders/vault` storage directories with safe atomic file write | M2 | ORIGINAL_REQUEST §R2 |
| F6 | Document Storage IPC Handlers | Implement `tenders:save-document`, `tenders:read-document`, `tenders:open-document`, and `tenders:delete-document` in `tenders-main.ts` | M2 | ORIGINAL_REQUEST §R2 |
| F7 | Renderer Document & Vault Integration | Replace ephemeral `URL.createObjectURL` with `saveDocument`, storing durable relative paths | M2 | ORIGINAL_REQUEST §R2 |
| F8 | Restart-Resilient Document Reloading | Update `store.ts` partialize/rehydrate and PDF viewer to read durable paths via `readDocument`, removing re-attach warning | M2 | ORIGINAL_REQUEST §R2 |
| F9 | Books Reconciliation Payment Back-Propagation | Books bank reconciliation updates linked tender milestones to `'PAID'` in `tenders-data.json` and notifies Tenders | M3 | ORIGINAL_REQUEST §R3 |
| F10 | CRM Tender Opportunity Sync Hardening | Deterministic deal ID `deal-tender-${id}`, closing date mapped to `expectedCloseDate`, back-reference `linkedCrmDealId` on tender | M3 | ORIGINAL_REQUEST §R3 |
| F11 | Docs Proposal & Sheets Matrix Export | Clean CSV export to Sheets with escaped cells; proposal draft export opening directly into Zanostack Docs | M3 | ORIGINAL_REQUEST §R3 |
| F12 | Vitest Setup for `apps/tenders` | Create `apps/tenders/vitest.config.ts`, add `"test": "vitest run"` script, and link to monorepo test runner | M4 | ORIGINAL_REQUEST §R4 |
| F13 | Deterministic RFP Shredder Heuristic Tests | Automated unit tests for clause extraction, sentence joining, 35 rules scoring, and metadata extraction | M4 | ORIGINAL_REQUEST §R4 |
| F14 | Compliance Gap Analysis Tests | Automated unit tests for document health, 90-day police stamp expiry window, keyword matching, and 0.5 auto-link threshold | M4 | ORIGINAL_REQUEST §R4 |
| F15 | Store Migration & IPC Handler Tests | Automated tests for schema migration, atomic writes, corruption handling, and main-renderer synchronization | M4 | ORIGINAL_REQUEST §R4 |
| F16 | Monorepo Quality & Forensic Audit | Clean `npm run typecheck` across all packages, 100% tests passing, zero brand violations, and Forensic Integrity Audit certification | M4 | ORIGINAL_REQUEST §AC |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Unified Main-Renderer State Synchronization | Implement IPC push channel, hydrate/save in Zustand store, harmonize seed data, and ensure real-time UI updates (F1, F2, F3, F4) | none | DONE |
| M2 | Persistent Disk Storage for Documents & Vault | Managed disk storage in userData, IPC document handlers, durable relative paths, eliminating blob URL re-attach prompts (F5, F6, F7, F8) | M1 | DONE |
| M3 | Cross-App Interoperability & Export Workflows | Books reconciliation payment back-propagation, CRM deal sync hardening with deterministic IDs, Docs/Sheets export workflows (F9, F10, F11) | M1 | DONE |
| M4 | Automated Testing & Verification Suite | Vitest configuration, deterministic shredder & gap analysis test suites, store & IPC tests, typecheck clean, forensic audit (F12, F13, F14, F15, F16) | M1, M2, M3 | DONE |

---

## Code Layout
- `apps/tenders/src/main/tenders-main.ts` — Electron main process backend, IPC registration, store persistence, document disk storage, cross-app operations.
- `apps/tenders/src/shared/ipc.ts` — IPC channel constant definitions and typed request/response payload contracts.
- `apps/tenders/src/shared/types.ts` — Data models for tenders, contract milestones, compliance vault documents, requirements, and stored envelopes.
- `apps/tenders/src/preload/index.ts` — Electron preload script exposing typed `window.tendersApi` to renderer context.
- `apps/tenders/src/renderer/src/store.ts` — Zustand renderer state store, persistence bridge, and action handlers.
- `apps/tenders/src/renderer/src/components/` — UI views (TenderList, Workspace, DocumentsPage, MilestonesDrawer).
- `apps/tenders/src/renderer/src/pdf/` — Deterministic PDF extraction (`extract.ts`), clause stitching (`clauses.ts`), and shredder heuristics (`shred.ts`).
- `apps/tenders/src/renderer/src/gap.ts` — Compliance gap analysis and vault document health heuristics.
- `apps/tenders/tests/` — Automated Vitest test suites for shredder heuristics, compliance gap, store migration, and IPC handlers.
- `apps/books/src/main/books-main.ts` — Zano Books backend and bank statement reconciliation logic.
- `apps/crm/src/main/crm-main.ts` — Zano CRM backend and deals persistence.
- `apps/shell/src/main/index.ts` — Application shell and cross-app tab routing.

---

## Interface Contracts

### 1. Unified State Synchronization IPC Contracts
```typescript
// IPC Channels
TENDERS_CHANNELS.dataChanged = 'tenders:data-changed' // Main -> Renderer broadcast
TENDERS_CHANNELS.getStoredData = 'tenders:get-stored-data' // Renderer -> Main
TENDERS_CHANNELS.saveStoredData = 'tenders:save-stored-data' // Renderer -> Main

export interface TendersApiBridge {
  getStoredData: () => Promise<string | null>
  saveStoredData: (json: string) => Promise<{ ok: boolean; error?: string }>
  onDataChanged: (callback: (data: TendersData) => void) => () => void
}
```

### 2. Document & Vault Disk Storage IPC Contracts
```typescript
TENDERS_CHANNELS.saveDocument = 'tenders:save-document'
TENDERS_CHANNELS.readDocument = 'tenders:read-document'
TENDERS_CHANNELS.openDocument = 'tenders:open-document'
TENDERS_CHANNELS.deleteDocument = 'tenders:delete-document'

export interface SaveDocumentRequest {
  fileName: string
  buffer: ArrayBuffer | Uint8Array
  category: 'rfp' | 'vault'
}
export interface SaveDocumentResponse {
  ok: boolean
  storedPath: string // relative to userData/tenders, e.g. "documents/1725470000000_tender.pdf"
  error?: string
}

export interface ReadDocumentRequest {
  storedPath: string
}
export interface ReadDocumentResponse {
  ok: boolean
  buffer?: ArrayBuffer
  error?: string
}
```

### 3. Cross-App Contracts
```typescript
// Books Reconciliation -> Tenders Milestone Back-Propagation
// When an invoice with tenderReference is reconciled and marked 'Paid':
// 1. Load userData/tenders/tenders-data.json
// 2. Locate matching milestone by billedInvoiceId or tenderReference
// 3. Update milestone: status = 'PAID', paidAt = new Date().toISOString()
// 4. Save tenders-data.json atomically and broadcast tenders:data-changed

// CRM Opportunity Sync Contract
export interface SyncWithCrmPayload {
  dealId: string // deterministic: `deal-tender-${tender.id}`
  title: string
  companyName: string
  referenceNumber: string
  amount: number
  expectedCloseDate: string // tender.closingDate
  stage: 'proposal'
  tenderId: string
}
```

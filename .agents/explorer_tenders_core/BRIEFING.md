# BRIEFING — 2026-09-04T18:45:00Z

## Mission
Read-only investigation of apps/tenders frontend and core domain logic: Zustand store, RFP shredder heuristics, compliance matrix, milestone/document modeling, and PDF/vault storage.

## 🔒 My Identity
- Archetype: explorer
- Roles: explorer_tenders_core
- Working directory: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_core
- Original parent: fbcabbf4-6f44-4812-94fe-47a67abd75f4
- Milestone: tenders overhaul & hardening (R1, R2, R3, R4)

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Do NOT edit or write source code files
- Write your handoff to handoff.md in your working directory
- When finished, send a completion message to parent with summary

## Current Parent
- Conversation ID: fbcabbf4-6f44-4812-94fe-47a67abd75f4
- Updated: 2026-09-04T18:45:00Z

## Investigation State
- **Explored paths**:
  - `apps/tenders/src/renderer/src/store.ts` (Zustand store, persist middleware, seed, partialize, rehydration)
  - `apps/tenders/src/main/tenders-main.ts` (Electron backend IPC handlers, validation, migrations, file I/O)
  - `apps/tenders/src/preload/index.ts` & `src/shared/ipc.ts` (IPC contract and window.tendersApi)
  - `apps/tenders/src/renderer/src/pdf/shred.ts`, `clauses.ts`, `extract.ts`, `src/shared/rules.ts` (RFP shredder heuristics, determinism)
  - `apps/tenders/src/renderer/src/gap.ts`, `readiness.ts`, `issuer.ts`, `deadline.ts` (gap analysis, health checks, readiness scoring)
  - `apps/tenders/src/renderer/src/components/Workspace.tsx`, `TenderList.tsx`, `DocumentsPage.tsx`, `VaultDrawer.tsx`, `MilestonesDrawer.tsx` (blob URLs, reattachment, milestone billing)
  - `apps/tenders/src/shared/types.ts` (data models: TenderRecord, RequirementRecord, VaultDoc, ContractMilestone, TendersData)
  - `apps/tenders/package.json`, root `package.json`, root `tools/verify-suite-workflows.mjs`
- **Key findings**:
  1. Zustand store currently persists only to browser `localStorage` (`zanostack-tenders-v1`). It NEVER loads from nor saves to `userData/tenders/tenders-data.json`.
  2. IPC methods `getStoredData` and `saveStoredData` are registered in Electron backend and exposed in preload, but NEVER invoked by the renderer.
  3. No live IPC event notification exists between main and renderer when backend modifies `tenders-data.json` (e.g. milestone billing).
  4. RFP shredder is 100% deterministic (sentence stitching, pattern matching against 35 South African tender rules, scoring, and metadata lifting).
  5. Compliance gap analysis is deterministic (keyword matching, category agreement bonus/penalty, 0.5 auto-link threshold, document health / 90-day police stamp expiry).
  6. Transient `blob:` URLs are used for all uploaded PDFs and vault returnables (`TenderList.tsx:84`, `DocumentsPage.tsx:108,122`, `Workspace.tsx:98`). `store.ts` explicitly strips them on reload, breaking document viewing across app restarts.
- **Unexplored areas**: None within the assigned scope. All 4 prompt objectives thoroughly investigated.

## Key Decisions Made
- Structured the handoff report to detail exact file paths, line numbers, code snippets, and architectural blueprints for R1 (state synchronization & live updates) and R2 (persistent document storage & IPC retrieval).

## Artifact Index
- DISPATCH.md — record of incoming tasks/dispatches
- progress.md — liveness heartbeat and subtask tracker
- BRIEFING.md — persistent situational awareness
- handoff.md — final 5-component report

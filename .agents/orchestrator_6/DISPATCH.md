# Dispatch to Orchestrator 6 (Tenders 9/10 Hardening — Phase 2 Durability Remaining Work)

- **Target Workspace**: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice
- **Agent Directory**: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_6
- **Request Source**: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (Header ## 2026-09-15T04:52:08Z)
- **Integrity Mode**: development

## Context & References
- Handoff index: docs/tenders-hardening/README.md
- Invariants and schema specifications: docs/tenders-hardening/contracts-and-invariants.md
- Detailed roadmap & tasks: docs/tenders-hardening/phase-2-remaining.md
- Deepwork log: .slim/deepwork/tenders-9of10.md
- Gate policy: Lighter gate (one reviewer per increment, Oracle gate only at phase end, batch findings).
- Deferred items (do NOT implement now): Rotating backups + recovery UI, managed-file lifecycle (trash/undo/orphan reconciliation), main-owned readiness snapshot binding.

## Objectives & Requirements

### R1. Live Regression Smoke (Task 2A)
Verify that the built Electron app and all 14 hardened privileged IPC handlers function without authorization or origin-matching failures (INVALID_REQUEST / Unauthorized).
- Use an isolated scratch userData under %LOCALAPPDATA%\Temp\opencode\. Never touch real user profiles or terminate unrelated processes (PID 21200).
- Validate through real UI: requirement status change, upload + save vault document, export compliance matrix, generate Draft Docs, CRM sync (if available).
- Verify persistence across scratch restart.

### R2. Renderer v2 Persistence Cutover (Task 2B)
Cut renderer persistence over from localStorage to the authoritative v2 store:
- **Hydration**: In pps/tenders/src/renderer/src/store.ts and components/App.tsx, hydrate via loadStoreV2().
  - 
ot-found: Clean empty workspace (no demo seeding).
  - migrated: Render migrated data and commit once via saveStoreV2({ expectedRevision: 0, document }).
  - loaded: Set active state directly from committed snapshot.
  - Failure (READ_FAILED / UNSUPPORTED_SCHEMA_VERSION): Show explicit error/recovery state; never silently overwrite or synthesize empty.
- **Persistence**: Persist mutations via saveStoreV2({ expectedRevision, document }); update local store only from the returned committed snapshot.
- **Save State UI**: Implement a dedicated theme-compliant save status indicator (components/SaveStatus.tsx and workspace chrome) displaying Loading, Saving, Saved, Save Failed (with Retry), and Conflict.
- **Multi-window Sync**: Listen to onStoreChangedV2 to update state if another window mutates data.
- **No Domain localStorage**: Workspaces, tenders, customers, and vault records must not be stored in localStorage. Retain only UI preferences (active page, zoom, pane dimensions) under a designated UI-only key.
- **Retire Legacy IPC**: Cease renderer use of getStoredData and saveStoredData.

### R3. Quality Gates & Oracle Review (Task 2C)
- Maintain TDD practices.
- Ensure all repository guards pass: full Tenders test suite (588+ passing), typecheck, Tenders and Shell builds, theme-color checks, and code formatting.
- Execute isolated built-Electron E2E verification for hydration, mutation, restart, retry on failure, and conflict detection.
- Complete the Phase 2 Oracle gate with explicit PASS evidence against revised exit criteria.

## Acceptance Criteria
- [ ] Renderer hydrates correctly from loadStoreV2 across all four states (
ot-found, migrated, loaded, error).
- [ ] No domain records (workspaces, tenders, customers, vault docs) are written to or read from localStorage.
- [ ] Every domain mutation persists via saveStoreV2 with CAS revision tracking.
- [ ] Save failure preserves uncommitted local edits and surfaces Save Failed + Retry.
- [ ] REVISION_CONFLICT is surfaced cleanly without overwriting newer disk revisions.
- [ ] Theme guard (
pm run check:theme-colors) passes without raw hex or rgb styling in new UI components.
- [ ] 
pm test -w @genoffice/tenders passes with 0 failures (>=588 passing + new tests).
- [ ] 
pm run typecheck -w @genoffice/tenders passes with 0 errors.
- [ ] 
pm run build -w @genoffice/tenders and 
pm run build -w @genoffice/shell build cleanly.
- [ ] 
pm run check:theme-colors and 
pm run format:check pass.
- [ ] Isolated built-Electron smoke and E2E journeys succeed.
- [ ] Phase 2 Oracle gate passes with confirmation that v2 is the single authoritative source of truth.

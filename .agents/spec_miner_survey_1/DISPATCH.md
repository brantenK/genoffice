## 2026-09-15T04:54:15Z
You are spec_miner_survey_1.
Your working directory is: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\spec_miner_survey_1

Mission:
Map the precise specifications, invariants, schema requirements, and acceptance criteria for Phase 2 (Durability) remaining work in Tenders 9/10 hardening.

Mandatory reading:
1. C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (specifically Section ## 2026-09-15T04:52:08Z)
2. C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_6\DISPATCH.md
3. docs/tenders-hardening/phase-2-remaining.md
4. docs/tenders-hardening/contracts-and-invariants.md
5. docs/tenders-hardening/README.md
6. .slim/deepwork/tenders-9of10.md

Key investigation areas:
- Task 2A (Live Regression Smoke):
  * The 14 hardened privileged IPC handlers: what are their names, arguments, return schemas, authorization and origin checks.
  * Isolated scratch userData under %LOCALAPPDATA%\Temp\opencode\ requirements.
  * Constraints: never touch real user profiles or terminate unrelated processes (PID 21200).
  * Real UI workflow coverage: requirement status change, upload + save vault document, export compliance matrix, generate Draft Docs, CRM sync.
  * Persistence across scratch restart verification requirements.
- Task 2B (Renderer v2 Persistence Cutover):
  * Hydration states: not-found, migrated, loaded, failure (READ_FAILED, UNSUPPORTED_SCHEMA_VERSION). What exact behavior is required for each?
  * CAS (compare-and-swap) revision tracking rules: expectedRevision, document, REVISION_CONFLICT handling.
  * Multi-window sync: onStoreChangedV2 contract and behavior.
  * LocalStorage rules: what UI preferences may remain (active page, zoom, pane dimensions) under what key, and strict prohibition of domain records (workspaces, tenders, customers, vault docs).
  * SaveStatus UI: exact states (Loading, Saving, Saved, Save Failed with Retry, Conflict), theme compliance, placement.
  * Legacy IPC retirement: getStoredData / saveStoredData.
- Task 2C (Quality Gates & Oracle Review):
  * All required repository guards, test thresholds (588+ passing), typecheck, builds, theme colors, format.
  * Oracle gate exit criteria.
- Deferred items: Rotating backups + recovery UI, managed-file lifecycle, main-owned readiness snapshot binding (confirm what NOT to do).

Output requirements:
- Write comprehensive findings to C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\spec_miner_survey_1\spec_analysis.md
- Write a self-contained handoff.md in your working directory.
- Send a completion message via send_message to orchestrator_6 with a summary of the key findings.

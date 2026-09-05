## 2026-09-05T00:49:52Z

You are worker_m4_tests, an implementation and test engineering worker.
Your assigned working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_m4_tests

You MUST read ORIGINAL_REQUEST.md before starting work:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md
Specifically inspect the latest request dated 2026-09-04T18:31:53Z.

Also read PROJECT.md:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\PROJECT.md

Scope of Milestone 4: Automated Testing and Verification Suite (R4)
Your write ownership covers:
- apps/tenders/vitest.config.ts
- apps/tenders/package.json
- apps/tenders/tests/shredder-heuristics.test.ts
- apps/tenders/tests/compliance-gap.test.ts
- apps/tenders/tests/store-migrations.test.ts
- apps/tenders/tests/ipc-handlers.test.ts

Detailed implementation tasks:
1. **Configure Vitest in `apps/tenders`**:
   - Create `apps/tenders/vitest.config.ts` following monorepo conventions (see `apps/docs/vitest.config.ts` for alias and environment patterns).
   - Add `"test": "vitest run"` to `"scripts"` in `apps/tenders/package.json`.
2. **Author 4 Comprehensive Automated Test Suites in `apps/tenders/tests/`**:
   - `apps/tenders/tests/shredder-heuristics.test.ts`:
     - Test line extraction, noise filtering, and clause stitching in `clauses.ts`.
     - Test 35 sentence scoring rules, category classification (Technical, Financial, Legal, Experience, Personnel, Plant/Equipment), and confidence scoring in `shred.ts`.
     - Test tender title, reference number, issuing authority, and closing date extraction heuristics.
     - Test edge cases: uppercase heading detection, numbered/bulleted subclauses, South African tender clauses (CIDB grading, SBD 4, SBD 6.1, PPPFA, B-BBEE level, CSD registration).
   - `apps/tenders/tests/compliance-gap.test.ts`:
     - Test document health evaluation (VALID, EXPIRED, EXPIRING_SOON, MISSING, UNATTACHED).
     - Test the strict 90-day police stamp certification window calculation (within 90 days vs expired).
     - Test keyword matching and the 0.5 similarity auto-link threshold between vault returnables and RFP compliance requirements.
     - Test mandatory vs non-mandatory requirement flags, disqualifier detection, and readiness score calculation.
   - `apps/tenders/tests/store-migrations.test.ts`:
     - Test `migrateAndValidateTenders` in `apps/tenders/src/main/tenders-main.ts`.
     - Test default seeding and legacy data migrations: ensure `MOCK_COMPANY` (Thabo Engineering), `MOCK_CUSTOMERS`, and all 7 compliance documents in `MOCK_VAULT` (`vd-tax`, `vd-coida`, `vd-bbbee`, `vd-cipc`, `vd-directors`, `vd-sbd`, `vd-csd`) are preserved.
     - Test atomic write persistence (`.tmp` + renameSync with retry backoff).
     - Test corrupted JSON handling and `.corrupted.bak` backup creation.
     - Test Zustand store serialization / rehydration (`store.ts`): verify durable relative paths (`documents/...`, `vault/...`) are preserved while transient session `blob:` URLs are cleanly stripped.
   - `apps/tenders/tests/ipc-handlers.test.ts`:
     - Test Electron IPC handlers registered in `tenders-main.ts`:
       - `tenders:data-changed` push notifications
       - `tenders:get-stored-data` and `tenders:save-stored-data`
       - `tenders:save-document`, `tenders:read-document`, `tenders:open-document`, `tenders:delete-document`
       - Path traversal security validation: verify `resolveSafeTendersPath` strictly prevents escaping `userData/tenders/documents/` and `userData/tenders/vault/` (e.g. `../../etc`, absolute Windows paths, UNC paths).
       - Cross-app handlers: CRM sync with deterministic ID `deal-tender-${id}`, and Sheets CSV export with strict RFC 4180 unspaced comma delimiter and UTF-8 BOM.
3. **Run Verifications**:
   - Run `npm test` in `apps/tenders` (or `npx vitest run --config apps/tenders/vitest.config.ts`) — all tests must pass 100%.
   - Run `npm run check:brand` — 0 violations.
   - Run `npm run typecheck` across all 22 monorepo packages — 0 errors.
   - Run all existing verification scripts:
     - `npx tsx tools/verify-tenders-sync.ts`
     - `npx tsx tools/verify-tenders-storage.ts`
     - `npx tsx tools/verify-tenders-interop.ts`
     - `node tools/verify-suite-workflows.mjs`

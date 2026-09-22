# Dispatch: worker_2a_smoke

- **Task**: Live Regression Smoke (Phase 2 / Task 2A)
- **Agent Directory**: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_2a_smoke
- **Original Request**: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md
- **References**:
  - `docs/tenders-hardening/README.md`
  - `docs/tenders-hardening/contracts-and-invariants.md`
  - `docs/tenders-hardening/phase-2-remaining.md`
  - `e2e/tenders-regression-smoke.spec.ts`

## MANDATORY INTEGRITY WARNING
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Objective
Execute the live regression smoke test against the built Electron shell to verify that all 14 hardened privileged IPC handlers function without authorization or origin-matching failures (`INVALID_REQUEST` / `Unauthorized`).

## Instructions
1. First, ensure Tenders and Shell builds are fresh:
   `npm run build -w @genoffice/tenders; if ($?) { npm run build -w @genoffice/shell }`
2. Run the dedicated live regression smoke spec:
   `npx playwright test e2e/tenders-regression-smoke.spec.ts` (or `npm run test:e2e -- e2e/tenders-regression-smoke.spec.ts`)
3. Safety & isolation rules:
   - Playwright uses an isolated scratch `userData` under temp directory. Never touch real user profiles.
   - NEVER terminate unrelated processes (specifically PID 21200).
4. Inspect the test results and the generated artifacts in `e2e/artifacts/`:
   - Find the latest `tenders-regression-smoke-*.json` report.
   - Check all recorded flows:
     1. Seed data loads (demo workspace, tender RFP-WTR-2026-04)
     2. Change a requirement status
     3. Upload + save a vault document
     4. Export compliance matrix
     5. Generate Draft Docs
     6. CRM sync
     7. Restart against scratch profile and confirm persistence
     8. Blocked readiness and conservative proposal checks
   - Check for any `Unauthorized` / `INVALID_REQUEST` / origin mismatch errors in console logs or diagnostics.


## 2026-09-15T16:26:14Z
Execute Live Regression Smoke (Task 2A) against built Electron shell:
1. Build Tenders and Shell: `npm run build -w @genoffice/tenders; if ($?) { npm run build -w @genoffice/shell }`
2. Run Playwright smoke test: `npm run test:e2e -- e2e/tenders-regression-smoke.spec.ts`
3. Check generated artifacts in e2e/artifacts/
4. Verify all 6 flows pass, restart persistence passes, blocked readiness & conservative proposals are verified, and no Unauthorized / INVALID_REQUEST trust errors occur.
5. Do NOT touch real user profiles or terminate unrelated processes (PID 21200).
6. Write findings to handoff.md.
7. Send message to parent when complete.

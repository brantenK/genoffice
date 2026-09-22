## 2026-09-15T04:54:15Z

You are explorer_smoke_survey_3.
Your working directory is: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_smoke_survey_3

Mission:
Explore the test suites, scripts, and live smoke test mechanics for Task 2A (Live Regression Smoke) and Task 2C (Quality Gates).

Mandatory reading:
1. C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (specifically Section ## 2026-09-15T04:52:08Z)
2. C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_6\DISPATCH.md

Key investigation areas:
- Existing Test Infrastructure:
  * Inspect apps/tenders/package.json, root package.json, Vitest/Playwright configs, and existing tests in apps/tenders/test/ or tools/.
  * What tests currently exist for the 14 privileged IPC handlers? What tests exist for v2 store persistence?
  * Check how many tests currently pass (baseline: >=588 passing).
- Live Regression Smoke for Task 2A:
  * How can we execute a live regression smoke test against the built Electron app without touching real user profiles?
  * Inspect how %LOCALAPPDATA%\Temp\opencode\ scratch userData is specified or configured (command line flags like --user-data-dir or env vars).
  * Safety rules: CRITICAL — PID 21200 must NEVER be terminated or touched. Unrelated processes must not be affected. Real user profiles must never be modified.
  * UI workflows to smoke test: requirement status change, upload + save vault document, export compliance matrix, generate Draft Docs, CRM sync.
  * Check if there are existing automated E2E scripts (e.g. tools/verify-*.mjs or Playwright / Spectron / custom scripts) that test Electron live.
  * How to verify persistence across scratch restart.
- Quality Gates (Task 2C):
  * Verify commands for: npm test -w @genoffice/tenders, npm run typecheck -w @genoffice/tenders, npm run build -w @genoffice/tenders, npm run build -w @genoffice/shell, npm run check:theme-colors, npm run format:check.
  * Identify any potential blockers, missing dependencies, or setup required.

Output requirements:
- Write comprehensive findings to C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_smoke_survey_3\smoke_test_analysis.md
- Write a self-contained handoff.md in your working directory.
- Send a completion message via send_message to orchestrator_6 with a summary of the key findings.

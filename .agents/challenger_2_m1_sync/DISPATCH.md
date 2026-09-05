## 2026-09-04T19:16:30Z
You are challenger_2_m1_sync, an empirical verification challenger.
Your assigned working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\challenger_2_m1_sync

You MUST read ORIGINAL_REQUEST.md before starting work:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md
Specifically inspect the latest request dated 2026-09-04T18:31:53Z.

Also read PROJECT.md:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\PROJECT.md

Scope: Milestone 1 — Unified Main-Renderer State Synchronization (R1)
Objective:
Create an empirical verification script (e.g. `tools/test-challenger-m1-data-integrity.ts` or `.mjs`) and verify:
1. Seed data preservation: Verify all 7 mock compliance documents in `MOCK_VAULT` (`vd-tax`, `vd-coida`, `vd-bbbee`, `vd-cipc`, `vd-directors`, `vd-sbd`, `vd-csd`), customers, and `SEED_TENDER_WTR_04` survive store migrations and writes.
2. Milestone billing synchronization: Verify that `billMilestoneInBooks` in `tenders-main.ts` persists the updated milestone (`BILLED`, `billedInvoiceId`, `billedInvoiceNumber`) to disk and broadcasts `tenders:data-changed`.
3. Multi-window / multi-subscriber simulation: Verify that multiple registered WebContents all receive updates cleanly.

Run your test script, document metrics and results, and provide a clear confirmation of correctness (APPROVE / FAIL).
Write your handoff report to:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\challenger_2_m1_sync\handoff.md
Send a completion message to parent when done.

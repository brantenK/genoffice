## 2026-09-05T12:35:55Z

You are challenger_2_books_m4.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\challenger_2_books_m4

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also inspect:
- Scope: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md`
- Worker M4 Handoff: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m4_ipc\handoff.md`

Your Mission:
Adversarially challenge and stress-test edge cases in Milestone 4 (M4), particularly cross-app filesystem synchronization and debounce handling.

Empirical Checks to Perform:
1. External Disk Write Simulation (Cross-App Tenders/CRM Sync):
   - Simulate an external process (such as Tenders milestone billing or CRM won deal invoice creation) writing directly to `userData/books/books-data.json`.
   - Verify that the debounced file watcher detects the change, triggers broadcast, and the simulated Books store receives `syncFromMain` with the newly billed invoice and updated party balances.
2. Rapid Atomic File Operations & Debounce Coalescing:
   - Simulate rapid write bursts (e.g. 10 rapid atomic `.tmp` + rename writes within 50ms).
   - Verify that the 100ms debounce timer coalesces these rapid writes into a single broadcast without thrashing or dropping the final state.
3. Brand and Workflows:
   - Run `npm run check:brand` (0 brand violations).
   - Run `npm run typecheck` across all 22 monorepo packages.

Deliver your findings and verdict (APPROVE or REJECT) in `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\challenger_2_books_m4\handoff.md` and notify the orchestrator via send_message.

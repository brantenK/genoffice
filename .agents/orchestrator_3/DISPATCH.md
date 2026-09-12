## 2026-09-04T18:33:22Z

You are the Project Orchestrator for the Zanostack Tenders overhaul and hardening task.

Your assigned working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_3

The project repository root is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice

The authoritative user request is recorded in:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md
(Refer to the latest request dated 2026-09-04T18:31:53Z).

Your mission is to orchestrate and execute the complete overhaul and hardening of Zanostack Tenders (`apps/tenders`) and its Electron backend (`tenders-main.ts`), fulfilling all four requirements and acceptance criteria:
1. R1: Unified Main-Renderer State Synchronization between Zustand store and `userData/tenders/tenders-data.json` via IPC without requiring reloads.
2. R2: Persistent Disk Storage for RFP Documents & Vault Returnables in the application user data directory, replacing blob URLs with durable paths / IPC.
3. R3: Cross-App Interoperability & Export Workflows (Zano Books milestone billing double-entry & invoices, Zano CRM deal synchronization, Docs & Sheets compliance matrix & draft proposal exports).
4. R4: Automated Testing and Verification Suite covering deterministic RFP shredder heuristics, compliance gap analysis, store serialization/migrations, and IPC handlers, with 100% tests passing and `npm run typecheck` passing cleanly with zero errors across `apps/tenders` and dependent apps.

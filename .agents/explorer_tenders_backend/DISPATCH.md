## 2026-09-04T18:35:07Z
Objective:
Investigate apps/tenders Electron main process, IPC, and persistence:
1. Examine apps/tenders/src/main/tenders-main.ts, apps/tenders/src/shared/ipc.ts, apps/tenders/src/preload/index.ts, and apps/shell/src/main/index.ts.
2. Investigate how userData/tenders/tenders-data.json is loaded, serialized, validated, and migrated:
   - How is atomic write handled?
   - What IPC channels exist currently for Tenders?
   - Is there an IPC notification mechanism from main to renderer (or across windows) when data changes?
3. Investigate document and PDF disk storage (R2):
   - Where in userData should tender PDFs and vault files be stored? (e.g., userData/tenders/documents/, vault/)?
   - What IPC handlers are needed for storing files, reading files, getting file paths/URLs, or serving them safely?
4. Investigate how tenders-main interacts with shell lifecycle and other apps.
5. Write a comprehensive, structured handoff report with exact file paths, line numbers, code snippets, and architectural recommendations for R1 and R2 to:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_backend\handoff.md

Hard constraints:
- Do NOT edit or write source code files. You are read-only.
- Write your handoff to handoff.md in your working directory.
- When finished, send a completion message to parent with summary.

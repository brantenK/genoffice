## 2026-09-03T18:07:16Z
Implement Milestone 3: Tenders Contract Milestone Billing in Zano Books (Features F9, F10, F11, F12 in PROJECT.md)
Role: implementer, qa, specialist
Parent: d94f5282-fbc7-4b07-8909-cf2550459903 (parent)
Working directory: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_m3

1. Type Definitions & Data Models (`apps/tenders/src/shared/types.ts`)
2. IPC Protocol & Preload (`apps/tenders/src/shared/ipc.ts` & `apps/tenders/src/preload/index.ts`)
3. Main Process Implementation (`apps/tenders/src/main/tenders-main.ts` & `apps/shell/src/main/index.ts`)
4. Tenders UI Components (`apps/tenders/src/renderer/`)
5. Verification:
   - npm run check:brand
   - npm run typecheck
   - node tools/verify-suite-workflows.mjs --feature r3
   - node tools/verify-suite-workflows.mjs --feature r2
   - node tools/verify-suite-workflows.mjs --feature r1
   - npm run build:all

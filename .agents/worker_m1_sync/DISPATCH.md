## 2026-09-04T18:52:54Z

You are worker_m1_sync, an implementation and verification worker.
Your assigned working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_m1_sync

You MUST read ORIGINAL_REQUEST.md before starting work:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md
Specifically inspect the latest request dated 2026-09-04T18:31:53Z.

Also read PROJECT.md:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\PROJECT.md

And read the Explorer handoff reports:
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_core\handoff.md
- c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_tenders_backend\handoff.md

Scope of Milestone 1: Unified Main-Renderer State Synchronization (R1)
Your write ownership covers:
- apps/tenders/src/shared/ipc.ts
- apps/tenders/src/main/tenders-main.ts
- apps/tenders/src/preload/index.ts
- apps/tenders/src/renderer/src/store.ts
- apps/tenders/src/renderer/src/components/App.tsx
- apps/shell/src/main/index.ts / tab-manager.ts (if needed to pass WebContents to tenders-main)

Detailed implementation tasks:
1. In `apps/tenders/src/shared/ipc.ts`:
   - Add `TENDERS_CHANNELS.dataChanged = 'tenders:data-changed'` (or `dataUpdated`).
   - Define typed signatures in `TendersApiBridge` if needed.
2. In `apps/tenders/src/main/tenders-main.ts`:
   - Track active Tenders WebContents (when views are registered or created).
   - In `writeTendersStore`, broadcast the updated `TendersData` envelope to all active WebContents:
     `wc.send(TENDERS_CHANNELS.dataChanged, tendersData)`
   - Harmonize seed data: Ensure `migrateAndValidateTenders` default seed includes `MOCK_COMPANY` (Thabo Engineering), `MOCK_CUSTOMERS`, and `MOCK_VAULT` (all 7 compliance documents) so hydrating from backend never wipes the mock vault.
   - In `billMilestoneInBooks`, ensure it persists and triggers broadcast.
3. In `apps/tenders/src/preload/index.ts`:
   - Expose `onDataChanged: (callback: (data: TendersData) => void) => () => void` in `window.tendersApi`.
   - Expose `getStoredData: () => Promise<string | null>` and `saveStoredData: (json: string) => Promise<{ ok: boolean; error?: string }>`.
4. In `apps/tenders/src/renderer/src/store.ts`:
   - Implement `loadFromMain`: On mount, fetch from `window.tendersApi.getStoredData()`. If valid data is returned, rehydrate store. If null, seed is saved to main via `saveStoredData`.
   - Implement `syncFromMain(data: TendersData)`: Rehydrate in-memory state cleanly using an `isSyncingFromMain` guard to avoid feedback loops.
   - Implement debounced `saveToMain(get())` on user mutations.
5. In `apps/tenders/src/renderer/src/components/App.tsx`:
   - In a top-level `useEffect`, call `loadFromMain()` and subscribe to `onDataChanged`.
6. Verification:
   - Run `npm run check:brand` (must pass with 0 violations).
   - Run `npm run typecheck` across monorepo packages (must pass with 0 errors).
   - Run a verification test confirming that:
     a) Data saved in renderer is persisted to `tenders-data.json` and loads identically on restart.
     b) External modifications to `tenders-data.json` emit `tenders:data-changed` and update renderer store without requiring a reload.

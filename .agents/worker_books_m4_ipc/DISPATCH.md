## 2026-09-05T12:20:54Z

<USER_REQUEST>
You are worker_books_m4_ipc.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m4_ipc

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also inspect:
- Scope: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md`
- Survey CoA & Store Explorer: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_books_coa_store\handoff.md`

Your Mission:
Implement Milestone 4 (M4): Real-Time IPC Synchronization & Cross-App Event Pipeline (Features F14, F15, F16).

Write Ownership (You exclusively own and may edit these files):
- `apps/books/src/shared/ipc.ts`
- `apps/books/src/preload/index.ts`
- `apps/books/src/main/books-main.ts`
- `apps/books/src/renderer/src/store.ts`
- `apps/books/src/renderer/src/components/Desk.tsx`

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Detailed Tasks:
1. IPC Channels & API (`shared/ipc.ts` and `preload/index.ts`):
   - In `shared/ipc.ts`:
     - Define `BOOKS_CHANNELS.DATA_CHANGED = 'books:data-changed'` (or ensure it exists).
     - Add `onDataChanged?: (callback: (data: BooksData) => void) => () => void` to the `BooksApi` interface.
   - In `preload/index.ts`:
     - Expose `onDataChanged: (callback) => { ... }` in `window.booksApi`:
       - Use `ipcRenderer.on('books:data-changed', (_, data) => callback(data))`
       - Return a cleanup function: `() => ipcRenderer.removeListener('books:data-changed', listener)`.

2. Main Process Broadcast Pipeline & Watcher (`main/books-main.ts`):
   - WebContents Tracking:
     - Maintain a `Set<WebContents>` of registered Books renderers, adding `event.sender` when `books:get-data` or any books handler is invoked, and removing on `sender.on('destroyed', ...)`.
   - `broadcastBooksData(data: BooksData, excludeSender?: WebContents)`:
     - Loop through tracked WebContents and send `'books:data-changed'` with `data`, skipping `excludeSender` (Layer 1 loop suppression).
   - In all persistence calls (`persistBooksData`, IPC mutation handlers):
     - Trigger `broadcastBooksData(data, sender)`.
   - File Watcher on `userData/books/books-data.json`:
     - Watch for file changes (e.g. `fs.watch` or `fs.watchFile` with debounce e.g. 100ms).
     - When file changes externally (e.g. from Tenders milestone billing or CRM won deal invoicing writing to disk), reload via `readBooksStore()` and broadcast to all active WebContents (`broadcastBooksData(data)`).

3. Renderer Store Live Sync & Layer 2 Loop Suppression (`renderer/src/store.ts` and `Desk.tsx`):
   - In `store.ts`:
     - Maintain `lastSavedHash` or `lastSavedJson` string.
     - When saving state to disk via IPC, record hash of saved data.
     - Implement `syncFromMain(incomingData: BooksData)` action:
       - Compare hash/serialization of incomingData with `lastSavedHash`. If identical, do nothing (Layer 2 loop suppression).
       - If changed, update the Zustand store state in-memory (`accounts`, `invoices`, `journalEntries`, `parties`, `bankTransactions`, `reconciliationRules`, etc.) without calling `persistBooksData` back to main!
       - Recompute party balances if needed.
   - In `Desk.tsx`:
     - Add `useEffect` subscribing to `window.booksApi?.onDataChanged`:
       ```tsx
       useEffect(() => {
         const unsubscribe = window.booksApi?.onDataChanged?.((data) => {
           useBooksStore.getState().syncFromMain(data)
         })
         return () => {
           unsubscribe?.()
         }
       }, [])
       ```

4. Verification Commands:
   - Create a dedicated test script `tools/verify-books-m4-challenger.ts` testing:
     - `books:data-changed` broadcast to registered WebContents mock.
     - Layer 1 sender exclusion (sender does not receive echo).
     - Layer 2 hash comparison loop suppression (store ignores identical payload).
     - Live store update when external data arrives without re-persisting.
     - Cross-app sync simulation (writing to `books-data.json` triggers broadcast and store updates).
   - Run `npx tsx tools/verify-books-m4-challenger.ts`
   - Run `npx tsx tools/verify-books-m3-challenger.ts`
   - Run `npx tsx tools/verify-books-m2-challenger.ts`
   - Run `node tools/verify-suite-workflows.mjs`
   - Run `npm run typecheck -w @genoffice/books`
   - Run `npm run build -w @genoffice/books`
   - Run `npm run typecheck` across all 22 monorepo packages
   - Run `npm run check:brand`

5. Report:
   - Deliver your handoff report to `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m4_ipc\handoff.md`.
   - Include changes made, files modified, verification commands and exact outputs.
   - When done, send a completion message to the orchestrator.
</USER_REQUEST>

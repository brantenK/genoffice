# BRIEFING — 2026-09-05T07:01:45Z

## Mission
Investigate Requirement R2 (Chart of Accounts Harmonization & Schema Invariants) and Requirement R4 (Real-Time IPC Synchronization `books:data-changed`) for Zano Books backend (`apps/books`).

## 🔒 My Identity
- Archetype: explorer
- Roles: explorer, investigator, synthesizer
- Working directory: c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_books_coa_store
- Original parent: 3d77b420-8b70-452a-8634-e59f49e46b15
- Milestone: Books Backend Audit & Hardening (R2 & R4)

## 🔒 Key Constraints
- Read-only investigation — do NOT implement or edit source code files
- Produce structured report at `.agents/explorer_books_coa_store/handoff.md`
- Report exact file paths, line numbers, current behavior vs required behavior, and concrete fix plan
- Send summary message to orchestrator parent upon completion

## Current Parent
- Conversation ID: 3d77b420-8b70-452a-8634-e59f49e46b15
- Updated: 2026-09-05T07:01:45Z

## Investigation State
- **Explored paths**:
  - `apps/books/src/main/books-main.ts`
  - `apps/books/src/renderer/src/mock/initialData.ts`
  - `apps/books/src/renderer/src/store.ts`
  - `apps/books/src/preload/index.ts`
  - `apps/books/src/shared/ipc.ts`
  - `apps/books/src/shared/types.ts`
  - `apps/books/src/renderer/src/components/ChartOfAccounts.tsx`
  - `apps/books/src/renderer/src/components/ReportsView.tsx`
  - `apps/books/src/renderer/src/components/Dashboard.tsx`
  - `apps/books/src/renderer/src/components/Desk.tsx`
  - `apps/tenders/src/main/tenders-main.ts`
  - `apps/crm/src/main/crm-main.ts`
  - `apps/shell/src/main/index.ts`
  - Peer reports from `explorer_books_ledger` and `explorer_books_reconciliation`
- **Key findings**:
  - R2 CoA Disparity: Backend only defines 5 accounts with missing parent groups; renderer has 23 accounts; `ChartOfAccounts.tsx` crashes to a blank view on fresh initialization; 22 standard accounts must be harmonized.
  - R2 Dashboard Bug: `Dashboard.tsx` sums all accounts by root type without `!a.isGroup`, doubling income/expenses if groups are populated.
  - R2 Storage: Atomic write with `.tmp` and rename exists; corrupt JSON backup writes `.corrupted.bak` but lacks timestamped `.corrupt-[timestamp]`.
  - R4 IPC: No WebContents tracking, no `broadcastBooksData`, no `books:data-changed` channel, no renderer listener, no loop suppression guards. Cross-app milestone billing leaves active Books tabs stale until restart.
- **Unexplored areas**: None. Full scope explored and documented.

## Key Decisions Made
- Defined unified 22 standard accounts specification with 5 root categories and parent-child hierarchy.
- Designed dual-layer loop-suppression for `books:data-changed` (WebContents sender exclusion in main, `lastSavedPayload` check in renderer).
- Backwards compatibility guaranteed for existing tests expecting `CORE_ACCOUNTS` and `${filePath}.corrupted.bak`.

## Artifact Index
- `.agents/explorer_books_coa_store/DISPATCH.md` — Initial dispatch message
- `.agents/explorer_books_coa_store/BRIEFING.md` — Agent memory
- `.agents/explorer_books_coa_store/progress.md` — Liveness & heartbeat
- `.agents/explorer_books_coa_store/handoff.md` — Final technical findings report

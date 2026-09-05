## 2026-09-05T07:50:22Z
You are worker_books_m2_ledger.
Your working directory is:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m2_ledger

You MUST read the original user request at:
c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md (under section ## 2026-09-05T06:42:35Z)

Also read:
- Scope: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_5\SCOPE.md`
- Survey Ledger: `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\explorer_books_ledger\handoff.md`
- Accounting Engine: `apps/books/src/shared/accounting.ts`

Your Mission:
Implement Milestone 2 (M2): Strict Double-Entry Bookkeeping & Balanced Journal Posting in Renderer Store Actions (Features F5, F6, F7, F8, F9).

Write Ownership (You exclusively own and may edit these files):
- `apps/books/src/renderer/src/store.ts`
- `apps/books/src/renderer/src/components/InvoiceForm.tsx` (if needed for line account selection or draft transitions)
- Any necessary types in `apps/books/src/shared/types.ts` (if required for settlement/reversal tracking)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Detailed Tasks:
1. In `apps/books/src/renderer/src/store.ts`:
   - Import accounting functions from `../../shared/accounting`:
     `round2`, `calculateInvoiceTotals`, `createSalesInvoiceJournal`, `createPurchaseBillJournal`, `createSettlementJournal`, `recomputePartyBalances`.
   - Fix `saveInvoice` (handling both create and update):
     a) Always calculate accurate totals via `calculateInvoiceTotals(targetInvoice.items)`: `subtotal`, `taxTotal`, `grandTotal`. Ensure `targetInvoice.grandTotal = totals.grandTotal`, `targetInvoice.subtotal = totals.subtotal`, `targetInvoice.taxTotal = totals.taxTotal`.
     b) For new invoices (`!isEdit`):
        - `outstandingAmount`: if `targetInvoice.status === 'Paid'`, set to `0`; otherwise set to `targetInvoice.grandTotal`.
     c) Draft-to-Posted transition (F7):
        - Track previous invoice status (`const oldInvoice = state.invoices.find(i => i.id === targetInvoice.id)`).
        - Determine if this save is a posting event:
          - A new non-Draft invoice: `!oldInvoice && targetInvoice.status !== 'Draft'`
          - OR an existing Draft transitioning to non-Draft: `oldInvoice && oldInvoice.status === 'Draft' && targetInvoice.status !== 'Draft'`
     d) Balanced Journal Posting for Sales Invoices (F5):
        - When a Sales Invoice is posted, generate a journal entry via `createSalesInvoiceJournal(targetInvoice, state.accounts, party)`.
        - Add this journal entry to `state.journalEntries`.
        - Update account balances accurately:
          - Increment `acc-ar` balance by `targetInvoice.grandTotal`.
          - Increment line item revenue accounts by their respective net amounts (`inc.amount`).
          - Increment `acc-vat` (or `acc-vat-out`) balance by `targetInvoice.taxTotal`.
     e) Balanced Journal Posting for Purchase Bills (F6):
        - When a Purchase Bill is posted, generate a journal entry via `createPurchaseBillJournal(targetInvoice, state.accounts, party)`.
        - Add this journal entry to `state.journalEntries`.
        - Update account balances accurately:
          - Increment `acc-ap` balance by `targetInvoice.grandTotal`.
          - Increment line item expense accounts by their respective net amounts (`exp.amount`).
          - If `targetInvoice.taxTotal > 0`, increment `acc-vat-in` (or `acc-vat` if `acc-vat-in` is not used) by `targetInvoice.taxTotal`.
     f) Immediate settlement if created as 'Paid':
        - If posted with status `'Paid'`, also generate a settlement journal via `createSettlementJournal(targetInvoice, state.accounts, party, targetInvoice.grandTotal)` and update `acc-bank` and `acc-ar`/`acc-ap`.
     g) Enforce Party Balance Invariant (F9):
        - Recompute party balances using `recomputePartyBalances(newInvoices, state.parties)` so that customer and supplier balances strictly equal the sum of open invoices.
   - Fix `markInvoicePaid` (F8):
     a) Check if already paid; if so, return.
     b) Settle against actual `outstandingAmount`:
        `const settlementAmount = round2(inv.outstandingAmount > 0 ? inv.outstandingAmount : inv.grandTotal)`.
     c) Generate settlement journal entry via `createSettlementJournal(inv, state.accounts, party, settlementAmount)`.
     d) Add settlement journal entry to `state.journalEntries`.
     e) Update ledger balances:
        - If `inv.type === 'Sales'`: increment Bank (`acc-bank`) by `settlementAmount`, decrement AR (`acc-ar`) by `settlementAmount`.
        - If `inv.type === 'Purchase'`: decrement AP (`acc-ap`) by `settlementAmount`, decrement Bank (`acc-bank`) by `settlementAmount`.
     f) Update invoice: `outstandingAmount: 0`, `status: 'Paid'`.
     g) Recompute party balances via `recomputePartyBalances`.
   - Fix `deleteInvoice`:
     a) If the deleted invoice was posted (status !== 'Draft'):
        - Revert ledger account balances (decrement AR/AP, decrement revenue/expense, decrement VAT) or post reversing journal entries.
        - Ensure party balances are recomputed via `recomputePartyBalances`.

2. In `apps/books/src/renderer/src/components/InvoiceForm.tsx`:
   - Ensure the form allows selecting expense accounts for Purchase Bills (e.g. `acc-materials`, `acc-salaries`, `acc-rent`, `acc-utilities`, etc.) and revenue accounts for Sales Invoices (`acc-sales`, `acc-consult`, etc.).
   - Ensure the form calculates subtotal, taxTotal (15%), and grandTotal consistently using `calculateInvoiceTotals` or matching math.

3. Verification Commands:
   - `npm run typecheck -w @genoffice/books`
   - `npm run build -w @genoffice/books`
   - `node tools/test-challenger-m1-empirical.mjs`
   - `node tools/verify-suite-workflows.mjs`
   - `npm run typecheck` across all 22 monorepo packages
   - `npm run check:brand`

4. Report:
   - Deliver your handoff report to `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\worker_books_m2_ledger\handoff.md`.
   - Include changes made, files modified, verification commands and exact outputs.
   - When done, send a completion message to the orchestrator.

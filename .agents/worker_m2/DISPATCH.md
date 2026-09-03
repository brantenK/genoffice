## 2026-09-03T13:44:08Z

Implement Milestone 2: CRM to Zano Books Invoicing Automation (Features F5, F6, F7, F8 in PROJECT.md):
1. **IPC Protocol & Preload**:
   - In `apps/crm/src/shared/ipc.ts`: Add `createInvoiceInBooks: 'crm:create-invoice-in-books'` and `openBooks: 'crm:open-books'`. Add methods to `CrmApi` interface.
   - In `apps/crm/src/preload/index.ts`: Expose `createInvoiceInBooks: (dealId: string) => ipcRenderer.invoke(CRM_CHANNELS.createInvoiceInBooks, dealId)` and `openBooks: () => ipcRenderer.invoke(CRM_CHANNELS.openBooks)`.
2. **Main Process Implementation & Shell Integration**:
   - In `apps/crm/src/main/crm-main.ts`:
     - Add `onOpenBooks?: () => void` to `CrmRuntimeConfig`.
     - Register handler for `CRM_CHANNELS.openBooks`: calls `runtime.onOpenBooks?.()`.
     - Register handler for `CRM_CHANNELS.createInvoiceInBooks`:
       - Fetch deal via `s.getDeals().find(d => d.id === dealId)`.
       - Validate deal exists and `deal.stage === 'won'`. If already invoiced, return existing invoice details without duplicating.
       - Read or seed `userData/books/books-data.json` using `readBooksStore` from `apps/books/src/main/books-main.ts`.
       - Match or create customer `Party` in Books for `deal.companyName || deal.name`.
       - Generate next sales invoice number `INV-${new Date().getFullYear()}-${String(count + 1).padStart(3, '0')}`.
       - Compute valuation: `grandTotal = deal.amount`, `subtotal = Math.round((deal.amount / 1.15) * 100) / 100`, `taxTotal = Math.round((deal.amount - subtotal) * 100) / 100`.
       - Build `Invoice` object with `type: 'Sales'`, `partyId`, `partyName`, `crmDealId: deal.id`, line-item description `${deal.name} - Commercial Implementation & Services`, payment terms `'Payment terms: Net 30 days upon invoice receipt.'`, `status: 'Unpaid'`.
       - Update double-entry accounts in Books: `acc-ar` balance += grandTotal, `acc-sales` balance += subtotal, `acc-vat` balance += taxTotal.
       - Append balanced `JournalEntry` (Debit `acc-ar`, Credit `acc-sales`, Credit `acc-vat`).
       - Save Books store atomically via `writeBooksStore`.
       - Update CRM deal in `deals.json` with `invoiceId: invoice.id`, `invoiceNumber: invoice.invoiceNumber`, `invoicedAt: new Date().toISOString()`.
       - Trigger `runtime.onOpenBooks?.()` to activate the Books tab in the shell.
       - Return `{ ok: true, invoiceNumber: invoice.invoiceNumber, invoiceId: invoice.id }`.
   - In `apps/shell/src/main/index.ts`:
     - In `configureCrmRuntime`, wire `onOpenBooks: () => newBooksTab()`.
3. **CRM UI Components**:
   - In `apps/crm/src/renderer/src/components/DealsTableView.tsx`:
     - For won deals (`deal.stage === 'won'`):
       - If `deal.invoiceNumber`: render an invoice pill button `[📄 ${deal.invoiceNumber}]` that triggers `window.crmApi?.openBooks()`.
       - If not invoiced: render action button `[⚡ Invoice in Books]` that calls `window.crmApi?.createInvoiceInBooks(deal.id)`, updates local deal state, and shows toast notification.
   - In `apps/crm/src/renderer/src/components/DealModal.tsx`:
     - When editing a deal in `'won'` stage, render an invoicing section with current invoice status and the 1-click "Create Invoice in Zano Books" action button.
4. **Verification**:
   - Run `npm run check:brand` (must pass with 0 unauthorized brand occurrences).
   - Run `npm run typecheck` (must pass cleanly across all 22 monorepo packages).
   - Run `node tools/verify-suite-workflows.mjs --feature r2` (must pass all tests).
   - Run `npm run build:all` (must compile without error).

## 2026-09-03T17:24:46Z

**Context**: Server restart and quota reset.
**Content**: The server has restarted and quota has reset. Please resume implementing Milestone 2 (CRM to Zano Books Invoicing Automation: IPC channels, crm-main.ts Books invoice creation, shell onOpenBooks wiring, and Deals UI buttons).
**Action**: Resume execution, implement changes, verify with `node tools/verify-suite-workflows.mjs --feature r2`, `npm run check:brand`, `npm run typecheck`, and write handoff.md.

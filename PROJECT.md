# Project: Zanostack Workflow Expansion & Hardening (CRM, Tenders, Books)

## Architecture
Zanostack is an Electron-based multi-application office suite managed as an npm monorepo with 22 packages (9 apps, 13 packages).
The application shell (`apps/shell`) hosts multiple application views (`WebContentsView`) in a unified tab strip (`tabManager`).
The core applications in this workflow hardening are:
- **Zanostack CRM** (`apps/crm` / `@genoffice/crm`): Manages customer relationships, contacts, companies, and sales pipelines (`userData/crm/deals.json`).
- **Zanostack Tenders** (`apps/tenders` / `@genoffice/tenders`): Manages public/private sector RFPs, compliance matrices, company vault returnables, and contract delivery milestones (`userData/tenders/tenders-data.json`).
- **Zano Books** (`apps/books` / `@genoffice/books`): Local-first double-entry accounting software managing Chart of Accounts (`acc-bank`, `acc-ar`, `acc-ap`, `acc-sales`, `acc-vat`), parties, sales invoices, purchase bills, journal entries, and bank reconciliations (`userData/books/books-data.json`).

### Data Flow & Cross-App Integration
1. **CRM → Books Invoicing Bridge**:
   When an opportunity is marked `won` in CRM, clicking "Create Invoice in Zano Books" generates a Sales Invoice in Books, sets `crmDealId`, updates Books double-entry ledger (`acc-ar`, `acc-sales`, `acc-vat`), saves `invoiceId` and `invoiceNumber` onto the CRM deal, and switches shell active tab to Zano Books.
2. **Tenders → Books Milestone Billing Bridge**:
   When a tender contract milestone is reached, clicking "Bill Milestone in Zano Books" generates a Tax Invoice in Books linked to `tenderReference` (e.g. `RFP-WTR-2026-04`), records the issuing authority as party, posts double-entry accounting entries, updates the milestone to `BILLED` with `billedInvoiceId`, and switches shell active tab to Zano Books.
3. **Books Banking CSV Reconciliation**:
   Banking view in Zano Books imports standard bank CSV files into Bank Account (`acc-bank`), adjusts the bank ledger balance, automatically computes settlement suggestions for open sales invoices (deposits) and purchase bills (withdrawals), and executes 1-click reconciliation updating invoice status, party balance, and journal entries.
4. **Resilient Data Persistence**:
   All 3 applications use a versioned envelope `{ version: 1, updatedAt: string, ... }` with backward-compatible migration of legacy data, field validation, atomic writes (`.tmp` + rename), and corruption backup (`.corrupted.bak`).

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | CRM deals schema versioning & migration | Versioned envelope `{ version: 1, updatedAt, deals }`, legacy array migration, field validation, atomic write, corruption backup | M1 | ORIGINAL_REQUEST §R1 |
| F2 | Tenders data schema versioning & persistence | Versioned envelope `{ version: 1, updatedAt, activeCompanyId, workspaces, issuerTemplates }`, IPC bridge between store and `tenders-data.json`, atomic write | M1 | ORIGINAL_REQUEST §R1 |
| F3 | Books data schema versioning & validation | Versioned envelope `{ version: 1, updatedAt, ...BooksData }`, safe migration, double-entry validation, atomic write | M1 | ORIGINAL_REQUEST §R1 |
| F4 | Safe external sync merge logic | External cross-app writes (Tenders->CRM, CRM->Books, Tenders->Books) safely merge/update entities by ID without dropping existing records | M1 | ORIGINAL_REQUEST §R1 |
| F5 | CRM won deals detection & invoicing eligibility | Identify won deals (`deal.stage === 'won'`), determine invoicing state (`invoiceNumber`/`invoiceId`) | M2 | ORIGINAL_REQUEST §R2 |
| F6 | CRM to Books invoice creation handler | IPC handler `crm:create-invoice-in-books` mapping deal to Sales Invoice (counterparty, valuation, line item, payment terms, `crmDealId`, double-entry entries) | M2 | ORIGINAL_REQUEST §R2 |
| F7 | CRM deal back-reference update | Record generated `invoiceId`, `invoiceNumber`, and `invoicedAt` onto the CRM deal in `deals.json` | M2 | ORIGINAL_REQUEST §R2 |
| F8 | CRM UI 1-click action & tab switch | "Create Invoice in Zano Books" button and linked invoice badge in `DealsTableView` & `DealModal`; triggers `onOpenBooks` shell tab activation | M2 | ORIGINAL_REQUEST §R2 |
| F9 | Tenders contract milestone data model | `ContractMilestone` interface on `TenderRecord` (`id`, `title`, `description`, `amount`, `status`, `dueDate`, `completedDate`, `billedInvoiceId`); seed RFP-WTR-2026-04 | M3 | ORIGINAL_REQUEST §R3 |
| F10 | Tenders to Books milestone billing handler | IPC handler `tenders:bill-milestone-in-books` creating Tax Invoice in Books with `tenderReference`, issuing authority, milestone amount, double-entry entries | M3 | ORIGINAL_REQUEST §R3 |
| F11 | Tenders milestone status update | Update milestone status to `BILLED`, store `billedInvoiceId`, persist to `tenders-data.json` | M3 | ORIGINAL_REQUEST §R3 |
| F12 | Tenders UI milestone workspace & tab switch | Milestones drawer/section in `Workspace.tsx` with status badges and "Bill Milestone in Zano Books" button; triggers `onOpenBooks` shell tab activation | M3 | ORIGINAL_REQUEST §R3 |
| F13 | Books Banking view & tab affordance | Add `'banking'` navigation tab to `Desk.tsx` and create `BankingView.tsx` displaying `acc-bank` account balance and transactions | M4 | ORIGINAL_REQUEST §R4 |
| F14 | Bank statement CSV parser & ingestion | Parse standard bank CSVs (Date, Description, Reference, Amount/Debit/Credit), handle currency formatting, ingest into `acc-bank` | M4 | ORIGINAL_REQUEST §R4 |
| F15 | Bank ledger balance adjustment | Update `acc-bank.balance` in Books Chart of Accounts by net transaction amount upon CSV import | M4 | ORIGINAL_REQUEST §R4 |
| F16 | Settlement suggestion matching engine | Match unreconciled bank transactions against open invoices/bills by amount and text tokens (invoice number, tender reference, party name) with confidence scoring | M4 | ORIGINAL_REQUEST §R4 |
| F17 | 1-click bank reconciliation action | Reconcile matched transaction, mark invoice `Paid`, adjust party balance, post balancing settlement journal entry | M4 | ORIGINAL_REQUEST §R4 |
| F18 | Automated integration verification script | Standalone script `tools/verify-suite-workflows.mjs` verifying R1-R4 end-to-end, exiting with code 0 | M5 / Test Track | ORIGINAL_REQUEST §Verification |
| F19 | Monorepo compliance verification | Zero unauthorized brand occurrences (`npm run check:brand`), clean typecheck across all 22 packages (`npm run typecheck`), full build (`npm run build:all`) | M5 / Test Track | ORIGINAL_REQUEST §Verification |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Resilient Data Sync Architecture | Schema versioning, validation, safe migration, atomic writes, and safe external sync merge across `deals.json`, `tenders-data.json`, and `books-data.json` (F1, F2, F3, F4) | none | DONE |
| M2 | CRM to Books Invoicing Automation | CRM won opportunity detection, IPC invoice creation in Books, deal back-reference, Deals table & modal UI buttons, Books tab activation (F5, F6, F7, F8) | M1 | DONE |
| M3 | Tenders Contract Milestone Billing | Tenders `ContractMilestone` model, RFP-WTR-2026-04 seed, IPC milestone billing in Books, milestone status update, Workspace UI actions, Books tab activation (F9, F10, F11, F12) | M1 | DONE |
| M4 | Bank Statement Import & Reconciliation | Books `'banking'` tab & `BankingView.tsx`, CSV statement parser, `acc-bank` balance adjustment, settlement suggestion matching, 1-click reconciliation (F13, F14, F15, F16, F17) | M1 | DONE |
| M5 | Final Milestone: Acceptance & Adversarial Hardening | Phase 1: 100% pass of `tools/verify-suite-workflows.mjs` (Tiers 1-4). Phase 2: Adversarial coverage hardening (Tier 5). Full checks: brand check, typecheck (22 packages), build:all (F18, F19) | M1, M2, M3, M4 | IN_PROGRESS |

*Parallel Track*:
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E2E | E2E Testing Track | Test infra design, test case creation (Tiers 1-4) in `tools/verify-suite-workflows.mjs`, publish `TEST_READY.md` | none (survey complete) | DONE |

---

## Interface Contracts

### Shared Data Store Schema Version Envelope
```typescript
export interface DataEnvelope<T> {
  version: number
  updatedAt: string
  data: T // or specific payload properties: deals, workspaces, accounts/invoices
}
```

### CRM ↔ Books Invoicing Contract
```typescript
// IPC Channel: 'crm:create-invoice-in-books'
export interface CreateInvoiceFromDealRequest {
  dealId: string
}
export interface CreateInvoiceFromDealResponse {
  ok: boolean
  invoiceId?: string
  invoiceNumber?: string
  error?: string
}

// Generated Invoice in Books:
// - type: 'Sales'
// - partyName: deal.companyName || deal.name
// - grandTotal: deal.amount
// - subtotal: Math.round((deal.amount / 1.15) * 100) / 100
// - taxTotal: Math.round((deal.amount - subtotal) * 100) / 100
// - items: [{ description: `${deal.name} - Commercial Implementation & Services`, qty: 1, rate: subtotal, amount: subtotal, taxRate: 15 }]
// - crmDealId: deal.id
// - status: 'Unpaid'
// - notes: 'Payment terms: Net 30 days upon invoice receipt.'
```

### Tenders ↔ Books Milestone Billing Contract
```typescript
// IPC Channel: 'tenders:bill-milestone-in-books'
export interface BillMilestoneRequest {
  tenderId: string
  milestoneId: string
  tenderReference: string // e.g. 'RFP-WTR-2026-04'
  issuingAuthority: string // e.g. 'City of Ekurhuleni Water Dept'
  milestoneTitle: string // e.g. 'Phase 1 Reservoir Valve Refurbishment'
  amount: number // e.g. 145000
  notes?: string
}
export interface BillMilestoneResponse {
  ok: boolean
  invoiceId?: string
  invoiceNumber?: string
  error?: string
}

// Generated Tax Invoice in Books:
// - type: 'Sales'
// - partyName: issuingAuthority
// - tenderReference: tenderReference
// - grandTotal: amount
// - subtotal: Math.round((amount / 1.15) * 100) / 100
// - taxTotal: Math.round((amount - subtotal) * 100) / 100
// - items: [{ description: `${milestoneTitle} per ${tenderReference}`, qty: 1, rate: subtotal, amount: subtotal, taxRate: 15 }]
// - status: 'Unpaid'
```

### Books Banking CSV Import & Reconciliation Contract
```typescript
export interface BankTransaction {
  id: string
  accountId: string // 'acc-bank'
  date: string // YYYY-MM-DD
  description: string
  reference?: string
  amount: number // positive = deposit, negative = withdrawal
  reconciled: boolean
  matchedInvoiceId?: string
  reconciledAt?: string
}

export interface SettlementSuggestion {
  transactionId: string
  invoiceId: string
  invoiceNumber: string
  partyName: string
  invoiceType: 'Sales' | 'Purchase'
  amount: number
  confidence: 'HIGH' | 'MEDIUM'
  reason: string
}
```

---

## Code Layout
- `packages/project-store/` or shared schema modules: Resilient data schema migration and storage helpers.
- `apps/crm/src/`:
  - `shared/types.ts`: `Deal` interface with invoice fields, `DealsStoreEnvelope`.
  - `main/crm-store.ts`: Schema migration, validation, atomic writing.
  - `main/crm-main.ts`: IPC handlers for Books invoice creation and opening Books tab.
  - `renderer/src/components/DealsTableView.tsx`, `DealModal.tsx`: Invoicing UI affordances.
- `apps/tenders/src/`:
  - `shared/types.ts`: `ContractMilestone`, `TendersData` envelope.
  - `main/tenders-main.ts`: Milestone billing IPC handler, safe external sync with CRM deals.
  - `renderer/src/components/Workspace.tsx`: Milestones drawer and "Bill Milestone in Zano Books" action.
  - `renderer/src/store.ts`: Seed tender `RFP-WTR-2026-04` with reached milestone, IPC sync.
- `apps/books/src/`:
  - `shared/types.ts`: `BankTransaction`, `BooksData` versioned envelope.
  - `main/books-main.ts`: Schema versioning, atomic writing, data loading/saving.
  - `renderer/src/components/Desk.tsx`: `'banking'` tab navigation.
  - `renderer/src/components/BankingView.tsx`: Bank statement CSV import and 1-click reconciliation UI.
  - `renderer/src/store.ts`: Bank transaction state, CSV import action, suggestion matching, reconcile action.
- `apps/shell/src/main/`:
  - `index.ts`: Wire `onOpenBooks` into `configureCrmRuntime` and `configureTendersRuntime`.
- `tools/`:
  - `verify-suite-workflows.mjs`: Automated end-to-end integration test runner.

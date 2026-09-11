# Handoff Report: Zano Books Bank Reconciliation Engine (R3) & Automated Test Suite (R5)

**Agent**: `explorer_books_reconciliation`  
**Working Directory**: `.agents/explorer_books_reconciliation`  
**Target Package**: `apps/books` (`@genoffice/books`)  
**Date**: 2026-09-05  

---

## 1. Observation

### 1.1 Bank Statement CSV Import Logic
Direct observations across `apps/books/src/main/books-main.ts` and `apps/books/src/renderer/src/store.ts`:

1. **Parser Implementation Locations**:
   - `apps/books/src/main/books-main.ts` (lines 371–443): `parseBankStatementCsv(csvText: string): BankTransaction[]`
   - `apps/books/src/main/books-main.ts` (lines 445–502): `importBankStatement({ booksDataPath, csvContent })`
   - `apps/books/src/renderer/src/store.ts` (lines 358–454): Fallback duplicate implementation of CSV parsing and ingestion
   - `apps/books/src/renderer/src/components/BankingView.tsx` (lines 131–187): File upload reader (`handleFileUpload`) and demo generator (`handleLoadSampleStatement`)

2. **Rigid Header Matching in `books-main.ts` (lines 375–384)**:
   ```ts
   const headerLine = lines[0]
   const headers = headerLine.split(',').map((h) => h.trim().toLowerCase().replace(/['"]/g, ''))

   const dateIdx = headers.findIndex((h) => h.includes('date'))
   const descIdx = headers.findIndex((h) => h.includes('desc') || h.includes('details') || h.includes('narrative'))
   const refIdx = headers.findIndex((h) => h.includes('ref'))
   const amountIdx = headers.findIndex((h) => h === 'amount' || h === 'value')
   const debitIdx = headers.findIndex((h) => h.includes('debit'))
   const creditIdx = headers.findIndex((h) => h.includes('credit'))
   ```
   - **Row 0 assumption**: `lines[0]` is unconditionally assumed to be the header row. In Nedbank and Absa exports, lines 1–3 typically contain account metadata (e.g. `"Account Number:","1234567890"`). If metadata exists, all header indices evaluate to `-1`, resulting in 0 parsed transactions.
   - **Amount column check**: Strict equality `h === 'amount' || h === 'value'` fails on standard bank headers: `"Transaction Amount"`, `"Amount (ZAR)"`, `"Amount (R)"`, `"Net Amount"`.
   - **Debit/Credit synonyms**: Ignores common UK/South African statement headers such as `"Paid Out"`, `"Paid In"`, `"Money Out"`, `"Money In"`, `"Withdrawal"`, `"Deposit"`.
   - **Description synonyms**: Misses `"Particulars"`, `"Remarks"`, `"Statement Description"`, `"Payee"`.
   - **UTF-8 BOM**: Does not strip leading `\uFEFF`, corrupting the first column header if exported with UTF-8 BOM.

3. **Numeric Format & Debit/Credit Column Handling (`books-main.ts` lines 413–430)**:
   ```ts
   let amount = 0
   if (amountIdx >= 0 && cols[amountIdx]) {
     let clean = cols[amountIdx].replace(/[R$\s]/g, '').replace(/,/g, '')
     if (clean.startsWith('(') && clean.endsWith(')')) {
       clean = '-' + clean.slice(1, -1)
     }
     amount = parseFloat(clean) || 0
   } else if (debitIdx >= 0 || creditIdx >= 0) {
     const debRaw = debitIdx >= 0 && cols[debitIdx] ? cols[debitIdx].replace(/[R$\s]/g, '').replace(/,/g, '') : '0'
     const credRaw = creditIdx >= 0 && cols[creditIdx] ? cols[creditIdx].replace(/[R$\s]/g, '').replace(/,/g, '') : '0'
     const deb = parseFloat(debRaw) || 0
     const cred = parseFloat(credRaw) || 0
     amount = cred > 0 ? cred : -deb
   }
   ```
   - **Debit Column Sign Inversion Bug**: If a statement provides a debit column with signed negatives (e.g. `-1250.00`), `amount = cred > 0 ? cred : -deb` computes `-(-1250.00) = +1250.00`, inverting an outgoing expense into an incoming deposit.
   - **Parenthetical Negative in Debit Column**: The check `clean.startsWith('(') && clean.endsWith(')')` is only executed in the single `amountIdx` branch. If a debit column has `(1,250.00)`, `parseFloat` returns `NaN`, evaluating to `0`.
   - **Currency Symbols**: Strips only `R` and `$`. Fails on `ZAR 1,250.00`.
   - **Decimal Comma Formats**: Stripping all commas via `.replace(/,/g, '')` turns standard SABS decimal comma values (e.g. `1250,50`) into `125050` (a 100x magnification error).

4. **Transaction Deduplication Defect (`books-main.ts` lines 468–481)**:
   ```ts
   const existing = booksData.bankTransactions || []
   const existingFingerprints = new Set(existing.map((t) => `${t.date}|${t.description}|${t.amount}`))

   const toAdd: BankTransaction[] = []
   let netAdjustment = 0

   for (const tx of parsed) {
     const fp = `${tx.date}|${tx.description}|${tx.amount}`
     if (!existingFingerprints.has(fp)) {
       toAdd.push(tx)
       netAdjustment += tx.amount
       existingFingerprints.add(fp)
     }
   }
   ```
   - **Collisions on legitimate identical charges**: If a company incurs two identical transactions on the same day (e.g., two R45 bank service fees, two R150 Uber charges, or two payments to the same contractor), `existingFingerprints.add(fp)` drops the 2nd transaction within the *same file on first import*.
   - **Reference field ignored**: Omits `reference` from the fingerprint. Two distinct payments on the same date with different references (e.g., `INV-101` vs `INV-102`) collide if amounts are equal.

---

### 1.2 Reconciliation Execution & Settlement Math Flaw
Direct observation of `executeReconciliation` in `books-main.ts` (lines 600–653):

```ts
  // 1. Mark transaction reconciled
  tx.reconciled = true
  tx.matchedInvoiceId = inv.id
  tx.reconciledAt = new Date().toISOString()

  // 2. Mark invoice Paid and clear outstanding
  const settledAmount = inv.outstandingAmount
  inv.status = 'Paid'
  inv.outstandingAmount = 0
  inv.updatedAt = new Date().toISOString()

  // 3. Update party balance
  const party = booksData.parties.find((p) => p.id === inv.partyId || p.name === inv.partyName)
  if (party) {
    party.outstandingBalance = Math.max(0, Math.round((party.outstandingBalance - settledAmount) * 100) / 100)
  }

  // 4. Update ledger accounts (offset Receivable or Payable against Bank settlement)
  for (const acc of booksData.accounts) {
    if (inv.type === 'Sales' && acc.id === 'acc-ar') {
      acc.balance = Math.max(0, Math.round((acc.balance - settledAmount) * 100) / 100)
    }
    if (inv.type === 'Purchase' && acc.id === 'acc-ap') {
      acc.balance = Math.max(0, Math.round((acc.balance - settledAmount) * 100) / 100)
    }
  }

  // 5. Post settlement journal entry
  const year = new Date().getFullYear()
  const jeNumber = `JE-${year}-${booksData.journalEntries.length + 1}`
  const today = new Date().toISOString().split('T')[0]

  const journalItems =
    inv.type === 'Sales'
      ? [
          { id: 'jei-rec-1', accountId: 'acc-bank', accountName: 'FNB Business Cheque Account', debit: settledAmount, credit: 0 },
          { id: 'jei-rec-2', accountId: 'acc-ar', accountName: 'Accounts Receivable (Debtors)', debit: 0, credit: settledAmount, partyId: party?.id, partyName: party?.name },
        ]
      : [
          { id: 'jei-rec-1', accountId: 'acc-ap', accountName: 'Accounts Payable (Creditors)', debit: settledAmount, credit: 0, partyId: party?.id, partyName: party?.name },
          { id: 'jei-rec-2', accountId: 'acc-bank', accountName: 'FNB Business Cheque Account', debit: 0, credit: settledAmount },
        ]
```

- **Critical Bug**: `const settledAmount = inv.outstandingAmount`. The code *completely ignores* `tx.amount`.
- **Consequences**:
  1. If an invoice has `outstandingAmount = 100000` and the customer pays a deposit of `tx.amount = 40000`:
     - `settledAmount` is set to `100000`.
     - The invoice is marked `Paid`, with `outstandingAmount = 0`.
     - The remaining R60,000 receivable balance is wiped out from `acc-ar` and `party.outstandingBalance`.
     - A settlement Journal Entry of `R 100,000.00` is posted into the ledger, corrupting trial balances.
  2. If an invoice has `outstandingAmount = 10000` and the bank transaction is `15000`:
     - It only settles `10000`, disconnecting the remaining transaction amount.
  3. No validation of transaction direction: A withdrawal/debit transaction can be reconciled against a Sales invoice, or a deposit against a Purchase bill.
  4. Identical flaw exists in `apps/books/src/renderer/src/store.ts` (lines 475–543).

---

### 1.3 Cross-App Tender Milestone Payment Back-Propagation
Direct observation of `books-main.ts` (lines 662–735) and `apps/tenders/src/main/tenders-main.ts` (lines 204–287):

1. **Milestone Matching & Update**:
   - `executeReconciliation` searches `tenders-data.json` for a matching milestone using:
     - `m.billedInvoiceId === inv.id`
     - `m.billedInvoiceNumber === inv.invoiceNumber`
     - Tender reference (`t.referenceNumber === inv.tenderReference`) + milestone amount matching `settledAmount`.
   - On match, sets `m.status = 'PAID'`, `m.paidAt = nowIso`, `m.paidDate = nowIso`.
   - Calls `writeTendersStore(candidatePath, tendersData)`.
   - `writeTendersStore` writes the file atomically and invokes `broadcastTendersData(validated)`, broadcasting `tenders:data-changed` to active Tenders WebContents.
2. **Defects Observed**:
   - **Premature PAID state on partial payment**: If an invoice is only partially settled, `m.status` is still changed to `'PAID'` because `executeReconciliation` previously assumed 100% settlement.
   - **Dynamic `require` vulnerability**: Line 686 does `require('../../../tenders/src/main/tenders-main')`. If compiled into bundled Electron without source or run in a pure Node context, this require fails. The error is caught by `console.warn`, leaving `tenderMilestonePaid = false` without fallback JSON persistence.

---

### 1.4 Vitest Test Infrastructure Status (R5)
Direct observations:

1. **`apps/books/package.json`**:
   - Line 9–14:
     ```json
     "scripts": {
       "dev": "electron-vite dev",
       "dev:renderer": "vite --config vite.renderer.config.ts",
       "build": "electron-vite build",
       "typecheck": "tsc --noEmit"
     }
     ```
   - **No test script exists** in `apps/books/package.json`.
2. **`apps/books/vitest.config.ts`**: **Does not exist**.
3. **`apps/books/tests/` directory**: **Does not exist**.
4. **Root `package.json` line 29**:
   ```json
   "test": "npm run test -w @genoffice/i18n && npm run test -w @genoffice/electron-utils && npm run test -w @genoffice/font-metrics && npm run test -w @genoffice/docx-engine && npm run test -w @genoffice/pdf2docx && npm run test -w @genoffice/file-parse && npm run test -w @genoffice/pptx-engine && npm run test -w @genoffice/pptx-render && npm run test -w @genoffice/ai-search && npm run test -w @genoffice/agent-core && npm run test -w @genoffice/ai-provider && npm run test -w @genoffice/project-store && npm run test -w @genoffice/docs && npm run test -w @genoffice/sheets && npm run test -w @genoffice/shell && npm run test -w @genoffice/slides && npm run test -w @genoffice/pdf && npm run test -w @genoffice/markdown"
   ```
   - Does not include `@genoffice/books`.
5. **Tool verification (`tools/verify-suite-workflows.mjs`)**:
   - Runs and passes 56/56 mock tests, but *does not test `apps/books` source files*. It contains internal duplicate mock functions.

---

## 2. Logic Chain

1. **From Observation 1.1 (Bank Statement Import)**:
   - Because South African banks (FNB, Standard Bank, Nedbank, Absa) use differing export formats (some signed, some separate debit/credit, some with metadata headers, some using space or comma number separators), the current parser fails when presented with real-world statements.
   - Specifically, if a bank provides separate debit/credit columns where debits are listed with negative signs or parentheses, the current logic either inverts the sign or returns zero.
   - Because deduplication currently uses a simple `Set` of `${date}|${description}|${amount}`, legitimate repeated transactions in a single day are discarded.
   - **Inference**: A resilient parser must locate the header row dynamically, normalize headers to canonical columns, clean numbers considering both decimal commas and parenthetical negatives, and use frequency-based deduplication with reference support.

2. **From Observation 1.2 (Settlement Math)**:
   - In `executeReconciliation`, `settledAmount` is unconditionally initialized to `inv.outstandingAmount`.
   - `tx.amount` represents the true cash movement. When `tx.amount < inv.outstandingAmount`, the customer has only paid a partial amount.
   - Clearing `inv.outstandingAmount` to 0 and reducing Accounts Receivable by `inv.outstandingAmount` creates an immediate unrecorded credit and ledger imbalance.
   - **Inference**: The settlement math must bind strictly to the actual transaction cash value:
     $$\text{availablePayment} = |\text{tx.amount}|$$
     $$\text{settledAmount} = \min(\text{availablePayment}, \text{inv.outstandingAmount})$$
     $$\text{remainingBalance} = \text{inv.outstandingAmount} - \text{settledAmount}$$
   - When $\text{remainingBalance} > 0$, the invoice must remain `status: 'Unpaid'` with updated `outstandingAmount = remainingBalance`. AR, AP, and Party balances must decrement by $\text{settledAmount}$, and the Journal Entry must post exactly $\text{settledAmount}$.

3. **From Observation 1.3 (Milestone Back-Propagation)**:
   - Tender milestones should represent true contract completion and financial settlement.
   - If an invoice is only partially settled, marking `m.status = 'PAID'` prematurely flags the milestone as completed in Tenders.
   - **Inference**: `executeReconciliation` must only update the tender milestone to `'PAID'` when $\text{remainingBalance} == 0$ or when the settled amount meets or exceeds the milestone amount.

4. **From Observation 1.4 (Testing Infrastructure R5)**:
   - `apps/books` currently has zero unit/integration tests and no `vitest.config.ts`.
   - Without automated Vitest coverage, regressions in double-entry invariants, ledger balances, and CSV parsing cannot be prevented or verified programmatically.
   - **Inference**: We must establish `apps/books/vitest.config.ts`, add `"test": "vitest run"` in `apps/books/package.json`, and write 6 dedicated test files covering all requirements.

---

## 3. Caveats

1. **Multi-Currency Reconciliation**: Currently, all bank transactions and invoices in Zano Books are denominated in South African Rand (ZAR). Foreign currency conversions are out of scope for R3.
2. **Bank Statement CSV Encodings**: While UTF-8 and standard ASCII with/without BOM are covered, obscure legacy character encodings (e.g. ISO-8859-1 with non-standard diacritics) rely on standard Node.js/browser UTF-8 string decoding.
3. **Split Reconciliation Across Multiple Invoices**: 1-click reconciliation maps one bank transaction to one invoice. Splitting a single large deposit across multiple small invoices in a single click is a future UI enhancement; exact matching and partial settlement of a single invoice are the core requirements.

---

## 4. Conclusion & Concrete Fix Plan

### 4.1 Concrete Code Fix Plan for `apps/books`

#### Phase 1: Robust Bank Statement CSV Parser (`apps/books/src/main/books-main.ts` & `store.ts`)
- **File**: `apps/books/src/main/books-main.ts` (replace lines 371–502)
- **Changes**:
  1. Strip leading UTF-8 BOM: `csvText.replace(/^\uFEFF/, '')`.
  2. Scan the first 10 rows to detect the actual header row by matching at least two banking terms (`date`, `desc|details|narrative|particulars|remarks`, `amount|value|debit|credit|balance|paid in|paid out`).
  3. Expand column matching regular expressions:
     - `date`: `/date/i`
     - `desc`: `/desc|detail|narrative|particular|remark|memo|payee/i`
     - `ref`: `/ref/i`
     - `amount`: `/^(amount|value|net amount|total amount)$/i` or `/(?=.*amount)(?!.*balance)(?!.*debit)(?!.*credit)/i`
     - `debit`: `/debit|paid\s*out|money\s*out|withdrawal|payments/i`
     - `credit`: `/credit|paid\s*in|money\s*in|deposit|receipts/i`
     - `balance`: `/balance/i`
  4. Robust number parser:
     - Clean currency tokens: `replace(/[R$\s\u00A0ZAR]/gi, '').trim()`
     - Parenthetical negative: `if (s.startsWith('(') && s.endsWith(')')) s = '-' + s.slice(1, -1)`
     - Decimal comma conversion: `if (/^[+-]?\d+,\d{2}$/.test(s)) s = s.replace(',', '.') else s = s.replace(/,/g, '')`
  5. Compute debit/credit magnitudes cleanly:
     - If debit/credit columns exist: `deb = Math.abs(parseNumber(cols[debIdx]))`, `cred = Math.abs(parseNumber(cols[credIdx]))`. `amount = cred > 0 ? cred : -deb`.
  6. Normalize dates to ISO `YYYY-MM-DD` across `YYYY-MM-DD`, `YYYY/MM/DD`, `DD/MM/YYYY`, `DD-MM-YYYY`.
  7. Frequency-based deduplication in `importBankStatement`:
     - Count existing occurrences of `${tx.date}|${tx.description}|${tx.amount}|${tx.reference || ''}` in a `Map<string, number>`.
     - When importing, skip the first $N$ occurrences that already exist in the database, allowing legitimate repeated items in the incoming file to be ingested without duplication collisions.
  8. Mirror these improvements in `apps/books/src/renderer/src/store.ts` (lines 358–454).

#### Phase 2: Reconciliation Execution & Settlement Math
- **File**: `apps/books/src/main/books-main.ts` (replace lines 568–748) and `store.ts` (lines 456–544)
- **Changes**:
  1. Add direction validation:
     - If `inv.type === 'Sales' && tx.amount <= 0`, return `{ ok: false, error: 'Cannot reconcile a withdrawal/debit transaction against a Sales invoice' }`.
     - If `inv.type === 'Purchase' && tx.amount >= 0`, return `{ ok: false, error: 'Cannot reconcile a deposit/credit transaction against a Purchase bill' }`.
  2. Bind settlement to transaction amount:
     ```ts
     const availablePayment = Math.round(Math.abs(tx.amount) * 100) / 100
     const settledAmount = Math.min(availablePayment, inv.outstandingAmount)
     const remainingBalance = Math.max(0, Math.round((inv.outstandingAmount - settledAmount) * 100) / 100)
     ```
  3. Update invoice:
     - `inv.outstandingAmount = remainingBalance`
     - `inv.status = remainingBalance === 0 ? 'Paid' : 'Unpaid'`
  4. Update party balance and ledger accounts:
     - Reduce `party.outstandingBalance` by `settledAmount` (not full invoice total).
     - Reduce `acc-ar` (for Sales) or `acc-ap` (for Purchase) by `settledAmount`.
  5. Post strictly balanced Journal Entry:
     - `totalDebit = settledAmount`, `totalCredit = settledAmount`.
     - Line items: Sales receipt (Debit `acc-bank` settledAmount, Credit `acc-ar` settledAmount); Bill payment (Debit `acc-ap` settledAmount, Credit `acc-bank` settledAmount).
  6. Propagate Tender milestone only when fully settled:
     - `if (remainingBalance === 0 || Math.round(m.amount * 100) <= Math.round(settledAmount * 100))` -> `m.status = 'PAID'`.
     - Include direct JSON fallback read/write if `require('../../../tenders/src/main/tenders-main')` fails.
  7. Enhance `computeSettlementSuggestions`:
     - Suggest exact amount matches with HIGH (text matched) or MEDIUM (amount only) confidence.
     - Also suggest partial matches when `tx.description` or `tx.reference` contains `inv.invoiceNumber` or `inv.tenderReference` with MEDIUM confidence (`Partial payment matching invoice ${inv.invoiceNumber}`).

#### Phase 3: Real-Time IPC Synchronization (`books:data-changed` R4)
- **File**: `apps/books/src/main/books-main.ts`, `apps/books/src/shared/ipc.ts`, `apps/books/src/preload/index.ts`, `apps/books/src/renderer/src/store.ts`
- **Changes**:
  1. In `shared/ipc.ts`: Add `BOOKS_CHANNELS.dataChanged = 'books:data-changed'` and `onDataChanged` in `BooksApi`.
  2. In `preload/index.ts`: Expose `onDataChanged: (callback) => ipcRenderer.on(BOOKS_CHANNELS.dataChanged, ...)`
  3. In `books-main.ts`:
     - Track `activeBooksWebContents = new Set<WebContents>()`.
     - Add `broadcastBooksData(data: BooksData)` with `lastBroadcastJson` loop-suppression guard.
     - Add `startBooksStoreWatcher()` and `stopBooksStoreWatcher()` on `books-data.json`.
     - In `writeBooksStore()`, invoke `broadcastBooksData()`.
  4. In `store.ts` & `Desk.tsx`:
     - Subscribe to `window.booksApi?.onDataChanged((data) => set({ data }))`.

#### Phase 4: Vitest Test Infrastructure (R5)
- **File**: `apps/books/package.json`
  - Add `"test": "vitest run"` under `"scripts"`.
- **File**: `apps/books/vitest.config.ts`
  - Create configuration with path aliases to `@genoffice/` packages, test timeout 20000ms.
- **Directory**: `apps/books/tests/`
  - Create the following 6 test suites:
    1. `tests/double-entry-invariants.test.ts`
       - Verifies `totalDebit === totalCredit` across Sales invoices, Purchase bills, and reconciliation settlements.
       - Tests 2-decimal-place rounding and floating-point precision guards.
    2. `tests/invoice-posting-ledger.test.ts`
       - Verifies account balance updates (`acc-ar`, `acc-sales`, `acc-vat`, `acc-ap`, `acc-bank`).
       - Verifies party balance updates for customers and suppliers.
    3. `tests/bank-statement-parser.test.ts`
       - Verifies FNB, Standard Bank, Nedbank, and Absa CSV parsing.
       - Tests parenthetical negatives, debit/credit columns, currency prefixes, comma decimals, and metadata headers.
    4. `tests/reconciliation-settlement.test.ts`
       - Verifies exact settlement, partial settlement, remaining balance calculation, and duplicate handling.
       - Verifies rejection of wrong-direction transactions and re-reconciled transactions.
    5. `tests/store-persistence-migrations.test.ts`
       - Verifies safe schema initialization, atomic writes, `.corrupted.bak` creation on invalid JSON, and full Chart of Accounts preservation.
    6. `tests/ipc-sync-tenders-interop.test.ts`
       - Verifies tender milestone back-propagation to `PAID`, `tenders:data-changed` emission, and `books:data-changed` broadcast.

---

## 5. Verification Method

To independently verify the implementation once executed:

1. **Run Vitest Test Suite**:
   ```powershell
   npm test -w @genoffice/books
   ```
   - Must pass 100% of tests across all test files in `apps/books/tests/`.

2. **Verify Typecheck Cleanliness**:
   ```powershell
   npm run typecheck -w @genoffice/books
   npm run typecheck
   ```
   - Must pass with 0 errors across `apps/books` and all 22 monorepo workspaces.

3. **Verify Upstream Brand Guard**:
   ```powershell
   npm run check:brand
   ```
   - Must output: `Brand check passed: Zero unauthorized upstream brand occurrences found.`

4. **Verify Workflow Verification Runner**:
   ```powershell
   node tools/verify-suite-workflows.mjs
   ```
   - Must pass all 56 tests with exit code 0.

5. **Files to Inspect for Integrity**:
   - `apps/books/src/main/books-main.ts`: Verify `executeReconciliation` computes `settledAmount = Math.min(Math.abs(tx.amount), inv.outstandingAmount)`.
   - `apps/books/src/renderer/src/store.ts`: Verify store reconciliation fallback matches main process logic.
   - `apps/books/package.json`: Verify `"test": "vitest run"`.
   - `apps/books/vitest.config.ts`: Verify configuration exists and resolves workspace aliases.

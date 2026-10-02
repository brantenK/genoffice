# Zano Books — Known Gaps & Safe-Use Guide (pre-release)

Date: 2026-09-28 · Branch `product` @ `29ec88c` · **Updated 2026-10-02 @ `c0bf8a63`**
(quotation printing, letterhead logo/registration and buyer-identity printing landed in
the 0.12.0 print batch — the affected entries below carry dated notes; line numbers
re-checked against the current tree where flagged).
Audience: anyone evaluating or trialing the module before it is sent to outside users.
Companion to `.agents/books_production_signoff.md`, which proves what IS solid (money core,
data durability, journeys, packaging). This document records where the app LACKS for real
users, from a six-perspective independent review (daily workflow completeness, SARS
compliance, data safety, security & privacy, usability & accessibility, operations &
lifecycle), plus one additional verified defect found during that review.

## Verified solid (no need to re-test)

- Double-entry engine: 35,000-case fuzz across invoices/bills/credit notes with balanced
  journals, AR/AP === grandTotal × rate, VAT leg === posted tax, invoice + full credit note
  nets every account to zero; 2,500 settlement scenarios; 10,000-operation soak with the
  full invariant set checked every 500 ops.
- Persistence under hostile conditions: disk-full refusal (byte-identical file), mid-write
  kill recovers the last good ledger, concurrent-writer conflict + rollback, byte-identical
  JSON round-trips, backup preservation.
- Real-UI: 13/13 journeys through the actual shell (invoicing, reconciliation, splits,
  over-payments, restart persistence, corrupt-store guard, EUR multi-currency, print/PDF).
- 5,000-invoice ledger: load 130ms, save 256ms, PDF 41ms, aging 250ms, RSS ≤ 331MB.
- Packaging: `dist:win` exit 0; a live books journey was driven on the packaged binary.

Full details and every fix commit: see the sign-off.

## Blocking gaps — fix before relying on the app for statutory or shared use

| # | Gap | Evidence | What a user experiences | Workaround today |
|---|-----|----------|--------------------------|------------------|
| 1 | **Year-2+ period closes are refused (verified bug)** | `shared/closing.ts:44-52` + `books-main.ts:441` refuse ANY change to `closedThrough` once one exists; the pure engine supports sequential closes (`closing.test.ts:275-279`) but the main-process save guard blocks them, and no test through that guard and no real-UI journey ever exercises a second close | First Close Period works; every later close fails with "cannot be changed through a raw save" — no in-app way forward | Close at most once; undo via backup restore |
| 2 | **No VAT201-style period reporting** | `reports.ts:143` — the tax register is whole-ledger only; `ReportsView.tsx:43,594-646` has no period picker; register CSV has no dates | When the bi-monthly VAT201 is due, the user must hand-pivot output/input VAT from the general-ledger CSV — transcription risk on a statutory return | Export CSVs and pivot manually per period |
| 3 | **Tax-invoice identity printing: mostly landed, residue remains** (updated 2026-10-02) | The Billed-To block now draws party name + stamped address + `VAT / Tax ID` (`invoice-pdf.ts:247-277`), and the seller letterhead carries the `Reg:` line (`invoice-pdf.ts:231-243`) and an embedded logo (`invoice-pdf.ts:199-228`, drawn at 456-512); stamped at save time (`store.ts:660-661`). Residue: an unset seller VAT number prints `VAT Reg: -` (`invoice-pdf.ts:519,854`); rows saved before 2026-10-01 have no stamp (no backfill migration); structured banking-details fields are still free text; no zero-rated/exempt distinction | Newly saved invoices and quotes carry full buyer/seller identity; legacy rows print name-only and a missing VAT number shows a dash | Re-save old invoices to stamp them; fill the Tax/VAT number in Settings and on the party |
| 4 | **No automatic or off-machine backups** | Backup is a manual button only (`books-main.ts:617+`), 10 kept (`books-main.ts:627`) + single-generation `.bak` (`books-core.ts:931-937`); restore accepts only files already inside the module's backups dir (`books-main.ts:641-654`); no file dialog exists in the module | Machine loss or ransomware = books loss; backups on a USB stick or from support cannot be restored through the UI | Click "Backup now" weekly; copy the backups folder to OneDrive/USB manually |
| 5 | **Restore unreachable when the store is broken** | The read-error screen offers only "Try again" (`Desk.tsx:112`); the desk (and Settings, where restore lives) never renders; no restore path accepts an external file | A corrupt store leaves a non-technical user stuck until support walks them through Explorer surgery in `%APPDATA%\Zanostack\books` | Manual rename of `books-data.json.bak` / forensic copies |
| 6 | **One-click delete without confirmation** | `InvoiceList.tsx:285-292` (invoices) and `QuotesView.tsx:280-288` (quotes) call delete directly; payments and restores DO confirm | One stray click on a busy list deletes a posted invoice AND its settlement journals; only the audit log remains | Careful clicking; recover via backup restore |
| 7 | **Fixed, trade-tuned chart of accounts and a single hard-branded bank account** | `chart.ts` pins 31 accounts (23 leaf posting accounts under 8 groups) named for the trade; `BankingView.tsx:229` hard-brands "FNB Business Cheque Account"; new invoices default to engineering descriptions at R50,000 (`InvoiceForm.tsx:95-105`) | Correct for Branten Solutions' trade; any other business must post through misnamed accounts; a second bank account cannot exist | None |

## High-value gaps for real users (not statutory-blocking)

- **Expense coding of statement lines is missing** — bank lines that are not invoice
  settlements (fees, rent, salaries, fuel) sit "Unmatched" in Suspense forever
  (`BankingView.tsx:611`); the only recourse is a hand-built journal. A real statement is
  mostly such lines, so month-end Bank-vs-Suspense clearing is manual.
- **Audit trail is shallow**: silently capped at 500 entries (`audit.ts:13,36`), and editing
  a posted invoice REPLACES its original journals instead of reversing, so no before-image
  survives (`store.ts:711-721`). The Audit Log's "Immutable trail" wording
  (`AuditLogView.tsx:37`) is not backed by the file format.
- **No app lock or encryption at rest (POPIA)** — books and backups are cleartext JSON; any
  person at the machine sees client names and full financials; the ledger can be edited
  outside the app and loads as gospel.
- **Edit refusals on settled invoices** (by design — every posted edit re-posts the settled
  cash): suspense-settled invoices refuse every edit including notes-only (`store.ts:712-719`);
  invoices paid by multi-invoice payments refuse edits entirely (`store.ts:490-502`). The
  remedy is delete-and-recreate.
- **Reports are fixed-scope**: P&L YTD only, balance sheet and aging as-of-today; no date
  ranges or comparatives (`ReportsView.tsx:30-31,339`). (Updated 2026-10-02: quotations now
  print to PDF via the row/form print buttons → `QuotationPrintModal` /
  `buildQuotationPdf`; the remaining quotation gap is the custom sections below.)
- **No structured banking-details fields** — payment instructions are a per-invoice
  free-text note ("Terms & Banking Details") printed under Notes & Payment Terms; there is
  no bank/holder/account-number/type/branch-code block the app fills for you.
- **No quotation custom sections** — the quotation PDF prints number, dates, items,
  discounts and totals, but the rich sections real quotations carry (payment options,
  care plans, warranty, acceptance/signature block) have no home yet.
- **Parties are add-only** — no edit or delete (`PartyList.tsx:33-50`); a typo'd contact is
  permanent. Single bank account; one ledger per OS user (no multi-company switcher).
- **Accessibility beyond the Axe gate**: the zero-critical scan covers only four list
  screens; form-heavy surfaces are never scanned; only 2 `htmlFor` exist module-wide
  (`SettingsView.tsx:469,594` — letterhead footer, close-through date); every other label
  is adjacency-only; modals lack `role="dialog"` and
  focus traps; the error banner is not `role="alert"` — screen-reader users are never
  announced refusals or errors.
- **VAT mechanics assume a vendor**: pre-set 15% default (`chart.ts:16`), no zero-rated vs
  exempt distinction on the invoice form, no non-vendor mode. (Fixed 2026-10-02: 0%/mixed
  invoices no longer mislabel the VAT row — `shared/print.ts` `vatTaxLabel`; drafts still
  print titled "TAX INVOICE" via `invoiceDocumentTitle`, `invoice-pdf.ts:454`.)
- **Restore bypasses the period lock** — `restoreBackup` has no
  `validateClosedPeriodMutation` check (`backup-restore.ts:238-355`); audited, but a restore
  can un-post a closed period.

## Minor / polish

- Invoice PDFs and report CSVs are written to `%TEMP%\zano-books-exports\<stamp>\` and never
  cleaned (`books-main.ts:352-373`).
- No diagnostics surface for support: main-process errors go to `console.error` only; the
  packaged app writes no log file.
- ~600MB installed footprint / ~148MB installer for the whole shell; no books-only option.
- No keyboard shortcuts; list rows are click-only; the dashboard margin arrow is statically
  green even at a loss (`Dashboard.tsx:142-145`); a deleted invoice's id is shown raw in
  banking match text (`BankingView.tsx:597`).
- "Rate (excl)" column header contradicts the default "Prices are VAT-inclusive" setting
  (`InvoiceForm.tsx:356`) — label-only, but VAT-misstatement prone.
- Integrity checking is JSON-parse only — bit rot that still parses loads silently.
- No fsync before rename — saves survive process kill and disk-full (verified), but a
  power-loss can lose the most recent save(s).
- Backups pruned beyond 10; `.bak` holds only the immediately-previous save.
- The books→tenders bridge writes the tenders store via a non-atomic `writeFileSync`
  fallback (`books-main.ts:823`).
- No CSP meta and no will-navigate lock anywhere in the books renderer.
- i18n pending locale data; en-ZA formatting is hardcoded.
- Posting with no party selected silently creates a party named "Customer"
  (`store.ts:639-651`); a draft dated before a close becomes permanently unpostable after
  the close (`closing.ts:129`).
- Base currency and financial-year start can be changed with posted data and no guard
  (`SettingsView.tsx:379-420`), silently re-reading every posted figure.

## Safe-use guide until the blockers close

1. Click "Backup now" weekly, and copy `…\Zanostack\books\backups` to OneDrive or a USB
   stick after any significant session.
2. Close a period at most once; don't close until you actually need the lock.
3. Don't edit invoices that are already paid or statement-settled — delete-and-recreate.
4. VAT labelling on documents is now honest (0%/mixed print a bare VAT row), but the app
   still has no zero-rated/exempt distinction and no VAT201 report — if VAT-registered,
   cross-check statutory invoices against the VAT201 pivot until gap 2 closes; if not
   VAT-registered, ignore the VAT fields (everything presets to 15% / VAT-inclusive).
5. Remember the audit log and "immutable" wording are history, not forensic evidence.

## Alternatives considered

Frappe Books (the reference open-source desktop accounting app) covers several generic gaps
(chart of accounts, ranged reports, editable parties, emailing, portable backup export,
custom print templates, multi-currency) but NOT the South African layer (VAT201, s16 tax
invoices) and not tamper-evidence, encryption, or automatic backups — and adopting it means
leaving the Zanostack suite and the verified core documented in the sign-off. The gaps above
are each a small, targeted build inside `apps/books`.

## Suggested fix order

1. Year-2+ close guard (verified bug — allow `closedThrough` to advance forward, refuse
   backward/clearing)
2. Delete confirmations for invoices and quotes
3. Automatic backups + export/import to a chosen folder (machine moves, off-machine copies)
4. Recovery actions on the read-error screen (restore + reveal data folder)
5. VAT period report (date-scoped register, VAT201-style layout)
6. VAT-vendor configuration: zero-rated/exempt distinction and clear handling of the
   `VAT Reg: -` fallback (buyer/seller identity printing landed 2026-10-01)
7. Structured banking-details fields + quotation custom sections (payment options,
   warranty, acceptance/signature)

(Blocker 7 — fixed chart + branded bank account — is deliberately not listed: it is a
product decision, not a build item.)

# Zano Books — Production Sign-off (2026-09-28)

Module: `apps/books` (@genoffice/books), Electron module hosted by apps/shell.
Gauntlet window: 2026-09-28, base commit `0bf4138` → head `190828e` (branch `product`).
All suites below ran on a fresh build (`npx electron-vite build` in apps/books, then
`npm run build -w @genoffice/shell`).

## What was tested

| Phase | Coverage | Result |
|---|---|---|
| 1 Baseline | Fresh-build reproduction of the full baseline | One red found (date-rotted journey assertion masking a wrong locator) — fixed |
| 2 Money-core fuzz | 25,000 sales invoices + 5,000 purchase bills + 5,000 credit-note pairs through `calculateInvoiceTotals` / `createSalesInvoiceJournal` / `createPurchaseBillJournal` / `createCreditNoteJournal` (seed `0xB00B5`, 6.7s). Invariants per case: balanced journals, AR/AP leg === grandTotal × rate, VAT leg === taxTotal × rate, single-sided control legs, invoice + full credit note nets every account to zero, tax register === posted VAT | Invariants found 5 real defects (F1–F5) — all fixed |
| 2 Settlement fuzz | 2,500 scenarios: exact / partial / over-amount / split `invoiceIds[]` / direction-mismatch / credit-carrying / re-import-after-partial (seed `0x5E771E`) | Controls tie; refusal semantics proven |
| 2 Soak | 10,000-op random walk (create/invoice/pay/credit/convert/import CSV/reconcile/delete/reopen) against one store, seed `0x50A04`; full invariant set after every 500 ops | Held at every checkpoint |
| 3 Hostile persistence | 13 scenarios over the REAL IPC handlers: disk-full (ENOSPC on tmp and rename), mid-write kill (stale `.tmp` shapes), two-module concurrent writers, byte-identical envelope round-trips, 1,000-op migration history, backup/restore safety | Zero defects — persistence held everywhere |
| 3 Perf | 5,000-invoice ledger (see numbers below) | Nothing timed out; memory sane |
| 3 CSV | 10,000-row hostile statement (duplicates, malformed, huge/negative, unicode) | Atomic, contract dedupe, 3,337ms, never crashed |
| 4 Real-UI journeys | 13 journeys through the REAL shell (8 baseline + 5 new: expired quotation + quotes-page axe, quote conversion vs closed period, restore raced against a save, both print templates on an EUR invoice, EUR invoice in aging/tax register/cash flow) | 13/13 pass; Axe: zero critical findings |
| 5 Packaging | `npm run dist:win` → exit 0 (NSIS + blockmap; signtool steps on exe, elevate.exe, uninstaller, installer); `resources/modules/books/{main,preload,renderer}` layout verified; packaged app launched from `apps/shell/release/win-unpacked`, consumed its automation launch record, answered `app.status` (0.10.0) over its own protocol; a full books journey (setup wizard → party → invoice → Submit & Post) was driven through the window's accessibility tree | Journey PASS; persisted ledger correct (INV-2026-001, AR 2500, balanced journals) |
| 6 Full re-run | tsc, full unit suite, all journeys, workflows, hygiene gates — on a fresh build | All green (numbers below) |

## Final gate results (fresh build, 2026-09-28)

- `npx tsc --noEmit` (apps/books): **0 errors**
- `npx vitest run` (apps/books): **47 files / 625 tests, all green** (baseline was 36 files / 555)
- `npx playwright test books-flows books-smoke`: **13/13 journeys**, Axe zero critical findings
- `npx tsx tools/verify-suite-workflows.mjs`: **56 / 56** (file unedited)
- Hygiene: `format:check`, `check:theme-colors`, `check:english-comments`, `check:brand` **PASS**;
  `npx eslint apps/books` **0 findings**

## Defects found and fixed (each with a teeth-proven regression test)

1. **F2 — editing an invoice below its settled portion** re-posted the full paid amount against
   the smaller total (outstanding clamped to 0, AR floating negative, unbilled cash into Bank).
   Fix: refusal before any reversal, error names invoice/amounts.
   `tests/edit-settlement-regressions.test.ts` (RED `AR control … expected -270 to be +0`).
2. **F4 — editing a reconciled invoice** re-posted the carried portion as a direct bank
   settlement (double-counted Bank, stranded the import's Suspense leg). Fix: suspense-funded
   portions refused; purely bank-funded carried re-posts stay allowed (two anti-over-refusal
   controls). Same file (RED `expected 2300 to be 1150`).
3. **F3 — remark-text journal matching**: deleting an invoice whose number appeared in a
   statement description deleted the bank import journal (real cash unpostable) and could
   remove other invoices' settlement reclasses. Fix: structural `JournalEntryItem.invoiceId`
   stamps; legacy fallback never crosses a cash-side leg. `tests/delete-edit-attribution.test.ts`.
4. **F6 — deleting a reconciled invoice** stranded Suspense at −X. Fix: coherent unwind
   (imports survive; statement lines re-allocatable; uncovered cash re-posted; over-payment
   ride removed with its settlement and re-forms on re-reconciliation). Same file.
5. **F1 — fallback legs posted to GROUP accounts** whose balances are overwritten by the child
   rollup, so legs vanished from the ledger; the credit-note mirror reversed onto a leaf,
   breaking the netting contract. Fix: leaf-only account resolution + CN split-mirror to the
   original homes; also fixed the purchase-bill discount clamp. Also fixed en route:
   `deletePayment` import-journal re-sizing with mixed funding, and structural import-journal
   detection in `recordPayment`/`applyReconciliation`. `tests/fallback-and-unapplied-regressions.test.ts`.
6. **F5 — unapplied-receipt legs were unattributable** (rode the last-funded invoice's
   journal while the credit rode the last target's outstanding; deleting either side stranded
   the other). Fix: cross-invoice rides post as their own balanced, structurally attributed
   entries. Same file.
7. **Foreign-currency print contract**: `buildInvoicePdf` printed foreign figures with the BASE
   symbol and no base equivalent. Fix: documents print in the invoice's currency with ISO
   labels plus an FX note (rate + base grand total). `tests/fx-print-contract.test.ts`.
8. **UTC-derived "today" at 34 sites** (invoice/quote/credit-note/payment/journal defaults,
   due dates, report asOf, cash-flow, normalizeDate fallbacks, close-through default) misdated
   documents during the first two hours of the local day in UTC+2. Fix: `shared/dates.ts`
   local-calendar helpers swept through the module. `tests/local-dates.test.ts`.
9. **Test-side fixes** (each proven, no product behaviour weakened): date-rotted journey
   locator (`24e985a`), csv-hostile wall bound now guards against hangs rather than an
   invented 30s SLA that measured suite worker contention, un-awaited save assertion in the
   hostile seed helper (real ordering race), and pdf-lib second-granularity timestamps
   normalized in decoded-stream comparisons (`190828e`).

Teeth protocol: every fix was disabled after going green and the regression test was watched
to fail, then the file was restored byte-identically (sha256-verified) and watched to pass
again.

## Performance numbers (5,000-invoice ledger, 31 accounts, 1,500 payments, 6,500 journals)

- load **130ms** · save **256ms** · save-from-loaded **522ms** · statement PDF **41ms**
- aging (sales) **250ms** · tax register **2ms** · trial balance Dr === Cr (22,304,480)
- memory: RSS ≤ 331MB, heapUsed ≤ 198MB
- 10,000-op soak: 243.8s wall, heap ≤ 265MB, no hangs (superlinear per-op cost — see limitations)
- 10,000-row hostile CSV import: **3,337ms**

## Known limitations (with severity)

- **[boundary]** Repo-wide `lint` has 81 pre-existing problems — all in crm/docs/pdf/sheets/
  shell/slides/tenders, none in books; per the module boundary this run did not touch those
  modules (a parallel session owns tenders). Books-scoped eslint is clean.
- **[minor, perf]** Every save re-serializes the whole ledger for the change hash — O(ledger)
  per operation (522ms at 5k invoices; the 10k-op soak shows superlinear chunk growth). Fine
  at the stated scale; an incremental hashing layer is the natural next step if ledgers grow
  much larger.
- **[minor]** Payment identity attribution still uses the established `Payment <id>` remark
  marker (ids are random-suffixed); invoice identity is fully structural.
- **[minor]** The credit note cannot reconstruct the original's absorb placement in one rare
  shape (preferred account with no compatible leg AND a round-off leg); observed worst FX
  netting dust is 0.01 and the fuzz tolerance covers conversion rounding.
- **[environment]** The packaged build cannot be UI-driven by Playwright/CDP **by design** —
  in automation mode the shell strips the remote-debugging switch and its automation protocol
  exposes only status/tabs/files/screenshots. The packaged journey was therefore driven
  through the window's accessibility tree (element-based, no coordinate clicking) against a
  scratch automation session; the driver scripts live outside the repository.
- **[product boundary]** SARS registration details on printed invoices remain absent pending
  the owner's product decision (out of scope here); email sending is out of scope per the
  mission.

## Verdict

**PRODUCTION READY** for the `apps/books` module within its boundary: every suite, journey,
workflow and hygiene gate green on a fresh build; no open critical/serious defect in books;
no data-loss path found; packaging verified end-to-end including a live books journey on the
packaged binary. The listed limitations are minor/boundary items with owners or next steps.

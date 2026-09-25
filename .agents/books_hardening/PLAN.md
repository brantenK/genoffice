# Zano Books — Production Hardening Plan

Owner: single session (books only). Date: 2026-09-24.

## 0. Baseline (verified this session)

| Check | Command | Result |
|---|---|---|
| Unit tests | `npm test -w @genoffice/books` | 17 files / 265 tests pass |
| Typecheck | `npm run typecheck -w @genoffice/books` | exit 0 |
| Cross-app workflow E2E | `npx tsx tools/verify-suite-workflows.mjs` | 56/56 pass |

Facts that shape the plan:

- `apps/books` is **not** a standalone Electron app. `src/main/index.ts` is a one-line re-export; `apps/shell` hosts it as a `WebContentsView` (`apps/shell/src/main/tab-manager.ts`). Data lives at `userData/books/books-data.json`.
- There is **no Playwright spec that drives the Books UI**, and no test executes the real `ipcMain.handle` bodies.
- The renderer duplicates three main-process engines (bank import, reconciliation, settlement suggestions); the *renderer* copies are the well-tested ones while production runs the *main* copies.
- Persistence is an unlocked whole-file read-modify-write; a read error degrades to an empty ledger that the next save persists over the real file.

## 1. Scope

In scope: `apps/books/**` only — `src/shared`, `src/main`, `src/preload`, `src/renderer`, `tests`.

Out of scope, and must not be touched:

- `apps/tenders/**`, `apps/crm/**`, `apps/shell/**` (another session is working on tenders).
- `e2e/**` shared specs, `tools/verify-suite-workflows.mjs`, `.github/**` — treat as read-only gates. `tools/verify-suite-workflows.mjs` must stay green; if a fix requires editing it, stop and report instead.
- Root configs (`package.json`, `vitest.config.ts` at root, tsconfig.base).

No new features. Every change is a fix or a refinement of something that already exists.

## 2. Explicit deferrals (recorded so they are decisions, not omissions)

| Deferred | Why |
|---|---|
| Full i18n of the module (`@genoffice/i18n`, ~200 strings in 15 components + shared reports) | Largest mechanical diff, zero functional risk, no locale data exists for business modules yet. Stretch stage only. |
| Multi-currency / FX | Needs a schema and product decision. |
| Split reconciliation (one bank txn → many invoices) | Genuine new feature; needs a new UI. |
| Managed-file lifecycle / rotating backups UI | Recorded deferral from the original mandate; `backup-restore.ts` already covers backup/restore. |

## 3. Stages

Each stage runs as an agent swarm. File ownership inside a stage is disjoint, so parallel writers never touch the same file.

### Stage 1 — Foundations (4 parallel agents)

**S1.1 Money-math correctness** — owns `src/shared/reports.ts`, `src/shared/credit-notes.ts`, `src/shared/accounting.ts`, new `tests/discount-reporting.test.ts`.

- Extract one shared per-invoice VAT breakdown from `accounting.ts` and use it in **both** the sales journal and `taxRegister`, so the VAT register can never disagree with the posted VAT output when an invoice-level `discountTotal` is used.
- `createCreditNoteJournal` must use `effectiveLineAmount` (line `discountRate`) like the original posting, instead of dumping the discount into the last group's account.
- AR aging must reconcile with `recomputePartyBalances` in the presence of credit notes (no silent construction-level difference).
- Replace substring journal↔invoice matching (`reversalJournalRemoval`, `deleteInvoice` pattern) with an exact-reference helper.

**S1.2 One settlement engine** — owns new `src/shared/settlement.ts`, `src/main/books-core.ts`, `src/main/books-main.ts`, `src/renderer/src/store.ts`, `src/renderer/src/components/BankingView.tsx`, new `tests/settlement-parity.test.ts`.

- Move the pure cores (`importBankStatement`, `computeSettlementSuggestions`, `executeReconciliationCore`) out of `books-core.ts` into `src/shared/settlement.ts`.
- Main and renderer both import that one module; delete the renderer duplicates.
- Store actions keep using IPC when the bridge exists and the shared engine when it does not (dev browser). Identical behaviour either way.
- `BankingView` consumes the same suggestion engine instead of its own partial re-implementation.
- The IPC surface (`BOOKS_CHANNELS`, `registerBooksIpc`, `configureBooksRuntime`) must not change shape here.

**S1.3 IPC contract hygiene** — owns `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/env.d.ts`, new `tests/ipc-contract.test.ts`.

- Declared `BooksApi` types must match the real handler results exactly (`loadData` nullable, `newBankBalance: number | null`, `transactions`, `restoredData`, full reconcile result).
- Add pure runtime payload validators for the unguarded channels (`saveData`, `openInPdf`, `exportToSheets`, `importBankStatementCsv`, `reconcileTransaction`).
- Remove unreachable/duplicate channel aliases and the duplicate `Window.booksApi` declaration.

**S1.4 E2E harness** — owns new `apps/books/tests/e2e/**` and `apps/books/tests/helpers/**` only.

- Electron mock + temp `userData`, booting the **real** `books-main.ts` handlers so the actual `ipcMain.handle` bodies run.
- Journeys: setup → invoice → rule posting → persistence across reload → bank CSV import → reconcile → close period → backup/restore → corrupt-file recovery → cross-app invoice issue → concurrent-writer conflict.

### Stage 2 — Production robustness (3 parallel agents, after Stage 1)

**S2.1 Durability & concurrency** — owns `src/main/books-core.ts`, `src/main/books-main.ts`, new `tests/durability.test.ts`.
- Serialize every read-modify-write on the ledger file (main-process mutation queue) so concurrent CRM/Tenders/Books writes cannot produce duplicate invoice numbers or lose an invoice; optimistic revision check on `saveData`.
- Read failure must not masquerade as an empty ledger: return an error, never hand an empty envelope to the renderer, never overwrite the file from that path.
- Safety snapshot + record-count guard before any write that would replace a populated ledger; corrupt-JSON forensics written once per content hash, not on every read.
- Atomic writes for the Sheets export and the PDF; unique PDF filenames.
- Migration registry: branch on `version`, refuse a newer-than-supported file with a clear error.
- Apply the S1.3 validators on the IPC handlers.

**S2.2 Store & UI robustness** — owns `src/renderer/src/store.ts`, `src/renderer/src/components/**`, `src/renderer/src/styles/books.css`.
- Surface failures: persist errors, closed-period blocks, rejected payments and failed journal posts must reach the user; `saveData` returns a reason instead of a bare `false`.
- Remove demo paths from production code: the `485250` balance fallback, the hardcoded sample FNB statement, the fabricated `@<party>.com` email.
- One source of truth for: VAT rate text in remarks, default payment terms, app version string (`package.json` is 0.1.0, the UI says v0.37), bank account name.
- Wizard writes complete settings; `Overdue` derived instead of silently rendering as `Draft`; `Cancelled` respected and filterable.
- Print stylesheet for `InvoicePrintModal`; `aria-label` on icon buttons; row amount respects line discounts.
- Audit `actor` populated from the OS user in the main process.

**S2.3 PDF/report polish** — owns `src/shared/reports.ts`.
- Page numbers on every page, repeated table header, footer on every page, safe column widths.

### Stage 3 — Verification swarm

Independent verifiers, one per stage-1/2 workstream, prompted to *find* problems rather than confirm: re-run the commands themselves on a fresh build, attack the invariants (journal balance, party balance vs ledger, aging vs AR, VAT register vs posted VAT), and report only reproducible defects. Plus one agent that runs the full gate set.

### Stage 4 — Fix-forward

Address the reproducible findings; each fix gets a regression test.

### Stage 5 — Final end-to-end pass

`npm test -w @genoffice/books`, `npm run typecheck -w @genoffice/books`, the new e2e suite, `npm run build -w @genoffice/books`, `npx tsx tools/verify-suite-workflows.mjs`, format/lint/theme gates on changed files. Report results with the actual command output.
# Zano Books — Production Hardening: Outcome

Date: 2026-09-24. Plan: this file's earlier section. All work confined to `apps/books/**`.

## Final verification (frozen tree, run by the parent, sequential)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `cd apps/books && npx tsc --noEmit` | exit 0 |
| E2E typecheck | `cd apps/books && npx tsc --noEmit -p tsconfig.e2e.json` | exit 0 |
| Unit + in-process E2E | `cd apps/books && npx vitest run` | 32 files / 498 tests pass (baseline 17 / 265) |
| Bundle build | `cd apps/books && npx electron-vite build` | exit 0 |
| Cross-app workflow E2E | `npx tsx tools/verify-suite-workflows.mjs` | 56/56 pass |
| Format (changed files) | `npm run format:check` | books clean |
| Lint | `npx eslint apps/books` | 0 problems |
| Theme colours | `node tools/check-theme-colors.mjs` | clean |
| English comments | `node tools/check-english-comments.mjs` | OK |
| Brand | `node fork/tools/check-brand.mjs` | passed |

## What the swarms did

- **Recon (3 explorers)** — architecture map, E2E infrastructure map, prior-effort history. Established the baseline and the real defect list.
- **Stage 1 (4 agents)** — money-math divergence; one shared settlement engine (`src/shared/settlement.ts`) replacing three renderer/main duplicates; IPC contract + runtime validators; a headless in-process E2E harness that boots the **real** `books-main.ts` against a temp userData and drives the real IPC channels.
- **Stage 2 (4 agents)** — durability/concurrency; store error surfacing; PDF/aging polish; component and print polish.
- **Verification (3 adversarial agents)** — ~10 000 randomised probes plus hand-built cases and three sabotage ("teeth") experiments. Found a release blocker and four high-severity defects (below).
- **Fix-forward (5 agents, two rounds)** — repaired every confirmed high/medium defect, with teeth evidence per fix.

## Headline finding

`src/preload/index.ts` declared `saveData: (data) => invoke(channel, data)`, dropping the `revision` argument the handler requires. **Every save in the app was rejected** — first-run setup, invoices, journals, payments, settings — surfacing only as a persistent banner. Nothing caught it because the contract test asserted that bridge members *exist*, and `Window.booksApi` is wired with an inline structural literal so a short parameter list still compiles. Fixed, and pinned by a routing test that drives the real preload into the real handler and asserts a two-argument call. The built artifact (`out/preload/index.js`) verifiably forwards `revision`.

## Other defects fixed (all with regression tests)

- **Stale-save destroyed data.** The staged *merge-then-write* unioned invoices/journals but spread the stale writer's envelope for everything else: it erased the newer writer's payments, imported statement lines, parties and audit trail, reverted newer edits to the same invoice, and resurrected deleted records — while reporting success. Replaced with the planned hard reject (`{ok:false, conflict:true, current}`, nothing written). The guard now reads only the explicit revision argument, so the renderer's conflict recovery converges instead of looping.
- **A read error looked like an empty ledger** and the next save overwrote the real file; now absent vs unreadable vs *parses-but-is-not-a-ledger* are distinguished, every write is refused while the store is unreadable, and a content-addressed forensic copy is written once per payload (the old path wrote copies on every read and the watcher fed itself — 1 file became 18 in two seconds).
- **Negative-subtotal invoices** (a rebate line) posted no revenue leg, leaving an unbalanced journal, or dumped the residual into the VAT leg — silently booking a rebate-sized amount as VAT. The revenue/expense leg now posts, the VAT leg carries the stored VAT, and the entry balances for every finite input.
- **Over-amount / partly-covered statement lines** stranded cash in Bank Suspense permanently. The settlement engine now respects the coverage a recorded payment already booked and books a genuine excess as an unapplied receipt, so Bank Suspense, AR control, the party balance and aging all agree.
- **Failed operations still wrote** (spurious revision bump, `.bak` rotation, broadcast) — a no-op import now writes nothing.
- **Silent failures everywhere** — failed persists, refused saves, closed-period blocks, rejected payments and rejected journal posts each report through the store's error surface, and in-memory state rolls back rather than showing a save that never landed. `closeFinancialYear` no longer reports success for a refused write.
- **No way to reach an empty ledger** (the shrink guard had gone too far): deleting the last invoice and restoring an empty backup now work again, via an explicit `emptyLedger` intent that must accompany a current revision; stale and migration-decoy payloads still cannot empty a populated ledger, and the refusal message is user-facing prose.
- **Demo data removed from production paths** — the `485250` balance fallback is gone, the sample-statement helper is compiled out of production builds, and hardcoded VAT/bank/terms/version constants became single sources (the version even disagreed with `package.json`).
- **Reporting and UX** — the VAT register and the journals now share one tax rule; AR aging reconciles with party balances and credit notes; PDF invoices carry page numbers, a repeated header and a footer on every page with clipping that prevents column collisions; the invoice form's line amount respects discounts; `Overdue` is derived and its filter chip matches the badge; a print stylesheet exists; icon buttons have accessible names; the audit log shows the actor.
- **Housekeeping** — dead code and duplicate engines removed, `tests/` typechecked through `tsconfig.e2e.json`, orphaned exports and unused dependencies gone, theme colours tokenised.

## Deliberate decisions and documented limits

- **No Playwright spec was added** for Books: `e2e/**` and `.github/**` are shared infrastructure owned by the other (tenders) session, and the Playwright lane needs `build:all` plus a display. Books' end-to-end coverage is the in-process harness that drives the real main-process handlers over the real channels against a real temp store, run by `npm test`, plus the cross-app workflow suite.
- **`version: 0` stays readable** as the pre-ledger format: two committed tests feed it as legacy data and require the migration to succeed.
- **Known, not fixed** (each surfaced by verification and left deliberately): two OS processes sharing one `userData` are not serialised (the queue is per-process); main-process core writes other than `books:save-data` do not re-check the closed period; `revision` after a restore is the backed-up one (self-healing via broadcast, suspected only); the 9 orphaned `tools/*books*` challenger scripts remain unwired to any npm script; `taxRegister` cannot know `taxInclusive`, so an item-only row is read VAT-exclusive by both the register and the journal (stated in code and tested).

# Tenders 9/10 Hardening — Handoff Index

Status of the multi-phase effort to raise `apps/tenders` from a functional MVP to a
trustworthy paid local-first desktop tender product. Written so a **new session can
resume without re-discovery**.

- Repo: `C:\Users\brant\OneDrive\Documents\GenOffice\genoffice`
- Branch: `product`. **HEAD is `e634250`** (`refactor(tenders): close the 10-reviewer code review
findings`). The Phase 1–5 work landed as `ff822c0` with the fork/e2e commits
  `284c312`…`5711775` on top of it; the five-wave hardening fix set is **committed** as
  `a22b5e6`, the optional-AI wave as `c188470`, the DOCX/discovery/reminders wave as
  `7f7067b`, and the two remediation waves (review findings, then coordination sweep) as
  **`e634250`**. A **third wave (structural) is uncommitted** on top of `e634250`, alongside a
  concurrent, unrelated `apps/books` + `.agents/` workstream. That number moves while agents edit,
  so run `git status --porcelain` rather than quoting a figure from here.
- Deepwork coordination state: `.slim/deepwork/tenders-9of10.md` (git-local; read it too)
- Original audit artifacts: `C:\Users\brant\AppData\Local\Temp\opencode\tenders-live-audit-Lpyf1l\`
- Full 15-work-package roadmap + release gates: produced by planner `pla-1`, pressure-tested
  by oracle `ora-1`; summarized in the deepwork file.

## Documents in this folder

| File                          | Contents                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                   | This index, current status, resume instructions, commands                                                                                                                                                             |
| `contracts-and-invariants.md` | Technical reference: v2 schema, store API, IPC channels, limits, invariants that must not regress                                                                                                                     |
| `module-map.md`               | **Structural reference**: where each responsibility lives after the composition-root split, the import-graph direction, the diagnostics log's path/bounds, the test infrastructure, and the no-blank-screen invariant |
| `phase-2-remaining.md`        | Phase 2 (durability) — COMPLETE; retained as the record of what was done                                                                                                                                              |
| `phase-3-intake.md`           | Phase 3 — parser corpus, extraction review, OCR, scale                                                                                                                                                                |
| `phase-4-workflows.md`        | Phase 4 — company/customer CRUD, submission/outcome, typed integrations                                                                                                                                               |
| `phase-5-product.md`          | Phase 5 — responsive UX, accessibility, theme, IPC hardening, release evidence                                                                                                                                        |

## Phase status

| Phase                             | State                                                                                                                                                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Truth (readiness + proposals) | **DONE** — Oracle PASS (`ora-1`)                                                                                                                                                                                                                                                                   |
| 2 — Durability                    | **DONE** — schema, authoritative store, typed IPC bridge, IPC-surface authorization, renderer v2 cutover, live smoke and cutover E2E all built and verified; Oracle gate PASS (`ora-1` re-gate after B1/F1 remediation)                                                                            |
| 3 — Intake                        | **DONE — Oracle gate PASS** — parser improvements, extraction review/correction UI, authoritative intake verification + additive readiness gate, OCR honesty (alpha only; OCR-Beta deferred), import scale/cancellation; synthetic corpus 100% metadata/recall/conflict with **0 false-readiness** |
| 4 — Workflows                     | **DONE — Oracle gate PASS** — first-use separation + company/customer CRUD, submission/outcome lifecycle, typed CRM/Books ports, main-owned readiness binding; E2E 23 tests across 7 specs                                                                                                         |
| 5 — Product                       | **DONE — Oracle gate PASS** — responsive workspace, a11y + light/dark/system theme, WP-14 IPC/export hardening, measured limits, managed-file trash/undo + rotating-backup recovery; E2E 10 specs. Caveats: synthetic-only corpus, OCR-Beta deferred; packaged win build + packaged smoke PASS     |

## Verified current state (do not re-derive)

- **The four newest features — DOCX intake, tender discovery, deadline reminders and optional AI
  extraction — are documented in `contracts-and-invariants.md` §3b (discovery), §3c (reminders),
  §3d (DOCX intake), §3e (diagnostics) and §5a (AI).** The privileged handler count is **33** and
  unchanged by the composition-root split (it was stated as 14, then 23, then 31 as channels were
  added — §3 now shows the arithmetic and the command that counts it): after the split all 33
  `ipcMain.handle` calls live in `apps/tenders/src/main/ipc/handlers.ts`, and **every one of the 33
  begins with `isTrustedTendersEvent`** — verified mechanically by splitting that file on
  `ipcMain.handle` and requiring the gate within each handler, which reports zero exceptions. The
  eight discovery/reminder channels plus the two diagnostics channels are in §3's list with their
  preload member names.
- **The structural reference is now `module-map.md`** (wave 3): the per-module responsibility map,
  the line counts, the import-graph direction, the diagnostics log, the test infrastructure and the
  no-blank-screen invariant. It also records that **`main` no longer imports `renderer/`** — the
  demo dataset moved to `shared/demo-seed.ts` — and that `main/tenders-main.ts` is now **341 lines**
  (it was 3,702) and is the composition root only. **Two corrections to what this bullet used to
  claim:** the figure was **347**, which was stale (a `wc -l` run in the 2026-09-25 pass reports
  341, and the module-map table had drifted in eleven rows), and the import direction is **not**
  "enforced" — nothing in the toolchain fails on a `main → renderer` import, and a type-only
  `renderer → main` edge (in `renderer/src/diagnostics.ts`) exists today. `module-map.md` now says
  both plainly.
- **Three items this file used to record as open have closed, verified on disk:** the **error
  boundary** landed (`renderer/src/components/ErrorBoundary.tsx`, mounted in `main.tsx` around
  `<App />` and in `App.tsx` around the page area — a render throw is now a recoverable, honest
  fallback rather than a blank window; `tests/components/error-boundary.test.tsx` pins it); and
  **both diagnostics wiring gaps** closed (`recordDiagnosticsStart` is called from
  `registerTendersIpc` before anything else can record, and `ErrorBoundary` renders the log path to
  the user in its fallback). §6 item 15 and §3e were corrected against disk; the earlier wording in
  this folder described all three as un-landed and was wrong.
- Full Tenders suite — **the figures below are stale and must be re-measured, not quoted.** The
  wave-3 pass reported `npm test -w @genoffice/tenders` as **Test Files 10 failed | 48 passed (58)**
  and **Tests 8 failed | 1604 passed | 7 skipped (1619)**, read at the time as a concurrent-edit
  artefact rather than a regression (three of the failures — `adversarial-stress.test.ts`,
  `ai-e2e-contract.test.ts`, `renderer-display-locale.test.ts` — passed when run alone: 61/61).
  **Those counts are written from a tree that no longer exists.** The verified figures for the
  current tree are **1854 passing / 7 skipped / 0 failing across 58 test files**, and
  `find apps/tenders/tests -name "*.test.ts*" | wc -l` reports **58 files** on disk (it reported 57
  when this bullet was written). Every pass total this folder has carried — 1056, then 1604, then
  this one — went stale within a wave; treat a count here as a dated observation and re-run
  `npm test -w @genoffice/tenders` for the current one.
- `npm run check:e2e-types` and `npx tsc --noEmit -p e2e/tsconfig.json`: run in the wave-3 pass,
  both **clean (exit 0)** after the wave-3 spec edits.
- Built-Electron E2E — **14 Tenders specs on disk** (`ls e2e/tenders-*.spec.ts | wc -l` → 14), plus
  the shared modules `e2e/tenders-ai-fixtures.ts`, `e2e/tenders-discovery-fixtures.ts` and
  `e2e/tenders-timing.ts`. The specs declare **63** `test(` cases statically
  (`grep -h "^\s*test(" e2e/tenders-*.spec.ts | wc -l` → 63; `tenders-regression-smoke.spec.ts` is
  one `test(` that drives 19 flows). The lane's own totals are **not** re-measured here — the
  orchestrator runs the suite. The two figures above move with every added test, and the previous
  version of this bullet (**13 specs / 59 cases**) was already stale; the recorded run totals it
  also carried have been dropped rather than left to rot, because this folder has now been wrong
  about a test count three times.
- **A FAILING e2e run still yields the app's diagnostics log, and that is now guarded.** The log
  lives inside the scratch profile every spec deletes, so `e2e/tenders-timing.ts` owns
  `salvageTendersDiagnosticsLog` / `teardownScratchProfile` and **all 14 specs** tear their profiles
  down through them, naming the artefact in the result JSON. The first version of this collected the
  log in the spec's `finally` but recorded the path **before** that block ran, so a failing run
  reported `diagnosticsLogArtifact: null` with the profile already gone — the log absent exactly
  when it was needed, and the JSON contradicting itself (top-level `null`, `artifacts.diagnosticsLog`
  a real path). Salvage now happens at both the throw site and the `finally`, and
  `e2e/tenders-diagnostics-artifact-guard.spec.ts` (4 cases) asserts the contract mechanically:
  copy-before-delete with byte equality, `null` for a run whose app never started (not a second
  failure), a failing run's artefact present and named, and **no Tenders spec deleting a scratch
  profile outside the helper**.
- **The error boundary now has e2e coverage in the BUILT app.** `tenders-regression-smoke.spec.ts`
  drives a new flow (`error-boundary-fallback-in-built-app`, 19 flows in the spec now) that injects
  a genuine render throw into the real mounted boundary instance by walking React's fiber tree from
  `#root`, picking the **inner page boundary** (`region: "Tenders"`) rather than the root one, and
  asserting that **both** are mounted, the fallback's real copy and test ids, that the shell's
  navigation stays usable beside the failed region, that the failure reaches the log as an **error
  code and not the thrown message**, and that "Try this view again" remounts the page. It does not
  prove that a specific product component throws — that stays the
  jsdom suite's job — and the spec says so where it asserts it.
- **The e2e lane's load sensitivity is now a documented contract, not folklore.**
  `contracts-and-invariants.md` §7 and `e2e/tenders-timing.ts` record what was measured (a healthy
  commit is observed by a poll in **under ~600 ms**; the slowest figure any journey covers is under
  1 s), the three shared windows derived from it (`STORE_COMMIT_POLL_MS` = 12 000 — 20× the slowest
  measured commit; `STORE_IMPORT_POLL_MS` = 30 000; `FIXTURE_SETTLE_POLL_MS` = 60 000), and every
  per-spec figure they replaced. `fork/RUNBOOK.md` carries the operational rule: **a failure that
  passes when run alone is a load artefact, not a regression.**
  `e2e/tenders-ai-extraction.spec.ts` (4 journeys over a local fake provider — AI off contacts
  nothing; AI on lands a marked unconfirmed suggestion; a failing/malformed reply degrades to
  the local extraction; an interrupted run leaves a usable tender and writes nothing),
  `e2e/tenders-docx-intake.spec.ts` (2 journeys — a Word `.docx` imports through the file input,
  populates the matrix and persists; a file that is not a real `.docx` is refused with a reason
  rather than shredded) and `e2e/tenders-discovery.spec.ts` with `e2e/tenders-discovery-fixtures.ts`
  (2 journeys — the saved list with its limits and filters plus a refused document download; a
  saved list that cannot be read reports the failure and never an empty list). Re-run the lane
  (`npm run test:e2e`, Tenders specs only) for the current totals rather than quoting any of this.
  - What each spec covers, with the journey counts declared on disk today (a static count again,
    not a run result — the recorded per-spec counts this list used to carry have drifted):
  - `e2e/tenders-regression-smoke.spec.ts` — 17 flows in one `test(`,
    `unauthorizedOrInvalidRequest: []`.
  - `e2e/tenders-persistence-cutover.spec.ts` — 8 journeys: hydrate→edit→save→restart;
    vault-entity restart (1b); v1 migrate-once→v2; forced save failure + Retry; forced
    `REVISION_CONFLICT` + Reload (no overwrite); localStorage UI-only; a schema-rejected
    closing-date no-brick regression (with a valid-date control); and journey 7 — a close
    inside the autosave debounce still commits the edit.
  - `e2e/tenders-intake-review.spec.ts` — 5 scenarios: mandatory review gate on import;
    correct/reclassify/add/not-stated; readiness blocked then cleared with no false clear;
    a textless scanned page classified OCR-required and blocked until reviewed; review
    state survives restart.
  - `e2e/tenders-first-use-crud.spec.ts` — 4: first-use choice, company + customer
    create/edit/archive/restore with required-document definitions across restart, a tender
    opened by keyboard alone (Tab+Enter / Tab+Space), and demo-import labelling.
  - `e2e/tenders-demo-isolation.spec.ts` — 3: sample workspace labelled with
    `dataOrigin:'demo'`, never a recovery fallback, cross-app writes gated, and the
    copy-into-own-workspace path persists with no dangling vault references.
  - `e2e/tenders-lifecycle.spec.ts` — 2: reasoned transitions, override submission with a
    preserved blocker snapshot (never "cleared"), evidence step, won/lost outcomes with
    milestone gating, all persisting across restart.
  - `e2e/tenders-billing-guard.spec.ts` — 3: no billing affordance on a non-won tender;
    a real inline billing attempt surfaces success or a visible error + Retry (never
    silence); main-side typed rejections for non-won and demo workspaces with no writes.
  - `e2e/tenders-durability.spec.ts` — 9: soft-delete to `.trash` + restore across restart;
    link-aware delete warnings; replace-then-trash ordering; recovery is never automatic;
    reconciliation reports without deleting; a failed `saveDocument` never presented as
    durable; tender removal soft-deletes its RFP (and is fail-closed on failure); vault
    re-attach replaces and trashes.
  - `e2e/tenders-a11y-theme.spec.ts` — 9: system/light/dark token sets and relaunch
    survival; PDF rendering unaffected by the UI theme; axe scan on core pages and overlays;
    dialog/drawer semantics with focus trap + restore; named icon controls ≥ 24px and a
    keyboard-only journey; every `Drawer` aside starts below the workspace toolbar so its
    close control is hit-testable; theme-token sidebar chrome in dark.
  - `e2e/tenders-responsive.spec.ts` — 5: 1280×800 wide split, 1024×768 compact pane
    switch, 800×600 with no unreachable controls, 200 % text zoom, and a keyboard-resized
    split proportion surviving reload.
  - Artifacts under `e2e/artifacts/` (`tenders-*-journey-*.json`, `tenders-regression-smoke-*.json`,
    screenshots, videos).
  - **`e2e/tenders-timing.ts` declares the lane's poll windows and their justification** — one
    `pollStore` / `readStore` / `storeFile` / `storeSignature` for the whole lane, plus
    `STORE_COMMIT_POLL_MS` (12 000), `STORE_IMPORT_POLL_MS` (30 000) and `FIXTURE_SETTLE_POLL_MS`
    (60 000). Eight specs import them instead of each carrying a hand-picked figure; the figures
    they replaced, and the measurement behind the new ones, are in `contracts-and-invariants.md` §7.
    It is a helper with no test case of its own, the same shape as `e2e/cli-control.spec.ts`.
- Phase 3 corpus metrics (`apps/tenders/tests/fixtures/tenders-corpus/metrics.json`):
  critical-metadata accuracy **100%**, critical-requirement recall **100%**, pricing/BOQ
  recall **100%**, conflict detection **100%**, false-positive rate 0.32%, **false-readiness
  0**. **How that "0" is derived, and what it therefore does not prove:** the figure is a
  **harness predicate over the synthetic corpus**, computed by `computeMetrics` in
  `tools/tenders-corpus/metrics.mjs` from the parser's own output versus gold annotations that
  are themselves generated from the same rule catalogue that renders the fixtures
  (`tools/tenders-corpus/corpus.mjs`) — it is a deterministic regression gate, **not** a run of
  `assessReadiness` over real tenders and **not** a measurement of the app's accuracy on a
  document a bidder would actually receive. The one claim it supports is the one the suite
  enforces: on 30 code-generated fixtures the parser never produced a "trusted-clear" reading of
  a fixture the gold says is not clearable, and never missed a mandatory/disqualifier
  requirement. The gate cannot be bypassed by weakening it, and two things hold independently
  of it: the new mandatory-review/OCR gate blocks readiness while any readiness-critical field
  is unconfirmed or any OCR-required page is unreviewed, and no automated path may write
  `confirmed`.
- **Known limitation (unchanged, and it still governs every accuracy claim):** the Phase 3 corpus
  is **synthetic** (code-generated), not real/anonymised tender documents. Criterion #1 is met on
  synthetic data only; real-world accuracy still needs user-supplied tenders before any paid-release
  claim. **The DOCX intake does not change this** — its tests use code-generated `.docx` packages
  built by the suite's own fixture writer, not documents a real bidder produced — and **tender
  discovery does not change it either**: listings come from a feed Treasury itself calls a public
  beta with no accuracy guarantee, so a discovered tender is a lead to verify, never evidence of
  the app's accuracy. Nothing added in this batch licenses a real-world accuracy claim.
- **OCR (alpha only) — conditional on AI being configured AND on the source being a PDF.** The
  **local** engine performs no OCR: pages with no text layer are **detected and classified**
  (`ocr-required` / `ocr-unavailable` / `ocr-failed`), their text is **not extracted**, and they
  block readiness until each page is read by the optional AI pass (`ai-extracted`,
  `contracts-and-invariants.md` §5a) or marked manually reviewed. That local limit is permanent
  and unconditional. What changed in the AI wave is that a model the user configured can read
  such a page's **image**, so "scanned pages are not read" is true of the app **only while AI
  extraction is off**. **What the DOCX wave changed is the other half of the condition: the
  limitation is now also source-dependent.** A Word `.docx` has no rendered page and no scanner,
  so the AI vision pass **refuses a Word source outright, before it consults the model** —
  whatever the configured model can do (`WORD_DOCUMENT_VISION_MESSAGE`,
  `contracts-and-invariants.md` §3d). A picture-only Word page therefore stays flagged and keeps
  **blocking** until a person compares it against the original and marks it reviewed, with AI on
  or off — the page gate in `contracts-and-invariants.md` §1a states the same condition
  (`ai-extracted` is reachable only for a PDF source) — and no surface may call such a page
  "scanned". Both directions are guarded:
  `tests/ocr-honesty-copy.test.ts` fails when a surface says scanned pages are read without
  naming AI as the reader (or claims the text layer of every page is extracted),
  `tests/ai-honesty-copy.test.ts` fails when a surface calls the app entirely offline without
  stating that AI extraction sends the document to the model provider the user configured, and
  `tests/docx-intake-copy.test.ts` pins the Word refusal. **OCR-Beta (in-app OCR) remains
  deferred** to a later phase/backlog by decision.
- **Intake covers `.docx` as well as PDF.** Intake accepts a Word `.docx` **as a single
  document** — one `.docx` is one tender — through the same file input, drag-and-drop path and
  review step a PDF uses; **it does not read multi-file packs, `.doc`, or any other Word format.**
  A `.docx` has no pages, so only the page breaks the document **itself declares** are counted and
  a flowing document is presented as one continuous block of text rather than as "1 page"
  (`contracts-and-invariants.md` §3d). Every preflight failure is typed and user-visible
  (`FILE_TOO_LARGE` / `TOO_MANY_LINES` / `TOO_MUCH_TEXT` / `ZIP_BOMB` / `PROTECTED` / `NOT_A_DOCX` /
  `CORRUPT` / `EMPTY_DOCUMENT` / `NO_TEXT`); nothing returns a silent empty extraction, and a
  refused file is never shredded.
- **The import limits are published as the ones that are enforced, including the smaller bound
  that decides whether a document can be kept.** 500 pages / 100 MiB per PDF
  (`PDF_PREFLIGHT_LIMITS`); 24 600 text lines / 100 MiB per `.docx`, plus 12 000 000 characters of
  extracted text (`DOCX_PREFLIGHT_LIMITS.maxLines` / `maxTextChars` — a line count cannot see a
  single unbounded paragraph, which is the shape the character budget exists for); and a **25 MiB
  per-document save ceiling** (`MAX_TENDERS_DOCUMENT_UPLOAD_BYTES`), which a document between it
  and the 100 MiB import ceiling exceeds — such a file **still imports and is shredded**, but
  cannot be saved into the workspace and lives in the session only. `intakeLimitDisclosure()`
  says exactly that on the dropzone, and `tests/docx-intake.test.ts` ("the advertised import
  limits are the enforced ones") fails if any published figure drifts from the constant that
  enforces it. `contracts-and-invariants.md` §1 and §3d carry the same numbers.
- **A "no reminders" gap is closed — with a caveat that must be carried by the copy.** Before
  the reminders wave the app had no reminder mechanism at all beyond a manual `.ics` export and an
  on-screen countdown, so a user who closed the app was never warned about a closing time. Main
  now runs a deadline schedule (`contracts-and-invariants.md` §3c) that raises an OS
  notification on a configurable lead-time ladder, deduped once per (tender, threshold, closing
  instant) by a persisted ledger. **The caveat: a reminder fires only while the app is running.**
  There is no background service, no OS scheduler and no cloud push, so it cannot warn a user
  whose app is closed; the warning that was due is delivered the next time the app opens, marked
  `late`, and says so. The sentence is exported as `REMINDERS_RUNTIME_LIMITATION`, shown verbatim
  on the reminder settings surface, and pinned by `tests/reminders-settings-copy.test.ts`.
- **Tender discovery reads a public beta and says so.** Listings come from National Treasury's
  keyless eTenders OCDS feed (PDDL 1.0). Treasury labels it a **public beta**, states its
  **accuracy is not guaranteed**, and states it **must not be used for critical decision making
  or legal purposes**; **municipalities and state-owned enterprises appear only when they
  volunteer their data**, so a known tender can be missing. `describeCoverage()` renders those
  limits verbatim and always (empty and error states included), and a listing added to the
  workspace arrives **`unconfirmed`** like any other machine-sourced value
  (`contracts-and-invariants.md` §3b).
- Phase 2 Oracle gate: **PASS** (`ora-1` re-gate, after a `reviewer_2b_cutover`
  REQUEST_CHANGES — an integrity backdoor in `partialize` — was remediated) and after a
  shredder v2 schema-validity data-loss defect and the B1 `closingDate` bricking defect
  were fixed.
- The renderer persists exclusively through the authoritative v2 store (`loadStoreV2` /
  `saveStoreV2` / `onStoreChangedV2`); localStorage holds UI preferences only
  (`zanostack-tenders-ui`) and the legacy `zanostack-tenders-v1` key is purged.
- Non-blocking follow-ups are tracked in `contracts-and-invariants.md` §6.

## Release status and accepted limitations

All five phases are complete, and each phase passed its Oracle gate (Phase 1, Phase 2
re-gate, Phase 3 re-gate, Phase 4, Phase 5 re-gate — all `ora-1`).

**Resolved by the five-wave hardening fix set (committed as `a22b5e6`).** Four fix
waves built the set; an eight-reviewer adversarial pass over that work produced further
findings, and the fifth wave closed them — each closure with a test or an e2e journey behind
it:

- **Demo assets never shipped.** electron-vite's renderer root is `src/renderer`, so vite's
  default `publicDir` was empty and no `demo/` was emitted at all: "Load demo RFP" fetched a
  404 and the sample workspace's vault documents had no file. `publicDir` now points at
  `apps/tenders/public`, and `assertModuleTreesPresent` fails the package step when either
  asset is missing.
- **The drawer close control was unreachable by pointer.** The drawer now measures the
  workspace toolbar and starts below it (`Drawer.tsx` + `responsive.css`), guarded by
  `e2e/tenders-a11y-theme.spec.ts` test 6 and `apps/tenders/tests/drawer-toolbar-offset.test.ts`.
- **Money was parsed in three places.** One rand parser/formatter now lives in
  `shared/money.ts` (`parseMoney` / `formatRandAmount`), so the amount printed in a proposal
  and the amount parsed from an edit cannot drift apart.
- **Dirty-close data loss.** The shell now flushes a Tenders view before the window closes
  (see §3a of `contracts-and-invariants.md` — the shell dirty-close guard), so an edit inside
  the autosave debounce is committed or explicitly prompted for — never dropped silently.
- **The size-ceiling wedge.** The document ceiling was below what a fully reviewed tender
  serialises to. The ceilings were raised and the renderer now pre-checks both of them,
  reporting a refusal with a way forward (limits table, `contracts-and-invariants.md` §1).
- **CSP.** `apps/tenders/src/renderer/index.html` now carries an explicit
  `Content-Security-Policy` — `default-src 'self'`, with `'wasm-unsafe-eval'` and `blob:`
  allowed only where the bundled pdf.js worker needs them.
- **Third-party notice coverage.** `tools/gen-third-party-notices.mjs` now scans the fork-only
  `apps/books`, `apps/crm` and `apps/tenders` trees, so libraries that ship inside `app.asar`
  (lucide-react, zustand) finally have notice entries.

**The uncommitted remediation wave (on top of `7f7067b`) — what it changes, each with a test.**
The set above left a further round of findings; this wave closes them, and every line here is
documented in `contracts-and-invariants.md`:

- **A fabricated closing date is gone** (§4). `docsAtClosing` no longer assesses linked
  documents against `Date.now() + 90 days`: each entry carries the instant it was assessed
  against as a closed union (`KNOWN | UNKNOWN | UNPARSEABLE`), and with no known closing date
  the dimension reports `UNKNOWN`, the `docs-at-closing` check fails with an explicit reason and
  the runway's `daysAway` is a civil-day reading (1 Nov → 30 Nov is 29).
- **The legacy v1 persistence stack is retired** (§2b, §3) — no synthesis, no watcher, no
  writer inside Tenders; `readTendersStore` quarantines a malformed primary to
  `.corrupted.bak` and throws `LegacyTendersReadError` instead of degrading to
  `{workspaces: []}`, while a missing file is still `null`.
- **Path confinement does real `realpath` + `lstat` checks** (`main/document-store.ts`),
  including links out of the managed root and a `.trash/` directory that became a link.
- **A diagnostics log exists** (§3e): `<userData>/tenders/tenders-diagnostics.log`, bounded at
  1 MiB × 3 files, writing counts and codes and never document content, with
  `tenders:diagnostics-record` / `tenders:diagnostics-path`.
- **A build with no bridge can no longer claim its work is saved** (§2a): `hydrationMode:
'unavailable'` and the `Cannot save` pill replace the old "Saved" over a persistence path
  that did not exist.
- **AI runs have wall-clock budgets** (§5a): 300 000 ms per call, 900 000 ms per run, with the
  deadline warning shown to the user and the unreached pages left blocking.
- **The published import limits are the enforced ones** (§1, §3d): 500 pages / 100 MiB PDF,
  24 600 lines / 100 MiB `.docx`, the new `maxTextChars` (12 000 000) with `TOO_MUCH_TEXT`, and
  the 25 MiB per-document save ceiling that the dropzone now discloses.

**DOCX intake, tender discovery and deadline reminders (this batch — two new external reaches
and one new source format).** Three features landed after the AI wave. Their contracts are in
`contracts-and-invariants.md` §3b–§3d; here is what a release claim would still need for each.

- **Intake now reads a Word `.docx` as a single document** (not a pack, and not `.doc`). It goes
  through the same shredder, rule engine and review step as a PDF, so there is one pipeline, and
  the module refuses to invent pages: a flowing `.docx` is one continuous block of text rather
  than "1 page", and a picture-only page stays flagged and blocking rather than being called
  scanned. Verified by `tests/docx-intake.test.ts`, `tests/docx-intake-copy.test.ts` and
  `e2e/tenders-docx-intake.spec.ts`.
- **Tender discovery reads National Treasury's public OCDS feed**, keyless, with an https-only
  exact-host allow-list validated before every request, per-hop redirect re-validation, byte caps
  enforced while reading, timeouts, bounded retries, and an on-disk cache
  (`<userData>/tenders/discovery/discovery-cache.json`, 6-hour staleness) so the pane works with
  no network at all. A downloaded document enters through the **same** managed-document store and
  the **same** intake as a file the user picked, arriving `unconfirmed`. Verified by
  `tests/discovery.test.ts`, `tests/discovery-client.test.ts`, `tests/discovery-pane.test.ts` and
  `e2e/tenders-discovery.spec.ts`.
- **Deadline reminders** raise an OS notification from a pure, testable schedule with a persisted
  dedupe ledger. **State plainly what it cannot do: a reminder fires only while the app is
  running** — no background service, so it cannot warn a user whose app is closed, and a warning
  that fell due while closed arrives late and says so. Verified by `tests/reminders.test.ts`,
  `tests/reminders-scheduler.test.ts` and `tests/reminders-settings-copy.test.ts`.
- **What a release claim would still need, for all three:** a real `.docx` corpus (the intake's
  fixtures are code-generated), a live Treasury request from a user's machine (the client's
  network call is injected, so no test here proves one), and a platform check that an OS
  notification is actually displayed. **None of the three adds e2e coverage of the AI path**, and
  none of them licenses an accuracy claim.

**Optional AI extraction (the AI wave — the deliberate boundary change).** Tenders can now read a
tender with a model provider the **user** configures, alongside the local rule engine, which
stays the offline default. The boundary amendment and what it excludes are in the
Product-boundary reminder above; the contracts are in `contracts-and-invariants.md` §5a, and
`fork/COMPLIANCE.md` records it as a fork decision with its first outbound network call.

- **Verified in this wave:** the pure core (`apps/tenders/src/shared/ai-extraction.ts`) with its
  behaviour guard (`tests/ai-extraction.test.ts`), the preload pass-throughs over the shell's own
  `ai:*` channels (Tenders registers no handler), the schema's `suggestedBy` provenance marker,
  the `'ai-extracted'` page status with the `pageContentObtained` readiness rule, and the two
  copy guards.
- **What a release claim would still need:** the whole AI journey exercised in the **built** app
  (offer → extraction → review → readiness), and a live-provider smoke test. No test in this repo
  may call a provider — the model call is injected precisely so tests need no network — so nothing
  here proves a real model call works, and the AI path deliberately has no e2e coverage.

**Remaining release work (not correctness blockers):**

- **Real/anonymised tender corpus.** Every parser accuracy figure is measured on a synthetic,
  parser-friendly corpus; a licensed/anonymised set of real tenders is required before any
  real-world accuracy claim (Phase 3 criterion #1 is met in form only). This is now the blocking
  item for two more features than it was: DOCX intake is measured the same way, and the discovery
  feed's own reliability is Treasury's problem, not a proof of this app's.
- **The discovery feed and the reminder schedule have no live-provider equivalent of a smoke
  test.** The discovery client's network call is injected, so every unit test runs with zero
  network; that is what makes the bounds provable, but it also means **nothing in this repo proves
  a real Treasury request succeeds from a user's machine**, and the two e2e journeys drive the
  built app against fixtures. Similarly, nothing proves an OS notification is actually _displayed_
  on a given platform — the scheduler records and reports a notification it could not show rather
  than re-arming it (`contracts-and-invariants.md` §3c), so a silent platform degrades visibly but
  is not covered by a test here.
- **The PDF path still has no line-count guard.** The published byte ceiling is measured (a
  91.6 MB image-heavy PDF parses in ~0.66 s), but text density drives memory, and the PDF preflight
  bounds only bytes and pages. **The text-dense figure is worse than this folder used to state.**
  It said **~0.042 MB heap per extracted text line** (≈24 600 lines at a 1 GB budget), which was
  **extrapolated from the 2 000-page sweep** in `tests/performance/results.json` (40 000 lines,
  ~405 MB peak heap against a ~168 MB baseline). The reviewer's measurement is against the
  **`byteStress`** point in the same file — the fixture the byte guard actually has to survive:
  **22 000 lines / 5.2 MB / 4 766 389 characters peaked at ~916 MB heap**, same baseline, i.e.
  **~34 MB of heap per 1 000 lines**, on lines roughly **5× shorter** than the sweep's. That is
  **~4× the sweep's per-line cost**, which is the correction: at the measured rate a 1 GB budget
  buys on the order of **25 000 text-dense lines**, so a line-count guard must be sized from the
  stress point rather than from the sweep. The **DOCX** path closed its half of this in the
  remediation wave: it now enforces a line budget (24 600) **and** a character budget (12 000 000),
  because a single unbounded paragraph defeats a line count
  (`contracts-and-invariants.md` §3d). A PDF line-count guard alongside the byte/page guards is
  still recommended, not required.
- **Workspace-level `dataOrigin` trust.** The per-tender `dataOrigin` field is closed (only
  `'demo'` is representable), but billing/CRM privilege is gated on the **workspace** field,
  which the renderer still writes through `saveStoreV2` and which defaults to the permissive
  `'user'` when unrecognised. A saved demo workspace can therefore still be relabelled
  `'user'` and billed; gating that transition in main is a follow-up.

**Accepted by decision (no further work):**

- **Unsigned distribution.** The app ships **unsigned** — the user has chosen not to sign.
  Signing is **suite-wide, not Tenders-specific**: Tenders ships as a module inside the
  single `com.zanostack.app` product (`apps/shell/electron-builder.cjs`,
  `extraResources → modules/tenders`), so there is no separate Tenders artifact to sign. A
  signed release would also cover the bundled native sidecar (`xlsx-sidecar.exe`).
- **OCR-Beta (in-app OCR)** remains deferred; image-only pages are detected and block
  readiness until the optional AI pass reads them or a person marks them reviewed, and the
  product copy says so.

**Known environmental (non-product) notes:** a terminal Playwright worker-teardown timeout
can yield a non-zero E2E exit after all tests pass, and `apps/shell` has a pre-existing,
unrelated `tests/cloud-projects.test.ts` failure.

## Gating decision (used for the remainder of Phase 2 and Phases 3–5)

**Lighter gate** was chosen by the user:

- One reviewer per increment — code **or** security, whichever is relevant — not both.
- Oracle review only at each phase gate, not after every increment.
- Batch findings into a single remediation pass; avoid fix → review → fix → review loops.
- Keep TDD (RED before GREEN) and phase-end verification.
- Keep the full suite, typecheck, Tenders+Shell builds, formatter and theme guard at phase end.

## How to resume in a new session

Paste something like:

> The Tenders 9/10 hardening (Phases 1–5) is complete — every phase passed its Oracle gate
> (`ora-1`). Read `docs/tenders-hardening/README.md` and `contracts-and-invariants.md` before
> making changes; remaining release work is tracked under "Release status and accepted
> limitations" above, and the phase files (`phase-2-remaining.md` … `phase-5-product.md`)
> record what each phase did.

## Commands

```powershell
# from genoffice/

# focused tests (fast inner loop)
npm run test -w @genoffice/tenders -- tests/<file>.test.ts

# full Tenders suite
npm test -w @genoffice/tenders

# typecheck
npm run typecheck -w @genoffice/tenders

# builds — REQUIRED after any main-process change (Tenders main is bundled into the shell)
npm run build -w @genoffice/tenders
npm run build -w @genoffice/shell

# repo guards
npm run check:theme-colors
npm run format
npm run format:check

# built-Electron E2E (builds required first)
npm run test:e2e
```

### Known environment gotchas

- **Main-process code for apps is compiled into the Shell build.** Changing
  `apps/tenders/src/main/**`, `src/preload/**`, or `src/shared/**` requires rebuilding
  **and** launching the shell, or the change silently does not run.
- A **stale preload** leaves the renderer blank; rebuild preload after editing it.
- Root-level `npm test` has pre-existing failures recorded in `fork/BASELINE.md`
  (`npm run check:baseline` fails only on failures the baseline does not list, so read that
  instead of a raw failure count); root `npm run typecheck` is clean across all 28
  workspaces. **`fork/BASELINE.md` is currently stale** — it was recorded before the Tenders
  hardening and the file's own note says so (`fork/RUNBOOK.md`); another agent owns it.
  Prefer the Tenders workspace commands above for a fast inner loop.
- Shell: PowerShell 5.1 — no `&&`; use `;` or `if ($?) { ... }`.
- Theming rule: renderer CSS must not introduce raw `#hex`/`rgb()` chrome colors; CI
  enforces `tools/check-theme-colors.mjs`.
- Unrelated dirty baseline left untouched: `apps/crm/src/renderer/src/styles/crm.css`
  (modified) and `.ignore` (untracked).

## Uncommitted change set (as of this documentation pass)

The Phase 1–5 work is **committed** as `ff822c0` (`feat(tenders): harden app to
production-ready across phases 1-5`), with the fork/e2e commits `284c312`…`5711775` on top of
it, the five-wave hardening fix set as `a22b5e6`, the AI wave as `c188470`, and the DOCX /
discovery / reminders wave as `7f7067b` — **which is HEAD**. On top of HEAD there is
**uncommitted work in two independent streams**, and a second agent is editing the tree while
this is written, so re-run `git status --porcelain` for the exact list rather than trusting a
count: measured here it was **70 entries — 52 modified, 18 untracked**, of which roughly 28
modified + 15 untracked belong to the concurrent `apps/books` + `.agents` workstream that this
documentation pass must not touch.

The **Tenders remediation** (the stream these docs describe) changes:

- **Tenders main / preload / shared** — `main/tenders-main.ts` (the legacy v1 stack retired:
  no synthesis, no watcher, no writer; `getStoredData` fails closed on an unreadable file; the
  two new diagnostics handlers), `main/document-store.ts`, `preload/index.ts`, `shared/ipc.ts`
  (the two diagnostics channels and their bound constants), `shared/readiness.ts`
  (`DocAtClosing.closingDate` and the civil-day `daysBetween`), `shared/tenders-schema.ts`,
  `shared/tenders-persistence.ts` (the growth-ceiling and per-record-cost wording), and the
  **new** `main/diagnostics-log.ts`.
- **Tenders renderer** — `renderer/src/store.ts` (`hydrationMode`, the `'no-bridge'` save
  status), `renderer/src/components/SaveStatus.tsx` (the `Cannot save` kind),
  `renderer/src/components/TenderList.tsx` (one read of the file buffer per import; the
  advertised import limits), `renderer/src/intake/docx.ts` (`maxTextChars` / `TOO_MUCH_TEXT`),
  `renderer/src/calendar.ts` (civil-day `daysAway`), `renderer/src/ai/extract-with-ai.ts` and
  `renderer/src/ai/transport.ts` (the run budget and the failure-class messages), and the
  **new** `renderer/src/diagnostics.ts`.
- **Tests** — a dozen-plus modified Tenders unit files (the count moves as agents edit) plus the
  **new** `tests/diagnostics.test.ts`,
  `tests/components/*.test.tsx` and `tests/helpers/render.tsx` (the `.tsx` specs are new to
  `vitest.config.ts`). The AI / DOCX / discovery / reminders waves (committed at `c188470` and
  `7f7067b`) added these unit files —
  `tests/ai-extraction.test.ts`, `tests/ai-honesty-copy.test.ts`, `tests/ocr-honesty-copy.test.ts`,
  `tests/discovery.test.ts`, `tests/discovery-client.test.ts`, `tests/discovery-pane.test.ts`,
  `tests/docx-intake.test.ts`, `tests/docx-intake-copy.test.ts`, `tests/reminders.test.ts`,
  `tests/reminders-scheduler.test.ts`, `tests/reminders-settings-copy.test.ts` — **and three e2e
  specs** (`e2e/tenders-ai-extraction.spec.ts`, `e2e/tenders-docx-intake.spec.ts`,
  `e2e/tenders-discovery.spec.ts` with `e2e/tenders-discovery-fixtures.ts`).
- **Docs** — this folder (`README.md`, `contracts-and-invariants.md`, `phase-2-remaining.md`,
  `phase-5-product.md`) plus `fork/COMPLIANCE.md`, `fork/RUNBOOK.md`.
- **Unrelated dirty baseline left untouched** — `apps/crm/src/renderer/src/styles/crm.css`
  (modified), `.ignore` (untracked), and the whole `apps/books` + `.agents/books_hardening/`
  workstream.

Do not commit unless the user explicitly asks. `fork/BASELINE.md` must be re-recorded before
the next sync — see `fork/RUNBOOK.md`.

## Product-boundary reminder

Local-first, single-user, desktop. Do **not** build: multi-user/auth/cloud sync,
automated email/portal submission, tender-marketplace scraping, generic CRM features,
AI-authored methodology, broad international rule packs, mobile/web SaaS, or an
automatic legal-advice engine. Tenders is a high-confidence tender **control** system,
not a compliance authority.

**Amended — optional AI extraction is permitted (owner's decision), and tender discovery reads a
public government feed.** The earlier "the document never leaves the machine" position was relaxed
deliberately, to raise extraction accuracy and to read scanned (image-only) pages: the user may
configure a model provider and let it read the tender. **Tenders now reaches two external sources
by design** — the model provider the user configures, and National Treasury's public eTenders
OCDS feed (PDDL 1.0), read by the discovery pane. Both are recorded here rather than left to be
discovered as an accident (see `fork/COMPLIANCE.md`).

- **The local rule engine stays the offline default.** AI is optional and additive: with no API
  key, or no network, the app behaves exactly as it did before the feature existed. Discovery is
  optional in exactly the same way: nothing is fetched until the user opens the Discover pane, the
  saved list is readable from disk with no network at all, and **deadline reminders are computed
  entirely on this machine** (`contracts-and-invariants.md` §3c) — they are not an online feature
  and do not become one.
- **Nothing AI produces is ever confirmed**, and neither is anything the feed produced. Every value
  a model returns is an unconfirmed suggestion carrying `suggestedBy: 'ai'`, and no AI output may
  write `confirmed`. A discovered opportunity carries `provenance: 'discovery-feed'` and imports
  with every field `unconfirmed` like any other machine-sourced value. A page a model read stops
  blocking readiness while everything lifted from it still needs a human decision —
  `contracts-and-invariants.md` §5a, §3b.
- **Still forbidden, and why neither of these is it.** Tender-marketplace **scraping** and
  portal/email submission stay out. AI extraction reads a document the **user already has** and
  only lifts values for that user to confirm. Discovery reads one **named, licensed, public
  government open-data feed** under the same policy, from main, with an allow-list — it does not
  crawl a commercial marketplace, it does not mirror documents, it never acts as the user, and it
  never submits anything. Neither feature fetches a tender from a marketplace. AI-authored
  methodology stays out too: the pass extracts what the document says, it does not write the bid.
- The feed's limits are a product fact, not a footnote: Treasury calls it a **public beta**,
  guarantees no accuracy, forbids critical-decision and legal use, and municipalities and SOEs
  appear only when they volunteer data. `describeCoverage()` shows that verbatim and always.
- The copy rules this obliges are enforced by `apps/tenders/tests/ai-honesty-copy.test.ts`,
  `apps/tenders/tests/ocr-honesty-copy.test.ts` and `apps/tenders/tests/docx-intake-copy.test.ts`.

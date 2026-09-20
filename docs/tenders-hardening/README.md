# Tenders 9/10 Hardening — Handoff Index

Status of the multi-phase effort to raise `apps/tenders` from a functional MVP to a
trustworthy paid local-first desktop tender product. Written so a **new session can
resume without re-discovery**.

- Repo: `C:\Users\brant\OneDrive\Documents\GenOffice\genoffice`
- Branch: `product` (no commits made during this effort)
- Deepwork coordination state: `.slim/deepwork/tenders-9of10.md` (git-local; read it too)
- Original audit artifacts: `C:\Users\brant\AppData\Local\Temp\opencode\tenders-live-audit-Lpyf1l\`
- Full 15-work-package roadmap + release gates: produced by planner `pla-1`, pressure-tested
  by oracle `ora-1`; summarized in the deepwork file.

## Documents in this folder

| File                          | Contents                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `README.md`                   | This index, current status, resume instructions, commands                                         |
| `contracts-and-invariants.md` | Technical reference: v2 schema, store API, IPC channels, limits, invariants that must not regress |
| `phase-2-remaining.md`        | Phase 2 (durability) — COMPLETE; retained as the record of what was done                          |
| `phase-3-intake.md`           | Phase 3 — parser corpus, extraction review, OCR, scale                                            |
| `phase-4-workflows.md`        | Phase 4 — company/customer CRUD, submission/outcome, typed integrations                           |
| `phase-5-product.md`          | Phase 5 — responsive UX, accessibility, theme, IPC hardening, release evidence                    |

## Phase status

| Phase                             | State                                                                                                                                                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Truth (readiness + proposals) | **DONE** — Oracle PASS (`ora-1`)                                                                                                                                                                                                                                                                   |
| 2 — Durability                    | **DONE** — schema, authoritative store, typed IPC bridge, IPC-surface authorization, renderer v2 cutover, live smoke and cutover E2E all built and verified; Oracle gate PASS (`ora-1` re-gate after B1/F1 remediation)                                                                            |
| 3 — Intake                        | **DONE — Oracle gate PASS** — parser improvements, extraction review/correction UI, authoritative intake verification + additive readiness gate, OCR honesty (alpha only; OCR-Beta deferred), import scale/cancellation; synthetic corpus 100% metadata/recall/conflict with **0 false-readiness** |
| 4 — Workflows                     | **DONE — Oracle gate PASS** — first-use separation + company/customer CRUD, submission/outcome lifecycle, typed CRM/Books ports, main-owned readiness binding; E2E 23 tests across 7 specs                                                                                                         |
| 5 — Product                       | **DONE — Oracle gate PASS** — responsive workspace, a11y + light/dark/system theme, WP-14 IPC/export hardening, measured limits, managed-file trash/undo + rotating-backup recovery; E2E 10 specs. Caveats: synthetic-only corpus, OCR-Beta deferred; packaged win build + packaged smoke PASS     |

## Verified current state (do not re-derive)

- Full Tenders suite: **829 passing**, 29 test files (7 gated benchmark tests skipped unless
  `TENDERS_BENCH=1`).
- `npm run typecheck -w @genoffice/tenders`: clean.
- `npm run build -w @genoffice/tenders` and `npm run build -w @genoffice/shell`: pass.
- `npm run check:theme-colors`, `npm run format:check`, `git diff --check`: pass.
- Built-Electron E2E:
  - `e2e/tenders-regression-smoke.spec.ts` — 17/17 flows, `unauthorizedOrInvalidRequest: []`.
  - `e2e/tenders-persistence-cutover.spec.ts` — 7/7 journeys: hydrate→edit→save→restart;
    vault-entity restart; v1 migrate-once→v2; forced save failure + Retry; forced
    `REVISION_CONFLICT` + Reload (no overwrite); localStorage UI-only; and a
    schema-rejected closing-date no-brick regression (with a valid-date control).
  - `e2e/tenders-intake-review.spec.ts` — 5/5 scenarios: mandatory review gate on import;
    correct/reclassify/add/not-stated; readiness blocked then cleared with no false clear;
    a textless scanned page classified OCR-required and blocked until reviewed; review
    state survives restart.
  - `e2e/tenders-first-use-crud.spec.ts` � 2/2: first-use choice, company + customer
    create/edit/archive/restore with required-document definitions across restart.
  - `e2e/tenders-demo-isolation.spec.ts` � 3/3: sample workspace labelled with
    `dataOrigin:'demo'`, never a recovery fallback, cross-app writes gated, and the
    copy-into-own-workspace path persists with no dangling vault references.
  - `e2e/tenders-lifecycle.spec.ts` � 2/2: reasoned transitions, override submission with a
    preserved blocker snapshot (never "cleared"), evidence step, won/lost outcomes with
    milestone gating, all persisting across restart.
  - `e2e/tenders-billing-guard.spec.ts` � 3/3: no billing affordance on a non-won tender;
    a real inline billing attempt surfaces success or a visible error + Retry (never
    silence); main-side typed rejections for non-won and demo workspaces with no writes.
  - Artifacts under `e2e/artifacts/` (`tenders-*-journey-*.json`, `tenders-regression-smoke-*.json`,
    screenshots, videos).
- Phase 3 corpus metrics (`apps/tenders/tests/fixtures/tenders-corpus/metrics.json`):
  critical-metadata accuracy **100%**, critical-requirement recall **100%**, pricing/BOQ
  recall **100%**, conflict detection **100%**, false-positive rate 0.32%, **false-readiness
  0**. The new mandatory-review/OCR gate cannot be bypassed: readiness blocks while any
  readiness-critical field is unconfirmed or any OCR-required page is unreviewed.
- **Known limitation:** the Phase 3 corpus is **synthetic** (code-generated), not
  real/anonymised tender documents. Criterion #1 is met on synthetic data only; real-world
  accuracy still needs user-supplied tenders before any paid-release claim.
- **OCR (alpha only):** pages with no text layer are **detected and classified**
  (`ocr-required` / `ocr-unavailable` / `ocr-failed`); their text is **not extracted**; they
  block readiness until each page is marked manually reviewed. This is exactly what the
  shipping copy says — onboarding, the guided tour, the Tutorials page and the review step
  all state that scanned/image-only pages are not read. `tests/ocr-honesty-copy.test.ts`
  fails if copy claiming scanned pages are read (for example "including scanned pages",
  "via OCR", or "the OCR step handles them automatically") reappears in the renderer.
  **OCR-Beta (real OCR) is deferred** to a later phase/backlog by decision.
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

**Remaining release work (not correctness blockers):**

- **Real/anonymised tender corpus.** Every parser accuracy figure is measured on a synthetic,
  parser-friendly corpus; a licensed/anonymised set of real tenders is required before any
  real-world accuracy claim (Phase 3 criterion #1 is met in form only).
- **Optional line-count guard.** The published byte ceiling is measured (a 91.6 MB
  image-heavy PDF parses in ~0.66 s), but text density drives memory (~0.042 MB heap per
  extracted text line, ~24 600 lines at a 1 GB budget); a line-count guard alongside the
  byte/page guards is recommended, not required.

**Accepted by decision (no further work):**

- **Unsigned distribution.** The app ships **unsigned** — the user has chosen not to sign.
  Signing is **suite-wide, not Tenders-specific**: Tenders ships as a module inside the
  single `com.zanostack.app` product (`apps/shell/electron-builder.cjs`,
  `extraResources → modules/tenders`), so there is no separate Tenders artifact to sign. A
  signed release would also cover the bundled native sidecar (`xlsx-sidecar.exe`).
- **OCR-Beta (real OCR)** remains deferred; image-only pages are detected and block
  readiness until manually reviewed, and the product copy says so.

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
- Root-level `npm test` / `npm run typecheck` are **blocked by unrelated workspaces**
  (`@genoffice/docx-engine` deep-table timeout; `@genoffice/html2docx` needs Chrome).
  Use the Tenders workspace commands above.
- Shell: PowerShell 5.1 — no `&&`; use `;` or `if ($?) { ... }`.
- Theming rule: renderer CSS must not introduce raw `#hex`/`rgb()` chrome colors; CI
  enforces `tools/check-theme-colors.mjs`.
- Unrelated dirty baseline left untouched: `apps/crm/src/renderer/src/styles/crm.css`
  (modified) and `.ignore` (untracked).

## Uncommitted change set (as of this handoff)

Modified (tracked):
`apps/crm/src/renderer/src/styles/crm.css` (unrelated pre-existing baseline),
`apps/tenders/src/main/tenders-main.ts`,
`apps/tenders/src/preload/index.ts`,
`apps/tenders/src/renderer/src/components/App.tsx`,
`apps/tenders/src/renderer/src/components/Workspace.tsx`,
`apps/tenders/src/renderer/src/components/pages/TutorialsPage.tsx`,
`apps/tenders/src/renderer/src/pdf/extract.ts`,
`apps/tenders/src/renderer/src/readiness.ts`,
`apps/tenders/src/renderer/src/store.ts`,
`apps/tenders/src/shared/ipc.ts`,
`apps/tenders/src/shared/rules.ts`,
`apps/tenders/src/shared/types.ts`,
`apps/tenders/tests/ipc-handlers.test.ts`,
`apps/tenders/tests/store-migrations.test.ts`

New (untracked):
`apps/tenders/src/main/proposal-generator.ts`,
`apps/tenders/src/main/tenders-store.ts`,
`apps/tenders/src/renderer/src/components/FirstRunEmpty.tsx`,
`apps/tenders/src/renderer/src/components/SaveStatus.tsx`,
`apps/tenders/src/shared/readiness.ts`,
`apps/tenders/src/shared/tenders-persistence.ts`,
`apps/tenders/src/shared/tenders-schema.ts`,
`apps/tenders/tests/pdf-box-bounds.test.ts`,
`apps/tenders/tests/proposal-truth.test.ts`,
`apps/tenders/tests/readiness-invariants.test.ts`,
`apps/tenders/tests/renderer-store-v2.test.ts`,
`apps/tenders/tests/tenders-persistence-bounds.test.ts`,
`apps/tenders/tests/tenders-store.test.ts`,
`e2e/tenders-persistence-cutover.spec.ts`,
`e2e/tenders-regression-smoke.spec.ts`,
`docs/tenders-hardening/`, `.ignore`, and `.agents/*` orchestration dirs.

No commits were created. Do not commit unless the user explicitly asks.

## Product-boundary reminder

Local-first, single-user, desktop. Do **not** build: multi-user/auth/cloud sync,
automated email/portal submission, tender-marketplace scraping, generic CRM features,
AI-authored methodology, broad international rule packs, mobile/web SaaS, or an
automatic legal-advice engine. Tenders is a high-confidence tender **control** system,
not a compliance authority.

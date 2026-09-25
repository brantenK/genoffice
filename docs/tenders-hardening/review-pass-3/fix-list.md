# Review Pass 3 — Fix List (confirmed findings, exclusive file ownership)

Every finding here is `confirmed` in `findings.md` with its reproduction. One fix agent per group; **no two groups share a file**. Fix protocol (mandatory for every agent):

1. **Reproduce first** — run the reproduction from `findings.md` on the clean tree. If it does not reproduce, the finding is refuted: record it, do not fix.
2. **Write the failing test** that pins the verified defect (project has tests — follow the file's existing style).
3. Run it, confirm it fails for the right reason.
4. Implement the minimal fix.
5. Run the test + the owned files' tests, confirm green.
6. Mutation-check where the finding is about a guard: delete the pinned behaviour, confirm the guard now fails.
7. **Commit staged explicitly** — never `git add -A`. The Books workstream's ~45 uncommitted files under `apps/books/` must not be touched, staged, formatted, or typechecked-fixed. Commit message: `fix(tenders): <finding IDs> — <one line each>; refuted: <none|what>`.
8. Do not run the repo-wide `npm run typecheck` (28 workspaces; the Books lane may fail — that is theirs) — run the tenders-only check (`npx tsc --noEmit` from `apps/tenders`). Do not run the full e2e.

## Group A — diagnostics sink (F2 + F4)

**Files (exclusive):** `apps/tenders/src/main/diagnostics-log.ts`, `apps/tenders/src/main/ipc/handlers-diagnostics.ts`, `apps/tenders/tests/diagnostics.test.ts`

- **F2:** sanitize `source` (and `level`) exactly like `message`/`detail` in `formatDiagnosticsLine` so one entry is always one line; and/or refuse line separators at the IPC boundary (`handlers-diagnostics.ts`). Pin: a `source` containing `\n` and U+2028/U+2029 produces exactly one line with no raw separators (extend the existing "cannot be made to forge a line" test).
- **F4:** route `rotate()` through the shared `renameWithBoundedRetry*` helper (`tenders-paths.ts`) so a transient EBUSY no longer permanently disables rotation. Pin: injected EBUSY on rotation no longer sets the permanent-disabled state; the file stays bounded.

## Group B — open refusal trailing-dot bypass (F1)

**Files (exclusive):** `apps/tenders/src/main/document-lifecycle.ts`, `apps/tenders/tests/ipc-handlers.test.ts`

- **F1:** close the trailing-dot bypass in the open path — a name like `evil.docm.` must be refused (treat `extname` result `.` as unopenable when the pre-dot stem carries a refused extension, or normalize before the check). Do not make the refusal blanket: a macro-free document (`.docx`) with a trailing dot may still be a legitimate name decision — but it must not silently open a macro container. Pin: `evil.docm.` and `evil.lnk.` refused with macro/launcher-honest copy; `.docx` (and `.docx.`) still opens; normal `.docm` still refused.

## Group C — restore always-renames (F3)

**Files (exclusive):** `apps/tenders/src/main/document-store.ts` + the covering test file for `restore` (locate it; likely `apps/tenders/tests/document-durability-ipc.test.ts` or a store test — do not edit any other file)

- **F3:** make `restore` return a document to its original `relativePath` when that spot is safe (not a link, not occupied), and mint a fresh name only when it is unsafe/occupied. The inverted guard (`isRealPathInside` always-true) must become the intended condition. Pin: save → trash → restore yields the original `relativePath` when the spot is free; a name collision or planted link at the spot still yields a fresh name (recovery preserved).

## Group D — legacy enum validation (F5)

**Files (exclusive):** `apps/tenders/src/main/legacy-store.ts`, `apps/tenders/tests/store-migrations.test.ts`

- **F5:** enforce the typed unions for `category`/`riskLevel` in `parseLegacyRequirement` — refuse (whole-tender, loudly, consistent with the unreadable-requirement path) or normalize per the schema's own posture. Follow the file's existing fail-closed idiom. Pin: a v1 file with `category: 123` / `riskLevel: {bogus:true}` is refused or normalized — never shipped raw; valid string values pass through unchanged.

## Group E — test-isolation leak (F6)

**Files (exclusive):** `apps/tenders/tests/renderer-store-v2.test.ts`

- **F6:** find the deferred-save continuation that survives the per-test boundary (`vi.resetModules()` + fresh `window.tendersApi`) and make the isolation deterministic — e.g., flush/clear the debounce timer before the boundary, or assert no pending save survives. Do not weaken the `not.toHaveBeenCalled()` assertions (they are correct); close the seam instead. Verification: the file passes in isolation; run it 6+ times and once shuffled (`--sequence.shuffle --sequence.seed=<n>`) with zero failures; explain in the commit message what the seam was.

## Group F — dialog-over-drawer overlay collision (F7)

**Files (exclusive):** `apps/tenders/src/renderer/src/components/Dialog.tsx`, `Drawer.tsx`, `MilestonesDrawer.tsx`, `TrashDrawer.tsx` + component tests under `apps/tenders/tests/components/` (create/extend one)

- **F7:** **reproduce with the real components first** (the finding's repro was a listener-code model): render `TrashDrawer` (and `MilestonesDrawer`) through `apps/tenders/tests/helpers/render.tsx` with the confirm dialog open and assert the current broken behaviour (Escape closes both; Tab cannot reach the confirm button). If the real components do not exhibit the defect, record refuted and do not fix. Then fix: the drawer's window-capture trap must not capture keys while a modal dialog is open (e.g., a modal-open signal the dialog sets, or the drawer's trap bailing when `[aria-modal="true"]` is present). Assert after fix: Escape closes only the dialog; forward Tab reaches the confirm action; the drawer's view state survives Escape on the dialog.

## Group G — documentation sweep (F8)

**Files (exclusive):** `apps/tenders/src/main/ipc/trust.ts`, `apps/tenders/src/main/tenders-main.ts`, `apps/tenders/src/shared/ipc.ts`, `apps/tenders/src/main/ipc/handlers.ts`, `apps/tenders/src/main/ipc/handlers-store.ts`, `apps/tenders/src/renderer/src/store.ts`, `docs/tenders-hardening/README.md` + `docs/tenders-hardening/contracts-and-invariants.md` + `docs/tenders-hardening/module-map.md`

- **F8:** fix all seven items from `findings.md` F8 — the `trust.ts` header (point at the seven `handlers-*.ts` modules, not the 0-registration root), the `tenders-main.ts` map (name the domain modules; source the 33 figure from the per-module count), the `shared/ipc.ts` pointer, the `handlers.ts` 33-vs-36 wording (declare 36 = 33 handle + 3 push-only), the `handlers-store.ts` "five" header, the `store.ts` 3.0 MB citations (name the real fixture: `tests/tenders-persistence-bounds.test.ts` builds 4 MiB; the 3.79 MB measured fixture lives in `tests/renderer-store-v2.test.ts`), and add the HEAD perf work (DOCX yield seams, save-cost derivation, 12M-char freeze) to the hardening docs. Comments/doc text only — no behavior change; no test edits.

---

**Known out-of-scope (recorded, never fixed by this wave):** the accuracy-claim ceiling (Correctness — owner data decision); the shell-wide sender check for other apps' handlers (Security — `apps/crm`/shell, different codebase); the 12M-char-paragraph freeze and the DOCX parse seam (product decisions, mechanism verified in `findings.md`).

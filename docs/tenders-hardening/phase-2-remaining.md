# Phase 2 — Durability (remaining work)

> **STATUS: COMPLETE — Oracle gate PASS (`ora-1` re-gate).** Tasks 2A/2B/2C below are
> done. On top of the cutover, a reviewer integrity finding, a shredder v2
> schema-validity defect, and the B1 `closingDate` bricking defect were remediated;
> `e2e/tenders-persistence-cutover.spec.ts` covers the cutover journeys and
> `e2e/tenders-regression-smoke.spec.ts` was rewritten to cutover semantics. This file
> is retained as the record of what was done; the next phase is `phase-3-intake.md`.

Phase 2 built the persistence foundation and it passed code + security review. What
remains is the **cutover** (making the renderer actually use it) plus a live check and
the phase gate. Two durability items are deliberately deferred.

Read `contracts-and-invariants.md` first.

## Phase 2 exit criteria (revised)

1. The **built app still works live** under the hardened IPC (regression smoke).
2. The **renderer persists through the authoritative v2 store** (`loadStoreV2` /
   `saveStoreV2` / `onStoreChangedV2`), with visible save/conflict/retry state, and does
   not treat localStorage as a second source of truth.
3. Full Tenders suite, typecheck, Tenders + Shell builds, formatter, theme guard: clean.
4. Oracle gate PASS.

## Task 2A — Live regression smoke (was cancelled)

Why: F1–F4 made **all 14 privileged handlers** require a registered Tenders WebContents
with a trusted top-frame origin. If origin matching is wrong, the live renderer breaks
before the cutover even starts.

Steps (isolated scratch `userData` under `%LOCALAPPDATA%\Temp\opencode`, never the real
profile; close only owned Electron processes; delete the temp runner):

1. Launch the built shell, open Tenders. Confirm data loads (not blank).
2. Exercise gated handlers through real UI: change a requirement status; upload + save a
   vault document; export the compliance matrix; generate Draft Docs; CRM sync if available.
   Each must succeed with no `Unauthorized` / `INVALID_REQUEST` trust errors.
3. Restart the same scratch profile; confirm changes persisted.
4. Confirm blocked readiness + unverified-draft proposal still hold.
5. Capture screenshots + result JSON.

If origin matching fails, report expected-vs-actual `senderFrame.url` and the missing
frame fields. Do not patch source during a smoke.

## Task 2B — Renderer v2 cutover

This is the substantive remaining Phase 2 work. It is user-visible, so route the
save-state/conflict **UI** through `@designer`, and keep mechanical wiring with `@fixer`.

Primary files:

- `apps/tenders/src/renderer/src/store.ts` — currently Zustand persisted to localStorage;
  must become a cache over the authoritative snapshot.
- `apps/tenders/src/renderer/src/components/App.tsx` — hydrate from `loadStoreV2`.
- New save-state component (e.g. `components/SaveStatus.tsx`).
- Any component that calls `saveStoredData` / `getStoredData` today.

Required behaviour:

1. **Hydrate** from `loadStoreV2()`:
   - `not-found` ⇒ show the empty workspace (no demo seeding).
   - `migrated` (`needsSave: true`) ⇒ render migrated data and commit once via
     `saveStoreV2` with `expectedRevision: 0`.
   - `loaded` ⇒ use as-is.
   - failure (`READ_FAILED` / `UNSUPPORTED_SCHEMA_VERSION`) ⇒ explicit recovery/error
     state, never silent seeding or an empty-overwrite.
2. **Persist** every mutation via `saveStoreV2({ expectedRevision, document })`; update
   local state only from the returned committed snapshot.
3. **Save state UI**: Loading / Saving / Saved / Save failed (Retry) / Conflict. On
   `REVISION_CONFLICT`, surface the conflict (reload the committed document or prompt),
   never blind-overwrite.
4. **Subscribe** to `onStoreChangedV2` to stay in sync if another window writes.
5. **Remove localStorage domain authority**: keep only UI preferences (current page, pane
   width/mode, zoom, onboarding-seen) under a UI-only key. Do not store workspaces,
   tenders, customers, or vault records in localStorage.
6. Stop using the legacy `getStoredData` / `saveStoredData` channels once cut over. Keep
   them in main only as a transitional guard (they already reject `schemaVersion >= 2`).
7. Debounce/queue saves sensibly; never fire concurrent saves with the same
   `expectedRevision` (the store serialises, but the UI should still avoid churn).

Acceptance:

- Fresh profile: create a tender/requirement change, restart, change survives; a real
  v1 file migrates once and stays v2.
- Forced save failure shows Save failed + Retry, keeps unsaved changes, and does not
  claim success.
- Forced `REVISION_CONFLICT` shows the conflict state and does not overwrite.
- No domain data written to localStorage.
- Built-Electron E2E covers: hydrate → edit → save → restart → verify; failed-save retry;
  conflict path.

Tests: extend `apps/tenders/tests/` (store/renderer-adjacent) plus an `e2e/tenders-*.spec.ts`
journey. Prefer assertions on observable store/file state and UI state.

Risks:

- React StrictMode double-invocation / effect races causing duplicate migration commits —
  guard the initial `needsSave` commit.
- Stale closures writing old revisions — always send the latest committed revision.
- Losing unsaved edits on unmount — keep pending state until the save is acknowledged.

## Task 2C — Phase 2 Oracle gate

Run `@oracle` once, at the end, with: the revised exit criteria, the 588+ test evidence,
typecheck/build/formatter/theme results, the live smoke artifacts, and the renderer
cutover diff. Ask specifically: is v2 now the single authoritative store from the
renderer's perspective, and is anything left that could silently lose or overwrite user
data?

## Deferred out of Phase 2 (execute before paid release, not now)

These were originally in the Phase 2 durability scope. They are separable and were
deferred to prioritise speed.

1. **Rotating backups + explicit recovery UI** (planner WP-2 remainder)
   - Rotating last-known-good copies of `tenders-data.json`; a recovery screen listing
     `TendersRecoveryCandidate`s; explicit user restore. Never auto-substitute
     demo/empty/backup as authoritative.
   - Files: `main/tenders-store.ts` (or new `main/recovery.ts`), `main/tenders-main.ts`
     (new channels), renderer recovery screen, `shared/tenders-persistence.ts` DTOs
     (already declared: `TendersRecoveryCandidate`, `RECOVERY_REQUIRED`).
2. **Managed-file lifecycle** (planner WP-9)
   - Managed-file metadata (id, relative path, size, MIME, hash, timestamps, missing
     state); soft-delete to a Tenders trash dir; undo across restart; startup
     reconciliation for missing/orphaned files; link-aware delete warnings; replacing a
     file moves the old one to trash after the new commit. This is also where
     `DocumentsPage`'s metadata-only delete (orphan file) and the session-blob fallback
     get fixed.
   - Files: new `main/document-store.ts`, `shared/ipc.ts`, renderer
     `pages/DocumentsPage.tsx`, `components/TenderList.tsx`, a `TrashDrawer`.
3. **Main-owned readiness snapshot binding**
   - Bind proposal generation to a canonical readiness snapshot built in main from the
     authoritative tender/company/vault (closing the "renderer cannot prove readiness"
     gap and enabling a truthful positive `READY` path). Must include tender id/revision
     fingerprint so a report cannot be applied to the wrong or stale tender.
   - Files: `main/tenders-main.ts` (load canonical data, build report),
     `main/proposal-generator.ts` (already accepts `readinessReport`), tests.
4. **Non-blocking follow-ups listed in `contracts-and-invariants.md` §6** (billing
   reservation, CRM partial application, test-reset safety, fail-open trust, compact
   conflict payload, store path param, packaged URL equality, document buffer bound,
   navigation deny-by-default).

## Ownership map (cutover)

| Lane                     | Write scope                                       |
| ------------------------ | ------------------------------------------------- |
| Store/renderer state     | `renderer/src/store.ts`, `components/App.tsx`     |
| Save-state UI (designer) | new `components/SaveStatus.tsx`, workspace chrome |
| Tests                    | `apps/tenders/tests/**`, `e2e/tenders-*.spec.ts`  |

`tenders-main.ts`, `store.ts`, `App.tsx`, `shared/ipc.ts` are integration hotspots — one
writer at a time.

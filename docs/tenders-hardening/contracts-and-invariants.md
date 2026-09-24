# Tenders — Contracts and Invariants (Phase 1–2 foundation)

Technical reference for the machinery already built. Treat everything here as
**must not regress** unless a phase explicitly changes it.

## 1. Persistence schema (v2)

Files:

- `apps/tenders/src/shared/tenders-schema.ts` — pure validation + migration
- `apps/tenders/src/shared/tenders-persistence.ts` — DTOs + limits
- `apps/tenders/src/shared/types.ts` — additive `TendersDataV1` / `TendersDataV2` / `TendersWorkspaceV2`
- `apps/tenders/src/shared/money.ts` — the single rand parser/formatter (`parseMoney`,
  `parseMoneyDetailed`, `extractMoneyLiterals`, `formatRandAmount`, `safeMoneyLocale`),
  shared by the proposal generator, the extraction review and the outcome dialog

Shape:

```ts
TENDERS_SCHEMA_VERSION = 2
TendersDataV2 {
  schemaVersion: 2
  revision: number                 // non-negative safe integer
  updatedAt: string                // RFC 3339
  activeCompanyId: string | null   // null iff workspaces is empty
  workspaces: TendersWorkspaceV2[] // extends CompanyWorkspace + dataOrigin
  issuerTemplates: IssuerTemplate[]
}
TendersWorkspaceV2 { ...CompanyWorkspace, dataOrigin: 'user' | 'demo' }
```

Pure API:

- `validateTendersDataV2(raw)`
- `migrateTendersDataV1(raw, { migratedAt })`
- `migrateTendersData(raw, { migratedAt })`
- `createEmptyTendersDataV2(now)`

Invariants enforced:

- Unknown fields **rejected** (except dynamic maps `VaultDoc.metadata`, `signatureChecks`).
- Invalid nested record rejects the **whole document** — never partial/dropped records.
- Empty stays empty. No demo/customer/vault/tender synthesis.
- Future versions rejected (`UNSUPPORTED_SCHEMA_VERSION`); non-integer versions rejected.
- Unique IDs per collection; `activeCompanyId` invariant; unique non-null tender references.
- Vault references must be **exact `VaultDoc.id`** in v2. v1 may rewrite unique legacy
  filename/path/stem aliases to canonical IDs with a `LEGACY_VAULT_REFERENCE_REWRITTEN`
  warning; ambiguous/unmatched aliases reject.
- Numeric ranges: safe non-negative counts; requirement page within tender range;
  `ocrPages <= numPages`; confidence and bounding boxes normalised 0..1; non-negative money.
- Dates: strict. RFC 3339 for `createdAt`/`lastSeen`/`billedAt`; civil or RFC 3339 where
  the domain allows; impossible/malformed values reject. `closingDate` validated only
  through the shared `parseClosingDate` (which accepts strict RFC 3339 and the supported
  human formats).
- Demo identity: only an **exact canonical full-content match** of a frozen historical
  snapshot is `demo`. Any edit ⇒ `user`. Never classify by ID alone. **Exception:** the
  additive persisted `TenderRecord.dataOrigin?: 'demo'` label (`shared/types.ts`,
  `TENDER_DATA_ORIGINS` in `tenders-schema.ts`), written by the Load-demo-RFP path and
  carried by copy-into-own-workspace. It is deliberately narrower than the workspace field —
  `'demo'` is the only representable value and `'user'` is rejected outright, so absent means
  "the user's own import" and the label can never _promote_ a record. Privilege (billing,
  CRM sync) stays gated on the **workspace-level** `dataOrigin`, which this field cannot
  influence.
- Prototype-named dynamic keys (`__proto__`, `constructor`, `prototype`) preserved exactly.
- Idempotent, non-mutating, deep-cloned outputs.

Limits (exported from `tenders-persistence.ts`):

| Constant                                         | Value                                    |
| ------------------------------------------------ | ---------------------------------------- |
| `MAX_TENDERS_STORE_FILE_BYTES`                   | 8 MiB                                    |
| `MAX_TENDERS_DOCUMENT_BYTES`                     | 4 MiB                                    |
| `MAX_TENDERS_IPC_PAYLOAD_BYTES`                  | 5 MiB                                    |
| `MAX_TENDERS_MANAGED_INDEX_BYTES`                | 4 MiB                                    |
| `MAX_TENDERS_MANAGED_FILE_NAME_CHARS`            | 80                                       |
| `MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD`     | 832                                      |
| `MAX_TENDERS_MANAGED_FILES`                      | 5000                                     |
| `MAX_TENDERS_TRASH_ENTRIES`                      | 5000                                     |
| `MAX_TENDERS_BACKUPS`                            | 5                                        |
| `MAX_TENDERS_RECOVERY_CANDIDATES`                | 64                                       |
| `MAX_TENDERS_WORKSPACES`                         | 100                                      |
| `MAX_TENDERS_CUSTOMERS_PER_WORKSPACE`            | 10000                                    |
| `MAX_TENDERS_VAULT_DOCS_PER_WORKSPACE`           | 10000                                    |
| `MAX_TENDERS_TENDERS_PER_WORKSPACE`              | 5000                                     |
| `MAX_TENDERS_REQUIREMENTS_PER_TENDER`            | 5000                                     |
| `MAX_TENDERS_MILESTONES_PER_TENDER`              | 5000                                     |
| `MAX_TENDERS_ISSUER_TEMPLATES`                   | 1000                                     |
| `MAX_TENDERS_REQUIRED_DOCS_PER_CUSTOMER`         | 1000                                     |
| `MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT` | 1000                                     |
| `MAX_TENDERS_SINGLE_STRING_CHARS`                | 32768                                    |
| `MAX_TENDERS_AGGREGATE_STRING_CHARS`             | 4194304 (= `MAX_TENDERS_DOCUMENT_BYTES`) |
| `MAX_TENDERS_DYNAMIC_ENTRIES`                    | 2000                                     |
| `MAX_TENDERS_DYNAMIC_KEY_CHARS`                  | 256                                      |
| `MAX_TENDERS_SCHEMA_ISSUES`                      | 500                                      |
| `MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD`        | 16                                       |
| `MAX_TENDERS_REVIEW_REQUIREMENTS`                | 5000                                     |
| `MAX_TENDERS_REVIEW_CONFLICTS`                   | 128                                      |
| `MAX_TENDERS_PAGE_STATES`                        | 5000                                     |
| `MAX_TENDERS_LIFECYCLE_HISTORY`                  | 500                                      |
| `MAX_TENDERS_READINESS_BLOCKERS`                 | 64                                       |

`MAX_TENDERS_DOCUMENT_BYTES`, `MAX_TENDERS_IPC_PAYLOAD_BYTES` and
`MAX_TENDERS_AGGREGATE_STRING_CHARS` were raised together, and they are **one** fix. A fully
reviewed tender (requirement cap + page-state cap + 16 candidates for each of the eight
readiness-critical fields) serialises to 2.89 MiB, so the old 1.5 MiB document ceiling made it
unsaveable and wedged the workspace. `MAX_TENDERS_DOCUMENT_BYTES` is the one **actionable**
bound:
`MAX_TENDERS_IPC_PAYLOAD_BYTES` stays strictly above it so the save-envelope check can never
bind, and `MAX_TENDERS_AGGREGATE_STRING_CHARS` is held equal to it in characters so it can
never bind either (it remains the backstop for the 8 MiB load path and the cycle guard). The
same IPC constant is reused as the **byte** ceiling for the compliance-matrix export payload
(`exportMatrixToSheets`), where it _is_ the binding check; that export's own bounds are the
separate row/cell constants in `shared/ipc.ts` (table below).
`MAX_TENDERS_MANAGED_FILES` was 20 000 while the 4 MiB index ceiling admitted only ~11 500
records — the advertised capacity was unreachable, and a full index refused the user _below_
it with a limit they could not count or plan for. `MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD`
(832 bytes) is the _measured_ worst-case serialized cost of one record at
`MAX_TENDERS_MANAGED_FILE_NAME_CHARS` (80 characters), and that clamp is what keeps the
record-count caps binding before the byte ceiling for every record the store writes.

Also exported from `shared/ipc.ts`:

| Constant                               | Value  |
| -------------------------------------- | ------ |
| `MAX_TENDERS_DOCUMENT_UPLOAD_BYTES`    | 25 MiB |
| `MAX_TENDERS_MATRIX_EXPORT_ROWS`       | 5000   |
| `MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS` | 32768  |

### 1a. Intake verification (Phase 3 — additive on schema v2)

`TenderRecord.intakeVerification?` is an **optional, additive** field on schema v2 (no
version bump; a document without it still validates exactly as before). It holds the
extraction-review state: per readiness-critical field a state plus the chosen value and the
original extracted candidate(s) (provenance), requirement-review annotations, and per-page
extraction state (`native | ocr-required | ocr-unavailable | ocr-failed | manually-reviewed`).

`TenderRecord.dataOrigin?: 'demo'` is a **second** additive optional field on the same terms
(no version bump; absent still validates) — see the demo-identity exception in §1. Only
`'demo'` is representable, so it can label demonstration data but never claim user
provenance.

`assessReadiness` blocks additively on (a) unconfirmed readiness-critical fields / unresolved
competing candidates and (b) un-readable pages that are not proven reviewed. Both checks carry
score weight **0**.

- The `intake-review` check is added **only when `intakeVerification` is present**.
- The `page-extraction` check is **fail-closed**: it is added when `intakeVerification`
  exists **or** when the authoritative `TenderRecord.ocrPages > 0` is not covered by an
  individual `manually-reviewed` page state (`unprovenOcrPageCount(tender) > 0`). This closes
  the v1→v2 migration false-clear: a migrated tender with unreadable pages and no page state
  is blocked (fail-closed) until each page is reviewed. With `ocrPages === 0`/absent and no
  review, no page check is added and readiness is byte-identical to pre-Phase-3.

Review and page state are authoritative (persisted through the v2 store); the legacy
`zanostack-tenders-review-v1` localStorage key is purged and never written.

## 2. Authoritative store

File: `apps/tenders/src/main/tenders-store.ts`

```ts
createTendersStore({ directory, now?, onCommitted? }) → {
  load(): Promise<TendersLoadResult>
  save(request: SaveTendersRequest): Promise<SaveTendersResult>
  mutate(expectedRevision, mutator): Promise<SaveTendersResult>
}
```

Guarantees:

- Storage path is exactly `<directory>/tenders-data.json`; directory created only on commit.
- `load` states: `not-found` (empty v2 rev 0, no file, no demo) / `loaded` / `migrated`
  (`needsSave: true`, source file untouched); malformed ⇒ `READ_FAILED`; future ⇒
  `UNSUPPORTED_SCHEMA_VERSION`.
- `save` requires `expectedRevision === document.revision === current on disk`; stale ⇒
  `REVISION_CONFLICT` with current snapshot and **no write**.
- Main owns `revision + 1` and the timestamp; returns the exact committed snapshot.
- Atomic: same-directory exclusive temp file, fsync where available, rename, readback,
  temp cleanup; prior file preserved on failure; cleanup failure detail included in
  `WRITE_FAILED`.
- Process-wide queue keyed by resolved path (multiple store instances for one file serialise);
  different directories independent.
- Callbacks/mutators run outside the commit lock (reentrant `load`/`save` safe);
  callback rejection after durable commit ⇒ `ok: true` + `postCommitError`, never `WRITE_FAILED`.
- `mutate` with a value-equal result does **not** bump revision/write/notify.
- Before each commit the previous valid primary is copied to
  `backups/tenders-data.<revision>.json` and rotated down to `MAX_TENDERS_BACKUPS` (5). A
  corrupt primary yields `RECOVERY_REQUIRED` with validated candidates
  (`MAX_TENDERS_RECOVERY_CANDIDATES` = 64) and **never auto-substitutes** one — or an empty
  document — as authoritative. Restore is an explicit user action, confined to the store
  directory, and quarantines the corrupt primary first.
- `save` refuses a document whose **pretty-printed** payload would exceed
  `MAX_TENDERS_STORE_FILE_BYTES`: the file actually written is the same document 2-space
  indented (measured ~2.0x for record-heavy documents, up to 3.57x for arrays of empty
  strings), so the ceiling has to be checked on the file shape, not the compact one. A
  committed file is therefore always one `load` will read back.
- `load` `stat`s and rejects oversize before reading.
- Deep-clone isolation in and out.

## 3. IPC + preload bridge

Files: `apps/tenders/src/shared/ipc.ts`, `apps/tenders/src/preload/index.ts`,
`apps/tenders/src/main/tenders-main.ts`

v2 channels: `tenders:load-store-v2`, `tenders:save-store-v2`, `tenders:store-changed-v2`.
Preload API: `loadStoreV2`, `saveStoreV2`, `onStoreChangedV2` (direct objects, not JSON strings).

Nine channels have since joined them: `tenders:close-flush-request` / `tenders:close-flush-result`
(the shell dirty-close guard, §3a), the managed-document lifecycle
(`tenders:list-document-trash`, `tenders:restore-document`, `tenders:replace-document`,
`tenders:reconcile-documents`, `tenders:cleanup-document-trash`) and rotating-backup recovery
(`tenders:list-recovery-candidates`, `tenders:restore-recovery-candidate`). All nine have
preload pass-throughs (`onCloseFlushRequest`, `reportCloseFlush`, `listDocumentTrash` …
`cleanupDocumentTrash`, `listRecoveryCandidates` / `restoreRecoveryCandidate`), and the
document channels (`saveDocument` / `readDocument` / `openDocument` / `deleteDocument`) are
wired too — validation, trust and path confinement all stay in main.

Authorization (applies to **all 23 privileged handlers**, each calling `isTrustedTendersEvent`
**directly** — there is no central wrapper):

- `isTrustedTendersEvent` requires: sender is a registered active Tenders WebContents,
  `senderFrame.parent === null` (top frame only), and trusted origin matching
  `runtime.rendererUrl` (or packaged `rendererFile` URL); falls back to
  `webContents.getURL()` when frame missing.
- Rejection shape: `{ ok:false, error:{ code:'INVALID_REQUEST', message:/authoriz|trusted|registered/i } }`,
  with no side effects. **Except `draftProposalDoc`**, which returns a bare string `error` with
  no `code` — check for the string, not the envelope, when asserting on that one.
- `isTrustedTendersWebContents` filters broadcast recipients for both `store-changed-v2`
  and legacy `dataChanged`.
- Lifecycle helpers used by tests: `resetTendersIpcForTests()`,
  `isTendersIpcRegisteredForTests()`; `ipcRegistered` set only after full registration.
  `resetTendersIpcForTests()` is **test-only and refuses to run outside a test runner**
  (`VITEST === 'true' || NODE_ENV === 'test'`); when it does run it deletes `documents/`,
  `vault/`, `.trash/`, `backups/` and `managed-documents.json`, so it must never be reachable
  from production code.

Legacy channels (preload-only — no renderer module calls them any more):

- `getStoredData` / `saveStoredData` remain, now authorized.
- `saveStoredData` accepts **only a schema-v2 document** (`validateTendersDataV2`) and commits
  it through the authoritative store at its own revision; v1, `schemaVersion: 3` and
  non-integer versions are all rejected. It can therefore never re-seed demo
  company/vault/tender data into, or overwrite, the user's store.
- `syncWithCrm` and `billMilestoneInBooks` go through the authoritative store `mutate`,
  ignore renderer-supplied `tendersPath` / `crmDealsPath` / `userDataDir` (main resolves
  from `app.getPath('userData')`), accept optional `expectedRevision` (stale ⇒ conflict),
  and return a compact `currentRevision` on conflict.
- Billing idempotency key: `crmDealId = tender-milestone-<tenderId>-<milestoneId>`. The caller
  revision is **checked** via a value-equal `mutate` before posting — a revision check,
  **not a reservation**: `mutate(rev, d => d)` writes nothing and bumps nothing. It does
  guarantee that a stale caller posts zero invoices; a competing writer that moves the
  revision between that check and the link commit is reconciled by one reload-and-retry, and
  the Books idempotency key keeps it to at most one invoice.

### 3a. Shell dirty-close guard (the flush loop)

Files: `apps/shell/src/main/index.ts`, `apps/shell/src/main/tab-manager.ts` (`tendersTabs()`,
the `closeTab` guard), `apps/tenders/src/main/tenders-main.ts` (`requestTendersClose`,
`confirmDiscardingTendersChanges`), `apps/tenders/src/renderer/src/store.ts`.

Tenders autosaves behind a 300 ms debounce, so the shell cannot tell whether an edit is still
only in renderer memory. The guard is therefore the flush itself, and it runs in two places:
`tab-manager.closeTab` for a single tab, and `win.on('close')` for the window — where it walks
every live Tenders tab after the sheets/pdf/markdown/html/slides/docs passes.

- Main sends `tenders:close-flush-request` with a request id and waits up to
  **`CLOSE_FLUSH_TIMEOUT_MS` = 10 s** for `tenders:close-flush-result`.
- The renderer subscribes at module load (not at first hydration, so a window closed during
  start-up is answered rather than timing out), commits whatever is pending, and replies
  `{ requestId, dirty, ok, error }`.
- **Fail-closed on no reply.** A timeout, a throwing `send`, or a renderer that throws while
  flushing resolves to "not proven durable" — the shell shows the "Close Zanostack with
  unsaved Tenders changes?" prompt instead of closing silently, and a dialog that cannot be
  shown keeps the window open.
- A clean view answers immediately and the close proceeds; any "keep open" aborts the whole
  close. Duplicate requests for one view are coalesced, and `resetTendersIpcForTests()` clears
  the pending maps.
- Bounded cost: the loop is sequential, so N wedged Tenders tabs cost up to 10 s × N plus one
  prompt each. Every path settles — nothing hangs.

## 4. Canonical readiness

Files: `apps/tenders/src/shared/readiness.ts`, `apps/tenders/src/shared/rules.ts`
(renderer `src/renderer/src/readiness.ts` is a compatibility re-export).

- `assessReadiness(tender, vault, company, now)` is the single source of truth used by
  cards, drawer, status transitions, and proposal generation.
- `TENDER_RULES` owns `evidenceKind` (`DOCUMENT | SIGNATURE | NONE`) and `validityKind`
  (`EXPIRY_REQUIRED | CERTIFICATION_WINDOW | PERMANENT | NONE`). Evidence/validity
  behaviour is derived from the catalogue, not a second key list.
- Blocking: empty/unaudited matrix; unresolved mandatory requirements; missing, dangling,
  or file-less linked evidence; expiry/certification unknown; missing company details
  demanded by mandatory applicable requirements; invalid/unparseable dates; unchecked
  signatures; unknown or past deadline.
- `NOT_APPLICABLE` resolves only with a dedicated `notApplicableReason` (never the generic
  automated `reason`); a valid N/A skips evidence and company checks.
- `parseClosingDate` accepts strict RFC 3339 (with timezone) plus ISO civil, day-first
  named-month (incl. `11h00` and ordinal suffixes), month-first, and day-first slash dates,
  each optionally followed by a clock time. Semantics:
  - Civil forms are **anchored in UTC** and a **missing time means 23:59** (end of day), so
    day counts, expiry-at-closing and the runway are identical whatever timezone the app runs
    in.
  - **Tail tolerance.** Trailing noise carrying no date/time information — a parenthetical
    note, a timezone abbreviation, free text with no digit and no named month — is tolerated,
    so realistic RFP lines import. Trailing text carrying _any_ date/time information (a
    digit, a clock time, a year, a named month) makes the whole string ambiguous and rejects
    it, so an amended or competing deadline can never be swallowed into a wrong date.
  - RFC 3339 is accepted only as a whole-string timestamp (offset required).
  - Impossible, ambiguous and timezone-less values return null — as do dash dates such as
    `30-11-2026`, which the pre-fix parser accepted.

## 5. Proposal generation

Files: `apps/tenders/src/main/proposal-generator.ts`,
`apps/tenders/src/main/readiness-binding.ts` (the canonical snapshot builder)

- `generateProposalMarkdown(input, options?)`. Ready language requires a **main-owned,
  binding-verified `readinessReport`** and consistent confirmed positive pricing.
- Phase 4 supplies that report: main loads the authoritative document, builds the
  `ReadinessReport` itself (`buildCanonicalReadinessReport`), and binds it to
  `{tenderId, revision, fingerprint}`. The expected binding is derived from independently
  resolved main facts (requested tender id + loaded document revision), **never** from the
  report's own binding — that comparison would be tautological. Renderer-supplied
  `readinessReport`/`ready` is ignored.
- **Readiness-snapshot recompute (must not regress).** `TenderRecord.submission.readiness` is
  renderer-authored, so a renderer could persist `ready: true` with no blockers for a blocked
  tender and make the compliance receipt lie. Every write path into the authoritative store is
  gated (`gateTendersCommits` wraps `save`, `mutate` — CRM sync and milestone billing — and the
  legacy `saveStoredData` channel), and the gate recomputes the checkpoints that commit
  **introduces or changes** against canonical readiness and replaces any that contradict it
  (`repairSubmissionReadinessSnapshots`). It corrects rather than rejects, so a contradicting
  renderer cannot wedge the workspace. Only new/changed checkpoints are recomputed — one
  byte-identical to the previously committed document, `capturedAt` included, is the frozen
  record of an earlier moment and survives later edits. The recompute assesses the document
  **over every check at the commit instant**, wall-clock-dependent ones included: excluding
  them was the hole that let a renderer persist `ready: true` for a tender whose only blocker
  was a lapsed or absent closing date. `restoreRecoveryCandidate` is deliberately not re-gated
  — its input is a main-authored backup that already committed through this gate.
- Unbound or mismatched reports still yield `DRAFT — READINESS NOT INDEPENDENTLY VERIFIED`.
  A renderer-only readiness claim can never produce `READY`/`CLEARED`; a truthful positive
  `READY` is reachable only through the canonical, fingerprint-matched report.
- No fabricated methodology, staffing, safety, certification, VAT, payment terms, or
  zero-valued pricing schedules. Missing data is stated as not provided.
- Amounts go through the single rand formatter (`formatRandAmount` in `shared/money.ts`), with
  the locale parameterised and an `en-ZA` fallback (`safeMoneyLocale` rejects any locale
  `Intl.NumberFormat` cannot parse). Blockers are deduplicated by stable IDs; `Cf` controls
  stripped; Markdown table cells escaped.

## 6. Non-blocking follow-ups (tracked, from `cod-7` / `sec-2`)

1. **CLOSED (Phase 4).** Billing now validates the caller revision before posting, posts
   through the Books port whose idempotency key dedupes, marks the milestone billed, and
   reconciles on conflict with a single retry (mid-commit crash ⇒ at most one invoice;
   retry ⇒ no double-post). Main additionally enforces won-only billing and rejects demo
   workspaces. A persisted `BILLING_IN_PROGRESS` marker was not added —
   reconciliation-on-conflict was the item's allowed alternative.
2. **CLOSED (Phase 4).** `syncWithCrm` commits the tender back-link revision first and
   aborts on conflict before any CRM write; the CRM upsert uses a deterministic deal id, so
   a retry reconciles to exactly one deal. Main also rejects demo workspaces.
3. **CLOSED.** `resetTendersIpcForTests()` throws unless the process is a test runner
   (`VITEST === 'true' || NODE_ENV === 'test'`, `tendersTestModeActive` in `tenders-main.ts`),
   and when it does run it deletes `documents/`, `vault/`, `.trash/`, `backups/` and
   `managed-documents.json`. The refusal is pinned by `tests/document-durability-ipc.test.ts`.
4. **CLOSED (Phase 5 / WP-14).** `isTrustedTendersEvent` / `isTrustedTendersWebContents` now
   fail **closed** when neither `rendererUrl` nor `rendererFile` is configured (and when a
   recipient cannot report a URL).
5. **CLOSED (Phase 5 / WP-14).** `saveStoreV2` conflicts return a compact payload
   (`error.code`/`message` + `currentRevision`); the full `current` document is never sent.
6. **CLOSED (Phase 5 / WP-14).** `getAuthoritativeTendersStore()` takes no path override;
   the renderer-path hole cannot reopen.
7. **CLOSED (Phase 5 packaged smoke).** A current packaged Windows build
   (`apps/shell/release/win-unpacked/Zanostack.exe`, built 2026-09-19) was launched from the
   packaged module under an isolated scratch profile: Tenders rendered from
   `resources/modules/tenders/renderer/index.html`, the first-use screen showed no demo
   seeding, a workspace was created and persisted to `<userData>/tenders/tenders-data.json`
   (schema v2, revision 1), and the auth/trust error count was **0** — i.e. packaged
   renderer URL equality holds and persistence does not fail closed in production. The
   artifact is unsigned — **accepted by decision** (see the README "Release status and
   accepted limitations"): signing is **suite-wide**, not Tenders-specific, so there is no
   separate Tenders artifact to sign. Signing would cover the whole `com.zanostack.app`
   product (`apps/shell/electron-builder.cjs`) plus the bundled native sidecar
   (`xlsx-sidecar.exe`); it is a distribution concern, not a correctness item.
8. **CLOSED (Phase 5 / WP-14).** `saveDocument` / `readDocument` / `replaceDocument` are
   bounded (`MAX_TENDERS_DOCUMENT_UPLOAD_BYTES` = 25 MiB) and reject before reading/writing;
   the managed document store re-checks the bound and caps its index/trash collections.
9. **CLOSED.** `applyTendersNavigationPolicy` (applied in `createTendersView`) denies by
   default: `will-navigate` is prevented and `setWindowOpenHandler` returns `deny` unless
   `allowedTendersNavigation` accepts the URL — the trusted renderer origin/file, or a
   `blob:` URL (a prefix test; an object URL only resolves in the renderer that created it).
   Store values such as `VaultDoc.fileUrl` / `TenderRecord.fileUrl` can therefore no longer
   navigate the privileged view away from the trusted renderer. **Must not regress.**

Phase 5 also closed the deferred durability items:

- **Managed-file lifecycle** (`main/document-store.ts`): `active → trashed` soft-delete
  (move to `.trash/`, never unlink), restore/undo across restart, replace-then-trash
  ordering (old file trashed only after the new commit), link-aware delete warnings,
  missing/orphaned reconciliation, and on-read path confinement of the metadata index.
  Tender deletion now routes through it (confirmation + link warning + RFP to trash).
- **Rotating backups + recovery** (`main/tenders-store.ts`): the previous valid primary is
  copied to `backups/tenders-data.<revision>.json` and rotated; a corrupt primary yields
  `RECOVERY_REQUIRED` with validated candidates and **never auto-substitutes**; restore is
  explicit, confined, quarantines the corrupt primary first, and bounds quarantine files.

Added during the Phase 2 gate (re-gate PASS; all non-blocking):

10. **CLOSED.** `checkTendersSaveSize` (`renderer/src/store.ts`) mirrors **both** ceilings
    before `saveStoreV2`: the compact document against `MAX_TENDERS_DOCUMENT_BYTES` and the
    pretty-printed file against `MAX_TENDERS_STORE_FILE_BYTES`, with an 80 % warning and an
    actionable refusal ("Nothing was lost — this change is still only on screen. Delete
    tenders, vault documents or customers you no longer need, then retry."). The IPC envelope
    cap is deliberately **not** mirrored: it sits strictly above the document ceiling, so it
    can never bind. **Must not regress** — this pre-check is what turns an unsaveable
    workspace into a visible, recoverable one.
11. A duplicate non-null tender `referenceNumber` (e.g. re-importing the same RFP) still
    fails `semanticChecks`; the renderer now surfaces the failing field path instead of
    failing silently, but the shred/`addTender` path does not de-dupe or warn. Recommend a
    shred-time duplicate-reference check so a re-import cannot leave a workspace unsavable
    until the duplicate is removed.
12. `onStoreChangedV2` is not adopted while a save is in flight (`isSaveInFlight` /
    `isSavePending` / `isMigrating`); a genuine external write received in that window
    reconciles as a `REVISION_CONFLICT` on the next save (never a silent overwrite or
    loss). Alternative: exclude the originating WebContents in main's commit broadcast so
    external writes can be adopted immediately.

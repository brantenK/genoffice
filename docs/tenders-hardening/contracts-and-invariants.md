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
compliance-matrix export has its **own** byte ceiling, `MAX_TENDERS_MATRIX_EXPORT_BYTES`
(4 MiB, `shared/ipc.ts`) — deliberately not this envelope's: a raised envelope once loosened
that export for a reason that had nothing to do with it, and nothing then reported the change.
There it _is_ the binding check, and it is held below the envelope on purpose so the export
answers for itself (pinned by `tests/tenders-main-write-bounds.test.ts`); that export's
row/cell bounds are the separate constants in `shared/ipc.ts` (table below).
`MAX_TENDERS_MANAGED_FILES` was 20 000 while the 4 MiB index ceiling admitted only ~11 500
records — the advertised capacity was unreachable, and a full index refused the user _below_
it with a limit they could not count or plan for. `MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD`
(832 bytes) is the _measured_ worst-case serialized cost of one record at
`MAX_TENDERS_MANAGED_FILE_NAME_CHARS` (80 characters), and that clamp is what keeps the
record-count caps binding before the byte ceiling for every record the store writes.

**That ceiling is a serialized-bytes GROWTH ceiling, not a bound on what the index costs to
hold.** It is enforced only on a write that ADDS a record (`writeIndex`); trash, restore,
empty-trash and `reconcile`'s missing/active flips are allowed past it, so a full index can
never wedge the user out of deleting a document, and `readIndex` never refuses a large index —
refusing to read would hide the very documents the user needs to delete. The cost of a parsed
index is larger than its bytes: the live objects `JSON.parse` produces were **measured at
5.05×** the serialized size for a 5 000-record index (~11.3 MB of heap for 2 328 931 serialized
bytes), and an over-ceiling index is still read and rewritten by the non-growing paths above —
measured at 4 194 795 serialized bytes, `listRecords` returned 9 004 records, and a read plus a
trash/empty-trash cycle each finished in under 200 ms. The claim the constant supports is
exactly the one `writeIndex` enforces: an index this large can no longer GROW through the app.
What bounds the cost of a managed-document operation is `MAX_TENDERS_MANAGED_FILES` (5 000
records), which is what a full store reports and what the user can count against. Pinned by
`tests/tenders-persistence-bounds.test.ts` ("the managed-index ceiling is a serialized-bytes
growth cap, not a memory cost").

Also exported from `shared/ipc.ts`:

| Constant                               | Value  |
| -------------------------------------- | ------ |
| `MAX_TENDERS_DOCUMENT_UPLOAD_BYTES`    | 25 MiB |
| `MAX_TENDERS_MATRIX_EXPORT_BYTES`      | 4 MiB  |
| `MAX_TENDERS_MATRIX_EXPORT_ROWS`       | 5000   |
| `MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS` | 32768  |

### 1a. Intake verification (Phase 3 — additive on schema v2)

`TenderRecord.intakeVerification?` is an **optional, additive** field on schema v2 (no
version bump; a document without it still validates exactly as before). It holds the
extraction-review state: per readiness-critical field a state plus the chosen value and the
original extracted candidate(s) (provenance), requirement-review annotations, and per-page
extraction state (`native | ocr-required | ocr-unavailable | ocr-failed | manually-reviewed |
ai-extracted` — `ai-extracted` is the optional AI extraction pass, §5a).

An additive optional marker also rides on the review records: `suggestedBy?: 'parser' | 'ai'`
(`ValueProvenance`) on `FieldReview`, `ReviewCandidate` and `ExtractedRequirement` /
`RequirementRecord`, so a value a model suggested is never presented as the local parser's own
read. Absent means `'parser'` — decided in exactly one place, `valueProvenance(carrier)`, and
the schema accepts only the closed set `VALUE_PROVENANCES` (`parser`, `ai`), rejecting an
unrecognised origin rather than coercing it. Provenance is never a review decision: it does not
change `state`.

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
  individual page state whose content was obtained (`unprovenOcrPageCount(tender) > 0`). This
  closes the v1→v2 migration false-clear: a migrated tender with unreadable pages and no page
  state is blocked (fail-closed) until each page is reviewed. With `ocrPages === 0`/absent and
  no review, no page check is added and readiness is byte-identical to pre-Phase-3.
- What clears a page is its **content being obtained**, never a confirmation — one predicate,
  `pageContentObtained(state)` in `shared/types.ts`: `native`, `manually-reviewed` and
  `ai-extracted` are content-obtained; `ocr-required`, `ocr-unavailable` and `ocr-failed` are
  not. A page no method obtained still blocks readiness (§5a).
- **`ai-extracted` is reachable only for a PDF source, and this list used to read as though it
  were reachable for every source.** A Word `.docx` has no rendered page, so the vision pass
  refuses it before it consults the model (§3d, `WORD_DOCUMENT_VISION_MESSAGE`) and `markModelReadPages`
  is never given a page to mark; a picture-only Word page therefore leaves `ocr-required` only
  through `manually-reviewed`. It keeps blocking with AI on or off, which is what §3d and
  `README.md` say about it — the two sections now agree because this one names the condition
  instead of implying the model can clear any flagged page.

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

### 2a. Renderer persistence state (the save pill must not claim more than happened)

The renderer's own state machine over that store (`renderer/src/store.ts`,
`renderer/src/components/SaveStatus.tsx`). Two names have to be known, because both exist to
stop the UI describing a persistence path it does not have:

- `hydrationMode: 'normal' | 'unavailable'` — **which kind** of hydration happened.
  `'unavailable'` means the preload bridge is absent or stale (`window.tendersApi?.loadStoreV2`
  is missing), so main was never asked, no document was read, and no save can ever succeed. It
  is set with `hydrationStatus: 'ready'` on purpose: the workspace is usable, and explicitly
  unable to save. Before this state existed that branch rendered `'ready'`/`'saved'`, so a user
  could build a company, tenders and requirements that could never persist while the chrome
  said "Saved".
- `SaveStatus` = `'loading' | 'saving' | 'saved' | 'error' | 'conflict' | 'no-bridge'`, rendered
  by `SaveStatus.tsx` as `Loading… / Saving… / Saved / Save failed (Retry) / Conflict /
**Cannot save**`. `'no-bridge'` is `SaveStatus`'s own kind — `SaveStatusKind` mirrors it —
  and it is never "Saved" and never "Unsaved": the label states the fact. It is an alert (the
  danger tone, `role="alert"`), and it flips on **every** refused edit, not only the first, so
  a bridge that disappears mid-session moves the pill to "Cannot save" at the moment the first
  edit is refused. `'saved'` is the only status that reads as success, pinned by
  `tests/components/save-status.test.tsx` ("prints 'Saved' for the saved state, and only for
  the saved state"); the `'no-bridge'` transition, and its refusal to return to `'saved'`, are
  pinned by `tests/diagnostics.test.ts` ("a build with no bridge cannot claim its work is
  saved").
- The store's own refusal vocabulary (`TendersSaveRefusalCode`: `NO_IPC_BRIDGE`,
  `SAVE_BLOCKED_BY_CONFLICT`, `DOCUMENT_OVER_SIZE`, `SCHEMA_INVALID`, `REVISION_CONFLICT`,
  `STORE_REFUSED`, `SAVE_THREW`) is **diagnostic only** — no state, no retry, no user-visible
  copy — and a save that commits logs nothing at all, which is what keeps the log from becoming
  noise (`renderer/src/store.ts`, §3e).

### 2b. The legacy v1 stack is retired — what that does and does not mean

The v1 stack (`tenders-main.ts`) is a **second** persistence architecture that used to run
alongside the authoritative v2 store. It is retired, deliberately and in three parts. Two
stack descriptions of the app are stale; this is the state now:

- **No synthesis.** `migrateAndValidateTenders` reads back only what a v1 file actually
  contains. It used to answer an empty or non-object payload with `createDefaultSeedWorkspaces()`
  (demo company, customers, vault and the seeded RFP), which is the one thing the v2 path
  promises never to do; a store whose vault had been emptied came back with seven compliance
  documents in it. It also no longer rewrites legacy workspace or active-company ids — they are
  read as written. A payload that is not an object throws `LegacyTendersReadError`; it is never
  answered with a stub.
- **No live watcher.** `registerTendersIpc` no longer starts the `fs.watch` over
  `tenders-data.json` that re-read and re-broadcast the file on `tenders:data-changed` — a
  channel with no subscribers since the v2 cutover, so it re-read and re-broadcast on every
  write the v2 store made to a file only the legacy stack cared about.
- **No writer.** `writeTendersStore` is reachable from no Tenders IPC handler, so within this
  app the sole shipping writer of `tenders-data.json` is the authoritative v2 store.
  `writeTendersStore`, `startTendersStoreWatcher`, `broadcastTendersData` and
  `migrateAndValidateTenders` remain **exported for the tests that pin their own behaviour**
  (`tests/ipc-handlers.test.ts` "4b. The legacy v1 stack is retired, not merely quiet";
  `tests/store-migrations.test.ts`; `tests/adversarial-stress.test.ts`).

What stays, and why: the **read** path. `readTendersStore` serves `getStoredData` (§3), which
`e2e/tenders-regression-smoke.spec.ts` proves is reachable and which reads a genuine v1 file
back. A missing file is still an empty envelope; a malformed primary throws
`LegacyTendersReadError` after quarantining the bytes to `<path>.corrupted.bak` (§3, §1).

**One caller of the legacy writer is outside this app, and it is the exception that keeps the
"sole writer" sentence honest.** `apps/books/src/main/books-main.ts` (measured: the
milestone-billing reconciliation around lines 706–728) dynamically `require`s
`apps/tenders/src/main/tenders-main` and calls `readTendersStore` / `writeTendersStore` on
`<userData>/tenders/tenders-data.json`, with a fallback that writes that file directly when the
require fails. So the retirement is complete **within Tenders**: no Tenders surface writes the
v1 file, and the file the v2 store owns is `<directory>/tenders-data.json` in the same
directory. It is not true of the suite, and until that Books path is deleted the docs must not
say otherwise. Tracked in §6 item 14 (a Books-owned change; not made here).

## 3. IPC + preload bridge

Files: `apps/tenders/src/shared/ipc.ts`, `apps/tenders/src/preload/index.ts`, and — after the
composition-root split — `apps/tenders/src/main/ipc/handlers.ts` (all 33 registrations),
`apps/tenders/src/main/ipc/trust.ts` (the gate) and `apps/tenders/src/main/ipc/registration-state.ts`
(the registered boolean). `apps/tenders/src/main/tenders-main.ts` is now the composition root and
re-exports the surface; see `module-map.md`.

v2 channels: `tenders:load-store-v2`, `tenders:save-store-v2`, `tenders:store-changed-v2`.
Preload API: `loadStoreV2`, `saveStoreV2`, `onStoreChangedV2` (direct objects, not JSON strings).

**The arithmetic, stated once so it can be checked.** `TENDERS_CHANNELS` in `shared/ipc.ts`
declares **36** channel constants; **33** of them have an `ipcMain.handle` in
`apps/tenders/src/main/tenders-main.ts` (count it: `grep -c "ipcMain.handle" ` on that file
returns 33). The three that do not are main→renderer pushes: `store-changed-v2` (the commit
broadcast), `close-flush-request` (the shell's dirty-close guard, §3a) and the legacy
`data-changed`. The 33 handlers break down as: 2 v2 store (`load-store-v2`, `save-store-v2`),
1 close-flush reply (`close-flush-result`), 2 legacy (`get-stored-data`, `save-stored-data`),
9 document lifecycle (`save-document`, `read-document`, `open-document`, `delete-document`,
`list-document-trash`, `restore-document`, `replace-document`, `reconcile-documents`,
`cleanup-document-trash`), 2 recovery (`list-recovery-candidates`,
`restore-recovery-candidate`), 7 cross-app (`export-matrix-to-sheets`, `draft-proposal-doc`,
`sync-with-crm`, `update-tender-outcome`, `open-in-crm`, `bill-milestone-in-books`,
`open-books`), 5 discovery (§3b), 3 reminders (§3c), 2 diagnostics (§3e). The channel list has
grown in waves — 3 v2 channels, then the 9 close-flush/document-lifecycle/recovery channels
(`close-flush-request` / `close-flush-result`; `list-document-trash`, `restore-document`,
`replace-document`, `reconcile-documents`, `cleanup-document-trash`; `list-recovery-candidates`,
`restore-recovery-candidate`) plus the four document channels they sit beside; then the 8
discovery/reminder channels (§3b, §3c); then the 2 diagnostics channels (§3e); and the legacy
and cross-app channels that predate all of it — which is why a count stated as "3 + 9 + 8" was
always going to be wrong. Every one of these has a preload pass-through (`onCloseFlushRequest`,
`reportCloseFlush`, `listDocumentTrash` … `cleanupDocumentTrash`, `listRecoveryCandidates` /
`restoreRecoveryCandidate`), and validation, trust and path confinement against the
document channels all stay in main.

The optional AI extraction pass adds **no channel and no handler** to this list: it goes
through the shell's own `ai:*` channels (`AI_CHANNELS`), which Tenders only mirrors in the
preload. See §5a.

**Tender discovery and deadline reminders add eight more** (§3b, §3c): five discovery channels —
`tenders:discovery-list`, `tenders:discovery-refresh`, `tenders:discovery-read-cache`,
`tenders:discovery-release`, `tenders:discovery-download-document` — and three reminder channels
— `tenders:reminders-get`, `tenders:reminders-set`, `tenders:reminders-check`. Every one has a
preload pass-through, and main owns the shape validation, the trust check, the URL allow-list,
the byte caps and the store.

| preload member                                                               | channel                                 |
| ---------------------------------------------------------------------------- | --------------------------------------- |
| `discoveryList(request: DiscoveryListRequest)`                               | `tenders:discovery-list` (invoke)       |
| `discoveryRefresh(request?: DiscoveryRefreshRequest)`                        | `tenders:discovery-refresh` (invoke)    |
| `discoveryReadCache()`                                                       | `tenders:discovery-read-cache` (invoke) |
| `discoveryFetchRelease(request: DiscoveryReleaseRequest)`                    | `tenders:discovery-release` (invoke)    |
| `discoveryDownloadDocument(request: DiscoveryDownloadDocumentRequest)`       | `tenders:discovery-download-document`   |
| `getReminders(): Promise<RemindersStateResponse>`                            | `tenders:reminders-get` (invoke)        |
| `setReminders(settings: RemindersSetRequest): Promise<RemindersSetResponse>` | `tenders:reminders-set` (invoke)        |
| `checkReminders(): Promise<RemindersCheckResponse>`                          | `tenders:reminders-check` (invoke)      |

Note the two names that differ deliberately between the two layers:
`TENDERS_CHANNELS.discoveryRelease` is invoked from the preload's `discoveryFetchRelease`
(the member describes what it does), and `TENDERS_CHANNELS.remindersGet` / `-Set` / `-Check`
from `getReminders` / `setReminders` / `checkReminders` (the members describe what the
renderer asks for). The preload exposes these as **functions only** — it never exposes
`ipcRenderer`, so a renderer cannot reach a channel that has no member above.

Authorization (applies to **all 33 privileged handlers**, each calling `isTrustedTendersEvent`
**directly** — there is no central wrapper):

- `isTrustedTendersEvent` requires: sender is a registered active Tenders WebContents,
  `senderFrame.parent === null` (top frame only), and trusted origin matching
  `runtime.rendererUrl` (or packaged `rendererFile` URL); falls back to
  `webContents.getURL()` when frame missing.
- Rejection shape: `{ ok:false, error:{ code:'INVALID_REQUEST', message:/authoriz|trusted|registered/i } }`,
  with no side effects — 30 of the 33 return exactly that (`unauthorizedTendersRequest()`).
  **Three return a bare string `error` with no `code`**: `draftProposalDoc`, and the two
  diagnostics handlers (`recordDiagnostics`, `diagnosticsPath`, §3e) — check for the string,
  not the envelope, when asserting on those.
- `isTrustedTendersWebContents` filters broadcast recipients for both `store-changed-v2`
  and legacy `dataChanged`.
- Lifecycle helpers used by tests: `resetTendersIpcForTests()`,
  `isTendersIpcRegisteredForTests()`; `ipcRegistered` set only after full registration.
  `resetTendersIpcForTests()` is **test-only and refuses to run outside a test runner**
  (`VITEST === 'true' || NODE_ENV === 'test'`); when it does run it deletes `documents/`,
  `vault/`, `.trash/`, `backups/` and `managed-documents.json`, so it must never be reachable
  from production code.

Legacy channels (preload-only — no renderer module calls them any more; the ledger and the
regression smoke are their only consumers):

- `getStoredData` / `saveStoredData` remain, now authorized.
- `saveStoredData` accepts **only a schema-v2 document** (`validateTendersDataV2`) and commits
  it through the authoritative store at its own revision; v1, `schemaVersion: 3` and
  non-integer versions are all rejected. It can therefore never re-seed demo
  company/vault/tender data into, or overwrite, the user's store.
- `getStoredData` answers with the file that is actually on disk, read by the legacy v1
  envelope reader (`readTendersStore`), or `null` when **no file exists at all** — the one case
  where "nothing" is the honest answer, because it is also what the read found. A file that
  exists but cannot be read or parsed **fails closed**: it is quarantined to
  `<path>.corrupted.bak` and the channel returns
  `{ ok:false, error:{ code:'RECOVERY_REQUIRED', message: LEGACY_TENDERS_READ_FAILED }, recoveryCandidates? }`,
  the same posture `loadStoreV2` takes. It used to return `null` — which the renderer shows as
  "no saved data", i.e. apparent data loss with the real failure invisible — and, before that,
  `{workspaces: []}`. `recoveryCandidates` comes from `listLegacyRecoveryCandidates()`, which
  lists the `.corrupted.bak` copies **beside the live file** and deliberately not the v2
  store's backups: offering those for a v1 file would restore the wrong document.
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

### 3b. Tender discovery (additive, optional, and the fork's second outbound reach)

Tenders has always started with the user pasting a link. Discovery is the additive alternative:
it turns National Treasury's public eTenders **OCDS 1.1** open data into a list of opportunities
the user can pick from. It is optional, it is off until the user opens the Discover pane, and the
local rule engine stays the offline, always-available default.

Files:

- `apps/tenders/src/shared/discovery.ts` — the **pure core**: parsing, normalising, filtering,
  scoring, the cache envelope, and every URL the client is allowed to build. No `fetch`, no
  `node:*`, no clock (every time-dependent function takes `now`), no randomness, no locale.
- `apps/tenders/src/main/discovery-client.ts` — the **wire and the disk**. The network call is
  injected (`fetchImpl` defaults to `globalThis.fetch`), so the whole client — retries, timeouts,
  the byte cap, the redirect handling, the fallback, the cache — runs in the unit suite with zero
  network.
- `apps/tenders/src/main/tenders-main.ts` — the five handlers, the document download
  (`downloadDiscoveryDocument`) and the cache directory resolution.
- `apps/tenders/src/renderer/src/components/pages/DiscoverPage.tsx` — the pane.
- `apps/tenders/tests/discovery.test.ts`, `tests/discovery-client.test.ts`,
  `tests/discovery-pane.test.ts` and `e2e/tenders-discovery.spec.ts` (with
  `e2e/tenders-discovery-fixtures.ts`) — the core's rules, the transport's bounds, the pane's copy,
  and two built-app journeys.

**The source, and what it does not cover — product facts, not footnotes.** The source is National
Treasury's keyless eTenders OCDS feed (`ocds-api.etenders.gov.za`), published under the **Public
Domain Dedication and Licence (PDDL) 1.0**. `describeCoverage()` in the core returns the limits in
plain language for the UI to show **verbatim and always** (`DiscoverPage` renders it in every
state, including the empty and error ones), because they are the thing a bidder could otherwise be
misled by:

- **National and provincial departments publish here. Municipalities and state-owned enterprises
  appear only when they volunteer their data to Treasury**, so a tender the user already knows
  about may simply be missing. Coverage starts **January 2024**.
- Treasury labels the whole feed a **public beta** and states that **its accuracy is not
  guaranteed**.
- Treasury states the feed **must not be used for critical decision making or legal purposes**;
  the copy says to work from the official tender document, not from the list.
- Personal information is redacted at source under POPIA, so contact details may be absent.
- Values are almost never published: a tender with no stated value shows **no** value, never a
  zero. (A stated `amount: 0` — which the archive states for every release it publishes — is read
  as "no value stated", never as a R 0 tender.)
- The live feed is slow and unreliable (a two-record page measured 30 s; a 200-record page never
  answered), so the app pages in small date windows, retries, and **says so when it could not get
  everything** (`truncated`, `failedPages`, `warnings` — never a silently short list).

**Invariants a future change must not break:**

- **Main fetches; the renderer never does.** The renderer holds no `fetch` for the feed, and the
  handlers pass every call through to the injected client. The pane can be reachable with no
  network at all and answer from the cache.
- **https only, on an exact-host allow-list, validated BEFORE any request.** `isAllowedDiscoveryUrl`
  requires `https:`, one of `DISCOVERY_ALLOWED_HOSTS` (`ocds-api.etenders.gov.za`,
  `data.etenders.gov.za`, `www.etenders.gov.za` — **exact** host match, so
  `ocds-api.etenders.gov.za.evil.example` is refused), and no embedded credentials. It is checked
  before `fetch` for the request URL, for a `links.next` the feed offered, and for the document
  download's link.
- **Redirects are followed manually, one hop at a time, and re-validated per hop.** `redirect:
'manual'` is passed and each hop goes back through `isAllowedDiscoveryUrl`; a redirect off the
  allow-list is refused with `BLOCKED_URL` and **nothing is requested at the target**. Hops are
  bounded (`DISCOVERY_MAX_REDIRECTS` = 3).
- **Every request is bounded in time and bytes.** A 45 s per-request timeout
  (`DISCOVERY_REQUEST_TIMEOUT_MS`), bounded exponential-backoff retries on 5xx / 408 / 429 /
  timeout / network only (`DISCOVERY_MAX_ATTEMPTS` = 3, base 750 ms, capped 8 s), an **8 MiB**
  response ceiling enforced **while the body is read** rather than after
  (`DISCOVERY_MAX_RESPONSE_BYTES`), a declared `content-length` check before the body,
  `DISCOVERY_MAX_PAGES` = 20 pages walked per window, windows of at most
  `DISCOVERY_MAX_WINDOW_DAYS` = 7 days, `DISCOVERY_MAX_WINDOWS_PER_REFRESH` = 6 windows per refresh,
  2 archive files tried, 2 000 opportunities and 4 MiB kept in the cache. All of these are
  constructor options, so a test proves each bound with no network and no wall time.
- **The live feed is the default; the monthly bulk archive is the fallback, and it says so.**
  When every live window fails, the archive is read instead and the cache records
  `source: 'bulk-archive'` plus a warning that the archive lags the live feed by one to two
  months. A fallback is never presented as the live feed.
- **A failed refresh never destroys a good cache.** A refresh writes only when it has something to
  write; otherwise the previous cache is left alone and the failure is returned.
- **The on-disk cache is what makes the pane work offline.** Path:
  `<userData>/tenders/discovery/discovery-cache.json` (`discoveryCacheDir(userDataDir)` +
  `DISCOVERY_CACHE_FILE_NAME`), beside the store's own `tenders` directory. Staleness:
  `DISCOVERY_CACHE_MAX_AGE_MS` = **6 hours**, and `readCache()` reports `stale` rather than hiding
  the age. The write is **atomic** (a uniquely named `wx` temp file, then `rename`, mode 0600) and
  the read is **defensive**: a wrong `version`, a missing window or an unreadable `fetchedAt`
  refuses the whole envelope, and each stored record is re-derived (a closing state recomputed, a
  document link re-checked, a province required to be a real province, a value required to be
  positive), so a hand-edited or truncated cache cannot inject a record the app would otherwise
  refuse.
- **A downloaded document arrives through the SAME managed-document store and the SAME intake as a
  file the user picked.** `discoveryDownloadDocument` re-checks the renderer-supplied link against
  the allow-list **before any request**, follows redirects manually with the same re-validation,
  enforces the same 25 MiB body ceiling (`MAX_DISCOVERY_DOWNLOAD_BYTES` =
  `MAX_TENDERS_DOCUMENT_UPLOAD_BYTES`) while reading, and stores what it fetched through the
  ordinary `ManagedDocumentStore.save(...)` at `category: 'rfp'`. The pane then hands that file to
  `intakeTenderFile` with the **already-stored** path, so there is one intake, one store, and no
  second copy. **The result is `unconfirmed` like any machine-sourced value** (§5a rule 1): a
  listing is a lead, and the provenance note (`provenanceNote`) naming the feed, the ocid and the
  source record rides into the tender's persisted review `conflicts`.
- **Nothing here can claim readiness.** Every `Opportunity` carries
  `provenance: 'discovery-feed'` and `reviewState: 'unconfirmed'` (`DISCOVERY_REVIEW_STATE`) —
  the one review state a machine may write. Nothing in the core can produce `confirmed`.
- **Reject with a reason, never throw and never repair.** Every dropped record
  (`DiscoveryParseIssue`: `not-an-object` / `missing-ocid` / `missing-title` / `duplicate-ocid`)
  and every refused document link (`refusedDocumentLinks`) is reported, because a silently
  repaired field would be a fabricated one. A missing or unreadable closing date is flagged
  (`closingState: 'missing' | 'unparseable'` plus a plain-language note), never invented.
- **The feature reaches exactly two hosts by design, and a third only through the user.** The API
  and the archive are read; **tender documents are re-hosted nowhere** — the app opens a linked
  document on `etenders.gov.za` — and `www.etenders.gov.za` is on the allow-list only so the
  download handler can accept a link the feed itself published, still under the same validation.

### 3c. Deadline reminders (the app's only notification path — live-process only)

The audit finding this answers is blunt: the app had **no reminder mechanism at all** — a manual
`.ics` export and an on-screen countdown, nothing that survives the app being closed — so a user
who shut the app was never warned about a closing time, which is the product's stated job.

Files:

- `apps/tenders/src/shared/reminders.ts` — the **pure core**. Every decision is a pure function of
  `(tenders, settings, now, ledger)`: no Electron, no clock, no disk, no locale. It takes the
  closing instant from the **one** parser (`parseClosingDate` in `./readiness`, which owns the SAST
  anchor) and renders it with that module's own `formatClosingInstant`, so a reminder can never
  disagree with the readiness gate or the countdown badge about when a bid closes or how that
  instant is written.
- `apps/tenders/src/main/reminders-scheduler.ts` — the main-process scheduler and the Electron
  `Notification` path. Every side effect is injected (clock, notifier, tender reader, timer
  primitives, logger), so the whole schedule — dedupe across restarts, the corrupt-file path, the
  timer lifecycle — is testable with no Electron and no waiting.
- `apps/tenders/src/main/tenders-main.ts` — the three handlers, `startTendersReminders()` (called
  from `registerTendersIpc`, the same hook that starts the store watcher, so the store exists
  before the first check reads it), and the `readReminderTenders` reader over the authoritative
  store.
- `apps/tenders/tests/reminders.test.ts`, `tests/reminders-scheduler.test.ts`,
  `tests/reminders-settings-copy.test.ts` — the core's rules, the scheduler's containment and
  durability, and the settings surface's copy.

**THE LIMITATION, stated plainly: a reminder fires only while the app is running.** `Notification`
is a live-process API. There is **no background service, no OS scheduler and no cloud push** here.
If the app is closed when a threshold passes, nothing is sent at that time; the warning is
delivered the next time the app opens and is marked `late` (the title reads "— late warning" and
the body says the moment had already passed), so the copy never pretends the user was warned on
time. The exact sentence is exported as `REMINDERS_RUNTIME_LIMITATION`, travels on the
`reminders-get` / `reminders-set` responses so the settings surface shows the same words without
importing a main-process module, is logged by `start()`, and is pinned verbatim by
`tests/reminders-settings-copy.test.ts`. **This is the single most important thing to know about
the feature.**

The pure core's rules — each one a product decision, all documented in the source:

- **The threshold ladder.** `DEFAULT_REMINDER_THRESHOLDS` ships `7d` / `3d` / `1d` / `2h` lead
  times (a week out to start assembling, three days to chase documents, one day for the final
  check, two hours to submit). Reminders are **enabled by default** (`DEFAULT_REMINDER_SETTINGS`)
  — the schedule is computed entirely on this machine and "don't miss the closing time" is the
  product's stated job — and `enabled: false` makes the schedule inert (`dueReminders` returns
  nothing and writes nothing). A threshold is crossed once `now >= closing - leadMs`, **inclusive**
  at the boundary (the instant a scheduler wakes).
- **Once per (tender, threshold, closing instant).** The serialisable ledger
  (`ReminderLedger`, `REMINDER_LEDGER_VERSION` = 1) records each decision and is fed back into the
  next call; `dueReminders` records what it returned **within the same pass**, so a duplicated
  tender row cannot fire twice either. The ledger is persisted as plain JSON, so the guarantee
  survives a restart.
- **Only open tenders, only future closings.** `OPEN_TENDER_STATUSES` is an explicit allow-list
  (`IN_PROGRESS`, `READY_TO_ASSEMBLE`, `PACK_GENERATED`, `READY_FOR_SUBMISSION`), so an
  unrecognised status fails **closed** and produces no notification. A tender with no closing date,
  an unreadable one, or a closing instant already past gets no reminder and (for the first two) no
  ledger entry — there is nothing to key on.
- **The added-late rule.** When several thresholds have already passed at first consideration (a
  late import, or the app closed for days), **at most ONE reminder fires — the most urgent crossed
  threshold** — and every other crossed threshold is recorded as `skipped-stale`. Firing the
  week-out, three-day and one-day warnings at once would be a burst of stale alarms; recording the
  skipped ones is what stops them trickling out one per check afterwards. The entry is honest
  about not having been shown (`ReminderLedgerDisposition`).
- **The moved-deadline rule.** A ledger entry suppresses only the exact
  (tender, threshold, closing instant) it was written for. **Moving the closing date — earlier or
  later — makes every existing entry refer to a deadline that no longer exists, so the thresholds
  fire again for the new instant.** Returning to a previously notified instant (A → B → A) is
  suppressed, because the entry for A was never invalidated. Both directions are documented
  rather than hidden.
- **Pruning.** `pruneReminderLedger` drops entries for closings more than
  `REMINDER_LEDGER_RETENTION_DAYS` = 30 days past, so the file cannot grow forever — and pruning is
  by the **closing instant only**, deliberately not by status, because the lifecycle allows a
  tender to move backwards and an entry dropped early would re-notify a deadline the user has
  already been warned about. An unusable clock keeps the ledger rather than wiping it.
- **Fail toward notifying.** `parseReminderLedger` discards a ledger whose `version` is not the one
  this build writes and drops entries that do not validate; `normalizeReminderSettings` falls back
  to the defaults. A corrupt or misunderstood ledger must never **suppress** a warning about a
  closing time: re-notifying is a nuisance, silently missing the deadline is the failure the
  feature exists to prevent. Entries are compared as **instants, not strings**, so
  `09:00:00.000Z` and `11:00:00+02:00` suppress alike.
- **Honest copy.** `describeReminder` names the tender, the remaining time and the closing instant
  (with the `SAST` / "your local time" suffix the countdown badge uses) and stops there. It never
  says a tender is ready, confirmed or compliant. `markRemindersSent` / `forgetReminders` exist so
  a caller that displayed only a subset — or whose delivery failed — records exactly what was
  shown; `nextReminderAt` reports the next strictly-future instant, so a scheduler could sleep
  instead of poll.

The main-process scheduler:

- **State file:** `<userData>/tenders/reminders.json` (`remindersStatePath(userDataDir)`,
  `REMINDERS_STATE_FILE_NAME`), **beside** the authoritative store rather than part of it — the
  strict v2 authority schema stays untouched by a dedupe ledger. Layout version
  `REMINDERS_STATE_VERSION` = 1; a file from another version or a damaged one is ignored
  **entirely** (defaults + empty ledger), which is the fail-toward-notifying rule above. The
  read ceiling is `MAX_REMINDERS_STATE_BYTES` = 4 MiB.
- **The file is the single source of truth.** Every check re-reads it instead of trusting a memory
  copy, so a second window, a restart or a hand-edited file cannot desync the schedule.
- **Atomic writes.** A uniquely named `wx` temp file, then `rename`, mode 0600 — the store's own
  discipline — and **pruned on every write**. A quiet check touches no disk at all (the ledger is
  compared before writing).
- **Checks are serialised** on one queue, so a check always sees the ledger the previous one
  persisted. That is what makes ONCE-ONLY true rather than merely likely.
- **Failures are contained.** A throwing tender reader, a failing notifier or a failed disk write
  is reported through the log hook and absorbed: the ledger is left intact, `checkNow()` still
  resolves (it never rejects — a rejected interval callback would end the schedule), and the
  interval keeps running. A notifier that throws loses **no** ledger entry; a notification the OS
  cannot show is logged naming the tender and threshold and is deliberately **not** re-armed
  (retrying cannot make an unsupported platform show it, and re-arming would fire it at an
  arbitrary later moment).
- **Check interval:** `DEFAULT_REMINDER_CHECK_INTERVAL_MS` = **15 minutes** — the tightest default
  lead time is two hours, so a quarter-hour poll bounds how late a warning can be to fifteen
  minutes. `start()` is idempotent and runs **one check immediately**, which is what surfaces a
  deadline that fell due while the app was closed. The schedule is tied to the **process**, not to
  a window: it keeps running while the app runs even if the user closes the Tenders tab, and
  `will-quit` stops it (not `before-quit`, which the shell's dirty-document flow can cancel).
- **The notifier degrades honestly.** Without Electron, or on a platform reporting notifications
  unsupported, it logs `NOTIFICATIONS_UNAVAILABLE_MESSAGE` / `NOTIFICATIONS_UNSUPPORTED_MESSAGE`
  and returns quietly rather than throwing into the schedule.
- **Nothing is networked.** The schedule is computed on this machine from the store the app
  already has, exactly like the local rule engine. Reminders are not an online feature and do not
  become one.

### 3d. DOCX intake (additive on the PDF pipeline, one document at a time)

Intake now accepts a **Word `.docx` as a single document, in exactly the same place a PDF is
accepted** (the file input, the drag-and-drop path, and a document downloaded from the discovery
pane). **It does not accept multi-file packs, `.doc`, or any other Word format** — one `.docx` is
one tender, and the message for anything else says so
(`Only PDF and Word (.docx) documents are supported.`). Saying this explicitly because "packs of
files" is the obvious next guess and it is not what this is.

File: `apps/tenders/src/renderer/src/intake/docx.ts` — `extractDocxIntake(source, options)`.
Guards: `apps/tenders/tests/docx-intake.test.ts`, `tests/docx-intake-copy.test.ts`,
`tests/tender-list-intake-copy.test.ts` and `e2e/tenders-docx-intake.spec.ts` (two built-app
journeys: a real `.docx` imports, populates the matrix and persists; a file that is not a real
`.docx` is refused with a reason rather than shredded).

**The contract.** A `.docx` has no pages and no measured geometry, so the module presents the
document honestly instead of inventing either. `DocxIntake` is `PageExtraction`-compatible on
purpose — `shredExtraction`, `extractTenderMeta`, `extractIssuerInfo` and the review UI consume it
with **no change**, so there is one shredder, one rule engine and one review step for both
formats — plus a `kind: 'docx'` discriminator and the extra fields a surface needs to describe the
source truthfully:

- **One line per paragraph, and per table row** (cells joined, the way the PDF path clusters a
  visual row), split further at the soft/column breaks the engine encodes as `'\n'`.
- **Boxes are READING-ORDER COORDINATES, not measured geometry:** lines stack top-to-bottom inside
  the band `0.20`–`0.80`, with a paragraph-sized gap between groups, which is exactly what
  `buildClauses` needs to split clauses at paragraph boundaries. Staying out of the `0.18`
  header/footer band keeps the running-boilerplate heuristic from stripping a body line.
  `left`/`width` are the full column, because the file records no x positions.
- **`needsOcr` mirrors the PDF rule's intent**, and is decided honestly: a `.docx` can tell the
  difference between "no text" and "content that is not text", so a page is flagged **only** when
  it carries visible content that is not text (pictures, charts, drawings) **and** yields fewer
  than 20 non-space characters. A genuinely blank page does **not** block — the body was read in
  full — while a picture-only page still fails closed.
- **Not read, deliberately:** header/footer parts, footnotes, endnotes and comments (separate
  parts; the body is where requirements live), and Word's saved `w:lastRenderedPageBreak` layout
  hint, which is a layout **cache** whose position inside a paragraph the block model does not
  carry — honouring it would place boundaries at paragraph starts, i.e. a **guessed** page number,
  which is exactly what this module refuses to produce.

**The pagination honesty rule (must not regress).** A `.docx` has no pages. Only page breaks the
document **itself declares** are counted — a body-level `w:br w:type="page"`, a paragraph carrying
`w:pageBreakBefore`, a section whose start type is `nextPage` / `evenPage` / `oddPage`. **A
flowing `.docx` is one page to this app (`numPages: 1`) with
`pagination: 'continuous'`, and the UI must NOT print "1 page" for it** — a printed page number
the file does not have. `docxPaginationNote(intake)` is the one function that words this, so no
surface paraphrases it and gets it wrong: a flowing document says it "declares no page breaks, so
the document is presented as one continuous block of text: clause references read "p. 1" and are
not printed page numbers", while a paged one says "Pages follow the page breaks this .docx declares
(N pages)". The tender card follows the same rule through `documentPageSummary` — a flowing `.docx`
reads "1 continuous block of text (no page breaks declared)". `numPages` is therefore the
document's **own** page count and every `pageNumber` is one of its page numbers, so no clause can
ever cite a page the file does not have. Pinned by `tests/docx-intake.test.ts` ("does not claim a
page count it cannot support") and `tests/docx-intake-copy.test.ts`.

**Preflight codes.** Every failure is typed and user-surfaceable (`DocxPreflightError` carries
`code`, `actual`, `limit`); **nothing returns a silent empty extraction** that would look like a
tender with no requirements. Cancellation is its own type (`DocxImportCancelledError`, code
`CANCELLED`) and returns no partial result.

| `DocxPreflightCode` | Raised when                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `FILE_TOO_LARGE`    | Over `DOCX_PREFLIGHT_LIMITS.maxBytes` — refused **before** the buffer is read               |
| `TOO_MANY_LINES`    | Over `maxLines` (24 600), checked once the line count is known and before the shredder runs |
| `TOO_MUCH_TEXT`     | Over `maxTextChars` (12 000 000), checked beside the line budget and before the shredder    |
| `ZIP_BOMB`          | Declared uncompressed size beyond `DOCX_ZIP_LIMITS` (zip bomb)                              |
| `PROTECTED`         | A CFB/OLE container: password-protected, or a legacy `.doc` wearing a `.docx` name          |
| `NOT_A_DOCX`        | Not a Word package at all (another format renamed, or no document part)                     |
| `CORRUPT`           | Truncated, damaged or unparseable package                                                   |
| `EMPTY_DOCUMENT`    | The document holds no content at all                                                        |
| `NO_TEXT`           | The document holds content but no text (pictures/drawings only)                             |

`DOCX_PREFLIGHT_LIMITS` deliberately reuses the PDF path's published per-file ceiling
(`PDF_PREFLIGHT_LIMITS.maxBytes`, 100 MiB) and states two budgets of its own:

- `maxLines` = **24 600**. A `.docx` "line" is a whole paragraph or table row, so the reason the
  PDF path needs a line budget applies here too, but not the PDF's own figure — the PDF's
  ~0.042 MB heap per line was measured on visual lines of ~40 characters, and a DOCX paragraph
  is 5–25× longer. What this path measured is a cost per LINE, because the parsed block model
  (not the text) dominates: 24 500 lines / 4.77 M characters retained ~112 MB through parse →
  `buildClauses` → `shredExtraction` in ~4.8 s, i.e. ~4.6 KB per line whether the line is 195 or
  1 087 characters.
- `maxTextChars` = **12 000 000**. `maxLines` alone does not bound what it looks like it bounds:
  `blockUnits` splits at the engine's soft/column/page breaks, so a paragraph with no break is
  ONE line of unbounded length, and a highly compressible `.docx` can declare up to
  `DOCX_ZIP_LIMITS.maxPartBytes` (512 MiB) of `document.xml` in a single paragraph. Measured:
  ~4.5 bytes of resident heap per extracted character and ~1 M characters per second through the
  same path, so 12 000 000 characters is ~54 MB of heap and ~12 s — 2.5× the 4 766 389
  characters of the 24 500-line realistic fixture, so the line budget still binds first for a
  normal document and this one exists for the shape a line count cannot see. Both are refusals
  before the shredder, never a truncation: a cut document would present a partial reading as a
  complete one. `tests/docx-intake.test.ts` pins both ("refuses too much text on too few lines,
  where a line count sees nothing"; "reports the extracted character count on the result"), and
  `intakeLimitDisclosure()` publishes the figure the guard enforces
  ("the advertised import limits are the enforced ones").

`DOCX_ZIP_LIMITS` belongs to the engine (`@genoffice/docx-engine`), so the conditions there are
mapped onto the union rather than re-derived.

**The AI vision pass refuses a Word source, before it consults the model.** A `.docx` has no
rendered page, so there is no page image to hand a model — whatever the configured model can do.
`importVision` (`components/TenderList.tsx`) checks the document **first** and only then
`settingsSupportVision`, deliberately: a vision-capable model would otherwise be handed a renderer
for a document that cannot be rendered, and the run would fail over a file it had read perfectly.
The refusal is `WORD_DOCUMENT_VISION_MESSAGE` ("This tender came from a Word .docx, which has no
rendered pages, so there is no page image to read."), the pass reports it, and **the pages the
local extractor flagged keep blocking readiness until a person compares them against the original
and marks them reviewed** — the same fail-closed rule as a scanned PDF page (§1a, §4). A
picture-only Word page is never called "scanned": no scanner ran, and the copy says so
(`PAGE_STATUS_EXPLANATION_WORD`). Pinned by `tests/docx-intake-copy.test.ts` ("checks the document
before the model, so a vision-capable model is not asked either").

### 3e. Diagnostics (the local log a support engineer can read)

The finding this answers is blunt: the app had **no log sink at all**. Every diagnostic in main
(the reminders scheduler's `log` hook, the store's refusals) and in the renderer (the
save-refusal warnings) went to a `console` a packaged Electron app gives the user no way to
read — no devtools, no file — so a support request could only ever be answered by guesswork.

Files:

- `apps/tenders/src/main/diagnostics-log.ts` — the sink.
  `createDiagnosticsLog({ dir, maxBytes?, maxFiles?, now? })` → `{ record(entry), path(), flush() }`.
  `DEFAULT_DIAGNOSTICS_MAX_BYTES` = **1 MiB** on the live file, `DEFAULT_DIAGNOSTICS_MAX_FILES` =
  **3** (the live file plus two rotated generations), so the directory can never hold more than
  **3 MiB** however long the app runs. `record()` is synchronous, returns nothing, never throws,
  and writes exactly one line per entry (a message's newlines are collapsed, so `tail -f` reads
  whole entries). Rotation is `name → name.1 → name.2`, dropping the oldest, and it is disabled
  for the rest of the session if a rotation fails, rather than retrying the same doomed rename on
  every entry. `DIAGNOSTICS_MAX_MESSAGE_CHARS` = 2 000, `DIAGNOSTICS_MAX_DETAIL_CHARS` = 500,
  24 detail keys.
- **The path: `<userData>/tenders/tenders-diagnostics.log`.** `diagnosticsLogDir(userDataDir)` =
  `<userData>/tenders` and `DIAGNOSTICS_FILE_NAME` = `tenders-diagnostics.log` — beside
  `tenders-data.json`, not inside it.
- **It never records document content**, and that is a property of the sink rather than a habit
  of its callers: `detail` values must be primitives (an object or array is dropped, not
  walked), every string is cut to 500 characters, and a list of keys that only ever carry
  document text (`clause`, `verbatimClause`, `title`, `text`, `requirements`, `workspaces`,
  `vault`, `buffer`, `html`, …) is refused outright.
- The file lives on **this** machine. Nothing is uploaded, nothing is networked, and each
  `record()` is a completed synchronous append, so closing the app cannot lose an entry already
  written.
- `apps/tenders/src/renderer/src/diagnostics.ts` — the renderer's half: `rendererDiagnostics`
  (`info` / `warn` / `error` / `record`), `createRendererDiagnostics`, `tendersDiagnosticsBridge`,
  `buildDiagnosticsEntry`, `sanitizeDiagnosticsDetail`. It mirrors every entry to `console` and
  forwards it to main; an absent or partial bridge is a no-op rather than a throw, a rejected
  `invoke` is swallowed, and the same content rule is applied on this side too. `store.ts`
  routes its save-refusal diagnostics through it.

Channels and preload members — both behind the same trusted-sender gate as every other handler,
and both returning a bare string `error` when refused (§3):

| preload member                                         | channel                               | direction                          |
| ------------------------------------------------------ | ------------------------------------- | ---------------------------------- |
| `recordDiagnostics(request: RecordDiagnosticsRequest)` | `tenders:diagnostics-record` (invoke) | renderer → main, one entry         |
| `diagnosticsPath()`                                    | `tenders:diagnostics-path` (invoke)   | renderer → main, the live log path |

- Main validates the shape and the bounds (`MAX_TENDERS_DIAGNOSTIC_MESSAGE_CHARS` = 2 000,
  `MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS` = 64, `MAX_TENDERS_DIAGNOSTIC_DETAIL_KEYS` = 24) and
  writes through the same rotating sink it uses itself. **The diagnostics surface is write-only
  from the UI**: there is no reader channel, so a renderer can add to the record and can never
  browse it.
- Both members are typed **optional** on `TendersApi` (`recordDiagnostics?`, `diagnosticsPath?`),
  because a stale preload legitimately lacks them and the renderer treats a partial bridge as no
  bridge.
- Main records its own failures through the same sink: a store read that failed (with its code
  and how many recovery copies are visible), a refused `saveStoreV2` / legacy write (with the
  code), a legacy read refusal, a recomputed readiness checkpoint, and the reminders
  scheduler's own log events.
- **Both former wiring gaps are now CLOSED, and this line used to say the opposite.** (a)
  `recordDiagnosticsStart(log, version)` — the one line a fresh session should start with, so a
  file attached to a support request says what wrote it — **is called from `registerTendersIpc`**
  in `main/ipc/handlers.ts`, before anything else can record (the `isTendersIpcRegistered` guard
  keeps it from being written twice), so a real session's log now opens with that line. §3e's
  earlier wording and §6 item 15 both described this as un-wired and were corrected against disk.
  (b) The renderer **does** render the log path to the user: `ErrorBoundary` takes an optional
  `diagnosticsPath` prop and `errorBoundaryLogHint(path, code)` names the file (and the code) in
  its fallback, which is the one surface where telling the user where the log is matters most.
  Pinned by `tests/diagnostics.test.ts` (the sink's bounds and rotation, the content rule, the
  renderer's no-op path, and the no-bridge save state) and `tests/ipc-handlers.test.ts`
  ("4c. Diagnostics transport", including a refusal for every untrusted sender).

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
- Additively (score weight **0**, §1a): unconfirmed readiness-critical fields / unresolved
  competing candidates, and pages whose content was never obtained. The page gate's predicate
  is `pageContentObtained` — a page a model read (`ai-extracted`) is content-obtained, so it
  stops blocking **that** gate, while every value lifted from it stays an unconfirmed model
  suggestion and blocks through the review gate instead (§5a). No AI output can clear the
  review gate.
- `NOT_APPLICABLE` resolves only with a dedicated `notApplicableReason` (never the generic
  automated `reason`); a valid N/A skips evidence and company checks.
- `parseClosingDate` accepts strict RFC 3339 (with timezone) plus ISO civil, day-first
  named-month (incl. `11h00` and ordinal suffixes), month-first, and day-first slash dates,
  each optionally followed by a clock time. Semantics:
  - Civil forms are **anchored in SAST (+02:00)**, and a **missing time means 23:59 SAST**
    (end of the stated SA civil day, i.e. 21:59Z) — not UTC. Anchoring in UTC made every SA
    deadline two hours late: "30 November 2026 at 11:00" is 09:00Z, the instant an 11:00 SAST
    deadline actually passes (`SAST_OFFSET_MS`, `sastInstant`). A fixed offset, not a timezone
    lookup, so day counts, expiry-at-closing and the runway are identical whatever timezone the
    app runs in. (This section said "anchored in UTC" and contradicted §3c, which already said
    the parser owns the SAST anchor; the code says SAST.)
  - **Tail tolerance.** Trailing noise carrying no date/time information — a parenthetical
    note, a timezone abbreviation, free text with no digit and no named month — is tolerated,
    so realistic RFP lines import. Trailing text carrying _any_ date/time information (a
    digit, a clock time, a year, a named month) makes the whole string ambiguous and rejects
    it, so an amended or competing deadline can never be swallowed into a wrong date.
  - RFC 3339 is accepted only as a whole-string timestamp (offset required).
  - Impossible, ambiguous and timezone-less values return null — as do dash dates such as
    `30-11-2026`, which the pre-fix parser accepted.
- **Day counts are civil-day readings, never rounded 24-hour quotients.** `daysBetween(a, b)`
  (`shared/readiness.ts`) folds both arguments onto the SA civil calendar first, and the
  runway's `daysAway` is that number: **1 November → 30 November is 29 days, not 30** (it used
  to be `Math.round` over raw instants, which added the 21:59Z wall clock of an end-of-day
  closing back onto the count). A 16:00 deadline is therefore 0 days away at 09:00 and 1 day
  away at 17:00 on the same civil day. It is **display only**: no decision may use it — a
  ranking or go/no-go compares instants, and the runway's own "recently closed" tail and its
  `.ics` "upcoming" filter (`buildIcs`) are decided on the instant for that reason. Pinned by
  `tests/readiness-invariants.test.ts` ("daysBetween is a civil-day reading, never a
  decision") and `tests/closing-date-parser.test.ts` ("the runway uses the same closing
  instant").
- **`docsAtClosing(tender, vault)` never assesses a document against a deadline the app does
  not have.** Every entry carries the instant it was assessed against, as a closed union —
  `DocAtClosing.closingDate: { status: 'KNOWN'; raw; instant } | { status: 'UNKNOWN'; raw:
string | null } | { status: 'UNPARSEABLE'; raw: string }`. With `UNKNOWN` (no closing value at
  all) or `UNPARSEABLE` (a value the canonical parser rejects), there is no instant to assess
  against, so `healthAtClosing.health` is `UNKNOWN` ("not assessed", the state `healthWillFail`
  already fails closed on), `daysUntilExpiry` / `daysSinceCertified` / `stampDaysLeft` are `null`
  rather than a fabricated day count, and `willFail` is `true`. The check says exactly why —
  "Cannot be evaluated: this tender has no closing date on file" or "the closing date "<raw>"
  could not be read", plus "Confirm the closing date first" — and earns **0** progress, because
  no assessment happened. It used to assess every document against `Date.now() + 90 days`, so a
  bid with no deadline at all was told its documents "remain valid through closing" on a
  timeline nobody stated. Only a **keyed** document entry can report this: with no linked
  document there is nothing the missing instant would have been used for, and the check is
  unchanged. Pinned by `tests/readiness-invariants.test.ts` ("an unknown closing instant is
  never fabricated"), `tests/intake-verification.test.ts` and
  `tests/compliance-gap.test.ts`.

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

## 5a. AI extraction (optional, additive — a deliberate boundary change)

The owner decided that Tenders may offer **optional AI extraction** alongside the local rule
engine, to raise extraction accuracy and to read scanned pages. It is additive in every
direction: the local engine stays the offline, always-available default, and with no API key
(or no network) the app behaves exactly as it did before this feature existed. The boundary this
changes — and what stays forbidden — is recorded in `README.md` ("Product-boundary reminder")
and `fork/COMPLIANCE.md`.

Files:

- `apps/tenders/src/shared/ai-extraction.ts` — the pure core: availability, chunking, prompt,
  defensive parsing, per-bound validation, merge, pipeline, and the vision read's prompt and reply
  parser. It imports nothing but `./types` (pinned by its test): no `node:*`, no `electron`, no
  `@genoffice/ai-provider`, no `fetch`; no clock, no randomness, no locale.
- `apps/tenders/src/renderer/src/ai/transport.ts` — the transport: it builds the core's injected
  call on the shared bridge, and is the one place the renderer reaches a model.
- `apps/tenders/src/renderer/src/ai/extract-with-ai.ts` — the adapter: the rule catalogue
  projection, the translation of a core suggestion into `ReviewCandidate` /
  `ExtractedRequirement` (`suggestedBy: 'ai'`), the duplicate-reference check, the fold into
  `intakeVerification`, and the vision pass (`runTenderAiPass`, `markModelReadPages`,
  `createVisionCompletion`, `settingsSupportVision`).
- `apps/tenders/src/renderer/src/pdf/page-image.ts` — one PDF page rendered to a downscaled image
  for a model to read (the vision lane, below).
- `apps/tenders/tests/ai-extraction.test.ts` — the core's behaviour guard; the model call is a
  deterministic double, so the whole file runs with no network.
- `apps/tenders/tests/ai-extraction-adapter.test.ts` — the adapter's guard: the translation,
  the candidate merge, the review fold, and the credential-rule delegation to the core.
- `apps/tenders/tests/ai-vision.test.ts` — the vision lane: page images, the read prompt and
  reply, the capability gate, the completion on the bridge, and the pass itself.
- `apps/tenders/tests/ai-pass-visibility.test.ts` — the pass store: visibility, the cancel /
  supersede refusals, and that its state adds no persisted key.
- `apps/tenders/tests/ai-e2e-contract.test.ts` and `e2e/tenders-ai-extraction.spec.ts` (with
  `e2e/tenders-ai-fixtures.ts`) — the contract the four e2e journeys assert on disk, and the
  journeys themselves over a local fake provider: AI off contacts nothing, AI on lands a marked
  unconfirmed suggestion, a failing/malformed reply degrades to the local extraction, and an
  interrupted run leaves a usable tender and writes nothing.
- `apps/tenders/tests/ai-honesty-copy.test.ts` and `tests/ocr-honesty-copy.test.ts` — the copy
  guards (see the honesty rules below).

### The channels are the shell's; Tenders registers none

`AI_CHANNELS` (`shared/ipc.ts`): `ai:get-settings`, `ai:stream`, `ai:stream-chunk`,
`ai:stream-cancel`. `ipcMain.handle` for every one is registered **once for the whole suite** by
`registerAiIpc()` (the docs app's function, called at module scope in
`apps/shell/src/main/index.ts`), and Tenders runs as a WebContentsView inside that same process —
so a second `ipcMain.handle` on any of them throws
("Attempted to register a second handler for 'ai:stream'"). Tenders therefore registers **zero**
AI handlers, and §3's handler count is **33** — every one of them a Tenders channel; none of them
an `ai:*` channel.

Preload pass-throughs (`TendersApi`, `apps/tenders/src/preload/index.ts`):

| member                                                            | channel                                        |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| `getAiSettings(): Promise<AiSettings>`                            | `ai:get-settings` (invoke)                     |
| `aiStream(request: AiStreamRequest): Promise<void>`               | `ai:stream` (invoke)                           |
| `aiStreamCancel(requestId: string): Promise<void>`                | `ai:stream-cancel` (invoke)                    |
| `onAiStream(handler: (chunk: AiStreamChunk) => void): () => void` | `ai:stream-chunk` (on; returns an unsubscribe) |

`AiSettings` / `AiStreamRequest` / `AiStreamChunk` are the canonical types from
`@genoffice/ai-provider`, re-exported by `shared/ipc.ts` as **type-only** imports (erased by the
bundler), so the wire shape is never restated and no Node-backed transport reaches the renderer
bundle through them. The settings the shell returns have already been through `activeProvider`;
the renderer passes the whole object back per request, main injects the key, and the renderer
never handles a key itself.

### The injected completion seam

```ts
type AiCompletion = (args: { system: string; user: string; signal?: AbortSignal }) => Promise<string>

runAiExtraction(input: AiExtractionRunInput): Promise<AiExtractionRun> // { merged, outcomes }
```

The core never knows which provider answered: a caller wraps `chatForProvider` /
`streamForProvider`, or passes a test double. A chunk whose call throws, or whose reply cannot be
read, is recorded in `outcomes` with an error and its pages stay unread — the run still returns
every other chunk's output, which is what makes the pass additive: nothing a model does can
remove or weaken the local engine's result.

### The run's wall-clock budget — a published time figure that is enforced

`chunkCount × per-request latency` was the quantity nothing bounded: a 500-page tender is many
chunks, and against a slow provider each call may legitimately occupy its own absolute cap, so a
run could last hours with only a manual Cancel. Two ceilings now bound it, both declared in
`renderer/src/ai/extract-with-ai.ts` and both handed down to the transport:

- `AI_EXTRACTION_CHUNK_BUDGET_MS` = **300 000** (5 minutes) — a ceiling on ONE model call, passed
  to `createTendersCompletion` / `createVisionCompletion` as `callTimeoutMs`, so a single call is
  stopped on a wall clock that wire activity cannot extend. It is a ceiling on one request, not a
  promise about a slow one: the idle-silence watchdog (`AI_EXTRACTION_SILENCE_TIMEOUT_MS` = 240 s)
  and the transport's own absolute cap (`AI_EXTRACTION_ABSOLUTE_TIMEOUT_MS` = 15 min) keep their
  jobs, and a call is bounded by the smaller of the deadlines armed.
- `AI_EXTRACTION_RUN_BUDGET_MS` = **900 000** (15 minutes) — a ceiling on the WHOLE run, text
  chunks and vision reads together, however many chunks the document needs.

The ceilings, the clock and the timers are all injectable (`AiRunBudget`, `DEFAULT_AI_RUN_BUDGET`),
so a test drives a deadline with a fake clock — no network, no sleeping, no wall time. What a
stopped run does follows the same rule as every other failure: the chunk that could not be sent is
recorded with `RUN_DEADLINE_REASON` (or `CHUNK_BUDGET_REASON` for a call that outlived its share),
its pages stay **unread** so they keep blocking readiness, and everything already extracted is
kept. The budget aborts the run's own signal — the path a Cancel click already took — so a run
stopped for time, a cancelled run and a superseded run all apply nothing. **The user is told, in
the pass's own warnings:** `runDeadlineWarning(budgetMs)` is prepended to `merged.warnings` ("The
AI extraction run reached its 15 minutes time budget and stopped. Everything it had read up to
that point is kept; the chunks it did not reach were not read by AI."), which the pass panel
renders. Pinned by `tests/ai-vision.test.ts` ("the run's wall-clock budget": one call bounded to
its share while every other chunk's result is kept, the whole run stopping at its deadline and
saying so, vision reads on the same clock with those pages left blocking, and a user's Cancel
reported as a cancellation rather than as the budget) and `tests/ai-extraction-adapter.test.ts`
("bounds one call on a wall clock the wire cannot extend, and cancels it in main").

**A failed chunk's class reaches the user too.** The shell's `ai:stream` handler classifies an
error chunk as `'timeout' | 'credits' | 'network' | 'overloaded'`; the transport turns that into
`AI_EXTRACTION_ERROR_CLASS_MESSAGES[code]` followed by the provider's own words in brackets
(`aiExtractionErrorMessage`), so a wrong key, an empty account, a rate limit and a dead connection
stop reading as one identical sentence. An unclassified failure keeps the provider's raw text —
except for a recognisable authentication failure, which gets the actionable
`AI_EXTRACTION_AUTH_FAILURE_MESSAGE` with the provider's text still quoted, because "HTTP 401"
alone tells a user nothing they can act on. None of these messages claims anything about the
extraction: a failed chunk means those pages were not read.

### Provenance — a model suggestion is never the parser's own read

- `ValueProvenance = 'parser' | 'ai'` and `valueProvenance(carrier)` are the only place "absent
  means parser" is decided (§1a); the schema accepts only that closed set.
- The core marks its own output: `AI_SUGGESTION_PROVENANCE = 'ai-suggested'`, `markProvenance()`
  (additive, non-mutating, idempotent), `isAiSuggested()`.
- Every suggestion `validateSuggestions` / `mergeExtractionChunks` returns carries the marker, and
  the renderer's adaptation translates it to the schema's `'ai'` — `toReviewCandidate` and
  `toExtractedRequirement` name every member rather than spreading, because the schema rejects
  unknown keys document-wide.
- The marker is **visible**, not a tooltip: `ExtractionReview.tsx` renders `AI_SUGGESTION_LABEL`
  = `'AI-suggested'` as its own always-visible chip with its own icon, on the field, on each
  candidate and on each requirement — and only for `'ai'`, so a parser value never wears it.
  `ai-e2e-contract.test.ts` pins the marker the e2e journeys assert against that label.

### No AI output may ever write `confirmed` — the standing rule

Three independent places enforce it, and none may be relaxed:

1. `AI_SUGGESTION_REVIEW_STATE = 'unconfirmed'` is the only review state the core can return
   (`MergedExtraction.reviewState`).
2. `deriveTenderReview` (renderer `ExtractionReview.tsx`) writes `state: 'unconfirmed'` for every
   field it builds; only a human action moves a field out of it.
3. The schema's review states are decisions, not provenance: `suggestedBy` records who produced a
   value and never changes `state`.

Consequence: a model-suggested value blocks readiness until a human confirms it — so an
`ai-extracted` page clears the **page** gate while the values lifted from it still block through
the **review** gate.

### The page status, the method and the readiness rule

- `PageExtractionStatus` gained `'ai-extracted'`; the `method` such a page records is
  `AI_VISION_METHOD = 'ai-vision'` (`shared/types.ts`). `method` stays an open string for
  backward compatibility with already-stored documents, so that constant — not a type — is what
  makes the reader unambiguous.
- `pageContentObtained(state)` is the single predicate (§1a). `unreviewedOcrPages` and
  `unprovenOcrPageCount` both use it, and `ai-extracted` counts as proof that one unreadable page
  was resolved — so the page gate stops blocking, while `TenderRecord.ocrPages` (the parser's own
  count) is never rewritten by a model read.
- A page whose text was never obtained still blocks readiness: `MergedExtraction.unreadPages` is
  the complement of `pagesRead` (`{ pageNumber, method: 'native-text' | 'ai-vision', chunkIndex }`),
  and a page with no text layer is never sent as text — it is either read as an image or left
  unread.
- **`ai-extracted` is reachable only for a PDF source.** The vision lane needs a page image, and
  a Word `.docx` has no rendered page, so `importVision` refuses one before it consults the model
  (§3d) and no read exists to mark. A picture-only Word page therefore keeps blocking with AI on
  or off, and only a human review clears it — the one place where "a page a model read stops
  blocking" does not apply, stated here so this section and §1a/§3d cannot be read against each
  other.
- The status is deliberately neither `native` (which claims the page has its own text layer) nor
  `manually-reviewed` (which claims a person read it): the content is available, nothing on it is
  confirmed. The renderer labels it "Model-read", gives it a non-human tone, and shows a model
  read's confidence as "model confidence", never "text confidence".

### The vision lane — reading a page that has no text layer

The local engine cannot read a page with no text layer, so such a page is either handed to a
model as an **image** or left unread (and an unread page keeps blocking, §4).

- `renderer/src/pdf/page-image.ts` — `renderPageImage(doc, pageNumber, options)`: one page of an
  already-parsed `PDFDocumentProxy`, rendered to a downscaled JPEG (`PAGE_IMAGE_MIME`,
  `DEFAULT_PAGE_IMAGE_MAX_EDGE` = 1500 px on the longest edge, `DEFAULT_PAGE_IMAGE_QUALITY` = 0.7)
  and returned as raw base64 with no `data:` prefix — the wire shape. Cost is what the cap is for:
  a native-resolution scan is an order of magnitude more tokens for text a model reads just as
  well. `pageImageSize` is pure (caps the longest edge, preserves the aspect ratio, never
  upscales); `decodeDataUrl` takes the mime from the encoder, so the declared type can never
  disagree with the bytes. Failure is per page and typed — `PageImageError` with
  `INVALID_OPTION | NO_CANVAS | RENDER_FAILED | ENCODE_FAILED | CANCELLED`, whose message is safe
  to show as that page's reason — never a blank or full-size image, and `page.cleanup()` always
  runs. Only pdf.js **types** are imported (the caller passes the document it parsed), so this
  module runs in a plain jsdom test. The canvas is painted white first: a PDF page is transparent
  wherever it has no content and a JPEG has no alpha channel, so an unpainted canvas would encode
  those areas black.
- `renderer/src/ai/extract-with-ai.ts` — `runTenderAiPass` is the whole pass: the text chunks,
  then `readScannedPages`, then **one** merge of both. `settingsSupportVision(settings)` mirrors
  the slides renderer's own gate (provider capabilities, then `modelLacksVision`) and withholds a
  vision read that would fail, because a page then keeps blocking and the caller says why, whereas
  attempting it would spend the user's tokens to learn nothing. `createVisionCompletion` builds
  the read on the shared bridge by passing the page image through `createTendersCompletion`'s own
  optional `images` argument, which puts it on the request's last user message — so the stream
  lifecycle (one listener, both watchdogs, the reply ceiling, `stopReason`) stays the one
  `createTendersCompletion` implementation and no second copy exists to drift. `AiVisionCompletion` is deliberately a **different type** from the core's
  `AiCompletion`, so a caller must be able to withhold it rather than have the pass quietly ask a
  model to transcribe an image it was never sent. `VISION_UNAVAILABLE_MESSAGE` and
  `VISION_CANCELLED_REASON` are complete sentences shown as-is.
- `shared/ai-extraction.ts` — `buildVisionReadPrompt` is a **transcription** request, not an
  extraction request: the reading becomes the page's _text_, which then goes through the same
  chunk → prompt → parse → validate path as a page carrying its own text layer. One extraction
  path and one set of honesty rules for both kinds of page, and the reading stays reviewable in
  its own right instead of arriving already digested into suggestions. `parseVisionReadReply`
  turns a reply into text or a failure, and two constants make a refusal safe:
  `VISION_UNREADABLE_MARKER` = `'UNREADABLE'`, the exact marker the prompt asks for when the image
  cannot be read — an explicit refusal protocol, because inferring failure from the reply's shape
  would let a prose refusal pass as the page's text, which is the one way a model could clear the
  page gate without having read anything — and `MIN_VISION_TRANSCRIPT_CHARS` = 20, the same
  threshold `extractSinglePage` flags `needsOcr` at, so a reading below it has produced no more
  usable text than the text layer it replaces.
- **Only pages the parser itself flagged `needsOcr` may be marked `'ai-extracted'`, and only when
  a read actually obtained text.** `markModelReadPages` is the only function that writes a page
  state; it intersects the read set with the parser's `scannedPages`, skips any page whose content
  is already obtained (a text layer, or a human's own review — a model read may never displace
  either), and writes nothing else. The reason is mechanical, not stylistic: readiness'
  `unprovenOcrPageCount` is **count-based** (`max(unresolved, ocrPages - resolvedUnreadable)`),
  so marking one page too many would over-subtract and **weaken** the page gate — the gate would
  clear on a document with an unread scanned page. `runTenderAiPass` makes the same rule hold
  upstream by emptying a flagged page's text before chunking, so `textlessPages` and the parser's
  flagged set are the same pages and no page can be marked from a text chunk that never existed.
  Pinned by `tests/ai-vision.test.ts` ("never marks a page the parser did not flag, even if a read
  claims it"; "never displaces a human's own review of a page").
- **A page is marked on the reading, not on the extraction over it.** A vision chunk whose
  extraction then produced nothing still records its pages as read — the content was obtained,
  there are simply no suggestions from it — while a refused, empty, too-short, unrenderable or
  failed reading leaves the page exactly as it was: still blocking. That is why
  `ChunkExtractionOutcome.method` exists: an `'ai-vision'` chunk's pages record a null
  `chunkIndex` (no text chunk read them) and can never be recorded as `'native-text'`, which would
  claim a text layer they do not have.

### The AI pass UI state and its apply gate

The pass is fire-and-forget and it enriches the tender that was just imported — and importing
**activates** that tender, which unmounts the list view. State in a `useState` there was gone
before the run had even started, so the run's state lives in a module-level store in
`renderer/src/components/TenderList.tsx` (`AiPassState`, `startAiPass`, `reportAiPassProgress`,
`reportAiPassChars`, `finishAiPass`, `failAiPass`, `cancelAiPass`, `dismissAiPass`,
`subscribeAiPass` / `getAiPassState` / `useAiPass`, and the `AiPassPanel` that renders it) —
plain data with subscribe/getSnapshot, the shape the suite already uses for renderer-only state
(`packages/ui/src/ai-panel-prefs-store.ts`), readable from the list view and from the workspace
and testable with no component harness. `components/Workspace.tsx` mounts it scoped to the tender
on screen (`<AiPassPanel tenderId={tender.id} … />`): progress and findings for a document the
user is not looking at would be feedback about the wrong tender.

- **A cancelled or superseded run applies nothing, and the gate is checked before any write.**
  `finishAiPass(runId, outcome)` returns `false` and records nothing unless that `runId` still
  owns the live run (`liveAiPass`), and `runAiPass` returns on `!accepted` **before** the first
  `updateTender` / `setTenderReview`. So a run stopped between the model answering and the apply
  step cannot write a requirement, a candidate or a page state — the tender keeps exactly what the
  local engine produced. `failAiPass` refuses the same way, so a cancelled run can never be
  relabelled a failure, nor the other way round; `cancelAiPass(runId)` takes the run's own id so a
  superseded attempt cannot cancel the attempt that replaced it. The run is made visible _before_
  anything can refuse it, so "no model configured" is recorded and read rather than swallowed.
- **This state is UI-only and must never be persisted into the authoritative document.** Nothing
  in the store is written to the tender or to the document: `store.ts`'s `partialize` enumerates
  the persisted keys (`page`, `view`, `zoom`, `currentPage`, `onboardingDone`, `activeTenderId`,
  `activeRequirementId`) and no key of this store is among them. A run's findings reach the
  document only the way any other suggestion does — `updateTender` / `setTenderReview`, as
  `unconfirmed` review material a person still has to confirm (§5a, "No AI output may ever write
  `confirmed`"). `tests/ai-pass-visibility.test.ts` pins this ("adds no persisted key, and changes
  nothing the store already persists").

### Availability — can this user run AI extraction, and if not why not

`aiExtractionAvailability(input)` → `{ available: true, provider, model, visionCapable }` or
`{ available: false, reason: 'no-provider-configured' | 'no-api-key' | 'no-model', message }`.

- Pure and dependency-free, so the settings are typed structurally (`AiSettingsLike`); the same
  rule that keeps the core importable in a browser and a plain jsdom test.
- It mirrors the gate that actually decides a stream, in order: `activeProvider`'s fallback to
  the BYOK default (`AI_FALLBACK_PROVIDER`), then **the resolved provider's own credential**,
  then a model id. A stored selection is usable when **both** hold: a model id (except for a
  CLI provider, which picks the account's own current default) **and** the credential its
  provider kind requires. The credential shape is the one table,
  `AI_PROVIDER_AUTH_KINDS: Record<string, 'api-key' | 'base-url' | 'cli' | 'sign-in'>`, and the
  three derived lists — `AI_KEYLESS_PROVIDERS`, `AI_BASE_URL_PROVIDERS`,
  `AI_SIGN_IN_PROVIDERS` — are read off it rather than listed again, so a provider's kind is
  stated once:
  - `'api-key'` (the default, and every provider absent from the table) — a non-empty
    `apiKey.trim()`.
  - `'base-url'` (today exactly `custom`) — a non-empty `baseUrl.trim()`, and the key stays
    **optional**: custom OpenAI-compatible endpoints (Ollama, LM Studio, vLLM) accept anonymous
    requests.
  - `'cli'` (today exactly `codex`) — nothing at all: no key and no model id, because the CLI is
    already signed in.
  - `'sign-in'` (today exactly `genspark`) — nothing, because main fetches the key from the
    app's own login per request. A model id is still required of it, exactly as the
    main-process guard requires one of every provider but codex.
- All of it is restated rather than imported — the module may not import `@genoffice/ai-provider`
  — and `tests/ai-extraction.test.ts` pins the table against the catalogue's `needsCliPath` /
  `needsBaseUrl` flags and the registry's `codex-chatgpt` / `gsk-login` / `api-key` auth, so the
  two cannot drift silently.
- The caller supplies **no override list**. The old `keylessProviders` / `baseUrlProviders`
  inputs were deleted: a caller able to extend the keyless or base-URL set could make one
  settings object answer two ways, which is the drift a single source of truth exists to
  prevent. `AiAvailabilityInput` carries the settings, an optional fallback id and the caller's
  vision answer — nothing else.
- `'no-api-key'` is the "the credential is missing" bucket, and its message names what is
  actually missing for **this** provider — a base URL where that is the credential. The
  renderer shows the helper's own per-reason `message` verbatim: `AI_MODEL_SETTINGS_HINT` was
  deleted, so there is no second copy of this copy to fall out of step with the reason
  (`readAiReadiness` passes `message: availability.message` through and adds nothing).
- `visionCapable` is the **caller's** answer to "can this model read an image"
  (`modelLacksVision` lives in `@genoffice/ai-provider/browser`, which this module may not
  import) and is echoed back unchanged. It is deliberately not a fourth reason: a text-only model
  still runs the pass over every page that carries a text layer; it only cannot read a scanned
  page, and the caller decides what to do about that.
- Unavailable is not an error and never stops the app: the message is the reason the _optional_
  pass is off, and the local engine keeps working.

### Limits

| Constant (core)                                                                                                                                                                      | Value                                 | Mirrors / why                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------ |
| `DEFAULT_EXTRACTION_CHUNK_CHARS`                                                                                                                                                     | 24 000                                | `READ_CHUNK_CHARS` in `apps/pdf/src/renderer/ai/tools.ts`                      |
| `MAX_REQUIREMENTS_PER_CHUNK`                                                                                                                                                         | 64                                    | headroom over the 27-rule catalogue                                            |
| `MAX_METADATA_SUGGESTIONS_PER_CHUNK`                                                                                                                                                 | 64                                    | one chunk's metadata budget                                                    |
| `MAX_PARSED_ITEMS_PER_CHUNK`                                                                                                                                                         | 128                                   | bounds what a hostile reply can push into validation                           |
| `MAX_REQUIREMENTS_PER_RESULT`                                                                                                                                                        | 5 000                                 | `MAX_TENDERS_REQUIREMENTS_PER_TENDER`                                          |
| `MAX_METADATA_CANDIDATES_PER_FIELD`                                                                                                                                                  | 16                                    | `MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD`                                      |
| `MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT`                                                                                                                                             | 8                                     | held far below `MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT` (1 000)        |
| `MAX_SOURCE_CLAUSE_CHARS` / `MAX_REQUIREMENT_CLAUSE_CHARS` / `MAX_REQUIREMENT_TITLE_CHARS` / `MAX_REQUIREMENT_NOTES_CHARS` / `MAX_METADATA_VALUE_CHARS` / `MAX_REQUIREMENT_ID_CHARS` | 2 000 / 4 000 / 200 / 500 / 512 / 128 | quoted-evidence and label bounds, all inside `MAX_TENDERS_SINGLE_STRING_CHARS` |

The numeric mirrors (`MAX_REQUIREMENTS_PER_RESULT`, `MAX_METADATA_CANDIDATES_PER_FIELD` and
`MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT`) are restated in the core, not imported, and **no test
pins them against `tenders-persistence.ts`** — see §6 item 13. (The provider constants above —
`AI_FALLBACK_PROVIDER` and `AI_PROVIDER_AUTH_KINDS` with the three lists derived from it _are_
pinned, by `tests/ai-extraction.test.ts`, against the catalogue's flags and the registry's auth.)

### Honesty rules the copy must carry

Two guards scan the renderer's source text:

- `ai-honesty-copy.test.ts` — every surface on the AI journey states that AI extraction is
  optional, that the local rule engine is offline and always available, that using AI sends the
  document's text (or a scanned page's image) to the model provider the user configured, and that
  what comes back is unconfirmed until the user confirms it. A model's output may never be called
  verified, accurate or trustworthy, and no surface may imply AI (or an API key) is required to
  extract.
- `ocr-honesty-copy.test.ts` — the LOCAL engine never reads a page with no text layer; a
  "scanned pages are read" claim is honest only when the same sentence names AI as the reader;
  and the universal "text layer of every page" claim stays forbidden outright, because no reading
  path — local or model — reads a text layer off a page that has none.

## 5b. The module map, the diagnostics log and the test infrastructure

**The structural reference is now `module-map.md`** in this folder — where each responsibility
lives after the composition-root split, the import-graph direction, the IPC arithmetic recounted
from disk, the diagnostics log's path and bounds, the test-infrastructure additions, and the
**no-blank-screen** invariant. Read it beside this file; it states structure, this one states
behaviour, and this one wins on every point of behaviour.

Three things from it that this document must not contradict:

- **`apps/tenders/src/main/tenders-main.ts` is now the composition root only (347 lines; it was
  3,702)**, and `main` imports **nothing** from `renderer/` — the demo dataset moved to
  `shared/demo-seed.ts` and the renderer's mock modules re-export it. **The IPC arithmetic is
  unchanged:** 33 `ipcMain.handle` registrations, now all in `main/ipc/handlers.ts`, each still
  beginning with `isTrustedTendersEvent` (verified mechanically, not by reading). §3's count and
  channel breakdown stand.
- **The diagnostics log's path and bounds are `<userData>/tenders/tenders-diagnostics.log`, 1 MiB
  live × 3 files = 3 MiB maximum** (§3e), and the surface stays **write-only** from the UI. §6 item
  15's two gaps are **CLOSED**: `recordDiagnosticsStart` is called from `registerTendersIpc` before
  anything else can record, so a real session's log opens with the line that says what wrote it, and
  `ErrorBoundary` renders the log path to the user in its fallback.
- **The no-blank-screen invariant has LANDED.** `renderer/src/components/ErrorBoundary.tsx` is a
  React class boundary catching a render/lifecycle/effect throw and showing an honest, recoverable
  fallback instead of an empty window; it is mounted twice — once in `renderer/src/main.tsx` around
  `<App />` (covering the sidebar, modals, tour and the shell render itself) and once in
  `App.tsx` around the page area, so a crash in one view keeps the sidebar and its navigation.
  Recovery is a **remount** of the child subtree under a new `key`, not a re-render, because the
  same element would simply throw again and a retry that cannot work is a worse lie than no button.
  **The fallback claims only what is true:** the window is still running and navigation still works;
  the failure was written to the diagnostics log as an **error code plus a component stack and
  nothing else** — deliberately not the error message, which can embed the tender text that choked
  it, so the content rule holds even here; and **nothing was confirmed on the user's behalf**, which
  is what keeps the app's core invariant intact through a crash. It never claims data was lost, and
  never claims it is intact. It cannot catch an event-handler or async throw (React's own limit),
  which is why every cross-app call still reports its own failure visibly. Pinned by
  `tests/components/error-boundary.test.tsx`.

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
11. **CLOSED for the import path (AI wave).** `shredFile` (`components/TenderList.tsx`) runs the
    extracted `referenceNumber` through `checkDuplicateReference` against the workspace's own
    tenders and, on a collision, writes `null` instead of the colliding value and reports it
    through `onDuplicateReference` — so a re-import can no longer leave a workspace unsavable,
    and the user is told why. What the schema's own rule still does is the backstop: a duplicate
    introduced **outside** the import path (a value typed into the extraction review, a
    hand-edited document, a migration) still fails `semanticChecks` document-wide, with the
    failing field path surfaced instead of a silent failure.
12. `onStoreChangedV2` is not adopted while a save is in flight (`isSaveInFlight` /
    `isSavePending` / `isMigrating`); a genuine external write received in that window
    reconciles as a `REVISION_CONFLICT` on the next save (never a silent overwrite or
    loss). Alternative: exclude the originating WebContents in main's commit broadcast so
    external writes can be adopted immediately.
13. **CLOSED (remediation wave).** The AI core restates three bounds and the provider catalogue's credential
    facts instead of importing them (§5a): `MAX_REQUIREMENTS_PER_RESULT` (mirrors
    `MAX_TENDERS_REQUIREMENTS_PER_TENDER`), `MAX_METADATA_CANDIDATES_PER_FIELD` (mirrors
    `MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD`), `MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT` (held far
    below `MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT`), and `AI_FALLBACK_PROVIDER` +
    `AI_PROVIDER_AUTH_KINDS` with the three lists derived from it (`AI_KEYLESS_PROVIDERS`,
    `AI_BASE_URL_PROVIDERS`, `AI_SIGN_IN_PROVIDERS`), which mirror the provider catalogue's
    `needsCliPath` / `needsBaseUrl` flags, the registry's auth (`codex-chatgpt`, `gsk-login`,
    `api-key`) and `activeProvider`'s fallback. The provider facts are pinned by
    `tests/ai-extraction.test.ts`, which reads the catalogue source, and **the three numeric
    mirrors are now pinned too** — `tests/tenders-persistence-bounds.test.ts` reads
    `shared/ai-extraction.ts` as text and compares each pair ("the AI core's numeric mirrors of
    the persistence bounds"), which is how it avoids importing a module the core may not import.
14. **The legacy v1 writer still has one caller outside Tenders** (§2b, measured): the milestone
    billing reconciliation in `apps/books/src/main/books-main.ts` dynamically `require`s
    `apps/tenders/src/main/tenders-main` and calls `readTendersStore` / `writeTendersStore` on
    `<userData>/tenders/tenders-data.json`, falling back to writing that file itself when the
    require fails. It is not a Tenders surface and it predates the v2 store, but it means
    "`tenders-data.json` has exactly one writer" is true of this app only. Delete the path (Books
    owns it) or route it through the Books port, and drop the qualifier in §2b.
15. **CLOSED.** Both diagnostics wiring gaps (§3e) are now closed, and this item used to record
    them as open. (a) `recordDiagnosticsStart(log, version)` is called from `registerTendersIpc`
    in `apps/tenders/src/main/ipc/handlers.ts`, before anything else can record, so a real
    session's log opens with the line that says what wrote it. (b) A surface renders the log path:
    `ErrorBoundary` (`renderer/src/components/ErrorBoundary.tsx`) takes an optional
    `diagnosticsPath` prop and its fallback names the file and an error code via
    `errorBoundaryLogHint`, so the user is told where to look at the moment it matters most.

## 7. The e2e lane's timing contract (why the windows are what they are)

The Tenders e2e lane is **load-sensitive by construction**, and this section exists because that
fact cost this project hours twice: a run against a loaded machine reported a _shifting_ set of
failures, each of which passed when run alone.

### What was measured

Both figures come from a purpose-built measurement spec run against the built shell over a scratch
profile, polling the real store file every 50 ms and timing one real commit:

| Commit                                         | Healthy wall time (observed by poll)              |
| ---------------------------------------------- | ------------------------------------------------- |
| Workspace created through the first-use dialog | **907 ms** from the click; **227 / 234 / 472 ms** |
| A shredded tender's requirements reaching disk | **348 ms**                                        |
| A requirement status change reaching disk      | **599 ms** first edit, then **4 ms** and **7 ms** |

The last row is the informative one: 599 ms on the first edit, then single-digit milliseconds,
because the product's own 300 ms autosave debounce had already elapsed for the later edits. So a
healthy commit is observed by a poll in **under ~600 ms**, and the slowest thing any journey has to
cover is **under 1 s**.

### The windows, and why these figures are safe

`e2e/tenders-timing.ts` is the single place the lane's poll windows are declared. It exports one
`pollStore` / `readStore` / `storeFile` / `storeSignature`, and eight specs import them rather than
each carrying a hand-picked number that could drift apart again (`cli-control.spec.ts` is the
repo's precedent for a shared e2e helper with no test case of its own).

| Constant                 | Value      | Basis                                                               |
| ------------------------ | ---------- | ------------------------------------------------------------------- |
| `STORE_COMMIT_POLL_MS`   | **12 000** | **20× the slowest measured healthy commit (599 ms)**                |
| `STORE_IMPORT_POLL_MS`   | **30 000** | a whole shredded document — parse, matrix, commit                   |
| `FIXTURE_SETTLE_POLL_MS` | **60 000** | a test-process-driven fixture settling; covers harness latency only |

**The figures that were replaced, so the change is auditable.** The per-spec defaults and explicit
windows were: `20_000` (billing guard, demo isolation, first-use CRUD, intake review, regression
smoke, persistence cutover's `expectStoreStable` slack of `+4_000`); `25_000` (lifecycle,
persistence cutover); `30_000` (AI fixtures, docx intake, and explicit calls in the AI extraction,
intake review, persistence cutover and regression smoke specs); `15_000` (billing guard's two
`BILLED`-milestone polls); and `45_000` (the smoke's shredded-tender poll — **the one window that
was already generous** and is now `STORE_IMPORT_POLL_MS`). The a11y/theme spec's repeated **20 s**
visibility gates became a named `UI_SETTLE_TIMEOUT_MS` = **60 000**; its `settledPdfSignature`
helper's hard-coded twelve × 350 ms sleeps became an `expect.poll` on the same 350 ms interval with
a 60 s window, so a slow _paint_ is no longer what fails a **theme** assertion.

**Why a window 20× the healthy latency is not "tight".** It is the margin a runner needs when the
machine is shared. Two consecutive `pollStore` calls leave well over 100 s of headroom on an idle
machine and still finish inside the suite's own ceiling when it is 4–9× oversubscribed.

### What was deliberately NOT done, and why

- **No window was widened to hide a broken behaviour.** Every `pollStore` call still returns the
  last document read, so every caller's `expect(store, …)` still fails when the predicate never
  becomes true. What changed is only the _time allowed for a correct behaviour to be observed_.
- **The close-guard journey's timing gate keeps its figure and its meaning.** Journey 7 of
  `tenders-persistence-cutover.spec.ts` measures the product's own **300 ms** autosave debounce on
  the renderer's own clock (`closeFlushFromScheduleMs`), because that measurement is the whole
  point of the journey: it is what rules out the debounce having been what committed the edit. It
  was measured at **328 ms** and at **exactly 300 ms** on loaded machines. Its figure is **not**
  widened — widening it would make those races pass too, and the measurement exists to catch them.
  What changed is its **failure message**, which now says which side was at fault: both timestamps
  are renderer-clock readings, so an overrun there is the **close path's own IPC hops under load**,
  not the debounce and not a dropped edit, and the message says so and says to re-run the journey
  alone before treating it as a regression.
- **A window is not reduced to buy parallelism.** `e2e/playwright.config.ts` already runs the whole
  suite with `workers: 1` and `fullyParallel: false`, because the specs launch real Electron
  instances that fight over the GPU cache. There is no parallelism left in the Tenders lane to
  trade away.

### The operational rule

**A failure that passes when run alone is a load artefact, not a regression.** Treat the isolated
run as the verdict and re-run the suite serially — do not "fix" it. `fork/RUNBOOK.md` carries this
rule alongside the suite's healthy and loaded wall times, because it is the fact a reader needs
before they touch anything.

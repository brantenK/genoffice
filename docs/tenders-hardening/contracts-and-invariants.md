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

The optional AI extraction pass adds **no channel and no handler** to this list: it goes
through the shell's own `ai:*` channels (`AI_CHANNELS`), which Tenders only mirrors in the
preload. See §5a.

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
AI handlers, and §3's handler count stays **23**.

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
13. **The AI core restates three bounds and the provider catalogue's credential facts instead of
    importing them** (§5a): `MAX_REQUIREMENTS_PER_RESULT` (mirrors
    `MAX_TENDERS_REQUIREMENTS_PER_TENDER`), `MAX_METADATA_CANDIDATES_PER_FIELD` (mirrors
    `MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD`), `MAX_ADDITIONAL_CLAUSES_PER_REQUIREMENT` (held far
    below `MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT`), and `AI_FALLBACK_PROVIDER` +
    `AI_PROVIDER_AUTH_KINDS` with the three lists derived from it (`AI_KEYLESS_PROVIDERS`,
    `AI_BASE_URL_PROVIDERS`, `AI_SIGN_IN_PROVIDERS`), which mirror the provider catalogue's
    `needsCliPath` / `needsBaseUrl` flags, the registry's auth (`codex-chatgpt`, `gsk-login`,
    `api-key`) and `activeProvider`'s fallback. The provider facts are pinned by
    `tests/ai-extraction.test.ts`, which reads the catalogue source; the three numeric mirrors are
    **not** pinned by any test yet, because the core may not import `tenders-persistence.ts` — a
    test that compares the three pairs would close that gap.

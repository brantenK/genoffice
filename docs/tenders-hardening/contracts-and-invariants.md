# Tenders — Contracts and Invariants (Phase 1–2 foundation)

Technical reference for the machinery already built. Treat everything here as
**must not regress** unless a phase explicitly changes it.

## 1. Persistence schema (v2)

Files:

- `apps/tenders/src/shared/tenders-schema.ts` — pure validation + migration
- `apps/tenders/src/shared/tenders-persistence.ts` — DTOs + limits
- `apps/tenders/src/shared/types.ts` — additive `TendersDataV1` / `TendersDataV2` / `TendersWorkspaceV2`

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
  snapshot is `demo`. Any edit ⇒ `user`. Never classify by ID alone.
- Prototype-named dynamic keys (`__proto__`, `constructor`, `prototype`) preserved exactly.
- Idempotent, non-mutating, deep-cloned outputs.

Limits (exported from `tenders-persistence.ts`):

| Constant                                         | Value   |
| ------------------------------------------------ | ------- |
| `MAX_TENDERS_STORE_FILE_BYTES`                   | 8 MiB   |
| `MAX_TENDERS_DOCUMENT_BYTES`                     | 1.5 MiB |
| `MAX_TENDERS_IPC_PAYLOAD_BYTES`                  | 2 MiB   |
| `MAX_TENDERS_WORKSPACES`                         | 100     |
| `MAX_TENDERS_CUSTOMERS_PER_WORKSPACE`            | 10000   |
| `MAX_TENDERS_VAULT_DOCS_PER_WORKSPACE`           | 10000   |
| `MAX_TENDERS_TENDERS_PER_WORKSPACE`              | 5000    |
| `MAX_TENDERS_REQUIREMENTS_PER_TENDER`            | 5000    |
| `MAX_TENDERS_MILESTONES_PER_TENDER`              | 5000    |
| `MAX_TENDERS_ISSUER_TEMPLATES`                   | 1000    |
| `MAX_TENDERS_REQUIRED_DOCS_PER_CUSTOMER`         | 1000    |
| `MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT` | 1000    |
| `MAX_TENDERS_SINGLE_STRING_CHARS`                | 32768   |
| `MAX_TENDERS_AGGREGATE_STRING_CHARS`             | 1048576 |
| `MAX_TENDERS_DYNAMIC_ENTRIES`                    | 2000    |
| `MAX_TENDERS_DYNAMIC_KEY_CHARS`                  | 256     |
| `MAX_TENDERS_SCHEMA_ISSUES`                      | 500     |
| `MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD`        | 16      |
| `MAX_TENDERS_REVIEW_REQUIREMENTS`                | 5000    |
| `MAX_TENDERS_REVIEW_CONFLICTS`                   | 128     |
| `MAX_TENDERS_PAGE_STATES`                        | 5000    |
| `MAX_TENDERS_LIFECYCLE_HISTORY`                  | 500     |
| `MAX_TENDERS_READINESS_BLOCKERS`                 | 64      |

### 1a. Intake verification (Phase 3 — additive on schema v2)

`TenderRecord.intakeVerification?` is an **optional, additive** field on schema v2 (no
version bump; a document without it still validates exactly as before). It holds the
extraction-review state: per readiness-critical field a state plus the chosen value and the
original extracted candidate(s) (provenance), requirement-review annotations, and per-page
extraction state (`native | ocr-required | ocr-unavailable | ocr-failed | manually-reviewed`).

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
- `load` `stat`s and rejects oversize before reading.
- Deep-clone isolation in and out.

## 3. IPC + preload bridge

Files: `apps/tenders/src/shared/ipc.ts`, `apps/tenders/src/preload/index.ts`,
`apps/tenders/src/main/tenders-main.ts`

New v2 channels: `tenders:load-store-v2`, `tenders:save-store-v2`, `tenders:store-changed-v2`.
Preload API: `loadStoreV2`, `saveStoreV2`, `onStoreChangedV2` (direct objects, not JSON strings).

Authorization (applies to **all 14 privileged handlers**):

- `isTrustedTendersEvent` requires: sender is a registered active Tenders WebContents,
  `senderFrame.parent === null` (top frame only), and trusted origin matching
  `runtime.rendererUrl` (or packaged `rendererFile` URL); falls back to
  `webContents.getURL()` when frame missing.
- Rejection shape: `{ ok:false, error:{ code:'INVALID_REQUEST', message:/authoriz|trusted|registered/i } }`,
  with no side effects.
- `isTrustedTendersWebContents` filters broadcast recipients for both `store-changed-v2`
  and legacy `dataChanged`.
- Lifecycle helpers used by tests: `resetTendersIpcForTests()`,
  `isTendersIpcRegisteredForTests()`; `ipcRegistered` set only after full registration.

Legacy compatibility (renderer still on legacy channels):

- `getStoredData` / `saveStoredData` remain, now authorized.
- Legacy save **rejects** overwriting any existing authoritative document with numeric
  `schemaVersion >= 2` (including 3 and non-integers).
- `syncWithCrm` and `billMilestoneInBooks` go through the authoritative store `mutate`,
  ignore renderer-supplied `tendersPath` / `crmDealsPath` / `userDataDir` (main resolves
  from `app.getPath('userData')`), accept optional `expectedRevision` (stale ⇒ conflict),
  and return a compact `currentRevision` on conflict.
- Billing idempotency key: `crmDealId = tender-milestone-<tenderId>-<milestoneId>`; the
  revision is reserved via `mutate` before posting the invoice, so a conflict posts zero
  invoices and a retry posts exactly one.

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
  named-month (incl. `11h00`), month-first, and slash dates. Rejects impossible/ambiguous
  values and timezone-less datetimes.

## 5. Proposal generation

File: `apps/tenders/src/main/proposal-generator.ts`

- `generateProposalMarkdown(input, options?)`. Ready language requires a **main-owned,
  binding-verified `readinessReport`** and consistent confirmed positive pricing.
- Phase 4 supplies that report: main loads the authoritative document, builds the
  `ReadinessReport` itself, and binds it to `{tenderId, revision, fingerprint}`. The expected
  binding is derived from independently resolved main facts (requested tender id + loaded
  document revision), so any drift withholds the report. Renderer-supplied
  `readinessReport`/`ready` is ignored.
- Unbound or mismatched reports still yield `DRAFT — READINESS NOT INDEPENDENTLY VERIFIED`.
  A renderer-only readiness claim can never produce `READY`/`CLEARED`; a truthful positive
  `READY` is reachable only through the canonical, fingerprint-matched report.
- No fabricated methodology, staffing, safety, certification, VAT, payment terms, or
  zero-valued pricing schedules. Missing data is stated as not provided.
- Blockers are deduplicated by stable IDs; `en-ZA` formatting; `Cf` controls stripped;
  Markdown table cells escaped.

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
3. `resetTendersIpcForTests` deletes the real `documents` directory; gate it to test mode.
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
9. Tenders `WebContentsView` has no `will-navigate` / `setWindowOpenHandler` deny-by-default.

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

10. Renderer pre-validation (`store.ts` → `validateTendersDataV2` before `saveStoreV2`)
    does not mirror main's byte bounds (`MAX_TENDERS_DOCUMENT_BYTES`, IPC payload cap);
    an over-size but schema-valid document passes the renderer and is rejected visibly in
    main. Add the size checks to the renderer pre-validation for symmetry.
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

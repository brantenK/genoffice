import type { TendersDataV2 } from './types'
import type { TendersSchemaIssue } from './tenders-schema'

export const TENDERS_PERSISTENCE_FILE_NAME = 'tenders-data.json' as const
export const MAX_TENDERS_STORE_FILE_BYTES = 8 * 1024 * 1024
/**
 * Ceiling for one serialized document: the renderer pre-check, `save`, and the
 * `dataChanged` broadcast all measure the compact JSON against this value.
 *
 * Raised from 1.5 MiB after measuring the document shape intake verification
 * creates: one shredded tender at the requirement cap (5 000) plus per-page
 * extraction state at its cap (5 000) plus 16 candidates per readiness-critical
 * field serialises to 3 026 314 bytes (2.89 MiB) — 1.9x the old ceiling, so a
 * fully reviewed tender became unsaveable and the workspace wedged. 4 MiB leaves
 * that shape ~38% headroom.
 *
 * This is the one *actionable* document bound: `MAX_TENDERS_AGGREGATE_STRING_CHARS`
 * is held at the same number of characters so it can never bind first (see its
 * comment), and the renderer mirrors this value to report the refusal with a way
 * forward.
 *
 * This ceiling must stay well below `MAX_TENDERS_STORE_FILE_BYTES`: the file
 * actually written is the same document pretty-printed (2-space indent), which
 * measured ~2.0x for record-heavy documents and up to 3.57x for arrays of empty
 * strings. `tenders-store` therefore also refuses to commit a document whose
 * pretty-printed payload would exceed the store-file ceiling, so a file committed
 * through `tenders-store` is always one its own loader reads back.
 * `writeTendersStore` in `tenders-main.ts` applies the same store-file ceiling
 * before it writes, so every writer is bounded by the file its loader accepts.
 */
export const MAX_TENDERS_DOCUMENT_BYTES = 4 * 1024 * 1024
/**
 * Ceiling for the outer `saveStoreV2` request (the document plus its envelope).
 * Kept strictly above `MAX_TENDERS_DOCUMENT_BYTES` so the document ceiling — the
 * one the renderer mirrors and reports with an actionable message — is always the
 * binding constraint, never this envelope check.
 */
export const MAX_TENDERS_IPC_PAYLOAD_BYTES = 5 * 1024 * 1024
export const MAX_TENDERS_WORKSPACES = 100
export const MAX_TENDERS_CUSTOMERS_PER_WORKSPACE = 10_000
export const MAX_TENDERS_VAULT_DOCS_PER_WORKSPACE = 10_000
export const MAX_TENDERS_TENDERS_PER_WORKSPACE = 5_000
export const MAX_TENDERS_REQUIREMENTS_PER_TENDER = 5_000
export const MAX_TENDERS_MILESTONES_PER_TENDER = 5_000
export const MAX_TENDERS_REQUIRED_DOCS_PER_CUSTOMER = 1_000
export const MAX_TENDERS_ADDITIONAL_CLAUSES_PER_REQUIREMENT = 1_000
export const MAX_TENDERS_REVIEW_CANDIDATES_PER_FIELD = 16
export const MAX_TENDERS_REVIEW_REQUIREMENTS = 5_000
export const MAX_TENDERS_REVIEW_CONFLICTS = 128
export const MAX_TENDERS_PAGE_STATES = 5_000
export const MAX_TENDERS_LIFECYCLE_HISTORY = 500
export const MAX_TENDERS_READINESS_BLOCKERS = 64
// Durability (Phase 5 WP-9 managed files + WP-2 backups/recovery).
/** Rotating last-known-good copies of `tenders-data.json` kept per store. */
export const MAX_TENDERS_BACKUPS = 5
/** Recovery candidates returned by one `listRecoveryCandidates` call. */
export const MAX_TENDERS_RECOVERY_CANDIDATES = 64
/**
 * Serialized size cap for the managed-document metadata index
 * (`<baseDir>/managed-documents.json`).
 *
 * It bounds **growth of the metadata collection**: a write that adds a record is
 * refused when the serialized index would exceed it (see `writeIndex`). Writes
 * that add no record — trash, restore, empty-trash, and `reconcile`'s
 * missing/active flips — are deliberately allowed past it, so a full index can
 * never wedge the user out of deleting a document, which is also why `readIndex`
 * never refuses a large index (refusing to read would hide the very documents the
 * user needs to delete). The collection can therefore only exceed this ceiling
 * through such a non-growing write on an index that was already over it, which
 * requires an index written by an older build or edited outside the app: the name
 * clamp and the per-record cost below keep every record the store writes inside
 * `MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD`, so the record-count caps bind
 * first by construction.
 */
export const MAX_TENDERS_MANAGED_INDEX_BYTES = 4 * 1024 * 1024
/**
 * Longest file name the store writes into the index (extension preserved).
 *
 * The record caps below are derived from the serialized cost of one record, and
 * an unbounded name defeats that arithmetic: each name character costs 2 bytes of
 * a record (file name and relative path) and 3 once the record is trashed (its
 * trashed path repeats the name). Clamping at 80 characters also keeps the
 * derived paths inside the 255-character file-name limit every supported
 * filesystem enforces — measured: a 255-character name makes `save` fail with
 * ENOENT before anything is written, and `.trash/<record id>__<name>` (39 + 2 +
 * name characters) would fail the soft-delete rename *after* a successful save.
 * 80 characters still holds every realistic name: the heaviest measured
 * certificate name is 65 characters.
 */
export const MAX_TENDERS_MANAGED_FILE_NAME_CHARS = 80
/**
 * Serialized cost of one index record. This is the measured worst case the store
 * can write at `MAX_TENDERS_MANAGED_FILE_NAME_CHARS`, not an estimate: a record
 * carrying every optional field (`missing` with `trashedAt`, `trashedPath`,
 * `missingAt` and `replacedBy` all set — the shape a failed restore of a
 * replaced document leaves), an 80-character file name and the longest MIME type
 * the store maps (`…spreadsheetml.sheet`, 65 characters) serialises to **815
 * bytes**. 832 leaves ~2% headroom over that measured maximum and covers every
 * lighter shape (active 536, trashed 721, trashed + replaced 776 bytes measured).
 */
export const MAX_TENDERS_MANAGED_INDEX_BYTES_PER_RECORD = 832
/**
 * Managed-document metadata records (active + trashed, all workspaces).
 *
 * User-visible capacity: **5 000 managed documents**, now reachable for every
 * record the store writes — 5 000 × 832 = 4 160 000 bytes, inside the 4 MiB
 * ceiling, and the ceiling admits floor(4 194 304 / 832) = 5 041 records of the
 * heaviest measured shape — so the count cap is what a full store reports and
 * what the user can plan against. The cap was 20 000 while the index ceiling
 * admitted only ~11 500 of them (365 bytes per record measured), so the
 * advertised capacity was unreachable and a full index refused the user *below*
 * it with "index is full" — a limit they could not see, count or plan for.
 *
 * Disclosed residual: a file placed in `documents/` or `vault/` by something
 * other than `save` (an external copy, a restored backup) can carry a name longer
 * than `MAX_TENDERS_MANAGED_FILE_NAME_CHARS`, and soft-deleting it adopts that
 * name into `relativePath`; enough of those can still reach the byte ceiling
 * first, where the refusal names the index rather than a count.
 */
export const MAX_TENDERS_MANAGED_FILES = 5_000
/**
 * Soft-deleted documents retained in the Tenders trash directory. Trashed records
 * are the largest records in the same index, so this cap can never exceed
 * `MAX_TENDERS_MANAGED_FILES`.
 */
export const MAX_TENDERS_TRASH_ENTRIES = 5_000
export const MAX_TENDERS_ISSUER_TEMPLATES = 1_000
export const MAX_TENDERS_SINGLE_STRING_CHARS = 32_768
/**
 * Aggregate string content across one document, in characters.
 *
 * Held equal to `MAX_TENDERS_DOCUMENT_BYTES` so it can never be the binding
 * document bound: every counted character costs at least one byte of the compact
 * JSON the byte ceiling measures (object keys, punctuation and escape sequences
 * add bytes without adding characters), so any document inside the byte ceiling
 * is inside this one. It is a backstop, not a text budget — the measured heavy
 * workspace (5 000 requirements + 5 000 page states + 16 candidates for each of
 * the eight readiness-critical fields) carries 910 274 counted characters — 87%
 * of the old 1 MiB value — so a document only ~15% larger than it was refused
 * with "Aggregate string content exceeds limit of 1048576": a message that names
 * no field and no way forward, the same non-actionable wedge class the
 * document-ceiling raise removed. The
 * check still bounds documents validated without the byte check (the 8 MiB load
 * path) and is still the cycle guard — `aggregateStrings` returns cap + 1 for a
 * cyclic graph.
 */
export const MAX_TENDERS_AGGREGATE_STRING_CHARS = MAX_TENDERS_DOCUMENT_BYTES
export const MAX_TENDERS_DYNAMIC_ENTRIES = 2_000
export const MAX_TENDERS_DYNAMIC_KEY_CHARS = 256
export const MAX_TENDERS_SCHEMA_ISSUES = 500

export type TendersPersistenceErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_DATA'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'REVISION_CONFLICT'
  | 'NOT_FOUND'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'RECOVERY_REQUIRED'

export interface TendersPersistenceError {
  code: TendersPersistenceErrorCode
  message: string
  schemaIssues?: TendersSchemaIssue[]
  current?: TendersDataV2
}

/**
 * A recoverable copy of the authoritative document found on disk. Candidates
 * are only ever *listed*; restoring one is an explicit user action. `load` never
 * substitutes a candidate (or an empty document) as authoritative.
 */
export interface TendersRecoveryCandidate {
  /** Stable id within the store directory, e.g. `backups/tenders-data.3.json`. */
  id: string
  /** Relative path inside the Tenders store directory (never absolute). */
  path: string
  source: 'primary' | 'backup' | 'temporary' | 'unknown'
  reason?: string
  updatedAt?: string
  /** Parsed revision when the candidate is readable. */
  revision?: number
  /** True when the candidate parsed and migrated into a valid v2 document. */
  valid: boolean
  sizeBytes?: number
}

// ── Managed documents (Phase 5 WP-9) ─────────────────────────────────────────

export type ManagedFileCategory = 'rfp' | 'vault'
export type ManagedFileState = 'active' | 'trashed' | 'missing'

export interface ManagedFileRecord {
  id: string
  category: ManagedFileCategory
  /** Relative path under the Tenders base dir, e.g. `documents/1712_x.pdf`. */
  relativePath: string
  fileName: string
  mimeType: string
  size: number
  /** Lower-case hex SHA-256 of the stored bytes. */
  hash: string
  createdAt: string
  updatedAt: string
  state: ManagedFileState
  trashedAt: string | null
  /** Relative path under `.trash/` once soft-deleted. */
  trashedPath: string | null
  missingAt: string | null
  /** Id of the record that replaced this one, when applicable. */
  replacedBy: string | null
}

/** One soft-deleted document the user can restore (undo across restart). */
export interface ManagedFileTrashEntry {
  id: string
  recordId: string
  fileName: string
  category: ManagedFileCategory
  size: number
  hash: string
  trashedAt: string
  deletedFrom: string
  trashedPath: string
}

/** A tender/customer/vault record that references a managed file. */
export interface ManagedFileLink {
  kind: 'tender' | 'customer' | 'vault'
  id: string
  label: string
}

export interface DocumentReconciliation {
  missing: Array<{
    id: string
    relativePath: string
    fileName: string
    lastSeenAt: string
  }>
  /** Files on disk with no metadata record (never auto-deleted). */
  orphaned: string[]
  trashed: ManagedFileTrashEntry[]
  activeCount: number
}

export type TendersLoadStatus = 'loaded' | 'migrated' | 'not-found'

export interface TendersLoadSuccess {
  ok: true
  status: TendersLoadStatus
  data: TendersDataV2
  needsSave: boolean
  warnings: string[]
}

export interface TendersLoadFailure {
  ok: false
  error: TendersPersistenceError
  recoveryCandidates?: TendersRecoveryCandidate[]
}

export type TendersLoadResult = TendersLoadSuccess | TendersLoadFailure

export interface SaveTendersRequest {
  expectedRevision: number
  document: TendersDataV2
}

export interface SaveTendersSuccess {
  ok: true
  data: TendersDataV2
  postCommitError?: string
}

export interface SaveTendersFailure {
  ok: false
  error: TendersPersistenceError
  current?: TendersDataV2
}

export type SaveTendersResult = SaveTendersSuccess | SaveTendersFailure

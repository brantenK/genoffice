import type { TendersDataV2 } from './types'
import type { TendersSchemaIssue } from './tenders-schema'

export const TENDERS_PERSISTENCE_FILE_NAME = 'tenders-data.json' as const
export const MAX_TENDERS_STORE_FILE_BYTES = 8 * 1024 * 1024
export const MAX_TENDERS_DOCUMENT_BYTES = 1.5 * 1024 * 1024
export const MAX_TENDERS_IPC_PAYLOAD_BYTES = 2 * 1024 * 1024
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
/** Managed-document metadata records (active + trashed, all workspaces). */
export const MAX_TENDERS_MANAGED_FILES = 20_000
/** Soft-deleted documents retained in the Tenders trash directory. */
export const MAX_TENDERS_TRASH_ENTRIES = 20_000
/** Serialized size cap for the managed-document metadata index. */
export const MAX_TENDERS_MANAGED_INDEX_BYTES = 4 * 1024 * 1024
export const MAX_TENDERS_ISSUER_TEMPLATES = 1_000
export const MAX_TENDERS_SINGLE_STRING_CHARS = 32_768
export const MAX_TENDERS_AGGREGATE_STRING_CHARS = 1_048_576
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

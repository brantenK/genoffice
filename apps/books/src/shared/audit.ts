/**
 * apps/books/src/shared/audit.ts
 *
 * Pure audit-log helpers (no electron/react imports). The audit log is an
 * immutable, newest-first trail of every ledger mutation. Store actions
 * append an entry via appendAudit to the exact data object they persist, so
 * the entry lands on disk together with the mutation it describes.
 */

import type { AuditEntry, BooksData } from './types'

/** Newest-first cap: keep only the most recent entries on disk. */
export const MAX_AUDIT_ENTRIES = 500

/** Builds a fresh, immutable audit entry. */
export function createAuditEntry(
  action: string,
  summary: string,
  extra?: Partial<Omit<AuditEntry, 'id' | 'timestamp' | 'action' | 'summary'>>,
): AuditEntry {
  return {
    id: `audit-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    timestamp: new Date().toISOString(),
    action,
    summary,
    ...extra,
  }
}

/** Returns a copy of `data` with the entry prepended (newest first), capped.
 *  Generic over the input type so envelope-typed callers (books-core) keep
 *  their concrete type. */
export function appendAudit<T extends BooksData>(data: T, entry: AuditEntry): T {
  return {
    ...data,
    auditLog: [entry, ...(data.auditLog || [])].slice(0, MAX_AUDIT_ENTRIES),
  } as T
}

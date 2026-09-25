// The managed-document lifecycle: save, read, open, delete to trash, restore,
// replace, reconcile and trash cleanup.
//
// Split out of `main/tenders-main.ts` with no behaviour change. Every one of
// these answers a renderer request, so every one takes a `storedPath` (or a
// managed id) that arrived over IPC: the confinement checks in
// `tenders-paths.ts` run first and the byte caps run before any filesystem work.
//
// The two main-process stores it needs are INJECTED rather than imported, so this
// module never has to know how they are built or where their state lives:
//
//   * `getManagedDocumentStore()` — the managed-document metadata store.
//   * `getAuthoritativeTendersStore()` — read only, to report which records still
//     reference a document before it is moved to trash.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { shell } from 'electron'
import {
  MAX_TENDERS_DOCUMENT_UPLOAD_BYTES,
  type DeleteDocumentRequest,
  type DeleteDocumentResponse,
  type OpenDocumentRequest,
  type OpenDocumentResponse,
  type ReadDocumentRequest,
  type ReadDocumentResponse,
  type SaveDocumentRequest,
  type SaveDocumentResponse,
  type CleanupDocumentTrashRequest,
  type CleanupDocumentTrashResponse,
  type ListDocumentTrashResponse,
  type ReplaceDocumentRequest,
  type ReplaceDocumentResponse,
  type ReconcileDocumentsResponse,
  type RestoreDocumentRequest,
  type RestoreDocumentResponse,
  type ListRecoveryCandidatesResponse,
  type RestoreRecoveryCandidateRequest,
  type RestoreRecoveryCandidateResponse,
} from '../shared/ipc'
import type { ManagedFileLink } from '../shared/tenders-persistence'
import { findManagedFileLinks, toManagedRelativePath } from './document-store'
import { resolveConfinedTendersPath, getTendersBaseDir } from './tenders-paths'
import { managedDocumentStore, authoritativeStore } from './store-registry'

export async function saveDocumentFile(
  req: SaveDocumentRequest,
  overrideUserData?: string,
): Promise<SaveDocumentResponse> {
  try {
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'Invalid request payload' }
    }
    const { fileName, buffer, category } = req
    if (!fileName || typeof fileName !== 'string') {
      return { ok: false, error: 'File name is required' }
    }
    if (!buffer) {
      return { ok: false, error: 'File buffer is required' }
    }
    if (category !== 'rfp' && category !== 'vault') {
      return { ok: false, error: 'Category must be either "rfp" or "vault"' }
    }
    const fileBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as any)
    // Bounded upload: reject before any filesystem work or sanitisation so an
    // oversized document cannot stream across IPC or be written.
    if (fileBuf.byteLength > MAX_TENDERS_DOCUMENT_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `Document exceeds the ${MAX_TENDERS_DOCUMENT_UPLOAD_BYTES}-byte upload limit.`,
      }
    }

    // Route through the managed-document store so every saved file gets durable
    // metadata (id/size/MIME/hash/timestamps). Filenames stay timestamped.
    const saved = await managedDocumentStore(overrideUserData).save({
      fileName,
      buffer: fileBuf,
      category,
    })
    if (!saved.ok) return { ok: false, error: saved.error }
    return {
      ok: true,
      storedPath: saved.record.relativePath,
      id: saved.record.id,
      record: saved.record,
    }
  } catch (err: any) {
    console.error('tenders-main: failed to save document file', err)
    return { ok: false, error: err?.message || 'Failed to save document' }
  }
}

export async function readDocumentFile(
  req: ReadDocumentRequest,
  overrideUserData?: string,
): Promise<ReadDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || !req.storedPath) {
      return { ok: false, error: 'Stored path is required' }
    }
    const check = resolveConfinedTendersPath(req.storedPath, overrideUserData)
    if (!check.safe) {
      return { ok: false, error: check.error || 'Invalid or unsafe path' }
    }
    if (!existsSync(check.fullPath)) {
      return { ok: false, error: 'File not found on disk' }
    }
    // Bounded read: never stream an oversized file back across IPC.
    if (statSync(check.fullPath).size > MAX_TENDERS_DOCUMENT_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `Document exceeds the ${MAX_TENDERS_DOCUMENT_UPLOAD_BYTES}-byte read limit.`,
      }
    }
    const buf = readFileSync(check.fullPath)
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, buffer: arrayBuffer }
  } catch (err: any) {
    console.error('tenders-main: failed to read document file', err)
    return { ok: false, error: err?.message || 'Failed to read document' }
  }
}

export async function openDocumentFile(
  req: OpenDocumentRequest,
  overrideUserData?: string,
): Promise<OpenDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || !req.storedPath) {
      return { ok: false, error: 'Stored path is required' }
    }
    // Confinement is proven against the real filesystem, not the text: a link
    // planted at a managed leaf would otherwise hand `shell.openPath` a path
    // that resolves outside the Tenders directory.
    const check = resolveConfinedTendersPath(req.storedPath, overrideUserData)
    if (!check.safe) {
      return { ok: false, error: check.error || 'Invalid or unsafe path' }
    }
    if (!existsSync(check.fullPath)) {
      return { ok: false, error: 'File not found on disk' }
    }
    // `shell.openPath` hands the file to the OS, which FOLLOWS a `.lnk` shortcut
    // and runs a launcher. A managed document is a PDF, a DOCX or an image —
    // never a shortcut, a launcher script or a macro container that would run
    // code on open — so the extension is refused here rather than trusted to the
    // shell.
    // Windows strips trailing dots when it resolves a file association, so a
    // stored name like `evil.docm.` — whose `extname` is `.`, in neither refusal
    // set — would still open under its `.docm` handler. The trailing dot is
    // normalized away before the extension is judged, so a macro/launcher
    // container never reaches the shell under any name shape, while a macro-free
    // `.docx.` still opens.
    const leaf = basename(check.fullPath)
    const normalizedLeaf = leaf.replace(/\.+$/, '')
    const refusal = refusalForUnopenableExtension(extname(normalizedLeaf).toLowerCase())
    if (refusal) return { ok: false, error: refusal }
    const openErr = await shell.openPath(check.fullPath)
    if (openErr) {
      return { ok: false, error: openErr }
    }
    return { ok: true }
  } catch (err: any) {
    console.error('tenders-main: failed to open document file', err)
    return { ok: false, error: err?.message || 'Failed to open document' }
  }
}

/**
 * Extensions the OS treats as a launcher rather than a document. Opening one
 * through `shell.openPath` runs whatever it points at or contains, which for a
 * `.lnk` means following an attacker-chosen target.
 */
const WINDOWS_LAUNCHER_EXTENSIONS = new Set([
  '.lnk',
  '.url',
  '.pif',
  '.scf',
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.js',
  '.hta',
  '.reg',
  '.msi',
  '.exe',
])

/**
 * OOXML extensions whose container may carry and RUN a VBA macro project.
 *
 * These are what an attacker actually sends: the old binary `.doc`/`.xls` are
 * the ones Office blocks by default, while a `.docm` from a third party is an
 * ordinary-looking document the user is expected to open — and opening it runs
 * its `vbaProject.bin` unless Office's own macro setting stops it. This app
 * ingests documents from untrusted third parties and then hands them to
 * `shell.openPath`, so "Office will probably warn about this one" is not a
 * defence the app gets to delegate; it refuses the container instead.
 */
const OOXML_MACRO_EXTENSIONS = new Set([
  '.docm',
  '.dotm',
  '.xlsm',
  '.xltm',
  '.xlam',
  '.pptm',
  '.potm',
  '.ppsm',
  '.sldm',
])

/**
 * Why this extension may not be opened, as the sentence the user is shown, or
 * `null` when it may. Two honest messages rather than one: a macro container is
 * not a launcher, and telling a user their `.docm` "is a launcher or shortcut"
 * would describe something the file is not.
 */
export function refusalForUnopenableExtension(extension: string): string | null {
  if (WINDOWS_LAUNCHER_EXTENSIONS.has(extension)) {
    return `A ${extension} file is a launcher or shortcut and is not opened from Tenders.`
  }
  if (OOXML_MACRO_EXTENSIONS.has(extension)) {
    return `A ${extension} file can carry macros, so it is not opened from Tenders. Save it as a macro-free format first.`
  }
  return null
}

/**
 * Soft-delete a managed document: the file is MOVED to the Tenders trash (never
 * hard-unlinked) and can be restored across a restart. Returns the records that
 * still reference it so the UI can warn/confirm.
 *
 * The managed record id is preferred over the path (see `DeleteDocumentRequest`):
 * when an id is supplied it is resolved against the managed index, and a
 * `storedPath` that names a different document is rejected rather than silently
 * deleting the wrong file.
 */
export async function deleteDocumentFile(
  req: DeleteDocumentRequest,
  overrideUserData?: string,
): Promise<DeleteDocumentResponse> {
  try {
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'Invalid request payload' }
    }
    const requestedId = typeof req.id === 'string' && req.id.length > 0 ? req.id : ''
    if (!requestedId && !req.storedPath) {
      return { ok: false, error: 'Stored path is required' }
    }
    const store = managedDocumentStore(overrideUserData)
    let relativePath: string | null
    if (requestedId) {
      if (requestedId.length > 512) return { ok: false, error: 'Invalid managed document id' }
      const record = (await store.listRecords()).find((candidate) => candidate.id === requestedId)
      if (!record) return { ok: false, error: `Unknown managed document id: ${requestedId}` }
      relativePath = record.relativePath
      if (req.storedPath) {
        const claimed = toManagedRelativePath(req.storedPath)
        if (claimed !== relativePath) {
          return {
            ok: false,
            error: 'The supplied id and storedPath refer to different documents.',
          }
        }
      }
    } else {
      relativePath = toManagedRelativePath(req.storedPath)
    }
    if (!relativePath) {
      return { ok: false, error: 'Invalid or unsafe path' }
    }
    const trashed = await store.trash(relativePath)

    // Link-aware warnings (best-effort; a lookup failure never blocks the move).
    let links: ManagedFileLink[] = []
    try {
      const loaded = await authoritativeStore().load()
      if (loaded.ok) links = findManagedFileLinks(relativePath, loaded.data)
    } catch {
      // ignore link lookup failures
    }

    if (!trashed.ok) {
      // The file was already gone and untracked: deleting is idempotent.
      const full = join(getTendersBaseDir(overrideUserData), relativePath)
      if (!existsSync(full)) return { ok: true, ...(links.length ? { links } : {}) }
      return { ok: false, error: trashed.error }
    }

    const warnings = links.length
      ? [
          `This file is referenced by ${links.length} record(s); it was moved to trash and can be restored.`,
        ]
      : []
    return {
      ok: true,
      ...(links.length ? { links } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(trashed.entry ? { trashId: trashed.entry.id } : {}),
    }
  } catch (err: any) {
    console.error('tenders-main: failed to delete document file', err)
    return { ok: false, error: err?.message || 'Failed to delete document' }
  }
}

// ── Managed-document lifecycle helpers (Phase 5 WP-9) ────────────────────────

export async function listDocumentTrashFile(
  overrideUserData?: string,
): Promise<ListDocumentTrashResponse> {
  try {
    return { ok: true, entries: await managedDocumentStore(overrideUserData).listTrash() }
  } catch (err: any) {
    console.error('tenders-main: failed to list document trash', err)
    return { ok: false, error: err?.message || 'Failed to list document trash' }
  }
}

export async function restoreDocumentFile(
  req: RestoreDocumentRequest,
  overrideUserData?: string,
): Promise<RestoreDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || typeof req.id !== 'string' || req.id.length === 0) {
      return { ok: false, error: 'Trash entry id is required' }
    }
    const result = await managedDocumentStore(overrideUserData).restore(req.id)
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, record: result.record, storedPath: result.restoredPath }
  } catch (err: any) {
    console.error('tenders-main: failed to restore document', err)
    return { ok: false, error: err?.message || 'Failed to restore document' }
  }
}

export async function replaceDocumentFile(
  req: ReplaceDocumentRequest,
  overrideUserData?: string,
): Promise<ReplaceDocumentResponse> {
  try {
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.storedPath !== 'string' ||
      typeof req.fileName !== 'string'
    ) {
      return { ok: false, error: 'storedPath and fileName are required' }
    }
    if (!req.buffer) return { ok: false, error: 'File buffer is required' }
    const buffer = Buffer.isBuffer(req.buffer) ? req.buffer : Buffer.from(req.buffer as any)
    if (buffer.byteLength > MAX_TENDERS_DOCUMENT_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `Document exceeds the ${MAX_TENDERS_DOCUMENT_UPLOAD_BYTES}-byte upload limit.`,
      }
    }
    const result = await managedDocumentStore(overrideUserData).replace({
      storedPath: req.storedPath,
      fileName: req.fileName,
      buffer,
    })
    if (!result.ok) return { ok: false, error: result.error }
    return {
      ok: true,
      record: result.record,
      storedPath: result.record.relativePath,
      previousTrashed: result.previousTrashed,
      ...(result.warning ? { warning: result.warning } : {}),
    }
  } catch (err: any) {
    console.error('tenders-main: failed to replace document', err)
    return { ok: false, error: err?.message || 'Failed to replace document' }
  }
}

export async function reconcileDocumentFiles(
  overrideUserData?: string,
): Promise<ReconcileDocumentsResponse> {
  try {
    return { ok: true, reconciliation: await managedDocumentStore(overrideUserData).reconcile() }
  } catch (err: any) {
    console.error('tenders-main: failed to reconcile documents', err)
    return { ok: false, error: err?.message || 'Failed to reconcile documents' }
  }
}

export async function cleanupDocumentTrash(
  req: CleanupDocumentTrashRequest,
  overrideUserData?: string,
): Promise<CleanupDocumentTrashResponse> {
  try {
    if (req !== undefined && (typeof req !== 'object' || req === null)) {
      return { ok: false, error: 'Invalid cleanup request' }
    }
    if (
      req?.olderThanMs !== undefined &&
      (typeof req.olderThanMs !== 'number' || req.olderThanMs < 0)
    ) {
      return { ok: false, error: 'olderThanMs must be a non-negative number' }
    }
    const result = await managedDocumentStore(overrideUserData).cleanupTrash({
      all: req?.all === true,
      ...(typeof req?.olderThanMs === 'number' ? { olderThanMs: req.olderThanMs } : {}),
    })
    return { ok: true, removed: result.removed }
  } catch (err: any) {
    console.error('tenders-main: failed to clean up document trash', err)
    return { ok: false, error: err?.message || 'Failed to clean up document trash' }
  }
}

// ── Recovery helpers (Phase 5 WP-2 remainder) ────────────────────────────────

export async function listRecoveryCandidatesFile(): Promise<ListRecoveryCandidatesResponse> {
  try {
    const candidates = await authoritativeStore().listRecoveryCandidates()
    return { ok: true, candidates: candidates as never }
  } catch (err: any) {
    console.error('tenders-main: failed to list recovery candidates', err)
    return { ok: false, error: err?.message || 'Failed to list recovery candidates' }
  }
}

export async function restoreRecoveryCandidateFile(
  req: RestoreRecoveryCandidateRequest,
): Promise<RestoreRecoveryCandidateResponse> {
  try {
    if (!req || typeof req !== 'object' || typeof req.id !== 'string' || req.id.length === 0) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Candidate id is required.' } }
    }
    const result = await authoritativeStore().restoreRecoveryCandidate(req.id)
    if (!result.ok) {
      return { ok: false, error: { code: result.error.code, message: result.error.message } }
    }
    return { ok: true, data: result.data as never }
  } catch (err: any) {
    console.error('tenders-main: failed to restore recovery candidate', err)
    return {
      ok: false,
      error: { code: 'WRITE_FAILED', message: err?.message || 'Failed to restore candidate' },
    }
  }
}

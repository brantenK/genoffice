// The managed-document and recovery channels: the RFP/vault document store on
// disk, its trash, and the rotating-backup recovery list.
//
// Split out of `ipc/handlers.ts` with no behaviour change. Every handler is
// behind the same trusted-sender gate and validates its request SHAPE before
// touching disk; what a "valid trash entry id" or a "replaceable document" means
// belongs to `document-lifecycle.ts`, and this module does not re-word it.
import {
  TENDERS_CHANNELS,
  type CleanupDocumentTrashRequest,
  type DeleteDocumentRequest,
  type OpenDocumentRequest,
  type ReadDocumentRequest,
  type ReplaceDocumentRequest,
  type RestoreDocumentRequest,
  type RestoreRecoveryCandidateRequest,
  type SaveDocumentRequest,
} from '../../shared/ipc'
import {
  saveDocumentFile,
  readDocumentFile,
  openDocumentFile,
  deleteDocumentFile,
  listDocumentTrashFile,
  restoreDocumentFile,
  replaceDocumentFile,
  reconcileDocumentFiles,
  cleanupDocumentTrash,
  listRecoveryCandidatesFile,
  restoreRecoveryCandidateFile,
} from '../document-lifecycle'
import { isTrustedTendersEvent, unauthorizedTendersRequest } from './trust'
import type { TendersIpcRegistry } from './handler-context'

export function registerTendersDocumentChannels(ipc: TendersIpcRegistry): void {
  // Persistent Document & Vault Disk Storage (R2)
  ipc.handle(TENDERS_CHANNELS.saveDocument, async (_e, req: SaveDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return saveDocumentFile(req)
  })

  ipc.handle(TENDERS_CHANNELS.readDocument, async (_e, req: ReadDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return readDocumentFile(req)
  })

  ipc.handle(TENDERS_CHANNELS.openDocument, async (_e, req: OpenDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return openDocumentFile(req)
  })

  ipc.handle(TENDERS_CHANNELS.deleteDocument, async (_e, req: DeleteDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return deleteDocumentFile(req)
  })

  // Managed-document lifecycle (Phase 5 WP-9). Every handler is behind the same
  // trusted-sender gate and validates its request shape before touching disk.
  ipc.handle(TENDERS_CHANNELS.listDocumentTrash, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return listDocumentTrashFile()
  })

  ipc.handle(TENDERS_CHANNELS.restoreDocument, async (_e, req: RestoreDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.id !== 'string' ||
      req.id.length === 0 ||
      req.id.length > 512
    ) {
      return { ok: false, error: 'A valid trash entry id is required' }
    }
    return restoreDocumentFile(req)
  })

  ipc.handle(TENDERS_CHANNELS.replaceDocument, async (_e, req: ReplaceDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.storedPath !== 'string' ||
      typeof req.fileName !== 'string' ||
      req.fileName.length > 512
    ) {
      return { ok: false, error: 'storedPath and fileName are required' }
    }
    return replaceDocumentFile(req)
  })

  ipc.handle(TENDERS_CHANNELS.reconcileDocuments, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return reconcileDocumentFiles()
  })

  ipc.handle(
    TENDERS_CHANNELS.cleanupDocumentTrash,
    async (_e, req: CleanupDocumentTrashRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      return cleanupDocumentTrash(req)
    },
  )

  // Rotating backups + explicit recovery (Phase 5 WP-2 remainder).
  ipc.handle(TENDERS_CHANNELS.listRecoveryCandidates, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return listRecoveryCandidatesFile()
  })

  ipc.handle(
    TENDERS_CHANNELS.restoreRecoveryCandidate,
    async (_e, req: RestoreRecoveryCandidateRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      if (
        !req ||
        typeof req !== 'object' ||
        typeof req.id !== 'string' ||
        req.id.length === 0 ||
        req.id.length > 512
      ) {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'A valid candidate id is required.' },
        }
      }
      return restoreRecoveryCandidateFile(req)
    },
  )
}

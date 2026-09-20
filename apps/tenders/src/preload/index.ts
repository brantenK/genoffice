import { contextBridge, ipcRenderer } from 'electron'
import {
  SUITE_THEME_CHANNELS,
  TENDERS_CHANNELS,
  type TendersApi,
  type TendersResolvedTheme,
} from '../shared/ipc'
import type { TendersData, TendersDataV2 } from '../shared/types'
import type {
  SaveTendersRequest,
  SaveTendersResult,
  TendersLoadResult,
} from '../shared/tenders-persistence'

function projectProposalDto(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  const dto: Record<string, unknown> = {}
  for (const key of [
    'title',
    'referenceNumber',
    'issuingBody',
    'closingDate',
    'estimatedValue',
    'pricingConfirmed',
  ]) {
    if (key in source) dto[key] = source[key]
  }
  if (Array.isArray(source.requirements)) {
    dto.requirements = source.requirements.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item
      const input = item as Record<string, unknown>
      const projected: Record<string, unknown> = {}
      for (const key of [
        'id',
        'title',
        'verbatimClause',
        'isMandatory',
        'status',
        'linkedVaultDocId',
        'healthStatus',
        'ruleKey',
        'reason',
        'notApplicableReason',
        'notes',
      ]) {
        if (key in input) projected[key] = input[key]
      }
      return projected
    })
  }
  if (Array.isArray(source.milestones)) {
    dto.milestones = source.milestones.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item
      const input = item as Record<string, unknown>
      const projected: Record<string, unknown> = {}
      for (const key of ['id', 'name', 'title', 'amount', 'dueDate']) {
        if (key in input) projected[key] = input[key]
      }
      return projected
    })
  }
  if (
    source.signatureChecks &&
    typeof source.signatureChecks === 'object' &&
    !Array.isArray(source.signatureChecks)
  ) {
    dto.signatureChecks = source.signatureChecks
  }
  return dto
}

// Suite theme bridge (Phase 5 / WP-13). The shell's main process owns
// `app:get-theme` and broadcasts `app:theme-changed` to every webContents (see
// apps/shell/src/main/index.ts); these two channels are suite-wide, not
// Tenders-specific. They publish the RESOLVED theme (`light | dark`) because
// Electron 43 does not flip `prefers-color-scheme`; the renderer applies the
// explicit value to `<html data-theme>` in renderer/src/components/ui.tsx.
const getTheme = async (): Promise<TendersResolvedTheme> => {
  const result: unknown = await ipcRenderer.invoke(SUITE_THEME_CHANNELS.getTheme)
  return result === 'dark' ? 'dark' : 'light'
}
const onThemeChanged = (handler: (theme: TendersResolvedTheme) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, theme: unknown): void =>
    handler(theme === 'dark' ? 'dark' : 'light')
  ipcRenderer.on(SUITE_THEME_CHANNELS.themeChanged, listener)
  return () => {
    ipcRenderer.removeListener(SUITE_THEME_CHANNELS.themeChanged, listener)
  }
}

const tendersApi: TendersApi = {
  getTheme,
  onThemeChanged,
  getStoredData: () => ipcRenderer.invoke(TENDERS_CHANNELS.getStoredData),
  saveStoredData: (json: string) => ipcRenderer.invoke(TENDERS_CHANNELS.saveStoredData, json),
  onDataChanged: (callback: (data: TendersData) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TendersData) => {
      callback(data)
    }
    ipcRenderer.on(TENDERS_CHANNELS.dataChanged, handler)
    return () => {
      ipcRenderer.removeListener(TENDERS_CHANNELS.dataChanged, handler)
    }
  },
  saveDocument: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.saveDocument, req),
  readDocument: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.readDocument, req),
  openDocument: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.openDocument, req),
  deleteDocument: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.deleteDocument, req),
  // Managed-document lifecycle + rotating-backup recovery (Phase 5 WP-9/WP-2).
  // Thin pass-through: validation, trust and path confinement stay in main.
  listDocumentTrash: () => ipcRenderer.invoke(TENDERS_CHANNELS.listDocumentTrash),
  restoreDocument: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.restoreDocument, req),
  replaceDocument: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.replaceDocument, req),
  reconcileDocuments: () => ipcRenderer.invoke(TENDERS_CHANNELS.reconcileDocuments),
  cleanupDocumentTrash: (req) => ipcRenderer.invoke(TENDERS_CHANNELS.cleanupDocumentTrash, req),
  listRecoveryCandidates: () => ipcRenderer.invoke(TENDERS_CHANNELS.listRecoveryCandidates),
  restoreRecoveryCandidate: (req) =>
    ipcRenderer.invoke(TENDERS_CHANNELS.restoreRecoveryCandidate, req),
  loadStoreV2: (): Promise<TendersLoadResult> => ipcRenderer.invoke(TENDERS_CHANNELS.loadStoreV2),
  saveStoreV2: (request: SaveTendersRequest): Promise<SaveTendersResult> =>
    ipcRenderer.invoke(TENDERS_CHANNELS.saveStoreV2, request),
  onStoreChangedV2: (callback: (data: TendersDataV2) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TendersDataV2) => callback(data)
    ipcRenderer.on(TENDERS_CHANNELS.storeChangedV2, handler)
    return () => ipcRenderer.removeListener(TENDERS_CHANNELS.storeChangedV2, handler)
  },
  exportMatrixToSheets: (tenderId: string, tenderTitle: string, matrixRows: any[]) =>
    ipcRenderer.invoke(TENDERS_CHANNELS.exportMatrixToSheets, tenderId, tenderTitle, matrixRows),
  draftProposalDoc: (tender: any) =>
    ipcRenderer.invoke(TENDERS_CHANNELS.draftProposalDoc, projectProposalDto(tender)),
  syncWithCrm: (dealData) => ipcRenderer.invoke(TENDERS_CHANNELS.syncWithCrm, dealData),
  updateTenderOutcome: (request) =>
    ipcRenderer.invoke(TENDERS_CHANNELS.updateTenderOutcome, request),
  openInCrm: (dealId?: string) => ipcRenderer.invoke(TENDERS_CHANNELS.openInCrm, dealId),
  billMilestoneInBooks: (tenderIdOrPayload, milestoneId) =>
    ipcRenderer.invoke(TENDERS_CHANNELS.billMilestoneInBooks, tenderIdOrPayload, milestoneId),
  openBooks: () => ipcRenderer.invoke(TENDERS_CHANNELS.openBooks),
}

contextBridge.exposeInMainWorld('tendersApi', tendersApi)

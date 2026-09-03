import { contextBridge, ipcRenderer } from 'electron'
import { TENDERS_CHANNELS, type TendersApi } from '../shared/ipc'

const tendersApi: TendersApi = {
  getStoredData: () => ipcRenderer.invoke(TENDERS_CHANNELS.getStoredData),
  saveStoredData: (json: string) => ipcRenderer.invoke(TENDERS_CHANNELS.saveStoredData, json),
  exportMatrixToSheets: (tenderId: string, tenderTitle: string, matrixRows: any[]) =>
    ipcRenderer.invoke(TENDERS_CHANNELS.exportMatrixToSheets, tenderId, tenderTitle, matrixRows),
  draftProposalDoc: (tender: any) =>
    ipcRenderer.invoke(TENDERS_CHANNELS.draftProposalDoc, tender),
  syncWithCrm: (dealData) =>
    ipcRenderer.invoke(TENDERS_CHANNELS.syncWithCrm, dealData),
  openInCrm: (dealId?: string) =>
    ipcRenderer.invoke(TENDERS_CHANNELS.openInCrm, dealId),
  billMilestoneInBooks: (tenderIdOrPayload, milestoneId) =>
    ipcRenderer.invoke(TENDERS_CHANNELS.billMilestoneInBooks, tenderIdOrPayload, milestoneId),
  openBooks: () => ipcRenderer.invoke(TENDERS_CHANNELS.openBooks),
}

contextBridge.exposeInMainWorld('tendersApi', tendersApi)


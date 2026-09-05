import { contextBridge, ipcRenderer } from 'electron'
import { TENDERS_CHANNELS, type TendersApi } from '../shared/ipc'
import type { TendersData } from '../shared/types'

const tendersApi: TendersApi = {
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


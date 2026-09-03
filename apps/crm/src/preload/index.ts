import { contextBridge, ipcRenderer } from 'electron'
import { CRM_CHANNELS, type CrmApi } from '../shared/ipc'
import type { Activity, Company, Contact, Deal, DealStage } from '../shared/types'

const crmApi: CrmApi = {
  getStats: () => ipcRenderer.invoke(CRM_CHANNELS.getStats),

  listDeals: () => ipcRenderer.invoke(CRM_CHANNELS.listDeals),
  getDeal: (id: string) => ipcRenderer.invoke(CRM_CHANNELS.getDeal, id),
  saveDeal: (deal: Partial<Deal>) => ipcRenderer.invoke(CRM_CHANNELS.saveDeal, deal),
  updateDealStage: (id: string, stage: DealStage) =>
    ipcRenderer.invoke(CRM_CHANNELS.updateDealStage, id, stage),
  deleteDeal: (id: string) => ipcRenderer.invoke(CRM_CHANNELS.deleteDeal, id),

  listContacts: () => ipcRenderer.invoke(CRM_CHANNELS.listContacts),
  saveContact: (contact: Partial<Contact>) =>
    ipcRenderer.invoke(CRM_CHANNELS.saveContact, contact),
  deleteContact: (id: string) => ipcRenderer.invoke(CRM_CHANNELS.deleteContact, id),

  listCompanies: () => ipcRenderer.invoke(CRM_CHANNELS.listCompanies),
  saveCompany: (company: Partial<Company>) =>
    ipcRenderer.invoke(CRM_CHANNELS.saveCompany, company),
  deleteCompany: (id: string) => ipcRenderer.invoke(CRM_CHANNELS.deleteCompany, id),

  listActivities: (filter) => ipcRenderer.invoke(CRM_CHANNELS.listActivities, filter),
  addActivity: (act) => ipcRenderer.invoke(CRM_CHANNELS.addActivity, act),
  toggleActivity: (id) => ipcRenderer.invoke(CRM_CHANNELS.toggleActivity, id),

  exportToSheets: () => ipcRenderer.invoke(CRM_CHANNELS.exportToSheets),
  generateProposalDoc: (dealId: string) =>
    ipcRenderer.invoke(CRM_CHANNELS.generateProposalDoc, dealId),
  openTenders: () => ipcRenderer.invoke(CRM_CHANNELS.openTenders),
}

contextBridge.exposeInMainWorld('crmApi', crmApi)

declare global {
  interface Window {
    crmApi: CrmApi
  }
}

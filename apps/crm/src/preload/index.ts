import { contextBridge, ipcRenderer } from 'electron'
import { CRM_CHANNELS, type CrmApi } from '../shared/ipc'
import type { ActivityPatch, Company, Contact, Deal, DealStage } from '../shared/types'

const crmApi: CrmApi = {
  getStats: () => ipcRenderer.invoke(CRM_CHANNELS.getStats),
  getRecoveryState: () => ipcRenderer.invoke(CRM_CHANNELS.getRecoveryState),
  acknowledgeRecovery: () => ipcRenderer.invoke(CRM_CHANNELS.acknowledgeRecovery),
  listAudit: (filter) => ipcRenderer.invoke(CRM_CHANNELS.listAudit, filter),
  findContactDuplicate: (email: string, excludeId?: string) =>
    ipcRenderer.invoke(CRM_CHANNELS.findContactDuplicate, email, excludeId),
  findCompanyDuplicate: (name: string, domain?: string, excludeId?: string) =>
    ipcRenderer.invoke(CRM_CHANNELS.findCompanyDuplicate, name, domain, excludeId),

  listDeals: () => ipcRenderer.invoke(CRM_CHANNELS.listDeals),
  getDeal: (id: string) => ipcRenderer.invoke(CRM_CHANNELS.getDeal, id),
  saveDeal: (deal: Partial<Deal>) => ipcRenderer.invoke(CRM_CHANNELS.saveDeal, deal),
  updateDealStage: (id: string, stage: DealStage) =>
    ipcRenderer.invoke(CRM_CHANNELS.updateDealStage, id, stage),
  deleteDeal: (id: string) => ipcRenderer.invoke(CRM_CHANNELS.deleteDeal, id),

  listContacts: () => ipcRenderer.invoke(CRM_CHANNELS.listContacts),
  saveContact: (contact: Partial<Contact>) => ipcRenderer.invoke(CRM_CHANNELS.saveContact, contact),
  deleteContact: (id: string) => ipcRenderer.invoke(CRM_CHANNELS.deleteContact, id),

  listCompanies: () => ipcRenderer.invoke(CRM_CHANNELS.listCompanies),
  saveCompany: (company: Partial<Company>) => ipcRenderer.invoke(CRM_CHANNELS.saveCompany, company),
  deleteCompany: (id: string) => ipcRenderer.invoke(CRM_CHANNELS.deleteCompany, id),

  listActivities: (filter) => ipcRenderer.invoke(CRM_CHANNELS.listActivities, filter),
  addActivity: (act) => ipcRenderer.invoke(CRM_CHANNELS.addActivity, act),
  updateActivity: (id: string, patch: ActivityPatch) =>
    ipcRenderer.invoke(CRM_CHANNELS.updateActivity, id, patch),
  deleteActivity: (id: string) => ipcRenderer.invoke(CRM_CHANNELS.deleteActivity, id),
  toggleActivity: (id) => ipcRenderer.invoke(CRM_CHANNELS.toggleActivity, id),

  exportToSheets: () => ipcRenderer.invoke(CRM_CHANNELS.exportToSheets),
  generateProposalDoc: (dealId: string) =>
    ipcRenderer.invoke(CRM_CHANNELS.generateProposalDoc, dealId),
  openTenders: () => ipcRenderer.invoke(CRM_CHANNELS.openTenders),
  openBooks: () => ipcRenderer.invoke(CRM_CHANNELS.openBooks),
  createInvoiceInBooks: (dealId: string) =>
    ipcRenderer.invoke(CRM_CHANNELS.createInvoiceInBooks, dealId),
}

contextBridge.exposeInMainWorld('crmApi', crmApi)

declare global {
  interface Window {
    crmApi: CrmApi
  }
}

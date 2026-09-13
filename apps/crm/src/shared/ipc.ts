import type {
  Activity,
  ActivityPatch,
  Company,
  Contact,
  CrmAuditEntry,
  CrmStats,
  Deal,
  DealStage,
} from './types'

export interface CrmRecoveryItem {
  entity: 'deals' | 'contacts' | 'companies' | 'activities'
  file: string
  quarantinePath: string
  reason: string
}

export interface CrmRecoveryState {
  items: Array<CrmRecoveryItem & { acknowledged: boolean }>
  pending: boolean
}

export const CRM_CHANNELS = {
  getStats: 'crm:get-stats',
  getRecoveryState: 'crm:getRecoveryState',
  acknowledgeRecovery: 'crm:acknowledgeRecovery',
  listAudit: 'crm:list-audit',
  findContactDuplicate: 'crm:find-contact-duplicate',
  findCompanyDuplicate: 'crm:find-company-duplicate',
  // Deals
  listDeals: 'crm:list-deals',
  getDeal: 'crm:get-deal',
  saveDeal: 'crm:save-deal',
  updateDealStage: 'crm:update-deal-stage',
  deleteDeal: 'crm:delete-deal',
  // Contacts
  listContacts: 'crm:list-contacts',
  saveContact: 'crm:save-contact',
  deleteContact: 'crm:delete-contact',
  // Companies
  listCompanies: 'crm:list-companies',
  saveCompany: 'crm:save-company',
  deleteCompany: 'crm:delete-company',
  // Activities
  listActivities: 'crm:list-activities',
  addActivity: 'crm:add-activity',
  updateActivity: 'crm:update-activity',
  deleteActivity: 'crm:delete-activity',
  toggleActivity: 'crm:toggle-activity',
  // Cross-App Integrations
  exportToSheets: 'crm:export-to-sheets',
  generateProposalDoc: 'crm:generate-proposal-doc',
  openTenders: 'crm:open-tenders',
  createInvoiceInBooks: 'crm:create-invoice-in-books',
  openBooks: 'crm:open-books',
} as const

export interface CrmApi {
  getStats(): Promise<CrmStats>
  getRecoveryState(): Promise<CrmRecoveryState>
  acknowledgeRecovery(): Promise<void>
  listAudit(filter?: { dealId?: string; limit?: number }): Promise<CrmAuditEntry[]>
  findContactDuplicate(
    email: string,
    excludeId?: string,
  ): Promise<{ id: string; name: string } | null>
  findCompanyDuplicate(
    name: string,
    domain?: string,
    excludeId?: string,
  ): Promise<{ id: string; name: string } | null>
  openTenders(): Promise<boolean>
  openBooks(): Promise<boolean>
  createInvoiceInBooks(
    dealId: string,
  ): Promise<{ ok: boolean; invoiceNumber?: string; invoiceId?: string; error?: string }>
  // Deals
  listDeals(): Promise<Deal[]>
  getDeal(id: string): Promise<Deal | null>
  saveDeal(deal: Partial<Deal>): Promise<Deal>
  updateDealStage(id: string, stage: DealStage): Promise<boolean>
  deleteDeal(id: string): Promise<boolean>
  // Contacts
  listContacts(): Promise<Contact[]>
  saveContact(contact: Partial<Contact>): Promise<Contact>
  deleteContact(id: string): Promise<boolean>
  // Companies
  listCompanies(): Promise<Company[]>
  saveCompany(company: Partial<Company>): Promise<Company>
  deleteCompany(id: string): Promise<boolean>
  // Activities
  listActivities(filter?: { dealId?: string; contactId?: string }): Promise<Activity[]>
  addActivity(activity: Omit<Activity, 'id' | 'createdAt'>): Promise<Activity>
  updateActivity(id: string, patch: ActivityPatch): Promise<Activity>
  deleteActivity(id: string): Promise<boolean>
  toggleActivity(id: string): Promise<boolean>
  // Cross-App
  exportToSheets(): Promise<{ ok: boolean; path?: string; error?: string }>
  generateProposalDoc(dealId: string): Promise<{ ok: boolean; path?: string; error?: string }>
}

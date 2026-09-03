import type { Activity, Company, Contact, CrmStats, Deal, DealStage } from './types'

export const CRM_CHANNELS = {
  getStats: 'crm:get-stats',
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
  toggleActivity(id: string): Promise<boolean>
  // Cross-App
  exportToSheets(): Promise<{ ok: boolean; path?: string; error?: string }>
  generateProposalDoc(dealId: string): Promise<{ ok: boolean; path?: string; error?: string }>
}

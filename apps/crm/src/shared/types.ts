export type DealStage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'

export interface Deal {
  id: string
  name: string
  companyId?: string
  companyName?: string
  contactId?: string
  contactName?: string
  amount: number
  stage: DealStage
  probability: number
  owner?: string
  nextStep?: string
  expectedCloseDate?: string
  notes?: string
  invoiceId?: string
  invoiceNumber?: string
  invoicedAt?: string
  deletedAt?: string
  createdAt: string
  updatedAt: string
}

export interface DealsStoreEnvelope {
  version: number
  updatedAt: string
  deals: Deal[]
}

export interface Contact {
  id: string
  name: string
  email: string
  phone?: string
  title?: string
  companyId?: string
  companyName?: string
  tags: string[]
  status: 'lead' | 'active' | 'churned'
  deletedAt?: string
  createdAt: string
  updatedAt: string
}

export interface Company {
  id: string
  name: string
  domain?: string
  industry?: string
  size?: string
  website?: string
  city?: string
  country?: string
  deletedAt?: string
  createdAt: string
}

export interface Activity {
  id: string
  dealId?: string
  contactId?: string
  type: 'note' | 'call' | 'meeting' | 'email' | 'task'
  title: string
  description: string
  createdAt: string
  completed?: boolean
  dueDate?: string
}

export type ActivityPatch = Partial<
  Pick<Activity, 'title' | 'description' | 'type' | 'dueDate' | 'completed'>
>

export type CrmAuditEntity = 'deal' | 'contact' | 'company' | 'activity'
export type CrmAuditAction =
  'create' | 'update' | 'delete' | 'restore' | 'stage-change' | 'invoice-linked'

export interface CrmAuditEntry {
  id: string
  at: string
  entity: CrmAuditEntity
  entityId: string
  action: CrmAuditAction
  summary: string
  dealId?: string
}

export interface CrmStats {
  totalDeals: number
  openDeals: number
  wonDeals: number
  lostDeals: number
  totalPipelineValue: number
  weightedForecastValue: number
  avgOpenDealSize: number
  wonValue: number
  winRatePct: number
  totalContacts: number
  totalCompanies: number
}

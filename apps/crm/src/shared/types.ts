export type DealStage =
  | 'lead'
  | 'qualified'
  | 'proposal'
  | 'negotiation'
  | 'won'
  | 'lost'

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
  expectedCloseDate?: string
  notes?: string
  createdAt: string
  updatedAt: string
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
}

export interface CrmStats {
  totalDeals: number
  totalPipelineValue: number
  wonValue: number
  winRatePct: number
  totalContacts: number
  totalCompanies: number
}

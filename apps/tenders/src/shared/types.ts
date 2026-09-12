// Zanostack Tenders shared types — desktop RFP shredder & compliance system

// ── App navigation ────────────────────────────────────────────────────────────
export type AppPage = 'overview' | 'customers' | 'documents' | 'tenders' | 'profile' | 'tutorials'

// ── Customer types ─────────────────────────────────────────────────────────────
export type CustomerStatus = 'ACTIVE' | 'PROSPECT' | 'INACTIVE'

export interface CustomerDoc {
  docCategory: DocCategory
  label: string
  fulfilled: boolean
  linkedVaultDocId: string | null
}

export interface Customer {
  id: string
  name: string
  contactName: string
  contactEmail: string
  contactPhone: string
  industry: string
  status: CustomerStatus
  since: string // ISO date
  notes: string
  requiredDocs: CustomerDoc[]
}

// ── Company profile ────────────────────────────────────────────────────────────
export type ProjectStatus = 'COMPLETED' | 'IN_PROGRESS' | 'BIDDING' | 'ON_HOLD'

export interface CompanyProject {
  id: string
  title: string
  client: string
  value: string
  period: string
  status: ProjectStatus
  description: string
  sector: string
}

export interface CompanyDirector {
  name: string
  role: string
  idNumber: string
}

export interface CompanyProfile {
  name: string
  tradingName: string
  registrationNumber: string
  vatNumber: string
  taxPin: string
  bbbeeLevel: string
  bbbeeBlackOwnership: string
  csdSupplierNumber: string
  founded: string
  employees: string
  industry: string
  description: string
  address: string
  phone: string
  email: string
  website: string
  directors: CompanyDirector[]
  projects: CompanyProject[]
}

// ── Document & Compliance Categories ───────────────────────────────────────────
export type DocCategory = 'COMPLIANCE' | 'FINANCIAL' | 'TECHNICAL' | 'GOVERNANCE' | 'CV'
export type RequirementCategory =
  | 'MANDATORY_STAGE_1'
  | 'FUNCTIONALITY_STAGE_2'
  | 'FINANCIAL_STAGE_3'
  | 'GENERAL_RETURNABLE'
export type RiskLevel = 'CRITICAL_DISQUALIFIER' | 'POINT_SCORED' | 'INFORMATIONAL'
export type FulfillmentStatus = 'FULFILLED' | 'ACTION_REQUIRED' | 'OUTSTANDING' | 'NOT_APPLICABLE'
export type TenderStatus = 'IN_PROGRESS' | 'READY_FOR_SUBMISSION' | 'SUBMITTED' | 'ARCHIVED'

export type SubmissionMethod = 'PHYSICAL' | 'ELECTRONIC' | 'EMAIL'

/** Normalized (0.0–1.0) rect over a PDF page, origin top-left. */
export interface BoundingBox {
  top: number
  left: number
  width: number
  height: number
}

/** One rendered text line from a page. */
export interface PageLine {
  pageNumber: number
  text: string
  box: BoundingBox
}

export interface ExtractedPage {
  pageNumber: number
  width: number
  height: number
  text: string
  lines: PageLine[]
  needsOcr: boolean
}

export interface PageExtraction {
  numPages: number
  pages: ExtractedPage[]
  textPages: number
  ocrPages: number
}

/** A requirement produced by the shredder. */
export interface ExtractedRequirement {
  id: string
  ruleKey: string
  title: string
  category: RequirementCategory
  isMandatory: boolean
  verbatimClause: string
  pageNumber: number
  boundingBox: BoundingBox
  riskLevel: RiskLevel
  order: number
  additionalClauses?: { text: string; pageNumber: number }[]
  confidence?: number
  notes?: string
}

/** Requirement + working state in the compliance matrix. */
export interface RequirementRecord extends ExtractedRequirement {
  status: FulfillmentStatus
  linkedVaultDocId: string | null
  reason: string | null
  suggestedVaultDocIds: string[]
}

export type DocHealth = 'VALID' | 'EXPIRED' | 'STALE_CERTIFICATION' | 'NO_EXPIRY_INFO'

export interface VaultDoc {
  id: string
  title: string
  category: DocCategory
  fileUrl: string | null
  issueDate: string | null // ISO
  expiryDate: string | null // ISO
  isCertified: boolean
  certifiedDate: string | null // ISO — 90-day police stamp window
  metadata: Record<string, string>
}

export interface TenderRecord {
  id: string
  title: string
  referenceNumber: string | null
  issuingBody: string | null
  closingDate: string | null
  submissionMethod: SubmissionMethod | null
  submissionAddress: string | null
  signatureChecks: Record<string, boolean>
  status: TenderStatus
  createdAt: string
  fileName: string
  fileUrl: string
  numPages: number
  ocrPages: number
  requirements: RequirementRecord[]
  linkedCrmDealId?: string | null
  estimatedValue?: number | null
  milestones?: ContractMilestone[]
}

export type MilestoneBillingStatus = 'PENDING' | 'REACHED' | 'BILLED' | 'PAID'
export type MilestoneStatus = MilestoneBillingStatus

export interface ContractMilestone {
  id: string
  name: string
  title?: string
  description?: string
  amount: number
  dueDate?: string
  completedDate?: string
  status: MilestoneBillingStatus
  billedInvoiceId?: string
  billedInvoiceNumber?: string
  billedAt?: string
  billedDate?: string
}


export interface CompanyWorkspace {
  id: string
  name?: string
  company: CompanyProfile
  customers: Customer[]
  vault: VaultDoc[]
  tenders: TenderRecord[]
}

export interface IssuerTemplate {
  id: string
  name: string
  displayName: string
  address: string | null
  contact: string | null
  refStyle: string | null
  submissionMethod: SubmissionMethod | null
  submissionAddress: string | null
  seenCount: number
  lastSeen: string
}

export interface TendersData {
  version: number
  updatedAt: string
  activeCompanyId: string
  workspaces: CompanyWorkspace[]
  issuerTemplates: IssuerTemplate[]
}

export const SUBMISSION_METHOD_LABEL: Record<SubmissionMethod, string> = {
  PHYSICAL: 'Physical submission',
  ELECTRONIC: 'Electronic portal',
  EMAIL: 'Email submission',
}

export const TENDER_STATUS_LABEL: Record<TenderStatus, string> = {
  IN_PROGRESS: 'In progress',
  READY_FOR_SUBMISSION: 'Ready for submission',
  SUBMITTED: 'Submitted',
  ARCHIVED: 'Archived',
}

export const REQUIREMENT_CATEGORY_LABEL: Record<RequirementCategory, string> = {
  MANDATORY_STAGE_1: 'Stage 1 · Mandatory Returnables',
  FUNCTIONALITY_STAGE_2: 'Stage 2 · Functionality / Technical',
  FINANCIAL_STAGE_3: 'Stage 3 · Financial',
  GENERAL_RETURNABLE: 'General Returnables',
}

export const CATEGORY_ORDER: RequirementCategory[] = [
  'MANDATORY_STAGE_1',
  'FUNCTIONALITY_STAGE_2',
  'FINANCIAL_STAGE_3',
  'GENERAL_RETURNABLE',
]

export const DOC_CATEGORY_LABEL: Record<DocCategory, string> = {
  COMPLIANCE: 'Compliance',
  FINANCIAL: 'Financial',
  TECHNICAL: 'Technical',
  GOVERNANCE: 'Governance',
  CV: 'CV / Personnel',
}

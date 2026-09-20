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
  /**
   * Soft-archive marker (WP-8). Additive/optional: absent means active.
   * Destructive delete is deferred to the managed-file/trash lane.
   */
  archivedAt?: string | null
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
  /**
   * Soft-archive marker (WP-8). Additive/optional: absent means active.
   * Destructive delete is deferred to the managed-file/trash lane.
   */
  archivedAt?: string | null
}

// ── Document & Compliance Categories ───────────────────────────────────────────
export type DocCategory = 'COMPLIANCE' | 'FINANCIAL' | 'TECHNICAL' | 'GOVERNANCE' | 'CV'
export type RequirementCategory =
  'MANDATORY_STAGE_1' | 'FUNCTIONALITY_STAGE_2' | 'FINANCIAL_STAGE_3' | 'GENERAL_RETURNABLE'
export type RiskLevel = 'CRITICAL_DISQUALIFIER' | 'POINT_SCORED' | 'INFORMATIONAL'
export type FulfillmentStatus = 'FULFILLED' | 'ACTION_REQUIRED' | 'OUTSTANDING' | 'NOT_APPLICABLE'

/**
 * Tender lifecycle (WP-11). ADDITIVE on schema v2 — the original four values
 * remain valid and map onto the documented flow as:
 *
 *   IN_PROGRESS            = preparing              (legacy name kept verbatim)
 *   READY_FOR_SUBMISSION   = ready to submit
 *   SUBMITTED              = submitted, evidence not yet recorded (legacy)
 *   ARCHIVED               = archived
 *
 * New states add the rest of the flow:
 *   READY_TO_ASSEMBLE → PACK_GENERATED → READY_FOR_SUBMISSION →
 *   SUBMITTED → SUBMITTED_EVIDENCED → WON | LOST | WITHDRAWN | CANCELLED → ARCHIVED
 */
export type TenderStatus =
  | 'IN_PROGRESS'
  | 'READY_TO_ASSEMBLE'
  | 'PACK_GENERATED'
  | 'READY_FOR_SUBMISSION'
  | 'SUBMITTED'
  | 'SUBMITTED_EVIDENCED'
  | 'WON'
  | 'LOST'
  | 'WITHDRAWN'
  | 'CANCELLED'
  | 'ARCHIVED'

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
  /** User-entered audit justification used only when status is NOT_APPLICABLE. */
  notApplicableReason?: string | null
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

/** A frozen readiness checkpoint captured when a submission is recorded. */
export interface TenderReadinessSnapshot {
  /** True only when a current, blockers-free checkpoint was captured. */
  ready: boolean
  score: number
  failedCheckIds: string[]
  /** Blocking checks that were failing when this snapshot was captured. */
  blockingCheckIds: string[]
  capturedAt: string
}

/** Receipt / evidence attachment captured with a submission. */
export interface TenderSubmissionEvidence {
  /** e.g. 'email-receipt' | 'portal-confirmation' | 'courier-slip' | 'attachment'. */
  kind: string
  /** Vault-doc id or stored-path reference; null when only a note exists. */
  reference: string | null
  note: string | null
}

/** Proof-of-submission record (WP-11). Additive; absent on legacy tenders. */
export interface TenderSubmissionRecord {
  /** RFC3339 instant the bid was submitted. */
  submittedAt: string
  /** Optional IANA zone or offset label the submitter reported. */
  timeZone: string | null
  method: SubmissionMethod
  destination: string | null
  confirmationReference: string | null
  evidence: TenderSubmissionEvidence | null
  person: string | null
  notes: string | null
  readiness: TenderReadinessSnapshot | null
  /**
   * Present ONLY when submitted with blocking checks or without a current clear
   * checkpoint. The readiness snapshot is preserved unchanged (`ready:false`
   * with its blockers); this is an audited override, never a "cleared" claim.
   */
  blockerOverrideReason: string | null
}

export type TenderOutcomeStatus = 'pending' | 'won' | 'lost' | 'withdrawn' | 'cancelled'

/** Tender outcome record (WP-11). Additive; absent until an outcome is known. */
export interface TenderOutcomeRecord {
  status: TenderOutcomeStatus
  /** RFC3339 notice/award date if the issuer stated one. */
  noticeDate: string | null
  reason: string | null
  awardedValue: number | null
  evidenceReference: string | null
  recordedAt: string
}

/** One append-only lifecycle transition. Entries are added, never rewritten. */
export interface TenderLifecycleEvent {
  at: string
  from: TenderStatus | null
  to: TenderStatus
  reason: string | null
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
  /** True only after the tender price has been explicitly reviewed/confirmed. */
  pricingConfirmed?: boolean
  milestones?: ContractMilestone[]
  /**
   * Authoritative intake-verification state (Phase 3). Additive and optional:
   * documents written before this field existed validate unchanged, and
   * readiness only enforces the verification gate when it is present.
   */
  intakeVerification?: IntakeVerification
  /** Proof-of-submission record. Additive; absent on legacy tenders. */
  submission?: TenderSubmissionRecord | null
  /** Outcome record. Additive; absent until an outcome is known. */
  outcome?: TenderOutcomeRecord | null
  /** Append-only lifecycle audit (when/why the status changed). */
  lifecycle?: TenderLifecycleEvent[]
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

// ── Intake verification (Phase 3) ─────────────────────────────────────────────
// Review annotations and per-page extraction state live inside the authoritative
// v2 document on the tender itself, so review decisions that gate readiness are
// persisted, validated and revision-tracked like any other domain record —
// never in a side localStorage key.

/** Tender metadata field that can be reviewed / confirmed. */
export type ReviewFieldKey =
  | 'title'
  | 'referenceNumber'
  | 'issuingBody'
  | 'contactEmail'
  | 'closingDate'
  | 'submissionMethod'
  | 'submissionDestination'
  | 'estimatedValue'

export type ReviewFieldState = 'unconfirmed' | 'confirmed' | 'corrected' | 'not_stated'

/** One competing value the review layer found in the source document. */
export interface ReviewCandidate {
  value: string
  sourcePage: number | null
  sourceClause: string | null
  /** 0–1 relative strength within this field's candidate set. */
  score: number
}

export interface FieldReview {
  /** What the parser lifted before any correction — provenance. */
  extractedValue: string | null
  sourcePage: number | null
  sourceClause: string | null
  confidence: number | null
  candidates: ReviewCandidate[]
  state: ReviewFieldState
  reviewedAt: string | null
}

export type RequirementReviewState = 'unreviewed' | 'verified'

export interface RequirementReview {
  state: RequirementReviewState
  /** Requirement title before the user corrected it — provenance. */
  originalTitle: string | null
  /** Category before the user reclassified it — provenance. */
  originalCategory: RequirementCategory | null
  correctedAt: string | null
}

/** Per-page extraction method. OCR-required/failed/unavailable pages block readiness. */
export type PageExtractionStatus =
  'native' | 'ocr-required' | 'ocr-unavailable' | 'ocr-failed' | 'manually-reviewed'

export interface PageExtractionState {
  pageNumber: number
  state: PageExtractionStatus
  /** e.g. 'native-text' | 'ocr' | null when OCR has not run. */
  method: string | null
  confidence: number | null
  reviewedAt: string | null
}

export interface IntakeVerification {
  fields: Partial<Record<ReviewFieldKey, FieldReview>>
  requirements: Record<string, RequirementReview>
  /** Additive: absent means "no page-level extraction state was captured". */
  pages?: PageExtractionState[]
  /** Clarification e-mail — no TenderRecord field exists, so it is review-scoped. */
  contactEmail: string | null
  /** Parser notes about competing values, shown at the top of the review step. */
  conflicts: string[]
  createdAt: string
  updatedAt: string
}

/**
 * Metadata fields that must be explicitly decided before readiness may clear.
 * `contactEmail` / `estimatedValue` are review-scoped and are not readiness gates.
 */
export const INTAKE_CRITICAL_REVIEW_FIELDS: readonly ReviewFieldKey[] = [
  'title',
  'referenceNumber',
  'issuingBody',
  'closingDate',
  'submissionMethod',
  'submissionDestination',
]

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

/** Persisted schema v1 envelope retained for Phase 2 migration tests. */
export interface TendersDataV1 {
  version: 1
  updatedAt: string
  activeCompanyId: string
  workspaces: CompanyWorkspace[]
  issuerTemplates: IssuerTemplate[]
}

export type WorkspaceDataOrigin = 'user' | 'demo'

/** Schema v2 workspace: origin is explicit so demo data cannot be mistaken for user data. */
export interface TendersWorkspaceV2 extends CompanyWorkspace {
  dataOrigin: WorkspaceDataOrigin
}

/** Schema v2 envelope. `revision` is intended to be a non-negative counter. */
export interface TendersDataV2 {
  schemaVersion: 2
  revision: number
  updatedAt: string
  activeCompanyId: string | null
  workspaces: TendersWorkspaceV2[]
  issuerTemplates: IssuerTemplate[]
}

export const SUBMISSION_METHOD_LABEL: Record<SubmissionMethod, string> = {
  PHYSICAL: 'Physical submission',
  ELECTRONIC: 'Electronic portal',
  EMAIL: 'Email submission',
}

export const TENDER_STATUS_LABEL: Record<TenderStatus, string> = {
  IN_PROGRESS: 'In progress',
  READY_TO_ASSEMBLE: 'Ready to assemble',
  PACK_GENERATED: 'Pack generated',
  READY_FOR_SUBMISSION: 'Ready for submission',
  SUBMITTED: 'Submitted · evidence required',
  SUBMITTED_EVIDENCED: 'Submitted · evidence recorded',
  WON: 'Won',
  LOST: 'Lost',
  WITHDRAWN: 'Withdrawn',
  CANCELLED: 'Cancelled',
  ARCHIVED: 'Archived',
}

export const TENDER_OUTCOME_LABEL: Record<TenderOutcomeStatus, string> = {
  pending: 'Pending',
  won: 'Won',
  lost: 'Lost',
  withdrawn: 'Withdrawn',
  cancelled: 'Cancelled',
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

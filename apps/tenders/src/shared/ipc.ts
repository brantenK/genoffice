// IPC channel definitions and context bridge API for Zanostack Tenders

export const TENDERS_CHANNELS = {
  getStoredData: 'tenders:get-stored-data',
  saveStoredData: 'tenders:save-stored-data',
  exportMatrixToSheets: 'tenders:export-matrix-to-sheets',
  draftProposalDoc: 'tenders:draft-proposal-doc',
  syncWithCrm: 'tenders:sync-with-crm',
  openInCrm: 'tenders:open-in-crm',
  billMilestoneInBooks: 'tenders:bill-milestone-in-books',
  openBooks: 'tenders:open-books',
} as const

export interface BillMilestoneRequest {
  tenderId: string
  milestoneId: string
  tenderReference?: string
  issuingAuthority?: string
  milestoneTitle?: string
  amount?: number
  notes?: string
}

export interface BillMilestoneResult {
  ok: boolean
  invoiceNumber?: string
  invoiceId?: string
  tenderReference?: string
  grandTotal?: number
  subtotal?: number
  taxTotal?: number
  error?: string
}

export interface TendersApi {
  getStoredData: () => Promise<string | null>
  saveStoredData: (json: string) => Promise<boolean>
  exportMatrixToSheets: (tenderId: string, tenderTitle: string, matrixRows: any[]) => Promise<{ ok: boolean; path?: string; error?: string }>
  draftProposalDoc: (tender: any) => Promise<{ ok: boolean; path?: string; error?: string }>
  syncWithCrm: (dealData: { name: string; amount: number; companyName: string; notes?: string }) => Promise<{ ok: boolean; dealId?: string; error?: string }>
  openInCrm: (dealId?: string) => Promise<{ ok: boolean }>
  billMilestoneInBooks: (
    tenderIdOrPayload: string | BillMilestoneRequest,
    milestoneId?: string
  ) => Promise<BillMilestoneResult>
  openBooks: () => Promise<boolean>
}

declare global {
  interface Window {
    tendersApi?: TendersApi
  }
}

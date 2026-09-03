// IPC channel definitions and context bridge API for Zanostack Tenders

export const TENDERS_CHANNELS = {
  getStoredData: 'tenders:get-stored-data',
  saveStoredData: 'tenders:save-stored-data',
  exportMatrixToSheets: 'tenders:export-matrix-to-sheets',
  draftProposalDoc: 'tenders:draft-proposal-doc',
  syncWithCrm: 'tenders:sync-with-crm',
  openInCrm: 'tenders:open-in-crm',
} as const

export interface TendersApi {
  getStoredData: () => Promise<string | null>
  saveStoredData: (json: string) => Promise<boolean>
  exportMatrixToSheets: (tenderId: string, tenderTitle: string, matrixRows: any[]) => Promise<{ ok: boolean; path?: string; error?: string }>
  draftProposalDoc: (tender: any) => Promise<{ ok: boolean; path?: string; error?: string }>
  syncWithCrm: (dealData: { name: string; amount: number; companyName: string; notes?: string }) => Promise<{ ok: boolean; dealId?: string; error?: string }>
  openInCrm: (dealId?: string) => Promise<{ ok: boolean }>
}

declare global {
  interface Window {
    tendersApi?: TendersApi
  }
}

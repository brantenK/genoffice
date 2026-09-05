// IPC channel definitions and context bridge API for Zanostack Tenders

import type { TendersData } from './types'

export const TENDERS_CHANNELS = {
  getStoredData: 'tenders:get-stored-data',
  saveStoredData: 'tenders:save-stored-data',
  dataChanged: 'tenders:data-changed',
  saveDocument: 'tenders:save-document',
  readDocument: 'tenders:read-document',
  openDocument: 'tenders:open-document',
  deleteDocument: 'tenders:delete-document',
  exportMatrixToSheets: 'tenders:export-matrix-to-sheets',
  draftProposalDoc: 'tenders:draft-proposal-doc',
  syncWithCrm: 'tenders:sync-with-crm',
  openInCrm: 'tenders:open-in-crm',
  billMilestoneInBooks: 'tenders:bill-milestone-in-books',
  openBooks: 'tenders:open-books',
} as const

export interface SaveDocumentRequest {
  fileName: string
  buffer: ArrayBuffer | Uint8Array
  category: 'rfp' | 'vault'
}

export interface SaveDocumentResponse {
  ok: boolean
  storedPath?: string
  error?: string
}

export interface ReadDocumentRequest {
  storedPath: string
}

export interface ReadDocumentResponse {
  ok: boolean
  buffer?: ArrayBuffer
  error?: string
}

export interface OpenDocumentRequest {
  storedPath: string
}

export interface OpenDocumentResponse {
  ok: boolean
  error?: string
}

export interface DeleteDocumentRequest {
  storedPath: string
}

export interface DeleteDocumentResponse {
  ok: boolean
  error?: string
}

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

export interface TendersApiBridge {
  getStoredData: () => Promise<string | null>
  saveStoredData: (json: string) => Promise<{ ok: boolean; error?: string }>
  onDataChanged: (callback: (data: TendersData) => void) => () => void
  saveDocument: (req: SaveDocumentRequest) => Promise<SaveDocumentResponse>
  readDocument: (req: ReadDocumentRequest) => Promise<ReadDocumentResponse>
  openDocument: (req: OpenDocumentRequest) => Promise<OpenDocumentResponse>
  deleteDocument: (req: DeleteDocumentRequest) => Promise<DeleteDocumentResponse>
}

export interface TendersApi extends TendersApiBridge {
  getStoredData: () => Promise<string | null>
  saveStoredData: (json: string) => Promise<{ ok: boolean; error?: string }>
  onDataChanged: (callback: (data: TendersData) => void) => () => void
  saveDocument: (req: SaveDocumentRequest) => Promise<SaveDocumentResponse>
  readDocument: (req: ReadDocumentRequest) => Promise<ReadDocumentResponse>
  openDocument: (req: OpenDocumentRequest) => Promise<OpenDocumentResponse>
  deleteDocument: (req: DeleteDocumentRequest) => Promise<DeleteDocumentResponse>
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


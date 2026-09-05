import type { BooksData, Invoice, SettlementSuggestion } from './types'

export const BOOKS_CHANNELS = {
  loadData: 'books:load-data',
  saveData: 'books:save-data',
  dataChanged: 'books:data-changed',
  DATA_CHANGED: 'books:data-changed',
  getData: 'books:get-data',
  exportToSheets: 'books:export-to-sheets',
  openInPdf: 'books:open-in-pdf',
  openInCrm: 'books:open-in-crm',
  openInTenders: 'books:open-in-tenders',
  importBankStatementCsv: 'books:import-bank-statement-csv',
  reconcileTransaction: 'books:reconcile-transaction',
  getSettlementSuggestions: 'books:get-settlement-suggestions',
} as const

export interface BooksApi {
  loadData: () => Promise<BooksData>
  saveData: (data: BooksData) => Promise<boolean>
  onDataChanged?: (callback: (data: BooksData) => void) => () => void
  exportToSheets: (reportName: string, csvContent: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  openInPdf: (invoice: Invoice, companyName: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  openInCrm: () => Promise<boolean>
  openInTenders: () => Promise<boolean>
  importBankStatementCsv: (csvContent: string) => Promise<{
    ok: boolean
    importedCount?: number
    skippedDuplicates?: number
    netAdjustment?: number
    newBankBalance?: number
    error?: string
  }>
  reconcileTransaction: (transactionId: string, invoiceId: string) => Promise<{ ok: boolean; error?: string }>
  getSettlementSuggestions: () => Promise<SettlementSuggestion[]>
}

declare global {
  interface Window {
    booksApi?: BooksApi
  }
}


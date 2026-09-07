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
  backupNow: 'books:backup-now',
  listBackups: 'books:list-backups',
  restoreBackup: 'books:restore-backup',
} as const

export interface BackupResult {
  ok: boolean
  path?: string
  error?: string
}

export interface BackupFileInfo {
  name: string
  path: string
  size: number
  modifiedAt: string
}

export interface BooksApi {
  loadData: () => Promise<BooksData>
  saveData: (data: BooksData) => Promise<boolean>
  onDataChanged?: (callback: (data: BooksData) => void) => () => void
  exportToSheets: (
    reportName: string,
    csvContent: string,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>
  openInPdf: (
    invoice: Invoice,
    companyName: string,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>
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
  reconcileTransaction: (
    transactionId: string,
    invoiceId: string,
  ) => Promise<{ ok: boolean; error?: string }>
  getSettlementSuggestions: () => Promise<SettlementSuggestion[]>
  backupNow: () => Promise<BackupResult>
  listBackups: () => Promise<BackupFileInfo[]>
  restoreBackup: (backupName: string) => Promise<{ ok: boolean; error?: string }>
}

declare global {
  interface Window {
    booksApi?: BooksApi
  }
}

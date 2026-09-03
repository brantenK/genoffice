import type { BooksData, Invoice } from './types'

export const BOOKS_CHANNELS = {
  loadData: 'books:load-data',
  saveData: 'books:save-data',
  exportToSheets: 'books:export-to-sheets',
  openInPdf: 'books:open-in-pdf',
  openInCrm: 'books:open-in-crm',
  openInTenders: 'books:open-in-tenders',
} as const

export interface BooksApi {
  loadData: () => Promise<BooksData>
  saveData: (data: BooksData) => Promise<boolean>
  exportToSheets: (reportName: string, csvContent: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  openInPdf: (invoice: Invoice, companyName: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  openInCrm: () => Promise<boolean>
  openInTenders: () => Promise<boolean>
}

declare global {
  interface Window {
    booksApi?: BooksApi
  }
}

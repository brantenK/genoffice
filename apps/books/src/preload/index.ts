import { contextBridge, ipcRenderer } from 'electron'
import { BOOKS_CHANNELS, type BooksApi } from '../shared/ipc'
import type { BooksData, Invoice } from '../shared/types'

const booksApi: BooksApi = {
  loadData: () => ipcRenderer.invoke(BOOKS_CHANNELS.loadData),
  saveData: (data: BooksData) => ipcRenderer.invoke(BOOKS_CHANNELS.saveData, data),
  exportToSheets: (reportName: string, csvContent: string) =>
    ipcRenderer.invoke(BOOKS_CHANNELS.exportToSheets, reportName, csvContent),
  openInPdf: (invoice: Invoice, companyName: string) =>
    ipcRenderer.invoke(BOOKS_CHANNELS.openInPdf, invoice, companyName),
  openInCrm: () => ipcRenderer.invoke(BOOKS_CHANNELS.openInCrm),
  openInTenders: () => ipcRenderer.invoke(BOOKS_CHANNELS.openInTenders),
  importBankStatementCsv: (csvContent: string) =>
    ipcRenderer.invoke(BOOKS_CHANNELS.importBankStatementCsv, csvContent),
  reconcileTransaction: (transactionId: string, invoiceId: string) =>
    ipcRenderer.invoke(BOOKS_CHANNELS.reconcileTransaction, transactionId, invoiceId),
  getSettlementSuggestions: () =>
    ipcRenderer.invoke(BOOKS_CHANNELS.getSettlementSuggestions),
  onDataChanged: (callback: (data: BooksData) => void) => {
    const listener = (_: any, data: BooksData) => callback(data)
    ipcRenderer.on(BOOKS_CHANNELS.dataChanged, listener)
    return () => {
      ipcRenderer.removeListener(BOOKS_CHANNELS.dataChanged, listener)
    }
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('booksApi', booksApi)
  } catch (error) {
    console.error('[books-preload] Failed to expose booksApi:', error)
  }
} else {
  ;(window as any).booksApi = booksApi
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, ipcMain, WebContentsView } from 'electron'
import { BOOKS_CHANNELS } from '../shared/ipc'
import type { BooksData, Invoice } from '../shared/types'

export interface BooksRuntimeConfig {
  preloadPath: string
  rendererUrl?: string | undefined
  rendererFile: string
  openGeneratedPath?: (path: string) => boolean
  onOpenCrm?: () => void
  onOpenTenders?: () => void
}

let runtime: BooksRuntimeConfig = {
  preloadPath: '',
  rendererFile: '',
}

let ipcRegistered = false

function getStoragePath(): string {
  const dir = join(app.getPath('userData'), 'books')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, 'books-data.json')
}

export function configureBooksRuntime(config: BooksRuntimeConfig): void {
  runtime = { ...runtime, ...config }
}

export function registerBooksIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  // Load persistence
  ipcMain.handle(BOOKS_CHANNELS.loadData, () => {
    try {
      const p = getStoragePath()
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf8')
        return JSON.parse(raw)
      }
      return null
    } catch {
      return null
    }
  })

  // Save persistence
  ipcMain.handle(BOOKS_CHANNELS.saveData, (_e, data: BooksData) => {
    try {
      const p = getStoragePath()
      writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  })

  // Cross-App: Export to Sheets
  ipcMain.handle(BOOKS_CHANNELS.exportToSheets, (_e, reportName: string, csvContent: string) => {
    try {
      const safeName = (reportName || 'Financial_Report').replace(/[^a-zA-Z0-9_-]/g, '_')
      const targetPath = join(tmpdir(), `${safeName}_${Date.now()}.csv`)
      writeFileSync(targetPath, csvContent, 'utf8')

      if (runtime.openGeneratedPath) {
        runtime.openGeneratedPath(targetPath)
      }
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to export report to Sheets' }
    }
  })

  // Cross-App: Print & Sign in PDF
  ipcMain.handle(BOOKS_CHANNELS.openInPdf, (_e, invoice: Invoice, companyName: string) => {
    try {
      const invoiceNo = (invoice?.invoiceNumber || 'INV-0001').replace(/[^a-zA-Z0-9_-]/g, '_')
      const targetPath = join(tmpdir(), `Tax_Invoice_${invoiceNo}.md`)
      
      const content = `# TAX INVOICE: ${invoice?.invoiceNumber}

**Issuer:** ${companyName || 'Zano Consulting (Pty) Ltd'}  
**Client / Billed To:** ${invoice?.partyName || 'Customer'}  
**Invoice Date:** ${invoice?.date}  
**Payment Due:** ${invoice?.dueDate}  
**Status:** ${invoice?.status?.toUpperCase()}  
${invoice?.tenderReference ? `**Reference:** ${invoice.tenderReference}  ` : ''}

---

### Line Items
| # | Description | Qty | Unit Rate | Tax Rate | Amount |
|---|---|---|---|---|---|
${(invoice?.items || []).map((it, idx) => `| ${idx + 1} | ${it.description} | ${it.qty} | R ${it.rate.toFixed(2)} | ${it.taxRate}% | R ${it.amount.toFixed(2)} |`).join('\n')}

---

### Summary
- **Subtotal:** R ${(invoice?.subtotal || 0).toFixed(2)}
- **VAT / Tax (15%):** R ${(invoice?.taxTotal || 0).toFixed(2)}
- **Grand Total:** R ${(invoice?.grandTotal || 0).toFixed(2)}
- **Amount Due:** R ${(invoice?.outstandingAmount || 0).toFixed(2)}

**Notes & Banking Details:**
${invoice?.notes || 'Standard 30 days payment terms. Please use invoice number as reference.'}

---
*Generated via Zano Books — Sovereign Financial Management*
`
      writeFileSync(targetPath, content, 'utf8')

      if (runtime.openGeneratedPath) {
        runtime.openGeneratedPath(targetPath)
      }
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to open invoice in PDF' }
    }
  })

  // Cross-App: Open CRM
  ipcMain.handle(BOOKS_CHANNELS.openInCrm, () => {
    if (runtime.onOpenCrm) {
      runtime.onOpenCrm()
      return true
    }
    return false
  })

  // Cross-App: Open Tenders
  ipcMain.handle(BOOKS_CHANNELS.openInTenders, () => {
    if (runtime.onOpenTenders) {
      runtime.onOpenTenders()
      return true
    }
    return false
  })
}

export function createBooksView(): WebContentsView {
  registerBooksIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (runtime.rendererUrl) {
    view.webContents.loadURL(runtime.rendererUrl)
  } else {
    view.webContents.loadFile(runtime.rendererFile)
  }

  return view
}

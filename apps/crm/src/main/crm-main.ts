import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, ipcMain, WebContentsView } from 'electron'
import { CRM_CHANNELS } from '../shared/ipc'
import type { Activity, Company, Contact, Deal, DealStage } from '../shared/types'
import { readBooksStore, writeBooksStore } from '../../../books/src/main/books-main'
import type { Invoice, JournalEntry } from '../../../books/src/shared/types'
import { CrmStore } from './crm-store'

export interface CrmRuntimeConfig {
  preloadPath: string
  rendererUrl?: string | undefined
  rendererFile: string
  openGeneratedPath?: (path: string) => boolean
  onOpenTenders?: (tenderTitle?: string) => void
  onOpenBooks?: () => void
}

let runtime: CrmRuntimeConfig = {
  preloadPath: '',
  rendererFile: '',
}

let store: CrmStore | null = null
let ipcRegistered = false

function getStore(): CrmStore {
  if (!store) {
    const userData = app.getPath('userData')
    store = new CrmStore(userData)
  }
  return store
}

export function configureCrmRuntime(config: CrmRuntimeConfig): void {
  runtime = { ...runtime, ...config }
}

export function registerCrmIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  const s = getStore()

  ipcMain.handle(CRM_CHANNELS.getStats, () => s.getStats())

  // Deals
  ipcMain.handle(CRM_CHANNELS.listDeals, () => s.getDeals())
  ipcMain.handle(CRM_CHANNELS.getDeal, (_e, id: string) => {
    return s.getDeals().find((d) => d.id === id) ?? null
  })
  ipcMain.handle(CRM_CHANNELS.saveDeal, (_e, deal: Partial<Deal>) => s.saveDeal(deal))
  ipcMain.handle(CRM_CHANNELS.updateDealStage, (_e, id: string, stage: DealStage) => {
    return s.updateDealStage(id, stage)
  })
  ipcMain.handle(CRM_CHANNELS.deleteDeal, (_e, id: string) => s.deleteDeal(id))

  // Contacts
  ipcMain.handle(CRM_CHANNELS.listContacts, () => s.getContacts())
  ipcMain.handle(CRM_CHANNELS.saveContact, (_e, contact: Partial<Contact>) => s.saveContact(contact))
  ipcMain.handle(CRM_CHANNELS.deleteContact, (_e, id: string) => s.deleteContact(id))

  // Companies
  ipcMain.handle(CRM_CHANNELS.listCompanies, () => s.getCompanies())
  ipcMain.handle(CRM_CHANNELS.saveCompany, (_e, company: Partial<Company>) => s.saveCompany(company))
  ipcMain.handle(CRM_CHANNELS.deleteCompany, (_e, id: string) => s.deleteCompany(id))

  // Activities
  ipcMain.handle(CRM_CHANNELS.listActivities, (_e, filter) => s.getActivities(filter))
  ipcMain.handle(CRM_CHANNELS.addActivity, (_e, act: Omit<Activity, 'id' | 'createdAt'>) => {
    return s.addActivity(act)
  })
  ipcMain.handle(CRM_CHANNELS.toggleActivity, (_e, id: string) => s.toggleActivity(id))

  // Cross-App: Export to Sheets (CSV format opens directly in Sheets)
  ipcMain.handle(CRM_CHANNELS.exportToSheets, () => {
    try {
      const deals = s.getDeals()
      const header = 'Deal Name,Company,Contact,Stage,Amount ($),Probability (%),Expected Close Date\n'
      const rows = deals
        .map((d) => {
          const name = `"${(d.name || '').replace(/"/g, '""')}"`
          const comp = `"${(d.companyName || '').replace(/"/g, '""')}"`
          const cont = `"${(d.contactName || '').replace(/"/g, '""')}"`
          const stage = d.stage.toUpperCase()
          const amount = d.amount || 0
          const prob = d.probability || 0
          const date = d.expectedCloseDate || ''
          return `${name},${comp},${cont},${stage},${amount},${prob},${date}`
        })
        .join('\n')

      const csvContent = header + rows
      const targetPath = join(tmpdir(), `Zanostack_Pipeline_${Date.now()}.csv`)
      writeFileSync(targetPath, csvContent, 'utf8')

      if (runtime.openGeneratedPath) {
        runtime.openGeneratedPath(targetPath)
      }
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to export deals' }
    }
  })

  // Cross-App: Generate Proposal (Markdown document opens directly in Docs/Markdown)
  ipcMain.handle(CRM_CHANNELS.generateProposalDoc, (_e, dealId: string) => {
    try {
      const deal = s.getDeals().find((d) => d.id === dealId)
      if (!deal) return { ok: false, error: 'Deal not found' }

      const content = `# Commercial Proposal: ${deal.name}

**Prepared for:** ${deal.companyName || 'Valued Client'}  
**Primary Contact:** ${deal.contactName || 'Executive Sponsor'}  
**Date:** ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}  
**Target Execution Date:** ${deal.expectedCloseDate || 'Immediate'}  

---

## 1. Executive Summary
This proposal outlines the commercial and technical scope for **${deal.name}**. Our solution is designed to streamline operations, enhance security, and deliver enterprise-grade performance.

## 2. Investment & Commercial Terms

| Item | Scope Description | Investment |
| :--- | :--- | :--- |
| **01** | Platform Licensing & Deployment | $${Math.round(deal.amount * 0.7).toLocaleString()} |
| **02** | Dedicated Implementation & SLA | $${Math.round(deal.amount * 0.3).toLocaleString()} |
| **Total** | **Comprehensive Solution Scope** | **$${deal.amount.toLocaleString()}** |

## 3. Notes & Discussion
${deal.notes ? `> ${deal.notes}\n\n` : ''}
- Payment Terms: Net 30 upon execution of contract.
- Implementation timeline begins within 5 business days of sign-off.

---

*Generated by Zanostack CRM*
`

      const targetPath = join(tmpdir(), `Proposal_${deal.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`)
      writeFileSync(targetPath, content, 'utf8')

      if (runtime.openGeneratedPath) {
        runtime.openGeneratedPath(targetPath)
      }
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to generate proposal' }
    }
  })

  // Cross-App: Open Tenders tab
  ipcMain.handle(CRM_CHANNELS.openTenders, (_e, tenderTitle?: string) => {
    if (runtime.onOpenTenders) {
      runtime.onOpenTenders(tenderTitle)
      return true
    }
    return false
  })

  // Cross-App: Open Books tab
  ipcMain.handle(CRM_CHANNELS.openBooks, () => {
    if (runtime.onOpenBooks) {
      runtime.onOpenBooks()
      return true
    }
    return false
  })

  // Cross-App: Create Invoice in Zano Books
  ipcMain.handle(CRM_CHANNELS.createInvoiceInBooks, async (_e, dealId: string) => {
    try {
      const deal = s.getDeals().find((d) => d.id === dealId)
      if (!deal) {
        return { ok: false, error: `Deal not found: ${dealId}` }
      }

      if (deal.stage !== 'won') {
        return { ok: false, error: `Deal is not won. Current stage: ${deal.stage}` }
      }

      if (deal.invoiceNumber || deal.invoiceId) {
        return {
          ok: true,
          invoiceNumber: deal.invoiceNumber,
          invoiceId: deal.invoiceId,
        }
      }

      const booksDir = join(app.getPath('userData'), 'books')
      const booksPath = join(booksDir, 'books-data.json')
      const booksData = readBooksStore(booksPath)

      const partyName = deal.companyName || deal.name || 'Valued Client'
      let party = booksData.parties.find(
        (p) => p.name.toLowerCase() === partyName.toLowerCase(),
      )

      if (!party) {
        party = {
          id: `party-${randomUUID().slice(0, 8)}`,
          name: partyName,
          type: 'Customer',
          email: `accounts@${partyName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'client'}.com`,
          outstandingBalance: 0,
        }
        booksData.parties.push(party)
      }

      const year = new Date().getFullYear()
      const count = booksData.invoices.length
      const invoiceNumber = `INV-${year}-${String(count + 1).padStart(3, '0')}`
      const invoiceId = `inv-${randomUUID().slice(0, 8)}`

      const grandTotal = Math.round(Number(deal.amount || 0) * 100) / 100
      const subtotal = Math.round((grandTotal / 1.15) * 100) / 100
      const taxTotal = Math.round((grandTotal - subtotal) * 100) / 100
      const today = new Date().toISOString().split('T')[0]
      const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]

      const newInvoice: Invoice = {
        id: invoiceId,
        invoiceNumber,
        type: 'Sales',
        partyId: party.id,
        partyName: party.name,
        date: today,
        dueDate,
        items: [
          {
            id: `item-${randomUUID().slice(0, 8)}`,
            itemCode: 'COMMERCIAL-DELIVERY',
            description: `${deal.name} - Commercial Implementation & Services`,
            accountId: 'acc-sales',
            accountName: 'Tender & Commercial Contracting Sales',
            qty: 1,
            rate: subtotal,
            taxRate: 15,
            amount: subtotal,
          },
        ],
        subtotal,
        taxTotal,
        grandTotal,
        outstandingAmount: grandTotal,
        status: 'Unpaid',
        notes: 'Payment terms: Net 30 days upon invoice receipt.',
        crmDealId: deal.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      booksData.invoices.unshift(newInvoice)
      party.outstandingBalance = Math.round((party.outstandingBalance + grandTotal) * 100) / 100

      // Double-entry ledger adjustment
      for (const acc of booksData.accounts) {
        if (acc.id === 'acc-ar') acc.balance = Math.round((acc.balance + grandTotal) * 100) / 100
        if (acc.id === 'acc-sales') acc.balance = Math.round((acc.balance + subtotal) * 100) / 100
        if (acc.id === 'acc-vat') acc.balance = Math.round((acc.balance + taxTotal) * 100) / 100
      }

      // Balanced Journal Entry
      const nextJeNumber = `JE-${year}-${booksData.journalEntries.length + 1}`
      const newJournalEntry: JournalEntry = {
        id: `je-${randomUUID().slice(0, 8)}`,
        entryNumber: nextJeNumber,
        date: today,
        totalDebit: grandTotal,
        totalCredit: grandTotal,
        remarks: `Sales Invoice ${invoiceNumber} for CRM Deal: ${deal.name}`,
        posted: true,
        items: [
          {
            id: `jei-${randomUUID().slice(0, 8)}`,
            accountId: 'acc-ar',
            accountName: 'Accounts Receivable',
            debit: grandTotal,
            credit: 0,
            partyId: party.id,
            partyName: party.name,
          },
          {
            id: `jei-${randomUUID().slice(0, 8)}`,
            accountId: 'acc-sales',
            accountName: 'Tender & Commercial Contracting Sales',
            debit: 0,
            credit: subtotal,
          },
          {
            id: `jei-${randomUUID().slice(0, 8)}`,
            accountId: 'acc-vat',
            accountName: 'SARS VAT Output Payable',
            debit: 0,
            credit: taxTotal,
          },
        ],
      }
      booksData.journalEntries.unshift(newJournalEntry)

      writeBooksStore(booksPath, booksData)

      // Update CRM deal in deals.json with back-reference
      s.saveDeal({
        id: deal.id,
        invoiceId,
        invoiceNumber,
        invoicedAt: new Date().toISOString(),
      })

      // Trigger shell tab activation
      runtime.onOpenBooks?.()

      return {
        ok: true,
        invoiceNumber,
        invoiceId,
      }
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message || 'Failed to create invoice in Books',
      }
    }
  })
}

export function createCrmView(): WebContentsView {
  registerCrmIpc()

  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (runtime.rendererUrl) {
    void view.webContents.loadURL(runtime.rendererUrl)
  } else if (runtime.rendererFile && existsSync(runtime.rendererFile)) {
    void view.webContents.loadFile(runtime.rendererFile)
  }

  return view
}

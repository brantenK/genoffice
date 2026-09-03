import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, ipcMain, WebContentsView } from 'electron'
import { CRM_CHANNELS } from '../shared/ipc'
import type { Activity, Company, Contact, Deal, DealStage } from '../shared/types'
import { CrmStore } from './crm-store'

export interface CrmRuntimeConfig {
  preloadPath: string
  rendererUrl?: string | undefined
  rendererFile: string
  openGeneratedPath?: (path: string) => boolean
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

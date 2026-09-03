import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, ipcMain, WebContentsView } from 'electron'
import { TENDERS_CHANNELS } from '../shared/ipc'

export interface TendersRuntimeConfig {
  preloadPath: string
  rendererUrl?: string | undefined
  rendererFile: string
  openGeneratedPath?: (path: string) => boolean
  onOpenCrm?: (dealId?: string) => void
}

let runtime: TendersRuntimeConfig = {
  preloadPath: '',
  rendererFile: '',
}

let ipcRegistered = false

function getStoragePath(): string {
  const dir = join(app.getPath('userData'), 'tenders')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, 'tenders-data.json')
}

export function configureTendersRuntime(config: TendersRuntimeConfig): void {
  runtime = { ...runtime, ...config }
}

export function registerTendersIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  // Persistence in userData/tenders/
  ipcMain.handle(TENDERS_CHANNELS.getStoredData, () => {
    try {
      const p = getStoragePath()
      if (existsSync(p)) {
        return readFileSync(p, 'utf8')
      }
      return null
    } catch {
      return null
    }
  })

  ipcMain.handle(TENDERS_CHANNELS.saveStoredData, (_e, json: string) => {
    try {
      const p = getStoragePath()
      writeFileSync(p, json, 'utf8')
      return true
    } catch {
      return false
    }
  })

  // Cross-App: Export Compliance Matrix to Sheets
  ipcMain.handle(
    TENDERS_CHANNELS.exportMatrixToSheets,
    (_e, _tenderId: string, tenderTitle: string, matrixRows: any[]) => {
      try {
        const header = 'Item,Category,Requirement / Clause,Risk Level,Status,Linked Vault Document,Compliance Reason\n'
        const rows = (matrixRows || [])
          .map((r, idx) => {
            const item = idx + 1
            const cat = `"${(r.category || '').replace(/"/g, '""')}"`
            const title = `"${(r.title || r.verbatimClause || '').replace(/"/g, '""')}"`
            const risk = `"${(r.riskLevel || '').replace(/"/g, '""')}"`
            const status = `"${(r.status || '').replace(/"/g, '""')}"`
            const doc = `"${(r.linkedVaultDocId || 'None').replace(/"/g, '""')}"`
            const reason = `"${(r.reason || '').replace(/"/g, '""')}"`
            return `${item},${cat},${title},${risk},${status},${doc},${reason}`
          })
          .join('\n')

        const csvContent = header + rows
        const targetPath = join(
          tmpdir(),
          `Tender_Matrix_${(tenderTitle || 'Export').replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`,
        )
        writeFileSync(targetPath, csvContent, 'utf8')

        if (runtime.openGeneratedPath) {
          runtime.openGeneratedPath(targetPath)
        }
        return { ok: true, path: targetPath }
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Failed to export compliance matrix to Sheets' }
      }
    },
  )

  // Cross-App: Draft Proposal in Docs
  ipcMain.handle(TENDERS_CHANNELS.draftProposalDoc, (_e, tender: any) => {
    try {
      const title = tender?.title || 'Tender Response'
      const ref = tender?.referenceNumber || 'RFP-BID-2026'
      const issuer = tender?.issuingBody || 'Procurement Authority'
      const closing = tender?.closingDate || 'TBD'
      const requirements = (tender?.requirements || []) as any[]

      const fulfilled = requirements.filter((r) => r.status === 'FULFILLED')
      const actionReq = requirements.filter((r) => r.status === 'ACTION_REQUIRED')

      const content = `# Bid & Tender Submission: ${title}

**Tender Reference:** ${ref}  
**Issuing Authority:** ${issuer}  
**Submission Deadline:** ${closing}  
**Date Generated:** ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}  

---

## 1. Compliance Statement & Executive Transmittal
We hereby formally submit our comprehensive proposal and compliance pack in response to **${title}** (${ref}). Our organization confirms that all mandatory criteria, technical functional prerequisites, and returnables specified by **${issuer}** have been verified.

## 2. Compliance Returnables Verification Summary

- **Total Evaluated Criteria:** ${requirements.length}
- **Fully Fulfilled Returnables:** ${fulfilled.length}
- **Pending Action Items:** ${actionReq.length}
- **Readiness Gate Status:** ${actionReq.length === 0 ? 'READY FOR FINAL SUBMISSION' : 'PRE-FLIGHT CHECKS IN PROGRESS'}

### Evaluated Matrix
| # | Requirement | Stage | Status | Verification Detail |
| :--- | :--- | :--- | :--- | :--- |
${requirements
  .slice(0, 15)
  .map(
    (r, i) =>
      `| ${i + 1} | ${r.title || 'Requirement'} | ${r.category?.replace(/_/g, ' ') || 'General'} | **${r.status}** | ${r.reason || 'Verified against vault'} |`,
  )
  .join('\n')}

---

## 3. Commercial & Technical Offer
- **Proposed Engagement Scope:** Complete delivery per RFP specifications.
- **Validity Period:** 90 calendar days from closing date.
- **Accompanying Attachments:** Company Document Pack, Tax Compliance Status PIN, BBBEE Affidavit, Certified Director IDs.

---

*Compiled via Zanostack Tenders & Bids Hub*
`

      const targetPath = join(tmpdir(), `Bid_Response_${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`)
      writeFileSync(targetPath, content, 'utf8')

      if (runtime.openGeneratedPath) {
        runtime.openGeneratedPath(targetPath)
      }
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to draft proposal in Docs' }
    }
  })

  // Cross-App: Sync with CRM
  ipcMain.handle(TENDERS_CHANNELS.syncWithCrm, (_e, dealData) => {
    try {
      const crmDir = join(app.getPath('userData'), 'crm')
      if (!existsSync(crmDir)) {
        mkdirSync(crmDir, { recursive: true })
      }
      const crmDealsPath = join(crmDir, 'deals.json')
      let deals: any[] = []
      if (existsSync(crmDealsPath)) {
        try {
          const raw = readFileSync(crmDealsPath, 'utf8')
          const parsed = JSON.parse(raw)
          deals = Array.isArray(parsed) ? parsed : []
        } catch {
          deals = []
        }
      }
      const newDeal = {
        id: `deal-tender-${Date.now()}`,
        name: dealData.name || 'Tender Opportunity',
        amount: Number(dealData.amount) || 150000,
        stage: 'proposal',
        probability: 60,
        companyName: dealData.companyName || 'Procurement Buyer',
        notes: dealData.notes || 'Imported from Zanostack Tenders',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      deals.unshift(newDeal)
      writeFileSync(crmDealsPath, JSON.stringify(deals, null, 2), 'utf8')
      return { ok: true, dealId: newDeal.id }
    } catch (e: any) {
      return { ok: false, error: e?.message }
    }
  })

  ipcMain.handle(TENDERS_CHANNELS.openInCrm, (_e, dealId) => {
    if (runtime.onOpenCrm) {
      runtime.onOpenCrm(dealId)
      return { ok: true }
    }
    return { ok: false }
  })
}

export function createTendersView(): WebContentsView {
  registerTendersIpc()

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

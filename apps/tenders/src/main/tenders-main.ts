import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, ipcMain, WebContentsView } from 'electron'
import { TENDERS_CHANNELS, type BillMilestoneRequest, type BillMilestoneResult } from '../shared/ipc'
import type { ContractMilestone, TenderRecord, TendersData } from '../shared/types'
import { readBooksStore, writeBooksStore } from '../../../books/src/main/books-main'
import type { Invoice, JournalEntry, Party } from '../../../books/src/shared/types'

export const CURRENT_TENDERS_SCHEMA_VERSION = 1

export const SEED_TENDER_WTR_04: TenderRecord = {
  id: 'tender-wtr-04',
  title: 'Bulk Water Metering & Valve Refurbishment',
  referenceNumber: 'RFP-WTR-2026-04',
  issuingBody: 'City of Ekurhuleni Water Dept',
  closingDate: '2026-10-31',
  submissionMethod: 'PHYSICAL',
  submissionAddress: 'Civic Centre, Kempton Park, Ekurhuleni',
  signatureChecks: {},
  status: 'IN_PROGRESS',
  createdAt: '2026-08-01T08:00:00Z',
  fileName: 'RFP-WTR-2026-04.pdf',
  fileUrl: '',
  numPages: 24,
  ocrPages: 0,
  estimatedValue: 243000,
  milestones: [
    {
      id: 'ms-01',
      name: 'Phase 1 Reservoir Valve Refurbishment',
      title: 'Phase 1 Reservoir Valve Refurbishment',
      description: 'Complete overhaul of high-pressure control valves per tender specification',
      amount: 145000,
      status: 'REACHED',
      dueDate: '2026-08-30',
      completedDate: '2026-08-28',
    },
    {
      id: 'ms-02',
      name: 'Phase 2 Ultrasonic Flow Meter Installation',
      title: 'Phase 2 Ultrasonic Flow Meter Installation',
      description: 'Install and calibrate digital flow sensors across metering points',
      amount: 98000,
      status: 'PENDING',
      dueDate: '2026-11-15',
    },
  ],
  requirements: [],
}

export function migrateAndValidateTenders(raw: unknown): TendersData {
  const now = new Date().toISOString()
  if (!raw || typeof raw !== 'object') {
    return {
      version: CURRENT_TENDERS_SCHEMA_VERSION,
      updatedAt: now,
      activeCompanyId: 'comp-zano-01',
      workspaces: [
        {
          id: 'ws-ekurhuleni-01',
          name: 'Ekurhuleni Water Infrastructure',
          company: {
            name: 'Zano Consulting (Pty) Ltd',
            tradingName: 'Zano Consulting',
            registrationNumber: '2018/123456/07',
            vatNumber: '4920284719',
            taxPin: '9876543210',
            bbbeeLevel: 'Level 1',
            bbbeeBlackOwnership: '100%',
            csdSupplierNumber: 'MAAA0012345',
            founded: '2018',
            employees: '45',
            industry: 'Engineering & Construction',
            description: 'Civil and mechanical engineering contracting services',
            address: '24 Sovereign Square, Sandton, 2196',
            phone: '+27 11 982 4000',
            email: 'info@zanostack.dev',
            website: 'https://zanostack.dev',
            directors: [],
            projects: [],
          },
          customers: [],
          vault: [],
          tenders: [SEED_TENDER_WTR_04],
        },
      ],
      issuerTemplates: [],
    }
  }

  const r = raw as Record<string, unknown>
  const version = typeof r.version === 'number' && r.version >= 1 ? r.version : CURRENT_TENDERS_SCHEMA_VERSION
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt.trim() ? r.updatedAt : now
  const workspaces = Array.isArray(r.workspaces) ? (r.workspaces as any[]) : []
  const activeCompanyId = typeof r.activeCompanyId === 'string' && r.activeCompanyId.trim()
    ? r.activeCompanyId
    : (workspaces[0]?.id || '')
  const issuerTemplates = Array.isArray(r.issuerTemplates) ? (r.issuerTemplates as any[]) : []

  return {
    version,
    updatedAt,
    activeCompanyId,
    workspaces,
    issuerTemplates,
  }
}

export function readTendersStore(baseDirOrPath: string): TendersData {
  const filePath = baseDirOrPath.endsWith('tenders-data.json') ? baseDirOrPath : join(baseDirOrPath, 'tenders-data.json')
  if (!existsSync(filePath)) {
    return migrateAndValidateTenders(null)
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (err) {
    console.error('tenders-main: failed to read tenders-data.json:', err)
    return {
      version: CURRENT_TENDERS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      activeCompanyId: '',
      workspaces: [],
      issuerTemplates: [],
    }
  }

  try {
    const parsed = JSON.parse(content)
    return migrateAndValidateTenders(parsed)
  } catch (parseErr) {
    const backupPath = `${filePath}.corrupted.bak`
    try {
      writeFileSync(backupPath, content, 'utf8')
      console.warn(`tenders-main: Corrupted tenders file detected. Backed up to ${backupPath}`)
    } catch (bakErr) {
      console.error('tenders-main: Failed to write corrupted backup file', bakErr)
    }
    return {
      version: CURRENT_TENDERS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      activeCompanyId: '',
      workspaces: [],
      issuerTemplates: [],
    }
  }
}

export function writeTendersStore(baseDirOrPath: string, data: unknown): void {
  const filePath = baseDirOrPath.endsWith('tenders-data.json') ? baseDirOrPath : join(baseDirOrPath, 'tenders-data.json')
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const validated = migrateAndValidateTenders(data)
  const tmp = `${filePath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf8')
    renameSync(tmp, filePath)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    console.error('tenders-main: failed to atomically write tenders store', filePath, e)
    throw e
  }
}

export interface TendersRuntimeConfig {
  preloadPath: string
  rendererUrl?: string | undefined
  rendererFile: string
  openGeneratedPath?: (path: string) => boolean
  onOpenCrm?: (dealId?: string) => void
  onOpenBooks?: (invoiceId?: string) => void
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
        const validated = readTendersStore(p)
        return JSON.stringify(validated)
      }
      return null
    } catch {
      return null
    }
  })

  ipcMain.handle(TENDERS_CHANNELS.saveStoredData, (_e, json: string) => {
    try {
      const p = getStoragePath()
      const parsed = typeof json === 'string' ? JSON.parse(json) : json
      writeTendersStore(p, parsed)
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
      let envelope: { version: number; updatedAt: string; deals: any[] } = {
        version: 1,
        updatedAt: new Date().toISOString(),
        deals: [],
      }

      if (existsSync(crmDealsPath)) {
        try {
          const raw = readFileSync(crmDealsPath, 'utf8')
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            envelope.deals = parsed
          } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.deals)) {
            envelope = {
              version: typeof parsed.version === 'number' && parsed.version >= 1 ? parsed.version : 1,
              updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
              deals: parsed.deals,
            }
          }
        } catch (readErr) {
          try {
            const raw = readFileSync(crmDealsPath, 'utf8')
            writeFileSync(`${crmDealsPath}.corrupted.bak`, raw, 'utf8')
          } catch {}
          envelope.deals = []
        }
      }

      const targetId = dealData?.id || dealData?.dealId || dealData?.crmDealId || `deal-tender-${Date.now()}`
      const existingIdx = envelope.deals.findIndex((d: any) => d && d.id === targetId)
      const now = new Date().toISOString()
      let resultDealId = targetId

      if (existingIdx >= 0) {
        const existing = envelope.deals[existingIdx]
        const updated = {
          ...existing,
          name: dealData?.name || existing.name || 'Tender Opportunity',
          amount: typeof dealData?.amount === 'number' && Number.isFinite(dealData.amount)
            ? dealData.amount
            : (Number(dealData?.amount) >= 0 ? Number(dealData.amount) : (existing.amount ?? 150000)),
          stage: dealData?.stage || existing.stage || 'proposal',
          probability: typeof dealData?.probability === 'number' ? dealData.probability : (existing.probability ?? 60),
          companyName: dealData?.companyName || existing.companyName || 'Procurement Buyer',
          notes: dealData?.notes !== undefined ? dealData.notes : existing.notes,
          updatedAt: now,
        }
        envelope.deals[existingIdx] = updated
        resultDealId = existing.id
      } else {
        const newDeal = {
          id: targetId,
          name: dealData?.name || 'Tender Opportunity',
          amount: Number(dealData?.amount) >= 0 ? Number(dealData.amount) : 150000,
          stage: dealData?.stage || 'proposal',
          probability: typeof dealData?.probability === 'number' ? dealData.probability : 60,
          companyName: dealData?.companyName || 'Procurement Buyer',
          notes: dealData?.notes || 'Imported from Zanostack Tenders',
          createdAt: now,
          updatedAt: now,
        }
        envelope.deals.unshift(newDeal)
        resultDealId = newDeal.id
      }

      envelope.updatedAt = now
      const tmp = `${crmDealsPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
      writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf8')
      renameSync(tmp, crmDealsPath)

      return { ok: true, dealId: resultDealId }
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

  // Cross-App: Open Books tab
  ipcMain.handle(TENDERS_CHANNELS.openBooks, () => {
    if (runtime.onOpenBooks) {
      runtime.onOpenBooks()
      return true
    }
    return false
  })

  // Cross-App: Bill Milestone in Zano Books
  ipcMain.handle(
    TENDERS_CHANNELS.billMilestoneInBooks,
    async (
      _e,
      tenderIdOrPayload: string | BillMilestoneRequest,
      milestoneIdArg?: string,
    ): Promise<BillMilestoneResult> => {
      try {
        let tenderId: string
        let milestoneId: string
        let tenderReference: string | undefined
        let issuingAuthority: string | undefined
        let milestoneTitle: string | undefined
        let customAmount: number | undefined
        let customNotes: string | undefined

        if (typeof tenderIdOrPayload === 'object' && tenderIdOrPayload !== null) {
          tenderId = tenderIdOrPayload.tenderId
          milestoneId = tenderIdOrPayload.milestoneId
          tenderReference = tenderIdOrPayload.tenderReference
          issuingAuthority = tenderIdOrPayload.issuingAuthority
          milestoneTitle = tenderIdOrPayload.milestoneTitle
          customAmount = tenderIdOrPayload.amount
          customNotes = tenderIdOrPayload.notes
        } else {
          tenderId = String(tenderIdOrPayload || '')
          milestoneId = String(milestoneIdArg || '')
        }

        const tendersPath = getStoragePath()
        const tendersData = readTendersStore(tendersPath)

        let foundTender: TenderRecord | null = null
        let foundMilestone: ContractMilestone | null = null

        for (const ws of tendersData.workspaces) {
          for (const t of ws.tenders || []) {
            if (t.id === tenderId || (tenderReference && t.referenceNumber === tenderReference)) {
              foundTender = t
              if (Array.isArray(t.milestones)) {
                foundMilestone = t.milestones.find((m) => m.id === milestoneId) || null
              }
              break
            }
          }
          if (foundTender) break
        }

        if (!foundTender) {
          return { ok: false, error: `Tender not found: ${tenderId || tenderReference || 'unknown'}` }
        }

        if (!foundMilestone) {
          return { ok: false, error: `Milestone not found: ${milestoneId}` }
        }

        if (foundMilestone.status === 'BILLED' || foundMilestone.billedInvoiceId) {
          return {
            ok: false,
            error: `Milestone already billed: ${foundMilestone.billedInvoiceNumber || foundMilestone.billedInvoiceId || 'already billed'}`,
          }
        }

        if (foundMilestone.status !== 'REACHED') {
          return {
            ok: false,
            error: `Milestone is not reached. Current status: ${foundMilestone.status} (Milestone is not in REACHED status)`,
          }
        }

        const billAmount = Number(customAmount ?? foundMilestone.amount ?? 0)
        if (billAmount <= 0) {
          return { ok: false, error: `Milestone billing amount must be greater than 0: ${billAmount}` }
        }

        const booksDir = join(app.getPath('userData'), 'books')
        const booksPath = join(booksDir, 'books-data.json')
        const booksData = readBooksStore(booksPath)

        const issuer = issuingAuthority || foundTender.issuingBody || 'Municipal Water Authority'
        let party = booksData.parties.find(
          (p) => p.name.toLowerCase() === issuer.toLowerCase(),
        )

        if (!party) {
          party = {
            id: `party-${randomUUID().slice(0, 8)}`,
            name: issuer,
            type: 'Customer',
            email: `procurement@${issuer.toLowerCase().replace(/[^a-z0-9]/g, '') || 'gov'}.gov.za`,
            outstandingBalance: 0,
          }
          booksData.parties.push(party)
        }

        const year = new Date().getFullYear()
        const count = booksData.invoices.length
        const invoiceNumber = `INV-${year}-${String(count + 1).padStart(3, '0')}`
        const invoiceId = `inv-${randomUUID().slice(0, 8)}`

        const grandTotal = Math.round(billAmount * 100) / 100
        const subtotal = Math.round((grandTotal / 1.15) * 100) / 100
        const taxTotal = Math.round((grandTotal - subtotal) * 100) / 100
        const today = new Date().toISOString().split('T')[0]
        const dueDate = foundMilestone.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
        const ref = tenderReference || foundTender.referenceNumber || 'RFP-WTR-2026-04'
        const mName = milestoneTitle || foundMilestone.name || foundMilestone.title || 'Delivery Milestone'
        const itemDescription = `${mName} per ${ref}`

        const newTaxInvoice: Invoice = {
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
              itemCode: 'TENDER-PROGRESS',
              description: itemDescription,
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
          tenderReference: ref,
          notes: customNotes || 'Payment terms: 30 days net from tax invoice submission.',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }

        booksData.invoices.unshift(newTaxInvoice)
        party.outstandingBalance = Math.round((party.outstandingBalance + grandTotal) * 100) / 100

        // Double-entry ledger accounts adjustment
        for (const acc of booksData.accounts) {
          if (acc.id === 'acc-ar') acc.balance = Math.round((acc.balance + grandTotal) * 100) / 100
          if (acc.id === 'acc-sales') acc.balance = Math.round((acc.balance + subtotal) * 100) / 100
          if (acc.id === 'acc-vat') acc.balance = Math.round((acc.balance + taxTotal) * 100) / 100
        }

        // Balanced Journal Entry
        booksData.journalEntries.unshift({
          id: `je-${randomUUID().slice(0, 8)}`,
          entryNumber: `JE-${year}-${booksData.journalEntries.length + 1}`,
          date: today,
          totalDebit: grandTotal,
          totalCredit: grandTotal,
          remarks: `Milestone Tax Invoice ${invoiceNumber} for Tender ${ref}`,
          posted: true,
          items: [
            {
              id: `jei-1`,
              accountId: 'acc-ar',
              accountName: 'Accounts Receivable',
              debit: grandTotal,
              credit: 0,
              partyId: party.id,
              partyName: party.name,
            },
            {
              id: `jei-2`,
              accountId: 'acc-sales',
              accountName: 'Tender & Commercial Contracting Sales',
              debit: 0,
              credit: subtotal,
            },
            {
              id: `jei-3`,
              accountId: 'acc-vat',
              accountName: 'SARS VAT Output Payable',
              debit: 0,
              credit: taxTotal,
            },
          ],
        })

        writeBooksStore(booksPath, booksData)

        // Update milestone in tenders data store
        const nowIso = new Date().toISOString()
        foundMilestone.status = 'BILLED'
        foundMilestone.billedInvoiceId = invoiceId
        foundMilestone.billedInvoiceNumber = invoiceNumber
        foundMilestone.billedAt = nowIso
        foundMilestone.billedDate = nowIso
        tendersData.updatedAt = nowIso
        writeTendersStore(tendersPath, tendersData)

        // Shell tab activation trigger callback
        runtime.onOpenBooks?.(invoiceId)

        return {
          ok: true,
          invoiceNumber,
          invoiceId,
          tenderReference: ref,
          grandTotal,
          subtotal,
          taxTotal,
        }
      } catch (err: any) {
        return {
          ok: false,
          error: err?.message || 'Failed to bill milestone in Books',
        }
      }
    },
  )
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

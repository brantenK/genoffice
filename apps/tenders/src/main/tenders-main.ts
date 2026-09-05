import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, ipcMain, shell, WebContentsView, type WebContents } from 'electron'
import {
  TENDERS_CHANNELS,
  type BillMilestoneRequest,
  type BillMilestoneResult,
  type DeleteDocumentRequest,
  type DeleteDocumentResponse,
  type OpenDocumentRequest,
  type OpenDocumentResponse,
  type ReadDocumentRequest,
  type ReadDocumentResponse,
  type SaveDocumentRequest,
  type SaveDocumentResponse,
} from '../shared/ipc'
import type { CompanyWorkspace, ContractMilestone, TenderRecord, TendersData } from '../shared/types'
import { readBooksStore, writeBooksStore } from '../../../books/src/main/books-main'
import type { Invoice, JournalEntry, Party } from '../../../books/src/shared/types'
import { MOCK_COMPANY } from '../renderer/src/mock/company'
import { MOCK_CUSTOMERS } from '../renderer/src/mock/customers'
import { MOCK_VAULT } from '../renderer/src/mock/vault'

export const CURRENT_TENDERS_SCHEMA_VERSION = 1
export const SEED_COMPANY_ID = 'co-thabo'

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

export function createDefaultSeedWorkspaces(): CompanyWorkspace[] {
  return [
    {
      id: SEED_COMPANY_ID,
      name: 'Thabo Engineering (Pty) Ltd',
      company: { ...MOCK_COMPANY },
      customers: [...MOCK_CUSTOMERS],
      vault: [...MOCK_VAULT],
      tenders: [SEED_TENDER_WTR_04],
    },
  ]
}

export function migrateAndValidateTenders(raw: unknown): TendersData {
  const now = new Date().toISOString()
  if (!raw || typeof raw !== 'object') {
    return {
      version: CURRENT_TENDERS_SCHEMA_VERSION,
      updatedAt: now,
      activeCompanyId: SEED_COMPANY_ID,
      workspaces: createDefaultSeedWorkspaces(),
      issuerTemplates: [],
    }
  }

  const r = raw as Record<string, unknown>
  const version = typeof r.version === 'number' && r.version >= 1 ? r.version : CURRENT_TENDERS_SCHEMA_VERSION
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt.trim() ? r.updatedAt : now
  let workspaces = Array.isArray(r.workspaces) ? (r.workspaces as any[]) : []
  if (workspaces.length === 0) {
    workspaces = createDefaultSeedWorkspaces()
  } else {
    workspaces = workspaces.map((ws) => {
      const isSeedCompany = ws.id === SEED_COMPANY_ID || ws.id === 'ws-ekurhuleni-01'
      const company = ws.company && ws.company.name ? ws.company : { ...MOCK_COMPANY }
      const customers = Array.isArray(ws.customers) && ws.customers.length > 0
        ? ws.customers
        : (isSeedCompany ? [...MOCK_CUSTOMERS] : (Array.isArray(ws.customers) ? ws.customers : []))
      const vault = Array.isArray(ws.vault) && ws.vault.length > 0
        ? ws.vault
        : (isSeedCompany ? [...MOCK_VAULT] : (Array.isArray(ws.vault) ? ws.vault : []))
      const tenders = Array.isArray(ws.tenders) && ws.tenders.length > 0
        ? ws.tenders
        : (isSeedCompany ? [SEED_TENDER_WTR_04] : (Array.isArray(ws.tenders) ? ws.tenders : []))
      return {
        ...ws,
        id: ws.id === 'ws-ekurhuleni-01' ? SEED_COMPANY_ID : ws.id,
        name: ws.name || company.tradingName || company.name,
        company,
        customers,
        vault,
        tenders,
      }
    })
  }
  const activeCompanyId = typeof r.activeCompanyId === 'string' && r.activeCompanyId.trim() && r.activeCompanyId !== 'comp-zano-01'
    ? (r.activeCompanyId === 'ws-ekurhuleni-01' ? SEED_COMPANY_ID : r.activeCompanyId)
    : (workspaces[0]?.id || SEED_COMPANY_ID)
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

const activeTendersWebContents = new Set<WebContents>()
let fileWatcher: FSWatcher | null = null
let lastBroadcastJson = ''
let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null

export function registerTendersWebContents(wc: WebContents): void {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
  activeTendersWebContents.add(wc)
  if (typeof wc.once === 'function') {
    wc.once('destroyed', () => {
      activeTendersWebContents.delete(wc)
    })
  }
}

export function unregisterTendersWebContents(wc: WebContents): void {
  activeTendersWebContents.delete(wc)
}

export function getActiveTendersWebContents(): WebContents[] {
  return Array.from(activeTendersWebContents).filter(
    (wc) => typeof wc.isDestroyed !== 'function' || !wc.isDestroyed()
  )
}

export function broadcastTendersData(data: TendersData): void {
  const json = JSON.stringify(data)
  lastBroadcastJson = json
  for (const wc of activeTendersWebContents) {
    if (typeof wc.isDestroyed !== 'function' || !wc.isDestroyed()) {
      try {
        wc.send(TENDERS_CHANNELS.dataChanged, data)
      } catch (err) {
        console.warn('tenders-main: failed to broadcast dataChanged to WebContents:', err)
      }
    }
  }
}

let watchedFilePath = ''

export function startTendersStoreWatcher(targetPath?: string): void {
  const filePath = targetPath || getStoragePath()
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (fileWatcher) {
    if (watchedFilePath === filePath) {
      return
    }
    stopTendersStoreWatcher()
  }

  watchedFilePath = filePath
  try {
    fileWatcher = watch(dir, (_eventType, filename) => {
      if (filename && filename.includes('tenders-data.json') && !filename.endsWith('.tmp')) {
        if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
        watchDebounceTimer = setTimeout(() => {
          try {
            if (existsSync(filePath)) {
              const currentData = readTendersStore(filePath)
              const currentJson = JSON.stringify(currentData)
              if (currentJson !== lastBroadcastJson) {
                lastBroadcastJson = currentJson
                broadcastTendersData(currentData)
              }
            }
          } catch (err) {
            console.warn('tenders-main: error in file watcher handler:', err)
          }
        }, 100)
      }
    })
  } catch (err) {
    console.warn('tenders-main: could not start tenders-data.json watcher:', err)
  }
}

export function stopTendersStoreWatcher(): void {
  watchedFilePath = ''
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer)
    watchDebounceTimer = null
  }
  if (fileWatcher) {
    try {
      fileWatcher.close()
    } catch {}
    fileWatcher = null
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
    broadcastTendersData(validated)
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

export function getTendersBaseDir(overrideUserData?: string): string {
  const dir = join(overrideUserData || app.getPath('userData'), 'tenders')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getTendersDocumentsDir(overrideUserData?: string): string {
  const dir = join(getTendersBaseDir(overrideUserData), 'documents')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getTendersVaultDir(overrideUserData?: string): string {
  const dir = join(getTendersBaseDir(overrideUserData), 'vault')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function resolveSafeTendersPath(
  storedPath: string,
  overrideUserData?: string
): { safe: boolean; fullPath: string; error?: string } {
  if (!storedPath || typeof storedPath !== 'string') {
    return { safe: false, fullPath: '', error: 'Stored path is required' }
  }
  if (storedPath.includes('\0')) {
    return { safe: false, fullPath: '', error: 'Null byte detected in path' }
  }
  const root = resolve(getTendersBaseDir(overrideUserData))
  const resolved = resolve(root, storedPath)
  const docsDir = resolve(getTendersDocumentsDir(overrideUserData))
  const docsDirWithSep = docsDir.endsWith(sep) ? docsDir : docsDir + sep
  const vaultDir = resolve(getTendersVaultDir(overrideUserData))
  const vaultDirWithSep = vaultDir.endsWith(sep) ? vaultDir : vaultDir + sep

  // Must strictly be inside either documents/ or vault/ subdirectories
  const isInsideDocs = resolved.startsWith(docsDirWithSep) && resolved !== docsDir
  const isInsideVault = resolved.startsWith(vaultDirWithSep) && resolved !== vaultDir

  if (!isInsideDocs && !isInsideVault) {
    return { safe: false, fullPath: '', error: 'Directory traversal detected' }
  }
  return { safe: true, fullPath: resolved }
}

export function atomicWriteDocumentFile(targetPath: string, buffer: Buffer): void {
  const dir = targetPath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmp = `${targetPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, buffer)
    let renamed = false
    let lastErr: any = null
    for (let i = 0; i < 3; i++) {
      try {
        renameSync(tmp, targetPath)
        renamed = true
        break
      } catch (err: any) {
        lastErr = err
        if (err?.code === 'EBUSY' || err?.code === 'EPERM') {
          const start = Date.now()
          while (Date.now() - start < 15) {}
        } else {
          throw err
        }
      }
    }
    if (!renamed && lastErr) {
      throw lastErr
    }
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    throw err
  }
}

let lastSaveTimestamp = 0
export function getUniqueTimestamp(): number {
  const now = Date.now()
  lastSaveTimestamp = now > lastSaveTimestamp ? now : lastSaveTimestamp + 1
  return lastSaveTimestamp
}

export async function saveDocumentFile(
  req: SaveDocumentRequest,
  overrideUserData?: string
): Promise<SaveDocumentResponse> {
  try {
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'Invalid request payload' }
    }
    const { fileName, buffer, category } = req
    if (!fileName || typeof fileName !== 'string') {
      return { ok: false, error: 'File name is required' }
    }
    if (!buffer) {
      return { ok: false, error: 'File buffer is required' }
    }
    if (category !== 'rfp' && category !== 'vault') {
      return { ok: false, error: 'Category must be either "rfp" or "vault"' }
    }

    // Sanitize fileName to prevent directory traversal and remove problematic characters
    const rawBase = basename(fileName)
    let cleanName = rawBase.replace(/[^a-zA-Z0-9._-]/g, '_')
    if (!cleanName || cleanName.replace(/[._-]/g, '').length === 0) {
      cleanName = category === 'rfp' ? 'tender.pdf' : 'document.pdf'
    }

    const timestamp = getUniqueTimestamp()
    const storedFileName = `${timestamp}_${cleanName}`
    const subFolder = category === 'rfp' ? 'documents' : 'vault'
    const targetDir = category === 'rfp'
      ? getTendersDocumentsDir(overrideUserData)
      : getTendersVaultDir(overrideUserData)
    const targetPath = join(targetDir, storedFileName)

    const fileBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as any)
    atomicWriteDocumentFile(targetPath, fileBuf)

    const storedPath = `${subFolder}/${storedFileName}`
    return { ok: true, storedPath }
  } catch (err: any) {
    console.error('tenders-main: failed to save document file', err)
    return { ok: false, error: err?.message || 'Failed to save document' }
  }
}

export async function readDocumentFile(
  req: ReadDocumentRequest,
  overrideUserData?: string
): Promise<ReadDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || !req.storedPath) {
      return { ok: false, error: 'Stored path is required' }
    }
    const check = resolveSafeTendersPath(req.storedPath, overrideUserData)
    if (!check.safe) {
      return { ok: false, error: check.error || 'Invalid or unsafe path' }
    }
    if (!existsSync(check.fullPath)) {
      return { ok: false, error: 'File not found on disk' }
    }
    const buf = readFileSync(check.fullPath)
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, buffer: arrayBuffer }
  } catch (err: any) {
    console.error('tenders-main: failed to read document file', err)
    return { ok: false, error: err?.message || 'Failed to read document' }
  }
}

export async function openDocumentFile(
  req: OpenDocumentRequest,
  overrideUserData?: string
): Promise<OpenDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || !req.storedPath) {
      return { ok: false, error: 'Stored path is required' }
    }
    const check = resolveSafeTendersPath(req.storedPath, overrideUserData)
    if (!check.safe) {
      return { ok: false, error: check.error || 'Invalid or unsafe path' }
    }
    if (!existsSync(check.fullPath)) {
      return { ok: false, error: 'File not found on disk' }
    }
    const openErr = await shell.openPath(check.fullPath)
    if (openErr) {
      return { ok: false, error: openErr }
    }
    return { ok: true }
  } catch (err: any) {
    console.error('tenders-main: failed to open document file', err)
    return { ok: false, error: err?.message || 'Failed to open document' }
  }
}

export async function deleteDocumentFile(
  req: DeleteDocumentRequest,
  overrideUserData?: string
): Promise<DeleteDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || !req.storedPath) {
      return { ok: false, error: 'Stored path is required' }
    }
    const check = resolveSafeTendersPath(req.storedPath, overrideUserData)
    if (!check.safe) {
      return { ok: false, error: check.error || 'Invalid or unsafe path' }
    }
    if (existsSync(check.fullPath)) {
      unlinkSync(check.fullPath)
    }
    return { ok: true }
  } catch (err: any) {
    console.error('tenders-main: failed to delete document file', err)
    return { ok: false, error: err?.message || 'Failed to delete document' }
  }
}

function getStoragePath(): string {
  return join(getTendersBaseDir(), 'tenders-data.json')
}

export function configureTendersRuntime(config: TendersRuntimeConfig): void {
  runtime = { ...runtime, ...config }
}

export function registerTendersIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  startTendersStoreWatcher()

  // Persistence in userData/tenders/
  ipcMain.handle(TENDERS_CHANNELS.getStoredData, (_e) => {
    try {
      if (_e?.sender) {
        registerTendersWebContents(_e.sender)
      }
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
      if (_e?.sender) {
        registerTendersWebContents(_e.sender)
      }
      const p = getStoragePath()
      const parsed = typeof json === 'string' ? JSON.parse(json) : json
      writeTendersStore(p, parsed)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save stored data' }
    }
  })

  // Persistent Document & Vault Disk Storage (R2)
  ipcMain.handle(TENDERS_CHANNELS.saveDocument, async (_e, req: SaveDocumentRequest) => {
    return saveDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.readDocument, async (_e, req: ReadDocumentRequest) => {
    return readDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.openDocument, async (_e, req: OpenDocumentRequest) => {
    return openDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.deleteDocument, async (_e, req: DeleteDocumentRequest) => {
    return deleteDocumentFile(req)
  })

  // Cross-App: Export Compliance Matrix to Sheets
  ipcMain.handle(
    TENDERS_CHANNELS.exportMatrixToSheets,
    (_e, _tenderId: string, tenderTitle: string, matrixRows: any[]) => {
      try {
        const BOM = '\uFEFF'
        const header = 'Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes\n'
        const escapeCsv = (str: unknown): string => {
          if (str === null || str === undefined) return '""'
          const s = String(str).replace(/"/g, '""')
          return `"${s}"`
        }

        const rows = (matrixRows || [])
          .map((r, idx) => {
            const reqId = escapeCsv(r.id || `REQ-${idx + 1}`)
            const cat = escapeCsv((r.category || 'GENERAL').replace(/_/g, ' '))
            const reqText = escapeCsv(r.title || r.verbatimClause || r.requirementText || '')
            const isMand = r.isMandatory !== undefined ? Boolean(r.isMandatory) : (r.mandatory !== undefined ? Boolean(r.mandatory) : (r.riskLevel === 'HIGH' || r.riskLevel === 'CRITICAL'))
            const mandText = escapeCsv(isMand ? 'Mandatory / Disqualifier' : 'Standard Returnable')
            const status = escapeCsv(r.status || 'UNDER_REVIEW')
            const linkedDoc = escapeCsv(r.linkedVaultDocId || r.linkedDocument || 'None')
            const health = escapeCsv(r.healthStatus || (r.linkedVaultDocId ? 'VALID' : 'NO_ATTACHMENT'))
            const notes = escapeCsv(r.notes || r.reason || '')
            return [reqId, cat, reqText, mandText, status, linkedDoc, health, notes].join(',')
          })
          .join('\n')

        const csvContent = BOM + header + rows
        const sanitizedTitle = (tenderTitle || 'Tender').replace(/[^a-zA-Z0-9_-]/g, '_')
        const targetPath = join(
          tmpdir(),
          `${sanitizedTitle}_Compliance_Matrix_${getUniqueTimestamp()}.csv`,
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
      const title = tender?.title || 'Tender Proposal'
      const ref = tender?.referenceNumber || 'RFP-BID-2026'
      const issuer = tender?.issuingBody || 'Procurement Authority'
      const closing = tender?.closingDate || 'TBD'
      const estValue = tender?.estimatedValue ? Number(tender.estimatedValue) : 0
      const requirements = (tender?.requirements || []) as any[]
      const milestones = (tender?.milestones || []) as any[]

      const fulfilled = requirements.filter((r) => r.status === 'FULFILLED')
      const actionReq = requirements.filter((r) => r.status === 'ACTION_REQUIRED')
      const underReview = requirements.filter((r) => r.status === 'UNDER_REVIEW')

      const dateStr = new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' })

      const content = `# Commercial & Technical Tender Proposal

**Project Title:** ${title}  
**Tender Reference:** ${ref}  
**Issuing Authority:** ${issuer}  
**Closing Date:** ${closing}  
**Submission Date:** ${dateStr}  
**Total Bid Valuation:** R ${estValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (incl. 15% VAT)

---

## 1. Executive Summary

This tender proposal is formally submitted by our organization in response to **${title}** (${ref}) issued by **${issuer}**. Having rigorously examined the scope of work, technical specifications, and general conditions of contract, we hereby commit to execute and complete all specified deliverables with uncompromising fidelity, technical precision, and full compliance with South African regulatory standards.

Our engineering and contracting division possesses the requisite operational capability, accredited technical personnel, robust supply chain partnerships, and sound financial liquidity to fulfill all terms specified in the contract documents. All preliminary returnables, mandatory disqualification criteria, and compliance documentation have been verified and assembled in our attached compliance pack.

---

## 2. Delivery Methodology & Implementation Plan

Our operational deployment follows a structured, milestone-driven project delivery lifecycle engineered to eliminate delivery risks and ensure seamless stakeholder communication:

1. **Phase 1: Project Mobilization & Technical Baseline Survey**
   - Immediate deployment of lead project managers and safety officers.
   - Comprehensive site inspection, verification of existing infrastructure parameters, and finalization of detailed execution drawings.
   - Procurement lock-in with certified primary suppliers and submission of Occupational Health & Safety (OHS) baseline files.

2. **Phase 2: Core Engineering, Overhaul & Procurement Execution**
   - Execution of primary civil, mechanical, and instrumentation works strictly conforming to SABS and ISO 9001 standards.
   - Rigorous staged quality control inspections with structured sign-off hold-points for client consulting engineers.
   - Continuous environmental and safety compliance monitoring with zero-harm safety enforcement.

3. **Phase 3: Integration, Commissioning, Calibration & Handover**
   - Systematic testing, flow calibration, pressure testing, and multi-point telemetry verification.
   - Comprehensive operator training, handover of operations manuals, and issuance of certificates of compliance (CoC).
   - Structured defect liability period monitoring and post-commissioning technical support.

---

## 3. Pricing Schedule & Contract Milestones

The proposed commercial structure is organized into progressive delivery milestones payable upon formal engineering certification and tax invoicing through Zano Books:

| Phase | Milestone Description | Target Due Date | Valuation (excl. VAT) | VAT (15%) | Total Progress Amount (ZAR) |
| :--- | :--- | :--- | :--- | :--- | :--- |
${milestones.length > 0
  ? milestones.map((m, idx) => {
      const gross = Number(m.amount || 0)
      const net = Math.round((gross / 1.15) * 100) / 100
      const vat = Math.round((gross - net) * 100) / 100
      return `| Phase ${idx + 1} | ${m.name || m.title || 'Contract Milestone'} | ${m.dueDate || 'TBD'} | R ${net.toLocaleString(undefined, { minimumFractionDigits: 2 })} | R ${vat.toLocaleString(undefined, { minimumFractionDigits: 2 })} | R ${gross.toLocaleString(undefined, { minimumFractionDigits: 2 })} |`
    }).join('\n')
  : `| 01 | Phase 1 Initial Mobilization & Procurement | ${closing} | R ${Math.round((estValue * 0.4 / 1.15) * 100) / 100} | R ${Math.round((estValue * 0.4 - estValue * 0.4 / 1.15) * 100) / 100} | R ${(estValue * 0.4).toLocaleString()} |\n| 02 | Phase 2 Site Execution & Core Overhaul | TBD | R ${Math.round((estValue * 0.4 / 1.15) * 100) / 100} | R ${Math.round((estValue * 0.4 - estValue * 0.4 / 1.15) * 100) / 100} | R ${(estValue * 0.4).toLocaleString()} |\n| 03 | Phase 3 Commissioning & Final Handover | TBD | R ${Math.round((estValue * 0.2 / 1.15) * 100) / 100} | R ${Math.round((estValue * 0.2 - estValue * 0.2 / 1.15) * 100) / 100} | R ${(estValue * 0.2).toLocaleString()} |`
}
| **TOTAL** | **Comprehensive Turnkey Contract Sum** | | **R ${Math.round((estValue / 1.15) * 100) / 100}** | **R ${Math.round((estValue - Math.round((estValue / 1.15) * 100) / 100) * 100) / 100}** | **R ${estValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}** |

*Payment Terms: 30 days from invoice certification. Double-entry ledger settlement via Zano Books.*

---

## 4. Compliance Checklist & Returnables Matrix

The pre-submission compliance audit confirms the readiness of all mandatory criteria, legal standing certificates, and technical prerequisites:

- **Total Evaluated Criteria:** ${requirements.length}
- **Fully Fulfilled Returnables:** ${fulfilled.length}
- **Under Review / Action Required:** ${actionReq.length + underReview.length}
- **Audit Gate Status:** ${actionReq.length === 0 ? 'CLEARED FOR SUBMISSION' : 'CONDITIONAL PRE-FLIGHT'}

| Item | Requirement / Returnable | Mandatory / Disqualifier | Fulfillment Status | Linked Returnable | Health Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
${requirements.map((r, i) => {
  const mand = r.isMandatory !== false ? 'Mandatory' : 'Optional'
  const link = r.linkedVaultDocId ? `\`${r.linkedVaultDocId}\`` : 'Direct Attachment'
  const health = r.healthStatus || (r.linkedVaultDocId ? 'VALID' : 'NO_DOC')
  return `| ${i + 1} | ${r.title || r.verbatimClause || 'Requirement'} | ${mand} | **${r.status || 'UNDER_REVIEW'}** | ${link} | ${health} |`
}).join('\n')}

---

*Compiled and verified via Zanostack Tenders & Bids Hub · Zano Enterprise Office Suite*
`

      const sanitizedTitle = (title || 'Tender').replace(/[^a-zA-Z0-9_-]/g, '_')
      const targetPath = join(tmpdir(), `${sanitizedTitle}_Draft_Proposal_${getUniqueTimestamp()}.md`)
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
      const userDataDir = (app?.getPath ? app.getPath('userData') : '') || dealData?.userDataDir || ''
      const crmDir = dealData?.crmDealsPath ? dirname(dealData.crmDealsPath) : join(userDataDir, 'crm')
      if (!existsSync(crmDir)) {
        mkdirSync(crmDir, { recursive: true })
      }
      const crmDealsPath = dealData?.crmDealsPath || join(crmDir, 'deals.json')
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

      // Resolve Tender from disk if needed
      const tendersPath = dealData?.tendersPath || getStoragePath()
      let tenderFromStore: TenderRecord | undefined
      let tendersDataEnvelope: TendersData | undefined
      if (existsSync(tendersPath)) {
        try {
          tendersDataEnvelope = readTendersStore(tendersPath)
          for (const ws of tendersDataEnvelope.workspaces || []) {
            for (const t of ws.tenders || []) {
              if (
                (dealData?.tenderId && t.id === dealData.tenderId) ||
                (dealData?.id && (t.id === dealData.id || `deal-tender-${t.id}` === dealData.id)) ||
                (dealData?.tenderReference && t.referenceNumber === dealData.tenderReference)
              ) {
                tenderFromStore = t
                break
              }
            }
          }
        } catch {}
      }

      const tender = dealData?.tender || tenderFromStore
      const tenderId = dealData?.tenderId || tender?.id || (dealData?.id?.startsWith('deal-tender-') ? dealData.id.replace('deal-tender-', '') : dealData?.id)
      const deterministicDealId = dealData?.dealId || (dealData?.id && dealData.id !== tenderId ? dealData.id : (tenderId ? `deal-tender-${tenderId}` : `deal-tender-${Date.now()}`))
      const targetId = deterministicDealId

      const refNum = tender?.referenceNumber || dealData?.tenderReference || dealData?.referenceNumber || ''
      const rawTitle = tender?.title || dealData?.title || dealData?.name || 'Tender Opportunity'
      const title = refNum && rawTitle.startsWith(`${refNum} - `) ? rawTitle.replace(`${refNum} - `, '') : rawTitle
      const dealName = refNum ? `${refNum} - ${title}` : title
      const companyName = tender?.issuingBody || dealData?.companyName || 'Government / Enterprise Buyer'
      const rawAmount = typeof tender?.estimatedValue === 'number'
        ? tender.estimatedValue
        : (typeof dealData?.amount === 'number' && Number.isFinite(dealData.amount) ? dealData.amount : 0)
      const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0
      const stage = dealData?.stage || 'proposal'
      const expectedCloseDate = tender?.closingDate || dealData?.expectedCloseDate || dealData?.closingDate || undefined
      const notes = dealData?.notes || (refNum ? `Tender Ref: ${refNum}\nIssuing Authority: ${companyName}` : `Issuing Authority: ${companyName}`)

      const now = new Date().toISOString()
      const existingIdx = envelope.deals.findIndex((d: any) => d && (d.id === targetId || (tenderId && d.tenderId === tenderId)))
      let resultDealId = targetId

      const dealFields = {
        id: targetId,
        name: dealName,
        companyName,
        amount,
        stage,
        expectedCloseDate,
        notes,
        tenderReference: refNum || undefined,
        tenderId: tenderId || undefined,
        probability: typeof dealData?.probability === 'number' ? dealData.probability : (stage === 'won' ? 100 : 60),
        updatedAt: now,
      }

      if (existingIdx >= 0) {
        const existing = envelope.deals[existingIdx]
        envelope.deals[existingIdx] = {
          ...existing,
          ...dealFields,
          createdAt: existing.createdAt || now,
        }
        resultDealId = existing.id
      } else {
        const newDeal = {
          ...dealFields,
          createdAt: now,
        }
        envelope.deals.unshift(newDeal)
        resultDealId = newDeal.id
      }

      envelope.updatedAt = now
      const tmp = `${crmDealsPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
      writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf8')
      renameSync(tmp, crmDealsPath)

      // Record tender.linkedCrmDealId = deal.id back onto TenderRecord in tenders-data.json and persist
      if (tendersPath && existsSync(tendersPath)) {
        try {
          const tendersData = tendersDataEnvelope || readTendersStore(tendersPath)
          let tenderUpdated = false
          for (const ws of tendersData.workspaces || []) {
            for (const t of ws.tenders || []) {
              if (t.id === tenderId || (refNum && t.referenceNumber === refNum)) {
                t.linkedCrmDealId = resultDealId
                tenderUpdated = true
              }
            }
          }
          if (tenderUpdated) {
            tendersData.updatedAt = now
            writeTendersStore(tendersPath, tendersData) // automatically broadcasts tenders:data-changed!
          }
        } catch (tenderErr) {
          console.warn('tenders-main: failed to back-link CRM deal on tender:', tenderErr)
        }
      }

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
        if (_e?.sender) {
          registerTendersWebContents(_e.sender)
        }
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

  registerTendersWebContents(view.webContents)

  if (runtime.rendererUrl) {
    void view.webContents.loadURL(runtime.rendererUrl)
  } else if (runtime.rendererFile && existsSync(runtime.rendererFile)) {
    void view.webContents.loadFile(runtime.rendererFile)
  }

  return view
}

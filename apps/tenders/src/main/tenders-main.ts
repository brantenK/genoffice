import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, ipcMain, shell, WebContentsView, type WebContents } from 'electron'
import {
  MAX_TENDERS_DOCUMENT_UPLOAD_BYTES,
  TENDERS_CHANNELS,
  type BillMilestoneRequest,
  type BillMilestoneResult,
  type CleanupDocumentTrashRequest,
  type CleanupDocumentTrashResponse,
  type DeleteDocumentRequest,
  type DeleteDocumentResponse,
  type ListDocumentTrashResponse,
  type ListRecoveryCandidatesResponse,
  type OpenDocumentRequest,
  type OpenDocumentResponse,
  type ReadDocumentRequest,
  type ReadDocumentResponse,
  type ReconcileDocumentsResponse,
  type ReplaceDocumentRequest,
  type ReplaceDocumentResponse,
  type RestoreDocumentRequest,
  type RestoreDocumentResponse,
  type RestoreRecoveryCandidateRequest,
  type RestoreRecoveryCandidateResponse,
  type SaveDocumentRequest,
  type SaveDocumentResponse,
} from '../shared/ipc'
import type {
  CompanyWorkspace,
  ContractMilestone,
  TenderRecord,
  TendersData,
  TendersDataV2,
} from '../shared/types'
import {
  MAX_TENDERS_DOCUMENT_BYTES,
  MAX_TENDERS_IPC_PAYLOAD_BYTES,
} from '../shared/tenders-persistence'
import type {
  ManagedFileLink,
  SaveTendersRequest,
  TendersPersistenceError,
} from '../shared/tenders-persistence'
import {
  expectedReadinessBinding,
  generateProposalMarkdown,
  type ProposalInput,
} from './proposal-generator'
import { createTendersStore, type TendersStore } from './tenders-store'
import {
  createManagedDocumentStore,
  findManagedFileLinks,
  toManagedRelativePath,
  type ManagedDocumentStore,
} from './document-store'
import { buildCanonicalReadinessReport } from './readiness-binding'
import { milestonesAllowed } from '../shared/lifecycle'
import {
  resolveTendersIntegrations,
  setInjectedTendersIntegrations,
  type TendersIntegrations,
} from './integrations'
import type { ReadinessBinding, ReadinessReport } from '../shared/readiness'
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
  const version =
    typeof r.version === 'number' && r.version >= 1 ? r.version : CURRENT_TENDERS_SCHEMA_VERSION
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt.trim() ? r.updatedAt : now
  let workspaces = Array.isArray(r.workspaces) ? (r.workspaces as any[]) : []
  if (workspaces.length === 0) {
    workspaces = createDefaultSeedWorkspaces()
  } else {
    workspaces = workspaces.map((ws) => {
      const isSeedCompany = ws.id === SEED_COMPANY_ID || ws.id === 'ws-ekurhuleni-01'
      const company = ws.company && ws.company.name ? ws.company : { ...MOCK_COMPANY }
      const customers =
        Array.isArray(ws.customers) && ws.customers.length > 0
          ? ws.customers
          : isSeedCompany
            ? [...MOCK_CUSTOMERS]
            : Array.isArray(ws.customers)
              ? ws.customers
              : []
      const vault =
        Array.isArray(ws.vault) && ws.vault.length > 0
          ? ws.vault
          : isSeedCompany
            ? [...MOCK_VAULT]
            : Array.isArray(ws.vault)
              ? ws.vault
              : []
      const tenders =
        Array.isArray(ws.tenders) && ws.tenders.length > 0
          ? ws.tenders
          : isSeedCompany
            ? [SEED_TENDER_WTR_04]
            : Array.isArray(ws.tenders)
              ? ws.tenders
              : []
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
  const activeCompanyId =
    typeof r.activeCompanyId === 'string' &&
    r.activeCompanyId.trim() &&
    r.activeCompanyId !== 'comp-zano-01'
      ? r.activeCompanyId === 'ws-ekurhuleni-01'
        ? SEED_COMPANY_ID
        : r.activeCompanyId
      : workspaces[0]?.id || SEED_COMPANY_ID
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
  const filePath = baseDirOrPath.endsWith('tenders-data.json')
    ? baseDirOrPath
    : join(baseDirOrPath, 'tenders-data.json')
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
const authoritativeTendersStores = new Map<string, TendersStore>()
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
    (wc) => typeof wc.isDestroyed !== 'function' || !wc.isDestroyed(),
  )
}

function trustedRendererUrl(url: string): boolean {
  try {
    if (runtime.rendererUrl && new URL(url).origin === new URL(runtime.rendererUrl).origin)
      return true
    if (runtime.rendererFile) {
      const expected = runtime.rendererFile.startsWith('file:')
        ? runtime.rendererFile
        : pathToFileURL(resolve(runtime.rendererFile)).href
      return new URL(url).href === new URL(expected).href
    }
  } catch {}
  return false
}

function isTrustedTendersEvent(
  event: { sender?: unknown; senderFrame?: { url?: string; parent?: unknown } | null } | undefined,
): boolean {
  const sender = event?.sender
  if (!getActiveTendersWebContents().some((wc) => wc === sender)) return false
  if (event?.senderFrame?.parent !== undefined && event.senderFrame.parent !== null) return false
  // Fail closed when the trusted renderer origin was never configured: with no
  // expected origin there is no way to prove the sender is the real renderer.
  if (!runtime.rendererUrl && !runtime.rendererFile) return false
  const url =
    event?.senderFrame?.url ||
    (sender && typeof (sender as { getURL?: () => string }).getURL === 'function'
      ? (sender as { getURL: () => string }).getURL()
      : '')
  return typeof url === 'string' && trustedRendererUrl(url)
}

function isTrustedTendersWebContents(wc: WebContents): boolean {
  if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false
  // Fail closed for an unconfigured origin, and for any object that cannot
  // report its URL (a real Electron WebContents always can).
  if (!runtime.rendererUrl && !runtime.rendererFile) return false
  if (typeof (wc as unknown as { getURL?: () => string }).getURL !== 'function') return false
  const url = (wc as unknown as { getURL: () => string }).getURL()
  return trustedRendererUrl(url)
}

function unauthorizedTendersRequest(): { ok: false; error: TendersPersistenceError } {
  return {
    ok: false,
    error: { code: 'INVALID_REQUEST', message: 'Sender is not a registered Tenders WebContents.' },
  }
}

/**
 * The authoritative store for the app-owned Tenders directory. There is NO
 * path override: the store location is always resolved in main from
 * `app.getPath('userData')`, so a renderer-supplied path can never reopen the
 * renderer-path hole (all callers pass no argument).
 */
function getAuthoritativeTendersStore(): TendersStore {
  const directory = resolve(getTendersBaseDir())
  const existing = authoritativeTendersStores.get(directory)
  if (existing) return existing
  const store = createTendersStore({
    directory,
    onCommitted: async (document: TendersDataV2) => {
      const failures: string[] = []
      for (const wc of getActiveTendersWebContents()) {
        if (!isTrustedTendersWebContents(wc)) continue
        try {
          wc.send(TENDERS_CHANNELS.storeChangedV2, structuredClone(document))
        } catch (error: unknown) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      if (failures.length > 0) throw new Error(failures.join('; '))
    },
  })
  authoritativeTendersStores.set(directory, store)
  return store
}

const managedDocumentStores = new Map<string, ManagedDocumentStore>()

/** Managed-document metadata store for the active Tenders base directory. */
function getManagedDocumentStore(overrideUserData?: string): ManagedDocumentStore {
  const directory = resolve(getTendersBaseDir(overrideUserData))
  const existing = managedDocumentStores.get(directory)
  if (existing) return existing
  const store = createManagedDocumentStore({ baseDir: directory })
  managedDocumentStores.set(directory, store)
  return store
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validOptionalString(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.length <= maxLength)
  )
}

const PROPOSAL_TOP_LEVEL_KEYS = new Set([
  'id',
  'title',
  'referenceNumber',
  'issuingBody',
  'closingDate',
  'estimatedValue',
  'pricingConfirmed',
  'requirements',
  'milestones',
  'signatureChecks',
  // Legacy renderer fields are accepted only to preserve caller compatibility; they are ignored.
  'readinessReport',
  'ready',
  'healthStatus',
])
const PROPOSAL_REQUIREMENT_KEYS = new Set([
  'id',
  'title',
  'verbatimClause',
  'isMandatory',
  'status',
  'linkedVaultDocId',
  'healthStatus',
  'ruleKey',
  'reason',
  'notApplicableReason',
  'notes',
])
const PROPOSAL_MILESTONE_KEYS = new Set(['id', 'name', 'title', 'amount', 'dueDate'])
const PROPOSAL_STATUSES = new Set(['FULFILLED', 'ACTION_REQUIRED', 'OUTSTANDING', 'NOT_APPLICABLE'])
const PROPOSAL_HEALTH_STATES = new Set([
  'VALID',
  'EXPIRED',
  'STALE_CERTIFICATION',
  'NO_EXPIRY_INFO',
  'UNKNOWN',
  'INVALID_DATE',
])

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function aggregateStringChars(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length
  if (!value || typeof value !== 'object') return 0
  if (seen.has(value)) return Number.POSITIVE_INFINITY
  seen.add(value)
  let total = 0
  if (Array.isArray(value)) {
    for (const item of value) total += aggregateStringChars(item, seen)
  } else {
    for (const child of Object.values(value)) total += aggregateStringChars(child, seen)
  }
  return total
}

function validProposalPayload(value: unknown): value is ProposalInput {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, PROPOSAL_TOP_LEVEL_KEYS)) return false
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) return false
  } catch {
    return false
  }
  if (aggregateStringChars(value) > 64 * 1024) return false
  if (
    !validOptionalString(value.title, 500) ||
    !validOptionalString(value.referenceNumber, 500) ||
    !validOptionalString(value.issuingBody, 500) ||
    !validOptionalString(value.closingDate, 120)
  )
    return false
  if (
    value.estimatedValue !== undefined &&
    (typeof value.estimatedValue !== 'number' ||
      !Number.isFinite(value.estimatedValue) ||
      value.estimatedValue < 0)
  )
    return false
  if (value.pricingConfirmed !== undefined && typeof value.pricingConfirmed !== 'boolean')
    return false
  if (value.id !== undefined && !validOptionalString(value.id, 200)) return false
  if (value.ready !== undefined && typeof value.ready !== 'boolean') return false
  if (!validOptionalString(value.healthStatus, 64)) return false
  if (value.readinessReport !== undefined && !isRecord(value.readinessReport)) return false

  if (value.requirements !== undefined) {
    if (!Array.isArray(value.requirements) || value.requirements.length > 500) return false
    for (const raw of value.requirements) {
      if (!isRecord(raw)) return false
      if (!hasOnlyKeys(raw, PROPOSAL_REQUIREMENT_KEYS)) return false
      const hasTitle =
        typeof raw.title === 'string' && raw.title.trim().length > 0 && raw.title.length <= 500
      const hasClause =
        typeof raw.verbatimClause === 'string' &&
        raw.verbatimClause.trim().length > 0 &&
        raw.verbatimClause.length <= 2000
      if (!hasTitle && !hasClause) return false
      if (
        !validOptionalString(raw.id, 200) ||
        !validOptionalString(raw.status, 64) ||
        !validOptionalString(raw.linkedVaultDocId, 500) ||
        !validOptionalString(raw.healthStatus, 64) ||
        !validOptionalString(raw.ruleKey, 100) ||
        !validOptionalString(raw.reason, 2000) ||
        !validOptionalString(raw.notApplicableReason, 2000) ||
        !validOptionalString(raw.notes, 2000)
      )
        return false
      if (raw.isMandatory !== undefined && typeof raw.isMandatory !== 'boolean') return false
      if (
        raw.status !== undefined &&
        (typeof raw.status !== 'string' || !PROPOSAL_STATUSES.has(raw.status))
      )
        return false
      if (
        raw.healthStatus !== undefined &&
        (typeof raw.healthStatus !== 'string' || !PROPOSAL_HEALTH_STATES.has(raw.healthStatus))
      )
        return false
    }
  }

  if (value.milestones !== undefined) {
    if (!Array.isArray(value.milestones) || value.milestones.length > 500) return false
    for (const raw of value.milestones) {
      if (!isRecord(raw)) return false
      if (!hasOnlyKeys(raw, PROPOSAL_MILESTONE_KEYS)) return false
      const hasName =
        typeof raw.name === 'string' && raw.name.trim().length > 0 && raw.name.length <= 500
      const hasTitle =
        typeof raw.title === 'string' && raw.title.trim().length > 0 && raw.title.length <= 500
      if (!hasName && !hasTitle) return false
      if (
        raw.amount !== undefined &&
        (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0)
      )
        return false
      if (!validOptionalString(raw.dueDate, 120)) return false
    }
  }

  if (value.signatureChecks !== undefined) {
    if (!isRecord(value.signatureChecks) || Object.keys(value.signatureChecks).length > 50)
      return false
    if (Object.keys(value.signatureChecks).some((key) => key.length > 100)) return false
    if (Object.values(value.signatureChecks).some((checked) => typeof checked !== 'boolean'))
      return false
  }
  return true
}

function writeGeneratedProposal(content: string): string {
  const outputDir = join(getTendersBaseDir(), 'generated')
  mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const outputPath = join(outputDir, `${randomUUID()}.md`)
  writeFileSync(outputPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return outputPath
}

export function broadcastTendersData(data: TendersData): void {
  const json = JSON.stringify(data)
  if (Buffer.byteLength(json, 'utf8') > MAX_TENDERS_DOCUMENT_BYTES) return
  lastBroadcastJson = json
  for (const wc of activeTendersWebContents) {
    if (isTrustedTendersWebContents(wc)) {
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
  const filePath = baseDirOrPath.endsWith('tenders-data.json')
    ? baseDirOrPath
    : join(baseDirOrPath, 'tenders-data.json')
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
  /**
   * Composition-root injected cross-app ports (CRM/Books). Omit to use the
   * built-in adapters; pass `{}` to run with integrations disabled.
   */
  integrations?: TendersIntegrations
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
  overrideUserData?: string,
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
          while (Date.now() - start < 15) {
            /* retry delay */
          }
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
  overrideUserData?: string,
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
    const fileBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as any)
    // Bounded upload: reject before any filesystem work or sanitisation so an
    // oversized document cannot stream across IPC or be written.
    if (fileBuf.byteLength > MAX_TENDERS_DOCUMENT_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `Document exceeds the ${MAX_TENDERS_DOCUMENT_UPLOAD_BYTES}-byte upload limit.`,
      }
    }

    // Route through the managed-document store so every saved file gets durable
    // metadata (id/size/MIME/hash/timestamps). Filenames stay timestamped.
    const saved = await getManagedDocumentStore(overrideUserData).save({
      fileName,
      buffer: fileBuf,
      category,
    })
    if (!saved.ok) return { ok: false, error: saved.error }
    return {
      ok: true,
      storedPath: saved.record.relativePath,
      id: saved.record.id,
      record: saved.record,
    }
  } catch (err: any) {
    console.error('tenders-main: failed to save document file', err)
    return { ok: false, error: err?.message || 'Failed to save document' }
  }
}

export async function readDocumentFile(
  req: ReadDocumentRequest,
  overrideUserData?: string,
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
    // Bounded read: never stream an oversized file back across IPC.
    if (statSync(check.fullPath).size > MAX_TENDERS_DOCUMENT_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `Document exceeds the ${MAX_TENDERS_DOCUMENT_UPLOAD_BYTES}-byte read limit.`,
      }
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
  overrideUserData?: string,
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

/**
 * Soft-delete a managed document: the file is MOVED to the Tenders trash (never
 * hard-unlinked) and can be restored across a restart. Returns the records that
 * still reference it so the UI can warn/confirm.
 */
export async function deleteDocumentFile(
  req: DeleteDocumentRequest,
  overrideUserData?: string,
): Promise<DeleteDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || !req.storedPath) {
      return { ok: false, error: 'Stored path is required' }
    }
    const relativePath = toManagedRelativePath(req.storedPath)
    if (!relativePath) {
      return { ok: false, error: 'Invalid or unsafe path' }
    }
    const store = getManagedDocumentStore(overrideUserData)
    const trashed = await store.trash(relativePath)

    // Link-aware warnings (best-effort; a lookup failure never blocks the move).
    let links: ManagedFileLink[] = []
    try {
      const loaded = await getAuthoritativeTendersStore().load()
      if (loaded.ok) links = findManagedFileLinks(relativePath, loaded.data)
    } catch {
      // ignore link lookup failures
    }

    if (!trashed.ok) {
      // The file was already gone and untracked: deleting is idempotent.
      const full = join(getTendersBaseDir(overrideUserData), relativePath)
      if (!existsSync(full)) return { ok: true, ...(links.length ? { links } : {}) }
      return { ok: false, error: trashed.error }
    }

    const warnings = links.length
      ? [
          `This file is referenced by ${links.length} record(s); it was moved to trash and can be restored.`,
        ]
      : []
    return {
      ok: true,
      ...(links.length ? { links } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(trashed.entry ? { trashId: trashed.entry.id } : {}),
    }
  } catch (err: any) {
    console.error('tenders-main: failed to delete document file', err)
    return { ok: false, error: err?.message || 'Failed to delete document' }
  }
}

// ── Managed-document lifecycle helpers (Phase 5 WP-9) ────────────────────────

export async function listDocumentTrashFile(
  overrideUserData?: string,
): Promise<ListDocumentTrashResponse> {
  try {
    return { ok: true, entries: await getManagedDocumentStore(overrideUserData).listTrash() }
  } catch (err: any) {
    console.error('tenders-main: failed to list document trash', err)
    return { ok: false, error: err?.message || 'Failed to list document trash' }
  }
}

export async function restoreDocumentFile(
  req: RestoreDocumentRequest,
  overrideUserData?: string,
): Promise<RestoreDocumentResponse> {
  try {
    if (!req || typeof req !== 'object' || typeof req.id !== 'string' || req.id.length === 0) {
      return { ok: false, error: 'Trash entry id is required' }
    }
    const result = await getManagedDocumentStore(overrideUserData).restore(req.id)
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, record: result.record, storedPath: result.restoredPath }
  } catch (err: any) {
    console.error('tenders-main: failed to restore document', err)
    return { ok: false, error: err?.message || 'Failed to restore document' }
  }
}

export async function replaceDocumentFile(
  req: ReplaceDocumentRequest,
  overrideUserData?: string,
): Promise<ReplaceDocumentResponse> {
  try {
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.storedPath !== 'string' ||
      typeof req.fileName !== 'string'
    ) {
      return { ok: false, error: 'storedPath and fileName are required' }
    }
    if (!req.buffer) return { ok: false, error: 'File buffer is required' }
    const buffer = Buffer.isBuffer(req.buffer) ? req.buffer : Buffer.from(req.buffer as any)
    if (buffer.byteLength > MAX_TENDERS_DOCUMENT_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `Document exceeds the ${MAX_TENDERS_DOCUMENT_UPLOAD_BYTES}-byte upload limit.`,
      }
    }
    const result = await getManagedDocumentStore(overrideUserData).replace({
      storedPath: req.storedPath,
      fileName: req.fileName,
      buffer,
    })
    if (!result.ok) return { ok: false, error: result.error }
    return {
      ok: true,
      record: result.record,
      storedPath: result.record.relativePath,
      previousTrashed: result.previousTrashed,
      ...(result.warning ? { warning: result.warning } : {}),
    }
  } catch (err: any) {
    console.error('tenders-main: failed to replace document', err)
    return { ok: false, error: err?.message || 'Failed to replace document' }
  }
}

export async function reconcileDocumentFiles(
  overrideUserData?: string,
): Promise<ReconcileDocumentsResponse> {
  try {
    return { ok: true, reconciliation: await getManagedDocumentStore(overrideUserData).reconcile() }
  } catch (err: any) {
    console.error('tenders-main: failed to reconcile documents', err)
    return { ok: false, error: err?.message || 'Failed to reconcile documents' }
  }
}

export async function cleanupDocumentTrash(
  req: CleanupDocumentTrashRequest,
  overrideUserData?: string,
): Promise<CleanupDocumentTrashResponse> {
  try {
    if (req !== undefined && (typeof req !== 'object' || req === null)) {
      return { ok: false, error: 'Invalid cleanup request' }
    }
    if (
      req?.olderThanMs !== undefined &&
      (typeof req.olderThanMs !== 'number' || req.olderThanMs < 0)
    ) {
      return { ok: false, error: 'olderThanMs must be a non-negative number' }
    }
    const result = await getManagedDocumentStore(overrideUserData).cleanupTrash({
      all: req?.all === true,
      ...(typeof req?.olderThanMs === 'number' ? { olderThanMs: req.olderThanMs } : {}),
    })
    return { ok: true, removed: result.removed }
  } catch (err: any) {
    console.error('tenders-main: failed to clean up document trash', err)
    return { ok: false, error: err?.message || 'Failed to clean up document trash' }
  }
}

// ── Recovery helpers (Phase 5 WP-2 remainder) ────────────────────────────────

export async function listRecoveryCandidatesFile(): Promise<ListRecoveryCandidatesResponse> {
  try {
    const candidates = await getAuthoritativeTendersStore().listRecoveryCandidates()
    return { ok: true, candidates }
  } catch (err: any) {
    console.error('tenders-main: failed to list recovery candidates', err)
    return { ok: false, error: err?.message || 'Failed to list recovery candidates' }
  }
}

export async function restoreRecoveryCandidateFile(
  req: RestoreRecoveryCandidateRequest,
): Promise<RestoreRecoveryCandidateResponse> {
  try {
    if (!req || typeof req !== 'object' || typeof req.id !== 'string' || req.id.length === 0) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Candidate id is required.' } }
    }
    const result = await getAuthoritativeTendersStore().restoreRecoveryCandidate(req.id)
    if (!result.ok) {
      return { ok: false, error: { code: result.error.code, message: result.error.message } }
    }
    return { ok: true, data: result.data }
  } catch (err: any) {
    console.error('tenders-main: failed to restore recovery candidate', err)
    return {
      ok: false,
      error: { code: 'WRITE_FAILED', message: err?.message || 'Failed to restore candidate' },
    }
  }
}

function getStoragePath(): string {
  return join(getTendersBaseDir(), 'tenders-data.json')
}

export function configureTendersRuntime(config: TendersRuntimeConfig): void {
  if ('integrations' in config) setInjectedTendersIntegrations(config.integrations)
  runtime = { ...runtime, ...config }
}

/** Effective cross-app ports (injected by the shell, else built-in adapters). */
function getIntegrations(): TendersIntegrations {
  return resolveTendersIntegrations({ userDataDir: app.getPath('userData') })
}

/** Open the owning app at a returned entity (CRM deal / Books invoice). */
function openOwningApp(target: { app: 'crm' | 'books'; entityId?: string }): void {
  const integrations = getIntegrations()
  if (integrations.openAppAt) {
    integrations.openAppAt(target)
    return
  }
  // Legacy runtime callbacks remain supported for callers that have not
  // migrated to the typed `openAppAt` port.
  if (target.app === 'crm') runtime.onOpenCrm?.(target.entityId)
  else runtime.onOpenBooks?.(target.entityId)
}

/** Resolve a tender from the authoritative document (never from renderer paths). */
function findTenderById(
  document: TendersDataV2,
  tenderId: string,
): { workspace: TendersDataV2['workspaces'][number]; tender: TenderRecord } | null {
  for (const workspace of document.workspaces) {
    const tender = workspace.tenders.find((candidate) => candidate.id === tenderId)
    if (tender) return { workspace, tender }
  }
  return null
}

/** Main-side demo isolation: cross-app writes are refused for demo data. */
export const TENDERS_DEMO_WRITE_ERROR =
  'Demo workspace: CRM sync and Books billing are disabled for demonstration data.'

/** Main-side won-only gate for milestone billing (mirrors `milestonesAllowed`). */
export const tendersNotWonBillingError = (status: string): string =>
  `Milestone billing is only allowed for a won tender. Current status: ${status}.`

export function resetTendersIpcForTests(): void {
  for (const channel of Object.values(TENDERS_CHANNELS)) ipcMain.removeHandler(channel)
  stopTendersStoreWatcher()
  activeTendersWebContents.clear()
  authoritativeTendersStores.clear()
  managedDocumentStores.clear()
  const baseDirectory = getTendersBaseDir()
  try {
    rmSync(join(baseDirectory, 'documents'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(join(baseDirectory, 'vault'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(join(baseDirectory, '.trash'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(join(baseDirectory, 'backups'), { recursive: true, force: true })
  } catch {}
  try {
    rmSync(join(baseDirectory, 'managed-documents.json'), { force: true })
  } catch {}
  ipcRegistered = false
}

export function isTendersIpcRegisteredForTests(): boolean {
  return ipcRegistered
}

export function registerTendersIpc(): void {
  if (ipcRegistered) return

  startTendersStoreWatcher()

  // Best-effort startup reconciliation of managed documents (Phase 5 WP-9):
  // persist missing/orphaned state now; the renderer shows the full report via
  // `tenders:reconcile-documents`. A failure never blocks startup.
  void getManagedDocumentStore()
    .reconcile()
    .catch(() => {})

  ipcMain.handle(TENDERS_CHANNELS.loadStoreV2, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return getAuthoritativeTendersStore().load()
  })

  ipcMain.handle(TENDERS_CHANNELS.saveStoreV2, async (_e, request: SaveTendersRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const payloadBytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
      if (payloadBytes > MAX_TENDERS_IPC_PAYLOAD_BYTES) {
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: `IPC payload exceeds ${MAX_TENDERS_IPC_PAYLOAD_BYTES} bytes.`,
          },
        }
      }
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: error instanceof Error ? error.message : 'IPC payload cannot be serialized.',
        },
      }
    }
    const result = await getAuthoritativeTendersStore().save(request)
    if (result.ok) return result
    // Compact conflict payload: never ship the full authoritative document over
    // IPC. The renderer only needs the error and the current revision; it
    // reveals its conflict UI from `code`, and reloads via `loadStoreV2`.
    return {
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.schemaIssues ? { schemaIssues: result.error.schemaIssues } : {}),
      },
      currentRevision: result.current?.revision ?? result.error.current?.revision,
    }
  })

  // Persistence in userData/tenders/
  ipcMain.handle(TENDERS_CHANNELS.getStoredData, (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
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
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const p = getStoragePath()
      if (existsSync(p)) {
        try {
          const existing = JSON.parse(readFileSync(p, 'utf8'))
          if (
            existing &&
            typeof existing === 'object' &&
            typeof existing.schemaVersion === 'number' &&
            Number.isFinite(existing.schemaVersion) &&
            existing.schemaVersion >= 2
          ) {
            return {
              ok: false,
              error: 'Legacy persistence cannot overwrite an authoritative v2 store.',
            }
          }
        } catch (error: any) {
          return { ok: false, error: error?.message || 'Failed to inspect existing Tenders store' }
        }
      }
      const parsed = typeof json === 'string' ? JSON.parse(json) : json
      writeTendersStore(p, parsed)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save stored data' }
    }
  })

  // Persistent Document & Vault Disk Storage (R2)
  ipcMain.handle(TENDERS_CHANNELS.saveDocument, async (_e, req: SaveDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return saveDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.readDocument, async (_e, req: ReadDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return readDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.openDocument, async (_e, req: OpenDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return openDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.deleteDocument, async (_e, req: DeleteDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return deleteDocumentFile(req)
  })

  // Managed-document lifecycle (Phase 5 WP-9). Every handler is behind the same
  // trusted-sender gate and validates its request shape before touching disk.
  ipcMain.handle(TENDERS_CHANNELS.listDocumentTrash, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return listDocumentTrashFile()
  })

  ipcMain.handle(TENDERS_CHANNELS.restoreDocument, async (_e, req: RestoreDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.id !== 'string' ||
      req.id.length === 0 ||
      req.id.length > 512
    ) {
      return { ok: false, error: 'A valid trash entry id is required' }
    }
    return restoreDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.replaceDocument, async (_e, req: ReplaceDocumentRequest) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (
      !req ||
      typeof req !== 'object' ||
      typeof req.storedPath !== 'string' ||
      typeof req.fileName !== 'string' ||
      req.fileName.length > 512
    ) {
      return { ok: false, error: 'storedPath and fileName are required' }
    }
    return replaceDocumentFile(req)
  })

  ipcMain.handle(TENDERS_CHANNELS.reconcileDocuments, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return reconcileDocumentFiles()
  })

  ipcMain.handle(
    TENDERS_CHANNELS.cleanupDocumentTrash,
    async (_e, req: CleanupDocumentTrashRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      return cleanupDocumentTrash(req)
    },
  )

  // Rotating backups + explicit recovery (Phase 5 WP-2 remainder).
  ipcMain.handle(TENDERS_CHANNELS.listRecoveryCandidates, async (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    return listRecoveryCandidatesFile()
  })

  ipcMain.handle(
    TENDERS_CHANNELS.restoreRecoveryCandidate,
    async (_e, req: RestoreRecoveryCandidateRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      if (
        !req ||
        typeof req !== 'object' ||
        typeof req.id !== 'string' ||
        req.id.length === 0 ||
        req.id.length > 512
      ) {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'A valid candidate id is required.' },
        }
      }
      return restoreRecoveryCandidateFile(req)
    },
  )

  // Cross-App: Export Compliance Matrix to Sheets
  ipcMain.handle(
    TENDERS_CHANNELS.exportMatrixToSheets,
    (_e, _tenderId: string, tenderTitle: string, matrixRows: any[]) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      try {
        const BOM = '\uFEFF'
        const header =
          'Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes\n'
        // RFC 4180 quoting plus spreadsheet formula neutralisation: any cell
        // that begins with = + - @ TAB or CR is prefixed with an apostrophe so
        // a spreadsheet app cannot evaluate it as a formula. The BOM and
        // comma-delimited quoting are unchanged.
        const neutralizeFormula = (value: string): string =>
          /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
        const escapeCsv = (str: unknown): string => {
          if (str === null || str === undefined) return '""'
          const s = neutralizeFormula(String(str)).replace(/"/g, '""')
          return `"${s}"`
        }

        const rows = (matrixRows || [])
          .map((r, idx) => {
            const reqId = escapeCsv(r.id || `REQ-${idx + 1}`)
            const cat = escapeCsv((r.category || 'GENERAL').replace(/_/g, ' '))
            const reqText = escapeCsv(r.title || r.verbatimClause || r.requirementText || '')
            const isMand =
              r.isMandatory !== undefined
                ? Boolean(r.isMandatory)
                : r.mandatory !== undefined
                  ? Boolean(r.mandatory)
                  : r.riskLevel === 'HIGH' || r.riskLevel === 'CRITICAL'
            const mandText = escapeCsv(isMand ? 'Mandatory / Disqualifier' : 'Standard Returnable')
            const status = escapeCsv(r.status || 'UNDER_REVIEW')
            const linkedDoc = escapeCsv(r.linkedVaultDocId || r.linkedDocument || 'None')
            const health = escapeCsv(
              r.healthStatus || (r.linkedVaultDocId ? 'VALID' : 'NO_ATTACHMENT'),
            )
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
  ipcMain.handle(TENDERS_CHANNELS.draftProposalDoc, async (_e, tender: unknown) => {
    if (!isTrustedTendersEvent(_e)) {
      return { ok: false, error: 'Unauthorized Tenders WebContents sender' }
    }
    if (!validProposalPayload(tender)) {
      return { ok: false, error: 'Invalid proposal payload' }
    }
    try {
      // Main owns the canonical readiness snapshot: it resolves the requested
      // tender from the authoritative document (never from renderer-supplied
      // data), assesses company/vault readiness itself, and binds the report to
      // the exact tender id + revision + fingerprint. The generator verifies the
      // binding before it may emit ready language, so a stale or mismatched
      // report cannot clear a proposal.
      const requestedId =
        isRecord(tender) && typeof (tender as { id?: unknown }).id === 'string'
          ? (tender as { id: string }).id
          : ''
      let readinessReport: ReadinessReport | undefined
      let expectedBinding: (Partial<ReadinessBinding> & { required?: boolean }) | undefined
      if (requestedId) {
        const loaded = await getAuthoritativeTendersStore().load()
        if (loaded.ok) {
          const canonical = buildCanonicalReadinessReport(loaded.data, requestedId)
          // Derive the expectation from the requested id + loaded revision, not
          // from the report's own binding (that comparison would be tautological).
          // On any drift the binding is undefined, so the report is also withheld
          // and the generator cannot emit ready language.
          const binding = expectedReadinessBinding({
            requestedTenderId: requestedId,
            loadedRevision: loaded.data.revision,
            canonicalTenderId: canonical.tender?.id ?? '',
            reportBinding: canonical.report?.binding,
          })
          if (canonical.ok && canonical.report && binding) {
            readinessReport = canonical.report
            expectedBinding = binding
          }
        }
      }
      const content = generateProposalMarkdown(tender, { readinessReport, expectedBinding })
      const targetPath = writeGeneratedProposal(content)
      if (runtime.openGeneratedPath) runtime.openGeneratedPath(targetPath)
      return { ok: true, path: targetPath }
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to draft proposal in Docs' }
    }
  })

  // Cross-App: Sync with CRM (typed port; Tenders never touches the CRM store)
  ipcMain.handle(TENDERS_CHANNELS.syncWithCrm, async (_e, dealData: any) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const integrations = getIntegrations()
      const upsertTenderOpportunity = integrations.upsertTenderOpportunity
      // Resolve the port BEFORE any side effect: with CRM disabled there is no
      // partial application at all.
      if (!upsertTenderOpportunity) {
        return { ok: false, error: 'CRM integration is not configured.' }
      }

      const authoritativeStore = getAuthoritativeTendersStore()
      const loaded = await authoritativeStore.load()
      if (!loaded.ok) return { ok: false, error: loaded.error.message }

      const payloadTender: TenderRecord | undefined =
        dealData && typeof dealData.tender === 'object'
          ? (dealData.tender as TenderRecord)
          : undefined
      const tenderId =
        (typeof dealData?.tenderId === 'string' && dealData.tenderId) ||
        payloadTender?.id ||
        (typeof dealData?.id === 'string' && dealData.id.startsWith('deal-tender-')
          ? dealData.id.replace('deal-tender-', '')
          : '') ||
        ''

      const resolved = tenderId ? findTenderById(loaded.data, tenderId) : null
      // Main-side demo isolation: never write to CRM from a demonstration
      // workspace, even if the renderer guard were bypassed. Rejection happens
      // before any mutation, so there is no side effect.
      if (resolved?.workspace.dataOrigin === 'demo') {
        return { ok: false, error: TENDERS_DEMO_WRITE_ERROR }
      }
      // Identity and the back-link come from the canonical document; the deal
      // content prefers the renderer's explicit sync payload (its historical
      // contract), falling back to the canonical tender.
      const tender = payloadTender ?? resolved?.tender
      const effectiveTenderId = resolved?.tender.id ?? tenderId

      const deterministicDealId =
        (typeof dealData?.dealId === 'string' && dealData.dealId) ||
        (typeof dealData?.id === 'string' && dealData.id !== effectiveTenderId
          ? dealData.id
          : effectiveTenderId
            ? `deal-tender-${effectiveTenderId}`
            : `deal-tender-${Date.now()}`)

      const refNum =
        tender?.referenceNumber || dealData?.tenderReference || dealData?.referenceNumber || ''
      const rawTitle = tender?.title || dealData?.title || dealData?.name || 'Tender Opportunity'
      const title =
        refNum && rawTitle.startsWith(`${refNum} - `)
          ? rawTitle.replace(`${refNum} - `, '')
          : rawTitle
      const dealName = refNum ? `${refNum} - ${title}` : title
      const companyName =
        tender?.issuingBody || dealData?.companyName || 'Government / Enterprise Buyer'
      const rawAmount =
        typeof tender?.estimatedValue === 'number'
          ? tender.estimatedValue
          : typeof dealData?.amount === 'number' && Number.isFinite(dealData.amount)
            ? dealData.amount
            : 0
      const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0
      const stage = typeof dealData?.stage === 'string' ? dealData.stage : 'proposal'
      const expectedCloseDate =
        tender?.closingDate || dealData?.expectedCloseDate || dealData?.closingDate || undefined
      const notes =
        dealData?.notes ||
        (refNum
          ? `Tender Ref: ${refNum}\nIssuing Authority: ${companyName}`
          : `Issuing Authority: ${companyName}`)

      // Race fix (contracts §6.2): resolve the tender revision and commit the
      // back-link FIRST. A revision conflict therefore aborts before the CRM
      // write, so a conflict can never leave a deal that the tender does not
      // reference. The CRM upsert is idempotent (deterministic id), so a retry
      // after a later CRM failure reconciles to exactly one deal.
      if (resolved) {
        const expectedRevision =
          typeof dealData?.expectedRevision === 'number'
            ? dealData.expectedRevision
            : loaded.data.revision
        const committed = await authoritativeStore.mutate(expectedRevision, (document) => {
          const target = findTenderById(document, resolved.tender.id)
          if (target) target.tender.linkedCrmDealId = deterministicDealId
          return document
        })
        if (!committed.ok) {
          return {
            ok: false,
            error: committed.error.message,
            currentRevision: committed.current?.revision ?? committed.error.current?.revision,
          }
        }
      }

      let dealId = deterministicDealId
      try {
        const upserted = await upsertTenderOpportunity({
          dealId: deterministicDealId,
          tenderId: effectiveTenderId,
          tenderReference: refNum || null,
          name: dealName,
          companyName,
          amount,
          stage,
          expectedCloseDate,
          notes,
        })
        if (!upserted.ok) return { ok: false, error: upserted.error || 'CRM upsert failed.' }
        dealId = upserted.dealId || dealId
      } catch (crmError: unknown) {
        // The tender link already committed; the deterministic deal id makes a
        // retry safe and idempotent. Surface the error for the retry UI.
        return {
          ok: false,
          dealId: deterministicDealId,
          error: crmError instanceof Error ? crmError.message : String(crmError),
        }
      }

      return { ok: true, dealId }
    } catch (e: any) {
      return { ok: false, error: e?.message }
    }
  })

  // Cross-App: Record tender outcome on the CRM opportunity (typed port)
  ipcMain.handle(TENDERS_CHANNELS.updateTenderOutcome, async (_e, request: any) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    try {
      const tenderId = typeof request?.tenderId === 'string' ? request.tenderId : ''
      const outcome = request?.outcome
      if (!tenderId) return { ok: false, error: 'A tender id is required.' }
      if (
        outcome !== 'won' &&
        outcome !== 'lost' &&
        outcome !== 'withdrawn' &&
        outcome !== 'cancelled'
      ) {
        return { ok: false, error: `Unknown tender outcome: ${String(outcome)}` }
      }
      const updateTenderOutcome = getIntegrations().updateTenderOutcome
      if (!updateTenderOutcome) {
        return { ok: false, error: 'CRM integration is not configured.' }
      }
      const loaded = await getAuthoritativeTendersStore().load()
      if (!loaded.ok) return { ok: false, error: loaded.error.message }
      const resolved = findTenderById(loaded.data, tenderId)
      if (!resolved) return { ok: false, error: `Tender not found: ${tenderId}` }
      const dealId =
        (typeof request?.dealId === 'string' && request.dealId) ||
        resolved.tender.linkedCrmDealId ||
        `deal-tender-${tenderId}`
      const result = await updateTenderOutcome({
        dealId,
        tenderId,
        outcome,
        amount: typeof request?.amount === 'number' ? request.amount : undefined,
        reason: typeof request?.reason === 'string' ? request.reason : undefined,
        noticeDate: typeof request?.noticeDate === 'string' ? request.noticeDate : undefined,
      })
      return result
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to record tender outcome' }
    }
  })

  ipcMain.handle(TENDERS_CHANNELS.openInCrm, (_e, dealId) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    const integrations = getIntegrations()
    if (integrations.openAppAt || runtime.onOpenCrm) {
      openOwningApp({ app: 'crm', entityId: typeof dealId === 'string' ? dealId : undefined })
      return { ok: true }
    }
    return { ok: false }
  })

  // Cross-App: Open Books tab
  ipcMain.handle(TENDERS_CHANNELS.openBooks, (_e) => {
    if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
    if (getIntegrations().openAppAt || runtime.onOpenBooks) {
      openOwningApp({ app: 'books' })
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
    ): Promise<BillMilestoneResult | { ok: false; error: TendersPersistenceError }> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      try {
        let tenderId: string
        let milestoneId: string
        let tenderReference: string | undefined
        let issuingAuthority: string | undefined
        let milestoneTitle: string | undefined
        let customAmount: number | undefined
        let customNotes: string | undefined
        let expectedRevision: number | undefined

        if (typeof tenderIdOrPayload === 'object' && tenderIdOrPayload !== null) {
          tenderId = tenderIdOrPayload.tenderId
          milestoneId = tenderIdOrPayload.milestoneId
          tenderReference = tenderIdOrPayload.tenderReference
          issuingAuthority = tenderIdOrPayload.issuingAuthority
          milestoneTitle = tenderIdOrPayload.milestoneTitle
          customAmount = tenderIdOrPayload.amount
          customNotes = tenderIdOrPayload.notes
          expectedRevision = tenderIdOrPayload.expectedRevision
        } else {
          tenderId = String(tenderIdOrPayload || '')
          milestoneId = String(milestoneIdArg || '')
        }

        const issueMilestoneInvoice = getIntegrations().issueMilestoneInvoice
        if (!issueMilestoneInvoice) {
          return { ok: false, error: 'Books integration is not configured.' }
        }

        const authoritativeStore = getAuthoritativeTendersStore()
        const loadedTenders = await authoritativeStore.load()
        if (!loadedTenders.ok) return { ok: false, error: loadedTenders.error.message }
        const tendersData = loadedTenders.data

        const located =
          (tenderId ? findTenderById(tendersData, tenderId) : null) ??
          (() => {
            if (!tenderReference) return null
            for (const workspace of tendersData.workspaces) {
              const tender = workspace.tenders.find(
                (candidate) => candidate.referenceNumber === tenderReference,
              )
              if (tender) return { workspace, tender }
            }
            return null
          })()

        if (!located) {
          return {
            ok: false,
            error: `Tender not found: ${tenderId || tenderReference || 'unknown'}`,
          }
        }

        const foundTender = located.tender
        // Main-side demo isolation: a demonstration workspace may never raise an
        // invoice. Rejected before any reservation/side effect.
        if (located.workspace.dataOrigin === 'demo') {
          return { ok: false, error: TENDERS_DEMO_WRITE_ERROR }
        }
        const foundMilestone: ContractMilestone | undefined = foundTender.milestones?.find(
          (candidate) => candidate.id === milestoneId,
        )
        if (!foundMilestone) {
          return { ok: false, error: `Milestone not found: ${milestoneId}` }
        }

        const billingIdempotencyKey = `tender-milestone-${foundTender.id}-${foundMilestone.id}`

        // Already billed (e.g. a retry after a lost response): idempotent
        // success. Never post a second invoice. This reconciliation path is
        // exempt from the won gate below so a retry cannot double-post.
        if (foundMilestone.status === 'BILLED' || foundMilestone.billedInvoiceId) {
          return {
            ok: true,
            reconciled: true,
            invoiceId: foundMilestone.billedInvoiceId,
            invoiceNumber: foundMilestone.billedInvoiceNumber,
          }
        }

        // Won-only gating (mirrors shared/lifecycle `milestonesAllowed`): a
        // tender that is not won must not expose or raise milestone billing.
        if (foundMilestone.status !== 'REACHED') {
          return {
            ok: false,
            error: `Milestone is not reached. Current status: ${foundMilestone.status} (Milestone is not in REACHED status)`,
          }
        }

        if (!milestonesAllowed(foundTender.status)) {
          return { ok: false, error: tendersNotWonBillingError(foundTender.status) }
        }

        const billAmount = Number(customAmount ?? foundMilestone.amount ?? 0)
        if (billAmount <= 0) {
          return {
            ok: false,
            error: `Milestone billing amount must be greater than 0: ${billAmount}`,
          }
        }

        // Reservation: validate the revision BEFORE posting. A conflict here
        // posts no invoice (contracts §6.1 / F4), so a stale caller cannot cause
        // a stray invoice.
        const reservationRevision = expectedRevision ?? tendersData.revision
        const reservation = await authoritativeStore.mutate(
          reservationRevision,
          (document) => document,
        )
        if (!reservation.ok) {
          return {
            ok: false,
            error: reservation.error.message,
            currentRevision: reservation.current?.revision ?? reservation.error.current?.revision,
          }
        }

        const issuer = issuingAuthority || foundTender.issuingBody || 'Municipal Water Authority'
        const today = new Date().toISOString().split('T')[0]
        const dueDate =
          foundMilestone.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
        const ref = tenderReference || foundTender.referenceNumber || 'RFP-WTR-2026-04'
        const mName =
          milestoneTitle || foundMilestone.name || foundMilestone.title || 'Delivery Milestone'
        const itemDescription = `${mName} per ${ref}`

        // Single posting path via the typed port; Books owns party resolution,
        // VAT-inclusive pricing, numbering, journal posting and persistence.
        // `billingIdempotencyKey` makes the post retry-safe.
        const invoice = await issueMilestoneInvoice({
          tenderId: foundTender.id,
          milestoneId: foundMilestone.id,
          idempotencyKey: billingIdempotencyKey,
          partyName: issuer,
          itemDescription,
          itemCode: 'TENDER-PROGRESS',
          accountId: 'acc-sales',
          accountName: 'Tender & Commercial Contracting Sales',
          amount: billAmount,
          tenderReference: ref,
          notes: customNotes || 'Payment terms: 30 days net from tax invoice submission.',
          date: today,
          dueDate,
        })

        if (!invoice.ok || !invoice.invoiceId) {
          return { ok: false, error: invoice.error || 'Failed to bill milestone in Books' }
        }

        const invoiceId = invoice.invoiceId
        const invoiceNumber = invoice.invoiceNumber

        const applyBilling = (document: TendersDataV2, at: string): void => {
          const target = findTenderById(document, foundTender.id)
          const milestone = target?.tender.milestones?.find(
            (candidate) => candidate.id === foundMilestone.id,
          )
          if (!milestone) return
          milestone.status = 'BILLED'
          milestone.billedInvoiceId = invoiceId
          milestone.billedInvoiceNumber = invoiceNumber
          milestone.billedAt = at
          milestone.billedDate = at
        }

        const nowIso = new Date().toISOString()
        let committed = await authoritativeStore.mutate(reservationRevision, (document) => {
          applyBilling(document, nowIso)
          return document
        })
        let reconciled = false
        let warning: string | undefined

        if (!committed.ok) {
          // Reconcile: a competing writer may already have billed this
          // milestone, or the revision moved. Reload once and either adopt the
          // existing billing or retry the link exactly once with the fresh
          // revision. The invoice already exists (and is deduped by key), so a
          // retry can never double-post.
          let latest = committed.current
          if (!latest) {
            const reloaded = await authoritativeStore.load()
            if (reloaded.ok) latest = reloaded.data
          }
          const latestData = latest ?? tendersData
          const latestTarget = findTenderById(latestData, foundTender.id)
          const latestMilestone = latestTarget?.tender.milestones?.find(
            (candidate) => candidate.id === foundMilestone.id,
          )
          if (latestMilestone?.status === 'BILLED' || latestMilestone?.billedInvoiceId) {
            reconciled = true
            warning = 'Milestone was already billed; reused the existing invoice.'
          } else {
            const retry = await authoritativeStore.mutate(latestData.revision, (document) => {
              applyBilling(document, nowIso)
              return document
            })
            if (retry.ok) {
              committed = retry
            } else {
              // The invoice exists (deduped by key), but this call could not
              // commit the tender link. Report failure so the UI surfaces the
              // retry; the retry reconciles without double-posting.
              return {
                ok: false,
                error:
                  'Invoice posted; the milestone link could not be committed. Retry to reconcile the tender.',
                invoiceId,
                invoiceNumber,
                tenderReference: ref,
                currentRevision: retry.current?.revision ?? latestData.revision,
              }
            }
          }
        }

        // Open the owning app at the returned invoice.
        openOwningApp({ app: 'books', entityId: invoiceId })

        return {
          ok: true,
          invoiceNumber,
          invoiceId,
          tenderReference: ref,
          grandTotal: invoice.grandTotal,
          subtotal: invoice.subtotal,
          taxTotal: invoice.taxTotal,
          ...(reconciled ? { reconciled: true } : {}),
          ...(warning ? { warning } : {}),
        }
      } catch (err: any) {
        return {
          ok: false,
          error: err?.message || 'Failed to bill milestone in Books',
        }
      }
    },
  )
  ipcRegistered = true
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

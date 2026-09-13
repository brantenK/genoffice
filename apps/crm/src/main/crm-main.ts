import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, ipcMain, WebContentsView } from 'electron'
import { CRM_CHANNELS } from '../shared/ipc'
import type { Activity, ActivityPatch, Company, Contact, Deal, DealStage } from '../shared/types'
import { issueSalesInvoiceInBooks } from '../../../books/src/main/books-core'
import { CrmStore } from './crm-store'

const VALID_DEAL_STAGES: ReadonlySet<DealStage> = new Set([
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
])
const VALID_ACTIVITY_TYPES: ReadonlySet<Activity['type']> = new Set([
  'note',
  'call',
  'meeting',
  'email',
  'task',
])

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function requireObject<T extends object>(value: unknown, label: string): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object payload`)
  return value as T
}

function requirePlainObject<T extends object>(value: unknown, label: string): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be a plain object payload`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must be a plain object payload`)
  return value as T
}

function validateDealPayload(deal: Partial<Deal>): void {
  if (deal.id !== undefined) requireId(deal.id, 'Deal id')
  if (
    deal.amount !== undefined &&
    (typeof deal.amount !== 'number' || !Number.isFinite(deal.amount) || deal.amount < 0)
  ) {
    throw new Error('Deal amount must be a finite number greater than or equal to 0')
  }
  if (deal.owner !== undefined && typeof deal.owner !== 'string')
    throw new Error('Deal owner must be a string when provided')
  if (deal.nextStep !== undefined && typeof deal.nextStep !== 'string')
    throw new Error('Deal nextStep must be a string when provided')
}

function validateContactEmail(email: string): void {
  if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Contact email must be a valid email address')
  }
}

function validateActivityPatch(patch: ActivityPatch): void {
  const allowed = new Set(['title', 'description', 'type', 'dueDate', 'completed'])
  const unknown = Object.keys(patch).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`Activity patch contains unknown field: ${unknown}`)
  if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim()))
    throw new Error('Activity title must be a non-empty string when provided')
  if (patch.description !== undefined && typeof patch.description !== 'string')
    throw new Error('Activity description must be a string when provided')
  if (
    patch.type !== undefined &&
    (typeof patch.type !== 'string' || !VALID_ACTIVITY_TYPES.has(patch.type as Activity['type']))
  )
    throw new Error(`Activity type must be one of: ${Array.from(VALID_ACTIVITY_TYPES).join(', ')}`)
  if (
    patch.dueDate !== undefined &&
    (typeof patch.dueDate !== 'string' ||
      !patch.dueDate.trim() ||
      !Number.isFinite(new Date(patch.dueDate).getTime()))
  )
    throw new Error('Activity dueDate must be a non-empty, parseable date string when provided')
  if (patch.completed !== undefined && typeof patch.completed !== 'boolean')
    throw new Error('Activity completed must be a boolean when provided')
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function serializeCsvField(value: string | number): string {
  const text = String(value)
  const leadingTrimmed = text.trimStart()
  const safeText = /^[=+\-@]/.test(leadingTrimmed) || /^\s*[\t\r]/.test(text) ? `'${text}` : text
  return `"${safeText.replace(/"/g, '""')}"`
}

function serializeCsvRow(fields: Array<string | number>): string {
  return fields.map(serializeCsvField).join(',')
}

function writeTextFileAtomically(filePath: string, content: string): void {
  const tempPath = `${filePath}.${Date.now()}.tmp`
  try {
    writeFileSync(tempPath, content, 'utf8')
    renameSync(tempPath, filePath)
  } catch (error: unknown) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // Preserve the original write failure for the handler's existing error response.
    }
    throw error
  }
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/[\[\]]/g, '\\$&')
    .replace(/[<>]/g, '\\$&')
    .replace(/^(\s*)([#>])/gm, '$1\\$2')
}

function formatNotes(notes: string): string {
  return escapeMarkdown(notes)
    .split(/\r\n|\r|\n/)
    .map((line) => (line.length ? `> ${line}` : '>'))
    .join('\n')
}

export interface CrmRuntimeConfig {
  preloadPath: string
  rendererUrl?: string | undefined
  rendererFile: string
  openGeneratedPath?: (path: string) => boolean
  onOpenTenders?: (tenderTitle?: string) => void
  onOpenBooks?: () => void
}

let runtime: CrmRuntimeConfig = { preloadPath: '', rendererFile: '' }
let store: CrmStore | null = null
let ipcRegistered = false

function getStore(): CrmStore {
  if (!store) store = new CrmStore(app.getPath('userData'))
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
  ipcMain.handle(CRM_CHANNELS.getRecoveryState, () => s.getRecoveryState())
  ipcMain.handle(CRM_CHANNELS.acknowledgeRecovery, () => s.acknowledgeRecovery())
  ipcMain.handle(CRM_CHANNELS.listAudit, (_e, rawFilter: unknown) => {
    if (rawFilter === undefined) return s.listAudit()
    const filter = requireObject<{ dealId?: string; limit?: number }>(rawFilter, 'Audit filter')
    if (filter.dealId !== undefined) requireId(filter.dealId, 'Audit filter dealId')
    if (
      filter.limit !== undefined &&
      (typeof filter.limit !== 'number' || !Number.isFinite(filter.limit))
    ) {
      throw new Error('Audit filter limit must be a finite number')
    }
    return s.listAudit(filter)
  })
  ipcMain.handle(CRM_CHANNELS.findContactDuplicate, (_e, email: unknown, rawExcludeId: unknown) => {
    if (typeof email !== 'string') throw new Error('Contact duplicate email must be a string')
    const excludeId =
      rawExcludeId === undefined ? undefined : requireId(rawExcludeId, 'Contact excludeId')
    return s.findContactDuplicate(email, excludeId)
  })
  ipcMain.handle(
    CRM_CHANNELS.findCompanyDuplicate,
    (_e, name: unknown, rawDomain: unknown, rawExcludeId: unknown) => {
      if (typeof name !== 'string') throw new Error('Company duplicate name must be a string')
      if (rawDomain !== undefined && typeof rawDomain !== 'string')
        throw new Error('Company duplicate domain must be a string')
      const excludeId =
        rawExcludeId === undefined ? undefined : requireId(rawExcludeId, 'Company excludeId')
      return s.findCompanyDuplicate(name, rawDomain, excludeId)
    },
  )

  ipcMain.handle(CRM_CHANNELS.listDeals, () => s.getDeals())
  ipcMain.handle(CRM_CHANNELS.getDeal, (_e, id: unknown) => {
    const validId = requireId(id, 'Deal id')
    return s.getDeals().find((deal) => deal.id === validId) ?? null
  })
  ipcMain.handle(CRM_CHANNELS.saveDeal, (_e, rawDeal: unknown) => {
    const deal = requireObject<Partial<Deal>>(rawDeal, 'Deal')
    validateDealPayload(deal)
    s.assertMutationAllowed()
    return s.saveDeal(deal)
  })
  ipcMain.handle(CRM_CHANNELS.updateDealStage, (_e, id: unknown, stage: unknown) => {
    const validId = requireId(id, 'Deal id')
    if (typeof stage !== 'string' || !VALID_DEAL_STAGES.has(stage as DealStage))
      throw new Error(`Deal stage must be one of: ${Array.from(VALID_DEAL_STAGES).join(', ')}`)
    s.assertMutationAllowed()
    return s.updateDealStage(validId, stage as DealStage)
  })
  ipcMain.handle(CRM_CHANNELS.deleteDeal, (_e, id: unknown) => {
    const validId = requireId(id, 'Deal id')
    s.assertMutationAllowed()
    return s.deleteDeal(validId)
  })

  ipcMain.handle(CRM_CHANNELS.listContacts, () => s.getContacts())
  ipcMain.handle(CRM_CHANNELS.saveContact, (_e, rawContact: unknown) => {
    const contact = requireObject<Partial<Contact>>(rawContact, 'Contact')
    if (contact.id !== undefined) requireId(contact.id, 'Contact id')
    if (contact.companyId !== undefined) requireId(contact.companyId, 'Contact companyId')
    if (contact.email !== undefined && typeof contact.email !== 'string')
      throw new Error('Contact email must be a string')
    if (contact.email !== undefined) validateContactEmail(contact.email)
    s.assertMutationAllowed()
    return s.saveContact(contact)
  })
  ipcMain.handle(CRM_CHANNELS.deleteContact, (_e, id: unknown) => {
    const validId = requireId(id, 'Contact id')
    s.assertMutationAllowed()
    return s.deleteContact(validId)
  })

  ipcMain.handle(CRM_CHANNELS.listCompanies, () => s.getCompanies())
  ipcMain.handle(CRM_CHANNELS.saveCompany, (_e, rawCompany: unknown) => {
    const company = requireObject<Partial<Company>>(rawCompany, 'Company')
    if (company.id !== undefined) requireId(company.id, 'Company id')
    s.assertMutationAllowed()
    return s.saveCompany(company)
  })
  ipcMain.handle(CRM_CHANNELS.deleteCompany, (_e, id: unknown) => {
    const validId = requireId(id, 'Company id')
    s.assertMutationAllowed()
    return s.deleteCompany(validId)
  })

  ipcMain.handle(CRM_CHANNELS.listActivities, (_e, rawFilter: unknown) => {
    if (rawFilter === undefined) return s.getActivities()
    const filter = requireObject<{ dealId?: string; contactId?: string }>(
      rawFilter,
      'Activity filter',
    )
    if (filter.dealId !== undefined) requireId(filter.dealId, 'Activity filter dealId')
    if (filter.contactId !== undefined) requireId(filter.contactId, 'Activity filter contactId')
    return s.getActivities(filter)
  })
  ipcMain.handle(CRM_CHANNELS.addActivity, (_e, rawAct: unknown) => {
    const act = requireObject<Omit<Activity, 'id' | 'createdAt'>>(rawAct, 'Activity')
    if (act.dealId !== undefined) requireId(act.dealId, 'Activity dealId')
    if (act.contactId !== undefined) requireId(act.contactId, 'Activity contactId')
    s.assertMutationAllowed()
    return s.addActivity(act)
  })
  ipcMain.handle(CRM_CHANNELS.updateActivity, (_e, id: unknown, rawPatch: unknown) => {
    const validId = requireId(id, 'Activity id')
    const patch = requirePlainObject<ActivityPatch>(rawPatch, 'Activity patch')
    validateActivityPatch(patch)
    s.assertMutationAllowed()
    return s.updateActivity(validId, patch)
  })
  ipcMain.handle(CRM_CHANNELS.deleteActivity, (_e, id: unknown) => {
    const validId = requireId(id, 'Activity id')
    s.assertMutationAllowed()
    return s.deleteActivity(validId)
  })
  ipcMain.handle(CRM_CHANNELS.toggleActivity, (_e, id: unknown) => {
    const validId = requireId(id, 'Activity id')
    s.assertMutationAllowed()
    return s.toggleActivity(validId)
  })

  ipcMain.handle(CRM_CHANNELS.exportToSheets, () => {
    try {
      const rows = [
        serializeCsvRow([
          'Deal Name',
          'Company',
          'Contact',
          'Stage',
          'Amount ($)',
          'Probability (%)',
          'Expected Close Date',
        ]),
        ...s
          .getDeals()
          .map((deal) =>
            serializeCsvRow([
              deal.name || '',
              deal.companyName || '',
              deal.contactName || '',
              deal.stage.toUpperCase(),
              deal.amount || 0,
              deal.probability || 0,
              deal.expectedCloseDate || '',
            ]),
          ),
      ]
      const targetPath = join(tmpdir(), `Zanostack_Pipeline_${Date.now()}.csv`)
      writeTextFileAtomically(targetPath, `\uFEFF${rows.join('\r\n')}\r\n`)
      if (runtime.openGeneratedPath && !runtime.openGeneratedPath(targetPath)) {
        return {
          ok: false,
          path: targetPath,
          error: 'CSV export was created but could not be opened',
        }
      }
      return { ok: true, path: targetPath }
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error, 'Failed to export deals') }
    }
  })

  ipcMain.handle(CRM_CHANNELS.generateProposalDoc, (_e, rawDealId: unknown) => {
    const dealId = requireId(rawDealId, 'Deal id')
    try {
      const deal = s.getDeals().find((entry) => entry.id === dealId)
      if (!deal) return { ok: false, error: 'Deal not found' }
      const safeDealName = escapeMarkdown(deal.name)
      const notes = deal.notes ? formatNotes(deal.notes) : ''
      const content = `# Commercial Proposal: ${safeDealName}

> **Draft generated by CRM — review before sending**

- **Prepared for:** ${escapeMarkdown(deal.companyName || 'Valued Client')}
- **Primary Contact:** ${escapeMarkdown(deal.contactName || 'Executive Sponsor')}
- **Date:** ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}
- **Target Execution Date:** ${escapeMarkdown(deal.expectedCloseDate || 'Immediate')}

---

## 1. Executive Summary
This proposal outlines the commercial and technical scope for **${safeDealName}**. Our solution is designed to streamline operations, enhance security, and deliver enterprise-grade performance.

## 2. Investment & Commercial Terms

| Item | Scope Description | Investment |
| :--- | :--- | :--- |
| **Scope** | **Comprehensive Solution Scope** | **$${deal.amount.toLocaleString()}** |

Commercial terms are a draft to be confirmed before sending.

## 3. Notes & Discussion
${notes ? `${notes}\n\n` : ''}
---

*Generated by Zanostack CRM*
`
      const safeName = deal.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'untitled'
      const safeDealId = deal.id.replace(/[^a-zA-Z0-9_-]/g, '_')
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const targetPath = join(tmpdir(), `Proposal_${safeName}_${safeDealId}_${timestamp}.md`)
      writeTextFileAtomically(targetPath, content)
      if (runtime.openGeneratedPath && !runtime.openGeneratedPath(targetPath)) {
        return {
          ok: false,
          path: targetPath,
          error: 'Proposal was created but could not be opened',
        }
      }
      return { ok: true, path: targetPath }
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error, 'Failed to generate proposal') }
    }
  })

  ipcMain.handle(CRM_CHANNELS.openTenders, (_e, tenderTitle?: string) =>
    runtime.onOpenTenders ? (runtime.onOpenTenders(tenderTitle), true) : false,
  )
  ipcMain.handle(CRM_CHANNELS.openBooks, () =>
    runtime.onOpenBooks ? (runtime.onOpenBooks(), true) : false,
  )

  ipcMain.handle(CRM_CHANNELS.createInvoiceInBooks, async (_e, rawDealId: unknown) => {
    const dealId = requireId(rawDealId, 'Deal id')
    s.assertMutationAllowed()
    try {
      const deal = s.getDeals().find((entry) => entry.id === dealId)
      if (!deal) return { ok: false, error: `Deal not found: ${dealId}` }
      if (deal.stage !== 'won')
        return { ok: false, error: `Deal is not won. Current stage: ${deal.stage}` }
      if (deal.invoiceNumber || deal.invoiceId)
        return { ok: true, invoiceNumber: deal.invoiceNumber, invoiceId: deal.invoiceId }
      const result = issueSalesInvoiceInBooks({
        booksDataPath: join(app.getPath('userData'), 'books', 'books-data.json'),
        partyName: deal.companyName || deal.name || 'Valued Client',
        itemDescription: `${deal.name} - Commercial Implementation & Services`,
        itemCode: 'COMMERCIAL-DELIVERY',
        accountId: 'acc-sales',
        accountName: 'Tender & Commercial Contracting Sales',
        amount: Number(deal.amount || 0),
        crmDealId: deal.id,
        notes: 'Payment terms: Net 30 days upon invoice receipt.',
      })
      if (!result.ok || !result.invoice)
        return { ok: false, error: result.error || 'Failed to create invoice in Books' }
      const invoiceNumber = result.invoice.invoiceNumber
      const invoiceId = result.invoice.id
      s.saveDeal({ id: deal.id, invoiceId, invoiceNumber, invoicedAt: new Date().toISOString() })
      runtime.onOpenBooks?.()
      return { ok: true, invoiceNumber, invoiceId }
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error, 'Failed to create invoice in Books') }
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
  if (runtime.rendererUrl) void view.webContents.loadURL(runtime.rendererUrl)
  else if (runtime.rendererFile && existsSync(runtime.rendererFile))
    void view.webContents.loadFile(runtime.rendererFile)
  return view
}

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Activity,
  ActivityPatch,
  Company,
  Contact,
  CrmAuditAction,
  CrmAuditEntity,
  CrmAuditEntry,
  CrmStats,
  Deal,
  DealStage,
  DealsStoreEnvelope,
} from '../shared/types'
import type { CrmRecoveryItem, CrmRecoveryState } from '../shared/ipc'
import { SEED_ACTIVITIES, SEED_COMPANIES, SEED_CONTACTS, SEED_DEALS } from './seed-data'

export const CURRENT_DEALS_SCHEMA_VERSION = 1

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

function applyDealStageProbability(deal: Deal, previousStage?: DealStage): void {
  if (deal.stage === 'won') deal.probability = 100
  else if (deal.stage === 'lost') deal.probability = 0
  else if (previousStage === 'won' || previousStage === 'lost') deal.probability = 50
}

type RecoveryEntity = 'deals' | 'contacts' | 'companies' | 'activities'
type RecoveryInfo = Omit<CrmRecoveryItem, 'file'> & { originalFile: string }
type RecoveryRecord = RecoveryInfo & { acknowledged: boolean }
type RecoveryRecords = Record<string, RecoveryRecord>
type RecoveryCallback = (item: RecoveryInfo) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const VALID_AUDIT_ENTITIES: ReadonlySet<CrmAuditEntity> = new Set([
  'deal',
  'contact',
  'company',
  'activity',
])
const VALID_AUDIT_ACTIONS: ReadonlySet<CrmAuditAction> = new Set([
  'create',
  'update',
  'delete',
  'restore',
  'stage-change',
  'invoice-linked',
])

function isAuditEntry(raw: unknown): raw is CrmAuditEntry {
  if (!isRecord(raw)) return false
  return (
    hasString(raw, 'id') &&
    isValidDateString(raw.at) &&
    typeof raw.entity === 'string' &&
    VALID_AUDIT_ENTITIES.has(raw.entity as CrmAuditEntity) &&
    hasString(raw, 'entityId') &&
    typeof raw.action === 'string' &&
    VALID_AUDIT_ACTIONS.has(raw.action as CrmAuditAction) &&
    hasString(raw, 'summary') &&
    (raw.dealId === undefined || typeof raw.dealId === 'string')
  )
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && (value[key] as string).trim().length > 0
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'number' && Number.isFinite(value[key])
}

function isValidDateString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Number.isFinite(new Date(value).getTime())
  )
}

function validateContactEmail(email: string): void {
  if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Contact email must be a valid email address')
  }
}

const DEAL_AUDIT_FIELDS: ReadonlyArray<keyof Deal> = [
  'name',
  'companyId',
  'companyName',
  'contactId',
  'contactName',
  'amount',
  'stage',
  'probability',
  'owner',
  'nextStep',
  'expectedCloseDate',
  'notes',
  'invoiceId',
  'invoiceNumber',
  'invoicedAt',
]

const CONTACT_AUDIT_FIELDS: ReadonlyArray<keyof Contact> = [
  'name',
  'email',
  'phone',
  'title',
  'companyId',
  'companyName',
  'tags',
  'status',
]

const COMPANY_AUDIT_FIELDS: ReadonlyArray<keyof Company> = [
  'name',
  'domain',
  'industry',
  'size',
  'website',
  'city',
  'country',
]

function hasChanged<T extends object>(
  previous: T,
  next: T,
  fields: ReadonlyArray<keyof T>,
): boolean {
  return fields.some((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]))
}

export function isDeal(raw: unknown): raw is Deal {
  if (!isRecord(raw) || !hasString(raw, 'id') || !hasString(raw, 'name')) return false
  if (!hasNumber(raw, 'amount') || (raw.amount as number) < 0) return false
  if (typeof raw.stage !== 'string' || !VALID_DEAL_STAGES.has(raw.stage as DealStage)) return false
  if (
    !hasNumber(raw, 'probability') ||
    (raw.probability as number) < 0 ||
    (raw.probability as number) > 100
  )
    return false
  if (!hasString(raw, 'createdAt') || !hasString(raw, 'updatedAt')) return false
  return (
    (raw.companyId === undefined || typeof raw.companyId === 'string') &&
    (raw.companyName === undefined || typeof raw.companyName === 'string') &&
    (raw.contactId === undefined || typeof raw.contactId === 'string') &&
    (raw.contactName === undefined || typeof raw.contactName === 'string') &&
    (raw.owner === undefined || typeof raw.owner === 'string') &&
    (raw.nextStep === undefined || typeof raw.nextStep === 'string') &&
    (raw.expectedCloseDate === undefined || typeof raw.expectedCloseDate === 'string') &&
    (raw.notes === undefined || typeof raw.notes === 'string') &&
    (raw.invoiceId === undefined || typeof raw.invoiceId === 'string') &&
    (raw.invoiceNumber === undefined || typeof raw.invoiceNumber === 'string') &&
    (raw.invoicedAt === undefined || typeof raw.invoicedAt === 'string') &&
    (raw.deletedAt === undefined || typeof raw.deletedAt === 'string')
  )
}

export function isContact(raw: unknown): raw is Contact {
  if (
    !isRecord(raw) ||
    !hasString(raw, 'id') ||
    !hasString(raw, 'name') ||
    typeof raw.email !== 'string'
  )
    return false
  if (!Array.isArray(raw.tags) || !raw.tags.every((tag) => typeof tag === 'string')) return false
  if (raw.status !== 'lead' && raw.status !== 'active' && raw.status !== 'churned') return false
  if (!hasString(raw, 'createdAt') || !hasString(raw, 'updatedAt')) return false
  return (
    (raw.phone === undefined || typeof raw.phone === 'string') &&
    (raw.title === undefined || typeof raw.title === 'string') &&
    (raw.companyId === undefined || typeof raw.companyId === 'string') &&
    (raw.companyName === undefined || typeof raw.companyName === 'string') &&
    (raw.deletedAt === undefined || typeof raw.deletedAt === 'string')
  )
}

export function isCompany(raw: unknown): raw is Company {
  if (
    !isRecord(raw) ||
    !hasString(raw, 'id') ||
    !hasString(raw, 'name') ||
    !hasString(raw, 'createdAt')
  )
    return false
  return (
    ['domain', 'industry', 'size', 'website', 'city', 'country'].every(
      (key) => raw[key] === undefined || typeof raw[key] === 'string',
    ) &&
    (raw.deletedAt === undefined || typeof raw.deletedAt === 'string')
  )
}

export function isActivity(raw: unknown): raw is Activity {
  if (
    !isRecord(raw) ||
    !hasString(raw, 'id') ||
    !hasString(raw, 'title') ||
    typeof raw.description !== 'string'
  )
    return false
  if (typeof raw.type !== 'string' || !VALID_ACTIVITY_TYPES.has(raw.type as Activity['type']))
    return false
  if (!hasString(raw, 'createdAt')) return false
  return (
    (raw.dealId === undefined || typeof raw.dealId === 'string') &&
    (raw.contactId === undefined || typeof raw.contactId === 'string') &&
    (raw.completed === undefined || typeof raw.completed === 'boolean') &&
    (raw.dueDate === undefined || isValidDateString(raw.dueDate))
  )
}

export function sanitizeDeal(raw: unknown): Deal {
  const d = isRecord(raw) ? raw : {}
  const id =
    typeof d.id === 'string' && d.id.trim() ? d.id.trim() : `deal-${randomUUID().slice(0, 8)}`
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'Untitled Deal'
  const rawAmount =
    typeof d.amount === 'number'
      ? d.amount
      : typeof d.amount === 'string'
        ? parseFloat(d.amount)
        : NaN
  const amount =
    Number.isFinite(rawAmount) && rawAmount >= 0 ? Math.round(rawAmount * 100) / 100 : 0
  const stage =
    typeof d.stage === 'string' && VALID_DEAL_STAGES.has(d.stage as DealStage)
      ? (d.stage as DealStage)
      : 'lead'
  const probability =
    stage === 'won'
      ? 100
      : stage === 'lost'
        ? 0
        : typeof d.probability === 'number' && Number.isFinite(d.probability)
          ? Math.max(0, Math.min(100, Math.round(d.probability)))
          : 20
  const now = new Date().toISOString()
  const sanitized: Deal = {
    ...(d as unknown as Deal),
    id,
    name,
    amount,
    stage,
    probability,
    createdAt: typeof d.createdAt === 'string' && d.createdAt.trim() ? d.createdAt : now,
    updatedAt: typeof d.updatedAt === 'string' && d.updatedAt.trim() ? d.updatedAt : now,
  }
  if (typeof d.companyId === 'string') sanitized.companyId = d.companyId
  if (typeof d.companyName === 'string') sanitized.companyName = d.companyName
  if (typeof d.contactId === 'string') sanitized.contactId = d.contactId
  if (typeof d.contactName === 'string') sanitized.contactName = d.contactName
  const owner = typeof d.owner === 'string' ? d.owner.trim() : ''
  const nextStep = typeof d.nextStep === 'string' ? d.nextStep.trim() : ''
  if (owner) sanitized.owner = owner
  else delete sanitized.owner
  if (nextStep) sanitized.nextStep = nextStep
  else delete sanitized.nextStep
  if (typeof d.expectedCloseDate === 'string') sanitized.expectedCloseDate = d.expectedCloseDate
  if (typeof d.notes === 'string') sanitized.notes = d.notes
  if (typeof d.invoiceId === 'string') sanitized.invoiceId = d.invoiceId
  if (typeof d.invoiceNumber === 'string') sanitized.invoiceNumber = d.invoiceNumber
  if (typeof d.invoicedAt === 'string') sanitized.invoicedAt = d.invoicedAt
  if (typeof d.deletedAt === 'string') sanitized.deletedAt = d.deletedAt
  return sanitized
}

function invalidEntry(entity: string, index: number): Error {
  return new Error(`${entity} store entry ${index} has an invalid shape`)
}

function isLegacyDeal(raw: unknown): boolean {
  if (!isRecord(raw) || !hasString(raw, 'id') || !hasString(raw, 'name')) return false
  if (
    (typeof raw.amount !== 'number' && typeof raw.amount !== 'string') ||
    !Number.isFinite(typeof raw.amount === 'number' ? raw.amount : parseFloat(raw.amount))
  )
    return false
  return typeof raw.stage === 'string' && VALID_DEAL_STAGES.has(raw.stage as DealStage)
}

export function migrateAndValidateDeals(raw: unknown): DealsStoreEnvelope {
  const now = new Date().toISOString()
  let entries: unknown[]
  let version = CURRENT_DEALS_SCHEMA_VERSION
  let updatedAt = now
  if (Array.isArray(raw)) {
    raw.forEach((entry, index) => {
      if (!isLegacyDeal(entry)) throw invalidEntry('Deals', index)
    })
    const deals = raw.map(sanitizeDeal)
    deals.forEach((deal, index) => {
      if (!isDeal(deal)) throw invalidEntry('Deals', index)
    })
    return { version, updatedAt, deals }
  } else if (isRecord(raw) && Array.isArray(raw.deals)) {
    entries = raw.deals
    if (raw.version !== undefined && (typeof raw.version !== 'number' || raw.version < 1))
      throw new Error('Deals store has an invalid schema version')
    version = typeof raw.version === 'number' ? raw.version : CURRENT_DEALS_SCHEMA_VERSION
    if (raw.updatedAt !== undefined && typeof raw.updatedAt !== 'string')
      throw new Error('Deals store has an invalid updatedAt value')
    updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : now
  } else {
    throw new Error('Deals store must be an array or a versioned envelope')
  }
  entries.forEach((entry, index) => {
    if (!isDeal(entry)) throw invalidEntry('Deals', index)
  })
  return { version, updatedAt, deals: entries.map(sanitizeDeal) }
}

function emptyDeals(): DealsStoreEnvelope {
  return { version: CURRENT_DEALS_SCHEMA_VERSION, updatedAt: new Date().toISOString(), deals: [] }
}

function quarantineFile(
  filePath: string,
  entity: RecoveryEntity | 'audit',
  reason: string,
): string {
  const directory = filePath.replace(/[/\\][^/\\]+$/, '')
  const name = filePath.replace(/^.*[/\\]/, '').replace(/\.json$/, '')
  const timestamp = new Date().toISOString().replace(/:/g, '-')
  let quarantinePath = join(directory, `${name}.corrupt-${timestamp}.json`)
  let suffix = 1
  while (existsSync(quarantinePath)) {
    quarantinePath = join(directory, `${name}.corrupt-${timestamp}-${suffix}.json`)
    suffix += 1
  }
  if (existsSync(filePath)) renameSync(filePath, quarantinePath)
  console.warn(`CrmStore: quarantined ${entity} file ${filePath} to ${quarantinePath}: ${reason}`)
  return quarantinePath
}

export function readDealsStore(
  baseDirOrPath: string,
  fallbackSeed?: Deal[],
  onRecovery?: RecoveryCallback,
): DealsStoreEnvelope {
  const filePath = baseDirOrPath.endsWith('deals.json')
    ? baseDirOrPath
    : join(baseDirOrPath, 'deals.json')
  if (!existsSync(filePath)) {
    const directory = filePath.replace(/[/\\][^/\\]+$/, '')
    if (
      existsSync(directory) &&
      readdirSync(directory).some(
        (file) => file.startsWith('deals.corrupt-') && file.endsWith('.json'),
      )
    )
      return emptyDeals()
    return {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      deals: (fallbackSeed || []).map(sanitizeDeal),
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    const quarantinePath = quarantineFile(filePath, 'deals', reason)
    onRecovery?.({ entity: 'deals', originalFile: filePath, quarantinePath, reason })
    return emptyDeals()
  }
  let migrated: DealsStoreEnvelope
  try {
    migrated = migrateAndValidateDeals(parsed)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    const quarantinePath = quarantineFile(filePath, 'deals', reason)
    onRecovery?.({ entity: 'deals', originalFile: filePath, quarantinePath, reason })
    return emptyDeals()
  }
  if (Array.isArray(parsed)) writeDealsStore(filePath, migrated)
  return migrated
}

function atomicWrite(path: string, data: unknown): void {
  const directory = path.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  const tmp = `${path}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (error: unknown) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Preserve the original write failure.
    }
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to atomically write CRM file ${path}: ${cause}`)
  }
}

export function writeDealsStore(baseDirOrPath: string, envelope: DealsStoreEnvelope): void {
  const filePath = baseDirOrPath.endsWith('deals.json')
    ? baseDirOrPath
    : join(baseDirOrPath, 'deals.json')
  atomicWrite(filePath, {
    version: envelope.version || CURRENT_DEALS_SCHEMA_VERSION,
    updatedAt: envelope.updatedAt || new Date().toISOString(),
    deals: (envelope.deals || []).map(sanitizeDeal),
  })
}

export class CrmStore {
  private readonly baseDir: string
  private readonly quarantinedEntities = new Set<RecoveryEntity>()

  constructor(userDataDir: string) {
    this.baseDir = join(userDataDir, 'crm')
    this.init()
  }

  private init(): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    const defaults: Array<[RecoveryEntity, string, unknown]> = [
      [
        'deals',
        'deals.json',
        {
          version: CURRENT_DEALS_SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          deals: SEED_DEALS,
        },
      ],
      ['contacts', 'contacts.json', SEED_CONTACTS],
      ['companies', 'companies.json', SEED_COMPANIES],
      ['activities', 'activities.json', SEED_ACTIVITIES],
    ]
    for (const [entity, file, data] of defaults) {
      if (
        !existsSync(join(this.baseDir, file)) &&
        !this.hasQuarantine(entity) &&
        !this.hasRecoveryRecord(entity)
      ) {
        if (entity === 'deals') writeDealsStore(this.baseDir, data as DealsStoreEnvelope)
        else this.writeJson(join(this.baseDir, file), data)
      }
    }
  }

  private recoveryPath(): string {
    return join(this.baseDir, 'recovery.json')
  }

  private readRecoveryRecords(): RecoveryRecords {
    const path = this.recoveryPath()
    if (!existsSync(path)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!isRecord(parsed)) return {}
      const records: RecoveryRecords = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (!isRecord(value)) continue
        if (
          (value.entity === 'deals' ||
            value.entity === 'contacts' ||
            value.entity === 'companies' ||
            value.entity === 'activities') &&
          typeof value.originalFile === 'string' &&
          typeof value.quarantinePath === 'string' &&
          typeof value.reason === 'string' &&
          typeof value.acknowledged === 'boolean'
        )
          records[key] = value as unknown as RecoveryRecord
      }
      return records
    } catch {
      return {}
    }
  }

  private hasQuarantine(entity: RecoveryEntity): boolean {
    return readdirSync(this.baseDir).some(
      (file) => file.startsWith(`${entity}.corrupt-`) && file.endsWith('.json'),
    )
  }

  private hasRecoveryRecord(entity: RecoveryEntity): boolean {
    return Object.values(this.readRecoveryRecords()).some((record) => record.entity === entity)
  }

  private saveRecoveryRecords(records: RecoveryRecords): void {
    atomicWrite(this.recoveryPath(), records)
  }

  private recordRecovery(item: RecoveryInfo): void {
    const records = this.readRecoveryRecords()
    const key = item.quarantinePath.replace(/^.*[/\\]/, '')
    records[key] = { ...item, acknowledged: false }
    this.saveRecoveryRecords(records)
  }

  private recover(
    entity: RecoveryEntity,
    file: string,
    seed: unknown[],
    validator: (value: unknown) => boolean,
  ): unknown[] {
    const path = join(this.baseDir, file)
    if (!existsSync(path) && (this.quarantinedEntities.has(entity) || this.hasQuarantine(entity))) {
      this.quarantinedEntities.add(entity)
      return []
    }
    if (!existsSync(path)) return seed
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error(`${file} must contain an array`)
      parsed.forEach((entry, index) => {
        if (!validator(entry)) throw invalidEntry(entity, index)
      })
      return parsed
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      const quarantinePath = quarantineFile(path, entity, reason)
      this.quarantinedEntities.add(entity)
      this.recordRecovery({ entity, originalFile: path, quarantinePath, reason })
      return []
    }
  }

  private readJson<T extends unknown[]>(
    file: string,
    seed: T,
    validator: (value: unknown) => value is T[number],
  ): T {
    return this.recover(file.replace('.json', '') as RecoveryEntity, file, seed, validator) as T
  }

  private writeJson(path: string, data: unknown): void {
    atomicWrite(path, data)
  }

  private readAudit(): CrmAuditEntry[] {
    const path = join(this.baseDir, 'audit.json')
    if (!existsSync(path)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('audit.json must contain an array')
      const entries = parsed.filter(isAuditEntry)
      if (entries.length !== parsed.length)
        console.warn('CrmStore: ignored malformed entries in audit.json')
      return entries
    } catch (error: unknown) {
      console.warn('CrmStore: unable to read audit.json; starting with an empty audit trail', error)
      try {
        if (statSync(path).isFile()) quarantineFile(path, 'audit', String(error))
      } catch (quarantineError: unknown) {
        console.warn('CrmStore: unable to quarantine corrupt audit.json', quarantineError)
      }
      return []
    }
  }

  private appendAudit(entry: CrmAuditEntry): void {
    const entries = this.readAudit()
    entries.push(entry)
    // Entity writes intentionally happen first; audit is supplemental, so an audit failure must not fail the mutation.
    try {
      atomicWrite(join(this.baseDir, 'audit.json'), entries.slice(-2000))
    } catch (error: unknown) {
      console.warn(
        'CrmStore: unable to append audit entry; entity mutation was already persisted',
        error,
      )
    }
  }

  private audit(
    entity: CrmAuditEntity,
    entityId: string,
    action: CrmAuditAction,
    summary: string,
    dealId?: string,
  ): void {
    this.appendAudit({
      id: randomUUID(),
      at: new Date().toISOString(),
      entity,
      entityId,
      action,
      summary,
      dealId,
    })
  }

  listAudit(filter?: { dealId?: string; limit?: number }): CrmAuditEntry[] {
    const limit =
      filter?.limit === undefined ? 50 : Math.min(500, Math.max(0, Math.floor(filter.limit)))
    return this.readAudit()
      .filter((entry) => !filter?.dealId || entry.dealId === filter.dealId)
      .slice()
      .reverse()
      .slice(0, limit)
  }

  findContactDuplicate(email: string, excludeId?: string): { id: string; name: string } | null {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) return null
    const match = this.getContacts().find(
      (contact) =>
        contact.id !== excludeId && contact.email.trim().toLowerCase() === normalizedEmail,
    )
    return match ? { id: match.id, name: match.name } : null
  }

  findCompanyDuplicate(
    name: string,
    domain?: string,
    excludeId?: string,
  ): { id: string; name: string } | null {
    const normalizedName = name.trim().toLowerCase()
    const normalizedDomain = this.normalizeCompanyDomain(domain)
    if (!normalizedName && !normalizedDomain) return null
    const match = this.getCompanies().find((company) => {
      if (company.id === excludeId) return false
      const companyName = company.name.trim().toLowerCase()
      const companyDomain = this.normalizeCompanyDomain(company.domain)
      return (
        (normalizedName && companyName === normalizedName) ||
        (normalizedDomain !== '' && companyDomain === normalizedDomain)
      )
    })
    return match ? { id: match.id, name: match.name } : null
  }

  private normalizeCompanyDomain(domain?: string): string {
    return (domain || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '')
  }

  private assertValidList<T>(
    entity: string,
    list: T[],
    validator: (value: unknown) => boolean,
  ): void {
    list.forEach((entry, index) => {
      if (!validator(entry)) throw invalidEntry(entity, index)
    })
  }

  getRecoveryState(): CrmRecoveryState {
    this.getDealsEnvelope()
    this.getContacts()
    this.getCompanies()
    this.getActivities()
    const records = this.readRecoveryRecords()
    const seen = new Set<string>()
    const items: Array<CrmRecoveryItem & { acknowledged: boolean }> = []
    for (const record of Object.values(records)) {
      const key = record.quarantinePath.replace(/^.*[/\\]/, '')
      if (!record.acknowledged && existsSync(record.quarantinePath) && !seen.has(key)) {
        items.push({
          entity: record.entity,
          file: record.originalFile,
          quarantinePath: record.quarantinePath,
          reason: record.reason,
          acknowledged: false,
        })
        seen.add(key)
      }
    }
    for (const file of readdirSync(this.baseDir)) {
      const match = /^(deals|contacts|companies|activities)\.corrupt-.*\.json$/.exec(file)
      if (!match || seen.has(file) || records[file]?.acknowledged) continue
      const entity = match[1] as RecoveryEntity
      items.push({
        entity,
        file: join(this.baseDir, `${entity}.json`),
        quarantinePath: join(this.baseDir, file),
        reason: 'CRM data file was quarantined during recovery',
        acknowledged: false,
      })
    }
    return { items, pending: items.length > 0 }
  }

  acknowledgeRecovery(): void {
    const records = this.readRecoveryRecords()
    for (const item of this.getRecoveryState().items) {
      const key = item.quarantinePath.replace(/^.*[/\\]/, '')
      records[key] = {
        entity: item.entity,
        originalFile: item.file,
        quarantinePath: item.quarantinePath,
        reason: item.reason,
        acknowledged: true,
      }
    }
    this.saveRecoveryRecords(records)
  }

  assertMutationAllowed(): void {
    if (this.getRecoveryState().pending)
      throw new Error('Data recovery required — acknowledge in CRM first')
  }

  // ── Deals ──
  getDealsEnvelope(): DealsStoreEnvelope {
    const path = join(this.baseDir, 'deals.json')
    if (
      !existsSync(path) &&
      (this.quarantinedEntities.has('deals') || this.hasQuarantine('deals'))
    ) {
      this.quarantinedEntities.add('deals')
      return emptyDeals()
    }
    return readDealsStore(this.baseDir, SEED_DEALS, (item) => {
      this.quarantinedEntities.add('deals')
      this.recordRecovery(item)
    })
  }

  getDeals(): Deal[] {
    return this.getDealsEnvelope().deals.filter((deal) => !deal.deletedAt)
  }

  saveDeal(deal: Partial<Deal>): Deal {
    this.assertMutationAllowed()
    const list = this.getDealsEnvelope().deals
    const now = new Date().toISOString()
    const dealPatch: Partial<Deal> = { ...deal }
    delete dealPatch.deletedAt
    delete dealPatch.probability
    let previous: Deal | undefined
    let saved: Deal
    if (deal.id) {
      const index = list.findIndex((entry) => entry.id === deal.id)
      if (index >= 0) {
        previous = { ...list[index] }
        const existing = { ...previous }
        delete existing.deletedAt
        saved = sanitizeDeal({ ...existing, ...dealPatch, updatedAt: now })
        applyDealStageProbability(saved, existing.stage)
        list[index] = saved
      } else {
        saved = sanitizeDeal({
          id: deal.id,
          name: deal.name || 'Untitled Deal',
          amount: deal.amount ?? 0,
          stage: deal.stage || 'lead',
          probability: 20,
          createdAt: now,
          updatedAt: now,
          ...dealPatch,
        })
        list.push(saved)
      }
    } else {
      saved = sanitizeDeal({
        id: `deal-${randomUUID().slice(0, 8)}`,
        name: deal.name || 'New Opportunity',
        amount: deal.amount ?? 0,
        stage: deal.stage || 'lead',
        probability: 20,
        createdAt: now,
        updatedAt: now,
        ...dealPatch,
      })
      list.push(saved)
    }
    writeDealsStore(this.baseDir, {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: now,
      deals: list,
    })
    if (!previous) {
      this.audit('deal', saved.id, 'create', 'Opportunity created', saved.id)
    } else {
      if (previous.deletedAt)
        this.audit('deal', saved.id, 'restore', 'Opportunity restored', saved.id)
      if (previous.stage !== saved.stage)
        this.audit(
          'deal',
          saved.id,
          'stage-change',
          `Stage → ${saved.stage[0].toUpperCase()}${saved.stage.slice(1)}`,
          saved.id,
        )
      else if (!previous.deletedAt && hasChanged(previous, saved, DEAL_AUDIT_FIELDS))
        this.audit('deal', saved.id, 'update', 'Opportunity updated', saved.id)
      if (
        (!previous.invoiceId && saved.invoiceId) ||
        (!previous.invoiceNumber && saved.invoiceNumber)
      ) {
        this.audit(
          'deal',
          saved.id,
          'invoice-linked',
          `Invoice ${saved.invoiceNumber || saved.invoiceId} linked`,
          saved.id,
        )
      }
    }
    return saved
  }

  updateDealStage(id: string, stage: DealStage): boolean {
    if (!VALID_DEAL_STAGES.has(stage)) throw new Error(`Unknown deal stage: ${stage}`)
    this.assertMutationAllowed()
    const list = this.getDealsEnvelope().deals
    const deal = list.find((entry) => entry.id === id)
    if (!deal || deal.deletedAt) return false
    if (deal.stage === stage) return true
    const previousStage = deal.stage
    deal.stage = stage
    deal.updatedAt = new Date().toISOString()
    applyDealStageProbability(deal, previousStage)
    writeDealsStore(this.baseDir, {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      deals: list,
    })
    this.audit(
      'deal',
      deal.id,
      'stage-change',
      `Stage → ${stage[0].toUpperCase()}${stage.slice(1)}`,
      deal.id,
    )
    return true
  }

  deleteDeal(id: string): boolean {
    this.assertMutationAllowed()
    const list = this.getDealsEnvelope().deals
    const deal = list.find((entry) => entry.id === id)
    if (!deal || deal.deletedAt) return false
    deal.deletedAt = new Date().toISOString()
    writeDealsStore(this.baseDir, {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      deals: list,
    })
    this.audit('deal', deal.id, 'delete', 'Opportunity deleted', deal.id)
    return true
  }

  // ── Contacts ──
  private getRawContacts(): Contact[] {
    return this.readJson<Contact[]>('contacts.json', SEED_CONTACTS, isContact)
  }
  getContacts(): Contact[] {
    return this.getRawContacts().filter((contact) => !contact.deletedAt)
  }

  saveContact(contact: Partial<Contact>): Contact {
    this.assertMutationAllowed()
    if (contact.email !== undefined) validateContactEmail(contact.email)
    const list = this.getRawContacts()
    const now = new Date().toISOString()
    const contactPatch: Partial<Contact> = { ...contact }
    delete contactPatch.deletedAt
    let previous: Contact | undefined
    let saved: Contact
    if (contact.id) {
      const index = list.findIndex((entry) => entry.id === contact.id)
      if (index >= 0) {
        const existing = { ...list[index] }
        previous = existing
        delete existing.deletedAt
        saved = { ...existing, ...contactPatch, updatedAt: now } as Contact
        list[index] = saved
      } else {
        saved = {
          id: contact.id,
          name: contact.name || 'Unnamed Contact',
          email: contact.email || '',
          tags: contact.tags || [],
          status: contact.status || 'lead',
          createdAt: now,
          updatedAt: now,
          ...contactPatch,
        }
        list.push(saved)
      }
    } else {
      saved = {
        id: `cont-${randomUUID().slice(0, 8)}`,
        name: contact.name || 'New Contact',
        email: contact.email || '',
        tags: contact.tags || ['New'],
        status: contact.status || 'lead',
        createdAt: now,
        updatedAt: now,
        ...contactPatch,
      }
      list.push(saved)
    }
    this.assertValidList('contacts', list, isContact)
    this.writeJson(join(this.baseDir, 'contacts.json'), list)
    if (!previous) this.audit('contact', saved.id, 'create', 'Contact created')
    else if (previous.deletedAt) this.audit('contact', saved.id, 'restore', 'Contact restored')
    else if (hasChanged(previous, saved, CONTACT_AUDIT_FIELDS))
      this.audit('contact', saved.id, 'update', 'Contact updated')
    return saved
  }

  deleteContact(id: string): boolean {
    this.assertMutationAllowed()
    const list = this.getRawContacts()
    const contact = list.find((entry) => entry.id === id)
    if (!contact || contact.deletedAt) return false
    contact.deletedAt = new Date().toISOString()
    this.writeJson(join(this.baseDir, 'contacts.json'), list)
    this.audit('contact', contact.id, 'delete', 'Contact deleted')
    return true
  }

  // ── Companies ──
  private getRawCompanies(): Company[] {
    return this.readJson<Company[]>('companies.json', SEED_COMPANIES, isCompany)
  }
  getCompanies(): Company[] {
    return this.getRawCompanies().filter((company) => !company.deletedAt)
  }

  saveCompany(company: Partial<Company>): Company {
    this.assertMutationAllowed()
    const list = this.getRawCompanies()
    const companyPatch: Partial<Company> = { ...company }
    delete companyPatch.deletedAt
    let previous: Company | undefined
    let saved: Company
    if (company.id) {
      const index = list.findIndex((entry) => entry.id === company.id)
      if (index >= 0) {
        const existing = { ...list[index] }
        previous = existing
        delete existing.deletedAt
        saved = { ...existing, ...companyPatch } as Company
        list[index] = saved
      } else {
        saved = {
          id: company.id,
          name: company.name || 'Unnamed Company',
          createdAt: new Date().toISOString(),
          ...companyPatch,
        }
        list.push(saved)
      }
    } else {
      saved = {
        id: `comp-${randomUUID().slice(0, 8)}`,
        name: company.name || 'New Company',
        createdAt: new Date().toISOString(),
        ...companyPatch,
      }
      list.push(saved)
    }
    this.assertValidList('companies', list, isCompany)
    this.writeJson(join(this.baseDir, 'companies.json'), list)
    if (!previous) this.audit('company', saved.id, 'create', 'Company created')
    else if (previous.deletedAt) this.audit('company', saved.id, 'restore', 'Company restored')
    else if (hasChanged(previous, saved, COMPANY_AUDIT_FIELDS))
      this.audit('company', saved.id, 'update', 'Company updated')
    return saved
  }

  deleteCompany(id: string): boolean {
    this.assertMutationAllowed()
    const list = this.getRawCompanies()
    const company = list.find((entry) => entry.id === id)
    if (!company || company.deletedAt) return false
    company.deletedAt = new Date().toISOString()
    this.writeJson(join(this.baseDir, 'companies.json'), list)
    this.audit('company', company.id, 'delete', 'Company deleted')
    return true
  }

  // ── Activities ──
  getActivities(filter?: { dealId?: string; contactId?: string }): Activity[] {
    const list = this.readJson<Activity[]>('activities.json', SEED_ACTIVITIES, isActivity)
    if (!filter) return list
    return list.filter(
      (activity) =>
        (!filter.dealId || activity.dealId === filter.dealId) &&
        (!filter.contactId || activity.contactId === filter.contactId),
    )
  }

  addActivity(act: Omit<Activity, 'id' | 'createdAt'>): Activity {
    this.assertMutationAllowed()
    const list = this.getActivities()
    const saved: Activity = {
      id: `act-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      ...act,
    }
    list.unshift(saved)
    this.assertValidList('activities', list, isActivity)
    this.writeJson(join(this.baseDir, 'activities.json'), list)
    this.audit('activity', saved.id, 'create', 'Activity logged', saved.dealId)
    return saved
  }

  updateActivity(id: string, patch: ActivityPatch): Activity {
    this.assertMutationAllowed()
    if (!isRecord(patch)) throw new Error('Activity patch must be an object')
    const allowed = new Set(['title', 'description', 'type', 'dueDate', 'completed'])
    const unknown = Object.keys(patch).find((key) => !allowed.has(key))
    if (unknown) throw new Error(`Activity patch contains unknown field: ${unknown}`)
    if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim()))
      throw new Error('Activity title must be a non-empty string when provided')
    if (patch.description !== undefined && typeof patch.description !== 'string')
      throw new Error('Activity description must be a string when provided')
    if (patch.type !== undefined && !VALID_ACTIVITY_TYPES.has(patch.type))
      throw new Error(
        `Activity type must be one of: ${Array.from(VALID_ACTIVITY_TYPES).join(', ')}`,
      )
    if (patch.dueDate !== undefined && !isValidDateString(patch.dueDate))
      throw new Error('Activity dueDate must be a non-empty, parseable date string when provided')
    if (patch.completed !== undefined && typeof patch.completed !== 'boolean')
      throw new Error('Activity completed must be a boolean when provided')
    const list = this.getActivities()
    const index = list.findIndex((entry) => entry.id === id)
    if (index < 0) throw new Error(`Activity not found: ${id}`)
    const updated = { ...list[index], ...patch }
    if (!isActivity(updated)) throw new Error(`Activity ${id} would have an invalid shape`)
    const changed = (Object.keys(patch) as Array<keyof ActivityPatch>).some(
      (key) => JSON.stringify(list[index][key]) !== JSON.stringify(patch[key]),
    )
    if (!changed) return list[index]
    list[index] = updated
    this.writeJson(join(this.baseDir, 'activities.json'), list)
    this.audit('activity', updated.id, 'update', 'Activity updated', updated.dealId)
    return updated
  }

  deleteActivity(id: string): boolean {
    this.assertMutationAllowed()
    const list = this.getActivities()
    const index = list.findIndex((entry) => entry.id === id)
    if (index < 0) return false
    const deleted = list[index]
    list.splice(index, 1)
    this.writeJson(join(this.baseDir, 'activities.json'), list)
    this.audit('activity', deleted.id, 'delete', 'Activity deleted', deleted.dealId)
    return true
  }

  toggleActivity(id: string): boolean {
    this.assertMutationAllowed()
    const list = this.getActivities()
    const activity = list.find((entry) => entry.id === id)
    if (!activity) return false
    activity.completed = !activity.completed
    this.writeJson(join(this.baseDir, 'activities.json'), list)
    this.audit('activity', activity.id, 'update', 'Activity updated', activity.dealId)
    return true
  }

  getStats(): CrmStats {
    const deals = this.getDeals()
    const contacts = this.getContacts()
    const companies = this.getCompanies()
    // Pipeline and forecast metrics intentionally describe only open opportunities; win rate remains closed-deal count based.
    const openDeals = deals.filter((deal) => deal.stage !== 'won' && deal.stage !== 'lost')
    const wonDeals = deals.filter((deal) => deal.stage === 'won')
    const lostDeals = deals.filter((deal) => deal.stage === 'lost')
    const closedDeals = deals.filter((deal) => deal.stage === 'won' || deal.stage === 'lost')
    const totalPipelineValue = openDeals.reduce((sum, deal) => sum + (deal.amount || 0), 0)
    return {
      totalDeals: deals.length,
      openDeals: openDeals.length,
      wonDeals: wonDeals.length,
      lostDeals: lostDeals.length,
      totalPipelineValue,
      weightedForecastValue: Math.round(
        openDeals.reduce((sum, deal) => sum + (deal.amount * deal.probability) / 100, 0),
      ),
      avgOpenDealSize: openDeals.length ? Math.round(totalPipelineValue / openDeals.length) : 0,
      wonValue: wonDeals.reduce((sum, deal) => sum + (deal.amount || 0), 0),
      winRatePct: closedDeals.length ? Math.round((wonDeals.length / closedDeals.length) * 100) : 0,
      totalContacts: contacts.length,
      totalCompanies: companies.length,
    }
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Activity, Company, Contact, CrmStats, Deal, DealStage, DealsStoreEnvelope } from '../shared/types'
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

export function sanitizeDeal(raw: unknown): Deal {
  const d = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const id = typeof d.id === 'string' && d.id.trim() ? d.id.trim() : `deal-${randomUUID().slice(0, 8)}`
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'Untitled Deal'
  const rawAmount = typeof d.amount === 'number' ? d.amount : typeof d.amount === 'string' ? parseFloat(d.amount) : NaN
  const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? Math.round(rawAmount * 100) / 100 : 0
  const stage = typeof d.stage === 'string' && VALID_DEAL_STAGES.has(d.stage as DealStage) ? (d.stage as DealStage) : 'lead'

  let probability: number
  if (typeof d.probability === 'number' && Number.isFinite(d.probability)) {
    probability = Math.max(0, Math.min(100, Math.round(d.probability)))
  } else {
    probability = stage === 'won' ? 100 : stage === 'lost' ? 0 : 20
  }

  const now = new Date().toISOString()
  const createdAt = typeof d.createdAt === 'string' && d.createdAt.trim() ? d.createdAt : now
  const updatedAt = typeof d.updatedAt === 'string' && d.updatedAt.trim() ? d.updatedAt : now

  const sanitized: Deal = {
    ...(d as unknown as Deal),
    id,
    name,
    amount,
    stage,
    probability,
    createdAt,
    updatedAt,
  }

  if (typeof d.companyId === 'string') sanitized.companyId = d.companyId
  if (typeof d.companyName === 'string') sanitized.companyName = d.companyName
  if (typeof d.contactId === 'string') sanitized.contactId = d.contactId
  if (typeof d.contactName === 'string') sanitized.contactName = d.contactName
  if (typeof d.expectedCloseDate === 'string') sanitized.expectedCloseDate = d.expectedCloseDate
  if (typeof d.notes === 'string') sanitized.notes = d.notes
  if (typeof d.invoiceId === 'string') sanitized.invoiceId = d.invoiceId
  if (typeof d.invoiceNumber === 'string') sanitized.invoiceNumber = d.invoiceNumber
  if (typeof d.invoicedAt === 'string') sanitized.invoicedAt = d.invoicedAt

  return sanitized
}

export function migrateAndValidateDeals(raw: unknown): DealsStoreEnvelope {
  const now = new Date().toISOString()

  // v0 raw array migration
  if (Array.isArray(raw)) {
    return {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: now,
      deals: raw.map(sanitizeDeal),
    }
  }

  // v1+ versioned envelope validation
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).deals)) {
    const r = raw as any
    const version = typeof r.version === 'number' && r.version >= 1 ? r.version : CURRENT_DEALS_SCHEMA_VERSION
    const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt.trim() ? r.updatedAt : now
    return {
      version,
      updatedAt,
      deals: r.deals.map(sanitizeDeal),
    }
  }

  return {
    version: CURRENT_DEALS_SCHEMA_VERSION,
    updatedAt: now,
    deals: [],
  }
}

export function readDealsStore(baseDirOrPath: string, fallbackSeed?: Deal[]): DealsStoreEnvelope {
  const filePath = baseDirOrPath.endsWith('deals.json') ? baseDirOrPath : join(baseDirOrPath, 'deals.json')
  if (!existsSync(filePath)) {
    const deals = (fallbackSeed || []).map(sanitizeDeal)
    return {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      deals,
    }
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (err) {
    console.error('CrmStore: failed to read deals.json:', err)
    return {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      deals: (fallbackSeed || []).map(sanitizeDeal),
    }
  }

  try {
    const parsed = JSON.parse(content)
    return migrateAndValidateDeals(parsed)
  } catch (parseErr) {
    const backupPath = `${filePath}.corrupted.bak`
    try {
      writeFileSync(backupPath, content, 'utf8')
      console.warn(`CrmStore: Corrupted deals file detected. Backed up to ${backupPath}`)
    } catch (bakErr) {
      console.error('CrmStore: Failed to write corrupted backup file', bakErr)
    }
    return {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      deals: (fallbackSeed || []).map(sanitizeDeal),
    }
  }
}

export function writeDealsStore(baseDirOrPath: string, envelope: DealsStoreEnvelope): void {
  const filePath = baseDirOrPath.endsWith('deals.json') ? baseDirOrPath : join(baseDirOrPath, 'deals.json')
  const dir = filePath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const validEnvelope: DealsStoreEnvelope = {
    version: envelope.version || CURRENT_DEALS_SCHEMA_VERSION,
    updatedAt: envelope.updatedAt || new Date().toISOString(),
    deals: (envelope.deals || []).map(sanitizeDeal),
  }

  const tmp = `${filePath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(validEnvelope, null, 2), 'utf8')
    renameSync(tmp, filePath)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    console.error('CrmStore: failed to atomically write deals store', filePath, e)
    throw e
  }
}

export class CrmStore {
  private baseDir: string

  constructor(userDataDir: string) {
    this.baseDir = join(userDataDir, 'crm')
    this.init()
  }

  private init(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true })
    }

    const dealsPath = join(this.baseDir, 'deals.json')
    if (!existsSync(dealsPath)) {
      writeDealsStore(this.baseDir, {
        version: CURRENT_DEALS_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        deals: SEED_DEALS,
      })
    } else {
      try {
        const raw = readFileSync(dealsPath, 'utf8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) || !parsed.version) {
          const migrated = migrateAndValidateDeals(parsed)
          writeDealsStore(this.baseDir, migrated)
        }
      } catch {}
    }

    const contactsPath = join(this.baseDir, 'contacts.json')
    if (!existsSync(contactsPath)) {
      this.writeJson(contactsPath, SEED_CONTACTS)
    }

    const companiesPath = join(this.baseDir, 'companies.json')
    if (!existsSync(companiesPath)) {
      this.writeJson(companiesPath, SEED_COMPANIES)
    }

    const activitiesPath = join(this.baseDir, 'activities.json')
    if (!existsSync(activitiesPath)) {
      this.writeJson(activitiesPath, SEED_ACTIVITIES)
    }
  }

  private readJson<T>(file: string, fallback: T): T {
    const p = join(this.baseDir, file)
    try {
      if (!existsSync(p)) return fallback
      const content = readFileSync(p, 'utf8')
      return JSON.parse(content) as T
    } catch (err) {
      if (existsSync(p)) {
        try {
          const content = readFileSync(p, 'utf8')
          writeFileSync(`${p}.corrupted.bak`, content, 'utf8')
          console.warn(`CrmStore: Corrupted ${file} preserved to ${p}.corrupted.bak`)
        } catch {}
      }
      return fallback
    }
  }

  private writeJson<T>(path: string, data: T): void {
    const tmp = `${path}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, path)
    } catch (e) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {}
      console.error('CrmStore: failed to write file', path, e)
    }
  }

  // ── Deals ──
  getDealsEnvelope(): DealsStoreEnvelope {
    return readDealsStore(this.baseDir, SEED_DEALS)
  }

  getDeals(): Deal[] {
    return this.getDealsEnvelope().deals
  }

  saveDeal(deal: Partial<Deal>): Deal {
    const env = this.getDealsEnvelope()
    const list = env.deals
    const now = new Date().toISOString()
    let saved: Deal

    if (deal.id) {
      const idx = list.findIndex((d) => d.id === deal.id)
      if (idx >= 0) {
        saved = sanitizeDeal({ ...list[idx], ...deal, updatedAt: now })
        list[idx] = saved
      } else {
        saved = sanitizeDeal({
          id: deal.id,
          name: deal.name || 'Untitled Deal',
          amount: deal.amount ?? 0,
          stage: deal.stage || 'lead',
          probability: deal.probability ?? 20,
          createdAt: now,
          updatedAt: now,
          ...deal,
        })
        list.push(saved)
      }
    } else {
      saved = sanitizeDeal({
        id: `deal-${randomUUID().slice(0, 8)}`,
        name: deal.name || 'New Opportunity',
        amount: deal.amount ?? 0,
        stage: deal.stage || 'lead',
        probability: deal.probability ?? 20,
        createdAt: now,
        updatedAt: now,
        ...deal,
      })
      list.push(saved)
    }

    writeDealsStore(this.baseDir, {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: now,
      deals: list,
    })
    return saved
  }

  updateDealStage(id: string, stage: DealStage): boolean {
    const env = this.getDealsEnvelope()
    const list = env.deals
    const deal = list.find((d) => d.id === id)
    if (!deal) return false

    deal.stage = stage
    deal.updatedAt = new Date().toISOString()
    if (stage === 'won') deal.probability = 100
    if (stage === 'lost') deal.probability = 0

    writeDealsStore(this.baseDir, {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      deals: list,
    })
    return true
  }

  deleteDeal(id: string): boolean {
    const env = this.getDealsEnvelope()
    const list = env.deals
    const filtered = list.filter((d) => d.id !== id)
    if (filtered.length === list.length) return false
    writeDealsStore(this.baseDir, {
      version: CURRENT_DEALS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      deals: filtered,
    })
    return true
  }

  // ── Contacts ──
  getContacts(): Contact[] {
    return this.readJson<Contact[]>('contacts.json', [])
  }

  saveContact(contact: Partial<Contact>): Contact {
    const list = this.getContacts()
    const now = new Date().toISOString()
    let saved: Contact

    if (contact.id) {
      const idx = list.findIndex((c) => c.id === contact.id)
      if (idx >= 0) {
        saved = { ...list[idx], ...contact, updatedAt: now } as Contact
        list[idx] = saved
      } else {
        saved = {
          id: contact.id,
          name: contact.name || 'Unnamed Contact',
          email: contact.email || '',
          tags: contact.tags || [],
          status: contact.status || 'lead',
          createdAt: now,
          updatedAt: now,
          ...contact,
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
        ...contact,
      }
      list.push(saved)
    }

    this.writeJson(join(this.baseDir, 'contacts.json'), list)
    return saved
  }

  deleteContact(id: string): boolean {
    const list = this.getContacts()
    const filtered = list.filter((c) => c.id !== id)
    if (filtered.length === list.length) return false
    this.writeJson(join(this.baseDir, 'contacts.json'), filtered)
    return true
  }

  // ── Companies ──
  getCompanies(): Company[] {
    return this.readJson<Company[]>('companies.json', [])
  }

  saveCompany(company: Partial<Company>): Company {
    const list = this.getCompanies()
    let saved: Company

    if (company.id) {
      const idx = list.findIndex((c) => c.id === company.id)
      if (idx >= 0) {
        saved = { ...list[idx], ...company } as Company
        list[idx] = saved
      } else {
        saved = {
          id: company.id,
          name: company.name || 'Unnamed Company',
          createdAt: new Date().toISOString(),
          ...company,
        }
        list.push(saved)
      }
    } else {
      saved = {
        id: `comp-${randomUUID().slice(0, 8)}`,
        name: company.name || 'New Company',
        createdAt: new Date().toISOString(),
        ...company,
      }
      list.push(saved)
    }

    this.writeJson(join(this.baseDir, 'companies.json'), list)
    return saved
  }

  deleteCompany(id: string): boolean {
    const list = this.getCompanies()
    const filtered = list.filter((c) => c.id !== id)
    if (filtered.length === list.length) return false
    this.writeJson(join(this.baseDir, 'companies.json'), filtered)
    return true
  }

  // ── Activities ──
  getActivities(filter?: { dealId?: string; contactId?: string }): Activity[] {
    const list = this.readJson<Activity[]>('activities.json', [])
    if (!filter) return list
    return list.filter((a) => {
      if (filter.dealId && a.dealId !== filter.dealId) return false
      if (filter.contactId && a.contactId !== filter.contactId) return false
      return true
    })
  }

  addActivity(act: Omit<Activity, 'id' | 'createdAt'>): Activity {
    const list = this.getActivities()
    const saved: Activity = {
      id: `act-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      ...act,
    }
    list.unshift(saved)
    this.writeJson(join(this.baseDir, 'activities.json'), list)
    return saved
  }

  toggleActivity(id: string): boolean {
    const list = this.getActivities()
    const act = list.find((a) => a.id === id)
    if (!act) return false
    act.completed = !act.completed
    this.writeJson(join(this.baseDir, 'activities.json'), list)
    return true
  }

  // ── Aggregated Stats ──
  getStats(): CrmStats {
    const deals = this.getDeals()
    const contacts = this.getContacts()
    const companies = this.getCompanies()

    const totalDeals = deals.length
    const totalPipelineValue = deals.reduce((sum, d) => sum + (d.amount || 0), 0)
    const wonDeals = deals.filter((d) => d.stage === 'won')
    const wonValue = wonDeals.reduce((sum, d) => sum + (d.amount || 0), 0)
    const closedDeals = deals.filter((d) => d.stage === 'won' || d.stage === 'lost')
    const winRatePct =
      closedDeals.length > 0 ? Math.round((wonDeals.length / closedDeals.length) * 100) : 0

    return {
      totalDeals,
      totalPipelineValue,
      wonValue,
      winRatePct,
      totalContacts: contacts.length,
      totalCompanies: companies.length,
    }
  }
}

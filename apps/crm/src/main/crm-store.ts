import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Activity, Company, Contact, CrmStats, Deal, DealStage } from '../shared/types'
import { SEED_ACTIVITIES, SEED_COMPANIES, SEED_CONTACTS, SEED_DEALS } from './seed-data'

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
      this.writeJson(dealsPath, SEED_DEALS)
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
    try {
      const p = join(this.baseDir, file)
      if (!existsSync(p)) return fallback
      const content = readFileSync(p, 'utf8')
      return JSON.parse(content) as T
    } catch {
      return fallback
    }
  }

  private writeJson<T>(path: string, data: T): void {
    const tmp = `${path}.${Date.now()}.tmp`
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
  getDeals(): Deal[] {
    return this.readJson<Deal[]>('deals.json', [])
  }

  saveDeal(deal: Partial<Deal>): Deal {
    const list = this.getDeals()
    const now = new Date().toISOString()
    let saved: Deal

    if (deal.id) {
      const idx = list.findIndex((d) => d.id === deal.id)
      if (idx >= 0) {
        saved = { ...list[idx], ...deal, updatedAt: now } as Deal
        list[idx] = saved
      } else {
        saved = {
          id: deal.id,
          name: deal.name || 'Untitled Deal',
          amount: deal.amount ?? 0,
          stage: deal.stage || 'lead',
          probability: deal.probability ?? 20,
          createdAt: now,
          updatedAt: now,
          ...deal,
        }
        list.push(saved)
      }
    } else {
      saved = {
        id: `deal-${randomUUID().slice(0, 8)}`,
        name: deal.name || 'New Opportunity',
        amount: deal.amount ?? 0,
        stage: deal.stage || 'lead',
        probability: deal.probability ?? 20,
        createdAt: now,
        updatedAt: now,
        ...deal,
      }
      list.push(saved)
    }

    this.writeJson(join(this.baseDir, 'deals.json'), list)
    return saved
  }

  updateDealStage(id: string, stage: DealStage): boolean {
    const list = this.getDeals()
    const deal = list.find((d) => d.id === id)
    if (!deal) return false

    deal.stage = stage
    deal.updatedAt = new Date().toISOString()
    if (stage === 'won') deal.probability = 100
    if (stage === 'lost') deal.probability = 0

    this.writeJson(join(this.baseDir, 'deals.json'), list)
    return true
  }

  deleteDeal(id: string): boolean {
    const list = this.getDeals()
    const filtered = list.filter((d) => d.id !== id)
    if (filtered.length === list.length) return false
    this.writeJson(join(this.baseDir, 'deals.json'), filtered)
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

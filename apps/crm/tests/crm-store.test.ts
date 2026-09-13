import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CrmStore } from '../src/main/crm-store'

describe('CrmStore persistence and recovery', () => {
  let userDataDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'genoffice-crm-test-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('seeds missing files and quarantines corrupt files without overwriting prior quarantine', () => {
    const seeded = new CrmStore(userDataDir)
    expect(seeded.getDeals().length).toBeGreaterThan(0)
    expect(seeded.getContacts().length).toBeGreaterThan(0)
    expect(seeded.getCompanies().length).toBeGreaterThan(0)
    expect(seeded.getActivities().length).toBeGreaterThan(0)

    const crmDir = join(userDataDir, 'crm')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-12T10:11:12.000Z'))
    writeFileSync(join(crmDir, 'contacts.json'), '{not valid json', 'utf8')

    const firstRecovery = new CrmStore(userDataDir)
    const firstState = firstRecovery.getRecoveryState()
    expect(firstState.pending).toBe(true)
    expect(firstState.items.some((item) => item.entity === 'contacts')).toBe(true)
    expect(firstRecovery.getContacts()).toEqual([])
    expect(existsSync(join(crmDir, 'contacts.json'))).toBe(false)

    writeFileSync(join(crmDir, 'contacts.json'), '{still not valid json', 'utf8')
    const secondRecovery = new CrmStore(userDataDir)
    secondRecovery.getContacts()

    const quarantined = readdirSync(crmDir).filter(
      (file) =>
        file.startsWith('contacts.corrupt-2026-09-12T10-11-12.000Z') && file.endsWith('.json'),
    )
    expect(quarantined).toHaveLength(2)
    expect(quarantined.some((file) => file.endsWith('-1.json'))).toBe(true)
  })

  it('persists recovery acknowledgement and permits mutations after acknowledgement', () => {
    const seeded = new CrmStore(userDataDir)
    writeFileSync(join(userDataDir, 'crm', 'companies.json'), '{broken', 'utf8')

    const recovering = new CrmStore(userDataDir)
    expect(recovering.getRecoveryState().pending).toBe(true)
    expect(recovering.getCompanies()).toEqual([])

    const restartedBeforeAcknowledgement = new CrmStore(userDataDir)
    expect(restartedBeforeAcknowledgement.getCompanies()).toEqual([])
    expect(restartedBeforeAcknowledgement.getRecoveryState().pending).toBe(true)

    recovering.acknowledgeRecovery()
    expect(recovering.getRecoveryState().pending).toBe(false)
    expect(recovering.getCompanies()).toEqual([])

    const reloaded = new CrmStore(userDataDir)
    expect(reloaded.getRecoveryState().pending).toBe(false)
    expect(reloaded.getCompanies()).toEqual([])
    const saved = reloaded.saveCompany({ id: 'comp-after-recovery', name: 'Recovered Company' })
    expect(saved.id).toBe('comp-after-recovery')
    expect(reloaded.getCompanies()).toContainEqual(expect.objectContaining({ id: saved.id }))

    // Keep the initial construction explicit: the corrupt file was created only
    // after normal defaults had been seeded.
    expect(seeded.getDeals().length).toBeGreaterThan(0)
  })

  it('gates mutations while recovery is pending but leaves reads available', () => {
    const seeded = new CrmStore(userDataDir)
    writeFileSync(join(userDataDir, 'crm', 'contacts.json'), '{broken', 'utf8')
    const store = new CrmStore(userDataDir)

    expect(store.getRecoveryState().pending).toBe(true)
    expect(() => store.saveDeal({ id: 'deal-1', name: 'Blocked' })).toThrow(
      /Data recovery required/,
    )
    expect(() => store.deleteDeal('deal-1')).toThrow(/Data recovery required/)
    expect(() => store.updateDealStage('deal-1', 'won')).toThrow(/Data recovery required/)
    expect(store.getDeals().length).toBeGreaterThan(0)
    expect(store.getContacts()).toEqual([])
    expect(seeded.getCompanies().length).toBeGreaterThan(0)
  })

  it('updates existing deals and creates new deals while preserving ids and timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-12T11:00:00.000Z'))
    const store = new CrmStore(userDataDir)
    const original = store.getDeals().find((deal) => deal.id === 'deal-1')!

    vi.setSystemTime(new Date('2026-09-12T11:01:00.000Z'))
    const updated = store.saveDeal({ id: original.id, name: 'Updated Deal', amount: 1234.56 })
    expect(updated.id).toBe(original.id)
    expect(updated.createdAt).toBe(original.createdAt)
    expect(updated.updatedAt).toBe('2026-09-12T11:01:00.000Z')
    expect(updated.name).toBe('Updated Deal')

    const created = store.saveDeal({ name: 'Created Deal', amount: 42 })
    expect(created.id).not.toBe(original.id)
    expect(created.createdAt).toBe('2026-09-12T11:01:00.000Z')
    expect(created.updatedAt).toBe('2026-09-12T11:01:00.000Z')
  })

  it('trims, persists, resurrects, and audits optional deal owner and next step fields', () => {
    const store = new CrmStore(userDataDir)
    const created = store.saveDeal({
      name: 'Owned Deal',
      amount: 100,
      owner: '  Alex Morgan  ',
      nextStep: '  Send proposal  ',
    })
    expect(created).toMatchObject({ owner: 'Alex Morgan', nextStep: 'Send proposal' })

    const reloaded = new CrmStore(userDataDir)
    expect(reloaded.getDeals()).toContainEqual(
      expect.objectContaining({
        id: created.id,
        owner: 'Alex Morgan',
        nextStep: 'Send proposal',
      }),
    )

    expect(reloaded.deleteDeal(created.id)).toBe(true)
    const resurrected = reloaded.saveDeal({ id: created.id })
    expect(resurrected).toMatchObject({ owner: 'Alex Morgan', nextStep: 'Send proposal' })

    reloaded.saveDeal({ id: created.id, owner: '  Casey Brown  ', nextStep: '  Confirm budget  ' })
    const updatesAfterChange = reloaded
      .listAudit({ dealId: created.id, limit: 50 })
      .filter((entry) => entry.action === 'update')
    expect(updatesAfterChange).toHaveLength(1)

    reloaded.saveDeal({ id: created.id, owner: 'Casey Brown', nextStep: 'Confirm budget' })
    expect(
      reloaded
        .listAudit({ dealId: created.id, limit: 50 })
        .filter((entry) => entry.action === 'update'),
    ).toHaveLength(1)

    const cleared = reloaded.saveDeal({ id: created.id, owner: '   ', nextStep: '' })
    expect(cleared.owner).toBeUndefined()
    expect(cleared.nextStep).toBeUndefined()
    const finalReload = new CrmStore(userDataDir)
    const finalDeal = finalReload.getDeals().find((deal) => deal.id === created.id)
    expect(finalDeal?.owner).toBeUndefined()
    expect(finalDeal?.nextStep).toBeUndefined()
  })

  it('migrates legacy deal arrays before strict v1 validation', () => {
    const first = new CrmStore(userDataDir)
    writeFileSync(
      join(userDataDir, 'crm', 'deals.json'),
      JSON.stringify([{ id: 'legacy-deal', name: 'Legacy Deal', amount: '120000', stage: 'lead' }]),
      'utf8',
    )

    const store = new CrmStore(userDataDir)
    const deal = store.getDeals().find((entry) => entry.id === 'legacy-deal')
    expect(deal).toMatchObject({
      id: 'legacy-deal',
      name: 'Legacy Deal',
      amount: 120000,
      stage: 'lead',
      probability: 20,
    })
    const persisted = JSON.parse(readFileSync(join(userDataDir, 'crm', 'deals.json'), 'utf8')) as {
      version: number
      deals: unknown[]
    }
    expect(persisted.version).toBe(1)
    expect(persisted.deals).toHaveLength(1)
    expect(store.getRecoveryState().pending).toBe(false)
    expect(first.getDeals().length).toBeGreaterThan(0)
  })

  it('enforces terminal probabilities and preserves non-terminal probabilities on save', () => {
    const store = new CrmStore(userDataDir)
    const won = store.saveDeal({ name: 'Won Deal', stage: 'won', probability: 50 })
    expect(won.probability).toBe(100)
    expect(store.saveDeal({ id: won.id, probability: 50 }).probability).toBe(100)

    const lost = store.saveDeal({ name: 'Lost Deal', stage: 'lost', probability: 50 })
    expect(lost.probability).toBe(0)

    const open = store.saveDeal({ name: 'Open Deal', stage: 'lead', probability: 80 })
    expect(open.probability).toBe(20)
    expect(store.saveDeal({ id: open.id, stage: 'proposal', probability: 50 }).probability).toBe(20)
  })

  it('resets probability to 50 when saveDeal reopens a terminal deal', () => {
    const store = new CrmStore(userDataDir)
    expect(store.saveDeal({ id: 'deal-3', stage: 'proposal' }).probability).toBe(50)

    store.updateDealStage('deal-5', 'lost')
    expect(store.saveDeal({ id: 'deal-5', stage: 'negotiation' }).probability).toBe(50)

    const nonTerminal = store.saveDeal({ id: 'deal-4', stage: 'lead' })
    expect(nonTerminal.probability).toBe(40)
    expect(store.saveDeal({ id: 'deal-4', stage: 'qualified' }).probability).toBe(40)
  })

  it('rejects unknown stages and applies won, lost, and reopened probabilities', () => {
    const store = new CrmStore(userDataDir)
    expect(() => store.updateDealStage('deal-1', 'unknown' as never)).toThrow(
      'Unknown deal stage: unknown',
    )

    expect(store.updateDealStage('deal-1', 'won')).toBe(true)
    expect(store.getDeals().find((deal) => deal.id === 'deal-1')?.probability).toBe(100)
    expect(store.updateDealStage('deal-1', 'lost')).toBe(true)
    expect(store.getDeals().find((deal) => deal.id === 'deal-1')?.probability).toBe(0)
    expect(store.updateDealStage('deal-1', 'proposal')).toBe(true)
    expect(store.getDeals().find((deal) => deal.id === 'deal-1')?.probability).toBe(50)
  })

  it('round-trips contacts and companies through a new store instance', () => {
    const store = new CrmStore(userDataDir)
    const contact = store.saveContact({
      id: 'cont-round-trip',
      name: 'Round Trip Contact',
      email: 'round.trip@example.com',
      tags: ['test'],
      status: 'active',
    })
    const company = store.saveCompany({
      id: 'comp-round-trip',
      name: 'Round Trip Company',
      domain: 'round-trip.example.com',
    })

    const reloaded = new CrmStore(userDataDir)
    expect(reloaded.getContacts()).toContainEqual(expect.objectContaining(contact))
    expect(reloaded.getCompanies()).toContainEqual(expect.objectContaining(company))
  })

  it('quarantines shape-invalid entries for every validated entity', () => {
    new CrmStore(userDataDir)
    const crmDir = join(userDataDir, 'crm')
    writeFileSync(join(crmDir, 'deals.json'), JSON.stringify([{ id: 'bad-deal' }]), 'utf8')
    writeFileSync(
      join(crmDir, 'contacts.json'),
      JSON.stringify([{ id: 'bad-contact', name: 'Bad', email: 42 }]),
      'utf8',
    )
    writeFileSync(
      join(crmDir, 'companies.json'),
      JSON.stringify([{ id: 'bad-company', name: 'Bad' }]),
      'utf8',
    )
    writeFileSync(
      join(crmDir, 'activities.json'),
      JSON.stringify([{ id: 'bad-activity', title: 'Bad', description: 'Bad', type: 'note' }]),
      'utf8',
    )

    const store = new CrmStore(userDataDir)
    const state = store.getRecoveryState()
    expect(state.pending).toBe(true)
    expect(new Set(state.items.map((item) => item.entity))).toEqual(
      new Set(['deals', 'contacts', 'companies', 'activities']),
    )
    expect(store.getDeals()).toEqual([])
    expect(store.getContacts()).toEqual([])
    expect(store.getCompanies()).toEqual([])
    expect(store.getActivities()).toEqual([])
    expect(
      readdirSync(crmDir).filter((file) =>
        /^(deals|contacts|companies|activities)\.corrupt-.*\.json$/.test(file),
      ),
    ).toHaveLength(4)
  })

  it('soft-deletes records from lists and stats, preserves them on disk, and resurrects on save', () => {
    const store = new CrmStore(userDataDir)
    const deal = store.getDeals()[0]
    const contact = store.getContacts()[0]
    const company = store.getCompanies()[0]
    const before = store.getStats()

    expect(store.deleteDeal(deal.id)).toBe(true)
    expect(store.deleteContact(contact.id)).toBe(true)
    expect(store.deleteCompany(company.id)).toBe(true)
    expect(store.getDeals()).not.toContainEqual(expect.objectContaining({ id: deal.id }))
    expect(store.getContacts()).not.toContainEqual(expect.objectContaining({ id: contact.id }))
    expect(store.getCompanies()).not.toContainEqual(expect.objectContaining({ id: company.id }))
    expect(store.getStats().totalDeals).toBe(before.totalDeals - 1)
    expect(store.getStats().totalContacts).toBe(before.totalContacts - 1)
    expect(store.getStats().totalCompanies).toBe(before.totalCompanies - 1)

    const crmDir = join(userDataDir, 'crm')
    const rawDeals = JSON.parse(readFileSync(join(crmDir, 'deals.json'), 'utf8')) as {
      deals: Array<{ id: string; deletedAt?: string }>
    }
    const rawContacts = JSON.parse(readFileSync(join(crmDir, 'contacts.json'), 'utf8')) as Array<{
      id: string
      deletedAt?: string
    }>
    const rawCompanies = JSON.parse(readFileSync(join(crmDir, 'companies.json'), 'utf8')) as Array<{
      id: string
      deletedAt?: string
    }>
    expect(rawDeals.deals.find((entry) => entry.id === deal.id)?.deletedAt).toBeTruthy()
    expect(rawContacts.find((entry) => entry.id === contact.id)?.deletedAt).toBeTruthy()
    expect(rawCompanies.find((entry) => entry.id === company.id)?.deletedAt).toBeTruthy()

    expect(store.saveDeal({ id: deal.id, name: 'Resurrected Deal' }).deletedAt).toBeUndefined()
    expect(store.saveContact({ id: contact.id, name: contact.name }).deletedAt).toBeUndefined()
    expect(store.saveCompany({ id: company.id, name: company.name }).deletedAt).toBeUndefined()
    expect(store.getDeals()).toContainEqual(
      expect.objectContaining({ id: deal.id, name: 'Resurrected Deal' }),
    )
    expect(store.getContacts()).toContainEqual(expect.objectContaining({ id: contact.id }))
    expect(store.getCompanies()).toContainEqual(expect.objectContaining({ id: company.id }))
  })

  it('keeps a soft-deleted record when an unrelated record is saved', () => {
    const store = new CrmStore(userDataDir)
    const deleted = store.getDeals()[0]
    store.deleteDeal(deleted.id)
    store.saveDeal({ name: 'Unrelated Deal', amount: 10 })

    const raw = JSON.parse(readFileSync(join(userDataDir, 'crm', 'deals.json'), 'utf8')) as {
      deals: Array<{ id: string; deletedAt?: string }>
    }
    expect(raw.deals.find((entry) => entry.id === deleted.id)?.deletedAt).toBeTruthy()
  })

  it('returns false when deleting unknown or already-deleted records', () => {
    const store = new CrmStore(userDataDir)
    expect(store.deleteDeal('missing-deal')).toBe(false)
    expect(store.deleteContact('missing-contact')).toBe(false)
    expect(store.deleteCompany('missing-company')).toBe(false)
    expect(store.deleteActivity('missing-activity')).toBe(false)
    const deal = store.getDeals()[0]
    expect(store.deleteDeal(deal.id)).toBe(true)
    expect(store.deleteDeal(deal.id)).toBe(false)
  })

  it('updates, persists, and deletes activities with validated patches', () => {
    const store = new CrmStore(userDataDir)
    const activity = store.addActivity({ type: 'task', title: 'Original', description: 'Details' })
    const updated = store.updateActivity(activity.id, {
      title: 'Updated',
      description: 'Changed',
      type: 'meeting',
      dueDate: '2027-01-15',
      completed: true,
    })
    expect(updated).toMatchObject({
      title: 'Updated',
      description: 'Changed',
      type: 'meeting',
      dueDate: '2027-01-15',
      completed: true,
    })

    const reloaded = new CrmStore(userDataDir)
    expect(reloaded.getActivities()).toContainEqual(expect.objectContaining(updated))
    expect(() => reloaded.updateActivity('missing-activity', { title: 'Nope' })).toThrow(
      'Activity not found',
    )
    expect(() => reloaded.updateActivity(activity.id, { type: 'invalid' as never })).toThrow(
      'Activity type must be one of',
    )
    expect(reloaded.deleteActivity(activity.id)).toBe(true)
    expect(reloaded.getActivities()).not.toContainEqual(
      expect.objectContaining({ id: activity.id }),
    )
  })

  it('accepts valid due dates and rejects invalid due dates', () => {
    const store = new CrmStore(userDataDir)
    const activity = store.addActivity({
      type: 'note',
      title: 'Due date',
      description: 'Valid',
      dueDate: '2027-02-01',
    })
    expect(activity.dueDate).toBe('2027-02-01')
    expect(() =>
      store.addActivity({
        type: 'note',
        title: 'Invalid',
        description: 'Bad',
        dueDate: 'not-a-date',
      }),
    ).toThrow('invalid shape')
    expect(() => store.updateActivity(activity.id, { dueDate: '' })).toThrow('parseable date')
  })

  it('reports open pipeline, weighted forecast, deal counts, average size, and closed win rate', () => {
    const store = new CrmStore(userDataDir)
    store.updateDealStage('deal-5', 'lost')

    const stats = store.getStats()
    expect(stats.totalDeals).toBe(5)
    expect(stats.openDeals).toBe(3)
    expect(stats.wonDeals).toBe(1)
    expect(stats.lostDeals).toBe(1)
    expect(stats.totalPipelineValue).toBe(260000)
    expect(stats.weightedForecastValue).toBe(167000)
    expect(stats.avgOpenDealSize).toBe(86667)
    expect(stats.winRatePct).toBe(50)

    store.deleteDeal('deal-3')
    store.deleteDeal('deal-5')
    expect(store.getStats().winRatePct).toBe(0)
  })

  it('records deal audit history newest-first and filters by deal and limit', () => {
    const store = new CrmStore(userDataDir)
    const deal = store.saveDeal({ name: 'Audited Deal', amount: 100 })
    store.updateDealStage(deal.id, 'proposal')
    store.deleteDeal(deal.id)
    store.saveDeal({ id: deal.id, name: 'Restored Audited Deal' })

    const history = store.listAudit({ dealId: deal.id, limit: 10 })
    expect(history.map((entry) => entry.action)).toEqual([
      'restore',
      'delete',
      'stage-change',
      'create',
    ])
    expect(history.every((entry) => entry.entityId === deal.id && entry.dealId === deal.id)).toBe(
      true,
    )
    expect(store.listAudit({ dealId: deal.id, limit: 2 })).toEqual(history.slice(0, 2))
  })

  it('does not let audit corruption gate entity mutations', () => {
    const store = new CrmStore(userDataDir)
    writeFileSync(join(userDataDir, 'crm', 'audit.json'), '{broken', 'utf8')
    const saved = store.saveCompany({ name: 'Audit Corruption Recovery' })
    expect(saved.name).toBe('Audit Corruption Recovery')
    expect(store.getRecoveryState().pending).toBe(false)
    expect(store.listAudit().length).toBeGreaterThan(0)
  })

  it('keeps entity mutations successful when audit append fails', () => {
    const store = new CrmStore(userDataDir)
    mkdirSync(join(userDataDir, 'crm', 'audit.json'))

    const saved = store.saveCompany({ name: 'Audit Write Failure' })
    expect(saved.name).toBe('Audit Write Failure')
    expect(store.getCompanies()).toContainEqual(expect.objectContaining({ id: saved.id }))
  })

  it('quarantines an unreadable audit file without entering recovery mode', () => {
    const store = new CrmStore(userDataDir)
    writeFileSync(join(userDataDir, 'crm', 'audit.json'), '{not an array', 'utf8')

    expect(store.listAudit()).toEqual([])
    expect(store.getRecoveryState().pending).toBe(false)
    expect(
      readdirSync(join(userDataDir, 'crm')).some(
        (file) => file.startsWith('audit.corrupt-') && file.endsWith('.json'),
      ),
    ).toBe(true)
  })

  it('does not append audit updates for unchanged data', () => {
    const store = new CrmStore(userDataDir)
    const deal = store.getDeals()[0]
    const contact = store.getContacts()[0]
    const company = store.getCompanies()[0]
    const activity = store.getActivities()[0]

    store.saveDeal({ id: deal.id })
    store.updateDealStage(deal.id, deal.stage)
    store.saveContact({ id: contact.id })
    store.saveCompany({ id: company.id })
    store.updateActivity(activity.id, { title: activity.title })

    expect(store.listAudit()).toEqual([])
  })

  it('finds normalized contact and company duplicates while excluding deleted records', () => {
    const store = new CrmStore(userDataDir)
    const firstContact = store.saveContact({ name: 'First', email: 'Alice@Example.COM' })
    const secondContact = store.saveContact({ name: 'Second', email: 'alice@example.com' })
    expect(store.findContactDuplicate('alice@example.com')).toEqual({
      id: firstContact.id,
      name: 'First',
    })
    expect(store.findContactDuplicate('alice@example.com', firstContact.id)).toEqual({
      id: secondContact.id,
      name: 'Second',
    })
    store.deleteContact(secondContact.id)
    expect(store.findContactDuplicate('alice@example.com', firstContact.id)).toBeNull()
    expect(store.findContactDuplicate('   ')).toBeNull()

    const firstCompany = store.saveCompany({
      name: 'Acme Corp',
      domain: 'https://www.Example.com/',
    })
    expect(store.findCompanyDuplicate(' acme corp ')).toEqual({
      id: firstCompany.id,
      name: 'Acme Corp',
    })
    expect(store.findCompanyDuplicate('Other', 'example.com')).toEqual({
      id: firstCompany.id,
      name: 'Acme Corp',
    })
    expect(store.findCompanyDuplicate('Acme Corp', undefined, firstCompany.id)).toBeNull()
    store.deleteCompany(firstCompany.id)
    expect(store.findCompanyDuplicate('Acme Corp')).toBeNull()
  })

  it('rejects invalid contact email while allowing an empty email', () => {
    const store = new CrmStore(userDataDir)
    expect(() => store.saveContact({ name: 'Invalid', email: 'not-an-email' })).toThrow(
      'Contact email must be a valid email address',
    )
    expect(store.saveContact({ name: 'No Email', email: '' }).email).toBe('')
  })
})

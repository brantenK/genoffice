/**
 * Phase 4 lane L2 — typed integration ports, the two known races, and the
 * main-owned readiness snapshot binding.
 *
 * These tests are deterministic and offline: the CRM/Books ports are exercised
 * against real on-disk stores under a temp directory, and the IPC handlers run
 * against an in-memory electron mock. No network.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── electron mock (only the Tenders main import needs it) ─────────────────────

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => (globalThis as any).__tendersTestUserData,
    isReady: () => true,
  },
  ipcMain: {
    handle: (channel: string, listener: (...args: any[]) => any) => {
      ipcHandlers.set(channel, listener)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    },
  },
  shell: { openPath: vi.fn(async () => '') },
  WebContentsView: class MockWebContentsView {
    webContents = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
  },
}))

import { createCrmTenderPort } from '../../crm/src/main/tender-port'
import { createBooksTenderPort } from '../../books/src/main/tender-port'
import { migrateAndValidateDeals } from '../../crm/src/main/crm-store'
import {
  configureTendersRuntime,
  registerTendersIpc,
  registerTendersWebContents,
  resetTendersIpcForTests,
} from '../src/main/tenders-main'
import { buildCanonicalReadinessReport } from '../src/main/readiness-binding'
import { generateProposalMarkdown } from '../src/main/proposal-generator'
import { TENDERS_CHANNELS } from '../src/shared/ipc'
import {
  bindReadinessReport,
  readinessFingerprint,
  type ReadinessReport,
} from '../src/shared/readiness'
import type {
  CompanyProfile,
  TenderRecord,
  TendersDataV2,
  TendersWorkspaceV2,
} from '../src/shared/types'

const TRUSTED_RENDERER_URL = 'http://localhost:5179/'

let testDir = ''

function makeTestDir(): string {
  const dir = join(tmpdir(), `tenders-ports-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  ;(globalThis as any).__tendersTestUserData = dir
  return dir
}

function trustedEvent(): { sender: any; senderFrame: any } {
  const sender: any = { isDestroyed: () => false, getURL: () => TRUSTED_RENDERER_URL }
  registerTendersWebContents(sender)
  return { sender, senderFrame: { url: TRUSTED_RENDERER_URL, parent: null } }
}

function company(): CompanyProfile {
  return {
    name: 'Probe Co',
    tradingName: 'Probe Co',
    registrationNumber: 'REG-1',
    vatNumber: 'VAT-1',
    taxPin: 'TAX-1',
    bbbeeLevel: 'Level 2',
    bbbeeBlackOwnership: '51%',
    csdSupplierNumber: 'CSD-1',
    founded: '2019',
    employees: '10',
    industry: 'Services',
    description: '',
    address: '',
    phone: '',
    email: '',
    website: '',
    directors: [],
    projects: [],
  }
}

function tender(overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: 'tender-1',
    title: 'Supply and Delivery of Office Computers',
    referenceNumber: 'ICT/2026/041',
    issuingBody: 'Provincial Administration Office',
    closingDate: '2026-12-18',
    submissionMethod: 'ELECTRONIC',
    submissionAddress: 'portal@example.test',
    signatureChecks: {},
    status: 'IN_PROGRESS',
    createdAt: '2026-08-01T00:00:00.000Z',
    fileName: 'rfp.pdf',
    fileUrl: 'documents/rfp.pdf',
    numPages: 3,
    ocrPages: 0,
    requirements: [],
    ...overrides,
  }
}

function documentV2(tenders: TenderRecord[]): TendersDataV2 {
  const workspace: TendersWorkspaceV2 = {
    id: 'ws-1',
    name: 'Probe Co',
    dataOrigin: 'user',
    company: company(),
    customers: [],
    vault: [],
    tenders,
  }
  return {
    schemaVersion: 2,
    revision: 4,
    updatedAt: '2026-09-01T00:00:00.000Z',
    activeCompanyId: 'ws-1',
    workspaces: [workspace],
    issuerTemplates: [],
  }
}

function writeTendersDocument(document: TendersDataV2): void {
  const dir = join(testDir, 'tenders')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tenders-data.json'), JSON.stringify(document, null, 2), 'utf8')
}

function readTendersDocument(): TendersDataV2 {
  return JSON.parse(readFileSync(join(testDir, 'tenders', 'tenders-data.json'), 'utf8'))
}

// ── 1. CRM port contract ──────────────────────────────────────────────────────

describe('CRM tender port (typed contract)', () => {
  beforeEach(() => {
    testDir = makeTestDir()
  })
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('upserts one deal with typed provenance and is idempotent on repeat', () => {
    const port = createCrmTenderPort({ userDataDir: testDir })
    const input = {
      dealId: 'deal-tender-1',
      tenderId: 'tender-1',
      tenderReference: 'ICT/2026/041',
      name: 'ICT/2026/041 - Supply and Delivery of Office Computers',
      companyName: 'Provincial Administration Office',
      amount: 115000,
      stage: 'proposal',
      expectedCloseDate: '2026-12-18',
      notes: 'Tender Ref: ICT/2026/041',
    }

    const first = port.upsertTenderOpportunity(input)
    expect(first).toEqual({ ok: true, dealId: 'deal-tender-1' })

    const second = port.upsertTenderOpportunity({ ...input, amount: 120000 })
    expect(second.ok).toBe(true)

    const deals = port.getStore().getDeals()
    expect(deals.filter((deal) => deal.id === 'deal-tender-1')).toHaveLength(1)
    expect(deals[0].amount).toBe(120000)
    expect(deals[0].tenderId).toBe('tender-1')
    expect(deals[0].tenderReference).toBe('ICT/2026/041')
    // No CRM demo records were synthesized by the Tenders port.
    expect(port.getStore().getContacts()).toHaveLength(0)
  })

  it('records won/lost outcomes as a stage change with an audit entry', () => {
    const port = createCrmTenderPort({ userDataDir: testDir })
    port.upsertTenderOpportunity({
      dealId: 'deal-tender-1',
      tenderId: 'tender-1',
      tenderReference: null,
      name: 'Opportunity',
      companyName: 'Buyer',
      amount: 5000,
      stage: 'proposal',
    })

    const won = port.updateTenderOutcome({
      dealId: 'deal-tender-1',
      tenderId: 'tender-1',
      outcome: 'won',
      noticeDate: '2026-10-01',
    })
    expect(won).toEqual({ ok: true, dealId: 'deal-tender-1' })
    expect(port.getStore().getDeals()[0].stage).toBe('won')
    expect(port.getStore().listAudit({ dealId: 'deal-tender-1' })[0].action).toBe('stage-change')

    const lost = port.updateTenderOutcome({
      dealId: 'deal-tender-1',
      tenderId: 'tender-1',
      outcome: 'withdrawn',
      reason: 'No bid submitted',
    })
    expect(lost.ok).toBe(true)
    expect(port.getStore().getDeals()[0].stage).toBe('lost')
  })

  it('refuses writes with a useful error while CRM recovery is pending', () => {
    const crmDir = join(testDir, 'crm')
    mkdirSync(crmDir, { recursive: true })
    // A quarantine file makes CRM recovery pending until it is acknowledged.
    writeFileSync(join(crmDir, 'deals.corrupt-2026-01-01T00-00-00-000Z.json'), '[]', 'utf8')

    const port = createCrmTenderPort({ userDataDir: testDir })
    const result = port.upsertTenderOpportunity({
      dealId: 'deal-tender-1',
      tenderId: 'tender-1',
      tenderReference: null,
      name: 'Opportunity',
      companyName: 'Buyer',
      amount: 1000,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/recovery/i)
  })

  it('quarantines a corrupt deals store and recovers after acknowledgement', () => {
    const crmDir = join(testDir, 'crm')
    mkdirSync(crmDir, { recursive: true })
    writeFileSync(join(crmDir, 'deals.json'), '{ not json', 'utf8')

    const port = createCrmTenderPort({ userDataDir: testDir })
    const blocked = port.upsertTenderOpportunity({
      dealId: 'deal-tender-1',
      tenderId: 'tender-1',
      tenderReference: null,
      name: 'Opportunity',
      companyName: 'Buyer',
      amount: 1000,
    })
    expect(blocked.ok).toBe(false)
    expect(port.getStore().getRecoveryState().pending).toBe(true)

    port.getStore().acknowledgeRecovery()
    const recovered = port.upsertTenderOpportunity({
      dealId: 'deal-tender-1',
      tenderId: 'tender-1',
      tenderReference: null,
      name: 'Opportunity',
      companyName: 'Buyer',
      amount: 1000,
    })
    expect(recovered.ok).toBe(true)
    expect(port.getStore().getDeals()).toHaveLength(1)
  })

  it('validates and sanitizes typed tender provenance on the CRM Deal', () => {
    const envelope = migrateAndValidateDeals([
      {
        id: 'deal-1',
        name: 'Opportunity',
        amount: 100,
        stage: 'proposal',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        tenderId: 'tender-1',
        tenderReference: 'REF-1',
      },
    ])
    expect(envelope.deals[0].tenderId).toBe('tender-1')
    expect(envelope.deals[0].tenderReference).toBe('REF-1')
    // Invalid provenance types do not survive sanitization.
    const cleaned = migrateAndValidateDeals([
      {
        id: 'deal-2',
        name: 'Opportunity',
        amount: 100,
        stage: 'proposal',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        tenderId: 42,
      } as any,
    ])
    expect(cleaned.deals[0].tenderId).toBeUndefined()
  })
})

// ── 2. Books port idempotency ─────────────────────────────────────────────────

describe('Books milestone-invoice port (typed contract)', () => {
  beforeEach(() => {
    testDir = makeTestDir()
  })
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('dedupes on the idempotency key: repeating a request posts exactly one invoice', () => {
    const port = createBooksTenderPort({ userDataDir: testDir })
    const input = {
      tenderId: 'tender-1',
      milestoneId: 'ms-01',
      idempotencyKey: 'tender-milestone-tender-1-ms-01',
      partyName: 'Provincial Administration Office',
      itemDescription: 'Phase 1 per ICT/2026/041',
      amount: 145000,
    }

    const first = port.issueMilestoneInvoice(input)
    const second = port.issueMilestoneInvoice(input)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.invoiceId).toBe(first.invoiceId)
    expect(second.invoiceNumber).toBe(first.invoiceNumber)

    const books = JSON.parse(readFileSync(port.booksDataPath, 'utf8'))
    expect(books.invoices).toHaveLength(1)
    expect(books.invoices[0].crmDealId).toBe(input.idempotencyKey)
  })

  it('rejects a non-positive amount without writing', () => {
    const port = createBooksTenderPort({ userDataDir: testDir })
    const result = port.issueMilestoneInvoice({
      tenderId: 'tender-1',
      milestoneId: 'ms-01',
      idempotencyKey: 'k',
      partyName: 'Buyer',
      itemDescription: 'x',
      amount: 0,
    })
    expect(result.ok).toBe(false)
    expect(existsSync(port.booksDataPath)).toBe(false)
  })
})

// ── 3. Readiness snapshot binding ─────────────────────────────────────────────

function apparentlyReadyInput() {
  return {
    id: 'tender-1',
    title: 'Supply and Delivery of Office Computers',
    referenceNumber: 'ICT/2026/041',
    issuingBody: 'Provincial Administration Office',
    closingDate: '2026-12-18',
    estimatedValue: 115000,
    pricingConfirmed: true,
    requirements: [
      {
        id: 'req-tax',
        title: 'Valid SARS Tax Clearance / TCS PIN',
        isMandatory: true,
        status: 'FULFILLED',
        linkedVaultDocId: 'vault-tax',
        healthStatus: 'VALID',
      },
    ],
    milestones: [{ name: 'Delivery', amount: 115000, dueDate: '2026-11-30' }],
  }
}

function readyReport(): ReadinessReport {
  return {
    checks: [],
    ready: true,
    passedCount: 0,
    failedCount: 0,
    blockingFailedCount: 0,
    score: 100,
    nextBestAction: null,
  }
}

describe('readiness snapshot binding', () => {
  beforeEach(() => {
    testDir = makeTestDir()
  })
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('binds the canonical report to tender id, revision and fingerprint', () => {
    const document = documentV2([tender()])
    const built = buildCanonicalReadinessReport(
      document,
      'tender-1',
      new Date('2026-09-01T00:00:00Z'),
    )
    expect(built.ok).toBe(true)
    expect(built.report?.binding?.tenderId).toBe('tender-1')
    expect(built.report?.binding?.revision).toBe(4)
    expect(built.report?.binding?.fingerprint).toBe(
      readinessFingerprint({
        tender: document.workspaces[0].tenders[0],
        company: company(),
        vault: [],
      }),
    )
    // A tender with an empty/unresolved matrix is NOT ready.
    expect(built.report?.ready).toBe(false)
  })

  it('requires a matching binding before ready language is permitted', () => {
    const input = apparentlyReadyInput() as any
    const binding = {
      tenderId: 'tender-1',
      revision: 4,
      fingerprint: 'abc123',
      generatedAt: '2026-09-01T00:00:00.000Z',
    }
    const ready = bindReadinessReport(readyReport(), binding)

    expect(
      generateProposalMarkdown(input, {
        readinessReport: ready,
        expectedBinding: { ...binding, required: true },
      }),
    ).toMatch(/READY FOR SUBMISSION/)
    expect(
      generateProposalMarkdown(input, {
        readinessReport: ready,
        expectedBinding: { ...binding, tenderId: 'other-tender', required: true },
      }),
    ).not.toMatch(/READY FOR SUBMISSION/)
    expect(
      generateProposalMarkdown(input, {
        readinessReport: ready,
        expectedBinding: { ...binding, revision: 5, required: true },
      }),
    ).not.toMatch(/READY FOR SUBMISSION/)
    expect(
      generateProposalMarkdown(input, {
        readinessReport: ready,
        expectedBinding: { ...binding, fingerprint: 'different', required: true },
      }),
    ).not.toMatch(/READY FOR SUBMISSION/)
    // A required binding cannot be satisfied by an unbound report.
    expect(
      generateProposalMarkdown(input, {
        readinessReport: readyReport(),
        expectedBinding: { ...binding, required: true },
      }),
    ).not.toMatch(/READY FOR SUBMISSION/)
  })

  it('keeps the historical unbound pure-helper contract', () => {
    const content = generateProposalMarkdown(apparentlyReadyInput() as any, {
      readinessReport: readyReport(),
    })
    expect(content).toMatch(/READY FOR SUBMISSION/)
  })

  it('cannot be READY when the canonical report is not ready (parity)', () => {
    const input = apparentlyReadyInput() as any
    const notReady: ReadinessReport = {
      ...readyReport(),
      ready: false,
      checks: [
        {
          id: 'requirements',
          label: 'Canonical matrix unresolved',
          detail: 'x',
          passed: false,
          blocking: true,
        },
      ],
      failedCount: 1,
      blockingFailedCount: 1,
    }
    const binding = {
      tenderId: 'tender-1',
      revision: 4,
      fingerprint: 'abc123',
      generatedAt: '2026-09-01T00:00:00.000Z',
    }
    const content = generateProposalMarkdown(input, {
      readinessReport: bindReadinessReport(notReady, binding),
      expectedBinding: { ...binding, required: true },
    })
    expect(content).not.toMatch(/READY FOR SUBMISSION/)
    expect(content).toMatch(/DRAFT — SUBMISSION BLOCKED|READINESS NOT INDEPENDENTLY VERIFIED/)
  })
})

// ── 4. IPC integration behaviour (races + disabled + parity) ───────────────────

describe('Tenders integration IPC (ports, races, disabled)', () => {
  beforeEach(() => {
    testDir = makeTestDir()
    resetTendersIpcForTests()
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
    })
    registerTendersIpc()
  })
  afterEach(() => {
    resetTendersIpcForTests()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('syncWithCrm conflict leaves no CRM deal (tender revision resolved first)', async () => {
    const crmPort = createCrmTenderPort({ userDataDir: testDir })
    const upsert = vi.fn((input: any) => crmPort.upsertTenderOpportunity(input))
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
      integrations: { upsertTenderOpportunity: upsert },
    })
    writeTendersDocument(documentV2([tender()]))

    const handler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
    const result = await handler!(trustedEvent(), {
      tenderId: 'tender-1',
      expectedRevision: 3, // document is at revision 4
    })

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toMatch(/conflict|revision/i)
    expect(upsert).not.toHaveBeenCalled()
    expect(existsSync(join(testDir, 'crm', 'deals.json'))).toBe(false)
    expect(readTendersDocument().revision).toBe(4)
  })

  it('syncWithCrm links the tender and upserts one CRM deal through the port', async () => {
    const crmPort = createCrmTenderPort({ userDataDir: testDir })
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
      integrations: { upsertTenderOpportunity: (input) => crmPort.upsertTenderOpportunity(input) },
    })
    writeTendersDocument(documentV2([tender()]))

    const handler = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
    const result = await handler!(trustedEvent(), { tenderId: 'tender-1' })

    expect(result.ok).toBe(true)
    expect(result.dealId).toBe('deal-tender-tender-1')
    expect(readTendersDocument().workspaces[0].tenders[0].linkedCrmDealId).toBe(
      'deal-tender-tender-1',
    )
    expect(crmPort.getStore().getDeals()).toHaveLength(1)
  })

  it('runs with integrations disabled: typed error, no side effects', async () => {
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
      integrations: {},
    })
    writeTendersDocument(documentV2([tender()]))

    const sync = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
    const bill = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
    const syncResult = await sync!(trustedEvent(), { tenderId: 'tender-1' })
    const billResult = await bill!(trustedEvent(), 'tender-1', 'ms-01')

    expect(syncResult.ok).toBe(false)
    expect(syncResult.error).toMatch(/not configured/i)
    expect(billResult.ok).toBe(false)
    expect(billResult.error).toMatch(/not configured/i)
    expect(existsSync(join(testDir, 'crm', 'deals.json'))).toBe(false)
    expect(existsSync(join(testDir, 'books', 'books-data.json'))).toBe(false)
    expect(readTendersDocument().workspaces[0].tenders[0].linkedCrmDealId ?? null).toBeNull()
  })

  it('billing reconciles a previously posted invoice without double-posting', async () => {
    const booksPort = createBooksTenderPort({ userDataDir: testDir })
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
      integrations: { issueMilestoneInvoice: (input) => booksPort.issueMilestoneInvoice(input) },
    })
    const withMilestone = tender({
      status: 'WON',
      milestones: [
        {
          id: 'ms-01',
          name: 'Phase 1',
          title: 'Phase 1',
          amount: 145000,
          status: 'REACHED',
          dueDate: '2026-08-30',
        },
      ],
    })
    writeTendersDocument(documentV2([withMilestone]))

    // Simulate a crash between posting and the tender commit: the invoice
    // exists in Books under the idempotency key, but the milestone is REACHED.
    const prePosted = booksPort.issueMilestoneInvoice({
      tenderId: 'tender-1',
      milestoneId: 'ms-01',
      idempotencyKey: 'tender-milestone-tender-1-ms-01',
      partyName: 'Provincial Administration Office',
      itemDescription: 'Phase 1 per ICT/2026/041',
      amount: 145000,
    })
    expect(prePosted.ok).toBe(true)

    const handler = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
    const result = await handler!(trustedEvent(), 'tender-1', 'ms-01')
    expect(result.ok).toBe(true)
    expect(result.invoiceId).toBe(prePosted.invoiceId)

    const books = JSON.parse(readFileSync(booksPort.booksDataPath, 'utf8'))
    expect(books.invoices).toHaveLength(1)
    const milestone = readTendersDocument().workspaces[0].tenders[0].milestones?.find(
      (candidate) => candidate.id === 'ms-01',
    )
    expect(milestone?.status).toBe('BILLED')

    // A second call is idempotent: no new invoice, reconciled success.
    const again = await handler!(trustedEvent(), 'tender-1', 'ms-01')
    expect(again.ok).toBe(true)
    expect(again.reconciled).toBe(true)
    expect(JSON.parse(readFileSync(booksPort.booksDataPath, 'utf8')).invoices).toHaveLength(1)
  })

  it('refuses milestone billing for a tender that is not won (main-side gate, no side effects)', async () => {
    const booksPort = createBooksTenderPort({ userDataDir: testDir })
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
      integrations: { issueMilestoneInvoice: (input) => booksPort.issueMilestoneInvoice(input) },
    })
    writeTendersDocument(
      documentV2([
        tender({
          status: 'IN_PROGRESS',
          milestones: [
            {
              id: 'ms-01',
              name: 'Phase 1',
              title: 'Phase 1',
              amount: 145000,
              status: 'REACHED',
              dueDate: '2026-08-30',
            },
          ],
        }),
      ]),
    )

    const handler = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
    const result = await handler!(trustedEvent(), 'tender-1', 'ms-01')

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/only allowed for a won tender/i)
    expect(existsSync(join(testDir, 'books', 'books-data.json'))).toBe(false)
    expect(readTendersDocument().revision).toBe(4)
    expect(readTendersDocument().workspaces[0].tenders[0].milestones?.[0].status).toBe('REACHED')
  })

  it('refuses CRM sync and Books billing from a demo workspace (main-side isolation)', async () => {
    const crmPort = createCrmTenderPort({ userDataDir: testDir })
    const booksPort = createBooksTenderPort({ userDataDir: testDir })
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
      integrations: {
        upsertTenderOpportunity: (input) => crmPort.upsertTenderOpportunity(input),
        issueMilestoneInvoice: (input) => booksPort.issueMilestoneInvoice(input),
      },
    })
    const demo = documentV2([
      tender({
        status: 'WON',
        milestones: [
          {
            id: 'ms-01',
            name: 'Phase 1',
            title: 'Phase 1',
            amount: 145000,
            status: 'REACHED',
            dueDate: '2026-08-30',
          },
        ],
      }),
    ])
    demo.workspaces[0].dataOrigin = 'demo'
    writeTendersDocument(demo)

    const sync = ipcHandlers.get(TENDERS_CHANNELS.syncWithCrm)
    const syncResult = await sync!(trustedEvent(), { tenderId: 'tender-1' })
    expect(syncResult.ok).toBe(false)
    expect(syncResult.error).toMatch(/demo workspace/i)

    const bill = ipcHandlers.get(TENDERS_CHANNELS.billMilestoneInBooks)
    const billResult = await bill!(trustedEvent(), 'tender-1', 'ms-01')
    expect(billResult.ok).toBe(false)
    expect(billResult.error).toMatch(/demo workspace/i)

    expect(existsSync(join(testDir, 'crm', 'deals.json'))).toBe(false)
    expect(existsSync(join(testDir, 'books', 'books-data.json'))).toBe(false)
    const onDisk = readTendersDocument()
    expect(onDisk.revision).toBe(4)
    expect(onDisk.workspaces[0].tenders[0].linkedCrmDealId ?? null).toBeNull()
    expect(onDisk.workspaces[0].tenders[0].milestones?.[0].status).toBe('REACHED')
  })

  it('draftProposalDoc cannot emit READY from a renderer-only claim (canonical parity)', async () => {
    configureTendersRuntime({
      preloadPath: '',
      rendererUrl: TRUSTED_RENDERER_URL,
      rendererFile: '',
      openGeneratedPath: () => true,
    })
    writeTendersDocument(documentV2([tender()])) // empty matrix ⇒ not ready

    const handler = ipcHandlers.get(TENDERS_CHANNELS.draftProposalDoc)
    const result = await handler!(trustedEvent(), {
      ...apparentlyReadyInput(),
      readinessReport: readyReport(), // forged by the renderer
      ready: true,
    })
    expect(result.ok).toBe(true)
    const content = readFileSync(result.path, 'utf8')
    expect(content).not.toMatch(/READY FOR SUBMISSION/)
    expect(content).toMatch(/DRAFT/)
  })
})

// ── 5. Static ownership check ─────────────────────────────────────────────────

describe('CRM file ownership', () => {
  it('no Tenders source module reads or writes crm/deals.json', () => {
    const root = join(process.cwd(), 'src')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        if (readFileSync(full, 'utf8').includes('deals.json')) {
          offenders.push(relative(root, full).split(sep).join('/'))
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})

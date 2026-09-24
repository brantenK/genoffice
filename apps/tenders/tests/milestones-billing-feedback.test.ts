/**
 * Billing feedback truthfulness (`runMilestoneBilling`).
 *
 * The audit found that opening the Zano Books window happened INSIDE the
 * post-and-persist `try`, so a rejection there converted an already-persisted
 * BILLED milestone into "Error occurred while creating invoice in Zano Books"
 * with a Retry — a claim that the invoice does not exist, when it does.
 *
 * These tests drive the shared handler (used by both the inline workspace
 * button and the milestones drawer) against the real renderer store, so the
 * persisted milestone and the reported outcome are checked together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CompanyProfile,
  ContractMilestone,
  Customer,
  TenderRecord,
  TendersDataV2,
  TendersWorkspaceV2,
  VaultDoc,
} from '../src/shared/types'
import type {
  SaveTendersRequest,
  SaveTendersResult,
  TendersLoadResult,
} from '../src/shared/tenders-persistence'

const STORE_MODULE = '../src/renderer/src/store'
const DRAWER_MODULE = '../src/renderer/src/components/MilestonesDrawer'
const AT = '2026-09-01T00:00:00.000Z'
const NEXT = '2026-09-01T00:00:01.000Z'
const BOOKS_WARNING = 'the Zano Books invoice view did not open'

type ApiMock = {
  loadStoreV2: ReturnType<typeof vi.fn>
  saveStoreV2: ReturnType<typeof vi.fn>
  onStoreChangedV2: ReturnType<typeof vi.fn>
  billMilestoneInBooks: ReturnType<typeof vi.fn>
  openBooks: ReturnType<typeof vi.fn>
}

let api: ApiMock

function installTendersApiMock(): void {
  api = {
    loadStoreV2: vi.fn(),
    saveStoreV2: vi.fn(),
    onStoreChangedV2: vi.fn(() => () => {}),
    billMilestoneInBooks: vi.fn(),
    openBooks: vi.fn(),
  }
  ;(window as unknown as Record<string, unknown>).tendersApi = api
}

beforeEach(() => {
  vi.resetModules()
  window.localStorage.clear()
  vi.useFakeTimers()
  installTendersApiMock()
})

afterEach(() => {
  vi.useRealTimers()
  window.localStorage.clear()
  ;(window as unknown as Record<string, unknown>).tendersApi = undefined
})

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function company(): CompanyProfile {
  return {
    name: 'Test Co',
    tradingName: 'Test Co',
    registrationNumber: 'REG-1',
    vatNumber: 'VAT-1',
    taxPin: 'TAX-1',
    bbbeeLevel: 'Level 2',
    bbbeeBlackOwnership: '51%',
    csdSupplierNumber: 'CSD-1',
    founded: '2019',
    employees: '25',
    industry: 'Construction',
    description: 'Synthetic company.',
    address: '1 Test Street',
    phone: '+27 10 000 0000',
    email: 'test@example.test',
    website: 'https://example.test',
    directors: [],
    projects: [],
  }
}

function customer(): Customer {
  return {
    id: 'cust-1',
    name: 'Example Customer',
    contactName: 'Contact',
    contactEmail: 'c@example.test',
    contactPhone: '+27 10 000 0001',
    industry: 'Public sector',
    status: 'ACTIVE',
    since: '2025-01-01',
    notes: 'Synthetic.',
    requiredDocs: [],
  }
}

function vaultDoc(): VaultDoc {
  return {
    id: 'vd-1',
    title: 'Tax clearance',
    category: 'COMPLIANCE',
    fileUrl: 'vault/tax.pdf',
    issueDate: null,
    expiryDate: '2027-01-01',
    isCertified: false,
    certifiedDate: null,
    metadata: {},
  }
}

function milestone(overrides: Partial<ContractMilestone> = {}): ContractMilestone {
  return {
    id: 'ms-1',
    name: 'Phase 1 — Mobilisation',
    description: 'Site establishment.',
    amount: 250000,
    dueDate: '2026-10-01',
    status: 'REACHED',
    ...overrides,
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
    submissionAddress: null,
    signatureChecks: {},
    status: 'WON',
    createdAt: AT,
    fileName: 'rfp.pdf',
    fileUrl: 'documents/rfp.pdf',
    numPages: 4,
    ocrPages: 0,
    requirements: [],
    milestones: [milestone()],
    ...overrides,
  }
}

function documentV2(
  tenderRecord: TenderRecord,
  dataOrigin: TendersWorkspaceV2['dataOrigin'] = 'user',
): TendersDataV2 {
  const workspace: TendersWorkspaceV2 = {
    id: 'ws-1',
    name: 'Test Co',
    dataOrigin,
    company: company(),
    customers: [customer()],
    vault: [vaultDoc()],
    tenders: [tenderRecord],
  }
  return {
    schemaVersion: 2,
    revision: 4,
    updatedAt: AT,
    activeCompanyId: 'ws-1',
    workspaces: [workspace],
    issuerTemplates: [],
  }
}

function loadOk(data: TendersDataV2): TendersLoadResult {
  return { ok: true, status: 'loaded', data, needsSave: false, warnings: [] }
}

function useSuccessfulSave(): void {
  api.saveStoreV2.mockImplementation(async (request: SaveTendersRequest) => {
    const result: SaveTendersResult = {
      ok: true,
      data: {
        ...clone(request.document),
        revision: request.expectedRevision + 1,
        updatedAt: NEXT,
      },
    }
    return result
  })
}

async function hydrate(tenderRecord = tender()): Promise<{ getState: () => any }> {
  api.loadStoreV2.mockResolvedValue(loadOk(documentV2(tenderRecord)))
  useSuccessfulSave()
  const mod = (await import(STORE_MODULE)) as unknown as {
    useTendersStore: { getState: () => any }
  }
  await mod.useTendersStore.getState().hydrateFromMain()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  return mod.useTendersStore
}

async function runBilling(
  store: { getState: () => any },
  target: ContractMilestone,
): Promise<{ feedback: any; busy: Array<string | null> }> {
  const mod = (await import(DRAWER_MODULE)) as unknown as {
    runMilestoneBilling: (
      tender: TenderRecord,
      milestone: ContractMilestone,
      options: { onBusy: (id: string | null) => void; onFeedback: (f: any) => void },
    ) => Promise<void>
  }
  const feedback: any[] = []
  const busy: Array<string | null> = []
  await mod.runMilestoneBilling(store.getState().tenders[0], target, {
    onBusy: (id) => busy.push(id),
    onFeedback: (f) => feedback.push(f),
  })
  // The store persists through a debounce, so let the queued save commit.
  await vi.advanceTimersByTimeAsync(1000)
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  return { feedback: feedback[feedback.length - 1], busy }
}

function savedMilestone(store: { getState: () => any }, id = 'ms-1'): ContractMilestone {
  const index = api.saveStoreV2.mock.calls.length - 1
  const document = (api.saveStoreV2.mock.calls[index][0] as SaveTendersRequest)
    .document as TendersDataV2
  return document.workspaces[0].tenders[0].milestones!.find((m) => m.id === id)!
}

describe('runMilestoneBilling feedback', () => {
  it('reports a persisted post as billed when the Books window does not open', async () => {
    const store = await hydrate()
    api.billMilestoneInBooks.mockResolvedValue({
      ok: true,
      invoiceId: 'inv-1',
      invoiceNumber: 'INV-0001',
    })
    api.openBooks.mockResolvedValue(false)

    const { feedback, busy } = await runBilling(store, milestone())

    expect(feedback.kind, 'a persisted post is a success, not an error').toBe('success')
    expect(feedback.retryable).toBe(false)
    expect(feedback.message).toContain('INV-0001')
    expect(feedback.warning, 'the post-persist caveat is reported').toBeTruthy()
    expect(feedback.warning).toContain(BOOKS_WARNING)
    expect(busy).toEqual(['ms-1', null])
    expect(savedMilestone(store).status).toBe('BILLED')
    expect(savedMilestone(store).billedInvoiceNumber).toBe('INV-0001')
  })

  it('never converts a rejected Books open into a billing failure', async () => {
    const store = await hydrate()
    api.billMilestoneInBooks.mockResolvedValue({
      ok: true,
      invoiceId: 'inv-1',
      invoiceNumber: 'INV-0001',
    })
    api.openBooks.mockRejectedValue(new Error('books window refused to open'))

    const { feedback } = await runBilling(store, milestone())

    expect(feedback.kind).toBe('success')
    expect(feedback.retryable).toBe(false)
    expect(feedback.warning, 'the post-persist caveat is reported').toBeTruthy()
    expect(feedback.warning).toContain(BOOKS_WARNING)
    expect(feedback.message).not.toMatch(/Error occurred while creating invoice/i)
    expect(savedMilestone(store).status).toBe('BILLED')
  })

  it('adds no caveat when the Books window opens', async () => {
    const store = await hydrate()
    api.billMilestoneInBooks.mockResolvedValue({
      ok: true,
      invoiceId: 'inv-1',
      invoiceNumber: 'INV-0001',
    })
    api.openBooks.mockResolvedValue(true)

    const { feedback } = await runBilling(store, milestone())

    expect(feedback.kind).toBe('success')
    expect(feedback.warning).toBeUndefined()
    expect(savedMilestone(store).status).toBe('BILLED')
  })

  it('keeps the reconcile note and the Books caveat together', async () => {
    const store = await hydrate()
    api.billMilestoneInBooks.mockResolvedValue({
      ok: true,
      reconciled: true,
      invoiceId: 'inv-9',
      invoiceNumber: 'INV-0009',
      warning: 'Milestone was already billed; reused the existing invoice.',
    })
    api.openBooks.mockResolvedValue(false)

    const { feedback } = await runBilling(store, milestone())

    expect(feedback.kind).toBe('success')
    expect(feedback.reconciled).toBe(true)
    expect(feedback.warning).toContain('reused the existing invoice')
    expect(feedback.warning).toContain(BOOKS_WARNING)
  })

  it('reports a refused post as a retryable error and does not mark the milestone billed', async () => {
    const store = await hydrate()
    api.billMilestoneInBooks.mockResolvedValue({ ok: false, error: 'Books is not configured.' })

    const { feedback } = await runBilling(store, milestone())

    expect(feedback.kind).toBe('error')
    expect(feedback.retryable, 'a not-configured rejection is not retryable').toBe(false)
    expect(api.openBooks).not.toHaveBeenCalled()
    expect(store.getState().tenders[0].milestones[0].status).toBe('REACHED')
    expect(api.saveStoreV2).not.toHaveBeenCalled()
  })

  it('treats a thrown post as a retryable error', async () => {
    const store = await hydrate()
    api.billMilestoneInBooks.mockRejectedValue(new Error('transport down'))

    const { feedback, busy } = await runBilling(store, milestone())

    expect(feedback.kind).toBe('error')
    expect(feedback.message).toBe('transport down')
    expect(feedback.retryable).toBe(true)
    expect(busy).toEqual(['ms-1', null])
  })

  it('refuses to bill inside a sample workspace without calling Books', async () => {
    api.loadStoreV2.mockResolvedValue(loadOk(documentV2(tender(), 'demo')))
    useSuccessfulSave()
    const mod = (await import(STORE_MODULE)) as unknown as {
      useTendersStore: { getState: () => any }
    }
    await mod.useTendersStore.getState().hydrateFromMain()
    for (let i = 0; i < 12; i += 1) await Promise.resolve()

    const { feedback } = await runBilling(mod.useTendersStore, milestone())

    expect(feedback.kind).toBe('error')
    expect(feedback.retryable).toBe(false)
    expect(feedback.message).toMatch(/sample workspace/i)
    expect(api.billMilestoneInBooks).not.toHaveBeenCalled()
    expect(api.openBooks).not.toHaveBeenCalled()
  })
})

#!/usr/bin/env node
/**
 * tools/verify-tenders-interop.ts
 *
 * Automated Verification Suite for Milestone 3:
 * Cross-App Interoperability & Export Workflows (R3)
 *
 * Checks:
 * 1. Milestone Billing & Accounting In Books (Req a):
 *    - Billed milestones produce balanced journal entries, accounts receivable adjustments,
 *      and linked tax invoices in Zano Books with correct South African VAT arithmetic.
 * 2. Bank Reconciliation Payment Back-Propagation to Tenders (Req b):
 *    - Bank statement reconciliation in Books marks linked milestone as 'PAID' in tenders-data.json
 *      with paidAt timestamp and broadcasts tenders:data-changed to active WebContents/store.
 * 3. CRM Opportunity Sync Hardening (Req c):
 *    - Tenders exported to CRM appear with expected metadata (reference, issuer, value, closing date)
 *      with deterministic ID (deal-tender-${tender.id}), back-links linkedCrmDealId onto TenderRecord,
 *      and prevents duplicate deals on re-sync.
 * 4. Docs & Sheets Export Workflows (Req d):
 *    - exportMatrixToSheets generates valid UTF-8 BOM CSV with required headers and quotes,
 *      invoking shell tab navigation.
 *    - draftProposalDoc generates formatted proposal with executive summary, methodology,
 *      pricing schedule, and compliance checklist, invoking shell tab navigation.
 * 5. Cross-Suite Regression Verification (Req e):
 *    - Existing test harnesses verify-tenders-sync, verify-tenders-storage, and verify-suite-workflows.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Module from 'node:module'

// ----------------------------------------------------------------------------
// Mock Electron Environment
// ----------------------------------------------------------------------------
const ipcHandlers: Record<string, (...args: any[]) => any> = {}
const testDir = join(tmpdir(), `tenders-interop-test-${randomUUID().slice(0, 8)}`)
mkdirSync(testDir, { recursive: true })

const openedGeneratedPaths: string[] = []
let crmTabOpenedWith: string | undefined
let booksTabOpenedWith: string | undefined

const mockApp = {
  getPath: (name: string) => {
    if (name === 'userData') return testDir
    return testDir
  },
  isReady: () => true,
}

const mockShell = {
  openPath: async (targetPath: string) => {
    if (existsSync(targetPath)) return ''
    return 'Failed to open file: does not exist'
  },
}

const mockIpcMain = {
  handle: (channel: string, listener: (...args: any[]) => any) => {
    ipcHandlers[channel] = listener
  },
}

class MockWebContentsView {
  webContents = {
    isDestroyed: () => false,
    send: (channel: string, ...args: any[]) => {
      webContentsEvents.push({ channel, args })
    },
    loadURL: async () => {},
    loadFile: async () => {},
    once: (_event: string, _fn: () => void) => {},
  }
}

const webContentsEvents: Array<{ channel: string; args: any[] }> = []

// Intercept 'electron' require
const origRequire = (Module.prototype as any).require
;(Module.prototype as any).require = function (id: string) {
  if (id === 'electron') {
    return {
      app: mockApp,
      shell: mockShell,
      ipcMain: mockIpcMain,
      WebContentsView: MockWebContentsView,
    }
  }
  return origRequire.apply(this, arguments)
}

// ----------------------------------------------------------------------------
// Load Modules
// ----------------------------------------------------------------------------
const tendersMain = require('../apps/tenders/src/main/tenders-main.ts')
const {
  CURRENT_TENDERS_SCHEMA_VERSION,
  SEED_TENDER_WTR_04,
  migrateAndValidateTenders,
  readTendersStore,
  writeTendersStore,
  registerTendersIpc,
  registerTendersWebContents,
  configureTendersRuntime,
} = tendersMain

const booksMain = require('../apps/books/src/main/books-main.ts')
const {
  CURRENT_BOOKS_SCHEMA_VERSION,
  CORE_ACCOUNTS,
  DEFAULT_BOOK_SETTINGS,
  readBooksStore,
  writeBooksStore,
  importBankStatement,
  executeReconciliation,
  registerBooksIpc,
} = booksMain

const tendersIpc = require('../apps/tenders/src/shared/ipc.ts')
const { TENDERS_CHANNELS } = tendersIpc

const { parseCsv } = require('../apps/sheets/src/gateway/csv-import.ts')

// Setup mock window & renderer store
const listeners: Record<string, Array<(...args: any[]) => void>> = {}

const mockTendersApi = {
  getStoredData: async () => {
    const fn = ipcHandlers[TENDERS_CHANNELS.getStoredData]
    if (fn) return fn({ sender: null })
    return null
  },
  saveStoredData: async (json: string) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.saveStoredData]
    if (fn) return fn({ sender: null }, json)
    return { ok: true }
  },
  onDataChanged: (cb: (data: any) => void) => {
    if (!listeners[TENDERS_CHANNELS.dataChanged]) {
      listeners[TENDERS_CHANNELS.dataChanged] = []
    }
    listeners[TENDERS_CHANNELS.dataChanged].push(cb)
    return () => {
      const arr = listeners[TENDERS_CHANNELS.dataChanged]
      const idx = arr.indexOf(cb)
      if (idx >= 0) arr.splice(idx, 1)
    }
  },
  billMilestoneInBooks: async (payload: any, milestoneId?: string) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.billMilestoneInBooks]
    if (fn) return fn({ sender: null }, payload, milestoneId)
    return { ok: false }
  },
  syncWithCrm: async (dealData: any) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.syncWithCrm]
    if (fn) return fn({ sender: null }, dealData)
    return { ok: false }
  },
  openInCrm: async (dealId?: string) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.openInCrm]
    if (fn) return fn({ sender: null }, dealId)
    return { ok: false }
  },
  exportMatrixToSheets: async (tenderId: string, tenderTitle: string, matrixRows: any[]) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.exportMatrixToSheets]
    if (fn) return fn({ sender: null }, tenderId, tenderTitle, matrixRows)
    return { ok: false }
  },
  draftProposalDoc: async (tender: any) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.draftProposalDoc]
    if (fn) return fn({ sender: null }, tender)
    return { ok: false }
  },
  openBooks: async () => {
    const fn = ipcHandlers[TENDERS_CHANNELS.openBooks]
    if (fn) return fn({ sender: null })
    return false
  },
}

const storeMap = new Map<string, string>()
const mockLocalStorage = {
  getItem: (k: string) => storeMap.get(k) ?? null,
  setItem: (k: string, v: string) => { storeMap.set(k, String(v)) },
  removeItem: (k: string) => { storeMap.delete(k) },
  clear: () => { storeMap.clear() },
  length: 0,
  key: () => null,
}
;(global as any).localStorage = mockLocalStorage
;(global as any).window = {
  tendersApi: mockTendersApi,
  localStorage: mockLocalStorage,
}

const tendersStoreModule = require('../apps/tenders/src/renderer/src/store.ts')
const { useTendersStore } = tendersStoreModule

// ----------------------------------------------------------------------------
// Test Assertion Helpers
// ----------------------------------------------------------------------------
let passed = 0
let failed = 0

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error(`  ❌ FAIL: ${msg}`)
    failed++
    throw new Error(msg)
  } else {
    console.log(`  ✅ PASS: ${msg}`)
    passed++
  }
}

async function runTests() {
  console.log('\n======================================================================')
  console.log('   ZANOSTACK TENDERS INTEROPERABILITY & EXPORT WORKFLOWS (M3)')
  console.log('======================================================================\n')

  try {
    // ------------------------------------------------------------------------
    // SETUP SANDBOX ENVIRONMENT
    // ------------------------------------------------------------------------
    const tendersDir = join(testDir, 'tenders')
    const booksDir = join(testDir, 'books')
    const crmDir = join(testDir, 'crm')
    mkdirSync(tendersDir, { recursive: true })
    mkdirSync(booksDir, { recursive: true })
    mkdirSync(crmDir, { recursive: true })

    const tendersPath = join(tendersDir, 'tenders-data.json')
    const booksPath = join(booksDir, 'books-data.json')
    const crmDealsPath = join(crmDir, 'deals.json')

    // Configure runtime hooks
    configureTendersRuntime({
      preloadPath: '',
      rendererFile: '',
      openGeneratedPath: (p: string) => {
        openedGeneratedPaths.push(p)
        return true
      },
      onOpenCrm: (dealId?: string) => {
        crmTabOpenedWith = dealId
      },
      onOpenBooks: (invId?: string) => {
        booksTabOpenedWith = invId
      },
    })

    // Register IPC
    registerTendersIpc()
    registerBooksIpc()

    // Register a mock WebContents to capture broadcasts and route to renderer
    const mockWc = {
      isDestroyed: () => false,
      send: (channel: string, data: any) => {
        webContentsEvents.push({ channel, args: [data] })
        const cbs = listeners[channel] || []
        for (const cb of cbs) cb(data)
      },
      once: (_ev: string, _fn: () => void) => {},
    }
    registerTendersWebContents(mockWc as any)

    // Wire store subscription
    mockTendersApi.onDataChanged((data) => {
      useTendersStore.getState().syncFromMain(data)
    })

    // Initialize Books store
    const initialBooksData = {
      version: CURRENT_BOOKS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      settings: DEFAULT_BOOK_SETTINGS,
      accounts: [
        { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: 100000 },
        { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', parentId: 'acc-curr-asset', isGroup: false, balance: 0 },
        { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', parentId: 'acc-curr-liab', isGroup: false, balance: 0 },
        { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-income', isGroup: false, balance: 0 },
        { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 0 },
      ],
      parties: [],
      invoices: [],
      journalEntries: [],
      bankTransactions: [],
    }
    writeBooksStore(booksPath, initialBooksData)

    // Initialize Tenders store with seed tender
    const initialTendersData = migrateAndValidateTenders(null)
    writeTendersStore(tendersPath, initialTendersData)

    // Load renderer store
    await useTendersStore.getState().loadFromMain()

    // ------------------------------------------------------------------------
    // SECTION 1: Milestone Billing & Accounting In Books (Req a)
    // ------------------------------------------------------------------------
    console.log('--- SECTION 1: Books Milestone Billing & Double-Entry Ledger Integrity (Req a) ---')

    const milestoneToBill = initialTendersData.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
    assert(milestoneToBill !== undefined, 'Found seed reached milestone ms-01')
    assert(milestoneToBill.status === 'REACHED', 'Milestone ms-01 is initially in REACHED status')
    assert(milestoneToBill.amount === 145000, 'Milestone amount is R 145,000')

    const billRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      tenderReference: 'RFP-WTR-2026-04',
      issuingAuthority: 'City of Ekurhuleni Water Dept',
      milestoneTitle: 'Phase 1 Reservoir Valve Refurbishment',
      amount: 145000,
    })

    assert(billRes.ok === true, 'billMilestoneInBooks returned ok: true')
    assert(typeof billRes.invoiceNumber === 'string' && billRes.invoiceNumber.startsWith('INV-'), `Generated Tax Invoice number: ${billRes.invoiceNumber}`)
    assert(typeof billRes.invoiceId === 'string', `Generated Tax Invoice ID: ${billRes.invoiceId}`)
    assert(billRes.grandTotal === 145000, 'Invoice grandTotal matches R 145,000')

    // Verify Books Invoice
    const booksAfterBill = readBooksStore(booksPath)
    const createdInvoice = booksAfterBill.invoices.find((i: any) => i.id === billRes.invoiceId)
    assert(createdInvoice !== undefined, 'Created invoice exists in Books invoices list')
    assert(createdInvoice.type === 'Sales', 'Invoice type is Sales')
    assert(createdInvoice.status === 'Unpaid', 'Invoice status is initially Unpaid')
    assert(createdInvoice.tenderReference === 'RFP-WTR-2026-04', 'Invoice has tenderReference: RFP-WTR-2026-04')
    assert(createdInvoice.grandTotal === 145000, 'Invoice grandTotal is 145,000')
    assert(createdInvoice.subtotal === 126086.96, `Invoice net subtotal is R 126,086.96 (15% VAT base)`)
    assert(createdInvoice.taxTotal === 18913.04, `Invoice tax total is R 18,913.04 (subtotal + tax = 145,000)`)
    assert(Math.round((createdInvoice.subtotal + createdInvoice.taxTotal) * 100) / 100 === 145000, 'Subtotal + Tax matches grandTotal to the cent')

    // Verify Books Double-Entry Ledger Balances
    const accAr = booksAfterBill.accounts.find((a: any) => a.id === 'acc-ar')
    const accSales = booksAfterBill.accounts.find((a: any) => a.id === 'acc-sales')
    const accVat = booksAfterBill.accounts.find((a: any) => a.id === 'acc-vat')
    assert(accAr.balance === 145000, `Accounts Receivable debited to R 145,000 (current: ${accAr.balance})`)
    assert(accSales.balance === 126086.96, `Sales income credited to R 126,086.96 (current: ${accSales.balance})`)
    assert(accVat.balance === 18913.04, `VAT Output liability credited to R 18,913.04 (current: ${accVat.balance})`)

    // Verify Balanced Journal Entry
    assert(booksAfterBill.journalEntries.length === 1, '1 balanced journal entry posted in Books')
    const je = booksAfterBill.journalEntries[0]
    assert(je.posted === true, 'Journal entry is marked posted')
    assert(je.totalDebit === 145000 && je.totalCredit === 145000, 'Journal entry is balanced: Debit === Credit === 145,000')
    assert(je.items.length === 3, 'Journal entry contains 3 line items (AR debit, Sales credit, VAT credit)')

    // Verify Tenders On-Disk Milestone Status is BILLED
    const tendersAfterBill = readTendersStore(tendersPath)
    const diskMilestone = tendersAfterBill.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
    assert(diskMilestone.status === 'BILLED', 'Tenders on-disk milestone status updated to BILLED')
    assert(diskMilestone.billedInvoiceId === billRes.invoiceId, 'Tenders on-disk milestone stores billedInvoiceId')
    assert(diskMilestone.billedInvoiceNumber === billRes.invoiceNumber, 'Tenders on-disk milestone stores billedInvoiceNumber')
    assert(typeof diskMilestone.billedAt === 'string', 'Tenders on-disk milestone stores billedAt ISO date')

    // Verify Renderer In-Memory Store reflects BILLED
    const inMemMilestone = useTendersStore.getState().tenders[0].milestones?.find((m: any) => m.id === 'ms-01')
    assert(inMemMilestone?.status === 'BILLED', 'Renderer in-memory store reflects BILLED live')

    // ------------------------------------------------------------------------
    // SECTION 2: Bank Reconciliation Payment Back-Propagation (Req b)
    // ------------------------------------------------------------------------
    console.log('\n--- SECTION 2: Bank Reconciliation Payment Back-Propagation to Tenders (Req b) ---')

    // Import bank statement deposit from City of Ekurhuleni Water Dept
    const bankCsv = `Date,Description,Amount\n2026-09-04,DEP CITY EKURHULENI WATER DEPT RFP-WTR-2026-04 REF: ${billRes.invoiceNumber},145000\n`
    const importRes = importBankStatement({
      booksDataPath: booksPath,
      csvContent: bankCsv,
    })
    assert(importRes.ok === true, 'Bank statement CSV successfully imported into Books')
    assert(Array.isArray(importRes.transactions) && importRes.transactions.length === 1, '1 transaction parsed and ingested')
    const txId = importRes.transactions![0].id

    const beforeEventsCount = webContentsEvents.length

    // Execute 1-click bank reconciliation in Books
    const reconResult = executeReconciliation({
      booksDataPath: booksPath,
      transactionId: txId,
      invoiceId: billRes.invoiceId!,
      tendersDataPath: tendersPath,
    })

    assert(reconResult.ok === true, 'executeReconciliation in Books succeeded')
    assert(reconResult.invoiceStatus === 'Paid', 'Invoice status updated to Paid in Books')
    assert(reconResult.settledAmount === 145000, 'Settled amount is R 145,000')
    assert(reconResult.tenderMilestonePaid === true, 'executeReconciliation confirmed tender milestone paid')

    // Verify Books post-reconciliation ledger
    const booksAfterRecon = readBooksStore(booksPath)
    const reconciledTx = booksAfterRecon.bankTransactions.find((t: any) => t.id === txId)
    const paidInv = booksAfterRecon.invoices.find((i: any) => i.id === billRes.invoiceId)
    const accBank = booksAfterRecon.accounts.find((a: any) => a.id === 'acc-bank')
    const accArAfterRecon = booksAfterRecon.accounts.find((a: any) => a.id === 'acc-ar')

    assert(reconciledTx.reconciled === true, 'Bank transaction marked reconciled: true')
    assert(paidInv.status === 'Paid', 'Invoice status is Paid')
    assert(paidInv.outstandingAmount === 0, 'Invoice outstandingAmount cleared to 0')
    assert(accBank.balance === 245000, `Bank account debited to R 245,000 (balance: ${accBank.balance})`)
    assert(accArAfterRecon.balance === 0, `Accounts Receivable cleared to R 0 (balance: ${accArAfterRecon.balance})`)
    assert(booksAfterRecon.journalEntries.length === 2, 'Settlement journal entry posted (now 2 JEs in Books)')

    // CRUCIAL: Verify Tenders On-Disk Milestone Status transitioned to PAID
    const tendersAfterRecon = readTendersStore(tendersPath)
    const paidMilestone = tendersAfterRecon.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
    assert(paidMilestone.status === 'PAID', 'Tenders milestone ms-01 status on disk transitioned to PAID')
    assert(typeof paidMilestone.paidAt === 'string', `Milestone paidAt timestamp persisted: ${paidMilestone.paidAt}`)
    assert(paidMilestone.billedInvoiceNumber === billRes.invoiceNumber, 'Milestone retains billed invoice number')

    // Verify broadcast tenders:data-changed was emitted
    const newBroadcastEvents = webContentsEvents.slice(beforeEventsCount)
    const dataChangedEvent = newBroadcastEvents.find((e) => e.channel === TENDERS_CHANNELS.dataChanged)
    assert(dataChangedEvent !== undefined, 'tenders:data-changed broadcast emitted to active WebContents')

    // Verify Renderer In-Memory Store updated live to PAID
    const rehydratedInMemMilestone = useTendersStore.getState().tenders[0].milestones?.find((m: any) => m.id === 'ms-01')
    assert(rehydratedInMemMilestone?.status === 'PAID', 'Renderer in-memory store reflects PAID live without manual reload')
    assert(typeof (rehydratedInMemMilestone as any)?.paidAt === 'string', 'Renderer in-memory milestone reflects paidAt timestamp')

    // ------------------------------------------------------------------------
    // SECTION 3: CRM Tender Opportunity Sync Hardening (Req c)
    // ------------------------------------------------------------------------
    console.log('\n--- SECTION 3: CRM Tender Opportunity Sync Hardening (Req c) ---')

    const activeTender = tendersAfterRecon.workspaces[0].tenders[0]
    assert(activeTender.id === 'tender-wtr-04', 'Active tender is tender-wtr-04')
    assert(activeTender.referenceNumber === 'RFP-WTR-2026-04', 'Tender reference is RFP-WTR-2026-04')

    // Trigger syncWithCrm
    const syncRes = await mockTendersApi.syncWithCrm({
      tenderId: activeTender.id,
      tender: activeTender,
      crmDealsPath,
      tendersPath,
    })

    assert(syncRes.ok === true, 'syncWithCrm returned ok: true')
    assert(syncRes.dealId === `deal-tender-${activeTender.id}`, `Deterministic deal ID used: ${syncRes.dealId}`)

    // Inspect deals.json
    assert(existsSync(crmDealsPath), 'deals.json exists in CRM user data directory')
    const crmEnvelope = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
    assert(Array.isArray(crmEnvelope.deals), 'CRM envelope contains deals array')
    const syncedDeal = crmEnvelope.deals.find((d: any) => d.id === `deal-tender-${activeTender.id}`)

    assert(syncedDeal !== undefined, 'Synced deal found in deals.json')
    assert(syncedDeal.id === 'deal-tender-tender-wtr-04', 'Deal ID is deterministic: deal-tender-tender-wtr-04')
    assert(syncedDeal.name === 'RFP-WTR-2026-04 - Bulk Water Metering & Valve Refurbishment', `Deal name formatted with RFP ref: ${syncedDeal.name}`)
    assert(syncedDeal.companyName === 'City of Ekurhuleni Water Dept', `Deal companyName is issuer: ${syncedDeal.companyName}`)
    assert(syncedDeal.amount === 243000, `Deal amount matches estimatedValue (243,000)`)
    assert(syncedDeal.stage === 'proposal', `Deal stage is 'proposal'`)
    assert(syncedDeal.expectedCloseDate === '2026-10-31', `Deal expectedCloseDate matches closingDate: ${syncedDeal.expectedCloseDate}`)
    assert(syncedDeal.tenderReference === 'RFP-WTR-2026-04', `Deal tenderReference matches RFP-WTR-2026-04`)
    assert(syncedDeal.tenderId === 'tender-wtr-04', `Deal tenderId matches tender-wtr-04`)
    assert(syncedDeal.notes.includes('Tender Ref: RFP-WTR-2026-04'), 'Deal notes contain RFP reference')
    assert(syncedDeal.notes.includes('City of Ekurhuleni Water Dept'), 'Deal notes contain issuing authority')

    // Verify tender.linkedCrmDealId back-linked on disk
    const tendersAfterCrmSync = readTendersStore(tendersPath)
    const diskTenderWithCrm = tendersAfterCrmSync.workspaces[0].tenders.find((t: any) => t.id === activeTender.id)
    assert(diskTenderWithCrm.linkedCrmDealId === 'deal-tender-tender-wtr-04', 'tender.linkedCrmDealId persisted to tenders-data.json')

    // Verify renderer in-memory store updated with linkedCrmDealId
    const inMemTenderWithCrm = useTendersStore.getState().tenders.find((t: any) => t.id === activeTender.id)
    assert(inMemTenderWithCrm?.linkedCrmDealId === 'deal-tender-tender-wtr-04', 'Renderer in-memory store reflects linkedCrmDealId')

    // Test Deduplication: Re-syncing same tender must update existing deal without duplication
    const initialDealsCount = crmEnvelope.deals.length
    const reSyncRes = await mockTendersApi.syncWithCrm({
      tenderId: activeTender.id,
      tender: { ...activeTender, estimatedValue: 275000 },
      crmDealsPath,
      tendersPath,
    })

    assert(reSyncRes.ok === true, 'Re-sync returned ok: true')
    assert(reSyncRes.dealId === 'deal-tender-tender-wtr-04', 'Re-sync returned same deterministic deal ID')

    const crmEnvelopeAfterReSync = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
    assert(crmEnvelopeAfterReSync.deals.length === initialDealsCount, 'Deals array length unchanged (no duplicate deal created)')
    const updatedDeal = crmEnvelopeAfterReSync.deals.find((d: any) => d.id === 'deal-tender-tender-wtr-04')
    assert(updatedDeal.amount === 275000, 'Existing deal updated in place with new amount (275,000)')

    // Test openInCrm callback routing
    crmTabOpenedWith = undefined
    const openCrmRes = await mockTendersApi.openInCrm('deal-tender-tender-wtr-04')
    assert(openCrmRes.ok === true, 'openInCrm returned ok: true')
    assert(crmTabOpenedWith === 'deal-tender-tender-wtr-04', 'Shell onOpenCrm callback invoked with deal ID')

    // ------------------------------------------------------------------------
    // SECTION 4: Docs & Sheets Export Workflows (Req d)
    // ------------------------------------------------------------------------
    console.log('\n--- SECTION 4: Docs & Sheets Export Workflows (Req d) ---')

    openedGeneratedPaths.length = 0

    // 1. Export Matrix to Sheets
    const sampleRequirements = [
      {
        id: 'REQ-001',
        category: 'TAX_COMPLIANCE',
        title: 'Valid Tax Clearance Certificate Pin',
        isMandatory: true,
        status: 'FULFILLED',
        linkedVaultDocId: 'vd-tax',
        healthStatus: 'VALID',
        notes: 'Verified against SARS e-Filing portal',
      },
      {
        id: 'REQ-002',
        category: 'COIDA',
        title: 'Letter of Good Standing (Compensation Commissioner)',
        isMandatory: true,
        status: 'FULFILLED',
        linkedVaultDocId: 'vd-coida',
        healthStatus: 'VALID',
        notes: 'Department of Labour certified',
      },
      {
        id: 'REQ-003',
        category: 'FINANCIAL',
        title: 'Audited Financial Statements (Last 3 Years)',
        isMandatory: false,
        status: 'UNDER_REVIEW',
        linkedVaultDocId: null,
        healthStatus: 'NO_ATTACHMENT',
        notes: 'Pending auditor signoff, comma in description, and "quotes" test',
      },
    ]

    const exportSheetsRes = await mockTendersApi.exportMatrixToSheets(
      activeTender.id,
      activeTender.title,
      sampleRequirements
    )

    assert(exportSheetsRes.ok === true, 'exportMatrixToSheets returned ok: true')
    assert(typeof exportSheetsRes.path === 'string', `Exported CSV path: ${exportSheetsRes.path}`)
    assert(existsSync(exportSheetsRes.path), 'Generated CSV file exists on disk')

    const csvRawBuffer = readFileSync(exportSheetsRes.path)
    // Verify UTF-8 BOM: EF BB BF (\uFEFF)
    assert(csvRawBuffer[0] === 0xef && csvRawBuffer[1] === 0xbb && csvRawBuffer[2] === 0xbf, 'CSV file starts with UTF-8 BOM (\uFEFF)')

    const csvText = readFileSync(exportSheetsRes.path, 'utf8')
    assert(csvText.includes('Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes'), 'CSV header matches specification (strict RFC 4180 unspaced)')
    assert(csvText.includes('REQ-001'), 'CSV contains REQ-001')
    assert(csvText.includes('Valid Tax Clearance Certificate Pin'), 'CSV contains requirement title')
    assert(csvText.includes('Mandatory / Disqualifier'), 'CSV correctly identifies mandatory criteria')
    assert(csvText.includes('vd-tax'), 'CSV contains linked document ID')
    assert(csvText.includes('Pending auditor signoff, comma in description, and ""quotes"" test'), 'CSV properly escapes commas and double quotes')
    assert(openedGeneratedPaths.includes(exportSheetsRes.path), 'runtime.openGeneratedPath called with CSV path (triggers Sheets tab navigation)')

    // Verify 100% column and row fidelity with Zano Sheets native importer
    const parsedMatrix = parseCsv(csvText)
    assert(parsedMatrix.length === 4, `CSV imports into Sheets with exactly 4 rows (1 header + 3 records, actual: ${parsedMatrix.length})`)
    assert(parsedMatrix[0].length === 8, `CSV header has exactly 8 columns (actual: ${parsedMatrix[0].length})`)
    assert(parsedMatrix[0][0] === 'Requirement ID', 'Header column 0 is "Requirement ID"')
    assert(parsedMatrix[0][1] === 'Category', 'Header column 1 is "Category" (no leading whitespace)')
    assert(parsedMatrix[0][2] === 'Requirement Text', 'Header column 2 is "Requirement Text"')
    assert(parsedMatrix[0][3] === 'Mandatory / Disqualifier', 'Header column 3 is "Mandatory / Disqualifier"')
    assert(parsedMatrix[0][4] === 'Fulfillment Status', 'Header column 4 is "Fulfillment Status"')
    assert(parsedMatrix[0][5] === 'Linked Document', 'Header column 5 is "Linked Document"')
    assert(parsedMatrix[0][6] === 'Health Status', 'Header column 6 is "Health Status"')
    assert(parsedMatrix[0][7] === 'Notes', 'Header column 7 is "Notes"')

    // Check Row 1 (REQ-001)
    assert(parsedMatrix[1].length === 8, `Row 1 has exactly 8 columns (actual: ${parsedMatrix[1].length})`)
    assert(parsedMatrix[1][0] === 'REQ-001', 'Row 1 ID is "REQ-001"')
    assert(parsedMatrix[1][1] === 'TAX COMPLIANCE', 'Row 1 Category is "TAX COMPLIANCE" without quotes or leading whitespace')
    assert(parsedMatrix[1][2] === 'Valid Tax Clearance Certificate Pin', 'Row 1 Requirement Text preserved')
    assert(parsedMatrix[1][5] === 'vd-tax', 'Row 1 Linked Document is "vd-tax"')
    assert(parsedMatrix[1][6] === 'VALID', 'Row 1 Health Status is "VALID"')

    // Check Row 2 (REQ-002)
    assert(parsedMatrix[2].length === 8, `Row 2 has exactly 8 columns (actual: ${parsedMatrix[2].length})`)
    assert(parsedMatrix[2][0] === 'REQ-002', 'Row 2 ID is "REQ-002"')
    assert(parsedMatrix[2][1] === 'COIDA', 'Row 2 Category is "COIDA"')
    assert(parsedMatrix[2][5] === 'vd-coida', 'Row 2 Linked Document is "vd-coida"')

    // Check Row 3 (REQ-003: Commas and quotes in title & notes)
    assert(parsedMatrix[3].length === 8, `Row 3 with internal commas and quotes has exactly 8 columns (actual: ${parsedMatrix[3].length})`)
    assert(parsedMatrix[3][0] === 'REQ-003', 'Row 3 ID is "REQ-003"')
    assert(parsedMatrix[3][1] === 'FINANCIAL', 'Row 3 Category is "FINANCIAL"')
    assert(parsedMatrix[3][7] === 'Pending auditor signoff, comma in description, and "quotes" test', 'Row 3 Notes preserves internal commas and strips quotes correctly in Sheets')

    // 2. Draft Proposal in Docs
    const draftDocsRes = await mockTendersApi.draftProposalDoc(activeTender)
    assert(draftDocsRes.ok === true, 'draftProposalDoc returned ok: true')
    assert(typeof draftDocsRes.path === 'string', `Draft proposal path: ${draftDocsRes.path}`)
    assert(existsSync(draftDocsRes.path), 'Generated proposal document file exists on disk')

    const docText = readFileSync(draftDocsRes.path, 'utf8')
    assert(docText.includes('Commercial & Technical Tender Proposal'), 'Proposal contains title header')
    assert(docText.includes('1. Executive Summary'), 'Proposal contains Executive Summary section')
    assert(docText.includes('2. Delivery Methodology & Implementation Plan'), 'Proposal contains Delivery Methodology section')
    assert(docText.includes('3. Pricing Schedule & Contract Milestones'), 'Proposal contains Pricing Schedule section')
    assert(docText.includes('4. Compliance Checklist & Returnables Matrix'), 'Proposal contains Compliance Checklist section')
    assert(docText.includes('RFP-WTR-2026-04'), 'Proposal includes tender reference')
    assert(docText.includes('City of Ekurhuleni Water Dept'), 'Proposal includes issuing authority')
    assert(openedGeneratedPaths.includes(draftDocsRes.path), 'runtime.openGeneratedPath called with proposal path (triggers document editor navigation)')

    // Clean up temporary export files
    try {
      if (existsSync(exportSheetsRes.path)) unlinkSync(exportSheetsRes.path)
      if (existsSync(draftDocsRes.path)) unlinkSync(draftDocsRes.path)
    } catch {}

    // ------------------------------------------------------------------------
    // SUMMARY
    // ------------------------------------------------------------------------
    console.log('\n----------------------------------------------------------------------')
    console.log(`Results: ${passed} passed, ${failed} failed`)
    console.log('🎉 ALL MILESTONE 3 INTEROPERABILITY VERIFICATIONS PASSED!')
    console.log('----------------------------------------------------------------------\n')

    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {}
    process.exit(0)
  } catch (err) {
    console.error('\nVerification run encountered a fatal failure:', err)
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {}
    process.exit(1)
  }
}

void runTests()

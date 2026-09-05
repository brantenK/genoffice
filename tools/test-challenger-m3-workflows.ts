#!/usr/bin/env node
/**
 * tools/test-challenger-m3-workflows.ts
 *
 * EMPIRICAL ADVERSARIAL WORKFLOW CHALLENGER — MILESTONE 3
 * Role: Empirical Challenger (challenger_2_m3_interop)
 *
 * Scope: Milestone 3 — Cross-App Interoperability & Export Workflows (R3)
 *
 * Objective:
 * Empirically verify & stress-test:
 * 1. Complete Lifecycle:
 *    - Milestone eligibility guards (reject PLANNED / IN_PROGRESS / PAID / <= 0 amounts)
 *    - Reached milestone billed in Books -> balanced double-entry JE & Tax Invoice with SA 15% VAT
 *    - Double-billing rejection guard
 *    - Multi-milestone decimal cents support
 *    - Bank statement CSV parsing stress (symbols, parenthesized negatives, whitespace, deduplication)
 *    - Reconciliation execution -> settlement JE posted, invoice paid
 *    - Automatic back-propagation to tenders-data.json -> milestone transitions to PAID with paidAt
 *    - Active WebContents broadcast & live Zustand store rehydration without reload
 *    - Idempotency & double-reconciliation rejection guards
 *
 * 2. Tender to CRM Sync & 1-Click Navigation:
 *    - Sync tender with special characters into CRM deals.json
 *    - Deterministic ID (deal-tender-${id}), metadata (ref, issuer, value, close date)
 *    - Back-link tender.linkedCrmDealId saved to disk and live store
 *    - 10x consecutive re-sync idempotency test (in-place update, 0 duplicate deals)
 *    - 1-click navigation callback routing (openInCrm)
 *    - Resilient recovery on corrupt deals.json
 *
 * 3. Matrix to Sheets and Draft Proposal to Docs:
 *    - Matrix export with commas, quotes, line breaks, unicode, empty/null fields
 *    - UTF-8 BOM (\uFEFF) verification and RFC 4180 double-quote escaping
 *    - Draft proposal structured markdown verification (all 4 sections, calculations)
 *    - Empty matrix edge case
 *    - Concurrent rapid export collision & integrity test
 *    - Shell tab navigation triggering (runtime.openGeneratedPath)
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Module from 'node:module'

// ----------------------------------------------------------------------------
// 1. ELECTRON ENVIRONMENT MOCK HARNESS
// ----------------------------------------------------------------------------
const ipcHandlers: Record<string, (...args: any[]) => any> = {}
const testDir = join(tmpdir(), `challenger-m3-workflow-${randomUUID().slice(0, 8)}`)
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
      broadcastEvents.push({ channel, args })
    },
    loadURL: async () => {},
    loadFile: async () => {},
    once: (_event: string, _fn: () => void) => {},
  }
}

const broadcastEvents: Array<{ channel: string; args: any[] }> = []

// Intercept 'electron'
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
// 2. LOAD APPLICATION BACKENDS
// ----------------------------------------------------------------------------
const tendersMain = require('../apps/tenders/src/main/tenders-main.ts')
const {
  CURRENT_TENDERS_SCHEMA_VERSION,
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
  DEFAULT_BOOK_SETTINGS,
  readBooksStore,
  writeBooksStore,
  importBankStatement,
  computeSettlementSuggestions,
  executeReconciliation,
  registerBooksIpc,
} = booksMain

const tendersIpc = require('../apps/tenders/src/shared/ipc.ts')
const { TENDERS_CHANNELS } = tendersIpc

// Mock window, localStorage and Zustand store
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
    return { ok: false, error: 'IPC handler not registered' }
  },
  syncWithCrm: async (dealData: any) => {
    const fn = ipcHandlers[TENDERS_CHANNELS.syncWithCrm]
    if (fn) return fn({ sender: null }, dealData)
    return { ok: false, error: 'IPC handler not registered' }
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

const mockStorageMap = new Map<string, string>()
const mockLocalStorage = {
  getItem: (k: string) => mockStorageMap.get(k) ?? null,
  setItem: (k: string, v: string) => { mockStorageMap.set(k, String(v)) },
  removeItem: (k: string) => { mockStorageMap.delete(k) },
  clear: () => { mockStorageMap.clear() },
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
// 3. TEST ASSERTION & METRICS SUITE
// ----------------------------------------------------------------------------
let totalTests = 0
let passedTests = 0
let failedTests = 0
const metrics = {
  lifecycleChecks: 0,
  crmSyncChecks: 0,
  exportChecks: 0,
  adversarialStressChecks: 0,
}

function expect(cond: boolean, description: string, metricCategory?: keyof typeof metrics) {
  totalTests++
  if (metricCategory) metrics[metricCategory]++
  if (cond) {
    passedTests++
    console.log(`  [PASS] ${description}`)
  } else {
    failedTests++
    console.error(`  [FAIL] ${description}`)
    throw new Error(`Assertion failed: ${description}`)
  }
}

async function runChallengerVerification() {
  console.log('================================================================================')
  console.log('  CHALLENGER 2 EMPIRICAL VERIFICATION: MILESTONE 3 INTEROP WORKFLOWS (R3)')
  console.log('================================================================================\n')

  try {
    // ------------------------------------------------------------------------
    // SETUP ISOLATED SANDBOX
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

    registerTendersIpc()
    registerBooksIpc()

    // Mock WebContents to relay broadcasts
    const mockWc = {
      isDestroyed: () => false,
      send: (channel: string, data: any) => {
        broadcastEvents.push({ channel, args: [data] })
        const cbs = listeners[channel] || []
        for (const cb of cbs) cb(data)
      },
      once: (_ev: string, _fn: () => void) => {},
    }
    registerTendersWebContents(mockWc as any)

    mockTendersApi.onDataChanged((data) => {
      useTendersStore.getState().syncFromMain(data)
    })

    // Initialize Books Store
    const initialBooksData = {
      version: CURRENT_BOOKS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      settings: DEFAULT_BOOK_SETTINGS,
      accounts: [
        { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: 50000 },
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

    // Initialize Tenders Store with 2 milestones (one reached, one upcoming)
    const initialTendersData = migrateAndValidateTenders(null)
    const activeTender = initialTendersData.workspaces[0].tenders[0]
    // Add second milestone with fractional cents
    activeTender.milestones = [
      {
        id: 'ms-01',
        title: 'Phase 1 Reservoir Valve Refurbishment',
        amount: 145000,
        status: 'REACHED',
        dueDate: '2026-09-15',
      },
      {
        id: 'ms-02',
        title: 'Phase 2 Telemetry & Pressure Calibration',
        amount: 52345.67,
        status: 'REACHED',
        dueDate: '2026-10-15',
      },
      {
        id: 'ms-03',
        title: 'Phase 3 Final Handover & Signoff',
        amount: 30000,
        status: 'PLANNED',
        dueDate: '2026-11-15',
      },
    ]
    writeTendersStore(tendersPath, initialTendersData)

    // Hydrate renderer store
    await useTendersStore.getState().loadFromMain()

    // ========================================================================
    // SUITE 1: COMPLETE CONTRACT LIFECYCLE VERIFICATION & ADVERSARIAL STRESS
    // ========================================================================
    console.log('\n--- SUITE 1: Complete Contract Milestone Lifecycle & Accounting Integrity ---')

    // 1.1 Milestone Eligibility Enforcement
    console.log('\n  [Scenario 1.1] Milestone eligibility & boundary guards')
    const billPlannedRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: activeTender.id,
      milestoneId: 'ms-03', // PLANNED status
      amount: 30000,
    })
    expect(billPlannedRes.ok === false, 'Rejects billing milestone in PLANNED status', 'adversarialStressChecks')
    expect(billPlannedRes.error?.includes('not in REACHED status') || billPlannedRes.error?.includes('not reached'), 'Returns clear error explaining non-reached status', 'adversarialStressChecks')

    const billZeroRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: activeTender.id,
      milestoneId: 'ms-01',
      amount: 0,
    })
    expect(billZeroRes.ok === false, 'Rejects billing milestone with amount = 0', 'adversarialStressChecks')

    const billNegativeRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: activeTender.id,
      milestoneId: 'ms-01',
      amount: -5000,
    })
    expect(billNegativeRes.ok === false, 'Rejects billing milestone with negative amount', 'adversarialStressChecks')

    const billNonExistentTender = await mockTendersApi.billMilestoneInBooks({
      tenderId: 'non-existent-tender-id',
      milestoneId: 'ms-01',
      amount: 10000,
    })
    expect(billNonExistentTender.ok === false, 'Rejects billing for non-existent tender ID', 'adversarialStressChecks')

    const billNonExistentMs = await mockTendersApi.billMilestoneInBooks({
      tenderId: activeTender.id,
      milestoneId: 'non-existent-milestone-id',
      amount: 10000,
    })
    expect(billNonExistentMs.ok === false, 'Rejects billing for non-existent milestone ID', 'adversarialStressChecks')

    // 1.2 Legitimate Milestone Billing: Milestone 1 (R 145,000.00)
    console.log('\n  [Scenario 1.2] Billed Milestone 1 in Books & Balanced Ledger Verification')
    booksTabOpenedWith = undefined
    const billRes1 = await mockTendersApi.billMilestoneInBooks({
      tenderId: activeTender.id,
      milestoneId: 'ms-01',
      tenderReference: activeTender.referenceNumber,
      issuingAuthority: activeTender.issuingBody,
      milestoneTitle: 'Phase 1 Reservoir Valve Refurbishment',
      amount: 145000,
      notes: 'Terms: 30 days net',
    })

    expect(billRes1.ok === true, 'Milestone 1 successfully billed in Books', 'lifecycleChecks')
    expect(typeof billRes1.invoiceNumber === 'string' && billRes1.invoiceNumber.startsWith('INV-'), `Valid Tax Invoice number generated: ${billRes1.invoiceNumber}`, 'lifecycleChecks')
    expect(typeof billRes1.invoiceId === 'string', `Valid Tax Invoice ID generated: ${billRes1.invoiceId}`, 'lifecycleChecks')
    expect(billRes1.grandTotal === 145000, 'Invoice grandTotal matches R 145,000', 'lifecycleChecks')
    expect(billRes1.subtotal === 126086.96, 'Net subtotal correctly calculated base: R 126,086.96 (15% VAT)', 'lifecycleChecks')
    expect(billRes1.taxTotal === 18913.04, 'SARS VAT Output correctly calculated: R 18,913.04', 'lifecycleChecks')
    expect(booksTabOpenedWith === billRes1.invoiceId, 'runtime.onOpenBooks invoked with generated invoiceId', 'lifecycleChecks')

    // Double billing guard
    const duplicateBillRes = await mockTendersApi.billMilestoneInBooks({
      tenderId: activeTender.id,
      milestoneId: 'ms-01',
      amount: 145000,
    })
    expect(duplicateBillRes.ok === false, 'Double billing guard: Rejects billing already billed milestone', 'adversarialStressChecks')
    expect(duplicateBillRes.error?.includes('already billed'), 'Clear error indicates milestone already billed', 'adversarialStressChecks')

    // Inspect Books State after Billing 1
    const booksPostBill1 = readBooksStore(booksPath)
    const inv1 = booksPostBill1.invoices.find((i: any) => i.id === billRes1.invoiceId)
    expect(inv1 !== undefined, 'Invoice 1 exists in Books store', 'lifecycleChecks')
    expect(inv1.status === 'Unpaid', 'Invoice 1 status is Unpaid', 'lifecycleChecks')
    expect(inv1.tenderReference === activeTender.referenceNumber, `Invoice 1 stores tenderReference: ${activeTender.referenceNumber}`, 'lifecycleChecks')
    expect(inv1.outstandingAmount === 145000, 'Invoice 1 outstandingAmount is 145,000', 'lifecycleChecks')

    // Verify Party created in Books
    const party = booksPostBill1.parties.find((p: any) => p.name.toLowerCase() === activeTender.issuingBody.toLowerCase())
    expect(party !== undefined, 'Customer Party created for issuing authority', 'lifecycleChecks')
    expect(party.outstandingBalance === 145000, 'Party outstandingBalance is R 145,000', 'lifecycleChecks')

    // Verify Books General Ledger & Double-Entry Journal Entry
    const arAcc = booksPostBill1.accounts.find((a: any) => a.id === 'acc-ar')
    const salesAcc = booksPostBill1.accounts.find((a: any) => a.id === 'acc-sales')
    const vatAcc = booksPostBill1.accounts.find((a: any) => a.id === 'acc-vat')
    expect(arAcc.balance === 145000, `Accounts Receivable debited to R 145,000 (actual: ${arAcc.balance})`, 'lifecycleChecks')
    expect(salesAcc.balance === 126086.96, `Sales credited to R 126,086.96 (actual: ${salesAcc.balance})`, 'lifecycleChecks')
    expect(vatAcc.balance === 18913.04, `VAT Output credited to R 18,913.04 (actual: ${vatAcc.balance})`, 'lifecycleChecks')

    expect(booksPostBill1.journalEntries.length === 1, 'Exactly 1 balanced journal entry posted in Books', 'lifecycleChecks')
    const je1 = booksPostBill1.journalEntries[0]
    expect(je1.posted === true, 'Journal entry marked posted', 'lifecycleChecks')
    expect(je1.totalDebit === 145000 && je1.totalCredit === 145000, 'Journal entry perfectly balanced (Debit === Credit === 145,000)', 'lifecycleChecks')

    // Verify Tenders On-Disk & Store updated to BILLED
    const tendersPostBill1 = readTendersStore(tendersPath)
    const diskMs1 = tendersPostBill1.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
    expect(diskMs1.status === 'BILLED', 'Tenders on-disk milestone ms-01 status updated to BILLED', 'lifecycleChecks')
    expect(diskMs1.billedInvoiceId === billRes1.invoiceId, 'On-disk milestone stores billedInvoiceId', 'lifecycleChecks')
    expect(diskMs1.billedInvoiceNumber === billRes1.invoiceNumber, 'On-disk milestone stores billedInvoiceNumber', 'lifecycleChecks')
    expect(typeof diskMs1.billedAt === 'string', 'On-disk milestone stores billedAt ISO timestamp', 'lifecycleChecks')

    // Live store in-memory reflects BILLED without reload
    const inMemMs1 = useTendersStore.getState().tenders[0].milestones?.find((m: any) => m.id === 'ms-01')
    expect(inMemMs1?.status === 'BILLED', 'Renderer in-memory store reflects BILLED live', 'lifecycleChecks')

    // 1.3 Bill Second Milestone with fractional cents: Milestone 2 (R 52,345.67)
    console.log('\n  [Scenario 1.3] Multi-Milestone with Fractional Cents Billing')
    const billRes2 = await mockTendersApi.billMilestoneInBooks({
      tenderId: activeTender.id,
      milestoneId: 'ms-02',
      tenderReference: activeTender.referenceNumber,
      issuingAuthority: activeTender.issuingBody,
      milestoneTitle: 'Phase 2 Telemetry & Pressure Calibration',
      amount: 52345.67,
    })
    expect(billRes2.ok === true, 'Milestone 2 billed in Books', 'lifecycleChecks')
    const expectedSubtotal2 = Math.round((52345.67 / 1.15) * 100) / 100
    const expectedTax2 = Math.round((52345.67 - expectedSubtotal2) * 100) / 100
    expect(billRes2.subtotal === expectedSubtotal2, `Milestone 2 net subtotal: R ${expectedSubtotal2}`, 'lifecycleChecks')
    expect(billRes2.taxTotal === expectedTax2, `Milestone 2 tax total: R ${expectedTax2}`, 'lifecycleChecks')
    expect(Math.round((billRes2.subtotal + billRes2.taxTotal) * 100) / 100 === 52345.67, 'Subtotal + Tax matches grandTotal to the exact cent', 'lifecycleChecks')

    // 1.4 Bank Statement Import Stress Testing
    console.log('\n  [Scenario 1.4] Bank Statement CSV Ingestion Stress (currency symbols, commas, quotes, deduplication)')
    const initialBankBal = 50000
    const rawBankCsv = [
      'Date,Description,Amount',
      // Standard transaction with currency symbol, spaces, and invoice ref
      `2026-09-04,"DEP CITY OF EKURHULENI WATER - REF: ${billRes1.invoiceNumber}", "R 145,000.00"`,
      // Malformed extra spacing and quotes
      `2026-09-05,  Ekurhuleni Water Tender ${activeTender.referenceNumber} Settlement  , 52345.67`,
      // Parenthesized negative transaction (supplier payment)
      `2026-09-03, "Valves Supply Co PTY LTD", (15000) `,
      // Zero amount should be skipped
      `2026-09-02, Bank Charge Zero, 0.00`,
      // Empty line
      '',
    ].join('\r\n')

    const importRes = importBankStatement({
      booksDataPath: booksPath,
      csvContent: rawBankCsv,
    })

    expect(importRes.ok === true, 'Bank statement CSV parsed successfully', 'lifecycleChecks')
    expect(importRes.importedCount === 3, 'Imported exactly 3 valid transactions (0 amount skipped)', 'adversarialStressChecks')
    expect(importRes.transactions?.length === 3, 'Transactions list length is 3', 'lifecycleChecks')

    const netChange = 145000 + 52345.67 - 15000
    const expectedBankBal = Math.round((initialBankBal + netChange) * 100) / 100
    const booksAfterImport = readBooksStore(booksPath)
    const bankAcc = booksAfterImport.accounts.find((a: any) => a.id === 'acc-bank')
    expect(bankAcc.balance === expectedBankBal, `Bank account adjusted accurately: R ${bankAcc.balance} (expected: R ${expectedBankBal})`, 'lifecycleChecks')

    // Test Deduplication: Re-importing same statement should skip duplicates and NOT double-adjust balance
    const reImportRes = importBankStatement({
      booksDataPath: booksPath,
      csvContent: rawBankCsv,
    })
    expect(reImportRes.ok === true, 'Re-import CSV succeeded', 'adversarialStressChecks')
    expect(reImportRes.importedCount === 0, '0 duplicate transactions imported on re-import', 'adversarialStressChecks')
    expect(reImportRes.skippedDuplicates === 3, 'All 3 transactions recognized as duplicates and skipped', 'adversarialStressChecks')
    const booksAfterReImport = readBooksStore(booksPath)
    const bankAccAfterReImport = booksAfterReImport.accounts.find((a: any) => a.id === 'acc-bank')
    expect(bankAccAfterReImport.balance === expectedBankBal, 'Bank account balance unchanged after re-importing duplicates', 'adversarialStressChecks')

    // 1.5 Settlement Suggestions Match
    console.log('\n  [Scenario 1.5] Automated Settlement Suggestions Verification')
    const suggestions = computeSettlementSuggestions(booksAfterReImport)
    expect(suggestions.length >= 2, 'Generated settlement suggestions for open invoices', 'lifecycleChecks')
    const ms1Suggestion = suggestions.find((s) => s.invoiceId === billRes1.invoiceId)
    expect(ms1Suggestion !== undefined, 'Found matching suggestion for Invoice 1', 'lifecycleChecks')
    expect(ms1Suggestion?.confidence === 'HIGH', 'Confidence is HIGH due to invoice number / tender ref match', 'lifecycleChecks')

    // 1.6 Execute 1-Click Bank Reconciliation & Payment Back-Propagation to Tenders
    console.log('\n  [Scenario 1.6] Reconciliation & Automatic Tenders Payment Propagation')
    const txMs1 = booksAfterReImport.bankTransactions.find((t: any) => t.amount === 145000)
    expect(txMs1 !== undefined, 'Found deposit bank transaction for Milestone 1', 'lifecycleChecks')

    const broadcastCountBefore = broadcastEvents.length

    const reconRes1 = executeReconciliation({
      booksDataPath: booksPath,
      transactionId: txMs1.id,
      invoiceId: billRes1.invoiceId!,
      tendersDataPath: tendersPath,
    })

    expect(reconRes1.ok === true, 'executeReconciliation succeeded for Milestone 1', 'lifecycleChecks')
    expect(reconRes1.invoiceStatus === 'Paid', 'Invoice status updated to Paid', 'lifecycleChecks')
    expect(reconRes1.settledAmount === 145000, 'Settled amount matches R 145,000', 'lifecycleChecks')
    expect(reconRes1.tenderMilestonePaid === true, 'Reconciliation confirmed tender milestone paid', 'lifecycleChecks')
    expect(reconRes1.matchedMilestoneId === 'ms-01', 'Matched exact milestone ms-01', 'lifecycleChecks')

    // Books ledger verification after reconciliation
    const booksAfterRecon1 = readBooksStore(booksPath)
    const postInv1 = booksAfterRecon1.invoices.find((i: any) => i.id === billRes1.invoiceId)
    const postArAcc = booksAfterRecon1.accounts.find((a: any) => a.id === 'acc-ar')
    expect(postInv1.status === 'Paid', 'Books invoice is Paid', 'lifecycleChecks')
    expect(postInv1.outstandingAmount === 0, 'Invoice outstanding amount is 0', 'lifecycleChecks')
    expect(postArAcc.balance === 52345.67, `AR reduced by 145,000, remaining balance: R ${postArAcc.balance} (Milestone 2)`, 'lifecycleChecks')

    // CRITICAL: Inspect tenders-data.json ON DISK
    const tendersAfterRecon1 = readTendersStore(tendersPath)
    const diskPaidMs1 = tendersAfterRecon1.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
    expect(diskPaidMs1.status === 'PAID', 'Milestone ms-01 status on disk transitioned to PAID', 'lifecycleChecks')
    expect(typeof diskPaidMs1.paidAt === 'string', `Milestone ms-01 paidAt timestamp persisted: ${diskPaidMs1.paidAt}`, 'lifecycleChecks')
    expect(diskPaidMs1.billedInvoiceNumber === billRes1.invoiceNumber, 'Milestone ms-01 retains billed invoice number', 'lifecycleChecks')

    // Verify isolation: Milestone 2 must STILL be BILLED, NOT PAID
    const diskMs2 = tendersAfterRecon1.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-02')
    expect(diskMs2.status === 'BILLED', 'Isolation: Milestone ms-02 remains BILLED (not prematurely marked PAID)', 'adversarialStressChecks')

    // Verify IPC broadcast was dispatched
    const recentBroadcasts = broadcastEvents.slice(broadcastCountBefore)
    const dataChangedEvent = recentBroadcasts.find((e) => e.channel === TENDERS_CHANNELS.dataChanged)
    expect(dataChangedEvent !== undefined, 'broadcastTendersData emitted tenders:data-changed on reconciliation', 'lifecycleChecks')

    // Verify in-memory Zustand store updated LIVE without reload
    const inMemPaidMs1 = useTendersStore.getState().tenders[0].milestones?.find((m: any) => m.id === 'ms-01')
    expect(inMemPaidMs1?.status === 'PAID', 'Renderer in-memory store reflects PAID live via broadcast', 'lifecycleChecks')
    expect(typeof (inMemPaidMs1 as any)?.paidAt === 'string', 'Renderer in-memory store reflects paidAt date', 'lifecycleChecks')

    // 1.7 Double-Reconciliation & Double-Settlement Guard
    console.log('\n  [Scenario 1.7] Double-reconciliation rejection guards')
    const doubleReconTxRes = executeReconciliation({
      booksDataPath: booksPath,
      transactionId: txMs1.id, // already reconciled
      invoiceId: billRes2.invoiceId!,
      tendersDataPath: tendersPath,
    })
    expect(doubleReconTxRes.ok === false, 'Rejects reconciliation on already reconciled transaction', 'adversarialStressChecks')
    expect(doubleReconTxRes.error?.includes('already reconciled'), 'Clear error explaining transaction already reconciled', 'adversarialStressChecks')

    const txMs2 = booksAfterRecon1.bankTransactions.find((t: any) => t.amount === 52345.67)
    const doubleReconInvRes = executeReconciliation({
      booksDataPath: booksPath,
      transactionId: txMs2.id,
      invoiceId: billRes1.invoiceId!, // already paid
      tendersDataPath: tendersPath,
    })
    expect(doubleReconInvRes.ok === false, 'Rejects reconciliation on already paid invoice', 'adversarialStressChecks')
    expect(doubleReconInvRes.error?.includes('already marked Paid'), 'Clear error explaining invoice already paid', 'adversarialStressChecks')

    // Reconcile Milestone 2
    console.log('\n  [Scenario 1.8] Reconcile Milestone 2 and Complete Multi-Milestone Lifecycle')
    const reconRes2 = executeReconciliation({
      booksDataPath: booksPath,
      transactionId: txMs2.id,
      invoiceId: billRes2.invoiceId!,
      tendersDataPath: tendersPath,
    })
    expect(reconRes2.ok === true, 'Reconciliation for Milestone 2 succeeded', 'lifecycleChecks')
    const tendersAfterRecon2 = readTendersStore(tendersPath)
    const diskPaidMs2 = tendersAfterRecon2.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-02')
    expect(diskPaidMs2.status === 'PAID', 'Milestone ms-02 status transitioned to PAID', 'lifecycleChecks')
    const finalBooks = readBooksStore(booksPath)
    const finalAr = finalBooks.accounts.find((a: any) => a.id === 'acc-ar')
    expect(finalAr.balance === 0, 'AR account fully cleared to R 0 after all milestones reconciled', 'lifecycleChecks')

    // ========================================================================
    // SUITE 2: TENDER TO CRM OPPORTUNITY SYNC & 1-CLICK NAVIGATION
    // ========================================================================
    console.log('\n--- SUITE 2: CRM Tender Opportunity Sync & 1-Click Navigation Hardening ---')

    const crmTender = tendersAfterRecon2.workspaces[0].tenders[0]
    crmTender.title = 'Bulk Water Metering & "Smart" Valves [Phase 1/2]' // Test special chars & quotes

    // 2.1 Initial Sync
    console.log('\n  [Scenario 2.1] Export tender to CRM deals')
    const syncRes1 = await mockTendersApi.syncWithCrm({
      tenderId: crmTender.id,
      tender: crmTender,
      crmDealsPath,
      tendersPath,
    })

    expect(syncRes1.ok === true, 'syncWithCrm returned ok: true', 'crmSyncChecks')
    const expectedDealId = `deal-tender-${crmTender.id}`
    expect(syncRes1.dealId === expectedDealId, `Deterministic dealId generated: ${expectedDealId}`, 'crmSyncChecks')

    // Check deals.json content
    expect(existsSync(crmDealsPath), 'CRM deals.json created on disk', 'crmSyncChecks')
    const crmData1 = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
    expect(Array.isArray(crmData1.deals), 'deals.json contains deals array', 'crmSyncChecks')
    expect(crmData1.deals.length === 1, 'Exactly 1 deal in CRM deals.json', 'crmSyncChecks')

    const syncedDeal = crmData1.deals[0]
    expect(syncedDeal.id === expectedDealId, 'Deal ID matches deterministic ID', 'crmSyncChecks')
    expect(syncedDeal.name.includes(crmTender.referenceNumber), 'Deal name contains tender reference number', 'crmSyncChecks')
    expect(syncedDeal.companyName === crmTender.issuingBody, `Deal companyName matches issuer: ${syncedDeal.companyName}`, 'crmSyncChecks')
    expect(syncedDeal.amount === crmTender.estimatedValue, `Deal amount matches estimatedValue: ${syncedDeal.amount}`, 'crmSyncChecks')
    expect(syncedDeal.expectedCloseDate === crmTender.closingDate, `Deal expectedCloseDate matches closingDate: ${syncedDeal.expectedCloseDate}`, 'crmSyncChecks')
    expect(syncedDeal.stage === 'proposal', 'Deal stage set to proposal', 'crmSyncChecks')
    expect(syncedDeal.tenderReference === crmTender.referenceNumber, 'Deal stores tenderReference', 'crmSyncChecks')
    expect(syncedDeal.tenderId === crmTender.id, 'Deal stores tenderId', 'crmSyncChecks')

    // 2.2 Verify Tender Record Back-Linking
    console.log('\n  [Scenario 2.2] Tender linkedCrmDealId back-link verification')
    const tendersPostCrm = readTendersStore(tendersPath)
    const diskTenderPostCrm = tendersPostCrm.workspaces[0].tenders.find((t: any) => t.id === crmTender.id)
    expect(diskTenderPostCrm.linkedCrmDealId === expectedDealId, 'tender.linkedCrmDealId persisted to tenders-data.json', 'crmSyncChecks')

    const inMemTenderPostCrm = useTendersStore.getState().tenders.find((t: any) => t.id === crmTender.id)
    expect(inMemTenderPostCrm?.linkedCrmDealId === expectedDealId, 'Renderer in-memory store reflects linkedCrmDealId', 'crmSyncChecks')

    // 2.3 10x Consecutive Sync Idempotency Stress Test
    console.log('\n  [Scenario 2.3] 10x consecutive sync idempotency & in-place update stress test')
    let latestDealAmount = crmTender.estimatedValue
    for (let i = 1; i <= 10; i++) {
      latestDealAmount += 5000
      const loopSync = await mockTendersApi.syncWithCrm({
        tenderId: crmTender.id,
        tender: { ...crmTender, estimatedValue: latestDealAmount },
        crmDealsPath,
        tendersPath,
      })
      expect(loopSync.ok === true && loopSync.dealId === expectedDealId, `Sync iteration ${i} succeeded with same deal ID`, 'adversarialStressChecks')
    }

    const crmDataPostStress = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
    expect(crmDataPostStress.deals.length === 1, 'CRM deals count strictly preserved at 1 (zero duplicates created)', 'adversarialStressChecks')
    expect(crmDataPostStress.deals[0].amount === latestDealAmount, `Existing deal updated in-place with latest amount: R ${latestDealAmount}`, 'adversarialStressChecks')

    // 2.4 1-Click Navigation callback verification
    console.log('\n  [Scenario 2.4] 1-Click Navigation to CRM opportunity')
    crmTabOpenedWith = undefined
    const openCrmRes = await mockTendersApi.openInCrm(expectedDealId)
    expect(openCrmRes.ok === true, 'openInCrm returned ok: true', 'crmSyncChecks')
    expect(crmTabOpenedWith === expectedDealId, `runtime.onOpenCrm invoked with dealId: ${expectedDealId}`, 'crmSyncChecks')

    // 2.5 Resilient Recovery on Corrupted deals.json
    console.log('\n  [Scenario 2.5] Resilient recovery on corrupted deals.json')
    writeFileSync(crmDealsPath, 'CORRUPTED NON-JSON CONTENT {[[', 'utf8')
    const recoverSync = await mockTendersApi.syncWithCrm({
      tenderId: crmTender.id,
      tender: crmTender,
      crmDealsPath,
      tendersPath,
    })
    expect(recoverSync.ok === true, 'syncWithCrm safely recovers when deals.json was corrupted', 'adversarialStressChecks')
    expect(existsSync(`${crmDealsPath}.corrupted.bak`), 'Corrupted file safely preserved as .corrupted.bak', 'adversarialStressChecks')
    const recoveredData = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
    expect(Array.isArray(recoveredData.deals) && recoveredData.deals.length === 1, 'New valid deals envelope written without crashing', 'adversarialStressChecks')

    // ========================================================================
    // SUITE 3: MATRIX TO SHEETS & DRAFT PROPOSAL TO DOCS EXPORT WORKFLOWS
    // ========================================================================
    console.log('\n--- SUITE 3: Matrix to Sheets & Draft Proposal to Docs Export Workflows ---')

    openedGeneratedPaths.length = 0

    // 3.1 Matrix Export to Sheets with Adversarial Characters & RFC 4180 Escaping
    console.log('\n  [Scenario 3.1] Export Compliance Matrix with commas, quotes, linebreaks, and UTF-8 BOM')
    const adversarialMatrix = [
      {
        id: 'REQ-001',
        category: 'MANDATORY_LEGAL',
        title: 'Valid Tax Pin from "SARS", Certified',
        isMandatory: true,
        status: 'FULFILLED',
        linkedVaultDocId: 'vd-tax-01',
        healthStatus: 'VALID',
        notes: 'Verified online, no issues found.',
      },
      {
        id: 'REQ-002',
        category: 'OHS_COMPLIANCE',
        title: 'Safety Plan with Line Break\nAnd Special Chars: © 2026, 100% compliant',
        isMandatory: true,
        status: 'ACTION_REQUIRED',
        linkedVaultDocId: null,
        healthStatus: 'EXPIRED',
        notes: 'Requires signature from "Lead Safety Officer", urgent.',
      },
      {
        id: 'REQ-003',
        category: 'FINANCIAL_STANDING',
        title: 'Audited AFS (Last 3 Years)',
        isMandatory: false,
        status: 'UNDER_REVIEW',
        linkedVaultDocId: 'vd-fin-03',
        healthStatus: 'EXPIRING_SOON',
        notes: null, // Test null notes
      },
    ]

    const exportSheetsRes = await mockTendersApi.exportMatrixToSheets(
      crmTender.id,
      crmTender.title,
      adversarialMatrix
    )

    expect(exportSheetsRes.ok === true, 'exportMatrixToSheets returned ok: true', 'exportChecks')
    expect(typeof exportSheetsRes.path === 'string', `Generated CSV path: ${exportSheetsRes.path}`, 'exportChecks')
    expect(existsSync(exportSheetsRes.path), 'CSV file exists on disk', 'exportChecks')

    const csvBytes = readFileSync(exportSheetsRes.path)
    // UTF-8 BOM check: 0xEF, 0xBB, 0xBF (\uFEFF)
    expect(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, 'CSV file starts with UTF-8 BOM (0xEF, 0xBB, 0xBF)', 'exportChecks')

    const csvContent = readFileSync(exportSheetsRes.path, 'utf8')
    const expectedHeader = 'Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes'
    expect(csvContent.includes(expectedHeader), 'CSV contains exact 8-column header', 'exportChecks')
    expect(csvContent.includes('REQ-001'), 'CSV contains REQ-001 row', 'exportChecks')
    // RFC 4180 quote escaping: "SARS" becomes ""SARS"" inside quotes
    expect(csvContent.includes('""SARS""'), 'Double quotes properly escaped as per RFC 4180', 'exportChecks')
    expect(csvContent.includes('Mandatory / Disqualifier'), 'Mandatory criteria labeled correctly', 'exportChecks')
    expect(csvContent.includes('vd-tax-01'), 'Linked vault document ID present', 'exportChecks')
    expect(openedGeneratedPaths.includes(exportSheetsRes.path), 'runtime.openGeneratedPath called with CSV path (Sheets tab navigation triggered)', 'exportChecks')

    // 3.2 Empty Matrix Edge Case
    console.log('\n  [Scenario 3.2] Export Empty Matrix Edge Case')
    const emptyMatrixRes = await mockTendersApi.exportMatrixToSheets('empty-tender', 'Empty Tender', [])
    expect(emptyMatrixRes.ok === true, 'Empty matrix exports cleanly without crashing', 'adversarialStressChecks')
    const emptyCsv = readFileSync(emptyMatrixRes.path, 'utf8')
    expect(emptyCsv.includes(expectedHeader), 'Empty CSV contains headers', 'adversarialStressChecks')

    // 3.3 Draft Proposal Export to Docs
    console.log('\n  [Scenario 3.3] Draft Proposal structured document generation')
    crmTender.requirements = adversarialMatrix
    const draftDocsRes = await mockTendersApi.draftProposalDoc(crmTender)

    expect(draftDocsRes.ok === true, 'draftProposalDoc returned ok: true', 'exportChecks')
    expect(typeof draftDocsRes.path === 'string', `Generated Markdown proposal path: ${draftDocsRes.path}`, 'exportChecks')
    expect(existsSync(draftDocsRes.path), 'Proposal markdown file exists on disk', 'exportChecks')

    const docContent = readFileSync(draftDocsRes.path, 'utf8')
    expect(docContent.includes('# Commercial & Technical Tender Proposal'), 'Proposal contains Title Header', 'exportChecks')
    expect(docContent.includes('## 1. Executive Summary'), 'Proposal contains Section 1: Executive Summary', 'exportChecks')
    expect(docContent.includes('## 2. Delivery Methodology & Implementation Plan'), 'Proposal contains Section 2: Delivery Methodology', 'exportChecks')
    expect(docContent.includes('## 3. Pricing Schedule & Contract Milestones'), 'Proposal contains Section 3: Pricing Schedule', 'exportChecks')
    expect(docContent.includes('## 4. Compliance Checklist & Returnables Matrix'), 'Proposal contains Section 4: Compliance Checklist', 'exportChecks')
    expect(docContent.includes(crmTender.referenceNumber), 'Proposal includes RFP reference number', 'exportChecks')
    expect(docContent.includes(crmTender.issuingBody), 'Proposal includes issuing authority', 'exportChecks')
    expect(docContent.includes('Phase 1') && docContent.includes('Phase 2'), 'Proposal pricing schedule contains project phases', 'exportChecks')
    expect(openedGeneratedPaths.includes(draftDocsRes.path), 'runtime.openGeneratedPath called with Markdown path (Docs tab navigation triggered)', 'exportChecks')

    // 3.4 Concurrent Rapid Export Collision Stress Test
    console.log('\n  [Scenario 3.4] Concurrent rapid exports collision & file integrity stress test')
    const concurrentPromises = [
      mockTendersApi.exportMatrixToSheets(crmTender.id, 'Burst_1', adversarialMatrix),
      mockTendersApi.exportMatrixToSheets(crmTender.id, 'Burst_2', adversarialMatrix),
      mockTendersApi.draftProposalDoc(crmTender),
      mockTendersApi.draftProposalDoc(crmTender),
    ]
    const burstResults = await Promise.all(concurrentPromises)
    expect(burstResults.every((r) => r.ok === true), 'All 4 concurrent burst exports succeeded', 'adversarialStressChecks')
    const burstPaths = burstResults.map((r) => r.path)
    const uniquePaths = new Set(burstPaths)
    expect(uniquePaths.size === 4, 'All 4 concurrent exports generated distinct, non-colliding file paths', 'adversarialStressChecks')
    for (const p of burstPaths) {
      expect(existsSync(p), `Burst export file exists and readable: ${p}`, 'adversarialStressChecks')
      try { unlinkSync(p) } catch {}
    }

    // Clean up temporary export files
    try {
      if (existsSync(exportSheetsRes.path)) unlinkSync(exportSheetsRes.path)
      if (existsSync(emptyMatrixRes.path)) unlinkSync(emptyMatrixRes.path)
      if (existsSync(draftDocsRes.path)) unlinkSync(draftDocsRes.path)
    } catch {}

    // ========================================================================
    // SUMMARY REPORT
    // ========================================================================
    console.log('\n================================================================================')
    console.log('   CHALLENGER 2 VERIFICATION SUMMARY & METRICS')
    console.log('================================================================================')
    console.log(`Total Assertions Evaluated : ${totalTests}`)
    console.log(`Passed Assertions           : ${passedTests}`)
    console.log(`Failed Assertions           : ${failedTests}`)
    console.log('\nBreakdown by Category:')
    console.log(`- Contract Lifecycle & Accounting Checks : ${metrics.lifecycleChecks}`)
    console.log(`- CRM Opportunity Sync & Navigation      : ${metrics.crmSyncChecks}`)
    console.log(`- Sheets & Docs Export Workflows          : ${metrics.exportChecks}`)
    console.log(`- Adversarial Stress & Edge Case Checks  : ${metrics.adversarialStressChecks}`)
    console.log('================================================================================')

    if (failedTests === 0) {
      console.log('🎉 VERDICT: APPROVE — All Milestone 3 Cross-App Workflows empirically verified!\n')
    } else {
      console.error('❌ VERDICT: FAIL — Verification failures detected.\n')
      process.exit(1)
    }

    // Clean up sandbox
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {}

    process.exit(0)
  } catch (err: any) {
    console.error('\n❌ FATAL TEST HARNESS EXCEPTION:', err?.message || err)
    if (err?.stack) console.error(err.stack)
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {}
    process.exit(1)
  }
}

void runChallengerVerification()

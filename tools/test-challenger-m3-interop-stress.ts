#!/usr/bin/env node
/**
 * tools/test-challenger-m3-interop-stress.ts
 *
 * EMPIRICAL ADVERSARIAL STRESS TEST HARNESS FOR MILESTONE 3:
 * Cross-App Interoperability & Export Workflows (R3)
 *
 * Challenger: challenger_1_m3_interop
 *
 * Scope:
 * 1. Books bank reconciliation back-propagation under stress:
 *    - Multiple bank transactions & multiple invoices
 *    - Matching by invoiceId, invoiceNumber, and tenderReference + amount
 *    - Status transition guards (DRAFT milestones, already PAID milestones)
 *    - Partial payments / amount mismatch behavior
 *    - Idempotency / duplicate reconciliation attempts
 *    - Error resilience on missing / corrupt data
 *
 * 2. CRM sync deduplication:
 *    - Rapid-fire 10x sequential sync on the same tender
 *    - Rapid-fire 10x concurrent sync (Promise.all) on the same tender
 *    - Exact deal count assertion (exactly 1 deal)
 *    - Metadata accuracy (name, issuer, closing date, value, back-linked ID)
 *    - In-place mutation updates on re-sync
 *    - ID format & payload variations
 *
 * 3. Sheets CSV export robustness:
 *    - Special characters, quotes, commas within fields
 *    - Multiline requirements (\n, \r\n)
 *    - Unicode, currency symbols (R, ±, m³), CJK, emojis
 *    - Large compliance matrix stress test (1,000 rows)
 *    - Empirical round-trip parseability with Zano Sheets' native parseCsv
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Module from 'node:module'

// ----------------------------------------------------------------------------
// Test Harness Bookkeeping
// ----------------------------------------------------------------------------
let passedCount = 0
let failedCount = 0
const findings: Array<{ title: string; severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; detail: string }> = []

function assert(condition: boolean, message: string, failureDetails?: string) {
  if (condition) {
    passedCount++
    console.log(`  ✅ PASS: ${message}`)
  } else {
    failedCount++
    console.error(`  ❌ FAIL: ${message}`)
    if (failureDetails) {
      console.error(`     Details: ${failureDetails}`)
    }
  }
}

// ----------------------------------------------------------------------------
// Mock Electron Environment
// ----------------------------------------------------------------------------
const ipcHandlers: Record<string, (...args: any[]) => any> = {}
const testDir = join(tmpdir(), `challenger-m3-interop-${randomUUID().slice(0, 8)}`)
mkdirSync(testDir, { recursive: true })

const webContentsBroadcasts: Array<{ channel: string; data: any }> = []

const mockApp = {
  getPath: (name: string) => testDir,
  isReady: () => true,
}

const mockShell = {
  openPath: async (targetPath: string) => (existsSync(targetPath) ? '' : 'File not found'),
}

const mockIpcMain = {
  handle: (channel: string, listener: (...args: any[]) => any) => {
    ipcHandlers[channel] = listener
  },
}

class MockWebContentsView {
  webContents = {
    isDestroyed: () => false,
    send: (channel: string, data: any) => {
      webContentsBroadcasts.push({ channel, data })
    },
    loadURL: async () => {},
    loadFile: async () => {},
    once: () => {},
  }
}

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
const tendersIpcModule = require('../apps/tenders/src/shared/ipc.ts')
const TENDERS_CHANNELS = tendersIpcModule.TENDERS_CHANNELS

const tendersMain = require('../apps/tenders/src/main/tenders-main.ts')
const booksMain = require('../apps/books/src/main/books-main.ts')
const { parseCsv } = require('../apps/sheets/src/gateway/csv-import.ts')

const {
  registerTendersIpc,
  registerTendersWebContents,
  configureTendersRuntime,
  readTendersStore,
  writeTendersStore,
} = tendersMain

const {
  readBooksStore,
  writeBooksStore,
  executeReconciliation,
  computeSettlementSuggestions,
  DEFAULT_BOOK_SETTINGS,
} = booksMain

// Initialize Tenders IPC & WebContents
registerTendersIpc()
const mockView = new MockWebContentsView()
registerTendersWebContents(mockView.webContents as any)

let lastOpenedPath: string | undefined
let lastOpenedCrmDealId: string | undefined

configureTendersRuntime({
  openGeneratedPath: (path: string) => {
    lastOpenedPath = path
  },
  onOpenCrm: (dealId: string) => {
    lastOpenedCrmDealId = dealId
  },
})

// Paths in isolated test directory
const tendersDataPath = join(testDir, 'tenders', 'tenders-data.json')
mkdirSync(join(testDir, 'tenders'), { recursive: true })

const booksDataPath = join(testDir, 'books', 'books-data.json')
mkdirSync(join(testDir, 'books'), { recursive: true })

const crmDealsPath = join(testDir, 'crm', 'deals.json')
mkdirSync(join(testDir, 'crm'), { recursive: true })

// ----------------------------------------------------------------------------
// MAIN EXECUTION
// ----------------------------------------------------------------------------
async function runAllStressTests() {
  console.log('======================================================================')
  console.log('   EMPIRICAL ADVERSARIAL STRESS TEST: MILESTONE 3 INTEROPERABILITY    ')
  console.log('======================================================================\n')

  // ==========================================================================
  // SUITE 1: BOOKS BANK RECONCILIATION BACK-PROPAGATION UNDER STRESS
  // ==========================================================================
  console.log('--- SUITE 1: Books Bank Reconciliation Back-Propagation Under Stress ---')

  // Setup initial Tenders store with multiple tenders and diverse milestones
  const initialTendersStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeWorkspaceId: 'ws-stress',
    workspaces: [
      {
        id: 'ws-stress',
        name: 'Stress Test Workspace',
        tenders: [
          {
            id: 'tender-stress-01',
            referenceNumber: 'RFP-STR-01',
            title: 'Water Reticulation Project Phase 1',
            issuingBody: 'City of Tshwane',
            closingDate: '2026-11-30',
            estimatedValue: 500000,
            status: 'ACTIVE',
            milestones: [
              {
                id: 'ms-inv-id',
                title: 'Phase 1 Mobilization',
                amount: 120000,
                status: 'BILLED',
                billedInvoiceId: 'inv-recon-01',
                billedInvoiceNumber: 'INV-2026-R01',
              },
              {
                id: 'ms-inv-num',
                title: 'Phase 1 Trenching & Piping',
                amount: 180000,
                status: 'BILLED',
                // No billedInvoiceId, will match via billedInvoiceNumber
                billedInvoiceNumber: 'INV-2026-R02',
              },
              {
                id: 'ms-ref-amount',
                title: 'Phase 1 Commissioning',
                amount: 200000,
                status: 'REACHED',
                // Neither invoiceId nor invoiceNumber set; will match via tenderReference + amount
              },
              {
                id: 'ms-draft',
                title: 'Phase 1 Retention / Closeout',
                amount: 50000,
                status: 'DRAFT', // Should NOT be paid even if ref matches!
              },
            ],
          },
          {
            id: 'tender-stress-02',
            referenceNumber: 'RFP-STR-02',
            title: 'Substation Transformer Supply',
            issuingBody: 'Eskom Holdings',
            closingDate: '2026-12-15',
            estimatedValue: 750000,
            status: 'ACTIVE',
            milestones: [
              {
                id: 'ms-eskom-01',
                title: 'Factory Acceptance Test',
                amount: 300000,
                status: 'BILLED',
                billedInvoiceId: 'inv-eskom-01',
                billedInvoiceNumber: 'INV-ESKOM-001',
              },
              {
                id: 'ms-eskom-already-paid',
                title: 'Initial Deposit',
                amount: 100000,
                status: 'PAID',
                paidAt: '2026-08-01T10:00:00.000Z',
                billedInvoiceId: 'inv-eskom-dep',
              },
            ],
          },
        ],
        documents: [],
      },
    ],
  }
  writeTendersStore(tendersDataPath, initialTendersStore)

  // Setup initial Books store
  const initialBooksStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_BOOK_SETTINGS },
    accounts: [
      { id: 'acc-bank', code: '1000', name: 'FNB Business Cheque Account', type: 'Asset', balance: 50000 },
      { id: 'acc-ar', code: '1200', name: 'Accounts Receivable (Debtors)', type: 'Asset', balance: 900000 },
      { id: 'acc-ap', code: '2000', name: 'Accounts Payable (Creditors)', type: 'Liability', balance: 0 },
      { id: 'acc-sales', code: '4000', name: 'Sales / Fee Revenue', type: 'Income', balance: 0 },
      { id: 'acc-vat-out', code: '2150', name: 'VAT Output Liability (15%)', type: 'Liability', balance: 0 },
    ],
    parties: [
      { id: 'pty-tshwane', name: 'City of Tshwane', type: 'Customer', outstandingBalance: 500000 },
      { id: 'pty-eskom', name: 'Eskom Holdings', type: 'Customer', outstandingBalance: 400000 },
    ],
    invoices: [
      {
        id: 'inv-recon-01',
        invoiceNumber: 'INV-2026-R01',
        type: 'Sales',
        partyId: 'pty-tshwane',
        partyName: 'City of Tshwane',
        date: '2026-09-01',
        dueDate: '2026-09-30',
        items: [{ description: 'Mobilization', quantity: 1, rate: 104347.83, amount: 104347.83, taxRate: 15, taxAmount: 15652.17 }],
        subtotal: 104347.83,
        taxTotal: 15652.17,
        grandTotal: 120000,
        outstandingAmount: 120000,
        status: 'Unpaid',
        tenderReference: 'RFP-STR-01',
      },
      {
        id: 'inv-recon-02',
        invoiceNumber: 'INV-2026-R02',
        type: 'Sales',
        partyId: 'pty-tshwane',
        partyName: 'City of Tshwane',
        date: '2026-09-02',
        dueDate: '2026-10-02',
        items: [{ description: 'Trenching & Piping', quantity: 1, rate: 156521.74, amount: 156521.74, taxRate: 15, taxAmount: 23478.26 }],
        subtotal: 156521.74,
        taxTotal: 23478.26,
        grandTotal: 180000,
        outstandingAmount: 180000,
        status: 'Unpaid',
        tenderReference: 'RFP-STR-01',
      },
      {
        id: 'inv-recon-03',
        invoiceNumber: 'INV-2026-R03',
        type: 'Sales',
        partyId: 'pty-tshwane',
        partyName: 'City of Tshwane',
        date: '2026-09-03',
        dueDate: '2026-10-03',
        items: [{ description: 'Commissioning', quantity: 1, rate: 173913.04, amount: 173913.04, taxRate: 15, taxAmount: 26086.96 }],
        subtotal: 173913.04,
        taxTotal: 26086.96,
        grandTotal: 200000,
        outstandingAmount: 200000,
        status: 'Unpaid',
        tenderReference: 'RFP-STR-01',
      },
      {
        id: 'inv-recon-draft',
        invoiceNumber: 'INV-2026-R04',
        type: 'Sales',
        partyId: 'pty-tshwane',
        partyName: 'City of Tshwane',
        date: '2026-09-04',
        dueDate: '2026-10-04',
        items: [{ description: 'Retention', quantity: 1, rate: 43478.26, amount: 43478.26, taxRate: 15, taxAmount: 6521.74 }],
        subtotal: 43478.26,
        taxTotal: 6521.74,
        grandTotal: 50000,
        outstandingAmount: 50000,
        status: 'Unpaid',
        tenderReference: 'RFP-STR-01',
      },
    ],
    bankTransactions: [
      { id: 'tx-01', date: '2026-09-05', description: 'DEP TSHWANE INV-2026-R01', amount: 120000, reference: 'FT260905101', reconciled: false },
      { id: 'tx-02', date: '2026-09-06', description: 'DEP TSHWANE PIPING', amount: 180000, reference: 'INV-2026-R02', reconciled: false },
      { id: 'tx-03', date: '2026-09-07', description: 'DEP TSHWANE RFP-STR-01 COMM', amount: 200000, reference: 'REF-COMM', reconciled: false },
      { id: 'tx-draft', date: '2026-09-08', description: 'DEP TSHWANE RETENTION RFP-STR-01', amount: 50000, reference: 'RET-01', reconciled: false },
      { id: 'tx-partial', date: '2026-09-09', description: 'DEP TSHWANE PARTIAL', amount: 60000, reference: 'PARTIAL', reconciled: false },
    ],
    journalEntries: [],
  }
  writeBooksStore(booksDataPath, initialBooksStore)

  // 1.1 Test Suggestion Engine
  const suggestions = computeSettlementSuggestions(readBooksStore(booksDataPath))
  assert(suggestions.length >= 3, `Settlement suggestion engine produced ${suggestions.length} suggestions (expected >= 3)`)
  const sugInv1 = suggestions.find((s: any) => s.invoiceId === 'inv-recon-01')
  assert(sugInv1 !== undefined && sugInv1.confidence === 'HIGH', 'inv-recon-01 suggested with HIGH confidence (invoiceNumber match)')
  const sugInv2 = suggestions.find((s: any) => s.invoiceId === 'inv-recon-02')
  assert(sugInv2 !== undefined && sugInv2.confidence === 'HIGH', 'inv-recon-02 suggested with HIGH confidence (reference invoiceNumber match)')
  const sugInv3 = suggestions.find((s: any) => s.invoiceId === 'inv-recon-03')
  assert(sugInv3 !== undefined && sugInv3.confidence === 'HIGH', 'inv-recon-03 suggested with HIGH confidence (tenderReference match)')

  // 1.2 Multi-Transaction Reconciliation Execution: Match by Invoice ID
  const recon1 = executeReconciliation({
    booksDataPath,
    transactionId: 'tx-01',
    invoiceId: 'inv-recon-01',
    tendersDataPath,
  })
  assert(recon1.ok === true, 'Reconciliation 1 (matchByInvoiceId) succeeded')
  assert(recon1.tenderMilestonePaid === true, 'Reconciliation 1 confirmed tenderMilestonePaid')

  // Verify tenders store updated
  let currentTenders = readTendersStore(tendersDataPath)
  let t1 = currentTenders.workspaces[0].tenders[0]
  let m1 = t1.milestones.find((m: any) => m.id === 'ms-inv-id')
  assert(m1.status === 'PAID', 'ms-inv-id transitioned to PAID')
  assert(typeof m1.paidAt === 'string', `ms-inv-id paidAt set to ${m1.paidAt}`)

  // 1.3 Match by Invoice Number
  const recon2 = executeReconciliation({
    booksDataPath,
    transactionId: 'tx-02',
    invoiceId: 'inv-recon-02',
    tendersDataPath,
  })
  assert(recon2.ok === true, 'Reconciliation 2 (matchByInvoiceNum) succeeded')
  assert(recon2.tenderMilestonePaid === true, 'Reconciliation 2 confirmed tenderMilestonePaid')

  currentTenders = readTendersStore(tendersDataPath)
  t1 = currentTenders.workspaces[0].tenders[0]
  let m2 = t1.milestones.find((m: any) => m.id === 'ms-inv-num')
  assert(m2.status === 'PAID', 'ms-inv-num transitioned to PAID')
  assert(m2.billedInvoiceId === 'inv-recon-02', 'ms-inv-num back-populated with billedInvoiceId')

  // 1.4 Match by Tender Reference + Amount (milestone had no prior invoice linked)
  const recon3 = executeReconciliation({
    booksDataPath,
    transactionId: 'tx-03',
    invoiceId: 'inv-recon-03',
    tendersDataPath,
  })
  assert(recon3.ok === true, 'Reconciliation 3 (matchByRefAndAmount) succeeded')
  assert(recon3.tenderMilestonePaid === true, 'Reconciliation 3 confirmed tenderMilestonePaid')

  currentTenders = readTendersStore(tendersDataPath)
  t1 = currentTenders.workspaces[0].tenders[0]
  let m3 = t1.milestones.find((m: any) => m.id === 'ms-ref-amount')
  assert(m3.status === 'PAID', 'ms-ref-amount transitioned to PAID')
  assert(m3.billedInvoiceId === 'inv-recon-03', 'ms-ref-amount back-populated with billedInvoiceId')
  assert(m3.billedInvoiceNumber === 'INV-2026-R03', 'ms-ref-amount back-populated with billedInvoiceNumber')

  // 1.5 Edge Case: Milestone in 'DRAFT' status must NOT transition to PAID
  const reconDraft = executeReconciliation({
    booksDataPath,
    transactionId: 'tx-draft',
    invoiceId: 'inv-recon-draft',
    tendersDataPath,
  })
  assert(reconDraft.ok === true, 'Reconciliation of invoice with matching DRAFT milestone completed in Books')
  assert(reconDraft.tenderMilestonePaid === false, 'DRAFT milestone was NOT marked PAID (guard verified)')

  currentTenders = readTendersStore(tendersDataPath)
  t1 = currentTenders.workspaces[0].tenders[0]
  let mDraft = t1.milestones.find((m: any) => m.id === 'ms-draft')
  assert(mDraft.status === 'DRAFT', 'ms-draft remained in DRAFT status')

  // 1.6 Idempotency Stress Test: Duplicate reconciliation attempts
  const dupTxRecon = executeReconciliation({
    booksDataPath,
    transactionId: 'tx-01', // Already reconciled
    invoiceId: 'inv-recon-draft',
    tendersDataPath,
  })
  assert(dupTxRecon.ok === false, 'Duplicate tx reconciliation rejected gracefully')
  assert(dupTxRecon.error?.includes('already reconciled') === true, `Expected error message for duplicate tx: ${dupTxRecon.error}`)

  const dupInvRecon = executeReconciliation({
    booksDataPath,
    transactionId: 'tx-partial',
    invoiceId: 'inv-recon-01', // Already Paid
    tendersDataPath,
  })
  assert(dupInvRecon.ok === false, 'Reconciliation of already Paid invoice rejected gracefully')
  assert(dupInvRecon.error?.includes('already marked Paid') === true, `Expected error message for already paid invoice: ${dupInvRecon.error}`)

  // 1.7 Amount Mismatch / Partial Payment Suggestion Exclusion
  const updatedBooks = readBooksStore(booksDataPath)
  const partialSuggestions = computeSettlementSuggestions(updatedBooks)
  const partialMatch = partialSuggestions.find((s: any) => s.transactionId === 'tx-partial')
  assert(partialMatch === undefined, 'Partial payment tx (R 60,000 vs R 50,000/R 120,000) not suggested for settlement')

  // 1.8 Error Resilience: Invalid / Corrupt / Missing Tenders Store
  const nonExistentTendersPath = join(testDir, 'non-existent', 'tenders.json')
  const bData = readBooksStore(booksDataPath)
  bData.invoices.push({
    id: 'inv-orphaned',
    invoiceNumber: 'INV-ORPHAN',
    type: 'Sales',
    partyId: 'pty-tshwane',
    partyName: 'City of Tshwane',
    date: '2026-09-10',
    dueDate: '2026-10-10',
    items: [{ description: 'Orphan', quantity: 1, rate: 10000, amount: 10000, taxRate: 15, taxAmount: 1500 }],
    subtotal: 10000,
    taxTotal: 1500,
    grandTotal: 11500,
    outstandingAmount: 11500,
    status: 'Unpaid',
    tenderReference: 'RFP-DOES-NOT-EXIST',
  })
  bData.bankTransactions.push({
    id: 'tx-orphan',
    date: '2026-09-10',
    description: 'DEP ORPHAN',
    amount: 11500,
    reference: 'ORPHAN',
    reconciled: false,
  })
  writeBooksStore(booksDataPath, bData)

  const reconMissingTenders = executeReconciliation({
    booksDataPath,
    transactionId: 'tx-orphan',
    invoiceId: 'inv-orphaned',
    tendersDataPath: nonExistentTendersPath,
  })
  assert(reconMissingTenders.ok === true, 'Reconciliation with non-existent tenders file succeeds safely for Books')
  assert(reconMissingTenders.tenderMilestonePaid === false, 'tenderMilestonePaid is false when tenders file does not exist')

  // Corrupted tenders store resilience
  const corruptTendersPath = join(testDir, 'corrupt-tenders.json')
  writeFileSync(corruptTendersPath, '{ invalid json syntax !!!', 'utf8')
  bData.bankTransactions.push({
    id: 'tx-corrupt',
    date: '2026-09-11',
    description: 'DEP CORRUPT',
    amount: 11500,
    reference: 'CORRUPT',
    reconciled: false,
  })
  bData.invoices.push({
    id: 'inv-corrupt',
    invoiceNumber: 'INV-CORRUPT',
    type: 'Sales',
    partyId: 'pty-tshwane',
    partyName: 'City of Tshwane',
    date: '2026-09-11',
    dueDate: '2026-10-11',
    items: [{ description: 'Corrupt Test', quantity: 1, rate: 10000, amount: 10000, taxRate: 15, taxAmount: 1500 }],
    subtotal: 10000,
    taxTotal: 1500,
    grandTotal: 11500,
    outstandingAmount: 11500,
    status: 'Unpaid',
    tenderReference: 'RFP-STR-01',
  })
  writeBooksStore(booksDataPath, bData)

  const reconCorruptTenders = executeReconciliation({
    booksDataPath,
    transactionId: 'tx-corrupt',
    invoiceId: 'inv-corrupt',
    tendersDataPath: corruptTendersPath,
  })
  assert(reconCorruptTenders.ok === true, 'Reconciliation with corrupted tenders file survives and completes in Books')
  assert(reconCorruptTenders.tenderMilestonePaid === false, 'tenderMilestonePaid is false on corrupt store without crash')

  // 1.9 Single Milestone Settlement Invariant (Loop Break Verification)
  // When multiple milestones have identical amounts & tender reference, exactly ONE milestone settles per invoice.
  const loopBreakTendersStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeWorkspaceId: 'ws-loop',
    workspaces: [
      {
        id: 'ws-loop',
        name: 'Loop Break Workspace',
        tenders: [
          {
            id: 'tender-dup-milestones',
            referenceNumber: 'RFP-DUP-01',
            title: 'Water Pipe Twin Valves Delivery',
            issuingBody: 'City of Tshwane',
            closingDate: '2026-11-30',
            estimatedValue: 150000,
            status: 'ACTIVE',
            milestones: [
              {
                id: 'ms-dup-1',
                title: 'Valve Unit A Delivery',
                amount: 75000,
                status: 'BILLED',
              },
              {
                id: 'ms-dup-2',
                title: 'Valve Unit B Delivery',
                amount: 75000,
                status: 'BILLED',
              },
            ],
          },
        ],
        documents: [],
      },
    ],
  }
  const loopTendersPath = join(testDir, 'loop-tenders.json')
  writeTendersStore(loopTendersPath, loopBreakTendersStore)

  const loopBooksStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_BOOK_SETTINGS },
    accounts: [
      { id: 'acc-bank', code: '1000', name: 'FNB Business Cheque Account', type: 'Asset', balance: 100000 },
      { id: 'acc-ar', code: '1200', name: 'Accounts Receivable (Debtors)', type: 'Asset', balance: 150000 },
      { id: 'acc-ap', code: '2000', name: 'Accounts Payable (Creditors)', type: 'Liability', balance: 0 },
      { id: 'acc-sales', code: '4000', name: 'Sales / Fee Revenue', type: 'Income', balance: 0 },
      { id: 'acc-vat-out', code: '2150', name: 'VAT Output Liability (15%)', type: 'Liability', balance: 0 },
    ],
    parties: [
      { id: 'pty-tshwane-loop', name: 'City of Tshwane Loop', type: 'Customer', outstandingBalance: 150000 },
    ],
    invoices: [
      {
        id: 'inv-dup-1',
        invoiceNumber: 'INV-DUP-01',
        type: 'Sales',
        partyId: 'pty-tshwane-loop',
        partyName: 'City of Tshwane Loop',
        date: '2026-09-01',
        dueDate: '2026-09-30',
        items: [{ description: 'Valve Unit A', quantity: 1, rate: 65217.39, amount: 65217.39, taxRate: 15, taxAmount: 9782.61 }],
        subtotal: 65217.39,
        taxTotal: 9782.61,
        grandTotal: 75000,
        outstandingAmount: 75000,
        status: 'Unpaid',
        tenderReference: 'RFP-DUP-01',
      },
      {
        id: 'inv-dup-2',
        invoiceNumber: 'INV-DUP-02',
        type: 'Sales',
        partyId: 'pty-tshwane-loop',
        partyName: 'City of Tshwane Loop',
        date: '2026-09-02',
        dueDate: '2026-10-02',
        items: [{ description: 'Valve Unit B', quantity: 1, rate: 65217.39, amount: 65217.39, taxRate: 15, taxAmount: 9782.61 }],
        subtotal: 65217.39,
        taxTotal: 9782.61,
        grandTotal: 75000,
        outstandingAmount: 75000,
        status: 'Unpaid',
        tenderReference: 'RFP-DUP-01',
      },
    ],
    bankTransactions: [
      { id: 'tx-dup-1', date: '2026-09-05', description: 'DEP TSHWANE VALVE A', amount: 75000, reference: 'TX-DUP-01', reconciled: false },
      { id: 'tx-dup-2', date: '2026-09-06', description: 'DEP TSHWANE VALVE B', amount: 75000, reference: 'TX-DUP-02', reconciled: false },
    ],
    journalEntries: [],
  }
  const loopBooksPath = join(testDir, 'loop-books.json')
  writeBooksStore(loopBooksPath, loopBooksStore)

  // Reconcile FIRST transaction against FIRST invoice
  const loopRecon1 = executeReconciliation({
    booksDataPath: loopBooksPath,
    transactionId: 'tx-dup-1',
    invoiceId: 'inv-dup-1',
    tendersDataPath: loopTendersPath,
  })
  assert(loopRecon1.ok === true, 'First duplicate-amount reconciliation succeeded')
  assert(loopRecon1.tenderMilestonePaid === true, 'First reconciliation confirmed tenderMilestonePaid')
  assert(loopRecon1.matchedMilestoneId === 'ms-dup-1', 'First reconciliation matched ms-dup-1 specifically')

  const loopTendersAfter1 = readTendersStore(loopTendersPath)
  const ms1After = loopTendersAfter1.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-dup-1')
  const ms2After = loopTendersAfter1.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-dup-2')
  assert(ms1After.status === 'PAID', 'First milestone ms-dup-1 transitioned to PAID')
  assert(ms2After.status === 'BILLED', 'ISOLATION / LOOP BREAK GUARD: Second milestone ms-dup-2 remains BILLED (not falsely paid)')

  // 1.10 Double-Entry Accounting Invariant Checks
  const loopBooksAfter1 = readBooksStore(loopBooksPath)
  const arAcc = loopBooksAfter1.accounts.find((a: any) => a.id === 'acc-ar')
  const partyAfter1 = loopBooksAfter1.parties.find((p: any) => p.id === 'pty-tshwane-loop')
  assert(arAcc.balance === 75000, 'AR balance reduced by exact settled amount (150,000 - 75,000 = 75,000)')
  assert(partyAfter1.outstandingBalance === 75000, 'Party outstanding balance reduced by settled amount')
  const lastJE = loopBooksAfter1.journalEntries[0]
  assert(lastJE !== undefined, 'Settlement journal entry exists')
  assert(lastJE.totalDebit === 75000 && lastJE.totalCredit === 75000, 'Settlement journal entry is strictly balanced (Debit === Credit === 75,000)')

  // Now reconcile SECOND transaction against SECOND invoice
  const loopRecon2 = executeReconciliation({
    booksDataPath: loopBooksPath,
    transactionId: 'tx-dup-2',
    invoiceId: 'inv-dup-2',
    tendersDataPath: loopTendersPath,
  })
  assert(loopRecon2.ok === true, 'Second duplicate-amount reconciliation succeeded')
  assert(loopRecon2.tenderMilestonePaid === true, 'Second reconciliation confirmed tenderMilestonePaid')
  assert(loopRecon2.matchedMilestoneId === 'ms-dup-2', 'Second reconciliation matched remaining un-paid milestone ms-dup-2')

  const loopTendersAfter2 = readTendersStore(loopTendersPath)
  const ms2After2 = loopTendersAfter2.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-dup-2')
  assert(ms2After2.status === 'PAID', 'Second milestone ms-dup-2 transitioned to PAID after its own reconciliation')

  // 1.11 Already PAID Milestone Invariant
  // When all milestones under a tender are PAID, a subsequent invoice does not falsely re-pay already paid milestones
  const extraBooks = readBooksStore(loopBooksPath)
  extraBooks.invoices.push({
    id: 'inv-dup-extra',
    invoiceNumber: 'INV-DUP-EXTRA',
    type: 'Sales',
    partyId: 'pty-tshwane-loop',
    partyName: 'City of Tshwane Loop',
    date: '2026-09-03',
    dueDate: '2026-10-03',
    items: [{ description: 'Extra', quantity: 1, rate: 65217.39, amount: 65217.39, taxRate: 15, taxAmount: 9782.61 }],
    subtotal: 65217.39,
    taxTotal: 9782.61,
    grandTotal: 75000,
    outstandingAmount: 75000,
    status: 'Unpaid',
    tenderReference: 'RFP-DUP-01',
  })
  extraBooks.bankTransactions.push({
    id: 'tx-dup-extra',
    date: '2026-09-07',
    description: 'DEP TSHWANE EXTRA',
    amount: 75000,
    reference: 'TX-EXTRA',
    reconciled: false,
  })
  writeBooksStore(loopBooksPath, extraBooks)

  const loopReconExtra = executeReconciliation({
    booksDataPath: loopBooksPath,
    transactionId: 'tx-dup-extra',
    invoiceId: 'inv-dup-extra',
    tendersDataPath: loopTendersPath,
  })
  assert(loopReconExtra.ok === true, 'Books reconciliation for extra invoice succeeded')
  assert(loopReconExtra.tenderMilestonePaid === false, 'tenderMilestonePaid is FALSE when all matching milestones are already PAID')

  // 1.12 Multi-Workspace Milestone Resolution
  // Verify that milestones in secondary workspaces (not just index 0) are located and settled
  const multiWsTendersStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeWorkspaceId: 'ws-primary',
    workspaces: [
      { id: 'ws-primary', name: 'Primary WS', tenders: [], documents: [] },
      {
        id: 'ws-secondary',
        name: 'Secondary WS',
        tenders: [
          {
            id: 'tender-ws-2',
            referenceNumber: 'RFP-WS2-99',
            title: 'Secondary Workspace Tender',
            issuingBody: 'Rand Water',
            closingDate: '2026-12-01',
            estimatedValue: 85000,
            status: 'ACTIVE',
            milestones: [
              {
                id: 'ms-ws2-milestone',
                title: 'WS2 Delivery',
                amount: 85000,
                status: 'BILLED',
                billedInvoiceId: 'inv-ws2-01',
              },
            ],
          },
        ],
        documents: [],
      },
    ],
  }
  const multiWsTendersPath = join(testDir, 'multi-ws-tenders.json')
  writeTendersStore(multiWsTendersPath, multiWsTendersStore)

  const ws2BooksStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_BOOK_SETTINGS },
    accounts: [
      { id: 'acc-bank', code: '1000', name: 'Bank', type: 'Asset', balance: 0 },
      { id: 'acc-ar', code: '1200', name: 'AR', type: 'Asset', balance: 85000 },
    ],
    parties: [{ id: 'pty-rand', name: 'Rand Water', type: 'Customer', outstandingBalance: 85000 }],
    invoices: [
      {
        id: 'inv-ws2-01',
        invoiceNumber: 'INV-WS2-001',
        type: 'Sales',
        partyId: 'pty-rand',
        partyName: 'Rand Water',
        date: '2026-09-01',
        dueDate: '2026-09-30',
        items: [],
        subtotal: 73913.04,
        taxTotal: 11086.96,
        grandTotal: 85000,
        outstandingAmount: 85000,
        status: 'Unpaid',
        tenderReference: 'RFP-WS2-99',
      },
    ],
    bankTransactions: [
      { id: 'tx-ws2-01', date: '2026-09-05', description: 'DEP RAND WATER', amount: 85000, reference: 'WS2-DEP', reconciled: false },
    ],
    journalEntries: [],
  }
  const ws2BooksPath = join(testDir, 'ws2-books.json')
  writeBooksStore(ws2BooksPath, ws2BooksStore)

  const reconWs2 = executeReconciliation({
    booksDataPath: ws2BooksPath,
    transactionId: 'tx-ws2-01',
    invoiceId: 'inv-ws2-01',
    tendersDataPath: multiWsTendersPath,
  })
  assert(reconWs2.ok === true, 'Multi-workspace reconciliation succeeded')
  assert(reconWs2.tenderMilestonePaid === true, 'Milestone in secondary workspace resolved and paid')
  const multiWsAfter = readTendersStore(multiWsTendersPath)
  const msWs2 = multiWsAfter.workspaces[1].tenders[0].milestones[0]
  assert(msWs2.status === 'PAID', 'Secondary workspace milestone ms-ws2-milestone is PAID')

  console.log('\n--- SUITE 2: CRM Sync Deduplication Stress Test ---')
  // ==========================================================================
  // SUITE 2: CRM SYNC DEDUPLICATION UNDER STRESS
  // ==========================================================================

  const testTender = {
    id: 'tender-dedup-42',
    referenceNumber: 'RFP-WATER-DEDUP-2026',
    title: 'Johannesburg Bulk Water Meter Automated Reading',
    issuingBody: 'Johannesburg Water SOC Ltd',
    closingDate: '2026-11-15',
    estimatedValue: 480000,
    status: 'ACTIVE',
    requirements: [],
    milestones: [],
  }

  // Setup tenders store with testTender
  const dedupTendersStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeWorkspaceId: 'ws-dedup',
    workspaces: [
      {
        id: 'ws-dedup',
        name: 'Dedup Workspace',
        tenders: [testTender],
        documents: [],
      },
    ],
  }
  writeTendersStore(tendersDataPath, dedupTendersStore)

  const syncHandler = ipcHandlers[TENDERS_CHANNELS.syncWithCrm]
  assert(typeof syncHandler === 'function', 'syncWithCrm IPC handler is registered')

  // 2.1 Rapid-fire 10x Sequential Sync
  console.log('  Executing 10x sequential sync on tender-dedup-42...')
  const sequentialResults: any[] = []
  for (let i = 1; i <= 10; i++) {
    const res = await syncHandler(null, {
      tender: testTender,
      tendersPath: tendersDataPath,
      crmDealsPath,
    })
    sequentialResults.push(res)
  }

  assert(sequentialResults.every((r) => r.ok === true), 'All 10 sequential sync calls returned ok: true')
  const expectedDealId = 'deal-tender-tender-dedup-42'
  assert(sequentialResults.every((r) => r.dealId === expectedDealId), `All 10 calls returned deterministic dealId: ${expectedDealId}`)

  // Verify CRM deals.json contains exactly 1 deal
  const crmRaw = readFileSync(crmDealsPath, 'utf8')
  const crmEnvelope = JSON.parse(crmRaw)
  const deals = Array.isArray(crmEnvelope) ? crmEnvelope : crmEnvelope.deals
  assert(Array.isArray(deals), 'CRM storage contains valid deals array')
  assert(deals.length === 1, `Deals array length after 10 sequential syncs is exactly 1 (actual: ${deals.length})`)

  const deal = deals[0]
  assert(deal.id === expectedDealId, `Deal ID matches deterministic contract: ${deal.id}`)
  assert(deal.name === `${testTender.referenceNumber} - ${testTender.title}`, `Deal name formatted correctly: ${deal.name}`)
  assert(deal.companyName === testTender.issuingBody, `Deal companyName matches tender issuer: ${deal.companyName}`)
  assert(deal.amount === testTender.estimatedValue, `Deal amount matches estimatedValue: ${deal.amount}`)
  assert(deal.expectedCloseDate === testTender.closingDate, `Deal expectedCloseDate matches closingDate: ${deal.expectedCloseDate}`)
  assert(deal.tenderReference === testTender.referenceNumber, `Deal tenderReference matches RFP ref: ${deal.tenderReference}`)
  assert(deal.tenderId === testTender.id, `Deal tenderId matches tender ID: ${deal.tenderId}`)
  assert(deal.stage === 'proposal', `Deal initial stage is 'proposal': ${deal.stage}`)

  // Verify back-linked ID on Tender in tenders-data.json
  const tendersAfterSync = readTendersStore(tendersDataPath)
  const tenderAfterSync = tendersAfterSync.workspaces[0].tenders.find((t: any) => t.id === testTender.id)
  assert(tenderAfterSync.linkedCrmDealId === expectedDealId, `Tender linkedCrmDealId back-propagated onto TenderRecord: ${tenderAfterSync.linkedCrmDealId}`)

  // 2.2 Rapid-fire 10x Concurrent Sync (Promise.all)
  console.log('  Executing 10x concurrent sync (Promise.all) on tender-dedup-42...')
  const concurrentPromises = Array.from({ length: 10 }, () =>
    syncHandler(null, {
      tender: testTender,
      tendersPath: tendersDataPath,
      crmDealsPath,
    })
  )
  const concurrentResults = await Promise.all(concurrentPromises)
  assert(concurrentResults.every((r) => r.ok === true), 'All 10 concurrent sync calls resolved successfully')

  const crmRawConcurrent = readFileSync(crmDealsPath, 'utf8')
  const crmEnvelopeConcurrent = JSON.parse(crmRawConcurrent)
  const dealsConcurrent = Array.isArray(crmEnvelopeConcurrent) ? crmEnvelopeConcurrent : crmEnvelopeConcurrent.deals
  assert(dealsConcurrent.length === 1, `Deals array length after 10 concurrent syncs is still exactly 1 (actual: ${dealsConcurrent.length})`)

  // 2.3 Re-sync with Mutated Tender Fields (In-Place Update)
  console.log('  Executing re-sync with mutated tender fields (increased amount & updated date)...')
  const updatedTender = {
    ...testTender,
    title: 'Johannesburg Bulk Water Meter Automated Reading - EXPANDED SCOPE',
    estimatedValue: 620000,
    closingDate: '2026-12-31',
  }
  const updateRes = await syncHandler(null, {
    tender: updatedTender,
    tendersPath: tendersDataPath,
    crmDealsPath,
  })
  assert(updateRes.ok === true, 'Update sync returned ok: true')

  const crmRawUpdated = readFileSync(crmDealsPath, 'utf8')
  const crmEnvelopeUpdated = JSON.parse(crmRawUpdated)
  const dealsUpdated = Array.isArray(crmEnvelopeUpdated) ? crmEnvelopeUpdated : crmEnvelopeUpdated.deals
  assert(dealsUpdated.length === 1, 'Deals array length remained 1 after mutation update')
  const updatedDeal = dealsUpdated[0]
  assert(updatedDeal.amount === 620000, `Deal amount updated to R 620,000 (actual: ${updatedDeal.amount})`)
  assert(updatedDeal.expectedCloseDate === '2026-12-31', `Deal expectedCloseDate updated to 2026-12-31 (actual: ${updatedDeal.expectedCloseDate})`)
  assert(updatedDeal.name.includes('EXPANDED SCOPE'), 'Deal name updated to reflect new title')

  // 2.4 Varied Payload Resolution (resolving via tenderId, tenderReference, id)
  const syncByTenderId = await syncHandler(null, {
    tenderId: testTender.id,
    tendersPath: tendersDataPath,
    crmDealsPath,
  })
  assert(syncByTenderId.ok === true && syncByTenderId.dealId === expectedDealId, 'Sync by tenderId resolves to existing deal without duplicate')

  const syncByDealId = await syncHandler(null, {
    id: expectedDealId,
    tendersPath: tendersDataPath,
    crmDealsPath,
  })
  assert(syncByDealId.ok === true && syncByDealId.dealId === expectedDealId, 'Sync by dealId resolves to existing deal without duplicate')

  const crmRawVaried = readFileSync(crmDealsPath, 'utf8')
  const dealsVaried = JSON.parse(crmRawVaried).deals
  assert(dealsVaried.length === 1, 'Total deal count remains 1 across all payload invocation forms')

  // 2.5 Multi-tender isolation
  const secondTender = {
    id: 'tender-second-99',
    referenceNumber: 'RFP-ROADS-2026',
    title: 'Provincial Road Resurfacing',
    issuingBody: 'Gauteng Dept of Roads and Transport',
    closingDate: '2026-10-20',
    estimatedValue: 1200000,
    status: 'ACTIVE',
  }
  await syncHandler(null, { tender: secondTender, tendersPath: tendersDataPath, crmDealsPath })
  const dealsMulti = JSON.parse(readFileSync(crmDealsPath, 'utf8')).deals
  assert(dealsMulti.length === 2, `Two distinct tenders produce exactly 2 deals (actual: ${dealsMulti.length})`)

  // 2.6 High-Volume Concurrent Stress (50x Concurrent Sync)
  console.log('  Executing 50x high-volume concurrent sync (Promise.all) on tender-stress-50...')
  const tenderStress50 = {
    id: 'tender-stress-50',
    referenceNumber: 'RFP-MASSIVE-50',
    title: 'Massive Concurrency Infrastructure Upgrade',
    issuingBody: 'Department of Public Works',
    closingDate: '2027-03-31',
    estimatedValue: 3500000,
    status: 'ACTIVE',
  }
  const promises50 = Array.from({ length: 50 }, () =>
    syncHandler(null, {
      tender: tenderStress50,
      tendersPath: tendersDataPath,
      crmDealsPath,
    })
  )
  const results50 = await Promise.all(promises50)
  assert(results50.every((r: any) => r.ok === true), 'All 50 high-volume concurrent sync calls returned ok: true')
  assert(results50.every((r: any) => r.dealId === 'deal-tender-tender-stress-50'), 'All 50 calls returned deterministic dealId')
  const dealsAfter50 = JSON.parse(readFileSync(crmDealsPath, 'utf8')).deals
  const deal50 = dealsAfter50.find((d: any) => d.id === 'deal-tender-tender-stress-50')
  assert(deal50 !== undefined, 'Deal for tender-stress-50 exists in CRM store')
  const count50 = dealsAfter50.filter((d: any) => d.id === 'deal-tender-tender-stress-50').length
  assert(count50 === 1, `Exactly 1 deal exists for tender-stress-50 after 50 concurrent syncs (actual: ${count50})`)

  // 2.7 Interleaved Multi-Tender Concurrency (30x mixed)
  console.log('  Executing 30x interleaved concurrent sync across 3 distinct tenders...')
  const tenderA = { id: 'tender-mix-A', referenceNumber: 'RFP-MIX-A', title: 'Mixed Tender Alpha', issuingBody: 'Alpha Agency', closingDate: '2026-11-01', estimatedValue: 110000 }
  const tenderB = { id: 'tender-mix-B', referenceNumber: 'RFP-MIX-B', title: 'Mixed Tender Beta', issuingBody: 'Beta Board', closingDate: '2026-11-02', estimatedValue: 220000 }
  const tenderC = { id: 'tender-mix-C', referenceNumber: 'RFP-MIX-C', title: 'Mixed Tender Gamma', issuingBody: 'Gamma Group', closingDate: '2026-11-03', estimatedValue: 330000 }

  const mixedCalls: Promise<any>[] = []
  for (let i = 0; i < 10; i++) {
    mixedCalls.push(syncHandler(null, { tender: tenderA, tendersPath: tendersDataPath, crmDealsPath }))
    mixedCalls.push(syncHandler(null, { tender: tenderB, tendersPath: tendersDataPath, crmDealsPath }))
    mixedCalls.push(syncHandler(null, { tender: tenderC, tendersPath: tendersDataPath, crmDealsPath }))
  }
  const mixedResults = await Promise.all(mixedCalls)
  assert(mixedResults.every((r: any) => r.ok === true), 'All 30 interleaved sync calls returned ok: true')
  const dealsAfterMixed = JSON.parse(readFileSync(crmDealsPath, 'utf8')).deals
  const dealA = dealsAfterMixed.find((d: any) => d.id === 'deal-tender-tender-mix-A')
  const dealB = dealsAfterMixed.find((d: any) => d.id === 'deal-tender-tender-mix-B')
  const dealC = dealsAfterMixed.find((d: any) => d.id === 'deal-tender-tender-mix-C')
  assert(dealA && dealB && dealC, 'All 3 interleaved tenders exist as deals in CRM store')
  const countA = dealsAfterMixed.filter((d: any) => d.id === 'deal-tender-tender-mix-A').length
  const countB = dealsAfterMixed.filter((d: any) => d.id === 'deal-tender-tender-mix-B').length
  const countC = dealsAfterMixed.filter((d: any) => d.id === 'deal-tender-tender-mix-C').length
  assert(countA === 1 && countB === 1 && countC === 1, 'Zero duplicate deals created under interleaved concurrency (each count is 1)')

  // 2.8 Special Characters, Unicode, CJK, and Emojis in CRM Deals
  const unicodeTender = {
    id: 'tender-unicode-spec',
    referenceNumber: 'RFP-SPEC/2026 "QUOTED"',
    title: 'Smart Water & "Sewerage" System / 供水系统 🚰🇿🇦 ±5%',
    issuingBody: 'City of Ekurhuleni "Metro" Water & Sanitation Dept',
    closingDate: '2027-01-31',
    estimatedValue: 987654.32,
    status: 'ACTIVE',
  }
  const unicodeSyncRes = await syncHandler(null, { tender: unicodeTender, tendersPath: tendersDataPath, crmDealsPath })
  assert(unicodeSyncRes.ok === true, 'Unicode tender sync returned ok: true')
  const dealsAfterUnicode = JSON.parse(readFileSync(crmDealsPath, 'utf8')).deals
  const unicodeDeal = dealsAfterUnicode.find((d: any) => d.id === 'deal-tender-tender-unicode-spec')
  assert(unicodeDeal !== undefined, 'Unicode deal located in CRM store')
  assert(unicodeDeal.name.includes('供水系统 🚰🇿🇦 ±5%'), 'Deal name accurately preserves CJK and emojis')
  assert(unicodeDeal.companyName === unicodeTender.issuingBody, 'Deal companyName accurately preserves internal quotes and ampersands')
  assert(unicodeDeal.amount === 987654.32, 'Deal amount preserves exact fractional value')

  // 2.9 Non-Destructive Sync / Unrelated CRM Deals Preservation
  // Inject a manually created CRM deal not associated with Tenders
  const manualCrmDeal = {
    id: 'deal-crm-manual-999',
    name: 'Private Client Commercial Advisory',
    companyName: 'Private Equity Corp',
    amount: 1500000,
    stage: 'won',
    probability: 100,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
  const currentCrmRaw = JSON.parse(readFileSync(crmDealsPath, 'utf8'))
  currentCrmRaw.deals.push(manualCrmDeal)
  writeFileSync(crmDealsPath, JSON.stringify(currentCrmRaw, null, 2), 'utf8')

  // Sync an existing tender again
  await syncHandler(null, { tender: testTender, tendersPath: tendersDataPath, crmDealsPath })
  const dealsAfterPreserve = JSON.parse(readFileSync(crmDealsPath, 'utf8')).deals
  const preservedManual = dealsAfterPreserve.find((d: any) => d.id === 'deal-crm-manual-999')
  assert(preservedManual !== undefined, 'Manual non-tender CRM deal preserved during external sync')
  assert(preservedManual.stage === 'won' && preservedManual.amount === 1500000, 'Manual CRM deal properties remain completely untouched')

  // 2.10 Boundary and Malformed Amount & Date Handling
  const boundaryTender = {
    id: 'tender-boundary-zero',
    referenceNumber: 'RFP-BOUND-0',
    title: 'Zero-Value Tender Without Closing Date',
    issuingBody: 'Free Assessment Body',
    closingDate: '', // empty closing date
    estimatedValue: 0,
  }
  const boundarySyncRes = await syncHandler(null, { tender: boundaryTender, tendersPath: tendersDataPath, crmDealsPath })
  assert(boundarySyncRes.ok === true, 'Boundary sync with zero amount and empty closingDate succeeded')
  const boundaryDeal = JSON.parse(readFileSync(crmDealsPath, 'utf8')).deals.find((d: any) => d.id === 'deal-tender-tender-boundary-zero')
  assert(boundaryDeal !== undefined && boundaryDeal.amount === 0, 'Deal amount safely defaulted to 0')
  assert(boundaryDeal.expectedCloseDate === undefined || boundaryDeal.expectedCloseDate === '', 'Empty closingDate handled gracefully')

  console.log('\n--- SUITE 3: Sheets CSV Export Robustness Stress Test ---')
  // ==========================================================================
  // SUITE 3: SHEETS CSV EXPORT ROBUSTNESS
  // ==========================================================================

  const exportSheetsHandler = ipcHandlers[TENDERS_CHANNELS.exportMatrixToSheets]
  assert(typeof exportSheetsHandler === 'function', 'exportMatrixToSheets IPC handler is registered')

  // Adversarial matrix rows with edge cases
  const adversarialRows = [
    {
      id: 'REQ-EDGE-01',
      category: 'LEGAL_COMPLIANCE',
      title: 'Company Registration (CIPC) & Tax Clearance Certificate',
      isMandatory: true,
      status: 'FULFILLED',
      linkedVaultDocId: 'vd-cipc-01',
      healthStatus: 'VALID',
      notes: 'Clean document, no commas or quotes',
    },
    {
      id: 'REQ-EDGE-02',
      category: 'TECHNICAL_SPEC',
      title: 'Supply, delivery, installation, testing, and commissioning of Class-C smart water meters',
      isMandatory: true,
      status: 'UNDER_REVIEW',
      linkedVaultDocId: null,
      healthStatus: 'NO_ATTACHMENT',
      notes: 'Contains multiple commas: one, two, three, four items in list',
    },
    {
      id: 'REQ-EDGE-03',
      category: 'QUALITY_ASSURANCE',
      title: 'Manufacturer must hold "ISO 9001:2015" and "SABS 1529-1" certifications with "SANAS" accreditation',
      isMandatory: true,
      status: 'ACTION_REQUIRED',
      linkedVaultDocId: 'vd-sabs',
      healthStatus: 'EXPIRING_SOON',
      notes: 'Contains double quotes "inside" text and "nested ""quotes"""',
    },
    {
      id: 'REQ-EDGE-04',
      category: 'DELIVERY_SCHEDULE',
      title: 'Phase 1: Mobilization (30 Days)\nPhase 2: Pipe Laying (60 Days)\nPhase 3: Testing & Handover (15 Days)',
      isMandatory: false,
      status: 'UNDER_REVIEW',
      linkedVaultDocId: null,
      healthStatus: 'NO_ATTACHMENT',
      notes: 'Multiline requirement text with embedded newlines (\n) across 3 lines',
    },
    {
      id: 'REQ-EDGE-05',
      category: 'FINANCIAL_PROPOSAL',
      title: 'Total bid price: R 1,250,000.00 ± 5% (incl. 15% VAT); Flow: 250m³/h; CJK: 供水管道系统; Emojis: 🚰🇿🇦',
      isMandatory: true,
      status: 'FULFILLED',
      linkedVaultDocId: 'vd-pricing',
      healthStatus: 'VALID',
      notes: 'Rich unicode: currency R, ± symbol, m³ exponent, CJK characters, emojis',
    },
    {
      id: 'REQ-EDGE-06',
      category: 'SECURITY_INJECTION',
      title: '=cmd|"/c calc"!A1 + @SUM(1,2) - 100',
      isMandatory: false,
      status: 'UNDER_REVIEW',
      linkedVaultDocId: null,
      healthStatus: 'NO_ATTACHMENT',
      notes: '=HYPERLINK("http://attacker.com", "Click Here")',
    },
    {
      id: 'REQ-EDGE-07',
      category: '',
      title: '',
      isMandatory: false,
      status: '',
      linkedVaultDocId: null,
      healthStatus: '',
      notes: '',
    },
  ]

  const exportRes = await exportSheetsHandler(null, 'tender-adv-01', 'Bulk Water Metering & Valve Refurbishment', adversarialRows)
  assert(exportRes.ok === true, 'exportMatrixToSheets returned ok: true')
  assert(typeof exportRes.path === 'string' && existsSync(exportRes.path), `Exported CSV file exists at: ${exportRes.path}`)

  const csvBytes = readFileSync(exportRes.path)
  // Check UTF-8 BOM: 0xEF 0xBB 0xBF
  assert(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, 'CSV file begins with valid UTF-8 BOM (0xEF, 0xBB, 0xBF)')

  const csvRawUtf8 = readFileSync(exportRes.path, 'utf8')
  assert(csvRawUtf8.startsWith('\uFEFF'), 'CSV decoded string starts with unicode BOM character')

  // Verify escaping of quotes in raw CSV
  assert(csvRawUtf8.includes('""ISO 9001:2015""'), 'Quotes inside requirement title are escaped with RFC 4180 double quotes ("")')
  assert(csvRawUtf8.includes('供水管道系统'), 'CJK characters preserved in CSV')
  assert(csvRawUtf8.includes('🚰🇿🇦'), 'Emojis preserved in CSV')

  // 3.5 Large Compliance Matrix Stress Test (1,000 rows)
  console.log('  Generating and exporting 1,000-row compliance matrix...')
  const largeMatrix: any[] = []
  const categories = ['TECHNICAL', 'LEGAL', 'FINANCIAL', 'ENVIRONMENTAL', 'HEALTH_SAFETY', 'B-BBEE', 'LOCAL_CONTENT']
  const statuses = ['FULFILLED', 'UNDER_REVIEW', 'ACTION_REQUIRED']

  for (let i = 1; i <= 1000; i++) {
    largeMatrix.push({
      id: `REQ-${String(i).padStart(4, '0')}`,
      category: categories[i % categories.length],
      title: `Specification Clause ${i}.0: Technical requirement for sub-component item #${i}, with "precision" tolerance of ±0.${i % 9}%, rate R ${(i * 123.45).toFixed(2)}`,
      isMandatory: i % 3 === 0,
      status: statuses[i % statuses.length],
      linkedVaultDocId: i % 2 === 0 ? `vd-doc-${i}` : null,
      healthStatus: i % 2 === 0 ? 'VALID' : 'NO_ATTACHMENT',
      notes: `Automated compliance verification record ${i}`,
    })
  }

  const startTime = Date.now()
  const largeExportRes = await exportSheetsHandler(null, 'tender-large-01', 'Mega Infrastructure Compliance Matrix', largeMatrix)
  const durationMs = Date.now() - startTime
  console.log(`  1,000-row CSV generation took ${durationMs} ms`)

  assert(largeExportRes.ok === true, '1,000-row matrix export returned ok: true')
  assert(existsSync(largeExportRes.path), '1,000-row CSV file exists on disk')
  const largeFileSize = readFileSync(largeExportRes.path).length
  console.log(`  1,000-row CSV file size: ${(largeFileSize / 1024).toFixed(2)} KB`)
  assert(largeFileSize > 100000, `1,000-row CSV is sufficiently populated (> 100 KB, actual: ${largeFileSize} bytes)`)
  assert(durationMs < 1000, `1,000-row CSV export generated in under 1 second (${durationMs} ms)`)

  // ==========================================================================
  // SUITE 3.6: EMPIRICAL SHEETS PARSEABILITY CHECK (ORACLE: apps/sheets parseCsv)
  // ==========================================================================
  console.log('\n--- SUITE 3.6: Empirical Parseability with Zano Sheets Native Importer ---')

  const parsedSheetsMatrix = parseCsv(csvRawUtf8)
  console.log(`  Total parsed rows from adversarial export: ${parsedSheetsMatrix.length} (expected header + 7 rows = 8)`)

  const headerRow = parsedSheetsMatrix[0]
  console.log('  Header columns parsed:', headerRow)

  parsedSheetsMatrix.forEach((row: string[], idx: number) => {
    if (row.length !== 8) {
      console.warn(`    ⚠️ Row ${idx} has ${row.length} columns (expected 8):`, row)
    }
  })

  // Check whether REQ-EDGE-02 (commas in title) split into extra columns
  const req2Row = parsedSheetsMatrix.find((r: string[]) => r[0] === 'REQ-EDGE-02')
  if (req2Row) {
    if (req2Row.length !== 8) {
      findings.push({
        title: 'CSV cell with commas parsed into extra columns due to leading space after delimiter',
        severity: 'HIGH',
        detail: `Row REQ-EDGE-02 has ${req2Row.length} columns instead of 8. The exporter formats rows with ", " (comma-space), which causes RFC 4180 parsers expecting strict delimiter-quote binding to treat space as literal character and fail quote boundary detection.`,
      })
    }
    assert(
      req2Row.length === 8,
      'Row with commas in requirement text preserved as exactly 8 columns in Sheets parseCsv',
      `Row expanded to ${req2Row.length} columns due to unescaped comma split: ${JSON.stringify(req2Row)}`
    )
  } else {
    findings.push({
      title: 'Row identifier corrupted / unmatchable due to CSV structural deformation',
      severity: 'HIGH',
      detail: 'REQ-EDGE-02 row could not be found at column 0 in the parsed CSV matrix because preceding unescaped row splits deformed record boundaries.',
    })
    assert(false, 'Row REQ-EDGE-02 located in parsed CSV matrix', 'Row boundary deformed by previous unescaped cell newline/comma')
  }

  // Check whether REQ-EDGE-04 (multiline) broke into multiple rows
  if (parsedSheetsMatrix.length !== 8) {
    findings.push({
      title: 'Multiline CSV cell broke single requirement row into multiple spreadsheet rows',
      severity: 'HIGH',
      detail: `Parsed CSV contains ${parsedSheetsMatrix.length} rows instead of expected 8 (1 header + 7 requirements). The leading space after comma prevents the opening quote from being recognized at field start, causing embedded newlines (\\n) to trigger unquoted row breaks.`,
    })
  }
  assert(
    parsedSheetsMatrix.length === 8,
    `Total parsed rows in Sheets matches 1 header + 7 records = 8 (actual: ${parsedSheetsMatrix.length})`,
    `Row count mismatch: expected 8, got ${parsedSheetsMatrix.length}. Multiline text caused unauthorized row splits.`
  )

  // Check for leading spaces in cell values
  if (headerRow && headerRow.length >= 2) {
    if (headerRow[1].startsWith(' ')) {
      findings.push({
        title: 'CSV header columns contain unintended leading spaces',
        severity: 'MEDIUM',
        detail: `Header column 1 is "${headerRow[1]}" instead of "Category". The header definition uses comma-space separation: "Requirement ID, Category, ...", contaminating column names with whitespace.`,
      })
    }
    assert(!headerRow[1].startsWith(' '), 'CSV header column 1 has no leading whitespace', `Header column is "${headerRow[1]}"`)
  }

  // Check row 1 column 1 for quotes/spaces
  const row1 = parsedSheetsMatrix[1]
  if (row1 && row1.length >= 2) {
    if (row1[1].startsWith(' ') || row1[1].includes('"')) {
      findings.push({
        title: 'CSV data cells retain raw quotes and leading whitespace when imported into Sheets',
        severity: 'HIGH',
        detail: `Cell Category in Row 1 parsed as '${row1[1]}' instead of 'LEGAL COMPLIANCE'. Because of leading space after delimiter (", "), the parser does not recognize quotes as field wrappers, leaving raw quotes and whitespace inside user data.`,
      })
    }
    assert(!row1[1].startsWith(' ') && !row1[1].includes('"'), 'Data cell has quotes stripped and no leading space in Sheets parseCsv', `Parsed as: "${row1[1]}"`)
  }

  // Also parse large matrix
  const parsedLarge = parseCsv(readFileSync(largeExportRes.path, 'utf8'))
  console.log(`  Parsed large matrix rows: ${parsedLarge.length} (expected 1001)`)
  assert(parsedLarge.length === 1001, `Large matrix parsed exactly 1,001 rows in Sheets parseCsv (actual: ${parsedLarge.length})`)

  let largeColErrors = 0
  for (let i = 0; i < parsedLarge.length; i++) {
    if (parsedLarge[i].length !== 8) {
      largeColErrors++
    }
  }
  assert(
    largeColErrors === 0,
    `All 1,001 rows in large matrix have exactly 8 columns (actual rows with wrong column count: ${largeColErrors})`,
    `${largeColErrors} rows in the 1,000-row matrix were split into incorrect column counts due to commas in text.`
  )

  // ==========================================================================
  // SUITE 3.7: BENCHMARK PROOF: STRICT RFC 4180 FORMAT (NO SPACE AFTER COMMA)
  // ==========================================================================
  console.log('\n--- SUITE 3.7: Root-Cause Verification Benchmark (RFC 4180 Unspaced) ---')
  // Re-encode the exact same adversarial rows without the extraneous space after comma
  const benchmarkHeader = 'Requirement ID,Category,Requirement Text,Mandatory / Disqualifier,Fulfillment Status,Linked Document,Health Status,Notes\n'
  const escapeCsvBenchmark = (str: unknown): string => {
    if (str === null || str === undefined) return '""'
    const s = String(str).replace(/"/g, '""')
    return `"${s}"`
  }
  const benchmarkRows = (adversarialRows || []).map((r, idx) => {
    const reqId = escapeCsvBenchmark(r.id || `REQ-${idx + 1}`)
    const cat = escapeCsvBenchmark((r.category || 'GENERAL').replace(/_/g, ' '))
    const reqText = escapeCsvBenchmark(r.title || '')
    const isMand = r.isMandatory !== undefined ? Boolean(r.isMandatory) : false
    const mandText = escapeCsvBenchmark(isMand ? 'Mandatory / Disqualifier' : 'Standard Returnable')
    const status = escapeCsvBenchmark(r.status || 'UNDER_REVIEW')
    const linkedDoc = escapeCsvBenchmark(r.linkedVaultDocId || 'None')
    const health = escapeCsvBenchmark(r.healthStatus || 'NO_ATTACHMENT')
    const notes = escapeCsvBenchmark(r.notes || '')
    return `${reqId},${cat},${reqText},${mandText},${status},${linkedDoc},${health},${notes}`
  }).join('\n')

  const benchmarkCsv = '\uFEFF' + benchmarkHeader + benchmarkRows
  const benchmarkParsed = parseCsv(benchmarkCsv)

  console.log(`  Benchmark parsed row count: ${benchmarkParsed.length} (expected 8)`)
  const benchmarkRowsPass = benchmarkParsed.length === 8
  const benchmarkColsPass = benchmarkParsed.every((r: string[]) => r.length === 8)
  const benchmarkNoLeadingSpace = !benchmarkParsed[0][1].startsWith(' ')
  const benchmarkQuotesStripped = !benchmarkParsed[1][1].startsWith(' ') && !benchmarkParsed[1][1].includes('"')

  console.log(`  Benchmark all rows have 8 cols: ${benchmarkColsPass}`)
  console.log(`  Benchmark no leading space in cols: ${benchmarkNoLeadingSpace}`)
  console.log(`  Benchmark quotes stripped properly: ${benchmarkQuotesStripped}`)

  if (benchmarkRowsPass && benchmarkColsPass && benchmarkNoLeadingSpace && benchmarkQuotesStripped) {
    console.log('  🎯 ROOT CAUSE CONFIRMED: Eliminating ", " (comma-space) in favor of strictly standard "," produces 100% compliant CSV in Zano Sheets native importer.')
  }

  // ==========================================================================
  // SUITE 3.8: EXHAUSTIVE 8,000-CELL ROUND-TRIP FIDELITY ORACLE
  // ==========================================================================
  console.log('\n--- SUITE 3.8: Exhaustive 8,000-Cell Round-Trip Fidelity Oracle ---')
  console.log('  Validating all 8 columns across all 1,000 rows against input data...')

  let cellDiscrepancies = 0
  let sampleDiscrepancy: string | undefined

  for (let i = 0; i < 1000; i++) {
    const input = largeMatrix[i]
    const parsedRow = parsedLarge[i + 1] // +1 for header

    const expectedId = input.id
    const expectedCategory = input.category.replace(/_/g, ' ')
    const expectedTitle = input.title
    const expectedMand = input.isMandatory ? 'Mandatory / Disqualifier' : 'Standard Returnable'
    const expectedStatus = input.status
    const expectedDoc = input.linkedVaultDocId || 'None'
    const expectedHealth = input.healthStatus
    const expectedNotes = input.notes

    if (parsedRow[0] !== expectedId) {
      cellDiscrepancies++
      sampleDiscrepancy = `Row ${i} col 0: expected ${expectedId}, got ${parsedRow[0]}`
    }
    if (parsedRow[1] !== expectedCategory) {
      cellDiscrepancies++
      sampleDiscrepancy = `Row ${i} col 1: expected ${expectedCategory}, got ${parsedRow[1]}`
    }
    if (parsedRow[2] !== expectedTitle) {
      cellDiscrepancies++
      sampleDiscrepancy = `Row ${i} col 2: expected ${expectedTitle}, got ${parsedRow[2]}`
    }
    if (parsedRow[3] !== expectedMand) {
      cellDiscrepancies++
      sampleDiscrepancy = `Row ${i} col 3: expected ${expectedMand}, got ${parsedRow[3]}`
    }
    if (parsedRow[4] !== expectedStatus) {
      cellDiscrepancies++
      sampleDiscrepancy = `Row ${i} col 4: expected ${expectedStatus}, got ${parsedRow[4]}`
    }
    if (parsedRow[5] !== expectedDoc) {
      cellDiscrepancies++
      sampleDiscrepancy = `Row ${i} col 5: expected ${expectedDoc}, got ${parsedRow[5]}`
    }
    if (parsedRow[6] !== expectedHealth) {
      cellDiscrepancies++
      sampleDiscrepancy = `Row ${i} col 6: expected ${expectedHealth}, got ${parsedRow[6]}`
    }
    if (parsedRow[7] !== expectedNotes) {
      cellDiscrepancies++
      sampleDiscrepancy = `Row ${i} col 7: expected ${expectedNotes}, got ${parsedRow[7]}`
    }
  }

  assert(cellDiscrepancies === 0, `All 8,000 cells across 1,000 rows match input data with 100% fidelity (discrepancies: ${cellDiscrepancies})`, sampleDiscrepancy)

  // ==========================================================================
  // SUITE 3.9: EXTREME ADVERSARIAL MATRIX (CRLF, 10,000 CHAR, FORMULAS, CONSECUTIVE QUOTES)
  // ==========================================================================
  console.log('\n--- SUITE 3.9: Extreme Adversarial Matrix Robustness ---')

  const extremeLongText = 'EXTREME_PREFIX_' + 'A, B "C" \r\n D '.repeat(500) + '_EXTREME_SUFFIX'
  const extremeAdversarialRows = [
    {
      id: 'REQ-EXT-EMPTY',
      category: '',
      title: '',
      isMandatory: false,
      status: '',
      linkedVaultDocId: null,
      healthStatus: '',
      notes: '',
    },
    {
      id: 'REQ-EXT-SPACES',
      category: '   SPACES   ',
      title: '     Leading and trailing whitespace everywhere     ',
      isMandatory: true,
      status: 'UNDER_REVIEW',
      linkedVaultDocId: null,
      healthStatus: 'NO_ATTACHMENT',
      notes: '     ',
    },
    {
      id: 'REQ-EXT-CRLF',
      category: 'WINDOWS_LINEBREAKS',
      title: 'Line 1\r\nLine 2\r\nLine 3 with "quoted words"\r\nLine 4',
      isMandatory: false,
      status: 'FULFILLED',
      linkedVaultDocId: 'vd-crlf',
      healthStatus: 'VALID',
      notes: 'Contains Windows CRLF (\\r\\n) inside quotes',
    },
    {
      id: 'REQ-EXT-QUOTES',
      category: 'QUOTE_EXPLOSION',
      title: '"""""Nested""""" """Quotes""" ""Alone"" and "," comma in quotes',
      isMandatory: true,
      status: 'ACTION_REQUIRED',
      linkedVaultDocId: null,
      healthStatus: 'NO_ATTACHMENT',
      notes: '"""Double""" and """""Quintiple""""" quotes',
    },
    {
      id: 'REQ-EXT-FORMULA',
      category: 'FORMULA_INJECTION',
      title: '=SUM(1, 2, 3) + @AVERAGE(A1:B10) - 100 * 50',
      isMandatory: false,
      status: 'UNDER_REVIEW',
      linkedVaultDocId: null,
      healthStatus: 'NO_ATTACHMENT',
      notes: '+cmd|"/c calc"!A0',
    },
    {
      id: 'REQ-EXT-LONG',
      category: 'STRESS_VOLUME',
      title: extremeLongText,
      isMandatory: true,
      status: 'FULFILLED',
      linkedVaultDocId: 'vd-huge',
      healthStatus: 'VALID',
      notes: 'Huge 10KB cell containing commas, quotes, CRLF',
    },
    {
      id: 'REQ-EXT-NUMERIC',
      category: 'NUMERIC_CODES',
      title: '00742',
      isMandatory: false,
      status: '001',
      linkedVaultDocId: '0099',
      healthStatus: '000',
      notes: '0123456789',
    },
  ]

  const extremeExportRes = await exportSheetsHandler(null, 'tender-extreme', 'Extreme Adversarial Matrix', extremeAdversarialRows)
  assert(extremeExportRes.ok === true, 'Extreme matrix export returned ok: true')
  const extremeCsvRaw = readFileSync(extremeExportRes.path, 'utf8')
  const parsedExtreme = parseCsv(extremeCsvRaw)
  console.log(`  Parsed extreme matrix rows: ${parsedExtreme.length} (expected 8: 1 header + 7 records)`)
  assert(parsedExtreme.length === 8, `Extreme matrix parsed exactly 8 rows (actual: ${parsedExtreme.length})`)

  let extremeColErrors = 0
  for (let i = 0; i < parsedExtreme.length; i++) {
    if (parsedExtreme[i].length !== 8) extremeColErrors++
  }
  assert(extremeColErrors === 0, `All rows in extreme matrix have exactly 8 columns (errors: ${extremeColErrors})`)

  const longRowParsed = parsedExtreme.find((r: string[]) => r[0] === 'REQ-EXT-LONG')
  assert(longRowParsed !== undefined, 'Extreme 10KB row successfully parsed with valid ID')
  assert(longRowParsed[2].startsWith('EXTREME_PREFIX_') && longRowParsed[2].endsWith('_EXTREME_SUFFIX'), 'Extreme 10KB cell text fully preserved end-to-end')

  const crlfRowParsed = parsedExtreme.find((r: string[]) => r[0] === 'REQ-EXT-CRLF')
  assert(crlfRowParsed !== undefined, 'CRLF row successfully parsed with valid ID')
  assert(crlfRowParsed[2].includes('Line 1') && crlfRowParsed[2].includes('Line 4'), 'CRLF line breaks preserved inside cell without row break')

  // ==========================================================================
  // SUITE 3.10: MONOTONIC EXPORT TIMESTAMPS & ANTI-COLLISION VERIFICATION
  // ==========================================================================
  console.log('\n--- SUITE 3.10: Monotonic Export Timestamps & Anti-Collision Verification ---')
  const burstPaths: string[] = []
  for (let i = 0; i < 10; i++) {
    const res = await exportSheetsHandler(null, 'tender-burst', 'Rapid Burst Export', [{ id: `REQ-${i}`, title: `Burst ${i}` }])
    burstPaths.push(res.path)
  }
  const uniqueBurstPaths = new Set(burstPaths)
  assert(uniqueBurstPaths.size === 10, `All 10 rapid burst exports generated unique non-colliding paths (unique: ${uniqueBurstPaths.size}/10)`)
  const allExist = burstPaths.every((p: string) => existsSync(p))
  assert(allExist, 'All 10 burst export CSV files exist on disk')


  // ==========================================================================
  // SUMMARY REPORT
  // ==========================================================================
  console.log('\n======================================================================')
  console.log(`RESULTS: ${passedCount} passed, ${failedCount} failed`)
  console.log(`FINDINGS: ${findings.length} detected`)
  console.log('======================================================================')

  for (const f of findings) {
    console.log(`\n[${f.severity}] ${f.title}`)
    console.log(`  ${f.detail}`)
  }

  return {
    passedCount,
    failedCount,
    findings,
    approved: failedCount === 0,
  }
}

// Run test harness
runAllStressTests()
  .then((summary) => {
    if (summary.approved) {
      console.log('\nVERDICT: APPROVE — All stress tests passed cleanly.')
      process.exit(0)
    } else {
      console.log('\nVERDICT: FAIL — Defect(s) discovered during empirical stress testing.')
      process.exit(1)
    }
  })
  .catch((err) => {
    console.error('FATAL TEST ERROR:', err)
    process.exit(1)
  })

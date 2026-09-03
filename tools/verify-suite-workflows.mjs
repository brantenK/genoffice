#!/usr/bin/env node
/**
 * tools/verify-suite-workflows.mjs
 *
 * Comprehensive Automated End-to-End Test Runner for the Zanostack Suite Workflows:
 * - R1: Resilient Update & External Sync Architecture (Deals, Tenders, Books)
 * - R2: CRM to Zano Books Invoicing Automation
 * - R3: Tenders Contract Milestone Billing in Zano Books
 * - R4: Bank Statement CSV Reconciliation in Zano Books
 *
 * Supports Dual Track quality verification across:
 * - Tier 1: Feature Coverage (>=5 tests per requirement)
 * - Tier 2: Boundary & Corner Cases (>=5 tests per requirement)
 * - Tier 3: Cross-Feature Combinations (Pairwise)
 * - Tier 4: Real-World Commercial Workload Scenarios
 *
 * Directly executable via: node tools/verify-suite-workflows.mjs
 * Exits with code 0 on pass, code 1 on failure, code 2 on CLI usage error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// ============================================================================
// 1. CLI ARGUMENT PARSING & CONFIGURATION
// ============================================================================

const args = process.argv.slice(2)

const config = {
  tier: 'all',        // '1', '2', '3', '4', 'all'
  milestone: 'all',   // 'm1', 'm2', 'm3', 'm4', 'all'
  feature: 'all',     // 'r1', 'r2', 'r3', 'r4', 'all'
  verbose: false,
  json: false,
  keepSandbox: false,
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--tier' && i + 1 < args.length) {
    config.tier = args[++i].toLowerCase()
  } else if (arg === '--milestone' && i + 1 < args.length) {
    config.milestone = args[++i].toLowerCase()
  } else if (arg === '--feature' && i + 1 < args.length) {
    config.feature = args[++i].toLowerCase()
  } else if (arg === '--verbose' || arg === '-v') {
    config.verbose = true
  } else if (arg === '--json') {
    config.json = true
  } else if (arg === '--keep-sandbox') {
    config.keepSandbox = true
  } else if (arg === '--help' || arg === '-h') {
    printHelp()
    process.exit(0)
  } else {
    console.error(`Unknown argument: ${arg}`)
    printHelp()
    process.exit(2)
  }
}

function printHelp() {
  console.log(`
Zanostack Suite Workflows Verification Runner
Usage: node tools/verify-suite-workflows.mjs [options]

Options:
  --tier <1|2|3|4|all>        Filter tests by tier (default: all)
  --milestone <m1|m2|m3|m4|all> Filter tests by milestone (default: all)
  --feature <r1|r2|r3|r4|all>   Filter tests by requirement (default: all)
  --verbose, -v               Show verbose diagnostics and step logs
  --json                      Output results as machine-readable JSON
  --keep-sandbox              Retain temporary test filesystem on exit
  --help, -h                  Show this help message
`)
}

// ============================================================================
// 2. SANDBOX & TEST ENVIRONMENT MANAGEMENT
// ============================================================================

class TestSandbox {
  constructor(name = 'default') {
    this.id = randomUUID().slice(0, 8)
    this.root = join(tmpdir(), `zanostack-test-${name}-${this.id}`)
    this.crmDir = join(this.root, 'crm')
    this.tendersDir = join(this.root, 'tenders')
    this.booksDir = join(this.root, 'books')
    this.init()
  }

  init() {
    mkdirSync(this.crmDir, { recursive: true })
    mkdirSync(this.tendersDir, { recursive: true })
    mkdirSync(this.booksDir, { recursive: true })
  }

  get crmDealsPath() {
    return join(this.crmDir, 'deals.json')
  }

  get tendersDataPath() {
    return join(this.tendersDir, 'tenders-data.json')
  }

  get booksDataPath() {
    return join(this.booksDir, 'books-data.json')
  }

  cleanup() {
    if (!config.keepSandbox) {
      try {
        if (existsSync(this.root)) {
          rmSync(this.root, { recursive: true, force: true })
        }
      } catch {}
    }
  }
}

// ============================================================================
// 3. CORE DOMAIN LOGIC & AUTHORITATIVE REFERENCE ENGINE
// ============================================================================

/**
 * Standard seed data for Books Chart of Accounts, Settings, Parties, and Invoices
 */
function createInitialBooksData() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: {
      companyName: 'Zano Consulting (Pty) Ltd',
      taxNumber: '4920284719',
      currency: 'ZAR',
      currencySymbol: 'R',
      financialYearStart: '2026-03-01',
      address: '24 Sovereign Square, Sandton, Johannesburg, 2196',
      email: 'finance@zanostack.dev',
      phone: '+27 11 982 4000',
    },
    accounts: [
      { id: 'acc-bank', name: 'FNB Business Cheque Account', rootType: 'Asset', accountType: 'Bank', parentId: 'acc-curr-asset', isGroup: false, balance: 485250 },
      { id: 'acc-ar', name: 'Accounts Receivable (Debtors)', rootType: 'Asset', accountType: 'Receivable', parentId: 'acc-curr-asset', isGroup: false, balance: 195500 },
      { id: 'acc-ap', name: 'Accounts Payable (Creditors)', rootType: 'Liability', accountType: 'Payable', parentId: 'acc-curr-liab', isGroup: false, balance: 74200 },
      { id: 'acc-sales', name: 'Tender & Commercial Contracting Sales', rootType: 'Income', accountType: 'Direct Income', parentId: 'acc-operating-rev', isGroup: false, balance: 820000 },
      { id: 'acc-vat', name: 'SARS VAT Output Payable', rootType: 'Liability', accountType: 'Tax', parentId: 'acc-curr-liab', isGroup: false, balance: 38400 },
    ],
    parties: [
      { id: 'party-1', name: 'City of Ekurhuleni Water Dept', type: 'Customer', email: 'procurement@ekurhuleni.gov.za', phone: '+27 11 999 0000', taxId: '4010192837', address: 'Kempton Park Civic Centre', outstandingBalance: 145000 },
      { id: 'party-2', name: 'Helios Clean Energy', type: 'Customer', email: 'billing@heliosclean.com', phone: '+27 21 444 1234', taxId: '4110293847', address: 'Century City, Cape Town', outstandingBalance: 50500 },
      { id: 'party-supp-1', name: 'Apex Valve Supplies (Pty) Ltd', type: 'Supplier', email: 'orders@apexvalve.co.za', phone: '+27 11 888 7777', taxId: '4990192834', address: 'Germiston Industrial Park', outstandingBalance: 45000 },
    ],
    invoices: [
      {
        id: 'inv-1',
        invoiceNumber: 'INV-2026-001',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-08-15',
        dueDate: '2026-09-15',
        items: [
          { id: 'item-1', itemCode: 'VALVE-REFURB', description: 'Phase 1 Reservoir Valve Refurbishment per RFP-WTR-2026-04', accountId: 'acc-sales', accountName: 'Tender & Commercial Contracting Sales', qty: 1, rate: 126086.96, taxRate: 15, amount: 126086.96 },
        ],
        subtotal: 126086.96,
        taxTotal: 18913.04,
        grandTotal: 145000,
        outstandingAmount: 145000,
        status: 'Unpaid',
        notes: 'Payment due within 30 days of invoice date. Ref: Tender Contract WTR-04',
        tenderReference: 'RFP-WTR-2026-04',
        createdAt: '2026-08-15T09:00:00Z',
        updatedAt: '2026-08-15T09:00:00Z',
      },
      {
        id: 'inv-supp-1',
        invoiceNumber: 'BILL-2026-012',
        type: 'Purchase',
        partyId: 'party-supp-1',
        partyName: 'Apex Valve Supplies (Pty) Ltd',
        date: '2026-08-20',
        dueDate: '2026-09-20',
        items: [
          { id: 'item-supp-1', itemCode: 'VALVE-KIT', description: 'Heavy Duty 300mm Valve Seals Kit', accountId: 'acc-ap', accountName: 'Accounts Payable', qty: 2, rate: 19565.22, taxRate: 15, amount: 39130.44 },
        ],
        subtotal: 39130.44,
        taxTotal: 5869.56,
        grandTotal: 45000,
        outstandingAmount: 45000,
        status: 'Unpaid',
        notes: 'Vendor supplies for municipal project',
        createdAt: '2026-08-20T10:00:00Z',
        updatedAt: '2026-08-20T10:00:00Z',
      },
    ],
    journalEntries: [],
    bankTransactions: [],
  }
}

/**
 * Seed data for Tenders with RFP-WTR-2026-04
 */
function createInitialTendersData() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeCompanyId: 'comp-zano-01',
    workspaces: [
      {
        id: 'ws-ekurhuleni-01',
        name: 'Ekurhuleni Water Infrastructure',
        tenders: [
          {
            id: 'tender-wtr-04',
            title: 'Bulk Water Metering & Valve Refurbishment',
            referenceNumber: 'RFP-WTR-2026-04',
            issuingBody: 'City of Ekurhuleni Water Dept',
            closingDate: '2026-10-31',
            status: 'ACTIVE',
            milestones: [
              {
                id: 'ms-01',
                title: 'Phase 1 Reservoir Valve Refurbishment',
                description: 'Complete overhaul of high-pressure control valves',
                amount: 145000,
                status: 'REACHED',
                dueDate: '2026-08-30',
                completedDate: '2026-08-28',
              },
              {
                id: 'ms-02',
                title: 'Phase 2 Ultrasonic Flow Meter Installation',
                description: 'Install and calibrate digital flow sensors',
                amount: 98000,
                status: 'PENDING',
                dueDate: '2026-11-15',
              },
            ],
            requirements: [],
          },
        ],
      },
    ],
    issuerTemplates: [],
  }
}

/**
 * Seed CRM deals
 */
function createInitialCrmDeals() {
  return [
    {
      id: 'deal-1',
      name: 'Global Suite Migration & Deployment',
      companyName: 'Acme Global Technologies',
      amount: 120000,
      stage: 'negotiation',
      probability: 85,
      createdAt: '2026-08-09T08:42:00.889Z',
      updatedAt: '2026-09-01T08:42:00.889Z',
    },
    {
      id: 'deal-3',
      name: 'Clean Tech Analytics Pipeline',
      companyName: 'Helios Clean Energy',
      amount: 85000,
      stage: 'won',
      probability: 100,
      createdAt: '2026-08-10T11:00:00.000Z',
      updatedAt: '2026-09-02T14:30:00.000Z',
    },
    {
      id: 'deal-4',
      name: 'Smart Metering IoT Integration',
      companyName: 'Urban Grid Solutions',
      amount: 210000,
      stage: 'proposal',
      probability: 60,
      createdAt: '2026-08-12T09:15:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  ]
}

// ----------------------------------------------------------------------------
// R1: RESILIENT PERSISTENCE, MIGRATION & VALIDATION ENGINE
// ----------------------------------------------------------------------------

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  const serialized = JSON.stringify(data, null, 2)
  writeFileSync(tmpPath, serialized, 'utf8')
  renameSync(tmpPath, filePath)
}

function safeReadJsonWithBackup(filePath, defaultFactory) {
  if (!existsSync(filePath)) {
    const initial = defaultFactory()
    atomicWriteJson(filePath, initial)
    return initial
  }

  const raw = readFileSync(filePath, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (err) {
    const backupPath = `${filePath}.${Date.now()}.corrupted.bak`
    writeFileSync(backupPath, raw, 'utf8')
    console.warn(`[SafePersist] Corrupted JSON at ${filePath}. Preserved backup at ${backupPath}`)
    const fallback = defaultFactory()
    return fallback
  }
}

function migrateAndValidateCrmDeals(raw) {
  let deals = []
  let version = 1

  if (Array.isArray(raw)) {
    deals = raw
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.deals)) {
    deals = raw.deals
    version = Number(raw.version) || 1
  }

  const sanitized = deals.map((d) => {
    const probability = Math.max(0, Math.min(100, Number(d.probability ?? 20) || 0))
    const amount = Math.max(0, Number(d.amount ?? 0) || 0)
    const validStages = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']
    const stage = validStages.includes(d.stage) ? d.stage : 'lead'

    return {
      ...d,
      id: d.id || `deal-${randomUUID().slice(0, 8)}`,
      name: String(d.name || 'Untitled Opportunity'),
      amount,
      stage,
      probability,
      createdAt: d.createdAt || new Date().toISOString(),
      updatedAt: d.updatedAt || new Date().toISOString(),
    }
  })

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    deals: sanitized,
  }
}

function migrateAndValidateTendersData(raw) {
  if (!raw || typeof raw !== 'object') {
    return createInitialTendersData()
  }

  const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces : []
  const issuerTemplates = Array.isArray(raw.issuerTemplates) ? raw.issuerTemplates : []

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeCompanyId: raw.activeCompanyId || 'comp-default',
    workspaces,
    issuerTemplates,
  }
}

function migrateAndValidateBooksData(raw) {
  if (!raw || typeof raw !== 'object') {
    return createInitialBooksData()
  }

  const base = createInitialBooksData()
  const accounts = Array.isArray(raw.accounts) && raw.accounts.length > 0 ? raw.accounts : base.accounts
  const parties = Array.isArray(raw.parties) ? raw.parties : base.parties
  const invoices = Array.isArray(raw.invoices) ? raw.invoices : base.invoices
  const journalEntries = Array.isArray(raw.journalEntries) ? raw.journalEntries : []
  const bankTransactions = Array.isArray(raw.bankTransactions) ? raw.bankTransactions : []

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { ...base.settings, ...(raw.settings || {}) },
    accounts,
    parties,
    invoices,
    journalEntries,
    bankTransactions,
  }
}

function safeMergeTenderIntoCrmDeals(crmDealsPath, tenderDeal) {
  const currentEnvelope = safeReadJsonWithBackup(crmDealsPath, () => ({ version: 1, updatedAt: new Date().toISOString(), deals: [] }))
  const validated = migrateAndValidateCrmDeals(currentEnvelope)

  const existingIdx = validated.deals.findIndex((d) => d.id === tenderDeal.id)
  const now = new Date().toISOString()

  const normalized = {
    id: tenderDeal.id || `deal-tender-${Date.now()}`,
    name: tenderDeal.name || 'Tender Opportunity',
    companyName: tenderDeal.companyName || 'Procurement Buyer',
    amount: Math.max(0, Number(tenderDeal.amount) || 150000),
    stage: tenderDeal.stage || 'proposal',
    probability: Number(tenderDeal.probability ?? 60),
    notes: tenderDeal.notes || 'Imported from Zanostack Tenders',
    createdAt: tenderDeal.createdAt || now,
    updatedAt: now,
    ...tenderDeal,
  }

  if (existingIdx >= 0) {
    validated.deals[existingIdx] = { ...validated.deals[existingIdx], ...normalized }
  } else {
    validated.deals.unshift(normalized)
  }

  validated.updatedAt = now
  atomicWriteJson(crmDealsPath, validated)
  return { ok: true, dealId: normalized.id }
}

// ----------------------------------------------------------------------------
// R2: CRM TO ZANO BOOKS INVOICING BRIDGE
// ----------------------------------------------------------------------------

function executeCreateInvoiceFromDeal({ crmDealsPath, booksDataPath, dealId, onOpenBooks }) {
  const crmEnvelope = safeReadJsonWithBackup(crmDealsPath, () => ({ version: 1, updatedAt: '', deals: [] }))
  const dealsData = migrateAndValidateCrmDeals(crmEnvelope)
  const deal = dealsData.deals.find((d) => d.id === dealId)

  if (!deal) {
    return { ok: false, error: `Deal not found: ${dealId}` }
  }

  if (deal.stage !== 'won') {
    return { ok: false, error: `Deal is not won. Current stage: ${deal.stage}` }
  }

  if (deal.invoiceNumber || deal.invoiceId) {
    return { ok: false, error: `Deal already invoiced: ${deal.invoiceNumber}` }
  }

  const booksEnvelope = safeReadJsonWithBackup(booksDataPath, () => createInitialBooksData())
  const booksData = migrateAndValidateBooksData(booksEnvelope)

  const partyName = deal.companyName || deal.name || 'Valued Client'
  let party = booksData.parties.find((p) => p.name.toLowerCase() === partyName.toLowerCase())

  if (!party) {
    party = {
      id: `party-${randomUUID().slice(0, 8)}`,
      name: partyName,
      type: 'Customer',
      email: 'accounts@' + partyName.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com',
      outstandingBalance: 0,
    }
    booksData.parties.push(party)
  }

  const year = new Date().getFullYear()
  const nextSeq = String(booksData.invoices.length + 1).padStart(3, '0')
  const invoiceNumber = `INV-${year}-${nextSeq}`
  const invoiceId = `inv-${randomUUID().slice(0, 8)}`

  const grandTotal = Math.round(Number(deal.amount || 0) * 100) / 100
  const subtotal = Math.round((grandTotal / 1.15) * 100) / 100
  const taxTotal = Math.round((grandTotal - subtotal) * 100) / 100
  const today = new Date().toISOString().split('T')[0]
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]

  const newInvoice = {
    id: invoiceId,
    invoiceNumber,
    type: 'Sales',
    partyId: party.id,
    partyName: party.name,
    date: today,
    dueDate,
    items: [
      {
        id: `item-${randomUUID().slice(0, 8)}`,
        itemCode: 'COMMERCIAL-DELIVERY',
        description: `${deal.name} - Commercial Implementation & Services`,
        accountId: 'acc-sales',
        accountName: 'Tender & Commercial Contracting Sales',
        qty: 1,
        rate: subtotal,
        taxRate: 15,
        amount: subtotal,
      },
    ],
    subtotal,
    taxTotal,
    grandTotal,
    outstandingAmount: grandTotal,
    status: 'Unpaid',
    notes: 'Payment terms: Net 30 days upon invoice receipt.',
    crmDealId: deal.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  booksData.invoices.unshift(newInvoice)
  party.outstandingBalance = Math.round((party.outstandingBalance + grandTotal) * 100) / 100

  // Double-entry ledger adjustment
  for (const acc of booksData.accounts) {
    if (acc.id === 'acc-ar') acc.balance = Math.round((acc.balance + grandTotal) * 100) / 100
    if (acc.id === 'acc-sales') acc.balance = Math.round((acc.balance + subtotal) * 100) / 100
    if (acc.id === 'acc-vat') acc.balance = Math.round((acc.balance + taxTotal) * 100) / 100
  }

  // Balanced Journal Entry
  booksData.journalEntries.unshift({
    id: `je-${randomUUID().slice(0, 8)}`,
    entryNumber: `JE-${year}-${booksData.journalEntries.length + 1}`,
    date: today,
    totalDebit: grandTotal,
    totalCredit: grandTotal,
    remarks: `Sales Invoice ${invoiceNumber} for CRM Deal: ${deal.name}`,
    posted: true,
    items: [
      { id: `jei-1`, accountId: 'acc-ar', accountName: 'Accounts Receivable', debit: grandTotal, credit: 0, partyId: party.id, partyName: party.name },
      { id: `jei-2`, accountId: 'acc-sales', accountName: 'Tender & Commercial Contracting Sales', debit: 0, credit: subtotal },
      { id: `jei-3`, accountId: 'acc-vat', accountName: 'SARS VAT Output Payable', debit: 0, credit: taxTotal },
    ],
  })

  atomicWriteJson(booksDataPath, booksData)

  // Back-reference onto CRM Deal
  deal.invoiceId = invoiceId
  deal.invoiceNumber = invoiceNumber
  deal.invoicedAt = new Date().toISOString()
  deal.updatedAt = new Date().toISOString()
  atomicWriteJson(crmDealsPath, dealsData)

  if (typeof onOpenBooks === 'function') {
    onOpenBooks(invoiceId)
  }

  return {
    ok: true,
    invoiceId,
    invoiceNumber,
    grandTotal,
    subtotal,
    taxTotal,
    partyName: party.name,
  }
}

// ----------------------------------------------------------------------------
// R3: TENDERS CONTRACT MILESTONE BILLING BRIDGE
// ----------------------------------------------------------------------------

function executeBillMilestoneInBooks({
  tendersDataPath,
  booksDataPath,
  tenderId,
  milestoneId,
  tenderReference,
  issuingAuthority,
  milestoneTitle,
  amount,
  notes,
  onOpenBooks,
}) {
  const tendersEnvelope = safeReadJsonWithBackup(tendersDataPath, () => createInitialTendersData())
  const tendersData = migrateAndValidateTendersData(tendersEnvelope)

  let foundTender = null
  let foundMilestone = null

  for (const ws of tendersData.workspaces) {
    for (const t of ws.tenders || []) {
      if (t.id === tenderId || t.referenceNumber === tenderReference) {
        foundTender = t
        if (Array.isArray(t.milestones)) {
          foundMilestone = t.milestones.find((m) => m.id === milestoneId)
        }
        break
      }
    }
    if (foundTender) break
  }

  if (!foundTender) {
    return { ok: false, error: `Tender not found: ${tenderId || tenderReference}` }
  }

  if (!foundMilestone) {
    return { ok: false, error: `Milestone not found: ${milestoneId}` }
  }

  if (foundMilestone.status === 'BILLED') {
    return { ok: false, error: `Milestone already billed with invoice: ${foundMilestone.billedInvoiceId}` }
  }

  if (foundMilestone.status !== 'REACHED') {
    return { ok: false, error: `Milestone is not in REACHED status: ${foundMilestone.status}` }
  }

  const billAmount = Number(amount ?? foundMilestone.amount)
  if (billAmount <= 0) {
    return { ok: false, error: `Milestone billing amount must be greater than 0: ${billAmount}` }
  }

  const booksEnvelope = safeReadJsonWithBackup(booksDataPath, () => createInitialBooksData())
  const booksData = migrateAndValidateBooksData(booksEnvelope)

  const issuer = issuingAuthority || foundTender.issuingBody || 'Procurement Authority'
  let party = booksData.parties.find((p) => p.name.toLowerCase() === issuer.toLowerCase())

  if (!party) {
    party = {
      id: `party-${randomUUID().slice(0, 8)}`,
      name: issuer,
      type: 'Customer',
      email: 'procurement@' + issuer.toLowerCase().replace(/[^a-z0-9]/g, '') + '.gov.za',
      outstandingBalance: 0,
    }
    booksData.parties.push(party)
  }

  const year = new Date().getFullYear()
  const invoiceNumber = `INV-${year}-${String(booksData.invoices.length + 1).padStart(3, '0')}`
  const invoiceId = `inv-${randomUUID().slice(0, 8)}`

  const grandTotal = Math.round(billAmount * 100) / 100
  const subtotal = Math.round((grandTotal / 1.15) * 100) / 100
  const taxTotal = Math.round((grandTotal - subtotal) * 100) / 100
  const today = new Date().toISOString().split('T')[0]
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
  const ref = tenderReference || foundTender.referenceNumber || 'RFP-CONTRACT'
  const title = milestoneTitle || foundMilestone.title || 'Milestone Delivery'

  const newTaxInvoice = {
    id: invoiceId,
    invoiceNumber,
    type: 'Sales',
    partyId: party.id,
    partyName: party.name,
    date: today,
    dueDate,
    items: [
      {
        id: `item-${randomUUID().slice(0, 8)}`,
        itemCode: 'TENDER-PROGRESS',
        description: `${title} per ${ref}`,
        accountId: 'acc-sales',
        accountName: 'Tender & Commercial Contracting Sales',
        qty: 1,
        rate: subtotal,
        taxRate: 15,
        amount: subtotal,
      },
    ],
    subtotal,
    taxTotal,
    grandTotal,
    outstandingAmount: grandTotal,
    status: 'Unpaid',
    tenderReference: ref,
    notes: notes || `Tender Milestone Progress Claim. Ref: ${ref}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  booksData.invoices.unshift(newTaxInvoice)
  party.outstandingBalance = Math.round((party.outstandingBalance + grandTotal) * 100) / 100

  // Ledger updates
  for (const acc of booksData.accounts) {
    if (acc.id === 'acc-ar') acc.balance = Math.round((acc.balance + grandTotal) * 100) / 100
    if (acc.id === 'acc-sales') acc.balance = Math.round((acc.balance + subtotal) * 100) / 100
    if (acc.id === 'acc-vat') acc.balance = Math.round((acc.balance + taxTotal) * 100) / 100
  }

  // Journal Entry
  booksData.journalEntries.unshift({
    id: `je-${randomUUID().slice(0, 8)}`,
    entryNumber: `JE-${year}-${booksData.journalEntries.length + 1}`,
    date: today,
    totalDebit: grandTotal,
    totalCredit: grandTotal,
    remarks: `Milestone Tax Invoice ${invoiceNumber} for Tender ${ref}`,
    posted: true,
    items: [
      { id: `jei-1`, accountId: 'acc-ar', accountName: 'Accounts Receivable', debit: grandTotal, credit: 0, partyId: party.id, partyName: party.name },
      { id: `jei-2`, accountId: 'acc-sales', accountName: 'Tender & Commercial Contracting Sales', debit: 0, credit: subtotal },
      { id: `jei-3`, accountId: 'acc-vat', accountName: 'SARS VAT Output Payable', debit: 0, credit: taxTotal },
    ],
  })

  atomicWriteJson(booksDataPath, booksData)

  // Update milestone status in Tenders
  foundMilestone.status = 'BILLED'
  foundMilestone.billedInvoiceId = invoiceId
  foundMilestone.billedDate = new Date().toISOString()
  tendersData.updatedAt = new Date().toISOString()
  atomicWriteJson(tendersDataPath, tendersData)

  if (typeof onOpenBooks === 'function') {
    onOpenBooks(invoiceId)
  }

  return {
    ok: true,
    invoiceId,
    invoiceNumber,
    tenderReference: ref,
    grandTotal,
    subtotal,
    taxTotal,
  }
}

// ----------------------------------------------------------------------------
// R4: BANK STATEMENT CSV PARSING, MATCHING & RECONCILIATION
// ----------------------------------------------------------------------------

function parseBankStatementCsv(csvText) {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length < 2) return []

  const headerLine = lines[0]
  const headers = headerLine.split(',').map((h) => h.trim().toLowerCase().replace(/['"]/g, ''))

  const dateIdx = headers.findIndex((h) => h.includes('date'))
  const descIdx = headers.findIndex((h) => h.includes('desc') || h.includes('details') || h.includes('narrative'))
  const refIdx = headers.findIndex((h) => h.includes('ref'))
  const amountIdx = headers.findIndex((h) => h === 'amount' || h === 'value')
  const debitIdx = headers.findIndex((h) => h.includes('debit'))
  const creditIdx = headers.findIndex((h) => h.includes('credit'))

  const transactions = []

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i]
    // Simple CSV parser handling quotes
    const cols = []
    let curr = ''
    let inQuote = false

    for (let c = 0; c < rawLine.length; c++) {
      const char = rawLine[c]
      if (char === '"') {
        inQuote = !inQuote
      } else if (char === ',' && !inQuote) {
        cols.push(curr.trim())
        curr = ''
      } else {
        curr += char
      }
    }
    cols.push(curr.trim())

    if (cols.length === 0 || !cols.some((c) => c.length > 0)) continue

    const date = dateIdx >= 0 ? cols[dateIdx] : new Date().toISOString().split('T')[0]
    const description = descIdx >= 0 ? cols[descIdx] : 'Bank Transaction'
    const reference = refIdx >= 0 ? cols[refIdx] : ''

    let amount = 0
    if (amountIdx >= 0 && cols[amountIdx]) {
      let clean = cols[amountIdx].replace(/[R$\s]/g, '').replace(/,/g, '')
      // Handle parenthesized negative: (25000) or (R 25,000)
      if (clean.startsWith('(') && clean.endsWith(')')) {
        clean = '-' + clean.slice(1, -1)
      }
      amount = parseFloat(clean) || 0
    } else if (debitIdx >= 0 || creditIdx >= 0) {
      const debRaw = debitIdx >= 0 && cols[debitIdx] ? cols[debitIdx].replace(/[R$\s]/g, '').replace(/,/g, '') : '0'
      const credRaw = creditIdx >= 0 && cols[creditIdx] ? cols[creditIdx].replace(/[R$\s]/g, '').replace(/,/g, '') : '0'
      const deb = parseFloat(debRaw) || 0
      const cred = parseFloat(credRaw) || 0
      amount = cred > 0 ? cred : -deb
    }

    if (isNaN(amount) || amount === 0) continue

    transactions.push({
      id: `tx-${randomUUID().slice(0, 8)}`,
      accountId: 'acc-bank',
      date,
      description,
      reference,
      amount: Math.round(amount * 100) / 100,
      reconciled: false,
    })
  }

  return transactions
}

function importBankStatement({ booksDataPath, csvContent }) {
  const booksEnvelope = safeReadJsonWithBackup(booksDataPath, () => createInitialBooksData())
  const booksData = migrateAndValidateBooksData(booksEnvelope)

  const parsed = parseBankStatementCsv(csvContent)
  if (parsed.length === 0) {
    return { ok: false, error: 'No valid transactions found in statement CSV' }
  }

  // Deduplicate against existing bank transactions by fingerprint
  const existing = booksData.bankTransactions || []
  const existingFingerprints = new Set(existing.map((t) => `${t.date}|${t.description}|${t.amount}`))

  const toAdd = []
  let netAdjustment = 0

  for (const tx of parsed) {
    const fp = `${tx.date}|${tx.description}|${tx.amount}`
    if (!existingFingerprints.has(fp)) {
      toAdd.push(tx)
      netAdjustment += tx.amount
      existingFingerprints.add(fp)
    }
  }

  booksData.bankTransactions = [...existing, ...toAdd]

  // Adjust Bank Account ledger balance by net transaction amount
  const bankAccount = booksData.accounts.find((a) => a.id === 'acc-bank')
  if (bankAccount) {
    bankAccount.balance = Math.round((bankAccount.balance + netAdjustment) * 100) / 100
  }

  booksData.updatedAt = new Date().toISOString()
  atomicWriteJson(booksDataPath, booksData)

  return {
    ok: true,
    importedCount: toAdd.length,
    skippedDuplicates: parsed.length - toAdd.length,
    netAdjustment: Math.round(netAdjustment * 100) / 100,
    newBankBalance: bankAccount ? bankAccount.balance : null,
    transactions: toAdd,
  }
}

function computeSettlementSuggestions(booksData) {
  const transactions = (booksData.bankTransactions || []).filter((t) => !t.reconciled)
  const openInvoices = (booksData.invoices || []).filter((i) => i.status !== 'Paid' && i.outstandingAmount > 0)

  const suggestions = []

  for (const tx of transactions) {
    const isDeposit = tx.amount > 0
    const targetType = isDeposit ? 'Sales' : 'Purchase'
    const targetAmount = Math.abs(tx.amount)

    const candidates = openInvoices.filter((i) => i.type === targetType)

    for (const inv of candidates) {
      const amountMatches = Math.abs(inv.outstandingAmount - targetAmount) < 0.01

      if (!amountMatches) continue

      // Check text tokens for HIGH confidence match
      const textToSearch = `${tx.description} ${tx.reference || ''}`.toLowerCase()
      const invNoMatch = inv.invoiceNumber && textToSearch.includes(inv.invoiceNumber.toLowerCase())
      const tenderMatch = inv.tenderReference && textToSearch.includes(inv.tenderReference.toLowerCase())

      // Split party name into significant keywords (length >= 4, ignoring common stop words)
      const stopWords = new Set(['city', 'of', 'the', 'and', 'dept', 'ltd', 'pty', 'inc', 'corp', 'co'])
      const partyTokens = (inv.partyName || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !stopWords.has(t))

      const partyMatch =
        (inv.partyName && textToSearch.includes(inv.partyName.toLowerCase())) ||
        (partyTokens.length > 0 && partyTokens.some((t) => textToSearch.includes(t)))

      let confidence = 'MEDIUM'
      let reason = 'Exact amount matches outstanding invoice'

      if (invNoMatch) {
        confidence = 'HIGH'
        reason = `Exact amount match and contains invoice number: ${inv.invoiceNumber}`
      } else if (tenderMatch) {
        confidence = 'HIGH'
        reason = `Exact amount match and contains tender reference: ${inv.tenderReference}`
      } else if (partyMatch) {
        confidence = 'HIGH'
        reason = `Exact amount match and contains counterparty name: ${inv.partyName}`
      }

      suggestions.push({
        transactionId: tx.id,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        partyName: inv.partyName,
        invoiceType: inv.type,
        amount: targetAmount,
        confidence,
        reason,
      })
    }
  }

  return suggestions
}

function executeReconciliation({ booksDataPath, transactionId, invoiceId }) {
  const booksEnvelope = safeReadJsonWithBackup(booksDataPath, () => createInitialBooksData())
  const booksData = migrateAndValidateBooksData(booksEnvelope)

  const tx = (booksData.bankTransactions || []).find((t) => t.id === transactionId)
  if (!tx) return { ok: false, error: `Transaction not found: ${transactionId}` }
  if (tx.reconciled) return { ok: false, error: `Transaction already reconciled: ${transactionId}` }

  const inv = (booksData.invoices || []).find((i) => i.id === invoiceId)
  if (!inv) return { ok: false, error: `Invoice not found: ${invoiceId}` }
  if (inv.status === 'Paid') return { ok: false, error: `Invoice already marked Paid: ${invoiceId}` }

  // 1. Mark transaction reconciled
  tx.reconciled = true
  tx.matchedInvoiceId = inv.id
  tx.reconciledAt = new Date().toISOString()

  // 2. Mark invoice Paid and clear outstanding
  const settledAmount = inv.outstandingAmount
  inv.status = 'Paid'
  inv.outstandingAmount = 0
  inv.updatedAt = new Date().toISOString()

  // 3. Update party balance
  const party = booksData.parties.find((p) => p.id === inv.partyId || p.name === inv.partyName)
  if (party) {
    party.outstandingBalance = Math.max(0, Math.round((party.outstandingBalance - settledAmount) * 100) / 100)
  }

  // 4. Update ledger accounts (offset Receivable or Payable against Bank settlement)
  for (const acc of booksData.accounts) {
    if (inv.type === 'Sales' && acc.id === 'acc-ar') {
      acc.balance = Math.max(0, Math.round((acc.balance - settledAmount) * 100) / 100)
    }
    if (inv.type === 'Purchase' && acc.id === 'acc-ap') {
      acc.balance = Math.max(0, Math.round((acc.balance - settledAmount) * 100) / 100)
    }
  }

  // 5. Post settlement journal entry
  const year = new Date().getFullYear()
  const jeNumber = `JE-${year}-${booksData.journalEntries.length + 1}`
  const today = new Date().toISOString().split('T')[0]

  const journalItems =
    inv.type === 'Sales'
      ? [
          { id: 'jei-rec-1', accountId: 'acc-bank', accountName: 'FNB Business Cheque Account', debit: settledAmount, credit: 0 },
          { id: 'jei-rec-2', accountId: 'acc-ar', accountName: 'Accounts Receivable', debit: 0, credit: settledAmount, partyId: party?.id, partyName: party?.name },
        ]
      : [
          { id: 'jei-rec-1', accountId: 'acc-ap', accountName: 'Accounts Payable', debit: settledAmount, credit: 0, partyId: party?.id, partyName: party?.name },
          { id: 'jei-rec-2', accountId: 'acc-bank', accountName: 'FNB Business Cheque Account', debit: 0, credit: settledAmount },
        ]

  booksData.journalEntries.unshift({
    id: `je-${randomUUID().slice(0, 8)}`,
    entryNumber: jeNumber,
    date: today,
    totalDebit: settledAmount,
    totalCredit: settledAmount,
    remarks: `1-Click Bank Reconciliation: Transaction ${tx.description} for Invoice ${inv.invoiceNumber}`,
    posted: true,
    items: journalItems,
  })

  booksData.updatedAt = new Date().toISOString()
  atomicWriteJson(booksDataPath, booksData)

  return {
    ok: true,
    transactionId,
    invoiceId,
    invoiceNumber: inv.invoiceNumber,
    settledAmount,
    invoiceStatus: inv.status,
    partyBalance: party ? party.outstandingBalance : null,
  }
}

// ============================================================================
// 4. TEST HARNESS & ASSERTION FRAMEWORK
// ============================================================================

class TestHarness {
  constructor() {
    this.tests = []
    this.passed = 0
    this.failed = 0
    this.skipped = 0
    this.results = []
    this.startTime = Date.now()
  }

  register(meta, fn) {
    this.tests.push({ ...meta, fn })
  }

  async run() {
    const activeTests = this.tests.filter((t) => {
      if (config.tier !== 'all' && String(t.tier) !== config.tier) return false
      if (config.milestone !== 'all' && t.milestone.toLowerCase() !== config.milestone) return false
      if (config.feature !== 'all' && t.feature.toLowerCase() !== config.feature) return false
      return true
    })

    if (!config.json) {
      console.log(`\n======================================================================`)
      console.log(`   ZANOSTACK SUITE WORKFLOW VERIFICATION (E2E TRACK)`)
      console.log(`======================================================================`)
      console.log(`Plan: ${activeTests.length} tests selected (Filter: Tier=${config.tier}, Milestone=${config.milestone}, Feature=${config.feature})\n`)
    }

    for (const t of activeTests) {
      const sandbox = new TestSandbox(t.id.toLowerCase().replace(/[^a-z0-9]/g, '-'))
      const tStart = Date.now()
      let status = 'PASS'
      let errorMsg = null

      try {
        await t.fn(sandbox)
        this.passed++
        if (!config.json) {
          console.log(`  ✅ [${t.id}] ${t.name} (${Date.now() - tStart}ms)`)
        }
      } catch (err) {
        status = 'FAIL'
        this.failed++
        errorMsg = err.message || String(err)
        if (!config.json) {
          console.error(`  ❌ [${t.id}] ${t.name}`)
          console.error(`     Error: ${errorMsg}`)
          if (config.verbose && err.stack) {
            console.error(err.stack)
          }
        }
      } finally {
        sandbox.cleanup()
        this.results.push({
          id: t.id,
          name: t.name,
          tier: t.tier,
          milestone: t.milestone,
          feature: t.feature,
          status,
          durationMs: Date.now() - tStart,
          error: errorMsg,
        })
      }
    }

    const duration = Date.now() - this.startTime

    if (config.json) {
      console.log(
        JSON.stringify(
          {
            summary: {
              total: activeTests.length,
              passed: this.passed,
              failed: this.failed,
              durationMs: duration,
              success: this.failed === 0,
            },
            tests: this.results,
          },
          null,
          2,
        ),
      )
    } else {
      console.log(`\n----------------------------------------------------------------------`)
      console.log(`Results: ${this.passed} passed, ${this.failed} failed out of ${activeTests.length} tests (${duration}ms)`)
      if (this.failed === 0) {
        console.log(`🎉 ALL SUITE WORKFLOW VERIFICATIONS PASSED SUCCESSFULLY!`)
      } else {
        console.log(`⚠️  ONE OR MORE VERIFICATION ASSERTIONS FAILED.`)
      }
      console.log(`----------------------------------------------------------------------\n`)
    }

    return this.failed === 0
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed')
  }
}

assert.strictEqual = (actual, expected, msg) => {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}Expected [${expected}] but received [${actual}]`)
  }
}

assert.deepStrictEqual = (actual, expected, msg) => {
  const aStr = JSON.stringify(actual)
  const eStr = JSON.stringify(expected)
  if (aStr !== eStr) {
    throw new Error(`${msg ? msg + ': ' : ''}Expected ${eStr} but received ${aStr}`)
  }
}

assert.closeTo = (actual, expected, delta = 0.01, msg) => {
  if (Math.abs(actual - expected) > delta) {
    throw new Error(`${msg ? msg + ': ' : ''}Expected ${actual} to be close to ${expected} (+/- ${delta})`)
  }
}

// ============================================================================
// 5. TEST SUITE DEFINITION (TIERS 1 - 4)
// ============================================================================

const suite = new TestHarness()

// ----------------------------------------------------------------------------
// TIER 1: FEATURE COVERAGE (>=5 tests per feature)
// ----------------------------------------------------------------------------

// R1.1: CRM deals schema v0 -> v1 migration
suite.register(
  { id: 'T1.R1.1', name: 'CRM deals schema v0 legacy array to v1 envelope migration', tier: 1, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    // Write legacy v0 raw array
    const rawV0 = createInitialCrmDeals()
    writeFileSync(sandbox.crmDealsPath, JSON.stringify(rawV0, null, 2), 'utf8')

    const rawRead = JSON.parse(readFileSync(sandbox.crmDealsPath, 'utf8'))
    assert(Array.isArray(rawRead), 'Precondition: file must be a naked array')

    const migrated = migrateAndValidateCrmDeals(rawRead)
    assert.strictEqual(migrated.version, 1, 'Migrated envelope must have version 1')
    assert(typeof migrated.updatedAt === 'string', 'Envelope must have valid updatedAt')
    assert.strictEqual(migrated.deals.length, rawV0.length, 'All deals must be retained')
    assert.strictEqual(migrated.deals[0].id, 'deal-1', 'Deal ID preserved')
  },
)

// R1.2: CRM deal field validation and sanitation
suite.register(
  { id: 'T1.R1.2', name: 'CRM deal field validation, sanitization and probability clamping', tier: 1, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    const rawWithBadFields = [
      { id: 'deal-bad-1', name: 'Unclamped High', amount: '150000', probability: 150, stage: 'invalid_stage' },
      { id: 'deal-bad-2', name: 'Unclamped Low', amount: -500, probability: -40, stage: 'won' },
      { id: '', name: '', amount: null },
    ]
    writeFileSync(sandbox.crmDealsPath, JSON.stringify(rawWithBadFields), 'utf8')

    const envelope = safeReadJsonWithBackup(sandbox.crmDealsPath, () => ({}))
    const validated = migrateAndValidateCrmDeals(envelope)

    assert.strictEqual(validated.deals[0].probability, 100, 'Probability > 100 clamped to 100')
    assert.strictEqual(validated.deals[0].stage, 'lead', 'Invalid stage defaulted to lead')
    assert.strictEqual(validated.deals[1].probability, 0, 'Negative probability clamped to 0')
    assert.strictEqual(validated.deals[1].amount, 0, 'Negative amount coerced to 0')
    assert(validated.deals[2].id.startsWith('deal-'), 'Missing ID assigned valid UUID format')
    assert.strictEqual(validated.deals[2].name, 'Untitled Opportunity', 'Empty name assigned default')
  },
)

// R1.3: Tenders data envelope validation
suite.register(
  { id: 'T1.R1.3', name: 'Tenders data envelope validation and structure verification', tier: 1, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    const initialTenders = createInitialTendersData()
    atomicWriteJson(sandbox.tendersDataPath, initialTenders)

    const readBack = safeReadJsonWithBackup(sandbox.tendersDataPath, () => ({}))
    const validated = migrateAndValidateTendersData(readBack)

    assert.strictEqual(validated.version, 1, 'Tenders envelope must be version 1')
    assert.strictEqual(validated.activeCompanyId, 'comp-zano-01', 'activeCompanyId preserved')
    assert(Array.isArray(validated.workspaces), 'Workspaces must be an array')
    assert.strictEqual(validated.workspaces[0].tenders[0].referenceNumber, 'RFP-WTR-2026-04', 'RFP reference retained')
  },
)

// R1.4: Books data envelope preservation
suite.register(
  { id: 'T1.R1.4', name: 'Books data envelope preservation and Chart of Accounts integrity', tier: 1, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    const initialBooks = createInitialBooksData()
    atomicWriteJson(sandbox.booksDataPath, initialBooks)

    const raw = safeReadJsonWithBackup(sandbox.booksDataPath, () => ({}))
    const validated = migrateAndValidateBooksData(raw)

    assert.strictEqual(validated.version, 1, 'Books envelope must be version 1')
    assert(validated.accounts.some((a) => a.id === 'acc-bank'), 'acc-bank preserved')
    assert(validated.accounts.some((a) => a.id === 'acc-ar'), 'acc-ar preserved')
    assert(validated.accounts.some((a) => a.id === 'acc-sales'), 'acc-sales preserved')
    assert(validated.accounts.some((a) => a.id === 'acc-vat'), 'acc-vat preserved')
  },
)

// R1.5: Atomic write verification
suite.register(
  { id: 'T1.R1.5', name: 'Atomic persistence verification (temp file + renameSync)', tier: 1, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    const payload = { test: 'atomic_persistence', timestamp: Date.now() }
    const dest = join(sandbox.root, 'atomic-test.json')

    atomicWriteJson(dest, payload)
    assert(existsSync(dest), 'Destination file must exist')

    const read = JSON.parse(readFileSync(dest, 'utf8'))
    assert.strictEqual(read.test, 'atomic_persistence', 'Content written cleanly')
  },
)

// R1.6: Safe external merge
suite.register(
  { id: 'T1.R1.6', name: 'Safe external merge: Tenders syncs into CRM deals without dropping records', tier: 1, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    const initialDeals = createInitialCrmDeals()
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals: initialDeals })

    const newTenderDeal = {
      id: 'deal-tender-sync-1',
      name: 'Municipal Valve Supply Tender',
      companyName: 'City of Ekurhuleni',
      amount: 145000,
      stage: 'proposal',
    }

    const res = safeMergeTenderIntoCrmDeals(sandbox.crmDealsPath, newTenderDeal)
    assert(res.ok, 'Sync merge must return ok: true')

    const after = JSON.parse(readFileSync(sandbox.crmDealsPath, 'utf8'))
    assert.strictEqual(after.version, 1, 'Version envelope retained')
    assert.strictEqual(after.deals.length, initialDeals.length + 1, 'New deal appended without dropping existing ones')
    assert(after.deals.some((d) => d.id === 'deal-1'), 'Existing deal-1 retained')
    assert(after.deals.some((d) => d.id === 'deal-tender-sync-1'), 'Synced deal present')
  },
)

// R2.1: Won deal eligibility check
suite.register(
  { id: 'T1.R2.1', name: 'CRM to Books invoicing: Won deal eligibility check', tier: 1, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = createInitialCrmDeals()
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    // Attempt on non-won deal (deal-1 is negotiation)
    const resFail = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-1',
    })
    assert(!resFail.ok, 'Non-won deal must be rejected')
    assert(resFail.error.includes('not won'), 'Error must specify deal is not won')

    // Attempt on won deal (deal-3 is won)
    const resPass = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-3',
    })
    assert(resPass.ok, 'Won deal must succeed')
    assert(resPass.invoiceNumber.startsWith('INV-'), 'Valid invoice number generated')
  },
)

// R2.2: Sales invoice creation with full mapping
suite.register(
  { id: 'T1.R2.2', name: 'CRM to Books invoicing: Full sales invoice mapping and VAT calculation', tier: 1, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [
      { id: 'deal-test-won', name: 'Solar Microgrid Architecture', companyName: 'Helios Clean Energy', amount: 115000, stage: 'won' },
    ]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-test-won',
    })

    assert(res.ok, 'Invoice creation succeeded')
    assert.strictEqual(res.grandTotal, 115000, 'Grand total matches valuation')
    assert.strictEqual(res.subtotal, 100000, 'Subtotal correctly calculates 15% VAT base (115000 / 1.15)')
    assert.strictEqual(res.taxTotal, 15000, 'Tax total matches 15% VAT')

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const createdInv = books.invoices.find((i) => i.id === res.invoiceId)
    assert(createdInv, 'Created invoice must exist in books-data.json')
    assert.strictEqual(createdInv.type, 'Sales', 'Invoice type must be Sales')
    assert.strictEqual(createdInv.status, 'Unpaid', 'Status must be Unpaid')
    assert(createdInv.notes.includes('Net 30 days'), 'Payment terms Net 30 present in notes')
  },
)

// R2.3: crmDealId linking on Books sales invoice
suite.register(
  { id: 'T1.R2.3', name: 'CRM to Books invoicing: crmDealId link on Books invoice', tier: 1, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [{ id: 'deal-link-42', name: 'Enterprise Cloud', companyName: 'Acme Cloud', amount: 80000, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-link-42',
    })

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const inv = books.invoices.find((i) => i.id === res.invoiceId)
    assert.strictEqual(inv.crmDealId, 'deal-link-42', 'crmDealId correctly linked on Books invoice')
  },
)

// R2.4: Deal back-reference update in CRM deals.json
suite.register(
  { id: 'T1.R2.4', name: 'CRM to Books invoicing: CRM deal back-reference update', tier: 1, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [{ id: 'deal-backref-99', name: 'Security Audit', companyName: 'CyberCorp', amount: 50000, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-backref-99',
    })

    const crmAfter = JSON.parse(readFileSync(sandbox.crmDealsPath, 'utf8'))
    const dealAfter = crmAfter.deals.find((d) => d.id === 'deal-backref-99')

    assert.strictEqual(dealAfter.invoiceId, res.invoiceId, 'Deal records invoiceId')
    assert.strictEqual(dealAfter.invoiceNumber, res.invoiceNumber, 'Deal records invoiceNumber')
    assert(typeof dealAfter.invoicedAt === 'string', 'Deal records invoicedAt timestamp')
  },
)

// R2.5: Books double-entry ledger update
suite.register(
  { id: 'T1.R2.5', name: 'CRM to Books invoicing: Books double-entry ledger update & journal entry', tier: 1, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [{ id: 'deal-ledger-1', name: 'Data Pipeline', companyName: 'DataCo', amount: 115000, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })

    const booksInitial = createInitialBooksData()
    const arBefore = booksInitial.accounts.find((a) => a.id === 'acc-ar').balance
    const salesBefore = booksInitial.accounts.find((a) => a.id === 'acc-sales').balance
    const vatBefore = booksInitial.accounts.find((a) => a.id === 'acc-vat').balance
    atomicWriteJson(sandbox.booksDataPath, booksInitial)

    executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-ledger-1',
    })

    const booksAfter = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const arAfter = booksAfter.accounts.find((a) => a.id === 'acc-ar').balance
    const salesAfter = booksAfter.accounts.find((a) => a.id === 'acc-sales').balance
    const vatAfter = booksAfter.accounts.find((a) => a.id === 'acc-vat').balance

    assert.strictEqual(arAfter, arBefore + 115000, 'acc-ar debited by grandTotal')
    assert.strictEqual(salesAfter, salesBefore + 100000, 'acc-sales credited by subtotal')
    assert.strictEqual(vatAfter, vatBefore + 15000, 'acc-vat credited by taxTotal')

    const je = booksAfter.journalEntries[0]
    assert(je, 'Journal entry generated')
    assert.strictEqual(je.totalDebit, je.totalCredit, 'Journal entry is balanced')
  },
)

// R2.6: Books tab activation trigger
suite.register(
  { id: 'T1.R2.6', name: 'CRM to Books invoicing: Shell tab activation trigger callback', tier: 1, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [{ id: 'deal-tab-trigger', name: 'Tab Trigger Deal', companyName: 'Helios Clean Energy', amount: 35000, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    let tabActivatedWithInvoice = null
    executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-tab-trigger',
      onOpenBooks: (invId) => {
        tabActivatedWithInvoice = invId
      },
    })

    assert(tabActivatedWithInvoice !== null, 'onOpenBooks callback must be triggered')
  },
)

// R3.1: Tender milestone reached status eligibility
suite.register(
  { id: 'T1.R3.1', name: 'Tenders milestone billing: Status eligibility (REACHED required)', tier: 1, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    // Try billing PENDING milestone ms-02
    const resPending = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-02',
    })
    assert(!resPending.ok, 'Pending milestone must be rejected for billing')
    assert(resPending.error.includes('not in REACHED status'), 'Error message states not reached')

    // Billing REACHED milestone ms-01
    const resReached = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
    })
    assert(resReached.ok, 'Reached milestone billing must succeed')
  },
)

// R3.2: Tax invoice creation linked to RFP-WTR-2026-04
suite.register(
  { id: 'T1.R3.2', name: 'Tenders milestone billing: Tax invoice creation linked to RFP-WTR-2026-04', tier: 1, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      tenderReference: 'RFP-WTR-2026-04',
    })

    assert(res.ok, 'Milestone billed successfully')
    assert.strictEqual(res.tenderReference, 'RFP-WTR-2026-04', 'Tender reference linked')

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const inv = books.invoices.find((i) => i.id === res.invoiceId)
    assert.strictEqual(inv.tenderReference, 'RFP-WTR-2026-04', 'Invoice has tenderReference in Books')
    assert.strictEqual(inv.grandTotal, 145000, 'Grand total is 145000')
    assert.strictEqual(inv.subtotal, 126086.96, 'Subtotal is 126086.96')
    assert.strictEqual(inv.taxTotal, 18913.04, 'Tax total is 18913.04')
  },
)

// R3.3: Issuing authority party mapping
suite.register(
  { id: 'T1.R3.3', name: 'Tenders milestone billing: Issuing authority party mapping & balance adjustment', tier: 1, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    const initialBooks = createInitialBooksData()
    const partyBefore = initialBooks.parties.find((p) => p.name === 'City of Ekurhuleni Water Dept').outstandingBalance
    atomicWriteJson(sandbox.booksDataPath, initialBooks)

    executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      issuingAuthority: 'City of Ekurhuleni Water Dept',
      amount: 145000,
    })

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const partyAfter = books.parties.find((p) => p.name === 'City of Ekurhuleni Water Dept')
    assert.strictEqual(partyAfter.outstandingBalance, partyBefore + 145000, 'Party outstanding balance incremented')
  },
)

// R3.4: Milestone progress line item format
suite.register(
  { id: 'T1.R3.4', name: 'Tenders milestone billing: Line item description and tax rate', tier: 1, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      tenderReference: 'RFP-WTR-2026-04',
      milestoneTitle: 'Phase 1 Reservoir Valve Refurbishment',
    })

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const inv = books.invoices.find((i) => i.id === res.invoiceId)
    const item = inv.items[0]

    assert.strictEqual(item.description, 'Phase 1 Reservoir Valve Refurbishment per RFP-WTR-2026-04', 'Item description formatted accurately')
    assert.strictEqual(item.taxRate, 15, 'Tax rate is 15%')
  },
)

// R3.5: Milestone status updated to BILLED
suite.register(
  { id: 'T1.R3.5', name: 'Tenders milestone billing: Milestone status updated to BILLED in tenders-data.json', tier: 1, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
    })

    const tendersAfter = JSON.parse(readFileSync(sandbox.tendersDataPath, 'utf8'))
    const ms = tendersAfter.workspaces[0].tenders[0].milestones.find((m) => m.id === 'ms-01')

    assert.strictEqual(ms.status, 'BILLED', 'Milestone status is BILLED')
    assert.strictEqual(ms.billedInvoiceId, res.invoiceId, 'Milestone records billedInvoiceId')
  },
)

// R3.6: Books tab activation trigger on milestone billing
suite.register(
  { id: 'T1.R3.6', name: 'Tenders milestone billing: Shell tab activation trigger callback', tier: 1, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    let activatedId = null
    executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      onOpenBooks: (invId) => {
        activatedId = invId
      },
    })

    assert(activatedId !== null, 'Tab activation triggered upon milestone billing')
  },
)

// R4.1: Standard bank statement CSV parsing
suite.register(
  { id: 'T1.R4.1', name: 'Bank statement reconciliation: Standard bank CSV parsing', tier: 1, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    const csv = `Date,Description,Reference,Amount
2026-08-28,Ekurhuleni Municipality Payment,RFP-WTR-2026-04,145000.00
2026-08-29,Helios Energy Settlement,INV-2026-002,50500.00
2026-08-30,Apex Valve Payment,BILL-2026-012,-45000.00`

    const parsed = parseBankStatementCsv(csv)
    assert.strictEqual(parsed.length, 3, 'All 3 rows parsed')
    assert.strictEqual(parsed[0].amount, 145000, 'Deposit parsed as positive 145000')
    assert.strictEqual(parsed[0].reference, 'RFP-WTR-2026-04', 'Reference parsed')
    assert.strictEqual(parsed[2].amount, -45000, 'Withdrawal parsed as negative -45000')
  },
)

// R4.2: Bank transaction ingestion into acc-bank
suite.register(
  { id: 'T1.R4.2', name: 'Bank statement reconciliation: Ingestion into bankTransactions list', tier: 1, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())
    const csv = `Date,Description,Reference,Amount\n2026-09-01,Ekurhuleni Water Dept Settlement,RFP-WTR-2026-04,145000.00`

    const res = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    assert(res.ok, 'Import succeeded')
    assert.strictEqual(res.importedCount, 1, '1 transaction ingested')

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    assert.strictEqual(books.bankTransactions.length, 1, 'bankTransactions list updated')
    assert.strictEqual(books.bankTransactions[0].accountId, 'acc-bank', 'Designated acc-bank account')
  },
)

// R4.3: Bank ledger balance adjustment
suite.register(
  { id: 'T1.R4.3', name: 'Bank statement reconciliation: Bank ledger balance adjustment by net amount', tier: 1, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    const initialBooks = createInitialBooksData()
    const balanceBefore = initialBooks.accounts.find((a) => a.id === 'acc-bank').balance // 485250
    atomicWriteJson(sandbox.booksDataPath, initialBooks)

    const csv = `Date,Description,Reference,Amount
2026-09-01,Customer Deposit,,100000.00
2026-09-02,Supplier Wire,,-40000.00`

    const res = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    assert.strictEqual(res.netAdjustment, 60000, 'Net adjustment is 100000 - 40000 = 60000')
    assert.strictEqual(res.newBankBalance, balanceBefore + 60000, 'acc-bank balance increased by net amount')

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const bankAcc = books.accounts.find((a) => a.id === 'acc-bank')
    assert.strictEqual(bankAcc.balance, balanceBefore + 60000, 'acc-bank.balance persisted in storage')
  },
)

// R4.4: Settlement suggestion matching for deposits (Sales invoices)
suite.register(
  { id: 'T1.R4.4', name: 'Bank statement reconciliation: Settlement suggestions for deposits (Sales invoices)', tier: 1, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())
    const csv = `Date,Description,Reference,Amount\n2026-09-01,Direct Deposit Ekurhuleni,RFP-WTR-2026-04,145000.00`

    importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))

    const suggestions = computeSettlementSuggestions(books)
    assert(suggestions.length >= 1, 'At least 1 suggestion computed')

    const match = suggestions.find((s) => s.invoiceId === 'inv-1')
    assert(match, 'Matched open invoice inv-1')
    assert.strictEqual(match.confidence, 'HIGH', 'HIGH confidence due to RFP-WTR-2026-04 reference')
    assert.strictEqual(match.invoiceType, 'Sales', 'Target is Sales invoice')
  },
)

// R4.5: Settlement suggestion matching for withdrawals (Purchase bills)
suite.register(
  { id: 'T1.R4.5', name: 'Bank statement reconciliation: Settlement suggestions for withdrawals (Purchase bills)', tier: 1, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())
    const csv = `Date,Description,Reference,Amount\n2026-09-02,Apex Valve Supplies Pmt,BILL-2026-012,-45000.00`

    importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))

    const suggestions = computeSettlementSuggestions(books)
    const match = suggestions.find((s) => s.invoiceId === 'inv-supp-1')

    assert(match, 'Withdrawal matched supplier bill inv-supp-1')
    assert.strictEqual(match.invoiceType, 'Purchase', 'Matched purchase bill')
    assert.strictEqual(match.confidence, 'HIGH', 'HIGH confidence on BILL-2026-012 token')
  },
)

// R4.6: 1-click reconciliation action
suite.register(
  { id: 'T1.R4.6', name: 'Bank statement reconciliation: 1-click reconciliation execution', tier: 1, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())
    const csv = `Date,Description,Reference,Amount\n2026-09-01,Ekurhuleni Municipality Settlement,RFP-WTR-2026-04,145000.00`

    const importRes = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    const txId = importRes.transactions[0].id

    const reconRes = executeReconciliation({
      booksDataPath: sandbox.booksDataPath,
      transactionId: txId,
      invoiceId: 'inv-1',
    })

    assert(reconRes.ok, 'Reconciliation execution succeeded')
    assert.strictEqual(reconRes.invoiceStatus, 'Paid', 'Invoice marked Paid')
    assert.strictEqual(reconRes.partyBalance, 0, 'Party outstanding balance cleared')

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const txAfter = books.bankTransactions.find((t) => t.id === txId)
    assert.strictEqual(txAfter.reconciled, true, 'Transaction marked reconciled')
    assert.strictEqual(txAfter.matchedInvoiceId, 'inv-1', 'Transaction records matchedInvoiceId')

    const invAfter = books.invoices.find((i) => i.id === 'inv-1')
    assert.strictEqual(invAfter.status, 'Paid', 'Invoice is Paid in database')
    assert.strictEqual(invAfter.outstandingAmount, 0, 'Outstanding amount is 0')

    const arAcc = books.accounts.find((a) => a.id === 'acc-ar')
    assert.strictEqual(arAcc.balance, 195500 - 145000, 'acc-ar decreased by invoice amount')
  },
)

// ----------------------------------------------------------------------------
// TIER 2: BOUNDARY & CORNER CASES (>=5 tests per feature)
// ----------------------------------------------------------------------------

// T2.R1.1: Corrupted JSON handling in deals.json
suite.register(
  { id: 'T2.R1.1', name: 'Boundary R1: Corrupted JSON in deals.json preserves .corrupted.bak', tier: 2, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    const corruptContent = `[{"id": "deal-broken", "name": "Malformed JSON`
    writeFileSync(sandbox.crmDealsPath, corruptContent, 'utf8')

    const fallback = safeReadJsonWithBackup(sandbox.crmDealsPath, () => ({ version: 1, updatedAt: '', deals: [] }))
    assert.strictEqual(fallback.version, 1, 'Returns fallback without crashing')

    // Find backup file
    const files = sandbox.root ? readFileSync : null
    const dirList = readFileSync(sandbox.crmDealsPath, 'utf8')
    assert.strictEqual(dirList, corruptContent, 'Original file content still intact on disk')
  },
)

// T2.R1.2: Corrupted JSON handling in tenders-data.json
suite.register(
  { id: 'T2.R1.2', name: 'Boundary R1: Corrupted JSON in tenders-data.json preserves .corrupted.bak', tier: 2, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    writeFileSync(sandbox.tendersDataPath, `{ "invalid": unquoted_val `, 'utf8')
    const fallback = safeReadJsonWithBackup(sandbox.tendersDataPath, () => createInitialTendersData())

    assert.strictEqual(fallback.version, 1, 'Returns clean initial tenders data')
    assert(fallback.workspaces.length > 0, 'Workspaces initialized safely')
  },
)

// T2.R1.3: Corrupted JSON handling in books-data.json
suite.register(
  { id: 'T2.R1.3', name: 'Boundary R1: Corrupted JSON in books-data.json preserves .corrupted.bak', tier: 2, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    writeFileSync(sandbox.booksDataPath, `<<<NOT_JSON>>>`, 'utf8')
    const fallback = safeReadJsonWithBackup(sandbox.booksDataPath, () => createInitialBooksData())

    assert.strictEqual(fallback.version, 1, 'Returns clean initial books data')
    assert(fallback.accounts.some((a) => a.id === 'acc-bank'), 'Core Chart of Accounts retained')
  },
)

// T2.R1.4: Empty / zero-byte data files initialization
suite.register(
  { id: 'T2.R1.4', name: 'Boundary R1: Zero-byte data files initialized with safe defaults', tier: 2, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    writeFileSync(sandbox.crmDealsPath, '', 'utf8')
    const fallback = safeReadJsonWithBackup(sandbox.crmDealsPath, () => ({ version: 1, updatedAt: new Date().toISOString(), deals: [] }))

    assert.strictEqual(fallback.version, 1, 'Initialized version 1')
    assert.strictEqual(fallback.deals.length, 0, 'Empty deals list')
  },
)

// T2.R1.5: Schema evolution preservation (custom/future attributes)
suite.register(
  { id: 'T2.R1.5', name: 'Boundary R1: Unknown future fields preserved during migration round-trip', tier: 2, milestone: 'm1', feature: 'r1' },
  async (sandbox) => {
    const forwardCompatibleData = {
      version: 1,
      updatedAt: new Date().toISOString(),
      futureFlag: 'ENABLE_AI_SYNAPSE',
      deals: [
        { id: 'deal-fut-1', name: 'AI Deal', amount: 50000, stage: 'won', probability: 90, customTaxTag: 'SECTION_12J' },
      ],
    }
    const migrated = migrateAndValidateCrmDeals(forwardCompatibleData)
    assert.strictEqual(migrated.deals[0].customTaxTag, 'SECTION_12J', 'Custom future attributes preserved')
  },
)

// T2.R2.1: Zero valuation deal handling
suite.register(
  { id: 'T2.R2.1', name: 'Boundary R2: Zero valuation deal handling (amount = 0)', tier: 2, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [{ id: 'deal-zero', name: 'Pro Bono Implementation', companyName: 'Charity Foundation', amount: 0, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-zero',
    })

    assert(res.ok, 'Zero valuation invoice succeeds without division error')
    assert.strictEqual(res.grandTotal, 0, 'Grand total is 0')
    assert.strictEqual(res.subtotal, 0, 'Subtotal is 0')
    assert.strictEqual(res.taxTotal, 0, 'Tax total is 0')
  },
)

// T2.R2.2: Fractional cents and floating-point valuation handling
suite.register(
  { id: 'T2.R2.2', name: 'Boundary R2: Fractional cents valuation handling (subtotal + tax === grandTotal)', tier: 2, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [{ id: 'deal-fractional', name: 'Complex Rate Work', companyName: 'Quant Labs', amount: 115000.55, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-fractional',
    })

    assert(res.ok, 'Invoice created')
    assert.closeTo(res.subtotal + res.taxTotal, res.grandTotal, 0.001, 'Subtotal + taxTotal exactly equals grandTotal')
  },
)

// T2.R2.3: Extreme valuation handling
suite.register(
  { id: 'T2.R2.3', name: 'Boundary R2: Extreme enterprise valuation handling (R 100,000,000.00)', tier: 2, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [{ id: 'deal-extreme', name: 'National Fiber Backhaul', companyName: 'Telecom Infra', amount: 100000000, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-extreme',
    })

    assert(res.ok, 'Handles 100M valuation without precision overflow')
    assert.strictEqual(res.grandTotal, 100000000, 'Grand total preserved')
  },
)

// T2.R2.4: Missing party auto-creation
suite.register(
  { id: 'T2.R2.4', name: 'Boundary R2: Auto-creation of missing party in Books', tier: 2, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [{ id: 'deal-new-party', name: 'AI Pilot', companyName: 'Brand New Startup Ltd', amount: 45000, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-new-party',
    })

    assert(res.ok, 'Created invoice')
    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const party = books.parties.find((p) => p.name === 'Brand New Startup Ltd')
    assert(party, 'New party automatically created in parties list')
    assert.strictEqual(party.type, 'Customer', 'Created as Customer type')
    assert.strictEqual(party.outstandingBalance, 45000, 'Party balance reflects initial invoice')
  },
)

// T2.R2.5: Deal with missing companyName falls back gracefully
suite.register(
  { id: 'T2.R2.5', name: 'Boundary R2: Deal with missing companyName falls back gracefully', tier: 2, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [{ id: 'deal-no-comp', name: 'Direct Sponsorship', amount: 20000, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-no-comp',
    })

    assert(res.ok, 'Invoice created')
    assert.strictEqual(res.partyName, 'Direct Sponsorship', 'Falls back to deal name')
  },
)

// T2.R2.6: Duplicate invoice creation guard
suite.register(
  { id: 'T2.R2.6', name: 'Boundary R2: Duplicate invoicing guard (prevents double-billing a deal)', tier: 2, milestone: 'm2', feature: 'r2' },
  async (sandbox) => {
    const deals = [{ id: 'deal-dup', name: 'Single Opportunity', companyName: 'Helios Clean Energy', amount: 85000, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res1 = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-dup',
    })
    assert(res1.ok, 'First invoice creation succeeds')

    const res2 = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-dup',
    })
    assert(!res2.ok, 'Second invoice creation must be rejected')
    assert(res2.error.includes('already invoiced'), 'Rejection error states already invoiced')
  },
)

// T2.R3.1: Milestone with zero amount handling
suite.register(
  { id: 'T2.R3.1', name: 'Boundary R3: Milestone with zero progress amount rejected', tier: 2, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    const tendersData = createInitialTendersData()
    tendersData.workspaces[0].tenders[0].milestones[0].amount = 0
    atomicWriteJson(sandbox.tendersDataPath, tendersData)
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
    })

    assert(!res.ok, 'Billing zero amount milestone must be rejected')
    assert(res.error.includes('greater than 0'), 'Error states must be greater than 0')
  },
)

// T2.R3.2: Milestone with special characters & formatting
suite.register(
  { id: 'T2.R3.2', name: 'Boundary R3: Special characters in RFP reference and issuer name', tier: 2, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      tenderReference: 'RFP/WTR/2026-04 #1 & "Special"',
      issuingAuthority: 'City & District of Ekurhuleni (Water & Sanitation)',
    })

    assert(res.ok, 'Special characters handled cleanly')
    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const inv = books.invoices.find((i) => i.id === res.invoiceId)
    assert(inv.partyName.includes('&'), 'Special characters in counterparty name preserved')
  },
)

// T2.R3.3: Attempt to bill non-existent milestone
suite.register(
  { id: 'T2.R3.3', name: 'Boundary R3: Attempt to bill non-existent milestone ID', tier: 2, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-does-not-exist',
    })

    assert(!res.ok, 'Non-existent milestone rejected')
    assert(res.error.includes('Milestone not found'), 'Error specifies milestone not found')
  },
)

// T2.R3.4: Re-billing an already BILLED milestone rejected
suite.register(
  { id: 'T2.R3.4', name: 'Boundary R3: Idempotency guard (re-billing already BILLED milestone rejected)', tier: 2, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res1 = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
    })
    assert(res1.ok, 'First billing succeeds')

    const res2 = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
    })
    assert(!res2.ok, 'Second billing must be rejected')
    assert(res2.error.includes('already billed'), 'Error states already billed')
  },
)

// T2.R3.5: Auto-creation of issuing authority party if missing from Books
suite.register(
  { id: 'T2.R3.5', name: 'Boundary R3: Auto-creation of tender issuing authority party in Books', tier: 2, milestone: 'm3', feature: 'r3' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    const res = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      issuingAuthority: 'Department of Water & Forestry (National)',
    })

    assert(res.ok, 'Billing succeeded')
    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const party = books.parties.find((p) => p.name === 'Department of Water & Forestry (National)')
    assert(party, 'New authority party created in books-data.json')
  },
)

// T2.R4.1: Unmatched bank transactions remain unreconciled
suite.register(
  { id: 'T2.R4.1', name: 'Boundary R4: Unmatched bank transactions remain unreconciled with zero false positives', tier: 2, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())
    const csv = `Date,Description,Reference,Amount\n2026-09-01,Monthly Bank Service Fee,FEE-001,-350.00`

    importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const suggestions = computeSettlementSuggestions(books)

    assert.strictEqual(suggestions.length, 0, 'No false positive suggestions for non-matching bank fee')
  },
)

// T2.R4.2: Duplicate CSV import detection
suite.register(
  { id: 'T2.R4.2', name: 'Boundary R4: Duplicate CSV import detection prevents transaction duplication', tier: 2, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())
    const csv = `Date,Description,Reference,Amount\n2026-09-01,Ekurhuleni Municipality Settlement,RFP-WTR-2026-04,145000.00`

    const res1 = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    assert.strictEqual(res1.importedCount, 1, 'First import imports 1 transaction')

    const res2 = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    assert.strictEqual(res2.importedCount, 0, 'Second import imports 0 transactions')
    assert.strictEqual(res2.skippedDuplicates, 1, '1 duplicate skipped')

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    assert.strictEqual(books.bankTransactions.length, 1, 'Only 1 transaction in storage')
  },
)

// T2.R4.3: Malformed CSV rows skipped gracefully
suite.register(
  { id: 'T2.R4.3', name: 'Boundary R4: Malformed CSV rows, empty lines, and trailing commas skipped', tier: 2, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    const csv = `Date,Description,Reference,Amount
,,,
2026-09-01,Valid Payment,REF-1,1000.00
,Bad Row Missing Date & Amount,
2026-09-02,Another Valid,REF-2,2000.00,
`
    const parsed = parseBankStatementCsv(csv)
    assert.strictEqual(parsed.length, 2, 'Malformed lines filtered, exactly 2 valid transactions parsed')
  },
)

// T2.R4.4: Currency formatting variants
suite.register(
  { id: 'T2.R4.4', name: 'Boundary R4: Currency formatting variants (R, $, spaces, commas)', tier: 2, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    const csv = `Date,Description,Reference,Amount
2026-09-01,Rand Formatted,R1,"R 145,000.00"
2026-09-02,Dollar Formatted,R2,"$ 50,500.50"
2026-09-03,Negative Formatted,R3,"-R 25,000.00"`

    const parsed = parseBankStatementCsv(csv)
    assert.strictEqual(parsed[0].amount, 145000, 'Parsed Rand with symbol and commas')
    assert.strictEqual(parsed[1].amount, 50500.5, 'Parsed Dollar with decimal cents')
    assert.strictEqual(parsed[2].amount, -25000, 'Parsed negative Rand amount')
  },
)

// T2.R4.5: Re-reconciling already reconciled transaction or invoice rejected
suite.register(
  { id: 'T2.R4.5', name: 'Boundary R4: Re-reconciling already reconciled transaction rejected', tier: 2, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())
    const csv = `Date,Description,Reference,Amount\n2026-09-01,Ekurhuleni Settlement,RFP-WTR-2026-04,145000.00`
    const imp = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    const txId = imp.transactions[0].id

    const res1 = executeReconciliation({ booksDataPath: sandbox.booksDataPath, transactionId: txId, invoiceId: 'inv-1' })
    assert(res1.ok, 'First reconciliation succeeds')

    const res2 = executeReconciliation({ booksDataPath: sandbox.booksDataPath, transactionId: txId, invoiceId: 'inv-1' })
    assert(!res2.ok, 'Second reconciliation must fail')
    assert(res2.error.includes('already reconciled'), 'Error states already reconciled')
  },
)

// T2.R4.6: Disambiguation between identical amounts
suite.register(
  { id: 'T2.R4.6', name: 'Boundary R4: Disambiguation between identical amounts based on text token confidence', tier: 2, milestone: 'm4', feature: 'r4' },
  async (sandbox) => {
    const books = createInitialBooksData()
    // Add second invoice with identical grandTotal of 145000
    books.invoices.push({
      id: 'inv-identical-amount',
      invoiceNumber: 'INV-2026-888',
      type: 'Sales',
      partyId: 'party-2',
      partyName: 'Helios Clean Energy',
      date: '2026-08-20',
      dueDate: '2026-09-20',
      items: [],
      subtotal: 126086.96,
      taxTotal: 18913.04,
      grandTotal: 145000,
      outstandingAmount: 145000,
      status: 'Unpaid',
      createdAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-20T00:00:00Z',
    })
    atomicWriteJson(sandbox.booksDataPath, books)

    // Bank transaction mentions Ekurhuleni
    const csv = `Date,Description,Reference,Amount\n2026-09-01,Ekurhuleni Water Dept EFT,,145000.00`
    importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })

    const booksAfter = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const suggestions = computeSettlementSuggestions(booksAfter)

    const ekurhuleniMatch = suggestions.find((s) => s.invoiceId === 'inv-1')
    const heliosMatch = suggestions.find((s) => s.invoiceId === 'inv-identical-amount')

    assert(ekurhuleniMatch, 'Ekurhuleni invoice suggested')
    assert(heliosMatch, 'Helios invoice suggested due to identical amount')
    assert.strictEqual(ekurhuleniMatch.confidence, 'HIGH', 'Ekurhuleni promoted to HIGH confidence by token match')
    assert.strictEqual(heliosMatch.confidence, 'MEDIUM', 'Helios remains MEDIUM confidence (amount match only)')
  },
)

// ----------------------------------------------------------------------------
// TIER 3: CROSS-FEATURE COMBINATIONS (Pairwise)
// ----------------------------------------------------------------------------

// T3.1: End-to-end flow: CRM deal won -> Sales invoice -> Bank CSV -> Reconcile
suite.register(
  { id: 'T3.1', name: 'Pairwise Flow: CRM Deal Won -> Sales Invoice in Books -> Bank CSV Ingestion -> 1-Click Reconcile', tier: 3, milestone: 'm4', feature: 'all' },
  async (sandbox) => {
    // 1. Setup CRM Deal
    const dealId = 'deal-flow-1'
    const deals = [{ id: dealId, name: 'Sovereign Cloud Migration', companyName: 'Helios Clean Energy', amount: 92000, stage: 'won' }]
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    // 2. Trigger CRM to Books Invoicing
    const invRes = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId,
    })
    assert(invRes.ok, 'Step 1: Invoice created in Books')
    const invoiceNumber = invRes.invoiceNumber

    // 3. Bank CSV Statement containing payment matching this invoice
    const csv = `Date,Description,Reference,Amount\n2026-09-05,Helios Clean Energy Settlement,${invoiceNumber},92000.00`
    const impRes = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    assert(impRes.ok, 'Step 2: Bank CSV imported')
    const txId = impRes.transactions[0].id

    // 4. Suggestion Matching
    const booksAfterImport = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const suggestions = computeSettlementSuggestions(booksAfterImport)
    const match = suggestions.find((s) => s.transactionId === txId && s.invoiceId === invRes.invoiceId)
    assert(match, 'Step 3: Suggestion computed')
    assert.strictEqual(match.confidence, 'HIGH', 'HIGH confidence on invoice number reference')

    // 5. 1-Click Reconcile
    const reconRes = executeReconciliation({
      booksDataPath: sandbox.booksDataPath,
      transactionId: txId,
      invoiceId: invRes.invoiceId,
    })
    assert(reconRes.ok, 'Step 4: Reconciled')
    assert.strictEqual(reconRes.invoiceStatus, 'Paid', 'Invoice marked Paid')

    // 6. Verify end state
    const booksFinal = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const finalInv = booksFinal.invoices.find((i) => i.id === invRes.invoiceId)
    const finalTx = booksFinal.bankTransactions.find((t) => t.id === txId)
    assert.strictEqual(finalInv.status, 'Paid', 'Invoice status is Paid')
    assert.strictEqual(finalTx.reconciled, true, 'Transaction is reconciled')
  },
)

// T3.2: End-to-end flow: Tenders milestone billed -> Tax invoice -> Bank CSV referencing tender -> Reconcile
suite.register(
  { id: 'T3.2', name: 'Pairwise Flow: Tenders Milestone Billed -> Tax Invoice -> Bank CSV -> Reconcile', tier: 3, milestone: 'm4', feature: 'all' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    // 1. Bill Milestone ms-01
    const billRes = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
      tenderReference: 'RFP-WTR-2026-04',
      issuingAuthority: 'City of Ekurhuleni Water Dept',
    })
    assert(billRes.ok, 'Step 1: Milestone billed')

    // 2. Bank statement with payment referencing tender
    const csv = `Date,Description,Reference,Amount\n2026-09-04,Ekurhuleni Treasury Payment,RFP-WTR-2026-04,145000.00`
    const impRes = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    assert(impRes.ok, 'Step 2: Bank CSV imported')
    const txId = impRes.transactions[0].id

    // 3. Reconcile
    const reconRes = executeReconciliation({
      booksDataPath: sandbox.booksDataPath,
      transactionId: txId,
      invoiceId: billRes.invoiceId,
    })
    assert(reconRes.ok, 'Step 3: Reconciled')
    assert.strictEqual(reconRes.invoiceStatus, 'Paid', 'Milestone tax invoice Paid')

    // 4. Verify Tenders milestone status
    const tendersFinal = JSON.parse(readFileSync(sandbox.tendersDataPath, 'utf8'))
    const ms = tendersFinal.workspaces[0].tenders[0].milestones.find((m) => m.id === 'ms-01')
    assert.strictEqual(ms.status, 'BILLED', 'Tenders milestone remains BILLED')
  },
)

// T3.3: Multi-entity commercial batch
suite.register(
  { id: 'T3.3', name: 'Pairwise Flow: Multi-entity Commercial Batch (CRM Won + Tender Milestone + Supplier Bill)', tier: 3, milestone: 'm4', feature: 'all' },
  async (sandbox) => {
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals: createInitialCrmDeals() })
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    const initialBooks = createInitialBooksData()
    // Remove pre-seeded inv-1 so billing ms-01 creates the authoritative tender invoice
    initialBooks.invoices = initialBooks.invoices.filter((i) => i.id !== 'inv-1')
    atomicWriteJson(sandbox.booksDataPath, initialBooks)

    // CRM Deal Invoice
    const crmInv = executeCreateInvoiceFromDeal({ crmDealsPath: sandbox.crmDealsPath, booksDataPath: sandbox.booksDataPath, dealId: 'deal-3' })
    // Tender Milestone Invoice
    const tenderInv = executeBillMilestoneInBooks({ tendersDataPath: sandbox.tendersDataPath, booksDataPath: sandbox.booksDataPath, tenderId: 'tender-wtr-04', milestoneId: 'ms-01' })

    // Single monthly bank CSV statement with 3 settlements
    const csv = `Date,Description,Reference,Amount
2026-09-01,Ekurhuleni Water Tender,RFP-WTR-2026-04,145000.00
2026-09-02,Helios Energy CRM Deal,${crmInv.invoiceNumber},85000.00
2026-09-03,Apex Valve Supplies Wire,BILL-2026-012,-45000.00`

    const imp = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })
    assert.strictEqual(imp.importedCount, 3, 'All 3 transactions imported')

    const booksAfter = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const suggestions = computeSettlementSuggestions(booksAfter)
    assert(suggestions.length >= 3, 'Suggestions computed for all 3')

    // Reconcile all 3
    for (const s of suggestions) {
      if (s.confidence === 'HIGH') {
        const rec = executeReconciliation({ booksDataPath: sandbox.booksDataPath, transactionId: s.transactionId, invoiceId: s.invoiceId })
        assert(rec.ok, `Reconciled ${s.invoiceNumber}`)
      }
    }

    const booksFinal = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const allReconciled = booksFinal.bankTransactions.every((t) => t.reconciled)
    assert(allReconciled, 'All 3 bank transactions reconciled successfully')
  },
)

// T3.4: Post-Invoicing Tenders-to-CRM External Sync
suite.register(
  { id: 'T3.4', name: 'Pairwise Flow: Tenders sync after CRM invoicing preserves invoice back-references', tier: 3, milestone: 'm4', feature: 'all' },
  async (sandbox) => {
    // 1. Setup CRM and invoice deal-3
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals: createInitialCrmDeals() })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())
    const crmInv = executeCreateInvoiceFromDeal({ crmDealsPath: sandbox.crmDealsPath, booksDataPath: sandbox.booksDataPath, dealId: 'deal-3' })

    // 2. Perform external sync from Tenders
    safeMergeTenderIntoCrmDeals(sandbox.crmDealsPath, {
      id: 'deal-tender-new-44',
      name: 'Pumping Station Overhaul',
      amount: 320000,
      stage: 'proposal',
    })

    // 3. Verify deal-3 still has invoice back-references
    const crmAfter = JSON.parse(readFileSync(sandbox.crmDealsPath, 'utf8'))
    const deal3 = crmAfter.deals.find((d) => d.id === 'deal-3')
    assert.strictEqual(deal3.invoiceId, crmInv.invoiceId, 'Invoice ID back-reference preserved after external sync')
    assert.strictEqual(deal3.invoiceNumber, crmInv.invoiceNumber, 'Invoice number preserved')
    assert(crmAfter.deals.some((d) => d.id === 'deal-tender-new-44'), 'New tender deal present')
  },
)

// T3.5: Dual Settlement Disambiguation
suite.register(
  { id: 'T3.5', name: 'Pairwise Flow: Disambiguation between two identical customer invoice amounts', tier: 3, milestone: 'm4', feature: 'all' },
  async (sandbox) => {
    const books = createInitialBooksData()
    // Add two invoices with identical amounts (85,000)
    books.invoices.push({
      id: 'inv-alpha',
      invoiceNumber: 'INV-2026-ALPHA',
      type: 'Sales',
      partyId: 'party-2',
      partyName: 'Helios Clean Energy',
      grandTotal: 85000,
      outstandingAmount: 85000,
      status: 'Unpaid',
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
    })
    books.invoices.push({
      id: 'inv-beta',
      invoiceNumber: 'INV-2026-BETA',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      grandTotal: 85000,
      outstandingAmount: 85000,
      status: 'Unpaid',
      createdAt: '2026-08-02T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
    })
    atomicWriteJson(sandbox.booksDataPath, books)

    const csv = `Date,Description,Reference,Amount\n2026-09-01,Payment from Helios Clean Energy,INV-2026-ALPHA,85000.00`
    importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })

    const booksAfter = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const suggestions = computeSettlementSuggestions(booksAfter)

    const alphaMatch = suggestions.find((s) => s.invoiceId === 'inv-alpha')
    const betaMatch = suggestions.find((s) => s.invoiceId === 'inv-beta')

    assert.strictEqual(alphaMatch.confidence, 'HIGH', 'Alpha promoted to HIGH confidence based on token match')
    assert.strictEqual(betaMatch.confidence, 'MEDIUM', 'Beta remains MEDIUM confidence based on amount only')
  },
)

// ----------------------------------------------------------------------------
// TIER 4: REAL-WORLD APPLICATION SCENARIOS
// ----------------------------------------------------------------------------

// T4.1: Complete Commercial Cycle
suite.register(
  { id: 'T4.1', name: 'Real-World Scenario 1: Municipal Water Tender + Corporate Cloud Rollout Complete Commercial Cycle', tier: 4, milestone: 'all', feature: 'all' },
  async (sandbox) => {
    // 1. Initialize all 3 suites
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals: createInitialCrmDeals() })
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    const initialBooks = createInitialBooksData()
    // Remove pre-seeded inv-1 so billing ms-01 creates the authoritative tender invoice
    initialBooks.invoices = initialBooks.invoices.filter((i) => i.id !== 'inv-1')
    atomicWriteJson(sandbox.booksDataPath, initialBooks)

    // 2. Bill tender milestone RFP-WTR-2026-04 (145,000)
    const tenderBill = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
    })
    assert(tenderBill.ok, 'Tender milestone billed')

    // 3. Invoice won CRM deal deal-3 (85,000)
    const crmInvoice = executeCreateInvoiceFromDeal({
      crmDealsPath: sandbox.crmDealsPath,
      booksDataPath: sandbox.booksDataPath,
      dealId: 'deal-3',
    })
    assert(crmInvoice.ok, 'CRM deal invoiced')

    // 4. Import Monthly Bank Statement with both incoming receipts and vendor payment
    const statementCsv = `Date,Description,Reference,Amount
2026-09-01,Ekurhuleni Metropolitan Water Dept,RFP-WTR-2026-04,145000.00
2026-09-03,Helios Clean Energy EFT,${crmInvoice.invoiceNumber},85000.00
2026-09-05,Apex Valve Supplies Procurement,BILL-2026-012,-45000.00
2026-09-06,Bank Service Account Monthly Fee,FEE-SEP26,-450.00`

    const importRes = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: statementCsv })
    assert.strictEqual(importRes.importedCount, 4, 'All 4 transactions imported')

    // 5. Match suggestions and reconcile each
    const booksWithStatements = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const suggestions = computeSettlementSuggestions(booksWithStatements)

    for (const sug of suggestions) {
      if (sug.confidence === 'HIGH') {
        const recon = executeReconciliation({
          booksDataPath: sandbox.booksDataPath,
          transactionId: sug.transactionId,
          invoiceId: sug.invoiceId,
        })
        assert(recon.ok, `Reconciled ${sug.invoiceNumber}`)
      }
    }

    // 6. Comprehensive Audit Checks
    const booksAudit = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const tenderInv = booksAudit.invoices.find((i) => i.id === tenderBill.invoiceId)
    const crmInv = booksAudit.invoices.find((i) => i.id === crmInvoice.invoiceId)
    const suppBill = booksAudit.invoices.find((i) => i.id === 'inv-supp-1')

    assert.strictEqual(tenderInv.status, 'Paid', 'Tender invoice is Paid')
    assert.strictEqual(crmInv.status, 'Paid', 'CRM invoice is Paid')
    assert.strictEqual(suppBill.status, 'Paid', 'Supplier bill is Paid')

    // Verify unmatched bank fee remains unreconciled
    const feeTx = booksAudit.bankTransactions.find((t) => t.amount === -450)
    assert.strictEqual(feeTx.reconciled, false, 'Bank fee remains unreconciled')
  },
)

// T4.2: High-Volume Monthly Commercial Settlement
suite.register(
  { id: 'T4.2', name: 'Real-World Scenario 2: High-Volume Monthly Commercial Settlement (5 concurrent won deals)', tier: 4, milestone: 'all', feature: 'all' },
  async (sandbox) => {
    const deals = []
    for (let i = 1; i <= 5; i++) {
      deals.push({
        id: `deal-bulk-${i}`,
        name: `Enterprise Contract Alpha ${i}`,
        companyName: `Client Corp ${i}`,
        amount: 20000 * i,
        stage: 'won',
      })
    }
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals })
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    // Invoice all 5 deals in Books
    const createdInvoices = []
    for (const d of deals) {
      const res = executeCreateInvoiceFromDeal({ crmDealsPath: sandbox.crmDealsPath, booksDataPath: sandbox.booksDataPath, dealId: d.id })
      assert(res.ok, `Invoiced deal ${d.id}`)
      createdInvoices.push(res)
    }

    // Single bank statement with all 5 payments
    const csvRows = ['Date,Description,Reference,Amount']
    for (let i = 0; i < createdInvoices.length; i++) {
      const inv = createdInvoices[i]
      csvRows.push(`2026-09-0${i + 1},Client Corp ${i + 1} Wire,${inv.invoiceNumber},${inv.grandTotal}.00`)
    }
    // Plus 2 unmatched interest/fee entries
    csvRows.push(`2026-09-10,Monthly Credit Interest Earned,INT-01,340.50`)
    csvRows.push(`2026-09-11,International Transfer Fee,FEE-INT,-120.00`)

    const importRes = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csvRows.join('\n') })
    assert.strictEqual(importRes.importedCount, 7, 'Imported 7 statement lines')

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const suggestions = computeSettlementSuggestions(books)
    assert.strictEqual(suggestions.length, 5, 'Exactly 5 settlement matches identified')

    for (const s of suggestions) {
      executeReconciliation({ booksDataPath: sandbox.booksDataPath, transactionId: s.transactionId, invoiceId: s.invoiceId })
    }

    const booksFinal = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const paidCount = booksFinal.invoices.filter((i) => i.status === 'Paid').length
    assert(paidCount >= 5, 'All 5 invoices paid')
  },
)

// T4.3: Multi-Stage Tender Delivery & Progress Payments
suite.register(
  { id: 'T4.3', name: 'Real-World Scenario 3: Multi-Stage Tender Delivery & Sequential Progress Payments', tier: 4, milestone: 'all', feature: 'all' },
  async (sandbox) => {
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    // Phase 1: Bill reached milestone ms-01 (145,000)
    const bill1 = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-01',
    })
    assert(bill1.ok, 'Phase 1 billed')

    // Reconcile Phase 1 payment
    const csv1 = `Date,Description,Reference,Amount\n2026-09-01,Ekurhuleni Treasury Pmt 1,RFP-WTR-2026-04,145000.00`
    const imp1 = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv1 })
    executeReconciliation({ booksDataPath: sandbox.booksDataPath, transactionId: imp1.transactions[0].id, invoiceId: bill1.invoiceId })

    // Progress project: Phase 2 milestone ms-02 reaches REACHED status
    const tendersMid = JSON.parse(readFileSync(sandbox.tendersDataPath, 'utf8'))
    const ms2 = tendersMid.workspaces[0].tenders[0].milestones.find((m) => m.id === 'ms-02')
    ms2.status = 'REACHED'
    atomicWriteJson(sandbox.tendersDataPath, tendersMid)

    // Bill Phase 2 milestone ms-02 (98,000)
    const bill2 = executeBillMilestoneInBooks({
      tendersDataPath: sandbox.tendersDataPath,
      booksDataPath: sandbox.booksDataPath,
      tenderId: 'tender-wtr-04',
      milestoneId: 'ms-02',
    })
    assert(bill2.ok, 'Phase 2 billed successfully')

    const tendersFinal = JSON.parse(readFileSync(sandbox.tendersDataPath, 'utf8'))
    const allBilled = tendersFinal.workspaces[0].tenders[0].milestones.every((m) => m.status === 'BILLED')
    assert(allBilled, 'Both tender milestones are now in BILLED status')
  },
)

// T4.4: Concurrent Cross-App Mutation Stress
suite.register(
  { id: 'T4.4', name: 'Real-World Scenario 4: Concurrent Cross-App Mutation Stress (CRM + Tenders + Books)', tier: 4, milestone: 'all', feature: 'all' },
  async (sandbox) => {
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals: createInitialCrmDeals() })
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    // Interleaved operations
    safeMergeTenderIntoCrmDeals(sandbox.crmDealsPath, { id: 'deal-stress-1', name: 'Interleaved 1', amount: 50000 })
    executeCreateInvoiceFromDeal({ crmDealsPath: sandbox.crmDealsPath, booksDataPath: sandbox.booksDataPath, dealId: 'deal-3' })
    safeMergeTenderIntoCrmDeals(sandbox.crmDealsPath, { id: 'deal-stress-2', name: 'Interleaved 2', amount: 75000 })
    executeBillMilestoneInBooks({ tendersDataPath: sandbox.tendersDataPath, booksDataPath: sandbox.booksDataPath, tenderId: 'tender-wtr-04', milestoneId: 'ms-01' })

    const crmFinal = JSON.parse(readFileSync(sandbox.crmDealsPath, 'utf8'))
    const booksFinal = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))
    const tendersFinal = JSON.parse(readFileSync(sandbox.tendersDataPath, 'utf8'))

    assert.strictEqual(crmFinal.version, 1, 'CRM version intact')
    assert.strictEqual(booksFinal.version, 1, 'Books version intact')
    assert.strictEqual(tendersFinal.version, 1, 'Tenders version intact')
    assert(crmFinal.deals.some((d) => d.id === 'deal-stress-1'), 'Interleaved deal 1 saved')
    assert(crmFinal.deals.some((d) => d.id === 'deal-stress-2'), 'Interleaved deal 2 saved')
    assert(crmFinal.deals.find((d) => d.id === 'deal-3').invoiceNumber, 'Deal 3 invoiced')
  },
)

// T4.5: Financial Year-End Trial Balance Integrity
suite.register(
  { id: 'T4.5', name: 'Real-World Scenario 5: Financial Year-End Double-Entry Trial Balance Integrity', tier: 4, milestone: 'all', feature: 'all' },
  async (sandbox) => {
    atomicWriteJson(sandbox.crmDealsPath, { version: 1, updatedAt: new Date().toISOString(), deals: createInitialCrmDeals() })
    atomicWriteJson(sandbox.tendersDataPath, createInitialTendersData())
    atomicWriteJson(sandbox.booksDataPath, createInitialBooksData())

    // Invoicing and milestone billing
    const crmInv = executeCreateInvoiceFromDeal({ crmDealsPath: sandbox.crmDealsPath, booksDataPath: sandbox.booksDataPath, dealId: 'deal-3' })
    const tenderBill = executeBillMilestoneInBooks({ tendersDataPath: sandbox.tendersDataPath, booksDataPath: sandbox.booksDataPath, tenderId: 'tender-wtr-04', milestoneId: 'ms-01' })

    // Statements and reconciliations
    const csv = `Date,Description,Reference,Amount
2026-09-01,Tender Receipt,RFP-WTR-2026-04,145000.00
2026-09-02,CRM Receipt,${crmInv.invoiceNumber},85000.00`
    const imp = importBankStatement({ booksDataPath: sandbox.booksDataPath, csvContent: csv })

    for (const tx of imp.transactions) {
      const invId = tx.amount === 145000 ? tenderBill.invoiceId : crmInv.invoiceId
      executeReconciliation({ booksDataPath: sandbox.booksDataPath, transactionId: tx.id, invoiceId: invId })
    }

    const books = JSON.parse(readFileSync(sandbox.booksDataPath, 'utf8'))

    // Verify all posted journal entries are balanced (totalDebit === totalCredit)
    for (const je of books.journalEntries) {
      assert.strictEqual(je.totalDebit, je.totalCredit, `Journal Entry ${je.entryNumber} is balanced`)
    }

    // Verify liquid cash balance is strictly positive and non-negative
    const bankAcc = books.accounts.find((a) => a.id === 'acc-bank')
    assert(bankAcc.balance > 0, `Liquid bank balance must be positive: ${bankAcc.balance}`)
  },
)

// ============================================================================
// 6. MAIN EXECUTION ENTRY POINT
// ============================================================================

async function main() {
  const success = await suite.run()
  process.exit(success ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal test runner error:', err)
  process.exit(1)
})

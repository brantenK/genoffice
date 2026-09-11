#!/usr/bin/env node
/**
 * tools/test-challenger-m1-empirical.mjs
 *
 * Empirical Challenge Harness for Milestone 1:
 * - Books store migration & envelope structure
 * - Preservation of existing balances on core accounts (acc-bank, acc-ar, acc-ap, acc-sales, acc-vat)
 * - Corrupted JSON backup & graceful degradation (.corrupted.bak)
 * - Atomic write safety & disk resilience (tmp file + renameSync)
 * - Custom / unknown attributes preservation across store round-trips
 * - Cross-store external sync merge resilience (Tenders -> CRM deals)
 * - Edge cases: malformed types, duplicate IDs, boundary numbers, circular refs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import assert from 'node:assert'

const require = createRequire(import.meta.url)
const booksModule = require('../apps/books/out/main/index.js')
const crmModule = require('../apps/crm/out/main/index.js')
const tendersModule = require('../apps/tenders/out/main/index.js')

const {
  CURRENT_BOOKS_SCHEMA_VERSION,
  DEFAULT_BOOK_SETTINGS,
  CORE_ACCOUNTS,
  migrateAndValidateBooks,
  readBooksStore,
  writeBooksStore,
} = booksModule

const {
  CURRENT_DEALS_SCHEMA_VERSION,
  sanitizeDeal,
  migrateAndValidateDeals,
  readDealsStore,
  writeDealsStore,
} = crmModule

const {
  CURRENT_TENDERS_SCHEMA_VERSION,
  migrateAndValidateTenders,
  readTendersStore,
  writeTendersStore,
} = tendersModule

// Test runner infrastructure
let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  [PASS] ${name}`)
  } catch (err) {
    failed++
    failures.push({ name, error: err.message, stack: err.stack })
    console.error(`  [FAIL] ${name}: ${err.message}`)
  }
}

// Sandbox isolation
function createSandbox() {
  const sandboxDir = join(tmpdir(), `challenger2-m1-${randomUUID().slice(0, 8)}`)
  mkdirSync(sandboxDir, { recursive: true })
  return {
    dir: sandboxDir,
    booksPath: join(sandboxDir, 'books', 'books-data.json'),
    crmPath: join(sandboxDir, 'crm', 'deals.json'),
    tendersPath: join(sandboxDir, 'tenders', 'tenders-data.json'),
    cleanup() {
      try {
        rmSync(sandboxDir, { recursive: true, force: true })
      } catch {}
    },
  }
}

console.log('======================================================================')
console.log('   CHALLENGER 2: EMPIRICAL BOOKS & CROSS-STORE DATA RESILIENCE HARNESS')
console.log('======================================================================\n')

// ============================================================================
// SECTION 1: BOOKS-DATA.JSON MIGRATION FROM UNVERSIONED OBJECT TO V1 ENVELOPE
// ============================================================================
console.log('--- Section 1: Books Migration & Envelope Integrity ---')

test('1.1 Unversioned legacy object is upgraded to v1 envelope with valid updatedAt', () => {
  const legacyData = {
    settings: {
      companyName: 'Legacy Consulting Ltd',
      currency: 'ZAR',
    },
    accounts: [
      { id: 'acc-bank', name: 'Legacy Bank', balance: 350000 },
    ],
    parties: [
      { id: 'party-1', name: 'Legacy Client', outstandingBalance: 15000 },
    ],
    invoices: [
      { id: 'inv-1', invoiceNumber: 'INV-2025-001', grandTotal: 23000, status: 'Unpaid' },
    ],
    journalEntries: [
      { id: 'je-1', entryNumber: 'JE-2025-001', totalDebit: 23000, totalCredit: 23000 },
    ],
  }

  const migrated = migrateAndValidateBooks(legacyData)
  assert.strictEqual(migrated.version, 1, 'Version must be upgraded to 1')
  assert(typeof migrated.updatedAt === 'string' && !isNaN(Date.parse(migrated.updatedAt)), 'updatedAt must be a valid ISO string')
  assert.strictEqual(migrated.settings.companyName, 'Legacy Consulting Ltd', 'Existing settings preserved')
  assert.strictEqual(migrated.settings.taxNumber, DEFAULT_BOOK_SETTINGS.taxNumber, 'Missing settings filled from defaults')
  assert.strictEqual(migrated.parties.length, 1, 'Parties preserved')
  assert.strictEqual(migrated.invoices.length, 1, 'Invoices preserved')
  assert.strictEqual(migrated.journalEntries.length, 1, 'Journal entries preserved')
})

test('1.2 Empty object {} returns valid default v1 envelope with core accounts', () => {
  const migrated = migrateAndValidateBooks({})
  assert.strictEqual(migrated.version, 1, 'Version must be 1')
  assert(migrated.updatedAt, 'updatedAt must be present')
  assert.strictEqual(migrated.settings.companyName, DEFAULT_BOOK_SETTINGS.companyName)
  assert.strictEqual(migrated.accounts.length, CORE_ACCOUNTS.length, 'Must have all 5 core accounts')
  assert.deepStrictEqual(migrated.parties, [])
  assert.deepStrictEqual(migrated.invoices, [])
  assert.deepStrictEqual(migrated.journalEntries, [])
})

test('1.3 Non-object primitives (null, undefined, string, number, array) return safe defaults without throwing', () => {
  const inputs = [null, undefined, 'malformed', 12345, true, [1, 2, 3]]
  for (const input of inputs) {
    const migrated = migrateAndValidateBooks(input)
    assert.strictEqual(migrated.version, 1, `Failed for input: ${typeof input}`)
    assert(migrated.accounts.length >= 5, 'Core accounts populated')
  }
})

test('1.4 Existing v1 envelope preserves original version and updatedAt timestamp', () => {
  const existingTimestamp = '2026-01-15T08:30:00.000Z'
  const envelope = {
    version: 1,
    updatedAt: existingTimestamp,
    settings: { ...DEFAULT_BOOK_SETTINGS },
    accounts: [...CORE_ACCOUNTS],
    parties: [],
    invoices: [],
    journalEntries: [],
  }

  const result = migrateAndValidateBooks(envelope)
  assert.strictEqual(result.version, 1)
  assert.strictEqual(result.updatedAt, existingTimestamp, 'Original updatedAt must be preserved')
})

test('1.5 Future version envelope (version: 2) preserves version number >= 1', () => {
  const future = {
    version: 2,
    updatedAt: '2026-06-01T12:00:00.000Z',
    accounts: [],
  }
  const result = migrateAndValidateBooks(future)
  assert.strictEqual(result.version, 2, 'Future version 2 should not be downgraded')
})

test('1.6 Partial settings merges custom fields while retaining default configuration', () => {
  const partial = {
    settings: {
      companyName: 'Acme Mega Corp',
      address: '99 Innovation Blvd',
    },
  }
  const result = migrateAndValidateBooks(partial)
  assert.strictEqual(result.settings.companyName, 'Acme Mega Corp')
  assert.strictEqual(result.settings.address, '99 Innovation Blvd')
  assert.strictEqual(result.settings.currency, 'ZAR', 'Retains default currency')
  assert.strictEqual(result.settings.taxNumber, '4920198273', 'Retains default tax number')
})

test('1.7 readBooksStore on non-existent file returns valid default v1 envelope without error', () => {
  const sb = createSandbox()
  try {
    const loaded = readBooksStore(sb.booksPath)
    assert.strictEqual(loaded.version, 1)
    assert.strictEqual(loaded.accounts.length, CORE_ACCOUNTS.length)
    assert.strictEqual(loaded.invoices.length, 0)
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SECTION 2: EXISTING BALANCES ON CORE ACCOUNTS ARE NEVER OVERWRITTEN
// ============================================================================
console.log('\n--- Section 2: Core Account Balances Preservation ---')

test('2.1 Custom non-default positive balances on all core accounts are strictly preserved', () => {
  const customAccounts = [
    { id: 'acc-bank', name: 'Custom FNB', balance: 9999999.99, rootType: 'Asset', accountType: 'Bank' },
    { id: 'acc-ar', name: 'Custom AR', balance: 111111.11, rootType: 'Asset', accountType: 'Receivable' },
    { id: 'acc-ap', name: 'Custom AP', balance: 222222.22, rootType: 'Liability', accountType: 'Payable' },
    { id: 'acc-sales', name: 'Custom Sales', balance: 888888.88, rootType: 'Income', accountType: 'Direct Income' },
    { id: 'acc-vat', name: 'Custom VAT', balance: 333333.33, rootType: 'Liability', accountType: 'Tax' },
  ]

  const migrated = migrateAndValidateBooks({ accounts: customAccounts })
  
  const bank = migrated.accounts.find((a) => a.id === 'acc-bank')
  const ar = migrated.accounts.find((a) => a.id === 'acc-ar')
  const ap = migrated.accounts.find((a) => a.id === 'acc-ap')
  const sales = migrated.accounts.find((a) => a.id === 'acc-sales')
  const vat = migrated.accounts.find((a) => a.id === 'acc-vat')

  assert.strictEqual(bank.balance, 9999999.99, 'acc-bank custom balance must not be overwritten')
  assert.strictEqual(ar.balance, 111111.11, 'acc-ar custom balance must not be overwritten')
  assert.strictEqual(ap.balance, 222222.22, 'acc-ap custom balance must not be overwritten')
  assert.strictEqual(sales.balance, 888888.88, 'acc-sales custom balance must not be overwritten')
  assert.strictEqual(vat.balance, 333333.33, 'acc-vat custom balance must not be overwritten')
})

test('2.2 Zero balances (0) on all core accounts are NEVER overwritten by truthy default checks', () => {
  // CRITICAL EDGE CASE: If code uses `acc.balance || default`, 0 would be overwritten with default!
  const zeroAccounts = [
    { id: 'acc-bank', balance: 0 },
    { id: 'acc-ar', balance: 0 },
    { id: 'acc-ap', balance: 0 },
    { id: 'acc-sales', balance: 0 },
    { id: 'acc-vat', balance: 0 },
  ]

  const migrated = migrateAndValidateBooks({ accounts: zeroAccounts })

  for (const id of ['acc-bank', 'acc-ar', 'acc-ap', 'acc-sales', 'acc-vat']) {
    const acc = migrated.accounts.find((a) => a.id === id)
    assert.strictEqual(acc.balance, 0, `Core account ${id} with 0 balance was overwritten! Got: ${acc.balance}`)
  }
})

test('2.3 Negative balances (overdraft / tax refund due) are preserved without truncation or reset', () => {
  const negativeAccounts = [
    { id: 'acc-bank', balance: -75000.50 }, // Overdraft
    { id: 'acc-vat', balance: -12500.00 },  // VAT refund receivable
  ]

  const migrated = migrateAndValidateBooks({ accounts: negativeAccounts })
  const bank = migrated.accounts.find((a) => a.id === 'acc-bank')
  const vat = migrated.accounts.find((a) => a.id === 'acc-vat')

  assert.strictEqual(bank.balance, -75000.50, 'Negative bank balance (overdraft) must survive')
  assert.strictEqual(vat.balance, -12500.00, 'Negative VAT balance must survive')
})

test('2.4 Partial core accounts: existing retain custom balance, missing accounts are injected with defaults', () => {
  const partialAccounts = [
    { id: 'acc-bank', balance: 42 },
    { id: 'acc-sales', balance: 100 },
  ]

  const migrated = migrateAndValidateBooks({ accounts: partialAccounts })
  const bank = migrated.accounts.find((a) => a.id === 'acc-bank')
  const sales = migrated.accounts.find((a) => a.id === 'acc-sales')
  const ar = migrated.accounts.find((a) => a.id === 'acc-ar')
  const ap = migrated.accounts.find((a) => a.id === 'acc-ap')
  const vat = migrated.accounts.find((a) => a.id === 'acc-vat')

  assert.strictEqual(bank.balance, 42, 'Existing acc-bank retains 42')
  assert.strictEqual(sales.balance, 100, 'Existing acc-sales retains 100')
  assert.strictEqual(ar.balance, 195500, 'Missing acc-ar receives default')
  assert.strictEqual(ap.balance, 74200, 'Missing acc-ap receives default')
  assert.strictEqual(vat.balance, 38400, 'Missing acc-vat receives default')
})

test('2.5 Custom non-core accounts (payroll, director loan, investments) survive along with core accounts', () => {
  const mixedAccounts = [
    { id: 'acc-bank', balance: 50000 },
    { id: 'acc-custom-payroll', name: 'Salaries & Wages', balance: 120000, rootType: 'Expense', accountType: 'Direct Expense' },
    { id: 'acc-custom-investments', name: 'Treasury Bills', balance: 450000, rootType: 'Asset', accountType: 'Current Asset' },
  ]

  const migrated = migrateAndValidateBooks({ accounts: mixedAccounts })
  const payroll = migrated.accounts.find((a) => a.id === 'acc-custom-payroll')
  const inv = migrated.accounts.find((a) => a.id === 'acc-custom-investments')
  const bank = migrated.accounts.find((a) => a.id === 'acc-bank')

  assert(payroll, 'Custom payroll account preserved')
  assert.strictEqual(payroll.balance, 120000)
  assert(inv, 'Custom investments account preserved')
  assert.strictEqual(inv.balance, 450000)
  assert.strictEqual(bank.balance, 50000)
  // All 5 core accounts must still be present in the final list
  for (const core of CORE_ACCOUNTS) {
    assert(migrated.accounts.some((a) => a.id === core.id), `Core account ${core.id} must exist`)
  }
})

// ============================================================================
// SECTION 3: CORRUPTED JSON HANDLING & .corrupted.bak BACKUP
// ============================================================================
console.log('\n--- Section 3: Corrupted JSON Handling & Forensics ---')

test('3.1 Corrupted JSON with syntax error creates .corrupted.bak and returns safe fallback', () => {
  const sb = createSandbox()
  try {
    const corruptContent = '{"version": 1, "accounts": [{"id": "acc-bank", "balance": 485250}, UNFINISHED_SYNTAX...'
    mkdirSync(join(sb.dir, 'books'), { recursive: true })
    writeFileSync(sb.booksPath, corruptContent, 'utf8')

    const loaded = readBooksStore(sb.booksPath)
    assert.strictEqual(loaded.version, 1, 'Should return safe v1 envelope')
    assert.strictEqual(loaded.accounts.length, CORE_ACCOUNTS.length, 'Should return default core accounts')

    const bakPath = `${sb.booksPath}.corrupted.bak`
    assert(existsSync(bakPath), '.corrupted.bak backup file must exist')
    const bakContent = readFileSync(bakPath, 'utf8')
    assert.strictEqual(bakContent, corruptContent, 'Backup content must exactly match original corrupt content')
  } finally {
    sb.cleanup()
  }
})

test('3.2 Zero-byte empty file triggers .corrupted.bak and returns safe fallback', () => {
  const sb = createSandbox()
  try {
    mkdirSync(join(sb.dir, 'books'), { recursive: true })
    writeFileSync(sb.booksPath, '', 'utf8') // 0 bytes

    const loaded = readBooksStore(sb.booksPath)
    assert.strictEqual(loaded.version, 1)
    assert(loaded.accounts.length >= 5)

    const bakPath = `${sb.booksPath}.corrupted.bak`
    assert(existsSync(bakPath), '.corrupted.bak must be generated for empty file')
    const bakContent = readFileSync(bakPath, 'utf8')
    assert.strictEqual(bakContent, '', 'Backup should preserve 0-byte state')
  } finally {
    sb.cleanup()
  }
})

test('3.3 Subsequent writeBooksStore repairs file without destroying .corrupted.bak', () => {
  const sb = createSandbox()
  try {
    const corruptContent = 'INVALID_JSON_FOR_TESTING'
    mkdirSync(join(sb.dir, 'books'), { recursive: true })
    writeFileSync(sb.booksPath, corruptContent, 'utf8')

    // Read triggers backup
    readBooksStore(sb.booksPath)
    const bakPath = `${sb.booksPath}.corrupted.bak`
    assert(existsSync(bakPath), 'Backup created')

    // Now write clean data
    const cleanData = {
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: { ...DEFAULT_BOOK_SETTINGS, companyName: 'Repaired Company' },
      accounts: [{ id: 'acc-bank', balance: 777777 }],
      parties: [],
      invoices: [],
      journalEntries: [],
    }
    writeBooksStore(sb.booksPath, cleanData)

    // Verify booksPath is now clean valid JSON
    const reloaded = readBooksStore(sb.booksPath)
    assert.strictEqual(reloaded.settings.companyName, 'Repaired Company')
    assert.strictEqual(reloaded.accounts.find((a) => a.id === 'acc-bank').balance, 777777)

    // Verify .corrupted.bak remains intact on disk
    assert(existsSync(bakPath), '.corrupted.bak must NOT be overwritten or deleted by subsequent write')
    assert.strictEqual(readFileSync(bakPath, 'utf8'), corruptContent)
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SECTION 4: ATOMIC WRITE SAFETY (TMP FILE + RENAMESYNC)
// ============================================================================
console.log('\n--- Section 4: Atomic Write Safety ---')

test('4.1 writeBooksStore creates non-existent parent directory recursively', () => {
  const sb = createSandbox()
  try {
    const deepPath = join(sb.dir, 'a', 'deeply', 'nested', 'path', 'books-data.json')
    writeBooksStore(deepPath, { accounts: [{ id: 'acc-bank', balance: 12345 }] })
    assert(existsSync(deepPath), 'File written to deep directory')

    const data = JSON.parse(readFileSync(deepPath, 'utf8'))
    assert.strictEqual(data.version, 1)
  } finally {
    sb.cleanup()
  }
})

test('4.2 Atomic write mechanics: temporary file pattern verified and no leftover tmp files', () => {
  const sb = createSandbox()
  try {
    const dir = join(sb.dir, 'books')
    mkdirSync(dir, { recursive: true })

    writeBooksStore(sb.booksPath, { accounts: [{ id: 'acc-bank', balance: 88888 }] })
    assert(existsSync(sb.booksPath), 'Destination file exists')

    // Inspect directory for any lingering .tmp files
    const files = readdirSync(dir)
    const tmpFiles = files.filter((f) => f.includes('.tmp'))
    assert.strictEqual(tmpFiles.length, 0, `Found orphaned tmp files: ${tmpFiles.join(', ')}`)

    // Verify valid JSON content
    const content = readFileSync(sb.booksPath, 'utf8')
    assert.doesNotThrow(() => JSON.parse(content), 'Content must be valid JSON')
    assert(content.includes('\n  "version": 1'), 'File is formatted with indentation')
  } finally {
    sb.cleanup()
  }
})

test('4.3 Rapid sequential writes (50 iterations) execute atomically without data corruption', () => {
  const sb = createSandbox()
  try {
    for (let i = 1; i <= 50; i++) {
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        settings: { ...DEFAULT_BOOK_SETTINGS, companyName: `Write Cycle ${i}` },
        accounts: [{ id: 'acc-bank', balance: i * 1000 }],
        parties: [],
        invoices: [{ id: `inv-${i}`, invoiceNumber: `INV-${i}`, grandTotal: i * 50 }],
        journalEntries: [],
      }
      writeBooksStore(sb.booksPath, payload)
    }

    const finalData = readBooksStore(sb.booksPath)
    assert.strictEqual(finalData.settings.companyName, 'Write Cycle 50')
    assert.strictEqual(finalData.accounts.find((a) => a.id === 'acc-bank').balance, 50000)
    assert.strictEqual(finalData.invoices.length, 1)
    assert.strictEqual(finalData.invoices[0].id, 'inv-50')

    const dirFiles = readdirSync(join(sb.dir, 'books'))
    const orphaned = dirFiles.filter((f) => f.includes('.tmp'))
    assert.strictEqual(orphaned.length, 0, 'No orphaned tmp files after 50 writes')
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SECTION 5: CUSTOM OR UNKNOWN ATTRIBUTES IN STORES SURVIVE ROUND-TRIPS
// ============================================================================
console.log('\n--- Section 5: Custom / Unknown Attributes Round-Trip ---')

test('5.1 Books: Child entity custom attributes survive writeBooksStore -> readBooksStore', () => {
  const sb = createSandbox()
  try {
    const richBooksData = {
      version: 1,
      updatedAt: '2026-09-03T10:00:00.000Z',
      settings: {
        ...DEFAULT_BOOK_SETTINGS,
        customRegistrationNo: '2026/099999/07',
        customBranchCode: '051001',
        auditApproved: true,
      },
      accounts: [
        {
          id: 'acc-bank',
          name: 'Main Operating FNB',
          rootType: 'Asset',
          accountType: 'Bank',
          balance: 654321,
          customBranch: 'Sandton CBD',
          glAccountCode: '1000-01-FNB',
          fxCurrency: 'USD',
          tags: ['primary', 'operational', 'treasury'],
        },
      ],
      parties: [
        {
          id: 'party-special-1',
          name: 'Department of Water & Sanitation',
          type: 'Customer',
          outstandingBalance: 145000,
          customVendorNumber: 'V-99482',
          tenderEligible: true,
          internalRating: 'AAA',
        },
      ],
      invoices: [
        {
          id: 'inv-special-1',
          invoiceNumber: 'INV-2026-WTR-01',
          type: 'Sales',
          partyId: 'party-special-1',
          partyName: 'Department of Water & Sanitation',
          date: '2026-09-01',
          dueDate: '2026-10-01',
          items: [],
          subtotal: 126086.96,
          taxTotal: 18913.04,
          grandTotal: 145000,
          outstandingAmount: 145000,
          status: 'Unpaid',
          crmDealId: 'deal-tender-883',
          tenderReference: 'RFP-WTR-2026-04',
          customMilestoneRef: 'MILESTONE-PHASE-1',
          specialPaymentTerms: 'SARS Tax Clearance Required Before EFT',
        },
      ],
      journalEntries: [
        {
          id: 'je-special-1',
          entryNumber: 'JE-2026-099',
          date: '2026-09-01',
          items: [],
          totalDebit: 145000,
          totalCredit: 145000,
          posted: true,
          auditHash: 'sha256:4b227777d8892',
          approvedByUserId: 'usr-cfo-001',
        },
      ],
    }

    writeBooksStore(sb.booksPath, richBooksData)
    const reloaded = readBooksStore(sb.booksPath)

    // Verify Settings custom fields
    assert.strictEqual(reloaded.settings.customRegistrationNo, '2026/099999/07', 'Settings customRegistrationNo')
    assert.strictEqual(reloaded.settings.customBranchCode, '051001', 'Settings customBranchCode')
    assert.strictEqual(reloaded.settings.auditApproved, true, 'Settings auditApproved')

    // Verify Account custom fields
    const bank = reloaded.accounts.find((a) => a.id === 'acc-bank')
    assert.strictEqual(bank.customBranch, 'Sandton CBD', 'Account customBranch')
    assert.strictEqual(bank.glAccountCode, '1000-01-FNB', 'Account glAccountCode')
    assert.deepStrictEqual(bank.tags, ['primary', 'operational', 'treasury'], 'Account tags array')

    // Verify Party custom fields
    const party = reloaded.parties.find((p) => p.id === 'party-special-1')
    assert.strictEqual(party.customVendorNumber, 'V-99482', 'Party customVendorNumber')
    assert.strictEqual(party.tenderEligible, true, 'Party tenderEligible')
    assert.strictEqual(party.internalRating, 'AAA', 'Party internalRating')

    // Verify Invoice custom fields
    const invoice = reloaded.invoices.find((i) => i.id === 'inv-special-1')
    assert.strictEqual(invoice.crmDealId, 'deal-tender-883', 'Invoice crmDealId')
    assert.strictEqual(invoice.tenderReference, 'RFP-WTR-2026-04', 'Invoice tenderReference')
    assert.strictEqual(invoice.customMilestoneRef, 'MILESTONE-PHASE-1', 'Invoice customMilestoneRef')
    assert.strictEqual(invoice.specialPaymentTerms, 'SARS Tax Clearance Required Before EFT', 'Invoice specialPaymentTerms')

    // Verify JournalEntry custom fields
    const je = reloaded.journalEntries.find((j) => j.id === 'je-special-1')
    assert.strictEqual(je.auditHash, 'sha256:4b227777d8892', 'JournalEntry auditHash')
    assert.strictEqual(je.approvedByUserId, 'usr-cfo-001', 'JournalEntry approvedByUserId')
  } finally {
    sb.cleanup()
  }
})

test('5.2 CRM Deals: Custom / future attributes on deals survive writeDealsStore -> readDealsStore', () => {
  const sb = createSandbox()
  try {
    const dealsPayload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      deals: [
        {
          id: 'deal-forward-compat',
          name: 'Forward Compatible Enterprise Deal',
          amount: 750000,
          stage: 'won',
          probability: 100,
          invoiceId: 'inv-target-001',
          invoiceNumber: 'INV-2026-099',
          invoicedAt: '2026-09-03T12:00:00.000Z',
          customTaxTag: 'SECTION_12J',
          riskLevel: 'LOW',
          executiveSponsor: 'VP Technology',
          customFlags: { enterpriseTier: true, automatedBilling: true },
        },
      ],
    }

    writeDealsStore(sb.crmPath, dealsPayload)
    const reloaded = readDealsStore(sb.crmPath)

    assert.strictEqual(reloaded.version, 1)
    assert.strictEqual(reloaded.deals.length, 1)
    const deal = reloaded.deals[0]
    assert.strictEqual(deal.invoiceId, 'inv-target-001', 'invoiceId backref')
    assert.strictEqual(deal.invoiceNumber, 'INV-2026-099', 'invoiceNumber backref')
    assert.strictEqual(deal.invoicedAt, '2026-09-03T12:00:00.000Z', 'invoicedAt backref')
    assert.strictEqual(deal.customTaxTag, 'SECTION_12J', 'customTaxTag')
    assert.strictEqual(deal.riskLevel, 'LOW', 'riskLevel')
    assert.strictEqual(deal.executiveSponsor, 'VP Technology', 'executiveSponsor')
    assert.deepStrictEqual(deal.customFlags, { enterpriseTier: true, automatedBilling: true }, 'customFlags nested object')
  } finally {
    sb.cleanup()
  }
})

test('5.3 Tenders Store: Custom attributes on workspaces & issuerTemplates survive writeTendersStore -> readTendersStore', () => {
  const sb = createSandbox()
  try {
    const tendersPayload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      activeCompanyId: 'comp-za-001',
      workspaces: [
        {
          id: 'comp-za-001',
          companyName: 'Zano Tech Pty Ltd',
          registrationNumber: '2024/111111/07',
          customSector: 'Municipal Water Infrastructure',
          vaultIntegrityHash: 'hash-990011',
          tenders: [
            {
              id: 'tender-1',
              title: 'Reservoir Valve Refurbishment',
              referenceNumber: 'RFP-WTR-2026-04',
              issuingBody: 'City of Ekurhuleni',
              milestones: [
                {
                  id: 'ms-1',
                  title: 'Phase 1 Delivery',
                  amount: 145000,
                  status: 'BILLED',
                  billedInvoiceId: 'inv-books-999',
                  customApprovalRef: 'COUNCIL-RES-2026-04',
                },
              ],
            },
          ],
        },
      ],
      issuerTemplates: [
        {
          id: 'template-ekurhuleni',
          name: 'City of Ekurhuleni Standard',
          customEvaluationThreshold: 75,
        },
      ],
    }

    writeTendersStore(sb.tendersPath, tendersPayload)
    const reloaded = readTendersStore(sb.tendersPath)

    assert.strictEqual(reloaded.version, 1)
    assert.strictEqual(reloaded.activeCompanyId, 'comp-za-001')
    assert.strictEqual(reloaded.workspaces[0].customSector, 'Municipal Water Infrastructure')
    assert.strictEqual(reloaded.workspaces[0].vaultIntegrityHash, 'hash-990011')
    const ms = reloaded.workspaces[0].tenders[0].milestones[0]
    assert.strictEqual(ms.billedInvoiceId, 'inv-books-999')
    assert.strictEqual(ms.customApprovalRef, 'COUNCIL-RES-2026-04')
    assert.strictEqual(reloaded.issuerTemplates[0].customEvaluationThreshold, 75)
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SECTION 6: STRESS & ADVERSARIAL TESTING
// ============================================================================
console.log('\n--- Section 6: Stress & Adversarial Edge Cases ---')

test('6.1 Large dataset persistence: 1000 invoices and 500 accounts perform cleanly', () => {
  const sb = createSandbox()
  try {
    const accounts = []
    for (let i = 1; i <= 500; i++) {
      accounts.push({
        id: `acc-cust-${i}`,
        name: `Account #${i}`,
        rootType: i % 2 === 0 ? 'Asset' : 'Expense',
        accountType: 'Current Asset',
        balance: i * 15.5,
      })
    }
    // ensure 1 core account included in input
    accounts.push({ id: 'acc-bank', balance: 500000 })
    // Total accounts input = 501. Missing core accounts backfilled from CORE_ACCOUNTS.
    // Expected output accounts = 500 + CORE_ACCOUNTS.length accounts (530 accounts).

    const invoices = []
    for (let i = 1; i <= 1000; i++) {
      invoices.push({
        id: `inv-${i}`,
        invoiceNumber: `INV-2026-${String(i).padStart(4, '0')}`,
        type: 'Sales',
        partyId: `party-${i % 20}`,
        partyName: `Customer ${i % 20}`,
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [
          { id: `it-${i}-1`, itemCode: 'SRV', description: 'Consulting', qty: 2, rate: 500, taxRate: 15, amount: 1000 },
        ],
        subtotal: 1000,
        taxTotal: 150,
        grandTotal: 1150,
        outstandingAmount: 1150,
        status: 'Unpaid',
        crmDealId: `deal-${i}`,
      })
    }

    const largeEnvelope = {
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: { ...DEFAULT_BOOK_SETTINGS },
      accounts,
      parties: [],
      invoices,
      journalEntries: [],
    }

    const tStart = Date.now()
    writeBooksStore(sb.booksPath, largeEnvelope)
    const tWrite = Date.now() - tStart

    const tReadStart = Date.now()
    const loaded = readBooksStore(sb.booksPath)
    const tRead = Date.now() - tReadStart

    assert.strictEqual(loaded.accounts.length, 500 + CORE_ACCOUNTS.length, '500 custom accounts + core accounts backfilled')
    assert.strictEqual(loaded.invoices.length, 1000)
    assert.strictEqual(loaded.invoices[999].invoiceNumber, 'INV-2026-1000')
    assert.strictEqual(loaded.invoices[999].grandTotal, 1150)
    console.log(`    ℹ️ Large payload (1000 invoices, ${loaded.accounts.length} accounts): Write=${tWrite}ms, Read=${tRead}ms`)
  } finally {
    sb.cleanup()
  }
})

test('6.2 Unicode & special characters in party names, notes, and company settings survive round-trip', () => {
  const sb = createSandbox()
  try {
    const unicodeData = {
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: {
        ...DEFAULT_BOOK_SETTINGS,
        companyName: 'Zano & Associés (Pty) Ltd — 🇿🇦 «Tech» & Co.',
        address: '14 Königsallee, Überlingen / 1000 서울특별시 강남구',
      },
      accounts: [{ id: 'acc-bank', name: 'Standard Bank 🏦 Cheque', balance: 100000 }],
      parties: [
        { id: 'p-1', name: 'Société Générale (Côte d’Ivoire) & Müller GmbH', outstandingBalance: 50000 },
      ],
      invoices: [
        {
          id: 'inv-u1',
          invoiceNumber: 'INV-2026-ÖÄÜ-001',
          notes: 'Quotes: "double" \'single\' & Ampersand <tags> 日本語 한국어',
          grandTotal: 50000,
          status: 'Unpaid',
        },
      ],
      journalEntries: [],
    }

    writeBooksStore(sb.booksPath, unicodeData)
    const loaded = readBooksStore(sb.booksPath)

    assert.strictEqual(loaded.settings.companyName, 'Zano & Associés (Pty) Ltd — 🇿🇦 «Tech» & Co.')
    assert.strictEqual(loaded.settings.address, '14 Königsallee, Überlingen / 1000 서울특별시 강남구')
    assert.strictEqual(loaded.accounts.find((a) => a.id === 'acc-bank').name, 'Standard Bank 🏦 Cheque')
    assert.strictEqual(loaded.parties[0].name, 'Société Générale (Côte d’Ivoire) & Müller GmbH')
    assert.strictEqual(loaded.invoices[0].notes, 'Quotes: "double" \'single\' & Ampersand <tags> 日本語 한국어')
  } finally {
    sb.cleanup()
  }
})

test('6.3 Boundary numbers: extreme large numbers, fractional cents, and scientific notation', () => {
  const sb = createSandbox()
  try {
    const extremeData = {
      accounts: [
        { id: 'acc-bank', balance: 9007199254740991 }, // Number.MAX_SAFE_INTEGER
        { id: 'acc-ar', balance: 0.0000001 },
        { id: 'acc-ap', balance: -999999999999.99 },
        { id: 'acc-sales', balance: 1e10 },
        { id: 'acc-vat', balance: 0.00 },
      ],
    }

    writeBooksStore(sb.booksPath, extremeData)
    const loaded = readBooksStore(sb.booksPath)

    assert.strictEqual(loaded.accounts.find((a) => a.id === 'acc-bank').balance, 9007199254740991)
    assert.strictEqual(loaded.accounts.find((a) => a.id === 'acc-ar').balance, 0.0000001)
    assert.strictEqual(loaded.accounts.find((a) => a.id === 'acc-ap').balance, -999999999999.99)
    assert.strictEqual(loaded.accounts.find((a) => a.id === 'acc-sales').balance, 1e10)
    assert.strictEqual(loaded.accounts.find((a) => a.id === 'acc-vat').balance, 0)
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SECTION 7: CROSS-STORE MERGE & EXTERNAL SYNC RESILIENCE
// ============================================================================
console.log('\n--- Section 7: Cross-Store External Sync Merge Resilience ---')

test('7.1 CRM Deals: v0 naked array correctly migrates to v1 envelope on readDealsStore', () => {
  const sb = createSandbox()
  try {
    const v0Deals = [
      { id: 'deal-legacy-1', name: 'Legacy Deal 1', amount: 50000, stage: 'proposal' },
      { id: 'deal-legacy-2', name: 'Legacy Deal 2', amount: 120000, stage: 'won' },
    ]
    mkdirSync(join(sb.dir, 'crm'), { recursive: true })
    writeFileSync(sb.crmPath, JSON.stringify(v0Deals), 'utf8')

    const loaded = readDealsStore(sb.crmPath)
    assert.strictEqual(loaded.version, 1, 'Version upgraded to 1')
    assert.strictEqual(loaded.deals.length, 2, 'Both legacy deals preserved')
    assert.strictEqual(loaded.deals[0].id, 'deal-legacy-1')
    assert.strictEqual(loaded.deals[1].probability, 100, 'Won stage assigned 100% probability default')
  } finally {
    sb.cleanup()
  }
})

test('7.2 CRM Deals: Deal probability clamping (0-100) and negative amount protection', () => {
  const malformedDeal = sanitizeDeal({
    id: 'deal-clamp',
    name: 'Invalid Values Deal',
    amount: -50000,     // Negative should be normalized to 0
    probability: 999,   // Exceeds 100 -> clamped to 100
    stage: 'lead',
  })

  assert.strictEqual(malformedDeal.amount, 0, 'Negative amount normalized to 0')
  assert.strictEqual(malformedDeal.probability, 100, 'Probability clamped to 100')

  const malformedDeal2 = sanitizeDeal({
    id: 'deal-clamp-2',
    name: 'Negative Prob Deal',
    amount: 1000,
    probability: -50,   // Below 0 -> clamped to 0
    stage: 'lead',
  })

  assert.strictEqual(malformedDeal2.probability, 0, 'Negative probability clamped to 0')
})

test('7.3 Tenders Store: v0 unversioned tenders migrate cleanly to v1 envelope', () => {
  const legacyTenders = {
    activeCompanyId: 'comp-001',
    workspaces: [{ id: 'ws-1', name: 'Workspace 1' }],
    issuerTemplates: [{ id: 'tmpl-1', name: 'Standard Template' }],
  }

  const result = migrateAndValidateTenders(legacyTenders)
  assert.strictEqual(result.version, 1)
  assert.strictEqual(result.activeCompanyId, 'comp-001')
  assert.strictEqual(result.workspaces.length, 1)
  assert.strictEqual(result.issuerTemplates.length, 1)
})

test('7.4 Tenders Store: Zero-byte / corrupted tenders file generates .corrupted.bak and safe defaults', () => {
  const sb = createSandbox()
  try {
    mkdirSync(join(sb.dir, 'tenders'), { recursive: true })
    writeFileSync(sb.tendersPath, 'CORRUPTED_TENDERS_PAYLOAD', 'utf8')

    const loaded = readTendersStore(sb.tendersPath)
    assert.strictEqual(loaded.version, 1)
    assert.strictEqual(loaded.workspaces.length, 0)

    const bakPath = `${sb.tendersPath}.corrupted.bak`
    assert(existsSync(bakPath), 'Tenders .corrupted.bak must exist')
    assert.strictEqual(readFileSync(bakPath, 'utf8'), 'CORRUPTED_TENDERS_PAYLOAD')
  } finally {
    sb.cleanup()
  }
})

// ============================================================================
// SECTION 8: MALFORMED DATA STRUCTURES & RESILIENCE
// ============================================================================
console.log('\n--- Section 8: Malformed Data Structures & Error Recovery ---')

test('8.1 Duplicate account IDs in Books store are merged without duplicate entries', () => {
  const duplicateAccounts = [
    { id: 'acc-bank', balance: 100000 },
    { id: 'acc-bank', balance: 250000 }, // Duplicate ID
  ]

  const migrated = migrateAndValidateBooks({ accounts: duplicateAccounts })
  const bankAccounts = migrated.accounts.filter((a) => a.id === 'acc-bank')
  assert.strictEqual(bankAccounts.length, 1, 'Duplicate account ID must be deduplicated')
  assert.strictEqual(bankAccounts[0].balance, 250000, 'Latest entry in map wins')
})

test('8.2 Accounts with invalid or non-string IDs are safely ignored', () => {
  const invalidAccounts = [
    null,
    undefined,
    1234,
    { id: null, balance: 100 },
    { id: 9999, balance: 200 },
    { id: 'acc-bank', balance: 50000 },
  ]

  const migrated = migrateAndValidateBooks({ accounts: invalidAccounts })
  const bank = migrated.accounts.find((a) => a.id === 'acc-bank')
  assert.strictEqual(bank.balance, 50000)
  assert.strictEqual(migrated.accounts.filter((a) => !a || typeof a.id !== 'string').length, 0, 'No malformed accounts in list')
})

test('8.3 Malformed settings (non-object or null) gracefully fall back to DEFAULT_BOOK_SETTINGS', () => {
  const res1 = migrateAndValidateBooks({ settings: 'not an object' })
  assert.strictEqual(res1.settings.companyName, DEFAULT_BOOK_SETTINGS.companyName)

  const res2 = migrateAndValidateBooks({ settings: null })
  assert.strictEqual(res2.settings.companyName, DEFAULT_BOOK_SETTINGS.companyName)

  const res3 = migrateAndValidateBooks({ settings: [1, 2, 3] })
  assert.strictEqual(res3.settings.companyName, DEFAULT_BOOK_SETTINGS.companyName)
})

// ============================================================================
// SUMMARY & VERDICT
// ============================================================================
console.log('\n======================================================================')
console.log(`SUMMARY: ${passed} passed, ${failed} failed out of ${passed + failed} tests`)
if (failures.length > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) {
    console.log(`❌ ${f.name}: ${f.error}`)
  }
}
console.log('======================================================================')

process.exit(failed > 0 ? 1 : 0)

import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  parseBankAmount,
  normalizeDate,
  parseBankStatementCsv,
  splitCsvRow,
  deduplicateBankTransactions,
  round2,
  createSettlementJournal,
} from '../../apps/books/src/shared/accounting'
import {
  importBankStatement,
  executeReconciliation,
  computeSettlementSuggestions,
  writeBooksStore,
  readBooksStore,
} from '../../apps/books/src/main/books-main'
import { initialBooksData } from '../../apps/books/src/renderer/src/mock/initialData'
import type { BooksData } from '../../apps/books/src/shared/types'

let total = 0
let passed = 0
let failed = 0
const errors: Array<{ name: string; error: string }> = []

function check(name: string, fn: () => void) {
  total++
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err: any) {
    failed++
    errors.push({ name, error: err.message })
    console.log(`  ✗ ${name}: ${err.message}`)
  }
}

function createSandbox() {
  const root = join(tmpdir(), `books-r2-adv-${randomUUID().slice(0, 8)}`)
  const booksDir = join(root, 'books')
  const tendersDir = join(root, 'tenders')
  mkdirSync(booksDir, { recursive: true })
  mkdirSync(tendersDir, { recursive: true })
  return {
    root,
    booksPath: join(booksDir, 'books-data.json'),
    tendersPath: join(tendersDir, 'tenders-data.json'),
  }
}

function cleanSandbox(root: string) {
  try {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  } catch {}
}

console.log('=== Reviewer 2 Adversarial Stress Suite ===\n')

// 1. Parsing Edge Cases
console.log('--- 1. Bank Statement Parsing Edge Cases ---')

check('1.1 parseBankAmount: trailing CR/DR, parenthetical negatives, currency tokens', () => {
  assert.strictEqual(parseBankAmount('1500.00DR'), -1500.00)
  assert.strictEqual(parseBankAmount('1500.00 DR'), -1500.00)
  assert.strictEqual(parseBankAmount('3200.00CR'), 3200.00)
  assert.strictEqual(parseBankAmount('3200.00 CR'), 3200.00)
  assert.strictEqual(parseBankAmount('(R 4,500.25)'), -4500.25)
  assert.strictEqual(parseBankAmount('(12 500,75)'), -12500.75)
  assert.strictEqual(parseBankAmount('- R 99,99'), -99.99)
  assert.strictEqual(parseBankAmount('0.00'), 0)
  assert.strictEqual(parseBankAmount(''), 0)
  assert.strictEqual(parseBankAmount(null), 0)
})

check('1.2 splitCsvRow: handles escaped quotes ("")', () => {
  const row = '2026-09-01,"Payment for ""Project Alpha"" Services",15000.00'
  const cols = splitCsvRow(row)
  assert.strictEqual(cols.length, 3)
  assert.strictEqual(cols[0], '2026-09-01')
  assert.strictEqual(cols[1], 'Payment for "Project Alpha" Services')
  assert.strictEqual(cols[2], '15000.00')
})

check('1.3 normalizeDate: varied formats to ISO YYYY-MM-DD', () => {
  assert.strictEqual(normalizeDate('2026-09-05'), '2026-09-05')
  assert.strictEqual(normalizeDate('2026/09/05'), '2026-09-05')
  assert.strictEqual(normalizeDate('05/09/2026'), '2026-09-05')
  assert.strictEqual(normalizeDate('05-09-2026'), '2026-09-05')
  assert.strictEqual(normalizeDate('20260905'), '2026-09-05')
})

check('1.4 parseBankStatementCsv: unrecognized headers return empty array safely', () => {
  const badCsv = `Foo,Bar,Baz\n1,2,3\n4,5,6`
  const parsed = parseBankStatementCsv(badCsv)
  assert.strictEqual(parsed.length, 0, 'Unrecognized headers should return [] without throwing')
})

// 2. Reconciliation Edge Cases
console.log('\n--- 2. Reconciliation Edge Cases ---')

check('2.1 Multi-step partial settlement: 3 payments against 1 invoice until fully paid', () => {
  const sb = createSandbox()
  try {
    const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
    // Create an invoice with grandTotal 100,000
    data.invoices.push({
      id: 'inv-multi-partial',
      invoiceNumber: 'INV-MP-001',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      date: '2026-09-01',
      dueDate: '2026-10-01',
      items: [],
      subtotal: 86956.52,
      taxTotal: 13043.48,
      grandTotal: 100000,
      outstandingAmount: 100000,
      status: 'Unpaid',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    writeBooksStore(sb.booksPath, data)

    // Payment 1: 30,000
    const csv1 = `Date,Description,Reference,Amount\n2026-09-01,Payment 1,INV-MP-001,30000.00`
    const imp1 = importBankStatement({ booksDataPath: sb.booksPath, csvContent: csv1 })
    const r1 = executeReconciliation({
      booksDataPath: sb.booksPath,
      transactionId: imp1.transactions![0].id,
      invoiceId: 'inv-multi-partial',
    })
    assert.strictEqual(r1.ok, true)
    assert.strictEqual(r1.settledAmount, 30000)
    assert.strictEqual(r1.remainingOutstanding, 70000)
    assert.strictEqual(r1.invoiceStatus, 'Unpaid')

    // Payment 2: 45,000
    const csv2 = `Date,Description,Reference,Amount\n2026-09-02,Payment 2,INV-MP-001,45000.00`
    const imp2 = importBankStatement({ booksDataPath: sb.booksPath, csvContent: csv2 })
    const r2 = executeReconciliation({
      booksDataPath: sb.booksPath,
      transactionId: imp2.transactions![0].id,
      invoiceId: 'inv-multi-partial',
    })
    assert.strictEqual(r2.ok, true)
    assert.strictEqual(r2.settledAmount, 45000)
    assert.strictEqual(r2.remainingOutstanding, 25000)
    assert.strictEqual(r2.invoiceStatus, 'Unpaid')

    // Payment 3: 25,000 (final full settlement)
    const csv3 = `Date,Description,Reference,Amount\n2026-09-03,Payment 3,INV-MP-001,25000.00`
    const imp3 = importBankStatement({ booksDataPath: sb.booksPath, csvContent: csv3 })
    const r3 = executeReconciliation({
      booksDataPath: sb.booksPath,
      transactionId: imp3.transactions![0].id,
      invoiceId: 'inv-multi-partial',
    })
    assert.strictEqual(r3.ok, true)
    assert.strictEqual(r3.settledAmount, 25000)
    assert.strictEqual(r3.remainingOutstanding, 0)
    assert.strictEqual(r3.invoiceStatus, 'Paid')

    // Check store state
    const after = readBooksStore(sb.booksPath)
    const finalInv = after.invoices.find((i) => i.id === 'inv-multi-partial')!
    assert.strictEqual(finalInv.status, 'Paid')
    assert.strictEqual(finalInv.outstandingAmount, 0)
    assert.strictEqual(after.journalEntries.length, initialBooksData.journalEntries.length + 3)
  } finally {
    cleanSandbox(sb.root)
  }
})

check('2.2 Matching direction validation: rejects inverted signs', () => {
  const sb = createSandbox()
  try {
    const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
    writeBooksStore(sb.booksPath, data)

    // Negative transaction against Sales
    const csvSalesNeg = `Date,Description,Amount\n2026-09-01,Test Negative Sales,-5000.00`
    const imp1 = importBankStatement({ booksDataPath: sb.booksPath, csvContent: csvSalesNeg })
    const r1 = executeReconciliation({
      booksDataPath: sb.booksPath,
      transactionId: imp1.transactions![0].id,
      invoiceId: 'inv-1', // Sales invoice
    })
    assert.strictEqual(r1.ok, false)
    assert.ok(r1.error?.includes('Sales') || r1.error?.includes('withdrawal'))

    // Positive transaction against Purchase
    const csvPurchPos = `Date,Description,Amount\n2026-09-01,Test Positive Purchase,5000.00`
    const imp2 = importBankStatement({ booksDataPath: sb.booksPath, csvContent: csvPurchPos })
    const r2 = executeReconciliation({
      booksDataPath: sb.booksPath,
      transactionId: imp2.transactions![0].id,
      invoiceId: 'bill-1', // Purchase bill
    })
    assert.strictEqual(r2.ok, false)
    assert.ok(r2.error?.includes('Purchase') || r2.error?.includes('deposit'))
  } finally {
    cleanSandbox(sb.root)
  }
})

check('2.3 Cross-app tender milestone persistence fallback gating', () => {
  const sb = createSandbox()
  try {
    const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
    data.invoices.push({
      id: 'inv-tender-adv',
      invoiceNumber: 'INV-TND-ADV',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      date: '2026-09-01',
      dueDate: '2026-10-01',
      tenderReference: 'RFP-ADV-2026',
      items: [],
      subtotal: 100000,
      taxTotal: 15000,
      grandTotal: 115000,
      outstandingAmount: 115000,
      status: 'Unpaid',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    writeBooksStore(sb.booksPath, data)

    // Create tender milestone in sandbox
    const tendersData = {
      version: 1,
      updatedAt: new Date().toISOString(),
      workspaces: [
        {
          id: 'ws-1',
          name: 'Main',
          tenders: [
            {
              id: 't-1',
              referenceNumber: 'RFP-ADV-2026',
              milestones: [
                {
                  id: 'ms-adv-1',
                  amount: 115000,
                  status: 'BILLED',
                  billedInvoiceId: 'inv-tender-adv',
                  billedInvoiceNumber: 'INV-TND-ADV',
                },
              ],
            },
          ],
        },
      ],
    }
    writeFileSync(sb.tendersPath, JSON.stringify(tendersData, null, 2), 'utf8')

    // Step 1: 99% partial payment (114,999 of 115,000)
    const csvPart = `Date,Description,Reference,Amount\n2026-09-01,Near Full,RFP-ADV-2026,114999.00`
    const impPart = importBankStatement({ booksDataPath: sb.booksPath, csvContent: csvPart })
    const rPart = executeReconciliation({
      booksDataPath: sb.booksPath,
      transactionId: impPart.transactions![0].id,
      invoiceId: 'inv-tender-adv',
      tendersDataPath: sb.tendersPath,
    })
    assert.strictEqual(rPart.ok, true)
    assert.strictEqual(rPart.tenderMilestonePaid, false)

    // Milestone on disk must STILL be BILLED
    const disk1 = JSON.parse(readFileSync(sb.tendersPath, 'utf8'))
    assert.strictEqual(disk1.workspaces[0].tenders[0].milestones[0].status, 'BILLED')

    // Step 2: Final 1.00 settlement
    const csvFinal = `Date,Description,Reference,Amount\n2026-09-02,Final Cent,RFP-ADV-2026,1.00`
    const impFinal = importBankStatement({ booksDataPath: sb.booksPath, csvContent: csvFinal })
    const rFinal = executeReconciliation({
      booksDataPath: sb.booksPath,
      transactionId: impFinal.transactions![0].id,
      invoiceId: 'inv-tender-adv',
      tendersDataPath: sb.tendersPath,
    })
    assert.strictEqual(rFinal.ok, true)
    assert.strictEqual(rFinal.tenderMilestonePaid, true)

    // Milestone on disk must now be PAID
    const disk2 = JSON.parse(readFileSync(sb.tendersPath, 'utf8'))
    assert.strictEqual(disk2.workspaces[0].tenders[0].milestones[0].status, 'PAID')
    assert.ok(disk2.workspaces[0].tenders[0].milestones[0].paidAt)
  } finally {
    cleanSandbox(sb.root)
  }
})

console.log(`\n======================================================`)
console.log(`Reviewer 2 Adversarial: ${passed}/${total} passed, ${failed} failed`)
console.log(`======================================================`)
if (failed > 0) process.exit(1)

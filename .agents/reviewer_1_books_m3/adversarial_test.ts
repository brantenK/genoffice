import assert from 'node:assert'
import {
  parseBankAmount,
  parseBankStatementCsv,
  deduplicateBankTransactions,
  round2,
  createSettlementJournal,
  recomputePartyBalances,
} from '../../apps/books/src/shared/accounting'
import {
  executeReconciliation,
  importBankStatement,
  readBooksStore,
  writeBooksStore,
} from '../../apps/books/src/main/books-main'
import { initialBooksData } from '../../apps/books/src/renderer/src/mock/initialData'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

console.log('--- STARTING ADVERSARIAL STRESS TESTING FOR BOOKS M3 ---')

// 1. Adversarial Number Parsing
console.log('Testing adversarial number formats...')
assert.strictEqual(parseBankAmount(''), 0)
assert.strictEqual(parseBankAmount('   '), 0)
assert.strictEqual(parseBankAmount(null), 0)
assert.strictEqual(parseBankAmount(undefined), 0)
assert.strictEqual(parseBankAmount('N/A'), 0)
assert.strictEqual(parseBankAmount('--'), 0)
assert.strictEqual(parseBankAmount('(0.00)'), 0)
assert.strictEqual(parseBankAmount('0,00'), 0)
assert.strictEqual(parseBankAmount('R 0.00'), 0)
assert.strictEqual(parseBankAmount('(R 0.01)'), -0.01)
assert.strictEqual(parseBankAmount('R 999 999 999,99'), 999999999.99)
assert.strictEqual(parseBankAmount('(999,999,999.99)'), -999999999.99)
assert.strictEqual(parseBankAmount('100.50CR'), 100.5)
assert.strictEqual(parseBankAmount('100.50DR'), -100.5)
assert.strictEqual(parseBankAmount('R 1 234 567.89'), 1234567.89)
assert.strictEqual(parseBankAmount('-R 1 234 567,89'), -1234567.89)
console.log('Adversarial number parsing: PASS')

// 2. Adversarial Deduplication: Re-importing 5 times, mixed batches
console.log('Testing deduplication under multi-round re-import stress...')
const txBase = [
  { id: '1', accountId: 'acc-bank', date: '2026-09-01', description: 'Fee', reference: 'REF1', amount: -15, reconciled: false },
  { id: '2', accountId: 'acc-bank', date: '2026-09-01', description: 'Fee', reference: 'REF1', amount: -15, reconciled: false },
  { id: '3', accountId: 'acc-bank', date: '2026-09-01', description: 'Deposit', reference: 'REF2', amount: 500, reconciled: false },
]

let existing: any[] = []
let totalNetAdjustment = 0

// Import round 1: 3 tx
const round1 = deduplicateBankTransactions(txBase, existing)
assert.strictEqual(round1.toAdd.length, 3)
assert.strictEqual(round1.skippedDuplicates, 0)
assert.strictEqual(round1.netAdjustment, 470)
existing = [...existing, ...round1.toAdd]
totalNetAdjustment += round1.netAdjustment

// Import round 2: identical CSV
const round2Res = deduplicateBankTransactions(txBase, existing)
assert.strictEqual(round2Res.toAdd.length, 0)
assert.strictEqual(round2Res.skippedDuplicates, 3)
assert.strictEqual(round2Res.netAdjustment, 0)

// Import round 3: 1 extra identical fee (now 3 fees on same day)
const txRound3 = [
  ...txBase,
  { id: '4', accountId: 'acc-bank', date: '2026-09-01', description: 'Fee', reference: 'REF1', amount: -15, reconciled: false },
]
const round3Res = deduplicateBankTransactions(txRound3, existing)
assert.strictEqual(round3Res.toAdd.length, 1)
assert.strictEqual(round3Res.skippedDuplicates, 3)
assert.strictEqual(round3Res.netAdjustment, -15)
existing = [...existing, ...round3Res.toAdd]
totalNetAdjustment += round3Res.netAdjustment

assert.strictEqual(existing.length, 4)
assert.strictEqual(totalNetAdjustment, 455)
console.log('Multi-round deduplication: PASS')

// 3. Adversarial Tender Milestone Gating: 99.99% Paid
console.log('Testing tender milestone strictly gated at 100% settlement...')
const testDir = join(tmpdir(), `books-adv-${randomUUID().slice(0, 8)}`)
mkdirSync(join(testDir, 'books'), { recursive: true })
mkdirSync(join(testDir, 'tenders'), { recursive: true })
const booksPath = join(testDir, 'books', 'books-data.json')
const tendersPath = join(testDir, 'tenders', 'tenders-data.json')

try {
  const booksData = JSON.parse(JSON.stringify(initialBooksData))
  booksData.invoices.push({
    id: 'inv-tender-adv',
    invoiceNumber: 'INV-TND-ADV',
    type: 'Sales',
    partyId: 'party-1',
    partyName: 'City of Ekurhuleni Water Dept',
    date: '2026-08-28',
    dueDate: '2026-09-28',
    tenderReference: 'RFP-WTR-2026-04',
    items: [],
    subtotal: 100000,
    taxTotal: 15000,
    grandTotal: 115000,
    outstandingAmount: 115000,
    status: 'Unpaid',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  })
  writeBooksStore(booksPath, booksData)

  const tendersData = {
    version: 1,
    updatedAt: new Date().toISOString(),
    workspaces: [
      {
        id: 'ws-default',
        name: 'Default',
        tenders: [
          {
            id: 'tender-1',
            referenceNumber: 'RFP-WTR-2026-04',
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
  writeFileSync(tendersPath, JSON.stringify(tendersData, null, 2), 'utf8')

  // Partial pay: 114,999.99 (leaves 0.01 unpaid)
  const csvPartial = `Date,Description,Reference,Amount\n2026-09-01,Payment,INV-TND-ADV,114999.99`
  const impPartial = importBankStatement({ booksDataPath: booksPath, csvContent: csvPartial })
  const resPartial = executeReconciliation({
    booksDataPath: booksPath,
    transactionId: impPartial.transactions![0].id,
    invoiceId: 'inv-tender-adv',
    tendersDataPath: tendersPath,
  })

  assert.strictEqual(resPartial.ok, true)
  assert.strictEqual(resPartial.settledAmount, 114999.99)
  assert.strictEqual(resPartial.remainingOutstanding, 0.01)
  assert.strictEqual(resPartial.invoiceStatus, 'Unpaid')
  assert.strictEqual(resPartial.tenderMilestonePaid, false)

  // Verify tenders file on disk is still BILLED
  const diskTenders = JSON.parse(readFileSync(tendersPath, 'utf8'))
  const ms = diskTenders.workspaces[0].tenders[0].milestones[0]
  assert.strictEqual(ms.status, 'BILLED', 'Must remain BILLED even when 99.99% is paid!')

  // Now pay final 0.01
  const csvFinal = `Date,Description,Reference,Amount\n2026-09-02,Payment Final Cent,INV-TND-ADV,0.01`
  const impFinal = importBankStatement({ booksDataPath: booksPath, csvContent: csvFinal })
  const resFinal = executeReconciliation({
    booksDataPath: booksPath,
    transactionId: impFinal.transactions![0].id,
    invoiceId: 'inv-tender-adv',
    tendersDataPath: tendersPath,
  })

  assert.strictEqual(resFinal.ok, true)
  assert.strictEqual(resFinal.settledAmount, 0.01)
  assert.strictEqual(resFinal.remainingOutstanding, 0)
  assert.strictEqual(resFinal.invoiceStatus, 'Paid')
  assert.strictEqual(resFinal.tenderMilestonePaid, true)

  const diskTendersFinal = JSON.parse(readFileSync(tendersPath, 'utf8'))
  const msFinal = diskTendersFinal.workspaces[0].tenders[0].milestones[0]
  assert.strictEqual(msFinal.status, 'PAID')
  assert.ok(msFinal.paidAt)
  console.log('Tender milestone gating 100%: PASS')
} finally {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
}

console.log('--- ALL ADVERSARIAL STRESS TESTS PASSED SUCCESSFULLY! ---')

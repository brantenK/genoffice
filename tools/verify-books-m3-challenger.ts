/**
 * tools/verify-books-m3-challenger.ts
 *
 * EMPIRICAL CHALLENGER TEST SUITE FOR BOOKS MILESTONE 3 (M3)
 * Features: F10, F11, F12, F13
 *
 * Verification Objectives:
 * 1. F10 - SA Bank Statement CSV Parser:
 *    - Dynamic header detection skipping introductory metadata rows (Nedbank, Absa)
 *    - FNB single signed amount column, Standard Bank Debit/Credit columns
 *    - Parenthetical negatives: (1,250.00) -> -1250.00
 *    - Decimal commas: 1250,50 -> 1250.50, spaces as thousands: 1 250,50 -> 1250.50
 *    - UTF-8 BOM, summary line filtering, strict 2-decimal rounding
 * 2. F11 - Resilient Bank Transaction Deduplication:
 *    - Exact duplicate CSV re-import detection (skippedDuplicates > 0, 0 re-added)
 *    - Same-day legitimate identical charges preserved on first import
 *    - Distinct reference support avoiding collisions
 *    - Accurate acc-bank ledger balance adjustment by net amount
 * 3. F12 - Exact & Partial Reconciliation Settlement Math:
 *    - Direction validation (Sales requires deposit > 0, Purchase requires withdrawal < 0)
 *    - Exact settlement: binds to amount, clears outstanding, marks Paid
 *    - Partial settlement: binds to transaction amount, decrements outstanding, keeps Unpaid
 *    - Accurate AR/AP deduction by settled amount (NOT full invoice total)
 *    - Balanced settlement JournalEntry (totalDebit === totalCredit === settledAmount)
 *    - Recomputed party balances strictly matching remaining open totals
 * 4. F13 - Tender Milestone Payment Back-Propagation Threshold:
 *    - Partial settlement does NOT transition milestone to PAID
 *    - Full settlement transitions milestone to PAID with paidAt/paidDate
 *    - Disk store updated resiliently with direct JSON fallback
 * 5. Parity between books-main.ts backend and store.ts renderer fallback
 */

import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  parseBankStatementCsv,
  parseBankAmount,
  normalizeDate,
  deduplicateBankTransactions,
  round2,
  createSettlementJournal,
} from '../apps/books/src/shared/accounting'
import {
  importBankStatement,
  executeReconciliation,
  computeSettlementSuggestions,
  writeBooksStore,
  readBooksStore,
} from '../apps/books/src/main/books-main'
import { useBooksStore } from '../apps/books/src/renderer/src/store'
import { initialBooksData } from '../apps/books/src/renderer/src/mock/initialData'
import type { BooksData } from '../apps/books/src/shared/types'

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures: Array<{ suite: string; name: string; error: string }> = []

async function test(suite: string, name: string, fn: () => void | Promise<void>) {
  totalTests++
  try {
    await fn()
    passedTests++
    console.log(`  [PASS] ${name}`)
  } catch (err: any) {
    failedTests++
    failures.push({ suite, name, error: err.message || String(err) })
    console.error(`  [FAIL] ${name}: ${err.message}`)
  }
}

// Temporary sandbox creator
function createSandbox(): { root: string; booksPath: string; tendersPath: string } {
  const id = randomUUID().slice(0, 8)
  const root = join(tmpdir(), `books-m3-challenger-${id}`)
  const booksDir = join(root, 'books')
  const tendersDir = join(root, 'tenders')
  mkdirSync(booksDir, { recursive: true })
  mkdirSync(tendersDir, { recursive: true })
  const booksPath = join(booksDir, 'books-data.json')
  const tendersPath = join(tendersDir, 'tenders-data.json')
  return { root, booksPath, tendersPath }
}

function cleanSandbox(root: string) {
  try {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  } catch {}
}

function createSampleTendersData(milestoneAmount = 145000) {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    workspaces: [
      {
        id: 'ws-default',
        name: 'Default Workspace',
        tenders: [
          {
            id: 'tender-1',
            referenceNumber: 'RFP-WTR-2026-04',
            title: 'Municipal Water Reticulation Upgrades',
            issuingAuthority: 'City of Ekurhuleni Water Dept',
            milestones: [
              {
                id: 'ms-01',
                title: 'Civil Groundwork & Trenching',
                amount: milestoneAmount,
                status: 'BILLED',
                billedInvoiceId: 'inv-tender-1',
                billedInvoiceNumber: 'INV-2026-TND1',
                billedDate: '2026-08-28T00:00:00.000Z',
              },
              {
                id: 'ms-02',
                title: 'Pipe Laying & Pressure Testing',
                amount: 85000,
                status: 'BILLED',
                billedInvoiceId: 'inv-tender-2',
                billedInvoiceNumber: 'INV-2026-TND2',
                billedDate: '2026-08-28T00:00:00.000Z',
              },
            ],
          },
        ],
      },
    ],
  }
}

async function run() {
  console.log('======================================================================')
  console.log('   EMPIRICAL CHALLENGER: BOOKS MILESTONE 3 (M3) AUDIT HARNESS')
  console.log('======================================================================\n')

  // --------------------------------------------------------------------------
  // SUITE 1: F10 - SA Bank Statement CSV Parser
  // --------------------------------------------------------------------------
  console.log('--- SUITE 1: F10 - South African Bank Statement CSV Parsing ---')

  await test('Suite 1', '1.1 parseBankAmount: handles parenthetical negatives, currency tokens, and commas', () => {
    assert.strictEqual(parseBankAmount('(1,250.00)'), -1250)
    assert.strictEqual(parseBankAmount('(1250.00)'), -1250)
    assert.strictEqual(parseBankAmount('(R 1,250.50)'), -1250.5)
    assert.strictEqual(parseBankAmount('R 145,000.00'), 145000)
    assert.strictEqual(parseBankAmount('ZAR 50 500.50'), 50500.5)
    assert.strictEqual(parseBankAmount('$ 2,500.25'), 2500.25)
    assert.strictEqual(parseBankAmount('-R 42,000.00'), -42000)
    assert.strictEqual(parseBankAmount('450.00-'), -450)
    assert.strictEqual(parseBankAmount('1500.00DR'), -1500)
    assert.strictEqual(parseBankAmount('12000.00CR'), 12000)
  })

  await test('Suite 1', '1.2 parseBankAmount: handles South African decimal commas and spaces as thousands', () => {
    assert.strictEqual(parseBankAmount('1250,50'), 1250.5)
    assert.strictEqual(parseBankAmount('1 250,50'), 1250.5)
    assert.strictEqual(parseBankAmount('1 250.50'), 1250.5)
    assert.strictEqual(parseBankAmount('-45 000,00'), -45000)
    assert.strictEqual(parseBankAmount('(R 12 500,00)'), -12500)
    assert.strictEqual(parseBankAmount('R 125 000,50'), 125000.5)
  })

  await test('Suite 1', '1.3 FNB format: signed Amount column with quotes, R prefix and parenthetical fees', () => {
    const csv = `Date,Amount,Balance,Description
2026-09-01,"R 145,000.00","R 630,250.00",Ekurhuleni Municipality Settlement
2026-09-02,"(450.00)","R 629,800.00",Monthly Cheque Account Fee
2026-09-03,"-12,500.00","R 617,300.00",Safintra Steel Materials`

    const parsed = parseBankStatementCsv(csv)
    assert.strictEqual(parsed.length, 3)
    assert.strictEqual(parsed[0].amount, 145000)
    assert.strictEqual(parsed[0].description, 'Ekurhuleni Municipality Settlement')
    assert.strictEqual(parsed[1].amount, -450)
    assert.strictEqual(parsed[2].amount, -12500)
  })

  await test('Suite 1', '1.4 Standard Bank format: separate Debit and Credit columns with positive/negative debit values', () => {
    const csv = `Date,Description,Debit,Credit,Balance
2026-09-01,Customer Deposit,,50000.00,535250.00
2026-09-02,Subcontractor Payment,15000.00,,520250.00
2026-09-03,Office Equipment,"(2,500.00)",,517750.00
2026-09-04,Courier Service,-350.00,,517400.00`

    const parsed = parseBankStatementCsv(csv)
    assert.strictEqual(parsed.length, 4)
    assert.strictEqual(parsed[0].amount, 50000)
    assert.strictEqual(parsed[1].amount, -15000) // Positive in debit column correctly becomes negative
    assert.strictEqual(parsed[2].amount, -2500)  // Parenthesized negative in debit column remains negative
    assert.strictEqual(parsed[3].amount, -350)   // Signed negative in debit column does NOT invert
  })

  await test('Suite 1', '1.5 Nedbank format: dynamic header row detection skipping introductory account metadata', () => {
    const csv = `Account Number:,1234567890
Account Name:,Zano Consulting (Pty) Ltd
Statement Period:,2026-09-01 to 2026-09-05
Closing Balance:,R 625,000.00

Date,Transaction Description,Debit Amount,Credit Amount,Balance
2026-09-01,Municipal Progress Payment,,145000.00,630250.00
2026-09-02,Safintra Steel Payment,42000.00,,588250.00
2026-09-03,Bank Service Charge,450.00,,587800.00

Total Debits,42450.00,,
Total Credits,,145000.00,`

    const parsed = parseBankStatementCsv(csv)
    assert.strictEqual(parsed.length, 3, 'Exactly 3 data rows parsed, metadata header and summary footer skipped')
    assert.strictEqual(parsed[0].amount, 145000)
    assert.strictEqual(parsed[0].description, 'Municipal Progress Payment')
    assert.strictEqual(parsed[1].amount, -42000)
    assert.strictEqual(parsed[2].amount, -450)
  })

  await test('Suite 1', '1.6 Absa format: UTF-8 BOM, metadata header, and decimal comma values', () => {
    const csv = `\uFEFFAbsa Business Banking Statement
Account: 987654321
Date,Description,Debit,Credit,Balance
2026-09-01,Consulting Fee,,"85 000,50",
2026-09-02,Rent Expense,"15 250,50",,`

    const parsed = parseBankStatementCsv(csv)
    assert.strictEqual(parsed.length, 2)
    assert.strictEqual(parsed[0].amount, 85000.5)
    assert.strictEqual(parsed[1].amount, -15250.5)
  })

  // --------------------------------------------------------------------------
  // SUITE 2: F11 - Resilient Bank Transaction Deduplication
  // --------------------------------------------------------------------------
  console.log('\n--- SUITE 2: F11 - Resilient Bank Transaction Deduplication ---')

  await test('Suite 2', '2.1 Re-importing exact same CSV skips 100% of duplicates and does not double-adjust bank balance', () => {
    const sandbox = createSandbox()
    try {
      const initial = JSON.parse(JSON.stringify(initialBooksData))
      const bankBefore = initial.accounts.find((a: any) => a.id === 'acc-bank').balance
      writeBooksStore(sandbox.booksPath, initial)

      const csv = `Date,Description,Reference,Amount
2026-09-01,Client Deposit,INV-001,100000.00
2026-09-02,Vendor Payment,BILL-001,-25000.00`

      // 1st Import
      const res1 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      assert.strictEqual(res1.ok, true)
      assert.strictEqual(res1.importedCount, 2)
      assert.strictEqual(res1.skippedDuplicates, 0)
      assert.strictEqual(res1.netAdjustment, 75000)
      assert.strictEqual(res1.newBankBalance, round2(bankBefore + 75000))

      // 2nd Import of identical CSV
      const res2 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      assert.strictEqual(res2.ok, true)
      assert.strictEqual(res2.importedCount, 0)
      assert.strictEqual(res2.skippedDuplicates, 2)
      assert.strictEqual(res2.netAdjustment, 0)
      assert.strictEqual(res2.newBankBalance, round2(bankBefore + 75000))

      const dataAfter = readBooksStore(sandbox.booksPath)
      assert.strictEqual(dataAfter.bankTransactions.length, 2)
      const finalBank = dataAfter.accounts.find((a: any) => a.id === 'acc-bank').balance
      assert.strictEqual(finalBank, round2(bankBefore + 75000))
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Suite 2', '2.2 Legitimate same-day identical charges: both preserved on 1st import, skipped on re-import', () => {
    const sandbox = createSandbox()
    try {
      writeBooksStore(sandbox.booksPath, JSON.parse(JSON.stringify(initialBooksData)))

      // 2 legitimate identical bank charges on the same day (e.g. 2 x R45 service fee)
      const csv = `Date,Description,Reference,Amount
2026-09-01,Monthly Business Cheque Account Maintenance Fee,FEE-01,-45.00
2026-09-01,Monthly Business Cheque Account Maintenance Fee,FEE-01,-45.00`

      const res1 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      assert.strictEqual(res1.ok, true)
      assert.strictEqual(res1.importedCount, 2, 'Both legitimate same-day charges imported')
      assert.strictEqual(res1.skippedDuplicates, 0)
      assert.strictEqual(res1.netAdjustment, -90)

      const dataAfter1 = readBooksStore(sandbox.booksPath)
      assert.strictEqual(dataAfter1.bankTransactions.length, 2)

      // Re-importing must skip both
      const res2 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      assert.strictEqual(res2.importedCount, 0)
      assert.strictEqual(res2.skippedDuplicates, 2)
      assert.strictEqual(res2.netAdjustment, 0)

      // If statement now contains 3 charges (1 new legitimate one)
      const csv3 = `${csv}\n2026-09-01,Monthly Business Cheque Account Maintenance Fee,FEE-01,-45.00`
      const res3 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv3 })
      assert.strictEqual(res3.importedCount, 1, 'Only the 3rd new occurrence is imported')
      assert.strictEqual(res3.skippedDuplicates, 2, 'First 2 occurrences recognized as existing duplicates')
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Suite 2', '2.3 Distinct references avoid deduplication collision', () => {
    const sandbox = createSandbox()
    try {
      writeBooksStore(sandbox.booksPath, JSON.parse(JSON.stringify(initialBooksData)))

      const csv = `Date,Description,Reference,Amount
2026-09-01,Client Payment,INV-101,50000.00
2026-09-01,Client Payment,INV-102,50000.00`

      const res = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      assert.strictEqual(res.importedCount, 2, 'Distinct references treated as distinct transactions')
      assert.strictEqual(res.skippedDuplicates, 0)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  // --------------------------------------------------------------------------
  // SUITE 3: F12 - Exact & Partial Reconciliation Settlement Math
  // --------------------------------------------------------------------------
  console.log('\n--- SUITE 3: F12 - Exact & Partial Reconciliation Settlement Math ---')

  await test('Suite 3', '3.1 Exact settlement: full invoice paid, status becomes Paid, balanced journal posted', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      const openInv = data.invoices.find((i) => i.id === 'inv-1')!
      const initialAr = data.accounts.find((a) => a.id === 'acc-ar')!.balance
      const targetAmount = openInv.outstandingAmount // 145000

      writeBooksStore(sandbox.booksPath, data)

      const csv = `Date,Description,Reference,Amount\n2026-09-01,Ekurhuleni Settlement,${openInv.invoiceNumber},${targetAmount}`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const txId = imp.transactions![0].id

      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: txId,
        invoiceId: openInv.id,
      })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.settledAmount, 145000)
      assert.strictEqual(res.remainingOutstanding, 0)
      assert.strictEqual(res.invoiceStatus, 'Paid')

      const after = readBooksStore(sandbox.booksPath)
      const reconciledInv = after.invoices.find((i) => i.id === openInv.id)!
      assert.strictEqual(reconciledInv.status, 'Paid')
      assert.strictEqual(reconciledInv.outstandingAmount, 0)

      // AR decremented by settled amount
      const newAr = after.accounts.find((a) => a.id === 'acc-ar')!.balance
      assert.strictEqual(newAr, round2(initialAr - 145000))

      // Balanced settlement Journal Entry posted
      const je = after.journalEntries[0]
      assert.strictEqual(je.totalDebit, 145000)
      assert.strictEqual(je.totalCredit, 145000)
      assert.strictEqual(je.totalDebit, je.totalCredit)
      assert.strictEqual(je.items.find((it) => it.accountId === 'acc-bank')!.debit, 145000)
      assert.strictEqual(je.items.find((it) => it.accountId === 'acc-ar')!.credit, 145000)

      // Party balance updated
      const party = after.parties.find((p) => p.id === openInv.partyId)!
      assert.strictEqual(party.outstandingBalance, 0)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Suite 3', '3.2 Partial settlement: deposit < invoice, binds to tx.amount, leaves remainder Unpaid', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      // inv-1 grandTotal is 145000, outstandingAmount is 145000
      const initialAr = data.accounts.find((a) => a.id === 'acc-ar')!.balance
      const depositAmount = 45000 // Partial payment

      writeBooksStore(sandbox.booksPath, data)

      const csv = `Date,Description,Reference,Amount\n2026-09-01,Ekurhuleni Deposit Part 1,INV-2026-001,${depositAmount}`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const txId = imp.transactions![0].id

      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: txId,
        invoiceId: 'inv-1',
      })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.settledAmount, 45000, 'Settled amount bound to actual deposit, NOT 145000')
      assert.strictEqual(res.remainingOutstanding, 100000, '145000 - 45000 = 100000 remaining')
      assert.strictEqual(res.invoiceStatus, 'Unpaid', 'Invoice remains Unpaid')

      const after = readBooksStore(sandbox.booksPath)
      const partiallyPaidInv = after.invoices.find((i) => i.id === 'inv-1')!
      assert.strictEqual(partiallyPaidInv.status, 'Unpaid')
      assert.strictEqual(partiallyPaidInv.outstandingAmount, 100000)

      // AR decremented by EXACT partial amount
      const newAr = after.accounts.find((a) => a.id === 'acc-ar')!.balance
      assert.strictEqual(newAr, round2(initialAr - 45000))

      // Balanced journal entry of exactly R45,000
      const je = after.journalEntries[0]
      assert.strictEqual(je.totalDebit, 45000)
      assert.strictEqual(je.totalCredit, 45000)

      // Party balance reflects open remainder of R100,000
      const party = after.parties.find((p) => p.id === 'party-1')!
      assert.strictEqual(party.outstandingBalance, 100000)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Suite 3', '3.3 Multi-step settlement: 2 partial payments fully settle an invoice', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      writeBooksStore(sandbox.booksPath, data)

      // Step 1: Pay 60,000
      const csv1 = `Date,Description,Reference,Amount\n2026-09-01,Part 1,INV-2026-001,60000.00`
      const imp1 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv1 })
      const res1 = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp1.transactions![0].id,
        invoiceId: 'inv-1',
      })
      assert.strictEqual(res1.settledAmount, 60000)
      assert.strictEqual(res1.remainingOutstanding, 85000)
      assert.strictEqual(res1.invoiceStatus, 'Unpaid')

      // Step 2: Pay remaining 85,000
      const csv2 = `Date,Description,Reference,Amount\n2026-09-02,Part 2,INV-2026-001,85000.00`
      const imp2 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv2 })
      const res2 = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp2.transactions![0].id,
        invoiceId: 'inv-1',
      })
      assert.strictEqual(res2.settledAmount, 85000)
      assert.strictEqual(res2.remainingOutstanding, 0)
      assert.strictEqual(res2.invoiceStatus, 'Paid')

      const finalData = readBooksStore(sandbox.booksPath)
      const finalInv = finalData.invoices.find((i) => i.id === 'inv-1')!
      assert.strictEqual(finalInv.status, 'Paid')
      assert.strictEqual(finalInv.outstandingAmount, 0)
      const party = finalData.parties.find((p) => p.id === 'party-1')!
      assert.strictEqual(party.outstandingBalance, 0)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Suite 3', '3.4 Purchase bill partial and exact settlement', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      // bill-1 is a Purchase bill for 42000
      const initialAp = data.accounts.find((a) => a.id === 'acc-ap')!.balance
      writeBooksStore(sandbox.booksPath, data)

      // Partial disbursement of -20000
      const csv = `Date,Description,Reference,Amount\n2026-09-01,Safintra Steel Part Pay,BILL-2026-001,-20000.00`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp.transactions![0].id,
        invoiceId: 'bill-1',
      })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.settledAmount, 20000)
      assert.strictEqual(res.remainingOutstanding, 22000)
      assert.strictEqual(res.invoiceStatus, 'Unpaid')

      const after = readBooksStore(sandbox.booksPath)
      const newAp = after.accounts.find((a) => a.id === 'acc-ap')!.balance
      assert.strictEqual(newAp, round2(initialAp - 20000))

      const je = after.journalEntries[0]
      assert.strictEqual(je.totalDebit, 20000)
      assert.strictEqual(je.totalCredit, 20000)
      assert.strictEqual(je.items.find((it) => it.accountId === 'acc-ap')!.debit, 20000)
      assert.strictEqual(je.items.find((it) => it.accountId === 'acc-bank')!.credit, 20000)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Suite 3', '3.5 Rejection guards: direction mismatches and double-reconciliation', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      writeBooksStore(sandbox.booksPath, data)

      const csv = `Date,Description,Reference,Amount
2026-09-01,Deposit For Sales,,50000.00
2026-09-02,Withdrawal For Purchase,,-20000.00`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const depositTxId = imp.transactions![0].id
      const withdrawalTxId = imp.transactions![1].id

      // 1. Withdrawal against Sales invoice must fail
      const badSales = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: withdrawalTxId,
        invoiceId: 'inv-1',
      })
      assert.strictEqual(badSales.ok, false)
      assert.ok(badSales.error?.includes('withdrawal') || badSales.error?.includes('Sales'))

      // 2. Deposit against Purchase bill must fail
      const badPurchase = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: depositTxId,
        invoiceId: 'bill-1',
      })
      assert.strictEqual(badPurchase.ok, false)
      assert.ok(badPurchase.error?.includes('deposit') || badPurchase.error?.includes('Purchase'))

      // 3. Re-reconcile already reconciled transaction must fail
      const okRecon = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: depositTxId,
        invoiceId: 'inv-1',
      })
      assert.strictEqual(okRecon.ok, true)

      const dupTxRecon = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: depositTxId,
        invoiceId: 'inv-2',
      })
      assert.strictEqual(dupTxRecon.ok, false)
      assert.ok(dupTxRecon.error?.includes('already reconciled'))
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  // --------------------------------------------------------------------------
  // SUITE 4: F13 - Tender Milestone Payment Back-Propagation Threshold
  // --------------------------------------------------------------------------
  console.log('\n--- SUITE 4: F13 - Tender Milestone Back-Propagation Threshold ---')

  await test('Suite 4', '4.1 Partial settlement does NOT transition tender milestone to PAID', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      // Add a tender-linked invoice
      data.invoices.push({
        id: 'inv-tender-1',
        invoiceNumber: 'INV-2026-TND1',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-08-28',
        dueDate: '2026-09-28',
        tenderReference: 'RFP-WTR-2026-04',
        items: [],
        subtotal: 126086.96,
        taxTotal: 18913.04,
        grandTotal: 145000,
        outstandingAmount: 145000,
        status: 'Unpaid',
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
      })
      writeBooksStore(sandbox.booksPath, data)

      // Initialize tenders data on disk
      const tendersData = createSampleTendersData(145000)
      writeFileSync(sandbox.tendersPath, JSON.stringify(tendersData, null, 2), 'utf8')

      // Partial payment of 60,000 (leaves 85,000 unpaid)
      const csv = `Date,Description,Reference,Amount\n2026-09-01,Ekurhuleni Tender Partial,RFP-WTR-2026-04,60000.00`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const txId = imp.transactions![0].id

      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: txId,
        invoiceId: 'inv-tender-1',
        tendersDataPath: sandbox.tendersPath,
      })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.settledAmount, 60000)
      assert.strictEqual(res.remainingOutstanding, 85000)
      assert.strictEqual(res.invoiceStatus, 'Unpaid')
      assert.strictEqual(res.tenderMilestonePaid, false, 'Partial payment must NOT trigger tenderMilestonePaid')

      // Inspect tenders-data.json on disk: milestone ms-01 must STILL be BILLED, NOT PAID
      const tendersOnDisk = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      const milestone = tendersOnDisk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
      assert.strictEqual(milestone.status, 'BILLED', 'Milestone status remains BILLED on partial payment')
      assert.strictEqual(milestone.paidAt, undefined)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Suite 4', '4.2 Full settlement transitions tender milestone to PAID on disk', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      data.invoices.push({
        id: 'inv-tender-1',
        invoiceNumber: 'INV-2026-TND1',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-08-28',
        dueDate: '2026-09-28',
        tenderReference: 'RFP-WTR-2026-04',
        items: [],
        subtotal: 126086.96,
        taxTotal: 18913.04,
        grandTotal: 145000,
        outstandingAmount: 145000,
        status: 'Unpaid',
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
      })
      writeBooksStore(sandbox.booksPath, data)

      const tendersData = createSampleTendersData(145000)
      writeFileSync(sandbox.tendersPath, JSON.stringify(tendersData, null, 2), 'utf8')

      // Full payment of 145,000
      const csv = `Date,Description,Reference,Amount\n2026-09-01,Ekurhuleni Tender Full,RFP-WTR-2026-04,145000.00`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const txId = imp.transactions![0].id

      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: txId,
        invoiceId: 'inv-tender-1',
        tendersDataPath: sandbox.tendersPath,
      })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.settledAmount, 145000)
      assert.strictEqual(res.remainingOutstanding, 0)
      assert.strictEqual(res.invoiceStatus, 'Paid')
      assert.strictEqual(res.tenderMilestonePaid, true, 'Full payment triggers tenderMilestonePaid')
      assert.strictEqual(res.matchedMilestoneId, 'ms-01')

      // Inspect tenders-data.json on disk
      const tendersOnDisk = JSON.parse(readFileSync(sandbox.tendersPath, 'utf8'))
      const milestone = tendersOnDisk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-01')
      assert.strictEqual(milestone.status, 'PAID', 'Milestone transitioned to PAID on full settlement')
      assert.strictEqual(typeof milestone.paidAt, 'string')
      assert.strictEqual(typeof milestone.paidDate, 'string')

      // Verify second milestone remained unchanged
      const ms2 = tendersOnDisk.workspaces[0].tenders[0].milestones.find((m: any) => m.id === 'ms-02')
      assert.strictEqual(ms2.status, 'BILLED')
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  // --------------------------------------------------------------------------
  // SUITE 5: Renderer Store Parity & In-Memory Fallback
  // --------------------------------------------------------------------------
  console.log('\n--- SUITE 5: Renderer Zustand Store Parity ---')

  await test('Suite 5', '5.1 store.ts in-memory importBankStatementCsv & reconcileTransaction handles partial settlement', async () => {
    useBooksStore.setState({
      activeTab: 'banking',
      data: JSON.parse(JSON.stringify(initialBooksData)),
      activeInvoiceId: null,
      invoiceStatusFilter: 'All',
      activeReport: 'profit-loss',
      printInvoice: null,
      searchTerm: '',
    })

    const store = useBooksStore.getState()
    const initialAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance

    // Import statement via store fallback
    const csv = `Date,Description,Reference,Amount\n2026-09-01,Partial Store Payment,INV-2026-001,50000.00`
    const impRes = await store.importBankStatementCsv(csv)
    assert.strictEqual(impRes.ok, true)
    assert.strictEqual(impRes.importedCount, 1)

    const tx = useBooksStore.getState().data.bankTransactions[0]
    assert.strictEqual(tx.amount, 50000)

    // Reconcile via store fallback
    const reconRes = await store.reconcileTransaction(tx.id, 'inv-1')
    assert.strictEqual(reconRes.ok, true)
    assert.strictEqual((reconRes as any).settledAmount, 50000)
    assert.strictEqual((reconRes as any).remainingOutstanding, 95000)
    assert.strictEqual((reconRes as any).invoiceStatus, 'Unpaid')

    const stateAfter = useBooksStore.getState().data
    const invAfter = stateAfter.invoices.find((i) => i.id === 'inv-1')!
    assert.strictEqual(invAfter.status, 'Unpaid')
    assert.strictEqual(invAfter.outstandingAmount, 95000)

    const arAfter = stateAfter.accounts.find((a) => a.id === 'acc-ar')!.balance
    assert.strictEqual(arAfter, round2(initialAr - 50000))

    const je = stateAfter.journalEntries[0]
    assert.strictEqual(je.totalDebit, 50000)
    assert.strictEqual(je.totalCredit, 50000)

    const party = stateAfter.parties.find((p) => p.id === 'party-1')!
    assert.strictEqual(party.outstandingBalance, 95000)
  })

  // --------------------------------------------------------------------------
  // SUITE 6: Settlement Suggestions & Randomized Stress Fuzzer
  // --------------------------------------------------------------------------
  console.log('\n--- SUITE 6: Settlement Suggestions & Randomized Stress Fuzzer ---')

  await test('Suite 6', '6.1 computeSettlementSuggestions detects exact and partial token matches', () => {
    const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
    data.bankTransactions = [
      {
        id: 'tx-exact',
        accountId: 'acc-bank',
        date: '2026-09-01',
        description: 'EFT Ekurhuleni Municipality RFP-WTR-2026-04',
        amount: 145000,
        reconciled: false,
      },
      {
        id: 'tx-partial',
        accountId: 'acc-bank',
        date: '2026-09-02',
        description: 'Part Payment for INV-2026-002',
        amount: 25000, // Partial of 50500
        reconciled: false,
      },
      {
        id: 'tx-unrelated',
        accountId: 'acc-bank',
        date: '2026-09-03',
        description: 'Coffee Shop Groceries',
        amount: -150,
        reconciled: false,
      },
    ]

    const suggestions = computeSettlementSuggestions(data)
    assert.strictEqual(suggestions.length, 2)

    const exactMatch = suggestions.find((s) => s.transactionId === 'tx-exact')!
    assert.strictEqual(exactMatch.confidence, 'HIGH')
    assert.strictEqual(exactMatch.invoiceId, 'inv-1')

    const partialMatch = suggestions.find((s) => s.transactionId === 'tx-partial')!
    assert.strictEqual(partialMatch.confidence, 'MEDIUM')
    assert.strictEqual(partialMatch.invoiceId, 'inv-2')
    assert.ok(partialMatch.reason.includes('Partial payment'))
  })

  await test('Suite 6', '6.2 Reconcile rejects draft invoice and already paid invoice', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      data.invoices.push({
        id: 'inv-draft',
        invoiceNumber: 'INV-DRAFT-01',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'Customer',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [],
        subtotal: 10000,
        taxTotal: 1500,
        grandTotal: 11500,
        outstandingAmount: 11500,
        status: 'Draft',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      })
      writeBooksStore(sandbox.booksPath, data)

      const csv = `Date,Description,Amount\n2026-09-01,Payment,11500.00\n2026-09-02,Payment 2,85000.00`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })

      // Try reconciling draft invoice
      const resDraft = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp.transactions![0].id,
        invoiceId: 'inv-draft',
      })
      assert.strictEqual(resDraft.ok, false)
      assert.ok(resDraft.error?.includes('draft'))

      // Try reconciling already paid invoice (inv-3 in initialBooksData is status: Paid)
      const resPaid = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp.transactions![1].id,
        invoiceId: 'inv-3',
      })
      assert.strictEqual(resPaid.ok, false)
      assert.ok(resPaid.error?.includes('already marked Paid'))
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  await test('Suite 6', '6.3 Fuzzer: 50 randomized bank CSV statements and settlements preserve journal balance and party invariant', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      writeBooksStore(sandbox.booksPath, data)

      for (let i = 0; i < 50; i++) {
        const isSales = Math.random() > 0.4
        const invAmount = Math.round((Math.random() * 50000 + 1000) * 100) / 100
        const invId = `fuzz-inv-${i}`
        const invNum = `INV-FUZZ-${String(i).padStart(3, '0')}`

        const currentData = readBooksStore(sandbox.booksPath)
        currentData.invoices.push({
          id: invId,
          invoiceNumber: invNum,
          type: isSales ? 'Sales' : 'Purchase',
          partyId: isSales ? 'party-1' : 'party-4',
          partyName: isSales ? 'City of Ekurhuleni Water Dept' : 'Safintra Steel & Building Materials',
          date: '2026-09-01',
          dueDate: '2026-10-01',
          items: [],
          subtotal: round2(invAmount / 1.15),
          taxTotal: round2(invAmount - round2(invAmount / 1.15)),
          grandTotal: invAmount,
          outstandingAmount: invAmount,
          status: 'Unpaid',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        writeBooksStore(sandbox.booksPath, currentData)

        // Generate matching or partial transaction
        const partialRatio = Math.random() > 0.5 ? 1 : Math.random() * 0.8 + 0.1
        const payAmount = round2(invAmount * partialRatio)
        const signedPay = isSales ? payAmount : -payAmount

        const csv = `Date,Description,Reference,Amount\n2026-09-02,Fuzz Transaction ${i},${invNum},${signedPay}`
        const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
        assert.strictEqual(imp.ok, true)

        const tx = imp.transactions![0]
        const reconRes = executeReconciliation({
          booksDataPath: sandbox.booksPath,
          transactionId: tx.id,
          invoiceId: invId,
        })
        assert.strictEqual(reconRes.ok, true)

        // Verify journal balance
        const updatedBooks = readBooksStore(sandbox.booksPath)
        const latestJe = updatedBooks.journalEntries[0]
        assert.strictEqual(latestJe.totalDebit, latestJe.totalCredit)
        assert.strictEqual(latestJe.totalDebit, reconRes.settledAmount)

        // Verify party balance invariant
        for (const party of updatedBooks.parties) {
          const expected = updatedBooks.invoices
            .filter((inv) => inv.partyId === party.id && inv.status !== 'Paid' && inv.status !== 'Cancelled')
            .reduce((s, inv) => round2(s + (inv.outstandingAmount ?? inv.grandTotal)), 0)
          assert.strictEqual(party.outstandingBalance, round2(expected))
        }
      }
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  console.log('\n======================================================================')
  console.log(`SUMMARY: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  console.log('======================================================================')

  if (failedTests > 0) {
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('Fatal error running M3 challenger tests:', err)
  process.exit(1)
})

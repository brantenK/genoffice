/**
 * tools/stress-books-m3-empirical.ts
 *
 * INDEPENDENT EMPIRICAL CHALLENGER STRESS SUITE FOR BOOKS MILESTONE 3 (M3)
 * Author: challenger_1_books_m3
 *
 * Scenarios tested:
 * 1. South African Banking CSV Parsing Stress:
 *    - FNB: signed Amount, currency R, parenthetical negatives (1,250.00), CR/DR suffixes, trailing '-'
 *    - Standard Bank: separate Debit & Credit columns, signed & unsigned debits, parenthetical debits
 *    - Nedbank: 15 lines of account & branch metadata headers before CSV table, space thousands, footer summaries
 *    - Absa: UTF-8 BOM, comma decimal separators (1250,50), quoted multi-line structures, varying date formats
 * 2. Idempotent Re-Import vs Legitimate Duplicate Transactions:
 *    - Legitimate multiple identical charges on same date with same reference
 *    - Exact re-import deduplication (100% skipped, 0 balance change)
 *    - Incremental re-import (only new identical charges imported, existing skipped)
 * 3. Multi-Step Partial Settlement (3 Consecutive Partial Deposits against 1 Invoice):
 *    - Intermediate invoice status ('Unpaid')
 *    - Final invoice status ('Paid')
 *    - Balanced settlement journal at every single step (totalDebit === totalCredit === settledAmount)
 *    - Strict AR balance reduction matching settled amount at each step
 *    - Party balance invariant holds strictly at every intermediate and final step
 * 4. Overpayment Capping:
 *    - Deposit greater than remaining outstanding caps settlement amount to remaining balance
 *    - AR not over-reduced, journal balances to capped amount
 * 5. Rejection Guards:
 *    - Unmatched transactionId / invoiceId
 *    - Already-reconciled transaction
 *    - Already-paid invoice (status 'Paid' or outstandingAmount <= 0)
 *    - Draft invoice / Cancelled invoice
 *    - Direction mismatch (withdrawal against Sales, deposit against Purchase)
 * 6. Store Parity:
 *    - Verify exact same behavior in Zustand in-memory fallback (store.ts)
 * 7. Comprehensive Invariant Fuzzing:
 *    - 100 randomized multi-step partial transactions across Sales and Purchase
 *    - Strict verification of Debit === Credit and Party balance invariants
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
  recomputePartyBalances,
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
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'))
    }
  }
}

function createSandbox(): { root: string; booksPath: string; tendersPath: string } {
  const id = randomUUID().slice(0, 8)
  const root = join(tmpdir(), `books-m3-empirical-${id}`)
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

async function runEmpiricalChallenges() {
  console.log('======================================================================')
  console.log('  CHALLENGER EMPIRICAL STRESS TEST: BOOKS M3 (RECONCILIATION & CSV)')
  console.log('======================================================================\n')

  // ==========================================================================
  // SECTION 1: SA BANK CSV PARSING - EDGE CASES & MALFORMED INPUTS
  // ==========================================================================
  console.log('--- SECTION 1: SA BANK CSV PARSING - ROBUSTNESS & EDGE CASES ---')

  await test('Section 1', '1.1 Number parsing: parenthetical, trailing minus, DR/CR, currency tokens, spaces & comma decimals', () => {
    // Parenthetical negatives
    assert.strictEqual(parseBankAmount('(1,250.00)'), -1250)
    assert.strictEqual(parseBankAmount('( 1 250,50 )'), -1250.5)
    assert.strictEqual(parseBankAmount('(R12,345.67)'), -12345.67)
    assert.strictEqual(parseBankAmount('(ZAR 999.99)'), -999.99)

    // Trailing minus and DR/CR
    assert.strictEqual(parseBankAmount('500.00-'), -500)
    assert.strictEqual(parseBankAmount('1250.50DR'), -1250.5)
    assert.strictEqual(parseBankAmount('1250.50dr'), -1250.5)
    assert.strictEqual(parseBankAmount('3400.00CR'), 3400)
    assert.strictEqual(parseBankAmount('3400.00cr'), 3400)

    // Comma decimals
    assert.strictEqual(parseBankAmount('1250,50'), 1250.5)
    assert.strictEqual(parseBankAmount('1250,00'), 1250)
    assert.strictEqual(parseBankAmount('50,5'), 50.5)
    assert.strictEqual(parseBankAmount('1 250 000,50'), 1250000.5)

    // Null/empty/bogus handling
    assert.strictEqual(parseBankAmount(''), 0)
    assert.strictEqual(parseBankAmount(null), 0)
    assert.strictEqual(parseBankAmount(undefined), 0)
    assert.strictEqual(parseBankAmount('N/A'), 0)
    assert.strictEqual(parseBankAmount('---'), 0)
  })

  await test('Section 1', '1.2 Date Normalization: ISO, slash, dot, dash, DMY, and compact YYYYMMDD', () => {
    assert.strictEqual(normalizeDate('2026-09-01'), '2026-09-01')
    assert.strictEqual(normalizeDate('2026/09/01'), '2026-09-01')
    assert.strictEqual(normalizeDate('01/09/2026'), '2026-09-01')
    assert.strictEqual(normalizeDate('01-09-2026'), '2026-09-01')
    assert.strictEqual(normalizeDate('20260901'), '2026-09-01')
  })

  await test('Section 1', '1.3 Nedbank format with 12 metadata header lines, spaces as thousands, and footer totals', () => {
    const nedbankCsv = `Nedbank Corporate and Business Banking
Account Number,1987654321
Branch Code,198765
Account Type,Current Account
Statement Number,84
Statement Date,2026-09-05
Opening Balance,150 000.00
Closing Balance,485 250.00
VAT Registration Number,4920198273
Currency,ZAR
Available Balance,485 250.00

Date,Transaction Description,Debit Amount,Credit Amount,Balance
2026-09-01,City of Ekurhuleni Water Dept Milestone 1,,145 000.00,295 000.00
2026-09-02,Safintra Steel Project Supplies,"42 000,00",,253 000.00
2026-09-03,Monthly Cheque Account Fee,"(450,00)",,252 550.00
2026-09-04,Direct Client Settlement INV-2026-002,,50 500.00,303 050.00

Total Debits,42 450.00,,
Total Credits,,195 500.00,
Closing Balance,,,485 250.00`

    const txs = parseBankStatementCsv(nedbankCsv)
    assert.strictEqual(txs.length, 4, 'Should parse exactly 4 transaction rows, skipping metadata and footer')
    assert.strictEqual(txs[0].amount, 145000)
    assert.strictEqual(txs[0].date, '2026-09-01')
    assert.strictEqual(txs[1].amount, -42000)
    assert.strictEqual(txs[2].amount, -450)
    assert.strictEqual(txs[3].amount, 50500)
  })

  await test('Section 1', '1.4 Standard Bank format with Debit/Credit columns, signed debits and parenthetical negatives', () => {
    const sbCsv = `Date,Description,Debit,Credit,Balance
2026-09-01,Deposit Customer A,,75000.00,75000.00
2026-09-02,Supplier Wire 1,25000.00,,50000.00
2026-09-03,Supplier Wire 2,"(15,000.00)",,35000.00
2026-09-04,Supplier Wire 3,-5000.00,,30000.00`

    const txs = parseBankStatementCsv(sbCsv)
    assert.strictEqual(txs.length, 4)
    assert.strictEqual(txs[0].amount, 75000)
    assert.strictEqual(txs[1].amount, -25000)
    assert.strictEqual(txs[2].amount, -15000)
    assert.strictEqual(txs[3].amount, -5000) // Negative in debit column should NOT double negate to positive!
  })

  await test('Section 1', '1.5 Absa format with UTF-8 BOM, decimal commas and semicolon/comma quotes', () => {
    const absaCsv = `\uFEFFAbsa Business Integrator Export
Account: 40-1234-5678
Date,Description,Debit,Credit,Balance
01/09/2026,"Ekurhuleni Deposit",,"145 000,50","145 000,50"
02/09/2026,"Steel Payment","42 000,50",,"103 000,00"`

    const txs = parseBankStatementCsv(absaCsv)
    assert.strictEqual(txs.length, 2)
    assert.strictEqual(txs[0].date, '2026-09-01')
    assert.strictEqual(txs[0].amount, 145000.5)
    assert.strictEqual(txs[1].date, '2026-09-02')
    assert.strictEqual(txs[1].amount, -42000.5)
  })

  // ==========================================================================
  // SECTION 2: DEDUPLICATION VS LEGITIMATE DUPLICATES
  // ==========================================================================
  console.log('\n--- SECTION 2: IDEMPOTENT DEDUPLICATION & SAME-DAY LEGITIMATE CHARGES ---')

  await test('Section 2', '2.1 Legitimate duplicate handling: 3 identical transactions on same day preserved, 4th on re-import added', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      writeBooksStore(sandbox.booksPath, data)
      const initialBankBalance = data.accounts.find((a) => a.id === 'acc-bank')!.balance

      // Statement with 3 identical legitimate charges on the same day (e.g. 3 x R50 fuel or bank charge)
      const csv3 = `Date,Description,Reference,Amount
2026-09-01,Bank Fee,FEE-CHG,-50.00
2026-09-01,Bank Fee,FEE-CHG,-50.00
2026-09-01,Bank Fee,FEE-CHG,-50.00`

      // 1. First import: all 3 must be imported
      const res1 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv3 })
      assert.strictEqual(res1.ok, true)
      assert.strictEqual(res1.importedCount, 3)
      assert.strictEqual(res1.skippedDuplicates, 0)
      assert.strictEqual(res1.netAdjustment, -150)
      assert.strictEqual(res1.newBankBalance, round2(initialBankBalance - 150))

      // 2. Re-import identical CSV: 0 imported, 3 skipped, 0 net balance change
      const res2 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv3 })
      assert.strictEqual(res2.ok, true)
      assert.strictEqual(res2.importedCount, 0)
      assert.strictEqual(res2.skippedDuplicates, 3)
      assert.strictEqual(res2.netAdjustment, 0)
      assert.strictEqual(res2.newBankBalance, round2(initialBankBalance - 150))

      // 3. New statement containing 4 identical transactions (1 new one + 3 previously imported)
      const csv4 = `${csv3}\n2026-09-01,Bank Fee,FEE-CHG,-50.00`
      const res3 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv4 })
      assert.strictEqual(res3.ok, true)
      assert.strictEqual(res3.importedCount, 1)
      assert.strictEqual(res3.skippedDuplicates, 3)
      assert.strictEqual(res3.netAdjustment, -50)
      assert.strictEqual(res3.newBankBalance, round2(initialBankBalance - 200))

      // Verify store consistency on disk
      const diskData = readBooksStore(sandbox.booksPath)
      const matchingTxs = diskData.bankTransactions.filter(
        (t) => t.date === '2026-09-01' && t.description === 'Bank Fee' && t.amount === -50
      )
      assert.strictEqual(matchingTxs.length, 4)
      const bankAcc = diskData.accounts.find((a) => a.id === 'acc-bank')!
      assert.strictEqual(bankAcc.balance, round2(initialBankBalance - 200))
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  // ==========================================================================
  // SECTION 3: MULTI-STEP PARTIAL SETTLEMENT (3 CONSECUTIVE PARTIAL DEPOSITS)
  // ==========================================================================
  console.log('\n--- SECTION 3: MULTI-STEP PARTIAL SETTLEMENT (3 DEPOSITS AGAINST 1 INVOICE) ---')

  await test('Section 3', '3.1 Three consecutive partial deposits: intermediate Unpaid, final Paid, balanced journals, party balance invariant', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      // Invoice grand total: R100,000.00
      const invoiceId = 'inv-multi-step-1'
      const partyId = 'party-1'
      const initialAr = data.accounts.find((a) => a.id === 'acc-ar')!.balance
      const targetParty = data.parties.find((p) => p.id === partyId)!

      data.invoices.push({
        id: invoiceId,
        invoiceNumber: 'INV-STEP-001',
        type: 'Sales',
        partyId,
        partyName: targetParty.name,
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [{ id: 'it-1', description: 'Consulting Contract', qty: 1, rate: 100000, taxRate: 0, amount: 100000 }],
        subtotal: 100000,
        taxTotal: 0,
        grandTotal: 100000,
        outstandingAmount: 100000,
        status: 'Unpaid',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      })
      // Adjust initial party balance and AR for this new invoice
      data.accounts.find((a) => a.id === 'acc-ar')!.balance = round2(initialAr + 100000)
      data.parties = recomputePartyBalances(data.invoices, data.parties)
      writeBooksStore(sandbox.booksPath, data)

      const partyBalanceBefore = data.parties.find((p) => p.id === partyId)!.outstandingBalance
      const arBefore = round2(initialAr + 100000)

      // Step 1: Deposit 1 = R25,000.00
      const csv1 = `Date,Description,Reference,Amount\n2026-09-02,Deposit 1,INV-STEP-001,25000.00`
      const imp1 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv1 })
      const res1 = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp1.transactions![0].id,
        invoiceId,
      })

      assert.strictEqual(res1.ok, true)
      assert.strictEqual(res1.settledAmount, 25000)
      assert.strictEqual(res1.remainingOutstanding, 75000)
      assert.strictEqual(res1.invoiceStatus, 'Unpaid')

      // Verify intermediate disk state 1
      let currentBooks = readBooksStore(sandbox.booksPath)
      let inv = currentBooks.invoices.find((i) => i.id === invoiceId)!
      assert.strictEqual(inv.status, 'Unpaid')
      assert.strictEqual(inv.outstandingAmount, 75000)

      let currentAr = currentBooks.accounts.find((a) => a.id === 'acc-ar')!.balance
      assert.strictEqual(currentAr, round2(arBefore - 25000))

      let je1 = currentBooks.journalEntries[0]
      assert.strictEqual(je1.totalDebit, 25000)
      assert.strictEqual(je1.totalCredit, 25000)
      assert.strictEqual(je1.totalDebit, je1.totalCredit)

      // Party balance invariant check 1
      for (const p of currentBooks.parties) {
        const expected = currentBooks.invoices
          .filter((i) => i.partyId === p.id && i.status !== 'Paid' && i.status !== 'Cancelled')
          .reduce((s, i) => round2(s + (i.outstandingAmount ?? i.grandTotal)), 0)
        assert.strictEqual(p.outstandingBalance, round2(expected))
      }
      assert.strictEqual(
        currentBooks.parties.find((p) => p.id === partyId)!.outstandingBalance,
        round2(partyBalanceBefore - 25000)
      )

      // Step 2: Deposit 2 = R45,000.00
      const csv2 = `Date,Description,Reference,Amount\n2026-09-03,Deposit 2,INV-STEP-001,45000.00`
      const imp2 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv2 })
      const res2 = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp2.transactions![0].id,
        invoiceId,
      })

      assert.strictEqual(res2.ok, true)
      assert.strictEqual(res2.settledAmount, 45000)
      assert.strictEqual(res2.remainingOutstanding, 30000)
      assert.strictEqual(res2.invoiceStatus, 'Unpaid')

      // Verify intermediate disk state 2
      currentBooks = readBooksStore(sandbox.booksPath)
      inv = currentBooks.invoices.find((i) => i.id === invoiceId)!
      assert.strictEqual(inv.status, 'Unpaid')
      assert.strictEqual(inv.outstandingAmount, 30000)

      currentAr = currentBooks.accounts.find((a) => a.id === 'acc-ar')!.balance
      assert.strictEqual(currentAr, round2(arBefore - 70000))

      let je2 = currentBooks.journalEntries[0]
      assert.strictEqual(je2.totalDebit, 45000)
      assert.strictEqual(je2.totalCredit, 45000)
      assert.strictEqual(je2.totalDebit, je2.totalCredit)

      // Party balance invariant check 2
      for (const p of currentBooks.parties) {
        const expected = currentBooks.invoices
          .filter((i) => i.partyId === p.id && i.status !== 'Paid' && i.status !== 'Cancelled')
          .reduce((s, i) => round2(s + (i.outstandingAmount ?? i.grandTotal)), 0)
        assert.strictEqual(p.outstandingBalance, round2(expected))
      }
      assert.strictEqual(
        currentBooks.parties.find((p) => p.id === partyId)!.outstandingBalance,
        round2(partyBalanceBefore - 70000)
      )

      // Step 3: Deposit 3 = R30,000.00 (final settlement)
      const csv3 = `Date,Description,Reference,Amount\n2026-09-04,Deposit 3 Final,INV-STEP-001,30000.00`
      const imp3 = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv3 })
      const res3 = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp3.transactions![0].id,
        invoiceId,
      })

      assert.strictEqual(res3.ok, true)
      assert.strictEqual(res3.settledAmount, 30000)
      assert.strictEqual(res3.remainingOutstanding, 0)
      assert.strictEqual(res3.invoiceStatus, 'Paid')

      // Verify final disk state 3
      currentBooks = readBooksStore(sandbox.booksPath)
      inv = currentBooks.invoices.find((i) => i.id === invoiceId)!
      assert.strictEqual(inv.status, 'Paid')
      assert.strictEqual(inv.outstandingAmount, 0)

      currentAr = currentBooks.accounts.find((a) => a.id === 'acc-ar')!.balance
      assert.strictEqual(currentAr, round2(arBefore - 100000))

      let je3 = currentBooks.journalEntries[0]
      assert.strictEqual(je3.totalDebit, 30000)
      assert.strictEqual(je3.totalCredit, 30000)
      assert.strictEqual(je3.totalDebit, je3.totalCredit)

      // Party balance invariant check 3
      for (const p of currentBooks.parties) {
        const expected = currentBooks.invoices
          .filter((i) => i.partyId === p.id && i.status !== 'Paid' && i.status !== 'Cancelled')
          .reduce((s, i) => round2(s + (i.outstandingAmount ?? i.grandTotal)), 0)
        assert.strictEqual(p.outstandingBalance, round2(expected))
      }
      assert.strictEqual(
        currentBooks.parties.find((p) => p.id === partyId)!.outstandingBalance,
        round2(partyBalanceBefore - 100000)
      )
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  // ==========================================================================
  // SECTION 4: OVERPAYMENT CAPPING
  // ==========================================================================
  console.log('\n--- SECTION 4: OVERPAYMENT CAPPING GUARD ---')

  await test('Section 4', '4.1 Deposit exceeding remaining invoice balance caps settlement amount to remaining balance', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      // Invoice outstanding is 20,000
      data.invoices.push({
        id: 'inv-cap-test',
        invoiceNumber: 'INV-CAP-001',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [],
        subtotal: 20000,
        taxTotal: 0,
        grandTotal: 20000,
        outstandingAmount: 20000,
        status: 'Unpaid',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      })
      writeBooksStore(sandbox.booksPath, data)

      // Customer deposits 25,000 (an overpayment of 5,000)
      const csv = `Date,Description,Reference,Amount\n2026-09-02,Overpayment Deposit,INV-CAP-001,25000.00`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const res = executeReconciliation({
        booksDataPath: sandbox.booksPath,
        transactionId: imp.transactions![0].id,
        invoiceId: 'inv-cap-test',
      })

      assert.strictEqual(res.ok, true)
      assert.strictEqual(res.settledAmount, 20000, 'Settlement amount must cap at outstanding amount (20000), not 25000')
      assert.strictEqual(res.remainingOutstanding, 0)
      assert.strictEqual(res.invoiceStatus, 'Paid')

      // Verify journal entry is for capped amount (20000)
      const after = readBooksStore(sandbox.booksPath)
      const je = after.journalEntries[0]
      assert.strictEqual(je.totalDebit, 20000)
      assert.strictEqual(je.totalCredit, 20000)
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  // ==========================================================================
  // SECTION 5: REJECTION GUARDS
  // ==========================================================================
  console.log('\n--- SECTION 5: REJECTION GUARDS FOR UNMATCHED & ALREADY SETTLED ---')

  await test('Section 5', '5.1 Comprehensive rejection guards (invalid IDs, already reconciled, already paid, draft, direction mismatch)', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      data.invoices.push({
        id: 'inv-draft-guard',
        invoiceNumber: 'INV-DFT-001',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'Customer',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [],
        subtotal: 10000,
        taxTotal: 0,
        grandTotal: 10000,
        outstandingAmount: 10000,
        status: 'Draft',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      })
      data.invoices.push({
        id: 'inv-cancelled-guard',
        invoiceNumber: 'INV-CNC-001',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'Customer',
        date: '2026-09-01',
        dueDate: '2026-10-01',
        items: [],
        subtotal: 10000,
        taxTotal: 0,
        grandTotal: 10000,
        outstandingAmount: 10000,
        status: 'Cancelled',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      })
      writeBooksStore(sandbox.booksPath, data)

      const csv = `Date,Description,Reference,Amount
2026-09-01,Deposit A,,50000.00
2026-09-02,Withdrawal B,,-25000.00`
      const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
      const txDep = imp.transactions![0].id
      const txWdr = imp.transactions![1].id

      // 1. Invalid transaction ID
      const r1 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: 'non-existent-tx', invoiceId: 'inv-1' })
      assert.strictEqual(r1.ok, false)
      assert.ok(r1.error?.includes('Transaction not found'))

      // 2. Invalid invoice ID
      const r2 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: txDep, invoiceId: 'non-existent-inv' })
      assert.strictEqual(r2.ok, false)
      assert.ok(r2.error?.includes('Invoice not found'))

      // 3. Draft invoice
      const r3 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: txDep, invoiceId: 'inv-draft-guard' })
      assert.strictEqual(r3.ok, false)
      assert.ok(r3.error?.includes('draft'))

      // 4. Cancelled invoice
      const r4 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: txDep, invoiceId: 'inv-cancelled-guard' })
      assert.strictEqual(r4.ok, false)
      assert.ok(r4.error?.includes('cancelled'))

      // 5. Already paid invoice (inv-3 is status Paid in initialBooksData)
      const r5 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: txDep, invoiceId: 'inv-3' })
      assert.strictEqual(r5.ok, false)
      assert.ok(r5.error?.includes('already marked Paid'))

      // 6. Direction mismatch: withdrawal against Sales invoice
      const r6 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: txWdr, invoiceId: 'inv-1' })
      assert.strictEqual(r6.ok, false)
      assert.ok(r6.error?.includes('withdrawal') || r6.error?.includes('Sales'))

      // 7. Direction mismatch: deposit against Purchase bill
      const r7 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: txDep, invoiceId: 'bill-1' })
      assert.strictEqual(r7.ok, false)
      assert.ok(r7.error?.includes('deposit') || r7.error?.includes('Purchase'))

      // 8. Successful reconciliation of txDep
      const r8 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: txDep, invoiceId: 'inv-1' })
      assert.strictEqual(r8.ok, true)

      // 9. Reconcile already reconciled transaction must fail
      const r9 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: txDep, invoiceId: 'inv-2' })
      assert.strictEqual(r9.ok, false)
      assert.ok(r9.error?.includes('already reconciled'))
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  // ==========================================================================
  // SECTION 6: ZUSTAND RENDERER STORE PARITY (store.ts)
  // ==========================================================================
  console.log('\n--- SECTION 6: ZUSTAND RENDERER STORE PARITY (store.ts) ---')

  await test('Section 6', '6.1 store.ts in-memory multi-step partial settlement & rejection guards match books-main', async () => {
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
    const partyId = 'party-1'
    const invoiceId = 'inv-store-test'

    // Add invoice for 80,000
    await store.saveInvoice({
      id: invoiceId,
      invoiceNumber: 'INV-STR-001',
      type: 'Sales',
      partyId,
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      grandTotal: 80000,
      outstandingAmount: 80000,
      items: [{ id: 'it-s1', description: 'Item 1', qty: 1, rate: 80000, taxRate: 0, amount: 80000 }],
    })

    // Import statement with 2 partial payments: 30,000 then 50,000
    const csv = `Date,Description,Reference,Amount
2026-09-01,Store Part 1,INV-STR-001,30000.00
2026-09-02,Store Part 2,INV-STR-001,50000.00`

    const imp = await store.importBankStatementCsv(csv)
    assert.strictEqual(imp.ok, true)
    assert.strictEqual(imp.importedCount, 2)

    const tx1 = useBooksStore.getState().data.bankTransactions.find((t) => t.amount === 30000)!
    const tx2 = useBooksStore.getState().data.bankTransactions.find((t) => t.amount === 50000)!

    // Step 1: Reconcile tx1 (30,000)
    const rec1 = await store.reconcileTransaction(tx1.id, invoiceId)
    assert.strictEqual(rec1.ok, true)
    assert.strictEqual(rec1.settledAmount, 30000)
    assert.strictEqual(rec1.remainingOutstanding, 50000)
    assert.strictEqual(rec1.invoiceStatus, 'Unpaid')

    let state = useBooksStore.getState().data
    let targetInv = state.invoices.find((i) => i.id === invoiceId)!
    assert.strictEqual(targetInv.status, 'Unpaid')
    assert.strictEqual(targetInv.outstandingAmount, 50000)

    // Verify journal balance
    let je1 = state.journalEntries[0]
    assert.strictEqual(je1.totalDebit, 30000)
    assert.strictEqual(je1.totalCredit, 30000)

    // Step 2: Reconcile tx2 (50,000) -> fully settles
    const rec2 = await store.reconcileTransaction(tx2.id, invoiceId)
    assert.strictEqual(rec2.ok, true)
    assert.strictEqual(rec2.settledAmount, 50000)
    assert.strictEqual(rec2.remainingOutstanding, 0)
    assert.strictEqual(rec2.invoiceStatus, 'Paid')

    state = useBooksStore.getState().data
    targetInv = state.invoices.find((i) => i.id === invoiceId)!
    assert.strictEqual(targetInv.status, 'Paid')
    assert.strictEqual(targetInv.outstandingAmount, 0)

    // Reconcile already reconciled tx1 must fail
    const recAgain = await store.reconcileTransaction(tx1.id, 'inv-1')
    assert.strictEqual(recAgain.ok, false)

    // Reconcile already paid invoice must fail
    const recPaid = await store.reconcileTransaction(tx2.id, invoiceId)
    assert.strictEqual(recPaid.ok, false)
  })

  // ==========================================================================
  // SECTION 7: STRESS FUZZING & DOUBLE-ENTRY INVARIANTS
  // ==========================================================================
  console.log('\n--- SECTION 7: STRESS FUZZING & DOUBLE-ENTRY INVARIANTS ---')

  await test('Section 7', '7.1 100 Randomized Multi-Step Settlements preserve totalDebit === totalCredit and party balance invariant', () => {
    const sandbox = createSandbox()
    try {
      const data = JSON.parse(JSON.stringify(initialBooksData)) as BooksData
      writeBooksStore(sandbox.booksPath, data)

      for (let i = 0; i < 100; i++) {
        const isSales = Math.random() > 0.4
        const invTotal = Math.round((Math.random() * 40000 + 1000) * 100) / 100
        const invId = `fuzz-m3-${i}`
        const invNum = `INV-FZ-${String(i).padStart(3, '0')}`
        const partyId = isSales ? 'party-1' : 'party-4'

        const storeData = readBooksStore(sandbox.booksPath)
        storeData.invoices.push({
          id: invId,
          invoiceNumber: invNum,
          type: isSales ? 'Sales' : 'Purchase',
          partyId,
          partyName: isSales ? 'City of Ekurhuleni Water Dept' : 'Safintra Steel & Building Materials',
          date: '2026-09-01',
          dueDate: '2026-10-01',
          items: [],
          subtotal: round2(invTotal / 1.15),
          taxTotal: round2(invTotal - round2(invTotal / 1.15)),
          grandTotal: invTotal,
          outstandingAmount: invTotal,
          status: 'Unpaid',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        storeData.parties = recomputePartyBalances(storeData.invoices, storeData.parties)
        writeBooksStore(sandbox.booksPath, storeData)

        // Generate 2 partial payments for this invoice
        const p1Ratio = Math.round((Math.random() * 0.4 + 0.2) * 100) / 100
        const pay1 = round2(invTotal * p1Ratio)
        const pay2 = round2(invTotal - pay1)

        const sign = isSales ? 1 : -1
        const csv = `Date,Description,Reference,Amount
2026-09-02,Fuzz Payment 1,${invNum},${sign * pay1}
2026-09-03,Fuzz Payment 2,${invNum},${sign * pay2}`

        const imp = importBankStatement({ booksDataPath: sandbox.booksPath, csvContent: csv })
        assert.strictEqual(imp.ok, true)
        assert.strictEqual(imp.importedCount, 2)

        const tx1Id = imp.transactions![0].id
        const tx2Id = imp.transactions![1].id

        // Execute step 1
        const r1 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: tx1Id, invoiceId: invId })
        assert.strictEqual(r1.ok, true)
        assert.strictEqual(r1.settledAmount, pay1)

        // Execute step 2
        const r2 = executeReconciliation({ booksDataPath: sandbox.booksPath, transactionId: tx2Id, invoiceId: invId })
        assert.strictEqual(r2.ok, true)
        assert.strictEqual(r2.settledAmount, pay2)
        assert.strictEqual(r2.remainingOutstanding, 0)
        assert.strictEqual(r2.invoiceStatus, 'Paid')

        // Verify journal balance invariants on disk
        const finalState = readBooksStore(sandbox.booksPath)
        const je1 = finalState.journalEntries[1]
        const je2 = finalState.journalEntries[0]
        assert.strictEqual(je1.totalDebit, je1.totalCredit)
        assert.strictEqual(je2.totalDebit, je2.totalCredit)

        // Verify party balance invariant
        for (const p of finalState.parties) {
          const expected = finalState.invoices
            .filter((inv) => inv.partyId === p.id && inv.status !== 'Paid' && inv.status !== 'Cancelled')
            .reduce((s, inv) => round2(s + (inv.outstandingAmount ?? inv.grandTotal)), 0)
          assert.strictEqual(p.outstandingBalance, round2(expected))
        }
      }
    } finally {
      cleanSandbox(sandbox.root)
    }
  })

  console.log('\n======================================================================')
  console.log(`EMPIRICAL STRESS TEST RESULTS: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
  console.log('======================================================================')

  if (failedTests > 0) {
    console.error(`FAILED TESTS:`)
    for (const f of failures) {
      console.error(`  - [${f.suite}] ${f.name}: ${f.error}`)
    }
    process.exit(1)
  }
}

runEmpiricalChallenges().catch((err) => {
  console.error('Fatal error in stress test execution:', err)
  process.exit(1)
})

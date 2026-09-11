/**
 * tools/verify-books-m1-challenger.ts
 *
 * EMPIRICAL CHALLENGER TEST SUITE FOR BOOKS MILESTONE 1 (M1)
 *
 * Tests:
 * 1. Accounting math edge cases (apps/books/src/shared/accounting.ts)
 *    - Floating point precision: .005, .004, .044, .999, negative zeroes, strings, NaNs
 *    - calculateInvoiceTotals on multi-item invoices with different tax rates (subtotal + taxTotal === grandTotal)
 *    - createSalesInvoiceJournal and createPurchaseBillJournal on multi-item invoices (totalDebit === totalCredit)
 *    - createSettlementJournal for sales and purchase settlements (debits == credits == settledAmount)
 *    - 1,000-iteration randomized fuzz/stress generator for invoice balancing invariants
 * 2. Chart of Accounts invariants
 *    - CORE_ACCOUNTS and initialBooksData.accounts have all 22 standard accounts + 8 root/group accounts (30 total)
 *    - All root group accounts have parentId === null
 *    - No account points to a non-existent parentId (no dangling parent pointers)
 *    - Acyclicity and group flags
 * 3. Persistence & corrupt recovery
 *    - Malformed JSON creates BOTH .corrupted.bak and .corrupt-[timestamp] backups
 *    - Fallback data retains all 30 valid core accounts
 *    - Consecutive corruptions preserve timestamped backups
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert'

// Direct imports from TypeScript sources
import {
  round2,
  calculateInvoiceTotals,
  createSalesInvoiceJournal,
  createPurchaseBillJournal,
  createSettlementJournal,
  recomputePartyBalances,
} from '../apps/books/src/shared/accounting'

import {
  CORE_ACCOUNTS,
  CURRENT_BOOKS_SCHEMA_VERSION,
  DEFAULT_BOOK_SETTINGS,
  migrateAndValidateBooks,
  readBooksStore,
  writeBooksStore,
} from '../apps/books/src/main/books-main'

import { initialBooksData } from '../apps/books/src/renderer/src/mock/initialData'
import type { Account, Invoice, InvoiceItem, Party } from '../apps/books/src/shared/types'

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures: Array<{ suite: string; name: string; error: string; stack?: string }> = []

function test(suite: string, name: string, fn: () => void) {
  totalTests++
  try {
    fn()
    passedTests++
    console.log(`  [PASS] ${name}`)
  } catch (err: any) {
    failedTests++
    failures.push({ suite, name, error: err?.message || String(err), stack: err?.stack })
    console.error(`  [FAIL] ${name}: ${err?.message || String(err)}`)
  }
}

function createSandbox() {
  const dir = join(tmpdir(), `challenger-books-m1-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  const booksPath = join(dir, 'books', 'books-data.json')
  return {
    dir,
    booksPath,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

console.log('======================================================================')
console.log('   EMPIRICAL CHALLENGER: BOOKS MILESTONE 1 (M1) AUDIT HARNESS')
console.log('======================================================================\n')

// ============================================================================
// SUITE 1: ACCOUNTING MATH EDGE CASES
// ============================================================================
console.log('--- SUITE 1: Accounting Math Engine Edge Cases ---')

test('Suite 1', '1.1 round2 floating-point precision on sub-cent amounts (.005, .004, .044, .999)', () => {
  // Test .004 -> 0, .044 -> 0.04
  assert.strictEqual(round2(0.004), 0, '0.004 rounds to 0')
  assert.strictEqual(round2(0.044), 0.04, '0.044 rounds to 0.04')
  assert.strictEqual(round2(1.044), 1.04, '1.044 rounds to 1.04')

  // Test .999 -> 1 or 2
  assert.strictEqual(round2(0.999), 1, '0.999 rounds to 1')
  assert.strictEqual(round2(1.999), 2, '1.999 rounds to 2')
  assert.strictEqual(round2(19.999), 20, '19.999 rounds to 20')

  // Test .005
  assert.strictEqual(round2(0.005), 0.01, '0.005 rounds to 0.01')
  assert.strictEqual(round2(0.015), 0.02, '0.015 rounds to 0.02')
  assert.strictEqual(round2(0.025), 0.03, '0.025 rounds to 0.03')
  assert.strictEqual(round2(0.035), 0.04, '0.035 rounds to 0.04')
  assert.strictEqual(round2(0.045), 0.05, '0.045 rounds to 0.05')

  // Documented IEEE-754 boundary behavior:
  // 1.005 * 100 in IEEE-754 double precision is 100.49999999999999, so Math.round yields 100 -> 1.00
  // 1.045 * 100 is 104.50000000000001, so Math.round yields 105 -> 1.05
  assert.strictEqual(round2(1.005), 1.0, 'IEEE-754 1.005 behavior')
  assert.strictEqual(round2(1.045), 1.05, 'IEEE-754 1.045 behavior')

  // Standard float addition drift
  assert.strictEqual(round2(0.1 + 0.2), 0.3, '0.1 + 0.2 rounded to 0.3')
  assert.strictEqual(round2(0.7 + 0.1), 0.8, '0.7 + 0.1 rounded to 0.8')
  assert.strictEqual(round2(1.0000000000000002), 1, 'Micro-epsilon rounds to 1')
})

test('Suite 1', '1.2 round2 negative zero and signed zero handling', () => {
  // Test -0 normalization: Object.is(-0, 0) is false in JS!
  const resNegZero = round2(-0)
  assert.strictEqual(Object.is(resNegZero, -0), false, 'round2(-0) must not be -0')
  assert.strictEqual(Object.is(resNegZero, 0), true, 'round2(-0) must strictly be +0')
  assert.strictEqual(1 / resNegZero, Infinity, '1 / round2(-0) must be Infinity, not -Infinity')

  // Test tiny negative numbers rounding to 0
  const resTinyNeg = round2(-0.0001)
  assert.strictEqual(Object.is(resTinyNeg, 0), true, 'round2(-0.0001) must normalize to +0')
  assert.strictEqual(1 / resTinyNeg, Infinity, '1 / round2(-0.0001) must be Infinity')

  const resStringNegZero = round2('-0' as any)
  assert.strictEqual(Object.is(resStringNegZero, 0), true, 'round2("-0") must normalize to +0')
})

test('Suite 1', '1.3 round2 edge inputs: NaN, null, undefined, strings, booleans', () => {
  assert.strictEqual(round2(NaN), 0, 'NaN returns 0')
  assert.strictEqual(round2(null as any), 0, 'null returns 0')
  assert.strictEqual(round2(undefined as any), 0, 'undefined returns 0')
  assert.strictEqual(round2('123.456' as any), 123.46, 'Numeric string parsed and rounded')
  assert.strictEqual(round2('invalid' as any), 0, 'Invalid string returns 0')
  assert.strictEqual(round2(Infinity), Infinity, 'Infinity propagates as Infinity')
  assert.strictEqual(round2(-Infinity), -Infinity, '-Infinity propagates as -Infinity')
})

test('Suite 1', '1.4 calculateInvoiceTotals on multi-item invoices with different tax rates', () => {
  const items: InvoiceItem[] = [
    { id: '1', itemCode: 'A', description: 'Standard VAT 15%', qty: 3, rate: 33.33, taxRate: 15, amount: 99.99 },
    { id: '2', itemCode: 'B', description: 'Zero-rated VAT 0%', qty: 10, rate: 50.50, taxRate: 0, amount: 505.00 },
    { id: '3', itemCode: 'C', description: 'Reduced VAT 5%', qty: 2, rate: 125.40, taxRate: 5, amount: 250.80 },
    { id: '4', itemCode: 'D', description: 'Exempt VAT 0%', qty: 1, rate: 1000.00, taxRate: 0, amount: 1000.00 },
  ]

  const totals = calculateInvoiceTotals(items)

  // Subtotal = round2(99.99 + 505.00 + 250.80 + 1000.00) = 1855.79
  assert.strictEqual(totals.subtotal, 1855.79, 'Subtotal calculation')
  // TaxTotal = round2(round2(99.99*0.15) + 0 + round2(250.80*0.05) + 0) = round2(15.00 + 0 + 12.54 + 0) = 27.54
  assert.strictEqual(totals.taxTotal, 27.54, 'TaxTotal calculation')
  // GrandTotal = round2(1855.79 + 27.54) = 1883.33
  assert.strictEqual(totals.grandTotal, 1883.33, 'GrandTotal calculation')

  // Strict invariant: subtotal + taxTotal === grandTotal
  assert.strictEqual(round2(totals.subtotal + totals.taxTotal), totals.grandTotal, 'Strict invariant: subtotal + taxTotal === grandTotal')
})

test('Suite 1', '1.5 calculateInvoiceTotals with fractional cents and quantity x rate multiplication', () => {
  const items: InvoiceItem[] = [
    // 3 * 33.333 = 99.999 -> lineAmt = 100.00, tax = 15.00
    { id: '1', itemCode: 'A', description: 'Fractional Rate 1', qty: 3, rate: 33.333, taxRate: 15 },
    // 7 * 14.285 = 99.995 -> lineAmt = 100.00, tax = 15.00
    { id: '2', itemCode: 'B', description: 'Fractional Rate 2', qty: 7, rate: 14.285, taxRate: 15 },
    // 11 * 9.091 = 100.001 -> lineAmt = 100.00, tax = 15.00
    { id: '3', itemCode: 'C', description: 'Fractional Rate 3', qty: 11, rate: 9.091, taxRate: 15 },
  ]

  const totals = calculateInvoiceTotals(items)
  assert.strictEqual(totals.subtotal, 300.00)
  assert.strictEqual(totals.taxTotal, 45.00)
  assert.strictEqual(totals.grandTotal, 345.00)
  assert.strictEqual(totals.subtotal + totals.taxTotal, totals.grandTotal)
})

test('Suite 1', '1.6 calculateInvoiceTotals empty and invalid inputs', () => {
  assert.deepStrictEqual(calculateInvoiceTotals([]), { subtotal: 0, taxTotal: 0, grandTotal: 0 })
  assert.deepStrictEqual(calculateInvoiceTotals(null as any), { subtotal: 0, taxTotal: 0, grandTotal: 0 })
  assert.deepStrictEqual(calculateInvoiceTotals(undefined as any), { subtotal: 0, taxTotal: 0, grandTotal: 0 })
})

test('Suite 1', '1.7 createSalesInvoiceJournal multi-item multi-account balanced journal invariant', () => {
  const items: InvoiceItem[] = [
    { id: '1', itemCode: 'SRV1', description: 'Consulting', accountId: 'acc-consult', qty: 5, rate: 1000, taxRate: 15 },
    { id: '2', itemCode: 'SRV2', description: 'Contracting', accountId: 'acc-sales', qty: 2, rate: 10000, taxRate: 15 },
  ]
  const totals = calculateInvoiceTotals(items)

  const invoice: Invoice = {
    id: 'inv-test-sales-1',
    invoiceNumber: 'INV-2026-TEST-01',
    type: 'Sales',
    partyId: 'party-cust-1',
    partyName: 'City of Ekurhuleni',
    date: '2026-09-01',
    dueDate: '2026-09-30',
    items,
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    outstandingAmount: totals.grandTotal,
    status: 'Unpaid',
  }

  const journal = createSalesInvoiceJournal(invoice, CORE_ACCOUNTS)

  // Check structure
  assert(journal.entryNumber.startsWith('JE-2026-'), 'Valid entry number generated')
  assert.strictEqual(journal.posted, true)

  // Verify journal items
  const arItem = journal.items.find((i) => i.accountId === 'acc-ar')
  assert(arItem, 'AR debit item must exist')
  assert.strictEqual(arItem.debit, totals.grandTotal, 'AR debited for grandTotal')
  assert.strictEqual(arItem.credit, 0)

  const consultItem = journal.items.find((i) => i.accountId === 'acc-consult')
  assert(consultItem, 'acc-consult credit item must exist')
  assert.strictEqual(consultItem.credit, 5000, 'acc-consult credited for line subtotal')
  assert.strictEqual(consultItem.debit, 0)

  const salesItem = journal.items.find((i) => i.accountId === 'acc-sales')
  assert(salesItem, 'acc-sales credit item must exist')
  assert.strictEqual(salesItem.credit, 20000, 'acc-sales credited for line subtotal')
  assert.strictEqual(salesItem.debit, 0)

  const vatItem = journal.items.find((i) => i.accountId === 'acc-vat')
  assert(vatItem, 'acc-vat credit item must exist')
  assert.strictEqual(vatItem.credit, totals.taxTotal, 'acc-vat credited for taxTotal')
  assert.strictEqual(vatItem.debit, 0)

  // Invariant: totalDebit === totalCredit === grandTotal
  assert.strictEqual(journal.totalDebit, journal.totalCredit, 'totalDebit === totalCredit')
  assert.strictEqual(journal.totalDebit, totals.grandTotal, 'totalDebit === grandTotal')

  // Verify actual item sum equals totalDebit and totalCredit
  const itemDebitSum = round2(journal.items.reduce((s, it) => s + it.debit, 0))
  const itemCreditSum = round2(journal.items.reduce((s, it) => s + it.credit, 0))
  assert.strictEqual(itemDebitSum, journal.totalDebit, 'Items debit sum === totalDebit')
  assert.strictEqual(itemCreditSum, journal.totalCredit, 'Items credit sum === totalCredit')
})

test('Suite 1', '1.8 createSalesInvoiceJournal zero tax invoice does not post VAT entry', () => {
  const items: InvoiceItem[] = [
    { id: '1', itemCode: 'EXP', description: 'Zero Tax Item', accountId: 'acc-sales', qty: 1, rate: 5000, taxRate: 0 },
  ]
  const totals = calculateInvoiceTotals(items)

  const invoice: Invoice = {
    id: 'inv-zero-tax',
    invoiceNumber: 'INV-2026-ZERO-01',
    type: 'Sales',
    partyId: 'party-cust-1',
    partyName: 'Exempt Customer',
    date: '2026-09-01',
    dueDate: '2026-09-30',
    items,
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    outstandingAmount: totals.grandTotal,
    status: 'Unpaid',
  }

  const journal = createSalesInvoiceJournal(invoice, CORE_ACCOUNTS)
  const vatItem = journal.items.find((i) => i.accountId === 'acc-vat' || i.accountId === 'acc-vat-out')
  assert.strictEqual(vatItem, undefined, 'Zero tax invoice must not include VAT journal line')
  assert.strictEqual(journal.totalDebit, 5000)
  assert.strictEqual(journal.totalCredit, 5000)
})

test('Suite 1', '1.9 createPurchaseBillJournal multi-item multi-account balanced journal invariant', () => {
  const items: InvoiceItem[] = [
    { id: '1', itemCode: 'MAT', description: 'Raw Materials', accountId: 'acc-materials', qty: 100, rate: 45.50, taxRate: 15 },
    { id: '2', itemCode: 'UTL', description: 'Site Electricity', accountId: 'acc-utilities', qty: 1, rate: 1200.00, taxRate: 15 },
  ]
  const totals = calculateInvoiceTotals(items)

  const bill: Invoice = {
    id: 'bill-test-purchase-1',
    invoiceNumber: 'BILL-2026-TEST-01',
    type: 'Purchase',
    partyId: 'party-supp-1',
    partyName: 'Safintra Steel',
    date: '2026-09-02',
    dueDate: '2026-10-02',
    items,
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    outstandingAmount: totals.grandTotal,
    status: 'Unpaid',
  }

  const journal = createPurchaseBillJournal(bill, CORE_ACCOUNTS)

  // Verify journal items
  const matItem = journal.items.find((i) => i.accountId === 'acc-materials')
  assert(matItem, 'acc-materials debit item must exist')
  assert.strictEqual(matItem.debit, 4550, 'Materials debited for line subtotal')
  assert.strictEqual(matItem.credit, 0)

  const utlItem = journal.items.find((i) => i.accountId === 'acc-utilities')
  assert(utlItem, 'acc-utilities debit item must exist')
  assert.strictEqual(utlItem.debit, 1200, 'Utilities debited for line subtotal')
  assert.strictEqual(utlItem.credit, 0)

  const vatInItem = journal.items.find((i) => i.accountId === 'acc-vat-in' || i.accountId === 'acc-vat')
  assert(vatInItem, 'VAT input debit item must exist')
  assert.strictEqual(vatInItem.debit, totals.taxTotal, 'VAT input debited for taxTotal')
  assert.strictEqual(vatInItem.credit, 0)

  const apItem = journal.items.find((i) => i.accountId === 'acc-ap')
  assert(apItem, 'Accounts Payable credit item must exist')
  assert.strictEqual(apItem.credit, totals.grandTotal, 'AP credited for grandTotal')
  assert.strictEqual(apItem.debit, 0)

  // Invariant: totalDebit === totalCredit === grandTotal
  assert.strictEqual(journal.totalDebit, journal.totalCredit, 'totalDebit === totalCredit')
  assert.strictEqual(journal.totalDebit, totals.grandTotal, 'totalDebit === grandTotal')

  // Verify item sums
  const itemDebitSum = round2(journal.items.reduce((s, it) => s + it.debit, 0))
  const itemCreditSum = round2(journal.items.reduce((s, it) => s + it.credit, 0))
  assert.strictEqual(itemDebitSum, journal.totalDebit, 'Items debit sum === totalDebit')
  assert.strictEqual(itemCreditSum, journal.totalCredit, 'Items credit sum === totalCredit')
})

test('Suite 1', '1.10 createSettlementJournal for Sales and Purchase settlements', () => {
  const salesInv: Invoice = {
    id: 'inv-settle-sales',
    invoiceNumber: 'INV-2026-SETTLE-01',
    type: 'Sales',
    partyId: 'party-cust-1',
    partyName: 'City of Ekurhuleni',
    date: '2026-09-01',
    dueDate: '2026-09-30',
    subtotal: 10000,
    taxTotal: 1500,
    grandTotal: 11500,
    outstandingAmount: 11500,
    status: 'Unpaid',
  }

  // Full settlement for sales invoice (options object style)
  const salesJournal = createSettlementJournal({
    invoice: salesInv,
    accounts: CORE_ACCOUNTS,
    amount: 11500,
    bankAccountId: 'acc-bank',
  })

  assert.strictEqual(salesJournal.totalDebit, 11500)
  assert.strictEqual(salesJournal.totalCredit, 11500)
  const bankDebit = salesJournal.items.find((i) => i.accountId === 'acc-bank')
  assert(bankDebit, 'Bank debited for sales receipt')
  assert.strictEqual(bankDebit.debit, 11500)
  assert.strictEqual(bankDebit.credit, 0)
  const arCredit = salesJournal.items.find((i) => i.accountId === 'acc-ar')
  assert(arCredit, 'AR credited for sales receipt')
  assert.strictEqual(arCredit.credit, 11500)
  assert.strictEqual(arCredit.debit, 0)

  // Partial settlement for purchase bill (positional argument style)
  const purchaseBill: Invoice = {
    id: 'bill-settle-purchase',
    invoiceNumber: 'BILL-2026-SETTLE-01',
    type: 'Purchase',
    partyId: 'party-supp-1',
    partyName: 'Safintra Steel',
    date: '2026-09-01',
    dueDate: '2026-09-30',
    subtotal: 5000,
    taxTotal: 750,
    grandTotal: 5750,
    outstandingAmount: 5750,
    status: 'Unpaid',
  }

  const purchaseJournal = createSettlementJournal(
    purchaseBill,
    CORE_ACCOUNTS,
    2500.50, // Partial payment
    undefined,
    undefined,
    'acc-bank',
    'Partial supplier settlement'
  )

  assert.strictEqual(purchaseJournal.totalDebit, 2500.50)
  assert.strictEqual(purchaseJournal.totalCredit, 2500.50)
  const apDebit = purchaseJournal.items.find((i) => i.accountId === 'acc-ap')
  assert(apDebit, 'AP debited for purchase disbursement')
  assert.strictEqual(apDebit.debit, 2500.50)
  assert.strictEqual(apDebit.credit, 0)
  const bankCredit = purchaseJournal.items.find((i) => i.accountId === 'acc-bank')
  assert(bankCredit, 'Bank credited for purchase disbursement')
  assert.strictEqual(bankCredit.credit, 2500.50)
  assert.strictEqual(bankCredit.debit, 0)
})

test('Suite 1', '1.11 recomputePartyBalances strict invariant', () => {
  const parties: Party[] = [
    { id: 'party-1', name: 'Cust 1', type: 'Customer', outstandingBalance: 999999 }, // Corrupted balance
    { id: 'party-2', name: 'Cust 2', type: 'Customer', outstandingBalance: 0 },
  ]
  const invoices: Invoice[] = [
    { id: 'i-1', invoiceNumber: 'I1', type: 'Sales', partyId: 'party-1', grandTotal: 1000, outstandingAmount: 500, status: 'Unpaid' },
    { id: 'i-2', invoiceNumber: 'I2', type: 'Sales', partyId: 'party-1', grandTotal: 250, outstandingAmount: 250, status: 'Unpaid' },
    { id: 'i-3', invoiceNumber: 'I3', type: 'Sales', partyId: 'party-1', grandTotal: 300, outstandingAmount: 0, status: 'Paid' },
    { id: 'i-4', invoiceNumber: 'I4', type: 'Sales', partyId: 'party-1', grandTotal: 400, outstandingAmount: 400, status: 'Cancelled' },
  ]

  const recomputed = recomputePartyBalances(invoices, parties)
  const p1 = recomputed.find((p) => p.id === 'party-1')
  const p2 = recomputed.find((p) => p.id === 'party-2')

  // Party 1 should only sum active open invoices (500 + 250 = 750)
  assert.strictEqual(p1?.outstandingBalance, 750)
  assert.strictEqual(p2?.outstandingBalance, 0)
})

test('Suite 1', '1.12 Randomized stress fuzzer (1,000 multi-item invoices) strictly balances every journal', () => {
  const incomeAccounts = ['acc-sales', 'acc-consult', 'acc-interest-income']
  const expenseAccounts = ['acc-materials', 'acc-salaries', 'acc-rent', 'acc-utilities', 'acc-travel', 'acc-deprec']
  const taxRates = [0, 5, 14, 15, 17.5]

  for (let i = 0; i < 1000; i++) {
    const itemCount = 1 + Math.floor(Math.random() * 6)
    const items: InvoiceItem[] = []

    for (let j = 0; j < itemCount; j++) {
      const isQtyRate = Math.random() > 0.3
      const taxRate = taxRates[Math.floor(Math.random() * taxRates.length)]
      if (isQtyRate) {
        items.push({
          id: `fuzz-${i}-${j}`,
          description: `Fuzz Item ${j}`,
          accountId: i % 2 === 0 ? incomeAccounts[j % incomeAccounts.length] : expenseAccounts[j % expenseAccounts.length],
          qty: round2(0.1 + Math.random() * 20),
          rate: round2(1 + Math.random() * 5000),
          taxRate,
        })
      } else {
        items.push({
          id: `fuzz-${i}-${j}`,
          description: `Fuzz Amount Item ${j}`,
          accountId: i % 2 === 0 ? incomeAccounts[j % incomeAccounts.length] : expenseAccounts[j % expenseAccounts.length],
          amount: round2(1 + Math.random() * 10000),
          taxRate,
        })
      }
    }

    const totals = calculateInvoiceTotals(items)
    // 1. Invariant: subtotal + taxTotal === grandTotal
    assert.strictEqual(
      round2(totals.subtotal + totals.taxTotal),
      totals.grandTotal,
      `Fuzz #${i}: subtotal (${totals.subtotal}) + taxTotal (${totals.taxTotal}) !== grandTotal (${totals.grandTotal})`
    )

    if (i % 2 === 0) {
      // Sales Invoice
      const invoice: Invoice = {
        id: `fuzz-inv-${i}`,
        invoiceNumber: `INV-FUZZ-${i}`,
        type: 'Sales',
        date: '2026-09-01',
        items,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        outstandingAmount: totals.grandTotal,
        status: 'Unpaid',
      }
      const journal = createSalesInvoiceJournal(invoice, CORE_ACCOUNTS)
      assert.strictEqual(
        journal.totalDebit,
        journal.totalCredit,
        `Fuzz #${i} Sales: Debit (${journal.totalDebit}) !== Credit (${journal.totalCredit})`
      )
      const debitSum = round2(journal.items.reduce((s, it) => s + it.debit, 0))
      const creditSum = round2(journal.items.reduce((s, it) => s + it.credit, 0))
      assert.strictEqual(debitSum, journal.totalDebit, `Fuzz #${i} Sales: item debit sum !== totalDebit`)
      assert.strictEqual(creditSum, journal.totalCredit, `Fuzz #${i} Sales: item credit sum !== totalCredit`)
    } else {
      // Purchase Bill
      const bill: Invoice = {
        id: `fuzz-bill-${i}`,
        invoiceNumber: `BILL-FUZZ-${i}`,
        type: 'Purchase',
        date: '2026-09-01',
        items,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        outstandingAmount: totals.grandTotal,
        status: 'Unpaid',
      }
      const journal = createPurchaseBillJournal(bill, CORE_ACCOUNTS)
      assert.strictEqual(
        journal.totalDebit,
        journal.totalCredit,
        `Fuzz #${i} Purchase: Debit (${journal.totalDebit}) !== Credit (${journal.totalCredit})`
      )
      const debitSum = round2(journal.items.reduce((s, it) => s + it.debit, 0))
      const creditSum = round2(journal.items.reduce((s, it) => s + it.credit, 0))
      assert.strictEqual(debitSum, journal.totalDebit, `Fuzz #${i} Purchase: item debit sum !== totalDebit`)
      assert.strictEqual(creditSum, journal.totalCredit, `Fuzz #${i} Purchase: item credit sum !== totalCredit`)
    }
  }
})

// ============================================================================
// SUITE 2: CHART OF ACCOUNTS INVARIANTS
// ============================================================================
console.log('\n--- SUITE 2: Chart of Accounts Invariants ---')

const EXPECTED_22_STANDARD_ACCOUNTS = [
  // 6 Assets
  'acc-bank',
  'acc-cash',
  'acc-ar',
  'acc-inventory',
  'acc-equip',
  'acc-vehic',
  // 4 Liabilities
  'acc-ap',
  'acc-vat',
  'acc-vat-in',
  'acc-payroll-liab',
  // 3 Equity
  'acc-retained',
  'acc-capital',
  'acc-owner-equity',
  // 3 Income
  'acc-sales',
  'acc-consult',
  'acc-interest-income',
  // 6 Expenses
  'acc-materials',
  'acc-salaries',
  'acc-rent',
  'acc-utilities',
  'acc-travel',
  'acc-deprec',
]

const EXPECTED_8_GROUP_ACCOUNTS = [
  'acc-asset',
  'acc-curr-asset',
  'acc-fixed-asset',
  'acc-liab',
  'acc-curr-liab',
  'acc-equity',
  'acc-income',
  'acc-expense',
]

const ROOT_CATEGORY_GROUPS = [
  'acc-asset',
  'acc-liab',
  'acc-equity',
  'acc-income',
  'acc-expense',
]

function verifyAccountListInvariants(list: Account[], sourceName: string) {
  assert.strictEqual(list.length, 30, `${sourceName} must contain exactly 30 accounts (got ${list.length})`)

  // Check all 22 standard accounts
  for (const accId of EXPECTED_22_STANDARD_ACCOUNTS) {
    const found = list.find((a) => a.id === accId)
    assert(found, `${sourceName} must include standard account ${accId}`)
    assert.strictEqual(found.isGroup, false, `${accId} must have isGroup: false`)
    assert(found.parentId !== null && found.parentId !== undefined, `${accId} must have non-null parentId`)
  }

  // Check all 8 group accounts
  for (const grpId of EXPECTED_8_GROUP_ACCOUNTS) {
    const found = list.find((a) => a.id === grpId)
    assert(found, `${sourceName} must include group account ${grpId}`)
    assert.strictEqual(found.isGroup, true, `${grpId} must have isGroup: true`)
  }

  // Check all 5 root groups have parentId === null
  for (const rootId of ROOT_CATEGORY_GROUPS) {
    const found = list.find((a) => a.id === rootId)
    assert(found, `${sourceName} must include root group ${rootId}`)
    assert.strictEqual(found.parentId, null, `Root group ${rootId} must strictly have parentId === null`)
  }

  // Check no dangling parent IDs
  for (const acc of list) {
    if (acc.parentId !== null && acc.parentId !== undefined) {
      const parentExists = list.some((p) => p.id === acc.parentId)
      assert(parentExists, `${sourceName}: Account ${acc.id} points to non-existent parentId: ${acc.parentId}`)
    }
  }

  // Check acyclicity and max depth
  for (const acc of list) {
    const visited = new Set<string>()
    let curr: Account | undefined = acc
    let depth = 0
    while (curr && curr.parentId !== null) {
      assert(!visited.has(curr.id), `${sourceName}: Cycle detected involving account ${curr.id}`)
      visited.add(curr.id)
      curr = list.find((a) => a.id === curr!.parentId)
      depth++
      assert(depth < 10, `${sourceName}: Hierarchy depth too deep for account ${acc.id}`)
    }
  }
}

test('Suite 2', '2.1 CORE_ACCOUNTS in books-main.ts contains all 22 standard + 8 group accounts with valid invariants', () => {
  verifyAccountListInvariants(CORE_ACCOUNTS, 'CORE_ACCOUNTS')
})

test('Suite 2', '2.2 initialBooksData.accounts in initialData.ts contains all 22 standard + 8 group accounts with valid invariants', () => {
  verifyAccountListInvariants(initialBooksData.accounts, 'initialBooksData.accounts')
})

test('Suite 2', '2.3 CORE_ACCOUNTS and initialBooksData.accounts are structurally identical', () => {
  assert.strictEqual(CORE_ACCOUNTS.length, initialBooksData.accounts.length)
  for (const core of CORE_ACCOUNTS) {
    const mock = initialBooksData.accounts.find((a) => a.id === core.id)
    assert(mock, `initialBooksData.accounts missing ${core.id}`)
    assert.strictEqual(mock.rootType, core.rootType, `rootType mismatch for ${core.id}`)
    assert.strictEqual(mock.accountType, core.accountType, `accountType mismatch for ${core.id}`)
    assert.strictEqual(mock.parentId, core.parentId, `parentId mismatch for ${core.id}`)
    assert.strictEqual(mock.isGroup, core.isGroup, `isGroup mismatch for ${core.id}`)
  }
})

// ============================================================================
// SUITE 3: PERSISTENCE & CORRUPT RECOVERY
// ============================================================================
console.log('\n--- SUITE 3: Persistence & Corrupt Recovery Forensics ---')

test('Suite 3', '3.1 Corrupt JSON triggers creation of BOTH .corrupted.bak AND .corrupt-[timestamp] files', () => {
  const sb = createSandbox()
  try {
    const corruptPayload = '{"version": 1, "accounts": [{"id": "acc-bank", "balance": 12345}, UNFINISHED_SYNTAX_ERROR...'
    mkdirSync(join(sb.dir, 'books'), { recursive: true })
    writeFileSync(sb.booksPath, corruptPayload, 'utf8')

    const beforeRead = Date.now()
    const result = readBooksStore(sb.booksPath)
    const afterRead = Date.now()

    // 1. Verify return value
    assert.strictEqual(result.version, CURRENT_BOOKS_SCHEMA_VERSION, 'Fallback version is CURRENT_BOOKS_SCHEMA_VERSION')
    assert.strictEqual(result.accounts.length, 30, 'Fallback accounts contains all 30 core accounts')

    // 2. Verify legacy .corrupted.bak exists and matches corrupt content
    const bakPath = `${sb.booksPath}.corrupted.bak`
    assert(existsSync(bakPath), '.corrupted.bak file must exist on disk')
    assert.strictEqual(readFileSync(bakPath, 'utf8'), corruptPayload, '.corrupted.bak contains exact corrupt payload')

    // 3. Verify timestamped .corrupt-[timestamp] exists and matches corrupt content
    const files = readdirSync(join(sb.dir, 'books'))
    const timestampedFiles = files.filter((f) => /books-data\.json\.corrupt-\d+$/.test(f))
    assert.strictEqual(timestampedFiles.length, 1, `Exactly 1 timestamped corrupt file expected, found: ${timestampedFiles.join(', ')}`)

    const tsMatch = timestampedFiles[0].match(/corrupt-(\d+)$/)
    assert(tsMatch, 'Must have numeric timestamp suffix')
    const fileTimestamp = Number(tsMatch[1])
    assert(fileTimestamp >= beforeRead - 1000 && fileTimestamp <= afterRead + 1000, `Timestamp ${fileTimestamp} is within read interval`)

    const timestampedContent = readFileSync(join(sb.dir, 'books', timestampedFiles[0]), 'utf8')
    assert.strictEqual(timestampedContent, corruptPayload, 'Timestamped backup contains exact corrupt payload')
  } finally {
    sb.cleanup()
  }
})

test('Suite 3', '3.2 Zero-byte empty file triggers dual corrupt backups and returns safe fallback with all 30 core accounts', () => {
  const sb = createSandbox()
  try {
    mkdirSync(join(sb.dir, 'books'), { recursive: true })
    writeFileSync(sb.booksPath, '', 'utf8')

    const result = readBooksStore(sb.booksPath)
    assert.strictEqual(result.version, CURRENT_BOOKS_SCHEMA_VERSION)
    assert.strictEqual(result.accounts.length, 30)

    const bakPath = `${sb.booksPath}.corrupted.bak`
    assert(existsSync(bakPath), '.corrupted.bak exists for 0-byte file')
    assert.strictEqual(readFileSync(bakPath, 'utf8'), '')

    const files = readdirSync(join(sb.dir, 'books'))
    const timestamped = files.filter((f) => /books-data\.json\.corrupt-\d+$/.test(f))
    assert.strictEqual(timestamped.length, 1)
  } finally {
    sb.cleanup()
  }
})

test('Suite 3', '3.3 Consecutive corrupt reads preserve historical timestamped backups', () => {
  const sb = createSandbox()
  try {
    mkdirSync(join(sb.dir, 'books'), { recursive: true })

    // First corruption
    writeFileSync(sb.booksPath, 'CORRUPT_BATCH_1', 'utf8')
    readBooksStore(sb.booksPath)

    // Second corruption with slight delay to ensure distinct millisecond
    const sleepSync = (ms: number) => {
      const end = Date.now() + ms
      while (Date.now() < end) {}
    }
    sleepSync(10)

    writeFileSync(sb.booksPath, 'CORRUPT_BATCH_2', 'utf8')
    readBooksStore(sb.booksPath)

    const files = readdirSync(join(sb.dir, 'books'))
    const timestamped = files.filter((f) => /books-data\.json\.corrupt-\d+$/.test(f))
    assert.strictEqual(timestamped.length, 2, 'Both distinct timestamped corrupt files must exist')

    // Legacy .corrupted.bak should have the latest content
    const bakContent = readFileSync(`${sb.booksPath}.corrupted.bak`, 'utf8')
    assert.strictEqual(bakContent, 'CORRUPT_BATCH_2', 'Legacy .corrupted.bak has latest content')
  } finally {
    sb.cleanup()
  }
})

test('Suite 3', '3.4 Fallback data retains all 30 valid core accounts and respects account invariants', () => {
  const sb = createSandbox()
  try {
    mkdirSync(join(sb.dir, 'books'), { recursive: true })
    writeFileSync(sb.booksPath, '{"invalid_json":', 'utf8')

    const fallback = readBooksStore(sb.booksPath)
    verifyAccountListInvariants(fallback.accounts, 'Fallback accounts')
    assert.strictEqual(fallback.settings.companyName, DEFAULT_BOOK_SETTINGS.companyName)
    assert.deepStrictEqual(fallback.parties, [])
    assert.deepStrictEqual(fallback.invoices, [])
    assert.deepStrictEqual(fallback.journalEntries, [])
    assert.deepStrictEqual(fallback.bankTransactions, [])
  } finally {
    sb.cleanup()
  }
})

test('Suite 3', '3.5 migrateAndValidateBooks backfills missing accounts from CORE_ACCOUNTS into partial stores', () => {
  const partialData = {
    version: 1,
    accounts: [
      { id: 'acc-bank', balance: 500000 },
      { id: 'acc-custom-1', name: 'Custom Account', rootType: 'Asset', accountType: 'Current Asset', balance: 12000 },
    ],
  }

  const migrated = migrateAndValidateBooks(partialData)

  // 1 custom + 30 core (with acc-bank updated) = 31 accounts
  assert.strictEqual(migrated.accounts.length, 31, '1 custom + 30 core accounts = 31')
  const bank = migrated.accounts.find((a) => a.id === 'acc-bank')
  assert.strictEqual(bank?.balance, 500000, 'Custom balance on existing core account retained')
  assert.strictEqual(bank?.parentId, 'acc-curr-asset', 'Missing parentId backfilled from core')

  const custom = migrated.accounts.find((a) => a.id === 'acc-custom-1')
  assert(custom, 'Custom account preserved')
  assert.strictEqual(custom.balance, 12000)

  // Invariants preserved on all core accounts
  for (const core of CORE_ACCOUNTS) {
    assert(migrated.accounts.some((a) => a.id === core.id), `Core account ${core.id} must be present`)
  }
})

// ============================================================================
// SUMMARY & VERDICT
// ============================================================================
console.log('\n======================================================================')
console.log(`SUMMARY: ${passedTests} passed, ${failedTests} failed out of ${totalTests} tests`)
if (failures.length > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) {
    console.log(`❌ [${f.suite}] ${f.name}: ${f.error}`)
  }
}
console.log('======================================================================')

process.exit(failedTests > 0 ? 1 : 0)

/**
 * tools/test-challenger-m2-empirical.ts
 *
 * EMPIRICAL ADVERSARIAL CHALLENGER TEST SUITE FOR BOOKS MILESTONE 2 (M2)
 *
 * Rigorous Stress Tests for:
 * 1. High-value & decimal edge cases (odd decimals, 0% tax, 15% tax, mixed positive/negative discounts)
 *    Strict invariant: Total Debits === Total Credits strictly across all journals.
 * 2. Immediate settlement on creation (status: 'Paid' in saveInvoice)
 *    Strict verification: BOTH posting journal AND settlement journal generated; Bank/AR/AP balances accurate.
 * 3. Multi-line split expense purchase bills (acc-materials, acc-rent, acc-utilities)
 *    Strict verification: Each expense account incremented by exact net line amount; VAT input debited/incremented.
 * 4. Full lifecycle reversals (Draft -> Unpaid -> Paid -> Delete).
 * 5. 500-iteration randomized multi-line fuzz test.
 */

import assert from 'node:assert'
import { useBooksStore } from '../apps/books/src/renderer/src/store'
import { initialBooksData } from '../apps/books/src/renderer/src/mock/initialData'
import { round2, calculateInvoiceTotals } from '../apps/books/src/shared/accounting'
import type { InvoiceItem } from '../apps/books/src/shared/types'

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures: Array<{ suite: string; name: string; error: string }> = []

async function test(suite: string, name: string, fn: () => Promise<void> | void) {
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

function resetStore() {
  useBooksStore.setState({
    activeTab: 'dashboard',
    data: JSON.parse(JSON.stringify(initialBooksData)),
    activeInvoiceId: null,
    invoiceStatusFilter: 'All',
    activeReport: 'profit-loss',
    printInvoice: null,
    searchTerm: '',
  })
}

async function run() {
  console.log('======================================================================')
  console.log('   DEEP EMPIRICAL CHALLENGER: BOOKS MILESTONE 2 (M2) AUDIT HARNESS')
  console.log('======================================================================\n')

  // =========================================================================
  // CHECK 1: High-value & decimal edge cases
  // =========================================================================
  console.log('--- CHECK 1: High-value & Decimal Edge Cases ---')

  await test('Check 1', '1.1 Sales invoice with odd decimals, 0% tax, 15% tax, and discount line (debits === credits)', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialJournals = store.data.journalEntries.length

    const items: InvoiceItem[] = [
      {
        id: 'i-1',
        itemCode: 'ODD-1',
        description: 'Odd fractional quantity and rate',
        accountId: 'acc-sales',
        accountName: 'Tender & Commercial Contracting Sales',
        qty: 3.333,
        rate: 19.999,
        taxRate: 15,
        amount: round2(3.333 * 19.999), // 66.66
      },
      {
        id: 'i-2',
        itemCode: 'ZERO-TAX',
        description: 'Zero-rated municipal service line',
        accountId: 'acc-consult',
        accountName: 'Professional Advisory Fees',
        qty: 1,
        rate: 10450.33,
        taxRate: 0,
        amount: 10450.33,
      },
      {
        id: 'i-3',
        itemCode: 'DISC-1',
        description: 'Early settlement discount (negative)',
        accountId: 'acc-sales',
        accountName: 'Tender & Commercial Contracting Sales',
        qty: 1,
        rate: -250.75,
        taxRate: 15,
        amount: -250.75,
      },
      {
        id: 'i-4',
        itemCode: 'ODD-2',
        description: 'Another odd decimal line',
        accountId: 'acc-consult',
        accountName: 'Professional Advisory Fees',
        qty: 7.123,
        rate: 456.789,
        taxRate: 0,
        amount: round2(7.123 * 456.789), // 3253.71
      },
    ]

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const inv = updated.invoices[0]

    // Verify calculated totals
    const line1Amt = 66.66
    const line1Tax = round2(line1Amt * 0.15) // 10.00
    const line2Amt = 10450.33
    const line2Tax = 0
    const line3Amt = -250.75
    const line3Tax = round2(line3Amt * 0.15) // -37.61
    const line4Amt = 3253.71
    const line4Tax = 0

    const expectedSubtotal = round2(line1Amt + line2Amt + line3Amt + line4Amt) // 13519.95
    const expectedTax = round2(line1Tax + line2Tax + line3Tax + line4Tax) // -27.61
    const expectedGrandTotal = round2(expectedSubtotal + expectedTax) // 13492.34

    assert.strictEqual(inv.subtotal, expectedSubtotal, `Subtotal mismatch: got ${inv.subtotal}, expected ${expectedSubtotal}`)
    assert.strictEqual(inv.taxTotal, expectedTax, `Tax mismatch: got ${inv.taxTotal}, expected ${expectedTax}`)
    assert.strictEqual(inv.grandTotal, expectedGrandTotal, `Grand total mismatch: got ${inv.grandTotal}, expected ${expectedGrandTotal}`)
    assert.strictEqual(inv.subtotal + inv.taxTotal, inv.grandTotal, 'subtotal + taxTotal must strictly equal grandTotal')

    // Verify Journal Entry
    assert.strictEqual(updated.journalEntries.length, initialJournals + 1)
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, je.totalCredit, `Journal Debits (${je.totalDebit}) must strictly equal Credits (${je.totalCredit})`)
    assert.ok(je.totalDebit > 0, 'Total debit must be positive')

    // Verify all line items in journal have non-negative debits/credits
    for (const it of je.items) {
      assert.ok(it.debit >= 0, `Line item debit cannot be negative: ${it.debit}`)
      assert.ok(it.credit >= 0, `Line item credit cannot be negative: ${it.credit}`)
      assert.ok(it.debit === 0 || it.credit === 0, 'Line item cannot have both debit and credit')
    }
  })

  await test('Check 1', '1.2 Extreme high-value sales invoice (R 50,000,000.75) with mixed lines and discount', async () => {
    resetStore()
    const store = useBooksStore.getState()

    const items: InvoiceItem[] = [
      {
        id: 'hi-1',
        itemCode: 'INFRA-1',
        description: 'Large Mega-Project Dam Construction',
        accountId: 'acc-sales',
        accountName: 'Tender & Commercial Contracting Sales',
        qty: 1,
        rate: 50000000.75,
        taxRate: 15,
        amount: 50000000.75,
      },
      {
        id: 'hi-2',
        itemCode: 'DISC-2',
        description: 'Tender Volume Rebate Discount',
        accountId: 'acc-sales',
        accountName: 'Tender & Commercial Contracting Sales',
        qty: 1,
        rate: -1500000.25,
        taxRate: 15,
        amount: -1500000.25,
      },
      {
        id: 'hi-3',
        itemCode: 'FEES-0',
        description: 'Exempt Regulatory Levy',
        accountId: 'acc-consult',
        accountName: 'Professional Advisory Fees',
        qty: 1,
        rate: 250000.00,
        taxRate: 0,
        amount: 250000.00,
      },
    ]

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const inv = updated.invoices[0]
    const je = updated.journalEntries[0]

    assert.strictEqual(inv.subtotal + inv.taxTotal, inv.grandTotal)
    assert.strictEqual(je.totalDebit, je.totalCredit, `High-value JE Debits (${je.totalDebit}) !== Credits (${je.totalCredit})`)
    assert.strictEqual(je.totalDebit, inv.grandTotal)
  })

  await test('Check 1', '1.3 Purchase bill with odd decimals, 0% tax, 15% tax, and discount lines (debits === credits)', async () => {
    resetStore()
    const store = useBooksStore.getState()

    const items: InvoiceItem[] = [
      {
        id: 'p-odd-1',
        itemCode: 'STEEL-BATCH',
        description: 'Fabricated Structural Sections',
        accountId: 'acc-materials',
        accountName: 'Direct Project Materials & Subcontractors',
        qty: 14.875,
        rate: 2345.67,
        taxRate: 15,
        amount: round2(14.875 * 2345.67), // 34891.84
      },
      {
        id: 'p-odd-2',
        itemCode: 'LOGISTICS-0',
        description: 'Exempt Freight Transit Surcharge',
        accountId: 'acc-travel',
        accountName: 'Site Travel & Logistics',
        qty: 1,
        rate: 4500.55,
        taxRate: 0,
        amount: 4500.55,
      },
      {
        id: 'p-odd-3',
        itemCode: 'SUPPLIER-DISC',
        description: 'Volume discount on materials',
        accountId: 'acc-materials',
        accountName: 'Direct Project Materials & Subcontractors',
        qty: 1,
        rate: -1200.00,
        taxRate: 15,
        amount: -1200.00,
      },
    ]

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const bill = updated.invoices[0]
    const je = updated.journalEntries[0]

    assert.strictEqual(bill.subtotal + bill.taxTotal, bill.grandTotal)
    assert.strictEqual(je.totalDebit, je.totalCredit, `Purchase JE Debits (${je.totalDebit}) !== Credits (${je.totalCredit})`)
    assert.strictEqual(je.totalCredit, bill.grandTotal)
  })

  await test('Check 1', '1.4 Negative total invoice (Credit note / refund scenario) preserves balanced journal', async () => {
    resetStore()
    const store = useBooksStore.getState()

    // Create a credit note sales invoice where discount exceeds positive
    const items: InvoiceItem[] = [
      {
        id: 'cr-1',
        itemCode: 'RET-1',
        description: 'Return of defective equipment',
        accountId: 'acc-sales',
        accountName: 'Tender & Commercial Contracting Sales',
        qty: 1,
        rate: -10000.00,
        taxRate: 15,
        amount: -10000.00,
      },
      {
        id: 'cr-2',
        itemCode: 'RESTOCK-FEES',
        description: 'Restocking handling charge',
        accountId: 'acc-consult',
        accountName: 'Professional Advisory Fees',
        qty: 1,
        rate: 1500.00,
        taxRate: 15,
        amount: 1500.00,
      },
    ]

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const inv = updated.invoices[0]
    const je = updated.journalEntries[0]

    // grandTotal = -9775
    assert.strictEqual(inv.grandTotal, -9775)
    // Debits: Return (-10000 as debit 10000) + Tax (-1275 as debit 1275) = 11275
    // Credits: AR (-9775 as credit 9775) + Restock (+1500 as credit 1500) = 11275
    assert.strictEqual(je.totalDebit, je.totalCredit, `Credit Note JE Debits (${je.totalDebit}) !== Credits (${je.totalCredit})`)
    assert.strictEqual(je.totalDebit, 11275)
    assert.strictEqual(je.totalCredit, 11275)
  })

  await test('Check 1', '1.5 Zero-total invoice (full offset discount: subtotal=0, tax=0, grandTotal=0) produces balanced journal', async () => {
    resetStore()
    const store = useBooksStore.getState()

    const items: InvoiceItem[] = [
      {
        id: 'z-1',
        itemCode: 'SRV-100',
        description: 'Warranty service covered',
        accountId: 'acc-sales',
        qty: 1,
        rate: 5000.00,
        taxRate: 15,
        amount: 5000.00,
      },
      {
        id: 'z-2',
        itemCode: 'WAR-DISC',
        description: 'Warranty coverage 100%',
        accountId: 'acc-sales',
        qty: 1,
        rate: -5000.00,
        taxRate: 15,
        amount: -5000.00,
      },
    ]

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const inv = updated.invoices[0]
    assert.strictEqual(inv.subtotal, 0)
    assert.strictEqual(inv.taxTotal, 0)
    assert.strictEqual(inv.grandTotal, 0)

    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, je.totalCredit)
  })

  // =========================================================================
  // CHECK 2: Immediate settlement on creation
  // =========================================================================
  console.log('\n--- CHECK 2: Immediate Settlement on Creation (status: Paid) ---')

  await test('Check 2', '2.1 Sales invoice created with status: Paid generates BOTH posting AND settlement journals', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialBank = store.data.accounts.find((a) => a.id === 'acc-bank')!.balance
    const initialAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
    const initialSales = store.data.accounts.find((a) => a.id === 'acc-sales')!.balance
    const initialVat = store.data.accounts.find((a) => a.id === 'acc-vat')!.balance
    const initialJournals = store.data.journalEntries.length
    const initialPartyBalance = store.data.parties.find((p) => p.id === 'party-1')!.outstandingBalance

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Paid',
      items: [
        {
          id: 'pay-now-1',
          itemCode: 'CSH-SRV',
          description: 'Immediate EFT Settled Services',
          accountId: 'acc-sales',
          accountName: 'Tender & Commercial Contracting Sales',
          qty: 1,
          rate: 45000.50,
          taxRate: 15,
          amount: 45000.50,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const inv = updated.invoices[0]

    // Invoice status and amounts
    assert.strictEqual(inv.status, 'Paid')
    assert.strictEqual(inv.outstandingAmount, 0)
    assert.strictEqual(inv.subtotal, 45000.50)
    assert.strictEqual(inv.taxTotal, 6750.08)
    assert.strictEqual(inv.grandTotal, 51750.58)

    // Exactly 2 journal entries must be generated: settlement + posting
    assert.strictEqual(updated.journalEntries.length, initialJournals + 2, 'Exactly 2 journal entries must be created')
    const settlementJe = updated.journalEntries[0]
    const postingJe = updated.journalEntries[1]

    // Posting Journal verification
    assert.strictEqual(postingJe.totalDebit, 51750.58)
    assert.strictEqual(postingJe.totalCredit, 51750.58)
    assert.ok(postingJe.items.some((it) => it.accountId === 'acc-ar' && it.debit === 51750.58), 'Posting must debit AR')
    assert.ok(postingJe.items.some((it) => it.accountId === 'acc-sales' && it.credit === 45000.50), 'Posting must credit Sales')
    assert.ok(postingJe.items.some((it) => (it.accountId === 'acc-vat' || it.accountId === 'acc-vat-out') && it.credit === 6750.08), 'Posting must credit VAT')

    // Settlement Journal verification
    assert.strictEqual(settlementJe.totalDebit, 51750.58)
    assert.strictEqual(settlementJe.totalCredit, 51750.58)
    assert.ok(settlementJe.items.some((it) => it.accountId === 'acc-bank' && it.debit === 51750.58), 'Settlement must debit Bank')
    assert.ok(settlementJe.items.some((it) => it.accountId === 'acc-ar' && it.credit === 51750.58), 'Settlement must credit AR')

    // Ledger account balance adjustments:
    // Bank: increased by grandTotal
    const newBank = updated.accounts.find((a) => a.id === 'acc-bank')!.balance
    assert.strictEqual(newBank, round2(initialBank + 51750.58), `Bank balance mismatch: ${newBank} vs ${initialBank + 51750.58}`)

    // AR: net change must be ZERO (debited by posting, credited by settlement)
    const newAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
    assert.strictEqual(newAr, initialAr, `AR balance must remain unchanged after immediate settlement: ${newAr} vs ${initialAr}`)

    // Sales: increased by subtotal
    const newSales = updated.accounts.find((a) => a.id === 'acc-sales')!.balance
    assert.strictEqual(newSales, round2(initialSales + 45000.50))

    // VAT Output: increased by taxTotal
    const newVat = updated.accounts.find((a) => a.id === 'acc-vat')!.balance
    assert.strictEqual(newVat, round2(initialVat + 6750.08))

    // Party outstanding balance remains strictly unaffected because it is fully settled
    const newPartyBalance = updated.parties.find((p) => p.id === 'party-1')!.outstandingBalance
    assert.strictEqual(newPartyBalance, initialPartyBalance, 'Party outstanding balance must not increase for immediate Paid invoice')
  })

  await test('Check 2', '2.2 Purchase bill created with status: Paid generates BOTH posting AND settlement journals', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialBank = store.data.accounts.find((a) => a.id === 'acc-bank')!.balance
    const initialAp = store.data.accounts.find((a) => a.id === 'acc-ap')!.balance
    const initialMaterials = store.data.accounts.find((a) => a.id === 'acc-materials')!.balance
    const vatInAcc = store.data.accounts.find((a) => a.id === 'acc-vat-in') || store.data.accounts.find((a) => a.id === 'acc-vat')!
    const initialVatIn = vatInAcc.balance
    const initialJournals = store.data.journalEntries.length
    const initialSupplierBalance = store.data.parties.find((p) => p.id === 'party-4')!.outstandingBalance

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Paid',
      items: [
        {
          id: 'pay-bill-1',
          itemCode: 'INSTANT-MAT',
          description: 'Cash on Delivery Materials',
          accountId: 'acc-materials',
          accountName: 'Direct Project Materials & Subcontractors',
          qty: 2,
          rate: 15000.25,
          taxRate: 15,
          amount: 30000.50,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const bill = updated.invoices[0]

    assert.strictEqual(bill.status, 'Paid')
    assert.strictEqual(bill.outstandingAmount, 0)
    assert.strictEqual(bill.subtotal, 30000.50)
    assert.strictEqual(bill.taxTotal, 4500.08)
    assert.strictEqual(bill.grandTotal, 34500.58)

    // Exactly 2 journals generated
    assert.strictEqual(updated.journalEntries.length, initialJournals + 2)
    const settlementJe = updated.journalEntries[0]
    const postingJe = updated.journalEntries[1]

    // Posting Journal verification
    assert.strictEqual(postingJe.totalDebit, 34500.58)
    assert.strictEqual(postingJe.totalCredit, 34500.58)
    assert.ok(postingJe.items.some((it) => it.accountId === 'acc-materials' && it.debit === 30000.50), 'Posting must debit Materials')
    assert.ok(postingJe.items.some((it) => (it.accountId === 'acc-vat-in' || it.accountId === 'acc-vat') && it.debit === 4500.08), 'Posting must debit VAT Input')
    assert.ok(postingJe.items.some((it) => it.accountId === 'acc-ap' && it.credit === 34500.58), 'Posting must credit AP')

    // Settlement Journal verification
    assert.strictEqual(settlementJe.totalDebit, 34500.58)
    assert.strictEqual(settlementJe.totalCredit, 34500.58)
    assert.ok(settlementJe.items.some((it) => it.accountId === 'acc-ap' && it.debit === 34500.58), 'Settlement must debit AP')
    assert.ok(settlementJe.items.some((it) => it.accountId === 'acc-bank' && it.credit === 34500.58), 'Settlement must credit Bank')

    // Ledger accounts:
    // Bank: decremented by grandTotal
    const newBank = updated.accounts.find((a) => a.id === 'acc-bank')!.balance
    assert.strictEqual(newBank, round2(initialBank - 34500.58))

    // AP: net change must be ZERO (credited by posting, debited by settlement)
    const newAp = updated.accounts.find((a) => a.id === 'acc-ap')!.balance
    assert.strictEqual(newAp, initialAp)

    // Materials: incremented by subtotal
    const newMaterials = updated.accounts.find((a) => a.id === 'acc-materials')!.balance
    assert.strictEqual(newMaterials, round2(initialMaterials + 30000.50))

    // VAT Input: incremented by taxTotal
    const newVatIn = (updated.accounts.find((a) => a.id === 'acc-vat-in') || updated.accounts.find((a) => a.id === 'acc-vat')!).balance
    assert.strictEqual(newVatIn, round2(initialVatIn + 4500.08))

    // Supplier balance remains unchanged
    const newSupplierBalance = updated.parties.find((p) => p.id === 'party-4')!.outstandingBalance
    assert.strictEqual(newSupplierBalance, initialSupplierBalance)
  })

  // =========================================================================
  // CHECK 3: Multi-line split expense purchase bills
  // =========================================================================
  console.log('\n--- CHECK 3: Multi-Line Split Expense Purchase Bills ---')

  await test('Check 3', '3.1 Purchase bill with lines to acc-materials, acc-rent, and acc-utilities increments each expense and debits/increments VAT in', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialAp = store.data.accounts.find((a) => a.id === 'acc-ap')!.balance
    const initialMaterials = store.data.accounts.find((a) => a.id === 'acc-materials')!.balance
    const initialRent = store.data.accounts.find((a) => a.id === 'acc-rent')!.balance
    const initialUtilities = store.data.accounts.find((a) => a.id === 'acc-utilities')!.balance
    const vatInAcc = store.data.accounts.find((a) => a.id === 'acc-vat-in') || store.data.accounts.find((a) => a.id === 'acc-vat')!
    const initialVatIn = vatInAcc.balance
    const initialJournals = store.data.journalEntries.length

    const items: InvoiceItem[] = [
      {
        id: 'split-1',
        itemCode: 'MAT-SPLIT',
        description: 'Raw Steel and Fasteners',
        accountId: 'acc-materials',
        accountName: 'Direct Project Materials & Subcontractors',
        qty: 4,
        rate: 6250.00,
        taxRate: 15,
        amount: 25000.00,
      },
      {
        id: 'split-2',
        itemCode: 'RENT-SPLIT',
        description: 'Site Crane & Scaffold Rental',
        accountId: 'acc-rent',
        accountName: 'Office Rent & Facilities',
        qty: 1,
        rate: 18000.00,
        taxRate: 15,
        amount: 18000.00,
      },
      {
        id: 'split-3',
        itemCode: 'UTIL-SPLIT',
        description: 'High-Voltage Power Supply Setup',
        accountId: 'acc-utilities',
        accountName: 'Water & Electricity Utilities',
        qty: 1,
        rate: 7500.00,
        taxRate: 15,
        amount: 7500.00,
      },
    ]

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const bill = updated.invoices[0]

    // Verify subtotal, taxTotal, grandTotal
    const expectedSubtotal = round2(25000 + 18000 + 7500) // 50500.00
    const expectedTax = round2(50500 * 0.15) // 7575.00
    const expectedGrandTotal = round2(expectedSubtotal + expectedTax) // 58075.00

    assert.strictEqual(bill.subtotal, expectedSubtotal)
    assert.strictEqual(bill.taxTotal, expectedTax)
    assert.strictEqual(bill.grandTotal, expectedGrandTotal)

    // Verify journal entry
    assert.strictEqual(updated.journalEntries.length, initialJournals + 1)
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, expectedGrandTotal)
    assert.strictEqual(je.totalCredit, expectedGrandTotal)
    assert.strictEqual(je.totalDebit, je.totalCredit)

    // Verify journal line items:
    // Expense debits
    const matJe = je.items.find((it) => it.accountId === 'acc-materials')
    const rentJe = je.items.find((it) => it.accountId === 'acc-rent')
    const utilJe = je.items.find((it) => it.accountId === 'acc-utilities')
    const vatJe = je.items.find((it) => it.accountId === 'acc-vat-in' || it.accountId === 'acc-vat')
    const apJe = je.items.find((it) => it.accountId === 'acc-ap')

    assert.ok(matJe, 'Journal must contain acc-materials item')
    assert.strictEqual(matJe.debit, 25000.00)
    assert.strictEqual(matJe.credit, 0)

    assert.ok(rentJe, 'Journal must contain acc-rent item')
    assert.strictEqual(rentJe.debit, 18000.00)
    assert.strictEqual(rentJe.credit, 0)

    assert.ok(utilJe, 'Journal must contain acc-utilities item')
    assert.strictEqual(utilJe.debit, 7500.00)
    assert.strictEqual(utilJe.credit, 0)

    assert.ok(vatJe, 'Journal must contain VAT Input item')
    assert.strictEqual(vatJe.debit, 7575.00, 'VAT Input is debited in general journal')
    assert.strictEqual(vatJe.credit, 0)

    assert.ok(apJe, 'Journal must contain AP item')
    assert.strictEqual(apJe.credit, 58075.00, 'AP is credited in general journal')
    assert.strictEqual(apJe.debit, 0)

    // Verify each account balance in ledger:
    const newMaterials = updated.accounts.find((a) => a.id === 'acc-materials')!.balance
    const newRent = updated.accounts.find((a) => a.id === 'acc-rent')!.balance
    const newUtilities = updated.accounts.find((a) => a.id === 'acc-utilities')!.balance
    const newVatIn = (updated.accounts.find((a) => a.id === 'acc-vat-in') || updated.accounts.find((a) => a.id === 'acc-vat')!).balance
    const newAp = updated.accounts.find((a) => a.id === 'acc-ap')!.balance

    assert.strictEqual(newMaterials, round2(initialMaterials + 25000.00), 'acc-materials incremented by exact net line amount')
    assert.strictEqual(newRent, round2(initialRent + 18000.00), 'acc-rent incremented by exact net line amount')
    assert.strictEqual(newUtilities, round2(initialUtilities + 7500.00), 'acc-utilities incremented by exact net line amount')
    assert.strictEqual(newVatIn, round2(initialVatIn + 7575.00), 'acc-vat-in incremented by exact tax amount')
    assert.strictEqual(newAp, round2(initialAp + 58075.00), 'acc-ap incremented by grand total')
  })

  await test('Check 3', '3.2 Multi-line split expense with mixed tax rates (15% on materials and rent, 0% on utilities)', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialMaterials = store.data.accounts.find((a) => a.id === 'acc-materials')!.balance
    const initialRent = store.data.accounts.find((a) => a.id === 'acc-rent')!.balance
    const initialUtilities = store.data.accounts.find((a) => a.id === 'acc-utilities')!.balance
    const vatInAcc = store.data.accounts.find((a) => a.id === 'acc-vat-in') || store.data.accounts.find((a) => a.id === 'acc-vat')!
    const initialVatIn = vatInAcc.balance

    const items: InvoiceItem[] = [
      {
        id: 'm-1',
        itemCode: 'M1',
        description: 'Materials',
        accountId: 'acc-materials',
        qty: 1,
        rate: 10000,
        taxRate: 15,
        amount: 10000,
      },
      {
        id: 'm-2',
        itemCode: 'M2',
        description: 'Rent',
        accountId: 'acc-rent',
        qty: 1,
        rate: 6000,
        taxRate: 15,
        amount: 6000,
      },
      {
        id: 'm-3',
        itemCode: 'M3',
        description: 'Utilities (Zero-Rated)',
        accountId: 'acc-utilities',
        qty: 1,
        rate: 4000,
        taxRate: 0,
        amount: 4000,
      },
    ]

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const bill = updated.invoices[0]
    const je = updated.journalEntries[0]

    // Subtotal: 20000, Tax: 1500 + 900 = 2400, GrandTotal: 22400
    assert.strictEqual(bill.subtotal, 20000)
    assert.strictEqual(bill.taxTotal, 2400)
    assert.strictEqual(bill.grandTotal, 22400)

    assert.strictEqual(je.totalDebit, 22400)
    assert.strictEqual(je.totalCredit, 22400)

    const newMaterials = updated.accounts.find((a) => a.id === 'acc-materials')!.balance
    const newRent = updated.accounts.find((a) => a.id === 'acc-rent')!.balance
    const newUtilities = updated.accounts.find((a) => a.id === 'acc-utilities')!.balance
    const newVatIn = (updated.accounts.find((a) => a.id === 'acc-vat-in') || updated.accounts.find((a) => a.id === 'acc-vat')!).balance

    assert.strictEqual(newMaterials, round2(initialMaterials + 10000))
    assert.strictEqual(newRent, round2(initialRent + 6000))
    assert.strictEqual(newUtilities, round2(initialUtilities + 4000))
    assert.strictEqual(newVatIn, round2(initialVatIn + 2400))
  })

  await test('Check 3', '3.3 Split expense across 5 accounts (materials, salaries, rent, utilities, travel) with discount', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialMat = store.data.accounts.find((a) => a.id === 'acc-materials')!.balance
    const initialSal = store.data.accounts.find((a) => a.id === 'acc-salaries')!.balance
    const initialRent = store.data.accounts.find((a) => a.id === 'acc-rent')!.balance
    const initialUtil = store.data.accounts.find((a) => a.id === 'acc-utilities')!.balance
    const initialTrv = store.data.accounts.find((a) => a.id === 'acc-travel')!.balance
    const initialAp = store.data.accounts.find((a) => a.id === 'acc-ap')!.balance

    const items: InvoiceItem[] = [
      { id: 'e-1', accountId: 'acc-materials', qty: 1, rate: 12000, taxRate: 15, amount: 12000 },
      { id: 'e-2', accountId: 'acc-salaries', qty: 1, rate: 8000, taxRate: 0, amount: 8000 },
      { id: 'e-3', accountId: 'acc-rent', qty: 1, rate: 5000, taxRate: 15, amount: 5000 },
      { id: 'e-4', accountId: 'acc-utilities', qty: 1, rate: 2500, taxRate: 15, amount: 2500 },
      { id: 'e-5', accountId: 'acc-travel', qty: 1, rate: 3000, taxRate: 15, amount: 3000 },
      { id: 'e-6', accountId: 'acc-materials', qty: 1, rate: -1000, taxRate: 15, amount: -1000 }, // Supplier rebate
    ]

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const bill = updated.invoices[0]
    const je = updated.journalEntries[0]

    // Net subtotal: 12000 + 8000 + 5000 + 2500 + 3000 - 1000 = 29500
    // Tax: 1800 + 0 + 750 + 375 + 450 - 150 = 3225
    // Grand total: 32725
    assert.strictEqual(bill.subtotal, 29500)
    assert.strictEqual(bill.taxTotal, 3225)
    assert.strictEqual(bill.grandTotal, 32725)
    assert.strictEqual(je.totalDebit, je.totalCredit)

    // Check individual balances
    assert.strictEqual(updated.accounts.find((a) => a.id === 'acc-materials')!.balance, round2(initialMat + 11000))
    assert.strictEqual(updated.accounts.find((a) => a.id === 'acc-salaries')!.balance, round2(initialSal + 8000))
    assert.strictEqual(updated.accounts.find((a) => a.id === 'acc-rent')!.balance, round2(initialRent + 5000))
    assert.strictEqual(updated.accounts.find((a) => a.id === 'acc-utilities')!.balance, round2(initialUtil + 2500))
    assert.strictEqual(updated.accounts.find((a) => a.id === 'acc-travel')!.balance, round2(initialTrv + 3000))
    assert.strictEqual(updated.accounts.find((a) => a.id === 'acc-ap')!.balance, round2(initialAp + 32725))
  })

  // =========================================================================
  // CHECK 4: Lifecycle Reversal & State Invariants
  // =========================================================================
  console.log('\n--- CHECK 4: Lifecycle & Reversal Invariants ---')

  await test('Check 4', '4.1 Draft -> Unpaid -> Paid -> Delete returns balances and journals to baseline', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineAccounts = JSON.stringify(store.data.accounts)
    const baselineParties = JSON.stringify(store.data.parties)
    const baselineJournalsCount = store.data.journalEntries.length

    // 1. Create as Draft
    await store.saveInvoice({
      id: 'lifecycle-inv-1',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Draft',
      items: [
        {
          id: 'li-1',
          itemCode: 'LC-1',
          description: 'Lifecycle Test Item',
          accountId: 'acc-sales',
          qty: 2,
          rate: 25000,
          taxRate: 15,
          amount: 50000,
        },
      ],
    })

    // Balances and journals unchanged in Draft
    assert.strictEqual(useBooksStore.getState().data.journalEntries.length, baselineJournalsCount)
    assert.strictEqual(JSON.stringify(useBooksStore.getState().data.accounts), baselineAccounts)

    // 2. Transition Draft to Unpaid
    await store.saveInvoice({
      id: 'lifecycle-inv-1',
      status: 'Unpaid',
    })

    // Now journal is posted (+1) and accounts updated
    assert.strictEqual(useBooksStore.getState().data.journalEntries.length, baselineJournalsCount + 1)
    const arAfterPost = useBooksStore.getState().data.accounts.find((a) => a.id === 'acc-ar')!.balance
    assert.ok(arAfterPost > 0)

    // 3. Mark as Paid
    await store.markInvoicePaid('lifecycle-inv-1')
    assert.strictEqual(useBooksStore.getState().data.journalEntries.length, baselineJournalsCount + 2)

    // 4. Delete the invoice
    await store.deleteInvoice('lifecycle-inv-1')

    // After deletion, journal entries matching invoice must be purged
    const afterDeleteState = useBooksStore.getState().data
    assert.strictEqual(afterDeleteState.journalEntries.length, baselineJournalsCount)
    assert.strictEqual(JSON.stringify(afterDeleteState.accounts), baselineAccounts)
    assert.strictEqual(JSON.stringify(afterDeleteState.parties), baselineParties)
  })

  // =========================================================================
  // CHECK 5: 500-Iteration High-Stress Randomized Fuzzer
  // =========================================================================
  console.log('\n--- CHECK 5: 500-Iteration High-Stress Randomized Fuzzer ---')

  await test('Check 5', '5.1 500 randomized multi-line transactions strictly satisfy debits === credits and party invariants', async () => {
    resetStore()
    const store = useBooksStore.getState()

    for (let i = 0; i < 500; i++) {
      const isSales = Math.random() > 0.4
      const itemCount = Math.floor(Math.random() * 5) + 1
      const partyId = isSales ? (Math.random() > 0.5 ? 'party-1' : 'party-2') : (Math.random() > 0.5 ? 'party-4' : 'party-5')
      const partyName = isSales ? 'Customer' : 'Supplier'
      const status = Math.random() > 0.25 ? 'Unpaid' : 'Paid'

      const incomeAccs = ['acc-sales', 'acc-consult']
      const expenseAccs = ['acc-materials', 'acc-rent', 'acc-salaries', 'acc-utilities', 'acc-travel']

      const items: InvoiceItem[] = []
      for (let j = 0; j < itemCount; j++) {
        // Occasionally include fractional odd quantities and rates
        const qty = Math.random() > 0.3 ? Math.floor(Math.random() * 10) + 1 : Math.round((Math.random() * 8 + 0.333) * 1000) / 1000
        const rate = Math.random() > 0.3 ? Math.round((Math.random() * 5000 + 10) * 100) / 100 : Math.round((Math.random() * 5000 + 0.999) * 100) / 100
        const isDiscount = j > 0 && Math.random() < 0.15 // 15% chance of discount line
        const finalRate = isDiscount ? -Math.abs(rate) : rate
        const taxRate = Math.random() > 0.2 ? 15 : 0

        const accId = isSales
          ? incomeAccs[Math.floor(Math.random() * incomeAccs.length)]
          : expenseAccs[Math.floor(Math.random() * expenseAccs.length)]

        items.push({
          id: `fuzz-${i}-${j}`,
          itemCode: `FZ-${j}`,
          description: `Fuzzer item ${j}`,
          accountId: accId,
          qty,
          rate: finalRate,
          taxRate,
          amount: round2(qty * finalRate),
        })
      }

      await store.saveInvoice({
        type: isSales ? 'Sales' : 'Purchase',
        partyId,
        partyName,
        status,
        items,
      })

      const curState = useBooksStore.getState().data

      // Check debits === credits on all generated journals
      const journalsToCheck = status === 'Paid' ? [curState.journalEntries[0], curState.journalEntries[1]] : [curState.journalEntries[0]]
      for (const je of journalsToCheck) {
        assert.strictEqual(
          je.totalDebit,
          je.totalCredit,
          `Fuzz iter ${i}: JE ${je.entryNumber} debits (${je.totalDebit}) !== credits (${je.totalCredit})`
        )
      }

      // Check party outstanding balance invariant
      for (const p of curState.parties) {
        const expected = curState.invoices
          .filter((inv) => inv.partyId === p.id && inv.status !== 'Paid' && inv.status !== 'Cancelled')
          .reduce((s, inv) => round2(s + (inv.outstandingAmount ?? inv.grandTotal)), 0)
        assert.strictEqual(
          p.outstandingBalance,
          round2(expected),
          `Fuzz iter ${i}: Party ${p.name} balance mismatch: ${p.outstandingBalance} vs ${expected}`
        )
      }
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
  console.error('Fatal error in deep challenger runner:', err)
  process.exit(1)
})

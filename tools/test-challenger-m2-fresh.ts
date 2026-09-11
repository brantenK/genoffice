/**
 * tools/test-challenger-m2-fresh.ts
 *
 * EMPIRICAL ADVERSARIAL CHALLENGER TEST SUITE (M2)
 * Agent: challenger_2_books_m2_fresh
 *
 * Test Suites:
 * Suite 1: High-value & decimal edge cases (odd decimals, 0% tax, 15% tax, mixed +/- discount lines)
 * Suite 2: Immediate settlement on creation (saveInvoice with status: 'Paid' for Sales and Purchase)
 * Suite 3: Multi-line split expense purchase bills (acc-materials, acc-rent, acc-utilities + VAT Input)
 * Suite 4: Adversarial Stress & Fuzzing (150 randomized edge cases with extreme numbers and party invariants)
 */

import assert from 'node:assert'
import { useBooksStore } from '../apps/books/src/renderer/src/store'
import { initialBooksData } from '../apps/books/src/renderer/src/mock/initialData'
import {
  round2,
  calculateInvoiceTotals,
  createSalesInvoiceJournal,
  createPurchaseBillJournal,
  createSettlementJournal,
  recomputePartyBalances,
} from '../apps/books/src/shared/accounting'
import type { Invoice, InvoiceItem } from '../apps/books/src/shared/types'

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
    if (err.stack) console.error(err.stack)
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
  console.log('   CHALLENGER 2: EMPIRICAL ADVERSARIAL VERIFICATION SUITE (M2)')
  console.log('======================================================================\n')

  // ====================================================================
  // SUITE 1: High-value & decimal edge cases
  // ====================================================================
  console.log('--- SUITE 1: High-Value & Decimal Edge Cases ---')

  await test('Suite 1', '1.1 Sales invoice with odd decimals and 1/3 rate (subtotal + tax === grandTotal strictly)', async () => {
    resetStore()
    const store = useBooksStore.getState()

    const items: InvoiceItem[] = [
      {
        id: 'odd-1',
        itemCode: 'ODD-1',
        description: 'Odd rate consulting',
        accountId: 'acc-consult',
        accountName: 'Professional Advisory Fees',
        qty: 3,
        rate: 33.333, // 3 * 33.333 = 99.999 => rounds to 100.00
        taxRate: 15, // 15% of 100 = 15.00
        amount: 100.0,
      },
      {
        id: 'odd-2',
        itemCode: 'ODD-2',
        description: 'Fractional quantity item',
        accountId: 'acc-sales',
        accountName: 'Tender & Commercial Contracting Sales',
        qty: 7,
        rate: 13.97, // 7 * 13.97 = 97.79
        taxRate: 15, // 15% of 97.79 = 14.6685 => 14.67
        amount: 97.79,
      },
    ]

    const totals = calculateInvoiceTotals(items)
    assert.strictEqual(totals.subtotal, 197.79)
    assert.strictEqual(totals.taxTotal, 29.67) // 15.00 + 14.67 = 29.67
    assert.strictEqual(totals.grandTotal, 227.46) // 197.79 + 29.67 = 227.46
    assert.strictEqual(totals.grandTotal, round2(totals.subtotal + totals.taxTotal))

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 227.46)
    assert.strictEqual(je.totalCredit, 227.46)
    assert.strictEqual(je.totalDebit, je.totalCredit)
  })

  await test('Suite 1', '1.2 Mixed 0% and 15% tax lines on Sales invoice', async () => {
    resetStore()
    const store = useBooksStore.getState()

    const items: InvoiceItem[] = [
      {
        id: 'tax-15',
        itemCode: 'STD-1',
        description: 'Standard taxable supply',
        accountId: 'acc-sales',
        accountName: 'Tender Sales',
        qty: 1,
        rate: 1000.0,
        taxRate: 15,
        amount: 1000.0,
      },
      {
        id: 'tax-0',
        itemCode: 'ZERO-1',
        description: 'Zero-rated municipal export',
        accountId: 'acc-consult',
        accountName: 'Advisory',
        qty: 1,
        rate: 500.0,
        taxRate: 0,
        amount: 500.0,
      },
    ]

    const totals = calculateInvoiceTotals(items)
    assert.strictEqual(totals.subtotal, 1500.0)
    assert.strictEqual(totals.taxTotal, 150.0)
    assert.strictEqual(totals.grandTotal, 1650.0)

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 1650.0)
    assert.strictEqual(je.totalCredit, 1650.0)

    const vatItem = je.items.find((it) => it.accountId === 'acc-vat')
    assert.ok(vatItem)
    assert.strictEqual(vatItem.credit, 150.0)
  })

  await test('Suite 1', '1.3 Mixed positive and negative lines (discounts) strictly balance debits === credits', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialSales = store.data.accounts.find((a) => a.id === 'acc-sales')!.balance
    const initialAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
    const initialVat = store.data.accounts.find((a) => a.id === 'acc-vat')!.balance

    const items: InvoiceItem[] = [
      {
        id: 'disc-base',
        itemCode: 'BASE-1',
        description: 'Base Project Contract',
        accountId: 'acc-sales',
        accountName: 'Tender Sales',
        qty: 1,
        rate: 100000.0,
        taxRate: 15,
        amount: 100000.0,
      },
      {
        id: 'disc-neg',
        itemCode: 'DISC-1',
        description: 'Contract Negotiated Discount',
        accountId: 'acc-sales',
        accountName: 'Tender Sales',
        qty: 1,
        rate: -15000.0,
        taxRate: 15,
        amount: -15000.0,
      },
      {
        id: 'disc-rebate',
        itemCode: 'REB-1',
        description: 'Zero-rated Prompt Settlement Rebate',
        accountId: 'acc-sales',
        accountName: 'Tender Sales',
        qty: 1,
        rate: -5000.0,
        taxRate: 0,
        amount: -5000.0,
      },
    ]

    // subtotal = 100000 - 15000 - 5000 = 80000
    // taxTotal = 15000 - 2250 + 0 = 12750
    // grandTotal = 80000 + 12750 = 92750
    const totals = calculateInvoiceTotals(items)
    assert.strictEqual(totals.subtotal, 80000.0)
    assert.strictEqual(totals.taxTotal, 12750.0)
    assert.strictEqual(totals.grandTotal, 92750.0)

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 92750.0)
    assert.strictEqual(je.totalCredit, 92750.0)
    assert.strictEqual(je.totalDebit, je.totalCredit)

    // Ledger accounts
    const newAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
    const newSales = updated.accounts.find((a) => a.id === 'acc-sales')!.balance
    const newVat = updated.accounts.find((a) => a.id === 'acc-vat')!.balance
    assert.strictEqual(newAr, round2(initialAr + 92750.0))
    assert.strictEqual(newSales, round2(initialSales + 80000.0))
    assert.strictEqual(newVat, round2(initialVat + 12750.0))
  })

  await test('Suite 1', '1.4 Multi-account discounts with distinct debit lines in Journal Entry', async () => {
    resetStore()
    const store = useBooksStore.getState()

    // Line 1: acc-sales positive
    // Line 2: acc-consult negative (discount on consulting)
    const items: InvoiceItem[] = [
      {
        id: 'd-1',
        itemCode: 'S-1',
        description: 'Sales component',
        accountId: 'acc-sales',
        accountName: 'Tender Sales',
        qty: 1,
        rate: 50000.0,
        taxRate: 15,
        amount: 50000.0,
      },
      {
        id: 'd-2',
        itemCode: 'C-DISC',
        description: 'Consulting Credit / Discount',
        accountId: 'acc-consult',
        accountName: 'Consulting',
        qty: 1,
        rate: -10000.0,
        taxRate: 15,
        amount: -10000.0,
      },
    ]

    // subtotal = 40000, tax = 6000, grandTotal = 46000
    const totals = calculateInvoiceTotals(items)
    assert.strictEqual(totals.subtotal, 40000.0)
    assert.strictEqual(totals.taxTotal, 6000.0)
    assert.strictEqual(totals.grandTotal, 46000.0)

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-2',
      partyName: 'Transnet Freight Rail Logistics',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const je = updated.journalEntries[0]
    // AR debit = 46000, Discount debit = 10000 => totalDebit = 56000
    // Sales credit = 50000, VAT credit = 6000 => totalCredit = 56000
    assert.strictEqual(je.totalDebit, je.totalCredit)
    assert.strictEqual(je.totalDebit, 56000.0)
  })

  await test('Suite 1', '1.5 Extreme high-value transaction (R 99,999,999.99)', async () => {
    resetStore()
    const store = useBooksStore.getState()

    const items: InvoiceItem[] = [
      {
        id: 'mega-1',
        itemCode: 'MEGA-1',
        description: 'National Infrastructure Mega Project',
        accountId: 'acc-sales',
        accountName: 'Tender Sales',
        qty: 1,
        rate: 99999999.99,
        taxRate: 15,
        amount: 99999999.99,
      },
    ]

    const totals = calculateInvoiceTotals(items)
    // 99,999,999.99 * 0.15 = 14,999,999.9985 => 15,000,000.00
    assert.strictEqual(totals.subtotal, 99999999.99)
    assert.strictEqual(totals.taxTotal, 15000000.0)
    assert.strictEqual(totals.grandTotal, 114999999.99)

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 114999999.99)
    assert.strictEqual(je.totalCredit, 114999999.99)
    assert.strictEqual(je.totalDebit, je.totalCredit)
  })

  // ====================================================================
  // SUITE 2: Immediate settlement on creation
  // ====================================================================
  console.log('\n--- SUITE 2: Immediate Settlement on Creation ---')

  await test('Suite 2', '2.1 Sales invoice created with status: "Paid" creates BOTH posting and settlement journals, updates Bank & AR', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialBank = store.data.accounts.find((a) => a.id === 'acc-bank')!.balance
    const initialAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
    const initialSales = store.data.accounts.find((a) => a.id === 'acc-sales')!.balance
    const initialVat = store.data.accounts.find((a) => a.id === 'acc-vat')!.balance
    const initialJournalsCount = store.data.journalEntries.length
    const initialParty1Balance = store.data.parties.find((p) => p.id === 'party-1')!.outstandingBalance

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Paid',
      items: [
        {
          id: 'imm-1',
          itemCode: 'IMM-S',
          description: 'Immediate Card Sales',
          accountId: 'acc-sales',
          accountName: 'Tender Sales',
          qty: 2,
          rate: 25000,
          taxRate: 15,
          amount: 50000,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const createdInv = updated.invoices[0]
    assert.strictEqual(createdInv.status, 'Paid')
    assert.strictEqual(createdInv.grandTotal, 57500)
    assert.strictEqual(createdInv.outstandingAmount, 0)

    // Exactly 2 journal entries added
    assert.strictEqual(updated.journalEntries.length, initialJournalsCount + 2)
    const settlementJe = updated.journalEntries[0]
    const postingJe = updated.journalEntries[1]

    // Verify Posting Journal
    assert.strictEqual(postingJe.totalDebit, 57500)
    assert.strictEqual(postingJe.totalCredit, 57500)
    const arPost = postingJe.items.find((it) => it.accountId === 'acc-ar')
    const salesPost = postingJe.items.find((it) => it.accountId === 'acc-sales')
    const vatPost = postingJe.items.find((it) => it.accountId === 'acc-vat')
    assert.ok(arPost && arPost.debit === 57500)
    assert.ok(salesPost && salesPost.credit === 50000)
    assert.ok(vatPost && vatPost.credit === 7500)

    // Verify Settlement Journal
    assert.strictEqual(settlementJe.totalDebit, 57500)
    assert.strictEqual(settlementJe.totalCredit, 57500)
    const bankSettle = settlementJe.items.find((it) => it.accountId === 'acc-bank')
    const arSettle = settlementJe.items.find((it) => it.accountId === 'acc-ar')
    assert.ok(bankSettle && bankSettle.debit === 57500)
    assert.ok(arSettle && arSettle.credit === 57500)

    // Balances
    const newBank = updated.accounts.find((a) => a.id === 'acc-bank')!.balance
    const newAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
    const newSales = updated.accounts.find((a) => a.id === 'acc-sales')!.balance
    const newVat = updated.accounts.find((a) => a.id === 'acc-vat')!.balance
    assert.strictEqual(newBank, round2(initialBank + 57500))
    assert.strictEqual(newAr, initialAr) // Net AR unchanged because it was debited then immediately credited
    assert.strictEqual(newSales, round2(initialSales + 50000))
    assert.strictEqual(newVat, round2(initialVat + 7500))

    // Party balance invariant: customer paid immediately so outstandingBalance remains unchanged
    const newParty1Balance = updated.parties.find((p) => p.id === 'party-1')!.outstandingBalance
    assert.strictEqual(newParty1Balance, initialParty1Balance)
  })

  await test('Suite 2', '2.2 Purchase bill created with status: "Paid" creates BOTH posting and settlement journals, updates Bank & AP', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialBank = store.data.accounts.find((a) => a.id === 'acc-bank')!.balance
    const initialAp = store.data.accounts.find((a) => a.id === 'acc-ap')!.balance
    const initialMaterials = store.data.accounts.find((a) => a.id === 'acc-materials')!.balance
    const initialVatIn = (store.data.accounts.find((a) => a.id === 'acc-vat-in') || store.data.accounts.find((a) => a.id === 'acc-vat')!).balance
    const initialJournalsCount = store.data.journalEntries.length
    const initialParty4Balance = store.data.parties.find((p) => p.id === 'party-4')!.outstandingBalance

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Paid',
      items: [
        {
          id: 'imm-p-1',
          itemCode: 'MAT-IMM',
          description: 'Instant Cash Purchase Materials',
          accountId: 'acc-materials',
          accountName: 'Materials',
          qty: 1,
          rate: 30000,
          taxRate: 15,
          amount: 30000,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const createdBill = updated.invoices[0]
    assert.strictEqual(createdBill.status, 'Paid')
    assert.strictEqual(createdBill.grandTotal, 34500)
    assert.strictEqual(createdBill.outstandingAmount, 0)

    // Exactly 2 journal entries added
    assert.strictEqual(updated.journalEntries.length, initialJournalsCount + 2)
    const settlementJe = updated.journalEntries[0]
    const postingJe = updated.journalEntries[1]

    // Verify Posting Journal (Debit Expense & VAT Input, Credit AP)
    assert.strictEqual(postingJe.totalDebit, 34500)
    assert.strictEqual(postingJe.totalCredit, 34500)
    const apPost = postingJe.items.find((it) => it.accountId === 'acc-ap')
    const matPost = postingJe.items.find((it) => it.accountId === 'acc-materials')
    const vatPost = postingJe.items.find((it) => it.accountId === 'acc-vat-in' || it.accountId === 'acc-vat')
    assert.ok(apPost && apPost.credit === 34500)
    assert.ok(matPost && matPost.debit === 30000)
    assert.ok(vatPost && vatPost.debit === 4500)

    // Verify Settlement Journal (Debit AP, Credit Bank)
    assert.strictEqual(settlementJe.totalDebit, 34500)
    assert.strictEqual(settlementJe.totalCredit, 34500)
    const apSettle = settlementJe.items.find((it) => it.accountId === 'acc-ap')
    const bankSettle = settlementJe.items.find((it) => it.accountId === 'acc-bank')
    assert.ok(apSettle && apSettle.debit === 34500)
    assert.ok(bankSettle && bankSettle.credit === 34500)

    // Balances
    const newBank = updated.accounts.find((a) => a.id === 'acc-bank')!.balance
    const newAp = updated.accounts.find((a) => a.id === 'acc-ap')!.balance
    const newMaterials = updated.accounts.find((a) => a.id === 'acc-materials')!.balance
    const newVatIn = (updated.accounts.find((a) => a.id === 'acc-vat-in') || updated.accounts.find((a) => a.id === 'acc-vat')!).balance
    assert.strictEqual(newBank, round2(initialBank - 34500))
    assert.strictEqual(newAp, initialAp) // Net AP unchanged because it was credited then immediately debited
    assert.strictEqual(newMaterials, round2(initialMaterials + 30000))
    assert.strictEqual(newVatIn, round2(initialVatIn + 4500))

    // Party balance invariant: supplier bill paid immediately so outstandingBalance remains unchanged
    const newParty4Balance = updated.parties.find((p) => p.id === 'party-4')!.outstandingBalance
    assert.strictEqual(newParty4Balance, initialParty4Balance)
  })

  // ====================================================================
  // SUITE 3: Multi-line split expense purchase bills
  // ====================================================================
  console.log('\n--- SUITE 3: Multi-Line Split Expense Purchase Bills ---')

  await test('Suite 3', '3.1 Purchase bill with split expenses across acc-materials, acc-rent, acc-utilities + acc-vat-in', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialMaterials = store.data.accounts.find((a) => a.id === 'acc-materials')!.balance
    const initialRent = store.data.accounts.find((a) => a.id === 'acc-rent')!.balance
    const initialUtilities = store.data.accounts.find((a) => a.id === 'acc-utilities')!.balance
    const initialAp = store.data.accounts.find((a) => a.id === 'acc-ap')!.balance
    const vatInAcc = store.data.accounts.find((a) => a.id === 'acc-vat-in') || store.data.accounts.find((a) => a.id === 'acc-vat')!
    const initialVatIn = vatInAcc.balance

    const items: InvoiceItem[] = [
      {
        id: 'split-1',
        itemCode: 'MAT-SPLIT',
        description: 'Concrete and Reinforcing Steel',
        accountId: 'acc-materials',
        accountName: 'Direct Project Materials & Subcontractors',
        qty: 5,
        rate: 12000,
        taxRate: 15,
        amount: 60000, // tax: 9000
      },
      {
        id: 'split-2',
        itemCode: 'RNT-SPLIT',
        description: 'Temporary Site Compound Rent',
        accountId: 'acc-rent',
        accountName: 'Office Rent & Facilities',
        qty: 1,
        rate: 18000,
        taxRate: 15,
        amount: 18000, // tax: 2700
      },
      {
        id: 'split-3',
        itemCode: 'UTL-SPLIT',
        description: 'Construction Generator Diesel & Utilities',
        accountId: 'acc-utilities',
        accountName: 'Water & Electricity Utilities',
        qty: 1,
        rate: 4500,
        taxRate: 15,
        amount: 4500, // tax: 675
      },
    ]

    // subtotal = 60000 + 18000 + 4500 = 82500
    // taxTotal = 9000 + 2700 + 675 = 12375
    // grandTotal = 82500 + 12375 = 94875
    const totals = calculateInvoiceTotals(items)
    assert.strictEqual(totals.subtotal, 82500)
    assert.strictEqual(totals.taxTotal, 12375)
    assert.strictEqual(totals.grandTotal, 94875)

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 94875)
    assert.strictEqual(je.totalCredit, 94875)
    assert.strictEqual(je.totalDebit, je.totalCredit)

    // Verify journal items
    const matJe = je.items.find((it) => it.accountId === 'acc-materials')
    const rentJe = je.items.find((it) => it.accountId === 'acc-rent')
    const utlJe = je.items.find((it) => it.accountId === 'acc-utilities')
    const vatInJe = je.items.find((it) => it.accountId === 'acc-vat-in' || it.accountId === 'acc-vat')
    const apJe = je.items.find((it) => it.accountId === 'acc-ap')

    assert.ok(matJe, 'acc-materials must be in journal')
    assert.strictEqual(matJe.debit, 60000)
    assert.strictEqual(matJe.credit, 0)

    assert.ok(rentJe, 'acc-rent must be in journal')
    assert.strictEqual(rentJe.debit, 18000)
    assert.strictEqual(rentJe.credit, 0)

    assert.ok(utlJe, 'acc-utilities must be in journal')
    assert.strictEqual(utlJe.debit, 4500)
    assert.strictEqual(utlJe.credit, 0)

    assert.ok(vatInJe, 'VAT Input must be in journal')
    assert.strictEqual(vatInJe.debit, 12375)
    assert.strictEqual(vatInJe.credit, 0)

    assert.ok(apJe, 'acc-ap must be in journal')
    assert.strictEqual(apJe.credit, 94875)
    assert.strictEqual(apJe.debit, 0)

    // Verify account balance updates
    const newMaterials = updated.accounts.find((a) => a.id === 'acc-materials')!.balance
    const newRent = updated.accounts.find((a) => a.id === 'acc-rent')!.balance
    const newUtilities = updated.accounts.find((a) => a.id === 'acc-utilities')!.balance
    const newVatIn = (updated.accounts.find((a) => a.id === 'acc-vat-in') || updated.accounts.find((a) => a.id === 'acc-vat')!).balance
    const newAp = updated.accounts.find((a) => a.id === 'acc-ap')!.balance

    assert.strictEqual(newMaterials, round2(initialMaterials + 60000))
    assert.strictEqual(newRent, round2(initialRent + 18000))
    assert.strictEqual(newUtilities, round2(initialUtilities + 4500))
    assert.strictEqual(newVatIn, round2(initialVatIn + 12375))
    assert.strictEqual(newAp, round2(initialAp + 94875))
  })

  await test('Suite 3', '3.2 Multi-line split expense with mixed tax rates (15% on materials & utilities, 0% on rent)', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialMaterials = store.data.accounts.find((a) => a.id === 'acc-materials')!.balance
    const initialRent = store.data.accounts.find((a) => a.id === 'acc-rent')!.balance
    const initialUtilities = store.data.accounts.find((a) => a.id === 'acc-utilities')!.balance
    const initialVatIn = (store.data.accounts.find((a) => a.id === 'acc-vat-in') || store.data.accounts.find((a) => a.id === 'acc-vat')!).balance

    const items: InvoiceItem[] = [
      {
        id: 'mix-1',
        itemCode: 'MAT-1',
        description: 'Materials (Taxable)',
        accountId: 'acc-materials',
        accountName: 'Materials',
        qty: 1,
        rate: 10000,
        taxRate: 15,
        amount: 10000, // tax: 1500
      },
      {
        id: 'mix-2',
        itemCode: 'RNT-EXEMPT',
        description: 'Residential Staff Accommodation Rent (Exempt 0%)',
        accountId: 'acc-rent',
        accountName: 'Rent',
        qty: 1,
        rate: 8000,
        taxRate: 0,
        amount: 8000, // tax: 0
      },
      {
        id: 'mix-3',
        itemCode: 'UTL-1',
        description: 'Utilities (Taxable)',
        accountId: 'acc-utilities',
        accountName: 'Utilities',
        qty: 1,
        rate: 2000,
        taxRate: 15,
        amount: 2000, // tax: 300
      },
    ]

    // subtotal = 20000, taxTotal = 1800, grandTotal = 21800
    const totals = calculateInvoiceTotals(items)
    assert.strictEqual(totals.subtotal, 20000)
    assert.strictEqual(totals.taxTotal, 1800)
    assert.strictEqual(totals.grandTotal, 21800)

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items,
    })

    const updated = useBooksStore.getState().data
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 21800)
    assert.strictEqual(je.totalCredit, 21800)

    const newMaterials = updated.accounts.find((a) => a.id === 'acc-materials')!.balance
    const newRent = updated.accounts.find((a) => a.id === 'acc-rent')!.balance
    const newUtilities = updated.accounts.find((a) => a.id === 'acc-utilities')!.balance
    const newVatIn = (updated.accounts.find((a) => a.id === 'acc-vat-in') || updated.accounts.find((a) => a.id === 'acc-vat')!).balance

    assert.strictEqual(newMaterials, round2(initialMaterials + 10000))
    assert.strictEqual(newRent, round2(initialRent + 8000))
    assert.strictEqual(newUtilities, round2(initialUtilities + 2000))
    assert.strictEqual(newVatIn, round2(initialVatIn + 1800))
  })

  // ====================================================================
  // SUITE 4: Adversarial Stress & Fuzzing
  // ====================================================================
  console.log('\n--- SUITE 4: Adversarial Stress & Fuzzing ---')

  await test('Suite 4', '4.1 150-iteration randomized stress fuzzer with discounts, odd decimals, and zero-tax lines', async () => {
    resetStore()
    const store = useBooksStore.getState()

    const salesAccounts = ['acc-sales', 'acc-consult', 'acc-interest-income']
    const expenseAccounts = ['acc-materials', 'acc-rent', 'acc-utilities', 'acc-salaries', 'acc-travel']

    for (let i = 0; i < 150; i++) {
      const isSales = Math.random() > 0.5
      const itemCount = Math.floor(Math.random() * 5) + 1
      const partyId = isSales ? (Math.random() > 0.5 ? 'party-1' : 'party-2') : 'party-4'
      const partyName = isSales ? 'Customer' : 'Supplier'
      const status = Math.random() > 0.3 ? 'Unpaid' : 'Paid'

      const items: InvoiceItem[] = []
      for (let j = 0; j < itemCount; j++) {
        // Occasionally inject negative line (discount) if not the first line
        const isDiscount = j > 0 && Math.random() > 0.75
        const sign = isDiscount ? -1 : 1
        const qty = Math.floor(Math.random() * 10) + 1
        // Random odd decimal rate: 10.33, 499.99, 1234.567
        const rate = round2((Math.random() * 5000 + 1) * sign)
        const taxRate = Math.random() > 0.3 ? 15 : 0
        const accPool = isSales ? salesAccounts : expenseAccounts
        const accId = accPool[Math.floor(Math.random() * accPool.length)]

        items.push({
          id: `fuzz-${i}-${j}`,
          itemCode: `FZ-${j}`,
          description: `Fuzz line ${j}`,
          accountId: accId,
          accountName: accId,
          qty,
          rate,
          taxRate,
          amount: round2(qty * rate),
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
      const latestJe = curState.journalEntries[0]
      assert.strictEqual(
        latestJe.totalDebit,
        latestJe.totalCredit,
        `Fuzz iteration ${i}: JE ${latestJe.entryNumber} debits (${latestJe.totalDebit}) !== credits (${latestJe.totalCredit})`
      )

      // Check Party Balance invariant: party.outstandingBalance === sum(open invoices)
      for (const party of curState.parties) {
        const expected = curState.invoices
          .filter((inv) => inv.partyId === party.id && inv.status !== 'Paid' && inv.status !== 'Cancelled')
          .reduce((sum, inv) => round2(sum + (inv.outstandingAmount ?? inv.grandTotal)), 0)

        assert.strictEqual(
          party.outstandingBalance,
          round2(expected),
          `Fuzz iteration ${i}: Party ${party.name} balance ${party.outstandingBalance} !== expected ${expected}`
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
  console.error('Fatal error running challenger tests:', err)
  process.exit(1)
})

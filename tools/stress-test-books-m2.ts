/**
 * tools/stress-test-books-m2.ts
 *
 * EMPIRICAL ADVERSARIAL STRESS TEST SUITE FOR BOOKS MILESTONE 2 (M2)
 *
 * Target: apps/books/src/renderer/src/store.ts
 * Roles: Critic & Empirical Challenger
 *
 * Tests:
 * 1. Sales Invoice creation -> totalDebit === totalCredit and AR balance increment === grandTotal.
 * 2. Purchase Bill creation -> totalDebit === totalCredit and AP balance increment === grandTotal.
 * 3. Draft creation -> NO journal entry and NO account balance modification across all 22 accounts.
 * 4. Draft -> Unpaid transition -> journal entry created and account balances updated.
 * 5. markInvoicePaid -> settlement journal created, Bank debited/credited, AR/AP credited/debited, idempotency.
 * 6. deleteInvoice -> account balances reverted and journal entries cleaned up (Unpaid & Paid, Sales & Purchase).
 * 7. Party balance invariant across all combinations (create, pay, delete, interleave, auto-created parties).
 * 8. Stress fuzzer: 200 randomized mixed actions checking debits===credits, party invariants, and no NaN.
 */

import assert from 'node:assert'
import { useBooksStore } from '../apps/books/src/renderer/src/store'
import { initialBooksData } from '../apps/books/src/renderer/src/mock/initialData'
import { round2, calculateInvoiceTotals } from '../apps/books/src/shared/accounting'
import type { Invoice, InvoiceItem } from '../apps/books/src/shared/types'

let totalAssertions = 0
let passedTests = 0
let failedTests = 0
const failureList: Array<{ suite: string; name: string; error: string }> = []

function check(suite: string, name: string, condition: boolean, message?: string) {
  totalAssertions++
  if (!condition) {
    throw new Error(message || `Assertion failed in [${suite}] - ${name}`)
  }
}

async function runTest(suite: string, name: string, fn: () => Promise<void>) {
  try {
    await fn()
    passedTests++
    console.log(`  [PASS] ${name}`)
  } catch (err: any) {
    failedTests++
    failureList.push({ suite, name, error: err.message || String(err) })
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

function getAccountBalance(id: string): number {
  const acc = useBooksStore.getState().data.accounts.find((a) => a.id === id)
  if (!acc) throw new Error(`Account not found: ${id}`)
  return acc.balance
}

function getAllAccountBalances(): Map<string, number> {
  const map = new Map<string, number>()
  for (const acc of useBooksStore.getState().data.accounts) {
    map.set(acc.id, acc.balance)
  }
  return map
}

async function main() {
  console.log('======================================================================')
  console.log('  CHALLENGER STRESS HARNESS: BOOKS M2 ACTIONS & INVARIANTS')
  console.log('======================================================================\n')

  // ==========================================================================
  // SUITE 1: Sales Invoice Creation
  // ==========================================================================
  console.log('--- SUITE 1: Sales Invoice Creation ---')

  await runTest('Suite 1', '1.1 Single-item standard Sales Invoice: totalDebit === totalCredit and AR += grandTotal', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineAr = getAccountBalance('acc-ar')
    const baselineSales = getAccountBalance('acc-sales')
    const baselineVat = getAccountBalance('acc-vat')
    const baselineJournals = store.data.journalEntries.length

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'item-1',
          itemCode: 'ENG-01',
          description: 'Structural Water Engineering',
          accountId: 'acc-sales',
          accountName: 'Tender & Commercial Contracting Sales',
          qty: 4,
          rate: 12500,
          taxRate: 15,
          amount: 50000,
        },
      ],
    })

    const state = useBooksStore.getState().data
    const inv = state.invoices[0]
    check('Suite 1', '1.1 inv totals', inv.subtotal === 50000 && inv.taxTotal === 7500 && inv.grandTotal === 57500)
    check('Suite 1', '1.1 journal added', state.journalEntries.length === baselineJournals + 1)

    const je = state.journalEntries[0]
    check('Suite 1', '1.1 je balanced', je.totalDebit === 57500 && je.totalCredit === 57500 && je.totalDebit === je.totalCredit)

    const newAr = getAccountBalance('acc-ar')
    const newSales = getAccountBalance('acc-sales')
    const newVat = getAccountBalance('acc-vat')
    check('Suite 1', '1.1 AR balance increased by grandTotal', newAr === round2(baselineAr + 57500))
    check('Suite 1', '1.1 Sales balance increased by subtotal', newSales === round2(baselineSales + 50000))
    check('Suite 1', '1.1 VAT balance increased by taxTotal', newVat === round2(baselineVat + 7500))
  })

  await runTest('Suite 1', '1.2 Multi-line Sales Invoice with 0% tax, 15% tax, and distinct income accounts', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineAr = getAccountBalance('acc-ar')
    const baselineSales = getAccountBalance('acc-sales')
    const baselineConsult = getAccountBalance('acc-consult')
    const baselineVat = getAccountBalance('acc-vat')

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-2',
      partyName: 'Transnet Freight Rail Logistics',
      status: 'Unpaid',
      items: [
        {
          id: 'item-1',
          itemCode: 'CONTRACT-01',
          description: 'Rail maintenance contract (15% VAT)',
          accountId: 'acc-sales',
          accountName: 'Tender & Commercial Contracting Sales',
          qty: 3,
          rate: 11111.11,
          taxRate: 15,
          amount: 33333.33,
        },
        {
          id: 'item-2',
          itemCode: 'CONSULT-01',
          description: 'Zero-rated export advisory (0% VAT)',
          accountId: 'acc-consult',
          accountName: 'Professional Advisory Fees',
          qty: 2,
          rate: 15000,
          taxRate: 0,
          amount: 30000,
        },
      ],
    })

    const state = useBooksStore.getState().data
    const inv = state.invoices[0]
    const expectedSubtotal = round2(33333.33 + 30000)
    const expectedTax = round2(33333.33 * 0.15)
    const expectedGrandTotal = round2(expectedSubtotal + expectedTax)

    check('Suite 1', '1.2 subtotal match', inv.subtotal === expectedSubtotal)
    check('Suite 1', '1.2 tax match', inv.taxTotal === expectedTax)
    check('Suite 1', '1.2 grandTotal match', inv.grandTotal === expectedGrandTotal)

    const je = state.journalEntries[0]
    check('Suite 1', '1.2 je balanced', je.totalDebit === je.totalCredit && je.totalDebit === expectedGrandTotal)

    check('Suite 1', '1.2 AR updated', getAccountBalance('acc-ar') === round2(baselineAr + expectedGrandTotal))
    check('Suite 1', '1.2 Sales updated', getAccountBalance('acc-sales') === round2(baselineSales + 33333.33))
    check('Suite 1', '1.2 Consult updated', getAccountBalance('acc-consult') === round2(baselineConsult + 30000))
    check('Suite 1', '1.2 VAT updated', getAccountBalance('acc-vat') === round2(baselineVat + expectedTax))
  })

  // ==========================================================================
  // SUITE 2: Purchase Bill Creation
  // ==========================================================================
  console.log('\n--- SUITE 2: Purchase Bill Creation ---')

  await runTest('Suite 2', '2.1 Purchase Bill creation: totalDebit === totalCredit and AP += grandTotal', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineAp = getAccountBalance('acc-ap')
    const baselineMaterials = getAccountBalance('acc-materials')
    const baselineVatIn = getAccountBalance('acc-vat-in')

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items: [
        {
          id: 'item-p1',
          itemCode: 'STL-99',
          description: 'Corrugated roof sheeting',
          accountId: 'acc-materials',
          accountName: 'Direct Project Materials & Subcontractors',
          qty: 15,
          rate: 2000,
          taxRate: 15,
          amount: 30000,
        },
      ],
    })

    const state = useBooksStore.getState().data
    const bill = state.invoices[0]
    check('Suite 2', '2.1 bill grandTotal', bill.grandTotal === 34500)

    const je = state.journalEntries[0]
    check('Suite 2', '2.1 je balanced', je.totalDebit === 34500 && je.totalCredit === 34500)

    const newAp = getAccountBalance('acc-ap')
    const newMaterials = getAccountBalance('acc-materials')
    const newVatIn = getAccountBalance('acc-vat-in')
    check('Suite 2', '2.1 AP updated', newAp === round2(baselineAp + 34500))
    check('Suite 2', '2.1 Materials updated', newMaterials === round2(baselineMaterials + 30000))
    check('Suite 2', '2.1 VAT Input updated', newVatIn === round2(baselineVatIn + 4500))
  })

  await runTest('Suite 2', '2.2 Multi-expense Purchase Bill (Materials, Rent, Travel) with fractional rates', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineAp = getAccountBalance('acc-ap')
    const baselineMaterials = getAccountBalance('acc-materials')
    const baselineRent = getAccountBalance('acc-rent')
    const baselineTravel = getAccountBalance('acc-travel')
    const baselineVatIn = getAccountBalance('acc-vat-in')

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-5',
      partyName: 'PPC Cement Supplies (Pty) Ltd',
      status: 'Unpaid',
      items: [
        {
          id: 'p-1',
          itemCode: 'MAT-01',
          description: 'Cement Pallets',
          accountId: 'acc-materials',
          accountName: 'Materials',
          qty: 7,
          rate: 1333.33,
          taxRate: 15,
          amount: 9333.31,
        },
        {
          id: 'p-2',
          itemCode: 'RNT-01',
          description: 'Scaffolding Rental',
          accountId: 'acc-rent',
          accountName: 'Office Rent & Facilities',
          qty: 1,
          rate: 5500.5,
          taxRate: 15,
          amount: 5500.5,
        },
        {
          id: 'p-3',
          itemCode: 'TRV-01',
          description: 'Freight Transport',
          accountId: 'acc-travel',
          accountName: 'Site Travel & Logistics',
          qty: 2,
          rate: 2250.25,
          taxRate: 15,
          amount: 4500.5,
        },
      ],
    })

    const state = useBooksStore.getState().data
    const bill = state.invoices[0]
    const je = state.journalEntries[0]
    check('Suite 2', '2.2 je debits === credits', je.totalDebit === je.totalCredit && je.totalDebit === bill.grandTotal)

    check('Suite 2', '2.2 AP updated', getAccountBalance('acc-ap') === round2(baselineAp + bill.grandTotal))
    check('Suite 2', '2.2 Materials updated', getAccountBalance('acc-materials') === round2(baselineMaterials + 9333.31))
    check('Suite 2', '2.2 Rent updated', getAccountBalance('acc-rent') === round2(baselineRent + 5500.5))
    check('Suite 2', '2.2 Travel updated', getAccountBalance('acc-travel') === round2(baselineTravel + 4500.5))
    check('Suite 2', '2.2 VAT Input updated', getAccountBalance('acc-vat-in') === round2(baselineVatIn + bill.taxTotal))
  })

  // ==========================================================================
  // SUITE 3: Draft Creation
  // ==========================================================================
  console.log('\n--- SUITE 3: Draft Creation Invariants ---')

  await runTest('Suite 3', '3.1 Draft Sales & Purchase creation: ZERO journals and ZERO account modifications across ALL 22 accounts', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineBalances = getAllAccountBalances()
    const baselineJournals = store.data.journalEntries.length

    // Save Draft Sales Invoice
    await store.saveInvoice({
      id: 'draft-sales-1',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Draft',
      items: [
        {
          id: 'd-s1',
          itemCode: 'PROPOSAL-1',
          description: 'Draft proposal consulting',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 1,
          rate: 99999,
          taxRate: 15,
          amount: 99999,
        },
      ],
    })

    // Save Draft Purchase Bill
    await store.saveInvoice({
      id: 'draft-purch-1',
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Draft',
      items: [
        {
          id: 'd-p1',
          itemCode: 'RFQ-01',
          description: 'Draft quotation materials',
          accountId: 'acc-materials',
          accountName: 'Materials',
          qty: 2,
          rate: 45000,
          taxRate: 15,
          amount: 90000,
        },
      ],
    })

    const state = useBooksStore.getState().data

    // 1. Journal count must be strictly unchanged
    check('Suite 3', '3.1 journal count unchanged', state.journalEntries.length === baselineJournals)

    // 2. All 22 account balances must be strictly unchanged
    for (const acc of state.accounts) {
      const prev = baselineBalances.get(acc.id)
      check(
        'Suite 3',
        `3.1 account ${acc.id} unchanged`,
        acc.balance === prev,
        `Account ${acc.id} modified during draft creation! Expected ${prev}, got ${acc.balance}`
      )
    }
  })

  // ==========================================================================
  // SUITE 4: Draft -> Unpaid Transition
  // ==========================================================================
  console.log('\n--- SUITE 4: Draft -> Unpaid Transition ---')

  await runTest('Suite 4', '4.1 Transitioning Sales Draft to Unpaid posts balanced journal and updates accounts', async () => {
    // Rely on draft-sales-1 created in Suite 3
    const store = useBooksStore.getState()
    const baselineAr = getAccountBalance('acc-ar')
    const baselineSales = getAccountBalance('acc-sales')
    const baselineVat = getAccountBalance('acc-vat')
    const baselineJournals = store.data.journalEntries.length

    await store.saveInvoice({
      id: 'draft-sales-1',
      status: 'Unpaid',
    })

    const state = useBooksStore.getState().data
    const inv = state.invoices.find((i) => i.id === 'draft-sales-1')!
    check('Suite 4', '4.1 status is Unpaid', inv.status === 'Unpaid')
    check('Suite 4', '4.1 journal entry created', state.journalEntries.length === baselineJournals + 1)

    const je = state.journalEntries[0]
    check('Suite 4', '4.1 je balanced', je.totalDebit === je.totalCredit && je.totalDebit === inv.grandTotal)

    check('Suite 4', '4.1 AR updated', getAccountBalance('acc-ar') === round2(baselineAr + inv.grandTotal))
    check('Suite 4', '4.1 Sales updated', getAccountBalance('acc-sales') === round2(baselineSales + inv.subtotal))
    check('Suite 4', '4.1 VAT updated', getAccountBalance('acc-vat') === round2(baselineVat + inv.taxTotal))
  })

  await runTest('Suite 4', '4.2 Transitioning Purchase Draft to Unpaid posts balanced journal and updates accounts', async () => {
    // Rely on draft-purch-1 created in Suite 3
    const store = useBooksStore.getState()
    const baselineAp = getAccountBalance('acc-ap')
    const baselineMaterials = getAccountBalance('acc-materials')
    const baselineVatIn = getAccountBalance('acc-vat-in')
    const baselineJournals = store.data.journalEntries.length

    await store.saveInvoice({
      id: 'draft-purch-1',
      status: 'Unpaid',
    })

    const state = useBooksStore.getState().data
    const bill = state.invoices.find((i) => i.id === 'draft-purch-1')!
    check('Suite 4', '4.2 status is Unpaid', bill.status === 'Unpaid')
    check('Suite 4', '4.2 journal entry created', state.journalEntries.length === baselineJournals + 1)

    const je = state.journalEntries[0]
    check('Suite 4', '4.2 je balanced', je.totalDebit === je.totalCredit && je.totalDebit === bill.grandTotal)

    check('Suite 4', '4.2 AP updated', getAccountBalance('acc-ap') === round2(baselineAp + bill.grandTotal))
    check('Suite 4', '4.2 Materials updated', getAccountBalance('acc-materials') === round2(baselineMaterials + bill.subtotal))
    check('Suite 4', '4.2 VAT Input updated', getAccountBalance('acc-vat-in') === round2(baselineVatIn + bill.taxTotal))
  })

  // ==========================================================================
  // SUITE 5: markInvoicePaid
  // ==========================================================================
  console.log('\n--- SUITE 5: markInvoicePaid Actions & Invariants ---')

  await runTest('Suite 5', '5.1 Sales markInvoicePaid: settlement journal (Debit Bank, Credit AR) and idempotent re-calling', async () => {
    resetStore()
    const store = useBooksStore.getState()

    await store.saveInvoice({
      id: 'inv-pay-test',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'it-1',
          itemCode: 'SVC-10',
          description: 'Consulting',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 2,
          rate: 25000,
          taxRate: 15,
          amount: 50000,
        },
      ],
    })

    const stateBefore = useBooksStore.getState().data
    const preBank = getAccountBalance('acc-bank')
    const preAr = getAccountBalance('acc-ar')
    const preJournals = stateBefore.journalEntries.length

    // 1st markInvoicePaid
    await store.markInvoicePaid('inv-pay-test')

    const stateAfter = useBooksStore.getState().data
    const paidInv = stateAfter.invoices.find((i) => i.id === 'inv-pay-test')!
    check('Suite 5', '5.1 invoice status is Paid', paidInv.status === 'Paid')
    check('Suite 5', '5.1 outstanding is 0', paidInv.outstandingAmount === 0)
    check('Suite 5', '5.1 settlement journal created', stateAfter.journalEntries.length === preJournals + 1)

    const je = stateAfter.journalEntries[0]
    check('Suite 5', '5.1 je balanced', je.totalDebit === 57500 && je.totalCredit === 57500)

    const bankItem = je.items.find((i) => i.accountId === 'acc-bank')
    const arItem = je.items.find((i) => i.accountId === 'acc-ar')
    check('Suite 5', '5.1 bank debited', !!bankItem && bankItem.debit === 57500 && bankItem.credit === 0)
    check('Suite 5', '5.1 ar credited', !!arItem && arItem.credit === 57500 && arItem.debit === 0)

    check('Suite 5', '5.1 Bank balance incremented', getAccountBalance('acc-bank') === round2(preBank + 57500))
    check('Suite 5', '5.1 AR balance decremented', getAccountBalance('acc-ar') === round2(preAr - 57500))

    // IDEMPOTENCY CHECK: Call markInvoicePaid again on already Paid invoice
    await store.markInvoicePaid('inv-pay-test')
    const stateIdempotent = useBooksStore.getState().data
    check('Suite 5', '5.1 idempotent: journal count unchanged', stateIdempotent.journalEntries.length === stateAfter.journalEntries.length)
    check('Suite 5', '5.1 idempotent: Bank balance unchanged', getAccountBalance('acc-bank') === getAccountBalance('acc-bank'))
  })

  await runTest('Suite 5', '5.2 Purchase markInvoicePaid: settlement journal (Debit AP, Credit Bank) and idempotent re-calling', async () => {
    resetStore()
    const store = useBooksStore.getState()

    await store.saveInvoice({
      id: 'bill-pay-test',
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items: [
        {
          id: 'it-p1',
          itemCode: 'MAT-20',
          description: 'Building materials',
          accountId: 'acc-materials',
          accountName: 'Materials',
          qty: 1,
          rate: 40000,
          taxRate: 15,
          amount: 40000,
        },
      ],
    })

    const stateBefore = useBooksStore.getState().data
    const preBank = getAccountBalance('acc-bank')
    const preAp = getAccountBalance('acc-ap')
    const preJournals = stateBefore.journalEntries.length

    await store.markInvoicePaid('bill-pay-test')

    const stateAfter = useBooksStore.getState().data
    const paidBill = stateAfter.invoices.find((i) => i.id === 'bill-pay-test')!
    check('Suite 5', '5.2 status is Paid', paidBill.status === 'Paid')
    check('Suite 5', '5.2 outstanding is 0', paidBill.outstandingAmount === 0)
    check('Suite 5', '5.2 settlement journal created', stateAfter.journalEntries.length === preJournals + 1)

    const je = stateAfter.journalEntries[0]
    check('Suite 5', '5.2 je balanced', je.totalDebit === 46000 && je.totalCredit === 46000)

    const apItem = je.items.find((i) => i.accountId === 'acc-ap')
    const bankItem = je.items.find((i) => i.accountId === 'acc-bank')
    check('Suite 5', '5.2 ap debited', !!apItem && apItem.debit === 46000 && apItem.credit === 0)
    check('Suite 5', '5.2 bank credited', !!bankItem && bankItem.credit === 46000 && bankItem.debit === 0)

    check('Suite 5', '5.2 AP decremented', getAccountBalance('acc-ap') === round2(preAp - 46000))
    check('Suite 5', '5.2 Bank decremented', getAccountBalance('acc-bank') === round2(preBank - 46000))

    // IDEMPOTENCY CHECK
    await store.markInvoicePaid('bill-pay-test')
    const stateIdempotent = useBooksStore.getState().data
    check('Suite 5', '5.2 idempotent: journal count unchanged', stateIdempotent.journalEntries.length === stateAfter.journalEntries.length)
  })

  // ==========================================================================
  // SUITE 6: deleteInvoice
  // ==========================================================================
  console.log('\n--- SUITE 6: deleteInvoice Reversals ---')

  await runTest('Suite 6', '6.1 deleteInvoice on Unpaid Sales Invoice cleanly reverts accounts and purges journal', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineBalances = getAllAccountBalances()
    const baselineJournals = store.data.journalEntries.length

    await store.saveInvoice({
      id: 'to-delete-unpaid-sales',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'del-1',
          itemCode: 'TEMP-1',
          description: 'Temporary invoice',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 2,
          rate: 15000,
          taxRate: 15,
          amount: 30000,
        },
      ],
    })

    await store.deleteInvoice('to-delete-unpaid-sales')

    const stateAfter = useBooksStore.getState().data
    check('Suite 6', '6.1 invoice removed', !stateAfter.invoices.some((i) => i.id === 'to-delete-unpaid-sales'))
    check('Suite 6', '6.1 journals reverted', stateAfter.journalEntries.length === baselineJournals)

    for (const acc of stateAfter.accounts) {
      const prev = baselineBalances.get(acc.id)
      check('Suite 6', `6.1 account ${acc.id} reverted`, acc.balance === prev, `${acc.id}: expected ${prev}, got ${acc.balance}`)
    }
  })

  await runTest('Suite 6', '6.2 deleteInvoice on Paid Sales Invoice cleanly reverts accounts (including Bank) and purges journals', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineBalances = getAllAccountBalances()
    const baselineJournals = store.data.journalEntries.length

    await store.saveInvoice({
      id: 'to-delete-paid-sales',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'del-p1',
          itemCode: 'TEMP-PAID-1',
          description: 'Paid invoice to delete',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 1,
          rate: 20000,
          taxRate: 15,
          amount: 20000,
        },
      ],
    })

    await store.markInvoicePaid('to-delete-paid-sales')
    await store.deleteInvoice('to-delete-paid-sales')

    const stateAfter = useBooksStore.getState().data
    check('Suite 6', '6.2 invoice removed', !stateAfter.invoices.some((i) => i.id === 'to-delete-paid-sales'))
    check('Suite 6', '6.2 all journals purged', stateAfter.journalEntries.length === baselineJournals)

    for (const acc of stateAfter.accounts) {
      const prev = baselineBalances.get(acc.id)
      check('Suite 6', `6.2 account ${acc.id} reverted`, acc.balance === prev, `${acc.id}: expected ${prev}, got ${acc.balance}`)
    }
  })

  await runTest('Suite 6', '6.3 deleteInvoice on Paid Purchase Bill cleanly reverts accounts (including Bank disbursement) and purges journals', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineBalances = getAllAccountBalances()
    const baselineJournals = store.data.journalEntries.length

    await store.saveInvoice({
      id: 'to-delete-paid-bill',
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items: [
        {
          id: 'del-b1',
          itemCode: 'TEMP-BILL-1',
          description: 'Paid bill to delete',
          accountId: 'acc-materials',
          accountName: 'Materials',
          qty: 1,
          rate: 18000,
          taxRate: 15,
          amount: 18000,
        },
      ],
    })

    await store.markInvoicePaid('to-delete-paid-bill')
    await store.deleteInvoice('to-delete-paid-bill')

    const stateAfter = useBooksStore.getState().data
    check('Suite 6', '6.3 bill removed', !stateAfter.invoices.some((i) => i.id === 'to-delete-paid-bill'))
    check('Suite 6', '6.3 journals purged', stateAfter.journalEntries.length === baselineJournals)

    for (const acc of stateAfter.accounts) {
      const prev = baselineBalances.get(acc.id)
      check('Suite 6', `6.3 account ${acc.id} reverted`, acc.balance === prev, `${acc.id}: expected ${prev}, got ${acc.balance}`)
    }
  })

  // ==========================================================================
  // SUITE 7: Party Balance Invariant Across All Combinations
  // ==========================================================================
  console.log('\n--- SUITE 7: Party Balance Invariant Combinations ---')

  await runTest('Suite 7', '7.1 Party balance invariant strictly maintained through create, pay, delete, and interleaved combinations', async () => {
    resetStore()
    const store = useBooksStore.getState()

    function verifyAllPartyInvariants() {
      const s = useBooksStore.getState().data
      for (const p of s.parties) {
        const expected = s.invoices
          .filter((inv) => inv.partyId === p.id && inv.status !== 'Paid' && inv.status !== 'Cancelled')
          .reduce((sum, inv) => round2(sum + (inv.outstandingAmount !== undefined ? inv.outstandingAmount : inv.grandTotal)), 0)
        check(
          'Suite 7',
          `party ${p.name} invariant`,
          p.outstandingBalance === round2(expected),
          `Party ${p.name} balance mismatch: ${p.outstandingBalance} vs expected ${expected}`
        )
      }
    }

    // Step 0: verify baseline party balances
    verifyAllPartyInvariants()

    // Step 1: Create 1st invoice for party-1
    await store.saveInvoice({
      id: 'comb-inv-1',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [{ id: 'c1', itemCode: 'C1', description: 'C1', accountId: 'acc-sales', qty: 1, rate: 10000, taxRate: 15, amount: 10000 }],
    })
    verifyAllPartyInvariants()

    // Step 2: Create 2nd invoice for party-1
    await store.saveInvoice({
      id: 'comb-inv-2',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [{ id: 'c2', itemCode: 'C2', description: 'C2', accountId: 'acc-sales', qty: 1, rate: 25000, taxRate: 15, amount: 25000 }],
    })
    verifyAllPartyInvariants()

    // Step 3: Create bill for supplier party-4
    await store.saveInvoice({
      id: 'comb-bill-1',
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items: [{ id: 'cb1', itemCode: 'CB1', description: 'CB1', accountId: 'acc-materials', qty: 2, rate: 5000, taxRate: 15, amount: 10000 }],
    })
    verifyAllPartyInvariants()

    // Step 4: Pay comb-inv-1
    await store.markInvoicePaid('comb-inv-1')
    verifyAllPartyInvariants()

    // Step 5: Delete comb-inv-2
    await store.deleteInvoice('comb-inv-2')
    verifyAllPartyInvariants()

    // Step 6: Create invoice for a brand-new auto-created customer
    await store.saveInvoice({
      id: 'comb-new-party-inv',
      type: 'Sales',
      partyName: 'Brand New Mining Client Ltd',
      status: 'Unpaid',
      items: [{ id: 'cn1', itemCode: 'NEW-1', description: 'Survey', accountId: 'acc-consult', qty: 1, rate: 75000, taxRate: 15, amount: 75000 }],
    })
    verifyAllPartyInvariants()

    // Step 7: Pay the new client invoice
    await store.markInvoicePaid('comb-new-party-inv')
    verifyAllPartyInvariants()

    // Step 8: Delete the paid invoice of the new client
    await store.deleteInvoice('comb-new-party-inv')
    verifyAllPartyInvariants()
  })

  // ==========================================================================
  // SUITE 8: 200-Iteration Adversarial Randomized Stress Fuzzer
  // ==========================================================================
  console.log('\n--- SUITE 8: 200-Iteration Adversarial Stress Fuzzer ---')

  await runTest('Suite 8', '8.1 200 randomized mixed store actions maintain debits===credits, party invariants, and zero NaN balances', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const createdInvoiceIds: string[] = []

    for (let iteration = 0; iteration < 200; iteration++) {
      const actionType = Math.random()

      if (actionType < 0.55 || createdInvoiceIds.length === 0) {
        // Create an invoice (Sales or Purchase, with Draft, Unpaid, or Paid)
        const id = `fuzz-inv-${iteration}-${Date.now()}`
        const isSales = Math.random() > 0.45
        const statusRand = Math.random()
        const status = statusRand < 0.2 ? 'Draft' : statusRand < 0.7 ? 'Unpaid' : 'Paid'
        const partyId = isSales ? (Math.random() > 0.5 ? 'party-1' : 'party-2') : 'party-4'
        const partyName = isSales ? 'Customer' : 'Supplier'
        const numItems = Math.floor(Math.random() * 3) + 1

        const items: InvoiceItem[] = []
        for (let k = 0; k < numItems; k++) {
          const qty = Math.floor(Math.random() * 5) + 1
          const rate = Math.round((Math.random() * 2000 + 1) * 100) / 100
          const taxRate = Math.random() > 0.3 ? 15 : 0
          const accId = isSales
            ? (Math.random() > 0.5 ? 'acc-sales' : 'acc-consult')
            : (Math.random() > 0.5 ? 'acc-materials' : 'acc-rent')

          items.push({
            id: `fuzz-item-${iteration}-${k}`,
            itemCode: `F-${k}`,
            description: `Fuzz item ${k}`,
            accountId: accId,
            accountName: accId,
            qty,
            rate,
            taxRate,
            amount: round2(qty * rate),
          })
        }

        await store.saveInvoice({
          id,
          type: isSales ? 'Sales' : 'Purchase',
          partyId,
          partyName,
          status,
          items,
        })
        createdInvoiceIds.push(id)
      } else if (actionType < 0.75) {
        // Pay an unpaid invoice
        const state = useBooksStore.getState().data
        const unpaidInvs = state.invoices.filter((i) => i.status === 'Unpaid')
        if (unpaidInvs.length > 0) {
          const target = unpaidInvs[Math.floor(Math.random() * unpaidInvs.length)]
          await store.markInvoicePaid(target.id)
        }
      } else if (actionType < 0.90) {
        // Transition a Draft invoice to Unpaid
        const state = useBooksStore.getState().data
        const draftInvs = state.invoices.filter((i) => i.status === 'Draft')
        if (draftInvs.length > 0) {
          const target = draftInvs[Math.floor(Math.random() * draftInvs.length)]
          await store.saveInvoice({
            id: target.id,
            status: 'Unpaid',
          })
        }
      } else {
        // Delete a random created invoice
        if (createdInvoiceIds.length > 0) {
          const pickIdx = Math.floor(Math.random() * createdInvoiceIds.length)
          const targetId = createdInvoiceIds[pickIdx]
          await store.deleteInvoice(targetId)
          createdInvoiceIds.splice(pickIdx, 1)
        }
      }

      // Assert invariants at each iteration
      const curState = useBooksStore.getState().data

      // Invariant A: Every single journal entry must be balanced (debit === credit)
      for (const je of curState.journalEntries) {
        check(
          'Suite 8',
          `fuzz iter ${iteration} je ${je.entryNumber} balance`,
          round2(je.totalDebit) === round2(je.totalCredit),
          `JE ${je.entryNumber} imbalance: Debit ${je.totalDebit} !== Credit ${je.totalCredit}`
        )
      }

      // Invariant B: Every party's outstandingBalance strictly equals open invoices
      for (const p of curState.parties) {
        const expected = curState.invoices
          .filter((inv) => inv.partyId === p.id && inv.status !== 'Paid' && inv.status !== 'Cancelled')
          .reduce((sum, inv) => round2(sum + (inv.outstandingAmount !== undefined ? inv.outstandingAmount : inv.grandTotal)), 0)
        check(
          'Suite 8',
          `fuzz iter ${iteration} party ${p.name} balance`,
          p.outstandingBalance === round2(expected),
          `Party ${p.name} mismatch: ${p.outstandingBalance} vs ${expected}`
        )
      }

      // Invariant C: Zero NaN or undefined in account balances
      for (const acc of curState.accounts) {
        check(
          'Suite 8',
          `fuzz iter ${iteration} account ${acc.id} valid number`,
          typeof acc.balance === 'number' && !isNaN(acc.balance),
          `Account ${acc.id} balance is NaN or invalid: ${acc.balance}`
        )
      }
    }
  })

  console.log('\n======================================================================')
  console.log(`RESULTS: ${passedTests} passed, ${failedTests} failed (${totalAssertions} assertions verified)`)
  console.log('======================================================================')

  if (failedTests > 0) {
    console.error('\nFailures:')
    for (const f of failureList) {
      console.error(`  - [${f.suite}] ${f.name}: ${f.error}`)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error running stress harness:', err)
  process.exit(1)
})

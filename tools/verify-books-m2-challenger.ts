/**
 * tools/verify-books-m2-challenger.ts
 *
 * EMPIRICAL CHALLENGER TEST SUITE FOR BOOKS MILESTONE 2 (M2)
 * Features: F5, F6, F7, F8, F9
 *
 * Verification Objectives:
 * 1. F5 - Sales Invoice Balanced Journal Posting:
 *    - Balanced journal entry (debits === credits === grandTotal)
 *    - acc-ar debited, revenue accounts credited, acc-vat credited
 * 2. F6 - Purchase Bill Balanced Journal Posting:
 *    - Balanced journal entry (debits === credits === grandTotal)
 *    - expense accounts debited, acc-vat-in debited, acc-ap credited
 * 3. F7 - Draft-to-Posted Invoice Transition:
 *    - Draft invoices do NOT post journal entries or modify account balances
 *    - Updating a Draft to Unpaid posts balanced journals and updates accounts
 * 4. F8 - Invoice Payment & Reversal Settlement Journals:
 *    - markInvoicePaid generates balanced settlement journal
 *    - Sales settlement: Debit acc-bank, Credit acc-ar
 *    - Purchase settlement: Debit acc-ap, Credit acc-bank
 *    - deleteInvoice reverts account balances and reverses/removes postings
 * 5. F9 - Party Outstanding Balance Invariant:
 *    - Strict equality: party.outstandingBalance === sum(openInvoice.outstandingAmount)
 *    - Maintained through creation, edits, settlement, and deletion
 * 6. Immediate settlement on status === 'Paid'
 * 7. Multi-line items with distinct revenue/expense accounts
 * 8. Stress fuzzer testing randomized transactions
 */

import assert from 'node:assert'
import { useBooksStore } from '../apps/books/src/renderer/src/store'
import { initialBooksData } from '../apps/books/src/renderer/src/mock/initialData'
import { round2, calculateInvoiceTotals } from '../apps/books/src/shared/accounting'
import type { Invoice, InvoiceItem } from '../apps/books/src/shared/types'

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures: Array<{ suite: string; name: string; error: string }> = []

async function testAsync(suite: string, name: string, fn: () => Promise<void>) {
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

// Reset store helper
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
  console.log('   EMPIRICAL CHALLENGER: BOOKS MILESTONE 2 (M2) AUDIT HARNESS')
  console.log('======================================================================\n')

  // --- SUITE 1: F5 - Sales Invoice Balanced Journal Posting ---
  console.log('--- SUITE 1: F5 - Sales Invoice Balanced Journal Posting ---')

  await testAsync('Suite 1', '1.1 Sales invoice creates balanced journal entry (Debit AR, Credit Sales, Credit VAT)', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
    const initialSales = store.data.accounts.find((a) => a.id === 'acc-sales')!.balance
    const initialVat = store.data.accounts.find((a) => a.id === 'acc-vat')!.balance
    const initialJournalsCount = store.data.journalEntries.length

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'i-1',
          itemCode: 'SVC-1',
          description: 'Engineering Consulting',
          accountId: 'acc-sales',
          accountName: 'Tender & Commercial Contracting Sales',
          qty: 2,
          rate: 50000,
          taxRate: 15,
          amount: 100000,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const createdInv = updated.invoices[0]
    assert.strictEqual(createdInv.subtotal, 100000)
    assert.strictEqual(createdInv.taxTotal, 15000)
    assert.strictEqual(createdInv.grandTotal, 115000)
    assert.strictEqual(createdInv.outstandingAmount, 115000)

    // Journal Entry posted
    assert.strictEqual(updated.journalEntries.length, initialJournalsCount + 1)
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 115000)
    assert.strictEqual(je.totalCredit, 115000)
    assert.strictEqual(je.totalDebit, je.totalCredit)

    // Check line items in journal
    const arItem = je.items.find((it) => it.accountId === 'acc-ar')
    const salesItem = je.items.find((it) => it.accountId === 'acc-sales')
    const vatItem = je.items.find((it) => it.accountId === 'acc-vat' || it.accountId === 'acc-vat-out')
    assert.ok(arItem, 'Journal must contain AR debit')
    assert.strictEqual(arItem.debit, 115000)
    assert.strictEqual(arItem.credit, 0)
    assert.ok(salesItem, 'Journal must contain Sales credit')
    assert.strictEqual(salesItem.credit, 100000)
    assert.ok(vatItem, 'Journal must contain VAT credit')
    assert.strictEqual(vatItem.credit, 15000)

    // Account balances updated
    const newAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
    const newSales = updated.accounts.find((a) => a.id === 'acc-sales')!.balance
    const newVat = updated.accounts.find((a) => a.id === 'acc-vat')!.balance
    assert.strictEqual(newAr, round2(initialAr + 115000))
    assert.strictEqual(newSales, round2(initialSales + 100000))
    assert.strictEqual(newVat, round2(initialVat + 15000))
  })

  await testAsync('Suite 1', '1.2 Multi-item sales invoice with different income accounts (acc-sales and acc-consult)', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
    const initialSales = store.data.accounts.find((a) => a.id === 'acc-sales')!.balance
    const initialConsult = store.data.accounts.find((a) => a.id === 'acc-consult')!.balance

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'i-1',
          itemCode: 'SALE-1',
          description: 'Commercial Sales',
          accountId: 'acc-sales',
          accountName: 'Tender & Commercial Contracting Sales',
          qty: 1,
          rate: 40000,
          taxRate: 15,
          amount: 40000,
        },
        {
          id: 'i-2',
          itemCode: 'CNS-1',
          description: 'Advisory Fees',
          accountId: 'acc-consult',
          accountName: 'Professional Advisory Fees',
          qty: 1,
          rate: 60000,
          taxRate: 15,
          amount: 60000,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 115000)
    assert.strictEqual(je.totalCredit, 115000)

    const newAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
    const newSales = updated.accounts.find((a) => a.id === 'acc-sales')!.balance
    const newConsult = updated.accounts.find((a) => a.id === 'acc-consult')!.balance
    assert.strictEqual(newAr, round2(initialAr + 115000))
    assert.strictEqual(newSales, round2(initialSales + 40000))
    assert.strictEqual(newConsult, round2(initialConsult + 60000))
  })

  // --- SUITE 2: F6 - Purchase Bill Balanced Journal Posting ---
  console.log('\n--- SUITE 2: F6 - Purchase Bill Balanced Journal Posting ---')

  await testAsync('Suite 2', '2.1 Purchase bill posts balanced journal (Debit Expense, Debit VAT Input, Credit AP)', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialAp = store.data.accounts.find((a) => a.id === 'acc-ap')!.balance
    const initialMaterials = store.data.accounts.find((a) => a.id === 'acc-materials')!.balance
    const vatInAcc = store.data.accounts.find((a) => a.id === 'acc-vat-in') || store.data.accounts.find((a) => a.id === 'acc-vat')!
    const initialVatIn = vatInAcc.balance
    const initialJournalsCount = store.data.journalEntries.length

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items: [
        {
          id: 'p-1',
          itemCode: 'MAT-1',
          description: 'Steel Structural Beams',
          accountId: 'acc-materials',
          accountName: 'Direct Project Materials & Subcontractors',
          qty: 10,
          rate: 5000,
          taxRate: 15,
          amount: 50000,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const createdBill = updated.invoices[0]
    assert.strictEqual(createdBill.subtotal, 50000)
    assert.strictEqual(createdBill.taxTotal, 7500)
    assert.strictEqual(createdBill.grandTotal, 57500)
    assert.strictEqual(createdBill.outstandingAmount, 57500)

    // Balanced Journal Entry posted
    assert.strictEqual(updated.journalEntries.length, initialJournalsCount + 1)
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 57500)
    assert.strictEqual(je.totalCredit, 57500)

    const apItem = je.items.find((it) => it.accountId === 'acc-ap')
    const matItem = je.items.find((it) => it.accountId === 'acc-materials')
    const vatItem = je.items.find((it) => it.accountId === 'acc-vat-in' || it.accountId === 'acc-vat')
    assert.ok(apItem, 'Journal must contain AP credit')
    assert.strictEqual(apItem.credit, 57500)
    assert.ok(matItem, 'Journal must contain Materials debit')
    assert.strictEqual(matItem.debit, 50000)
    assert.ok(vatItem, 'Journal must contain VAT Input debit')
    assert.strictEqual(vatItem.debit, 7500)

    // Accounts updated
    const newAp = updated.accounts.find((a) => a.id === 'acc-ap')!.balance
    const newMaterials = updated.accounts.find((a) => a.id === 'acc-materials')!.balance
    const newVatIn = (updated.accounts.find((a) => a.id === 'acc-vat-in') || updated.accounts.find((a) => a.id === 'acc-vat')!).balance
    assert.strictEqual(newAp, round2(initialAp + 57500))
    assert.strictEqual(newMaterials, round2(initialMaterials + 50000))
    assert.strictEqual(newVatIn, round2(initialVatIn + 7500))
  })

  await testAsync('Suite 2', '2.2 Multi-expense purchase bill (acc-materials, acc-rent, acc-salaries)', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialAp = store.data.accounts.find((a) => a.id === 'acc-ap')!.balance
    const initialMaterials = store.data.accounts.find((a) => a.id === 'acc-materials')!.balance
    const initialRent = store.data.accounts.find((a) => a.id === 'acc-rent')!.balance

    await store.saveInvoice({
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items: [
        {
          id: 'p-1',
          itemCode: 'MAT-1',
          description: 'Materials',
          accountId: 'acc-materials',
          accountName: 'Materials',
          qty: 1,
          rate: 20000,
          taxRate: 15,
          amount: 20000,
        },
        {
          id: 'p-2',
          itemCode: 'RNT-1',
          description: 'Equipment Rent',
          accountId: 'acc-rent',
          accountName: 'Office Rent & Facilities',
          qty: 1,
          rate: 10000,
          taxRate: 15,
          amount: 10000,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 34500)
    assert.strictEqual(je.totalCredit, 34500)

    const newAp = updated.accounts.find((a) => a.id === 'acc-ap')!.balance
    const newMaterials = updated.accounts.find((a) => a.id === 'acc-materials')!.balance
    const newRent = updated.accounts.find((a) => a.id === 'acc-rent')!.balance
    assert.strictEqual(newAp, round2(initialAp + 34500))
    assert.strictEqual(newMaterials, round2(initialMaterials + 20000))
    assert.strictEqual(newRent, round2(initialRent + 10000))
  })

  // --- SUITE 3: F7 - Draft-to-Posted Invoice Transition ---
  console.log('\n--- SUITE 3: F7 - Draft-to-Posted Invoice Transition ---')

  await testAsync('Suite 3', '3.1 Draft invoice creation does NOT post journal or alter account balances', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
    const initialJournalsCount = store.data.journalEntries.length

    await store.saveInvoice({
      id: 'draft-test-1',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Draft',
      items: [
        {
          id: 'd-1',
          itemCode: 'DFT-1',
          description: 'Draft Project Plan',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 1,
          rate: 80000,
          taxRate: 15,
          amount: 80000,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const draftInv = updated.invoices.find((i) => i.id === 'draft-test-1')
    assert.ok(draftInv)
    assert.strictEqual(draftInv.status, 'Draft')

    // Zero journal entries created
    assert.strictEqual(updated.journalEntries.length, initialJournalsCount)
    // AR balance unchanged
    const newAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
    assert.strictEqual(newAr, initialAr)
  })

  await testAsync('Suite 3', '3.2 Updating Draft to Unpaid posts balanced journal and updates accounts', async () => {
    const store = useBooksStore.getState()
    const initialAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
    const initialJournalsCount = store.data.journalEntries.length

    // Transition draft-test-1 to Unpaid
    await store.saveInvoice({
      id: 'draft-test-1',
      status: 'Unpaid',
    })

    const updated = useBooksStore.getState().data
    const postedInv = updated.invoices.find((i) => i.id === 'draft-test-1')
    assert.ok(postedInv)
    assert.strictEqual(postedInv.status, 'Unpaid')
    assert.strictEqual(postedInv.grandTotal, 92000)
    assert.strictEqual(postedInv.outstandingAmount, 92000)

    // Journal Entry posted
    assert.strictEqual(updated.journalEntries.length, initialJournalsCount + 1)
    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 92000)
    assert.strictEqual(je.totalCredit, 92000)

    // AR updated
    const newAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
    assert.strictEqual(newAr, round2(initialAr + 92000))
  })

  // --- SUITE 4: F8 - Invoice Payment & Reversal Settlement Journals ---
  console.log('\n--- SUITE 4: F8 - Invoice Payment & Reversal Settlement Journals ---')

  await testAsync('Suite 4', '4.1 markInvoicePaid creates balanced settlement journal (Debit Bank, Credit AR)', async () => {
    resetStore()
    const store = useBooksStore.getState()

    // Create sales invoice
    await store.saveInvoice({
      id: 'inv-to-pay',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'i-1',
          itemCode: 'ITM-1',
          description: 'Services',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 1,
          rate: 50000,
          taxRate: 15,
          amount: 50000,
        },
      ],
    })

    const stateBeforePay = useBooksStore.getState().data
    const initialBank = stateBeforePay.accounts.find((a) => a.id === 'acc-bank')!.balance
    const initialAr = stateBeforePay.accounts.find((a) => a.id === 'acc-ar')!.balance
    const initialJournalsCount = stateBeforePay.journalEntries.length

    // Mark paid
    await store.markInvoicePaid('inv-to-pay')

    const stateAfterPay = useBooksStore.getState().data
    const paidInv = stateAfterPay.invoices.find((i) => i.id === 'inv-to-pay')!
    assert.strictEqual(paidInv.status, 'Paid')
    assert.strictEqual(paidInv.outstandingAmount, 0)

    // Settlement journal entry created
    assert.strictEqual(stateAfterPay.journalEntries.length, initialJournalsCount + 1)
    const settlementJe = stateAfterPay.journalEntries[0]
    assert.strictEqual(settlementJe.totalDebit, 57500)
    assert.strictEqual(settlementJe.totalCredit, 57500)

    const bankItem = settlementJe.items.find((it) => it.accountId === 'acc-bank')
    const arItem = settlementJe.items.find((it) => it.accountId === 'acc-ar')
    assert.ok(bankItem)
    assert.strictEqual(bankItem.debit, 57500)
    assert.ok(arItem)
    assert.strictEqual(arItem.credit, 57500)

    // Bank incremented, AR decremented
    const newBank = stateAfterPay.accounts.find((a) => a.id === 'acc-bank')!.balance
    const newAr = stateAfterPay.accounts.find((a) => a.id === 'acc-ar')!.balance
    assert.strictEqual(newBank, round2(initialBank + 57500))
    assert.strictEqual(newAr, round2(initialAr - 57500))
  })

  await testAsync('Suite 4', '4.2 markInvoicePaid on Purchase bill (Debit AP, Credit Bank)', async () => {
    resetStore()
    const store = useBooksStore.getState()

    await store.saveInvoice({
      id: 'bill-to-pay',
      type: 'Purchase',
      partyId: 'party-4',
      partyName: 'Safintra Steel & Building Materials',
      status: 'Unpaid',
      items: [
        {
          id: 'p-1',
          itemCode: 'MAT-1',
          description: 'Materials',
          accountId: 'acc-materials',
          accountName: 'Materials',
          qty: 1,
          rate: 20000,
          taxRate: 15,
          amount: 20000,
        },
      ],
    })

    const stateBeforePay = useBooksStore.getState().data
    const initialBank = stateBeforePay.accounts.find((a) => a.id === 'acc-bank')!.balance
    const initialAp = stateBeforePay.accounts.find((a) => a.id === 'acc-ap')!.balance

    await store.markInvoicePaid('bill-to-pay')

    const stateAfterPay = useBooksStore.getState().data
    const paidBill = stateAfterPay.invoices.find((i) => i.id === 'bill-to-pay')!
    assert.strictEqual(paidBill.status, 'Paid')
    assert.strictEqual(paidBill.outstandingAmount, 0)

    const settlementJe = stateAfterPay.journalEntries[0]
    assert.strictEqual(settlementJe.totalDebit, 23000)
    assert.strictEqual(settlementJe.totalCredit, 23000)

    const apItem = settlementJe.items.find((it) => it.accountId === 'acc-ap')
    const bankItem = settlementJe.items.find((it) => it.accountId === 'acc-bank')
    assert.ok(apItem)
    assert.strictEqual(apItem.debit, 23000)
    assert.ok(bankItem)
    assert.strictEqual(bankItem.credit, 23000)

    const newBank = stateAfterPay.accounts.find((a) => a.id === 'acc-bank')!.balance
    const newAp = stateAfterPay.accounts.find((a) => a.id === 'acc-ap')!.balance
    assert.strictEqual(newBank, round2(initialBank - 23000))
    assert.strictEqual(newAp, round2(initialAp - 23000))
  })

  await testAsync('Suite 4', '4.3 deleteInvoice reverts ledger accounts and journal entries', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
    const baselineSales = store.data.accounts.find((a) => a.id === 'acc-sales')!.balance
    const baselineVat = store.data.accounts.find((a) => a.id === 'acc-vat')!.balance
    const baselineJournalsCount = store.data.journalEntries.length

    // Post an invoice
    await store.saveInvoice({
      id: 'inv-to-delete',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'del-1',
          itemCode: 'DEL-1',
          description: 'To Delete',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 1,
          rate: 30000,
          taxRate: 15,
          amount: 30000,
        },
      ],
    })

    // Now delete it
    await store.deleteInvoice('inv-to-delete')

    const updated = useBooksStore.getState().data
    assert.ok(!updated.invoices.some((i) => i.id === 'inv-to-delete'))

    // Balances must be reverted back to baseline
    const revertedAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
    const revertedSales = updated.accounts.find((a) => a.id === 'acc-sales')!.balance
    const revertedVat = updated.accounts.find((a) => a.id === 'acc-vat')!.balance
    assert.strictEqual(revertedAr, baselineAr)
    assert.strictEqual(revertedSales, baselineSales)
    assert.strictEqual(revertedVat, baselineVat)
    assert.strictEqual(updated.journalEntries.length, baselineJournalsCount)
  })

  // --- SUITE 5: F9 - Party Outstanding Balance Invariant ---
  console.log('\n--- SUITE 5: F9 - Party Outstanding Balance Invariant ---')

  await testAsync('Suite 5', '5.1 Party balance strictly equals sum of open invoice outstanding amounts', async () => {
    resetStore()
    const store = useBooksStore.getState()

    // Check party 1 initial open invoices sum
    const p1Invoices = store.data.invoices.filter((i) => i.partyId === 'party-1' && i.status !== 'Paid' && i.status !== 'Cancelled')
    const expectedInitialP1 = p1Invoices.reduce((sum, i) => round2(sum + i.outstandingAmount), 0)
    const party1 = store.data.parties.find((p) => p.id === 'party-1')!
    assert.strictEqual(party1.outstandingBalance, expectedInitialP1)

    // Add another invoice for party 1
    await store.saveInvoice({
      id: 'p1-extra-inv',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'i-1',
          itemCode: 'SVC-2',
          description: 'Extra work',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 1,
          rate: 10000,
          taxRate: 15,
          amount: 10000,
        },
      ],
    })

    const afterAdd = useBooksStore.getState().data
    const updatedParty1 = afterAdd.parties.find((p) => p.id === 'party-1')!
    assert.strictEqual(updatedParty1.outstandingBalance, round2(expectedInitialP1 + 11500))

    // Now mark paid
    await store.markInvoicePaid('p1-extra-inv')
    const afterPay = useBooksStore.getState().data
    const paidParty1 = afterPay.parties.find((p) => p.id === 'party-1')!
    assert.strictEqual(paidParty1.outstandingBalance, expectedInitialP1)
  })

  // --- SUITE 6: Immediate Settlement on Create ---
  console.log('\n--- SUITE 6: Immediate Settlement on Create ---')

  await testAsync('Suite 6', '6.1 Creating invoice with status: Paid immediately generates settlement journal', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initialBank = store.data.accounts.find((a) => a.id === 'acc-bank')!.balance
    const initialAr = store.data.accounts.find((a) => a.id === 'acc-ar')!.balance
    const initialJournalsCount = store.data.journalEntries.length

    await store.saveInvoice({
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Paid',
      items: [
        {
          id: 'i-cash',
          itemCode: 'CSH-1',
          description: 'Direct Cash/Card Sales',
          accountId: 'acc-sales',
          accountName: 'Sales',
          qty: 1,
          rate: 20000,
          taxRate: 15,
          amount: 20000,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const inv = updated.invoices[0]
    assert.strictEqual(inv.status, 'Paid')
    assert.strictEqual(inv.outstandingAmount, 0)
    assert.strictEqual(inv.grandTotal, 23000)

    // Exactly 2 journal entries created: Invoice posting + Settlement
    assert.strictEqual(updated.journalEntries.length, initialJournalsCount + 2)
    const settlementJe = updated.journalEntries[0]
    const invoiceJe = updated.journalEntries[1]

    assert.strictEqual(settlementJe.totalDebit, 23000)
    assert.strictEqual(settlementJe.totalCredit, 23000)
    assert.strictEqual(invoiceJe.totalDebit, 23000)
    assert.strictEqual(invoiceJe.totalCredit, 23000)

    // Bank net increase by 23000, AR remains net unchanged
    const newBank = updated.accounts.find((a) => a.id === 'acc-bank')!.balance
    const newAr = updated.accounts.find((a) => a.id === 'acc-ar')!.balance
    assert.strictEqual(newBank, round2(initialBank + 23000))
    assert.strictEqual(newAr, initialAr)
  })

  // --- SUITE 7: Randomized Stress Fuzzer ---
  console.log('\n--- SUITE 7: Randomized Double-Entry Stress Fuzzer ---')

  await testAsync('Suite 7', '7.1 100 randomized Sales and Purchase invoices all produce balanced journals and valid party invariants', async () => {
    resetStore()
    const store = useBooksStore.getState()

    for (let i = 0; i < 100; i++) {
      const isSales = Math.random() > 0.5
      const itemCount = Math.floor(Math.random() * 4) + 1
      const partyId = isSales ? (Math.random() > 0.5 ? 'party-1' : 'party-2') : 'party-4'
      const partyName = isSales ? 'Customer' : 'Supplier'
      const status = Math.random() > 0.3 ? 'Unpaid' : 'Paid'

      const items: InvoiceItem[] = []
      for (let j = 0; j < itemCount; j++) {
        const qty = Math.floor(Math.random() * 10) + 1
        const rate = Math.round((Math.random() * 5000 + 10) * 100) / 100
        const taxRate = Math.random() > 0.2 ? 15 : 0
        const accId = isSales
          ? (Math.random() > 0.5 ? 'acc-sales' : 'acc-consult')
          : (Math.random() > 0.5 ? 'acc-materials' : 'acc-rent')
        items.push({
          id: `item-${i}-${j}`,
          itemCode: `CODE-${j}`,
          description: `Test item ${j}`,
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

      // Check invariant on latest journal entry
      const curState = useBooksStore.getState().data
      const latestJe = curState.journalEntries[0]
      assert.strictEqual(latestJe.totalDebit, latestJe.totalCredit, `JE ${latestJe.entryNumber} debits !== credits`)

      // Check party invariant
      for (const party of curState.parties) {
        const expected = curState.invoices
          .filter((inv) => inv.partyId === party.id && inv.status !== 'Paid' && inv.status !== 'Cancelled')
          .reduce((s, inv) => round2(s + (inv.outstandingAmount ?? inv.grandTotal)), 0)
        assert.strictEqual(
          party.outstandingBalance,
          round2(expected),
          `Party ${party.name} balance mismatch: ${party.outstandingBalance} vs ${expected}`,
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

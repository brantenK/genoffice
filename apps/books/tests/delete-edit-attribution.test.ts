/**
 * Regression tests for the delete/edit attribution findings F3 and F6.
 *
 * F3: an invoice's journals were found by substring-matching the invoice
 *     NUMBER against journal remarks — and bank-statement DESCRIPTIONS ride in
 *     those remarks — so a number that merely appeared in statement text
 *     coupled unrelated journals to that invoice's edits/deletes.
 *     Fixed semantics: journals are attributed by a STRUCTURAL key
 *     (JournalEntryItem.invoiceId, stamped at posting time; legacy rows fall
 *     back to item remarks only, never through cash-side legs).
 *
 * F6: deleting a reconciled invoice left the import journal's Suspense credit
 *     stranded (the reclass died, the import survived) and the statement line
 *     stayed reconciled against a dead invoice, so the cash could never be
 *     re-allocated. Fixed deletion semantics (pinned here):
 *       - the bank import journal (real cash) SURVIVES the delete;
 *       - the deleted invoice's posting and settlement/reclass journals are
 *         removed TOGETHER, so Suspense re-balances to the unallocated
 *         remainder of the affected statement lines;
 *       - affected statement lines become un-reconciled again (dead payment
 *         links dropped) and are immediately re-allocatable;
 *       - the over-payment credit ride is REMOVED with the settlement it rode;
 *       - party balances, AR/AP control, the tax register and the
 *         stored-balances-are-journal-derived invariant all hold after.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { applyLoadedEnvelope, useBooksStore } from '../src/renderer/src/store'
import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../src/shared/chart'
import {
  accountsMatchJournals,
  allJournalsBalanced,
  computeAccountBalances,
  recomputePartyBalances,
  round2,
} from '../src/shared/accounting'
import { taxRegister } from '../src/shared/reports'
import type { BooksData, Invoice } from '../src/shared/types'

const state = () => useBooksStore.getState()
const data = () => state().data

const seedLedger = (taxInclusive = false): BooksData => ({
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  settings: { ...DEFAULT_BOOK_SETTINGS, taxInclusive, companyName: 'Attribution Co' },
  accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a, balance: 0 })),
  parties: [
    { id: 'party-c0', name: 'Probe Customer', type: 'Customer', outstandingBalance: 0 },
    { id: 'party-s0', name: 'Probe Supplier', type: 'Supplier', outstandingBalance: 0 },
  ],
  invoices: [],
  quotes: [],
  journalEntries: [],
  bankTransactions: [],
  payments: [],
  auditLog: [],
})

const reseed = (taxInclusive = false): void => {
  applyLoadedEnvelope({ ...seedLedger(taxInclusive), version: 1, revision: 1 })
  state().clearError()
}

const derivedBal = (id: string): number =>
  round2(
    computeAccountBalances(data().accounts, data().journalEntries).find((a) => a.id === id)
      ?.balance ?? 0,
  )

const invoice = (id: string): Invoice => {
  const found = data().invoices.find((i) => i.id === id)
  expect(found, `invoice ${id} exists`).toBeDefined()
  return found as Invoice
}

const outstandingOf = (inv: Invoice): number =>
  round2(
    inv.outstandingAmount !== undefined && inv.outstandingAmount !== null
      ? inv.outstandingAmount
      : inv.grandTotal,
  )

const workLine = (id: string, rate: number) => ({
  id,
  itemCode: 'T-1',
  description: 'Works',
  accountId: 'acc-sales',
  accountName: 'Sales',
  qty: 1,
  rate,
  taxRate: 15,
  amount: rate,
})

const saveInvoicePayload = (id: string, rate: number) => ({
  id,
  type: 'Sales' as const,
  partyId: 'party-c0',
  partyName: 'Probe Customer',
  status: 'Unpaid' as const,
  items: [workLine(`it-${id}`, rate)],
})

const importCsv = async (rows: string[]): Promise<void> => {
  const result = await state().importBankStatementCsv(
    ['Date,Description,Reference,Amount', ...rows].join('\n'),
  )
  expect(result.ok, `import ok: ${result.error}`).toBe(true)
}

/** Whole-ledger coherence asserts shared by every delete scenario below. */
function expectLedgerCoherent(ctx: string): void {
  expect(allJournalsBalanced(data().journalEntries), `${ctx}: journals balanced`).toBe(true)
  expect(accountsMatchJournals(data().accounts, data().journalEntries), `${ctx}: stored balances are journal-derived`).toBe(true)
  const derived = computeAccountBalances(data().accounts, data().journalEntries)
  for (const acc of data().accounts) {
    const computed = derived.find((x) => x.id === acc.id)!
    expect(
      round2(acc.balance),
      `${ctx}: account ${acc.id} balance equals the journal-derived value`,
    ).toBe(round2(computed.balance))
  }
  const recomputed = recomputePartyBalances(data().invoices, data().parties)
  for (let i = 0; i < data().parties.length; i++) {
    expect(
      round2(data().parties[i].outstandingBalance),
      `${ctx}: party ${data().parties[i].name} balance is invoice-derived`,
    ).toBe(round2(recomputed[i].outstandingBalance))
  }
  const openSales = round2(
    data()
      .invoices.filter(
        (inv) =>
          inv.type === 'Sales' && inv.status !== 'Paid' && inv.status !== 'Cancelled' && inv.status !== 'Draft',
      )
      .reduce((s, inv) => s + outstandingOf(inv), 0),
  )
  expect(derivedBal('acc-ar'), `${ctx}: AR control equals open sales outstandings`).toBe(openSales)
  const rows = taxRegister(data().invoices)
  const totalsRow = rows.find((r) => r.taxRate === null)!
  let vatOutPosted = 0
  for (const je of data().journalEntries) {
    for (const it of je.items) {
      if (it.accountId === 'acc-vat' || it.accountId === 'acc-vat-out') {
        vatOutPosted = round2(vatOutPosted + it.credit - it.debit)
      }
    }
  }
  expect(
    round2(totalsRow.salesTax),
    `${ctx}: tax register salesTax equals the posted output VAT`,
  ).toBe(round2(vatOutPosted))
}

describe('F3 repro A: a statement description naming the invoice no longer kills its bank cash', () => {
  beforeAll(() => reseed())

  it('deleteInvoice keeps the import journal, unwinds suspense, and the line is re-allocatable', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-a', 1000))
    const number = invoice('inv-a').invoiceNumber
    await importCsv([`2026-06-01,"EFT payment ${number} Probe Customer","",1150.00`])
    const tx = data().bankTransactions[0]
    const rec = await state().reconcileTransaction(tx.id, 'inv-a')
    expect(rec.ok).toBe(true)
    expect(invoice('inv-a').status).toBe('Paid')
    expect(derivedBal('acc-bank'), 'sanity: import moved bank once').toBe(1150)
    expect(derivedBal('acc-suspense'), 'sanity: reclass cleared suspense').toBe(0)

    await state().deleteInvoice('inv-a')
    expect(data().invoices.some((i) => i.id === 'inv-a'), 'invoice deleted').toBe(false)

    // Corruption asserts first: pre-fix the import journal died with the
    // invoice (bank 0, suspense 0) and the line stayed reconciled forever.
    expect(
      derivedBal('acc-bank'),
      'F3-A: the bank import journal (real cash) survives the delete',
    ).toBe(1150)
    expect(
      derivedBal('acc-suspense'),
      'F3-A: suspense re-balances to the unallocated remainder',
    ).toBe(-1150)
    expect(derivedBal('acc-ar'), 'F3-A: AR control is fully unwound').toBe(0)
    expect(
      round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance),
      'F3-A: the party balance is unwound',
    ).toBe(0)
    const txAfter = data().bankTransactions[0]
    expect(txAfter.reconciled, 'F3-A: the statement line is un-reconciled again').toBe(false)
    expect(txAfter.matchedInvoiceId, 'F3-A: no match against a dead invoice').toBeUndefined()
    expectLedgerCoherent('F3-A after delete')

    // The line is immediately re-allocatable against a fresh invoice.
    await state().saveInvoice(saveInvoicePayload('inv-b', 1000))
    const reRec = await state().reconcileTransaction(txAfter.id, 'inv-b')
    expect(reRec.ok, `F3-A: the freed line re-allocates: ${reRec.error}`).toBe(true)
    expect(invoice('inv-b').status).toBe('Paid')
    expect(derivedBal('acc-suspense'), 'F3-A: suspense cleared again by the re-allocation').toBe(0)
    expect(derivedBal('acc-bank'), 'F3-A: bank unchanged by the re-allocation').toBe(1150)
    expectLedgerCoherent('F3-A after re-allocation')
  })
})

describe('F3 repro B: editing one invoice never touches another invoice\u2019s settlement journals', () => {
  beforeAll(() => reseed())

  it('a reclass whose entry remark mentions invoice 1 survives editing invoice 1', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-1', 1000))
    await state().saveInvoice(saveInvoicePayload('inv-2', 1000))
    const numberOne = invoice('inv-1').invoiceNumber
    await importCsv([`2026-06-01,"EFT ${numberOne} combo settlement","",1150.00`])
    const tx = data().bankTransactions[0]
    const rec = await state().reconcileTransaction(tx.id, 'inv-2')
    expect(rec.ok).toBe(true)
    expect(invoice('inv-2').status, 'sanity: invoice 2 settled by the line').toBe('Paid')
    expect(derivedBal('acc-ar'), 'sanity: AR = invoice 1 only').toBe(1150)

    const journalsBefore = data().journalEntries.length
    state().clearError()
    await state().saveInvoice(saveInvoicePayload('inv-1', 2000))
    expect(invoice('inv-1').grandTotal, 'sanity: the edit posted (nothing settled on invoice 1)').toBe(2300)

    // Corruption assert first: pre-fix the edit removed the import journal AND
    // invoice 2's reclass (both remarks mention invoice 1's number), leaving
    // AR at 3450 against parties of 2300.
    expect(
      derivedBal('acc-ar'),
      'F3-B: AR control ties to the party balances after the edit',
    ).toBe(2300)
    expect(
      data().journalEntries.some((je) => je.id === `je-reclass-${tx.id}`),
      'F3-B: invoice 2\u2019s reclass journal survives the edit of invoice 1',
    ).toBe(true)
    expect(
      derivedBal('acc-bank'),
      'F3-B: the import journal survives the edit of invoice 1',
    ).toBe(1150)
    expect(
      data().journalEntries.length,
      'F3-B: only invoice 1\u2019s own journals were reversed and re-posted (one replaces one)',
    ).toBe(journalsBefore)
    expect(derivedBal('acc-suspense'), 'F3-B: suspense stays cleared').toBe(0)
    expectLedgerCoherent('F3-B after edit')
  })
})

describe('F6: deleting a reconciled invoice unwinds suspense coherently', () => {
  beforeAll(() => reseed())

  it('imported cash returns to the unallocated remainder and is immediately re-allocatable', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-c', 1000))
    await importCsv(['2026-06-01,"EFT payment for Probe Customer","",1150.00'])
    const tx = data().bankTransactions[0]
    const rec = await state().reconcileTransaction(tx.id, 'inv-c')
    expect(rec.ok).toBe(true)
    expect(invoice('inv-c').status).toBe('Paid')
    expect(derivedBal('acc-suspense'), 'sanity: suspense cleared by the reclass').toBe(0)

    await state().deleteInvoice('inv-c')

    // The strand: pre-fix the numbers already landed here, but the statement
    // line stayed reconciled against the dead invoice — the cash could never
    // be re-allocated. That is the failure this test pins.
    expect(derivedBal('acc-bank'), 'F6: the import journal (real cash) survives').toBe(1150)
    expect(derivedBal('acc-suspense'), 'F6: suspense holds the unallocated remainder').toBe(-1150)
    expect(derivedBal('acc-ar'), 'F6: AR control fully unwound').toBe(0)
    const txAfter = data().bankTransactions[0]
    expect(txAfter.reconciled, 'F6: the line is un-reconciled (re-allocatable)').toBe(false)
    expect(txAfter.matchedInvoiceId, 'F6: no match against a dead invoice').toBeUndefined()
    expectLedgerCoherent('F6 after delete')

    await state().saveInvoice(saveInvoicePayload('inv-d', 1000))
    const reRec = await state().reconcileTransaction(txAfter.id, 'inv-d')
    expect(reRec.ok, `F6: the freed line re-allocates: ${reRec.error}`).toBe(true)
    expect(invoice('inv-d').status).toBe('Paid')
    expect(derivedBal('acc-suspense'), 'F6: suspense cleared by the re-allocation').toBe(0)
    expectLedgerCoherent('F6 after re-allocation')
  })
})

describe('over-payment credit ride mirrors the e2e flow and deletes coherently', () => {
  beforeAll(() => reseed(true))

  it('import 1500 against a 1000 invoice, reconcile, delete: credit removed with the settlement', async () => {
    // The fresh profile prices VAT-inclusively, like the e2e journey.
    await state().saveInvoice(saveInvoicePayload('inv-e', 1000))
    expect(round2(invoice('inv-e').grandTotal), 'sanity: VAT-inclusive grand total').toBe(1000)
    const number = invoice('inv-e').invoiceNumber
    await importCsv([`2026-09-26,"EFT Buyer Co ${number}","",1500.00`])
    const tx = data().bankTransactions[0]
    const rec = await state().reconcileTransaction(tx.id, 'inv-e')
    expect(rec.ok).toBe(true)
    expect(outstandingOf(invoice('inv-e')), 'sanity: the credit rides the invoice').toBe(-500)
    expect(
      round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance),
      'sanity: the party carries the credit',
    ).toBe(-500)
    expect(derivedBal('acc-suspense'), 'sanity: suspense cleared (fully allocated)').toBe(0)
    expect(derivedBal('acc-bank'), 'sanity: bank holds the full line').toBe(1500)

    await state().deleteInvoice('inv-e')

    // Chosen semantics (pinned): the credit ride is REMOVED with the settlement
    // it rode; the full line returns to suspense as the unallocated remainder;
    // the import journal (real cash) survives.
    expect(allJournalsBalanced(data().journalEntries), 'over-payment: journals balanced').toBe(true)
    expect(derivedBal('acc-ar'), 'over-payment: AR control unwound').toBe(0)
    expect(
      round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance),
      'over-payment: the credit ride left with the settlement',
    ).toBe(0)
    expect(derivedBal('acc-bank'), 'over-payment: the import journal survives').toBe(1500)
    expect(
      derivedBal('acc-suspense'),
      'over-payment: suspense holds the full unallocated remainder',
    ).toBe(-1500)
    const txAfter = data().bankTransactions[0]
    expect(txAfter.reconciled, 'over-payment: the line is un-reconciled').toBe(false)
    expectLedgerCoherent('over-payment after delete')

    await state().saveInvoice(saveInvoicePayload('inv-f', 1000))
    const reRec = await state().reconcileTransaction(txAfter.id, 'inv-f')
    expect(reRec.ok, `over-payment: the line re-allocates: ${reRec.error}`).toBe(true)
    expect(outstandingOf(invoice('inv-f')), 'over-payment: the credit ride re-forms').toBe(-500)
    expect(derivedBal('acc-suspense'), 'over-payment: suspense cleared again').toBe(0)
    expectLedgerCoherent('over-payment after re-allocation')
  })
})

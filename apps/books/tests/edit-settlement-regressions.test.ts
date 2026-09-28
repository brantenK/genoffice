/**
 * Regression tests for the edit-settlement findings F2 and F4.
 *
 * F2: editing a partially-settled invoice DOWN below its already-settled
 *     portion used to re-post the FULL paid portion as a settlement against
 *     the smaller invoice — outstanding 0, status Paid, AR control floating
 *     negative with no party carrying it, and an unbacked bank movement.
 *     Fixed semantics: the store REFUSES the edit with an error naming the
 *     invoice number, the settled amount and the attempted new total.
 *
 * F4: editing an invoice whose settled portion is suspense-funded (the cash
 *     arrived via a bank-statement import and a reclass settlement) used to
 *     re-post the carried portion as a DIRECT bank settlement — Bank
 *     double-counted, Suspense dangling negative. Fixed semantics: the store
 *     REFUSES edits whose reversed journals carry a Suspense leg, naming the
 *     invoice, the settled amount and the reason. Payment-funded (bank)
 *     partial settlements remain editable to totals at or above the settled
 *     amount — the carried re-post is provably invariant-preserving there
 *     (both controls at the bottom pin that).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { applyLoadedEnvelope, useBooksStore } from '../src/renderer/src/store'
import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../src/shared/chart'
import { allJournalsBalanced, computeAccountBalances, round2 } from '../src/shared/accounting'
import type { BooksData, Invoice } from '../src/shared/types'

const state = () => useBooksStore.getState()
const data = () => state().data

const seedLedger = (): BooksData => ({
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  settings: { ...DEFAULT_BOOK_SETTINGS, taxInclusive: false, companyName: 'Edit Regressions' },
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

const reseed = (): void => {
  applyLoadedEnvelope({ ...seedLedger(), version: 1, revision: 1 })
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

const cloneLedger = (): BooksData => JSON.parse(JSON.stringify(data())) as BooksData

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

describe('F2: an edit below the settled portion is refused, not re-derived', () => {
  beforeAll(reseed)

  it('partial bank reconciliation then a smaller edit: refusal, ledger untouched', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-f2a', 1000))
    expect(round2(invoice('inv-f2a').grandTotal)).toBe(1150)

    useBooksStore.setState({
      data: {
        ...data(),
        bankTransactions: [
          {
            id: 'tx-f2a',
            accountId: 'acc-bank',
            date: '2026-06-10',
            description: 'Partial EFT',
            amount: 500,
            reconciled: false,
          },
        ],
      },
    })
    const rec = await state().reconcileTransaction('tx-f2a', 'inv-f2a')
    expect(rec.ok).toBe(true)
    expect(outstandingOf(invoice('inv-f2a'))).toBe(650)
    expect(derivedBal('acc-ar')).toBe(650)

    const before = cloneLedger()
    state().clearError()
    await state().saveInvoice(saveInvoicePayload('inv-f2a', 200))

    // Corruption asserts first: pre-fix these fail with the corruption visible.
    expect(
      derivedBal('acc-ar'),
      'F2: AR control must equal the party balance (the settled invoice must not float AR)',
    ).toBe(round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance))
    expect(round2(invoice('inv-f2a').grandTotal), 'F2: the smaller edit must be refused').toBe(1150)
    expect(outstandingOf(invoice('inv-f2a')), 'F2: outstanding must be unchanged by the refusal').toBe(650)
    expect(invoice('inv-f2a').status, 'F2: the invoice must not flip to Paid').toBe('Unpaid')
    expect(state().lastError ?? '', 'F2: the refusal names the settled amount').toContain('500.00')
    expect(state().lastError ?? '', 'F2: the refusal names the attempted new total').toContain('230.00')
    expect(state().lastError ?? '', 'F2: the refusal names the invoice').toContain(
      invoice('inv-f2a').invoiceNumber,
    )
    expect(data(), 'F2: a refused edit leaves the ledger byte-identical').toEqual(before)
    expect(allJournalsBalanced(data().journalEntries), 'F2: journals stay balanced').toBe(true)
    expect(derivedBal('acc-bank'), 'F2: no unbacked bank movement').toBe(500)
  })

  it('partial recorded payment then a smaller edit: refusal, ledger untouched', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-f2b', 1000))
    const pay = await state().recordPayment({
      partyId: 'party-c0',
      date: '2026-06-10',
      type: 'received',
      allocations: [{ invoiceId: 'inv-f2b', invoiceNumber: invoice('inv-f2b').invoiceNumber, amount: 500 }],
    })
    expect(pay.ok).toBe(true)
    expect(outstandingOf(invoice('inv-f2b'))).toBe(650)

    const before = cloneLedger()
    state().clearError()
    await state().saveInvoice(saveInvoicePayload('inv-f2b', 200))

    expect(
      derivedBal('acc-ar'),
      'F2: AR control must equal the party balance after a refused payment-funded shrink-edit',
    ).toBe(round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance))
    expect(round2(invoice('inv-f2b').grandTotal), 'F2: the smaller edit must be refused').toBe(1150)
    expect(outstandingOf(invoice('inv-f2b')), 'F2: outstanding unchanged').toBe(650)
    expect(state().lastError ?? '', 'F2: the refusal names the settled amount').toContain('500.00')
    expect(state().lastError ?? '', 'F2: the refusal names the attempted new total').toContain('230.00')
    expect(data(), 'F2: a refused edit leaves the ledger byte-identical').toEqual(before)
    expect(derivedBal('acc-bank'), 'F2: the recorded payment keeps its bank movement').toBe(500)
  })
})

describe('F4: an edit whose settled cash is suspense-funded is refused', () => {
  beforeAll(reseed)

  it('reconciled invoice edited: refusal instead of a direct bank re-post', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-f4a', 1000))
    const csv = [
      'Date,Description,Reference,Amount',
      '2026-06-01,"EFT payment for Probe Customer","",1150.00',
    ].join('\n')
    const imported = await state().importBankStatementCsv(csv)
    expect(imported.ok).toBe(true)
    const tx = data().bankTransactions[0]
    const rec = await state().reconcileTransaction(tx.id, 'inv-f4a')
    expect(rec.ok).toBe(true)
    expect(derivedBal('acc-bank'), 'sanity: the import moved the bank once').toBe(1150)
    expect(derivedBal('acc-suspense'), 'sanity: the reclass cleared suspense').toBe(0)
    expect(derivedBal('acc-ar'), 'sanity: the invoice is fully settled').toBe(0)

    const before = cloneLedger()
    state().clearError()
    await state().saveInvoice(saveInvoicePayload('inv-f4a', 2000))

    // Corruption asserts first: pre-fix these fail with the corruption visible.
    expect(
      derivedBal('acc-bank'),
      'F4: the settled cash must not be moved through Bank a second time',
    ).toBe(1150)
    expect(derivedBal('acc-suspense'), 'F4: suspense must stay cleared').toBe(0)
    expect(round2(invoice('inv-f4a').grandTotal), 'F4: the edit must be refused').toBe(1150)
    expect(outstandingOf(invoice('inv-f4a')), 'F4: outstanding unchanged').toBe(0)
    expect(state().lastError ?? '', 'F4: the refusal names the settled amount').toContain('1150.00')
    expect(state().lastError ?? '', 'F4: the refusal explains the funding source').toMatch(
      /reconciliation|statement/i,
    )
    expect(data(), 'F4: a refused edit leaves the ledger byte-identical').toEqual(before)
    expect(allJournalsBalanced(data().journalEntries), 'F4: journals stay balanced').toBe(true)
  })

  it('payment recorded after the statement import edited: refusal, bank/suspense intact', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-f4b', 1000))
    const csv = [
      'Date,Description,Reference,Amount',
      '2026-06-01,"EFT Probe Customer settlement","",1150.00',
    ].join('\n')
    const imported = await state().importBankStatementCsv(csv)
    expect(imported.ok).toBe(true)
    const pay = await state().recordPayment({
      partyId: 'party-c0',
      date: '2026-06-02',
      type: 'received',
      allocations: [{ invoiceId: 'inv-f4b', invoiceNumber: invoice('inv-f4b').invoiceNumber, amount: 1150 }],
    })
    expect(pay.ok).toBe(true)
    expect(derivedBal('acc-bank'), 'sanity: bank moved once (the import)').toBe(1150)
    expect(derivedBal('acc-suspense'), 'sanity: the payment cleared suspense').toBe(0)
    expect(derivedBal('acc-ar'), 'sanity: settled').toBe(0)
    expect(invoice('inv-f4b').status).toBe('Paid')

    const before = cloneLedger()
    state().clearError()
    await state().saveInvoice(saveInvoicePayload('inv-f4b', 2000))

    expect(
      derivedBal('acc-bank'),
      'F4: the settled cash must not move through Bank a second time',
    ).toBe(1150)
    expect(derivedBal('acc-suspense'), 'F4: suspense must stay cleared').toBe(0)
    expect(round2(invoice('inv-f4b').grandTotal), 'F4: the edit must be refused').toBe(1150)
    expect(state().lastError ?? '', 'F4: the refusal names the settled amount').toContain('1150.00')
    expect(data(), 'F4: a refused edit leaves the ledger byte-identical').toEqual(before)
  })
})

describe('controls: bank-funded partial settlements stay editable (no over-refusal)', () => {
  beforeAll(reseed)

  it('a partially-paid invoice edits fine to a total at or above the settled amount', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-ok1', 1000))
    const pay = await state().recordPayment({
      partyId: 'party-c0',
      date: '2026-06-10',
      type: 'received',
      allocations: [{ invoiceId: 'inv-ok1', invoiceNumber: invoice('inv-ok1').invoiceNumber, amount: 500 }],
    })
    expect(pay.ok).toBe(true)

    state().clearError()
    await state().saveInvoice(saveInvoicePayload('inv-ok1', 2000))

    expect(state().lastError, 'control: a bank-funded edit to a larger total is not refused').toBeNull()
    const inv = invoice('inv-ok1')
    expect(round2(inv.grandTotal)).toBe(2300)
    expect(outstandingOf(inv)).toBe(1800)
    expect(derivedBal('acc-ar')).toBe(1800)
    expect(round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance)).toBe(1800)
    expect(derivedBal('acc-bank'), 'control: the paid portion rides Bank exactly once').toBe(500)
    expect(allJournalsBalanced(data().journalEntries)).toBe(true)
    expect(
      derivedBal('acc-ar'),
      'control: AR control ties to the party balance',
    ).toBe(round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance))
  })

  it('a fully-paid invoice edits fine to a larger total (I5: the delta becomes outstanding)', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-ok2', 1000))
    const pay = await state().recordPayment({
      partyId: 'party-c0',
      date: '2026-06-10',
      type: 'received',
      allocations: [{ invoiceId: 'inv-ok2', invoiceNumber: invoice('inv-ok2').invoiceNumber, amount: 1150 }],
    })
    expect(pay.ok).toBe(true)
    expect(invoice('inv-ok2').status).toBe('Paid')

    state().clearError()
    await state().saveInvoice(saveInvoicePayload('inv-ok2', 2000))

    expect(state().lastError, 'control: a bank-funded fully-paid edit is not refused').toBeNull()
    const inv = invoice('inv-ok2')
    expect(round2(inv.grandTotal)).toBe(2300)
    expect(outstandingOf(inv)).toBe(1150)
    expect(derivedBal('acc-ar')).toBe(1150)
    expect(derivedBal('acc-bank'), 'control: the paid portion rides Bank exactly once').toBe(1150)
    expect(allJournalsBalanced(data().journalEntries)).toBe(true)
  })
})

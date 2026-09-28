/**
 * Final-review regression findings, pinned against the real store path.
 *
 * F1-import-sizing: deleting an invoice whose statement line was PARTIALLY
 * covered at import must re-import the line's FULL cash — the dead payment's
 * bank posting dies with its journal, so a surviving remainder-only import
 * journal under-states Bank by the covered share.
 *
 * F2-negative-total: editing a posted invoice to a negative grand total is
 * refused with its own clear message (the old paid-portion message read
 * "0.00 is already settled … more than -50.00").
 *
 * F2/F4 notes-only: a suspense-settled invoice refuses EVERY edit — including
 * notes-only edits, because the carried settlement is re-posted from the
 * invoice's own figures on every posted edit — and the refusal message says
 * so accurately (no dead-end "re-reconcile" guidance).
 *
 * F3-carry-rate: the carried re-post converts the paid portion at the
 * invoice's stored rate (plan.paidAmount is OWN currency;
 * createSettlementJournal posts BASE) — an FX invoice's carry must not
 * mis-state AR/Bank by ×rate.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { applyLoadedEnvelope, useBooksStore } from '../src/renderer/src/store'
import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../src/shared/chart'
import {
  accountsMatchJournals,
  allJournalsBalanced,
  computeAccountBalances,
  round2,
} from '../src/shared/accounting'
import type { BooksData, BooksDataEnvelope, Invoice } from '../src/shared/types'

const state = () => useBooksStore.getState()
const data = () => state().data

const seedLedger = (): BooksData => ({
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  settings: { ...DEFAULT_BOOK_SETTINGS, taxInclusive: false, companyName: 'Final Review Co' },
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

const workLine = (id: string, rate: number, taxRate = 15) => ({
  id,
  itemCode: 'T-1',
  description: 'Works',
  accountId: 'acc-sales',
  accountName: 'Sales',
  qty: 1,
  rate,
  taxRate,
  amount: rate,
})

const saveInvoicePayload = (id: string, rate: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'Sales' as const,
  partyId: 'party-c0',
  partyName: 'Probe Customer',
  status: 'Unpaid' as const,
  items: [workLine(`it-${id}`, rate)],
  ...extra,
})

const importCsv = async (rows: string[]): Promise<void> => {
  const result = await state().importBankStatementCsv(
    ['Date,Description,Reference,Amount', ...rows].join('\n'),
  )
  expect(result.ok, `import ok: ${result.error}`).toBe(true)
}

/** The F1 shape: payment first (bank-funded), then a statement line whose
 * text matches the payment — the import stores the link and posts only the
 * uncovered remainder — then the rest is reconciled and the invoice deleted. */
async function buildPartiallyCoveredLine(): Promise<string> {
  reseed()
  await state().saveInvoice(saveInvoicePayload('inv-f1', 1000))
  expect(round2(invoice('inv-f1').grandTotal)).toBe(1150)
  const pay = await state().recordPayment({
    partyId: 'party-c0',
    date: '2026-06-01',
    type: 'received',
    reference: 'EFT PARTIAL BUYER',
    allocations: [{ invoiceId: 'inv-f1', invoiceNumber: invoice('inv-f1').invoiceNumber, amount: 400 }],
  })
  expect(pay.ok).toBe(true)

  await importCsv(['2026-06-02,"EFT payment Probe Customer INV-2026-001","",1150.00'])
  const tx = (data().bankTransactions ?? [])[0]
  expect(tx.paymentLinks, 'the import linked the pre-recorded payment').toBeTruthy()
  expect(round2(tx.paymentLinks![0].amount)).toBe(400)
  // Bank: the payment's 400 + the import's 750 remainder = the full 1 150.
  expect(derivedBal('acc-bank'), 'import posts the uncovered remainder beside the payment').toBe(
    1150,
  )
  expect(derivedBal('acc-suspense')).toBe(-750)

  const rec = await state().reconcileTransaction(tx.id, 'inv-f1')
  expect(rec.ok, `reconcile ok: ${rec.error}`).toBe(true)
  expect(invoice('inv-f1').status, 'sanity: fully settled').toBe('Paid')
  expect(derivedBal('acc-ar'), 'sanity: AR fully cleared').toBe(0)
  return tx.id
}

describe('F1: delete-unwind re-imports the full cash of a partially covered line', () => {
  beforeAll(reseed)

  it('after deleting the invoice, Bank equals the statement cash and suspense is explainable', async () => {
    const txId = await buildPartiallyCoveredLine()
    const txBefore = (data().bankTransactions ?? [])[0]

    await state().deleteInvoice('inv-f1')
    expect(data().invoices.some((i) => i.id === 'inv-f1'), 'invoice deleted').toBe(false)

    // The statement's real cash is 1 150: the dead payment's 400 bank posting
    // died with its journal, so the surviving remainder-only import journal
    // (750) must be RESIZED to the full line, not treated as the full truth.
    expect(
      derivedBal('acc-bank'),
      'Bank == the statement cash (1 150), not the stale remainder (750)',
    ).toBe(1150)
    // Suspense: the full line is unallocated awaiting re-settlement.
    expect(derivedBal('acc-suspense'), 'suspense holds the full unallocated line').toBe(-1150)
    expect(derivedBal('acc-ar'), 'AR unwound').toBe(0)
    expect(
      round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance),
      'party unwound',
    ).toBe(0)
    expect(allJournalsBalanced(data().journalEntries), 'journals balanced').toBe(true)
    expect(accountsMatchJournals(data().accounts, data().journalEntries)).toBe(true)

    const txAfter = (data().bankTransactions ?? [])[0]
    expect(txAfter.id).toBe(txId)
    expect(txAfter.reconciled, 'the line is un-reconciled and re-allocatable').toBe(false)
    expect(txAfter.paymentLinks, 'the dead payment link is gone').toBeUndefined()
    expect(
      Math.abs(txAfter.amount),
      'the statement line itself is untouched',
    ).toBe(1150)
    void txBefore
  })
})

describe('F2: negative-total edits get their own clear refusal', () => {
  beforeAll(reseed)

  it('editing an unpaid invoice to a negative grand total is refused, not mis-explained', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-neg', 1000))
    const before = cloneLedger()
    state().clearError()

    await state().saveInvoice(saveInvoicePayload('inv-neg', -50, { taxRate: 0 }))
    expect(state().lastError ?? '', 'the refusal names the negative total').toMatch(/negative/)
    expect(state().lastError ?? '').not.toMatch(/already settled/)
    expect(JSON.stringify(data())).toBe(JSON.stringify(before))
    expect(derivedBal('acc-ar'), 'nothing moved').toBe(1150)
  })
})

describe('F2/F4: suspense-settled invoices refuse notes-only edits too, with an accurate message', () => {
  beforeAll(reseed)

  it('a notes-only edit of a suspense-settled invoice is refused and nothing moves', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-susp', 1000))
    await importCsv(['2026-06-02,"EFT payment Probe Customer INV-2026-001","",1150.00'])
    const tx = (data().bankTransactions ?? [])[0]
    const rec = await state().reconcileTransaction(tx.id, 'inv-susp')
    expect(rec.ok, `sanity: settled: ${rec.error}`).toBe(true)
    expect(invoice('inv-susp').status).toBe('Paid')
    expect(derivedBal('acc-suspense'), 'sanity: suspense cleared by the reclass').toBe(0)

    const before = cloneLedger()
    state().clearError()
    // Notes-only: no items, no money, no status change.
    await state().saveInvoice({ id: 'inv-susp', notes: 'Updated payment terms' })

    expect(
      state().lastError ?? '',
      'the refusal explains that every edit re-posts the settled cash',
    ).toMatch(/every edit of this invoice re-posts/i)
    expect(state().lastError ?? '').not.toMatch(/re-reconcile/)
    expect(JSON.stringify(data()), 'the refusal leaves the ledger byte-identical').toBe(
      JSON.stringify(before),
    )
    // Control accounts unchanged.
    expect(derivedBal('acc-ar')).toBe(0)
    expect(derivedBal('acc-bank')).toBe(1150)
    expect(derivedBal('acc-suspense')).toBe(0)
  })

  it('a money edit of the same invoice is refused by the same guard', async () => {
    reseed()
    await state().saveInvoice(saveInvoicePayload('inv-susp2', 1000))
    await importCsv(['2026-06-02,"EFT payment Probe Customer INV-2026-001","",1150.00'])
    const tx = (data().bankTransactions ?? [])[0]
    const rec = await state().reconcileTransaction(tx.id, 'inv-susp2')
    expect(rec.ok).toBe(true)

    const before = cloneLedger()
    state().clearError()
    await state().saveInvoice(saveInvoicePayload('inv-susp2', 2000))

    expect(state().lastError ?? '', 'the money edit hits the same refusal').toMatch(
      /every edit of this invoice re-posts/i,
    )
    expect(JSON.stringify(data())).toBe(JSON.stringify(before))
  })
})

describe('F3: the carried re-post converts the paid portion at the stored rate', () => {
  beforeAll(reseed)

  it('editing a partially paid EUR invoice keeps AR and party tied in base', async () => {
    reseed()
    // A zero-rated EUR invoice: grand 1 000 own = 20 000 base.
    await state().saveInvoice({
      id: 'inv-fx',
      type: 'Sales',
      partyId: 'party-c0',
      partyName: 'Probe Customer',
      status: 'Unpaid',
      currency: 'EUR',
      exchangeRate: 20,
      items: [{ ...workLine('it-fx', 1000, 0) }],
    })
    const posted = invoice('inv-fx')
    expect(round2(posted.grandTotal), 'sanity: own-currency total').toBe(1000)
    expect(derivedBal('acc-ar'), 'sanity: posting is ×20 in base').toBe(20000)

    // Half paid, in BASE (the payment boundary is base).
    const pay = await state().recordPayment({
      partyId: 'party-c0',
      date: '2026-06-01',
      type: 'received',
      allocations: [{ invoiceId: 'inv-fx', invoiceNumber: invoice('inv-fx').invoiceNumber, amount: 10000 }],
    })
    expect(pay.ok, pay.error).toBe(true)
    expect(derivedBal('acc-ar'), 'sanity: half the base outstanding left').toBe(10000)
    expect(round2(outstandingOf(invoice('inv-fx'))), 'sanity: own-currency remainder').toBe(500)

    // Edit to a larger own-currency total (allowed: F2 only refuses when the
    // new total is BELOW the paid portion). The carried re-post must be the
    // paid portion converted at the stored rate.
    await state().saveInvoice({
      id: 'inv-fx',
      type: 'Sales',
      partyId: 'party-c0',
      partyName: 'Probe Customer',
      status: 'Unpaid',
      currency: 'EUR',
      exchangeRate: 20,
      items: [{ ...workLine('it-fx-2', 1500, 0) }],
    })
    expect(round2(invoice('inv-fx').grandTotal), 'sanity: new own total').toBe(1500)

    // AR: new posting 30 000 − carried 10 000 = 20 000; the party carries
    // 1 000 own × 20 = 20 000. The tie holds only when the carry is in base.
    expect(
      derivedBal('acc-ar'),
      'AR == new posting − carried base (the ×rate mis-state must not return)',
    ).toBe(20000)
    expect(
      round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance),
      'party balance (base)',
    ).toBe(20000)
    expect(derivedBal('acc-bank'), 'Bank: the carried cash re-posts at its true base amount').toBe(
      10000,
    )
    expect(allJournalsBalanced(data().journalEntries), 'journals balanced').toBe(true)
    expect(accountsMatchJournals(data().accounts, data().journalEntries)).toBe(true)
  })
})

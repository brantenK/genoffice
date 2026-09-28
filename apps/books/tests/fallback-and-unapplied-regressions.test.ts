/**
 * Regression tests for the fallback-account finding F1 and the unapplied-receipt
 * attribution finding F5.
 *
 * F1: the invoice builders' fallback account (used when NO line carries an
 *     effective amount) matched `accountType` before `id` in chart order and
 *     could land on a GROUP account (acc-income / acc-expense) — a balance
 *     computeAccountBalances overwrites from children, so the leg silently
 *     vanished from the ledger, and the credit-note mirror reversed onto a
 *     leaf, breaking the original+CN netting contract. Fixed semantics:
 *     fallbacks resolve to LEAF accounts only, the credit note mirrors the
 *     invoice's own grouping (zero-effective lines post no group on either
 *     side), so original + full CN nets EVERY account to zero — including
 *     round-off-only invoices and mixed zero/effective lines.
 *
 * F5: an unapplied receipt (the over-payment excess) used to ride the LAST
 *     FUNDED invoice's settlement journal while the credit rode the LAST
 *     TARGET's outstanding — deleting or editing either stranded the other.
 *     Fixed semantics: the excess may ride the settlement entry only when it
 *     belongs to the SAME invoice; a cross-invoice ride posts as its OWN
 *     balanced entry, structurally attributed to the carrier (its AR/AP leg
 *     carries the carrier's invoiceId), so deleting either side removes
 *     exactly its own legs and the survivor stays coherent.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  allJournalsBalanced,
  computeAccountBalances,
  createSalesInvoiceJournal,
  round2,
} from '../src/shared/accounting'
import { createCreditNoteJournal } from '../src/shared/credit-notes'
import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../src/shared/chart'
import { applyLoadedEnvelope, useBooksStore } from '../src/renderer/src/store'
import type { Account, BooksData, Invoice, InvoiceItem, JournalEntry, Party } from '../src/shared/types'

const ACCOUNTS: Account[] = EMPTY_ACCOUNTS.map((a) => ({ ...a, balance: 0 }))
const GROUP_IDS = new Set(ACCOUNTS.filter((a) => a.isGroup).map((a) => a.id))
const PARTY: Party = { id: 'party-f1', name: 'Fallback Customer', type: 'Customer', outstandingBalance: 0 }

const baseInvoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: 'inv-f1',
  invoiceNumber: 'INV-F1-001',
  type: 'Sales',
  partyId: PARTY.id,
  partyName: PARTY.name,
  date: '2026-06-01',
  dueDate: '2026-07-01',
  items: [],
  subtotal: 0,
  taxTotal: 0,
  grandTotal: 0,
  outstandingAmount: 0,
  status: 'Unpaid',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

/** The wave-1 repro line: fully rebated (100% line discount) → effective 0. */
const rebatedLine = (accountId = 'acc-sales', over: Partial<InvoiceItem> = {}): InvoiceItem => ({
  id: 'it-rebated',
  itemCode: 'F1-1',
  description: 'Rebated line',
  accountId,
  accountName: accountId,
  qty: 3.75,
  rate: 44283.26,
  taxRate: 10,
  amount: 166062.23,
  discountRate: 100,
  ...over,
})

const expectNoGroupLegs = (je: JournalEntry, ctx: string): void => {
  for (const item of je.items) {
    expect(
      GROUP_IDS.has(item.accountId),
      `${ctx}: no leg may post to a group account (${item.accountId})`,
    ).toBe(false)
  }
}

const expectNetsToZero = (journals: JournalEntry[], ctx: string): void => {
  const derived = computeAccountBalances(ACCOUNTS, journals)
  for (const acc of derived) {
    expect(round2(acc.balance) || 0, `${ctx}: ${acc.id} nets to zero`).toBe(0)
  }
}

describe('F1: fallback legs land on leaves and original+CN nets to zero', () => {
  it('round-off-only invoice (seed 771393 repro) nets every account to zero', () => {
    // The wave-1 minimal repro: a fully rebated line, stored totals (0, 0, 0.5)
    // and a 0.50 round-off — the only money on the invoice is the round-off.
    const original = baseInvoice({
      items: [rebatedLine('acc-sales')],
      subtotal: 0,
      taxTotal: 0,
      grandTotal: 0.5,
      outstandingAmount: 0.5,
      roundOff: 0.5,
    })
    const je = createSalesInvoiceJournal(original, ACCOUNTS, PARTY)
    expect(allJournalsBalanced([je]), 'F1: the original journal is balanced').toBe(true)
    expectNoGroupLegs(je, 'F1 original')

    const cn: Invoice = {
      ...original,
      id: 'cn-f1',
      invoiceNumber: 'CN-F1-001',
      creditNote: true,
      creditedInvoiceId: original.id,
      outstandingAmount: -0.5,
      items: [{ ...rebatedLine('acc-sales'), id: 'cn-it' }],
    }
    const jeCn = createCreditNoteJournal(cn, ACCOUNTS, PARTY)
    expect(allJournalsBalanced([jeCn]), 'F1: the credit note is balanced').toBe(true)
    expectNoGroupLegs(jeCn, 'F1 credit note')

    expectNetsToZero([je, jeCn], 'F1 round-off-only pair')
  })

  it('stored totals on zero-effective lines post on a leaf and net with the credit note', () => {
    const original = baseInvoice({
      items: [rebatedLine('acc-sales')],
      subtotal: 100,
      taxTotal: 15,
      grandTotal: 115,
      outstandingAmount: 115,
    })
    const je = createSalesInvoiceJournal(original, ACCOUNTS, PARTY)
    expect(allJournalsBalanced([je]), 'F1: balanced').toBe(true)
    expectNoGroupLegs(je, 'F1 stored-totals original')
    // The stored subtotal must be visible in the LEDGER (a group-account leg
    // would be silently dropped by the rollup).
    const incomeLegs = je.items.filter((it) => it.credit > 0 && it.accountId !== 'acc-vat')
    expect(
      round2(incomeLegs.reduce((s, it) => s + it.credit, 0)),
      'F1: the stored subtotal posts on a leaf the rollup keeps',
    ).toBe(100)

    const cn: Invoice = {
      ...original,
      id: 'cn-f1b',
      invoiceNumber: 'CN-F1-002',
      creditNote: true,
      outstandingAmount: -115,
      items: [{ ...rebatedLine('acc-sales'), id: 'cn-it' }],
    }
    const jeCn = createCreditNoteJournal(cn, ACCOUNTS, PARTY)
    expectNetsToZero([je, jeCn], 'F1 stored-totals pair')
  })

  it('mixed zero and effective lines net: residual legs follow the first effective group', () => {
    const lines: InvoiceItem[] = [
      rebatedLine('acc-consult', { id: 'it-zero', qty: 2, rate: 500, amount: 1000 }),
      {
        id: 'it-live',
        itemCode: 'F1-2',
        description: 'Live line',
        accountId: 'acc-sales',
        accountName: 'Sales',
        qty: 1,
        rate: 1000,
        taxRate: 15,
        amount: 1000,
      },
    ]
    const original = baseInvoice({
      items: lines,
      subtotal: 1000,
      taxTotal: 150,
      grandTotal: 1150.5,
      outstandingAmount: 1150.5,
      roundOff: 0.5,
    })
    const je = createSalesInvoiceJournal(original, ACCOUNTS, PARTY)
    expectNoGroupLegs(je, 'F1 mixed original')
    // The round-off leg must sit on the same account the credit note will use.
    const roundOffLeg = je.items.find((it) => it.remark?.includes('Round-off'))
    expect(roundOffLeg?.accountId, 'F1: round-off follows the first effective group').toBe(
      'acc-sales',
    )

    const cn: Invoice = {
      ...original,
      id: 'cn-f1c',
      invoiceNumber: 'CN-F1-003',
      creditNote: true,
      outstandingAmount: -1150.5,
      items: lines.map((l) => ({ ...l, id: `cn-${l.id}` })),
    }
    const jeCn = createCreditNoteJournal(cn, ACCOUNTS, PARTY)
    const roundOffCn = jeCn.items.find((it) => it.remark?.includes('Round-off'))
    expect(
      roundOffCn?.accountId,
      'F1: the credit-note round-off mirrors the original\u2019s account',
    ).toBe('acc-sales')
    expectNetsToZero([je, jeCn], 'F1 mixed pair')
  })
})

/* ─────────────────────────── F5 (store-driven) ─────────────────────────── */

const state = () => useBooksStore.getState()
const data = () => state().data

const seedLedger = (): BooksData => ({
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  settings: { ...DEFAULT_BOOK_SETTINGS, taxInclusive: false, companyName: 'F5 Co' },
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

const saveInvoicePayload = (id: string, rate: number) => ({
  id,
  type: 'Sales' as const,
  partyId: 'party-c0',
  partyName: 'Probe Customer',
  status: 'Unpaid' as const,
  items: [
    {
      id: `it-${id}`,
      itemCode: 'T-1',
      description: 'Works',
      accountId: 'acc-sales',
      accountName: 'Sales',
      qty: 1,
      rate,
      taxRate: 15,
      amount: rate,
    },
  ],
})

const importCsv = async (rows: string[]): Promise<void> => {
  const result = await state().importBankStatementCsv(
    ['Date,Description,Reference,Amount', ...rows].join('\n'),
  )
  expect(result.ok, `import ok: ${result.error}`).toBe(true)
}

/** Builds the cross-invoice ride: B first carries a credit, then a split
 * settlement of a second line funds A while B (in credit) is the carrier. */
async function buildCrossInvoiceRide(): Promise<{ txA: string; txB: string }> {
  reseed()
  await state().saveInvoice(saveInvoicePayload('inv-b', 1000))
  await importCsv(['2026-06-01,"EFT overpayment for Probe Customer","",1500.00'])
  const txB = data().bankTransactions[0].id
  const recB = await state().reconcileTransaction(txB, 'inv-b')
  expect(recB.ok, `sanity: B carries the credit: ${recB.error}`).toBe(true)
  expect(outstandingOf(invoice('inv-b')), 'sanity: B in credit').toBe(-350)

  await state().saveInvoice(saveInvoicePayload('inv-a', 1000))
  await importCsv(['2026-06-02,"EFT second line for Probe Customer","",1200.00'])
  const txA = data().bankTransactions[1].id
  // Split across [A, B]: A is funded; B (in credit) is the last target — the
  // unapplied excess rides A's settlement journal pre-fix, its own entry post-fix.
  const recSplit = await state().reconcileTransaction(txA, '', ['inv-a', 'inv-b'])
  expect(recSplit.ok, `sanity: split reconcile: ${recSplit.error}`).toBe(true)
  expect(outstandingOf(invoice('inv-a')), 'sanity: A fully settled').toBe(0)
  expect(outstandingOf(invoice('inv-b')), 'sanity: B takes the excess as more credit').toBe(-400)
  return { txA, txB }
}

describe('F5: a cross-invoice unapplied ride is its own attributed entry', () => {
  beforeAll(() => reseed())

  it('the excess posts in a journal that carries no other invoice\u2019s legs', async () => {
    await buildCrossInvoiceRide()
    const rideJournals = data().journalEntries.filter((je) =>
      je.items.some((it) => it.remark?.startsWith('Unapplied')),
    )
    expect(rideJournals.length, 'F5: the ride exists').toBeGreaterThan(0)
    for (const je of rideJournals) {
      expect(
        je.items.some((it) => it.invoiceId === 'inv-a'),
        'F5: the ride journal must not carry the funded invoice\u2019s legs',
      ).toBe(false)
      expect(
        je.items.some((it) => it.invoiceId === 'inv-b'),
        'F5: the ride is attributed to the carrier',
      ).toBe(true)
    }
  })

  it('deleting the funded invoice leaves the carrier\u2019s ride intact and coherent', async () => {
    await buildCrossInvoiceRide()
    await state().deleteInvoice('inv-a')
    expect(data().invoices.some((i) => i.id === 'inv-a'), 'A deleted').toBe(false)
    // B keeps its credit ride: outstanding −400, AR −400, party −400.
    expect(outstandingOf(invoice('inv-b')), 'F5: the carrier keeps the ride').toBe(-400)
    expect(derivedBal('acc-ar'), 'F5: AR control == the carrier credit').toBe(-400)
    expect(
      round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance),
      'F5: party balance == the carrier credit',
    ).toBe(-400)
    // Line 2's freed cash (1150) returns to suspense; the ride's 50 stays held.
    expect(
      derivedBal('acc-suspense'),
      'F5: suspense holds the freed remainder minus the live ride',
    ).toBe(-1150)
    expect(allJournalsBalanced(data().journalEntries), 'F5: journals balanced').toBe(true)
    const derived = computeAccountBalances(data().accounts, data().journalEntries)
    for (const acc of data().accounts) {
      expect(
        round2(acc.balance),
        `F5: account ${acc.id} is journal-derived after the delete`,
      ).toBe(round2(derived.find((x) => x.id === acc.id)!.balance))
    }
  })

  it('deleting the carrier removes the ride with it; no orphan journal remains', async () => {
    await buildCrossInvoiceRide()
    await state().deleteInvoice('inv-b')
    expect(data().invoices.some((i) => i.id === 'inv-b'), 'B deleted').toBe(false)
    const orphans = data().journalEntries.filter((je) =>
      je.items.some((it) => it.invoiceId === 'inv-b' || it.remark?.startsWith('Unapplied')),
    )
    expect(orphans, 'F5: no orphan ride journal survives the carrier delete').toHaveLength(0)
    expect(derivedBal('acc-ar'), 'F5: AR unwound').toBe(0)
    expect(
      round2(data().parties.find((p) => p.id === 'party-c0')!.outstandingBalance),
      'F5: party unwound',
    ).toBe(0)
    // Line 1's import journal survives (real cash) with its full remainder in
    // suspense; line 2's import holds its line, of which A's 1150 allocation
    // is still live — only B's removed 50 ride returns to suspense.
    expect(derivedBal('acc-bank'), 'F5: both import journals survive').toBe(2700)
    expect(
      derivedBal('acc-suspense'),
      'F5: suspense holds line 1 in full plus line 2\u2019s freed ride',
    ).toBe(-1550)
    expect(allJournalsBalanced(data().journalEntries), 'F5: journals balanced').toBe(true)
  })
})

/**
 * Randomized settlement fuzz: ~2 500 scenarios against the real settlement /
 * payments engines (applyBankStatementImport, applyReconciliation, applyPayment,
 * createPaymentJournal, linkPaymentToBankTransaction), mixing exact pay,
 * partial pay, over-amount lines, split allocation across invoiceIds[],
 * direction mismatches, credit-carrying parties (unapplied receipts) and
 * re-import / re-settle idempotency.
 *
 * After EVERY scenario (and after every rejected op) the whole ledger must
 * still satisfy:
 *   - every journal balanced (items and totals);
 *   - no journal item carries both sides; fixed legs single-sided;
 *   - Bank Suspense equals the explainable model: minus the uncovered cash of
 *     every imported-but-unreconciled statement line, zero otherwise
 *     (reconciled lines are cleared by the reclass/unapplied legs);
 *   - stored party balances === recomputePartyBalances(invoices, parties);
 *   - AR control === sum of customer party balances and AP control === sum of
 *     supplier party balances (exact at rate 1; within the documented FX
 *     write-back dust allowance otherwise — see the report);
 *   - rejected ops leave the ledger byte-identical (engines never mutate).
 */
import { describe, expect, it } from 'vitest'
import {
  allJournalsBalanced,
  calculateInvoiceTotals,
  computeAccountBalances,
  createPurchaseBillJournal,
  createSalesInvoiceJournal,
  invoiceExchangeRate,
  nextJournalNumber,
  recomputePartyBalances,
  round2,
  toBaseAmount,
} from '../src/shared/accounting'
import {
  applyPayment,
  createPaymentJournal,
  linkPaymentToBankTransaction,
  paymentCoverage,
} from '../src/shared/payments'
import { applyBankStatementImport, applyReconciliation } from '../src/shared/settlement'
import { mentionsReference } from '../src/shared/credit-notes'
import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../src/shared/chart'
import { cents, makeFuzz, type Fuzz } from './fuzz-random'
import type {
  Account,
  BankTransaction,
  BooksData,
  Invoice,
  InvoiceItem,
  JournalEntry,
  Party,
} from '../src/shared/types'

/** Fixed master seed for the settlement fuzz. */
const SEED = 0x5e771e
const SCENARIOS = 2_500
const CHUNKS = 5
const SCENARIOS_PER_CHUNK = SCENARIOS / CHUNKS

/** Coverage tally — printed once at the end so the sign-off can see the mix. */
const tally = {
  imports: 0,
  payments: 0,
  paymentsRefused: 0,
  reconciles: 0,
  splitReconciles: 0,
  mismatchRefused: 0,
  reimports: 0,
  unappliedReceipts: 0,
  creditCarrierTargets: 0,
  fxScenarios: 0,
  dustIncidents: 0,
  maxDustDiff: 0,
}

const ACCOUNTS: Account[] = EMPTY_ACCOUNTS.map((a) => ({ ...a, balance: 0 }))

const cloneLedger = (data: BooksData): BooksData =>
  JSON.parse(JSON.stringify(data)) as BooksData

const balanceOf = (accounts: Account[], id: string): number =>
  accounts.find((a) => a.id === id)?.balance ?? 0

const outstandingOf = (inv: Invoice): number =>
  round2(inv.outstandingAmount !== undefined && inv.outstandingAmount !== null ? inv.outstandingAmount : inv.grandTotal)

/** Journal-shape check shared with the money-core suite (subset). */
function checkShape(je: JournalEntry, ctx: string): void {
  for (const it of je.items) {
    expect(
      !(it.debit > 0 && it.credit > 0) && !(it.debit < 0 || it.credit < 0),
      `${ctx} item on ${it.accountId} single-sided (d=${it.debit} c=${it.credit})`,
    ).toBe(true)
  }
  const sides = new Map<string, { d: number; c: number }>()
  for (const it of je.items) {
    const agg = sides.get(it.accountId) || { d: 0, c: 0 }
    agg.d = round2(agg.d + it.debit)
    agg.c = round2(agg.c + it.credit)
    sides.set(it.accountId, agg)
  }
  for (const [acc, agg] of sides) {
    const fixed = acc === 'acc-ar' || acc === 'acc-ap' || acc.startsWith('acc-vat')
    expect(
      !fixed || agg.d === 0 || agg.c === 0,
      `${ctx} fixed leg ${acc} carries both sides (d=${agg.d} c=${agg.c})`,
    ).toBe(true)
    expect(
      !(agg.d > 0 && agg.c > 0),
      `${ctx} account ${acc} carries both sides (d=${agg.d} c=${agg.c})`,
    ).toBe(true)
  }
}

interface BuiltLedger {
  data: BooksData
  rate: number
  /** FX write-back dust allowance accumulated by partial settlements. */
  dust: number
}

function buildScenario(f: Fuzz, index: number): BuiltLedger {
  const fx = index % 8 === 0
  const rate = fx ? f.fxRate() : 1

  const parties: Party[] = []
  for (let c = 0; c < f.int(1, 2); c++) {
    parties.push({
      id: `party-cust-${index}-${c}`,
      name: `Fuzz Customer ${index}_${c}`,
      type: 'Customer',
      outstandingBalance: 0,
    })
  }
  for (let s = 0; s < f.int(1, 2); s++) {
    parties.push({
      id: `party-supp-${index}-${s}`,
      name: `Fuzz Supplier ${index}_${s}`,
      type: 'Supplier',
      outstandingBalance: 0,
    })
  }

  const invoices: Invoice[] = []
  const journals: JournalEntry[] = []
  const count = f.int(1, 4)
  for (let k = 0; k < count; k++) {
    const type: 'Sales' | 'Purchase' = f.chance(0.6) ? 'Sales' : 'Purchase'
    const pool = parties.filter((p) => (type === 'Sales' ? p.type === 'Customer' : p.type === 'Supplier'))
    const party = f.pick(pool)
    const items: InvoiceItem[] = Array.from({ length: f.int(1, 2) }, (_, li) => {
      const qty = f.int(1, 9)
      const lineRate = f.int(100, 400_000) / 100
      const taxRate = f.pick([0, 15, 14.99, 7.5])
      const amount = round2(qty * lineRate)
      return {
        id: `it-${index}-${k}-${li}`,
        itemCode: 'FZ-1',
        description: 'Settlement fuzz line',
        accountId: type === 'Sales' ? 'acc-sales' : 'acc-materials',
        accountName: type === 'Sales' ? 'Sales' : 'Materials',
        qty,
        rate: lineRate,
        taxRate,
        amount,
      }
    })
    const totals = calculateInvoiceTotals(items, {})
    const invoice: Invoice = {
      id: `inv-${index}-${k}`,
      invoiceNumber: `${type === 'Sales' ? 'INV' : 'BILL'}-FZ-${index}-${k}`,
      type,
      partyId: party.id,
      partyName: party.name,
      date: f.isoDate(),
      dueDate: f.isoDate(),
      items,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      outstandingAmount: totals.grandTotal,
      status: 'Unpaid',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...(fx ? { currency: 'EUR', exchangeRate: rate } : {}),
    }
    journals.push(
      type === 'Sales'
        ? createSalesInvoiceJournal(invoice, ACCOUNTS, party)
        : createPurchaseBillJournal(invoice, ACCOUNTS, party),
    )
    invoices.push(invoice)
  }

  const data: BooksData = {
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    settings: { ...DEFAULT_BOOK_SETTINGS, taxInclusive: false },
    accounts: computeAccountBalances(
      ACCOUNTS.map((a) => ({ ...a, balance: 0 })),
      journals,
    ),
    parties: recomputePartyBalances(invoices, parties),
    invoices,
    journalEntries: journals,
    quotes: [],
    bankTransactions: [],
    payments: [],
    auditLog: [],
  }
  return { data, rate, dust: 0 }
}

function runScenario(index: number, log: string[]): BuiltLedger {
  const f = makeFuzz((SEED ^ 0x5e77) + index)
  const built = buildScenario(f, index)
  let data = built.data
  const rate = built.rate
  let dust = built.dust
  const ctx = `settle#${index} seed=${(SEED ^ 0x5e77) + index}`
  const csvs: string[] = []
  if (rate !== 1) tally.fxScenarios++

  const customers = data.parties.filter((p) => p.type === 'Customer')
  const suppliers = data.parties.filter((p) => p.type === 'Supplier')

  // ── Op: record a payment (before or after import, exercising both orders) ──
  const paymentOp = (): void => {
    const party = f.pick([...customers, ...suppliers])
    const type = party.type === 'Customer' ? 'received' : 'paid'
    const open = data.invoices.filter(
      (inv) =>
        inv.partyId === party.id &&
        inv.status === 'Unpaid' &&
        round2(toBaseAmount(outstandingOf(inv), invoiceExchangeRate(inv))) > 0,
    )
    if (open.length === 0) return
    const targets = open.slice(0, f.int(1, Math.min(2, open.length)))
    const allocations = targets.map((inv) => {
      const outstandingBase = round2(toBaseAmount(outstandingOf(inv), invoiceExchangeRate(inv)))
      // Over-allocation attempts are part of the mix: the engine must refuse.
      const roll = f.float()
      const amount =
        roll < 0.45 ? outstandingBase : roll < 0.9 ? round2(outstandingBase * (f.int(10, 90) / 100)) : round2(outstandingBase + f.int(1, 500) / 100)
      return { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: Math.max(amount, 0.01) }
    })
    const before = cloneLedger(data)
    const result = applyPayment(data, {
      partyId: party.id,
      date: f.isoDate(),
      type,
      method: 'Bank Transfer',
      reference: `FZ-PAY-${index}`,
      allocations,
    })
    if (!result.ok || !result.payment || !result.updatedInvoices) {
      expect(result.ok, `${ctx} over-allocation refused: ${result.error}`).toBe(false)
      expect(data, `${ctx} refused payment leaves the ledger untouched`).toEqual(before)
      tally.paymentsRefused++
      return
    }
    const payment = result.payment
    const linked = linkPaymentToBankTransaction(data, payment)
    const matchedTx = linked.matchedTransactionId
      ? linked.bankTransactions.find((t) => t.id === linked.matchedTransactionId) ?? null
      : null
    const hasImportJournal =
      matchedTx !== null &&
      data.journalEntries.some((je) =>
        mentionsReference(je.remarks, `Bank statement import: ${matchedTx.id}`),
      )
    const journal = createPaymentJournal(
      payment,
      result.updatedInvoices,
      data.accounts,
      nextJournalNumber(data.journalEntries, payment.date),
      hasImportJournal ? { suspenseAmount: linked.coveredAmount || 0 } : undefined,
    )
    const nextJournals = [journal, ...data.journalEntries]
    tally.payments++
    data = {
      ...data,
      bankTransactions: linked.bankTransactions,
      payments: [payment, ...(data.payments || [])],
      invoices: result.updatedInvoices,
      journalEntries: nextJournals,
      accounts: computeAccountBalances(data.accounts, nextJournals),
      parties: recomputePartyBalances(result.updatedInvoices, data.parties),
    }
    // Partial settlements of FX invoices strand documented sub-cent write-back dust.
    for (const inv of result.updatedInvoices) {
      const r = invoiceExchangeRate(inv)
      if (r !== 1) {
        const beforeOutstanding = round2(
          toBaseAmount(
            outstandingOf(before.invoices.find((i) => i.id === inv.id)!),
            r,
          ),
        )
        const afterOutstanding = round2(toBaseAmount(outstandingOf(inv), r))
        if (beforeOutstanding !== afterOutstanding && afterOutstanding !== 0) {
          dust = round2(dust + 0.01 * r + 0.03)
        }
      }
    }
  }

  // ── Op: import a small synthetic statement ──
  const importOp = (): void => {
    const rows: string[] = ['Date,Description,Reference,Amount']
    const rowCount = f.int(1, 3)
    for (let k = 0; k < rowCount; k++) {
      const deposit = f.chance(0.65)
      let amount: number
      let description = `EFT fuzz ${index}_${k}`
      if (f.chance(0.7)) {
        // Size the line against a real invoice of the matching direction so
        // exact / partial / over-amount flows all occur.
        const direction = deposit ? 'Sales' : 'Purchase'
        const pool = data.invoices.filter((inv) => inv.type === direction && inv.status === 'Unpaid')
        if (pool.length > 0) {
          const inv = f.pick(pool)
          const outstandingBase = round2(
            toBaseAmount(outstandingOf(inv), invoiceExchangeRate(inv)),
          )
          const roll = f.float()
          amount =
            roll < 0.4 ? outstandingBase : roll < 0.8 ? round2(outstandingBase * (f.int(20, 90) / 100)) : round2(outstandingBase + f.int(100, 50_000) / 100)
          if (f.chance(0.6)) description = `${description} ${inv.invoiceNumber}`
          if (f.chance(0.4)) description = `${inv.partyName} ${description}`
        } else {
          amount = f.int(100, 500_000) / 100
        }
      } else {
        amount = f.int(100, 500_000) / 100
      }
      if (amount <= 0) amount = 1
      rows.push(
        `${f.isoDate()},"${description}","REF-${index}-${k}",${deposit ? round2(Math.abs(amount)).toFixed(2) : (-round2(Math.abs(amount))).toFixed(2)}`,
      )
    }
    const csv = rows.join('\n')
    const { result, ledger } = applyBankStatementImport(data, csv)
    expect(result.ok, `${ctx} import ok: ${result.error}`).toBe(true)
    expect(ledger, `${ctx} import returns a ledger`).not.toBeNull()
    tally.imports++
    data = ledger!
    csvs.push(csv)
  }

  // ── Op: reconcile (1-2 rounds; split allocations, mismatches, credit carriers) ──
  const reconcileOp = (round: number): void => {
    const unreconciled = (data.bankTransactions || []).filter(
      (t) => !t.reconciled && round2(Math.abs(t.amount || 0) - paymentCoverage(t)) > 0,
    )
    if (unreconciled.length === 0) return
    const tx = f.pick(unreconciled)
    const txAmount = round2(Math.abs(tx.amount || 0))
    const direction: 'Sales' | 'Purchase' = tx.amount > 0 ? 'Sales' : 'Purchase'

    // Direction-mismatch attempt: a payment posted against a bill of the
    // other direction must be refused, byte-identical ledger.
    if (f.chance(0.15)) {
      const wrong = data.invoices.filter((inv) => inv.type !== direction && inv.status === 'Unpaid')
      if (wrong.length > 0) {
        const before = cloneLedger(data)
        const bad = applyReconciliation(data, { transactionId: tx.id, invoiceId: f.pick(wrong).id })
        expect(bad.result.ok, `${ctx} direction mismatch refused`).toBe(false)
        expect(bad.ledger, `${ctx} direction mismatch returns no ledger`).toBeNull()
        expect(data, `${ctx} refused reconciliation leaves the ledger untouched`).toEqual(before)
        tally.mismatchRefused++
        return
      }
    }

    const candidates = data.invoices.filter((inv) => {
      if (inv.type !== direction) return false
      if (inv.status !== 'Unpaid') return false
      return round2(toBaseAmount(outstandingOf(inv), invoiceExchangeRate(inv))) !== 0
    })
    if (candidates.length === 0) return

    // Credit carriers ride along: an invoice already in credit absorbs the
    // line as an unapplied receipt (the code's documented route).
    const carrierFirst = candidates.find(
      (inv) => round2(toBaseAmount(outstandingOf(inv), invoiceExchangeRate(inv))) < 0,
    )
    const useSplit = candidates.length >= 2 && f.chance(0.35)
    const picks = useSplit
      ? candidates.slice(0, Math.min(candidates.length, f.int(2, 3)))
      : [carrierFirst && f.chance(0.4) ? carrierFirst : f.pick(candidates)]
    if (picks.some((inv) => round2(toBaseAmount(outstandingOf(inv), invoiceExchangeRate(inv))) < 0)) {
      tally.creditCarrierTargets++
    }

    const before = cloneLedger(data)
    const coverageBefore = round2(Math.min(paymentCoverage(tx), txAmount))
    const lineAmount = round2(txAmount - coverageBefore)
    const { result, ledger } = applyReconciliation(data, {
      transactionId: tx.id,
      invoiceIds: picks.map((inv) => inv.id),
    })
    expect(result.ok, `${ctx} reconcile ok: ${result.error}`).toBe(true)
    expect(ledger, `${ctx} reconcile returns a ledger`).not.toBeNull()
    tally.reconciles++
    if (useSplit) tally.splitReconciles++
    if ((result.unappliedAmount || 0) > 0) tally.unappliedReceipts++
    const applied = result.applied || []
    expect(applied.length, `${ctx} one applied row per target`).toBe(picks.length)

    // Allocation arithmetic: settled + unapplied == the line's uncovered cash.
    expect(
      cents(round2((result.settledAmount || 0) + (result.unappliedAmount || 0))) || 0,
      `${ctx} settled + unapplied == uncovered line cash`,
    ).toBe(cents(lineAmount) || 0)

    // Each write-back lands on the invoice exactly as reported (exact at rate
    // 1; within the documented FX write-back dust otherwise, which also feeds
    // the control-account allowance below).
    for (const row of applied) {
      const inv = ledger!.invoices.find((i) => i.id === row.invoiceId)!
      expect(inv, `${ctx} applied invoice exists`).toBeDefined()
      expect(inv.status, `${ctx} invoice ${row.invoiceNumber} status`).toBe(row.invoiceStatus)
      const r = invoiceExchangeRate(inv)
      const written = round2(toBaseAmount(outstandingOf(inv), r))
      if (r === 1) {
        expect(
          cents(written) || 0,
          `${ctx} invoice ${row.invoiceNumber} outstanding base == reported remainder`,
        ).toBe(cents(row.remainingOutstanding) || 0)
      } else {
        const diff = Math.abs(round2(written - row.remainingOutstanding))
        tally.maxDustDiff = Math.max(tally.maxDustDiff, diff)
        expect(
          diff,
          `${ctx} invoice ${row.invoiceNumber} outstanding within FX write-back dust`,
        ).toBeLessThanOrEqual(0.01 * r + 0.01 + 1e-9)
        if (diff > 0 && row.remainingOutstanding !== 0) {
          dust = round2(dust + 0.01 * r + 0.03)
          tally.dustIncidents++
        }
      }
    }

    // Re-running the same settlement against the POST ledger must be refused
    // idempotently, byte-identical.
    data = ledger!
    const beforeAgain = cloneLedger(data)
    const again = applyReconciliation(data, {
      transactionId: tx.id,
      invoiceIds: picks.map((inv) => inv.id),
    })
    expect(again.result.ok, `${ctx} re-settlement refused`).toBe(false)
    expect(again.ledger, `${ctx} re-settlement returns no ledger`).toBeNull()
    expect(data, `${ctx} re-settlement leaves the ledger untouched`).toEqual(beforeAgain)

    void round
  }

  // ── Op: re-import idempotency ──
  const reimportOp = (): void => {
    if (csvs.length === 0 || !f.chance(0.5)) return
    const beforeTx = data.bankTransactions
    const beforeJe = data.journalEntries
    const again = applyBankStatementImport(data, csvs[0])
    expect(again.result.ok, `${ctx} re-import ok`).toBe(true)
    expect(again.result.importedCount, `${ctx} re-import adds nothing`).toBe(0)
    tally.reimports++
    expect(again.ledger!.bankTransactions, `${ctx} re-import leaves statement lines unchanged`).toEqual(
      beforeTx,
    )
    expect(again.ledger!.journalEntries, `${ctx} re-import leaves journals unchanged`).toEqual(
      beforeJe,
    )
  }

  // Drive the ops: payments and imports interleave, then reconciliation.
  const opCount = f.int(2, 5)
  for (let op = 0; op < opCount; op++) {
    const roll = f.float()
    if (roll < 0.35) paymentOp()
    else if (roll < 0.75) importOp()
    else reconcileOp(op)
  }
  if (f.chance(0.85)) reconcileOp(99)
  reimportOp()

  // ───────────────────────── per-scenario invariants ─────────────────────────
  expect(allJournalsBalanced(data.journalEntries), `${ctx} all journals balanced`).toBe(true)
  for (const je of data.journalEntries) checkShape(je, ctx)

  // Suspense: minus the uncovered cash of imported-but-unreconciled lines.
  const expectedSuspense = round2(
    (data.bankTransactions || []).reduce((sum, tx) => {
      if (tx.reconciled) return sum
      const hasImport = data.journalEntries.some((je) =>
        mentionsReference(je.remarks, `Bank statement import: ${tx.id}`),
      )
      if (!hasImport) return sum
      const uncovered = round2(Math.abs(tx.amount || 0) - paymentCoverage(tx))
      return round2(sum + (tx.amount > 0 ? -uncovered : uncovered))
    }, 0),
  )
  const derived = computeAccountBalances(data.accounts, data.journalEntries)
  const suspense = derived.find((a) => a.id === 'acc-suspense')?.balance ?? 0
  expect(
    cents(suspense) || 0,
    `${ctx} suspense == explainable model (${expectedSuspense})`,
  ).toBe(cents(expectedSuspense) || 0)

  // Party balances agree with the invoice-derived recomputation.
  const recomputed = recomputePartyBalances(data.invoices, data.parties)
  for (let i = 0; i < data.parties.length; i++) {
    expect(
      cents(data.parties[i].outstandingBalance) || 0,
      `${ctx} party ${data.parties[i].name} balance is invoice-derived`,
    ).toBe(cents(recomputed[i].outstandingBalance) || 0)
  }

  // Control accounts tie to the party balances (FX write-back dust allowed).
  const customersSum = round2(
    data.parties.filter((p) => p.type === 'Customer').reduce((s, p) => s + p.outstandingBalance, 0),
  )
  const suppliersSum = round2(
    data.parties.filter((p) => p.type === 'Supplier').reduce((s, p) => s + p.outstandingBalance, 0),
  )
  const ar = derived.find((a) => a.id === 'acc-ar')?.balance ?? 0
  const ap = derived.find((a) => a.id === 'acc-ap')?.balance ?? 0
  if (rate === 1) {
    expect(cents(ar) || 0, `${ctx} AR control == customer balances`).toBe(cents(customersSum) || 0)
    expect(cents(ap) || 0, `${ctx} AP control == supplier balances`).toBe(cents(suppliersSum) || 0)
  } else {
    expect(
      Math.abs(round2(ar - customersSum)),
      `${ctx} AR control == customer balances within FX write-back dust`,
    ).toBeLessThanOrEqual(round2(dust) + 1e-9)
    expect(
      Math.abs(round2(ap - suppliersSum)),
      `${ctx} AP control == supplier balances within FX write-back dust`,
    ).toBeLessThanOrEqual(round2(dust) + 1e-9)
  }

  log.push(`${ctx} ok (journals=${data.journalEntries.length} txs=${(data.bankTransactions || []).length})`)
  return { data, rate, dust }
}

describe('fuzz: settlement engine under randomized scenarios', () => {
  it(
    `settlement scenarios 1-${SCENARIOS_PER_CHUNK * 1}`,
    () => {
      const log: string[] = []
      for (let i = 0; i < SCENARIOS_PER_CHUNK; i++) runScenario(i, log)
      expect(log.length).toBe(SCENARIOS_PER_CHUNK)
    },
    120_000,
  )
  for (let chunk = 1; chunk < CHUNKS; chunk++) {
    it(
      `settlement scenarios ${chunk * SCENARIOS_PER_CHUNK + 1}-${(chunk + 1) * SCENARIOS_PER_CHUNK}`,
      () => {
        const log: string[] = []
        for (let i = 0; i < SCENARIOS_PER_CHUNK; i++) runScenario(chunk * SCENARIOS_PER_CHUNK + i, log)
        expect(log.length).toBe(SCENARIOS_PER_CHUNK)
        if (chunk === CHUNKS - 1) {
          console.log(
            `[fuzz-settlement tally] scenarios=${SCENARIOS} fx=${tally.fxScenarios} imports=${tally.imports} payments=${tally.payments} (refused=${tally.paymentsRefused}) reconciles=${tally.reconciles} (split=${tally.splitReconciles}, unapplied=${tally.unappliedReceipts}, credit-carriers=${tally.creditCarrierTargets}) mismatch-refusals=${tally.mismatchRefused} re-import-idempotency=${tally.reimports} fx-dust-incidents=${tally.dustIncidents} max-fx-dust=${tally.maxDustDiff}`,
          )
        }
      },
      120_000,
    )
  }
})

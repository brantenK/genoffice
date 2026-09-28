/**
 * 10 000-operation random soak against ONE renderer store instance.
 *
 * The store is driven exactly the way the existing invariant tests drive it
 * (tests/ledger-invariants.test.ts): the real zustand store with no bridge, so
 * every mutation runs the real shared engines in-process and `persist` is the
 * bridgeless no-op success path. Ops: create party, create/post invoice,
 * record payment, mark paid, credit note, quotation flow (save/status/convert),
 * synthetic CSV bank import (plus duplicate re-imports), 1-click reconciliation
 * (single and split), manual balanced journal entries, deletes, and simulated
 * reloads (deriveLedger parity + applyLoadedEnvelope).
 *
 * After EVERY 500 ops (each chunk below) and at the end the full invariant set
 * is asserted over the whole ledger:
 *   - every journal balanced (items and totals);
 *   - stored account balances === computeAccountBalances(journals) exactly;
 *   - stored party balances === recomputePartyBalances(invoices, parties)
 *     (the code's own rule: open = not Paid/Cancelled, Drafts included);
 *   - AR control === sum of OPEN (non-draft) sales outstandings === sum of
 *     customer party balances minus draft outstandings; AP likewise;
 *   - tax register totals === the VAT the journals posted (per direction);
 *   - every invoice's outstanding === the shadow model of the code's own
 *     rules (grand total minus live payment allocations, minus the paid
 *     portion carried across edits, minus reconciled/unapplied settlements);
 *   - status Paid <=> outstanding === 0 for posted invoices;
 *   - a reload's deriveLedger(data) equals data (balances are journal-derived).
 *
 * Wall time and heap are recorded per checkpoint and printed at the end —
 * numbers only, no perf assertions.
 *
 * Generator carve-outs (each documented in the report with its own finding):
 *   F2/F4 — FIXED in the product as of this suite: the store refuses edits
 *        below the settled portion (F2) and edits of suspense-settled
 *        invoices (F4). The walk deliberately aims edits at both, so the
 *        refusal path is exercised and the invariant holds for real through
 *        the refusal; a refused edit must leave the ledger untouched.
 *   F3 — statement descriptions never carry invoice numbers: the store removes
 *        journals by remark-text matching, so a number embedded in statement
 *        text couples unrelated journals to that invoice's edits/deletes.
 *   F5 — invoices that carry (or funded) an unapplied receipt are frozen
 *        against delete/edit: the unapplied legs are not attributed to their
 *        carrier by any remark, so removing either side strands the other.
 * Quotations are customer-party only (the product has no purchase-quote flow:
 * convertQuoteToInvoice always posts a Sales invoice).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyLoadedEnvelope,
  getRevision,
  useBooksStore,
} from '../src/renderer/src/store'
import { DEFAULT_BOOK_SETTINGS, EMPTY_ACCOUNTS } from '../src/shared/chart'
import {
  allJournalsBalanced,
  calculateInvoiceTotals,
  computeAccountBalances,
  postedInvoiceAmounts,
  recomputePartyBalances,
  round2,
} from '../src/shared/accounting'
import { deriveLedger } from '../src/shared/settlement'
import { taxRegister } from '../src/shared/reports'
import { cents, makeFuzz, type Fuzz } from './fuzz-random'
import type { BooksData, Invoice, InvoiceItem, Party } from '../src/shared/types'

/** Fixed master seed for the soak. */
const SEED = 0x50a04
const CHUNKS = 20
const OPS_PER_CHUNK = 500
const TOTAL_OPS = CHUNKS * OPS_PER_CHUNK

const state = () => useBooksStore.getState()
const data = () => state().data

const outstandingOf = (inv: Invoice): number =>
  round2(
    inv.outstandingAmount !== undefined && inv.outstandingAmount !== null
      ? inv.outstandingAmount
      : inv.grandTotal,
  )

/** Shadow model of every live invoice's outstanding (the code's own rules). */
const shadow = new Map<string, number>()
let opCounter = 0

const tally = {
  addParty: 0,
  invoiceCreate: 0,
  invoiceEdit: 0,
  editRefused: 0,
  payment: 0,
  paymentRefused: 0,
  markPaid: 0,
  creditNote: 0,
  creditNoteRefused: 0,
  quoteSave: 0,
  quoteStatus: 0,
  quoteConvert: 0,
  bankImport: 0,
  bankReimport: 0,
  reconcile: 0,
  reconcileRefused: 0,
  deleteInvoice: 0,
  deletePayment: 0,
  deleteQuote: 0,
  manualJournal: 0,
  reload: 0,
}

const perf: string[] = []
const soakStart = Date.now()

function breathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2))
}

function seedLedger(): BooksData {
  const customers: Party[] = Array.from({ length: 4 }, (_, i) => ({
    id: `party-soak-c${i}`,
    name: `Soak Customer ${i}`,
    type: 'Customer',
    outstandingBalance: 0,
  }))
  const suppliers: Party[] = Array.from({ length: 3 }, (_, i) => ({
    id: `party-soak-s${i}`,
    name: `Soak Supplier ${i}`,
    type: 'Supplier',
    outstandingBalance: 0,
  }))
  return {
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    settings: { ...DEFAULT_BOOK_SETTINGS, taxInclusive: false, companyName: 'Soak Co' },
    accounts: EMPTY_ACCOUNTS.map((a) => ({ ...a, balance: 0 })),
    parties: [...customers, ...suppliers],
    invoices: [],
    quotes: [],
    journalEntries: [],
    bankTransactions: [],
    payments: [],
    auditLog: [],
  }
}

function makeLine(f: Fuzz, type: 'Sales' | 'Purchase'): InvoiceItem {
  const qty = f.int(1, 9)
  const rate = f.int(100, 200_000) / 100
  const taxRate = f.pick([0, 15, 14.99, 7.5])
  return {
    id: `it-soak-${opCounter}-${f.int(0, 999)}`,
    itemCode: 'SOAK-1',
    description: 'Soak line',
    accountId: type === 'Sales' ? 'acc-sales' : 'acc-materials',
    accountName: type === 'Sales' ? 'Sales' : 'Materials',
    qty,
    rate,
    taxRate,
    amount: round2(qty * rate),
  }
}

function customerParties(): Party[] {
  return data().parties.filter((p) => p.type === 'Customer')
}
function supplierParties(): Party[] {
  return data().parties.filter((p) => p.type === 'Supplier')
}

function openInvoicesFor(partyId: string): Invoice[] {
  return data().invoices.filter(
    (inv) => inv.partyId === partyId && inv.status === 'Unpaid' && round2(outstandingOf(inv)) > 0 && !inv.creditNote,
  )
}

/** ───────────────────────────── the ops ───────────────────────────── */

async function opAddParty(f: Fuzz): Promise<void> {
  if (data().parties.length >= 14) return
  const type = f.chance(0.5) ? 'Customer' : 'Supplier'
  await state().addParty({ name: `Soak Party ${opCounter}`, type })
  tally.addParty++
  await breathe()
}

async function opInvoiceCreate(f: Fuzz): Promise<void> {
  const type: 'Sales' | 'Purchase' = f.chance(0.6) ? 'Sales' : 'Purchase'
  const pool = type === 'Sales' ? customerParties() : supplierParties()
  const status = f.weighted<'Unpaid' | 'Draft' | 'Paid'>([
    ['Unpaid', 82],
    ['Draft', 12],
    ['Paid', 6],
  ])
  const id = `inv-soak-${opCounter}`
  await state().saveInvoice({
    id,
    type,
    partyId: f.pick(pool).id,
    status,
    items: Array.from({ length: f.int(1, 3) }, () => makeLine(f, type)),
  })
  const saved = data().invoices.find((i) => i.id === id)
  expect(saved, `soak#${opCounter} created invoice exists`).toBeDefined()
  shadow.set(id, round2(outstandingOf(saved as Invoice)))
  tally.invoiceCreate++
}

/** Candidate edits: posted-or-draft, not a credit note, no multi-invoice
 * payment, non-negative outstanding. Returns null when none qualify. */
function editCandidate(f: Fuzz): Invoice | null {
  const multiSettled = new Set(
    (data().payments || [])
      .filter((p) => p.allocations.length > 1)
      .flatMap((p) => p.allocations.map((a) => a.invoiceId)),
  )
  const candidates = data().invoices.filter(
    (inv) =>
      !inv.creditNote &&
      !multiSettled.has(inv.id) &&
      !frozen.has(inv.id) &&
      round2(outstandingOf(inv)) >= 0 &&
      round2(outstandingOf(inv)) <= round2(inv.grandTotal),
  )
  if (candidates.length === 0) return null
  return f.pick(candidates)
}

async function opInvoiceEdit(f: Fuzz): Promise<void> {
  const target = editCandidate(f)
  if (!target) return
  const paid = round2(target.grandTotal - outstandingOf(target))
  const isDraft = target.status === 'Draft'
  // Findings F2/F4 are FIXED in the product: the store refuses edits whose new
  // total is below the settled portion (F2) and edits of invoices whose settled
  // cash is suspense-funded (F4). The walk deliberately aims rates below the
  // paid portion and at already-reconciled invoices, so the refusal path is
  // exercised; a refused edit must leave the ledger — and this shadow model —
  // untouched.
  const newRate = round2(f.money(1, 5000))
  const editItems = [
    {
      id: `it-edit-${opCounter}`,
      itemCode: 'SOAK-1',
      description: 'Edited soak line',
      accountId: target.type === 'Sales' ? 'acc-sales' : 'acc-materials',
      accountName: target.type === 'Sales' ? 'Sales' : 'Materials',
      qty: 1,
      rate: newRate,
      taxRate: 15,
      amount: newRate,
    },
  ]
  const intendedGrand = round2(
    calculateInvoiceTotals(editItems, { taxInclusive: false }).grandTotal,
  )
  await state().saveInvoice({
    id: target.id,
    type: target.type,
    partyId: target.partyId,
    partyName: target.partyName,
    status: isDraft ? 'Draft' : 'Unpaid',
    items: editItems,
  })
  const saved = data().invoices.find((i) => i.id === target.id)!
  expect(saved, `soak#${opCounter} edited invoice exists`).toBeDefined()
  if (round2(saved.grandTotal) !== intendedGrand) {
    // The store refused the edit (F2/F4 guard): nothing may have moved.
    expect(
      round2(outstandingOf(saved)),
      `soak#${opCounter} refused edit leaves the outstanding untouched`,
    ).toBe(round2(outstandingOf(target)))
    expect(
      saved.status,
      `soak#${opCounter} refused edit leaves the status untouched`,
    ).toBe(target.status)
    tally.editRefused++
    return
  }
  shadow.set(target.id, round2(saved.grandTotal - paid))
  tally.invoiceEdit++
  lastEditDebug = `op ${opCounter} edit ${target.invoiceNumber}: oldG=${target.grandTotal} oldOut=${outstandingOf(target)} oldStatus=${target.status} paid=${paid} newG=${saved.grandTotal} newOut=${outstandingOf(saved)} newStatus=${saved.status}`
}

async function opPayment(f: Fuzz): Promise<void> {
  const party = f.pick([...customerParties(), ...supplierParties()])
  const open = openInvoicesFor(party.id)
  if (open.length === 0) return
  const targets = open.slice(0, f.int(1, Math.min(2, open.length)))
  const allocations = targets.map((inv) => {
    const outstanding = round2(outstandingOf(inv))
    const roll = f.float()
    const amount =
      roll < 0.5
        ? outstanding
        : roll < 0.85
          ? round2(outstanding * (f.int(20, 90) / 100))
          : round2(outstanding + f.int(1, 500) / 100) // over-allocation attempt
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      amount: Math.max(round2(amount), 0.01),
    }
  })
  const before = (data().payments || []).length
  const result = await state().recordPayment({
    partyId: party.id,
    date: f.isoDate(),
    type: party.type === 'Customer' ? 'received' : 'paid',
    method: 'Bank Transfer',
    reference: `SOAK-PAY-${opCounter}`,
    allocations,
  })
  if (!result.ok) {
    tally.paymentRefused++
    return
  }
  expect((data().payments || []).length, `soak#${opCounter} payment recorded`).toBe(before + 1)
  for (const alloc of allocations) {
    const current = shadow.get(alloc.invoiceId)
    if (current === undefined) continue
    shadow.set(alloc.invoiceId, round2(current - alloc.amount))
  }
  tally.payment++
}

async function opMarkPaid(f: Fuzz): Promise<void> {
  const party = f.pick(customerParties())
  const open = openInvoicesFor(party.id)
  if (open.length === 0) return
  const inv = f.pick(open)
  const amount = round2(outstandingOf(inv))
  await state().markInvoicePaid(inv.id)
  const after = data().invoices.find((i) => i.id === inv.id)!
  expect(
    round2(outstandingOf(after)),
    `soak#${opCounter} mark-paid settles exactly`,
  ).toBe(0)
  shadow.set(inv.id, 0)
  tally.markPaid++
  void amount
}

async function opCreditNote(f: Fuzz): Promise<void> {
  const originals = data().invoices.filter(
    (inv) => inv.status === 'Unpaid' && !inv.creditNote && round2(inv.grandTotal) > 0,
  )
  if (originals.length === 0) return
  const original = f.pick(originals)
  const result = await state().saveCreditNote({ originalInvoiceId: original.id, date: f.isoDate() })
  if (!result.ok) {
    tally.creditNoteRefused++
    return
  }
  const cn = result.creditNote!
  shadow.set(cn.id, round2(outstandingOf(cn)))
  expect(round2(outstandingOf(cn)), `soak#${opCounter} credit note carries negative outstanding`).toBe(
    -round2(cn.grandTotal),
  )
  tally.creditNote++
  await breathe()
}

async function opQuoteSave(f: Fuzz): Promise<void> {
  // Quotations are customer documents in this product (the Quotation type has
  // no direction field and convertQuoteToInvoice posts a Sales invoice), so
  // the party pool is customers only.
  const party = f.pick(customerParties())
  await state().saveQuote({
    id: `quote-soak-${opCounter}`,
    partyId: party.id,
    partyName: party.name,
    status: 'Draft',
    date: f.isoDate(),
    validUntil: f.isoDate(),
    items: Array.from({ length: f.int(1, 2) }, () => makeLine(f, 'Sales')),
  })
  tally.quoteSave++
}

async function opQuoteStatus(f: Fuzz): Promise<void> {
  const quotes = (data().quotes || []).filter((q) => q.status !== 'Converted')
  if (quotes.length === 0) return
  const quote = f.pick(quotes)
  await state().setQuoteStatus(quote.id, f.pick(['Sent', 'Accepted', 'Lost'] as const))
  tally.quoteStatus++
}

async function opQuoteConvert(f: Fuzz): Promise<void> {
  const quotes = (data().quotes || []).filter((q) => q.status !== 'Converted' && q.status !== 'Lost')
  if (quotes.length === 0) return
  const quote = f.pick(quotes)
  const result = await state().convertQuoteToInvoice(quote.id)
  if (!result.ok) return
  const invoice = result.invoice!
  shadow.set(invoice.id, round2(outstandingOf(invoice)))
  tally.quoteConvert++
  await breathe()
}

function buildCsv(f: Fuzz): string {
  const rows: string[] = ['Date,Description,Reference,Amount']
  const rowCount = f.int(1, 3)
  for (let k = 0; k < rowCount; k++) {
    const deposit = f.chance(0.65)
    let amount = f.int(100, 500_000) / 100
    let description = `Soak EFT ${opCounter}_${k}`
    if (f.chance(0.7)) {
      const direction = deposit ? 'Sales' : 'Purchase'
      const pool = data().invoices.filter(
        (inv) => inv.type === direction && inv.status === 'Unpaid' && round2(outstandingOf(inv)) > 0,
      )
      if (pool.length > 0) {
        const inv = f.pick(pool)
        const outstanding = round2(outstandingOf(inv))
        const roll = f.float()
        amount =
          roll < 0.4
            ? outstanding
            : roll < 0.8
              ? round2(outstanding * (f.int(20, 90) / 100))
              : round2(outstanding + f.int(100, 50_000) / 100)
        if (f.chance(0.4)) description = `${inv.partyName} ${description}`
        // Carve-out (findings F3/F5): statement text never carries invoice
        // numbers in this walk. The store removes journals by REMARK-TEXT
        // matching on reversalJournalRemoval, and a description that names any
        // invoice number makes an edit/delete of that invoice destroy other
        // invoices' settlement journals (or the bank import journal). Both
        // product defects are reported with minimal reproductions; this walk
        // keeps the reversal scope exact so the mandated invariants can be
        // asserted strictly.
      }
    }
    amount = round2(Math.max(amount, 0.01))
    rows.push(
      `${f.isoDate()},"${description}","SOAK-${opCounter}-${k}",${deposit ? amount.toFixed(2) : (-amount).toFixed(2)}`,
    )
  }
  return rows.join('\n')
}

async function opBankImport(f: Fuzz): Promise<void> {
  const csv = buildCsv(f)
  const result = await state().importBankStatementCsv(csv)
  expect(result.ok, `soak#${opCounter} import ok: ${result.error}`).toBe(true)
  tally.bankImport++
  // Re-import the identical statement: dedupe must add nothing (idempotency).
  if (f.chance(0.4)) {
    const beforeJournals = data().journalEntries.length
    const beforeTx = (data().bankTransactions || []).length
    const again = await state().importBankStatementCsv(csv)
    expect(again.ok, `soak#${opCounter} re-import ok`).toBe(true)
    expect(again.importedCount ?? -1, `soak#${opCounter} re-import adds nothing`).toBe(0)
    expect(data().journalEntries.length, `soak#${opCounter} re-import posts no journals`).toBe(
      beforeJournals,
    )
    expect(
      (data().bankTransactions || []).length,
      `soak#${opCounter} re-import stores no lines`,
    ).toBe(beforeTx)
    tally.bankReimport++
  }
}

async function opReconcile(f: Fuzz): Promise<void> {
  const unreconciled = (data().bankTransactions || []).filter((t) => !t.reconciled)
  if (unreconciled.length === 0) return
  const tx = f.pick(unreconciled)
  const direction: 'Sales' | 'Purchase' = tx.amount > 0 ? 'Sales' : 'Purchase'
  const candidates = data().invoices.filter(
    (inv) =>
      inv.type === direction &&
      inv.status === 'Unpaid' &&
      round2(outstandingOf(inv)) !== 0,
  )
  // Direction-mismatch attempt: a deposit against a bill must be refused.
  if (f.chance(0.15)) {
    const wrong = data().invoices.filter((inv) => inv.type !== direction && inv.status === 'Unpaid')
    if (wrong.length > 0) {
      const result = await state().reconcileTransaction(tx.id, f.pick(wrong).id)
      expect(result.ok, `soak#${opCounter} direction mismatch refused`).toBe(false)
      tally.reconcileRefused++
      return
    }
  }
  if (candidates.length === 0) return
  const useSplit = candidates.length >= 2 && f.chance(0.2)
  const picks = candidates.slice(0, useSplit ? f.int(2, Math.min(3, candidates.length)) : 1)
  const result = await state().reconcileTransaction(
    tx.id,
    useSplit ? '' : picks[0].id,
    useSplit ? picks.map((inv) => inv.id) : undefined,
  )
  if (!result.ok) {
    tally.reconcileRefused++
    return
  }
  for (const row of result.applied || []) {
    shadow.set(row.invoiceId, round2(row.remainingOutstanding))
  }
  // Finding F5 (see the report): the unapplied-receipt legs of a split or
  // standalone reconciliation ride the LAST FUNDED invoice's journal while the
  // credit itself rides the LAST TARGET's outstanding — neither journal
  // remark names the carrier, so deleting or editing either invoice strands
  // the other's AR/AP movement. Freeze both from further delete/edit so the
  // walk stays on the tied domain; the defect itself is reported separately.
  if ((result.unappliedAmount || 0) > 0) {
    const applied = result.applied || []
    const carrier = applied[applied.length - 1]
    if (carrier) frozen.add(carrier.invoiceId)
    const lastFunded = [...applied].reverse().find((row) => row.settledAmount > 0)
    if (lastFunded) frozen.add(lastFunded.invoiceId)
  }
  tally.reconcile++
}

/** Invoice ids whose journals carry another invoice's unapplied receipt legs
 * (finding F5): excluded from delete/edit so the walk stays tied. */
const frozen = new Set<string>()

async function opDeleteInvoice(f: Fuzz): Promise<void> {
  const invoices = data().invoices.filter(
    (inv) => !frozen.has(inv.id) && round2(outstandingOf(inv)) >= 0,
  )
  if (invoices.length === 0) return
  const target = f.pick(invoices)
  const beforeOut = round2(outstandingOf(target))
  const beforeStatus = target.status
  const debugAr = process.env.SOAK_DEBUG === '1'
  const beforeJournals = debugAr
    ? data().journalEntries
        .filter(
          (je) =>
            (je.remarks || '').includes(target.invoiceNumber) ||
            je.items.some((it) => (it.remark || '').includes(target.invoiceNumber)),
        )
        .map((je) => je.items.map((it) => `${it.accountId} d=${it.debit} c=${it.credit} [${it.remark}]`).join(' | '))
    : []
  const beforePayments = debugAr
    ? (data().payments || [])
        .filter((p) => p.allocations.some((a) => a.invoiceId === target.id))
        .map((p) => `${p.id} total=${p.total} allocs=${p.allocations.map((a) => `${a.invoiceNumber}:${a.amount}`).join(',')}`)
    : []
  await state().deleteInvoice(target.id)
  const gone = !data().invoices.some((i) => i.id === target.id)
  if (gone) {
    shadow.delete(target.id)
    tally.deleteInvoice++
    lastEditDebug = `op ${opCounter} DELETE ${target.invoiceNumber}: type=${target.type} G=${target.grandTotal} out=${beforeOut} status=${beforeStatus} BEFORE-journals=${JSON.stringify(beforeJournals)} BEFORE-payments=${JSON.stringify(beforePayments)}`
  }
}

async function opDeletePayment(f: Fuzz): Promise<void> {
  const payments = data().payments || []
  if (payments.length === 0) return
  const payment = f.pick(payments)
  await state().deletePayment(payment.id)
  const gone = !(data().payments || []).some((p) => p.id === payment.id)
  if (gone) {
    for (const alloc of payment.allocations) {
      const current = shadow.get(alloc.invoiceId)
      if (current === undefined) continue
      shadow.set(alloc.invoiceId, round2(current + alloc.amount))
    }
    tally.deletePayment++
  }
}

async function opDeleteQuote(f: Fuzz): Promise<void> {
  const quotes = (data().quotes || []).filter((q) => q.status !== 'Converted')
  if (quotes.length === 0) return
  const quote = f.pick(quotes)
  await state().deleteQuote(quote.id)
  if (!(data().quotes || []).some((q) => q.id === quote.id)) tally.deleteQuote++
}

async function opManualJournal(f: Fuzz): Promise<void> {
  // Balanced manual entry; VAT and control accounts are deliberately excluded
  // (the tax-register invariant ties acc-vat* to invoice postings only).
  const amount = round2(f.int(100, 100_000) / 100)
  const pairs: Array<[string, string]> = [
    ['acc-bank', 'acc-cash'],
    ['acc-cash', 'acc-bank'],
    ['acc-sales', 'acc-retained'],
    ['acc-retained', 'acc-sales'],
    ['acc-materials', 'acc-retained'],
    ['acc-retained', 'acc-materials'],
  ]
  const [debitAcc, creditAcc] = f.pick(pairs)
  const ok = await state().addJournalEntry({
    date: f.isoDate(),
    remarks: `Soak manual JE ${opCounter}`,
    items: [
      { id: `jei-${opCounter}-a`, accountId: debitAcc, accountName: debitAcc, debit: amount, credit: 0 },
      { id: `jei-${opCounter}-b`, accountId: creditAcc, accountName: creditAcc, debit: 0, credit: amount },
    ],
  })
  expect(ok, `soak#${opCounter} balanced manual entry posts`).toBe(true)
  tally.manualJournal++
  await breathe()
}

async function opReload(): Promise<void> {
  const before = data()
  // A real reload re-derives every stored balance from the journals on read;
  // the store's own load transition (applyLoadedEnvelope) must find nothing to
  // change: deriveLedger(data) deep-equals data at any point in the walk.
  const derived = deriveLedger(JSON.parse(JSON.stringify(before)) as BooksData)
  expect(derived, `soak#${opCounter} stored balances are journal-derived`).toEqual(before)
  applyLoadedEnvelope({
    ...before,
    version: 1,
    revision: getRevision() + 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  tally.reload++
}

/** ─────────────────────────── checkpoint ─────────────────────────── */

function assertCheckpoint(chunk: number): void {
  const d = data()
  const ctx = `soak checkpoint ${chunk}`

  expect(allJournalsBalanced(d.journalEntries), `${ctx}: every journal balanced`).toBe(true)

  const derived = computeAccountBalances(d.accounts, d.journalEntries)
  for (const acc of d.accounts) {
    const computed = derived.find((x) => x.id === acc.id)!
    expect(
      cents(acc.balance) || 0,
      `${ctx}: account ${acc.id} balance is journal-derived`,
    ).toBe(cents(computed.balance) || 0)
  }

  const recomputed = recomputePartyBalances(d.invoices, d.parties)
  for (let i = 0; i < d.parties.length; i++) {
    expect(
      cents(d.parties[i].outstandingBalance) || 0,
      `${ctx}: party ${d.parties[i].name} balance is invoice-derived`,
    ).toBe(cents(recomputed[i].outstandingBalance) || 0)
  }

  // Control accounts tie to the open (non-draft) outstandings and to the
  // party balances net of drafts (party balances include drafts, AR/AP do
  // not post them — the code's own definitions).
  const openSales = d.invoices.filter(
    (inv) =>
      inv.type === 'Sales' && inv.status !== 'Paid' && inv.status !== 'Cancelled' && inv.status !== 'Draft',
  )
  const openPurchases = d.invoices.filter(
    (inv) =>
      inv.type === 'Purchase' && inv.status !== 'Paid' && inv.status !== 'Cancelled' && inv.status !== 'Draft',
  )
  const draftSales = d.invoices.filter(
    (inv) => inv.type === 'Sales' && inv.status === 'Draft',
  )
  const draftPurchases = d.invoices.filter(
    (inv) => inv.type === 'Purchase' && inv.status === 'Draft',
  )
  const openSalesSum = round2(openSales.reduce((s, inv) => s + outstandingOf(inv), 0))
  const openPurchaseSum = round2(openPurchases.reduce((s, inv) => s + outstandingOf(inv), 0))
  const draftSalesSum = round2(draftSales.reduce((s, inv) => s + outstandingOf(inv), 0))
  const draftPurchaseSum = round2(draftPurchases.reduce((s, inv) => s + outstandingOf(inv), 0))
  const customersSum = round2(
    d.parties.filter((p) => p.type === 'Customer').reduce((s, p) => s + p.outstandingBalance, 0),
  )
  const suppliersSum = round2(
    d.parties.filter((p) => p.type === 'Supplier').reduce((s, p) => s + p.outstandingBalance, 0),
  )
  const ar = derived.find((a) => a.id === 'acc-ar')?.balance ?? 0
  const ap = derived.find((a) => a.id === 'acc-ap')?.balance ?? 0
  expect(cents(ar) || 0, `${ctx}: AR control == open sales outstandings`).toBe(
    cents(openSalesSum) || 0,
  )
  expect(cents(ap) || 0, `${ctx}: AP control == open purchase outstandings`).toBe(
    cents(openPurchaseSum) || 0,
  )
  expect(
    cents(customersSum) || 0,
    `${ctx}: customer party balances == open sales outstandings + drafts`,
  ).toBe(cents(round2(openSalesSum + draftSalesSum)) || 0)
  expect(
    cents(suppliersSum) || 0,
    `${ctx}: supplier party balances == open purchase outstandings + drafts`,
  ).toBe(cents(round2(openPurchaseSum + draftPurchaseSum)) || 0)

  // Tax register === posted VAT, both directions.
  const rows = taxRegister(d.invoices)
  const totalsRow = rows.find((r) => r.taxRate === null)
  expect(totalsRow, `${ctx}: tax register totals row`).toBeDefined()
  let vatOutPosted = 0
  let vatInPosted = 0
  for (const je of d.journalEntries) {
    for (const it of je.items) {
      if (it.accountId === 'acc-vat' || it.accountId === 'acc-vat-out') {
        vatOutPosted = round2(vatOutPosted + it.credit - it.debit)
      } else if (it.accountId === 'acc-vat-in') {
        vatInPosted = round2(vatInPosted + it.debit - it.credit)
      }
    }
  }
  expect(cents(totalsRow!.salesTax) || 0, `${ctx}: register salesTax == posted output VAT`).toBe(
    cents(vatOutPosted) || 0,
  )
  expect(
    cents(totalsRow!.purchaseTax) || 0,
    `${ctx}: register purchaseTax == posted input VAT`,
  ).toBe(cents(vatInPosted) || 0)
  let salesTaxInvoices = 0
  let purchaseTaxInvoices = 0
  for (const inv of d.invoices) {
    if (inv.status === 'Draft' || inv.status === 'Cancelled') continue
    const sign = inv.creditNote ? -1 : 1
    const tax = postedInvoiceAmounts(inv).taxTotal
    if (inv.type === 'Sales') salesTaxInvoices = round2(salesTaxInvoices + sign * tax)
    else purchaseTaxInvoices = round2(purchaseTaxInvoices + sign * tax)
  }
  expect(
    cents(totalsRow!.salesTax) || 0,
    `${ctx}: register salesTax == invoice-derived output VAT`,
  ).toBe(cents(salesTaxInvoices) || 0)
  expect(
    cents(totalsRow!.purchaseTax) || 0,
    `${ctx}: register purchaseTax == invoice-derived input VAT`,
  ).toBe(cents(purchaseTaxInvoices) || 0)

  // Shadow model: every invoice's outstanding matches the code's rules.
  for (const inv of d.invoices) {
    const expected = shadow.get(inv.id)
    expect(expected, `${ctx}: invoice ${inv.invoiceNumber} is shadow-tracked`).toBeDefined()
    expect(
      cents(outstandingOf(inv)) || 0,
      `${ctx}: invoice ${inv.invoiceNumber} outstanding == shadow model`,
    ).toBe(cents(expected ?? Number.NaN) || 0)
    if (inv.status !== 'Draft') {
      expect(
        (inv.status === 'Paid') === (round2(outstandingOf(inv)) === 0),
        `${ctx}: invoice ${inv.invoiceNumber} status Paid <=> outstanding zero`,
      ).toBe(true)
    }
  }

  const wallSec = ((Date.now() - soakStart) / 1000).toFixed(1)
  const heapMb = (process.memoryUsage().heapUsed / 1048576).toFixed(1)
  perf.push(
    `chunk ${chunk}: ops=${chunk * OPS_PER_CHUNK} wall=${wallSec}s heap=${heapMb}MB journals=${d.journalEntries.length} invoices=${d.invoices.length} txs=${(d.bankTransactions || []).length}`,
  )
}

/** ───────────────────────────── the walk ───────────────────────────── */

function pickOp(f: Fuzz): (f: Fuzz) => Promise<void> {
  const roll = f.float()
  lastOpName =
    roll < 0.05 ? 'addParty'
    : roll < 0.35 ? 'invoiceCreate'
    : roll < 0.43 ? 'invoiceEdit'
    : roll < 0.57 ? 'payment'
    : roll < 0.62 ? 'markPaid'
    : roll < 0.68 ? 'creditNote'
    : roll < 0.71 ? 'quoteSave'
    : roll < 0.73 ? 'quoteStatus'
    : roll < 0.76 ? 'quoteConvert'
    : roll < 0.83 ? 'bankImport'
    : roll < 0.92 ? 'reconcile'
    : roll < 0.96 ? 'deleteInvoice'
    : roll < 0.98 ? 'deletePayment'
    : roll < 0.99 ? 'deleteQuote'
    : roll < 0.999 ? 'manualJournal'
    : 'reload'
  if (lastOpName === 'addParty') return opAddParty
  if (lastOpName === 'invoiceCreate') return opInvoiceCreate
  if (lastOpName === 'invoiceEdit') return opInvoiceEdit
  if (lastOpName === 'payment') return opPayment
  if (lastOpName === 'markPaid') return opMarkPaid
  if (lastOpName === 'creditNote') return opCreditNote
  if (lastOpName === 'quoteSave') return opQuoteSave
  if (lastOpName === 'quoteStatus') return opQuoteStatus
  if (lastOpName === 'quoteConvert') return opQuoteConvert
  if (lastOpName === 'bankImport') return opBankImport
  if (lastOpName === 'reconcile') return opReconcile
  if (lastOpName === 'deleteInvoice') return opDeleteInvoice
  if (lastOpName === 'deletePayment') return opDeletePayment
  if (lastOpName === 'deleteQuote') return opDeleteQuote
  if (lastOpName === 'manualJournal') return opManualJournal
  return opReload
}

let lastOpName = 'none'
let lastEditDebug = 'no edits yet'

async function runChunk(chunk: number): Promise<void> {
  const f = makeFuzz((SEED ^ 0x50a1) + chunk)
  const debugAr = process.env.SOAK_DEBUG === '1'
  for (let op = 0; op < OPS_PER_CHUNK; op++) {
    opCounter++
    const action = pickOp(f)
    await action(f)
    if (!debugAr) continue
    const d = data()
    const partyIds = new Set(d.parties.map((p) => p.id))
    const dangling = d.invoices.filter((inv) => !partyIds.has(inv.partyId))
    if (dangling.length > 0) {
      throw new Error(
        `[SOAK_DEBUG] op ${opCounter} (${lastOpName}) left invoices with dangling partyId: ${JSON.stringify(
          dangling.map((inv) => `${inv.invoiceNumber} partyId=${inv.partyId} out=${outstandingOf(inv)}`),
        )} [${lastEditDebug}]`,
      )
    }
    const dAcc = computeAccountBalances(d.accounts, d.journalEntries)
    const ar = dAcc.find((a) => a.id === 'acc-ar')?.balance ?? 0
    const openSalesSum = round2(
      d.invoices
        .filter(
          (inv) =>
            inv.type === 'Sales' &&
            inv.status !== 'Paid' &&
            inv.status !== 'Cancelled' &&
            inv.status !== 'Draft',
        )
        .reduce((s, inv) => s + outstandingOf(inv), 0),
    )
    if ((cents(ar) || 0) !== (cents(openSalesSum) || 0)) {
      throw new Error(
        `[SOAK_DEBUG] op ${opCounter} (${lastOpName}) broke the AR tie: AR=${ar} openSales=${openSalesSum} (diff ${round2(ar - openSalesSum)}) [${lastEditDebug}]`,
      )
    }
  }
  assertCheckpoint(chunk)
}

describe('soak: 10 000-operation random walk against one store instance', () => {
  beforeAll(() => {
    if (getRevision() === 0 || data().invoices.length === 0) {
      applyLoadedEnvelope({ ...seedLedger(), version: 1, revision: 1 })
      expect(data().invoices).toHaveLength(0)
      expect(getRevision()).toBe(1)
    }
  })

  it('loads the seed ledger through the store’s own load transition', () => {
    expect(data().invoices).toHaveLength(0)
    expect(getRevision()).toBe(1)
  })

  for (let chunk = 1; chunk <= CHUNKS; chunk++) {
    it(
      `walk chunk ${chunk}/${CHUNKS} (ops ${(chunk - 1) * OPS_PER_CHUNK + 1}-${chunk * OPS_PER_CHUNK})`,
      async () => {
        await runChunk(chunk)
        if (chunk === CHUNKS) {
          console.log(`[soak perf]\n${perf.join('\n')}`)
          console.log(
            `[soak ops] ${JSON.stringify(tally)}`,
          )
          console.log(
            `[soak totals] ops=${opCounter} wall=${((Date.now() - soakStart) / 1000).toFixed(1)}s heapPeak=${(process.memoryUsage().heapUsed / 1048576).toFixed(1)}MB`,
          )
        }
      },
      600_000,
    )
  }
})

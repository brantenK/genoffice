/**
 * apps/books/src/shared/settlement.ts
 *
 * THE settlement engine: bank-statement CSV import, settlement suggestions
 * and 1-click reconciliation. Pure and dependency-free (no node/electron
 * imports) so the Electron main process and the renderer bundle import the
 * very same implementation — they can never disagree about which invoices a
 * bank line settles.
 *
 * The engines never mutate their input: each returns a derived copy of the
 * ledger for the caller to persist (books-core) or to apply to its state
 * (the renderer store).
 */

import {
  round2,
  parseBankStatementCsv,
  deduplicateBankTransactions,
  nextJournalNumber,
  createBankImportJournal,
  createReconciliationJournal,
  createSettlementJournal,
  computeAccountBalances,
  recomputePartyBalances,
  invoiceExchangeRate,
  toBaseAmount,
  fromBaseAmount,
} from './accounting'
import { appendAudit, createAuditEntry } from './audit'
import { paymentCoverage, planImportCoverage } from './payments'
import type {
  BankTransaction,
  BooksData,
  Invoice,
  Party,
  JournalEntry,
  JournalEntryItem,
  SettlementSuggestion,
} from './types'

/**
 * Ledger-first derivation: a copy of the ledger whose account balances come
 * strictly from the journal entries and whose party balances come from the
 * open invoices. books-core's recomputeLedger delegates here so the main and
 * renderer paths always derive identical balances.
 */
export function deriveLedger(data: BooksData): BooksData {
  const journalEntries = Array.isArray(data.journalEntries) ? [...data.journalEntries] : []
  return {
    ...data,
    accounts: computeAccountBalances(
      Array.isArray(data.accounts) ? data.accounts : [],
      journalEntries,
    ),
    parties: recomputePartyBalances(
      Array.isArray(data.invoices) ? data.invoices : [],
      Array.isArray(data.parties) ? data.parties : [],
    ),
    journalEntries,
  }
}

/** Result of one bank-statement import, independent of the transport. */
export interface BankStatementImportResult {
  ok: boolean
  error?: string
  importedCount?: number
  skippedDuplicates?: number
  netAdjustment?: number
  newBankBalance?: number | null
  transactions?: BankTransaction[]
}

export interface ReconciliationCoreResult {
  ok: boolean
  error?: string
  transactionId?: string
  invoiceId?: string
  invoiceNumber?: string
  /**
   * The part of the statement line's cash this reconciliation placed against
   * the invoice. Cash a recorded payment already posted against that invoice is
   * not counted here — it was placed once, by the payment.
   */
  settledAmount?: number
  /** What is still outstanding on the invoice (negative once it is in credit). */
  remainingOutstanding?: number
  invoiceStatus?: string
  partyBalance?: number
  /**
   * The part of the statement line no invoice could absorb (an unapplied
   * receipt on the party's account).
   */
  unappliedAmount?: number
  /**
   * One row per invoice the line was split across, in the caller's order.
   * Present for both the single-invoice path (one row) and a split.
   */
  applied?: Array<{
    invoiceId: string
    invoiceNumber?: string
    settledAmount: number
    remainingOutstanding: number
    invoiceStatus: string
  }>
}

/**
 * An engine result plus the ledger it produced; the ledger is null when the
 * engine rejected the request.
 */
export interface AppliedLedger<T> {
  result: T
  ledger: BooksData | null
}

/**
 * Imports a bank statement CSV into the ledger: dedupes against the stored
 * statement lines, pre-reconciles the lines a recorded payment already
 * covered, posts the import journal for the uncovered remainder of every
 * line, and returns the derived ledger plus the import counters.
 */
export function applyBankStatementImport(
  booksData: BooksData,
  csvContent: string,
): AppliedLedger<BankStatementImportResult> {
  const parsed = parseBankStatementCsv(csvContent)
  if (parsed.length === 0) {
    return {
      result: { ok: false, error: 'No valid transactions found in statement CSV' },
      ledger: null,
    }
  }

  const existing = booksData.bankTransactions || []
  const { toAdd, skippedDuplicates, netAdjustment } = deduplicateBankTransactions(parsed, existing)

  // Phase-3 payment ↔ bank-reconciliation unification: a statement line
  // already covered by a recorded payment is the SAME cash the payment
  // journal booked (Dr/Cr Bank vs AR/AP). Fully covered lines are stored
  // pre-reconciled against the matched allocation invoice and post NO import
  // journal — posting the bank movement again would double-count Bank and
  // strand Suspense. PARTIALLY covered lines post an import journal for the
  // uncovered remainder only, so Bank always matches the statement exactly.
  const coverage = planImportCoverage(booksData, toAdd)
  const storedToAdd: BankTransaction[] = toAdd.map((tx) => {
    const plan = coverage.get(tx.id)
    if (!plan || plan.paymentLinks.length === 0) return tx
    // The links are stored even on a line the payment only PARTLY covered: they
    // are what stops a second statement line (or payment) from consuming the
    // same cash twice, and what tells the settlement engine how much of the
    // line a recorded payment already posted when the line is reconciled later.
    const linked: BankTransaction = { ...tx, paymentLinks: plan.paymentLinks }
    if (!plan.fullyCovered) return linked
    return {
      ...linked,
      reconciled: true,
      matchedInvoiceId: plan.matchedInvoiceId,
      reconciledAt: new Date().toISOString(),
    }
  })

  // Ledger-first: each imported transaction is posted as a journal entry
  // (Dr/Cr Bank against Bank Suspense) for the UNCOVERED portion — a fully
  // covered line posts nothing, a partially covered line posts the remainder,
  // everything else posts in full. Balances are then derived from journals;
  // entry numbers come from the journal sequence so imports never reuse one.
  const journals = Array.isArray(booksData.journalEntries) ? [...booksData.journalEntries] : []
  for (const tx of toAdd) {
    const plan = coverage.get(tx.id)
    const uncovered = round2(Math.abs(tx.amount || 0) - (plan?.coveredAmount || 0))
    if (uncovered <= 0.005) continue
    const remainderTx: BankTransaction = {
      ...tx,
      amount: tx.amount > 0 ? uncovered : -uncovered,
    }
    journals.unshift(
      createBankImportJournal(
        remainderTx,
        booksData.accounts,
        nextJournalNumber(journals, tx.date),
      ),
    )
  }

  const ledger = deriveLedger(
    appendAudit(
      {
        ...booksData,
        bankTransactions: [...existing, ...storedToAdd],
        journalEntries: journals,
        updatedAt: new Date().toISOString(),
      },
      createAuditEntry(
        'bank.import',
        `Imported bank statement: ${toAdd.length} new transaction${toAdd.length === 1 ? '' : 's'} (${skippedDuplicates} duplicates skipped)`,
      ),
    ),
  )

  const bankAccount = ledger.accounts.find((a) => a.id === 'acc-bank')
  return {
    result: {
      ok: true,
      importedCount: toAdd.length,
      skippedDuplicates,
      netAdjustment,
      newBankBalance: bankAccount ? bankAccount.balance : null,
      transactions: storedToAdd,
    },
    ledger,
  }
}

/**
 * Repeats the settlement entry's own crossing for the part of the statement
 * line the invoice could not absorb: the sibling entry built for the receipt
 * amount supplies the leg shape — the same cash-side leg and the same control
 * leg, with the excess booked as an unapplied receipt. Zero legs from either
 * entry are dropped, so when the invoice could absorb nothing (a party credit)
 * the posted entry is the unapplied receipt alone. Booking it in the
 * settlement entry (rather than leaving it in Bank Suspense) matters because
 * the line is marked reconciled — a Suspense balance left behind would never
 * be cleared.
 */
function withUnappliedReceipt(
  journal: JournalEntry,
  unappliedEntry: JournalEntry,
  amount: number,
  remark: string,
): JournalEntry {
  const kept = journal.items.filter((item) => item.debit !== 0 || item.credit !== 0)
  const extra: JournalEntryItem[] = unappliedEntry.items
    .filter((item) => item.debit !== 0 || item.credit !== 0)
    .map((item) => ({
      ...item,
      id: `${item.id}-unapplied`,
      debit: item.debit !== 0 ? amount : 0,
      credit: item.credit !== 0 ? amount : 0,
      remark,
    }))
  const items = [...kept, ...extra]
  return {
    ...journal,
    items,
    totalDebit: round2(items.reduce((sum, item) => sum + item.debit, 0)),
    totalCredit: round2(items.reduce((sum, item) => sum + item.credit, 0)),
  }
}

/**
 * Matches every unreconciled statement line against the open invoices of the
 * matching direction: an exact amount match, a partial payment identified by
 * the invoice number or tender reference found in the transaction text, or —
 * for an invoice already carrying a party credit — the whole uncovered cash as
 * an unapplied receipt, which is the only route that clears the line's
 * Suspense balance.
 */
export function computeSettlementSuggestions(booksData: BooksData): SettlementSuggestion[] {
  const transactions = (booksData.bankTransactions || []).filter((t) => !t.reconciled)
  const openInvoices = (booksData.invoices || []).filter(
    (i) =>
      i.status !== 'Paid' &&
      i.status !== 'Cancelled' &&
      round2(i.outstandingAmount ?? i.grandTotal) !== 0,
  )

  const suggestions: SettlementSuggestion[] = []

  for (const tx of transactions) {
    const isDeposit = tx.amount > 0
    const targetType = isDeposit ? 'Sales' : 'Purchase'
    const targetAmount = round2(Math.abs(tx.amount) - paymentCoverage(tx))

    const candidates = openInvoices.filter((i) => i.type === targetType)

    for (const inv of candidates) {
      // Suggestion amounts are base currency (statement lines and payments
      // are), so the invoice's own outstanding figure is converted at its rate.
      const currentOutstanding = toBaseAmount(
        round2(inv.outstandingAmount !== undefined ? inv.outstandingAmount : inv.grandTotal),
        invoiceExchangeRate(inv),
      )
      const amountMatches = Math.abs(currentOutstanding - targetAmount) < 0.01

      // Check text tokens for match
      const textToSearch = `${tx.description} ${tx.reference || ''}`.toLowerCase()
      const invNoMatch = Boolean(
        inv.invoiceNumber && textToSearch.includes(inv.invoiceNumber.toLowerCase()),
      )
      const tenderMatch = Boolean(
        inv.tenderReference && textToSearch.includes(inv.tenderReference.toLowerCase()),
      )

      // Split party name into significant keywords (length >= 4, ignoring common stop words)
      const stopWords = new Set([
        'city',
        'of',
        'the',
        'and',
        'dept',
        'ltd',
        'pty',
        'inc',
        'corp',
        'co',
      ])
      const partyTokens = (inv.partyName || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !stopWords.has(t))

      const partyMatch =
        Boolean(inv.partyName && textToSearch.includes(inv.partyName.toLowerCase())) ||
        (partyTokens.length > 0 && partyTokens.some((t) => textToSearch.includes(t)))

      if (amountMatches) {
        let confidence: 'HIGH' | 'MEDIUM' = 'MEDIUM'
        let reason = 'Exact amount matches outstanding invoice'

        if (invNoMatch) {
          confidence = 'HIGH'
          reason = `Exact amount match and contains invoice number: ${inv.invoiceNumber}`
        } else if (tenderMatch) {
          confidence = 'HIGH'
          reason = `Exact amount match and contains tender reference: ${inv.tenderReference}`
        } else if (partyMatch) {
          confidence = 'HIGH'
          reason = `Exact amount match and contains counterparty name: ${inv.partyName}`
        }

        suggestions.push({
          transactionId: tx.id,
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          partyName: inv.partyName,
          invoiceType: inv.type,
          amount: targetAmount,
          confidence,
          reason,
        })
      } else if (currentOutstanding < 0 && (invNoMatch || tenderMatch)) {
        // The invoice is already in credit, so it cannot absorb the line: the
        // whole uncovered amount becomes an unapplied receipt on the party's
        // account. Offering the match at all is what lets the user clear this
        // line's Suspense balance from the UI.
        suggestions.push({
          transactionId: tx.id,
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          partyName: inv.partyName,
          invoiceType: inv.type,
          amount: targetAmount,
          confidence: 'MEDIUM',
          reason: `Invoice ${inv.invoiceNumber} is already in credit: this line becomes an unapplied receipt`,
        })
      } else if (targetAmount <= currentOutstanding && (invNoMatch || tenderMatch)) {
        // Partial payment match on invoice number or tender reference
        suggestions.push({
          transactionId: tx.id,
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          partyName: inv.partyName,
          invoiceType: inv.type,
          amount: targetAmount,
          confidence: 'MEDIUM',
          reason: `Partial payment matching invoice ${inv.invoiceNumber}`,
        })
      } else if (
        targetAmount > currentOutstanding &&
        currentOutstanding > 0 &&
        (invNoMatch || tenderMatch)
      ) {
        // The line carries more cash than the invoice needs and names it: the
        // reconciliation engine already books the excess as an unapplied
        // receipt, so the UI must offer the match or the line is stranded as
        // Unmatched with no action a user can take.
        const excess = round2(targetAmount - currentOutstanding)
        suggestions.push({
          transactionId: tx.id,
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          partyName: inv.partyName,
          invoiceType: inv.type,
          amount: targetAmount,
          confidence: 'MEDIUM',
          reason: `Covers invoice ${inv.invoiceNumber}; the extra ${excess} becomes an unapplied receipt`,
        })
      }
    }
  }

  return suggestions
}

/**
 * The pure settlement core of bank-statement reconciliation (no electron).
 * Marks the transaction reconciled, settles the invoice (exact, partial, or
 * over-amount: the excess becomes an unapplied receipt on the party's account,
 * and cash a recorded payment already posted is never booked a second time),
 * posts the reclass-or-direct settlement journal, recomputes balances and party
 * balances, and returns the ledger the caller must persist. Cross-app tender
 * back-propagation lives in books-main's executeReconciliation wrapper.
 */
export function applyReconciliation(
  booksData: BooksData,
  {
    transactionId,
    invoiceId,
    invoiceIds,
  }: { transactionId: string; invoiceId?: string; invoiceIds?: string[] },
): AppliedLedger<ReconciliationCoreResult> {
  const reject = (error: string): AppliedLedger<ReconciliationCoreResult> => ({
    result: { ok: false, error },
    ledger: null,
  })

  const tx = (booksData.bankTransactions || []).find((t) => t.id === transactionId)
  if (!tx) return reject(`Transaction not found: ${transactionId}`)
  if (tx.reconciled) return reject(`Transaction already reconciled: ${transactionId}`)

  // The split targets: an explicit list allocates the line across several
  // invoices; a single invoiceId is the one-invoice case and behaves exactly
  // as before. Duplicates collapse, order is the caller's.
  const requested: string[] = []
  for (const id of [...(invoiceIds ?? []), ...(invoiceId ? [invoiceId] : [])]) {
    if (id && !requested.includes(id)) requested.push(id)
  }
  if (requested.length === 0) {
    return reject('No invoice selected to reconcile against')
  }

  // Validation is all-or-nothing: every target must be open, of the matching
  // direction, and not already settled — the same rules the single-invoice
  // path applies, checked for the whole split before anything is posted. A
  // NEGATIVE balance is not settled: it is a party credit carried on the
  // invoice (the aging report's credit column), and the line is accepted as
  // an unapplied receipt that extends that credit — the only route that
  // clears the line's Suspense balance.
  const invoicesAll = booksData.invoices || []
  // The whole settlement maths runs in the ledger's base currency (statement
  // cash and payments are base), so each target's outstanding is converted at
  // its exchange rate; the written-back figure below goes back to the
  // invoice's own currency.
  const targets = requested.map((id) => {
    const inv = invoicesAll.find((i) => i.id === id)
    if (!inv) return { inv: undefined as Invoice | undefined, id, outstanding: 0 }
    const outstanding = toBaseAmount(
      round2(inv.outstandingAmount !== undefined ? inv.outstandingAmount : inv.grandTotal),
      invoiceExchangeRate(inv),
    )
    return { inv, id, outstanding }
  })

  for (const { inv, id, outstanding } of targets) {
    if (!inv) return reject(`Invoice not found: ${id}`)
    if (inv.status === 'Paid' || outstanding === 0) {
      return reject(
        `Invoice ${inv.invoiceNumber} is already settled (nothing outstanding): a statement line cannot be applied to it`,
      )
    }
    if (inv.status === 'Draft') return reject(`Cannot reconcile a draft invoice: ${id}`)
    if (inv.status === 'Cancelled') {
      return reject(`Cannot reconcile a cancelled invoice: ${id}`)
    }
    if (inv.type === 'Sales' && tx.amount <= 0) {
      return reject('Cannot reconcile a debit/withdrawal transaction against a Sales invoice')
    }
    if (inv.type === 'Purchase' && tx.amount >= 0) {
      return reject('Cannot reconcile a credit/deposit transaction against a Purchase bill')
    }
  }

  const nowIso = new Date().toISOString()
  const primary = targets[0].inv as Invoice

  // 1. Mark transaction reconciled (the first invoice is the match of record)
  const settledTx: BankTransaction = {
    ...tx,
    reconciled: true,
    matchedInvoiceId: primary.id,
    reconciledAt: nowIso,
  }

  // 2. Settlement maths. The line's cash is placed in two parts:
  //  - the part a recorded payment already posted against the named invoices
  //    is NOT placed again (its journal already moved the money);
  //  - what is left fills the invoices in the requested order, each up to its
  //    own balance, and anything beyond that is an unapplied receipt riding on
  //    the last invoice as a negative outstanding — how this product carries a
  //    party credit (see the aging report's credit column).
  // All figures here are base currency; the invoice write-back below converts
  // each remainder back into the invoice's own currency (base ÷ rate).
  const txAmt = round2(Math.abs(tx.amount))
  const alreadyPosted = round2(Math.min(paymentCoverage(tx), txAmt))
  const lineAmount = round2(txAmt - alreadyPosted)

  let cashLeft = lineAmount
  const allocations = targets.map(({ inv, outstanding }, index) => {
    const invoice = inv as Invoice
    const settled = round2(Math.min(cashLeft, Math.max(outstanding, 0)))
    cashLeft = round2(cashLeft - settled)
    const isLast = index === targets.length - 1
    const remainingOutstanding = isLast
      ? round2(outstanding - settled - cashLeft)
      : round2(outstanding - settled)
    return {
      invoice,
      outstanding,
      settled,
      remainingOutstanding,
      status: (remainingOutstanding === 0 ? 'Paid' : 'Unpaid') as Invoice['status'],
    }
  })
  const unappliedAmount = round2(cashLeft)
  const settledAmount = round2(allocations.reduce((s, a) => s + a.settled, 0))

  const updatedInvoices = new Map(
    allocations.map((a) => [
      a.invoice.id,
      {
        ...a.invoice,
        // Write the remainder back in the invoice's OWN currency: the base
        // remainder ÷ its exchange rate. A negative remainder (a party credit
        // riding on this invoice) stays negative in the invoice's currency.
        outstandingAmount: fromBaseAmount(a.remainingOutstanding, invoiceExchangeRate(a.invoice)),
        status: a.status,
        updatedAt: nowIso,
      } as Invoice,
    ]),
  )
  const invoices = (booksData.invoices || []).map((i) => updatedInvoices.get(i.id) ?? i)

  // 3. Recompute party balances from the updated invoices
  const parties = recomputePartyBalances(invoices, booksData.parties || [])
  const partyFor = (inv: Invoice) =>
    parties.find((p) => p.id === inv.partyId || p.name === inv.partyName) ??
    (booksData.parties || []).find((p) => p.id === inv.partyId || p.name === inv.partyName)

  // 4. One balanced settlement entry per invoice that received cash. When the
  // transaction was imported from a bank statement, the import journal already
  // moved the bank account, so each entry only clears suspense against the
  // invoice; legacy transactions post the direct settlement instead. The
  // unapplied receipt rides on the last entry's legs.
  const journals = Array.isArray(booksData.journalEntries) ? [...booksData.journalEntries] : []
  const hasImportJournal = journals.some(
    (je) => je.remarks && je.remarks.includes(`Bank statement import: ${tx.id}`),
  )
  let entryNumber = nextJournalNumber(journals, tx.date)
  const settlementEntryFor = (
    invoice: Invoice,
    amount: number,
    party: Party | undefined,
  ): JournalEntry =>
    hasImportJournal
      ? createReconciliationJournal(settledTx, invoice, booksData.accounts, amount, entryNumber)
      : createSettlementJournal(
          invoice,
          booksData.accounts,
          amount,
          party,
          entryNumber,
          'acc-bank',
          `1-Click Bank Reconciliation: Transaction ${tx.description} for Invoice ${invoice.invoiceNumber}`,
        )

  const funded = allocations.filter((a) => a.settled > 0)
  const newEntries: JournalEntry[] = []
  for (const a of funded) {
    newEntries.push(
      settlementEntryFor(updatedInvoices.get(a.invoice.id)!, a.settled, partyFor(a.invoice)),
    )
    entryNumber = nextJournalNumber([...journals, ...newEntries], tx.date)
  }
  const carrier = allocations[allocations.length - 1]
  const unappliedRemark = `Unapplied ${
    carrier.invoice.type === 'Sales' ? 'receipt' : 'payment'
  }: Transaction ${tx.description || tx.id}`
  if (unappliedAmount > 0) {
    const unappliedEntry = settlementEntryFor(
      updatedInvoices.get(carrier.invoice.id)!,
      unappliedAmount,
      partyFor(carrier.invoice),
    )
    if (newEntries.length > 0) {
      newEntries[newEntries.length - 1] = withUnappliedReceipt(
        newEntries[newEntries.length - 1],
        unappliedEntry,
        unappliedAmount,
        unappliedRemark,
      )
    } else {
      // Nothing was settled (every target already in credit): the whole line
      // is one unapplied receipt entry of its own. The base entry is built for
      // the settled amount (zero), so only the receipt legs survive.
      const emptyBase = settlementEntryFor(carrier.invoice, 0, partyFor(carrier.invoice))
      newEntries.push(
        withUnappliedReceipt(emptyBase, unappliedEntry, unappliedAmount, unappliedRemark),
      )
    }
  }
  journals.unshift(...newEntries)

  const ledger = deriveLedger(
    appendAudit(
      {
        ...booksData,
        bankTransactions: (booksData.bankTransactions || []).map((t) =>
          t.id === settledTx.id ? settledTx : t,
        ),
        invoices,
        parties,
        journalEntries: journals,
        updatedAt: new Date().toISOString(),
      },
      createAuditEntry(
        'bank.reconcile',
        `Reconciled ${tx.description || tx.id} against ${allocations
          .map((a) => a.invoice.invoiceNumber)
          .join(', ')}${unappliedAmount > 0 ? ` (${unappliedAmount} unapplied)` : ''}`,
        {
          invoiceNumber: allocations.map((a) => a.invoice.invoiceNumber).join(', '),
          amount: settledAmount,
        },
      ),
    ),
  )

  const last = allocations[allocations.length - 1]
  return {
    result: {
      ok: true,
      transactionId: settledTx.id,
      invoiceId: last.invoice.id,
      invoiceNumber: last.invoice.invoiceNumber,
      settledAmount,
      remainingOutstanding: last.remainingOutstanding,
      invoiceStatus: last.status,
      partyBalance: partyFor(last.invoice)?.outstandingBalance,
      unappliedAmount,
      applied: allocations.map((a) => ({
        invoiceId: a.invoice.id,
        invoiceNumber: a.invoice.invoiceNumber,
        settledAmount: a.settled,
        remainingOutstanding: a.remainingOutstanding,
        invoiceStatus: a.status,
      })),
    },
    ledger,
  }
}

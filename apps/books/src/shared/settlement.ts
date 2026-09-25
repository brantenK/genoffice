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
} from './accounting'
import { appendAudit, createAuditEntry } from './audit'
import { paymentCoverage, planImportCoverage } from './payments'
import type {
  BankTransaction,
  BooksData,
  Invoice,
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
      const currentOutstanding = round2(
        inv.outstandingAmount !== undefined ? inv.outstandingAmount : inv.grandTotal,
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
  { transactionId, invoiceId }: { transactionId: string; invoiceId: string },
): AppliedLedger<ReconciliationCoreResult> {
  const reject = (error: string): AppliedLedger<ReconciliationCoreResult> => ({
    result: { ok: false, error },
    ledger: null,
  })

  const tx = (booksData.bankTransactions || []).find((t) => t.id === transactionId)
  if (!tx) return reject(`Transaction not found: ${transactionId}`)
  if (tx.reconciled) return reject(`Transaction already reconciled: ${transactionId}`)

  const inv = (booksData.invoices || []).find((i) => i.id === invoiceId)
  if (!inv) return reject(`Invoice not found: ${invoiceId}`)

  // The invoice's own balance decides whether it can receive the line. A
  // settled invoice (nothing outstanding) is closed and stays refused, with a
  // message that says so. A NEGATIVE balance is not settled: it is a party
  // credit carried on the invoice (the aging report's credit column), and the
  // line is accepted as an unapplied receipt that extends that credit — the
  // only route that clears the line's Suspense balance.
  const currentOutstanding = round2(
    inv.outstandingAmount !== undefined ? inv.outstandingAmount : inv.grandTotal,
  )
  if (inv.status === 'Paid' || currentOutstanding === 0) {
    return reject(
      `Invoice ${inv.invoiceNumber} is already settled (nothing outstanding): a statement line cannot be applied to it`,
    )
  }
  if (inv.status === 'Draft') return reject(`Cannot reconcile a draft invoice: ${invoiceId}`)
  if (inv.status === 'Cancelled') {
    return reject(`Cannot reconcile a cancelled invoice: ${invoiceId}`)
  }

  // Direction validation
  if (inv.type === 'Sales' && tx.amount <= 0) {
    return reject('Cannot reconcile a debit/withdrawal transaction against a Sales invoice')
  }
  if (inv.type === 'Purchase' && tx.amount >= 0) {
    return reject('Cannot reconcile a credit/deposit transaction against a Purchase bill')
  }

  const nowIso = new Date().toISOString()

  // 1. Mark transaction reconciled
  const settledTx: BankTransaction = {
    ...tx,
    reconciled: true,
    matchedInvoiceId: inv.id,
    reconciledAt: nowIso,
  }

  // 2. Exact, partial and over-amount settlement maths. The line's cash is
  // placed in two parts:
  //  - the part a recorded payment already posted against this invoice is NOT
  //    placed again: the payment's allocation cut the invoice before the line
  //    arrived and its journal already moved the money, so booking it here
  //    would double-count the cash and invent a party credit;
  //  - what is left settles the invoice up to its own balance, and anything
  //    beyond that is an unapplied receipt. The excess rides on the invoice as
  //    a negative outstanding, which is how this product carries a party credit
  //    (see the aging report's credit column), so the control account, the
  //    derived party balance and the aging report all show the same figure
  //    instead of a Bank Suspense balance nothing can ever clear.
  const txAmt = round2(Math.abs(tx.amount))
  const alreadyPosted = round2(Math.min(paymentCoverage(tx), txAmt))
  const lineAmount = round2(txAmt - alreadyPosted)
  const settledAmount = round2(Math.min(lineAmount, Math.max(currentOutstanding, 0)))
  const remainingOutstanding = round2(currentOutstanding - lineAmount)
  const unappliedAmount = round2(lineAmount - settledAmount)

  const settledInvoice: Invoice = {
    ...inv,
    outstandingAmount: remainingOutstanding,
    // Only a zero residual closes the invoice: an over-settled one stays open
    // precisely because a party credit remains against it.
    status: remainingOutstanding === 0 ? 'Paid' : 'Unpaid',
    updatedAt: nowIso,
  }

  const bankTransactions = (booksData.bankTransactions || []).map((t) =>
    t.id === settledTx.id ? settledTx : t,
  )
  const invoices = (booksData.invoices || []).map((i) =>
    i.id === settledInvoice.id ? settledInvoice : i,
  )

  // 3. Recompute party balance from open invoices
  const party = (booksData.parties || []).find(
    (p) => p.id === inv.partyId || p.name === inv.partyName,
  )
  const parties = recomputePartyBalances(invoices, booksData.parties || [])
  const updatedParty = parties.find((p) => p.id === inv.partyId || p.name === inv.partyName)

  // 4. Post the settlement journal entry. When the transaction was imported
  // from a bank statement, the import journal already moved the bank account,
  // so this leg only clears the suspense account against Receivable/Payable
  // (ledger-first: no direct balance mutation anywhere). Legacy transactions
  // without an import journal post the full direct settlement instead.
  const journals = Array.isArray(booksData.journalEntries) ? [...booksData.journalEntries] : []
  const hasImportJournal = journals.some(
    (je) => je.remarks && je.remarks.includes(`Bank statement import: ${tx.id}`),
  )
  const entryNumber = nextJournalNumber(journals, tx.date)
  const settlementEntryFor = (amount: number): JournalEntry =>
    hasImportJournal
      ? createReconciliationJournal(
          settledTx,
          settledInvoice,
          booksData.accounts,
          amount,
          entryNumber,
        )
      : createSettlementJournal(
          settledInvoice,
          booksData.accounts,
          amount,
          updatedParty || party,
          entryNumber,
          'acc-bank',
          `1-Click Bank Reconciliation: Transaction ${tx.description} for Invoice ${inv.invoiceNumber}`,
        )

  let settlementJournal = settlementEntryFor(settledAmount)
  if (unappliedAmount > 0) {
    settlementJournal = withUnappliedReceipt(
      settlementJournal,
      settlementEntryFor(unappliedAmount),
      unappliedAmount,
      `Unapplied ${inv.type === 'Sales' ? 'receipt' : 'payment'}: Transaction ${
        tx.description || tx.id
      }`,
    )
  }
  // When a recorded payment already posted the whole line there is nothing left
  // to place, and an entry of two zero legs would only be journal noise.
  if (settledAmount > 0 || unappliedAmount > 0) journals.unshift(settlementJournal)

  const ledger = deriveLedger(
    appendAudit(
      {
        ...booksData,
        bankTransactions,
        invoices,
        parties,
        journalEntries: journals,
        updatedAt: new Date().toISOString(),
      },
      createAuditEntry(
        'bank.reconcile',
        `Reconciled ${tx.description || tx.id} against ${inv.invoiceNumber}${
          unappliedAmount > 0 ? ` (${unappliedAmount} unapplied)` : ''
        }`,
        { invoiceNumber: inv.invoiceNumber, amount: settledAmount },
      ),
    ),
  )

  return {
    result: {
      ok: true,
      transactionId: settledTx.id,
      invoiceId: settledInvoice.id,
      invoiceNumber: settledInvoice.invoiceNumber,
      settledAmount,
      remainingOutstanding,
      invoiceStatus: settledInvoice.status,
      partyBalance: updatedParty ? updatedParty.outstandingBalance : party?.outstandingBalance,
      unappliedAmount,
    },
    ledger,
  }
}

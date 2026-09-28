// Credit notes & partial-settlement planning for Zano Books.
// Pure module (no electron / react imports). Every credit note posts a
// balanced reversal journal (ledger-first), so account balances stay
// derived from journal entries and are never mutated directly.

import type {
  Account,
  BankTransaction,
  Invoice,
  InvoiceStatus,
  JournalEntry,
  JournalEntryItem,
  Party,
} from './types'
import {
  createBankImportJournal,
  journalLineAmount,
  nextJournalNumber,
  postedInvoiceAmounts,
  round2,
  toBaseAmount,
  invoiceExchangeRate,
} from './accounting'
import { localIsoToday } from './dates'

/**
 * Creates a balanced JournalEntry that REVERSES a previously posted sales
 * or purchase invoice. The credit note invoice itself carries POSITIVE
 * totals (subtotal / taxTotal / grandTotal); the reversal happens in the
 * journal by mirroring createSalesInvoiceJournal / createPurchaseBillJournal
 * with every debit/credit side swapped:
 * - Sales credit note:    Cr Accounts Receivable / Dr Income groups / Dr VAT output
 * - Purchase credit note: Dr Accounts Payable / Cr Expense groups / Cr VAT input
 * Income/expense line items are grouped by item.accountId on the same
 * post-discount basis (effectiveLineAmount) as the original posting, and the
 * invoice-level discount and round-off are mirrored on the first group the
 * original booked them to, so per account the credit note cancels the invoice
 * it reverses. The last group still absorbs any leftover rounding difference,
 * so the entry always balances.
 *
 * Every leg is in the LEDGER'S BASE CURRENCY, converted from the credit
 * note's own currency at its exchange rate — the same conversion the original
 * posting applied — so an invoice and its credit note (same currency and
 * rate) still net every account to zero.
 */
export function createCreditNoteJournal(
  invoice: Invoice,
  accounts: Account[],
  party?: Party,
  entryNumber?: string,
): JournalEntry {
  const rate = invoiceExchangeRate(invoice)
  const grandTotal = toBaseAmount(
    round2(invoice.grandTotal || invoice.subtotal + invoice.taxTotal),
    rate,
  )
  // The reversal must carry back exactly the VAT and the VAT-exclusive base the
  // original posting carried, so both read the same shared rule (both in base
  // currency).
  const { subtotal: postedSubtotal, taxTotal } = postedInvoiceAmounts(invoice)
  const discountTotal = toBaseAmount(Number(invoice.discountTotal) || 0, rate)
  const isSales = invoice.type === 'Sales'

  const dateStr = invoice.date || localIsoToday()
  const year = new Date(dateStr).getFullYear() || new Date().getFullYear()
  const randomSuffix = Math.random().toString(36).slice(2, 7)
  const entryNum = entryNumber || `JE-${year}-${String(Date.now()).slice(-4)}-${randomSuffix}`

  const items: JournalEntryItem[] = []
  const absGrand = round2(Math.abs(grandTotal))

  // Receivable / Payable leg — the reverse side of the original posting.
  if (isSales) {
    const arAcc = accounts.find((a) => a.id === 'acc-ar' || a.accountType === 'Receivable') || {
      id: 'acc-ar',
      name: 'Accounts Receivable (Debtors)',
    }
    items.push({
      id: `je-i-ar-cn-${Date.now()}-${randomSuffix}`,
      accountId: arAcc.id,
      accountName: arAcc.name,
      invoiceId: invoice.id,
      partyId: invoice.partyId || party?.id,
      partyName: invoice.partyName || party?.name,
      debit: grandTotal < 0 ? absGrand : 0,
      credit: grandTotal >= 0 ? absGrand : 0,
      remark: `Credit Note ${invoice.invoiceNumber}`,
    })
  } else {
    const apAcc = accounts.find((a) => a.id === 'acc-ap' || a.accountType === 'Payable') || {
      id: 'acc-ap',
      name: 'Accounts Payable (Creditors)',
    }
    items.push({
      id: `je-i-ap-cn-${Date.now()}-${randomSuffix}`,
      accountId: apAcc.id,
      accountName: apAcc.name,
      invoiceId: invoice.id,
      partyId: invoice.partyId || party?.id,
      partyName: invoice.partyName || party?.name,
      debit: grandTotal >= 0 ? absGrand : 0,
      credit: grandTotal < 0 ? absGrand : 0,
      remark: `Credit Note ${invoice.invoiceNumber}`,
    })
  }

  // Group line items by income/expense account on the same post-discount
  // `journalLineAmount` basis as the original posting, converted into the
  // ledger's base currency at the same rate, so per account the reversal
  // cancels the invoice it credits.
  const groups = new Map<string, { accountId: string; accountName: string; amount: number }>()

  if (Array.isArray(invoice.items) && invoice.items.length > 0) {
    for (const it of invoice.items) {
      const lineAmt = toBaseAmount(journalLineAmount(it), rate)
      const accId = it.accountId || (isSales ? 'acc-sales' : 'acc-materials')
      const matched = accounts.find((a) => a.id === accId)
      const accName =
        it.accountName ||
        matched?.name ||
        (isSales
          ? 'Tender & Commercial Contracting Sales'
          : 'Direct Project Materials & Subcontractors')

      const existing = groups.get(accId) || {
        accountId: accId,
        accountName: accName,
        amount: 0,
      }
      existing.amount = round2(existing.amount + lineAmt)
      groups.set(accId, existing)
    }
  }

  // The original posting booked the invoice-level discount and any round-off
  // adjustment on the first group, so the reversal carries them back on the
  // same account. Subtracting them leaves the groups at the posted
  // VAT-exclusive subtotal; any leftover (an unrecorded difference) is
  // absorbed by the last group. A negative subtotal posts no discount leg on
  // the invoice either, so the mirror must not carry one back.
  const bookedDiscount = round2(postedSubtotal >= 0 ? Math.min(discountTotal, postedSubtotal) : 0)
  const roundOff = toBaseAmount(Number(invoice.roundOff) || 0, rate)
  const groupTotal = round2(grandTotal - taxTotal + bookedDiscount - roundOff)

  if (groups.size === 0) {
    const fallback = isSales
      ? accounts.find((a) => a.id === 'acc-sales' || a.accountType === 'Direct Income') || {
          id: 'acc-sales',
          name: 'Tender & Commercial Contracting Sales',
        }
      : accounts.find((a) => a.id === 'acc-materials' || a.accountType === 'Direct Expense') || {
          id: 'acc-materials',
          name: 'Direct Project Materials & Subcontractors',
        }
    groups.set(fallback.id, {
      accountId: fallback.id,
      accountName: fallback.name,
      amount: groupTotal,
    })
  } else {
    // Ensure the grouped amount equals the posted subtotal exactly
    // (1-cent absorption).
    const entries = Array.from(groups.values())
    const sumGroups = entries.reduce((s, e) => round2(s + e.amount), 0)
    const diff = round2(groupTotal - sumGroups)
    if (diff !== 0 && entries.length > 0) {
      entries[entries.length - 1].amount = round2(entries[entries.length - 1].amount + diff)
    }
  }

  let grpIdx = 1
  for (const grp of groups.values()) {
    if (grp.amount !== 0 || groups.size === 1 || groupTotal === 0) {
      const isNegative = grp.amount < 0
      const absAmt = round2(Math.abs(grp.amount))
      // Sales credit notes debit income groups; purchase credit notes credit
      // expense groups. Negative group amounts flip to the opposite side.
      const onDebitSide = isSales ? !isNegative : isNegative
      items.push({
        id: `je-i-cn-${grpIdx++}-${Date.now()}-${randomSuffix}`,
        accountId: grp.accountId,
        accountName: grp.accountName,
        invoiceId: invoice.id,
        debit: onDebitSide ? absAmt : 0,
        credit: onDebitSide ? 0 : absAmt,
        remark: isNegative
          ? `Credit Note Adjustment - ${invoice.invoiceNumber}`
          : `Credit Note Reversal - ${invoice.invoiceNumber}`,
      })
    }
  }

  // Invoice-level discount: the reverse of the original posting's entry for
  // it (a debit for sales, a credit for purchase), on the same first account.
  if (bookedDiscount !== 0) {
    const first = Array.from(groups.values())[0]
    const absDiscount = round2(Math.abs(bookedDiscount))
    const onDebitSide = isSales ? bookedDiscount < 0 : bookedDiscount > 0
    items.push({
      id: `je-i-cn-disc-${Date.now()}-${randomSuffix}`,
      accountId: first.accountId,
      accountName: first.accountName,
      invoiceId: invoice.id,
      debit: onDebitSide ? absDiscount : 0,
      credit: onDebitSide ? 0 : absDiscount,
      remark: `Credit Note Discount Reversal - ${invoice.invoiceNumber}`,
    })
  }

  if (taxTotal !== 0) {
    const vatAcc = isSales
      ? accounts.find((a) => a.id === 'acc-vat' || a.id === 'acc-vat-out') || {
          id: 'acc-vat',
          name: 'SARS VAT Output Payable',
        }
      : accounts.find((a) => a.id === 'acc-vat-in') ||
        accounts.find((a) => a.id === 'acc-vat') || {
          id: 'acc-vat-in',
          name: 'SARS VAT Input Recoverable',
        }
    const isNegativeTax = taxTotal < 0
    const absTax = round2(Math.abs(taxTotal))
    // Sales credit notes debit VAT output; purchase credit notes credit VAT
    // input. Negative tax flips to the opposite side.
    const onDebitSide = isSales ? !isNegativeTax : isNegativeTax
    items.push({
      id: `je-i-vat-cn-${Date.now()}-${randomSuffix}`,
      accountId: vatAcc.id,
      accountName: vatAcc.name,
      invoiceId: invoice.id,
      debit: onDebitSide ? absTax : 0,
      credit: onDebitSide ? 0 : absTax,
      remark: isSales
        ? `Credit Note VAT Output Reversal - ${invoice.invoiceNumber}`
        : `Credit Note VAT Input Reversal - ${invoice.invoiceNumber}`,
    })
  }

  // Round-off: the reverse of the original posting's adjustment, on the same
  // first account, so a rounded invoice and its credit note cancel per account.
  if (roundOff !== 0) {
    const primary = Array.from(groups.values())[0]
    const absRoundOff = round2(Math.abs(roundOff))
    const onDebitSide = isSales ? roundOff > 0 : roundOff < 0
    items.push({
      id: `je-i-cn-round-${Date.now()}-${randomSuffix}`,
      accountId: primary.accountId,
      accountName: primary.accountName,
      invoiceId: invoice.id,
      debit: onDebitSide ? absRoundOff : 0,
      credit: onDebitSide ? 0 : absRoundOff,
      remark: `Credit Note Round-off Reversal - ${invoice.invoiceNumber}`,
    })
  }

  const totalDebit = round2(items.reduce((s, it) => s + it.debit, 0))
  const totalCredit = round2(items.reduce((s, it) => s + it.credit, 0))

  return {
    id: `je-${Date.now()}-${randomSuffix}`,
    entryNumber: entryNum,
    date: dateStr,
    items,
    totalDebit,
    totalCredit,
    remarks: `System credit note posting for ${invoice.invoiceNumber}`,
    posted: true,
  }
}

export interface CreditNoteValidationInput {
  invoice: Invoice
  originalInvoice?: Invoice | null
  paidAmount: number
  /** Credit notes already issued against the same original invoice. */
  existingCreditNotes?: Invoice[]
}

/**
 * Validates a credit note before posting:
 * - the credit note must carry an invoice number reference,
 * - subtotal / taxTotal / grandTotal must be numeric,
 * - the credit amount (grandTotal) must be greater than zero,
 * - when an original invoice is supplied: it must not itself be a credit
 *   note, and the credit amount may never exceed the original grandTotal
 *   (never credit more than was ever billed),
 * - the CUMULATIVE total of credit notes against the original invoice
 *   (existing + this one) may never exceed the original grandTotal, so two
 *   full credit notes cannot both pass.
 */
export function validateCreditNote(input: CreditNoteValidationInput): {
  ok: boolean
  error?: string
} {
  const { invoice, originalInvoice } = input

  const reference = typeof invoice.invoiceNumber === 'string' ? invoice.invoiceNumber.trim() : ''
  if (!reference) {
    return { ok: false, error: 'Credit note must reference an invoice number' }
  }

  if (
    !Number.isFinite(Number(invoice.subtotal)) ||
    !Number.isFinite(Number(invoice.taxTotal)) ||
    !Number.isFinite(Number(invoice.grandTotal))
  ) {
    return { ok: false, error: 'Credit note amounts must be numeric' }
  }

  const amount = round2(Number(invoice.grandTotal) || 0)
  if (amount <= 0) {
    return { ok: false, error: 'Credit note amount must be greater than zero' }
  }

  if (originalInvoice) {
    if (originalInvoice.creditNote) {
      return { ok: false, error: 'Cannot credit a credit note' }
    }
    const originalTotal = round2(Number(originalInvoice.grandTotal) || 0)
    if (amount > originalTotal) {
      return { ok: false, error: 'Credit note amount cannot exceed the original invoice total' }
    }
    // Cumulative cap: existing credit notes against this invoice plus the
    // new one may never exceed what was billed.
    const alreadyCredited = round2(
      (input.existingCreditNotes || []).reduce((sum, cn) => sum + (Number(cn.grandTotal) || 0), 0),
    )
    if (round2(alreadyCredited + amount) > originalTotal) {
      return {
        ok: false,
        error: `Cumulative credit notes (${alreadyCredited}) plus this amount (${amount}) exceed the original invoice total (${originalTotal})`,
      }
    }
  }

  return { ok: true }
}

/**
 * Corrected repost plan for the phase-1 partial-settlement limitation: when
 * a partially settled invoice is edited, the store currently reverses ALL
 * its journals and re-posts the full amount, losing the paid portion. This
 * pure function computes what the corrected behavior must be:
 * - paidAmount = old grandTotal - old outstanding (what was already paid;
 *   zero when the old invoice was never paid),
 * - newOutstanding = max(0, next grandTotal - paidAmount),
 * - status = Paid when nothing remains outstanding, otherwise Draft stays
 *   Draft and every other open status becomes Unpaid.
 */
export function repostPlanForPartialSettlement(
  oldInvoice: Invoice,
  nextInvoice: Invoice,
): { paidAmount: number; newOutstanding: number; status: InvoiceStatus } {
  const paidAmount = Math.max(
    0,
    round2((Number(oldInvoice.grandTotal) || 0) - (Number(oldInvoice.outstandingAmount) || 0)),
  )
  const newOutstanding = Math.max(0, round2((Number(nextInvoice.grandTotal) || 0) - paidAmount))
  const status: InvoiceStatus =
    newOutstanding <= 0 ? 'Paid' : nextInvoice.status === 'Draft' ? 'Draft' : 'Unpaid'
  return { paidAmount, newOutstanding, status }
}

/**
 * True when a remark mentions the exact reference. References are matched as
 * whole tokens, so INV-2026-001 does not match INV-2026-0011 (or the other way
 * round): letters, digits, underscores and hyphens stay part of the token. An
 * empty reference matches nothing (and would otherwise scan forever, since
 * `indexOf('')` always finds the end of the string).
 */
export function mentionsReference(text: string | undefined, reference: string): boolean {
  const haystack = String(text || '')
  if (!haystack || !reference) return false
  const isReferenceChar = (char: string): boolean => /[A-Za-z0-9_-]/.test(char)

  let from = 0
  for (;;) {
    const at = haystack.indexOf(reference, from)
    if (at === -1) return false
    const before = at > 0 ? haystack[at - 1] : ''
    const after = at + reference.length < haystack.length ? haystack[at + reference.length] : ''
    if (!isReferenceChar(before) && !isReferenceChar(after)) return true
    from = at + 1
  }
}

/**
 * True when the journal entry was posted for exactly this invoice number —
 * matched as a whole reference in the entry remarks or the item remarks, never
 * as a substring, so INV-2026-001 cannot claim the journals of INV-2026-0011.
 */
export function journalReferencesInvoice(journal: JournalEntry, invoiceNumber: string): boolean {
  const reference = String(invoiceNumber || '').trim()
  if (!reference) return false
  if (mentionsReference(journal?.remarks, reference)) return true
  return (journal?.items || []).some((item) => mentionsReference(item?.remark, reference))
}

/**
 * Returns the journal entries minus every entry that references the given
 * invoice number — the journals the store reverses when editing or deleting a
 * posted invoice. Matching is by exact reference (see
 * `journalReferencesInvoice`), so a number that is merely a prefix of another
 * (INV-2026-001 vs INV-2026-0011) leaves the other invoice's journals alone.
 *
 * LEGACY helper: product paths now attribute journals structurally (see
 * `journalOwnedByInvoice`) — remark text is not invoice identity, because
 * statement descriptions ride inside remarks and would couple unrelated
 * journals to this invoice's number. Retained for historical tooling and the
 * helper's own suite.
 */
export function reversalJournalRemoval(
  oldInvoiceNumber: string,
  journalEntries: JournalEntry[],
): JournalEntry[] {
  return (journalEntries || []).filter((je) => !journalReferencesInvoice(je, oldInvoiceNumber))
}

/* ════════════════════════════════════════════════════════════════════
   Structural invoice attribution (findings F3/F6): an invoice's journals
   are found by a structural key — JournalEntryItem.invoiceId, stamped by
   every invoice-owned journal builder at posting time — never by matching
   remark or description text. Statement text belongs to the STATEMENT.
   ════════════════════════════════════════════════════════════════════ */

/** Cash-side accounts are statement-owned and never carry invoice attribution. */
const CASH_SIDE_ACCOUNTS = new Set(['acc-bank', 'acc-suspense'])

/**
 * True when the journal entry belongs to the given invoice, by structural
 * attribution: a leg stamped with this invoice's id. Journals posted before
 * the attribution key existed (legacy rows whose legs carry no invoiceId) fall
 * back to ITEM remarks only — never the entry remark, which carries raw
 * statement text — and never through a cash-side leg, whose remark embeds the
 * statement description. This keeps legacy behaviour for the invoice's own
 * posting/settlement legs while making import journals (whose only legs are
 * cash-side) permanently immune to remark coupling.
 */
export function journalOwnedByInvoice(
  journal: JournalEntry,
  invoice: Pick<Invoice, 'id' | 'invoiceNumber'>,
): boolean {
  const reference = String(invoice.invoiceNumber || '').trim()
  return (journal?.items || []).some((item) => {
    if (item.invoiceId) return item.invoiceId === invoice.id
    if (!reference) return false
    return !CASH_SIDE_ACCOUNTS.has(item.accountId) && mentionsReference(item?.remark, reference)
  })
}

/** The journals that belong to the given invoice, by structural attribution. */
export function invoiceOwnedJournals(
  invoice: Pick<Invoice, 'id' | 'invoiceNumber'>,
  journalEntries: JournalEntry[],
): JournalEntry[] {
  return (journalEntries || []).filter((je) => journalOwnedByInvoice(je, invoice))
}

export interface InvoiceDeletionUnwind {
  journalEntries: JournalEntry[]
  bankTransactions: BankTransaction[]
}

/**
 * THE coherent delete unwind for a posted invoice (findings F3/F6).
 *
 * Removes the invoice's OWN journals by structural attribution — the posting
 * journal and every settlement journal allocated to it (payment settlements,
 * reconciliation reclasses, unapplied-receipt rides). A reclass entry pairs an
 * invoice-owned AR/AP leg with a statement-owned Suspense leg; removing the
 * whole entry releases the statement's cash back to Suspense, which is exactly
 * the "unallocated remainder" the deletion must leave behind.
 *
 * Every statement line the invoice touched is then restored to a coherent
 * allocation state:
 * - payment links owned by payments that died with the invoice are dropped;
 * - the line stays reconciled while a LIVE allocation survives for it (a
 *   sibling reclass of a split, or live payment links covering its full cash)
 *   — un-reconciling it would invite a second allocation of cash another
 *   invoice already holds;
 * - otherwise the line is un-reconciled (no match against a dead invoice) so
 *   the cash can be reconciled again, and — only when the line has NO import
 *   journal of its own (its cash was posted by the now-removed settlement) —
 *   one import journal is posted for the uncovered remainder, restoring the
 *   bank movement. An existing import journal is never touched: it already
 *   posts the line's bank truth, and its Suspense credit is what holds the
 *   unallocated remainder.
 *
 * The over-payment credit ride (an unapplied receipt riding a settlement) is
 * removed WITH the settlement it rode; the cash behind it returns to Suspense
 * with the remainder, where it can be re-allocated later.
 *
 * Draft invoices post nothing and unwind to a no-op. Import journals are
 * never attribution targets: they belong to the statement, so statement text
 * naming this invoice can never pull them into the removal.
 */
export function unwindDeletedInvoice(
  invoice: Pick<Invoice, 'id' | 'invoiceNumber' | 'status'>,
  journalEntries: JournalEntry[],
  bankTransactions: BankTransaction[],
  accounts: Account[],
  droppedPaymentIds: ReadonlySet<string>,
): InvoiceDeletionUnwind {
  if (String(invoice.status || '').toLowerCase() === 'draft') {
    return { journalEntries, bankTransactions }
  }
  const owned = invoiceOwnedJournals(invoice, journalEntries)
  if (owned.length === 0) {
    return { journalEntries, bankTransactions }
  }
  const ownedSet = new Set(owned)
  const journals = journalEntries.filter((je) => !ownedSet.has(je))

  const reclassTxIds = new Set(
    owned
      .map((je) => String(je.id || ''))
      .filter((id) => id.startsWith('je-reclass-'))
      .map((id) => id.slice('je-reclass-'.length)),
  )

  const nextTxs: BankTransaction[] = []
  for (const tx of bankTransactions || []) {
    const links = tx.paymentLinks || []
    const liveLinks = links.filter((link) => !droppedPaymentIds.has(link.paymentId))
    const deadLinks = liveLinks.length !== links.length
    const reclassRemoved = reclassTxIds.has(tx.id)
    const matchDied = tx.matchedInvoiceId === invoice.id
    if (!reclassRemoved && !matchDied && !deadLinks) {
      nextTxs.push(tx)
      continue
    }

    // Recompute the line's allocation state from what is still LIVE: the
    // surviving payment links, and any sibling reclass of a split that is
    // still holding its share of the cash.
    const survivingReclass = journals.find((je) => je.id === `je-reclass-${tx.id}`)
    const survivingInvoiceId = survivingReclass?.items.find((it) => it.invoiceId)?.invoiceId
    const covered = round2(liveLinks.reduce((s, link) => s + round2(Number(link.amount) || 0), 0))
    const txAbs = round2(Math.abs(Number(tx.amount) || 0))
    const uncovered = round2(txAbs - covered)
    const fullyCovered = txAbs > 0 && uncovered <= 0.005
    const stillAllocated = Boolean(survivingReclass) || fullyCovered
    const firstLive = liveLinks[0]
    nextTxs.push({
      ...tx,
      paymentLinks: liveLinks.length > 0 ? liveLinks : undefined,
      reconciled: stillAllocated,
      matchedInvoiceId: stillAllocated
        ? survivingInvoiceId ?? firstLive?.invoiceId
        : undefined,
      reconciledAt: stillAllocated ? tx.reconciledAt ?? new Date().toISOString() : undefined,
    })

    // The line's bank cash is posted exactly once. An existing import journal
    // already carries it (and its Suspense credit holds the unallocated
    // remainder), so it is left untouched. A line with NO import journal had
    // its cash posted by the settlement that just died — restore it with one
    // journal for the uncovered remainder.
    const hasImportJournal = journals.some((je) => je.id === `je-import-${tx.id}`)
    if (!hasImportJournal && !stillAllocated && uncovered > 0.005) {
      journals.unshift(
        createBankImportJournal(
          { ...tx, amount: tx.amount > 0 ? uncovered : -uncovered },
          accounts,
          nextJournalNumber(journals, tx.date),
        ),
      )
    }
  }

  return { journalEntries: journals, bankTransactions: nextTxs }
}

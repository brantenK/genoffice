// Credit notes & partial-settlement planning for Zano Books.
// Pure module (no electron / react imports). Every credit note posts a
// balanced reversal journal (ledger-first), so account balances stay
// derived from journal entries and are never mutated directly.

import type {
  Account,
  Invoice,
  InvoiceStatus,
  JournalEntry,
  JournalEntryItem,
  Party,
} from './types'
import { journalLineAmount, postedInvoiceAmounts, round2 } from './accounting'

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
 */
export function createCreditNoteJournal(
  invoice: Invoice,
  accounts: Account[],
  party?: Party,
  entryNumber?: string,
): JournalEntry {
  const grandTotal = round2(invoice.grandTotal || invoice.subtotal + invoice.taxTotal)
  // The reversal must carry back exactly the VAT and the VAT-exclusive base the
  // original posting carried, so both read the same shared rule.
  const { subtotal: postedSubtotal, taxTotal } = postedInvoiceAmounts(invoice)
  const discountTotal = round2(Number(invoice.discountTotal) || 0)
  const isSales = invoice.type === 'Sales'

  const dateStr = invoice.date || new Date().toISOString().split('T')[0]
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
      partyId: invoice.partyId || party?.id,
      partyName: invoice.partyName || party?.name,
      debit: grandTotal >= 0 ? absGrand : 0,
      credit: grandTotal < 0 ? absGrand : 0,
      remark: `Credit Note ${invoice.invoiceNumber}`,
    })
  }

  // Group line items by income/expense account on the same post-discount
  // `journalLineAmount` basis as the original posting, so per account the
  // reversal cancels the invoice it credits.
  const groups = new Map<string, { accountId: string; accountName: string; amount: number }>()

  if (Array.isArray(invoice.items) && invoice.items.length > 0) {
    for (const it of invoice.items) {
      const lineAmt = journalLineAmount(it)
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
  const roundOff = round2(Number(invoice.roundOff) || 0)
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
 */
export function reversalJournalRemoval(
  oldInvoiceNumber: string,
  journalEntries: JournalEntry[],
): JournalEntry[] {
  return (journalEntries || []).filter((je) => !journalReferencesInvoice(je, oldInvoiceNumber))
}

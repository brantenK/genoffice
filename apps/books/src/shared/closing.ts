// Period-close engine for Zano Books.
// Pure module (no electron / react imports). Closing a period never mutates
// account balances directly: it prepends balanced year-end closing journal
// entries and recomputes every balance from the journals (ledger-first), so
// the stored balances always stay derived from journal entries.

import type { BooksData, JournalEntry, JournalEntryItem } from './types'
import { computeAccountBalances, round2 } from './accounting'

/** Strict ISO YYYY-MM-DD matcher (string comparison is safe for these). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** True when `s` is a real calendar date in YYYY-MM-DD form. */
function isValidIsoDate(s: string): boolean {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false
  const parsed = new Date(s)
  if (isNaN(parsed.getTime())) return false
  return parsed.toISOString().slice(0, 10) === s
}

/**
 * True when the given YYYY-MM-DD date is locked because a period has already
 * been closed through it (dates at or before settings.closedThrough cannot be
 * posted into anymore). Empty or invalid dates are never locked.
 */
export function isDateLocked(data: BooksData, date: string): boolean {
  const closedThrough = String(data?.settings?.closedThrough || '').trim()
  if (!closedThrough || !isValidIsoDate(date) || !isValidIsoDate(closedThrough)) return false
  return date <= closedThrough
}

/**
 * Main-process boundary guard for whole-envelope saves. Once a period is
 * closed, raw renderer IPC may not rewrite invoices or journal entries dated
 * in the locked window (or remove the close setting itself). Late settlements
 * go through the dedicated bank-reconciliation core, not this arbitrary save.
 */
export function validateClosedPeriodMutation(
  previous: BooksData,
  candidate: BooksData,
): { ok: boolean; error?: string } {
  const closedThrough = String(previous?.settings?.closedThrough || '').trim()
  if (!closedThrough || !isValidIsoDate(closedThrough)) return { ok: true }
  if (candidate?.settings?.closedThrough !== closedThrough) {
    return { ok: false, error: `Closed period through ${closedThrough} cannot be changed through a raw save` }
  }

  const lockedInvoices = (data: BooksData) =>
    new Map(
      (data.invoices || [])
        .filter((inv) => isDateLocked(previous, inv.date))
        .map((inv) => {
          // Late payments/reconciliation are legitimate after close: they may
          // change an old invoice's settlement state, but never its P&L
          // content. Compare every accounting/identity field while allowing
          // status, outstandingAmount and updatedAt to move.
          const { status: _status, outstandingAmount: _outstanding, updatedAt: _updated, ...lockedShape } = inv
          return [inv.id, JSON.stringify(lockedShape)]
        }),
    )
  const lockedJournals = (data: BooksData) =>
    new Map(
      (data.journalEntries || [])
        .filter((je) => isDateLocked(previous, je.date))
        .map((je) => [je.id, JSON.stringify(je)]),
    )

  for (const [label, before, after] of [
    ['invoice', lockedInvoices(previous), lockedInvoices(candidate)],
    ['journal entry', lockedJournals(previous), lockedJournals(candidate)],
  ] as const) {
    if (before.size !== after.size) {
      return { ok: false, error: `Cannot add or remove a ${label} in the closed period through ${closedThrough}` }
    }
    for (const [id, serialized] of before) {
      if (after.get(id) !== serialized) {
        return { ok: false, error: `Cannot modify ${label} ${id} in the closed period through ${closedThrough}` }
      }
    }
  }
  return { ok: true }
}

/**
 * Validates a period close through `throughDate`:
 * - the date must be a valid YYYY-MM-DD,
 * - it must be AFTER the existing settings.closedThrough (if any) so periods
 *   close in order,
 * - there must be NO open invoices (not Paid / Cancelled / Draft, with
 *   outstandingAmount > 0) dated at or before the period end.
 */
export function validatePeriodClose(
  data: BooksData,
  throughDate: string,
): { ok: boolean; error?: string } {
  const dateStr = String(throughDate || '').trim()
  if (!isValidIsoDate(dateStr)) {
    return {
      ok: false,
      error: `Invalid period end date: ${throughDate || '(empty)'} (expected YYYY-MM-DD)`,
    }
  }

  const closedThrough = String(data?.settings?.closedThrough || '').trim()
  if (closedThrough && dateStr <= closedThrough) {
    return {
      ok: false,
      error: `Period end date ${dateStr} must be after the already closed period end (${closedThrough})`,
    }
  }

  const openInvoices = (data?.invoices || []).filter((inv) => {
    if (!inv || !inv.date || inv.date > dateStr) return false
    const status = String(inv.status || '').toLowerCase()
    if (status === 'paid' || status === 'cancelled' || status === 'draft') return false
    return round2(Number(inv.outstandingAmount) || 0) > 0
  })

  if (openInvoices.length > 0) {
    const listed = openInvoices
      .map(
        (inv) =>
          `${inv.invoiceNumber} (${inv.partyName}, dated ${inv.date}, ${round2(Number(inv.outstandingAmount) || 0)} outstanding)`,
      )
      .join(', ')
    return {
      ok: false,
      error: `Cannot close period through ${dateStr}: open invoice(s) remain: ${listed}`,
    }
  }

  return { ok: true }
}

/**
 * Builds the balanced year-end close entries posted as of `throughDate`:
 * - `JE-CLOSE-<year>`: Dr each non-group Income account by its balance
 *   (zero balances skipped), Cr retained earnings for the income total.
 * - `JE-CLOSE-<year>-EXP`: Dr retained earnings, Cr each non-group Expense
 *   account by its balance.
 * Uses the STORED (journal-derived) account balances and never mutates the
 * input. When there is nothing to close, the entry is returned with no items
 * and totalDebit === totalCredit === 0.
 */
export function buildClosingEntries(data: BooksData, throughDate: string): JournalEntry[] {
  const dateStr = String(throughDate || '').trim()
  const year = isValidIsoDate(dateStr) ? dateStr.slice(0, 4) : new Date().getFullYear().toString()
  const accounts = Array.isArray(data?.accounts) ? data.accounts : []

  const retained =
    accounts.find((a) => a.id === 'acc-retained') ||
    accounts.find((a) => a.rootType === 'Equity' && !a.isGroup)
  const retainedId = retained?.id || 'acc-retained'
  const retainedName = retained?.name || 'Retained Earnings'

  const closingRemark = (what: string) =>
    `Closing ${what} to retained earnings (period end ${dateStr})`

  // Period-limited balances: only journals dated <= throughDate belong to the
  // period being closed. A mid-period close must never sweep revenue that was
  // posted after throughDate, and a second close of the same year must find
  // income already zeroed by the first close's entries.
  const periodJournals = (Array.isArray(data.journalEntries) ? data.journalEntries : []).filter(
    (je) => je.date <= dateStr,
  )
  const periodBalances = computeAccountBalances(
    Array.isArray(data.accounts) ? data.accounts : [],
    periodJournals,
  )
  const balanceOf = (id: string): number =>
    round2(periodBalances.find((a) => a.id === id)?.balance || 0)

  // Sign-aware close per the account's normal side: a positive income balance
  // is debited away; a contra (negative) income balance is credited toward
  // zero. Retained earnings absorbs the signed net.
  const incomeItems: JournalEntryItem[] = []
  let incomeDr = 0
  let incomeCr = 0
  for (const acc of accounts) {
    if (!acc || acc.isGroup || acc.rootType !== 'Income') continue
    const bal = balanceOf(acc.id)
    if (bal === 0) continue
    // Income is credit-normal: close positive balances with a debit, contra
    // (negative) balances with a credit.
    const debit = round2(bal > 0 ? bal : 0)
    const credit = round2(bal < 0 ? -bal : 0)
    incomeItems.push({
      id: `jei-close-income-${acc.id}`,
      accountId: acc.id,
      accountName: acc.name,
      debit,
      credit,
      remark: closingRemark('income'),
    })
    incomeDr = round2(incomeDr + debit)
    incomeCr = round2(incomeCr + credit)
  }
  const incomeNet = round2(incomeDr - incomeCr)
  if (incomeNet !== 0) {
    incomeItems.push({
      id: `jei-close-income-${retainedId}`,
      accountId: retainedId,
      accountName: retainedName,
      debit: incomeNet > 0 ? 0 : -incomeNet,
      credit: incomeNet > 0 ? incomeNet : 0,
      remark: closingRemark('income'),
    })
  }

  const expenseItems: JournalEntryItem[] = []
  let expenseDr = 0
  let expenseCr = 0
  for (const acc of accounts) {
    if (!acc || acc.isGroup || acc.rootType !== 'Expense') continue
    const bal = balanceOf(acc.id)
    if (bal === 0) continue
    // Expense is debit-normal: close positive balances with a credit, contra
    // (negative) balances with a debit.
    const debit = round2(bal < 0 ? -bal : 0)
    const credit = round2(bal > 0 ? bal : 0)
    expenseItems.push({
      id: `jei-close-expense-${acc.id}`,
      accountId: acc.id,
      accountName: acc.name,
      debit,
      credit,
      remark: closingRemark('expenses'),
    })
    expenseDr = round2(expenseDr + debit)
    expenseCr = round2(expenseCr + credit)
  }
  const expenseNet = round2(expenseDr - expenseCr)
  if (expenseNet !== 0) {
    // Negative net (credits exceed debits) needs MORE debits — retained is
    // debited by the shortfall; a positive net credits retained.
    expenseItems.push({
      id: `jei-close-expense-${retainedId}`,
      accountId: retainedId,
      accountName: retainedName,
      debit: expenseNet < 0 ? -expenseNet : 0,
      credit: expenseNet > 0 ? expenseNet : 0,
      remark: closingRemark('expenses'),
    })
  }

  // Unique per close event: the through-date suffix makes ids and entry
  // numbers distinct across multiple closes of the same year.
  const closeSuffix = dateStr.replace(/-/g, '')
  return [
    {
      id: `je-close-${closeSuffix}`,
      entryNumber: `JE-CLOSE-${year}-${closeSuffix.slice(4)}`,
      date: dateStr,
      items: incomeItems,
      totalDebit: round2(incomeItems.reduce((s, it) => s + it.debit, 0)),
      totalCredit: round2(incomeItems.reduce((s, it) => s + it.credit, 0)),
      remarks: closingRemark('income'),
      posted: true,
    },
    {
      id: `je-close-${closeSuffix}-exp`,
      entryNumber: `JE-CLOSE-${year}-${closeSuffix.slice(4)}-EXP`,
      date: dateStr,
      items: expenseItems,
      totalDebit: round2(expenseItems.reduce((s, it) => s + it.debit, 0)),
      totalCredit: round2(expenseItems.reduce((s, it) => s + it.credit, 0)),
      remarks: closingRemark('expenses'),
      posted: true,
    },
  ]
}

/**
 * Closes the period through `throughDate`: validates the close, prepends the
 * year-end closing entries to the journal, sets settings.closedThrough, and
 * recomputes every account balance from the journals. Pure — returns a NEW
 * BooksData; the caller persists it.
 */
export function closePeriod(
  data: BooksData,
  throughDate: string,
): { ok: boolean; data?: BooksData; error?: string } {
  if (!data || typeof data !== 'object') return { ok: false, error: 'No ledger data' }

  const validation = validatePeriodClose(data, throughDate)
  if (!validation.ok) return { ok: false, error: validation.error }

  const closingEntries = buildClosingEntries(data, throughDate)
  const journalEntries = [
    ...closingEntries,
    ...(Array.isArray(data.journalEntries) ? data.journalEntries : []),
  ]
  const accounts = computeAccountBalances(
    Array.isArray(data.accounts) ? data.accounts : [],
    journalEntries,
  )

  const next: BooksData = {
    ...data,
    settings: {
      ...data.settings,
      closedThrough: String(throughDate || '').trim(),
    },
    accounts,
    journalEntries,
    updatedAt: new Date().toISOString(),
  }
  return { ok: true, data: next }
}

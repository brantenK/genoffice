// Statement of Cash Flows for Zano Books.
// Pure module (no electron / fs imports), like the other shared report
// modules: it computes straight from the journal entries — the module's iron
// rule is that reports derive from journals, never from cached balances.
//
// Classification rule (deliberately simple):
//   For every entry that touches a cash account, the CASH movement is
//   classified by the entry's counterpart legs (its non-cash items):
//   - Income or Expense root            -> Operating
//   - Asset root on a fixed-asset leaf  -> Investing (acc-fixed-asset group)
//   - Equity root                       -> Financing (capital, drawings)
//   - Liability root                    -> Operating (working capital:
//     supplier/customer settlements, VAT and payroll remittances)
//   - Any other Asset root (AR, inventory, VAT input, bank suspense) ->
//     Operating, because those legs clear trade working capital.
//   Liabilities that are loans or other financing would ideally be Financing;
//   keeping them Operating is the documented limit here — a `notes?` field on
//   the journal can later carry a financing hint without changing the rule.
//   An entry whose legs are ALL cash accounts (a bank -> petty-cash transfer)
//   has no counterpart left after the cash legs are excluded, so it is an
//   internal transfer with no flow at all.

import { computeAccountBalances, round2 } from './accounting'
import { localIsoToday } from './dates'
import type { Account, CompanySettings, JournalEntry } from './types'

export type CashFlowCategory = 'operating' | 'investing' | 'financing'

export interface CashFlowStatement {
  /** Period start (YYYY-MM-DD), inclusive. */
  from: string
  /** Period end (YYYY-MM-DD), inclusive. */
  to: string
  /** The cash (bank + petty cash) leaf accounts the statement covers. */
  cashAccountIds: string[]
  /** Cash balance before the period start (journals dated before `from`). */
  opening: number
  operating: number
  investing: number
  financing: number
  /** operating + investing + financing. */
  netChange: number
  /** opening + netChange — must equal the cash accounts' derived balance at `to`. */
  closing: number
  /** In-period entries that moved cash (internal transfers included). */
  cashEntries: number
  /** Entries whose non-cash legs were all cash: bank -> petty cash moves. */
  internalTransfers: number
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** True for a real calendar date in YYYY-MM-DD form (string-safe compare). */
function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false
  const parsed = new Date(s)
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s
}

/**
 * Cash leaves of the chart: the two core ids (`acc-bank`, `acc-cash`) and any
 * Asset-rooted leaf typed Bank or Cash — a second bank account a user adds is
 * cash too. Group accounts never post, so they are excluded.
 */
export function isCashAccount(acc: Account): boolean {
  return (
    Boolean(acc) &&
    !acc.isGroup &&
    acc.rootType === 'Asset' &&
    (acc.id === 'acc-bank' ||
      acc.id === 'acc-cash' ||
      acc.accountType === 'Bank' ||
      acc.accountType === 'Cash')
  )
}

/**
 * True when the account is a fixed-asset leaf: typed `Fixed Asset` itself or
 * sitting under the chart's `acc-fixed-asset` group (possibly through an
 * intermediate group a user created).
 */
export function isFixedAssetAccount(acc: Account, accountsById: Map<string, Account>): boolean {
  let current: Account | undefined = acc
  const visited = new Set<string>()
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    if (current.accountType === 'Fixed Asset') return true
    if (current.id === 'acc-fixed-asset') return true
    current = current.parentId ? accountsById.get(current.parentId) : undefined
  }
  return false
}

/** Category of one counterpart leg, by the rules documented at the top. */
function classifyCounterpart(
  acc: Account | undefined,
  accountsById: Map<string, Account>,
): CashFlowCategory {
  if (!acc) return 'operating'
  switch (acc.rootType) {
    case 'Asset':
      return isFixedAssetAccount(acc, accountsById) ? 'investing' : 'operating'
    case 'Equity':
      return 'financing'
    // Income, Expense and Liability all land in operating: revenue and its
    // costs, and the working-capital settlements (AR/AP, VAT, payroll).
    default:
      return 'operating'
  }
}

/**
 * The period convention the P&L uses: year-to-date from the financial year
 * start to today. `toOverride`/`fromOverride` exist for tests and explicit
 * reports; an invalid or blank `financialYearStart` falls back to 1 January
 * of the period-end year.
 */
function resolvePeriod(
  settings: CompanySettings | undefined,
  fromOverride?: string,
  toOverride?: string,
): { from: string; to: string } {
  const today = localIsoToday()
  const to = isValidIsoDate(toOverride) ? toOverride : today
  const from = isValidIsoDate(fromOverride)
    ? fromOverride
    : isValidIsoDate(settings?.financialYearStart)
      ? settings.financialYearStart
      : `${to.slice(0, 4)}-01-01`
  // A malformed ledger must not produce a reversed period: clamp the start.
  return { from: from > to ? to : from, to }
}

/** Sum of the cash leaves' balances in a derived account array. */
function cashBalanceOf(derived: Account[], cashAccounts: Account[]): number {
  let sum = 0
  for (const acc of cashAccounts) {
    sum = round2(sum + (derived.find((a) => a.id === acc.id)?.balance || 0))
  }
  return round2(sum)
}

/**
 * Builds the Statement of Cash Flows from the journals over the P&L's
 * year-to-date period (or an explicit `period`). Every figure is derived from
 * journal items: opening from journals strictly before the period start, the
 * three category flows from the in-period entries' counterpart legs, and the
 closing as opening + net change. `closing` therefore equals the cash
 accounts' `computeAccountBalances` figure at period end for any balanced
 ledger — that equality is the statement's truth condition and is asserted in
 the tests.
 */
export function computeCashFlowStatement(
  ledger: {
    accounts?: Account[]
    journalEntries?: JournalEntry[]
    settings?: CompanySettings
  },
  period?: { from?: string; to?: string },
): CashFlowStatement {
  const accounts = Array.isArray(ledger.accounts) ? ledger.accounts : []
  const journalEntries = Array.isArray(ledger.journalEntries) ? ledger.journalEntries : []
  const { from, to } = resolvePeriod(ledger.settings, period?.from, period?.to)

  const accountsById = new Map(accounts.map((a) => [a.id, a]))
  const cashAccounts = accounts.filter(isCashAccount)
  const cashIds = new Set(cashAccounts.map((a) => a.id))
  const cashAccountIds = cashAccounts.map((a) => a.id)

  const inPeriod: JournalEntry[] = []
  const beforePeriod: JournalEntry[] = []
  for (const je of journalEntries) {
    if (!je || typeof je.date !== 'string') continue
    if (je.date < from) beforePeriod.push(je)
    else if (je.date <= to) inPeriod.push(je)
  }

  const opening = cashBalanceOf(computeAccountBalances(accounts, beforePeriod), cashAccounts)

  let operating = 0
  let investing = 0
  let financing = 0
  let cashEntries = 0
  let internalTransfers = 0

  for (const je of inPeriod) {
    const items = Array.isArray(je.items) ? je.items : []
    const cashItems = items.filter((it) => it && cashIds.has(it.accountId))
    if (cashItems.length === 0) continue
    cashEntries += 1

    const counterparts = items.filter((it) => it && !cashIds.has(it.accountId))
    const counterpartNet = round2(
      counterparts.reduce((sum, it) => sum + (Number(it.debit) || 0) - (Number(it.credit) || 0), 0),
    )
    if (counterpartNet === 0) {
      // No non-cash legs left (or they net to nil): an internal transfer like
      // bank -> petty cash moves money between cash accounts only, so the
      // combined cash position does not change.
      internalTransfers += 1
      continue
    }

    // A balanced entry's counterpart legs carry exactly the negative of the
    // cash movement, so crediting each category with minus the sum of its
    // counterparts' signed amounts allocates the whole cash flow — a mixed
    // entry splits proportionally and still sums to the cash movement.
    for (const it of counterparts) {
      const signed = round2((Number(it.debit) || 0) - (Number(it.credit) || 0))
      if (signed === 0) continue
      const category = classifyCounterpart(accountsById.get(it.accountId), accountsById)
      const flow = round2(-signed)
      if (category === 'operating') operating = round2(operating + flow)
      else if (category === 'investing') investing = round2(investing + flow)
      else financing = round2(financing + flow)
    }
  }

  const netChange = round2(operating + investing + financing)
  const closing = round2(opening + netChange)

  return {
    from,
    to,
    cashAccountIds,
    opening,
    operating,
    investing,
    financing,
    netChange,
    closing,
    cashEntries,
    internalTransfers,
  }
}

import { describe, expect, it } from 'vitest'
import { EMPTY_ACCOUNTS } from '../src/shared/chart'
import { computeAccountBalances, round2 } from '../src/shared/accounting'
import { computeCashFlowStatement } from '../src/shared/cash-flow'
import type { JournalEntry, JournalEntryItem } from '../src/shared/types'

/**
 * Locks for the Statement of Cash Flows: the categories classify correctly on
 * a realistic ledger, a bank -> petty-cash transfer nets to zero movement,
 * the closing figure equals the cash accounts' journal-derived balance at
 * period end (the statement's truth condition), and the opening figure is
 * taken strictly before the period start.
 */

const PERIOD = { from: '2026-04-01', to: '2026-09-30' }

let itemSeq = 0
function leg(
  accountId: string,
  accountName: string,
  side: 'debit' | 'credit',
  amount: number,
  extra: Partial<JournalEntryItem> = {},
): JournalEntryItem {
  itemSeq += 1
  return {
    id: `jei-cf-${itemSeq}`,
    accountId,
    accountName,
    debit: side === 'debit' ? amount : 0,
    credit: side === 'credit' ? amount : 0,
    ...extra,
  }
}

let entrySeq = 0
function journal(date: string, items: JournalEntryItem[], remarks?: string): JournalEntry {
  entrySeq += 1
  const totalDebit = round2(items.reduce((s, it) => s + it.debit, 0))
  const totalCredit = round2(items.reduce((s, it) => s + it.credit, 0))
  return {
    id: `je-cf-${entrySeq}`,
    entryNumber: `JE-2026-${String(entrySeq).padStart(3, '0')}`,
    date,
    items,
    totalDebit,
    totalCredit,
    remarks,
    posted: true,
  }
}

/**
 * A realistic year: capital injected and an opening float before the year
 * starts, then sales settled into the bank, a bill paid, a machine bought, a
 * bank -> petty-cash float top-up, VAT settled to SARS, owner drawings, rent
 * paid straight from the bank and a mixed receipt (sale + capital top-up).
 * A pre-year receipt and a post-period receipt bracket the period on both
 * sides.
 */
function realisticLedger(): {
  accounts: ReturnType<typeof computeAccountBalances>
  journals: JournalEntry[]
} {
  const journals: JournalEntry[] = [
    journal(
      '2026-02-10',
      [
        leg('acc-bank', 'Business Cheque Account', 'debit', 50000),
        leg('acc-capital', 'Share Capital', 'credit', 50000),
      ],
      'Owner capital injection',
    ),
    journal(
      '2026-02-10',
      [
        leg('acc-cash', 'Petty Cash', 'debit', 500),
        leg('acc-capital', 'Share Capital', 'credit', 500),
      ],
      'Petty cash float',
    ),
    journal(
      '2026-03-25',
      [
        leg('acc-bank', 'Business Cheque Account', 'debit', 1000),
        leg('acc-ar', 'Accounts Receivable (Debtors)', 'credit', 1000),
      ],
      'Customer settlement before the year start',
    ),
    journal(
      '2026-05-05',
      [
        leg('acc-bank', 'Business Cheque Account', 'debit', 11500),
        leg('acc-ar', 'Accounts Receivable (Debtors)', 'credit', 11500, {
          partyName: 'Buyer Co',
        }),
      ],
      'Payment received: Invoice INV-2026-001',
    ),
    journal(
      '2026-05-20',
      [
        leg('acc-ap', 'Accounts Payable (Creditors)', 'debit', 4600, { partyName: 'Timber Co' }),
        leg('acc-bank', 'Business Cheque Account', 'credit', 4600),
      ],
      'Disbursement for Bill BILL-2026-001',
    ),
    journal(
      '2026-06-01',
      [
        leg('acc-equip', 'Office & IT Equipment', 'debit', 8000),
        leg('acc-bank', 'Business Cheque Account', 'credit', 8000),
      ],
      'Purchased a site laptop fleet',
    ),
    journal(
      '2026-06-15',
      [
        leg('acc-cash', 'Petty Cash', 'debit', 2000),
        leg('acc-bank', 'Business Cheque Account', 'credit', 2000),
      ],
      'Bank to petty cash float top-up',
    ),
    journal(
      '2026-07-07',
      [
        leg('acc-vat', 'SARS VAT Output Payable', 'debit', 1234),
        leg('acc-bank', 'Business Cheque Account', 'credit', 1234),
      ],
      'VAT settlement',
    ),
    journal(
      '2026-08-01',
      [
        leg('acc-owner-equity', "Owner's Drawings & Equity", 'debit', 3000),
        leg('acc-bank', 'Business Cheque Account', 'credit', 3000),
      ],
      'Owner drawings',
    ),
    journal(
      '2026-08-15',
      [
        leg('acc-rent', 'Office Rent & Facilities', 'debit', 5000),
        leg('acc-bank', 'Business Cheque Account', 'credit', 5000),
      ],
      'Office rent',
    ),
    journal(
      '2026-09-01',
      [
        leg('acc-bank', 'Business Cheque Account', 'debit', 1000),
        leg('acc-sales', 'Sales', 'credit', 600),
        leg('acc-capital', 'Share Capital', 'credit', 400),
      ],
      'Mixed receipt: cash sale plus a capital top-up',
    ),
    // Dated after the period end: must not move any figure of the statement.
    journal(
      '2026-10-05',
      [
        leg('acc-bank', 'Business Cheque Account', 'debit', 9999),
        leg('acc-sales', 'Sales', 'credit', 9999),
      ],
      'Receipt posted after the period end',
    ),
  ]
  const accounts = computeAccountBalances(EMPTY_ACCOUNTS, journals)
  return { accounts, journals }
}

describe('computeCashFlowStatement', () => {
  it('classifies a realistic ledger into operating / investing / financing', () => {
    const { accounts, journals } = realisticLedger()
    const statement = computeCashFlowStatement(
      { accounts, journalEntries: journals, settings: { financialYearStart: '2026-04-01' } as any },
      PERIOD,
    )

    // Operating: the customer settlement + the mixed cash sale, less the bill,
    // the VAT settlement, the rent and (working capital) nothing else.
    expect(statement.operating).toBe(round2(11500 - 4600 - 1234 - 5000 + 600))
    // Investing: only the fixed-asset purchase.
    expect(statement.investing).toBe(-8000)
    // Financing: drawings out, the mixed capital top-up in.
    expect(statement.financing).toBe(round2(-3000 + 400))
    expect(statement.netChange).toBe(
      round2(statement.operating + statement.investing + statement.financing),
    )
    expect(statement.cashEntries).toBe(8)
    expect(statement.internalTransfers).toBe(1)
    expect(statement.cashAccountIds.sort()).toEqual(['acc-bank', 'acc-cash'])
  })

  it('respects the opening balance taken strictly before the period start', () => {
    const { accounts, journals } = realisticLedger()
    const statement = computeCashFlowStatement({ accounts, journalEntries: journals }, PERIOD)

    // The 2026-02-10 capital injections and the 2026-03-25 settlement are the
    // only cash movements before 2026-04-01.
    expect(statement.opening).toBe(round2(50000 + 500 + 1000))
    // The in-period net change reconciles opening to closing.
    expect(statement.closing).toBe(round2(statement.opening + statement.netChange))
  })

  it('closing equals the cash accounts derived balance at period end', () => {
    const { accounts, journals } = realisticLedger()
    const statement = computeCashFlowStatement({ accounts, journalEntries: journals }, PERIOD)

    const inPeriodJournals = journals.filter((je) => je.date <= PERIOD.to)
    const derivedAtEnd = computeAccountBalances(EMPTY_ACCOUNTS, inPeriodJournals)
    const derivedCash = round2(
      derivedAtEnd
        .filter((a) => statement.cashAccountIds.includes(a.id))
        .reduce((s, a) => s + a.balance, 0),
    )
    expect(statement.closing).toBe(derivedCash)
    expect(derivedCash).toBe(42166)

    // With no future-dated entries the statement also agrees with the store's
    // all-journals derivation — the balances the rest of the module displays.
    const noFuture = journals.filter((je) => je.date <= PERIOD.to)
    const allDerived = computeAccountBalances(EMPTY_ACCOUNTS, noFuture)
    const allCash = round2(
      allDerived
        .filter((a) => statement.cashAccountIds.includes(a.id))
        .reduce((s, a) => s + a.balance, 0),
    )
    const statementAll = computeCashFlowStatement(
      { accounts: EMPTY_ACCOUNTS, journalEntries: noFuture },
      PERIOD,
    )
    expect(statementAll.closing).toBe(allCash)
  })

  it('nets a bank -> petty-cash transfer to zero movement', () => {
    const transfer = journal(
      '2026-06-15',
      [
        leg('acc-cash', 'Petty Cash', 'debit', 2000),
        leg('acc-bank', 'Business Cheque Account', 'credit', 2000),
      ],
      'Bank to petty cash',
    )
    const accounts = computeAccountBalances(EMPTY_ACCOUNTS, [transfer])
    const statement = computeCashFlowStatement({ accounts, journalEntries: [transfer] }, PERIOD)

    expect(statement.internalTransfers).toBe(1)
    expect(statement.cashEntries).toBe(1)
    expect(statement.operating).toBe(0)
    expect(statement.investing).toBe(0)
    expect(statement.financing).toBe(0)
    expect(statement.netChange).toBe(0)
    expect(statement.opening).toBe(0)
    expect(statement.closing).toBe(0)
  })

  it('respects a pre-period opening even when the period has no movements', () => {
    const opening = journal(
      '2026-02-10',
      [
        leg('acc-bank', 'Business Cheque Account', 'debit', 12000),
        leg('acc-capital', 'Share Capital', 'credit', 12000),
      ],
      'Opening balances',
    )
    const accounts = computeAccountBalances(EMPTY_ACCOUNTS, [opening])
    const statement = computeCashFlowStatement({ accounts, journalEntries: [opening] }, PERIOD)
    expect(statement.opening).toBe(12000)
    expect(statement.netChange).toBe(0)
    expect(statement.closing).toBe(12000)
  })

  it('defaults the period to the P&L convention: financial year start to today', () => {
    const { accounts, journals } = realisticLedger()
    // The settings' financial year start is the P&L's "Year-to-Date" scope;
    // an explicit `to` keeps the test deterministic.
    const statement = computeCashFlowStatement(
      { accounts, journalEntries: journals, settings: { financialYearStart: '2026-03-01' } as any },
      { to: PERIOD.to },
    )
    expect(statement.from).toBe('2026-03-01')
    expect(statement.to).toBe(PERIOD.to)
    // The 2026-02-10 journals are before the financial year start now.
    expect(statement.opening).toBe(round2(50000 + 500))
    // An invalid year start falls back to 1 January of the period-end year.
    const fallback = computeCashFlowStatement(
      { accounts, journalEntries: journals, settings: { financialYearStart: 'not-a-date' } as any },
      { to: PERIOD.to },
    )
    expect(fallback.from).toBe('2026-01-01')
    // A reversed period is clamped so the statement can never go backwards.
    const clamped = computeCashFlowStatement(
      { accounts, journalEntries: journals },
      { from: '2027-01-01', to: PERIOD.to },
    )
    expect(clamped.from).toBe(PERIOD.to)
    expect(clamped.netChange).toBe(0)
  })

  it('treats every Asset-rooted Bank/Cash leaf as cash and reports its ids', () => {
    const savings = {
      ...EMPTY_ACCOUNTS[0],
      id: 'acc-savings',
      name: 'Savings Account',
      accountType: 'Bank' as const,
      parentId: 'acc-curr-asset',
      isGroup: false,
    }
    const deposit = journal(
      '2026-05-05',
      [
        leg('acc-savings', 'Savings Account', 'debit', 700),
        leg('acc-sales', 'Sales', 'credit', 700),
      ],
      'Deposit into a second bank account',
    )
    const accounts = computeAccountBalances([...EMPTY_ACCOUNTS, savings], [deposit])
    const statement = computeCashFlowStatement({ accounts, journalEntries: [deposit] }, PERIOD)
    expect(statement.cashAccountIds).toContain('acc-savings')
    expect(statement.operating).toBe(700)
    // Groups and non-cash accounts never count as cash.
    expect(statement.cashAccountIds).not.toContain('acc-curr-asset')
    expect(statement.cashAccountIds).not.toContain('acc-ar')
  })
})

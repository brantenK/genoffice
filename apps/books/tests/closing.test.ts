import { describe, expect, it } from 'vitest'
import { accountsMatchJournals, allJournalsBalanced, computeAccountBalances, round2 } from '../src/shared/accounting'
import { EMPTY_ACCOUNTS } from '../src/shared/chart'
import {
  buildClosingEntries,
  closePeriod,
  isDateLocked,
  validatePeriodClose,
} from '../src/shared/closing'
import { initialBooksData } from '../src/renderer/src/mock/initialData'
import { useBooksStore } from '../src/renderer/src/store'
import type { BooksData } from '../src/shared/types'

const seed = (): BooksData => JSON.parse(JSON.stringify(initialBooksData))

const settleAllInvoices = (data: BooksData): BooksData => {
  for (const inv of data.invoices) {
    inv.status = 'Paid'
    inv.outstandingAmount = 0
  }
  return data
}

describe('isDateLocked', () => {
  it('locks dates at or before closedThrough and unlocks dates after it', () => {
    const data = seed()
    data.settings.closedThrough = '2026-09-30'
    // Equal to the closed-through date is locked.
    expect(isDateLocked(data, '2026-09-30')).toBe(true)
    // Before it is locked.
    expect(isDateLocked(data, '2026-08-15')).toBe(true)
    expect(isDateLocked(data, '2026-09-29')).toBe(true)
    expect(isDateLocked(data, '2026-01-01')).toBe(true)
    // After it is unlocked.
    expect(isDateLocked(data, '2026-10-01')).toBe(false)
    expect(isDateLocked(data, '2027-03-31')).toBe(false)
  })

  it('returns false when no closedThrough is set', () => {
    const data = seed()
    expect(data.settings.closedThrough).toBeUndefined()
    expect(isDateLocked(data, '2026-09-30')).toBe(false)
    expect(isDateLocked(data, '2027-01-01')).toBe(false)
  })

  it('returns false for empty or invalid dates', () => {
    const data = seed()
    data.settings.closedThrough = '2026-09-30'
    expect(isDateLocked(data, '')).toBe(false)
    expect(isDateLocked(data, 'not-a-date')).toBe(false)
    expect(isDateLocked(data, '09/30/2026')).toBe(false)
    expect(isDateLocked(data, '2026-2-3')).toBe(false)
    expect(isDateLocked(data, '2026-13-01')).toBe(false)
    expect(isDateLocked(data, '2026-02-30')).toBe(false)
    expect(isDateLocked(data, '2026-09-31')).toBe(false)
  })
})

describe('validatePeriodClose', () => {
  it('rejects an invalid period end date', () => {
    expect(validatePeriodClose(seed(), '2026-09-31').ok).toBe(false)
    const bad = validatePeriodClose(seed(), 'Sept 30 2026')
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('YYYY-MM-DD')
    expect(validatePeriodClose(seed(), '').ok).toBe(false)
    expect(validatePeriodClose(seed(), '2026-02-30').ok).toBe(false)
    expect(validatePeriodClose(seed(), '2026-9-3').ok).toBe(false)
  })

  it('rejects closing before or equal to the existing closedThrough', () => {
    const data = seed()
    settleAllInvoices(data)
    data.settings.closedThrough = '2026-09-30'
    // Equal to the already closed period end is rejected.
    const equal = validatePeriodClose(data, '2026-09-30')
    expect(equal.ok).toBe(false)
    expect(equal.error).toContain('2026-09-30')
    // Earlier is rejected too — periods must close in order.
    const before = validatePeriodClose(data, '2026-09-29')
    expect(before.ok).toBe(false)
    expect(before.error).toContain('2026-09-30')
    // A later period is fine.
    expect(validatePeriodClose(data, '2026-10-31')).toEqual({ ok: true })
  })

  it('rejects when open invoices are dated at or before the period end and lists them', () => {
    const data = seed()
    const res = validatePeriodClose(data, '2026-09-30')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('INV-2026-001')
    expect(res.error).toContain('INV-2026-002')
    expect(res.error).toContain('BILL-2026-001')
    // The blocking amounts are part of the description.
    expect(res.error).toContain('145000')
    expect(res.error).toContain('50500')
    expect(res.error).toContain('42000')
    // Fully paid seed invoices do not block.
    expect(res.error).not.toContain('INV-2026-003')
    expect(res.error).not.toContain('BILL-2026-002')
    // Invoices dated after the period end belong to the next period.
    const data2 = seed()
    for (const inv of data2.invoices) {
      inv.status = 'Paid'
      inv.outstandingAmount = 0
    }
    data2.invoices[0].status = 'Unpaid'
    data2.invoices[0].outstandingAmount = 999
    data2.invoices[0].date = '2026-12-15'
    expect(validatePeriodClose(data2, '2026-09-30')).toEqual({ ok: true })
  })

  it('accepts a clean close when no open invoices remain in the period', () => {
    const data = settleAllInvoices(seed())
    expect(validatePeriodClose(data, '2026-09-30')).toEqual({ ok: true })
    // Draft invoices never block a close, even with an outstanding amount.
    const data2 = settleAllInvoices(seed())
    data2.invoices[0].status = 'Draft'
    data2.invoices[0].outstandingAmount = 145000
    expect(validatePeriodClose(data2, '2026-09-30')).toEqual({ ok: true })
  })
})

describe('buildClosingEntries', () => {
  it('builds two balanced entries: income Dr to retained Cr, expenses Cr from retained Dr', () => {
    const data = seed()
    const [incomeEntry, expenseEntry] = buildClosingEntries(data, '2026-09-30')

    expect(incomeEntry.entryNumber).toBe('JE-CLOSE-2026-0930')
    expect(expenseEntry.entryNumber).toBe('JE-CLOSE-2026-0930-EXP')
    expect(incomeEntry.date).toBe('2026-09-30')
    expect(expenseEntry.date).toBe('2026-09-30')
    expect(incomeEntry.posted).toBe(true)
    expect(expenseEntry.posted).toBe(true)
    expect(incomeEntry.remarks).toBe('Closing income to retained earnings (period end 2026-09-30)')
    expect(expenseEntry.remarks).toBe(
      'Closing expenses to retained earnings (period end 2026-09-30)',
    )
    expect(allJournalsBalanced([incomeEntry, expenseEntry])).toBe(true)

    // Income entry uses the STORED (journal-derived) balances: Dr each
    // non-group income account, Cr retained earnings for the total.
    const salesItem = incomeEntry.items.find((i) => i.accountId === 'acc-sales')!
    const consultItem = incomeEntry.items.find((i) => i.accountId === 'acc-consult')!
    const retainedCredit = incomeEntry.items.find((i) => i.accountId === 'acc-retained')!
    expect(salesItem.debit).toBe(820000)
    expect(salesItem.credit).toBe(0)
    expect(salesItem.accountName).toBe('Tender & Commercial Contracting Sales')
    expect(consultItem.debit).toBe(235000)
    expect(consultItem.credit).toBe(0)
    expect(retainedCredit.debit).toBe(0)
    expect(retainedCredit.credit).toBe(1055000)
    expect(incomeEntry.totalDebit).toBe(1055000)
    expect(incomeEntry.totalCredit).toBe(1055000)

    // Expense entry: Dr retained earnings, Cr each non-group expense account.
    const retainedDebit = expenseEntry.items.find((i) => i.accountId === 'acc-retained')!
    expect(retainedDebit.debit).toBe(818000)
    expect(retainedDebit.credit).toBe(0)
    const expenseCredits = expenseEntry.items
      .filter((i) => i.accountId !== 'acc-retained')
      .map((i) => i.credit)
    expect(expenseCredits).toEqual([345000, 380000, 65000, 28000])
    expect(expenseEntry.totalDebit).toBe(818000)
    expect(expenseEntry.totalCredit).toBe(818000)
  })

  it('skips zero-balance accounts and never posts to group accounts', () => {
    const data = seed()
    const [incomeEntry, expenseEntry] = buildClosingEntries(data, '2026-09-30')

    // Zero-balance seed accounts (utilities, depreciation, interest) are skipped.
    for (const id of ['acc-utilities', 'acc-deprec', 'acc-interest-income']) {
      expect(incomeEntry.items.some((i) => i.accountId === id)).toBe(false)
      expect(expenseEntry.items.some((i) => i.accountId === id)).toBe(false)
    }
    // Leaf-only: group accounts never receive close items.
    for (const id of ['acc-income', 'acc-expense']) {
      expect(incomeEntry.items.some((i) => i.accountId === id)).toBe(false)
      expect(expenseEntry.items.some((i) => i.accountId === id)).toBe(false)
    }
  })

  it('returns empty balanced entries when income and expense balances are zero', () => {
    const data = seed()
    data.accounts = EMPTY_ACCOUNTS
    data.journalEntries = []
    const [incomeEntry, expenseEntry] = buildClosingEntries(data, '2026-09-30')
    expect(incomeEntry.items).toHaveLength(0)
    expect(expenseEntry.items).toHaveLength(0)
    expect(incomeEntry.totalDebit).toBe(0)
    expect(incomeEntry.totalCredit).toBe(0)
    expect(expenseEntry.totalDebit).toBe(0)
    expect(expenseEntry.totalCredit).toBe(0)
    expect(allJournalsBalanced([incomeEntry, expenseEntry])).toBe(true)
  })

  it('never mutates the input data', () => {
    const data = seed()
    const accountsBefore = JSON.stringify(data.accounts)
    const journalsBefore = JSON.stringify(data.journalEntries)
    const settingsBefore = JSON.stringify(data.settings)
    buildClosingEntries(data, '2026-09-30')
    expect(JSON.stringify(data.accounts)).toBe(accountsBefore)
    expect(JSON.stringify(data.journalEntries)).toBe(journalsBefore)
    expect(JSON.stringify(data.settings)).toBe(settingsBefore)
  })
})

describe('closePeriod', () => {
  it('rejects a close while seed invoices are still open', () => {
    const res = closePeriod(seed(), '2026-09-30')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('INV-2026-001')
    expect(res.error).toContain('INV-2026-002')
    expect(res.error).toContain('BILL-2026-001')
    expect(res.data).toBeUndefined()
  })

  it('closes through 2026-09-30 after invoices are settled: zeroes income, retained grows by net profit', () => {
    const data = settleAllInvoices(seed())
    const incomeBefore = data.accounts
      .filter((a) => a.rootType === 'Income' && !a.isGroup)
      .reduce((sum, a) => round2(sum + a.balance), 0)
    const expenseBefore = data.accounts
      .filter((a) => a.rootType === 'Expense' && !a.isGroup)
      .reduce((sum, a) => round2(sum + a.balance), 0)
    const retainedBefore = data.accounts.find((a) => a.id === 'acc-retained')!.balance

    const res = closePeriod(data, '2026-09-30')
    expect(res.ok).toBe(true)
    const closed = res.data!
    expect(closed.settings.closedThrough).toBe('2026-09-30')
    expect(allJournalsBalanced(closed.journalEntries)).toBe(true)
    expect(accountsMatchJournals(closed.accounts, closed.journalEntries)).toBe(true)

    // Closing entries were prepended.
    expect(closed.journalEntries.slice(0, 2).map((je) => je.entryNumber)).toEqual([
      'JE-CLOSE-2026-0930',
      'JE-CLOSE-2026-0930-EXP',
    ])
    expect(closed.journalEntries.length).toBe(data.journalEntries.length + 2)

    // Income accounts are reduced by their full balances (closed to zero).
    expect(closed.accounts.find((a) => a.id === 'acc-sales')!.balance).toBe(0)
    expect(closed.accounts.find((a) => a.id === 'acc-consult')!.balance).toBe(0)
    // Expense accounts are closed to zero as well.
    expect(closed.accounts.find((a) => a.id === 'acc-materials')!.balance).toBe(0)
    expect(closed.accounts.find((a) => a.id === 'acc-travel')!.balance).toBe(0)
    // Retained earnings grows by exactly net profit (income total - expense total).
    const netProfit = round2(incomeBefore - expenseBefore)
    expect(closed.accounts.find((a) => a.id === 'acc-retained')!.balance).toBe(
      round2(retainedBefore + netProfit),
    )
    // Balance-sheet accounts are untouched by the close.
    expect(closed.accounts.find((a) => a.id === 'acc-bank')!.balance).toBe(
      data.accounts.find((a) => a.id === 'acc-bank')!.balance,
    )
    expect(closed.accounts.find((a) => a.id === 'acc-ar')!.balance).toBe(
      data.accounts.find((a) => a.id === 'acc-ar')!.balance,
    )
    // The input data itself is not mutated.
    expect(data.settings.closedThrough).toBeUndefined()
  })

  it('supports a later period close and rejects closing an earlier period again', () => {
    const data = settleAllInvoices(seed())
    const first = closePeriod(data, '2026-09-30')
    expect(first.ok).toBe(true)

    // A second close further out works: income/expense are already zero, so
    // the 2027 closing entries are empty but still balanced.
    const second = closePeriod(first.data!, '2027-03-31')
    expect(second.ok).toBe(true)
    expect(second.data!.settings.closedThrough).toBe('2027-03-31')
    expect(allJournalsBalanced(second.data!.journalEntries)).toBe(true)
    expect(accountsMatchJournals(second.data!.accounts, second.data!.journalEntries)).toBe(true)
    const close2027 = second.data!.journalEntries.slice(0, 2)
    expect(close2027.map((je) => je.entryNumber)).toEqual(['JE-CLOSE-2027-0331', 'JE-CLOSE-2027-0331-EXP'])
    expect(close2027[0].items).toHaveLength(0)
    expect(close2027[1].items).toHaveLength(0)
    expect(close2027[0].totalDebit).toBe(0)
    expect(close2027[0].totalCredit).toBe(0)
    // Retained earnings is unchanged by the empty second close.
    expect(second.data!.accounts.find((a) => a.id === 'acc-retained')!.balance).toBe(
      first.data!.accounts.find((a) => a.id === 'acc-retained')!.balance,
    )

    // Periods must close in order: a retro close is rejected.
    const retro = closePeriod(second.data!, '2026-08-01')
    expect(retro.ok).toBe(false)
    expect(retro.error).toContain('2027-03-31')
  })

  describe('Store integration: closeFinancialYear + closed-period lock', () => {
    const readySeed = () => {
      const data = seed()
      // Close requires all invoices <= throughDate to be paid/cancelled.
      data.invoices = data.invoices.map((inv) => ({ ...inv, status: 'Paid', outstandingAmount: 0 }))
      return data
    }

    it('closeFinancialYear persists the close, audits it, and keeps invariants', async () => {
      useBooksStore.setState({ data: readySeed() })
      const res = await useBooksStore.getState().closeFinancialYear('2026-09-30')
      expect(res.ok).toBe(true)
      const d = useBooksStore.getState().data
      expect(d.settings.closedThrough).toBe('2026-09-30')
      expect(d.auditLog?.[0]?.action).toBe('period.close')
      expect(allJournalsBalanced(d.journalEntries)).toBe(true)
      expect(accountsMatchJournals(d.accounts, d.journalEntries)).toBe(true)
      // Income closed to retained earnings: net profit = 1,055,000 - 818,000.
      expect(d.accounts.find((a) => a.id === 'acc-retained')!.balance).toBe(round2(571150 + 237000))
    })

    it('rejects a close while open invoices exist in the period', async () => {
      useBooksStore.setState({ data: seed() })
      const res = await useBooksStore.getState().closeFinancialYear('2026-09-30')
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/open invoice/i)
      expect(useBooksStore.getState().data.settings.closedThrough).toBeUndefined()
    })

    it('blocks posting invoices into the locked period but allows later dates and drafts', async () => {
      useBooksStore.setState({ data: readySeed() })
      const closed = await useBooksStore.getState().closeFinancialYear('2026-09-30')
      expect(closed.ok).toBe(true)

      const store = useBooksStore.getState()
      const invoiceCount = store.data.invoices.length

      // Unpaid invoice dated inside the locked period: no-op, nothing posted.
      await store.saveInvoice({
        type: 'Sales',
        partyName: 'Locked Period Co',
        date: '2026-08-15',
        dueDate: '2026-09-15',
        status: 'Unpaid',
        items: [{ id: 'it-1', description: 'Late', qty: 1, rate: 5000, taxRate: 15, amount: 5000 }],
      })
      const afterLocked = useBooksStore.getState().data
      expect(afterLocked.invoices.length).toBe(invoiceCount)

      // Draft dated inside the locked period: allowed (cannot post).
      await store.saveInvoice({
        type: 'Sales',
        partyName: 'Locked Period Co',
        date: '2026-08-15',
        status: 'Draft',
        items: [
          { id: 'it-1', description: 'Draft late', qty: 1, rate: 5000, taxRate: 15, amount: 5000 },
        ],
      })
      const afterDraft = useBooksStore.getState().data
      expect(afterDraft.invoices.length).toBe(invoiceCount + 1)
      expect(afterDraft.invoices[0].status).toBe('Draft')

      // Invoice dated AFTER the locked period: normal posting.
      await useBooksStore.getState().saveInvoice({
        type: 'Sales',
        partyName: 'Locked Period Co',
        date: '2026-10-15',
        dueDate: '2026-11-15',
        status: 'Unpaid',
        items: [
          { id: 'it-1', description: 'New period', qty: 1, rate: 5000, taxRate: 15, amount: 5000 },
        ],
      })
      const afterOpen = useBooksStore.getState().data
      expect(afterOpen.invoices.length).toBe(invoiceCount + 2)
      expect(accountsMatchJournals(afterOpen.accounts, afterOpen.journalEntries)).toBe(true)
    })
  })

  describe('Review fixes: loss periods and mid-period closes', () => {
    it('closes a LOSS period correctly (expenses > income): retained is net-debited', () => {
      const data = settleAllInvoices(seed())
      // Add an expense-only bill to push expenses above income.
      data.invoices.push({
        id: 'bill-loss',
        invoiceNumber: 'BILL-2026-050',
        type: 'Purchase',
        partyId: 'party-4',
        partyName: 'Safintra Steel & Building Materials',
        date: '2026-09-20',
        dueDate: '2026-10-20',
        items: [{ id: 'i1', itemCode: 'A', description: 'Extra', accountId: 'acc-materials', accountName: 'Materials', qty: 1, rate: 400000, taxRate: 0, amount: 400000 }],
        subtotal: 400000,
        taxTotal: 0,
        grandTotal: 400000,
        outstandingAmount: 0,
        status: 'Paid',
        createdAt: '',
        updatedAt: '',
      })
      const expenseBefore = data.accounts
        .filter((a) => a.rootType === 'Expense' && !a.isGroup)
        .reduce((sum, a) => round2(sum + a.balance), 0)
      const incomeBefore = data.accounts
        .filter((a) => a.rootType === 'Income' && !a.isGroup)
        .reduce((sum, a) => round2(sum + a.balance), 0)
      const retainedBefore = data.accounts.find((a) => a.id === 'acc-retained')!.balance

      const res = closePeriod(data, '2026-09-30')
      expect(res.ok).toBe(true)
      const closed = res.data!
      expect(allJournalsBalanced(closed.journalEntries)).toBe(true)
      expect(accountsMatchJournals(closed.accounts, closed.journalEntries)).toBe(true)
      // Loss: retained decreases by (expenses - income).
      const loss = round2(expenseBefore - incomeBefore)
      expect(closed.accounts.find((a) => a.id === 'acc-retained')!.balance).toBe(
        round2(retainedBefore - loss),
      )
      // Income and expense accounts are still closed to zero.
      expect(closed.accounts.filter((a) => a.rootType === 'Income' && !a.isGroup).every((a) => a.balance === 0)).toBe(true)
      expect(closed.accounts.filter((a) => a.rootType === 'Expense' && !a.isGroup).every((a) => a.balance === 0)).toBe(true)
    })

    it('a mid-period close does NOT sweep income posted after throughDate', () => {
      const data = settleAllInvoices(seed())
      // Post an invoice dated AFTER the close date (2026-11-15 > 2026-09-30).
      data.invoices.push({
        id: 'inv-late',
        invoiceNumber: 'INV-2026-050',
        type: 'Sales',
        partyId: 'party-1',
        partyName: 'City of Ekurhuleni Water Dept',
        date: '2026-11-15',
        dueDate: '2026-12-15',
        items: [{ id: 'i1', itemCode: 'A', description: 'Late', accountId: 'acc-sales', accountName: 'Sales', qty: 1, rate: 100000, taxRate: 0, amount: 100000 }],
        subtotal: 100000,
        taxTotal: 0,
        grandTotal: 100000,
        outstandingAmount: 0,
        status: 'Paid',
        createdAt: '',
        updatedAt: '',
      })
      // Its posting journal is dated 2026-11-15 — outside the close window.
      data.journalEntries.unshift({
        id: 'je-late',
        entryNumber: 'JE-2026-050',
        date: '2026-11-15',
        items: [
          { id: 'i1', accountId: 'acc-ar', accountName: 'AR', debit: 100000, credit: 0 },
          { id: 'i2', accountId: 'acc-sales', accountName: 'Sales', debit: 0, credit: 100000 },
        ],
        totalDebit: 100000,
        totalCredit: 100000,
        remarks: 'Late invoice posting',
        posted: true,
      })
      data.accounts = computeAccountBalances(data.accounts, data.journalEntries)

      const res = closePeriod(data, '2026-09-30')
      expect(res.ok).toBe(true)
      const closed = res.data!
      // The 100,000 dated 2026-11-15 stays in acc-sales — NOT swept into the
      // September close (which swept the 1,055,000 attributable to <= 09-30).
      expect(closed.accounts.find((a) => a.id === 'acc-sales')!.balance).toBe(100000)
      expect(accountsMatchJournals(closed.accounts, closed.journalEntries)).toBe(true)
      // Closing again through 2027-03-31 sweeps the late revenue correctly.
      const second = closePeriod(closed, '2027-03-31')
      expect(second.ok).toBe(true)
      expect(second.data!.accounts.find((a) => a.id === 'acc-sales')!.balance).toBe(0)
      expect(accountsMatchJournals(second.data!.accounts, second.data!.journalEntries)).toBe(true)
    })
  })
})
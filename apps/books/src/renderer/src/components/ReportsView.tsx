import React from 'react'
import { FileSpreadsheet, TrendingUp, Scale, BookOpen, CheckSquare } from 'lucide-react'
import { useBooksStore } from '../store'
import type { ReportType } from '../../../shared/types'

export function ReportsView() {
  const { data, activeReport, setActiveReport } = useBooksStore()
  const { accounts, settings, journalEntries, invoices } = data

  const formatMoney = (val: number) => {
    return `${settings.currencySymbol} ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  // --- 1. P&L CALCULATIONS ---
  const incomeAccounts = accounts.filter((a) => a.rootType === 'Income' && !a.isGroup)
  const totalIncome = incomeAccounts.reduce((sum, a) => sum + a.balance, 0)

  const expenseAccounts = accounts.filter((a) => a.rootType === 'Expense' && !a.isGroup)
  const totalExpense = expenseAccounts.reduce((sum, a) => sum + a.balance, 0)
  const netProfit = totalIncome - totalExpense

  // --- 2. BALANCE SHEET CALCULATIONS ---
  const assetAccounts = accounts.filter((a) => a.rootType === 'Asset' && !a.isGroup)
  const totalAssets = assetAccounts.reduce((sum, a) => sum + a.balance, 0)

  const liabilityAccounts = accounts.filter((a) => a.rootType === 'Liability' && !a.isGroup)
  const totalLiabilities = liabilityAccounts.reduce((sum, a) => sum + a.balance, 0)

  const equityAccounts = accounts.filter((a) => a.rootType === 'Equity' && !a.isGroup)
  const totalEquity = equityAccounts.reduce((sum, a) => sum + a.balance, 0) + netProfit

  // --- EXPORT TO SHEETS ---
  const handleExportToSheets = () => {
    let reportTitle = 'Financial_Report'
    let csv = ''

    if (activeReport === 'profit-loss') {
      reportTitle = 'Profit_and_Loss_Statement'
      csv = `Statement,Account Name,Amount (${settings.currency})\n`
      csv += 'INCOME\n'
      incomeAccounts.forEach((a) => {
        csv += `Income,"${a.name}",${a.balance.toFixed(2)}\n`
      })
      csv += `Total Income,,${totalIncome.toFixed(2)}\n\n`
      csv += 'EXPENSES\n'
      expenseAccounts.forEach((a) => {
        csv += `Expense,"${a.name}",${a.balance.toFixed(2)}\n`
      })
      csv += `Total Expenses,,${totalExpense.toFixed(2)}\n\n`
      csv += `NET PROFIT / (LOSS),,${netProfit.toFixed(2)}\n`
    } else if (activeReport === 'balance-sheet') {
      reportTitle = 'Balance_Sheet'
      csv = `Category,Account Name,Amount (${settings.currency})\n`
      csv += 'ASSETS\n'
      assetAccounts.forEach((a) => {
        csv += `Asset,"${a.name}",${a.balance.toFixed(2)}\n`
      })
      csv += `Total Assets,,${totalAssets.toFixed(2)}\n\n`
      csv += 'LIABILITIES\n'
      liabilityAccounts.forEach((a) => {
        csv += `Liability,"${a.name}",${a.balance.toFixed(2)}\n`
      })
      csv += `Total Liabilities,,${totalLiabilities.toFixed(2)}\n\n`
      csv += 'EQUITY\n'
      equityAccounts.forEach((a) => {
        csv += `Equity,"${a.name}",${a.balance.toFixed(2)}\n`
      })
      csv += `Retained Profit / Current Period,,${netProfit.toFixed(2)}\n`
      csv += `Total Equity & Liabilities,,${(totalLiabilities + totalEquity).toFixed(2)}\n`
    } else if (activeReport === 'trial-balance') {
      reportTitle = 'Trial_Balance'
      csv = `Account Name,Root Type,Debit (${settings.currency}),Credit (${settings.currency})\n`
      let totalDr = 0
      let totalCr = 0
      accounts.filter((a) => !a.isGroup).forEach((a) => {
        const isDebit = a.rootType === 'Asset' || a.rootType === 'Expense'
        const dr = isDebit ? a.balance : 0
        const cr = !isDebit ? a.balance : 0
        totalDr += dr
        totalCr += cr
        csv += `"${a.name}","${a.rootType}",${dr.toFixed(2)},${cr.toFixed(2)}\n`
      })
      csv += `TOTAL,,${totalDr.toFixed(2)},${totalCr.toFixed(2)}\n`
    } else {
      reportTitle = 'General_Ledger'
      csv = `Date,Entry Number,Account,Debit,Credit,Remark\n`
      journalEntries.forEach((je) => {
        je.items.forEach((it) => {
          csv += `"${je.date}","${je.entryNumber}","${it.accountName}",${it.debit.toFixed(2)},${it.credit.toFixed(2)},"${it.remark || ''}"\n`
        })
      })
    }

    if (window.booksApi?.exportToSheets) {
      window.booksApi.exportToSheets(reportTitle, csv)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Top Header */}
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#EDEDED]">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B] tracking-tight">Financial Reports</h1>
          <p className="text-sm text-[#7C7C7C] mt-0.5">
            Standard GAAP compliant statements for {settings.companyName}
          </p>
        </div>

        <button
          onClick={handleExportToSheets}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-[#10B981] hover:bg-[#059669] shadow-xs transition-colors"
        >
          <FileSpreadsheet className="w-4 h-4" />
          Export to Zanostack Sheets
        </button>
      </div>

      {/* Report Selector Pills */}
      <div className="flex items-center gap-2 mb-8 bg-white p-1.5 rounded-xl border border-[#EDEDED] shadow-xs w-fit">
        <button
          onClick={() => setActiveReport('profit-loss')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
            activeReport === 'profit-loss'
              ? 'bg-[#1E293B] text-white'
              : 'text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3]'
          }`}
        >
          <TrendingUp className="w-3.5 h-3.5" />
          Profit and Loss
        </button>

        <button
          onClick={() => setActiveReport('balance-sheet')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
            activeReport === 'balance-sheet'
              ? 'bg-[#1E293B] text-white'
              : 'text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3]'
          }`}
        >
          <Scale className="w-3.5 h-3.5" />
          Balance Sheet
        </button>

        <button
          onClick={() => setActiveReport('trial-balance')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
            activeReport === 'trial-balance'
              ? 'bg-[#1E293B] text-white'
              : 'text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3]'
          }`}
        >
          <CheckSquare className="w-3.5 h-3.5" />
          Trial Balance
        </button>

        <button
          onClick={() => setActiveReport('general-ledger')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
            activeReport === 'general-ledger'
              ? 'bg-[#1E293B] text-white'
              : 'text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3]'
          }`}
        >
          <BookOpen className="w-3.5 h-3.5" />
          General Ledger
        </button>
      </div>

      {/* --- REPORT 1: PROFIT AND LOSS --- */}
      {activeReport === 'profit-loss' && (
        <div className="bg-white rounded-xl border border-[#EDEDED] p-8 shadow-xs max-w-4xl">
          <div className="text-center pb-6 border-b border-[#EDEDED] mb-6">
            <h2 className="text-lg font-bold text-[#1E293B]">{settings.companyName}</h2>
            <p className="text-xs text-[#7C7C7C] font-semibold mt-1 uppercase tracking-wider">
              Statement of Profit and Loss
            </p>
            <p className="text-xs text-[#7C7C7C] mt-0.5">Year-to-Date Financial Assessment</p>
          </div>

          {/* Income Section */}
          <div className="mb-6">
            <div className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">Income</div>
            <div className="divide-y divide-[#EDEDED] border-t border-[#EDEDED]">
              {incomeAccounts.map((acc) => (
                <div key={acc.id} className="py-2.5 flex justify-between text-xs">
                  <span className="text-[#525252] pl-4">{acc.name}</span>
                  <span className="font-mono text-[#1E293B]">{formatMoney(acc.balance)}</span>
                </div>
              ))}
              <div className="py-2.5 flex justify-between text-xs font-bold text-[#1E293B] bg-[#F8F8F8] px-4 rounded-md">
                <span>Total Income</span>
                <span>{formatMoney(totalIncome)}</span>
              </div>
            </div>
          </div>

          {/* Expense Section */}
          <div className="mb-8">
            <div className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">Expenses</div>
            <div className="divide-y divide-[#EDEDED] border-t border-[#EDEDED]">
              {expenseAccounts.map((acc) => (
                <div key={acc.id} className="py-2.5 flex justify-between text-xs">
                  <span className="text-[#525252] pl-4">{acc.name}</span>
                  <span className="font-mono text-[#1E293B]">{formatMoney(acc.balance)}</span>
                </div>
              ))}
              <div className="py-2.5 flex justify-between text-xs font-bold text-[#1E293B] bg-[#F8F8F8] px-4 rounded-md">
                <span>Total Expenses</span>
                <span>{formatMoney(totalExpense)}</span>
              </div>
            </div>
          </div>

          {/* Net Profit Banner */}
          <div className="p-4 rounded-xl bg-[#F0FDFA] border border-[#BAE8E1] flex justify-between items-center text-sm font-bold text-[#0F766E]">
            <span>Net Operating Profit</span>
            <span className="text-base font-mono">{formatMoney(netProfit)}</span>
          </div>
        </div>
      )}

      {/* --- REPORT 2: BALANCE SHEET --- */}
      {activeReport === 'balance-sheet' && (
        <div className="bg-white rounded-xl border border-[#EDEDED] p-8 shadow-xs max-w-4xl">
          <div className="text-center pb-6 border-b border-[#EDEDED] mb-6">
            <h2 className="text-lg font-bold text-[#1E293B]">{settings.companyName}</h2>
            <p className="text-xs text-[#7C7C7C] font-semibold mt-1 uppercase tracking-wider">
              Statement of Financial Position (Balance Sheet)
            </p>
            <p className="text-xs text-[#7C7C7C] mt-0.5">As of Today</p>
          </div>

          {/* Assets */}
          <div className="mb-6">
            <div className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">Assets</div>
            <div className="divide-y divide-[#EDEDED] border-t border-[#EDEDED]">
              {assetAccounts.map((acc) => (
                <div key={acc.id} className="py-2 flex justify-between text-xs">
                  <span className="text-[#525252] pl-4">{acc.name}</span>
                  <span className="font-mono text-[#1E293B]">{formatMoney(acc.balance)}</span>
                </div>
              ))}
              <div className="py-2.5 flex justify-between text-xs font-bold text-[#1E293B] bg-[#F8F8F8] px-4 rounded-md">
                <span>Total Assets</span>
                <span>{formatMoney(totalAssets)}</span>
              </div>
            </div>
          </div>

          {/* Liabilities */}
          <div className="mb-6">
            <div className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">Liabilities</div>
            <div className="divide-y divide-[#EDEDED] border-t border-[#EDEDED]">
              {liabilityAccounts.map((acc) => (
                <div key={acc.id} className="py-2 flex justify-between text-xs">
                  <span className="text-[#525252] pl-4">{acc.name}</span>
                  <span className="font-mono text-[#1E293B]">{formatMoney(acc.balance)}</span>
                </div>
              ))}
              <div className="py-2.5 flex justify-between text-xs font-bold text-[#1E293B] bg-[#F8F8F8] px-4 rounded-md">
                <span>Total Liabilities</span>
                <span>{formatMoney(totalLiabilities)}</span>
              </div>
            </div>
          </div>

          {/* Equity */}
          <div className="mb-8">
            <div className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">Equity</div>
            <div className="divide-y divide-[#EDEDED] border-t border-[#EDEDED]">
              {equityAccounts.map((acc) => (
                <div key={acc.id} className="py-2 flex justify-between text-xs">
                  <span className="text-[#525252] pl-4">{acc.name}</span>
                  <span className="font-mono text-[#1E293B]">{formatMoney(acc.balance)}</span>
                </div>
              ))}
              <div className="py-2 flex justify-between text-xs">
                <span className="text-[#525252] pl-4">Current Year Retained Profit</span>
                <span className="font-mono text-[#1E293B]">{formatMoney(netProfit)}</span>
              </div>
              <div className="py-2.5 flex justify-between text-xs font-bold text-[#1E293B] bg-[#F8F8F8] px-4 rounded-md">
                <span>Total Equity</span>
                <span>{formatMoney(totalEquity)}</span>
              </div>
            </div>
          </div>

          {/* Equality Check Banner */}
          <div className="p-4 rounded-xl bg-[#F8F8F8] border border-[#EDEDED] flex justify-between items-center text-xs font-bold text-[#1E293B]">
            <span>Total Liabilities & Equity Equation Check:</span>
            <span className="font-mono text-sm text-[#10B981]">
              Assets ({formatMoney(totalAssets)}) = Liab + Eq ({formatMoney(totalLiabilities + totalEquity)}) ✓
            </span>
          </div>
        </div>
      )}

      {/* --- REPORT 3: TRIAL BALANCE --- */}
      {activeReport === 'trial-balance' && (
        <div className="bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs max-w-4xl">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F8F8F8] font-bold text-[#7C7C7C] border-b border-[#EDEDED]">
              <tr>
                <th className="px-4 py-3">Account Title</th>
                <th className="px-4 py-3">Classification</th>
                <th className="px-4 py-3 text-right">Debit Balance</th>
                <th className="px-4 py-3 text-right">Credit Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EDEDED]">
              {accounts
                .filter((a) => !a.isGroup)
                .map((acc) => {
                  const isDebit = acc.rootType === 'Asset' || acc.rootType === 'Expense'
                  return (
                    <tr key={acc.id} className="hover:bg-[#FBFBFB]">
                      <td className="px-4 py-2.5 font-medium text-[#1E293B]">{acc.name}</td>
                      <td className="px-4 py-2.5 text-[#7C7C7C]">{acc.rootType}</td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {isDebit ? formatMoney(acc.balance) : '-'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {!isDebit ? formatMoney(acc.balance) : '-'}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      )}

      {/* --- REPORT 4: GENERAL LEDGER --- */}
      {activeReport === 'general-ledger' && (
        <div className="bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs max-w-4xl">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F8F8F8] font-bold text-[#7C7C7C] border-b border-[#EDEDED]">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Entry No</th>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3 text-right">Debit</th>
                <th className="px-4 py-3 text-right">Credit</th>
                <th className="px-4 py-3">Remarks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EDEDED]">
              {journalEntries.flatMap((je) =>
                je.items.map((it) => (
                  <tr key={it.id} className="hover:bg-[#FBFBFB]">
                    <td className="px-4 py-2.5 text-[#7C7C7C]">{je.date}</td>
                    <td className="px-4 py-2.5 font-mono text-[#1E293B]">{je.entryNumber}</td>
                    <td className="px-4 py-2.5 font-medium text-[#1E293B]">{it.accountName}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-[#1E293B]">
                      {it.debit > 0 ? formatMoney(it.debit) : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[#1E293B]">
                      {it.credit > 0 ? formatMoney(it.credit) : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-[#7C7C7C]">{it.remark || je.remarks || '-'}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

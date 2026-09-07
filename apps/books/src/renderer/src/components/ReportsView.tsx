import React, { useState } from 'react'
import {
  BookOpen,
  CheckSquare,
  Clock,
  FileSpreadsheet,
  Receipt,
  Scale,
  TrendingUp,
} from 'lucide-react'
import { useBooksStore } from '../store'
import { agingBuckets, taxRegister } from '../../../shared/reports'
import type { ReportType } from '../../../shared/types'

export function ReportsView() {
  const { data, activeReport, setActiveReport } = useBooksStore()
  const { accounts, settings, journalEntries, invoices, parties } = data
  const [agingScope, setAgingScope] = useState<'Sales' | 'Purchase'>('Sales')

  // ReportType in shared/types covers the four legacy statements; the Aging
  // and Tax Register tabs live in this view only (store/types untouched).
  type ReportTab = ReportType | 'aging' | 'tax-register'
  const report = activeReport as ReportTab
  const setReportTab = (tab: ReportTab) => setActiveReport(tab as ReportType)

  const asOf = new Date().toISOString().split('T')[0]
  const agingRows = agingBuckets(invoices, parties, asOf, agingScope)
  const agingTotals = agingRows.reduce(
    (sum, r) => ({
      current: sum.current + r.current,
      days30: sum.days30 + r.days30,
      days60: sum.days60 + r.days60,
      days90: sum.days90 + r.days90,
      total: sum.total + r.total,
    }),
    { current: 0, days30: 0, days60: 0, days90: 0, total: 0 },
  )
  const taxRows = taxRegister(invoices)

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
    let reportTitle: string
    let csv = ''

    if (report === 'profit-loss') {
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
    } else if (report === 'balance-sheet') {
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
    } else if (report === 'trial-balance') {
      reportTitle = 'Trial_Balance'
      csv = `Account Name,Root Type,Debit (${settings.currency}),Credit (${settings.currency})\n`
      let totalDr = 0
      let totalCr = 0
      accounts
        .filter((a) => !a.isGroup)
        .forEach((a) => {
          const isDebit = a.rootType === 'Asset' || a.rootType === 'Expense'
          const dr = isDebit ? a.balance : 0
          const cr = !isDebit ? a.balance : 0
          totalDr += dr
          totalCr += cr
          csv += `"${a.name}","${a.rootType}",${dr.toFixed(2)},${cr.toFixed(2)}\n`
        })
      csv += `TOTAL,,${totalDr.toFixed(2)},${totalCr.toFixed(2)}\n`
    } else if (report === 'aging') {
      reportTitle = `Aging_Report_${agingScope === 'Sales' ? 'Receivable' : 'Payable'}`
      csv = `Party,Current,30 Days,60 Days,90+ Days,Total\n`
      agingRows.forEach((r) => {
        csv += `"${r.partyName}",${r.current.toFixed(2)},${r.days30.toFixed(2)},${r.days60.toFixed(2)},${r.days90.toFixed(2)},${r.total.toFixed(2)}\n`
      })
      csv += `TOTAL,${agingTotals.current.toFixed(2)},${agingTotals.days30.toFixed(2)},${agingTotals.days60.toFixed(2)},${agingTotals.days90.toFixed(2)},${agingTotals.total.toFixed(2)}\n`
    } else if (report === 'tax-register') {
      reportTitle = 'Tax_Register'
      csv = `Tax Rate,Sales Taxable,Sales VAT (Output),Purchase Taxable,Purchase VAT (Input)\n`
      taxRows.forEach((r) => {
        const label = r.taxRate === null ? 'TOTAL' : `${r.taxRate}%`
        csv += `"${label}",${r.salesTaxable.toFixed(2)},${r.salesTax.toFixed(2)},${r.purchaseTaxable.toFixed(2)},${r.purchaseTax.toFixed(2)}\n`
      })
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
            report === 'profit-loss'
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
            report === 'balance-sheet'
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
            report === 'trial-balance'
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
            report === 'general-ledger'
              ? 'bg-[#1E293B] text-white'
              : 'text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3]'
          }`}
        >
          <BookOpen className="w-3.5 h-3.5" />
          General Ledger
        </button>

        <button
          onClick={() => setReportTab('aging')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
            report === 'aging'
              ? 'bg-[#1E293B] text-white'
              : 'text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3]'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          Aging
        </button>

        <button
          onClick={() => setReportTab('tax-register')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
            report === 'tax-register'
              ? 'bg-[#1E293B] text-white'
              : 'text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3]'
          }`}
        >
          <Receipt className="w-3.5 h-3.5" />
          Tax Register
        </button>
      </div>

      {/* --- REPORT 1: PROFIT AND LOSS --- */}
      {report === 'profit-loss' && (
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
            <div className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">
              Income
            </div>
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
            <div className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">
              Expenses
            </div>
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
      {report === 'balance-sheet' && (
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
            <div className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">
              Assets
            </div>
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
            <div className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">
              Liabilities
            </div>
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
            <div className="text-xs font-bold text-[#1E293B] uppercase tracking-wider mb-2">
              Equity
            </div>
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
              Assets ({formatMoney(totalAssets)}) = Liab + Eq (
              {formatMoney(totalLiabilities + totalEquity)}) ✓
            </span>
          </div>
        </div>
      )}

      {/* --- REPORT 3: TRIAL BALANCE --- */}
      {report === 'trial-balance' && (
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
      {report === 'general-ledger' && (
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

      {/* --- REPORT 5: AGING (AR / AP) --- */}
      {report === 'aging' && (
        <div className="bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs max-w-4xl">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-[#1E293B]">
                Accounts {agingScope === 'Sales' ? 'Receivable' : 'Payable'} Aging
              </h2>
              <p className="text-xs text-[#7C7C7C] mt-0.5">As of {asOf}</p>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-[#F8F8F8] border border-[#EDEDED]">
              <button
                onClick={() => setAgingScope('Sales')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  agingScope === 'Sales'
                    ? 'bg-[#1E293B] text-white'
                    : 'text-[#7C7C7C] hover:text-[#1E293B]'
                }`}
              >
                Sales (AR)
              </button>
              <button
                onClick={() => setAgingScope('Purchase')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  agingScope === 'Purchase'
                    ? 'bg-[#1E293B] text-white'
                    : 'text-[#7C7C7C] hover:text-[#1E293B]'
                }`}
              >
                Purchase (AP)
              </button>
            </div>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F8F8F8] font-bold text-[#7C7C7C] border-b border-[#EDEDED]">
              <tr>
                <th className="px-4 py-3">Party</th>
                <th className="px-4 py-3 text-right">Current</th>
                <th className="px-4 py-3 text-right">30 Days</th>
                <th className="px-4 py-3 text-right">60 Days</th>
                <th className="px-4 py-3 text-right">90+ Days</th>
                <th className="px-4 py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EDEDED]">
              {agingRows.map((row) => (
                <tr key={row.partyId} className="hover:bg-[#FBFBFB]">
                  <td className="px-4 py-2.5 font-medium text-[#1E293B]">{row.partyName}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-[#1E293B]">
                    {formatMoney(row.current)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[#1E293B]">
                    {formatMoney(row.days30)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[#1E293B]">
                    {formatMoney(row.days60)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[#1E293B]">
                    {formatMoney(row.days90)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold text-[#1E293B]">
                    {formatMoney(row.total)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-[#F8F8F8] font-bold text-[#1E293B]">
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right font-mono">
                  {formatMoney(agingTotals.current)}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {formatMoney(agingTotals.days30)}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {formatMoney(agingTotals.days60)}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {formatMoney(agingTotals.days90)}
                </td>
                <td className="px-4 py-3 text-right font-mono">{formatMoney(agingTotals.total)}</td>
              </tr>
            </tfoot>
          </table>
          {agingRows.length === 0 && (
            <p className="text-xs text-[#7C7C7C] mt-4">
              No open {agingScope === 'Sales' ? 'sales invoices' : 'purchase bills'} in this aging
              view.
            </p>
          )}
        </div>
      )}

      {/* --- REPORT 6: TAX REGISTER --- */}
      {report === 'tax-register' && (
        <div className="bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs max-w-4xl">
          <div className="mb-4">
            <h2 className="text-lg font-bold text-[#1E293B]">Tax Register (VAT)</h2>
            <p className="text-xs text-[#7C7C7C] mt-0.5">
              VAT Output = Sales VAT · VAT Input = Purchase VAT
            </p>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F8F8F8] font-bold text-[#7C7C7C] border-b border-[#EDEDED]">
              <tr>
                <th className="px-4 py-3">Rate</th>
                <th className="px-4 py-3 text-right">Sales Taxable</th>
                <th className="px-4 py-3 text-right">Sales VAT (Output)</th>
                <th className="px-4 py-3 text-right">Purchase Taxable</th>
                <th className="px-4 py-3 text-right">Purchase VAT (Input)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EDEDED]">
              {taxRows.map((row) => {
                const isTotal = row.taxRate === null
                return (
                  <tr
                    key={isTotal ? 'total' : `rate-${row.taxRate}`}
                    className={isTotal ? 'bg-[#F8F8F8]' : 'hover:bg-[#FBFBFB]'}
                  >
                    <td
                      className={`px-4 py-2.5 ${
                        isTotal ? 'font-bold text-[#1E293B]' : 'font-medium text-[#1E293B]'
                      }`}
                    >
                      {isTotal ? 'TOTAL' : `${row.taxRate}%`}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[#1E293B]">
                      {formatMoney(row.salesTaxable)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[#1E293B]">
                      {formatMoney(row.salesTax)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[#1E293B]">
                      {formatMoney(row.purchaseTaxable)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[#1E293B]">
                      {formatMoney(row.purchaseTax)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

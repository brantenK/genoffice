import React from 'react'
import {
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  Receipt,
  Building2,
  Wallet,
  Plus,
  FileSpreadsheet,
  CheckCircle2,
  Clock,
  AlertCircle,
} from 'lucide-react'
import { useBooksStore } from '../store'
import type { Invoice } from '../../../shared/types'

export function Dashboard() {
  const { data, setActiveTab, setActiveInvoiceId, setPrintInvoice } = useBooksStore()
  const { invoices, accounts, settings } = data

  const salesInvoices = invoices.filter((i) => i.type === 'Sales')
  const totalReceivable = salesInvoices.reduce((acc, i) => acc + i.outstandingAmount, 0)

  const purchaseBills = invoices.filter((i) => i.type === 'Purchase')
  const totalPayable = purchaseBills.reduce((acc, i) => acc + i.outstandingAmount, 0)

  const incomeAccounts = accounts.filter((a) => !a.isGroup && a.rootType === 'Income')
  const totalIncome = incomeAccounts.reduce((acc, a) => acc + a.balance, 0)

  const expenseAccounts = accounts.filter((a) => !a.isGroup && a.rootType === 'Expense')
  const totalExpenses = expenseAccounts.reduce((acc, a) => acc + a.balance, 0)

  const netProfit = totalIncome - totalExpenses

  const bankAccounts = accounts.filter((a) => !a.isGroup && (a.accountType === 'Bank' || a.accountType === 'Cash'))
  const liquidCash = bankAccounts.reduce((acc, a) => acc + a.balance, 0)

  const recentInvoices = invoices.slice(0, 6)

  const formatMoney = (amount: number) => {
    return `${settings.currencySymbol} ${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const getStatusBadge = (status: Invoice['status']) => {
    switch (status) {
      case 'Paid':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#F3FCF5] text-[#30A66D] border border-[#DAF0E1]">
            <CheckCircle2 className="w-3 h-3" /> Paid
          </span>
        )
      case 'Unpaid':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#FDFAED] text-[#DB7706] border border-[#FCE6D5]">
            <Clock className="w-3 h-3" /> Unpaid
          </span>
        )
      case 'Overdue':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#FFF7F7] text-[#E03636] border border-[#FCD7D7]">
            <AlertCircle className="w-3 h-3" /> Overdue
          </span>
        )
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#F3F3F3] text-[#7C7C7C]">
            Draft
          </span>
        )
    }
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Header Banner */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B] tracking-tight">Financial Dashboard</h1>
          <p className="text-sm text-[#7C7C7C] mt-1">
            {settings.companyName} · Financial Year {new Date(settings.financialYearStart).getFullYear()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveTab('reports')}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium text-[#1E293B] bg-white border border-[#EDEDED] hover:bg-[#F8F8F8] shadow-xs transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4 text-[#7C7C7C]" />
            Reports
          </button>
          <button
            onClick={() => {
              setActiveTab('invoices')
              setActiveInvoiceId('new')
            }}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] shadow-xs transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Invoice
          </button>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {/* Net Profit */}
        <div className="bg-white p-5 rounded-xl border border-[#EDEDED] shadow-xs">
          <div className="flex items-center justify-between text-xs font-medium text-[#7C7C7C] mb-2">
            <span>Net Profit</span>
            <TrendingUp className="w-4 h-4 text-[#30A66D]" />
          </div>
          <div className="text-2xl font-bold text-[#1E293B] tracking-tight">{formatMoney(netProfit)}</div>
          <div className="flex items-center gap-1.5 mt-2 text-xs font-medium text-[#30A66D]">
            <ArrowUpRight className="w-3.5 h-3.5" />
            <span>Operational Margin: {((netProfit / (totalIncome || 1)) * 100).toFixed(1)}%</span>
          </div>
        </div>

        {/* Total Income */}
        <div className="bg-white p-5 rounded-xl border border-[#EDEDED] shadow-xs">
          <div className="flex items-center justify-between text-xs font-medium text-[#7C7C7C] mb-2">
            <span>Total Revenue</span>
            <Receipt className="w-4 h-4 text-[#007BE0]" />
          </div>
          <div className="text-2xl font-bold text-[#1E293B] tracking-tight">{formatMoney(totalIncome)}</div>
          <div className="text-xs text-[#7C7C7C] mt-2">Across contract & consulting sales</div>
        </div>

        {/* Total Expenses */}
        <div className="bg-white p-5 rounded-xl border border-[#EDEDED] shadow-xs">
          <div className="flex items-center justify-between text-xs font-medium text-[#7C7C7C] mb-2">
            <span>Total Expenses</span>
            <ArrowDownRight className="w-4 h-4 text-[#E03636]" />
          </div>
          <div className="text-2xl font-bold text-[#1E293B] tracking-tight">{formatMoney(totalExpenses)}</div>
          <div className="text-xs text-[#7C7C7C] mt-2">Materials, salaries & site overheads</div>
        </div>

        {/* Bank & Cash */}
        <div className="bg-white p-5 rounded-xl border border-[#EDEDED] shadow-xs">
          <div className="flex items-center justify-between text-xs font-medium text-[#7C7C7C] mb-2">
            <span>Liquid Cash & Bank</span>
            <Wallet className="w-4 h-4 text-[#DB7706]" />
          </div>
          <div className="text-2xl font-bold text-[#1E293B] tracking-tight">{formatMoney(liquidCash)}</div>
          <div className="text-xs text-[#7C7C7C] mt-2">FNB Cheque + Petty Cash</div>
        </div>
      </div>

      {/* Receivables & Payables Band */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
        <div className="bg-white p-6 rounded-xl border border-[#EDEDED] shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-[#1E293B]">Accounts Receivable (Debtors)</h2>
              <p className="text-xs text-[#7C7C7C] mt-0.5">Outstanding payments owed by clients</p>
            </div>
            <span className="text-lg font-bold text-[#DB7706]">{formatMoney(totalReceivable)}</span>
          </div>
          <div className="w-full bg-[#F3F3F3] h-2 rounded-full overflow-hidden">
            <div
              className="bg-[#DB7706] h-full rounded-full transition-all"
              style={{ width: `${Math.min(100, (totalReceivable / (totalIncome || 1)) * 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-3 text-xs text-[#7C7C7C]">
            <span>{salesInvoices.filter((i) => i.status === 'Unpaid').length} open customer invoices</span>
            <button onClick={() => setActiveTab('invoices')} className="text-[#007BE0] hover:underline font-medium">
              View Invoices →
            </button>
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl border border-[#EDEDED] shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-[#1E293B]">Accounts Payable (Creditors)</h2>
              <p className="text-xs text-[#7C7C7C] mt-0.5">Bills owed to suppliers & subcontractors</p>
            </div>
            <span className="text-lg font-bold text-[#E03636]">{formatMoney(totalPayable)}</span>
          </div>
          <div className="w-full bg-[#F3F3F3] h-2 rounded-full overflow-hidden">
            <div
              className="bg-[#E03636] h-full rounded-full transition-all"
              style={{ width: `${Math.min(100, (totalPayable / (totalExpenses || 1)) * 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-3 text-xs text-[#7C7C7C]">
            <span>{purchaseBills.filter((i) => i.status === 'Unpaid').length} pending vendor bills</span>
            <button onClick={() => setActiveTab('purchases')} className="text-[#007BE0] hover:underline font-medium">
              View Purchases →
            </button>
          </div>
        </div>
      </div>

      {/* Recent Invoices & Transactions */}
      <div className="bg-white rounded-xl border border-[#EDEDED] shadow-xs overflow-hidden">
        <div className="px-6 py-4 border-b border-[#EDEDED] flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-[#1E293B]">Recent Invoices & Bills</h2>
            <p className="text-xs text-[#7C7C7C] mt-0.5">Latest commercial billing activity</p>
          </div>
          <button
            onClick={() => setActiveTab('invoices')}
            className="text-xs font-semibold text-[#007BE0] hover:underline"
          >
            View All ({invoices.length})
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#F8F8F8] text-xs font-semibold text-[#7C7C7C] border-b border-[#EDEDED]">
              <tr>
                <th className="px-6 py-3">Number</th>
                <th className="px-6 py-3">Type</th>
                <th className="px-6 py-3">Customer / Supplier</th>
                <th className="px-6 py-3">Date</th>
                <th className="px-6 py-3">Due Date</th>
                <th className="px-6 py-3 text-right">Amount</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EDEDED]">
              {recentInvoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-[#FBFBFB] transition-colors">
                  <td className="px-6 py-3.5 font-medium text-[#1E293B] font-mono text-xs">
                    {inv.invoiceNumber}
                  </td>
                  <td className="px-6 py-3.5 text-xs text-[#7C7C7C]">
                    <span className={`px-2 py-0.5 rounded-md font-medium ${inv.type === 'Sales' ? 'bg-[#F0FDFA] text-[#0F766E]' : 'bg-[#FFF9F5] text-[#D45A08]'}`}>
                      {inv.type}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 text-[#1E293B] font-medium">
                    {inv.partyName}
                    {inv.tenderReference && (
                      <span className="block text-xs text-[#7C7C7C] mt-0.5">Ref: {inv.tenderReference}</span>
                    )}
                  </td>
                  <td className="px-6 py-3.5 text-xs text-[#7C7C7C]">{inv.date}</td>
                  <td className="px-6 py-3.5 text-xs text-[#7C7C7C]">{inv.dueDate}</td>
                  <td className="px-6 py-3.5 text-right font-bold text-[#1E293B]">
                    {formatMoney(inv.grandTotal)}
                  </td>
                  <td className="px-6 py-3.5">{getStatusBadge(inv.status)}</td>
                  <td className="px-6 py-3.5 text-right">
                    <button
                      onClick={() => setPrintInvoice(inv)}
                      className="text-xs font-semibold text-[#1E293B] hover:text-[#007BE0] hover:underline"
                    >
                      Print / PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

import React, { useState } from 'react'
import {
  Plus,
  Search,
  Printer,
  Check,
  Trash2,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileSpreadsheet,
} from 'lucide-react'
import { useBooksStore } from '../store'
import type { Invoice, InvoiceStatus, InvoiceType } from '../../../shared/types'

interface InvoiceListProps {
  type: InvoiceType
}

export function InvoiceList({ type }: InvoiceListProps) {
  const {
    data,
    setActiveInvoiceId,
    setPrintInvoice,
    markInvoicePaid,
    deleteInvoice,
  } = useBooksStore()

  const [statusFilter, setStatusFilter] = useState<'All' | InvoiceStatus>('All')
  const [searchTerm, setSearchTerm] = useState('')

  const invoices = data.invoices.filter((i) => i.type === type)

  const filteredInvoices = invoices.filter((inv) => {
    const matchesStatus = statusFilter === 'All' || inv.status === statusFilter
    const matchesSearch =
      inv.invoiceNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inv.partyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (inv.tenderReference && inv.tenderReference.toLowerCase().includes(searchTerm.toLowerCase()))
    return matchesStatus && matchesSearch
  })

  const formatMoney = (val: number) => {
    return `${data.settings.currencySymbol} ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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

  const exportTableToSheets = () => {
    const header = 'Invoice Number,Type,Customer / Supplier,Date,Due Date,Grand Total,Outstanding Amount,Status,Reference\n'
    const rows = filteredInvoices
      .map((i) =>
        `"${i.invoiceNumber}","${i.type}","${i.partyName}","${i.date}","${i.dueDate}",${i.grandTotal},${i.outstandingAmount},"${i.status}","${i.tenderReference || ''}"`,
      )
      .join('\n')
    if (window.booksApi?.exportToSheets) {
      window.booksApi.exportToSheets(`${type}_Register`, header + rows)
    }
  }

  const title = type === 'Sales' ? 'Sales Invoices' : 'Purchase Bills'
  const partyHeader = type === 'Sales' ? 'Customer' : 'Supplier'

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B] tracking-tight">{title}</h1>
          <p className="text-sm text-[#7C7C7C] mt-0.5">
            {filteredInvoices.length} {type.toLowerCase()} transactions recorded
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={exportTableToSheets}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium text-[#1E293B] bg-white border border-[#EDEDED] hover:bg-[#F8F8F8] shadow-xs transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4 text-[#7C7C7C]" />
            Export to Sheets
          </button>
          <button
            onClick={() => setActiveInvoiceId('new')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] shadow-xs transition-colors"
          >
            <Plus className="w-4 h-4" />
            New {type === 'Sales' ? 'Invoice' : 'Bill'}
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex items-center justify-between gap-4 mb-6 bg-white p-3 rounded-xl border border-[#EDEDED] shadow-xs">
        <div className="flex items-center gap-1">
          {(['All', 'Unpaid', 'Paid', 'Overdue', 'Draft'] as const).map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                statusFilter === st
                  ? 'bg-[#1E293B] text-white'
                  : 'text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3]'
              }`}
            >
              {st}
            </button>
          ))}
        </div>

        <div className="relative w-72">
          <Search className="w-4 h-4 text-[#7C7C7C] absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder={`Search ${title.toLowerCase()}...`}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B] transition-colors"
          />
        </div>
      </div>

      {/* Invoices Table */}
      <div className="bg-white rounded-xl border border-[#EDEDED] shadow-xs overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#F8F8F8] text-xs font-semibold text-[#7C7C7C] border-b border-[#EDEDED]">
            <tr>
              <th className="px-6 py-3">Number</th>
              <th className="px-6 py-3">{partyHeader}</th>
              <th className="px-6 py-3">Date</th>
              <th className="px-6 py-3">Due Date</th>
              <th className="px-6 py-3 text-right">Grand Total</th>
              <th className="px-6 py-3 text-right">Balance Due</th>
              <th className="px-6 py-3">Status</th>
              <th className="px-6 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EDEDED]">
            {filteredInvoices.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-6 py-12 text-center text-sm text-[#7C7C7C]">
                  No {title.toLowerCase()} found matching criteria.
                </td>
              </tr>
            ) : (
              filteredInvoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-[#FBFBFB] transition-colors">
                  <td
                    onClick={() => setActiveInvoiceId(inv.id)}
                    className="px-6 py-3.5 font-medium text-[#1E293B] font-mono text-xs cursor-pointer hover:underline"
                  >
                    {inv.invoiceNumber}
                  </td>
                  <td className="px-6 py-3.5 text-[#1E293B] font-medium">
                    {inv.partyName}
                    {inv.tenderReference && (
                      <span className="block text-xs text-[#7C7C7C] font-mono mt-0.5">
                        Ref: {inv.tenderReference}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-3.5 text-xs text-[#7C7C7C]">{inv.date}</td>
                  <td className="px-6 py-3.5 text-xs text-[#7C7C7C]">{inv.dueDate}</td>
                  <td className="px-6 py-3.5 text-right font-bold text-[#1E293B]">
                    {formatMoney(inv.grandTotal)}
                  </td>
                  <td className="px-6 py-3.5 text-right font-medium text-[#DB7706]">
                    {formatMoney(inv.outstandingAmount)}
                  </td>
                  <td className="px-6 py-3.5">{getStatusBadge(inv.status)}</td>
                  <td className="px-6 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        title="Print / Export PDF"
                        onClick={() => setPrintInvoice(inv)}
                        className="p-1.5 text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3] rounded-md transition-colors"
                      >
                        <Printer className="w-4 h-4" />
                      </button>

                      {inv.status !== 'Paid' && (
                        <button
                          title="Record Payment (Mark Paid)"
                          onClick={() => markInvoicePaid(inv.id)}
                          className="p-1.5 text-[#30A66D] hover:bg-[#F3FCF5] rounded-md transition-colors"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                      )}

                      <button
                        title="Delete"
                        onClick={() => deleteInvoice(inv.id)}
                        className="p-1.5 text-[#E03636] hover:bg-[#FFF7F7] rounded-md transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

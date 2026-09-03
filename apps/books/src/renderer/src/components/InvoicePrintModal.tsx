import React from 'react'
import { X, Printer, PenTool } from 'lucide-react'
import { useBooksStore } from '../store'

export function InvoicePrintModal() {
  const { printInvoice, setPrintInvoice, data } = useBooksStore()
  const { settings } = data

  if (!printInvoice) return null

  const formatMoney = (val: number) => {
    return `${settings.currencySymbol} ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const handleOpenPdf = async () => {
    if (window.booksApi?.openInPdf) {
      await window.booksApi.openInPdf(printInvoice, settings.companyName)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-3xl w-full my-8 shadow-2xl border border-[#EDEDED] flex flex-col overflow-hidden">
        {/* Top Control Bar */}
        <div className="px-6 py-4 bg-[#F8F8F8] border-b border-[#EDEDED] flex items-center justify-between">
          <span className="text-xs font-bold text-[#1E293B] uppercase tracking-wider">
            Document Print Preview · {printInvoice.invoiceNumber}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenPdf}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-[#0F766E] hover:bg-[#0D655E] shadow-xs"
            >
              <PenTool className="w-3.5 h-3.5" />
              Sign in Zanostack PDF
            </button>
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-[#1E293B] bg-white border border-[#EDEDED] hover:bg-[#F3F3F3]"
            >
              <Printer className="w-3.5 h-3.5" />
              Print
            </button>
            <button
              onClick={() => setPrintInvoice(null)}
              className="p-1.5 text-[#7C7C7C] hover:text-[#1E293B] rounded-lg"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Printable Paper Canvas (A4 simulation) */}
        <div className="p-10 text-xs bg-white space-y-8">
          {/* Header & Logo */}
          <div className="flex justify-between items-start border-b border-[#EDEDED] pb-6">
            <div>
              <h1 className="text-xl font-bold text-[#1E293B] tracking-tight">{settings.companyName}</h1>
              <p className="text-[#7C7C7C] mt-1">{settings.address}</p>
              <p className="text-[#7C7C7C]">VAT Reg: {settings.taxNumber} · Email: {settings.email}</p>
            </div>
            <div className="text-right">
              <span className="text-2xl font-black text-[#1E293B] uppercase tracking-wider">
                {printInvoice.type === 'Sales' ? 'TAX INVOICE' : 'PURCHASE BILL'}
              </span>
              <p className="font-mono text-sm font-bold text-[#1E293B] mt-1">{printInvoice.invoiceNumber}</p>
              <span className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold mt-2 ${
                printInvoice.status === 'Paid' ? 'bg-[#F3FCF5] text-[#30A66D]' : 'bg-[#FDFAED] text-[#DB7706]'
              }`}>
                {printInvoice.status.toUpperCase()}
              </span>
            </div>
          </div>

          {/* Bill To & Dates */}
          <div className="grid grid-cols-2 gap-8">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#7C7C7C]">Billed To:</span>
              <p className="text-sm font-bold text-[#1E293B] mt-1">{printInvoice.partyName}</p>
              {printInvoice.tenderReference && (
                <p className="text-xs text-[#0F766E] font-medium mt-1">
                  Contract / Tender: {printInvoice.tenderReference}
                </p>
              )}
            </div>
            <div className="text-right space-y-1">
              <div>
                <span className="text-[#7C7C7C]">Invoice Date: </span>
                <span className="font-semibold text-[#1E293B]">{printInvoice.date}</span>
              </div>
              <div>
                <span className="text-[#7C7C7C]">Payment Due: </span>
                <span className="font-semibold text-[#1E293B]">{printInvoice.dueDate}</span>
              </div>
            </div>
          </div>

          {/* Items Table */}
          <div className="border border-[#EDEDED] rounded-lg overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-[#F8F8F8] font-bold text-[#525252] border-b border-[#EDEDED]">
                <tr>
                  <th className="px-4 py-2.5 w-12 text-center">#</th>
                  <th className="px-4 py-2.5">Description</th>
                  <th className="px-4 py-2.5 text-right w-16">Qty</th>
                  <th className="px-4 py-2.5 text-right w-28">Rate</th>
                  <th className="px-4 py-2.5 text-right w-20">VAT</th>
                  <th className="px-4 py-2.5 text-right w-28">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EDEDED]">
                {printInvoice.items.map((it, idx) => (
                  <tr key={it.id}>
                    <td className="px-4 py-2.5 text-center text-[#7C7C7C]">{idx + 1}</td>
                    <td className="px-4 py-2.5 font-medium text-[#1E293B]">{it.description}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{it.qty}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{formatMoney(it.rate)}</td>
                    <td className="px-4 py-2.5 text-right">{it.taxRate}%</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-[#1E293B]">
                      {formatMoney(it.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals Summary */}
          <div className="flex justify-end">
            <div className="w-64 space-y-2 border-t border-[#EDEDED] pt-3">
              <div className="flex justify-between text-[#7C7C7C]">
                <span>Subtotal (excl):</span>
                <span className="font-mono text-[#1E293B]">{formatMoney(printInvoice.subtotal)}</span>
              </div>
              <div className="flex justify-between text-[#7C7C7C]">
                <span>VAT (15%):</span>
                <span className="font-mono text-[#1E293B]">{formatMoney(printInvoice.taxTotal)}</span>
              </div>
              <div className="flex justify-between font-bold text-sm text-[#1E293B] pt-2 border-t border-[#EDEDED]">
                <span>Grand Total:</span>
                <span className="font-mono text-base text-[#1E293B]">{formatMoney(printInvoice.grandTotal)}</span>
              </div>
              <div className="flex justify-between font-bold text-xs text-[#DB7706] pt-1">
                <span>Balance Due:</span>
                <span className="font-mono">{formatMoney(printInvoice.outstandingAmount)}</span>
              </div>
            </div>
          </div>

          {/* Notes & Banking Details */}
          <div className="pt-6 border-t border-[#EDEDED] text-[11px] text-[#7C7C7C] space-y-1">
            <span className="font-bold uppercase tracking-wider text-[#525252]">Payment Instructions:</span>
            <p>{printInvoice.notes || 'Please deposit into company FNB account using invoice number as reference.'}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

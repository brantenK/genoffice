import React, { useEffect, useRef } from 'react'
import { X, Printer, FileDown } from 'lucide-react'
import { useBooksStore } from '../store'
import { effectiveLineAmount, round2 } from '../../../shared/accounting'
import { DEFAULT_INVOICE_ACCENT, isValidInvoiceAccent } from '../../../shared/chart'
import { isBaseCurrency } from './currencies'

/** A #RRGGBB accent as a CSS colour with `alpha`, for the tinted header. */
function withAlpha(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16)
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`
}

/** The footer text the PDF builder draws when no letterhead footer is set. */
const PDF_DEFAULT_FOOTER = 'Generated via Zano Books — Sovereign Financial Management'

export function InvoicePrintModal() {
  const { printInvoice, setPrintInvoice, data } = useBooksStore()
  const { settings } = data
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // The preview agrees with the PDF builder: same template, same accent, same
  // letterhead footer treatment.
  const template = settings.printTemplate === 'modern' ? 'modern' : 'classic'
  const accent = isValidInvoiceAccent(settings.invoiceAccent)
    ? settings.invoiceAccent
    : DEFAULT_INVOICE_ACCENT
  const letterhead = (settings.letterheadFooter || '').trim()

  useEffect(() => {
    if (!printInvoice) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPrintInvoice(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [printInvoice, setPrintInvoice])

  useEffect(() => {
    if (printInvoice) closeButtonRef.current?.focus()
  }, [printInvoice])

  if (!printInvoice) return null

  // The document prints in the INVOICE'S currency (its totals are its own
  // figures): a foreign-currency invoice is labelled with its ISO code, a
  // base-currency one keeps the company's symbol.
  const invoiceCurrencyLabel = isBaseCurrency(printInvoice, settings.currency)
    ? settings.currencySymbol
    : printInvoice.currency!.trim().toUpperCase()

  const formatMoney = (val: number) => {
    return `${invoiceCurrencyLabel} ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const handleOpenPdf = async () => {
    if (window.booksApi?.openInPdf) {
      await window.booksApi.openInPdf(printInvoice, settings.companyName)
    }
  }

  // "VAT at 15%" only when every line actually carries 15% and there is VAT on
  // the document — otherwise the rate shown beside the total would be a guess.
  const distinctRates = Array.from(
    new Set(printInvoice.items.map((it) => round2(Number(it.taxRate) || 0))),
  )
  const vatLabel =
    distinctRates.length === 1 && printInvoice.taxTotal !== 0 ? `VAT (${distinctRates[0]}%)` : 'VAT'

  return (
    <div className="print-root fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="print-panel bg-white rounded-2xl max-w-3xl w-full my-8 shadow-2xl border border-[#EDEDED] flex flex-col overflow-hidden">
        {/* Top Control Bar */}
        <div className="print-chrome px-6 py-4 bg-[#F8F8F8] border-b border-[#EDEDED] flex items-center justify-between">
          <span className="text-xs font-bold text-[#1E293B] uppercase tracking-wider">
            Document Print Preview · {printInvoice.invoiceNumber}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenPdf}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-[#0F766E] hover:bg-[#0D655E] shadow-xs"
            >
              <FileDown className="w-3.5 h-3.5" />
              Print / PDF
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
              ref={closeButtonRef}
              aria-label="Close print preview"
              title="Close (Esc)"
              className="p-1.5 text-[#6B6B6B] hover:text-[#1E293B] rounded-lg"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Printable Paper Canvas (A4 simulation) */}
        <div className="print-sheet p-10 text-xs bg-white space-y-8">
          {template === 'modern' ? (
            /* Modern: full-width accent header band carrying the issuer
               and the document title, matching the PDF's band. */
            <div
              className="px-6 py-6 flex justify-between items-start"
              style={{ backgroundColor: accent }}
            >
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">
                  {settings.companyName}
                </h1>
                <p className="text-white/80 mt-1">{settings.address}</p>
                <p className="text-white/80">
                  VAT Reg: {settings.taxNumber} · Email: {settings.email}
                </p>
              </div>
              <div className="text-right">
                <span className="text-2xl font-black text-white uppercase tracking-wider">
                  {printInvoice.type === 'Sales' ? 'TAX INVOICE' : 'PURCHASE BILL'}
                </span>
                <p className="font-mono text-sm font-bold text-white mt-1">
                  {printInvoice.invoiceNumber}
                </p>
                <span className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold mt-2 bg-white/15 text-white">
                  {printInvoice.status.toUpperCase()}
                </span>
              </div>
            </div>
          ) : (
            /* Header & Logo */
            <div className="flex justify-between items-start border-b border-[#EDEDED] pb-6">
              <div>
                <h1 className="text-xl font-bold text-[#1E293B] tracking-tight">
                  {settings.companyName}
                </h1>
                <p className="text-[#6B6B6B] mt-1">{settings.address}</p>
                <p className="text-[#6B6B6B]">
                  VAT Reg: {settings.taxNumber} · Email: {settings.email}
                </p>
              </div>
              <div className="text-right">
                <span className="text-2xl font-black text-[#1E293B] uppercase tracking-wider">
                  {printInvoice.type === 'Sales' ? 'TAX INVOICE' : 'PURCHASE BILL'}
                </span>
                <p className="font-mono text-sm font-bold text-[#1E293B] mt-1">
                  {printInvoice.invoiceNumber}
                </p>
                <span
                  className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold mt-2 ${
                    printInvoice.status === 'Paid'
                      ? 'bg-[#F3FCF5] text-[#30A66D]'
                      : 'bg-[#FDFAED] text-[#B45309]'
                  }`}
                >
                  {printInvoice.status.toUpperCase()}
                </span>
              </div>
            </div>
          )}

          {/* Bill To & Dates */}
          <div className="grid grid-cols-2 gap-8">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#6B6B6B]">
                Billed To:
              </span>
              <p className="text-sm font-bold text-[#1E293B] mt-1">{printInvoice.partyName}</p>
              {printInvoice.tenderReference && (
                <p className="text-xs font-medium mt-1" style={{ color: accent }}>
                  Contract / Tender: {printInvoice.tenderReference}
                </p>
              )}
            </div>
            <div className="text-right space-y-1">
              <div>
                <span className="text-[#6B6B6B]">Invoice Date: </span>
                <span className="font-semibold text-[#1E293B]">{printInvoice.date}</span>
              </div>
              <div>
                <span className="text-[#6B6B6B]">Payment Due: </span>
                <span className="font-semibold text-[#1E293B]">{printInvoice.dueDate}</span>
              </div>
            </div>
          </div>

          {/* Items Table */}
          <div className="border border-[#EDEDED] rounded-lg overflow-hidden">
            <table className="w-full text-left">
              <thead
                className={`font-bold text-[#525252] border-b border-[#EDEDED] ${
                  template === 'modern' ? '' : 'bg-[#F8F8F8]'
                }`}
                style={
                  template === 'modern' ? { backgroundColor: withAlpha(accent, 0.14) } : undefined
                }
              >
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
                    <td className="px-4 py-2.5 text-center text-[#6B6B6B]">{idx + 1}</td>
                    <td className="px-4 py-2.5 font-medium text-[#1E293B]">{it.description}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{it.qty}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{formatMoney(it.rate)}</td>
                    <td className="px-4 py-2.5 text-right">{it.taxRate}%</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-[#1E293B]">
                      {formatMoney(effectiveLineAmount(it))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals Summary */}
          <div className="flex justify-end">
            <div className="w-64 space-y-2 border-t border-[#EDEDED] pt-3">
              <div className="flex justify-between text-[#6B6B6B]">
                <span>Subtotal (excl):</span>
                <span className="font-mono text-[#1E293B]">
                  {formatMoney(printInvoice.subtotal)}
                </span>
              </div>
              <div className="flex justify-between text-[#6B6B6B]">
                <span>{vatLabel}:</span>
                <span className="font-mono text-[#1E293B]">
                  {formatMoney(printInvoice.taxTotal)}
                </span>
              </div>
              <div
                className="flex justify-between font-bold text-sm pt-2 border-t border-[#EDEDED]"
                style={template === 'modern' ? { color: accent } : undefined}
              >
                <span className={template === 'modern' ? undefined : 'text-[#1E293B]'}>
                  Grand Total:
                </span>
                <span
                  className={`font-mono text-base ${
                    template === 'modern' ? undefined : 'text-[#1E293B]'
                  }`}
                >
                  {formatMoney(printInvoice.grandTotal)}
                </span>
              </div>
              <div
                className="flex justify-between font-bold text-xs pt-1"
                style={{ color: accent }}
              >
                <span>Balance Due:</span>
                <span className="font-mono">{formatMoney(printInvoice.outstandingAmount)}</span>
              </div>
            </div>
          </div>

          {/* Notes & Banking Details */}
          <div className="pt-6 border-t border-[#EDEDED] text-[11px] text-[#6B6B6B] space-y-1">
            <span className="font-bold uppercase tracking-wider text-[#525252]">
              Payment Instructions:
            </span>
            <p>
              {printInvoice.notes ||
                'Please deposit into company FNB account using invoice number as reference.'}
            </p>
          </div>

          {/* Letterhead footer — classic appends it to the PDF's generated-by
              line (shown only when set, as the PDF draws it), modern replaces
              the generated-by text with it. */}
          {template === 'modern' || letterhead ? (
            <div className="pt-4 border-t border-[#EDEDED] text-[10px] text-[#6B6B6B]">
              {template === 'modern'
                ? letterhead || PDF_DEFAULT_FOOTER
                : `${PDF_DEFAULT_FOOTER} · ${letterhead}`}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

import React, { useEffect, useRef } from 'react'
import { X, Printer, FileDown } from 'lucide-react'
import { useBooksStore } from '../store'
import { effectiveLineAmount } from '../../../shared/accounting'
import { DEFAULT_INVOICE_ACCENT, isValidInvoiceAccent } from '../../../shared/chart'
import {
  DEFAULT_INVOICE_NOTES,
  bookedInvoiceDiscount,
  vatTaxLabel,
} from '../../../shared/print'
import { isBaseCurrency } from './currencies'

/** A #RRGGBB accent as a CSS colour with `alpha`, for the tinted header. */
function withAlpha(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16)
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`
}

/** The footer text the PDF builder draws when no letterhead footer is set. */
const PDF_DEFAULT_FOOTER = 'Generated via Zano Books — Sovereign Financial Management'

/**
 * The quotation print preview — the invoice preview's mirror: same templates,
 * same letterhead, same totals discipline (booked discount, shared VAT label),
 * with the quotation's own meta (quote number, valid-until date) and no
 * round-off, due date or balance due.
 */
export function QuotationPrintModal() {
  const { printQuote, setPrintQuote, data } = useBooksStore()
  const { settings } = data
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const template = settings.printTemplate === 'modern' ? 'modern' : 'classic'
  const accent = isValidInvoiceAccent(settings.invoiceAccent)
    ? settings.invoiceAccent
    : DEFAULT_INVOICE_ACCENT
  const letterhead = (settings.letterheadFooter || '').trim()

  useEffect(() => {
    if (!printQuote) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPrintQuote(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [printQuote, setPrintQuote])

  useEffect(() => {
    if (printQuote) closeButtonRef.current?.focus()
  }, [printQuote])

  if (!printQuote) return null

  // The preview agrees with the quotation PDF: the document prints in the
  // quotation's currency — its ISO code for a foreign document, the company
  // symbol for a base-currency one.
  const quoteCurrencyLabel = isBaseCurrency(printQuote, settings.currency)
    ? settings.currencySymbol
    : printQuote.currency!.trim().toUpperCase()

  const formatMoney = (val: number) => {
    return `${quoteCurrencyLabel} ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const handleOpenPdf = async () => {
    if (window.booksApi?.openQuotePdf) {
      await window.booksApi.openQuotePdf(printQuote, settings.companyName)
    }
  }

  const vatLabel = vatTaxLabel(printQuote.items, printQuote.taxTotal, 'VAT')
  const bookedDiscount = bookedInvoiceDiscount(printQuote.subtotal, printQuote.discountTotal ?? 0)

  return (
    <div className="print-root fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="print-panel bg-white rounded-2xl max-w-3xl w-full my-8 shadow-2xl border border-[#EDEDED] flex flex-col overflow-hidden">
        {/* Top Control Bar */}
        <div className="print-chrome px-6 py-4 bg-[#F8F8F8] border-b border-[#EDEDED] flex items-center justify-between">
          <span className="text-xs font-bold text-[#1E293B] uppercase tracking-wider">
            Document Print Preview · {printQuote.quoteNumber}
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
              onClick={() => setPrintQuote(null)}
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
                {settings.registrationNumber && (
                  <p className="text-white/80">Reg: {settings.registrationNumber}</p>
                )}
              </div>
              <div className="text-right">
                {settings.logoDataUrl && (
                  <img
                    src={settings.logoDataUrl}
                    alt={`${settings.companyName} logo`}
                    className="ml-auto mb-2 max-h-14 object-contain"
                  />
                )}
                <span className="text-2xl font-black text-white uppercase tracking-wider">
                  QUOTATION
                </span>
                <p className="font-mono text-sm font-bold text-white mt-1">
                  {printQuote.quoteNumber}
                </p>
                <span className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold mt-2 bg-white/15 text-white">
                  {printQuote.status.toUpperCase()}
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
                {settings.registrationNumber && (
                  <p className="text-[#6B6B6B]">Reg: {settings.registrationNumber}</p>
                )}
              </div>
              <div className="text-right">
                {settings.logoDataUrl && (
                  <img
                    src={settings.logoDataUrl}
                    alt={`${settings.companyName} logo`}
                    className="ml-auto mb-2 max-h-14 object-contain"
                  />
                )}
                <span className="text-2xl font-black text-[#1E293B] uppercase tracking-wider">
                  QUOTATION
                </span>
                <p className="font-mono text-sm font-bold text-[#1E293B] mt-1">
                  {printQuote.quoteNumber}
                </p>
                <span className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold mt-2 bg-[#FDFAED] text-[#B45309]">
                  {printQuote.status.toUpperCase()}
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
              <p className="text-sm font-bold text-[#1E293B] mt-1">{printQuote.partyName}</p>
              {printQuote.partyAddress && (
                <p className="text-xs text-[#6B6B6B] mt-1">{printQuote.partyAddress}</p>
              )}
              {printQuote.partyTaxId && (
                <p className="text-xs text-[#6B6B6B]">VAT / Tax ID: {printQuote.partyTaxId}</p>
              )}
            </div>
            <div className="text-right space-y-1">
              <div>
                <span className="text-[#6B6B6B]">Quote Date: </span>
                <span className="font-semibold text-[#1E293B]">{printQuote.date}</span>
              </div>
              <div>
                <span className="text-[#6B6B6B]">Valid Until: </span>
                <span className="font-semibold text-[#1E293B]">{printQuote.validUntil}</span>
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
                  <th className="px-4 py-2.5 text-right w-28">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EDEDED]">
                {printQuote.items.map((it, idx) => (
                  <tr key={it.id}>
                    <td className="px-4 py-2.5 text-center text-[#6B6B6B]">{idx + 1}</td>
                    <td className="px-4 py-2.5 font-medium text-[#1E293B]">{it.description}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{it.qty}</td>
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
                <span className="font-mono text-[#1E293B]">{formatMoney(printQuote.subtotal)}</span>
              </div>
              {bookedDiscount > 0 && (
                <div className="flex justify-between text-[#6B6B6B]">
                  <span>Discount:</span>
                  <span className="font-mono text-[#1E293B]">-{formatMoney(bookedDiscount)}</span>
                </div>
              )}
              <div className="flex justify-between text-[#6B6B6B]">
                <span>{vatLabel}:</span>
                <span className="font-mono text-[#1E293B]">{formatMoney(printQuote.taxTotal)}</span>
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
                  {formatMoney(printQuote.grandTotal)}
                </span>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="pt-6 border-t border-[#EDEDED] text-[11px] text-[#6B6B6B] space-y-1">
            <span className="font-bold uppercase tracking-wider text-[#525252]">Notes:</span>
            <p>{printQuote.notes || DEFAULT_INVOICE_NOTES}</p>
          </div>

          {/* Letterhead footer — same treatment as the invoice preview. */}
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

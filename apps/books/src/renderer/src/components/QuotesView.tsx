import React, { useState } from 'react'
import {
  Plus,
  Search,
  Trash2,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Send,
  Pencil,
  Receipt,
  ArrowLeft,
  Save,
} from 'lucide-react'
import { useBooksStore } from '../store'
import { displayQuoteStatus, quoteMatchesStatusFilter } from './quote-status'
import { currencyTag, EXTRA_CURRENCIES } from './currencies'
import type { InvoiceItem, Quotation, QuotationStatus } from '../../../shared/types'
import { round2, calculateInvoiceTotals, effectiveLineAmount } from '../../../shared/accounting'
import { isoDaysFromToday, localIsoToday } from '../../../shared/dates'

type Mode = { kind: 'list' } | { kind: 'form'; quote: Quotation | null }

const QUOTE_FILTERS: Array<'All' | QuotationStatus> = [
  'All',
  'Draft',
  'Sent',
  'Accepted',
  'Lost',
  'Expired',
  'Converted',
]

export function QuotesView() {
  const {
    data,
    setQuoteStatus,
    convertQuoteToInvoice,
    deleteQuote,
    setActiveTab,
    setActiveInvoiceId,
  } = useBooksStore()

  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [statusFilter, setStatusFilter] = useState<'All' | QuotationStatus>('All')
  const [searchTerm, setSearchTerm] = useState('')

  const asOf = localIsoToday()
  const quotes = data.quotes || []

  const formatMoney = (val: number) => {
    return `${data.settings.currencySymbol} ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const getStatusBadge = (quote: Quotation) => {
    const status = displayQuoteStatus(quote, asOf)
    switch (status) {
      case 'Accepted':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#F3FCF5] text-[#1B7A46] border border-[#DAF0E1]">
            <CheckCircle2 className="w-3 h-3" /> Accepted
          </span>
        )
      case 'Sent':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#FDFAED] text-[#B45309] border border-[#FCE6D5]">
            <Send className="w-3 h-3" /> Sent
          </span>
        )
      case 'Expired':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#FFF7F7] text-[#C22626] border border-[#FCD7D7]">
            <AlertCircle className="w-3 h-3" /> Expired
          </span>
        )
      case 'Lost':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#F3F3F3] text-[#6B6B6B] border border-[#E2E2E2] line-through">
            <XCircle className="w-3 h-3" /> Lost
          </span>
        )
      case 'Converted':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#F0FDFA] text-[#0F766E] border border-[#CCFBF1]">
            <Receipt className="w-3 h-3" /> Converted
          </span>
        )
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#F3F3F3] text-[#6B6B6B]">
            Draft
          </span>
        )
    }
  }

  // Conversion is the moment a quotation becomes a ledger event: the invoice
  // posts through the store's single posting path and the desk opens it.
  // Failures (already converted, closed period, refused write) surface through
  // the store's error banner.
  const convert = async (quote: Quotation) => {
    const result = await convertQuoteToInvoice(quote.id)
    if (result.ok && result.invoice) {
      setActiveTab('invoices')
      setActiveInvoiceId(result.invoice.id)
    }
  }

  const filteredQuotes = quotes.filter((q) => {
    const matchesStatus = quoteMatchesStatusFilter(q, statusFilter, asOf)
    const matchesSearch =
      q.quoteNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      q.partyName.toLowerCase().includes(searchTerm.toLowerCase())
    return matchesStatus && matchesSearch
  })

  if (mode.kind === 'form') {
    return <QuoteForm quote={mode.quote} onClose={() => setMode({ kind: 'list' })} />
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B] tracking-tight">Quotations</h1>
          <p className="text-sm text-[#6B6B6B] mt-0.5">
            {filteredQuotes.length} quotation{filteredQuotes.length === 1 ? '' : 's'} on record —
            nothing posts to the ledger until a quote converts to an invoice
          </p>
        </div>
        <button
          onClick={() => setMode({ kind: 'form', quote: null })}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] shadow-xs transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Quotation
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex items-center justify-between gap-4 mb-6 bg-white p-3 rounded-xl border border-[#EDEDED] shadow-xs">
        <div className="flex items-center gap-1 flex-wrap">
          {QUOTE_FILTERS.map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                statusFilter === st
                  ? 'bg-[#1E293B] text-white'
                  : 'text-[#6B6B6B] hover:text-[#1E293B] hover:bg-[#F3F3F3]'
              }`}
            >
              {st}
            </button>
          ))}
        </div>

        <div className="relative w-72">
          <Search className="w-4 h-4 text-[#6B6B6B] absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Search quotations..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B] transition-colors"
          />
        </div>
      </div>

      {/* Quotations Table */}
      <div className="bg-white rounded-xl border border-[#EDEDED] shadow-xs overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#F8F8F8] text-xs font-semibold text-[#6B6B6B] border-b border-[#EDEDED]">
            <tr>
              <th className="px-6 py-3">Number</th>
              <th className="px-6 py-3">Customer</th>
              <th className="px-6 py-3">Date</th>
              <th className="px-6 py-3">Valid Until</th>
              <th className="px-6 py-3 text-right">Grand Total</th>
              <th className="px-6 py-3">Status</th>
              <th className="px-6 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EDEDED]">
            {filteredQuotes.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-sm text-[#6B6B6B]">
                  No quotations found matching criteria.
                </td>
              </tr>
            ) : (
              filteredQuotes.map((q) => (
                <tr key={q.id} className="hover:bg-[#FBFBFB] transition-colors">
                  <td className="px-6 py-3.5 font-medium text-[#1E293B] font-mono text-xs">
                    {q.quoteNumber}
                  </td>
                  <td className="px-6 py-3.5 text-[#1E293B] font-medium">{q.partyName}</td>
                  <td className="px-6 py-3.5 text-xs text-[#6B6B6B]">{q.date}</td>
                  <td className="px-6 py-3.5 text-xs text-[#6B6B6B]">{q.validUntil}</td>
                  <td className="px-6 py-3.5 text-right font-bold text-[#1E293B]">
                    {formatMoney(q.grandTotal)}
                    {currencyTag(q, data.settings.currency) && (
                      <span className="ml-1.5 text-[11px] font-semibold text-[#6B6B6B]">
                        {currencyTag(q, data.settings.currency)}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-3.5">{getStatusBadge(q)}</td>
                  <td className="px-6 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {(q.status === 'Sent' || q.status === 'Accepted') && (
                        <button
                          title="Convert to Invoice"
                          aria-label={`Convert quotation ${q.quoteNumber} to an invoice`}
                          onClick={() => convert(q)}
                          className="p-1.5 text-[#0F766E] hover:bg-[#F0FDFA] rounded-md transition-colors"
                        >
                          <Receipt className="w-4 h-4" />
                        </button>
                      )}

                      {q.status === 'Draft' && (
                        <button
                          title="Mark as Sent"
                          aria-label={`Mark quotation ${q.quoteNumber} as sent`}
                          onClick={() => setQuoteStatus(q.id, 'Sent')}
                          className="p-1.5 text-[#B45309] hover:bg-[#FDFAED] rounded-md transition-colors"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      )}

                      {q.status === 'Sent' && (
                        <>
                          <button
                            title="Mark as Accepted"
                            aria-label={`Mark quotation ${q.quoteNumber} as accepted`}
                            onClick={() => setQuoteStatus(q.id, 'Accepted')}
                            className="p-1.5 text-[#30A66D] hover:bg-[#F3FCF5] rounded-md transition-colors"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                          </button>
                          <button
                            title="Mark as Lost"
                            aria-label={`Mark quotation ${q.quoteNumber} as lost`}
                            onClick={() => setQuoteStatus(q.id, 'Lost')}
                            className="p-1.5 text-[#6B6B6B] hover:bg-[#F3F3F3] rounded-md transition-colors"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        </>
                      )}

                      {q.status === 'Draft' && (
                        <button
                          title="Edit"
                          aria-label={`Edit quotation ${q.quoteNumber}`}
                          onClick={() => setMode({ kind: 'form', quote: q })}
                          className="p-1.5 text-[#6B6B6B] hover:text-[#1E293B] hover:bg-[#F3F3F3] rounded-md transition-colors"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}

                      {q.status !== 'Converted' && (
                        <button
                          title="Delete"
                          aria-label={`Delete quotation ${q.quoteNumber}`}
                          onClick={() => deleteQuote(q.id)}
                          className="p-1.5 text-[#E03636] hover:bg-[#FFF7F7] rounded-md transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
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

/** The quotation editor. It writes to `quotes` only — nothing here posts. */
function QuoteForm({ quote, onClose }: { quote: Quotation | null; onClose: () => void }) {
  const { data, saveQuote } = useBooksStore()

  const customers = data.parties.filter((p) => p.type === 'Customer')
  const relevantAccounts = data.accounts.filter((a) => !a.isGroup && a.rootType === 'Income')
  const defaultAccount = relevantAccounts[0] || {
    id: 'acc-sales',
    name: 'Tender & Commercial Contracting Sales',
  }

  const [partyId, setPartyId] = useState(quote?.partyId || customers[0]?.id || '')
  const [date, setDate] = useState(quote?.date || localIsoToday())
  const [validUntil, setValidUntil] = useState(
    quote?.validUntil || isoDaysFromToday(30),
  )
  const [notes, setNotes] = useState(quote?.notes || 'Quotation valid for 30 days.')
  const [discountTotal, setDiscountTotal] = useState(
    quote?.discountTotal !== undefined ? String(quote.discountTotal) : '',
  )

  // The quotation is denominated in its own currency exactly like an invoice;
  // the rate only matters at conversion, when the invoice posts at it.
  const baseCurrency = data.settings.currency || 'ZAR'
  const [currency, setCurrency] = useState(quote?.currency || baseCurrency)
  const [exchangeRate, setExchangeRate] = useState(
    quote?.exchangeRate !== undefined && quote.exchangeRate !== null
      ? String(quote.exchangeRate)
      : '',
  )
  const isBaseCurrency = currency.trim().toUpperCase() === baseCurrency.toUpperCase()
  const effectiveExchangeRate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 1
  const previewSymbol = isBaseCurrency
    ? data.settings.currencySymbol
    : currency.trim().toUpperCase()

  const effectiveTaxRate = data.settings.defaultTaxRate ?? 15

  const [items, setItems] = useState<InvoiceItem[]>(
    quote?.items && quote.items.length > 0
      ? quote.items.map((it) => ({
          ...it,
          accountId: it.accountId || defaultAccount.id,
          accountName: it.accountName || defaultAccount.name,
          amount: round2(
            it.qty != null && it.rate != null
              ? Number(it.qty) * Number(it.rate)
              : Number(it.amount) || 0,
          ),
        }))
      : [
          {
            id: `item-${Date.now()}`,
            itemCode: 'ITEM-01',
            description: 'Professional Engineering & Site Supervision',
            accountId: defaultAccount.id,
            accountName: defaultAccount.name,
            qty: 1,
            rate: 10000,
            taxRate: effectiveTaxRate,
            amount: 10000,
          },
        ],
  )

  const updateItem = (id: string, field: keyof InvoiceItem, val: any) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it
        const next = { ...it, [field]: val }
        if (field === 'qty' || field === 'rate') {
          const q = field === 'qty' ? Number(val) || 0 : Number(it.qty) || 0
          const r = field === 'rate' ? Number(val) || 0 : Number(it.rate) || 0
          next.amount = round2(q * r)
        }
        if (field === 'accountId') {
          const matched = relevantAccounts.find((a) => a.id === val)
          if (matched) next.accountName = matched.name
        }
        return next
      }),
    )
  }

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      {
        id: `item-${Date.now()}`,
        itemCode: `ITEM-${String(prev.length + 1).padStart(2, '0')}`,
        description: 'Commercial Service Delivery',
        accountId: defaultAccount.id,
        accountName: defaultAccount.name,
        qty: 1,
        rate: 10000,
        taxRate: effectiveTaxRate,
        amount: 10000,
      },
    ])
  }

  const removeItem = (id: string) => {
    if (items.length <= 1) return
    setItems((prev) => prev.filter((it) => it.id !== id))
  }

  const { subtotal, taxTotal, grandTotal } = calculateInvoiceTotals(items, {
    taxInclusive: data.settings.taxInclusive,
    discountTotal: Number(discountTotal) || 0,
  })

  const handleSave = async () => {
    const selectedParty = customers.find((p) => p.id === partyId)
    await saveQuote({
      id: quote?.id,
      partyId,
      partyName: selectedParty?.name || 'Customer',
      date,
      validUntil,
      notes,
      items,
      currency: currency.trim() || baseCurrency,
      exchangeRate: effectiveExchangeRate,
      ...(discountTotal.trim() && Number(discountTotal) !== 0
        ? { discountTotal: Number(discountTotal) }
        : {}),
    })
    onClose()
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Top Header */}
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#EDEDED]">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="p-2 text-[#6B6B6B] hover:text-[#1E293B] hover:bg-[#F3F3F3] rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-[#1E293B]">
              {quote ? `Edit ${quote.quoteNumber}` : 'New Quotation'}
            </h1>
            <p className="text-xs text-[#6B6B6B] mt-0.5">
              A quotation is a commercial offer — nothing posts to the ledger until it converts
            </p>
          </div>
        </div>

        <button
          onClick={handleSave}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] shadow-xs transition-colors"
        >
          <Save className="w-4 h-4" />
          Save Quotation
        </button>
      </div>

      {/* Form Fields Card */}
      <div className="bg-white rounded-xl border border-[#EDEDED] p-6 mb-6 shadow-xs">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-semibold text-[#525252] mb-1.5">Customer</label>
            <select
              value={partyId}
              onChange={(e) => setPartyId(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
            >
              {customers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#525252] mb-1.5">Quote Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#525252] mb-1.5">Valid Until</label>
            <input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#525252] mb-1.5">Currency</label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
            >
              <option value={baseCurrency}>Base — {baseCurrency}</option>
              {EXTRA_CURRENCIES.filter((code) => code !== baseCurrency).map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
              {!isBaseCurrency && !EXTRA_CURRENCIES.includes(currency.trim().toUpperCase()) && (
                <option value={currency}>{currency.trim().toUpperCase()}</option>
              )}
            </select>
          </div>

          {!isBaseCurrency && (
            <div>
              <label className="block text-xs font-semibold text-[#525252] mb-1.5">
                Exchange Rate
              </label>
              <input
                type="number"
                min="0"
                step="0.0001"
                placeholder="1"
                value={exchangeRate}
                onChange={(e) => setExchangeRate(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
              />
              <p className="text-[11px] text-[#6B6B6B] mt-1">
                {`1 ${currency.trim().toUpperCase()} = ${effectiveExchangeRate} ${baseCurrency} when converted`}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Itemized Line Items Table */}
      <div className="bg-white rounded-xl border border-[#EDEDED] shadow-xs overflow-hidden mb-6">
        <div className="px-6 py-3.5 bg-[#F8F8F8] border-b border-[#EDEDED] flex items-center justify-between">
          <span className="text-xs font-bold text-[#1E293B] uppercase tracking-wider">
            Line Items
          </span>
          <button
            onClick={addItem}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0062A8] hover:underline"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Row
          </button>
        </div>

        <table className="w-full text-left text-xs">
          <thead className="bg-[#F8F8F8] font-semibold text-[#6B6B6B] border-b border-[#EDEDED]">
            <tr>
              <th className="px-6 py-2.5 w-1/3">Description</th>
              <th className="px-4 py-2.5">Account</th>
              <th className="px-4 py-2.5 text-right w-20">Qty</th>
              <th className="px-4 py-2.5 text-right w-28">Rate (excl)</th>
              <th className="px-4 py-2.5 text-right w-20">VAT %</th>
              <th className="px-4 py-2.5 text-right w-16">Disc %</th>
              <th className="px-6 py-2.5 text-right w-28">Amount</th>
              <th className="px-4 py-2.5 w-10"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EDEDED]">
            {items.map((it) => (
              <tr key={it.id}>
                <td className="px-6 py-2.5">
                  <input
                    type="text"
                    value={it.description}
                    onChange={(e) => updateItem(it.id, 'description', e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none focus:border-[#1E293B]"
                  />
                </td>
                <td className="px-4 py-2.5">
                  <select
                    value={it.accountId}
                    onChange={(e) => updateItem(it.id, 'accountId', e.target.value)}
                    className="w-full px-2 py-1.5 bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none focus:border-[#1E293B]"
                  >
                    {relevantAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2.5">
                  <input
                    type="number"
                    min="1"
                    value={it.qty}
                    onChange={(e) => updateItem(it.id, 'qty', parseFloat(e.target.value) || 0)}
                    className="w-full px-2 py-1.5 text-right bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none focus:border-[#1E293B]"
                  />
                </td>
                <td className="px-4 py-2.5">
                  <input
                    type="number"
                    step="0.01"
                    value={it.rate}
                    onChange={(e) => updateItem(it.id, 'rate', parseFloat(e.target.value) || 0)}
                    className="w-full px-2 py-1.5 text-right bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none focus:border-[#1E293B]"
                  />
                </td>
                <td className="px-4 py-2.5">
                  <select
                    value={it.taxRate}
                    onChange={(e) => updateItem(it.id, 'taxRate', parseFloat(e.target.value) || 0)}
                    className="w-full px-1.5 py-1.5 text-right bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none focus:border-[#1E293B]"
                  >
                    <option value={effectiveTaxRate}>{effectiveTaxRate}%</option>
                    <option value={0}>0%</option>
                  </select>
                </td>
                <td className="px-4 py-2.5">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="0.5"
                    placeholder="0"
                    value={it.discountRate ?? ''}
                    onChange={(e) =>
                      updateItem(it.id, 'discountRate', parseFloat(e.target.value) || 0)
                    }
                    className="w-full px-1.5 py-1.5 text-right bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none focus:border-[#1E293B]"
                  />
                </td>
                <td className="px-6 py-2.5 text-right font-semibold text-[#1E293B]">
                  {previewSymbol} {effectiveLineAmount(it).toFixed(2)}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <button
                    onClick={() => removeItem(it.id)}
                    className="text-[#6B6B6B] hover:text-[#E03636] p-1 rounded transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Bottom Summary & Notes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-[#EDEDED] p-5 shadow-xs">
          <label className="block text-xs font-semibold text-[#525252] mb-2">Notes</label>
          <textarea
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
          />
        </div>

        <div className="bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs">
          <div className="space-y-2.5 text-xs">
            <div className="flex justify-between text-[#6B6B6B]">
              <span>Subtotal</span>
              <span className="font-semibold text-[#1E293B]">
                {previewSymbol} {subtotal.toFixed(2)}
              </span>
            </div>

            {/* Invoice-level discount (VAT-exclusive), carried onto the invoice at conversion */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[#6B6B6B]">Quote discount (excl.)</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[#6B6B6B]">{previewSymbol}</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="0.00"
                  value={discountTotal}
                  onChange={(e) => setDiscountTotal(e.target.value)}
                  className="w-28 px-2 py-1 text-right bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none focus:border-[#1E293B]"
                />
              </div>
            </div>

            <div className="flex justify-between text-[#6B6B6B]">
              <span>VAT / Tax ({effectiveTaxRate}%)</span>
              <span className="font-semibold text-[#1E293B]">
                {previewSymbol} {taxTotal.toFixed(2)}
              </span>
            </div>

            <div className="pt-3 border-t border-[#EDEDED] flex justify-between text-sm font-bold text-[#1E293B]">
              <span>Grand Total</span>
              <span className="text-base text-[#10B981]">
                {previewSymbol} {grandTotal.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

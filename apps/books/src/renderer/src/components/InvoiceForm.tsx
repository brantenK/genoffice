import React, { useState } from 'react'
import { Plus, Trash2, ArrowLeft, Save, Printer } from 'lucide-react'
import { useBooksStore } from '../store'
import type { InvoiceItem, InvoiceType } from '../../../shared/types'

interface InvoiceFormProps {
  type: InvoiceType
}

export function InvoiceForm({ type }: InvoiceFormProps) {
  const { data, activeInvoiceId, setActiveInvoiceId, saveInvoice, setPrintInvoice } = useBooksStore()
  const existing = data.invoices.find((i) => i.id === activeInvoiceId)

  const relevantParties = data.parties.filter((p) =>
    type === 'Sales' ? p.type === 'Customer' : p.type === 'Supplier',
  )

  const relevantAccounts = data.accounts.filter((a) =>
    type === 'Sales' ? a.rootType === 'Income' : a.rootType === 'Expense',
  )

  const [partyId, setPartyId] = useState(existing?.partyId || relevantParties[0]?.id || '')
  const [date, setDate] = useState(existing?.date || new Date().toISOString().split('T')[0])
  const [dueDate, setDueDate] = useState(
    existing?.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
  )
  const [tenderRef, setTenderRef] = useState(existing?.tenderReference || '')
  const [notes, setNotes] = useState(existing?.notes || 'Standard 30 days payment terms.')

  const [items, setItems] = useState<InvoiceItem[]>(
    existing?.items || [
      {
        id: `item-${Date.now()}`,
        itemCode: 'ITEM-01',
        description: 'Professional Engineering & Site Supervision',
        accountId: relevantAccounts[0]?.id || 'acc-sales',
        accountName: relevantAccounts[0]?.name || 'Sales',
        qty: 1,
        rate: 50000,
        taxRate: 15,
        amount: 50000,
      },
    ],
  )

  const updateItem = (id: string, field: keyof InvoiceItem, val: any) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it
        const next = { ...it, [field]: val }
        if (field === 'qty' || field === 'rate') {
          next.amount = (Number(next.qty) || 0) * (Number(next.rate) || 0)
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
        accountId: relevantAccounts[0]?.id || 'acc-sales',
        accountName: relevantAccounts[0]?.name || 'Sales',
        qty: 1,
        rate: 15000,
        taxRate: 15,
        amount: 15000,
      },
    ])
  }

  const removeItem = (id: string) => {
    if (items.length <= 1) return
    setItems((prev) => prev.filter((it) => it.id !== id))
  }

  const subtotal = items.reduce((sum, it) => sum + it.amount, 0)
  const taxTotal = items.reduce((sum, it) => sum + (it.amount * it.taxRate) / 100, 0)
  const grandTotal = subtotal + taxTotal

  const handleSave = async (status: 'Draft' | 'Unpaid') => {
    const selectedParty = data.parties.find((p) => p.id === partyId)
    await saveInvoice({
      id: existing?.id,
      type,
      partyId,
      partyName: selectedParty?.name || 'Client',
      date,
      dueDate,
      tenderReference: tenderRef.trim() || undefined,
      notes,
      items,
      status,
    })
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Top Header */}
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#EDEDED]">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveInvoiceId(null)}
            className="p-2 text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3] rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-[#1E293B]">
              {existing ? `Edit ${existing.invoiceNumber}` : `New ${type === 'Sales' ? 'Sales Invoice' : 'Purchase Bill'}`}
            </h1>
            <p className="text-xs text-[#7C7C7C] mt-0.5">
              {type === 'Sales' ? 'Bill a client or won tender contract' : 'Record an operational vendor expense'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {existing && (
            <button
              onClick={() => setPrintInvoice(existing)}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold text-[#1E293B] bg-white border border-[#EDEDED] hover:bg-[#F8F8F8] transition-colors"
            >
              <Printer className="w-4 h-4" />
              Print / PDF
            </button>
          )}

          <button
            onClick={() => handleSave('Draft')}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold text-[#1E293B] bg-white border border-[#EDEDED] hover:bg-[#F8F8F8] transition-colors"
          >
            Save Draft
          </button>

          <button
            onClick={() => handleSave('Unpaid')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] shadow-xs transition-colors"
          >
            <Save className="w-4 h-4" />
            Submit & Post
          </button>
        </div>
      </div>

      {/* Form Fields Card */}
      <div className="bg-white rounded-xl border border-[#EDEDED] p-6 mb-6 shadow-xs">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-semibold text-[#525252] mb-1.5">
              {type === 'Sales' ? 'Customer' : 'Supplier'}
            </label>
            <select
              value={partyId}
              onChange={(e) => setPartyId(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
            >
              {relevantParties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#525252] mb-1.5">Invoice Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#525252] mb-1.5">Payment Due Date</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#525252] mb-1.5">
              Tender / Contract Ref <span className="text-[#7C7C7C] font-normal">(Optional)</span>
            </label>
            <input
              type="text"
              placeholder="e.g. RFP-WTR-2026-04"
              value={tenderRef}
              onChange={(e) => setTenderRef(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
            />
          </div>
        </div>
      </div>

      {/* Itemized Line Items Table */}
      <div className="bg-white rounded-xl border border-[#EDEDED] shadow-xs overflow-hidden mb-6">
        <div className="px-6 py-3.5 bg-[#F8F8F8] border-b border-[#EDEDED] flex items-center justify-between">
          <span className="text-xs font-bold text-[#1E293B] uppercase tracking-wider">Line Items</span>
          <button
            onClick={addItem}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#007BE0] hover:underline"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Row
          </button>
        </div>

        <table className="w-full text-left text-xs">
          <thead className="bg-[#F8F8F8] font-semibold text-[#7C7C7C] border-b border-[#EDEDED]">
            <tr>
              <th className="px-6 py-2.5 w-1/3">Description</th>
              <th className="px-4 py-2.5">Account</th>
              <th className="px-4 py-2.5 text-right w-20">Qty</th>
              <th className="px-4 py-2.5 text-right w-28">Rate (excl)</th>
              <th className="px-4 py-2.5 text-right w-20">VAT %</th>
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
                    onChange={(e) => updateItem(it.id, 'taxRate', parseFloat(e.target.value))}
                    className="w-full px-1.5 py-1.5 text-right bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none focus:border-[#1E293B]"
                  >
                    <option value={15}>15%</option>
                    <option value={0}>0%</option>
                  </select>
                </td>
                <td className="px-6 py-2.5 text-right font-semibold text-[#1E293B]">
                  {data.settings.currencySymbol} {it.amount.toFixed(2)}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <button
                    onClick={() => removeItem(it.id)}
                    className="text-[#7C7C7C] hover:text-[#E03636] p-1 rounded transition-colors"
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
          <label className="block text-xs font-semibold text-[#525252] mb-2">Terms & Banking Details</label>
          <textarea
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
          />
        </div>

        <div className="bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs flex flex-col justify-between">
          <div className="space-y-2.5 text-xs">
            <div className="flex justify-between text-[#7C7C7C]">
              <span>Subtotal</span>
              <span className="font-semibold text-[#1E293B]">{data.settings.currencySymbol} {subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-[#7C7C7C]">
              <span>VAT / Tax (15%)</span>
              <span className="font-semibold text-[#1E293B]">{data.settings.currencySymbol} {taxTotal.toFixed(2)}</span>
            </div>
            <div className="pt-3 border-t border-[#EDEDED] flex justify-between text-sm font-bold text-[#1E293B]">
              <span>Grand Total</span>
              <span className="text-base text-[#10B981]">{data.settings.currencySymbol} {grandTotal.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

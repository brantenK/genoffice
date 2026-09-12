import React, { useMemo, useState } from 'react'
import { Banknote, Plus, Trash2, ArrowDownLeft, ArrowUpRight, CheckCircle2 } from 'lucide-react'
import { useBooksStore } from '../store'
import { round2 } from '../../../shared/accounting'
import type { Payment } from '../../../shared/types'

const PAYMENT_METHODS = ['Bank Transfer', 'Cash', 'Card', 'Other']

export function PaymentsView() {
  const { data, recordPayment, deletePayment } = useBooksStore()
  const { settings } = data

  const [showModal, setShowModal] = useState(false)
  const [mode, setMode] = useState<'payment' | 'refund'>('payment')
  const [partyId, setPartyId] = useState('')
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [method, setMethod] = useState('Bank Transfer')
  const [reference, setReference] = useState('')
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  const payments = useMemo(
    () =>
      [...(data.payments || [])].sort(
        (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
      ),
    [data.payments],
  )

  // Payment mode: open invoices with a positive outstanding. Refund mode:
  // the party's open sales credit notes (negative outstanding = credit).
  const openInvoices = useMemo(() => {
    if (!partyId) return []
    return data.invoices.filter((inv) => {
      if (inv.partyId !== partyId || inv.status === 'Draft' || inv.status === 'Cancelled') {
        return false
      }
      const outstanding = round2(inv.outstandingAmount ?? inv.grandTotal)
      if (mode === 'refund') {
        return Boolean(inv.creditNote) && inv.type === 'Sales' && outstanding < 0
      }
      return outstanding > 0
    })
  }, [data.invoices, partyId, mode])

  const total = round2(
    Object.entries(amounts).reduce((s, [invId, amt]) => {
      if (!openInvoices.some((i) => i.id === invId)) return s
      return s + (Number(amt) || 0)
    }, 0),
  )

  const formatMoney = (val: number) => {
    return `${settings.currencySymbol || 'R'} ${val.toLocaleString('en-ZA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev))
    }, 4500)
  }

  const handlePartyChange = (id: string) => {
    setPartyId(id)
    const next: Record<string, string> = {}
    for (const inv of data.invoices) {
      if (inv.partyId !== id || inv.status === 'Draft' || inv.status === 'Cancelled') continue
      const outstanding = round2(inv.outstandingAmount ?? inv.grandTotal)
      const isTarget =
        mode === 'refund'
          ? Boolean(inv.creditNote) && inv.type === 'Sales' && outstanding < 0
          : outstanding > 0
      if (isTarget) {
        next[inv.id] = round2(Math.abs(outstanding)).toFixed(2)
      }
    }
    setAmounts(next)
  }

  const handleModeChange = (nextMode: 'payment' | 'refund') => {
    setMode(nextMode)
    setAmounts({})
    if (partyId) {
      // Re-derive the auto amounts for the new mode.
      const next: Record<string, string> = {}
      for (const inv of data.invoices) {
        if (inv.partyId !== partyId || inv.status === 'Draft' || inv.status === 'Cancelled') {
          continue
        }
        const outstanding = round2(inv.outstandingAmount ?? inv.grandTotal)
        const isTarget =
          nextMode === 'refund'
            ? Boolean(inv.creditNote) && inv.type === 'Sales' && outstanding < 0
            : outstanding > 0
        if (isTarget) {
          next[inv.id] = round2(Math.abs(outstanding)).toFixed(2)
        }
      }
      setAmounts(next)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!partyId) return
    const allocations = openInvoices
      .map((inv) => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount: round2(Number(amounts[inv.id]) || 0),
      }))
      .filter((a) => a.amount > 0)
    if (allocations.length === 0) {
      showToast(
        mode === 'refund'
          ? 'Enter an amount for at least one credit note'
          : 'Enter an amount for at least one open invoice',
      )
      return
    }
    setSaving(true)
    try {
      const res = await recordPayment({
        partyId,
        date,
        type: mode === 'refund' ? 'refund' : undefined,
        method,
        reference: reference.trim() || undefined,
        allocations,
      })
      if (res.ok) {
        setShowModal(false)
        setPartyId('')
        setAmounts({})
        setReference('')
        setMethod('Bank Transfer')
        setMode('payment')
      } else {
        showToast(
          res.error || (mode === 'refund' ? 'Failed to record refund' : 'Failed to record payment'),
        )
      }
    } catch (err: any) {
      showToast(
        err?.message ||
          (mode === 'refund' ? 'Failed to record refund' : 'Failed to record payment'),
      )
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (payment: Payment) => {
    const confirmed = window.confirm(
      `Delete payment of ${formatMoney(payment.total)} from ${payment.partyName}? ` +
        'This restores the invoice outstanding amounts and reverses the journal entry.',
    )
    if (!confirmed) return
    await deletePayment(payment.id)
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 bg-[#1E293B] text-white text-xs rounded-xl shadow-lg border border-[#334155] animate-in fade-in slide-in-from-top-2 duration-200">
          <CheckCircle2 className="w-4 h-4 text-[#30A66D] flex-shrink-0" />
          <span>{toastMessage}</span>
          <button
            onClick={() => setToastMessage(null)}
            className="ml-2 text-white/60 hover:text-white text-xs font-semibold"
          >
            ×
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B] tracking-tight">Payments</h1>
          <p className="text-sm text-[#7C7C7C] mt-0.5">
            Money received from customers and paid to suppliers — posted straight into the ledger
            for {settings.companyName}
          </p>
        </div>

        <button
          onClick={() => {
            setMode('payment')
            setShowModal(true)
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] shadow-xs transition-colors"
        >
          <Plus className="w-4 h-4" />
          Record Payment / Refund
        </button>
      </div>

      {/* Payments table */}
      <div className="bg-white border border-[#EDEDED] rounded-xl overflow-hidden shadow-xs">
        <div className="p-4 border-b border-[#EDEDED] bg-[#FAFAFA] flex items-center justify-between">
          <div className="text-xs text-[#7C7C7C]">
            {payments.length} payment{payments.length === 1 ? '' : 's'} recorded
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#EDEDED] bg-[#F8F8F8] text-[#7C7C7C] font-semibold">
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Party</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Method / Reference</th>
                <th className="py-3 px-4">Allocations</th>
                <th className="py-3 px-4 text-right">Total</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EDEDED]">
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#7C7C7C]">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Banknote className="w-8 h-8 text-[#CBD5E1]" />
                      <div className="font-semibold text-sm text-[#475569]">
                        No payments recorded yet
                      </div>
                      <p className="text-xs text-[#94A3B8] max-w-sm">
                        Record money received from customers or paid to suppliers against their open
                        invoices. Every payment posts a balanced journal entry, so the ledger always
                        reflects reality.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                payments.map((payment) => (
                  <tr key={payment.id} className="hover:bg-[#FBFBFB] transition-colors">
                    <td className="py-3 px-4 font-mono text-[#525252] whitespace-nowrap">
                      {payment.date}
                    </td>
                    <td className="py-3 px-4 font-medium text-[#1E293B]">{payment.partyName}</td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {payment.type === 'received' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]">
                          <ArrowDownLeft className="w-3 h-3" /> Received
                        </span>
                      ) : payment.type === 'refund' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#FFF7F7] text-[#E03636] border border-[#FCD7D7]">
                          <ArrowUpRight className="w-3 h-3" /> Refund
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#EFF6FF] text-[#2563EB] border border-[#BFDBFE]">
                          <ArrowUpRight className="w-3 h-3" /> Paid
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-[#64748B] whitespace-nowrap">
                      {payment.method || '—'}
                      {payment.reference ? (
                        <span className="text-[#94A3B8]"> · {payment.reference}</span>
                      ) : null}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex flex-wrap gap-1">
                        {payment.allocations.map((alloc) => (
                          <span
                            key={alloc.invoiceId}
                            className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[#F1F5F9] text-[#475569] border border-[#E2E8F0]"
                          >
                            {alloc.invoiceNumber}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-[#1E293B] whitespace-nowrap">
                      {formatMoney(payment.total)}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <button
                        onClick={() => handleDelete(payment)}
                        title="Delete payment and reverse its journal entry"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-[#DC2626] bg-[#FEF2F2] hover:bg-[#FEE2E2] border border-[#FECACA] transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Record Payment / Refund Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-xl border border-[#EDEDED] max-h-[90vh] overflow-y-auto custom-scroll">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-bold text-[#1E293B]">
                {mode === 'refund' ? 'Record Refund' : 'Record Payment'}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="w-7 h-7 rounded-lg text-[#7C7C7C] hover:bg-[#F3F3F3] hover:text-[#1E293B] text-lg leading-none"
              >
                ×
              </button>
            </div>
            <p className="text-xs text-[#7C7C7C] mb-4">
              {mode === 'refund'
                ? "Pay back a customer's credit balance against their open credit notes. Posts a balanced journal entry (Bank credited, Accounts Receivable debited)."
                : "Allocate money against the party's open invoices. The payment posts a balanced journal entry (Bank vs Accounts Receivable/Payable)."}
            </p>

            {/* Payment / Refund mode toggle */}
            <div className="flex items-center gap-1 bg-[#F1F5F9] p-1 rounded-lg w-fit mb-4">
              <button
                type="button"
                onClick={() => handleModeChange('payment')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  mode === 'payment' ? 'bg-white text-[#1E293B] shadow-xs' : 'text-[#64748B]'
                }`}
              >
                Payment
              </button>
              <button
                type="button"
                onClick={() => handleModeChange('refund')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  mode === 'refund' ? 'bg-white text-[#1E293B] shadow-xs' : 'text-[#64748B]'
                }`}
              >
                Refund
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="block font-semibold text-[#525252] mb-1">
                    Customer / Supplier *
                  </label>
                  <select
                    required
                    value={partyId}
                    onChange={(e) => handlePartyChange(e.target.value)}
                    className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                  >
                    <option value="">Select a party...</option>
                    {data.parties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.type})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-[#525252] mb-1">Date</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-[#525252] mb-1">Payment Method</label>
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-[#525252] mb-1">
                    Reference (optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. EFT-2026-001"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-[#525252] mb-1">
                  {mode === 'refund'
                    ? 'Allocations — open credit notes'
                    : 'Allocations — open invoices'}
                </label>
                {openInvoices.length === 0 ? (
                  <div className="text-xs text-[#94A3B8] bg-[#F8FAFC] border border-[#F1F5F9] rounded-lg p-4">
                    {mode === 'refund'
                      ? 'No open credit notes for this party. Issue a credit note from the invoice list first.'
                      : 'No open invoices for this party. Pick a party with an unpaid invoice or bill, or create one first.'}
                  </div>
                ) : (
                  <div className="border border-[#EDEDED] rounded-lg divide-y divide-[#EDEDED]">
                    {openInvoices.map((inv) => {
                      const outstanding = round2(Math.abs(inv.outstandingAmount ?? inv.grandTotal))
                      return (
                        <div
                          key={inv.id}
                          className="flex items-center justify-between gap-3 px-4 py-3 bg-[#FBFBFB]"
                        >
                          <div>
                            <div className="font-semibold text-[#1E293B]">{inv.invoiceNumber}</div>
                            <div className="text-[11px] text-[#7C7C7C]">
                              {mode === 'refund'
                                ? 'Credit note'
                                : inv.type === 'Sales'
                                  ? 'Invoice'
                                  : 'Bill'}{' '}
                              · {inv.date} ·{' '}
                              {mode === 'refund' ? 'Credit available ' : 'Outstanding '}
                              {formatMoney(outstanding)}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[#7C7C7C]">{settings.currencySymbol || 'R'}</span>
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              value={amounts[inv.id] ?? ''}
                              onChange={(e) => setAmounts({ ...amounts, [inv.id]: e.target.value })}
                              className="w-36 px-3 py-1.5 text-right font-semibold bg-white border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between border-t border-[#EDEDED] pt-4">
                <div className="text-sm font-semibold text-[#7C7C7C]">
                  Total {mode === 'refund' ? 'refund' : 'payment'}:{' '}
                  <span className="text-lg font-bold text-[#1E293B]">{formatMoney(total)}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="px-4 py-2 rounded-lg font-semibold text-[#525252] bg-[#F3F3F3] hover:bg-[#E2E2E2]"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving || openInvoices.length === 0}
                    className="px-4 py-2 rounded-lg font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] disabled:opacity-50"
                  >
                    {saving
                      ? mode === 'refund'
                        ? 'Recording...'
                        : 'Recording...'
                      : mode === 'refund'
                        ? 'Record Refund'
                        : 'Record Payment'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

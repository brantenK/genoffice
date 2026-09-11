import React, { useState } from 'react'
import { RotateCcw, ShieldAlert } from 'lucide-react'
import { useBooksStore } from '../store'
import { round2 } from '../../../shared/accounting'
import type { Invoice, InvoiceItem } from '../../../shared/types'

interface CreditNoteModalProps {
  original: Invoice
  onClose: () => void
}

/**
 * Issues a credit note against a posted invoice. Defaults to the full
 * invoice amount; partial amounts scale the original line items
 * proportionally so the credit note's totals always match the request and
 * validation (capped at the original total, cumulative across credit notes).
 */
export function CreditNoteModal({ original, onClose }: CreditNoteModalProps) {
  const { data, saveCreditNote } = useBooksStore()
  const { settings } = data

  const [amount, setAmount] = useState(String(original.grandTotal))
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const formatMoney = (val: number) =>
    `${settings.currencySymbol || 'R'} ${val.toLocaleString('en-ZA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const target = round2(Number(amount) || 0)
    if (target <= 0) {
      setError('Credit note amount must be greater than zero.')
      return
    }
    if (target > original.grandTotal) {
      setError(`Cannot credit more than the original total (${formatMoney(original.grandTotal)}).`)
      return
    }

    // Scale the original line items proportionally to the requested amount.
    const scale = target / original.grandTotal
    const items: InvoiceItem[] = original.items.map((it, idx) => {
      const newAmount = round2((it.amount || 0) * scale)
      return {
        ...it,
        id: `cn-item-${Date.now()}-${idx}`,
        amount: newAmount,
        rate: it.qty ? round2(newAmount / it.qty) : newAmount,
      }
    })

    setSaving(true)
    setError(null)
    try {
      const res = await saveCreditNote({
        originalInvoiceId: original.id,
        date,
        items,
        notes: notes.trim() || undefined,
      })
      if (res.ok) {
        onClose()
      } else {
        setError(res.error || 'Failed to issue credit note')
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to issue credit note')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-[#EDEDED]">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-[#1E293B] flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-[#0F766E]" />
            Issue Credit Note
          </h2>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-[#7C7C7C] hover:bg-[#F3F3F3] hover:text-[#1E293B] text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="text-xs text-[#7C7C7C] mb-5">
          Reverses <span className="font-semibold text-[#1E293B]">{original.invoiceNumber}</span>{' '}
          for <span className="font-semibold text-[#1E293B]">{original.partyName}</span> — the
          ledger posts a balanced reversal journal (Accounts Receivable credited, income and VAT
          debited).
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 px-4 py-3 rounded-lg bg-[#FFF7F7] border border-[#FCD7D7] text-xs font-medium text-[#E03636]">
            <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-[#525252] mb-1">Amount (VAT incl.)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#7C7C7C]">
                  {settings.currencySymbol || 'R'}
                </span>
                <input
                  type="number"
                  min={0.01}
                  step="0.01"
                  max={original.grandTotal}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B] font-semibold"
                />
              </div>
              <div className="text-[11px] text-[#7C7C7C] mt-1">
                Original total: {formatMoney(original.grandTotal)}
              </div>
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

          <div>
            <label className="block font-semibold text-[#525252] mb-1">
              Notes <span className="text-[#7C7C7C] font-normal">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder={`Credit note against ${original.invoiceNumber}`}
              className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
            />
          </div>

          <div className="flex items-center justify-between border-t border-[#EDEDED] pt-4">
            <div className="text-sm font-semibold text-[#7C7C7C]">
              Credit amount:{' '}
              <span className="text-lg font-bold text-[#0F766E]">
                {formatMoney(round2(Number(amount) || 0))}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg font-semibold text-[#525252] bg-[#F3F3F3] hover:bg-[#E2E2E2]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg font-semibold text-white bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-50"
              >
                {saving ? 'Issuing...' : 'Issue Credit Note'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

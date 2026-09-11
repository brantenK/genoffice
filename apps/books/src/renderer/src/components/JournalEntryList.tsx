import React, { useState } from 'react'
import { Plus, Trash2, CheckCircle2, AlertCircle } from 'lucide-react'
import { useBooksStore } from '../store'
import type { JournalEntryItem } from '../../../shared/types'

export function JournalEntryList() {
  const { data, addJournalEntry } = useBooksStore()
  const { journalEntries, accounts, settings } = data

  const [showModal, setShowModal] = useState(false)
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [remarks, setRemarks] = useState('')

  const [items, setItems] = useState<JournalEntryItem[]>([
    {
      id: '1',
      accountId: accounts[0]?.id || '',
      accountName: accounts[0]?.name || '',
      debit: 0,
      credit: 0,
      remark: '',
    },
    {
      id: '2',
      accountId: accounts[1]?.id || '',
      accountName: accounts[1]?.name || '',
      debit: 0,
      credit: 0,
      remark: '',
    },
  ])

  const formatMoney = (val: number) => {
    return `${settings.currencySymbol} ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const updateItem = (id: string, field: keyof JournalEntryItem, val: any) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it
        const next = { ...it, [field]: val }
        if (field === 'accountId') {
          const acc = accounts.find((a) => a.id === val)
          if (acc) next.accountName = acc.name
        }
        return next
      }),
    )
  }

  const addRow = () => {
    setItems((prev) => [
      ...prev,
      {
        id: String(Date.now()),
        accountId: accounts[0]?.id || '',
        accountName: accounts[0]?.name || '',
        debit: 0,
        credit: 0,
        remark: '',
      },
    ])
  }

  const removeRow = (id: string) => {
    if (items.length <= 2) return
    setItems((prev) => prev.filter((it) => it.id !== id))
  }

  const totalDebit = items.reduce((sum, it) => sum + (Number(it.debit) || 0), 0)
  const totalCredit = items.reduce((sum, it) => sum + (Number(it.credit) || 0), 0)
  const isBalanced = totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.01

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isBalanced) return

    await addJournalEntry({
      entryNumber: '',
      date,
      items,
      totalDebit,
      totalCredit,
      remarks,
    })

    setShowModal(false)
    setRemarks('')
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B] tracking-tight">Journal Entries</h1>
          <p className="text-sm text-[#7C7C7C] mt-0.5">
            Manual double-entry adjustment vouchers & opening balance entries
          </p>
        </div>

        <button
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] shadow-xs transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Journal Entry
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-[#EDEDED] shadow-xs overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#F8F8F8] text-xs font-semibold text-[#7C7C7C] border-b border-[#EDEDED]">
            <tr>
              <th className="px-6 py-3">Entry No</th>
              <th className="px-6 py-3">Date</th>
              <th className="px-6 py-3">Remarks</th>
              <th className="px-6 py-3 text-right">Debit Total</th>
              <th className="px-6 py-3 text-right">Credit Total</th>
              <th className="px-6 py-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EDEDED]">
            {journalEntries.map((je) => (
              <tr key={je.id} className="hover:bg-[#FBFBFB]">
                <td className="px-6 py-3.5 font-mono text-xs font-semibold text-[#1E293B]">
                  {je.entryNumber}
                </td>
                <td className="px-6 py-3.5 text-xs text-[#7C7C7C]">{je.date}</td>
                <td className="px-6 py-3.5 text-xs text-[#525252]">
                  {je.remarks || 'Standard posting'}
                </td>
                <td className="px-6 py-3.5 text-right font-mono text-xs font-bold text-[#1E293B]">
                  {formatMoney(je.totalDebit)}
                </td>
                <td className="px-6 py-3.5 text-right font-mono text-xs font-bold text-[#1E293B]">
                  {formatMoney(je.totalCredit)}
                </td>
                <td className="px-6 py-3.5 text-center">
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#F3FCF5] text-[#30A66D] border border-[#DAF0E1]">
                    <CheckCircle2 className="w-3 h-3" /> Posted
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* New Journal Entry Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-xl border border-[#EDEDED]">
            <h2 className="text-lg font-bold text-[#1E293B] mb-4">
              Record Double-Entry Journal Voucher
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold text-[#525252] mb-1">Posting Date</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-[#525252] mb-1">
                    Remarks / Reference
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Bank charges or depreciation"
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                  />
                </div>
              </div>

              {/* Rows */}
              <div className="border border-[#EDEDED] rounded-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-[#F8F8F8] text-[#7C7C7C] font-semibold border-b border-[#EDEDED]">
                    <tr>
                      <th className="px-3 py-2">Account</th>
                      <th className="px-3 py-2 text-right w-28">Debit</th>
                      <th className="px-3 py-2 text-right w-28">Credit</th>
                      <th className="px-2 py-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#EDEDED]">
                    {items.map((it) => (
                      <tr key={it.id}>
                        <td className="p-2">
                          <select
                            value={it.accountId}
                            onChange={(e) => updateItem(it.id, 'accountId', e.target.value)}
                            className="w-full px-2 py-1.5 bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none"
                          >
                            {accounts
                              .filter((a) => !a.isGroup)
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name} ({a.rootType})
                                </option>
                              ))}
                          </select>
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            step="0.01"
                            value={it.debit || ''}
                            onChange={(e) =>
                              updateItem(it.id, 'debit', parseFloat(e.target.value) || 0)
                            }
                            className="w-full px-2 py-1.5 text-right bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            step="0.01"
                            value={it.credit || ''}
                            onChange={(e) =>
                              updateItem(it.id, 'credit', parseFloat(e.target.value) || 0)
                            }
                            className="w-full px-2 py-1.5 text-right bg-[#F8F8F8] border border-[#EDEDED] rounded focus:outline-none"
                          />
                        </td>
                        <td className="p-2 text-center">
                          <button
                            type="button"
                            onClick={() => removeRow(it.id)}
                            className="text-[#7C7C7C] hover:text-[#E03636]"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-between items-center text-xs">
                <button
                  type="button"
                  onClick={addRow}
                  className="text-[#007BE0] hover:underline font-semibold"
                >
                  + Add Row
                </button>
                <div className="flex gap-6 font-mono font-bold">
                  <span>Dr: {formatMoney(totalDebit)}</span>
                  <span>Cr: {formatMoney(totalCredit)}</span>
                </div>
              </div>

              {!isBalanced && totalDebit > 0 && (
                <div className="flex items-center gap-2 p-2.5 bg-[#FFF7F7] text-[#E03636] rounded-lg text-xs">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>
                    Journal entry is out of balance. Total Debits must equal Total Credits.
                  </span>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-3 border-t border-[#EDEDED]">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-lg font-semibold text-[#525252] bg-[#F3F3F3] hover:bg-[#E2E2E2]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!isBalanced}
                  className={`px-4 py-2 rounded-lg font-semibold text-white ${
                    isBalanced
                      ? 'bg-[#1E293B] hover:bg-[#0F172A]'
                      : 'bg-[#C7C7C7] cursor-not-allowed'
                  }`}
                >
                  Post Voucher
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

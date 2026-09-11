import React from 'react'
import { History } from 'lucide-react'
import { useBooksStore } from '../store'

/**
 * Read-only audit trail: every ledger mutation, newest first. Entries are
 * appended by store actions at mutation time and are never edited or removed.
 */
export function AuditLogView() {
  const { data } = useBooksStore()
  const { auditLog, settings } = data
  const entries = auditLog || []

  const formatMoney = (val: number) => {
    return `${settings.currencySymbol} ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const formatTimestamp = (ts: string) => {
    const date = new Date(ts)
    if (isNaN(date.getTime())) return ts
    return date.toLocaleString('en-ZA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B] tracking-tight">Audit Log</h1>
          <p className="text-sm text-[#7C7C7C] mt-0.5">
            Immutable trail of every ledger mutation for {settings.companyName}
          </p>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="bg-white rounded-xl border border-[#EDEDED] shadow-xs p-12 flex flex-col items-center text-center">
          <History className="w-8 h-8 text-[#94A3B8] mb-3" />
          <p className="text-sm font-semibold text-[#525252]">No activity recorded yet</p>
          <p className="text-xs text-[#7C7C7C] mt-1 max-w-sm">
            Every mutation in the ledger will appear here.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-[#EDEDED] shadow-xs overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#F8F8F8] text-xs font-semibold text-[#7C7C7C] border-b border-[#EDEDED]">
              <tr>
                <th className="px-6 py-3">Timestamp</th>
                <th className="px-6 py-3">Action</th>
                <th className="px-6 py-3">Summary</th>
                <th className="px-6 py-3">Invoice</th>
                <th className="px-6 py-3">Payment</th>
                <th className="px-6 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EDEDED]">
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-[#FBFBFB]">
                  <td className="px-6 py-3.5 font-mono text-xs text-[#7C7C7C] whitespace-nowrap">
                    {formatTimestamp(entry.timestamp)}
                  </td>
                  <td className="px-6 py-3.5">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[#F0F4FF] text-[#1E3A8A] border border-[#DBE4FF]">
                      {entry.action}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 text-xs text-[#525252]">{entry.summary}</td>
                  <td className="px-6 py-3.5 font-mono text-xs text-[#1E293B]">
                    {entry.invoiceNumber || '—'}
                  </td>
                  <td className="px-6 py-3.5 font-mono text-xs text-[#1E293B]">
                    {entry.paymentId || '—'}
                  </td>
                  <td className="px-6 py-3.5 text-right font-mono text-xs font-bold text-[#1E293B]">
                    {entry.amount !== undefined ? formatMoney(entry.amount) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

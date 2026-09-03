// Contract Milestones Drawer: Delivery progress & Zano Books billing integration
import { useState } from 'react'
import {
  Award,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Plus,
  Receipt,
  Sparkles,
  X,
  Zap
} from 'lucide-react'
import { selectActiveTender, useTendersStore } from '../store'
import type { ContractMilestone, MilestoneBillingStatus } from '../../shared/types'
import { Badge, Button, Spinner } from './ui'

export function MilestonesDrawer({ onClose }: { onClose: () => void }) {
  const tender = useTendersStore(selectActiveTender)
  const updateTender = useTendersStore((s) => s.updateTender)
  const [billingMilestoneId, setBillingMilestoneId] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!tender) return null

  const milestones = tender.milestones || []
  const totalAmount = milestones.reduce((sum, m) => sum + (Number(m.amount) || 0), 0)
  const billedAmount = milestones
    .filter((m) => m.status === 'BILLED' || m.status === 'PAID')
    .reduce((sum, m) => sum + (Number(m.amount) || 0), 0)
  const reachedAmount = milestones
    .filter((m) => m.status === 'REACHED')
    .reduce((sum, m) => sum + (Number(m.amount) || 0), 0)

  const handleBill = async (milestone: ContractMilestone) => {
    setBillingMilestoneId(milestone.id)
    setError(null)
    setToastMessage(null)
    try {
      const res = await window.tendersApi?.billMilestoneInBooks(tender.id, milestone.id)
      if (res && res.ok) {
        const nowIso = new Date().toISOString()
        const updatedMilestones = (tender.milestones || []).map((m) =>
          m.id === milestone.id
            ? {
                ...m,
                status: 'BILLED' as MilestoneBillingStatus,
                billedInvoiceId: res.invoiceId,
                billedInvoiceNumber: res.invoiceNumber,
                billedAt: nowIso,
                billedDate: nowIso,
              }
            : m
        )
        updateTender(tender.id, { milestones: updatedMilestones })
        setToastMessage(`Tax Invoice ${res.invoiceNumber || res.invoiceId} successfully created in Zano Books!`)
        // Switch tab to Books
        await window.tendersApi?.openBooks?.()
      } else {
        setError(res?.error || 'Failed to bill milestone in Zano Books.')
      }
    } catch (e: any) {
      setError(e?.message || 'Error occurred while creating invoice in Zano Books.')
    } finally {
      setBillingMilestoneId(null)
    }
  }

  const handleOpenBooks = async () => {
    await window.tendersApi?.openBooks?.()
  }

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[440px] max-w-[92%] flex-col border-l border-slate-200 bg-white shadow-2xl">
      {/* Drawer Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 ring-1 ring-indigo-200">
            <Award size={18} />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900">Contract Milestones</h2>
            <p className="text-[11px] text-slate-500">Zano Books Milestone Billing Bridge</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} title="Close Milestones">
          <X size={15} />
        </Button>
      </div>

      {/* Progress & Valuation Banner */}
      <div className="shrink-0 border-b border-slate-100 bg-gradient-to-br from-indigo-50/70 via-slate-50 to-emerald-50/50 p-4">
        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>Total Contract Valuation</span>
          <span className="font-bold text-slate-900">
            R {totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full bg-indigo-600 transition-all duration-300"
            style={{ width: `${totalAmount > 0 ? Math.min(100, Math.round((billedAmount / totalAmount) * 100)) : 0}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span className="text-indigo-700 font-medium">
            Billed: R {billedAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          {reachedAmount > 0 && (
            <span className="text-amber-700 font-medium">
              Ready to Bill: R {reachedAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
      </div>

      {/* Toast Notification */}
      {toastMessage && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 animate-in fade-in">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" />
          <div className="flex-1 font-medium">{toastMessage}</div>
          <button onClick={() => setToastMessage(null)} className="text-emerald-600 hover:text-emerald-800">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Error Notification */}
      {error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 animate-in fade-in">
          <X size={16} className="mt-0.5 shrink-0 text-red-600" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)} className="text-red-600 hover:text-red-800">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Milestones List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {milestones.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-slate-400">
            <Award size={32} className="mb-2 stroke-[1.5] text-slate-300" />
            <p className="text-sm font-medium text-slate-600">No contract milestones defined</p>
            <p className="mt-1 text-xs text-slate-400">
              Contract delivery milestones track progressive project phases and generate Books tax invoices.
            </p>
          </div>
        ) : (
          milestones.map((ms, index) => {
            const isReached = ms.status === 'REACHED'
            const isBilled = ms.status === 'BILLED'
            const isPaid = ms.status === 'PAID'
            const isPending = ms.status === 'PENDING'
            const isCurrentBilling = billingMilestoneId === ms.id

            return (
              <div
                key={ms.id || index}
                className={`rounded-xl border p-4 transition-all ${
                  isBilled
                    ? 'border-indigo-100 bg-slate-50/60'
                    : isReached
                      ? 'border-indigo-200 bg-indigo-50/20 ring-1 ring-indigo-200/50'
                      : 'border-slate-200 bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-slate-400">Phase {index + 1}</span>
                      {isReached && <Badge tone="indigo">Ready to Bill</Badge>}
                      {isBilled && <Badge tone="violet">Billed</Badge>}
                      {isPaid && <Badge tone="green">Paid</Badge>}
                      {isPending && <Badge tone="amber">Pending</Badge>}
                    </div>
                    <h3 className="mt-1 font-semibold text-sm text-slate-900 leading-snug">
                      {ms.name || ms.title || 'Milestone'}
                    </h3>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-bold text-slate-900">
                      R {Number(ms.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <div className="text-[10px] text-slate-500">incl. 15% VAT</div>
                  </div>
                </div>

                {ms.description && (
                  <p className="mt-2 text-xs text-slate-600 leading-relaxed">
                    {ms.description}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
                  <div className="flex items-center gap-3">
                    {ms.dueDate && (
                      <span className="inline-flex items-center gap-1">
                        <Clock size={12} /> Due: {ms.dueDate}
                      </span>
                    )}
                    {ms.billedAt && (
                      <span className="inline-flex items-center gap-1 text-slate-400">
                        Billed: {new Date(ms.billedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>

                  {/* Actions based on Milestone Status */}
                  <div>
                    {isReached && (
                      <button
                        type="button"
                        disabled={isCurrentBilling}
                        onClick={() => handleBill(ms)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors disabled:opacity-50"
                      >
                        {isCurrentBilling ? (
                          <>
                            <Spinner /> Invoicing…
                          </>
                        ) : (
                          <>
                            <Zap size={13} className="text-amber-300" /> Bill Milestone in Zano Books
                          </>
                        )}
                      </button>
                    )}

                    {isBilled && (
                      <button
                        type="button"
                        onClick={handleOpenBooks}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
                        title="Open invoice in Zano Books"
                      >
                        <FileText size={12} />
                        <span>{ms.billedInvoiceNumber || 'View in Books'}</span>
                        <ExternalLink size={10} className="text-indigo-400" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Drawer Footer */}
      <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-3">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={handleOpenBooks}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            <Receipt size={13} /> View all invoices in Zano Books
          </button>
          <Button variant="default" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </aside>
  )
}

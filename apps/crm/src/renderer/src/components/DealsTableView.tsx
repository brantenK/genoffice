import React, { useState } from 'react'
import { EmptyState } from './EmptyState'
import { DealDetail } from './DealDetail'
import type { Deal, DealStage } from '../../../shared/types'
import {
  BuildingIcon,
  EditIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  TenderIcon,
  TrashIcon,
} from './Icons'

interface DealsTableViewProps {
  deals: Deal[]
  onEditDeal: (deal: Deal) => void
  onUpdateStage: (id: string, stage: DealStage) => void
  onDeleteDeal: (id: string) => void
  onGenerateProposal: (dealId: string) => void
  onInvoiceCreated?: (dealId: string, invoiceNumber: string) => void
  onShowToast?: (msg: string, error?: boolean) => void
  onRefresh?: () => Promise<void>
}

const STAGES: { key: DealStage; label: string; color: string }[] = [
  { key: 'lead', label: 'Lead', color: '#64748b' },
  { key: 'qualified', label: 'Qualified', color: '#0284c7' },
  { key: 'proposal', label: 'Proposal', color: '#d97706' },
  { key: 'negotiation', label: 'Negotiation', color: '#7c3aed' },
  { key: 'won', label: 'Closed Won', color: '#059669' },
  { key: 'lost', label: 'Closed Lost', color: '#dc2626' },
]

export function DealsTableView({
  deals,
  onEditDeal,
  onUpdateStage,
  onDeleteDeal,
  onGenerateProposal,
  onInvoiceCreated,
  onShowToast,
  onRefresh,
}: DealsTableViewProps) {
  const [filterStage, setFilterStage] = useState<DealStage | 'all'>('all')
  const [invoicingDealId, setInvoicingDealId] = useState<string | null>(null)
  const [localInvoices, setLocalInvoices] = useState<Record<string, string>>({})
  const [localToast, setLocalToast] = useState<string | null>(null)
  const [stageSavingId, setStageSavingId] = useState<string | null>(null)
  const [activeMenuDealId, setActiveMenuDealId] = useState<string | null>(null)
  const [detailDealId, setDetailDealId] = useState<string | null>(null)
  const detailDeal = detailDealId ? deals.find((deal) => deal.id === detailDealId) : undefined

  React.useEffect(() => {
    if (detailDealId && !detailDeal) setDetailDealId(null)
  }, [detailDeal, detailDealId])

  React.useEffect(() => {
    if (!activeMenuDealId) return

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.crm-overflow-wrap')) setActiveMenuDealId(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveMenuDealId(null)
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [activeMenuDealId])

  React.useEffect(() => {
    let mounted = true
    const refresh = async () => {
      try {
        if (onRefresh) await onRefresh()
      } catch (error: unknown) {
        if (mounted) {
          onShowToast?.(
            error instanceof Error ? error.message : 'Could not refresh opportunities',
            true,
          )
        }
      }
    }

    const onFocus = () => void refresh()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = setInterval(refresh, 30000)

    return () => {
      mounted = false
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(timer)
    }
  }, [onRefresh, onShowToast])

  const handleCreateInvoice = async (deal: Deal) => {
    if (invoicingDealId) return
    setInvoicingDealId(deal.id)
    try {
      const res = await window.crmApi?.createInvoiceInBooks(deal.id)
      if (res?.ok && res.invoiceNumber) {
        setLocalInvoices((prev) => ({ ...prev, [deal.id]: res.invoiceNumber! }))
        const msg = `Invoice ${res.invoiceNumber} created in Zano Books`
        if (onShowToast) {
          onShowToast(msg)
        } else {
          setLocalToast(msg)
          setTimeout(() => setLocalToast(null), 3000)
        }
        onInvoiceCreated?.(deal.id, res.invoiceNumber)
        try {
          await onRefresh?.()
        } catch (error: unknown) {
          onShowToast?.(
            error instanceof Error ? error.message : 'Could not refresh opportunities',
            true,
          )
        }
      } else if (res?.error) {
        const errMsg = res.error
        if (onShowToast) {
          onShowToast(errMsg)
        } else {
          setLocalToast(errMsg)
          setTimeout(() => setLocalToast(null), 3000)
        }
      }
    } catch (err: unknown) {
      console.error('Failed to create invoice in Books:', err)
      onShowToast?.(err instanceof Error ? err.message : 'Failed to create invoice in Books', true)
    } finally {
      setInvoicingDealId(null)
    }
  }

  const filtered = deals.filter((d) => (filterStage === 'all' ? true : d.stage === filterStage))
  const handleStageChange = async (deal: Deal, stage: DealStage) => {
    setStageSavingId(deal.id)
    try {
      await onUpdateStage(deal.id, stage)
    } catch (error: unknown) {
      onShowToast?.(
        error instanceof Error ? error.message : 'Could not update opportunity stage',
        true,
      )
    } finally {
      setStageSavingId(null)
    }
  }

  return (
    <>
      <div className="crm-table-container">
        <div className="crm-table-toolbar">
          <div className="crm-filter-pills">
            <button
              className={`crm-filter-pill ${filterStage === 'all' ? 'active' : ''}`}
              onClick={() => setFilterStage('all')}
            >
              All Deals ({deals.length})
            </button>
            {STAGES.map((st) => (
              <button
                key={st.key}
                className={`crm-filter-pill ${filterStage === st.key ? 'active' : ''}`}
                onClick={() => setFilterStage(st.key)}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: st.color,
                    display: 'inline-block',
                    marginRight: 6,
                  }}
                />
                {st.label}
              </button>
            ))}
          </div>

          <div style={{ fontSize: '12.5px', color: 'var(--crm-text-muted)', fontWeight: 500 }}>
            {filtered.length} Opportunities
          </div>
        </div>

        <div className="crm-table-wrapper">
          <table className="crm-table">
            <thead>
              <tr>
                <th>Opportunity</th>
                <th>Account</th>
                <th>Contact</th>
                <th>Owner</th>
                <th>Stage</th>
                <th>Value</th>
                <th>Expected Close</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState
                      title="No opportunities found"
                      message={
                        deals.length
                          ? 'Try a different stage filter.'
                          : 'New opportunities will appear here.'
                      }
                      actionLabel={deals.length ? 'Clear filter' : undefined}
                      onAction={deals.length ? () => setFilterStage('all') : undefined}
                    />
                  </td>
                </tr>
              )}
              {filtered.map((deal) => {
                const currentStage = STAGES.find((s) => s.key === deal.stage)
                return (
                  <tr key={deal.id}>
                    <td>
                      <strong
                        style={{ color: 'var(--crm-text)', cursor: 'pointer' }}
                        onClick={() => setDetailDealId(deal.id)}
                      >
                        {deal.name}
                      </strong>
                      {Boolean((deal as any).tenderReference || (deal as any).tenderId) && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: '10px',
                            padding: '1px 5px',
                            borderRadius: 4,
                            backgroundColor: 'rgba(99, 102, 241, 0.12)',
                            color: '#4f46e5',
                            fontWeight: 600,
                            display: 'inline-block',
                          }}
                          title={`Tender Reference: ${(deal as any).tenderReference || (deal as any).tenderId}`}
                        >
                          {(deal as any).tenderReference || 'Tender'}
                        </span>
                      )}
                      {deal.notes && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'var(--crm-text-dim)',
                            marginTop: '2px',
                            maxWidth: '300px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {deal.notes}
                        </div>
                      )}
                      {deal.nextStep && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: 'var(--crm-text-muted)',
                            marginTop: '3px',
                            maxWidth: '300px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          Next: {deal.nextStep}
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <BuildingIcon size={12} style={{ color: 'var(--crm-text-dim)' }} />
                        <span>{deal.companyName || '—'}</span>
                      </div>
                    </td>
                    <td>{deal.contactName || '—'}</td>
                    <td>{deal.owner || '—'}</td>
                    <td>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 8px',
                          borderRadius: 12,
                          fontSize: '11.5px',
                          fontWeight: 500,
                          backgroundColor: 'rgba(0, 0, 0, 0.04)',
                          color: currentStage?.color || 'inherit',
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            backgroundColor: currentStage?.color,
                          }}
                        />
                        <select
                          className="crm-table-stage-select"
                          value={deal.stage}
                          disabled={stageSavingId === deal.id}
                          aria-label={`Stage for ${deal.name}`}
                          onChange={(event) =>
                            void handleStageChange(deal, event.target.value as DealStage)
                          }
                        >
                          {STAGES.map((stage) => (
                            <option key={stage.key} value={stage.key}>
                              {stage.label}
                            </option>
                          ))}
                        </select>
                        {stageSavingId === deal.id && (
                          <span className="crm-saving-inline">Saving…</span>
                        )}
                      </span>
                    </td>
                    <td>
                      <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                        ${(deal.amount || 0).toLocaleString()}
                      </strong>
                    </td>
                    <td style={{ color: 'var(--crm-text-secondary)', fontSize: '12px' }}>
                      {deal.expectedCloseDate || '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="crm-table-actions">
                        <div className="crm-overflow-wrap">
                          <button
                            className="crm-icon-action-btn"
                            title="Actions"
                            aria-label={`Actions for ${deal.name}`}
                            aria-haspopup="menu"
                            aria-expanded={activeMenuDealId === deal.id}
                            onClick={(event) => {
                              event.stopPropagation()
                              setActiveMenuDealId((current) =>
                                current === deal.id ? null : deal.id,
                              )
                            }}
                          >
                            <MoreHorizontalIcon size={14} />
                          </button>
                          {activeMenuDealId === deal.id && (
                            <div
                              className="crm-overflow-menu"
                              role="menu"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <button
                                className="crm-overflow-item"
                                role="menuitem"
                                onClick={() => {
                                  setActiveMenuDealId(null)
                                  onGenerateProposal(deal.id)
                                }}
                              >
                                <FileTextIcon size={13} />
                                <span>Create Proposal</span>
                              </button>
                              <button
                                className="crm-overflow-item"
                                role="menuitem"
                                onClick={() => {
                                  setActiveMenuDealId(null)
                                  void window.crmApi?.openTenders()
                                }}
                              >
                                <TenderIcon size={13} />
                                <span>View in Tenders</span>
                              </button>
                              {deal.stage === 'won' &&
                                (deal.invoiceNumber || localInvoices[deal.id] ? (
                                  <button
                                    className="crm-overflow-item"
                                    role="menuitem"
                                    onClick={() => {
                                      setActiveMenuDealId(null)
                                      void window.crmApi?.openBooks()
                                    }}
                                  >
                                    <span>
                                      Open Invoice {deal.invoiceNumber || localInvoices[deal.id]}
                                    </span>
                                  </button>
                                ) : (
                                  <button
                                    className="crm-overflow-item"
                                    role="menuitem"
                                    disabled={invoicingDealId === deal.id}
                                    onClick={() => {
                                      if (invoicingDealId === deal.id) return
                                      setActiveMenuDealId(null)
                                      void handleCreateInvoice(deal)
                                    }}
                                  >
                                    <span>
                                      {invoicingDealId === deal.id
                                        ? 'Invoicing…'
                                        : 'Create Invoice in Books'}
                                    </span>
                                  </button>
                                ))}
                              <button
                                className="crm-overflow-item"
                                role="menuitem"
                                onClick={() => {
                                  setActiveMenuDealId(null)
                                  onEditDeal(deal)
                                }}
                              >
                                <EditIcon size={13} />
                                <span>Edit</span>
                              </button>
                              <button
                                className="crm-overflow-item danger"
                                role="menuitem"
                                onClick={() => {
                                  setActiveMenuDealId(null)
                                  onDeleteDeal(deal.id)
                                }}
                              >
                                <TrashIcon size={13} />
                                <span>Delete</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {localToast && (
          <div
            className="crm-toast"
            style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 1000 }}
          >
            <span>{localToast}</span>
          </div>
        )}
      </div>
      {detailDeal && (
        <DealDetail
          deal={detailDeal}
          onClose={() => setDetailDealId(null)}
          onEditDeal={(selectedDeal) => {
            setDetailDealId(null)
            onEditDeal(selectedDeal)
          }}
          onDeleteDeal={(id) => {
            setDetailDealId(null)
            onDeleteDeal(id)
          }}
          onGenerateProposal={onGenerateProposal}
        />
      )}
    </>
  )
}

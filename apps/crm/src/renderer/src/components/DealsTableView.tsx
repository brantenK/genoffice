import React, { useState } from 'react'
import type { Deal, DealStage } from '../../../shared/types'
import { BuildingIcon, FileTextIcon, EditIcon, TrashIcon } from './Icons'

interface DealsTableViewProps {
  deals: Deal[]
  onEditDeal: (deal: Deal) => void
  onUpdateStage: (id: string, stage: DealStage) => void
  onDeleteDeal: (id: string) => void
  onGenerateProposal: (dealId: string) => void
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
}: DealsTableViewProps) {
  const [filterStage, setFilterStage] = useState<DealStage | 'all'>('all')

  const filtered = deals.filter((d) => (filterStage === 'all' ? true : d.stage === filterStage))

  return (
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
              <th>Stage</th>
              <th>Value</th>
              <th>Expected Close</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((deal) => {
              const currentStage = STAGES.find((s) => s.key === deal.stage)
              return (
                <tr key={deal.id}>
                  <td>
                    <strong
                      style={{ color: 'var(--crm-text)', cursor: 'pointer' }}
                      onClick={() => onEditDeal(deal)}
                    >
                      {deal.name}
                    </strong>
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
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <BuildingIcon size={12} style={{ color: 'var(--crm-text-dim)' }} />
                      <span>{deal.companyName || '—'}</span>
                    </div>
                  </td>
                  <td>{deal.contactName || '—'}</td>
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
                      {currentStage?.label}
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
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button
                        className="crm-pill-action-btn"
                        title="Generate Proposal Contract in Zanostack Docs"
                        onClick={() => onGenerateProposal(deal.id)}
                      >
                        <FileTextIcon size={11} />
                        <span>Proposal</span>
                      </button>
                      <button
                        className="crm-icon-action-btn"
                        title="Edit Deal"
                        onClick={() => onEditDeal(deal)}
                      >
                        <EditIcon size={13} />
                      </button>
                      <button
                        className="crm-icon-action-btn delete"
                        title="Delete Deal"
                        onClick={() => onDeleteDeal(deal.id)}
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

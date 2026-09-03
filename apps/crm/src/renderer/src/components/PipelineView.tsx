import React from 'react'
import type { Deal, DealStage } from '../../../shared/types'

interface PipelineViewProps {
  deals: Deal[]
  onEditDeal: (deal: Deal) => void
  onUpdateStage: (id: string, stage: DealStage) => void
  onDeleteDeal: (id: string) => void
  onGenerateProposal: (dealId: string) => void
}

const STAGES: { key: DealStage; label: string; color: string }[] = [
  { key: 'lead', label: 'Lead', color: '#94a3b8' },
  { key: 'qualified', label: 'Qualified', color: '#38bdf8' },
  { key: 'proposal', label: 'Proposal', color: '#fbbf24' },
  { key: 'negotiation', label: 'Negotiation', color: '#f97316' },
  { key: 'won', label: 'Closed Won', color: '#22c55e' },
  { key: 'lost', label: 'Closed Lost', color: '#ef4444' },
]

export function PipelineView({
  deals,
  onEditDeal,
  onUpdateStage,
  onDeleteDeal,
  onGenerateProposal,
}: PipelineViewProps) {
  return (
    <div className="crm-pipeline-board">
      {STAGES.map((st) => {
        const stageDeals = deals.filter((d) => d.stage === st.key)
        const stageTotal = stageDeals.reduce((sum, d) => sum + (d.amount || 0), 0)

        return (
          <div key={st.key} className="crm-stage-column">
            <div className="crm-stage-header">
              <div className="crm-stage-title-wrap">
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: st.color,
                    display: 'inline-block',
                  }}
                />
                <span className="crm-stage-name">{st.label}</span>
                <span className="crm-stage-badge">{stageDeals.length}</span>
              </div>
              <span className="crm-stage-total">${stageTotal.toLocaleString()}</span>
            </div>

            <div className="crm-cards-list">
              {stageDeals.map((deal) => (
                <div key={deal.id} className="crm-deal-card">
                  <div className="crm-deal-header">
                    <span className="crm-deal-title">{deal.name}</span>
                    <span className="crm-deal-amount">${(deal.amount || 0).toLocaleString()}</span>
                  </div>

                  <div className="crm-deal-meta">
                    <span className="crm-deal-company">
                      🏢 {deal.companyName || 'No Company'}
                    </span>
                    {deal.contactName && <span>👤 {deal.contactName}</span>}
                  </div>

                  {deal.notes && (
                    <p
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      }}
                    >
                      {deal.notes}
                    </p>
                  )}

                  <div className="crm-deal-actions">
                    <select
                      className="crm-deal-stage-select"
                      value={deal.stage}
                      onChange={(e) => onUpdateStage(deal.id, e.target.value as DealStage)}
                    >
                      {STAGES.map((s) => (
                        <option key={s.key} value={s.key}>
                          Move to: {s.label}
                        </option>
                      ))}
                    </select>

                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        className="crm-btn-proposal"
                        title="Generate Proposal Contract in Zanostack Docs"
                        onClick={() => onGenerateProposal(deal.id)}
                      >
                        📄 Proposal
                      </button>
                      <button
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--text-muted)',
                          fontSize: '13px',
                        }}
                        title="Edit Opportunity"
                        onClick={() => onEditDeal(deal)}
                      >
                        ✎
                      </button>
                      <button
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--text-muted)',
                          fontSize: '13px',
                        }}
                        title="Delete"
                        onClick={() => onDeleteDeal(deal.id)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {stageDeals.length === 0 && (
                <div
                  style={{
                    padding: '24px 12px',
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                    fontSize: '12px',
                    fontStyle: 'italic',
                  }}
                >
                  No opportunities in this stage
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

import React, { useState } from 'react'
import type { Deal, DealStage } from '../../../shared/types'
import {
  BuildingIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  EditIcon,
  TrashIcon,
} from './Icons'

interface PipelineViewProps {
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

export function PipelineView({
  deals,
  onEditDeal,
  onUpdateStage,
  onDeleteDeal,
  onGenerateProposal,
}: PipelineViewProps) {
  const [activeMenuDealId, setActiveMenuDealId] = useState<string | null>(null)
  const [draggedDealId, setDraggedDealId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<DealStage | null>(null)

  return (
    <div
      className="crm-pipeline-board"
      onClick={() => {
        if (activeMenuDealId) setActiveMenuDealId(null)
      }}
    >
      {STAGES.map((st) => {
        const stageDeals = deals.filter((d) => d.stage === st.key)
        const stageTotal = stageDeals.reduce((sum, d) => sum + (d.amount || 0), 0)
        const isDragOver = dragOverStage === st.key

        return (
          <div
            key={st.key}
            className={`crm-stage-column ${isDragOver ? 'drag-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOverStage(st.key)
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return
              setDragOverStage(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setDragOverStage(null)
              const id = e.dataTransfer.getData('text/plain')
              if (id) onUpdateStage(id, st.key)
            }}
          >
            {/* Column Header */}
            <div className="crm-stage-header">
              <div className="crm-stage-title-wrap">
                <span className="crm-stage-dot" style={{ backgroundColor: st.color }} />
                <span className="crm-stage-name">{st.label}</span>
                <span className="crm-stage-badge">{stageDeals.length}</span>
              </div>
              <span className="crm-stage-total">${stageTotal.toLocaleString()}</span>
            </div>

            {/* Cards List */}
            <div className="crm-cards-list">
              {stageDeals.map((deal) => {
                const isMenuOpen = activeMenuDealId === deal.id
                const isDragging = draggedDealId === deal.id
                const contactInitials = deal.contactName
                  ? deal.contactName
                      .split(' ')
                      .map((n: string) => n[0])
                      .join('')
                      .toUpperCase()
                      .slice(0, 2)
                  : '?'

                return (
                  <div
                    key={deal.id}
                    className={`crm-deal-card ${isDragging ? 'dragging' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', deal.id)
                      setDraggedDealId(deal.id)
                    }}
                    onDragEnd={() => {
                      setDraggedDealId(null)
                      setDragOverStage(null)
                    }}
                  >
                    {/* Top Row: Account & Action menu */}
                    <div className="crm-deal-top-row">
                      <div className="crm-deal-company-badge">
                        <BuildingIcon size={12} />
                        <span>{deal.companyName || 'No Company'}</span>
                      </div>

                      <button
                        className="crm-deal-menu-btn"
                        title="Options"
                        onClick={(e) => {
                          e.stopPropagation()
                          setActiveMenuDealId(isMenuOpen ? null : deal.id)
                        }}
                      >
                        <MoreHorizontalIcon size={14} />
                      </button>

                      {/* Popover Menu */}
                      {isMenuOpen && (
                        <div className="crm-popover-menu" onClick={(e) => e.stopPropagation()}>
                          <div style={{ padding: '4px 8px', fontSize: '10.5px', color: 'var(--crm-text-dim)', fontWeight: 600 }}>
                            MOVE STAGE
                          </div>
                          {STAGES.filter((s) => s.key !== deal.stage).map((s) => (
                            <button
                              key={s.key}
                              className="crm-popover-item"
                              onClick={() => {
                                onUpdateStage(deal.id, s.key)
                                setActiveMenuDealId(null)
                              }}
                            >
                              <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: s.color, display: 'inline-block' }} />
                              <span>{s.label}</span>
                            </button>
                          ))}
                          <div className="crm-popover-divider" />
                          <button
                            className="crm-popover-item"
                            onClick={() => {
                              onGenerateProposal(deal.id)
                              setActiveMenuDealId(null)
                            }}
                          >
                            <FileTextIcon size={13} />
                            <span>Create Proposal</span>
                          </button>
                          <button
                            className="crm-popover-item"
                            onClick={() => {
                              onEditDeal(deal)
                              setActiveMenuDealId(null)
                            }}
                          >
                            <EditIcon size={13} />
                            <span>Edit Deal</span>
                          </button>
                          <button
                            className="crm-popover-item danger"
                            onClick={() => {
                              onDeleteDeal(deal.id)
                              setActiveMenuDealId(null)
                            }}
                          >
                            <TrashIcon size={13} />
                            <span>Delete Deal</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Main Deal Information */}
                    <div className="crm-deal-main" onClick={() => onEditDeal(deal)}>
                      <div className="crm-deal-title">{deal.name}</div>
                      <div className="crm-deal-amount">${(deal.amount || 0).toLocaleString()}</div>
                      {deal.notes && <p className="crm-deal-notes">{deal.notes}</p>}
                    </div>

                    {/* Bottom Row: Contact info & Quick actions */}
                    <div className="crm-deal-bottom-row">
                      {deal.contactName ? (
                        <div className="crm-deal-contact">
                          <span className="crm-avatar-sm">{contactInitials}</span>
                          <span className="crm-deal-contact-name">{deal.contactName}</span>
                        </div>
                      ) : (
                        <div />
                      )}

                      <div className="crm-deal-actions-inline">
                        <button
                          className="crm-pill-action-btn"
                          title="Generate proposal contract in Zanostack Docs"
                          onClick={(e) => {
                            e.stopPropagation()
                            onGenerateProposal(deal.id)
                          }}
                        >
                          <FileTextIcon size={11} />
                          <span>Proposal</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

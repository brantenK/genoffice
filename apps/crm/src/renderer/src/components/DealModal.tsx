import React, { useState } from 'react'
import type { Company, Contact, Deal, DealStage } from '../../../shared/types'

interface DealModalProps {
  deal?: Partial<Deal>
  companies: Company[]
  contacts: Contact[]
  onClose: () => void
  onSave: (deal: Partial<Deal>) => void
}

export function DealModal({ deal, companies, contacts, onClose, onSave }: DealModalProps) {
  const [name, setName] = useState(deal?.name || '')
  const [amount, setAmount] = useState(deal?.amount ? String(deal.amount) : '10000')
  const [stage, setStage] = useState<DealStage>(deal?.stage || 'lead')
  const [probability, setProbability] = useState(deal?.probability ? String(deal.probability) : '20')
  const [companyId, setCompanyId] = useState(deal?.companyId || (companies[0]?.id ?? ''))
  const [contactId, setContactId] = useState(deal?.contactId || (contacts[0]?.id ?? ''))
  const [expectedCloseDate, setExpectedCloseDate] = useState(deal?.expectedCloseDate || '')
  const [notes, setNotes] = useState(deal?.notes || '')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    const selComp = companies.find((c) => c.id === companyId)
    const selCont = contacts.find((c) => c.id === contactId)

    onSave({
      id: deal?.id,
      name: name.trim(),
      amount: Number(amount) || 0,
      stage,
      probability: Number(probability) || 0,
      companyId,
      companyName: selComp?.name || '',
      contactId,
      contactName: selCont?.name || '',
      expectedCloseDate,
      notes,
    })
  }

  return (
    <div className="crm-modal-overlay" onClick={onClose}>
      <div className="crm-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="crm-modal-header">
            <h3 className="crm-modal-title">{deal?.id ? 'Edit Deal' : 'New Opportunity'}</h3>
            <button type="button" className="crm-modal-close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="crm-modal-body">
            <div className="crm-form-group">
              <label className="crm-form-label">Deal Name</label>
              <input
                className="crm-form-input"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Enterprise License Expansion"
              />
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Deal Amount ($)</label>
                <input
                  type="number"
                  className="crm-form-input"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  min={0}
                  step={500}
                />
              </div>

              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Pipeline Stage</label>
                <select
                  className="crm-form-select"
                  value={stage}
                  onChange={(e) => setStage(e.target.value as DealStage)}
                >
                  <option value="lead">Lead</option>
                  <option value="qualified">Qualified</option>
                  <option value="proposal">Proposal</option>
                  <option value="negotiation">Negotiation</option>
                  <option value="won">Closed Won</option>
                  <option value="lost">Closed Lost</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Company Account</label>
                <select
                  className="crm-form-select"
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                >
                  <option value="">(None)</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Primary Contact</label>
                <select
                  className="crm-form-select"
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                >
                  <option value="">(None)</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="crm-form-group">
              <label className="crm-form-label">Expected Close Date</label>
              <input
                type="date"
                className="crm-form-input"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
              />
            </div>

            <div className="crm-form-group">
              <label className="crm-form-label">Deal Notes & Scope</label>
              <textarea
                className="crm-form-textarea"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Key requirements, decision criteria, or follow-up notes..."
              />
            </div>
          </div>
          <div className="crm-modal-footer">
            <button type="button" className="crm-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="crm-btn crm-btn-primary">
              Save Opportunity
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

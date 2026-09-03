import React, { useEffect, useState } from 'react'
import type { Company, Contact, Deal, DealStage } from '../../../shared/types'
import { XIcon } from './Icons'

interface DealModalProps {
  deal?: Partial<Deal>
  companies: Company[]
  contacts: Contact[]
  onClose: () => void
  onSave: (deal: Partial<Deal>) => void
  onInvoiceCreated?: (dealId: string, invoiceNumber: string) => void
}

export function DealModal({ deal, companies, contacts, onClose, onSave, onInvoiceCreated }: DealModalProps) {
  const [name, setName] = useState(deal?.name || '')
  const [amount, setAmount] = useState(deal?.amount ? String(deal.amount) : '10000')
  const [stage, setStage] = useState<DealStage>(deal?.stage || 'lead')
  const [companyId, setCompanyId] = useState(deal?.companyId || (companies[0]?.id ?? ''))
  const [contactId, setContactId] = useState(deal?.contactId || (contacts[0]?.id ?? ''))
  const [expectedCloseDate, setExpectedCloseDate] = useState(deal?.expectedCloseDate || '')
  const [notes, setNotes] = useState(deal?.notes || '')
  const [localInvoiceNumber, setLocalInvoiceNumber] = useState<string | undefined>(deal?.invoiceNumber)
  const [isInvoicing, setIsInvoicing] = useState(false)
  const [invoiceError, setInvoiceError] = useState<string | null>(null)

  useEffect(() => {
    setLocalInvoiceNumber(deal?.invoiceNumber)
  }, [deal?.invoiceNumber])

  const handleCreateInvoice = async () => {
    if (!deal?.id) return
    setIsInvoicing(true)
    setInvoiceError(null)
    try {
      const res = await window.crmApi?.createInvoiceInBooks(deal.id)
      if (res?.ok && res.invoiceNumber) {
        setLocalInvoiceNumber(res.invoiceNumber)
        onInvoiceCreated?.(deal.id, res.invoiceNumber)
      } else if (res?.error) {
        setInvoiceError(res.error)
      }
    } catch (err: any) {
      setInvoiceError(err?.message || 'Failed to create invoice')
    } finally {
      setIsInvoicing(false)
    }
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

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
      probability: 50,
      companyId,
      companyName: selComp?.name || '',
      contactId,
      contactName: selCont?.name || '',
      expectedCloseDate,
      notes,
      invoiceNumber: localInvoiceNumber,
    })
  }

  return (
    <div className="crm-modal-backdrop" onClick={onClose}>
      <div className="crm-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="crm-modal-header">
            <h3 className="crm-modal-title">{deal?.id ? 'Edit Opportunity' : 'New Opportunity'}</h3>
            <button type="button" className="crm-modal-close-btn" onClick={onClose}>
              <XIcon size={14} />
            </button>
          </div>

          <div className="crm-modal-body">
            <div className="crm-form-group">
              <label className="crm-form-label">Opportunity Name</label>
              <input
                className="crm-form-input"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Enterprise License Expansion"
                autoFocus
              />
            </div>

            <div className="crm-form-row">
              <div className="crm-form-group">
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

              <div className="crm-form-group">
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

            <div className="crm-form-row">
              <div className="crm-form-group">
                <label className="crm-form-label">Company Account</label>
                <select
                  className="crm-form-select"
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="crm-form-group">
                <label className="crm-form-label">Primary Contact</label>
                <select
                  className="crm-form-select"
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                >
                  {contacts.map((ct) => (
                    <option key={ct.id} value={ct.id}>
                      {ct.name}
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
              <label className="crm-form-label">Notes & Requirements</label>
              <textarea
                className="crm-form-textarea"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Key requirements, next steps, or customer context..."
                rows={3}
              />
            </div>

            {stage === 'won' && deal?.id && (
              <div
                className="crm-form-group"
                style={{
                  padding: '14px',
                  borderRadius: '8px',
                  backgroundColor: localInvoiceNumber
                    ? 'rgba(5, 150, 105, 0.06)'
                    : 'rgba(245, 158, 11, 0.08)',
                  border: localInvoiceNumber
                    ? '1px solid rgba(5, 150, 105, 0.25)'
                    : '1px solid rgba(245, 158, 11, 0.3)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '6px',
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: '13px',
                      color: localInvoiceNumber ? '#059669' : '#d97706',
                    }}
                  >
                    Zano Books Invoicing
                  </span>
                  {localInvoiceNumber ? (
                    <button
                      type="button"
                      className="crm-pill-action-btn"
                      style={{
                        background: 'rgba(5, 150, 105, 0.12)',
                        borderColor: '#059669',
                        color: '#059669',
                        fontWeight: 600,
                        padding: '4px 10px',
                      }}
                      title="Open Invoice in Zano Books"
                      onClick={() => void window.crmApi?.openBooks()}
                    >
                      📄 {localInvoiceNumber} (Open in Books)
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="crm-btn crm-btn-primary"
                      style={{ fontSize: '12px', padding: '6px 14px' }}
                      disabled={isInvoicing}
                      onClick={() => void handleCreateInvoice()}
                    >
                      {isInvoicing ? 'Creating...' : '⚡ Create Invoice in Zano Books'}
                    </button>
                  )}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--crm-text-secondary)' }}>
                  {localInvoiceNumber
                    ? `Invoice ${localInvoiceNumber} has been generated and linked to this opportunity.`
                    : 'This opportunity is closed won. Generate a Sales Invoice directly in Zano Books.'}
                </div>
                {invoiceError && (
                  <div style={{ color: '#dc2626', fontSize: '12px', marginTop: '6px' }}>
                    {invoiceError}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="crm-modal-footer">
            <button type="button" className="crm-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="crm-btn crm-btn-primary">
              {deal?.id ? 'Save Changes' : 'Create Opportunity'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

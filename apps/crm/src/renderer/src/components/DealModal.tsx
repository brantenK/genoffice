import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Company, Contact, Deal, DealStage } from '../../../shared/types'
import { XIcon, FileTextIcon } from './Icons'
import { ConfirmDialog } from './ConfirmDialog'
import { useDialogA11y } from './useDialogA11y'

interface DealModalProps {
  deal?: Partial<Deal>
  companies: Company[]
  contacts: Contact[]
  onClose: () => void
  onSave: (deal: Partial<Deal>) => void | Promise<void>
  saving: boolean
  onInvoiceCreated?: (dealId: string, invoiceNumber: string) => void
}

export function DealModal({
  deal,
  companies,
  contacts,
  onClose,
  onSave,
  saving,
  onInvoiceCreated,
}: DealModalProps) {
  const [name, setName] = useState(deal?.name || '')
  const [amount, setAmount] = useState(deal?.amount !== undefined ? String(deal.amount) : '')
  const [stage, setStage] = useState<DealStage>(deal?.stage || 'lead')
  const [companyId, setCompanyId] = useState(deal?.companyId || (companies[0]?.id ?? ''))
  const [contactId, setContactId] = useState(deal?.contactId || (contacts[0]?.id ?? ''))
  const [expectedCloseDate, setExpectedCloseDate] = useState(deal?.expectedCloseDate || '')
  const [owner, setOwner] = useState(deal?.owner || '')
  const [nextStep, setNextStep] = useState(deal?.nextStep || '')
  const [notes, setNotes] = useState(deal?.notes || '')
  const [localInvoiceNumber, setLocalInvoiceNumber] = useState<string | undefined>(
    deal?.invoiceNumber,
  )
  const [isInvoicing, setIsInvoicing] = useState(false)
  const [invoiceError, setInvoiceError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstInvalidRef = useRef<HTMLInputElement | null>(null)
  const initialRef = useRef({
    name: deal?.name || '',
    amount: deal?.amount !== undefined ? String(deal.amount) : '',
    stage: deal?.stage || 'lead',
    companyId: deal?.companyId || (companies[0]?.id ?? ''),
    contactId: deal?.contactId || (contacts[0]?.id ?? ''),
    expectedCloseDate: deal?.expectedCloseDate || '',
    owner: deal?.owner || '',
    nextStep: deal?.nextStep || '',
    notes: deal?.notes || '',
  })
  const isDirty =
    JSON.stringify({
      name,
      amount,
      stage,
      companyId,
      contactId,
      expectedCloseDate,
      owner,
      nextStep,
      notes,
    }) !== JSON.stringify(initialRef.current)

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
    } catch (err: unknown) {
      setInvoiceError(err instanceof Error ? err.message : 'Failed to create invoice')
    } finally {
      setIsInvoicing(false)
    }
  }

  const validate = useCallback(() => {
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Enter an opportunity name'
    if (amount.trim() && (!Number.isFinite(Number(amount)) || Number(amount) < 0))
      next.amount = 'Enter a valid amount'
    if (expectedCloseDate && Number.isNaN(Date.parse(expectedCloseDate)))
      next.expectedCloseDate = 'Enter a valid close date'
    setErrors(next)
    return next
  }, [amount, expectedCloseDate, name])
  const handleEscape = useCallback(() => {
    if (saving || discardOpen) return
    if (isDirty) setDiscardOpen(true)
    else onClose()
  }, [discardOpen, isDirty, onClose, saving])
  useDialogA11y(dialogRef, handleEscape)
  const requestClose = () => {
    if (saving) return
    if (isDirty) setDiscardOpen(true)
    else onClose()
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitAttempted(true)
    const nextErrors = validate()
    if (saving || Object.keys(nextErrors).length) {
      setTouched((prev) => ({
        ...prev,
        ...Object.fromEntries(Object.keys(nextErrors).map((key) => [key, true])),
      }))
      requestAnimationFrame(() => firstInvalidRef.current?.focus())
      return
    }

    const selComp = companies.find((c) => c.id === companyId)
    const selCont = contacts.find((c) => c.id === contactId)

    void Promise.resolve(
      onSave({
        id: deal?.id,
        name: name.trim(),
        amount: Number(amount) || 0,
        stage,
        companyId,
        companyName: selComp?.name || '',
        contactId,
        contactName: selCont?.name || '',
        expectedCloseDate,
        owner: owner.trim(),
        nextStep: nextStep.trim(),
        notes,
        invoiceNumber: localInvoiceNumber,
      }),
    ).catch(() => undefined)
  }
  const showError = (field: string) => (submitAttempted || touched[field]) && errors[field]

  return (
    <>
      <div className="crm-modal-backdrop" onClick={requestClose}>
        <div
          ref={dialogRef}
          className="crm-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="crm-deal-modal-title"
          onClick={(e) => e.stopPropagation()}
        >
          <form onSubmit={handleSubmit} noValidate>
            <div className="crm-modal-header">
              <h3 id="crm-deal-modal-title" className="crm-modal-title">
                {deal?.id ? 'Edit Opportunity' : 'New Opportunity'}
              </h3>
              <button
                type="button"
                className="crm-modal-close-btn"
                onClick={requestClose}
                disabled={saving}
                aria-label="Close dialog"
              >
                <XIcon size={14} />
              </button>
            </div>

            <div className="crm-modal-body">
              <div className="crm-form-group">
                <label className="crm-form-label" htmlFor="crm-deal-name">
                  Opportunity Name
                </label>
                <input
                  id="crm-deal-name"
                  ref={(element) => {
                    if (errors.name) firstInvalidRef.current = element
                  }}
                  className="crm-form-input"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Enterprise License Expansion"
                  autoFocus
                  onBlur={() => {
                    setTouched((prev) => ({ ...prev, name: true }))
                    validate()
                  }}
                  aria-invalid={showError('name') ? true : undefined}
                  aria-describedby={showError('name') ? 'crm-deal-name-error' : undefined}
                />
                {showError('name') && (
                  <div id="crm-deal-name-error" className="crm-field-error">
                    {errors.name}
                  </div>
                )}
              </div>

              <div className="crm-form-row">
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-deal-amount">
                    Deal Amount ($)
                  </label>
                  <input
                    id="crm-deal-amount"
                    type="number"
                    className="crm-form-input"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="e.g. 25000"
                    min={0}
                    step={500}
                    onBlur={() => {
                      setTouched((prev) => ({ ...prev, amount: true }))
                      validate()
                    }}
                    aria-invalid={showError('amount') ? true : undefined}
                    aria-describedby={showError('amount') ? 'crm-deal-amount-error' : undefined}
                  />
                  {showError('amount') && (
                    <div id="crm-deal-amount-error" className="crm-field-error">
                      {errors.amount}
                    </div>
                  )}
                </div>

                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-deal-stage">
                    Pipeline Stage
                  </label>
                  <select
                    id="crm-deal-stage"
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
                  <label className="crm-form-label" htmlFor="crm-deal-company">
                    Company Account
                  </label>
                  <select
                    id="crm-deal-company"
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
                  <label className="crm-form-label" htmlFor="crm-deal-contact">
                    Primary Contact
                  </label>
                  <select
                    id="crm-deal-contact"
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

              <div className="crm-form-row">
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-deal-owner">
                    Owner
                  </label>
                  <input
                    id="crm-deal-owner"
                    className="crm-form-input"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="e.g. Alex Morgan"
                  />
                </div>
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-deal-next-step">
                    Next step
                  </label>
                  <input
                    id="crm-deal-next-step"
                    className="crm-form-input"
                    value={nextStep}
                    onChange={(e) => setNextStep(e.target.value)}
                    placeholder="e.g. Send questionnaire"
                  />
                </div>
              </div>

              <div className="crm-form-group">
                <label className="crm-form-label" htmlFor="crm-deal-close-date">
                  Expected Close Date
                </label>
                <input
                  id="crm-deal-close-date"
                  type="date"
                  className="crm-form-input"
                  value={expectedCloseDate}
                  onChange={(e) => setExpectedCloseDate(e.target.value)}
                  onBlur={() => {
                    setTouched((prev) => ({ ...prev, expectedCloseDate: true }))
                    validate()
                  }}
                  aria-invalid={showError('expectedCloseDate') ? true : undefined}
                  aria-describedby={
                    showError('expectedCloseDate') ? 'crm-deal-close-date-error' : undefined
                  }
                />
                {showError('expectedCloseDate') && (
                  <div id="crm-deal-close-date-error" className="crm-field-error">
                    {errors.expectedCloseDate}
                  </div>
                )}
              </div>

              <div className="crm-form-group">
                <label className="crm-form-label" htmlFor="crm-deal-notes">
                  Notes & Requirements
                </label>
                <textarea
                  id="crm-deal-notes"
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
                        <>
                          <FileTextIcon size={12} /> {localInvoiceNumber} (Open in Books)
                        </>
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
              <button type="button" className="crm-btn" onClick={requestClose} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="crm-btn crm-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : deal?.id ? 'Save Changes' : 'Create Opportunity'}
              </button>
            </div>
          </form>
        </div>
      </div>
      {discardOpen && (
        <ConfirmDialog
          title="Discard changes?"
          message="Your unsaved edits will be lost."
          confirmLabel="Discard"
          onCancel={() => setDiscardOpen(false)}
          onConfirm={onClose}
        />
      )}
    </>
  )
}

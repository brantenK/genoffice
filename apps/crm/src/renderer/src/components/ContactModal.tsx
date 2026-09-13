import React, { useCallback, useRef, useState } from 'react'
import type { Company, Contact } from '../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { XIcon } from './Icons'
import { useDialogA11y } from './useDialogA11y'

export function ContactModal({
  contact,
  companies,
  onClose,
  onSave,
}: {
  contact?: Partial<Contact>
  companies: Company[]
  onClose: () => void
  onSave: (contact: Partial<Contact>) => void
}) {
  const [name, setName] = useState(contact?.name || ''),
    [email, setEmail] = useState(contact?.email || '')
  const [phone, setPhone] = useState(contact?.phone || ''),
    [title, setTitle] = useState(contact?.title || '')
  const [companyId, setCompanyId] = useState(contact?.companyId || (companies[0]?.id ?? ''))
  const [tagsStr, setTagsStr] = useState(contact?.tags ? contact.tags.join(', ') : 'Decision Maker')
  const [status, setStatus] = useState<'lead' | 'active' | 'churned'>(contact?.status || 'active')
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [touched, setTouched] = useState<Record<string, boolean>>({}),
    [attempted, setAttempted] = useState(false),
    [discardOpen, setDiscardOpen] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null)
  const duplicateRequestId = useRef(0)
  const ref = useRef<HTMLDivElement>(null),
    firstInvalid = useRef<HTMLInputElement | null>(null)
  const initial = useRef({
    name: contact?.name || '',
    email: contact?.email || '',
    phone: contact?.phone || '',
    title: contact?.title || '',
    companyId: contact?.companyId || (companies[0]?.id ?? ''),
    tagsStr: contact?.tags ? contact.tags.join(', ') : 'Decision Maker',
    status: contact?.status || 'active',
  })
  const dirty =
    JSON.stringify({ name, email, phone, title, companyId, tagsStr, status }) !==
    JSON.stringify(initial.current)
  const validate = useCallback(() => {
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Enter a contact name'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = 'Enter a valid email address'
    setErrors(next)
    return next
  }, [email, name])
  const close = useCallback(() => {
    if (dirty) setDiscardOpen(true)
    else onClose()
  }, [dirty, onClose])
  useDialogA11y(ref, close)
  const show = (field: string) => (attempted || touched[field]) && errors[field]
  const checkDuplicate = async (value: string) => {
    const requestId = ++duplicateRequestId.current
    const queriedEmail = value.trim()
    if (!window.crmApi || !queriedEmail) return
    try {
      const match = await window.crmApi.findContactDuplicate(queriedEmail, contact?.id)
      if (requestId !== duplicateRequestId.current || email.trim() !== queriedEmail) return
      setDuplicateWarning(match ? `A contact with this email already exists: ${match.name}` : null)
    } catch {
      // Duplicate detection is advisory; saving remains available if it fails.
    }
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setAttempted(true)
    const next = validate()
    if (Object.keys(next).length) {
      setTouched((p) => ({ ...p, ...Object.fromEntries(Object.keys(next).map((k) => [k, true])) }))
      requestAnimationFrame(() => firstInvalid.current?.focus())
      return
    }
    await checkDuplicate(email)
    const c = companies.find((item) => item.id === companyId)
    onSave({
      id: contact?.id,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      title: title.trim(),
      companyId,
      companyName: c?.name || '',
      tags: tagsStr
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      status,
    })
  }
  return (
    <>
      <div className="crm-modal-backdrop" onClick={close}>
        <div
          ref={ref}
          className="crm-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="crm-contact-modal-title"
          onClick={(e) => e.stopPropagation()}
        >
          <form onSubmit={submit} noValidate>
            <div className="crm-modal-header">
              <h3 id="crm-contact-modal-title" className="crm-modal-title">
                {contact?.id ? 'Edit Contact' : 'New Contact'}
              </h3>
              <button
                type="button"
                className="crm-modal-close-btn"
                aria-label="Close dialog"
                onClick={close}
              >
                <XIcon size={14} />
              </button>
            </div>
            <div className="crm-modal-body">
              <div className="crm-form-group">
                <label className="crm-form-label" htmlFor="crm-contact-name">
                  Full Name
                </label>
                <input
                  id="crm-contact-name"
                  ref={(el) => {
                    if (errors.name) firstInvalid.current = el
                  }}
                  className="crm-form-input"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => {
                    setTouched((p) => ({ ...p, name: true }))
                    validate()
                  }}
                  placeholder="e.g. Sarah Chen"
                  autoFocus
                  aria-invalid={show('name') ? true : undefined}
                  aria-describedby={show('name') ? 'crm-contact-name-error' : undefined}
                />
                {show('name') && (
                  <div id="crm-contact-name-error" className="crm-field-error">
                    {errors.name}
                  </div>
                )}
              </div>
              <div className="crm-form-row">
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-contact-email">
                    Email Address
                  </label>
                  <input
                    id="crm-contact-email"
                    type="email"
                    className="crm-form-input"
                    required
                    value={email}
                    onChange={(e) => {
                      duplicateRequestId.current += 1
                      setEmail(e.target.value)
                      setDuplicateWarning(null)
                    }}
                    onBlur={() => {
                      setTouched((p) => ({ ...p, email: true }))
                      validate()
                      void checkDuplicate(email)
                    }}
                    placeholder="sarah@example.com"
                    aria-invalid={show('email') ? true : undefined}
                    aria-describedby={show('email') ? 'crm-contact-email-error' : undefined}
                  />
                  {show('email') && (
                    <div id="crm-contact-email-error" className="crm-field-error">
                      {errors.email}
                    </div>
                  )}
                  {duplicateWarning && <div className="crm-field-warning">{duplicateWarning}</div>}
                </div>
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-contact-phone">
                    Phone Number
                  </label>
                  <input
                    id="crm-contact-phone"
                    type="tel"
                    className="crm-form-input"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1 (555) 000-0000"
                  />
                </div>
              </div>
              <div className="crm-form-row">
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-contact-title">
                    Job Title
                  </label>
                  <input
                    id="crm-contact-title"
                    className="crm-form-input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. VP Engineering"
                  />
                </div>
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-contact-company">
                    Company Account
                  </label>
                  <select
                    id="crm-contact-company"
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
              </div>
              <div className="crm-form-group">
                <label className="crm-form-label" htmlFor="crm-contact-tags">
                  Tags (comma separated)
                </label>
                <input
                  id="crm-contact-tags"
                  className="crm-form-input"
                  value={tagsStr}
                  onChange={(e) => setTagsStr(e.target.value)}
                  placeholder="VIP, Enterprise, Decision Maker"
                />
              </div>
              <div className="crm-form-group">
                <label className="crm-form-label" htmlFor="crm-contact-status">
                  Relationship Status
                </label>
                <select
                  id="crm-contact-status"
                  className="crm-form-select"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as 'lead' | 'active' | 'churned')}
                >
                  <option value="active">Active</option>
                  <option value="lead">Lead</option>
                  <option value="churned">Churned</option>
                </select>
              </div>
            </div>
            <div className="crm-modal-footer">
              <button type="button" className="crm-btn" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="crm-btn crm-btn-primary">
                {contact?.id ? 'Save Changes' : 'Create Contact'}
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

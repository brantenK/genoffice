import React, { useState } from 'react'
import type { Company, Contact } from '../../../shared/types'

interface ContactModalProps {
  contact?: Partial<Contact>
  companies: Company[]
  onClose: () => void
  onSave: (contact: Partial<Contact>) => void
}

export function ContactModal({ contact, companies, onClose, onSave }: ContactModalProps) {
  const [name, setName] = useState(contact?.name || '')
  const [email, setEmail] = useState(contact?.email || '')
  const [phone, setPhone] = useState(contact?.phone || '')
  const [title, setTitle] = useState(contact?.title || '')
  const [companyId, setCompanyId] = useState(contact?.companyId || (companies[0]?.id ?? ''))
  const [tagsStr, setTagsStr] = useState(contact?.tags ? contact.tags.join(', ') : 'Decision Maker')
  const [status, setStatus] = useState<'lead' | 'active' | 'churned'>(contact?.status || 'active')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !email.trim()) return

    const selComp = companies.find((c) => c.id === companyId)
    const tags = tagsStr
      .split(',')
      .map((t: string) => t.trim())
      .filter(Boolean)

    onSave({
      id: contact?.id,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      title: title.trim(),
      companyId,
      companyName: selComp?.name || '',
      tags,
      status,
    })
  }

  return (
    <div className="crm-modal-overlay" onClick={onClose}>
      <div className="crm-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="crm-modal-header">
            <h3 className="crm-modal-title">{contact?.id ? 'Edit Contact' : 'New Contact'}</h3>
            <button type="button" className="crm-modal-close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="crm-modal-body">
            <div className="crm-form-group">
              <label className="crm-form-label">Full Name</label>
              <input
                className="crm-form-input"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Sarah Connor"
              />
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Email Address</label>
                <input
                  type="email"
                  className="crm-form-input"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                />
              </div>

              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Phone</label>
                <input
                  className="crm-form-input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 (555) 019-2834"
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Job Title</label>
                <input
                  className="crm-form-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. VP Operations"
                />
              </div>

              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Company</label>
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
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <div className="crm-form-group" style={{ flex: 2 }}>
                <label className="crm-form-label">Tags (comma separated)</label>
                <input
                  className="crm-form-input"
                  value={tagsStr}
                  onChange={(e) => setTagsStr(e.target.value)}
                  placeholder="VIP, Engineering, Enterprise"
                />
              </div>

              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Status</label>
                <select
                  className="crm-form-select"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as any)}
                >
                  <option value="active">Active</option>
                  <option value="lead">Lead</option>
                  <option value="churned">Churned</option>
                </select>
              </div>
            </div>
          </div>
          <div className="crm-modal-footer">
            <button type="button" className="crm-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="crm-btn crm-btn-primary">
              Save Contact
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

import React, { useState } from 'react'
import type { Company } from '../../../shared/types'

interface CompanyModalProps {
  company?: Partial<Company>
  onClose: () => void
  onSave: (company: Partial<Company>) => void
}

export function CompanyModal({ company, onClose, onSave }: CompanyModalProps) {
  const [name, setName] = useState(company?.name || '')
  const [domain, setDomain] = useState(company?.domain || '')
  const [industry, setIndustry] = useState(company?.industry || '')
  const [size, setSize] = useState(company?.size || '50-200')
  const [city, setCity] = useState(company?.city || '')
  const [country, setCountry] = useState(company?.country || '')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    onSave({
      id: company?.id,
      name: name.trim(),
      domain: domain.trim(),
      industry: industry.trim(),
      size,
      city: city.trim(),
      country: country.trim(),
    })
  }

  return (
    <div className="crm-modal-overlay" onClick={onClose}>
      <div className="crm-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="crm-modal-header">
            <h3 className="crm-modal-title">{company?.id ? 'Edit Company' : 'New Company Account'}</h3>
            <button type="button" className="crm-modal-close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="crm-modal-body">
            <div className="crm-form-group">
              <label className="crm-form-label">Company Name</label>
              <input
                className="crm-form-input"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Corporation"
              />
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Domain / Website</label>
                <input
                  className="crm-form-input"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="acme.com"
                />
              </div>

              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Industry</label>
                <input
                  className="crm-form-input"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="Software / Healthcare"
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">Company Size</label>
                <select
                  className="crm-form-select"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                >
                  <option value="1-10">1-10 employees</option>
                  <option value="11-50">11-50 employees</option>
                  <option value="50-200">50-200 employees</option>
                  <option value="200-1000">200-1000 employees</option>
                  <option value="1000+">1000+ Enterprise</option>
                </select>
              </div>

              <div className="crm-form-group" style={{ flex: 1 }}>
                <label className="crm-form-label">City, Country</label>
                <input
                  className="crm-form-input"
                  value={city ? `${city}, ${country}` : country}
                  onChange={(e) => {
                    const parts = e.target.value.split(',')
                    setCity(parts[0]?.trim() || '')
                    setCountry(parts[1]?.trim() || '')
                  }}
                  placeholder="San Francisco, USA"
                />
              </div>
            </div>
          </div>
          <div className="crm-modal-footer">
            <button type="button" className="crm-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="crm-btn crm-btn-primary">
              Save Company
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

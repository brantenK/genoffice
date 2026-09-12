import React, { useEffect, useState } from 'react'
import type { Company } from '../../../shared/types'
import { XIcon } from './Icons'

interface CompanyModalProps {
  company?: Partial<Company>
  onClose: () => void
  onSave: (company: Partial<Company>) => void
}

export function CompanyModal({ company, onClose, onSave }: CompanyModalProps) {
  const [name, setName] = useState(company?.name || '')
  const [domain, setDomain] = useState(company?.domain || '')
  const [industry, setIndustry] = useState(company?.industry || '')
  const [size, setSize] = useState(company?.size || '50–200')
  const [city, setCity] = useState(company?.city || '')
  const [country, setCountry] = useState(company?.country || '')

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
    <div className="crm-modal-backdrop" onClick={onClose}>
      <div className="crm-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="crm-modal-header">
            <h3 className="crm-modal-title">{company?.id ? 'Edit Account' : 'New Account'}</h3>
            <button type="button" className="crm-modal-close-btn" onClick={onClose}>
              <XIcon size={14} />
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
                placeholder="e.g. Acme Global Technologies"
                autoFocus
              />
            </div>

            <div className="crm-form-row">
              <div className="crm-form-group">
                <label className="crm-form-label">Domain Website</label>
                <input
                  type="text"
                  className="crm-form-input"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="acme.tech"
                />
              </div>

              <div className="crm-form-group">
                <label className="crm-form-label">Industry Sector</label>
                <input
                  className="crm-form-input"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="e.g. Enterprise Software"
                />
              </div>
            </div>

            <div className="crm-form-group">
              <label className="crm-form-label">Organization Size</label>
              <select
                className="crm-form-select"
                value={size}
                onChange={(e) => setSize(e.target.value)}
              >
                <option value="1–10">1–10 employees</option>
                <option value="10–50">10–50 employees</option>
                <option value="50–200">50–200 employees</option>
                <option value="200–500">200–500 employees</option>
                <option value="500–1000">500–1000 employees</option>
                <option value="1000+">1000+ enterprise</option>
              </select>
            </div>

            <div className="crm-form-row">
              <div className="crm-form-group">
                <label className="crm-form-label">City Headquarters</label>
                <input
                  className="crm-form-input"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="San Francisco"
                />
              </div>

              <div className="crm-form-group">
                <label className="crm-form-label">Country</label>
                <input
                  className="crm-form-input"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="United States"
                />
              </div>
            </div>
          </div>

          <div className="crm-modal-footer">
            <button type="button" className="crm-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="crm-btn crm-btn-primary">
              {company?.id ? 'Save Changes' : 'Create Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

import React, { useCallback, useRef, useState } from 'react'
import type { Company } from '../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { XIcon } from './Icons'
import { useDialogA11y } from './useDialogA11y'

export function CompanyModal({
  company,
  onClose,
  onSave,
}: {
  company?: Partial<Company>
  onClose: () => void
  onSave: (company: Partial<Company>) => void
}) {
  const [name, setName] = useState(company?.name || ''),
    [domain, setDomain] = useState(company?.domain || ''),
    [website, setWebsite] = useState(company?.website || ''),
    [industry, setIndustry] = useState(company?.industry || ''),
    [size, setSize] = useState(company?.size || '50–200'),
    [city, setCity] = useState(company?.city || ''),
    [country, setCountry] = useState(company?.country || '')
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [touched, setTouched] = useState<Record<string, boolean>>({}),
    [attempted, setAttempted] = useState(false),
    [discardOpen, setDiscardOpen] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null)
  const duplicateRequestId = useRef(0)
  const ref = useRef<HTMLDivElement>(null),
    firstInvalid = useRef<HTMLInputElement | null>(null)
  const initial = useRef({
    name: company?.name || '',
    domain: company?.domain || '',
    website: company?.website || '',
    industry: company?.industry || '',
    size: company?.size || '50–200',
    city: company?.city || '',
    country: company?.country || '',
  })
  const dirty =
    JSON.stringify({ name, domain, website, industry, size, city, country }) !==
    JSON.stringify(initial.current)
  const validate = useCallback(() => {
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Enter an account name'
    if (website.trim() && !/^(https?:\/\/)?[^\s.]+\.[^\s]+$/i.test(website.trim()))
      next.website = 'Enter a valid website address'
    setErrors(next)
    return next
  }, [name, website])
  const close = useCallback(() => {
    if (dirty) setDiscardOpen(true)
    else onClose()
  }, [dirty, onClose])
  useDialogA11y(ref, close)
  const show = (field: string) => (attempted || touched[field]) && errors[field]
  const checkDuplicate = async (nameValue: string, domainValue: string) => {
    const requestId = ++duplicateRequestId.current
    const queriedName = nameValue.trim()
    const queriedDomain = domainValue.trim()
    if (!window.crmApi || (!queriedName && !queriedDomain)) return
    try {
      const match = await window.crmApi.findCompanyDuplicate(
        queriedName,
        queriedDomain || undefined,
        company?.id,
      )
      if (
        requestId !== duplicateRequestId.current ||
        name.trim() !== queriedName ||
        domain.trim() !== queriedDomain
      )
        return
      setDuplicateWarning(match ? `An account with this name already exists: ${match.name}` : null)
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
    await checkDuplicate(name, domain)
    onSave({
      id: company?.id,
      name: name.trim(),
      domain: domain.trim(),
      website: website.trim(),
      industry: industry.trim(),
      size,
      city: city.trim(),
      country: country.trim(),
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
          aria-labelledby="crm-company-modal-title"
          onClick={(e) => e.stopPropagation()}
        >
          <form onSubmit={submit} noValidate>
            <div className="crm-modal-header">
              <h3 id="crm-company-modal-title" className="crm-modal-title">
                {company?.id ? 'Edit Account' : 'New Account'}
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
                <label className="crm-form-label" htmlFor="crm-company-name">
                  Company Name
                </label>
                <input
                  id="crm-company-name"
                  ref={(el) => {
                    if (errors.name) firstInvalid.current = el
                  }}
                  className="crm-form-input"
                  required
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setDuplicateWarning(null)
                  }}
                  onBlur={() => {
                    setTouched((p) => ({ ...p, name: true }))
                    validate()
                    void checkDuplicate(name, domain)
                  }}
                  placeholder="e.g. Acme Global Technologies"
                  autoFocus
                  aria-invalid={show('name') ? true : undefined}
                  aria-describedby={show('name') ? 'crm-company-name-error' : undefined}
                />
                {show('name') && (
                  <div id="crm-company-name-error" className="crm-field-error">
                    {errors.name}
                  </div>
                )}
              </div>
              <div className="crm-form-row">
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-company-domain">
                    Domain
                  </label>
                  <input
                    id="crm-company-domain"
                    className="crm-form-input"
                    value={domain}
                    onChange={(e) => {
                      setDomain(e.target.value)
                      setDuplicateWarning(null)
                    }}
                    onBlur={() => void checkDuplicate(name, domain)}
                    placeholder="acme.tech"
                  />
                </div>
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-company-website">
                    Website
                  </label>
                  <input
                    id="crm-company-website"
                    type="url"
                    className="crm-form-input"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    onBlur={() => {
                      setTouched((p) => ({ ...p, website: true }))
                      validate()
                    }}
                    placeholder="https://acme.tech"
                    aria-invalid={show('website') ? true : undefined}
                    aria-describedby={show('website') ? 'crm-company-website-error' : undefined}
                  />
                  {show('website') && (
                    <div id="crm-company-website-error" className="crm-field-error">
                      {errors.website}
                    </div>
                  )}
                </div>
              </div>
              {duplicateWarning && <div className="crm-field-warning">{duplicateWarning}</div>}
              <div className="crm-form-group">
                <label className="crm-form-label" htmlFor="crm-company-industry">
                  Industry Sector
                </label>
                <input
                  id="crm-company-industry"
                  className="crm-form-input"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="e.g. Enterprise Software"
                />
              </div>
              <div className="crm-form-group">
                <label className="crm-form-label" htmlFor="crm-company-size">
                  Organization Size
                </label>
                <select
                  id="crm-company-size"
                  className="crm-form-select"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                >
                  {['1–10', '10–50', '50–200', '200–500', '500–1000', '1000+'].map((v) => (
                    <option key={v} value={v}>
                      {v} employees
                    </option>
                  ))}
                </select>
              </div>
              <div className="crm-form-row">
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-company-city">
                    City Headquarters
                  </label>
                  <input
                    id="crm-company-city"
                    className="crm-form-input"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="San Francisco"
                  />
                </div>
                <div className="crm-form-group">
                  <label className="crm-form-label" htmlFor="crm-company-country">
                    Country
                  </label>
                  <input
                    id="crm-company-country"
                    className="crm-form-input"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    placeholder="United States"
                  />
                </div>
              </div>
            </div>
            <div className="crm-modal-footer">
              <button type="button" className="crm-btn" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="crm-btn crm-btn-primary">
                {company?.id ? 'Save Changes' : 'Create Account'}
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

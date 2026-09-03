import React, { useState } from 'react'
import type { Company } from '../../../shared/types'
import { BuildingIcon, SearchIcon, EditIcon, TrashIcon } from './Icons'

interface CompaniesViewProps {
  companies: Company[]
  onEditCompany: (company: Company) => void
  onDeleteCompany: (id: string) => void
}

export function CompaniesView({ companies, onEditCompany, onDeleteCompany }: CompaniesViewProps) {
  const [search, setSearch] = useState('')

  const filtered = companies.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.domain || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.industry || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.city || '').toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="crm-table-container">
      <div className="crm-table-toolbar">
        <div className="crm-search-box" style={{ width: '280px' }}>
          <SearchIcon size={14} />
          <input
            type="text"
            className="crm-search-input-bare"
            placeholder="Search accounts by name, domain, industry..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div style={{ fontSize: '12.5px', color: 'var(--crm-text-muted)', fontWeight: 500 }}>
          {filtered.length} Accounts
        </div>
      </div>

      <div className="crm-table-wrapper">
        <table className="crm-table">
          <thead>
            <tr>
              <th>Account Name</th>
              <th>Domain</th>
              <th>Industry</th>
              <th>Employees</th>
              <th>Headquarters</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const initials = c.name
                .split(' ')
                .map((n: string) => n[0])
                .join('')
                .toUpperCase()
                .slice(0, 2)

              return (
                <tr key={c.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <span className="crm-avatar" style={{ background: '#f8fafc', color: '#0284c7' }}>
                        <BuildingIcon size={13} />
                      </span>
                      <strong
                        style={{ color: 'var(--crm-text)', cursor: 'pointer' }}
                        onClick={() => onEditCompany(c)}
                      >
                        {c.name}
                      </strong>
                    </div>
                  </td>
                  <td>
                    {c.domain ? (
                      <span style={{ color: 'var(--crm-accent)', fontFamily: 'monospace', fontSize: '12px' }}>
                        {c.domain}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{c.industry || '—'}</td>
                  <td style={{ color: 'var(--crm-text-secondary)' }}>{c.size || '—'}</td>
                  <td>
                    {c.city || c.country
                      ? `${c.city ? c.city + ', ' : ''}${c.country || ''}`
                      : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button
                        className="crm-icon-action-btn"
                        title="Edit Account"
                        onClick={() => onEditCompany(c)}
                      >
                        <EditIcon size={13} />
                      </button>
                      <button
                        className="crm-icon-action-btn delete"
                        title="Delete Account"
                        onClick={() => onDeleteCompany(c.id)}
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

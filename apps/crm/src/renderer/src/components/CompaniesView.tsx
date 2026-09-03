import React, { useState } from 'react'
import type { Company } from '../../../shared/types'

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
        <input
          type="text"
          className="crm-search-input"
          placeholder="Search accounts by company name, domain, industry..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          {filtered.length} Organizations
        </div>
      </div>

      <table className="crm-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Domain</th>
            <th>Industry</th>
            <th>Size</th>
            <th>Location</th>
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
                    <span
                      className="crm-avatar"
                      style={{ background: '#fef3c7', color: '#b45309' }}
                    >
                      {initials}
                    </span>
                    <strong style={{ color: 'var(--text-primary)' }}>{c.name}</strong>
                  </div>
                </td>
                <td>
                  {c.domain ? (
                    <span style={{ color: 'var(--crm-accent)' }}>{c.domain}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{c.industry || '—'}</td>
                <td>{c.size || '—'}</td>
                <td>{[c.city, c.country].filter(Boolean).join(', ') || '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="crm-btn"
                    style={{ padding: '4px 8px', fontSize: '12px', marginRight: '6px' }}
                    onClick={() => onEditCompany(c)}
                  >
                    Edit
                  </button>
                  <button
                    className="crm-btn"
                    style={{ padding: '4px 8px', fontSize: '12px', color: 'var(--danger)' }}
                    onClick={() => onDeleteCompany(c.id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            )
          })}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={6} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                No accounts found matching your search
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

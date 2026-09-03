import React, { useState } from 'react'
import type { Contact } from '../../../shared/types'

interface ContactsViewProps {
  contacts: Contact[]
  onEditContact: (contact: Contact) => void
  onDeleteContact: (id: string) => void
}

export function ContactsView({ contacts, onEditContact, onDeleteContact }: ContactsViewProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'lead' | 'churned'>('all')

  const filtered = contacts.filter((c) => {
    const matchesSearch =
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.email.toLowerCase().includes(search.toLowerCase()) ||
      (c.companyName || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.title || '').toLowerCase().includes(search.toLowerCase())

    const matchesStatus = statusFilter === 'all' || c.status === statusFilter
    return matchesSearch && matchesStatus
  })

  return (
    <div className="crm-table-container">
      <div className="crm-table-toolbar">
        <input
          type="text"
          className="crm-search-input"
          placeholder="Search contacts by name, email, or company..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div style={{ display: 'flex', gap: '8px' }}>
          {(['all', 'active', 'lead', 'churned'] as const).map((st) => (
            <button
              key={st}
              className={`crm-btn ${statusFilter === st ? 'crm-btn-primary' : ''}`}
              style={{ fontSize: '12px', padding: '5px 10px', textTransform: 'capitalize' }}
              onClick={() => setStatusFilter(st)}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      <table className="crm-table">
        <thead>
          <tr>
            <th>Contact</th>
            <th>Job Title</th>
            <th>Company</th>
            <th>Email & Phone</th>
            <th>Tags</th>
            <th>Status</th>
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
                    <span className="crm-avatar">{initials}</span>
                    <strong style={{ color: 'var(--text-primary)' }}>{c.name}</strong>
                  </div>
                </td>
                <td>{c.title || '—'}</td>
                <td>{c.companyName || '—'}</td>
                <td>
                  <div>{c.email}</div>
                  {c.phone && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{c.phone}</div>}
                </td>
                <td>
                  {c.tags.map((t) => (
                    <span key={t} className="crm-tag">
                      {t}
                    </span>
                  ))}
                </td>
                <td>
                  <span className={c.status === 'active' ? 'crm-status-active' : 'crm-status-lead'}>
                    {c.status}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="crm-btn"
                    style={{ padding: '4px 8px', fontSize: '12px', marginRight: '6px' }}
                    onClick={() => onEditContact(c)}
                  >
                    Edit
                  </button>
                  <button
                    className="crm-btn"
                    style={{ padding: '4px 8px', fontSize: '12px', color: 'var(--danger)' }}
                    onClick={() => onDeleteContact(c.id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            )
          })}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={7} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                No contacts matching your search criteria
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

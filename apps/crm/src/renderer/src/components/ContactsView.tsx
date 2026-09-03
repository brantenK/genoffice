import React, { useState } from 'react'
import type { Contact } from '../../../shared/types'
import { SearchIcon, EditIcon, TrashIcon } from './Icons'

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
        <div className="crm-search-box" style={{ width: '280px' }}>
          <SearchIcon size={14} />
          <input
            type="text"
            className="crm-search-input-bare"
            placeholder="Search contacts by name, email, company..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="crm-filter-pills">
          {(['all', 'active', 'lead', 'churned'] as const).map((st) => (
            <button
              key={st}
              className={`crm-filter-pill ${statusFilter === st ? 'active' : ''}`}
              onClick={() => setStatusFilter(st)}
            >
              {st === 'all' ? 'All Contacts' : st.charAt(0).toUpperCase() + st.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="crm-table-wrapper">
        <table className="crm-table">
          <thead>
            <tr>
              <th>Contact Name</th>
              <th>Role & Title</th>
              <th>Account</th>
              <th>Contact Information</th>
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
                      <strong
                        style={{ color: 'var(--crm-text)', cursor: 'pointer' }}
                        onClick={() => onEditContact(c)}
                      >
                        {c.name}
                      </strong>
                    </div>
                  </td>
                  <td>{c.title || '—'}</td>
                  <td>{c.companyName || '—'}</td>
                  <td>
                    <div style={{ color: 'var(--crm-text)' }}>{c.email}</div>
                    {c.phone && <div style={{ fontSize: '11px', color: 'var(--crm-text-dim)' }}>{c.phone}</div>}
                  </td>
                  <td>
                    {c.tags.map((t) => (
                      <span key={t} className="crm-tag-pill">
                        {t}
                      </span>
                    ))}
                  </td>
                  <td>
                    <span className={`crm-status-pill ${c.status}`}>
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          backgroundColor: c.status === 'active' ? '#059669' : c.status === 'lead' ? '#2563eb' : '#dc2626',
                        }}
                      />
                      {c.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button
                        className="crm-icon-action-btn"
                        title="Edit Contact"
                        onClick={() => onEditContact(c)}
                      >
                        <EditIcon size={13} />
                      </button>
                      <button
                        className="crm-icon-action-btn delete"
                        title="Delete Contact"
                        onClick={() => onDeleteContact(c.id)}
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

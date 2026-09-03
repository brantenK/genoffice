import React, { useEffect, useState } from 'react'
import type { Company, Contact, CrmStats, Deal, DealStage } from '../../shared/types'
import { SEED_COMPANIES, SEED_CONTACTS, SEED_DEALS } from '../../main/seed-data'
import { PipelineView } from './components/PipelineView'
import { ContactsView } from './components/ContactsView'
import { CompaniesView } from './components/CompaniesView'
import { AnalyticsView } from './components/AnalyticsView'
import { DealModal } from './components/DealModal'
import { ContactModal } from './components/ContactModal'
import { CompanyModal } from './components/CompanyModal'

export function App() {
  const [activeNav, setActiveNav] = useState<'pipeline' | 'contacts' | 'companies' | 'analytics'>(
    'pipeline',
  )
  const [deals, setDeals] = useState<Deal[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [stats, setStats] = useState<CrmStats>({
    totalDeals: 0,
    totalPipelineValue: 0,
    wonValue: 0,
    winRatePct: 0,
    totalContacts: 0,
    totalCompanies: 0,
  })

  const [toast, setToast] = useState<string | null>(null)
  const [dealModalOpen, setDealModalOpen] = useState(false)
  const [editingDeal, setEditingDeal] = useState<Deal | undefined>(undefined)
  const [contactModalOpen, setContactModalOpen] = useState(false)
  const [editingContact, setEditingContact] = useState<Contact | undefined>(undefined)
  const [companyModalOpen, setCompanyModalOpen] = useState(false)
  const [editingCompany, setEditingCompany] = useState<Company | undefined>(undefined)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const loadData = async () => {
    if (window.crmApi) {
      const [d, c, comp, s] = await Promise.all([
        window.crmApi.listDeals(),
        window.crmApi.listContacts(),
        window.crmApi.listCompanies(),
        window.crmApi.getStats(),
      ])
      setDeals(d)
      setContacts(c)
      setCompanies(comp)
      setStats(s)
    } else {
      // Browser fallback for development
      setDeals(SEED_DEALS)
      setContacts(SEED_CONTACTS)
      setCompanies(SEED_COMPANIES)
      const totalVal = SEED_DEALS.reduce((sum, d) => sum + (d.amount || 0), 0)
      const wonVal = SEED_DEALS.filter((d) => d.stage === 'won').reduce(
        (sum, d) => sum + (d.amount || 0),
        0,
      )
      setStats({
        totalDeals: SEED_DEALS.length,
        totalPipelineValue: totalVal,
        wonValue: wonVal,
        winRatePct: 60,
        totalContacts: SEED_CONTACTS.length,
        totalCompanies: SEED_COMPANIES.length,
      })
    }
  }

  useEffect(() => {
    void loadData()
  }, [])

  // Deal actions
  const handleSaveDeal = async (dealData: Partial<Deal>) => {
    if (window.crmApi) {
      await window.crmApi.saveDeal(dealData)
    } else {
      setDeals((prev) => {
        if (dealData.id) {
          return prev.map((d) => (d.id === dealData.id ? ({ ...d, ...dealData } as Deal) : d))
        }
        return [{ ...dealData, id: `deal-${Date.now()}` } as Deal, ...prev]
      })
    }
    setDealModalOpen(false)
    setEditingDeal(undefined)
    await loadData()
    showToast('Deal updated successfully')
  }

  const handleUpdateStage = async (id: string, stage: DealStage) => {
    if (window.crmApi) {
      await window.crmApi.updateDealStage(id, stage)
    } else {
      setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, stage } : d)))
    }
    await loadData()
  }

  const handleDeleteDeal = async (id: string) => {
    if (!confirm('Are you sure you want to delete this opportunity?')) return
    if (window.crmApi) {
      await window.crmApi.deleteDeal(id)
    } else {
      setDeals((prev) => prev.filter((d) => d.id !== id))
    }
    await loadData()
    showToast('Opportunity removed')
  }

  // Contact actions
  const handleSaveContact = async (contactData: Partial<Contact>) => {
    if (window.crmApi) {
      await window.crmApi.saveContact(contactData)
    } else {
      setContacts((prev) => {
        if (contactData.id) {
          return prev.map((c) =>
            c.id === contactData.id ? ({ ...c, ...contactData } as Contact) : c,
          )
        }
        return [{ ...contactData, id: `cont-${Date.now()}` } as Contact, ...prev]
      })
    }
    setContactModalOpen(false)
    setEditingContact(undefined)
    await loadData()
    showToast('Contact saved')
  }

  const handleDeleteContact = async (id: string) => {
    if (!confirm('Are you sure you want to delete this contact?')) return
    if (window.crmApi) {
      await window.crmApi.deleteContact(id)
    } else {
      setContacts((prev) => prev.filter((c) => c.id !== id))
    }
    await loadData()
    showToast('Contact removed')
  }

  // Company actions
  const handleSaveCompany = async (companyData: Partial<Company>) => {
    if (window.crmApi) {
      await window.crmApi.saveCompany(companyData)
    } else {
      setCompanies((prev) => {
        if (companyData.id) {
          return prev.map((c) =>
            c.id === companyData.id ? ({ ...c, ...companyData } as Company) : c,
          )
        }
        return [{ ...companyData, id: `comp-${Date.now()}` } as Company, ...prev]
      })
    }
    setCompanyModalOpen(false)
    setEditingCompany(undefined)
    await loadData()
    showToast('Company account saved')
  }

  const handleDeleteCompany = async (id: string) => {
    if (!confirm('Are you sure you want to delete this company?')) return
    if (window.crmApi) {
      await window.crmApi.deleteCompany(id)
    } else {
      setCompanies((prev) => prev.filter((c) => c.id !== id))
    }
    await loadData()
    showToast('Company removed')
  }

  // Cross-App integrations
  const handleExportToSheets = async () => {
    if (!window.crmApi) {
      showToast('Sheets integration ready (runs inside desktop app)')
      return
    }
    const res = await window.crmApi.exportToSheets()
    if (res.ok) {
      showToast('📊 Pipeline opened in Zanostack Sheets!')
    } else {
      alert('Export failed: ' + res.error)
    }
  }

  const handleGenerateProposal = async (dealId: string) => {
    if (!window.crmApi) {
      showToast('Proposal generator ready (runs inside desktop app)')
      return
    }
    const res = await window.crmApi.generateProposalDoc(dealId)
    if (res.ok) {
      showToast('📄 Commercial proposal opened in Zanostack Docs!')
    } else {
      alert('Proposal generation failed: ' + res.error)
    }
  }

  return (
    <div className="crm-layout">
      {/* Toast popup */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            backgroundColor: '#1e293b',
            color: '#f8fafc',
            padding: '12px 20px',
            borderRadius: '8px',
            fontSize: '13px',
            fontWeight: 600,
            boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            zIndex: 9999,
            animation: 'modalPop 0.2s ease',
          }}
        >
          {toast}
        </div>
      )}

      {/* Header */}
      <header className="crm-header">
        <div className="crm-header-left">
          <div className="crm-brand">
            <div className="crm-brand-badge">Z</div>
            <span className="crm-title">Zanostack CRM</span>
          </div>

          <nav className="crm-nav">
            <button
              className={`crm-nav-btn ${activeNav === 'pipeline' ? 'active' : ''}`}
              onClick={() => setActiveNav('pipeline')}
            >
              📊 Pipeline
            </button>
            <button
              className={`crm-nav-btn ${activeNav === 'contacts' ? 'active' : ''}`}
              onClick={() => setActiveNav('contacts')}
            >
              👥 Contacts
            </button>
            <button
              className={`crm-nav-btn ${activeNav === 'companies' ? 'active' : ''}`}
              onClick={() => setActiveNav('companies')}
            >
              🏢 Accounts
            </button>
            <button
              className={`crm-nav-btn ${activeNav === 'analytics' ? 'active' : ''}`}
              onClick={() => setActiveNav('analytics')}
            >
              📈 Analytics
            </button>
          </nav>
        </div>

        <div className="crm-header-right">
          <button
            className="crm-btn crm-btn-sheets"
            onClick={handleExportToSheets}
            title="Export full deals pipeline into a new Zanostack Sheets tab"
          >
            📊 Export to Sheets
          </button>

          {activeNav === 'contacts' ? (
            <button
              className="crm-btn crm-btn-primary"
              onClick={() => {
                setEditingContact(undefined)
                setContactModalOpen(true)
              }}
            >
              + New Contact
            </button>
          ) : activeNav === 'companies' ? (
            <button
              className="crm-btn crm-btn-primary"
              onClick={() => {
                setEditingCompany(undefined)
                setCompanyModalOpen(true)
              }}
            >
              + New Account
            </button>
          ) : (
            <button
              className="crm-btn crm-btn-primary"
              onClick={() => {
                setEditingDeal(undefined)
                setDealModalOpen(true)
              }}
            >
              + New Opportunity
            </button>
          )}
        </div>
      </header>

      {/* Quick Stats Banner */}
      <div className="crm-stats-bar">
        <div className="crm-stat-item">
          <span className="crm-stat-label">Pipeline Value</span>
          <span className="crm-stat-value">${stats.totalPipelineValue.toLocaleString()}</span>
        </div>
        <div className="crm-stat-divider" />
        <div className="crm-stat-item">
          <span className="crm-stat-label">Active Opportunities</span>
          <span className="crm-stat-value">{stats.totalDeals}</span>
        </div>
        <div className="crm-stat-divider" />
        <div className="crm-stat-item">
          <span className="crm-stat-label">Closed Won</span>
          <span className="crm-stat-value" style={{ color: '#16a34a' }}>
            ${stats.wonValue.toLocaleString()}
          </span>
        </div>
        <div className="crm-stat-divider" />
        <div className="crm-stat-item">
          <span className="crm-stat-label">Win Rate</span>
          <span className="crm-stat-value">{stats.winRatePct}%</span>
        </div>
        <div className="crm-stat-divider" />
        <div className="crm-stat-item">
          <span className="crm-stat-label">Total Contacts</span>
          <span className="crm-stat-value">{stats.totalContacts}</span>
        </div>
      </div>

      {/* Main View Area */}
      <main className="crm-content">
        {activeNav === 'pipeline' && (
          <PipelineView
            deals={deals}
            onEditDeal={(deal) => {
              setEditingDeal(deal)
              setDealModalOpen(true)
            }}
            onUpdateStage={handleUpdateStage}
            onDeleteDeal={handleDeleteDeal}
            onGenerateProposal={handleGenerateProposal}
          />
        )}

        {activeNav === 'contacts' && (
          <ContactsView
            contacts={contacts}
            onEditContact={(contact) => {
              setEditingContact(contact)
              setContactModalOpen(true)
            }}
            onDeleteContact={handleDeleteContact}
          />
        )}

        {activeNav === 'companies' && (
          <CompaniesView
            companies={companies}
            onEditCompany={(comp) => {
              setEditingCompany(comp)
              setCompanyModalOpen(true)
            }}
            onDeleteCompany={handleDeleteCompany}
          />
        )}

        {activeNav === 'analytics' && <AnalyticsView stats={stats} deals={deals} />}
      </main>

      {/* Modals */}
      {dealModalOpen && (
        <DealModal
          deal={editingDeal}
          companies={companies}
          contacts={contacts}
          onClose={() => {
            setDealModalOpen(false)
            setEditingDeal(undefined)
          }}
          onSave={handleSaveDeal}
        />
      )}

      {contactModalOpen && (
        <ContactModal
          contact={editingContact}
          companies={companies}
          onClose={() => {
            setContactModalOpen(false)
            setEditingContact(undefined)
          }}
          onSave={handleSaveContact}
        />
      )}

      {companyModalOpen && (
        <CompanyModal
          company={editingCompany}
          onClose={() => {
            setCompanyModalOpen(false)
            setEditingCompany(undefined)
          }}
          onSave={handleSaveCompany}
        />
      )}
    </div>
  )
}

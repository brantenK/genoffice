import React, { useEffect, useState } from 'react'
import type { Company, Contact, CrmStats, Deal, DealStage } from '../../shared/types'
import { SEED_COMPANIES, SEED_CONTACTS, SEED_DEALS } from '../../main/seed-data'
import { PipelineView } from './components/PipelineView'
import { DealsTableView } from './components/DealsTableView'
import { ContactsView } from './components/ContactsView'
import { CompaniesView } from './components/CompaniesView'
import { AnalyticsView } from './components/AnalyticsView'
import { DealModal } from './components/DealModal'
import { ContactModal } from './components/ContactModal'
import { CompanyModal } from './components/CompanyModal'
import {
  KanbanIcon,
  TableIcon,
  UsersIcon,
  BuildingIcon,
  ChartIcon,
  SheetsIcon,
  PlusIcon,
  SearchIcon,
  CheckIcon,
} from './components/Icons'

type NavView = 'pipeline' | 'table' | 'contacts' | 'companies' | 'analytics'

export function App() {
  const [activeNav, setActiveNav] = useState<NavView>('pipeline')
  const [globalSearch, setGlobalSearch] = useState('')

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
    setTimeout(() => setToast(null), 3000)
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
    showToast('Opportunity saved')
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
          return prev.map((c) => (c.id === contactData.id ? ({ ...c, ...contactData } as Contact) : c))
        }
        return [{ ...contactData, id: `contact-${Date.now()}` } as Contact, ...prev]
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
          return prev.map((c) => (c.id === companyData.id ? ({ ...c, ...companyData } as Company) : c))
        }
        return [{ ...companyData, id: `company-${Date.now()}` } as Company, ...prev]
      })
    }
    setCompanyModalOpen(false)
    setEditingCompany(undefined)
    await loadData()
    showToast('Account saved')
  }

  const handleDeleteCompany = async (id: string) => {
    if (!confirm('Are you sure you want to delete this organization?')) return
    if (window.crmApi) {
      await window.crmApi.deleteCompany(id)
    } else {
      setCompanies((prev) => prev.filter((c) => c.id !== id))
    }
    await loadData()
    showToast('Account removed')
  }

  // Cross-App Workflows
  const handleExportToSheets = async () => {
    if (window.crmApi) {
      const res = await window.crmApi.exportToSheets()
      if (res.ok) {
        showToast('Exporting to Zanostack Sheets...')
      } else {
        alert(res.error || 'Failed to export to Sheets')
      }
    }
  }

  const handleGenerateProposal = async (dealId: string) => {
    if (window.crmApi) {
      const res = await window.crmApi.generateProposalDoc(dealId)
      if (res.ok) {
        showToast('Opening proposal in Zanostack Docs...')
      } else {
        alert(res.error || 'Failed to generate proposal')
      }
    }
  }

  // Filtered lists based on search
  const filteredDeals = deals.filter(
    (d) =>
      d.name.toLowerCase().includes(globalSearch.toLowerCase()) ||
      (d.companyName || '').toLowerCase().includes(globalSearch.toLowerCase()) ||
      (d.contactName || '').toLowerCase().includes(globalSearch.toLowerCase()),
  )

  const filteredContacts = contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(globalSearch.toLowerCase()) ||
      c.email.toLowerCase().includes(globalSearch.toLowerCase()) ||
      (c.companyName || '').toLowerCase().includes(globalSearch.toLowerCase()),
  )

  const filteredCompanies = companies.filter(
    (comp) =>
      comp.name.toLowerCase().includes(globalSearch.toLowerCase()) ||
      (comp.domain || '').toLowerCase().includes(globalSearch.toLowerCase()),
  )

  return (
    <div className="crm-layout">
      {/* ── Top Command Bar ── */}
      <header className="crm-header">
        <div className="crm-header-left">
          {/* Segmented View Switcher */}
          <nav className="crm-segmented-nav">
            <button
              className={`crm-segmented-btn ${activeNav === 'pipeline' ? 'active' : ''}`}
              onClick={() => setActiveNav('pipeline')}
            >
              <KanbanIcon size={14} />
              <span>Board</span>
            </button>
            <button
              className={`crm-segmented-btn ${activeNav === 'table' ? 'active' : ''}`}
              onClick={() => setActiveNav('table')}
            >
              <TableIcon size={14} />
              <span>Table</span>
            </button>
            <button
              className={`crm-segmented-btn ${activeNav === 'contacts' ? 'active' : ''}`}
              onClick={() => setActiveNav('contacts')}
            >
              <UsersIcon size={14} />
              <span>Contacts</span>
            </button>
            <button
              className={`crm-segmented-btn ${activeNav === 'companies' ? 'active' : ''}`}
              onClick={() => setActiveNav('companies')}
            >
              <BuildingIcon size={14} />
              <span>Accounts</span>
            </button>
            <button
              className={`crm-segmented-btn ${activeNav === 'analytics' ? 'active' : ''}`}
              onClick={() => setActiveNav('analytics')}
            >
              <ChartIcon size={14} />
              <span>Analytics</span>
            </button>
          </nav>
        </div>

        <div className="crm-header-right">
          {/* Global Search */}
          <div className="crm-search-box">
            <SearchIcon size={13} />
            <input
              type="text"
              className="crm-search-input-bare"
              placeholder="Search CRM..."
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
            />
          </div>

          {/* Export to Sheets action */}
          <button
            className="crm-btn crm-btn-sheets"
            onClick={handleExportToSheets}
            title="Export pipeline into a new Zanostack Sheets tab"
          >
            <SheetsIcon size={14} />
            <span>Export to Sheets</span>
          </button>

          {/* Primary Create action */}
          {activeNav === 'contacts' ? (
            <button
              className="crm-btn crm-btn-primary"
              onClick={() => {
                setEditingContact(undefined)
                setContactModalOpen(true)
              }}
            >
              <PlusIcon size={14} />
              <span>New Contact</span>
            </button>
          ) : activeNav === 'companies' ? (
            <button
              className="crm-btn crm-btn-primary"
              onClick={() => {
                setEditingCompany(undefined)
                setCompanyModalOpen(true)
              }}
            >
              <PlusIcon size={14} />
              <span>New Account</span>
            </button>
          ) : (
            <button
              className="crm-btn crm-btn-primary"
              onClick={() => {
                setEditingDeal(undefined)
                setDealModalOpen(true)
              }}
            >
              <PlusIcon size={14} />
              <span>New Opportunity</span>
            </button>
          )}
        </div>
      </header>

      {/* ── Refined Metrics Strip ── */}
      <div className="crm-metrics-strip">
        <div className="crm-metric-item">
          <span className="crm-metric-label">Pipeline</span>
          <span className="crm-metric-value">${stats.totalPipelineValue.toLocaleString()}</span>
        </div>
        <div className="crm-metric-divider" />
        <div className="crm-metric-item">
          <span className="crm-metric-label">Active Opportunities</span>
          <span className="crm-metric-value">{stats.totalDeals}</span>
        </div>
        <div className="crm-metric-divider" />
        <div className="crm-metric-item">
          <span className="crm-metric-label">Closed Won</span>
          <span className="crm-metric-value highlight">${stats.wonValue.toLocaleString()}</span>
        </div>
        <div className="crm-metric-divider" />
        <div className="crm-metric-item">
          <span className="crm-metric-label">Win Rate</span>
          <span className="crm-metric-value">{stats.winRatePct}%</span>
        </div>
        <div className="crm-metric-divider" />
        <div className="crm-metric-item">
          <span className="crm-metric-label">Total Contacts</span>
          <span className="crm-metric-value">{stats.totalContacts}</span>
        </div>
      </div>

      {/* ── Main View Content ── */}
      <main className="crm-content">
        {activeNav === 'pipeline' && (
          <PipelineView
            deals={filteredDeals}
            onEditDeal={(deal) => {
              setEditingDeal(deal)
              setDealModalOpen(true)
            }}
            onUpdateStage={handleUpdateStage}
            onDeleteDeal={handleDeleteDeal}
            onGenerateProposal={handleGenerateProposal}
          />
        )}

        {activeNav === 'table' && (
          <DealsTableView
            deals={filteredDeals}
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
            contacts={filteredContacts}
            onEditContact={(contact) => {
              setEditingContact(contact)
              setContactModalOpen(true)
            }}
            onDeleteContact={handleDeleteContact}
          />
        )}

        {activeNav === 'companies' && (
          <CompaniesView
            companies={filteredCompanies}
            onEditCompany={(company) => {
              setEditingCompany(company)
              setCompanyModalOpen(true)
            }}
            onDeleteCompany={handleDeleteCompany}
          />
        )}

        {activeNav === 'analytics' && <AnalyticsView stats={stats} deals={deals} />}
      </main>

      {/* ── Modals ── */}
      {dealModalOpen && (
        <DealModal
          deal={editingDeal}
          companies={companies}
          contacts={contacts}
          onClose={() => setDealModalOpen(false)}
          onSave={handleSaveDeal}
        />
      )}

      {contactModalOpen && (
        <ContactModal
          contact={editingContact}
          companies={companies}
          onClose={() => setContactModalOpen(false)}
          onSave={handleSaveContact}
        />
      )}

      {companyModalOpen && (
        <CompanyModal
          company={editingCompany}
          onClose={() => setCompanyModalOpen(false)}
          onSave={handleSaveCompany}
        />
      )}

      {/* ── Toast Feedback ── */}
      {toast && (
        <div className="crm-toast">
          <CheckIcon size={14} style={{ color: '#34d399' }} />
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}

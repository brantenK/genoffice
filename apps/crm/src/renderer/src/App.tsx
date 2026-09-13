import React, { useEffect, useRef, useState } from 'react'
import type { Company, Contact, CrmStats, Deal, DealStage } from '../../shared/types'
import type { CrmRecoveryState } from '../../shared/ipc'
import { SEED_COMPANIES, SEED_CONTACTS, SEED_DEALS } from '../../main/seed-data'
import { PipelineView } from './components/PipelineView'
import { DealsTableView } from './components/DealsTableView'
import { ContactsView } from './components/ContactsView'
import { CompaniesView } from './components/CompaniesView'
import { AnalyticsView } from './components/AnalyticsView'
import { DealModal } from './components/DealModal'
import { ContactModal } from './components/ContactModal'
import { CompanyModal } from './components/CompanyModal'
import { ConfirmDialog } from './components/ConfirmDialog'
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
type SavingModal = 'deal' | 'contact' | 'company' | null
type DeleteRequest =
  | { kind: 'deal'; record: Deal }
  | { kind: 'contact'; record: Contact }
  | { kind: 'company'; record: Company }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The CRM operation failed'
}

export function App() {
  const [activeNav, setActiveNav] = useState<NavView>('pipeline')
  const [globalSearch, setGlobalSearch] = useState('')

  const [deals, setDeals] = useState<Deal[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [stats, setStats] = useState<CrmStats>({
    totalDeals: 0,
    openDeals: 0,
    wonDeals: 0,
    lostDeals: 0,
    totalPipelineValue: 0,
    weightedForecastValue: 0,
    avgOpenDealSize: 0,
    wonValue: 0,
    winRatePct: 0,
    totalContacts: 0,
    totalCompanies: 0,
  })

  const [toast, setToast] = useState<{
    message: string
    error: boolean
    action?: { label: string; run: () => void }
  } | null>(null)
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<CrmRecoveryState | null>(null)
  const [acknowledgingRecovery, setAcknowledgingRecovery] = useState(false)
  const [savingModal, setSavingModal] = useState<SavingModal>(null)
  const [dealModalOpen, setDealModalOpen] = useState(false)
  const [editingDeal, setEditingDeal] = useState<Deal | undefined>(undefined)
  const [contactModalOpen, setContactModalOpen] = useState(false)
  const [editingContact, setEditingContact] = useState<Contact | undefined>(undefined)
  const [companyModalOpen, setCompanyModalOpen] = useState(false)
  const [editingCompany, setEditingCompany] = useState<Company | undefined>(undefined)
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (msg: string, error = false, action?: { label: string; run: () => void }) => {
    if (toastTimeoutRef.current !== null) clearTimeout(toastTimeoutRef.current)
    setToast({ message: msg, error, action })
    const timeout = setTimeout(
      () => {
        if (toastTimeoutRef.current !== timeout) return
        toastTimeoutRef.current = null
        setToast(null)
      },
      action ? 8000 : 3000,
    )
    toastTimeoutRef.current = timeout
  }

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current !== null) clearTimeout(toastTimeoutRef.current)
    }
  }, [])

  const loadData = async () => {
    if (window.crmApi) {
      const [d, c, comp, s, recoveryState] = await Promise.all([
        window.crmApi.listDeals(),
        window.crmApi.listContacts(),
        window.crmApi.listCompanies(),
        window.crmApi.getStats(),
        window.crmApi.getRecoveryState(),
      ])
      setDeals(d)
      setContacts(c)
      setCompanies(comp)
      setStats(s)
      setRecovery(recoveryState)
    } else {
      setDeals(SEED_DEALS)
      setContacts(SEED_CONTACTS)
      setCompanies(SEED_COMPANIES)
      const openDeals = SEED_DEALS.filter((d) => d.stage !== 'won' && d.stage !== 'lost')
      const wonDeals = SEED_DEALS.filter((d) => d.stage === 'won')
      const lostDeals = SEED_DEALS.filter((d) => d.stage === 'lost')
      const totalVal = openDeals.reduce((sum, d) => sum + (d.amount || 0), 0)
      const wonVal = wonDeals.reduce((sum, d) => sum + (d.amount || 0), 0)
      const closedDeals = wonDeals.length + lostDeals.length
      setStats({
        totalDeals: SEED_DEALS.length,
        openDeals: openDeals.length,
        wonDeals: wonDeals.length,
        lostDeals: lostDeals.length,
        totalPipelineValue: totalVal,
        weightedForecastValue: Math.round(
          openDeals.reduce((sum, d) => sum + (d.amount * d.probability) / 100, 0),
        ),
        avgOpenDealSize: openDeals.length ? Math.round(totalVal / openDeals.length) : 0,
        wonValue: wonVal,
        winRatePct: closedDeals ? Math.round((wonDeals.length / closedDeals) * 100) : 0,
        totalContacts: SEED_CONTACTS.length,
        totalCompanies: SEED_COMPANIES.length,
      })
      setRecovery(null)
    }
    setLoadError(null)
  }

  useEffect(() => {
    void loadData().catch((error: unknown) => setLoadError(errorMessage(error)))
  }, [])

  const refreshRecovery = async () => {
    if (window.crmApi) setRecovery(await window.crmApi.getRecoveryState())
  }

  const handleOperationError = async (error: unknown) => {
    const message = errorMessage(error)
    showToast(message, true)
    if (/recovery/i.test(message)) {
      try {
        await refreshRecovery()
      } catch {
        // Preserve the original operation error in the toast.
      }
    }
  }

  const handleAcknowledgeRecovery = async () => {
    if (!window.crmApi || acknowledgingRecovery) return
    setAcknowledgingRecovery(true)
    try {
      await window.crmApi.acknowledgeRecovery()
      await loadData()
    } catch (error: unknown) {
      await handleOperationError(error)
    } finally {
      setAcknowledgingRecovery(false)
    }
  }

  // Deal actions
  const handleSaveDeal = async (dealData: Partial<Deal>) => {
    if (savingModal) return
    setSavingModal('deal')
    try {
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
      await loadData()
      setDealModalOpen(false)
      setEditingDeal(undefined)
      showToast('Opportunity saved')
    } catch (error: unknown) {
      await handleOperationError(error)
    } finally {
      setSavingModal(null)
    }
  }

  const handleInvoiceCreated = async (dealId: string, invoiceNumber: string) => {
    try {
      setDeals((prev) =>
        prev.map((d) =>
          d.id === dealId ? { ...d, invoiceNumber, invoicedAt: new Date().toISOString() } : d,
        ),
      )
      showToast(`Invoice ${invoiceNumber} created in Zano Books`)
      await loadData()
    } catch (error: unknown) {
      await handleOperationError(error)
    }
  }

  const handleUpdateStage = async (id: string, stage: DealStage) => {
    try {
      if (window.crmApi) {
        await window.crmApi.updateDealStage(id, stage)
      } else {
        setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, stage } : d)))
      }
      await loadData()
    } catch (error: unknown) {
      await handleOperationError(error)
    }
  }

  const handleDeleteDeal = async (id: string) => {
    const record = deals.find((d) => d.id === id)
    if (record) setDeleteRequest({ kind: 'deal', record })
  }
  const handleDeleteContact = async (id: string) => {
    const record = contacts.find((c) => c.id === id)
    if (record) setDeleteRequest({ kind: 'contact', record })
  }
  const handleDeleteCompany = async (id: string) => {
    const record = companies.find((c) => c.id === id)
    if (record) setDeleteRequest({ kind: 'company', record })
  }
  const confirmDelete = async () => {
    if (!deleteRequest || deleting) return
    const request = deleteRequest
    setDeleting(true)
    try {
      if (window.crmApi)
        await (request.kind === 'deal'
          ? window.crmApi.deleteDeal(request.record.id)
          : request.kind === 'contact'
            ? window.crmApi.deleteContact(request.record.id)
            : window.crmApi.deleteCompany(request.record.id))
      else if (request.kind === 'deal')
        setDeals((prev) => prev.filter((d) => d.id !== request.record.id))
      else if (request.kind === 'contact')
        setContacts((prev) => prev.filter((c) => c.id !== request.record.id))
      else setCompanies((prev) => prev.filter((c) => c.id !== request.record.id))
      await loadData()
      setDeleteRequest(null)
      showToast(
        `${request.kind === 'deal' ? 'Opportunity' : request.kind === 'contact' ? 'Contact' : 'Account'} removed`,
        false,
        { label: 'Undo', run: () => void undoDelete(request) },
      )
    } catch (error: unknown) {
      await handleOperationError(error)
    } finally {
      setDeleting(false)
    }
  }

  // Contact actions
  const handleSaveContact = async (contactData: Partial<Contact>) => {
    if (savingModal) return
    setSavingModal('contact')
    try {
      if (window.crmApi) {
        await window.crmApi.saveContact(contactData)
      } else {
        setContacts((prev) => {
          if (contactData.id) {
            return prev.map((c) =>
              c.id === contactData.id ? ({ ...c, ...contactData } as Contact) : c,
            )
          }
          return [{ ...contactData, id: `contact-${Date.now()}` } as Contact, ...prev]
        })
      }
      await loadData()
      setContactModalOpen(false)
      setEditingContact(undefined)
      showToast('Contact saved')
    } catch (error: unknown) {
      await handleOperationError(error)
    } finally {
      setSavingModal(null)
    }
  }

  const undoDelete = async (request: DeleteRequest) => {
    try {
      if (!window.crmApi) {
        if (request.kind === 'deal') setDeals((p) => [request.record, ...p])
        else if (request.kind === 'contact') setContacts((p) => [request.record, ...p])
        else setCompanies((p) => [request.record, ...p])
      } else {
        if (request.kind === 'deal') await window.crmApi.saveDeal(request.record)
        else if (request.kind === 'contact') await window.crmApi.saveContact(request.record)
        else await window.crmApi.saveCompany(request.record)
      }
      await loadData()
      showToast('Removal undone')
    } catch (error: unknown) {
      await handleOperationError(error)
    }
  }

  // Company actions
  const handleSaveCompany = async (companyData: Partial<Company>) => {
    if (savingModal) return
    setSavingModal('company')
    try {
      if (window.crmApi) {
        await window.crmApi.saveCompany(companyData)
      } else {
        setCompanies((prev) => {
          if (companyData.id) {
            return prev.map((c) =>
              c.id === companyData.id ? ({ ...c, ...companyData } as Company) : c,
            )
          }
          return [{ ...companyData, id: `company-${Date.now()}` } as Company, ...prev]
        })
      }
      await loadData()
      setCompanyModalOpen(false)
      setEditingCompany(undefined)
      showToast('Account saved')
    } catch (error: unknown) {
      await handleOperationError(error)
    } finally {
      setSavingModal(null)
    }
  }

  // Cross-App Workflows
  const handleExportToSheets = async () => {
    try {
      if (window.crmApi) {
        const res = await window.crmApi.exportToSheets()
        if (res.ok) {
          showToast('Exporting to Zanostack Sheets...')
        } else {
          showToast(res.error || 'Failed to export to Sheets', true)
        }
      }
    } catch (error: unknown) {
      await handleOperationError(error)
    }
  }

  const handleGenerateProposal = async (dealId: string) => {
    try {
      if (window.crmApi) {
        const res = await window.crmApi.generateProposalDoc(dealId)
        if (res.ok) {
          showToast('Opening proposal in Zanostack Docs...')
        } else {
          showToast(res.error || 'Failed to generate proposal', true)
        }
      }
    } catch (error: unknown) {
      await handleOperationError(error)
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

      {loadError && (
        <div className="crm-banner" role="alert">
          <span>Unable to load CRM data: {loadError}</span>
          <button
            className="crm-btn"
            type="button"
            onClick={() =>
              void loadData().catch((error: unknown) => setLoadError(errorMessage(error)))
            }
          >
            Retry
          </button>
        </div>
      )}

      {!window.crmApi && (
        <div className="crm-banner crm-banner--preview" role="status">
          Preview mode — changes are not saved.
        </div>
      )}

      {recovery?.pending && (
        <div className="crm-banner" role="alert">
          <div>
            <strong>Data recovery required</strong>
            <span> Corrupted CRM files were quarantined and loaded empty.</span>
            <ul>
              {recovery.items.map((item) => (
                <li key={item.quarantinePath}>
                  {item.entity}: {item.file} → {item.quarantinePath} ({item.reason})
                </li>
              ))}
            </ul>
          </div>
          <button
            className="crm-btn"
            type="button"
            disabled={acknowledgingRecovery}
            onClick={() => void handleAcknowledgeRecovery()}
          >
            {acknowledgingRecovery ? 'Acknowledging…' : 'Acknowledge'}
          </button>
        </div>
      )}

      {/* ── Refined Metrics Strip ── */}
      <div className="crm-metrics-strip">
        <div className="crm-metric-item">
          <span className="crm-metric-label">Open Pipeline</span>
          <span className="crm-metric-value">${stats.totalPipelineValue.toLocaleString()}</span>
        </div>
        <div className="crm-metric-divider" />
        <div className="crm-metric-item">
          <span className="crm-metric-label">Active Opportunities</span>
          <span className="crm-metric-value">{stats.openDeals}</span>
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
            onInvoiceCreated={handleInvoiceCreated}
            onShowToast={showToast}
            onRefresh={loadData}
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
          saving={savingModal === 'deal'}
          onInvoiceCreated={handleInvoiceCreated}
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

      {deleteRequest && (
        <ConfirmDialog
          title={`Delete ${deleteRequest.kind === 'deal' ? 'opportunity' : deleteRequest.kind === 'contact' ? 'contact' : 'account'}?`}
          message={
            deleteRequest.kind === 'company'
              ? `“${deleteRequest.record.name}” will be removed. ${contacts.filter((c) => c.companyId === deleteRequest.record.id).length} contacts and ${deals.filter((d) => d.companyId === deleteRequest.record.id).length} opportunities reference this account.`
              : deleteRequest.kind === 'contact'
                ? `“${deleteRequest.record.name}” will be removed. ${deals.filter((d) => d.contactId === deleteRequest.record.id).length} opportunities reference this contact.`
                : `“${deleteRequest.record.name}” will be removed. Use Undo immediately if you change your mind.`
          }
          busy={deleting}
          onCancel={() => !deleting && setDeleteRequest(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {/* ── Toast Feedback ── */}
      {toast && (
        <div
          className={`crm-toast ${toast.error ? 'crm-toast--error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {!toast.error && <CheckIcon size={14} style={{ color: '#34d399' }} />}
          <span>{toast.message}</span>
          {toast.action && (
            <button type="button" className="crm-toast-action" onClick={toast.action.run}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

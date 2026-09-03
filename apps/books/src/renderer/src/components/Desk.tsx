import React, { useEffect, useState } from 'react'
import {
  LayoutDashboard,
  Receipt,
  ShoppingBag,
  Users,
  FolderTree,
  BookOpen,
  FileSpreadsheet,
  Settings,
  ChevronLeft,
  ChevronRight,
  Plus,
  ArrowUpRight,
  HelpCircle,
  Command,
} from 'lucide-react'
import { useBooksStore } from '../store'
import { Dashboard } from './Dashboard'
import { InvoiceList } from './InvoiceList'
import { InvoiceForm } from './InvoiceForm'
import { PartyList } from './PartyList'
import { ChartOfAccounts } from './ChartOfAccounts'
import { JournalEntryList } from './JournalEntryList'
import { ReportsView } from './ReportsView'
import { InvoicePrintModal } from './InvoicePrintModal'
import type { BooksNavigationTab } from '../../../shared/types'

export function Desk() {
  const {
    activeTab,
    setActiveTab,
    activeInvoiceId,
    setActiveInvoiceId,
    loadData,
    data,
  } = useBooksStore()

  const [sidebarOpen, setSidebarOpen] = useState(true)

  useEffect(() => {
    loadData()
  }, [loadData])

  const navItems: { id: BooksNavigationTab; label: string; icon: React.ComponentType<{ className?: string }>; section?: string }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'invoices', label: 'Sales Invoices', icon: Receipt, section: 'Sales' },
    { id: 'parties', label: 'Customers & Parties', icon: Users, section: 'Sales' },
    { id: 'purchases', label: 'Purchase Bills', icon: ShoppingBag, section: 'Purchases' },
    { id: 'accounts', label: 'Chart of Accounts', icon: FolderTree, section: 'Accounting' },
    { id: 'journal', label: 'Journal Entries', icon: BookOpen, section: 'Accounting' },
    { id: 'reports', label: 'Financial Reports', icon: FileSpreadsheet, section: 'Reports' },
  ]

  const handleOpenCrm = () => {
    if (window.booksApi?.openInCrm) window.booksApi.openInCrm()
  }

  const handleOpenTenders = () => {
    if (window.booksApi?.openInTenders) window.booksApi.openInTenders()
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#FBFBFB] text-[#1E293B]">
      {/* ── FRAPPE BOOKS SIGNATURE SIDEBAR ── */}
      <aside
        className={`flex-shrink-0 bg-[#F8F8F8] border-r border-[#EDEDED] flex flex-col justify-between transition-all duration-200 ${
          sidebarOpen ? 'w-60' : 'w-16'
        }`}
      >
        {/* Brand & Company Header */}
        <div>
          <div className="p-4 border-b border-[#EDEDED] flex items-center justify-between">
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="w-8 h-8 rounded-lg bg-[#0F766E] text-white flex items-center justify-center font-bold text-sm shadow-xs flex-shrink-0">
                ZB
              </div>
              {sidebarOpen && (
                <div className="overflow-hidden">
                  <div className="font-bold text-sm text-[#1E293B] leading-none truncate">Zano Books</div>
                  <div className="text-[11px] text-[#7C7C7C] truncate mt-1">
                    {data.settings.currency} · Double-Entry
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-1 text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#EDEDED] rounded transition-colors"
            >
              {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          </div>

          {/* Quick Action Button */}
          {sidebarOpen && (
            <div className="p-3">
              <button
                onClick={() => {
                  setActiveTab('invoices')
                  setActiveInvoiceId('new')
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] shadow-xs transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                New Invoice
              </button>
            </div>
          )}

          {/* Navigation Links */}
          <nav className="p-2 space-y-1">
            {navItems.map((item, idx) => {
              const Icon = item.icon
              const isActive = activeTab === item.id && activeInvoiceId === null
              const showSection =
                sidebarOpen &&
                item.section &&
                (idx === 0 || navItems[idx - 1]?.section !== item.section)

              return (
                <React.Fragment key={item.id}>
                  {showSection && (
                    <div className="text-[10px] font-bold uppercase tracking-wider text-[#999999] px-3 pt-3 pb-1">
                      {item.section}
                    </div>
                  )}
                  <button
                    onClick={() => {
                      setActiveTab(item.id)
                      setActiveInvoiceId(null)
                    }}
                    title={!sidebarOpen ? item.label : undefined}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                      isActive
                        ? 'bg-[#EDEDED] text-[#1E293B] font-semibold'
                        : 'text-[#525252] hover:bg-[#EDEDED]/60 hover:text-[#1E293B]'
                    }`}
                  >
                    <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-[#0F766E]' : 'text-[#7C7C7C]'}`} />
                    {sidebarOpen && <span className="truncate">{item.label}</span>}
                  </button>
                </React.Fragment>
              )
            })}
          </nav>
        </div>

        {/* Bottom Cross-App Bridges & Help */}
        <div className="p-3 border-t border-[#EDEDED] space-y-1 text-xs">
          {sidebarOpen ? (
            <>
              <div className="text-[10px] font-bold uppercase tracking-wider text-[#999999] px-2 mb-1">
                Zanostack Bridges
              </div>
              <button
                onClick={handleOpenCrm}
                className="w-full flex items-center justify-between px-2 py-1.5 text-[#525252] hover:text-[#1E293B] hover:bg-[#EDEDED] rounded transition-colors"
              >
                <span>Switch to CRM</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-[#999999]" />
              </button>
              <button
                onClick={handleOpenTenders}
                className="w-full flex items-center justify-between px-2 py-1.5 text-[#525252] hover:text-[#1E293B] hover:bg-[#EDEDED] rounded transition-colors"
              >
                <span>Switch to Tenders</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-[#999999]" />
              </button>
              <div className="pt-2 border-t border-[#EDEDED] flex items-center justify-between text-[11px] text-[#999999] px-2">
                <span>Zano Books v0.37</span>
                <span className="font-mono">Local-First</span>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 text-[#7C7C7C]">
              <HelpCircle className="w-4 h-4" />
            </div>
          )}
        </div>
      </aside>

      {/* ── MAIN DESK VIEWPORT ── */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {activeInvoiceId !== null ? (
          <InvoiceForm type={activeTab === 'purchases' ? 'Purchase' : 'Sales'} />
        ) : (
          <>
            {activeTab === 'dashboard' && <Dashboard />}
            {activeTab === 'invoices' && <InvoiceList type="Sales" />}
            {activeTab === 'purchases' && <InvoiceList type="Purchase" />}
            {activeTab === 'parties' && <PartyList />}
            {activeTab === 'accounts' && <ChartOfAccounts />}
            {activeTab === 'journal' && <JournalEntryList />}
            {activeTab === 'reports' && <ReportsView />}
          </>
        )}
      </main>

      {/* Document Print Modal */}
      <InvoicePrintModal />
    </div>
  )
}

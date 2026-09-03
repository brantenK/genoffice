// Root shell: fixed left sidebar (nav + company switcher) + main content area.
import { useState } from 'react'
import {
  BookOpen,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  GraduationCap,
  HelpCircle,
  LayoutDashboard,
  Plus,
  ShieldCheck,
  Users,
  X
} from 'lucide-react'
import type { AppPage, CompanyProfile } from '../../shared/types'
import { useTendersStore } from '../store'
import { GuidedTour } from './GuidedTour'
import { OnboardingModal } from './OnboardingModal'
import { CustomersPage } from './pages/CustomersPage'
import { DocumentsPage } from './pages/DocumentsPage'
import { OverviewPage } from './pages/OverviewPage'
import { ProfilePage } from './pages/ProfilePage'
import { TendersPage } from './pages/TendersPage'
import { TutorialsPage } from './pages/TutorialsPage'

const NAV_ITEMS: { page: AppPage; label: string; icon: React.ReactNode; tour?: string }[] = [
  { page: 'overview',   label: 'Overview',         icon: <LayoutDashboard size={18} /> },
  { page: 'customers',  label: 'Customers',         icon: <Users           size={18} /> },
  { page: 'documents',  label: 'Documents',         icon: <FileText        size={18} /> },
  { page: 'tenders',    label: 'Tenders',           icon: <BookOpen        size={18} /> },
  { page: 'profile',    label: 'Company Profile',   icon: <Building2       size={18} /> },
  { page: 'tutorials',  label: 'Tutorials',         icon: <GraduationCap   size={18} />, tour: 'tour-tutorials-nav' },
]

export function App() {
  const page = useTendersStore((s) => s.page)
  const setPage = useTendersStore((s) => s.setPage)
  const company = useTendersStore((s) => s.company)
  const workspaces = useTendersStore((s) => s.workspaces)
  const activeCompanyId = useTendersStore((s) => s.activeCompanyId)
  const setActiveCompany = useTendersStore((s) => s.setActiveCompany)
  const addCompany = useTendersStore((s) => s.addCompany)
  const [collapsed, setCollapsed] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [addingCompany, setAddingCompany] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const onboardingDone = useTendersStore((s) => s.onboardingDone)
  const restartOnboarding = useTendersStore((s) => s.restartOnboarding)
  const startTour = useTendersStore((s) => s.startTour)

  return (
    <div className="flex h-full min-h-0">
      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <aside
        className={`relative flex shrink-0 flex-col border-r border-slate-200 bg-white transition-all duration-200 ${
          collapsed ? 'w-[60px]' : 'w-[220px]'
        }`}
      >
        {/* logo */}
        <div className={`flex h-14 shrink-0 items-center border-b border-slate-100 px-3 gap-2.5`}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <ShieldCheck size={16} />
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-bold tracking-tight text-slate-900">Zanostack Tenders</span>
              <span className="block truncate text-[10px] text-slate-400">Bids & RFP Workspace</span>
            </span>
          )}
        </div>

        {/* nav */}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3" data-tour="tour-nav">
          {NAV_ITEMS.map((item) => {
            const active = page === item.page
            return (
              <button
                key={item.page}
                type="button"
                onClick={() => setPage(item.page)}
                data-tour={item.tour}
                title={collapsed ? item.label : undefined}
                className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition-colors ${
                  active
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className={`shrink-0 ${active ? 'text-indigo-600' : 'text-slate-400'}`}>
                  {item.icon}
                </span>
                {!collapsed && <span className="truncate">{item.label}</span>}
              </button>
            )
          })}
        </nav>

        {/* help + onboarding shortcuts */}
        <div className="relative shrink-0 border-t border-slate-100" data-tour="tour-help">
          <button
            type="button"
            onClick={() => setHelpOpen((v) => !v)}
            title={collapsed ? 'Help, tour & tutorials' : undefined}
            className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-slate-100 ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            <HelpCircle size={15} className="shrink-0 text-slate-400" />
            {!collapsed && <span className="text-[13px] font-medium text-slate-600">Help &amp; tutorials</span>}
          </button>

          {helpOpen && (
            <div className="absolute bottom-full left-2 z-30 mb-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
              <button
                type="button"
                onClick={() => {
                  restartOnboarding()
                  setHelpOpen(false)
                }}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[13px] text-slate-700 transition-colors hover:bg-slate-50"
              >
                <ShieldCheck size={14} className="text-indigo-500" /> Re-run welcome walkthrough
              </button>
              <button
                type="button"
                onClick={() => {
                  startTour()
                  setHelpOpen(false)
                }}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[13px] text-slate-700 transition-colors hover:bg-slate-50"
              >
                <LayoutDashboard size={14} className="text-indigo-500" /> Take the guided tour
              </button>
              <button
                type="button"
                onClick={() => {
                  setPage('tutorials')
                  setHelpOpen(false)
                }}
                className="flex w-full cursor-pointer items-center gap-2 border-t border-slate-100 px-3 py-2.5 text-left text-[13px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50"
              >
                <GraduationCap size={14} /> Open Tutorials page
              </button>
            </div>
          )}
        </div>

        {/* company identity footer + switcher */}
        <div className="relative shrink-0 border-t border-slate-100" data-tour="tour-company-switcher">
          <button
            type="button"
            onClick={() => setSwitcherOpen((v) => !v)}
            title={collapsed ? `Switch company (active: ${company.tradingName})` : 'Switch company'}
            className={`flex w-full cursor-pointer items-center gap-2 px-3 py-3 text-left transition-colors hover:bg-slate-100 ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-indigo-50 text-[10px] font-bold text-indigo-600">
              {company.tradingName.slice(0, 2).toUpperCase()}
            </span>
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold text-slate-700">{company.tradingName}</span>
                  <span className="block truncate text-[10px] text-slate-400">{company.bbbeeLevel} · {company.industry}</span>
                </span>
                <ChevronDown
                  size={13}
                  className={`shrink-0 text-slate-400 transition-transform ${switcherOpen ? 'rotate-180' : ''}`}
                />
              </>
            )}
          </button>

          {switcherOpen && (
            <div className="absolute bottom-full left-2 z-30 mb-2 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
              <p className="border-b border-slate-100 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Workspaces
              </p>
              <ul className="max-h-64 overflow-y-auto py-1">
                {workspaces.map((ws) => {
                  const active = ws.id === activeCompanyId
                  return (
                    <li key={ws.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveCompany(ws.id)
                          setSwitcherOpen(false)
                        }}
                        className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors ${
                          active
                            ? 'bg-indigo-50 font-semibold text-indigo-700'
                            : 'text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-[9px] font-bold text-slate-500">
                          {ws.company.tradingName.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{ws.company.tradingName}</span>
                        {active && <Check size={13} className="shrink-0 text-indigo-600" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
              <button
                type="button"
                onClick={() => {
                  setAddingCompany(true)
                  setSwitcherOpen(false)
                }}
                className="flex w-full cursor-pointer items-center gap-2 border-t border-slate-100 px-3 py-2.5 text-left text-[13px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50"
              >
                <Plus size={14} /> Add company
              </button>
            </div>
          )}
        </div>

        {/* collapse toggle */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="absolute -right-3 top-16 z-10 flex size-6 cursor-pointer items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 shadow-sm hover:text-slate-700"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
      </aside>

      {/* ── Add-company modal ───────────────────────────────────────────────── */}
      {addingCompany && (
        <AddCompanyModal
          onClose={() => setAddingCompany(false)}
          onCreate={(profile) => {
            addCompany(profile)
            setAddingCompany(false)
          }}
        />
      )}

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50">
        {page === 'overview'   && <OverviewPage />}
        {page === 'customers'  && <CustomersPage />}
        {page === 'documents'  && <DocumentsPage />}
        {page === 'tenders'    && <TendersPage />}
        {page === 'profile'    && <ProfilePage />}
        {page === 'tutorials'  && <TutorialsPage />}
      </main>

      {/* ── Onboarding: first-launch walkthrough + interactive tour ────────── */}
      {!onboardingDone && <OnboardingModal />}
      <GuidedTour />
    </div>
  )
}

/** Minimal creation form: just the essentials — the rest is editable later on
 *  the Company Profile page. New workspaces start empty (no customers, vault
 *  docs or tenders). */
function AddCompanyModal({
  onClose,
  onCreate
}: {
  onClose: () => void
  onCreate: (profile: CompanyProfile) => void
}) {
  const [form, setForm] = useState({
    tradingName: '',
    industry: '',
    registrationNumber: '',
    vatNumber: '',
    taxPin: '',
    bbbeeLevel: '',
    address: '',
    phone: '',
    email: ''
  })
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const canCreate = form.tradingName.trim().length > 0

  const handleCreate = () => {
    if (!canCreate) return
    onCreate({
      name: form.tradingName.trim(),
      tradingName: form.tradingName.trim(),
      registrationNumber: form.registrationNumber.trim(),
      vatNumber: form.vatNumber.trim(),
      taxPin: form.taxPin.trim(),
      bbbeeLevel: form.bbbeeLevel.trim(),
      bbbeeBlackOwnership: '',
      csdSupplierNumber: '',
      founded: '',
      employees: '',
      industry: form.industry.trim(),
      description: '',
      address: form.address.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      website: '',
      directors: [],
      projects: []
    })
  }

  const field = (
    label: string,
    key: keyof typeof form,
    placeholder = '',
    required = false
  ) => (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-slate-600">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      <input
        value={form[key]}
        onChange={set(key)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
      />
    </label>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-900">Add a company workspace</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Each company keeps its own customers, vault and tenders.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">{field('Trading name', 'tradingName', 'e.g. Lephalale Civils (Pty) Ltd', true)}</div>
          {field('Industry', 'industry', 'e.g. Civil construction')}
          {field('B-BBEE level', 'bbbeeLevel', 'e.g. Level 1')}
          {field('Registration number', 'registrationNumber', 'e.g. 2016/123456/07')}
          {field('VAT number', 'vatNumber', 'e.g. 4820315678')}
          {field('Tax PIN', 'taxPin', 'e.g. 0123456789')}
          {field('Phone', 'phone', 'e.g. 015 783 0022')}
          <div className="sm:col-span-2">{field('Address', 'address', 'e.g. 12 Industrial Rd, Polokwane')}</div>
          <div className="sm:col-span-2">{field('Email', 'email', 'e.g. tenders@company.co.za')}</div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCreate}
            onClick={handleCreate}
            className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Create workspace
          </button>
        </div>
      </div>
    </div>
  )
}
